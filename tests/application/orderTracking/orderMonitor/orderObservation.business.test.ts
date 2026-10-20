/**
 * 订单观测真实时序验证。
 * 使用真实 SDK mapper / cancel adapter 与现有 tracking、event、settlement owner，
 * 覆盖首次 ACK 配对、先确认后结算、重复终态、诊断失败及恢复重试。
 */
import { describe, expect, it } from 'bun:test';
import { createEventFlow } from '../../../../src/application/orderTracking/orderMonitor/eventFlow.js';
import { createRecoveryFlow } from '../../../../src/application/orderTracking/orderMonitor/recoveryFlow.js';
import { createSettlementFlow } from '../../../../src/application/orderTracking/orderMonitor/settlementFlow.js';
import { DIAGNOSTIC_OPERATIONS } from '../../../../src/constants/diagnostics.js';
import type { DiagnosticFields, DiagnosticObserver } from '../../../../src/types/diagnostics.js';
import { createTradingConfig } from '../../../../mock/factories/configFactory.js';
import {
  createLoggerDouble,
  createMonitorConfigDouble,
  createRateLimiterDouble,
  createSymbolRegistryDouble,
} from '../../../helpers/testDoubles.js';
import { createBrokerIngressFixture } from '../../../integration/architectureRefactoringP1Native/trade/brokerIngressFixture.js';
import { createExecutionFixture } from '../recorder/executionFixture.js';

/** 使用实际 broker 终态生产者，broker revision 与本地观测时钟故意分离。 */
async function createHarness(side: 'BUY' | 'SELL' = 'SELL') {
  const native = await createBrokerIngressFixture({
    orderId: 'OBSERVED-ORDER',
    symbol: 'BULL.HK',
    stockName: 'HSI RC',
    remark: '',
    side,
    status: 'Canceled',
    quantity: '100',
    executedQuantity: '0',
    submittedPrice: '1',
    executedPrice: '0',
    submittedAtMs: 1,
    updatedAtMs: 50_000,
  });
  native.setCancelBeforeReply(async () => {});
  const economic = createExecutionFixture({ nowMs: 10_000 });
  const { runtime } = economic;
  runtime.runtimeState = 'ACTIVE';
  runtime.running = true;
  let nowMs = 10_000;
  const now = () => new Date(nowMs);
  const records: Array<{ readonly operation: string; readonly fields: DiagnosticFields }> = [];
  let diagnosticThrows = false;
  const diagnostics: DiagnosticObserver = {
    record: (operation, fields) => {
      records.push({ operation, fields });
      if (diagnosticThrows) throw new Error('diagnostic failure must stay passive');
    },
  };
  const flow = createSettlementFlow({
    runtime,
    diagnostics,
    now,
    orderHoldRegistry: economic.holds,
    orderRecorder: economic.recorder,
    dailyLossTracker: economic.daily,
    protectiveLiquidationEpisodeTracker: economic.episode,
    persistProtectiveLiquidationExecutionProgress: () => {
      throw new Error('zero execution must not persist execution progress');
    },
    postTradeConsistencyRuntime: economic.sink,
    emitOrderStateChanged: () => {},
  });
  const orderOps = native.createOperations({
    diagnostics,
    now,
    runtime,
    wait: async () => {},
    logger: createLoggerDouble(),
    captureWorkGuard: () => () => true,
    termination: economic.termination,
    monitorConfig: createMonitorConfigDouble(),
    rateLimiter: createRateLimiterDouble(),
    cacheManager: { clearCache: () => {}, getPendingOrders: async () => [] },
    orderHoldRegistry: economic.holds,
    orderRecorder: economic.recorder,
    recordCumulativeExecution: (params) => {
      flow.recordCumulativeExecution(params);
    },
    triggerRoute: () => {},
  });
  orderOps.trackOrder({
    orderId: native.queryObservation.orderId,
    symbol: 'BULL.HK',
    side,
    executionSide: side,
    initialExecutionPhase: 'OPEN',
    initialStatus: 'WORKING',
    price: '1',
    initialSubmittedPrice: '1',
    quantity: 100,
    submittedAtMs: 1,
    isLongSymbol: true,
    monitorSymbol: 'HSI.HK',
    isProtectiveLiquidation: false,
    orderType: 'LO',
  });
  const eventFlow = createEventFlow({
    diagnostics,
    now,
    logger: createLoggerDouble(),
    runtime,
    monitorConfig: createMonitorConfigDouble(),
    orderRecorder: economic.recorder,
    recordCumulativeExecution: (params) => {
      flow.recordCumulativeExecution(params);
    },
    prepareProtectiveTerminalExecution: flow.prepareProtectiveTerminalExecution,
    settleOrder: flow.settleOrder,
    cacheBootstrappingEvent: () => {},
    triggerRoute: () => {},
  });
  const terminal = {
    orderId: native.queryObservation.orderId,
    closedReason: 'CANCELED',
    source: 'STATE_CHECK',
    executedPrice: '0',
    executedAmount: '0',
    executedQuantity: 0,
    executedTimeMs: null,
    orderUpdatedAtMs: native.queryObservation.updatedAtMs,
  } as const;
  return {
    ...economic,
    native,
    flow,
    orderOps,
    eventFlow,
    diagnostics,
    records,
    terminal,
    now,
    advanceTo: (timeMs: number) => {
      nowMs = timeMs;
    },
    throwDiagnostics: () => {
      diagnosticThrows = true;
    },
  };
}

