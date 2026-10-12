/** P1 真实执行时间边界：同量高 revision 不越过 completed boundary，不落 durable/修改 baseline。 */
import { expect, test } from 'bun:test';
import { createDailyLossTracker } from '../../../src/domain/risk/dailyLossTracker.js';
import { createDailyLossOrderAnalysisDeps } from '../../../src/core/orderRecorder/index.js';
import { toHongKongTimeIso } from '../../../src/utils/time/index.js';

const now = new Date('2026-10-07T02:00:00Z');
const t = now.getTime();
function tracker() {
  const owner = createDailyLossTracker({
    onOwnershipWarning: () => {},
    ...createDailyLossOrderAnalysisDeps(),
    toHongKongTimeIso,
  });
  owner.resetAll(now);
  return owner;
}

test('boundary or earlier true T with higher revision is a no-op including durable observer and baseline', () => {
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
    admission: 'SUPPRESSED',
    authoritativeFactChanged: false,
    executionAdvanced: false,
  });
  expect(durableCalls).toBe(0);
  expect(owner.getLossOffset('LONG')).toBe('0');
  expect(owner.getExecutionTimeEvidence()[0]).toMatchObject({
    lastExecutionTimeMs: t,
    orderRevisionMs: t,
    cumulativeAmount: '123.45678901234567890123456789',
  });
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
  expect(owner.getExecutionTimeEvidence()).toEqual([]);
  expect(owner.getLossOffset('LONG')).toBe('0');
});
