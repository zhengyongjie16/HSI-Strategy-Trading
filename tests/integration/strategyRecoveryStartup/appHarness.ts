import {
  createAutoSearchWakeupRuntimeDouble,
  createDoomsdayClearanceWorkflowDouble,
  createOrdinaryBuyWorkflowDouble,
  createOrdinarySellWorkflowDouble,
  createLiquidationCooldownTrackerDouble,
  createMarketDataClientDouble,
  createMonitorContextDouble,
  createPeriodicSwitchWakeupRuntimeDouble,
  createQuoteSubscriptionRuntimeDouble,
  createSeatActivationDispatcherDouble,
  createSeatActivationWorkflowDouble,
  createWarrantRiskRefreshDouble,
  createSeatRuntimeCleanupDispatcherDouble,
  createSymbolRegistryDouble,
  createTradeRuntimeDouble,
  createTradingGateEventRuntimeDouble,
} from '../../helpers/testDoubles.js';
import type { RuntimeStateFixtures } from '../../helpers/types.js';
import type { RuntimeTermination } from '../../../src/types/runtime.js';

/** T28 独立 app 装配 helper：替换离线外围 owners，保留真实 runApp 启动和错误分类。 */
import { mock } from 'bun:test';
import { createDiagnosticObserverDouble } from '../../helpers/diagnostics.js';
import { AsyncLocalStorage } from 'node:async_hooks';

import { createCleanup } from '../../../src/app/shutdown/createCleanup.js';
import { loadStartupSnapshot as loadRealStartupSnapshot } from '../../../src/application/tradingDayRebuild/startupSnapshot.js';
import { executeStartupRebuild } from '../../../src/application/tradingDayRebuild/startupRebuild.js';
import type {
  CreatePostGateRuntimeParams,
  CreatePreGateRuntimeParams,
  PostGateRuntime,
  PreGateRuntime,
  RunAppDeps,
} from '../../../src/app/types.js';
import type { AsyncRuntime } from '../../../src/app/runtime/types.js';
import { createWarrantListCache } from '../../../src/infrastructure/longbridge/market/warrantListCache/index.js';

import { createTradingConfig } from '../../../mock/factories/configFactory.js';
import { createBrokerClientFactoryDouble } from '../../helpers/brokerClientFactoryDouble.js';

import { applyStartupSnapshotFailureState } from '../../../src/application/tradingDayRebuild/startupFailureState.js';
import {
  createBuyTaskQueue,
  createSellTaskQueue,
} from '../../../src/runtime/asyncProgram/tradeTaskQueue/index.js';
import type { StartupRecoveryHarnessParams, StartupRecoveryHarness } from './types.js';

const startsContext = new AsyncLocalStorage<string[]>();
let importSequence = 0;
function createMinimalRuntimeStates(): RuntimeStateFixtures {
  return {
    tradingTimeState: { canTrade: false, isHalfDay: false, openProtectionActive: false },
    lifecycleState: {
      currentDayKey: '2026-04-29',
      lifecycleState: 'ACTIVE',
      pendingOpenRebuild: false,
      isTradingEnabled: true,
    },
    tradingCalendarState: { cachedTradingDayInfo: null, tradingCalendarSnapshot: new Map() },
    quoteSubscriptionState: { allTradingSymbols: new Set() },
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
    diagnostics: createDiagnosticObserverDouble(),
    brokerClientFactory: createBrokerClientFactoryDouble(),
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
    warrantListCache: warrantListCache,
    marketDataClient: createMarketDataClientDouble(),
    startupTradingDayInfo: null,
  };
}

