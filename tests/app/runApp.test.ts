/**
 * app/runApp 组装测试
 *
 * 覆盖：
 * - 正常启动链路保持统一时间源与关键装配顺序
 * - startupRebuildPending 分支会跳过首次重建，但仍完成后续装配
 * - startupRebuildPending 与运行时标的验证失败并存时，启动不会被中止
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { createWarrantListCache } from '../../src/services/autoSymbolFinder/utils.js';
import { createRunApp } from '../../src/app/runApp.js';
import type { AppEnvironmentParams, RunAppDeps } from '../../src/app/types.js';
import type { LastState } from '../../src/types/state.js';
import {
  createStrategyRuntimeConfig,
  createTradingConfigFixture,
} from '../../mock/factories/configFactory.js';
import {
  createMarketDataClientDouble,
  createStrategyRuntimeDouble,
  createPositionCacheDouble,
  createProtectiveLiquidationEpisodeTrackerDouble,
  createSdkConfigDouble,
  createSymbolRegistryDouble,
  createTraderDouble,
} from '../helpers/testDoubles.js';
import type { AppTestTaskQueueDouble, MutableRunAppHarnessState } from './types.js';

const STOP_AFTER_FIRST_LOOP = new Error('STOP_AFTER_FIRST_LOOP');
const TEST_APP_ENV = {
  APP_RUNTIME_PROFILE: 'test',
} as const;

function createLastState(): LastState {
  const monitorConfig = createStrategyRuntimeConfig();
  return {
    canTrade: null,
    isHalfDay: null,
    openProtectionActive: null,
    currentDayKey: '2026-03-09',
    lifecycleState: 'ACTIVE',
    pendingOpenRebuild: false,
    targetTradingDayKey: null,
    isTradingEnabled: true,
    cachedAccount: null,
    cachedPositions: [],
    positionCache: createPositionCacheDouble(),
    cachedTradingDayInfo: {
      isTradingDay: true,
      isHalfDay: false,
    },
    tradingCalendarSnapshot: new Map(),
    monitorState: {
      baseInstrumentSymbol: monitorConfig.baseInstrumentSymbol,
      monitorPrice: null,
      longPrice: null,
      shortPrice: null,
      signal: null,
      pendingSignals: [],
      lastMonitorSnapshot: null,
      lastCandlestickCacheVersion: null,
    },
    allTradingSymbols: new Set(),
  };
}

function createTaskQueueDouble(): AppTestTaskQueueDouble {
  return {
    push: () => {},
    pop: () => null,
    isEmpty: () => true,
    removeTasks: () => 0,
    clearAll: () => 0,
    onTaskAdded: () => () => {},
  };
}

function createHarnessState(): MutableRunAppHarnessState {
  return {
    events: [],
    startupRebuildPending: false,
    runtimeGateMode: 'strict',
    preGateRuntimeEnv: null,
    postGateRuntimeEnv: null,
    createPostGateRuntimeNow: null,
    loadStartupSnapshotNow: null,
    rebuildCalls: [],
    cleanupRegistered: 0,
    mainProgramCalls: 0,
    mainProgramRuntimeGateModes: [],
    sleepDurations: [],
    validationResult: {
      valid: true,
      warnings: [],
      errors: [],
    },
  };
}

function createRunAppDeps(harnessState: MutableRunAppHarnessState): RunAppDeps {
  const warrantListCache = createWarrantListCache();

  return {
    createPreGateRuntime: async (params: AppEnvironmentParams) => {
      harnessState.preGateRuntimeEnv = params.env;
      const monitorConfig = createStrategyRuntimeConfig();
      return {
        config: createSdkConfigDouble(),
        tradingConfig: createTradingConfigFixture({
          global: {
            doomsdayProtection: true,
            debug: false,
            openProtection: {
              morning: { enabled: true, minutes: 3 },
              afternoon: { enabled: true, minutes: 3 },
            },
            orderMonitorPriceUpdateInterval: 1,
            allowBuyOrderTrackingAboveInitialPrice: true,
            tradingOrderType: 'ELO',
            liquidationOrderType: 'MO',
            buyOrderTimeout: {
              enabled: true,
              timeoutSeconds: 180,
            },
            sellOrderTimeout: {
              enabled: true,
              timeoutSeconds: 180,
            },
          },
        }),
        monitorConfig,
        symbolRegistry: createSymbolRegistryDouble(),
        warrantListCache,
        warrantListCacheConfig: {
          cache: warrantListCache,
          ttlMs: 60_000,
          nowMs: () => 0,
        },
        marketDataClient: createMarketDataClientDouble({
          getQuoteContext: async () => {
            throw new Error('runApp test should not request quote context');
          },
        }),
        runMode: 'prod',
        gatePolicies: {
          startupGate: 'strict',
          runtimeGate: harnessState.runtimeGateMode,
        },
        startupTradingDayInfo: {
          isTradingDay: true,
          isHalfDay: false,
        },
        startupGate: {
          wait: async () => ({ isTradingDay: true, isHalfDay: false }),
        },
      };
    },
    createPostGateRuntime: async (params) => {
      harnessState.createPostGateRuntimeNow = params.now;
      harnessState.postGateRuntimeEnv = params.env;
      const refreshGateStatus = {
        currentVersion: 3,
        staleVersion: 7,
      };

      return {
        liquidationCooldownTracker: {
          recordLiquidationTrigger: () => ({
            currentCount: 1,
            cooldownActivated: false,
          }),
          recordCooldown: () => {},
          restoreTriggerCount: () => {},
          getRemainingMs: () => 0,
          clearMidnightEligible: () => {},
          resetAllTriggerCounts: () => {},
        },
        dailyLossTracker: {
          resetAll: () => {},
          recalculateFromAllOrders: () => {},
          recordFilledOrder: () => {},
          getLossOffset: () => 0,
          startNewProtectionEpisode: () => {},
        },
        protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
        monitorContext: null,
        refreshGate: {
          markStale: () => 0,
          markFresh: (version: number) => {
            harnessState.events.push(`markFresh:${version}`);
          },
          waitForFresh: async () => {},
          getStatus: () => refreshGateStatus,
        },
        lastState: createLastState(),
        trader: createTraderDouble(),
        tradeLogHydrator: {
          hydrate: () => new Map(),
        },
        loadTradingDayRuntimeSnapshot: async () => ({
          allOrders: [],
          quotesMap: new Map(),
        }),
        marketMonitor: {
          monitorPriceChanges: () => false,
          monitorIndicatorChanges: () => false,
        },
        doomsdayProtection: {
          shouldRejectBuy: () => false,
          executeClearance: async () => ({ executed: false, signalCount: 0 }),
          cancelPendingBuyOrders: async () => ({ executed: false, cancelRequestAcceptedCount: 0 }),
        },
        signalProcessor: {
          processSellSignals: ({ signals }) => signals,
          applyRiskChecks: async (signals) => signals,
          resetRiskCheckCooldown: () => {},
        },
        buyTaskQueue: createTaskQueueDouble(),
        sellTaskQueue: createTaskQueueDouble(),
        monitorTaskQueue: {
          scheduleLatest: () => {},
          pop: () => null,
          isEmpty: () => true,
          removeTasks: () => 0,
          clearAll: () => 0,
          onTaskAdded: () => () => {},
        },
      };
    },
    loadStartupSnapshot: async (params) => {
      harnessState.loadStartupSnapshotNow = params.now;
      harnessState.events.push('loadStartupSnapshot');
      return {
        allOrders: [],
        quotesMap: new Map(),
        startupRebuildPending: harnessState.startupRebuildPending,
        now: params.now,
      };
    },
    collectRuntimeValidationSymbols: () => ({
      requiredSymbols: new Set(),
      runtimeValidationInputs: [],
    }),
    buildStrategyRuntime: (params) => {
      harnessState.events.push('buildStrategyRuntime');
      params.postGateRuntime.monitorContext = createStrategyRuntimeDouble({
        config: params.preGateRuntime.monitorConfig,
        state: params.postGateRuntime.lastState.monitorState,
      });
    },
    createRebuildTradingDayState: () => {
      harnessState.events.push('createRebuildTradingDayState');
      return async (params) => {
        harnessState.events.push('rebuildTradingDayState');
        harnessState.rebuildCalls.push(params);
      };
    },
    displayAccountAndPositions: async () => {},
    createAsyncRuntime: () => ({
      monitorTaskProcessor: {
        start: () => {
          harnessState.events.push('monitorTaskProcessor.start');
        },
        stop: () => {},
        stopAndDrain: async () => {},
        restart: () => {},
      },
      buyProcessor: {
        start: () => {
          harnessState.events.push('buyProcessor.start');
        },
        stop: () => {},
        stopAndDrain: async () => {},
        restart: () => {},
      },
      sellProcessor: {
        start: () => {
          harnessState.events.push('sellProcessor.start');
        },
        stop: () => {},
        stopAndDrain: async () => {},
        restart: () => {},
      },
      orderMonitorWorker: {
        start: () => {
          harnessState.events.push('orderMonitorWorker.start');
        },
        schedule: () => {},
        stopAndDrain: async () => {},
      },
      postTradeRefresher: {
        start: () => {
          harnessState.events.push('postTradeRefresher.start');
        },
        enqueue: () => {},
        stopAndDrain: async () => {},
        clearPending: () => {},
      },
    }),
    createLifecycleRuntime: () => {
      harnessState.events.push('createLifecycleRuntime');
      return {
        tick: async () => {},
      };
    },
    createCleanup: () => ({
      execute: async () => {},
      registerExitHandlers: () => {
        harnessState.cleanupRegistered += 1;
        harnessState.events.push('registerExitHandlers');
      },
    }),
    mainProgram: async (params) => {
      harnessState.mainProgramCalls += 1;
      harnessState.mainProgramRuntimeGateModes.push(params.runtimeGateMode);
      harnessState.events.push('mainProgram');
    },
    sleep: async (ms) => {
      harnessState.sleepDurations.push(ms);
      harnessState.events.push(`sleep:${ms}`);
      throw STOP_AFTER_FIRST_LOOP;
    },
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    formatError: String,
    validateRuntimeSymbolsFromQuotesMap: () => harnessState.validationResult,
    applyStartupSnapshotFailureState: () => {},
  };
}

describe('app runApp assembly', () => {
  let harnessState = createHarnessState();

  beforeEach(() => {
    harnessState = createHarnessState();
  });

  it('uses a shared startup time source and keeps rebuild before async runtime creation', async () => {
    const runApp = createRunApp(createRunAppDeps(harnessState));
    let caught: unknown = null;

    try {
      await runApp({ env: TEST_APP_ENV });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBe(STOP_AFTER_FIRST_LOOP);
    expect(harnessState.preGateRuntimeEnv?.['APP_RUNTIME_PROFILE']).toBe('test');
    expect(harnessState.postGateRuntimeEnv?.['APP_RUNTIME_PROFILE']).toBe('test');
    expect(harnessState.createPostGateRuntimeNow).toBe(harnessState.loadStartupSnapshotNow);
    expect(harnessState.rebuildCalls).toHaveLength(1);
    expect(harnessState.events).toEqual([
      'loadStartupSnapshot',
      'buildStrategyRuntime',
      'createRebuildTradingDayState',
      'rebuildTradingDayState',
      'markFresh:7',
      'createLifecycleRuntime',
      'monitorTaskProcessor.start',
      'buyProcessor.start',
      'sellProcessor.start',
      'orderMonitorWorker.start',
      'postTradeRefresher.start',
      'registerExitHandlers',
      'mainProgram',
      'sleep:1000',
    ]);
    expect(harnessState.sleepDurations).toEqual([1000]);
    expect(harnessState.cleanupRegistered).toBe(1);
    expect(harnessState.mainProgramCalls).toBe(1);
    expect(harnessState.mainProgramRuntimeGateModes).toEqual(['strict']);
  });

  it('skips the initial rebuild when startup snapshot switches to pending open rebuild', async () => {
    harnessState.startupRebuildPending = true;
    const runApp = createRunApp(createRunAppDeps(harnessState));
    let caught: unknown = null;

    try {
      await runApp({ env: TEST_APP_ENV });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBe(STOP_AFTER_FIRST_LOOP);
    expect(harnessState.createPostGateRuntimeNow).toBe(harnessState.loadStartupSnapshotNow);
    expect(harnessState.rebuildCalls).toHaveLength(0);
    expect(harnessState.events).toEqual([
      'loadStartupSnapshot',
      'buildStrategyRuntime',
      'createRebuildTradingDayState',
      'createLifecycleRuntime',
      'monitorTaskProcessor.start',
      'buyProcessor.start',
      'sellProcessor.start',
      'orderMonitorWorker.start',
      'postTradeRefresher.start',
      'registerExitHandlers',
      'mainProgram',
      'sleep:1000',
    ]);
    expect(harnessState.sleepDurations).toEqual([1000]);
    expect(harnessState.cleanupRegistered).toBe(1);
    expect(harnessState.mainProgramCalls).toBe(1);
    expect(harnessState.mainProgramRuntimeGateModes).toEqual(['strict']);
  });

  it('keeps startup pending-open-rebuild assembly behavior in skip runtime gate mode', async () => {
    harnessState.startupRebuildPending = true;
    harnessState.runtimeGateMode = 'skip';
    const runApp = createRunApp(createRunAppDeps(harnessState));
    let caught: unknown = null;

    try {
      await runApp({ env: TEST_APP_ENV });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBe(STOP_AFTER_FIRST_LOOP);
    expect(harnessState.rebuildCalls).toHaveLength(0);
    expect(harnessState.mainProgramRuntimeGateModes).toEqual(['skip']);
  });

  it('does not abort startup in pending-open-rebuild path when runtime symbol validation reports failure', async () => {
    harnessState.startupRebuildPending = true;
    harnessState.validationResult = {
      valid: false,
      warnings: [],
      errors: ['missing quote'],
    };
    const runApp = createRunApp(createRunAppDeps(harnessState));
    let caught: unknown = null;

    try {
      await runApp({ env: TEST_APP_ENV });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBe(STOP_AFTER_FIRST_LOOP);
    expect(harnessState.rebuildCalls).toHaveLength(0);
    expect(harnessState.events).toEqual([
      'loadStartupSnapshot',
      'buildStrategyRuntime',
      'createRebuildTradingDayState',
      'createLifecycleRuntime',
      'monitorTaskProcessor.start',
      'buyProcessor.start',
      'sellProcessor.start',
      'orderMonitorWorker.start',
      'postTradeRefresher.start',
      'registerExitHandlers',
      'mainProgram',
      'sleep:1000',
    ]);
    expect(harnessState.mainProgramCalls).toBe(1);
    expect(harnessState.cleanupRegistered).toBe(1);
  });

  it('throws AppStartupAbortError instead of exiting process when runtime symbol validation fails', async () => {
    harnessState.validationResult = {
      valid: false,
      warnings: [],
      errors: ['missing quote'],
    };
    const runApp = createRunApp(createRunAppDeps(harnessState));
    let caught: unknown = null;

    try {
      await runApp({ env: TEST_APP_ENV });
    } catch (err) {
      caught = err;
    }

    expect(caught).toMatchObject({
      name: 'AppStartupAbortError',
      message: '运行时标的验证失败，启动已中止',
    });
    expect(harnessState.events).toEqual(['loadStartupSnapshot']);
    expect(harnessState.mainProgramCalls).toBe(0);
    expect(harnessState.cleanupRegistered).toBe(0);
  });

  it('sleeps only for the remaining interval after a short mainProgram run', async () => {
    const originalDateNow = Date.now;
    let nowCallIndex = 0;
    Date.now = () => {
      nowCallIndex += 1;
      return nowCallIndex === 1 ? 1_000 : 1_250;
    };
    const runApp = createRunApp(createRunAppDeps(harnessState));
    let caught: unknown = null;

    try {
      await runApp({ env: TEST_APP_ENV });
    } catch (err) {
      caught = err;
    } finally {
      Date.now = originalDateNow;
    }

    expect(caught).toBe(STOP_AFTER_FIRST_LOOP);
    expect(harnessState.sleepDurations).toEqual([750]);
    expect(harnessState.events.at(-1)).toBe('sleep:750');
  });

  it('starts the next tick immediately when a mainProgram run exceeds the interval', async () => {
    const originalDateNow = Date.now;
    let nowCallIndex = 0;
    Date.now = () => {
      nowCallIndex += 1;
      return nowCallIndex === 1 ? 5_000 : 6_250;
    };
    const runApp = createRunApp(createRunAppDeps(harnessState));
    let caught: unknown = null;

    try {
      await runApp({ env: TEST_APP_ENV });
    } catch (err) {
      caught = err;
    } finally {
      Date.now = originalDateNow;
    }

    expect(caught).toBe(STOP_AFTER_FIRST_LOOP);
    expect(harnessState.sleepDurations).toEqual([0]);
    expect(harnessState.events.at(-1)).toBe('sleep:0');
  });

  it('logs a mainProgram error and continues into the next loop iteration', async () => {
    const loggedErrors: string[] = [];
    let sleepCallCount = 0;
    const deps: RunAppDeps = {
      ...createRunAppDeps(harnessState),
      mainProgram: async (params) => {
        harnessState.mainProgramCalls += 1;
        harnessState.mainProgramRuntimeGateModes.push(params.runtimeGateMode);
        harnessState.events.push(`mainProgram:${harnessState.mainProgramCalls}`);
        if (harnessState.mainProgramCalls === 1) {
          throw new Error('loop failed');
        }
      },
      sleep: async (ms) => {
        sleepCallCount += 1;
        harnessState.sleepDurations.push(ms);
        harnessState.events.push(`sleep:${sleepCallCount}:${ms}`);
        if (sleepCallCount === 2) {
          throw STOP_AFTER_FIRST_LOOP;
        }
      },
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: (message) => {
          loggedErrors.push(message);
        },
      },
    };
    const runApp = createRunApp(deps);
    let caught: unknown = null;

    try {
      await runApp({ env: TEST_APP_ENV });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBe(STOP_AFTER_FIRST_LOOP);
    expect(harnessState.mainProgramCalls).toBe(2);
    expect(harnessState.events).toContain('mainProgram:2');
    expect(harnessState.sleepDurations).toHaveLength(2);
    expect(harnessState.sleepDurations[0]).toBeGreaterThanOrEqual(0);
    expect(harnessState.sleepDurations[0]).toBeLessThanOrEqual(1000);
    expect(harnessState.sleepDurations[1]).toBeGreaterThanOrEqual(0);
    expect(harnessState.sleepDurations[1]).toBeLessThanOrEqual(1000);
    expect(loggedErrors).toContain('[runApp] 主循环执行失败，下一轮继续重试');
  });
});
