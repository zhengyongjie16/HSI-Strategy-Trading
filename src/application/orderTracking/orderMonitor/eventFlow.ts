/**
 * orderMonitor 事件流模块
 *
 * 职责：
 * - 处理 STOPPED / BOOTSTRAPPING / ACTIVE 三阶段订单推送
 * - 将已确认终态订单统一交给 settlementFlow 结算
 * - 在部分成交时维护 pendingSell 部分成交状态
 */

import { ORDER_MONITOR_WAIT_WS_ONLY_BLOCK_UNTIL_MS } from '../../../constants/index.js';
import { recordOrderTerminalConfirmation } from './orderObservation.js';
import { mergeExecutionFact } from '../../../domain/order/executionFact.js';
import {
  assertExecutionQuantityWithinSubmittedQuantity,
  assertOrderObservedFactsReady,
  assertProtectiveSellRawObservationFactsReady,
  isWeakOpenOrderObservation,
  mergeMonotonicOrderFact,
} from '../../../domain/order/orderFactMerge.js';
import { resolveOrderOwnership } from '../../../domain/order/orderOwnership.js';
import { isTerminalOrderReadStatus } from '../../../domain/order/orderReadLifecycle.js';
import { hasProtectiveLiquidationRemark } from '../../../domain/order/orderRemark.js';
import { resolveOrderClosedReasonFromStatus } from '../../../domain/order/orderTrackingPolicy.js';
import type { OrderReadStatus } from '../../../types/orderReadMetadata.js';
import type { DailyLossCumulativeExecutionResult } from '../../../types/risk.js';
import type { OrderFact } from '../../../types/trade.js';
import { exactCompare } from '../../../utils/numeric/exact.js';
import {
  acknowledgeLatestReplaceTerminal,
  acknowledgeQueriedTerminalState,
  peekLatestReplaceTerminal,
  peekQueriedTerminalState,
  resumeOrderReplaceFromWsProgress,
} from './orderOps.js';
import type { EventFlow, EventFlowDeps, OrderCumulativeExecutionParams } from './types.js';

/** 仅当状态已离开撤单中阶段时，才恢复下一次撤单重试机会。 */
function shouldResumeCancelRetryFromWsStatus(status: OrderReadStatus): boolean {
  return status !== 'CANCELLATION_REQUESTED' && status !== 'CANCELLATION_PENDING';
}

/**
 * WS 终态完成本地结算后，只确认与该次 broker revision 对应的 terminal evidence。
 *
 * 若期间已有更新的 raw terminal observation，则保留给后续终态网关，不能由旧 WS 事件覆盖。
 */
