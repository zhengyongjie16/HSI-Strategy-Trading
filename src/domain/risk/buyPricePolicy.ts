/**
 * 买入价格纯规则。
 * 将候选价格与最新已成交成本金额/数量交叉乘比较，严格拒绝等价或追高，不能用显示均价作依据。
 */
import type { OrderCostBasis } from '../../types/orderRecorder.js';
import { exactCompare, exactMultiply } from '../../utils/numeric/exact.js';

/** 最新成本不存在时不额外拦截；价格缺失由调用方行情准入负责。 */
export function isBuyPriceWithinLatestOrderLimit(
  candidatePrice: string | null,
  latestBuyCost: OrderCostBasis | null,
): boolean {
  if (candidatePrice !== null) exactCompare(candidatePrice, '0');

  if (latestBuyCost === null) return true;

  if (!Number.isSafeInteger(latestBuyCost.quantity))
    throw new RangeError('最新买入成本数量必须为安全整数');

  if (latestBuyCost.quantity <= 0) throw new TypeError('最新买入成本数量必须为正安全整数');

  exactCompare(latestBuyCost.costAmount, '0');
  return (
    candidatePrice === null ||
    exactCompare(
      exactMultiply(candidatePrice, String(latestBuyCost.quantity)),
      latestBuyCost.costAmount,
    ) < 0
  );
}
