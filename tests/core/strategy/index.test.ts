/**
 * createTrendContinuationStrategy 业务测试
 *
 * 功能：
 * - 验证 factor snapshot 驱动的开平仓输出
 */
import { describe, expect, it } from 'bun:test';

import { createTrendContinuationStrategy } from '../../../src/core/strategy/index.js';
import { createStrategyRuntimeConfig } from '../../../mock/factories/configFactory.js';
import type { FactorSnapshot } from '../../../src/types/factor.js';
import {
  createFactorSnapshotDouble,
  createOrderRecorderDouble,
} from '../../helpers/testDoubles.js';

const TEST_TIMESTAMP_MS = Date.UTC(2026, 2, 29, 2, 15, 0);

function createFactorSnapshot(overrides: Partial<FactorSnapshot> = {}): FactorSnapshot {
  return createFactorSnapshotDouble({
    ...overrides,
  });
}

describe('createTrendContinuationStrategy', () => {
  it('emits buy signals for aligned bullish factors', () => {
    const strategy = createTrendContinuationStrategy(createStrategyRuntimeConfig().strategyConfig);
    const result = strategy.generateSignals(
      createFactorSnapshot(),
      'BULL.HK',
      'BEAR.HK',
      createOrderRecorderDouble(),
    );

    expect(result.map((signal) => signal.action)).toEqual(['BUYCALL']);
    expect(result[0]?.reason ?? '').toContain('trend');
  });

  it('emits exit signals when the held long symbol is no longer supported', () => {
    const strategy = createTrendContinuationStrategy(createStrategyRuntimeConfig().strategyConfig);
    const result = strategy.generateSignals(
      createFactorSnapshot({
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
      }),
      'BULL.HK',
      '',
      createOrderRecorderDouble({
        getBuyOrdersForSymbol: (symbol, isLongSymbol) =>
          isLongSymbol && symbol === 'BULL.HK'
            ? [
                {
                  orderId: 'BUY-1',
                  symbol: 'BULL.HK',
                  executedPrice: 100,
                  executedQuantity: 100,
                  executedTime: TEST_TIMESTAMP_MS,
                  submittedAt: undefined,
                  updatedAt: undefined,
                },
              ]
            : [],
      }),
    );

    expect(result.map((signal) => signal.action)).toEqual(['SELLCALL']);
  });

  it('does not emit strategic exits when factor readiness is not ready', () => {
    const strategy = createTrendContinuationStrategy(createStrategyRuntimeConfig().strategyConfig);
    const result = strategy.generateSignals(
      createFactorSnapshot({
        readiness: {
          regimeReady: false,
          trendReady: false,
          structureReady: false,
          confirmationReady: false,
          overallReady: false,
          reasons: ['波动率基线未就绪'],
        },
        volatilityRegime: null,
        trendClassification: null,
        trendScore: null,
        reverseTrendScore: null,
        er15: null,
        er30: null,
        momentum: {
          mom15: null,
          mom30: null,
          mom60: null,
          zMom15: null,
          zMom30: null,
          zMom60: null,
          sameSignCount: 0,
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
          breakoutUp: false,
          breakoutDown: false,
          outsidePersistenceUp: null,
          outsidePersistenceDown: null,
          retestHoldUp: false,
          retestHoldDown: false,
          failedBreakout: false,
        },
        pmContinuation: {
          amQualified: false,
          middayHold: false,
          pmConfirmed: false,
        },
        confirmation: {
          longAllowed: false,
          shortAllowed: false,
          emaAlignedLong: false,
          emaAlignedShort: false,
          macdAlignedLong: false,
          macdAlignedShort: false,
          vwapAlignedLong: false,
          vwapAlignedShort: false,
        },
        blockedByNoiseWindow: false,
      }),
      'BULL.HK',
      '',
      createOrderRecorderDouble({
        getBuyOrdersForSymbol: (symbol, isLongSymbol) =>
          isLongSymbol && symbol === 'BULL.HK'
            ? [
                {
                  orderId: 'BUY-1',
                  symbol: 'BULL.HK',
                  executedPrice: 100,
                  executedQuantity: 100,
                  executedTime: TEST_TIMESTAMP_MS,
                  submittedAt: undefined,
                  updatedAt: undefined,
                },
              ]
            : [],
      }),
    );

    expect(result).toHaveLength(0);
  });

  it('returns no signals for a neutral snapshot', () => {
    const strategy = createTrendContinuationStrategy(createStrategyRuntimeConfig().strategyConfig);
    const result = strategy.generateSignals(
      createFactorSnapshot({
        trendClassification: 'range',
        trendScore: 0,
        volatilityRegime: 'normal',
      }),
      'BULL.HK',
      'BEAR.HK',
      createOrderRecorderDouble(),
    );

    expect(result).toHaveLength(0);
  });

  it('rejects long entry when structure confirmation is missing on the live path', () => {
    const strategy = createTrendContinuationStrategy(createStrategyRuntimeConfig().strategyConfig);
    const result = strategy.generateSignals(
      createFactorSnapshot({
        volatilityRegime: 'normal',
        trendClassification: 'trend_up',
        trendScore: 1.2,
        reverseTrendScore: -1.2,
        er15: 0.6,
        er30: 0.6,
        openingStructure: {
          orHigh: 101,
          orLow: 99,
          breakoutUp: false,
          breakoutDown: false,
          outsidePersistenceUp: 0,
          outsidePersistenceDown: 0,
          retestHoldUp: false,
          retestHoldDown: false,
          failedBreakout: false,
        },
        pmContinuation: {
          amQualified: false,
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
      }),
      'BULL.HK',
      'BEAR.HK',
      createOrderRecorderDouble(),
    );

    expect(result).toHaveLength(0);
  });
});
