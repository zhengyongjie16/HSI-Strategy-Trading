/**
 * 订单事件流、真实 DailyLossTracker 与结算流组合测试。
 *
 * 覆盖同一订单更新时间内累计成交继续增长时，事件合并、亏损投影、保护 episode 与刷新副作用必须共同推进。
 */
import { describe, expect, it } from 'bun:test';
import { OrderSide, OrderStatus, OrderType, TopicType } from 'longbridge';
import { createTradingConfig } from '../../mock/factories/configFactory.js';
import { createOrder, createPushOrderChanged } from '../../mock/factories/tradeFactory.js';
import { createTradeContextMock } from '../../mock/longbridge/tradeContextMock.js';
import {
  createDailyLossOrderAnalysisDeps,
  createOrderRecorder,
} from '../../src/core/orderRecorder/index.js';
import { createDailyLossTracker } from '../../src/core/riskController/dailyLossTracker.js';
import { createOrderHoldRegistry as createRealOrderHoldRegistry } from '../../src/core/trader/orderHoldRegistry.js';
import { createOrderMonitor } from '../../src/core/trader/orderMonitor/index.js';
import { createEventFlow } from '../../src/core/trader/orderMonitor/eventFlow.js';
import { createSettlementFlow } from '../../src/core/trader/orderMonitor/settlementFlow.js';
import type {
  OrderMonitorRuntimeStore,
  OrderMonitorTrackedOrder,
} from '../../src/core/trader/orderMonitor/types.js';
import { createProtectiveLiquidationEpisodeTracker } from '../../src/core/trader/protectiveLiquidationEpisodeTracker/index.js';
import type { OrderHoldRegistry } from '../../src/core/trader/types.js';
import { toHongKongTimeIso } from '../../src/utils/time/index.js';
import {
  createMarketDataClientDouble,
  createOrderRecorderDouble,
  createRateLimiterDouble,
  createSymbolRegistryDouble,
  createTradeContextDouble,
} from '../helpers/testDoubles.js';

async function emitOrderChanged(
  tradeCtx: ReturnType<typeof createTradeContextMock>,
  event: Parameters<ReturnType<typeof createTradeContextMock>['emitOrderChanged']>[0],
): Promise<void> {
  expect(tradeCtx.getSubscribedTopics().has(TopicType.Private)).toBe(true);
  tradeCtx.emitOrderChanged(event);
  tradeCtx.flushAllEvents();
  await Promise.resolve();
  await Promise.resolve();
}

function createRuntime(): OrderMonitorRuntimeStore {
  return {
    trackedOrders: new Map(),
    trackedOrderLifecycles: new Map(),
    bootstrappingOrderEvents: new Map(),
    closedOrderIds: new Set(),
    queriedTerminalStateByOrderId: new Map(),
    latestReplaceOutcomeByOrderId: new Map(),
    orderStateChangedListeners: new Set(),
    trackedOrderIdsBySymbol: new Map(),
    routeStatesBySymbol: new Map(),
    latestRouteGenerationBySymbol: new Map(),
    runtimeState: 'ACTIVE',
    running: true,
    unsubscribeQuoteUpdated: null,
  };
}

function createOrderHoldRegistry(): OrderHoldRegistry {
  return {
    trackOrder: () => {},
    markOrderClosed: () => {},
    seedFromOrders: () => {},
    getHoldSymbols: () => new Set(),
    onOrderHoldSymbolsChanged: () => () => {},
    clear: () => {},
  };
}

