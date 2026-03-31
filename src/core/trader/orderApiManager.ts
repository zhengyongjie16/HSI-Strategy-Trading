/**
 * 订单 API 管理模块
 *
 * 职责：
 * - 从 Longbridge API 获取订单
 * - 管理全量订单缓存（history + today 合并去重）
 * - 在信任边界将 SDK Order 转换为 RawOrderFromAPI
 */
import type { Order } from 'longbridge';
import { decimalToNumber } from '../../utils/helpers/index.js';
import type { RawOrderFromAPI } from '../../types/services.js';
import type {
  MergedOrderEntry,
  OrderApiManager,
  OrderApiManagerDeps,
  OrderSnapshotSource,
} from './types.js';

/** 将 Longbridge SDK Order 实例转换为内部 RawOrderFromAPI。 */
function orderToRawOrderFromAPI(order: Order): RawOrderFromAPI {
  const price = order.price;
  const executedPrice = order.executedPrice;
  const remark = order.remark;
  return {
    orderId: order.orderId,
    symbol: order.symbol,
    stockName: order.stockName,
    side: order.side,
    status: order.status,
    orderType: order.orderType,
    remark: typeof remark === 'string' ? remark : null,
    price: price === null ? null : decimalToNumber(price),
    quantity: decimalToNumber(order.quantity),
    executedPrice: executedPrice === null ? null : decimalToNumber(executedPrice),
    executedQuantity: decimalToNumber(order.executedQuantity),
    submittedAt: order.submittedAt,
    updatedAt: order.updatedAt ?? null,
  };
}

/** 解析订单快照版本时间（用于合并去重时比较新旧）。 */
function resolveOrderSnapshotVersionMs(order: RawOrderFromAPI): number {
  const updatedAtMs = order.updatedAt?.getTime() ?? 0;
  if (updatedAtMs > 0) {
    return updatedAtMs;
  }

  const submittedAtMs = order.submittedAt?.getTime() ?? 0;
  return Math.max(Number.isNaN(submittedAtMs) ? 0 : submittedAtMs, 0);
}

/** 判断候选订单是否应覆盖现有订单。 */
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

/** 合并历史订单和今日订单，按 orderId 去重并保留最新快照。 */
function mergeAndDeduplicateOrders(
  historyOrders: ReadonlyArray<RawOrderFromAPI>,
  todayOrders: ReadonlyArray<RawOrderFromAPI>,
): ReadonlyArray<RawOrderFromAPI> {
  const mergedByOrderId = new Map<string, MergedOrderEntry>();

  for (const order of historyOrders) {
    const existing = mergedByOrderId.get(order.orderId);
    if (!existing) {
      mergedByOrderId.set(order.orderId, { source: 'history', order });
      continue;
    }

    if (shouldReplaceMergedEntry(existing, order, 'history')) {
      mergedByOrderId.set(order.orderId, { source: 'history', order });
    }
  }

  for (const order of todayOrders) {
    const existing = mergedByOrderId.get(order.orderId);
    if (!existing) {
      mergedByOrderId.set(order.orderId, { source: 'today', order });
      continue;
    }

    if (shouldReplaceMergedEntry(existing, order, 'today')) {
      mergedByOrderId.set(order.orderId, { source: 'today', order });
    }
  }

  return Array.from(mergedByOrderId.values(), (entry) => entry.order);
}

/**
 * 创建订单 API 管理器。
 *
 * @param deps 依赖注入（ctxPromise、rateLimiter）
 * @returns 只负责全量订单查询与缓存的轻量服务
 */
export function createOrderAPIManager(deps: OrderApiManagerDeps): OrderApiManager {
  const { ctxPromise, rateLimiter } = deps;
  let allOrdersCache: ReadonlyArray<RawOrderFromAPI> | null = null;

  async function fetchAllOrdersFromAPI(
    forceRefresh = false,
  ): Promise<ReadonlyArray<RawOrderFromAPI>> {
    if (allOrdersCache !== null && !forceRefresh) {
      return [...allOrdersCache];
    }

    const ctx = await ctxPromise;
    await rateLimiter.throttle();
    const historyOrdersRaw: ReadonlyArray<Order> = await ctx.historyOrders({
      endAt: new Date(),
    });
    await rateLimiter.throttle();
    const todayOrdersRaw: ReadonlyArray<Order> = await ctx.todayOrders();

    const historyOrders = Array.from(historyOrdersRaw, orderToRawOrderFromAPI);
    const todayOrders = Array.from(todayOrdersRaw, orderToRawOrderFromAPI);
    const allOrders = mergeAndDeduplicateOrders(historyOrders, todayOrders);
    allOrdersCache = allOrders;
    return [...allOrders];
  }

  function clearCache(): void {
    allOrdersCache = null;
  }

  return {
    fetchAllOrdersFromAPI,
    clearCache,
  };
}
