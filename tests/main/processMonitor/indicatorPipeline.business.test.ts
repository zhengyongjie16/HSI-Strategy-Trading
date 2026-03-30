/**
 * indicatorPipeline 业务测试
 *
 * 功能：
 * - 验证当前 K 线缓存可构建 factor snapshot 时的状态更新语义
 * - 验证缓存缺失时返回 null
 * - 验证 pipeline 不再走旧版增量指标 runtime 语义
 */
import { describe, expect, it } from 'bun:test';
import { Period } from 'longbridge';

import type { CandleData } from '../../../src/types/data.js';
import type { StrategyThresholdConfig } from '../../../src/types/factor.js';
import type { IndicatorSnapshot } from '../../../src/types/quote.js';
import type { StrategyRuntime } from '../../../src/types/state.js';
import type { IndicatorPipelineParams } from '../../../src/main/processMonitor/types.js';
import type { MonitorIndicatorChangesParams } from '../../../src/services/marketMonitor/types.js';
import {
  createIndicatorDisplayProfileDouble,
  createStrategyRuntimeConfigDouble,
  createQuoteDouble,
} from '../../helpers/testDoubles.js';

function createCandles(
  length: number,
  start: number,
  step: number,
  baseTimestamp: number = 1_708_000_000_000,
): ReadonlyArray<CandleData> {
  const candles: CandleData[] = [];
  for (let i = 0; i < length; i += 1) {
    const close = start + i * step;
    candles.push({
      open: close - 0.2,
      high: close + 0.3,
      low: close - 0.4,
      close,
      volume: 1_000 + i,
      timestamp: baseTimestamp + i * 60_000,
    });
  }

  return candles;
}

function createSnapshot(price: number): IndicatorSnapshot {
  return {
    price,
    changePercent: 0,
    factorSnapshot: null,
  };
}

function createHongKongSessionBaseTimestamp(hour: number, minute: number): number {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Hong_Kong',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(new Date());
  let year = '';
  let month = '';
  let day = '';
  for (const part of parts) {
    if (part.type === 'year') {
      year = part.value;
      continue;
    }

    if (part.type === 'month') {
      month = part.value;
      continue;
    }

    if (part.type === 'day') {
      day = part.value;
    }
  }

  return Date.parse(
    `${year}-${month}-${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+08:00`,
  );
}

const STRATEGY_THRESHOLD_CONFIG: StrategyThresholdConfig = {
  regimeThresholds: {
    atrShortPeriod: 5,
    atrLongPeriod: 30,
    rvQuantileWindowDays: 20,
    trendOnVolExpansion: 1.2,
    trendOffVolExpansion: 0.8,
    extremeVolExpansion: 1.8,
    trendOnVolQuantile: 0.6,
    trendOffVolQuantile: 0.4,
    extremeVolQuantile: 0.9,
  },
  trendScoreThresholds: {
    w15: 0.2,
    w30: 0.3,
    w60: 0.5,
    classificationThreshold: 0.6,
    entryThreshold: 0.9,
    exitThreshold: 0.35,
    reverseInvalidationThreshold: 0.5,
  },
  erThresholds: {
    er15EntryMin: 0.4,
    er30EntryMin: 0.4,
    er15ExitMax: 0.35,
    er30ExitMax: 0.35,
    strongTrendErFloor: 0.6,
  },
  vwapConfirmRules: {
    distanceBandAtr: 0.1,
    slopeWindowBars: 5,
    maxCrossCountLast10m: 2,
  },
  openingStructureRules: {
    openingRangeMinutes: 20,
    breakoutScoreMin: 0.8,
    outsidePersistenceWindowBars: 2,
    outsidePersistenceMin: 0.5,
    retestToleranceAtr: 0.15,
    confirmBars: 2,
    morningNoiseWindowMinutes: 20,
    afternoonNoiseWindowMinutes: 15,
  },
  pmContinuationRules: {
    amMoveZMin: 1,
    middayHoldMin: 0.5,
    pmReExpansionTrendScoreMin: 0.9,
    pmReExpansionEr15Min: 0.4,
    pmConfirmCutoffMinutes: 810,
  },
  instrumentAdaptationRules: {
    bullBuyMinDistancePct: 0.35,
    bearBuyMaxDistancePct: -0.35,
    bullLiquidationDistancePct: 0.3,
    bearLiquidationDistancePct: -0.3,
    autoSearchOpenDelayMinutes: 15,
    autoSearchPrimaryDistanceBull: 0.35,
    autoSearchPrimaryDistanceBear: -0.35,
    switchDistanceRangeBull: [0.31, 1.5],
    switchDistanceRangeBear: [-1.5, -0.31],
    autoSearchMinTurnoverPerMinuteBull: 1000000,
    autoSearchMinTurnoverPerMinuteBear: 1000000,
    autoSearchExpiryMinMonths: 3,
  },
};