describe('order observation authoritative boundaries', () => {
  it('counts timeout WS terminal before settlement, pairs only the first ACK, and stays once across settlement/replay', async () => {
    const h = await createHarness();
    const order = h.runtime.trackedOrders.get('OBSERVED-ORDER');
    if (order === undefined) throw new Error('tracked order required');

    order.timeoutMarketConversionPending = true;
    await h.orderOps.cancelOrder(order.orderId, { kind: 'ORDER_FACT' });
    h.advanceTo(10_030);
    await h.orderOps.cancelOrder(order.orderId, { kind: 'ORDER_FACT' });
    h.advanceTo(10_090);
    h.eventFlow.handleOrderChangedWhenActive(h.native.pushObservation);
    expect(h.runtime.closedOrderIds.has(order.orderId)).toBe(false);
    expect(order.timeoutMarketConversionTerminalState?.closedReason).toBe('CANCELED');
    expect(h.records).toEqual([
      {
        operation: DIAGNOSTIC_OPERATIONS.ORDER_TERMINAL_CONFIRMED,
        fields: {
          orderId: order.orderId,
          symbol: 'BULL.HK',
          side: 'SELL',
          source: 'WS',
          closedReason: 'CANCELED',
          terminalConfirmedAtMs: 10_090,
          orderUpdatedAtMs: 50_000,
          count: 1,
        },
      },
      {
        operation: DIAGNOSTIC_OPERATIONS.CANCEL_ACKNOWLEDGEMENT_TO_TERMINAL,
        fields: expect.objectContaining({
          orderId: order.orderId,
          cancelAcknowledgedAtMs: 10_000,
          terminalConfirmedAtMs: 10_090,
          durationMs: 90,
          count: 1,
        }),
      },
    ]);
    h.eventFlow.handleOrderChangedWhenActive(h.native.pushObservation);
    expect(h.flow.settleOrder(h.terminal).handled).toBe(true);
    expect(h.flow.settleOrder(h.terminal).handled).toBe(false);
    expect(h.runtime.trackedOrderLifecycles.get(order.orderId)?.state).toBe('CLOSED');
    expect(h.records).toHaveLength(2);
  });

  it('does not backfill a duration when WS terminal wins the pending cancel ACK race', async () => {
    const h = await createHarness();
    h.native.setCancelBeforeReply(async () => {
      h.advanceTo(10_050);
      h.eventFlow.handleOrderChangedWhenActive(h.native.pushObservation);
      h.advanceTo(10_100);
    });

    expect(await h.orderOps.cancelOrder('OBSERVED-ORDER', { kind: 'ORDER_FACT' })).toEqual({
      kind: 'CANCEL_CONFIRMED',
      relatedBuyOrderIds: null,
    });

    expect(h.records.map((record) => record.operation)).toEqual([
      DIAGNOSTIC_OPERATIONS.ORDER_TERMINAL_CONFIRMED,
    ]);
    expect(h.runtime.closedOrderIds.has('OBSERVED-ORDER')).toBe(true);
    h.flow.settleOrder(h.terminal);
    expect(h.records).toHaveLength(1);
  });

  it.each(['none', 'same-clock', 'clock-regression'] as const)(
    'never fabricates ACK duration for %s',
    async (mode) => {
      const h = await createHarness();
      if (mode !== 'none') await h.orderOps.cancelOrder('OBSERVED-ORDER', { kind: 'ORDER_FACT' });

      if (mode === 'clock-regression') h.advanceTo(9_999);

      h.eventFlow.handleOrderChangedWhenActive(h.native.pushObservation);
      expect(h.records.map((record) => record.operation)).toEqual([
        DIAGNOSTIC_OPERATIONS.ORDER_TERMINAL_CONFIRMED,
      ]);
      expect(h.runtime.closedOrderIds.has('OBSERVED-ORDER')).toBe(true);
    },
  );

  it.each(['invalid-ack', 'negative-ack', 'invalid-terminal', 'negative-terminal'] as const)(
    'keeps the first ACK without fabricating duration for %s',
    async (mode) => {
      const h = await createHarness();
      if (mode === 'invalid-ack') h.advanceTo(Number.NaN);

      if (mode === 'negative-ack') h.advanceTo(-1);

      await h.orderOps.cancelOrder('OBSERVED-ORDER', { kind: 'ORDER_FACT' });
      h.advanceTo(10_100);
      await h.orderOps.cancelOrder('OBSERVED-ORDER', { kind: 'ORDER_FACT' });
      h.advanceTo(10_200);
      if (mode === 'invalid-terminal') h.advanceTo(Number.NaN);

      if (mode === 'negative-terminal') h.advanceTo(-1);

      h.eventFlow.handleOrderChangedWhenActive(h.native.pushObservation);
      expect(h.records.map((record) => record.operation)).toEqual([
        DIAGNOSTIC_OPERATIONS.ORDER_TERMINAL_CONFIRMED,
      ]);
      expect(h.runtime.closedOrderIds.has('OBSERVED-ORDER')).toBe(true);
    },
  );

  it('observes authoritative state-check before settlement and isolates even a throwing diagnostics implementation', async () => {
    const h = await createHarness();
    await h.orderOps.cancelOrder('OBSERVED-ORDER', { kind: 'ORDER_FACT' });
    h.advanceTo(10_100);
    h.throwDiagnostics();
    h.native.setCancelFailure(new Error('openapi error: code=601011: order cannot be cancelled'));
    expect(await h.orderOps.cancelOrder('OBSERVED-ORDER', { kind: 'ORDER_FACT' })).toMatchObject({
      kind: 'ALREADY_CLOSED',
      closedReason: 'CANCELED',
    });
    expect(h.runtime.closedOrderIds.has('OBSERVED-ORDER')).toBe(false);
    expect(h.records.map((record) => record.operation)).toEqual([
      DIAGNOSTIC_OPERATIONS.ORDER_TERMINAL_CONFIRMED,
      DIAGNOSTIC_OPERATIONS.CANCEL_ACKNOWLEDGEMENT_TO_TERMINAL,
    ]);
    expect(h.flow.settleOrder(h.terminal).handled).toBe(true);
    h.eventFlow.handleOrderChangedWhenActive(h.native.pushObservation);
    expect(h.records).toHaveLength(2);
  });

  it('preserves confirmation across recovery rollback and retry, without tying the count to settlement success', async () => {
    const h = await createHarness('BUY');
    const snapshot = await createBrokerIngressFixture({
      orderId: 'OBSERVED-ORDER',
      symbol: 'OLD_BULL.HK',
      stockName: 'OLD',
      remark: '',
      side: 'BUY',
      status: 'New',
      quantity: '100',
      executedQuantity: '0',
      submittedPrice: '1',
      executedPrice: '0',
      submittedAtMs: 1,
      updatedAtMs: 49_000,
    });
    const recoveryOrder = snapshot.queryObservation;
    h.runtime.queriedTerminalStateByOrderId.clear();
    let settlementAttempts = 0;
    const originalFailure = new Error('original settlement failure');
    const recovery = createRecoveryFlow({
      diagnostics: h.diagnostics,
      now: h.now,
      logger: createLoggerDouble(),
      runtime: h.runtime,
      termination: h.termination,
      orderHoldRegistry: h.holds,
      orderRecorder: h.recorder,
      tradingConfig: createTradingConfig(),
      symbolRegistry: createSymbolRegistryDouble(),
      trackOrder: () => {
        throw new Error('mismatched BUY should not be tracked');
      },
      cancelOrder: async () => {
        h.runtime.queriedTerminalStateByOrderId.set(recoveryOrder.orderId, {
          kind: 'TERMINAL',
          closedReason: 'CANCELED',
          status: 'CANCELED',
          executionStatus: 'NONE',
          submittedQuantity: 100,
          executedQuantity: 0,
          executedPrice: '0',
          executedAmount: '0',
          executionTimeMs: null,
          orderUpdatedAtMs: recoveryOrder.updatedAtMs,
        });
        return {
          kind: 'ALREADY_CLOSED',
          closedReason: 'CANCELED',
          relatedBuyOrderIds: null,
          terminalExecution: { submittedQuantity: 100, executedQuantity: 0 },
        };
      },
      settleOrder: () => {
        settlementAttempts += 1;
        throw originalFailure;
      },
      handleOrderChangedWhenActive: () => {},
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      const failure = await recovery
        .recoverOrderTrackingFromSnapshot([recoveryOrder])
        .catch((error: unknown) => error);
      expect(failure).toBe(originalFailure);
    }

    expect(settlementAttempts).toBe(2);
    expect(h.records.map((record) => record.operation)).toEqual([
      DIAGNOSTIC_OPERATIONS.ORDER_TERMINAL_CONFIRMED,
    ]);

    // 确认来源仍由真实诊断字段保留，lifecycle 只留存在标记。
    expect(h.records[0]?.fields).toMatchObject({
      orderId: recoveryOrder.orderId,
      source: 'RECOVERY',
    });

    expect(h.runtime.trackedOrderLifecycles.get(recoveryOrder.orderId)).toMatchObject({
      state: null,
      terminalConfirmed: true,
    });
  });
});
