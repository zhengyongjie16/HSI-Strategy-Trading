/**
 * AutoSearchWakeupRuntime 异步 owner 业务测试
 *
 * 覆盖：连续交易授权关闭、末日清仓接管、生命周期关闭与 stopAndDrain 必须使运行时拥有的
 * SEARCHING owner 失效；旧 finder 结果不能推进 ACTIVATING，因而不能产生 SEAT_REFRESH。
 */
import { describe, expect, it } from 'bun:test';
import { createMonitorTaskQueue } from '../../../src/main/asyncProgram/monitorTaskQueue/index.js';
import type { MonitorTaskDataMap } from '../../../src/main/asyncProgram/monitorTaskProcessor/types.js';
import { createAutoSearchWakeupRuntime } from '../../../src/main/autoSearchWakeupRuntime/index.js';
import { createSeatActivationDispatcher } from '../../../src/main/seatActivationDispatcher/index.js';
import { timeWakeupEvaluationProgram } from '../../../src/main/timeWakeupEvaluationProgram/index.js';
import type { TimeWakeupEvaluationContext } from '../../../src/main/timeWakeupEvaluationProgram/types.js';
import { createAutoSearch } from '../../../src/services/autoSymbolManager/autoSearch.js';
import { createSeatStateManager } from '../../../src/services/autoSymbolManager/seatStateManager.js';
import { createSymbolRegistry } from '../../../src/services/autoSymbolManager/utils.js';
import type {
  SwitchState,
  SwitchSuppression,
} from '../../../src/services/autoSymbolManager/types.js';
import type {
  FindBestWarrantInput,
  WarrantCandidate,
} from '../../../src/services/autoSymbolFinder/types.js';
import type { SeatStateChangedEvent } from '../../../src/types/seat.js';
import type { LastState } from '../../../src/types/state.js';
import type { TradingConfig } from '../../../src/types/config.js';
import { createExternalApiRequestError } from '../../helpers/createExternalApiRequestError.js';
import { getHKDateKey } from '../../../src/utils/time/index.js';
import { createTradingGateEventRuntime } from '../../../src/main/tradingGateEventRuntime/index.js';
import type { DayLifecycleTickResult } from '../../../src/main/lifecycle/types.js';
import type { AutoSearchAuthorizationChangedEvent } from '../../../src/main/tradingGateEventRuntime/types.js';
import {
  createAccountSnapshotDouble,
  createAutoSymbolManagerDouble,
  createDoomsdayProtectionDouble,
  createMarketDataClientDouble,
  createMonitorConfigDouble,
  createMonitorContextDouble,
  createPositionCacheDouble,
  createQuoteSubscriptionRuntimeDouble,
  createTraderDouble,
} from '../../helpers/testDoubles.js';
import {
  createDirectionalAutoSearchPolicy,
  createFindBestWarrantInputDouble,
  createLoggerStub,
  createWarrantCandidate,
  getDefaultAutoSearchConfig,
} from '../../services/autoSymbolManager/utils.js';

type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}>;

type Finder = (input: FindBestWarrantInput) => Promise<WarrantCandidate | null>;

function createAutoSearchAuthorizationEventRuntimeHarness() {
  const authorizationListeners = new Set<(event: AutoSearchAuthorizationChangedEvent) => void>();

  return {
    port: {
      onAutoSearchAuthorizationChanged(
        listener: (event: AutoSearchAuthorizationChangedEvent) => void,
      ): () => void {
        authorizationListeners.add(listener);
        return () => {
          authorizationListeners.delete(listener);
        };
      },
    },
    emitAutoSearchAuthorizationChanged(event: AutoSearchAuthorizationChangedEvent): void {
      for (const listener of authorizationListeners) {
        listener(event);
      }
    },
  };
}

function createDeferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T | PromiseLike<T>) => void) | null = null;
  let rejectPromise: ((reason?: unknown) => void) | null = null;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  return {
    promise,
    resolve(value: T): void {
      if (resolvePromise === null) {
        throw new Error('deferred resolver is unavailable');
      }

      resolvePromise(value);
    },
    reject(reason: unknown): void {
      if (rejectPromise === null) {
        throw new Error('deferred rejecter is unavailable');
      }

      rejectPromise(reason);
    },
  };
}

