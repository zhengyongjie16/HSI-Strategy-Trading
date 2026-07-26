/**
 * orderMonitor 事件流模块
 *
 * 职责：
 * - 处理 STOPPED / BOOTSTRAPPING / ACTIVE 三阶段订单推送
 * - 将已确认终态订单统一交给 settlementFlow 结算
 * - 在部分成交时维护 pendingSell 部分成交状态
 */
import { OrderSide, OrderStatus, type PushOrderChanged } from 'longbridge';
import { logger } from '../../../utils/logger/index.js';
import { decimalToNumber } from '../../../utils/helpers/index.js';
import { ORDER_MONITOR_WAIT_WS_ONLY_BLOCK_UNTIL_MS } from '../../../constants/index.js';
import type { EventFlow, EventFlowDeps, OrderCumulativeExecutionParams } from './types.js';
import {
  acknowledgeLatestReplaceTerminal,
  acknowledgeQueriedTerminalState,
  peekLatestReplaceTerminal,
  peekQueriedTerminalState,
  resumeOrderReplaceFromWsProgress,
} from './orderOps.js';
import { isClosedStatus, resolveOrderClosedReasonFromStatus, resolveUpdatedAtMs } from './utils.js';
import {
  assertProtectiveSellRawObservationFactsReady,
  mergeMonotonicOrderFact,
} from './orderFactMerge.js';
import { classifyOrderStatusLifecycle } from '../../orderStatusLifecycle/index.js';
import type { DailyLossCumulativeExecutionResult } from '../../../types/risk.js';

/** 仅当状态已离开撤单中阶段时，才恢复下一次撤单重试机会。 */
function shouldResumeCancelRetryFromWsStatus(status: OrderStatus): boolean {
  return status !== OrderStatus.WaitToCancel && status !== OrderStatus.PendingCancel;
}

/**
 * WS 终态完成本地结算后，只确认与该次 broker revision 对应的 terminal evidence。
 *
 * 若期间已有更新的 raw terminal observation，则保留给后续终态网关，不能由旧 WS 事件覆盖。
 */
function acknowledgeTerminalEvidenceAfterWsSettlement(
  runtime: EventFlowDeps['runtime'],
  orderId: string,
  status: OrderStatus,
  orderUpdatedAtMs: number | null,
): void {
  const replaceTerminal = peekLatestReplaceTerminal(runtime, orderId);
  if (
    replaceTerminal !== null &&
    replaceTerminal.status === status &&
    replaceTerminal.orderUpdatedAtMs === orderUpdatedAtMs
  ) {
    acknowledgeLatestReplaceTerminal(runtime, orderId, replaceTerminal);
    acknowledgeQueriedTerminalState(runtime, orderId, replaceTerminal);
  }

  const rawTerminalState = peekQueriedTerminalState(runtime, orderId);
  if (
    rawTerminalState !== null &&
    rawTerminalState.status === status &&
    rawTerminalState.orderUpdatedAtMs === orderUpdatedAtMs
  ) {
    acknowledgeQueriedTerminalState(runtime, orderId, rawTerminalState);
  }
}

/** 将 SDK Decimal/unknown 价格数量统一收敛为 number | null。 */
function resolveNullableDecimalNumber(value: Parameters<typeof decimalToNumber>[0]): number | null {
  const resolved = decimalToNumber(value);
  return Number.isFinite(resolved) ? resolved : null;
}

/**
 * 创建事件流处理器。
 *
 * @param deps 事件流依赖
 * @returns 事件流接口
 */
