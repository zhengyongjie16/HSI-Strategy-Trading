/**
 * 订单事件流、真实 DailyLossTracker 与结算流组合测试。
 *
 * 覆盖同一订单更新时间内累计成交继续增长时，事件合并、亏损投影、保护 episode 与刷新副作用必须共同推进。
 */
import { describe, expect, it } from 'bun:test';
import { createExecutionFixture } from '../core/orderRecorder/executionFixture.js';
import { createBrokerIngressFixture } from './architectureRefactoringP1Native/trade/brokerIngressFixture.js';
import { createTradingConfig } from '../../mock/factories/configFactory.js';
import { createEventFlow as createProductionEventFlow } from '../../src/core/trader/orderMonitor/eventFlow.js';
import {
  createMonitorConfigDouble,
  createMarketDataClientDouble,
  createSymbolRegistryDouble,
} from '../helpers/testDoubles.js';

async function flushIngress() {
  for (let index = 0; index < 100; index++) await Promise.resolve();
}

async function brokerObservation(
  orderId: string,
  status: 'PartialFilled' | 'Canceled',
  quantity: string,
  price: string,
  revisionMs: number,
) {
  const native = await createBrokerIngressFixture({
    orderId,
    tradeId: orderId + '-' + quantity + '-' + price,
    symbol: 'BULL.HK',
    stockName: 'HSI RC',
    remark: '',
    side: 'SELL',
    status,
    quantity: '100',
    executedQuantity: quantity,
    submittedPrice: '1',
    executedPrice: price,
    submittedAtMs: revisionMs - 10,
    executionTimeMs: revisionMs,
    updatedAtMs: revisionMs,
  });
  return native.pushObservation;
}

async function realEventChain(
  f: ReturnType<typeof createExecutionFixture>,
  orderId: string,
  revisionMs: number,
) {
  const native = await createBrokerIngressFixture({
    orderId,
    tradeId: orderId + '-tracking',
    symbol: 'BULL.HK',
    stockName: 'HSI RC',
    remark: '',
    side: 'SELL',
    status: 'New',
    quantity: '100',
    executedQuantity: '0',
    submittedPrice: '1',
    executedPrice: '0',
    submittedAtMs: revisionMs - 10,
    executionTimeMs: null,
    updatedAtMs: revisionMs,
  });
  f.runtime.runtimeState = 'ACTIVE';
  f.runtime.running = true;
  const monitorConfig = createMonitorConfigDouble();
  const ops = native.createOperations({
    runtime: f.runtime,
    monitorConfig,
    orderRecorder: f.recorder,
    orderHoldRegistry: f.holds,
    termination: f.termination,
    rateLimiter: f.rateLimiter,
    cacheManager: { clearCache: () => {}, getPendingOrders: async () => [] },
    getExecutionTimeEvidence: f.daily.getExecutionTimeEvidence,
    now: () => new Date(revisionMs),
    triggerRoute: () => {},
    captureWorkGuard: () => {
      const captured = f.snapshot.getView().token;
      return () =>
        f.snapshot.getView().token === captured &&
        !f.termination.isTerminated() &&
        f.runtime.runtimeState !== 'STOPPED';
    },
    recordCumulativeExecution: (p) => {
      f.flow.recordCumulativeExecution(p);
    },
  });
  ops.trackOrder({
    orderId,
    symbol: 'BULL.HK',
    side: native.queryObservation.executionSide,
    executionSide: native.queryObservation.executionSide,
    orderType: native.queryObservation.orderType,
    price: '1',
    initialSubmittedPrice: '1',
    quantity: 100,
    isLongSymbol: true,
    monitorSymbol: 'HSI.HK',
    isProtectiveLiquidation: true,
  });
  f.recorder.submitSellOrder(orderId, 'BULL.HK', 'LONG', 100, [], true, revisionMs - 10);
  return createProductionEventFlow({
    runtime: f.runtime,
    monitorConfig,
    now: () => new Date(revisionMs),
    orderRecorder: f.recorder,
    recordCumulativeExecution: (p) => {
      f.flow.recordCumulativeExecution(p);
    },
    prepareProtectiveTerminalExecution: f.flow.prepareProtectiveTerminalExecution,
    settleOrder: f.flow.settleOrder,
    cacheBootstrappingEvent: () => {},
    triggerRoute: () => {},
  });
}

