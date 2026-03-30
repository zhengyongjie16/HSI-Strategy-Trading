/**
 * 订单记录转换模块
 *
 * 职责：
 * - 提供原始订单到内部 OrderRecord 的转换与重建分流
 * - 提供订单超时判定与订单数量统计等纯函数
 */
import { OrderSide, OrderStatus } from 'longbridge';
import { PENDING_ORDER_STATUSES, TIME } from '../../constants/index.js';
import { decimalToNumber } from '../../utils/helpers/index.js';
import { calculateTradingDurationMsBetween } from '../../utils/time/index.js';
import { decimalAdd, decimalToNumberValue, toDecimalValue } from '../../utils/numeric/index.js';
import type { OrderRecord, RawOrderFromAPI } from '../../types/services.js';
import type { OrderTimeoutCheckParams } from '../../types/tradingCalendar.js';
import type { OrderRebuildClassification } from './types.js';

/**
 * 计算订单列表的总成交数量。
 *
 * @param orders 订单记录列表
 * @returns 所有订单的成交数量之和
 */
export function calculateTotalQuantity(orders: ReadonlyArray<OrderRecord>): number {
  let total = toDecimalValue(0);
  for (const order of orders) {
    const quantity = Number.isFinite(order.executedQuantity) ? order.executedQuantity : 0;
    total = decimalAdd(total, quantity);
  }

  return decimalToNumberValue(total);
}

/**
 * 按严格交易时段累计口径判定订单是否超时。
 *
 * @param params 订单成交时间、当前时间、超时分钟与交易日历快照
 * @returns true 表示超时；false 表示未超时或参数无效
 */
export function isOrderTimedOut(params: OrderTimeoutCheckParams): boolean {
  const { orderExecutedTimeMs, nowMs, timeoutMinutes, calendarSnapshot } = params;
  if (!Number.isInteger(timeoutMinutes) || timeoutMinutes < 0) {
    return false;
  }

  const timeoutMs = timeoutMinutes * TIME.MILLISECONDS_PER_MINUTE;
  const heldTradingMs = calculateTradingDurationMsBetween({
    startMs: orderExecutedTimeMs,
    endMs: nowMs,
    calendarSnapshot,
  });
  return heldTradingMs > timeoutMs;
}

/** 将原始 API 订单转换为内部 OrderRecord。 */
function convertOrderToRecord(order: RawOrderFromAPI, isBuyOrder: boolean): OrderRecord | null {
  const executedPrice = decimalToNumber(order.executedPrice);
  const executedQuantity = decimalToNumber(order.executedQuantity);
  const executedTime = order.updatedAt ? order.updatedAt.getTime() : 0;

  if (
    !Number.isFinite(executedPrice) ||
    executedPrice <= 0 ||
    !Number.isFinite(executedQuantity) ||
    executedQuantity <= 0 ||
    executedTime === 0
  ) {
    return null;
  }

  return {
    orderId: order.orderId,
    symbol: order.symbol,
    executedPrice,
    executedQuantity,
    executedTime,
    submittedAt: isBuyOrder ? (order.submittedAt ?? undefined) : undefined,
    updatedAt: isBuyOrder ? (order.updatedAt ?? undefined) : undefined,
  };
}

/**
 * 将原始 API 订单列表按买卖方向分类并转换为内部 OrderRecord。
 *
 * @param orders 原始 API 订单列表
 * @returns 分类后的买入订单列表与卖出订单列表
 */
export function classifyAndConvertOrders(orders: ReadonlyArray<RawOrderFromAPI>): {
  readonly buyOrders: ReadonlyArray<OrderRecord>;
  readonly sellOrders: ReadonlyArray<OrderRecord>;
} {
  const buyOrders: OrderRecord[] = [];
  const sellOrders: OrderRecord[] = [];

  for (const order of orders) {
    const isBuyOrder = order.side === OrderSide.Buy;
    const isSellOrder = order.side === OrderSide.Sell;

    if (!isBuyOrder && !isSellOrder) {
      continue;
    }

    const converted = convertOrderToRecord(order, isBuyOrder);
    if (!converted) {
      continue;
    }

    if (isBuyOrder) {
      buyOrders.push(converted);
      continue;
    }

    sellOrders.push(converted);
  }

  return { buyOrders, sellOrders };
}

/**
 * 启动/重建阶段对当前执行标的的全量订单做统一分类与分流。
 *
 * @param orders 当前执行标的的全量订单
 * @returns Filled/Pending 按买卖方向分流后的分类结果
 */
export function classifyOrdersForRebuild(
  orders: ReadonlyArray<RawOrderFromAPI>,
): OrderRebuildClassification {
  const filledBuyOrders: OrderRecord[] = [];
  const filledSellOrders: OrderRecord[] = [];
  const pendingBuyOrders: RawOrderFromAPI[] = [];
  const pendingSellOrders: RawOrderFromAPI[] = [];

  for (const order of orders) {
    if (order.status === OrderStatus.Filled) {
      const isBuyOrder = order.side === OrderSide.Buy;
      const isSellOrder = order.side === OrderSide.Sell;
      if (!isBuyOrder && !isSellOrder) {
        continue;
      }

      const converted = convertOrderToRecord(order, isBuyOrder);
      if (!converted) {
        continue;
      }

      if (isBuyOrder) {
        filledBuyOrders.push(converted);
        continue;
      }

      filledSellOrders.push(converted);
      continue;
    }

    if (!PENDING_ORDER_STATUSES.has(order.status)) {
      continue;
    }

    if (order.side === OrderSide.Buy) {
      pendingBuyOrders.push(order);
      continue;
    }

    if (order.side === OrderSide.Sell) {
      pendingSellOrders.push(order);
    }
  }

  return {
    filledBuyOrders,
    filledSellOrders,
    pendingBuyOrders,
    pendingSellOrders,
  };
}
