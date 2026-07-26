/**
 * PeriodicSwitchWakeupRuntime
 *
 * 职责：
 * - 接管 ACTIVE seat 周期换标 due timer 的唯一 ownership
 * - 基于 seat truth baseline 隔离旧 timer、旧 waiting-empty 与旧任务回调
 * - 通过 AUTO_SYMBOL_TICK latest-only 任务推进周期换标，不向 timeWakeupPlanner 暴露候选
 */
import { TRADING } from '../../constants/index.js';
import { scheduleBoundedOneShotAt } from '../../utils/timer/index.js';
import type { SeatTruthChangedListener } from '../../types/seat.js';
import type { MonitorTaskInput } from '../asyncProgram/monitorTaskQueue/types.js';
import type { MonitorTaskDataMap } from '../asyncProgram/monitorTaskProcessor/types.js';
import type { TradingGateStateChangedEvent } from '../tradingGateEventRuntime/types.js';
import type {
  PeriodicSwitchRouteBaseline,
  PeriodicSwitchRouteState,
  PeriodicSwitchWakeupRuntime,
  PeriodicSwitchWakeupRuntimeDeps,
} from './types.js';

function baselineMatches(
  left: PeriodicSwitchRouteBaseline,
  right: PeriodicSwitchRouteBaseline,
): boolean {
  return (
    left.direction === right.direction &&
    left.symbol === right.symbol &&
    left.seatVersion === right.seatVersion &&
    left.lastSeatActivatedAt === right.lastSeatActivatedAt
  );
}

function isValidSeatVersion(seatVersion: number): boolean {
  return Number.isSafeInteger(seatVersion) && seatVersion > 0;
}

function isFailureReevaluationPending(
  state: PeriodicSwitchRouteState,
  baseline: PeriodicSwitchRouteBaseline,
): boolean {
  return (
    state.failureReevaluationAtMs !== null &&
    state.baseline !== null &&
    baselineMatches(state.baseline, baseline)
  );
}

const PERIODIC_SWITCH_DIRECTIONS: ReadonlyArray<'LONG' | 'SHORT'> = ['LONG', 'SHORT'];

/**
 * 创建周期换标唤醒 runtime。
 *
 * @param deps runtime 依赖
 * @returns PeriodicSwitchWakeupRuntime 实例
 */
