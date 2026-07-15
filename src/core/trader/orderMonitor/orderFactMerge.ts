/**
 * orderMonitor 订单事实单调合并模块
 *
 * 职责：将 WS 与权威 state-check 的订单观察值按时间、累计成交量和状态阶段合并为单调事实。
 */
import { OrderSide, OrderStatus } from 'longbridge';
import { classifyOrderStatusLifecycle } from '../../orderStatusLifecycle/index.js';
import type { OrderStateCheckResult } from '../../../types/trader.js';
import type {
  KnownOrderFact,
  MonotonicOrderFact,
  NormalizedTerminalStateSnapshot,
  OrderMonitorTrackedOrder,
  OrderObservedFact,
  TerminalStateSnapshot,
} from './types.js';

/** 判断值是否是可用于订单累计成交事实的有限正数。 */
function isValidPositiveFactNumber(value: number | null): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * 校验累计成交量落在当前有效委托量的闭区间内。
 *
 * 改单成功后 tracked 的 submittedQuantity 会更新为“已成交量 + 新剩余量”，
 * 因此它是后续 WS、state-check 与终态结算必须共同遵守的数量上界。
 */
export function assertExecutionQuantityWithinSubmittedQuantity(
  orderId: string,
  submittedQuantity: number,
  executedQuantity: number,
): void {
  if (!Number.isFinite(executedQuantity) || executedQuantity < 0) {
    throw new Error(`[订单监控] 订单 ${orderId} 收到无效累计成交数量`);
  }

  if (executedQuantity <= submittedQuantity) {
    return;
  }

  throw new Error(
    `[订单监控] 订单 ${orderId} 累计成交量超过有效委托数量: ` +
      `submittedQuantity=${submittedQuantity} executedQuantity=${executedQuantity}`,
  );
}

/**
 * 判断本次原始观察是否会声明或收口保护性 SELL 的累计成交。
 *
 * CANCELED/REJECTED 在已有部分成交时同样必须携带完整原始累计事实，
 * 否则不能借用 tracked 值完成终态收口。
 */
function requiresProtectiveSellRawExecutionFact(
  trackedOrder: Pick<OrderMonitorTrackedOrder, 'executedQuantity'>,
  observedFact: OrderObservedFact,
): boolean {
  if (isValidPositiveFactNumber(trackedOrder.executedQuantity)) {
    return true;
  }

  if (isValidPositiveFactNumber(observedFact.executedQuantity)) {
    return true;
  }

  if (
    observedFact.status === OrderStatus.PartialFilled ||
    observedFact.status === OrderStatus.Filled
  ) {
    return true;
  }

  return false;
}

/**
 * 在通用单调合并前校验保护性 SELL 的本次原始成交观察。
 *
 * state-check 的 `orderUpdatedAtMs` 是 SDK `Last updated` 给出的经纪商观察/revision 时间；
 * 只有累计成交量增加时，才把它派生为本地执行账务时间，绝不把它解释为交易所成交时间，
 * 也不得由旧 tracked、0 或当前时钟补造。
 */
export function assertProtectiveSellRawObservationFactsReady(
  trackedOrder: Pick<
    OrderMonitorTrackedOrder,
    'orderId' | 'side' | 'isProtectiveLiquidation' | 'executedQuantity' | 'lastOrderUpdateAtMs'
  >,
  observedFact: OrderObservedFact,
): void {
  if (
    trackedOrder.side !== OrderSide.Sell ||
    !trackedOrder.isProtectiveLiquidation ||
    !requiresProtectiveSellRawExecutionFact(trackedOrder, observedFact)
  ) {
    return;
  }

  if (
    isValidPositiveFactNumber(observedFact.executedQuantity) &&
    observedFact.executedQuantity > trackedOrder.executedQuantity &&
    !isValidPositiveFactNumber(observedFact.executedPrice)
  ) {
    throw new Error(
      `[订单监控] 订单 ${trackedOrder.orderId} 保护性 SELL 累计成交数量推进但缺少有效成交价`,
    );
  }

  if (
    !isValidPositiveFactNumber(observedFact.executedQuantity) ||
    !isValidPositiveFactNumber(observedFact.executedPrice) ||
    !isValidPositiveFactNumber(observedFact.executedTimeMs) ||
    !isValidPositiveFactNumber(observedFact.updatedAtMs)
  ) {
    throw new Error(
      `[订单监控] 订单 ${trackedOrder.orderId} 保护性 SELL 存在正累计成交但执行事实不完整，` +
        '拒绝用历史事实补齐原始观察',
    );
  }

  if (observedFact.executedTimeMs > observedFact.updatedAtMs) {
    throw new Error(
      `[订单监控] 订单 ${trackedOrder.orderId} 保护性 SELL 原始执行时间晚于 order revision，阻断状态推进`,
    );
  }

  if (
    observedFact.executedQuantity > trackedOrder.executedQuantity &&
    trackedOrder.lastOrderUpdateAtMs !== null &&
    observedFact.updatedAtMs < trackedOrder.lastOrderUpdateAtMs
  ) {
    throw new Error(
      `[订单监控] 订单 ${trackedOrder.orderId} 保护性 SELL 累计成交推进但 broker revision 倒退，阻断状态推进`,
    );
  }
}