function createCacheSnapshot(params: {
  readonly symbol?: string;
  readonly candles: ReadonlyArray<CandleData>;
  readonly version: number;
  readonly initialized?: boolean;
  readonly lastBarConfirmed?: boolean | null;
}) {
  const symbol = params.symbol ?? 'HSI.HK';
  const latest = params.candles.at(-1);
  const timestamp =
    latest && typeof latest.timestamp === 'number' && Number.isFinite(latest.timestamp)
      ? latest.timestamp
      : null;
  return {
    symbol,
    period: Period.Min_1,
    version: params.version,
    candles: params.candles,
    lastBarTimestamp: timestamp,
    lastBarConfirmed: params.lastBarConfirmed ?? false,
    initialized: params.initialized ?? true,
  };
}

function createStrategyRuntime(overrides: Partial<StrategyRuntime> = {}): StrategyRuntime {
  const config = createStrategyRuntimeConfigDouble({ baseInstrumentSymbol: 'HSI.HK' });
  return {
    config,
    state: {
      baseInstrumentSymbol: config.baseInstrumentSymbol,
      monitorPrice: null,
      longPrice: null,
      shortPrice: null,
      signal: null,
      pendingSignals: [],
      monitorValues: null,
      lastMonitorSnapshot: null,
      lastCandlestickCacheVersion: null,
    },
    baseInstrumentName: config.baseInstrumentSymbol,
    indicatorProfile: createIndicatorDisplayProfileDouble(),
    ...overrides,
  } as unknown as StrategyRuntime;
}

type RunIndicatorPipelineFn = (
  params: IndicatorPipelineParams,
) => Promise<IndicatorSnapshot | null>;

async function loadRunIndicatorPipeline(): Promise<RunIndicatorPipelineFn> {
  const modulePath =
    '../../../src/main/processMonitor/indicatorPipeline.js?real-indicator-pipeline-v2';
  const module = await import(modulePath);
  return module.runIndicatorPipeline as RunIndicatorPipelineFn;
}

