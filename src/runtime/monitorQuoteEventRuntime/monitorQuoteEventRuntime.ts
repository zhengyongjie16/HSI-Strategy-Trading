/**
 * MonitorQuoteEventRuntime
 *
 * 职责：
 * - 监听 monitor quote 与静态清仓 wakeup symbols 的标准化 quote 事件
 * - 对单个 monitorSymbol 执行 single-flight + latest-only collapse
 * - 在执行前统一复用 lifecycle gate、freshness baseline 与 waitForFresh 门禁
 * - 在 autoSearch 开启时启动距离换标，在关闭时接管静态距回收价清仓 WAIT owner
 */
import { isWithinDoomsdayClearanceTakeoverWindow } from '../../domain/liquidation/doomsday/index.js';
import { formatError } from '../../utils/error/index.js';
import { isSettlementReadinessAbortError } from '../../application/postTradeSettlement/readinessGate.js';
import { scheduleBoundedOneShotAt } from '../../utils/timer/index.js';
import type { SettlementReadinessReceipt } from '../../types/settlement.js';
import { exactCompare } from '../../utils/numeric/exact.js';
import { areStringSetsEqual } from './setUtils.js';
import type { QuoteUpdatedEvent } from '../../types/marketPorts.js';
import type { DistanceSwitchExecutionResult } from '../../application/seatSwitch/types.js';
import {
  createDistanceSwitchExecutor,
  captureDistanceSwitchPrecheckSnapshot,
} from '../../application/seatSwitch/distanceSwitch.js';
import type { StaticLiquidationExecutionResult } from '../../application/staticLiquidation/types.js';
import type {
  CreateDefaultMonitorQuoteEventRuntimeDeps,
  CreateMonitorQuoteEventRuntimeDeps,
  MonitorQuoteEventRuntime,
  MonitorQuoteRouteMode,
  MonitorQuoteRouteState,
} from './types.js';

function assertValidStartedSwitchResult(result: unknown): void {
  if (typeof result !== 'object' || result === null) {
    throw new Error('[MonitorQuoteEventRuntime] start switch result must be an object');
  }

  if (!('started' in result) || result.started !== true) {
    return;
  }

  if (
    !('driveResult' in result) ||
    typeof result.driveResult !== 'object' ||
    result.driveResult === null
  ) {
    throw new Error('[MonitorQuoteEventRuntime] started switch must return WAIT');
  }

  if (!('kind' in result.driveResult) || result.driveResult.kind !== 'WAIT') {
    throw new Error('[MonitorQuoteEventRuntime] started switch must return WAIT');
  }
}

/**
 * 判断当前 runtime gate 是否打开。
 *
 * @param deps runtime 依赖
 * @returns 允许执行事件时返回 true
 */
function isExecutionGateOpen(deps: CreateMonitorQuoteEventRuntimeDeps): boolean {
  if (deps.termination.isTerminated()) return false;

  if (!deps.lastState) {
    return true;
  }

  if (!deps.lastState.isTradingEnabled || deps.lastState.canTrade !== true) {
    return false;
  }

  if (!deps.doomsdayProtectionEnabled) {
    return true;
  }

  return !isWithinDoomsdayClearanceTakeoverWindow(deps.now(), deps.lastState.isHalfDay ?? false);
}

/**
 * 判断当前 baseline 是否已经 ready。
 *
 * @param deps runtime 依赖
 * @returns baseline ready 时返回 true
 */
function isBaselineReady(deps: CreateMonitorQuoteEventRuntimeDeps): boolean {
  const status = deps.postTradeConsistencyRuntime.getStatus();
  return status.started && status.currentVersion === status.staleVersion;
}

/**
 * 创建 route 初始状态。
 *
 * @param mode route 模式
 * @returns 初始 route 状态
 */
function createRouteState(mode: MonitorQuoteRouteMode): MonitorQuoteRouteState {
  return {
    generation: 0,
    monitorQuoteGeneration: 0,
    latestEvent: null,
    latestDayEpoch: null,
    blockedOnFreshness: false,
    wakeupSymbols: new Set(),
    retainedQuoteSymbols: new Set(),
    retainNeedsRetry: false,
    mode,
    inFlight: false,
    dirty: false,
    retryAttempts: 0,
    retryTimerHandle: null,
    distanceSwitchPrecheckRetryTimer: null,
    distanceSwitchPrecheckRetryConsumed: false,
    submittedLiquidationDirections: new Set(),
  };
}

