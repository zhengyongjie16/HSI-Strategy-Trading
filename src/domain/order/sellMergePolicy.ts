/** 卖单合并规则：隔离旧 protective 订单身份，保留普通同类型单张挂单的合法 REPLACE。 */
import {
  NON_REPLACEABLE_READ_STATUSES,
  NON_REPLACEABLE_READ_TYPES,
} from '../../constants/orderReadMetadata.js';
import { isValidPositiveNumber } from '../../utils/helpers/index.js';
import { sumSafeQuantities } from '../../utils/numeric/exact.js';
import type { SellMergeDecision, SellMergeDecisionInput } from './types.js';

/** 纯规划与最终 permit 复核共用该规则；跨目的旧单必须撤旧并等待结算后再提交。 */
export function resolveSellMergeDecision(input: SellMergeDecisionInput): SellMergeDecision {
  for (const order of input.pendingOrders) {
    if (typeof order.isProtectiveLiquidation !== 'boolean') {
      throw new TypeError('[订单合并] 旧卖单缺少可证明的 protective 身份');
    }
  }

  const normalized = input.pendingOrders
    .map((order) => ({ order, remaining: order.submittedQuantity - order.executedQuantity }))
    .filter((item) => isValidPositiveNumber(item.remaining));
  const pendingOrderIds = normalized.map((item) => item.order.orderId);
  const pendingRemainingQuantity = sumSafeQuantities(
    normalized.map((item) => String(item.remaining)),
  );

  if (!Number.isFinite(input.newOrderQuantity) || input.newOrderQuantity <= 0) {
    return {
      action: 'SKIP',
      mergedQuantity: pendingRemainingQuantity,
      targetOrderId: null,
      pendingOrderIds,
      pendingRemainingQuantity,
      reason: 'no-additional-quantity',
    };
  }

  if (pendingRemainingQuantity <= 0) {
    return {
      action: 'SUBMIT',
      mergedQuantity: input.newOrderQuantity,
      targetOrderId: null,
      pendingOrderIds,
      pendingRemainingQuantity,
      reason: 'no-pending-sell',
    };
  }

  const mergedQuantity = sumSafeQuantities([
    String(pendingRemainingQuantity),
    String(input.newOrderQuantity),
  ]);
  const mustCancel =
    input.isProtectiveLiquidation ||
    normalized.some((item) => item.order.isProtectiveLiquidation) ||
    normalized.length > 1 ||
    normalized.some((item) => item.order.orderType !== input.newOrderType) ||
    normalized.some((item) => NON_REPLACEABLE_READ_STATUSES.has(item.order.status)) ||
    normalized.some((item) => NON_REPLACEABLE_READ_TYPES.has(item.order.orderType));

  return {
    action: mustCancel ? 'CANCEL_AND_SUBMIT' : 'REPLACE',
    mergedQuantity,
    targetOrderId: mustCancel ? null : (normalized[0]?.order.orderId ?? null),
    pendingOrderIds,
    pendingRemainingQuantity,
    reason: mustCancel ? 'cancel-and-merge' : 'replace-and-merge',
  };
}