function createRuntimeHarness(params: {
  readonly initialNowMs: number;
  readonly findBestWarrant: Finder;
  readonly searchFailCountToday?: number;
}) {
  let currentNowMs = params.initialNowMs;
  const monitorConfig = createMonitorConfigDouble({
    autoSearchConfig: getDefaultAutoSearchConfig(),
  });
  const symbolRegistry = createSymbolRegistry(monitorConfig);
  symbolRegistry.updateSeatState('LONG', {
    symbol: null,
    status: 'EMPTY',
    lastSwitchAt: null,
    lastSearchAt: null,
    lastSeatActivatedAt: null,
    callPrice: null,
    searchFailCountToday: params.searchFailCountToday ?? 0,
    frozenTradingDayKey: null,
  });

  symbolRegistry.updateSeatState('SHORT', {
    symbol: 'BEAR.HK',
    status: 'ACTIVE',
    lastSwitchAt: null,
    lastSearchAt: null,
    lastSeatActivatedAt: params.initialNowMs,
    callPrice: null,
    searchFailCountToday: 0,
    frozenTradingDayKey: null,
  });

  const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskDataMap>();
  const seatActivationDispatcher = createSeatActivationDispatcher({
    symbolRegistry,
    monitorTaskQueue,
  });
  seatActivationDispatcher.start();
  const seatStateManager = createSeatStateManager({
    symbolRegistry,
    switchStates: new Map<'LONG' | 'SHORT', SwitchState>(),
    switchSuppressions: new Map<'LONG' | 'SHORT', SwitchSuppression>(),
    now: () => new Date(currentNowMs),
    logger: createLoggerStub(),
    getHKDateKey,
  });
  const autoSearch = createAutoSearch({
    autoSearchConfig: monitorConfig.autoSearchConfig,
    monitorSymbol: monitorConfig.monitorSymbol,
    symbolRegistry,
    updateSeatState: seatStateManager.updateSeatState,
    resolveDirectionalAutoSearchPolicy: () => createDirectionalAutoSearchPolicy('LONG'),
    buildFindBestWarrantInput: async () => createFindBestWarrantInputDouble(),
    findBestWarrant: params.findBestWarrant,
    isWithinMorningAutoSearchOpenDelay: () => false,
    searchCooldownMs: 10_000,
    getHKDateKey,
    maxSearchFailuresPerDay: 3,
    logger: createLoggerStub(),
  });
  const monitorContext = createMonitorContextDouble({
    config: monitorConfig,
    symbolRegistry,
    autoSymbolManager: createAutoSymbolManagerDouble({
      maybeSearchOnEvent: (searchParams) => autoSearch.maybeSearchOnEvent(searchParams),
    }),
  });
  const lastState = {
    canTrade: true,
    isTradingEnabled: true,
    isHalfDay: false,
  };
  const tradingGateEventRuntime = createAutoSearchAuthorizationEventRuntimeHarness();
  const runtime = createAutoSearchWakeupRuntime({
    symbolRegistry,
    monitorContext,
    lastState,
    tradingGateEventRuntime: tradingGateEventRuntime.port,
    doomsdayProtectionEnabled: true,
    now: () => new Date(currentNowMs),
    scheduleTimer: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer: (handle) => {
      clearTimeout(handle);
    },
  });

  return {
    runtime,
    symbolRegistry,
    monitorTaskQueue,
    seatActivationDispatcher,
    lastState,
    tradingGateEventRuntime,
    setNow(nextNowMs: number): void {
      currentNowMs = nextNowMs;
    },
  };
}

