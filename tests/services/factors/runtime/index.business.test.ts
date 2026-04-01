import { describe, expect, it } from 'bun:test';

import {
  buildTrendFactorSnapshot as buildTrendFactorSnapshotRaw,
  createSignalFromFactorDecision,
  planFactorSignals,
} from '../../../../src/services/factors/runtime/index.js';
import { computeTrendClassification } from '../../../../src/services/factors/runtime/trendClassifier.js';
import type { CandleData } from '../../../../src/types/data.js';
import type { FactorSnapshot, StrategyThresholdConfig } from '../../../../src/types/factor.js';
import { createStrategyRuntimeConfig } from '../../../../mock/factories/configFactory.js';
import { createPositionCacheDouble, createPositionDouble } from '../../../helpers/testDoubles.js';

const TEST_TIMESTAMP_MS = Date.UTC(2026, 2, 29, 2, 15, 0);
const TEST_HK_YEAR = 2026;
const TEST_HK_MONTH_INDEX = 2;
const TEST_HK_DAY = 30;

function createBullishFactorSnapshot(overrides: Partial<FactorSnapshot> = {}): FactorSnapshot {
  return {
    session: 'am',
    timestamp: TEST_TIMESTAMP_MS,
    benchmarkPrice: 100,
    readiness: {
      regimeReady: true,
      trendReady: true,
      structureReady: true,
      confirmationReady: true,
      overallReady: true,
      reasons: [],
    },
    volatilityRegime: 'expanding',
    trendClassification: 'trend_up',
    trendScore: 1.2,
    reverseTrendScore: -1.2,
    er15: 0.6,
    er30: 0.55,
    momentum: {
      mom15: 1,
      mom30: 1,
      mom60: 1,
      zMom15: 1,
      zMom30: 1,
      zMom60: 1,
      sameSignCount: 3,
    },
    vwap: {
      amVwap: 100,
      pmVwap: null,
      dayVwap: 100,
      activeSessionVwap: 100,
      activeSessionVwapSlope: 1,
      crossCountLast10m: 0,
      distanceFromActiveVwap: 1,
    },
    openingStructure: {
      orHigh: 101,
      orLow: 99,
      breakoutUp: true,
      breakoutDown: false,
      outsidePersistenceUp: 1,
      outsidePersistenceDown: null,
      retestHoldUp: false,
      retestHoldDown: false,
      failedBreakout: false,
    },
    pmContinuation: {
      amQualified: true,
      middayHold: false,
      pmConfirmed: false,
    },
    confirmation: {
      longAllowed: true,
      shortAllowed: false,
      emaAlignedLong: true,
      emaAlignedShort: false,
      macdAlignedLong: true,
      macdAlignedShort: false,
      vwapAlignedLong: true,
      vwapAlignedShort: false,
    },
    blockedByNoiseWindow: false,
    ...overrides,
  };
}

function toUtcTimestampFromHongKong(params: {
  readonly hour: number;
  readonly minute: number;
  readonly dayOffset?: number;
}): number {
  const dayOffset = params.dayOffset ?? 0;
  return Date.UTC(
    TEST_HK_YEAR,
    TEST_HK_MONTH_INDEX,
    TEST_HK_DAY + dayOffset,
    params.hour - 8,
    params.minute,
    0,
    0,
  );
}

function createMinuteCandles(params: {
  readonly startHour: number;
  readonly startMinute: number;
  readonly endHour: number;
  readonly endMinute: number;
  readonly startPrice: number;
  readonly step: number;
  readonly dayOffset?: number;
}): ReadonlyArray<CandleData> {
  const candles: CandleData[] = [];
  let minuteOfDay = params.startHour * 60 + params.startMinute;
  const endMinuteOfDay = params.endHour * 60 + params.endMinute;
  let price = params.startPrice;
  while (minuteOfDay <= endMinuteOfDay) {
    const hour = Math.floor(minuteOfDay / 60);
    const minute = minuteOfDay % 60;
    const timestampInput =
      params.dayOffset === undefined
        ? {
            hour,
            minute,
          }
        : {
            hour,
            minute,
            dayOffset: params.dayOffset,
          };
    candles.push({
      timestamp: toUtcTimestampFromHongKong(timestampInput),
      open: price,
      close: price,
      high: price + 0.05,
      low: price - 0.05,
      volume: 1_000,
    });
    minuteOfDay += 1;
    price += params.step;
  }

  return candles;
}