/**
 * 在 state-check TERMINAL 快照进入通用归一化前校验保护性 SELL 原始事实。
 *
 * 当前经纪商 state-check 契约只提供本次权威 `orderUpdatedAtMs`；
 * 该值是本次观察的原始时间来源，而非对缺失字段的默认回填。
 */
export function assertProtectiveSellRawTerminalStateFactsReady(
  trackedOrder: Pick<
    OrderMonitorTrackedOrder,
    'orderId' | 'side' | 'isProtectiveLiquidation' | 'executedQuantity' | 'lastOrderUpdateAtMs'
  >,
  terminalState: TerminalStateSnapshot,
): void {
  const rawExecutedQuantity = terminalState.executedQuantity;
  if (typeof rawExecutedQuantity !== 'number' || !Number.isFinite(rawExecutedQuantity)) {
    assertProtectiveSellRawObservationFactsReady(trackedOrder, {
      status: terminalState.status,
      executedQuantity: terminalState.executedQuantity,
      executedPrice: terminalState.executedPrice,
      executedTimeMs: terminalState.orderUpdatedAtMs,
      updatedAtMs: terminalState.orderUpdatedAtMs,
    });
    return;
  }

  const hasRawExecutionAdvance = rawExecutedQuantity > trackedOrder.executedQuantity;
  if (!hasRawExecutionAdvance) {
    return;
  }

  assertProtectiveSellRawObservationFactsReady(trackedOrder, {
    status: terminalState.status,
    executedQuantity: terminalState.executedQuantity,
    executedPrice: terminalState.executedPrice,
    executedTimeMs: terminalState.orderUpdatedAtMs,
    updatedAtMs: terminalState.orderUpdatedAtMs,
  });
}

/**
 * 在 state-check 结果进入任意本地状态、缓存或经济副作用前校验原始成交事实。
 *
 * SDK 仅提供 `updatedAt`（Last updated）：它是经纪商观察/revision 时间。累计成交量增加时，
 * 才可将该时间派生为本地执行账务时间；它不是交易所成交时间，也不能由 tracked 或当前时钟补造。
 */
export function assertStateCheckRawExecutionFactsReady(
  trackedOrder: OrderMonitorTrackedOrder | null | undefined,
  stateCheckResult: Exclude<OrderStateCheckResult, { kind: 'QUERY_FAILED' }>,
): void {
  const rawExecutedQuantity = stateCheckResult.executedQuantity;
  if (
    typeof rawExecutedQuantity !== 'number' ||
    !Number.isFinite(rawExecutedQuantity) ||
    rawExecutedQuantity < 0
  ) {
    throw new Error('[订单监控] state-check 收到无效累计成交数量，拒绝推进订单状态');
  }

  if (trackedOrder !== null && trackedOrder !== undefined) {
    assertExecutionQuantityWithinSubmittedQuantity(
      trackedOrder.orderId,
      trackedOrder.submittedQuantity,
      rawExecutedQuantity,
    );
  }

  const knownExecutedQuantity =
    trackedOrder === null || trackedOrder === undefined ? 0 : trackedOrder.executedQuantity;
  if (rawExecutedQuantity > knownExecutedQuantity) {
    if (!isValidPositiveFactNumber(stateCheckResult.executedPrice)) {
      throw new Error('[订单监控] state-check 累计成交数量推进但缺少有效成交价');
    }

    const rawUpdatedAtMs =
      stateCheckResult.kind === 'OPEN'
        ? stateCheckResult.updatedAtMs
        : stateCheckResult.orderUpdatedAtMs;
    if (!isValidPositiveFactNumber(rawUpdatedAtMs)) {
      throw new Error('[订单监控] state-check 累计成交数量推进但缺少有效 broker revision');
    }

    const knownUpdatedAtMs = trackedOrder?.lastOrderUpdateAtMs;
    if (
      knownUpdatedAtMs !== undefined &&
      knownUpdatedAtMs !== null &&
      rawUpdatedAtMs < knownUpdatedAtMs
    ) {
      throw new Error('[订单监控] state-check 累计成交数量推进但 broker revision 倒退');
    }
  }

  if (trackedOrder === null || trackedOrder === undefined) {
    return;
  }

  if (stateCheckResult.kind === 'OPEN') {
    assertProtectiveSellRawObservationFactsReady(trackedOrder, {
      status: stateCheckResult.status,
      executedQuantity: stateCheckResult.executedQuantity,
      executedPrice: stateCheckResult.executedPrice,
      executedTimeMs: stateCheckResult.updatedAtMs,
      updatedAtMs: stateCheckResult.updatedAtMs,
    });
    return;
  }

  assertProtectiveSellRawTerminalStateFactsReady(trackedOrder, stateCheckResult);
}

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
 * 校验累计成交增加时本次 broker observation 必须完整且不可否认既有事实。
 *
 * 新增成交会进入订单记录、待成交卖出占用与 DailyLoss；因此时间和 revision 不能由 tracked
 * 值、当前时钟或其他 observation 补造。
 */
