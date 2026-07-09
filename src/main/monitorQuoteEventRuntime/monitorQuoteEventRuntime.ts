/**
 * MonitorQuoteEventRuntime
 *
 * 职责：
 * - 监听 monitor quote 与静态清仓 wakeup symbols 的标准化 quote 事件
 * - 对单个 monitorSymbol 执行 single-flight + latest-only collapse
 * - 在执行前统一复用 lifecycle gate、freshness baseline 与 waitForFresh 门禁
 * - 在 autoSearch 开启时启动距离换标，在关闭时接管静态距回收价清仓 WAIT owner
 */
import { isWithinDoomsdayClearanceTakeoverWindow } from '../../core/doomsdayProtection/utils.js';
import { formatError } from '../../utils/error/index.js';
import { isRefreshGateAbortError } from '../../utils/refreshGate/index.js';
import { logger } from '../../utils/logger/index.js';
import type { StartSwitchOnDistanceResult } from '../../types/monitorContextPorts.js';
import { areStringSetsEqual } from './setUtils.js';
import type { MonitorContext } from '../../types/state.js';
import type { QuoteUpdatedEvent } from '../../types/services.js';
import { isSeatActive } from '../../utils/seat/guards.js';
import { createStaticLiquidationExecutor } from './staticLiquidationExecutor.js';
import type {
  CreateDefaultMonitorQuoteEventRuntimeDeps,
  CreateMonitorQuoteEventRuntimeDeps,
  MonitorQuoteEventRuntime,
  MonitorQuoteEventExecutor,
  MonitorQuoteRouteMode,
  MonitorQuoteRouteState,
  StaticLiquidationRuntimeResult,
  StartDistanceSwitchExecutor,
} from './types.js';

/**
 * 根据 quote 事件匹配唯一监控上下文。
 *
 * @param params.monitorContext monitor 上下文
 * @param params.event 标准化 quote 事件
 * @returns 事件属于唯一 monitor 时返回 monitor 上下文；否则返回 null
 */
function matchMonitorContextForQuoteEvent(params: {
  readonly monitorContext: MonitorContext;
  readonly event: QuoteUpdatedEvent;
}): MonitorContext | null {
  return params.event.symbol === params.monitorContext.config.monitorSymbol
    ? params.monitorContext
    : null;
}

/**
 * 判断当前 runtime gate 是否打开。
 *
 * @param deps runtime 依赖
 * @returns 允许执行事件时返回 true
 */
function isExecutionGateOpen(deps: CreateMonitorQuoteEventRuntimeDeps): boolean {
  if (!deps.lastState) {
    return true;
  }

  if (!deps.lastState.isTradingEnabled || deps.lastState.canTrade !== true) {
    return false;
  }

  if (!deps.doomsdayProtectionEnabled) {
    return true;
  }

  return !isWithinDoomsdayClearanceTakeoverWindow(
    deps.now?.() ?? new Date(),
    deps.lastState.isHalfDay ?? false,
  );
}

/**
 * 判断当前 baseline 是否已经 ready。
 *
 * @param deps runtime 依赖
 * @returns baseline ready 时返回 true
 */
function isBaselineReady(deps: CreateMonitorQuoteEventRuntimeDeps): boolean {
  if (!deps.postTradeConsistencyRuntime) {
    return true;
  }

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
    latestEvent: null,
    wakeupSymbols: new Set(),
    retainedQuoteSymbols: new Set(),
    retainNeedsRetry: false,
    mode,
    inFlight: false,
    dirty: false,
    retryAttempts: 0,
    retryTimerHandle: null,
    submittedLiquidationDirections: new Set(),
  };
}

/**
 * 为 autoSearch 关闭场景创建真实静态清仓执行器。
 *
 * @param deps 清仓执行所需的最小真实依赖
 * @returns monitor quote 驱动的静态清仓执行函数
 */
function createDefaultStaticLiquidationExecutor(
  deps: CreateDefaultMonitorQuoteEventRuntimeDeps,
): MonitorQuoteEventExecutor {
  return createStaticLiquidationExecutor({
    trader: deps.trader,
    marketDataClient: deps.marketDataClient,
    lastState: deps.lastState,
    now: deps.now,
  });
}

/**
 * 为 autoSearch 开启场景创建最小距离换标启动执行器。
 *
 * @param deps 持仓快照依赖
 * @returns monitor quote 驱动的距离换标启动执行函数
 */
