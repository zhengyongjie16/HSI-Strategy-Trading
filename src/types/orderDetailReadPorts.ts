/** 单订单读取后保留私有 DTO 的解码能力；调用方控制预检及 ledger 合并阶段。 */

import type { OrderExecutionLedgerFact } from './orderExecutionLedger.js';
import type { OrderFact } from './trade.js';

/** 原 orderDetail DTO 的延后解码能力；由查询 owner 校验并合并同一 execution ledger 后调用。 */
export interface OrderDetailDecoder {
  readonly decode: (executions: ReadonlyArray<OrderExecutionLedgerFact>) => OrderFact;
}

/** 单订单权威读取能力，不拥有重试、限流、取消复核或可信执行时间补全。 */
export interface OrderDetailReadPort {
  readonly read: (orderId: string) => Promise<OrderDetailDecoder>;

  /** broker 读取失败的既有暂态证据；重试时机仍由 query owner 决定。 */
  readonly isRetryableError: (error: unknown) => boolean;

  /** broker 原错误码映射，供 query 保留 603001 等既有业务分支。 */
  readonly getErrorCode: (error: unknown) => string | null;
}
