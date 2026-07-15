/**
 * 信号处理模块 - 风险检查流水线
 *
 * 功能：
 * - 执行买入信号风险检查并过滤无效信号
 * - 维护风险检查冷却与交易频率控制
 * - 轻检查通过后实时拉取账户与持仓
 */
import { isValidPositiveNumber } from '../../utils/helpers/index.js';
import { logger } from '../../utils/logger/index.js';
import { formatSymbolDisplayFromQuote } from '../utils.js';
import { VERIFICATION } from '../../constants/index.js';
import { getDoomsdayBuyCutoffWindowRangeLabel } from '../doomsdayProtection/utils.js';
import { getSymbolName, isBuyPriceWithinLatestOrderLimit } from './utils.js';
import type { Quote } from '../../types/quote.js';
import type { BuySignal } from '../../types/signal.js';
import type { LiquidationCooldownConfig, TradingConfig } from '../../types/config.js';
import type { BuyRiskCheckContext } from '../../types/services.js';
import type { LiquidationCooldownTracker } from '../../services/liquidationCooldown/types.js';

const HIGH_FRESHNESS_API_RETRY_CONFIG = {
  retries: 0,
  delayMs: 0,
} as const;

/** 生成买入风险检查冷却键；同一标的的 BUYCALL / BUYPUT 共用 BUY 语义。 */
function getRiskCheckCooldownKey(symbol: string): string {
  return `${symbol}_BUY`;
}

/**
 * 在任何冷却写入、外部读取或风险检查前验证买入风控入口不变量。
 * 类型系统负责正常调用方，运行时校验负责阻断 JavaScript 或强制断言绕过类型边界的卖出信号。
 */
function assertBuySignals(signals: ReadonlyArray<BuySignal>): void {
  for (const signal of signals) {
    const runtimeAction: unknown = signal.action;
    if (runtimeAction !== 'BUYCALL' && runtimeAction !== 'BUYPUT') {
      throw new Error(
        `买入风控只接受 BUYCALL 或 BUYPUT，收到 ${String(runtimeAction)}: ${signal.symbol}`,
      );
    }
  }
}

function getMaximumCooldownRemainingMs(params: {
  readonly liquidationCooldownTracker: LiquidationCooldownTracker;
  readonly cooldownConfig: LiquidationCooldownConfig | null;
  readonly currentTimeMs: number;
}): number {
  const { liquidationCooldownTracker, cooldownConfig, currentTimeMs } = params;
  const longRemainingMs = liquidationCooldownTracker.getRemainingMs({
    direction: 'LONG',
    cooldownConfig,
    currentTimeMs,
  });
  const shortRemainingMs = liquidationCooldownTracker.getRemainingMs({
    direction: 'SHORT',
    cooldownConfig,
    currentTimeMs,
  });

  return Math.max(longRemainingMs, shortRemainingMs);
}

function getSignalQuote(params: {
  readonly signalSymbol: string;
  readonly longSymbol: string;
  readonly shortSymbol: string;
  readonly longQuote: Quote | null;
  readonly shortQuote: Quote | null;
}): Quote | null {
  const { signalSymbol, longSymbol, shortSymbol, longQuote, shortQuote } = params;
  if (signalSymbol === longSymbol) {
    return longQuote;
  }

  if (signalSymbol === shortSymbol) {
    return shortQuote;
  }

  return null;
}

/**
 * 创建风险检查流水线
 * 返回一个只接受买入信号的异步函数：先做统一冷却过滤，再按固定顺序执行风控。
 * 轻检查通过后实时拉取账户/持仓并执行基础风险检查。
 */
