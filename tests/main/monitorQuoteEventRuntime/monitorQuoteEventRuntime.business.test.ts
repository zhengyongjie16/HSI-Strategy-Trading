/**
 * MonitorQuoteEventRuntime 业务测试
 *
 * 功能：
 * - 验证 monitor quote 事件运行时的公开默认工厂与生产行为契约
 */
import { describe, expect, it } from 'bun:test';
import {
  createAutoSymbolManagerDouble,
  createMonitorContextDouble,
  createOrderRecorderDouble,
  createPositionCacheDouble,
  createPositionDouble,
  createQuoteDouble,
  createRiskCheckerDouble,
  createSymbolRegistryDouble,
  createTraderDouble,
} from '../../helpers/testDoubles.js';
import { createMonitorConfig } from '../../../mock/factories/configFactory.js';
import { ORDER_QUOTE_RETRY, TRADING } from '../../../src/constants/index.js';
import { createDefaultMonitorQuoteEventRuntime } from '../../../src/main/monitorQuoteEventRuntime/monitorQuoteEventRuntime.js';
import { createExternalApiRequestError } from '../../helpers/createExternalApiRequestError.js';
import type {
  CreateDefaultMonitorQuoteEventRuntimeDeps,
  MonitorQuoteEventRuntime,
} from '../../../src/main/monitorQuoteEventRuntime/types.js';
import type { MonitorContext } from '../../../src/types/state.js';
import type { StartSwitchOnDistanceResult } from '../../../src/types/monitorContextPorts.js';
import type { QuoteUpdatedEvent } from '../../../src/types/services.js';

type MonitorQuoteFreshnessDeps =
  CreateDefaultMonitorQuoteEventRuntimeDeps['postTradeConsistencyRuntime'];

type RuntimeHarness = Readonly<{
  runtime: MonitorQuoteEventRuntime;
  emitQuoteUpdated: (event: QuoteUpdatedEvent) => void;
}>;

type RetainReleaseCall = Readonly<{
  ownerKey: string;
  reason: string;
}>;

type DistanceSwitchTimerHarness = Readonly<{
  now: () => Date;
  setNow: (nextNowMs: number) => void;
  scheduleTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer: (handle: ReturnType<typeof setTimeout>) => void;
  fireDueTimers: () => void;
  getPendingTimerCount: () => number;
  getPendingTimerAtMs: () => ReadonlyArray<number>;
}>;

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });

  return {
    promise,
    resolve,
  };
}

function createDistanceSwitchTimerHarness(initialNowMs: number): DistanceSwitchTimerHarness {
  let currentNowMs = initialNowMs;
  const timers = new Map<ReturnType<typeof setTimeout>, { atMs: number; callback: () => void }>();

  function scheduleTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    const handle = setTimeout(() => {}, delayMs);
    timers.set(handle, {
      atMs: currentNowMs + delayMs,
      callback,
    });
    return handle;
  }

  function clearTimer(handle: ReturnType<typeof setTimeout>): void {
    clearTimeout(handle);
    timers.delete(handle);
  }

  function fireDueTimers(): void {
    const dueTimers = [...timers.entries()].filter(([, timer]) => timer.atMs <= currentNowMs);
    for (const [handle, timer] of dueTimers) {
      clearTimeout(handle);
      timers.delete(handle);
      timer.callback();
    }
  }

  return {
    now: () => new Date(currentNowMs),
    setNow: (nextNowMs: number) => {
      currentNowMs = nextNowMs;
    },
    scheduleTimer,
    clearTimer,
    fireDueTimers,
    getPendingTimerCount: () => timers.size,
    getPendingTimerAtMs: () => [...timers.values()].map((timer) => timer.atMs),
  };
}

function createQuoteUpdatedEvent(symbol: string, price: number): QuoteUpdatedEvent {
  return {
    symbol,
    quote: createQuoteDouble(symbol, price, 100),
  };
}

function createMonitorQuoteUpdatedEvent(price: number = 20_000): QuoteUpdatedEvent {
  return createQuoteUpdatedEvent('HSI.HK', price);
}

