/**
 * orderMonitor routeProcessor 业务测试
 *
 * 功能：
 * - 锁定 quoteFlow 迁移到 routeProcessor 后必须保持的超时与动作选择语义。
 */
import { describe, expect, it } from 'bun:test';
import { OrderSide, OrderStatus, OrderType } from 'longbridge';
import {
  ORDER_MONITOR_WAIT_WS_ONLY_BLOCK_UNTIL_MS,
  ORDER_QUOTE_RETRY,
} from '../../../../src/constants/index.js';
import { createOrderStorage } from '../../../../src/core/orderRecorder/orderStorage.js';
import { createRouteProcessor } from '../../../../src/core/trader/orderMonitor/routeProcessor.js';
import { createSettlementFlow } from '../../../../src/core/trader/orderMonitor/settlementFlow.js';
import type {
  FinalizeOrderSettlementParams,
  OrderMonitorRuntimeStore,
  OrderMonitorTrackedOrder,
  TerminalStateSnapshot,
  RouteProcessorDeps,
} from '../../../../src/core/trader/orderMonitor/types.js';
import type { OrderMonitorConfig, TrackOrderParams } from '../../../../src/core/trader/types.js';
import type {
  OrderRecord,
  RateLimiter,
  TradeMutationPermit,
} from '../../../../src/types/services.js';
import { toDecimal } from '../../../../src/core/trader/utils.js';
import { createTradeContextMock } from '../../../../mock/longbridge/tradeContextMock.js';
import {
  createOrderRecorderDouble,
  createProtectiveLiquidationEpisodeTrackerDouble,
  createQuoteDouble,
  createTradeContextDouble,
} from '../../../helpers/testDoubles.js';

function createRuntimeStore(): OrderMonitorRuntimeStore {
  return {
    trackedOrders: new Map(),
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

function createConfig(params?: {
  readonly buyTimeoutMs?: number;
  readonly sellTimeoutMs?: number;
  readonly priceUpdateIntervalMs?: number;
  readonly allowBuyOrderTrackingAboveInitialPrice?: boolean;
}): OrderMonitorConfig {
  return {
    buyTimeout: {
      enabled: true,
      timeoutMs: params?.buyTimeoutMs ?? 0,
    },
    sellTimeout: {
      enabled: true,
      timeoutMs: params?.sellTimeoutMs ?? 0,
    },
    priceUpdateIntervalMs: params?.priceUpdateIntervalMs ?? 0,
    priceDiffThreshold: 0.001,
    allowBuyOrderTrackingAboveInitialPrice: params?.allowBuyOrderTrackingAboveInitialPrice ?? true,
  };
}

/** 构造 routeProcessor 默认路径使用的无副作用 callback permit 限流器。 */
function createRateLimiterDouble(): RateLimiter {
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

function createTrackedOrder(
  params: Partial<OrderMonitorTrackedOrder> &
    Pick<OrderMonitorTrackedOrder, 'orderId' | 'symbol' | 'side'>,
): OrderMonitorTrackedOrder {
  const now = Date.now();
  return {
    orderId: params.orderId,
    symbol: params.symbol,
    side: params.side,
    isLongSymbol: params.isLongSymbol ?? true,
    monitorSymbol: params.monitorSymbol ?? 'HSI.HK',
    isProtectiveLiquidation: params.isProtectiveLiquidation ?? false,
    orderType: params.orderType ?? OrderType.ELO,
    submittedPrice: params.submittedPrice ?? 1,
    initialSubmittedPrice: params.initialSubmittedPrice ?? 1,
    submittedQuantity: params.submittedQuantity ?? 100,
    executedQuantity: params.executedQuantity ?? 0,
    executedPrice: params.executedPrice ?? null,
    lastExecutedTimeMs: params.lastExecutedTimeMs ?? null,
    lastOrderUpdateAtMs: params.lastOrderUpdateAtMs ?? null,
    status: params.status ?? OrderStatus.New,
    submittedAt: params.submittedAt ?? now - 5_000,
    lastPriceUpdateAt: params.lastPriceUpdateAt ?? now - 5_000,
    convertedToMarket: params.convertedToMarket ?? false,
    nextCancelAttemptAt: params.nextCancelAttemptAt ?? now - 1,
    cancelRetryCount: params.cancelRetryCount ?? 0,
    replaceCapability: params.replaceCapability ?? 'SUPPORTED',
    replaceBlockedUntilAt: params.replaceBlockedUntilAt ?? null,
    quoteRetryAttempts: params.quoteRetryAttempts ?? 0,
    quoteRetryNextAt: params.quoteRetryNextAt ?? null,
    quoteRetryExhausted: params.quoteRetryExhausted ?? false,
    replaceTempBlockedCount: params.replaceTempBlockedCount ?? 0,
    replaceResumeMode: params.replaceResumeMode ?? 'TIME_BACKOFF',
    timeoutMarketConversionPending: params.timeoutMarketConversionPending ?? false,
    timeoutMarketConversionTerminalState: params.timeoutMarketConversionTerminalState ?? null,
  };
}

function setLatestReplaceTerminal(
  runtime: OrderMonitorRuntimeStore,
  orderId: string,
  outcome: TerminalStateSnapshot,
): void {
  runtime.latestReplaceTerminalByOrderId.set(orderId, outcome);
}

function attachTrackedOrders(
  runtime: OrderMonitorRuntimeStore,
  symbol: string,
  orders: ReadonlyArray<OrderMonitorTrackedOrder>,
): void {
  const orderIds = new Set<string>();
  for (const order of orders) {
    runtime.trackedOrders.set(order.orderId, order);
    runtime.trackedOrderLifecycles.set(order.orderId, 'OPEN');
    orderIds.add(order.orderId);
  }

  runtime.trackedOrderIdsBySymbol.set(symbol, orderIds);
  runtime.routeStatesBySymbol.set(symbol, {
    symbol,
    generation: 1,
    inFlight: false,
    dirty: false,
    latestQuote: null,
    pendingWakeupKind: null,
    timerHandles: new Map(),
  });
  runtime.latestRouteGenerationBySymbol.set(symbol, 1);
}

function makeOrderRecord(
  orderId: string,
  executedPrice: number,
  executedQuantity: number,
  executedTime: number,
  symbol = 'BULL.HK',
): OrderRecord {
  return {
    orderId,
    symbol,
    executedPrice,
    executedQuantity,
    executedTime,
    submittedAt: undefined,
    updatedAt: undefined,
  };
}

function createDeferredValue<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
  };
}

function createStorageBackedOrderRecorder(
  storage: ReturnType<typeof createOrderStorage>,
): RouteProcessorDeps['orderRecorder'] {
  return createOrderRecorderDouble({
    recordLocalSell: (
      symbol,
      executedPrice,
      executedQuantity,
      isLongSymbol,
      executedTimeMs,
      orderId,
      relatedBuyOrderIds,
    ) => {
      storage.updateAfterSell(
        symbol,
        executedPrice,
        executedQuantity,
        isLongSymbol,
        executedTimeMs,
        orderId,
        relatedBuyOrderIds,
      );
    },
    getBuyOrdersForSymbol: (symbol, isLongSymbol) => storage.getBuyOrdersList(symbol, isLongSymbol),
    submitSellOrder: (orderId, symbol, direction, quantity, relatedBuyOrderIds, submittedAtMs) => {
      storage.addPendingSell({
        orderId,
        symbol,
        direction,
        submittedQuantity: quantity,
        relatedBuyOrderIds,
        submittedAt: submittedAtMs ?? Date.now(),
      });
    },
    markSellCancelled: (orderId) => storage.markSellCancelled(orderId),
    allocateRelatedBuyOrderIdsForRecovery: (symbol, direction, quantity) =>
      storage.allocateRelatedBuyOrderIdsForRecovery(symbol, direction, quantity),
    getPendingSellSnapshot: () => storage.getPendingSellSnapshot(),
    selectSellableOrders: (params) => storage.selectSellableOrders(params),
  });
}

function createSettlementFlowForRouteProcessor(params: {
  readonly runtime: OrderMonitorRuntimeStore;
  readonly orderRecorder: RouteProcessorDeps['orderRecorder'];
}): ReturnType<typeof createSettlementFlow> {
  return createSettlementFlow({
    runtime: params.runtime,
    orderHoldRegistry: {
      trackOrder: () => {},
      markOrderClosed: () => {},
      seedFromOrders: () => {},
      getHoldSymbols: () => new Set<string>(),
      onOrderHoldSymbolsChanged: () => () => {},
      clear: () => {},
    },
    orderRecorder: params.orderRecorder,
    dailyLossTracker: {
      resetAll: () => {},
      prepareProtectionBoundary: (boundaryParams) => ({
        ...boundaryParams,
        orderBaselines: [],
      }),
      commitProtectionBoundary: () => {},
      restoreExecutionSnapshot: () => {},
      restoreProtectionBoundary: () => {},
      recalculateFromAllOrders: () => {},
      recordCumulativeExecution: () => ({
        authoritativeFactChanged: false,
        executionAdvanced: false,
      }),
      getLossOffset: () => 0,
    },
    persistProtectiveLiquidationExecutionProgress: () => {},
    protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
    postTradeConsistencyRuntime: {
      recordSettlementRefreshNeed: () => {},
    },
    emitOrderStateChanged: () => {},
  });
}

function createTimeoutSellHandoffHarness(orderId: string): {
  readonly runtime: OrderMonitorRuntimeStore;
  readonly storage: ReturnType<typeof createOrderStorage>;
  readonly orderRecorder: RouteProcessorDeps['orderRecorder'];
  readonly settlementFlow: ReturnType<typeof createSettlementFlow>;
} {
  const runtime = createRuntimeStore();
  attachTrackedOrders(runtime, 'BULL.HK', [
    createTrackedOrder({
      orderId,
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      status: OrderStatus.Canceled,
      submittedQuantity: 200,
      executedQuantity: 0,
      submittedAt: Date.now() - 10_000,
      timeoutMarketConversionPending: true,
      timeoutMarketConversionTerminalState: {
        closedReason: 'CANCELED',
        source: 'WS',
        executedPrice: 0,
        executedQuantity: 0,
        executedTimeMs: Date.parse('2026-04-08T09:00:01.000Z'),
        orderUpdatedAtMs: Date.parse('2026-04-08T09:00:01.000Z'),
      },
    }),
  ]);

  const storage = createOrderStorage();
  storage.setBuyOrdersListForLong('BULL.HK', [
    makeOrderRecord('BUY-1', 1, 100, Date.parse('2026-04-08T08:30:00.000Z')),
    makeOrderRecord('BUY-2', 1.1, 100, Date.parse('2026-04-08T08:31:00.000Z')),
  ]);

  storage.addPendingSell({
    orderId,
    symbol: 'BULL.HK',
    direction: 'LONG',
    submittedQuantity: 200,
    relatedBuyOrderIds: ['BUY-1', 'BUY-2'],
    submittedAt: Date.parse('2026-04-08T09:00:00.000Z'),
  });

  const orderRecorder = createStorageBackedOrderRecorder(storage);
  const settlementFlow = createSettlementFlowForRouteProcessor({ runtime, orderRecorder });

  return {
    runtime,
    storage,
    orderRecorder,
    settlementFlow,
  };
}

function createDeps(params?: {
  readonly runtime?: OrderMonitorRuntimeStore;
  readonly config?: OrderMonitorConfig;
  readonly cancelOrder?: RouteProcessorDeps['cancelOrder'];
  readonly replaceOrderPrice?: RouteProcessorDeps['replaceOrderPrice'];
  readonly settleOrder?: RouteProcessorDeps['settleOrder'];
  readonly trackOrder?: RouteProcessorDeps['trackOrder'];
  readonly isContinuousTradingAllowed?: () => boolean;
  readonly orderRecorder?: RouteProcessorDeps['orderRecorder'];
  readonly ctx?: RouteProcessorDeps['ctx'];
  readonly rateLimiter?: RouteProcessorDeps['rateLimiter'];
  readonly now?: RouteProcessorDeps['now'];
}): {
  readonly runtime: OrderMonitorRuntimeStore;
  readonly tradeCtx: ReturnType<typeof createTradeContextMock>;
  readonly deps: RouteProcessorDeps;
} {
  const runtime = params?.runtime ?? createRuntimeStore();
  const config = params?.config ?? createConfig();
  const tradeCtx = createTradeContextMock();
  const deps: RouteProcessorDeps = {
    now: params?.now ?? (() => new Date(Date.now())),
    runtime,
    config,
    thresholdDecimal: toDecimal(config.priceDiffThreshold),
    orderRecorder: params?.orderRecorder ?? createOrderRecorderDouble(),
    ctx: params?.ctx ?? createTradeContextDouble(tradeCtx),
    rateLimiter: params?.rateLimiter ?? createRateLimiterDouble(),
    isContinuousTradingAllowed: params?.isContinuousTradingAllowed ?? (() => true),
    trackOrder:
      params?.trackOrder ??
      ((_trackParams: TrackOrderParams) => {
        throw new Error('trackOrder was not stubbed');
      }),
    cancelOrder:
      params?.cancelOrder ??
      (async (_orderId: string) => ({
        kind: 'UNKNOWN_FAILURE',
        errorCode: null,
      })),
    replaceOrderPrice:
      params?.replaceOrderPrice ??
      (async (_orderId: string, _newPrice: number, _quantity?: number | null) => {}),
    settleOrder:
      params?.settleOrder ??
      ((_params) => ({
        handled: true,
        relatedBuyOrderIds: null,
      })),
  };

  return {
    runtime,
    tradeCtx,
    deps,
  };
}

async function captureTimeoutMarketRouteError(deps: RouteProcessorDeps): Promise<string> {
  const routeProcessor = createRouteProcessor(deps);
  try {
    await routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'ORDER_EVENT',
      latestQuote: null,
    });
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }

  return '';
}

