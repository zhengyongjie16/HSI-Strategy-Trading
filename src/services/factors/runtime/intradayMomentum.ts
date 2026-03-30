/**
 * factor runtime 日内动量编排模块
 *
 * 职责：
 * - 将 1m / 5m / 15m K 线规整为 trend factor 所需的 bar 视图
 * - 组合动量、波动率、VWAP、结构与确认层，生成因子快照
 */
import type { CandleData } from '../../../types/data.js';
import type {
  FactorReadiness,
  FactorSnapshot,
  StrategyThresholdConfig,
} from '../../../types/factor.js';
import type { MultiPeriodCandles, NormalizedBar } from './types.js';
import {
  computeAtr,
  computeEr,
  computePercentileRank,
  computeRealizedVolatility,
  computeReturns,
} from './math.js';
import {
  collectRecentTradingDayKeys,
  filterBarsByDayKey,
  filterBarsBySession,
  getHongKongParts,
  getSessionPhase,
  isBlockedByNoiseWindow,
  sliceSessionBarsForDay,
} from './session.js';
import { classifyRegime } from './volatilityRegime.js';
import {
  computeMomentumSnapshot,
  applyMultiTimeframeTrendConsistency,
  computeTrendClassification,
  resolveEffectiveTrendScore,
} from './trendClassifier.js';
import { computeVwapSnapshot } from './sessionVwap.js';
import { computeOpeningStructure, computePmContinuation } from './openingStructure.js';
import { computeConfirmation } from './confirmation.js';

/**
 * 将原始 CandleData 规整为趋势计算所需的 bar。
 *
 * @param params candles 与当前交易日键
 * @returns 归一化后的 bars
 */
function normalizeBars(params: {
  readonly candles: ReadonlyArray<CandleData>;
  readonly currentDayKey?: string;
}): ReadonlyArray<NormalizedBar> {
  const normalized: NormalizedBar[] = [];
  for (const candle of params.candles) {
    const close =
      typeof candle.close === 'number' && Number.isFinite(candle.close) ? candle.close : null;
    const high =
      typeof candle.high === 'number' && Number.isFinite(candle.high) ? candle.high : null;
    const low = typeof candle.low === 'number' && Number.isFinite(candle.low) ? candle.low : null;
    const volume =
      typeof candle.volume === 'number' && Number.isFinite(candle.volume) ? candle.volume : 0;
    const timestamp = typeof candle.timestamp === 'number' ? candle.timestamp : null;
    if (close === null || high === null || low === null || timestamp === null) {
      continue;
    }

    const { dayKey, minuteOfDay } = getHongKongParts(timestamp);
    if (params.currentDayKey && dayKey !== params.currentDayKey) {
      continue;
    }

    if (getSessionPhase(minuteOfDay) === 'closed') {
      continue;
    }

    normalized.push({
      close,
      high,
      low,
      volume,
      timestamp,
    });
  }

  normalized.sort((left, right) => left.timestamp - right.timestamp);
  return normalized;
}

/**
 * 计算同 session 历史波动率分位。
 *
 * @param params bars、交易日键、session 与观察窗口
 * @returns 当前 RV30、分位数与历史样本数
 */
function computeSessionRv30Quantile(params: {
  readonly bars: ReadonlyArray<NormalizedBar>;
  readonly currentDayKey: string;
  readonly session: 'am' | 'pm';
  readonly cutoffMinuteOfDay: number;
  readonly rvQuantileWindowDays: number;
}): {
  readonly currentRv30: number | null;
  readonly volQuantile: number | null;
  readonly historicalSampleCount: number;
} {
  const currentSessionBars = sliceSessionBarsForDay({
    bars: params.bars,
    dayKey: params.currentDayKey,
    session: params.session,
    cutoffMinuteOfDay: params.cutoffMinuteOfDay,
  });
  const currentRv30 = computeRealizedVolatility(computeReturns(currentSessionBars.slice(-31)));

  const historicalDayKeys = collectRecentTradingDayKeys({
    bars: params.bars,
    currentDayKey: params.currentDayKey,
    lookbackDays: params.rvQuantileWindowDays,
  });
  const historicalRv30Series = historicalDayKeys
    .map((dayKey) => {
      const sessionBars = sliceSessionBarsForDay({
        bars: params.bars,
        dayKey,
        session: params.session,
        cutoffMinuteOfDay: params.cutoffMinuteOfDay,
      });
      return computeRealizedVolatility(computeReturns(sessionBars.slice(-31)));
    })
    .filter((rv): rv is number => rv !== null);
  const volQuantile = computePercentileRank(historicalRv30Series, currentRv30);

  return {
    currentRv30,
    volQuantile,
    historicalSampleCount: historicalRv30Series.length,
  };
}