function createDefaultStartDistanceSwitchExecutor(
  deps: Pick<CreateDefaultMonitorQuoteEventRuntimeDeps, 'lastState'>,
): StartDistanceSwitchExecutor {
  return async function startDistanceSwitchOnMonitorQuote(params: {
    readonly monitorContext: MonitorContext;
    readonly event: QuoteUpdatedEvent;
    readonly canContinue: () => boolean;
  }): Promise<ReadonlyArray<StartSwitchOnDistanceResult>> {
    const { monitorContext, event } = params;
    const monitorSymbol = monitorContext.config.monitorSymbol;
    const longSeat = monitorContext.symbolRegistry.getSeatState(monitorSymbol, 'LONG');
    const shortSeat = monitorContext.symbolRegistry.getSeatState(monitorSymbol, 'SHORT');
    const monitorPrice = event.quote.price;
    const positions = deps.lastState.cachedPositions;
    const results: StartSwitchOnDistanceResult[] = [];

    if (isSeatActive(longSeat) && params.canContinue()) {
      results.push(
        await monitorContext.autoSymbolManager.startSwitchOnDistance({
          direction: 'LONG',
          monitorPrice,
          positions,
        }),
      );
    }

    if (isSeatActive(shortSeat) && params.canContinue()) {
      results.push(
        await monitorContext.autoSymbolManager.startSwitchOnDistance({
          direction: 'SHORT',
          monitorPrice,
          positions,
        }),
      );
    }

    return results;
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
    marketDataClient: deps.marketDataClient,
    monitorContext: deps.monitorContext,
    executeStaticLiquidation: createDefaultStaticLiquidationExecutor(deps),
    startDistanceSwitch: createDefaultStartDistanceSwitchExecutor({
      lastState: deps.lastState,
    }),
    ...(deps.handoffPendingSwitch ? { handoffPendingSwitch: deps.handoffPendingSwitch } : {}),
    ...(deps.scheduleTimer ? { scheduleTimer: deps.scheduleTimer } : {}),
    ...(deps.clearTimer ? { clearTimer: deps.clearTimer } : {}),
    ...(deps.quoteSubscriptionRuntime
      ? { quoteSubscriptionRuntime: deps.quoteSubscriptionRuntime }
      : {}),
    lastState: deps.lastState,
    postTradeConsistencyRuntime: deps.postTradeConsistencyRuntime,
    doomsdayProtectionEnabled: deps.doomsdayProtectionEnabled,
    now: deps.now,
    ...(deps.onFatalError ? { onFatalError: deps.onFatalError } : {}),
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
    marketDataClient,
    monitorContext,
    executeStaticLiquidation,
    startDistanceSwitch,
    handoffPendingSwitch,
  } = deps;
  const scheduleTimer = deps.scheduleTimer ?? setTimeout;
  const clearTimer = deps.clearTimer ?? clearTimeout;
  const runtimeMonitorSymbol = monitorContext.config.monitorSymbol;

  let running = false;
  let unsubscribeQuoteUpdated: (() => void) | null = null;
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

        clearStaticWakeupIndexes();
        releaseStaticLiquidationRetain();
        routeState.generation += 1;
        routeState.mode = mode;
        routeState.wakeupSymbols = new Set();
        routeState.retryAttempts = 0;
        routeState.submittedLiquidationDirections.clear();
      }

      return routeState;
    }

    routeState = createRouteState(mode);
    return routeState;
  }

  function registerInFlight(promise: Promise<void>): void {
    activePromises.add(promise);
    void promise.finally(() => {
      activePromises.delete(promise);
    });
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

      deps.onFatalError?.(error);
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

    void quoteSubscriptionRuntime
      .releaseRetain({
        ownerKey: runtimeMonitorSymbol,
        reason: 'STATIC_LIQUIDATION_WAIT',
      })
      .catch((error: unknown) => {
        logger.error(
          '[MonitorQuoteEventRuntime] 释放静态清仓 quote retain 失败',
          formatError(error),
        );
        deps.onFatalError?.(error);
      });
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

    void quoteSubscriptionRuntime
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
        deps.onFatalError?.(error);
      });
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

    clearTimer(targetRouteState.retryTimerHandle);
    targetRouteState.retryTimerHandle = null;
  }

  /**
   * 按 WAIT 结果重建静态清仓 route 的显式 wakeup 与 retry timer。
   *
   * @param executionResult 本轮静态清仓执行结果
   */
  function updateStaticLiquidationWaitState(
    executionResult: Extract<StaticLiquidationRuntimeResult, { kind: 'WAIT' }>,
  ): void {
    if (routeState === null) {
      return;
    }

    const activeRouteState = routeState;

    clearRouteRetryTimer(activeRouteState);
    const nextWakeupSymbols = new Set(executionResult.wakeupSymbols);
    if (!running) {
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

    const delayMs = Math.max(0, executionResult.retryAtMs - (deps.now?.() ?? new Date()).getTime());
    activeRouteState.retryTimerHandle = scheduleTimer(() => {
      if (routeState === activeRouteState) {
        activeRouteState.retryTimerHandle = null;
      }

      triggerRoute();
    }, delayMs);
  }

  /**
   * 判断 runtime 是否仍处于运行态。
   *
   * @returns runtime 仍在运行时返回 true
   */
  function isRuntimeRunning(): boolean {
    return running;
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
   * @returns 是否可以继续执行
   */
  async function waitForExecutionFreshness(): Promise<boolean> {
    if (!isExecutionGateOpen(deps) || !isBaselineReady(deps)) {
      return false;
    }

    if (!deps.postTradeConsistencyRuntime) {
      return true;
    }

    try {
      await deps.postTradeConsistencyRuntime.waitForFresh();
    } catch (error) {
      if (isRefreshGateAbortError(error, 'STOP_AND_DRAIN')) {
        return false;
      }

      throw error;
    }

    return isExecutionGateOpen(deps) && isBaselineReady(deps);
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
        if (!running) {
          return;
        }

        activeRouteState.dirty = false;
        const snapshotEvent = activeRouteState.latestEvent;
        if (!snapshotEvent) {
          clearStaticWakeupIndexes();
          routeState = null;
          return;
        }

        const executionGeneration = activeRouteState.generation;

        const canExecute = await waitForExecutionFreshness();
        if (!canExecute) {
          return;
        }

        if (
          !isRouteExecutionCurrent({
            routeState: activeRouteState,
            generation: executionGeneration,
          })
        ) {
          continue;
        }

        if (activeRouteState.mode === 'DISTANCE_SWITCH') {
          if (!startDistanceSwitch) {
            continue;
          }

          const results = await startDistanceSwitch({
            monitorContext,
            event: snapshotEvent,
            canContinue: () =>
              isRouteExecutionCurrent({
                routeState: activeRouteState,
                generation: executionGeneration,
              }),
          });

          if (
            !isRouteExecutionCurrent({
              routeState: activeRouteState,
              generation: executionGeneration,
            })
          ) {
            continue;
          }

          for (const result of results) {
            if (
              isRuntimeRunning() &&
              handoffPendingSwitch &&
              result.started &&
              result.driveResult.kind === 'WAIT'
            ) {
              handoffPendingSwitch({
                monitorSymbol: runtimeMonitorSymbol,
                direction: result.direction,
                monitorContext,
                driveResult: result.driveResult,
              });
            }
          }

          continue;
        }

        if (!executeStaticLiquidation) {
          continue;
        }

        const executionResult = await executeStaticLiquidation({
          monitorContext,
          event: snapshotEvent,
          retryAttempts: activeRouteState.retryAttempts,
          excludedDirections: activeRouteState.submittedLiquidationDirections,
          canContinue: () =>
            isRouteExecutionCurrent({
              routeState: activeRouteState,
              generation: executionGeneration,
            }),
          onDirectionSubmitted: (direction) => {
            if (
              isRouteExecutionCurrent({
                routeState: activeRouteState,
                generation: executionGeneration,
              })
            ) {
              activeRouteState.submittedLiquidationDirections.add(direction);
            }
          },
        });

        if (
          !isRouteExecutionCurrent({
            routeState: activeRouteState,
            generation: executionGeneration,
          })
        ) {
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
    if (!running) {
      return;
    }

    const eventMonitorContext = matchMonitorContextForQuoteEvent({
      monitorContext,
      event,
    });
    if (eventMonitorContext) {
      const mode: MonitorQuoteRouteMode = eventMonitorContext.config.autoSearchConfig
        .autoSearchEnabled
        ? 'DISTANCE_SWITCH'
        : 'STATIC_LIQUIDATION';
      const currentRouteState = getOrCreateRouteState(mode);
      currentRouteState.latestEvent = event;
      if (mode === 'STATIC_LIQUIDATION') {
        clearRouteRetryTimer(currentRouteState);
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
    clearRouteRetryTimer(routeState);
    triggerRoute();
  }

  function start(): void {
    if (running) {
      return;
    }

    running = true;
    unsubscribeQuoteUpdated = marketDataClient.onQuoteUpdated(handleQuoteUpdated);
  }

  async function stopAndDrain(): Promise<void> {
    running = false;
    unsubscribeQuoteUpdated?.();
    unsubscribeQuoteUpdated = null;

    if (routeState !== null) {
      clearRouteRetryTimer(routeState);
      clearStaticWakeupIndexes();
      releaseStaticLiquidationRetain();
      routeState.wakeupSymbols = new Set();
    }

    if (activePromises.size > 0) {
      await Promise.allSettled(activePromises);
    }

    if (routeState !== null) {
      clearRouteRetryTimer(routeState);
      clearStaticWakeupIndexes();
      releaseStaticLiquidationRetain();
      routeState.wakeupSymbols = new Set();
    }

    clearStaticWakeupIndexes();
    routeState = null;
  }

  return {
    start,
    stopAndDrain,
  };
}
