import {
  createLoggerDouble,
  createAccountSnapshotDouble,
  createMonitorConfigDouble,
  createMonitorContextDouble,
  createSymbolRegistryDouble,
  createTradeRuntimeDouble,
} from '../../helpers/testDoubles.js';
import { createSnapshotFixture } from '../../helpers/accountPositionSnapshot.js';
import { createSettlementRuntimeFixture } from '../../helpers/settlementRuntime.js';
import { createTerminationRuntime } from '../../../src/runtime/lifecycle/terminationRuntime.js';
import { beforeEach, describe, expect, it } from 'bun:test';
import { TIME, TRADING } from '../../../src/constants/index.js';
import { createPeriodicSwitchWakeupRuntime } from '../../../src/runtime/periodicSwitchWakeupRuntime/index.js';

import type { MonitorConfig } from '../../../src/types/config.js';
import type { AccountPositionSnapshotReader } from '../../../src/types/accountPosition.js';
import type { RuntimeWritableSeatState } from '../../../src/types/seat.js';
import type { MonitorContextAssembly } from '../../../src/app/context/types.js';
import type { PostTradeConsistencyRuntime } from '../../../src/app/runtime/types.js';
import type { OrderStateChangedEvent } from '../../../src/types/orderTracking.js';
import type { Unsubscribe } from '../../../src/types/events.js';
import type { TradingGateStateChangedEvent } from '../../../src/types/timeControlPlane.js';
import type { PeriodicSwitchWakeupRuntimeDeps } from '../../../src/runtime/periodicSwitchWakeupRuntime/types.js';
import type { MonitorTaskInput } from '../../../src/runtime/asyncProgram/monitorTaskQueue/types.js';
import type { MonitorTaskDataMap } from '../../../src/runtime/asyncProgram/monitorTaskProcessor/types.js';
import type {
  PeriodicSwitchRouteBaseline,
  PeriodicSwitchTaskAuthorization,
} from '../../../src/types/periodicSwitch.js';
import { calculateTradingDurationDueAtMs } from '../../../src/domain/tradingSession/index.js';

let termination: ReturnType<typeof createTerminationRuntime>;
beforeEach(() => {
  termination = createTerminationRuntime({
    closeTradingGate: () => {},
    closeProducerAdmission: () => {},
    stopProducers: [],
    onSecondaryError: () => {},
  });
});

/**
 * PeriodicSwitchWakeupRuntime 业务测试
 *
 * 覆盖周期换标 due timer 的 ownership、baseline 隔离、waiting-empty 显式唤醒与 stop 清理语义。
 */

type ScheduledTask = MonitorTaskInput<MonitorTaskDataMap, 'AUTO_SYMBOL_TICK'>;
type TimerHandle = ReturnType<typeof setTimeout>;

type PeriodicHarness = Readonly<{
  runtime: ReturnType<typeof createPeriodicSwitchWakeupRuntime>;
  snapshot: AccountPositionSnapshotReader;
  symbolRegistry: ReturnType<typeof createSymbolRegistryDouble>;
  tasks: ScheduledTask[];
  timers: ReturnType<typeof createTimerHarness>;
  subscriptions: ReturnType<typeof createSubscriptionHarness>;
  monitorConfig: MonitorConfig;
  getAuthorization: (direction: 'LONG' | 'SHORT') => PeriodicSwitchTaskAuthorization;
}>;

function hkMs(dateKey: string, hour: number, minute: number): number {
  return Date.parse(
    `${dateKey}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000+08:00`,
  );
}

function createActiveSeat(symbol: string, lastSeatActivatedAt: number): RuntimeWritableSeatState {
  return {
    symbol,
    status: 'ACTIVE',
    lastSwitchAt: null,
    lastSearchAt: null,
    lastSeatActivatedAt,
    callPrice: null,
    searchFailCountToday: 0,
    frozenTradingDayKey: null,
  };
}

function createSwitchEnabledMonitorConfig(
  params: {
    readonly monitorSymbol?: string;
    readonly switchIntervalMinutes?: number;
    readonly autoSearchEnabled?: boolean;
  } = {},
): MonitorConfig {
  const baseConfig = createMonitorConfigDouble({
    monitorSymbol: params.monitorSymbol ?? 'HSI.HK',
  });

  return createMonitorConfigDouble({
    ...baseConfig,
    autoSearchConfig: {
      ...baseConfig.autoSearchConfig,
      autoSearchEnabled: params.autoSearchEnabled ?? true,
      switchIntervalMinutes: params.switchIntervalMinutes ?? 5,
    },
  });
}

function createTimerHarness(initialNowMs: number) {
  let currentNowMs = initialNowMs;
  const timers = new Map<TimerHandle, { readonly atMs: number; readonly callback: () => void }>();

  return {
    now: () => new Date(currentNowMs),
    setNow: (nextNowMs: number) => {
      currentNowMs = nextNowMs;
    },
    scheduleTimer: (callback: () => void, delayMs: number) => {
      const handle = setTimeout(() => {}, 2_147_483_647);
      timers.set(handle, {
        atMs: currentNowMs + delayMs,
        callback,
      });
      return handle;
    },
    clearTimer: (handle: TimerHandle) => {
      clearTimeout(handle);
      timers.delete(handle);
    },
    fireNext: () => {
      const next = [...timers.entries()].sort(([, left], [, right]) => left.atMs - right.atMs)[0];
      if (next === undefined) {
        return;
      }

      const [handle, timer] = next;
      clearTimeout(handle);
      timers.delete(handle);
      timer.callback();
    },
    captureNextCallback: () => {
      const next = [...timers.values()].sort((left, right) => left.atMs - right.atMs)[0];
      return next?.callback ?? null;
    },
    getPendingTimerCount: () => timers.size,
    getPendingTimerAts: () => [...timers.values()].map((timer) => timer.atMs),
  };
}

