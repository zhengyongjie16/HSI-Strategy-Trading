/** 全量订单快照择新纯规则：today 覆盖 history，同来源按独立更新时间择新；不请求或提交订单。 */

import type { OrderFact } from '../../types/trade.js';
import type { MergedOrderEntry, OrderSnapshotSource } from './types.js';

/**
 * 解析订单快照版本时间（用于合并去重时比较新旧）。
 * 使用 broker ingress 已独立校验的 updatedAtMs，不用成交时间推导版本。
 *
 * @param order 订单记录
 * @returns 版本时间戳（毫秒）
 */
function resolveOrderSnapshotVersionMs(order: OrderFact): number {
  return order.updatedAtMs;
}

/**
 * 判断候选订单是否应覆盖现有订单：today 快照优先于 history；同一来源时版本时间更晚者优先。
 *
 * @param existingEntry 已存在的合并项
 * @param candidateOrder 候选订单
 * @param candidateSource 候选订单来源（today/history）
 * @returns 为 true 时应用候选订单覆盖现有项
 */
function shouldReplaceMergedEntry(
  existingEntry: MergedOrderEntry,
  candidateOrder: OrderFact,
  candidateSource: OrderSnapshotSource,
): boolean {
  if (candidateSource === 'today' && existingEntry.source === 'history') {
    return true;
  }

  if (candidateSource === 'history' && existingEntry.source === 'today') {
    return false;
  }

  const existingVersion = resolveOrderSnapshotVersionMs(existingEntry.order);
  const candidateVersion = resolveOrderSnapshotVersionMs(candidateOrder);
  return candidateVersion > existingVersion;
}

/**
 * 合并历史订单和今日订单，按 orderId 去重；跨来源时 today 无条件优先，同一来源内按版本时间选择更新项。
 *
 * @param historyOrders 历史订单列表
 * @param todayOrders 今日订单列表
 * @returns 按 orderId 去重后的订单数组（跨来源保留 today，同来源保留版本时间更新的一条）
 */
export function mergeAndDeduplicateOrders(
  historyOrders: ReadonlyArray<OrderFact>,
  todayOrders: ReadonlyArray<OrderFact>,
): OrderFact[] {
  const mergedByOrderId = new Map<string, MergedOrderEntry>();

  for (const order of historyOrders) {
    const existing = mergedByOrderId.get(order.orderId);
    if (!existing) {
      mergedByOrderId.set(order.orderId, {
        source: 'history',
        order,
      });
      continue;
    }

    if (shouldReplaceMergedEntry(existing, order, 'history')) {
      mergedByOrderId.set(order.orderId, {
        source: 'history',
        order,
      });
    }
  }

  for (const order of todayOrders) {
    const existing = mergedByOrderId.get(order.orderId);
    if (!existing) {
      mergedByOrderId.set(order.orderId, {
        source: 'today',
        order,
      });
      continue;
    }

    if (shouldReplaceMergedEntry(existing, order, 'today')) {
      mergedByOrderId.set(order.orderId, {
        source: 'today',
        order,
      });
    }
  }

  return Array.from(mergedByOrderId.values(), (entry) => entry.order);
}