export function createPeriodicSwitchWakeupRuntime(
  deps: PeriodicSwitchWakeupRuntimeDeps,
): PeriodicSwitchWakeupRuntime {
  let running = false;
  let unsubscribeSeatTruthChanged: (() => void) | null = null;
  let unsubscribeOrderStateChanged: (() => void) | null = null;
  let unsubscribeFreshReached: (() => void) | null = null;
  let unsubscribeGateStateChanged: (() => void) | null = null;
  const routeStates = new Map<'LONG' | 'SHORT', PeriodicSwitchRouteState>();

  function getRouteState(direction: 'LONG' | 'SHORT'): PeriodicSwitchRouteState {
    const currentState = routeStates.get(direction);
    if (currentState !== undefined) {
      return currentState;
    }

    const nextState: PeriodicSwitchRouteState = {
      baseline: null,
      timerHandle: null,
      waitingEmpty: null,
      failureReevaluationAtMs: null,
    };
    routeStates.set(direction, nextState);
    return nextState;
  }

  function clearRouteTimer(direction: 'LONG' | 'SHORT'): void {
    const state = routeStates.get(direction);
    if (state?.timerHandle === null || state === undefined) {
      return;
    }

    state.timerHandle.cancel();
    state.timerHandle = null;
  }

  function readCurrentBaseline(direction: 'LONG' | 'SHORT'): PeriodicSwitchRouteBaseline | null {
    const autoSearchConfig = deps.monitorContext.config.autoSearchConfig;
    if (!autoSearchConfig.autoSearchEnabled || autoSearchConfig.switchIntervalMinutes <= 0) {
      return null;
    }

    const seatState = deps.symbolRegistry.getSeatState(direction);
    const seatVersion = deps.symbolRegistry.getSeatVersion(direction);
    if (
      seatState.status !== 'ACTIVE' ||
      seatState.lastSeatActivatedAt === null ||
      !Number.isFinite(seatState.lastSeatActivatedAt) ||
      !isValidSeatVersion(seatVersion)
    ) {
      return null;
    }

    return {
      direction,
      symbol: seatState.symbol,
      seatVersion,
      lastSeatActivatedAt: seatState.lastSeatActivatedAt,
    };
  }

  function getSwitchIntervalMinutes(): number | null {
    const switchIntervalMinutes = deps.monitorContext.config.autoSearchConfig.switchIntervalMinutes;
    if (switchIntervalMinutes <= 0) {
      return null;
    }

    return switchIntervalMinutes;
  }

  function dispatchAutoSymbolTick(baseline: PeriodicSwitchRouteBaseline): void {
    const currentTimeMs = deps.now().getTime();
    const data: MonitorTaskDataMap['AUTO_SYMBOL_TICK'] = {
      direction: baseline.direction,
      seatVersion: baseline.seatVersion,
      symbol: baseline.symbol,
      lastSeatActivatedAt: baseline.lastSeatActivatedAt,
      currentTimeMs,
    };
    const task: MonitorTaskInput<MonitorTaskDataMap, 'AUTO_SYMBOL_TICK'> = {
      type: 'AUTO_SYMBOL_TICK',
      dedupeKey: `AUTO_SYMBOL_TICK:${baseline.direction}`,
      data,
    };

    deps.monitorTaskQueue.scheduleLatest(task);
  }

  function invalidateRouteIfBaselineChanged(
    direction: 'LONG' | 'SHORT',
    nextBaseline: PeriodicSwitchRouteBaseline | null,
  ): PeriodicSwitchRouteState {
    const state = getRouteState(direction);
    const currentBaseline = state.baseline;
    const baselineChanged =
      currentBaseline !== null &&
      (nextBaseline === null || !baselineMatches(currentBaseline, nextBaseline));

    if (baselineChanged) {
      clearRouteTimer(direction);
      state.waitingEmpty = null;
      state.failureReevaluationAtMs = null;
    }

    state.baseline = nextBaseline;
    return state;
  }

  /**
   * 对单 route 重新读取权威 truth 并安排一次 due 行为。
   * baseline 不完整或 dueAtMs 为 null 时只清理旧派生状态，不额外补排到期动作。
   */
  function planRoute(direction: 'LONG' | 'SHORT'): void {
    if (!running) {
      return;
    }

    const baseline = readCurrentBaseline(direction);
    const state = invalidateRouteIfBaselineChanged(direction, baseline);
    if (baseline === null || state.waitingEmpty !== null) {
      return;
    }

    if (isFailureReevaluationPending(state, baseline)) {
      return;
    }

    const switchIntervalMinutes = getSwitchIntervalMinutes();
    if (switchIntervalMinutes === null) {
      return;
    }

    const dueAtMs = deps.calculateDueAtMs({
      startMs: baseline.lastSeatActivatedAt,
      switchIntervalMinutes,
    });
    if (dueAtMs === null) {
      clearRouteTimer(direction);
      return;
    }

    const nowMs = deps.now().getTime();
    if (dueAtMs <= nowMs) {
      clearRouteTimer(direction);
      dispatchAutoSymbolTick(baseline);
      return;
    }

    clearRouteTimer(direction);
    const timerHandle = scheduleBoundedOneShotAt({
      atMs: dueAtMs,
      now: deps.now,
      scheduleTimer: deps.scheduleTimer,
      clearTimer: deps.clearTimer,
      onDue: () => {
        if (state.timerHandle !== timerHandle) {
          return;
        }

        state.timerHandle = null;
        if (!running) {
          return;
        }

        const currentBaseline = readCurrentBaseline(direction);
        if (currentBaseline !== null && baselineMatches(currentBaseline, baseline)) {
          dispatchAutoSymbolTick(baseline);
        }
      },
    });
    state.timerHandle = timerHandle;
  }

  function seedRoutes(): void {
    for (const direction of PERIODIC_SWITCH_DIRECTIONS) {
      planRoute(direction);
    }
  }

  const handleSeatTruthChanged: SeatTruthChangedListener = (event) => {
    planRoute(event.direction);
  };

  function redispatchWaitingEmptyRoutes(): void {
    if (!running) {
      return;
    }

    for (const [direction, state] of routeStates) {
      const waitingBaseline = state.waitingEmpty;
      if (waitingBaseline === null) {
        continue;
      }

      const currentBaseline = readCurrentBaseline(waitingBaseline.direction);
      if (currentBaseline === null || !baselineMatches(currentBaseline, waitingBaseline)) {
        routeStates.delete(direction);
        continue;
      }

      dispatchAutoSymbolTick(waitingBaseline);
    }
  }

  function handleGateStateChanged(event: TradingGateStateChangedEvent): void {
    if (event.previousCanTrade === true || !event.nextCanTrade) {
      return;
    }

    for (const direction of PERIODIC_SWITCH_DIRECTIONS) {
      const state = routeStates.get(direction);
      if (state !== undefined && state.waitingEmpty !== null) {
        continue;
      }

      planRoute(direction);
    }
  }

  function markWaitingEmpty(baseline: PeriodicSwitchRouteBaseline): void {
    if (!running) {
      return;
    }

    const currentBaseline = readCurrentBaseline(baseline.direction);
    if (currentBaseline === null || !baselineMatches(currentBaseline, baseline)) {
      return;
    }

    const state = getRouteState(baseline.direction);
    if (isFailureReevaluationPending(state, baseline)) {
      return;
    }

    clearRouteTimer(baseline.direction);
    state.baseline = baseline;
    state.waitingEmpty = baseline;
  }

  function clearWaitingEmpty(baseline: PeriodicSwitchRouteBaseline): void {
    const currentBaseline = readCurrentBaseline(baseline.direction);
    if (currentBaseline === null || !baselineMatches(currentBaseline, baseline)) {
      return;
    }

    const state = routeStates.get(baseline.direction);
    if (state === undefined || isFailureReevaluationPending(state, baseline)) {
      return;
    }

    if (state.waitingEmpty !== null) {
      state.waitingEmpty = null;
    }
  }

  /**
   * 根据 AUTO_SYMBOL_TICK 的处理结果回写 route 状态。
   * processed 只按当前 baseline 重排未来 due；blocked/skipped 交还给 gate owner 或清理等待；
   * failed 由本 owner 安排一次未来外部失败重评估，避免同 baseline 永久锁死或事件热循环。
   */
  function replanRouteAfterTask(
    params: Parameters<PeriodicSwitchWakeupRuntime['replanRouteAfterTask']>[0],
  ): void {
    if (!running) {
      return;
    }

    const baseline: PeriodicSwitchRouteBaseline = {
      direction: params.direction,
      symbol: params.symbol,
      seatVersion: params.seatVersion,
      lastSeatActivatedAt: params.lastSeatActivatedAt,
    };
    const currentBaseline = readCurrentBaseline(baseline.direction);
    if (currentBaseline === null || !baselineMatches(currentBaseline, baseline)) {
      const state = routeStates.get(baseline.direction);
      const stateBaseline = state?.baseline;
      if (
        stateBaseline !== undefined &&
        stateBaseline !== null &&
        baselineMatches(stateBaseline, baseline)
      ) {
        clearRouteTimer(baseline.direction);
        routeStates.delete(baseline.direction);
      }

      return;
    }

    const state = invalidateRouteIfBaselineChanged(baseline.direction, currentBaseline);
    if (params.status !== 'failed' && isFailureReevaluationPending(state, baseline)) {
      return;
    }

    if (params.status === 'skipped' || params.status === 'blocked') {
      clearRouteTimer(baseline.direction);
      state.waitingEmpty = null;
      state.failureReevaluationAtMs = null;
      return;
    }

    if (params.status === 'failed') {
      if (isFailureReevaluationPending(state, baseline)) {
        return;
      }

      clearRouteTimer(baseline.direction);
      state.waitingEmpty = null;
      const failureReevaluationAtMs = deps.now().getTime() + TRADING.INTERVAL_MS;
      state.failureReevaluationAtMs = failureReevaluationAtMs;
      const timerHandle = scheduleBoundedOneShotAt({
        atMs: failureReevaluationAtMs,
        now: deps.now,
        scheduleTimer: deps.scheduleTimer,
        clearTimer: deps.clearTimer,
        onDue: () => {
          if (state.timerHandle !== timerHandle) {
            return;
          }

          state.timerHandle = null;
          state.failureReevaluationAtMs = null;
          if (!running) {
            return;
          }

          const latestBaseline = readCurrentBaseline(baseline.direction);
          if (latestBaseline === null || !baselineMatches(latestBaseline, baseline)) {
            return;
          }

          dispatchAutoSymbolTick(baseline);
        },
      });
      state.timerHandle = timerHandle;
      return;
    }

    state.failureReevaluationAtMs = null;

    if (state.waitingEmpty !== null && baselineMatches(state.waitingEmpty, baseline)) {
      return;
    }

    state.waitingEmpty = null;
    const switchIntervalMinutes = getSwitchIntervalMinutes();
    if (switchIntervalMinutes === null) {
      return;
    }

    const dueAtMs = deps.calculateDueAtMs({
      startMs: baseline.lastSeatActivatedAt,
      switchIntervalMinutes,
    });
    if (dueAtMs === null) {
      clearRouteTimer(baseline.direction);
      return;
    }

    if (dueAtMs <= params.taskTimeMs) {
      clearRouteTimer(baseline.direction);
      return;
    }

    planRoute(baseline.direction);
  }

  function start(): void {
    if (running) {
      return;
    }

    running = true;
    unsubscribeSeatTruthChanged = deps.symbolRegistry.onSeatTruthChanged(handleSeatTruthChanged);
    unsubscribeOrderStateChanged = deps.trader.onOrderStateChanged(redispatchWaitingEmptyRoutes);
    unsubscribeFreshReached = deps.postTradeConsistencyRuntime.onFreshReached(
      redispatchWaitingEmptyRoutes,
    );

    unsubscribeGateStateChanged =
      deps.tradingGateEventRuntime.onGateStateChanged(handleGateStateChanged);
    seedRoutes();
  }

  function stopAndDrain(): Promise<void> {
    running = false;
    unsubscribeSeatTruthChanged?.();
    unsubscribeSeatTruthChanged = null;
    unsubscribeOrderStateChanged?.();
    unsubscribeOrderStateChanged = null;
    unsubscribeFreshReached?.();
    unsubscribeFreshReached = null;
    unsubscribeGateStateChanged?.();
    unsubscribeGateStateChanged = null;

    for (const state of routeStates.values()) {
      if (state.timerHandle !== null) {
        state.timerHandle.cancel();
      }
    }

    routeStates.clear();
    return Promise.resolve();
  }

  return {
    start,
    stopAndDrain,
    markWaitingEmpty,
    clearWaitingEmpty,
    replanRouteAfterTask,
  };
}