function aggregateCandles(
  candles: ReadonlyArray<CandleData>,
  periodMinutes: number,
): ReadonlyArray<CandleData> {
  if (periodMinutes <= 1 || candles.length === 0) {
    return candles;
  }

  type AggregateBucket = {
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    count: number;
    lastTimestamp: number;
  };
  const aggregated: CandleData[] = [];
  let bucket: AggregateBucket | null = null;
  for (const candle of candles) {
    const open = Number(candle.open);
    const high = Number(candle.high);
    const low = Number(candle.low);
    const close = Number(candle.close);
    const volume = Number(candle.volume);
    const timestamp = typeof candle.timestamp === 'number' ? candle.timestamp : null;
    if (
      timestamp === null ||
      !Number.isFinite(open) ||
      !Number.isFinite(high) ||
      !Number.isFinite(low) ||
      !Number.isFinite(close) ||
      !Number.isFinite(volume)
    ) {
      continue;
    }

    if (
      bucket === null ||
      timestamp - bucket.lastTimestamp !== 60_000 ||
      bucket.count >= periodMinutes
    ) {
      if (bucket !== null) {
        aggregated.push({
          open: bucket.open,
          high: bucket.high,
          low: bucket.low,
          close: bucket.close,
          volume: bucket.volume,
          timestamp: bucket.lastTimestamp,
        });
      }

      bucket = {
        open,
        high,
        low,
        close,
        volume,
        count: 1,
        lastTimestamp: timestamp,
      };
      continue;
    }

    bucket = {
      open: bucket.open,
      high: Math.max(bucket.high, high),
      low: Math.min(bucket.low, low),
      close,
      volume: bucket.volume + volume,
      count: bucket.count + 1,
      lastTimestamp: timestamp,
    };
  }

  if (bucket !== null) {
    aggregated.push({
      open: bucket.open,
      high: bucket.high,
      low: bucket.low,
      close: bucket.close,
      volume: bucket.volume,
      timestamp: bucket.lastTimestamp,
    });
  }

  return aggregated;
}

function buildTrendFactorSnapshot(params: {
  readonly candles: ReadonlyArray<CandleData>;
  readonly currentPrice: number;
  readonly strategyConfig: StrategyThresholdConfig;
}) {
  return buildTrendFactorSnapshotRaw({
    candlesByPeriod: {
      min1: params.candles,
      min5: aggregateCandles(params.candles, 5),
      min15: aggregateCandles(params.candles, 15),
    },
    currentPrice: params.currentPrice,
    strategyConfig: params.strategyConfig,
  });
}

