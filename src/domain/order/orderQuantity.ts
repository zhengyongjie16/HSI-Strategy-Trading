/** 订单纯数量规则：仅汇总已证明的安全正整数成交数量，不承担时间或交易日政策。 */
import type { OrderRecord } from '../../types/services.js';

/**
 * 汇总经证明的安全整数数量；内部无效状态不得按零吞掉。
 * @param orders 已校验订单记录
 * @returns 安全整数总成交数量
 */
export function calculateTotalQuantity(orders: ReadonlyArray<OrderRecord>): number {
  let total = 0;
  for (const order of orders) {
    if (!Number.isSafeInteger(order.executedQuantity) || order.executedQuantity <= 0) {
      throw new RangeError('[订单记录] 单笔数量不是安全正整数');
    }

    total += order.executedQuantity;
    if (!Number.isSafeInteger(total)) {
      throw new RangeError('[订单记录] 汇总数量超出安全整数范围');
    }
  }

  return total;
}
