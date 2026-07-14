/**
 * orderMonitor 订单事实单调合并模块
 *
 * 职责：将 WS 与权威 state-check 的订单观察值按时间、累计成交量和状态阶段合并为单调事实。
 */
import { OrderStatus } from 'longbridge';
import { classifyOrderStatusLifecycle } from '../../orderStatusLifecycle/index.js';
import type {
  KnownOrderFact,
  MonotonicOrderFact,
  NormalizedTerminalStateSnapshot,
  OrderObservedFact,
  TerminalStateSnapshot,
} from './types.js';

/** 按订单操作语义解析同 timestamp OPEN 状态的事实阶段。 */
function resolveOpenStatusFactPhase(status: OrderStatus): number {
  if (status === OrderStatus.PendingCancel) return 6;

  if (status === OrderStatus.WaitToCancel) return 5;

  if (status === OrderStatus.PartialFilled) return 4;

  if (status === OrderStatus.New || status === OrderStatus.Replaced) return 3;

  if (status === OrderStatus.PendingReplace) return 2;

  if (status === OrderStatus.WaitToReplace) return 1;

  if (
    status === OrderStatus.WaitToNew ||
    status === OrderStatus.NotReported ||
    status === OrderStatus.ReplacedNotReported ||
    status === OrderStatus.ProtectedNotReported ||
    status === OrderStatus.VarietiesNotReported
  ) {
    return 0;
  }

  throw new Error(`[订单监控] 非 OPEN 状态不能参与 OPEN 事实阶段裁决: ${String(status)}`);
}

/** 同 timestamp 无法依赖先后顺序时，按业务事实阶段选择结果。 */
function resolveSameTimestampOpenStatus(left: OrderStatus, right: OrderStatus): OrderStatus {
  const leftPhase = resolveOpenStatusFactPhase(left);
  const rightPhase = resolveOpenStatusFactPhase(right);
  if (leftPhase !== rightPhase) {
    return leftPhase > rightPhase ? left : right;
  }

  if (left === right) {
    return left;
  }

  if (left === OrderStatus.New || right === OrderStatus.New) {
    return OrderStatus.New;
  }

  return left > right ? left : right;
}

/** 判断较新 OPEN 状态是否属于合法生命周期推进。 */
function canAdvanceOpenStatus(current: OrderStatus, next: OrderStatus): boolean {
  if (current === next) return true;

  if (
    current === OrderStatus.NotReported ||
    current === OrderStatus.ReplacedNotReported ||
    current === OrderStatus.ProtectedNotReported ||
    current === OrderStatus.VarietiesNotReported ||
    current === OrderStatus.WaitToNew
  ) {
    return true;
  }

  if (current === OrderStatus.New || current === OrderStatus.Replaced) {
    return (
      next === OrderStatus.New ||
      next === OrderStatus.WaitToReplace ||
      next === OrderStatus.PendingReplace ||
      next === OrderStatus.Replaced ||
      next === OrderStatus.PartialFilled ||
      next === OrderStatus.WaitToCancel ||
      next === OrderStatus.PendingCancel
    );
  }

  if (current === OrderStatus.WaitToReplace || current === OrderStatus.PendingReplace) {
    return (
      next === OrderStatus.New ||
      next === OrderStatus.WaitToReplace ||
      next === OrderStatus.PendingReplace ||
      next === OrderStatus.Replaced ||
      next === OrderStatus.PartialFilled ||
      next === OrderStatus.WaitToCancel ||
      next === OrderStatus.PendingCancel
    );
  }

  if (current === OrderStatus.PartialFilled) {
    return (
      next === OrderStatus.PartialFilled ||
      next === OrderStatus.WaitToReplace ||
      next === OrderStatus.PendingReplace ||
      next === OrderStatus.Replaced ||
      next === OrderStatus.WaitToCancel ||
      next === OrderStatus.PendingCancel
    );
  }

  if (current === OrderStatus.WaitToCancel) {
    return (
      next === OrderStatus.WaitToCancel ||
      next === OrderStatus.PendingCancel ||
      next === OrderStatus.New ||
      next === OrderStatus.Replaced ||
      next === OrderStatus.PartialFilled ||
      next === OrderStatus.WaitToReplace ||
      next === OrderStatus.PendingReplace
    );
  }

  if (current === OrderStatus.PendingCancel) {
    return (
      next === OrderStatus.PendingCancel ||
      next === OrderStatus.New ||
      next === OrderStatus.Replaced ||
      next === OrderStatus.PartialFilled ||
      next === OrderStatus.WaitToReplace ||
      next === OrderStatus.PendingReplace
    );
  }

  throw new Error(`[订单监控] 未识别的 OPEN 状态推进起点: ${String(current)}`);
}

/** 合并可空时间戳，保证已知时间不因其他维度的事实推进而回退。 */
function resolveMonotonicTimestamp(current: number | null, incoming: number | null): number | null {
  if (incoming === null) {
    return current;
  }

  if (current === null || incoming >= current) {
    return incoming;
  }

  return current;
}

/**
 * 将订单观察值合并为单调事实：旧 revision 拒绝、累计成交量取最大、终态不可回 OPEN。
 */
