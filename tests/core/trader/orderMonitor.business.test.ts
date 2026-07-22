/**
 * orderMonitor 业务测试
 *
 * 功能：
 * - 验证订单监控相关场景意图、边界条件与业务期望。
 */
import { describe, expect, it } from 'bun:test';
import {
  OrderSide,
  type Order,
  OrderStatus,
  OrderType,
  TopicType,
  type TradeContext,
} from 'longbridge';
import { createOrderMonitor } from '../../../src/core/trader/orderMonitor/index.js';
import type { OrderMonitorDeps } from '../../../src/core/trader/types.js';
import type { DailyLossCumulativeExecutionInput } from '../../../src/types/risk.js';
import { createTradingConfig } from '../../../mock/factories/configFactory.js';
import { createPushOrderChanged } from '../../../mock/factories/tradeFactory.js';
import { createTradeContextMock } from '../../../mock/longbridge/tradeContextMock.js';
import {
  createMarketDataClientDouble,
  createDailyLossTrackerDouble,
  createOrderRecorderDouble,
  createProtectiveLiquidationEpisodeTrackerDouble,
  createQuoteDouble,
  createSymbolRegistryDouble,
} from '../../helpers/testDoubles.js';
import type { Quote } from '../../../src/types/quote.js';
import type {
  OrderRecord,
  OrderStateChangedEvent,
  PendingSellInfo,
  QuoteUpdatedEvent,
  RateLimiter,
  RawOrderFromAPI,
  TradeMutationPermit,
} from '../../../src/types/services.js';
import type { RecordLocalSellCall, ReplaceOrderPayload } from './types.js';
import { isRecord } from '../../../src/utils/helpers/index.js';

async function expectPromiseRejectsToMatch(
  operation: () => Promise<unknown>,
  expectedMessagePattern: RegExp,
): Promise<void> {
  try {
    await operation();
  } catch (error: unknown) {
    if (!(error instanceof Error)) {
      throw new Error(`[测试] 预期 Promise 以 Error 拒绝，实际为: ${String(error)}`, {
        cause: error,
      });
    }

    expect(error.message).toMatch(expectedMessagePattern);
    return;
  }

  throw new Error('[测试] 预期 Promise 拒绝，但实际成功');
}

function flushMicrotasks(): Promise<void> {
  return Promise.resolve()
    .then(() => {})
    .then(() => {});
}

/** 构造可显式控制异步边界的测试 deferred。 */
function createDeferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });

  return {
    promise,
    resolve: resolvePromise,
  };
}

async function waitForCondition(
  condition: () => boolean,
  failureMessage: string,
  maxAttempts: number = 10,
): Promise<void> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (condition()) {
      return;
    }

    await flushMicrotasks();
  }

  throw new Error(failureMessage);
}

async function waitForConditionWithDelay(
  condition: () => boolean,
  failureMessage: string,
  maxAttempts: number = 20,
  delayMs: number = 5,
): Promise<void> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (condition()) {
      return;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, delayMs);
    });
  }

  throw new Error(failureMessage);
}

/** 构造订单监控测试使用的限流器，并暴露 mutation permit 已取得的时序观察点。 */
function createRateLimiterDouble(onMutationPermitAcquired?: () => void): RateLimiter {
  return {
    throttle: async () => {},
    withTradeMutation: async <T>(
      callback: (permit: TradeMutationPermit) => Promise<T>,
    ): Promise<T> => {
      onMutationPermitAcquired?.();
      return callback({
        invoke: async <TResult>(operation: () => Promise<TResult>): Promise<TResult> => operation(),
      });
    },
  };
}

async function emitOrderChanged(
  tradeCtx: ReturnType<typeof createTradeContextMock>,
  event: Parameters<ReturnType<typeof createTradeContextMock>['emitOrderChanged']>[0],
): Promise<void> {
  expect(tradeCtx.getSubscribedTopics().has(TopicType.Private)).toBe(true);
  tradeCtx.emitOrderChanged(event);
  tradeCtx.flushAllEvents();
  await flushMicrotasks();
  await flushMicrotasks();
}

type RuntimeTimerHarness = {
  readonly advanceBy: (delayMs: number) => Promise<void>;
  readonly restore: () => void;
};

function createRuntimeTimerHarness(initialNowMs: number): RuntimeTimerHarness {
  const originalNow = Date.now;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let nowMs = initialNowMs;
  const timers = new Map<unknown, { readonly atMs: number; readonly callback: () => void }>();

  function isTimerCallback(
    handler: Parameters<typeof globalThis.setTimeout>[0],
  ): handler is (...args: ReadonlyArray<unknown>) => void {
    return typeof handler === 'function';
  }

  const fakeSetTimeout = Object.assign(
    (
      handler: Parameters<typeof globalThis.setTimeout>[0],
      timeout?: number,
    ): ReturnType<typeof originalSetTimeout> => {
      if (!isTimerCallback(handler)) {
        throw new TypeError('[测试] fake runtime timer 仅支持函数回调');
      }

      const handle = originalSetTimeout(() => {}, 0);
      originalClearTimeout(handle);
      timers.set(handle, {
        atMs: nowMs + (typeof timeout === 'number' ? timeout : 0),
        callback: () => {
          handler();
        },
      });
      return handle;
    },
    {
      __promisify__: originalSetTimeout.__promisify__,
    },
  );

  const fakeClearTimeout: typeof globalThis.clearTimeout = (handle) => {
    timers.delete(handle);
  };

  Date.now = () => nowMs;
  globalThis.setTimeout = fakeSetTimeout;
  globalThis.clearTimeout = fakeClearTimeout;

  return {
    advanceBy: async (delayMs: number) => {
      nowMs += delayMs;
      const dueTimers = [...timers.entries()].filter(([, timer]) => timer.atMs <= nowMs);
      for (const [handle, timer] of dueTimers) {
        timers.delete(handle);
        timer.callback();
      }

      await flushMicrotasks();
      await flushMicrotasks();
    },
    restore: () => {
      Date.now = originalNow;
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    },
  };
}