function createSubscriptionHarness(settlement: PostTradeConsistencyRuntime) {
  const orderListeners = new Set<(event: OrderStateChangedEvent) => void>();
  let freshListenerCount = 0;
  let canTradeNow = true;
  const gateListeners = new Set<(event: TradingGateStateChangedEvent) => void>();

  return {
    tradeRuntime: createTradeRuntimeDouble({
      orderMonitor: {
        onOrderStateChanged: (listener) => {
          orderListeners.add(listener);
          return () => {
            orderListeners.delete(listener);
          };
        },
      },
    }),
    getCanTradeNow: () => canTradeNow,
    postTradeConsistencyRuntime: {
      ...settlement,
      onFreshReached: (listener: () => void) => {
        freshListenerCount += 1;
        const unsubscribe = settlement.onFreshReached(listener);
        return () => {
          freshListenerCount -= 1;
          unsubscribe();
        };
      },
    },
    tradingGateEventRuntime: {
      onGateStateChanged: (
        listener: (event: TradingGateStateChangedEvent) => void,
      ): Unsubscribe => {
        gateListeners.add(listener);
        return () => {
          gateListeners.delete(listener);
        };
      },
    },
    emitOrder: () => {
      const event: OrderStateChangedEvent = {
        orderId: 'order-1',
        symbol: 'BULL.HK',
        side: 'SELL',
        source: 'WS',
        status: 'FILLED',
        monitorSymbol: 'HSI.HK',
        isLongSymbol: true,
        isProtectiveLiquidation: false,
        executedPrice: '1',
        executedQuantity: 100,
        executedTimeMs: 2_000,
      };
      for (const listener of orderListeners) {
        listener(event);
      }
    },
    emitFresh: async () => {
      settlement.recordSettlementRefreshNeed({ refreshAccount: true, refreshPositions: true });
      await settlement.waitForFresh();
    },
    emitGate: (event: TradingGateStateChangedEvent) => {
      canTradeNow = event.nextCanTrade;
      for (const listener of gateListeners) {
        listener(event);
      }
    },
    getListenerCounts: () => ({
      order: orderListeners.size,
      fresh: freshListenerCount,
      gate: gateListeners.size,
    }),
  };
}

async function createHarness(
  params: {
    readonly nowMs?: number;
    readonly monitorConfig?: MonitorConfig;
    readonly symbolRegistry?: ReturnType<typeof createSymbolRegistryDouble>;
    readonly monitorContext?: Pick<MonitorContextAssembly, 'config'>;
    readonly calculateDueAtMs?: PeriodicSwitchWakeupRuntimeDeps['calculateDueAtMs'];
  } = {},
): Promise<PeriodicHarness> {
  const monitorConfig = params.monitorConfig ?? createSwitchEnabledMonitorConfig();
  const symbolRegistry =
    params.symbolRegistry ??
    createSymbolRegistryDouble({
      longSeat: createActiveSeat('BULL.HK', 1_000),
      shortSeat: createActiveSeat('BEAR.HK', 1_500),
      longVersion: 1,
      shortVersion: 2,
    });
  const monitorContext = createMonitorContextDouble({
    config: monitorConfig,
    symbolRegistry,
  });
  const runtimeMonitorContext = params.monitorContext ?? monitorContext;
  const timers = createTimerHarness(params.nowMs ?? 10_000);
  const snapshot = await createSnapshotFixture({
    account: createAccountSnapshotDouble('100000'),
    positions: [],
  });
  const settlement = createSettlementRuntimeFixture({
    logger: createLoggerDouble(),
    snapshot,
    termination,
    monitorContext,
    getProtectiveOrderReader: () => createTradeRuntimeDouble().orderMonitor,
    onPositionsCommitted: async (token) => {
      expect(snapshot.isCurrent(token, { account: true, positions: true, paired: true })).toBe(
        true,
      );
    },
    scheduler: {
      scheduleTimer: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimer: (handle) => {
        clearTimeout(handle);
      },
    },
  });
  settlement.start();
  expect(await settlement.completeRebuildBaseline()).toBeTrue();
  const startupReceipt = await settlement.waitForFresh();
  expect(startupReceipt.snapshotToken).toBe(snapshot.getView().token);
  // 新周期任务使用普通 commit 后的 view；旧完成水位不能导致永远不派发。
  for (const refreshAccount of [true, false]) {
    await snapshot.requestRefresh({
      source: 'SEAT_ACTIVATION',
      dayEpoch: startupReceipt.snapshotToken.dayEpoch,
      refreshAccount,
      refreshPositions: true,
    }).result;
    expect(settlement.isCurrent(startupReceipt)).toBe(true);
    expect(await settlement.waitForFresh()).toBe(startupReceipt);
  }

  const subscriptions = createSubscriptionHarness(settlement);
  const tasks: ScheduledTask[] = [];
  const issuedTasks: ScheduledTask[] = [];

  const runtime = createPeriodicSwitchWakeupRuntime({
    termination,
    snapshot,
    getCanTradeNow: subscriptions.getCanTradeNow,
    monitorContext: runtimeMonitorContext,
    symbolRegistry,
    monitorTaskQueue: {
      scheduleLatest: (task) => {
        if (task.type === 'AUTO_SYMBOL_TICK') {
          tasks.push(task);
          issuedTasks.push(task);
        }

        return true;
      },
    },
    orderMonitor: subscriptions.tradeRuntime.orderMonitor,
    postTradeConsistencyRuntime: subscriptions.postTradeConsistencyRuntime,
    tradingGateEventRuntime: subscriptions.tradingGateEventRuntime,
    calculateDueAtMs:
      params.calculateDueAtMs ?? ((input) => input.startMs + input.switchIntervalMinutes * 60_000),
    now: timers.now,
    scheduleTimer: timers.scheduleTimer,
    clearTimer: timers.clearTimer,
  });

  return {
    runtime,
    snapshot,
    symbolRegistry,
    tasks,
    timers,
    subscriptions,
    monitorConfig,
    getAuthorization: (direction) => {
      for (let index = issuedTasks.length - 1; index >= 0; index -= 1) {
        const task = issuedTasks[index];
        if (task?.data.direction === direction) return task.data;
      }

      throw new Error(`route ${direction} has no issued authorization`);
    },
  };
}

