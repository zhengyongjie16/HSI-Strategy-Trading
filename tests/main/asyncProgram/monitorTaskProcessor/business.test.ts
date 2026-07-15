/**
 * monitorTaskProcessor 业务测试
 *
 * 功能：
 * - 验证监控任务处理器相关场景意图、边界条件与业务期望。
 */
import { describe, expect, it } from 'bun:test';
import { OrderSide, OrderStatus, OrderType } from 'longbridge';

import { createMonitorTaskProcessor } from '../../../../src/main/asyncProgram/monitorTaskProcessor/index.js';
import { createExternalApiRequestError } from '../../../../src/utils/apiFailure/index.js';
import { API } from '../../../../src/constants/index.js';
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
import type { MonitorTask } from '../../../../src/main/asyncProgram/monitorTaskQueue/types.js';
import type { RawOrderFromAPI } from '../../../../src/types/services.js';
import {
  createAccountSnapshotDouble,
  createDailyLossTrackerDouble,
  createMarketDataClientDouble,
  createOrderRecorderDouble,
  createPositionDouble,
  createQuoteSubscriptionRuntimeDouble,
  createQuoteDouble,
  createRiskCheckerDouble,
  createTraderDouble,
} from '../../../helpers/testDoubles.js';
import { createLastState, createMonitorContext, runProcessorFlow, waitUntil } from '../utils.js';
import type { CreateBusinessProcessorParams } from '../types.js';

function createStatusCollector(
  statuses: MonitorTaskStatus[],
): NonNullable<MonitorTaskProcessorDeps['onProcessed']> {
  return function collectStatus(
    _task: MonitorTask<MonitorTaskDataMap>,
    status: MonitorTaskStatus,
  ): void {
    statuses.push(status);
  };
}