export function mergeMonotonicOrderFact(
  trackedOrder: KnownOrderFact,
  observedFact: OrderObservedFact,
): MonotonicOrderFact | null {
  const currentLifecycle = classifyOrderStatusLifecycle(trackedOrder.status);
  const nextLifecycle = classifyOrderStatusLifecycle(observedFact.status);
  if (currentLifecycle === 'TERMINAL') {
    return null;
  }

  const nextUpdatedAtMs = observedFact.updatedAtMs;
  const currentUpdatedAtMs = trackedOrder.lastOrderUpdateAtMs;
  if (
    nextLifecycle === 'OPEN' &&
    currentUpdatedAtMs !== null &&
    (nextUpdatedAtMs === null || nextUpdatedAtMs < currentUpdatedAtMs)
  ) {
    return null;
  }

  const nextExecutedQuantity = observedFact.executedQuantity;
  if (!Number.isFinite(nextExecutedQuantity) || nextExecutedQuantity < 0) {
    throw new Error(`[订单监控] 订单 ${trackedOrder.orderId} 收到无效累计成交数量`);
  }

  const executionQuantityAdvanced = nextExecutedQuantity > trackedOrder.executedQuantity;
  const hasValidIncomingExecutionPrice =
    observedFact.executedPrice !== null &&
    Number.isFinite(observedFact.executedPrice) &&
    observedFact.executedPrice > 0;
  if (executionQuantityAdvanced && !hasValidIncomingExecutionPrice) {
    throw new Error(`[订单监控] 订单 ${trackedOrder.orderId} 累计成交数量推进但缺少有效成交价`);
  }

  let mergedStatus = observedFact.status;
  if (currentUpdatedAtMs !== null && nextUpdatedAtMs === currentUpdatedAtMs) {
    const hasStrongerQuantity = nextExecutedQuantity > trackedOrder.executedQuantity;
    const hasTerminalProgress = nextLifecycle === 'TERMINAL';
    if (nextExecutedQuantity < trackedOrder.executedQuantity && !hasTerminalProgress) {
      return null;
    }

    if (!hasTerminalProgress) {
      mergedStatus = resolveSameTimestampOpenStatus(trackedOrder.status, observedFact.status);
    }

    if (!hasStrongerQuantity && !hasTerminalProgress && mergedStatus === trackedOrder.status) {
      return null;
    }
  } else if (
    nextLifecycle === 'OPEN' &&
    !canAdvanceOpenStatus(trackedOrder.status, observedFact.status)
  ) {
    if (nextExecutedQuantity <= trackedOrder.executedQuantity) {
      return null;
    }

    mergedStatus = trackedOrder.status;
  }

  const incomingPriceIsAuthoritative =
    executionQuantityAdvanced ||
    (nextExecutedQuantity === trackedOrder.executedQuantity &&
      nextExecutedQuantity > 0 &&
      hasValidIncomingExecutionPrice &&
      (currentUpdatedAtMs === null ||
        (nextUpdatedAtMs !== null && nextUpdatedAtMs >= currentUpdatedAtMs)));
  const executedQuantity = executionQuantityAdvanced
    ? nextExecutedQuantity
    : trackedOrder.executedQuantity;
  const updatedAtMs = resolveMonotonicTimestamp(currentUpdatedAtMs, nextUpdatedAtMs);
  const executedTimeMs = executionQuantityAdvanced
    ? resolveMonotonicTimestamp(trackedOrder.lastExecutedTimeMs, observedFact.executedTimeMs)
    : trackedOrder.lastExecutedTimeMs;
  return {
    status: mergedStatus,
    executedQuantity,
    executedPrice: incomingPriceIsAuthoritative
      ? observedFact.executedPrice
      : trackedOrder.executedPrice,
    executedTimeMs,
    updatedAtMs,
  };
}

/**
 * 将 API TERMINAL state-check 与当前已知订单事实合并为可结算终态。
 * 终态负责关闭生命周期，但成交数量、价格、成交时间和 revision 不得否认更强的已知事实。
 */
export function normalizeTerminalStateSnapshot(
  knownFact: KnownOrderFact,
  terminalState: TerminalStateSnapshot,
): NormalizedTerminalStateSnapshot {
  const mergedFact = mergeMonotonicOrderFact(knownFact, {
    status: terminalState.status,
    executedQuantity: terminalState.executedQuantity ?? knownFact.executedQuantity,
    executedPrice: terminalState.executedPrice,
    executedTimeMs: terminalState.orderUpdatedAtMs,
    updatedAtMs: terminalState.orderUpdatedAtMs,
  });
  if (mergedFact === null) {
    throw new Error(`[订单监控] 订单 ${knownFact.orderId} 终态事实无法与当前已知事实合并`);
  }

  return {
    ...terminalState,
    status: mergedFact.status,
    executedPrice: mergedFact.executedPrice,
    executedQuantity: mergedFact.executedQuantity,
    executedTimeMs: mergedFact.executedTimeMs,
    orderUpdatedAtMs: mergedFact.updatedAtMs,
  };
}
