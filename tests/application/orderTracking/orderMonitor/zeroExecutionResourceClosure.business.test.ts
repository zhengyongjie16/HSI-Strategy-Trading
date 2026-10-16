import { wait } from '../../../../src/infrastructure/time/index.js';
import { createLoggerDouble, createMonitorConfigDouble } from '../../../helpers/testDoubles.js';

/** 完整tracked生产normalize→settle：非FILLED零执行只收资源，不能借失踪tracking绕过经济提交。 */

import { expect, test } from 'bun:test';
import { normalizeTerminalStateSnapshot } from '../../../../src/domain/order/orderFactMerge.js';
import type { TerminalStateSnapshot } from '../../../../src/domain/order/types.js';

import { createBrokerIngressFixture } from '../../../integration/architectureRefactoringP1Native/trade/brokerIngressFixture.js';
import { createExecutionFixture } from '../recorder/executionFixture.js';

const now = Date.parse('2026-07-14T02:00:00.000Z');
async function setup(status: 'Canceled' | 'Rejected' | 'Filled') {
  const native = await createBrokerIngressFixture({
    orderId: 'ZERO-RESOURCE',
    tradeId: 'zero-no-execution',
    symbol: 'BULL.HK',
    stockName: 'HSI RC',
    remark: '',
    side: 'SELL',
    status,
    quantity: '100',
    executedQuantity: '0',
    submittedPrice: '1.02',
    executedPrice: '0',
    submittedAtMs: now - 60_000,
    executionTimeMs: now - 10_000,
    updatedAtMs: now,
  });
  const f = createExecutionFixture({ nowMs: now, createRecorder: native.createRecorder });
  f.runtime.runtimeState = 'ACTIVE';
  f.runtime.running = true;
  const ops = native.createOperations({
    logger: createLoggerDouble(),
    wait: wait,
    runtime: f.runtime,
    monitorConfig: createMonitorConfigDouble(),
    rateLimiter: f.rateLimiter,
    orderRecorder: f.recorder,
    orderHoldRegistry: f.holds,
    termination: f.termination,
    cacheManager: { clearCache: () => {}, getPendingOrders: async () => [] },
    getExecutionTimeEvidence: f.daily.getExecutionTimeEvidence,
    captureWorkGuard: () => {
      const captured = f.snapshot.getView().token;
      return () =>
        f.snapshot.getView().token === captured &&
        f.runtime.runtimeState !== 'STOPPED' &&
        !f.termination.isTerminated();
    },
    now: () => new Date(now),
    recordCumulativeExecution: (params) => {
      f.flow.recordCumulativeExecution(params);
    },
    triggerRoute: () => {},
  });
  ops.trackOrder({
    orderId: 'ZERO-RESOURCE',
    symbol: 'BULL.HK',
    side: native.queryObservation.executionSide,
    executionSide: native.queryObservation.executionSide,
    orderType: native.queryObservation.orderType,
    price: '1.02',
    initialSubmittedPrice: '1.02',
    quantity: 100,
    isLongSymbol: true,
    monitorSymbol: 'HSI.HK',
    isProtectiveLiquidation: true,
  });
  f.recorder.submitSellOrder('ZERO-RESOURCE', 'BULL.HK', 'LONG', 100, [], true, now - 60_000);

  return { f, native };
}

