import type { ExternalApiRetryConfig } from '../../types/apiFailure.js';

/**
 * 外部 API 请求包装参数。
 * 类型用途：描述真实 IO 请求及调用方只收窄、不扩展默认 retry 门禁的回调。
 * 数据来源：Longbridge adapter 或 app 注入的外部执行边界。
 * 使用范围：仅 externalApi 请求实现，不作为业务层能力契约。
 */
export type WrapExternalApiRequestParams<T> = Readonly<{
  operation: string;
  request: () => Promise<T>;
  shouldRetry?: (error: unknown) => boolean;
  retryConfig?: ExternalApiRetryConfig;
}>;
