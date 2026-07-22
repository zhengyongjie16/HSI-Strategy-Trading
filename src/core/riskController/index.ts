/**
 * 风险控制模块入口（门面模式）
 *
 * 功能/职责：协调 warrantRiskChecker、positionLimitChecker、unrealizedLossChecker 三个子检查器，
 * 对外提供统一的 RiskChecker 接口（买入订单前检查、牛熊证风险、浮亏刷新与清仓判定等）。
 * 执行流程：依赖注入子检查器 → createRiskChecker 创建门面实例 → 调用方在买入订单前调用 checkBeforeOrder，
 * 买入前可选 checkWarrantRisk，浮亏监控侧调用 refreshUnrealizedLossData / checkUnrealizedLoss / checkWarrantDistanceLiquidation。
 *
 * 风险阈值（均为配置项，具体数值以 constants/index.ts 为准）：
 * - 牛熊证距离回收价：使用 BULL_WARRANT_MIN_DISTANCE_PERCENT / BEAR_WARRANT_MAX_DISTANCE_PERCENT 控制可买入距离（当前默认约为 +0.35% / -0.35%）
 * - 单标的市值上限：maxPositionNotional（由监控配置提供）
 * - 保护性清仓触发阈值：maxUnrealizedLossPerSymbol（浮亏低于阈值时触发保护性清仓）
 */
import { isValidPositiveNumber } from '../../utils/helpers/index.js';
import {
  decimalLt,
  decimalMul,
  decimalSub,
  decimalToNumberValue,
  formatDecimal,
  toDecimalValue,
} from '../../utils/numeric/index.js';
import type { Position, AccountSnapshot, CashInfo } from '../../types/account.js';
import type { BuySignal, SignalType } from '../../types/signal.js';
import type { Quote } from '../../types/quote.js';
import type {
  MarketDataClient,
  OrderRecorder,
  RiskCheckResult,
  UnrealizedLossMetrics,
  UnrealizedLossCheckResult,
  WarrantRefreshResult,
  RiskChecker,
} from '../../types/services.js';
import type {
  RiskCheckerDeps,
  WarrantRiskChecker,
  PositionLimitChecker,
  UnrealizedLossChecker,
} from './types.js';

/**
 * 创建风险检查器（门面模式）。
 * 聚合牛熊证、持仓限制、浮亏三个子检查器，对外提供统一 checkBeforeOrder / checkWarrantRisk / refreshUnrealizedLossData 等接口。
 * 买入订单前风控、牛熊证距离、浮亏刷新与清仓判定需在同一入口按固定顺序执行，门面统一依赖注入与调用顺序。
 * @param deps 依赖（warrantRiskChecker、positionLimitChecker、unrealizedLossChecker）
 * @returns 实现 RiskChecker 接口的门面实例
 */
