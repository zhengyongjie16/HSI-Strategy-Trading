/** 有状态替代策略验收：验证宿主 delayed emitter 与策略生命周期公共契约。 */
import { describe, expect, it } from 'bun:test';
import { createOpenRebuildContextFixture } from '../lifecycle/fixtures/openRebuildContext.js';
import { createCleanup } from '../../../src/app/shutdown/createCleanup.js';
import { createSelectedStrategy } from '../../../src/app/startup/createSelectedStrategy.js';
import { createSignalRuntimeDomain } from '../../../src/runtime/lifecycle/cacheDomains/signalRuntimeDomain.js';
import { createMonitorTaskQueue } from '../../../src/runtime/asyncProgram/monitorTaskQueue/index.js';
import { createSeatRuntimeCleanupDispatcher } from '../../../src/runtime/seatRuntimeCleanupDispatcher/index.js';
import { createEventHarness } from './fixtures.js';
import { createStatefulStrategyFixture } from './statefulStrategyFixture.js';
import { createLoggerDouble, createMonitorContextDouble } from '../../helpers/testDoubles.js';
import type { PreparedStrategySelection } from '../../../src/app/startup/types.js';
import type { StrategyDeps } from '../../../src/types/strategy.js';
import type { RuntimeScheduler } from '../../../src/types/runtime.js';
import type { SignalRuntimeDomainDeps } from '../../../src/runtime/lifecycle/cacheDomains/types.js';
import type { MonitorTaskDataMap } from '../../../src/runtime/asyncProgram/monitorTaskProcessor/types.js';
import type { EventHarness } from './types.js';

type ManualTimer = {
  readonly callback: () => void;
  readonly delayMs: number;
  readonly handle: ReturnType<typeof setTimeout>;
  cleared: boolean;
};

type ManualScheduler = Readonly<{
  readonly runtime: RuntimeScheduler;
  readonly timers: ManualTimer[];
}>;

/** 复用现有 runtime 测试的手动 scheduler；句柄立即取消，回调只由用例推进。 */
function createManualScheduler(): ManualScheduler {
  const timers: ManualTimer[] = [];
  return {
    timers,
    runtime: {
      scheduleTimer(callback, delayMs) {
        const handle = setTimeout(() => {}, 2_147_483_647);
        clearTimeout(handle);
        timers.push({ callback, delayMs, handle, cleared: false });
        return handle;
      },
      clearTimer(handle) {
        const timer = timers.find((entry) => entry.handle === handle);
        if (timer !== undefined) {
          timer.cleared = true;
          clearTimeout(handle);
        }
      },
    },
  };
}

function emptySeat() {
  return {
    symbol: null,
    status: 'EMPTY' as const,
    lastSeatActivatedAt: null,
    lastSwitchAt: null,
    lastSearchAt: null,
    searchFailCountToday: 0,
    frozenTradingDayKey: null,
  };
}

/** 只替换 signalRuntime domain 的外围 owners，保留真实 midnight/open 编排。 */
function createSignalDomain(h: EventHarness) {
  const owner = {
    start: () => {},
    stop: () => {},
    stopAndDrain: async () => {},
    restart: () => {},
  };
  const switchOwner = { ...owner, handoffPendingSwitch: () => {} };
  const seatOwner = { start: () => {}, stop: () => {} };
  const quoteSubscriptionOwner = {
    reconcileFromCurrentTruth: async () => {},
    start: () => {},
    stopAndDrain: async () => {},
  };
  const postTradeOwner = {
    abortWaiting: () => {},
    resetAbort: () => {},
    start: () => {},
    stopAndDrain: async () => {},
    midnightClear: () => {},
    completeRebuildBaseline: async () => true,
  };
  const monitorContext = createMonitorContextDouble({ strategy: h.strategy });
  const deps: SignalRuntimeDomainDeps = {
    termination: h.termination,
    logger: createLoggerDouble(),
    monitorContext,
    buyProcessor: owner,
    sellProcessor: owner,
    monitorTaskProcessor: owner,
    businessEventProgram: h.program,
    tradingRiskEventRuntime: owner,
    monitorQuoteEventRuntime: owner,
    monitorDisplayRuntime: owner,
    tradingQuoteDisplayRuntime: owner,
    switchWakeupRuntime: switchOwner,
    periodicSwitchWakeupRuntime: owner,
    autoSearchWakeupRuntime: owner,
    seatActivationDispatcher: seatOwner,
    seatRuntimeCleanupDispatcher: seatOwner,
    orderMonitor: { startRuntime: () => {}, stopRuntimeAndDrain: async () => {} },
    postTradeConsistencyRuntime: postTradeOwner,
    quoteSubscriptionRuntime: quoteSubscriptionOwner,
    buyTaskQueue: h.buyTaskQueue,
    sellTaskQueue: h.sellTaskQueue,
    monitorTaskQueue: createMonitorTaskQueue<MonitorTaskDataMap>(createLoggerDouble()),
  };
  return { domain: createSignalRuntimeDomain(deps), monitorContext };
}