describe('factor runtime', () => {
  it('builds a readiness-aware bullish factor snapshot', () => {
    const factorSnapshot = createBullishFactorSnapshot();

    expect(factorSnapshot.session).toBe('am');
    expect(factorSnapshot.readiness.overallReady).toBeTrue();
    expect(factorSnapshot.trendClassification).toBe('trend_up');
    expect(factorSnapshot.confirmation.longAllowed).toBeTrue();
    expect(factorSnapshot.volatilityRegime).toBe('expanding');
  });

  it('classifies ready but non-trending momentum as range instead of null', () => {
    const result = computeTrendClassification({
      momentum: {
        mom15: 1,
        mom30: -1,
        mom60: 0.2,
        zMom15: 1,
        zMom30: -1,
        zMom60: 0.5,
        sameSignCount: 1,
      },
      trendScore: 1.2,
      threshold: 0.8,
    });

    expect(result).toBe('range');
  });

  it('plans a buycall for aligned bullish factors', () => {
    const strategyConfig = createStrategyRuntimeConfig().strategyConfig;
    const factorSnapshot = createBullishFactorSnapshot();
    const decisionSnapshot = planFactorSignals({
      factorSnapshot,
      strategyConfig,
      longSymbol: 'BULL.HK',
      shortSymbol: 'BEAR.HK',
      positionCache: createPositionCacheDouble(),
    });

    expect(decisionSnapshot.actions.map((action) => action.action)).toEqual(['BUYCALL']);
    expect(createSignalFromFactorDecision(decisionSnapshot.actions[0]!).action).toBe('BUYCALL');
  });

  it('does not plan a pm buycall before pm continuation is confirmed', () => {
    const strategyConfig = createStrategyRuntimeConfig().strategyConfig;
    const baseFactorSnapshot = createBullishFactorSnapshot();
    const factorSnapshot = {
      ...baseFactorSnapshot,
      session: 'pm' as const,
      openingStructure: {
        ...baseFactorSnapshot.openingStructure,
        breakoutUp: true,
      },
      pmContinuation: {
        ...baseFactorSnapshot.pmContinuation,
        pmConfirmed: false,
      },
    };
    const decisionSnapshot = planFactorSignals({
      factorSnapshot,
      strategyConfig,
      longSymbol: 'BULL.HK',
      shortSymbol: 'BEAR.HK',
      positionCache: createPositionCacheDouble(),
    });

    expect(decisionSnapshot.actions).toHaveLength(0);
  });

  it('plans an exit when the held long symbol is no longer supported', () => {
    const strategyConfig = createStrategyRuntimeConfig().strategyConfig;
    const factorSnapshot = createBullishFactorSnapshot({
      trendClassification: 'trend_down',
      trendScore: -1.2,
      reverseTrendScore: 1.2,
      er15: 0.5,
      er30: 0.45,
      openingStructure: {
        orHigh: 101,
        orLow: 99,
        breakoutUp: false,
        breakoutDown: true,
        outsidePersistenceUp: null,
        outsidePersistenceDown: 1,
        retestHoldUp: false,
        retestHoldDown: false,
        failedBreakout: false,
      },
      confirmation: {
        longAllowed: false,
        shortAllowed: true,
        emaAlignedLong: false,
        emaAlignedShort: true,
        macdAlignedLong: false,
        macdAlignedShort: true,
        vwapAlignedLong: false,
        vwapAlignedShort: true,
      },
    });
    const decisionSnapshot = planFactorSignals({
      factorSnapshot,
      strategyConfig,
      longSymbol: 'BULL.HK',
      shortSymbol: '',
      positionCache: createPositionCacheDouble([
        createPositionDouble({
          symbol: 'BULL.HK',
          quantity: 100,
          availableQuantity: 100,
        }),
      ]),
    });

    expect(decisionSnapshot.actions.map((action) => action.action)).toEqual(['SELLCALL']);
  });

  it('uses vwapConfirmRules.slopeWindowBars when computing activeSessionVwapSlope', () => {
    const candles = createMinuteCandles({
      startHour: 13,
      startMinute: 0,
      endHour: 13,
      endMinute: 6,
      startPrice: 100,
      step: 1,
    });
    const baseStrategyConfig = createStrategyRuntimeConfig().strategyConfig;
    const singlePointSlopeConfig = {
      ...baseStrategyConfig,
      vwapConfirmRules: {
        ...baseStrategyConfig.vwapConfirmRules,
        slopeWindowBars: 1,
      },
    };
    const multiPointSlopeConfig = {
      ...baseStrategyConfig,
      vwapConfirmRules: {
        ...baseStrategyConfig.vwapConfirmRules,
        slopeWindowBars: 5,
      },
    };

    const singlePointSnapshot = buildTrendFactorSnapshot({
      candles,
      currentPrice: 106,
      strategyConfig: singlePointSlopeConfig,
    });
    const multiPointSnapshot = buildTrendFactorSnapshot({
      candles,
      currentPrice: 106,
      strategyConfig: multiPointSlopeConfig,
    });

    expect(singlePointSnapshot).not.toBeNull();
    expect(multiPointSnapshot).not.toBeNull();
    expect(singlePointSnapshot?.vwap.activeSessionVwapSlope).toBeNull();
    expect((multiPointSnapshot?.vwap.activeSessionVwapSlope ?? 0) > 0).toBeTrue();
  });

  it('uses same-day continuous trading bars across lunch for pm momentum readiness', () => {
    const candles = [
      ...createMinuteCandles({
        startHour: 9,
        startMinute: 30,
        endHour: 10,
        endMinute: 15,
        startPrice: 99,
        step: 0.01,
        dayOffset: -2,
      }),
      ...createMinuteCandles({
        startHour: 13,
        startMinute: 0,
        endHour: 13,
        endMinute: 5,
        startPrice: 99.5,
        step: 0.005,
        dayOffset: -2,
      }),
      ...createMinuteCandles({
        startHour: 9,
        startMinute: 30,
        endHour: 10,
        endMinute: 15,
        startPrice: 100,
        step: 0.015,
        dayOffset: -1,
      }),
      ...createMinuteCandles({
        startHour: 13,
        startMinute: 0,
        endHour: 13,
        endMinute: 5,
        startPrice: 100.5,
        step: 0.007,
        dayOffset: -1,
      }),
      ...createMinuteCandles({
        startHour: 9,
        startMinute: 30,
        endHour: 12,
        endMinute: 0,
        startPrice: 101,
        step: 0.08,
      }),
      ...createMinuteCandles({
        startHour: 13,
        startMinute: 0,
        endHour: 13,
        endMinute: 5,
        startPrice: 113.1,
        step: 0.05,
      }),
    ];
    const baseStrategyConfig = createStrategyRuntimeConfig().strategyConfig;
    const strategyConfig = {
      ...baseStrategyConfig,
      regimeThresholds: {
        ...baseStrategyConfig.regimeThresholds,
        atrShortPeriod: 5,
        atrLongPeriod: 10,
        rvQuantileWindowDays: 2,
        trendOnVolExpansion: 0,
        trendOffVolExpansion: -1,
        extremeVolExpansion: 999,
        trendOnVolQuantile: 0,
        trendOffVolQuantile: -1,
        extremeVolQuantile: 999,
      },
    };

    const snapshot = buildTrendFactorSnapshot({
      candles,
      currentPrice: 113.4,
      strategyConfig,
    });

    expect(snapshot).not.toBeNull();
    expect(snapshot?.session).toBe('pm');
    expect(snapshot?.momentum.mom15).not.toBeNull();
    expect(snapshot?.er15).not.toBeNull();
    expect(snapshot?.readiness.regimeReady).toBeFalse();
    expect(snapshot?.readiness.trendReady).toBeTrue();
    expect(snapshot?.readiness.confirmationReady).toBeTrue();
    expect(snapshot?.readiness.overallReady).toBeFalse();
  });

  it('derives the active trading day from the latest bar cache', () => {
    const candles = createMinuteCandles({
      startHour: 9,
      startMinute: 30,
      endHour: 10,
      endMinute: 35,
      startPrice: 100,
      step: 0.08,
    });

    const snapshot = buildTrendFactorSnapshot({
      candles,
      currentPrice: 105,
      strategyConfig: createStrategyRuntimeConfig().strategyConfig,
    });

    expect(snapshot).not.toBeNull();
    expect(snapshot?.timestamp).toBe(candles.at(-1)?.timestamp ?? null);
  });

  it('does not mark failedBreakout before any actual OR breakout happens', () => {
    const candles = createMinuteCandles({
      startHour: 9,
      startMinute: 30,
      endHour: 9,
      endMinute: 55,
      startPrice: 100,
      step: 0.001,
    });

    const snapshot = buildTrendFactorSnapshot({
      candles,
      currentPrice: Number(candles.at(-1)?.close ?? 0),
      strategyConfig: createStrategyRuntimeConfig().strategyConfig,
    });

    expect(snapshot).not.toBeNull();
    expect(snapshot?.openingStructure.breakoutUp).toBeFalse();
    expect(snapshot?.openingStructure.breakoutDown).toBeFalse();
    expect(snapshot?.openingStructure.failedBreakout).toBeFalse();
  });

  it('treats a reversal through the morning start as midday hold failure', () => {
    const candles = [
      ...createMinuteCandles({
        startHour: 9,
        startMinute: 50,
        endHour: 12,
        endMinute: 0,
        startPrice: 100,
        step: 0.04,
      }),
      ...createMinuteCandles({
        startHour: 13,
        startMinute: 0,
        endHour: 14,
        endMinute: 5,
        startPrice: 106,
        step: -0.45,
      }),
    ];
    const baseStrategyConfig = createStrategyRuntimeConfig().strategyConfig;
    const strategyConfig = {
      ...baseStrategyConfig,
      pmContinuationRules: {
        ...baseStrategyConfig.pmContinuationRules,
        amMoveZMin: 0,
        pmReExpansionTrendScoreMin: 0,
        pmReExpansionEr15Min: 0,
        pmConfirmCutoffMinutes: 13 * 60 + 15,
      },
    };

    const snapshot = buildTrendFactorSnapshot({
      candles,
      currentPrice: Number(candles.at(-1)?.close ?? 0),
      strategyConfig,
    });

    expect(snapshot).not.toBeNull();
    expect(snapshot?.momentum.mom15).not.toBeNull();
    expect((snapshot?.momentum.mom15 ?? 0) < 0).toBeTrue();
    expect(snapshot?.pmContinuation.middayHold).toBeFalse();
    expect(snapshot?.pmContinuation.pmConfirmed).toBeFalse();
  });

  it('requires pm re-expansion to stay in the same direction as the qualified am move', () => {
    const candles = [
      ...createMinuteCandles({
        startHour: 9,
        startMinute: 50,
        endHour: 12,
        endMinute: 0,
        startPrice: 100,
        step: 0.08,
      }),
      ...createMinuteCandles({
        startHour: 13,
        startMinute: 0,
        endHour: 14,
        endMinute: 5,
        startPrice: 110,
        step: -0.2,
      }),
    ];
    const baseStrategyConfig = createStrategyRuntimeConfig().strategyConfig;
    const strategyConfig = {
      ...baseStrategyConfig,
      pmContinuationRules: {
        ...baseStrategyConfig.pmContinuationRules,
        amMoveZMin: 0,
        pmReExpansionTrendScoreMin: 0,
        pmReExpansionEr15Min: 0,
        pmConfirmCutoffMinutes: 13 * 60 + 15,
      },
    };

    const snapshot = buildTrendFactorSnapshot({
      candles,
      currentPrice: Number(candles.at(-1)?.close ?? 0),
      strategyConfig,
    });

    expect(snapshot).not.toBeNull();
    expect(snapshot?.pmContinuation.amQualified).toBeTrue();
    expect(snapshot?.pmContinuation.middayHold).toBeTrue();
    expect((snapshot?.trendScore ?? 1) < 0).toBeTrue();
    expect(snapshot?.pmContinuation.pmConfirmed).toBeFalse();
  });

  it('computes activeSessionVwapSlope from the session VWAP series instead of raw closes', () => {
    const candles: CandleData[] = [
      {
        timestamp: toUtcTimestampFromHongKong({ hour: 13, minute: 0 }),
        open: 120,
        high: 120.1,
        low: 119.9,
        close: 120,
        volume: 1_000_000,
      },
      {
        timestamp: toUtcTimestampFromHongKong({ hour: 13, minute: 1 }),
        open: 119,
        high: 119.1,
        low: 118.9,
        close: 119,
        volume: 1_000_000,
      },
      {
        timestamp: toUtcTimestampFromHongKong({ hour: 13, minute: 2 }),
        open: 90,
        high: 90.1,
        low: 89.9,
        close: 90,
        volume: 1,
      },
      {
        timestamp: toUtcTimestampFromHongKong({ hour: 13, minute: 3 }),
        open: 91,
        high: 91.1,
        low: 90.9,
        close: 91,
        volume: 1,
      },
      {
        timestamp: toUtcTimestampFromHongKong({ hour: 13, minute: 4 }),
        open: 92,
        high: 92.1,
        low: 91.9,
        close: 92,
        volume: 1,
      },
      {
        timestamp: toUtcTimestampFromHongKong({ hour: 13, minute: 5 }),
        open: 93,
        high: 93.1,
        low: 92.9,
        close: 93,
        volume: 1,
      },
      {
        timestamp: toUtcTimestampFromHongKong({ hour: 13, minute: 6 }),
        open: 94,
        high: 94.1,
        low: 93.9,
        close: 94,
        volume: 1,
      },
    ];
    const baseStrategyConfig = createStrategyRuntimeConfig().strategyConfig;
    const strategyConfig = {
      ...baseStrategyConfig,
      vwapConfirmRules: {
        ...baseStrategyConfig.vwapConfirmRules,
        slopeWindowBars: 5,
      },
    };

    const snapshot = buildTrendFactorSnapshot({
      candles,
      currentPrice: 94,
      strategyConfig,
    });

    expect(snapshot).not.toBeNull();
    expect(snapshot?.vwap.activeSessionVwapSlope).not.toBeNull();
    expect((snapshot?.vwap.activeSessionVwapSlope ?? 0) < 0).toBeTrue();
  });

  it('uses configured morning and afternoon noise windows', () => {
    const amCandles = createMinuteCandles({
      startHour: 9,
      startMinute: 30,
      endHour: 9,
      endMinute: 36,
      startPrice: 100,
      step: 0.05,
    });
    const baseStrategyConfig = createStrategyRuntimeConfig().strategyConfig;
    const strategyConfig = {
      ...baseStrategyConfig,
      openingStructureRules: {
        ...baseStrategyConfig.openingStructureRules,
        morningNoiseWindowMinutes: 5,
        afternoonNoiseWindowMinutes: 5,
      },
    };

    const amSnapshot = buildTrendFactorSnapshot({
      candles: amCandles,
      currentPrice: Number(amCandles.at(-1)?.close ?? 0),
      strategyConfig,
    });
    const pmCandles = [
      ...createMinuteCandles({
        startHour: 9,
        startMinute: 30,
        endHour: 12,
        endMinute: 0,
        startPrice: 100,
        step: 0.05,
      }),
      ...createMinuteCandles({
        startHour: 13,
        startMinute: 0,
        endHour: 13,
        endMinute: 6,
        startPrice: 108,
        step: 0.05,
      }),
    ];
    const pmSnapshot = buildTrendFactorSnapshot({
      candles: pmCandles,
      currentPrice: Number(pmCandles.at(-1)?.close ?? 0),
      strategyConfig,
    });

    expect(amSnapshot).not.toBeNull();
    expect(pmSnapshot).not.toBeNull();
    expect(amSnapshot?.blockedByNoiseWindow).toBeFalse();
    expect(pmSnapshot?.blockedByNoiseWindow).toBeFalse();
  });

  it('applies pmConfirmCutoffMinutes before allowing pmConfirmed', () => {
    const candles = [
      ...createMinuteCandles({
        startHour: 9,
        startMinute: 50,
        endHour: 12,
        endMinute: 0,
        startPrice: 100,
        step: 0.08,
      }),
      ...createMinuteCandles({
        startHour: 13,
        startMinute: 0,
        endHour: 14,
        endMinute: 5,
        startPrice: 111,
        step: 0.05,
      }),
    ];
    const baseStrategyConfig = createStrategyRuntimeConfig().strategyConfig;
    const cutoffPassedConfig = {
      ...baseStrategyConfig,
      pmContinuationRules: {
        ...baseStrategyConfig.pmContinuationRules,
        pmReExpansionTrendScoreMin: 0,
        pmReExpansionEr15Min: 0,
        pmConfirmCutoffMinutes: 13 * 60 + 15,
      },
    };
    const cutoffNotReachedConfig = {
      ...baseStrategyConfig,
      pmContinuationRules: {
        ...baseStrategyConfig.pmContinuationRules,
        pmReExpansionTrendScoreMin: 0,
        pmReExpansionEr15Min: 0,
        pmConfirmCutoffMinutes: 14 * 60 + 30,
      },
    };

    const cutoffPassedSnapshot = buildTrendFactorSnapshot({
      candles,
      currentPrice: Number(candles.at(-1)?.close ?? 0),
      strategyConfig: cutoffPassedConfig,
    });
    const cutoffNotReachedSnapshot = buildTrendFactorSnapshot({
      candles,
      currentPrice: Number(candles.at(-1)?.close ?? 0),
      strategyConfig: cutoffNotReachedConfig,
    });

    expect(cutoffPassedSnapshot).not.toBeNull();
    expect(cutoffNotReachedSnapshot).not.toBeNull();
    expect(cutoffPassedSnapshot?.pmContinuation.middayHold).toBeTrue();
    expect(cutoffPassedSnapshot?.pmContinuation.pmConfirmed).toBeTrue();
    expect(cutoffNotReachedSnapshot?.pmContinuation.middayHold).toBeTrue();
    expect(cutoffNotReachedSnapshot?.pmContinuation.pmConfirmed).toBeFalse();
  });

  it('uses rvQuantileWindowDays as same-session day baseline when classifying regime', () => {
    const candles = [
      ...createMinuteCandles({
        startHour: 9,
        startMinute: 30,
        endHour: 10,
        endMinute: 15,
        startPrice: 100,
        step: 0.02,
        dayOffset: -2,
      }),
      ...createMinuteCandles({
        startHour: 9,
        startMinute: 30,
        endHour: 10,
        endMinute: 15,
        startPrice: 101,
        step: 0.18,
        dayOffset: -1,
      }),
      ...createMinuteCandles({
        startHour: 9,
        startMinute: 30,
        endHour: 10,
        endMinute: 15,
        startPrice: 102,
        step: 0.08,
      }),
    ];
    const baseStrategyConfig = createStrategyRuntimeConfig().strategyConfig;
    const regimeDrivenConfig = {
      ...baseStrategyConfig,
      regimeThresholds: {
        ...baseStrategyConfig.regimeThresholds,
        trendOnVolExpansion: 0,
        trendOffVolExpansion: -1,
        extremeVolExpansion: 99,
        trendOnVolQuantile: 0.3,
        trendOffVolQuantile: -1,
        extremeVolQuantile: 99,
      },
    };
    const oneDayWindowConfig = {
      ...regimeDrivenConfig,
      regimeThresholds: {
        ...regimeDrivenConfig.regimeThresholds,
        rvQuantileWindowDays: 1,
      },
    };
    const twoDayWindowConfig = {
      ...regimeDrivenConfig,
      regimeThresholds: {
        ...regimeDrivenConfig.regimeThresholds,
        rvQuantileWindowDays: 2,
      },
    };

    const oneDayWindowSnapshot = buildTrendFactorSnapshot({
      candles,
      currentPrice: 106,
      strategyConfig: oneDayWindowConfig,
    });
    const twoDayWindowSnapshot = buildTrendFactorSnapshot({
      candles,
      currentPrice: 106,
      strategyConfig: twoDayWindowConfig,
    });

    expect(oneDayWindowSnapshot).not.toBeNull();
    expect(twoDayWindowSnapshot).not.toBeNull();
    expect(oneDayWindowSnapshot?.volatilityRegime).toBe('normal');
    expect(twoDayWindowSnapshot?.volatilityRegime).toBe('expanding');
  });

  it('sets regime readiness to false when historical same-session baseline is unavailable', () => {
    const candles = createMinuteCandles({
      startHour: 9,
      startMinute: 30,
      endHour: 10,
      endMinute: 15,
      startPrice: 100,
      step: 0.08,
    });
    const baseStrategyConfig = createStrategyRuntimeConfig().strategyConfig;
    const strictWindowConfig = {
      ...baseStrategyConfig,
      regimeThresholds: {
        ...baseStrategyConfig.regimeThresholds,
        rvQuantileWindowDays: 20,
      },
    };

    const snapshot = buildTrendFactorSnapshot({
      candles,
      currentPrice: 106,
      strategyConfig: strictWindowConfig,
    });

    expect(snapshot).not.toBeNull();
    expect(snapshot?.readiness.regimeReady).toBeFalse();
    expect(snapshot?.readiness.overallReady).toBeFalse();
    expect(snapshot?.readiness.reasons).toContain('波动率基线未就绪');
    expect(snapshot?.volatilityRegime).toBeNull();
  });

  it('keeps regime not ready when same-session historical baseline count is below window', () => {
    const candles = [
      ...createMinuteCandles({
        startHour: 9,
        startMinute: 30,
        endHour: 10,
        endMinute: 15,
        startPrice: 100,
        step: 0.03,
        dayOffset: -1,
      }),
      ...createMinuteCandles({
        startHour: 9,
        startMinute: 30,
        endHour: 10,
        endMinute: 15,
        startPrice: 101,
        step: 0.08,
      }),
    ];
    const baseStrategyConfig = createStrategyRuntimeConfig().strategyConfig;
    const strictWindowConfig = {
      ...baseStrategyConfig,
      regimeThresholds: {
        ...baseStrategyConfig.regimeThresholds,
        rvQuantileWindowDays: 20,
      },
    };

    const snapshot = buildTrendFactorSnapshot({
      candles,
      currentPrice: 106,
      strategyConfig: strictWindowConfig,
    });

    expect(snapshot).not.toBeNull();
    expect(snapshot?.readiness.regimeReady).toBeFalse();
    expect(snapshot?.readiness.reasons).toContain('波动率基线未就绪');
    expect(snapshot?.volatilityRegime).toBeNull();
  });
});
