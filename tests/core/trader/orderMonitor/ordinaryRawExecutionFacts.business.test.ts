/**
 * orderMonitor 普通订单原始成交事实准入测试。
 *
 * 验证累计成交增加必须由本次 broker observation 的数量、价格、执行时间与 revision 共同证实；
 * 不允许把历史 tracked 时间当作新成交事实的替代来源。
 */
import { describe, expect, it } from 'bun:test';
import { createBrokerIngressFixture } from '../../../integration/architectureRefactoringP1Native/trade/brokerIngressFixture.js';
import type { BrokerIngressInput } from '../../../infrastructure/longbridge/trade/brokerIngressFixture.js';
import { createAccountPositionSnapshot } from '../../../../src/application/accountPositionSnapshot/index.js';
import { createPostTradeConsistencyRuntime } from '../../../../src/app/runtime/createPostTradeConsistencyRuntime.js';
import { createSettlementFlow } from '../../../../src/core/trader/orderMonitor/settlementFlow.js';
import {
  createDailyLossTrackerDouble,
  createMonitorContextDouble,
  createLiquidationCooldownTrackerDouble,
  createProtectiveLiquidationEpisodeTrackerDouble,
  createTerminationDouble,
  createTraderDouble,
} from '../../../helpers/testDoubles.js';
import { createTradingConfig } from '../../../../mock/factories/configFactory.js';
import { createEventFlow as createProductionEventFlow } from '../../../../src/core/trader/orderMonitor/eventFlow.js';
import { mergeMonotonicOrderFact } from '../../../../src/core/trader/orderMonitor/orderFactMerge.js';
import type {
  FinalizeOrderSettlementParams,
  EventFlowDeps,
  OrderCumulativeExecutionParams,
  OrderMonitorRuntimeStore,
  OrderMonitorTrackedOrder,
} from '../../../../src/core/trader/orderMonitor/types.js';
import type { OrderCacheManager, OrderHoldRegistry } from '../../../../src/core/trader/types.js';
import type { RateLimiter, TradeMutationPermit } from '../../../../src/types/services.js';

type TestEventFlowDeps = Omit<EventFlowDeps, 'now'> & Partial<Pick<EventFlowDeps, 'now'>>;
function createEventFlow(deps: TestEventFlowDeps) {
  return createProductionEventFlow({
    now: () => new Date('2031-01-02T03:04:05.000Z'),
    ...deps,
  });
}

const KNOWN_FACT_TIME_MS = 200;

