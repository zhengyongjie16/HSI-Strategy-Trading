/**
 * TradingRiskEventRuntime
 *
 * 职责：
 * - 监听 quoteClient 发布的标准化 quote 事件
 * - 启动和席位 truth 变化时基于 symbolRegistry 刷新路由索引缓存
 * - 对同一路由执行 single-flight + latest-only collapse
 * - 通过单方向浮亏执行器触发保护性清仓
 */
import { isWithinDoomsdayClearanceTakeoverWindow } from '../../core/doomsdayProtection/utils.js';
import { isValidPositiveNumber } from '../../utils/helpers/index.js';
import {
  isExternalApiRequestError,
  isUnconfirmedOrderSubmissionError,
} from '../../utils/apiFailure/index.js';
import { formatError } from '../../utils/error/index.js';
import { isRefreshGateAbortError } from '../../utils/refreshGate/index.js';
import { isTradingRiskRouteCurrent, resolveTradingRiskRoute } from './routeValidation.js';
import { buildTradingRiskRoutingIndex } from './routingIndex.js';
import { executeDirectionalUnrealizedLoss } from './unrealizedLossExecutor.js';
import type { QuoteUpdatedEvent } from '../../types/services.js';
import type {
  RouteExecutionState,
  TradingRiskEventRuntime,
  TradingRiskEventRuntimeDeps,
  TradingRiskRoutingIndex,
} from './types.js';

/**
 * 创建单 route 的初始执行状态。
 *
 * @returns 初始空状态
 */
function createRouteExecutionState(): RouteExecutionState {
  return {
    inFlight: false,
    dirty: false,
    latestRoute: null,
    latestEvent: null,
  };
}

function shouldExposeRouteProcessingError(error: unknown): boolean {
  return !isExternalApiRequestError(error) || isUnconfirmedOrderSubmissionError(error);
}

/**
 * 创建 TradingRiskEventRuntime。
 *
 * @param deps 风险 runtime 依赖
 * @returns TradingRiskEventRuntime 实例
 */
