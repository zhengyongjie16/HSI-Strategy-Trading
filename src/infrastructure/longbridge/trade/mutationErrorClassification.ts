/**
 * Longbridge mutation 错误映射。
 * 只读取已发出请求的 SDK 结构字段、cause/error 与既有错误码文本；不重试、不查询、不推进 tracking。
 * submit 的明确拒绝沿用结构化六位业务码口径，其他未确认提交一律 UNKNOWN。
 */
import {
  ORDER_API_RETRYABLE_MESSAGE_HINTS,
  ORDER_API_TRANSIENT_STATUS_CODE_SET,
  ORDER_CLOSED_ERROR_CODE_SET,
  REPLACE_TEMP_BLOCKED_BY_STATUS_ERROR_CODE_SET,
  REPLACE_UNSUPPORTED_BY_TYPE_ERROR_CODE_SET,
} from '../../../constants/common.js';
import type {
  TradeCancelResult,
  TradeReplaceResult,
  TradeSubmitResult,
} from '../../../types/tradeMutationPorts.js';
import { isRecord } from '../../../utils/helpers/index.js';
import { isProgramError } from '../../../utils/apiFailure/index.js';

/** 仅识别实际字段中的完整码，不截断错误码数字或读取未约定的对象字段。 */
function structuredCode(error: unknown): string | null {
  if (!isRecord(error)) return null;

  for (const key of ['code', 'errorCode', 'errno'] as const) {
    const value = error[key];
    if (typeof value === 'string' && /^\d+$/.test(value.trim())) return value.trim();

    if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  }

  return null;
}

/** 已有 submit 拒绝边界要求 cause/error 链内存在完整的结构化六位业务码。 */
function structuredBusinessCode(error: unknown, depth: number = 0): string | null {
  if (depth > 2 || !isRecord(error)) return null;

  for (const key of ['code', 'errorCode', 'errno'] as const) {
    const value = error[key];
    if (typeof value === 'string' && /^\d{6}$/.test(value.trim())) return value.trim();

    if (
      typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= 100_000 &&
      value <= 999_999
    )
      return String(value);
  }

  for (const key of ['cause', 'error'] as const) {
    const nested = structuredBusinessCode(error[key], depth + 1);
    if (nested !== null) return nested;
  }

  return null;
}

/** SDK 的已有码文本出口仅用于 replace/cancel 及保留 UNKNOWN 原码，不放宽 submit 拒绝证据。 */
function brokerCode(error: unknown, depth: number = 0): string | null {
  if (depth > 2 || !isRecord(error)) return null;

  const code = structuredCode(error);
  if (code !== null) return code;

  for (const key of ['cause', 'error'] as const) {
    const nested = brokerCode(error[key], depth + 1);
    if (nested !== null) return nested;
  }

  const message = error['message'];
  return typeof message === 'string' ? (/\bcode=(\d+)\b(?!\.\d)/.exec(message)?.[1] ?? null) : null;
}

/** 保留原消息仅供 adapter 判断已有暂态规则，业务层不再匹配 SDK 文本。 */
function errorMessage(error: unknown): string {
  if (isRecord(error) && typeof error['message'] === 'string') return error['message'];

  return String(error);
}

/** 结构化 HTTP status 优先，随后沿用嵌套 cause/error 和显式 HTTP 文本口径。 */
function httpStatus(error: unknown, depth: number = 0): string | null {
  if (depth > 2 || !isRecord(error)) return null;

  for (const key of ['status', 'statusCode', 'httpStatus'] as const) {
    const value = error[key];
    if (typeof value === 'string' && /^\d{3}$/.test(value.trim())) return value.trim();

    if (typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 999)
      return String(value);
  }

  for (const key of ['cause', 'error'] as const) {
    const nested = httpStatus(error[key], depth + 1);
    if (nested !== null) return nested;
  }

  const message = errorMessage(error);
  for (const pattern of [
    /\bstatus(?:code)?[=:]\s*(\d{3})\b(?!\.\d)/i,
    /\bhttp\s+(\d{3})\b(?!\.\d)/i,
  ]) {
    const status = pattern.exec(message)?.[1];
    if (status !== undefined) return status;
  }

  return null;
}

/** 只沿用已存在的 replace/cancel 暂态证据；无已知 status、code 或消息证据时不能默认为外部重试。 */
function isRetryableMutationError(error: unknown, code: string | null): boolean {
  const status = httpStatus(error);
  if (status !== null && ORDER_API_TRANSIENT_STATUS_CODE_SET.has(status)) return true;

  if (code !== null) return ORDER_API_TRANSIENT_STATUS_CODE_SET.has(code);

  const message = errorMessage(error).toLowerCase();
  return ORDER_API_RETRYABLE_MESSAGE_HINTS.some((hint) => message.includes(hint));
}

/** 映射 submit 的单次 SDK 拒绝；内部契约错误仍原样 fail-fast。 */
export function classifySubmitRequestError(cause: unknown): TradeSubmitResult {
  if (isProgramError(cause)) throw cause;

  const businessCode = structuredBusinessCode(cause);
  return Object.freeze({
    operation: 'TradeContext.submitOrder',
    requestAttempted: true,
    kind: businessCode === null ? 'UNKNOWN' : 'REJECTED',
    code: businessCode ?? brokerCode(cause),
    cause,
  });
}

/** 映射 replace 的明确业务拒绝、需确认关闭、既有外部暂态与 UNKNOWN；不执行状态机政策。 */
export function classifyReplaceRequestError(cause: unknown): TradeReplaceResult {
  if (isProgramError(cause)) throw cause;

  const code = brokerCode(cause);
  const observation = {
    operation: 'TradeContext.replaceOrder',
    requestAttempted: true,
    code,
    cause,
  } as const;
  if (code !== null && REPLACE_UNSUPPORTED_BY_TYPE_ERROR_CODE_SET.has(code))
    return Object.freeze({
      ...observation,
      kind: 'REJECTED',
      reason: 'UNSUPPORTED_BY_TYPE' as const,
    });

  if (code !== null && REPLACE_TEMP_BLOCKED_BY_STATUS_ERROR_CODE_SET.has(code))
    return Object.freeze({
      ...observation,
      kind: 'REJECTED',
      reason: 'TEMP_BLOCKED_BY_STATUS' as const,
    });

  if (code !== null && ORDER_CLOSED_ERROR_CODE_SET.has(code))
    return Object.freeze({ ...observation, kind: 'ORDER_ALREADY_CLOSED' });

  return Object.freeze({
    ...observation,
    kind: isRetryableMutationError(cause, code) ? 'RETRYABLE_EXTERNAL_ERROR' : 'UNKNOWN',
  });
}

/** 撤单关闭码仅要求原 tracking 做权威确认；ACK/terminal 不能在错误映射中混同。 */
export function classifyCancelRequestError(cause: unknown): TradeCancelResult {
  if (isProgramError(cause)) throw cause;

  const code = brokerCode(cause);
  const observation = {
    operation: 'TradeContext.cancelOrder',
    requestAttempted: true,
    code,
    cause,
  } as const;
  if (code !== null && ORDER_CLOSED_ERROR_CODE_SET.has(code))
    return Object.freeze({ ...observation, kind: 'STATE_CONFIRMATION_REQUIRED' });

  return Object.freeze({
    ...observation,
    kind: isRetryableMutationError(cause, code) ? 'RETRYABLE_EXTERNAL_ERROR' : 'UNKNOWN',
  });
}
