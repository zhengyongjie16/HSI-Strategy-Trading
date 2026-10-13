/**
 * 换标领域 policy。
 * PERIODIC_REPLACE 只替换空席位；DISTANCE_MOVE 撤买、卖旧且等待空仓，并按真实卖出预算在 SWITCHING 内回补。
 * 两者共用自动寻标两层候选规则和 ACTIVATING 完成出口，不能把移仓能力套到周期替换上。
 */
import type { SeatSwitchPolicy, SwitchMode } from './types.js';
import {
  compareRatios,
  exactMultiply,
  exactCompare,
  safeQuantityNumber,
  wholeLotQuantity,
} from '../../utils/numeric/exact.js';

/** 选择具名 policy；阶段执行器消费明确动作，不以布尔组合推导周期/距离差异。 */
export function resolveSeatSwitchPolicy(mode: SwitchMode): SeatSwitchPolicy {
  if (mode === 'PERIODIC') {
    return {
      kind: 'PERIODIC_REPLACE',
      oldSeatHandling: 'REQUIRE_EMPTY',
      noCandidate: 'CLEAR_AND_COUNT_FAILURE',
      stageAfterCancellation: 'BIND_NEW',
      rebuy: 'NONE',
      orderTypeOverride: null,
    };
  }

  return {
    kind: 'DISTANCE_MOVE',
    oldSeatHandling: 'SELL_AVAILABLE_AND_WAIT_EMPTY',
    noCandidate: 'UNWIND_THEN_FAIL_AND_COUNT_FAILURE',
    stageAfterCancellation: 'SELL_OUT',
    rebuy: 'ACTUAL_SELL_AMOUNT_IN_SWITCHING',
    orderTypeOverride: 'ELO',
  };
}

/** 以未舍入距离基数交叉乘比较百分比阈值；LONG/SHORT 原包含边界不变。 */
export function resolveDistanceTriggerSide(params: {
  readonly direction: 'LONG' | 'SHORT';
  readonly distanceNumerator: string;
  readonly distanceDenominator: string;
  readonly range: { readonly min: string; readonly max: string };
}): 'SAFE' | 'DANGER' | null {
  const { direction, distanceNumerator, distanceDenominator, range } = params;
  const numerator = exactMultiply(distanceNumerator, '100');
  const comparedToMin = compareRatios(numerator, distanceDenominator, range.min, '1');
  const comparedToMax = compareRatios(numerator, distanceDenominator, range.max, '1');
  if (direction === 'LONG') {
    if (comparedToMin <= 0) return 'DANGER';

    if (comparedToMax >= 0) return 'SAFE';

    return null;
  }

  if (comparedToMax >= 0) return 'DANGER';

  if (comparedToMin <= 0) return 'SAFE';

  return null;
}

/** 根据权威金额与最新委托价向下整手，数量只在安全整数边界进入执行信号。 */
export function calculateBuyQuantityByNotional(
  notional: string,
  price: string,
  lotSize: number,
): number | null {
  if (!Number.isSafeInteger(lotSize) || lotSize <= 0)
    throw new RangeError('Lot size must be a positive safe integer');

  if (exactCompare(notional, '0') <= 0 || exactCompare(price, '0') <= 0) return null;

  const quantity = safeQuantityNumber(wholeLotQuantity(notional, price, String(lotSize)));
  return quantity === 0 ? null : quantity;
}

/** ACTIVE 起点晚于等待起点时，原周期基线已失效，不继承旧空仓等待。 */
export function shouldResetPeriodicPendingBySeatActivatedAt(params: {
  readonly pendingSinceMs: number | null;
  readonly lastSeatActivatedAt: number | null;
}): boolean {
  return (
    params.pendingSinceMs !== null &&
    params.lastSeatActivatedAt !== null &&
    params.lastSeatActivatedAt > params.pendingSinceMs
  );
}
