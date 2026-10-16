/**
 * 外部 API retry 配置。
 * 类型用途：限定真实外部 API 请求失败后的有限重试次数与间隔。
 * 数据来源：调用方显式传入或使用 API 默认常量。
 * 使用范围：wrapExternalApiRequest 工具函数。
 */
export type ExternalApiRetryConfig = Readonly<{
  retries: number;
  delayMs: number;
}>;

/**
 * 外部 API 重试决策。
 * 类型用途：表达单个错误在统一分类器下应进入有限重试还是立即抛出。
 * 数据来源：isRetryableExternalApiError 对错误对象的分类结果。
 * 使用范围：wrapExternalApiRequest 默认重试门禁。
 */
export type ExternalApiRetryDecision = 'RETRY' | 'FAIL_FAST';

/**
 * 外部 API 请求失败错误。
 * 类型用途：表达真实外部 API 请求在有限尝试后仍失败。
 * 数据来源：createExternalApiRequestError 根据原始错误构造。
 * 使用范围：运行时错误分类与 retry 边界判断。
 */
export type ExternalApiRequestError = Error &
  Readonly<{
    name: 'ExternalApiRequestError';
    operation: string;
    attempts: number;
  }>;

/** 真实外部请求的有限重试执行能力；调用方只提供原请求与收窄门禁，不依赖 IO 实现。 */
export type ExternalApiRequest = <T>(
  params: Readonly<{
    operation: string;
    request: () => Promise<T>;
    shouldRetry?: (error: unknown) => boolean;
    retryConfig?: ExternalApiRetryConfig;
  }>,
) => Promise<T>;
