import { createDiagnosticObserverDouble } from '../../helpers/diagnostics.js';
import type { RuntimeStateFixtures } from '../../helpers/types.js';
import { createRuntimeStateFixtures } from '../../helpers/runtimeStateFixtures.js';

/** 自动寻标 wakeup 旧 owner 集成测试：授权关闭/停止同步失效，旧候选不能激活或触发刷新。 */
import {
  createEmptySnapshotFixture,
  createSnapshotFixture,
} from '../../helpers/accountPositionSnapshot.js';
import { createTerminationRuntime } from '../../../src/runtime/lifecycle/terminationRuntime.js';
import { beforeEach, describe, expect, it } from 'bun:test';
import { createMonitorTaskQueue } from '../../../src/runtime/asyncProgram/monitorTaskQueue/index.js';
import type { MonitorTaskDataMap } from '../../../src/runtime/asyncProgram/monitorTaskProcessor/types.js';
import { createAutoSearchWakeupRuntime } from '../../../src/runtime/autoSearchWakeupRuntime/index.js';
import { createSeatActivationDispatcher } from '../../../src/runtime/seatActivationDispatcher/index.js';
import { timeWakeupEvaluationProgram } from '../../../src/runtime/timeWakeupEvaluationProgram/index.js';
import type { TimeWakeupEvaluationContext } from '../../../src/runtime/timeWakeupEvaluationProgram/types.js';
import { createAutoSearch } from '../../../src/application/autoSearch/index.js';
import { createSymbolRegistry } from '../../../src/domain/seat/symbolRegistry.js';
import type { AutoSearchCandidate } from '../../../src/application/autoSearch/types.js';
import type { SeatStateChangedEvent } from '../../../src/types/seat.js';
import type { TradingConfig } from '../../../src/types/config.js';
import { createExternalApiRequestError } from '../../helpers/createExternalApiRequestError.js';
import { createTradingGateEventRuntime as createProductionTradingGateEventRuntime } from '../../../src/runtime/tradingGateEventRuntime/index.js';
import type {
  DayLifecycleTickResult,
  AutoSearchAuthorizationChangedEvent,
} from '../../../src/types/timeControlPlane.js';
import {
  createLoggerDouble,
  createDoomsdayClearanceWorkflowDouble,
  createMarketDataClientDouble,
  createMonitorConfigDouble,
  createMonitorContextDouble,
  createAccountSnapshotDouble,
  createTradeRuntimeDouble,
} from '../../helpers/testDoubles.js';
import {
  createDirectionalAutoSearchPolicy,
  createLoggerStub,
  createWarrantCandidate,
  getDefaultAutoSearchConfig,
} from '../../helpers/seatTestUtils.js';

let termination: ReturnType<typeof createTerminationRuntime>;
beforeEach(() => {
  termination = createTerminationRuntime({
    closeTradingGate: () => {},
    closeProducerAdmission: () => {},
    stopProducers: [],
    onSecondaryError: () => {},
  });
});

/**
 * AutoSearchWakeupRuntime 异步 owner 业务测试
 *
 * 覆盖：连续交易授权关闭、末日清仓接管、生命周期关闭与 stopAndDrain 必须使运行时拥有的
 * SEARCHING owner 失效；旧 finder 结果不能推进 ACTIVATING，因而不能产生 SEAT_REFRESH。
 */

function createTradingGateEventRuntime() {
  return createProductionTradingGateEventRuntime({ logger: createLoggerDouble() });
}

type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}>;