/**
 * 计算趋势准备状态。
 *
 * @param params 各层 readiness 依赖
 * @returns readiness 状态
 */
function computeReadiness(params: {
  readonly regimeReady: boolean;
  readonly trendBars: ReadonlyArray<NormalizedBar>;
  readonly activeSessionBars: ReadonlyArray<NormalizedBar>;
  readonly trendScore: number | null;
  readonly trendScore5m: number | null;
  readonly trendScore15m: number | null;
  readonly session: 'am' | 'pm' | 'closed';
  readonly openingStructure: FactorSnapshot['openingStructure'];
  readonly vwap: FactorSnapshot['vwap'];
}): FactorReadiness {
  const reasons: string[] = [];
  if (!params.regimeReady) {
    reasons.push('波动率基线未就绪');
  }

  const trendReady =
    params.trendBars.length >= (params.session === 'closed' ? 0 : 60) &&
    params.trendScore !== null &&
    params.trendScore5m !== null &&
    params.trendScore15m !== null;
  if (!trendReady) {
    reasons.push('趋势样本不足');
  }

  const structureReady =
    params.openingStructure.orHigh !== null && params.openingStructure.orLow !== null;
  if (!structureReady) {
    reasons.push('开盘结构未就绪');
  }

  const confirmationReady =
    params.session !== 'closed' &&
    params.trendBars.length >= 34 &&
    params.activeSessionBars.length >= 2 &&
    params.vwap.activeSessionVwap !== null &&
    params.vwap.activeSessionVwapSlope !== null;
  if (!confirmationReady) {
    reasons.push('确认层未就绪');
  }

  return {
    regimeReady: params.regimeReady,
    trendReady,
    structureReady,
    confirmationReady,
    overallReady: params.regimeReady && trendReady && structureReady && confirmationReady,
    reasons,
  };
}

/**
 * 将 1m / 5m / 15m K 线缓存转换为趋势因子快照。
 *
 * @param params candlesByPeriod、currentPrice 与策略阈值
 * @returns 因子快照；无可用样本时返回 null
 */
