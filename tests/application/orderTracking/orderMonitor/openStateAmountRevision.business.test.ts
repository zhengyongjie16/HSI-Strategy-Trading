import { createDiagnosticObserverDouble } from '../../../helpers/diagnostics.js';
import { wait } from '../../../../src/infrastructure/time/index.js';
import { createLoggerDouble, createMonitorConfigDouble } from '../../../helpers/testDoubles.js';

/** OPEN state-check 金额修订：同 O/Daily/H/S 自然结算登记，原 durable/partial-count oracle 不变。 */

import { describe, expect, it } from 'bun:test';
import { createEventFlow } from '../../../../src/application/orderTracking/orderMonitor/eventFlow.js';
import type { ProtectiveLiquidationExecutionProgressInput } from '../../../../src/types/risk.js';

import { createBrokerIngressFixture } from '../../../integration/architectureRefactoringP1Native/trade/brokerIngressFixture.js';
import { createExecutionFixture } from '../recorder/executionFixture.js';

describe('orderMonitor OPEN state-check amount revision', () => {
  it('routes a higher-revision equal-quantity correction through DailyLoss without re-marking partial fill', async () => {
    const firstRevisionMs = Date.parse('2026-07-11T02:00:00.000Z');
    const secondRevisionMs = firstRevisionMs + 1000;
    const persisted: ProtectiveLiquidationExecutionProgressInput[] = [];
    const partialFills: number[] = [];
    const routeWakeups: string[] = [];
    const f = createExecutionFixture({
      nowMs: firstRevisionMs - 60_000,
      persistProgress: (progress) => {
        persisted.push(progress);
      },
    });
    f.runtime.runtimeState = 'ACTIVE';
    f.runtime.running = true;
    const orderId = 'OPEN-STATE-AMOUNT-REVISION';
    f.recorder.submitSellOrder(orderId, 'BULL.HK', 'LONG', 100, [], firstRevisionMs - 10);
    const recorder = {
      ...f.recorder,
      markSellPartialFilled: (id: string, quantity: number) => {
        partialFills.push(quantity);
        return f.recorder.markSellPartialFilled(id, quantity);
      },
    };
    const frame = {
      orderId,
      symbol: 'BULL.HK',
      stockName: 'HSI RC',
      remark: '',
      side: 'SELL' as const,
      status: 'PartialFilled' as const,
      orderType: 'ELO' as const,
      quantity: '100',
      executedQuantity: '40',
      submittedPrice: '9',
      executedPrice: '9',
      submittedAtMs: firstRevisionMs - 10,
      executionTimeMs: firstRevisionMs,
      updatedAtMs: firstRevisionMs,
    };
    const native = await createBrokerIngressFixture(frame);
    native.setCancelFailure(new Error('openapi error: code=601011: order cannot be cancelled'));
    native.setOrderDetailReplies([
      { ...frame, executedPrice: '9.4', updatedAtMs: secondRevisionMs },
    ]);

    const now = () => new Date(secondRevisionMs);
    const workGuard = () => {
      const captured = f.snapshot.getView().token.dayEpoch;
      return () =>
        captured === f.snapshot.getView().token.dayEpoch &&
        !f.termination.isTerminated() &&
        f.runtime.runtimeState !== 'STOPPED';
    };
    const orderOps = native.createOperations({
      diagnostics: createDiagnosticObserverDouble(),
      logger: createLoggerDouble(),
      wait: wait,
      captureWorkGuard: workGuard,
      runtime: f.runtime,
      monitorConfig: createMonitorConfigDouble(),
      rateLimiter: f.rateLimiter,
      cacheManager: {
        clearCache: () => {},
        getPendingOrders: async () => {
          throw new Error('OPEN correction cannot issue pending snapshot IO');
        },
      },
      orderHoldRegistry: f.holds,
      orderRecorder: recorder,
      recordCumulativeExecution: (params) => {
        f.flow.recordCumulativeExecution(params);
      },
      triggerRoute: (symbol, reason) => {
        routeWakeups.push(`${symbol}:${reason}`);
      },
      termination: f.termination,
      now,
    });
    orderOps.trackOrder({
      orderId,
      symbol: 'BULL.HK',
      side: native.queryObservation.executionSide,
      executionSide: 'SELL',
      price: '9',
      initialSubmittedPrice: '9',
      quantity: 100,
      initialStatus: native.queryObservation.status,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: true,
      orderType: native.queryObservation.orderType,
    });
    const eventFlow = createEventFlow({
      diagnostics: createDiagnosticObserverDouble(),
      logger: createLoggerDouble(),
      monitorConfig: createMonitorConfigDouble({
        monitorSymbol: 'HSI.HK',
        orderOwnershipMapping: ['HSI'],
      }),
      runtime: f.runtime,
      orderRecorder: recorder,
      recordCumulativeExecution: (params) => {
        f.flow.recordCumulativeExecution(params);
      },
      prepareProtectiveTerminalExecution: f.flow.prepareProtectiveTerminalExecution,
      settleOrder: f.flow.settleOrder,
      cacheBootstrappingEvent: () => {
        throw new Error('active event must not cache bootstrapping event');
      },
      triggerRoute: (symbol, reason) => {
        routeWakeups.push(`${symbol}:${reason}`);
      },
      now,
    });
    const first = native.queryObservation;
    eventFlow.handleOrderChangedWhenActive(first);
    await orderOps.cancelOrder(orderId, { kind: 'ORDER_FACT' });
    expect(
      persisted.map((progress) => ({
        factStage: progress.factStage,
        cumulativeQuantity: progress.cumulativeQuantity,
        cumulativeAmount: progress.cumulativeAmount,
        lastExecutionTimeMs: progress.lastExecutionTimeMs,
        orderRevisionMs: progress.orderRevisionMs,
      })),
    ).toEqual([
      {
        factStage: 'OPEN',
        cumulativeQuantity: '40',
        cumulativeAmount: '360',
        lastExecutionTimeMs: firstRevisionMs,
        orderRevisionMs: firstRevisionMs,
      },
      {
        factStage: 'OPEN',
        cumulativeQuantity: '40',
        cumulativeAmount: '376',
        lastExecutionTimeMs: firstRevisionMs,
        orderRevisionMs: secondRevisionMs,
      },
    ]);
    expect(partialFills).toEqual([40]);
    expect(routeWakeups).toEqual(['BULL.HK:TRACKED', 'BULL.HK:ORDER_EVENT']);
    expect(f.sink.getStatus()).toEqual({ started: false, currentVersion: 0, staleVersion: 2 });
    expect(f.snapshot.getView().token.snapshotGeneration).toBe(2);
    expect(f.recorder.getExecutionFact(orderId)).toMatchObject({
      cumulativeQuantity: 40,
      cumulativeAmount: '376',
      executionTimeMs: firstRevisionMs,
      updatedAtMs: secondRevisionMs,
      phase: 'OPEN',
    });

    expect(f.recorder.getPendingSellSnapshot()).toMatchObject([
      { orderId, filledQuantity: 40, status: 'partial' },
    ]);
    expect(f.io.calls).toEqual([]);
  });
});
