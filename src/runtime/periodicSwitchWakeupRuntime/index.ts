/**
 * PeriodicSwitchWakeupRuntime
 *
 * 职责：
 * - 接管 ACTIVE seat 周期换标 due timer 的唯一 ownership
 * - 基于 seat truth baseline 隔离旧 timer、旧 waiting-empty 与旧任务回调
 * - 通过 AUTO_SYMBOL_TICK latest-only 任务推进周期换标，不向 timeWakeupPlanner 暴露候选
 */
import { scheduleBoundedOneShotAt } from '../timer/index.js';
import { isSettlementReadinessAbortError } from '../../application/postTradeSettlement/readinessGate.js';
import type { SettlementReadinessReceipt } from '../../types/settlement.js';
import type { SeatTruthChangedListener } from '../../types/seat.js';
import type { MonitorTaskInput } from '../asyncProgram/monitorTaskQueue/types.js';
import type { MonitorTaskDataMap } from '../asyncProgram/monitorTaskProcessor/types.js';
import type { TradingGateStateChangedEvent } from '../../types/timeControlPlane.js';
import type {
  PeriodicSwitchRouteBaseline,
  PeriodicSwitchTaskAuthorization,
  PeriodicSwitchTaskData,
} from '../../types/periodicSwitch.js';
import type {
  PeriodicSwitchRouteState,
  PeriodicSwitchWakeupRuntime,
  PeriodicSwitchWakeupRuntimeDeps,
} from './types.js';

