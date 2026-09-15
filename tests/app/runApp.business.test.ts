import type { RuntimeTermination } from '../../src/types/runtime.js';

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
  ProcessedSellSignal,
  ProcessSellSignalsParams,
  SignalProcessor,
} from '../../src/core/signalProcessor/types.js';
import type { TaskQueue } from '../../src/main/asyncProgram/tradeTaskQueue/types.js';
import { createWarrantListCache } from '../../src/services/autoSymbolFinder/utils.js';
import type { BuySignal } from '../../src/types/signal.js';
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
  prepareStrategy: (params) => requireActiveRunAppDeps().prepareStrategy(params),
  subscribeShutdownSignal: (callback) =>
    requireActiveRunAppDeps().subscribeShutdownSignal(callback),
  createBusinessEventProgram: (deps) => requireActiveRunAppDeps().createBusinessEventProgram(deps),
  createAsyncRuntime: (params) => requireActiveRunAppDeps().createAsyncRuntime(params),
  createLifecycleRuntime: (params, factories) =>
    requireActiveRunAppDeps().createLifecycleRuntime(params, factories),
  createCleanup: () => requireActiveRunAppDeps().createCleanup(),
  createTimeWakeupRuntime: (deps) => requireActiveRunAppDeps().createTimeWakeupRuntime(deps),
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
  applyStartupSnapshotFailureState: (lastState) => {
    requireActiveRunAppDeps().applyStartupSnapshotFailureState(lastState);
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
    isTradingEnabled: true,
    cachedAccount: null,
    cachedPositions: [],
    positionCache: {
      update: () => {},
      get: () => null,
    },
    cachedTradingDayInfo: null,
    tradingCalendarSnapshot: new Map(),
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

function createStartStopRecorder(name: string): {
  readonly start: () => void;
  readonly stopAndDrain: () => Promise<void>;
  readonly stop: () => void;
} {
  return {
    start: () => {
      recordSteadyRuntimeStart(name);
    },
    stop: () => {},
    stopAndDrain: async () => {},
  };
}

function noop(): void {}

function noopAsync(): void {}

function createTradeTaskQueueDouble<TType extends string>(): TaskQueue<TType> {
  return {
    push: () => true,
    close: () => {},
    pop: () => null,
    isEmpty: () => true,
    removeTasks: () => 0,
    clearAll: () => 0,
    onTaskAdded: () => noop,
  };
}

function createMonitorTaskQueueDouble(): PostGateRuntime['monitorTaskQueue'] {
  return {
    scheduleLatest: () => true,
    close: () => {},
    pop: () => null,
    isEmpty: () => true,
    removeTasks: () => 0,
    clearAll: () => 0,
    onTaskAdded: () => noop,
  };
}

function createMockPreGateRuntime(): PreGateRuntime {
  const warrantListCache = createWarrantListCache();

  return {
    config: createSdkConfigDouble(),
    tradingConfig: createTradingConfig({
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
    }),
    symbolRegistry: createSymbolRegistryDouble(),
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
): PostGateRuntime {
  const signalProcessor: SignalProcessor = {
    processSellSignals: ({
      signals,
    }: ProcessSellSignalsParams): ReadonlyArray<ProcessedSellSignal> => signals,
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
      stopScheduling: () => {},
      abortWaiting: () => {},
      resetAbort: () => {},
      start: () => {
        recordSteadyRuntimeStart('postTradeConsistencyRuntime.start');
      },
      completeRebuildBaseline: () => {
        recordSteadyRuntimeStart('postTradeConsistencyRuntime.completeRebuildBaseline');
      },
      stopAndDrain: async () => {},
      midnightClear: () => {},
    },
    lastState,
    trader,
    loadTradingDayRuntimeSnapshot: async () => ({ allOrders: [], quotesMap: new Map() }),
    doomsdayProtection: createDoomsdayProtectionDouble(),
    signalProcessor,
    buyTaskQueue: createTradeTaskQueueDouble(),
    sellTaskQueue: createTradeTaskQueueDouble(),
    monitorTaskQueue: createMonitorTaskQueueDouble(),
  };
}

function createMockAsyncRuntime(): AsyncRuntime {
  return {
    monitorTaskProcessor: createProcessorRecorder('monitorTaskProcessor.start'),
    buyProcessor: createProcessorRecorder('buyProcessor.start'),
    sellProcessor: createProcessorRecorder('sellProcessor.start'),
  };
}

function createShutdownController() {
  let onShutdown: (() => void) | null = null;
  return {
    subscribeShutdownSignal: (callback: () => void) => {
      onShutdown = callback;
      return () => {
        onShutdown = null;
      };
    },
    triggerShutdown: () => {
      onShutdown?.();
    },
  };
}

function createRunAppHarnessState(
  options: {
    readonly deps?: Partial<RunAppDeps>;
    readonly rejectTimeWakeupDuringStart?: boolean;
    readonly cleanupError?: Error;
    readonly runtimeValidationValid?: boolean;
    readonly wiringError?: Error;
    readonly postGateMonitorContext?: PostGateRuntime['monitorContext'];
  } = {},
) {
  const lastState = createMinimalLastState();
  const shutdownController = createShutdownController();
  let termination: RuntimeTermination | null = null;
  const deps = {
    prepareStrategy: async () => ({
      strategyId: createMonitorContextDouble().strategy.strategyId,
      prepared: { create: () => createMonitorContextDouble().strategy },
    }),
    createPreGateRuntime: async ({
      cleanup,
      termination: sharedTermination,
    }: CreatePreGateRuntimeParams) => {
      termination = sharedTermination;
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
          phase: 'DESTROY_STRATEGY',
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
    createBusinessEventProgram: () => {
      if (options.wiringError !== undefined) {
        throw options.wiringError;
      }

      return {
        ...createStartStopRecorder('businessEventProgram.start'),
      };
    },
    createAsyncRuntime: () => createMockAsyncRuntime(),
    createLifecycleRuntime: () => ({
      tick: async () => ({ nextRetryAtMs: null, pendingOpenRebuild: false }),
    }),
    createCleanup,
    subscribeShutdownSignal: shutdownController.subscribeShutdownSignal,
    createTimeWakeupRuntime: () => ({
      start: async () => {
        timeWakeupStartCount += 1;
        runtimeStartSteps.push('timeWakeupRuntime.start.begin');
        if (options.rejectTimeWakeupDuringStart === true) {
          termination?.reportFatalError(new Error('time wakeup initial fatal'));
        }

        await Promise.resolve();
        runtimeStartSteps.push('timeWakeupRuntime.start.end');
      },
      stop: () => {},
      stopAndDrain: async () => {},
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
    deps: { ...deps, ...options.deps },
    triggerShutdown: shutdownController.triggerShutdown,
    triggerTimeWakeupFatal: (error: Error) => {
      termination?.reportFatalError(error);
    },
    triggerAutoSearchFatal: (error: Error) => {
      termination?.reportFatalError(error);
    },
    triggerBusinessEventFatal: (error: Error) => {
      termination?.reportFatalError(error);
    },
    triggerPostTradeFatal: (error: Error) => {
      termination?.reportFatalError(error);
    },
    triggerPostGateFatal: (error: Error) => {
      termination?.reportFatalError(error);
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

  for (let attempt = 0; attempt < 100 && timeWakeupStartCount === 0; attempt += 1) {
    await Bun.sleep(1);
  }
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

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error('Expected rejection');
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

  it.each(['success', 'fatal', 'cleanupFailure'] as const)(
    'logs normal completion only after successful cleanup: %s',
    async (outcome) => {
      const debugMessages: string[] = [];
      const failure = new Error('completion route failure');
      const harness = createRunAppHarness({
        ...(outcome === 'cleanupFailure' ? { cleanupError: failure } : {}),
        deps: {
          logger: {
            debug: (message) => {
              expect(cleanupResetCount).toBe(1);
              debugMessages.push(message);
            },
            info: () => {},
            warn: () => {},
            error: () => {},
          },
        },
      });
      const execution = harness.runApp({ env: {} });
      await flushMicrotasks(20);
      expect(debugMessages).toEqual([]);
      if (outcome === 'fatal') {
        harness.triggerTimeWakeupFatal(failure);
      } else {
        harness.triggerShutdown();
      }

      if (outcome === 'success') {
        await execution;
        expect(debugMessages).toEqual(['[App] 运行与清理完成，即将正常返回']);
      } else {
        const caught = await rejectionOf(execution);
        if (outcome === 'fatal') {
          expect(caught).toBe(failure);
        } else {
          expect(caught).toBeInstanceOf(AggregateError);
          if (!(caught instanceof AggregateError))
            throw new Error('Expected cleanup AggregateError');

          expect(caught.errors).toEqual([failure]);
        }

        expect(debugMessages).toEqual([]);
      }

      expect(cleanupResetCount).toBe(1);
    },
  );

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

    await waitForSteadyRuntimeStart('businessEventProgram.start');
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

  it('subscribes shutdown then prepares before touching SDK resources', async () => {
    const calls: string[] = [];
    const prepareFailure = new Error('invalid selected config');
    const harness = createRunAppHarness({
      deps: {
        subscribeShutdownSignal: () => {
          calls.push('subscribe');
          return () => {
            calls.push('unsubscribe');
          };
        },
        prepareStrategy: async () => {
          calls.push('prepare');
          throw prepareFailure;
        },
        createPreGateRuntime: async () => {
          calls.push('SDK');
          return null;
        },
      },
    });
    expect(await rejectionOf(harness.runApp({ env: {} }))).toBe(prepareFailure);
    expect(calls).toEqual(['subscribe', 'prepare', 'unsubscribe']);
  });

  it('waits for late acquisition, registers its disposer and skips later assembly after shutdown', async () => {
    let finish: (() => void) | undefined;
    let shutdown: (() => void) | undefined;
    const acquired = { current: false };
    let disposed = 0;
    let postGateCalls = 0;
    const harness = createRunAppHarness({
      deps: {
        subscribeShutdownSignal: (callback) => {
          shutdown = callback;
          return () => {};
        },
        createPreGateRuntime: async ({ cleanup }) => {
          acquired.current = true;
          await new Promise<void>((resolve) => {
            finish = resolve;
          });

          cleanup.register({
            phase: 'RESET_MARKET_DATA_RUNTIME',
            step: 'late quote',
            handler: () => {
              disposed++;
            },
          });
          return createMockPreGateRuntime();
        },
        createPostGateRuntime: async () => {
          postGateCalls++;
          return null;
        },
      },
    });
    const running = harness.runApp({ env: {} });
    while (!acquired.current) await Bun.sleep(1);

    shutdown?.();
    await Promise.resolve();
    expect(disposed).toBe(0);
    finish?.();
    await running;
    expect(disposed).toBe(1);
    expect(postGateCalls).toBe(0);
  });

  it('normal shutdown does not hide a subsequent internal acquisition error', async () => {
    let finish: (() => void) | undefined;
    const acquired = { current: false };
    const fatal = new Error('late acquisition invariant');
    const harness = createRunAppHarness({
      deps: {
        createPreGateRuntime: async ({ termination }) => {
          acquired.current = true;
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
          termination.requestShutdown();
          throw fatal;
        },
      },
    });
    const running = harness.runApp({ env: {} });
    while (!acquired.current) await Bun.sleep(1);

    harness.triggerShutdown();
    finish?.();
    expect(await rejectionOf(running)).toBe(fatal);
  });

  it('preserves original fatal identity when a later awaited operation throws', async () => {
    const first = { message: 'first raw fatal' };
    const second = new Error('later awaited error');
    const harness = createRunAppHarness({
      deps: {
        createPreGateRuntime: async ({ termination }) => {
          termination.reportFatalError(first);
          throw second;
        },
      },
    });
    expect(await rejectionOf(harness.runApp({ env: {} }))).toBe(first);
  });
});