for (const [status, reason] of [
  ['Canceled', 'CANCELED'],
  ['Rejected', 'REJECTED'],
] as const) {
  test(`${reason} full tracked zero execution with no revision closes all resources once without finance`, async () => {
    const { f, native } = await setup(status);
    const tracked = f.runtime.trackedOrders.get('ZERO-RESOURCE');
    if (tracked === undefined)
      throw new Error('full production tracking must exist before normalization');

    expect(tracked).toMatchObject({
      symbol: 'BULL.HK',
      monitorSymbol: 'HSI.HK',
      executionSide: 'SELL',
      submittedQuantity: 100,
      isProtectiveLiquidation: true,
    });
    expect(f.holds.getHoldSymbols().has('BULL.HK')).toBe(true);
    expect(f.recorder.getPendingSellSnapshot()).toHaveLength(1);
    const generation = f.snapshot.getView().token.snapshotGeneration;
    const initialSink = f.sink.getStatus();
    const raw: TerminalStateSnapshot = {
      executionStatus: native.queryObservation.executionStatus,
      kind: 'TERMINAL',
      closedReason: reason,
      status: native.queryObservation.status,
      submittedQuantity: 100,
      executedQuantity: 0,
      executedAmount: '0',
      executedPrice: null,
      executionTimeMs: null,
      orderUpdatedAtMs: null,
    };
    const normalized = normalizeTerminalStateSnapshot(tracked, raw, true);
    expect(normalized).toMatchObject({
      executedQuantity: 0,
      executedAmount: '0',
      executedTimeMs: null,
      orderUpdatedAtMs: null,
    });
    const input = {
      ...normalized,
      orderId: 'ZERO-RESOURCE',
      source: 'STATE_CHECK' as const,
      executedQuantity: 0,
      closedReason: reason,
    };
    expect(f.flow.settleOrder(input).handled).toBe(true);
    expect(f.runtime.trackedOrders.has('ZERO-RESOURCE')).toBe(false);
    expect(f.runtime.trackedOrderLifecycles.get('ZERO-RESOURCE')).toBe('CLOSED');
    expect(f.runtime.trackedOrderIdsBySymbol.get('BULL.HK')?.has('ZERO-RESOURCE') ?? false).toBe(
      false,
    );
    expect(f.runtime.closedOrderIds.has('ZERO-RESOURCE')).toBe(true);
    expect(f.holds.getHoldSymbols().has('BULL.HK')).toBe(false);
    expect(f.recorder.getPendingSellSnapshot()).toEqual([]);
    expect(f.recorder.getExecutionFact('ZERO-RESOURCE')).toBeNull();
    expect(f.daily.getExecutionTimeEvidence()).toEqual([]);
    expect(f.episode.getInProgressEpisodes()).toEqual([]);
    expect(f.snapshot.getView().token.snapshotGeneration).toBe(generation);
    expect(f.sink.getStatus()).toEqual(initialSink);
    expect(f.events).toHaveLength(1);
    expect(f.flow.settleOrder(input).handled).toBe(false);
    expect(f.events).toHaveLength(1);
    expect(f.recorder.getExecutionFact('ZERO-RESOURCE')).toBeNull();
    expect(f.daily.getExecutionTimeEvidence()).toEqual([]);
    expect(f.snapshot.getView().token.snapshotGeneration).toBe(generation);
  });
}

test('FILLED zero execution cannot borrow the non-FILLED resource-only close', async () => {
  const { f, native } = await setup('Filled');
  const tracked = f.runtime.trackedOrders.get('ZERO-RESOURCE');
  if (tracked === undefined) throw new Error('FILLED negative case requires full tracking');

  const before = { ...tracked };
  const generation = f.snapshot.getView().token.snapshotGeneration;
  const result = f.flow.settleOrder({
    orderId: 'ZERO-RESOURCE',
    closedReason: 'FILLED',
    source: 'STATE_CHECK',
    executedQuantity: 0,
    executedAmount: '0',
    executedPrice: null,
    executedTimeMs: null,
    orderUpdatedAtMs: null,
  });
  expect(result.handled).toBe(false);
  expect(f.runtime.trackedOrders.get('ZERO-RESOURCE')).toEqual(before);
  expect(f.holds.getHoldSymbols().has('BULL.HK')).toBe(true);
  expect(f.recorder.getPendingSellSnapshot()).toHaveLength(1);
  expect(f.events).toEqual([]);
  expect(f.recorder.getExecutionFact('ZERO-RESOURCE')).toBeNull();
  expect(f.daily.getExecutionTimeEvidence()).toEqual([]);
  expect(f.snapshot.getView().token.snapshotGeneration).toBe(generation);
  const missingT: TerminalStateSnapshot = {
    executionStatus: native.queryObservation.executionStatus,
    kind: 'TERMINAL',
    closedReason: 'FILLED',
    status: native.queryObservation.status,
    submittedQuantity: 100,
    executedQuantity: 100,
    executedAmount: '103',
    executedPrice: '1.03',
    executionTimeMs: null,
    orderUpdatedAtMs: now,
  };
  expect(() => normalizeTerminalStateSnapshot(tracked, missingT, true)).toThrow(
    '正累计成交缺少有效金额、成交价格、真实执行时间或 broker revision',
  );
  expect(f.runtime.trackedOrders.get('ZERO-RESOURCE')).toEqual(before);
  expect(f.recorder.getPendingSellSnapshot()).toHaveLength(1);
  expect(f.events).toEqual([]);
});
