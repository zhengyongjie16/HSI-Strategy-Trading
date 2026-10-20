import { createDiagnosticObserverDouble } from '../../../helpers/diagnostics.js';
import { scheduleBoundedOneShotAt } from '../../../../src/runtime/timer/index.js';
import { wrapExternalApiRequest } from '../../../../src/infrastructure/externalApi/index.js';
import { wait } from '../../../../src/infrastructure/time/index.js';
import {
  createLoggerDouble,
  createMarketDataClientDouble,
  createQuoteDouble,
  createSymbolRegistryDouble,
} from '../../../helpers/testDoubles.js';

/**
 * orderMonitor 业务测试
 *
 * 功能：
 * - 验证订单监控相关场景意图、边界条件与业务期望。
 */

import { describe, expect, it } from 'bun:test';
import { createTradingConfig } from '../../../../mock/factories/configFactory.js';
import { createTerminationRuntime } from '../../../../src/runtime/lifecycle/terminationRuntime.js';
import type { OrderMonitorDeps } from '../../../../src/application/orderTracking/types.js';
import type { QuoteUpdatedEvent } from '../../../../src/types/marketPorts.js';
import type { Quote } from '../../../../src/types/quote.js';
import type { DailyLossCumulativeExecutionInput } from '../../../../src/types/risk.js';
import type { OrderStateChangedEvent } from '../../../../src/types/orderTracking.js';
import type { OrderRecord } from '../../../../src/types/orderRecorder.js';
import type { RateLimiter, TradeMutationPermit } from '../../../../src/types/rateLimit.js';
import { isInContinuousHKSession } from '../../../../src/domain/tradingSession/index.js';

import { createBrokerIngressFixture } from '../../../integration/architectureRefactoringP1Native/trade/brokerIngressFixture.js';
import { createExecutionFixture } from '../recorder/executionFixture.js';

/**
 * 判断一次订单记录提交前后经济投影是否变化。
 * recorder 的提交回执已收敛为 void；这里用可观察经济记录（买单列表或卖单记录）的前后差异证明经济是否变化。
 */
function economicProjectionChanged(
  before: ReadonlyArray<OrderRecord | null>,
  after: ReadonlyArray<OrderRecord | null>,
): boolean {
  if (before.length !== after.length) return true;

  return after.some((record, index) => {
    const previous = before[index];
    if (previous === undefined || previous === null || record === null) return previous !== record;

    return (
      previous.orderId !== record.orderId ||
      previous.symbol !== record.symbol ||
      previous.costAmount !== record.costAmount ||
      previous.executedQuantity !== record.executedQuantity ||
      previous.executedTime !== record.executedTime
    );
  });
}