function acknowledgeTerminalEvidenceAfterWsSettlement(
  runtime: EventFlowDeps['runtime'],
  orderId: string,
  status: OrderReadStatus,
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

/**
 * 创建事件流处理器。
 *
 * @param deps 事件流依赖
 * @returns 事件流接口
 */
export function createEventFlow(deps: EventFlowDeps): EventFlow {
  const { logger } = deps;
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
  function handleOrderChangedWhenActive(event: OrderFact): void {
    const orderId = event.orderId;
    const trackedOrder = runtime.trackedOrders.get(orderId);
    if (!trackedOrder) {
      const existing = orderRecorder.getExecutionFact(orderId);
      if (existing !== null) {
        // tracking 已关闭不关闭累计事实准入：合法新 revision/金额修订仍交给同一 owner 保存，
        // 但绝不重新结算资源、发布终态事件或重复记账。
        const ownership = resolveOrderOwnership(event, deps.monitorConfig);
        if (ownership?.monitorSymbol !== deps.monitorConfig.monitorSymbol)
          throw new Error('[订单监控] 已有 broker 事实的新观察缺少唯一归属');

        assertExecutionQuantityWithinSubmittedQuantity(
          orderId,
          event.quantity,
          event.executedQuantity,
        );

        const observedFact = {
          status: event.status,
          executionPhase: event.executionPhase,
          executedQuantity: event.executedQuantity,
          executedAmount: event.executedAmount,
          executedPrice: event.executedPrice,
          executedTimeMs:
            event.executedQuantity === 0 ? null : (event.executionTimeMs ?? event.updatedAtMs),
          updatedAtMs: event.updatedAtMs,
        };

        // 先验证本次原始事实及归属，再允许过滤 closed 同 revision 的完整 OPEN 重放。
        assertOrderObservedFactsReady({ ...observedFact, executedTimeMs: event.executionTimeMs });
        if (
          existing.brokerOrderId !== orderId ||
          existing.symbol !== event.symbol ||
          existing.side !== event.executionSide
        )
          throw new Error('[订单事实] 同 broker identity 的归属冲突');

        if (
          existing.phase === 'TERMINAL' &&
          event.executionPhase === 'OPEN' &&
          event.updatedAtMs === existing.updatedAtMs &&
          event.executedQuantity === existing.cumulativeQuantity &&
          exactCompare(event.executedAmount ?? '0', existing.cumulativeAmount) === 0
        )
          return;

        // develop 限定弱观察过滤：仅 OPEN->OPEN、同 revision、量降、金额不增、时间不推进。
        if (
          isWeakOpenOrderObservation(
            {
              executionPhase: existing.phase,
              executedQuantity: existing.cumulativeQuantity,
              executedAmount: existing.cumulativeAmount,
              lastExecutedTimeMs: existing.executionTimeMs,
              lastOrderUpdateAtMs: existing.updatedAtMs,
            },
            observedFact,
          )
        )
          return;

        // 与 tracked 路径共用唯一累计裁决：同量保留 known T，合法金额修订/水位推进，
        // 重复观察幂等吸收；绝不进入结算/资源终态。
        const merged = mergeExecutionFact(
          {
            brokerOrderId: existing.brokerOrderId,
            symbol: existing.symbol,
            side: existing.side,
            cumulativeQuantity: existing.cumulativeQuantity,
            cumulativeAmount: existing.cumulativeAmount,
            executionTimeMs: existing.executionTimeMs,
            updatedAtMs: existing.updatedAtMs,
            phase: existing.phase,
          },
          {
            brokerOrderId: orderId,
            symbol: event.symbol,
            side: event.executionSide,
            cumulativeQuantity: event.executedQuantity,
            cumulativeAmount: event.executedAmount ?? '0',
            executionTimeMs: observedFact.executedTimeMs,
            updatedAtMs: event.updatedAtMs,
            phase: event.executionPhase,
          },
        );
        // 更旧 revision 的更低累计量是纯乱序重复，入口直接忽略；
        // 同量金额修订尝试仍交给同一 owner 以 DUPLICATE 收口（不推进任何事实）。
        if (merged === null && event.executedQuantity < existing.cumulativeQuantity) return;

        const effective = merged ?? {
          cumulativeQuantity: observedFact.executedQuantity,
          cumulativeAmount: observedFact.executedAmount ?? '0',
          executionTimeMs: observedFact.executedTimeMs,
          updatedAtMs: event.updatedAtMs,
          phase: observedFact.executionPhase,
        };

        const closedReason =
          merged === null ? null : resolveOrderClosedReasonFromStatus(event.status);
        if (closedReason !== null) {
          recordOrderTerminalConfirmation(deps, {
            orderId,
            symbol: event.symbol,
            side: event.executionSide,
            closedReason,
            source: 'WS',
            orderUpdatedAtMs: effective.updatedAtMs,
          });
        }

        recordCumulativeExecution({
          orderId,
          symbol: event.symbol,
          side: event.executionSide,
          monitorSymbol: ownership.monitorSymbol,
          isLongSymbol: ownership.direction === 'LONG',
          isProtectiveLiquidation: hasProtectiveLiquidationRemark(event.remark),
          factStage: effective.phase,
          executedPrice: event.executedPrice,
          executedQuantity: effective.cumulativeQuantity,
          executedAmount: effective.cumulativeAmount,
          executedTimeMs: effective.executionTimeMs,
          orderUpdatedAtMs: effective.updatedAtMs,
        });
        return;
      }

      if (isTerminalOrderReadStatus(event.status)) {
        logger.warn(`[订单监控] 收到未追踪订单 ${orderId} 的终态事件 ${event.status}，已忽略`);
      }

      return;
    }

    const observedFact = {
      status: event.status,
      executionPhase: event.executionPhase,
      executionStatus: event.executionStatus,
      executedQuantity: event.executedQuantity,
      executedAmount: event.executedAmount,
      executedPrice: event.executedPrice,
      executedTimeMs: event.executionTimeMs,
      updatedAtMs: event.updatedAtMs,
    };
    assertProtectiveSellRawObservationFactsReady(trackedOrder, observedFact);
    const mergedFact = mergeMonotonicOrderFact(trackedOrder, observedFact);
    if (mergedFact === null) {
      return;
    }

    const closedReason = resolveOrderClosedReasonFromStatus(mergedFact.status);
    if (closedReason !== null) {
      recordOrderTerminalConfirmation(deps, {
        orderId,
        closedReason,
        source: 'WS',
        orderUpdatedAtMs: mergedFact.updatedAtMs,
      });
    }

    const requiresDurableProtectiveSettlementBeforeTrackedFact =
      closedReason !== null &&
      trackedOrder.side === 'SELL' &&
      trackedOrder.isProtectiveLiquidation &&
      mergedFact.executedQuantity > 0 &&
      !trackedOrder.timeoutMarketConversionPending;
    if (requiresDurableProtectiveSettlementBeforeTrackedFact) {
      const result = settleOrder({
        orderId,
        closedReason,
        source: 'WS',
        executedPrice: mergedFact.executedPrice,
        executedAmount: mergedFact.executedAmount,
        executedQuantity: mergedFact.executedQuantity,
        executedTimeMs: mergedFact.executedTimeMs,
        orderUpdatedAtMs: mergedFact.updatedAtMs,
      });
      if (!result.handled) {
        logger.warn(
          `[订单监控] 保护性订单 ${orderId} 终态=${mergedFact.status} 已到达，但结算未执行`,
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
      trackedOrder.side === 'SELL' &&
      trackedOrder.isProtectiveLiquidation &&
      trackedOrder.timeoutMarketConversionPending &&
      mergedFact.executedQuantity > 0
    ) {
      const preparedExecution = prepareProtectiveTerminalExecution({
        orderId,
        closedReason,
        source: 'WS',
        executedPrice: mergedFact.executedPrice,
        executedAmount: mergedFact.executedAmount,
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
            factStage: mergedFact.executionPhase,
            orderId,
            side: trackedOrder.side === 'BUY' ? 'BUY' : 'SELL',
            monitorSymbol: trackedOrder.monitorSymbol,
            symbol: trackedOrder.symbol,
            isLongSymbol: trackedOrder.isLongSymbol,
            isProtectiveLiquidation: trackedOrder.isProtectiveLiquidation,
            executedPrice: mergedFact.executedPrice,
            executedAmount: mergedFact.executedAmount,
            executedQuantity: mergedFact.executedQuantity,
            executedTimeMs: mergedFact.executedTimeMs,
            orderUpdatedAtMs: mergedFact.updatedAtMs,
          }
        : null;
    const isProtectiveSell = trackedOrder.isProtectiveLiquidation && trackedOrder.side === 'SELL';
    if (openCumulativeExecutionParams !== null && isProtectiveSell) {
      recordCumulativeExecution(openCumulativeExecutionParams);
    }

    const previousStatus = trackedOrder.status;
    const previousExecutedQuantity = trackedOrder.executedQuantity;
    trackedOrder.status = mergedFact.status;
    trackedOrder.executionPhase = mergedFact.executionPhase;
    trackedOrder.executedQuantity = mergedFact.executedQuantity;
    trackedOrder.executedPrice = mergedFact.executedPrice;
    trackedOrder.executedAmount = mergedFact.executedAmount;
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
      trackedOrder.side === 'SELL' &&
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

    if (trackedOrder.side === 'SELL' && trackedOrder.timeoutMarketConversionPending) {
      trackedOrder.timeoutMarketConversionTerminalState = {
        closedReason,
        source: 'WS',
        executedPrice: mergedFact.executedPrice,
        executedAmount: mergedFact.executedAmount,
        executedQuantity: mergedFact.executedQuantity,
        executedTimeMs: trackedOrder.lastExecutedTimeMs,
        orderUpdatedAtMs: mergedFact.updatedAtMs,
        ...(preparedProtectiveTerminalExecution === undefined
          ? {}
          : { preparedProtectiveTerminalExecution }),
      };

      triggerRoute(trackedOrder.symbol, 'ORDER_EVENT');
      logger.info(
        `[订单监控] 卖出订单 ${orderId} 超时撤单后收到终态=${mergedFact.status}，已写入终态快照并显式唤醒 route`,
      );
      return;
    }

    const result = settleOrder({
      orderId,
      closedReason,
      source: 'WS',
      executedPrice: mergedFact.executedPrice,
      executedAmount: mergedFact.executedAmount,
      executedQuantity: mergedFact.executedQuantity,
      executedTimeMs: trackedOrder.lastExecutedTimeMs,
      orderUpdatedAtMs: mergedFact.updatedAtMs,
    });
    if (!result.handled) {
      logger.warn(`[订单监控] 订单 ${orderId} 终态=${mergedFact.status} 已到达，但结算未执行`);
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
  function handleOrderChanged(event: OrderFact): void {
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
