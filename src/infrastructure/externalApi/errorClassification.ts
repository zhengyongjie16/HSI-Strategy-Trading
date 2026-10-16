/**
 * 外部请求错误分类
 *
 * 职责：保留网络暂态、HTTP 状态与 Longbridge 业务 code 的既有默认 retry 门禁；不改变调用方策略。
 */
import { formatError } from '../../utils/error/index.js';
import { isRecord } from '../../utils/helpers/index.js';
import { isProgramError } from '../../utils/apiFailure/index.js';
import type { ExternalApiRetryDecision } from '../../types/apiFailure.js';

const TRANSIENT_STATUS_CODES = new Set(['408', '425', '429', '500', '502', '503', '504']);
const NON_RETRYABLE_MESSAGE_HINTS = [
  'invalid',
  'validation',
  'permission',
  'unauthorized',
  'forbidden',
  'unsupported',
  'not found',
  'no data',
  'business rejection',
] as const;
const RETRYABLE_MESSAGE_HINTS = [
  'network',
  'timeout',
  'timed out',
  'temporarily unavailable',
  'service unavailable',
  'service busy',
  'connection',
  'econnreset',
  'etimedout',
  'rate limit',
] as const;
const RETRYABLE_STRUCTURED_ERROR_CODES = new Set(['econnreset', 'etimedout']);
const STRUCTURED_ERROR_CODE_KEYS = ['code', 'errorCode', 'errno'] as const;
const STRUCTURED_STATUS_KEYS = ['status', 'statusCode', 'httpStatus'] as const;
const NESTED_ERROR_KEYS = ['cause', 'error'] as const;

/**
 * 从错误对象读取字符串或数字字段。
 *
 * @param error 待读取错误对象
 * @param key 字段名
 * @returns 可用于分类的字段文本
 */
function extractStringProperty(error: unknown, key: string): string | null {
  if (!isRecord(error)) {
    return null;
  }

  const value = error[key];
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }

  return null;
}

/**
 * 从错误对象及其结构化 cause/error 字段读取可分类字段。
 *
 * @param error 待读取错误对象
 * @param keys 字段名列表
 * @param depth 当前递归深度
 * @returns 可用于分类的字段文本列表
 */
function extractNestedStringProperties(
  error: unknown,
  keys: ReadonlyArray<string>,
  depth: number = 0,
): ReadonlyArray<string> {
  if (depth > 2 || !isRecord(error)) {
    return [];
  }

  const values: string[] = [];
  for (const key of keys) {
    const value = extractStringProperty(error, key);
    if (value !== null) {
      values.push(value);
    }
  }

  for (const key of NESTED_ERROR_KEYS) {
    values.push(...extractNestedStringProperties(error[key], keys, depth + 1));
  }

  return values;
}

/**
 * 从结构化错误字段读取 HTTP 状态码。
 *
 * @param error 待分类错误对象
 * @returns 三位状态码文本
 */
function extractNumericStatusText(error: unknown): string | null {
  for (const value of extractNestedStringProperties(error, STRUCTURED_STATUS_KEYS)) {
    if (/^\d{3}$/.test(value)) {
      return value;
    }
  }

  return null;
}

/**
 * 从错误消息中读取 HTTP 状态码。
 *
 * @param message 错误消息文本
 * @returns 三位状态码文本
 */
function extractStatusFromMessage(message: string): string | null {
  const patterns = [/\bstatus(?:code)?[=:]\s*(\d{3})\b/i, /\bhttp\s+(\d{3})\b/i] as const;
  for (const pattern of patterns) {
    const match = pattern.exec(message);
    if (match?.[1]) {
      return match[1];
    }
  }

  return null;
}

/**
 * 判断错误是否带有 Longbridge 业务错误码。
 *
 * @param error 待分类错误对象
 * @param message 错误消息文本
 * @returns true 表示结构化字段或消息包含六位业务 code
 */
function hasBusinessErrorCode(error: unknown, message: string): boolean {
  for (const structuredCode of extractNestedStringProperties(error, STRUCTURED_ERROR_CODE_KEYS)) {
    if (/^\d{6}$/.test(structuredCode)) {
      return true;
    }
  }

  return /\b(?:code=)?\d{6}\b/i.test(message);
}

/**
 * 判断结构化错误码是否为明确的暂态网络错误。
 *
 * @param error 待分类错误对象
 * @returns true 表示 cause/error 中存在明确的网络暂态错误码
 */
function hasRetryableStructuredErrorCode(error: unknown): boolean {
  return extractNestedStringProperties(error, STRUCTURED_ERROR_CODE_KEYS).some((code) =>
    RETRYABLE_STRUCTURED_ERROR_CODES.has(code.toLowerCase()),
  );
}

/**
 * 解析外部 API 错误的默认重试决策。
 *
 * @param error 待分类错误对象
 * @returns RETRY 表示允许有限重试，FAIL_FAST 表示立即抛出
 */
function resolveExternalApiRetryDecision(error: unknown): ExternalApiRetryDecision {
  if (isProgramError(error)) {
    return 'FAIL_FAST';
  }

  const message = formatError(error).toLowerCase();
  if (NON_RETRYABLE_MESSAGE_HINTS.some((hint) => message.includes(hint))) {
    return 'FAIL_FAST';
  }

  if (hasBusinessErrorCode(error, message)) {
    return 'FAIL_FAST';
  }

  const statusText = extractNumericStatusText(error) ?? extractStatusFromMessage(message);
  if (statusText !== null && TRANSIENT_STATUS_CODES.has(statusText)) {
    return 'RETRY';
  }

  if (hasRetryableStructuredErrorCode(error)) {
    return 'RETRY';
  }

  if (RETRYABLE_MESSAGE_HINTS.some((hint) => message.includes(hint))) {
    return 'RETRY';
  }

  return 'FAIL_FAST';
}

/**
 * 判断外部 API 错误是否属于可重试暂态错误。
 *
 * @param error 待分类错误对象
 * @returns true 表示可进入有限重试
 */
export function isRetryableExternalApiError(error: unknown): boolean {
  return resolveExternalApiRetryDecision(error) === 'RETRY';
}
