/** 中性push解码能力：原SDK DTO只留adapter闭包，domain不注册/读取SDK类字段。 */
import type { OrderFact } from './trade.js';
import type { OrderExecutionLedgerFact } from './orderExecutionLedger.js';
import type { BrokerOrderExecutionFact } from './orderRecorder.js';

/** 已确认同broker累计事实及其原价格；只用于证明缺失终态quote与真实ledger的兼容性。 */
export type OrderExecutionPriceEvidence = BrokerOrderExecutionFact &
  Readonly<{ executedPrice: string | null }>;

/** 发ledger前验证的原生身份/数量/revision，不含尚未证明的金额或执行时间。 */
export type OrderPushReadFact = Readonly<{
  orderId: string;
  symbol: string;
  executedQuantity: number;
  updatedAtMs: number;
}>;

/** 这是延迟原始事实转换行为，不是readonly pure-data类型。 */
export interface OrderPushDecoder {
  readonly inspect: () => OrderPushReadFact;
  readonly decode: (
    executions: ReadonlyArray<OrderExecutionLedgerFact>,
    confirmed?: OrderExecutionPriceEvidence,
  ) => OrderFact;
}

/** 原 context 的 callback 与 Private 订退订；时序、限流及经济发布仍归原 Monitor。 */
export interface OrderPushPort {
  readonly subscribePrivate: () => Promise<void>;
  readonly unsubscribePrivate: () => Promise<void>;
  readonly setOnOrderChanged: (
    consumer: (error: Error | null, decoder: OrderPushDecoder) => void,
  ) => void;
}
