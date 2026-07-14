/**
 * orderMonitor/orderOps 业务测试
 *
 * 覆盖：
 * - trackOrder 会把 orderId 挂到 symbol bucket，并在 ACTIVE 运行态触发 TRACKED wakeup
 * - 恢复阶段 trackOrder 只重建 truth，不触发 TRACKED wakeup
 */
import { describe, expect, it } from 'bun:test';
import { OrderSide, OrderStatus, OrderType } from 'longbridge';
import { createOrderOps } from '../../../../src/core/trader/orderMonitor/orderOps.js';
import type {
  OrderMonitorRuntimeStore,
  OrderMonitorTrackedOrder,
} from '../../../../src/core/trader/orderMonitor/types.js';
import { createTradingConfig } from '../../../../mock/factories/configFactory.js';
import {
  createOrderRecorderDouble,
  createTradeContextDouble,
} from '../../../helpers/testDoubles.js';
import type { OrderHoldRegistry, OrderCacheManager } from '../../../../src/core/trader/types.js';
import type { RateLimiter } from '../../../../src/types/services.js';
import { createTradeContextMock } from '../../../../mock/longbridge/tradeContextMock.js';

const TEST_MONITOR_CONFIG = createTradingConfig().monitor;

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

describe('orderMonitor orderOps', () => {
  it('trackOrder 会建立 symbol bucket、route state，并在 ACTIVE 运行态触发 TRACKED wakeup', () => {
    const runtime = createRuntimeStore();
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
          reason: 'NOT_FOUND' as const,
          errorCode: '603001',
          message: 'not used in this test',
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
          reason: 'NOT_FOUND' as const,
          errorCode: '603001',
          message: 'not used in this test',
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
          reason: 'NOT_FOUND' as const,
          errorCode: '603001',
          message: 'not used in this test',
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
          reason: 'NOT_FOUND' as const,
          errorCode: '603001',
          message: 'not used in this test',
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
          reason: 'NOT_FOUND' as const,
          errorCode: '603001',
          message: 'not used in this test',
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
          reason: 'NOT_FOUND' as const,
          errorCode: '603001',
          message: 'not used in this test',
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
          executedQuantity: null,
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
          reason: 'NOT_FOUND' as const,
          errorCode: '603001',
          message: 'not used in this test',
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
    expect(runtime.latestReplaceOutcomeByOrderId.get('ORDER-REPLACE-BUSINESS-NO-RETRY')).toEqual({
      kind: 'SKIPPED',
      reason: 'UNSUPPORTED_BY_TYPE',
    });
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
          reason: 'NOT_FOUND' as const,
          errorCode: '603001',
          message: 'not used in this test',
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
          reason: 'NOT_FOUND' as const,
          errorCode: '603001',
          message: 'not used in this test',
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
          reason: 'NOT_FOUND' as const,
          errorCode: '603001',
          message: 'not used in this test',
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
          reason: 'NOT_FOUND' as const,
          errorCode: '603001',
          message: 'not used in this test',
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
    expect(runtime.latestReplaceOutcomeByOrderId.has('ORDER-STALE-REPLACE-1')).toBe(false);
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
        throttle: async () => {
          throttleStarted.resolve();
          await releaseThrottle.promise;
        },
      },
      cacheManager: createCacheManager(),
      orderHoldRegistry: createOrderHoldRegistry(),
      orderRecorder: createOrderRecorderDouble(),
      recordCumulativeExecution: () => {},
      orderStatusQuery: {
        checkOrderState: async () => ({
          kind: 'QUERY_FAILED',
          reason: 'NOT_FOUND',
          errorCode: '603001',
          message: 'not used in this test',
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
});