function expectTimeoutSellOccupancyReleased(storage: ReturnType<typeof createOrderStorage>): void {
  expect(storage.getPendingSellSnapshot()).toEqual([]);
  const sellableOrders = storage.selectSellableOrders({
    symbol: 'BULL.HK',
    direction: 'LONG',
    strategy: 'ALL',
    currentPrice: 1.2,
  });
  expect(sellableOrders.orders.map((order) => order.orderId)).toEqual(['BUY-1', 'BUY-2']);
  expect(sellableOrders.totalQuantity).toBe(200);
}

describe('orderMonitor routeProcessor', () => {
  it('将 timeout snapshot 已准备的保护性 progress 原样传入终态结算', async () => {
    const runtime = createRuntimeStore();
    const preparedExecution = {
      authoritativeFactChanged: true,
      executionAdvanced: true,
    };
    attachTrackedOrders(runtime, 'BULL.HK', [
      createTrackedOrder({
        orderId: 'SELL-TIMEOUT-PREPARED-PROGRESS',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.Filled,
        submittedQuantity: 40,
        executedQuantity: 40,
        executedPrice: 1.02,
        isProtectiveLiquidation: true,
        timeoutMarketConversionPending: true,
        timeoutMarketConversionTerminalState: {
          closedReason: 'FILLED',
          source: 'WS',
          executedPrice: 1.02,
          executedQuantity: 40,
          executedTimeMs: Date.parse('2026-07-13T05:00:00.000Z'),
          orderUpdatedAtMs: Date.parse('2026-07-13T05:00:00.000Z'),
          preparedProtectiveTerminalExecution: preparedExecution,
        },
      }),
    ]);
    const settlementInputs: FinalizeOrderSettlementParams[] = [];
    const { deps } = createDeps({
      runtime,
      settleOrder: (params) => {
        settlementInputs.push(params);
        return { handled: true, relatedBuyOrderIds: null };
      },
    });

    await createRouteProcessor(deps).processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'ORDER_EVENT',
      latestQuote: null,
    });

    expect(settlementInputs).toHaveLength(1);
    const settlementInput = settlementInputs[0];
    if (settlementInput === undefined) {
      throw new Error('missing timeout settlement input');
    }

    expect(settlementInput.preparedProtectiveTerminalExecution).toBe(preparedExecution);
  });

  it('submits timeout market conversion through a callback permit instead of read throttle', async () => {
    const runtime = createRuntimeStore();
    attachTrackedOrders(runtime, 'BULL.HK', [
      createTrackedOrder({
        orderId: 'SELL-TIMEOUT-PERMIT',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.Canceled,
        timeoutMarketConversionPending: true,
        timeoutMarketConversionTerminalState: {
          closedReason: 'CANCELED',
          source: 'WS',
          executedPrice: 0,
          executedQuantity: 0,
          executedTimeMs: Date.now(),
          orderUpdatedAtMs: Date.now(),
        },
      }),
    ]);
    const events: string[] = [];
    const rateLimiter = {
      throttle: async (): Promise<void> => {
        throw new Error('timeout market submit must not use read throttle');
      },
      withTradeMutation: async <T>(
        callback: (permit: {
          readonly invoke: <TResult>(operation: () => Promise<TResult>) => Promise<TResult>;
        }) => Promise<T>,
      ): Promise<T> => {
        events.push('permit');
        let invoked = false;
        return callback({
          invoke: async <TResult>(operation: () => Promise<TResult>): Promise<TResult> => {
            if (invoked) {
              throw new Error('mutation permit invoked more than once');
            }

            invoked = true;
            events.push('invoke');
            return operation();
          },
        });
      },
    };
    const trackedOrders: TrackOrderParams[] = [];
    const { deps, tradeCtx } = createDeps({
      runtime,
      rateLimiter,
      settleOrder: () => ({
        handled: true,
        relatedBuyOrderIds: ['BUY-1'],
      }),
      trackOrder: (params) => {
        trackedOrders.push(params);
      },
    });

    await createRouteProcessor(deps).processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'ORDER_EVENT',
      latestQuote: null,
    });

    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(1);
    expect(trackedOrders).toHaveLength(1);
    expect(events).toEqual(['permit', 'invoke']);
  });

  it('买单超时只触发 cancel，不转市价', async () => {
    const runtime = createRuntimeStore();
    attachTrackedOrders(runtime, 'BULL.HK', [
      createTrackedOrder({
        orderId: 'BUY-TIMEOUT-1',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
      }),
    ]);
    const cancelOrderIds: string[] = [];
    const { deps, tradeCtx } = createDeps({
      runtime,
      cancelOrder: async (orderId) => {
        cancelOrderIds.push(orderId);
        return {
          kind: 'CANCEL_CONFIRMED',
          relatedBuyOrderIds: null,
        };
      },
    });
    const routeProcessor = createRouteProcessor(deps);

    await routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'TIMER',
      latestQuote: null,
    });

    expect(cancelOrderIds).toEqual(['BUY-TIMEOUT-1']);
    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(0);
    const trackedOrder = runtime.trackedOrders.get('BUY-TIMEOUT-1');
    expect(trackedOrder?.nextCancelAttemptAt).toBe(ORDER_MONITOR_WAIT_WS_ONLY_BLOCK_UNTIL_MS);
  });

  it('普通终态订单不会再次进入 timeout 处理', async () => {
    const runtime = createRuntimeStore();
    attachTrackedOrders(runtime, 'BULL.HK', [
      createTrackedOrder({
        orderId: 'BUY-CLOSED-SHOULD-SKIP-TIMEOUT',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
        status: OrderStatus.Filled,
      }),
    ]);
    const cancelOrderIds: string[] = [];
    const { deps } = createDeps({
      runtime,
      cancelOrder: async (orderId) => {
        cancelOrderIds.push(orderId);
        return {
          kind: 'CANCEL_CONFIRMED',
          relatedBuyOrderIds: null,
        };
      },
    });
    const routeProcessor = createRouteProcessor(deps);

    await routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'TIMER',
      latestQuote: null,
    });

    expect(cancelOrderIds).toEqual([]);
  });

  it('超时等待中的完整成交卖单即使剩余数量为零也会消费终态快照完成 settlement', async () => {
    const runtime = createRuntimeStore();
    attachTrackedOrders(runtime, 'BULL.HK', [
      createTrackedOrder({
        orderId: 'SELL-TIMEOUT-FILLED-SETTLEMENT',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.Filled,
        submittedQuantity: 100,
        executedQuantity: 100,
        timeoutMarketConversionPending: true,
        timeoutMarketConversionTerminalState: {
          closedReason: 'FILLED',
          source: 'WS',
          executedPrice: 1.02,
          executedQuantity: 100,
          executedTimeMs: Date.parse('2026-04-08T09:00:01.000Z'),
          orderUpdatedAtMs: Date.parse('2026-04-08T09:00:01.000Z'),
        },
      }),
    ]);
    const settlementOrderIds: string[] = [];
    const { deps, tradeCtx } = createDeps({
      runtime,
      settleOrder: (params) => {
        settlementOrderIds.push(params.orderId);
        return {
          handled: true,
          relatedBuyOrderIds: null,
        };
      },
    });
    const routeProcessor = createRouteProcessor(deps);

    await routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'ORDER_EVENT',
      latestQuote: null,
    });

    expect(settlementOrderIds).toEqual(['SELL-TIMEOUT-FILLED-SETTLEMENT']);
    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(0);
  });

  it('卖单超时撤单请求成功后进入等待 WS，不立即转市价', async () => {
    const runtime = createRuntimeStore();
    attachTrackedOrders(runtime, 'BULL.HK', [
      createTrackedOrder({
        orderId: 'SELL-TIMEOUT-1',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
      }),
    ]);
    const cancelOrderIds: string[] = [];
    const { deps, tradeCtx } = createDeps({
      runtime,
      cancelOrder: async (orderId, beforeBrokerCancel?: () => boolean) => {
        cancelOrderIds.push(orderId);
        if (beforeBrokerCancel === undefined) {
          throw new Error('[测试] 超时卖单撤单前必须执行 route preflight');
        }

        expect(beforeBrokerCancel()).toBe(true);
        return {
          kind: 'CANCEL_CONFIRMED',
          relatedBuyOrderIds: null,
        };
      },
    });
    const routeProcessor = createRouteProcessor(deps);

    await routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'TIMER',
      latestQuote: null,
    });

    expect(cancelOrderIds).toEqual(['SELL-TIMEOUT-1']);
    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(0);
    const trackedOrder = runtime.trackedOrders.get('SELL-TIMEOUT-1');
    expect(trackedOrder?.timeoutMarketConversionPending).toBe(true);
    expect(trackedOrder?.nextCancelAttemptAt).toBe(ORDER_MONITOR_WAIT_WS_ONLY_BLOCK_UNTIL_MS);
  });

  it('卖单等待终态快照时会先 settlement，再转 MO', async () => {
    const runtime = createRuntimeStore();
    attachTrackedOrders(runtime, 'BULL.HK', [
      createTrackedOrder({
        orderId: 'SELL-CONVERT-1',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.Canceled,
        timeoutMarketConversionPending: true,
        timeoutMarketConversionTerminalState: {
          closedReason: 'CANCELED',
          source: 'WS',
          executedPrice: 0,
          executedQuantity: 0,
          executedTimeMs: Date.parse('2026-04-08T09:00:01.000Z'),
          orderUpdatedAtMs: Date.parse('2026-04-08T09:00:01.000Z'),
        },
      }),
    ]);
    const callSequence: string[] = [];
    const trackedOrders: TrackOrderParams[] = [];
    const { deps, tradeCtx } = createDeps({
      runtime,
      settleOrder: (_params) => {
        callSequence.push('settle');
        return {
          handled: true,
          relatedBuyOrderIds: ['BUY-1'],
        };
      },
      trackOrder: (params) => {
        callSequence.push('track');
        trackedOrders.push(params);
      },
    });
    const originalSubmitOrder = tradeCtx.submitOrder.bind(tradeCtx);
    tradeCtx.submitOrder = async (options) => {
      callSequence.push('submit');
      return originalSubmitOrder(options);
    };
    const routeProcessor = createRouteProcessor(deps);

    await routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'ORDER_EVENT',
      latestQuote: null,
    });

    expect(callSequence).toEqual(['settle', 'submit', 'track']);
    expect(tradeCtx.getCalls('cancelOrder')).toHaveLength(0);
    expect(trackedOrders).toHaveLength(1);
    expect(trackedOrders[0]?.orderId).toBe('MOCK-000001');
    expect(trackedOrders[0]?.orderType).toBe(OrderType.MO);
    expect(trackedOrders[0]?.quantity).toBe(100);
  });

  it('连续交易关闭时仍结算超时卖单终态，但不提交新的市价单', async () => {
    const runtime = createRuntimeStore();
    attachTrackedOrders(runtime, 'BULL.HK', [
      createTrackedOrder({
        orderId: 'SELL-CONVERT-CLOSED-CONTINUOUS-SESSION',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.Canceled,
        timeoutMarketConversionPending: true,
        timeoutMarketConversionTerminalState: {
          closedReason: 'CANCELED',
          source: 'WS',
          executedPrice: 0,
          executedQuantity: 0,
          executedTimeMs: Date.parse('2026-04-08T09:00:01.000Z'),
          orderUpdatedAtMs: Date.parse('2026-04-08T09:00:01.000Z'),
        },
      }),
    ]);
    const settlementOrderIds: string[] = [];
    const { deps, tradeCtx } = createDeps({
      runtime,
      isContinuousTradingAllowed: () => false,
      settleOrder: (params) => {
        settlementOrderIds.push(params.orderId);
        return {
          handled: true,
          relatedBuyOrderIds: ['BUY-1'],
        };
      },
      trackOrder: () => {},
    });

    await createRouteProcessor(deps).processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'ORDER_EVENT',
      latestQuote: null,
    });

    expect(settlementOrderIds).toEqual(['SELL-CONVERT-CLOSED-CONTINUOUS-SESSION']);
    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(0);
  });

  it('卖单 timeout 结算为无剩余量后，同轮仍允许后续订单基于 quote 继续 replace', async () => {
    const runtime = createRuntimeStore();
    attachTrackedOrders(runtime, 'BULL.HK', [
      createTrackedOrder({
        orderId: 'SELL-TIMEOUT-NO-REMAINDER',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.Canceled,
        submittedAt: Date.now() - 10_000,
        timeoutMarketConversionPending: true,
        timeoutMarketConversionTerminalState: {
          closedReason: 'CANCELED',
          source: 'WS',
          executedPrice: 0,
          executedQuantity: 100,
          executedTimeMs: Date.now(),
          orderUpdatedAtMs: Date.now(),
        },
        submittedQuantity: 100,
        executedQuantity: 0,
      }),
      createTrackedOrder({
        orderId: 'SELL-REPLACE-AFTER-NO-REMAINDER',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        submittedAt: Date.now() - 1_000,
        submittedPrice: 1,
        initialSubmittedPrice: 1,
        lastPriceUpdateAt: 0,
      }),
    ]);
    const replaceOrderIds: string[] = [];
    const { deps } = createDeps({
      runtime,
      config: createConfig({
        buyTimeoutMs: 60_000,
        sellTimeoutMs: 5_000,
      }),
      settleOrder: () => {
        runtime.trackedOrders.delete('SELL-TIMEOUT-NO-REMAINDER');
        runtime.trackedOrderLifecycles.set('SELL-TIMEOUT-NO-REMAINDER', 'CLOSED');
        runtime.closedOrderIds.add('SELL-TIMEOUT-NO-REMAINDER');
        runtime.trackedOrderIdsBySymbol.get('BULL.HK')?.delete('SELL-TIMEOUT-NO-REMAINDER');
        return {
          handled: true,
          relatedBuyOrderIds: null,
        };
      },
      replaceOrderPrice: async (orderId) => {
        replaceOrderIds.push(orderId);
      },
    });
    const routeProcessor = createRouteProcessor(deps);

    await routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'ORDER_EVENT',
      latestQuote: createQuoteDouble('BULL.HK', 1.02),
    });

    expect(replaceOrderIds).toEqual(['SELL-REPLACE-AFTER-NO-REMAINDER']);
  });

  it('单次 pass 最多只执行一个 broker mutation', async () => {
    const runtime = createRuntimeStore();
    attachTrackedOrders(runtime, 'BULL.HK', [
      createTrackedOrder({
        orderId: 'BUY-TIMEOUT-OLDER',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
        submittedAt: Date.parse('2026-04-08T08:59:00.000Z'),
      }),
      createTrackedOrder({
        orderId: 'BUY-TIMEOUT-NEWER',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
        submittedAt: Date.parse('2026-04-08T08:59:30.000Z'),
      }),
    ]);
    const cancelOrderIds: string[] = [];
    const { deps } = createDeps({
      runtime,
      cancelOrder: async (orderId) => {
        cancelOrderIds.push(orderId);
        return {
          kind: 'RETRYABLE_FAILURE',
          errorCode: 'NETWORK',
        };
      },
    });
    const routeProcessor = createRouteProcessor(deps);

    await routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'TIMER',
      latestQuote: null,
    });

    expect(cancelOrderIds).toEqual(['BUY-TIMEOUT-OLDER']);
  });

  it('同一订单同时满足 timeout 与 replace 时优先走 timeout', async () => {
    const runtime = createRuntimeStore();
    attachTrackedOrders(runtime, 'BULL.HK', [
      createTrackedOrder({
        orderId: 'BUY-TIMEOUT-AND-REPLACE',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
        submittedPrice: 1,
        initialSubmittedPrice: 1,
        lastPriceUpdateAt: 0,
      }),
    ]);
    const cancelOrderIds: string[] = [];
    const replaceOrderIds: string[] = [];
    const { deps } = createDeps({
      runtime,
      cancelOrder: async (orderId) => {
        cancelOrderIds.push(orderId);
        return {
          kind: 'RETRYABLE_FAILURE',
          errorCode: 'NETWORK',
        };
      },
      replaceOrderPrice: async (orderId) => {
        replaceOrderIds.push(orderId);
      },
    });
    const routeProcessor = createRouteProcessor(deps);

    await routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'QUOTE',
      latestQuote: createQuoteDouble('BULL.HK', 1.02),
    });

    expect(cancelOrderIds).toEqual(['BUY-TIMEOUT-AND-REPLACE']);
    expect(replaceOrderIds).toEqual([]);
  });

  it('前序 timeout 订单处于 WAIT_WS_ONLY 时不会饿死后续可改价订单', async () => {
    const runtime = createRuntimeStore();
    attachTrackedOrders(runtime, 'BULL.HK', [
      createTrackedOrder({
        orderId: 'BUY-WAIT-WS-ONLY',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
        nextCancelAttemptAt: ORDER_MONITOR_WAIT_WS_ONLY_BLOCK_UNTIL_MS,
        submittedAt: Date.now() - 10_000,
      }),
      createTrackedOrder({
        orderId: 'SELL-REPLACE-AFTER-WAIT-WS',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        submittedAt: Date.now() - 5_000,
        submittedPrice: 1,
        initialSubmittedPrice: 1,
        lastPriceUpdateAt: 0,
      }),
    ]);
    const replaceOrderIds: string[] = [];
    const { deps } = createDeps({
      runtime,
      config: createConfig({
        buyTimeoutMs: 0,
        sellTimeoutMs: 60_000,
      }),
      replaceOrderPrice: async (orderId) => {
        replaceOrderIds.push(orderId);
      },
    });
    const routeProcessor = createRouteProcessor(deps);

    await routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'QUOTE',
      latestQuote: createQuoteDouble('BULL.HK', 1.02),
    });

    expect(replaceOrderIds).toEqual(['SELL-REPLACE-AFTER-WAIT-WS']);
  });

  it('超时转出的 MO 新订单不会再次进入 timeout 路径', async () => {
    const runtime = createRuntimeStore();
    attachTrackedOrders(runtime, 'BULL.HK', [
      createTrackedOrder({
        orderId: 'SELL-CONVERT-MO-SKIP-TIMEOUT',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        timeoutMarketConversionPending: true,
        timeoutMarketConversionTerminalState: {
          closedReason: 'CANCELED',
          source: 'WS',
          executedPrice: 0,
          executedQuantity: 0,
          executedTimeMs: Date.now(),
          orderUpdatedAtMs: Date.now(),
        },
      }),
    ]);
    const trackedOrders: TrackOrderParams[] = [];
    const cancelOrderIds: string[] = [];
    const { deps, tradeCtx } = createDeps({
      runtime,
      settleOrder: () => ({
        handled: true,
        relatedBuyOrderIds: ['BUY-1'],
      }),
      trackOrder: (params) => {
        trackedOrders.push(params);
      },
      cancelOrder: async (orderId) => {
        cancelOrderIds.push(orderId);
        return {
          kind: 'CANCEL_CONFIRMED',
          relatedBuyOrderIds: null,
        };
      },
    });
    const originalSubmitOrder = tradeCtx.submitOrder.bind(tradeCtx);
    tradeCtx.submitOrder = async (options) => originalSubmitOrder(options);
    const routeProcessor = createRouteProcessor(deps);

    await routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'ORDER_EVENT',
      latestQuote: null,
    });

    expect(trackedOrders).toHaveLength(1);
    const convertedOrder = createTrackedOrder({
      orderId: 'MOCK-000001',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      orderType: OrderType.MO,
      submittedPrice: null,
      initialSubmittedPrice: null,
      submittedAt: Date.now() - 10_000,
    });
    attachTrackedOrders(runtime, 'BULL.HK', [convertedOrder]);

    await routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'TIMER',
      latestQuote: null,
    });

    expect(cancelOrderIds).toEqual([]);
    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(1);
  });

  it('卖单等待阶段遇到非法终态快照时会阻断本轮后续动作', async () => {
    const runtime = createRuntimeStore();
    const invalidTerminalState = {
      closedReason: 'UNKNOWN',
      source: 'WS',
      executedPrice: null,
      executedQuantity: null,
      executedTimeMs: null,
    } as unknown as NonNullable<OrderMonitorTrackedOrder['timeoutMarketConversionTerminalState']>;
    attachTrackedOrders(runtime, 'BULL.HK', [
      createTrackedOrder({
        orderId: 'SELL-PENDING-INVALID-TERMINAL',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        submittedAt: Date.now() - 10_000,
        timeoutMarketConversionPending: true,
        timeoutMarketConversionTerminalState: invalidTerminalState,
      }),
      createTrackedOrder({
        orderId: 'SELL-SHOULD-NOT-REPLACE-AFTER-INVALID-TERMINAL',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        submittedAt: Date.now() - 1_000,
        submittedPrice: 1,
        initialSubmittedPrice: 1,
        lastPriceUpdateAt: 0,
      }),
    ]);
    const replaceOrderIds: string[] = [];
    const { deps } = createDeps({
      runtime,
      config: createConfig({
        buyTimeoutMs: 60_000,
        sellTimeoutMs: 5_000,
      }),
      replaceOrderPrice: async (orderId) => {
        replaceOrderIds.push(orderId);
      },
    });
    const routeProcessor = createRouteProcessor(deps);

    await routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'QUOTE',
      latestQuote: createQuoteDouble('BULL.HK', 1.02),
    });

    expect(replaceOrderIds).toEqual([]);
    expect(runtime.trackedOrders.get('SELL-PENDING-INVALID-TERMINAL')?.cancelRetryCount).toBe(1);
  });

  it('卖单 timeout 在剩余数量不明确时会保留 timeout conversion owner 并继续等待或重试', async () => {
    const runtime = createRuntimeStore();
    attachTrackedOrders(runtime, 'BULL.HK', [
      createTrackedOrder({
        orderId: 'SELL-PENDING-UNKNOWN-REMAINING',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.Canceled,
        submittedAt: Date.now() - 10_000,
        timeoutMarketConversionPending: true,
        timeoutMarketConversionTerminalState: {
          closedReason: 'CANCELED',
          source: 'WS',
          executedPrice: 0,
          executedQuantity: null,
          executedTimeMs: Date.now(),
          orderUpdatedAtMs: Date.now(),
        },
      }),
    ]);
    const trackedOrder = runtime.trackedOrders.get('SELL-PENDING-UNKNOWN-REMAINING');
    if (!trackedOrder) {
      throw new Error('missing tracked order for timeout remaining test');
    }

    trackedOrder.cancelRetryCount = 3;
    trackedOrder.nextCancelAttemptAt = Date.now() - 1;

    const { deps, tradeCtx } = createDeps({
      runtime,
      settleOrder: () => ({
        handled: true,
        relatedBuyOrderIds: ['BUY-1'],
      }),
      trackOrder: (_params) => {
        throw new Error('should not submit market order when remaining quantity is unknown');
      },
    });
    const routeProcessor = createRouteProcessor(deps);

    await routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'ORDER_EVENT',
      latestQuote: null,
    });

    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(0);
    expect(trackedOrder.timeoutMarketConversionPending).toBe(true);
    expect(trackedOrder.timeoutMarketConversionTerminalState).not.toBeNull();
    expect(trackedOrder.cancelRetryCount).toBeGreaterThanOrEqual(3);
  });

  it('卖单 timeout 转市价在 broker submit 返回前保持 related buy orders 占用连续', async () => {
    const { runtime, storage, orderRecorder, settlementFlow } =
      createTimeoutSellHandoffHarness('SELL-TIMEOUT-CONTINUOUS');
    const tradeCtx = createTradeContextMock();
    const submitStarted = createDeferredValue<null>();
    const submitFinished = createDeferredValue<null>();
    const originalSubmitOrder = tradeCtx.submitOrder.bind(tradeCtx);
    tradeCtx.submitOrder = async (options) => {
      submitStarted.resolve(null);
      await submitFinished.promise;
      return originalSubmitOrder(options);
    };
    const trackedOrders: TrackOrderParams[] = [];
    const { deps } = createDeps({
      runtime,
      orderRecorder,
      settleOrder: settlementFlow.settleOrder,
      ctx: createTradeContextDouble(tradeCtx),
      trackOrder: (params) => {
        trackedOrders.push(params);
      },
    });
    const routeProcessor = createRouteProcessor(deps);

    const processPromise = routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'ORDER_EVENT',
      latestQuote: null,
    });

    await submitStarted.promise;

    const inFlightSellableOrders = storage.selectSellableOrders({
      symbol: 'BULL.HK',
      direction: 'LONG',
      strategy: 'ALL',
      currentPrice: 1.2,
    });
    expect(inFlightSellableOrders.orders).toEqual([]);
    expect(inFlightSellableOrders.totalQuantity).toBe(0);
    expect(storage.getPendingSellSnapshot().map((pendingSell) => pendingSell.orderId)).toEqual([
      'SELL-TIMEOUT-CONTINUOUS',
    ]);

    submitFinished.resolve(null);
    await processPromise;

    const pendingSellSnapshot = storage.getPendingSellSnapshot();
    expect(pendingSellSnapshot).toHaveLength(1);
    expect(pendingSellSnapshot[0]).toMatchObject({
      orderId: 'MOCK-000001',
      submittedQuantity: 200,
      relatedBuyOrderIds: ['BUY-1', 'BUY-2'],
    });
    expect(trackedOrders).toHaveLength(1);
  });

  it('卖单 timeout 转市价在 submitOrder 已发起后 reject 时保留 follow-up placeholder', async () => {
    const { runtime, storage, orderRecorder, settlementFlow } = createTimeoutSellHandoffHarness(
      'SELL-TIMEOUT-SUBMIT-RESULT-UNKNOWN',
    );
    const tradeCtx = createTradeContextMock();
    const submitStarted = createDeferredValue<null>();
    const submitResult = createDeferredValue<Awaited<ReturnType<typeof tradeCtx.submitOrder>>>();
    tradeCtx.submitOrder = async () => {
      submitStarted.resolve(null);
      return submitResult.promise;
    };
    const trackedOrders: TrackOrderParams[] = [];
    const { deps } = createDeps({
      runtime,
      orderRecorder,
      settleOrder: settlementFlow.settleOrder,
      ctx: createTradeContextDouble(tradeCtx),
      trackOrder: (params) => {
        trackedOrders.push(params);
      },
    });

    const processPromise = createRouteProcessor(deps).processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'ORDER_EVENT',
      latestQuote: null,
    });
    await submitStarted.promise;
    submitResult.reject(new Error('network unavailable after request'));

    let receivedError: unknown = null;
    try {
      await processPromise;
    } catch (error) {
      receivedError = error;
    }

    expect(receivedError).toMatchObject({
      name: 'ExternalApiRequestError',
      operation: 'TradeContext.submitOrder.timeoutMarketConversion',
    });

    expect(storage.getPendingSellSnapshot().map((pendingSell) => pendingSell.orderId)).toEqual([
      'SELL-TIMEOUT-SUBMIT-RESULT-UNKNOWN',
    ]);
    const sellableOrders = storage.selectSellableOrders({
      symbol: 'BULL.HK',
      direction: 'LONG',
      strategy: 'ALL',
      currentPrice: 1.2,
    });
    expect(sellableOrders.orders).toEqual([]);
    expect(sellableOrders.totalQuantity).toBe(0);
    expect(trackedOrders).toEqual([]);
  });

  it('卖单 timeout 转市价在 mutation permit 抛错时释放 follow-up placeholder', async () => {
    const { runtime, storage, orderRecorder, settlementFlow } = createTimeoutSellHandoffHarness(
      'SELL-TIMEOUT-RATE-LIMITER-FAIL',
    );
    const trackedOrders: TrackOrderParams[] = [];
    const { deps, tradeCtx } = createDeps({
      runtime,
      orderRecorder,
      settleOrder: settlementFlow.settleOrder,
      rateLimiter: {
        throttle: async () => {},
        withTradeMutation: async <T>(
          _callback: (permit: TradeMutationPermit) => Promise<T>,
        ): Promise<T> => {
          throw new Error('rate limiter failed before broker accept');
        },
      },
      trackOrder: (params) => {
        trackedOrders.push(params);
      },
    });

    const errorMessage = await captureTimeoutMarketRouteError(deps);
    expect(errorMessage).toContain('rate limiter failed before broker accept');
    expectTimeoutSellOccupancyReleased(storage);
    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(0);
    expect(trackedOrders).toEqual([]);
  });

  it('卖单 timeout 转市价在取得 mutation permit 后 route generation 失效时释放 follow-up placeholder 且不调用 SDK', async () => {
    const { runtime, storage, orderRecorder, settlementFlow } = createTimeoutSellHandoffHarness(
      'SELL-TIMEOUT-ROUTE-STALE-BEFORE-SUBMIT',
    );
    const { deps, tradeCtx } = createDeps({
      runtime,
      orderRecorder,
      settleOrder: settlementFlow.settleOrder,
      rateLimiter: {
        throttle: async () => {},
        withTradeMutation: async <T>(
          callback: (permit: TradeMutationPermit) => Promise<T>,
        ): Promise<T> => {
          runtime.latestRouteGenerationBySymbol.set('BULL.HK', 2);
          return callback({
            invoke: async <TResult>(operation: () => Promise<TResult>): Promise<TResult> =>
              operation(),
          });
        },
      },
      trackOrder: () => {},
    });

    const errorMessage = await captureTimeoutMarketRouteError(deps);

    expect(errorMessage).toBe('');
    expectTimeoutSellOccupancyReleased(storage);
    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(0);
  });

  it('卖单 timeout 转市价在取得 mutation permit 后连续交易关闭时释放 follow-up placeholder 且不调用 SDK', async () => {
    const { runtime, storage, orderRecorder, settlementFlow } = createTimeoutSellHandoffHarness(
      'SELL-TIMEOUT-CONTINUOUS-CLOSED-BEFORE-SUBMIT',
    );
    let isContinuousTradingAllowed = true;
    const { deps, tradeCtx } = createDeps({
      runtime,
      orderRecorder,
      settleOrder: settlementFlow.settleOrder,
      rateLimiter: {
        throttle: async () => {},
        withTradeMutation: async <T>(
          callback: (permit: TradeMutationPermit) => Promise<T>,
        ): Promise<T> => {
          isContinuousTradingAllowed = false;
          return callback({
            invoke: async <TResult>(operation: () => Promise<TResult>): Promise<TResult> =>
              operation(),
          });
        },
      },
      isContinuousTradingAllowed: () => isContinuousTradingAllowed,
      trackOrder: () => {},
    });

    const errorMessage = await captureTimeoutMarketRouteError(deps);

    expect(errorMessage).toBe('');
    expectTimeoutSellOccupancyReleased(storage);
    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(0);
  });

  it('卖单 timeout 转市价在 broker 已接受后即使 runtime 停止也承认远端订单事实', async () => {
    const { runtime, storage, orderRecorder, settlementFlow } = createTimeoutSellHandoffHarness(
      'SELL-TIMEOUT-STOPPED-AFTER-SUBMIT',
    );
    const tradeCtx = createTradeContextMock();
    const submitStarted = createDeferredValue<null>();
    const submitFinished = createDeferredValue<null>();
    const trackedOrders: TrackOrderParams[] = [];
    const originalSubmitOrder = tradeCtx.submitOrder.bind(tradeCtx);
    tradeCtx.submitOrder = async (options) => {
      submitStarted.resolve(null);
      await submitFinished.promise;
      return originalSubmitOrder(options);
    };
    const { deps } = createDeps({
      runtime,
      orderRecorder,
      settleOrder: settlementFlow.settleOrder,
      ctx: createTradeContextDouble(tradeCtx),
      trackOrder: (params) => {
        trackedOrders.push(params);
      },
    });
    const routeProcessor = createRouteProcessor(deps);

    const processPromise = routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'ORDER_EVENT',
      latestQuote: null,
    });

    await submitStarted.promise;
    runtime.running = false;
    runtime.runtimeState = 'STOPPED';
    submitFinished.resolve(null);

    await processPromise;
    expect(trackedOrders.map((trackedOrder) => trackedOrder.orderId)).toEqual(['MOCK-000001']);
    expect(storage.getPendingSellSnapshot().map((pendingSell) => pendingSell.orderId)).toEqual([
      'MOCK-000001',
    ]);
  });

  it('卖单 timeout 转市价在 broker 已接受后即使 route generation 变化也承认远端订单事实', async () => {
    const { runtime, storage, orderRecorder, settlementFlow } = createTimeoutSellHandoffHarness(
      'SELL-TIMEOUT-GENERATION-CHANGED',
    );
    const tradeCtx = createTradeContextMock();
    const submitStarted = createDeferredValue<null>();
    const submitFinished = createDeferredValue<null>();
    const trackedOrders: TrackOrderParams[] = [];
    const originalSubmitOrder = tradeCtx.submitOrder.bind(tradeCtx);
    tradeCtx.submitOrder = async (options) => {
      submitStarted.resolve(null);
      await submitFinished.promise;
      return originalSubmitOrder(options);
    };
    const { deps } = createDeps({
      runtime,
      orderRecorder,
      settleOrder: settlementFlow.settleOrder,
      ctx: createTradeContextDouble(tradeCtx),
      trackOrder: (params) => {
        trackedOrders.push(params);
      },
    });
    const routeProcessor = createRouteProcessor(deps);

    const processPromise = routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'ORDER_EVENT',
      latestQuote: null,
    });

    await submitStarted.promise;
    const routeState = runtime.routeStatesBySymbol.get('BULL.HK');
    if (routeState) {
      routeState.generation = 2;
    }

    runtime.latestRouteGenerationBySymbol.set('BULL.HK', 2);
    submitFinished.resolve(null);

    await processPromise;
    expect(trackedOrders.map((trackedOrder) => trackedOrder.orderId)).toEqual(['MOCK-000001']);
    expect(storage.getPendingSellSnapshot().map((pendingSell) => pendingSell.orderId)).toEqual([
      'MOCK-000001',
    ]);
  });

  it('broker ack 后 trackOrder 抛错仍保留旧 placeholder 且错误携带 newOrderId', async () => {
    const { runtime, storage, orderRecorder, settlementFlow } =
      createTimeoutSellHandoffHarness('SELL-TIMEOUT-TRACK-FAIL');
    const trackAttempts: string[] = [];
    const { deps } = createDeps({
      runtime,
      orderRecorder,
      settleOrder: settlementFlow.settleOrder,
      trackOrder: (params) => {
        trackAttempts.push(params.orderId);
        throw new Error('track local fact failed');
      },
    });

    const errorMessage = await captureTimeoutMarketRouteError(deps);

    expect(trackAttempts).toEqual(['MOCK-000001']);
    expect(errorMessage).toContain('order submitted but local sync failed: MOCK-000001');
    expect(storage.getPendingSellSnapshot().map((pendingSell) => pendingSell.orderId)).toEqual([
      'SELL-TIMEOUT-TRACK-FAIL',
    ]);
  });

  it('ORDER_EVENT 唤醒会基于 latestQuote 继续推进 replace', async () => {
    const runtime = createRuntimeStore();
    attachTrackedOrders(runtime, 'BULL.HK', [
      createTrackedOrder({
        orderId: 'SELL-ORDER-EVENT-REPLACE',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        submittedAt: Date.now() - 1_000,
        submittedPrice: 1,
        initialSubmittedPrice: 1,
        lastPriceUpdateAt: 0,
      }),
    ]);
    const replaceOrderIds: string[] = [];
    const { deps } = createDeps({
      runtime,
      config: createConfig({
        buyTimeoutMs: 60_000,
        sellTimeoutMs: 60_000,
      }),
      replaceOrderPrice: async (orderId) => {
        replaceOrderIds.push(orderId);
      },
    });
    const routeProcessor = createRouteProcessor(deps);

    await routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'ORDER_EVENT',
      latestQuote: createQuoteDouble('BULL.HK', 1.02),
    });

    expect(replaceOrderIds).toEqual(['SELL-ORDER-EVENT-REPLACE']);
  });

  it('TRACKED 唤醒即使带有 latestQuote 也不会触发普通 replace', async () => {
    const runtime = createRuntimeStore();
    attachTrackedOrders(runtime, 'BULL.HK', [
      createTrackedOrder({
        orderId: 'SELL-TRACKED-NO-REPLACE',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        submittedAt: Date.now() - 1_000,
        submittedPrice: 1,
        initialSubmittedPrice: 1,
        lastPriceUpdateAt: 0,
      }),
    ]);
    const replaceOrderIds: string[] = [];
    const { deps } = createDeps({
      runtime,
      config: createConfig({
        buyTimeoutMs: 60_000,
        sellTimeoutMs: 60_000,
      }),
      replaceOrderPrice: async (orderId) => {
        replaceOrderIds.push(orderId);
      },
    });
    const routeProcessor = createRouteProcessor(deps);

    await routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'TRACKED',
      latestQuote: createQuoteDouble('BULL.HK', 1.02),
    });

    expect(replaceOrderIds).toEqual([]);
  });

  it('TIMER 唤醒会在 replace backoff 到期后基于缓存 latestQuote 补跑 replace', async () => {
    const runtime = createRuntimeStore();
    attachTrackedOrders(runtime, 'BULL.HK', [
      createTrackedOrder({
        orderId: 'SELL-REPLACE-RETRY-TIMER',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        submittedAt: Date.now() - 1_000,
        submittedPrice: 1,
        initialSubmittedPrice: 1,
        lastPriceUpdateAt: 0,
        replaceCapability: 'TEMP_BLOCKED_BY_STATUS',
        replaceBlockedUntilAt: Date.now() - 1,
        replaceResumeMode: 'TIME_BACKOFF',
        replaceTempBlockedCount: 1,
      }),
    ]);
    const replaceOrderIds: string[] = [];
    const { deps } = createDeps({
      runtime,
      config: createConfig({
        buyTimeoutMs: 60_000,
        sellTimeoutMs: 60_000,
      }),
      replaceOrderPrice: async (orderId) => {
        replaceOrderIds.push(orderId);
      },
    });
    const routeProcessor = createRouteProcessor(deps);

    await routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'TIMER',
      latestQuote: createQuoteDouble('BULL.HK', 1.02),
    });

    expect(replaceOrderIds).toEqual(['SELL-REPLACE-RETRY-TIMER']);
  });

  it('QUOTE 唤醒遇到不可用行情时会推进 quote retry 状态', async () => {
    const originalNow = Date.now;
    const nowMs = Date.parse('2026-04-09T10:00:00.000Z');
    Date.now = () => nowMs - 86_400_000;

    try {
      const runtime = createRuntimeStore();
      attachTrackedOrders(runtime, 'BULL.HK', [
        createTrackedOrder({
          orderId: 'SELL-QUOTE-RETRY-STATE',
          symbol: 'BULL.HK',
          side: OrderSide.Sell,
          submittedAt: nowMs - 1_000,
          submittedPrice: 1,
          initialSubmittedPrice: 1,
          lastPriceUpdateAt: 0,
          quoteRetryAttempts: 0,
          quoteRetryNextAt: null,
          quoteRetryExhausted: false,
        }),
      ]);
      const replaceOrderIds: string[] = [];
      const { deps } = createDeps({
        runtime,
        now: () => new Date(nowMs),
        config: createConfig({
          buyTimeoutMs: 60_000,
          sellTimeoutMs: 60_000,
        }),
        replaceOrderPrice: async (orderId) => {
          replaceOrderIds.push(orderId);
        },
      });
      const routeProcessor = createRouteProcessor(deps);

      await routeProcessor.processRoute({
        symbol: 'BULL.HK',
        generation: 1,
        wakeupKind: 'QUOTE',
        latestQuote: null,
      });

      expect(replaceOrderIds).toEqual([]);
      const order = runtime.trackedOrders.get('SELL-QUOTE-RETRY-STATE');
      expect(order?.quoteRetryAttempts).toBe(1);
      expect(order?.quoteRetryNextAt).toBe(nowMs + ORDER_QUOTE_RETRY.INTERVAL_MS);
      expect(order?.quoteRetryExhausted).toBe(false);
    } finally {
      Date.now = originalNow;
    }
  });

  it('QUOTE 唤醒遇到无效价格时不会推进 quote retry 状态', async () => {
    const originalNow = Date.now;
    const nowMs = Date.parse('2026-04-09T10:02:00.000Z');
    Date.now = () => nowMs;

    try {
      const runtime = createRuntimeStore();
      attachTrackedOrders(runtime, 'BULL.HK', [
        createTrackedOrder({
          orderId: 'SELL-INVALID-QUOTE-NO-RETRY',
          symbol: 'BULL.HK',
          side: OrderSide.Sell,
          submittedAt: nowMs - 1_000,
          submittedPrice: 1,
          initialSubmittedPrice: 1,
          lastPriceUpdateAt: 0,
          quoteRetryAttempts: 0,
          quoteRetryNextAt: null,
          quoteRetryExhausted: false,
        }),
      ]);
      const replaceOrderIds: string[] = [];
      const { deps } = createDeps({
        runtime,
        config: createConfig({
          buyTimeoutMs: 60_000,
          sellTimeoutMs: 60_000,
        }),
        replaceOrderPrice: async (orderId) => {
          replaceOrderIds.push(orderId);
        },
      });
      const routeProcessor = createRouteProcessor(deps);

      await routeProcessor.processRoute({
        symbol: 'BULL.HK',
        generation: 1,
        wakeupKind: 'QUOTE',
        latestQuote: createQuoteDouble('BULL.HK', 0),
      });

      expect(replaceOrderIds).toEqual([]);
      const order = runtime.trackedOrders.get('SELL-INVALID-QUOTE-NO-RETRY');
      expect(order?.quoteRetryAttempts).toBe(0);
      expect(order?.quoteRetryNextAt).toBeNull();
      expect(order?.quoteRetryExhausted).toBe(false);
    } finally {
      Date.now = originalNow;
    }
  });

  it('TIMER 唤醒会在 quote retry 到期后继续推进 quote retry 状态', async () => {
    const originalNow = Date.now;
    const nowMs = Date.parse('2026-04-09T10:05:00.000Z');
    Date.now = () => nowMs;

    try {
      const runtime = createRuntimeStore();
      attachTrackedOrders(runtime, 'BULL.HK', [
        createTrackedOrder({
          orderId: 'SELL-QUOTE-RETRY-TIMER',
          symbol: 'BULL.HK',
          side: OrderSide.Sell,
          submittedAt: nowMs - 1_000,
          submittedPrice: 1,
          initialSubmittedPrice: 1,
          lastPriceUpdateAt: 0,
          quoteRetryAttempts: 1,
          quoteRetryNextAt: nowMs - 1,
          quoteRetryExhausted: false,
        }),
      ]);
      const replaceOrderIds: string[] = [];
      const { deps } = createDeps({
        runtime,
        config: createConfig({
          buyTimeoutMs: 60_000,
          sellTimeoutMs: 60_000,
        }),
        replaceOrderPrice: async (orderId) => {
          replaceOrderIds.push(orderId);
        },
      });
      const routeProcessor = createRouteProcessor(deps);

      await routeProcessor.processRoute({
        symbol: 'BULL.HK',
        generation: 1,
        wakeupKind: 'TIMER',
        latestQuote: null,
      });

      expect(replaceOrderIds).toEqual([]);
      const order = runtime.trackedOrders.get('SELL-QUOTE-RETRY-TIMER');
      expect(order?.quoteRetryAttempts).toBe(2);
      expect(order?.quoteRetryNextAt).toBe(nowMs + ORDER_QUOTE_RETRY.INTERVAL_MS);
      expect(order?.quoteRetryExhausted).toBe(false);
    } finally {
      Date.now = originalNow;
    }
  });

  it('QUOTE 唤醒拿到有效行情后会清空 quote retry 状态并继续 replace', async () => {
    const originalNow = Date.now;
    const nowMs = Date.parse('2026-04-09T10:08:00.000Z');
    Date.now = () => nowMs;

    try {
      const runtime = createRuntimeStore();
      attachTrackedOrders(runtime, 'BULL.HK', [
        createTrackedOrder({
          orderId: 'SELL-QUOTE-RETRY-RESET',
          symbol: 'BULL.HK',
          side: OrderSide.Sell,
          submittedAt: nowMs - 1_000,
          submittedPrice: 1,
          initialSubmittedPrice: 1,
          lastPriceUpdateAt: 0,
          quoteRetryAttempts: 2,
          quoteRetryNextAt: nowMs + ORDER_QUOTE_RETRY.INTERVAL_MS,
          quoteRetryExhausted: false,
        }),
      ]);
      const replaceOrderIds: string[] = [];
      const { deps } = createDeps({
        runtime,
        config: createConfig({
          buyTimeoutMs: 60_000,
          sellTimeoutMs: 60_000,
        }),
        replaceOrderPrice: async (orderId) => {
          replaceOrderIds.push(orderId);
        },
      });
      const routeProcessor = createRouteProcessor(deps);

      await routeProcessor.processRoute({
        symbol: 'BULL.HK',
        generation: 1,
        wakeupKind: 'QUOTE',
        latestQuote: createQuoteDouble('BULL.HK', 1.02),
      });

      expect(replaceOrderIds).toEqual(['SELL-QUOTE-RETRY-RESET']);
      const order = runtime.trackedOrders.get('SELL-QUOTE-RETRY-RESET');
      expect(order?.quoteRetryAttempts).toBe(0);
      expect(order?.quoteRetryNextAt).toBeNull();
      expect(order?.quoteRetryExhausted).toBe(false);
    } finally {
      Date.now = originalNow;
    }
  });

  it('有效 quote 即使因 guard 未触发 replace 也会清空 quote retry 状态', async () => {
    const originalNow = Date.now;
    const nowMs = Date.parse('2026-04-09T10:09:00.000Z');
    Date.now = () => nowMs;

    try {
      const runtime = createRuntimeStore();
      attachTrackedOrders(runtime, 'BULL.HK', [
        createTrackedOrder({
          orderId: 'BUY-QUOTE-RETRY-GUARD-RESET',
          symbol: 'BULL.HK',
          side: OrderSide.Buy,
          submittedAt: nowMs - 1_000,
          submittedPrice: 1,
          initialSubmittedPrice: 1,
          lastPriceUpdateAt: 0,
          quoteRetryAttempts: 2,
          quoteRetryNextAt: nowMs + ORDER_QUOTE_RETRY.INTERVAL_MS,
          quoteRetryExhausted: false,
        }),
      ]);
      const replaceOrderIds: string[] = [];
      const { deps } = createDeps({
        runtime,
        config: createConfig({
          buyTimeoutMs: 60_000,
          sellTimeoutMs: 60_000,
          allowBuyOrderTrackingAboveInitialPrice: false,
        }),
        replaceOrderPrice: async (orderId) => {
          replaceOrderIds.push(orderId);
        },
      });
      const routeProcessor = createRouteProcessor(deps);

      await routeProcessor.processRoute({
        symbol: 'BULL.HK',
        generation: 1,
        wakeupKind: 'QUOTE',
        latestQuote: createQuoteDouble('BULL.HK', 1.02),
      });

      expect(replaceOrderIds).toEqual([]);
      const order = runtime.trackedOrders.get('BUY-QUOTE-RETRY-GUARD-RESET');
      expect(order?.quoteRetryAttempts).toBe(0);
      expect(order?.quoteRetryNextAt).toBeNull();
      expect(order?.quoteRetryExhausted).toBe(false);
    } finally {
      Date.now = originalNow;
    }
  });

  it('replace await 内确认 terminal 后订单脱离 route 时保留 evidence，重建后只结算一次', async () => {
    const runtime = createRuntimeStore();
    const trackedOrder = createTrackedOrder({
      orderId: 'SELL-REPLACE-TERMINAL-DETACHED',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      submittedAt: Date.now() - 1_000,
      submittedPrice: 1,
      initialSubmittedPrice: 1,
      lastPriceUpdateAt: 0,
    });
    attachTrackedOrders(runtime, 'BULL.HK', [trackedOrder]);
    const rawTerminal = {
      kind: 'TERMINAL' as const,
      closedReason: 'CANCELED' as const,
      executedPrice: null,
      executedQuantity: 0,
      submittedQuantity: 100,
      orderUpdatedAtMs: Date.now(),
      status: OrderStatus.Canceled,
    };
    const terminalOutcome: TerminalStateSnapshot = rawTerminal;
    const replaceStateWritten = createDeferredValue<null>();
    const allowReplaceToFinish = createDeferredValue<null>();
    const settlementOrderIds: string[] = [];
    let replaceAttempts = 0;
    const { deps } = createDeps({
      runtime,
      config: createConfig({ buyTimeoutMs: 60_000, sellTimeoutMs: 60_000 }),
      replaceOrderPrice: async (orderId) => {
        replaceAttempts += 1;
        if (replaceAttempts !== 1) {
          return;
        }

        runtime.queriedTerminalStateByOrderId.set(orderId, rawTerminal);
        setLatestReplaceTerminal(runtime, orderId, terminalOutcome);
        replaceStateWritten.resolve(null);
        await allowReplaceToFinish.promise;
      },
      settleOrder: (params) => {
        settlementOrderIds.push(params.orderId);
        return { handled: true, relatedBuyOrderIds: null };
      },
    });
    const routeProcessor = createRouteProcessor(deps);

    const processPromise = routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'QUOTE',
      latestQuote: createQuoteDouble('BULL.HK', 1.02),
    });
    await replaceStateWritten.promise;
    runtime.closedOrderIds.add(trackedOrder.orderId);
    allowReplaceToFinish.resolve(null);
    await processPromise;

    expect(settlementOrderIds).toEqual([]);
    expect(runtime.latestReplaceTerminalByOrderId.get(trackedOrder.orderId)).toBe(terminalOutcome);
    expect(runtime.queriedTerminalStateByOrderId.get(trackedOrder.orderId)).toBe(rawTerminal);

    runtime.closedOrderIds.delete(trackedOrder.orderId);
    await routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'ORDER_EVENT',
      latestQuote: createQuoteDouble('BULL.HK', 1.02),
    });

    expect(settlementOrderIds).toEqual([trackedOrder.orderId]);
    expect(runtime.latestReplaceTerminalByOrderId.has(trackedOrder.orderId)).toBe(false);
    expect(runtime.queriedTerminalStateByOrderId.has(trackedOrder.orderId)).toBe(false);

    await routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'ORDER_EVENT',
      latestQuote: createQuoteDouble('BULL.HK', 1.02),
    });

    expect(settlementOrderIds).toEqual([trackedOrder.orderId]);
  });

  it('replace terminal 未被 gateway 处理时保留 identity-bound evidence', async () => {
    const runtime = createRuntimeStore();
    const trackedOrder = createTrackedOrder({
      orderId: 'SELL-REPLACE-TERMINAL-UNHANDLED',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      submittedAt: Date.now() - 1_000,
      submittedPrice: 1,
      initialSubmittedPrice: 1,
      lastPriceUpdateAt: 0,
    });
    attachTrackedOrders(runtime, 'BULL.HK', [trackedOrder]);
    const rawTerminal = {
      kind: 'TERMINAL' as const,
      closedReason: 'CANCELED' as const,
      executedPrice: null,
      executedQuantity: 0,
      submittedQuantity: 100,
      orderUpdatedAtMs: Date.now(),
      status: OrderStatus.Canceled,
    };
    const terminalOutcome: TerminalStateSnapshot = rawTerminal;
    const { deps } = createDeps({
      runtime,
      config: createConfig({ buyTimeoutMs: 60_000, sellTimeoutMs: 60_000 }),
      replaceOrderPrice: async (orderId) => {
        runtime.queriedTerminalStateByOrderId.set(orderId, rawTerminal);
        setLatestReplaceTerminal(runtime, orderId, terminalOutcome);
      },
      settleOrder: () => ({ handled: false, relatedBuyOrderIds: null }),
    });
    const routeProcessor = createRouteProcessor(deps);

    await routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'QUOTE',
      latestQuote: createQuoteDouble('BULL.HK', 1.02),
    });

    expect(runtime.latestReplaceTerminalByOrderId.get(trackedOrder.orderId)).toBe(terminalOutcome);
    expect(runtime.queriedTerminalStateByOrderId.get(trackedOrder.orderId)).toBe(rawTerminal);
  });

  it('replace 确认 TERMINAL_CONFIRMED 时会立即结算并消费 outcome', async () => {
    const runtime = createRuntimeStore();
    attachTrackedOrders(runtime, 'BULL.HK', [
      createTrackedOrder({
        orderId: 'SELL-REPLACE-TERMINAL',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        submittedAt: Date.now() - 1_000,
        submittedPrice: 1,
        initialSubmittedPrice: 1,
        lastPriceUpdateAt: 0,
      }),
    ]);
    const settlementCalls: Array<{ readonly orderId: string; readonly closedReason: string }> = [];
    const { deps } = createDeps({
      runtime,
      config: createConfig({
        buyTimeoutMs: 60_000,
        sellTimeoutMs: 60_000,
      }),
      replaceOrderPrice: async (orderId) => {
        const rawTerminal = {
          kind: 'TERMINAL' as const,
          closedReason: 'CANCELED' as const,
          executedPrice: null,
          executedQuantity: 0,
          submittedQuantity: 100,
          orderUpdatedAtMs: Date.now(),
          status: OrderStatus.Canceled,
        };
        runtime.queriedTerminalStateByOrderId.set(orderId, rawTerminal);
        setLatestReplaceTerminal(runtime, orderId, rawTerminal);
      },
      settleOrder: (params) => {
        settlementCalls.push({
          orderId: params.orderId,
          closedReason: params.closedReason,
        });
        return {
          handled: true,
          relatedBuyOrderIds: null,
        };
      },
    });
    const routeProcessor = createRouteProcessor(deps);

    await routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'QUOTE',
      latestQuote: createQuoteDouble('BULL.HK', 1.02),
    });

    expect(settlementCalls).toMatchObject([
      {
        orderId: 'SELL-REPLACE-TERMINAL',
        closedReason: 'CANCELED',
      },
    ]);
    expect(runtime.latestReplaceTerminalByOrderId.has('SELL-REPLACE-TERMINAL')).toBe(false);
  });

  it('replace 终态查询陈旧时使用 tracked 已知的更强成交事实结算', async () => {
    const runtime = createRuntimeStore();
    const trackedExecutedAtMs = Date.parse('2026-04-08T09:00:00.200Z');
    attachTrackedOrders(runtime, 'BULL.HK', [
      createTrackedOrder({
        orderId: 'SELL-REPLACE-STALE-TERMINAL',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        submittedAt: Date.now() - 1_000,
        lastPriceUpdateAt: 0,
        executedQuantity: 50,
        executedPrice: 1.05,
        lastExecutedTimeMs: trackedExecutedAtMs,
        lastOrderUpdateAtMs: trackedExecutedAtMs,
        status: OrderStatus.PartialFilled,
      }),
    ]);
    const settlementCalls: Array<
      Readonly<{
        executedPrice?: number | null;
        executedQuantity?: number | null;
        executedTimeMs?: number | null;
        orderUpdatedAtMs?: number | null;
      }>
    > = [];
    const { deps } = createDeps({
      runtime,
      config: createConfig({ buyTimeoutMs: 60_000, sellTimeoutMs: 60_000 }),
      replaceOrderPrice: async (orderId) => {
        const rawTerminal = {
          kind: 'TERMINAL' as const,
          closedReason: 'CANCELED' as const,
          executedPrice: 0.9,
          executedQuantity: 20,
          submittedQuantity: 100,
          orderUpdatedAtMs: trackedExecutedAtMs - 100,
          status: OrderStatus.Canceled,
        };
        runtime.queriedTerminalStateByOrderId.set(orderId, rawTerminal);
        setLatestReplaceTerminal(runtime, orderId, rawTerminal);
      },
      settleOrder: (params) => {
        settlementCalls.push(params);
        return { handled: true, relatedBuyOrderIds: null };
      },
    });

    await createRouteProcessor(deps).processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'QUOTE',
      latestQuote: createQuoteDouble('BULL.HK', 1.02),
    });

    expect(settlementCalls).toMatchObject([
      {
        executedPrice: 1.05,
        executedQuantity: 50,
        executedTimeMs: trackedExecutedAtMs,
        orderUpdatedAtMs: trackedExecutedAtMs,
      },
    ]);
  });

  it('replace 等量较新终态可修订成交价但不推进成交时间', async () => {
    const runtime = createRuntimeStore();
    const trackedExecutedAtMs = Date.parse('2026-04-08T09:00:00.100Z');
    const terminalRevisionAtMs = Date.parse('2026-04-08T09:00:00.200Z');
    attachTrackedOrders(runtime, 'BULL.HK', [
      createTrackedOrder({
        orderId: 'SELL-REPLACE-EQUAL-QTY-PRICE-REVISION',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        submittedAt: Date.now() - 1_000,
        lastPriceUpdateAt: 0,
        executedQuantity: 40,
        executedPrice: 1,
        lastExecutedTimeMs: trackedExecutedAtMs,
        lastOrderUpdateAtMs: trackedExecutedAtMs,
        status: OrderStatus.PartialFilled,
      }),
    ]);
    const settlementCalls: FinalizeOrderSettlementParams[] = [];
    const { deps } = createDeps({
      runtime,
      config: createConfig({ buyTimeoutMs: 60_000, sellTimeoutMs: 60_000 }),
      replaceOrderPrice: async (orderId) => {
        const rawTerminal = {
          kind: 'TERMINAL' as const,
          closedReason: 'CANCELED' as const,
          executedPrice: 1.1,
          executedQuantity: 40,
          submittedQuantity: 100,
          orderUpdatedAtMs: terminalRevisionAtMs,
          status: OrderStatus.Canceled,
        };
        runtime.queriedTerminalStateByOrderId.set(orderId, rawTerminal);
        setLatestReplaceTerminal(runtime, orderId, rawTerminal);
      },
      settleOrder: (params) => {
        settlementCalls.push(params);
        return { handled: true, relatedBuyOrderIds: null };
      },
    });

    await createRouteProcessor(deps).processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'QUOTE',
      latestQuote: createQuoteDouble('BULL.HK', 1.02),
    });

    expect(settlementCalls).toMatchObject([
      {
        executedPrice: 1.1,
        executedQuantity: 40,
        executedTimeMs: trackedExecutedAtMs,
        orderUpdatedAtMs: terminalRevisionAtMs,
      },
    ]);
  });

  it('replace 终态查询成交量更大但 revision 更旧时在结算前拒绝伪造事实', async () => {
    const runtime = createRuntimeStore();
    const trackedExecutedAtMs = Date.parse('2026-04-08T09:00:00.200Z');
    attachTrackedOrders(runtime, 'BULL.HK', [
      createTrackedOrder({
        orderId: 'SELL-REPLACE-NEW-QTY-OLD-REVISION',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        submittedAt: Date.now() - 1_000,
        lastPriceUpdateAt: 0,
        executedQuantity: 50,
        executedPrice: 1.05,
        lastExecutedTimeMs: trackedExecutedAtMs,
        lastOrderUpdateAtMs: trackedExecutedAtMs,
        status: OrderStatus.PartialFilled,
      }),
    ]);
    const settlementCalls: Array<
      Readonly<{
        executedPrice?: number | null;
        executedQuantity?: number | null;
        executedTimeMs?: number | null;
        orderUpdatedAtMs?: number | null;
      }>
    > = [];
    const { deps } = createDeps({
      runtime,
      config: createConfig({ buyTimeoutMs: 60_000, sellTimeoutMs: 60_000 }),
      replaceOrderPrice: async (orderId) => {
        const rawTerminal = {
          kind: 'TERMINAL' as const,
          closedReason: 'CANCELED' as const,
          executedPrice: 0.9,
          executedQuantity: 80,
          submittedQuantity: 100,
          orderUpdatedAtMs: trackedExecutedAtMs - 100,
          status: OrderStatus.Canceled,
        };
        runtime.queriedTerminalStateByOrderId.set(orderId, rawTerminal);
        setLatestReplaceTerminal(runtime, orderId, rawTerminal);
      },
      settleOrder: (params) => {
        settlementCalls.push(params);
        return { handled: true, relatedBuyOrderIds: null };
      },
    });

    let caughtError: unknown = null;
    try {
      await createRouteProcessor(deps).processRoute({
        symbol: 'BULL.HK',
        generation: 1,
        wakeupKind: 'QUOTE',
        latestQuote: createQuoteDouble('BULL.HK', 1.02),
      });
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toHaveProperty(
      'message',
      expect.stringMatching(/累计成交数量推进但原始执行时间倒退/),
    );
    expect(settlementCalls).toEqual([]);
    expect(runtime.closedOrderIds.has('SELL-REPLACE-NEW-QTY-OLD-REVISION')).toBe(false);
    expect(runtime.trackedOrders.get('SELL-REPLACE-NEW-QTY-OLD-REVISION')).toMatchObject({
      executedQuantity: 50,
      executedPrice: 1.05,
      lastExecutedTimeMs: trackedExecutedAtMs,
      lastOrderUpdateAtMs: trackedExecutedAtMs,
    });
  });

  it('买单 timeout 在 cancel 返回 ALREADY_CLOSED 时会立即结算', async () => {
    const runtime = createRuntimeStore();
    attachTrackedOrders(runtime, 'BULL.HK', [
      createTrackedOrder({
        orderId: 'BUY-TIMEOUT-ALREADY-CLOSED',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
      }),
    ]);

    runtime.queriedTerminalStateByOrderId.set('BUY-TIMEOUT-ALREADY-CLOSED', {
      kind: 'TERMINAL',
      closedReason: 'CANCELED',
      executedPrice: null,
      executedQuantity: 0,
      submittedQuantity: 100,
      orderUpdatedAtMs: Date.now(),
      status: OrderStatus.Canceled,
    });
    const settlementCalls: Array<{ readonly orderId: string; readonly closedReason: string }> = [];
    const { deps } = createDeps({
      runtime,
      cancelOrder: async () => ({
        kind: 'ALREADY_CLOSED',
        closedReason: 'CANCELED',
        relatedBuyOrderIds: null,
        terminalExecution: {
          submittedQuantity: 100,
          executedQuantity: 0,
        },
      }),
      settleOrder: (params) => {
        settlementCalls.push({
          orderId: params.orderId,
          closedReason: params.closedReason,
        });
        return {
          handled: true,
          relatedBuyOrderIds: null,
        };
      },
    });
    const routeProcessor = createRouteProcessor(deps);

    await routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'TIMER',
      latestQuote: null,
    });

    expect(settlementCalls).toMatchObject([
      {
        orderId: 'BUY-TIMEOUT-ALREADY-CLOSED',
        closedReason: 'CANCELED',
      },
    ]);
  });

  it('买单 timeout 终态查询陈旧时不否认 tracked 已知部分成交', async () => {
    const runtime = createRuntimeStore();
    const trackedExecutedAtMs = Date.parse('2026-04-08T09:00:00.200Z');
    attachTrackedOrders(runtime, 'BULL.HK', [
      createTrackedOrder({
        orderId: 'BUY-TIMEOUT-STALE-TERMINAL',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
        executedQuantity: 50,
        executedPrice: 1.05,
        lastExecutedTimeMs: trackedExecutedAtMs,
        lastOrderUpdateAtMs: trackedExecutedAtMs,
        status: OrderStatus.PartialFilled,
      }),
    ]);

    runtime.queriedTerminalStateByOrderId.set('BUY-TIMEOUT-STALE-TERMINAL', {
      kind: 'TERMINAL',
      closedReason: 'CANCELED',
      executedPrice: 0.9,
      executedQuantity: 20,
      submittedQuantity: 100,
      orderUpdatedAtMs: trackedExecutedAtMs - 100,
      status: OrderStatus.Canceled,
    });
    const settlementCalls: Array<
      Readonly<{
        executedPrice?: number | null;
        executedQuantity?: number | null;
        executedTimeMs?: number | null;
        orderUpdatedAtMs?: number | null;
      }>
    > = [];
    const { deps } = createDeps({
      runtime,
      cancelOrder: async () => ({
        kind: 'ALREADY_CLOSED',
        closedReason: 'CANCELED',
        relatedBuyOrderIds: null,
        terminalExecution: {
          submittedQuantity: 100,
          executedQuantity: 20,
        },
      }),
      settleOrder: (params) => {
        settlementCalls.push(params);
        return { handled: true, relatedBuyOrderIds: null };
      },
    });

    await createRouteProcessor(deps).processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'TIMER',
      latestQuote: null,
    });

    expect(settlementCalls).toMatchObject([
      {
        executedPrice: 1.05,
        executedQuantity: 50,
        executedTimeMs: trackedExecutedAtMs,
        orderUpdatedAtMs: trackedExecutedAtMs,
      },
    ]);
  });

  it('保护性 SELL timeout state-check 的原始 executedQuantity 为 null 时不得由 tracked 部分成交收口', async () => {
    const runtime = createRuntimeStore();
    const trackedExecutionMs = Date.parse('2026-04-08T09:00:00.200Z');
    const trackedOrder = createTrackedOrder({
      orderId: 'SELL-PROTECTIVE-STATE-CHECK-NULL-QUANTITY',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      isProtectiveLiquidation: true,
      submittedAt: Date.now() - 1_000,
      submittedQuantity: 100,
      executedQuantity: 40,
      executedPrice: 1.02,
      lastExecutedTimeMs: trackedExecutionMs,
      lastOrderUpdateAtMs: trackedExecutionMs,
      status: OrderStatus.PartialFilled,
    });
    attachTrackedOrders(runtime, 'BULL.HK', [trackedOrder]);
    runtime.queriedTerminalStateByOrderId.set(trackedOrder.orderId, {
      kind: 'TERMINAL',
      closedReason: 'CANCELED',
      executedPrice: 1.02,
      executedQuantity: null,
      submittedQuantity: 100,
      orderUpdatedAtMs: trackedExecutionMs + 1_000,
      status: OrderStatus.Canceled,
    });
    let settlementCalls = 0;
    const { deps } = createDeps({
      runtime,
      cancelOrder: async () => ({
        kind: 'ALREADY_CLOSED',
        closedReason: 'CANCELED',
        relatedBuyOrderIds: null,
        terminalExecution: {
          submittedQuantity: 100,
          executedQuantity: null,
        },
      }),
      settleOrder: () => {
        settlementCalls += 1;
        return { handled: true, relatedBuyOrderIds: null };
      },
    });

    let caughtError: unknown = null;
    try {
      await createRouteProcessor(deps).processRoute({
        symbol: 'BULL.HK',
        generation: 1,
        wakeupKind: 'TIMER',
        latestQuote: null,
      });
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(Error);
    expect(caughtError).toHaveProperty('message', expect.stringMatching(/保护性 SELL/));

    expect(settlementCalls).toBe(0);
    expect(runtime.closedOrderIds.has(trackedOrder.orderId)).toBe(false);
    expect(runtime.trackedOrders.get(trackedOrder.orderId)).toMatchObject({
      status: OrderStatus.PartialFilled,
      executedQuantity: 40,
      executedPrice: 1.02,
      lastExecutedTimeMs: trackedExecutionMs,
      lastOrderUpdateAtMs: trackedExecutionMs,
    });
  });

  it('保护性 SELL state-check 的等量终态可用已确认事实完成结算', async () => {
    const runtime = createRuntimeStore();
    const trackedExecutionMs = Date.parse('2026-04-08T09:00:00.200Z');
    const trackedOrder = createTrackedOrder({
      orderId: 'SELL-PROTECTIVE-STATE-CHECK-EQUAL-QUANTITY',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      isProtectiveLiquidation: true,
      submittedAt: Date.now() - 1_000,
      submittedQuantity: 40,
      executedQuantity: 40,
      executedPrice: 1.02,
      lastExecutedTimeMs: trackedExecutionMs,
      lastOrderUpdateAtMs: trackedExecutionMs,
      status: OrderStatus.PartialFilled,
    });
    attachTrackedOrders(runtime, 'BULL.HK', [trackedOrder]);
    const rawTerminal = {
      kind: 'TERMINAL' as const,
      closedReason: 'CANCELED' as const,
      executedPrice: null,
      executedQuantity: 40,
      submittedQuantity: 40,
      orderUpdatedAtMs: null,
      status: OrderStatus.Canceled,
    };
    runtime.queriedTerminalStateByOrderId.set(trackedOrder.orderId, rawTerminal);
    setLatestReplaceTerminal(runtime, trackedOrder.orderId, rawTerminal);
    const settlementCalls: FinalizeOrderSettlementParams[] = [];
    const { deps } = createDeps({
      runtime,
      cancelOrder: async () => ({
        kind: 'ALREADY_CLOSED',
        closedReason: 'CANCELED',
        relatedBuyOrderIds: null,
        terminalExecution: {
          submittedQuantity: 40,
          executedQuantity: 40,
        },
      }),
      settleOrder: (params) => {
        settlementCalls.push(params);
        return { handled: true, relatedBuyOrderIds: null };
      },
    });

    await createRouteProcessor(deps).processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'QUOTE',
      latestQuote: createQuoteDouble('BULL.HK', 1.02),
    });

    expect(settlementCalls).toEqual([
      {
        orderId: trackedOrder.orderId,
        closedReason: 'CANCELED',
        source: 'STATE_CHECK',
        executedPrice: 1.02,
        executedQuantity: 40,
        executedTimeMs: trackedExecutionMs,
        orderUpdatedAtMs: trackedExecutionMs,
      },
    ]);
    expect(runtime.queriedTerminalStateByOrderId.has(trackedOrder.orderId)).toBe(false);
  });

  it('卖单 timeout 使用规范化成交量计算补卖数量', async () => {
    const runtime = createRuntimeStore();
    const trackedExecutedAtMs = Date.parse('2026-04-08T09:00:00.200Z');
    attachTrackedOrders(runtime, 'BULL.HK', [
      createTrackedOrder({
        orderId: 'SELL-TIMEOUT-NORMALIZED-REMAINDER',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        submittedQuantity: 100,
        executedQuantity: 50,
        executedPrice: 1.05,
        lastExecutedTimeMs: trackedExecutedAtMs,
        lastOrderUpdateAtMs: trackedExecutedAtMs,
        status: OrderStatus.PartialFilled,
      }),
    ]);

    runtime.queriedTerminalStateByOrderId.set('SELL-TIMEOUT-NORMALIZED-REMAINDER', {
      kind: 'TERMINAL',
      closedReason: 'CANCELED',
      executedPrice: 0.9,
      executedQuantity: 20,
      submittedQuantity: 100,
      orderUpdatedAtMs: trackedExecutedAtMs - 100,
      status: OrderStatus.Canceled,
    });
    const trackedOrders: TrackOrderParams[] = [];
    const { deps } = createDeps({
      runtime,
      cancelOrder: async () => ({
        kind: 'ALREADY_CLOSED',
        closedReason: 'CANCELED',
        relatedBuyOrderIds: null,
        terminalExecution: {
          submittedQuantity: 100,
          executedQuantity: 20,
        },
      }),
      settleOrder: () => ({ handled: true, relatedBuyOrderIds: ['BUY-1'] }),
      trackOrder: (params) => {
        trackedOrders.push(params);
      },
    });

    await createRouteProcessor(deps).processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'TIMER',
      latestQuote: null,
    });

    expect(trackedOrders).toHaveLength(1);
    expect(trackedOrders[0]?.quantity).toBe(50);
  });

  it('route generation 已推进时，旧的 timeout->market continuation 不会再提交 MO', async () => {
    const runtime = createRuntimeStore();
    attachTrackedOrders(runtime, 'BULL.HK', [
      createTrackedOrder({
        orderId: 'SELL-STALE-CONVERT',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.Canceled,
        timeoutMarketConversionPending: true,
        timeoutMarketConversionTerminalState: {
          closedReason: 'CANCELED',
          source: 'WS',
          executedPrice: 0,
          executedQuantity: 0,
          executedTimeMs: Date.parse('2026-04-08T09:00:01.000Z'),
          orderUpdatedAtMs: Date.parse('2026-04-08T09:00:01.000Z'),
        },
      }),
    ]);

    const tradeCtx = createTradeContextMock();
    const deferredPermit = createDeferredValue<null>();
    const trackedOrders: TrackOrderParams[] = [];
    const { deps } = createDeps({
      runtime,
      ctx: createTradeContextDouble(tradeCtx),
      rateLimiter: {
        throttle: async () => {},
        withTradeMutation: async <T>(
          callback: (permit: TradeMutationPermit) => Promise<T>,
        ): Promise<T> => {
          await deferredPermit.promise;
          return callback({
            invoke: async <TResult>(operation: () => Promise<TResult>): Promise<TResult> =>
              operation(),
          });
        },
      },
      trackOrder: (params) => {
        trackedOrders.push(params);
      },
      settleOrder: () => {
        runtime.trackedOrders.delete('SELL-STALE-CONVERT');
        runtime.trackedOrderLifecycles.set('SELL-STALE-CONVERT', 'CLOSED');
        runtime.closedOrderIds.add('SELL-STALE-CONVERT');
        runtime.trackedOrderIdsBySymbol.delete('BULL.HK');
        runtime.routeStatesBySymbol.delete('BULL.HK');

        const nextOrder = createTrackedOrder({
          orderId: 'SELL-NEWER-GENERATION',
          symbol: 'BULL.HK',
          side: OrderSide.Sell,
          submittedAt: Date.now(),
        });
        runtime.trackedOrders.set(nextOrder.orderId, nextOrder);
        runtime.trackedOrderLifecycles.set(nextOrder.orderId, 'OPEN');
        runtime.trackedOrderIdsBySymbol.set('BULL.HK', new Set([nextOrder.orderId]));
        runtime.routeStatesBySymbol.set('BULL.HK', {
          symbol: 'BULL.HK',
          generation: 2,
          inFlight: false,
          dirty: false,
          latestQuote: null,
          pendingWakeupKind: null,
          timerHandles: new Map(),
        });
        runtime.latestRouteGenerationBySymbol.set('BULL.HK', 2);

        return {
          handled: true,
          relatedBuyOrderIds: ['BUY-1'],
        };
      },
    });
    const routeProcessor = createRouteProcessor(deps);

    const processPromise = routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'ORDER_EVENT',
      latestQuote: null,
    });

    deferredPermit.resolve(null);
    await processPromise;

    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(0);
    expect(trackedOrders).toEqual([]);
  });

  it.each(['FILLED', 'CANCELED'] as const)(
    '保护性 SELL timeout 收到 ALREADY_CLOSED/%s 但无 raw terminal snapshot 时阻断 route',
    async (closedReason) => {
      const runtime = createRuntimeStore();
      const trackedOrder = createTrackedOrder({
        orderId: `SELL-PROTECTIVE-NO-RAW-${closedReason}`,
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.PartialFilled,
        submittedAt: Date.now() - 10_000,
        isProtectiveLiquidation: true,
        executedQuantity: 40,
        executedPrice: 1.02,
        lastExecutedTimeMs: 190,
        lastOrderUpdateAtMs: 200,
      });
      attachTrackedOrders(runtime, 'BULL.HK', [trackedOrder]);
      const tradeCtx = createTradeContextMock();
      let cancelCalls = 0;
      let settlementCalls = 0;
      const { deps } = createDeps({
        runtime,
        ctx: createTradeContextDouble(tradeCtx),
        cancelOrder: async () => {
          cancelCalls += 1;
          return {
            kind: 'ALREADY_CLOSED',
            closedReason,
            relatedBuyOrderIds: null,
            terminalExecution: {
              submittedQuantity: 100,
              executedQuantity: null,
            },
          };
        },
        settleOrder: () => {
          settlementCalls += 1;
          return { handled: true, relatedBuyOrderIds: ['BUY-1'] };
        },
      });

      let caughtError: unknown = null;
      try {
        await createRouteProcessor(deps).processRoute({
          symbol: 'BULL.HK',
          generation: 1,
          wakeupKind: 'TIMER',
          latestQuote: null,
        });
      } catch (error) {
        caughtError = error;
      }

      expect(caughtError).toBeInstanceOf(Error);
      expect(caughtError).toHaveProperty('message', expect.stringMatching(/raw terminal snapshot/));
      expect(settlementCalls).toBe(0);
      expect(tradeCtx.getCalls('submitOrder')).toHaveLength(0);
      expect(cancelCalls).toBe(1);
      expect(trackedOrder.nextCancelAttemptAt).toBe(ORDER_MONITOR_WAIT_WS_ONLY_BLOCK_UNTIL_MS);
      expect(runtime.closedOrderIds.has(trackedOrder.orderId)).toBe(false);
    },
  );

  it('保护性 SELL terminal raw 校验失败后保留 terminal snapshot，不允许用 tracked 事实改写', async () => {
    const runtime = createRuntimeStore();
    const trackedOrder = createTrackedOrder({
      orderId: 'SELL-PROTECTIVE-INVALID-RAW-RETAINED',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      status: OrderStatus.PartialFilled,
      submittedAt: Date.now() - 10_000,
      isProtectiveLiquidation: true,
      executedQuantity: 40,
      executedPrice: 1.02,
      lastExecutedTimeMs: 190,
      lastOrderUpdateAtMs: 200,
    });
    attachTrackedOrders(runtime, 'BULL.HK', [trackedOrder]);
    const rawTerminal = {
      kind: 'TERMINAL' as const,
      closedReason: 'FILLED' as const,
      status: OrderStatus.Filled,
      submittedQuantity: 100,
      executedQuantity: null,
      executedPrice: 1.02,
      orderUpdatedAtMs: 300,
    };
    runtime.queriedTerminalStateByOrderId.set(trackedOrder.orderId, rawTerminal);
    let settlementCalls = 0;
    const { deps } = createDeps({
      runtime,
      cancelOrder: async () => ({
        kind: 'ALREADY_CLOSED',
        closedReason: 'FILLED',
        relatedBuyOrderIds: null,
        terminalExecution: {
          submittedQuantity: 100,
          executedQuantity: null,
        },
      }),
      settleOrder: () => {
        settlementCalls += 1;
        return { handled: true, relatedBuyOrderIds: null };
      },
    });

    let caughtError: unknown = null;
    try {
      await createRouteProcessor(deps).processRoute({
        symbol: 'BULL.HK',
        generation: 1,
        wakeupKind: 'TIMER',
        latestQuote: null,
      });
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(Error);
    expect(caughtError).toHaveProperty('message', expect.stringMatching(/保护性 SELL/));
    expect(runtime.queriedTerminalStateByOrderId.get(trackedOrder.orderId)).toBe(rawTerminal);
    expect(settlementCalls).toBe(0);
    expect(runtime.closedOrderIds.has(trackedOrder.orderId)).toBe(false);
  });

  it('保护性 SELL terminal 本地结算失败后保留同一 raw snapshot，重试成功只确认一次', async () => {
    const runtime = createRuntimeStore();
    const trackedOrder = createTrackedOrder({
      orderId: 'SELL-PROTECTIVE-SETTLEMENT-RETRY',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      status: OrderStatus.PartialFilled,
      submittedAt: Date.now() - 10_000,
      isProtectiveLiquidation: true,
      executedQuantity: 40,
      executedPrice: 1.02,
      lastExecutedTimeMs: 190,
      lastOrderUpdateAtMs: 200,
    });
    attachTrackedOrders(runtime, 'BULL.HK', [trackedOrder]);
    const rawTerminal = {
      kind: 'TERMINAL' as const,
      closedReason: 'FILLED' as const,
      status: OrderStatus.Filled,
      submittedQuantity: 100,
      executedQuantity: 80,
      executedPrice: 1.01,
      orderUpdatedAtMs: 300,
    };
    runtime.queriedTerminalStateByOrderId.set(trackedOrder.orderId, rawTerminal);
    const settlementError = new Error('local settlement failed');
    let settlementAttempts = 0;
    let settledCount = 0;
    const { deps } = createDeps({
      runtime,
      cancelOrder: async () => ({
        kind: 'ALREADY_CLOSED',
        closedReason: 'FILLED',
        relatedBuyOrderIds: null,
        terminalExecution: {
          submittedQuantity: 100,
          executedQuantity: 80,
        },
      }),
      settleOrder: () => {
        settlementAttempts += 1;
        if (settlementAttempts === 1) {
          throw settlementError;
        }

        settledCount += 1;
        return { handled: true, relatedBuyOrderIds: null };
      },
    });
    const routeProcessor = createRouteProcessor(deps);

    let caughtError: unknown = null;
    try {
      await routeProcessor.processRoute({
        symbol: 'BULL.HK',
        generation: 1,
        wakeupKind: 'TIMER',
        latestQuote: null,
      });
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBe(settlementError);
    expect(runtime.queriedTerminalStateByOrderId.get(trackedOrder.orderId)).toBe(rawTerminal);
    expect(runtime.closedOrderIds.has(trackedOrder.orderId)).toBe(false);

    await routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'TIMER',
      latestQuote: null,
    });

    expect(settlementAttempts).toBe(2);
    expect(settledCount).toBe(1);
    expect(runtime.queriedTerminalStateByOrderId.has(trackedOrder.orderId)).toBe(false);
  });

  it('保护性 SELL replace terminal 的本地结算失败后保留 outcome 与 raw snapshot', async () => {
    const runtime = createRuntimeStore();
    const trackedOrder = createTrackedOrder({
      orderId: 'SELL-PROTECTIVE-REPLACE-OUTCOME-RETRY',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      status: OrderStatus.New,
      submittedAt: Date.now(),
      lastPriceUpdateAt: Date.now() - 10_000,
      isProtectiveLiquidation: true,
      executedQuantity: 40,
      executedPrice: 1.02,
      lastExecutedTimeMs: 190,
      lastOrderUpdateAtMs: 200,
    });
    attachTrackedOrders(runtime, 'BULL.HK', [trackedOrder]);
    const rawTerminal = {
      kind: 'TERMINAL' as const,
      closedReason: 'FILLED' as const,
      status: OrderStatus.Filled,
      submittedQuantity: 100,
      executedQuantity: 80,
      executedPrice: 1.01,
      orderUpdatedAtMs: 300,
    };
    const terminalOutcome: TerminalStateSnapshot = rawTerminal;
    runtime.queriedTerminalStateByOrderId.set(trackedOrder.orderId, rawTerminal);
    const settlementError = new Error('replace local settlement failed');
    let settlementAttempts = 0;
    const { deps } = createDeps({
      runtime,
      config: createConfig({ sellTimeoutMs: 60_000 }),
      replaceOrderPrice: async () => {
        runtime.latestReplaceTerminalByOrderId.set(trackedOrder.orderId, terminalOutcome);
      },
      settleOrder: () => {
        settlementAttempts += 1;
        if (settlementAttempts === 1) {
          throw settlementError;
        }

        return { handled: true, relatedBuyOrderIds: null };
      },
    });
    const routeProcessor = createRouteProcessor(deps);
    const routeParams = {
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'QUOTE' as const,
      latestQuote: createQuoteDouble('BULL.HK', 1.1),
    };

    let caughtError: unknown = null;
    try {
      await routeProcessor.processRoute(routeParams);
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBe(settlementError);
    expect(runtime.latestReplaceTerminalByOrderId.get(trackedOrder.orderId)).toBe(terminalOutcome);
    expect(runtime.queriedTerminalStateByOrderId.get(trackedOrder.orderId)).toBe(rawTerminal);

    await routeProcessor.processRoute(routeParams);

    expect(settlementAttempts).toBe(2);
    expect(runtime.latestReplaceTerminalByOrderId.has(trackedOrder.orderId)).toBe(false);
    expect(runtime.queriedTerminalStateByOrderId.has(trackedOrder.orderId)).toBe(false);
  });

  it('cancel ALREADY_CLOSED 后 route generation 失效时保留未 ack raw terminal，后续 gateway 只结算一次', async () => {
    const runtime = createRuntimeStore();
    const trackedOrder = createTrackedOrder({
      orderId: 'SELL-CANCEL-TERMINAL-GENERATION-STALE',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      submittedAt: Date.now() - 10_000,
    });
    attachTrackedOrders(runtime, 'BULL.HK', [trackedOrder]);
    const rawTerminal = {
      kind: 'TERMINAL' as const,
      closedReason: 'FILLED' as const,
      status: OrderStatus.Filled,
      submittedQuantity: 100,
      executedQuantity: 100,
      executedPrice: 1.01,
      orderUpdatedAtMs: Date.parse('2026-07-13T05:10:00.000Z'),
    };
    let cancelCalls = 0;
    let settlementCalls = 0;
    const marketOrderTracks: TrackOrderParams[] = [];
    const pendingSellReleaseOrderIds: string[] = [];
    const { deps, tradeCtx } = createDeps({
      runtime,
      config: createConfig({ buyTimeoutMs: 60_000, sellTimeoutMs: 0 }),
      orderRecorder: createOrderRecorderDouble({
        markSellCancelled: (orderId) => {
          pendingSellReleaseOrderIds.push(orderId);
          return null;
        },
      }),
      cancelOrder: async () => {
        cancelCalls += 1;
        runtime.queriedTerminalStateByOrderId.set(trackedOrder.orderId, rawTerminal);
        runtime.latestRouteGenerationBySymbol.set('BULL.HK', 2);
        return {
          kind: 'ALREADY_CLOSED' as const,
          closedReason: 'FILLED' as const,
          relatedBuyOrderIds: null,
          terminalExecution: {
            submittedQuantity: 100,
            executedQuantity: 100,
          },
        };
      },
      settleOrder: () => {
        settlementCalls += 1;
        return { handled: true, relatedBuyOrderIds: null };
      },
      trackOrder: (params) => {
        marketOrderTracks.push(params);
      },
    });
    const routeProcessor = createRouteProcessor(deps);

    await routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'TIMER',
      latestQuote: null,
    });

    expect(runtime.queriedTerminalStateByOrderId.get(trackedOrder.orderId)).toBe(rawTerminal);
    expect(settlementCalls).toBe(0);
    expect(pendingSellReleaseOrderIds).toEqual([]);
    expect(marketOrderTracks).toEqual([]);
    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(0);
    expect(cancelCalls).toBe(1);

    runtime.routeStatesBySymbol.get('BULL.HK')!.generation = 2;
    await routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 2,
      wakeupKind: 'TIMER',
      latestQuote: null,
    });

    expect(cancelCalls).toBe(1);
    expect(settlementCalls).toBe(1);
    expect(runtime.queriedTerminalStateByOrderId.has(trackedOrder.orderId)).toBe(false);
    expect(pendingSellReleaseOrderIds).toEqual([]);
    expect(marketOrderTracks).toEqual([]);
    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(0);
  });

  it('replace TERMINAL_CONFIRMED 后 runtime stop 时保留未 ack outcome 与 raw terminal，重启 gateway 只结算一次', async () => {
    const runtime = createRuntimeStore();
    const trackedOrder = createTrackedOrder({
      orderId: 'SELL-REPLACE-TERMINAL-RUNTIME-STOPPED',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      submittedAt: Date.now() - 1_000,
      lastPriceUpdateAt: 0,
    });
    attachTrackedOrders(runtime, 'BULL.HK', [trackedOrder]);
    const rawTerminal = {
      kind: 'TERMINAL' as const,
      closedReason: 'FILLED' as const,
      status: OrderStatus.Filled,
      submittedQuantity: 100,
      executedQuantity: 100,
      executedPrice: 1.01,
      orderUpdatedAtMs: Date.parse('2026-07-13T05:11:00.000Z'),
    };
    const terminalOutcome: TerminalStateSnapshot = rawTerminal;
    let replaceCalls = 0;
    let settlementCalls = 0;
    const marketOrderTracks: TrackOrderParams[] = [];
    const pendingSellReleaseOrderIds: string[] = [];
    const { deps, tradeCtx } = createDeps({
      runtime,
      config: createConfig({ buyTimeoutMs: 60_000, sellTimeoutMs: 60_000 }),
      orderRecorder: createOrderRecorderDouble({
        markSellCancelled: (orderId) => {
          pendingSellReleaseOrderIds.push(orderId);
          return null;
        },
      }),
      replaceOrderPrice: async () => {
        replaceCalls += 1;
        runtime.queriedTerminalStateByOrderId.set(trackedOrder.orderId, rawTerminal);
        setLatestReplaceTerminal(runtime, trackedOrder.orderId, terminalOutcome);
        runtime.running = false;
      },
      settleOrder: () => {
        settlementCalls += 1;
        return { handled: true, relatedBuyOrderIds: null };
      },
      trackOrder: (params) => {
        marketOrderTracks.push(params);
      },
    });
    const routeProcessor = createRouteProcessor(deps);
    const routeParams = {
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'QUOTE' as const,
      latestQuote: createQuoteDouble('BULL.HK', 1.02),
    };

    await routeProcessor.processRoute(routeParams);

    expect(runtime.latestReplaceTerminalByOrderId.get(trackedOrder.orderId)).toBe(terminalOutcome);
    expect(runtime.queriedTerminalStateByOrderId.get(trackedOrder.orderId)).toBe(rawTerminal);
    expect(settlementCalls).toBe(0);
    expect(pendingSellReleaseOrderIds).toEqual([]);
    expect(marketOrderTracks).toEqual([]);
    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(0);
    expect(replaceCalls).toBe(1);

    runtime.running = true;
    await routeProcessor.processRoute(routeParams);

    expect(replaceCalls).toBe(1);
    expect(settlementCalls).toBe(1);
    expect(runtime.latestReplaceTerminalByOrderId.has(trackedOrder.orderId)).toBe(false);
    expect(runtime.queriedTerminalStateByOrderId.has(trackedOrder.orderId)).toBe(false);
    expect(pendingSellReleaseOrderIds).toEqual([]);
    expect(marketOrderTracks).toEqual([]);
    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(0);
  });
});
