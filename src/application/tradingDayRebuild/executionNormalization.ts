/**
 * API 原始订单到完整经济事实的唯一归一。
 * 时间/revision/phase 只由共享 executionFact 裁决；本模块不另造 merge、不补造价格或执行事实。
 */
import { mergeExecutionFact } from '../../domain/order/executionFact.js';
import type { KnownExecutionBaseline } from '../../domain/order/types.js';
import type { OrderFact } from '../../types/trade.js';
import { exactCompare } from '../../utils/numeric/exact.js';
import type { NormalizedExecutionOrder, StaleObservationPolicy } from './types.js';

function keepKnownExecution(
  known: KnownExecutionBaseline,
  order: OrderFact,
): NormalizedExecutionOrder {
  if (known.phase === null)
    throw new Error(`[执行归一] stale 观察缺少 known phase，不能补造: ${order.orderId}`);

  return Object.freeze({
    ...order,
    executedQuantity: known.cumulativeQuantity,
    executedAmount: known.cumulativeAmount,
    executionTimeMs: known.executionTimeMs,
    updatedAtMs: known.updatedAtMs,
    updatedAt: new Date(known.updatedAtMs),
    executionPhase: known.phase,
  });
}

/**
 * 将 API 观察归一为可进入 DailyLoss/订单重建的完整经济事实。
 *
 * - 零成交：金额规范为 0、T 必须未知；
 * - 正成交：本次原始金额必须完整，不借 durable/known 金额、不补均价、不写 0；
 * - 同量/增量/合法 revision 全部交给 mergeExecutionFact；
 * - stale 非增量观察：启动恢复阻断，运行期重建保留 known 当前事实。
 */
export function normalizeExecutionOrder(
  order: OrderFact,
  known: KnownExecutionBaseline | undefined,
  staleObservation: StaleObservationPolicy,
): NormalizedExecutionOrder {
  const zeroQuantity = order.executedQuantity === 0;
  if (
    zeroQuantity &&
    ((order.executedAmount !== null && exactCompare(order.executedAmount, '0') !== 0) ||
      order.executionTimeMs !== null)
  )
    throw new Error(`[执行归一] 零成交订单声明金额或执行时间: ${order.orderId}`);

  const observedAmount = zeroQuantity ? '0' : order.executedAmount;
  if (observedAmount === null)
    throw new Error(`[执行归一] 正成交缺少本次原始金额: ${order.orderId}`);

  // 零观察也必须经过共享裁决：known 正量/高 revision 不能被零观察回退或清空。
  const merged = mergeExecutionFact(known, {
    brokerOrderId: order.orderId,
    symbol: order.symbol,
    side: order.executionSide,
    cumulativeQuantity: order.executedQuantity,
    cumulativeAmount: observedAmount,
    executionTimeMs: zeroQuantity ? null : order.updatedAtMs,
    updatedAtMs: order.updatedAtMs,
    phase: order.executionPhase,
  });
  if (merged !== null)
    return Object.freeze({
      ...order,
      executedAmount: merged.cumulativeAmount,
      executionTimeMs: merged.executionTimeMs,
      executionPhase: merged.phase,
    });

  if (staleObservation === 'THROW' || known === undefined)
    throw new Error(`[执行归一] API 观察早于 durable known，不能消费: ${order.orderId}`);

  return keepKnownExecution(known, order);
}