export const createRiskCheckPipeline = ({
  tradingConfig,
  liquidationCooldownTracker,
  lastRiskCheckTime,
}: {
  readonly tradingConfig: TradingConfig;
  readonly liquidationCooldownTracker: LiquidationCooldownTracker;
  readonly lastRiskCheckTime: Map<string, number>;
}): ((
  signals: ReadonlyArray<BuySignal>,
  context: BuyRiskCheckContext,
) => Promise<ReadonlyArray<BuySignal>>) => {
  /** 对买入信号列表应用固定顺序的风险检查，过滤不符合条件的信号。 */
  const applyRiskChecks = async (
    signals: ReadonlyArray<BuySignal>,
    context: BuyRiskCheckContext,
  ): Promise<ReadonlyArray<BuySignal>> => {
    assertBuySignals(signals);

    const {
      trader,
      riskChecker,
      orderRecorder,
      longQuote,
      shortQuote,
      monitorQuote,
      monitorSnapshot,
      longSymbol,
      shortSymbol,
      longSymbolName,
      shortSymbolName,
      currentTime,
      isHalfDay,
      doomsdayProtection,
    } = context;

    // 在本次调用入口固定当前毫秒时间，供冷却过滤/冷却写入/清仓冷却查询复用
    const currentTimeMs = Date.now();

    // 先过滤风险检查冷却期信号
    // 这样可以避免冷却期内信号进入后续检查与实时数据拉取
    const cooldownMs = VERIFICATION.VERIFIED_SIGNAL_COOLDOWN_SECONDS * 1000;
    const signalsAfterCooldown: BuySignal[] = [];
    for (const sig of signals) {
      const sigSymbol = sig.symbol;
      const cooldownKey = getRiskCheckCooldownKey(sigSymbol);
      const lastTime = lastRiskCheckTime.get(cooldownKey);
      if (lastTime && currentTimeMs - lastTime < cooldownMs) {
        const remainingSeconds = Math.ceil((lastTime + cooldownMs - currentTimeMs) / 1000);
        const reason = `风险检查冷却期内，剩余 ${remainingSeconds} 秒`;
        logger.warn(`[风险检查冷却] ${sigSymbol} ${sig.action}: ${reason}`);
      } else {
        signalsAfterCooldown.push(sig);
      }
    }

    // 如果所有信号都被冷却拦截，直接返回空数组
    if (signalsAfterCooldown.length === 0) {
      return [];
    }

    const finalSignals: BuySignal[] = [];

    // 遍历过滤后的信号进行风险检查
    for (const sig of signalsAfterCooldown) {
      const sigSymbol = sig.symbol;
      const sigName = getSymbolName(
        sig.symbol,
        longSymbol,
        shortSymbol,
        longSymbolName,
        shortSymbolName,
      );
      const signalLabel = `${sigName}(${sigSymbol}) ${sig.action}`;

      // 标记进入风险检查的时间（在处理信号前标记，确保后续相同信号被冷却）
      const cooldownKey = getRiskCheckCooldownKey(sigSymbol);
      lastRiskCheckTime.set(cooldownKey, currentTimeMs);

      const signalQuote = getSignalQuote({
        signalSymbol: sigSymbol,
        longSymbol,
        shortSymbol,
        longQuote,
        shortQuote,
      });
      const currentPrice = signalQuote?.price ?? null;

      const isLongBuyAction = sig.action === 'BUYCALL';
      const directionDesc = isLongBuyAction ? '做多标的' : '做空标的';

      /**
       * 买入风险检查流水线顺序（固定）：
       * 1. 风险检查冷却（已在循环前完成）
       * 2. 交易频率限制
       * 3. 清仓冷却
       * 4. 买入价格限制
       * 5. 末日保护程序
       * 6. 牛熊证风险
       * 7. 信号报价的浮亏保护预筛（P1 最终执行报价门禁由 submitFlow 在 mutation permit 内执行）
       * 8. Promise.all([trader.getAccountSnapshot(), trader.getStockPositions()])
       * 9. 基础风险检查（使用第 8 步实时数据）
       */
      const tradeCheck = trader.canTradeNow(sig.action);
      if (!tradeCheck.canTrade) {
        const waitSeconds = tradeCheck.waitSeconds ?? 0;
        const reason = `交易频率限制：${directionDesc} 在${context.config.buyIntervalSeconds}秒内已买入过，需等待 ${waitSeconds} 秒后才能再次买入`;
        logger.warn(`[交易频率限制] ${reason}：${signalLabel}`);
        continue;
      }

      const remainingMs = getMaximumCooldownRemainingMs({
        liquidationCooldownTracker,
        cooldownConfig: context.config.liquidationCooldown,
        currentTimeMs,
      });
      if (remainingMs > 0) {
        const remainingSeconds = Math.ceil(remainingMs / 1000);
        const reason = `清仓冷却期内，剩余 ${remainingSeconds} 秒，拒绝买入`;
        logger.warn(`[清仓冷却] ${signalLabel} ${reason}`);
        continue;
      }

      const latestBuyPrice = orderRecorder.getLatestBuyOrderPrice(sigSymbol, isLongBuyAction);
      if (
        currentPrice !== null &&
        latestBuyPrice !== null &&
        !isBuyPriceWithinLatestOrderLimit(currentPrice, latestBuyPrice)
      ) {
        const currentPriceStr = currentPrice.toFixed(3);
        const latestBuyPriceStr = latestBuyPrice.toFixed(3);
        const reason = `买入价格限制：当前价格 ${currentPriceStr} 高于或等于最新买入订单价格 ${latestBuyPriceStr}`;
        logger.warn(`[买入价格限制] ${directionDesc} ${reason}，拒绝买入：${signalLabel}`);
        continue;
      }

      if (latestBuyPrice !== null && currentPrice !== null) {
        logger.debug(
          `[买入价格限制] ${directionDesc} 当前价格 ${currentPrice.toFixed(3)} 低于最新买入订单价格 ${latestBuyPrice.toFixed(3)}，允许买入：${signalLabel}`,
        );
      }

      if (
        tradingConfig.global.doomsdayProtection &&
        doomsdayProtection.isBuyCutoffWindowActive(currentTime, isHalfDay)
      ) {
        const closeTimeRange = getDoomsdayBuyCutoffWindowRangeLabel(isHalfDay);
        const reason = `末日保护程序：买入截止窗口内拒绝买入（当前时间在${closeTimeRange}范围内）`;
        logger.warn(`[末日保护程序] ${reason}：${signalLabel}`);
        continue;
      }

      const monitorCurrentPrice = monitorQuote?.price ?? monitorSnapshot?.price ?? null;
      const warrantRiskResult = riskChecker.checkWarrantRisk(
        sig.symbol,
        sig.action,
        monitorCurrentPrice ?? 0,
      );
      if (warrantRiskResult.allowed) {
        if (warrantRiskResult.warrantInfo?.isWarrant) {
          const warrantType =
            warrantRiskResult.warrantInfo.warrantType === 'BULL' ? '牛证' : '熊证';
          const distancePercent = warrantRiskResult.warrantInfo.distanceToStrikePercent;

          const symbolDisplay = formatSymbolDisplayFromQuote(signalQuote, sig.symbol);
          logger.debug(
            `[牛熊证风险检查] ${symbolDisplay} 为${warrantType}，距离回收价百分比：${distancePercent.toFixed(
              2,
            )}%，风险检查通过`,
          );
        }
      } else {
        const reason = warrantRiskResult.reason ?? '牛熊证风险检查未通过';
        logger.warn(`[牛熊证风险拦截] 信号被牛熊证风险控制拦截：${signalLabel} - ${reason}`);
        continue;
      }

      if (isValidPositiveNumber(currentPrice)) {
        const unrealizedLossCheck = riskChecker.checkUnrealizedLoss(
          sig.symbol,
          currentPrice,
          isLongBuyAction,
        );
        if (unrealizedLossCheck.shouldLiquidate) {
          logger.warn(`[浮亏风险拦截] 当前浮亏已触发保护性清仓阈值，拒绝买入：${signalLabel}`);
          continue;
        }
      }

      const [realtimeAccount, realtimePositions] = await Promise.all([
        trader.getAccountSnapshot({ retryConfig: HIGH_FRESHNESS_API_RETRY_CONFIG }),
        trader.getStockPositions({ retryConfig: HIGH_FRESHNESS_API_RETRY_CONFIG }),
      ]);

      const orderNotional = context.config.targetNotional;
      const buyRiskResult = riskChecker.checkBeforeOrder({
        account: realtimeAccount,
        positions: realtimePositions,
        signal: sig,
        orderNotional,
      });
      if (buyRiskResult.allowed) {
        finalSignals.push(sig);
      } else {
        const reason = buyRiskResult.reason ?? '基础风险检查未通过';
        logger.warn(`[风险拦截] 信号被风险控制拦截：${signalLabel} - ${reason}`);
      }
    }

    return finalSignals;
  };
  return applyRiskChecks;
};
