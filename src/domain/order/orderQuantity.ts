/** 订单纯数量规则：按名义预算精确向下整手，汇总已证明的安全正整数成交数量。 */
import type { OrderRecord } from '../../types/orderRecorder.js';
import { exactCompare, exactMultiply, integerQuotient } from '../../utils/numeric/exact.js';

/**
 * 直接求整数手数再乘每手数量，保持名义预算不等式；不足一手返回 0。
 * @param amount 严格正预算
 * @param price 严格正价格
 * @param lotSize 严格正整数每手数量
 * @returns 精确整数数量文本，执行出口仍须验证安全整数后才转为 number
 */
export function wholeLotQuantity(amount: string, price: string, lotSize: string): string {
  if (exactCompare(amount, '0') <= 0) {
    throw new RangeError('Denominator must be strictly positive');
  }

  if (exactCompare(price, '0') <= 0) {
    throw new RangeError('Denominator must be strictly positive');
  }

  if (exactCompare(lotSize, '0') <= 0) {
    throw new RangeError('Denominator must be strictly positive');
  }

  if (exactCompare(integerQuotient(lotSize, '1'), lotSize) !== 0) {
    throw new RangeError('Lot size must be an integer');
  }

  return exactMultiply(integerQuotient(amount, exactMultiply(price, lotSize)), lotSize);
}

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