export function buildTrendFactorSnapshot(params: {
  readonly candlesByPeriod: MultiPeriodCandles;
  readonly currentPrice: number;
  readonly strategyConfig: StrategyThresholdConfig;
}): FactorSnapshot | null {
  const allSessionBars = normalizeBars({
    candles: params.candlesByPeriod.min1,
  });
  if (allSessionBars.length === 0) {
    return null;
  }

  const latestKnownBar = allSessionBars.at(-1);
  if (!latestKnownBar) {
    return null;
  }

  const currentDayKey = getHongKongParts(latestKnownBar.timestamp).dayKey;
  const dayBars = filterBarsByDayKey(allSessionBars, currentDayKey);
  if (dayBars.length === 0) {
    return null;
  }

  const latestBar = dayBars.at(-1);
  if (!latestBar) {
    return null;
  }

  const { minuteOfDay } = getHongKongParts(latestBar.timestamp);
  const session = getSessionPhase(minuteOfDay);
  if (session === 'closed') {
    return null;
  }

  const activeSessionBars = filterBarsBySession(dayBars, session);
  if (activeSessionBars.length === 0) {
    return null;
  }

  const intradayTradingBars = dayBars;
  const intradayTradingBars5m = normalizeBars({
    candles: params.candlesByPeriod.min5,
    currentDayKey,
  });
  const intradayTradingBars15m = normalizeBars({
    candles: params.candlesByPeriod.min15,
    currentDayKey,
  });

  const currentPrice = params.currentPrice > 0 ? params.currentPrice : latestBar.close;
  const momentumResult = computeMomentumSnapshot({
    bars: intradayTradingBars,
    strategyConfig: params.strategyConfig,
    barMinutes: 1,
  });
  const momentumResult5m = computeMomentumSnapshot({
    bars: intradayTradingBars5m,
    strategyConfig: params.strategyConfig,
    barMinutes: 5,
  });
  const momentumResult15m = computeMomentumSnapshot({
    bars: intradayTradingBars15m,
    strategyConfig: params.strategyConfig,
    barMinutes: 15,
  });
  const er15 = computeEr(intradayTradingBars, 15);
  const er30 = computeEr(intradayTradingBars, 30);
  const atr15 = computeAtr(intradayTradingBars, 15);
  const atrShort = computeAtr(
    activeSessionBars,
    params.strategyConfig.regimeThresholds.atrShortPeriod,
  );
  const atrLong = computeAtr(
    activeSessionBars,
    params.strategyConfig.regimeThresholds.atrLongPeriod,
  );
  const volExpansion =
    atrShort === null || atrLong === null || atrLong <= 0 ? null : atrShort / atrLong;
  const rvQuantile = computeSessionRv30Quantile({
    bars: allSessionBars,
    currentDayKey,
    session,
    cutoffMinuteOfDay: minuteOfDay,
    rvQuantileWindowDays: params.strategyConfig.regimeThresholds.rvQuantileWindowDays,
  });
  const volQuantile = rvQuantile.volQuantile;
  const requiredBaselineDays = Math.max(
    1,
    Math.floor(params.strategyConfig.regimeThresholds.rvQuantileWindowDays),
  );
  const regimeReady =
    volExpansion !== null &&
    volQuantile !== null &&
    rvQuantile.historicalSampleCount >= requiredBaselineDays;
  const vwap = computeVwapSnapshot({
    bars: dayBars,
    activeSessionBars,
    latestPrice: currentPrice,
    slopeWindowBars: params.strategyConfig.vwapConfirmRules.slopeWindowBars,
  });
  const openingStructure = computeOpeningStructure({
    bars: dayBars,
    latestPrice: currentPrice,
    atrReference: atr15,
    rules: params.strategyConfig.openingStructureRules,
  });
  const confirmation = computeConfirmation({
    closes: intradayTradingBars.map((bar) => bar.close),
    latestPrice: currentPrice,
    vwap,
    atr15,
    strategyConfig: params.strategyConfig,
  });
  const pmContinuation = computePmContinuation({
    bars: dayBars,
    latestPrice: currentPrice,
    trendScore: momentumResult.trendScore,
    er15: er15,
    vwap,
    rules: params.strategyConfig.pmContinuationRules,
  });
  const effectiveTrendScore = resolveEffectiveTrendScore({
    trendScore: momentumResult.trendScore,
  });
  const readiness = computeReadiness({
    regimeReady,
    trendBars: intradayTradingBars,
    activeSessionBars,
    trendScore: effectiveTrendScore,
    trendScore5m: momentumResult5m.trendScore,
    trendScore15m: momentumResult15m.trendScore,
    session,
    vwap,
    openingStructure,
  });
  const volatilityRegime = regimeReady
    ? classifyRegime({
        volExpansion,
        volQuantile,
        thresholds: params.strategyConfig.regimeThresholds,
      })
    : null;
  const baseTrendClassification = computeTrendClassification({
    momentum: momentumResult.momentum,
    trendScore: effectiveTrendScore,
    threshold: params.strategyConfig.trendScoreThresholds.classificationThreshold,
  });
  const trendClassification = applyMultiTimeframeTrendConsistency({
    baseClassification: baseTrendClassification,
    classificationThreshold: params.strategyConfig.trendScoreThresholds.classificationThreshold,
    trendScore5m: momentumResult5m.trendScore,
    trendScore15m: momentumResult15m.trendScore,
  });

  return {
    session,
    timestamp: latestBar.timestamp,
    benchmarkPrice: currentPrice,
    readiness,
    volatilityRegime,
    trendClassification,
    trendScore: effectiveTrendScore,
    reverseTrendScore: effectiveTrendScore === null ? null : -effectiveTrendScore,
    er15,
    er30,
    momentum: momentumResult.momentum,
    vwap,
    openingStructure,
    pmContinuation,
    confirmation,
    blockedByNoiseWindow: isBlockedByNoiseWindow({
      timestamp: latestBar.timestamp,
      rules: params.strategyConfig.openingStructureRules,
    }),
  };
}
