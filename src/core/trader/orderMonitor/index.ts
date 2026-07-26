/**
 * 订单监控模块（WebSocket 推送）
 *
 * 职责：
 * - 组装恢复流、事件流、订单操作流、单订单状态查询、route runtime/processor 与终态结算流程
 * - 初始化 WebSocket 私有主题订阅并分发订单推送
 * - 对外暴露事件驱动的 OrderMonitor 接口
 */
import { OrderSide, OrderStatus, TopicType, type PushOrderChanged } from 'longbridge';
import { logger } from '../../../utils/logger/index.js';
import { wrapExternalApiRequest } from '../../../utils/apiFailure/index.js';
import { toDecimal } from '../utils.js';
import { isOpenOrderStatus } from '../../orderStatusLifecycle/utils.js';
import type {
  CancelOrderMutationRequest,
  OrderMutationRequest,
  OrderMonitor,
  OrderMonitorDeps,
  PendingSellOrderSnapshot,
} from '../types.js';
import type {
  OrderStateChangedEvent,
  RawOrderFromAPI,
  TradeMutationPermit,
} from '../../../types/services.js';
import type {
  CancelOrderBeforeBrokerMutation,
  CancelOrderPreflightOutcome,
  OrderMonitorRuntimeStore,
  OrderMonitorTrackedOrder,
  OrderMonitorWakeupKind,
  RouteRuntime,
  TerminalStateSnapshot,
} from './types.js';
import { buildOrderMonitorConfig } from './utils.js';
import { createRecoveryFlow } from './recoveryFlow.js';
import { createEventFlow } from './eventFlow.js';
import { createSettlementFlow } from './settlementFlow.js';
import { createOrderStatusQuery } from './orderStatusQuery.js';
import {
  acknowledgeLatestReplaceTerminal,
  acknowledgeQueriedTerminalState,
  createOrderOps,
  peekLatestReplaceTerminal,
  peekQueriedTerminalState,
} from './orderOps.js';
import { createRouteRuntime } from './routeRuntime.js';
import { createRouteProcessor } from './routeProcessor.js';
import type {
  CancelOrderOutcome,
  DoomsdayCancelOrderOutcome,
  DoomsdayCancelOrderRequest,
} from '../../../types/trader.js';
import {
  assertProtectiveSellRawTerminalStateFactsReady,
  normalizeTerminalStateSnapshot,
} from './orderFactMerge.js';

/** 将只允许 route 内部使用的撤单结果阻断在公共 API 边界。 */
function requirePublicCancelOrderOutcome(outcome: CancelOrderPreflightOutcome): CancelOrderOutcome {
  if (outcome.kind === 'CANCEL_NOT_STARTED') {
    throw new Error('[订单监控] 常规撤单不得返回 CANCEL_NOT_STARTED');
  }

  return outcome;
}

/**
 * 创建订单监控器。
 *
 * @param deps 依赖（ctx、rateLimiter、cacheManager、orderRecorder、dailyLossTracker、orderHoldRegistry、tradingConfig 等）
 * @returns 实现 OrderMonitor 接口的实例
 */
