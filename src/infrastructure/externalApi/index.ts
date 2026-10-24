/**
 * 外部 API 请求适配
 *
 * 职责：在真实 IO 边界执行既有有限重试；保留原错误身份、尝试次数、等待时机和调用方收窄门禁。
 */
import { API } from '../../constants/common.js';
import { createExternalApiRequestError, isProgramError } from '../../utils/apiFailure/index.js';
import { isRetryableExternalApiError } from './errorClassification.js';
import type { ExternalApiRetryConfig } from '../../types/apiFailure.js';
import type { WrapExternalApiRequestParams } from './types.js';

const DEFAULT_EXTERNAL_API_RETRY_CONFIG: ExternalApiRetryConfig = {
  retries: API.DEFAULT_RETRY_COUNT,
  delayMs: API.DEFAULT_RETRY_DELAY_MS,
};

/**
 * 等待指定毫秒数。
 *
 * @param delayMs 等待时长，单位毫秒
 * @returns 等待完成后的 Promise
 */
function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

/**
 * 执行真实外部 API 请求，并在有限重试后将失败分类为 ExternalApiRequestError。
 *
 * @param params 外部 API 请求包装参数，包含操作名、请求函数与可选 retry 配置
 * @returns 外部 API 请求成功后的原始返回值
 */
export async function wrapExternalApiRequest<T>(
  params: WrapExternalApiRequestParams<T>,
): Promise<T> {
  const retryConfig = params.retryConfig ?? DEFAULT_EXTERNAL_API_RETRY_CONFIG;
  let lastError: unknown = null;
  const maxAttempts = retryConfig.retries + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await params.request();
    } catch (error) {
      if (isProgramError(error)) {
        throw error;
      }

      if (!isRetryableExternalApiError(error)) {
        throw error;
      }

      if (params.shouldRetry?.(error) === false) {
        throw error;
      }

      lastError = error;
      if (attempt < maxAttempts && retryConfig.delayMs > 0) {
        await wait(retryConfig.delayMs);
      }
    }
  }

  throw createExternalApiRequestError({
    operation: params.operation,
    attempts: maxAttempts,
    cause: lastError,
  });
}
