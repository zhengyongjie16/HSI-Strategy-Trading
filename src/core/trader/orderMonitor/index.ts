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
  OrderMutationRequest,
  OrderMonitor,
  OrderMonitorDeps,
  PendingSellOrderSnapshot,
} from '../types.js';
import type { OrderStateChangedEvent, RawOrderFromAPI } from '../../../types/services.js';
import type {
  OrderMonitorRuntimeStore,
  OrderMonitorTrackedOrder,
  OrderMonitorWakeupKind,
  RouteRuntime,
} from './types.js';
import { buildOrderMonitorConfig } from './utils.js';
import { createRecoveryFlow } from './recoveryFlow.js';
import { createEventFlow } from './eventFlow.js';
import { createSettlementFlow } from './settlementFlow.js';
import { createOrderStatusQuery } from './orderStatusQuery.js';
import {
  consumeQueriedTerminalState,
  createOrderOps,
  resetOrderReplaceRuntimeState,
} from './orderOps.js';
import { createRouteRuntime } from './routeRuntime.js';
import { createRouteProcessor } from './routeProcessor.js';
import type { CancelOrderOutcome } from '../../../types/trader.js';
import { normalizeTerminalStateSnapshot } from './orderFactMerge.js';

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
    isExecutionAllowed,
  } = deps;
  const config = buildOrderMonitorConfig(tradingConfig.global);
  const thresholdDecimal = toDecimal(config.priceDiffThreshold);
  const runtime: OrderMonitorRuntimeStore = {
    trackedOrders: new Map<string, OrderMonitorTrackedOrder>(),
    trackedOrderLifecycles: new Map(),
    bootstrappingOrderEvents: new Map<string, PushOrderChanged>(),
    closedOrderIds: new Set(),
    queriedTerminalStateByOrderId: new Map(),
    latestReplaceOutcomeByOrderId: new Map(),
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
    cancelOrder: (orderId) => orderOps.cancelOrder(orderId, { kind: 'ORDER_FACT' }),
    settleOrder: settlementFlow.settleOrder,
    handleOrderChangedWhenActive: (event) => {
      if (!activeHandler) {
        throw new Error('[订单监控] ACTIVE 事件处理器尚未初始化');
      }

      activeHandler(event);
    },
  });

  const eventFlow = createEventFlow({
    runtime,
    orderRecorder,
    recordCumulativeExecution: (params) => {
      settlementFlow.recordCumulativeExecution(params);
    },
    settleOrder: settlementFlow.settleOrder,
    cacheBootstrappingEvent: recoveryFlow.cacheBootstrappingEvent,
    triggerRoute,
  });
  activeHandler = eventFlow.handleOrderChangedWhenActive;

  const routeProcessor = createRouteProcessor({
    runtime,
    config,
    thresholdDecimal,
    orderRecorder,
    ctx,
    rateLimiter,
    isExecutionAllowed,
    trackOrder: orderOps.trackOrder,
    cancelOrder: (orderId) => orderOps.cancelOrder(orderId, { kind: 'ORDER_FACT' }),
    settleOrder: settlementFlow.settleOrder,
    replaceOrderPrice: async (orderId, newPrice) => {
      await orderOps.replaceOrderPrice(orderId, newPrice, { kind: 'ORDER_FACT' });
    },
  });

  routeRuntime = createRouteRuntime({
    runtime,
    config,
    marketDataClient,
    processRoute: routeProcessor.processRoute,
    ...(deps.onFatalError ? { onFatalError: deps.onFatalError } : {}),
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

  async function cancelOrder(
    orderId: string,
    request: OrderMutationRequest,
  ): Promise<CancelOrderOutcome> {
    const outcome = await orderOps.cancelOrder(orderId, request);
    if (outcome.kind !== 'ALREADY_CLOSED') {
      return outcome;
    }

    const trackedOrder = runtime.trackedOrders.get(orderId);
    if (!trackedOrder) {
      resetOrderReplaceRuntimeState(runtime, orderId);
      return outcome;
    }

    const terminalState = consumeQueriedTerminalState(runtime, orderId);
    if (terminalState === null) {
      logger.error(
        `[订单监控] 订单 ${orderId} 已确认终态，但缺少权威终态快照，拒绝向调用方暴露半成品结果`,
      );
      return {
        kind: 'UNKNOWN_FAILURE',
        errorCode: null,
        message: `missing terminal state snapshot for settled cancel order ${orderId}`,
      };
    }

    const normalizedTerminalState = normalizeTerminalStateSnapshot(trackedOrder, terminalState);

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
    resetOrderReplaceRuntimeState(runtime, orderId);
    if (!settlementResult.handled && !alreadySettled) {
      logger.error(
        `[订单监控] 订单 ${orderId} 已确认终态，但本地结算失败，拒绝向调用方暴露未结算结果`,
      );
      return {
        kind: 'UNKNOWN_FAILURE',
        errorCode: null,
        message: `terminal settlement failed for cancel order ${orderId}`,
      };
    }

    return {
      ...outcome,
      relatedBuyOrderIds: settlementResult.relatedBuyOrderIds,
    };
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

      eventFlow.handleOrderChanged(event);
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
    replaceOrderPrice: orderOps.replaceOrderPrice,
    startRuntime: routeRuntime.start,
    stopRuntimeAndDrain,
    recoverOrderTrackingFromSnapshot,
    getPendingSellOrders,
    hasPendingProtectiveLiquidationOrders,
    clearTrackedOrders,
  };
}
