/**
 * 同步风险规则与共享状态入口。
 *
 * 依赖注入唯一的牛熊证、持仓限制、浮亏检查器，持有基础现金检查及实时 R1/N1 估值规则。
 * 买入、结算、激活、重建和展示消费相同风险状态；外部 warrant 获取由 riskRefresh 用例负责，
 * 保护性提交与完成事务分别属于 protectiveLiquidation 和 postTradeSettlement。
 */
import {
  exactCompare,
  exactMultiply,
  exactSubtract,
  formatDecimal,
} from '../../utils/numeric/exact.js';
import type { Position, AccountSnapshot, CashInfo } from '../../types/account.js';
import type { BuySignal } from '../../types/signal.js';

import type { RiskCheckResult, RiskChecker } from '../../types/riskCheck.js';
import type { UnrealizedLossMetrics } from '../../types/unrealizedLoss.js';
import type { RiskCheckerDeps } from './types.js';

/**
 * 创建同步风险规则组合，不创建第二份缓存或异步 workflow。
 * 现金检查按账户可用性、港币现金、持仓限额的原顺序执行；其余规则读取注入的唯一状态。
 * @param deps 唯一牛熊证状态、持仓限额规则与浮亏状态
 * @returns RiskChecker 同步规则和 prepare-publish 能力
 */
export function createRiskChecker(deps: RiskCheckerDeps): RiskChecker {
  const { warrantRiskChecker, positionLimitChecker, unrealizedLossChecker } = deps;

  /**
   * 读取浮亏缓存并结合当前价格构造实时指标。
   * - R1: 开仓成本总额
   * - N1: 当前持仓数量
   * - R2: 按当前价估算的持仓市值（currentPrice * N1）
   * - unrealizedPnL: 持仓浮动盈亏（R2 - R1）
   * 仅在有持仓数量（N1>0）时要求有效当前价；N1<=0 时按 R2=0 处理，用于覆盖清仓后仍残留成本记录的场景。
   */
  function buildUnrealizedLossMetrics(
    symbol: string | null,
    currentPrice: string | null,
  ): UnrealizedLossMetrics | null {
    if (!symbol) {
      return null;
    }

    const lossData = unrealizedLossChecker.getUnrealizedLossData(symbol);
    if (!lossData) {
      return null;
    }

    const { r1, n1 } = lossData;
    if (!Number.isSafeInteger(n1) || n1 < 0 || exactCompare(r1, '0') < 0) {
      throw new TypeError('[risk] invalid published R1/N1');
    }

    let r2 = '0';
    if (n1 > 0) {
      if (currentPrice === null || exactCompare(currentPrice, '0') <= 0) return null;

      r2 = exactMultiply(currentPrice, String(n1));
    }

    return { r2, unrealizedPnL: exactSubtract(r2, r1) };
  }

  /** 买入订单前综合风险检查，按顺序执行：账户数据有效性 → 港币可用现金 → 持仓市值限制。 */
  function checkBeforeOrder(params: {
    readonly account: AccountSnapshot | null;
    readonly positions: ReadonlyArray<Position> | null;
    readonly signal: BuySignal;
    readonly orderNotional: string;
  }): RiskCheckResult {
    const { account, positions, signal, orderNotional } = params;

    if (!account) {
      return {
        allowed: false,
        reason: '账户数据不可用，无法进行风险检查，禁止买入操作',
      };
    }

    const { netAssets, totalCash } = account;

    exactCompare(netAssets, netAssets);
    exactCompare(totalCash, totalCash);

    const hkdCashInfo = account.cashInfos.find((c: CashInfo) => c.currency === 'HKD');
    const availableCash = hkdCashInfo?.availableCash ?? '0';

    if (exactCompare(availableCash, orderNotional) < 0) {
      return {
        allowed: false,
        reason: `港币可用现金 ${formatDecimal(availableCash, 2, 'unsigned')} HKD 不足以支付买入金额 ${formatDecimal(
          orderNotional,
          2,
          'unsigned',
        )} HKD`,
      };
    }

    // 检查单标的最大持仓市值限制
    const positionCheckResult = positionLimitChecker.checkLimit(signal, positions, orderNotional);
    if (!positionCheckResult.allowed) {
      return positionCheckResult;
    }

    return { allowed: true };
  }

  return {
    checkBeforeOrder,
    setWarrantInfoFromCallPrice: warrantRiskChecker.setWarrantInfoFromCallPrice,
    checkWarrantRisk: warrantRiskChecker.checkRisk,
    checkWarrantDistanceLiquidation: warrantRiskChecker.checkWarrantDistanceLiquidation,
    getWarrantDistanceInfo: warrantRiskChecker.getWarrantDistanceInfo,
    clearLongWarrantInfo: warrantRiskChecker.clearLongWarrantInfo,
    clearShortWarrantInfo: warrantRiskChecker.clearShortWarrantInfo,
    prepareUnrealizedLossData: unrealizedLossChecker.prepare,
    publishUnrealizedLossData: unrealizedLossChecker.publish,
    checkUnrealizedLoss: unrealizedLossChecker.check,
    getUnrealizedLossMetrics: buildUnrealizedLossMetrics,
    clearUnrealizedLossData: unrealizedLossChecker.clearUnrealizedLossData,
  };
}
