import type { OrderExecutionLedgerFact } from './orderExecutionLedger.js';
import type { RawOrderFromAPI } from './services.js';

/** 单订单读取后保留私有 DTO 的解码能力；调用方控制预检及 ledger 合并阶段。 */
export interface OrderDetailDecoder {
  readonly decode: (executions: ReadonlyArray<OrderExecutionLedgerFact>) => RawOrderFromAPI;
}

/** 单订单权威读取能力，不拥有重试、限流、取消复核或可信执行时间补全。 */
export interface OrderDetailReadPort {
  readonly read: (orderId: string) => Promise<OrderDetailDecoder>;
}
