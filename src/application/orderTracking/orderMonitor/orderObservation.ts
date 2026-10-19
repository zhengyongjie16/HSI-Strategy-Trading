/**
 * 订单事实边界观测。
 * 首个 cancel ACK 与首个权威 terminal 确认内聚在既有 tracking lifecycle 中；
 * 确认先于资源结算，诊断异常不影响订单推进、原 fatal 或业务幂等。
 */
import { DIAGNOSTIC_OPERATIONS } from '../../../constants/diagnostics.js';
import type {
  OrderObservationDeps,
  OrderTerminalConfirmationParams,
  TrackedOrderLifecycle,
} from './types.js';

/** 读取本地观测时钟；无效值只缺省诊断时间，不补造 broker 时间或零延迟。 */
function observationTimeMs(now: () => Date): number | null {
  try {
    const timeMs = now().getTime();
    return Number.isSafeInteger(timeMs) && timeMs >= 0 ? timeMs : null;
  } catch {
    return null;
  }
}

/** 复用现有 lifecycle entry；未跟踪的恢复撤单也不需要第二份订单登记表。 */
function resolveLifecycle(deps: OrderObservationDeps, orderId: string): TrackedOrderLifecycle {
  const existing = deps.runtime.trackedOrderLifecycles.get(orderId);
  if (existing !== undefined) return existing;

  if (deps.runtime.closedOrderIds.has(orderId)) return { state: 'CLOSED' };

  return { state: deps.runtime.trackedOrders.has(orderId) ? 'OPEN' : null };
}

/** 只保留首个真实 broker cancel ACK；晚于 terminal 的 ACK 不回填已经完成的配对。 */
export function recordCancelAcknowledgement(deps: OrderObservationDeps, orderId: string): void {
  const lifecycle = resolveLifecycle(deps, orderId);
  if (lifecycle.firstCancelAcknowledgedAtMs !== undefined) return;

  deps.runtime.trackedOrderLifecycles.set(orderId, {
    ...lifecycle,
    firstCancelAcknowledgedAtMs: observationTimeMs(deps.now),
  });
}

/**
 * 权威事实通过原有准入后立即确认一次，不等待 durable、recorder 或资源释放。
 * 先占据 lifecycle 确认位，保证重复终态、重试与诊断重入均不重复计数。
 */
export function recordOrderTerminalConfirmation(
  deps: OrderObservationDeps,
  params: OrderTerminalConfirmationParams,
): void {
  const lifecycle = resolveLifecycle(deps, params.orderId);
  if (lifecycle.terminalConfirmed !== undefined) return;

  const confirmedAtMs = observationTimeMs(deps.now);
  deps.runtime.trackedOrderLifecycles.set(params.orderId, {
    ...lifecycle,
    terminalConfirmed: true,
  });
  const tracked = deps.runtime.trackedOrders.get(params.orderId);
  const fields = {
    orderId: params.orderId,
    symbol: tracked?.symbol ?? params.symbol ?? null,
    side: tracked?.executionSide ?? params.side ?? null,
    source: params.source,
    closedReason: params.closedReason,
    terminalConfirmedAtMs: confirmedAtMs,
    orderUpdatedAtMs: params.orderUpdatedAtMs,
    count: 1,
  } as const;
  try {
    deps.diagnostics.record(DIAGNOSTIC_OPERATIONS.ORDER_TERMINAL_CONFIRMED, fields);
  } catch {
    // 旁路 observer 即使违反不抛错契约，也不能阻止结算或覆盖原 fatal。
  }

  const acknowledgedAtMs = lifecycle.firstCancelAcknowledgedAtMs;
  // 不用终态的 broker revision 与本地 ACK 混算；相等/倒退时钟不生成假 0 或负 duration。
  if (
    acknowledgedAtMs === undefined ||
    acknowledgedAtMs === null ||
    confirmedAtMs === null ||
    confirmedAtMs <= acknowledgedAtMs
  )
    return;

  const durationMs = confirmedAtMs - acknowledgedAtMs;
  if (!Number.isSafeInteger(durationMs)) return;

  try {
    deps.diagnostics.record(DIAGNOSTIC_OPERATIONS.CANCEL_ACKNOWLEDGEMENT_TO_TERMINAL, {
      ...fields,
      cancelAcknowledgedAtMs: acknowledgedAtMs,
      durationMs,
    });
  } catch {
    // 不重试诊断，也不改变已确认元数据。
  }
}