async function flushDispatch(): Promise<void> {
  for (let i = 0; i < 40; i += 1) await Promise.resolve();
}

function expectTickTask(
  task: ScheduledTask | undefined,
  expected: Omit<PeriodicSwitchRouteBaseline, 'dayEpoch'>,
): void {
  expect(task).toBeDefined();
  if (task === undefined) {
    return;
  }

  expect(task.type).toBe('AUTO_SYMBOL_TICK');
  expect(task.data.dayEpoch).toBe(task.data.readinessReceipt.snapshotToken.dayEpoch);
  expect(task.data.canContinue()).toBe(true);
  expect(task.data.isRouteCurrent()).toBe(true);
  expect(task.dedupeKey).toBe(`AUTO_SYMBOL_TICK:${expected.direction}`);
  expect(task.data.direction).toBe(expected.direction);
  expect(task.data.seatVersion).toBe(expected.seatVersion);
  expect(task.data.symbol).toBe(expected.symbol);
  expect(task.data.currentTimeMs).toEqual(expect.any(Number));
  expect(task.data).toHaveProperty('lastSeatActivatedAt', expected.lastSeatActivatedAt);
}

describe('PeriodicSwitchWakeupRuntime', () => {
  it('start seed 已启用 monitor 的 LONG/SHORT，并对 due route 入队完整 baseline', async () => {
    const harness = await createHarness({ nowMs: 400_000 });

    harness.runtime.start();
    await flushDispatch();

    expect(harness.tasks).toHaveLength(2);
    expectTickTask(harness.tasks[0], {
      direction: 'LONG',
      symbol: 'BULL.HK',
      seatVersion: 1,
      lastSeatActivatedAt: 1_000,
    });

    expectTickTask(harness.tasks[1], {
      direction: 'SHORT',
      symbol: 'BEAR.HK',
      seatVersion: 2,
      lastSeatActivatedAt: 1_500,
    });
    expect(harness.tasks.map((task) => task.data.currentTimeMs)).toEqual([400_000, 400_000]);
  });

  it('start 幂等且 stopAndDrain 后可重新订阅与 seed', async () => {
    const harness = await createHarness({ nowMs: 400_000 });

    harness.runtime.start();
    await flushDispatch();
    harness.runtime.start();
    await flushDispatch();

    expect(harness.tasks).toHaveLength(2);
    expect(harness.symbolRegistry.getSeatTruthChangedListenerCount()).toBe(1);
    expect(harness.subscriptions.getListenerCounts()).toEqual({ order: 1, fresh: 1, gate: 1 });

    await harness.runtime.stopAndDrain();
    expect(harness.symbolRegistry.getSeatTruthChangedListenerCount()).toBe(0);
    expect(harness.subscriptions.getListenerCounts()).toEqual({ order: 0, fresh: 0, gate: 0 });

    harness.runtime.start();
    await flushDispatch();

    expect(harness.tasks).toHaveLength(4);
    expect(harness.symbolRegistry.getSeatTruthChangedListenerCount()).toBe(1);
    expect(harness.subscriptions.getListenerCounts()).toEqual({ order: 1, fresh: 1, gate: 1 });
  });

  it('dueAtMs 小于等于当前时间时 inline 派发一次且不注册 0ms timer', async () => {
    const harness = await createHarness({
      nowMs: 301_000,
      calculateDueAtMs: () => 301_000,
    });

    harness.runtime.start();
    await flushDispatch();

    expect(harness.tasks).toHaveLength(2);
    expect(harness.timers.getPendingTimerCount()).toBe(0);
  });

  it('dueAtMs 大于当前时间时只注册 one-shot timer，触发时 baseline 匹配才派发且不递归重排', async () => {
    const harness = await createHarness({
      nowMs: 100_000,
      calculateDueAtMs: ({ startMs }) => (startMs === 1_000 ? 200_000 : 300_000),
    });

    harness.runtime.start();
    await flushDispatch();

    expect(harness.tasks).toHaveLength(0);
    expect(harness.timers.getPendingTimerCount()).toBe(2);
    expect(harness.timers.getPendingTimerAts().sort((left, right) => left - right)).toEqual([
      200_000, 300_000,
    ]);

    harness.timers.setNow(200_000);
    harness.timers.fireNext();
    await flushDispatch();

    expect(harness.tasks).toHaveLength(1);
    expect(harness.tasks[0]?.data.direction).toBe('LONG');
    expect(harness.timers.getPendingTimerCount()).toBe(1);
  });

  it('使用真实交易时长 due 计算时按午休后的实际到期时间注册 timer', async () => {
    const startMs = hkMs('2026-04-29', 11, 50);
    const dueAtMs = hkMs('2026-04-29', 13, 10);
    const monitorConfig = createSwitchEnabledMonitorConfig({ switchIntervalMinutes: 20 });
    const symbolRegistry = createSymbolRegistryDouble({
      longSeat: createActiveSeat('BULL.HK', startMs),
      shortSeat: createActiveSeat('BEAR.HK', startMs),
      longVersion: 1,
      shortVersion: 2,
    });
    const calendarSnapshot = new Map([['2026-04-29', { isTradingDay: true, isHalfDay: false }]]);
    const harness = await createHarness({
      nowMs: hkMs('2026-04-29', 11, 55),
      monitorConfig,
      symbolRegistry,
      calculateDueAtMs: ({ startMs: routeStartMs, switchIntervalMinutes }) =>
        calculateTradingDurationDueAtMs({
          startMs: routeStartMs,
          targetDurationMs: switchIntervalMinutes * TIME.MILLISECONDS_PER_MINUTE,
          calendarSnapshot,
        }),
    });

    harness.runtime.start();
    await flushDispatch();

    expect(harness.tasks).toHaveLength(0);
    expect(harness.timers.getPendingTimerAts().sort((left, right) => left - right)).toEqual([
      dueAtMs,
      dueAtMs,
    ]);
  });

  it('超长周期换标 due timer 只注册最大安全分段，到真实 due 后才派发', async () => {
    const nowMs = 100_000;
    const dueAtMs = nowMs + TIME.MAX_TIMER_DELAY_MS + 5;
    const harness = await createHarness({
      nowMs,
      calculateDueAtMs: () => dueAtMs,
    });

    harness.runtime.start();
    await flushDispatch();

    expect(harness.tasks).toHaveLength(0);
    expect(harness.timers.getPendingTimerAts().sort((left, right) => left - right)).toEqual([
      nowMs + TIME.MAX_TIMER_DELAY_MS,
      nowMs + TIME.MAX_TIMER_DELAY_MS,
    ]);

    harness.timers.setNow(nowMs + TIME.MAX_TIMER_DELAY_MS);
    harness.timers.fireNext();
    await flushDispatch();
    expect(harness.tasks).toHaveLength(0);
    expect(harness.timers.getPendingTimerAts().sort((left, right) => left - right)).toEqual([
      nowMs + TIME.MAX_TIMER_DELAY_MS,
      dueAtMs,
    ]);

    harness.timers.setNow(dueAtMs);
    harness.timers.fireNext();
    await flushDispatch();
    expect(harness.tasks).toHaveLength(1);
  });

  it('timer 触发时 baseline 已过期则不派发', async () => {
    const harness = await createHarness({ nowMs: 100_000 });
    harness.runtime.start();
    await flushDispatch();
    expect(harness.timers.getPendingTimerCount()).toBe(2);

    harness.symbolRegistry.updateSeatStateWithVersionBump(
      'LONG',
      createActiveSeat('BULL2.HK', 100_000),
    );
    await flushDispatch();
    harness.timers.setNow(301_000);
    harness.timers.fireNext();
    await flushDispatch();

    expect(harness.tasks.filter((task) => task.data.direction === 'LONG')).toHaveLength(0);
  });

  it('calculateDueAtMs 返回 null 时不派发也不注册 timer', async () => {
    const harness = await createHarness({
      nowMs: 100_000,
      calculateDueAtMs: () => null,
    });

    harness.runtime.start();
    await flushDispatch();

    expect(harness.tasks).toHaveLength(0);
    expect(harness.timers.getPendingTimerCount()).toBe(0);
  });

  it('stopAndDrain 阻止后续 timer/order/fresh 派发并清理 waiting-empty', async () => {
    const harness = await createHarness({ nowMs: 100_000 });
    harness.runtime.start();
    await flushDispatch();
    harness.timers.setNow(301_000);
    harness.timers.fireNext();
    await flushDispatch();
    expect(harness.tasks).toHaveLength(1);
    const baseline = harness.getAuthorization('LONG');
    expect(baseline.canContinue()).toBe(true);
    harness.tasks.length = 0;
    harness.runtime.markWaitingEmpty(baseline);

    await harness.runtime.stopAndDrain();
    harness.timers.setNow(301_000);
    harness.timers.fireNext();
    await flushDispatch();
    harness.subscriptions.emitOrder();
    await flushDispatch();
    await harness.subscriptions.emitFresh();

    expect(harness.tasks).toHaveLength(0);
    expect(harness.timers.getPendingTimerCount()).toBe(0);

    harness.runtime.start();
    await flushDispatch();
    const taskCountAfterRestartSeed = harness.tasks.length;
    harness.subscriptions.emitOrder();
    await flushDispatch();
    expect(harness.tasks).toHaveLength(taskCountAfterRestartSeed);
  });

  it('onSeatTruthChanged 只对事件 route 重算，不作为 waiting-empty progress 来源', async () => {
    const harness = await createHarness({ nowMs: 400_000 });
    harness.runtime.start();
    await flushDispatch();
    harness.tasks.length = 0;
    const staleBaseline = harness.getAuthorization('LONG');
    harness.runtime.markWaitingEmpty(staleBaseline);

    harness.symbolRegistry.updateSeatStateWithVersionBump(
      'LONG',
      createActiveSeat('BULL2.HK', 400_000),
    );
    await flushDispatch();

    harness.symbolRegistry.updateSeatStateWithVersionBump(
      'SHORT',
      createActiveSeat('BEAR2.HK', 1_500),
    );
    await flushDispatch();

    expect(harness.tasks).toHaveLength(1);
    expect(harness.tasks[0]?.data.direction).toBe('SHORT');
  });

  it('order/fresh 事件只重新派发 waiting-empty routes，并使用相同 dedupe key', async () => {
    const harness = await createHarness({ nowMs: 400_000 });
    harness.runtime.start();
    await flushDispatch();
    harness.tasks.length = 0;
    const baseline = harness.getAuthorization('LONG');

    harness.runtime.markWaitingEmpty(baseline);
    harness.runtime.replanRouteAfterTask({ ...baseline, taskTimeMs: 400_000, status: 'processed' });
    harness.subscriptions.emitOrder();
    await flushDispatch();
    const orderAuthorization = harness.getAuthorization('LONG');
    harness.runtime.replanRouteAfterTask({
      ...orderAuthorization,
      taskTimeMs: 400_000,
      status: 'processed',
    });
    await harness.subscriptions.emitFresh();

    expect(harness.tasks).toHaveLength(2);
    expect(harness.tasks.every((task) => task.dedupeKey === 'AUTO_SYMBOL_TICK:LONG')).toBe(true);
    expect(harness.tasks.every((task) => task.data.direction === 'LONG')).toBe(true);
  });

  it('当前 baseline 已 waiting-empty 时 replanRouteAfterTask 保持等待且不重派发', async () => {
    const harness = await createHarness({ nowMs: 400_000 });
    harness.runtime.start();
    await flushDispatch();
    harness.tasks.length = 0;
    const baseline = harness.getAuthorization('LONG');

    harness.runtime.markWaitingEmpty(baseline);
    harness.runtime.replanRouteAfterTask({ ...baseline, taskTimeMs: 400_000, status: 'processed' });

    expect(harness.tasks).toHaveLength(0);

    harness.subscriptions.emitOrder();
    await flushDispatch();

    expect(harness.tasks).toHaveLength(1);
    expect(harness.tasks[0]?.data.direction).toBe('LONG');
    expect(harness.timers.getPendingTimerCount()).toBe(0);
  });

  it('processed replanRouteAfterTask 不重复派发已处理 due route', async () => {
    const harness = await createHarness({ nowMs: 400_000 });
    harness.runtime.start();
    await flushDispatch();
    harness.tasks.length = 0;
    const baseline = harness.getAuthorization('LONG');

    harness.runtime.replanRouteAfterTask({ ...baseline, taskTimeMs: 400_000, status: 'processed' });

    expect(harness.tasks).toHaveLength(0);
    expect(harness.timers.getPendingTimerCount()).toBe(0);
  });

  it('processed replanRouteAfterTask 会为未来 due route 安排 timer', async () => {
    let dueAtMs = 400_000;
    const harness = await createHarness({
      nowMs: 400_000,
      calculateDueAtMs: () => dueAtMs,
    });
    harness.runtime.start();
    await flushDispatch();
    harness.tasks.length = 0;
    const baseline = harness.getAuthorization('LONG');

    dueAtMs = 405_000;
    harness.runtime.replanRouteAfterTask({ ...baseline, taskTimeMs: 400_000, status: 'processed' });
    harness.runtime.replanRouteAfterTask({
      ...harness.getAuthorization('SHORT'),
      taskTimeMs: 400_000,
      status: 'processed',
    });

    expect(harness.tasks).toHaveLength(0);
    expect(harness.timers.getPendingTimerAts()).toEqual([405_000, 405_000]);
  });

  it('skipped replanRouteAfterTask 不注册恢复 timer', async () => {
    const harness = await createHarness({ nowMs: 400_000 });
    harness.runtime.start();
    await flushDispatch();
    harness.tasks.length = 0;
    const baseline = harness.getAuthorization('LONG');

    harness.runtime.replanRouteAfterTask({ ...baseline, taskTimeMs: 400_000, status: 'skipped' });

    expect(harness.tasks).toHaveLength(0);
    expect(harness.timers.getPendingTimerCount()).toBe(0);
  });

  it('blocked replanRouteAfterTask 保留 baseline 并等待 null-to-open gate 重新派发', async () => {
    const harness = await createHarness({ nowMs: 400_000 });
    harness.runtime.start();
    await flushDispatch();
    harness.tasks.length = 0;
    const baseline = harness.getAuthorization('LONG');

    harness.runtime.replanRouteAfterTask({ ...baseline, taskTimeMs: 400_000, status: 'blocked' });
    harness.runtime.replanRouteAfterTask({
      ...harness.getAuthorization('SHORT'),
      taskTimeMs: 400_000,
      status: 'blocked',
    });

    expect(harness.tasks).toHaveLength(0);
    expect(harness.timers.getPendingTimerCount()).toBe(0);

    harness.subscriptions.emitGate({
      previousCanTrade: null,
      nextCanTrade: true,
    });
    await flushDispatch();

    expect(harness.tasks).toHaveLength(2);
    expect(
      harness.tasks.some(
        (task) =>
          task.data.direction === baseline.direction && task.data.symbol === baseline.symbol,
      ),
    ).toBe(true);
  });

  it('waiting-empty route 收到 blocked outcome 后转交 gate-open owner', async () => {
    const harness = await createHarness({ nowMs: 400_000 });
    harness.runtime.start();
    await flushDispatch();
    harness.tasks.length = 0;
    const baseline = harness.getAuthorization('LONG');

    harness.runtime.markWaitingEmpty(baseline);
    harness.subscriptions.emitGate({ previousCanTrade: true, nextCanTrade: false });
    await flushDispatch();
    harness.runtime.replanRouteAfterTask({ ...baseline, taskTimeMs: 400_000, status: 'blocked' });
    harness.runtime.replanRouteAfterTask({
      ...harness.getAuthorization('SHORT'),
      taskTimeMs: 400_000,
      status: 'blocked',
    });

    harness.subscriptions.emitOrder();
    await flushDispatch();
    await harness.subscriptions.emitFresh();

    expect(harness.tasks).toHaveLength(0);

    harness.subscriptions.emitGate({
      previousCanTrade: false,
      nextCanTrade: true,
    });
    await flushDispatch();

    expect(harness.tasks).toHaveLength(2);
    expect(
      harness.tasks.some(
        (task) =>
          task.data.direction === baseline.direction && task.data.symbol === baseline.symbol,
      ),
    ).toBe(true);
  });

  it('failed outcome 为同 baseline 安排明确未来 one-shot，seat/order/fresh/gate 不提前热循环', async () => {
    const harness = await createHarness({ nowMs: 400_000 });
    harness.runtime.start();
    await flushDispatch();
    harness.tasks.length = 0;
    const baseline = harness.getAuthorization('LONG');

    harness.runtime.replanRouteAfterTask({
      ...baseline,
      taskTimeMs: 400_000,
      status: 'failed',
      reevaluateAtMs: harness.timers.now().getTime() + TRADING.INTERVAL_MS,
    });
    harness.symbolRegistry.updateSeatState('LONG', createActiveSeat('BULL.HK', 1_000));
    await flushDispatch();
    harness.subscriptions.emitOrder();
    await flushDispatch();
    await harness.subscriptions.emitFresh();
    harness.subscriptions.emitGate({
      previousCanTrade: false,
      nextCanTrade: true,
    });
    await flushDispatch();

    expect(
      harness.tasks.some(
        (task) =>
          task.data.direction === baseline.direction && task.data.symbol === baseline.symbol,
      ),
    ).toBe(false);
    expect(harness.timers.getPendingTimerAts()).toEqual([400_000 + TRADING.INTERVAL_MS]);

    harness.timers.setNow(400_000 + TRADING.INTERVAL_MS);
    harness.timers.fireNext();
    await flushDispatch();

    expect(
      harness.tasks.filter(
        (task) =>
          task.data.direction === baseline.direction && task.data.symbol === baseline.symbol,
      ),
    ).toHaveLength(1);
    expect(harness.timers.getPendingTimerCount()).toBe(0);
  });

  it('waiting-empty route 收到 failed outcome 后清理等待并只由未来 one-shot 重评估', async () => {
    const harness = await createHarness({ nowMs: 400_000 });
    harness.runtime.start();
    await flushDispatch();
    harness.tasks.length = 0;
    const baseline = harness.getAuthorization('LONG');

    harness.runtime.markWaitingEmpty(baseline);
    harness.runtime.replanRouteAfterTask({
      ...baseline,
      taskTimeMs: 400_000,
      status: 'failed',
      reevaluateAtMs: harness.timers.now().getTime() + TRADING.INTERVAL_MS,
    });
    harness.subscriptions.emitOrder();
    await flushDispatch();
    await harness.subscriptions.emitFresh();

    expect(harness.tasks).toHaveLength(0);
    expect(harness.timers.getPendingTimerAts()).toEqual([400_000 + TRADING.INTERVAL_MS]);

    harness.timers.setNow(400_000 + TRADING.INTERVAL_MS);
    harness.timers.fireNext();
    await flushDispatch();

    expect(
      harness.tasks.some(
        (task) =>
          task.data.direction === baseline.direction && task.data.symbol === baseline.symbol,
      ),
    ).toBe(true);
  });

  it('failed 后同 baseline 的晚到 processed outcome 不能提前清除延迟重评估边界', async () => {
    const harness = await createHarness({ nowMs: 400_000 });
    harness.runtime.start();
    await flushDispatch();
    harness.tasks.length = 0;
    const baseline = harness.getAuthorization('LONG');

    harness.runtime.replanRouteAfterTask({
      ...baseline,
      taskTimeMs: 400_000,
      status: 'failed',
      reevaluateAtMs: harness.timers.now().getTime() + TRADING.INTERVAL_MS,
    });
    harness.runtime.replanRouteAfterTask({ ...baseline, taskTimeMs: 400_000, status: 'processed' });
    harness.subscriptions.emitGate({
      previousCanTrade: false,
      nextCanTrade: true,
    });
    await flushDispatch();

    expect(
      harness.tasks.some(
        (task) =>
          task.data.direction === baseline.direction && task.data.symbol === baseline.symbol,
      ),
    ).toBe(false);
    expect(harness.timers.getPendingTimerAts()).toEqual([400_000 + TRADING.INTERVAL_MS]);
  });

  it('failed 后同 baseline 的晚到 waiting-empty 回写不能重新打开 order/fresh 派发', async () => {
    const harness = await createHarness({ nowMs: 400_000 });
    harness.runtime.start();
    await flushDispatch();
    harness.tasks.length = 0;
    const baseline = harness.getAuthorization('LONG');

    harness.runtime.replanRouteAfterTask({
      ...baseline,
      taskTimeMs: 400_000,
      status: 'failed',
      reevaluateAtMs: harness.timers.now().getTime() + TRADING.INTERVAL_MS,
    });
    harness.runtime.markWaitingEmpty(baseline);
    harness.subscriptions.emitOrder();
    await flushDispatch();
    await harness.subscriptions.emitFresh();

    expect(
      harness.tasks.some(
        (task) =>
          task.data.direction === baseline.direction && task.data.symbol === baseline.symbol,
      ),
    ).toBe(false);
    expect(harness.timers.getPendingTimerAts()).toEqual([400_000 + TRADING.INTERVAL_MS]);
  });

  it('failed 后 seat baseline 变化允许新 baseline 正常派发', async () => {
    const harness = await createHarness({
      nowMs: 400_000,
      calculateDueAtMs: ({ startMs }) => (startMs === 500_000 ? 400_000 : 1_000),
    });
    harness.runtime.start();
    await flushDispatch();
    harness.tasks.length = 0;
    const baseline = harness.getAuthorization('LONG');

    harness.runtime.replanRouteAfterTask({
      ...baseline,
      taskTimeMs: 400_000,
      status: 'failed',
      reevaluateAtMs: harness.timers.now().getTime() + TRADING.INTERVAL_MS,
    });

    harness.symbolRegistry.updateSeatStateWithVersionBump(
      'LONG',
      createActiveSeat('BULL2.HK', 500_000),
    );
    await flushDispatch();

    expect(harness.tasks).toHaveLength(1);
    expect(harness.tasks[0]?.data).toMatchObject({
      direction: 'LONG',
      symbol: 'BULL2.HK',
      lastSeatActivatedAt: 500_000,
    });
  });

  it('waiting-empty route 收到 skipped outcome 会清理等待且不注册 timer', async () => {
    const harness = await createHarness({ nowMs: 400_000 });
    harness.runtime.start();
    await flushDispatch();
    harness.tasks.length = 0;
    const baseline = harness.getAuthorization('LONG');

    harness.runtime.markWaitingEmpty(baseline);
    harness.runtime.replanRouteAfterTask({ ...baseline, taskTimeMs: 400_000, status: 'skipped' });
    harness.subscriptions.emitOrder();
    await flushDispatch();

    expect(harness.tasks).toHaveLength(0);
    expect(harness.timers.getPendingTimerCount()).toBe(0);
  });

  it('同一 baseline 连续 failed outcome 只保留一个未来重评估 timer', async () => {
    const harness = await createHarness({ nowMs: 400_000 });
    harness.runtime.start();
    await flushDispatch();
    harness.tasks.length = 0;
    const baseline = harness.getAuthorization('LONG');

    harness.runtime.replanRouteAfterTask({
      ...baseline,
      taskTimeMs: 400_000,
      status: 'failed',
      reevaluateAtMs: harness.timers.now().getTime() + TRADING.INTERVAL_MS,
    });

    harness.runtime.replanRouteAfterTask({
      ...baseline,
      taskTimeMs: 400_000,
      status: 'failed',
      reevaluateAtMs: harness.timers.now().getTime() + TRADING.INTERVAL_MS,
    });

    expect(harness.tasks).toHaveLength(0);
    expect(harness.timers.getPendingTimerAts()).toEqual([400_000 + TRADING.INTERVAL_MS]);
  });

  it('stopAndDrain 取消 failed outcome 的未来重评估 timer 与失效 callback', async () => {
    const harness = await createHarness({ nowMs: 400_000 });
    harness.runtime.start();
    await flushDispatch();
    harness.tasks.length = 0;
    const baseline = harness.getAuthorization('LONG');

    harness.runtime.replanRouteAfterTask({
      ...baseline,
      taskTimeMs: 400_000,
      status: 'failed',
      reevaluateAtMs: harness.timers.now().getTime() + TRADING.INTERVAL_MS,
    });
    const staleCallback = harness.timers.captureNextCallback();

    await harness.runtime.stopAndDrain();
    staleCallback?.();

    expect(harness.tasks).toHaveLength(0);
    expect(harness.timers.getPendingTimerCount()).toBe(0);
  });

  it('stale failed outcome 不能修改新激活 route', async () => {
    const harness = await createHarness({
      nowMs: 400_000,
      calculateDueAtMs: ({ startMs }) => (startMs === 500_000 ? 700_000 : 1_000),
    });
    harness.runtime.start();
    await flushDispatch();
    harness.tasks.length = 0;
    const baseline = harness.getAuthorization('LONG');

    harness.symbolRegistry.updateSeatStateWithVersionBump(
      'LONG',
      createActiveSeat('BULL2.HK', 500_000),
    );
    await flushDispatch();
    harness.runtime.replanRouteAfterTask({
      ...baseline,
      taskTimeMs: 400_000,
      status: 'failed',
      reevaluateAtMs: harness.timers.now().getTime() + TRADING.INTERVAL_MS,
    });

    expect(harness.tasks).toHaveLength(0);
    expect(harness.timers.getPendingTimerAts()).toContain(700_000);
  });

  it('stale due timer callback 不能清除新 route timer ownership', async () => {
    const harness = await createHarness({
      nowMs: 100_000,
      calculateDueAtMs: ({ startMs }) => {
        if (startMs === 1_000) {
          return 300_000;
        }

        if (startMs === 600_000) {
          return 700_000;
        }

        return 800_000;
      },
    });
    harness.runtime.start();
    await flushDispatch();
    const staleCallback = harness.timers.captureNextCallback();

    harness.symbolRegistry.updateSeatStateWithVersionBump(
      'LONG',
      createActiveSeat('BULL2.HK', 600_000),
    );
    await flushDispatch();
    staleCallback?.();
    await harness.runtime.stopAndDrain();

    expect(harness.tasks).toHaveLength(0);
    expect(harness.timers.getPendingTimerCount()).toBe(0);
  });

  it('failed outcome timer 在 baseline 变化时取消且不影响新 route timer ownership', async () => {
    const harness = await createHarness({
      nowMs: 400_000,
      calculateDueAtMs: ({ startMs }) => (startMs === 500_000 ? 700_000 : 1_000),
    });
    harness.runtime.start();
    await flushDispatch();
    harness.tasks.length = 0;
    const baseline = harness.getAuthorization('LONG');

    harness.runtime.replanRouteAfterTask({
      ...baseline,
      taskTimeMs: 400_000,
      status: 'failed',
      reevaluateAtMs: harness.timers.now().getTime() + TRADING.INTERVAL_MS,
    });
    const staleCallback = harness.timers.captureNextCallback();
    expect(harness.timers.getPendingTimerAts()).toEqual([400_000 + TRADING.INTERVAL_MS]);

    harness.symbolRegistry.updateSeatStateWithVersionBump(
      'LONG',
      createActiveSeat('BULL2.HK', 500_000),
    );
    await flushDispatch();
    staleCallback?.();

    expect(harness.tasks).toHaveLength(0);
    expect(harness.timers.getPendingTimerAts()).toEqual([700_000]);

    await harness.runtime.stopAndDrain();
    expect(harness.timers.getPendingTimerCount()).toBe(0);
  });

  it('stale mark/clear/replan baseline 不能修改新激活 route', async () => {
    const harness = await createHarness({
      nowMs: 100_000,
      calculateDueAtMs: ({ startMs }) => (startMs === 600_000 ? 700_000 : 100_000),
    });
    harness.runtime.start();
    await flushDispatch();
    const staleBaseline = harness.getAuthorization('LONG');
    harness.symbolRegistry.updateSeatStateWithVersionBump(
      'LONG',
      createActiveSeat('BULL2.HK', 600_000),
    );
    await flushDispatch();
    harness.tasks.length = 0;

    harness.runtime.markWaitingEmpty(staleBaseline);
    harness.subscriptions.emitOrder();
    await flushDispatch();
    harness.runtime.clearWaitingEmpty(staleBaseline);
    harness.runtime.replanRouteAfterTask({
      ...staleBaseline,
      taskTimeMs: 100_000,
      status: 'processed',
    });

    expect(harness.tasks).toHaveLength(0);
    expect(harness.timers.getPendingTimerAts()).toContain(700_000);
  });

  it('gate open 不破坏 waiting-empty，后续 order/fresh 仍重派同一 baseline', async () => {
    const harness = await createHarness({ nowMs: 400_000 });
    harness.runtime.start();
    await flushDispatch();
    harness.tasks.length = 0;
    const baseline = harness.getAuthorization('LONG');
    harness.runtime.markWaitingEmpty(baseline);
    harness.runtime.replanRouteAfterTask({ ...baseline, taskTimeMs: 400_000, status: 'processed' });
    harness.runtime.replanRouteAfterTask({
      ...harness.getAuthorization('SHORT'),
      taskTimeMs: 400_000,
      status: 'processed',
    });

    harness.subscriptions.emitGate({
      previousCanTrade: false,
      nextCanTrade: true,
    });
    await flushDispatch();

    harness.subscriptions.emitGate({
      previousCanTrade: true,
      nextCanTrade: true,
    });
    await flushDispatch();

    expect(harness.tasks).toHaveLength(1);
    expect(harness.tasks[0]?.data.direction).toBe('SHORT');

    harness.subscriptions.emitOrder();
    await flushDispatch();
    expect(harness.tasks[1]?.data.readinessReceipt).toBe(baseline.readinessReceipt);
    harness.runtime.replanRouteAfterTask({
      ...harness.getAuthorization('LONG'),
      taskTimeMs: 400_000,
      status: 'processed',
    });
    const beforeFreshToken = harness.snapshot.getView().token;
    await harness.subscriptions.emitFresh();

    expect(harness.tasks).toHaveLength(3);
    const route = {
      direction: baseline.direction,
      symbol: baseline.symbol,
      seatVersion: baseline.seatVersion,
      lastSeatActivatedAt: baseline.lastSeatActivatedAt,
      dayEpoch: baseline.dayEpoch,
    };
    expect(harness.tasks[1]?.data).toMatchObject(route);
    expect(harness.tasks[2]?.data).toMatchObject(route);
    const freshTask = harness.tasks[2];
    if (freshTask === undefined) throw new Error('real fresh event must issue a task');

    expect(freshTask.data.readinessReceipt.settlementVersion).toBe(
      baseline.readinessReceipt.settlementVersion + 1,
    );

    // ordinary commit 已推进 canonical revision，但没有改写原 settlement 完成凭据。
    expect(freshTask.data.readinessReceipt.snapshotToken.commitRevision).toBe(
      beforeFreshToken.commitRevision + 1,
    );
    expect(freshTask.data.readinessReceipt.snapshotToken).toBe(harness.snapshot.getView().token);
    expect(baseline.canContinue()).toBe(false);
    expect(baseline.isRouteCurrent()).toBe(true);
    expect(freshTask.data.canContinue()).toBe(true);
    expect(freshTask.data.isRouteCurrent()).toBe(true);
  });

  it('seat truth 事件只按 direction route 重算，不要求 monitorSymbol fail-fast', async () => {
    const harness = await createHarness({ nowMs: 400_000 });
    harness.runtime.start();
    await flushDispatch();
    harness.tasks.length = 0;

    expect(() => {
      harness.symbolRegistry.updateSeatStateWithVersionBump('LONG', {
        symbol: 'BULL2.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: 500_000,
        callPrice: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      });
    }).not.toThrow();
    await flushDispatch();

    expect(harness.tasks).toHaveLength(0);
    expect(harness.timers.getPendingTimerAts()).toContain(800_000);
  });
});
