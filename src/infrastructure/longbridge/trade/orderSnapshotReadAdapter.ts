import { wrapExternalApiRequest } from '../../externalApi/index.js';

/** 同一原context订单快照IO边界；core只接收已验证观察，不解析SDK对象。 */
import { OrderSide, type Order, type TradeContext } from 'longbridge';
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
 * 先按市场范围过滤明确非HK订单，再执行严格数值/状态映射：
 * 跨市场订单（含碎股小数数量）不属于本系统管理范围，不得因结构差异升级为拒绝。
 */
function mapScopedOrders(
  raw: ReadonlyArray<unknown>,
  operation: string,
): ReadonlyArray<OrderFact> {
  const scope: OrderFact[] = [];
  for (const order of raw) {
    assertOrderIdentity(order, operation);
    if (!isHongKongSymbol(order.symbol)) continue;

    assertValidOrder(order, operation);
    scope.push(mapSnapshotOrder(order));
  }

  return scope;
}

/**
 * 只装配批准SDK读能力；原两读顺序/limiter/retry与返回后结构验证保持。非pure-conversion/data能力。
 * @param context 原SDKcontext，不创建第二上下文
 * @param deps 原limiter
 * @returns 实际快照IO port，历史优先策略仍由原core owner决定
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
    fetchSnapshots: async () => {
      await rateLimiter.throttle();
      const historyOrdersRaw: unknown = await wrapExternalApiRequest({
        operation: 'TradeContext.historyOrders',
        request: () =>
          ctx.historyOrders({
            endAt: new Date(),
          }),
      });
      assertOrderArray(historyOrdersRaw, 'TradeContext.historyOrders');
      // 历史结构先验证再发下一次读：坏返回不得先驱动后续 IO。
      const historyOrders = mapScopedOrders(historyOrdersRaw, 'TradeContext.historyOrders');

      await rateLimiter.throttle();
      const todayOrdersRaw: unknown = await wrapExternalApiRequest({
        operation: 'TradeContext.todayOrders',
        request: () => ctx.todayOrders(),
      });
      assertOrderArray(todayOrdersRaw, 'TradeContext.todayOrders');
      const todayOrders = mapScopedOrders(todayOrdersRaw, 'TradeContext.todayOrders');

      return { historyOrders, todayOrders };
    },
  };
}
