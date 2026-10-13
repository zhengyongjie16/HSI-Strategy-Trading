/**
 * 智能平仓纯规则：按原成本金额/数量判断整体盈利，并约束阶段可卖量。
 * 不读取订单账或记录占用；application 按阶段读取同一 order owner 的可卖订单事实。
 */
import type { OrderCostBasis } from '../../types/orderRecorder.js';
import { exactCompare, exactMultiply, sumSafeQuantities } from '../../utils/numeric/exact.js';

/** 当前市值严格高于原始成本才进入全卖阶段；均价显示舍入不参与判断。 */
export function isOverallProfitable(
  currentPrice: string,
  costBasis: OrderCostBasis | null,
): boolean {
  exactCompare(currentPrice, '0');
  if (costBasis === null) return false;

  if (!Number.isSafeInteger(costBasis.quantity)) throw new RangeError('成本数量必须为安全整数');

  if (costBasis.quantity <= 0) throw new TypeError('成本数量必须为正安全整数');

  return (
    exactCompare(costBasis.costAmount, '0') > 0 &&
    exactCompare(exactMultiply(currentPrice, String(costBasis.quantity)), costBasis.costAmount) > 0
  );
}

/** 不允许任何阶段越过真实授权可卖量；用于第二阶段剩余额度及最终总量。 */
export function remainingSellQuantity(availableQuantity: number, selectedQuantity: number): number {
  if (
    !Number.isSafeInteger(availableQuantity) ||
    availableQuantity < 0 ||
    !Number.isSafeInteger(selectedQuantity) ||
    selectedQuantity < 0
  ) {
    throw new RangeError('可卖订单数量必须为非负安全整数');
  }

  if (selectedQuantity > availableQuantity) throw new TypeError('可卖订单数量超过授权上限');

  return availableQuantity - selectedQuantity;
}

/** 盈利/超时两阶段数量保持安全整数，并共同受原 availableQuantity 上限约束。 */
export function sumSmartCloseQuantities(
  availableQuantity: number,
  profit: number,
  timeout: number,
): number {
  remainingSellQuantity(remainingSellQuantity(availableQuantity, profit), timeout);
  return sumSafeQuantities([String(profit), String(timeout)]);
}
