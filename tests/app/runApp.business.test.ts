/**
 * runApp 业务测试
 *
 * 覆盖：
 * - 启动快照进入 pending open rebuild 时仍启动系统级时间唤醒，但不启动稳态实时链路
 * - 启动初始重建失败时仍启动系统级时间唤醒，并保持稳态实时链路静止
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { AsyncLocalStorage } from 'node:async_hooks';

import { createExternalApiRequestError } from '../helpers/createExternalApiRequestError.js';
import { createCleanup } from '../../src/app/shutdown/createCleanup.js';
import type {
  AppEnvironmentParams,
  AsyncRuntime,
  CreatePostGateRuntimeParams,
  CreatePreGateRuntimeParams,
  PostGateRuntime,
  PreGateRuntime,
  RunAppDeps,
} from '../../src/app/types.js';
import type {
  ProcessSellSignalsParams,
  SignalProcessor,
} from '../../src/core/signalProcessor/types.js';
import type { TaskQueue } from '../../src/main/asyncProgram/tradeTaskQueue/types.js';
import type {
  WarrantListCache,
  WarrantListCacheEntry,
  WarrantListItem,
} from '../../src/services/autoSymbolFinder/types.js';
import type { BuySignal, Signal } from '../../src/types/signal.js';
import type { LastState } from '../../src/types/state.js';
import type { BuyRiskCheckContext } from '../../src/types/services.js';
import {
  createAutoSearchWakeupRuntimeDouble,
  createDailyLossTrackerDouble,
  createDoomsdayProtectionDouble,
  createLiquidationCooldownTrackerDouble,
  createMarketDataClientDouble,
  createMonitorContextDouble,
  createPeriodicSwitchWakeupRuntimeDouble,
  createProtectiveLiquidationEpisodeTrackerDouble,
  createQuoteSubscriptionRuntimeDouble,
  createSdkConfigDouble,
  createSeatActivationDispatcherDouble,
  createSeatRuntimeCleanupDispatcherDouble,
  createSymbolRegistryDouble,
  createTraderDouble,
  createTradingGateEventRuntimeDouble,
} from '../helpers/testDoubles.js';
import { createTradingConfig } from '../../mock/factories/configFactory.js';

type RunAppScenario =
  | 'startupRebuildPending'
  | 'startupSnapshotFails'
  | 'initialRebuildApiFails'
  | 'initialRebuildFails'
  | 'initialRebuildSucceeds';

let currentScenario: RunAppScenario = 'startupRebuildPending';
let startupFailureApplyCount = 0;
let rebuildCallCount = 0;
let timeWakeupStartCount = 0;
let cleanupExecuteCount = 0;
let cleanupStopCount = 0;
let cleanupUnsubscribeCount = 0;
let cleanupResetCount = 0;
let steadyRuntimeStarts: string[] = [];
let runtimeStartSteps: string[] = [];

type RunAppFunction = (params: AppEnvironmentParams) => Promise<void>;

let runAppImportSequence = 0;
const runAppDepsContext = new AsyncLocalStorage<RunAppDeps>();

function requireActiveRunAppDeps(): RunAppDeps {
  const deps = runAppDepsContext.getStore();
  if (deps === undefined) {
    throw new Error('runApp deps mock used before harness initialization');
  }

  return deps;
}

const runAppDepsProxy: RunAppDeps = {
  createPreGateRuntime: (params) => requireActiveRunAppDeps().createPreGateRuntime(params),
  createPostGateRuntime: (params) => requireActiveRunAppDeps().createPostGateRuntime(params),
  loadStartupSnapshot: (params) => requireActiveRunAppDeps().loadStartupSnapshot(params),
  collectRuntimeValidationSymbols: (params) =>
    requireActiveRunAppDeps().collectRuntimeValidationSymbols(params),
  createRebuildTradingDayState: (deps) =>
    requireActiveRunAppDeps().createRebuildTradingDayState(deps),
  displayAccountAndPositions: (params) => {
    requireActiveRunAppDeps().displayAccountAndPositions(params);
  },
  registerDelayedSignalHandlers: (params) => {
    requireActiveRunAppDeps().registerDelayedSignalHandlers(params);
  },
  createBusinessEventProgram: (deps) => requireActiveRunAppDeps().createBusinessEventProgram(deps),
  createAsyncRuntime: (params) => requireActiveRunAppDeps().createAsyncRuntime(params),
  createLifecycleRuntime: (params, factories) =>
    requireActiveRunAppDeps().createLifecycleRuntime(params, factories),
  createCleanup: () => requireActiveRunAppDeps().createCleanup(),
  createTimeWakeupRuntime: (deps) => requireActiveRunAppDeps().createTimeWakeupRuntime(deps),
  waitForShutdownSignal: () => requireActiveRunAppDeps().waitForShutdownSignal(),
  logger: {
    debug: (...args) => {
      requireActiveRunAppDeps().logger.debug(...args);
    },
    info: (...args) => {
      requireActiveRunAppDeps().logger.info(...args);
    },
    warn: (...args) => {
      requireActiveRunAppDeps().logger.warn(...args);
    },
    error: (...args) => {
      requireActiveRunAppDeps().logger.error(...args);
    },
  },
  formatError: (error) => requireActiveRunAppDeps().formatError(error),
  validateRuntimeSymbolsFromQuotesMap: (params) =>
    requireActiveRunAppDeps().validateRuntimeSymbolsFromQuotesMap(params),
  applyStartupSnapshotFailureState: (lastState, now) => {
    requireActiveRunAppDeps().applyStartupSnapshotFailureState(lastState, now);
  },
};

function createMinimalLastState(): LastState {
  return {
    canTrade: false,
    isHalfDay: false,
    openProtectionActive: false,
    currentDayKey: '2026-04-29',
    lifecycleState: 'ACTIVE',
    pendingOpenRebuild: false,
    targetTradingDayKey: null,
    isTradingEnabled: true,
    cachedAccount: null,
    cachedPositions: [],
    positionCache: {
      update: () => {},
      get: () => null,
    },
    cachedTradingDayInfo: null,
    tradingCalendarSnapshot: new Map(),
    monitorState: {
      monitorSymbol: 'HSI.HK',
      lastMonitorSnapshot: null,
      incrementalIndicatorRuntime: null,
    },
    allTradingSymbols: new Set(),
  };
}

function recordSteadyRuntimeStart(name: string): void {
  steadyRuntimeStarts.push(name);
  runtimeStartSteps.push(name);
}

function createProcessorRecorder(name: string): AsyncRuntime['buyProcessor'] {
  return {
    start: () => {
      recordSteadyRuntimeStart(name);
    },
    stop: () => {},
    stopAndDrain: async () => {},
    restart: () => {},
  };
}

function createMonitorTaskProcessorRecorder(name: string): AsyncRuntime['monitorTaskProcessor'] {
  return {
    start: () => {
      recordSteadyRuntimeStart(name);
    },
    stopAndDrain: async () => {},
    restart: () => {},
  };
}

function createStartStopRecorder(name: string): {
  readonly start: () => void;
  readonly stopAndDrain: () => Promise<void>;
  readonly drainFatalError: () => Promise<never>;
} {
  return {
    start: () => {
      recordSteadyRuntimeStart(name);
    },
    stopAndDrain: async () => {},
    drainFatalError: () => new Promise<never>(() => {}),
  };
}

function noop(): void {}

function noopAsync(): void {}

function createTradeTaskQueueDouble<TType extends string>(): TaskQueue<TType> {
  return {
    push: () => {},
    pop: () => null,
    isEmpty: () => true,
    removeTasks: () => 0,
    clearAll: () => 0,
    onTaskAdded: () => noop,
  };
}

function createMonitorTaskQueueDouble(): PostGateRuntime['monitorTaskQueue'] {
  return {
    scheduleLatest: () => {},
    pop: () => null,
    isEmpty: () => true,
    removeTasks: () => 0,
    clearAll: () => 0,
    onTaskAdded: () => noop,
  };
}

function createMockPreGateRuntime(): PreGateRuntime {
  const warrantListEntries = new Map<string, WarrantListCacheEntry>();
  const warrantListInFlight = new Map<string, Promise<ReadonlyArray<WarrantListItem>>>();
  const warrantListCache: WarrantListCache = {
    getEntry: (key) => warrantListEntries.get(key),
    setEntry: (key, entry) => {
      warrantListEntries.set(key, entry);
    },
    getInFlight: (key) => warrantListInFlight.get(key),
    setInFlight: (key, request) => {
      warrantListInFlight.set(key, request);
    },
    deleteInFlight: (key) => {
      warrantListInFlight.delete(key);
    },
    clear: () => {
      warrantListEntries.clear();
      warrantListInFlight.clear();
    },
  };

  return {
    config: createSdkConfigDouble(),
    tradingConfig: createTradingConfig({
      global: {
        doomsdayProtection: true,
        debug: false,
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
    }),
    symbolRegistry: createSymbolRegistryDouble(),
    warrantListCache,
    warrantListCacheConfig: {
      cache: warrantListCache,
      ttlMs: 60_000,
      nowMs: () => 0,
    },
    marketDataClient: createMarketDataClientDouble(),
    startupTradingDayInfo: null,
  };
}

function createMockPostGateRuntime(
  lastState: LastState,
  monitorContext: PostGateRuntime['monitorContext'],
  autoSearchFatalPromise: Promise<never> = new Promise<never>(() => {}),
  postTradeFatalPromise: Promise<never> = new Promise<never>(() => {}),
  postGateFatalPromise: Promise<never> = new Promise<never>(() => {}),
): PostGateRuntime {
  const signalProcessor: SignalProcessor = {
    processSellSignals: ({ signals }: ProcessSellSignalsParams): Signal[] => signals,
    applyRiskChecks: async (
      signals: ReadonlyArray<BuySignal>,
      _context: BuyRiskCheckContext,
    ): Promise<ReadonlyArray<BuySignal>> => signals,
    resetRiskCheckCooldown: () => {},
  };

  const quoteSubscriptionRuntime = createQuoteSubscriptionRuntimeDouble({
    reconcileFromCurrentTruth: async () => {
      recordSteadyRuntimeStart('quoteSubscriptionRuntime.reconcileFromCurrentTruth');
    },
    start: () => {
      recordSteadyRuntimeStart('quoteSubscriptionRuntime.start');
    },
  });
  const trader = createTraderDouble({
    startOrderMonitorRuntime: () => {
      recordSteadyRuntimeStart('trader.startOrderMonitorRuntime');
    },
  });

  return {
    liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
    dailyLossTracker: createDailyLossTrackerDouble(),
    protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
    monitorContext,
    tradingGateEventRuntime: createTradingGateEventRuntimeDouble({
      onGateStateChanged: () => noop,
    }),
    quoteSubscriptionRuntime,
    seatActivationDispatcher: createSeatActivationDispatcherDouble({
      start: () => {
        recordSteadyRuntimeStart('seatActivationDispatcher.start');
      },
    }),
    seatRuntimeCleanupDispatcher: createSeatRuntimeCleanupDispatcherDouble({
      start: () => {
        recordSteadyRuntimeStart('seatRuntimeCleanupDispatcher.start');
      },
    }),
    autoSearchWakeupRuntime: createAutoSearchWakeupRuntimeDouble({
      start: () => {
        recordSteadyRuntimeStart('autoSearchWakeupRuntime.start');
      },
      drainFatalError: () => autoSearchFatalPromise,
    }),
    periodicSwitchWakeupRuntime: createPeriodicSwitchWakeupRuntimeDouble({
      start: () => {
        recordSteadyRuntimeStart('periodicSwitchWakeupRuntime.start');
      },
    }),
    tradingRiskEventRuntime: createStartStopRecorder('tradingRiskEventRuntime.start'),
    monitorQuoteEventRuntime: createStartStopRecorder('monitorQuoteEventRuntime.start'),
    monitorDisplayRuntime: {
      ...createStartStopRecorder('monitorDisplayRuntime.start'),
      requestRender: () => {},
    },
    tradingQuoteDisplayRuntime: createStartStopRecorder('tradingQuoteDisplayRuntime.start'),
    switchWakeupRuntime: {
      ...createStartStopRecorder('switchWakeupRuntime.start'),
      handoffPendingSwitch: () => {},
    },
    postTradeConsistencyRuntime: {
      bindBusinessDeps: noop,
      recordSettlementRefreshNeed: () => {},
      getStatus: () => ({ started: false, currentVersion: 0, staleVersion: 0 }),
      waitForFresh: async () => {},
      onFreshReached: () => noop,
      abortWaiting: () => {},
      resetAbort: () => {},
      start: () => {
        recordSteadyRuntimeStart('postTradeConsistencyRuntime.start');
      },
      completeRebuildBaseline: () => {
        recordSteadyRuntimeStart('postTradeConsistencyRuntime.completeRebuildBaseline');
      },
      drainFatalError: () => postTradeFatalPromise,
      stopAndDrain: async () => {},
      midnightClear: () => {},
    },
    lastState,
    trader,
    loadTradingDayRuntimeSnapshot: async () => ({ allOrders: [], quotesMap: new Map() }),
    doomsdayProtection: createDoomsdayProtectionDouble(),
    signalProcessor,
    indicatorCache: {
      push: () => {},
      getClosest: () => null,
      clearAll: () => {},
    },
    buyTaskQueue: createTradeTaskQueueDouble(),
    sellTaskQueue: createTradeTaskQueueDouble(),
    monitorTaskQueue: createMonitorTaskQueueDouble(),
    drainFatalError: () => postGateFatalPromise,
  };
}

function createMockAsyncRuntime(): AsyncRuntime {
  return {
    monitorTaskProcessor: createMonitorTaskProcessorRecorder('monitorTaskProcessor.start'),
    buyProcessor: createProcessorRecorder('buyProcessor.start'),
    sellProcessor: createProcessorRecorder('sellProcessor.start'),
    drainFatalError: () => new Promise<never>(() => {}),
  };
}

function createShutdownController(): {
  readonly waitForShutdownSignal: () => Promise<void>;
  readonly triggerShutdown: () => void;
} {
  let resolveShutdown: (() => void) | null = null;
  const shutdownPromise = new Promise<void>((resolve) => {
    resolveShutdown = resolve;
  });

  return {
    waitForShutdownSignal: () => shutdownPromise,
    triggerShutdown: () => {
      resolveShutdown?.();
    },
  };
}

function createRunAppHarnessState(
  options: {
    readonly rejectTimeWakeupDuringStart?: boolean;
    readonly cleanupError?: Error;
    readonly runtimeValidationValid?: boolean;
    readonly wiringError?: Error;
    readonly postGateMonitorContext?: PostGateRuntime['monitorContext'];
  } = {},
) {
  const lastState = createMinimalLastState();
  const shutdownController = createShutdownController();
  let rejectTimeWakeupFatal: ((error: Error) => void) | null = null;
  let rejectAutoSearchFatal: ((error: Error) => void) | null = null;
  let rejectBusinessEventFatal: ((error: Error) => void) | null = null;
  let rejectPostTradeFatal: ((error: Error) => void) | null = null;
  let rejectPostGateFatal: ((error: Error) => void) | null = null;
  const timeWakeupFatalPromise = new Promise<never>((_, reject) => {
    rejectTimeWakeupFatal = reject;
  });
  const autoSearchFatalPromise = new Promise<never>((_, reject) => {
    rejectAutoSearchFatal = reject;
  });
  const businessEventFatalPromise = new Promise<never>((_, reject) => {
    rejectBusinessEventFatal = reject;
  });
  const postTradeFatalPromise = new Promise<never>((_, reject) => {
    rejectPostTradeFatal = reject;
  });
  const postGateFatalPromise = new Promise<never>((_, reject) => {
    rejectPostGateFatal = reject;
  });
  void timeWakeupFatalPromise.catch(() => {});
  void autoSearchFatalPromise.catch(() => {});
  void businessEventFatalPromise.catch(() => {});
  void postTradeFatalPromise.catch(() => {});
  void postGateFatalPromise.catch(() => {});
  const deps = {
    createPreGateRuntime: async ({ cleanup }: CreatePreGateRuntimeParams) => {
      cleanup.register({
        phase: 'CLOSE_TRADING_GATE',
        step: '记录 cleanup 执行',
        handler: () => {
          cleanupExecuteCount += 1;
        },
      });

      cleanup.register({
        phase: 'RESET_MARKET_DATA_RUNTIME',
        step: '重置测试行情资源',
        handler: () => {
          cleanupResetCount += 1;
        },
      });
      return createMockPreGateRuntime();
    },
    createPostGateRuntime: async ({ cleanup }: CreatePostGateRuntimeParams) => {
      cleanup.register({
        phase: 'STOP_ORDER_MONITOR_RUNTIME',
        step: '停止测试订单监控',
        handler: () => {
          cleanupStopCount += 1;
        },
      });

      cleanup.register({
        phase: 'UNSUBSCRIBE_TRADER_LISTENER',
        step: '取消测试 Trader 监听',
        handler: () => {
          cleanupUnsubscribeCount += 1;
        },
      });

      if (options.cleanupError !== undefined) {
        cleanup.register({
          phase: 'CLEAR_INDICATOR_CACHE',
          step: '释放失败的测试资源',
          handler: () => {
            const cleanupError = options.cleanupError;
            if (cleanupError === undefined) {
              throw new Error('[测试] cleanup error 未按预期配置');
            }

            throw cleanupError;
          },
        });
      }

      const runtime = createMockPostGateRuntime(
        lastState,
        options.postGateMonitorContext ?? createMonitorContextDouble(),
        autoSearchFatalPromise,
        postTradeFatalPromise,
        postGateFatalPromise,
      );
      return runtime;
    },
    loadStartupSnapshot: async () => {
      const now = new Date('2026-04-29T09:30:00.000+08:00');
      if (currentScenario === 'startupSnapshotFails') {
        throw new TypeError('startup snapshot contract broken');
      }

      if (currentScenario === 'startupRebuildPending') {
        return { kind: 'API_RETRY_PENDING', now };
      }

      return {
        kind: 'READY',
        allOrders: [],
        quotesMap: new Map(),
        now,
      };
    },
    collectRuntimeValidationSymbols: () => ({
      runtimeValidationInputs: [],
    }),
    createRebuildTradingDayState: () => async () => {
      rebuildCallCount += 1;
      if (currentScenario === 'initialRebuildApiFails') {
        throw await createExternalApiRequestError({
          operation: 'test.initialRebuild',
          attempts: 1,
          cause: new Error('initial rebuild api unavailable'),
        });
      }

      if (currentScenario === 'initialRebuildFails') {
        throw new TypeError('initial rebuild contract broken');
      }
    },
    displayAccountAndPositions: noopAsync,
    registerDelayedSignalHandlers: noop,
    createBusinessEventProgram: () => {
      if (options.wiringError !== undefined) {
        throw options.wiringError;
      }

      return {
        ...createStartStopRecorder('businessEventProgram.start'),
        drainFatalError: () => businessEventFatalPromise,
      };
    },
    createAsyncRuntime: () => createMockAsyncRuntime(),
    createLifecycleRuntime: () => ({
      tick: async () => ({ nextRetryAtMs: null, pendingOpenRebuild: false }),
    }),
    createCleanup,
    waitForShutdownSignal: shutdownController.waitForShutdownSignal,
    createTimeWakeupRuntime: () => ({
      start: async () => {
        timeWakeupStartCount += 1;
        runtimeStartSteps.push('timeWakeupRuntime.start.begin');
        if (options.rejectTimeWakeupDuringStart === true) {
          rejectTimeWakeupFatal?.(new Error('time wakeup initial fatal'));
        }

        await Promise.resolve();
        runtimeStartSteps.push('timeWakeupRuntime.start.end');
      },
      stopAndDrain: async () => {},
      drainFatalError: () => timeWakeupFatalPromise,
    }),
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    formatError: String,
    validateRuntimeSymbolsFromQuotesMap: () => ({
      valid: options.runtimeValidationValid ?? true,
      warnings: [],
      errors: options.runtimeValidationValid === false ? ['runtime symbol invalid'] : [],
    }),
    applyStartupSnapshotFailureState: () => {
      startupFailureApplyCount += 1;
    },
  } satisfies RunAppDeps;

  return {
    deps,
    triggerShutdown: shutdownController.triggerShutdown,
    triggerTimeWakeupFatal: (error: Error) => {
      rejectTimeWakeupFatal?.(error);
    },
    triggerAutoSearchFatal: (error: Error) => {
      rejectAutoSearchFatal?.(error);
    },
    triggerBusinessEventFatal: (error: Error) => {
      rejectBusinessEventFatal?.(error);
    },
    triggerPostTradeFatal: (error: Error) => {
      rejectPostTradeFatal?.(error);
    },
    triggerPostGateFatal: (error: Error) => {
      rejectPostGateFatal?.(error);
    },
  };
}

function createRunAppHarness(options: Parameters<typeof createRunAppHarnessState>[0] = {}) {
  const harnessState = createRunAppHarnessState(options);
  const runApp: RunAppFunction = (params) =>
    runAppDepsContext.run(harnessState.deps, async () => {
      mock.module('../../src/app/runAppDeps.js', () => ({
        DEFAULT_RUN_APP_DEPS: runAppDepsProxy,
      }));
      const importedModule = await import(
        `../../src/app/runApp.js?run-app-test=${runAppImportSequence++}`
      );
      const importedRunApp = importedModule.runApp as RunAppFunction;
      return importedRunApp(params);
    });

  return {
    runApp,
    triggerShutdown: harnessState.triggerShutdown,
    triggerTimeWakeupFatal: harnessState.triggerTimeWakeupFatal,
    triggerAutoSearchFatal: harnessState.triggerAutoSearchFatal,
    triggerBusinessEventFatal: harnessState.triggerBusinessEventFatal,
    triggerPostTradeFatal: harnessState.triggerPostTradeFatal,
    triggerPostGateFatal: harnessState.triggerPostGateFatal,
  };
}

async function flushMicrotasks(times: number): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }

  await Bun.sleep(0);
}

async function waitForSteadyRuntimeStart(name: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (steadyRuntimeStarts.includes(name)) {
      return;
    }

    await Bun.sleep(1);
  }

  throw new Error(`[测试] 未等到稳态运行时启动: ${name}`);
}

async function expectPromiseRejectsWithMessage(
  promise: Promise<unknown>,
  expectedMessagePattern: RegExp,
): Promise<Error> {
  try {
    await promise;
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

async function runAppAndTriggerShutdown(
  runApp: RunAppFunction,
  triggerShutdown: () => void,
): Promise<void> {
  const runPromise = runApp({ env: {} });
  await flushMicrotasks(20);
  triggerShutdown();
  await runPromise;
}

describe.serial('runApp business flow', () => {
  beforeEach(() => {
    currentScenario = 'startupRebuildPending';
    startupFailureApplyCount = 0;
    rebuildCallCount = 0;
    timeWakeupStartCount = 0;
    cleanupExecuteCount = 0;
    cleanupStopCount = 0;
    cleanupUnsubscribeCount = 0;
    cleanupResetCount = 0;
    steadyRuntimeStarts = [];
    runtimeStartSteps = [];
  });

  it('cleans acquired resources exactly once and preserves AppStartupAbortError on runtime validation failure', async () => {
    currentScenario = 'initialRebuildSucceeds';
    const harness = createRunAppHarness({
      runtimeValidationValid: false,
      cleanupError: new Error('cleanup failed during startup abort'),
    });

    const error = await expectPromiseRejectsWithMessage(
      harness.runApp({ env: {} }),
      /运行时标的验证失败，启动已中止/,
    );

    expect(error.name).toBe('AppStartupAbortError');
    expect(cleanupExecuteCount).toBe(1);
    expect(cleanupStopCount).toBe(1);
    expect(cleanupUnsubscribeCount).toBe(1);
    expect(cleanupResetCount).toBe(1);
  });

  it('cleans acquired resources exactly once when startup snapshot throws a non API error', async () => {
    currentScenario = 'startupSnapshotFails';
    const harness = createRunAppHarness();

    await expectPromiseRejectsWithMessage(
      harness.runApp({ env: {} }),
      /startup snapshot contract broken/,
    );

    expect(cleanupExecuteCount).toBe(1);
    expect(cleanupStopCount).toBe(1);
    expect(cleanupUnsubscribeCount).toBe(1);
    expect(cleanupResetCount).toBe(1);
  });

  it('cleans acquired resources exactly once when wiring fails after runtime validation', async () => {
    currentScenario = 'initialRebuildSucceeds';
    const harness = createRunAppHarness({ wiringError: new Error('business wiring failed') });

    await expectPromiseRejectsWithMessage(harness.runApp({ env: {} }), /business wiring failed/);

    expect(cleanupExecuteCount).toBe(1);
    expect(cleanupStopCount).toBe(1);
    expect(cleanupUnsubscribeCount).toBe(1);
    expect(cleanupResetCount).toBe(1);
  });

  it('starts only time wakeup runtime when startup snapshot stays pending open rebuild', async () => {
    currentScenario = 'startupRebuildPending';
    const harness = createRunAppHarness();

    await runAppAndTriggerShutdown(harness.runApp, harness.triggerShutdown);

    expect(rebuildCallCount).toBe(0);
    expect(startupFailureApplyCount).toBe(0);
    expect(timeWakeupStartCount).toBe(1);
    expect(cleanupExecuteCount).toBe(1);
    expect(steadyRuntimeStarts).toEqual([]);
  });

  it('propagates cleanup AggregateError after normal shutdown when an acquired resource disposer fails', async () => {
    currentScenario = 'startupRebuildPending';
    const cleanupFailure = new Error('normal shutdown disposer failed');
    const harness = createRunAppHarness({ cleanupError: cleanupFailure });
    const runPromise = harness.runApp({ env: {} });

    await flushMicrotasks(20);
    harness.triggerShutdown();
    const error = await expectPromiseRejectsWithMessage(runPromise, /资源清理失败，共 1 处/);

    expect(error).toBeInstanceOf(AggregateError);
    if (!(error instanceof AggregateError)) {
      throw new Error('[测试] runApp 应传播 cleanup AggregateError');
    }

    expect(error.errors).toEqual([cleanupFailure]);
    expect(cleanupExecuteCount).toBe(1);
    expect(cleanupStopCount).toBe(1);
    expect(cleanupUnsubscribeCount).toBe(1);
    expect(cleanupResetCount).toBe(1);
  });

  it('starts only time wakeup runtime when initial rebuild API request fails after snapshot success', async () => {
    currentScenario = 'initialRebuildApiFails';
    const harness = createRunAppHarness();

    await runAppAndTriggerShutdown(harness.runApp, harness.triggerShutdown);

    expect(rebuildCallCount).toBe(1);
    expect(startupFailureApplyCount).toBe(1);
    expect(timeWakeupStartCount).toBe(1);
    expect(cleanupExecuteCount).toBe(1);
    expect(steadyRuntimeStarts).toEqual([]);
  });

  it('fails fast when initial rebuild throws a non API error after snapshot success', async () => {
    currentScenario = 'initialRebuildFails';
    const harness = createRunAppHarness();

    await expectPromiseRejectsWithMessage(
      harness.runApp({ env: {} }),
      /initial rebuild contract broken/,
    );

    expect(rebuildCallCount).toBe(1);
    expect(startupFailureApplyCount).toBe(0);
    expect(timeWakeupStartCount).toBe(0);
    expect(cleanupExecuteCount).toBe(1);
    expect(steadyRuntimeStarts).toEqual([]);
  });

  it('time wakeup fatal triggers cleanup and propagates the error', async () => {
    currentScenario = 'startupRebuildPending';
    const harness = createRunAppHarness();
    const runPromise = harness.runApp({ env: {} });

    await flushMicrotasks(20);
    harness.triggerTimeWakeupFatal(new Error('time wakeup fatal'));

    await expectPromiseRejectsWithMessage(runPromise, /time wakeup fatal/);
    expect(cleanupExecuteCount).toBe(1);
  });

  it('auto search fatal triggers cleanup and propagates the error', async () => {
    currentScenario = 'initialRebuildSucceeds';
    const harness = createRunAppHarness();
    const runPromise = harness.runApp({ env: {} });

    await flushMicrotasks(20);
    harness.triggerAutoSearchFatal(new Error('auto search fatal'));

    await expectPromiseRejectsWithMessage(runPromise, /auto search fatal/);
    expect(cleanupExecuteCount).toBe(1);
  });

  it('business event fatal triggers cleanup and propagates the error', async () => {
    currentScenario = 'initialRebuildSucceeds';
    const harness = createRunAppHarness();
    const runPromise = harness.runApp({ env: {} });

    await flushMicrotasks(20);
    harness.triggerBusinessEventFatal(new Error('business event fatal'));

    await expectPromiseRejectsWithMessage(runPromise, /business event fatal/);
    expect(cleanupExecuteCount).toBe(1);
  });

  it('post-gate runtime fatal triggers cleanup and propagates the error', async () => {
    currentScenario = 'initialRebuildSucceeds';
    const harness = createRunAppHarness();
    const runPromise = harness.runApp({ env: {} });

    await waitForSteadyRuntimeStart('monitorQuoteEventRuntime.start');
    harness.triggerPostGateFatal(new Error('post gate fatal'));

    await expectPromiseRejectsWithMessage(runPromise, /post gate fatal/);
    expect(cleanupExecuteCount).toBe(1);
  });

  it('post-trade consistency fatal triggers cleanup and propagates the error', async () => {
    currentScenario = 'initialRebuildSucceeds';
    const harness = createRunAppHarness();
    const runPromise = harness.runApp({ env: {} });

    await waitForSteadyRuntimeStart('monitorQuoteEventRuntime.start');
    harness.triggerPostTradeFatal(new Error('post trade fatal'));

    await expectPromiseRejectsWithMessage(runPromise, /post trade fatal/);
    expect(cleanupExecuteCount).toBe(1);
  });

  it('time wakeup fatal during initial evaluation prevents ordinary K line business events', async () => {
    currentScenario = 'initialRebuildSucceeds';
    const harness = createRunAppHarness({ rejectTimeWakeupDuringStart: true });

    await expectPromiseRejectsWithMessage(harness.runApp({ env: {} }), /time wakeup initial fatal/);

    expect(cleanupExecuteCount).toBe(1);
    expect(steadyRuntimeStarts).not.toContain('businessEventProgram.start');
  });

  it('time wakeup fatal remains the propagated error when cleanup also fails', async () => {
    currentScenario = 'startupRebuildPending';
    const harness = createRunAppHarness({ cleanupError: new Error('cleanup failed') });
    const runPromise = harness.runApp({ env: {} });

    await flushMicrotasks(20);
    harness.triggerTimeWakeupFatal(new Error('time wakeup fatal before cleanup'));

    await expectPromiseRejectsWithMessage(runPromise, /time wakeup fatal before cleanup/);
    expect(cleanupExecuteCount).toBe(1);
  });

  it('awaits initial time wakeup evaluation before starting ordinary K line business events', async () => {
    currentScenario = 'initialRebuildSucceeds';
    const harness = createRunAppHarness();

    await runAppAndTriggerShutdown(harness.runApp, harness.triggerShutdown);

    const timeWakeupEvaluatedIndex = runtimeStartSteps.indexOf('timeWakeupRuntime.start.end');
    const businessEventStartIndex = runtimeStartSteps.indexOf('businessEventProgram.start');
    expect(timeWakeupStartCount).toBe(1);
    expect(timeWakeupEvaluatedIndex).toBeGreaterThan(-1);
    expect(businessEventStartIndex).toBeGreaterThan(timeWakeupEvaluatedIndex);
    expect(runtimeStartSteps).toContain('trader.startOrderMonitorRuntime');
  });

  it('reuses the post-gate monitorContext during runApp assembly', async () => {
    currentScenario = 'initialRebuildSucceeds';
    const harness = createRunAppHarness({
      postGateMonitorContext: createMonitorContextDouble({
        monitorSymbolName: '',
        longSymbolName: '',
        shortSymbolName: '',
      }),
    });

    await runAppAndTriggerShutdown(harness.runApp, harness.triggerShutdown);
  });
});
