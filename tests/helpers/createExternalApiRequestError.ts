/**
 * 外部 API 失败测试工厂
 *
 * 通过生产的重试边界制造已登记的 ExternalApiRequestError，供测试验证
 * WeakSet 身份语义，而不暴露生产内部构造函数。
 */
import {
  isExternalApiRequestError,
  wrapExternalApiRequest,
} from '../../src/utils/apiFailure/index.js';
import { formatError } from '../../src/utils/error/index.js';
import type { ExternalApiRequestError } from '../../src/utils/apiFailure/types.js';

type CreateExternalApiRequestErrorParams = Readonly<{
  operation: string;
  attempts: number;
  cause: unknown;
}>;

/**
 * 创建通过真实重试耗尽路径登记的外部 API 请求失败错误。
 *
 * @param params 操作名、尝试次数和用于保留测试上下文的原始原因
 * @returns 已被生产 WeakSet 记录的 ExternalApiRequestError
 */
export async function createExternalApiRequestError(
  params: CreateExternalApiRequestErrorParams,
): Promise<ExternalApiRequestError> {
  if (!Number.isInteger(params.attempts) || params.attempts < 1) {
    throw new Error('[test] 外部 API 失败次数必须为正整数');
  }

  const retryableFailure = new Error('network unavailable');
  try {
    await wrapExternalApiRequest({
      operation: params.operation,
      request: async () => {
        throw retryableFailure;
      },
      retryConfig: {
        retries: params.attempts - 1,
        delayMs: 0,
      },
    });
  } catch (error) {
    if (isExternalApiRequestError(error)) {
      error.message = `[外部 API 请求失败] ${params.operation}: ${formatError(params.cause)}`;
      Object.defineProperty(error, 'cause', {
        value: params.cause,
        writable: true,
        configurable: true,
      });
      return error;
    }

    throw error;
  }

  throw new Error('[test] 预期外部 API 请求失败');
}
