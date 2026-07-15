/**
 * orderMonitor 普通订单原始成交事实准入测试。
 *
 * 验证累计成交增加必须由本次 broker observation 的数量、价格、执行时间与 revision 共同证实；
 * 不允许把历史 tracked 时间当作新成交事实的替代来源。
 */
import { describe, expect, it } from 'bun:test';
import { OrderSide, OrderStatus, OrderType } from 'longbridge';
import { createPushOrderChanged } from '../../../../mock/factories/tradeFactory.js';
import { createTradingConfig } from '../../../../mock/factories/configFactory.js';
import { createEventFlow } from '../../../../src/core/trader/orderMonitor/eventFlow.js';
import { mergeMonotonicOrderFact } from '../../../../src/core/trader/orderMonitor/orderFactMerge.js';
import { createOrderOps } from '../../../../src/core/trader/orderMonitor/orderOps.js';
import type {
  FinalizeOrderSettlementParams,
  OrderCumulativeExecutionParams,
  OrderMonitorRuntimeStore,
  OrderMonitorTrackedOrder,
} from '../../../../src/core/trader/orderMonitor/types.js';
import type { OrderCacheManager, OrderHoldRegistry } from '../../../../src/core/trader/types.js';
import type { RateLimiter, TradeMutationPermit } from '../../../../src/types/services.js';
import {
  createOrderRecorderDouble,
  createTradeContextDouble,
} from '../../../helpers/testDoubles.js';
import { createTradeContextMock } from '../../../../mock/longbridge/tradeContextMock.js';

const KNOWN_FACT_TIME_MS = 200;

