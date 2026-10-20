/** Daily 经济重复不证明 durable 完成：未封存重复回调、revision-only 水位与 completed boundary 回归。 */

import { expect, test } from 'bun:test';
import { orderAnalysis } from '../../../src/domain/order/orderAnalysis.js';
import { createDailyLossTracker } from '../../../src/domain/risk/dailyLossTracker.js';
import type { DailyLossAuthoritativeFactSnapshot } from '../../../src/types/risk.js';
import { toHongKongTimeIso } from '../../../src/utils/time/index.js';

const T = Date.parse('2026-10-07T02:00:00.000Z');
test('unsealed duplicate verifies durable with adjudicated snapshot; failure commits nothing; sealed revision retains the same durable obligation', () => {
  let filters = 0;
  const analysis = orderAnalysis;
  const daily = createDailyLossTracker({
    onOwnershipWarning: () => {},
    ...analysis,
    toHongKongTimeIso,
    filteringEngine: {
      applyFilteringAlgorithm: (...args) => {
        filters++;
        return analysis.filteringEngine.applyFilteringAlgorithm(...args);
      },
    },
  });
  daily.resetAll(new Date(T));
  daily.recordCumulativeExecution({
    orderId: 'buy',
    symbol: 'BULL.HK',
    side: 'BUY',
    direction: 'LONG',
    factStage: 'TERMINAL',
    executedQuantity: 100,
    executedPrice: '1',
    executedTimeMs: T - 1,
    orderUpdatedAtMs: T - 1,
  });
  const input = {
    orderId: 'sell',
    symbol: 'BULL.HK',
    side: 'SELL' as const,
    direction: 'LONG' as const,
    factStage: 'TERMINAL' as const,
    executedQuantity: 100,
    executedPrice: '0.9',
    executedTimeMs: T,
    orderUpdatedAtMs: T + 20,
  };
  expect(daily.recordCumulativeExecution(input).admission).toBe('ADMITTED');
  const before = {
    loss: daily.getLossOffset('LONG'),
    filters,
  };
  expect(before.filters).toBeGreaterThan(0);
  const fault = new Error('duplicate durable validation failed');
  expect(() =>
    daily.recordCumulativeExecution(input, () => {
      throw fault;
    }),
  ).toThrow(fault);
  expect(daily.getLossOffset('LONG')).toBe(before.loss);
  expect(filters).toBe(before.filters);
  const durable: DailyLossAuthoritativeFactSnapshot[] = [];
  const duplicate = daily.recordCumulativeExecution(
    { ...input, executedTimeMs: T - 1, orderUpdatedAtMs: T + 10 },
    (snapshot) => {
      durable.push(snapshot);
    },
  );
  expect(duplicate).toEqual({
    admission: 'DUPLICATE',
    authoritativeFactChanged: false,
    executionAdvanced: false,
  });

  expect(durable).toEqual([
    {
      factStage: 'TERMINAL',
      cumulativeQuantity: '100',
      cumulativeAmount: '90',
      lastExecutionTimeMs: T,
      orderRevisionMs: T + 20,
    },
  ]);
  daily.recordCumulativeExecution({ ...input, orderUpdatedAtMs: T + 30 });
  expect(filters).toBe(before.filters);
  const revisionSnapshots: number[] = [];
  daily.recordCumulativeExecution({ ...input, orderUpdatedAtMs: T + 30 }, (snapshot) => {
    revisionSnapshots.push(snapshot.orderRevisionMs);
  });
  expect(revisionSnapshots).toEqual([T + 30]);
  const prepared = daily.prepareProtectionBoundary({
    direction: 'LONG',
    boundaryExecutedTimeMs: T,
  });
  daily.commitProtectionBoundary(prepared);
  expect(
    daily.recordCumulativeExecution({ ...input, orderUpdatedAtMs: T + 40 }, (snapshot) => {
      revisionSnapshots.push(snapshot.orderRevisionMs);
    }).admission,
  ).toBe('ADMITTED');
  expect(revisionSnapshots).toEqual([T + 30, T + 40]);
  expect(daily.getLossOffset('LONG')).toBe('0');
});