describe('order monitor cumulative execution integration', () => {
  it('settles a stale SELL state-check terminal without rolling back tracked partial execution', async () => {
    const revisionMs = Date.parse('2026-07-11T02:00:00.000Z');
    const orderId = 'SELL-STALE-PARTIAL-TERMINAL';
    const native = await createBrokerIngressFixture({
      orderId,
      tradeId: 'sell60',
      symbol: 'BULL.HK',
      stockName: 'HSI RC',
      remark: '',
      side: 'SELL',
      status: 'PartialFilled',
      quantity: '100',
      executedQuantity: '60',
      submittedPrice: '0.7',
      executedPrice: '0.7',
      submittedAtMs: revisionMs - 5000,
      executionTimeMs: revisionMs,
      updatedAtMs: revisionMs,
    });
    const f = createExecutionFixture({ nowMs: revisionMs, createRecorder: native.createRecorder });
    f.commit('BUY-1', 'BUY', '0.8', '48', 60, -2000, 'BULL.HK');
    f.commit('BUY-2', 'BUY', '1.2', '48', 40, -1000, 'BULL.HK');
    const buyOrders = f.recorder.getBuyOrdersForSymbol('BULL.HK', true);
    const remainingBuyOrder = buyOrders[1];
    if (remainingBuyOrder === undefined) throw new Error('[测试] 预期存在第二笔待保留买单');

    const stateChanges: string[] = [];
    const monitor = native.createMonitor({
      now: () => new Date(revisionMs),
      scheduleTimer: setTimeout,
      clearTimer: clearTimeout,
      rateLimiter: f.rateLimiter,
      cacheManager: { clearCache: () => {}, getPendingOrders: async () => [] },
      marketDataClient: createMarketDataClientDouble(),
      orderRecorder: f.recorder,
      dailyLossTracker: f.daily,
      orderHoldRegistry: f.holds,
      protectiveLiquidationEpisodeTracker: f.episode,
      persistProtectiveLiquidationExecutionProgress: () => {
        throw new Error('ordinary SELL cannot persist protection');
      },
      symbolRegistry: createSymbolRegistryDouble(),
      tradingConfig: createTradingConfig(),
      postTradeConsistencyRuntime: f.sink,
      isContinuousTradingAllowed: () => false,
      termination: f.termination,
    });
    monitor.onOrderStateChanged((e) => {
      stateChanges.push(e.orderId + ':' + e.status);
    });
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    f.recorder.submitSellOrder(
      orderId,
      'BULL.HK',
      'LONG',
      100,
      buyOrders.map((o) => o.orderId),
      false,
      revisionMs - 500,
    );
    expect(f.recorder.getPendingSellSnapshot()).toHaveLength(1);
    monitor.trackOrder({
      orderId,
      symbol: 'BULL.HK',
      side: native.queryObservation.executionSide,
      executionSide: native.queryObservation.executionSide,
      orderType: native.queryObservation.orderType,
      price: '0.7',
      initialSubmittedPrice: '0.7',
      quantity: 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
    });
    native.emitOrderChanged();
    await flushIngress();
    expect(f.termination.getFatalState()).toEqual({ hasFatalError: false });
    expect(f.recorder.getPendingSellSnapshot()).toMatchObject([
      { orderId, filledQuantity: 60, status: 'partial' },
    ]);
    native.setCancelFailure(new Error('openapi error: code=601011: Order already cancelled'));
    const staleDetail = {
      orderId,
      tradeId: 'stale20',
      symbol: 'BULL.HK',
      stockName: 'HSI RC',
      remark: '',
      side: 'SELL' as const,
      status: 'PartialWithdrawal' as const,
      quantity: '100',
      executedQuantity: '20',
      submittedPrice: '0.7',
      executedPrice: '0.1',
      submittedAtMs: revisionMs - 5000,
      executionTimeMs: revisionMs - 1000,
      updatedAtMs: revisionMs - 1000,
    };
    native.setOrderDetailReplies([staleDetail, staleDetail]);
    native.setExecutionReplies([
      {
        orderId,
        tradeId: 'stale20',
        symbol: 'BULL.HK',
        quantity: '20',
        price: '0.1',
        tradeDoneAtMs: revisionMs - 1000,
      },
    ]);
    const firstOutcome = await monitor.cancelOrder(orderId, { kind: 'ORDER_FACT' });
    const duplicateOutcome = await monitor.cancelOrder(orderId, { kind: 'ORDER_FACT' });
    expect(firstOutcome.kind).toBe('ALREADY_CLOSED');
    expect(duplicateOutcome.kind).toBe('ALREADY_CLOSED');
    expect(native.nativeReadCounts().detail).toBe(2);
    expect(f.recorder.getSellRecordByOrderId(orderId)).toMatchObject({
      costAmount: '42',
      executedQuantity: 60,
      executedTime: revisionMs,
    });

    expect(f.recorder.getBuyOrdersForSymbol('BULL.HK', true).map((o) => o.orderId)).toEqual([
      remainingBuyOrder.orderId,
    ]);
    expect(f.recorder.getPendingSellSnapshot()).toEqual([]);
    expect(monitor.getPendingSellOrders('BULL.HK')).toEqual([]);
    expect(f.holds.getHoldSymbols()).toEqual(new Set());
    expect(f.daily.getLossOffset('LONG')).toBe('-6');
    expect(stateChanges).toEqual([orderId + ':CANCELED']);
    await monitor.stopRuntimeAndDrain();
    await monitor.teardown();
  });

  it('does not advance DailyLoss, episode, or refresh when progress persistence fails', () => {
    const revisionMs = Date.parse('2026-07-11T02:00:00.000Z');
    const fault = new Error('progress persistence failed');
    const f = createExecutionFixture({
      nowMs: revisionMs,
      persistProgress: () => {
        throw fault;
      },
    });
    f.commit('BUY-COST-PERSISTENCE-FAILURE', 'BUY', '1', '100', 100, -1, 'BULL.HK');
    const generation = f.snapshot.getView().token.snapshotGeneration;
    let caught: unknown;
    try {
      f.flow.recordCumulativeExecution({
        factStage: 'OPEN',
        orderId: 'PROTECTIVE-PERSISTENCE-FAILURE',
        side: 'SELL',
        monitorSymbol: 'HSI.HK',
        symbol: 'BULL.HK',
        isLongSymbol: true,
        isProtectiveLiquidation: true,
        executedPrice: '0.9',
        executedAmount: '90',
        executedQuantity: 100,
        executedTimeMs: revisionMs,
        orderUpdatedAtMs: revisionMs,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(fault);
    expect(f.daily.getLossOffset('LONG')).toBe('0');
    expect(f.episode.getInProgressEpisodes()).toEqual([]);
    expect(f.snapshot.getView().token.snapshotGeneration).toBe(generation);
    expect(f.recorder.getExecutionFact('PROTECTIVE-PERSISTENCE-FAILURE')).toBeNull();
    expect(f.daily.getExecutionTimeEvidence().map((x) => x.brokerOrderId)).toEqual([
      'BUY-COST-PERSISTENCE-FAILURE',
    ]);
  });

  it('records one TERMINAL DailyLoss fact and one additional refresh when a partial protective WS closes at the same quantity', async () => {
    const revisionMs = Date.parse('2026-07-11T02:00:00.000Z');
    const persistedProgress: Array<{
      factStage: 'OPEN' | 'TERMINAL';
      cumulativeQuantity: string;
      cumulativeAmount: string;
    }> = [];
    const f = createExecutionFixture({
      nowMs: revisionMs,
      persistProgress: (p) => {
        persistedProgress.push({
          factStage: p.factStage,
          cumulativeQuantity: p.cumulativeQuantity,
          cumulativeAmount: p.cumulativeAmount,
        });
      },
    });
    const eventFlow = await realEventChain(f, 'PROTECTIVE-PARTIAL-TERMINAL-ONCE', revisionMs);
    const generation = f.snapshot.getView().token.snapshotGeneration;
    eventFlow.handleOrderChangedWhenActive(
      await brokerObservation(
        'PROTECTIVE-PARTIAL-TERMINAL-ONCE',
        'PartialFilled',
        '40',
        '0.9',
        revisionMs,
      ),
    );
    const refreshCountAfterPartial = f.snapshot.getView().token.snapshotGeneration - generation;
    eventFlow.handleOrderChangedWhenActive(
      await brokerObservation(
        'PROTECTIVE-PARTIAL-TERMINAL-ONCE',
        'Canceled',
        '40',
        '0.9',
        revisionMs,
      ),
    );

    expect(persistedProgress).toEqual([
      { factStage: 'OPEN', cumulativeQuantity: '40', cumulativeAmount: '36' },
      { factStage: 'TERMINAL', cumulativeQuantity: '40', cumulativeAmount: '36' },
    ]);
    expect(persistedProgress.filter((p) => p.factStage === 'TERMINAL')).toHaveLength(1);
    expect(refreshCountAfterPartial).toBe(1);
    expect(f.snapshot.getView().token.snapshotGeneration - generation).toBe(2);
    expect(f.runtime.closedOrderIds.has('PROTECTIVE-PARTIAL-TERMINAL-ONCE')).toBe(true);
  });

  it('advances same-revision cumulative execution through event, daily loss, episode, and settlement', async () => {
    const revisionMs = Date.parse('2026-07-11T02:00:00.000Z');
    const persistedProgress: Array<{
      factStage: 'OPEN' | 'TERMINAL';
      cumulativeQuantity: string;
      cumulativeAmount: string;
    }> = [];
    const f = createExecutionFixture({
      nowMs: revisionMs,
      persistProgress: (p) => {
        persistedProgress.push({
          factStage: p.factStage,
          cumulativeQuantity: p.cumulativeQuantity,
          cumulativeAmount: p.cumulativeAmount,
        });
      },
    });
    f.commit('BUY-COST', 'BUY', '1', '100', 100, -1, 'BULL.HK');
    const eventFlow = await realEventChain(f, 'PROTECTIVE-SAME-REVISION', revisionMs);
    const generation = f.snapshot.getView().token.snapshotGeneration;
    for (const [status, quantity, price] of [
      ['PartialFilled', '40', '0.9'],
      ['PartialFilled', '100', '0.95'],
      ['Canceled', '100', '0.97'],
    ] as const)
      eventFlow.handleOrderChangedWhenActive(
        await brokerObservation('PROTECTIVE-SAME-REVISION', status, quantity, price, revisionMs),
      );

    expect(f.daily.getLossOffset('LONG')).toBe('-3');
    expect(persistedProgress).toEqual([
      { factStage: 'OPEN', cumulativeQuantity: '40', cumulativeAmount: '36' },
      { factStage: 'OPEN', cumulativeQuantity: '100', cumulativeAmount: '95' },
      { factStage: 'TERMINAL', cumulativeQuantity: '100', cumulativeAmount: '97' },
    ]);

    expect(f.episode.getInProgressEpisodes()).toEqual([
      { direction: 'LONG', symbol: 'BULL.HK', latestExecutedTimeMs: revisionMs },
    ]);
    expect(f.snapshot.getView().token.snapshotGeneration - generation).toBe(3);
    expect(f.runtime.closedOrderIds.has('PROTECTIVE-SAME-REVISION')).toBe(true);
  });
});
