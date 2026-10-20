/** 单订单权威读取能力：返回已验证的中性订单事实，不携带 SDK DTO 或延迟解码闭包。 */

import type { OrderFact } from './trade.js';

/** 单订单权威读取能力，不拥有重试、限流、取消复核或可信执行时间补全。 */
export interface OrderDetailReadPort {
  /** 读取并校验身份/市场范围：错 orderId 或非HK 订单立即拒绝。 */
  readonly read: (orderId: string) => Promise<OrderFact>;

  /** broker 读取失败的既有暂态证据；重试时机仍由 query owner 决定。 */
  readonly isRetryableError: (error: unknown) => boolean;

  /** broker 原错误码映射，供 query 保留 603001 等既有业务分支。 */
  readonly getErrorCode: (error: unknown) => string | null;
}
