/**
 * orderMonitor 恢复流程模块
 *
 * 职责：
 * - 管理 BOOTSTRAPPING 阶段订单事件缓存与回放
 * - 执行快照恢复、席位一致性校验与失败回滚
 * - 消费权威终态快照并恢复未完成订单追踪
 */
import { OrderSide, OrderType, type PushOrderChanged } from 'longbridge';
import { logger } from '../../../utils/logger/index.js';
import { decimalToNumber, isValidPositiveNumber } from '../../../utils/helpers/index.js';
import { PENDING_ORDER_STATUSES } from '../../../constants/index.js';
import type { RawOrderFromAPI } from '../../../types/services.js';
import { resolveOrderOwnershipForMonitor } from '../../riskController/orderOwnership.js';
import { isSeatActive } from '../../../utils/seat/guards.js';
import type {
  OrderSeatOwnership,
  RecoverySnapshotReconciliationParams,
  TrackOrderParams,
} from '../types.js';
import type { RecoveryFlow, RecoveryFlowDeps } from './types.js';
import { consumeQueriedTerminalState, resetOrderReplaceRuntimeState } from './orderOps.js';
import { resolveSubmittedAtMs, resolveUpdatedAtMs } from './utils.js';
import { hasProtectiveLiquidationRemark } from '../utils.js';

/**
 * 解析恢复快照中的委托价。
 *
 * 对市价单，Longbridge 快照价格可能为空，恢复时允许使用 0 作为“无价格”语义；
 * 对需要价格语义的挂单，缺少有效委托价会破坏后续追价与边界判断，必须直接阻断恢复。
 *
 * @param order 快照订单
 * @returns 恢复后写入 tracked order 的委托价
 */
function resolveRecoveredTrackedPrice(order: RawOrderFromAPI): number {
  if (order.orderType === OrderType.MO) {
    return 0;
  }

  const trackedPrice = decimalToNumber(order.price);
  if (isValidPositiveNumber(trackedPrice)) {
    return trackedPrice;
  }

  throw new Error(`[订单监控] 订单 ${order.orderId} 委托价格无效，无法恢复追踪`);
}

/**
 * 创建恢复流程处理器。
 *
 * @param deps 恢复流程依赖
 * @returns 恢复流程接口
 */