export function createEventFlow(deps: EventFlowDeps): EventFlow {
  const {
    runtime,
    orderRecorder,
    recordCumulativeExecution,
    prepareProtectiveTerminalExecution,
    settleOrder,
    cacheBootstrappingEvent,
    triggerRoute,
  } = deps;

  /**
   * 处理 ACTIVE 状态下的订单推送。
   *
   * @param event 订单变更事件
   * @returns 无返回值
   */
  function handleOrderChangedWhenActive(event: PushOrderChanged): void {
    const orderId = event.orderId;
    const trackedOrder = runtime.trackedOrders.get(orderId);
    if (!trackedOrder) {
      if (isClosedStatus(event.status)) {
        logger.warn(
          `[订单监控] 收到未追踪订单 ${orderId} 的终态事件 ${String(event.status)}，已忽略`,
        );
      }

      return;
    }

    const observedFact = {
      status: event.status,
      executedQuantity: decimalToNumber(event.executedQuantity),
      executedPrice: resolveNullableDecimalNumber(event.executedPrice),
      executedTimeMs: resolveUpdatedAtMs(event.updatedAt),
      updatedAtMs: resolveUpdatedAtMs(event.updatedAt),
    };
    assertProtectiveSellRawObservationFactsReady(trackedOrder, observedFact);
    const mergedFact = mergeMonotonicOrderFact(trackedOrder, observedFact);
    if (mergedFact === null) {
      return;
    }

    const closedReason = resolveOrderClosedReasonFromStatus(mergedFact.status);
    const requiresDurableProtectiveSettlementBeforeTrackedFact =
      closedReason !== null &&
      trackedOrder.side === OrderSide.Sell &&
      trackedOrder.isProtectiveLiquidation &&
      mergedFact.executedQuantity > 0 &&
      !trackedOrder.timeoutMarketConversionPending;
    if (requiresDurableProtectiveSettlementBeforeTrackedFact) {
      const result = settleOrder({
        orderId,
        closedReason,
        source: 'WS',
        executedPrice: mergedFact.executedPrice,
        executedQuantity: mergedFact.executedQuantity,
        executedTimeMs: mergedFact.executedTimeMs,
        orderUpdatedAtMs: mergedFact.updatedAtMs,
      });
      if (!result.handled) {
        logger.warn(
          `[订单监控] 保护性订单 ${orderId} 终态=${String(mergedFact.status)} 已到达，但结算未执行`,
        );
        return;
      }

      acknowledgeTerminalEvidenceAfterWsSettlement(
        runtime,
        orderId,
        mergedFact.status,
        mergedFact.updatedAtMs,
      );

      const remainingOrderIds = runtime.trackedOrderIdsBySymbol.get(trackedOrder.symbol);
      if (remainingOrderIds !== undefined && remainingOrderIds.size > 0) {
        triggerRoute(trackedOrder.symbol, 'ORDER_EVENT');
      }

      return;
    }

    let preparedProtectiveTerminalExecution: DailyLossCumulativeExecutionResult | undefined;
    if (
      closedReason !== null &&
      trackedOrder.side === OrderSide.Sell &&
      trackedOrder.isProtectiveLiquidation &&
      trackedOrder.timeoutMarketConversionPending &&
      mergedFact.executedQuantity > 0
    ) {
      const preparedExecution = prepareProtectiveTerminalExecution({
        orderId,
        closedReason,
        source: 'WS',
        executedPrice: mergedFact.executedPrice,
        executedQuantity: mergedFact.executedQuantity,
        executedTimeMs: mergedFact.executedTimeMs,
        orderUpdatedAtMs: mergedFact.updatedAtMs,
      });
      if (preparedExecution === null) {
        throw new Error(`[订单监控] 保护性超时终态未生成 durable progress: ${orderId}`);
      }

      preparedProtectiveTerminalExecution = preparedExecution;
    }

    const openCumulativeExecutionParams: OrderCumulativeExecutionParams | null =
      closedReason === null && mergedFact.executedQuantity > 0
        ? {
            factStage: classifyOrderStatusLifecycle(mergedFact.status),
            orderId,
            side: trackedOrder.side === OrderSide.Buy ? 'BUY' : 'SELL',
            monitorSymbol: trackedOrder.monitorSymbol,
            symbol: trackedOrder.symbol,
            isLongSymbol: trackedOrder.isLongSymbol,
            isProtectiveLiquidation: trackedOrder.isProtectiveLiquidation,
            executedPrice: mergedFact.executedPrice,
            executedQuantity: mergedFact.executedQuantity,
            executedTimeMs: mergedFact.executedTimeMs,
            orderUpdatedAtMs: mergedFact.updatedAtMs,
          }
        : null;
    const isProtectiveSell =
      trackedOrder.isProtectiveLiquidation && trackedOrder.side === OrderSide.Sell;
    if (openCumulativeExecutionParams !== null && isProtectiveSell) {
      recordCumulativeExecution(openCumulativeExecutionParams);
    }

    const previousStatus = trackedOrder.status;
    const previousExecutedQuantity = trackedOrder.executedQuantity;
    trackedOrder.status = mergedFact.status;
    trackedOrder.executedQuantity = mergedFact.executedQuantity;
    trackedOrder.executedPrice = mergedFact.executedPrice;
    trackedOrder.lastOrderUpdateAtMs = mergedFact.updatedAtMs;
    trackedOrder.lastExecutedTimeMs = mergedFact.executedTimeMs;

    if (previousStatus !== mergedFact.status) {
      if (
        trackedOrder.nextCancelAttemptAt === ORDER_MONITOR_WAIT_WS_ONLY_BLOCK_UNTIL_MS &&
        shouldResumeCancelRetryFromWsStatus(mergedFact.status)
      ) {
        trackedOrder.cancelRetryCount = 0;
        trackedOrder.nextCancelAttemptAt = deps.now().getTime();
      }

      resumeOrderReplaceFromWsProgress(trackedOrder);
    }

    if (openCumulativeExecutionParams !== null && !isProtectiveSell) {
      recordCumulativeExecution(openCumulativeExecutionParams);
    }

    if (
      closedReason === null &&
      trackedOrder.side === OrderSide.Sell &&
      mergedFact.executedQuantity > previousExecutedQuantity
    ) {
      orderRecorder.markSellPartialFilled(orderId, trackedOrder.executedQuantity);
      logger.info(
        `[订单监控] 订单 ${orderId} 累计成交推进，` +
          `已成交=${trackedOrder.executedQuantity}/${trackedOrder.submittedQuantity}，` +
          '等待完全成交后更新本地记录',
      );
    }

    if (closedReason === null) {
      triggerRoute(trackedOrder.symbol, 'ORDER_EVENT');
      return;
    }

    if (trackedOrder.side === OrderSide.Sell && trackedOrder.timeoutMarketConversionPending) {
      trackedOrder.timeoutMarketConversionTerminalState = {
        closedReason,
        source: 'WS',
        executedPrice: mergedFact.executedPrice,
        executedQuantity: mergedFact.executedQuantity,
        executedTimeMs: trackedOrder.lastExecutedTimeMs,
        orderUpdatedAtMs: mergedFact.updatedAtMs,
        ...(preparedProtectiveTerminalExecution === undefined
          ? {}
          : { preparedProtectiveTerminalExecution }),
      };

      triggerRoute(trackedOrder.symbol, 'ORDER_EVENT');
      logger.info(
        `[订单监控] 卖出订单 ${orderId} 超时撤单后收到终态=${String(mergedFact.status)}，已写入终态快照并显式唤醒 route`,
      );
      return;
    }

    const result = settleOrder({
      orderId,
      closedReason,
      source: 'WS',
      executedPrice: mergedFact.executedPrice,
      executedQuantity: mergedFact.executedQuantity,
      executedTimeMs: trackedOrder.lastExecutedTimeMs,
      orderUpdatedAtMs: mergedFact.updatedAtMs,
    });
    if (!result.handled) {
      logger.warn(
        `[订单监控] 订单 ${orderId} 终态=${String(mergedFact.status)} 已到达，但结算未执行`,
      );
      return;
    }

    acknowledgeTerminalEvidenceAfterWsSettlement(
      runtime,
      orderId,
      mergedFact.status,
      mergedFact.updatedAtMs,
    );

    const remainingOrderIds = runtime.trackedOrderIdsBySymbol.get(trackedOrder.symbol);
    if (remainingOrderIds !== undefined && remainingOrderIds.size > 0) {
      triggerRoute(trackedOrder.symbol, 'ORDER_EVENT');
    }
  }

  /**
   * 处理 WebSocket 订单状态变化（BOOTSTRAPPING/ACTIVE 分发）。
   *
   * @param event 订单推送事件
   * @returns 无返回值
   */
  function handleOrderChanged(event: PushOrderChanged): void {
    switch (runtime.runtimeState) {
      case 'STOPPED': {
        return;
      }

      case 'BOOTSTRAPPING': {
        cacheBootstrappingEvent(event);
        return;
      }

      case 'ACTIVE': {
        handleOrderChangedWhenActive(event);
        return;
      }

      default: {
        return;
      }
    }
  }

  return {
    handleOrderChangedWhenActive,
    handleOrderChanged,
  };
}