function createMockPostGateRuntime(
  stateFixtures: RuntimeStateFixtures,
  monitorContext: PostGateRuntime['monitorContext'],
  owner: StartupRecoveryHarnessParams['executionOwner'],
): PostGateRuntime {
  const quoteSubscriptionRuntime = createQuoteSubscriptionRuntimeDouble({
    reconcileFromCurrentTruth: async () => {
      recordSteadyRuntimeStart('quoteSubscriptionRuntime.reconcileFromCurrentTruth');
    },
    start: () => {
      recordSteadyRuntimeStart('quoteSubscriptionRuntime.start');
    },
  });
  const tradeRuntime = createTradeRuntimeDouble({
    orderMonitor: {
      startRuntime: () => {
        recordSteadyRuntimeStart('tradeRuntime.orderMonitor.startRuntime');
      },
    },
  });

  const liquidationCooldownTracker = createLiquidationCooldownTrackerDouble();
  owner.sink.bindBusinessDeps({
    monitorContext,
    dailyLossTracker: owner.daily,
    liquidationCooldownTracker,
    protectiveLiquidationEpisodeTracker: owner.episode,
    mixedTradeLogRepository: {
      appendCompletionIdempotent: () => {
        throw new Error('T28 zero-resource recovery cannot publish completion IO');
      },
    },
  });
  return {
    liquidationCooldownTracker,
    dailyLossTracker: owner.daily,
    protectiveLiquidationEpisodeTracker: owner.episode,
    monitorContext,
    tradingGateEventRuntime: createTradingGateEventRuntimeDouble({
      onGateStateChanged: () => noop,
    }),
    quoteSubscriptionRuntime,
    seatActivation: createSeatActivationWorkflowDouble(),
    warrantRiskRefresh: createWarrantRiskRefreshDouble(),
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
    snapshot: owner.snapshot,
    postTradeConsistencyRuntime: {
      ...owner.sink,
      start: () => {
        recordSteadyRuntimeStart('postTradeConsistencyRuntime.start');
        owner.sink.start();
      },
      completeRebuildBaseline: (...args) => {
        recordSteadyRuntimeStart('postTradeConsistencyRuntime.completeRebuildBaseline');
        return owner.sink.completeRebuildBaseline(...args);
      },
    },
    ...stateFixtures,
    tradeRuntime,
    loadTradingDayRuntimeSnapshot: async (params) => {
      const receipt = await owner.snapshot.requestRefresh({
        source: params.source === 'OPEN_REBUILD' ? 'LIFECYCLE_REBUILD' : 'STARTUP',
        dayEpoch: owner.snapshot.getView().token.dayEpoch,
        refreshAccount: true,
        refreshPositions: true,
      }).result;
      return receipt.status === 'ABORTED'
        ? receipt
        : {
            status: 'COMMITTED',
            snapshotToken: receipt.snapshotToken,
            allOrders: [],
            quotesMap: new Map(),
          };
    },
    doomsdayClearanceWorkflow: createDoomsdayClearanceWorkflowDouble(),
    ordinaryBuy: createOrdinaryBuyWorkflowDouble(),
    ordinarySell: createOrdinarySellWorkflowDouble(),
    buyTaskQueue: createBuyTaskQueue({
      clock: { now: () => new Date() },
      diagnostics: createDiagnosticObserverDouble(),
    }),
    sellTaskQueue: createSellTaskQueue({
      clock: { now: () => new Date() },
      diagnostics: createDiagnosticObserverDouble(),
    }),
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
  const stateFixtures = createMinimalRuntimeStates();
  const post = createMockPostGateRuntime(
    stateFixtures,
    createMonitorContextDouble(),
    params.executionOwner,
  );
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
      resources.lifecycleState = stateFixtures.lifecycleState;
      resources.buyTaskQueue = post.buyTaskQueue;
      resources.sellTaskQueue = post.sellTaskQueue;
      resources.monitorTaskQueue = post.monitorTaskQueue;
      return post;
    },
    loadStartupSnapshot: loadRealStartupSnapshot,
    executeStartupRebuild,
    collectRuntimeValidationSymbols: () => ({ runtimeValidationInputs: [] }),
    createRebuildTradingDayState:
      () =>
      async ({ snapshotToken }) => {
        await params.recover();
        if (
          !params.executionOwner.snapshot.isCurrent(snapshotToken, {
            account: true,
            positions: true,
            paired: true,
          })
        )
          return { status: 'ABORTED' };

        stateFixtures.lifecycleState.isTradingEnabled = true;
        return { status: 'COMMITTED', snapshotToken };
      },
    displayAccountAndPositions: noop,
    createBusinessEventProgram: () => createStartStopRecorder('businessEventProgram.start'),
    createAsyncRuntime: createMockAsyncRuntime,
    createLifecycleRuntime: () => ({
      tick: async () => ({
        nextRetryAtMs: null,
      }),
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
    stateFixtures: stateFixtures,
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
