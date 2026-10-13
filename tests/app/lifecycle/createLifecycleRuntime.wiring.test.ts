import type { AccountPositionSnapshot } from '../../../src/types/accountPosition.js';
import { createSnapshotFixture } from '../../main/fixtures/accountPositionSnapshot.js';
import { createSettlementRuntimeFixture } from '../../main/fixtures/settlementRuntime.js';
import { executeTradingDayOpenRebuild } from '../../../src/app/lifecycle/rebuild.js';
import { createTerminationRuntime } from '../../../src/app/runtime/createTerminationRuntime.js';

/**
 * app/createLifecycleRuntime 接线测试
 *
 * 覆盖：
 * - createLifecycleRuntime 按固定顺序创建各 cache domain
 * - globalState domain 的 openRebuild 统一委托 executeTradingDayOpenRebuild
 * - createLifecycleRuntime 将固定顺序的 cache domains 交给 dayLifecycleManager
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createLifecycleRuntime } from '../../../src/app/lifecycle/createLifecycleRuntime.js';
import type {
  LifecycleRuntimeFactories,
  LifecycleRuntimeFactoryDeps,
} from '../../../src/app/types.js';
import type { CacheDomain } from '../../../src/main/lifecycle/types.js';
import type { SignalRuntimeDomainDeps } from '../../../src/main/lifecycle/cacheDomains/types.js';
import type { MonitorTaskProcessor } from '../../../src/runtime/asyncProgram/monitorTaskProcessor/types.js';
import type { Processor } from '../../../src/runtime/asyncProgram/types.js';
import type { LastState } from '../../../src/types/state.js';
import { createWarrantListCache } from '../../../src/infrastructure/longbridge/market/warrantListCache/index.js';
import { createTradingConfig } from '../../../mock/factories/configFactory.js';
import {
  createDailyLossTrackerDouble,
  createAccountSnapshotDouble,
  createLoggerDouble,
  createOrdinaryBuyWorkflowDouble,
  createOrdinarySellWorkflowDouble,
  createAutoSearchWakeupRuntimeDouble,
  createPeriodicSwitchWakeupRuntimeDouble,
  createMarketDataClientDouble,
  createMonitorContextDouble,
  createProtectiveLiquidationEpisodeTrackerDouble,
  createQuoteSubscriptionRuntimeDouble,
  createSdkConfigDouble,
  createSeatActivationDispatcherDouble,
  createSeatActivationWorkflowDouble,
  createWarrantRiskRefreshDouble,
  createSeatRuntimeCleanupDispatcherDouble,
  createSymbolRegistryDouble,
  createTradingGateEventRuntimeDouble,
  createTraderDouble,
} from '../../helpers/testDoubles.js';
import type { CreateDayLifecycleManagerCall, ExecuteOpenRebuildCall } from './types.js';

let activeSnapshot: AccountPositionSnapshot;
const fixtureCleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of fixtureCleanups.splice(0)) await cleanup();
});

const factoryCalls: string[] = [];
const executeOpenRebuildCalls: ExecuteOpenRebuildCall[] = [];
const createDayLifecycleManagerCalls: CreateDayLifecycleManagerCall[] = [];
const createSignalRuntimeDomainCalls: SignalRuntimeDomainDeps[] = [];
let signalRuntimeDomain: CacheDomain | null = null;
let marketDataDomain: CacheDomain | null = null;
let seatDomain: CacheDomain | null = null;
let orderDomain: CacheDomain | null = null;
let riskDomain: CacheDomain | null = null;
let globalStateDomain: CacheDomain | null = null;

function createNamedProcessor(name: string): Processor {
  return {
    start: () => {
      factoryCalls.push(`${name}.start`);
    },
    stop: () => {},
    stopAndDrain: async () => {},
    restart: () => {},
  };
}

function createMonitorTaskProcessorDouble(): MonitorTaskProcessor {
  return {
    start: () => {
      factoryCalls.push('monitorTaskProcessor.start');
    },
    stop: () => {},
    stopAndDrain: async () => {},
    restart: () => {},
  };
}

function createTradingRiskEventRuntimeDouble() {
  return {
    start: () => {
      factoryCalls.push('tradingRiskEventRuntime.start');
    },
    stop: () => {},
    stopAndDrain: async () => {},
  };
}

function createSwitchWakeupRuntimeDouble() {
  return {
    start: () => {
      factoryCalls.push('switchWakeupRuntime.start');
    },
    stop: () => {},
    stopAndDrain: async () => {},
    handoffPendingSwitch: () => {},
  };
}

function createMonitorQuoteEventRuntimeDouble() {
  return {
    start: () => {
      factoryCalls.push('monitorQuoteEventRuntime.start');
    },
    stop: () => {},
    stopAndDrain: async () => {},
  };
}

function createMonitorDisplayRuntimeDouble() {
  return {
    start: () => {
      factoryCalls.push('monitorDisplayRuntime.start');
    },
    requestRender: () => {},
    stopAndDrain: async () => {},
  };
}

function createTradingQuoteDisplayRuntimeDouble() {
  return {
    start: () => {
      factoryCalls.push('tradingQuoteDisplayRuntime.start');
    },
    stop: () => {},
    stopAndDrain: async () => {},
  };
}

function createLastState(): LastState {
  return {
    canTrade: null,
    isHalfDay: null,
    openProtectionActive: null,
    currentDayKey: '2026-03-09',
    lifecycleState: 'ACTIVE',
    pendingOpenRebuild: false,
    isTradingEnabled: true,
    cachedTradingDayInfo: null,
    tradingCalendarSnapshot: new Map(),
    allTradingSymbols: new Set(),
  };
}

async function createLifecycleDeps(): Promise<LifecycleRuntimeFactoryDeps> {
  const lastState = createLastState();
  const tradingConfig = createTradingConfig();
  const warrantListCache = createWarrantListCache();
  const monitorContext = createMonitorContextDouble();
  const snapshot = await createSnapshotFixture({
    account: createAccountSnapshotDouble('100000'),
    positions: [],
  });
  const trader = createTraderDouble();
  const termination = createTerminationRuntime({
    closeTradingGate: () => {},
    closeProducerAdmission: () => {},
    stopProducers: [],
    onSecondaryError: () => {},
  });
  const settlement = createSettlementRuntimeFixture({
    snapshot,
    monitorContext,
    termination,
    getTrader: () => trader,
    onPositionsCommitted: async (token) => {
      if (!snapshot.isCurrent(token, { account: true, positions: true, paired: true }))
        throw new Error('Unexpected stale commit');
    },
    scheduler: {
      scheduleTimer: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimer: (handle) => {
        clearTimeout(handle);
      },
    },
  });
  fixtureCleanups.push(settlement.stopAndDrain);
  activeSnapshot = snapshot;

  return {
    termination,
    logger: createLoggerDouble(),
    preGateRuntime: {
      config: createSdkConfigDouble(),
      tradingConfig,
      symbolRegistry: createSymbolRegistryDouble(),
      warrantListCache: warrantListCache,
      marketDataClient: createMarketDataClientDouble(),
      startupTradingDayInfo: {
        dateKey: '2026-03-09',
        info: {
          isTradingDay: true,
          isHalfDay: false,
        },
      },
    },
    businessEventProgram: {
      start: () => {},
      stop: () => {},
      stopAndDrain: async () => {},
    },
    postGateRuntime: {
      snapshot,
      liquidationCooldownTracker: {
        recordLiquidationTrigger: () => {},
        recordCooldown: () => {},
        restoreTriggerCount: () => {},
        getRemainingMs: () => 0,
        clearMidnightEligible: () => {},
        resetAllTriggerCounts: () => {},
      },
      dailyLossTracker: createDailyLossTrackerDouble(),
      protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
      monitorContext,
      tradingGateEventRuntime: createTradingGateEventRuntimeDouble(),
      quoteSubscriptionRuntime: createQuoteSubscriptionRuntimeDouble(),
      seatActivationDispatcher: createSeatActivationDispatcherDouble(),
      seatRuntimeCleanupDispatcher: createSeatRuntimeCleanupDispatcherDouble(),
      autoSearchWakeupRuntime: createAutoSearchWakeupRuntimeDouble(),
      periodicSwitchWakeupRuntime: createPeriodicSwitchWakeupRuntimeDouble(),
      tradingRiskEventRuntime: createTradingRiskEventRuntimeDouble(),
      monitorQuoteEventRuntime: createMonitorQuoteEventRuntimeDouble(),
      monitorDisplayRuntime: createMonitorDisplayRuntimeDouble(),
      tradingQuoteDisplayRuntime: createTradingQuoteDisplayRuntimeDouble(),
      switchWakeupRuntime: createSwitchWakeupRuntimeDouble(),
      postTradeConsistencyRuntime: settlement,
      lastState,
      trader,
      loadTradingDayRuntimeSnapshot: async () => {
        const captured = snapshot.getView().token;
        if (!snapshot.isCurrent(captured, { account: true, positions: true, paired: true }))
          return { status: 'ABORTED' };

        return {
          status: 'COMMITTED',
          snapshotToken: captured,
          allOrders: [],
          quotesMap: new Map(),
        };
      },
      seatActivation: createSeatActivationWorkflowDouble(),
      warrantRiskRefresh: createWarrantRiskRefreshDouble(),
      doomsdayClearanceWorkflow: {
        evaluate: async () => ({ executed: false, nextRetryAtMs: null }),
        executeClearance: async () => ({
          executed: false,
          nextRetryAtMs: null,
        }),
        cancelPendingBuyOrders: async () => ({
          executed: false,
          cancelRequestAcceptedCount: 0,
          nextRetryAtMs: null,
        }),
      },
      ordinaryBuy: createOrdinaryBuyWorkflowDouble(),
      ordinarySell: createOrdinarySellWorkflowDouble(),
      buyTaskQueue: {
        push: () => true,
        close: () => {},
        pop: () => null,
        isEmpty: () => true,
        removeTasks: () => 0,
        clearAll: () => 0,
        onTaskAdded: () => () => {},
      },
      sellTaskQueue: {
        push: () => true,
        close: () => {},
        pop: () => null,
        isEmpty: () => true,
        removeTasks: () => 0,
        clearAll: () => 0,
        onTaskAdded: () => () => {},
      },
      monitorTaskQueue: {
        scheduleLatest: () => true,
        close: () => {},
        pop: () => null,
        isEmpty: () => true,
        removeTasks: () => 0,
        clearAll: () => 0,
        onTaskAdded: () => () => {},
      },
    },
    asyncRuntime: {
      monitorTaskProcessor: createMonitorTaskProcessorDouble(),
      buyProcessor: createNamedProcessor('buyProcessor'),
      sellProcessor: createNamedProcessor('sellProcessor'),
    },
    rebuildTradingDayState: async (input) => {
      expect(input.allOrders).toEqual([]);
      expect(input.quotesMap).toEqual(new Map());
      if (
        !snapshot.isCurrent(input.snapshotToken, { account: true, positions: true, paired: true })
      )
        return { status: 'ABORTED' };

      return { status: 'COMMITTED', snapshotToken: input.snapshotToken };
    },
  };
}

function createDomain(name: string): CacheDomain {
  return {
    midnightClear: async () => {
      factoryCalls.push(`${name}.midnightClear`);
    },
    openRebuild: async (ctx) => {
      factoryCalls.push(`${name}.openRebuild`);
      if (
        !ctx.isCurrent() ||
        !activeSnapshot.isCurrent(ctx.snapshotToken, {
          account: true,
          positions: true,
          paired: true,
        })
      )
        return { status: 'ABORTED' };

      return { status: 'COMMITTED', snapshotToken: ctx.snapshotToken };
    },
  };
}

function createLifecycleRuntimeFactories(): LifecycleRuntimeFactories {
  return {
    createSignalRuntimeDomain: (deps) => {
      createSignalRuntimeDomainCalls.push(deps);
      factoryCalls.push('signalRuntime.factory');
      signalRuntimeDomain = createDomain('signalRuntime');
      return signalRuntimeDomain;
    },
    createMarketDataDomain: () => {
      factoryCalls.push('marketData.factory');
      marketDataDomain = createDomain('marketData');
      return marketDataDomain;
    },
    createSeatDomain: () => {
      factoryCalls.push('seat.factory');
      seatDomain = createDomain('seat');
      return seatDomain;
    },
    createOrderDomain: () => {
      factoryCalls.push('order.factory');
      orderDomain = createDomain('order');
      return orderDomain;
    },
    createRiskDomain: () => {
      factoryCalls.push('risk.factory');
      riskDomain = createDomain('risk');
      return riskDomain;
    },
    createGlobalStateDomain: (deps) => {
      factoryCalls.push('globalState.factory');
      const domain: CacheDomain = {
        midnightClear: async () => {
          factoryCalls.push('globalState.midnightClear');
        },
        openRebuild: async (ctx) => {
          factoryCalls.push('globalState.openRebuild');
          return deps.runTradingDayOpenRebuild(ctx.now);
        },
      };
      globalStateDomain = domain;
      return domain;
    },
    executeTradingDayOpenRebuild: async (params) => {
      executeOpenRebuildCalls.push(params);
      return executeTradingDayOpenRebuild(params);
    },
    createDayLifecycleManager: (deps) => {
      createDayLifecycleManagerCalls.push(deps);
      return {
        tick: async () => ({ nextRetryAtMs: null, pendingOpenRebuild: false }),
      };
    },
  };
}

describe('app createLifecycleRuntime wiring', () => {
  beforeEach(() => {
    factoryCalls.length = 0;
    executeOpenRebuildCalls.length = 0;
    createDayLifecycleManagerCalls.length = 0;
    createSignalRuntimeDomainCalls.length = 0;
    signalRuntimeDomain = null;
    marketDataDomain = null;
    seatDomain = null;
    orderDomain = null;
    riskDomain = null;
    globalStateDomain = null;
  });

  it('creates cache domains in the declared order and delegates global open rebuild centrally', async () => {
    const deps = await createLifecycleDeps();
    const factories = createLifecycleRuntimeFactories();
    createLifecycleRuntime(deps, factories);
    const domains = createDayLifecycleManagerCalls[0]?.cacheDomains;
    if (domains === undefined) {
      throw new Error('expected createDayLifecycleManager to receive cache domains');
    }

    expect(factoryCalls).toEqual([
      'signalRuntime.factory',
      'marketData.factory',
      'seat.factory',
      'order.factory',
      'risk.factory',
      'globalState.factory',
    ]);
    expect(domains).toHaveLength(6);
    expect(createSignalRuntimeDomainCalls).toHaveLength(1);
    expect(createSignalRuntimeDomainCalls[0]?.monitorQuoteEventRuntime).toBe(
      deps.postGateRuntime.monitorQuoteEventRuntime,
    );

    expect(createSignalRuntimeDomainCalls[0]?.periodicSwitchWakeupRuntime).toBe(
      deps.postGateRuntime.periodicSwitchWakeupRuntime,
    );
    expect(createSignalRuntimeDomainCalls[0]?.trader).toBe(deps.postGateRuntime.trader);

    await domains.at(-1)?.openRebuild({
      dayEpoch: deps.postGateRuntime.snapshot.getView().token.dayEpoch,
      snapshotToken: deps.postGateRuntime.snapshot.getView().token,
      isCurrent: (() => {
        const token = deps.postGateRuntime.snapshot.getView().token;
        return () =>
          !deps.termination.isTerminated() &&
          deps.postGateRuntime.snapshot.isCurrent(token, {
            account: true,
            positions: true,
            paired: true,
          });
      })(),
      now: new Date('2026-03-09T09:30:00.000Z'),
      runtime: {
        dayKey: '2026-03-09',
        canTradeNow: true,
        isTradingDay: true,
      },
    });

    expect(factoryCalls).toContain('globalState.openRebuild');
    expect(executeOpenRebuildCalls).toHaveLength(1);
    expect(executeOpenRebuildCalls[0]?.loadTradingDayRuntimeSnapshot).toBe(
      deps.postGateRuntime.loadTradingDayRuntimeSnapshot,
    );
    expect(executeOpenRebuildCalls[0]?.rebuildTradingDayState).toBe(deps.rebuildTradingDayState);
  });

  it('passes the ordered cache domains into createDayLifecycleManager', async () => {
    const deps = await createLifecycleDeps();
    const factories = createLifecycleRuntimeFactories();
    const dayLifecycleManager = createLifecycleRuntime(deps, factories);
    const cacheDomains = createDayLifecycleManagerCalls[0]?.cacheDomains;

    expect(dayLifecycleManager).toBeDefined();
    expect(createDayLifecycleManagerCalls).toHaveLength(1);
    expect(createDayLifecycleManagerCalls[0]?.mutableState).toBe(deps.postGateRuntime.lastState);

    if (
      !signalRuntimeDomain ||
      !marketDataDomain ||
      !seatDomain ||
      !orderDomain ||
      !riskDomain ||
      !globalStateDomain
    ) {
      throw new Error('expected all lifecycle cache domains to be created');
    }

    if (cacheDomains === undefined) {
      throw new Error('expected createDayLifecycleManager to receive cache domains');
    }

    expect(cacheDomains).toHaveLength(6);
    expect(cacheDomains[0]).toBe(signalRuntimeDomain);
    expect(cacheDomains[1]).toBe(marketDataDomain);
    expect(cacheDomains[2]).toBe(seatDomain);
    expect(cacheDomains[3]).toBe(orderDomain);
    expect(cacheDomains[4]).toBe(riskDomain);
    expect(cacheDomains[5]).toBe(globalStateDomain);
  });

  it('passes the same monitorQuoteEventRuntime object into signal runtime domain deps', async () => {
    const deps = await createLifecycleDeps();
    const factories = createLifecycleRuntimeFactories();

    createLifecycleRuntime(deps, factories);

    expect(createSignalRuntimeDomainCalls).toHaveLength(1);
    const signalRuntimeDeps = createSignalRuntimeDomainCalls[0];
    if (signalRuntimeDeps === undefined) {
      throw new Error('expected createSignalRuntimeDomain to receive deps');
    }

    expect(signalRuntimeDeps.monitorQuoteEventRuntime).toBe(
      deps.postGateRuntime.monitorQuoteEventRuntime,
    );

    expect(signalRuntimeDeps.periodicSwitchWakeupRuntime).toBe(
      deps.postGateRuntime.periodicSwitchWakeupRuntime,
    );
    expect(signalRuntimeDeps.trader).toBe(deps.postGateRuntime.trader);
  });
});
