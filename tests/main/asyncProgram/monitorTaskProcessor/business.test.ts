import { createBrokerIngressFixture } from '../../../integration/architectureRefactoringP1Native/trade/brokerIngressFixture.js';
import { afterEach, describe, expect, it } from 'bun:test';
import { createMonitorTaskProcessor as createMonitorTaskProcessorImpl } from '../../../../src/main/asyncProgram/monitorTaskProcessor/index.js';
import { createExternalApiRequestError } from '../../../helpers/createExternalApiRequestError.js';
import { createDailyLossTracker } from '../../../../src/core/riskController/dailyLossTracker.js';
import { classifyOrdersForRebuild } from '../../../../src/core/orderRecorder/utils.js';
import { createDailyLossOrderAnalysisDeps } from '../../../../src/core/orderRecorder/index.js';
import { createPositionLimitChecker } from '../../../../src/core/riskController/positionLimitChecker.js';
import { createRiskChecker } from '../../../../src/core/riskController/index.js';
import { createUnrealizedLossChecker } from '../../../../src/core/riskController/unrealizedLossChecker.js';
import { createWarrantRiskChecker } from '../../../../src/core/riskController/warrantRiskChecker.js';
import { toHongKongTimeIso } from '../../../../src/utils/time/index.js';
import type {
  MonitorTaskDataMap,
  MonitorTaskProcessorDeps,
  MonitorTaskStatus,
} from '../../../../src/main/asyncProgram/monitorTaskProcessor/types.js';
import { createMonitorTaskQueue } from '../../../../src/main/asyncProgram/monitorTaskQueue/index.js';
import { mergeBrokerOrderExecutionFact } from '../../../../src/domain/order/executionFact.js';
import { createSnapshotFixture } from '../../fixtures/accountPositionSnapshot.js';
import { createIssuedPeriodicTasksFixture } from '../../fixtures/issuedPeriodicTasks.js';
import { createTerminationRuntime } from '../../../../src/app/runtime/createTerminationRuntime.js';
import type { RuntimeTermination } from '../../../../src/types/runtime.js';
import type { PeriodicSwitchTaskData } from '../../../../src/types/periodicSwitch.js';
import { createAutoSymbolManager } from '../../../../src/services/autoSymbolManager/index.js';
import {
  getDefaultAutoSearchConfig,
  createWarrantCandidate,
} from '../../../services/autoSymbolManager/utils.js';
import type { AccountPositionSnapshot } from '../../../../src/types/accountPosition.js';
import type { RawOrderFromAPI } from '../../../../src/types/services.js';
import type { PreparedDailyLossRecalculation } from '../../../../src/types/risk.js';
import {
  createAccountSnapshotDouble,
  createMonitorConfigDouble,
  createDailyLossTrackerDouble,
  createMarketDataClientDouble,
  createOrderRecorderDouble,
  createPositionDouble,
  createQuoteSubscriptionRuntimeDouble,
  createRiskCheckerDouble,
  createTraderDouble,
} from '../../../helpers/testDoubles.js';
import { createMonitorContext, rethrowFatalError, runProcessorFlow, waitUntil } from '../utils.js';
import type { CreateBusinessProcessorParams } from '../types.js';

/**
 * monitorTaskProcessor 业务测试
 *
 * 功能：
 * - 验证监控任务处理器相关场景意图、边界条件与业务期望。
 */

/** Persisted BUY/SELL loss facts originate in two independent native producer observations. */
async function createDailyLossSeedOrders(
  now: Date,
  prefix: string,
): Promise<ReadonlyArray<RawOrderFromAPI>> {
  const buy = await createBrokerIngressFixture({
    stockName: 'HSI RC',
    remark: 'AUTO',
    orderId: prefix + '-buy',
    tradeId: prefix + '-buy-trade',
    symbol: 'BULL.HK',
    side: 'BUY',
    status: 'Filled',
    submittedPrice: '1.1',
    quantity: '100',
    executedPrice: '1',
    executedQuantity: '100',
    submittedAtMs: now.getTime() - 3000,
    executionTimeMs: now.getTime() - 2000,
    updatedAtMs: now.getTime() - 1500,
  });
  const sell = await createBrokerIngressFixture({
    stockName: 'HSI RC',
    remark: 'AUTO',
    orderId: prefix + '-sell',
    tradeId: prefix + '-sell-trade',
    symbol: 'BULL.HK',
    side: 'SELL',
    status: 'Filled',
    submittedPrice: '1.1',
    quantity: '100',
    executedPrice: '0.9',
    executedQuantity: '100',
    submittedAtMs: now.getTime() - 2000,
    executionTimeMs: now.getTime() - 1000,
    updatedAtMs: now.getTime() - 500,
  });
  return [buy.queryObservation, sell.queryObservation];
}

type OwnedProcessorDeps = Omit<MonitorTaskProcessorDeps, 'snapshot'> & {
  readonly snapshot: AccountPositionSnapshot;
};
const processorOwners = new WeakMap<
  ReturnType<typeof createMonitorTaskProcessorImpl>,
  OwnedProcessorDeps & { readonly termination: RuntimeTermination }
>();
const issuedTaskFixtures: Awaited<ReturnType<typeof createIssuedPeriodicTasksFixture>>[] = [];
afterEach(async () => {
  for (const fixture of issuedTaskFixtures.splice(0)) await fixture.stopAndDrain();
});

function createMonitorTaskProcessor(deps: OwnedProcessorDeps) {
  const ownerTermination = createTerminationRuntime({
    closeTradingGate: () => {},
    closeProducerAdmission: () => {},
    stopProducers: [],
    onSecondaryError: () => {},
  });
  const termination: RuntimeTermination = {
    ...ownerTermination,
    isTerminated: () => ownerTermination.isTerminated() || deps.termination.isTerminated(),
    reportFatalError: (error) => {
      ownerTermination.reportFatalError(error);
      deps.termination.reportFatalError(error);
    },
  };
  const ownedDeps = { ...deps, termination };
  const processor = createMonitorTaskProcessorImpl(ownedDeps);
  processorOwners.set(processor, ownedDeps);
  return processor;
}

function createPeriodicMonitorContext(overrides: Parameters<typeof createMonitorContext>[0]) {
  const config = createMonitorConfigDouble();
  return createMonitorContext({
    ...overrides,
    config: createMonitorConfigDouble({
      ...config,
      autoSearchConfig: {
        ...getDefaultAutoSearchConfig(),
        autoSearchEnabled: true,
        switchIntervalMinutes: 1,
      },
    }),
  });
}

async function issueTasksForProcessor(
  processor: ReturnType<typeof createMonitorTaskProcessorImpl>,
  nowMs: number,
) {
  const owner = processorOwners.get(processor);
  if (owner === undefined) throw new Error('Missing original processor dependencies');

  const fixture = await createIssuedPeriodicTasksFixture({
    snapshot: owner.snapshot,
    monitorContext: owner.monitorContext,
    trader: owner.trader,
    termination: owner.termination,
    getCanTradeNow: owner.getCanTradeNow,
    nowMs,
  });
  issuedTaskFixtures.push(fixture);
  return fixture;
}

function createRealPeriodicPublicationContext(params: {
  readonly now: () => Date;
  readonly afterPublication: () => Promise<void>;
}) {
  let brokerCalls = 0;
  const publications: Awaited<
    ReturnType<ReturnType<typeof createAutoSymbolManager>['evaluatePeriodicSwitchDue']>
  >[] = [];
  const base = createPeriodicMonitorContext({});
  base.symbolRegistry.updateSeatState('LONG', {
    ...base.symbolRegistry.getSeatState('LONG'),
    status: 'ACTIVE',
    symbol: 'BULL.HK',
    lastSeatActivatedAt: params.now().getTime() - 120_000,
    callPrice: null,
  });
  const trader = createTraderDouble({
    executeSignals: async () => {
      brokerCalls += 1;
      throw new Error('Initial WAIT publication must not submit a broker order');
    },
  });
  const marketDataClient = createMarketDataClientDouble({
    getQuotes: async (symbols) =>
      new Map([...symbols].map((symbol) => [symbol, createQuoteDouble(symbol, '1')])),
  });
  const manager = createAutoSymbolManager({
    monitorConfig: base.config,
    symbolRegistry: base.symbolRegistry,
    trader,
    marketDataClient,
    orderRecorder: base.orderRecorder,
    riskChecker: base.riskChecker,
    clock: { now: params.now },
    getTradingCalendarSnapshot: () =>
      new Map([['2026-02-16', { isTradingDay: true, isHalfDay: false }]]),
    findBestWarrant: async () => createWarrantCandidate('NEXT_BULL.HK'),
  });
  return {
    trader,
    marketDataClient,
    getBrokerCalls: () => brokerCalls,
    getPublications: () => publications,
    context: {
      ...base,
      autoSymbolManager: {
        ...manager,
        evaluatePeriodicSwitchDue: async (
          ...args: Parameters<typeof manager.evaluatePeriodicSwitchDue>
        ) => {
          const result = await manager.evaluatePeriodicSwitchDue(...args);
          expect(result.kind).toBe('WAIT');
          if (result.kind !== 'WAIT' || result.publishedRoute === undefined)
            throw new Error('Expected real initial publication');

          expect(result.publishedRoute.isCurrent()).toBe(true);
          publications.push(result);
          await params.afterPublication();
          return result;
        },
      },
    },
  };
}

function issuedAuthorizationFields(task: PeriodicSwitchTaskData) {
  return {
    dayEpoch: task.dayEpoch,
    currentTimeMs: task.currentTimeMs,
    readinessReceipt: task.readinessReceipt,
    canContinue: task.canContinue,
    isRouteCurrent: task.isRouteCurrent,
  };
}

const MONITOR_TASK_NOW_MS = Date.parse('2026-03-13T02:00:00.000Z');
const MONITOR_TASK_RUNTIME = {
  clock: {
    now: () => new Date(MONITOR_TASK_NOW_MS),
  },
  scheduler: {
    scheduleTimer: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
    clearTimer: (handle: ReturnType<typeof setTimeout>) => {
      clearTimeout(handle);
    },
  },
};

async function createBusinessProcessor(
  params: Omit<CreateBusinessProcessorParams, 'lastState'>,
): Promise<
  ReturnType<typeof createMonitorTaskProcessor> & Readonly<{ snapshot: AccountPositionSnapshot }>
> {
  const {
    queue,
    context,
    clock = MONITOR_TASK_RUNTIME.clock,
    scheduler = MONITOR_TASK_RUNTIME.scheduler,
    trader,
    marketDataClient = createMarketDataClientDouble(),
    quoteSubscriptionRuntime = createQuoteSubscriptionRuntimeDouble(),
    getCanProcessTask,
    getCanTradeNow = () => true,
    periodicSwitchWakeupRuntime = {
      markWaitingEmpty: () => {},
      clearWaitingEmpty: () => {},
      replanRouteAfterTask: () => {},
    },
    termination,
  } = params;
  const resolvedTrader = {
    ...(trader ?? createTraderDouble()),
    orderRecorder: context.orderRecorder,
  };

  let taskReadsEnabled = false;
  const snapshot = await createSnapshotFixture({
    account: createAccountSnapshotDouble('100000'),
    positions: [],
    readPort: {
      getAccountSnapshot: async () =>
        taskReadsEnabled
          ? resolvedTrader.getAccountSnapshot()
          : createAccountSnapshotDouble('100000'),
      getStockPositions: async () => (taskReadsEnabled ? resolvedTrader.getStockPositions() : []),
    },
  });
  taskReadsEnabled = true;
  const commitBatch = context.orderRecorder.commitRebuildSnapshot;
  const validateBatch = context.orderRecorder.validateRebuildSnapshot;
  context.orderRecorder.validateRebuildSnapshot = (symbol, orders) => {
    validateBatch(symbol, orders);
    classifyOrdersForRebuild(orders.filter((order) => order.symbol === symbol));
    for (const order of orders.filter((candidate) => candidate.symbol === symbol)) {
      mergeBrokerOrderExecutionFact(undefined, {
        brokerOrderId: order.orderId,
        symbol,
        side: order.executionSide,
        phase: order.executionPhase,
        cumulativeQuantity: order.executedQuantity,
        cumulativeAmount: order.executedAmount,
        executionTimeMs: order.executionTimeMs,
        updatedAtMs: order.updatedAtMs,
      });
    }
  };

  context.orderRecorder.commitRebuildSnapshot = (targets, orders, isCurrent, mode) => {
    expect(mode).toBe('ACTIVATION');
    if (!isCurrent()) return { status: 'ABORTED' };

    return commitBatch(targets, orders, isCurrent, mode);
  };
  const processor = createMonitorTaskProcessor({
    clock,
    scheduler,
    monitorTaskQueue: queue,
    monitorContext: context,
    trader: resolvedTrader,
    marketDataClient,
    quoteSubscriptionRuntime,
    switchWakeupRuntime: {
      handoffPendingSwitch: () => {},
    },
    snapshot,
    getCanTradeNow,
    periodicSwitchWakeupRuntime,
    ...(getCanProcessTask ? { getCanProcessTask } : {}),
    termination: termination ?? { isTerminated: () => false, reportFatalError: rethrowFatalError },
  });
  const ownedProcessor = { ...processor, snapshot };
  const owner = processorOwners.get(processor);
  if (owner === undefined) throw new Error('Missing constructed processor owner');

  processorOwners.set(ownedProcessor, owner);
  return ownedProcessor;
}