/** 创建 orderMonitor 所需的最小运行态。 */
function createRuntimeStore(): OrderMonitorRuntimeStore {
  return {
    trackedOrders: new Map<string, OrderMonitorTrackedOrder>(),
    trackedOrderLifecycles: new Map(),
    bootstrappingOrderEvents: new Map(),
    closedOrderIds: new Set(),
    queriedTerminalStateByOrderId: new Map(),
    latestReplaceTerminalByOrderId: new Map(),
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
  readonly side: 'BUY' | 'SELL';
  readonly status?: OrderMonitorTrackedOrder['status'];
  readonly executedQuantity?: number;
  readonly executedPrice?: string | null;
  readonly lastExecutedTimeMs?: number | null;
  readonly lastOrderUpdateAtMs?: number | null;
}): OrderMonitorTrackedOrder {
  const now = Date.now();
  return {
    orderId: params.orderId,
    symbol: 'BULL.HK',
    side: params.side,
    executionSide: params.side,
    isLongSymbol: true,
    monitorSymbol: 'HSI.HK',
    isProtectiveLiquidation: false,
    orderType: 'ELO',
    submittedPrice: '1',
    initialSubmittedPrice: '1',
    submittedQuantity: 100,
    executedQuantity: params.executedQuantity ?? 0,
    executedPrice: params.executedPrice ?? null,
    executedAmount: params.executedQuantity === 40 ? '40.8' : '0',
    executionPhase:
      params.status === 'FILLED' || params.status === 'CANCELED' ? 'TERMINAL' : 'OPEN',
    lastExecutedTimeMs: params.lastExecutedTimeMs ?? null,
    lastOrderUpdateAtMs: params.lastOrderUpdateAtMs ?? null,
    status: params.status ?? 'WORKING',
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
async function createEventFlowHarness(trackedOrder: OrderMonitorTrackedOrder) {
  const runtime = createRuntimeStore();
  runtime.trackedOrders.set(trackedOrder.orderId, trackedOrder);
  const pendingSellQuantities: number[] = [];
  const dailyLossInputs: OrderCumulativeExecutionParams[] = [];
  const settlementInputs: FinalizeOrderSettlementParams[] = [];
  const routeWakeups: Array<Readonly<{ symbol: string; kind: string }>> = [];
  const native = await createBrokerIngressFixture({
    orderId: 'ORIGINAL-BUY',
    tradeId: 'ORIGINAL-BUY-T',
    symbol: 'BULL.HK',
    stockName: 'HSI BULL',
    remark: '',
    side: 'BUY',
    status: 'Filled',
    orderType: 'ELO',
    quantity: '100',
    executedQuantity: '100',
    submittedPrice: '1',
    executedPrice: '1',
    submittedAtMs: 1,
    executionTimeMs: 100,
    updatedAtMs: 100,
  });
  native.setAccountBalance({
    currency: 'HKD',
    totalCash: '10000',
    netAssets: '10100',
    availableCash: '10000',
  });

  native.setStockPositions([
    {
      symbol: 'BULL.HK',
      symbolName: 'BULL',
      accountChannel: 'lb_papertrading',
      currency: 'HKD',
      quantity: '100',
      availableQuantity: '100',
      costPrice: '1',
    },
  ]);
  const account = native.createAccountService({ rateLimiter: createRateLimiter() });
  const snapshot = createAccountPositionSnapshot({
    dayEpoch: 1,
    readPort: account,
    scheduler: { schedule: queueMicrotask },
    reportFatalError: (error) => {
      throw error;
    },
  });
  const commit = await snapshot.requestRefresh({
    source: 'ordinary-raw-baseline',
    dayEpoch: 1,
    refreshAccount: true,
    refreshPositions: true,
  }).result;
  if (commit.status !== 'COMMITTED') throw new Error('expected actual paired commit');

  const dailyLossTracker = createDailyLossTrackerDouble();
  dailyLossTracker.resetAll(new Date(KNOWN_FACT_TIME_MS));
  let trader: ReturnType<typeof createTraderDouble> | null = null;
  const postTrade = createPostTradeConsistencyRuntime({
    snapshot,
    termination: createTerminationDouble(),
    getTrader: () => {
      if (trader === null) throw new Error('unbound trader');

      return trader;
    },
    onPositionsCommitted: async (token) => {
      if (!snapshot.isCurrent(token, { account: false, positions: true }))
        throw new Error('stale positions token');
    },
    scheduler: { scheduleTimer: setTimeout, clearTimer: clearTimeout },
  });
  const orderRecorder = native.createRecorder({
    rateLimiter: createRateLimiter(),
    getExecutionTimeEvidence: dailyLossTracker.getExecutionTimeEvidence,
    settlementRefreshNeedRecorder: postTrade,
  });
  trader = createTraderDouble({
    ...account,
    orderRecorder,
    executeSignals: async () => {
      throw new Error('raw observation must not submit');
    },
  });
  const protectiveTracker = createProtectiveLiquidationEpisodeTrackerDouble();
  const monitorContext = createMonitorContextDouble({ orderRecorder, dailyLossTracker });
  postTrade.bindBusinessDeps({
    monitorContext,
    dailyLossTracker,
    protectiveLiquidationEpisodeTracker: protectiveTracker,
    liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
    mixedTradeLogRepository: {
      appendCompletionIdempotent: () => {
        throw new Error('ordinary observation is not protective completion');
      },
    },
  });
  postTrade.start();
  expect(await postTrade.completeRebuildBaseline()).toBeTrue();
  const receipt = await postTrade.waitForFresh();
  expect(postTrade.isCurrent(receipt)).toBeTrue();
  const originalMark = orderRecorder.markSellPartialFilled;
  orderRecorder.markSellPartialFilled = (orderId, quantity) => {
    pendingSellQuantities.push(quantity);
    return originalMark(orderId, quantity);
  };
  const settlementFlow = createSettlementFlow({
    runtime,
    orderRecorder,
    dailyLossTracker,
    orderHoldRegistry: createOrderHoldRegistry(),
    protectiveLiquidationEpisodeTracker: protectiveTracker,
    persistProtectiveLiquidationExecutionProgress: () => {
      throw new Error('ordinary fact cannot persist protective progress');
    },
    postTradeConsistencyRuntime: postTrade,
    emitOrderStateChanged: () => {},
  });
  const eventFlow = createEventFlow({
    runtime,
    monitorConfig: createTradingConfig().monitor,
    orderRecorder,
    recordCumulativeExecution: (input) => {
      dailyLossInputs.push(input);
      settlementFlow.recordCumulativeExecution(input);
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
    native,
    isOriginalCurrent: () =>
      postTrade.isCurrent(receipt) &&
      snapshot.isCurrent(receipt.snapshotToken, { account: true, positions: true, paired: true }),
    orderRecorder,
    dailyLossTracker,
    dispose: async () => {
      await postTrade.stopAndDrain();
      await snapshot.requestClear({ reason: 'STOP', dayEpoch: 1 });
    },
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

/** 每次明确T/null与revision，经私有nativeSDKpush和独立ledger映射，不借tracked历史时间。 */
async function createNativeObservation(params: {
  orderId: string;
  side: 'BUY' | 'SELL';
  status: BrokerIngressInput['status'];
  quantity: string;
  executedQuantity: string;
  executedPrice: string;
  revisionMs: number;
  executionTimeMs: number | null;
}) {
  const native = await createBrokerIngressFixture({
    orderId: params.orderId,
    tradeId: params.orderId + '-T',
    symbol: 'BULL.HK',
    stockName: 'HSI BULL',
    remark: '',
    side: params.side,
    status: params.status,
    orderType: 'ELO',
    quantity: params.quantity,
    executedQuantity: params.executedQuantity,
    submittedPrice: '1',
    executedPrice: params.executedPrice,
    submittedAtMs: 1,
    executionTimeMs: params.executionTimeMs,
    updatedAtMs: params.revisionMs,
  });
  return native.pushObservation;
}
describe('orderMonitor 普通订单原始成交事实准入', () => {
  it('累计成交增加的原始执行时间不得早于已确认执行时间', () => {
    const trackedOrder = createTrackedOrder({
      orderId: 'ORDINARY-EXECUTION-TIME-STALE',
      side: 'BUY',
      status: 'PARTIALLY_FILLED',
      executedQuantity: 40,
      executedPrice: '1.02',
      lastExecutedTimeMs: KNOWN_FACT_TIME_MS,
      lastOrderUpdateAtMs: KNOWN_FACT_TIME_MS,
    });

    expect(() =>
      mergeMonotonicOrderFact(trackedOrder, {
        executedAmount: '80.8',
        executionPhase: 'OPEN',
        status: 'PARTIALLY_FILLED',
        executedQuantity: 80,
        executedPrice: '1.01',
        executedTimeMs: KNOWN_FACT_TIME_MS - 1,
        updatedAtMs: KNOWN_FACT_TIME_MS,
      }),
    ).toThrow('[订单事实] 新 revision 的可信执行时间倒退');
  });

  it('累计成交增加的原始 broker revision 不得早于已确认 revision', () => {
    const trackedOrder = createTrackedOrder({
      orderId: 'ORDINARY-REVISION-STALE',
      side: 'BUY',
      status: 'PARTIALLY_FILLED',
      executedQuantity: 40,
      executedPrice: '1.02',
      lastExecutedTimeMs: KNOWN_FACT_TIME_MS - 10,
      lastOrderUpdateAtMs: KNOWN_FACT_TIME_MS,
    });

    expect(() =>
      mergeMonotonicOrderFact(trackedOrder, {
        executedAmount: '80.8',
        executionPhase: 'OPEN',
        status: 'PARTIALLY_FILLED',
        executedQuantity: 80,
        executedPrice: '1.01',
        executedTimeMs: KNOWN_FACT_TIME_MS - 1,
        updatedAtMs: KNOWN_FACT_TIME_MS - 1,
      }),
    ).toThrow('[订单监控] 累计成交推进但 broker revision 倒退');
  });

  it('累计成交增加的执行时间不得晚于同次 broker revision', () => {
    const trackedOrder = createTrackedOrder({
      orderId: 'ORDINARY-EXECUTION-AFTER-REVISION',
      side: 'BUY',
    });

    expect(() =>
      mergeMonotonicOrderFact(trackedOrder, {
        executedAmount: '40.8',
        executionPhase: 'OPEN',
        status: 'PARTIALLY_FILLED',
        executedQuantity: 40,
        executedPrice: '1.02',
        executedTimeMs: KNOWN_FACT_TIME_MS + 1,
        updatedAtMs: KNOWN_FACT_TIME_MS,
      }),
    ).toThrow('[订单监控] 原始执行时间晚于 order revision');
  });

  it('普通 SELL WS 0 到 40 的累计成交缺少原始时间时零副作用失败', async () => {
    const trackedOrder = createTrackedOrder({
      orderId: 'ORDINARY-SELL-WS-INVALID-TIME',
      side: 'SELL',
    });
    const harness = await createEventFlowHarness(trackedOrder);
    const event = await createNativeObservation({
      orderId: trackedOrder.orderId,
      side: trackedOrder.side,
      status: 'PartialFilled',
      quantity: '100',
      executedQuantity: '40',
      executedPrice: '1.02',
      revisionMs: KNOWN_FACT_TIME_MS,
      executionTimeMs: null,
    });

    expect(() => {
      harness.eventFlow.handleOrderChangedWhenActive(event);
    }).toThrow('[订单监控] 正累计成交缺少有效金额、成交价格、真实执行时间或 broker revision');

    expect(trackedOrder).toMatchObject({
      status: 'WORKING',
      executedQuantity: 0,
      executedPrice: null,
      lastExecutedTimeMs: null,
      lastOrderUpdateAtMs: null,
    });
    expect(harness.pendingSellQuantities).toEqual([]);
    expect(harness.dailyLossInputs).toEqual([]);
    expect(harness.settlementInputs).toEqual([]);
    expect(harness.routeWakeups).toEqual([]);

    expect(harness.orderRecorder.getExecutionFact(trackedOrder.orderId)).toBeNull();
    expect(harness.dailyLossTracker.getLossOffset('LONG')).toBe('0');
    await harness.dispose();
  });

  it('普通 BUY Filled WS 缺少原始时间时不会进入结算或路由', async () => {
    const trackedOrder = createTrackedOrder({
      orderId: 'ORDINARY-BUY-WS-INVALID-TIME',
      side: 'BUY',
    });
    const harness = await createEventFlowHarness(trackedOrder);
    const event = await createNativeObservation({
      orderId: trackedOrder.orderId,
      side: trackedOrder.side,
      status: 'Filled',
      quantity: '100',
      executedQuantity: '100',
      executedPrice: '1.02',
      revisionMs: KNOWN_FACT_TIME_MS,
      executionTimeMs: null,
    });

    expect(() => {
      harness.eventFlow.handleOrderChangedWhenActive(event);
    }).toThrow('[订单监控] 正累计成交缺少有效金额、成交价格、真实执行时间或 broker revision');

    expect(trackedOrder).toMatchObject({
      status: 'WORKING',
      executedQuantity: 0,
      executedPrice: null,
      lastExecutedTimeMs: null,
      lastOrderUpdateAtMs: null,
    });
    expect(harness.pendingSellQuantities).toEqual([]);
    expect(harness.dailyLossInputs).toEqual([]);
    expect(harness.settlementInputs).toEqual([]);
    expect(harness.routeWakeups).toEqual([]);

    expect(harness.orderRecorder.getExecutionFact(trackedOrder.orderId)).toBeNull();
    expect(harness.dailyLossTracker.getLossOffset('LONG')).toBe('0');
    await harness.dispose();
  });

  it('普通 SELL 终态 40 到 80 的旧 revision 不得借用已确认时间结算', async () => {
    const trackedOrder = createTrackedOrder({
      orderId: 'ORDINARY-SELL-TERMINAL-STALE-REVISION',
      side: 'SELL',
      status: 'PARTIALLY_FILLED',
      executedQuantity: 40,
      executedPrice: '1.02',
      lastExecutedTimeMs: KNOWN_FACT_TIME_MS,
      lastOrderUpdateAtMs: KNOWN_FACT_TIME_MS,
    });
    const harness = await createEventFlowHarness(trackedOrder);

    const incoming = await createNativeObservation({
      orderId: trackedOrder.orderId,
      side: trackedOrder.side,
      status: 'Canceled',
      quantity: '100',
      executedQuantity: '80',
      executedPrice: '1.01',
      revisionMs: KNOWN_FACT_TIME_MS - 1,
      executionTimeMs: KNOWN_FACT_TIME_MS - 1,
    });
    expect(() => {
      harness.eventFlow.handleOrderChangedWhenActive(incoming);
    }).toThrow('[订单监控] 累计成交推进但 broker revision 倒退');

    expect(trackedOrder).toMatchObject({
      status: 'PARTIALLY_FILLED',
      executedQuantity: 40,
      executedPrice: '1.02',
      lastExecutedTimeMs: KNOWN_FACT_TIME_MS,
      lastOrderUpdateAtMs: KNOWN_FACT_TIME_MS,
    });
    expect(harness.pendingSellQuantities).toEqual([]);
    expect(harness.dailyLossInputs).toEqual([]);
    expect(harness.settlementInputs).toEqual([]);
    expect(harness.routeWakeups).toEqual([]);

    expect(harness.orderRecorder.getExecutionFact(trackedOrder.orderId)).toBeNull();
    expect(harness.dailyLossTracker.getLossOffset('LONG')).toBe('0');
    await harness.dispose();
  });

  it('相同 revision 的普通累计成交增加直接提交本次原始时间与 revision', async () => {
    const trackedOrder = createTrackedOrder({
      orderId: 'ORDINARY-SELL-SAME-REVISION',
      side: 'SELL',
      status: 'PARTIALLY_FILLED',
      executedQuantity: 40,
      executedPrice: '1.02',
      lastExecutedTimeMs: KNOWN_FACT_TIME_MS,
      lastOrderUpdateAtMs: KNOWN_FACT_TIME_MS,
    });
    const harness = await createEventFlowHarness(trackedOrder);

    harness.eventFlow.handleOrderChangedWhenActive(
      await createNativeObservation({
        orderId: trackedOrder.orderId,
        side: trackedOrder.side,
        status: 'PartialFilled',
        quantity: '100',
        executedQuantity: '80',
        executedPrice: '1.01',
        revisionMs: KNOWN_FACT_TIME_MS,
        executionTimeMs: KNOWN_FACT_TIME_MS,
      }),
    );

    expect(trackedOrder).toMatchObject({
      status: 'PARTIALLY_FILLED',
      executedQuantity: 80,
      executedPrice: '1.01',
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

    expect(harness.orderRecorder.getExecutionFact(trackedOrder.orderId)).toMatchObject({
      cumulativeQuantity: 80,
      cumulativeAmount: '80.8',
      executionTimeMs: KNOWN_FACT_TIME_MS,
      updatedAtMs: KNOWN_FACT_TIME_MS,
      phase: 'OPEN',
    });
    await harness.dispose();
  });

  it('零成交终态即使没有本次原始时间仍可收口生命周期', async () => {
    const trackedOrder = createTrackedOrder({
      orderId: 'ORDINARY-ZERO-TERMINAL',
      side: 'SELL',
    });
    const harness = await createEventFlowHarness(trackedOrder);
    const event = await createNativeObservation({
      orderId: trackedOrder.orderId,
      side: trackedOrder.side,
      status: 'Canceled',
      quantity: '100',
      executedQuantity: '0',
      executedPrice: '0',
      revisionMs: KNOWN_FACT_TIME_MS,
      executionTimeMs: null,
    });

    expect(() => {
      harness.eventFlow.handleOrderChangedWhenActive(event);
    }).not.toThrow();

    expect(trackedOrder).toMatchObject({
      status: 'CANCELED',
      executedQuantity: 0,
      executedPrice: '0',
      lastExecutedTimeMs: null,
      lastOrderUpdateAtMs: KNOWN_FACT_TIME_MS,
    });
    expect(harness.pendingSellQuantities).toEqual([]);
    expect(harness.dailyLossInputs).toEqual([]);
    expect(harness.settlementInputs).toEqual([
      expect.objectContaining({
        executedQuantity: 0,
        executedTimeMs: null,
        orderUpdatedAtMs: KNOWN_FACT_TIME_MS,
      }),
    ]);
    expect(harness.routeWakeups).toEqual([]);

    expect(harness.orderRecorder.getExecutionFact(trackedOrder.orderId)).toBeNull();
    expect(harness.dailyLossTracker.getLossOffset('LONG')).toBe('0');
    await harness.dispose();
  });
});

describe('orderMonitor 普通 OPEN state-check 原始成交事实准入', () => {
  it('API OPEN 累计成交增加但缺少 revision 时不得写入 tracked、pending、DailyLoss 或路由', async () => {
    const runtime = createRuntimeStore();
    const actualOwners = await createEventFlowHarness(
      createTrackedOrder({ orderId: 'ORDINARY-SELL-OPEN-NULL-REVISION', side: 'SELL' }),
    );
    const native = actualOwners.native;
    native.setOrderDetailReplies([
      {
        orderId: 'ORDINARY-SELL-OPEN-NULL-REVISION',
        tradeId: 'API-T',
        symbol: 'BULL.HK',
        stockName: 'HSI BULL',
        remark: '',
        side: 'SELL',
        status: 'PartialFilled',
        orderType: 'ELO',
        quantity: '100',
        executedQuantity: '40',
        submittedPrice: '1',
        executedPrice: '1.02',
        submittedAtMs: 1,
        executionTimeMs: KNOWN_FACT_TIME_MS,
        updatedAtMs: Number.NaN,
      },
    ]);
    native.setCancelFailure(new Error('openapi error: code=601011: order cannot be cancelled'));
    const pendingSellQuantities: number[] = [];
    const dailyLossInputs: OrderCumulativeExecutionParams[] = [];
    const routeWakeups: Array<Readonly<{ symbol: string; kind: string }>> = [];
    const orderOps = native.createOperations({
      captureWorkGuard: () => () =>
        runtime.running && runtime.runtimeState === 'ACTIVE' && actualOwners.isOriginalCurrent(),
      termination: {
        isTerminated: () => !runtime.running,
        reportFatalError: (error) => {
          throw error;
        },
      },
      now: () => new Date(200),
      getExecutionTimeEvidence: () => [],
      runtime,
      monitorConfig: createTradingConfig().monitor,
      rateLimiter: createRateLimiter(),
      cacheManager: createCacheManager(),
      orderHoldRegistry: createOrderHoldRegistry(),
      orderRecorder: {
        ...actualOwners.orderRecorder,
        markSellPartialFilled: (_orderId, executedQuantity) => {
          pendingSellQuantities.push(executedQuantity);
          return null;
        },
      },
      recordCumulativeExecution: (input) => {
        dailyLossInputs.push(input);
      },
      triggerRoute: (symbol, kind) => {
        routeWakeups.push({ symbol, kind });
      },
    });
    orderOps.trackOrder({
      orderId: 'ORDINARY-SELL-OPEN-NULL-REVISION',
      symbol: 'BULL.HK',
      side: 'SELL',
      price: '1',
      executionSide: 'SELL',
      submittedAtMs: 1,
      initialSubmittedPrice: '1',
      quantity: 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: 'ELO',
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

    expect(caughtError).toBeInstanceOf(TypeError);
    expect(caughtError).toHaveProperty('message', '[orderMapper] invalid updatedAt');

    expect(trackedOrder).toMatchObject({
      status: 'WORKING',
      executedQuantity: 0,
      executedPrice: null,
      lastExecutedTimeMs: null,
      lastOrderUpdateAtMs: null,
    });
    expect(pendingSellQuantities).toEqual([]);
    expect(dailyLossInputs).toEqual([]);
    expect(routeWakeups).toEqual([]);
    expect(native.nativeReadCounts()).toEqual({ cancel: 1, detail: 1 });
    expect(native.nativeMutations()).toEqual([]);
    expect(actualOwners.orderRecorder.getExecutionFact(trackedOrder.orderId)).toBeNull();
    await actualOwners.dispose();
  });
});