type Finder = () => Promise<AutoSearchCandidate | null>;

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

  const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskDataMap>({
    logger: createLoggerDouble(),
    clock: { now: () => new Date() },
    diagnostics: createDiagnosticObserverDouble(),
  });
  const seatActivationDispatcher = createSeatActivationDispatcher({
    logger: createLoggerDouble(),
    termination,
    snapshot: createEmptySnapshotFixture(),
    symbolRegistry,
    monitorTaskQueue,
  });
  seatActivationDispatcher.start();

  const autoSearch = createAutoSearch({
    autoSearchConfig: monitorConfig.autoSearchConfig,
    monitorSymbol: monitorConfig.monitorSymbol,
    symbolRegistry,
    candidateSearch: {
      resolveDistanceRange: () => createDirectionalAutoSearchPolicy('LONG').switchDistanceRange,
      findCandidate: params.findBestWarrant,
    },
    logger: createLoggerStub(),
  });

  const stateFixtures = createRuntimeStateFixtures({
    tradingTimeState: { canTrade: true, isHalfDay: false },
    lifecycleState: { isTradingEnabled: true },
    tradingCalendarState: {},
    quoteSubscriptionState: {},
  });
  const tradingGateEventRuntime = createAutoSearchAuthorizationEventRuntimeHarness();
  const runtime = createAutoSearchWakeupRuntime({
    termination,
    symbolRegistry,
    autoSearch,
    autoSearchConfig: monitorConfig.autoSearchConfig,
    ...stateFixtures,
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
    stateFixtures,
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
    const staleCandidate = createDeferred<AutoSearchCandidate | null>();
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

    const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskDataMap>({
      logger: createLoggerDouble(),
      clock: { now: () => new Date() },
      diagnostics: createDiagnosticObserverDouble(),
    });
    const seatActivationDispatcher = createSeatActivationDispatcher({
      logger: createLoggerDouble(),
      termination,
      snapshot: createEmptySnapshotFixture(),
      symbolRegistry,
      monitorTaskQueue,
    });
    seatActivationDispatcher.start();

    const autoSearch = createAutoSearch({
      autoSearchConfig: monitorConfig.autoSearchConfig,
      monitorSymbol: monitorConfig.monitorSymbol,
      symbolRegistry,
      candidateSearch: {
        resolveDistanceRange: () => createDirectionalAutoSearchPolicy('LONG').switchDistanceRange,
        findCandidate: async () => {
          finderStarted.resolve(null);
          return staleCandidate.promise;
        },
      },
      logger: createLoggerStub(),
    });
    const monitorContext = createMonitorContextDouble({ config: monitorConfig, symbolRegistry });
    const stateFixtures: RuntimeStateFixtures = {
      tradingTimeState: { canTrade: true, isHalfDay: false, openProtectionActive: false },
      lifecycleState: {
        currentDayKey: '2026-04-10',
        lifecycleState: 'ACTIVE',
        pendingOpenRebuild: false,
        isTradingEnabled: true,
      },
      tradingCalendarState: {
        cachedTradingDayInfo: {
          dateKey: '2026-04-10',
          info: { isTradingDay: true, isHalfDay: false },
        },
        tradingCalendarSnapshot: new Map([
          ['2026-04-10', { isTradingDay: true, isHalfDay: false }],
        ]),
      },
      quoteSubscriptionState: { allTradingSymbols: new Set<string>() },
    };
    const tradingGateEventRuntime = createTradingGateEventRuntime();
    const runtime = createAutoSearchWakeupRuntime({
      termination,
      symbolRegistry,
      autoSearch,
      autoSearchConfig: monitorConfig.autoSearchConfig,
      ...stateFixtures,
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
      logger: createLoggerDouble(),
      marketDataClient: createMarketDataClientDouble(),
      ...createTradeRuntimeDouble(),
      ...stateFixtures,
      doomsdayClearanceWorkflow: createDoomsdayClearanceWorkflowDouble(),
      tradingConfig,
      monitorContext,
      tradingGateEventRuntime,
      snapshot: await createSnapshotFixture({
        account: createAccountSnapshotDouble('100000'),
        positions: [],
      }),
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
    const staleCandidate = createDeferred<AutoSearchCandidate | null>();
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
      harness.stateFixtures.tradingTimeState.canTrade = false;
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
      harness.stateFixtures.tradingTimeState.canTrade = true;
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
    const staleCandidate = createDeferred<AutoSearchCandidate | null>();
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
    const nullResult = createDeferred<AutoSearchCandidate | null>();
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

      harness.stateFixtures.lifecycleState.isTradingEnabled = false;
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
    const staleCandidate = createDeferred<AutoSearchCandidate | null>();
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
    const firstResult = createDeferred<AutoSearchCandidate | null>();
    const secondResult = createDeferred<AutoSearchCandidate | null>();
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

      harness.stateFixtures.lifecycleState.isTradingEnabled = false;
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
      harness.stateFixtures.lifecycleState.isTradingEnabled = true;
      harness.tradingGateEventRuntime.emitAutoSearchAuthorizationChanged({
        previousAuthorized: false,
        nextAuthorized: true,
      });
      await Bun.sleep(0);
      expect(finderCalls).toBe(2);

      const fatalErrorPromise = termination
        .waitForTermination()
        .then(() => {
          const state = termination.getFatalState();
          if (state.hasFatalError) throw state.error;
        })
        .catch((error: unknown) => error);
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
