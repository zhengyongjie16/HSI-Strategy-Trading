/** Longbridge 订单读取错误分类；保留原查询错误码/HTTP 暂态口径，不拥有查询重试或 tracking 状态。 */

import {
  ORDER_API_RETRYABLE_MESSAGE_HINTS,
  ORDER_API_TRANSIENT_STATUS_CODE_SET,
} from '../../../constants/index.js';
import { isRecord } from '../../../utils/helpers/index.js';
import { logger } from '../../logger/index.js';

/**
 * 从对象字段中提取错误码。
 *
 * @param value 任意对象值
 * @returns 错误码，提取失败返回 null
 */
function extractErrorCodeFromRecord(value: Record<string, unknown>): string | null {
  const codeKeys = ['code', 'errorCode', 'errno'];
  for (const key of codeKeys) {
    const rawValue = value[key];
    if (typeof rawValue === 'string') {
      const trimmed = rawValue.trim();
      if (/^\d+$/.test(trimmed)) {
        return trimmed;
      }
    }

    if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
      return String(Math.trunc(rawValue));
    }
  }

  return null;
}

/**
 * 从错误对象中提取错误码。
 * 优先级：结构化字段（code/errorCode/errno）> 嵌套 cause/error > message 文本。
 *
 * @param err 错误对象
 * @param depth 递归深度（内部使用）
 * @returns 错误码字符串，提取失败返回 null
 */
export function extractErrorCode(err: unknown, depth: number = 0): string | null {
  if (depth > 2 || !isRecord(err)) {
    return null;
  }

  const directCode = extractErrorCodeFromRecord(err);
  if (directCode !== null) {
    return directCode;
  }

  const nestedKeys = ['cause', 'error'];
  for (const key of nestedKeys) {
    const nested = err[key];
    if (isRecord(nested)) {
      const nestedCode = extractErrorCode(nested, depth + 1);
      if (nestedCode !== null) {
        return nestedCode;
      }
    }
  }

  const message = err['message'];
  if (typeof message !== 'string') {
    return null;
  }

  const codeRegex = /code=(\d+)/;
  const codeMatch = codeRegex.exec(message);
  if (codeMatch?.[1]) {
    return codeMatch[1];
  }

  logger.debug(`[错误码提取] 无法从错误消息中提取错误码: ${message}`);

  return null;
}

/**
 * 从错误对象中提取错误消息。
 *
 * @param err 错误对象
 * @returns 错误消息文本
 */
export function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }

  if (isRecord(err)) {
    const message = err['message'];
    if (typeof message === 'string') {
      return message;
    }
  }

  return String(err);
}

/**
 * 从对象字段中提取 HTTP 状态码。
 *
 * @param value 任意对象值
 * @returns 三位状态码，提取失败返回 null
 */
function extractStatusCodeFromRecord(value: Record<string, unknown>): string | null {
  const statusKeys = ['status', 'statusCode', 'httpStatus'] as const;
  for (const key of statusKeys) {
    const rawValue = value[key];
    if (typeof rawValue === 'string' && /^\d{3}$/.test(rawValue.trim())) {
      return rawValue.trim();
    }

    if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
      const normalized = String(Math.trunc(rawValue));
      if (/^\d{3}$/.test(normalized)) {
        return normalized;
      }
    }
  }

  return null;
}

/**
 * 从错误消息中提取显式 HTTP 状态码。
 *
 * @param message 错误消息文本
 * @returns 三位状态码，提取失败返回 null
 */
function extractStatusCodeFromMessage(message: string): string | null {
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
 * 从错误对象中提取订单 API 状态码。
 *
 * @param err 错误对象
 * @param depth 递归深度（内部使用）
 * @returns 三位状态码，提取失败返回 null
 */
function extractOrderApiStatusCode(err: unknown, depth: number = 0): string | null {
  if (depth > 2 || !isRecord(err)) {
    return null;
  }

  const directStatusCode = extractStatusCodeFromRecord(err);
  if (directStatusCode !== null) {
    return directStatusCode;
  }

  const nestedKeys = ['cause', 'error'];
  for (const key of nestedKeys) {
    const nested = err[key];
    if (isRecord(nested)) {
      const nestedStatusCode = extractOrderApiStatusCode(nested, depth + 1);
      if (nestedStatusCode !== null) {
        return nestedStatusCode;
      }
    }
  }

  const message = err['message'];
  if (typeof message !== 'string') {
    return null;
  }

  return extractStatusCodeFromMessage(message);
}

/**
 * 判断是否为可重试订单 API 请求失败。
 *
 * @param err 错误对象
 * @returns true 表示可重试
 */
export function isRetryableOrderApiError(err: unknown): boolean {
  const statusCode = extractOrderApiStatusCode(err);
  if (statusCode !== null && ORDER_API_TRANSIENT_STATUS_CODE_SET.has(statusCode)) {
    return true;
  }

  const errorCode = extractErrorCode(err);
  if (errorCode !== null) {
    return ORDER_API_TRANSIENT_STATUS_CODE_SET.has(errorCode);
  }

  const message = extractErrorMessage(err).toLowerCase();
  return ORDER_API_RETRYABLE_MESSAGE_HINTS.some((hint) => message.includes(hint));
}
