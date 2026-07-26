/**
 * orderMonitor/orderOps 业务测试
 *
 * 覆盖：
 * - trackOrder 会把 orderId 挂到 symbol bucket，并在 ACTIVE 运行态触发 TRACKED wakeup
 * - 恢复阶段 trackOrder 只重建 truth，不触发 TRACKED wakeup
 */
import { describe, expect, it } from 'bun:test';
import { Decimal, OrderSide, OrderStatus, OrderType, type OrderDetail } from 'longbridge';
import { ORDER_MONITOR_REPLACE_TEMP_BLOCK_BACKOFF_MS } from '../../../../src/constants/index.js';
import { createRateLimiter as createTraderRateLimiter } from '../../../../src/core/trader/rateLimiter.js';
import { createOrderOps as createProductionOrderOps } from '../../../../src/core/trader/orderMonitor/orderOps.js';
import { createOrderStatusQuery } from '../../../../src/core/trader/orderMonitor/orderStatusQuery.js';
import { normalizeTerminalStateSnapshot } from '../../../../src/core/trader/orderMonitor/orderFactMerge.js';
import type {
  OrderMonitorRuntimeStore,
  OrderMonitorTrackedOrder,
  OrderOpsDeps,
} from '../../../../src/core/trader/orderMonitor/types.js';
import type { OrderStateCheckResult } from '../../../../src/types/trader.js';
import { createTradingConfig } from '../../../../mock/factories/configFactory.js';
import {
  createOrderRecorderDouble,
  createTradeContextDouble,
} from '../../../helpers/testDoubles.js';
import type { OrderHoldRegistry, OrderCacheManager } from '../../../../src/core/trader/types.js';
import type { RateLimiter, TradeMutationPermit } from '../../../../src/types/services.js';
import { createTradeContextMock } from '../../../../mock/longbridge/tradeContextMock.js';

const TEST_MONITOR_CONFIG = createTradingConfig().monitor;

type TestOrderOpsDeps = Omit<OrderOpsDeps, 'now'> & Partial<Pick<OrderOpsDeps, 'now'>>;

function createOrderOps(deps: TestOrderOpsDeps) {
  return createProductionOrderOps({
    now: () => new Date(Date.now()),
    ...deps,
  });
}

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

function createCacheManager(): OrderCacheManager {
  return {
    getPendingOrders: async () => [],
    clearCache: () => {},
  };
}

function createDeferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });

  return {
    promise,
    resolve: resolvePromise,
  };
}

/** 构造直接命中 602013 的改单路径，并保留 state-check 调用计数供断言。 */
function createReplaceTempBlockedHarness(): {
  readonly runtime: OrderMonitorRuntimeStore;
  readonly orderOps: ReturnType<typeof createOrderOps>;
  readonly trackedOrder: OrderMonitorTrackedOrder;
  readonly getReplaceOrderCalls: () => number;
  readonly getStateCheckCalls: () => number;
} {
  const runtime = createRuntimeStore();
  const tradeCtx = createTradeContextMock();
  let replaceOrderCalls = 0;
  tradeCtx.replaceOrder = async () => {
    replaceOrderCalls += 1;
    throw new Error('openapi error: code=602013: current status does not allow replace');
  };
  let stateCheckCalls = 0;
  const orderOps = createOrderOps({
    runtime,
    monitorConfig: TEST_MONITOR_CONFIG,
    ctx: createTradeContextDouble(tradeCtx),
    rateLimiter: createRateLimiter(),
    cacheManager: createCacheManager(),
    orderHoldRegistry: createOrderHoldRegistry(),
    orderRecorder: createOrderRecorderDouble(),
    recordCumulativeExecution: () => {},
    orderStatusQuery: {
      checkOrderState: async () => {
        stateCheckCalls += 1;
        return {
          kind: 'QUERY_FAILED' as const,
          errorCode: '603001',
        };
      },
    },
    triggerRoute: () => {},
  });
  orderOps.trackOrder({
    orderId: 'REPLACE-602013-BACKOFF-BOUNDARY',
    symbol: 'BULL.HK',
    side: OrderSide.Buy,
    price: 1,
    initialSubmittedPrice: 1,
    quantity: 100,
    initialStatus: OrderStatus.New,
    isLongSymbol: true,
    monitorSymbol: 'HSI.HK',
    isProtectiveLiquidation: false,
    orderType: OrderType.ELO,
  });
  const trackedOrder = runtime.trackedOrders.get('REPLACE-602013-BACKOFF-BOUNDARY');
  if (trackedOrder === undefined) {
    throw new Error('[测试] 602013 retry boundary 未建立 tracked order');
  }

  return {
    runtime,
    orderOps,
    trackedOrder,
    getReplaceOrderCalls: () => replaceOrderCalls,
    getStateCheckCalls: () => stateCheckCalls,
  };
}

type MutationPermitDouble = {
  readonly invoke: <T>(operation: () => Promise<T>) => Promise<T>;
};