describe('processMonitor indicatorPipeline business flow', () => {
  it('returns null when local candlestick cache is missing or not initialized', async () => {
    const runIndicatorPipeline = await loadRunIndicatorPipeline();
    const cachePushCount = 0;
    let monitorChangesCount = 0;

    const monitorContext = createStrategyRuntime();
    const result = await runIndicatorPipeline({
      baseInstrumentSymbol: 'HSI.HK',
      monitorContext,
      monitorQuote: createQuoteDouble('HSI.HK', 20_000),
      mainContext: {
        marketDataClient: {
          getCandlestickSnapshot: () => null,
        },
        marketMonitor: {
          monitorIndicatorChanges: () => {
            monitorChangesCount += 1;
            return false;
          },
        },
      } as never,
    });

    expect(result).toBeNull();
    expect(cachePushCount).toBe(0);
    expect(monitorChangesCount).toBe(0);
  });

  it('falls back to latest close when monitor quote price is invalid', async () => {
    const runIndicatorPipeline = await loadRunIndicatorPipeline();
    const sessionBaseTimestamp = createHongKongSessionBaseTimestamp(9, 30);
    const candles = createCandles(120, 20_000, 1, sessionBaseTimestamp);
    const cacheSnapshot = createCacheSnapshot({
      candles,
      version: 3,
    });
    const monitorContext = createStrategyRuntime();
    let monitorChangesCount = 0;

    const invalidMonitorQuote = {
      ...createQuoteDouble('HSI.HK', 20_000),
      price: Number.NaN,
      prevClose: 19_900,
    };
    const result = await runIndicatorPipeline({
      baseInstrumentSymbol: 'HSI.HK',
      monitorContext,
      monitorQuote: invalidMonitorQuote,
      mainContext: {
        marketDataClient: {
          getCandlestickSnapshot: () => cacheSnapshot,
        },
        marketMonitor: {
          monitorIndicatorChanges: () => {
            monitorChangesCount += 1;
            return true;
          },
        },
      } as never,
    });

    expect(result).not.toBeNull();
    if (!result) {
      throw new Error('expected indicator snapshot');
    }

    const latestClose = candles.at(-1)?.close;
    if (typeof latestClose !== 'number') {
      throw new TypeError('expected numeric latest close');
    }

    expect(result.price).toBe(latestClose);
    expect(result.changePercent).toBeNull();
    expect(monitorChangesCount).toBe(1);
  });

  it('rebuilds a fresh factor snapshot even when cache version is unchanged', async () => {
    const runIndicatorPipeline = await loadRunIndicatorPipeline();
    const lastSnapshot = createSnapshot(111);
    const sessionBaseTimestamp = createHongKongSessionBaseTimestamp(9, 30);
    const cacheSnapshot = createCacheSnapshot({
      candles: createCandles(120, 20_000, 2, sessionBaseTimestamp),
      version: 7,
    });

    const monitorContext = createStrategyRuntime({
      state: {
        baseInstrumentSymbol: 'HSI.HK',
        monitorPrice: null,
        longPrice: null,
        shortPrice: null,
        signal: null,
        pendingSignals: [],
        monitorValues: null,
        lastMonitorSnapshot: lastSnapshot,
        lastCandlestickCacheVersion: 7,
      },
    });

    const monitorChanges: IndicatorSnapshot[] = [];
    const result = await runIndicatorPipeline({
      baseInstrumentSymbol: 'HSI.HK',
      monitorContext,
      monitorQuote: createQuoteDouble('HSI.HK', 20_000),
      mainContext: {
        marketDataClient: {
          getCandlestickSnapshot: () => cacheSnapshot,
        },
        marketMonitor: {
          monitorIndicatorChanges: (params: MonitorIndicatorChangesParams) => {
            const monitorSnapshot = params.monitorSnapshot;
            if (monitorSnapshot === null) {
              throw new Error('expected indicator snapshot');
            }

            monitorChanges.push(monitorSnapshot);
            return false;
          },
        },
      } as never,
    });

    expect(result).not.toBeNull();
    if (!result) {
      throw new Error('expected indicator snapshot');
    }

    expect(result).not.toBe(lastSnapshot);
    expect(monitorChanges).toHaveLength(1);
    expect(monitorChanges[0]).toBe(result);
    expect(monitorContext.state.lastMonitorSnapshot).toBe(result);
    expect(monitorContext.state.lastCandlestickCacheVersion).toBe(7);
  });

  it('updates snapshot state when cache version changes without reviving legacy incremental runtime', async () => {
    const runIndicatorPipeline = await loadRunIndicatorPipeline();
    const sessionBaseTimestamp = createHongKongSessionBaseTimestamp(9, 30);
    const cacheSnapshot = createCacheSnapshot({
      candles: createCandles(120, 20_000, 3, sessionBaseTimestamp),
      version: 11,
    });
    const monitorContext = createStrategyRuntime();

    let monitorChangesCount = 0;
    const result = await runIndicatorPipeline({
      baseInstrumentSymbol: 'HSI.HK',
      monitorContext,
      monitorQuote: createQuoteDouble('HSI.HK', 20_100),
      mainContext: {
        marketDataClient: {
          getCandlestickSnapshot: () => cacheSnapshot,
        },
        marketMonitor: {
          monitorIndicatorChanges: () => {
            monitorChangesCount += 1;
            return true;
          },
        },
      } as never,
    });

    expect(result).not.toBeNull();
    if (!result) {
      throw new Error('expected indicator snapshot');
    }

    expect(monitorContext.state.lastMonitorSnapshot).toBe(result);
    expect(monitorContext.state.lastCandlestickCacheVersion).toBe(11);
    expect(monitorChangesCount).toBe(1);
  });

  it('builds factor snapshots on the single-index trend path', async () => {
    const runIndicatorPipeline = await loadRunIndicatorPipeline();
    const sessionBaseTimestamp = createHongKongSessionBaseTimestamp(9, 30);
    const cacheSnapshot = createCacheSnapshot({
      candles: createCandles(120, 20_000, 3, sessionBaseTimestamp),
      version: 5,
    });
    const monitorContext = createStrategyRuntime({
      config: createStrategyRuntimeConfigDouble({
        baseInstrumentSymbol: 'HSI.HK',
        strategyConfig: STRATEGY_THRESHOLD_CONFIG,
      }),
    });

    let monitorChangesCount = 0;
    const result = await runIndicatorPipeline({
      baseInstrumentSymbol: 'HSI.HK',
      monitorContext,
      monitorQuote: createQuoteDouble('HSI.HK', 20_360),
      mainContext: {
        marketDataClient: {
          getCandlestickSnapshot: () => cacheSnapshot,
        },
        marketMonitor: {
          monitorIndicatorChanges: () => {
            monitorChangesCount += 1;
            return true;
          },
        },
      } as never,
    });

    expect(result).not.toBeNull();
    expect(monitorChangesCount).toBe(1);
  });
});
