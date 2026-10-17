import { createDiagnosticObserverDouble } from '../helpers/diagnostics.js';
import type { RuntimeStateFixtures } from '../helpers/types.js';

/**
 * periodic-auto-symbol-chain 集成测试
 *
 * 功能：
 * - 验证周期换标的任务链路：任务调度 -> 任务处理器 -> 自动换标管理器状态机。
 */
import { createPeriodicSwitchTaskHandler } from '../../src/application/seatSwitch/periodicSwitchTask.js';

import { describe, expect, it } from 'bun:test';

import { createAccountPositionSnapshot } from '../../src/application/accountPositionSnapshot/index.js';
import { createPostTradeConsistencyRuntime } from '../../src/app/runtime/createPostTradeConsistencyRuntime.js';
import type { AccountPositionSnapshot } from '../../src/types/accountPosition.js';
import type { PostTradeConsistencyRuntime, TradeRuntime } from '../../src/app/runtime/types.js';
import { createSymbolRegistry } from '../../src/domain/seat/symbolRegistry.js';
import type { PeriodicSwitchTaskData } from '../../src/types/periodicSwitch.js';
import { createSeatSwitchWorkflow } from '../../src/application/seatSwitch/index.js';
import { createPeriodicSwitchWakeupRuntime } from '../../src/runtime/periodicSwitchWakeupRuntime/index.js';
import { calculateTradingDurationDueAtMs } from '../../src/domain/tradingSession/index.js';
import { createMonitorTaskQueue } from '../../src/runtime/asyncProgram/monitorTaskQueue/index.js';
import { createMonitorTaskProcessor } from '../../src/runtime/asyncProgram/monitorTaskProcessor/index.js';
import { createSwitchWakeupRuntime } from '../../src/runtime/monitorQuoteEventRuntime/switchWakeupRuntime.js';
import { createTradingGateEventRuntime as createProductionTradingGateEventRuntime } from '../../src/runtime/tradingGateEventRuntime/index.js';

import type { MonitorContextAssembly } from '../../src/app/context/types.js';
import type { MonitorTaskDataMap } from '../../src/runtime/asyncProgram/monitorTaskProcessor/types.js';
import type { SwitchWakeupRuntime } from '../../src/runtime/monitorQuoteEventRuntime/types.js';

import {
  createTerminationDouble,
  createMarketDataClientDouble,
  createLoggerDouble,
  createMonitorConfigDouble,
  createOrderRecorderDouble,
  createAccountSnapshotDouble,
  createMonitorContextDouble,
  createDailyLossTrackerDouble,
  createLiquidationCooldownTrackerDouble,
  createProtectiveLiquidationEpisodeTrackerDouble,
  createRiskCheckerDouble,
  createTradeRuntimeDouble,
  createQuoteSubscriptionRuntimeDouble,
  createWarrantDistanceInfoDouble,
} from '../helpers/testDoubles.js';
import { createWarrantCandidateWithOverrides, createLoggerStub } from '../helpers/seatTestUtils.js';

function createTradingGateEventRuntime() {
  return createProductionTradingGateEventRuntime({ logger: createLoggerDouble() });
}

let candidateQueue: Array<ReturnType<typeof createWarrantCandidateWithOverrides> | null> = [];

function rethrowFatalError(error: unknown): never {
  throw error;
}

const MONITOR_TASK_RUNTIME = {
  clock: { now: () => new Date('2026-02-16T01:31:00.000Z') },
  scheduler: {
    scheduleTimer: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
    clearTimer: (handle: ReturnType<typeof setTimeout>) => {
      clearTimeout(handle);
    },
  },
};

function createRuntimeStates(): RuntimeStateFixtures {
  return {
    tradingTimeState: { canTrade: true, isHalfDay: false, openProtectionActive: false },
    lifecycleState: {
      currentDayKey: '2026-02-16',
      lifecycleState: 'ACTIVE',
      pendingOpenRebuild: false,
      isTradingEnabled: true,
    },
    tradingCalendarState: { cachedTradingDayInfo: null, tradingCalendarSnapshot: new Map() },
    quoteSubscriptionState: { allTradingSymbols: new Set() },
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs: number = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('waitUntil timeout');
    }

    await Bun.sleep(10);
  }
}

/** 只触发生产owner原注册且已到期的one-shot，不制造task或receipt。 */
async function firePeriodicTimers(
  callbacks: Array<{ handle: ReturnType<typeof setTimeout>; atMs: number; callback: () => void }>,
  nowMs: number,
): Promise<void> {
  for (const entry of callbacks) {
    if (entry.atMs > nowMs) continue;

    clearTimeout(entry.handle);
    const index = callbacks.indexOf(entry);
    if (index !== -1) callbacks.splice(index, 1);

    entry.callback();
  }

  await Bun.sleep(0);
}

function createStartedSwitchWakeupRuntime(
  params: Readonly<{
    monitorContext: MonitorContextAssembly;
    tradeRuntime: TradeRuntime;
    stateFixtures: RuntimeStateFixtures;
    snapshot: AccountPositionSnapshot;
    settlement: PostTradeConsistencyRuntime;
    now: () => Date;
  }>,
): SwitchWakeupRuntime {
  const runtime = createSwitchWakeupRuntime({
    logger: { error: () => {} },
    marketDataClient: createMarketDataClientDouble(),
    orderMonitor: params.tradeRuntime.orderMonitor,
    symbolRegistry: params.monitorContext.symbolRegistry,
    monitorContext: params.monitorContext,
    ...params.stateFixtures,
    snapshot: params.snapshot,
    postTradeConsistencyRuntime: params.settlement,
    tradingGateEventRuntime: createTradingGateEventRuntime(),
    quoteSubscriptionRuntime: createQuoteSubscriptionRuntimeDouble(),
    doomsdayProtectionEnabled: false,
    now: params.now,
    scheduleTimer: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer: (handle) => {
      clearTimeout(handle);
    },
    termination: createTerminationDouble({
      reportFatalError: (error) => {
        throw error;
      },
    }),
  });
  runtime.start();
  return {
    ...runtime,
    handoffPendingSwitch: (handoff) => {
      const witness = handoff.driveResult.publishedRoute;
      if (witness === undefined)
        throw new Error('initial periodic handoff requires real publication');

      expect(witness.isCurrent()).toBeTrue();
      expect(params.monitorContext.symbolRegistry.getSeatVersion(handoff.direction)).toBe(
        witness.seatVersion,
      );
      expect(handoff.originalDayEpoch).toBe(params.snapshot.getView().token.dayEpoch);
      runtime.handoffPendingSwitch(handoff);
    },
  };
}