function assertRawExecutionAdvanceFactsReady(
  trackedOrder: KnownOrderFact,
  observedFact: OrderObservedFact,
): void {
  if (!isValidPositiveFactNumber(observedFact.executedQuantity)) {
    throw new Error(
      `[订单监控] 订单 ${trackedOrder.orderId} 累计成交数量推进但原始累计成交数量无效`,
    );
  }

  if (!isValidPositiveFactNumber(observedFact.executedPrice)) {
    throw new Error(`[订单监控] 订单 ${trackedOrder.orderId} 累计成交数量推进但缺少有效成交价`);
  }

  if (
    !isValidPositiveFactNumber(observedFact.executedTimeMs) ||
    !isValidPositiveFactNumber(observedFact.updatedAtMs)
  ) {
    throw new Error(
      `[订单监控] 订单 ${trackedOrder.orderId} 累计成交数量推进但原始执行时间或 broker revision 无效`,
    );
  }

  if (
    trackedOrder.lastExecutedTimeMs !== null &&
    observedFact.executedTimeMs < trackedOrder.lastExecutedTimeMs
  ) {
    throw new Error(`[订单监控] 订单 ${trackedOrder.orderId} 累计成交数量推进但原始执行时间倒退`);
  }

  if (
    trackedOrder.lastOrderUpdateAtMs !== null &&
    observedFact.updatedAtMs < trackedOrder.lastOrderUpdateAtMs
  ) {
    throw new Error(
      `[订单监控] 订单 ${trackedOrder.orderId} 累计成交数量推进但 broker revision 倒退`,
    );
  }

  if (observedFact.executedTimeMs > observedFact.updatedAtMs) {
    throw new Error(
      `[订单监控] 订单 ${trackedOrder.orderId} 累计成交数量推进但原始执行时间晚于 broker revision`,
    );
  }
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
  const nextExecutedQuantity = observedFact.executedQuantity;
  if (
    typeof nextExecutedQuantity !== 'number' ||
    !Number.isFinite(nextExecutedQuantity) ||
    nextExecutedQuantity < 0
  ) {
    throw new Error(`[订单监控] 订单 ${trackedOrder.orderId} 收到无效累计成交数量`);
  }

  assertExecutionQuantityWithinSubmittedQuantity(
    trackedOrder.orderId,
    trackedOrder.submittedQuantity,
    nextExecutedQuantity,
  );

  const executionQuantityAdvanced = nextExecutedQuantity > trackedOrder.executedQuantity;
  if (executionQuantityAdvanced) {
    assertRawExecutionAdvanceFactsReady(trackedOrder, observedFact);
  }

  if (
    nextLifecycle === 'OPEN' &&
    currentUpdatedAtMs !== null &&
    (nextUpdatedAtMs === null || nextUpdatedAtMs < currentUpdatedAtMs)
  ) {
    return null;
  }

  const hasValidIncomingExecutionPrice =
    observedFact.executedPrice !== null &&
    Number.isFinite(observedFact.executedPrice) &&
    observedFact.executedPrice > 0;

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
  const updatedAtMs = executionQuantityAdvanced
    ? observedFact.updatedAtMs
    : resolveMonotonicTimestamp(currentUpdatedAtMs, nextUpdatedAtMs);
  const executedTimeMs = executionQuantityAdvanced
    ? observedFact.executedTimeMs
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
 * 合并已通过严格 raw 准入的保护性 SELL 事实。
 *
 * 累计成交量推进时，执行时间必须直接来自本次原始 broker observation；
 * 不允许用 tracked 时间取最大值伪造本次新增成交的边界。
 */
function mergeProtectiveSellRawObservation(
  trackedOrder: KnownOrderFact,
  observedFact: OrderObservedFact,
): MonotonicOrderFact | null {
  const mergedFact = mergeMonotonicOrderFact(trackedOrder, observedFact);
  if (mergedFact === null || observedFact.executedQuantity === null) {
    return mergedFact;
  }

  if (observedFact.executedQuantity <= trackedOrder.executedQuantity) {
    return mergedFact;
  }

  return {
    ...mergedFact,
    executedTimeMs: observedFact.executedTimeMs,
  };
}

/**
 * 将 API TERMINAL state-check 与当前已知订单事实合并为可结算终态。
 * 终态负责关闭生命周期，但成交数量、价格、成交时间和 revision 不得否认更强的已知事实。
 */
export function normalizeTerminalStateSnapshot(
  knownFact: KnownOrderFact,
  terminalState: TerminalStateSnapshot,
  isProtectiveSell: boolean = false,
): NormalizedTerminalStateSnapshot {
  const observedFact = {
    status: terminalState.status,
    executedQuantity: terminalState.executedQuantity,
    executedPrice: terminalState.executedPrice,
    executedTimeMs: terminalState.orderUpdatedAtMs,
    updatedAtMs: terminalState.orderUpdatedAtMs,
  };
  const mergedFact = isProtectiveSell
    ? mergeProtectiveSellRawObservation(knownFact, observedFact)
    : mergeMonotonicOrderFact(knownFact, observedFact);
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