describe('stateful replacement strategy public contract', () => {
  it('delayed emitter survives direction invalidation only for the valid direction', async () => {
    const scheduler = createManualScheduler();
    const fixture = createStatefulStrategyFixture(scheduler.runtime);
    const h = createEventHarness({ strategy: fixture.strategy });
    const dispatcher = createSeatRuntimeCleanupDispatcher({
      logger: createLoggerDouble(),
      symbolRegistry: h.symbolRegistry,
      monitorContext: {
        strategy: h.strategy,
        riskChecker: { clearLongWarrantInfo: () => {}, clearShortWarrantInfo: () => {} },
      },
      buyTaskQueue: h.buyTaskQueue,
      sellTaskQueue: h.sellTaskQueue,
      monitorTaskQueue: createMonitorTaskQueue<MonitorTaskDataMap>(createLoggerDouble()),
    });

    const originTime = h.mutable.nowMs;
    dispatcher.start();
    h.program.start();
    h.publish();
    await Promise.resolve();
    expect(scheduler.timers).toHaveLength(2);
    expect(scheduler.timers.every((timer) => timer.delayMs === 1_000)).toBeTrue();
    expect(h.buyTaskQueue.isEmpty()).toBeTrue();
    h.mutable.nowMs += 5_000;

    const longTimer = scheduler.timers.at(0);
    const shortTimer = scheduler.timers.at(1);
    if (longTimer === undefined || shortTimer === undefined) {
      throw new Error('stateful fixture must schedule both directions');
    }

    h.symbolRegistry.updateSeatStateWithVersionBump('LONG', emptySeat());
    expect(fixture.lifecycle.invalidatedDirections).toEqual(['LONG']);
    expect(longTimer.cleared).toBeTrue();
    expect(shortTimer.cleared).toBeFalse();

    longTimer.callback();
    expect(h.buyTaskQueue.isEmpty()).toBeTrue();
    shortTimer.callback();
    expect(h.buyTaskQueue.pop()?.data).toMatchObject({
      action: 'BUYPUT',
      symbol: 'BEAR.HK',
      seatVersion: 1,
      triggerTime: new Date(originTime),
      reason: 'stateful-delayed',
    });

    // 被方向失效取消的 delayed callback 即使晚到也不能再输出。
    longTimer.callback();
    expect(h.buyTaskQueue.isEmpty()).toBeTrue();

    dispatcher.stop();
    await h.program.stopAndDrain();
  });

  it('real signalRuntime reset preserves the instance; cleanup destroys it once and rejects late callbacks', async () => {
    const scheduler = createManualScheduler();
    const fixture = createStatefulStrategyFixture(scheduler.runtime);
    const h = createEventHarness({ strategy: fixture.strategy });
    const { domain, monitorContext } = createSignalDomain(h);
    expect(monitorContext.strategy).toBe(h.strategy);

    h.program.start();
    h.publish();
    await Promise.resolve();
    const firstTimers = [...scheduler.timers];
    expect(firstTimers).toHaveLength(2);

    await domain.midnightClear({
      now: new Date('2026-07-16T00:00:00.000Z'),
      runtime: { dayKey: '2026-07-16', canTradeNow: false, isTradingDay: true },
    });
    expect(fixture.lifecycle.resetCount).toBe(1);
    expect(firstTimers.every((timer) => timer.cleared)).toBeTrue();
    for (const timer of firstTimers) timer.callback();

    expect(h.buyTaskQueue.isEmpty()).toBeTrue();
    expect(h.sellTaskQueue.isEmpty()).toBeTrue();

    h.stateFixtures.lifecycleState.currentDayKey = '2026-07-16';
    h.mutable.nowMs = Date.parse('2026-07-16T02:00:00.000Z');
    const ctx = await createOpenRebuildContextFixture({
      now: new Date(h.mutable.nowMs),
      runtime: { dayKey: '2026-07-16', canTradeNow: true, isTradingDay: true },
      termination: h.termination,
    });
    const result = await domain.openRebuild(ctx);
    expect(result.status).toBe('COMMITTED');
    if (result.status !== 'COMMITTED') throw new Error('Stateful strategy restart did not commit');

    expect(result.snapshotToken).toBe(ctx.snapshotToken);
    h.publish();
    await Promise.resolve();
    const nextTimers = scheduler.timers.slice(firstTimers.length);
    expect(nextTimers).toHaveLength(2);
    for (const timer of nextTimers) timer.callback();

    expect(h.buyTaskQueue.pop()?.data.action).toBe('BUYCALL');
    expect(h.buyTaskQueue.pop()?.data.action).toBe('BUYPUT');
    expect(h.buyTaskQueue.isEmpty()).toBeTrue();

    h.publish();
    await Promise.resolve();
    const exitTimers = scheduler.timers.slice(firstTimers.length + nextTimers.length);
    expect(exitTimers).toHaveLength(2);

    const cleanup = createCleanup();
    cleanup.register({
      phase: 'STOP_BUSINESS_EVENT_PROGRAM',
      step: '停止测试 BusinessEventProgram',
      handler: () => h.program.stopAndDrain(),
    });
    const selection: PreparedStrategySelection = {
      strategyId: h.strategy.strategyId,
      prepared: { create: () => h.strategy },
    };
    const strategyDeps: StrategyDeps = {
      clock: h.deps.clock,
      scheduler: scheduler.runtime,
      logger: createLoggerDouble(),
      onFatalError: h.termination.reportFatalError,
    };
    const selected = createSelectedStrategy(selection, strategyDeps, cleanup);
    expect(selected).toBe(h.strategy);
    expect(selected).toBe(monitorContext.strategy);

    const firstCleanup = cleanup.execute();
    const secondCleanup = cleanup.execute();
    expect(secondCleanup).toBe(firstCleanup);
    await firstCleanup;
    expect(fixture.lifecycle.destroyCount).toBe(1);
    expect(exitTimers.every((timer) => timer.cleared)).toBeTrue();
    for (const timer of exitTimers) timer.callback();

    expect(h.buyTaskQueue.isEmpty()).toBeTrue();
    expect(h.sellTaskQueue.isEmpty()).toBeTrue();
  });
});