function createQuoteDouble(symbol: string, price: string, lotSize = 100) {
  return { symbol, name: symbol, price, prevClose: price, timestamp: MONITOR_TASK_NOW_MS, lotSize };
}

function scheduleSeatRefreshTask(
  queue: MonitorTaskProcessorDeps['monitorTaskQueue'],
  dedupeKey: string,
  overrides: Partial<MonitorTaskDataMap['SEAT_REFRESH']> = {},
): void {
  queue.scheduleLatest({
    type: 'SEAT_REFRESH',
    dedupeKey,
    data: {
      dayEpoch: 0,
      direction: 'LONG',
      seatVersion: 2,
      previousSymbol: 'OLD_BULL.HK',
      nextSymbol: 'BULL.HK',
      callPrice: '20000',
      symbolName: 'BULL.HK',
      ...overrides,
    },
  });
}

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });

  return {
    promise,
    resolve,
    reject,
  };
}

describe('monitorTaskProcessor business flow', () => {
  it('hands AUTO_SYMBOL_TICK WAIT result to switchWakeupRuntime', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const handoffCalls: Array<{
      direction: 'LONG' | 'SHORT';
      seatVersion: number;
      driveKind: string;
    }> = [];
    let brokerCalls = 0;
    const baseContext = createPeriodicMonitorContext({});
    baseContext.symbolRegistry.updateSeatState('LONG', {
      ...baseContext.symbolRegistry.getSeatState('LONG'),
      status: 'ACTIVE',
      symbol: 'BULL.HK',
      lastSeatActivatedAt: MONITOR_TASK_NOW_MS - 120_000,
      callPrice: null,
    });
    const ownerTrader = createTraderDouble({
      executeSignals: async () => {
        brokerCalls += 1;
        return { executedOrderIds: ['SHOULD-NOT-SUBMIT'] };
      },
    });
    const marketDataClient = createMarketDataClientDouble({
      getQuotes: async (symbols) =>
        new Map([...symbols].map((symbol) => [symbol, createQuoteDouble(symbol, '1')])),
    });
    const context = {
      ...baseContext,
      autoSymbolManager: createAutoSymbolManager({
        monitorConfig: baseContext.config,
        symbolRegistry: baseContext.symbolRegistry,
        marketDataClient,
        trader: ownerTrader,
        riskChecker: baseContext.riskChecker,
        orderRecorder: baseContext.orderRecorder,
        clock: MONITOR_TASK_RUNTIME.clock,
        getTradingCalendarSnapshot: () =>
          new Map([['2026-03-13', { isTradingDay: true, isHalfDay: false }]]),
        findBestWarrant: async () => createWarrantCandidate('NEXT_BULL.HK'),
      }),
    };

    const processor = createMonitorTaskProcessor({
      ...MONITOR_TASK_RUNTIME,
      monitorTaskQueue: queue,
      monitorContext: context,
      trader: ownerTrader,
      marketDataClient: marketDataClient,
      quoteSubscriptionRuntime: createQuoteSubscriptionRuntimeDouble(),
      switchWakeupRuntime: {
        handoffPendingSwitch: (params) => {
          handoffCalls.push({
            direction: params.direction,
            seatVersion: params.monitorContext.symbolRegistry.getSeatVersion(params.direction),
            driveKind: params.driveResult.kind,
          });
        },
      },
      periodicSwitchWakeupRuntime: {
        markWaitingEmpty: () => {},
        clearWaitingEmpty: () => {},
        replanRouteAfterTask: () => {},
      },
      snapshot: await createSnapshotFixture({
        account: createAccountSnapshotDouble('100000'),
        positions: [],
      }),
      getCanTradeNow: () => true,
      termination: { isTerminated: () => false, reportFatalError: rethrowFatalError },
    });

    const issuedTasks = await issueTasksForProcessor(processor, MONITOR_TASK_NOW_MS);

    await runProcessorFlow({
      processor,
      pushTask: () => {
        queue.scheduleLatest({
          type: 'AUTO_SYMBOL_TICK',
          dedupeKey: 'AUTO_SYMBOL_TICK:LONG:WAKEUP',
          data: issuedTasks.getTask('LONG'),
        });
      },
      waitCondition: () => queue.isEmpty(),
      timeoutMs: 500,
    });

    expect(handoffCalls).toEqual([
      {
        direction: 'LONG',
        seatVersion: 3,
        driveKind: 'WAIT',
      },
    ]);

    expect(brokerCalls).toBe(0);
    expect(context.symbolRegistry.getSeatState('LONG').status).toBe('SWITCHING');
    expect(issuedTasks.getTask('LONG').canContinue()).toBe(false);
  });

  it('API 错误标记为普通任务失败且不进入 fatal 通道', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const fatalErrors: unknown[] = [];
    const context = createPeriodicMonitorContext({
      autoSymbolManager: {
        maybeSearchOnEvent: async () => {},
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
    const processor = createMonitorTaskProcessor({
      ...MONITOR_TASK_RUNTIME,
      monitorTaskQueue: queue,
      monitorContext: context,
      trader: createTraderDouble(),
      marketDataClient: createMarketDataClientDouble(),
      quoteSubscriptionRuntime: createQuoteSubscriptionRuntimeDouble(),
      switchWakeupRuntime: {
        handoffPendingSwitch: () => {},
      },
      periodicSwitchWakeupRuntime: {
        markWaitingEmpty: () => {},
        clearWaitingEmpty: () => {},
        replanRouteAfterTask: () => {},
      },
      snapshot: await createSnapshotFixture({
        account: createAccountSnapshotDouble('100000'),
        positions: [],
      }),
      getCanTradeNow: () => true,
      termination: {
        isTerminated: () => false,
        reportFatalError: (error) => {
          fatalErrors.push(error);
        },
      },
    });

    const issuedTasks = await issueTasksForProcessor(processor, Date.now());

    await runProcessorFlow({
      processor,
      pushTask: () => {
        queue.scheduleLatest({
          type: 'AUTO_SYMBOL_TICK',
          dedupeKey: 'AUTO_SYMBOL_TICK:LONG:API_FAIL',
          data: issuedTasks.getTask('LONG'),
        });
      },
      waitCondition: () => queue.isEmpty(),
      timeoutMs: 500,
    });

    expect(fatalErrors).toEqual([]);
  });

  it('非 API 程序错误进入 fatal 通道后停止调度并保留后续任务', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const fatalErrors: unknown[] = [];
    let periodicEvaluationCalls = 0;
    const context = createPeriodicMonitorContext({
      autoSymbolManager: {
        maybeSearchOnEvent: async () => {},
        evaluatePeriodicSwitchDue: async () => {
          periodicEvaluationCalls += 1;
          throw new TypeError('periodic contract broken');
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
    const processor = createMonitorTaskProcessor({
      ...MONITOR_TASK_RUNTIME,
      monitorTaskQueue: queue,
      monitorContext: context,
      trader: createTraderDouble(),
      marketDataClient: createMarketDataClientDouble(),
      quoteSubscriptionRuntime: createQuoteSubscriptionRuntimeDouble(),
      switchWakeupRuntime: {
        handoffPendingSwitch: () => {},
      },
      periodicSwitchWakeupRuntime: {
        markWaitingEmpty: () => {},
        clearWaitingEmpty: () => {},
        replanRouteAfterTask: () => {},
      },
      snapshot: await createSnapshotFixture({
        account: createAccountSnapshotDouble('100000'),
        positions: [],
      }),
      getCanTradeNow: () => true,
      termination: {
        isTerminated: () => false,
        reportFatalError: (error) => {
          fatalErrors.push(error);
        },
      },
    });

    const issuedTasks = await issueTasksForProcessor(processor, Date.now());

    processor.start();
    try {
      queue.scheduleLatest({
        type: 'AUTO_SYMBOL_TICK',
        dedupeKey: 'AUTO_SYMBOL_TICK:LONG:FATAL',
        data: issuedTasks.getTask('LONG'),
      });

      queue.scheduleLatest({
        type: 'AUTO_SYMBOL_TICK',
        dedupeKey: 'AUTO_SYMBOL_TICK:SHORT:AFTER_FATAL',
        data: issuedTasks.getTask('SHORT'),
      });

      await waitUntil(() => fatalErrors.length === 1, 500);
      await Bun.sleep(20);

      expect(fatalErrors).toHaveLength(1);
      expect(fatalErrors[0]).toBeInstanceOf(TypeError);
      expect(periodicEvaluationCalls).toBe(1);
      expect(queue.pop()?.dedupeKey).toBe('AUTO_SYMBOL_TICK:SHORT:AFTER_FATAL');
    } finally {
      await processor.stopAndDrain();
    }
  });

  it('processes AUTO_SYMBOL_TICK with valid seat snapshot', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    let maybeSearchCalls = 0;
    const intervalCallArgs: Array<{
      direction: 'LONG' | 'SHORT';
      currentTime: Date;
      canContinue: () => boolean;
    }> = [];

    const context = createPeriodicMonitorContext({
      autoSymbolManager: {
        maybeSearchOnEvent: async () => {
          maybeSearchCalls += 1;
        },
        evaluatePeriodicSwitchDue: async (params) => {
          expect(params.canContinue()).toBeTrue();
          intervalCallArgs.push(params);
          return {
            kind: 'NOOP',
          };
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

    const processor = await createBusinessProcessor({
      queue,
      context,
    });

    const issuedTasks = await issueTasksForProcessor(processor, Date.now());

    await runProcessorFlow({
      processor,
      pushTask: () => {
        queue.scheduleLatest({
          type: 'AUTO_SYMBOL_TICK',
          dedupeKey: 'AUTO_SYMBOL_TICK:LONG',
          data: issuedTasks.getTask('LONG'),
        });
      },
      waitCondition: () => queue.isEmpty(),
      timeoutMs: 500,
    });

    expect(maybeSearchCalls).toBe(0);
    expect(intervalCallArgs).toHaveLength(1);
    expect(intervalCallArgs[0]?.direction).toBe('LONG');
    expect(intervalCallArgs[0]?.canContinue()).toBeFalse();
    expect(issuedTasks.getTask('LONG').canContinue()).toBeTrue();
    expect(intervalCallArgs[0]?.currentTime.getTime()).toBeGreaterThan(0);
  });

  it('blocks AUTO_SYMBOL_TICK switch flow outside ordinary trade gate', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const intervalCallArgs: Array<{
      direction: 'LONG' | 'SHORT';
      currentTime: Date;
      canContinue: () => boolean;
    }> = [];

    const context = createPeriodicMonitorContext({
      autoSymbolManager: {
        maybeSearchOnEvent: async () => {},
        evaluatePeriodicSwitchDue: async (params) => {
          expect(params.canContinue()).toBeTrue();
          intervalCallArgs.push(params);
          return {
            kind: 'NOOP',
          };
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

    let canTradeNow = true;
    const processor = await createBusinessProcessor({
      queue,
      context,
      getCanTradeNow: () => canTradeNow,
    });

    const issuedTasks = await issueTasksForProcessor(processor, Date.now());
    canTradeNow = false;
    expect(issuedTasks.getTask('LONG').canContinue()).toBe(false);

    await runProcessorFlow({
      processor,
      pushTask: () => {
        queue.scheduleLatest({
          type: 'AUTO_SYMBOL_TICK',
          dedupeKey: 'AUTO_SYMBOL_TICK:LONG:CURRENT_GATE',
          data: issuedTasks.getTask('LONG'),
        });
      },
      waitCondition: () => queue.isEmpty(),
      timeoutMs: 500,
    });

    expect(intervalCallArgs).toHaveLength(0);
  });

  it('hands a real published periodic WAIT across takeover without reauthorizing old mutation', async () => {
    const beforeTakeoverMs = Date.parse('2026-02-16T07:54:59.000Z');
    const takeoverMs = Date.parse('2026-02-16T07:55:00.000Z');
    let currentNowMs = beforeTakeoverMs;
    const periodicEvaluationStarted = createDeferred<null>();
    const releasePeriodicEvaluation = createDeferred<null>();
    const handoffCalls: string[] = [];
    const periodicWakeupCalls: Array<{ kind: string; status?: MonitorTaskStatus }> = [];
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const publication = createRealPeriodicPublicationContext({
      now: () => new Date(currentNowMs),
      afterPublication: async () => {
        periodicEvaluationStarted.resolve(null);
        await releasePeriodicEvaluation.promise;
      },
    });
    const context = publication.context;
    const snapshot = await createSnapshotFixture({
      account: createAccountSnapshotDouble('100000'),
      positions: [],
    });
    const originalDayEpoch = snapshot.getView().token.dayEpoch;
    const processor = createMonitorTaskProcessor({
      ...MONITOR_TASK_RUNTIME,
      monitorTaskQueue: queue,
      monitorContext: context,
      trader: publication.trader,
      marketDataClient: publication.marketDataClient,
      quoteSubscriptionRuntime: createQuoteSubscriptionRuntimeDouble(),
      switchWakeupRuntime: {
        handoffPendingSwitch: (params) => {
          expect(params.originalDayEpoch).toBe(originalDayEpoch);
          const returnedResult = publication.getPublications()[0];
          if (returnedResult?.kind !== 'WAIT')
            throw new Error('Expected source-produced WAIT object');

          expect(params.driveResult).toBe(returnedResult);
          expect(params.driveResult.publishedRoute?.isCurrent()).toBe(true);
          expect(params.driveResult.wakeups).toEqual([
            { kind: 'RETRY_TIMER', atMs: beforeTakeoverMs },
          ]);
          handoffCalls.push('handoff');
        },
      },
      periodicSwitchWakeupRuntime: {
        markWaitingEmpty: () => {
          periodicWakeupCalls.push({ kind: 'mark' });
        },
        clearWaitingEmpty: () => {
          periodicWakeupCalls.push({ kind: 'clear' });
        },
        replanRouteAfterTask: (params) => {
          periodicWakeupCalls.push({ kind: 'replan', status: params.status });
        },
      },
      snapshot: snapshot,
      getCanTradeNow: () => currentNowMs < takeoverMs,
      termination: { isTerminated: () => false, reportFatalError: rethrowFatalError },
    });

    const issuedTasks = await issueTasksForProcessor(processor, beforeTakeoverMs);

    processor.start();
    queue.scheduleLatest({
      type: 'AUTO_SYMBOL_TICK',
      dedupeKey: 'AUTO_SYMBOL_TICK:LONG:TAKEOVER',
      data: issuedTasks.getTask('LONG'),
    });

    await periodicEvaluationStarted.promise;
    currentNowMs = takeoverMs;
    releasePeriodicEvaluation.resolve(null);
    await waitUntil(() => handoffCalls.length === 1, 500);
    await processor.stopAndDrain();

    expect(handoffCalls).toEqual(['handoff']);
    expect(periodicWakeupCalls).toEqual([]);
    expect(publication.getBrokerCalls()).toBe(0);
    expect(issuedTasks.getTask('LONG').canContinue()).toBe(false);
    expect(context.symbolRegistry.getSeatState('LONG').status).toBe('SWITCHING');
  });

  it('marks periodic route waiting-empty when AUTO_SYMBOL_TICK leaves periodic pending state', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const markCalls: Array<{
      direction: 'LONG' | 'SHORT';
      symbol: string;
      seatVersion: number;
      lastSeatActivatedAt: number;
    }> = [];
    const context = createPeriodicMonitorContext({
      autoSymbolManager: {
        maybeSearchOnEvent: async () => {},
        evaluatePeriodicSwitchDue: async () => ({
          kind: 'NOOP',
        }),
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
          pending: true,
        }),
        resetAllState: () => {},
      },
    });

    const processor = await createBusinessProcessor({
      queue,
      context,
      periodicSwitchWakeupRuntime: {
        markWaitingEmpty: (baseline) => {
          markCalls.push(baseline);
        },
        clearWaitingEmpty: () => {},
        replanRouteAfterTask: () => {},
      },
    });

    const issuedTasks = await issueTasksForProcessor(processor, 70_000);

    await runProcessorFlow({
      processor,
      pushTask: () => {
        queue.scheduleLatest({
          type: 'AUTO_SYMBOL_TICK',
          dedupeKey: 'AUTO_SYMBOL_TICK:LONG:PERIODIC_PENDING',
          data: issuedTasks.getTask('LONG'),
        });
      },
      waitCondition: () => queue.isEmpty(),
      timeoutMs: 500,
    });

    expect(markCalls).toEqual([
      {
        ...issuedAuthorizationFields(issuedTasks.getTask('LONG')),
        direction: 'LONG',
        symbol: 'BULL.HK',
        seatVersion: 2,
        lastSeatActivatedAt: 12_000,
      },
    ]);
  });

  it('clears periodic waiting-empty and replans route after processed AUTO_SYMBOL_TICK without pending state', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const clearCalls: Array<{
      direction: 'LONG' | 'SHORT';
      symbol: string;
      seatVersion: number;
      lastSeatActivatedAt: number;
    }> = [];
    const replanCalls: Array<{
      direction: 'LONG' | 'SHORT';
      symbol: string;
      seatVersion: number;
      lastSeatActivatedAt: number;
      taskTimeMs: number;
      status: MonitorTaskStatus;
    }> = [];
    const context = createPeriodicMonitorContext({
      autoSymbolManager: {
        maybeSearchOnEvent: async () => {},
        evaluatePeriodicSwitchDue: async () => ({
          kind: 'NOOP',
        }),
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

    const processor = await createBusinessProcessor({
      queue,
      context,
      periodicSwitchWakeupRuntime: {
        markWaitingEmpty: () => {},
        clearWaitingEmpty: (baseline) => {
          clearCalls.push(baseline);
        },
        replanRouteAfterTask: (params) => {
          replanCalls.push(params);
        },
      },
    });

    const issuedTasks = await issueTasksForProcessor(processor, 70_000);

    await runProcessorFlow({
      processor,
      pushTask: () => {
        queue.scheduleLatest({
          type: 'AUTO_SYMBOL_TICK',
          dedupeKey: 'AUTO_SYMBOL_TICK:LONG:PERIODIC_REPLAN',
          data: issuedTasks.getTask('LONG'),
        });
      },
      waitCondition: () => queue.isEmpty(),
      timeoutMs: 500,
    });

    expect(clearCalls).toEqual([
      {
        ...issuedAuthorizationFields(issuedTasks.getTask('LONG')),
        direction: 'LONG',
        symbol: 'BULL.HK',
        seatVersion: 2,
        lastSeatActivatedAt: 12_000,
      },
    ]);

    expect(replanCalls).toEqual([
      {
        ...issuedAuthorizationFields(issuedTasks.getTask('LONG')),
        direction: 'LONG',
        symbol: 'BULL.HK',
        seatVersion: 2,
        lastSeatActivatedAt: 12_000,
        taskTimeMs: 70_000,
        status: 'processed',
      },
    ]);
  });

  it('reports blocked outcome to periodic route outside ordinary trade gate so gate reopen can recover', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const replanCalls: Array<{
      direction: 'LONG' | 'SHORT';
      symbol: string;
      seatVersion: number;
      lastSeatActivatedAt: number;
      taskTimeMs: number;
      status: MonitorTaskStatus;
    }> = [];
    const clearCalls: string[] = [];
    let periodicDueCalls = 0;
    const context = createPeriodicMonitorContext({
      autoSymbolManager: {
        maybeSearchOnEvent: async () => {},
        evaluatePeriodicSwitchDue: async () => {
          periodicDueCalls += 1;
          return {
            kind: 'NOOP',
          };
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

    let canTradeNow = true;
    const processor = await createBusinessProcessor({
      queue,
      context,
      getCanTradeNow: () => canTradeNow,
      periodicSwitchWakeupRuntime: {
        markWaitingEmpty: () => {},
        clearWaitingEmpty: () => {
          clearCalls.push('clear');
        },
        replanRouteAfterTask: (params) => {
          replanCalls.push(params);
        },
      },
    });

    const issuedTasks = await issueTasksForProcessor(processor, 70_000);
    canTradeNow = false;
    expect(issuedTasks.getTask('LONG').canContinue()).toBe(false);

    await runProcessorFlow({
      processor,
      pushTask: () => {
        queue.scheduleLatest({
          type: 'AUTO_SYMBOL_TICK',
          dedupeKey: 'AUTO_SYMBOL_TICK:LONG:PERIODIC_GATE_CLOSED',
          data: issuedTasks.getTask('LONG'),
        });
      },
      waitCondition: () => queue.isEmpty(),
      timeoutMs: 500,
    });

    expect(periodicDueCalls).toBe(0);
    expect(clearCalls).toEqual([]);
    expect(replanCalls).toEqual([
      {
        ...issuedAuthorizationFields(issuedTasks.getTask('LONG')),
        direction: 'LONG',
        symbol: 'BULL.HK',
        seatVersion: 2,
        lastSeatActivatedAt: 12_000,
        taskTimeMs: 70_000,
        status: 'blocked',
      },
    ]);
  });

  it('skips AUTO_SYMBOL_TICK when seat snapshot is stale', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    let maybeSearchCalls = 0;

    const context = createPeriodicMonitorContext({
      autoSymbolManager: {
        maybeSearchOnEvent: async () => {
          maybeSearchCalls += 1;
        },
        evaluatePeriodicSwitchDue: async () => ({
          kind: 'NOOP',
        }),
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

    const processor = await createBusinessProcessor({
      queue,
      context,
    });

    const issuedTasks = await issueTasksForProcessor(processor, Date.now());
    const issuedSeat = context.symbolRegistry.getSeatState('LONG');
    if (issuedSeat.status !== 'ACTIVE' || issuedSeat.lastSeatActivatedAt === null)
      throw new Error('Expected original ACTIVE seat');

    context.symbolRegistry.updateSeatStateWithVersionBump('LONG', {
      ...issuedSeat,
      callPrice: null,
    });
    expect(issuedTasks.getTask('LONG').canContinue()).toBe(false);

    await runProcessorFlow({
      processor,
      pushTask: () => {
        queue.scheduleLatest({
          type: 'AUTO_SYMBOL_TICK',
          dedupeKey: 'AUTO_SYMBOL_TICK:LONG',
          data: issuedTasks.getTask('LONG'),
        });
      },
      waitCondition: () => queue.isEmpty(),
      timeoutMs: 500,
    });

    expect(maybeSearchCalls).toBe(0);
  });

  it('skips AUTO_SYMBOL_TICK when seat activation baseline is stale', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    let periodicDueCalls = 0;

    const context = createPeriodicMonitorContext({
      autoSymbolManager: {
        maybeSearchOnEvent: async () => {},
        evaluatePeriodicSwitchDue: async () => {
          periodicDueCalls += 1;
          return {
            kind: 'NOOP',
          };
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

    const processor = await createBusinessProcessor({
      queue,
      context,
    });

    const issuedTasks = await issueTasksForProcessor(processor, Date.now());
    context.symbolRegistry.updateSeatState('LONG', {
      ...context.symbolRegistry.getSeatState('LONG'),
      lastSeatActivatedAt: 13_000,
    });
    expect(issuedTasks.getTask('LONG').canContinue()).toBe(false);

    await runProcessorFlow({
      processor,
      pushTask: () => {
        queue.scheduleLatest({
          type: 'AUTO_SYMBOL_TICK',
          dedupeKey: 'AUTO_SYMBOL_TICK:LONG:STALE_ACTIVATION',
          data: issuedTasks.getTask('LONG'),
        });
      },
      waitCondition: () => queue.isEmpty(),
      timeoutMs: 500,
    });

    expect(periodicDueCalls).toBe(0);
  });

  it('skips stale SEAT_REFRESH when seatVersion no longer matches', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    let getQuotesCalls = 0;
    let clearLongWarrantCalls = 0;

    const context = createMonitorContext({
      riskChecker: createRiskCheckerDouble({
        clearLongWarrantInfo: () => {
          clearLongWarrantCalls += 1;
        },
      }),
    });
    context.symbolRegistry.updateSeatState('LONG', {
      ...context.symbolRegistry.getSeatState('LONG'),
      symbol: 'BULL.HK',
      status: 'ACTIVATING',
      callPrice: '20000',
    });

    const processor = await createBusinessProcessor({
      queue,
      context,
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () => {
          getQuotesCalls += 1;
          return new Map();
        },
      }),
    });

    await runProcessorFlow({
      processor,
      pushTask: () => {
        scheduleSeatRefreshTask(queue, 'SEAT_REFRESH:LONG:STALE_VERSION', {
          seatVersion: 1,
        });
      },
      waitCondition: () => queue.isEmpty(),
      timeoutMs: 500,
    });

    expect(getQuotesCalls).toBe(0);
    expect(clearLongWarrantCalls).toBe(0);
    expect(context.symbolRegistry.getSeatState('LONG')).toMatchObject({
      symbol: 'BULL.HK',
      status: 'ACTIVATING',
    });
  });

  it('skips AUTO_SYMBOL_TICK when lifecycle gate denies processing', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    let maybeSearchCalls = 0;

    const context = createPeriodicMonitorContext({
      autoSymbolManager: {
        maybeSearchOnEvent: async () => {
          maybeSearchCalls += 1;
        },
        evaluatePeriodicSwitchDue: async () => ({
          kind: 'NOOP',
        }),
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

    const processor = await createBusinessProcessor({
      queue,
      context,
      getCanProcessTask: () => false,
    });

    const issuedTasks = await issueTasksForProcessor(processor, Date.now());

    await runProcessorFlow({
      processor,
      pushTask: () => {
        queue.scheduleLatest({
          type: 'AUTO_SYMBOL_TICK',
          dedupeKey: 'AUTO_SYMBOL_TICK:LONG:GATE',
          data: issuedTasks.getTask('LONG'),
        });
      },
      waitCondition: () => queue.isEmpty(),
      timeoutMs: 500,
    });

    expect(maybeSearchCalls).toBe(0);
  });

  it('processes SEAT_REFRESH and rebuilds long-side runtime caches', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const allOrders: ReadonlyArray<RawOrderFromAPI> = [];
    const expectedRelatedTradingSymbols: ReadonlyArray<string> = [
      'BULL.HK',
      'OLD_BULL.HK',
      'BEAR.HK',
    ];
    const rebuildSnapshots: Array<ReadonlyArray<RawOrderFromAPI>> = [];
    const rebuildSteps: string[] = [];
    const preflightSymbols: string[] = [];
    let dailyLossRelatedTradingSymbols: ReadonlySet<string> | undefined;
    let fetchAllOrdersCalls = 0;
    let preflightCalls = 0;
    let refreshOrdersCalls = 0;
    let dailyLossPrepareCalls = 0;
    let dailyLossPublishCalls = 0;
    let preparedDailyLoss: PreparedDailyLossRecalculation | null = null;
    const dailyLossOwner = createDailyLossTrackerDouble();
    let refreshUnrealizedCalls = 0;
    let accountSnapshotCalls = 0;
    let stockPositionCalls = 0;
    let getQuotesCalls = 0;

    const orderRecorder = Object.assign(
      createOrderRecorderDouble({
        fetchAllOrdersFromAPI: async () => {
          fetchAllOrdersCalls += 1;
          return allOrders;
        },
        commitRebuildSnapshot: (targets, snapshot, isCurrent, mode) => {
          expect(mode).toBe('ACTIVATION');
          if (!isCurrent()) return { status: 'ABORTED' };

          expect(dailyLossPrepareCalls).toBe(1);
          expect(dailyLossPublishCalls).toBe(0);
          expect(preparedDailyLoss?.isCurrent()).toBeTrue();
          refreshOrdersCalls += 1;
          rebuildSteps.push('refresh');
          rebuildSnapshots.push(snapshot);
          expect(targets).toContainEqual({ symbol: 'BULL.HK', isLongSymbol: true });

          return { status: 'COMMITTED', receipts: [] };
        },
      }),
      {
        validateRebuildSnapshot: (symbol: string, snapshot: ReadonlyArray<RawOrderFromAPI>) => {
          preflightCalls += 1;
          preflightSymbols.push(symbol);
          rebuildSteps.push(`preflight:${symbol}`);
          rebuildSnapshots.push(snapshot);
          expect(expectedRelatedTradingSymbols).toContain(symbol);
        },
      },
    );
    const context = createMonitorContext({
      orderRecorder,
      dailyLossTracker: {
        ...dailyLossOwner,
        prepareRecalculationFromAllOrders: (...params) => {
          dailyLossPrepareCalls += 1;
          rebuildSteps.push('daily-prepare');
          rebuildSnapshots.push(params[0]);
          dailyLossRelatedTradingSymbols = params[4];
          expect(refreshOrdersCalls).toBe(0);
          expect(params[1].monitorSymbol).toBe('HSI.HK');
          expect(params[2].getTime()).toBe(MONITOR_TASK_NOW_MS);
          expect(params[3]).toBeUndefined();
          preparedDailyLoss = dailyLossOwner.prepareRecalculationFromAllOrders(...params);
          return preparedDailyLoss;
        },
        publishRecalculation: (prepared) => {
          expect(preparedDailyLoss).toBe(prepared);
          expect(refreshOrdersCalls).toBe(1);
          expect(prepared.isCurrent()).toBeTrue();
          dailyLossOwner.publishRecalculation(prepared);
          dailyLossPublishCalls += 1;
          rebuildSteps.push('daily-publish');
          expect(prepared.isCurrent()).toBeFalse();
        },
      },
      riskChecker: createRiskCheckerDouble({
        publishUnrealizedLossData: () => {
          refreshUnrealizedCalls += 1;
        },
      }),
    });
    context.symbolRegistry.updateSeatState('LONG', {
      ...context.symbolRegistry.getSeatState('LONG'),
      symbol: 'BULL.HK',
      status: 'ACTIVATING',
      callPrice: '20000',
    });

    const processor = await createBusinessProcessor({
      queue,
      context,
      trader: createTraderDouble({
        getAccountSnapshot: async () => {
          accountSnapshotCalls += 1;
          return createAccountSnapshotDouble('200000');
        },
        getStockPositions: async () => {
          stockPositionCalls += 1;
          return [
            createPositionDouble({
              symbol: 'BULL.HK',
              quantity: 100,
              availableQuantity: 100,
            }),
          ];
        },
      }),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () => {
          getQuotesCalls += 1;
          return new Map([
            ['BULL.HK', { ...createQuoteDouble('BULL.HK', '1.1', 100), name: 'BULL Name' }],
          ]);
        },
      }),
    });

    await runProcessorFlow({
      processor,
      pushTask: () => {
        scheduleSeatRefreshTask(queue, 'SEAT_REFRESH:LONG');
      },
      waitCondition: () => queue.isEmpty(),
      timeoutMs: 500,
    });

    expect(fetchAllOrdersCalls).toBe(1);
    expect(preflightCalls).toBe(expectedRelatedTradingSymbols.length);
    expect(refreshOrdersCalls).toBe(1);
    expect(dailyLossPrepareCalls).toBe(1);
    expect(dailyLossPublishCalls).toBe(1);
    expect(dailyLossOwner.getLossOffset('LONG')).toBe('0');
    expect(preflightSymbols).toEqual([...expectedRelatedTradingSymbols]);
    expect(rebuildSteps).toEqual([
      'preflight:BULL.HK',
      'preflight:OLD_BULL.HK',
      'preflight:BEAR.HK',
      'daily-prepare',
      'refresh',
      'daily-publish',
    ]);

    if (!dailyLossRelatedTradingSymbols) {
      throw new Error('expected SEAT_REFRESH to pass related trading symbols to DailyLossTracker');
    }

    expect([...dailyLossRelatedTradingSymbols]).toEqual([...expectedRelatedTradingSymbols]);
    for (const snapshot of rebuildSnapshots) {
      expect(snapshot).toBe(allOrders);
    }

    expect(accountSnapshotCalls).toBe(1);
    expect(stockPositionCalls).toBe(1);
    expect(refreshUnrealizedCalls).toBe(1);
    expect(getQuotesCalls).toBe(1);
    expect(context.symbolRegistry.getSeatState('LONG').status).toBe('ACTIVE');
    expect(context.longSymbolName).toBe('BULL Name');
    expect(processor.snapshot.getView().account?.totalCash).toBe('200000');
    expect(processor.snapshot.getAvailablePosition('BULL.HK')?.quantity).toBe(100);
  });

  it('fails SEAT_REFRESH fatally before cache, account, risk, or activation writes when the actual query mapper rejects updatedAt', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const fatalErrors: unknown[] = [];
    let refreshOrdersCalls = 0;
    let accountSnapshotCalls = 0;
    let stockPositionCalls = 0;
    let refreshUnrealizedCalls = 0;
    let warrantInfoWrites = 0;
    let activationWrites = 0;
    const ingress = await createBrokerIngressFixture({
      orderId: 'seat-refresh-missing-updated-at',
      tradeId: 'seat-refresh-missing-updated-at-trade',
      symbol: 'BULL.HK',
      stockName: 'HSI RC',
      remark: 'AUTO',
      side: 'BUY',
      status: 'Filled',
      submittedPrice: '1.1',
      quantity: '100',
      executedPrice: '1.1',
      executedQuantity: '100',
      submittedAtMs: Date.parse('2026-03-13T02:00:00.000Z'),
      executionTimeMs: MONITOR_TASK_NOW_MS,
      updatedAtMs: MONITOR_TASK_NOW_MS,
    });
    const readOrders = ingress.createQueryOrdersReader();
    ingress.setQueryUpdatedAtMs(Number.NaN);
    expect(ingress.nativeReadCounts().detail).toBe(0);
    let queryFailure: unknown = null;
    const dailyLossTracker = createDailyLossTracker({
      ...createDailyLossOrderAnalysisDeps(),
      resolveOrderOwnership: (order) =>
        order.symbol === 'BULL.HK' ? { monitorSymbol: 'HSI.HK', direction: 'LONG' } : null,
      toHongKongTimeIso,
    });
    const context = createMonitorContext({
      dailyLossTracker,
      orderRecorder: createOrderRecorderDouble({
        fetchAllOrdersFromAPI: async () => {
          try {
            return await readOrders();
          } catch (error) {
            queryFailure = error;
            throw error;
          }
        },
        commitRebuildSnapshot: (_targets, _orders, isCurrent, mode) => {
          expect(mode).toBe('ACTIVATION');
          if (!isCurrent()) return { status: 'ABORTED' };

          refreshOrdersCalls += 1;
          return { status: 'COMMITTED', receipts: [] };
        },
      }),
      riskChecker: createRiskCheckerDouble({
        publishUnrealizedLossData: () => {
          refreshUnrealizedCalls += 1;
        },
        setWarrantInfoFromCallPrice: () => {
          warrantInfoWrites += 1;
          return { status: 'ok', isWarrant: true };
        },
      }),
    });
    context.symbolRegistry.updateSeatState('LONG', {
      ...context.symbolRegistry.getSeatState('LONG'),
      symbol: 'BULL.HK',
      status: 'ACTIVATING',
      callPrice: '20000',
    });
    const updateSeatState = context.symbolRegistry.updateSeatState;
    context.symbolRegistry.updateSeatState = (direction, nextState) => {
      if (direction === 'LONG' && nextState.status === 'ACTIVE') {
        activationWrites += 1;
      }

      return updateSeatState(direction, nextState);
    };

    const processor = await createBusinessProcessor({
      queue,
      context,
      trader: createTraderDouble({
        getAccountSnapshot: async () => {
          accountSnapshotCalls += 1;
          return createAccountSnapshotDouble('100000');
        },
        getStockPositions: async () => {
          stockPositionCalls += 1;
          return [];
        },
      }),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () =>
          new Map([
            ['BULL.HK', createQuoteDouble('BULL.HK', '1.1', 100)],
            ['OLD_BULL.HK', createQuoteDouble('OLD_BULL.HK', '1', 100)],
          ]),
      }),
      termination: {
        isTerminated: () => false,
        reportFatalError: (error) => {
          fatalErrors.push(error);
        },
      },
    });

    await runProcessorFlow({
      processor,
      pushTask: () => {
        scheduleSeatRefreshTask(queue, 'SEAT_REFRESH:LONG:BAD_UPDATED_AT');
      },
      waitCondition: () => fatalErrors.length === 1,
      timeoutMs: 500,
    });

    expect(fatalErrors).toHaveLength(1);
    const fatalError = fatalErrors[0];
    if (!(fatalError instanceof Error)) {
      throw new Error('expected DailyLossTracker failure to reach the fatal channel');
    }

    expect(fatalErrors[0]).toBe(queryFailure);
    expect(fatalError.message).toBe('[orderMapper] invalid updatedAt');
    expect(ingress.nativeReadCounts()).toEqual({ cancel: 0, detail: 1 });
    expect(ingress.nativeMutations()).toEqual([]);
    expect(refreshOrdersCalls).toBe(0);
    expect(accountSnapshotCalls).toBe(0);
    expect(stockPositionCalls).toBe(0);
    expect(refreshUnrealizedCalls).toBe(0);
    expect(warrantInfoWrites).toBe(0);
    expect(activationWrites).toBe(0);
    expect(processor.snapshot.getView().account?.totalCash).toBe('100000');
    expect(processor.snapshot.getView().positions).toEqual([]);
    expect(context.symbolRegistry.getSeatState('LONG').status).toBe('ACTIVATING');
  });

  it('preflights SEAT_REFRESH before DailyLoss rejects a relevant unowned execution', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const fatalErrors: unknown[] = [];
    const now = new Date(MONITOR_TASK_NOW_MS);
    const ingress = await createBrokerIngressFixture({
      orderId: 'seat-refresh-unowned-known-side',
      tradeId: 'seat-refresh-unowned-known-side-trade',
      symbol: 'BULL.HK',
      stockName: 'HSI RC',
      remark: 'AUTO',
      side: 'BUY',
      status: 'Filled',
      submittedPrice: '1.1',
      quantity: '100',
      executedPrice: '1.1',
      executedQuantity: '100',
      submittedAtMs: now.getTime(),
      executionTimeMs: MONITOR_TASK_NOW_MS,
      updatedAtMs: now.getTime(),
    });
    const knownSideOrder = ingress.queryObservation;
    let preflightCalls = 0;
    const preflightSymbols: string[] = [];
    let refreshOrdersCalls = 0;
    let quotesCalls = 0;
    let accountReads = 0;
    let positionReads = 0;
    let prepareCalls = 0;
    let publishCalls = 0;
    let warrantWrites = 0;
    const orderRecorder = Object.assign(
      createOrderRecorderDouble({
        fetchAllOrdersFromAPI: async () => [knownSideOrder],
        commitRebuildSnapshot: (_targets, _orders, isCurrent, mode) => {
          expect(mode).toBe('ACTIVATION');
          if (!isCurrent()) return { status: 'ABORTED' };

          refreshOrdersCalls += 1;
          return { status: 'COMMITTED', receipts: [] };
        },
      }),
      {
        validateRebuildSnapshot: (symbol: string, allOrders: ReadonlyArray<RawOrderFromAPI>) => {
          preflightCalls += 1;
          preflightSymbols.push(symbol);
          classifyOrdersForRebuild(allOrders.filter((order) => order.symbol === symbol));
        },
      },
    );
    const dailyLossTracker = createDailyLossTracker({
      ...createDailyLossOrderAnalysisDeps(),
      resolveOrderOwnership: () => null,
      toHongKongTimeIso,
    });
    const context = createMonitorContext({
      dailyLossTracker,
      orderRecorder,
      riskChecker: createRiskCheckerDouble({
        prepareUnrealizedLossData: (_recorder, symbol) => {
          prepareCalls += 1;
          return { symbol, data: { r1: '0', n1: 0 } };
        },
        publishUnrealizedLossData: () => {
          publishCalls += 1;
        },
        setWarrantInfoFromCallPrice: () => {
          warrantWrites += 1;
          return { status: 'ok', isWarrant: true };
        },
      }),
    });
    context.symbolRegistry.updateSeatState('LONG', {
      ...context.symbolRegistry.getSeatState('LONG'),
      symbol: 'BULL.HK',
      status: 'ACTIVATING',
      callPrice: '20000',
    });

    const processor = await createBusinessProcessor({
      queue,
      context,
      trader: createTraderDouble({
        getAccountSnapshot: async () => {
          accountReads += 1;
          return createAccountSnapshotDouble('100000');
        },
        getStockPositions: async () => {
          positionReads += 1;
          return [];
        },
      }),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () => {
          quotesCalls += 1;
          return new Map([['BULL.HK', createQuoteDouble('BULL.HK', '1.1', 100)]]);
        },
      }),
      termination: {
        isTerminated: () => false,
        reportFatalError: (error) => {
          fatalErrors.push(error);
        },
      },
    });

    await runProcessorFlow({
      processor,
      pushTask: () => {
        scheduleSeatRefreshTask(queue, 'SEAT_REFRESH:LONG:UNOWNED_KNOWN_SIDE');
      },
      waitCondition: () => fatalErrors.length === 1,
      timeoutMs: 500,
    });

    const fatalError = fatalErrors[0];
    if (!(fatalError instanceof Error)) {
      throw new Error('expected DailyLossTracker ownership failure to reach the fatal channel');
    }

    expect(fatalError.message).toBe(
      '[DailyLossTracker] 相关成交订单无法归属: monitorSymbol=HSI.HK symbol=BULL.HK orderId=seat-refresh-unowned-known-side',
    );
    expect(dailyLossTracker.getLossOffset('LONG')).toBe('0');
    expect(processor.snapshot.getView().account?.totalCash).toBe('100000');
    expect(processor.snapshot.getView().positions).toEqual([]);
    expect(context.symbolRegistry.getSeatState('LONG').status).toBe('ACTIVATING');
    expect(preflightCalls).toBe(3);
    expect(preflightSymbols).toEqual(['BULL.HK', 'OLD_BULL.HK', 'BEAR.HK']);
    expect(quotesCalls).toBe(1);
    expect(accountReads).toBe(0);
    expect(positionReads).toBe(0);
    expect(prepareCalls).toBe(0);
    expect(publishCalls).toBe(0);
    expect(warrantWrites).toBe(0);
    expect(refreshOrdersCalls).toBe(0);
  });

  it('fails SEAT_REFRESH fatally before post-refresh writes when a positive execution fact is malformed', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const fatalErrors: unknown[] = [];
    let refreshOrdersCalls = 0;
    let accountSnapshotCalls = 0;
    let stockPositionCalls = 0;
    let refreshUnrealizedCalls = 0;
    let warrantInfoWrites = 0;
    let activationWrites = 0;
    const ingress = await createBrokerIngressFixture({
      orderId: 'seat-refresh-invalid-execution-price',
      tradeId: 'seat-refresh-invalid-execution-price-trade',
      symbol: 'BULL.HK',
      stockName: 'HSI RC',
      remark: 'AUTO',
      side: 'BUY',
      status: 'Filled',
      submittedPrice: '1.1',
      quantity: '100',
      executedPrice: '1.1',
      executedQuantity: '100',
      submittedAtMs: Date.parse('2026-03-13T02:00:00.000Z'),
      executionTimeMs: MONITOR_TASK_NOW_MS,
      updatedAtMs: Date.parse('2026-03-13T02:01:00.000Z'),
    });
    const malformedPositiveExecution: RawOrderFromAPI = {
      ...ingress.queryObservation,
      executedPrice: '0',
      executedAmount: '0',
    };
    const context = createMonitorContext({
      orderRecorder: createOrderRecorderDouble({
        fetchAllOrdersFromAPI: async () => [malformedPositiveExecution],
        commitRebuildSnapshot: (_targets, allOrders, isCurrent, mode) => {
          expect(mode).toBe('ACTIVATION');
          if (!isCurrent()) return { status: 'ABORTED' };

          refreshOrdersCalls += 1;
          classifyOrdersForRebuild(allOrders);
          return { status: 'COMMITTED', receipts: [] };
        },
      }),
      riskChecker: createRiskCheckerDouble({
        publishUnrealizedLossData: () => {
          refreshUnrealizedCalls += 1;
        },
        setWarrantInfoFromCallPrice: () => {
          warrantInfoWrites += 1;
          return { status: 'ok', isWarrant: true };
        },
      }),
    });
    context.symbolRegistry.updateSeatState('LONG', {
      ...context.symbolRegistry.getSeatState('LONG'),
      symbol: 'BULL.HK',
      status: 'ACTIVATING',
      callPrice: '20000',
    });
    const updateSeatState = context.symbolRegistry.updateSeatState;
    context.symbolRegistry.updateSeatState = (direction, nextState) => {
      if (direction === 'LONG' && nextState.status === 'ACTIVE') {
        activationWrites += 1;
      }

      return updateSeatState(direction, nextState);
    };

    const processor = await createBusinessProcessor({
      queue,
      context,
      trader: createTraderDouble({
        getAccountSnapshot: async () => {
          accountSnapshotCalls += 1;
          return createAccountSnapshotDouble('100000');
        },
        getStockPositions: async () => {
          stockPositionCalls += 1;
          return [];
        },
      }),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () =>
          new Map([
            ['BULL.HK', createQuoteDouble('BULL.HK', '1.1', 100)],
            ['OLD_BULL.HK', createQuoteDouble('OLD_BULL.HK', '1', 100)],
          ]),
      }),
      termination: {
        isTerminated: () => false,
        reportFatalError: (error) => {
          fatalErrors.push(error);
        },
      },
    });

    await runProcessorFlow({
      processor,
      pushTask: () => {
        scheduleSeatRefreshTask(queue, 'SEAT_REFRESH:LONG:INVALID_EXECUTION');
      },
      waitCondition: () => fatalErrors.length === 1,
      timeoutMs: 500,
    });

    expect(fatalErrors).toHaveLength(1);
    const fatalError = fatalErrors[0];
    if (!(fatalError instanceof Error)) {
      throw new Error('expected malformed execution fact to reach the fatal channel');
    }

    expect(fatalError.message).toBe('[订单记录] 金额、数量或执行时间无效');
    expect(refreshOrdersCalls).toBe(0);
    expect(accountSnapshotCalls).toBe(0);
    expect(stockPositionCalls).toBe(0);
    expect(refreshUnrealizedCalls).toBe(0);
    expect(warrantInfoWrites).toBe(0);
    expect(activationWrites).toBe(0);
    expect(processor.snapshot.getView().account?.totalCash).toBe('100000');
    expect(processor.snapshot.getView().positions).toEqual([]);
    expect(context.symbolRegistry.getSeatState('LONG').status).toBe('ACTIVATING');
  });

  for (const unknownSideCase of [
    {
      label: 'Filled with positive execution',
      status: 'Filled',
      executionStatus: 'FILLED',
      executedPrice: '1',
      executedQuantity: 100,
    },
    {
      label: 'PartialFilled with zero execution',
      status: 'PartialFilled',
      executedPrice: '0',
      executedQuantity: 0,
    },
  ] as const) {
    it(`fails SEAT_REFRESH fatally before post-refresh writes for Unknown-side ${unknownSideCase.label}`, async () => {
      const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
      const fatalErrors: unknown[] = [];
      let preflightCalls = 0;
      let refreshOrdersCalls = 0;
      let accountSnapshotCalls = 0;
      let stockPositionCalls = 0;
      let refreshUnrealizedCalls = 0;
      let warrantInfoWrites = 0;
      let activationWrites = 0;
      const now = new Date(MONITOR_TASK_NOW_MS);
      const ingress = await createBrokerIngressFixture({
        stockName: 'HSI RC',
        orderId: `seat-refresh-unknown-side-${unknownSideCase.label}`,
        tradeId: `trade-${unknownSideCase.label}`,
        symbol: 'BULL.HK',
        side: 'BUY',
        status: unknownSideCase.status,
        submittedPrice: '1.1',
        quantity: '100',
        executedPrice: unknownSideCase.executedPrice,
        executedQuantity: String(unknownSideCase.executedQuantity),
        submittedAtMs: now.getTime(),
        executionTimeMs: now.getTime(),
        updatedAtMs: now.getTime(),
        remark: 'AUTO',
      });
      const readOrders = ingress.createQueryOrdersReader();
      ingress.setQuerySideUnknown();
      expect(ingress.nativeReadCounts().detail).toBe(0);
      let queryFailure: unknown = null;
      const dailyLossTracker = createDailyLossTracker({
        ...createDailyLossOrderAnalysisDeps(),
        resolveOrderOwnership: (order) =>
          order.symbol === 'BULL.HK' ? { monitorSymbol: 'HSI.HK', direction: 'LONG' } : null,
        toHongKongTimeIso,
      });
      const orderRecorder = Object.assign(
        createOrderRecorderDouble({
          fetchAllOrdersFromAPI: async () => {
            try {
              return await readOrders();
            } catch (error) {
              queryFailure = error;
              throw error;
            }
          },
          commitRebuildSnapshot: (_targets, allOrders, isCurrent, mode) => {
            expect(mode).toBe('ACTIVATION');
            if (!isCurrent()) return { status: 'ABORTED' };

            refreshOrdersCalls += 1;
            classifyOrdersForRebuild(allOrders);
            return { status: 'COMMITTED', receipts: [] };
          },
        }),
        {
          validateRebuildSnapshot: (symbol: string, allOrders: ReadonlyArray<RawOrderFromAPI>) => {
            preflightCalls += 1;
            classifyOrdersForRebuild(allOrders.filter((order) => order.symbol === symbol));
          },
        },
      );
      const context = createMonitorContext({
        dailyLossTracker,
        orderRecorder,
        riskChecker: createRiskCheckerDouble({
          publishUnrealizedLossData: () => {
            refreshUnrealizedCalls += 1;
          },
          setWarrantInfoFromCallPrice: () => {
            warrantInfoWrites += 1;
            return { status: 'ok', isWarrant: true };
          },
        }),
      });
      context.symbolRegistry.updateSeatState('LONG', {
        ...context.symbolRegistry.getSeatState('LONG'),
        symbol: 'BULL.HK',
        status: 'ACTIVATING',
        callPrice: '20000',
      });
      const seedOrders = await createDailyLossSeedOrders(now, `unknown-${unknownSideCase.label}`);
      dailyLossTracker.recalculateFromAllOrders(
        seedOrders,
        context.config,
        now,
        undefined,
        new Set(['BULL.HK']),
      );
      expect(dailyLossTracker.getLossOffset('LONG')).toBe('-10');
      const updateSeatState = context.symbolRegistry.updateSeatState;
      context.symbolRegistry.updateSeatState = (direction, nextState) => {
        if (direction === 'LONG' && nextState.status === 'ACTIVE') {
          activationWrites += 1;
        }

        return updateSeatState(direction, nextState);
      };

      const processor = await createBusinessProcessor({
        queue,
        context,
        trader: createTraderDouble({
          getAccountSnapshot: async () => {
            accountSnapshotCalls += 1;
            return createAccountSnapshotDouble('100000');
          },
          getStockPositions: async () => {
            stockPositionCalls += 1;
            return [];
          },
        }),
        marketDataClient: createMarketDataClientDouble({
          getQuotes: async () =>
            new Map([
              ['BULL.HK', createQuoteDouble('BULL.HK', '1.1', 100)],
              ['OLD_BULL.HK', createQuoteDouble('OLD_BULL.HK', '1', 100)],
            ]),
        }),
        termination: {
          isTerminated: () => false,
          reportFatalError: (error) => {
            fatalErrors.push(error);
          },
        },
      });

      await runProcessorFlow({
        processor,
        pushTask: () => {
          scheduleSeatRefreshTask(queue, `SEAT_REFRESH:LONG:UNKNOWN_SIDE:${unknownSideCase.label}`);
        },
        waitCondition: () => fatalErrors.length === 1,
        timeoutMs: 500,
      });

      expect(ingress.nativeReadCounts()).toEqual({ cancel: 0, detail: 1 });
      expect(ingress.nativeMutations()).toEqual([]);
      expect(fatalErrors[0]).toBe(queryFailure);
      const fatalError = fatalErrors[0];
      const refreshWasBlocked = fatalError instanceof Error && fatalError === queryFailure;

      expect({
        refreshWasBlocked,
        preflightCalls,
        refreshOrdersCalls,
        accountSnapshotCalls,
        stockPositionCalls,
        refreshUnrealizedCalls,
        warrantInfoWrites,
        activationWrites,
        canonicalCash: processor.snapshot.getView().account?.totalCash,
        canonicalPositions: processor.snapshot.getView().positions,
        dailyLossOffset: dailyLossTracker.getLossOffset('LONG'),
        seatStatus: context.symbolRegistry.getSeatState('LONG').status,
      }).toEqual({
        refreshWasBlocked: true,
        preflightCalls: 0,
        refreshOrdersCalls: 0,
        accountSnapshotCalls: 0,
        stockPositionCalls: 0,
        refreshUnrealizedCalls: 0,
        warrantInfoWrites: 0,
        activationWrites: 0,
        canonicalCash: '100000',
        canonicalPositions: [],
        dailyLossOffset: '-10',
        seatStatus: 'ACTIVATING',
      });
    });
  }

  for (const relatedOrderCase of [
    {
      label: 'Unknown Filled execution',
      status: 'Filled',
      executionStatus: 'FILLED',
      executedPrice: '1',
      executedQuantity: 100,
      expectedErrorFragment: '订单方向不可归属',
    },
    {
      label: 'malformed known-side execution',

      executionStatus: 'FILLED',
      status: 'Filled',
      executedPrice: '0',
      executedQuantity: 100,
      expectedErrorFragment: '金额、数量或执行时间无效',
    },
  ] as const) {
    it(`fails SEAT_REFRESH before DailyLoss writes for non-target related ${relatedOrderCase.label}`, async () => {
      const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
      const fatalErrors: unknown[] = [];
      const now = new Date(MONITOR_TASK_NOW_MS);
      const ingress = await createBrokerIngressFixture({
        stockName: 'HSI RC',
        orderId: `seat-refresh-related-${relatedOrderCase.label}`,
        tradeId: `trade-related-${relatedOrderCase.label}`,
        symbol: 'OLD_BULL.HK',
        side: 'BUY',
        status: 'Filled',
        submittedPrice: '1.1',
        quantity: '100',
        executedPrice: '1',
        executedQuantity: '100',
        submittedAtMs: now.getTime(),
        executionTimeMs: now.getTime(),
        updatedAtMs: now.getTime(),
        remark: 'AUTO',
      });
      const isUnknownSide = relatedOrderCase.label === 'Unknown Filled execution';
      if (isUnknownSide) ingress.setQuerySideUnknown();

      expect(ingress.nativeReadCounts().detail).toBe(0);
      const readOrders = ingress.createQueryOrdersReader();
      let queryFailure: unknown = null;
      const dailyLossTracker = createDailyLossTracker({
        ...createDailyLossOrderAnalysisDeps(),
        resolveOrderOwnership: (order) =>
          order.symbol === 'BULL.HK' ? { monitorSymbol: 'HSI.HK', direction: 'LONG' } : null,
        toHongKongTimeIso,
      });
      const preflightSymbols: string[] = [];
      let refreshOrdersCalls = 0;
      let activationWrites = 0;
      const orderRecorder = createOrderRecorderDouble({
        fetchAllOrdersFromAPI: async () => {
          if (!isUnknownSide)
            return [{ ...ingress.queryObservation, executedPrice: '0', executedAmount: '0' }];

          try {
            return await readOrders();
          } catch (error) {
            queryFailure = error;
            throw error;
          }
        },
        validateRebuildSnapshot: (symbol, allOrders) => {
          preflightSymbols.push(symbol);
          classifyOrdersForRebuild(allOrders.filter((order) => order.symbol === symbol));
        },
        commitRebuildSnapshot: (_targets, _orders, isCurrent, mode) => {
          expect(mode).toBe('ACTIVATION');
          if (!isCurrent()) return { status: 'ABORTED' };

          refreshOrdersCalls += 1;
          return { status: 'COMMITTED', receipts: [] };
        },
      });
      const context = createMonitorContext({
        dailyLossTracker,
        orderRecorder,
      });
      context.symbolRegistry.updateSeatState('LONG', {
        ...context.symbolRegistry.getSeatState('LONG'),
        symbol: 'BULL.HK',
        status: 'ACTIVATING',
        callPrice: '20000',
      });
      const seedOrders = await createDailyLossSeedOrders(now, `related-${relatedOrderCase.label}`);
      dailyLossTracker.recalculateFromAllOrders(
        seedOrders,
        context.config,
        now,
        undefined,
        new Set(['BULL.HK']),
      );
      expect(dailyLossTracker.getLossOffset('LONG')).toBe('-10');
      const updateSeatState = context.symbolRegistry.updateSeatState;
      context.symbolRegistry.updateSeatState = (direction, nextState) => {
        if (direction === 'LONG' && nextState.status === 'ACTIVE') {
          activationWrites += 1;
        }

        return updateSeatState(direction, nextState);
      };

      const processor = await createBusinessProcessor({
        queue,
        context,
        marketDataClient: createMarketDataClientDouble({
          getQuotes: async () =>
            new Map([
              ['BULL.HK', createQuoteDouble('BULL.HK', '1.1', 100)],
              ['OLD_BULL.HK', createQuoteDouble('OLD_BULL.HK', '1', 100)],
            ]),
        }),
        termination: {
          isTerminated: () => false,
          reportFatalError: (error) => {
            fatalErrors.push(error);
          },
        },
      });

      await runProcessorFlow({
        processor,
        pushTask: () => {
          scheduleSeatRefreshTask(queue, `SEAT_REFRESH:LONG:RELATED:${relatedOrderCase.label}`);
        },
        waitCondition: () => fatalErrors.length === 1,
        timeoutMs: 500,
      });

      expect(ingress.nativeReadCounts()).toEqual({ cancel: 0, detail: isUnknownSide ? 1 : 0 });
      expect(ingress.nativeMutations()).toEqual([]);
      if (isUnknownSide) expect(fatalErrors[0]).toBe(queryFailure);

      const fatalError = fatalErrors[0];
      const preflightBlocked =
        fatalError instanceof Error &&
        (isUnknownSide
          ? fatalError === queryFailure
          : fatalError.message.includes(relatedOrderCase.expectedErrorFragment));

      expect({
        preflightBlocked,
        preflightSymbols,
        refreshOrdersCalls,
        dailyLossOffset: dailyLossTracker.getLossOffset('LONG'),
        activationWrites,
        seatStatus: context.symbolRegistry.getSeatState('LONG').status,
      }).toEqual({
        preflightBlocked: true,
        preflightSymbols: isUnknownSide ? [] : ['BULL.HK', 'OLD_BULL.HK'],
        refreshOrdersCalls: 0,
        dailyLossOffset: '-10',
        activationWrites: 0,
        seatStatus: 'ACTIVATING',
      });
    });
  }

  it('processes SHORT SEAT_REFRESH and updates short-side symbol name', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    let refreshOrdersCalls = 0;
    const context = createMonitorContext({
      orderRecorder: createOrderRecorderDouble({
        fetchAllOrdersFromAPI: async () => [],
        commitRebuildSnapshot: (_targets, __allOrders, isCurrent, mode) => {
          expect(mode).toBe('ACTIVATION');
          if (!isCurrent()) return { status: 'ABORTED' };

          refreshOrdersCalls += 1;

          return { status: 'COMMITTED', receipts: [] };
        },
      }),
      riskChecker: createRiskCheckerDouble({
        publishUnrealizedLossData: () => {},
      }),
    });
    context.symbolRegistry.updateSeatState('SHORT', {
      ...context.symbolRegistry.getSeatState('SHORT'),
      symbol: 'BEAR.HK',
      status: 'ACTIVATING',
      callPrice: '20000',
    });

    const processor = await createBusinessProcessor({
      queue,
      context,
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () =>
          new Map([
            ['BEAR.HK', { ...createQuoteDouble('BEAR.HK', '0.9', 100), name: 'BEAR Name' }],
          ]),
      }),
    });

    await runProcessorFlow({
      processor,
      pushTask: () => {
        scheduleSeatRefreshTask(queue, 'SEAT_REFRESH:SHORT', {
          direction: 'SHORT',
          seatVersion: 3,
          previousSymbol: 'OLD_BEAR.HK',
          nextSymbol: 'BEAR.HK',
          symbolName: 'BEAR.HK',
        });
      },
      waitCondition: () => queue.isEmpty(),
      timeoutMs: 500,
    });

    expect(refreshOrdersCalls).toBe(1);
    expect(context.symbolRegistry.getSeatState('SHORT').status).toBe('ACTIVE');
    expect(context.shortSymbolName).toBe('BEAR Name');
  });

  it('marks SHORT SEAT_REFRESH business failure as EMPTY and clears short-side symbol name', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const context = createMonitorContext({
      shortSymbolName: 'OLD_BEAR',
    });
    context.symbolRegistry.updateSeatState('SHORT', {
      ...context.symbolRegistry.getSeatState('SHORT'),
      symbol: 'BEAR.HK',
      status: 'ACTIVATING',
      callPrice: null,
    });

    const processor = await createBusinessProcessor({
      queue,
      context,
    });

    await runProcessorFlow({
      processor,
      pushTask: () => {
        scheduleSeatRefreshTask(queue, 'SEAT_REFRESH:SHORT:INVALID_CALL_PRICE', {
          direction: 'SHORT',
          seatVersion: 3,
          previousSymbol: 'OLD_BEAR.HK',
          nextSymbol: 'BEAR.HK',
          callPrice: null,
          symbolName: 'BEAR.HK',
        });
      },
      waitCondition: () => queue.isEmpty(),
      timeoutMs: 500,
    });

    expect(context.symbolRegistry.getSeatState('SHORT')).toMatchObject({
      symbol: null,
      status: 'EMPTY',
      callPrice: null,
    });
    expect(context.shortSymbolName).toBe('');
    expect(context.symbolRegistry.getSeatVersion('SHORT')).toBe(4);
  });

  it('waits for quote admission to resolve before rebuilding SEAT_REFRESH caches', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const admissionDeferred = createDeferred<null>();
    const admissionStartedDeferred = createDeferred<null>();
    let getQuotesCalls = 0;
    let fetchAllOrdersCalls = 0;
    let refreshOrdersCalls = 0;
    let refreshUnrealizedCalls = 0;
    const context = createMonitorContext({
      orderRecorder: createOrderRecorderDouble({
        fetchAllOrdersFromAPI: async () => {
          fetchAllOrdersCalls += 1;
          return [];
        },
        commitRebuildSnapshot: (_targets, _orders, isCurrent, mode) => {
          expect(mode).toBe('ACTIVATION');
          if (!isCurrent()) return { status: 'ABORTED' };

          refreshOrdersCalls += 1;
          return { status: 'COMMITTED', receipts: [] };
        },
      }),
      riskChecker: createRiskCheckerDouble({
        publishUnrealizedLossData: () => {
          refreshUnrealizedCalls += 1;
        },
      }),
    });
    context.symbolRegistry.updateSeatState('LONG', {
      ...context.symbolRegistry.getSeatState('LONG'),
      symbol: 'BULL.HK',
      status: 'ACTIVATING',
      callPrice: '20000',
    });

    const processor = await createBusinessProcessor({
      queue,
      context,
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () => {
          getQuotesCalls += 1;
          return new Map([['BULL.HK', createQuoteDouble('BULL.HK', '1.1', 100)]]);
        },
      }),
      quoteSubscriptionRuntime: createQuoteSubscriptionRuntimeDouble({
        waitForAdmission: async () => {
          admissionStartedDeferred.resolve(null);
          await admissionDeferred.promise;
        },
      }),
    });

    processor.start();
    scheduleSeatRefreshTask(queue, 'SEAT_REFRESH:LONG:ADMISSION');

    await admissionStartedDeferred.promise;
    await Promise.resolve();

    expect(getQuotesCalls).toBe(0);
    expect(fetchAllOrdersCalls).toBe(0);
    expect(refreshOrdersCalls).toBe(0);
    expect(refreshUnrealizedCalls).toBe(0);
    expect(context.symbolRegistry.getSeatState('LONG').status).toBe('ACTIVATING');

    admissionDeferred.resolve(null);
    await waitUntil(() => context.symbolRegistry.getSeatState('LONG').status === 'ACTIVE');
    await processor.stopAndDrain();

    expect(getQuotesCalls).toBe(1);
    expect(fetchAllOrdersCalls).toBe(1);
    expect(refreshOrdersCalls).toBe(1);
    expect(refreshUnrealizedCalls).toBe(1);
    expect(context.symbolRegistry.getSeatState('LONG').status).toBe('ACTIVE');
  });

  it('does not leave stale warrant risk cache after SEAT_REFRESH skips on changed seat', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const baseRiskChecker = createRiskChecker({
      warrantRiskChecker: createWarrantRiskChecker(),
      positionLimitChecker: createPositionLimitChecker({
        maxPositionNotional: null,
      }),
      unrealizedLossChecker: createUnrealizedLossChecker({
        maxUnrealizedLossPerSymbol: null,
      }),
    });
    const context = createMonitorContext({
      riskChecker: {
        ...baseRiskChecker,
        prepareUnrealizedLossData: (orderRecorder, symbol, isLongSymbol, dailyLossOffset) => {
          const prepared = baseRiskChecker.prepareUnrealizedLossData(
            orderRecorder,
            symbol,
            isLongSymbol,
            dailyLossOffset,
          );
          const latestSeat = context.symbolRegistry.getSeatState('LONG');
          context.symbolRegistry.updateSeatStateWithVersionBump('LONG', {
            ...latestSeat,
            symbol: 'NEXT_BULL.HK',
            status: 'SWITCHING',
            lastSwitchAt: Date.now(),
            callPrice: null,
          });
          return prepared;
        },
      },
    });
    context.symbolRegistry.updateSeatState('LONG', {
      ...context.symbolRegistry.getSeatState('LONG'),
      symbol: 'BULL.HK',
      status: 'ACTIVATING',
      callPrice: '20000',
    });

    const processor = await createBusinessProcessor({
      queue,
      context,
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () =>
          new Map([
            ['BULL.HK', createQuoteDouble('BULL.HK', '1.1', 100)],
            ['OLD_BULL.HK', createQuoteDouble('OLD_BULL.HK', '1', 100)],
          ]),
      }),
    });

    await runProcessorFlow({
      processor,
      pushTask: () => {
        scheduleSeatRefreshTask(queue, 'SEAT_REFRESH:LONG:STALE_CACHE_LEAK');
      },
      waitCondition: () => queue.isEmpty(),
      timeoutMs: 500,
    });

    const riskCheckResult = context.riskChecker.checkWarrantRisk(
      'NEXT_BULL.HK',
      'BUYCALL',
      '20010',
    );
    expect(riskCheckResult.allowed).toBeTrue();
  });

  it('does not write shared refresh state when SEAT_REFRESH becomes stale before cache rebuild starts', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    let dailyLossPrepareCalls = 0;
    let dailyLossPublishCalls = 0;
    const dailyLossOwner = createDailyLossTrackerDouble();
    let refreshOrdersCalls = 0;
    let refreshUnrealizedCalls = 0;
    let accountSnapshotCalls = 0;
    let stockPositionCalls = 0;
    const context = createMonitorContext({
      orderRecorder: createOrderRecorderDouble({
        fetchAllOrdersFromAPI: async () => [],
        commitRebuildSnapshot: (_targets, _orders, isCurrent, mode) => {
          expect(mode).toBe('ACTIVATION');
          if (!isCurrent()) return { status: 'ABORTED' };

          refreshOrdersCalls += 1;
          return { status: 'COMMITTED', receipts: [] };
        },
      }),
      dailyLossTracker: {
        ...dailyLossOwner,
        prepareRecalculationFromAllOrders: (...params) => {
          dailyLossPrepareCalls += 1;
          return dailyLossOwner.prepareRecalculationFromAllOrders(...params);
        },
        publishRecalculation: (prepared) => {
          dailyLossPublishCalls += 1;
          dailyLossOwner.publishRecalculation(prepared);
        },
      },
      riskChecker: createRiskCheckerDouble({
        publishUnrealizedLossData: () => {
          refreshUnrealizedCalls += 1;
        },
      }),
      longSymbolName: 'OLD_BULL',
    });
    context.symbolRegistry.updateSeatState('LONG', {
      ...context.symbolRegistry.getSeatState('LONG'),
      symbol: 'BULL.HK',
      status: 'ACTIVATING',
      callPrice: '20000',
    });

    const processor = await createBusinessProcessor({
      queue,
      context,
      trader: createTraderDouble({
        getAccountSnapshot: async () => {
          accountSnapshotCalls += 1;
          return createAccountSnapshotDouble('123000');
        },
        getStockPositions: async () => {
          stockPositionCalls += 1;
          return [
            createPositionDouble({
              symbol: 'BULL.HK',
              quantity: 100,
              availableQuantity: 100,
            }),
          ];
        },
      }),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () => {
          const latestSeat = context.symbolRegistry.getSeatState('LONG');
          context.symbolRegistry.updateSeatStateWithVersionBump('LONG', {
            ...latestSeat,
            symbol: 'NEXT_BULL.HK',
            status: 'SWITCHING',
            lastSwitchAt: Date.now(),
            callPrice: null,
          });
          return new Map([
            ['BULL.HK', createQuoteDouble('BULL.HK', '1.1', 100)],
            ['OLD_BULL.HK', createQuoteDouble('OLD_BULL.HK', '1', 100)],
          ]);
        },
      }),
    });

    await runProcessorFlow({
      processor,
      pushTask: () => {
        scheduleSeatRefreshTask(queue, 'SEAT_REFRESH:LONG:STALE_BEFORE_SHARED_WRITES');
      },
      waitCondition: () => queue.isEmpty(),
      timeoutMs: 500,
    });

    expect(dailyLossPrepareCalls).toBe(0);
    expect(dailyLossPublishCalls).toBe(0);
    expect(refreshOrdersCalls).toBe(0);
    expect(accountSnapshotCalls).toBe(0);
    expect(stockPositionCalls).toBe(0);
    expect(refreshUnrealizedCalls).toBe(0);
    expect(processor.snapshot.getView().account?.totalCash).toBe('100000');
    expect(processor.snapshot.getView().positions).toEqual([]);
    expect(processor.snapshot.getAvailablePosition('BULL.HK')).toBeNull();
    expect(context.longSymbolName).toBe('OLD_BULL');
    expect(context.symbolRegistry.getSeatVersion('LONG')).toBe(3);
    expect(context.symbolRegistry.getSeatState('LONG')).toMatchObject({
      symbol: 'NEXT_BULL.HK',
      status: 'SWITCHING',
    });
  });

  it('marks activating seat EMPTY after SEAT_REFRESH API retry is exhausted', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const fatalErrors: unknown[] = [];
    const retryCallbacks: Array<() => void> = [];
    let getQuotesCalls = 0;
    const context = createMonitorContext({
      longSymbolName: 'OLD_BULL',
    });
    context.symbolRegistry.updateSeatState('LONG', {
      ...context.symbolRegistry.getSeatState('LONG'),
      symbol: 'BULL.HK',
      status: 'ACTIVATING',
      callPrice: '20000',
    });
    const originalSeatVersion = context.symbolRegistry.getSeatVersion('LONG');

    const processor = await createBusinessProcessor({
      queue,
      context,
      scheduler: {
        scheduleTimer: (callback) => {
          retryCallbacks.push(callback);
          const handle = setTimeout(() => {}, 0);
          clearTimeout(handle);
          return handle;
        },
        clearTimer: () => {},
      },
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () => {
          getQuotesCalls += 1;
          throw await createExternalApiRequestError({
            operation: 'test.seatRefreshQuotes',
            attempts: 1,
            cause: new Error('quote unavailable'),
          });
        },
      }),
      termination: {
        isTerminated: () => false,
        reportFatalError: (error) => {
          fatalErrors.push(error);
        },
      },
    });

    processor.start();
    scheduleSeatRefreshTask(queue, 'SEAT_REFRESH:LONG:API_FAIL');

    await waitUntil(() => getQuotesCalls === 1 || fatalErrors.length === 1, 500);
    expect(retryCallbacks).toHaveLength(1);
    expect(getQuotesCalls).toBe(1);

    retryCallbacks[0]?.();
    await waitUntil(() => getQuotesCalls === 2 || fatalErrors.length === 1, 800);
    await processor.stopAndDrain();

    expect(fatalErrors).toEqual([]);
    expect(getQuotesCalls).toBe(2);
    expect(context.symbolRegistry.getSeatState('LONG')).toMatchObject({
      symbol: null,
      status: 'EMPTY',
      lastSwitchAt: MONITOR_TASK_NOW_MS,
      callPrice: null,
    });
    expect(context.longSymbolName).toBe('OLD_BULL');
    expect(context.symbolRegistry.getSeatVersion('LONG')).toBeGreaterThan(originalSeatVersion);
  });

  it('sends SEAT_REFRESH non API order refresh errors to fatal channel', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const fatalErrors: unknown[] = [];
    let getQuotesCalls = 0;

    const context = createMonitorContext({
      longSymbolName: 'OLD_BULL',
      orderRecorder: createOrderRecorderDouble({
        fetchAllOrdersFromAPI: async () => [],
        commitRebuildSnapshot: (_targets, _orders, isCurrent, mode) => {
          expect(mode).toBe('ACTIVATION');
          if (!isCurrent()) return { status: 'ABORTED' };

          throw new Error('seat refresh order rebuild failed');
        },
      }),
    });
    context.symbolRegistry.updateSeatState('LONG', {
      ...context.symbolRegistry.getSeatState('LONG'),
      symbol: 'BULL.HK',
      status: 'ACTIVATING',
      callPrice: '20000',
    });

    const processor = await createBusinessProcessor({
      queue,
      context,
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () => {
          getQuotesCalls += 1;
          return new Map([['BULL.HK', createQuoteDouble('BULL.HK', '1.1', 100)]]);
        },
      }),
      termination: {
        isTerminated: () => false,
        reportFatalError: (error) => {
          fatalErrors.push(error);
        },
      },
    });

    await runProcessorFlow({
      processor,
      pushTask: () => {
        scheduleSeatRefreshTask(queue, 'SEAT_REFRESH:LONG:FAIL');
      },
      waitCondition: () => fatalErrors.length === 1,
      timeoutMs: 500,
    });

    expect(fatalErrors).toHaveLength(1);
    expect(fatalErrors[0]).toBeInstanceOf(Error);
    expect(getQuotesCalls).toBe(1);
    expect(context.symbolRegistry.getSeatState('LONG')).toMatchObject({
      symbol: 'BULL.HK',
      status: 'ACTIVATING',
      callPrice: '20000',
    });
    expect(context.longSymbolName).toBe('OLD_BULL');
    expect(context.symbolRegistry.getSeatVersion('LONG')).toBe(2);
  });

  it('skips SEAT_REFRESH seat-owned work when the seat changes while order rebuild is pending', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const rebuildStarted = createDeferred<null>();
    const releaseRebuild = createDeferred<null>();
    let dailyLossPrepareCalls = 0;
    let dailyLossPublishCalls = 0;
    const dailyLossOwner = createDailyLossTrackerDouble();
    let accountSnapshotCalls = 0;
    let stockPositionCalls = 0;
    let refreshUnrealizedCalls = 0;
    let warrantInfoWrites = 0;
    let activationWrites = 0;
    const orderRecorder = Object.assign(
      createOrderRecorderDouble({
        fetchAllOrdersFromAPI: async () => {
          rebuildStarted.resolve(null);
          await releaseRebuild.promise;
          return [];
        },
      }),
      {
        validateRebuildSnapshot: () => {},
      },
    );
    const context = createMonitorContext({
      dailyLossTracker: {
        ...dailyLossOwner,
        prepareRecalculationFromAllOrders: (...params) => {
          dailyLossPrepareCalls += 1;
          return dailyLossOwner.prepareRecalculationFromAllOrders(...params);
        },
        publishRecalculation: (prepared) => {
          dailyLossPublishCalls += 1;
          dailyLossOwner.publishRecalculation(prepared);
        },
      },
      orderRecorder,
      riskChecker: createRiskCheckerDouble({
        publishUnrealizedLossData: () => {
          refreshUnrealizedCalls += 1;
        },
        setWarrantInfoFromCallPrice: () => {
          warrantInfoWrites += 1;
          return { status: 'ok', isWarrant: true };
        },
      }),
    });
    context.symbolRegistry.updateSeatState('LONG', {
      ...context.symbolRegistry.getSeatState('LONG'),
      symbol: 'BULL.HK',
      status: 'ACTIVATING',
      callPrice: '20000',
    });
    const updateSeatState = context.symbolRegistry.updateSeatState;
    context.symbolRegistry.updateSeatState = (direction, nextState) => {
      if (direction === 'LONG' && nextState.status === 'ACTIVE') {
        activationWrites += 1;
      }

      return updateSeatState(direction, nextState);
    };

    const processor = await createBusinessProcessor({
      queue,
      context,
      trader: createTraderDouble({
        getAccountSnapshot: async () => {
          accountSnapshotCalls += 1;
          return createAccountSnapshotDouble('100000');
        },
        getStockPositions: async () => {
          stockPositionCalls += 1;
          return [];
        },
      }),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () => new Map([['BULL.HK', createQuoteDouble('BULL.HK', '1.1', 100)]]),
      }),
    });

    processor.start();
    scheduleSeatRefreshTask(queue, 'SEAT_REFRESH:LONG:STALE_DURING_REBUILD');
    await rebuildStarted.promise;

    const latestSeat = context.symbolRegistry.getSeatState('LONG');
    context.symbolRegistry.updateSeatStateWithVersionBump('LONG', {
      ...latestSeat,
      symbol: 'NEXT_BULL.HK',
      status: 'SWITCHING',
      lastSwitchAt: Date.now(),
      callPrice: null,
    });
    releaseRebuild.resolve(null);
    await processor.stopAndDrain();

    expect(dailyLossPrepareCalls).toBe(0);
    expect(dailyLossPublishCalls).toBe(0);
    expect(accountSnapshotCalls).toBe(0);
    expect(stockPositionCalls).toBe(0);
    expect(refreshUnrealizedCalls).toBe(0);
    expect(warrantInfoWrites).toBe(0);
    expect(activationWrites).toBe(0);
    expect(processor.snapshot.getView().account?.totalCash).toBe('100000');
    expect(processor.snapshot.getView().positions).toEqual([]);
    expect(context.symbolRegistry.getSeatState('LONG')).toMatchObject({
      symbol: 'NEXT_BULL.HK',
      status: 'SWITCHING',
    });
  });

  it('skips SEAT_REFRESH risk and seat-owned writes when the seat changes during account cache refresh', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const accountRefreshStarted = createDeferred<null>();
    const releaseAccountRefresh = createDeferred<null>();
    let riskRefreshCalls = 0;
    let clearBuyOrdersCalls = 0;
    let warrantInfoWrites = 0;
    let activationWrites = 0;
    const orderRecorder = createOrderRecorderDouble({
      fetchAllOrdersFromAPI: async () => [],
      commitRebuildSnapshot: (_targets, _orders, isCurrent, mode) => {
        expect(mode).toBe('ACTIVATION');
        return isCurrent() ? { status: 'COMMITTED', receipts: [] } : { status: 'ABORTED' };
      },
      clearBuyOrders: () => {
        clearBuyOrdersCalls += 1;
      },
    });
    const context = createMonitorContext({
      orderRecorder,
      riskChecker: createRiskCheckerDouble({
        publishUnrealizedLossData: () => {
          riskRefreshCalls += 1;
        },
        setWarrantInfoFromCallPrice: () => {
          warrantInfoWrites += 1;
          return { status: 'ok', isWarrant: true };
        },
      }),
    });
    context.symbolRegistry.updateSeatState('LONG', {
      ...context.symbolRegistry.getSeatState('LONG'),
      symbol: 'BULL.HK',
      status: 'ACTIVATING',
      callPrice: '20000',
    });
    const updateSeatState = context.symbolRegistry.updateSeatState;
    context.symbolRegistry.updateSeatState = (direction, nextState) => {
      if (direction === 'LONG' && nextState.status === 'ACTIVE') {
        activationWrites += 1;
      }

      return updateSeatState(direction, nextState);
    };

    const processor = await createBusinessProcessor({
      queue,
      context,
      trader: createTraderDouble({
        getAccountSnapshot: async () => {
          accountRefreshStarted.resolve(null);
          await releaseAccountRefresh.promise;
          return createAccountSnapshotDouble('100000');
        },
        getStockPositions: async () => [],
      }),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () =>
          new Map([
            ['BULL.HK', createQuoteDouble('BULL.HK', '1.1', 100)],
            ['OLD_BULL.HK', createQuoteDouble('OLD_BULL.HK', '1', 100)],
          ]),
      }),
    });

    processor.start();
    scheduleSeatRefreshTask(queue, 'SEAT_REFRESH:LONG:STALE_DURING_ACCOUNT_REFRESH');
    await accountRefreshStarted.promise;

    const latestSeat = context.symbolRegistry.getSeatState('LONG');
    context.symbolRegistry.updateSeatStateWithVersionBump('LONG', {
      ...latestSeat,
      symbol: 'NEXT_BULL.HK',
      status: 'SWITCHING',
      lastSwitchAt: Date.now(),
      callPrice: null,
    });
    releaseAccountRefresh.resolve(null);
    await processor.stopAndDrain();

    expect(riskRefreshCalls).toBe(0);
    expect(clearBuyOrdersCalls).toBe(0);
    expect(warrantInfoWrites).toBe(0);
    expect(activationWrites).toBe(0);
    expect(context.symbolRegistry.getSeatState('LONG')).toMatchObject({
      symbol: 'NEXT_BULL.HK',
      status: 'SWITCHING',
    });
  });

  it('skips SEAT_REFRESH post-risk writes when the seat changes during risk refresh', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const riskRefreshStarted = createDeferred<null>();
    const releaseRiskRefresh = createDeferred<null>();
    let clearBuyOrdersCalls = 0;
    let warrantInfoWrites = 0;
    let activationWrites = 0;
    const orderRecorder = createOrderRecorderDouble({
      fetchAllOrdersFromAPI: async () => [],
      commitRebuildSnapshot: (_targets, _orders, isCurrent, mode) => {
        expect(mode).toBe('ACTIVATION');
        return isCurrent() ? { status: 'COMMITTED', receipts: [] } : { status: 'ABORTED' };
      },
      clearBuyOrders: () => {
        clearBuyOrdersCalls += 1;
      },
    });
    const context = createMonitorContext({
      orderRecorder,
      riskChecker: createRiskCheckerDouble({
        publishUnrealizedLossData: () => {
          throw new Error('obsolete prepared risk must not publish');
        },
        setWarrantInfoFromCallPrice: () => {
          warrantInfoWrites += 1;
          return { status: 'ok', isWarrant: true };
        },
      }),
    });
    context.symbolRegistry.updateSeatState('LONG', {
      ...context.symbolRegistry.getSeatState('LONG'),
      symbol: 'BULL.HK',
      status: 'ACTIVATING',
      callPrice: '20000',
    });
    const updateSeatState = context.symbolRegistry.updateSeatState;
    context.symbolRegistry.updateSeatState = (direction, nextState) => {
      if (direction === 'LONG' && nextState.status === 'ACTIVE') {
        activationWrites += 1;
      }

      return updateSeatState(direction, nextState);
    };

    const processor = await createBusinessProcessor({
      queue,
      context,
      quoteSubscriptionRuntime: createQuoteSubscriptionRuntimeDouble({
        reconcilePositionHoldFromCurrentTruth: async (token) => {
          expect(token).toEqual(processor.snapshot.getView().token);
          riskRefreshStarted.resolve(null);
          await releaseRiskRefresh.promise;
        },
      }),
      trader: createTraderDouble({
        getAccountSnapshot: async () => createAccountSnapshotDouble('100000'),
        getStockPositions: async () => [],
      }),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () =>
          new Map([
            ['BULL.HK', createQuoteDouble('BULL.HK', '1.1', 100)],
            ['OLD_BULL.HK', createQuoteDouble('OLD_BULL.HK', '1', 100)],
          ]),
      }),
    });

    processor.start();
    scheduleSeatRefreshTask(queue, 'SEAT_REFRESH:LONG:STALE_DURING_RISK_REFRESH');
    await riskRefreshStarted.promise;

    const latestSeat = context.symbolRegistry.getSeatState('LONG');
    context.symbolRegistry.updateSeatStateWithVersionBump('LONG', {
      ...latestSeat,
      symbol: 'NEXT_BULL.HK',
      status: 'SWITCHING',
      lastSwitchAt: Date.now(),
      callPrice: null,
    });
    releaseRiskRefresh.resolve(null);
    await processor.stopAndDrain();

    expect(clearBuyOrdersCalls).toBe(0);
    expect(warrantInfoWrites).toBe(0);
    expect(activationWrites).toBe(0);
    expect(context.symbolRegistry.getSeatState('LONG')).toMatchObject({
      symbol: 'NEXT_BULL.HK',
      status: 'SWITCHING',
    });
  });

  it('skips SEAT_REFRESH final activation when seat snapshot changes during refresh', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const context = createMonitorContext();
    context.symbolRegistry.updateSeatState('LONG', {
      ...context.symbolRegistry.getSeatState('LONG'),
      symbol: 'BULL.HK',
      status: 'ACTIVATING',
      callPrice: '20000',
    });

    context.riskChecker.prepareUnrealizedLossData = (_recorder, symbol) => {
      const latestSeat = context.symbolRegistry.getSeatState('LONG');
      context.symbolRegistry.updateSeatStateWithVersionBump('LONG', {
        ...latestSeat,
        symbol: 'NEXT_BULL.HK',
        status: 'SWITCHING',
        lastSwitchAt: Date.now(),
        callPrice: null,
      });
      return { symbol, data: { r1: '0', n1: 0 } };
    };

    const processor = await createBusinessProcessor({
      queue,
      context,
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () =>
          new Map([
            ['BULL.HK', createQuoteDouble('BULL.HK', '1.1', 100)],
            ['OLD_BULL.HK', createQuoteDouble('OLD_BULL.HK', '1', 100)],
          ]),
      }),
    });

    await runProcessorFlow({
      processor,
      pushTask: () => {
        scheduleSeatRefreshTask(queue, 'SEAT_REFRESH:LONG:STALE_DURING_REFRESH');
      },
      waitCondition: () => queue.isEmpty(),
      timeoutMs: 500,
    });

    expect(context.symbolRegistry.getSeatVersion('LONG')).toBe(3);
    expect(context.symbolRegistry.getSeatState('LONG')).toMatchObject({
      symbol: 'NEXT_BULL.HK',
      status: 'SWITCHING',
    });
  });
});

