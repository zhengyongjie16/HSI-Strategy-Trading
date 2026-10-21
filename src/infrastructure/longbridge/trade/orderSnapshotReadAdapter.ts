/** 同一 context 订单快照 IO 边界：先选择原始快照，再向 core 返回严格验证的订单事实。 */
import { OrderSide, type Order, type TradeContext } from 'longbridge';
import { wrapExternalApiRequest } from '../../externalApi/index.js';
import { isValidatedOrderStatus, isValidatedOrderType } from './orderValidation.js';
import { isHongKongSymbol } from '../../../utils/marketScope.js';
import { isRecord } from '../../../utils/helpers/index.js';
import { canonicalDecimal } from '../../../utils/numeric/exact.js';
import type { RateLimiter } from '../../../types/rateLimit.js';
import type { OrderSnapshotReadPort } from '../../../types/orderSnapshotReadPorts.js';
import type { OrderFact } from '../../../types/trade.js';
import { mapBrokerOrder } from './orderMapper.js';

/**
 * 校验外部订单 API 返回值必须是数组。
 *
 * @param value 外部 API 返回值
 * @param operation 外部 API 操作名
 */
function assertOrderArray(
  value: unknown,
  operation: string,
): asserts value is ReadonlyArray<unknown> {
  if (!Array.isArray(value)) {
    throw new TypeError(`[订单记录] ${operation} 返回值不是数组`);
  }
}

function isFiniteDecimalLike(value: unknown): boolean {
  if (!isRecord(value) || typeof value.toString !== 'function') return false;

  try {
    const converter: unknown = Reflect.get(value, 'toString');
    if (typeof converter !== 'function') return false;

    const text: unknown = Reflect.apply(converter, value, []);
    if (typeof text !== 'string') return false;

    canonicalDecimal(text);
    return true;
  } catch {
    return false;
  }
}

function isNullableFiniteDecimalLike(value: unknown): boolean {
  return value === null || isFiniteDecimalLike(value);
}

/**
 * 校验 SDK 订单时间为可用于内部订单事实的正有限时间点。
 *
 * @param value SDK 返回的时间字段
 * @returns 时间字段是否为有效的正有限 Date
 */
function isValidOrderTimestamp(value: unknown): value is Date {
  if (!(value instanceof Date)) {
    return false;
  }

  const timestampMs = value.getTime();
  return Number.isFinite(timestampMs) && timestampMs > 0;
}

function isValidOrderSide(value: unknown): value is OrderSide {
  switch (value) {
    case OrderSide.Unknown:
    case OrderSide.Buy:
    case OrderSide.Sell: {
      return true;
    }

    default: {
      return false;
    }
  }
}

/** 市场范围过滤前只校验订单身份；坏 symbol 结构由 marketScope 直接抛出，不静默忽略。 */
function assertOrderIdentity(
  value: unknown,
  operation: string,
): asserts value is Readonly<{ orderId: string; symbol: string }> {
  if (
    !isRecord(value) ||
    typeof value['orderId'] !== 'string' ||
    value['orderId'].length === 0 ||
    typeof value['symbol'] !== 'string' ||
    value['symbol'].length === 0
  ) {
    throw new TypeError(`[订单记录] ${operation} 订单数据结构无效`);
  }
}

function assertValidOrder(value: unknown, operation: string): asserts value is Order {
  if (
    !isRecord(value) ||
    typeof value['orderId'] !== 'string' ||
    value['orderId'].length === 0 ||
    typeof value['symbol'] !== 'string' ||
    value['symbol'].length === 0 ||
    typeof value['stockName'] !== 'string' ||
    !isValidOrderSide(value['side']) ||
    !isValidatedOrderStatus(value['status']) ||
    !isValidatedOrderType(value['orderType']) ||
    !isNullableFiniteDecimalLike(value['price']) ||
    !isFiniteDecimalLike(value['quantity']) ||
    !isNullableFiniteDecimalLike(value['executedPrice']) ||
    !isFiniteDecimalLike(value['executedQuantity']) ||
    !isValidOrderTimestamp(value['submittedAt']) ||
    (value['updatedAt'] !== undefined &&
      value['updatedAt'] !== null &&
      !isValidOrderTimestamp(value['updatedAt']))
  ) {
    throw new TypeError(`[订单记录] ${operation} 订单数据结构无效`);
  }
}