export function createTradingRiskEventRuntime(
  deps: TradingRiskEventRuntimeDeps,
): TradingRiskEventRuntime {
  const { logger } = deps;
  let running = false;
  let unsubscribeQuoteUpdated: (() => void) | null = null;
  let unsubscribeSeatTruthChanged: (() => void) | null = null;
  let cachedRoutingIndex: TradingRiskRoutingIndex | null = null;
  const routeStates = new Map<'LONG' | 'SHORT', RouteExecutionState>();
  const activeRoutePromises = new Set<Promise<void>>();

  /**
   * 获取或创建 route 状态。
   *
   * @param direction 方向级执行键
   * @returns 对应的执行状态
   */
  function getRouteState(direction: 'LONG' | 'SHORT'): RouteExecutionState {
    const existing = routeStates.get(direction);
    if (existing) {
      return existing;
    }

    const nextState = createRouteExecutionState();
    routeStates.set(direction, nextState);
    return nextState;
  }

  /**
   * 清理已经不再活跃且没有 in-flight 的 route 状态。
   *
   * @param activeRouteKeys 当前 symbolRegistry 快照下的活跃方向集合
   */
  function pruneRouteStates(activeRouteKeys: ReadonlySet<'LONG' | 'SHORT'>): void {
    for (const [direction, state] of routeStates) {
      if (state.inFlight) {
        continue;
      }

      if (!activeRouteKeys.has(direction)) {
        routeStates.delete(direction);
      }
    }
  }

  /** 索引不变量错误同步进入唯一 fatal，原始错误不做类型转换。 */
  function enterRoutingIndexFatal(error: unknown): void {
    deps.termination.reportFatalError(error);
    stop();
    cachedRoutingIndex = null;
    routeStates.clear();
    logger.error('[TradingRiskEventRuntime] 路由索引进入 fatal 状态', formatError(error));
  }

  /**
   * 基于当前 SymbolRegistry 权威快照同步刷新路由索引缓存。
   *
   * @returns 最新路由索引
   */
  function refreshRoutingIndex(): TradingRiskRoutingIndex {
    try {
      const routingIndex = buildTradingRiskRoutingIndex({
        symbolRegistry: deps.symbolRegistry,
      });
      cachedRoutingIndex = routingIndex;
      pruneRouteStates(routingIndex.activeRouteKeys);
      return routingIndex;
    } catch (error) {
      enterRoutingIndexFatal(error);
      throw error;
    }
  }

  /**
   * 读取 quote 与 route 校验路径可使用的路由索引；fatal 状态下返回空。
   *
   * @returns 当前可用路由索引，fatal 或未初始化时返回 null
   */
  function getActiveRoutingIndex(): TradingRiskRoutingIndex | null {
    if (deps.termination.isTerminated()) {
      return null;
    }

    return cachedRoutingIndex;
  }

  /**
   * 判断当前 runtime gate 是否打开。
   *
   * 该 gate 必须同时复用 lifecycle 交易门禁、连续交易时段门禁，以及末日保护清仓接管窗口语义。
   *
   * @returns 允许执行风险事件时返回 true
   */
  function isExecutionGateOpen(): boolean {
    if (
      !running ||
      deps.termination.isTerminated() ||
      !deps.lastState.isTradingEnabled ||
      deps.lastState.canTrade !== true
    ) {
      return false;
    }

    if (!deps.doomsdayProtectionEnabled) {
      return true;
    }

    return !isWithinDoomsdayClearanceTakeoverWindow(deps.now(), deps.lastState.isHalfDay ?? false);
  }

  /**
   * 判断当前 baseline 是否已经完成。
   *
   * @returns 已启动且 currentVersion 追平 staleVersion 时返回 true
   */
  function isBaselineReady(): boolean {
    const status = deps.postTradeConsistencyRuntime.getStatus();
    return status.started && status.currentVersion === status.staleVersion;
  }

  /**
   * 发起某个 route 的 single-flight 执行。
   *
   * @param direction 方向级执行键
   */
  function launchRouteProcessing(direction: 'LONG' | 'SHORT'): void {
    const processingPromise = processRouteQueue(direction).catch((error: unknown) => {
      logger.error('[TradingRiskEventRuntime] 风险事件处理失败', formatError(error));
      if (shouldExposeRouteProcessingError(error)) {
        deps.termination.reportFatalError(error);
      }
    });

    activeRoutePromises.add(processingPromise);
    void processingPromise.finally(() => {
      activeRoutePromises.delete(processingPromise);
    });
  }

  /**
   * 响应席位状态或版本 truth 变化并立即同步重投影路由索引。
   */
  function handleSeatTruthChanged(): void {
    if (!running || deps.termination.isTerminated()) {
      return;
    }

    try {
      refreshRoutingIndex();
    } catch (error) {
      enterRoutingIndexFatal(error);
    }
  }

  /**
   * 消费单条标准化行情事件。
   *
   * @param event quoteClient 发布的标准化 quote 事件
   */
  function handleQuoteUpdated(event: QuoteUpdatedEvent): void {
    if (!running || deps.termination.isTerminated()) {
      return;
    }

    if (!isValidPositiveNumber(event.quote.price)) {
      return;
    }

    const routingIndex = getActiveRoutingIndex();
    if (routingIndex === null) {
      return;
    }

    const route = resolveTradingRiskRoute(routingIndex, event.symbol);
    if (!route) {
      return;
    }

    const routeState = getRouteState(route.direction);
    routeState.latestRoute = route;
    routeState.latestEvent = event;
    routeState.dirty = true;

    if (routeState.inFlight) {
      return;
    }

    routeState.inFlight = true;
    launchRouteProcessing(route.direction);
  }

  /**
   * 处理单 route 的 latest-only 队列。
   *
   * 固定顺序：
   * 1. freshness 前 gate / baseline / seat 校验
   * 2. waitForFresh
   * 3. freshness 后再次校验 gate / baseline / seat
   * 4. 读取当前 route 收敛后的 latest event quote
   * 5. 执行单方向浮亏检查
   *
   * @param direction 方向级执行键
   */
  async function processRouteQueue(direction: 'LONG' | 'SHORT'): Promise<void> {
    const routeState = getRouteState(direction);

    try {
      while (running && routeState.dirty) {
        routeState.dirty = false;

        const snapshotRoute = routeState.latestRoute;
        const snapshotEvent = routeState.latestEvent;
        if (!snapshotRoute || !snapshotEvent) {
          continue;
        }

        if (!isExecutionGateOpen() || !isBaselineReady()) {
          return;
        }

        const routingIndexBeforeFreshness = getActiveRoutingIndex();
        if (routingIndexBeforeFreshness === null) {
          return;
        }

        if (!isTradingRiskRouteCurrent(snapshotRoute, routingIndexBeforeFreshness)) {
          return;
        }

        try {
          await deps.postTradeConsistencyRuntime.waitForFresh();
        } catch (error) {
          if (isRefreshGateAbortError(error, 'STOP_AND_DRAIN')) {
            return;
          }

          throw error;
        }

        if (!isExecutionGateOpen() || !isBaselineReady()) {
          return;
        }

        const routingIndexAfterFreshness = getActiveRoutingIndex();
        if (routingIndexAfterFreshness === null) {
          return;
        }

        if (!isTradingRiskRouteCurrent(snapshotRoute, routingIndexAfterFreshness)) {
          return;
        }

        const latestRoute = routeState.latestRoute;
        const latestEvent = routeState.latestEvent;
        if (!latestRoute || !latestEvent) {
          return;
        }

        if (!isValidPositiveNumber(latestEvent.quote.price)) {
          return;
        }

        await executeDirectionalUnrealizedLoss({
          route: latestRoute,
          event: latestEvent,
          trader: deps.trader,
          monitorContext: deps.monitorContext,
        });
      }
    } finally {
      routeState.inFlight = false;

      const activeRoutingIndex = getActiveRoutingIndex();
      const routeInactive =
        activeRoutingIndex !== null && !activeRoutingIndex.activeRouteKeys.has(direction);

      if (routeInactive) {
        routeStates.delete(direction);
      } else if (routeStates.get(direction) === routeState && routeState.dirty && running) {
        routeState.inFlight = true;
        launchRouteProcessing(direction);
      }
    }
  }

  /**
   * 启动 runtime 并订阅标准化 quote 事件。
   */
  function start(): void {
    if (running || deps.termination.isTerminated()) {
      return;
    }

    refreshRoutingIndex();
    running = true;
    unsubscribeSeatTruthChanged = deps.symbolRegistry.onSeatTruthChanged(handleSeatTruthChanged);

    unsubscribeQuoteUpdated = deps.marketDataClient.onQuoteUpdated((event) => {
      handleQuoteUpdated(event);
    });
  }

  /**
   * 停止 runtime 并等待当前 in-flight route 执行完成。
   */
  function stop(): void {
    running = false;
    unsubscribeQuoteUpdated?.();
    unsubscribeQuoteUpdated = null;
    unsubscribeSeatTruthChanged?.();
    unsubscribeSeatTruthChanged = null;
  }

  async function stopAndDrain(): Promise<void> {
    stop();
    await Promise.all(activeRoutePromises);

    routeStates.clear();
    cachedRoutingIndex = null;
  }

  return {
    start,
    stop,
    stopAndDrain,
  };
}