function waitTick(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function createFreshnessRuntimeDouble(): MonitorQuoteFreshnessDeps {
  return {
    waitForFresh: async () => {},
    getStatus: () => ({
      started: true,
      currentVersion: 1,
      staleVersion: 1,
    }),
  };
}

function createDefaultStaticLiquidationHarness(): RuntimeHarness &
  Readonly<{
    submittedActions: ReadonlyArray<string>;
    getClearedOrders: () => number;
    getRefreshUnrealizedCalls: () => number;
  }> {
  let quoteUpdatedListener: ((event: QuoteUpdatedEvent) => void) | null = null;
  const submittedActions: string[] = [];
  let clearedOrders = 0;
  let refreshUnrealizedCalls = 0;
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
  const monitorContext = createMonitorContextDouble({
    config: createMonitorConfig({
      monitorSymbol: 'HSI.HK',
      autoSearchConfig: {
        autoSearchEnabled: false,
        autoSearchMinDistancePctBull: null,
        autoSearchMinDistancePctBear: null,
        autoSearchMinTurnoverPerMinuteBull: null,
        autoSearchMinTurnoverPerMinuteBear: null,
        autoSearchExpiryMinMonths: 3,
        autoSearchOpenDelayMinutes: 5,
        switchIntervalMinutes: 0,
        switchDistanceRangeBull: null,
        switchDistanceRangeBear: null,
      },
      longSymbol: 'BULL.HK',
      shortSymbol: 'BEAR.HK',
    }),
    symbolRegistry,
    orderRecorder: createOrderRecorderDouble({
      clearBuyOrders: () => {
        clearedOrders += 1;
      },
    }),
    riskChecker: createRiskCheckerDouble({
      checkWarrantDistanceLiquidation: (_symbol, isLongSymbol) => ({
        shouldLiquidate: isLongSymbol,
        ...(isLongSymbol ? { reason: '触发清仓阈值' } : {}),
      }),
      refreshUnrealizedLossData: async () => {
        refreshUnrealizedCalls += 1;
        return { r1: 100, n1: 100 };
      },
    }),
  });
  const runtime = createDefaultMonitorQuoteEventRuntime({
    marketDataClient: {
      onQuoteUpdated: (listener) => {
        quoteUpdatedListener = listener;
        return () => {
          if (quoteUpdatedListener === listener) {
            quoteUpdatedListener = null;
          }
        };
      },
      getQuotes: async () =>
        new Map([
          ['HSI.HK', createQuoteDouble('HSI.HK', 20_000, 100)],
          ['BULL.HK', createQuoteDouble('BULL.HK', 1, 100)],
          ['BEAR.HK', createQuoteDouble('BEAR.HK', 1, 100)],
        ]),
    },
    monitorContext,
    trader: createTraderDouble({
      executeSignals: async (signals) => {
        for (const signal of signals) {
          submittedActions.push(signal.action);
        }

        return {
          executedOrderIds: signals.map(() => `EXECUTED-ORDER`),
        };
      },
    }),
    lastState: {
      positionCache: createPositionCacheDouble([
        createPositionDouble({
          symbol: 'BULL.HK',
          quantity: 200,
          availableQuantity: 200,
        }),
      ]),
      cachedPositions: [],
      isTradingEnabled: true,
      canTrade: true,
      isHalfDay: false,
    },
    postTradeConsistencyRuntime: createFreshnessRuntimeDouble(),
    doomsdayProtectionEnabled: false,
    now: () => new Date('2026-04-08T10:00:00+08:00'),
  });

  return {
    runtime,
    emitQuoteUpdated(event: QuoteUpdatedEvent): void {
      quoteUpdatedListener?.(event);
    },
    submittedActions,
    getClearedOrders: () => clearedOrders,
    getRefreshUnrealizedCalls: () => refreshUnrealizedCalls,
  };
}

function createDefaultDistanceSwitchHarness(
  params: {
    readonly waitForDistanceResult?: Promise<ReadonlyArray<StartSwitchOnDistanceResult>>;
    readonly waitForLongAdmission?: Promise<true>;
    readonly canTrade?: boolean | null;
    readonly switchFailures?: ReadonlyArray<Error | Promise<Error>>;
    readonly timerHarness?: DistanceSwitchTimerHarness;
    readonly doomsdayProtectionEnabled?: boolean;
    readonly markPendingSwitchBeforeFailure?: boolean;
    readonly onFatalError?: (error: unknown) => void;
    readonly invalidStartedResult?: boolean;
  } = {},
): RuntimeHarness &
  Readonly<{
    startSwitchDirections: ReadonlyArray<'LONG' | 'SHORT'>;
    startSwitchPrices: ReadonlyArray<number | null>;
    replaceLongSeatDuringPrecheck: () => void;
    switchMonitorRouteToStaticMode: () => void;
    switchWakeupHandoffs: ReadonlyArray<{
      readonly direction: 'LONG' | 'SHORT';
      readonly driveResultKind: string;
    }>;
  }> {
  let quoteUpdatedListener: ((event: QuoteUpdatedEvent) => void) | null = null;
  const startSwitchDirections: Array<'LONG' | 'SHORT'> = [];
  const startSwitchPrices: Array<number | null> = [];
  const switchFailures = [...(params.switchFailures ?? [])];
  let hasPendingSwitch = false;
  const pendingSwitchDirections = new Set<'LONG' | 'SHORT'>();
  const switchWakeupHandoffs: Array<{
    readonly direction: 'LONG' | 'SHORT';
    readonly driveResultKind: string;
  }> = [];
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
  const autoSymbolManager = createAutoSymbolManagerDouble({
    hasPendingSwitch: (direction) => hasPendingSwitch || pendingSwitchDirections.has(direction),
    startSwitchOnDistance: async ({ direction, monitorPrice, canContinue }) => {
      startSwitchDirections.push(direction);
      startSwitchPrices.push(monitorPrice);
      const switchFailure = switchFailures.shift();
      if (switchFailure) {
        const resolvedFailure = await switchFailure;
        if (params.markPendingSwitchBeforeFailure) {
          hasPendingSwitch = true;
        }

        throw resolvedFailure;
      }

      if (params.waitForLongAdmission) {
        if (pendingSwitchDirections.has(direction)) {
          return { started: false, direction, driveResult: { kind: 'NOOP' } };
        }

        if (direction === 'LONG') {
          await params.waitForLongAdmission;
        }

        if (!canContinue()) {
          return { started: false, direction, driveResult: { kind: 'NOOP' } };
        }

        pendingSwitchDirections.add(direction);
      }

      if (params.waitForDistanceResult) {
        const result = await params.waitForDistanceResult;
        return result[0] ?? { started: false, direction, driveResult: { kind: 'NOOP' } };
      }

      return {
        started: true,
        direction,
        driveResult: {
          kind: 'WAIT',
          wakeups: [
            { kind: 'ORDER_EVENT', symbols: [direction === 'LONG' ? 'BULL.HK' : 'BEAR.HK'] },
          ],
        },
      };
    },
  });
  if (params.invalidStartedResult) {
    Object.defineProperty(autoSymbolManager, 'startSwitchOnDistance', {
      value: async ({ direction }: { readonly direction: 'LONG' | 'SHORT' }) => ({
        started: true,
        direction,
        driveResult: { kind: 'COMPLETED' },
      }),
    });
  }

  let autoSearchEnabled = true;
  const distanceMonitorConfig = createMonitorConfig({
    monitorSymbol: 'HSI.HK',
    autoSearchConfig: {
      autoSearchEnabled: true,
      autoSearchMinDistancePctBull: null,
      autoSearchMinDistancePctBear: null,
      autoSearchMinTurnoverPerMinuteBull: null,
      autoSearchMinTurnoverPerMinuteBear: null,
      autoSearchExpiryMinMonths: 3,
      autoSearchOpenDelayMinutes: 5,
      switchIntervalMinutes: 0,
      switchDistanceRangeBull: null,
      switchDistanceRangeBear: null,
    },
    longSymbol: 'BULL.HK',
    shortSymbol: 'BEAR.HK',
  });
  const staticMonitorConfig = {
    ...distanceMonitorConfig,
    autoSearchConfig: {
      ...distanceMonitorConfig.autoSearchConfig,
      autoSearchEnabled: false,
    },
  };
  const distanceMonitorContext = createMonitorContextDouble({
    config: distanceMonitorConfig,
    symbolRegistry,
    autoSymbolManager,
  });
  const monitorContext: MonitorContext = {
    ...distanceMonitorContext,
    get config() {
      return autoSearchEnabled ? distanceMonitorConfig : staticMonitorConfig;
    },
  };
  const runtime = createDefaultMonitorQuoteEventRuntime({
    marketDataClient: {
      onQuoteUpdated: (listener) => {
        quoteUpdatedListener = listener;
        return () => {
          if (quoteUpdatedListener === listener) {
            quoteUpdatedListener = null;
          }
        };
      },
      getQuotes: async () => new Map(),
    },
    monitorContext,
    trader: createTraderDouble(),
    lastState: {
      positionCache: createPositionCacheDouble(),
      cachedPositions: [],
      isTradingEnabled: true,
      canTrade: params.canTrade ?? true,
      isHalfDay: false,
    },
    postTradeConsistencyRuntime: createFreshnessRuntimeDouble(),
    doomsdayProtectionEnabled: params.doomsdayProtectionEnabled ?? false,
    now: params.timerHarness?.now ?? (() => new Date('2026-04-08T10:00:00+08:00')),
    ...(params.timerHarness
      ? {
          scheduleTimer: params.timerHarness.scheduleTimer,
          clearTimer: params.timerHarness.clearTimer,
        }
      : {}),
    ...(params.onFatalError ? { onFatalError: params.onFatalError } : {}),
    handoffPendingSwitch: (handoffParams) => {
      switchWakeupHandoffs.push({
        direction: handoffParams.direction,
        driveResultKind: handoffParams.driveResult.kind,
      });
    },
  });

  return {
    runtime,
    emitQuoteUpdated(event: QuoteUpdatedEvent): void {
      quoteUpdatedListener?.(event);
    },
    startSwitchDirections,
    startSwitchPrices,
    replaceLongSeatDuringPrecheck: () => {
      symbolRegistry.updateSeatStateWithVersionBump('LONG', {
        symbol: 'BULL-NEXT.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: 1,
        callPrice: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      });
    },
    switchMonitorRouteToStaticMode: () => {
      autoSearchEnabled = false;
    },
    switchWakeupHandoffs,
  };
}

function createDefaultStaticWaitHarness(
  params: {
    readonly retainFailureCount?: number;
    readonly shouldLiquidateShort?: boolean;
    readonly longQuoteAvailable?: boolean;
    readonly shortQuoteAvailable?: boolean;
    readonly failShortSubmissionOnce?: boolean;
    readonly deferQuoteResponse?: boolean;
  } = {},
): RuntimeHarness &
  Readonly<{
    getQuoteRequestCount: () => number;
    getRetainCalls: () => ReadonlyArray<ReadonlyArray<string>>;
    getReleaseCalls: () => ReadonlyArray<RetainReleaseCall>;
    getSubmittedActions: () => ReadonlyArray<string>;
    getFatalErrorCount: () => number;
    resolveQuoteResponse: () => void;
    setLongQuoteAvailable: (available: boolean) => void;
    switchLongSeatToNextSymbol: () => void;
    switchMonitorRouteToDistanceMode: () => void;
  }> {
  let quoteUpdatedListener: ((event: QuoteUpdatedEvent) => void) | null = null;
  const quoteRequests: string[][] = [];
  const retainCalls: string[][] = [];
  const releaseCalls: RetainReleaseCall[] = [];
  const submittedActions: string[] = [];
  let remainingRetainFailures = params.retainFailureCount ?? 0;
  let remainingShortSubmissionFailures = params.failShortSubmissionOnce ? 1 : 0;
  let fatalErrorCount = 0;
  let longQuoteAvailable = params.longQuoteAvailable ?? false;
  const shortQuoteAvailable = params.shortQuoteAvailable ?? false;
  const quoteResponseGate = params.deferQuoteResponse ? createDeferred<true>() : null;
  let routeMode: 'STATIC_LIQUIDATION' | 'DISTANCE_SWITCH' = 'STATIC_LIQUIDATION';
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
  const staticMonitorContext = createMonitorContextDouble({
    config: createMonitorConfig({
      monitorSymbol: 'HSI.HK',
      autoSearchConfig: {
        autoSearchEnabled: false,
        autoSearchMinDistancePctBull: null,
        autoSearchMinDistancePctBear: null,
        autoSearchMinTurnoverPerMinuteBull: null,
        autoSearchMinTurnoverPerMinuteBear: null,
        autoSearchExpiryMinMonths: 3,
        autoSearchOpenDelayMinutes: 5,
        switchIntervalMinutes: 0,
        switchDistanceRangeBull: null,
        switchDistanceRangeBear: null,
      },
      longSymbol: 'BULL.HK',
      shortSymbol: 'BEAR.HK',
    }),
    symbolRegistry,
    riskChecker: createRiskCheckerDouble({
      checkWarrantDistanceLiquidation: (_symbol, isLongSymbol) => ({
        shouldLiquidate: isLongSymbol || (params.shouldLiquidateShort ?? false),
        ...(isLongSymbol || params.shouldLiquidateShort ? { reason: '触发清仓阈值' } : {}),
      }),
    }),
  });
  const distanceMonitorContext = createMonitorContextDouble({
    config: createMonitorConfig({
      monitorSymbol: 'HSI.HK',
      autoSearchConfig: {
        autoSearchEnabled: true,
        autoSearchMinDistancePctBull: null,
        autoSearchMinDistancePctBear: null,
        autoSearchMinTurnoverPerMinuteBull: null,
        autoSearchMinTurnoverPerMinuteBear: null,
        autoSearchExpiryMinMonths: 3,
        autoSearchOpenDelayMinutes: 5,
        switchIntervalMinutes: 0,
        switchDistanceRangeBull: null,
        switchDistanceRangeBear: null,
      },
      longSymbol: 'BULL.HK',
      shortSymbol: 'BEAR.HK',
    }),
    symbolRegistry,
    autoSymbolManager: createAutoSymbolManagerDouble({
      startSwitchOnDistance: async ({ direction }) => ({
        started: false,
        direction,
        driveResult: { kind: 'NOOP' },
      }),
    }),
  });
  const monitorContext: MonitorContext = {
    ...staticMonitorContext,
    get config() {
      return routeMode === 'STATIC_LIQUIDATION'
        ? staticMonitorContext.config
        : distanceMonitorContext.config;
    },
    get autoSymbolManager() {
      return routeMode === 'STATIC_LIQUIDATION'
        ? staticMonitorContext.autoSymbolManager
        : distanceMonitorContext.autoSymbolManager;
    },
  };
  const runtime = createDefaultMonitorQuoteEventRuntime({
    marketDataClient: {
      onQuoteUpdated: (listener) => {
        quoteUpdatedListener = listener;
        return () => {
          if (quoteUpdatedListener === listener) {
            quoteUpdatedListener = null;
          }
        };
      },
      getQuotes: async (symbols) => {
        quoteRequests.push([...symbols]);
        await quoteResponseGate?.promise;
        return new Map([
          ['HSI.HK', createQuoteDouble('HSI.HK', 20_000, 100)],
          ['BULL.HK', longQuoteAvailable ? createQuoteDouble('BULL.HK', 1, 100) : null],
          ['BEAR.HK', shortQuoteAvailable ? createQuoteDouble('BEAR.HK', 1, 100) : null],
        ]);
      },
    },
    monitorContext,
    trader: createTraderDouble({
      executeSignals: async (signals) => {
        if (
          signals.some((signal) => signal.action === 'SELLPUT') &&
          remainingShortSubmissionFailures > 0
        ) {
          remainingShortSubmissionFailures -= 1;
          throw new Error('short submission failed');
        }

        submittedActions.push(...signals.map((signal) => signal.action));
        return {
          executedOrderIds: signals.map((_, index) => `ORDER-${submittedActions.length}-${index}`),
        };
      },
    }),
    lastState: {
      positionCache: createPositionCacheDouble([
        createPositionDouble({
          symbol: 'BULL.HK',
          quantity: 200,
          availableQuantity: 200,
        }),
        createPositionDouble({
          symbol: 'BEAR.HK',
          quantity: 300,
          availableQuantity: 300,
        }),
        createPositionDouble({
          symbol: 'NEXT_BULL.HK',
          quantity: 200,
          availableQuantity: 200,
        }),
      ]),
      cachedPositions: [],
      isTradingEnabled: true,
      canTrade: true,
      isHalfDay: false,
    },
    postTradeConsistencyRuntime: createFreshnessRuntimeDouble(),
    doomsdayProtectionEnabled: false,
    now: () => new Date('2026-04-08T10:00:00+08:00'),
    onFatalError: () => {
      fatalErrorCount += 1;
    },
    quoteSubscriptionRuntime: {
      retainSymbols: async ({ symbols }) => {
        retainCalls.push([...symbols]);
        if (remainingRetainFailures > 0) {
          remainingRetainFailures -= 1;
          throw new Error('retain failed');
        }

        return () => {};
      },
      releaseRetain: async ({ ownerKey, reason }) => {
        releaseCalls.push({ ownerKey, reason });
      },
    },
  });

  return {
    runtime,
    emitQuoteUpdated(event: QuoteUpdatedEvent): void {
      quoteUpdatedListener?.(event);
    },
    getQuoteRequestCount: () => quoteRequests.length,
    getRetainCalls: () => retainCalls.map((symbols) => [...symbols]),
    getReleaseCalls: () => releaseCalls.map((call) => ({ ...call })),
    getSubmittedActions: () => [...submittedActions],
    getFatalErrorCount: () => fatalErrorCount,
    resolveQuoteResponse(): void {
      quoteResponseGate?.resolve(true);
    },
    setLongQuoteAvailable(available: boolean): void {
      longQuoteAvailable = available;
    },
    switchLongSeatToNextSymbol(): void {
      symbolRegistry.updateSeatState('LONG', {
        symbol: 'NEXT_BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: 1,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      });
    },
    switchMonitorRouteToDistanceMode(): void {
      routeMode = 'DISTANCE_SWITCH';
    },
  };
}

describe('monitorQuoteEventRuntime exports', () => {
  it('exports the public default monitor quote runtime factory', async () => {
    const module =
      await import('../../../src/main/monitorQuoteEventRuntime/monitorQuoteEventRuntime.js');

    expect(Object.keys(module)).toEqual(['createDefaultMonitorQuoteEventRuntime']);
  });
});

describe('monitorQuoteEventRuntime contract', () => {
  it('creates default runtime with start and stopAndDrain methods', () => {
    const harness = createDefaultDistanceSwitchHarness();

    expect(harness.runtime).toMatchObject({
      start: expect.any(Function),
      stopAndDrain: expect.any(Function),
    });
  });

  it('subscribes on start and unsubscribes on stopAndDrain', async () => {
    let subscribed = 0;
    let unsubscribed = 0;
    const runtime = createDefaultMonitorQuoteEventRuntime({
      marketDataClient: {
        onQuoteUpdated: () => {
          subscribed += 1;
          return () => {
            unsubscribed += 1;
          };
        },
        getQuotes: async () => new Map(),
      },
      monitorContext: createMonitorContextDouble(),
      trader: createTraderDouble(),
      lastState: {
        positionCache: createPositionCacheDouble(),
        cachedPositions: [],
        isTradingEnabled: true,
        canTrade: true,
        isHalfDay: false,
      },
      postTradeConsistencyRuntime: createFreshnessRuntimeDouble(),
      doomsdayProtectionEnabled: false,
      now: () => new Date('2026-04-08T10:00:00+08:00'),
    });

    runtime.start();
    expect(subscribed).toBe(1);

    await runtime.stopAndDrain();
    expect(unsubscribed).toBe(1);
  });

  it('executes real static liquidation when autoSearch is disabled', async () => {
    const harness = createDefaultStaticLiquidationHarness();

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());

    await waitTick();
    await harness.runtime.stopAndDrain();
    expect(harness.submittedActions).toEqual(['SELLCALL']);
    expect(harness.getClearedOrders()).toBe(1);
    expect(harness.getRefreshUnrealizedCalls()).toBe(1);
  });

  it('matches only registered static liquidation wakeup symbols', async () => {
    const harness = createDefaultStaticWaitHarness();

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());

    await waitTick();
    expect(harness.getQuoteRequestCount()).toBe(1);

    harness.emitQuoteUpdated(createQuoteUpdatedEvent('IGNORED.HK', 1));

    await waitTick();
    expect(harness.getQuoteRequestCount()).toBe(1);

    harness.emitQuoteUpdated(createQuoteUpdatedEvent('BULL.HK', 1));

    await waitTick();
    expect(harness.getQuoteRequestCount()).toBe(2);

    harness.emitQuoteUpdated(createQuoteUpdatedEvent('BEAR.HK', 1));

    await waitTick();
    expect(harness.getQuoteRequestCount()).toBe(3);

    await harness.runtime.stopAndDrain();
  });

  it('does not re-retain unchanged static liquidation wakeup symbols', async () => {
    const harness = createDefaultStaticWaitHarness();

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());

    await waitTick();
    expect(harness.getRetainCalls()).toEqual([['HSI.HK', 'BULL.HK', 'BEAR.HK']]);

    harness.emitQuoteUpdated(createQuoteUpdatedEvent('BULL.HK', 1));

    await waitTick();
    expect(harness.getRetainCalls()).toEqual([['HSI.HK', 'BULL.HK', 'BEAR.HK']]);

    await harness.runtime.stopAndDrain();
  });

  it('does not resubmit a completed direction while another static liquidation direction is waiting', async () => {
    const harness = createDefaultStaticWaitHarness({
      shouldLiquidateShort: true,
      shortQuoteAvailable: true,
    });

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());

    await waitTick();
    expect(harness.getSubmittedActions()).toEqual(['SELLPUT']);

    harness.setLongQuoteAvailable(true);
    harness.emitQuoteUpdated(createQuoteUpdatedEvent('BULL.HK', 1));

    await waitTick();
    expect(harness.getSubmittedActions()).toEqual(['SELLPUT', 'SELLCALL']);

    await harness.runtime.stopAndDrain();
  });

  it('retains a submitted direction when the following direction throws', async () => {
    const harness = createDefaultStaticWaitHarness({
      shouldLiquidateShort: true,
      longQuoteAvailable: true,
      shortQuoteAvailable: true,
      failShortSubmissionOnce: true,
    });

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());

    await waitTick();
    expect(harness.getSubmittedActions()).toEqual(['SELLCALL']);
    expect(harness.getFatalErrorCount()).toBe(1);

    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());

    await waitTick();
    expect(harness.getSubmittedActions()).toEqual(['SELLCALL', 'SELLPUT']);

    await harness.runtime.stopAndDrain();
  });

  it('retries unchanged static liquidation retain after previous retain failure', async () => {
    const harness = createDefaultStaticWaitHarness({ retainFailureCount: 1 });

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());

    await waitTick();
    expect(harness.getRetainCalls()).toEqual([['HSI.HK', 'BULL.HK', 'BEAR.HK']]);

    harness.emitQuoteUpdated(createQuoteUpdatedEvent('BULL.HK', 1));

    await waitTick();
    expect(harness.getRetainCalls()).toEqual([
      ['HSI.HK', 'BULL.HK', 'BEAR.HK'],
      ['HSI.HK', 'BULL.HK', 'BEAR.HK'],
    ]);

    await harness.runtime.stopAndDrain();
  });

  it('releases static liquidation retain owner after failed retain when runtime stops', async () => {
    const harness = createDefaultStaticWaitHarness({ retainFailureCount: 1 });

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());

    await waitTick();
    await harness.runtime.stopAndDrain();

    expect(harness.getReleaseCalls()).toEqual([
      { ownerKey: 'HSI.HK', reason: 'STATIC_LIQUIDATION_WAIT' },
    ]);
  });

  it('switches static liquidation wakeup membership when WAIT symbols change', async () => {
    const harness = createDefaultStaticWaitHarness();

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());

    await waitTick();
    expect(harness.getQuoteRequestCount()).toBe(1);

    harness.switchLongSeatToNextSymbol();
    harness.emitQuoteUpdated(createQuoteUpdatedEvent('BULL.HK', 1));

    await waitTick();
    expect(harness.getQuoteRequestCount()).toBe(2);

    harness.emitQuoteUpdated(createQuoteUpdatedEvent('BULL.HK', 1));

    await waitTick();
    expect(harness.getQuoteRequestCount()).toBe(2);

    harness.emitQuoteUpdated(createQuoteUpdatedEvent('NEXT_BULL.HK', 1));

    await waitTick();
    expect(harness.getQuoteRequestCount()).toBe(3);

    await harness.runtime.stopAndDrain();
  });

  it('clears static liquidation wakeups when route switches to distance mode', async () => {
    const harness = createDefaultStaticWaitHarness();

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());

    await waitTick();
    expect(harness.getQuoteRequestCount()).toBe(1);

    harness.switchMonitorRouteToDistanceMode();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());

    await waitTick();
    expect(harness.getQuoteRequestCount()).toBe(1);

    harness.emitQuoteUpdated(createQuoteUpdatedEvent('BULL.HK', 1));

    await waitTick();
    expect(harness.getQuoteRequestCount()).toBe(1);

    await harness.runtime.stopAndDrain();
  });

  it('discards an in-flight static WAIT result after the route switches to distance mode', async () => {
    const harness = createDefaultStaticWaitHarness({
      deferQuoteResponse: true,
      longQuoteAvailable: true,
    });

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());
    await waitTick();
    expect(harness.getQuoteRequestCount()).toBe(1);

    harness.switchMonitorRouteToDistanceMode();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());
    harness.resolveQuoteResponse();
    await waitTick();
    await waitTick();

    expect(harness.getRetainCalls()).toEqual([]);
    expect(harness.getSubmittedActions()).toEqual([]);

    await harness.runtime.stopAndDrain();
  });

  it('clears static liquidation wakeups after stopAndDrain', async () => {
    const harness = createDefaultStaticWaitHarness();

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());

    await waitTick();
    expect(harness.getQuoteRequestCount()).toBe(1);

    await harness.runtime.stopAndDrain();
    harness.emitQuoteUpdated(createQuoteUpdatedEvent('BULL.HK', 1));

    await waitTick();
    expect(harness.getQuoteRequestCount()).toBe(1);
  });

  it('starts distance switch through monitorContext autoSymbolManager when autoSearch is enabled', async () => {
    const harness = createDefaultDistanceSwitchHarness();

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());

    await waitTick();
    expect(harness.startSwitchDirections).toEqual(['LONG', 'SHORT']);
    expect(harness.switchWakeupHandoffs).toEqual([
      {
        direction: 'LONG',
        driveResultKind: 'WAIT',
      },
      {
        direction: 'SHORT',
        driveResultKind: 'WAIT',
      },
    ]);

    await harness.runtime.stopAndDrain();
  });

  it('skips distance switch when execution gate is closed', async () => {
    const harness = createDefaultDistanceSwitchHarness({ canTrade: false });

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());

    await waitTick();
    expect(harness.startSwitchDirections).toEqual([]);
    expect(harness.switchWakeupHandoffs).toEqual([]);

    await harness.runtime.stopAndDrain();
  });

  it('does not hand WAIT distance switch result after stopAndDrain', async () => {
    const deferred = createDeferred<ReadonlyArray<StartSwitchOnDistanceResult>>();
    const harness = createDefaultDistanceSwitchHarness({
      waitForDistanceResult: deferred.promise,
    });

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());
    const stopPromise = harness.runtime.stopAndDrain();

    await waitTick();
    deferred.resolve([
      {
        started: true,
        direction: 'LONG',
        driveResult: {
          kind: 'WAIT',
          wakeups: [{ kind: 'ORDER_EVENT', symbols: ['BULL.HK'] }],
        },
      },
    ]);
    await stopPromise;

    expect(harness.switchWakeupHandoffs).toEqual([]);
  });

  it('keeps a deferred LONG admission owned while a newer quote drives only the still-unpending SHORT direction', async () => {
    const longAdmission = createDeferred<true>();
    const harness = createDefaultDistanceSwitchHarness({
      waitForLongAdmission: longAdmission.promise,
    });

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent(100));
    await waitTick();
    expect(harness.startSwitchDirections).toEqual(['LONG']);

    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent(200));
    longAdmission.resolve(true);
    await waitTick();
    await waitTick();

    expect(harness.startSwitchDirections).toEqual(['LONG', 'LONG', 'SHORT']);
    expect(harness.startSwitchPrices).toEqual([100, 200, 200]);
    expect(harness.switchWakeupHandoffs).toEqual([
      { direction: 'LONG', driveResultKind: 'WAIT' },
      { direction: 'SHORT', driveResultKind: 'WAIT' },
    ]);
    await harness.runtime.stopAndDrain();
  });

  it('retries a true external precheck failure and hands off only after a later full distance evaluation', async () => {
    const fatalErrors: unknown[] = [];
    const nowMs = Date.parse('2026-04-08T02:00:00.000Z');
    const timerHarness = createDistanceSwitchTimerHarness(nowMs);
    const precheckError = await createExternalApiRequestError({
      operation: 'AutoSymbolManager.startSwitchOnDistance',
      attempts: 1,
      cause: new Error('candidate query unavailable'),
    });
    const harness = createDefaultDistanceSwitchHarness({
      switchFailures: [precheckError],
      timerHarness,
      onFatalError: (error) => {
        fatalErrors.push(error);
      },
    });

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());

    await waitTick();

    expect(fatalErrors).toEqual([]);
    expect(harness.startSwitchDirections).toEqual(['LONG']);
    expect(harness.switchWakeupHandoffs).toEqual([]);
    expect(timerHarness.getPendingTimerAtMs()).toEqual([nowMs + TRADING.INTERVAL_MS]);

    timerHarness.setNow(nowMs + TRADING.INTERVAL_MS);
    timerHarness.fireDueTimers();
    await waitTick();

    expect(harness.startSwitchDirections).toEqual(['LONG', 'LONG', 'SHORT']);
    expect(harness.switchWakeupHandoffs).toEqual([
      { direction: 'LONG', driveResultKind: 'WAIT' },
      { direction: 'SHORT', driveResultKind: 'WAIT' },
    ]);
    expect(timerHarness.getPendingTimerCount()).toBe(0);
    await harness.runtime.stopAndDrain();
  });

  it('allows only one safe external-precheck retry for the current monitor quote', async () => {
    const fatalErrors: unknown[] = [];
    const nowMs = Date.parse('2026-04-08T02:00:00.000Z');
    const timerHarness = createDistanceSwitchTimerHarness(nowMs);
    const firstPrecheckError = await createExternalApiRequestError({
      operation: 'AutoSymbolManager.startSwitchOnDistance',
      attempts: 1,
      cause: new Error('candidate query unavailable'),
    });
    const secondPrecheckError = await createExternalApiRequestError({
      operation: 'AutoSymbolManager.startSwitchOnDistance',
      attempts: 1,
      cause: new Error('candidate query remains unavailable'),
    });
    const harness = createDefaultDistanceSwitchHarness({
      switchFailures: [firstPrecheckError, secondPrecheckError],
      timerHarness,
      onFatalError: (error) => {
        fatalErrors.push(error);
      },
    });

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());
    await waitTick();
    expect(timerHarness.getPendingTimerAtMs()).toEqual([nowMs + TRADING.INTERVAL_MS]);

    timerHarness.setNow(nowMs + TRADING.INTERVAL_MS);
    timerHarness.fireDueTimers();
    await waitTick();

    expect(harness.startSwitchDirections).toEqual(['LONG', 'LONG']);
    expect(fatalErrors).toEqual([secondPrecheckError]);
    expect(timerHarness.getPendingTimerCount()).toBe(0);
    await harness.runtime.stopAndDrain();
  });

  it('keeps an external precheck error fatal when the seat symbol and version change while awaiting it', async () => {
    const fatalErrors: unknown[] = [];
    const timerHarness = createDistanceSwitchTimerHarness(Date.parse('2026-04-08T02:00:00.000Z'));
    const delayedPrecheckError = createDeferred<Error>();
    const precheckError = await createExternalApiRequestError({
      operation: 'AutoSymbolManager.startSwitchOnDistance',
      attempts: 1,
      cause: new Error('candidate query unavailable after seat replacement'),
    });
    const harness = createDefaultDistanceSwitchHarness({
      switchFailures: [delayedPrecheckError.promise],
      timerHarness,
      onFatalError: (error) => {
        fatalErrors.push(error);
      },
    });

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());
    await waitTick();
    harness.replaceLongSeatDuringPrecheck();
    delayedPrecheckError.resolve(precheckError);
    await waitTick();

    expect(fatalErrors).toEqual([precheckError]);
    expect(timerHarness.getPendingTimerCount()).toBe(0);
    await harness.runtime.stopAndDrain();
  });

  it('keeps ordinary distance-switch errors fatal instead of scheduling a retry', async () => {
    const fatalErrors: unknown[] = [];
    const timerHarness = createDistanceSwitchTimerHarness(Date.parse('2026-04-08T02:00:00.000Z'));
    const routeError = new Error('distance switch route broken');
    const harness = createDefaultDistanceSwitchHarness({
      switchFailures: [routeError],
      timerHarness,
      onFatalError: (error) => {
        fatalErrors.push(error);
      },
    });

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());
    await waitTick();

    expect(fatalErrors).toEqual([routeError]);
    expect(timerHarness.getPendingTimerCount()).toBe(0);
    await harness.runtime.stopAndDrain();
  });

  it('keeps TypeError distance-switch failures fatal instead of scheduling a retry', async () => {
    const fatalErrors: unknown[] = [];
    const timerHarness = createDistanceSwitchTimerHarness(Date.parse('2026-04-08T02:00:00.000Z'));
    const routeError = new TypeError('distance switch invariant broken');
    const harness = createDefaultDistanceSwitchHarness({
      switchFailures: [routeError],
      timerHarness,
      onFatalError: (error) => {
        fatalErrors.push(error);
      },
    });

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());
    await waitTick();

    expect(fatalErrors).toEqual([routeError]);
    expect(timerHarness.getPendingTimerCount()).toBe(0);
    await harness.runtime.stopAndDrain();
  });

  it('keeps a fake ExternalApiRequestError distance-switch failure fatal', async () => {
    const fatalErrors: unknown[] = [];
    const timerHarness = createDistanceSwitchTimerHarness(Date.parse('2026-04-08T02:00:00.000Z'));
    const routeError = Object.assign(new Error('forged external API error'), {
      name: 'ExternalApiRequestError',
      operation: 'AutoSymbolManager.startSwitchOnDistance',
      attempts: 1,
    });
    const harness = createDefaultDistanceSwitchHarness({
      switchFailures: [routeError],
      timerHarness,
      onFatalError: (error) => {
        fatalErrors.push(error);
      },
    });

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());
    await waitTick();

    expect(fatalErrors).toEqual([routeError]);
    expect(timerHarness.getPendingTimerCount()).toBe(0);
    await harness.runtime.stopAndDrain();
  });

  it('keeps a true external distance-switch failure fatal after a pending switch was created', async () => {
    const fatalErrors: unknown[] = [];
    const timerHarness = createDistanceSwitchTimerHarness(Date.parse('2026-04-08T02:00:00.000Z'));
    const routeError = await createExternalApiRequestError({
      operation: 'AutoSymbolManager.startSwitchOnDistance',
      attempts: 1,
      cause: new Error('post-admission state failure'),
    });
    const harness = createDefaultDistanceSwitchHarness({
      switchFailures: [routeError],
      timerHarness,
      markPendingSwitchBeforeFailure: true,
      onFatalError: (error) => {
        fatalErrors.push(error);
      },
    });

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());
    await waitTick();

    expect(fatalErrors).toEqual([routeError]);
    expect(timerHarness.getPendingTimerCount()).toBe(0);
    expect(harness.switchWakeupHandoffs).toEqual([]);
    await harness.runtime.stopAndDrain();
  });

  it('grants a new monitor quote its own one-shot external-precheck retry', async () => {
    const initialNowMs = Date.parse('2026-04-08T02:00:00.000Z');
    const latestQuoteNowMs = initialNowMs + 500;
    const timerHarness = createDistanceSwitchTimerHarness(initialNowMs);
    const fatalErrors: unknown[] = [];
    const harness = createDefaultDistanceSwitchHarness({
      switchFailures: [
        await createExternalApiRequestError({
          operation: 'AutoSymbolManager.startSwitchOnDistance',
          attempts: 1,
          cause: new Error('candidate query unavailable'),
        }),
        await createExternalApiRequestError({
          operation: 'AutoSymbolManager.startSwitchOnDistance',
          attempts: 1,
          cause: new Error('pending-order admission unavailable'),
        }),
      ],
      timerHarness,
      onFatalError: (error) => {
        fatalErrors.push(error);
      },
    });

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent(20_000));
    await waitTick();
    expect(timerHarness.getPendingTimerAtMs()).toEqual([initialNowMs + TRADING.INTERVAL_MS]);

    timerHarness.setNow(latestQuoteNowMs);
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent(20_100));
    await waitTick();
    expect(timerHarness.getPendingTimerAtMs()).toEqual([latestQuoteNowMs + TRADING.INTERVAL_MS]);

    timerHarness.setNow(initialNowMs + TRADING.INTERVAL_MS);
    timerHarness.fireDueTimers();
    await waitTick();
    expect(harness.startSwitchPrices).toEqual([20_000, 20_100]);

    timerHarness.setNow(latestQuoteNowMs + TRADING.INTERVAL_MS);
    timerHarness.fireDueTimers();
    await waitTick();
    expect(harness.startSwitchPrices).toEqual([20_000, 20_100, 20_100, 20_100]);
    expect(fatalErrors).toEqual([]);
    await harness.runtime.stopAndDrain();
  });

  it('cancels an external-precheck retry timer during stopAndDrain', async () => {
    const nowMs = Date.parse('2026-04-08T02:00:00.000Z');
    const timerHarness = createDistanceSwitchTimerHarness(nowMs);
    const harness = createDefaultDistanceSwitchHarness({
      switchFailures: [
        await createExternalApiRequestError({
          operation: 'AutoSymbolManager.startSwitchOnDistance',
          attempts: 1,
          cause: new Error('candidate query unavailable'),
        }),
      ],
      timerHarness,
    });

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());
    await waitTick();
    expect(timerHarness.getPendingTimerCount()).toBe(1);

    await harness.runtime.stopAndDrain();
    timerHarness.setNow(nowMs + TRADING.INTERVAL_MS);
    timerHarness.fireDueTimers();
    await waitTick();

    expect(harness.startSwitchDirections).toEqual(['LONG']);
    expect(harness.switchWakeupHandoffs).toEqual([]);
    expect(timerHarness.getPendingTimerCount()).toBe(0);
  });

  it('cancels an external-precheck retry timer when the monitor route changes mode', async () => {
    const nowMs = Date.parse('2026-04-08T02:00:00.000Z');
    const timerHarness = createDistanceSwitchTimerHarness(nowMs);
    const harness = createDefaultDistanceSwitchHarness({
      switchFailures: [
        await createExternalApiRequestError({
          operation: 'AutoSymbolManager.startSwitchOnDistance',
          attempts: 1,
          cause: new Error('candidate query unavailable'),
        }),
      ],
      timerHarness,
    });

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());
    await waitTick();
    expect(timerHarness.getPendingTimerCount()).toBe(1);

    harness.switchMonitorRouteToStaticMode();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());
    await waitTick();
    expect(timerHarness.getPendingTimerAtMs()).toEqual([nowMs + ORDER_QUOTE_RETRY.INTERVAL_MS]);

    timerHarness.setNow(nowMs + TRADING.INTERVAL_MS);
    timerHarness.fireDueTimers();
    await waitTick();

    expect(harness.startSwitchDirections).toEqual(['LONG']);
    await harness.runtime.stopAndDrain();
  });

  it('fails fast when started distance switch does not return WAIT', async () => {
    const fatalErrors: unknown[] = [];
    const harness = createDefaultDistanceSwitchHarness({
      invalidStartedResult: true,
      onFatalError: (error) => {
        fatalErrors.push(error);
      },
    });

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());
    await waitTick();

    expect(fatalErrors).toHaveLength(1);
    expect(fatalErrors[0]).toMatchObject({
      message: '[MonitorQuoteEventRuntime] started switch must return WAIT',
    });
    expect(harness.switchWakeupHandoffs).toEqual([]);
    await harness.runtime.stopAndDrain();
  });

  it('still hands off ordinary distance switches at 15:55 when doomsday protection is disabled', async () => {
    const takeoverMs = Date.parse('2026-02-16T07:55:00.000Z');
    const timerHarness = createDistanceSwitchTimerHarness(takeoverMs);
    const harness = createDefaultDistanceSwitchHarness({
      timerHarness,
      doomsdayProtectionEnabled: false,
    });

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());
    await waitTick();

    expect(harness.startSwitchDirections).toEqual(['LONG', 'SHORT']);
    expect(harness.switchWakeupHandoffs).toEqual([
      { direction: 'LONG', driveResultKind: 'WAIT' },
      { direction: 'SHORT', driveResultKind: 'WAIT' },
    ]);
    await harness.runtime.stopAndDrain();
  });

  it('does not hand off a distance switch after doomsday takeover begins during admission', async () => {
    const beforeTakeoverMs = Date.parse('2026-02-16T07:54:59.000Z');
    const takeoverMs = Date.parse('2026-02-16T07:55:00.000Z');
    const timerHarness = createDistanceSwitchTimerHarness(beforeTakeoverMs);
    const distanceResult = createDeferred<ReadonlyArray<StartSwitchOnDistanceResult>>();
    const harness = createDefaultDistanceSwitchHarness({
      waitForDistanceResult: distanceResult.promise,
      timerHarness,
      doomsdayProtectionEnabled: true,
    });

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());
    await waitTick();

    timerHarness.setNow(takeoverMs);
    distanceResult.resolve([
      {
        started: true,
        direction: 'LONG',
        driveResult: {
          kind: 'WAIT',
          wakeups: [{ kind: 'ORDER_EVENT', symbols: ['BULL.HK'] }],
        },
      },
    ]);
    await waitTick();

    expect(harness.switchWakeupHandoffs).toEqual([]);
    await harness.runtime.stopAndDrain();
  });
});