describe('periodic auto-symbol full chain integration', () => {
  it('hands periodic no-candidate back to EMPTY without letting AUTO_SYMBOL_TICK restart auto-search', async () => {
    const readyMs = Date.parse('2026-02-16T01:30:00.000Z');
    let currentNowMs = Date.parse('2026-02-16T01:31:00.000Z');
    candidateQueue = [
      null,
      null,
      createWarrantCandidateWithOverrides('NEW_BULL.HK', { callPrice: '21000' }),
    ];
    const tradingCalendarSnapshot = new Map([
      ['2026-02-16', { isTradingDay: true, isHalfDay: false }],
    ]);

    const monitorConfig = createMonitorConfigDouble({
      monitorSymbol: 'HSI.HK',
      autoSearchConfig: {
        autoSearchEnabled: true,
        autoSearchMinDistancePctBull: '0.35',
        autoSearchMinDistancePctBear: '-0.35',
        autoSearchMinTurnoverPerMinuteBull: '100000',
        autoSearchMinTurnoverPerMinuteBear: '100000',
        autoSearchExpiryMinMonths: 3,
        autoSearchOpenDelayMinutes: 0,
        switchIntervalMinutes: 1,
        switchDistanceRangeBull: { min: '0.2', max: '1.5' },
        switchDistanceRangeBear: { min: '-1.5', max: '-0.2' },
      },
    });

    const symbolRegistry = createSymbolRegistry(monitorConfig);
    symbolRegistry.updateSeatState('LONG', {
      symbol: 'OLD_BULL.HK',
      status: 'ACTIVE',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: readyMs,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
      callPrice: '20000',
    });

    let mutationCalls = 0;
    const tradeRuntime = createTradeRuntimeDouble({
      orderExecutor: {
        executeSignals: async (_signals, callerAuthorization) => {
          mutationCalls += 1;
          if (!callerAuthorization()) throw new Error('periodic stale mutation attempted');

          throw new Error('periodic switch must never SELL or REBUY');
        },
      },
      cacheManager: { getPendingOrders: async () => [] },
      orderMonitor: {
        cancelOrder: async () => ({
          kind: 'CANCEL_CONFIRMED',
          relatedBuyOrderIds: null,
        }),
      },
    });
    const orderRecorder = createOrderRecorderDouble({
      getBuyOrdersForSymbol: () => [],
    });
    const riskChecker = createRiskCheckerDouble({
      getWarrantDistanceInfo: () =>
        createWarrantDistanceInfoDouble({
          warrantType: 'BULL',
          distanceNumerator: '0.1',
          distanceDenominator: '100',
        }),
    });

    const seatSwitch = createSeatSwitchWorkflow({
      logger: createLoggerStub(),
      monitorConfig,
      symbolRegistry,
      marketDataClient: createMarketDataClientDouble(),
      cacheManager: tradeRuntime.cacheManager,
      orderHoldRegistry: tradeRuntime.orderHoldRegistry,
      orderMonitor: tradeRuntime.orderMonitor,
      orderExecutor: tradeRuntime.orderExecutor,
      orderRecorder,
      riskChecker,
      candidateSearch: {
        resolveDistanceRange: (direction) =>
          monitorConfig.autoSearchConfig[
            direction === 'LONG' ? 'switchDistanceRangeBull' : 'switchDistanceRangeBear'
          ],
        findCandidate: async () => candidateQueue.shift() ?? null,
      },
      clock: { now: () => new Date(currentNowMs) },
      getTradingCalendarSnapshot: () => tradingCalendarSnapshot,
    });

    const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskDataMap>({
      logger: createLoggerDouble(),
      clock: { now: () => new Date() },
      diagnostics: createDiagnosticObserverDouble(),
    });
    const dailyLossTracker = createDailyLossTrackerDouble();
    const preparedDaily = dailyLossTracker.prepareRecalculationFromAllOrders(
      [],
      monitorConfig,
      new Date(currentNowMs),
      undefined,
      new Set(['OLD_BULL.HK', 'NEW_BULL.HK']),
    );
    if (!preparedDaily.isCurrent()) throw new Error('original Daily preparation must be current');

    dailyLossTracker.publishRecalculation(preparedDaily);
    const monitorContext = {
      ...createMonitorContextDouble({
        config: monitorConfig,
        symbolRegistry,

        orderRecorder,
        dailyLossTracker,
        riskChecker,
        longSymbolName: 'OLD_BULL.HK',
        shortSymbolName: '',
        monitorSymbolName: 'HSI.HK',
      }),
      seatSwitch: seatSwitch,
    };
    const stateFixtures = createRuntimeStates();
    const snapshot = createAccountPositionSnapshot({
      clock: { now: () => new Date() },
      diagnostics: createDiagnosticObserverDouble(),
      dayEpoch: 1,
      scheduler: { schedule: queueMicrotask },
      readPort: {
        getAccountSnapshot: async () => createAccountSnapshotDouble('100000'),
        getStockPositions: async () => [],
      },
      reportFatalError: rethrowFatalError,
    });
    const baseline = await snapshot.requestRefresh({
      source: 'periodic-integration-baseline',
      dayEpoch: 1,
      refreshAccount: true,
      refreshPositions: true,
    }).result;
    if (baseline.status !== 'COMMITTED') throw new Error('expected real canonical paired commit');

    const settlement = createPostTradeConsistencyRuntime({
      diagnostics: createDiagnosticObserverDouble(),
      clock: { now: () => new Date() },
      logger: createLoggerDouble(),
      snapshot,
      termination: createTerminationDouble({ reportFatalError: rethrowFatalError }),
      getProtectiveOrderReader: () => tradeRuntime.orderMonitor,
      onPositionsCommitted: async (token) => {
        if (!snapshot.isCurrent(token, { account: false, positions: true }))
          throw new Error('old position subscription commit');
      },
      scheduler: MONITOR_TASK_RUNTIME.scheduler,
    });
    settlement.bindBusinessDeps({
      monitorContext,
      dailyLossTracker,
      liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
      protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
      mixedTradeLogRepository: {
        appendCompletionIdempotent: () => {
          throw new Error('periodic case must not create protective completion');
        },
      },
    });
    settlement.start();
    expect(await settlement.completeRebuildBaseline()).toBeTrue();
    const readinessReceipt = await settlement.waitForFresh();
    expect(readinessReceipt.snapshotToken).toEqual(baseline.snapshotToken);
    expect(settlement.isCurrent(readinessReceipt)).toBeTrue();
    const switchWakeupRuntime = createStartedSwitchWakeupRuntime({
      monitorContext,
      tradeRuntime,
      stateFixtures: stateFixtures,
      snapshot,
      settlement,
      now: () => new Date(currentNowMs),
    });
    const issuedTasks: PeriodicSwitchTaskData[] = [];
    const dueCallbacks: Array<{
      handle: ReturnType<typeof setTimeout>;
      atMs: number;
      callback: () => void;
    }> = [];
    const periodicSwitchWakeupRuntime = createPeriodicSwitchWakeupRuntime({
      termination: createTerminationDouble({ reportFatalError: rethrowFatalError }),
      monitorContext,
      symbolRegistry,
      monitorTaskQueue: {
        scheduleLatest: (task) => {
          if (task.type !== 'AUTO_SYMBOL_TICK') throw new Error('unexpected periodic task');

          issuedTasks.push(task.data);
          expect(task.data.canContinue()).toBeTrue();
          return monitorTaskQueue.scheduleLatest(task);
        },
      },
      orderMonitor: tradeRuntime.orderMonitor,
      snapshot,
      getCanTradeNow: () =>
        stateFixtures.lifecycleState.isTradingEnabled &&
        stateFixtures.tradingTimeState.canTrade === true,
      postTradeConsistencyRuntime: settlement,
      tradingGateEventRuntime: createTradingGateEventRuntime(),
      calculateDueAtMs: ({ startMs, switchIntervalMinutes }) =>
        calculateTradingDurationDueAtMs({
          startMs,
          targetDurationMs: switchIntervalMinutes * 60000,
          calendarSnapshot: tradingCalendarSnapshot,
        }),
      now: () => new Date(currentNowMs),
      scheduleTimer: (callback, delayMs) => {
        const handle = setTimeout(callback, delayMs);
        dueCallbacks.push({ handle, atMs: currentNowMs + delayMs, callback });
        return handle;
      },
      clearTimer: (handle) => {
        clearTimeout(handle);
        const index = dueCallbacks.findIndex((entry) => entry.handle === handle);
        if (index !== -1) dueCallbacks.splice(index, 1);
      },
    });
    const periodicHandler = createPeriodicSwitchTaskHandler({
      monitorContext,
      switchWakeupRuntime,
      periodicSwitchWakeupRuntime,
      snapshot,
      getCanTradeNow: () =>
        stateFixtures.lifecycleState.isTradingEnabled &&
        stateFixtures.tradingTimeState.canTrade === true,
      logger: createLoggerStub(),
      now: () => new Date(currentNowMs),
    });
    const processor = createMonitorTaskProcessor({
      ...MONITOR_TASK_RUNTIME,
      monitorTaskQueue,
      ...periodicHandler,
      seatActivation: {
        activate: async () => {
          throw new Error('周期链不消费激活任务');
        },
        isCurrent: () => false,
      },
      logger: createLoggerStub(),
      termination: createTerminationDouble({ reportFatalError: rethrowFatalError }),
    });

    processor.start();
    periodicSwitchWakeupRuntime.start();
    try {
      await firePeriodicTimers(dueCallbacks, currentNowMs);

      await firePeriodicTimers(dueCallbacks, currentNowMs);

      await waitUntil(() => monitorTaskQueue.isEmpty());
      await processor.stopAndDrain();

      const seatAfterPeriodicMiss = symbolRegistry.getSeatState('LONG');
      expect(seatAfterPeriodicMiss.status).toBe('EMPTY');
      expect(seatAfterPeriodicMiss.symbol).toBeNull();
      expect(seatAfterPeriodicMiss.searchFailCountToday).toBe(1);
      expect(symbolRegistry.getSeatVersion('LONG')).toBe(2);
      expect(seatSwitch.hasPendingSwitch('LONG')).toBeFalse();

      processor.restart();
      currentNowMs += 600_000;

      await firePeriodicTimers(dueCallbacks, currentNowMs);

      await firePeriodicTimers(dueCallbacks, currentNowMs);

      await waitUntil(() => monitorTaskQueue.isEmpty());
      await processor.stopAndDrain();

      const seatAfterAutoSearch = symbolRegistry.getSeatState('LONG');
      expect(seatAfterAutoSearch.status).toBe('EMPTY');
      expect(seatAfterAutoSearch.symbol).toBeNull();
      expect(seatAfterAutoSearch.searchFailCountToday).toBe(1);
      expect(seatSwitch.hasPendingSwitch('LONG')).toBeFalse();
      expect(symbolRegistry.getSeatVersion('LONG')).toBe(2);
    } finally {
      await processor.stopAndDrain();
      await switchWakeupRuntime.stopAndDrain();
      await periodicSwitchWakeupRuntime.stopAndDrain();
      await settlement.stopAndDrain();
      expect(mutationCalls).toBe(0);
      expect(issuedTasks.length).toBeGreaterThan(0);
      await snapshot.requestClear({ reason: 'STOP', dayEpoch: snapshot.getView().token.dayEpoch });
    }
  });

  it('keeps seat ACTIVE when local pending buy order exists before order recorder is written', async () => {
    const readyMs = Date.parse('2026-02-16T01:30:00.000Z');
    const currentNowMs = Date.parse('2026-02-16T01:31:00.000Z');
    candidateQueue = [createWarrantCandidateWithOverrides('NEW_BULL.HK', { callPrice: '21000' })];
    const tradingCalendarSnapshot = new Map([
      ['2026-02-16', { isTradingDay: true, isHalfDay: false }],
    ]);

    const monitorConfig = createMonitorConfigDouble({
      monitorSymbol: 'HSI.HK',
      autoSearchConfig: {
        autoSearchEnabled: true,
        autoSearchMinDistancePctBull: '0.35',
        autoSearchMinDistancePctBear: '-0.35',
        autoSearchMinTurnoverPerMinuteBull: '100000',
        autoSearchMinTurnoverPerMinuteBear: '100000',
        autoSearchExpiryMinMonths: 3,
        autoSearchOpenDelayMinutes: 0,
        switchIntervalMinutes: 1,
        switchDistanceRangeBull: { min: '0.2', max: '1.5' },
        switchDistanceRangeBear: { min: '-1.5', max: '-0.2' },
      },
    });

    const symbolRegistry = createSymbolRegistry(monitorConfig);
    symbolRegistry.updateSeatState('LONG', {
      symbol: 'OLD_BULL.HK',
      status: 'ACTIVE',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: readyMs,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
      callPrice: '20000',
    });

    let mutationCalls = 0;
    const tradeRuntime = createTradeRuntimeDouble({
      orderExecutor: {
        executeSignals: async (_signals, callerAuthorization) => {
          mutationCalls += 1;
          if (!callerAuthorization()) throw new Error('periodic stale mutation attempted');

          throw new Error('periodic switch must never SELL or REBUY');
        },
      },
      cacheManager: { getPendingOrders: async () => [] },
      orderHoldRegistry: { getHoldSymbols: () => new Set(['OLD_BULL.HK']) },
      orderMonitor: {
        cancelOrder: async () => ({
          kind: 'CANCEL_CONFIRMED',
          relatedBuyOrderIds: null,
        }),
      },
    });

    const orderRecorder = createOrderRecorderDouble({
      getBuyOrdersForSymbol: () => [],
    });
    const riskChecker = createRiskCheckerDouble({
      getWarrantDistanceInfo: () =>
        createWarrantDistanceInfoDouble({
          warrantType: 'BULL',
          distanceNumerator: '0.1',
          distanceDenominator: '100',
        }),
    });

    const seatSwitch = createSeatSwitchWorkflow({
      logger: createLoggerStub(),
      monitorConfig,
      symbolRegistry,
      marketDataClient: createMarketDataClientDouble(),
      cacheManager: tradeRuntime.cacheManager,
      orderHoldRegistry: tradeRuntime.orderHoldRegistry,
      orderMonitor: tradeRuntime.orderMonitor,
      orderExecutor: tradeRuntime.orderExecutor,
      orderRecorder,
      riskChecker,
      candidateSearch: {
        resolveDistanceRange: (direction) =>
          monitorConfig.autoSearchConfig[
            direction === 'LONG' ? 'switchDistanceRangeBull' : 'switchDistanceRangeBear'
          ],
        findCandidate: async () => candidateQueue.shift() ?? null,
      },
      clock: { now: () => new Date(currentNowMs) },
      getTradingCalendarSnapshot: () => tradingCalendarSnapshot,
    });

    const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskDataMap>({
      logger: createLoggerDouble(),
      clock: { now: () => new Date() },
      diagnostics: createDiagnosticObserverDouble(),
    });
    const dailyLossTracker = createDailyLossTrackerDouble();
    const preparedDaily = dailyLossTracker.prepareRecalculationFromAllOrders(
      [],
      monitorConfig,
      new Date(currentNowMs),
      undefined,
      new Set(['OLD_BULL.HK', 'NEW_BULL.HK']),
    );
    if (!preparedDaily.isCurrent()) throw new Error('original Daily preparation must be current');

    dailyLossTracker.publishRecalculation(preparedDaily);
    const monitorContext = {
      ...createMonitorContextDouble({
        config: monitorConfig,
        symbolRegistry,

        orderRecorder,
        dailyLossTracker,
        riskChecker,
        longSymbolName: 'OLD_BULL.HK',
        shortSymbolName: '',
        monitorSymbolName: 'HSI.HK',
      }),
      seatSwitch: seatSwitch,
    };
    const stateFixtures = createRuntimeStates();
    const snapshot = createAccountPositionSnapshot({
      clock: { now: () => new Date() },
      diagnostics: createDiagnosticObserverDouble(),
      dayEpoch: 1,
      scheduler: { schedule: queueMicrotask },
      readPort: {
        getAccountSnapshot: async () => createAccountSnapshotDouble('100000'),
        getStockPositions: async () => [],
      },
      reportFatalError: rethrowFatalError,
    });
    const baseline = await snapshot.requestRefresh({
      source: 'periodic-integration-baseline',
      dayEpoch: 1,
      refreshAccount: true,
      refreshPositions: true,
    }).result;
    if (baseline.status !== 'COMMITTED') throw new Error('expected real canonical paired commit');

    const settlement = createPostTradeConsistencyRuntime({
      diagnostics: createDiagnosticObserverDouble(),
      clock: { now: () => new Date() },
      logger: createLoggerDouble(),
      snapshot,
      termination: createTerminationDouble({ reportFatalError: rethrowFatalError }),
      getProtectiveOrderReader: () => tradeRuntime.orderMonitor,
      onPositionsCommitted: async (token) => {
        if (!snapshot.isCurrent(token, { account: false, positions: true }))
          throw new Error('old position subscription commit');
      },
      scheduler: MONITOR_TASK_RUNTIME.scheduler,
    });
    settlement.bindBusinessDeps({
      monitorContext,
      dailyLossTracker,
      liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
      protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
      mixedTradeLogRepository: {
        appendCompletionIdempotent: () => {
          throw new Error('periodic case must not create protective completion');
        },
      },
    });
    settlement.start();
    expect(await settlement.completeRebuildBaseline()).toBeTrue();
    const readinessReceipt = await settlement.waitForFresh();
    expect(readinessReceipt.snapshotToken).toEqual(baseline.snapshotToken);
    expect(settlement.isCurrent(readinessReceipt)).toBeTrue();
    const switchWakeupRuntime = createStartedSwitchWakeupRuntime({
      monitorContext,
      tradeRuntime,
      stateFixtures: stateFixtures,
      snapshot,
      settlement,
      now: () => new Date(currentNowMs),
    });
    const issuedTasks: PeriodicSwitchTaskData[] = [];
    const dueCallbacks: Array<{
      handle: ReturnType<typeof setTimeout>;
      atMs: number;
      callback: () => void;
    }> = [];
    const periodicSwitchWakeupRuntime = createPeriodicSwitchWakeupRuntime({
      termination: createTerminationDouble({ reportFatalError: rethrowFatalError }),
      monitorContext,
      symbolRegistry,
      monitorTaskQueue: {
        scheduleLatest: (task) => {
          if (task.type !== 'AUTO_SYMBOL_TICK') throw new Error('unexpected periodic task');

          issuedTasks.push(task.data);
          expect(task.data.canContinue()).toBeTrue();
          return monitorTaskQueue.scheduleLatest(task);
        },
      },
      orderMonitor: tradeRuntime.orderMonitor,
      snapshot,
      getCanTradeNow: () =>
        stateFixtures.lifecycleState.isTradingEnabled &&
        stateFixtures.tradingTimeState.canTrade === true,
      postTradeConsistencyRuntime: settlement,
      tradingGateEventRuntime: createTradingGateEventRuntime(),
      calculateDueAtMs: ({ startMs, switchIntervalMinutes }) =>
        calculateTradingDurationDueAtMs({
          startMs,
          targetDurationMs: switchIntervalMinutes * 60000,
          calendarSnapshot: tradingCalendarSnapshot,
        }),
      now: () => new Date(currentNowMs),
      scheduleTimer: (callback, delayMs) => {
        const handle = setTimeout(callback, delayMs);
        dueCallbacks.push({ handle, atMs: currentNowMs + delayMs, callback });
        return handle;
      },
      clearTimer: (handle) => {
        clearTimeout(handle);
        const index = dueCallbacks.findIndex((entry) => entry.handle === handle);
        if (index !== -1) dueCallbacks.splice(index, 1);
      },
    });
    const periodicHandler = createPeriodicSwitchTaskHandler({
      monitorContext,
      switchWakeupRuntime,
      periodicSwitchWakeupRuntime,
      snapshot,
      getCanTradeNow: () =>
        stateFixtures.lifecycleState.isTradingEnabled &&
        stateFixtures.tradingTimeState.canTrade === true,
      logger: createLoggerStub(),
      now: () => new Date(currentNowMs),
    });
    const processor = createMonitorTaskProcessor({
      ...MONITOR_TASK_RUNTIME,
      monitorTaskQueue,
      ...periodicHandler,
      seatActivation: {
        activate: async () => {
          throw new Error('周期链不消费激活任务');
        },
        isCurrent: () => false,
      },
      logger: createLoggerStub(),
      termination: createTerminationDouble({ reportFatalError: rethrowFatalError }),
    });

    processor.start();
    periodicSwitchWakeupRuntime.start();
    try {
      await firePeriodicTimers(dueCallbacks, currentNowMs);

      await firePeriodicTimers(dueCallbacks, currentNowMs);

      await waitUntil(() => monitorTaskQueue.isEmpty());
      await processor.stopAndDrain();
      const seat = symbolRegistry.getSeatState('LONG');
      expect(seat.status).toBe('ACTIVE');
      expect(seat.symbol).toBe('OLD_BULL.HK');
      expect(symbolRegistry.getSeatVersion('LONG')).toBe(1);
      expect(seatSwitch.hasPendingSwitch('LONG')).toBeFalse();
    } finally {
      await processor.stopAndDrain();
      await switchWakeupRuntime.stopAndDrain();
      await periodicSwitchWakeupRuntime.stopAndDrain();
      await settlement.stopAndDrain();
      expect(mutationCalls).toBe(0);
      expect(issuedTasks.length).toBeGreaterThan(0);
      await snapshot.requestClear({ reason: 'STOP', dayEpoch: snapshot.getView().token.dayEpoch });
    }
  });

  it('keeps seat ACTIVE when local pending sell order remains after order recorder is cleared', async () => {
    const readyMs = Date.parse('2026-02-16T01:30:00.000Z');
    const currentNowMs = Date.parse('2026-02-16T01:31:00.000Z');
    candidateQueue = [createWarrantCandidateWithOverrides('NEW_BULL.HK', { callPrice: '21000' })];
    const tradingCalendarSnapshot = new Map([
      ['2026-02-16', { isTradingDay: true, isHalfDay: false }],
    ]);

    const monitorConfig = createMonitorConfigDouble({
      monitorSymbol: 'HSI.HK',
      autoSearchConfig: {
        autoSearchEnabled: true,
        autoSearchMinDistancePctBull: '0.35',
        autoSearchMinDistancePctBear: '-0.35',
        autoSearchMinTurnoverPerMinuteBull: '100000',
        autoSearchMinTurnoverPerMinuteBear: '100000',
        autoSearchExpiryMinMonths: 3,
        autoSearchOpenDelayMinutes: 0,
        switchIntervalMinutes: 1,
        switchDistanceRangeBull: { min: '0.2', max: '1.5' },
        switchDistanceRangeBear: { min: '-1.5', max: '-0.2' },
      },
    });

    const symbolRegistry = createSymbolRegistry(monitorConfig);
    symbolRegistry.updateSeatState('LONG', {
      symbol: 'OLD_BULL.HK',
      status: 'ACTIVE',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: readyMs,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
      callPrice: '20000',
    });

    let mutationCalls = 0;
    const tradeRuntime = createTradeRuntimeDouble({
      orderExecutor: {
        executeSignals: async (_signals, callerAuthorization) => {
          mutationCalls += 1;
          if (!callerAuthorization()) throw new Error('periodic stale mutation attempted');

          throw new Error('periodic switch must never SELL or REBUY');
        },
      },
      cacheManager: { getPendingOrders: async () => [] },
      orderHoldRegistry: { getHoldSymbols: () => new Set(['OLD_BULL.HK']) },
      orderMonitor: {
        cancelOrder: async () => ({
          kind: 'CANCEL_CONFIRMED',
          relatedBuyOrderIds: null,
        }),
      },
    });

    const orderRecorder = createOrderRecorderDouble({
      getBuyOrdersForSymbol: () => [],
    });
    const riskChecker = createRiskCheckerDouble({
      getWarrantDistanceInfo: () =>
        createWarrantDistanceInfoDouble({
          warrantType: 'BULL',
          distanceNumerator: '0.1',
          distanceDenominator: '100',
        }),
    });

    const seatSwitch = createSeatSwitchWorkflow({
      logger: createLoggerStub(),
      monitorConfig,
      symbolRegistry,
      marketDataClient: createMarketDataClientDouble(),
      cacheManager: tradeRuntime.cacheManager,
      orderHoldRegistry: tradeRuntime.orderHoldRegistry,
      orderMonitor: tradeRuntime.orderMonitor,
      orderExecutor: tradeRuntime.orderExecutor,
      orderRecorder,
      riskChecker,
      candidateSearch: {
        resolveDistanceRange: (direction) =>
          monitorConfig.autoSearchConfig[
            direction === 'LONG' ? 'switchDistanceRangeBull' : 'switchDistanceRangeBear'
          ],
        findCandidate: async () => candidateQueue.shift() ?? null,
      },
      clock: { now: () => new Date(currentNowMs) },
      getTradingCalendarSnapshot: () => tradingCalendarSnapshot,
    });

    const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskDataMap>({
      logger: createLoggerDouble(),
      clock: { now: () => new Date() },
      diagnostics: createDiagnosticObserverDouble(),
    });
    const dailyLossTracker = createDailyLossTrackerDouble();
    const preparedDaily = dailyLossTracker.prepareRecalculationFromAllOrders(
      [],
      monitorConfig,
      new Date(currentNowMs),
      undefined,
      new Set(['OLD_BULL.HK', 'NEW_BULL.HK']),
    );
    if (!preparedDaily.isCurrent()) throw new Error('original Daily preparation must be current');

    dailyLossTracker.publishRecalculation(preparedDaily);
    const monitorContext = {
      ...createMonitorContextDouble({
        config: monitorConfig,
        symbolRegistry,

        orderRecorder,
        dailyLossTracker,
        riskChecker,
        longSymbolName: 'OLD_BULL.HK',
        shortSymbolName: '',
        monitorSymbolName: 'HSI.HK',
      }),
      seatSwitch: seatSwitch,
    };
    const stateFixtures = createRuntimeStates();
    const snapshot = createAccountPositionSnapshot({
      clock: { now: () => new Date() },
      diagnostics: createDiagnosticObserverDouble(),
      dayEpoch: 1,
      scheduler: { schedule: queueMicrotask },
      readPort: {
        getAccountSnapshot: async () => createAccountSnapshotDouble('100000'),
        getStockPositions: async () => [],
      },
      reportFatalError: rethrowFatalError,
    });
    const baseline = await snapshot.requestRefresh({
      source: 'periodic-integration-baseline',
      dayEpoch: 1,
      refreshAccount: true,
      refreshPositions: true,
    }).result;
    if (baseline.status !== 'COMMITTED') throw new Error('expected real canonical paired commit');

    const settlement = createPostTradeConsistencyRuntime({
      diagnostics: createDiagnosticObserverDouble(),
      clock: { now: () => new Date() },
      logger: createLoggerDouble(),
      snapshot,
      termination: createTerminationDouble({ reportFatalError: rethrowFatalError }),
      getProtectiveOrderReader: () => tradeRuntime.orderMonitor,
      onPositionsCommitted: async (token) => {
        if (!snapshot.isCurrent(token, { account: false, positions: true }))
          throw new Error('old position subscription commit');
      },
      scheduler: MONITOR_TASK_RUNTIME.scheduler,
    });
    settlement.bindBusinessDeps({
      monitorContext,
      dailyLossTracker,
      liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
      protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
      mixedTradeLogRepository: {
        appendCompletionIdempotent: () => {
          throw new Error('periodic case must not create protective completion');
        },
      },
    });
    settlement.start();
    expect(await settlement.completeRebuildBaseline()).toBeTrue();
    const readinessReceipt = await settlement.waitForFresh();
    expect(readinessReceipt.snapshotToken).toEqual(baseline.snapshotToken);
    expect(settlement.isCurrent(readinessReceipt)).toBeTrue();
    const switchWakeupRuntime = createStartedSwitchWakeupRuntime({
      monitorContext,
      tradeRuntime,
      stateFixtures: stateFixtures,
      snapshot,
      settlement,
      now: () => new Date(currentNowMs),
    });
    const issuedTasks: PeriodicSwitchTaskData[] = [];
    const dueCallbacks: Array<{
      handle: ReturnType<typeof setTimeout>;
      atMs: number;
      callback: () => void;
    }> = [];
    const periodicSwitchWakeupRuntime = createPeriodicSwitchWakeupRuntime({
      termination: createTerminationDouble({ reportFatalError: rethrowFatalError }),
      monitorContext,
      symbolRegistry,
      monitorTaskQueue: {
        scheduleLatest: (task) => {
          if (task.type !== 'AUTO_SYMBOL_TICK') throw new Error('unexpected periodic task');

          issuedTasks.push(task.data);
          expect(task.data.canContinue()).toBeTrue();
          return monitorTaskQueue.scheduleLatest(task);
        },
      },
      orderMonitor: tradeRuntime.orderMonitor,
      snapshot,
      getCanTradeNow: () =>
        stateFixtures.lifecycleState.isTradingEnabled &&
        stateFixtures.tradingTimeState.canTrade === true,
      postTradeConsistencyRuntime: settlement,
      tradingGateEventRuntime: createTradingGateEventRuntime(),
      calculateDueAtMs: ({ startMs, switchIntervalMinutes }) =>
        calculateTradingDurationDueAtMs({
          startMs,
          targetDurationMs: switchIntervalMinutes * 60000,
          calendarSnapshot: tradingCalendarSnapshot,
        }),
      now: () => new Date(currentNowMs),
      scheduleTimer: (callback, delayMs) => {
        const handle = setTimeout(callback, delayMs);
        dueCallbacks.push({ handle, atMs: currentNowMs + delayMs, callback });
        return handle;
      },
      clearTimer: (handle) => {
        clearTimeout(handle);
        const index = dueCallbacks.findIndex((entry) => entry.handle === handle);
        if (index !== -1) dueCallbacks.splice(index, 1);
      },
    });
    const periodicHandler = createPeriodicSwitchTaskHandler({
      monitorContext,
      switchWakeupRuntime,
      periodicSwitchWakeupRuntime,
      snapshot,
      getCanTradeNow: () =>
        stateFixtures.lifecycleState.isTradingEnabled &&
        stateFixtures.tradingTimeState.canTrade === true,
      logger: createLoggerStub(),
      now: () => new Date(currentNowMs),
    });
    const processor = createMonitorTaskProcessor({
      ...MONITOR_TASK_RUNTIME,
      monitorTaskQueue,
      ...periodicHandler,
      seatActivation: {
        activate: async () => {
          throw new Error('周期链不消费激活任务');
        },
        isCurrent: () => false,
      },
      logger: createLoggerStub(),
      termination: createTerminationDouble({ reportFatalError: rethrowFatalError }),
    });

    processor.start();
    periodicSwitchWakeupRuntime.start();
    try {
      await firePeriodicTimers(dueCallbacks, currentNowMs);

      await firePeriodicTimers(dueCallbacks, currentNowMs);

      await waitUntil(() => monitorTaskQueue.isEmpty());
      await processor.stopAndDrain();
      const seat = symbolRegistry.getSeatState('LONG');
      expect(seat.status).toBe('ACTIVE');
      expect(seat.symbol).toBe('OLD_BULL.HK');
      expect(symbolRegistry.getSeatVersion('LONG')).toBe(1);
      expect(seatSwitch.hasPendingSwitch('LONG')).toBeFalse();
    } finally {
      await processor.stopAndDrain();
      await switchWakeupRuntime.stopAndDrain();
      await periodicSwitchWakeupRuntime.stopAndDrain();
      await settlement.stopAndDrain();
      expect(mutationCalls).toBe(0);
      expect(issuedTasks.length).toBeGreaterThan(0);
      await snapshot.requestClear({ reason: 'STOP', dayEpoch: snapshot.getView().token.dayEpoch });
    }
  });

  it('applies cross-day trading-duration rule before periodic switch is triggered', async () => {
    const readyMs = Date.parse('2026-02-16T07:59:00.000Z'); // Day1 15:59 HK
    let currentNowMs = Date.parse('2026-02-17T01:30:00.000Z'); // Day2 09:30 HK
    candidateQueue = [createWarrantCandidateWithOverrides('NEW_BULL.HK', { callPrice: '21000' })];
    const tradingCalendarSnapshot = new Map([
      ['2026-02-16', { isTradingDay: true, isHalfDay: false }],
      ['2026-02-17', { isTradingDay: true, isHalfDay: false }],
    ]);

    const monitorConfig = createMonitorConfigDouble({
      monitorSymbol: 'HSI.HK',
      autoSearchConfig: {
        autoSearchEnabled: true,
        autoSearchMinDistancePctBull: '0.35',
        autoSearchMinDistancePctBear: '-0.35',
        autoSearchMinTurnoverPerMinuteBull: '100000',
        autoSearchMinTurnoverPerMinuteBear: '100000',
        autoSearchExpiryMinMonths: 3,
        autoSearchOpenDelayMinutes: 0,
        switchIntervalMinutes: 2,
        switchDistanceRangeBull: { min: '0.2', max: '1.5' },
        switchDistanceRangeBear: { min: '-1.5', max: '-0.2' },
      },
    });

    const symbolRegistry = createSymbolRegistry(monitorConfig);
    symbolRegistry.updateSeatState('LONG', {
      symbol: 'OLD_BULL.HK',
      status: 'ACTIVE',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: readyMs,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
      callPrice: '20000',
    });

    let mutationCalls = 0;
    const tradeRuntime = createTradeRuntimeDouble({
      orderExecutor: {
        executeSignals: async (_signals, callerAuthorization) => {
          mutationCalls += 1;
          if (!callerAuthorization()) throw new Error('periodic stale mutation attempted');

          throw new Error('periodic switch must never SELL or REBUY');
        },
      },
      cacheManager: { getPendingOrders: async () => [] },
      orderMonitor: {
        cancelOrder: async () => ({
          kind: 'CANCEL_CONFIRMED',
          relatedBuyOrderIds: null,
        }),
      },
    });

    const orderRecorder = createOrderRecorderDouble({
      getBuyOrdersForSymbol: () => [],
    });
    const riskChecker = createRiskCheckerDouble({
      getWarrantDistanceInfo: () =>
        createWarrantDistanceInfoDouble({
          warrantType: 'BULL',
          distanceNumerator: '0.1',
          distanceDenominator: '100',
        }),
    });

    const seatSwitch = createSeatSwitchWorkflow({
      logger: createLoggerStub(),
      monitorConfig,
      symbolRegistry,
      marketDataClient: createMarketDataClientDouble(),
      cacheManager: tradeRuntime.cacheManager,
      orderHoldRegistry: tradeRuntime.orderHoldRegistry,
      orderMonitor: tradeRuntime.orderMonitor,
      orderExecutor: tradeRuntime.orderExecutor,
      orderRecorder,
      riskChecker,
      candidateSearch: {
        resolveDistanceRange: (direction) =>
          monitorConfig.autoSearchConfig[
            direction === 'LONG' ? 'switchDistanceRangeBull' : 'switchDistanceRangeBear'
          ],
        findCandidate: async () => candidateQueue.shift() ?? null,
      },
      clock: { now: () => new Date(currentNowMs) },
      getTradingCalendarSnapshot: () => tradingCalendarSnapshot,
    });

    const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskDataMap>({
      logger: createLoggerDouble(),
      clock: { now: () => new Date() },
      diagnostics: createDiagnosticObserverDouble(),
    });
    const dailyLossTracker = createDailyLossTrackerDouble();
    const preparedDaily = dailyLossTracker.prepareRecalculationFromAllOrders(
      [],
      monitorConfig,
      new Date(currentNowMs),
      undefined,
      new Set(['OLD_BULL.HK', 'NEW_BULL.HK']),
    );
    if (!preparedDaily.isCurrent()) throw new Error('original Daily preparation must be current');

    dailyLossTracker.publishRecalculation(preparedDaily);
    const monitorContext = {
      ...createMonitorContextDouble({
        config: monitorConfig,
        symbolRegistry,

        orderRecorder,
        dailyLossTracker,
        riskChecker,
        longSymbolName: 'OLD_BULL.HK',
        shortSymbolName: '',
        monitorSymbolName: 'HSI.HK',
      }),
      seatSwitch: seatSwitch,
    };
    const stateFixtures = createRuntimeStates();
    const snapshot = createAccountPositionSnapshot({
      clock: { now: () => new Date() },
      diagnostics: createDiagnosticObserverDouble(),
      dayEpoch: 1,
      scheduler: { schedule: queueMicrotask },
      readPort: {
        getAccountSnapshot: async () => createAccountSnapshotDouble('100000'),
        getStockPositions: async () => [],
      },
      reportFatalError: rethrowFatalError,
    });
    const baseline = await snapshot.requestRefresh({
      source: 'periodic-integration-baseline',
      dayEpoch: 1,
      refreshAccount: true,
      refreshPositions: true,
    }).result;
    if (baseline.status !== 'COMMITTED') throw new Error('expected real canonical paired commit');

    const settlement = createPostTradeConsistencyRuntime({
      diagnostics: createDiagnosticObserverDouble(),
      clock: { now: () => new Date() },
      logger: createLoggerDouble(),
      snapshot,
      termination: createTerminationDouble({ reportFatalError: rethrowFatalError }),
      getProtectiveOrderReader: () => tradeRuntime.orderMonitor,
      onPositionsCommitted: async (token) => {
        if (!snapshot.isCurrent(token, { account: false, positions: true }))
          throw new Error('old position subscription commit');
      },
      scheduler: MONITOR_TASK_RUNTIME.scheduler,
    });
    settlement.bindBusinessDeps({
      monitorContext,
      dailyLossTracker,
      liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
      protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
      mixedTradeLogRepository: {
        appendCompletionIdempotent: () => {
          throw new Error('periodic case must not create protective completion');
        },
      },
    });
    settlement.start();
    expect(await settlement.completeRebuildBaseline()).toBeTrue();
    const readinessReceipt = await settlement.waitForFresh();
    expect(readinessReceipt.snapshotToken).toEqual(baseline.snapshotToken);
    expect(settlement.isCurrent(readinessReceipt)).toBeTrue();
    const switchWakeupRuntime = createStartedSwitchWakeupRuntime({
      monitorContext,
      tradeRuntime,
      stateFixtures: stateFixtures,
      snapshot,
      settlement,
      now: () => new Date(currentNowMs),
    });
    const issuedTasks: PeriodicSwitchTaskData[] = [];
    const dueCallbacks: Array<{
      handle: ReturnType<typeof setTimeout>;
      atMs: number;
      callback: () => void;
    }> = [];
    const periodicSwitchWakeupRuntime = createPeriodicSwitchWakeupRuntime({
      termination: createTerminationDouble({ reportFatalError: rethrowFatalError }),
      monitorContext,
      symbolRegistry,
      monitorTaskQueue: {
        scheduleLatest: (task) => {
          if (task.type !== 'AUTO_SYMBOL_TICK') throw new Error('unexpected periodic task');

          issuedTasks.push(task.data);
          expect(task.data.canContinue()).toBeTrue();
          return monitorTaskQueue.scheduleLatest(task);
        },
      },
      orderMonitor: tradeRuntime.orderMonitor,
      snapshot,
      getCanTradeNow: () =>
        stateFixtures.lifecycleState.isTradingEnabled &&
        stateFixtures.tradingTimeState.canTrade === true,
      postTradeConsistencyRuntime: settlement,
      tradingGateEventRuntime: createTradingGateEventRuntime(),
      calculateDueAtMs: ({ startMs, switchIntervalMinutes }) =>
        calculateTradingDurationDueAtMs({
          startMs,
          targetDurationMs: switchIntervalMinutes * 60000,
          calendarSnapshot: tradingCalendarSnapshot,
        }),
      now: () => new Date(currentNowMs),
      scheduleTimer: (callback, delayMs) => {
        const handle = setTimeout(callback, delayMs);
        dueCallbacks.push({ handle, atMs: currentNowMs + delayMs, callback });
        return handle;
      },
      clearTimer: (handle) => {
        clearTimeout(handle);
        const index = dueCallbacks.findIndex((entry) => entry.handle === handle);
        if (index !== -1) dueCallbacks.splice(index, 1);
      },
    });
    const periodicHandler = createPeriodicSwitchTaskHandler({
      monitorContext,
      switchWakeupRuntime,
      periodicSwitchWakeupRuntime,
      snapshot,
      getCanTradeNow: () =>
        stateFixtures.lifecycleState.isTradingEnabled &&
        stateFixtures.tradingTimeState.canTrade === true,
      logger: createLoggerStub(),
      now: () => new Date(currentNowMs),
    });
    const processor = createMonitorTaskProcessor({
      ...MONITOR_TASK_RUNTIME,
      monitorTaskQueue,
      ...periodicHandler,
      seatActivation: {
        activate: async () => {
          throw new Error('周期链不消费激活任务');
        },
        isCurrent: () => false,
      },
      logger: createLoggerStub(),
      termination: createTerminationDouble({ reportFatalError: rethrowFatalError }),
    });

    processor.start();
    periodicSwitchWakeupRuntime.start();
    try {
      await firePeriodicTimers(dueCallbacks, currentNowMs);

      await firePeriodicTimers(dueCallbacks, currentNowMs);

      await waitUntil(() => monitorTaskQueue.isEmpty());
      await processor.stopAndDrain();
      expect(symbolRegistry.getSeatState('LONG').status).toBe('ACTIVE');
      expect(seatSwitch.hasPendingSwitch('LONG')).toBeFalse();

      processor.restart();
      currentNowMs += 60_000; // Day2 09:31 HK

      await firePeriodicTimers(dueCallbacks, currentNowMs);

      await firePeriodicTimers(dueCallbacks, currentNowMs);

      await waitUntil(() => monitorTaskQueue.isEmpty());
      await waitUntil(() => symbolRegistry.getSeatState('LONG').status === 'ACTIVATING');
      await processor.stopAndDrain();

      const switchingSeat = symbolRegistry.getSeatState('LONG');
      expect(switchingSeat.status).toBe('ACTIVATING');
      expect(switchingSeat.symbol).toBe('NEW_BULL.HK');
      expect(seatSwitch.hasPendingSwitch('LONG')).toBeFalse();
      expect(symbolRegistry.getSeatVersion('LONG')).toBe(2);
    } finally {
      await processor.stopAndDrain();
      await switchWakeupRuntime.stopAndDrain();
      await periodicSwitchWakeupRuntime.stopAndDrain();
      await settlement.stopAndDrain();
      expect(mutationCalls).toBe(0);
      expect(issuedTasks.length).toBeGreaterThan(0);
      await snapshot.requestClear({ reason: 'STOP', dayEpoch: snapshot.getView().token.dayEpoch });
    }
  });
});