describe('AutoSearchWakeupRuntime stale continuation business flow', () => {
  it('15:55 lifecycle await 期间 finder 先返回时，稍后的真实授权关闭仍清理 runtime-owned SEARCHING owner', async () => {
    let currentNowMs = Date.parse('2026-04-10T15:54:00.000+08:00');
    const finderStarted = createDeferred<null>();
    const staleCandidate = createDeferred<WarrantCandidate | null>();
    const lifecycleStarted = createDeferred<null>();
    const lifecycleResult = createDeferred<DayLifecycleTickResult>();
    const monitorConfig = createMonitorConfigDouble({
      autoSearchConfig: getDefaultAutoSearchConfig(),
    });
    const symbolRegistry = createSymbolRegistry(monitorConfig);
    symbolRegistry.updateSeatState('LONG', {
      symbol: null,
      status: 'EMPTY',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: null,
      callPrice: null,
      searchFailCountToday: 1,
      frozenTradingDayKey: null,
    });

    symbolRegistry.updateSeatState('SHORT', {
      symbol: 'BEAR.HK',
      status: 'ACTIVE',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: currentNowMs,
      callPrice: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    });

    const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const seatActivationDispatcher = createSeatActivationDispatcher({
      symbolRegistry,
      monitorTaskQueue,
    });
    seatActivationDispatcher.start();
    const seatStateManager = createSeatStateManager({
      symbolRegistry,
      switchStates: new Map<'LONG' | 'SHORT', SwitchState>(),
      switchSuppressions: new Map<'LONG' | 'SHORT', SwitchSuppression>(),
      now: () => new Date(currentNowMs),
      logger: createLoggerStub(),
      getHKDateKey,
    });
    const autoSearch = createAutoSearch({
      autoSearchConfig: monitorConfig.autoSearchConfig,
      monitorSymbol: monitorConfig.monitorSymbol,
      symbolRegistry,
      updateSeatState: seatStateManager.updateSeatState,
      resolveDirectionalAutoSearchPolicy: () => createDirectionalAutoSearchPolicy('LONG'),
      buildFindBestWarrantInput: async () => createFindBestWarrantInputDouble(),
      findBestWarrant: async () => {
        finderStarted.resolve(null);
        return staleCandidate.promise;
      },
      isWithinMorningAutoSearchOpenDelay: () => false,
      searchCooldownMs: 10_000,
      getHKDateKey,
      maxSearchFailuresPerDay: 3,
      logger: createLoggerStub(),
    });
    const monitorContext = createMonitorContextDouble({
      config: monitorConfig,
      symbolRegistry,
      autoSymbolManager: createAutoSymbolManagerDouble({
        maybeSearchOnEvent: (params) => autoSearch.maybeSearchOnEvent(params),
      }),
    });
    const lastState: LastState = {
      canTrade: true,
      isHalfDay: false,
      openProtectionActive: false,
      currentDayKey: '2026-04-10',
      lifecycleState: 'ACTIVE',
      pendingOpenRebuild: false,
      targetTradingDayKey: null,
      isTradingEnabled: true,
      cachedAccount: createAccountSnapshotDouble(100_000),
      cachedPositions: [],
      positionCache: createPositionCacheDouble(),
      cachedTradingDayInfo: {
        dateKey: '2026-04-10',
        info: { isTradingDay: true, isHalfDay: false },
      },
      tradingCalendarSnapshot: new Map([['2026-04-10', { isTradingDay: true, isHalfDay: false }]]),
      monitorState: monitorContext.state,
      allTradingSymbols: new Set<string>(),
    };
    const tradingGateEventRuntime = createTradingGateEventRuntime();
    const runtime = createAutoSearchWakeupRuntime({
      symbolRegistry,
      monitorContext,
      lastState,
      tradingGateEventRuntime,
      doomsdayProtectionEnabled: true,
      now: () => new Date(currentNowMs),
      scheduleTimer: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimer: (handle) => {
        clearTimeout(handle);
      },
    });
    const tradingConfig: TradingConfig = {
      monitor: monitorConfig,
      global: {
        doomsdayProtection: true,
        openProtection: {
          morning: { enabled: false, minutes: null },
          afternoon: { enabled: false, minutes: null },
        },
        orderMonitorPriceUpdateInterval: 1,
        allowBuyOrderTrackingAboveInitialPrice: false,
        tradingOrderType: 'ELO',
        liquidationOrderType: 'ELO',
        buyOrderTimeout: { enabled: false, timeoutSeconds: 0 },
        sellOrderTimeout: { enabled: false, timeoutSeconds: 0 },
      },
    };
    const timeWakeupContext: TimeWakeupEvaluationContext = {
      marketDataClient: createMarketDataClientDouble(),
      trader: createTraderDouble(),
      lastState,
      doomsdayProtection: createDoomsdayProtectionDouble(),
      tradingConfig,
      monitorContext,
      tradingGateEventRuntime,
      quoteSubscriptionRuntime: createQuoteSubscriptionRuntimeDouble(),
      dayLifecycleManager: {
        tick: async () => {
          lifecycleStarted.resolve(null);
          return lifecycleResult.promise;
        },
      },
      now: () => new Date(currentNowMs),
    };
    const activatingTransitions: SeatStateChangedEvent[] = [];
    const unsubscribe = symbolRegistry.onSeatStateChanged((event) => {
      if (event.nextState.status === 'ACTIVATING') {
        activatingTransitions.push(event);
      }
    });

    try {
      runtime.start();
      await finderStarted.promise;
      const originalVersion = symbolRegistry.getSeatVersion('LONG');
      expect(symbolRegistry.getSeatState('LONG').status).toBe('SEARCHING');

      currentNowMs = Date.parse('2026-04-10T15:55:00.000+08:00');
      const evaluation = timeWakeupEvaluationProgram(timeWakeupContext);
      await lifecycleStarted.promise;
      staleCandidate.resolve(createWarrantCandidate('DOOMSDAY_STALE_BULL.HK'));
      await Bun.sleep(0);
      expect(symbolRegistry.getSeatVersion('LONG')).toBe(originalVersion + 1);
      expect(symbolRegistry.getSeatState('LONG')).toMatchObject({
        symbol: null,
        status: 'EMPTY',
        searchFailCountToday: 1,
      });
      expect(activatingTransitions).toHaveLength(0);
      expect(monitorTaskQueue.isEmpty()).toBeTrue();

      lifecycleResult.resolve({ nextRetryAtMs: null, pendingOpenRebuild: false });
      await evaluation;

      expect(symbolRegistry.getSeatVersion('LONG')).toBe(originalVersion + 1);
      expect(symbolRegistry.getSeatState('LONG')).toMatchObject({
        symbol: null,
        status: 'EMPTY',
        searchFailCountToday: 1,
      });
      expect(activatingTransitions).toHaveLength(0);
      expect(monitorTaskQueue.isEmpty()).toBeTrue();
    } finally {
      staleCandidate.resolve(null);
      lifecycleResult.resolve({ nextRetryAtMs: null, pendingOpenRebuild: false });
      await runtime.stopAndDrain();
      seatActivationDispatcher.stop();
      unsubscribe();
    }
  });

  it('连续交易授权关闭原子取消运行时 SEARCHING owner，下午重开由新 owner 寻标', async () => {
    const morningSearchTime = Date.parse('2026-04-10T03:59:00.000Z');
    const staleCandidate = createDeferred<WarrantCandidate | null>();
    let finderCalls = 0;
    const harness = createRuntimeHarness({
      initialNowMs: morningSearchTime,
      searchFailCountToday: 2,
      findBestWarrant: async () => {
        finderCalls += 1;
        if (finderCalls === 1) {
          return staleCandidate.promise;
        }

        return createWarrantCandidate('AFTERNOON_BULL.HK');
      },
    });
    const activatingTransitions: SeatStateChangedEvent[] = [];
    const unsubscribe = harness.symbolRegistry.onSeatStateChanged((event) => {
      if (event.nextState.status === 'ACTIVATING') {
        activatingTransitions.push(event);
      }
    });

    try {
      harness.runtime.start();
      await Bun.sleep(0);
      expect(finderCalls).toBe(1);
      const originalVersion = harness.symbolRegistry.getSeatVersion('LONG');

      harness.setNow(Date.parse('2026-04-10T04:00:00.000Z'));
      harness.lastState.canTrade = false;
      harness.tradingGateEventRuntime.emitAutoSearchAuthorizationChanged({
        previousAuthorized: true,
        nextAuthorized: false,
      });

      expect(harness.symbolRegistry.getSeatVersion('LONG')).toBe(originalVersion + 1);
      expect(harness.symbolRegistry.getSeatState('LONG')).toMatchObject({
        symbol: null,
        status: 'EMPTY',
        lastSearchAt: morningSearchTime,
        searchFailCountToday: 2,
      });

      staleCandidate.resolve(createWarrantCandidate('STALE_BULL.HK'));
      await Bun.sleep(0);
      expect(activatingTransitions).toHaveLength(0);
      expect(harness.monitorTaskQueue.isEmpty()).toBeTrue();

      harness.setNow(Date.parse('2026-04-10T05:00:00.000Z'));
      harness.lastState.canTrade = true;
      harness.tradingGateEventRuntime.emitAutoSearchAuthorizationChanged({
        previousAuthorized: false,
        nextAuthorized: true,
      });
      await Bun.sleep(0);

      expect(finderCalls).toBe(2);
      expect(harness.symbolRegistry.getSeatState('LONG')).toMatchObject({
        symbol: 'AFTERNOON_BULL.HK',
        status: 'ACTIVATING',
        searchFailCountToday: 0,
      });
      expect(activatingTransitions).toHaveLength(1);
      expect(harness.monitorTaskQueue.pop()?.type).toBe('SEAT_REFRESH');
    } finally {
      staleCandidate.resolve(null);
      await harness.runtime.stopAndDrain();
      harness.seatActivationDispatcher.stop();
      unsubscribe();
    }
  });

  it('15:55 末日清仓接管原子取消 SEARCHING owner，旧候选不能产生 ACTIVATING 或 SEAT_REFRESH 前置事件', async () => {
    const searchTime = Date.parse('2026-04-10T07:54:00.000Z');
    const staleCandidate = createDeferred<WarrantCandidate | null>();
    let finderCalls = 0;
    const harness = createRuntimeHarness({
      initialNowMs: searchTime,
      searchFailCountToday: 1,
      findBestWarrant: async () => {
        finderCalls += 1;
        return staleCandidate.promise;
      },
    });
    const activatingTransitions: SeatStateChangedEvent[] = [];
    const unsubscribe = harness.symbolRegistry.onSeatStateChanged((event) => {
      if (event.nextState.status === 'ACTIVATING') {
        activatingTransitions.push(event);
      }
    });

    try {
      harness.runtime.start();
      await Bun.sleep(0);
      expect(finderCalls).toBe(1);
      const originalVersion = harness.symbolRegistry.getSeatVersion('LONG');

      harness.setNow(Date.parse('2026-04-10T07:55:00.000Z'));
      harness.tradingGateEventRuntime.emitAutoSearchAuthorizationChanged({
        previousAuthorized: true,
        nextAuthorized: false,
      });

      expect(harness.symbolRegistry.getSeatVersion('LONG')).toBe(originalVersion + 1);
      expect(harness.symbolRegistry.getSeatState('LONG')).toMatchObject({
        symbol: null,
        status: 'EMPTY',
        lastSearchAt: searchTime,
        searchFailCountToday: 1,
      });

      staleCandidate.resolve(createWarrantCandidate('DOOMSDAY_STALE_BULL.HK'));
      await Bun.sleep(0);

      expect(harness.symbolRegistry.getSeatState('LONG')).toMatchObject({
        symbol: null,
        status: 'EMPTY',
        searchFailCountToday: 1,
      });
      expect(activatingTransitions).toHaveLength(0);
      expect(harness.monitorTaskQueue.isEmpty()).toBeTrue();
    } finally {
      staleCandidate.resolve(null);
      await harness.runtime.stopAndDrain();
      harness.seatActivationDispatcher.stop();
      unsubscribe();
    }
  });

  it('lifecycle close 原子取消 SEARCHING owner，旧 null 结果不写入失败次数', async () => {
    const searchTime = Date.parse('2026-04-10T01:00:00.000Z');
    const nullResult = createDeferred<WarrantCandidate | null>();
    let finderCalls = 0;
    const harness = createRuntimeHarness({
      initialNowMs: searchTime,
      searchFailCountToday: 1,
      findBestWarrant: async () => {
        finderCalls += 1;
        return nullResult.promise;
      },
    });

    try {
      harness.runtime.start();
      await Bun.sleep(0);
      expect(finderCalls).toBe(1);
      const originalVersion = harness.symbolRegistry.getSeatVersion('LONG');

      harness.lastState.isTradingEnabled = false;
      harness.tradingGateEventRuntime.emitAutoSearchAuthorizationChanged({
        previousAuthorized: true,
        nextAuthorized: false,
      });
      nullResult.resolve(null);
      await Bun.sleep(0);

      expect(harness.symbolRegistry.getSeatVersion('LONG')).toBe(originalVersion + 1);
      expect(harness.symbolRegistry.getSeatState('LONG')).toMatchObject({
        symbol: null,
        status: 'EMPTY',
        searchFailCountToday: 1,
      });
    } finally {
      nullResult.resolve(null);
      await harness.runtime.stopAndDrain();
      harness.seatActivationDispatcher.stop();
    }
  });

  it('stopAndDrain 在等待 finder 时取消其 SEARCHING owner，旧候选不能回写', async () => {
    const searchTime = Date.parse('2026-04-10T01:00:00.000Z');
    const staleCandidate = createDeferred<WarrantCandidate | null>();
    let finderCalls = 0;
    const harness = createRuntimeHarness({
      initialNowMs: searchTime,
      searchFailCountToday: 2,
      findBestWarrant: async () => {
        finderCalls += 1;
        return staleCandidate.promise;
      },
    });
    const activatingTransitions: SeatStateChangedEvent[] = [];
    const unsubscribe = harness.symbolRegistry.onSeatStateChanged((event) => {
      if (event.nextState.status === 'ACTIVATING') {
        activatingTransitions.push(event);
      }
    });

    try {
      harness.runtime.start();
      await Bun.sleep(0);
      expect(finderCalls).toBe(1);
      const originalVersion = harness.symbolRegistry.getSeatVersion('LONG');

      const stopping = harness.runtime.stopAndDrain();
      expect(harness.symbolRegistry.getSeatVersion('LONG')).toBe(originalVersion + 1);
      expect(harness.symbolRegistry.getSeatState('LONG')).toMatchObject({
        symbol: null,
        status: 'EMPTY',
        lastSearchAt: searchTime,
        searchFailCountToday: 2,
      });

      staleCandidate.resolve(createWarrantCandidate('STOPPED_STALE_BULL.HK'));
      await stopping;
      expect(activatingTransitions).toHaveLength(0);
      expect(harness.monitorTaskQueue.isEmpty()).toBeTrue();
    } finally {
      staleCandidate.resolve(null);
      await harness.runtime.stopAndDrain();
      harness.seatActivationDispatcher.stop();
      unsubscribe();
    }
  });

  it('lifecycle close 之后外部错误不写入失败次数，内部错误仍进入 fatal channel', async () => {
    const searchTime = Date.parse('2026-04-10T01:00:00.000Z');
    const firstResult = createDeferred<WarrantCandidate | null>();
    const secondResult = createDeferred<WarrantCandidate | null>();
    let finderCalls = 0;
    const harness = createRuntimeHarness({
      initialNowMs: searchTime,
      searchFailCountToday: 1,
      findBestWarrant: async () => {
        finderCalls += 1;
        return finderCalls === 1 ? firstResult.promise : secondResult.promise;
      },
    });

    try {
      harness.runtime.start();
      await Bun.sleep(0);
      expect(finderCalls).toBe(1);

      harness.lastState.isTradingEnabled = false;
      harness.tradingGateEventRuntime.emitAutoSearchAuthorizationChanged({
        previousAuthorized: true,
        nextAuthorized: false,
      });

      firstResult.reject(
        await createExternalApiRequestError({
          operation: 'test.autoSearch.lifecycle-close',
          attempts: 1,
          cause: new Error('finder unavailable'),
        }),
      );
      await Bun.sleep(0);
      expect(harness.symbolRegistry.getSeatState('LONG')).toMatchObject({
        symbol: null,
        status: 'EMPTY',
        searchFailCountToday: 1,
      });

      harness.symbolRegistry.updateSeatStateWithVersionBump('LONG', {
        symbol: null,
        status: 'EMPTY',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        callPrice: null,
        searchFailCountToday: 1,
        frozenTradingDayKey: null,
      });
      harness.lastState.isTradingEnabled = true;
      harness.tradingGateEventRuntime.emitAutoSearchAuthorizationChanged({
        previousAuthorized: false,
        nextAuthorized: true,
      });
      await Bun.sleep(0);
      expect(finderCalls).toBe(2);

      const fatalErrorPromise = harness.runtime.drainFatalError().catch((error: unknown) => error);
      secondResult.reject(new TypeError('finder contract broken'));
      const fatalError = await fatalErrorPromise;
      expect(fatalError).toMatchObject({ message: 'finder contract broken' });
    } finally {
      firstResult.resolve(null);
      secondResult.resolve(null);
      await harness.runtime.stopAndDrain();
      harness.seatActivationDispatcher.stop();
    }
  });
});
