import type { OrderExecutionLedgerFact } from './orderExecutionLedger.js';
import type { OrderExecutionPriceEvidence } from './orderPushPorts.js';

/** mapper 已保真读取的订单经济身份/累计量/revision；不携带 SDK 或任何可写账。 */
export type OrderEconomicsObservation = {
  readonly orderId: string;
  readonly symbol: string;
  readonly executionSide: 'BUY' | 'SELL';
  readonly executedQuantity: number;
  readonly updatedAtMs: number | null;
};

/** 订单金额、ledger 匹配与缺价终态裁决的纯能力；app 注入，adapter 只做 SDK 转换。 */
export interface OrderEconomics {
  readonly cumulativeAmount: (executedPrice: string | null, executedQuantity: number) => string;
  readonly executionTime: (
    order: OrderEconomicsObservation,
    executions: ReadonlyArray<OrderExecutionLedgerFact>,
  ) => number | null;
  readonly compatibleTerminalPrice: (
    order: OrderEconomicsObservation,
    executions: ReadonlyArray<OrderExecutionLedgerFact>,
    confirmed?: OrderExecutionPriceEvidence,
  ) => string | null;
}