describe('order monitor cumulative execution integration', () => {
  it('settles a stale SELL state-check terminal without rolling back tracked partial execution', async () => {
    const revisionMs = Date.parse('2026-07-11T02:00:00.000Z');
    const tradeCtx = createTradeContextMock();
    const rateLimiter = createRateLimiterDouble();
    const orderRecorder = createOrderRecorder({
      ctx: createTradeContextDouble(tradeCtx),
      rateLimiter,
    });
    orderRecorder.recordLocalBuy('BULL.HK', 0.8, 60, true, revisionMs - 2_000);
    orderRecorder.recordLocalBuy('BULL.HK', 1.2, 40, true, revisionMs - 1_000);
    const buyOrders = orderRecorder.getBuyOrdersForSymbol('BULL.HK', true);
    const remainingBuyOrder = buyOrders[1];
    if (remainingBuyOrder === undefined) {
      throw new Error('[测试] 预期存在第二笔待保留买单');
    }

    const orderId = 'SELL-STALE-PARTIAL-TERMINAL';
    tradeCtx.setFailureRule('cancelOrder', {
      failAtCalls: [1, 2],
      maxFailures: 2,
      errorMessage: 'openapi error: code=601011: Order already cancelled',
    });

    tradeCtx.seedTodayOrders([
      Object.assign(
        createOrder({
          orderId,
          symbol: 'BULL.HK',
          side: OrderSide.Sell,
          status: OrderStatus.PartialWithdrawal,
          quantity: 100,
          executedQuantity: 20,
          executedPrice: 0.1,
        }),
        { updatedAt: new Date(revisionMs - 1_000) },
      ),
    ]);

    const dailyLossTracker = createDailyLossTracker({
      ...createDailyLossOrderAnalysisDeps(),
      resolveOrderOwnership: () => null,
      toHongKongTimeIso,
    });
    dailyLossTracker.resetAll(new Date('2026-07-11T01:00:00.000Z'));
    for (const buyOrder of buyOrders) {
      dailyLossTracker.recordCumulativeExecution({
        factStage: 'TERMINAL',
        direction: 'LONG',
        symbol: buyOrder.symbol,
        side: OrderSide.Buy,
        executedPrice: buyOrder.executedPrice,
        executedQuantity: buyOrder.executedQuantity,
        executedTimeMs: buyOrder.executedTime,
        orderUpdatedAtMs: buyOrder.executedTime,
        orderId: buyOrder.orderId,
      });
    }

    const orderHoldRegistry = createRealOrderHoldRegistry();
    const stateChanges: string[] = [];
    const monitor = createOrderMonitor({
      ctx: createTradeContextDouble(tradeCtx),
      rateLimiter,
      cacheManager: {
        clearCache: () => {},
        getPendingOrders: async () => [],
      },
      marketDataClient: createMarketDataClientDouble(),
      orderRecorder,
      dailyLossTracker,
      orderHoldRegistry,
      protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTracker(),
      persistProtectiveLiquidationExecutionProgress: () => {},
      symbolRegistry: createSymbolRegistryDouble(),
      tradingConfig: createTradingConfig(),
      postTradeConsistencyRuntime: {
        recordSettlementRefreshNeed: () => {},
      },
      isContinuousTradingAllowed: () => true,
      onFatalError: (error) => {
        throw error;
      },
    });
    monitor.onOrderStateChanged((event) => {
      stateChanges.push(`${event.orderId}:${event.status}`);
    });
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    orderRecorder.submitSellOrder(
      orderId,
      'BULL.HK',
      'LONG',
      100,
      buyOrders.map((order) => order.orderId),
      revisionMs - 500,
    );
    expect(orderRecorder.getPendingSellSnapshot()).toHaveLength(1);
    monitor.trackOrder({
      orderId,
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      price: 0.7,
      initialSubmittedPrice: 0.7,
      quantity: 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: OrderType.ELO,
    });

    await emitOrderChanged(
      tradeCtx,
      createPushOrderChanged({
        orderId,
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.PartialFilled,
        executedQuantity: 60,
        executedPrice: 0.7,
        updatedAtMs: revisionMs,
      }),
    );

    expect(orderRecorder.getPendingSellSnapshot()).toMatchObject([
      {
        orderId,
        filledQuantity: 60,
        status: 'partial',
      },
    ]);

    const firstOutcome = await monitor.cancelOrder(orderId, { kind: 'ORDER_FACT' });
    const duplicateOutcome = await monitor.cancelOrder(orderId, { kind: 'ORDER_FACT' });

    expect(firstOutcome.kind).toBe('ALREADY_CLOSED');
    expect(duplicateOutcome.kind).toBe('ALREADY_CLOSED');
    expect(tradeCtx.getCalls('orderDetail')).toHaveLength(2);
    expect(orderRecorder.getSellRecordByOrderId(orderId)).toMatchObject({
      executedPrice: 0.7,
      executedQuantity: 60,
    });

    expect(
      orderRecorder.getBuyOrdersForSymbol('BULL.HK', true).map((order) => order.orderId),
    ).toEqual([remainingBuyOrder.orderId]);
    expect(orderRecorder.getPendingSellSnapshot()).toEqual([]);
    expect(monitor.getPendingSellOrders('BULL.HK')).toEqual([]);
    expect(orderHoldRegistry.getHoldSymbols()).toEqual(new Set());
    expect(dailyLossTracker.getLossOffset('LONG')).toBe(-6);
    expect(stateChanges).toEqual([`${orderId}:CANCELED`]);
  });

  it('does not advance DailyLoss, episode, or refresh when progress persistence fails', () => {
    const revisionMs = Date.parse('2026-07-11T02:00:00.000Z');
    const dailyLossTracker = createDailyLossTracker({
      ...createDailyLossOrderAnalysisDeps(),
      resolveOrderOwnership: () => null,
      toHongKongTimeIso,
    });
    dailyLossTracker.resetAll(new Date('2026-07-11T01:00:00.000Z'));
    dailyLossTracker.recordCumulativeExecution({
      factStage: 'TERMINAL',
      direction: 'LONG',
      symbol: 'BULL.HK',
      side: OrderSide.Buy,
      executedPrice: 1,
      executedQuantity: 100,
      executedTimeMs: revisionMs - 1,
      orderUpdatedAtMs: revisionMs - 1,
      orderId: 'BUY-COST-PERSISTENCE-FAILURE',
    });
    const protectiveLiquidationEpisodeTracker = createProtectiveLiquidationEpisodeTracker();
    let refreshCount = 0;
    const settlementFlow = createSettlementFlow({
      runtime: createRuntime(),
      orderHoldRegistry: createOrderHoldRegistry(),
      orderRecorder: createOrderRecorderDouble(),
      dailyLossTracker,
      protectiveLiquidationEpisodeTracker,
      persistProtectiveLiquidationExecutionProgress: () => {
        throw new Error('progress persistence failed');
      },
      postTradeConsistencyRuntime: {
        recordSettlementRefreshNeed: () => {
          refreshCount += 1;
        },
      },
      emitOrderStateChanged: () => {},
    });

    expect(() =>
      settlementFlow.recordCumulativeExecution({
        factStage: 'OPEN',
        orderId: 'PROTECTIVE-PERSISTENCE-FAILURE',
        side: 'SELL',
        monitorSymbol: 'HSI.HK',
        symbol: 'BULL.HK',
        isLongSymbol: true,
        isProtectiveLiquidation: true,
        executedPrice: 0.9,
        executedQuantity: 100,
        executedTimeMs: revisionMs,
        orderUpdatedAtMs: revisionMs,
      }),
    ).toThrow('progress persistence failed');
    expect(dailyLossTracker.getLossOffset('LONG')).toBe(0);
    expect(protectiveLiquidationEpisodeTracker.getInProgressEpisodes()).toEqual([]);
    expect(refreshCount).toBe(0);
  });

  it('records one TERMINAL DailyLoss fact and one additional refresh when a partial protective WS closes at the same quantity', () => {
    const revisionMs = Date.parse('2026-07-11T02:00:00.000Z');
    const runtime = createRuntime();
    const dailyLossTracker = createDailyLossTracker({
      ...createDailyLossOrderAnalysisDeps(),
      resolveOrderOwnership: () => null,
      toHongKongTimeIso,
    });
    dailyLossTracker.resetAll(new Date('2026-07-11T01:00:00.000Z'));
    const protectiveLiquidationEpisodeTracker = createProtectiveLiquidationEpisodeTracker();
    const persistedProgress: Array<{
      readonly factStage: 'OPEN' | 'TERMINAL';
      readonly cumulativeQuantity: string;
      readonly cumulativeAmount: string;
    }> = [];
    let refreshCount = 0;
    const settlementFlow = createSettlementFlow({
      runtime,
      orderHoldRegistry: createOrderHoldRegistry(),
      orderRecorder: createOrderRecorderDouble(),
      dailyLossTracker,
      protectiveLiquidationEpisodeTracker,
      persistProtectiveLiquidationExecutionProgress: (progress) => {
        persistedProgress.push({
          factStage: progress.factStage,
          cumulativeQuantity: progress.cumulativeQuantity,
          cumulativeAmount: progress.cumulativeAmount,
        });
      },
      postTradeConsistencyRuntime: {
        recordSettlementRefreshNeed: () => {
          refreshCount += 1;
        },
      },
      emitOrderStateChanged: () => {},
    });
    const trackedOrder: OrderMonitorTrackedOrder = {
      orderId: 'PROTECTIVE-PARTIAL-TERMINAL-ONCE',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: true,
      orderType: OrderType.ELO,
      submittedPrice: 1,
      initialSubmittedPrice: 1,
      submittedQuantity: 100,
      executedQuantity: 0,
      executedPrice: null,
      lastExecutedTimeMs: null,
      lastOrderUpdateAtMs: null,
      status: OrderStatus.New,
      submittedAt: revisionMs - 10,
      lastPriceUpdateAt: revisionMs - 10,
      convertedToMarket: false,
      nextCancelAttemptAt: revisionMs,
      cancelRetryCount: 0,
      replaceCapability: 'SUPPORTED',
      replaceBlockedUntilAt: null,
      quoteRetryAttempts: 0,
      quoteRetryNextAt: null,
      quoteRetryExhausted: false,
      replaceTempBlockedCount: 0,
      replaceResumeMode: 'TIME_BACKOFF',
      timeoutMarketConversionPending: false,
      timeoutMarketConversionTerminalState: null,
    };
    runtime.trackedOrders.set(trackedOrder.orderId, trackedOrder);
    const eventFlow = createEventFlow({
      runtime,
      orderRecorder: createOrderRecorderDouble(),
      recordCumulativeExecution: (params) => {
        settlementFlow.recordCumulativeExecution(params);
      },
      prepareProtectiveTerminalExecution: settlementFlow.prepareProtectiveTerminalExecution,
      settleOrder: settlementFlow.settleOrder,
      cacheBootstrappingEvent: () => {},
      triggerRoute: () => {},
    });

    eventFlow.handleOrderChangedWhenActive(
      createPushOrderChanged({
        orderId: trackedOrder.orderId,
        symbol: trackedOrder.symbol,
        side: trackedOrder.side,
        status: OrderStatus.PartialFilled,
        executedQuantity: 40,
        executedPrice: 0.9,
        updatedAtMs: revisionMs,
      }),
    );
    const refreshCountAfterPartial = refreshCount;
    eventFlow.handleOrderChangedWhenActive(
      createPushOrderChanged({
        orderId: trackedOrder.orderId,
        symbol: trackedOrder.symbol,
        side: trackedOrder.side,
        status: OrderStatus.Canceled,
        executedQuantity: 40,
        executedPrice: 0.9,
        updatedAtMs: revisionMs,
      }),
    );

    expect(persistedProgress).toEqual([
      { factStage: 'OPEN', cumulativeQuantity: '40', cumulativeAmount: '36' },
      { factStage: 'TERMINAL', cumulativeQuantity: '40', cumulativeAmount: '36' },
    ]);

    expect(persistedProgress.filter((progress) => progress.factStage === 'TERMINAL')).toHaveLength(
      1,
    );
    expect(refreshCountAfterPartial).toBe(1);
    expect(refreshCount).toBe(2);
    expect(runtime.closedOrderIds.has(trackedOrder.orderId)).toBe(true);
  });

  it('advances same-revision cumulative execution through event, daily loss, episode, and settlement', () => {
    const revisionMs = Date.parse('2026-07-11T02:00:00.000Z');
    const runtime = createRuntime();
    const dailyLossTracker = createDailyLossTracker({
      ...createDailyLossOrderAnalysisDeps(),
      resolveOrderOwnership: () => null,
      toHongKongTimeIso,
    });
    dailyLossTracker.resetAll(new Date('2026-07-11T01:00:00.000Z'));
    dailyLossTracker.recordCumulativeExecution({
      factStage: 'TERMINAL',
      direction: 'LONG',
      symbol: 'BULL.HK',
      side: OrderSide.Buy,
      executedPrice: 1,
      executedQuantity: 100,
      executedTimeMs: revisionMs - 1,
      orderUpdatedAtMs: revisionMs - 1,
      orderId: 'BUY-COST',
    });

    const protectiveLiquidationEpisodeTracker = createProtectiveLiquidationEpisodeTracker();
    let refreshCount = 0;
    const persistedProgress: Array<{
      readonly factStage: 'OPEN' | 'TERMINAL';
      readonly cumulativeQuantity: string;
      readonly cumulativeAmount: string;
    }> = [];
    const settlementFlow = createSettlementFlow({
      runtime,
      orderHoldRegistry: createOrderHoldRegistry(),
      orderRecorder: createOrderRecorderDouble(),
      dailyLossTracker,
      protectiveLiquidationEpisodeTracker,
      persistProtectiveLiquidationExecutionProgress: (progress) => {
        persistedProgress.push({
          factStage: progress.factStage,
          cumulativeQuantity: progress.cumulativeQuantity,
          cumulativeAmount: progress.cumulativeAmount,
        });
      },
      postTradeConsistencyRuntime: {
        recordSettlementRefreshNeed: () => {
          refreshCount += 1;
        },
      },
      emitOrderStateChanged: () => {},
    });
    const trackedOrder: OrderMonitorTrackedOrder = {
      orderId: 'PROTECTIVE-SAME-REVISION',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: true,
      orderType: OrderType.ELO,
      submittedPrice: 1,
      initialSubmittedPrice: 1,
      submittedQuantity: 100,
      executedQuantity: 0,
      executedPrice: null,
      lastExecutedTimeMs: null,
      lastOrderUpdateAtMs: null,
      status: OrderStatus.New,
      submittedAt: revisionMs - 10,
      lastPriceUpdateAt: revisionMs - 10,
      convertedToMarket: false,
      nextCancelAttemptAt: revisionMs,
      cancelRetryCount: 0,
      replaceCapability: 'SUPPORTED',
      replaceBlockedUntilAt: null,
      quoteRetryAttempts: 0,
      quoteRetryNextAt: null,
      quoteRetryExhausted: false,
      replaceTempBlockedCount: 0,
      replaceResumeMode: 'TIME_BACKOFF',
      timeoutMarketConversionPending: false,
      timeoutMarketConversionTerminalState: null,
    };
    runtime.trackedOrders.set(trackedOrder.orderId, trackedOrder);
    const eventFlow = createEventFlow({
      runtime,
      orderRecorder: createOrderRecorderDouble(),
      recordCumulativeExecution: (params) => {
        settlementFlow.recordCumulativeExecution(params);
      },
      prepareProtectiveTerminalExecution: settlementFlow.prepareProtectiveTerminalExecution,
      settleOrder: settlementFlow.settleOrder,
      cacheBootstrappingEvent: () => {},
      triggerRoute: () => {},
    });

    for (const [status, executedQuantity, executedPrice] of [
      [OrderStatus.PartialFilled, 40, 0.9],
      [OrderStatus.PartialFilled, 100, 0.95],
      [OrderStatus.Canceled, 100, 0.97],
    ] as const) {
      eventFlow.handleOrderChangedWhenActive(
        createPushOrderChanged({
          orderId: trackedOrder.orderId,
          symbol: trackedOrder.symbol,
          side: trackedOrder.side,
          status,
          executedQuantity,
          executedPrice,
          updatedAtMs: revisionMs,
        }),
      );
    }

    expect(dailyLossTracker.getLossOffset('LONG')).toBe(-3);
    expect(persistedProgress).toEqual([
      { factStage: 'OPEN', cumulativeQuantity: '40', cumulativeAmount: '36' },
      { factStage: 'OPEN', cumulativeQuantity: '100', cumulativeAmount: '95' },
      { factStage: 'TERMINAL', cumulativeQuantity: '100', cumulativeAmount: '97' },
    ]);

    expect(protectiveLiquidationEpisodeTracker.getInProgressEpisodes()).toEqual([
      {
        direction: 'LONG',
        symbol: 'BULL.HK',
        latestExecutedTimeMs: revisionMs,
      },
    ]);
    expect(refreshCount).toBe(3);
    expect(runtime.closedOrderIds.has(trackedOrder.orderId)).toBe(true);
  });
});
