/** 订单超时纯规则：可信终态后的剩余量与动作选择、稳定优先级及原撤单退避间隔。 */

import {
  ORDER_MONITOR_CANCEL_RETRY_BASE_DELAY_MS,
  ORDER_MONITOR_CANCEL_RETRY_MAX_DELAY_MS,
} from '../../constants/index.js';
import { isTerminalOrderReadStatus } from './orderReadLifecycle.js';
import type {
  OrderMonitorTrackedOrder,
  SellTimeoutResolution,
  TerminalClosedReason,
  TerminalSettlementInput,
  TimeoutMarketConversionTerminalState,
  TrackedOrder,
} from './types.js';

export function resolveCancelRetryDelayMs(retryCount: number): number {
  const delay = ORDER_MONITOR_CANCEL_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, retryCount - 1);
  return Math.min(delay, ORDER_MONITOR_CANCEL_RETRY_MAX_DELAY_MS);
}

export function isSupportedTerminalCloseReason(
  closedReason: string,
): closedReason is TerminalClosedReason {
  switch (closedReason) {
    case 'FILLED':
    case 'CANCELED':
    case 'REJECTED': {
      return true;
    }

    default: {
      return false;
    }
  }
}

function resolveRemainingQuantityForConversion(
  order: TrackedOrder,
  queriedExecutedQuantity: number | null,
): number | null {
  if (queriedExecutedQuantity === null || !Number.isFinite(queriedExecutedQuantity)) {
    return null;
  }

  const remaining = order.submittedQuantity - queriedExecutedQuantity;
  if (!Number.isFinite(remaining)) {
    return null;
  }

  return remaining;
}

export function canHandleClosedTimeoutRoute(order: OrderMonitorTrackedOrder): boolean {
  return (
    order.side === 'SELL' &&
    order.timeoutMarketConversionPending &&
    order.timeoutMarketConversionTerminalState !== null
  );
}

export function canAttemptTimeoutHandling(order: OrderMonitorTrackedOrder, now: number): boolean {
  if (isTerminalOrderReadStatus(order.status) && !canHandleClosedTimeoutRoute(order)) {
    return false;
  }

  if (canHandleClosedTimeoutRoute(order)) {
    return true;
  }

  if (order.nextCancelAttemptAt > now) {
    return false;
  }

  const remainingQuantity = order.submittedQuantity - order.executedQuantity;
  return remainingQuantity > 0;
}

export function resolvePendingTimeoutSettlementInput(
  orderId: string,
  terminalState: TimeoutMarketConversionTerminalState,
): TerminalSettlementInput | null {
  if (!isSupportedTerminalCloseReason(terminalState.closedReason)) {
    return null;
  }

  return {
    params: {
      orderId,
      closedReason: terminalState.closedReason,
      source: terminalState.source,
      executedPrice: terminalState.executedPrice,
      executedAmount: terminalState.executedAmount,
      executedQuantity: terminalState.executedQuantity,
      executedTimeMs: terminalState.executedTimeMs,
      orderUpdatedAtMs: terminalState.orderUpdatedAtMs,
      ...(terminalState.preparedProtectiveTerminalExecution === undefined
        ? {}
        : {
            preparedProtectiveTerminalExecution: terminalState.preparedProtectiveTerminalExecution,
          }),
    },
    queriedExecutedQuantity: terminalState.executedQuantity,
  };
}

export function resolveSellTimeoutResolution(
  order: OrderMonitorTrackedOrder,
  settlementInput: TerminalSettlementInput,
): SellTimeoutResolution {
  if (settlementInput.params.closedReason === 'FILLED') {
    return {
      kind: 'SETTLE_FILLED',
      settlementInput,
    };
  }

  const marketConversionQuantity = resolveRemainingQuantityForConversion(
    order,
    settlementInput.queriedExecutedQuantity,
  );
  if (marketConversionQuantity === null) {
    return {
      kind: 'WAIT_RETRY',
    };
  }

  if (marketConversionQuantity <= 0) {
    return {
      kind: 'SETTLE_NO_REMAINDER',
      settlementInput,
    };
  }

  return {
    kind: 'SETTLE_AND_CONVERT',
    settlementInput,
    marketConversionQuantity,
  };
}

export function compareTrackedOrderPriority(
  left: OrderMonitorTrackedOrder,
  right: OrderMonitorTrackedOrder,
): number {
  if (left.submittedAt !== right.submittedAt) {
    return left.submittedAt - right.submittedAt;
  }

  return left.orderId.localeCompare(right.orderId);
}