export function createOrderMonitor(deps: OrderMonitorDeps): OrderMonitor {
  const {
    ctx,
    rateLimiter,
    cacheManager,
    marketDataClient,
    orderRecorder,
    dailyLossTracker,
    orderHoldRegistry,
    protectiveLiquidationEpisodeTracker,
    persistProtectiveLiquidationExecutionProgress,
    postTradeConsistencyRuntime,
    tradingConfig,
    symbolRegistry,
    isContinuousTradingAllowed,
    now,
    scheduleTimer,
    clearTimer,
  } = deps;
  const config = buildOrderMonitorConfig(tradingConfig.global);
  const thresholdDecimal = toDecimal(config.priceDiffThreshold);
  const runtime: OrderMonitorRuntimeStore = {
    trackedOrders: new Map<string, OrderMonitorTrackedOrder>(),
    trackedOrderLifecycles: new Map(),
    bootstrappingOrderEvents: new Map<string, PushOrderChanged>(),
    closedOrderIds: new Set(),
    queriedTerminalStateByOrderId: new Map(),
    latestReplaceTerminalByOrderId: new Map(),
    orderStateChangedListeners: new Set(),
    trackedOrderIdsBySymbol: new Map(),
    routeStatesBySymbol: new Map(),
    latestRouteGenerationBySymbol: new Map(),
    runtimeState: 'STOPPED',
    running: false,
    unsubscribeQuoteUpdated: null,
  };
  let initialized = false;
  let routeRuntime: RouteRuntime | null = null;

  function triggerRoute(symbol: string, wakeupKind: OrderMonitorWakeupKind): void {
    if (routeRuntime === null) {
      throw new Error('[订单监控] route runtime 尚未初始化，禁止触发 route');
    }

    routeRuntime.triggerRoute(symbol, wakeupKind);
  }

  const settlementFlow = createSettlementFlow({
    runtime,
    orderHoldRegistry,
    orderRecorder,
    dailyLossTracker,
    protectiveLiquidationEpisodeTracker,
    persistProtectiveLiquidationExecutionProgress,
    postTradeConsistencyRuntime,
    emitOrderStateChanged: (event) => {
      for (const listener of runtime.orderStateChangedListeners) {
        listener(event);
      }
    },
  });

  const orderStatusQuery = createOrderStatusQuery({
    ctx,
    rateLimiter,
  });

  const orderOps = createOrderOps({
    now,
    runtime,
    monitorConfig: tradingConfig.monitor,
    ctx,
    rateLimiter,
    cacheManager,
    orderHoldRegistry,
    orderRecorder,
    recordCumulativeExecution: (params) => {
      settlementFlow.recordCumulativeExecution(params);
    },
    orderStatusQuery,
    triggerRoute,
  });

  let activeHandler: ((event: PushOrderChanged) => void) | null = null;
  const recoveryFlow = createRecoveryFlow({
    runtime,
    orderHoldRegistry,
    orderRecorder,
    tradingConfig,
    symbolRegistry,
    trackOrder: orderOps.trackOrder,
    cancelOrder: async (orderId) =>
      requirePublicCancelOrderOutcome(await orderOps.cancelOrder(orderId, { kind: 'ORDER_FACT' })),
    settleOrder: settlementFlow.settleOrder,
    handleOrderChangedWhenActive: (event) => {
      if (!activeHandler) {
        throw new Error('[订单监控] ACTIVE 事件处理器尚未初始化');
      }

      activeHandler(event);
    },
  });

  const eventFlow = createEventFlow({
    now,
    runtime,
    orderRecorder,
    recordCumulativeExecution: (params) => {
      settlementFlow.recordCumulativeExecution(params);
    },
    prepareProtectiveTerminalExecution: settlementFlow.prepareProtectiveTerminalExecution,
    settleOrder: settlementFlow.settleOrder,
    cacheBootstrappingEvent: recoveryFlow.cacheBootstrappingEvent,
    triggerRoute,
  });
  activeHandler = eventFlow.handleOrderChangedWhenActive;

  function cancelOrderForRoute(
    orderId: string,
    beforeBrokerCancel?: CancelOrderBeforeBrokerMutation,
  ): Promise<CancelOrderPreflightOutcome> {
    return orderOps.cancelOrder(orderId, { kind: 'ORDER_FACT' }, beforeBrokerCancel);
  }

  const routeProcessor = createRouteProcessor({
    now,
    runtime,
    config,
    thresholdDecimal,
    orderRecorder,
    ctx,
    rateLimiter,
    isContinuousTradingAllowed,
    trackOrder: orderOps.trackOrder,
    cancelOrder: cancelOrderForRoute,
    settleOrder: settlementFlow.settleOrder,
    replaceOrderPrice: async (orderId, newPrice) => {
      await orderOps.replaceOrderPrice(orderId, newPrice, {
        kind: 'CONTINUOUS_TRADING_AUTHORIZED',
        authorize: isContinuousTradingAllowed,
      });
    },
  });

  routeRuntime = createRouteRuntime({
    runtime,
    config,
    marketDataClient,
    processRoute: routeProcessor.processRoute,
    now,
    scheduleTimer,
    clearTimer,
    onFatalError: deps.onFatalError,
  });

  async function recoverOrderTrackingFromSnapshot(
    allOrders: ReadonlyArray<RawOrderFromAPI>,
  ): Promise<void> {
    await recoveryFlow.recoverOrderTrackingFromSnapshot(allOrders);
    if (routeRuntime === null) {
      throw new Error('[订单监控] route runtime 尚未初始化，禁止恢复后 bootstrap route');
    }

    routeRuntime.bootstrapActiveRoutes();
  }

  /**
   * 活跃订单 state-check 终态的唯一收口入口。
   *
   * 调用方必须先 peek 原始 broker snapshot；本入口只接受通过严格 raw 准入后的
   * canonical 事实。结算失败时不确认缓存，使同一原始观察能安全重试。
   */
  function settleActiveTerminalFromRaw(
    orderId: string,
    trackedOrder: OrderMonitorTrackedOrder,
    terminalState: TerminalStateSnapshot,
  ) {
    assertProtectiveSellRawTerminalStateFactsReady(trackedOrder, terminalState);
    const isProtectiveSell =
      trackedOrder.side === OrderSide.Sell && trackedOrder.isProtectiveLiquidation;
    const normalizedTerminalState = normalizeTerminalStateSnapshot(
      trackedOrder,
      terminalState,
      isProtectiveSell,
    );
    const alreadySettled = runtime.closedOrderIds.has(orderId);
    const settlementResult = settlementFlow.settleOrder({
      orderId,
      closedReason: normalizedTerminalState.closedReason,
      source: 'STATE_CHECK',
      executedPrice: normalizedTerminalState.executedPrice,
      executedQuantity: normalizedTerminalState.executedQuantity,
      executedTimeMs: normalizedTerminalState.executedTimeMs,
      orderUpdatedAtMs: normalizedTerminalState.orderUpdatedAtMs,
    });

    return {
      alreadySettled,
      normalizedTerminalState,
      settlementResult,
    };
  }

  /**
   * 在统一撤单 mutation 后完成权威终态的本地结算。
   * 普通与末日入口共享 broker/终态事实链路，仅在公开结果是否允许
   * `CANCEL_NOT_STARTED` 上分流，避免两条路径的结算语义漂移。
   *
   * @param orderId 订单唯一标识
   * @param request 撤单 mutation 授权来源
   * @returns 包含 permit 内未开始事实或已完成本地结算的撤单结果
   */
  async function cancelAndSettle(
    orderId: string,
    request: CancelOrderMutationRequest,
  ): Promise<CancelOrderPreflightOutcome> {
    const outcome = await orderOps.cancelOrder(orderId, request);
    if (outcome.kind === 'CANCEL_NOT_STARTED') {
      return outcome;
    }

    if (outcome.kind !== 'ALREADY_CLOSED') {
      return outcome;
    }

    const trackedOrder = runtime.trackedOrders.get(orderId);
    if (!trackedOrder) {
      const terminalState = peekQueriedTerminalState(runtime, orderId);
      if (terminalState !== null) {
        acknowledgeQueriedTerminalState(runtime, orderId, terminalState);
      }

      return outcome;
    }

    const terminalState = peekQueriedTerminalState(runtime, orderId);
    if (terminalState === null) {
      logger.error(
        `[订单监控] 订单 ${orderId} 已确认终态，但缺少 raw terminal snapshot，拒绝向调用方暴露半成品结果`,
      );
      return {
        kind: 'UNKNOWN_FAILURE',
        errorCode: null,
      };
    }

    const terminalSettlement = settleActiveTerminalFromRaw(orderId, trackedOrder, terminalState);
    if (!terminalSettlement.settlementResult.handled && !terminalSettlement.alreadySettled) {
      logger.error(
        `[订单监控] 订单 ${orderId} 已确认终态，但本地结算失败，拒绝向调用方暴露未结算结果`,
      );
      return {
        kind: 'UNKNOWN_FAILURE',
        errorCode: null,
      };
    }

    acknowledgeQueriedTerminalState(runtime, orderId, terminalState);

    const terminalExecution = {
      submittedQuantity: terminalState.submittedQuantity,
      // 结算可使用已知事实防止陈旧查询倒退；重规划则必须保留经纪商原始成交量是否缺失。
      executedQuantity:
        terminalState.executedQuantity === null
          ? null
          : terminalSettlement.normalizedTerminalState.executedQuantity,
    };

    return {
      ...outcome,
      relatedBuyOrderIds: terminalSettlement.settlementResult.relatedBuyOrderIds,
      terminalExecution,
    };
  }

  /**
   * 执行常规撤单，并阻断只允许末日路径观察的未开始结果。
   *
   * @param orderId 订单唯一标识
   * @param request 常规 mutation 授权来源
   * @returns 常规撤单结果
   */
  async function cancelOrder(
    orderId: string,
    request: OrderMutationRequest,
  ): Promise<CancelOrderOutcome> {
    return requirePublicCancelOrderOutcome(await cancelAndSettle(orderId, request));
  }

  /**
   * 执行末日保护撤单，保留 permit 内门禁失效且 broker 未调用的事实。
   *
   * @param orderId 订单唯一标识
   * @param request 末日窗口授权请求
   * @returns 末日保护撤单结果
   */
  function cancelDoomsdayOrder(
    orderId: string,
    request: DoomsdayCancelOrderRequest,
  ): Promise<DoomsdayCancelOrderOutcome> {
    return cancelAndSettle(orderId, request);
  }

  /**
   * 在外层最终报价 callback permit 内执行信号驱动改单，并沿用同一终态结算收口。
   * 该入口没有可选 permit 或重新排队分支，防止 final quote 与 SDK replace 之间出现 TOCTOU。
   */
  async function replaceOrderPriceWithPermit(
    orderId: string,
    newPrice: number,
    request: OrderMutationRequest,
    permit: TradeMutationPermit,
    quantity?: number | null,
  ) {
    const result = await orderOps.replaceOrderPriceWithPermit(
      orderId,
      newPrice,
      request,
      permit,
      quantity,
    );
    const replaceTerminal = peekLatestReplaceTerminal(runtime, orderId);
    if (replaceTerminal === null) {
      return result;
    }

    const trackedOrder = runtime.trackedOrders.get(orderId);
    if (trackedOrder === undefined) {
      return result;
    }

    const terminalSettlement = settleActiveTerminalFromRaw(orderId, trackedOrder, replaceTerminal);
    if (!terminalSettlement.settlementResult.handled && !terminalSettlement.alreadySettled) {
      throw new Error(`[订单监控] 订单 ${orderId} 改单终态已确认但本地结算失败`);
    }

    acknowledgeLatestReplaceTerminal(runtime, orderId, replaceTerminal);
    acknowledgeQueriedTerminalState(runtime, orderId, replaceTerminal);
    return result;
  }

  /**
   * 初始化 WebSocket 订阅（订阅 Private 主题）。
   *
   * @returns 初始化 Promise
   */
  async function initialize(): Promise<void> {
    if (runtime.runtimeState === 'STOPPED') {
      runtime.runtimeState = 'BOOTSTRAPPING';
      recoveryFlow.clearBootstrappingEventBuffer();
    }

    if (initialized) {
      return;
    }

    ctx.setOnOrderChanged((err: Error | null, event: PushOrderChanged) => {
      if (err) {
        logger.error('[订单监控] WebSocket 推送错误:', err.message);
        return;
      }

      try {
        eventFlow.handleOrderChanged(event);
      } catch (error: unknown) {
        deps.onFatalError(error);
      }
    });

    await wrapExternalApiRequest({
      operation: 'TradeContext.subscribe.private',
      request: () => ctx.subscribe([TopicType.Private]),
    });
    initialized = true;
    logger.info('[订单监控] WebSocket 订阅初始化成功');
  }

  /**
   * 清空恢复相关运行态与 BOOTSTRAPPING 事件缓存。
   *
   * @returns 无返回值
   */
  function clearTrackedOrders(): void {
    recoveryFlow.resetRecoveryTrackingState();
    recoveryFlow.clearBootstrappingEventBuffer();
    runtime.trackedOrderLifecycles.clear();
    runtime.closedOrderIds.clear();
    runtime.runtimeState = 'STOPPED';
  }

  /**
   * 先关闭订单监控入口并丢弃 BOOTSTRAPPING 缓冲事件，再排空所有 symbol route。
   *
   * 先切换为 STOPPED 可阻止停止期间的晚到 WS 事件继续推进；route 排空完成前不清除
   * tracked truth，供已在途的订单动作安全收口。
   *
   * @returns 所有在途 route 完成后的 Promise
   * @throws route runtime 尚未初始化，或在途 route 以错误结束时抛出
   */
  async function stopRuntimeAndDrain(): Promise<void> {
    runtime.runtimeState = 'STOPPED';
    recoveryFlow.clearBootstrappingEventBuffer();
    if (routeRuntime === null) {
      throw new Error('[订单监控] route runtime 尚未初始化，禁止停止 runtime');
    }

    await routeRuntime.stopAndDrain();
  }

  function onOrderStateChanged(listener: (event: OrderStateChangedEvent) => void): () => void {
    runtime.orderStateChangedListeners.add(listener);
    return () => {
      runtime.orderStateChangedListeners.delete(listener);
    };
  }

  /**
   * 获取指定标的的未成交卖单快照。
   *
   * 这里只读取 runtime tracked truth，不再依赖旧 quoteFlow owner。
   *
   * @param symbol 标的代码
   * @returns 卖单快照列表（按 submittedAt 升序）
   */
  function getPendingSellOrders(symbol: string): ReadonlyArray<PendingSellOrderSnapshot> {
    const pendingOrders: PendingSellOrderSnapshot[] = [];
    for (const order of runtime.trackedOrders.values()) {
      if (order.symbol !== symbol || order.side !== OrderSide.Sell) {
        continue;
      }

      if (!isOpenOrderStatus(order.status)) {
        continue;
      }

      if (order.status === OrderStatus.PartialWithdrawal) {
        continue;
      }

      const remaining = order.submittedQuantity - order.executedQuantity;
      if (!Number.isFinite(remaining) || remaining <= 0) {
        continue;
      }

      pendingOrders.push({
        orderId: order.orderId,
        symbol: order.symbol,
        side: order.side,
        status: order.status,
        orderType: order.orderType,
        submittedPrice: order.submittedPrice,
        submittedQuantity: order.submittedQuantity,
        executedQuantity: order.executedQuantity,
        submittedAt: order.submittedAt,
      });
    }

    return [...pendingOrders].sort((left, right) => left.submittedAt - right.submittedAt);
  }

  function hasPendingProtectiveLiquidationOrders(direction: 'LONG' | 'SHORT'): boolean {
    for (const trackedOrder of runtime.trackedOrders.values()) {
      if (!trackedOrder.isProtectiveLiquidation) {
        continue;
      }

      if (!isOpenOrderStatus(trackedOrder.status)) {
        continue;
      }

      if (trackedOrder.side !== OrderSide.Sell) {
        continue;
      }

      const trackedDirection = trackedOrder.isLongSymbol ? 'LONG' : 'SHORT';
      if (trackedDirection === direction) {
        return true;
      }
    }

    return false;
  }

  return {
    initialize,
    onOrderStateChanged,
    trackOrder: orderOps.trackOrder,
    cancelOrder,
    cancelDoomsdayOrder,
    replaceOrderPriceWithPermit,
    startRuntime: routeRuntime.start,
    stopRuntimeAndDrain,
    recoverOrderTrackingFromSnapshot,
    getPendingSellOrders,
    hasPendingProtectiveLiquidationOrders,
    clearTrackedOrders,
  };
}
