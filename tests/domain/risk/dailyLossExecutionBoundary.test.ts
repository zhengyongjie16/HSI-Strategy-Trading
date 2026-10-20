/** P1 执行时间边界只封存经济投影；同量高 revision 仍写前持久化并保留权威事实。 */

import { expect, test } from 'bun:test';
import { orderAnalysis } from '../../../src/domain/order/orderAnalysis.js';
import { createDailyLossTracker } from '../../../src/domain/risk/dailyLossTracker.js';
import { toHongKongTimeIso } from '../../../src/utils/time/index.js';

const now = new Date('2026-10-07T02:00:00Z');
const t = now.getTime();
function tracker() {
  const owner = createDailyLossTracker({
    onOwnershipWarning: () => {},
    ...orderAnalysis,
    toHongKongTimeIso,
  });
  owner.resetAll(now);
  return owner;
}

test('boundary or earlier true T admits higher revision through durable without rewriting the frozen projection', () => {
  const owner = tracker();
  const input = {
    orderId: 'buy',
    symbol: 'A.HK',
    direction: 'LONG' as const,
    side: 'BUY' as const,
    factStage: 'TERMINAL' as const,
    executedPrice: '1.2345678901234567890123456789',
    executedQuantity: 100,
    executedTimeMs: t,
    orderUpdatedAtMs: t,
  };
  expect(owner.recordCumulativeExecution(input).authoritativeFactChanged).toBe(true);
  const prepared = owner.prepareProtectionBoundary({
    direction: 'LONG',
    boundaryExecutedTimeMs: t,
  });
  owner.commitProtectionBoundary(prepared);
  let durableCalls = 0;
  const result = owner.recordCumulativeExecution(
    { ...input, executedPrice: '2.2345678901234567890123456789', orderUpdatedAtMs: t + 30000 },
    () => {
      durableCalls++;
    },
  );
  expect(result).toEqual({
    admission: 'ADMITTED',
    authoritativeFactChanged: true,
    executionAdvanced: false,
  });
  expect(durableCalls).toBe(1);
  expect(owner.getLossOffset('LONG')).toBe('0');
});

test('progress persistence failure leaves authoritative fact and financial state uncommitted', () => {
  const owner = tracker();
  const fault = new Error('durable failure');
  expect(() =>
    owner.recordCumulativeExecution(
      {
        orderId: 'buy',
        symbol: 'A.HK',
        direction: 'LONG',
        side: 'BUY',
        factStage: 'TERMINAL',
        executedPrice: '1',
        executedQuantity: 100,
        executedTimeMs: t,
        orderUpdatedAtMs: t,
      },
      () => {
        throw fault;
      },
    ),
  ).toThrow(fault);
  expect(owner.getLossOffset('LONG')).toBe('0');
});

test('same cumulative quantity after the Hong Kong day cut does not create a new in-day fill', () => {
  const owner = tracker();
  const input = {
    orderId: 'cross-day-sell',
    symbol: 'A.HK',
    direction: 'LONG' as const,
    side: 'SELL' as const,
    factStage: 'TERMINAL' as const,
    executedPrice: '0.9',
    executedQuantity: 100,
    executedTimeMs: t,
    orderUpdatedAtMs: t + 10,
  };
  expect(owner.recordCumulativeExecution(input).executionAdvanced).toBe(true);
  expect(owner.getLossOffset('LONG')).toBe('0');

  const nextDay = new Date('2026-10-08T02:00:00.000Z');
  owner.resetAll(nextDay);
  const replay = owner.recordCumulativeExecution({
    ...input,
    executedTimeMs: t,
    orderUpdatedAtMs: nextDay.getTime(),
  });
  expect(replay).toEqual({
    admission: 'SUPPRESSED',
    authoritativeFactChanged: false,
    executionAdvanced: false,
  });
  expect(owner.getLossOffset('LONG')).toBe('0');
});