function baselineMatches(
  left: PeriodicSwitchRouteBaseline,
  right: PeriodicSwitchRouteBaseline,
): boolean {
  return (
    left.dayEpoch === right.dayEpoch &&
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
  let draining = false;
  let drainPromise: Promise<void> | null = null;
  const dispatchPromises = new Set<Promise<void>>();
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
      dispatchBaseline: null,
      inFlight: false,
      dirty: false,
      blockedOnFreshness: false,
      blockedOnGate: false,
      dispatchedCanContinue: null,
    };
    routeStates.set(direction, nextState);
    return nextState;
  }

  function clearRouteTimer(direction: 'LONG' | 'SHORT'): void {
    const state = routeStates.get(direction);
    if (state?.timerHandle === null || state === undefined) {
      return;
    }

    const handle = state.timerHandle;
    state.timerHandle = null;
    handle.cancel();
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
      dayEpoch: deps.snapshot.getView().token.dayEpoch,
    };
  }

  function getSwitchIntervalMinutes(): number | null {
    const switchIntervalMinutes = deps.monitorContext.config.autoSearchConfig.switchIntervalMinutes;
    if (switchIntervalMinutes <= 0) {
      return null;
    }

    return switchIntervalMinutes;
  }

  /** 跨await读取真实运行态，停止后不能由旧回调继续派发。 */
  function isRuntimeActive(): boolean {
    return running && !deps.termination.isTerminated();
  }

  function isBaselineCurrent(baseline: PeriodicSwitchRouteBaseline): boolean {
    const currentBaseline = readCurrentBaseline(baseline.direction);
    return currentBaseline !== null && baselineMatches(currentBaseline, baseline);
  }

  function isBaselineReady(): boolean {
    const status = deps.postTradeConsistencyRuntime.getStatus();
    return status.started && status.currentVersion === status.staleVersion;
  }

  /** 原route身份与业务授权分开；真实WAIT接管不因receipt/交易时段失效被拒绝。 */
  function createRouteCurrent(baseline: PeriodicSwitchRouteBaseline): () => boolean {
    const ownerState = routeStates.get(baseline.direction);
    return () =>
      ownerState !== undefined &&
      routeStates.get(baseline.direction) === ownerState &&
      isRuntimeActive() &&
      isBaselineCurrent(baseline);
  }

  /** 原票跨manager quote/broker await传递；本owner不创建第二份持仓或主动失效canonical事实。 */
  function createTaskCanContinue(
    receipt: SettlementReadinessReceipt,
    isRouteCurrent: () => boolean,
  ): () => boolean {
    const selectedView = deps.snapshot.getView();
    return () =>
      isRouteCurrent() &&
      deps.getCanTradeNow() &&
      deps.postTradeConsistencyRuntime.isCurrent(receipt) &&
      deps.snapshot.isCurrent(selectedView.token, { account: false, positions: true });
  }

  /** 保存原due/WAIT需求；组件有效时只追最新水位，否则由真实fresh事件重驱。 */
  function blockOnFreshness(state: PeriodicSwitchRouteState): void {
    state.blockedOnFreshness = true;
    const view = deps.snapshot.getView();
    state.dirty =
      isBaselineReady() && deps.snapshot.isCurrent(view.token, { account: false, positions: true });
  }

  /** 已有任务迟到：不能改plan/waiting-empty；只让原route读取当前授权重新派发。 */
  function isTaskAuthorizationCurrent(authorization: PeriodicSwitchTaskAuthorization): boolean {
    if (!authorization.isRouteCurrent()) return false;

    const state = routeStates.get(authorization.direction);
    if (state?.dispatchedCanContinue !== authorization.canContinue) return false;

    if (isFailureReevaluationPending(state, authorization)) return false;

    if (!deps.getCanTradeNow()) {
      state.blockedOnGate = true;
      return false;
    }

    if (authorization.canContinue()) return true;

    dispatchAutoSymbolTick(authorization);
    return false;
  }

  /** 同 baseline 的派发与业务任务保持 single-flight 到结果回调；期间事件只标脏。 */
  async function processDispatchQueue(
    direction: 'LONG' | 'SHORT',
    state: PeriodicSwitchRouteState,
  ): Promise<void> {
    try {
      while (isRuntimeActive() && routeStates.get(direction) === state && state.dirty) {
        if (state.dispatchedCanContinue !== null) return;

        state.dirty = false;
        const baseline = state.dispatchBaseline;
        if (
          baseline === null ||
          !isBaselineCurrent(baseline) ||
          isFailureReevaluationPending(state, baseline)
        )
          return;

        if (!deps.getCanTradeNow()) {
          state.blockedOnGate = true;
          return;
        }

        state.blockedOnGate = false;

        if (!isBaselineReady()) {
          state.blockedOnFreshness = true;
          return;
        }

        state.blockedOnFreshness = false;
        let receipt: SettlementReadinessReceipt;
        try {
          receipt = await deps.postTradeConsistencyRuntime.waitForFresh();
        } catch (error) {
          if (isSettlementReadinessAbortError(error, 'STOP_AND_DRAIN')) return;

          throw error;
        }

        if (!isRuntimeActive() || routeStates.get(direction) !== state) return;

        if (!deps.getCanTradeNow()) {
          state.blockedOnGate = true;
          return;
        }

        if (!isBaselineCurrent(baseline)) continue;

        const isRouteCurrent = createRouteCurrent(baseline);
        const isAuthorizationCurrent = createTaskCanContinue(receipt, isRouteCurrent);
        const canContinue = (): boolean =>
          state.dispatchedCanContinue === canContinue &&
          !isFailureReevaluationPending(state, baseline) &&
          isAuthorizationCurrent();
        if (!isAuthorizationCurrent()) {
          blockOnFreshness(state);
          continue;
        }

        const data: PeriodicSwitchTaskData = {
          ...baseline,
          currentTimeMs: deps.now().getTime(),
          readinessReceipt: receipt,
          canContinue,
          isRouteCurrent,
        };
        const task: MonitorTaskInput<MonitorTaskDataMap, 'AUTO_SYMBOL_TICK'> = {
          type: 'AUTO_SYMBOL_TICK',
          dedupeKey: `AUTO_SYMBOL_TICK:${baseline.direction}`,
          data,
        };
        // 无await的最终授权→派发；消费端必须保持同一closure，不得用当前票重新授权旧任务。
        if (!isAuthorizationCurrent()) {
          blockOnFreshness(state);
          continue;
        }

        state.dispatchedCanContinue = canContinue;
        if (!deps.monitorTaskQueue.scheduleLatest(task) && !deps.termination.isTerminated()) {
          deps.termination.reportFatalError(
            new Error('[PeriodicSwitchWakeupRuntime] 非终态队列拒绝换标任务'),
          );
        }

        if (state.dispatchBaseline === baseline) state.dispatchBaseline = null;

        return;
      }
    } finally {
      state.inFlight = false;
    }
  }

  function dispatchAutoSymbolTick(baseline: PeriodicSwitchRouteBaseline): void {
    if (!running || deps.termination.isTerminated() || !isBaselineCurrent(baseline)) return;

    const state = getRouteState(baseline.direction);
    if (isFailureReevaluationPending(state, baseline)) return;

    state.dispatchBaseline = baseline;
    state.dirty = true;
    if (state.inFlight || state.dispatchedCanContinue !== null) return;

    state.inFlight = true;
    const work = processDispatchQueue(baseline.direction, state).catch((error: unknown) => {
      deps.termination.reportFatalError(error);
    });
    dispatchPromises.add(work);
    void work.then(
      () => {
        dispatchPromises.delete(work);
      },
      () => {
        dispatchPromises.delete(work);
      },
    );
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
      state.dispatchBaseline = null;
      state.dirty = false;
      state.blockedOnFreshness = false;
      state.blockedOnGate = false;
      state.dispatchedCanContinue = null;
    }

    state.baseline = nextBaseline;
    return state;
  }

  /**
   * 对单 route 重新读取权威 truth 并安排一次 due 行为。
   * baseline 不完整或 dueAtMs 为 null 时只清理旧派生状态，不额外补排到期动作。
   */
  function planRoute(direction: 'LONG' | 'SHORT'): void {
    if (!running || deps.termination.isTerminated()) {
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
        if (routeStates.get(baseline.direction) !== state || state.timerHandle !== timerHandle) {
          return;
        }

        state.timerHandle = null;
        if (!running || deps.termination.isTerminated()) {
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
    if (!running || deps.termination.isTerminated()) {
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
      if (state?.waitingEmpty !== null && state?.waitingEmpty !== undefined) {
        if (state.blockedOnGate) {
          state.blockedOnGate = false;
          dispatchAutoSymbolTick(state.waitingEmpty);
        }

        continue;
      }

      if (state?.dispatchBaseline !== null && state?.dispatchBaseline !== undefined) {
        dispatchAutoSymbolTick(state.dispatchBaseline);
        continue;
      }

      planRoute(direction);
    }
  }

  function markWaitingEmpty(baseline: PeriodicSwitchTaskAuthorization): void {
    if (!baseline.isRouteCurrent()) return;

    if (!deps.getCanTradeNow()) getRouteState(baseline.direction).blockedOnGate = true;

    const currentBaseline = readCurrentBaseline(baseline.direction);
    if (currentBaseline === null || !baselineMatches(currentBaseline, baseline)) {
      return;
    }

    const state = getRouteState(baseline.direction);
    // 真WAIT不因原receipt/gate失效被拒绝；只接受仍持有该业务任务的 owner。
    if (
      state.dispatchedCanContinue !== baseline.canContinue ||
      isFailureReevaluationPending(state, baseline)
    )
      return;

    clearRouteTimer(baseline.direction);
    state.baseline = baseline;
    state.waitingEmpty = baseline;
  }

  function clearWaitingEmpty(baseline: PeriodicSwitchTaskAuthorization): void {
    if (!isTaskAuthorizationCurrent(baseline)) return;

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
   * failed 消费 application 的一次未来重评估指令，避免同 baseline 永久锁死或事件热循环。
   */
  function replanRouteAfterTask(
    params: Parameters<PeriodicSwitchWakeupRuntime['replanRouteAfterTask']>[0],
  ): void {
    if (!running || deps.termination.isTerminated()) {
      return;
    }

    const owner = routeStates.get(params.direction);
    if (owner?.dispatchedCanContinue !== params.canContinue || !params.isRouteCurrent()) return;

    // 明确失败只复核原任务身份，不因刚关闭的 gate/失效 receipt 改成立即重派。
    // 所有结果处理完后才释放业务 ownership，再消费期间合并的事件。
    try {
      if (params.status !== 'failed' && !isTaskAuthorizationCurrent(params)) return;

      const baseline: PeriodicSwitchRouteBaseline = {
        direction: params.direction,
        symbol: params.symbol,
        seatVersion: params.seatVersion,
        lastSeatActivatedAt: params.lastSeatActivatedAt,
        dayEpoch: params.dayEpoch,
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

      if (params.status === 'blocked') {
        state.blockedOnGate = true;
        return;
      }

      if (params.status === 'skipped') {
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
        const failureReevaluationAtMs = params.reevaluateAtMs;
        if (failureReevaluationAtMs === undefined || !Number.isFinite(failureReevaluationAtMs))
          throw new TypeError('周期任务外部失败必须携带应用层重评估时刻');

        state.failureReevaluationAtMs = failureReevaluationAtMs;
        state.dispatchBaseline = null;
        state.dirty = false;
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
            if (!running || deps.termination.isTerminated()) {
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
    } finally {
      if (owner.dispatchedCanContinue === params.canContinue) {
        owner.dispatchedCanContinue = null;
        if (owner.dirty && owner.dispatchBaseline !== null)
          dispatchAutoSymbolTick(owner.dispatchBaseline);
      }
    }
  }

  function start(): void {
    if (running || draining || deps.termination.isTerminated()) {
      return;
    }

    drainPromise = null;
    running = true;
    unsubscribeSeatTruthChanged = deps.symbolRegistry.onSeatTruthChanged(handleSeatTruthChanged);
    unsubscribeOrderStateChanged = deps.orderMonitor.onOrderStateChanged(
      redispatchWaitingEmptyRoutes,
    );

    unsubscribeFreshReached = deps.postTradeConsistencyRuntime.onFreshReached(() => {
      redispatchWaitingEmptyRoutes();
      for (const state of routeStates.values()) {
        if (state.blockedOnFreshness && state.dispatchBaseline !== null)
          dispatchAutoSymbolTick(state.dispatchBaseline);
      }
    });

    unsubscribeGateStateChanged =
      deps.tradingGateEventRuntime.onGateStateChanged(handleGateStateChanged);
    seedRoutes();
  }

  function stop(): void {
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
  }

  function stopAndDrain(): Promise<void> {
    if (drainPromise !== null) return drainPromise;

    draining = true;
    stop();
    drainPromise = Promise.allSettled(dispatchPromises).then(() => {
      draining = false;
    });
    return drainPromise;
  }

  return {
    stop,
    start,
    stopAndDrain,
    markWaitingEmpty,
    clearWaitingEmpty,
    replanRouteAfterTask,
  };
}