describe('orderMonitor orderOps', () => {
  it('routes cancel and replace SDK mutations through callback permits instead of read throttle', async () => {
    const runtime = createRuntimeStore();
    const tradeContext = createTradeContextMock();
    const events: string[] = [];
    const rateLimiter = {
      throttle: async (): Promise<void> => {
        throw new Error('mutation must not use read throttle');
      },
      withTradeMutation: async <T>(
        callback: (permit: MutationPermitDouble) => Promise<T>,
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
    const orderOps = createOrderOps({
      runtime,
      monitorConfig: TEST_MONITOR_CONFIG,
      ctx: createTradeContextDouble(tradeContext),
      rateLimiter,
      cacheManager: createCacheManager(),
      orderHoldRegistry: createOrderHoldRegistry(),
      orderRecorder: createOrderRecorderDouble(),
      recordCumulativeExecution: () => {},
      orderStatusQuery: {
        checkOrderState: async () => ({
          kind: 'QUERY_FAILED' as const,
          errorCode: '603001',
        }),
      },
      triggerRoute: () => {},
    });
    orderOps.trackOrder({
      orderId: 'ORDER-CANCEL-PERMIT',
      symbol: 'BULL.HK',
      side: OrderSide.Buy,
      price: 1,
      initialSubmittedPrice: 1,
      quantity: 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: OrderType.ELO,
    });

    orderOps.trackOrder({
      orderId: 'ORDER-REPLACE-PERMIT',
      symbol: 'BEAR.HK',
      side: OrderSide.Sell,
      price: 1,
      initialSubmittedPrice: 1,
      quantity: 100,
      isLongSymbol: false,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: OrderType.ELO,
    });

    const [cancelOutcome, replaceOutcome] = await Promise.all([
      orderOps.cancelOrder('ORDER-CANCEL-PERMIT', { kind: 'ORDER_FACT' }),
      orderOps.replaceOrderPrice('ORDER-REPLACE-PERMIT', 1.1, { kind: 'ORDER_FACT' }),
    ]);

    expect(cancelOutcome.kind).toBe('CANCEL_CONFIRMED');
    expect(replaceOutcome.kind).toBe('BROKER_CONFIRMED');
    expect(tradeContext.getCalls('cancelOrder')).toHaveLength(1);
    expect(tradeContext.getCalls('replaceOrder')).toHaveLength(1);
    expect(events).toEqual(['permit', 'invoke', 'permit', 'invoke']);
  });

  it('rechecks signal authorization after the first replace mutation permit is acquired', async () => {
    const runtime = createRuntimeStore();
    const tradeContext = createTradeContextMock();
    let authorized = true;
    let permitAcquisitionCount = 0;
    const rateLimiter = {
      throttle: async (): Promise<void> => {
        throw new Error('mutation must not use read throttle');
      },
      withTradeMutation: async <T>(
        callback: (permit: MutationPermitDouble) => Promise<T>,
      ): Promise<T> => {
        permitAcquisitionCount += 1;
        authorized = false;
        return callback({
          invoke: async <TResult>(operation: () => Promise<TResult>): Promise<TResult> =>
            operation(),
        });
      },
    };
    const orderOps = createOrderOps({
      runtime,
      monitorConfig: TEST_MONITOR_CONFIG,
      ctx: createTradeContextDouble(tradeContext),
      rateLimiter,
      cacheManager: createCacheManager(),
      orderHoldRegistry: createOrderHoldRegistry(),
      orderRecorder: createOrderRecorderDouble(),
      recordCumulativeExecution: () => {},
      orderStatusQuery: {
        checkOrderState: async () => ({
          kind: 'QUERY_FAILED' as const,
          errorCode: '603001',
        }),
      },
      triggerRoute: () => {},
    });
    orderOps.trackOrder({
      orderId: 'ORDER-REPLACE-AUTH-REVOKED-AFTER-PERMIT',
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

    const outcome = await orderOps.replaceOrderPrice(
      'ORDER-REPLACE-AUTH-REVOKED-AFTER-PERMIT',
      1.1,
      { kind: 'SIGNAL_AUTHORIZED', authorize: () => authorized },
    );

    expect(permitAcquisitionCount).toBe(1);
    expect(outcome).toEqual({ kind: 'NOT_EXECUTED' });
    expect(tradeContext.getCalls('replaceOrder')).toHaveLength(0);
  });

  it('rechecks doomsday cancellation authorization after the queued mutation permit becomes available', async () => {
    const runtime = createRuntimeStore();
    const tradeContext = createTradeContextMock();
    const rateLimiter = createTraderRateLimiter({
      config: { maxCalls: 30, windowMs: 30_000 },
    });
    const firstMutationEntered = createDeferred();
    const releaseFirstMutation = createDeferred();
    const occupiedMutation = rateLimiter.withTradeMutation(async () => {
      firstMutationEntered.resolve();
      await releaseFirstMutation.promise;
    });
    await firstMutationEntered.promise;

    const orderOps = createOrderOps({
      runtime,
      monitorConfig: TEST_MONITOR_CONFIG,
      ctx: createTradeContextDouble(tradeContext),
      rateLimiter,
      cacheManager: createCacheManager(),
      orderHoldRegistry: createOrderHoldRegistry(),
      orderRecorder: createOrderRecorderDouble(),
      recordCumulativeExecution: () => {},
      orderStatusQuery: {
        checkOrderState: async () => ({
          kind: 'QUERY_FAILED' as const,
          errorCode: '603001',
        }),
      },
      triggerRoute: () => {},
    });
    let isLive = true;
    let permitGateChecks = 0;
    const cancelPromise = orderOps.cancelOrder('DOOMSDAY-QUEUED-CANCEL', {
      kind: 'DOOMSDAY_WINDOW',
      beforeBrokerCancel: () => {
        permitGateChecks += 1;
        return isLive;
      },
    });

    isLive = false;
    releaseFirstMutation.resolve();
    await occupiedMutation;

    const outcome = await cancelPromise;

    expect(outcome).toEqual({ kind: 'CANCEL_NOT_STARTED' });
    expect(permitGateChecks).toBe(1);
    expect(tradeContext.getCalls('cancelOrder')).toHaveLength(0);
  });

  it('trackOrder 会建立 symbol bucket、route state，并在 ACTIVE 运行态触发 TRACKED wakeup', () => {
    const runtime = createRuntimeStore();
    const injectedNowMs = Date.parse('2031-01-02T03:04:05.000Z');
    const routeWakeups: Array<{ readonly symbol: string; readonly kind: string }> = [];
    const deps = {
      now: () => new Date(injectedNowMs),
      runtime,
      monitorConfig: TEST_MONITOR_CONFIG,
      ctx: createTradeContextDouble(),
      rateLimiter: createRateLimiter(),
      cacheManager: createCacheManager(),
      orderHoldRegistry: createOrderHoldRegistry(),
      orderRecorder: createOrderRecorderDouble(),
      recordCumulativeExecution: () => {},
      orderStatusQuery: {
        checkOrderState: async () => ({
          kind: 'QUERY_FAILED' as const,
          errorCode: '603001',
        }),
      },
      triggerRoute: (symbol: string, kind: string) => {
        routeWakeups.push({ symbol, kind });
      },
    };
    const orderOps = createOrderOps(deps);

    orderOps.trackOrder({
      orderId: 'ORDER-TRACK-1',
      symbol: 'BULL.HK',
      side: OrderSide.Buy,
      price: 1.01,
      initialSubmittedPrice: 1.01,
      quantity: 100,
      initialStatus: OrderStatus.New,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: OrderType.ELO,
    });

    expect([...(runtime.trackedOrderIdsBySymbol.get('BULL.HK') ?? new Set()).values()]).toEqual([
      'ORDER-TRACK-1',
    ]);
    expect(runtime.routeStatesBySymbol.get('BULL.HK')).not.toBeUndefined();
    expect(runtime.trackedOrders.get('ORDER-TRACK-1')?.submittedAt).toBe(injectedNowMs);
    expect(injectedNowMs).not.toBe(Date.now());
    expect(routeWakeups).toEqual([
      {
        symbol: 'BULL.HK',
        kind: 'TRACKED',
      },
    ]);
  });

  it('recovery restore 期间的 trackOrder 不触发 TRACKED wakeup', () => {
    const runtime = createRuntimeStore();
    runtime.runtimeState = 'BOOTSTRAPPING';
    const routeWakeups: Array<{ readonly symbol: string; readonly kind: string }> = [];
    const deps = {
      runtime,
      monitorConfig: TEST_MONITOR_CONFIG,
      ctx: createTradeContextDouble(),
      rateLimiter: createRateLimiter(),
      cacheManager: createCacheManager(),
      orderHoldRegistry: createOrderHoldRegistry(),
      orderRecorder: createOrderRecorderDouble(),
      recordCumulativeExecution: () => {},
      orderStatusQuery: {
        checkOrderState: async () => ({
          kind: 'QUERY_FAILED' as const,
          errorCode: '603001',
        }),
      },
      triggerRoute: (symbol: string, kind: string) => {
        routeWakeups.push({ symbol, kind });
      },
    };
    const orderOps = createOrderOps(deps);

    orderOps.trackOrder({
      orderId: 'ORDER-RECOVERY-1',
      symbol: 'BULL.HK',
      side: OrderSide.Buy,
      price: 1.01,
      initialSubmittedPrice: 1.01,
      quantity: 100,
      initialStatus: OrderStatus.New,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: OrderType.ELO,
    });

    expect([...(runtime.trackedOrderIdsBySymbol.get('BULL.HK') ?? new Set()).values()]).toEqual([
      'ORDER-RECOVERY-1',
    ]);
    expect(routeWakeups).toEqual([]);
  });

  it('trackOrder 在 monitorSymbol 不匹配唯一配置时立即失败', () => {
    const runtime = createRuntimeStore();
    const orderOps = createOrderOps({
      runtime,
      monitorConfig: TEST_MONITOR_CONFIG,
      ctx: createTradeContextDouble(),
      rateLimiter: createRateLimiter(),
      cacheManager: createCacheManager(),
      orderHoldRegistry: createOrderHoldRegistry(),
      orderRecorder: createOrderRecorderDouble(),
      recordCumulativeExecution: () => {},
      orderStatusQuery: {
        checkOrderState: async () => ({
          kind: 'QUERY_FAILED' as const,
          errorCode: '603001',
        }),
      },
      triggerRoute: () => {},
    });

    expect(() => {
      orderOps.trackOrder({
        orderId: 'ORDER-TRACK-MISMATCH',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
        price: 1.01,
        initialSubmittedPrice: 1.01,
        quantity: 100,
        isLongSymbol: true,
        monitorSymbol: 'OTHER.HK',
        isProtectiveLiquidation: false,
        orderType: OrderType.ELO,
      });
    }).toThrow(/monitorSymbol.*期望=HSI\.HK/);
  });

  it('cancelOrder retries repeated request failures and rethrows ExternalApiRequestError', async () => {
    const runtime = createRuntimeStore();
    const tradeCtx = createTradeContextMock();
    let cancelCallCount = 0;
    tradeCtx.cancelOrder = async () => {
      cancelCallCount += 1;
      throw new Error('network unavailable');
    };
    const orderOps = createOrderOps({
      runtime,
      monitorConfig: TEST_MONITOR_CONFIG,
      ctx: createTradeContextDouble(tradeCtx),
      rateLimiter: createRateLimiter(),
      cacheManager: createCacheManager(),
      orderHoldRegistry: createOrderHoldRegistry(),
      orderRecorder: createOrderRecorderDouble(),
      recordCumulativeExecution: () => {},
      orderStatusQuery: {
        checkOrderState: async () => ({
          kind: 'QUERY_FAILED' as const,
          errorCode: '603001',
        }),
      },
      triggerRoute: () => {},
    });

    try {
      await orderOps.cancelOrder('ORDER-CANCEL-RETRY', { kind: 'ORDER_FACT' });
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({
        name: 'ExternalApiRequestError',
        operation: 'TradeContext.cancelOrder',
      });
      expect(cancelCallCount).toBeGreaterThan(1);
    }
  });

  it('cancelOrder retries coded transient rate-limit errors', async () => {
    const runtime = createRuntimeStore();
    const tradeCtx = createTradeContextMock();
    let cancelCallCount = 0;
    tradeCtx.cancelOrder = async () => {
      cancelCallCount += 1;
      throw new Error('openapi error: code=429: rate limit exceeded');
    };
    const orderOps = createOrderOps({
      runtime,
      monitorConfig: TEST_MONITOR_CONFIG,
      ctx: createTradeContextDouble(tradeCtx),
      rateLimiter: createRateLimiter(),
      cacheManager: createCacheManager(),
      orderHoldRegistry: createOrderHoldRegistry(),
      orderRecorder: createOrderRecorderDouble(),
      recordCumulativeExecution: () => {},
      orderStatusQuery: {
        checkOrderState: async () => ({
          kind: 'QUERY_FAILED' as const,
          errorCode: '603001',
        }),
      },
      triggerRoute: () => {},
    });

    try {
      await orderOps.cancelOrder('ORDER-CANCEL-CODED-TRANSIENT', { kind: 'ORDER_FACT' });
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({
        name: 'ExternalApiRequestError',
        operation: 'TradeContext.cancelOrder',
      });
      expect(cancelCallCount).toBeGreaterThan(1);
    }
  });

  it('cancelOrder 在暂态失败后的重试前重新授权，授权失效时不再次调用 SDK', async () => {
    const runtime = createRuntimeStore();
    const tradeCtx = createTradeContextMock();
    let authorized = true;
    let cancelCallCount = 0;
    tradeCtx.cancelOrder = async () => {
      cancelCallCount += 1;
      authorized = false;
      throw new Error('network unavailable');
    };
    const orderOps = createOrderOps({
      runtime,
      monitorConfig: TEST_MONITOR_CONFIG,
      ctx: createTradeContextDouble(tradeCtx),
      rateLimiter: createRateLimiter(),
      cacheManager: createCacheManager(),
      orderHoldRegistry: createOrderHoldRegistry(),
      orderRecorder: createOrderRecorderDouble(),
      recordCumulativeExecution: () => {},
      orderStatusQuery: {
        checkOrderState: async () => ({
          kind: 'QUERY_FAILED' as const,
          errorCode: '603001',
        }),
      },
      triggerRoute: () => {},
    });

    await orderOps.cancelOrder('ORDER-CANCEL-AUTH-REVOKED', {
      kind: 'SIGNAL_AUTHORIZED',
      authorize: () => authorized,
    });

    expect(cancelCallCount).toBe(1);
  });

  it('cancelOrder does not retry known business error codes even when message contains retry hints', async () => {
    const runtime = createRuntimeStore();
    const tradeCtx = createTradeContextMock();
    let cancelCallCount = 0;
    tradeCtx.cancelOrder = async () => {
      cancelCallCount += 1;
      throw new Error('openapi error: code=601011: order already cancelled after network delay');
    };
    const orderOps = createOrderOps({
      runtime,
      monitorConfig: TEST_MONITOR_CONFIG,
      ctx: createTradeContextDouble(tradeCtx),
      rateLimiter: createRateLimiter(),
      cacheManager: createCacheManager(),
      orderHoldRegistry: createOrderHoldRegistry(),
      orderRecorder: createOrderRecorderDouble(),
      recordCumulativeExecution: () => {},
      orderStatusQuery: {
        checkOrderState: async () => ({
          kind: 'TERMINAL' as const,
          closedReason: 'CANCELED' as const,
          status: 15,
          executedPrice: null,
          executedQuantity: 0,
          submittedQuantity: 100,
          orderUpdatedAtMs: null,
        }),
      },
      triggerRoute: () => {},
    });

    const outcome = await orderOps.cancelOrder('ORDER-CANCEL-BUSINESS-NO-RETRY', {
      kind: 'ORDER_FACT',
    });

    expect(cancelCallCount).toBe(1);
    expect(outcome.kind).toBe('ALREADY_CLOSED');
  });

  it('replaceOrderPrice does not retry known business error codes even when message contains retry hints', async () => {
    const runtime = createRuntimeStore();
    const tradeCtx = createTradeContextMock();
    let replaceCallCount = 0;
    tradeCtx.replaceOrder = async () => {
      replaceCallCount += 1;
      throw new Error('openapi error: code=602012: unsupported order type after timeout');
    };
    const orderOps = createOrderOps({
      runtime,
      monitorConfig: TEST_MONITOR_CONFIG,
      ctx: createTradeContextDouble(tradeCtx),
      rateLimiter: createRateLimiter(),
      cacheManager: createCacheManager(),
      orderHoldRegistry: createOrderHoldRegistry(),
      orderRecorder: createOrderRecorderDouble(),
      recordCumulativeExecution: () => {},
      orderStatusQuery: {
        checkOrderState: async () => ({
          kind: 'QUERY_FAILED' as const,
          errorCode: '603001',
        }),
      },
      triggerRoute: () => {},
    });
    orderOps.trackOrder({
      orderId: 'ORDER-REPLACE-BUSINESS-NO-RETRY',
      symbol: 'BULL.HK',
      side: OrderSide.Buy,
      price: 1.01,
      initialSubmittedPrice: 1.01,
      quantity: 100,
      initialStatus: OrderStatus.New,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: OrderType.ELO,
    });

    await orderOps.replaceOrderPrice('ORDER-REPLACE-BUSINESS-NO-RETRY', 1.23, {
      kind: 'ORDER_FACT',
    });

    expect(replaceCallCount).toBe(1);
    expect(runtime.latestReplaceTerminalByOrderId.has('ORDER-REPLACE-BUSINESS-NO-RETRY')).toBe(
      false,
    );
  });

  it('replaceOrderPrice retries coded transient service errors', async () => {
    const runtime = createRuntimeStore();
    const tradeCtx = createTradeContextMock();
    let replaceCallCount = 0;
    tradeCtx.replaceOrder = async () => {
      replaceCallCount += 1;
      throw new Error('openapi error: code=503: service unavailable');
    };
    const orderOps = createOrderOps({
      runtime,
      monitorConfig: TEST_MONITOR_CONFIG,
      ctx: createTradeContextDouble(tradeCtx),
      rateLimiter: createRateLimiter(),
      cacheManager: createCacheManager(),
      orderHoldRegistry: createOrderHoldRegistry(),
      orderRecorder: createOrderRecorderDouble(),
      recordCumulativeExecution: () => {},
      orderStatusQuery: {
        checkOrderState: async () => ({
          kind: 'QUERY_FAILED' as const,
          errorCode: '603001',
        }),
      },
      triggerRoute: () => {},
    });
    orderOps.trackOrder({
      orderId: 'ORDER-REPLACE-CODED-TRANSIENT',
      symbol: 'BULL.HK',
      side: OrderSide.Buy,
      price: 1.01,
      initialSubmittedPrice: 1.01,
      quantity: 100,
      initialStatus: OrderStatus.New,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: OrderType.ELO,
    });

    try {
      await orderOps.replaceOrderPrice('ORDER-REPLACE-CODED-TRANSIENT', 1.23, {
        kind: 'ORDER_FACT',
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({
        name: 'ExternalApiRequestError',
        operation: 'TradeContext.replaceOrder',
      });
      expect(replaceCallCount).toBeGreaterThan(1);
    }
  });

  it('replaceOrderPrice retries repeated request failures and rethrows ExternalApiRequestError', async () => {
    const runtime = createRuntimeStore();
    const tradeCtx = createTradeContextMock();
    let replaceCallCount = 0;
    tradeCtx.replaceOrder = async () => {
      replaceCallCount += 1;
      throw new Error('network unavailable');
    };
    const orderOps = createOrderOps({
      runtime,
      monitorConfig: TEST_MONITOR_CONFIG,
      ctx: createTradeContextDouble(tradeCtx),
      rateLimiter: createRateLimiter(),
      cacheManager: createCacheManager(),
      orderHoldRegistry: createOrderHoldRegistry(),
      orderRecorder: createOrderRecorderDouble(),
      recordCumulativeExecution: () => {},
      orderStatusQuery: {
        checkOrderState: async () => ({
          kind: 'QUERY_FAILED' as const,
          errorCode: '603001',
        }),
      },
      triggerRoute: () => {},
    });
    orderOps.trackOrder({
      orderId: 'ORDER-REPLACE-RETRY',
      symbol: 'BULL.HK',
      side: OrderSide.Buy,
      price: 1.01,
      initialSubmittedPrice: 1.01,
      quantity: 100,
      initialStatus: OrderStatus.New,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: OrderType.ELO,
    });

    try {
      await orderOps.replaceOrderPrice('ORDER-REPLACE-RETRY', 1.23, { kind: 'ORDER_FACT' }, 1000);
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({
        name: 'ExternalApiRequestError',
        operation: 'TradeContext.replaceOrder',
      });
      expect(replaceCallCount).toBeGreaterThan(1);
    }
  });

  it('replaceOrderPrice 在暂态失败后的重试前重新授权，授权失效时不再次调用 SDK', async () => {
    const runtime = createRuntimeStore();
    const tradeCtx = createTradeContextMock();
    let authorized = true;
    let replaceCallCount = 0;
    tradeCtx.replaceOrder = async () => {
      replaceCallCount += 1;
      authorized = false;
      throw new Error('network unavailable');
    };
    const orderOps = createOrderOps({
      runtime,
      monitorConfig: TEST_MONITOR_CONFIG,
      ctx: createTradeContextDouble(tradeCtx),
      rateLimiter: createRateLimiter(),
      cacheManager: createCacheManager(),
      orderHoldRegistry: createOrderHoldRegistry(),
      orderRecorder: createOrderRecorderDouble(),
      recordCumulativeExecution: () => {},
      orderStatusQuery: {
        checkOrderState: async () => ({
          kind: 'QUERY_FAILED' as const,
          errorCode: '603001',
        }),
      },
      triggerRoute: () => {},
    });
    orderOps.trackOrder({
      orderId: 'ORDER-REPLACE-AUTH-REVOKED',
      symbol: 'BULL.HK',
      side: OrderSide.Buy,
      price: 1.01,
      initialSubmittedPrice: 1.01,
      quantity: 100,
      initialStatus: OrderStatus.New,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: OrderType.ELO,
    });

    await orderOps.replaceOrderPrice(
      'ORDER-REPLACE-AUTH-REVOKED',
      1.23,
      { kind: 'SIGNAL_AUTHORIZED', authorize: () => authorized },
      100,
    );

    expect(replaceCallCount).toBe(1);
  });

  it('replaceOrderPrice 在订单脱离追踪后不会写回过期结果', async () => {
    const runtime = createRuntimeStore();
    const replaceStarted = createDeferred();
    const releaseReplace = createDeferred();
    const tradeCtx = createTradeContextMock();
    let replaceCallCount = 0;
    tradeCtx.replaceOrder = async () => {
      replaceCallCount += 1;
      replaceStarted.resolve();
      await releaseReplace.promise;
    };
    const deps = {
      runtime,
      monitorConfig: TEST_MONITOR_CONFIG,
      ctx: createTradeContextDouble(tradeCtx),
      rateLimiter: createRateLimiter(),
      cacheManager: createCacheManager(),
      orderHoldRegistry: createOrderHoldRegistry(),
      orderRecorder: createOrderRecorderDouble(),
      recordCumulativeExecution: () => {},
      orderStatusQuery: {
        checkOrderState: async () => ({
          kind: 'QUERY_FAILED' as const,
          errorCode: '603001',
        }),
      },
      triggerRoute: () => {},
    };
    const orderOps = createOrderOps(deps);
    orderOps.trackOrder({
      orderId: 'ORDER-STALE-REPLACE-1',
      symbol: 'BULL.HK',
      side: OrderSide.Buy,
      price: 1.01,
      initialSubmittedPrice: 1.01,
      quantity: 100,
      initialStatus: OrderStatus.New,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: OrderType.ELO,
    });
    const trackedOrder = runtime.trackedOrders.get('ORDER-STALE-REPLACE-1');
    if (!trackedOrder) {
      throw new Error('missing tracked order for stale replace test');
    }

    const replacePromise = orderOps.replaceOrderPrice('ORDER-STALE-REPLACE-1', 1.23, {
      kind: 'ORDER_FACT',
    });
    await replaceStarted.promise;
    runtime.trackedOrders.delete('ORDER-STALE-REPLACE-1');
    runtime.trackedOrderLifecycles.set('ORDER-STALE-REPLACE-1', 'CLOSED');
    runtime.trackedOrderIdsBySymbol.delete('BULL.HK');
    runtime.routeStatesBySymbol.delete('BULL.HK');
    runtime.closedOrderIds.add('ORDER-STALE-REPLACE-1');
    releaseReplace.resolve();
    const replaceOutcome = await replacePromise;

    expect(replaceCallCount).toBe(1);
    expect(replaceOutcome).toEqual({ kind: 'BROKER_CONFIRMED' });
    expect(runtime.latestReplaceTerminalByOrderId.has('ORDER-STALE-REPLACE-1')).toBe(false);
    expect(runtime.queriedTerminalStateByOrderId.has('ORDER-STALE-REPLACE-1')).toBe(false);
    expect(trackedOrder.submittedPrice).toBe(1.01);
    expect(trackedOrder.submittedQuantity).toBe(100);
  });

  it('replaceOrderPrice 在 broker API 前脱离追踪时返回 NOT_EXECUTED 且不调用 SDK', async () => {
    const runtime = createRuntimeStore();
    const throttleStarted = createDeferred();
    const releaseThrottle = createDeferred();
    const tradeCtx = createTradeContextMock();
    let replaceCallCount = 0;
    tradeCtx.replaceOrder = async () => {
      replaceCallCount += 1;
    };
    const orderOps = createOrderOps({
      runtime,
      monitorConfig: TEST_MONITOR_CONFIG,
      ctx: createTradeContextDouble(tradeCtx),
      rateLimiter: {
        throttle: async () => {},
        withTradeMutation: async <T>(
          callback: (permit: MutationPermitDouble) => Promise<T>,
        ): Promise<T> => {
          throttleStarted.resolve();
          await releaseThrottle.promise;
          return callback({
            invoke: async <TResult>(operation: () => Promise<TResult>): Promise<TResult> =>
              operation(),
          });
        },
      },
      cacheManager: createCacheManager(),
      orderHoldRegistry: createOrderHoldRegistry(),
      orderRecorder: createOrderRecorderDouble(),
      recordCumulativeExecution: () => {},
      orderStatusQuery: {
        checkOrderState: async () => ({
          kind: 'QUERY_FAILED',
          errorCode: '603001',
        }),
      },
      triggerRoute: () => {},
    });
    orderOps.trackOrder({
      orderId: 'ORDER-DETACHED-BEFORE-API',
      symbol: 'BULL.HK',
      side: OrderSide.Buy,
      price: 1.01,
      initialSubmittedPrice: 1.01,
      quantity: 100,
      initialStatus: OrderStatus.New,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: OrderType.ELO,
    });

    const replacePromise = orderOps.replaceOrderPrice('ORDER-DETACHED-BEFORE-API', 1.23, {
      kind: 'ORDER_FACT',
    });
    await throttleStarted.promise;
    runtime.trackedOrders.delete('ORDER-DETACHED-BEFORE-API');
    releaseThrottle.resolve();

    const replaceOutcome = await replacePromise;
    expect(replaceOutcome).toEqual({ kind: 'NOT_EXECUTED' });
    expect(replaceCallCount).toBe(0);
  });

  it('撤单业务失败后的 OPEN state-check 会记录新增累计成交事实', async () => {
    const runtime = createRuntimeStore();
    const tradeCtx = createTradeContextMock();
    tradeCtx.cancelOrder = async () => {
      throw new Error('openapi error: code=601011: order cannot be cancelled');
    };
    const partialFills: Array<Readonly<{ orderId: string; filledQuantity: number }>> = [];
    const cumulativeExecutions: Array<
      Readonly<{
        orderId: string;
        executedQuantity: number | null;
        orderUpdatedAtMs: number | null;
      }>
    > = [];
    const orderOps = createOrderOps({
      runtime,
      monitorConfig: TEST_MONITOR_CONFIG,
      ctx: createTradeContextDouble(tradeCtx),
      rateLimiter: createRateLimiter(),
      cacheManager: createCacheManager(),
      orderHoldRegistry: createOrderHoldRegistry(),
      orderRecorder: createOrderRecorderDouble({
        markSellPartialFilled: (orderId, filledQuantity) => {
          partialFills.push({ orderId, filledQuantity });
          return null;
        },
      }),
      recordCumulativeExecution: (params) => {
        cumulativeExecutions.push(params);
      },
      orderStatusQuery: {
        checkOrderState: async () => ({
          kind: 'OPEN' as const,
          status: OrderStatus.PartialFilled,
          executedPrice: 1.02,
          executedQuantity: 40,
          updatedAtMs: 200,
        }),
      },
      triggerRoute: () => {},
    });
    orderOps.trackOrder({
      orderId: 'SELL-CANCEL-OPEN-PARTIAL',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      price: 1.01,
      initialSubmittedPrice: 1.01,
      quantity: 100,
      initialStatus: OrderStatus.New,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: true,
      orderType: OrderType.ELO,
    });

    await orderOps.cancelOrder('SELL-CANCEL-OPEN-PARTIAL', { kind: 'ORDER_FACT' });

    expect(runtime.trackedOrders.get('SELL-CANCEL-OPEN-PARTIAL')).toMatchObject({
      status: OrderStatus.PartialFilled,
      executedPrice: 1.02,
      executedQuantity: 40,
      lastExecutedTimeMs: 200,
      lastOrderUpdateAtMs: 200,
    });
    expect(partialFills).toEqual([{ orderId: 'SELL-CANCEL-OPEN-PARTIAL', filledQuantity: 40 }]);
    expect(cumulativeExecutions).toEqual([
      expect.objectContaining({
        orderId: 'SELL-CANCEL-OPEN-PARTIAL',
        executedQuantity: 40,
        orderUpdatedAtMs: 200,
        isProtectiveLiquidation: true,
      }),
    ]);
  });

  it('撤单业务错误的无效 state-check revision 不会阻断后续有效 revision', async () => {
    const runtime = createRuntimeStore();
    const tradeCtx = createTradeContextMock();
    const orderId = 'BUY-CANCEL-OPEN-INVALID-REVISION';
    const validUpdatedAtMs = Date.parse('2026-07-14T02:00:00.000Z');
    let updatedAt: unknown = new Date(Number.NaN);
    tradeCtx.cancelOrder = async () => {
      throw new Error('openapi error: code=601011: order cannot be cancelled');
    };

    tradeCtx.orderDetail = async (requestedOrderId) => {
      // 外部 SDK 边界允许错误时间类型；其余字段与订单详情最小事实一致。
      return {
        orderId: requestedOrderId,
        status: OrderStatus.New,
        stockName: 'BULL',
        quantity: new Decimal(100),
        executedQuantity: new Decimal(0),
        price: new Decimal(1),
        executedPrice: new Decimal(0),
        submittedAt: new Date('2026-07-14T01:00:00.000Z'),
        side: OrderSide.Buy,
        symbol: 'BULL.HK',
        orderType: OrderType.ELO,
        updatedAt,
      } as unknown as OrderDetail;
    };
    const rateLimiter = createRateLimiter();
    const orderOps = createOrderOps({
      runtime,
      monitorConfig: TEST_MONITOR_CONFIG,
      ctx: createTradeContextDouble(tradeCtx),
      rateLimiter,
      cacheManager: createCacheManager(),
      orderHoldRegistry: createOrderHoldRegistry(),
      orderRecorder: createOrderRecorderDouble(),
      recordCumulativeExecution: () => {},
      orderStatusQuery: createOrderStatusQuery({
        ctx: createTradeContextDouble(tradeCtx),
        rateLimiter,
      }),
      triggerRoute: () => {},
    });
    orderOps.trackOrder({
      orderId,
      symbol: 'BULL.HK',
      side: OrderSide.Buy,
      price: 1,
      initialSubmittedPrice: 1,
      quantity: 100,
      initialStatus: OrderStatus.New,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: OrderType.ELO,
    });
    const trackedOrder = runtime.trackedOrders.get(orderId);
    if (trackedOrder === undefined) {
      throw new Error('missing tracked order for state-check revision test');
    }

    await orderOps.cancelOrder(orderId, { kind: 'ORDER_FACT' });

    expect(trackedOrder.lastOrderUpdateAtMs).toBeNull();

    updatedAt = new Date(validUpdatedAtMs);
    await orderOps.cancelOrder(orderId, { kind: 'ORDER_FACT' });

    expect(trackedOrder.lastOrderUpdateAtMs).toBe(validUpdatedAtMs);
  });

  it.each([null, 0] as const)(
    'OPEN state-check 累计量推进但成交价为 %s 时拒绝且不推进本地与累计副作用',
    async (incomingPrice) => {
      const runtime = createRuntimeStore();
      const tradeCtx = createTradeContextMock();
      tradeCtx.cancelOrder = async () => {
        throw new Error('openapi error: code=601011: order cannot be cancelled');
      };
      let cumulativeExecutionCount = 0;
      const orderOps = createOrderOps({
        runtime,
        monitorConfig: TEST_MONITOR_CONFIG,
        ctx: createTradeContextDouble(tradeCtx),
        rateLimiter: createRateLimiter(),
        cacheManager: createCacheManager(),
        orderHoldRegistry: createOrderHoldRegistry(),
        orderRecorder: createOrderRecorderDouble(),
        recordCumulativeExecution: () => {
          cumulativeExecutionCount += 1;
        },
        orderStatusQuery: {
          checkOrderState: async () => ({
            kind: 'OPEN',
            status: OrderStatus.PartialFilled,
            executedPrice: incomingPrice,
            executedQuantity: 100,
            updatedAtMs: 200,
          }),
        },
        triggerRoute: () => {},
      });
      orderOps.trackOrder({
        orderId: 'SELL-CANCEL-OPEN-INVALID-PRICE',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        price: 1.01,
        initialSubmittedPrice: 1.01,
        quantity: 100,
        initialStatus: OrderStatus.PartialFilled,
        isLongSymbol: true,
        monitorSymbol: 'HSI.HK',
        isProtectiveLiquidation: true,
        orderType: OrderType.ELO,
      });
      const trackedOrder = runtime.trackedOrders.get('SELL-CANCEL-OPEN-INVALID-PRICE');
      if (!trackedOrder) {
        throw new Error('missing tracked order for invalid OPEN state-check test');
      }

      trackedOrder.executedQuantity = 40;
      trackedOrder.executedPrice = 1;
      trackedOrder.lastExecutedTimeMs = 100;
      trackedOrder.lastOrderUpdateAtMs = 100;

      let caughtError: unknown = null;
      try {
        await orderOps.cancelOrder('SELL-CANCEL-OPEN-INVALID-PRICE', { kind: 'ORDER_FACT' });
      } catch (error) {
        caughtError = error;
      }

      expect(caughtError).toBeInstanceOf(Error);
      expect(caughtError).toHaveProperty(
        'message',
        expect.stringContaining('累计成交数量推进但缺少有效成交价'),
      );

      expect(trackedOrder).toMatchObject({
        status: OrderStatus.PartialFilled,
        executedQuantity: 40,
        executedPrice: 1,
        lastExecutedTimeMs: 100,
        lastOrderUpdateAtMs: 100,
      });
      expect(cumulativeExecutionCount).toBe(0);
    },
  );

  it('OPEN state-check 的累计成交量超过当前有效委托量时不推进本地或累计副作用', async () => {
    const runtime = createRuntimeStore();
    const tradeCtx = createTradeContextMock();
    tradeCtx.cancelOrder = async () => {
      throw new Error('openapi error: code=601011: order cannot be cancelled');
    };
    let cumulativeExecutionCount = 0;
    const orderOps = createOrderOps({
      runtime,
      monitorConfig: TEST_MONITOR_CONFIG,
      ctx: createTradeContextDouble(tradeCtx),
      rateLimiter: createRateLimiter(),
      cacheManager: createCacheManager(),
      orderHoldRegistry: createOrderHoldRegistry(),
      orderRecorder: createOrderRecorderDouble(),
      recordCumulativeExecution: () => {
        cumulativeExecutionCount += 1;
      },
      orderStatusQuery: {
        checkOrderState: async () => ({
          kind: 'OPEN',
          status: OrderStatus.PartialFilled,
          executedPrice: 1.02,
          executedQuantity: 101,
          updatedAtMs: 200,
        }),
      },
      triggerRoute: () => {},
    });
    orderOps.trackOrder({
      orderId: 'SELL-CANCEL-OPEN-EXCEEDS-SUBMITTED',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      price: 1.01,
      initialSubmittedPrice: 1.01,
      quantity: 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: true,
      orderType: OrderType.ELO,
    });
    const trackedOrder = runtime.trackedOrders.get('SELL-CANCEL-OPEN-EXCEEDS-SUBMITTED');
    if (trackedOrder === undefined) {
      throw new Error('missing tracked order for excessive OPEN state-check test');
    }

    expect(
      orderOps.cancelOrder('SELL-CANCEL-OPEN-EXCEEDS-SUBMITTED', { kind: 'ORDER_FACT' }),
    ).rejects.toThrow(/累计成交量超过有效委托数量/);

    expect(trackedOrder.executedQuantity).toBe(0);
    expect(cumulativeExecutionCount).toBe(0);
  });

  it.each([
    [
      '成交价',
      {
        kind: 'OPEN' as const,
        status: OrderStatus.PartialFilled,
        executedPrice: null,
        executedQuantity: 40,
        updatedAtMs: 200,
      },
    ],
    [
      '累计成交数量',
      {
        kind: 'OPEN' as const,
        status: OrderStatus.PartialFilled,
        executedPrice: 1.02,
        executedQuantity: null,
        updatedAtMs: 200,
      },
    ],
    [
      '原始执行/修订时间',
      {
        kind: 'OPEN' as const,
        status: OrderStatus.PartialFilled,
        executedPrice: 1.02,
        executedQuantity: 40,
        updatedAtMs: null,
      },
    ],
  ] as const)(
    '保护性 SELL OPEN state-check 缺少原始%s时不得借用 tracked 事实推进本地状态',
    async (_missingField, queryResult) => {
      const runtime = createRuntimeStore();
      const tradeCtx = createTradeContextMock();
      tradeCtx.cancelOrder = async () => {
        throw new Error('openapi error: code=601011: order cannot be cancelled');
      };
      const partialFills: number[] = [];
      let durableProgressCalls = 0;
      const orderOps = createOrderOps({
        runtime,
        monitorConfig: TEST_MONITOR_CONFIG,
        ctx: createTradeContextDouble(tradeCtx),
        rateLimiter: createRateLimiter(),
        cacheManager: createCacheManager(),
        orderHoldRegistry: createOrderHoldRegistry(),
        orderRecorder: createOrderRecorderDouble({
          markSellPartialFilled: (_orderId, filledQuantity) => {
            partialFills.push(filledQuantity);
            return null;
          },
        }),
        recordCumulativeExecution: () => {
          durableProgressCalls += 1;
        },
        orderStatusQuery: {
          checkOrderState: async () => queryResult,
        },
        triggerRoute: () => {},
      });
      orderOps.trackOrder({
        orderId: 'SELL-CANCEL-OPEN-RAW-FACT',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        price: 1.01,
        initialSubmittedPrice: 1.01,
        quantity: 100,
        initialStatus: OrderStatus.PartialFilled,
        isLongSymbol: true,
        monitorSymbol: 'HSI.HK',
        isProtectiveLiquidation: true,
        orderType: OrderType.ELO,
      });
      const trackedOrder = runtime.trackedOrders.get('SELL-CANCEL-OPEN-RAW-FACT');
      if (trackedOrder === undefined) {
        throw new Error('missing tracked order for raw OPEN state-check test');
      }

      trackedOrder.executedQuantity = 40;
      trackedOrder.executedPrice = 1;
      trackedOrder.lastExecutedTimeMs = 100;
      trackedOrder.lastOrderUpdateAtMs = 100;

      let caughtError: unknown = null;
      try {
        await orderOps.cancelOrder('SELL-CANCEL-OPEN-RAW-FACT', { kind: 'ORDER_FACT' });
      } catch (error) {
        caughtError = error;
      }

      expect(caughtError).toBeInstanceOf(Error);
      expect(caughtError).toHaveProperty(
        'message',
        expect.stringMatching(/保护性 SELL|无效累计成交数量/),
      );

      expect(trackedOrder).toMatchObject({
        status: OrderStatus.PartialFilled,
        executedQuantity: 40,
        executedPrice: 1,
        lastExecutedTimeMs: 100,
        lastOrderUpdateAtMs: 100,
      });
      expect(partialFills).toEqual([]);
      expect(durableProgressCalls).toBe(0);
    },
  );

  it('保护性 SELL OPEN state-check 的 durable progress 抛错时不得写入 tracked 或 pending sell', async () => {
    const runtime = createRuntimeStore();
    const tradeCtx = createTradeContextMock();
    tradeCtx.cancelOrder = async () => {
      throw new Error('openapi error: code=601011: order cannot be cancelled');
    };
    const persistenceError = new Error('protective OPEN progress persistence failed');
    const partialFills: number[] = [];
    const orderOps = createOrderOps({
      runtime,
      monitorConfig: TEST_MONITOR_CONFIG,
      ctx: createTradeContextDouble(tradeCtx),
      rateLimiter: createRateLimiter(),
      cacheManager: createCacheManager(),
      orderHoldRegistry: createOrderHoldRegistry(),
      orderRecorder: createOrderRecorderDouble({
        markSellPartialFilled: (_orderId, filledQuantity) => {
          partialFills.push(filledQuantity);
          return null;
        },
      }),
      recordCumulativeExecution: () => {
        throw persistenceError;
      },
      orderStatusQuery: {
        checkOrderState: async () => ({
          kind: 'OPEN' as const,
          status: OrderStatus.PartialFilled,
          executedPrice: 1.02,
          executedQuantity: 40,
          updatedAtMs: 200,
        }),
      },
      triggerRoute: () => {},
    });
    orderOps.trackOrder({
      orderId: 'SELL-CANCEL-OPEN-DURABLE-FIRST',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      price: 1.01,
      initialSubmittedPrice: 1.01,
      quantity: 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: true,
      orderType: OrderType.ELO,
    });
    const trackedOrder = runtime.trackedOrders.get('SELL-CANCEL-OPEN-DURABLE-FIRST');
    if (trackedOrder === undefined) {
      throw new Error('missing tracked order for durable OPEN state-check test');
    }

    let caughtError: unknown = null;
    try {
      await orderOps.cancelOrder('SELL-CANCEL-OPEN-DURABLE-FIRST', { kind: 'ORDER_FACT' });
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBe(persistenceError);

    expect(trackedOrder).toMatchObject({
      status: OrderStatus.New,
      executedQuantity: 0,
      executedPrice: null,
      lastExecutedTimeMs: null,
      lastOrderUpdateAtMs: null,
    });
    expect(partialFills).toEqual([]);
  });

  it('改单业务失败后的 OPEN state-check 会记录新增累计成交事实', async () => {
    const runtime = createRuntimeStore();
    const tradeCtx = createTradeContextMock();
    tradeCtx.replaceOrder = async () => {
      throw new Error('openapi error: code=601011: order state changed');
    };
    const partialFills: Array<Readonly<{ orderId: string; filledQuantity: number }>> = [];
    const cumulativeExecutions: Array<
      Readonly<{ orderId: string; executedQuantity: number | null }>
    > = [];
    const orderOps = createOrderOps({
      runtime,
      monitorConfig: TEST_MONITOR_CONFIG,
      ctx: createTradeContextDouble(tradeCtx),
      rateLimiter: createRateLimiter(),
      cacheManager: createCacheManager(),
      orderHoldRegistry: createOrderHoldRegistry(),
      orderRecorder: createOrderRecorderDouble({
        markSellPartialFilled: (orderId, filledQuantity) => {
          partialFills.push({ orderId, filledQuantity });
          return null;
        },
      }),
      recordCumulativeExecution: (params) => {
        cumulativeExecutions.push(params);
      },
      orderStatusQuery: {
        checkOrderState: async () => ({
          kind: 'OPEN' as const,
          status: OrderStatus.PartialFilled,
          executedPrice: 1.03,
          executedQuantity: 60,
          updatedAtMs: 300,
        }),
      },
      triggerRoute: () => {},
    });
    orderOps.trackOrder({
      orderId: 'SELL-REPLACE-OPEN-PARTIAL',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      price: 1.01,
      initialSubmittedPrice: 1.01,
      quantity: 100,
      initialStatus: OrderStatus.New,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: true,
      orderType: OrderType.ELO,
    });

    await orderOps.replaceOrderPrice('SELL-REPLACE-OPEN-PARTIAL', 1.04, {
      kind: 'ORDER_FACT',
    });

    expect(runtime.trackedOrders.get('SELL-REPLACE-OPEN-PARTIAL')).toMatchObject({
      status: OrderStatus.PartialFilled,
      executedPrice: 1.03,
      executedQuantity: 60,
      lastExecutedTimeMs: 300,
      lastOrderUpdateAtMs: 300,
    });
    expect(partialFills).toEqual([{ orderId: 'SELL-REPLACE-OPEN-PARTIAL', filledQuantity: 60 }]);
    expect(cumulativeExecutions).toEqual([
      expect.objectContaining({
        orderId: 'SELL-REPLACE-OPEN-PARTIAL',
        executedQuantity: 60,
        isProtectiveLiquidation: true,
      }),
    ]);
  });

  it('连续 602013 后的 OPEN state-check 会在转入 WAIT_WS_ONLY 前记录成交事实', async () => {
    const runtime = createRuntimeStore();
    const tradeCtx = createTradeContextMock();
    tradeCtx.replaceOrder = async () => {
      throw new Error('openapi error: code=602013: current status does not allow replace');
    };
    const partialFills: Array<Readonly<{ orderId: string; filledQuantity: number }>> = [];
    const cumulativeExecutions: Array<
      Readonly<{ orderId: string; executedQuantity: number | null }>
    > = [];
    const orderOps = createOrderOps({
      runtime,
      monitorConfig: TEST_MONITOR_CONFIG,
      ctx: createTradeContextDouble(tradeCtx),
      rateLimiter: createRateLimiter(),
      cacheManager: createCacheManager(),
      orderHoldRegistry: createOrderHoldRegistry(),
      orderRecorder: createOrderRecorderDouble({
        markSellPartialFilled: (orderId, filledQuantity) => {
          partialFills.push({ orderId, filledQuantity });
          return null;
        },
      }),
      recordCumulativeExecution: (params) => {
        cumulativeExecutions.push(params);
      },
      orderStatusQuery: {
        checkOrderState: async () => ({
          kind: 'OPEN' as const,
          status: OrderStatus.PartialFilled,
          executedPrice: 1.05,
          executedQuantity: 80,
          updatedAtMs: 400,
        }),
      },
      triggerRoute: () => {},
    });
    orderOps.trackOrder({
      orderId: 'SELL-REPLACE-602013-OPEN-PARTIAL',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      price: 1.01,
      initialSubmittedPrice: 1.01,
      quantity: 100,
      initialStatus: OrderStatus.New,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: true,
      orderType: OrderType.ELO,
    });
    const trackedOrder = runtime.trackedOrders.get('SELL-REPLACE-602013-OPEN-PARTIAL');
    if (trackedOrder === undefined) {
      throw new Error('missing tracked order for 602013 state-check test');
    }

    for (let attempt = 0; attempt < 5; attempt += 1) {
      trackedOrder.replaceBlockedUntilAt = null;
      await orderOps.replaceOrderPrice('SELL-REPLACE-602013-OPEN-PARTIAL', 1.04, {
        kind: 'ORDER_FACT',
      });
    }

    expect(trackedOrder).toMatchObject({
      status: OrderStatus.PartialFilled,
      executedPrice: 1.05,
      executedQuantity: 80,
      lastExecutedTimeMs: 400,
      lastOrderUpdateAtMs: 400,
      replaceCapability: 'TEMP_BLOCKED_BY_STATUS',
      replaceResumeMode: 'WAIT_WS_ONLY',
    });

    expect(partialFills).toEqual([
      { orderId: 'SELL-REPLACE-602013-OPEN-PARTIAL', filledQuantity: 80 },
    ]);

    expect(cumulativeExecutions).toEqual([
      expect.objectContaining({
        orderId: 'SELL-REPLACE-602013-OPEN-PARTIAL',
        executedQuantity: 80,
      }),
    ]);
  });

  it.each([
    [1, 1_000, 0],
    [2, 2_000, 1],
    [3, 4_000, 2],
    [4, 8_000, 3],
  ] as const)(
    '602013 第 %i 次保留 %i 毫秒有限退避且不提前查询订单状态',
    async (retryCount, expectedBackoffMs, previousRetryCount) => {
      const { runtime, orderOps, trackedOrder, getStateCheckCalls } =
        createReplaceTempBlockedHarness();
      trackedOrder.replaceTempBlockedCount = previousRetryCount;

      const outcome = await orderOps.replaceOrderPrice(trackedOrder.orderId, 1.01, {
        kind: 'ORDER_FACT',
      });

      expect(outcome).toEqual({ kind: 'NOT_EXECUTED' });
      expect(trackedOrder).toMatchObject({
        replaceCapability: 'TEMP_BLOCKED_BY_STATUS',
        replaceTempBlockedCount: retryCount,
        replaceResumeMode: 'TIME_BACKOFF',
      });
      const nextRetryAtMs = trackedOrder.replaceBlockedUntilAt;
      if (nextRetryAtMs === null) {
        throw new Error('[测试] TIME_BACKOFF 必须写入下一次 retry 时点');
      }

      expect(nextRetryAtMs).toBe(trackedOrder.lastPriceUpdateAt + expectedBackoffMs);

      expect(runtime.latestReplaceTerminalByOrderId.has(trackedOrder.orderId)).toBe(false);
      expect(getStateCheckCalls()).toBe(0);
    },
  );

  it('602013 第 5 次在完整四次退避后查询订单状态并转入 WAIT_WS_ONLY', async () => {
    const { runtime, orderOps, trackedOrder, getStateCheckCalls } =
      createReplaceTempBlockedHarness();
    trackedOrder.replaceTempBlockedCount = 4;

    const outcome = await orderOps.replaceOrderPrice(trackedOrder.orderId, 1.01, {
      kind: 'ORDER_FACT',
    });

    expect(outcome).toEqual({ kind: 'NOT_EXECUTED' });
    expect(trackedOrder).toMatchObject({
      replaceCapability: 'TEMP_BLOCKED_BY_STATUS',
      replaceTempBlockedCount: 5,
      replaceResumeMode: 'WAIT_WS_ONLY',
    });

    expect(runtime.latestReplaceTerminalByOrderId.has(trackedOrder.orderId)).toBe(false);
    expect(getStateCheckCalls()).toBe(1);
  });

  it('602013 退避配置槽缺失时在 broker 错误后立即失败且不写入恢复状态', async () => {
    const { runtime, orderOps, trackedOrder, getReplaceOrderCalls, getStateCheckCalls } =
      createReplaceTempBlockedHarness();
    const backoffSlotIndex = 0;
    const backoffSlot = Object.getOwnPropertyDescriptor(
      ORDER_MONITOR_REPLACE_TEMP_BLOCK_BACKOFF_MS,
      backoffSlotIndex,
    );
    if (backoffSlot === undefined) {
      throw new Error('[测试] 602013 首档退避配置槽不存在');
    }

    const trackedOrderBefore = { ...trackedOrder };
    if (!Reflect.deleteProperty(ORDER_MONITOR_REPLACE_TEMP_BLOCK_BACKOFF_MS, backoffSlotIndex)) {
      throw new Error('[测试] 无法构造 602013 退避配置槽缺失');
    }

    try {
      await expectStateCheckRawFactFailure(
        () => orderOps.replaceOrderPrice(trackedOrder.orderId, 1.01, { kind: 'ORDER_FACT' }),
        /602013.*退避配置缺失/,
      );

      expect(getReplaceOrderCalls()).toBe(1);
      expect(getStateCheckCalls()).toBe(0);
      expect(runtime.latestReplaceTerminalByOrderId.size).toBe(0);
      expect(runtime.queriedTerminalStateByOrderId.size).toBe(0);
      expect(trackedOrder).toEqual(trackedOrderBefore);
    } finally {
      Object.defineProperty(
        ORDER_MONITOR_REPLACE_TEMP_BLOCK_BACKOFF_MS,
        backoffSlotIndex,
        backoffSlot,
      );
    }
  });

  it.each([
    ['negative', -1],
    ['NaN', Number.NaN],
    ['decimal', 1.5],
  ] as const)(
    '602013 retry counter 为 %s 时在写入 retry state 前失败',
    async (_description, invalidRetryCount) => {
      const { runtime, orderOps, trackedOrder, getStateCheckCalls } =
        createReplaceTempBlockedHarness();
      trackedOrder.replaceTempBlockedCount = invalidRetryCount;
      const trackedOrderBefore = { ...trackedOrder };

      await expectStateCheckRawFactFailure(
        () => orderOps.replaceOrderPrice(trackedOrder.orderId, 1.01, { kind: 'ORDER_FACT' }),
        /602013.*重试计数/,
      );

      expect(trackedOrder).toEqual(trackedOrderBefore);
      expect(runtime.latestReplaceTerminalByOrderId.size).toBe(0);
      expect(runtime.queriedTerminalStateByOrderId.size).toBe(0);
      expect(getStateCheckCalls()).toBe(0);
    },
  );

  it.each([OrderStatus.PendingCancel, OrderStatus.WaitToCancel] as const)(
    '已有部分成交的保护性 SELL 收到 %s OPEN state-check 零值事实时拒绝推进',
    async (status) => {
      const runtime = createRuntimeStore();
      const tradeCtx = createTradeContextMock();
      tradeCtx.cancelOrder = async () => {
        throw new Error('openapi error: code=601011: order cannot be cancelled');
      };
      let durableProgressCalls = 0;
      const orderOps = createOrderOps({
        runtime,
        monitorConfig: TEST_MONITOR_CONFIG,
        ctx: createTradeContextDouble(tradeCtx),
        rateLimiter: createRateLimiter(),
        cacheManager: createCacheManager(),
        orderHoldRegistry: createOrderHoldRegistry(),
        orderRecorder: createOrderRecorderDouble(),
        recordCumulativeExecution: () => {
          durableProgressCalls += 1;
        },
        orderStatusQuery: {
          checkOrderState: async () => ({
            kind: 'OPEN' as const,
            status,
            executedPrice: 0,
            executedQuantity: 0,
            updatedAtMs: 300,
          }),
        },
        triggerRoute: () => {},
      });
      orderOps.trackOrder({
        orderId: `SELL-OPEN-${String(status)}-RAW-ZERO`,
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        price: 1.01,
        initialSubmittedPrice: 1.01,
        quantity: 100,
        initialStatus: OrderStatus.PartialFilled,
        isLongSymbol: true,
        monitorSymbol: 'HSI.HK',
        isProtectiveLiquidation: true,
        orderType: OrderType.ELO,
      });
      const trackedOrder = runtime.trackedOrders.get(`SELL-OPEN-${String(status)}-RAW-ZERO`);
      if (trackedOrder === undefined) {
        throw new Error('missing tracked order for protective OPEN raw-zero test');
      }

      trackedOrder.executedQuantity = 40;
      trackedOrder.executedPrice = 1.02;
      trackedOrder.lastExecutedTimeMs = 200;
      trackedOrder.lastOrderUpdateAtMs = 200;

      let caughtError: unknown = null;
      try {
        await orderOps.cancelOrder(trackedOrder.orderId, { kind: 'ORDER_FACT' });
      } catch (error) {
        caughtError = error;
      }

      expect(caughtError).toBeInstanceOf(Error);
      expect(caughtError).toHaveProperty('message', expect.stringMatching(/保护性 SELL/));
      expect(trackedOrder).toMatchObject({
        status: OrderStatus.PartialFilled,
        executedQuantity: 40,
        executedPrice: 1.02,
        lastExecutedTimeMs: 200,
        lastOrderUpdateAtMs: 200,
      });
      expect(durableProgressCalls).toBe(0);
    },
  );

  it.each(['cancel', 'replace'] as const)(
    '保护性 SELL %s state-check 的累计成交推进且 broker revision 倒退时拒绝缓存终态',
    async (operation) => {
      const runtime = createRuntimeStore();
      const tradeCtx = createTradeContextMock();
      const closedError = new Error('openapi error: code=601011: order state changed');
      tradeCtx.cancelOrder = async () => {
        throw closedError;
      };

      tradeCtx.replaceOrder = async () => {
        throw closedError;
      };

      const orderOps = createOrderOps({
        runtime,
        monitorConfig: TEST_MONITOR_CONFIG,
        ctx: createTradeContextDouble(tradeCtx),
        rateLimiter: createRateLimiter(),
        cacheManager: createCacheManager(),
        orderHoldRegistry: createOrderHoldRegistry(),
        orderRecorder: createOrderRecorderDouble(),
        recordCumulativeExecution: () => {},
        orderStatusQuery: {
          checkOrderState: async () => ({
            kind: 'TERMINAL' as const,
            closedReason: 'CANCELED' as const,
            status: OrderStatus.Canceled,
            submittedQuantity: 100,
            executedQuantity: 80,
            executedPrice: 1.01,
            orderUpdatedAtMs: 100,
          }),
        },
        triggerRoute: () => {},
      });
      const orderId = `SELL-${operation.toUpperCase()}-OLDER-REVISION`;
      orderOps.trackOrder({
        orderId,
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        price: 1.01,
        initialSubmittedPrice: 1.01,
        quantity: 100,
        initialStatus: OrderStatus.PartialFilled,
        isLongSymbol: true,
        monitorSymbol: 'HSI.HK',
        isProtectiveLiquidation: true,
        orderType: OrderType.ELO,
      });
      const trackedOrder = runtime.trackedOrders.get(orderId);
      if (trackedOrder === undefined) {
        throw new Error('missing tracked order for protective terminal older-revision test');
      }

      trackedOrder.executedQuantity = 40;
      trackedOrder.executedPrice = 1.02;
      trackedOrder.lastExecutedTimeMs = 190;
      trackedOrder.lastOrderUpdateAtMs = 200;

      let caughtError: unknown = null;
      try {
        const operationResult =
          operation === 'cancel'
            ? orderOps.cancelOrder(orderId, { kind: 'ORDER_FACT' })
            : orderOps.replaceOrderPrice(orderId, 1.03, { kind: 'ORDER_FACT' });
        await operationResult;
      } catch (error) {
        caughtError = error;
      }

      expect(caughtError).toBeInstanceOf(Error);
      expect(caughtError).toHaveProperty('message', expect.stringMatching(/revision/));
      expect(runtime.queriedTerminalStateByOrderId.has(orderId)).toBe(false);
      expect(runtime.latestReplaceTerminalByOrderId.has(orderId)).toBe(false);
      expect(trackedOrder).toMatchObject({
        status: OrderStatus.PartialFilled,
        executedQuantity: 40,
        executedPrice: 1.02,
        lastExecutedTimeMs: 190,
        lastOrderUpdateAtMs: 200,
      });
    },
  );
});

type StateCheckOperation = 'cancel' | 'replace';

/** 将测试故意构造的损坏外部 payload 收窄到状态查询边界类型。 */
function asStateCheckResultFromExternalPayload(payload: unknown): OrderStateCheckResult {
  // 仅测试 SDK/网络边界可能违反静态声明的运行时 payload；生产代码不得使用此断言。
  return payload as OrderStateCheckResult;
}

/** 构造常规订单的 state-check 失败路径，并记录所有可观察副作用。 */
function createStateCheckRawFactHarness(params: {
  readonly operation: StateCheckOperation;
  readonly side: OrderSide;
  readonly stateCheckResult: OrderStateCheckResult;
  readonly isProtectiveLiquidation?: boolean;
  readonly brokerErrorMessage?: string;
}) {
  const runtime = createRuntimeStore();
  runtime.runtimeState = 'BOOTSTRAPPING';
  const tradeCtx = createTradeContextMock();
  const error = new Error(
    params.brokerErrorMessage ?? 'openapi error: code=601011: order state changed',
  );

  tradeCtx.cancelOrder = async () => {
    throw error;
  };

  tradeCtx.replaceOrder = async () => {
    throw error;
  };

  const cacheClearCalls: string[] = [];
  const pendingSellProgress: number[] = [];
  const cumulativeExecutionQuantities: number[] = [];
  const routeWakeups: Array<Readonly<{ symbol: string; kind: string }>> = [];
  const orderOps = createOrderOps({
    runtime,
    monitorConfig: TEST_MONITOR_CONFIG,
    ctx: createTradeContextDouble(tradeCtx),
    rateLimiter: createRateLimiter(),
    cacheManager: {
      getPendingOrders: async () => [],
      clearCache: () => {
        cacheClearCalls.push('clear');
      },
    },
    orderHoldRegistry: createOrderHoldRegistry(),
    orderRecorder: createOrderRecorderDouble({
      markSellPartialFilled: (_orderId, executedQuantity) => {
        pendingSellProgress.push(executedQuantity);
        return null;
      },
    }),
    recordCumulativeExecution: (executionParams) => {
      cumulativeExecutionQuantities.push(executionParams.executedQuantity ?? -1);
    },
    orderStatusQuery: {
      checkOrderState: async () => params.stateCheckResult,
    },
    triggerRoute: (symbol, kind) => {
      routeWakeups.push({ symbol, kind });
    },
  });
  const orderId = `RAW-STATE-CHECK-${params.operation}-${String(params.side)}`;
  orderOps.trackOrder({
    orderId,
    symbol: 'BULL.HK',
    side: params.side,
    price: 1,
    initialSubmittedPrice: 1,
    quantity: 100,
    initialStatus: OrderStatus.New,
    isLongSymbol: true,
    monitorSymbol: 'HSI.HK',
    isProtectiveLiquidation: params.isProtectiveLiquidation ?? false,
    orderType: OrderType.ELO,
  });
  const trackedOrder = runtime.trackedOrders.get(orderId);
  if (trackedOrder === undefined) {
    throw new Error('[测试] 未建立 state-check raw fact tracked order');
  }

  return {
    runtime,
    orderOps,
    orderId,
    trackedOrder,
    cacheClearCalls,
    pendingSellProgress,
    cumulativeExecutionQuantities,
    routeWakeups,
  };
}

/** 以统一方式触发撤单或改单的业务错误 state-check 路径。 */
function runStateCheckOperation(
  operation: StateCheckOperation,
  harness: ReturnType<typeof createStateCheckRawFactHarness>,
): Promise<unknown> {
  if (operation === 'cancel') {
    return harness.orderOps.cancelOrder(harness.orderId, { kind: 'ORDER_FACT' });
  }

  return harness.orderOps.replaceOrderPrice(harness.orderId, 1.01, { kind: 'ORDER_FACT' });
}

/** 断言外部事实被拒绝时未留下任何可驱动结算的本地证据或经济副作用。 */
function expectNoStateCheckRawFactSideEffects(
  harness: ReturnType<typeof createStateCheckRawFactHarness>,
  trackedOrderBefore: OrderMonitorTrackedOrder,
): void {
  expect(harness.runtime.queriedTerminalStateByOrderId.size).toBe(0);
  expect(harness.runtime.latestReplaceTerminalByOrderId.size).toBe(0);
  expect(harness.trackedOrder).toEqual(trackedOrderBefore);
  expect(harness.cacheClearCalls).toEqual([]);
  expect(harness.pendingSellProgress).toEqual([]);
  expect(harness.cumulativeExecutionQuantities).toEqual([]);
  expect(harness.routeWakeups).toEqual([]);
}

/** 断言异步业务入口以预期的外部事实校验错误失败。 */
async function expectStateCheckRawFactFailure(
  operation: () => Promise<unknown>,
  messagePattern: RegExp,
): Promise<void> {
  try {
    await operation();
  } catch (error: unknown) {
    if (!(error instanceof Error)) {
      throw new Error(`[测试] 预期 Error，实际为 ${String(error)}`, { cause: error });
    }

    expect(error.message).toMatch(messagePattern);
    return;
  }

  throw new Error('[测试] 预期 state-check 原始事实校验失败，但操作成功返回');
}

describe('orderMonitor state-check 原始成交事实预检', () => {
  const invalidExecutedQuantities: ReadonlyArray<readonly [string, unknown]> = [
    ['null', null],
    ['NaN', Number.NaN],
    ['negative', -1],
  ];

  for (const side of [OrderSide.Buy, OrderSide.Sell] as const) {
    for (const operation of ['cancel', 'replace'] as const) {
      for (const [description, executedQuantity] of invalidExecutedQuantities) {
        it(`普通 ${side === OrderSide.Buy ? 'BUY' : 'SELL'} ${operation} TERMINAL 原始累计量为 ${description} 时在写入前失败`, async () => {
          const harness = createStateCheckRawFactHarness({
            operation,
            side,
            stateCheckResult: asStateCheckResultFromExternalPayload({
              kind: 'TERMINAL',
              closedReason: 'CANCELED',
              status: OrderStatus.Canceled,
              submittedQuantity: 100,
              executedQuantity,
              executedPrice: null,
              orderUpdatedAtMs: null,
            }),
          });
          const trackedOrderBefore = { ...harness.trackedOrder };

          await expectStateCheckRawFactFailure(
            () => runStateCheckOperation(operation, harness),
            /无效累计成交数量/,
          );

          expectNoStateCheckRawFactSideEffects(harness, trackedOrderBefore);
        });
      }
    }
  }

  for (const side of [OrderSide.Buy, OrderSide.Sell] as const) {
    it(`普通 ${side === OrderSide.Buy ? 'BUY' : 'SELL'} OPEN 原始累计量为 null 时不更新订单事实`, async () => {
      const harness = createStateCheckRawFactHarness({
        operation: 'cancel',
        side,
        stateCheckResult: {
          kind: 'OPEN',
          status: OrderStatus.PartialFilled,
          executedPrice: 1.02,
          executedQuantity: null,
          updatedAtMs: 200,
        },
      });
      const trackedOrderBefore = { ...harness.trackedOrder };

      await expectStateCheckRawFactFailure(
        () => runStateCheckOperation('cancel', harness),
        /无效累计成交数量/,
      );

      expectNoStateCheckRawFactSideEffects(harness, trackedOrderBefore);
    });
  }

  for (const kind of ['OPEN', 'TERMINAL'] as const) {
    it(`第 5 次 602013 的 ${kind} 原始累计量为 null 时不改变退避、价格或状态缓存`, async () => {
      const stateCheckResult: OrderStateCheckResult =
        kind === 'OPEN'
          ? {
              kind: 'OPEN',
              status: OrderStatus.PartialFilled,
              executedPrice: 1.02,
              executedQuantity: null,
              updatedAtMs: 200,
            }
          : {
              kind: 'TERMINAL',
              closedReason: 'CANCELED',
              status: OrderStatus.Canceled,
              submittedQuantity: 100,
              executedPrice: null,
              executedQuantity: null,
              orderUpdatedAtMs: null,
            };
      const harness = createStateCheckRawFactHarness({
        operation: 'replace',
        side: OrderSide.Buy,
        stateCheckResult,
        brokerErrorMessage: 'openapi error: code=602013: order status does not allow amendment',
      });

      for (let retry = 0; retry < 4; retry += 1) {
        harness.trackedOrder.replaceBlockedUntilAt = null;
        await runStateCheckOperation('replace', harness);
      }

      harness.trackedOrder.replaceBlockedUntilAt = null;
      harness.trackedOrder.lastPriceUpdateAt = 1;
      const trackedOrderBefore = { ...harness.trackedOrder };
      expect(harness.runtime.latestReplaceTerminalByOrderId.size).toBe(0);

      await expectStateCheckRawFactFailure(
        () => runStateCheckOperation('replace', harness),
        /无效累计成交数量/,
      );

      expect(harness.trackedOrder).toEqual(trackedOrderBefore);
      expect(harness.runtime.queriedTerminalStateByOrderId.size).toBe(0);
      expect(harness.runtime.latestReplaceTerminalByOrderId.size).toBe(0);
      expect(harness.cacheClearCalls).toEqual([]);
      expect(harness.pendingSellProgress).toEqual([]);
      expect(harness.cumulativeExecutionQuantities).toEqual([]);
      expect(harness.routeWakeups).toEqual([]);
    });
  }

  for (const terminalStatus of [OrderStatus.Canceled, OrderStatus.Rejected] as const) {
    it(`显式零累计量 ${String(terminalStatus)} 终态即使没有 revision 仍可关闭`, async () => {
      const harness = createStateCheckRawFactHarness({
        operation: 'cancel',
        side: OrderSide.Buy,
        stateCheckResult: {
          kind: 'TERMINAL',
          closedReason: terminalStatus === OrderStatus.Canceled ? 'CANCELED' : 'REJECTED',
          status: terminalStatus,
          submittedQuantity: 100,
          executedPrice: null,
          executedQuantity: 0,
          orderUpdatedAtMs: null,
        },
      });

      const outcome = await runStateCheckOperation('cancel', harness);
      expect(outcome).toMatchObject({ kind: 'ALREADY_CLOSED' });
      const terminalState = harness.runtime.queriedTerminalStateByOrderId.get(harness.orderId);
      if (terminalState === undefined) {
        throw new Error('[测试] 显式零累计量终态必须保留 raw snapshot 供后续关闭');
      }

      expect(normalizeTerminalStateSnapshot(harness.trackedOrder, terminalState)).toMatchObject({
        status: terminalStatus,
        executedQuantity: 0,
        executedPrice: null,
        executedTimeMs: null,
        orderUpdatedAtMs: null,
      });
    });
  }

  it('已确认 40 的等量终态可缺少本次 revision 并保留既有事实关闭', async () => {
    const harness = createStateCheckRawFactHarness({
      operation: 'cancel',
      side: OrderSide.Sell,
      isProtectiveLiquidation: true,
      stateCheckResult: {
        kind: 'TERMINAL',
        closedReason: 'CANCELED',
        status: OrderStatus.Canceled,
        submittedQuantity: 100,
        executedPrice: null,
        executedQuantity: 40,
        orderUpdatedAtMs: null,
      },
    });
    harness.trackedOrder.status = OrderStatus.PartialFilled;
    harness.trackedOrder.executedQuantity = 40;
    harness.trackedOrder.executedPrice = 1.02;
    harness.trackedOrder.lastExecutedTimeMs = 100;
    harness.trackedOrder.lastOrderUpdateAtMs = 100;

    await runStateCheckOperation('cancel', harness);
    const terminalState = harness.runtime.queriedTerminalStateByOrderId.get(harness.orderId);
    if (terminalState === undefined) {
      throw new Error('[测试] 等量终态必须保留 raw snapshot');
    }

    expect(normalizeTerminalStateSnapshot(harness.trackedOrder, terminalState, true)).toMatchObject(
      {
        status: OrderStatus.Canceled,
        executedQuantity: 40,
        executedPrice: 1.02,
        executedTimeMs: 100,
        orderUpdatedAtMs: 100,
      },
    );
  });

  it('累计量推进且 revision 相同的终态可使用本次 broker observation', async () => {
    const harness = createStateCheckRawFactHarness({
      operation: 'cancel',
      side: OrderSide.Buy,
      stateCheckResult: {
        kind: 'TERMINAL',
        closedReason: 'CANCELED',
        status: OrderStatus.Canceled,
        submittedQuantity: 100,
        executedPrice: 1.03,
        executedQuantity: 80,
        orderUpdatedAtMs: 100,
      },
    });
    harness.trackedOrder.status = OrderStatus.PartialFilled;
    harness.trackedOrder.executedQuantity = 40;
    harness.trackedOrder.executedPrice = 1.02;
    harness.trackedOrder.lastExecutedTimeMs = 100;
    harness.trackedOrder.lastOrderUpdateAtMs = 100;

    await runStateCheckOperation('cancel', harness);
    const terminalState = harness.runtime.queriedTerminalStateByOrderId.get(harness.orderId);
    if (terminalState === undefined) {
      throw new Error('[测试] 合法累计量推进终态必须保留 raw snapshot');
    }

    expect(normalizeTerminalStateSnapshot(harness.trackedOrder, terminalState)).toMatchObject({
      executedQuantity: 80,
      executedPrice: 1.03,
      executedTimeMs: 100,
      orderUpdatedAtMs: 100,
    });
  });

  it('累计量推进但 revision 倒退时在缓存前失败', async () => {
    const harness = createStateCheckRawFactHarness({
      operation: 'cancel',
      side: OrderSide.Buy,
      stateCheckResult: {
        kind: 'TERMINAL',
        closedReason: 'CANCELED',
        status: OrderStatus.Canceled,
        submittedQuantity: 100,
        executedPrice: 1.03,
        executedQuantity: 80,
        orderUpdatedAtMs: 99,
      },
    });
    harness.trackedOrder.status = OrderStatus.PartialFilled;
    harness.trackedOrder.executedQuantity = 40;
    harness.trackedOrder.executedPrice = 1.02;
    harness.trackedOrder.lastExecutedTimeMs = 100;
    harness.trackedOrder.lastOrderUpdateAtMs = 100;
    const trackedOrderBefore = { ...harness.trackedOrder };

    await expectStateCheckRawFactFailure(
      () => runStateCheckOperation('cancel', harness),
      /broker revision.*倒退/,
    );

    expectNoStateCheckRawFactSideEffects(harness, trackedOrderBefore);
  });
});