function createDeps(params?: {
  readonly sellTimeoutSeconds?: number;
  readonly buyTimeoutSeconds?: number;
  readonly orderMonitorPriceUpdateIntervalSeconds?: number;
  readonly allowBuyOrderTrackingAboveInitialPrice?: boolean;
  readonly continuousTradingOpen?: () => boolean;
  readonly allocateRelatedBuyOrderIdsForRecovery?: () => readonly string[];
  readonly protectiveLiquidationEpisodeTrackerOverride?: OrderMonitorDeps['protectiveLiquidationEpisodeTracker'];
  readonly orderRecorderOverride?: OrderMonitorDeps['orderRecorder'];
  readonly dailyLossTrackerOverride?: OrderMonitorDeps['dailyLossTracker'];
  readonly onRecordSettlementRefreshNeed?: (need: {
    readonly refreshAccount: boolean;
    readonly refreshPositions: boolean;
  }) => void;
  readonly onMutationPermitAcquired?: () => void;
  readonly rateLimiter?: RateLimiter;
  readonly persistProtectiveLiquidationExecutionProgress?: OrderMonitorDeps['persistProtectiveLiquidationExecutionProgress'];
  readonly onFatalError?: (error: unknown) => void;
}): {
  deps: OrderMonitorDeps;
  tradeCtx: ReturnType<typeof createTradeContextMock>;
  setQuotes: (quotes: ReadonlyMap<string, Quote | null>) => void;
  emitQuoteUpdated: (event: QuoteUpdatedEvent) => Promise<void>;
} {
  const tradeCtx = createTradeContextMock();
  let quotesMap = new Map<string, Quote | null>([['BULL.HK', createQuoteDouble('BULL.HK', 1.02)]]);
  const quoteUpdatedListeners: Array<(event: QuoteUpdatedEvent) => void> = [];
  const pendingSellSnapshot = new Map<string, PendingSellInfo>();
  const symbolRegistry = createSymbolRegistryDouble({
    longSeat: {
      symbol: 'BULL.HK',
      status: 'ACTIVE',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    },
    shortSeat: {
      symbol: 'BEAR.HK',
      status: 'ACTIVE',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    },
  });

  const orderRecorder =
    params?.orderRecorderOverride ??
    createOrderRecorderDouble({
      allocateRelatedBuyOrderIdsForRecovery:
        params?.allocateRelatedBuyOrderIdsForRecovery ?? (() => ['BUY-1']),
      submitSellOrder: (
        orderId: string,
        symbol: string,
        direction: 'LONG' | 'SHORT',
        quantity: number,
        relatedBuyOrderIds: readonly string[],
        submittedAtMs?: number,
      ) => {
        pendingSellSnapshot.set(orderId, {
          orderId,
          symbol,
          direction,
          submittedQuantity: quantity,
          filledQuantity: 0,
          relatedBuyOrderIds,
          status: 'pending',
          submittedAt: submittedAtMs ?? Date.now(),
        });
      },
      updatePendingSell: (orderId, nextPendingSell) => {
        const current = pendingSellSnapshot.get(orderId);
        if (!current) {
          return null;
        }

        let status: PendingSellInfo['status'] = 'pending';
        if (current.filledQuantity >= nextPendingSell.submittedQuantity) {
          status = 'filled';
        } else if (current.filledQuantity > 0) {
          status = 'partial';
        }

        const updated: PendingSellInfo = {
          ...current,
          submittedQuantity: nextPendingSell.submittedQuantity,
          relatedBuyOrderIds: [...nextPendingSell.relatedBuyOrderIds],
          status,
        };
        pendingSellSnapshot.set(orderId, updated);
        return updated;
      },
      markSellPartialFilled: (orderId: string, filledQuantity: number) => {
        const current = pendingSellSnapshot.get(orderId);
        if (!current) {
          return null;
        }

        const next: PendingSellInfo = {
          ...current,
          filledQuantity,
          status: filledQuantity >= current.submittedQuantity ? 'filled' : 'partial',
        };
        if (next.status === 'filled') {
          pendingSellSnapshot.delete(orderId);
        } else {
          pendingSellSnapshot.set(orderId, next);
        }

        return next;
      },
      markSellFilled: (orderId: string) => {
        const current = pendingSellSnapshot.get(orderId);
        if (!current) {
          return null;
        }

        const filled: PendingSellInfo = {
          ...current,
          filledQuantity: current.submittedQuantity,
          status: 'filled',
        };
        pendingSellSnapshot.delete(orderId);
        return filled;
      },
      markSellCancelled: (orderId: string) => {
        const current = pendingSellSnapshot.get(orderId);
        if (!current) {
          return null;
        }

        const cancelled: PendingSellInfo = {
          ...current,
          status: 'cancelled',
        };
        pendingSellSnapshot.delete(orderId);
        return cancelled;
      },
      getPendingSellSnapshot: () => [...pendingSellSnapshot.values()],
    });

  const baseConfig = createTradingConfig();
  const baseMonitor = baseConfig.monitor;

  const tradingConfig = createTradingConfig({
    monitor: {
      ...baseMonitor,
      orderOwnershipMapping: ['HSI'],
    },
    global: {
      ...baseConfig.global,
      buyOrderTimeout: {
        enabled: true,
        timeoutSeconds: params?.buyTimeoutSeconds ?? 180,
      },
      sellOrderTimeout: {
        enabled: true,
        timeoutSeconds: params?.sellTimeoutSeconds ?? 180,
      },
      orderMonitorPriceUpdateInterval: params?.orderMonitorPriceUpdateIntervalSeconds ?? 0,
      allowBuyOrderTrackingAboveInitialPrice:
        params?.allowBuyOrderTrackingAboveInitialPrice ??
        baseConfig.global.allowBuyOrderTrackingAboveInitialPrice,
    },
  });

  const deps: OrderMonitorDeps = {
    ctx: tradeCtx as unknown as TradeContext,
    rateLimiter: params?.rateLimiter ?? createRateLimiterDouble(params?.onMutationPermitAcquired),
    cacheManager: {
      clearCache: () => {},
      getPendingOrders: async () => [],
    },
    marketDataClient: createMarketDataClientDouble({
      getQuotes: async () => quotesMap,
      onQuoteUpdated: (listener) => {
        quoteUpdatedListeners.push(listener);
        return () => {
          const listenerIndex = quoteUpdatedListeners.indexOf(listener);
          if (listenerIndex !== -1) {
            quoteUpdatedListeners.splice(listenerIndex, 1);
          }
        };
      },
    }),
    orderRecorder,
    dailyLossTracker: params?.dailyLossTrackerOverride ?? {
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
    orderHoldRegistry: {
      trackOrder: () => {},
      markOrderClosed: () => {},
      seedFromOrders: () => {},
      getHoldSymbols: () => new Set<string>(),
      onOrderHoldSymbolsChanged: () => () => {},
      clear: () => {},
    },
    protectiveLiquidationEpisodeTracker:
      params?.protectiveLiquidationEpisodeTrackerOverride ??
      createProtectiveLiquidationEpisodeTrackerDouble(),
    persistProtectiveLiquidationExecutionProgress:
      params?.persistProtectiveLiquidationExecutionProgress ?? (() => {}),
    postTradeConsistencyRuntime: {
      recordSettlementRefreshNeed: (need) => {
        params?.onRecordSettlementRefreshNeed?.(need);
      },
    },
    tradingConfig,
    symbolRegistry,
    isContinuousTradingAllowed: params?.continuousTradingOpen ?? (() => true),
    onFatalError: params?.onFatalError ?? (() => {}),
  };

  return {
    deps,
    tradeCtx,
    setQuotes: (quotes) => {
      quotesMap = new Map(quotes);
    },
    emitQuoteUpdated: async (event) => {
      for (const listener of quoteUpdatedListeners) {
        listener(event);
      }

      await flushMicrotasks();
      await flushMicrotasks();
    },
  };
}

function createPendingRecoveryOrder(params: Partial<RawOrderFromAPI>): RawOrderFromAPI {
  return {
    orderId: params.orderId ?? 'RECOVER-ORDER',
    symbol: params.symbol ?? 'BULL.HK',
    stockName: params.stockName ?? 'HSI RC SAMPLE',
    side: params.side ?? OrderSide.Buy,
    status: params.status ?? OrderStatus.New,
    orderType: params.orderType ?? OrderType.ELO,
    remark: params.remark ?? null,
    price: params.price ?? 1,
    quantity: params.quantity ?? 100,
    executedPrice: params.executedPrice ?? 0,
    executedQuantity: params.executedQuantity ?? 0,
    submittedAt: params.submittedAt ?? new Date('2026-02-25T03:00:00.000Z'),
    updatedAt: params.updatedAt ?? new Date('2026-02-25T03:00:10.000Z'),
  };
}

async function executeReplaceScenario(params: {
  readonly initialPrice: number;
  readonly quotePrice: number;
  readonly processTimes?: number;
}): Promise<{
  readonly replaceCalls: number;
  readonly submittedPrice: number | null;
}> {
  const { deps, tradeCtx, setQuotes, emitQuoteUpdated } = createDeps({
    sellTimeoutSeconds: 999,
    buyTimeoutSeconds: 999,
  });
  const monitor = createOrderMonitor(deps);
  await monitor.initialize();
  await monitor.recoverOrderTrackingFromSnapshot([]);
  monitor.startRuntime();

  monitor.trackOrder({
    orderId: 'SELL-PRICE-DIFF-CASE',
    symbol: 'BULL.HK',
    side: OrderSide.Sell,
    price: params.initialPrice,
    initialSubmittedPrice: params.initialPrice,
    quantity: 100,
    isLongSymbol: true,
    monitorSymbol: 'HSI.HK',
    isProtectiveLiquidation: false,
    orderType: OrderType.ELO,
  });
  await flushMicrotasks();

  setQuotes(new Map([['BULL.HK', createQuoteDouble('BULL.HK', params.quotePrice)]]));

  const processTimes = params.processTimes ?? 1;
  for (let index = 0; index < processTimes; index += 1) {
    await emitQuoteUpdated({
      symbol: 'BULL.HK',
      quote: createQuoteDouble('BULL.HK', params.quotePrice),
    });
  }

  await monitor.stopRuntimeAndDrain();

  const pendingOrders = monitor.getPendingSellOrders('BULL.HK');
  return {
    replaceCalls: tradeCtx.getCalls('replaceOrder').length,
    submittedPrice: pendingOrders[0]?.submittedPrice ?? null,
  };
}

function isReplaceOrderPayload(value: unknown): value is ReplaceOrderPayload {
  if (!isRecord(value)) {
    return false;
  }

  const price = value['price'];
  if (!isRecord(price)) {
    return false;
  }

  return typeof price.toString === 'function';
}

function extractReplaceOrderPrices(
  replaceCalls: ReadonlyArray<{ readonly args: ReadonlyArray<unknown> }>,
): ReadonlyArray<number> {
  return replaceCalls.map((call) => {
    const payload = call.args[0];
    if (!isReplaceOrderPayload(payload)) {
      throw new Error('[测试] replaceOrder 调用载荷缺少可序列化 price 字段');
    }

    return Number(payload.price.toString());
  });
}

describe('orderMonitor business flow', () => {
  it('rechecks signal authorization after mutation permit acquisition before cancel API', async () => {
    let authorized = true;
    const { deps, tradeCtx } = createDeps({
      onMutationPermitAcquired: () => {
        authorized = false;
      },
    });
    const monitor = createOrderMonitor(deps);
    monitor.trackOrder({
      orderId: 'SIGNAL-CANCEL',
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

    await monitor.cancelOrder('SIGNAL-CANCEL', {
      kind: 'SIGNAL_AUTHORIZED',
      authorize: () => authorized,
    });

    expect(tradeCtx.getCalls('cancelOrder')).toHaveLength(0);
  });

  it('keeps order-fact public cancel independent from signal authorization', async () => {
    const { deps, tradeCtx } = createDeps();
    const monitor = createOrderMonitor(deps);

    await monitor.cancelOrder('ORDER-FACT-CANCEL', { kind: 'ORDER_FACT' });

    expect(tradeCtx.getCalls('cancelOrder')).toHaveLength(1);
  });

  it('retries private topic subscription during initialization after a transient API failure', async () => {
    const { deps, tradeCtx } = createDeps();
    tradeCtx.setFailureRule('tradeSubscribe', {
      failAtCalls: [1],
      errorMessage: 'network unavailable',
    });
    const monitor = createOrderMonitor(deps);

    let error: unknown = null;
    try {
      await monitor.initialize();
    } catch (err) {
      error = err;
    }

    expect(tradeCtx.getCalls('tradeSubscribe')).toHaveLength(2);
    expect(error).toBeNull();
  });

  it('replaces order when price diff equals threshold on downward move', async () => {
    const result = await executeReplaceScenario({
      initialPrice: 0.059,
      quotePrice: 0.058,
    });

    expect(result.replaceCalls).toBe(1);
    expect(result.submittedPrice).toBe(0.058);
  });

  it('replaces order when price diff equals threshold on upward move', async () => {
    const result = await executeReplaceScenario({
      initialPrice: 0.058,
      quotePrice: 0.059,
    });

    expect(result.replaceCalls).toBe(1);
    expect(result.submittedPrice).toBe(0.059);
  });

  it('does not replace order when price diff is lower than threshold', async () => {
    const result = await executeReplaceScenario({
      initialPrice: 0.059,
      quotePrice: 0.0581,
    });

    expect(result.replaceCalls).toBe(0);
    expect(result.submittedPrice).toBe(0.059);
  });

  it('replaces order when price diff is greater than threshold', async () => {
    const result = await executeReplaceScenario({
      initialPrice: 0.059,
      quotePrice: 0.057,
    });

    expect(result.replaceCalls).toBe(1);
    expect(result.submittedPrice).toBe(0.057);
  });

  it('does not repeatedly replace when quote price does not change', async () => {
    const result = await executeReplaceScenario({
      initialPrice: 0.058,
      quotePrice: 0.058,
      processTimes: 2,
    });

    expect(result.replaceCalls).toBe(0);
    expect(result.submittedPrice).toBe(0.058);
  });

  it('normalizes tracked submitted price after replace', async () => {
    const result = await executeReplaceScenario({
      initialPrice: 0.059,
      quotePrice: 0.05 + 0.008,
    });

    expect(result.replaceCalls).toBe(1);
    expect(result.submittedPrice).toBe(0.058);
  });

  it('allows buy order tracking above initial price when config is enabled', async () => {
    const { deps, tradeCtx, setQuotes, emitQuoteUpdated } = createDeps({
      sellTimeoutSeconds: 999,
      buyTimeoutSeconds: 999,
      allowBuyOrderTrackingAboveInitialPrice: true,
    });
    const monitor = createOrderMonitor(deps);
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.startRuntime();

    monitor.trackOrder({
      orderId: 'BUY-CHASE-ALLOW-UP',
      symbol: 'BULL.HK',
      side: OrderSide.Buy,
      price: 0.5,
      initialSubmittedPrice: 0.5,
      quantity: 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: OrderType.ELO,
    });
    await flushMicrotasks();

    setQuotes(new Map([['BULL.HK', createQuoteDouble('BULL.HK', 0.51)]]));
    await emitQuoteUpdated({
      symbol: 'BULL.HK',
      quote: createQuoteDouble('BULL.HK', 0.51),
    });

    expect(tradeCtx.getCalls('replaceOrder')).toHaveLength(1);
    expect(extractReplaceOrderPrices(tradeCtx.getCalls('replaceOrder'))).toEqual([0.51]);
  });

  it('allows buy order tracking downward when config disables chasing above initial price', async () => {
    const { deps, tradeCtx, setQuotes, emitQuoteUpdated } = createDeps({
      sellTimeoutSeconds: 999,
      buyTimeoutSeconds: 999,
      allowBuyOrderTrackingAboveInitialPrice: false,
    });
    const monitor = createOrderMonitor(deps);
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.startRuntime();

    monitor.trackOrder({
      orderId: 'BUY-CHASE-ALLOW-DOWN',
      symbol: 'BULL.HK',
      side: OrderSide.Buy,
      price: 0.5,
      initialSubmittedPrice: 0.5,
      quantity: 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: OrderType.ELO,
    });
    await flushMicrotasks();

    setQuotes(new Map([['BULL.HK', createQuoteDouble('BULL.HK', 0.49)]]));
    await emitQuoteUpdated({
      symbol: 'BULL.HK',
      quote: createQuoteDouble('BULL.HK', 0.49),
    });

    expect(tradeCtx.getCalls('replaceOrder')).toHaveLength(1);
    expect(extractReplaceOrderPrices(tradeCtx.getCalls('replaceOrder'))).toEqual([0.49]);
  });

  it('blocks buy order tracking above initial price when config disables chasing above initial price', async () => {
    const { deps, tradeCtx, emitQuoteUpdated } = createDeps({
      sellTimeoutSeconds: 999,
      buyTimeoutSeconds: 999,
      allowBuyOrderTrackingAboveInitialPrice: false,
    });
    const monitor = createOrderMonitor(deps);
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.startRuntime();

    monitor.trackOrder({
      orderId: 'BUY-CHASE-BLOCK-UP',
      symbol: 'BULL.HK',
      side: OrderSide.Buy,
      price: 0.5,
      initialSubmittedPrice: 0.5,
      quantity: 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: OrderType.ELO,
    });
    await flushMicrotasks();

    await emitQuoteUpdated({
      symbol: 'BULL.HK',
      quote: createQuoteDouble('BULL.HK', 0.51),
    });

    expect(tradeCtx.getCalls('replaceOrder')).toHaveLength(0);
  });

  it('allows buy order to return to initial price after lowering when config disables chasing above initial price', async () => {
    const { deps, tradeCtx, setQuotes, emitQuoteUpdated } = createDeps({
      sellTimeoutSeconds: 999,
      buyTimeoutSeconds: 999,
      allowBuyOrderTrackingAboveInitialPrice: false,
    });
    const monitor = createOrderMonitor(deps);
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.startRuntime();

    monitor.trackOrder({
      orderId: 'BUY-CHASE-BACK-TO-INITIAL',
      symbol: 'BULL.HK',
      side: OrderSide.Buy,
      price: 0.5,
      initialSubmittedPrice: 0.5,
      quantity: 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: OrderType.ELO,
    });
    await flushMicrotasks();

    setQuotes(new Map([['BULL.HK', createQuoteDouble('BULL.HK', 0.49)]]));
    await emitQuoteUpdated({
      symbol: 'BULL.HK',
      quote: createQuoteDouble('BULL.HK', 0.49),
    });

    setQuotes(new Map([['BULL.HK', createQuoteDouble('BULL.HK', 0.5)]]));
    await emitQuoteUpdated({
      symbol: 'BULL.HK',
      quote: createQuoteDouble('BULL.HK', 0.5),
    });

    expect(tradeCtx.getCalls('replaceOrder')).toHaveLength(2);
    expect(extractReplaceOrderPrices(tradeCtx.getCalls('replaceOrder'))).toEqual([0.49, 0.5]);
  });

  it('keeps sell replace behavior unchanged when config disables buy chasing above initial price', async () => {
    const { deps, tradeCtx, setQuotes, emitQuoteUpdated } = createDeps({
      sellTimeoutSeconds: 999,
      buyTimeoutSeconds: 999,
      allowBuyOrderTrackingAboveInitialPrice: false,
    });
    const monitor = createOrderMonitor(deps);
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.startRuntime();

    monitor.trackOrder({
      orderId: 'SELL-CHASE-UNTOUCHED',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      price: 0.5,
      initialSubmittedPrice: 0.5,
      quantity: 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: OrderType.ELO,
    });
    await flushMicrotasks();

    setQuotes(new Map([['BULL.HK', createQuoteDouble('BULL.HK', 0.51)]]));
    await emitQuoteUpdated({
      symbol: 'BULL.HK',
      quote: createQuoteDouble('BULL.HK', 0.51),
    });

    expect(tradeCtx.getCalls('replaceOrder')).toHaveLength(1);
    expect(extractReplaceOrderPrices(tradeCtx.getCalls('replaceOrder'))).toEqual([0.51]);
  });

  it('uses restored pending buy price as initial submitted price baseline after recovery', async () => {
    const { deps, tradeCtx, setQuotes, emitQuoteUpdated } = createDeps({
      sellTimeoutSeconds: 999,
      buyTimeoutSeconds: 999,
      allowBuyOrderTrackingAboveInitialPrice: false,
    });
    const monitor = createOrderMonitor(deps);
    await monitor.initialize();
    monitor.startRuntime();

    await monitor.recoverOrderTrackingFromSnapshot([
      createPendingRecoveryOrder({
        orderId: 'BUY-RECOVERY-INITIAL-BASELINE',
        symbol: 'BULL.HK',
        stockName: 'HSI RC RECOVER',
        side: OrderSide.Buy,
        status: OrderStatus.New,
        price: 0.49,
        submittedAt: new Date(),
      }),
    ]);
    await flushMicrotasks();

    setQuotes(new Map([['BULL.HK', createQuoteDouble('BULL.HK', 0.5)]]));
    await emitQuoteUpdated({
      symbol: 'BULL.HK',
      quote: createQuoteDouble('BULL.HK', 0.5),
    });
    expect(tradeCtx.getCalls('replaceOrder')).toHaveLength(0);

    setQuotes(new Map([['BULL.HK', createQuoteDouble('BULL.HK', 0.48)]]));
    await emitQuoteUpdated({
      symbol: 'BULL.HK',
      quote: createQuoteDouble('BULL.HK', 0.48),
    });
    expect(tradeCtx.getCalls('replaceOrder')).toHaveLength(1);
    expect(extractReplaceOrderPrices(tradeCtx.getCalls('replaceOrder'))).toEqual([0.48]);
  });

  it('waits for WS after timed-out sell cancel request success and does not convert immediately', async () => {
    const { deps, tradeCtx } = createDeps({
      sellTimeoutSeconds: 0,
    });
    const monitor = createOrderMonitor(deps);

    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.startRuntime();
    expect(tradeCtx.getSubscribedTopics().has(TopicType.Private)).toBe(true);

    monitor.trackOrder({
      orderId: 'SELL-001',
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

    await waitForCondition(
      () => tradeCtx.getCalls('cancelOrder').length === 1,
      '[测试] 预期超时卖单先发起撤单，但 cancelOrder 未发生',
    );

    const cancelCalls = tradeCtx.getCalls('cancelOrder');
    const submitCalls = tradeCtx.getCalls('submitOrder');

    expect(cancelCalls).toHaveLength(1);
    expect(submitCalls).toHaveLength(0);
    expect(tradeCtx.getCalls('orderDetail')).toHaveLength(0);
    expect(monitor.getPendingSellOrders('BULL.HK')).toHaveLength(1);
    expect(monitor.getPendingSellOrders('BULL.HK')[0]?.orderType).toBe(OrderType.ELO);
  });

  it('does not retry cancel when timed-out sell receives PendingCancel after cancel request success', async () => {
    const { deps, tradeCtx } = createDeps({
      sellTimeoutSeconds: 0,
    });
    const monitor = createOrderMonitor(deps);
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.startRuntime();
    monitor.trackOrder({
      orderId: 'SELL-TIMEOUT-PENDING-CANCEL',
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
    await flushMicrotasks();
    expect(tradeCtx.getCalls('cancelOrder')).toHaveLength(1);
    await emitOrderChanged(
      tradeCtx,
      createPushOrderChanged({
        orderId: 'SELL-TIMEOUT-PENDING-CANCEL',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.PendingCancel,
        orderType: OrderType.ELO,
        submittedPrice: 1,
        submittedQuantity: 100,
        executedQuantity: 0,
        executedPrice: 0,
        updatedAtMs: Date.parse('2026-02-25T03:11:00.000Z'),
      }),
    );
    await flushMicrotasks();
    expect(tradeCtx.getCalls('cancelOrder')).toHaveLength(1);
    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(0);
    expect(tradeCtx.getCalls('orderDetail')).toHaveLength(0);
  });

  it('does not retry cancel when timed-out buy receives PendingCancel after cancel request success', async () => {
    const { deps, tradeCtx } = createDeps({
      buyTimeoutSeconds: 0,
      sellTimeoutSeconds: 999,
    });
    const monitor = createOrderMonitor(deps);
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.startRuntime();
    monitor.trackOrder({
      orderId: 'BUY-TIMEOUT-PENDING-CANCEL',
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
    await flushMicrotasks();
    expect(tradeCtx.getCalls('cancelOrder')).toHaveLength(1);
    await emitOrderChanged(
      tradeCtx,
      createPushOrderChanged({
        orderId: 'BUY-TIMEOUT-PENDING-CANCEL',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
        status: OrderStatus.PendingCancel,
        orderType: OrderType.ELO,
        submittedPrice: 1,
        submittedQuantity: 100,
        executedQuantity: 0,
        executedPrice: 0,
        updatedAtMs: Date.parse('2026-02-25T03:12:00.000Z'),
      }),
    );
    await flushMicrotasks();
    expect(tradeCtx.getCalls('cancelOrder')).toHaveLength(1);
    expect(tradeCtx.getCalls('orderDetail')).toHaveLength(0);
  });

  it('does not retry cancel when timed-out sell receives WaitToCancel after cancel request success', async () => {
    const { deps, tradeCtx } = createDeps({
      sellTimeoutSeconds: 0,
    });
    const monitor = createOrderMonitor(deps);
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.startRuntime();
    monitor.trackOrder({
      orderId: 'SELL-TIMEOUT-WAIT-TO-CANCEL',
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
    await flushMicrotasks();
    expect(tradeCtx.getCalls('cancelOrder')).toHaveLength(1);
    await emitOrderChanged(
      tradeCtx,
      createPushOrderChanged({
        orderId: 'SELL-TIMEOUT-WAIT-TO-CANCEL',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.WaitToCancel,
        orderType: OrderType.ELO,
        submittedPrice: 1,
        submittedQuantity: 100,
        executedQuantity: 0,
        executedPrice: 0,
        updatedAtMs: Date.parse('2026-02-25T03:13:00.000Z'),
      }),
    );
    await flushMicrotasks();
    expect(tradeCtx.getCalls('cancelOrder')).toHaveLength(1);
    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(0);
    expect(tradeCtx.getCalls('orderDetail')).toHaveLength(0);
  });

  it('does not retry cancel when timed-out buy receives WaitToCancel after cancel request success', async () => {
    const { deps, tradeCtx } = createDeps({
      buyTimeoutSeconds: 0,
      sellTimeoutSeconds: 999,
    });
    const monitor = createOrderMonitor(deps);
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.startRuntime();
    monitor.trackOrder({
      orderId: 'BUY-TIMEOUT-WAIT-TO-CANCEL',
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
    await flushMicrotasks();
    expect(tradeCtx.getCalls('cancelOrder')).toHaveLength(1);
    await emitOrderChanged(
      tradeCtx,
      createPushOrderChanged({
        orderId: 'BUY-TIMEOUT-WAIT-TO-CANCEL',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
        status: OrderStatus.WaitToCancel,
        orderType: OrderType.ELO,
        submittedPrice: 1,
        submittedQuantity: 100,
        executedQuantity: 0,
        executedPrice: 0,
        updatedAtMs: Date.parse('2026-02-25T03:14:00.000Z'),
      }),
    );
    await flushMicrotasks();
    expect(tradeCtx.getCalls('cancelOrder')).toHaveLength(1);
    expect(tradeCtx.getCalls('orderDetail')).toHaveLength(0);
  });

  it('keeps protective sell tracked and does not submit market order before WS confirmation', async () => {
    const { deps, tradeCtx } = createDeps({
      sellTimeoutSeconds: 0,
    });
    const monitor = createOrderMonitor(deps);
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.startRuntime();

    monitor.trackOrder({
      orderId: 'SELL-PROTECTIVE-TIMEOUT',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      price: 1,
      initialSubmittedPrice: 1,
      quantity: 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: true,
      orderType: OrderType.ELO,
    });
    await flushMicrotasks();

    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(0);
    expect(tradeCtx.getCalls('orderDetail')).toHaveLength(0);
    const pending = monitor.getPendingSellOrders('BULL.HK');
    expect(pending).toHaveLength(1);
    expect(pending[0]?.orderId).toBe('SELL-PROTECTIVE-TIMEOUT');
  });

  it('converts timed-out sell to market order after WS confirms non-filled terminal', async () => {
    const { deps, tradeCtx } = createDeps({
      sellTimeoutSeconds: 0,
    });
    const cancelMutationStarted = createDeferred();
    const releaseCancelResponse = createDeferred();
    const originalCancelOrder = tradeCtx.cancelOrder.bind(tradeCtx);
    tradeCtx.cancelOrder = async (orderId) => {
      await originalCancelOrder(orderId);
      cancelMutationStarted.resolve();
      await releaseCancelResponse.promise;
    };
    const monitor = createOrderMonitor(deps);

    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.startRuntime();

    monitor.trackOrder({
      orderId: 'SELL-TIMEOUT-CONVERT-WS',
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

    await cancelMutationStarted.promise;

    await emitOrderChanged(
      tradeCtx,
      createPushOrderChanged({
        orderId: 'SELL-TIMEOUT-CONVERT-WS',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.Canceled,
        orderType: OrderType.ELO,
        submittedPrice: 1,
        submittedQuantity: 100,
        executedQuantity: 0,
        executedPrice: 0,
        updatedAtMs: Date.parse('2026-02-25T03:11:00.000Z'),
      }),
    );
    releaseCancelResponse.resolve();

    await waitForConditionWithDelay(
      () => tradeCtx.getCalls('submitOrder').length === 1,
      '[测试] 预期 WS 终态触发超时卖单转市价，但 submitOrder 未发生',
    );

    expect(tradeCtx.getCalls('cancelOrder')).toHaveLength(1);
    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(1);
    const submitCall = tradeCtx.getCalls('submitOrder')[0];
    const payload = submitCall?.args[0] as {
      readonly orderType: OrderType;
      readonly side: OrderSide;
      readonly submittedQuantity: { readonly toString: () => string };
    };
    expect(payload.orderType).toBe(OrderType.MO);
    expect(payload.side).toBe(OrderSide.Sell);
    expect(Number(payload.submittedQuantity.toString())).toBe(100);
  });

  it('does not convert timed-out sell when WS filled arrives after cancel mutation starts', async () => {
    const { deps, tradeCtx } = createDeps({
      sellTimeoutSeconds: 0,
    });
    const cancelMutationStarted = createDeferred();
    const releaseCancelResponse = createDeferred();
    const originalCancelOrder = tradeCtx.cancelOrder.bind(tradeCtx);
    tradeCtx.cancelOrder = async (orderId) => {
      await originalCancelOrder(orderId);
      cancelMutationStarted.resolve();
      await releaseCancelResponse.promise;
    };
    const monitor = createOrderMonitor(deps);

    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.startRuntime();
    monitor.trackOrder({
      orderId: 'SELL-TIMEOUT-FILLED-DURING-CANCEL',
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

    await cancelMutationStarted.promise;
    await emitOrderChanged(
      tradeCtx,
      createPushOrderChanged({
        orderId: 'SELL-TIMEOUT-FILLED-DURING-CANCEL',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.Filled,
        orderType: OrderType.ELO,
        submittedPrice: 1,
        submittedQuantity: 100,
        executedQuantity: 100,
        executedPrice: 1,
        updatedAtMs: Date.parse('2026-02-25T03:11:00.000Z'),
      }),
    );
    releaseCancelResponse.resolve();

    await monitor.stopRuntimeAndDrain();

    expect(tradeCtx.getCalls('cancelOrder')).toHaveLength(1);
    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(0);
    expect(monitor.getPendingSellOrders('BULL.HK')).toEqual([]);
  });

  it('converts only the remaining quantity when partial cancellation arrives after cancel mutation starts', async () => {
    const { deps, tradeCtx } = createDeps({
      sellTimeoutSeconds: 0,
    });
    const cancelMutationStarted = createDeferred();
    const releaseCancelResponse = createDeferred();
    const originalCancelOrder = tradeCtx.cancelOrder.bind(tradeCtx);
    tradeCtx.cancelOrder = async (orderId) => {
      await originalCancelOrder(orderId);
      cancelMutationStarted.resolve();
      await releaseCancelResponse.promise;
    };
    const monitor = createOrderMonitor(deps);

    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.startRuntime();
    monitor.trackOrder({
      orderId: 'SELL-TIMEOUT-PARTIAL-DURING-CANCEL',
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

    await cancelMutationStarted.promise;
    await emitOrderChanged(
      tradeCtx,
      createPushOrderChanged({
        orderId: 'SELL-TIMEOUT-PARTIAL-DURING-CANCEL',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.Canceled,
        orderType: OrderType.ELO,
        submittedPrice: 1,
        submittedQuantity: 100,
        executedQuantity: 40,
        executedPrice: 1,
        updatedAtMs: Date.parse('2026-02-25T03:11:00.000Z'),
      }),
    );
    releaseCancelResponse.resolve();

    await waitForConditionWithDelay(
      () => tradeCtx.getCalls('submitOrder').length === 1,
      '[测试] 预期部分撤单后仅为剩余数量提交市价卖单，但 submitOrder 未发生',
    );

    const submitCall = tradeCtx.getCalls('submitOrder')[0];
    const payload = submitCall?.args[0] as {
      readonly orderType: OrderType;
      readonly side: OrderSide;
      readonly submittedQuantity: { readonly toString: () => string };
    };
    expect(payload.orderType).toBe(OrderType.MO);
    expect(payload.side).toBe(OrderSide.Sell);
    expect(Number(payload.submittedQuantity.toString())).toBe(60);
  });

  it('settles terminal received before permit invocation without canceling or converting', async () => {
    const permitQueueReached = createDeferred();
    const releasePermit = createDeferred();
    const rateLimiter: RateLimiter = {
      throttle: async () => {},
      withTradeMutation: async <T>(
        callback: (permit: TradeMutationPermit) => Promise<T>,
      ): Promise<T> => {
        permitQueueReached.resolve();
        await releasePermit.promise;
        return callback({
          invoke: async <TResult>(operation: () => Promise<TResult>): Promise<TResult> =>
            operation(),
        });
      },
    };
    const { deps, tradeCtx } = createDeps({
      sellTimeoutSeconds: 0,
      rateLimiter,
    });
    const monitor = createOrderMonitor(deps);

    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.startRuntime();
    monitor.trackOrder({
      orderId: 'SELL-TIMEOUT-TERMINAL-BEFORE-PERMIT',
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

    await permitQueueReached.promise;
    await emitOrderChanged(
      tradeCtx,
      createPushOrderChanged({
        orderId: 'SELL-TIMEOUT-TERMINAL-BEFORE-PERMIT',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.Canceled,
        orderType: OrderType.ELO,
        submittedPrice: 1,
        submittedQuantity: 100,
        executedQuantity: 0,
        executedPrice: 0,
        updatedAtMs: Date.parse('2026-02-25T03:11:00.000Z'),
      }),
    );
    releasePermit.resolve();

    await monitor.stopRuntimeAndDrain();

    expect(tradeCtx.getCalls('cancelOrder')).toHaveLength(0);
    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(0);
    expect(monitor.getPendingSellOrders('BULL.HK')).toEqual([]);
  });

  it('prepares a protective timeout terminal once before route settlement consumes the same revision', async () => {
    const revisionMs = Date.parse('2026-07-11T02:00:00.000Z');
    const dailyLossFacts: DailyLossCumulativeExecutionInput[] = [];
    const persistedRevisions: number[] = [];
    const refreshNeeds: Array<{
      readonly refreshAccount: boolean;
      readonly refreshPositions: boolean;
    }> = [];
    const stateEvents: OrderStateChangedEvent[] = [];
    const { deps, tradeCtx } = createDeps({
      sellTimeoutSeconds: 0,
      dailyLossTrackerOverride: createDailyLossTrackerDouble({
        recordCumulativeExecution: (input, beforeAuthoritativeFactCommit) => {
          dailyLossFacts.push(input);
          beforeAuthoritativeFactCommit?.({
            factStage: input.factStage,
            cumulativeQuantity: '100',
            cumulativeAmount: '102',
            lastExecutionTimeMs: revisionMs,
            orderRevisionMs: input.orderUpdatedAtMs,
          });
          return { authoritativeFactChanged: true, executionAdvanced: true };
        },
      }),
      persistProtectiveLiquidationExecutionProgress: (progress) => {
        persistedRevisions.push(progress.orderRevisionMs);
      },
      onRecordSettlementRefreshNeed: (need) => {
        refreshNeeds.push(need);
      },
    });
    const monitor = createOrderMonitor(deps);
    monitor.onOrderStateChanged((event) => {
      stateEvents.push(event);
    });

    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.startRuntime();
    monitor.trackOrder({
      orderId: 'SELL-PROTECTIVE-TIMEOUT-DURABLE-ONCE',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      price: 1,
      initialSubmittedPrice: 1,
      quantity: 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: true,
      orderType: OrderType.ELO,
    });

    await waitForCondition(
      () => tradeCtx.getCalls('cancelOrder').length === 1,
      '[测试] 预期保护性超时卖单先发起撤单，但 cancelOrder 未发生',
    );

    await emitOrderChanged(
      tradeCtx,
      createPushOrderChanged({
        orderId: 'SELL-PROTECTIVE-TIMEOUT-DURABLE-ONCE',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.Canceled,
        executedQuantity: 100,
        executedPrice: 1.02,
        updatedAtMs: revisionMs,
      }),
    );

    await waitForCondition(
      () => stateEvents.length === 1,
      '[测试] 预期 terminal snapshot 被 route 消费并完成结算，但未收到状态事件',
    );

    expect(persistedRevisions).toEqual([revisionMs]);
    expect(
      dailyLossFacts.map((fact) => ({
        factStage: fact.factStage,
        orderId: fact.orderId,
        orderUpdatedAtMs: fact.orderUpdatedAtMs,
      })),
    ).toEqual([
      {
        factStage: 'TERMINAL',
        orderId: 'SELL-PROTECTIVE-TIMEOUT-DURABLE-ONCE',
        orderUpdatedAtMs: revisionMs,
      },
    ]);

    expect(refreshNeeds).toEqual([
      {
        refreshAccount: true,
        refreshPositions: true,
      },
    ]);

    expect(stateEvents).toMatchObject([
      {
        orderId: 'SELL-PROTECTIVE-TIMEOUT-DURABLE-ONCE',
        source: 'WS',
        status: 'CANCELED',
      },
    ]);
    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(0);
    expect(monitor.getPendingSellOrders('BULL.HK')).toEqual([]);
  });

  it('fails fast when timeout market sell submit response misses real orderId', async () => {
    let submitCalls = 0;
    const { deps, tradeCtx } = createDeps({
      sellTimeoutSeconds: 0,
    });
    tradeCtx.submitOrder = async () => {
      submitCalls += 1;
      return {} as never;
    };
    const monitor = createOrderMonitor(deps);

    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.startRuntime();

    monitor.trackOrder({
      orderId: 'SELL-TIMEOUT-MISSING-ID',
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

    await waitForCondition(
      () => tradeCtx.getCalls('cancelOrder').length === 1,
      '[测试] 预期超时卖单先发起撤单，但 cancelOrder 未发生',
    );
    await flushMicrotasks();
    await emitOrderChanged(
      tradeCtx,
      createPushOrderChanged({
        orderId: 'SELL-TIMEOUT-MISSING-ID',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.Canceled,
        orderType: OrderType.ELO,
        submittedPrice: 1,
        submittedQuantity: 100,
        executedQuantity: 0,
        executedPrice: 0,
        updatedAtMs: Date.parse('2026-02-25T03:11:00.000Z'),
      }),
    );

    await waitForConditionWithDelay(
      () => submitCalls === 1,
      '[测试] 预期超时卖单转市价已调用 submitOrder，但 submitOrder 未发生',
    );
    await flushMicrotasks();

    await expectPromiseRejectsToMatch(
      () => monitor.stopRuntimeAndDrain(),
      /submitOrder response missing valid orderId/,
    );

    expect(submitCalls).toBe(1);
    expect(monitor.getPendingSellOrders('BULL.HK')).toHaveLength(0);
  });

  it('routes a protective settlement persistence failure from the real WS callback into onFatalError', async () => {
    const persistenceError = new Error('protective progress persistence failed');
    const fatalErrors: unknown[] = [];
    const { deps, tradeCtx } = createDeps({
      dailyLossTrackerOverride: createDailyLossTrackerDouble({
        recordCumulativeExecution: (_input, beforeAuthoritativeFactCommit) => {
          beforeAuthoritativeFactCommit?.({
            factStage: 'TERMINAL',
            cumulativeQuantity: '100',
            cumulativeAmount: '102',
            lastExecutionTimeMs: Date.parse('2026-02-25T03:11:00.000Z'),
            orderRevisionMs: Date.parse('2026-02-25T03:11:00.000Z'),
          });
          return {
            authoritativeFactChanged: true,
            executionAdvanced: true,
          };
        },
      }),
      persistProtectiveLiquidationExecutionProgress: () => {
        throw persistenceError;
      },
      onFatalError: (error) => {
        fatalErrors.push(error);
      },
    });
    const monitor = createOrderMonitor(deps);

    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.startRuntime();
    monitor.trackOrder({
      orderId: 'SELL-PROTECTIVE-WS-FATAL',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      price: 1,
      initialSubmittedPrice: 1,
      quantity: 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: true,
      orderType: OrderType.ELO,
    });

    tradeCtx.emitOrderChanged(
      createPushOrderChanged({
        orderId: 'SELL-PROTECTIVE-WS-FATAL',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.Filled,
        executedQuantity: 100,
        executedPrice: 1.02,
        updatedAtMs: Date.parse('2026-02-25T03:11:00.000Z'),
      }),
    );

    expect(() => tradeCtx.flushAllEvents()).not.toThrow();
    await flushMicrotasks();

    expect(fatalErrors).toEqual([persistenceError]);
    expect(monitor.getPendingSellOrders('BULL.HK')).toHaveLength(1);
  });

  it('routes a protective WS terminal with positive execution but invalid execution time into onFatalError before local settlement', async () => {
    const fatalErrors: unknown[] = [];
    const recorderCalls: string[] = [];
    const dailyLossCalls: DailyLossCumulativeExecutionInput[] = [];
    const persistenceCalls: string[] = [];
    const episodeCalls: string[] = [];
    const refreshNeeds: Array<{
      readonly refreshAccount: boolean;
      readonly refreshPositions: boolean;
    }> = [];
    const orderStateEvents: OrderStateChangedEvent[] = [];
    const { deps, tradeCtx } = createDeps({
      orderRecorderOverride: createOrderRecorderDouble({
        markSellFilled: () => {
          recorderCalls.push('markSellFilled');
          return null;
        },
        markSellCancelled: () => {
          recorderCalls.push('markSellCancelled');
          return null;
        },
        recordLocalSell: () => {
          recorderCalls.push('recordLocalSell');
        },
      }),
      dailyLossTrackerOverride: createDailyLossTrackerDouble({
        recordCumulativeExecution: (input) => {
          dailyLossCalls.push(input);
          return { authoritativeFactChanged: true, executionAdvanced: true };
        },
      }),
      persistProtectiveLiquidationExecutionProgress: (input) => {
        persistenceCalls.push(input.orderId);
      },
      protectiveLiquidationEpisodeTrackerOverride: createProtectiveLiquidationEpisodeTrackerDouble({
        recordProtectiveFillProgress: () => {
          episodeCalls.push('recordProtectiveFillProgress');
        },
      }),
      onRecordSettlementRefreshNeed: (need) => {
        refreshNeeds.push(need);
      },
      onFatalError: (error) => {
        fatalErrors.push(error);
      },
    });
    const monitor = createOrderMonitor(deps);
    monitor.onOrderStateChanged((event) => {
      orderStateEvents.push(event);
    });

    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.startRuntime();
    monitor.trackOrder({
      orderId: 'SELL-PROTECTIVE-WS-MISSING-TIME',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      price: 1,
      initialSubmittedPrice: 1,
      quantity: 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: true,
      orderType: OrderType.ELO,
    });

    tradeCtx.emitOrderChanged(
      createPushOrderChanged({
        orderId: 'SELL-PROTECTIVE-WS-MISSING-TIME',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.Canceled,
        executedQuantity: 40,
        executedPrice: 1.02,
        updatedAtMs: Number.NaN,
      }),
    );

    expect(() => tradeCtx.flushAllEvents()).not.toThrow();
    await flushMicrotasks();

    expect(fatalErrors).toHaveLength(1);
    const fatalError = fatalErrors[0];
    expect(fatalError).toBeInstanceOf(Error);
    if (!(fatalError instanceof Error)) {
      throw new Error('[测试] WS 无效执行时间未透传 Error 到 onFatalError');
    }

    expect(fatalError.message).toMatch(/保护性 SELL 存在正累计成交但执行事实不完整/);
    expect(recorderCalls).toEqual([]);
    expect(dailyLossCalls).toEqual([]);
    expect(persistenceCalls).toEqual([]);
    expect(episodeCalls).toEqual([]);
    expect(refreshNeeds).toEqual([]);
    expect(orderStateEvents).toEqual([]);
    expect(monitor.getPendingSellOrders('BULL.HK')).toHaveLength(1);
  });

  it('routes a protective PartialFilled WS raw-fact rejection into onFatalError before any second local progress', async () => {
    const firstRevisionMs = Date.parse('2026-02-25T03:11:00.000Z');
    const fatalErrors: unknown[] = [];
    const dailyLossCalls: DailyLossCumulativeExecutionInput[] = [];
    const persistenceCalls: string[] = [];
    const episodeCalls: string[] = [];
    const refreshNeeds: Array<{
      readonly refreshAccount: boolean;
      readonly refreshPositions: boolean;
    }> = [];
    const partialFills: number[] = [];
    const orderStateEvents: OrderStateChangedEvent[] = [];
    const { deps, tradeCtx } = createDeps({
      orderRecorderOverride: createOrderRecorderDouble({
        markSellPartialFilled: (_orderId, filledQuantity) => {
          partialFills.push(filledQuantity);
          return null;
        },
      }),
      dailyLossTrackerOverride: createDailyLossTrackerDouble({
        recordCumulativeExecution: (input, beforeAuthoritativeFactCommit) => {
          dailyLossCalls.push(input);
          beforeAuthoritativeFactCommit?.({
            factStage: input.factStage,
            cumulativeQuantity: String(input.executedQuantity),
            cumulativeAmount: String(input.executedPrice * input.executedQuantity),
            lastExecutionTimeMs: input.executedTimeMs,
            orderRevisionMs: input.orderUpdatedAtMs,
          });
          return { authoritativeFactChanged: true, executionAdvanced: true };
        },
      }),
      persistProtectiveLiquidationExecutionProgress: (input) => {
        persistenceCalls.push(input.orderId);
      },
      protectiveLiquidationEpisodeTrackerOverride: createProtectiveLiquidationEpisodeTrackerDouble({
        recordProtectiveFillProgress: () => {
          episodeCalls.push('recordProtectiveFillProgress');
        },
      }),
      onRecordSettlementRefreshNeed: (need) => {
        refreshNeeds.push(need);
      },
      onFatalError: (error) => {
        fatalErrors.push(error);
      },
    });
    const monitor = createOrderMonitor(deps);
    monitor.onOrderStateChanged((event) => {
      orderStateEvents.push(event);
    });

    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.trackOrder({
      orderId: 'SELL-PROTECTIVE-WS-RAW-PARTIAL',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      price: 1,
      initialSubmittedPrice: 1,
      quantity: 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: true,
      orderType: OrderType.ELO,
    });

    await emitOrderChanged(
      tradeCtx,
      createPushOrderChanged({
        orderId: 'SELL-PROTECTIVE-WS-RAW-PARTIAL',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.PartialFilled,
        executedQuantity: 40,
        executedPrice: 1.02,
        updatedAtMs: firstRevisionMs,
      }),
    );
    const invalidRevisionEvent = createPushOrderChanged({
      orderId: 'SELL-PROTECTIVE-WS-RAW-PARTIAL',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      status: OrderStatus.PartialFilled,
      executedQuantity: 40,
      executedPrice: 1.02,
      updatedAtMs: firstRevisionMs + 1_000,
    });
    Object.assign(invalidRevisionEvent, { executedPrice: null });

    await emitOrderChanged(tradeCtx, invalidRevisionEvent);

    expect(fatalErrors).toHaveLength(1);
    expect(fatalErrors[0]).toBeInstanceOf(Error);
    expect(dailyLossCalls).toHaveLength(1);
    expect(persistenceCalls).toEqual(['SELL-PROTECTIVE-WS-RAW-PARTIAL']);
    expect(episodeCalls).toEqual(['recordProtectiveFillProgress']);
    expect(refreshNeeds).toHaveLength(1);
    expect(partialFills).toEqual([40]);
    expect(orderStateEvents).toEqual([]);
    expect(monitor.getPendingSellOrders('BULL.HK')).toMatchObject([
      {
        orderId: 'SELL-PROTECTIVE-WS-RAW-PARTIAL',
        executedQuantity: 40,
      },
    ]);
  });

  it('public state-check protective terminal with positive execution but invalid execution time rejects without local closure', async () => {
    const recorderCalls: string[] = [];
    const dailyLossCalls: DailyLossCumulativeExecutionInput[] = [];
    const persistenceCalls: string[] = [];
    const episodeCalls: string[] = [];
    const refreshNeeds: Array<{
      readonly refreshAccount: boolean;
      readonly refreshPositions: boolean;
    }> = [];
    const orderStateEvents: OrderStateChangedEvent[] = [];
    const fatalErrors: unknown[] = [];
    const { deps, tradeCtx } = createDeps({
      orderRecorderOverride: createOrderRecorderDouble({
        markSellFilled: () => {
          recorderCalls.push('markSellFilled');
          return null;
        },
        markSellCancelled: () => {
          recorderCalls.push('markSellCancelled');
          return null;
        },
        recordLocalSell: () => {
          recorderCalls.push('recordLocalSell');
        },
      }),
      dailyLossTrackerOverride: createDailyLossTrackerDouble({
        recordCumulativeExecution: (input) => {
          dailyLossCalls.push(input);
          return { authoritativeFactChanged: true, executionAdvanced: true };
        },
      }),
      persistProtectiveLiquidationExecutionProgress: (input) => {
        persistenceCalls.push(input.orderId);
      },
      protectiveLiquidationEpisodeTrackerOverride: createProtectiveLiquidationEpisodeTrackerDouble({
        recordProtectiveFillProgress: () => {
          episodeCalls.push('recordProtectiveFillProgress');
        },
      }),
      onRecordSettlementRefreshNeed: (need) => {
        refreshNeeds.push(need);
      },
      onFatalError: (error) => {
        fatalErrors.push(error);
      },
    });
    tradeCtx.setFailureRule('cancelOrder', {
      failAtCalls: [1],
      maxFailures: 1,
      errorMessage: 'openapi error: code=601011: Order already cancelled',
    });

    tradeCtx.seedTodayOrders([
      createPendingRecoveryOrder({
        orderId: 'SELL-PROTECTIVE-STATE-CHECK-MISSING-TIME',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.PartialWithdrawal,
        quantity: 100,
        executedQuantity: 40,
        executedPrice: 1.02,
        updatedAt: new Date(Number.NaN),
      }) as unknown as Order,
    ]);
    const monitor = createOrderMonitor(deps);
    monitor.onOrderStateChanged((event) => {
      orderStateEvents.push(event);
    });

    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.trackOrder({
      orderId: 'SELL-PROTECTIVE-STATE-CHECK-MISSING-TIME',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      price: 1,
      initialSubmittedPrice: 1,
      quantity: 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: true,
      orderType: OrderType.ELO,
    });

    await expectPromiseRejectsToMatch(
      () =>
        monitor.cancelOrder('SELL-PROTECTIVE-STATE-CHECK-MISSING-TIME', {
          kind: 'ORDER_FACT',
        }),
      /state-check 累计成交数量推进但缺少有效 broker revision/,
    );

    expect(recorderCalls).toEqual([]);
    expect(dailyLossCalls).toEqual([]);
    expect(persistenceCalls).toEqual([]);
    expect(episodeCalls).toEqual([]);
    expect(refreshNeeds).toEqual([]);
    expect(orderStateEvents).toEqual([]);
    expect(fatalErrors).toEqual([]);
    expect(monitor.getPendingSellOrders('BULL.HK')).toHaveLength(1);
  });

  it('broker ack 后 submitSellOrder 抛错会保留新 tracked fact、旧 placeholder 并上报 fatal', async () => {
    const pendingSellSnapshot = new Map<string, PendingSellInfo>();
    const fatalErrors: unknown[] = [];
    const { deps, tradeCtx } = createDeps({
      sellTimeoutSeconds: 0,
      onFatalError: (error) => {
        fatalErrors.push(error);
      },
      orderRecorderOverride: createOrderRecorderDouble({
        allocateRelatedBuyOrderIdsForRecovery: () => ['BUY-1'],
        submitSellOrder: (
          orderId: string,
          symbol: string,
          direction: 'LONG' | 'SHORT',
          quantity: number,
          relatedBuyOrderIds: readonly string[],
          submittedAtMs?: number,
        ) => {
          if (orderId === 'MOCK-000001') {
            throw new Error('submit sell sync failed');
          }

          pendingSellSnapshot.set(orderId, {
            orderId,
            symbol,
            direction,
            submittedQuantity: quantity,
            filledQuantity: 0,
            relatedBuyOrderIds: [...relatedBuyOrderIds],
            status: 'pending',
            submittedAt: submittedAtMs ?? Date.now(),
          });
        },
        markSellCancelled: (orderId: string) => {
          const current = pendingSellSnapshot.get(orderId);
          if (!current) {
            return null;
          }

          pendingSellSnapshot.delete(orderId);
          return {
            ...current,
            status: 'cancelled',
          };
        },
        getPendingSellSnapshot: () => [...pendingSellSnapshot.values()],
      }),
    });
    const monitor = createOrderMonitor(deps);

    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.startRuntime();

    monitor.trackOrder({
      orderId: 'SELL-TIMEOUT-LOCAL-SYNC-FAIL',
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

    await waitForCondition(
      () => tradeCtx.getCalls('cancelOrder').length === 1,
      '[测试] 预期超时卖单先发起撤单，但 cancelOrder 未发生',
    );
    await flushMicrotasks();
    await emitOrderChanged(
      tradeCtx,
      createPushOrderChanged({
        orderId: 'SELL-TIMEOUT-LOCAL-SYNC-FAIL',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.Canceled,
        orderType: OrderType.ELO,
        submittedPrice: 1,
        submittedQuantity: 100,
        executedQuantity: 0,
        executedPrice: 0,
        updatedAtMs: Date.parse('2026-02-25T03:11:00.000Z'),
      }),
    );

    await waitForConditionWithDelay(
      () => tradeCtx.getCalls('submitOrder').length === 1,
      '[测试] 预期超时卖单转市价已调用 submitOrder，但 submitOrder 未发生',
    );
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();

    await expectPromiseRejectsToMatch(
      () => monitor.stopRuntimeAndDrain(),
      /order submitted but local sync failed: MOCK-000001/,
    );

    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(1);
    expect(monitor.getPendingSellOrders('BULL.HK').map((order) => order.orderId)).toEqual([
      'MOCK-000001',
    ]);
    expect([...pendingSellSnapshot.keys()]).toEqual(['SELL-TIMEOUT-LOCAL-SYNC-FAIL']);
    expect(fatalErrors).toHaveLength(1);
    expect((fatalErrors[0] as Error).message).toContain(
      'order submitted but local sync failed: MOCK-000001',
    );
  });

  it('does not allocate replacement relatedBuyOrderIds when timeout sell cancel request succeeds', async () => {
    let allocateCalls = 0;
    const { deps, tradeCtx } = createDeps({
      sellTimeoutSeconds: 0,
      buyTimeoutSeconds: 999,
      allocateRelatedBuyOrderIdsForRecovery: () => {
        allocateCalls += 1;
        return ['BUY-ALLOC'];
      },
    });
    const monitor = createOrderMonitor(deps);

    await monitor.initialize();
    monitor.startRuntime();
    await monitor.recoverOrderTrackingFromSnapshot([
      createPendingRecoveryOrder({
        orderId: 'SELL-RECOVER-ALLOC',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.New,
        submittedAt: new Date(Date.now()),
      }),
    ]);

    await waitForCondition(
      () => tradeCtx.getCalls('cancelOrder').length === 1,
      '[测试] 预期恢复后的超时卖单先发起撤单，但 cancelOrder 未发生',
    );
    const allocateCallsBeforeTimeoutProcessing = allocateCalls;

    expect(tradeCtx.getCalls('cancelOrder')).toHaveLength(1);
    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(0);
    expect(tradeCtx.getCalls('orderDetail')).toHaveLength(0);
    expect(allocateCalls).toBe(allocateCallsBeforeTimeoutProcessing);
  });

  it('cancels timed-out buy order without market conversion', async () => {
    const { deps, tradeCtx } = createDeps({
      buyTimeoutSeconds: 0,
      sellTimeoutSeconds: 999,
    });
    const monitor = createOrderMonitor(deps);

    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.startRuntime();

    monitor.trackOrder({
      orderId: 'BUY-001',
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
    await flushMicrotasks();

    expect(tradeCtx.getCalls('cancelOrder')).toHaveLength(1);
    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(0);
  });

  it('blocks timeout->market conversion when continuous trading is closed', async () => {
    let continuousTradingOpen = false;
    const { deps, tradeCtx } = createDeps({
      sellTimeoutSeconds: 0,
      continuousTradingOpen: () => continuousTradingOpen,
    });
    const monitor = createOrderMonitor(deps);

    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.startRuntime();

    monitor.trackOrder({
      orderId: 'SELL-002',
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
    await flushMicrotasks();

    expect(tradeCtx.getCalls('cancelOrder')).toHaveLength(1);
    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(0);

    continuousTradingOpen = true;
  });

  it('连续交易关闭时不自动跟价改单', async () => {
    const { deps, tradeCtx, setQuotes, emitQuoteUpdated } = createDeps({
      sellTimeoutSeconds: 999,
      buyTimeoutSeconds: 999,
      continuousTradingOpen: () => false,
    });
    setQuotes(new Map([['BULL.HK', createQuoteDouble('BULL.HK', 1)]]));
    const monitor = createOrderMonitor(deps);

    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.startRuntime();
    monitor.trackOrder({
      orderId: 'SELL-REPLACE-CLOSED-CONTINUOUS-SESSION',
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
    await flushMicrotasks();
    setQuotes(new Map([['BULL.HK', createQuoteDouble('BULL.HK', 1.02)]]));

    await emitQuoteUpdated({
      symbol: 'BULL.HK',
      quote: createQuoteDouble('BULL.HK', 1.02),
    });
    await monitor.stopRuntimeAndDrain();

    expect(tradeCtx.getCalls('replaceOrder')).toHaveLength(0);
  });

  it('自动跟价首次失败后连续交易关闭时不再重试 SDK 改单', async () => {
    const runtimeTimers = createRuntimeTimerHarness(Date.parse('2026-02-25T03:10:00.000Z'));
    let continuousTradingOpen = true;
    let replaceAttemptCount = 0;
    try {
      const { deps, tradeCtx, setQuotes, emitQuoteUpdated } = createDeps({
        sellTimeoutSeconds: 999,
        buyTimeoutSeconds: 999,
        continuousTradingOpen: () => continuousTradingOpen,
      });
      tradeCtx.replaceOrder = async () => {
        replaceAttemptCount += 1;
        continuousTradingOpen = false;
        throw new Error('network unavailable');
      };
      setQuotes(new Map([['BULL.HK', createQuoteDouble('BULL.HK', 1)]]));
      const monitor = createOrderMonitor(deps);

      await monitor.initialize();
      await monitor.recoverOrderTrackingFromSnapshot([]);
      monitor.startRuntime();
      monitor.trackOrder({
        orderId: 'SELL-REPLACE-RETRY-CLOSED-CONTINUOUS-SESSION',
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
      await flushMicrotasks();
      setQuotes(new Map([['BULL.HK', createQuoteDouble('BULL.HK', 1.02)]]));

      await emitQuoteUpdated({
        symbol: 'BULL.HK',
        quote: createQuoteDouble('BULL.HK', 1.02),
      });
      await waitForCondition(() => replaceAttemptCount === 1, '[测试] 预期首次自动改单请求发生');
      await runtimeTimers.advanceBy(300);

      expect(replaceAttemptCount).toBe(1);
      await monitor.stopRuntimeAndDrain();
    } finally {
      runtimeTimers.restore();
    }
  });

  it('does not replace orders when status/type is non-replaceable', async () => {
    const { deps, tradeCtx } = createDeps({
      sellTimeoutSeconds: 999,
      buyTimeoutSeconds: 999,
    });
    const monitor = createOrderMonitor(deps);

    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.startRuntime();

    monitor.trackOrder({
      orderId: 'SELL-003',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      price: 1,
      initialSubmittedPrice: 1,
      quantity: 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: OrderType.MO,
    });
    await flushMicrotasks();

    await emitOrderChanged(
      tradeCtx,
      createPushOrderChanged({
        orderId: 'SELL-003',
        symbol: 'BULL.HK',
        status: OrderStatus.WaitToReplace,
        side: OrderSide.Sell,
        orderType: OrderType.MO,
        submittedPrice: 1,
        submittedQuantity: 100,
        executedQuantity: 0,
        executedPrice: 0,
      }),
    );
    await flushMicrotasks();

    expect(tradeCtx.getCalls('replaceOrder')).toHaveLength(0);
  });

  it('recovery keeps strict mode when mismatched buy cancel request succeeds without WS terminal', async () => {
    const { deps, tradeCtx } = createDeps();
    const monitor = createOrderMonitor(deps);
    await monitor.initialize();

    await expectPromiseRejectsToMatch(
      () =>
        monitor.recoverOrderTrackingFromSnapshot([
          createPendingRecoveryOrder({
            orderId: 'BUY-MISMATCH',
            symbol: 'OTHER.HK',
            side: OrderSide.Buy,
            status: OrderStatus.New,
          }),
        ]),
      /终态未确认/,
    );

    expect(tradeCtx.getCalls('todayOrders')).toHaveLength(0);
    expect(tradeCtx.getCalls('cancelOrder')).toHaveLength(1);
  });

  it('recovery blocks when mismatched buy terminal has executed quantity but ownership is unresolved', async () => {
    const { deps, tradeCtx } = createDeps();
    tradeCtx.setFailureRule('cancelOrder', {
      failAtCalls: [1],
      maxFailures: 1,
      errorMessage: 'openapi error: code=603001: Order not found',
    });

    tradeCtx.seedTodayOrders([
      createPendingRecoveryOrder({
        orderId: 'BUY-MISMATCH-PARTIAL',
        symbol: 'OTHER.HK',
        stockName: 'UNKNOWN-ORDER-NAME',
        side: OrderSide.Buy,
        status: OrderStatus.PartialWithdrawal,
        quantity: 100,
        executedQuantity: 20,
        executedPrice: 1.02,
      }) as unknown as Order,
    ]);
    const monitor = createOrderMonitor(deps);
    await monitor.initialize();

    await expectPromiseRejectsToMatch(
      () =>
        monitor.recoverOrderTrackingFromSnapshot([
          createPendingRecoveryOrder({
            orderId: 'BUY-MISMATCH-PARTIAL',
            symbol: 'OTHER.HK',
            stockName: 'UNKNOWN-ORDER-NAME',
            side: OrderSide.Buy,
            status: OrderStatus.New,
          }),
        ]),
      /不匹配但.*存在成交事实/,
    );

    expect(tradeCtx.getCalls('cancelOrder')).toHaveLength(1);
    expect(tradeCtx.getCalls('orderDetail')).toHaveLength(1);
  });

  it('replays bootstrapping filled events after snapshot recovery', async () => {
    const { deps, tradeCtx } = createDeps({});
    const monitor = createOrderMonitor(deps);
    await monitor.initialize();

    await emitOrderChanged(
      tradeCtx,
      createPushOrderChanged({
        orderId: 'SELL-BOOTSTRAP-FILLED',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.Filled,
        orderType: OrderType.ELO,
        submittedPrice: 1,
        executedPrice: 1,
        submittedQuantity: 100,
        executedQuantity: 100,
        updatedAtMs: Date.parse('2026-02-25T03:00:20.000Z'),
      }),
    );

    await monitor.recoverOrderTrackingFromSnapshot([
      createPendingRecoveryOrder({
        orderId: 'SELL-BOOTSTRAP-FILLED',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.New,
        updatedAt: new Date('2026-02-25T03:00:10.000Z'),
      }),
    ]);

    expect(monitor.getPendingSellOrders('BULL.HK')).toHaveLength(0);
  });

  it('stopRuntimeAndDrain 后忽略 late order WS，不再改写 tracked truth', async () => {
    const { deps, tradeCtx } = createDeps({});
    const monitor = createOrderMonitor(deps);
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.startRuntime();

    monitor.trackOrder({
      orderId: 'SELL-STOPPED-LATE-WS',
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
    await flushMicrotasks();

    expect(monitor.getPendingSellOrders('BULL.HK')).toHaveLength(1);

    await monitor.stopRuntimeAndDrain();

    await emitOrderChanged(
      tradeCtx,
      createPushOrderChanged({
        orderId: 'SELL-STOPPED-LATE-WS',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.Filled,
        orderType: OrderType.ELO,
        submittedPrice: 1,
        executedPrice: 1,
        submittedQuantity: 100,
        executedQuantity: 100,
      }),
    );

    expect(monitor.getPendingSellOrders('BULL.HK')).toHaveLength(1);
  });

  it('clearTrackedOrders 后到下一次 initialize 前的 late WS 不会污染下一轮 recovery', async () => {
    const { deps, tradeCtx } = createDeps({});
    const monitor = createOrderMonitor(deps);
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.startRuntime();
    await monitor.stopRuntimeAndDrain();
    monitor.clearTrackedOrders();

    await emitOrderChanged(
      tradeCtx,
      createPushOrderChanged({
        orderId: 'SELL-CLEAR-STALE-WS',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.Filled,
        orderType: OrderType.ELO,
        submittedPrice: 1,
        executedPrice: 1,
        submittedQuantity: 100,
        executedQuantity: 100,
        updatedAtMs: Date.parse('2026-02-25T03:00:20.000Z'),
      }),
    );

    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([
      createPendingRecoveryOrder({
        orderId: 'SELL-CLEAR-STALE-WS',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.New,
        updatedAt: new Date('2026-02-25T03:00:10.000Z'),
      }),
    ]);

    expect(monitor.getPendingSellOrders('BULL.HK')).toHaveLength(1);
  });

  it('restores protective liquidation semantics for recovered pending sells', async () => {
    const progressCalls: Array<{
      direction: 'LONG' | 'SHORT';
      symbol: string;
      executedTimeMs: number;
    }> = [];
    let cumulativeCallCount = 0;
    const executedTimeMs = Date.parse('2026-02-25T03:20:00.000Z');
    const { deps, tradeCtx } = createDeps({
      dailyLossTrackerOverride: createDailyLossTrackerDouble({
        recordCumulativeExecution: () => {
          cumulativeCallCount += 1;
          return { authoritativeFactChanged: true, executionAdvanced: cumulativeCallCount === 1 };
        },
      }),
      protectiveLiquidationEpisodeTrackerOverride: createProtectiveLiquidationEpisodeTrackerDouble({
        recordProtectiveFillProgress: (params) => {
          progressCalls.push(params);
        },
      }),
    });
    const monitor = createOrderMonitor(deps);
    await monitor.initialize();

    await monitor.recoverOrderTrackingFromSnapshot([
      createPendingRecoveryOrder({
        orderId: 'SELL-RECOVER-PROTECTIVE',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.New,
        remark: 'QuantDemo|PL',
      }),
    ]);

    await emitOrderChanged(
      tradeCtx,
      createPushOrderChanged({
        orderId: 'SELL-RECOVER-PROTECTIVE',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.Filled,
        orderType: OrderType.ELO,
        submittedPrice: 1,
        submittedQuantity: 100,
        executedPrice: 1,
        executedQuantity: 100,
        updatedAtMs: executedTimeMs,
      }),
    );

    expect(progressCalls).toHaveLength(1);
    expect(progressCalls[0]).toEqual({
      direction: 'LONG',
      symbol: 'BULL.HK',
      executedTimeMs,
    });
  });

  it('fails fast when pending sell ownership cannot be resolved', async () => {
    const { deps } = createDeps();
    const monitor = createOrderMonitor(deps);
    await monitor.initialize();

    await expectPromiseRejectsToMatch(
      () =>
        monitor.recoverOrderTrackingFromSnapshot([
          createPendingRecoveryOrder({
            orderId: 'SELL-UNRESOLVED',
            symbol: 'BULL.HK',
            side: OrderSide.Sell,
            stockName: 'UNKNOWN-ORDER-NAME',
            status: OrderStatus.New,
          }),
        ]),
      /无法解析归属/,
    );
  });

  it('clears recovered sell runtime state when mismatched buy cancel fails, and remains strict on later cancel success', async () => {
    const { deps, tradeCtx } = createDeps();
    const monitor = createOrderMonitor(deps);
    await monitor.initialize();

    tradeCtx.setFailureRule('cancelOrder', {
      failAtCalls: [1],
      maxFailures: 1,
      errorMessage: 'simulated cancel failure',
    });

    const pendingSell = createPendingRecoveryOrder({
      orderId: 'SELL-RECOVER-FAIL-001',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      status: OrderStatus.New,
    });
    const mismatchedPendingBuy = createPendingRecoveryOrder({
      orderId: 'BUY-RECOVER-FAIL-001',
      symbol: 'OTHER.HK',
      side: OrderSide.Buy,
      status: OrderStatus.New,
    });

    await expectPromiseRejectsToMatch(
      () => monitor.recoverOrderTrackingFromSnapshot([pendingSell, mismatchedPendingBuy]),
      /撤单失败|终态未确认/,
    );
    expect(monitor.getPendingSellOrders('BULL.HK')).toHaveLength(0);

    tradeCtx.clearFailureRules();
    await expectPromiseRejectsToMatch(
      () => monitor.recoverOrderTrackingFromSnapshot([pendingSell, mismatchedPendingBuy]),
      /终态未确认/,
    );
    expect(monitor.getPendingSellOrders('BULL.HK')).toHaveLength(0);
    expect(tradeCtx.getCalls('cancelOrder')).toHaveLength(2);
  });

  it('restores submittedAt from snapshot when recovering pending sells', async () => {
    const { deps } = createDeps();
    const monitor = createOrderMonitor(deps);
    await monitor.initialize();

    const submittedAt = new Date('2026-02-25T01:23:45.000Z');
    await monitor.recoverOrderTrackingFromSnapshot([
      createPendingRecoveryOrder({
        orderId: 'SELL-RESTORE-TIME',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.New,
        submittedAt,
      }),
    ]);

    const pending = monitor.getPendingSellOrders('BULL.HK');
    expect(pending).toHaveLength(1);
    expect(pending[0]?.submittedAt).toBe(submittedAt.getTime());
  });

  it('keeps wait-to-replace status from snapshot to avoid replace during recovery window', async () => {
    const { deps, tradeCtx } = createDeps({
      sellTimeoutSeconds: 999,
      buyTimeoutSeconds: 999,
    });
    const monitor = createOrderMonitor(deps);
    await monitor.initialize();

    await monitor.recoverOrderTrackingFromSnapshot([
      createPendingRecoveryOrder({
        orderId: 'BUY-WAIT-TO-REPLACE',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
        status: OrderStatus.WaitToReplace,
        submittedAt: new Date(),
      }),
    ]);
    monitor.startRuntime();
    await flushMicrotasks();

    expect(tradeCtx.getCalls('replaceOrder')).toHaveLength(0);
  });

  it('startRuntime 会补跑 start 前积压的 TRACKED 唤醒并推进已超时买单', async () => {
    const { deps, tradeCtx } = createDeps({
      buyTimeoutSeconds: 0,
      sellTimeoutSeconds: 999,
    });
    const monitor = createOrderMonitor(deps);
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);

    monitor.trackOrder({
      orderId: 'BUY-TIMER-START-1',
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
    monitor.startRuntime();

    await waitForCondition(
      () => tradeCtx.getCalls('cancelOrder').length === 1,
      '[测试] 预期 startRuntime 后补跑积压唤醒并推进超时买单，但 cancelOrder 未发生',
    );

    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(0);
  });

  it('runtime 运行中会在买单超时到点后自动推进，无需 quote 或手动轮询', async () => {
    const runtimeTimers = createRuntimeTimerHarness(Date.parse('2026-02-25T03:00:00.000Z'));
    try {
      const { deps, tradeCtx } = createDeps({
        buyTimeoutSeconds: 0.02,
        sellTimeoutSeconds: 999,
      });
      const monitor = createOrderMonitor(deps);
      await monitor.initialize();
      await monitor.recoverOrderTrackingFromSnapshot([]);
      monitor.startRuntime();

      monitor.trackOrder({
        orderId: 'BUY-TIMER-DELAY-1',
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
      await flushMicrotasks();

      expect(tradeCtx.getCalls('cancelOrder')).toHaveLength(0);

      await runtimeTimers.advanceBy(25);
      await waitForCondition(
        () => tradeCtx.getCalls('cancelOrder').length === 1,
        '[测试] 预期 timeout timer 到点后自动推进买单，但 cancelOrder 未发生',
      );

      expect(tradeCtx.getCalls('submitOrder')).toHaveLength(0);
    } finally {
      runtimeTimers.restore();
    }
  });

  it('does not submit market sell when timeout cancel returns already-filled (601012)', async () => {
    const { deps, tradeCtx } = createDeps({
      sellTimeoutSeconds: 0,
      buyTimeoutSeconds: 999,
    });
    tradeCtx.setFailureRule('cancelOrder', {
      failAtCalls: [1],
      maxFailures: 1,
      errorMessage: 'openapi error: code=601012: Order has been filled',
    });
    const monitor = createOrderMonitor(deps);
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.startRuntime();

    monitor.trackOrder({
      orderId: 'SELL-TIMEOUT-ALREADY-FILLED',
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
    await flushMicrotasks();

    expect(tradeCtx.getCalls('cancelOrder')).toHaveLength(1);
    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(0);
  });

  it('records local buy when timeout cancel fails by network error and filled event arrives later', async () => {
    let localBuyCount = 0;
    const { deps, tradeCtx } = createDeps({
      buyTimeoutSeconds: 0,
      sellTimeoutSeconds: 999,
      orderRecorderOverride: createOrderRecorderDouble({
        recordLocalBuy: () => {
          localBuyCount += 1;
        },
      }),
    });
    tradeCtx.setFailureRule('cancelOrder', {
      failAtCalls: [1],
      maxFailures: 1,
      errorMessage: 'network timeout',
    });

    const monitor = createOrderMonitor(deps);
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.startRuntime();

    monitor.trackOrder({
      orderId: 'BUY-TIMEOUT-NETWORK-FAIL',
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
    await flushMicrotasks();

    await emitOrderChanged(
      tradeCtx,
      createPushOrderChanged({
        orderId: 'BUY-TIMEOUT-NETWORK-FAIL',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
        status: OrderStatus.Filled,
        orderType: OrderType.ELO,
        submittedPrice: 1,
        submittedQuantity: 100,
        executedPrice: 1,
        executedQuantity: 100,
      }),
    );

    expect(localBuyCount).toBe(1);
  });

  it('settles filled quantity once when sell is canceled after partial fill', async () => {
    const pendingSellSnapshot = new Map<string, PendingSellInfo>();
    const buyOrders: ReadonlyArray<OrderRecord> = [
      {
        orderId: 'BUY-1',
        symbol: 'BULL.HK',
        executedPrice: 1,
        executedQuantity: 100,
        executedTime: Date.parse('2026-02-25T03:00:00.000Z'),
        submittedAt: new Date('2026-02-25T03:00:00.000Z'),
        updatedAt: new Date('2026-02-25T03:00:00.000Z'),
      },
      {
        orderId: 'BUY-2',
        symbol: 'BULL.HK',
        executedPrice: 1.2,
        executedQuantity: 100,
        executedTime: Date.parse('2026-02-25T03:05:00.000Z'),
        submittedAt: new Date('2026-02-25T03:05:00.000Z'),
        updatedAt: new Date('2026-02-25T03:05:00.000Z'),
      },
    ];
    const recordLocalSellCalls: Array<RecordLocalSellCall> = [];
    const dailyLossFacts: DailyLossCumulativeExecutionInput[] = [];
    let partialCount = 0;
    let cancelCount = 0;
    const refreshNeeds: Array<{
      readonly refreshAccount: boolean;
      readonly refreshPositions: boolean;
    }> = [];
    const partialExecutionMs = Date.parse('2026-02-25T03:10:00.000Z');
    const terminalRevisionMs = Date.parse('2026-02-25T03:11:00.000Z');
    const orderRecorder = createOrderRecorderDouble({
      submitSellOrder: (
        orderId: string,
        symbol: string,
        direction: 'LONG' | 'SHORT',
        quantity: number,
        relatedBuyOrderIds: readonly string[],
        submittedAtMs?: number,
      ) => {
        pendingSellSnapshot.set(orderId, {
          orderId,
          symbol,
          direction,
          submittedQuantity: quantity,
          filledQuantity: 0,
          relatedBuyOrderIds,
          status: 'pending',
          submittedAt: submittedAtMs ?? Date.now(),
        });
      },
      markSellPartialFilled: (orderId: string, filledQuantity: number) => {
        const current = pendingSellSnapshot.get(orderId);
        if (!current) {
          return null;
        }

        partialCount += 1;
        const updated: PendingSellInfo = {
          ...current,
          filledQuantity,
          status: 'partial',
        };
        pendingSellSnapshot.set(orderId, updated);
        return updated;
      },
      markSellCancelled: (orderId: string) => {
        const current = pendingSellSnapshot.get(orderId);
        if (!current) {
          return null;
        }

        cancelCount += 1;
        pendingSellSnapshot.delete(orderId);
        return {
          ...current,
          status: 'cancelled',
        };
      },
      getBuyOrdersForSymbol: () => buyOrders,
      recordLocalSell: (
        _symbol,
        _executedPrice,
        _executedQuantity,
        _isLongSymbol,
        _executedTimeMs,
        _orderId,
        relatedBuyOrderIds,
      ) => {
        recordLocalSellCalls.push({
          relatedBuyOrderIds: relatedBuyOrderIds ?? null,
        });
      },
    });
    const { deps, tradeCtx } = createDeps({
      orderRecorderOverride: orderRecorder,
      dailyLossTrackerOverride: {
        resetAll: () => {},
        prepareProtectionBoundary: (params) => ({ ...params, orderBaselines: [] }),
        commitProtectionBoundary: () => {},
        restoreExecutionSnapshot: () => {},
        restoreProtectionBoundary: () => {},
        recalculateFromAllOrders: () => {},
        recordCumulativeExecution: (input: DailyLossCumulativeExecutionInput) => {
          dailyLossFacts.push(input);
          return {
            authoritativeFactChanged: true,
            executionAdvanced: input.factStage === 'OPEN',
          };
        },
        getLossOffset: () => 0,
      },
      onRecordSettlementRefreshNeed: (need) => {
        refreshNeeds.push(need);
      },
    });
    const monitor = createOrderMonitor(deps);
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);

    orderRecorder.submitSellOrder('SELL-PARTIAL-CANCELED', 'BULL.HK', 'LONG', 200, [
      'BUY-1',
      'BUY-2',
    ]);

    monitor.trackOrder({
      orderId: 'SELL-PARTIAL-CANCELED',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      price: 1,
      initialSubmittedPrice: 1,
      quantity: 200,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: OrderType.ELO,
    });

    await emitOrderChanged(
      tradeCtx,
      createPushOrderChanged({
        orderId: 'SELL-PARTIAL-CANCELED',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.PartialFilled,
        orderType: OrderType.ELO,
        submittedPrice: 1,
        submittedQuantity: 200,
        executedPrice: 1.05,
        executedQuantity: 100,
        updatedAtMs: partialExecutionMs,
      }),
    );

    await emitOrderChanged(
      tradeCtx,
      createPushOrderChanged({
        orderId: 'SELL-PARTIAL-CANCELED',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.Canceled,
        orderType: OrderType.ELO,
        submittedPrice: 1,
        submittedQuantity: 200,
        executedPrice: 1.05,
        executedQuantity: 100,
        updatedAtMs: terminalRevisionMs,
      }),
    );

    await emitOrderChanged(
      tradeCtx,
      createPushOrderChanged({
        orderId: 'SELL-PARTIAL-CANCELED',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.Canceled,
        orderType: OrderType.ELO,
        submittedPrice: 1,
        submittedQuantity: 200,
        executedPrice: 1.05,
        executedQuantity: 100,
        updatedAtMs: Date.parse('2026-02-25T03:12:00.000Z'),
      }),
    );

    expect(partialCount).toBe(1);
    expect(cancelCount).toBe(1);
    expect(recordLocalSellCalls).toHaveLength(1);
    expect(recordLocalSellCalls[0]?.relatedBuyOrderIds).toEqual(['BUY-1']);
    expect(dailyLossFacts).toEqual([
      {
        factStage: 'OPEN',
        direction: 'LONG',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        executedPrice: 1.05,
        executedQuantity: 100,
        executedTimeMs: partialExecutionMs,
        orderUpdatedAtMs: partialExecutionMs,
        orderId: 'SELL-PARTIAL-CANCELED',
      },
      {
        factStage: 'TERMINAL',
        direction: 'LONG',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        executedPrice: 1.05,
        executedQuantity: 100,
        executedTimeMs: partialExecutionMs,
        orderUpdatedAtMs: terminalRevisionMs,
        orderId: 'SELL-PARTIAL-CANCELED',
      },
    ]);
    expect(monitor.getPendingSellOrders('BULL.HK')).toHaveLength(0);
    expect(refreshNeeds).toEqual([
      {
        refreshAccount: true,
        refreshPositions: true,
      },
      {
        refreshAccount: true,
        refreshPositions: true,
      },
    ]);
  });

  it('settles filled quantity once when sell is rejected after partial fill', async () => {
    const pendingSellSnapshot = new Map<string, PendingSellInfo>();
    const buyOrders: ReadonlyArray<OrderRecord> = [
      {
        orderId: 'BUY-1',
        symbol: 'BULL.HK',
        executedPrice: 1,
        executedQuantity: 100,
        executedTime: Date.parse('2026-02-25T03:00:00.000Z'),
        submittedAt: new Date('2026-02-25T03:00:00.000Z'),
        updatedAt: new Date('2026-02-25T03:00:00.000Z'),
      },
      {
        orderId: 'BUY-2',
        symbol: 'BULL.HK',
        executedPrice: 1.2,
        executedQuantity: 100,
        executedTime: Date.parse('2026-02-25T03:05:00.000Z'),
        submittedAt: new Date('2026-02-25T03:05:00.000Z'),
        updatedAt: new Date('2026-02-25T03:05:00.000Z'),
      },
    ];
    const recordLocalSellCalls: Array<RecordLocalSellCall> = [];
    const dailyLossFacts: DailyLossCumulativeExecutionInput[] = [];
    let partialCount = 0;
    let cancelCount = 0;
    const refreshNeeds: Array<{
      readonly refreshAccount: boolean;
      readonly refreshPositions: boolean;
    }> = [];
    const partialExecutionMs = Date.parse('2026-02-25T03:10:00.000Z');
    const terminalRevisionMs = Date.parse('2026-02-25T03:11:00.000Z');
    const orderRecorder = createOrderRecorderDouble({
      submitSellOrder: (
        orderId: string,
        symbol: string,
        direction: 'LONG' | 'SHORT',
        quantity: number,
        relatedBuyOrderIds: readonly string[],
        submittedAtMs?: number,
      ) => {
        pendingSellSnapshot.set(orderId, {
          orderId,
          symbol,
          direction,
          submittedQuantity: quantity,
          filledQuantity: 0,
          relatedBuyOrderIds,
          status: 'pending',
          submittedAt: submittedAtMs ?? Date.now(),
        });
      },
      markSellPartialFilled: (orderId: string, filledQuantity: number) => {
        const current = pendingSellSnapshot.get(orderId);
        if (!current) {
          return null;
        }

        partialCount += 1;
        const updated: PendingSellInfo = {
          ...current,
          filledQuantity,
          status: 'partial',
        };
        pendingSellSnapshot.set(orderId, updated);
        return updated;
      },
      markSellCancelled: (orderId: string) => {
        const current = pendingSellSnapshot.get(orderId);
        if (!current) {
          return null;
        }

        cancelCount += 1;
        pendingSellSnapshot.delete(orderId);
        return {
          ...current,
          status: 'cancelled',
        };
      },
      getBuyOrdersForSymbol: () => buyOrders,
      recordLocalSell: (
        _symbol,
        _executedPrice,
        _executedQuantity,
        _isLongSymbol,
        _executedTimeMs,
        _orderId,
        relatedBuyOrderIds,
      ) => {
        recordLocalSellCalls.push({
          relatedBuyOrderIds: relatedBuyOrderIds ?? null,
        });
      },
    });
    const { deps, tradeCtx } = createDeps({
      orderRecorderOverride: orderRecorder,
      dailyLossTrackerOverride: {
        resetAll: () => {},
        prepareProtectionBoundary: (params) => ({ ...params, orderBaselines: [] }),
        commitProtectionBoundary: () => {},
        restoreExecutionSnapshot: () => {},
        restoreProtectionBoundary: () => {},
        recalculateFromAllOrders: () => {},
        recordCumulativeExecution: (input: DailyLossCumulativeExecutionInput) => {
          dailyLossFacts.push(input);
          return {
            authoritativeFactChanged: true,
            executionAdvanced: input.factStage === 'OPEN',
          };
        },
        getLossOffset: () => 0,
      },
      onRecordSettlementRefreshNeed: (need) => {
        refreshNeeds.push(need);
      },
    });
    const monitor = createOrderMonitor(deps);
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);

    orderRecorder.submitSellOrder('SELL-PARTIAL-REJECTED', 'BULL.HK', 'LONG', 200, [
      'BUY-1',
      'BUY-2',
    ]);

    monitor.trackOrder({
      orderId: 'SELL-PARTIAL-REJECTED',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      price: 1,
      initialSubmittedPrice: 1,
      quantity: 200,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: OrderType.ELO,
    });

    await emitOrderChanged(
      tradeCtx,
      createPushOrderChanged({
        orderId: 'SELL-PARTIAL-REJECTED',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.PartialFilled,
        orderType: OrderType.ELO,
        submittedPrice: 1,
        submittedQuantity: 200,
        executedPrice: 1.05,
        executedQuantity: 100,
        updatedAtMs: partialExecutionMs,
      }),
    );

    await emitOrderChanged(
      tradeCtx,
      createPushOrderChanged({
        orderId: 'SELL-PARTIAL-REJECTED',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.Rejected,
        orderType: OrderType.ELO,
        submittedPrice: 1,
        submittedQuantity: 200,
        executedPrice: 1.05,
        executedQuantity: 100,
        updatedAtMs: terminalRevisionMs,
      }),
    );

    await emitOrderChanged(
      tradeCtx,
      createPushOrderChanged({
        orderId: 'SELL-PARTIAL-REJECTED',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.Rejected,
        orderType: OrderType.ELO,
        submittedPrice: 1,
        submittedQuantity: 200,
        executedPrice: 1.05,
        executedQuantity: 100,
        updatedAtMs: Date.parse('2026-02-25T03:12:00.000Z'),
      }),
    );

    expect(partialCount).toBe(1);
    expect(cancelCount).toBe(1);
    expect(recordLocalSellCalls).toHaveLength(1);
    expect(recordLocalSellCalls[0]?.relatedBuyOrderIds).toEqual(['BUY-1']);
    expect(dailyLossFacts).toEqual([
      {
        factStage: 'OPEN',
        direction: 'LONG',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        executedPrice: 1.05,
        executedQuantity: 100,
        executedTimeMs: partialExecutionMs,
        orderUpdatedAtMs: partialExecutionMs,
        orderId: 'SELL-PARTIAL-REJECTED',
      },
      {
        factStage: 'TERMINAL',
        direction: 'LONG',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        executedPrice: 1.05,
        executedQuantity: 100,
        executedTimeMs: partialExecutionMs,
        orderUpdatedAtMs: terminalRevisionMs,
        orderId: 'SELL-PARTIAL-REJECTED',
      },
    ]);
    expect(monitor.getPendingSellOrders('BULL.HK')).toHaveLength(0);
    expect(refreshNeeds).toEqual([
      {
        refreshAccount: true,
        refreshPositions: true,
      },
      {
        refreshAccount: true,
        refreshPositions: true,
      },
    ]);
  });

  it('falls back to quantity-based local settlement when partial fill cannot be mapped to exact buy orders', async () => {
    const pendingSellSnapshot = new Map<string, PendingSellInfo>();
    const buyOrders: ReadonlyArray<OrderRecord> = [
      {
        orderId: 'BUY-A',
        symbol: 'BULL.HK',
        executedPrice: 1,
        executedQuantity: 70,
        executedTime: Date.parse('2026-02-25T03:00:00.000Z'),
        submittedAt: new Date('2026-02-25T03:00:00.000Z'),
        updatedAt: new Date('2026-02-25T03:00:00.000Z'),
      },
      {
        orderId: 'BUY-B',
        symbol: 'BULL.HK',
        executedPrice: 1.2,
        executedQuantity: 70,
        executedTime: Date.parse('2026-02-25T03:05:00.000Z'),
        submittedAt: new Date('2026-02-25T03:05:00.000Z'),
        updatedAt: new Date('2026-02-25T03:05:00.000Z'),
      },
    ];
    const recordLocalSellCalls: Array<RecordLocalSellCall> = [];
    const orderRecorder = createOrderRecorderDouble({
      submitSellOrder: (
        orderId: string,
        symbol: string,
        direction: 'LONG' | 'SHORT',
        quantity: number,
        relatedBuyOrderIds: readonly string[],
        submittedAtMs?: number,
      ) => {
        pendingSellSnapshot.set(orderId, {
          orderId,
          symbol,
          direction,
          submittedQuantity: quantity,
          filledQuantity: 0,
          relatedBuyOrderIds,
          status: 'pending',
          submittedAt: submittedAtMs ?? Date.now(),
        });
      },
      markSellPartialFilled: (orderId: string, filledQuantity: number) => {
        const current = pendingSellSnapshot.get(orderId);
        if (!current) {
          return null;
        }

        const updated: PendingSellInfo = {
          ...current,
          filledQuantity,
          status: 'partial',
        };
        pendingSellSnapshot.set(orderId, updated);
        return updated;
      },
      markSellCancelled: (orderId: string) => {
        const current = pendingSellSnapshot.get(orderId);
        if (!current) {
          return null;
        }

        pendingSellSnapshot.delete(orderId);
        return {
          ...current,
          status: 'cancelled',
        };
      },
      getBuyOrdersForSymbol: () => buyOrders,
      recordLocalSell: (
        _symbol,
        _executedPrice,
        _executedQuantity,
        _isLongSymbol,
        _executedTimeMs,
        _orderId,
        relatedBuyOrderIds,
      ) => {
        recordLocalSellCalls.push({
          relatedBuyOrderIds: relatedBuyOrderIds ?? null,
        });
      },
    });
    const { deps, tradeCtx } = createDeps({
      orderRecorderOverride: orderRecorder,
    });
    const monitor = createOrderMonitor(deps);
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);

    orderRecorder.submitSellOrder('SELL-PARTIAL-FALLBACK', 'BULL.HK', 'LONG', 140, [
      'BUY-A',
      'BUY-B',
    ]);

    monitor.trackOrder({
      orderId: 'SELL-PARTIAL-FALLBACK',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      price: 1,
      initialSubmittedPrice: 1,
      quantity: 140,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: OrderType.ELO,
    });

    await emitOrderChanged(
      tradeCtx,
      createPushOrderChanged({
        orderId: 'SELL-PARTIAL-FALLBACK',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.PartialFilled,
        orderType: OrderType.ELO,
        submittedPrice: 1,
        submittedQuantity: 140,
        executedPrice: 1.05,
        executedQuantity: 100,
        updatedAtMs: Date.parse('2026-02-25T03:10:00.000Z'),
      }),
    );

    await emitOrderChanged(
      tradeCtx,
      createPushOrderChanged({
        orderId: 'SELL-PARTIAL-FALLBACK',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.Canceled,
        orderType: OrderType.ELO,
        submittedPrice: 1,
        submittedQuantity: 140,
        executedPrice: 1.05,
        executedQuantity: 100,
        updatedAtMs: Date.parse('2026-02-25T03:11:00.000Z'),
      }),
    );

    expect(recordLocalSellCalls).toHaveLength(1);
    expect(recordLocalSellCalls[0]?.relatedBuyOrderIds).toBeNull();
  });

  it('cleans tracked order when cancel returns already-canceled (601011) and orderDetail confirms terminal', async () => {
    const runtimeTimers = createRuntimeTimerHarness(Date.parse('2026-02-25T03:00:00.000Z'));
    try {
      const { deps, tradeCtx } = createDeps({
        buyTimeoutSeconds: 0,
        sellTimeoutSeconds: 999,
      });
      tradeCtx.setFailureRule('cancelOrder', {
        failAtCalls: [1],
        maxFailures: 1,
        errorMessage: 'openapi error: code=601011: Order has been cancelled',
      });

      tradeCtx.seedTodayOrders([
        createPendingRecoveryOrder({
          orderId: 'BUY-TIMEOUT-601011',
          symbol: 'BULL.HK',
          side: OrderSide.Buy,
          status: OrderStatus.Canceled,
          quantity: 100,
          executedQuantity: 0,
          executedPrice: 0,
          updatedAt: new Date('2026-02-25T03:00:05.000Z'),
        }) as unknown as Order,
      ]);
      const monitor = createOrderMonitor(deps);
      await monitor.initialize();
      await monitor.recoverOrderTrackingFromSnapshot([]);
      monitor.startRuntime();

      monitor.trackOrder({
        orderId: 'BUY-TIMEOUT-601011',
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
      await flushMicrotasks();

      expect(tradeCtx.getCalls('cancelOrder')).toHaveLength(1);
      expect(tradeCtx.getCalls('orderDetail')).toHaveLength(0);

      await runtimeTimers.advanceBy(2_000);

      expect(tradeCtx.getCalls('cancelOrder')).toHaveLength(1);
      expect(tradeCtx.getCalls('orderDetail')).toHaveLength(1);
    } finally {
      runtimeTimers.restore();
    }
  });

  it('runtime 会在 602013 backoff 到期后自动补跑 replace，无需新 quote', async () => {
    const { deps, tradeCtx, emitQuoteUpdated } = createDeps({
      sellTimeoutSeconds: 999,
      buyTimeoutSeconds: 999,
    });
    tradeCtx.setFailureRule('replaceOrder', {
      failAtCalls: [1],
      maxFailures: 1,
      errorMessage: 'openapi error: code=602013: status does not allow amendment',
    });
    const monitor = createOrderMonitor(deps);
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.startRuntime();

    monitor.trackOrder({
      orderId: 'SELL-REPLACE-RETRY-TIMER',
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
    await flushMicrotasks();

    await emitQuoteUpdated({
      symbol: 'BULL.HK',
      quote: createQuoteDouble('BULL.HK', 1.02),
    });

    expect(tradeCtx.getCalls('replaceOrder')).toHaveLength(1);

    await waitForConditionWithDelay(
      () => tradeCtx.getCalls('replaceOrder').length === 2,
      '[测试] 预期 602013 backoff 到期后 runtime 自动补跑 replace，但第二次 replace 未发生',
      260,
      5,
    );
  });

  it('runtime 会在 quote retry 耗尽后被后续恢复的有效 quote 重新唤醒 replace flow', async () => {
    const originalNow = Date.now;
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    let nowMs = Date.parse('2026-04-09T10:10:00.000Z');
    const timers = new Map<unknown, { atMs: number; callback: () => void }>();

    function isTimerCallback(
      handler: Parameters<typeof globalThis.setTimeout>[0],
    ): handler is (...args: ReadonlyArray<unknown>) => void {
      return typeof handler === 'function';
    }

    function advanceRuntimeTimersBy(delayMs: number): Promise<void> {
      nowMs += delayMs;
      const dueTimers = [...timers.entries()].filter(([, timer]) => timer.atMs <= nowMs);
      for (const [handle, timer] of dueTimers) {
        timers.delete(handle);
        timer.callback();
      }

      return flushMicrotasks().then(() => flushMicrotasks());
    }

    const fakeSetTimeout = Object.assign(
      (
        handler: Parameters<typeof globalThis.setTimeout>[0],
        timeout?: number,
      ): ReturnType<typeof originalSetTimeout> => {
        if (!isTimerCallback(handler)) {
          throw new TypeError('[测试] fake runtime timer 仅支持函数回调');
        }

        const handle = originalSetTimeout(() => {}, 0);
        originalClearTimeout(handle);
        timers.set(handle, {
          atMs: nowMs + (typeof timeout === 'number' ? timeout : 0),
          callback: () => {
            handler();
          },
        });
        return handle;
      },
      {
        __promisify__: originalSetTimeout.__promisify__,
      },
    );

    const fakeClearTimeout: typeof globalThis.clearTimeout = (handle) => {
      timers.delete(handle);
    };

    Date.now = () => nowMs;
    globalThis.setTimeout = fakeSetTimeout;
    globalThis.clearTimeout = fakeClearTimeout;

    const { deps, tradeCtx, emitQuoteUpdated } = createDeps({
      sellTimeoutSeconds: 999,
      buyTimeoutSeconds: 999,
    });
    const monitor = createOrderMonitor(deps);

    try {
      await monitor.initialize();
      await monitor.recoverOrderTrackingFromSnapshot([]);
      monitor.startRuntime();

      monitor.trackOrder({
        orderId: 'SELL-QUOTE-RETRY-RUNTIME',
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
      await flushMicrotasks();

      await emitQuoteUpdated({
        symbol: 'BULL.HK',
        quote: createQuoteDouble('BULL.HK', 0),
      });

      for (let attempt = 0; attempt < 5; attempt += 1) {
        await advanceRuntimeTimersBy(2_000);
      }

      await emitQuoteUpdated({
        symbol: 'BULL.HK',
        quote: createQuoteDouble('BULL.HK', 1.05),
      });

      expect(tradeCtx.getCalls('replaceOrder')).toHaveLength(1);
      expect(monitor.getPendingSellOrders('BULL.HK')).toHaveLength(1);
      expect(monitor.getPendingSellOrders('BULL.HK')[0]?.orderId).toBe('SELL-QUOTE-RETRY-RUNTIME');
    } finally {
      Date.now = originalNow;
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });

  it('重复 initialize 不会把已 ACTIVE 的 runtime 打回 BOOTSTRAPPING', async () => {
    const runtimeTimers = createRuntimeTimerHarness(Date.parse('2026-04-10T09:30:00.000Z'));

    try {
      const { deps, tradeCtx } = createDeps({
        sellTimeoutSeconds: 999,
        buyTimeoutSeconds: 1,
      });
      const monitor = createOrderMonitor(deps);
      await monitor.initialize();
      await monitor.recoverOrderTrackingFromSnapshot([]);
      monitor.startRuntime();

      await monitor.initialize();

      monitor.trackOrder({
        orderId: 'BUY-INITIALIZE-ACTIVE-SHOULD-STAY-ACTIVE',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
        price: 1,
        initialSubmittedPrice: 1,
        quantity: 100,
        submittedAtMs: Date.now() - 10_000,
        isLongSymbol: true,
        monitorSymbol: 'HSI.HK',
        isProtectiveLiquidation: false,
        orderType: OrderType.ELO,
      });
      await flushMicrotasks();
      await runtimeTimers.advanceBy(0);

      expect(tradeCtx.getCalls('cancelOrder')).toHaveLength(1);
      expect(tradeCtx.getCalls('cancelOrder')[0]?.args[0]).toBe(
        'BUY-INITIALIZE-ACTIVE-SHOULD-STAY-ACTIVE',
      );

      await emitOrderChanged(
        tradeCtx,
        createPushOrderChanged({
          orderId: 'BUY-INITIALIZE-ACTIVE-SHOULD-STAY-ACTIVE',
          symbol: 'BULL.HK',
          side: OrderSide.Buy,
          status: OrderStatus.Canceled,
          orderType: OrderType.ELO,
          submittedPrice: 1,
          submittedQuantity: 100,
          executedPrice: 0,
          executedQuantity: 0,
        }),
      );
      await flushMicrotasks();

      expect(monitor.getPendingSellOrders('BULL.HK')).toHaveLength(0);
    } finally {
      runtimeTimers.restore();
    }
  });

  it('marks 602012 as permanently unsupported and skips further replace attempts', async () => {
    const { deps, tradeCtx, emitQuoteUpdated } = createDeps({
      sellTimeoutSeconds: 999,
      buyTimeoutSeconds: 999,
    });
    tradeCtx.setFailureRule('replaceOrder', {
      failAtCalls: [1],
      maxFailures: 1,
      errorMessage: 'openapi error: code=602012: not supported by type',
    });
    const monitor = createOrderMonitor(deps);
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.startRuntime();

    monitor.trackOrder({
      orderId: 'SELL-REPLACE-602012',
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
    await flushMicrotasks();

    await emitQuoteUpdated({
      symbol: 'BULL.HK',
      quote: createQuoteDouble('BULL.HK', 1.05),
    });

    expect(tradeCtx.getCalls('replaceOrder')).toHaveLength(1);

    await emitQuoteUpdated({
      symbol: 'BULL.HK',
      quote: createQuoteDouble('BULL.HK', 1.06),
    });

    expect(tradeCtx.getCalls('replaceOrder')).toHaveLength(1);
  });

  it('marks 602013 as temporarily blocked and escalates to orderDetail on 5th consecutive hit', async () => {
    const runtimeTimers = createRuntimeTimerHarness(Date.parse('2026-02-25T03:00:00.000Z'));

    const { deps, tradeCtx, emitQuoteUpdated } = createDeps({
      sellTimeoutSeconds: 999,
      buyTimeoutSeconds: 999,
    });
    tradeCtx.setFailureRule('replaceOrder', {
      failAtCalls: [1, 2, 3, 4, 5],
      maxFailures: 5,
      errorMessage: 'openapi error: code=602013: status does not allow amendment',
    });

    tradeCtx.seedTodayOrders([
      createPendingRecoveryOrder({
        orderId: 'SELL-REPLACE-602013',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.PendingReplace,
        quantity: 100,
        executedQuantity: 0,
        executedPrice: 0,
      }) as unknown as Order,
    ]);
    const monitor = createOrderMonitor(deps);
    try {
      await monitor.initialize();
      await monitor.recoverOrderTrackingFromSnapshot([]);
      monitor.startRuntime();

      monitor.trackOrder({
        orderId: 'SELL-REPLACE-602013',
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
      await flushMicrotasks();
      await emitQuoteUpdated({
        symbol: 'BULL.HK',
        quote: createQuoteDouble('BULL.HK', 1.05),
      });

      await waitForCondition(
        () => tradeCtx.getCalls('replaceOrder').length === 1,
        '首次 602013 改单未触发',
      );
      expect(tradeCtx.getCalls('orderDetail')).toHaveLength(0);

      await runtimeTimers.advanceBy(1_000);
      await waitForCondition(
        () => tradeCtx.getCalls('replaceOrder').length === 2,
        '第 2 次 602013 改单未触发',
      );
      expect(tradeCtx.getCalls('orderDetail')).toHaveLength(0);

      await runtimeTimers.advanceBy(2_000);
      await waitForCondition(
        () => tradeCtx.getCalls('replaceOrder').length === 3,
        '第 3 次 602013 改单未触发',
      );
      expect(tradeCtx.getCalls('orderDetail')).toHaveLength(0);

      await runtimeTimers.advanceBy(4_000);
      await waitForCondition(
        () => tradeCtx.getCalls('replaceOrder').length === 4,
        '第 4 次 602013 改单未触发',
      );
      expect(tradeCtx.getCalls('orderDetail')).toHaveLength(0);

      await runtimeTimers.advanceBy(8_000);
      await waitForCondition(
        () => tradeCtx.getCalls('replaceOrder').length === 5,
        '第 5 次 602013 改单未触发',
      );

      await waitForCondition(
        () => tradeCtx.getCalls('orderDetail').length === 1,
        '第 5 次 602013 后未升级到 orderDetail',
      );

      await runtimeTimers.advanceBy(60_000);
      expect(tradeCtx.getCalls('replaceOrder')).toHaveLength(5);
    } finally {
      runtimeTimers.restore();
    }
  });

  it('drops a stale fifth 602013 blocking decision after WS progress has reopened replace', async () => {
    const initialNowMs = Date.parse('2026-02-25T05:00:00.000Z');
    const runtimeTimers = createRuntimeTimerHarness(initialNowMs);
    const { deps, tradeCtx, emitQuoteUpdated } = createDeps({
      sellTimeoutSeconds: 999,
      buyTimeoutSeconds: 999,
      orderMonitorPriceUpdateIntervalSeconds: 1,
    });
    const stateCheckStarted = createDeferred();
    const releaseStateCheck = createDeferred();
    const originalOrderDetail = tradeCtx.orderDetail;
    tradeCtx.orderDetail = async (orderId) => {
      const staleSnapshot = await originalOrderDetail(orderId);
      stateCheckStarted.resolve();
      await releaseStateCheck.promise;
      return staleSnapshot;
    };

    tradeCtx.setFailureRule('replaceOrder', {
      failAtCalls: [1, 2, 3, 4, 5],
      maxFailures: 5,
      errorMessage: 'openapi error: code=602013: status does not allow amendment',
    });

    tradeCtx.seedTodayOrders([
      createPendingRecoveryOrder({
        orderId: 'SELL-REPLACE-602013-STALE-STATE-CHECK',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.New,
        quantity: 100,
        executedQuantity: 0,
        executedPrice: 0,
      }) as unknown as Order,
    ]);
    const monitor = createOrderMonitor(deps);

    try {
      await monitor.initialize();
      await monitor.recoverOrderTrackingFromSnapshot([]);
      monitor.startRuntime();
      monitor.trackOrder({
        orderId: 'SELL-REPLACE-602013-STALE-STATE-CHECK',
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
      await flushMicrotasks();

      await runtimeTimers.advanceBy(1_000);
      await emitQuoteUpdated({
        symbol: 'BULL.HK',
        quote: createQuoteDouble('BULL.HK', 1.05),
      });

      await waitForCondition(
        () => tradeCtx.getCalls('replaceOrder').length === 1,
        '首次 602013 改单未触发',
      );

      for (const [delayMs, expectedCalls] of [
        [1_000, 2],
        [2_000, 3],
        [4_000, 4],
        [8_000, 5],
      ] as const) {
        await runtimeTimers.advanceBy(delayMs);
        await waitForCondition(
          () => tradeCtx.getCalls('replaceOrder').length === expectedCalls,
          `第 ${expectedCalls} 次 602013 改单未触发`,
        );
      }

      await stateCheckStarted.promise;
      await emitOrderChanged(
        tradeCtx,
        createPushOrderChanged({
          orderId: 'SELL-REPLACE-602013-STALE-STATE-CHECK',
          symbol: 'BULL.HK',
          side: OrderSide.Sell,
          status: OrderStatus.New,
          orderType: OrderType.ELO,
          submittedPrice: 1,
          submittedQuantity: 100,
          executedPrice: 0,
          executedQuantity: 0,
          updatedAtMs: initialNowMs + 16_000,
        }),
      );

      await emitOrderChanged(
        tradeCtx,
        createPushOrderChanged({
          orderId: 'SELL-REPLACE-602013-STALE-STATE-CHECK',
          symbol: 'BULL.HK',
          side: OrderSide.Sell,
          status: OrderStatus.PendingReplace,
          orderType: OrderType.ELO,
          submittedPrice: 1,
          submittedQuantity: 100,
          executedPrice: 0,
          executedQuantity: 0,
          updatedAtMs: initialNowMs + 16_001,
        }),
      );

      await emitOrderChanged(
        tradeCtx,
        createPushOrderChanged({
          orderId: 'SELL-REPLACE-602013-STALE-STATE-CHECK',
          symbol: 'BULL.HK',
          side: OrderSide.Sell,
          status: OrderStatus.New,
          orderType: OrderType.ELO,
          submittedPrice: 1,
          submittedQuantity: 100,
          executedPrice: 0,
          executedQuantity: 0,
          updatedAtMs: initialNowMs + 16_002,
        }),
      );

      releaseStateCheck.resolve();
      await waitForCondition(
        () => tradeCtx.getCalls('replaceOrder').length === 6,
        'WS 已重开改单后，过期第 5 次 state-check 不应阻塞 route 自动第 6 次改单',
        100,
      );
      await flushMicrotasks();
      await flushMicrotasks();

      expect(tradeCtx.getCalls('orderDetail')).toHaveLength(1);
      expect(monitor.getPendingSellOrders('BULL.HK')).toMatchObject([
        {
          orderId: 'SELL-REPLACE-602013-STALE-STATE-CHECK',
          status: OrderStatus.New,
          submittedPrice: 1.05,
        },
      ]);
    } finally {
      await monitor.stopRuntimeAndDrain();
      runtimeTimers.restore();
    }
  });

  it('resets 602013 consecutive counter after ws status progression and re-escalates only after next 5 hits', async () => {
    const runtimeTimers = createRuntimeTimerHarness(Date.parse('2026-02-25T04:00:00.000Z'));

    const { deps, tradeCtx, emitQuoteUpdated } = createDeps({
      sellTimeoutSeconds: 999,
      buyTimeoutSeconds: 999,
    });
    tradeCtx.setFailureRule('replaceOrder', {
      failAtCalls: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      maxFailures: 10,
      errorMessage: 'openapi error: code=602013: status does not allow amendment',
    });

    tradeCtx.seedTodayOrders([
      createPendingRecoveryOrder({
        orderId: 'SELL-REPLACE-602013-RESET',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.PendingReplace,
        quantity: 100,
        executedQuantity: 0,
        executedPrice: 0,
      }) as unknown as Order,
    ]);

    const monitor = createOrderMonitor(deps);
    try {
      await monitor.initialize();
      await monitor.recoverOrderTrackingFromSnapshot([]);
      monitor.startRuntime();

      monitor.trackOrder({
        orderId: 'SELL-REPLACE-602013-RESET',
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
      await flushMicrotasks();
      await emitQuoteUpdated({
        symbol: 'BULL.HK',
        quote: createQuoteDouble('BULL.HK', 1.05),
      });

      await waitForCondition(
        () => tradeCtx.getCalls('replaceOrder').length === 1,
        '首次 602013 改单未触发',
      );

      await runtimeTimers.advanceBy(1_000);
      await waitForCondition(
        () => tradeCtx.getCalls('replaceOrder').length === 2,
        '第 2 次 602013 改单未触发',
      );
      await runtimeTimers.advanceBy(2_000);
      await waitForCondition(
        () => tradeCtx.getCalls('replaceOrder').length === 3,
        '第 3 次 602013 改单未触发',
      );
      await runtimeTimers.advanceBy(4_000);
      await waitForCondition(
        () => tradeCtx.getCalls('replaceOrder').length === 4,
        '第 4 次 602013 改单未触发',
      );
      await runtimeTimers.advanceBy(8_000);
      await waitForCondition(
        () => tradeCtx.getCalls('replaceOrder').length === 5,
        '第 5 次 602013 改单未触发',
      );

      await waitForCondition(
        () => tradeCtx.getCalls('orderDetail').length === 1,
        '第 5 次 602013 后未升级到 orderDetail',
      );
      await flushMicrotasks();
      await flushMicrotasks();
      await flushMicrotasks();

      await emitOrderChanged(
        tradeCtx,
        createPushOrderChanged({
          orderId: 'SELL-REPLACE-602013-RESET',
          symbol: 'BULL.HK',
          side: OrderSide.Sell,
          status: OrderStatus.PendingReplace,
          orderType: OrderType.ELO,
          submittedPrice: 1,
          submittedQuantity: 100,
          executedPrice: 0,
          executedQuantity: 0,
        }),
      );

      await emitOrderChanged(
        tradeCtx,
        createPushOrderChanged({
          orderId: 'SELL-REPLACE-602013-RESET',
          symbol: 'BULL.HK',
          side: OrderSide.Sell,
          status: OrderStatus.New,
          orderType: OrderType.ELO,
          submittedPrice: 1,
          submittedQuantity: 100,
          executedPrice: 0,
          executedQuantity: 0,
        }),
      );
      await flushMicrotasks();
      await emitQuoteUpdated({
        symbol: 'BULL.HK',
        quote: createQuoteDouble('BULL.HK', 1.06),
      });

      await waitForCondition(
        () => tradeCtx.getCalls('replaceOrder').length === 6,
        'WS 解锁后的首次 QUOTE 未重新触发改单',
        100,
      );

      expect(tradeCtx.getCalls('orderDetail')).toHaveLength(1);

      await runtimeTimers.advanceBy(1_000);
      await waitForCondition(
        () => tradeCtx.getCalls('replaceOrder').length === 7,
        '重置后第 2 次 602013 改单未触发',
        100,
      );
      await runtimeTimers.advanceBy(2_000);
      await waitForCondition(
        () => tradeCtx.getCalls('replaceOrder').length === 8,
        '重置后第 3 次 602013 改单未触发',
        100,
      );
      await runtimeTimers.advanceBy(4_000);
      await waitForCondition(
        () => tradeCtx.getCalls('replaceOrder').length === 9,
        '重置后第 4 次 602013 改单未触发',
        100,
      );
      await runtimeTimers.advanceBy(8_000);
      await waitForCondition(
        () => tradeCtx.getCalls('replaceOrder').length === 10,
        '重置后第 5 次 602013 改单未触发',
        100,
      );

      await waitForCondition(
        () => tradeCtx.getCalls('orderDetail').length === 2,
        '重置后第 5 次 602013 未再次升级到 orderDetail',
        100,
      );
    } finally {
      runtimeTimers.restore();
    }
  });

  it('public cancelOrder settles state-checked sell close and returns remaining related buy order ids', async () => {
    const pendingSellSnapshot = new Map<string, PendingSellInfo>();
    const buyOrders: ReadonlyArray<OrderRecord> = [
      {
        orderId: 'BUY-1',
        symbol: 'BULL.HK',
        executedPrice: 1,
        executedQuantity: 100,
        executedTime: Date.parse('2026-02-25T03:00:00.000Z'),
        submittedAt: new Date('2026-02-25T03:00:00.000Z'),
        updatedAt: new Date('2026-02-25T03:00:00.000Z'),
      },
      {
        orderId: 'BUY-2',
        symbol: 'BULL.HK',
        executedPrice: 1.2,
        executedQuantity: 100,
        executedTime: Date.parse('2026-02-25T03:05:00.000Z'),
        submittedAt: new Date('2026-02-25T03:05:00.000Z'),
        updatedAt: new Date('2026-02-25T03:05:00.000Z'),
      },
    ];
    const recordLocalSellCalls: Array<ReadonlyArray<string> | null> = [];
    const orderRecorder = createOrderRecorderDouble({
      submitSellOrder: (
        orderId: string,
        symbol: string,
        direction: 'LONG' | 'SHORT',
        quantity: number,
        relatedBuyOrderIds: readonly string[],
        submittedAtMs?: number,
      ) => {
        pendingSellSnapshot.set(orderId, {
          orderId,
          symbol,
          direction,
          submittedQuantity: quantity,
          filledQuantity: 0,
          relatedBuyOrderIds,
          status: 'pending',
          submittedAt: submittedAtMs ?? Date.now(),
        });
      },
      markSellCancelled: (orderId: string) => {
        const current = pendingSellSnapshot.get(orderId);
        if (!current) {
          return null;
        }

        pendingSellSnapshot.delete(orderId);
        return {
          ...current,
          status: 'cancelled' as const,
        };
      },
      getPendingSellSnapshot: () => [...pendingSellSnapshot.values()],
      getBuyOrdersForSymbol: () => buyOrders,
      recordLocalSell: (
        _symbol,
        _executedPrice,
        _executedQuantity,
        _isLongSymbol,
        _executedTimeMs,
        _orderId,
        relatedBuyOrderIds,
      ) => {
        recordLocalSellCalls.push(relatedBuyOrderIds ?? null);
      },
    });
    const refreshNeeds: Array<{
      readonly refreshAccount: boolean;
      readonly refreshPositions: boolean;
    }> = [];
    const { deps, tradeCtx } = createDeps({
      orderRecorderOverride: orderRecorder,
      onRecordSettlementRefreshNeed: (need) => {
        refreshNeeds.push(need);
      },
    });
    tradeCtx.setFailureRule('cancelOrder', {
      failAtCalls: [1],
      maxFailures: 1,
      errorMessage: 'openapi error: code=603001: Order not found',
    });

    tradeCtx.seedTodayOrders([
      createPendingRecoveryOrder({
        orderId: 'SELL-CANCEL-SETTLED',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.PartialWithdrawal,
        quantity: 200,
        executedQuantity: 100,
        executedPrice: 1.05,
        updatedAt: new Date('2026-02-25T03:11:00.000Z'),
      }) as unknown as Order,
    ]);

    const monitor = createOrderMonitor(deps);
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);

    orderRecorder.submitSellOrder('SELL-CANCEL-SETTLED', 'BULL.HK', 'LONG', 200, [
      'BUY-1',
      'BUY-2',
    ]);

    monitor.trackOrder({
      orderId: 'SELL-CANCEL-SETTLED',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      price: 1,
      initialSubmittedPrice: 1,
      quantity: 200,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: OrderType.ELO,
    });

    const outcome = await monitor.cancelOrder('SELL-CANCEL-SETTLED', { kind: 'ORDER_FACT' });

    expect(outcome.kind).toBe('ALREADY_CLOSED');
    if (outcome.kind === 'ALREADY_CLOSED') {
      expect(outcome.closedReason).toBe('CANCELED');
      expect(outcome.relatedBuyOrderIds).toEqual(['BUY-2']);
    }

    expect(recordLocalSellCalls).toEqual([['BUY-1']]);
    expect(tradeCtx.getCalls('orderDetail')).toHaveLength(1);
    expect(monitor.getPendingSellOrders('BULL.HK')).toHaveLength(0);
    expect(refreshNeeds).toEqual([
      {
        refreshAccount: true,
        refreshPositions: true,
      },
    ]);
  });

  it('public cancelOrder 不会让陈旧终态否认 tracked 已知成交', async () => {
    const localBuyCalls: Array<
      Readonly<{ executedPrice: number; executedQuantity: number; executedTimeMs: number }>
    > = [];
    const dailyLossCalls: Array<
      Readonly<{
        factStage: 'OPEN' | 'TERMINAL';
        executedQuantity: number;
        executedTimeMs: number;
        orderUpdatedAtMs: number;
      }>
    > = [];
    const orderStateEvents: OrderStateChangedEvent[] = [];
    const { deps, tradeCtx } = createDeps({
      orderRecorderOverride: createOrderRecorderDouble({
        recordLocalBuy: (_symbol, executedPrice, executedQuantity, _isLong, executedTimeMs) => {
          localBuyCalls.push({ executedPrice, executedQuantity, executedTimeMs });
        },
      }),
      dailyLossTrackerOverride: createDailyLossTrackerDouble({
        recordCumulativeExecution: (input) => {
          dailyLossCalls.push(input);
          return { authoritativeFactChanged: true, executionAdvanced: true };
        },
      }),
    });
    tradeCtx.setFailureRule('cancelOrder', {
      failAtCalls: [1],
      maxFailures: 1,
      errorMessage: 'openapi error: code=601011: Order already cancelled',
    });

    tradeCtx.seedTodayOrders([
      createPendingRecoveryOrder({
        orderId: 'BUY-PUBLIC-CANCEL-STALE-TERMINAL',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
        status: OrderStatus.PartialWithdrawal,
        quantity: 100,
        executedQuantity: 20,
        executedPrice: 0.9,
        updatedAt: new Date('2026-02-25T03:11:00.100Z'),
      }) as unknown as Order,
    ]);
    const monitor = createOrderMonitor(deps);
    monitor.onOrderStateChanged((event) => {
      orderStateEvents.push(event);
    });
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.trackOrder({
      orderId: 'BUY-PUBLIC-CANCEL-STALE-TERMINAL',
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

    await emitOrderChanged(
      tradeCtx,
      createPushOrderChanged({
        orderId: 'BUY-PUBLIC-CANCEL-STALE-TERMINAL',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
        status: OrderStatus.PartialFilled,
        executedQuantity: 50,
        executedPrice: 1.05,
        updatedAtMs: Date.parse('2026-02-25T03:11:00.200Z'),
      }),
    );

    const outcome = await monitor.cancelOrder('BUY-PUBLIC-CANCEL-STALE-TERMINAL', {
      kind: 'ORDER_FACT',
    });

    expect(outcome.kind).toBe('ALREADY_CLOSED');
    expect(localBuyCalls).toEqual([
      {
        executedPrice: 1.05,
        executedQuantity: 50,
        executedTimeMs: Date.parse('2026-02-25T03:11:00.200Z'),
      },
    ]);

    expect(dailyLossCalls).toMatchObject([
      {
        factStage: 'OPEN',
        executedQuantity: 50,
        executedTimeMs: Date.parse('2026-02-25T03:11:00.200Z'),
        orderUpdatedAtMs: Date.parse('2026-02-25T03:11:00.200Z'),
      },
      {
        factStage: 'TERMINAL',
        executedQuantity: 50,
        executedTimeMs: Date.parse('2026-02-25T03:11:00.200Z'),
        orderUpdatedAtMs: Date.parse('2026-02-25T03:11:00.200Z'),
      },
    ]);

    expect(orderStateEvents).toMatchObject([
      {
        orderId: 'BUY-PUBLIC-CANCEL-STALE-TERMINAL',
        status: 'CANCELED',
        executedPrice: 1.05,
        executedQuantity: 50,
        executedTimeMs: Date.parse('2026-02-25T03:11:00.200Z'),
      },
    ]);
  });

  it('public cancelOrder returns already-closed for untracked filled order (601012)', async () => {
    const { deps, tradeCtx } = createDeps();
    tradeCtx.setFailureRule('cancelOrder', {
      failAtCalls: [1],
      maxFailures: 1,
      errorMessage: 'openapi error: code=601012: Order has been filled',
    });

    tradeCtx.seedTodayOrders([
      createPendingRecoveryOrder({
        orderId: 'UNTRACKED-601012-FILLED',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.Filled,
        quantity: 100,
        executedQuantity: 100,
        executedPrice: 1.03,
      }) as unknown as Order,
    ]);

    const monitor = createOrderMonitor(deps);
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);

    const outcome = await monitor.cancelOrder('UNTRACKED-601012-FILLED', {
      kind: 'ORDER_FACT',
    });

    expect(outcome.kind).toBe('ALREADY_CLOSED');
    if (outcome.kind === 'ALREADY_CLOSED') {
      expect(outcome.closedReason).toBe('FILLED');
      expect(outcome.relatedBuyOrderIds).toBeNull();
    }

    expect(tradeCtx.getCalls('orderDetail')).toHaveLength(1);
  });

  it('keeps close sink in state-check path from refreshing all orders on 603001 and does not submit market sell', async () => {
    let fetchAllOrdersCalls = 0;
    const { deps, tradeCtx } = createDeps({
      sellTimeoutSeconds: 0,
      buyTimeoutSeconds: 999,
      orderRecorderOverride: createOrderRecorderDouble({
        fetchAllOrdersFromAPI: async () => {
          fetchAllOrdersCalls += 1;
          return [];
        },
      }),
    });
    tradeCtx.setFailureRule('cancelOrder', {
      failAtCalls: [1],
      maxFailures: 1,
      errorMessage: 'openapi error: code=603001: Order not found',
    });
    const runtimeTimers = createRuntimeTimerHarness(Date.parse('2026-02-25T05:00:00.000Z'));
    const monitor = createOrderMonitor(deps);
    try {
      await monitor.initialize();
      await monitor.recoverOrderTrackingFromSnapshot([]);
      monitor.startRuntime();

      monitor.trackOrder({
        orderId: 'SELL-NOT-FOUND-CLOSE-SYNC',
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
      await flushMicrotasks();

      expect(tradeCtx.getCalls('cancelOrder')).toHaveLength(1);
      expect(tradeCtx.getCalls('orderDetail')).toHaveLength(0);

      await runtimeTimers.advanceBy(2_000);

      expect(fetchAllOrdersCalls).toBe(0);
      expect(tradeCtx.getCalls('cancelOrder')).toHaveLength(1);
      expect(tradeCtx.getCalls('orderDetail')).toHaveLength(1);
      expect(tradeCtx.getCalls('submitOrder')).toHaveLength(0);
    } finally {
      runtimeTimers.restore();
    }
  });

  it('keeps close sink idempotent when duplicate filled events are received and emits one order state event', async () => {
    let localBuyCount = 0;
    const orderStateEvents: OrderStateChangedEvent[] = [];
    const { deps, tradeCtx } = createDeps({
      orderRecorderOverride: createOrderRecorderDouble({
        recordLocalBuy: () => {
          localBuyCount += 1;
        },
      }),
    });

    const monitor = createOrderMonitor(deps);
    monitor.onOrderStateChanged((event) => {
      orderStateEvents.push(event);
    });
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);

    monitor.trackOrder({
      orderId: 'BUY-DUP-FILLED',
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

    const filledEvent = createPushOrderChanged({
      orderId: 'BUY-DUP-FILLED',
      symbol: 'BULL.HK',
      side: OrderSide.Buy,
      status: OrderStatus.Filled,
      orderType: OrderType.ELO,
      submittedPrice: 1,
      submittedQuantity: 100,
      executedPrice: 1,
      executedQuantity: 100,
      updatedAtMs: Date.now(),
    });
    await emitOrderChanged(tradeCtx, filledEvent);
    await emitOrderChanged(tradeCtx, filledEvent);

    expect(localBuyCount).toBe(1);
    expect(orderStateEvents).toHaveLength(1);
    expect(orderStateEvents[0]).toMatchObject({
      orderId: 'BUY-DUP-FILLED',
      symbol: 'BULL.HK',
      side: 'BUY',
      source: 'WS',
      status: 'FILLED',
      monitorSymbol: 'HSI.HK',
      isLongSymbol: true,
      isProtectiveLiquidation: false,
      executedPrice: 1,
      executedQuantity: 100,
    });
    expect(typeof orderStateEvents[0]?.executedTimeMs).toBe('number');
  });

  it('records executed buy quantity when PartialWithdrawal closes remaining quantity', async () => {
    let localBuyCount = 0;
    const dailyLossFacts: DailyLossCumulativeExecutionInput[] = [];
    const refreshNeeds: Array<{
      readonly refreshAccount: boolean;
      readonly refreshPositions: boolean;
    }> = [];
    const terminalExecutionMs = Date.parse('2026-02-25T03:11:00.000Z');
    const duplicateTerminalRevisionMs = terminalExecutionMs + 1;
    const { deps, tradeCtx } = createDeps({
      orderRecorderOverride: createOrderRecorderDouble({
        recordLocalBuy: () => {
          localBuyCount += 1;
        },
      }),
      dailyLossTrackerOverride: {
        resetAll: () => {},
        prepareProtectionBoundary: (params) => ({ ...params, orderBaselines: [] }),
        commitProtectionBoundary: () => {},
        restoreExecutionSnapshot: () => {},
        restoreProtectionBoundary: () => {},
        recalculateFromAllOrders: () => {},
        recordCumulativeExecution: (input: DailyLossCumulativeExecutionInput) => {
          dailyLossFacts.push(input);
          return { authoritativeFactChanged: true, executionAdvanced: true };
        },
        getLossOffset: () => 0,
      },
      onRecordSettlementRefreshNeed: (need) => {
        refreshNeeds.push(need);
      },
    });
    const monitor = createOrderMonitor(deps);
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);

    monitor.trackOrder({
      orderId: 'BUY-PARTIAL-WITHDRAWAL',
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

    await emitOrderChanged(
      tradeCtx,
      createPushOrderChanged({
        orderId: 'BUY-PARTIAL-WITHDRAWAL',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
        status: OrderStatus.PartialWithdrawal,
        orderType: OrderType.ELO,
        submittedPrice: 1,
        submittedQuantity: 100,
        executedPrice: 1.01,
        executedQuantity: 20,
        updatedAtMs: terminalExecutionMs,
      }),
    );

    await emitOrderChanged(
      tradeCtx,
      createPushOrderChanged({
        orderId: 'BUY-PARTIAL-WITHDRAWAL',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
        status: OrderStatus.PartialWithdrawal,
        orderType: OrderType.ELO,
        submittedPrice: 1,
        submittedQuantity: 100,
        executedPrice: 1.01,
        executedQuantity: 20,
        updatedAtMs: duplicateTerminalRevisionMs,
      }),
    );

    expect(localBuyCount).toBe(1);
    expect(dailyLossFacts).toEqual([
      {
        factStage: 'TERMINAL',
        direction: 'LONG',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
        executedPrice: 1.01,
        executedQuantity: 20,
        executedTimeMs: terminalExecutionMs,
        orderUpdatedAtMs: terminalExecutionMs,
        orderId: 'BUY-PARTIAL-WITHDRAWAL',
      },
    ]);

    expect(refreshNeeds).toEqual([
      {
        refreshAccount: true,
        refreshPositions: true,
      },
    ]);
  });

  it('does not treat zero-price quote as ready for replace flow', async () => {
    const { deps, tradeCtx, setQuotes } = createDeps({
      sellTimeoutSeconds: 999,
      buyTimeoutSeconds: 999,
    });
    setQuotes(new Map([['BULL.HK', createQuoteDouble('BULL.HK', 0, 100)]]));

    const monitor = createOrderMonitor(deps);
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.startRuntime();

    monitor.trackOrder({
      orderId: 'BUY-ZERO-PRICE-QUOTE',
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
    await flushMicrotasks();

    expect(tradeCtx.getCalls('replaceOrder')).toHaveLength(0);
  });

  it('replaceOrderPriceWithPermit 确认保护性 SELL terminal 时立即经终态网关提交 progress 并结算', async () => {
    const localSellCalls: Array<
      Readonly<{ executedPrice: number; executedQuantity: number; executedTimeMs: number }>
    > = [];
    const dailyLossCalls: DailyLossCumulativeExecutionInput[] = [];
    const persistedOrderIds: string[] = [];
    const orderStateEvents: OrderStateChangedEvent[] = [];
    const terminalRevisionMs = Date.parse('2026-07-13T05:00:00.000Z');
    const { deps, tradeCtx } = createDeps({
      orderRecorderOverride: createOrderRecorderDouble({
        recordLocalSell: (
          _symbol,
          executedPrice,
          executedQuantity,
          _isLongSymbol,
          executedTimeMs,
        ) => {
          localSellCalls.push({ executedPrice, executedQuantity, executedTimeMs });
        },
      }),
      dailyLossTrackerOverride: createDailyLossTrackerDouble({
        recordCumulativeExecution: (input, beforeAuthoritativeFactCommit) => {
          dailyLossCalls.push(input);
          beforeAuthoritativeFactCommit?.({
            factStage: input.factStage,
            cumulativeQuantity: '40',
            cumulativeAmount: '40.8',
            lastExecutionTimeMs: terminalRevisionMs,
            orderRevisionMs: input.orderUpdatedAtMs,
          });
          return { authoritativeFactChanged: true, executionAdvanced: true };
        },
      }),
      persistProtectiveLiquidationExecutionProgress: (input) => {
        persistedOrderIds.push(input.orderId);
      },
    });

    tradeCtx.replaceOrder = async () => {
      throw new Error('openapi error: code=601011: order state changed');
    };

    tradeCtx.seedTodayOrders([
      createPendingRecoveryOrder({
        orderId: 'SELL-PUBLIC-REPLACE-TERMINAL-GATEWAY',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.PartialWithdrawal,
        quantity: 100,
        executedQuantity: 40,
        executedPrice: 1.02,
        updatedAt: new Date(terminalRevisionMs),
      }) as unknown as Order,
    ]);

    const monitor = createOrderMonitor(deps);
    monitor.onOrderStateChanged((event) => {
      orderStateEvents.push(event);
    });
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.trackOrder({
      orderId: 'SELL-PUBLIC-REPLACE-TERMINAL-GATEWAY',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      price: 1,
      initialSubmittedPrice: 1,
      quantity: 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: true,
      orderType: OrderType.ELO,
    });

    await monitor.replaceOrderPriceWithPermit(
      'SELL-PUBLIC-REPLACE-TERMINAL-GATEWAY',
      1.03,
      { kind: 'ORDER_FACT' },
      { invoke: (operation) => operation() },
    );

    expect(persistedOrderIds).toEqual(['SELL-PUBLIC-REPLACE-TERMINAL-GATEWAY']);
    expect(dailyLossCalls).toMatchObject([
      {
        factStage: 'TERMINAL',
        orderId: 'SELL-PUBLIC-REPLACE-TERMINAL-GATEWAY',
        side: OrderSide.Sell,
        executedPrice: 1.02,
        executedQuantity: 40,
        executedTimeMs: terminalRevisionMs,
        orderUpdatedAtMs: terminalRevisionMs,
      },
    ]);

    expect(localSellCalls).toEqual([
      {
        executedPrice: 1.02,
        executedQuantity: 40,
        executedTimeMs: terminalRevisionMs,
      },
    ]);

    expect(orderStateEvents).toMatchObject([
      {
        orderId: 'SELL-PUBLIC-REPLACE-TERMINAL-GATEWAY',
        source: 'STATE_CHECK',
        status: 'CANCELED',
        isProtectiveLiquidation: true,
        executedQuantity: 40,
      },
    ]);
    expect(monitor.getPendingSellOrders('BULL.HK')).toHaveLength(0);
  });
});
