/** 订单快照owner：原history/today去重，SDK读取/解析仅在注入infra IO edge。 */
import type { RawOrderFromAPI } from '../../types/services.js';
import type {
  MergedOrderEntry,
  OrderAPIManager,
  OrderAPIManagerDeps,
  OrderSnapshotSource,
} from './types.js';

/**
 * 解析订单快照版本时间（用于合并去重时比较新旧）。
 * 优先使用 updatedAt，其次 submittedAt，均缺失时按 0 处理。
 *
 * @param order 订单记录
 * @returns 版本时间戳（毫秒）
 */
function resolveOrderSnapshotVersionMs(order: RawOrderFromAPI): number {
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
  candidateOrder: RawOrderFromAPI,
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
function mergeAndDeduplicateOrders(
  historyOrders: ReadonlyArray<RawOrderFromAPI>,
  todayOrders: ReadonlyArray<RawOrderFromAPI>,
): RawOrderFromAPI[] {
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

/** 原快照合并入口，不改变today优先/同source更新版本选择。 */
export function createOrderAPIManager(deps: OrderAPIManagerDeps): OrderAPIManager {
  return {
    fetchAllOrdersFromAPI: async () => {
      const { historyOrders, todayOrders } = await deps.orderSnapshotReadPort.fetchSnapshots();
      return [...mergeAndDeduplicateOrders(historyOrders, todayOrders)];
    },
  };
}