describe('SEAT_REFRESH retry identity', () => {
  it('stop 后同 key 新激活重试不会被旧取消 callback 删除或消费', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const context = createMonitorContext();
    const callbacks: Array<() => void> = [];
    const failure = await createExternalApiRequestError({
      operation: 'QuoteContext.realtimeQuote',
      attempts: 1,
      cause: new Error('network'),
    });
    context.symbolRegistry.updateSeatState('LONG', {
      ...context.symbolRegistry.getSeatState('LONG'),
      symbol: 'BULL.HK',
      status: 'ACTIVATING',
      callPrice: '20000',
    });
    const processor = await createBusinessProcessor({
      queue,
      context,
      scheduler: {
        scheduleTimer: (callback) => {
          callbacks.push(callback);
          const handle = setTimeout(() => {}, 0);
          clearTimeout(handle);
          return handle;
        },
        clearTimer: () => {},
      },
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () => {
          throw failure;
        },
      }),
    });
    processor.start();
    scheduleSeatRefreshTask(queue, 'SEAT_REFRESH:LONG:IDENTITY');
    await waitUntil(() => callbacks.length === 1);
    await processor.stopAndDrain();
    processor.start();
    scheduleSeatRefreshTask(queue, 'SEAT_REFRESH:LONG:IDENTITY');
    await waitUntil(() => callbacks.length === 2);
    callbacks[0]?.();
    expect(queue.isEmpty()).toBe(true);
    expect(context.symbolRegistry.getSeatState('LONG').status).toBe('ACTIVATING');
    callbacks[1]?.();
    await waitUntil(() => context.symbolRegistry.getSeatState('LONG').status === 'EMPTY');
    await processor.stopAndDrain();
    expect(callbacks).toHaveLength(2);
  });
});
