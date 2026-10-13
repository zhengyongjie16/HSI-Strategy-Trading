/**
 * 浮亏状态与精确阈值测试。
 * 验证 prepare 无副作用、publish 同步提交以及日内亏损偏移采用原精确成本口径。
 */
import { describe, expect, it } from 'bun:test';
import { createUnrealizedLossChecker } from '../../../src/domain/risk/unrealizedLossChecker.js';
import {
  createDailyLossTrackerDouble,
  createOrderRecorderDouble,
} from '../../helpers/testDoubles.js';

describe('unrealizedLossChecker business boundaries', () => {
  it('does not change the published basis while preparing a replacement, and preserves exact threshold equality', () => {
    const checker = createUnrealizedLossChecker({
      maxUnrealizedLossPerSymbol: '10',
      onMissingData: () => {},
    });
    checker.publish({ symbol: 'BULL.HK', data: { r1: '100', n1: 1 } });
    expect(checker.check('BULL.HK', '90', true)).toEqual({ shouldLiquidate: false });
    expect(checker.check('BULL.HK', '89.999999999999999999', true)).toMatchObject({
      shouldLiquidate: true,
      quantity: 1,
    });
    const replacement = checker.prepare(
      createOrderRecorderDouble({ getCostBasis: () => ({ costAmount: '0.1', quantity: 3 }) }),
      'BULL.HK',
      true,
      '-0.2',
    );
    expect(replacement).toEqual({ symbol: 'BULL.HK', data: { r1: '0.3', n1: 3 } });
    expect(Object.isFrozen(replacement)).toBeTrue();
    expect(Object.isFrozen(replacement.data)).toBeTrue();
    expect(checker.getUnrealizedLossData('BULL.HK')).toEqual({ r1: '100', n1: 1 });
    checker.publish(replacement);
    expect(checker.getUnrealizedLossData('BULL.HK')).toEqual({ r1: '0.3', n1: 3 });
  });

  it('fails fast before publishing invalid candidate cost or quantity, and keeps the old basis', () => {
    const checker = createUnrealizedLossChecker({
      maxUnrealizedLossPerSymbol: '10',
      onMissingData: () => {},
    });
    checker.publish({ symbol: 'BULL.HK', data: { r1: '100', n1: 1 } });
    expect(() => checker.prepare(createOrderRecorderDouble(), 'BULL.HK', true, '0.1')).toThrow(
      TypeError,
    );

    expect(() =>
      checker.prepare(
        createOrderRecorderDouble({ getCostBasis: () => ({ costAmount: '100', quantity: 1.5 }) }),
        'BULL.HK',
        true,
        '0',
      ),
    ).toThrow(RangeError);

    expect(() => {
      checker.publish({ symbol: 'BULL.HK', data: { r1: 'NaN', n1: 1 } });
    }).toThrow(TypeError);

    expect(() => {
      checker.publish({ symbol: 'BULL.HK', data: { r1: '-1', n1: 1 } });
    }).toThrow(TypeError);
    expect(checker.getUnrealizedLossData('BULL.HK')).toEqual({ r1: '100', n1: 1 });
  });

  it('observes only missing data and clears one direction without erasing the other symbol', () => {
    const warnings: string[] = [];
    const checker = createUnrealizedLossChecker({
      maxUnrealizedLossPerSymbol: '10',
      onMissingData: (symbol) => {
        warnings.push(symbol);
      },
    });
    checker.publish({ symbol: 'BULL.HK', data: { r1: '10', n1: 0 } });
    checker.publish({ symbol: 'BEAR.HK', data: { r1: '100', n1: 1 } });
    expect(checker.check('BULL.HK', '1', true)).toEqual({ shouldLiquidate: false });
    checker.clearUnrealizedLossData('BULL.HK');
    expect(checker.check('BULL.HK', '1', true)).toEqual({ shouldLiquidate: false });
    expect(warnings).toEqual(['BULL.HK']);
    expect(checker.getUnrealizedLossData('BEAR.HK')).toEqual({ r1: '100', n1: 1 });
    checker.clearUnrealizedLossData();
    expect(checker.getUnrealizedLossData('BEAR.HK')).toBeUndefined();
  });

  it('rethrows internal errors during unrealized loss preparation', () => {
    const checker = createUnrealizedLossChecker({
      onMissingData: () => {},
      maxUnrealizedLossPerSymbol: '1000',
    });
    const internalError = new Error('order recorder broken');
    const orderRecorder = createOrderRecorderDouble({
      getCostBasis: () => {
        throw internalError;
      },
    });

    expect(() => checker.prepare(orderRecorder, 'BULL.HK', true, '0')).toThrow(internalError);
  });

  it('prepares exact R1/N1 without publishing and applies the daily loss offset synchronously', () => {
    const checker = createUnrealizedLossChecker({
      onMissingData: () => {},
      maxUnrealizedLossPerSymbol: '499',
    });
    const orderRecorder = createOrderRecorderDouble({
      getCostBasis: () => ({ costAmount: '1000', quantity: 90 }),
    });

    const dailyLossTracker = createDailyLossTrackerDouble();
    const now = new Date('2026-02-16T02:00:00.000Z');
    const dailyPrepared = dailyLossTracker.prepareRecalculationFromAllOrders(
      [],
      { monitorSymbol: 'HSI.HK', orderOwnershipMapping: ['HSI'] },
      now,
      undefined,
      new Set(['BULL.HK']),
    );
    expect(dailyPrepared.isCurrent()).toBeTrue();
    expect(dailyLossTracker.getLossOffset('LONG')).toBe('0');
    dailyLossTracker.publishRecalculation(dailyPrepared);
    expect(dailyPrepared.isCurrent()).toBeFalse();
    expect(
      dailyLossTracker.recordCumulativeExecution({
        factStage: 'TERMINAL',
        direction: 'LONG',
        symbol: 'BULL.HK',
        side: 'BUY',
        executedPrice: '10',
        executedQuantity: 100,
        executedTimeMs: now.getTime() - 2,
        orderUpdatedAtMs: now.getTime() - 2,
        orderId: 'DAILY-LOSS-BUY',
      }).admission,
    ).toBe('ADMITTED');

    expect(
      dailyLossTracker.recordCumulativeExecution({
        factStage: 'TERMINAL',
        direction: 'LONG',
        symbol: 'BULL.HK',
        side: 'SELL',
        executedPrice: '8',
        executedQuantity: 100,
        executedTimeMs: now.getTime() - 1,
        orderUpdatedAtMs: now.getTime() - 1,
        orderId: 'DAILY-LOSS-SELL',
      }).admission,
    ).toBe('ADMITTED');
    expect(dailyLossTracker.getLossOffset('LONG')).toBe('-200');
    const prepared = checker.prepare(
      orderRecorder,
      'BULL.HK',
      true,
      dailyLossTracker.getLossOffset('LONG'),
    );
    expect(checker.getUnrealizedLossData('BULL.HK')).toBeUndefined();
    expect(prepared).toEqual({ symbol: 'BULL.HK', data: { r1: '1200', n1: 90 } });
    checker.publish(prepared);
    const result = checker.check('BULL.HK', '7', true);
    expect(checker.getUnrealizedLossData('BULL.HK')).toEqual({ r1: '1200', n1: 90 });
    expect(result).toMatchObject({ shouldLiquidate: true, quantity: 90 });
  });

  it('keeps the buy gate open when unrealized-loss cache is missing or the threshold is disabled', () => {
    const cacheMissingChecker = createUnrealizedLossChecker({
      onMissingData: () => {},
      maxUnrealizedLossPerSymbol: '100',
    });
    expect(cacheMissingChecker.check('BULL.HK', '1', true)).toEqual({ shouldLiquidate: false });
    const disabledChecker = createUnrealizedLossChecker({
      onMissingData: () => {},
      maxUnrealizedLossPerSymbol: '0',
    });
    disabledChecker.publish(
      disabledChecker.prepare(
        createOrderRecorderDouble({ getCostBasis: () => ({ costAmount: '1000', quantity: 100 }) }),
        'BULL.HK',
        true,
        '0',
      ),
    );
    expect(disabledChecker.check('BULL.HK', '1', true)).toEqual({ shouldLiquidate: false });
  });
});
