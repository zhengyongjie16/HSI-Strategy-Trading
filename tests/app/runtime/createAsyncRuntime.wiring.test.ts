import { createSnapshotFixture } from '../../main/fixtures/accountPositionSnapshot.js';
import { TRADING } from '../../../src/constants/index.js';
import { createIssuedPeriodicTasksFixture } from '../../main/fixtures/issuedPeriodicTasks.js';
import { getDefaultAutoSearchConfig } from '../../helpers/seatTestUtils.js';
import { createTerminationRuntime } from '../../../src/app/runtime/createTerminationRuntime.js';
import { createCleanup } from '../../../src/app/shutdown/createCleanup.js';
import type { RuntimeTermination } from '../../../src/types/runtime.js';

/**
 * app/createAsyncRuntime 接线测试
 *
 * 覆盖：
 * - lifecycle/末日 gate 关闭时，AUTO_SYMBOL_TICK 不回写 PeriodicSwitchWakeupRuntime owner
 * - 外部 API 失败时以 failed 状态回写 owner；非 API 错误进入异步 fatal 通道且不回写 periodic route
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { createAsyncRuntime as buildAsyncRuntime } from '../../../src/app/runtime/createAsyncRuntime.js';
import { createMonitorTaskQueue } from '../../../src/runtime/asyncProgram/monitorTaskQueue/index.js';
import { createExternalApiRequestError } from '../../helpers/createExternalApiRequestError.js';
import {
  createBuyTaskQueue,
  createSellTaskQueue,
} from '../../../src/runtime/asyncProgram/tradeTaskQueue/index.js';
import { createWarrantListCache } from '../../../src/infrastructure/longbridge/market/warrantListCache/index.js';
import type { AsyncRuntimeFactoryDeps } from '../../../src/app/types.js';
import type { MonitorTaskDataMap } from '../../../src/runtime/asyncProgram/monitorTaskProcessor/types.js';
import type { PeriodicSwitchWakeupRuntime } from '../../../src/runtime/periodicSwitchWakeupRuntime/types.js';
import type { LastState, MonitorContext } from '../../../src/types/state.js';
import { createTradingConfig } from '../../../mock/factories/configFactory.js';
import { createBrokerClientFactoryDouble } from '../../helpers/brokerClientFactoryDouble.js';
import {
  createDailyLossTrackerDouble,
  createAccountSnapshotDouble,
  createMonitorConfigDouble,
  createDoomsdayClearanceWorkflowDouble,
  createOrdinaryBuyWorkflowDouble,
  createOrdinarySellWorkflowDouble,
  createLoggerDouble,
  createSeatActivationWorkflowDouble,
  createWarrantRiskRefreshDouble,
  createMarketDataClientDouble,
  createProtectiveLiquidationEpisodeTrackerDouble,
  createQuoteSubscriptionRuntimeDouble,
  createSeatRuntimeCleanupDispatcherDouble,
  createSymbolRegistryDouble,
  createTraderDouble,
} from '../../helpers/testDoubles.js';
import {
  createLastState,
  createMonitorContext,
  runProcessorFlow,
} from '../../main/asyncProgram/utils.js';

let activeTermination: RuntimeTermination;
let issued: Awaited<ReturnType<typeof createIssuedPeriodicTasksFixture>>;
const fixtureCleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of fixtureCleanups.splice(0)) await cleanup();
});
function createAsyncRuntime(params: AsyncRuntimeFactoryDeps) {
  const runtime = buildAsyncRuntime(params);
  if (runtime === null) throw new Error('unexpected terminated runtime');

  return runtime;
}

async function waitForFatalError(): Promise<unknown> {
  await activeTermination.waitForTermination();
  const state = activeTermination.getFatalState();
  if (!state.hasFatalError) throw new Error('expected fatal');

  return state.error;
}

function createPeriodicSwitchWakeupRuntimeRecorder(
  calls: Parameters<PeriodicSwitchWakeupRuntime['replanRouteAfterTask']>[0][],
): PeriodicSwitchWakeupRuntime {
  return {
    start: () => {},
    stop: () => {},
    stopAndDrain: async () => {},
    markWaitingEmpty: () => {},
    clearWaitingEmpty: () => {},
    replanRouteAfterTask: (params) => {
      calls.push(params);
    },
  };
}

async function createDeps(
  options: Readonly<{
    lastState: LastState;
    monitorTaskQueue: ReturnType<typeof createMonitorTaskQueue<MonitorTaskDataMap>>;
    periodicSwitchWakeupRuntime: PeriodicSwitchWakeupRuntime;
    monitorContext?: MonitorContext;
    clockNow?: () => Date;
  }>,
): Promise<AsyncRuntimeFactoryDeps> {
  const { lastState, monitorTaskQueue, periodicSwitchWakeupRuntime, monitorContext, clockNow } =
    options;
  const warrantListCache = createWarrantListCache();
  const runtimeMonitorContext = {
    ...(monitorContext ?? createMonitorContext()),
    config: createMonitorConfigDouble({
      autoSearchConfig: { ...getDefaultAutoSearchConfig(), switchIntervalMinutes: 1 },
    }),
  };
  const snapshot = await createSnapshotFixture({
    account: createAccountSnapshotDouble('100000'),
    positions: [],
  });
  const trader = createTraderDouble();
  for (const direction of ['LONG', 'SHORT'] as const)
    runtimeMonitorContext.symbolRegistry.updateSeatState(direction, {
      ...runtimeMonitorContext.symbolRegistry.getSeatState(direction),
      lastSeatActivatedAt: 12000,
    });

  activeTermination = createTerminationRuntime({
    closeTradingGate: () => {},
    closeProducerAdmission: () => {},
    stopProducers: [],
    onSecondaryError: () => {},
  });

  issued = await createIssuedPeriodicTasksFixture({
    snapshot,
    monitorContext: runtimeMonitorContext,
    trader,
    termination: activeTermination,
    getCanTradeNow: () => lastState.canTrade === true,
    nowMs: 70000,
  });
  fixtureCleanups.push(issued.stopAndDrain);

  return {
    logger: createLoggerDouble(),
    termination: activeTermination,
    resources: {},
    cleanup: createCleanup(),
    clock: { now: clockNow ?? (() => new Date(Date.now())) },
    scheduler: {
      scheduleTimer: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimer: (handle) => {
        clearTimeout(handle);
      },
    },
    preGateRuntime: {
      brokerClientFactory: createBrokerClientFactoryDouble(),
      tradingConfig: createTradingConfig(),
      symbolRegistry: createSymbolRegistryDouble(),
      warrantListCache: warrantListCache,
      marketDataClient: createMarketDataClientDouble(),
      startupTradingDayInfo: null,
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
      monitorContext: runtimeMonitorContext,
      tradingGateEventRuntime: {
        emitGateStateChanged: () => {},
        onGateStateChanged: () => () => {},
        emitAutoSearchAuthorizationChanged: () => {},
        onAutoSearchAuthorizationChanged: () => () => {},
      },
      quoteSubscriptionRuntime: createQuoteSubscriptionRuntimeDouble(),
      seatActivation: createSeatActivationWorkflowDouble(),
      warrantRiskRefresh: createWarrantRiskRefreshDouble(),
      seatActivationDispatcher: {
        start: () => {},
        stop: () => {},
        dispatchCurrentActivatingSeats: () => {},
      },
      seatRuntimeCleanupDispatcher: createSeatRuntimeCleanupDispatcherDouble(),
      autoSearchWakeupRuntime: {
        start: () => {},
        stop: () => {},
        stopAndDrain: async () => {},
      },
      periodicSwitchWakeupRuntime,
      tradingRiskEventRuntime: {
        start: () => {},
        stop: () => {},
        stopAndDrain: async () => {},
      },
      monitorQuoteEventRuntime: {
        start: () => {},
        stop: () => {},
        stopAndDrain: async () => {},
      },
      monitorDisplayRuntime: {
        start: () => {},
        requestRender: () => {},
        stopAndDrain: async () => {},
      },
      tradingQuoteDisplayRuntime: {
        start: () => {},
        stop: () => {},
        stopAndDrain: async () => {},
      },
      switchWakeupRuntime: {
        start: () => {},
        stop: () => {},
        stopAndDrain: async () => {},
        handoffPendingSwitch: () => {},
      },
      postTradeConsistencyRuntime: issued.settlement,
      lastState,
      trader,
      loadTradingDayRuntimeSnapshot: async () => {
        const capture = snapshot.getView();
        if (!snapshot.isCurrent(capture.token, { account: true, positions: true, paired: true }))
          return { status: 'ABORTED' };

        return {
          status: 'COMMITTED',
          snapshotToken: capture.token,
          allOrders: [],
          quotesMap: new Map(),
        };
      },
      doomsdayClearanceWorkflow: createDoomsdayClearanceWorkflowDouble(),
      ordinaryBuy: createOrdinaryBuyWorkflowDouble(),
      ordinarySell: createOrdinarySellWorkflowDouble(),
      buyTaskQueue: createBuyTaskQueue(),
      sellTaskQueue: createSellTaskQueue(),
      monitorTaskQueue,
    },
  };
}

describe('app createAsyncRuntime wiring', () => {
  it('reports skipped outcome to periodic route when lifecycle gate skips AUTO_SYMBOL_TICK', async () => {
    const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const replanCalls: Parameters<PeriodicSwitchWakeupRuntime['replanRouteAfterTask']>[0][] = [];
    const runtime = createAsyncRuntime(
      await createDeps({
        lastState: createLastState({ isTradingEnabled: false }),
        monitorTaskQueue,
        periodicSwitchWakeupRuntime: createPeriodicSwitchWakeupRuntimeRecorder(replanCalls),
      }),
    );

    await runProcessorFlow({
      processor: runtime.monitorTaskProcessor,
      pushTask: () => {
        monitorTaskQueue.scheduleLatest({
          type: 'AUTO_SYMBOL_TICK',
          dedupeKey: 'AUTO_SYMBOL_TICK:LONG',
          data: issued.getTask('LONG'),
        });
      },
      waitCondition: () => monitorTaskQueue.isEmpty(),
    });

    expect(replanCalls).toEqual([
      {
        ...issued.getTask('LONG'),
        taskTimeMs: issued.getTask('LONG').currentTimeMs,
        status: 'skipped',
      },
    ]);
  });

  it('reports blocked outcome to periodic route when doomsday gate blocks AUTO_SYMBOL_TICK', async () => {
    const originalNow = Date.now;
    const injectedNow = new Date(Date.UTC(2026, 1, 16, 7, 56));
    Date.now = () => Date.UTC(2026, 1, 16, 2, 0);
    try {
      const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskDataMap>();
      const replanCalls: Parameters<PeriodicSwitchWakeupRuntime['replanRouteAfterTask']>[0][] = [];
      let periodicDueCalls = 0;
      const context = createMonitorContext({
        seatSwitch: {
          evaluatePeriodicSwitchDue: async () => {
            periodicDueCalls += 1;
            return { kind: 'NOOP' };
          },
          startSwitchOnDistance: async (params) => ({
            started: false,
            direction: params.direction,
            driveResult: {
              kind: 'NOOP',
            },
          }),
          advancePendingSwitch: async (params) => ({
            advanced: false,
            direction: params.direction,
            stillPending: false,
            driveResult: {
              kind: 'NOOP',
            },
          }),
          hasPendingSwitch: () => false,
          getPeriodicSwitchPendingState: () => ({
            pending: false,
          }),
          resetAllState: () => {},
        },
      });
      const runtime = createAsyncRuntime(
        await createDeps({
          lastState: createLastState({ canTrade: true, isHalfDay: false }),
          monitorContext: context,
          monitorTaskQueue,
          periodicSwitchWakeupRuntime: createPeriodicSwitchWakeupRuntimeRecorder(replanCalls),
          clockNow: () => injectedNow,
        }),
      );

      await runProcessorFlow({
        processor: runtime.monitorTaskProcessor,
        pushTask: () => {
          monitorTaskQueue.scheduleLatest({
            type: 'AUTO_SYMBOL_TICK',
            dedupeKey: 'AUTO_SYMBOL_TICK:LONG:DOOMSDAY',
            data: issued.getTask('LONG'),
          });
        },
        waitCondition: () => monitorTaskQueue.isEmpty(),
      });

      expect(periodicDueCalls).toBe(0);
      expect(replanCalls).toEqual([
        {
          ...issued.getTask('LONG'),
          taskTimeMs: issued.getTask('LONG').currentTimeMs,
          status: 'blocked',
        },
      ]);
    } finally {
      Date.now = originalNow;
    }
  });

  it('marks AUTO_SYMBOL_TICK API failures as failed without entering async fatal channel', async () => {
    const originalNow = Date.now;
    Date.now = () => Date.UTC(2026, 1, 16, 2, 0);
    const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const replanCalls: Parameters<PeriodicSwitchWakeupRuntime['replanRouteAfterTask']>[0][] = [];
    try {
      const context = createMonitorContext({
        seatSwitch: {
          evaluatePeriodicSwitchDue: async () => {
            throw await createExternalApiRequestError({
              operation: 'test.periodicDue',
              attempts: 1,
              cause: new Error('api unavailable'),
            });
          },
          startSwitchOnDistance: async (params) => ({
            started: false,
            direction: params.direction,
            driveResult: {
              kind: 'NOOP',
            },
          }),
          advancePendingSwitch: async (params) => ({
            advanced: false,
            direction: params.direction,
            stillPending: false,
            driveResult: {
              kind: 'NOOP',
            },
          }),
          hasPendingSwitch: () => false,
          getPeriodicSwitchPendingState: () => ({
            pending: false,
          }),
          resetAllState: () => {},
        },
      });
      const runtime = createAsyncRuntime(
        await createDeps({
          lastState: createLastState(),
          monitorContext: context,
          monitorTaskQueue,
          periodicSwitchWakeupRuntime: createPeriodicSwitchWakeupRuntimeRecorder(replanCalls),
        }),
      );

      await runProcessorFlow({
        processor: runtime.monitorTaskProcessor,
        pushTask: () => {
          monitorTaskQueue.scheduleLatest({
            type: 'AUTO_SYMBOL_TICK',
            dedupeKey: 'AUTO_SYMBOL_TICK:LONG:API_FAIL',
            data: issued.getTask('LONG'),
          });
        },
        waitCondition: () => monitorTaskQueue.isEmpty(),
      });

      expect(replanCalls).toEqual([
        {
          ...issued.getTask('LONG'),
          taskTimeMs: issued.getTask('LONG').currentTimeMs,
          status: 'failed',
          reevaluateAtMs: Date.now() + TRADING.INTERVAL_MS,
        },
      ]);
    } finally {
      Date.now = originalNow;
    }
  });

  it('sends non API AUTO_SYMBOL_TICK processing errors to async fatal channel', async () => {
    const originalNow = Date.now;
    Date.now = () => Date.UTC(2026, 1, 16, 2, 0);
    const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const replanCalls: Parameters<PeriodicSwitchWakeupRuntime['replanRouteAfterTask']>[0][] = [];
    try {
      const context = createMonitorContext({
        seatSwitch: {
          evaluatePeriodicSwitchDue: async () => {
            throw new TypeError('periodic due contract broken');
          },
          startSwitchOnDistance: async (params) => ({
            started: false,
            direction: params.direction,
            driveResult: {
              kind: 'NOOP',
            },
          }),
          advancePendingSwitch: async (params) => ({
            advanced: false,
            direction: params.direction,
            stillPending: false,
            driveResult: {
              kind: 'NOOP',
            },
          }),
          hasPendingSwitch: () => false,
          getPeriodicSwitchPendingState: () => ({
            pending: false,
          }),
          resetAllState: () => {},
        },
      });
      const runtime = createAsyncRuntime(
        await createDeps({
          lastState: createLastState(),
          monitorContext: context,
          monitorTaskQueue,
          periodicSwitchWakeupRuntime: createPeriodicSwitchWakeupRuntimeRecorder(replanCalls),
        }),
      );
      const fatalErrorPromise = waitForFatalError();

      await runProcessorFlow({
        processor: runtime.monitorTaskProcessor,
        pushTask: () => {
          monitorTaskQueue.scheduleLatest({
            type: 'AUTO_SYMBOL_TICK',
            dedupeKey: 'AUTO_SYMBOL_TICK:LONG:FAIL',
            data: issued.getTask('LONG'),
          });
        },
        waitCondition: () => monitorTaskQueue.isEmpty(),
      });

      const fatalError = await fatalErrorPromise;

      expect(fatalError).toBeInstanceOf(TypeError);
      if (!(fatalError instanceof TypeError)) throw new Error('Expected original internal fault');

      expect(fatalError.message).toBe('periodic due contract broken');
      expect(replanCalls).toEqual([]);
    } finally {
      Date.now = originalNow;
    }
  });
});