async function expectPromiseRejectsToMatch(
  operation: () => Promise<unknown>,
  expectedMessagePattern: RegExp,
): Promise<Error> {
  try {
    await operation();
  } catch (error: unknown) {
    if (!(error instanceof Error)) {
      throw new Error(`[测试] 预期 Promise 以 Error 拒绝，实际为: ${String(error)}`, {
        cause: error,
      });
    }

    expect(error.message).toMatch(expectedMessagePattern);
    return error;
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

type RuntimeTimerHarness = {
  readonly now: () => Date;
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
    now: () => new Date(nowMs),
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

type NativeDepsOptions = {
  readonly now?: OrderMonitorDeps['now'];
  readonly sellTimeoutSeconds?: number;
  readonly buyTimeoutSeconds?: number;
  readonly orderMonitorPriceUpdateIntervalSeconds?: number;
  readonly allowBuyOrderTrackingAboveInitialPrice?: boolean;
  readonly continuousTradingOpen?: () => boolean;
  readonly allocateRelatedBuyOrderIdsForRecovery?: () => readonly string[];
  readonly protectiveLiquidationEpisodeTrackerOverride?: OrderMonitorDeps['protectiveLiquidationEpisodeTracker'];
  readonly observeEpisode?: (
    owner: OrderMonitorDeps['protectiveLiquidationEpisodeTracker'],
  ) => OrderMonitorDeps['protectiveLiquidationEpisodeTracker'];
  readonly orderRecorderOverride?: OrderMonitorDeps['orderRecorder'];
  readonly observeRecorder?: (
    owner: OrderMonitorDeps['orderRecorder'],
  ) => OrderMonitorDeps['orderRecorder'];
  readonly observeDaily?: (
    owner: OrderMonitorDeps['dailyLossTracker'],
  ) => OrderMonitorDeps['dailyLossTracker'];
  readonly onRecordSettlementRefreshNeed?: (need: {
    readonly refreshAccount: boolean;
    readonly refreshPositions: boolean;
  }) => void;
  readonly onMutationPermitAcquired?: () => void;
  readonly rateLimiter?: RateLimiter;
  readonly persistProtectiveLiquidationExecutionProgress?: OrderMonitorDeps['persistProtectiveLiquidationExecutionProgress'];
  readonly termination?: OrderMonitorDeps['termination'];
  readonly terminationRuntime?: ReturnType<typeof createTerminationRuntime>;
};

/** Actual SDK actors and one O/Daily/H/S; automatic mutations are not implicitly authorized. */
async function createNativeDeps(
  params: NativeDepsOptions | undefined,
  input: Parameters<typeof createBrokerIngressFixture>[0],
) {
  const native = await createBrokerIngressFixture(input);
  const nativeRateLimiter =
    params?.rateLimiter ?? createRateLimiterDouble(params?.onMutationPermitAcquired);
  const economic = createExecutionFixture({
    ...(params?.terminationRuntime === undefined ? {} : { termination: params.terminationRuntime }),
    readPort: native.createAccountService({ rateLimiter: nativeRateLimiter }),
    ...(params?.onRecordSettlementRefreshNeed === undefined
      ? {}
      : { observeRefresh: params.onRecordSettlementRefreshNeed }),
    createRecorder: native.createRecorder,
    nowMs: (params?.now ?? (() => new Date()))().getTime(),
    ...(params?.observeRecorder === undefined ? {} : { observeRecorder: params.observeRecorder }),
    ...(params?.observeDaily === undefined ? {} : { observeDaily: params.observeDaily }),
    ...(params?.now === undefined ? {} : { nowMs: params.now().getTime() }),
    ...(params?.persistProtectiveLiquidationExecutionProgress === undefined
      ? {}
      : { persistProgress: params.persistProtectiveLiquidationExecutionProgress }),
  });
  let quotesMap = new Map<string, Quote | null>([
    ['BULL.HK', createQuoteDouble('BULL.HK', '1.02')],
  ]);
  const quoteUpdatedListeners: Array<(event: QuoteUpdatedEvent) => void> = [];
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
    (params?.allocateRelatedBuyOrderIdsForRecovery === undefined
      ? economic.recorder
      : {
          ...economic.recorder,
          allocateRelatedBuyOrderIdsForRecovery: params.allocateRelatedBuyOrderIdsForRecovery,
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

  const deps: Parameters<typeof native.createMonitor>[0] = {
    diagnostics: createDiagnosticObserverDouble(),
    logger: createLoggerDouble(),
    wait: wait,
    requestExternalApi: wrapExternalApiRequest,
    scheduleBoundedOneShotAt: scheduleBoundedOneShotAt,
    now: params?.now ?? (() => new Date()),
    scheduleTimer: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer: (handle) => {
      clearTimeout(handle);
    },
    rateLimiter: params?.rateLimiter ?? createRateLimiterDouble(params?.onMutationPermitAcquired),
    cacheManager: {
      clearCache: () => {},
      getPendingOrders: async () => {
        throw new Error('native monitor scenario did not configure pending-order IO');
      },
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
    dailyLossTracker: economic.daily,
    orderHoldRegistry: economic.holds,
    protectiveLiquidationEpisodeTracker:
      params?.protectiveLiquidationEpisodeTrackerOverride ??
      params?.observeEpisode?.(economic.episode) ??
      economic.episode,
    persistProtectiveLiquidationExecutionProgress:
      params?.persistProtectiveLiquidationExecutionProgress ??
      (() => {
        throw new Error('unconfigured protective durable persistence');
      }),
    postTradeConsistencyRuntime: economic.sink,
    tradingConfig,
    symbolRegistry,
    isContinuousTradingAllowed: params?.continuousTradingOpen ?? (() => false),
    termination: params?.termination ?? economic.termination,
  };

  return {
    deps,
    native,
    economic,
    setQuotes: (quotes: ReadonlyMap<string, Quote | null>) => {
      quotesMap = new Map(quotes);
    },
    emitQuoteUpdated: async (event: QuoteUpdatedEvent) => {
      for (const listener of quoteUpdatedListeners) {
        listener(event);
      }

      for (let index = 0; index < 30; index++) await flushMicrotasks();
    },
  };
}

async function executeReplaceScenario(params: {
  readonly initialPrice: string;
  readonly quotePrice: string;
  readonly processTimes?: number;
}): Promise<{
  readonly replaceCalls: number;
  readonly replaceSubmittedPrice: string | null;
}> {
  const now = Date.now();
  const frame = {
    orderId: 'SELL-PRICE-DIFF-CASE',
    symbol: 'BULL.HK',
    stockName: 'HSI RC',
    remark: '',
    side: 'SELL' as const,
    status: 'New' as const,
    orderType: 'ELO' as const,
    quantity: '100',
    executedQuantity: '0',
    submittedPrice: params.initialPrice,
    executedPrice: '0',
    submittedAtMs: now - 1,
    executionTimeMs: null,
    updatedAtMs: now,
  };
  const caller: { isCurrent?: () => boolean } = {};
  const { deps, native, economic, setQuotes, emitQuoteUpdated } = await createNativeDeps(
    {
      continuousTradingOpen: () => caller.isCurrent?.() ?? false,
      sellTimeoutSeconds: 999,
      buyTimeoutSeconds: 999,
    },
    frame,
  );
  native.setAccountBalance({
    currency: 'HKD',
    totalCash: '100000',
    netAssets: '100000',
    availableCash: '100000',
  });
  native.setStockPositions([]);
  const authority = await economic.snapshot.requestRefresh({
    source: 'MONITOR-NATIVE-PRICE-SCENARIO',
    dayEpoch: 1,
    refreshAccount: true,
    refreshPositions: true,
  }).result;
  if (authority.status !== 'COMMITTED')
    throw new Error('price scenario requires actual native paired receipt');

  const captured = authority.snapshotToken;
  caller.isCurrent = () =>
    economic.snapshot.isCurrent(captured, { account: true, positions: true, paired: true });
  setQuotes(new Map([['BULL.HK', createQuoteDouble('BULL.HK', params.initialPrice)]]));
  const monitor = native.createMonitor(deps);
  await monitor.initialize();
  await monitor.recoverOrderTrackingFromSnapshot([]);
  monitor.startRuntime();

  monitor.trackOrder({
    orderId: 'SELL-PRICE-DIFF-CASE',
    symbol: 'BULL.HK',
    side: native.queryObservation.executionSide,
    executionSide: native.queryObservation.executionSide,
    price: params.initialPrice,
    initialSubmittedPrice: params.initialPrice,
    quantity: 100,
    isLongSymbol: true,
    monitorSymbol: 'HSI.HK',
    isProtectiveLiquidation: false,
    orderType: native.queryObservation.orderType,
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

  for (let index = 0; index < 30; index++) await flushMicrotasks();

  await monitor.stopRuntimeAndDrain();

  const replaceMutations = native.nativeMutations().filter((m) => m.kind === 'REPLACE');
  return {
    replaceCalls: replaceMutations.length,
    replaceSubmittedPrice: replaceMutations.at(-1)?.price ?? null,
  };
}

describe('orderMonitor business flow', () => {
  it('rechecks signal authorization after mutation permit acquisition before cancel API', async () => {
    let authorized = true;
    const frame = {
      orderId: 'SIGNAL-CANCEL',
      symbol: 'BULL.HK',
      stockName: 'HSI RC',
      remark: '',
      side: 'SELL' as const,
      status: 'New' as const,
      orderType: 'ELO' as const,
      quantity: '100',
      executedQuantity: '0',
      submittedPrice: '1',
      executedPrice: '0',
      submittedAtMs: Date.parse('2026-02-25T03:00:00.000Z'),
      executionTimeMs: null,
      updatedAtMs: Date.parse('2026-02-25T03:00:10.000Z'),
    };
    const { deps, native } = await createNativeDeps(
      {
        onMutationPermitAcquired: () => {
          authorized = false;
        },
      },
      frame,
    );
    native.setCancelBeforeReply(async () => {});
    const monitor = native.createMonitor(deps);
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.trackOrder({
      orderId: 'SIGNAL-CANCEL',
      symbol: 'BULL.HK',
      side: native.queryObservation.executionSide,
      executionSide: native.queryObservation.executionSide,
      price: '1',
      initialSubmittedPrice: '1',
      quantity: 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: native.queryObservation.orderType,
    });

    await monitor.cancelOrder('SIGNAL-CANCEL', {
      kind: 'SIGNAL_AUTHORIZED',
      authorize: () => authorized,
    });

    expect(native.nativeReadCounts().cancel).toBe(0);
    expect(authorized).toBe(false);
  });

  it('keeps order-fact public cancel independent from signal authorization', async () => {
    const frame = {
      orderId: 'ORDER-FACT-CANCEL',
      symbol: 'BULL.HK',
      stockName: 'HSI RC',
      remark: '',
      side: 'SELL' as const,
      status: 'New' as const,
      orderType: 'ELO' as const,
      quantity: '100',
      executedQuantity: '0',
      submittedPrice: '1',
      executedPrice: '0',
      submittedAtMs: Date.parse('2026-02-25T03:00:00.000Z'),
      executionTimeMs: null,
      updatedAtMs: Date.parse('2026-02-25T03:00:10.000Z'),
    };
    const { deps, native } = await createNativeDeps({}, frame);
    native.setCancelBeforeReply(async () => {});
    const monitor = native.createMonitor(deps);
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);

    await monitor.cancelOrder('ORDER-FACT-CANCEL', { kind: 'ORDER_FACT' });

    expect(native.nativeReadCounts().cancel).toBe(1);
  });

  it('retries private topic subscription during initialization after a transient API failure', async () => {
    const frame = {
      orderId: 'BUY-SUBSCRIBE',
      symbol: 'BULL.HK',
      stockName: 'HSI RC',
      remark: '',
      side: 'BUY' as const,
      status: 'New' as const,
      orderType: 'ELO' as const,
      quantity: '100',
      executedQuantity: '0',
      submittedPrice: '1',
      executedPrice: '0',
      submittedAtMs: Date.parse('2026-02-25T03:00:00.000Z'),
      executionTimeMs: null,
      updatedAtMs: Date.parse('2026-02-25T03:00:00.000Z'),
    };
    const { deps, native } = await createNativeDeps(undefined, frame);
    const failure = new Error('network unavailable');
    let issued = 0;
    native.setSubscribeBehavior(async () => {
      if (++issued === 1) throw failure;
    });
    const monitor = native.createMonitor(deps);

    let error: unknown = null;
    try {
      await monitor.initialize();
    } catch (err) {
      error = err;
    }

    expect(native.subscribeReadCount()).toBe(2);
    expect(error).toBeNull();
    expect(native.subscribeObservations()).toEqual([['PRIVATE'], ['PRIVATE']]);
  });

  it('replaces order when price diff equals threshold on downward move', async () => {
    const result = await executeReplaceScenario({
      initialPrice: '0.059',
      quotePrice: '0.058',
    });

    expect(result.replaceCalls).toBe(1);
    expect(Object.is(result.replaceSubmittedPrice, '0.058')).toBeTrue();
  });

  it('replaces order when price diff equals threshold on upward move', async () => {
    const result = await executeReplaceScenario({
      initialPrice: '0.058',
      quotePrice: '0.059',
    });

    expect(result.replaceCalls).toBe(1);
    expect(Object.is(result.replaceSubmittedPrice, '0.059')).toBeTrue();
  });

  it('does not replace order when price diff is lower than threshold', async () => {
    const result = await executeReplaceScenario({
      initialPrice: '0.059',
      quotePrice: '0.0581',
    });

    expect(result.replaceCalls).toBe(0);
    expect(result.replaceSubmittedPrice).toBeNull();
  });

  it('replaces order when price diff is greater than threshold', async () => {
    const result = await executeReplaceScenario({
      initialPrice: '0.059',
      quotePrice: '0.057',
    });

    expect(result.replaceCalls).toBe(1);
    expect(Object.is(result.replaceSubmittedPrice, '0.057')).toBeTrue();
  });

  it('does not repeatedly replace when quote price does not change', async () => {
    const result = await executeReplaceScenario({
      initialPrice: '0.058',
      quotePrice: '0.058',
      processTimes: 2,
    });

    expect(result.replaceCalls).toBe(0);
    expect(result.replaceSubmittedPrice).toBeNull();
  });

  it('normalizes replace price sent to broker', async () => {
    const result = await executeReplaceScenario({
      initialPrice: '0.059',
      quotePrice: '0.05800000000000000',
    });

    expect(result.replaceCalls).toBe(1);
    expect(Object.is(result.replaceSubmittedPrice, '0.058')).toBeTrue();
  });

  it('allows buy order tracking above initial price when config is enabled', async () => {
    const frame = {
      orderId: 'BUY-CHASE-ALLOW-UP',
      symbol: 'BULL.HK',
      stockName: 'HSI RC',
      remark: '',
      side: 'BUY' as const,
      status: 'New' as const,
      orderType: 'ELO' as const,
      quantity: '100',
      executedQuantity: '0',
      submittedPrice: '0.5',
      executedPrice: '0',
      submittedAtMs: Date.now() - 1,
      executionTimeMs: null,
      updatedAtMs: Date.now(),
    };
    const caller: { isCurrent?: () => boolean } = {};
    const { deps, native, economic, setQuotes, emitQuoteUpdated } = await createNativeDeps(
      {
        continuousTradingOpen: () => caller.isCurrent?.() ?? false,
        sellTimeoutSeconds: 999,
        buyTimeoutSeconds: 999,
        allowBuyOrderTrackingAboveInitialPrice: true,
      },
      frame,
    );
    native.setAccountBalance({
      currency: 'HKD',
      totalCash: '100000',
      netAssets: '100000',
      availableCash: '100000',
    });
    native.setStockPositions([]);
    const authority = await economic.snapshot.requestRefresh({
      source: 'MONITOR-NATIVE-CHASE',
      dayEpoch: 1,
      refreshAccount: true,
      refreshPositions: true,
    }).result;
    if (authority.status !== 'COMMITTED') throw new Error('chase requires actual paired receipt');

    const captured = authority.snapshotToken;
    caller.isCurrent = () =>
      economic.snapshot.isCurrent(captured, { account: true, positions: true, paired: true });
    setQuotes(new Map([['BULL.HK', createQuoteDouble('BULL.HK', '0.5')]]));
    const monitor = native.createMonitor(deps);
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.startRuntime();

    monitor.trackOrder({
      orderId: 'BUY-CHASE-ALLOW-UP',
      symbol: 'BULL.HK',
      side: native.queryObservation.executionSide,
      executionSide: native.queryObservation.executionSide,
      price: '0.5',
      initialSubmittedPrice: '0.5',
      quantity: 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: native.queryObservation.orderType,
    });
    await flushMicrotasks();

    setQuotes(new Map([['BULL.HK', createQuoteDouble('BULL.HK', '0.51')]]));
    await emitQuoteUpdated({
      symbol: 'BULL.HK',
      quote: createQuoteDouble('BULL.HK', '0.51'),
    });

    await monitor.stopRuntimeAndDrain();
    expect(native.nativeMutations().filter((m) => m.kind === 'REPLACE')).toHaveLength(1);
    expect(
      native
        .nativeMutations()
        .filter((m) => m.kind === 'REPLACE')
        .map((m) => m.price),
    ).toEqual(['0.51']);
  });

  it('allows buy order tracking downward when config disables chasing above initial price', async () => {
    const frame = {
      orderId: 'BUY-CHASE-ALLOW-DOWN',
      symbol: 'BULL.HK',
      stockName: 'HSI RC',
      remark: '',
      side: 'BUY' as const,
      status: 'New' as const,
      orderType: 'ELO' as const,
      quantity: '100',
      executedQuantity: '0',
      submittedPrice: '0.5',
      executedPrice: '0',
      submittedAtMs: Date.now() - 1,
      executionTimeMs: null,
      updatedAtMs: Date.now(),
    };
    const caller: { isCurrent?: () => boolean } = {};
    const { deps, native, economic, setQuotes, emitQuoteUpdated } = await createNativeDeps(
      {
        continuousTradingOpen: () => caller.isCurrent?.() ?? false,
        sellTimeoutSeconds: 999,
        buyTimeoutSeconds: 999,
        allowBuyOrderTrackingAboveInitialPrice: false,
      },
      frame,
    );
    native.setAccountBalance({
      currency: 'HKD',
      totalCash: '100000',
      netAssets: '100000',
      availableCash: '100000',
    });
    native.setStockPositions([]);
    const authority = await economic.snapshot.requestRefresh({
      source: 'MONITOR-NATIVE-CHASE',
      dayEpoch: 1,
      refreshAccount: true,
      refreshPositions: true,
    }).result;
    if (authority.status !== 'COMMITTED') throw new Error('chase requires actual paired receipt');

    const captured = authority.snapshotToken;
    caller.isCurrent = () =>
      economic.snapshot.isCurrent(captured, { account: true, positions: true, paired: true });
    setQuotes(new Map([['BULL.HK', createQuoteDouble('BULL.HK', '0.5')]]));
    const monitor = native.createMonitor(deps);
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.startRuntime();

    monitor.trackOrder({
      orderId: 'BUY-CHASE-ALLOW-DOWN',
      symbol: 'BULL.HK',
      side: native.queryObservation.executionSide,
      executionSide: native.queryObservation.executionSide,
      price: '0.5',
      initialSubmittedPrice: '0.5',
      quantity: 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: native.queryObservation.orderType,
    });
    await flushMicrotasks();

    setQuotes(new Map([['BULL.HK', createQuoteDouble('BULL.HK', '0.49')]]));
    await emitQuoteUpdated({
      symbol: 'BULL.HK',
      quote: createQuoteDouble('BULL.HK', '0.49'),
    });

    await monitor.stopRuntimeAndDrain();
    expect(native.nativeMutations().filter((m) => m.kind === 'REPLACE')).toHaveLength(1);
    expect(
      native
        .nativeMutations()
        .filter((m) => m.kind === 'REPLACE')
        .map((m) => m.price),
    ).toEqual(['0.49']);
  });

  it('blocks buy order tracking above initial price when config disables chasing above initial price', async () => {
    const frame = {
      orderId: 'BUY-CHASE-BLOCK-UP',
      symbol: 'BULL.HK',
      stockName: 'HSI RC',
      remark: '',
      side: 'BUY' as const,
      status: 'New' as const,
      orderType: 'ELO' as const,
      quantity: '100',
      executedQuantity: '0',
      submittedPrice: '0.5',
      executedPrice: '0',
      submittedAtMs: Date.now() - 1,
      executionTimeMs: null,
      updatedAtMs: Date.now(),
    };
    const caller: { isCurrent?: () => boolean } = {};
    const { deps, native, economic, setQuotes, emitQuoteUpdated } = await createNativeDeps(
      {
        continuousTradingOpen: () => caller.isCurrent?.() ?? false,
        sellTimeoutSeconds: 999,
        buyTimeoutSeconds: 999,
        allowBuyOrderTrackingAboveInitialPrice: false,
      },
      frame,
    );
    native.setAccountBalance({
      currency: 'HKD',
      totalCash: '100000',
      netAssets: '100000',
      availableCash: '100000',
    });
    native.setStockPositions([]);
    const authority = await economic.snapshot.requestRefresh({
      source: 'MONITOR-NATIVE-CHASE',
      dayEpoch: 1,
      refreshAccount: true,
      refreshPositions: true,
    }).result;
    if (authority.status !== 'COMMITTED') throw new Error('chase requires actual paired receipt');

    const captured = authority.snapshotToken;
    caller.isCurrent = () =>
      economic.snapshot.isCurrent(captured, { account: true, positions: true, paired: true });
    setQuotes(new Map([['BULL.HK', createQuoteDouble('BULL.HK', '0.5')]]));
    const monitor = native.createMonitor(deps);
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.startRuntime();

    monitor.trackOrder({
      orderId: 'BUY-CHASE-BLOCK-UP',
      symbol: 'BULL.HK',
      side: native.queryObservation.executionSide,
      executionSide: native.queryObservation.executionSide,
      price: '0.5',
      initialSubmittedPrice: '0.5',
      quantity: 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: native.queryObservation.orderType,
    });
    await flushMicrotasks();

    await emitQuoteUpdated({
      symbol: 'BULL.HK',
      quote: createQuoteDouble('BULL.HK', '0.51'),
    });

    await monitor.stopRuntimeAndDrain();
    expect(native.nativeMutations().filter((m) => m.kind === 'REPLACE')).toHaveLength(0);
  });

  it('allows buy order to return to initial price after lowering when config disables chasing above initial price', async () => {
    const frame = {
      orderId: 'BUY-CHASE-BACK-TO-INITIAL',
      symbol: 'BULL.HK',
      stockName: 'HSI RC',
      remark: '',
      side: 'BUY' as const,
      status: 'New' as const,
      orderType: 'ELO' as const,
      quantity: '100',
      executedQuantity: '0',
      submittedPrice: '0.5',
      executedPrice: '0',
      submittedAtMs: Date.now() - 1,
      executionTimeMs: null,
      updatedAtMs: Date.now(),
    };
    const caller: { isCurrent?: () => boolean } = {};
    const { deps, native, economic, setQuotes, emitQuoteUpdated } = await createNativeDeps(
      {
        continuousTradingOpen: () => caller.isCurrent?.() ?? false,
        sellTimeoutSeconds: 999,
        buyTimeoutSeconds: 999,
        allowBuyOrderTrackingAboveInitialPrice: false,
      },
      frame,
    );
    native.setAccountBalance({
      currency: 'HKD',
      totalCash: '100000',
      netAssets: '100000',
      availableCash: '100000',
    });
    native.setStockPositions([]);
    const authority = await economic.snapshot.requestRefresh({
      source: 'MONITOR-NATIVE-CHASE',
      dayEpoch: 1,
      refreshAccount: true,
      refreshPositions: true,
    }).result;
    if (authority.status !== 'COMMITTED') throw new Error('chase requires actual paired receipt');

    const captured = authority.snapshotToken;
    caller.isCurrent = () =>
      economic.snapshot.isCurrent(captured, { account: true, positions: true, paired: true });
    setQuotes(new Map([['BULL.HK', createQuoteDouble('BULL.HK', '0.5')]]));
    const monitor = native.createMonitor(deps);
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.startRuntime();

    monitor.trackOrder({
      orderId: 'BUY-CHASE-BACK-TO-INITIAL',
      symbol: 'BULL.HK',
      side: native.queryObservation.executionSide,
      executionSide: native.queryObservation.executionSide,
      price: '0.5',
      initialSubmittedPrice: '0.5',
      quantity: 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: native.queryObservation.orderType,
    });
    await flushMicrotasks();

    setQuotes(new Map([['BULL.HK', createQuoteDouble('BULL.HK', '0.49')]]));
    await emitQuoteUpdated({
      symbol: 'BULL.HK',
      quote: createQuoteDouble('BULL.HK', '0.49'),
    });

    setQuotes(new Map([['BULL.HK', createQuoteDouble('BULL.HK', '0.5')]]));
    await emitQuoteUpdated({
      symbol: 'BULL.HK',
      quote: createQuoteDouble('BULL.HK', '0.5'),
    });

    await monitor.stopRuntimeAndDrain();
    expect(native.nativeMutations().filter((m) => m.kind === 'REPLACE')).toHaveLength(2);
    expect(
      native
        .nativeMutations()
        .filter((m) => m.kind === 'REPLACE')
        .map((m) => m.price),
    ).toEqual(['0.49', '0.5']);
  });

  it('keeps sell replace behavior unchanged when config disables buy chasing above initial price', async () => {
    const frame = {
      orderId: 'SELL-CHASE-UNTOUCHED',
      symbol: 'BULL.HK',
      stockName: 'HSI RC',
      remark: '',
      side: 'SELL' as const,
      status: 'New' as const,
      orderType: 'ELO' as const,
      quantity: '100',
      executedQuantity: '0',
      submittedPrice: '0.5',
      executedPrice: '0',
      submittedAtMs: Date.now() - 1,
      executionTimeMs: null,
      updatedAtMs: Date.now(),
    };
    const caller: { isCurrent?: () => boolean } = {};
    const { deps, native, economic, setQuotes, emitQuoteUpdated } = await createNativeDeps(
      {
        continuousTradingOpen: () => caller.isCurrent?.() ?? false,
        sellTimeoutSeconds: 999,
        buyTimeoutSeconds: 999,
        allowBuyOrderTrackingAboveInitialPrice: false,
      },
      frame,
    );
    native.setAccountBalance({
      currency: 'HKD',
      totalCash: '100000',
      netAssets: '100000',
      availableCash: '100000',
    });
    native.setStockPositions([]);
    const authority = await economic.snapshot.requestRefresh({
      source: 'MONITOR-NATIVE-CHASE',
      dayEpoch: 1,
      refreshAccount: true,
      refreshPositions: true,
    }).result;
    if (authority.status !== 'COMMITTED') throw new Error('chase requires actual paired receipt');

    const captured = authority.snapshotToken;
    caller.isCurrent = () =>
      economic.snapshot.isCurrent(captured, { account: true, positions: true, paired: true });
    setQuotes(new Map([['BULL.HK', createQuoteDouble('BULL.HK', '0.5')]]));
    const monitor = native.createMonitor(deps);
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.startRuntime();

    monitor.trackOrder({
      orderId: 'SELL-CHASE-UNTOUCHED',
      symbol: 'BULL.HK',
      side: native.queryObservation.executionSide,
      executionSide: native.queryObservation.executionSide,
      price: '0.5',
      initialSubmittedPrice: '0.5',
      quantity: 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: native.queryObservation.orderType,
    });
    await flushMicrotasks();

    setQuotes(new Map([['BULL.HK', createQuoteDouble('BULL.HK', '0.51')]]));
    await emitQuoteUpdated({
      symbol: 'BULL.HK',
      quote: createQuoteDouble('BULL.HK', '0.51'),
    });

    await monitor.stopRuntimeAndDrain();
    expect(native.nativeMutations().filter((m) => m.kind === 'REPLACE')).toHaveLength(1);
    expect(
      native
        .nativeMutations()
        .filter((m) => m.kind === 'REPLACE')
        .map((m) => m.price),
    ).toEqual(['0.51']);
  });

  it('uses restored pending buy price as initial submitted price baseline after recovery', async () => {
    const now = Date.now();
    const frame = {
      orderId: 'BUY-RECOVERY-INITIAL-BASELINE',
      symbol: 'BULL.HK',
      stockName: 'HSI RC RECOVER',
      remark: '',
      side: 'BUY' as const,
      status: 'New' as const,
      orderType: 'ELO' as const,
      quantity: '100',
      executedQuantity: '0',
      submittedPrice: '0.49',
      executedPrice: '0',
      submittedAtMs: now,
      executionTimeMs: null,
      updatedAtMs: now + 1,
    };
    const caller: { isCurrent?: () => boolean } = {};
    const { deps, native, economic, setQuotes, emitQuoteUpdated } = await createNativeDeps(
      {
        continuousTradingOpen: () => caller.isCurrent?.() ?? false,
        sellTimeoutSeconds: 999,
        buyTimeoutSeconds: 999,
        allowBuyOrderTrackingAboveInitialPrice: false,
      },
      frame,
    );
    native.setAccountBalance({
      currency: 'HKD',
      totalCash: '100000',
      netAssets: '100000',
      availableCash: '100000',
    });
    native.setStockPositions([]);
    const authority = await economic.snapshot.requestRefresh({
      source: 'MONITOR-NATIVE-RECOVERY-BASELINE',
      dayEpoch: 1,
      refreshAccount: true,
      refreshPositions: true,
    }).result;
    if (authority.status !== 'COMMITTED')
      throw new Error('recovery baseline requires actual paired receipt');

    const captured = authority.snapshotToken;
    caller.isCurrent = () =>
      economic.snapshot.isCurrent(captured, { account: true, positions: true, paired: true });
    setQuotes(new Map([['BULL.HK', createQuoteDouble('BULL.HK', '0.49')]]));
    const monitor = native.createMonitor(deps);
    await monitor.initialize();
    monitor.startRuntime();

    await monitor.recoverOrderTrackingFromSnapshot([native.queryObservation]);
    await flushMicrotasks();

    setQuotes(new Map([['BULL.HK', createQuoteDouble('BULL.HK', '0.5')]]));
    await emitQuoteUpdated({
      symbol: 'BULL.HK',
      quote: createQuoteDouble('BULL.HK', '0.5'),
    });
    expect(native.nativeMutations().filter((m) => m.kind === 'REPLACE')).toHaveLength(0);

    setQuotes(new Map([['BULL.HK', createQuoteDouble('BULL.HK', '0.48')]]));
    await emitQuoteUpdated({
      symbol: 'BULL.HK',
      quote: createQuoteDouble('BULL.HK', '0.48'),
    });
    expect(native.nativeMutations().filter((m) => m.kind === 'REPLACE')).toHaveLength(1);
    expect(
      native
        .nativeMutations()
        .filter((m) => m.kind === 'REPLACE')
        .map((m) => m.price),
    ).toEqual(['0.48']);
    await monitor.stopRuntimeAndDrain();
  });

  it('waits for WS after timed-out sell cancel request success and does not convert immediately', async () => {
    const frame = {
      orderId: 'SELL-001',
      symbol: 'BULL.HK',
      stockName: 'HSI RC',
      remark: '',
      side: 'SELL' as const,
      status: 'New' as const,
      orderType: 'ELO' as const,
      quantity: '100',
      executedQuantity: '0',
      submittedPrice: '1',
      executedPrice: '0',
      submittedAtMs: Date.parse('2026-02-25T03:00:00.000Z'),
      executionTimeMs: null,
      updatedAtMs: Date.parse('2026-02-25T03:00:10.000Z'),
    };
    const { deps, native } = await createNativeDeps(
      { now: () => new Date('2026-02-25T03:10:00.000Z'), sellTimeoutSeconds: 0 },
      frame,
    );
    native.setCancelBeforeReply(async () => {});
    const monitor = native.createMonitor(deps);

    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.startRuntime();
    expect(native.subscribeObservations()[0]).toContain('PRIVATE');

    monitor.trackOrder({
      orderId: 'SELL-001',
      symbol: 'BULL.HK',
      side: native.queryObservation.executionSide,
      executionSide: native.queryObservation.executionSide,
      price: '1',
      initialSubmittedPrice: '1',
      quantity: 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: native.queryObservation.orderType,
    });

    await waitForCondition(
      () => native.nativeReadCounts().cancel === 1,
      '[测试] 预期超时卖单先发起撤单，但 cancelOrder 未发生',
    );

    expect(native.nativeReadCounts().cancel).toBe(1);
    expect(native.nativeSubmitObservations()).toHaveLength(0);
    expect(native.nativeReadCounts().detail).toBe(0);
    expect(monitor.getPendingSellOrders('BULL.HK')).toHaveLength(1);
    expect(monitor.getPendingSellOrders('BULL.HK')[0]?.orderType).toBe('ELO');
    await monitor.stopRuntimeAndDrain();
  });

  const assertTimedOutSellCancelIsNotRetried = async (
    cancelStatus: 'PendingCancel' | 'WaitToCancel',
  ): Promise<void> => {
    const orderId = `SELL-TIMEOUT-${cancelStatus === 'PendingCancel' ? 'PENDING-CANCEL' : 'WAIT-TO-CANCEL'}`;
    const frame = {
      orderId,
      symbol: 'BULL.HK',
      stockName: 'HSI RC',
      remark: '',
      side: 'SELL' as const,
      status: cancelStatus,
      orderType: 'ELO' as const,
      quantity: '100',
      executedQuantity: '0',
      submittedPrice: '1',
      executedPrice: '0',
      submittedAtMs: Date.now() - 1,
      executionTimeMs: null,
      updatedAtMs: Date.now(),
    };
    const caller: { isCurrent?: () => boolean } = {};
    const { deps, native, economic } = await createNativeDeps(
      {
        continuousTradingOpen: () => caller.isCurrent?.() ?? false,

        sellTimeoutSeconds: 0,
      },
      frame,
    );
    native.setCancelBeforeReply(async () => {});
    native.setAccountBalance({
      currency: 'HKD',
      totalCash: '100000',
      netAssets: '100000',
      availableCash: '100000',
    });
    native.setStockPositions([]);
    const receipt = await economic.snapshot.requestRefresh({
      source: 'NATIVE-PENDING-CANCEL',
      dayEpoch: 1,
      refreshAccount: true,
      refreshPositions: true,
    }).result;
    if (receipt.status !== 'COMMITTED')
      throw new Error('pending cancel requires actual paired receipt');

    const captured = receipt.snapshotToken;
    caller.isCurrent = () =>
      economic.snapshot.isCurrent(captured, { account: true, positions: true, paired: true });
    const monitor = native.createMonitor(deps);
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.startRuntime();
    monitor.trackOrder({
      orderId,
      symbol: 'BULL.HK',
      side: native.queryObservation.executionSide,
      executionSide: native.queryObservation.executionSide,
      price: '1',
      initialSubmittedPrice: '1',
      quantity: 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: native.queryObservation.orderType,
    });

    await waitForCondition(
      () => native.nativeReadCounts().cancel === 1,
      'original timeout cancel native call not issued',
      80,
    );
    expect(native.nativeReadCounts().cancel).toBe(1);
    await (async () => {
      native.emitOrderChangedFrame(frame);
      for (let i = 0; i < 40; i++) await flushMicrotasks();
    })();

    await waitForCondition(
      () => native.nativeReadCounts().cancel === 1,
      'original timeout cancel native call not issued',
      80,
    );
    expect(native.nativeReadCounts().cancel).toBe(1);
    expect(native.nativeSubmitObservations()).toHaveLength(0);
    expect(native.nativeReadCounts().detail).toBe(0);
    await monitor.stopRuntimeAndDrain();
    expect(economic.recorder.getExecutionFact(frame.orderId)).toBeNull();
  };

  const assertTimedOutBuyCancelIsNotRetried = async (
    cancelStatus: 'PendingCancel' | 'WaitToCancel',
  ): Promise<void> => {
    const orderId = `BUY-TIMEOUT-${cancelStatus === 'PendingCancel' ? 'PENDING-CANCEL' : 'WAIT-TO-CANCEL'}`;
    const frame = {
      orderId,
      symbol: 'BULL.HK',
      stockName: 'HSI RC',
      remark: '',
      side: 'BUY' as const,
      status: cancelStatus,
      orderType: 'ELO' as const,
      quantity: '100',
      executedQuantity: '0',
      submittedPrice: '1',
      executedPrice: '0',
      submittedAtMs: Date.now() - 1,
      executionTimeMs: null,
      updatedAtMs: Date.now(),
    };
    const caller: { isCurrent?: () => boolean } = {};
    const { deps, native, economic } = await createNativeDeps(
      {
        continuousTradingOpen: () => caller.isCurrent?.() ?? false,

        buyTimeoutSeconds: 0,
        sellTimeoutSeconds: 999,
      },
      frame,
    );
    native.setCancelBeforeReply(async () => {});
    native.setAccountBalance({
      currency: 'HKD',
      totalCash: '100000',
      netAssets: '100000',
      availableCash: '100000',
    });
    native.setStockPositions([]);
    const receipt = await economic.snapshot.requestRefresh({
      source: 'NATIVE-PENDING-CANCEL',
      dayEpoch: 1,
      refreshAccount: true,
      refreshPositions: true,
    }).result;
    if (receipt.status !== 'COMMITTED')
      throw new Error('pending cancel requires actual paired receipt');

    const captured = receipt.snapshotToken;
    caller.isCurrent = () =>
      economic.snapshot.isCurrent(captured, { account: true, positions: true, paired: true });
    const monitor = native.createMonitor(deps);
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.startRuntime();
    monitor.trackOrder({
      orderId,
      symbol: 'BULL.HK',
      side: native.queryObservation.executionSide,
      executionSide: native.queryObservation.executionSide,
      price: '1',
      initialSubmittedPrice: '1',
      quantity: 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: native.queryObservation.orderType,
    });

    await waitForCondition(
      () => native.nativeReadCounts().cancel === 1,
      'original timeout cancel native call not issued',
      80,
    );
    expect(native.nativeReadCounts().cancel).toBe(1);
    await (async () => {
      native.emitOrderChangedFrame(frame);
      for (let i = 0; i < 40; i++) await flushMicrotasks();
    })();

    await waitForCondition(
      () => native.nativeReadCounts().cancel === 1,
      'original timeout cancel native call not issued',
      80,
    );
    expect(native.nativeReadCounts().cancel).toBe(1);
    expect(native.nativeReadCounts().detail).toBe(0);
    await monitor.stopRuntimeAndDrain();
    expect(economic.recorder.getExecutionFact(frame.orderId)).toBeNull();
  };

  it('does not retry cancel when timed-out sell receives PendingCancel after cancel request success', async () =>
    assertTimedOutSellCancelIsNotRetried('PendingCancel'));

  it('does not retry cancel when timed-out buy receives PendingCancel after cancel request success', async () =>
    assertTimedOutBuyCancelIsNotRetried('PendingCancel'));

  it('does not retry cancel when timed-out sell receives WaitToCancel after cancel request success', async () =>
    assertTimedOutSellCancelIsNotRetried('WaitToCancel'));

  it('does not retry cancel when timed-out buy receives WaitToCancel after cancel request success', async () =>
    assertTimedOutBuyCancelIsNotRetried('WaitToCancel'));

  it('keeps protective sell tracked and does not submit market order before WS confirmation', async () => {
    const frame = {
      orderId: 'SELL-PROTECTIVE-TIMEOUT',
      symbol: 'BULL.HK',
      stockName: 'HSI RC',
      remark: '',
      side: 'SELL' as const,
      status: 'New' as const,
      orderType: 'ELO' as const,
      quantity: '100',
      executedQuantity: '0',
      submittedPrice: '1',
      executedPrice: '0',
      submittedAtMs: Date.parse('2026-02-25T03:00:00.000Z'),
      executionTimeMs: null,
      updatedAtMs: Date.parse('2026-02-25T03:00:10.000Z'),
    };
    const { deps, native } = await createNativeDeps(
      { now: () => new Date('2026-02-25T03:10:00.000Z'), sellTimeoutSeconds: 0 },
      frame,
    );
    native.setCancelBeforeReply(async () => {});
    const monitor = native.createMonitor(deps);
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.startRuntime();

    monitor.trackOrder({
      orderId: 'SELL-PROTECTIVE-TIMEOUT',
      symbol: 'BULL.HK',
      side: native.queryObservation.executionSide,
      executionSide: native.queryObservation.executionSide,
      price: '1',
      initialSubmittedPrice: '1',
      quantity: 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: true,
      orderType: native.queryObservation.orderType,
    });
    await flushMicrotasks();

    expect(native.nativeSubmitObservations()).toHaveLength(0);
    expect(native.nativeReadCounts().detail).toBe(0);
    const pending = monitor.getPendingSellOrders('BULL.HK');
    expect(pending).toHaveLength(1);
    expect(pending[0]?.orderId).toBe('SELL-PROTECTIVE-TIMEOUT');
    await monitor.stopRuntimeAndDrain();
  });

  it('converts timed-out sell to market order after WS confirms non-filled terminal', async () => {
    const frame = {
      orderId: 'SELL-TIMEOUT-CONVERT-WS',
      symbol: 'BULL.HK',
      stockName: 'HSI RC',
      remark: '',
      side: 'SELL' as const,
      status: 'New' as const,
      orderType: 'ELO' as const,
      quantity: '100',
      executedQuantity: '0',
      submittedPrice: '1',
      executedPrice: '0',
      submittedAtMs: Date.parse('2026-02-25T03:00:00.000Z'),
      executionTimeMs: null,
      updatedAtMs: Date.parse('2026-02-25T03:11:00.000Z'),
    };
    const { deps, native, economic } = await createNativeDeps(
      {
        sellTimeoutSeconds: 0,
        now: () => new Date('2026-02-25T03:11:00.000Z'),
        continuousTradingOpen: () => isInContinuousHKSession(new Date('2026-02-25T03:11:00.000Z')),
      },
      frame,
    );
    const cancelMutationStarted = createDeferred();
    const releaseCancelResponse = createDeferred();
    native.setCancelBeforeReply(async () => {
      cancelMutationStarted.resolve();
      await releaseCancelResponse.promise;
    });
    native.setSubmitBehavior(async () => 'SELL-TIMEOUT-CONVERT-WS-MARKET');
    native.setAccountBalance({
      currency: 'HKD',
      totalCash: '100000',
      netAssets: '100000',
      availableCash: '100000',
    });
    native.setStockPositions([]);
    const receipt = await economic.snapshot.requestRefresh({
      source: 'NATIVE-CANCEL-CONVERT',
      dayEpoch: 1,
      refreshAccount: true,
      refreshPositions: true,
    }).result;
    if (receipt.status !== 'COMMITTED')
      throw new Error('cancel conversion requires issued actual paired authority');

    const monitor = native.createMonitor(deps);

    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.startRuntime();

    monitor.trackOrder({
      orderId: 'SELL-TIMEOUT-CONVERT-WS',
      symbol: 'BULL.HK',
      side: 'SELL',
      executionSide: 'SELL',
      price: '1',
      initialSubmittedPrice: '1',
      quantity: 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: 'ELO',
    });

    await cancelMutationStarted.promise;

    expect(native.subscribeObservations()[0]).toContain('PRIVATE');
    native.emitOrderChangedFrame({ ...frame, status: 'Canceled' });
    await flushMicrotasks();
    await flushMicrotasks();
    releaseCancelResponse.resolve();

    await waitForConditionWithDelay(
      () => native.nativeSubmitObservations().length === 1,
      '[测试] 预期 WS 终态触发超时卖单转市价，但 submitOrder 未发生',
    );

    expect(Array.from({ length: native.nativeReadCounts().cancel })).toHaveLength(1);
    expect(native.nativeSubmitObservations()).toHaveLength(1);
    const payload = native.nativeSubmitObservations()[0];
    expect(payload?.orderType).toBe('MO');
    expect(payload?.side).toBe('SELL');
    expect(payload?.quantity).toBe('100');
    await monitor.stopRuntimeAndDrain();
  });

  it('does not convert timed-out sell when WS filled arrives after cancel mutation starts', async () => {
    const executionMs = Date.parse('2026-02-25T03:11:00.000Z');
    const frame = {
      orderId: 'SELL-TIMEOUT-FILLED-DURING-CANCEL',
      symbol: 'BULL.HK',
      stockName: 'HSI RC',
      remark: '',
      side: 'SELL' as const,
      status: 'Filled' as const,
      orderType: 'ELO' as const,
      quantity: '100',
      executedQuantity: '100',
      submittedPrice: '1',
      executedPrice: '1',
      submittedAtMs: executionMs - 1000,
      executionTimeMs: executionMs,
      updatedAtMs: executionMs,
    };
    const caller: { isCurrent?: () => boolean } = {};
    const { deps, native, economic } = await createNativeDeps(
      {
        now: () => new Date(executionMs + 1000),
        continuousTradingOpen: () => caller.isCurrent?.() ?? false,

        sellTimeoutSeconds: 0,
      },
      frame,
    );
    native.setAccountBalance({
      currency: 'HKD',
      totalCash: '100000',
      netAssets: '100000',
      availableCash: '100000',
    });

    native.setStockPositions([
      {
        symbol: 'BULL.HK',
        symbolName: 'BULL',
        accountChannel: 'lb',
        currency: 'HKD',
        quantity: '100',
        availableQuantity: '100',
        costPrice: '1',
      },
    ]);
    const receipt = await economic.snapshot.requestRefresh({
      source: 'NATIVE-CANCEL-RESPONSE-BARRIER',
      dayEpoch: 1,
      refreshAccount: true,
      refreshPositions: true,
    }).result;
    if (receipt.status !== 'COMMITTED')
      throw new Error('barrier origin requires issued paired receipt');

    const captured = receipt.snapshotToken;
    expect(
      economic.snapshot.isCurrent(captured, { account: true, positions: true, paired: true }),
    ).toBe(true);
    const sessionAt = deps.now();
    caller.isCurrent = () =>
      isInContinuousHKSession(sessionAt) && !economic.termination.isTerminated();
    native.setSubmitBehavior(async () => 'SELL-TIMEOUT-FILLED-DURING-CANCEL-MARKET');
    const cancelMutationStarted = createDeferred();
    const releaseCancelResponse = createDeferred();
    native.setCancelBeforeReply(async () => {
      cancelMutationStarted.resolve();
      await releaseCancelResponse.promise;
    });
    const monitor = native.createMonitor(deps);

    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.startRuntime();
    monitor.trackOrder({
      orderId: 'SELL-TIMEOUT-FILLED-DURING-CANCEL',
      symbol: 'BULL.HK',
      side: native.queryObservation.executionSide,
      executionSide: native.queryObservation.executionSide,
      price: '1',
      initialSubmittedPrice: '1',
      quantity: 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: native.queryObservation.orderType,
    });

    await cancelMutationStarted.promise;
    await (async () => {
      native.emitOrderChangedFrame(frame);
      await waitForCondition(
        () => {
          const fatal = economic.termination.getFatalState();
          if (fatal.hasFatalError) throw fatal.error;

          const tracked = monitor.getPendingSellOrders('BULL.HK');
          return (
            tracked.length === 0 || tracked[0]?.executedQuantity === Number(frame.executedQuantity)
          );
        },
        'original WS did not finish before cancel response release',
        80,
      );
    })();
    releaseCancelResponse.resolve();

    await monitor.stopRuntimeAndDrain();

    expect(native.nativeReadCounts().cancel).toBe(1);
    expect(native.nativeSubmitObservations()).toHaveLength(0);
    expect(monitor.getPendingSellOrders('BULL.HK')).toEqual([]);
  });

  it('converts only the remaining quantity when partial cancellation arrives after cancel mutation starts', async () => {
    const executionMs = Date.parse('2026-02-25T03:11:00.000Z');
    const frame = {
      orderId: 'SELL-TIMEOUT-PARTIAL-DURING-CANCEL',
      symbol: 'BULL.HK',
      stockName: 'HSI RC',
      remark: '',
      side: 'SELL' as const,
      status: 'Canceled' as const,
      orderType: 'ELO' as const,
      quantity: '100',
      executedQuantity: '40',
      submittedPrice: '1',
      executedPrice: '1',
      submittedAtMs: executionMs - 1000,
      executionTimeMs: executionMs,
      updatedAtMs: executionMs,
    };
    const caller: { isCurrent?: () => boolean } = {};
    const { deps, native, economic } = await createNativeDeps(
      {
        now: () => new Date(executionMs + 1000),
        continuousTradingOpen: () => caller.isCurrent?.() ?? false,

        sellTimeoutSeconds: 0,
      },
      frame,
    );
    native.setAccountBalance({
      currency: 'HKD',
      totalCash: '100000',
      netAssets: '100000',
      availableCash: '100000',
    });

    native.setStockPositions([
      {
        symbol: 'BULL.HK',
        symbolName: 'BULL',
        accountChannel: 'lb',
        currency: 'HKD',
        quantity: '100',
        availableQuantity: '100',
        costPrice: '1',
      },
    ]);
    const receipt = await economic.snapshot.requestRefresh({
      source: 'NATIVE-CANCEL-RESPONSE-BARRIER',
      dayEpoch: 1,
      refreshAccount: true,
      refreshPositions: true,
    }).result;
    if (receipt.status !== 'COMMITTED')
      throw new Error('barrier origin requires issued paired receipt');

    const captured = receipt.snapshotToken;
    expect(
      economic.snapshot.isCurrent(captured, { account: true, positions: true, paired: true }),
    ).toBe(true);
    const sessionAt = deps.now();
    caller.isCurrent = () =>
      isInContinuousHKSession(sessionAt) && !economic.termination.isTerminated();
    native.setSubmitBehavior(async () => 'SELL-TIMEOUT-PARTIAL-DURING-CANCEL-MARKET');
    const cancelMutationStarted = createDeferred();
    const releaseCancelResponse = createDeferred();
    native.setCancelBeforeReply(async () => {
      cancelMutationStarted.resolve();
      await releaseCancelResponse.promise;
    });
    const monitor = native.createMonitor(deps);

    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.startRuntime();
    monitor.trackOrder({
      orderId: 'SELL-TIMEOUT-PARTIAL-DURING-CANCEL',
      symbol: 'BULL.HK',
      side: native.queryObservation.executionSide,
      executionSide: native.queryObservation.executionSide,
      price: '1',
      initialSubmittedPrice: '1',
      quantity: 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: native.queryObservation.orderType,
    });

    await cancelMutationStarted.promise;
    await (async () => {
      native.emitOrderChangedFrame(frame);
      await waitForCondition(
        () => {
          const fatal = economic.termination.getFatalState();
          if (fatal.hasFatalError) throw fatal.error;

          const tracked = monitor.getPendingSellOrders('BULL.HK');
          return (
            tracked.length === 0 || tracked[0]?.executedQuantity === Number(frame.executedQuantity)
          );
        },
        'original WS did not finish before cancel response release',
        80,
      );
    })();
    releaseCancelResponse.resolve();

    await waitForConditionWithDelay(
      () => native.nativeSubmitObservations().length === 1,
      '[测试] 预期部分撤单后仅为剩余数量提交市价卖单，但 submitOrder 未发生',
    );

    const payload = native.nativeSubmitObservations()[0];
    if (payload === undefined) throw new Error('original market submission missing');

    expect(payload.orderType).toBe('MO');
    expect(payload.side).toBe('SELL');
    expect(Number(payload.quantity)).toBe(60);
    await monitor.stopRuntimeAndDrain();
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
    const executionMs = Date.parse('2026-02-25T03:11:00.000Z');
    const frame = {
      orderId: 'SELL-TIMEOUT-TERMINAL-BEFORE-PERMIT',
      symbol: 'BULL.HK',
      stockName: 'HSI RC',
      remark: '',
      side: 'SELL' as const,
      status: 'Canceled' as const,
      orderType: 'ELO' as const,
      quantity: '100',
      executedQuantity: '0',
      submittedPrice: '1',
      executedPrice: '0',
      submittedAtMs: executionMs - 1000,
      executionTimeMs: null,
      updatedAtMs: executionMs,
    };
    const { deps, native } = await createNativeDeps(
      { now: () => new Date(executionMs + 1000), sellTimeoutSeconds: 0, rateLimiter },
      frame,
    );
    const monitor = native.createMonitor(deps);

    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.startRuntime();
    monitor.trackOrder({
      orderId: 'SELL-TIMEOUT-TERMINAL-BEFORE-PERMIT',
      symbol: 'BULL.HK',
      side: 'SELL',
      executionSide: 'SELL',
      price: '1',
      initialSubmittedPrice: '1',
      quantity: 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: 'ELO',
    });

    await permitQueueReached.promise;
    expect(native.subscribeObservations()[0]).toContain('PRIVATE');
    native.emitOrderChangedFrame(frame);
    await flushMicrotasks();
    await flushMicrotasks();
    releasePermit.resolve();

    await monitor.stopRuntimeAndDrain();

    expect(native.nativeReadCounts().cancel).toBe(0);
    expect(native.nativeSubmitObservations()).toHaveLength(0);
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
    const executionMs = revisionMs;
    const frame = {
      orderId: 'SELL-PROTECTIVE-TIMEOUT-DURABLE-ONCE',
      symbol: 'BULL.HK',
      stockName: 'HSI RC',
      remark: '',
      side: 'SELL' as const,
      status: 'Canceled' as const,
      orderType: 'ELO' as const,
      quantity: '100',
      executedQuantity: '100',
      submittedPrice: '1',
      executedPrice: '1.02',
      submittedAtMs: executionMs - 1000,
      executionTimeMs: executionMs,
      updatedAtMs: executionMs,
    };
    const { deps, native } = await createNativeDeps(
      {
        now: () => new Date(executionMs + 1000),
        sellTimeoutSeconds: 0,
        observeDaily: (owner) => ({
          ...owner,
          recordCumulativeExecution: (input, beforeAuthoritativeFactCommit) => {
            dailyLossFacts.push(input);
            return owner.recordCumulativeExecution(input, beforeAuthoritativeFactCommit);
          },
        }),
        persistProtectiveLiquidationExecutionProgress: (progress) => {
          persistedRevisions.push(progress.orderRevisionMs);
        },
        onRecordSettlementRefreshNeed: (need) => {
          refreshNeeds.push(need);
        },
      },
      frame,
    );
    native.setCancelBeforeReply(async () => {});
    const monitor = native.createMonitor(deps);
    monitor.onOrderStateChanged((event) => {
      stateEvents.push(event);
    });

    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.startRuntime();
    monitor.trackOrder({
      orderId: 'SELL-PROTECTIVE-TIMEOUT-DURABLE-ONCE',
      symbol: 'BULL.HK',
      side: 'SELL',
      executionSide: 'SELL',
      price: '1',
      initialSubmittedPrice: '1',
      quantity: 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: true,
      orderType: 'ELO',
    });

    await waitForCondition(
      () => native.nativeReadCounts().cancel === 1,
      '[测试] 预期保护性超时卖单先发起撤单，但 cancelOrder 未发生',
    );

    expect(native.subscribeObservations()[0]).toContain('PRIVATE');
    native.emitOrderChangedFrame(frame);
    await flushMicrotasks();
    await flushMicrotasks();
    await waitForCondition(
      () => stateEvents.length === 1,
      '[测试] 预期 terminal snapshot 被 route 消费并完成结算，但未收到状态事件',
    );

    // prepare 与正式收口各自校验同一 durable 事实；真实 repository 的单次 append 在 integration 验证。
    expect(persistedRevisions).toEqual([revisionMs, revisionMs]);
    expect(
      dailyLossFacts.map((fact) => ({
        factStage: fact.factStage,
        orderId: fact.orderId,
        orderUpdatedAtMs: fact.orderUpdatedAtMs,
      })),
    ).toEqual(
      Array.from({ length: 2 }, () => ({
        factStage: 'TERMINAL',
        orderId: 'SELL-PROTECTIVE-TIMEOUT-DURABLE-ONCE',
        orderUpdatedAtMs: revisionMs,
      })),
    );

    // 经济 prepare 与首次 episode/资源正式关闭是两个业务阶段，不是重复 closed 包刷新。
    expect(refreshNeeds).toEqual(
      Array.from({ length: 2 }, () => ({
        refreshAccount: true,
        refreshPositions: true,
      })),
    );

    expect(stateEvents).toMatchObject([
      {
        orderId: 'SELL-PROTECTIVE-TIMEOUT-DURABLE-ONCE',
        status: 'CANCELED',
      },
    ]);
    expect(native.nativeSubmitObservations()).toHaveLength(0);
    expect(monitor.getPendingSellOrders('BULL.HK')).toEqual([]);
    await monitor.stopRuntimeAndDrain();
  });

  it('fails fast when timeout market sell submit response misses real orderId', async () => {
    let submitCalls = 0;
    const executionMs = Date.parse('2026-02-25T03:11:00.000Z');
    const frame = {
      orderId: 'SELL-TIMEOUT-MISSING-ID',
      symbol: 'BULL.HK',
      stockName: 'HSI RC',
      remark: '',
      side: 'SELL' as const,
      status: 'New' as const,
      orderType: 'ELO' as const,
      quantity: '100',
      executedQuantity: '0',
      submittedPrice: '1',
      executedPrice: '0',
      submittedAtMs: executionMs - 1000,
      executionTimeMs: null,
      updatedAtMs: executionMs,
    };
    const { deps, native, economic } = await createNativeDeps(
      {
        now: () => new Date(executionMs),
        sellTimeoutSeconds: 0,
        continuousTradingOpen: () => isInContinuousHKSession(new Date(executionMs)),
      },
      frame,
    );
    native.setCancelBeforeReply(async () => {});
    native.setSubmitBehavior(async () => {
      submitCalls++;
      return '';
    });

    native.setAccountBalance({
      currency: 'HKD',
      totalCash: '100000',
      netAssets: '100000',
      availableCash: '100000',
    });
    native.setStockPositions([]);
    const receipt = await economic.snapshot.requestRefresh({
      source: 'NATIVE-MISSING-ID',
      dayEpoch: 1,
      refreshAccount: true,
      refreshPositions: true,
    }).result;
    if (receipt.status !== 'COMMITTED')
      throw new Error('missing-id scenario requires real paired authority');

    const monitor = native.createMonitor(deps);
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.startRuntime();
    monitor.trackOrder({
      orderId: frame.orderId,
      symbol: frame.symbol,
      side: native.queryObservation.executionSide,
      executionSide: native.queryObservation.executionSide,
      price: '1',
      initialSubmittedPrice: '1',
      quantity: 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: native.queryObservation.orderType,
    });

    await waitForCondition(
      () => native.nativeReadCounts().cancel === 1,
      '[测试] 预期超时卖单先发起撤单，但 cancelOrder 未发生',
    );
    await flushMicrotasks();
    expect(native.subscribeObservations()[0]).toContain('PRIVATE');
    native.emitOrderChangedFrame({ ...frame, status: 'Canceled' });
    await flushMicrotasks();
    await flushMicrotasks();
    await waitForConditionWithDelay(
      () => submitCalls === 1,
      '[测试] 预期超时卖单转市价已调用 submitOrder，但 submitOrder 未发生',
    );
    await flushMicrotasks();
    const unknownSubmit = await expectPromiseRejectsToMatch(
      () => monitor.stopRuntimeAndDrain(),
      /交易请求结果不可确认/,
    );
    expect(unknownSubmit).toMatchObject({
      name: 'TradeMutationUnknownError',
      operation: 'TradeContext.submitOrder',
      requestAttempted: true,
      code: null,
    });

    expect(unknownSubmit.cause).toMatchObject({
      message: 'submitOrder response missing valid orderId',
    });
    expect(submitCalls).toBe(1);
    expect(monitor.getPendingSellOrders('BULL.HK')).toHaveLength(0);
    expect(native.nativeSubmitObservations()).toMatchObject([
      { orderType: 'MO', side: 'SELL', quantity: '100' },
    ]);
    expect(economic.recorder.getExecutionFact(frame.orderId)).toBeNull();
  });

  it('routes a protective settlement persistence failure from the real WS callback into onFatalError', async () => {
    const persistenceError = new Error('protective progress persistence failed');
    const fatalErrors: unknown[] = [];
    const executionMs = Date.parse('2026-02-25T03:11:00.000Z');
    let producerAdmissionOpen = true;
    let tradingGateOpen = true;
    const termination = createTerminationRuntime({
      closeTradingGate: () => {
        tradingGateOpen = false;
      },
      closeProducerAdmission: () => {
        producerAdmissionOpen = false;
      },
      stopProducers: [],
      onSecondaryError: (error) => {
        throw error;
      },
    });
    const frame = {
      orderId: 'SELL-PROTECTIVE-WS-FATAL',
      symbol: 'BULL.HK',
      stockName: 'HSI RC',
      remark: 'QuantDemo|PL',
      side: 'SELL' as const,
      status: 'Filled' as const,
      orderType: 'ELO' as const,
      quantity: '100',
      executedQuantity: '100',
      submittedPrice: '1',
      executedPrice: '1.02',
      submittedAtMs: executionMs - 1000,
      executionTimeMs: executionMs,
      updatedAtMs: executionMs,
    };
    const { deps, native, economic } = await createNativeDeps(
      {
        now: () => new Date(executionMs + 1000),
        terminationRuntime: termination,
        observeDaily: (owner) => ({
          ...owner,
          recordCumulativeExecution: (input, beforeAuthoritativeFactCommit) => {
            return owner.recordCumulativeExecution(input, beforeAuthoritativeFactCommit);
          },
        }),
        persistProtectiveLiquidationExecutionProgress: () => {
          throw persistenceError;
        },
        termination: {
          isTerminated: termination.isTerminated,
          reportFatalError: (error) => {
            fatalErrors.push(error);
            termination.reportFatalError(error);
          },
        },
      },
      frame,
    );
    const monitor = native.createMonitor(deps);

    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.startRuntime();
    monitor.trackOrder({
      orderId: 'SELL-PROTECTIVE-WS-FATAL',
      symbol: 'BULL.HK',
      side: 'SELL',
      executionSide: 'SELL',
      price: '1',
      initialSubmittedPrice: '1',
      quantity: 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: true,
      orderType: 'ELO',
    });

    economic.recorder.submitSellOrder(
      frame.orderId,
      'BULL.HK',
      'LONG',
      100,
      [],
      frame.submittedAtMs,
    );
    const generation = economic.snapshot.getView().token.snapshotGeneration;
    expect(() => {
      native.emitOrderChangedFrame(frame);
    }).not.toThrow();

    await waitForCondition(
      () => fatalErrors.length === 1,
      'native ingress did not latch original durable failure',
      80,
    );
    expect(fatalErrors).toEqual([persistenceError]);
    expect(monitor.getPendingSellOrders('BULL.HK')).toHaveLength(1);
    expect(fatalErrors[0]).toBe(persistenceError);
    expect(termination.getFatalState()).toEqual({ hasFatalError: true, error: persistenceError });
    expect(producerAdmissionOpen).toBe(false);
    expect(tradingGateOpen).toBe(false);
    expect(economic.recorder.getExecutionFact(frame.orderId)).toBeNull();
    expect(economic.recorder.getPendingSellSnapshot()).toHaveLength(1);
    expect(economic.holds.getHoldSymbols().has('BULL.HK')).toBe(true);
    expect(economic.snapshot.getView().token.snapshotGeneration).toBe(generation);
    await monitor.stopRuntimeAndDrain();
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
    const executionMs = Date.parse('2026-02-25T03:11:00.000Z');
    let admissionOpen = true;
    const termination = createTerminationRuntime({
      closeTradingGate: () => {
        admissionOpen = false;
      },
      closeProducerAdmission: () => {
        admissionOpen = false;
      },
      stopProducers: [],
      onSecondaryError: (error) => {
        throw error;
      },
    });
    const frame = {
      orderId: 'SELL-PROTECTIVE-WS-MISSING-TIME',
      symbol: 'BULL.HK',
      stockName: 'HSI RC',
      remark: '',
      side: 'SELL' as const,
      status: 'Canceled' as const,
      orderType: 'ELO' as const,
      quantity: '100',
      executedQuantity: '40',
      submittedPrice: '1',
      executedPrice: '1.02',
      submittedAtMs: executionMs - 1000,
      executionTimeMs: executionMs,
      updatedAtMs: executionMs,
    };
    const { deps, native, economic } = await createNativeDeps(
      {
        now: () => new Date(executionMs + 1000),
        terminationRuntime: termination,
        observeRecorder: (owner) => ({
          ...owner,
          markSellFilled: (orderId) => {
            recorderCalls.push('markSellFilled');
            return owner.markSellFilled(orderId);
          },
          markSellCancelled: (orderId) => {
            recorderCalls.push('markSellCancelled');
            return owner.markSellCancelled(orderId);
          },
          commitExecutionFact: (fact, isLong, related, beforeCommit) => {
            const sellBefore = owner.getSellRecordByOrderId(fact.brokerOrderId);
            owner.commitExecutionFact(fact, isLong, related, beforeCommit);
            const sellAfter = owner.getSellRecordByOrderId(fact.brokerOrderId);
            if (economicProjectionChanged([sellBefore], [sellAfter]))
              recorderCalls.push('commitExecutionFact');
          },
        }),
        observeDaily: (owner) => ({
          ...owner,
          recordCumulativeExecution: (input, beforeAuthoritativeFactCommit) => {
            dailyLossCalls.push(input);
            return owner.recordCumulativeExecution(input, beforeAuthoritativeFactCommit);
          },
        }),
        persistProtectiveLiquidationExecutionProgress: (input) => {
          persistenceCalls.push(input.orderId);
        },
        observeEpisode: (owner) => ({
          ...owner,
          recordProtectiveFillProgress: (params) => {
            episodeCalls.push('recordProtectiveFillProgress');
            owner.recordProtectiveFillProgress(params);
          },
        }),
        onRecordSettlementRefreshNeed: (need) => {
          refreshNeeds.push(need);
        },
        termination: {
          isTerminated: termination.isTerminated,
          reportFatalError: (error) => {
            fatalErrors.push(error);
            termination.reportFatalError(error);
          },
        },
      },
      frame,
    );
    const monitor = native.createMonitor(deps);
    monitor.onOrderStateChanged((event) => {
      orderStateEvents.push(event);
    });

    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.startRuntime();
    monitor.trackOrder({
      orderId: 'SELL-PROTECTIVE-WS-MISSING-TIME',
      symbol: 'BULL.HK',
      side: 'SELL',
      executionSide: 'SELL',
      price: '1',
      initialSubmittedPrice: '1',
      quantity: 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: true,
      orderType: 'ELO',
    });

    const generation = economic.snapshot.getView().token.snapshotGeneration;
    // Native DTO revision is only read once by the registered production decoder.
    native.setPushUpdatedAtMs(Number.NaN);
    expect(() => {
      native.emitOrderChanged();
    }).not.toThrow();

    await waitForCondition(
      () => fatalErrors.length === 1,
      'registered private invalid-revision ingress did not latch fatal',
      80,
    );

    expect(fatalErrors).toHaveLength(1);
    const fatalError = fatalErrors[0];
    expect(fatalError).toBeInstanceOf(Error);
    if (!(fatalError instanceof Error)) {
      throw new Error('[测试] WS 无效执行时间未透传 Error 到 onFatalError');
    }

    expect(fatalError.message).toBe('[orderMapper] invalid updatedAt');
    expect(recorderCalls).toEqual([]);
    expect(dailyLossCalls).toEqual([]);
    expect(persistenceCalls).toEqual([]);
    expect(episodeCalls).toEqual([]);
    expect(refreshNeeds).toEqual([]);
    expect(orderStateEvents).toEqual([]);
    expect(monitor.getPendingSellOrders('BULL.HK')).toHaveLength(1);
    expect(termination.getFatalState()).toEqual({ hasFatalError: true, error: fatalError });
    expect(admissionOpen).toBe(false);
    expect(economic.recorder.getExecutionFact(frame.orderId)).toBeNull();
    expect(economic.snapshot.getView().token.snapshotGeneration).toBe(generation);
    await monitor.stopRuntimeAndDrain();
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
    let admissionOpen = true;
    const termination = createTerminationRuntime({
      closeTradingGate: () => {
        admissionOpen = false;
      },
      closeProducerAdmission: () => {
        admissionOpen = false;
      },
      stopProducers: [],
      onSecondaryError: (error) => {
        throw error;
      },
    });
    const frame = {
      orderId: 'SELL-PROTECTIVE-WS-RAW-PARTIAL',
      symbol: 'BULL.HK',
      stockName: 'HSI RC',
      remark: '',
      side: 'SELL' as const,
      status: 'PartialFilled' as const,
      orderType: 'ELO' as const,
      quantity: '100',
      executedQuantity: '40',
      submittedPrice: '1',
      executedPrice: '1.02',
      submittedAtMs: firstRevisionMs - 1000,
      executionTimeMs: firstRevisionMs,
      updatedAtMs: firstRevisionMs,
    };
    const { deps, native, economic } = await createNativeDeps(
      {
        now: () => new Date(firstRevisionMs + 2000),
        terminationRuntime: termination,
        observeRecorder: (owner) => ({
          ...owner,
          markSellPartialFilled: (orderId, filledQuantity) => {
            partialFills.push(filledQuantity);
            return owner.markSellPartialFilled(orderId, filledQuantity);
          },
        }),
        observeDaily: (owner) => ({
          ...owner,
          recordCumulativeExecution: (input, beforeAuthoritativeFactCommit) => {
            dailyLossCalls.push(input);
            return owner.recordCumulativeExecution(input, beforeAuthoritativeFactCommit);
          },
        }),
        persistProtectiveLiquidationExecutionProgress: (input) => {
          persistenceCalls.push(input.orderId);
        },
        observeEpisode: (owner) => ({
          ...owner,
          recordProtectiveFillProgress: (params) => {
            episodeCalls.push('recordProtectiveFillProgress');
            owner.recordProtectiveFillProgress(params);
          },
        }),
        onRecordSettlementRefreshNeed: (need) => {
          refreshNeeds.push(need);
        },
        termination: {
          isTerminated: termination.isTerminated,
          reportFatalError: (error) => {
            fatalErrors.push(error);
            termination.reportFatalError(error);
          },
        },
      },
      frame,
    );
    const monitor = native.createMonitor(deps);
    monitor.onOrderStateChanged((event) => {
      orderStateEvents.push(event);
    });

    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.trackOrder({
      orderId: 'SELL-PROTECTIVE-WS-RAW-PARTIAL',
      symbol: 'BULL.HK',
      side: 'SELL',
      executionSide: 'SELL',
      price: '1',
      initialSubmittedPrice: '1',
      quantity: 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: true,
      orderType: 'ELO',
    });

    economic.recorder.submitSellOrder(
      frame.orderId,
      'BULL.HK',
      'LONG',
      100,
      [],
      frame.submittedAtMs,
    );
    expect(native.subscribeObservations()[0]).toContain('PRIVATE');
    native.emitOrderChangedFrame(frame);
    await waitForCondition(
      () => partialFills.length === 1,
      'actual first partial execution did not progress',
      80,
    );
    const generation = economic.snapshot.getView().token.snapshotGeneration;
    native.setPushExecutedPriceMissing();
    native.setPushUpdatedAtMs(firstRevisionMs + 1000);
    expect(native.subscribeObservations()[0]).toContain('PRIVATE');
    native.emitOrderChanged();
    await waitForCondition(
      () => fatalErrors.length === 1,
      'actual second native invalid-price frame did not latch fatal',
      80,
    );

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
    expect(admissionOpen).toBe(false);
    expect(termination.getFatalState()).toEqual({ hasFatalError: true, error: fatalErrors[0] });
    expect(economic.snapshot.getView().token.snapshotGeneration).toBe(generation);
    expect(economic.recorder.getSellRecordByOrderId(frame.orderId)).toBeNull();

    expect(economic.recorder.getExecutionFact(frame.orderId)).toMatchObject({
      cumulativeQuantity: 40,
      cumulativeAmount: '40.8',
      executionTimeMs: firstRevisionMs,
      updatedAtMs: firstRevisionMs,
    });

    expect(economic.recorder.getPendingSellSnapshot()).toMatchObject([
      { orderId: frame.orderId, filledQuantity: 40 },
    ]);
    expect(economic.holds.getHoldSymbols().has('BULL.HK')).toBe(true);
    await monitor.stopRuntimeAndDrain();
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
    const executionMs = Date.parse('2026-02-25T03:11:00.000Z');
    let admissionOpen = true;
    const termination = createTerminationRuntime({
      closeTradingGate: () => {
        admissionOpen = false;
      },
      closeProducerAdmission: () => {
        admissionOpen = false;
      },
      stopProducers: [],
      onSecondaryError: (error) => {
        throw error;
      },
    });
    const frame = {
      orderId: 'SELL-PROTECTIVE-STATE-CHECK-MISSING-TIME',
      symbol: 'BULL.HK',
      stockName: 'HSI RC',
      remark: '',
      side: 'SELL' as const,
      status: 'PartialWithdrawal' as const,
      orderType: 'ELO' as const,
      quantity: '100',
      executedQuantity: '40',
      submittedPrice: '1',
      executedPrice: '1.02',
      submittedAtMs: executionMs - 1000,
      executionTimeMs: executionMs,
      updatedAtMs: executionMs,
    };
    const { deps, native, economic } = await createNativeDeps(
      {
        now: () => new Date(executionMs + 1000),
        terminationRuntime: termination,
        observeRecorder: (owner) => ({
          ...owner,
          markSellFilled: (orderId) => {
            recorderCalls.push('markSellFilled');
            return owner.markSellFilled(orderId);
          },
          markSellCancelled: (orderId) => {
            recorderCalls.push('markSellCancelled');
            return owner.markSellCancelled(orderId);
          },
          commitExecutionFact: (fact, isLong, related, beforeCommit) => {
            const sellBefore = owner.getSellRecordByOrderId(fact.brokerOrderId);
            owner.commitExecutionFact(fact, isLong, related, beforeCommit);
            const sellAfter = owner.getSellRecordByOrderId(fact.brokerOrderId);
            if (economicProjectionChanged([sellBefore], [sellAfter]))
              recorderCalls.push('commitExecutionFact');
          },
        }),
        observeDaily: (owner) => ({
          ...owner,
          recordCumulativeExecution: (input, beforeAuthoritativeFactCommit) => {
            dailyLossCalls.push(input);
            return owner.recordCumulativeExecution(input, beforeAuthoritativeFactCommit);
          },
        }),
        persistProtectiveLiquidationExecutionProgress: (input) => {
          persistenceCalls.push(input.orderId);
        },
        observeEpisode: (owner) => ({
          ...owner,
          recordProtectiveFillProgress: (params) => {
            episodeCalls.push('recordProtectiveFillProgress');
            owner.recordProtectiveFillProgress(params);
          },
        }),
        onRecordSettlementRefreshNeed: (need) => {
          refreshNeeds.push(need);
        },
        termination: {
          isTerminated: termination.isTerminated,
          reportFatalError: (error) => {
            fatalErrors.push(error);
            termination.reportFatalError(error);
          },
        },
      },
      frame,
    );
    native.setCancelFailure(new Error('openapi error: code=601011: Order already cancelled'));
    native.setQueryUpdatedAtMs(Number.NaN);
    const monitor = native.createMonitor(deps);
    monitor.onOrderStateChanged((event) => {
      orderStateEvents.push(event);
    });

    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.trackOrder({
      orderId: 'SELL-PROTECTIVE-STATE-CHECK-MISSING-TIME',
      symbol: 'BULL.HK',
      side: 'SELL',
      executionSide: 'SELL',
      price: '1',
      initialSubmittedPrice: '1',
      quantity: 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: true,
      orderType: 'ELO',
    });

    await expectPromiseRejectsToMatch(
      () =>
        monitor.cancelOrder('SELL-PROTECTIVE-STATE-CHECK-MISSING-TIME', {
          kind: 'ORDER_FACT',
        }),
      /\[orderMapper\] invalid updatedAt/,
    );

    expect(recorderCalls).toEqual([]);
    expect(dailyLossCalls).toEqual([]);
    expect(persistenceCalls).toEqual([]);
    expect(episodeCalls).toEqual([]);
    expect(refreshNeeds).toEqual([]);
    expect(orderStateEvents).toEqual([]);
    expect(fatalErrors).toEqual([]);
    expect(monitor.getPendingSellOrders('BULL.HK')).toHaveLength(1);
    expect(economic.recorder.getExecutionFact(frame.orderId)).toBeNull();
    expect(admissionOpen).toBe(true);
    expect(native.nativeReadCounts()).toEqual({ cancel: 1, detail: 1 });
    await monitor.stopRuntimeAndDrain();
  });

  it('broker ack 后 submitSellOrder 抛错会保留新 tracked fact、旧 placeholder 并上报 fatal', async () => {
    const executionMs = Date.parse('2026-02-25T03:11:00.000Z');
    const syncError = new Error('submit sell sync failed');
    const fatalErrors: unknown[] = [];
    let admissionOpen = true;
    const termination = createTerminationRuntime({
      closeTradingGate: () => {
        admissionOpen = false;
      },
      closeProducerAdmission: () => {
        admissionOpen = false;
      },
      stopProducers: [],
      onSecondaryError: (error) => {
        throw error;
      },
    });
    const frame = {
      orderId: 'SELL-TIMEOUT-LOCAL-SYNC-FAIL',
      symbol: 'BULL.HK',
      stockName: 'HSI RC',
      remark: '',
      side: 'SELL' as const,
      status: 'New' as const,
      orderType: 'ELO' as const,
      quantity: '100',
      executedQuantity: '0',
      submittedPrice: '1',
      executedPrice: '0',
      submittedAtMs: executionMs - 1000,
      executionTimeMs: null,
      updatedAtMs: executionMs,
    };
    const { deps, native, economic } = await createNativeDeps(
      {
        now: () => new Date(executionMs),
        sellTimeoutSeconds: 0,
        continuousTradingOpen: () =>
          isInContinuousHKSession(new Date(executionMs)) && !termination.isTerminated(),
        terminationRuntime: termination,
        termination: {
          isTerminated: termination.isTerminated,
          reportFatalError: (error) => {
            fatalErrors.push(error);
            termination.reportFatalError(error);
          },
        },
        observeRecorder: (owner) => ({
          ...owner,
          submitSellOrder: (...args) => {
            if (args[0] === 'MOCK-000001') throw syncError;

            owner.submitSellOrder(...args);
          },
        }),
      },
      frame,
    );
    native.setCancelBeforeReply(async () => {});
    native.setSubmitBehavior(async () => 'MOCK-000001');
    native.setAccountBalance({
      currency: 'HKD',
      totalCash: '100000',
      netAssets: '100000',
      availableCash: '100000',
    });
    native.setStockPositions([]);
    const receipt = await economic.snapshot.requestRefresh({
      source: 'NATIVE-POST-ACK-SYNC',
      dayEpoch: 1,
      refreshAccount: true,
      refreshPositions: true,
    }).result;
    if (receipt.status !== 'COMMITTED')
      throw new Error('post ack failure requires actual paired authority');

    const monitor = native.createMonitor(deps);
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.startRuntime();
    economic.recorder.submitSellOrder(
      frame.orderId,
      frame.symbol,
      'LONG',
      100,
      ['BUY-1'],
      frame.submittedAtMs,
    );

    monitor.trackOrder({
      orderId: frame.orderId,
      symbol: frame.symbol,
      side: native.queryObservation.executionSide,
      executionSide: native.queryObservation.executionSide,
      price: '1',
      initialSubmittedPrice: '1',
      quantity: 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: native.queryObservation.orderType,
    });

    await waitForCondition(
      () => native.nativeReadCounts().cancel === 1,
      '[测试] 预期超时卖单先发起撤单，但 cancelOrder 未发生',
    );
    await flushMicrotasks();
    expect(native.subscribeObservations()[0]).toContain('PRIVATE');
    native.emitOrderChangedFrame({ ...frame, status: 'Canceled' });
    await flushMicrotasks();
    await flushMicrotasks();
    await waitForConditionWithDelay(
      () => native.nativeSubmitObservations().length === 1,
      '[测试] 预期超时卖单转市价已调用 submitOrder，但 submitOrder 未发生',
    );
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();
    await expectPromiseRejectsToMatch(
      () => monitor.stopRuntimeAndDrain(),
      /order submitted but local sync failed: MOCK-000001/,
    );
    expect(native.nativeSubmitObservations()).toHaveLength(1);
    expect(monitor.getPendingSellOrders('BULL.HK').map((order) => order.orderId)).toEqual([
      'MOCK-000001',
    ]);

    expect(economic.recorder.getPendingSellSnapshot().map((order) => order.orderId)).toEqual([
      'SELL-TIMEOUT-LOCAL-SYNC-FAIL',
    ]);
    expect(fatalErrors).toHaveLength(1);
    const fatalError = fatalErrors[0];
    if (!(fatalError instanceof Error)) throw new Error('post ack fatal missing actual Error');

    expect(fatalError.message).toContain('order submitted but local sync failed: MOCK-000001');
    expect(fatalError).toMatchObject({
      name: 'AcceptedOrderLocalSyncError',
      operation: 'TradeContext.submitOrder',
      requestAttempted: true,
      orderId: 'MOCK-000001',
    });
    expect(fatalError.cause).toBe(syncError);
    expect(termination.getFatalState()).toEqual({ hasFatalError: true, error: fatalError });
    expect(admissionOpen).toBe(false);
    expect(economic.holds.getHoldSymbols().has(frame.symbol)).toBe(true);
  });

  it('does not allocate replacement relatedBuyOrderIds when timeout sell cancel request succeeds', async () => {
    let allocateCalls = 0;
    const frame = {
      orderId: 'SELL-RECOVER-ALLOC',
      symbol: 'BULL.HK',
      stockName: 'HSI RC',
      remark: '',
      side: 'SELL' as const,
      status: 'New' as const,
      orderType: 'ELO' as const,
      quantity: '100',
      executedQuantity: '0',
      submittedPrice: '1',
      executedPrice: '0',
      submittedAtMs: Date.parse('2026-02-25T03:00:00.000Z'),
      executionTimeMs: null,
      updatedAtMs: Date.parse('2026-02-25T03:00:10.000Z'),
    };
    const { deps, native } = await createNativeDeps(
      {
        now: () => new Date('2026-02-25T03:10:00.000Z'),
        sellTimeoutSeconds: 0,
        buyTimeoutSeconds: 999,
        observeRecorder: (owner) => ({
          ...owner,
          allocateRelatedBuyOrderIdsForRecovery: (...args) => {
            allocateCalls += 1;
            return owner.allocateRelatedBuyOrderIdsForRecovery(...args);
          },
        }),
      },
      frame,
    );
    native.setCancelBeforeReply(async () => {});
    const monitor = native.createMonitor(deps);

    await monitor.initialize();
    monitor.startRuntime();
    await monitor.recoverOrderTrackingFromSnapshot([native.queryObservation]);

    await waitForCondition(
      () => native.nativeReadCounts().cancel === 1,
      '[测试] 预期恢复后的超时卖单先发起撤单，但 cancelOrder 未发生',
    );
    const allocateCallsBeforeTimeoutProcessing = allocateCalls;

    expect(native.nativeReadCounts().cancel).toBe(1);
    expect(native.nativeSubmitObservations()).toHaveLength(0);
    expect(native.nativeReadCounts().detail).toBe(0);
    expect(allocateCalls).toBe(allocateCallsBeforeTimeoutProcessing);
    await monitor.stopRuntimeAndDrain();
  });

  it('cancels timed-out buy order without market conversion', async () => {
    const frame = {
      orderId: 'BUY-001',
      symbol: 'BULL.HK',
      stockName: 'HSI RC',
      remark: '',
      side: 'BUY' as const,
      status: 'New' as const,
      orderType: 'ELO' as const,
      quantity: '100',
      executedQuantity: '0',
      submittedPrice: '1',
      executedPrice: '0',
      submittedAtMs: Date.parse('2026-02-25T03:00:00.000Z'),
      executionTimeMs: null,
      updatedAtMs: Date.parse('2026-02-25T03:00:10.000Z'),
    };
    const { deps, native } = await createNativeDeps(
      {
        now: () => new Date('2026-02-25T03:10:00.000Z'),
        buyTimeoutSeconds: 0,
        sellTimeoutSeconds: 999,
      },
      frame,
    );
    native.setCancelBeforeReply(async () => {});
    const monitor = native.createMonitor(deps);

    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.startRuntime();

    monitor.trackOrder({
      orderId: 'BUY-001',
      symbol: 'BULL.HK',
      side: native.queryObservation.executionSide,
      executionSide: native.queryObservation.executionSide,
      price: '1',
      initialSubmittedPrice: '1',
      quantity: 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: native.queryObservation.orderType,
    });

    await waitForCondition(
      () => native.nativeReadCounts().cancel === 1,
      'original successful timeout cancel native ACK not issued',
      80,
    );

    expect(native.nativeReadCounts().cancel).toBe(1);
    expect(native.nativeSubmitObservations()).toHaveLength(0);
    await monitor.stopRuntimeAndDrain();
  });

  it('blocks timeout->market conversion when continuous trading is closed', async () => {
    let continuousTradingOpen = false;
    const frame = {
      orderId: 'SELL-002',
      symbol: 'BULL.HK',
      stockName: 'HSI RC',
      remark: '',
      side: 'SELL' as const,
      status: 'New' as const,
      orderType: 'ELO' as const,
      quantity: '100',
      executedQuantity: '0',
      submittedPrice: '1',
      executedPrice: '0',
      submittedAtMs: Date.now() - 1,
      executionTimeMs: null,
      updatedAtMs: Date.now(),
    };
    const caller: { isCurrent?: () => boolean } = {};
    const { deps, native, economic, setQuotes } = await createNativeDeps(
      {
        continuousTradingOpen: () =>
          caller.isCurrent?.() === true && (() => continuousTradingOpen)(),
        sellTimeoutSeconds: 0,
      },
      frame,
    );
    native.setAccountBalance({
      currency: 'HKD',
      totalCash: '100000',
      netAssets: '100000',
      availableCash: '100000',
    });
    native.setStockPositions([]);
    const receipt = await economic.snapshot.requestRefresh({
      source: 'NATIVE-REPLACE-CONTROL',
      dayEpoch: 1,
      refreshAccount: true,
      refreshPositions: true,
    }).result;
    if (receipt.status !== 'COMMITTED')
      throw new Error('control case requires actual paired authority');

    const captured = receipt.snapshotToken;
    expect(
      economic.snapshot.isCurrent(captured, { account: true, positions: true, paired: true }),
    ).toBe(true);
    const sessionAt = deps.now();
    caller.isCurrent = () =>
      isInContinuousHKSession(sessionAt) && !economic.termination.isTerminated();
    setQuotes(new Map([['BULL.HK', createQuoteDouble('BULL.HK', '1')]]));
    native.setCancelBeforeReply(async () => {});
    const monitor = native.createMonitor(deps);

    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.startRuntime();

    monitor.trackOrder({
      orderId: 'SELL-002',
      symbol: 'BULL.HK',
      side: native.queryObservation.executionSide,
      executionSide: native.queryObservation.executionSide,
      price: '1',
      initialSubmittedPrice: '1',
      quantity: 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: native.queryObservation.orderType,
    });

    await waitForCondition(
      () => native.nativeReadCounts().cancel === 1,
      'original closed-session cancel ACK did not issue',
      80,
    );

    expect(native.nativeReadCounts().cancel).toBe(1);
    expect(native.nativeSubmitObservations()).toHaveLength(0);

    continuousTradingOpen = true;
    await monitor.stopRuntimeAndDrain();
  });

  it('连续交易关闭时不自动跟价改单', async () => {
    const frame = {
      orderId: 'SELL-REPLACE-CLOSED-CONTINUOUS-SESSION',
      symbol: 'BULL.HK',
      stockName: 'HSI RC',
      remark: '',
      side: 'SELL' as const,
      status: 'New' as const,
      orderType: 'ELO' as const,
      quantity: '100',
      executedQuantity: '0',
      submittedPrice: '1',
      executedPrice: '0',
      submittedAtMs: Date.now() - 1,
      executionTimeMs: null,
      updatedAtMs: Date.now(),
    };
    const caller: { isCurrent?: () => boolean } = {};
    const { deps, native, economic, setQuotes, emitQuoteUpdated } = await createNativeDeps(
      {
        continuousTradingOpen: () => caller.isCurrent?.() === true && (() => false)(),
        sellTimeoutSeconds: 999,
        buyTimeoutSeconds: 999,
      },
      frame,
    );
    native.setAccountBalance({
      currency: 'HKD',
      totalCash: '100000',
      netAssets: '100000',
      availableCash: '100000',
    });
    native.setStockPositions([]);
    const receipt = await economic.snapshot.requestRefresh({
      source: 'NATIVE-REPLACE-CONTROL',
      dayEpoch: 1,
      refreshAccount: true,
      refreshPositions: true,
    }).result;
    if (receipt.status !== 'COMMITTED')
      throw new Error('control case requires actual paired authority');

    const captured = receipt.snapshotToken;
    expect(
      economic.snapshot.isCurrent(captured, { account: true, positions: true, paired: true }),
    ).toBe(true);
    const sessionAt = deps.now();
    caller.isCurrent = () =>
      isInContinuousHKSession(sessionAt) && !economic.termination.isTerminated();
    setQuotes(new Map([['BULL.HK', createQuoteDouble('BULL.HK', '1')]]));
    setQuotes(new Map([['BULL.HK', createQuoteDouble('BULL.HK', '1')]]));
    const monitor = native.createMonitor(deps);

    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.startRuntime();
    monitor.trackOrder({
      orderId: 'SELL-REPLACE-CLOSED-CONTINUOUS-SESSION',
      symbol: 'BULL.HK',
      side: native.queryObservation.executionSide,
      executionSide: native.queryObservation.executionSide,
      price: '1',
      initialSubmittedPrice: '1',
      quantity: 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: native.queryObservation.orderType,
    });
    await flushMicrotasks();
    setQuotes(new Map([['BULL.HK', createQuoteDouble('BULL.HK', '1.02')]]));

    await emitQuoteUpdated({
      symbol: 'BULL.HK',
      quote: createQuoteDouble('BULL.HK', '1.02'),
    });
    await monitor.stopRuntimeAndDrain();

    expect(native.nativeMutations().filter((m) => m.kind === 'REPLACE')).toHaveLength(0);
  });

  it('自动跟价首次失败后连续交易关闭时不再重试 SDK 改单', async () => {
    const runtimeTimers = createRuntimeTimerHarness(Date.parse('2026-02-25T03:10:00.000Z'));
    let continuousTradingOpen = true;
    let replaceAttemptCount = 0;
    try {
      const frame = {
        orderId: 'SELL-REPLACE-RETRY-CLOSED-CONTINUOUS-SESSION',
        symbol: 'BULL.HK',
        stockName: 'HSI RC',
        remark: '',
        side: 'SELL' as const,
        status: 'New' as const,
        orderType: 'ELO' as const,
        quantity: '100',
        executedQuantity: '0',
        submittedPrice: '1',
        executedPrice: '0',
        submittedAtMs: runtimeTimers.now().getTime() - 1,
        executionTimeMs: null,
        updatedAtMs: runtimeTimers.now().getTime(),
      };
      const caller: { isCurrent?: () => boolean } = {};
      const { deps, native, economic, setQuotes, emitQuoteUpdated } = await createNativeDeps(
        {
          continuousTradingOpen: () =>
            caller.isCurrent?.() === true && (() => continuousTradingOpen)(),
          now: runtimeTimers.now,
          sellTimeoutSeconds: 999,
          buyTimeoutSeconds: 999,
        },
        frame,
      );
      native.setAccountBalance({
        currency: 'HKD',
        totalCash: '100000',
        netAssets: '100000',
        availableCash: '100000',
      });
      native.setStockPositions([]);
      const receipt = await economic.snapshot.requestRefresh({
        source: 'NATIVE-REPLACE-CONTROL',
        dayEpoch: 1,
        refreshAccount: true,
        refreshPositions: true,
      }).result;
      if (receipt.status !== 'COMMITTED')
        throw new Error('control case requires actual paired authority');

      const captured = receipt.snapshotToken;
      caller.isCurrent = () =>
        economic.snapshot.isCurrent(captured, { account: true, positions: true, paired: true });
      setQuotes(new Map([['BULL.HK', createQuoteDouble('BULL.HK', '1')]]));
      native.setReplaceBeforeReply(async () => {
        replaceAttemptCount += 1;
        continuousTradingOpen = false;
        throw new Error('network unavailable');
      });
      setQuotes(new Map([['BULL.HK', createQuoteDouble('BULL.HK', '1')]]));
      const monitor = native.createMonitor(deps);

      await monitor.initialize();
      await monitor.recoverOrderTrackingFromSnapshot([]);
      monitor.startRuntime();
      monitor.trackOrder({
        orderId: 'SELL-REPLACE-RETRY-CLOSED-CONTINUOUS-SESSION',
        symbol: 'BULL.HK',
        side: 'SELL',
        executionSide: 'SELL',
        price: '1',
        initialSubmittedPrice: '1',
        quantity: 100,
        isLongSymbol: true,
        monitorSymbol: 'HSI.HK',
        isProtectiveLiquidation: false,
        orderType: native.queryObservation.orderType,
      });
      await flushMicrotasks();
      setQuotes(new Map([['BULL.HK', createQuoteDouble('BULL.HK', '1.02')]]));

      await emitQuoteUpdated({
        symbol: 'BULL.HK',
        quote: createQuoteDouble('BULL.HK', '1.02'),
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
    const frame = {
      orderId: 'SELL-003',
      symbol: 'BULL.HK',
      stockName: 'HSI RC',
      remark: '',
      side: 'SELL' as const,
      status: 'New' as const,
      orderType: 'MO' as const,
      quantity: '100',
      executedQuantity: '0',
      submittedPrice: '1',
      executedPrice: '0',
      submittedAtMs: Date.now() - 1,
      executionTimeMs: null,
      updatedAtMs: Date.now(),
    };
    const caller: { isCurrent?: () => boolean } = {};
    const { deps, native, economic, setQuotes } = await createNativeDeps(
      {
        continuousTradingOpen: () => caller.isCurrent?.() ?? false,
        sellTimeoutSeconds: 999,
        buyTimeoutSeconds: 999,
      },
      frame,
    );
    native.setAccountBalance({
      currency: 'HKD',
      totalCash: '100000',
      netAssets: '100000',
      availableCash: '100000',
    });
    native.setStockPositions([]);
    const receipt = await economic.snapshot.requestRefresh({
      source: 'NATIVE-REPLACE-CONTROL',
      dayEpoch: 1,
      refreshAccount: true,
      refreshPositions: true,
    }).result;
    if (receipt.status !== 'COMMITTED')
      throw new Error('control case requires actual paired authority');

    const captured = receipt.snapshotToken;
    expect(
      economic.snapshot.isCurrent(captured, { account: true, positions: true, paired: true }),
    ).toBe(true);
    const sessionAt = deps.now();
    caller.isCurrent = () =>
      isInContinuousHKSession(sessionAt) && !economic.termination.isTerminated();
    setQuotes(new Map([['BULL.HK', createQuoteDouble('BULL.HK', '1')]]));
    const monitor = native.createMonitor(deps);

    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.startRuntime();

    monitor.trackOrder({
      orderId: 'SELL-003',
      symbol: 'BULL.HK',
      side: native.queryObservation.executionSide,
      executionSide: native.queryObservation.executionSide,
      price: '1',
      initialSubmittedPrice: '1',
      quantity: 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: native.queryObservation.orderType,
    });
    await flushMicrotasks();

    await (async () => {
      native.emitOrderChangedFrame({
        ...frame,
        status: 'WaitToReplace',
        updatedAtMs: frame.updatedAtMs + 1,
      });

      for (let i = 0; i < 30; i++) await flushMicrotasks();
    })();
    await flushMicrotasks();

    expect(native.nativeMutations().filter((m) => m.kind === 'REPLACE')).toHaveLength(0);
    await monitor.stopRuntimeAndDrain();
  });

  it('recovery keeps strict mode when mismatched buy cancel request succeeds without WS terminal', async () => {
    const executionMs = Date.parse('2026-02-25T03:11:00.000Z');
    const frame = {
      orderId: 'BUY-MISMATCH',
      symbol: 'OTHER.HK',
      stockName: 'HSI RC',
      remark: '',
      side: 'BUY' as const,
      status: 'New' as const,
      orderType: 'ELO' as const,
      quantity: '100',
      executedQuantity: '0',
      submittedPrice: '1',
      executedPrice: '0',
      submittedAtMs: executionMs - 1000,
      executionTimeMs: null,
      updatedAtMs: executionMs,
    };
    const { deps, native, economic } = await createNativeDeps(
      { now: () => new Date(executionMs + 1000) },
      frame,
    );
    native.setCancelBeforeReply(async () => {});
    const monitor = native.createMonitor(deps);
    await monitor.initialize();
    await expectPromiseRejectsToMatch(
      () => monitor.recoverOrderTrackingFromSnapshot([native.queryObservation]),
      /终态未确认/,
    );
    expect(native.orderSnapshotReadCounts().today).toBe(0);
    expect(native.nativeReadCounts().cancel).toBe(1);
    expect(economic.recorder.getExecutionFact(frame.orderId)).toBeNull();
    await monitor.stopRuntimeAndDrain();
  });

  it('recovery blocks when mismatched buy terminal has executed quantity but ownership is unresolved', async () => {
    const executionMs = Date.parse('2026-02-25T03:11:00.000Z');
    const frame = {
      orderId: 'BUY-MISMATCH-PARTIAL',
      symbol: 'OTHER.HK',
      stockName: 'UNKNOWN-ORDER-NAME',
      remark: '',
      side: 'BUY' as const,
      status: 'New' as const,
      orderType: 'ELO' as const,
      quantity: '100',
      executedQuantity: '0',
      submittedPrice: '1',
      executedPrice: '0',
      submittedAtMs: executionMs - 1000,
      executionTimeMs: null,
      updatedAtMs: executionMs,
    };
    const { deps, native, economic } = await createNativeDeps(
      { now: () => new Date(executionMs + 1000) },
      frame,
    );
    native.setCancelFailure(new Error('openapi error: code=603001: Order not found'));
    native.setOrderDetailReplies([
      {
        ...frame,
        status: 'PartialWithdrawal',
        executedQuantity: '20',
        executedPrice: '1.02',
      },
    ]);

    const monitor = native.createMonitor(deps);
    await monitor.initialize();
    await expectPromiseRejectsToMatch(
      () => monitor.recoverOrderTrackingFromSnapshot([native.queryObservation]),
      /不匹配但.*存在成交事实/,
    );
    expect(native.nativeReadCounts().cancel).toBe(1);
    expect(native.nativeReadCounts().detail).toBe(1);
    expect(economic.recorder.getExecutionFact(frame.orderId)).toBeNull();
    await monitor.stopRuntimeAndDrain();
  });

  it('replays bootstrapping filled events after snapshot recovery', async () => {
    const snapshotFrame = {
      orderId: 'SELL-BOOTSTRAP-FILLED',
      symbol: 'BULL.HK',
      stockName: 'HSI RC SAMPLE',
      remark: '',
      side: 'SELL' as const,
      status: 'New' as const,
      orderType: 'ELO' as const,
      quantity: '100',
      executedQuantity: '0',
      submittedPrice: '1',
      executedPrice: '0',
      submittedAtMs: Date.parse('2026-02-25T03:00:00.000Z'),
      executionTimeMs: null,
      updatedAtMs: Date.parse('2026-02-25T03:00:10.000Z'),
    };
    const { deps, native, economic } = await createNativeDeps(
      { now: () => new Date('2026-02-25T03:30:00.000Z') },
      snapshotFrame,
    );
    native.setOrderDetailReplies([snapshotFrame]);
    const [restored] = await native.createQueryOrdersReader(snapshotFrame.orderId)();
    if (restored === undefined)
      throw new Error('native snapshot input did not produce its canonical observation');

    const monitor = native.createMonitor(deps);
    await monitor.initialize();

    await (async () => {
      const executionMs = Date.parse('2026-02-25T03:00:20.000Z');

      native.emitOrderChangedFrame({
        ...snapshotFrame,
        status: 'Filled',
        executedQuantity: '100',
        executedPrice: '1',
        updatedAtMs: executionMs,
      });

      for (let index = 0; index < 40; index++) await flushMicrotasks();
    })();

    await monitor.recoverOrderTrackingFromSnapshot([restored]);

    expect(monitor.getPendingSellOrders('BULL.HK')).toHaveLength(0);
    expect(economic.recorder.getSellRecordByOrderId(snapshotFrame.orderId)).toMatchObject({
      costAmount: '100',
      executedQuantity: 100,
      executedTime: Date.parse('2026-02-25T03:00:20.000Z'),
    });
  });

  it('stopRuntimeAndDrain 后忽略 late order WS，不再改写 tracked truth', async () => {
    const snapshotFrame = {
      orderId: 'SELL-STOPPED-LATE-WS',
      symbol: 'BULL.HK',
      stockName: 'HSI RC SAMPLE',
      remark: '',
      side: 'SELL' as const,
      status: 'New' as const,
      orderType: 'ELO' as const,
      quantity: '100',
      executedQuantity: '0',
      submittedPrice: '1',
      executedPrice: '0',
      submittedAtMs: Date.parse('2026-02-25T03:00:00.000Z'),
      executionTimeMs: null,
      updatedAtMs: Date.parse('2026-02-25T03:00:10.000Z'),
    };
    const { deps, native, economic } = await createNativeDeps(
      { now: () => new Date('2026-02-25T03:30:00.000Z') },
      snapshotFrame,
    );
    native.setOrderDetailReplies([snapshotFrame]);
    const [restored] = await native.createQueryOrdersReader(snapshotFrame.orderId)();
    if (restored === undefined)
      throw new Error('native snapshot input did not produce its canonical observation');

    const monitor = native.createMonitor(deps);
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.startRuntime();

    monitor.trackOrder({
      orderId: 'SELL-STOPPED-LATE-WS',
      symbol: 'BULL.HK',
      side: restored.executionSide,
      executionSide: restored.executionSide,
      price: '1',
      initialSubmittedPrice: '1',
      quantity: 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: restored.orderType,
    });
    await flushMicrotasks();

    expect(monitor.getPendingSellOrders('BULL.HK')).toHaveLength(1);

    await monitor.stopRuntimeAndDrain();

    await (async () => {
      const executionMs = Date.parse('2026-02-25T03:00:20.000Z');

      native.emitOrderChangedFrame({
        ...snapshotFrame,
        status: 'Filled',
        executedQuantity: '100',
        executedPrice: '1',
        updatedAtMs: executionMs,
      });

      for (let index = 0; index < 40; index++) await flushMicrotasks();
    })();

    expect(monitor.getPendingSellOrders('BULL.HK')).toHaveLength(1);
    expect(economic.recorder.getExecutionFact(snapshotFrame.orderId)).toBeNull();
  });

  it('clearTrackedOrders 后到下一次 initialize 前的 late WS 不会污染下一轮 recovery', async () => {
    const snapshotFrame = {
      orderId: 'SELL-CLEAR-STALE-WS',
      symbol: 'BULL.HK',
      stockName: 'HSI RC SAMPLE',
      remark: '',
      side: 'SELL' as const,
      status: 'New' as const,
      orderType: 'ELO' as const,
      quantity: '100',
      executedQuantity: '0',
      submittedPrice: '1',
      executedPrice: '0',
      submittedAtMs: Date.parse('2026-02-25T03:00:00.000Z'),
      executionTimeMs: null,
      updatedAtMs: Date.parse('2026-02-25T03:00:10.000Z'),
    };
    const { deps, native, economic } = await createNativeDeps(
      { now: () => new Date('2026-02-25T03:30:00.000Z') },
      snapshotFrame,
    );
    native.setOrderDetailReplies([snapshotFrame]);
    const [restored] = await native.createQueryOrdersReader(snapshotFrame.orderId)();
    if (restored === undefined)
      throw new Error('native snapshot input did not produce its canonical observation');

    const monitor = native.createMonitor(deps);
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.startRuntime();
    await monitor.stopRuntimeAndDrain();
    monitor.clearTrackedOrders();

    await (async () => {
      const executionMs = Date.parse('2026-02-25T03:00:20.000Z');

      native.emitOrderChangedFrame({
        ...snapshotFrame,
        status: 'Filled',
        executedQuantity: '100',
        executedPrice: '1',
        updatedAtMs: executionMs,
      });

      for (let index = 0; index < 40; index++) await flushMicrotasks();
    })();

    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([restored]);

    expect(monitor.getPendingSellOrders('BULL.HK')).toHaveLength(1);
    expect(economic.recorder.getExecutionFact(snapshotFrame.orderId)).toBeNull();
  });

  it('restores protective liquidation semantics for recovered pending sells', async () => {
    const progressCalls: Array<{
      direction: 'LONG' | 'SHORT';
      symbol: string;
      executedTimeMs: number;
    }> = [];
    let cumulativeCallCount = 0;
    const persisted: string[] = [];
    const executedTimeMs = Date.parse('2026-02-25T03:20:00.000Z');
    const snapshotFrame = {
      orderId: 'SELL-RECOVER-PROTECTIVE',
      symbol: 'BULL.HK',
      stockName: 'HSI RC SAMPLE',
      remark: 'QuantDemo|PL',
      side: 'SELL' as const,
      status: 'New' as const,
      orderType: 'ELO' as const,
      quantity: '100',
      executedQuantity: '0',
      submittedPrice: '1',
      executedPrice: '0',
      submittedAtMs: Date.parse('2026-02-25T03:00:00.000Z'),
      executionTimeMs: null,
      updatedAtMs: Date.parse('2026-02-25T03:00:10.000Z'),
    };
    const { deps, native, economic } = await createNativeDeps(
      {
        now: () => new Date('2026-02-25T03:30:00.000Z'),
        persistProtectiveLiquidationExecutionProgress: (progress) => {
          persisted.push(progress.orderId);
        },
        observeDaily: (owner) => ({
          ...owner,
          recordCumulativeExecution: (input, beforeAuthoritativeFactCommit) => {
            cumulativeCallCount += 1;
            return owner.recordCumulativeExecution(input, beforeAuthoritativeFactCommit);
          },
        }),
        observeEpisode: (owner) => ({
          ...owner,
          recordProtectiveFillProgress: (params) => {
            progressCalls.push(params);
            owner.recordProtectiveFillProgress(params);
          },
        }),
      },
      snapshotFrame,
    );
    native.setOrderDetailReplies([snapshotFrame]);
    const [restored] = await native.createQueryOrdersReader(snapshotFrame.orderId)();
    if (restored === undefined)
      throw new Error('native snapshot input did not produce its canonical observation');

    const monitor = native.createMonitor(deps);
    await monitor.initialize();

    await monitor.recoverOrderTrackingFromSnapshot([restored]);

    await (async () => {
      const executionMs = executedTimeMs;

      native.emitOrderChangedFrame({
        ...snapshotFrame,
        status: 'Filled',
        executedQuantity: '100',
        executedPrice: '1',
        updatedAtMs: executionMs,
      });

      for (let index = 0; index < 40; index++) await flushMicrotasks();
    })();

    expect(persisted).toEqual(['SELL-RECOVER-PROTECTIVE']);
    expect(cumulativeCallCount).toBe(1);
    expect(progressCalls).toHaveLength(1);
    expect(progressCalls[0]).toEqual({
      direction: 'LONG',
      symbol: 'BULL.HK',
      executedTimeMs,
    });

    expect(economic.recorder.getSellRecordByOrderId(snapshotFrame.orderId)).toMatchObject({
      costAmount: '100',
      executedQuantity: 100,
      executedTime: executedTimeMs,
    });
  });

  it('fails fast when pending sell ownership cannot be resolved', async () => {
    const snapshotFrame = {
      orderId: 'SELL-UNRESOLVED',
      symbol: 'BULL.HK',
      stockName: 'UNKNOWN-ORDER-NAME',
      remark: '',
      side: 'SELL' as const,
      status: 'New' as const,
      orderType: 'ELO' as const,
      quantity: '100',
      executedQuantity: '0',
      submittedPrice: '1',
      executedPrice: '0',
      submittedAtMs: Date.parse('2026-02-25T03:00:00.000Z'),
      executionTimeMs: null,
      updatedAtMs: Date.parse('2026-02-25T03:00:10.000Z'),
    };
    const { deps, native, economic } = await createNativeDeps(
      { now: () => new Date('2026-02-25T03:30:00.000Z') },
      snapshotFrame,
    );
    native.setOrderDetailReplies([snapshotFrame]);
    const [restored] = await native.createQueryOrdersReader(snapshotFrame.orderId)();
    if (restored === undefined)
      throw new Error('native snapshot input did not produce its canonical observation');

    const monitor = native.createMonitor(deps);
    await monitor.initialize();

    await expectPromiseRejectsToMatch(
      () => monitor.recoverOrderTrackingFromSnapshot([restored]),
      /无法解析归属/,
    );
    expect(economic.recorder.getPendingSellSnapshot()).toEqual([]);
  });

  it('clears recovered sell runtime state when mismatched buy cancel fails, and remains strict on later cancel success', async () => {
    const executionMs = Date.parse('2026-02-25T03:11:00.000Z');
    const frame = {
      orderId: 'SELL-RECOVER-FAIL-001',
      symbol: 'BULL.HK',
      stockName: 'HSI RC SAMPLE',
      remark: '',
      side: 'SELL' as const,
      status: 'New' as const,
      orderType: 'ELO' as const,
      quantity: '100',
      executedQuantity: '0',
      submittedPrice: '1',
      executedPrice: '0',
      submittedAtMs: executionMs - 1000,
      executionTimeMs: null,
      updatedAtMs: executionMs,
    };
    const { deps, native, economic } = await createNativeDeps(
      { now: () => new Date(executionMs + 1000) },
      frame,
    );
    const monitor = native.createMonitor(deps);
    await monitor.initialize();

    const failure = new Error('simulated cancel failure');
    let attempts = 0;
    native.setCancelBeforeReply(async () => {
      if (++attempts === 1) throw failure;
    });
    const pendingSell = native.queryObservation;
    const buyFrame = {
      ...frame,
      orderId: 'BUY-RECOVER-FAIL-001',
      symbol: 'OTHER.HK',
      side: 'BUY' as const,
    };
    native.setOrderDetailReplies([buyFrame]);
    const [mismatchedPendingBuy] = await native.createQueryOrdersReader(buyFrame.orderId)();
    if (mismatchedPendingBuy === undefined) throw new Error('canonical same ctx BUY input missing');

    const unknownCancel = await expectPromiseRejectsToMatch(
      () => monitor.recoverOrderTrackingFromSnapshot([pendingSell, mismatchedPendingBuy]),
      /撤单失败\/终态未确认/,
    );
    expect(unknownCancel).toMatchObject({
      name: 'TradeMutationUnknownError',
      operation: 'TradeContext.cancelOrder',
      requestAttempted: true,
      code: null,
    });
    expect(unknownCancel.cause).toBe(failure);
    expect(monitor.getPendingSellOrders('BULL.HK')).toHaveLength(0);

    // The finite actual cancel hook has exhausted its sole failure; next issued call ACKs.
    await expectPromiseRejectsToMatch(
      () => monitor.recoverOrderTrackingFromSnapshot([pendingSell, mismatchedPendingBuy]),
      /终态未确认/,
    );
    expect(monitor.getPendingSellOrders('BULL.HK')).toHaveLength(0);
    expect(native.nativeReadCounts().cancel).toBe(2);
    expect(economic.recorder.getExecutionFact(frame.orderId)).toBeNull();
    await monitor.stopRuntimeAndDrain();
  });

  it('restores submittedAt from snapshot when recovering pending sells', async () => {
    const snapshotFrame = {
      orderId: 'SELL-RESTORE-TIME',
      symbol: 'BULL.HK',
      stockName: 'HSI RC SAMPLE',
      remark: '',
      side: 'SELL' as const,
      status: 'New' as const,
      orderType: 'ELO' as const,
      quantity: '100',
      executedQuantity: '0',
      submittedPrice: '1',
      executedPrice: '0',
      submittedAtMs: Date.parse('2026-02-25T01:23:45.000Z'),
      executionTimeMs: null,
      updatedAtMs: Date.parse('2026-02-25T03:00:10.000Z'),
    };
    const { deps, native, economic } = await createNativeDeps(
      { now: () => new Date('2026-02-25T03:30:00.000Z') },
      snapshotFrame,
    );
    native.setOrderDetailReplies([snapshotFrame]);
    const [restored] = await native.createQueryOrdersReader(snapshotFrame.orderId)();
    if (restored === undefined)
      throw new Error('native snapshot input did not produce its canonical observation');

    const monitor = native.createMonitor(deps);
    await monitor.initialize();

    const submittedAt = new Date('2026-02-25T01:23:45.000Z');
    await monitor.recoverOrderTrackingFromSnapshot([restored]);

    const pending = monitor.getPendingSellOrders('BULL.HK');
    expect(pending).toHaveLength(1);
    expect(pending[0]?.submittedAt).toBe(submittedAt.getTime());
    expect(economic.holds.getHoldSymbols().has('BULL.HK')).toBe(true);
  });

  it('keeps wait-to-replace status from snapshot to avoid replace during recovery window', async () => {
    const snapshotFrame = {
      orderId: 'BUY-WAIT-TO-REPLACE',
      symbol: 'BULL.HK',
      stockName: 'HSI RC SAMPLE',
      remark: '',
      side: 'BUY' as const,
      status: 'WaitToReplace' as const,
      orderType: 'ELO' as const,
      quantity: '100',
      executedQuantity: '0',
      submittedPrice: '1',
      executedPrice: '0',
      submittedAtMs: Date.parse('2026-02-25T03:00:00.000Z'),
      executionTimeMs: null,
      updatedAtMs: Date.parse('2026-02-25T03:00:10.000Z'),
    };
    const caller: { isCurrent?: () => boolean } = {};
    const { deps, native, economic } = await createNativeDeps(
      {
        continuousTradingOpen: () => caller.isCurrent?.() ?? false,
        now: () => new Date('2026-02-25T03:30:00.000Z'),
        sellTimeoutSeconds: 999,
        buyTimeoutSeconds: 999,
      },
      snapshotFrame,
    );
    native.setOrderDetailReplies([snapshotFrame]);
    const [restored] = await native.createQueryOrdersReader(snapshotFrame.orderId)();
    if (restored === undefined)
      throw new Error('native snapshot input did not produce its canonical observation');

    native.setAccountBalance({
      currency: 'HKD',
      totalCash: '100000',
      netAssets: '100000',
      availableCash: '100000',
    });
    native.setStockPositions([]);
    const receipt = await economic.snapshot.requestRefresh({
      source: 'NATIVE-WAIT-REPLACE',
      dayEpoch: 1,
      refreshAccount: true,
      refreshPositions: true,
    }).result;
    if (receipt.status !== 'COMMITTED')
      throw new Error('wait-to-replace requires real paired authority');

    const captured = receipt.snapshotToken;
    expect(
      economic.snapshot.isCurrent(captured, { account: true, positions: true, paired: true }),
    ).toBe(true);
    const sessionAt = deps.now();
    caller.isCurrent = () =>
      isInContinuousHKSession(sessionAt) && !economic.termination.isTerminated();
    expect(caller.isCurrent()).toBe(true);

    const monitor = native.createMonitor(deps);
    await monitor.initialize();

    await monitor.recoverOrderTrackingFromSnapshot([restored]);
    monitor.startRuntime();
    await flushMicrotasks();

    expect(native.nativeMutations().filter((m) => m.kind === 'REPLACE')).toHaveLength(0);
  });

  it('startRuntime 会补跑 start 前积压的 TRACKED 唤醒并推进已超时买单', async () => {
    const frame = {
      orderId: 'BUY-TIMER-START-1',
      symbol: 'BULL.HK',
      stockName: 'HSI RC',
      remark: '',
      side: 'BUY' as const,
      status: 'New' as const,
      orderType: 'ELO' as const,
      quantity: '100',
      executedQuantity: '0',
      submittedPrice: '1',
      executedPrice: '0',
      submittedAtMs: Date.parse('2026-02-25T03:00:00.000Z'),
      executionTimeMs: null,
      updatedAtMs: Date.parse('2026-02-25T03:00:10.000Z'),
    };
    const { deps, native } = await createNativeDeps(
      {
        now: () => new Date('2026-02-25T03:10:00.000Z'),
        buyTimeoutSeconds: 0,
        sellTimeoutSeconds: 999,
      },
      frame,
    );
    native.setCancelBeforeReply(async () => {});
    const monitor = native.createMonitor(deps);
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);

    monitor.trackOrder({
      orderId: 'BUY-TIMER-START-1',
      symbol: 'BULL.HK',
      side: native.queryObservation.executionSide,
      executionSide: native.queryObservation.executionSide,
      price: '1',
      initialSubmittedPrice: '1',
      quantity: 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: native.queryObservation.orderType,
    });
    monitor.startRuntime();

    await waitForCondition(
      () => native.nativeReadCounts().cancel === 1,
      '[测试] 预期 startRuntime 后补跑积压唤醒并推进超时买单，但 cancelOrder 未发生',
    );

    expect(native.nativeSubmitObservations()).toHaveLength(0);
    await monitor.stopRuntimeAndDrain();
  });

  it('runtime 运行中会在买单超时到点后自动推进，无需 quote 或手动轮询', async () => {
    const runtimeTimers = createRuntimeTimerHarness(Date.parse('2026-02-25T03:00:00.000Z'));
    try {
      const frame = {
        orderId: 'BUY-TIMER-DELAY-1',
        symbol: 'BULL.HK',
        stockName: 'HSI RC',
        remark: '',
        side: 'BUY' as const,
        status: 'New' as const,
        orderType: 'ELO' as const,
        quantity: '100',
        executedQuantity: '0',
        submittedPrice: '1',
        executedPrice: '0',
        submittedAtMs: Date.parse('2026-02-25T03:00:00.000Z'),
        executionTimeMs: null,
        updatedAtMs: Date.parse('2026-02-25T03:00:10.000Z'),
      };
      const { deps, native } = await createNativeDeps(
        {
          now: runtimeTimers.now,
          buyTimeoutSeconds: 0.02,
          sellTimeoutSeconds: 999,
        },
        frame,
      );
      native.setCancelBeforeReply(async () => {});
      const monitor = native.createMonitor(deps);
      await monitor.initialize();
      await monitor.recoverOrderTrackingFromSnapshot([]);
      monitor.startRuntime();

      monitor.trackOrder({
        orderId: 'BUY-TIMER-DELAY-1',
        symbol: 'BULL.HK',
        side: 'BUY',
        executionSide: 'BUY',
        price: '1',
        initialSubmittedPrice: '1',
        quantity: 100,
        isLongSymbol: true,
        monitorSymbol: 'HSI.HK',
        isProtectiveLiquidation: false,
        orderType: native.queryObservation.orderType,
      });
      await flushMicrotasks();

      expect(native.nativeReadCounts().cancel).toBe(0);

      await runtimeTimers.advanceBy(25);
      await waitForCondition(
        () => native.nativeReadCounts().cancel === 1,
        '[测试] 预期 timeout timer 到点后自动推进买单，但 cancelOrder 未发生',
      );

      expect(native.nativeSubmitObservations()).toHaveLength(0);
      await monitor.stopRuntimeAndDrain();
    } finally {
      runtimeTimers.restore();
    }
  });

  it('does not submit market sell when timeout cancel returns already-filled (601012)', async () => {
    const frame = {
      orderId: 'SELL-TIMEOUT-ALREADY-FILLED',
      symbol: 'BULL.HK',
      stockName: 'HSI RC',
      remark: '',
      side: 'SELL' as const,
      status: 'New' as const,
      orderType: 'ELO' as const,
      quantity: '100',
      executedQuantity: '0',
      submittedPrice: '1',
      executedPrice: '0',
      submittedAtMs: Date.parse('2026-02-25T03:00:00.000Z'),
      executionTimeMs: null,
      updatedAtMs: Date.parse('2026-02-25T03:11:00.000Z'),
    };
    const { deps, native, economic } = await createNativeDeps(
      {
        sellTimeoutSeconds: 0,
        buyTimeoutSeconds: 999,
      },
      frame,
    );
    native.setCancelFailure(new Error('openapi error: code=601012: Order has been filled'));
    const monitor = native.createMonitor(deps);
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.startRuntime();

    monitor.trackOrder({
      orderId: 'SELL-TIMEOUT-ALREADY-FILLED',
      symbol: 'BULL.HK',
      side: 'SELL',
      executionSide: 'SELL',
      price: '1',
      initialSubmittedPrice: '1',
      quantity: 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: 'ELO',
    });
    await flushMicrotasks();

    expect(Array.from({ length: native.nativeReadCounts().cancel })).toHaveLength(1);
    expect(native.nativeSubmitObservations()).toHaveLength(0);
    expect(economic.recorder.getExecutionFact(frame.orderId)).toBeNull();
    await monitor.stopRuntimeAndDrain();
  });

  it('records local buy when timeout cancel fails by network error and filled event arrives later', async () => {
    let localBuyCount = 0;
    const executionMs = Date.now();
    const revisionMs = Date.now();
    const frame = {
      orderId: 'BUY-TIMEOUT-NETWORK-FAIL',
      symbol: 'BULL.HK',
      stockName: 'HSI RC',
      remark: '',
      side: 'BUY' as const,
      status: 'Filled' as const,
      orderType: 'ELO' as const,
      quantity: '100',
      executedQuantity: '100',
      submittedPrice: '1',
      executedPrice: '1',
      submittedAtMs: executionMs - 1000,
      executionTimeMs: executionMs,
      updatedAtMs: revisionMs,
    };
    const caller: { isCurrent?: () => boolean } = {};
    const { deps, native, economic } = await createNativeDeps(
      {
        continuousTradingOpen: () => caller.isCurrent?.() ?? false,
        buyTimeoutSeconds: 0,
        sellTimeoutSeconds: 999,
        observeRecorder: (owner) => ({
          ...owner,
          commitExecutionFact: (fact, isLong, related, beforeCommit) => {
            const buyBefore = owner.getBuyOrdersForSymbol(fact.symbol, isLong);
            owner.commitExecutionFact(fact, isLong, related, beforeCommit);
            const buyAfter = owner.getBuyOrdersForSymbol(fact.symbol, isLong);
            if (
              fact.side === 'BUY' &&
              fact.phase === 'TERMINAL' &&
              economicProjectionChanged(buyBefore, buyAfter)
            ) {
              localBuyCount += 1;
            }
          },
        }),
      },
      frame,
    );
    native.setAccountBalance({
      currency: 'HKD',
      totalCash: '100000',
      netAssets: '100000',
      availableCash: '100000',
    });
    native.setStockPositions([]);
    const authority = await economic.snapshot.requestRefresh({
      source: 'MONITOR-NATIVE-NETWORK-CASE',
      dayEpoch: 1,
      refreshAccount: true,
      refreshPositions: true,
    }).result;
    if (authority.status !== 'COMMITTED')
      throw new Error('native paired account/positions request did not commit');

    const captured = authority.snapshotToken;
    caller.isCurrent = () =>
      economic.snapshot.isCurrent(captured, { account: true, positions: true, paired: true });
    native.setCancelFailure(new Error('network timeout'));

    const monitor = native.createMonitor(deps);
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.startRuntime();

    monitor.trackOrder({
      orderId: 'BUY-TIMEOUT-NETWORK-FAIL',
      symbol: 'BULL.HK',
      side: native.queryObservation.executionSide,
      executionSide: native.queryObservation.executionSide,
      price: '1',
      initialSubmittedPrice: '1',
      quantity: 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: native.queryObservation.orderType,
    });
    await flushMicrotasks();

    await waitForCondition(
      () => native.nativeReadCounts().cancel === 1,
      'timeout cancel native IO not issued',
      40,
    );
    native.emitOrderChangedFrame(frame);
    await waitForCondition(() => localBuyCount === 1, 'native later filled did not commit', 60);

    expect(localBuyCount).toBe(1);
    expect(native.nativeReadCounts().cancel).toBe(1);
    expect(economic.recorder.getCostBasis('BULL.HK', true)).toEqual({
      costAmount: '100',
      quantity: 100,
    });
    await monitor.stopRuntimeAndDrain();
  });

  const assertSellPartialFillSettlesOnce = async (
    terminalStatus: 'Canceled' | 'Rejected',
  ): Promise<void> => {
    const orderId = `SELL-PARTIAL-${terminalStatus.toUpperCase()}`;
    const partialExecutionMs = Date.parse('2026-02-25T03:10:00.000Z');
    const terminalRevisionMs = Date.parse('2026-02-25T03:11:00.000Z');
    const economicSellCommits: Array<{ relatedBuyOrderIds: readonly string[] | null }> = [];
    const dailyLossFacts: DailyLossCumulativeExecutionInput[] = [];
    const refreshNeeds: Array<{
      readonly refreshAccount: boolean;
      readonly refreshPositions: boolean;
    }> = [];
    let partialCount = 0;
    let cancelCount = 0;
    const frame = {
      orderId,
      symbol: 'BULL.HK',
      stockName: 'HSI RC',
      remark: '',
      side: 'SELL' as const,
      status: 'PartialFilled' as const,
      orderType: 'ELO' as const,
      quantity: '200',
      executedQuantity: '100',
      submittedPrice: '1',
      executedPrice: '1.05',
      submittedAtMs: Date.parse('2026-02-25T03:06:00.000Z'),
      executionTimeMs: partialExecutionMs,
      updatedAtMs: partialExecutionMs,
    };
    const { deps, native, economic } = await createNativeDeps(
      {
        now: () => new Date('2026-02-25T03:15:00.000Z'),
        observeRecorder: (owner) => ({
          ...owner,
          markSellPartialFilled: (id, quantity) => {
            const result = owner.markSellPartialFilled(id, quantity);
            if (result !== null) partialCount++;

            return result;
          },
          markSellCancelled: (id) => {
            const result = owner.markSellCancelled(id);
            if (result !== null) cancelCount++;

            return result;
          },
          commitExecutionFact: (fact, isLong, related, beforeCommit) => {
            const sellBefore = owner.getSellRecordByOrderId(fact.brokerOrderId);
            owner.commitExecutionFact(fact, isLong, related, beforeCommit);
            const sellAfter = owner.getSellRecordByOrderId(fact.brokerOrderId);
            if (fact.side === 'SELL' && economicProjectionChanged([sellBefore], [sellAfter]))
              economicSellCommits.push({
                relatedBuyOrderIds: related.length === 0 ? null : [...related],
              });
          },
        }),
        observeDaily: (owner) => ({
          ...owner,
          recordCumulativeExecution: (input, beforeCommit) => {
            dailyLossFacts.push(input);
            return owner.recordCumulativeExecution(input, beforeCommit);
          },
        }),
        onRecordSettlementRefreshNeed: (need) => {
          refreshNeeds.push(need);
        },
      },
      frame,
    );
    const buyFrames = [
      {
        ...frame,
        orderId: 'BUY-1',
        side: 'BUY' as const,
        status: 'Filled' as const,
        quantity: '100',
        executedQuantity: '100',
        submittedPrice: '1',
        executedPrice: '1',
        submittedAtMs: Date.parse('2026-02-25T03:00:00.000Z'),
        executionTimeMs: Date.parse('2026-02-25T03:00:00.000Z'),
        updatedAtMs: Date.parse('2026-02-25T03:00:00.000Z'),
      },
      {
        ...frame,
        orderId: 'BUY-2',
        side: 'BUY' as const,
        status: 'Filled' as const,
        quantity: '100',
        executedQuantity: '100',
        submittedPrice: '1.2',
        executedPrice: '1.2',
        submittedAtMs: Date.parse('2026-02-25T03:05:00.000Z'),
        executionTimeMs: Date.parse('2026-02-25T03:05:00.000Z'),
        updatedAtMs: Date.parse('2026-02-25T03:05:00.000Z'),
      },
    ];
    native.setOrderDetailReplies(buyFrames);
;
    for (const buy of buyFrames) {
      const [observation] = await native.createQueryOrdersReader(buy.orderId)();
      if (observation === undefined) throw new Error('real BUY seed missing');

      economic.flow.recordCumulativeExecution({
        orderId: observation.orderId,
        symbol: observation.symbol,
        side: observation.executionSide,
        factStage: observation.executionPhase,
        monitorSymbol: 'HSI.HK',
        isLongSymbol: true,
        isProtectiveLiquidation: false,
        executedQuantity: observation.executedQuantity,
        executedAmount: observation.executedAmount!,
        executedPrice: observation.executedPrice!,
        executedTimeMs: observation.executionTimeMs,
        orderUpdatedAtMs: observation.updatedAtMs,
      });
    }

    // Original expectations below observe only the SELL, after actual BUY economics are established.
    dailyLossFacts.length = 0;
    refreshNeeds.length = 0;
    const monitor = native.createMonitor(deps);
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    economic.recorder.submitSellOrder(
      frame.orderId,
      'BULL.HK',
      'LONG',
      200,
      ['BUY-1', 'BUY-2'],
      frame.submittedAtMs,
    );

    monitor.trackOrder({
      orderId: frame.orderId,
      symbol: frame.symbol,
      side: native.queryObservation.executionSide,
      executionSide: native.queryObservation.executionSide,
      price: '1',
      initialSubmittedPrice: '1',
      quantity: 200,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: native.queryObservation.orderType,
    });
    native.emitOrderChangedFrame(frame);
    await waitForCondition(
      () => dailyLossFacts.length === 1,
      'original partial SELL economics did not arrive',
      80,
    );

    for (let i = 0; i < 10; i++) await flushMicrotasks();

    native.emitOrderChangedFrame({
      ...frame,
      status: terminalStatus,
      updatedAtMs: terminalRevisionMs,
    });

    await waitForCondition(
      () => monitor.getPendingSellOrders('BULL.HK').length === 0,
      'original terminal SELL did not release resources',
      80,
    );
    const firstTerminalGeneration = economic.snapshot.getView().token.snapshotGeneration;
    native.emitOrderChangedFrame({
      ...frame,
      status: terminalStatus,
      updatedAtMs: Date.parse('2026-02-25T03:12:00.000Z'),
    });

    await waitForCondition(
      () => true,
      'removed IO assertion',
      80,
    );
    await monitor.stopRuntimeAndDrain();
    expect(partialCount).toBe(1);
    expect(cancelCount).toBe(1);
    expect(economicSellCommits).toHaveLength(1);
    expect(economicSellCommits[0]?.relatedBuyOrderIds).toEqual(['BUY-1']);
    expect(dailyLossFacts).toEqual([
      {
        factStage: 'OPEN',
        direction: 'LONG',
        symbol: 'BULL.HK',
        side: 'SELL',
        executedPrice: '1.05',
        executedQuantity: 100,
        executedTimeMs: partialExecutionMs,
        orderUpdatedAtMs: partialExecutionMs,
        orderId,
      },
      {
        factStage: 'TERMINAL',
        direction: 'LONG',
        symbol: 'BULL.HK',
        side: 'SELL',
        executedPrice: '1.05',
        executedQuantity: 100,
        executedTimeMs: partialExecutionMs,
        orderUpdatedAtMs: terminalRevisionMs,
        orderId,
      },
      {
        factStage: 'TERMINAL',
        direction: 'LONG',
        symbol: 'BULL.HK',
        side: 'SELL',
        executedPrice: '1.05',
        executedQuantity: 100,
        executedTimeMs: partialExecutionMs,
        orderUpdatedAtMs: Date.parse('2026-02-25T03:12:00.000Z'),
        orderId,
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

    expect(economic.recorder.getCostBasis('BULL.HK', true)).toEqual({
      costAmount: '120',
      quantity: 100,
    });

    expect(economic.recorder.getSellRecordByOrderId(frame.orderId)).toMatchObject({
      costAmount: '105',
      executedQuantity: 100,
      executedTime: partialExecutionMs,
    });
    expect(economic.recorder.getPendingSellSnapshot()).toEqual([]);
    expect(economic.holds.getHoldSymbols().has('BULL.HK')).toBe(false);
    expect(economic.snapshot.getView().token.snapshotGeneration).toBe(firstTerminalGeneration);
    expect(economic.termination.isTerminated()).toBe(false);
  };

  it('settles filled quantity once when sell is canceled after partial fill', async () =>
    assertSellPartialFillSettlesOnce('Canceled'));

  it('settles filled quantity once when sell is rejected after partial fill', async () =>
    assertSellPartialFillSettlesOnce('Rejected'));

  it('falls back to quantity-based local settlement when partial fill cannot be mapped to exact buy orders', async () => {
    const partialExecutionMs = Date.parse('2026-02-25T03:10:00.000Z');
    const terminalRevisionMs = Date.parse('2026-02-25T03:11:00.000Z');
    const economicSellCommits: Array<{ relatedBuyOrderIds: readonly string[] | null }> = [];
    const dailyLossFacts: DailyLossCumulativeExecutionInput[] = [];
    const refreshNeeds: Array<{
      readonly refreshAccount: boolean;
      readonly refreshPositions: boolean;
    }> = [];

    const frame = {
      orderId: 'SELL-PARTIAL-FALLBACK',
      symbol: 'BULL.HK',
      stockName: 'HSI RC',
      remark: '',
      side: 'SELL' as const,
      status: 'PartialFilled' as const,
      orderType: 'ELO' as const,
      quantity: '140',
      executedQuantity: '100',
      submittedPrice: '1',
      executedPrice: '1.05',
      submittedAtMs: Date.parse('2026-02-25T03:06:00.000Z'),
      executionTimeMs: partialExecutionMs,
      updatedAtMs: partialExecutionMs,
    };
    const { deps, native, economic } = await createNativeDeps(
      {
        now: () => new Date('2026-02-25T03:15:00.000Z'),
        observeRecorder: (owner) => ({
          ...owner,

          commitExecutionFact: (fact, isLong, related, beforeCommit) => {
            const sellBefore = owner.getSellRecordByOrderId(fact.brokerOrderId);
            owner.commitExecutionFact(fact, isLong, related, beforeCommit);
            const sellAfter = owner.getSellRecordByOrderId(fact.brokerOrderId);
            if (fact.side === 'SELL' && economicProjectionChanged([sellBefore], [sellAfter]))
              economicSellCommits.push({
                relatedBuyOrderIds: related.length === 0 ? null : [...related],
              });
          },
        }),
        observeDaily: (owner) => ({
          ...owner,
          recordCumulativeExecution: (input, beforeCommit) => {
            dailyLossFacts.push(input);
            return owner.recordCumulativeExecution(input, beforeCommit);
          },
        }),
        onRecordSettlementRefreshNeed: (need) => {
          refreshNeeds.push(need);
        },
      },
      frame,
    );
    const buyFrames = [
      {
        ...frame,
        orderId: 'BUY-A',
        side: 'BUY' as const,
        status: 'Filled' as const,
        quantity: '70',
        executedQuantity: '70',
        submittedPrice: '1',
        executedPrice: '1',
        submittedAtMs: Date.parse('2026-02-25T03:00:00.000Z'),
        executionTimeMs: Date.parse('2026-02-25T03:00:00.000Z'),
        updatedAtMs: Date.parse('2026-02-25T03:00:00.000Z'),
      },
      {
        ...frame,
        orderId: 'BUY-B',
        side: 'BUY' as const,
        status: 'Filled' as const,
        quantity: '70',
        executedQuantity: '70',
        submittedPrice: '1.2',
        executedPrice: '1.2',
        submittedAtMs: Date.parse('2026-02-25T03:05:00.000Z'),
        executionTimeMs: Date.parse('2026-02-25T03:05:00.000Z'),
        updatedAtMs: Date.parse('2026-02-25T03:05:00.000Z'),
      },
    ];
    native.setOrderDetailReplies(buyFrames);
;
    for (const buy of buyFrames) {
      const [observation] = await native.createQueryOrdersReader(buy.orderId)();
      if (observation === undefined) throw new Error('real BUY seed missing');

      economic.flow.recordCumulativeExecution({
        orderId: observation.orderId,
        symbol: observation.symbol,
        side: observation.executionSide,
        factStage: observation.executionPhase,
        monitorSymbol: 'HSI.HK',
        isLongSymbol: true,
        isProtectiveLiquidation: false,
        executedQuantity: observation.executedQuantity,
        executedAmount: observation.executedAmount!,
        executedPrice: observation.executedPrice!,
        executedTimeMs: observation.executionTimeMs,
        orderUpdatedAtMs: observation.updatedAtMs,
      });
    }

    // Original expectations below observe only the SELL, after actual BUY economics are established.
    dailyLossFacts.length = 0;
    refreshNeeds.length = 0;
    const monitor = native.createMonitor(deps);
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    economic.recorder.submitSellOrder(
      frame.orderId,
      'BULL.HK',
      'LONG',
      140,
      ['BUY-A', 'BUY-B'],
      frame.submittedAtMs,
    );

    monitor.trackOrder({
      orderId: frame.orderId,
      symbol: frame.symbol,
      side: native.queryObservation.executionSide,
      executionSide: native.queryObservation.executionSide,
      price: '1',
      initialSubmittedPrice: '1',
      quantity: 140,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: native.queryObservation.orderType,
    });
    native.emitOrderChangedFrame(frame);
    await waitForCondition(
      () => dailyLossFacts.length === 1,
      'original partial SELL economics did not arrive',
      80,
    );

    for (let i = 0; i < 10; i++) await flushMicrotasks();

    native.emitOrderChangedFrame({ ...frame, status: 'Canceled', updatedAtMs: terminalRevisionMs });
    await waitForCondition(
      () => monitor.getPendingSellOrders('BULL.HK').length === 0,
      'original terminal SELL did not release resources',
      80,
    );
    const firstTerminalGeneration = economic.snapshot.getView().token.snapshotGeneration;

    await monitor.stopRuntimeAndDrain();
    expect(economicSellCommits).toHaveLength(1);
    expect(economicSellCommits[0]?.relatedBuyOrderIds).toBeNull();
    expect(refreshNeeds).toEqual([
      { refreshAccount: true, refreshPositions: true },
      { refreshAccount: true, refreshPositions: true },
    ]);

    expect(economic.recorder.getCostBasis('BULL.HK', true)).toEqual({
      costAmount: '84',
      quantity: 70,
    });

    expect(economic.recorder.getSellRecordByOrderId(frame.orderId)).toMatchObject({
      costAmount: '105',
      executedQuantity: 100,
      executedTime: partialExecutionMs,
    });
    expect(economic.recorder.getPendingSellSnapshot()).toEqual([]);
    expect(economic.holds.getHoldSymbols().has('BULL.HK')).toBe(false);
    expect(economic.snapshot.getView().token.snapshotGeneration).toBe(firstTerminalGeneration);
    expect(economic.termination.isTerminated()).toBe(false);
  });

  it('cleans tracked order when cancel returns already-canceled (601011) and orderDetail confirms terminal', async () => {
    const runtimeTimers = createRuntimeTimerHarness(Date.parse('2026-02-25T03:00:00.000Z'));
    try {
      const frame = {
        orderId: 'BUY-TIMEOUT-601011',
        symbol: 'BULL.HK',
        stockName: 'HSI RC',
        remark: '',
        side: 'BUY' as const,
        status: 'Canceled' as const,
        orderType: 'ELO' as const,
        quantity: '100',
        executedQuantity: '0',
        submittedPrice: '1',
        executedPrice: '0',
        submittedAtMs: Date.parse('2026-02-25T03:00:00.000Z'),
        executionTimeMs: null,
        updatedAtMs: Date.parse('2026-02-25T03:00:05.000Z'),
      };
      const { deps, native, economic } = await createNativeDeps(
        {
          now: runtimeTimers.now,
          buyTimeoutSeconds: 0,
          sellTimeoutSeconds: 999,
        },
        frame,
      );
      native.setCancelFailure(new Error('openapi error: code=601011: Order has been cancelled'));

      native.setOrderDetailReplies([frame]);
      const monitor = native.createMonitor(deps);
      await monitor.initialize();
      await monitor.recoverOrderTrackingFromSnapshot([]);
      monitor.startRuntime();

      monitor.trackOrder({
        orderId: 'BUY-TIMEOUT-601011',
        symbol: 'BULL.HK',
        side: 'BUY',
        executionSide: 'BUY',
        price: '1',
        initialSubmittedPrice: '1',
        quantity: 100,
        isLongSymbol: true,
        monitorSymbol: 'HSI.HK',
        isProtectiveLiquidation: false,
        orderType: 'ELO',
      });
      await flushMicrotasks();

      expect(Array.from({ length: native.nativeReadCounts().cancel })).toHaveLength(1);
      expect(Array.from({ length: native.nativeReadCounts().detail })).toHaveLength(0);

      await runtimeTimers.advanceBy(2_000);

      expect(Array.from({ length: native.nativeReadCounts().cancel })).toHaveLength(1);
      expect(Array.from({ length: native.nativeReadCounts().detail })).toHaveLength(1);
      expect(economic.recorder.getExecutionFact(frame.orderId)).toBeNull();
      await monitor.stopRuntimeAndDrain();
    } finally {
      runtimeTimers.restore();
    }
  });

  it('runtime 会在 602013 backoff 到期后自动补跑 replace，无需新 quote', async () => {
    const frame = {
      orderId: 'SELL-REPLACE-RETRY-TIMER',
      symbol: 'BULL.HK',
      stockName: 'HSI RC',
      remark: '',
      side: 'SELL' as const,
      status: 'New' as const,
      orderType: 'ELO' as const,
      quantity: '100',
      executedQuantity: '0',
      submittedPrice: '1',
      executedPrice: '0',
      submittedAtMs: Date.now() - 1,
      executionTimeMs: null,
      updatedAtMs: Date.now(),
    };
    const caller: { isCurrent?: () => boolean } = {};
    const { deps, native, economic, setQuotes, emitQuoteUpdated } = await createNativeDeps(
      {
        continuousTradingOpen: () => caller.isCurrent?.() ?? false,

        sellTimeoutSeconds: 999,
        buyTimeoutSeconds: 999,
      },
      frame,
    );
    native.setAccountBalance({
      currency: 'HKD',
      totalCash: '100000',
      netAssets: '100000',
      availableCash: '100000',
    });
    native.setStockPositions([]);
    const receipt = await economic.snapshot.requestRefresh({
      source: 'NATIVE-RETRY-TIMER',
      dayEpoch: 1,
      refreshAccount: true,
      refreshPositions: true,
    }).result;
    if (receipt.status !== 'COMMITTED')
      throw new Error('retry case requires actual issued paired authority');

    const captured = receipt.snapshotToken;
    caller.isCurrent = () =>
      economic.snapshot.isCurrent(captured, { account: true, positions: true, paired: true });
    setQuotes(new Map([['BULL.HK', createQuoteDouble('BULL.HK', '1')]]));
    let attempts = 0;
    native.setReplaceBeforeReply(async () => {
      if (++attempts === 1)
        throw new Error('openapi error: code=602013: status does not allow amendment');
    });
    const monitor = native.createMonitor(deps);
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.startRuntime();

    monitor.trackOrder({
      orderId: 'SELL-REPLACE-RETRY-TIMER',
      symbol: 'BULL.HK',
      side: 'SELL',
      executionSide: 'SELL',
      price: '1',
      initialSubmittedPrice: '1',
      quantity: 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: 'ELO',
    });
    await flushMicrotasks();

    await emitQuoteUpdated({
      symbol: 'BULL.HK',
      quote: createQuoteDouble('BULL.HK', '1.02'),
    });

    expect(native.nativeMutations().filter((m) => m.kind === 'REPLACE')).toHaveLength(1);

    await waitForConditionWithDelay(
      () => native.nativeMutations().filter((m) => m.kind === 'REPLACE').length === 2,
      '[测试] 预期 602013 backoff 到期后 runtime 自动补跑 replace，但第二次 replace 未发生',
      260,
      5,
    );
    await monitor.stopRuntimeAndDrain();
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

    const frame = {
      orderId: 'SELL-QUOTE-RETRY-RUNTIME',
      symbol: 'BULL.HK',
      stockName: 'HSI RC',
      remark: '',
      side: 'SELL' as const,
      status: 'New' as const,
      orderType: 'ELO' as const,
      quantity: '100',
      executedQuantity: '0',
      submittedPrice: '1',
      executedPrice: '0',
      submittedAtMs: Date.now() - 1,
      executionTimeMs: null,
      updatedAtMs: Date.now(),
    };
    const caller: { isCurrent?: () => boolean } = {};
    const { deps, native, economic, setQuotes, emitQuoteUpdated } = await createNativeDeps(
      {
        continuousTradingOpen: () => caller.isCurrent?.() ?? false,

        sellTimeoutSeconds: 999,
        buyTimeoutSeconds: 999,
      },
      frame,
    );
    native.setAccountBalance({
      currency: 'HKD',
      totalCash: '100000',
      netAssets: '100000',
      availableCash: '100000',
    });
    native.setStockPositions([]);
    const receipt = await economic.snapshot.requestRefresh({
      source: 'NATIVE-RETRY-TIMER',
      dayEpoch: 1,
      refreshAccount: true,
      refreshPositions: true,
    }).result;
    if (receipt.status !== 'COMMITTED')
      throw new Error('retry case requires actual issued paired authority');

    const captured = receipt.snapshotToken;
    caller.isCurrent = () =>
      economic.snapshot.isCurrent(captured, { account: true, positions: true, paired: true });
    setQuotes(new Map([['BULL.HK', createQuoteDouble('BULL.HK', '1')]]));
    const monitor = native.createMonitor(deps);

    try {
      await monitor.initialize();
      await monitor.recoverOrderTrackingFromSnapshot([]);
      monitor.startRuntime();

      monitor.trackOrder({
        orderId: 'SELL-QUOTE-RETRY-RUNTIME',
        symbol: 'BULL.HK',
        side: 'SELL',
        executionSide: 'SELL',
        price: '1',
        initialSubmittedPrice: '1',
        quantity: 100,
        isLongSymbol: true,
        monitorSymbol: 'HSI.HK',
        isProtectiveLiquidation: false,
        orderType: 'ELO',
      });
      await flushMicrotasks();

      await emitQuoteUpdated({
        symbol: 'BULL.HK',
        quote: createQuoteDouble('BULL.HK', '0'),
      });

      for (let attempt = 0; attempt < 5; attempt += 1) {
        await advanceRuntimeTimersBy(2_000);
      }

      await emitQuoteUpdated({
        symbol: 'BULL.HK',
        quote: createQuoteDouble('BULL.HK', '1.05'),
      });

      expect(native.nativeMutations().filter((m) => m.kind === 'REPLACE')).toHaveLength(1);
      expect(monitor.getPendingSellOrders('BULL.HK')).toHaveLength(1);
      expect(monitor.getPendingSellOrders('BULL.HK')[0]?.orderId).toBe('SELL-QUOTE-RETRY-RUNTIME');
    } finally {
      await monitor.stopRuntimeAndDrain();
      Date.now = originalNow;
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });

  it('重复 initialize 不会把已 ACTIVE 的 runtime 打回 BOOTSTRAPPING', async () => {
    const runtimeTimers = createRuntimeTimerHarness(Date.parse('2026-04-10T09:30:00.000Z'));

    try {
      const frame = {
        orderId: 'BUY-INITIALIZE-ACTIVE-SHOULD-STAY-ACTIVE',
        symbol: 'BULL.HK',
        stockName: 'HSI RC',
        remark: '',
        side: 'BUY' as const,
        status: 'New' as const,
        orderType: 'ELO' as const,
        quantity: '100',
        executedQuantity: '0',
        submittedPrice: '1',
        executedPrice: '0',
        submittedAtMs: Date.now() - 10000,
        executionTimeMs: null,
        updatedAtMs: Date.now(),
      };
      const { deps, native, economic } = await createNativeDeps(
        {
          now: runtimeTimers.now,
          sellTimeoutSeconds: 999,
          buyTimeoutSeconds: 1,
        },
        frame,
      );
      native.setCancelBeforeReply(async () => {});
      const monitor = native.createMonitor(deps);
      await monitor.initialize();
      await monitor.recoverOrderTrackingFromSnapshot([]);
      monitor.startRuntime();

      await monitor.initialize();

      monitor.trackOrder({
        orderId: 'BUY-INITIALIZE-ACTIVE-SHOULD-STAY-ACTIVE',
        symbol: 'BULL.HK',
        side: 'BUY',
        executionSide: 'BUY',
        price: '1',
        initialSubmittedPrice: '1',
        quantity: 100,
        submittedAtMs: Date.now() - 10_000,
        isLongSymbol: true,
        monitorSymbol: 'HSI.HK',
        isProtectiveLiquidation: false,
        orderType: 'ELO',
      });
      await flushMicrotasks();
      await runtimeTimers.advanceBy(0);

      expect(native.nativeReadCounts().cancel).toBe(1);
      expect(native.nativeCancelOrderIds()[0]).toBe('BUY-INITIALIZE-ACTIVE-SHOULD-STAY-ACTIVE');

      native.emitOrderChangedFrame({ ...frame, status: 'Canceled', updatedAtMs: Date.now() + 1 });
      await flushMicrotasks();

      expect(monitor.getPendingSellOrders('BULL.HK')).toHaveLength(0);
      expect(economic.holds.getHoldSymbols().has('BULL.HK')).toBe(false);
      expect(economic.recorder.getExecutionFact(frame.orderId)).toBeNull();
      expect(native.subscribeReadCount()).toBe(1);
      await monitor.stopRuntimeAndDrain();
    } finally {
      runtimeTimers.restore();
    }
  });

  it('marks 602012 as permanently unsupported and skips further replace attempts', async () => {
    const frame = {
      orderId: 'SELL-REPLACE-602012',
      symbol: 'BULL.HK',
      stockName: 'HSI RC',
      remark: '',
      side: 'SELL' as const,
      status: 'New' as const,
      orderType: 'ELO' as const,
      quantity: '100',
      executedQuantity: '0',
      submittedPrice: '1',
      executedPrice: '0',
      submittedAtMs: Date.now() - 1,
      executionTimeMs: null,
      updatedAtMs: Date.now(),
    };
    const caller: { isCurrent?: () => boolean } = {};
    const { deps, native, economic, setQuotes, emitQuoteUpdated } = await createNativeDeps(
      {
        continuousTradingOpen: () => caller.isCurrent?.() ?? false,
        sellTimeoutSeconds: 999,
        buyTimeoutSeconds: 999,
      },
      frame,
    );
    native.setAccountBalance({
      currency: 'HKD',
      totalCash: '100000',
      netAssets: '100000',
      availableCash: '100000',
    });
    native.setStockPositions([]);
    const receipt = await economic.snapshot.requestRefresh({
      source: 'NATIVE-REPLACE-CONTROL',
      dayEpoch: 1,
      refreshAccount: true,
      refreshPositions: true,
    }).result;
    if (receipt.status !== 'COMMITTED')
      throw new Error('control case requires actual paired authority');

    const captured = receipt.snapshotToken;
    caller.isCurrent = () =>
      economic.snapshot.isCurrent(captured, { account: true, positions: true, paired: true });
    setQuotes(new Map([['BULL.HK', createQuoteDouble('BULL.HK', '1')]]));
    native.failReplace(new Error('openapi error: code=602012: not supported by type'));
    const monitor = native.createMonitor(deps);
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.startRuntime();

    monitor.trackOrder({
      orderId: 'SELL-REPLACE-602012',
      symbol: 'BULL.HK',
      side: native.queryObservation.executionSide,
      executionSide: native.queryObservation.executionSide,
      price: '1',
      initialSubmittedPrice: '1',
      quantity: 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: native.queryObservation.orderType,
    });
    await flushMicrotasks();

    await emitQuoteUpdated({
      symbol: 'BULL.HK',
      quote: createQuoteDouble('BULL.HK', '1.05'),
    });

    expect(native.nativeMutations().filter((m) => m.kind === 'REPLACE')).toHaveLength(1);

    await emitQuoteUpdated({
      symbol: 'BULL.HK',
      quote: createQuoteDouble('BULL.HK', '1.06'),
    });

    expect(native.nativeMutations().filter((m) => m.kind === 'REPLACE')).toHaveLength(1);
    await monitor.stopRuntimeAndDrain();
  });

  it('marks 602013 as temporarily blocked and escalates to orderDetail on 5th consecutive hit', async () => {
    const runtimeTimers = createRuntimeTimerHarness(Date.parse('2026-02-25T03:00:00.000Z'));

    const frame = {
      orderId: 'SELL-REPLACE-602013',
      symbol: 'BULL.HK',
      stockName: 'HSI RC',
      remark: '',
      side: 'SELL' as const,
      status: 'New' as const,
      orderType: 'ELO' as const,
      quantity: '100',
      executedQuantity: '0',
      submittedPrice: '1',
      executedPrice: '0',
      submittedAtMs: Date.now() - 1000,
      executionTimeMs: null,
      updatedAtMs: Date.now(),
    };
    const caller: { isCurrent?: () => boolean } = {};
    const { deps, native, economic, emitQuoteUpdated, setQuotes } = await createNativeDeps(
      {
        now: runtimeTimers.now,
        continuousTradingOpen: () => caller.isCurrent?.() ?? false,
        sellTimeoutSeconds: 999,
        buyTimeoutSeconds: 999,
      },
      frame,
    );
    native.setAccountBalance({
      currency: 'HKD',
      totalCash: '100000',
      netAssets: '100000',
      availableCash: '100000',
    });
    native.setStockPositions([]);
    const receipt = await economic.snapshot.requestRefresh({
      source: 'NATIVE-602013',
      dayEpoch: 1,
      refreshAccount: true,
      refreshPositions: true,
    }).result;
    if (receipt.status !== 'COMMITTED')
      throw new Error('602013 retry requires actual paired receipt');

    const captured = receipt.snapshotToken;
    caller.isCurrent = () =>
      economic.snapshot.isCurrent(captured, { account: true, positions: true, paired: true });
    setQuotes(new Map([['BULL.HK', createQuoteDouble('BULL.HK', '1.02')]]));
    let replaceAttempts = 0;
    const failure = new Error('openapi error: code=602013: status does not allow amendment');
    native.setReplaceBeforeReply(async () => {
      if (++replaceAttempts <= 5) throw failure;
    });

    native.setOrderDetailReplies([{ ...frame, status: 'PendingReplace', updatedAtMs: Date.now() }]);
    const monitor = native.createMonitor(deps);
    try {
      await monitor.initialize();
      await monitor.recoverOrderTrackingFromSnapshot([]);
      monitor.startRuntime();

      monitor.trackOrder({
        orderId: 'SELL-REPLACE-602013',
        symbol: 'BULL.HK',
        side: 'SELL',
        executionSide: 'SELL',
        price: '1',
        initialSubmittedPrice: '1',
        quantity: 100,
        isLongSymbol: true,
        monitorSymbol: 'HSI.HK',
        isProtectiveLiquidation: false,
        orderType: 'ELO',
      });
      await flushMicrotasks();
      await emitQuoteUpdated({
        symbol: 'BULL.HK',
        quote: createQuoteDouble('BULL.HK', '1.05'),
      });

      await waitForCondition(
        () => native.nativeMutations().filter((m) => m.kind === 'REPLACE').length === 1,
        '首次 602013 改单未触发',
      );
      expect(native.nativeReadCounts().detail).toBe(0);

      await runtimeTimers.advanceBy(1_000);
      await waitForCondition(
        () => native.nativeMutations().filter((m) => m.kind === 'REPLACE').length === 2,
        '第 2 次 602013 改单未触发',
      );
      expect(native.nativeReadCounts().detail).toBe(0);

      await runtimeTimers.advanceBy(2_000);
      await waitForCondition(
        () => native.nativeMutations().filter((m) => m.kind === 'REPLACE').length === 3,
        '第 3 次 602013 改单未触发',
      );
      expect(native.nativeReadCounts().detail).toBe(0);

      await runtimeTimers.advanceBy(4_000);
      await waitForCondition(
        () => native.nativeMutations().filter((m) => m.kind === 'REPLACE').length === 4,
        '第 4 次 602013 改单未触发',
      );
      expect(native.nativeReadCounts().detail).toBe(0);

      await runtimeTimers.advanceBy(8_000);
      await waitForCondition(
        () => native.nativeMutations().filter((m) => m.kind === 'REPLACE').length === 5,
        '第 5 次 602013 改单未触发',
      );

      await waitForCondition(
        () => native.nativeReadCounts().detail === 1,
        '第 5 次 602013 后未升级到 orderDetail',
      );

      await runtimeTimers.advanceBy(60_000);
      expect(native.nativeMutations().filter((m) => m.kind === 'REPLACE')).toHaveLength(5);
    } finally {
      await monitor.stopRuntimeAndDrain();
      runtimeTimers.restore();
    }
  });

  it('drops a stale fifth 602013 blocking decision after WS progress has reopened replace', async () => {
    const initialNowMs = Date.parse('2026-02-25T05:00:00.000Z');
    const runtimeTimers = createRuntimeTimerHarness(initialNowMs);
    const frame = {
      orderId: 'SELL-REPLACE-602013-STALE-STATE-CHECK',
      symbol: 'BULL.HK',
      stockName: 'HSI RC',
      remark: '',
      side: 'SELL' as const,
      status: 'New' as const,
      orderType: 'ELO' as const,
      quantity: '100',
      executedQuantity: '0',
      submittedPrice: '1',
      executedPrice: '0',
      submittedAtMs: Date.now() - 1000,
      executionTimeMs: null,
      updatedAtMs: Date.now(),
    };
    const caller: { isCurrent?: () => boolean } = {};
    const { deps, native, economic, emitQuoteUpdated, setQuotes } = await createNativeDeps(
      {
        now: runtimeTimers.now,
        continuousTradingOpen: () => caller.isCurrent?.() ?? false,
        sellTimeoutSeconds: 999,
        buyTimeoutSeconds: 999,
        orderMonitorPriceUpdateIntervalSeconds: 1,
      },
      frame,
    );
    native.setAccountBalance({
      currency: 'HKD',
      totalCash: '100000',
      netAssets: '100000',
      availableCash: '100000',
    });
    native.setStockPositions([]);
    const receipt = await economic.snapshot.requestRefresh({
      source: 'NATIVE-602013',
      dayEpoch: 1,
      refreshAccount: true,
      refreshPositions: true,
    }).result;
    if (receipt.status !== 'COMMITTED')
      throw new Error('602013 retry requires actual paired receipt');

    const captured = receipt.snapshotToken;
    caller.isCurrent = () =>
      economic.snapshot.isCurrent(captured, { account: true, positions: true, paired: true });
    setQuotes(new Map([['BULL.HK', createQuoteDouble('BULL.HK', '1.02')]]));
    const stateCheckStarted = createDeferred();
    const releaseStateCheck = createDeferred();
    native.setOrderDetailBeforeReply(async () => {
      stateCheckStarted.resolve();
      await releaseStateCheck.promise;
    });

    let replaceAttempts = 0;
    const failure = new Error('openapi error: code=602013: status does not allow amendment');
    native.setReplaceBeforeReply(async () => {
      if (++replaceAttempts <= 5) throw failure;
    });

    native.setOrderDetailReplies([{ ...frame, status: 'New', updatedAtMs: Date.now() }]);
    const monitor = native.createMonitor(deps);

    try {
      await monitor.initialize();
      await monitor.recoverOrderTrackingFromSnapshot([]);
      monitor.startRuntime();
      monitor.trackOrder({
        orderId: 'SELL-REPLACE-602013-STALE-STATE-CHECK',
        symbol: 'BULL.HK',
        side: 'SELL',
        executionSide: 'SELL',
        price: '1',
        initialSubmittedPrice: '1',
        quantity: 100,
        isLongSymbol: true,
        monitorSymbol: 'HSI.HK',
        isProtectiveLiquidation: false,
        orderType: 'ELO',
      });
      await flushMicrotasks();

      await runtimeTimers.advanceBy(1_000);
      await emitQuoteUpdated({
        symbol: 'BULL.HK',
        quote: createQuoteDouble('BULL.HK', '1.05'),
      });

      await waitForCondition(
        () => native.nativeMutations().filter((m) => m.kind === 'REPLACE').length === 1,
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
          () =>
            native.nativeMutations().filter((m) => m.kind === 'REPLACE').length === expectedCalls,
          `第 ${expectedCalls} 次 602013 改单未触发`,
        );
      }

      await stateCheckStarted.promise;
      await Promise.resolve()
        .then(() => {
          expect(native.subscribeObservations()[0]).toContain('PRIVATE');
          native.emitOrderChangedFrame({
            ...frame,
            status: 'New',
            updatedAtMs: initialNowMs + 16_000,
          });
        })
        .then(() => flushMicrotasks())
        .then(() => flushMicrotasks());

      await Promise.resolve()
        .then(() => {
          expect(native.subscribeObservations()[0]).toContain('PRIVATE');
          native.emitOrderChangedFrame({
            ...frame,
            status: 'PendingReplace',
            updatedAtMs: initialNowMs + 16_001,
          });
        })
        .then(() => flushMicrotasks())
        .then(() => flushMicrotasks());

      await Promise.resolve()
        .then(() => {
          expect(native.subscribeObservations()[0]).toContain('PRIVATE');
          native.emitOrderChangedFrame({
            ...frame,
            status: 'New',
            updatedAtMs: initialNowMs + 16_002,
          });
        })
        .then(() => flushMicrotasks())
        .then(() => flushMicrotasks());

      releaseStateCheck.resolve();
      await waitForCondition(
        () => native.nativeMutations().filter((m) => m.kind === 'REPLACE').length === 6,
        'WS 已重开改单后，过期第 5 次 state-check 不应阻塞 route 自动第 6 次改单',
        100,
      );
      await flushMicrotasks();
      await flushMicrotasks();

      expect(native.nativeReadCounts().detail).toBe(1);
      expect(monitor.getPendingSellOrders('BULL.HK')).toMatchObject([
        {
          orderId: 'SELL-REPLACE-602013-STALE-STATE-CHECK',
          status: 'WORKING',
        },
      ]);
    } finally {
      await monitor.stopRuntimeAndDrain();
      runtimeTimers.restore();
    }
  });

  it('resets 602013 consecutive counter after ws status progression and re-escalates only after next 5 hits', async () => {
    const runtimeTimers = createRuntimeTimerHarness(Date.parse('2026-02-25T04:00:00.000Z'));

    const frame = {
      orderId: 'SELL-REPLACE-602013-RESET',
      symbol: 'BULL.HK',
      stockName: 'HSI RC',
      remark: '',
      side: 'SELL' as const,
      status: 'New' as const,
      orderType: 'ELO' as const,
      quantity: '100',
      executedQuantity: '0',
      submittedPrice: '1',
      executedPrice: '0',
      submittedAtMs: Date.now() - 1000,
      executionTimeMs: null,
      updatedAtMs: Date.now(),
    };
    const caller: { isCurrent?: () => boolean } = {};
    const { deps, native, economic, emitQuoteUpdated, setQuotes } = await createNativeDeps(
      {
        now: runtimeTimers.now,
        continuousTradingOpen: () => caller.isCurrent?.() ?? false,
        sellTimeoutSeconds: 999,
        buyTimeoutSeconds: 999,
      },
      frame,
    );
    native.setAccountBalance({
      currency: 'HKD',
      totalCash: '100000',
      netAssets: '100000',
      availableCash: '100000',
    });
    native.setStockPositions([]);
    const receipt = await economic.snapshot.requestRefresh({
      source: 'NATIVE-602013',
      dayEpoch: 1,
      refreshAccount: true,
      refreshPositions: true,
    }).result;
    if (receipt.status !== 'COMMITTED')
      throw new Error('602013 retry requires actual paired receipt');

    const captured = receipt.snapshotToken;
    caller.isCurrent = () =>
      economic.snapshot.isCurrent(captured, { account: true, positions: true, paired: true });
    setQuotes(new Map([['BULL.HK', createQuoteDouble('BULL.HK', '1.02')]]));
    let replaceAttempts = 0;
    const failure = new Error('openapi error: code=602013: status does not allow amendment');
    native.setReplaceBeforeReply(async () => {
      if (++replaceAttempts <= 10) throw failure;
    });

    native.setOrderDetailReplies([{ ...frame, status: 'PendingReplace', updatedAtMs: Date.now() }]);

    native.setOrderDetailReplies([
      { ...frame, status: 'PendingReplace', updatedAtMs: Date.now() },
      { ...frame, status: 'PendingReplace', updatedAtMs: Date.now() },
    ]);
    const monitor = native.createMonitor(deps);
    try {
      await monitor.initialize();
      await monitor.recoverOrderTrackingFromSnapshot([]);
      monitor.startRuntime();

      monitor.trackOrder({
        orderId: 'SELL-REPLACE-602013-RESET',
        symbol: 'BULL.HK',
        side: 'SELL',
        executionSide: 'SELL',
        price: '1',
        initialSubmittedPrice: '1',
        quantity: 100,
        isLongSymbol: true,
        monitorSymbol: 'HSI.HK',
        isProtectiveLiquidation: false,
        orderType: 'ELO',
      });
      await flushMicrotasks();
      await emitQuoteUpdated({
        symbol: 'BULL.HK',
        quote: createQuoteDouble('BULL.HK', '1.05'),
      });

      await waitForCondition(
        () => native.nativeMutations().filter((m) => m.kind === 'REPLACE').length === 1,
        '首次 602013 改单未触发',
      );

      await runtimeTimers.advanceBy(1_000);
      await waitForCondition(
        () => native.nativeMutations().filter((m) => m.kind === 'REPLACE').length === 2,
        '第 2 次 602013 改单未触发',
      );
      await runtimeTimers.advanceBy(2_000);
      await waitForCondition(
        () => native.nativeMutations().filter((m) => m.kind === 'REPLACE').length === 3,
        '第 3 次 602013 改单未触发',
      );
      await runtimeTimers.advanceBy(4_000);
      await waitForCondition(
        () => native.nativeMutations().filter((m) => m.kind === 'REPLACE').length === 4,
        '第 4 次 602013 改单未触发',
      );
      await runtimeTimers.advanceBy(8_000);
      await waitForCondition(
        () => native.nativeMutations().filter((m) => m.kind === 'REPLACE').length === 5,
        '第 5 次 602013 改单未触发',
      );

      await waitForCondition(
        () => native.nativeReadCounts().detail === 1,
        '第 5 次 602013 后未升级到 orderDetail',
      );
      await flushMicrotasks();
      await flushMicrotasks();
      await flushMicrotasks();

      await Promise.resolve()
        .then(() => {
          expect(native.subscribeObservations()[0]).toContain('PRIVATE');
          native.emitOrderChangedFrame({
            ...frame,
            status: 'PendingReplace',
            updatedAtMs: Date.now(),
          });
        })
        .then(() => flushMicrotasks())
        .then(() => flushMicrotasks());

      await Promise.resolve()
        .then(() => {
          expect(native.subscribeObservations()[0]).toContain('PRIVATE');
          native.emitOrderChangedFrame({ ...frame, status: 'New', updatedAtMs: Date.now() });
        })
        .then(() => flushMicrotasks())
        .then(() => flushMicrotasks());
      await flushMicrotasks();
      await emitQuoteUpdated({
        symbol: 'BULL.HK',
        quote: createQuoteDouble('BULL.HK', '1.06'),
      });

      await waitForCondition(
        () => native.nativeMutations().filter((m) => m.kind === 'REPLACE').length === 6,
        'WS 解锁后的首次 QUOTE 未重新触发改单',
        100,
      );

      expect(native.nativeReadCounts().detail).toBe(1);

      await runtimeTimers.advanceBy(1_000);
      await waitForCondition(
        () => native.nativeMutations().filter((m) => m.kind === 'REPLACE').length === 7,
        '重置后第 2 次 602013 改单未触发',
        100,
      );
      await runtimeTimers.advanceBy(2_000);
      await waitForCondition(
        () => native.nativeMutations().filter((m) => m.kind === 'REPLACE').length === 8,
        '重置后第 3 次 602013 改单未触发',
        100,
      );
      await runtimeTimers.advanceBy(4_000);
      await waitForCondition(
        () => native.nativeMutations().filter((m) => m.kind === 'REPLACE').length === 9,
        '重置后第 4 次 602013 改单未触发',
        100,
      );
      await runtimeTimers.advanceBy(8_000);
      await waitForCondition(
        () => native.nativeMutations().filter((m) => m.kind === 'REPLACE').length === 10,
        '重置后第 5 次 602013 改单未触发',
        100,
      );

      await waitForCondition(
        () => native.nativeReadCounts().detail === 2,
        '重置后第 5 次 602013 未再次升级到 orderDetail',
        100,
      );
    } finally {
      await monitor.stopRuntimeAndDrain();
      runtimeTimers.restore();
    }
  });

  it('public cancelOrder settles state-checked sell close and returns remaining related buy order ids', async () => {
    const terminalMs = Date.parse('2026-02-25T03:11:00.000Z');
    const frame = {
      orderId: 'SELL-CANCEL-SETTLED',
      symbol: 'BULL.HK',
      stockName: 'HSI RC',
      remark: '',
      side: 'SELL' as const,
      status: 'PartialWithdrawal' as const,
      orderType: 'ELO' as const,
      quantity: '200',
      executedQuantity: '100',
      submittedPrice: '1',
      executedPrice: '1.05',
      submittedAtMs: Date.parse('2026-02-25T03:06:00.000Z'),
      executionTimeMs: terminalMs,
      updatedAtMs: terminalMs,
    };
    const economicSellCommits: Array<readonly string[] | null> = [];
    const refreshNeeds: Array<{
      readonly refreshAccount: boolean;
      readonly refreshPositions: boolean;
    }> = [];
    const { deps, native, economic } = await createNativeDeps(
      {
        now: () => new Date(terminalMs + 1000),
        observeRecorder: (owner) => ({
          ...owner,
          commitExecutionFact: (fact, isLong, related, beforeCommit) => {
            const sellBefore = owner.getSellRecordByOrderId(fact.brokerOrderId);
            owner.commitExecutionFact(fact, isLong, related, beforeCommit);
            const sellAfter = owner.getSellRecordByOrderId(fact.brokerOrderId);
            if (fact.side === 'SELL' && economicProjectionChanged([sellBefore], [sellAfter]))
              economicSellCommits.push(related.length === 0 ? null : [...related]);
          },
        }),
        onRecordSettlementRefreshNeed: (need) => {
          refreshNeeds.push(need);
        },
      },
      frame,
    );
    const buyFrames = [
      {
        ...frame,
        orderId: 'BUY-1',
        side: 'BUY' as const,
        status: 'Filled' as const,
        quantity: '100',
        executedQuantity: '100',
        submittedPrice: '1',
        executedPrice: '1',
        submittedAtMs: Date.parse('2026-02-25T03:00:00.000Z'),
        executionTimeMs: Date.parse('2026-02-25T03:00:00.000Z'),
        updatedAtMs: Date.parse('2026-02-25T03:00:00.000Z'),
      },
      {
        ...frame,
        orderId: 'BUY-2',
        side: 'BUY' as const,
        status: 'Filled' as const,
        quantity: '100',
        executedQuantity: '100',
        submittedPrice: '1.2',
        executedPrice: '1.2',
        submittedAtMs: Date.parse('2026-02-25T03:05:00.000Z'),
        executionTimeMs: Date.parse('2026-02-25T03:05:00.000Z'),
        updatedAtMs: Date.parse('2026-02-25T03:05:00.000Z'),
      },
    ];
    native.setOrderDetailReplies(buyFrames);
;
    for (const buy of buyFrames) {
      const [observation] = await native.createQueryOrdersReader(buy.orderId)();
      if (observation === undefined) throw new Error('real BUY seed missing');

      economic.flow.recordCumulativeExecution({
        orderId: observation.orderId,
        symbol: observation.symbol,
        side: observation.executionSide,
        factStage: observation.executionPhase,
        monitorSymbol: 'HSI.HK',
        isLongSymbol: true,
        isProtectiveLiquidation: false,
        executedQuantity: observation.executedQuantity,
        executedAmount: observation.executedAmount!,
        executedPrice: observation.executedPrice!,
        executedTimeMs: observation.executionTimeMs,
        orderUpdatedAtMs: observation.updatedAtMs,
      });
    }

    // Original expectations below observe only the SELL, after actual BUY economics are established.
    refreshNeeds.length = 0;
    native.setCancelFailure(new Error('openapi error: code=603001: Order not found'));
    native.setOrderDetailReplies([frame]);
    const readBaseline = native.nativeReadCounts();
    const monitor = native.createMonitor(deps);
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    economic.recorder.submitSellOrder(
      frame.orderId,
      'BULL.HK',
      'LONG',
      200,
      ['BUY-1', 'BUY-2'],
      frame.submittedAtMs,
    );

    monitor.trackOrder({
      orderId: frame.orderId,
      symbol: frame.symbol,
      side: native.queryObservation.executionSide,
      executionSide: native.queryObservation.executionSide,
      price: '1',
      initialSubmittedPrice: '1',
      quantity: 200,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: native.queryObservation.orderType,
    });
    const outcome = await monitor.cancelOrder(frame.orderId, { kind: 'ORDER_FACT' });
    expect(outcome.kind).toBe('ALREADY_CLOSED');
    if (outcome.kind === 'ALREADY_CLOSED') {
      expect(outcome.closedReason).toBe('CANCELED');
      expect(outcome.relatedBuyOrderIds).toEqual(['BUY-2']);
    }

    expect(economicSellCommits).toEqual([['BUY-1']]);
    expect(native.nativeReadCounts().detail - readBaseline.detail).toBe(1);
    expect(monitor.getPendingSellOrders('BULL.HK')).toHaveLength(0);
    expect(refreshNeeds).toEqual([
      {
        refreshAccount: true,
        refreshPositions: true,
      },
    ]);

    expect(economic.recorder.getCostBasis('BULL.HK', true)).toEqual({
      costAmount: '120',
      quantity: 100,
    });

    expect(economic.recorder.getSellRecordByOrderId(frame.orderId)).toMatchObject({
      costAmount: '105',
      executedQuantity: 100,
      executedTime: terminalMs,
    });
    expect(economic.recorder.getPendingSellSnapshot()).toEqual([]);
    expect(economic.holds.getHoldSymbols().has('BULL.HK')).toBe(false);
  });

  it('public cancelOrder 不会让陈旧终态否认 tracked 已知成交', async () => {
    const localBuyCalls: Array<
      Readonly<{ costAmount: string; executedQuantity: number; executedTimeMs: number }>
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
    const executionMs = Date.parse('2026-02-25T03:11:00.200Z');
    const staleMs = Date.parse('2026-02-25T03:11:00.100Z');
    const frame = {
      orderId: 'BUY-PUBLIC-CANCEL-STALE-TERMINAL',
      symbol: 'BULL.HK',
      stockName: 'HSI RC',
      remark: '',
      side: 'BUY' as const,
      status: 'PartialFilled' as const,
      orderType: 'ELO' as const,
      quantity: '100',
      executedQuantity: '50',
      submittedPrice: '1',
      executedPrice: '1.05',
      submittedAtMs: executionMs - 1000,
      executionTimeMs: executionMs,
      updatedAtMs: executionMs,
    };
    const { deps, native, economic } = await createNativeDeps(
      {
        now: () => new Date(executionMs + 1000),
        observeRecorder: (owner) => ({
          ...owner,
          commitExecutionFact: (fact, isLong, related, beforeCommit) => {
            const buyBefore = owner.getBuyOrdersForSymbol(fact.symbol, isLong);
            owner.commitExecutionFact(fact, isLong, related, beforeCommit);
            const buyAfter = owner.getBuyOrdersForSymbol(fact.symbol, isLong);
            if (
              fact.side === 'BUY' &&
              fact.phase === 'TERMINAL' &&
              economicProjectionChanged(buyBefore, buyAfter)
            ) {
              if (fact.executionTimeMs === null)
                throw new Error('accepted BUY must retain execution time');

              localBuyCalls.push({
                costAmount: fact.cumulativeAmount,
                executedQuantity: fact.cumulativeQuantity,
                executedTimeMs: fact.executionTimeMs,
              });
            }
          },
        }),
        observeDaily: (owner) => ({
          ...owner,
          recordCumulativeExecution: (input, beforeAuthoritativeFactCommit) => {
            dailyLossCalls.push(input);
            return owner.recordCumulativeExecution(input, beforeAuthoritativeFactCommit);
          },
        }),
      },
      frame,
    );
    native.setCancelFailure(new Error('openapi error: code=601011: Order already cancelled'));
    const staleFrame = {
      ...frame,
      status: 'PartialWithdrawal' as const,
      executedQuantity: '20',
      executedPrice: '0.9',
      executionTimeMs: staleMs,
      updatedAtMs: staleMs,
    };
    native.setOrderDetailReplies([staleFrame]);
    const monitor = native.createMonitor(deps);
    monitor.onOrderStateChanged((event) => {
      orderStateEvents.push(event);
    });
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.trackOrder({
      orderId: 'BUY-PUBLIC-CANCEL-STALE-TERMINAL',
      symbol: 'BULL.HK',
      side: native.queryObservation.executionSide,
      executionSide: native.queryObservation.executionSide,
      price: '1',
      initialSubmittedPrice: '1',
      quantity: 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: native.queryObservation.orderType,
    });

    native.emitOrderChangedFrame(frame);
    await waitForCondition(
      () => dailyLossCalls.length === 1,
      'actual native OPEN baseline did not arrive',
      80,
    );

    // The broker returns its old cumulative20 detail and independent earlier ledger rows.
    // Confirmed tracked50 keeps its own real amount/T/revision, not a timestamp from this stale detail.
    const outcome = await monitor.cancelOrder('BUY-PUBLIC-CANCEL-STALE-TERMINAL', {
      kind: 'ORDER_FACT',
    });

    expect(outcome.kind).toBe('ALREADY_CLOSED');
    expect(localBuyCalls).toEqual([
      {
        costAmount: '52.5',
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
        executedPrice: '1.05',
        executedQuantity: 50,
        executedTimeMs: Date.parse('2026-02-25T03:11:00.200Z'),
      },
    ]);
    expect(native.nativeReadCounts()).toEqual({ cancel: 1, detail: 1 });
    expect(economic.recorder.getCostBasis('BULL.HK', true)).toEqual({
      costAmount: '52.5',
      quantity: 50,
    });

    expect(economic.recorder.getExecutionFact(frame.orderId)).toMatchObject({
      cumulativeAmount: '52.5',
      cumulativeQuantity: 50,
      executionTimeMs: executionMs,
      updatedAtMs: executionMs,
    });
  });

  it('public cancelOrder returns already-closed for untracked filled order (601012)', async () => {
    const frame = {
      orderId: 'UNTRACKED-601012-FILLED',
      symbol: 'BULL.HK',
      stockName: 'HSI RC',
      remark: '',
      side: 'SELL' as const,
      status: 'Filled' as const,
      orderType: 'ELO' as const,
      quantity: '100',
      executedQuantity: '100',
      submittedPrice: '1',
      executedPrice: '1.03',
      submittedAtMs: Date.parse('2026-02-25T03:00:00.000Z'),
      executionTimeMs: Date.parse('2026-02-25T03:00:10.000Z'),
      updatedAtMs: Date.parse('2026-02-25T03:00:10.000Z'),
    };
    const { deps, native } = await createNativeDeps({}, frame);
    native.setCancelBeforeReply(async () => {});
    native.setCancelFailure(new Error('openapi error: code=601012: Order has been filled'));
    native.setOrderDetailReplies([frame]);
    const monitor = native.createMonitor(deps);
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

    expect(native.nativeReadCounts().detail).toBe(1);
  });

  it('keeps close sink in state-check path from refreshing all orders on 603001 and does not submit market sell', async () => {
    let fetchAllOrdersCalls = 0;
    const runtimeTimers = createRuntimeTimerHarness(Date.parse('2026-02-25T05:00:00.000Z'));
    const atMs = Date.parse('2026-02-25T05:00:00.000Z');
    const frame = {
      orderId: 'SELL-NOT-FOUND-CLOSE-SYNC',
      symbol: 'BULL.HK',
      stockName: 'HSI RC',
      remark: '',
      side: 'SELL' as const,
      status: 'New' as const,
      orderType: 'ELO' as const,
      quantity: '100',
      executedQuantity: '0',
      submittedPrice: '1',
      executedPrice: '0',
      submittedAtMs: atMs - 1000,
      executionTimeMs: null,
      updatedAtMs: atMs,
    };
    const { deps, native } = await createNativeDeps(
      {
        now: runtimeTimers.now,
        sellTimeoutSeconds: 0,
        buyTimeoutSeconds: 999,
        observeRecorder: (owner) => ({
          ...owner,
          fetchAllOrdersFromAPI: async (...args) => {
            fetchAllOrdersCalls += 1;
            return owner.fetchAllOrdersFromAPI(...args);
          },
        }),
      },
      frame,
    );
    native.setCancelFailure(new Error('openapi error: code=603001: Order not found'));
    const monitor = native.createMonitor(deps);
    try {
      await monitor.initialize();
      await monitor.recoverOrderTrackingFromSnapshot([]);
      monitor.startRuntime();

      monitor.trackOrder({
        orderId: 'SELL-NOT-FOUND-CLOSE-SYNC',
        symbol: 'BULL.HK',
        side: 'SELL',
        executionSide: 'SELL',
        price: '1',
        initialSubmittedPrice: '1',
        quantity: 100,
        isLongSymbol: true,
        monitorSymbol: 'HSI.HK',
        isProtectiveLiquidation: false,
        orderType: 'ELO',
      });
      await flushMicrotasks();

      expect(native.nativeReadCounts().cancel).toBe(1);
      expect(native.nativeReadCounts().detail).toBe(0);

      await runtimeTimers.advanceBy(2_000);

      expect(fetchAllOrdersCalls).toBe(0);
      expect(native.nativeReadCounts().cancel).toBe(1);
      expect(native.nativeReadCounts().detail).toBe(1);
      expect(native.nativeSubmitObservations()).toHaveLength(0);
      expect(native.orderSnapshotReadCounts()).toEqual({ history: 0, today: 0 });
      await monitor.stopRuntimeAndDrain();
    } finally {
      runtimeTimers.restore();
    }
  });

  it('keeps close sink idempotent when duplicate filled events are received and emits one order state event', async () => {
    let localBuyCount = 0;
    const orderStateEvents: OrderStateChangedEvent[] = [];
    const executionMs = Date.now();
    const revisionMs = Date.now();
    const frame = {
      orderId: 'BUY-DUP-FILLED',
      symbol: 'BULL.HK',
      stockName: 'HSI RC',
      remark: '',
      side: 'BUY' as const,
      status: 'Filled' as const,
      orderType: 'ELO' as const,
      quantity: '100',
      executedQuantity: '100',
      submittedPrice: '1',
      executedPrice: '1',
      submittedAtMs: executionMs - 1000,
      executionTimeMs: executionMs,
      updatedAtMs: revisionMs,
    };
    const { deps, native, economic } = await createNativeDeps(
      {
        observeRecorder: (owner) => ({
          ...owner,
          commitExecutionFact: (fact, isLong, related, beforeCommit) => {
            const buyBefore = owner.getBuyOrdersForSymbol(fact.symbol, isLong);
            owner.commitExecutionFact(fact, isLong, related, beforeCommit);
            const buyAfter = owner.getBuyOrdersForSymbol(fact.symbol, isLong);
            if (
              fact.side === 'BUY' &&
              fact.phase === 'TERMINAL' &&
              economicProjectionChanged(buyBefore, buyAfter)
            ) {
              localBuyCount += 1;
            }
          },
        }),
      },
      frame,
    );

    const monitor = native.createMonitor(deps);
    monitor.onOrderStateChanged((event) => {
      orderStateEvents.push(event);
    });
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);

    monitor.trackOrder({
      orderId: 'BUY-DUP-FILLED',
      symbol: 'BULL.HK',
      side: native.queryObservation.executionSide,
      executionSide: native.queryObservation.executionSide,
      price: '1',
      initialSubmittedPrice: '1',
      quantity: 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: native.queryObservation.orderType,
    });

    const before = economic.snapshot.getView().token.snapshotGeneration;
    native.emitOrderChangedFrame(frame);
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();
    await waitForCondition(
      () => localBuyCount === 1,
      'registered native ingress did not commit BUY',
      40,
    );
    const afterFirst = economic.snapshot.getView().token.snapshotGeneration;
    native.emitOrderChangedFrame(frame);
    await waitForCondition(
      () => true,
      'removed IO assertion',
      60,
    );

    for (let index = 0; index < 10; index++) await flushMicrotasks();

    await monitor.stopRuntimeAndDrain();

    expect(localBuyCount).toBe(1);
    expect(orderStateEvents).toHaveLength(1);
    expect(orderStateEvents[0]).toMatchObject({
      orderId: 'BUY-DUP-FILLED',
      symbol: 'BULL.HK',
      side: 'BUY',
      status: 'FILLED',
      monitorSymbol: 'HSI.HK',
      isLongSymbol: true,
      isProtectiveLiquidation: false,
      executedPrice: '1',
      executedQuantity: 100,
    });
    expect(typeof orderStateEvents[0]?.executedTimeMs).toBe('number');
    expect(orderStateEvents[0]?.executedTimeMs).toBe(executionMs);
    expect(economic.recorder.getCostBasis('BULL.HK', true)).toEqual({
      costAmount: '100',
      quantity: 100,
    });

    expect(afterFirst).toBe(before + 1);
    expect(economic.snapshot.getView().token.snapshotGeneration).toBe(afterFirst);
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
    const frame = {
      orderId: 'BUY-PARTIAL-WITHDRAWAL',
      symbol: 'BULL.HK',
      stockName: 'HSI RC',
      remark: '',
      side: 'BUY' as const,
      status: 'PartialWithdrawal' as const,
      orderType: 'ELO' as const,
      quantity: '100',
      executedQuantity: '20',
      submittedPrice: '1',
      executedPrice: '1.01',
      submittedAtMs: Date.parse('2026-02-25T03:00:00.000Z'),
      executionTimeMs: terminalExecutionMs,
      updatedAtMs: terminalExecutionMs,
    };
    const { deps, native, economic } = await createNativeDeps(
      {
        now: () => new Date(terminalExecutionMs + 1000),
        observeRecorder: (owner) => ({
          ...owner,
          commitExecutionFact: (fact, isLong, related, beforeCommit) => {
            const buyBefore = owner.getBuyOrdersForSymbol(fact.symbol, isLong);
            owner.commitExecutionFact(fact, isLong, related, beforeCommit);
            const buyAfter = owner.getBuyOrdersForSymbol(fact.symbol, isLong);
            if (
              fact.side === 'BUY' &&
              fact.phase === 'TERMINAL' &&
              economicProjectionChanged(buyBefore, buyAfter)
            ) {
              localBuyCount += 1;
            }
          },
        }),
        observeDaily: (owner) => ({
          ...owner,
          recordCumulativeExecution: (input, beforeAuthoritativeFactCommit) => {
            dailyLossFacts.push(input);
            return owner.recordCumulativeExecution(input, beforeAuthoritativeFactCommit);
          },
        }),
        onRecordSettlementRefreshNeed: (need) => {
          refreshNeeds.push(need);
        },
      },
      frame,
    );
    const monitor = native.createMonitor(deps);
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);

    monitor.trackOrder({
      orderId: 'BUY-PARTIAL-WITHDRAWAL',
      symbol: 'BULL.HK',
      side: native.queryObservation.executionSide,
      executionSide: native.queryObservation.executionSide,
      price: '1',
      initialSubmittedPrice: '1',
      quantity: 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: native.queryObservation.orderType,
    });

    native.emitOrderChangedFrame(frame);
    await waitForCondition(
      () => localBuyCount === 1,
      'native partial-withdrawal did not commit original quantity',
      60,
    );
    const generation = economic.snapshot.getView().token.snapshotGeneration;
    native.emitOrderChangedFrame({ ...frame, updatedAtMs: duplicateTerminalRevisionMs });
    await waitForCondition(
      () => true,
      'removed IO assertion',
      60,
    );

    for (let index = 0; index < 10; index++) await flushMicrotasks();

    await monitor.stopRuntimeAndDrain();

    expect(localBuyCount).toBe(1);
    expect(dailyLossFacts).toEqual(
      [terminalExecutionMs, duplicateTerminalRevisionMs].map((orderUpdatedAtMs) => ({
        factStage: 'TERMINAL',
        direction: 'LONG',
        symbol: 'BULL.HK',
        side: 'BUY',
        executedPrice: '1.01',
        executedQuantity: 20,
        executedTimeMs: terminalExecutionMs,
        orderUpdatedAtMs,
        orderId: 'BUY-PARTIAL-WITHDRAWAL',
      })),
    );


    expect(refreshNeeds).toEqual([
      {
        refreshAccount: true,
        refreshPositions: true,
      },
    ]);

    expect(economic.recorder.getCostBasis('BULL.HK', true)).toEqual({
      costAmount: '20.2',
      quantity: 20,
    });
    expect(economic.snapshot.getView().token.snapshotGeneration).toBe(generation);
    expect(economic.termination.isTerminated()).toBe(false);
  });

  it('does not treat zero-price quote as ready for replace flow', async () => {
    const now = Date.now();
    const frame = {
      orderId: 'BUY-ZERO-PRICE-QUOTE',
      symbol: 'BULL.HK',
      stockName: 'HSI RC',
      remark: '',
      side: 'BUY' as const,
      status: 'New' as const,
      orderType: 'ELO' as const,
      quantity: '100',
      executedQuantity: '0',
      submittedPrice: '1',
      executedPrice: '0',
      submittedAtMs: now - 1,
      executionTimeMs: null,
      updatedAtMs: now,
    };
    const caller: { isCurrent?: () => boolean } = {};
    const { deps, native, economic, setQuotes } = await createNativeDeps(
      {
        continuousTradingOpen: () => caller.isCurrent?.() ?? false,
        sellTimeoutSeconds: 999,
        buyTimeoutSeconds: 999,
      },
      frame,
    );
    native.setAccountBalance({
      currency: 'HKD',
      totalCash: '100000',
      netAssets: '100000',
      availableCash: '100000',
    });
    native.setStockPositions([]);
    const authority = await economic.snapshot.requestRefresh({
      source: 'MONITOR-NATIVE-ZERO-QUOTE-CASE',
      dayEpoch: 1,
      refreshAccount: true,
      refreshPositions: true,
    }).result;
    if (authority.status !== 'COMMITTED')
      throw new Error('zero-quote test requires independently ready native paired snapshot');

    const captured = authority.snapshotToken;
    caller.isCurrent = () =>
      economic.snapshot.isCurrent(captured, { account: true, positions: true, paired: true });
    expect(caller.isCurrent()).toBe(true);
    setQuotes(new Map([['BULL.HK', createQuoteDouble('BULL.HK', '0', 100)]]));

    const monitor = native.createMonitor(deps);
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.startRuntime();

    monitor.trackOrder({
      orderId: 'BUY-ZERO-PRICE-QUOTE',
      symbol: 'BULL.HK',
      side: native.queryObservation.executionSide,
      executionSide: native.queryObservation.executionSide,
      price: '1',
      initialSubmittedPrice: '1',
      quantity: 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: native.queryObservation.orderType,
    });
    await flushMicrotasks();

    await monitor.stopRuntimeAndDrain();
    expect(native.nativeMutations().filter((m) => m.kind === 'REPLACE')).toHaveLength(0);
  });

  it('replaceOrderPriceWithPermit 确认保护性 SELL terminal 时立即经终态网关提交 progress 并结算', async () => {
    const localSellCalls: Array<
      Readonly<{ costAmount: string; executedQuantity: number; executedTimeMs: number }>
    > = [];
    const dailyLossCalls: DailyLossCumulativeExecutionInput[] = [];
    const persistedOrderIds: string[] = [];
    const orderStateEvents: OrderStateChangedEvent[] = [];
    const terminalRevisionMs = Date.parse('2026-07-13T05:00:00.000Z');
    const frame = {
      orderId: 'SELL-PUBLIC-REPLACE-TERMINAL-GATEWAY',
      symbol: 'BULL.HK',
      stockName: 'HSI RC',
      remark: '',
      side: 'SELL' as const,
      status: 'PartialWithdrawal' as const,
      orderType: 'ELO' as const,
      quantity: '100',
      executedQuantity: '40',
      submittedPrice: '1',
      executedPrice: '1.02',
      submittedAtMs: terminalRevisionMs - 1000,
      executionTimeMs: terminalRevisionMs,
      updatedAtMs: terminalRevisionMs,
    };
    const { deps, native, economic } = await createNativeDeps(
      {
        now: () => new Date(terminalRevisionMs + 1000),
        observeRecorder: (owner) => ({
          ...owner,
          commitExecutionFact: (fact, isLong, related, beforeCommit) => {
            const sellBefore = owner.getSellRecordByOrderId(fact.brokerOrderId);
            owner.commitExecutionFact(fact, isLong, related, beforeCommit);
            const sellAfter = owner.getSellRecordByOrderId(fact.brokerOrderId);
            if (fact.side === 'SELL' && economicProjectionChanged([sellBefore], [sellAfter])) {
              if (fact.executionTimeMs === null)
                throw new Error('accepted SELL requires original execution T');

              localSellCalls.push({
                costAmount: fact.cumulativeAmount,
                executedQuantity: fact.cumulativeQuantity,
                executedTimeMs: fact.executionTimeMs,
              });
            }
          },
        }),
        observeDaily: (owner) => ({
          ...owner,
          recordCumulativeExecution: (input, beforeAuthoritativeFactCommit) => {
            dailyLossCalls.push(input);
            return owner.recordCumulativeExecution(input, beforeAuthoritativeFactCommit);
          },
        }),
        persistProtectiveLiquidationExecutionProgress: (input) => {
          persistedOrderIds.push(input.orderId);
        },
      },
      frame,
    );
    native.failReplace(new Error('openapi error: code=601011: order state changed'));
    native.setOrderDetailReplies([frame]);

    const monitor = native.createMonitor(deps);
    monitor.onOrderStateChanged((event) => {
      orderStateEvents.push(event);
    });
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.trackOrder({
      orderId: 'SELL-PUBLIC-REPLACE-TERMINAL-GATEWAY',
      symbol: 'BULL.HK',
      side: native.queryObservation.executionSide,
      executionSide: native.queryObservation.executionSide,
      price: '1',
      initialSubmittedPrice: '1',
      quantity: 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: true,
      orderType: native.queryObservation.orderType,
    });

    economic.recorder.submitSellOrder(
      frame.orderId,
      'BULL.HK',
      'LONG',
      100,
      [],
      frame.submittedAtMs,
    );
    expect(economic.recorder.getPendingSellSnapshot()).toHaveLength(1);
    expect(economic.holds.getHoldSymbols().has('BULL.HK')).toBe(true);

    const outcome = await monitor.replaceOrderPriceWithPermit(
      'SELL-PUBLIC-REPLACE-TERMINAL-GATEWAY',
      '1.03',
      { kind: 'ORDER_FACT' },
      { invoke: (operation) => operation() },
    );

    if (outcome.kind === 'POST_FAILURE_CONFIRMATION_REQUIRED') {
      await outcome.confirmAfterPermitReleased();
    }

    expect(persistedOrderIds).toEqual(['SELL-PUBLIC-REPLACE-TERMINAL-GATEWAY']);
    expect(dailyLossCalls).toMatchObject([
      {
        factStage: 'TERMINAL',
        orderId: 'SELL-PUBLIC-REPLACE-TERMINAL-GATEWAY',
        side: 'SELL',
        executedPrice: '1.02',
        executedQuantity: 40,
        executedTimeMs: terminalRevisionMs,
        orderUpdatedAtMs: terminalRevisionMs,
      },
    ]);

    expect(localSellCalls).toEqual([
      {
        costAmount: '40.8',
        executedQuantity: 40,
        executedTimeMs: terminalRevisionMs,
      },
    ]);

    expect(orderStateEvents).toMatchObject([
      {
        orderId: 'SELL-PUBLIC-REPLACE-TERMINAL-GATEWAY',
        status: 'CANCELED',
        isProtectiveLiquidation: true,
        executedQuantity: 40,
      },
    ]);
    expect(monitor.getPendingSellOrders('BULL.HK')).toHaveLength(0);
    expect(native.nativeReadCounts().detail).toBe(1);
    expect(economic.recorder.getSellRecordByOrderId(frame.orderId)).toMatchObject({
      costAmount: '40.8',
      executedQuantity: 40,
      executedTime: terminalRevisionMs,
    });
    expect(economic.recorder.getPendingSellSnapshot()).toEqual([]);
  });
});