function createBusinessProcessor(
  params: CreateBusinessProcessorParams,
): ReturnType<typeof createMonitorTaskProcessor> {
  const {
    queue,
    context,
    lastState = createLastState(),
    trader,
    marketDataClient = createMarketDataClientDouble(),
    quoteSubscriptionRuntime = createQuoteSubscriptionRuntimeDouble(),
    onProcessed,
    getCanProcessTask,
    getCanTradeNow = () => true,
    periodicSwitchWakeupRuntime = {
      markWaitingEmpty: () => {},
      clearWaitingEmpty: () => {},
      replanRouteAfterTask: () => {},
    },
    onFatalError,
  } = params;
  const resolvedTrader = {
    ...(trader ?? createTraderDouble()),
    orderRecorder: context.orderRecorder,
  };

  return createMonitorTaskProcessor({
    monitorTaskQueue: queue,
    monitorContext: context,
    trader: resolvedTrader,
    marketDataClient,
    quoteSubscriptionRuntime,
    switchWakeupRuntime: {
      handoffPendingSwitch: () => {},
    },
    lastState,
    getCanTradeNow,
    periodicSwitchWakeupRuntime,
    ...(onProcessed ? { onProcessed } : {}),
    ...(getCanProcessTask ? { getCanProcessTask } : {}),
    ...(onFatalError ? { onFatalError } : {}),
  });
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
      direction: 'LONG',
      seatVersion: 2,
      previousSymbol: 'OLD_BULL.HK',
      nextSymbol: 'BULL.HK',
      callPrice: 20_000,
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
    const context = createMonitorContext({
      autoSymbolManager: {
        maybeSearchOnEvent: async () => {},
        evaluatePeriodicSwitchDue: async (params) => {
          const currentSeat = context.symbolRegistry.getSeatState(params.direction);
          if (currentSeat.status !== 'ACTIVE' || currentSeat.lastSeatActivatedAt === null) {
            throw new Error('expected runtime ACTIVE seat');
          }

          context.symbolRegistry.updateSeatStateWithVersionBump(params.direction, currentSeat);
          return {
            kind: 'WAIT',
            wakeups: [{ kind: 'ORDER_EVENT', symbols: ['BULL.HK'] }],
            pendingDirection: params.direction,
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
          pendingSinceMs: null,
        }),
        resetAllState: () => {},
      },
    });
    const statuses: MonitorTaskStatus[] = [];

    const processor = createMonitorTaskProcessor({
      monitorTaskQueue: queue,
      monitorContext: context,
      trader: createTraderDouble(),
      marketDataClient: createMarketDataClientDouble(),
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
      lastState: createLastState(),
      getCanTradeNow: () => true,
      onProcessed: createStatusCollector(statuses),
    });

    await runProcessorFlow({
      processor,
      pushTask: () => {
        queue.scheduleLatest({
          type: 'AUTO_SYMBOL_TICK',
          dedupeKey: 'AUTO_SYMBOL_TICK:LONG:WAKEUP',
          data: {
            direction: 'LONG',
            seatVersion: 2,
            symbol: 'BULL.HK',
            lastSeatActivatedAt: 12_000,
            currentTimeMs: Date.now(),
          },
        });
      },
      waitCondition: () => statuses.length === 1,
      timeoutMs: 500,
    });

    expect(statuses).toEqual(['processed']);
    expect(handoffCalls).toEqual([
      {
        direction: 'LONG',
        seatVersion: 3,
        driveKind: 'WAIT',
      },
    ]);
  });

  it('API 错误标记为普通任务失败且不进入 fatal 通道', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const statuses: MonitorTaskStatus[] = [];
    const fatalErrors: unknown[] = [];
    const context = createMonitorContext({
      autoSymbolManager: {
        maybeSearchOnEvent: async () => {},
        evaluatePeriodicSwitchDue: async () => {
          throw createExternalApiRequestError({
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
          pendingSinceMs: null,
        }),
        resetAllState: () => {},
      },
    });
    const processor = createMonitorTaskProcessor({
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
      lastState: createLastState(),
      getCanTradeNow: () => true,
      onFatalError: (error) => {
        fatalErrors.push(error);
      },
      onProcessed: createStatusCollector(statuses),
    });

    await runProcessorFlow({
      processor,
      pushTask: () => {
        queue.scheduleLatest({
          type: 'AUTO_SYMBOL_TICK',
          dedupeKey: 'AUTO_SYMBOL_TICK:LONG:API_FAIL',
          data: {
            direction: 'LONG',
            seatVersion: 2,
            symbol: 'BULL.HK',
            lastSeatActivatedAt: 12_000,
            currentTimeMs: Date.now(),
          },
        });
      },
      waitCondition: () => statuses.length === 1,
      timeoutMs: 500,
    });

    expect(statuses).toEqual(['failed']);
    expect(fatalErrors).toEqual([]);
  });

  it('非 API 程序错误进入 fatal 通道且不标记为普通任务失败', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const statuses: MonitorTaskStatus[] = [];
    const fatalErrors: unknown[] = [];
    const context = createMonitorContext({
      autoSymbolManager: {
        maybeSearchOnEvent: async () => {},
        evaluatePeriodicSwitchDue: async () => {
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
          pendingSinceMs: null,
        }),
        resetAllState: () => {},
      },
    });
    const processor = createMonitorTaskProcessor({
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
      lastState: createLastState(),
      getCanTradeNow: () => true,
      onFatalError: (error) => {
        fatalErrors.push(error);
      },
      onProcessed: createStatusCollector(statuses),
    });

    await runProcessorFlow({
      processor,
      pushTask: () => {
        queue.scheduleLatest({
          type: 'AUTO_SYMBOL_TICK',
          dedupeKey: 'AUTO_SYMBOL_TICK:LONG:FATAL',
          data: {
            direction: 'LONG',
            seatVersion: 2,
            symbol: 'BULL.HK',
            lastSeatActivatedAt: 12_000,
            currentTimeMs: Date.now(),
          },
        });
      },
      waitCondition: () => fatalErrors.length === 1 || statuses.length === 1,
      timeoutMs: 500,
    });

    expect(fatalErrors).toHaveLength(1);
    expect(fatalErrors[0]).toBeInstanceOf(TypeError);
    expect(statuses).toEqual([]);
  });

  it('processes AUTO_SYMBOL_TICK with valid seat snapshot', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    let maybeSearchCalls = 0;
    const intervalCallArgs: Array<{
      direction: 'LONG' | 'SHORT';
      currentTime: Date;
      canContinue: () => boolean;
    }> = [];

    const context = createMonitorContext({
      autoSymbolManager: {
        maybeSearchOnEvent: async () => {
          maybeSearchCalls += 1;
        },
        evaluatePeriodicSwitchDue: async (params) => {
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
          pendingSinceMs: null,
        }),
        resetAllState: () => {},
      },
    });
    const statuses: MonitorTaskStatus[] = [];

    const processor = createBusinessProcessor({
      queue,
      context,
      onProcessed: createStatusCollector(statuses),
    });

    await runProcessorFlow({
      processor,
      pushTask: () => {
        queue.scheduleLatest({
          type: 'AUTO_SYMBOL_TICK',
          dedupeKey: 'AUTO_SYMBOL_TICK:LONG',
          data: {
            direction: 'LONG',
            seatVersion: 2,
            symbol: 'BULL.HK',
            lastSeatActivatedAt: 12_000,
            currentTimeMs: Date.now(),
          },
        });
      },
      waitCondition: () => statuses.length === 1,
      timeoutMs: 500,
    });

    expect(maybeSearchCalls).toBe(0);
    expect(intervalCallArgs).toHaveLength(1);
    expect(intervalCallArgs[0]?.direction).toBe('LONG');
    expect(intervalCallArgs[0]?.canContinue()).toBeTrue();
    expect(intervalCallArgs[0]?.currentTime.getTime()).toBeGreaterThan(0);
    expect(statuses).toEqual(['processed']);
  });

  it('blocks AUTO_SYMBOL_TICK switch flow outside ordinary trade gate', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const intervalCallArgs: Array<{
      direction: 'LONG' | 'SHORT';
      currentTime: Date;
      canContinue: () => boolean;
    }> = [];

    const context = createMonitorContext({
      autoSymbolManager: {
        maybeSearchOnEvent: async () => {},
        evaluatePeriodicSwitchDue: async (params) => {
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
          pendingSinceMs: null,
        }),
        resetAllState: () => {},
      },
    });
    const statuses: MonitorTaskStatus[] = [];

    const processor = createBusinessProcessor({
      queue,
      context,
      getCanTradeNow: () => false,
      onProcessed: createStatusCollector(statuses),
    });

    await runProcessorFlow({
      processor,
      pushTask: () => {
        queue.scheduleLatest({
          type: 'AUTO_SYMBOL_TICK',
          dedupeKey: 'AUTO_SYMBOL_TICK:LONG:CURRENT_GATE',
          data: {
            direction: 'LONG',
            seatVersion: 2,
            symbol: 'BULL.HK',
            lastSeatActivatedAt: 12_000,
            currentTimeMs: Date.now(),
          },
        });
      },
      waitCondition: () => statuses.length === 1,
      timeoutMs: 500,
    });

    expect(intervalCallArgs).toHaveLength(0);
    expect(statuses).toEqual(['blocked']);
  });

  it('does not hand off or replan AUTO_SYMBOL_TICK after takeover begins during periodic evaluation', async () => {
    const beforeTakeoverMs = Date.parse('2026-02-16T07:54:59.000Z');
    const takeoverMs = Date.parse('2026-02-16T07:55:00.000Z');
    let currentNowMs = beforeTakeoverMs;
    const periodicEvaluationStarted = createDeferred<null>();
    const releasePeriodicEvaluation = createDeferred<null>();
    const handoffCalls: string[] = [];
    const periodicWakeupCalls: string[] = [];
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const statuses: MonitorTaskStatus[] = [];
    const context = createMonitorContext({
      autoSymbolManager: {
        maybeSearchOnEvent: async () => {},
        evaluatePeriodicSwitchDue: async () => {
          periodicEvaluationStarted.resolve(null);
          await releasePeriodicEvaluation.promise;
          return {
            kind: 'WAIT',
            wakeups: [{ kind: 'ORDER_EVENT', symbols: ['BULL.HK'] }],
          };
        },
        startSwitchOnDistance: async (params) => ({
          started: false,
          direction: params.direction,
          driveResult: { kind: 'NOOP' },
        }),
        advancePendingSwitch: async (params) => ({
          advanced: false,
          direction: params.direction,
          stillPending: false,
          driveResult: { kind: 'NOOP' },
        }),
        hasPendingSwitch: () => true,
        getPeriodicSwitchPendingState: () => ({ pending: false, pendingSinceMs: null }),
        resetAllState: () => {},
      },
    });
    const processor = createMonitorTaskProcessor({
      monitorTaskQueue: queue,
      monitorContext: context,
      trader: createTraderDouble(),
      marketDataClient: createMarketDataClientDouble(),
      quoteSubscriptionRuntime: createQuoteSubscriptionRuntimeDouble(),
      switchWakeupRuntime: {
        handoffPendingSwitch: () => {
          handoffCalls.push('handoff');
        },
      },
      periodicSwitchWakeupRuntime: {
        markWaitingEmpty: () => {
          periodicWakeupCalls.push('mark');
        },
        clearWaitingEmpty: () => {
          periodicWakeupCalls.push('clear');
        },
        replanRouteAfterTask: () => {
          periodicWakeupCalls.push('replan');
        },
      },
      lastState: createLastState(),
      getCanTradeNow: () => currentNowMs < takeoverMs,
      onProcessed: createStatusCollector(statuses),
    });

    processor.start();
    queue.scheduleLatest({
      type: 'AUTO_SYMBOL_TICK',
      dedupeKey: 'AUTO_SYMBOL_TICK:LONG:TAKEOVER',
      data: {
        direction: 'LONG',
        seatVersion: 2,
        symbol: 'BULL.HK',
        lastSeatActivatedAt: 12_000,
        currentTimeMs: beforeTakeoverMs,
      },
    });

    await periodicEvaluationStarted.promise;
    currentNowMs = takeoverMs;
    releasePeriodicEvaluation.resolve(null);
    await waitUntil(() => statuses.length === 1, 500);
    await processor.stopAndDrain();

    expect(statuses).toEqual(['blocked']);
    expect(handoffCalls).toEqual([]);
    expect(periodicWakeupCalls).toEqual([]);
  });

  it('marks periodic route waiting-empty when AUTO_SYMBOL_TICK leaves periodic pending state', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const markCalls: Array<{
      direction: 'LONG' | 'SHORT';
      symbol: string;
      seatVersion: number;
      lastSeatActivatedAt: number;
    }> = [];
    const context = createMonitorContext({
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
          pendingSinceMs: 50_000,
          blockedBy: 'ORDER_RECORDER',
        }),
        resetAllState: () => {},
      },
    });
    const statuses: MonitorTaskStatus[] = [];

    const processor = createBusinessProcessor({
      queue,
      context,
      periodicSwitchWakeupRuntime: {
        markWaitingEmpty: (baseline) => {
          markCalls.push(baseline);
        },
        clearWaitingEmpty: () => {},
        replanRouteAfterTask: () => {},
      },
      onProcessed: createStatusCollector(statuses),
    });

    await runProcessorFlow({
      processor,
      pushTask: () => {
        queue.scheduleLatest({
          type: 'AUTO_SYMBOL_TICK',
          dedupeKey: 'AUTO_SYMBOL_TICK:LONG:PERIODIC_PENDING',
          data: {
            direction: 'LONG',
            seatVersion: 2,
            symbol: 'BULL.HK',
            lastSeatActivatedAt: 12_000,
            currentTimeMs: 70_000,
          },
        });
      },
      waitCondition: () => statuses.length === 1,
      timeoutMs: 500,
    });

    expect(statuses).toEqual(['processed']);
    expect(markCalls).toEqual([
      {
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
    const context = createMonitorContext({
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
          pendingSinceMs: null,
        }),
        resetAllState: () => {},
      },
    });
    const statuses: MonitorTaskStatus[] = [];

    const processor = createBusinessProcessor({
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
      onProcessed: createStatusCollector(statuses),
    });

    await runProcessorFlow({
      processor,
      pushTask: () => {
        queue.scheduleLatest({
          type: 'AUTO_SYMBOL_TICK',
          dedupeKey: 'AUTO_SYMBOL_TICK:LONG:PERIODIC_REPLAN',
          data: {
            direction: 'LONG',
            seatVersion: 2,
            symbol: 'BULL.HK',
            lastSeatActivatedAt: 12_000,
            currentTimeMs: 70_000,
          },
        });
      },
      waitCondition: () => statuses.length === 1,
      timeoutMs: 500,
    });

    expect(statuses).toEqual(['processed']);
    expect(clearCalls).toEqual([
      {
        direction: 'LONG',
        symbol: 'BULL.HK',
        seatVersion: 2,
        lastSeatActivatedAt: 12_000,
      },
    ]);

    expect(replanCalls).toEqual([
      {
        direction: 'LONG',
        symbol: 'BULL.HK',
        seatVersion: 2,
        lastSeatActivatedAt: 12_000,
        taskTimeMs: 70_000,
        status: 'processed',
      },
    ]);
  });

  it('returns blocked without replanning periodic route outside ordinary trade gate', async () => {
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
    const context = createMonitorContext({
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
          pendingSinceMs: null,
        }),
        resetAllState: () => {},
      },
    });
    const statuses: MonitorTaskStatus[] = [];

    const processor = createBusinessProcessor({
      queue,
      context,
      getCanTradeNow: () => false,
      periodicSwitchWakeupRuntime: {
        markWaitingEmpty: () => {},
        clearWaitingEmpty: () => {
          clearCalls.push('clear');
        },
        replanRouteAfterTask: (params) => {
          replanCalls.push(params);
        },
      },
      onProcessed: createStatusCollector(statuses),
    });

    await runProcessorFlow({
      processor,
      pushTask: () => {
        queue.scheduleLatest({
          type: 'AUTO_SYMBOL_TICK',
          dedupeKey: 'AUTO_SYMBOL_TICK:LONG:PERIODIC_GATE_CLOSED',
          data: {
            direction: 'LONG',
            seatVersion: 2,
            symbol: 'BULL.HK',
            lastSeatActivatedAt: 12_000,
            currentTimeMs: 70_000,
          },
        });
      },
      waitCondition: () => statuses.length === 1,
      timeoutMs: 500,
    });

    expect(statuses).toEqual(['blocked']);
    expect(periodicDueCalls).toBe(0);
    expect(clearCalls).toEqual([]);
    expect(replanCalls).toEqual([]);
  });

  it('skips AUTO_SYMBOL_TICK when seat snapshot is stale', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    let maybeSearchCalls = 0;

    const context = createMonitorContext({
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
          pendingSinceMs: null,
        }),
        resetAllState: () => {},
      },
    });
    const statuses: MonitorTaskStatus[] = [];

    const processor = createBusinessProcessor({
      queue,
      context,
      onProcessed: createStatusCollector(statuses),
    });

    await runProcessorFlow({
      processor,
      pushTask: () => {
        queue.scheduleLatest({
          type: 'AUTO_SYMBOL_TICK',
          dedupeKey: 'AUTO_SYMBOL_TICK:LONG',
          data: {
            direction: 'LONG',
            seatVersion: 1,
            symbol: 'BULL.HK',
            lastSeatActivatedAt: 12_000,
            currentTimeMs: Date.now(),
          },
        });
      },
      waitCondition: () => statuses.length === 1,
      timeoutMs: 500,
    });

    expect(maybeSearchCalls).toBe(0);
    expect(statuses).toEqual(['skipped']);
  });

  it('skips AUTO_SYMBOL_TICK when seat activation baseline is stale', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    let periodicDueCalls = 0;

    const context = createMonitorContext({
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
          pendingSinceMs: null,
        }),
        resetAllState: () => {},
      },
    });
    const statuses: MonitorTaskStatus[] = [];

    const processor = createBusinessProcessor({
      queue,
      context,
      onProcessed: createStatusCollector(statuses),
    });

    await runProcessorFlow({
      processor,
      pushTask: () => {
        queue.scheduleLatest({
          type: 'AUTO_SYMBOL_TICK',
          dedupeKey: 'AUTO_SYMBOL_TICK:LONG:STALE_ACTIVATION',
          data: {
            direction: 'LONG',
            seatVersion: 2,
            symbol: 'BULL.HK',
            lastSeatActivatedAt: 13_000,
            currentTimeMs: Date.now(),
          },
        });
      },
      waitCondition: () => statuses.length === 1,
      timeoutMs: 500,
    });

    expect(periodicDueCalls).toBe(0);
    expect(statuses).toEqual(['skipped']);
  });

  it('skips stale SEAT_REFRESH when seatVersion no longer matches', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const statuses: MonitorTaskStatus[] = [];
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
      callPrice: 20_000,
    });

    const processor = createBusinessProcessor({
      queue,
      context,
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () => {
          getQuotesCalls += 1;
          return new Map();
        },
      }),
      onProcessed: createStatusCollector(statuses),
    });

    await runProcessorFlow({
      processor,
      pushTask: () => {
        scheduleSeatRefreshTask(queue, 'SEAT_REFRESH:LONG:STALE_VERSION', {
          seatVersion: 1,
        });
      },
      waitCondition: () => statuses.length === 1,
      timeoutMs: 500,
    });

    expect(statuses).toEqual(['skipped']);
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

    const context = createMonitorContext({
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
          pendingSinceMs: null,
        }),
        resetAllState: () => {},
      },
    });

    const seen: Array<{
      task: MonitorTask<MonitorTaskDataMap>;
      status: MonitorTaskStatus;
    }> = [];

    const processor = createBusinessProcessor({
      queue,
      context,
      getCanProcessTask: () => false,
      onProcessed: (task, status) => {
        seen.push({ task, status });
      },
    });

    await runProcessorFlow({
      processor,
      pushTask: () => {
        queue.scheduleLatest({
          type: 'AUTO_SYMBOL_TICK',
          dedupeKey: 'AUTO_SYMBOL_TICK:LONG:GATE',
          data: {
            direction: 'LONG',
            seatVersion: 2,
            symbol: 'BULL.HK',
            lastSeatActivatedAt: 12_000,
            currentTimeMs: Date.now(),
          },
        });
      },
      waitCondition: () => seen.length === 1,
      timeoutMs: 500,
    });

    expect(seen[0]?.status).toBe('skipped');
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
    let recalculateCalls = 0;
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
        refreshOrdersFromAllOrdersForLong: async (symbol, snapshot, quote) => {
          refreshOrdersCalls += 1;
          rebuildSteps.push('refresh');
          rebuildSnapshots.push(snapshot);
          expect(symbol).toBe('BULL.HK');
          expect(quote?.price).toBe(1.1);
          return [];
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
        resetAll: () => {},
        recalculateFromAllOrders: (
          _snapshot,
          _monitor,
          _now,
          _boundaries,
          relatedTradingSymbols,
        ) => {
          recalculateCalls += 1;
          rebuildSteps.push('daily-loss');
          rebuildSnapshots.push(_snapshot);
          dailyLossRelatedTradingSymbols = relatedTradingSymbols;
        },
        recordCumulativeExecution: () => ({
          authoritativeFactChanged: false,
          executionAdvanced: false,
        }),
        getLossOffset: () => 0,
        prepareProtectionBoundary: (params) => ({ ...params, orderBaselines: [] }),
        commitProtectionBoundary: () => {},
        restoreExecutionSnapshot: () => {},
        restoreProtectionBoundary: () => {},
      },
      riskChecker: createRiskCheckerDouble({
        refreshUnrealizedLossData: async () => {
          refreshUnrealizedCalls += 1;
          return { r1: 100, n1: 100 };
        },
      }),
    });
    context.symbolRegistry.updateSeatState('LONG', {
      ...context.symbolRegistry.getSeatState('LONG'),
      symbol: 'BULL.HK',
      status: 'ACTIVATING',
      callPrice: 20_000,
    });
    const statuses: MonitorTaskStatus[] = [];
    const lastState = createLastState();

    const processor = createBusinessProcessor({
      queue,
      context,
      lastState,
      trader: createTraderDouble({
        getAccountSnapshot: async () => {
          accountSnapshotCalls += 1;
          return createAccountSnapshotDouble(200_000);
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
            ['BULL.HK', { ...createQuoteDouble('BULL.HK', 1.1, 100), name: 'BULL Name' }],
          ]);
        },
      }),
      onProcessed: createStatusCollector(statuses),
    });

    await runProcessorFlow({
      processor,
      pushTask: () => {
        scheduleSeatRefreshTask(queue, 'SEAT_REFRESH:LONG');
      },
      waitCondition: () => statuses.length === 1,
      timeoutMs: 500,
    });

    expect(statuses[0]).toBe('processed');
    expect(fetchAllOrdersCalls).toBe(1);
    expect(preflightCalls).toBe(expectedRelatedTradingSymbols.length);
    expect(refreshOrdersCalls).toBe(1);
    expect(recalculateCalls).toBe(1);
    expect(preflightSymbols).toEqual([...expectedRelatedTradingSymbols]);
    expect(rebuildSteps).toEqual([
      'preflight:BULL.HK',
      'preflight:OLD_BULL.HK',
      'preflight:BEAR.HK',
      'daily-loss',
      'refresh',
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
    expect(lastState.cachedAccount?.totalCash).toBe(200_000);
    expect(lastState.positionCache.get('BULL.HK')?.quantity).toBe(100);
  });

  it('fails SEAT_REFRESH fatally before cache, account, risk, or activation writes when DailyLossTracker rejects updatedAt', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const statuses: MonitorTaskStatus[] = [];
    const fatalErrors: unknown[] = [];
    let refreshOrdersCalls = 0;
    let accountSnapshotCalls = 0;
    let stockPositionCalls = 0;
    let refreshUnrealizedCalls = 0;
    let warrantInfoWrites = 0;
    let activationWrites = 0;
    const lastState = createLastState();
    const invalidExecutedOrder: RawOrderFromAPI = {
      orderId: 'seat-refresh-missing-updated-at',
      symbol: 'BULL.HK',
      stockName: 'HSI RC',
      side: OrderSide.Buy,
      status: OrderStatus.Filled,
      orderType: OrderType.ELO,
      remark: 'AUTO',
      price: 1.1,
      quantity: 100,
      executedPrice: 1.1,
      executedQuantity: 100,
      submittedAt: new Date('2026-03-13T02:00:00.000Z'),
      updatedAt: null,
    };
    const dailyLossTracker = createDailyLossTracker({
      ...createDailyLossOrderAnalysisDeps(),
      resolveOrderOwnership: (order) =>
        order.symbol === 'BULL.HK' ? { monitorSymbol: 'HSI.HK', direction: 'LONG' } : null,
      toHongKongTimeIso,
    });
    const context = createMonitorContext({
      dailyLossTracker,
      orderRecorder: createOrderRecorderDouble({
        fetchAllOrdersFromAPI: async () => [invalidExecutedOrder],
        refreshOrdersFromAllOrdersForLong: async () => {
          refreshOrdersCalls += 1;
          return [];
        },
      }),
      riskChecker: createRiskCheckerDouble({
        refreshUnrealizedLossData: async () => {
          refreshUnrealizedCalls += 1;
          return null;
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
      callPrice: 20_000,
    });
    const updateSeatState = context.symbolRegistry.updateSeatState;
    context.symbolRegistry.updateSeatState = (direction, nextState) => {
      if (direction === 'LONG' && nextState.status === 'ACTIVE') {
        activationWrites += 1;
      }

      return updateSeatState(direction, nextState);
    };

    const processor = createBusinessProcessor({
      queue,
      context,
      lastState,
      trader: createTraderDouble({
        getAccountSnapshot: async () => {
          accountSnapshotCalls += 1;
          return createAccountSnapshotDouble(100_000);
        },
        getStockPositions: async () => {
          stockPositionCalls += 1;
          return [];
        },
      }),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () =>
          new Map([
            ['BULL.HK', createQuoteDouble('BULL.HK', 1.1, 100)],
            ['OLD_BULL.HK', createQuoteDouble('OLD_BULL.HK', 1, 100)],
          ]),
      }),
      onFatalError: (error) => {
        fatalErrors.push(error);
      },
      onProcessed: createStatusCollector(statuses),
    });

    await runProcessorFlow({
      processor,
      pushTask: () => {
        scheduleSeatRefreshTask(queue, 'SEAT_REFRESH:LONG:BAD_UPDATED_AT');
      },
      waitCondition: () => fatalErrors.length === 1 || statuses.length === 1,
      timeoutMs: 500,
    });

    expect(fatalErrors).toHaveLength(1);
    const fatalError = fatalErrors[0];
    if (!(fatalError instanceof Error)) {
      throw new Error('expected DailyLossTracker failure to reach the fatal channel');
    }

    expect(fatalError.message).toContain('已成交订单缺少有效更新时间');
    expect(statuses).toEqual([]);
    expect(refreshOrdersCalls).toBe(0);
    expect(accountSnapshotCalls).toBe(0);
    expect(stockPositionCalls).toBe(0);
    expect(refreshUnrealizedCalls).toBe(0);
    expect(warrantInfoWrites).toBe(0);
    expect(activationWrites).toBe(0);
    expect(lastState.cachedAccount).toBeNull();
    expect(lastState.cachedPositions).toEqual([]);
    expect(context.symbolRegistry.getSeatState('LONG').status).toBe('ACTIVATING');
  });

  it('preflights SEAT_REFRESH before DailyLoss rejects a relevant unowned execution', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const statuses: MonitorTaskStatus[] = [];
    const fatalErrors: unknown[] = [];
    const now = new Date();
    const knownSideOrder: RawOrderFromAPI = {
      orderId: 'seat-refresh-unowned-known-side',
      symbol: 'BULL.HK',
      stockName: 'HSI RC',
      side: OrderSide.Buy,
      status: OrderStatus.Filled,
      orderType: OrderType.ELO,
      remark: 'AUTO',
      price: 1.1,
      quantity: 100,
      executedPrice: 1.1,
      executedQuantity: 100,
      submittedAt: now,
      updatedAt: now,
    };
    let preflightCalls = 0;
    const preflightSymbols: string[] = [];
    let refreshOrdersCalls = 0;
    const orderRecorder = Object.assign(
      createOrderRecorderDouble({
        fetchAllOrdersFromAPI: async () => [knownSideOrder],
        refreshOrdersFromAllOrdersForLong: async () => {
          refreshOrdersCalls += 1;
          return [];
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
    });
    context.symbolRegistry.updateSeatState('LONG', {
      ...context.symbolRegistry.getSeatState('LONG'),
      symbol: 'BULL.HK',
      status: 'ACTIVATING',
      callPrice: 20_000,
    });

    const processor = createBusinessProcessor({
      queue,
      context,
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () => new Map([['BULL.HK', createQuoteDouble('BULL.HK', 1.1, 100)]]),
      }),
      onFatalError: (error) => {
        fatalErrors.push(error);
      },
      onProcessed: createStatusCollector(statuses),
    });

    await runProcessorFlow({
      processor,
      pushTask: () => {
        scheduleSeatRefreshTask(queue, 'SEAT_REFRESH:LONG:UNOWNED_KNOWN_SIDE');
      },
      waitCondition: () => fatalErrors.length === 1 || statuses.length === 1,
      timeoutMs: 500,
    });

    const fatalError = fatalErrors[0];
    if (!(fatalError instanceof Error)) {
      throw new Error('expected DailyLossTracker ownership failure to reach the fatal channel');
    }

    expect(fatalError.message).toContain('相关成交订单无法归属');
    expect(statuses).toEqual([]);
    expect(preflightCalls).toBe(3);
    expect(preflightSymbols).toEqual(['BULL.HK', 'OLD_BULL.HK', 'BEAR.HK']);
    expect(refreshOrdersCalls).toBe(0);
  });

  it('fails SEAT_REFRESH fatally before post-refresh writes when a positive execution fact is malformed', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const statuses: MonitorTaskStatus[] = [];
    const fatalErrors: unknown[] = [];
    let refreshOrdersCalls = 0;
    let accountSnapshotCalls = 0;
    let stockPositionCalls = 0;
    let refreshUnrealizedCalls = 0;
    let warrantInfoWrites = 0;
    let activationWrites = 0;
    const lastState = createLastState();
    const malformedPositiveExecution: RawOrderFromAPI = {
      orderId: 'seat-refresh-invalid-execution-price',
      symbol: 'BULL.HK',
      stockName: 'HSI RC',
      side: OrderSide.Buy,
      status: OrderStatus.Filled,
      orderType: OrderType.ELO,
      remark: 'AUTO',
      price: 1.1,
      quantity: 100,
      executedPrice: 0,
      executedQuantity: 100,
      submittedAt: new Date('2026-03-13T02:00:00.000Z'),
      updatedAt: new Date('2026-03-13T02:01:00.000Z'),
    };
    const context = createMonitorContext({
      orderRecorder: createOrderRecorderDouble({
        fetchAllOrdersFromAPI: async () => [malformedPositiveExecution],
        refreshOrdersFromAllOrdersForLong: async (_symbol, allOrders) => {
          refreshOrdersCalls += 1;
          return classifyOrdersForRebuild(allOrders).executedBuyOrders;
        },
      }),
      riskChecker: createRiskCheckerDouble({
        refreshUnrealizedLossData: async () => {
          refreshUnrealizedCalls += 1;
          return null;
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
      callPrice: 20_000,
    });
    const updateSeatState = context.symbolRegistry.updateSeatState;
    context.symbolRegistry.updateSeatState = (direction, nextState) => {
      if (direction === 'LONG' && nextState.status === 'ACTIVE') {
        activationWrites += 1;
      }

      return updateSeatState(direction, nextState);
    };

    const processor = createBusinessProcessor({
      queue,
      context,
      lastState,
      trader: createTraderDouble({
        getAccountSnapshot: async () => {
          accountSnapshotCalls += 1;
          return createAccountSnapshotDouble(100_000);
        },
        getStockPositions: async () => {
          stockPositionCalls += 1;
          return [];
        },
      }),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () =>
          new Map([
            ['BULL.HK', createQuoteDouble('BULL.HK', 1.1, 100)],
            ['OLD_BULL.HK', createQuoteDouble('OLD_BULL.HK', 1, 100)],
          ]),
      }),
      onFatalError: (error) => {
        fatalErrors.push(error);
      },
      onProcessed: createStatusCollector(statuses),
    });

    await runProcessorFlow({
      processor,
      pushTask: () => {
        scheduleSeatRefreshTask(queue, 'SEAT_REFRESH:LONG:INVALID_EXECUTION');
      },
      waitCondition: () => fatalErrors.length === 1 || statuses.length === 1,
      timeoutMs: 500,
    });

    expect(fatalErrors).toHaveLength(1);
    const fatalError = fatalErrors[0];
    if (!(fatalError instanceof Error)) {
      throw new Error('expected malformed execution fact to reach the fatal channel');
    }

    expect(fatalError.message).toMatch(/执行事实/);
    expect(statuses).toEqual([]);
    expect(refreshOrdersCalls).toBe(1);
    expect(accountSnapshotCalls).toBe(0);
    expect(stockPositionCalls).toBe(0);
    expect(refreshUnrealizedCalls).toBe(0);
    expect(warrantInfoWrites).toBe(0);
    expect(activationWrites).toBe(0);
    expect(lastState.cachedAccount).toBeNull();
    expect(lastState.cachedPositions).toEqual([]);
    expect(context.symbolRegistry.getSeatState('LONG').status).toBe('ACTIVATING');
  });

  for (const unknownSideCase of [
    {
      label: 'Filled with positive execution',
      status: OrderStatus.Filled,
      executedPrice: 1,
      executedQuantity: 100,
    },
    {
      label: 'PartialFilled with zero execution',
      status: OrderStatus.PartialFilled,
      executedPrice: 0,
      executedQuantity: 0,
    },
  ]) {
    it(`fails SEAT_REFRESH fatally before post-refresh writes for Unknown-side ${unknownSideCase.label}`, async () => {
      const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
      const statuses: MonitorTaskStatus[] = [];
      const fatalErrors: unknown[] = [];
      let preflightCalls = 0;
      let refreshOrdersCalls = 0;
      let accountSnapshotCalls = 0;
      let stockPositionCalls = 0;
      let refreshUnrealizedCalls = 0;
      let warrantInfoWrites = 0;
      let activationWrites = 0;
      const lastState = createLastState();
      const now = new Date();
      const unknownSideOrder: RawOrderFromAPI = {
        orderId: `seat-refresh-unknown-side-${unknownSideCase.label}`,
        symbol: 'BULL.HK',
        stockName: 'HSI RC',
        side: OrderSide.Unknown,
        status: unknownSideCase.status,
        orderType: OrderType.ELO,
        remark: 'AUTO',
        price: 1.1,
        quantity: 100,
        executedPrice: unknownSideCase.executedPrice,
        executedQuantity: unknownSideCase.executedQuantity,
        submittedAt: now,
        updatedAt: now,
      };
      const dailyLossTracker = createDailyLossTracker({
        ...createDailyLossOrderAnalysisDeps(),
        resolveOrderOwnership: (order) =>
          order.symbol === 'BULL.HK' ? { monitorSymbol: 'HSI.HK', direction: 'LONG' } : null,
        toHongKongTimeIso,
      });
      const orderRecorder = Object.assign(
        createOrderRecorderDouble({
          fetchAllOrdersFromAPI: async () => [unknownSideOrder],
          refreshOrdersFromAllOrdersForLong: async (_symbol, allOrders) => {
            refreshOrdersCalls += 1;
            return classifyOrdersForRebuild(allOrders).executedBuyOrders;
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
          refreshUnrealizedLossData: async () => {
            refreshUnrealizedCalls += 1;
            return null;
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
        callPrice: 20_000,
      });
      const seedOrders: ReadonlyArray<RawOrderFromAPI> = [
        {
          ...unknownSideOrder,
          orderId: `seat-refresh-seed-buy-${unknownSideCase.label}`,
          side: OrderSide.Buy,
          status: OrderStatus.Filled,
          executedPrice: 1,
          executedQuantity: 100,
          submittedAt: new Date(now.getTime() - 2_000),
          updatedAt: new Date(now.getTime() - 2_000),
        },
        {
          ...unknownSideOrder,
          orderId: `seat-refresh-seed-sell-${unknownSideCase.label}`,
          side: OrderSide.Sell,
          status: OrderStatus.Filled,
          executedPrice: 0.9,
          executedQuantity: 100,
          submittedAt: new Date(now.getTime() - 1_000),
          updatedAt: new Date(now.getTime() - 1_000),
        },
      ];
      dailyLossTracker.recalculateFromAllOrders(
        seedOrders,
        context.config,
        now,
        undefined,
        new Set(['BULL.HK']),
      );
      expect(dailyLossTracker.getLossOffset('LONG')).toBe(-10);
      const updateSeatState = context.symbolRegistry.updateSeatState;
      context.symbolRegistry.updateSeatState = (direction, nextState) => {
        if (direction === 'LONG' && nextState.status === 'ACTIVE') {
          activationWrites += 1;
        }

        return updateSeatState(direction, nextState);
      };

      const processor = createBusinessProcessor({
        queue,
        context,
        lastState,
        trader: createTraderDouble({
          getAccountSnapshot: async () => {
            accountSnapshotCalls += 1;
            return createAccountSnapshotDouble(100_000);
          },
          getStockPositions: async () => {
            stockPositionCalls += 1;
            return [];
          },
        }),
        marketDataClient: createMarketDataClientDouble({
          getQuotes: async () =>
            new Map([
              ['BULL.HK', createQuoteDouble('BULL.HK', 1.1, 100)],
              ['OLD_BULL.HK', createQuoteDouble('OLD_BULL.HK', 1, 100)],
            ]),
        }),
        onFatalError: (error) => {
          fatalErrors.push(error);
        },
        onProcessed: createStatusCollector(statuses),
      });

      await runProcessorFlow({
        processor,
        pushTask: () => {
          scheduleSeatRefreshTask(queue, `SEAT_REFRESH:LONG:UNKNOWN_SIDE:${unknownSideCase.label}`);
        },
        waitCondition: () => fatalErrors.length === 1 || statuses.length === 1,
        timeoutMs: 500,
      });

      const fatalError = fatalErrors[0];
      const refreshWasBlocked =
        fatalError instanceof Error && fatalError.message.includes('订单方向不可归属');

      expect({
        refreshWasBlocked,
        statuses,
        preflightCalls,
        refreshOrdersCalls,
        accountSnapshotCalls,
        stockPositionCalls,
        refreshUnrealizedCalls,
        warrantInfoWrites,
        activationWrites,
        cachedAccount: lastState.cachedAccount,
        cachedPositions: lastState.cachedPositions,
        dailyLossOffset: dailyLossTracker.getLossOffset('LONG'),
        seatStatus: context.symbolRegistry.getSeatState('LONG').status,
      }).toEqual({
        refreshWasBlocked: true,
        statuses: [],
        preflightCalls: 1,
        refreshOrdersCalls: 0,
        accountSnapshotCalls: 0,
        stockPositionCalls: 0,
        refreshUnrealizedCalls: 0,
        warrantInfoWrites: 0,
        activationWrites: 0,
        cachedAccount: null,
        cachedPositions: [],
        dailyLossOffset: -10,
        seatStatus: 'ACTIVATING',
      });
    });
  }

  for (const relatedOrderCase of [
    {
      label: 'Unknown Filled execution',
      side: OrderSide.Unknown,
      status: OrderStatus.Filled,
      executedPrice: 1,
      executedQuantity: 100,
      expectedErrorFragment: '订单方向不可归属',
    },
    {
      label: 'malformed known-side execution',
      side: OrderSide.Buy,
      status: OrderStatus.Filled,
      executedPrice: 0,
      executedQuantity: 100,
      expectedErrorFragment: '执行事实',
    },
  ] as const) {
    it(`fails SEAT_REFRESH before DailyLoss writes for non-target related ${relatedOrderCase.label}`, async () => {
      const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
      const statuses: MonitorTaskStatus[] = [];
      const fatalErrors: unknown[] = [];
      const now = new Date();
      const relatedOrder: RawOrderFromAPI = {
        orderId: `seat-refresh-related-${relatedOrderCase.label}`,
        symbol: 'OLD_BULL.HK',
        stockName: 'HSI RC',
        side: relatedOrderCase.side,
        status: relatedOrderCase.status,
        orderType: OrderType.ELO,
        remark: 'AUTO',
        price: 1.1,
        quantity: 100,
        executedPrice: relatedOrderCase.executedPrice,
        executedQuantity: relatedOrderCase.executedQuantity,
        submittedAt: now,
        updatedAt: now,
      };
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
        fetchAllOrdersFromAPI: async () => [relatedOrder],
        validateRebuildSnapshot: (symbol, allOrders) => {
          preflightSymbols.push(symbol);
          classifyOrdersForRebuild(allOrders.filter((order) => order.symbol === symbol));
        },
        refreshOrdersFromAllOrdersForLong: async () => {
          refreshOrdersCalls += 1;
          return [];
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
        callPrice: 20_000,
      });
      const seedOrders: ReadonlyArray<RawOrderFromAPI> = [
        {
          ...relatedOrder,
          orderId: `seat-refresh-related-seed-buy-${relatedOrderCase.label}`,
          symbol: 'BULL.HK',
          side: OrderSide.Buy,
          status: OrderStatus.Filled,
          executedPrice: 1,
          executedQuantity: 100,
          submittedAt: new Date(now.getTime() - 2_000),
          updatedAt: new Date(now.getTime() - 2_000),
        },
        {
          ...relatedOrder,
          orderId: `seat-refresh-related-seed-sell-${relatedOrderCase.label}`,
          symbol: 'BULL.HK',
          side: OrderSide.Sell,
          status: OrderStatus.Filled,
          executedPrice: 0.9,
          executedQuantity: 100,
          submittedAt: new Date(now.getTime() - 1_000),
          updatedAt: new Date(now.getTime() - 1_000),
        },
      ];
      dailyLossTracker.recalculateFromAllOrders(
        seedOrders,
        context.config,
        now,
        undefined,
        new Set(['BULL.HK']),
      );
      expect(dailyLossTracker.getLossOffset('LONG')).toBe(-10);
      const updateSeatState = context.symbolRegistry.updateSeatState;
      context.symbolRegistry.updateSeatState = (direction, nextState) => {
        if (direction === 'LONG' && nextState.status === 'ACTIVE') {
          activationWrites += 1;
        }

        return updateSeatState(direction, nextState);
      };

      const processor = createBusinessProcessor({
        queue,
        context,
        marketDataClient: createMarketDataClientDouble({
          getQuotes: async () =>
            new Map([
              ['BULL.HK', createQuoteDouble('BULL.HK', 1.1, 100)],
              ['OLD_BULL.HK', createQuoteDouble('OLD_BULL.HK', 1, 100)],
            ]),
        }),
        onFatalError: (error) => {
          fatalErrors.push(error);
        },
        onProcessed: createStatusCollector(statuses),
      });

      await runProcessorFlow({
        processor,
        pushTask: () => {
          scheduleSeatRefreshTask(queue, `SEAT_REFRESH:LONG:RELATED:${relatedOrderCase.label}`);
        },
        waitCondition: () => fatalErrors.length === 1 || statuses.length === 1,
        timeoutMs: 500,
      });

      const fatalError = fatalErrors[0];
      const preflightBlocked =
        fatalError instanceof Error &&
        fatalError.message.includes(relatedOrderCase.expectedErrorFragment);

      expect({
        preflightBlocked,
        statuses,
        preflightSymbols,
        refreshOrdersCalls,
        dailyLossOffset: dailyLossTracker.getLossOffset('LONG'),
        activationWrites,
        seatStatus: context.symbolRegistry.getSeatState('LONG').status,
      }).toEqual({
        preflightBlocked: true,
        statuses: [],
        preflightSymbols: ['BULL.HK', 'OLD_BULL.HK'],
        refreshOrdersCalls: 0,
        dailyLossOffset: -10,
        activationWrites: 0,
        seatStatus: 'ACTIVATING',
      });
    });
  }

  it('processes SHORT SEAT_REFRESH and updates short-side symbol name', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const statuses: MonitorTaskStatus[] = [];
    let refreshOrdersCalls = 0;
    const context = createMonitorContext({
      orderRecorder: createOrderRecorderDouble({
        fetchAllOrdersFromAPI: async () => [],
        refreshOrdersFromAllOrdersForShort: async (_symbol, _allOrders, quote) => {
          refreshOrdersCalls += 1;
          expect(quote?.price).toBe(0.9);
          return [];
        },
      }),
      riskChecker: createRiskCheckerDouble({
        refreshUnrealizedLossData: async () => ({ r1: 100, n1: 100 }),
      }),
    });
    context.symbolRegistry.updateSeatState('SHORT', {
      ...context.symbolRegistry.getSeatState('SHORT'),
      symbol: 'BEAR.HK',
      status: 'ACTIVATING',
      callPrice: 20_000,
    });

    const processor = createBusinessProcessor({
      queue,
      context,
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () =>
          new Map([['BEAR.HK', { ...createQuoteDouble('BEAR.HK', 0.9, 100), name: 'BEAR Name' }]]),
      }),
      onProcessed: createStatusCollector(statuses),
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
      waitCondition: () => statuses.length === 1,
      timeoutMs: 500,
    });

    expect(statuses).toEqual(['processed']);
    expect(refreshOrdersCalls).toBe(1);
    expect(context.symbolRegistry.getSeatState('SHORT').status).toBe('ACTIVE');
    expect(context.shortSymbolName).toBe('BEAR Name');
  });

  it('marks SHORT SEAT_REFRESH business failure as EMPTY and clears short-side symbol name', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const statuses: MonitorTaskStatus[] = [];
    const context = createMonitorContext({
      shortSymbolName: 'OLD_BEAR',
    });
    context.symbolRegistry.updateSeatState('SHORT', {
      ...context.symbolRegistry.getSeatState('SHORT'),
      symbol: 'BEAR.HK',
      status: 'ACTIVATING',
      callPrice: null,
    });

    const processor = createBusinessProcessor({
      queue,
      context,
      onProcessed: createStatusCollector(statuses),
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
      waitCondition: () => statuses.length === 1,
      timeoutMs: 500,
    });

    expect(statuses).toEqual(['processed']);
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
    const statuses: MonitorTaskStatus[] = [];
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
        refreshOrdersFromAllOrdersForLong: async () => {
          refreshOrdersCalls += 1;
          return [];
        },
      }),
      riskChecker: createRiskCheckerDouble({
        refreshUnrealizedLossData: async () => {
          refreshUnrealizedCalls += 1;
          return { r1: 100, n1: 100 };
        },
      }),
    });
    context.symbolRegistry.updateSeatState('LONG', {
      ...context.symbolRegistry.getSeatState('LONG'),
      symbol: 'BULL.HK',
      status: 'ACTIVATING',
      callPrice: 20_000,
    });

    const processor = createBusinessProcessor({
      queue,
      context,
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () => {
          getQuotesCalls += 1;
          return new Map([['BULL.HK', createQuoteDouble('BULL.HK', 1.1, 100)]]);
        },
      }),
      quoteSubscriptionRuntime: createQuoteSubscriptionRuntimeDouble({
        waitForAdmission: async () => {
          admissionStartedDeferred.resolve(null);
          await admissionDeferred.promise;
        },
      }),
      onProcessed: createStatusCollector(statuses),
    });

    processor.start();
    scheduleSeatRefreshTask(queue, 'SEAT_REFRESH:LONG:ADMISSION');

    await admissionStartedDeferred.promise;
    await Promise.resolve();

    expect(statuses).toEqual([]);
    expect(getQuotesCalls).toBe(0);
    expect(fetchAllOrdersCalls).toBe(0);
    expect(refreshOrdersCalls).toBe(0);
    expect(refreshUnrealizedCalls).toBe(0);
    expect(context.symbolRegistry.getSeatState('LONG').status).toBe('ACTIVATING');

    admissionDeferred.resolve(null);
    await waitUntil(() => statuses.length === 1, 500);
    await processor.stopAndDrain();

    expect(statuses).toEqual(['processed']);
    expect(getQuotesCalls).toBe(1);
    expect(fetchAllOrdersCalls).toBe(1);
    expect(refreshOrdersCalls).toBe(1);
    expect(refreshUnrealizedCalls).toBe(1);
    expect(context.symbolRegistry.getSeatState('LONG').status).toBe('ACTIVE');
  });

  it('does not leave stale warrant risk cache after SEAT_REFRESH skips on changed seat', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const statuses: MonitorTaskStatus[] = [];
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
        refreshUnrealizedLossData: async (
          orderRecorder,
          symbol,
          isLongSymbol,
          quote,
          dailyLossOffset,
        ) => {
          const result = await baseRiskChecker.refreshUnrealizedLossData(
            orderRecorder,
            symbol,
            isLongSymbol,
            quote,
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
          return result;
        },
      },
    });
    context.symbolRegistry.updateSeatState('LONG', {
      ...context.symbolRegistry.getSeatState('LONG'),
      symbol: 'BULL.HK',
      status: 'ACTIVATING',
      callPrice: 20_000,
    });

    const processor = createBusinessProcessor({
      queue,
      context,
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () =>
          new Map([
            ['BULL.HK', createQuoteDouble('BULL.HK', 1.1, 100)],
            ['OLD_BULL.HK', createQuoteDouble('OLD_BULL.HK', 1, 100)],
          ]),
      }),
      onProcessed: createStatusCollector(statuses),
    });

    await runProcessorFlow({
      processor,
      pushTask: () => {
        scheduleSeatRefreshTask(queue, 'SEAT_REFRESH:LONG:STALE_CACHE_LEAK');
      },
      waitCondition: () => statuses.length === 1,
      timeoutMs: 500,
    });

    expect(statuses).toEqual(['skipped']);
    const riskCheckResult = context.riskChecker.checkWarrantRisk('NEXT_BULL.HK', 'BUYCALL', 20_010);
    expect(riskCheckResult.allowed).toBeTrue();
  });

  it('does not write shared refresh state when SEAT_REFRESH becomes stale before cache rebuild starts', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const statuses: MonitorTaskStatus[] = [];
    let recalculateCalls = 0;
    let refreshOrdersCalls = 0;
    let refreshUnrealizedCalls = 0;
    let accountSnapshotCalls = 0;
    let stockPositionCalls = 0;
    const lastState = createLastState();
    const context = createMonitorContext({
      orderRecorder: createOrderRecorderDouble({
        fetchAllOrdersFromAPI: async () => [],
        refreshOrdersFromAllOrdersForLong: async () => {
          refreshOrdersCalls += 1;
          return [];
        },
      }),
      dailyLossTracker: {
        resetAll: () => {},
        recalculateFromAllOrders: () => {
          recalculateCalls += 1;
        },
        recordCumulativeExecution: () => ({
          authoritativeFactChanged: false,
          executionAdvanced: false,
        }),
        getLossOffset: () => 0,
        prepareProtectionBoundary: (params) => ({ ...params, orderBaselines: [] }),
        commitProtectionBoundary: () => {},
        restoreExecutionSnapshot: () => {},
        restoreProtectionBoundary: () => {},
      },
      riskChecker: createRiskCheckerDouble({
        refreshUnrealizedLossData: async () => {
          refreshUnrealizedCalls += 1;
          return { r1: 100, n1: 100 };
        },
      }),
      longSymbolName: 'OLD_BULL',
    });
    context.symbolRegistry.updateSeatState('LONG', {
      ...context.symbolRegistry.getSeatState('LONG'),
      symbol: 'BULL.HK',
      status: 'ACTIVATING',
      callPrice: 20_000,
    });

    const processor = createBusinessProcessor({
      queue,
      context,
      lastState,
      trader: createTraderDouble({
        getAccountSnapshot: async () => {
          accountSnapshotCalls += 1;
          return createAccountSnapshotDouble(123_000);
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
            ['BULL.HK', createQuoteDouble('BULL.HK', 1.1, 100)],
            ['OLD_BULL.HK', createQuoteDouble('OLD_BULL.HK', 1, 100)],
          ]);
        },
      }),
      onProcessed: createStatusCollector(statuses),
    });

    await runProcessorFlow({
      processor,
      pushTask: () => {
        scheduleSeatRefreshTask(queue, 'SEAT_REFRESH:LONG:STALE_BEFORE_SHARED_WRITES');
      },
      waitCondition: () => statuses.length === 1,
      timeoutMs: 500,
    });

    expect(statuses).toEqual(['skipped']);
    expect(recalculateCalls).toBe(0);
    expect(refreshOrdersCalls).toBe(0);
    expect(accountSnapshotCalls).toBe(0);
    expect(stockPositionCalls).toBe(0);
    expect(refreshUnrealizedCalls).toBe(0);
    expect(lastState.cachedAccount).toBeNull();
    expect(lastState.cachedPositions).toEqual([]);
    expect(lastState.positionCache.get('BULL.HK')).toBeNull();
    expect(context.longSymbolName).toBe('OLD_BULL');
    expect(context.symbolRegistry.getSeatVersion('LONG')).toBe(3);
    expect(context.symbolRegistry.getSeatState('LONG')).toMatchObject({
      symbol: 'NEXT_BULL.HK',
      status: 'SWITCHING',
    });
  });

  it('marks activating seat EMPTY after SEAT_REFRESH API retry is exhausted', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const statuses: MonitorTaskStatus[] = [];
    const fatalErrors: unknown[] = [];
    let getQuotesCalls = 0;
    const context = createMonitorContext({
      longSymbolName: 'OLD_BULL',
    });
    context.symbolRegistry.updateSeatState('LONG', {
      ...context.symbolRegistry.getSeatState('LONG'),
      symbol: 'BULL.HK',
      status: 'ACTIVATING',
      callPrice: 20_000,
    });
    const originalSeatVersion = context.symbolRegistry.getSeatVersion('LONG');

    const processor = createBusinessProcessor({
      queue,
      context,
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () => {
          getQuotesCalls += 1;
          throw createExternalApiRequestError({
            operation: 'test.seatRefreshQuotes',
            attempts: 1,
            cause: new Error('quote unavailable'),
          });
        },
      }),
      onFatalError: (error) => {
        fatalErrors.push(error);
      },
      onProcessed: createStatusCollector(statuses),
    });

    processor.start();
    scheduleSeatRefreshTask(queue, 'SEAT_REFRESH:LONG:API_FAIL');

    await waitUntil(() => statuses.length === 1 || fatalErrors.length === 1, 500);
    await Bun.sleep(Math.max(API.DEFAULT_RETRY_DELAY_MS - 100, 0));

    expect(statuses).toEqual(['failed']);
    expect(getQuotesCalls).toBe(1);

    await waitUntil(() => statuses.length === 2 || fatalErrors.length === 1, 800);
    await processor.stopAndDrain();

    expect(statuses).toEqual(['failed', 'failed']);
    expect(fatalErrors).toEqual([]);
    expect(getQuotesCalls).toBe(2);
    expect(context.symbolRegistry.getSeatState('LONG')).toMatchObject({
      symbol: null,
      status: 'EMPTY',
      callPrice: null,
    });
    expect(context.longSymbolName).toBe('OLD_BULL');
    expect(context.symbolRegistry.getSeatVersion('LONG')).toBeGreaterThan(originalSeatVersion);
  });

  it('sends SEAT_REFRESH non API order refresh errors to fatal channel', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const statuses: MonitorTaskStatus[] = [];
    const fatalErrors: unknown[] = [];
    let getQuotesCalls = 0;

    const context = createMonitorContext({
      longSymbolName: 'OLD_BULL',
      orderRecorder: createOrderRecorderDouble({
        fetchAllOrdersFromAPI: async () => [],
        refreshOrdersFromAllOrdersForLong: async () => {
          throw new Error('seat refresh order rebuild failed');
        },
      }),
    });
    context.symbolRegistry.updateSeatState('LONG', {
      ...context.symbolRegistry.getSeatState('LONG'),
      symbol: 'BULL.HK',
      status: 'ACTIVATING',
      callPrice: 20_000,
    });

    const processor = createBusinessProcessor({
      queue,
      context,
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () => {
          getQuotesCalls += 1;
          return new Map([['BULL.HK', createQuoteDouble('BULL.HK', 1.1, 100)]]);
        },
      }),
      onFatalError: (error) => {
        fatalErrors.push(error);
      },
      onProcessed: createStatusCollector(statuses),
    });

    await runProcessorFlow({
      processor,
      pushTask: () => {
        scheduleSeatRefreshTask(queue, 'SEAT_REFRESH:LONG:FAIL');
      },
      waitCondition: () => fatalErrors.length === 1 || statuses.length === 1,
      timeoutMs: 500,
    });

    expect(fatalErrors).toHaveLength(1);
    expect(fatalErrors[0]).toBeInstanceOf(Error);
    expect(statuses).toEqual([]);
    expect(getQuotesCalls).toBe(1);
    expect(context.symbolRegistry.getSeatState('LONG')).toMatchObject({
      symbol: 'BULL.HK',
      status: 'ACTIVATING',
      callPrice: 20_000,
    });
    expect(context.longSymbolName).toBe('OLD_BULL');
    expect(context.symbolRegistry.getSeatVersion('LONG')).toBe(2);
  });

  it('skips SEAT_REFRESH seat-owned work when the seat changes while order rebuild is pending', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const statuses: MonitorTaskStatus[] = [];
    const rebuildStarted = createDeferred<null>();
    const releaseRebuild = createDeferred<null>();
    let dailyLossRecalculations = 0;
    let accountSnapshotCalls = 0;
    let stockPositionCalls = 0;
    let refreshUnrealizedCalls = 0;
    let warrantInfoWrites = 0;
    let activationWrites = 0;
    const lastState = createLastState();
    const orderRecorder = Object.assign(
      createOrderRecorderDouble({
        fetchAllOrdersFromAPI: async () => [],
        refreshOrdersFromAllOrdersForLong: async () => {
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
      dailyLossTracker: createDailyLossTrackerDouble({
        recalculateFromAllOrders: () => {
          dailyLossRecalculations += 1;
        },
      }),
      orderRecorder,
      riskChecker: createRiskCheckerDouble({
        refreshUnrealizedLossData: async () => {
          refreshUnrealizedCalls += 1;
          return null;
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
      callPrice: 20_000,
    });
    const updateSeatState = context.symbolRegistry.updateSeatState;
    context.symbolRegistry.updateSeatState = (direction, nextState) => {
      if (direction === 'LONG' && nextState.status === 'ACTIVE') {
        activationWrites += 1;
      }

      return updateSeatState(direction, nextState);
    };

    const processor = createBusinessProcessor({
      queue,
      context,
      lastState,
      trader: createTraderDouble({
        getAccountSnapshot: async () => {
          accountSnapshotCalls += 1;
          return createAccountSnapshotDouble(100_000);
        },
        getStockPositions: async () => {
          stockPositionCalls += 1;
          return [];
        },
      }),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () => new Map([['BULL.HK', createQuoteDouble('BULL.HK', 1.1, 100)]]),
      }),
      onProcessed: createStatusCollector(statuses),
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
    await waitUntil(() => statuses.length === 1, 500);
    await processor.stopAndDrain();

    expect(statuses).toEqual(['skipped']);
    expect(dailyLossRecalculations).toBe(1);
    expect(accountSnapshotCalls).toBe(0);
    expect(stockPositionCalls).toBe(0);
    expect(refreshUnrealizedCalls).toBe(0);
    expect(warrantInfoWrites).toBe(0);
    expect(activationWrites).toBe(0);
    expect(lastState.cachedAccount).toBeNull();
    expect(lastState.cachedPositions).toEqual([]);
    expect(context.symbolRegistry.getSeatState('LONG')).toMatchObject({
      symbol: 'NEXT_BULL.HK',
      status: 'SWITCHING',
    });
  });

  it('skips SEAT_REFRESH risk and seat-owned writes when the seat changes during account cache refresh', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const statuses: MonitorTaskStatus[] = [];
    const accountRefreshStarted = createDeferred<null>();
    const releaseAccountRefresh = createDeferred<null>();
    let riskRefreshCalls = 0;
    let clearBuyOrdersCalls = 0;
    let clearOrdersCacheCalls = 0;
    let warrantInfoWrites = 0;
    let activationWrites = 0;
    const orderRecorder = createOrderRecorderDouble({
      fetchAllOrdersFromAPI: async () => [],
      refreshOrdersFromAllOrdersForLong: async () => [],
      clearBuyOrders: () => {
        clearBuyOrdersCalls += 1;
      },
      clearOrdersCacheForSymbol: () => {
        clearOrdersCacheCalls += 1;
      },
    });
    const context = createMonitorContext({
      orderRecorder,
      riskChecker: createRiskCheckerDouble({
        refreshUnrealizedLossData: async () => {
          riskRefreshCalls += 1;
          return null;
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
      callPrice: 20_000,
    });
    const updateSeatState = context.symbolRegistry.updateSeatState;
    context.symbolRegistry.updateSeatState = (direction, nextState) => {
      if (direction === 'LONG' && nextState.status === 'ACTIVE') {
        activationWrites += 1;
      }

      return updateSeatState(direction, nextState);
    };

    const processor = createBusinessProcessor({
      queue,
      context,
      trader: createTraderDouble({
        getAccountSnapshot: async () => {
          accountRefreshStarted.resolve(null);
          await releaseAccountRefresh.promise;
          return createAccountSnapshotDouble(100_000);
        },
        getStockPositions: async () => [],
      }),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () =>
          new Map([
            ['BULL.HK', createQuoteDouble('BULL.HK', 1.1, 100)],
            ['OLD_BULL.HK', createQuoteDouble('OLD_BULL.HK', 1, 100)],
          ]),
      }),
      onProcessed: createStatusCollector(statuses),
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
    await waitUntil(() => statuses.length === 1, 500);
    await processor.stopAndDrain();

    expect(statuses).toEqual(['skipped']);
    expect(riskRefreshCalls).toBe(0);
    expect(clearBuyOrdersCalls).toBe(0);
    expect(clearOrdersCacheCalls).toBe(0);
    expect(warrantInfoWrites).toBe(0);
    expect(activationWrites).toBe(0);
    expect(context.symbolRegistry.getSeatState('LONG')).toMatchObject({
      symbol: 'NEXT_BULL.HK',
      status: 'SWITCHING',
    });
  });

  it('skips SEAT_REFRESH post-risk writes when the seat changes during risk refresh', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const statuses: MonitorTaskStatus[] = [];
    const riskRefreshStarted = createDeferred<null>();
    const releaseRiskRefresh = createDeferred<null>();
    let clearBuyOrdersCalls = 0;
    let clearOrdersCacheCalls = 0;
    let warrantInfoWrites = 0;
    let activationWrites = 0;
    const orderRecorder = createOrderRecorderDouble({
      fetchAllOrdersFromAPI: async () => [],
      refreshOrdersFromAllOrdersForLong: async () => [],
      clearBuyOrders: () => {
        clearBuyOrdersCalls += 1;
      },
      clearOrdersCacheForSymbol: () => {
        clearOrdersCacheCalls += 1;
      },
    });
    const context = createMonitorContext({
      orderRecorder,
      riskChecker: createRiskCheckerDouble({
        refreshUnrealizedLossData: async () => {
          riskRefreshStarted.resolve(null);
          await releaseRiskRefresh.promise;
          return null;
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
      callPrice: 20_000,
    });
    const updateSeatState = context.symbolRegistry.updateSeatState;
    context.symbolRegistry.updateSeatState = (direction, nextState) => {
      if (direction === 'LONG' && nextState.status === 'ACTIVE') {
        activationWrites += 1;
      }

      return updateSeatState(direction, nextState);
    };

    const processor = createBusinessProcessor({
      queue,
      context,
      trader: createTraderDouble({
        getAccountSnapshot: async () => createAccountSnapshotDouble(100_000),
        getStockPositions: async () => [],
      }),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () =>
          new Map([
            ['BULL.HK', createQuoteDouble('BULL.HK', 1.1, 100)],
            ['OLD_BULL.HK', createQuoteDouble('OLD_BULL.HK', 1, 100)],
          ]),
      }),
      onProcessed: createStatusCollector(statuses),
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
    await waitUntil(() => statuses.length === 1, 500);
    await processor.stopAndDrain();

    expect(statuses).toEqual(['skipped']);
    expect(clearBuyOrdersCalls).toBe(0);
    expect(clearOrdersCacheCalls).toBe(0);
    expect(warrantInfoWrites).toBe(0);
    expect(activationWrites).toBe(0);
    expect(context.symbolRegistry.getSeatState('LONG')).toMatchObject({
      symbol: 'NEXT_BULL.HK',
      status: 'SWITCHING',
    });
  });

  it('skips SEAT_REFRESH final activation when seat snapshot changes during refresh', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const statuses: MonitorTaskStatus[] = [];
    const context = createMonitorContext();
    context.symbolRegistry.updateSeatState('LONG', {
      ...context.symbolRegistry.getSeatState('LONG'),
      symbol: 'BULL.HK',
      status: 'ACTIVATING',
      callPrice: 20_000,
    });

    context.riskChecker.refreshUnrealizedLossData = async () => {
      const latestSeat = context.symbolRegistry.getSeatState('LONG');
      context.symbolRegistry.updateSeatStateWithVersionBump('LONG', {
        ...latestSeat,
        symbol: 'NEXT_BULL.HK',
        status: 'SWITCHING',
        lastSwitchAt: Date.now(),
        callPrice: null,
      });
      return { r1: 100, n1: 100 };
    };

    const processor = createBusinessProcessor({
      queue,
      context,
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () =>
          new Map([
            ['BULL.HK', createQuoteDouble('BULL.HK', 1.1, 100)],
            ['OLD_BULL.HK', createQuoteDouble('OLD_BULL.HK', 1, 100)],
          ]),
      }),
      onProcessed: createStatusCollector(statuses),
    });

    await runProcessorFlow({
      processor,
      pushTask: () => {
        scheduleSeatRefreshTask(queue, 'SEAT_REFRESH:LONG:STALE_DURING_REFRESH');
      },
      waitCondition: () => statuses.length === 1,
      timeoutMs: 500,
    });

    expect(statuses).toEqual(['skipped']);
    expect(context.symbolRegistry.getSeatVersion('LONG')).toBe(3);
    expect(context.symbolRegistry.getSeatState('LONG')).toMatchObject({
      symbol: 'NEXT_BULL.HK',
      status: 'SWITCHING',
    });
  });
});