export function createRecoveryFlow(deps: RecoveryFlowDeps): RecoveryFlow {
  const {
    runtime,
    orderHoldRegistry,
    monitorConfig,
    symbolRegistry,
    trackOrder,
    cancelOrder,
    settleOrder,
    handleOrderChangedWhenActive,
  } = deps;

  function resolveOrderSeatOwnership(order: RawOrderFromAPI): OrderSeatOwnership | null {
    const resolved = resolveOrderOwnershipForMonitor(order, monitorConfig);
    if (!resolved) {
      return null;
    }

    return {
      baseInstrumentSymbol: resolved.baseInstrumentSymbol,
      direction: resolved.direction,
      isLongSymbol: resolved.direction === 'LONG',
    };
  }

  function isSeatMatchedForOrder(order: RawOrderFromAPI, ownership: OrderSeatOwnership): boolean {
    const seatState = symbolRegistry.getSeatState(ownership.direction);
    if (!isSeatActive(seatState)) {
      return false;
    }

    return seatState.symbol === order.symbol;
  }

  function resetRecoveryTrackingState(): void {
    for (const trackedOrder of runtime.trackedOrders.values()) {
      orderHoldRegistry.markOrderClosed(trackedOrder.orderId);
      resetOrderReplaceRuntimeState(runtime, trackedOrder.orderId);
    }

    runtime.trackedOrders.clear();
    runtime.trackedOrderLifecycles.clear();
    runtime.closedOrderIds.clear();
    runtime.latestReplaceOutcomeByOrderId.clear();
    runtime.queriedTerminalStateByOrderId.clear();
    runtime.pendingRefreshSymbols.length = 0;
  }

  function clearBootstrappingEventBuffer(): void {
    runtime.bootstrappingOrderEvents.clear();
  }

  function cacheBootstrappingEvent(event: PushOrderChanged): void {
    const current = runtime.bootstrappingOrderEvents.get(event.orderId);
    if (!current) {
      runtime.bootstrappingOrderEvents.set(event.orderId, event);
      return;
    }

    const currentUpdatedAt = resolveUpdatedAtMs(current.updatedAt);
    const nextUpdatedAt = resolveUpdatedAtMs(event.updatedAt);
    if (currentUpdatedAt !== null && nextUpdatedAt !== null && nextUpdatedAt >= currentUpdatedAt) {
      runtime.bootstrappingOrderEvents.set(event.orderId, event);
      return;
    }

    if (currentUpdatedAt === null && nextUpdatedAt !== null) {
      runtime.bootstrappingOrderEvents.set(event.orderId, event);
      return;
    }

    if (currentUpdatedAt === null && nextUpdatedAt === null) {
      runtime.bootstrappingOrderEvents.set(event.orderId, event);
    }
  }

  function replayBootstrappingEvents(): ReadonlySet<string> {
    if (runtime.bootstrappingOrderEvents.size === 0) {
      return new Set<string>();
    }

    const replayEvents = [...runtime.bootstrappingOrderEvents.values()];
    replayEvents.sort((left, right) => {
      const leftMs = resolveUpdatedAtMs(left.updatedAt) ?? 0;
      const rightMs = resolveUpdatedAtMs(right.updatedAt) ?? 0;
      return leftMs - rightMs;
    });
    runtime.bootstrappingOrderEvents.clear();
    const replayedOrderIds = new Set<string>();
    for (const event of replayEvents) {
      replayedOrderIds.add(event.orderId);
      handleOrderChangedWhenActive(event);
    }

    return replayedOrderIds;
  }

  function assertRecoverySnapshotReconciliation(
    params: RecoverySnapshotReconciliationParams,
  ): void {
    const { allOrders, closedMismatchedBuyOrderIds, replayedOrderIds } = params;
    const trackedOrderIds = new Set<string>();
    const nonPendingTrackedOrderIds: string[] = [];
    for (const trackedOrder of runtime.trackedOrders.values()) {
      trackedOrderIds.add(trackedOrder.orderId);
      if (!PENDING_ORDER_STATUSES.has(trackedOrder.status)) {
        nonPendingTrackedOrderIds.push(trackedOrder.orderId);
      }
    }

    if (nonPendingTrackedOrderIds.length > 0) {
      throw new Error(
        `[订单监控] 恢复对账失败: trackedNonPending=[${nonPendingTrackedOrderIds.join(', ')}]`,
      );
    }

    const snapshotPendingOrderIds = new Set<string>();
    for (const order of allOrders) {
      if (PENDING_ORDER_STATUSES.has(order.status)) {
        snapshotPendingOrderIds.add(order.orderId);
      }
    }

    const unexpectedTrackedOrderIds = [...trackedOrderIds].filter((orderId) => {
      if (snapshotPendingOrderIds.has(orderId)) {
        return false;
      }

      return !replayedOrderIds.has(orderId);
    });
    const missingTrackedOrderIds = [...snapshotPendingOrderIds].filter((orderId) => {
      if (trackedOrderIds.has(orderId)) {
        return false;
      }

      if (closedMismatchedBuyOrderIds.has(orderId)) {
        return false;
      }

      return !replayedOrderIds.has(orderId);
    });

    if (unexpectedTrackedOrderIds.length === 0 && missingTrackedOrderIds.length === 0) {
      return;
    }

    const unexpectedText = unexpectedTrackedOrderIds.join(', ') || 'none';
    const missingText = missingTrackedOrderIds.join(', ') || 'none';
    throw new Error(
      `[订单监控] 恢复对账失败: unexpectedTracked=[${unexpectedText}] missingTracked=[${missingText}]`,
    );
  }

  function restorePendingOrderTracking(
    order: RawOrderFromAPI,
    ownership: OrderSeatOwnership,
  ): void {
    const submittedQuantity = decimalToNumber(order.quantity);
    if (!isValidPositiveNumber(submittedQuantity)) {
      throw new Error(`[订单监控] 订单 ${order.orderId} 委托数量无效，无法恢复追踪`);
    }

    const trackedPrice = resolveRecoveredTrackedPrice(order);
    const submittedAtMs = resolveSubmittedAtMs(order.submittedAt);
    const executedQuantity = decimalToNumber(order.executedQuantity);
    const isProtectiveLiquidation = hasProtectiveLiquidationRemark(order.remark);
    const trackOrderParams: TrackOrderParams = {
      orderId: order.orderId,
      symbol: order.symbol,
      side: order.side,
      price: trackedPrice,
      initialSubmittedPrice: trackedPrice,
      quantity: submittedQuantity,
      ...(submittedAtMs === null ? {} : { submittedAtMs }),
      initialStatus: order.status,
      isLongSymbol: ownership.isLongSymbol,
      baseInstrumentSymbol: ownership.baseInstrumentSymbol,
      isProtectiveLiquidation,
      orderType: order.orderType,
    };
    trackOrder(trackOrderParams);
    const trackedOrder = runtime.trackedOrders.get(order.orderId);
    if (trackedOrder && executedQuantity > 0) {
      trackedOrder.executedQuantity = executedQuantity;
      trackedOrder.executedPrice = decimalToNumber(order.executedPrice);
      trackedOrder.lastExecutedTimeMs = resolveUpdatedAtMs(order.updatedAt);
      logger.debug(`[订单监控] 恢复部分成交订单 ${order.orderId}，已成交数量=${executedQuantity}`);
    }
  }

  async function recoverOrderTrackingFromSnapshot(
    allOrders: ReadonlyArray<RawOrderFromAPI>,
  ): Promise<void> {
    runtime.runtimeState = 'BOOTSTRAPPING';
    resetRecoveryTrackingState();
    let recoveredCount = 0;
    const closedMismatchedBuyOrderIds = new Set<string>();
    try {
      for (const order of allOrders) {
        if (!PENDING_ORDER_STATUSES.has(order.status)) {
          continue;
        }

        const ownership = resolveOrderSeatOwnership(order);
        const isMatched = ownership ? isSeatMatchedForOrder(order, ownership) : false;
        if (order.side === OrderSide.Sell) {
          if (!ownership) {
            throw new Error(`[订单监控] 卖单 ${order.orderId} 无法解析归属，阻断恢复`);
          }

          if (!isMatched) {
            throw new Error(`[订单监控] 卖单 ${order.orderId} 与当前席位不匹配，阻断恢复`);
          }

          restorePendingOrderTracking(order, ownership);
          recoveredCount += 1;
          continue;
        }

        if (order.side === OrderSide.Buy) {
          if (!ownership || !isMatched) {
            const cancelOutcome = await cancelOrder(order.orderId);
            if (cancelOutcome.kind === 'CANCEL_CONFIRMED') {
              throw new Error(
                `[订单监控] 买单 ${order.orderId} 不匹配且撤单请求成功，但终态未确认（等待 WS），阻断恢复`,
              );
            }

            if (
              cancelOutcome.kind === 'RETRYABLE_FAILURE' ||
              cancelOutcome.kind === 'UNKNOWN_FAILURE'
            ) {
              throw new Error(`[订单监控] 买单 ${order.orderId} 不匹配且撤单失败，阻断恢复`);
            }

            const queriedTerminalState = consumeQueriedTerminalState(runtime, order.orderId);
            if (queriedTerminalState === null) {
              throw new Error(`[订单监控] 买单 ${order.orderId} 缺少权威终态查询结果，阻断恢复`);
            }

            const settlementPayload = {
              orderId: order.orderId,
              closedReason: queriedTerminalState.closedReason,
              source: 'RECOVERY',
              executedPrice: queriedTerminalState.executedPrice,
              executedQuantity: queriedTerminalState.executedQuantity,
              executedTimeMs: queriedTerminalState.executedTimeMs,
              symbol: order.symbol,
              side: 'BUY',
              baseInstrumentSymbol: ownership?.baseInstrumentSymbol ?? null,
              isProtectiveLiquidation: hasProtectiveLiquidationRemark(order.remark),
              ...(ownership?.isLongSymbol === undefined
                ? {}
                : { isLongSymbol: ownership.isLongSymbol }),
            } as const;
            const settlementResult = settleOrder(settlementPayload);
            if (!settlementResult.handled) {
              throw new Error(`[订单监控] 买单 ${order.orderId} 终态已确认但结算失败，阻断恢复`);
            }

            closedMismatchedBuyOrderIds.add(order.orderId);
            continue;
          }

          restorePendingOrderTracking(order, ownership);
          recoveredCount += 1;
        }
      }

      const replayedOrderIds = replayBootstrappingEvents();
      assertRecoverySnapshotReconciliation({
        allOrders,
        closedMismatchedBuyOrderIds,
        replayedOrderIds,
      });
      runtime.runtimeState = 'ACTIVE';
      const closedMismatchedBuyCount = closedMismatchedBuyOrderIds.size;
      if (recoveredCount > 0 || closedMismatchedBuyCount > 0) {
        logger.info(
          `[订单监控] 快照恢复完成：恢复追踪=${recoveredCount}，关闭不匹配买单=${closedMismatchedBuyCount}`,
        );
      }
    } catch (error) {
      resetRecoveryTrackingState();
      throw error;
    }
  }

  return {
    cacheBootstrappingEvent,
    clearBootstrappingEventBuffer,
    resetRecoveryTrackingState,
    replayBootstrappingEvents,
    recoverOrderTrackingFromSnapshot,
  };
}