export function createRiskChecker(deps: RiskCheckerDeps): RiskChecker {
  // 依赖注入：子检查器通过参数注入，不在内部创建
  const warrantRiskChecker: WarrantRiskChecker = deps.warrantRiskChecker;
  const positionLimitChecker: PositionLimitChecker = deps.positionLimitChecker;
  const unrealizedLossChecker: UnrealizedLossChecker = deps.unrealizedLossChecker;

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
    currentPrice: number | null,
  ): UnrealizedLossMetrics | null {
    if (!symbol) {
      return null;
    }

    const lossData = unrealizedLossChecker.getUnrealizedLossData(symbol);
    if (!lossData) {
      return null;
    }

    const { r1, n1 } = lossData;
    if (!Number.isFinite(r1) || !Number.isFinite(n1)) {
      return null;
    }

    let r2 = toDecimalValue(0);
    if (n1 > 0) {
      if (!isValidPositiveNumber(currentPrice)) {
        return null;
      }

      r2 = decimalMul(currentPrice, n1);
    }

    const unrealizedPnL = decimalSub(r2, r1);
    const r2Number = decimalToNumberValue(r2);
    const unrealizedPnLNumber = decimalToNumberValue(unrealizedPnL);
    if (!Number.isFinite(unrealizedPnLNumber)) {
      return null;
    }

    return {
      r1,
      n1,
      r2: r2Number,
      unrealizedPnL: unrealizedPnLNumber,
    };
  }

  /** 买入订单前综合风险检查，按顺序执行：账户数据有效性 → 港币可用现金 → 持仓市值限制。 */
  function checkBeforeOrder(params: {
    readonly account: AccountSnapshot | null;
    readonly positions: ReadonlyArray<Position> | null;
    readonly signal: BuySignal;
    readonly orderNotional: number;
  }): RiskCheckResult {
    const { account, positions, signal, orderNotional } = params;

    if (!account) {
      return {
        allowed: false,
        reason: '账户数据不可用，无法进行风险检查，禁止买入操作',
      };
    }

    const { netAssets, totalCash } = account;

    if (!Number.isFinite(netAssets) || !Number.isFinite(totalCash)) {
      return {
        allowed: false,
        reason: `账户数据无效（netAssets=${netAssets}, totalCash=${totalCash}），无法进行风险检查，禁止买入操作`,
      };
    }

    const hkdCashInfo = account.cashInfos.find((c: CashInfo) => c.currency === 'HKD');
    const availableCash = hkdCashInfo?.availableCash ?? 0;

    if (decimalLt(availableCash, orderNotional)) {
      return {
        allowed: false,
        reason: `港币可用现金 ${formatDecimal(availableCash, 2)} HKD 不足以支付买入金额 ${formatDecimal(
          orderNotional,
          2,
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
    setWarrantInfoFromCallPrice(
      symbol: string,
      callPrice: number,
      isLongSymbol: boolean,
      symbolName: string | null = null,
    ) {
      return warrantRiskChecker.setWarrantInfoFromCallPrice(
        symbol,
        callPrice,
        isLongSymbol,
        symbolName,
      );
    },

    async refreshWarrantInfoForSymbol(
      marketDataClient: MarketDataClient,
      symbol: string,
      isLongSymbol: boolean,
      symbolName: string | null = null,
    ): Promise<WarrantRefreshResult> {
      return warrantRiskChecker.refreshWarrantInfoForSymbol(
        marketDataClient,
        symbol,
        isLongSymbol,
        symbolName,
      );
    },

    checkBeforeOrder,

    checkWarrantRisk(
      symbol: string,
      signalType: SignalType,
      monitorCurrentPrice: number,
    ): RiskCheckResult {
      return warrantRiskChecker.checkRisk(symbol, signalType, monitorCurrentPrice);
    },

    checkWarrantDistanceLiquidation(
      symbol: string,
      isLongSymbol: boolean,
      monitorCurrentPrice: number,
    ) {
      return warrantRiskChecker.checkWarrantDistanceLiquidation(
        symbol,
        isLongSymbol,
        monitorCurrentPrice,
      );
    },

    getWarrantDistanceInfo(
      isLongSymbol: boolean,
      seatSymbol: string,
      monitorCurrentPrice: number | null,
    ) {
      return warrantRiskChecker.getWarrantDistanceInfo(
        isLongSymbol,
        seatSymbol,
        monitorCurrentPrice,
      );
    },
    clearLongWarrantInfo(): void {
      warrantRiskChecker.clearLongWarrantInfo();
    },
    clearShortWarrantInfo(): void {
      warrantRiskChecker.clearShortWarrantInfo();
    },

    async refreshUnrealizedLossData(
      orderRecorder: OrderRecorder,
      symbol: string,
      isLongSymbol: boolean,
      quote?: Quote | null,
      dailyLossOffset?: number,
    ): Promise<void> {
      await unrealizedLossChecker.refresh(
        orderRecorder,
        symbol,
        isLongSymbol,
        quote,
        dailyLossOffset,
      );
    },

    checkUnrealizedLoss(
      symbol: string,
      currentPrice: number,
      isLongSymbol: boolean,
    ): UnrealizedLossCheckResult {
      return unrealizedLossChecker.check(symbol, currentPrice, isLongSymbol);
    },

    getUnrealizedLossMetrics(
      symbol: string,
      currentPrice: number | null,
    ): UnrealizedLossMetrics | null {
      return buildUnrealizedLossMetrics(symbol, currentPrice);
    },

    clearUnrealizedLossData(symbol?: string | null): void {
      unrealizedLossChecker.clearUnrealizedLossData(symbol);
    },
  };
}