/**
 * 创建模块内默认 monitor quote runtime 组装入口。
 *
 * @param deps 真实清仓与距离换标启动所需的最小依赖
 * @returns 已组装真实执行依赖的 runtime
 */
export function createDefaultMonitorQuoteEventRuntime(
  deps: CreateDefaultMonitorQuoteEventRuntimeDeps,
): MonitorQuoteEventRuntime {
  const runtimeDeps: CreateMonitorQuoteEventRuntimeDeps = {
    logger: deps.logger,
    marketDataClient: deps.marketDataClient,
    monitorContext: deps.monitorContext,
    executeStaticLiquidation: deps.executeStaticLiquidation,
    startDistanceSwitch: createDistanceSwitchExecutor({
      now: deps.now,
      snapshot: deps.snapshot,
    }),
    ...(deps.handoffPendingSwitch ? { handoffPendingSwitch: deps.handoffPendingSwitch } : {}),
    now: deps.now,
    scheduleTimer: deps.scheduleTimer,
    clearTimer: deps.clearTimer,
    ...(deps.quoteSubscriptionRuntime
      ? { quoteSubscriptionRuntime: deps.quoteSubscriptionRuntime }
      : {}),
    lastState: deps.lastState,
    snapshot: deps.snapshot,
    postTradeConsistencyRuntime: deps.postTradeConsistencyRuntime,
    doomsdayProtectionEnabled: deps.doomsdayProtectionEnabled,
    termination: deps.termination,
  };

  return createMonitorQuoteEventRuntime(runtimeDeps);
}

/**
 * 创建 MonitorQuoteEventRuntime。
 *
 * @param deps 行情事件源与最小执行依赖
 * @returns runtime 实例
 */
