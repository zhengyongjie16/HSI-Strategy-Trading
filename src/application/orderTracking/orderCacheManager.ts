/**
 * 订单缓存管理模块
 *
 * 职责：
 * - 缓存未成交订单列表（30秒 TTL）
 * - 提供按标的查询和强制刷新功能
 *
 * 缓存策略：
 * - 按 symbols 组合作为缓存键
 * - 订单状态变化后自动失效
 */

import { API } from '../../constants/common.js';
import {
  ORDER_READ_STATUS_VALUES,
  ORDER_READ_TYPE_VALUES,
} from '../../constants/orderReadMetadata.js';
import { isOpenOrderReadStatus } from '../../domain/order/orderReadLifecycle.js';
import type {
  OrderReadStatus,
  OrderReadType,
  PendingOrder,
} from '../../types/orderReadMetadata.js';

import { isRecord } from '../../utils/helpers/index.js';
import { canonicalDecimal } from '../../utils/numeric/exact.js';
import type {
  OrderCacheManager,
  OrderCacheManagerDeps,
  TodayOrderForPendingCache,
} from './types.js';

/** 校验adapter已证明的结构整数；不接受文本/SDK对象或非法数量的隐式number桥。 */
function isSafeOrderQuantity(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function textSetHas(set: ReadonlySet<string>, value: string): boolean {
  return set.has(value);
}

function isValidOrderSide(value: unknown): value is PendingOrder['side'] {
  return value === 'BUY' || value === 'SELL';
}

function isValidOrderStatus(value: unknown): value is OrderReadStatus {
  return typeof value === 'string' && textSetHas(ORDER_READ_STATUS_VALUES, value);
}

function isValidOrderType(value: unknown): value is OrderReadType {
  return typeof value === 'string' && textSetHas(ORDER_READ_TYPE_VALUES, value);
}

function isValidNullableOrderPrice(value: unknown): boolean {
  if (value === null) return true;

  if (typeof value !== 'string') return false;

  canonicalDecimal(value);
  return true;
}

function isValidTodayOrder(order: unknown): order is TodayOrderForPendingCache {
  if (!isRecord(order)) {
    return false;
  }

  return (
    typeof order['orderId'] === 'string' &&
    typeof order['symbol'] === 'string' &&
    isValidOrderSide(order['side']) &&
    isValidOrderStatus(order['status']) &&
    isValidOrderType(order['orderType']) &&
    isValidNullableOrderPrice(order['submittedPrice']) &&
    isSafeOrderQuantity(order['quantity'])
  );
}

/**
 * 创建订单缓存管理器。
 * 缓存未成交订单列表（按 symbols 组合 + TTL），提供 getPendingOrders、clearCache。
 * 避免频繁调用 todayOrders API，订单状态变化后由调用方 clearCache 失效。
 *
 * @param deps 依赖注入（ctx、rateLimiter）
 * @returns OrderCacheManager 接口实例
 */
export const createOrderCacheManager = (deps: OrderCacheManagerDeps): OrderCacheManager => {
  const { logger } = deps;
  const { ctx, rateLimiter, now } = deps;

  // 闭包捕获的私有状态
  let pendingOrdersCache: PendingOrder[] | null = null;
  let pendingOrdersCacheSymbols: string | null = null;
  let pendingOrdersCacheTime: number = 0;

  /**
   * 获取今日未成交订单（带缓存）。
   * 优先返回缓存；超过 TTL 或 forceRefresh 时调用 API 刷新并更新缓存。
   * 末日保护等运行期链路需要未成交订单列表，缓存减少 API 调用。
   *
   * @param symbols 标的列表，null 或空表示全部
   * @param forceRefresh 是否强制刷新，默认 false
   * @returns 未成交订单列表（仅包含 PENDING 等未完成状态）
   */
  const getPendingOrders = async (
    symbols: ReadonlyArray<string> | null = null,
    forceRefresh: boolean = false,
  ): Promise<ReadonlyArray<PendingOrder>> => {
    // 将 symbols 数组排序，用于比较缓存是否对应同一组 symbols
    const symbolsKey =
      symbols && symbols.length > 0
        ? [...symbols].sort((a, b) => a.localeCompare(b)).join(',')
        : 'ALL'; // null 或空数组统一标记为 "ALL"
    const currentTimeMs = now().getTime();
    const isCacheValid =
      pendingOrdersCache !== null &&
      pendingOrdersCacheSymbols === symbolsKey &&
      currentTimeMs - pendingOrdersCacheTime < API.PENDING_ORDERS_CACHE_TTL_MS;

    // 如果缓存有效且不强制刷新，直接返回缓存
    // 注意：虽然 isCacheValid 已经检查了 pendingOrdersCache !== null，
    // 但 TypeScript 无法推断变量中的条件关系，需要显式检查来缩窄类型
    if (isCacheValid && !forceRefresh && pendingOrdersCache !== null) {
      logger.debug(
        `[订单缓存] 使用缓存的未成交订单数据 (symbols=${symbolsKey}, 缓存时间: ${currentTimeMs - pendingOrdersCacheTime}ms)`,
      );
      return [...pendingOrdersCache];
    }

    // 始终一次性获取所有今日订单，然后在客户端按标的过滤
    // 这样无论查询多少个标的，都只需要 1 次 API 调用
    // 避免了之前为每个标的单独调用导致的 API 限流问题
    await rateLimiter.throttle();
    const todayOrdersRaw = await deps.requestExternalApi({
      operation: 'TradeContext.todayOrders',
      request: () => ctx.todayOrders(),
    });
    if (!Array.isArray(todayOrdersRaw)) {
      throw new TypeError('[订单缓存] todayOrders 返回结果不是数组，无法解析未成交订单');
    }

    for (const order of todayOrdersRaw) {
      if (!isValidTodayOrder(order)) {
        throw new TypeError('[订单缓存] todayOrders 订单数据结构无效，无法解析未成交订单');
      }
    }

    const allOrders: ReadonlyArray<TodayOrderForPendingCache> = todayOrdersRaw;

    // 如果指定了标的，还需要在客户端再次过滤（因为可能获取了所有订单）
    const targetSymbols = symbols && symbols.length > 0 ? new Set(symbols) : null;
    const result: PendingOrder[] = [];
    for (const order of allOrders) {
      // 先过滤状态
      if (!isOpenOrderReadStatus(order.status)) {
        continue;
      }

      // 如果指定了标的，再过滤标的
      if (targetSymbols && !targetSymbols.has(order.symbol)) {
        continue;
      }

      result.push({
        orderId: order.orderId,
        symbol: order.symbol,
        side: order.side,
        submittedPrice: order.submittedPrice,
        quantity: order.quantity,
        status: order.status,
        orderType: order.orderType,
      });
    }

    pendingOrdersCache = result;
    pendingOrdersCacheSymbols = symbolsKey;
    pendingOrdersCacheTime = now().getTime();
    logger.debug(
      `[订单缓存] 已刷新未成交订单缓存 (symbols=${symbolsKey})，共 ${result.length} 个订单`,
    );
    return [...result];
  };

  /** 清除缓存（订单提交/撤销/修改后调用） */
  const clearCache = (): void => {
    pendingOrdersCache = null;
    pendingOrdersCacheSymbols = null;
    pendingOrdersCacheTime = 0;
    logger.debug('[订单缓存] 已清除缓存');
  };
  return {
    getPendingOrders,
    clearCache,
  };
};
