/**
 * 指标处理流水线模块
 *
 * 功能：
 * - 每秒从应用层本地 K 线缓存读取快照
 * - 直接构建当前趋势策略所需的 factor snapshot
 * - 同步写回 monitorState 与展示层缓存
 */
import { buildTrendFactorSnapshot } from '../../services/factors/runtime/index.js';
import { logger } from '../../utils/logger/index.js';
import { Period } from 'longbridge';
import type { StrategyThresholdConfig } from '../../types/factor.js';
import type { IndicatorSnapshot } from '../../types/quote.js';
import type { IndicatorPipelineParams, TrendFactorCandlesByPeriod } from './types.js';
import { formatSymbolDisplay } from '../../utils/display/index.js';

function buildTrendIndicatorSnapshot(params: {
  readonly cacheSnapshot: NonNullable<
    ReturnType<IndicatorPipelineParams['mainContext']['marketDataClient']['getCandlestickSnapshot']>
  >;
  readonly candlesByPeriod: TrendFactorCandlesByPeriod;
  readonly monitorQuote: IndicatorPipelineParams['monitorQuote'];
  readonly strategyConfig: StrategyThresholdConfig;
}): IndicatorSnapshot | null {
  const { cacheSnapshot, candlesByPeriod, monitorQuote, strategyConfig } = params;
  const quotePrice = monitorQuote?.price ?? null;
  const resolvedQuotePrice =
    quotePrice !== null && Number.isFinite(quotePrice) && quotePrice > 0 ? quotePrice : null;
  if (resolvedQuotePrice === null) {
    logger.warn(
      `[${formatSymbolDisplay(cacheSnapshot.symbol)}] 监控标的实时价格无效，跳过本轮因子快照构建`,
    );
    return null;
  }

  const changePercent =
    monitorQuote !== null && monitorQuote.prevClose > 0
      ? ((resolvedQuotePrice - monitorQuote.prevClose) / monitorQuote.prevClose) * 100
      : null;
  const factorSnapshot = buildTrendFactorSnapshot({
    candlesByPeriod,
    currentPrice: resolvedQuotePrice,
    strategyConfig,
  });
  if (!factorSnapshot) {
    return null;
  }

  return {
    symbol: cacheSnapshot.symbol,
    price: resolvedQuotePrice,
    changePercent,
    factorSnapshot,
  };
}

function isValidCandlestickSnapshot(
  snapshot: ReturnType<
    IndicatorPipelineParams['mainContext']['marketDataClient']['getCandlestickSnapshot']
  >,
): snapshot is NonNullable<
  ReturnType<IndicatorPipelineParams['mainContext']['marketDataClient']['getCandlestickSnapshot']>
> {
  return snapshot !== null && snapshot.initialized && snapshot.candles.length > 0;
}

function getRequiredCandlesByPeriod(params: {
  readonly marketDataClient: IndicatorPipelineParams['mainContext']['marketDataClient'];
  readonly baseInstrumentSymbol: string;
  readonly baseInstrumentName: string;
}): {
  readonly cacheSnapshot: NonNullable<
    ReturnType<IndicatorPipelineParams['mainContext']['marketDataClient']['getCandlestickSnapshot']>
  >;
  readonly candlesByPeriod: TrendFactorCandlesByPeriod;
} | null {
  const min1Snapshot = params.marketDataClient.getCandlestickSnapshot(
    params.baseInstrumentSymbol,
    Period.Min_1,
  );
  const min5Snapshot = params.marketDataClient.getCandlestickSnapshot(
    params.baseInstrumentSymbol,
    Period.Min_5,
  );
  const min15Snapshot = params.marketDataClient.getCandlestickSnapshot(
    params.baseInstrumentSymbol,
    Period.Min_15,
  );

  if (!isValidCandlestickSnapshot(min1Snapshot)) {
    logger.warn(
      `未获取到监控标的 ${formatSymbolDisplay(params.baseInstrumentSymbol, params.baseInstrumentName)} 1m K线缓存快照`,
    );
    return null;
  }

  if (!isValidCandlestickSnapshot(min5Snapshot)) {
    logger.warn(
      `未获取到监控标的 ${formatSymbolDisplay(params.baseInstrumentSymbol, params.baseInstrumentName)} 5m K线缓存快照`,
    );
    return null;
  }

  if (!isValidCandlestickSnapshot(min15Snapshot)) {
    logger.warn(
      `未获取到监控标的 ${formatSymbolDisplay(params.baseInstrumentSymbol, params.baseInstrumentName)} 15m K线缓存快照`,
    );
    return null;
  }

  return {
    cacheSnapshot: min1Snapshot,
    candlesByPeriod: {
      min1: min1Snapshot.candles,
      min5: min5Snapshot.candles,
      min15: min15Snapshot.candles,
    },
  };
}

/**
 * 执行指标处理流水线。
 * 当前趋势路径直接从最新 K 线快照构建 factor snapshot。
 */
export function runIndicatorPipeline(params: IndicatorPipelineParams): IndicatorSnapshot | null {
  const { monitorContext, mainContext, monitorQuote } = params;
  const { marketDataClient, marketMonitor } = mainContext;
  const { state } = monitorContext;
  const baseInstrumentSymbol = monitorContext.config.baseInstrumentSymbol;

  const requiredSnapshots = getRequiredCandlesByPeriod({
    marketDataClient,
    baseInstrumentSymbol,
    baseInstrumentName: monitorContext.baseInstrumentName,
  });
  if (requiredSnapshots === null) {
    return null;
  }

  const { cacheSnapshot, candlesByPeriod } = requiredSnapshots;
  const monitorSnapshot = buildTrendIndicatorSnapshot({
    cacheSnapshot,
    candlesByPeriod,
    monitorQuote,
    strategyConfig: monitorContext.config.strategyConfig,
  });
  if (!monitorSnapshot) {
    logger.warn(
      `[${formatSymbolDisplay(baseInstrumentSymbol, monitorContext.baseInstrumentName)}] 无法构建趋势因子快照，跳过本次处理`,
    );
    return null;
  }

  marketMonitor.monitorIndicatorChanges({
    monitorSnapshot,
    monitorQuote,
    baseInstrumentSymbol,
    klineTimestamp: cacheSnapshot.lastBarTimestamp,
    monitorState: state,
  });

  state.lastMonitorSnapshot = monitorSnapshot;
  state.lastCandlestickCacheVersion = cacheSnapshot.version;

  return monitorSnapshot;
}
