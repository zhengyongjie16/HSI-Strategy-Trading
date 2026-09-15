import type { RuntimeTermination } from '../../../src/types/runtime.js';

/** T28 独立 app 装配 helper：替换离线外围 owners，保留真实 runApp 启动和错误分类。 */
import { mock } from 'bun:test';
import { AsyncLocalStorage } from 'node:async_hooks';

import { createCleanup } from '../../../src/app/shutdown/createCleanup.js';
import type {
  AsyncRuntime,
  CreatePostGateRuntimeParams,
  CreatePreGateRuntimeParams,
  PostGateRuntime,
  PreGateRuntime,
  RunAppDeps,
} from '../../../src/app/types.js';
import type {
  ProcessedSellSignal,
  ProcessSellSignalsParams,
  SignalProcessor,
} from '../../../src/core/signalProcessor/types.js';
import { createWarrantListCache } from '../../../src/services/autoSymbolFinder/utils.js';
import type { BuySignal } from '../../../src/types/signal.js';
import type { LastState } from '../../../src/types/state.js';
import type { BuyRiskCheckContext } from '../../../src/types/services.js';
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
} from '../../helpers/testDoubles.js';
import { createTradingConfig } from '../../../mock/factories/configFactory.js';

import { applyStartupSnapshotFailureState } from '../../../src/main/lifecycle/startupFailureState.js';
import {
  createBuyTaskQueue,
  createSellTaskQueue,
} from '../../../src/main/asyncProgram/tradeTaskQueue/index.js';
import type { StartupRecoveryHarnessParams, StartupRecoveryHarness } from './types.js';

const startsContext = new AsyncLocalStorage<string[]>();
let importSequence = 0;
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
  const starts = startsContext.getStore();
  if (starts === undefined) throw new Error('missing startup observer');

  starts.push(name);
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
    buyTaskQueue: createBuyTaskQueue(),
    sellTaskQueue: createSellTaskQueue(),
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

/** 仅替换外围装配；初次恢复异常由真实 runApp 决定 fatal 或开盘重建等待。 */
export function createStartupRecoveryHarness(
  params: StartupRecoveryHarnessParams,
): StartupRecoveryHarness {
  const starts: string[] = [];
  const lastState = createMinimalLastState();
  lastState.isTradingEnabled = false;
  const post = createMockPostGateRuntime(lastState, createMonitorContextDouble());
  let shutdown = () => {};
  let termination: RuntimeTermination | undefined;
  const classifiedErrors: unknown[] = [];
  const timeStarted = Promise.withResolvers<undefined>();
  const deps: RunAppDeps = {
    prepareStrategy: async () => ({
      strategyId: post.monitorContext.strategy.strategyId,
      prepared: { create: () => post.monitorContext.strategy },
    }),
    createPreGateRuntime: async ({ termination: shared }: CreatePreGateRuntimeParams) => {
      termination = shared;
      return createMockPreGateRuntime();
    },
    createPostGateRuntime: async ({ resources }: CreatePostGateRuntimeParams) => {
      resources.lastState = lastState;
      resources.buyTaskQueue = post.buyTaskQueue;
      resources.sellTaskQueue = post.sellTaskQueue;
      resources.monitorTaskQueue = post.monitorTaskQueue;
      return post;
    },
    loadStartupSnapshot: async () => ({
      kind: 'READY',
      now: new Date('2026-04-29T01:31:00Z'),
      allOrders: [],
      quotesMap: new Map(),
    }),
    collectRuntimeValidationSymbols: () => ({ runtimeValidationInputs: [] }),
    createRebuildTradingDayState: () => async () => {
      await params.recover();
      lastState.isTradingEnabled = true;
    },
    displayAccountAndPositions: noop,
    createBusinessEventProgram: () => createStartStopRecorder('businessEventProgram.start'),
    createAsyncRuntime: createMockAsyncRuntime,
    createLifecycleRuntime: () => ({
      tick: async () => ({ nextRetryAtMs: null, pendingOpenRebuild: lastState.pendingOpenRebuild }),
    }),
    createCleanup,
    subscribeShutdownSignal: (callback) => {
      shutdown = callback;
      return () => {
        shutdown = noop;
      };
    },
    createTimeWakeupRuntime: () => ({
      start: async () => {
        starts.push('time.start');
        timeStarted.resolve();
      },
      stop: noop,
      stopAndDrain: async () => {},
    }),
    logger: { debug: noop, info: noop, warn: noop, error: noop },
    formatError: (error) => {
      classifiedErrors.push(error);
      return String(error);
    },
    validateRuntimeSymbolsFromQuotesMap: () => ({ valid: true, warnings: [], errors: [] }),
    applyStartupSnapshotFailureState,
  };
  return {
    starts,
    lastState,
    post,
    classifiedErrors,
    timeStarted: timeStarted.promise,
    shutdown: () => {
      shutdown();
    },
    fatalState: () => termination?.getFatalState(),
    run: () =>
      startsContext.run(starts, async () => {
        mock.module('../../../src/app/runAppDeps.js', () => ({ DEFAULT_RUN_APP_DEPS: deps }));
        const app = await import(
          `../../../src/app/runApp.js?strategy-recovery-startup=${importSequence++}`
        );
        await app.runApp({ env: {} });
      }),
  };
}
