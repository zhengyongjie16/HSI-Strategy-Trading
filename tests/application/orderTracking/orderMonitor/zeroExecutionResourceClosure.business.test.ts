import { createDiagnosticObserverDouble } from '../../../helpers/diagnostics.js';
import { wait } from '../../../../src/infrastructure/time/index.js';
import { createLoggerDouble, createMonitorConfigDouble } from '../../../helpers/testDoubles.js';

/** 真实 trackOrder：非 FILLED 零执行只收资源，FILLED 零量在 eventFlow 原始准入拒绝。 */

import { expect, test } from 'bun:test';
import { createEventFlow } from '../../../../src/application/orderTracking/orderMonitor/eventFlow.js';
import { normalizeTerminalStateSnapshot } from '../../../../src/domain/order/orderFactMerge.js';
import type { TerminalStateSnapshot } from '../../../../src/domain/order/types.js';

import { createBrokerIngressFixture } from '../../../integration/architectureRefactoringP1Native/trade/brokerIngressFixture.js';
import { createExecutionFixture } from '../recorder/executionFixture.js';

const now = Date.parse('2026-07-14T02:00:00.000Z');
async function setup(status: 'Canceled' | 'Rejected', side: 'BUY' | 'SELL' = 'SELL', protective = true) {
  const native = await createBrokerIngressFixture({
    orderId: 'ZERO-RESOURCE',
    symbol: 'BULL.HK',
    stockName: 'HSI RC',
    remark: '',
    side,
    status,
    quantity: '100',
    executedQuantity: '0',
    submittedPrice: '1.02',
    executedPrice: '0',
    submittedAtMs: now - 60_000,
    updatedAtMs: now,
  });
  const f = createExecutionFixture({ nowMs: now, createRecorder: native.createRecorder });
  f.runtime.runtimeState = 'ACTIVE';
  f.runtime.running = true;
  const ops = native.createOperations({
    diagnostics: createDiagnosticObserverDouble(),
    logger: createLoggerDouble(),
    wait: wait,
    runtime: f.runtime,
    monitorConfig: createMonitorConfigDouble(),
    rateLimiter: f.rateLimiter,
    orderRecorder: f.recorder,
    orderHoldRegistry: f.holds,
    termination: f.termination,
    cacheManager: { clearCache: () => {}, getPendingOrders: async () => [] },
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
    isProtectiveLiquidation: protective,
  });

  if (side === 'SELL')
    f.recorder.submitSellOrder('ZERO-RESOURCE', 'BULL.HK', 'LONG', 100, [], now - 60_000);

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
    const normalized = normalizeTerminalStateSnapshot(tracked, raw);
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
    expect(f.runtime.trackedOrderLifecycles.get('ZERO-RESOURCE')?.state).toBe('CLOSED');
    expect(f.runtime.trackedOrderIdsBySymbol.get('BULL.HK')?.has('ZERO-RESOURCE') ?? false).toBe(
      false,
    );
    expect(f.runtime.closedOrderIds.has('ZERO-RESOURCE')).toBe(true);
    expect(f.holds.getHoldSymbols().has('BULL.HK')).toBe(false);
    expect(f.recorder.getPendingSellSnapshot()).toEqual([]);
    expect(f.recorder.getExecutionFact('ZERO-RESOURCE')).toBeNull();
    expect(f.episode.getInProgressEpisodes()).toEqual([]);
    expect(f.snapshot.getView().token.snapshotGeneration).toBe(generation);
    expect(f.sink.getStatus()).toEqual(initialSink);
    expect(f.events).toHaveLength(1);
    expect(f.flow.settleOrder(input).handled).toBe(false);
    expect(f.events).toHaveLength(1);
    expect(f.recorder.getExecutionFact('ZERO-RESOURCE')).toBeNull();
    expect(f.snapshot.getView().token.snapshotGeneration).toBe(generation);
  });
}

test.each(['BUY', 'SELL'] as const)('ordinary %s FILLED zero execution cannot mutate tracking or terminal confirmation', async (side) => {
  const { f, native } = await setup('Canceled', side, false);
  const flow = createEventFlow({
    diagnostics: createDiagnosticObserverDouble(),
    logger: createLoggerDouble(),
    runtime: f.runtime,
    monitorConfig: createMonitorConfigDouble(),
    now: () => new Date(now),
    orderRecorder: f.recorder,
    recordCumulativeExecution: (params) => {
      f.flow.recordCumulativeExecution(params);
    },
    prepareProtectiveTerminalExecution: f.flow.prepareProtectiveTerminalExecution,
    settleOrder: f.flow.settleOrder,
    cacheBootstrappingEvent: () => {
      throw new Error('active order cannot bootstrap');
    },
    triggerRoute: () => {
      throw new Error('invalid fact cannot wake a route');
    },
  });
  const observe = () => structuredClone({
    tracked: [...f.runtime.trackedOrders],
    lifecycles: [...f.runtime.trackedOrderLifecycles],
    indexed: [...f.runtime.trackedOrderIdsBySymbol],
    closed: [...f.runtime.closedOrderIds],
    fact: f.recorder.getExecutionFact('ZERO-RESOURCE'),
    buys: f.recorder.getBuyOrdersForSymbol('BULL.HK', true),
    sell: f.recorder.getSellRecordByOrderId('ZERO-RESOURCE'),
    holds: [...f.holds.getHoldSymbols()],
    pending: f.recorder.getPendingSellSnapshot(),
    loss: f.daily.getLossOffset('LONG'),
    episode: f.episode.getInProgressEpisodes(),
    events: f.events,
    snapshot: f.snapshot.getView().token,
    consistency: f.sink.getStatus(),
  });
  const before = observe();
  expect(before.tracked).toHaveLength(1);
  expect(before.lifecycles).toHaveLength(1);
  // 显式绕过 SDK mapper 检查共享 domain 边界；不是让不可达坏输入进入 settlement 后补救。
  expect(() => { flow.handleOrderChangedWhenActive({
    ...native.queryObservation,
    status: 'FILLED',
    executionStatus: 'FILLED',
  }); }).toThrow('FILLED 观察必须具有正累计成交数量');
  expect(observe()).toEqual(before);
  expect(native.nativeReadCounts()).toEqual({ cancel: 0, detail: 0 });
  expect(native.nativeMutations()).toEqual([]);
});