function createMonitorQuoteEventRuntime(
  deps: CreateMonitorQuoteEventRuntimeDeps,
): MonitorQuoteEventRuntime {
  const {
    logger,
    marketDataClient,
    monitorContext,
    executeStaticLiquidation,
    startDistanceSwitch,
    handoffPendingSwitch,
  } = deps;
  const { now, scheduleTimer, clearTimer } = deps;
  const runtimeMonitorSymbol = monitorContext.config.monitorSymbol;

  let running = false;
  let hasDrainFailure = false;
  let drainFailure: unknown;
  let drainPromise: Promise<void> | null = null;
  let draining = false;
  let unsubscribeQuoteUpdated: (() => void) | null = null;
  let unsubscribeFreshReached: (() => void) | null = null;
  let routeState: MonitorQuoteRouteState | null = null;
  const staticWakeupSymbols = new Set<string>();
  const activePromises = new Set<Promise<void>>();

  /**
   * 清空静态清仓 WAIT 持有的显式唤醒 quote symbol。
   */
  function clearStaticWakeupIndexes(): void {
    staticWakeupSymbols.clear();
  }

  /**
   * 用最新 WAIT 结果覆盖显式唤醒 quote symbol 集合。
   *
   * @param symbols 本轮 WAIT 需要继续监听的 quote symbol
   */
  function registerStaticWakeupIndexes(symbols: ReadonlySet<string>): void {
    clearStaticWakeupIndexes();
    for (const symbol of symbols) {
      staticWakeupSymbols.add(symbol);
    }
  }

  /**
   * 获取或创建 route 状态。
   *
   * @param mode route 模式
   * @returns route 状态
   */
  function getOrCreateRouteState(mode: MonitorQuoteRouteMode): MonitorQuoteRouteState {
    if (routeState !== null) {
      if (routeState.mode !== mode) {
        if (routeState.retryTimerHandle !== null) {
          clearTimer(routeState.retryTimerHandle);
          routeState.retryTimerHandle = null;
        }

        clearDistanceSwitchPrecheckRetryTimer(routeState);

        clearStaticWakeupIndexes();
        releaseStaticLiquidationRetain();
        routeState.generation += 1;
        routeState.monitorQuoteGeneration += 1;
        routeState.mode = mode;
        routeState.wakeupSymbols = new Set();
        routeState.retryAttempts = 0;
        routeState.distanceSwitchPrecheckRetryConsumed = false;
        routeState.submittedLiquidationDirections.clear();
      }

      return routeState;
    }

    routeState = createRouteState(mode);
    return routeState;
  }

  function registerInFlight(promise: Promise<void>): void {
    activePromises.add(promise);
    void promise.then(
      () => {
        activePromises.delete(promise);
      },
      (error: unknown) => {
        if (!hasDrainFailure) {
          hasDrainFailure = true;
          drainFailure = error;
        }

        activePromises.delete(promise);
      },
    );
  }

  function isRouteExecutionCurrent(params: {
    readonly routeState: MonitorQuoteRouteState;
    readonly generation: number;
  }): boolean {
    return (
      running &&
      routeState === params.routeState &&
      params.routeState.generation === params.generation
    );
  }

  /**
   * 判断一次距离换标执行是否仍对应启动时的 monitor quote。
   *
   * 距离换标会按 LONG、SHORT 顺序跨 await 执行；新 quote 到达后，旧 quote
   * 不得再用旧价格启动尚未开始的另一方向，但已经成功创建的 pending owner
   * 仍由外层按 route 身份交接。
   *
   * @param params 本次距离换标执行捕获的 route 与 quote 身份
   * @returns route、quote generation 与 quote 事件身份均未变化时返回 true
   */
  function isDistanceExecutionCurrent(params: {
    readonly routeState: MonitorQuoteRouteState;
    readonly generation: number;
    readonly monitorQuoteGeneration: number;
    readonly event: QuoteUpdatedEvent;
  }): boolean {
    return (
      isRouteExecutionCurrent({
        routeState: params.routeState,
        generation: params.generation,
      }) &&
      params.routeState.monitorQuoteGeneration === params.monitorQuoteGeneration &&
      params.routeState.latestEvent === params.event
    );
  }

  /**
   * 启动 route 处理并接入 fatal drain。
   *
   * @param source 本次触发来源
   */
  function launchRouteProcessing(source: string): void {
    const processingPromise = processRouteQueue().catch((error: unknown) => {
      logger.error(
        `[MonitorQuoteEventRuntime] monitor quote route 处理失败 source=${source} monitorSymbol=${runtimeMonitorSymbol}`,
        formatError(error),
      );

      deps.termination.reportFatalError(error);
    });
    registerInFlight(processingPromise);
  }

  /**
   * 释放静态清仓 WAIT 持有的 quote retain。
   */
  function releaseStaticLiquidationRetain(): void {
    if (routeState === null || routeState.retainedQuoteSymbols.size === 0) {
      return;
    }

    routeState.retainedQuoteSymbols = new Set<string>();
    routeState.retainNeedsRetry = false;
    const quoteSubscriptionRuntime = deps.quoteSubscriptionRuntime;
    if (quoteSubscriptionRuntime === undefined) {
      return;
    }

    const quoteMutation = quoteSubscriptionRuntime
      .releaseRetain({
        ownerKey: runtimeMonitorSymbol,
        reason: 'STATIC_LIQUIDATION_WAIT',
      })
      .catch((error: unknown) => {
        logger.error(
          '[MonitorQuoteEventRuntime] 释放静态清仓 quote retain 失败',
          formatError(error),
        );
        deps.termination.reportFatalError(error);
        throw error;
      });
    registerInFlight(quoteMutation);
  }

  /**
   * 注册静态清仓 WAIT 期间需要保留订阅的 quote symbols。
   *
   * @param symbols 等待期间需要保留订阅的标的
   */
  function retainStaticLiquidationSymbols(symbols: ReadonlySet<string>): void {
    if (routeState === null) {
      return;
    }

    if (symbols.size === 0) {
      releaseStaticLiquidationRetain();
      return;
    }

    if (
      !routeState.retainNeedsRetry &&
      areStringSetsEqual(routeState.retainedQuoteSymbols, symbols)
    ) {
      return;
    }

    const requestedSymbols = new Set(symbols);
    const activeRouteState = routeState;
    activeRouteState.retainedQuoteSymbols = requestedSymbols;
    activeRouteState.retainNeedsRetry = false;
    const quoteSubscriptionRuntime = deps.quoteSubscriptionRuntime;
    if (quoteSubscriptionRuntime === undefined) {
      return;
    }

    const quoteMutation = quoteSubscriptionRuntime
      .retainSymbols({
        ownerKey: runtimeMonitorSymbol,
        reason: 'STATIC_LIQUIDATION_WAIT',
        symbols: [...symbols],
      })
      .catch((error: unknown) => {
        if (
          routeState === activeRouteState &&
          activeRouteState.retainedQuoteSymbols === requestedSymbols
        ) {
          activeRouteState.retainNeedsRetry = true;
        }

        logger.error(
          '[MonitorQuoteEventRuntime] 注册静态清仓 quote retain 失败',
          formatError(error),
        );
        deps.termination.reportFatalError(error);
        throw error;
      });
    registerInFlight(quoteMutation);
  }

  /**
   * 清理 route 持有的一次性 retry timer。
   *
   * @param targetRouteState route 状态
   */
  function clearRouteRetryTimer(targetRouteState: MonitorQuoteRouteState): void {
    if (targetRouteState.retryTimerHandle === null) {
      return;
    }

    const handle = targetRouteState.retryTimerHandle;
    targetRouteState.retryTimerHandle = null;
    clearTimer(handle);
  }

  /**
   * 取消距离换标预检失败的 route 专属 one-shot RETRY_TIMER。
   *
   * @param targetRouteState 需要清理 retry 的 route 状态
   */
  function clearDistanceSwitchPrecheckRetryTimer(targetRouteState: MonitorQuoteRouteState): void {
    if (targetRouteState.distanceSwitchPrecheckRetryTimer === null) {
      return;
    }

    targetRouteState.distanceSwitchPrecheckRetryTimer.cancel();
    targetRouteState.distanceSwitchPrecheckRetryTimer = null;
  }

  /**
   * 为无副作用的距离换标预检外部失败安排 route 专属 one-shot RETRY_TIMER。
   *
   * 计时器到期后只触发 latest-only route，因此会用届时保存的最新 monitor quote
   * 完整重跑距离判断，不会伪造 pending switch 或复用其他业务 owner。
   *
   * @param params 当前 route 与 generation 身份
   */
  function scheduleDistanceSwitchPrecheckRetry(params: {
    readonly routeState: MonitorQuoteRouteState;
    readonly generation: number;
    readonly monitorQuoteGeneration: number;
    readonly retryAtMs: number;
  }): void {
    const targetRouteState = params.routeState;
    clearDistanceSwitchPrecheckRetryTimer(targetRouteState);

    const timerHandle = scheduleBoundedOneShotAt({
      atMs: params.retryAtMs,
      now,
      scheduleTimer,
      clearTimer,
      onDue: () => {
        if (targetRouteState.distanceSwitchPrecheckRetryTimer !== timerHandle) {
          return;
        }

        targetRouteState.distanceSwitchPrecheckRetryTimer = null;
        if (
          targetRouteState.mode !== 'DISTANCE_SWITCH' ||
          !isRouteExecutionCurrent({
            routeState: targetRouteState,
            generation: params.generation,
          }) ||
          targetRouteState.monitorQuoteGeneration !== params.monitorQuoteGeneration
        ) {
          return;
        }

        triggerRoute();
      },
    });
    targetRouteState.distanceSwitchPrecheckRetryTimer = timerHandle;
  }

  /**
   * 按 WAIT 结果重建静态清仓 route 的显式 wakeup 与 retry timer。
   *
   * @param executionResult 本轮静态清仓执行结果
   */
  function updateStaticLiquidationWaitState(
    executionResult: Extract<StaticLiquidationExecutionResult, { kind: 'WAIT' }>,
  ): void {
    if (routeState === null) {
      return;
    }

    const activeRouteState = routeState;

    clearRouteRetryTimer(activeRouteState);
    const nextWakeupSymbols = new Set(executionResult.wakeupSymbols);
    if (!running || deps.termination.isTerminated()) {
      clearStaticWakeupIndexes();
      activeRouteState.wakeupSymbols = new Set();
      releaseStaticLiquidationRetain();
      return;
    }

    const wakeupSymbolsChanged = !areStringSetsEqual(
      activeRouteState.wakeupSymbols,
      nextWakeupSymbols,
    );
    if (wakeupSymbolsChanged) {
      activeRouteState.wakeupSymbols = nextWakeupSymbols;
      registerStaticWakeupIndexes(activeRouteState.wakeupSymbols);
    }

    retainStaticLiquidationSymbols(activeRouteState.wakeupSymbols);

    if (executionResult.retryAtMs === null) {
      return;
    }

    const delayMs = Math.max(0, executionResult.retryAtMs - now().getTime());
    const handle = scheduleTimer(() => {
      if (routeState !== activeRouteState || activeRouteState.retryTimerHandle !== handle) return;

      activeRouteState.retryTimerHandle = null;
      triggerRoute();
    }, delayMs);
    activeRouteState.retryTimerHandle = handle;
  }

  /**
   * 判断 runtime 是否仍处于运行态。
   *
   * @returns runtime 仍在运行时返回 true
   */
  function isRuntimeRunning(): boolean {
    return running && !deps.termination.isTerminated();
  }

  /**
   * 触发唯一 monitor route 的 latest-only 执行。
   */
  function triggerRoute(): void {
    if (routeState === null || !running) {
      return;
    }

    routeState.dirty = true;
    if (routeState.inFlight) {
      return;
    }

    routeState.inFlight = true;
    launchRouteProcessing('QUOTE_EVENT');
  }

  /**
   * 执行单轮 freshness 门禁等待。
   *
   * @returns 真实ready凭据；门禁关闭/生命周期取消时返回null，不制造兼容授权。
   */
  async function waitForExecutionFreshness(): Promise<SettlementReadinessReceipt | null> {
    if (!isExecutionGateOpen(deps)) return null;

    if (!isBaselineReady(deps)) {
      if (routeState !== null) routeState.blockedOnFreshness = true;

      return null;
    }

    try {
      return await deps.postTradeConsistencyRuntime.waitForFresh();
    } catch (error) {
      if (isSettlementReadinessAbortError(error, 'STOP_AND_DRAIN')) return null;

      throw error;
    }
  }

  /**
   * 处理唯一 monitor route 的 latest-only 队列。
   */
  async function processRouteQueue(): Promise<void> {
    if (routeState === null) {
      return;
    }

    const activeRouteState = routeState;

    try {
      while (activeRouteState.dirty) {
        if (!running || deps.termination.isTerminated()) {
          return;
        }

        activeRouteState.dirty = false;
        const snapshotEvent = activeRouteState.latestEvent;
        if (!snapshotEvent) {
          clearStaticWakeupIndexes();
          routeState = null;
          return;
        }

        const dayEpoch = activeRouteState.latestDayEpoch;
        if (dayEpoch !== deps.snapshot.getView().token.dayEpoch) return;

        const seatSnapshot = captureDistanceSwitchPrecheckSnapshot(monitorContext);
        const isDirectionCurrent = (direction: 'LONG' | 'SHORT'): boolean => {
          const captured = seatSnapshot.find((entry) => entry.direction === direction);
          const seat = monitorContext.symbolRegistry.getSeatState(direction);
          return (
            captured?.seatStatus === 'ACTIVE' &&
            seat.status === 'ACTIVE' &&
            seat.symbol === captured.seatSymbol &&
            monitorContext.symbolRegistry.getSeatVersion(direction) === captured.seatVersion
          );
        };
        const executionGeneration = activeRouteState.generation;
        const monitorQuoteGeneration = activeRouteState.monitorQuoteGeneration;
        const receipt = await waitForExecutionFreshness();
        if (
          receipt === null ||
          !isExecutionGateOpen(deps) ||
          dayEpoch !== deps.snapshot.getView().token.dayEpoch
        )
          return;

        activeRouteState.blockedOnFreshness = false;
        const selectedView = deps.snapshot.getView();
        const isSnapshotCurrent = (): boolean =>
          isBaselineReady(deps) &&
          dayEpoch === deps.snapshot.getView().token.dayEpoch &&
          deps.postTradeConsistencyRuntime.isCurrent(receipt) &&
          deps.snapshot.isCurrent(selectedView.token, { account: false, positions: true });
        if (!isSnapshotCurrent()) {
          activeRouteState.dirty = true;
          continue;
        }

        const canContinueDistanceExecution = (): boolean =>
          isExecutionGateOpen(deps) &&
          isSnapshotCurrent() &&
          isDistanceExecutionCurrent({
            routeState: activeRouteState,
            generation: executionGeneration,
            monitorQuoteGeneration,
            event: snapshotEvent,
          });

        if (activeRouteState.mode === 'DISTANCE_SWITCH') {
          if (!canContinueDistanceExecution()) {
            continue;
          }

          if (!startDistanceSwitch) {
            continue;
          }

          const executionResult: DistanceSwitchExecutionResult = await startDistanceSwitch({
            monitorContext,
            event: snapshotEvent,
            canContinue: canContinueDistanceExecution,
            isDirectionCurrent,
            retryConsumed: activeRouteState.distanceSwitchPrecheckRetryConsumed,
          });
          if (executionResult.kind === 'RETRY_PRECHECK') {
            activeRouteState.distanceSwitchPrecheckRetryConsumed = true;
            scheduleDistanceSwitchPrecheckRetry({
              routeState: activeRouteState,
              generation: executionGeneration,
              monitorQuoteGeneration,
              retryAtMs: executionResult.retryAtMs,
            });
            continue;
          }

          const results = executionResult.results;

          // 只接管原epoch内本次真实发布的WAIT；keeper不依赖已经失效的ACTIVE/receipt/purpose票，
          // 也不补票推进plan。未发布、后继map/seat或跨日结果不得借当前席位挂旧wakeups。
          for (const result of results) {
            assertValidStartedSwitchResult(result);
            if (!handoffPendingSwitch || !result.started) continue;

            const publishedRoute = result.driveResult.publishedRoute;
            if (
              !isRuntimeRunning() ||
              dayEpoch !== deps.snapshot.getView().token.dayEpoch ||
              publishedRoute?.direction !== result.direction ||
              !publishedRoute.isCurrent()
            )
              continue;

            const publishedSeat = monitorContext.symbolRegistry.getSeatState(result.direction);
            if (
              publishedSeat.status !== 'SWITCHING' ||
              publishedSeat.symbol !== publishedRoute.symbol ||
              monitorContext.symbolRegistry.getSeatVersion(result.direction) !==
                publishedRoute.seatVersion
            )
              continue;

            handoffPendingSwitch({
              direction: result.direction,
              monitorContext,
              driveResult: result.driveResult,
              originalDayEpoch: dayEpoch,
            });
          }

          if (isRuntimeRunning() && isExecutionGateOpen(deps) && !isSnapshotCurrent())
            activeRouteState.dirty = true;

          continue;
        }

        // static executor在自己的wait/quote阶段捕获真实receipt；此闭包只取消旧route/epoch/gate。
        // 不能因父receipt被较新组件取代，禁止真实broker ack的方向登记而导致再次提交。
        const canContinueStaticLiquidation = (): boolean =>
          isExecutionGateOpen(deps) &&
          dayEpoch === deps.snapshot.getView().token.dayEpoch &&
          isRouteExecutionCurrent({
            routeState: activeRouteState,
            generation: executionGeneration,
          });
        if (!canContinueStaticLiquidation()) {
          continue;
        }

        if (!executeStaticLiquidation) {
          continue;
        }

        if (!isSnapshotCurrent()) {
          activeRouteState.dirty = true;
          continue;
        }

        const executionResult = await executeStaticLiquidation({
          monitorContext,
          event: snapshotEvent,
          retryAttempts: activeRouteState.retryAttempts,
          excludedDirections: new Set([
            ...activeRouteState.submittedLiquidationDirections,
            ...seatSnapshot
              .filter((entry) => !isDirectionCurrent(entry.direction))
              .map((entry) => entry.direction),
          ]),
          canContinue: canContinueStaticLiquidation,
          onDirectionSubmitted: (direction) => {
            // 真实ack仅记录仍属于原epoch/seat的已提交方向，不因receipt更新否认远端事实。
            if (
              dayEpoch === deps.snapshot.getView().token.dayEpoch &&
              isDirectionCurrent(direction) &&
              isRouteExecutionCurrent({
                routeState: activeRouteState,
                generation: executionGeneration,
              })
            )
              activeRouteState.submittedLiquidationDirections.add(direction);
          },
        });

        if (!isExecutionGateOpen(deps) || dayEpoch !== deps.snapshot.getView().token.dayEpoch)
          return;

        if (
          !isRouteExecutionCurrent({
            routeState: activeRouteState,
            generation: executionGeneration,
          })
        )
          continue;

        if (executionResult.kind === 'RE_EVALUATE' || !isSnapshotCurrent()) {
          // 本地supersession交原latest-only队列重算，不涨行情retry、不建timer、不丢WAIT retain。
          activeRouteState.dirty = true;
          continue;
        }

        if (executionResult.kind === 'WAIT') {
          activeRouteState.retryAttempts += 1;
          updateStaticLiquidationWaitState(executionResult);
          continue;
        }

        clearRouteRetryTimer(activeRouteState);
        clearStaticWakeupIndexes();
        releaseStaticLiquidationRetain();
        activeRouteState.wakeupSymbols = new Set();
        activeRouteState.retryAttempts = 0;
        activeRouteState.submittedLiquidationDirections.clear();
      }
    } finally {
      if (routeState === activeRouteState) {
        activeRouteState.inFlight = false;
        if (activeRouteState.dirty && running) {
          activeRouteState.inFlight = true;
          launchRouteProcessing('REENTER');
        }
      }
    }
  }

  /**
   * 处理单条 quote 事件。
   *
   * @param event 标准化 quote 事件
   */
  function handleQuoteUpdated(event: QuoteUpdatedEvent): void {
    if (!running || deps.termination.isTerminated()) {
      return;
    }

    try {
      if (exactCompare(event.quote.price, '0') <= 0) return;
    } catch (error) {
      deps.termination.reportFatalError(error);
      stop();
      return;
    }

    if (event.symbol === runtimeMonitorSymbol) {
      const mode: MonitorQuoteRouteMode = monitorContext.config.autoSearchConfig.autoSearchEnabled
        ? 'DISTANCE_SWITCH'
        : 'STATIC_LIQUIDATION';
      const currentRouteState = getOrCreateRouteState(mode);
      currentRouteState.latestEvent = event;
      currentRouteState.latestDayEpoch = deps.snapshot.getView().token.dayEpoch;
      currentRouteState.monitorQuoteGeneration += 1;
      if (mode === 'STATIC_LIQUIDATION') {
        clearRouteRetryTimer(currentRouteState);
      } else {
        clearDistanceSwitchPrecheckRetryTimer(currentRouteState);
        currentRouteState.distanceSwitchPrecheckRetryConsumed = false;
      }

      triggerRoute();
    }

    if (
      event.symbol === runtimeMonitorSymbol ||
      routeState === null ||
      !staticWakeupSymbols.has(event.symbol)
    ) {
      return;
    }

    routeState.latestEvent = event;
    routeState.latestDayEpoch = deps.snapshot.getView().token.dayEpoch;
    clearRouteRetryTimer(routeState);
    triggerRoute();
  }

  function start(): void {
    if (running || draining || deps.termination.isTerminated()) {
      return;
    }

    hasDrainFailure = false;
    drainFailure = undefined;
    drainPromise = null;
    running = true;
    unsubscribeQuoteUpdated = marketDataClient.onQuoteUpdated(handleQuoteUpdated);
    unsubscribeFreshReached = deps.postTradeConsistencyRuntime.onFreshReached(() => {
      if (routeState !== null && routeState.blockedOnFreshness && isRuntimeRunning()) {
        routeState.blockedOnFreshness = false;
        triggerRoute();
      }
    });
  }

  function stop(): void {
    running = false;
    unsubscribeQuoteUpdated?.();
    unsubscribeQuoteUpdated = null;
    unsubscribeFreshReached?.();
    unsubscribeFreshReached = null;

    if (routeState !== null) {
      clearRouteRetryTimer(routeState);
      clearDistanceSwitchPrecheckRetryTimer(routeState);
      clearStaticWakeupIndexes();
      releaseStaticLiquidationRetain();
      routeState.wakeupSymbols = new Set();
    }
  }

  /** 同周期共享排空结果；关闭入口后，全部在途工作落定才传播原始失败。 */
  function stopAndDrain(): Promise<void> {
    if (drainPromise !== null) {
      return drainPromise;
    }

    draining = true;
    drainPromise = drain().finally(() => {
      draining = false;
    });
    return drainPromise;
  }

  /** allSettled 不提前退出，并持续捕获清理过程中新增的 release。 */
  async function drain(): Promise<void> {
    stop();
    while (activePromises.size > 0) await Promise.allSettled(activePromises);

    if (routeState !== null) {
      clearRouteRetryTimer(routeState);
      clearDistanceSwitchPrecheckRetryTimer(routeState);
      clearStaticWakeupIndexes();
      releaseStaticLiquidationRetain();
      routeState.wakeupSymbols = new Set();
    }

    clearStaticWakeupIndexes();
    routeState = null;
    while (activePromises.size > 0) await Promise.allSettled(activePromises);

    if (hasDrainFailure) {
      throw drainFailure;
    }
  }

  return {
    start,
    stop,
    stopAndDrain,
  };
}