// SDK snapshot的原nullable/省略revision同为缺失；不spread原生class，不为正成交造revision。
function mapSnapshotOrder(order: Order): OrderFact {
  return mapBrokerOrder({
    orderId: order.orderId,
    symbol: order.symbol,
    stockName: order.stockName,
    side: order.side,
    status: order.status,
    orderType: order.orderType,
    remark: order.remark,
    price: order.price,
    quantity: order.quantity,
    executedPrice: order.executedPrice,
    executedQuantity: order.executedQuantity,
    submittedAt: order.submittedAt,
    updatedAt: order.updatedAt ?? null,
  });
}

/**
 * 仅校验身份并过滤明确非 HK 订单；同一来源的 HK ID 重复必须在跨来源覆盖前拒绝。
 * 保留原始 SDK 对象，败选观察不触碰金融、状态或修订字段。
 */
function indexScopedOrders(
  raw: ReadonlyArray<unknown>,
  operation: string,
): Map<string, unknown> {
  const ordersById = new Map<string, unknown>();
  for (const order of raw) {
    assertOrderIdentity(order, operation);
    const shouldSkip = !isHongKongSymbol(order.symbol);
    if (shouldSkip) continue;

    if (ordersById.has(order.orderId)) {
      throw new TypeError(`[订单记录] ${operation} 同一来源存在重复订单 ID: ${order.orderId}`);
    }

    ordersById.set(order.orderId, order);
  }

  return ordersById;
}

/**
 * 同一 context 并行读取 history/today，每次 SDK 尝试均先通过共享限流；只对获选 raw 严格映射。
 * today 无条件整条覆盖同 ID 的 history，不按更新时间择优或拼接字段。
 * @param context 原 SDK context，不创建第二上下文
 * @param deps 已有共享 limiter
 * @returns 返回最终 HK 订单事实的快照 IO port
 */
export function createOrderSnapshotReadAdapter(
  context: unknown,
  deps: Readonly<{ rateLimiter: Pick<RateLimiter, 'throttle'> }>,
): OrderSnapshotReadPort {
  if (
    !isRecord(context) ||
    typeof context['historyOrders'] !== 'function' ||
    typeof context['todayOrders'] !== 'function'
  )
    throw new TypeError('[OrderSnapshotReadAdapter] missing injected SDK snapshot capability');

  const ctx = context as Pick<TradeContext, 'historyOrders' | 'todayOrders'>;
  const { rateLimiter } = deps;
  return {
    fetchAllOrders: async () => {
      const [historyOrdersRaw, todayOrdersRaw] = await Promise.all([
        wrapExternalApiRequest<unknown>({
          operation: 'TradeContext.historyOrders',
          request: async () => {
            await rateLimiter.throttle();
            return ctx.historyOrders({
              endAt: new Date(),
            });
          },
        }),
        wrapExternalApiRequest<unknown>({
          operation: 'TradeContext.todayOrders',
          request: async () => {
            await rateLimiter.throttle();
            return ctx.todayOrders();
          },
        }),
      ]);
      assertOrderArray(historyOrdersRaw, 'TradeContext.historyOrders');
      assertOrderArray(todayOrdersRaw, 'TradeContext.todayOrders');

      const ordersById = indexScopedOrders(historyOrdersRaw, 'TradeContext.historyOrders');
      const todayOrdersById = indexScopedOrders(todayOrdersRaw, 'TradeContext.todayOrders');
      for (const [orderId, order] of todayOrdersById) {
        ordersById.set(orderId, order);
      }

      return Array.from(ordersById, ([orderId, order]) => {
        const operation = todayOrdersById.has(orderId)
          ? 'TradeContext.todayOrders'
          : 'TradeContext.historyOrders';
        assertValidOrder(order, operation);
        return mapSnapshotOrder(order);
      });
    },
  };
}
