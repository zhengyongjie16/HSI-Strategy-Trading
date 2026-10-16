/** 中性账户读取IO能力，返回已验证文本金额/安全数量，不输出SDK DTO。 */
import type { AccountSnapshot, Position } from './account.js';
import type { ExternalApiRetryConfig } from './apiFailure.js';
import type { RateLimiter } from './rateLimit.js';

/** 账户查询行为能力，不是pure readonly数据；外部读取由注入的SDK-free IO port执行。 */
export interface AccountService {
  readonly getAccountSnapshot: (params?: {
    readonly retryConfig?: ExternalApiRetryConfig;
  }) => Promise<AccountSnapshot>;
  readonly getStockPositions: (params?: {
    readonly symbols?: ReadonlyArray<string> | null;
    readonly retryConfig?: ExternalApiRetryConfig;
  }) => Promise<ReadonlyArray<Position>>;
}

/** 唯一账户service装配依赖，保原限流与真实IO能力，不携SDK context或capability默认值。 */
export interface AccountServiceDeps {
  readonly accountReadPort: AccountReadPort;
  readonly rateLimiter: Pick<RateLimiter, 'throttle'>;
}

/** broker adapter 的中性账户/持仓 IO；SDK DTO 与重试分类留在原边界，不输出到业务。 */
export interface AccountReadPort {
  readonly readPrimaryAccount: (params?: {
    readonly retryConfig?: ExternalApiRetryConfig;
  }) => Promise<Omit<AccountSnapshot, 'positionValue'>>;
  readonly readStockPositions: (params?: {
    readonly symbols?: ReadonlyArray<string> | null;
    readonly retryConfig?: ExternalApiRetryConfig;
  }) => Promise<ReadonlyArray<Position>>;
}