/** 创建 orderMonitor 所需的最小运行态。 */
function createRuntimeStore(): OrderMonitorRuntimeStore {
  return {
    trackedOrders: new Map<string, OrderMonitorTrackedOrder>(),
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

/** 创建普通订单的受控 tracked fact。 */
function createTrackedOrder(params: {
  readonly orderId: string;
  readonly side: OrderSide;
  readonly status?: OrderStatus;
  readonly executedQuantity?: number;
  readonly executedPrice?: number | null;
  readonly lastExecutedTimeMs?: number | null;
  readonly lastOrderUpdateAtMs?: number | null;
}): OrderMonitorTrackedOrder {
  const now = Date.now();
  return {
    orderId: params.orderId,
    symbol: 'BULL.HK',
    side: params.side,
    isLongSymbol: true,
    monitorSymbol: 'HSI.HK',
    isProtectiveLiquidation: false,
    orderType: OrderType.ELO,
    submittedPrice: 1,
    initialSubmittedPrice: 1,
    submittedQuantity: 100,
    executedQuantity: params.executedQuantity ?? 0,
    executedPrice: params.executedPrice ?? null,
    lastExecutedTimeMs: params.lastExecutedTimeMs ?? null,
    lastOrderUpdateAtMs: params.lastOrderUpdateAtMs ?? null,
    status: params.status ?? OrderStatus.New,
    submittedAt: now,
    lastPriceUpdateAt: now,
    convertedToMarket: false,
    nextCancelAttemptAt: now,
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
}

/** 创建事件流并记录所有会触及经济事实或路由的下游动作。 */
function createEventFlowHarness(trackedOrder: OrderMonitorTrackedOrder) {
  const runtime = createRuntimeStore();
  runtime.trackedOrders.set(trackedOrder.orderId, trackedOrder);
  const pendingSellQuantities: number[] = [];
  const dailyLossInputs: OrderCumulativeExecutionParams[] = [];
  const settlementInputs: FinalizeOrderSettlementParams[] = [];
  const routeWakeups: Array<Readonly<{ symbol: string; kind: string }>> = [];
  const eventFlow = createEventFlow({
    runtime,
    orderRecorder: createOrderRecorderDouble({
      markSellPartialFilled: (_orderId, executedQuantity) => {
        pendingSellQuantities.push(executedQuantity);
        return null;
      },
    }),
    recordCumulativeExecution: (input) => {
      dailyLossInputs.push(input);
    },
    prepareProtectiveTerminalExecution: () => null,
    settleOrder: (input) => {
      settlementInputs.push(input);
      return { handled: true, relatedBuyOrderIds: null };
    },
    cacheBootstrappingEvent: () => {},
    triggerRoute: (symbol, kind) => {
      routeWakeups.push({ symbol, kind });
    },
  });

  return {
    runtime,
    pendingSellQuantities,
    dailyLossInputs,
    settlementInputs,
    routeWakeups,
    eventFlow,
  };
}

/** 创建测试用 mutation permit 限流器。 */
function createRateLimiter(): RateLimiter {
  return {
    throttle: async () => {},
    withTradeMutation: async <T>(
      callback: (permit: TradeMutationPermit) => Promise<T>,
    ): Promise<T> =>
      callback({
        invoke: async <TResult>(operation: () => Promise<TResult>): Promise<TResult> => operation(),
      }),
  };
}

/** 创建与本测试无关的订单占用边界。 */
function createOrderHoldRegistry(): OrderHoldRegistry {
  return {
    trackOrder: () => {},
    markOrderClosed: () => {},
    seedFromOrders: () => {},
    getHoldSymbols: () => new Set<string>(),
    onOrderHoldSymbolsChanged: () => () => {},
    clear: () => {},
  };
}

/** 创建与本测试无关的订单缓存边界。 */
function createCacheManager(): OrderCacheManager {
  return {
    getPendingOrders: async () => [],
    clearCache: () => {},
  };
}

describe('orderMonitor 普通订单原始成交事实准入', () => {
  it('累计成交增加的原始执行时间不得早于已确认执行时间', () => {
    const trackedOrder = createTrackedOrder({
      orderId: 'ORDINARY-EXECUTION-TIME-STALE',
      side: OrderSide.Buy,
      status: OrderStatus.PartialFilled,
      executedQuantity: 40,
      executedPrice: 1.02,
      lastExecutedTimeMs: KNOWN_FACT_TIME_MS,
      lastOrderUpdateAtMs: KNOWN_FACT_TIME_MS,
    });

    expect(() =>
      mergeMonotonicOrderFact(trackedOrder, {
        status: OrderStatus.PartialFilled,
        executedQuantity: 80,
        executedPrice: 1.01,
        executedTimeMs: KNOWN_FACT_TIME_MS - 1,
        updatedAtMs: KNOWN_FACT_TIME_MS,
      }),
    ).toThrow(/累计成交数量推进.*执行时间.*倒退/);
  });

  it('累计成交增加的原始 broker revision 不得早于已确认 revision', () => {
    const trackedOrder = createTrackedOrder({
      orderId: 'ORDINARY-REVISION-STALE',
      side: OrderSide.Buy,
      status: OrderStatus.PartialFilled,
      executedQuantity: 40,
      executedPrice: 1.02,
      lastExecutedTimeMs: KNOWN_FACT_TIME_MS - 10,
      lastOrderUpdateAtMs: KNOWN_FACT_TIME_MS,
    });

    expect(() =>
      mergeMonotonicOrderFact(trackedOrder, {
        status: OrderStatus.PartialFilled,
        executedQuantity: 80,
        executedPrice: 1.01,
        executedTimeMs: KNOWN_FACT_TIME_MS - 1,
        updatedAtMs: KNOWN_FACT_TIME_MS - 1,
      }),
    ).toThrow(/累计成交数量推进.*broker revision.*倒退/);
  });

  it('累计成交增加的执行时间不得晚于同次 broker revision', () => {
    const trackedOrder = createTrackedOrder({
      orderId: 'ORDINARY-EXECUTION-AFTER-REVISION',
      side: OrderSide.Buy,
    });

    expect(() =>
      mergeMonotonicOrderFact(trackedOrder, {
        status: OrderStatus.PartialFilled,
        executedQuantity: 40,
        executedPrice: 1.02,
        executedTimeMs: KNOWN_FACT_TIME_MS + 1,
        updatedAtMs: KNOWN_FACT_TIME_MS,
      }),
    ).toThrow(/累计成交数量推进.*执行时间晚于 broker revision/);
  });

  it('普通 SELL WS 0 到 40 的累计成交缺少原始时间时零副作用失败', () => {
    const trackedOrder = createTrackedOrder({
      orderId: 'ORDINARY-SELL-WS-INVALID-TIME',
      side: OrderSide.Sell,
    });
    const harness = createEventFlowHarness(trackedOrder);
    const event = createPushOrderChanged({
      orderId: trackedOrder.orderId,
      symbol: trackedOrder.symbol,
      side: trackedOrder.side,
      status: OrderStatus.PartialFilled,
      executedQuantity: 40,
      executedPrice: 1.02,
      updatedAtMs: KNOWN_FACT_TIME_MS,
    });
    Object.assign(event, { updatedAt: new Date(Number.NaN) });

    expect(() => {
      harness.eventFlow.handleOrderChangedWhenActive(event);
    }).toThrow(/累计成交数量推进.*原始执行时间/);

    expect(trackedOrder).toMatchObject({
      status: OrderStatus.New,
      executedQuantity: 0,
      executedPrice: null,
      lastExecutedTimeMs: null,
      lastOrderUpdateAtMs: null,
    });
    expect(harness.pendingSellQuantities).toEqual([]);
    expect(harness.dailyLossInputs).toEqual([]);
    expect(harness.settlementInputs).toEqual([]);
    expect(harness.routeWakeups).toEqual([]);
  });

  it('普通 BUY Filled WS 缺少原始时间时不会进入结算或路由', () => {
    const trackedOrder = createTrackedOrder({
      orderId: 'ORDINARY-BUY-WS-INVALID-TIME',
      side: OrderSide.Buy,
    });
    const harness = createEventFlowHarness(trackedOrder);
    const event = createPushOrderChanged({
      orderId: trackedOrder.orderId,
      symbol: trackedOrder.symbol,
      side: trackedOrder.side,
      status: OrderStatus.Filled,
      executedQuantity: 100,
      executedPrice: 1.02,
      updatedAtMs: KNOWN_FACT_TIME_MS,
    });
    Object.assign(event, { updatedAt: new Date(Number.NaN) });

    expect(() => {
      harness.eventFlow.handleOrderChangedWhenActive(event);
    }).toThrow(/累计成交数量推进.*原始执行时间/);

    expect(trackedOrder).toMatchObject({
      status: OrderStatus.New,
      executedQuantity: 0,
      executedPrice: null,
      lastExecutedTimeMs: null,
      lastOrderUpdateAtMs: null,
    });
    expect(harness.pendingSellQuantities).toEqual([]);
    expect(harness.dailyLossInputs).toEqual([]);
    expect(harness.settlementInputs).toEqual([]);
    expect(harness.routeWakeups).toEqual([]);
  });

  it('普通 SELL 终态 40 到 80 的旧 revision 不得借用已确认时间结算', () => {
    const trackedOrder = createTrackedOrder({
      orderId: 'ORDINARY-SELL-TERMINAL-STALE-REVISION',
      side: OrderSide.Sell,
      status: OrderStatus.PartialFilled,
      executedQuantity: 40,
      executedPrice: 1.02,
      lastExecutedTimeMs: KNOWN_FACT_TIME_MS,
      lastOrderUpdateAtMs: KNOWN_FACT_TIME_MS,
    });
    const harness = createEventFlowHarness(trackedOrder);

    expect(() => {
      harness.eventFlow.handleOrderChangedWhenActive(
        createPushOrderChanged({
          orderId: trackedOrder.orderId,
          symbol: trackedOrder.symbol,
          side: trackedOrder.side,
          status: OrderStatus.Canceled,
          executedQuantity: 80,
          executedPrice: 1.01,
          updatedAtMs: KNOWN_FACT_TIME_MS - 1,
        }),
      );
    }).toThrow(/累计成交数量推进.*(?:执行时间|broker revision).*倒退/);

    expect(trackedOrder).toMatchObject({
      status: OrderStatus.PartialFilled,
      executedQuantity: 40,
      executedPrice: 1.02,
      lastExecutedTimeMs: KNOWN_FACT_TIME_MS,
      lastOrderUpdateAtMs: KNOWN_FACT_TIME_MS,
    });
    expect(harness.pendingSellQuantities).toEqual([]);
    expect(harness.dailyLossInputs).toEqual([]);
    expect(harness.settlementInputs).toEqual([]);
    expect(harness.routeWakeups).toEqual([]);
  });

  it('相同 revision 的普通累计成交增加直接提交本次原始时间与 revision', () => {
    const trackedOrder = createTrackedOrder({
      orderId: 'ORDINARY-SELL-SAME-REVISION',
      side: OrderSide.Sell,
      status: OrderStatus.PartialFilled,
      executedQuantity: 40,
      executedPrice: 1.02,
      lastExecutedTimeMs: KNOWN_FACT_TIME_MS,
      lastOrderUpdateAtMs: KNOWN_FACT_TIME_MS,
    });
    const harness = createEventFlowHarness(trackedOrder);

    harness.eventFlow.handleOrderChangedWhenActive(
      createPushOrderChanged({
        orderId: trackedOrder.orderId,
        symbol: trackedOrder.symbol,
        side: trackedOrder.side,
        status: OrderStatus.PartialFilled,
        executedQuantity: 80,
        executedPrice: 1.01,
        updatedAtMs: KNOWN_FACT_TIME_MS,
      }),
    );

    expect(trackedOrder).toMatchObject({
      status: OrderStatus.PartialFilled,
      executedQuantity: 80,
      executedPrice: 1.01,
      lastExecutedTimeMs: KNOWN_FACT_TIME_MS,
      lastOrderUpdateAtMs: KNOWN_FACT_TIME_MS,
    });
    expect(harness.pendingSellQuantities).toEqual([80]);
    expect(harness.dailyLossInputs).toEqual([
      expect.objectContaining({
        executedQuantity: 80,
        executedTimeMs: KNOWN_FACT_TIME_MS,
        orderUpdatedAtMs: KNOWN_FACT_TIME_MS,
      }),
    ]);
    expect(harness.settlementInputs).toEqual([]);
    expect(harness.routeWakeups).toEqual([{ symbol: 'BULL.HK', kind: 'ORDER_EVENT' }]);
  });

  it('零成交终态即使没有本次原始时间仍可收口生命周期', () => {
    const trackedOrder = createTrackedOrder({
      orderId: 'ORDINARY-ZERO-TERMINAL',
      side: OrderSide.Sell,
    });
    const harness = createEventFlowHarness(trackedOrder);
    const event = createPushOrderChanged({
      orderId: trackedOrder.orderId,
      symbol: trackedOrder.symbol,
      side: trackedOrder.side,
      status: OrderStatus.Canceled,
      executedQuantity: 0,
      executedPrice: 0,
      updatedAtMs: KNOWN_FACT_TIME_MS,
    });
    Object.assign(event, { updatedAt: new Date(Number.NaN) });

    expect(() => {
      harness.eventFlow.handleOrderChangedWhenActive(event);
    }).not.toThrow();

    expect(trackedOrder).toMatchObject({
      status: OrderStatus.Canceled,
      executedQuantity: 0,
      executedPrice: null,
      lastExecutedTimeMs: null,
      lastOrderUpdateAtMs: null,
    });
    expect(harness.pendingSellQuantities).toEqual([]);
    expect(harness.dailyLossInputs).toEqual([]);
    expect(harness.settlementInputs).toEqual([
      expect.objectContaining({
        executedQuantity: 0,
        executedTimeMs: null,
        orderUpdatedAtMs: null,
      }),
    ]);
    expect(harness.routeWakeups).toEqual([]);
  });
});

describe('orderMonitor 普通 OPEN state-check 原始成交事实准入', () => {
  it('API OPEN 累计成交增加但缺少 revision 时不得写入 tracked、pending、DailyLoss 或路由', async () => {
    const runtime = createRuntimeStore();
    const tradeContext = createTradeContextMock();
    tradeContext.cancelOrder = async () => {
      throw new Error('openapi error: code=601011: order cannot be cancelled');
    };
    const pendingSellQuantities: number[] = [];
    const dailyLossInputs: OrderCumulativeExecutionParams[] = [];
    const routeWakeups: Array<Readonly<{ symbol: string; kind: string }>> = [];
    const orderOps = createOrderOps({
      runtime,
      monitorConfig: createTradingConfig().monitor,
      ctx: createTradeContextDouble(tradeContext),
      rateLimiter: createRateLimiter(),
      cacheManager: createCacheManager(),
      orderHoldRegistry: createOrderHoldRegistry(),
      orderRecorder: createOrderRecorderDouble({
        markSellPartialFilled: (_orderId, executedQuantity) => {
          pendingSellQuantities.push(executedQuantity);
          return null;
        },
      }),
      recordCumulativeExecution: (input) => {
        dailyLossInputs.push(input);
      },
      orderStatusQuery: {
        checkOrderState: async () => ({
          kind: 'OPEN' as const,
          status: OrderStatus.PartialFilled,
          executedPrice: 1.02,
          executedQuantity: 40,
          updatedAtMs: null,
        }),
      },
      triggerRoute: (symbol, kind) => {
        routeWakeups.push({ symbol, kind });
      },
    });
    orderOps.trackOrder({
      orderId: 'ORDINARY-SELL-OPEN-NULL-REVISION',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      price: 1,
      initialSubmittedPrice: 1,
      quantity: 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: OrderType.ELO,
    });
    const trackedOrder = runtime.trackedOrders.get('ORDINARY-SELL-OPEN-NULL-REVISION');
    if (trackedOrder === undefined) {
      throw new Error('expected tracked order');
    }

    routeWakeups.length = 0;
    let caughtError: unknown = null;
    try {
      await orderOps.cancelOrder(trackedOrder.orderId, { kind: 'ORDER_FACT' });
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(Error);
    expect(caughtError).toHaveProperty(
      'message',
      expect.stringMatching(/state-check 累计成交数量推进但缺少有效 broker revision/),
    );

    expect(trackedOrder).toMatchObject({
      status: OrderStatus.New,
      executedQuantity: 0,
      executedPrice: null,
      lastExecutedTimeMs: null,
      lastOrderUpdateAtMs: null,
    });
    expect(pendingSellQuantities).toEqual([]);
    expect(dailyLossInputs).toEqual([]);
    expect(routeWakeups).toEqual([]);
  });
});
