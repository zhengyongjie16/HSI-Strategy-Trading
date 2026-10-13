/**
 * TradingRiskEventRuntime
 *
 * 职责：订阅标准化 quote 与席位 truth，维护方向级 single-flight/latest-only 队列，
 * 路由 protective workflow，并在原 readiness 事件到达时唤醒阻塞工作；只管理调度与 stop/drain。
 */
import { formatError } from '../../utils/error/index.js';
import { resolveTradingRiskRoute } from './routeValidation.js';
import { buildTradingRiskRoutingIndex } from './routingIndex.js';
import type { QuoteUpdatedEvent } from '../../types/marketPorts.js';
import type {
  RouteExecutionState,
  TradingRiskEventRuntime,
  TradingRiskEventRuntimeDeps,
  TradingRiskRoutingIndex,
} from './types.js';

function createRouteExecutionState(): RouteExecutionState {
  return {
    inFlight: false,
    dirty: false,
    latestTrigger: null,
    blockedOnFreshness: false,
  };
}

/** 创建仅调度风险行情工作的 runtime；业务门禁和失败分类由 protective owner 执行。 */
export function createTradingRiskEventRuntime(
  deps: TradingRiskEventRuntimeDeps,
): TradingRiskEventRuntime {
  const { logger } = deps;
  let running = false;
  let unsubscribeQuoteUpdated: (() => void) | null = null;
  let unsubscribeSeatTruthChanged: (() => void) | null = null;
  let unsubscribeFreshReached: (() => void) | null = null;
  let cachedRoutingIndex: TradingRiskRoutingIndex | null = null;
  const routeStates = new Map<'LONG' | 'SHORT', RouteExecutionState>();
  const activeRoutePromises = new Set<Promise<void>>();

  function isExecutionActive(): boolean {
    return running && !deps.termination.isTerminated();
  }

  function getRouteState(direction: 'LONG' | 'SHORT'): RouteExecutionState {
    const existing = routeStates.get(direction);
    if (existing) return existing;

    const nextState = createRouteExecutionState();
    routeStates.set(direction, nextState);
    return nextState;
  }

  function pruneRouteStates(activeRouteKeys: ReadonlySet<'LONG' | 'SHORT'>): void {
    for (const [direction, state] of routeStates) {
      if (!state.inFlight && !activeRouteKeys.has(direction)) routeStates.delete(direction);
    }
  }

  /** 路由不变量错误同步进入唯一 fatal，停止事件准入，原始错误不转成外部失败。 */
  function enterRoutingIndexFatal(error: unknown): void {
    deps.termination.reportFatalError(error);
    stop();
    cachedRoutingIndex = null;
    routeStates.clear();
    logger.error('[TradingRiskEventRuntime] 路由索引进入 fatal 状态', formatError(error));
  }

  function refreshRoutingIndex(): void {
    const routingIndex = buildTradingRiskRoutingIndex({ symbolRegistry: deps.symbolRegistry });
    cachedRoutingIndex = routingIndex;
    pruneRouteStates(routingIndex.activeRouteKeys);
  }

  function launchRouteProcessing(direction: 'LONG' | 'SHORT'): void {
    const processingPromise = processRouteQueue(direction).catch((error: unknown) => {
      // application 已处理明确外部失败，剩余内部/UNKNOWN 错误只交给唯一 fatal supervisor。
      deps.termination.reportFatalError(error);
    });
    activeRoutePromises.add(processingPromise);
    void processingPromise.finally(() => {
      activeRoutePromises.delete(processingPromise);
    });
  }

  function handleSeatTruthChanged(): void {
    if (!isExecutionActive()) return;

    try {
      refreshRoutingIndex();
    } catch (error) {
      enterRoutingIndexFatal(error);
    }
  }

  /** 只消费原 readiness 事件，不轮询或制造新的 settlement stale。 */
  function handleFreshReached(): void {
    if (!isExecutionActive()) return;

    for (const [direction, state] of routeStates) {
      if (!state.blockedOnFreshness) continue;

      state.blockedOnFreshness = false;
      state.dirty = true;
      if (state.inFlight) continue;

      state.inFlight = true;
      launchRouteProcessing(direction);
    }
  }

  /** 路由标准化行情；报价检查与事件 epoch 捕获由真正业务 owner 同步完成。 */
  function handleQuoteUpdated(event: QuoteUpdatedEvent): void {
    if (!isExecutionActive() || cachedRoutingIndex === null) return;

    const route = resolveTradingRiskRoute(cachedRoutingIndex, event.symbol);
    let trigger;
    try {
      trigger = deps.workflow.captureTrigger(route, event);
    } catch (error) {
      deps.termination.reportFatalError(error);
      stop();
      return;
    }

    if (trigger === null) return;

    const state = getRouteState(trigger.route.direction);
    state.latestTrigger = trigger;
    state.dirty = true;
    if (state.inFlight) return;

    state.inFlight = true;
    launchRouteProcessing(trigger.route.direction);
  }

  /** 串行交付每方向最新工作；是否等待 readiness 或重评由 application 返回明确调度结论。 */
  async function processRouteQueue(direction: 'LONG' | 'SHORT'): Promise<void> {
    const state = getRouteState(direction);
    try {
      while (isExecutionActive() && state.dirty) {
        state.dirty = false;
        state.blockedOnFreshness = false;
        const trigger = state.latestTrigger;
        if (trigger === null) continue;

        const result = await deps.workflow.execute({
          trigger,
          getLatestTrigger: () => state.latestTrigger,
          isExecutionActive,
          onFreshnessBlocked: () => {
            state.blockedOnFreshness = true;
          },
        });
        if (result === 'WAIT_FOR_FRESHNESS') return;

        if (result === 'RETRY_LATEST') state.dirty = true;
      }
    } finally {
      state.inFlight = false;
      const routeInactive =
        cachedRoutingIndex !== null && !cachedRoutingIndex.activeRouteKeys.has(direction);
      if (routeInactive) {
        routeStates.delete(direction);
      } else if (routeStates.get(direction) === state && state.dirty && isExecutionActive()) {
        state.inFlight = true;
        launchRouteProcessing(direction);
      }
    }
  }

  function start(): void {
    if (running || deps.termination.isTerminated()) return;

    try {
      refreshRoutingIndex();
    } catch (error) {
      enterRoutingIndexFatal(error);
      throw error;
    }

    running = true;
    unsubscribeSeatTruthChanged = deps.symbolRegistry.onSeatTruthChanged(handleSeatTruthChanged);
    unsubscribeFreshReached = deps.postTradeConsistencyRuntime.onFreshReached(handleFreshReached);
    unsubscribeQuoteUpdated = deps.marketDataClient.onQuoteUpdated(handleQuoteUpdated);
  }

  /** 同步关闭新事件准入；现有 await 通过同一 isExecutionActive 授权阻断后续业务副作用。 */
  function stop(): void {
    running = false;
    unsubscribeQuoteUpdated?.();
    unsubscribeQuoteUpdated = null;
    unsubscribeSeatTruthChanged?.();
    unsubscribeSeatTruthChanged = null;
    unsubscribeFreshReached?.();
    unsubscribeFreshReached = null;
  }

  async function stopAndDrain(): Promise<void> {
    stop();
    await Promise.all(activeRoutePromises);
    routeStates.clear();
    cachedRoutingIndex = null;
  }

  return { start, stop, stopAndDrain };
}
