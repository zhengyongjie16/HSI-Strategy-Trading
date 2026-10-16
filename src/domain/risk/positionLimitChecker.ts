/**
 * 持仓市值限制：保留成本价估值规则，以精确金融文本比较买入后单标的市值。
 * 成本价非正时仅检查计划金额，不以市场价替代成本价。
 */
import type { Position } from '../../types/account.js';
import type { BuySignal } from '../../types/signal.js';
import type { RiskCheckResult } from '../../types/riskCheck.js';
import { exactAdd, exactCompare, exactMultiply, formatDecimal } from '../../utils/numeric/exact.js';
import type { PositionLimitChecker, PositionLimitCheckerDeps } from './types.js';

/** 构建计划金额超限原因，展示只在出口一次 half-even。 */
function buildOrderNotionalExceededReason(orderNotional: string, max: string): string {
  return `本次计划下单金额 ${formatDecimal(orderNotional, 2, 'unsigned')} HKD 超过单标的最大持仓市值限制 ${formatDecimal(max, 2, 'unsigned')} HKD`;
}

/** 创建持仓限额检查器；内部文本/数量契约损坏直接抛出，不降级放行。 */
export const createPositionLimitChecker = (
  deps: PositionLimitCheckerDeps,
): PositionLimitChecker => {
  const maxPositionNotional = deps.maxPositionNotional;

  const checkLimit = (
    signal: BuySignal,
    positions: ReadonlyArray<Position> | null,
    orderNotional: string,
  ): RiskCheckResult => {
    if (exactCompare(orderNotional, '0') < 0) {
      return { allowed: false, reason: `计划下单金额无效：${orderNotional}` };
    }

    if (maxPositionNotional !== null && exactCompare(orderNotional, maxPositionNotional) > 0) {
      return {
        allowed: false,
        reason: buildOrderNotionalExceededReason(orderNotional, maxPositionNotional),
      };
    }

    const position = positions?.find((item) => item.symbol === signal.symbol);
    if (!position) {
      return { allowed: true };
    }

    if (!Number.isSafeInteger(position.quantity) || position.quantity < 0) {
      throw new RangeError('Position quantity must be a nonnegative safe integer');
    }

    if (position.quantity === 0 || exactCompare(position.costPrice, '0') <= 0) {
      return { allowed: true };
    }

    const currentNotional = exactMultiply(String(position.quantity), position.costPrice);
    const totalNotional = exactAdd(currentNotional, orderNotional);
    if (maxPositionNotional !== null && exactCompare(totalNotional, maxPositionNotional) > 0) {
      return {
        allowed: false,
        reason: `该标的当前持仓市值约 ${formatDecimal(currentNotional, 2, 'unsigned')} HKD（数量=${position.quantity} × 价格=${formatDecimal(position.costPrice, 3, 'unsigned')}），加上本次计划下单 ${formatDecimal(orderNotional, 2, 'unsigned')} HKD 将超过单标的最大持仓市值限制 ${formatDecimal(maxPositionNotional, 2, 'unsigned')} HKD`,
      };
    }

    return { allowed: true };
  };

  return { checkLimit };
};
