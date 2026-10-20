/**
 * 日损重算入参：入站 mapper 已保证正成交订单携带累计金额，
 * 缺金额的事实不得进入域层重算；直接暴露为测试失败，不补造 0 金额。
 */
import type { DailyLossOrderSnapshot } from '../../src/types/risk.js';
import type { OrderFact } from '../../src/types/trade.js';

export function toRecalculationOrders(
  orders: ReadonlyArray<OrderFact>,
): ReadonlyArray<DailyLossOrderSnapshot> {
  return orders.map((order) => {
    if (order.executedAmount === null)
      throw new TypeError(`[recalculationOrders] order lacks executed amount: ${order.orderId}`);

    return { ...order, executedAmount: order.executedAmount };
  });
}
