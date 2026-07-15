import { OrderSide } from 'longbridge';
import { TIME } from '../../constants/index.js';
import { classifyOrderStatusLifecycle } from '../orderStatusLifecycle/index.js';
import { decimalToNumber, isValidPositiveNumber } from '../../utils/helpers/index.js';
import { calculateTradingDurationMsBetween } from '../../utils/time/index.js';
import {
  decimalAdd,
  decimalDiv,
  decimalGt,
  decimalMul,
  decimalToNumberValue,
  toDecimalValue,
} from '../../utils/numeric/index.js';
import type { OrderRecord, RawOrderFromAPI } from '../../types/services.js';
import type { OrderTimeoutCheckParams } from '../../types/tradingCalendar.js';
import type { OrderRebuildClassification, OrderStatistics } from './types.js';

/**
 * 断言写入本地订单记录所需的 broker 执行事实完整有效。
 *
 * @param executedPrice 权威成交价格
 * @param executedQuantity 权威成交数量
 * @param executedTimeMs 权威成交时间戳（毫秒）
 * @returns 无返回值；任一事实缺失、非有限或非正时抛错
 */
export function assertCompleteExecutionFact(
  executedPrice: number,
  executedQuantity: number,
  executedTimeMs: number,
): void {
  if (
    !isValidPositiveNumber(executedPrice) ||
    !isValidPositiveNumber(executedQuantity) ||
    !isValidPositiveNumber(executedTimeMs)
  ) {
    throw new Error(
      `[订单记录] 执行事实不完整或无效: price=${executedPrice}, ` +
        `quantity=${executedQuantity}, executedTimeMs=${executedTimeMs}`,
    );
  }
}

/**
 * 计算订单列表的统计信息（用于调试输出与成本均价计算）。
 * 默认行为：价格或数量无效的订单按 0 参与累加；无订单时均价为 0。
 *
 * @param orders 订单记录列表
 * @returns 包含总数量与均价的统计对象
 */
export function calculateOrderStatistics(orders: ReadonlyArray<OrderRecord>): OrderStatistics {
  let totalQuantity = toDecimalValue(0);
  let totalValue = toDecimalValue(0);

  for (const order of orders) {
    const quantity = Number.isFinite(order.executedQuantity) ? order.executedQuantity : 0;
    const price = Number.isFinite(order.executedPrice) ? order.executedPrice : 0;
    totalQuantity = decimalAdd(totalQuantity, quantity);
    totalValue = decimalAdd(totalValue, decimalMul(price, quantity));
  }

  const averagePrice = decimalGt(totalQuantity, 0)
    ? decimalToNumberValue(decimalDiv(totalValue, totalQuantity))
    : 0;
  return {
    totalQuantity: decimalToNumberValue(totalQuantity),
    averagePrice,
  };
}

/**
 * 计算订单列表的总成交数量。
 * 默认行为：单笔订单的 executedQuantity 非有限数时视为 0 参与累加。
 *
 * @param orders 订单记录列表
 * @returns 所有订单的成交数量之和，无效数量视为 0
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
 * 触发条件：heldTradingMs > timeoutMinutes * 60_000（严格大于）。
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

/**
 * 将原始 API 订单转换为内部 OrderRecord 格式（内部辅助函数）
 *
 * 转换逻辑：
 * - 提取成交价格、成交数量和成交时间
 * - 买入订单保留 submittedAt 和 updatedAt 字段（用于成本计算）
 * - 卖出订单不保留时间字段（仅需成交信息）
 * - 价格/数量/时间任一无效时返回 null
 *
 * @param order 原始 API 订单数据
 * @param isBuyOrder 是否为买入订单（影响 submittedAt/updatedAt 是否保留）
 * @returns 转换后的订单记录，价格/数量/时间无效时返回 null
 */
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
 * 在重建分类前校验非零累计成交所对应的完整 broker 执行事实。
 * 零累计成交不代表执行事实：OPEN 订单仍需进入 pending，终态订单则直接忽略。
 *
 * @param order 原始 API 订单数据
 * @returns 无返回值；非零累计成交的价格、数量或更新时间无效时抛错
 */
function assertNonZeroRebuildExecutionFact(order: RawOrderFromAPI): void {
  const executedQuantity = decimalToNumber(order.executedQuantity);
  if (executedQuantity === 0) {
    return;
  }

  const executedPrice = decimalToNumber(order.executedPrice);
  const executedTimeMs = order.updatedAt?.getTime() ?? Number.NaN;
  assertCompleteExecutionFact(executedPrice, executedQuantity, executedTimeMs);
}

/**
 * 将原始 API 订单列表按买卖方向分类并转换为内部 OrderRecord 格式。
 * 默认行为：处理所有存在有效成交事实的订单（不限终态），价格/数量/时间无效的订单被跳过。
 *
 * @param orders 原始 API 订单列表
 * @returns 分类后的买入订单列表与卖出订单列表（仅包含有有效成交且转换成功的订单）
 */
export function classifyAndConvertOrders(orders: ReadonlyArray<RawOrderFromAPI>): {
  buyOrders: ReadonlyArray<OrderRecord>;
  sellOrders: ReadonlyArray<OrderRecord>;
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
    } else {
      sellOrders.push(converted);
    }
  }

  return { buyOrders, sellOrders };
}

/**
 * 启动/重建阶段对单标的全量订单做统一分类与分流。
 * 默认行为：
 * - 非零累计成交必须先具备完整有效的 broker 执行事实，否则阻断重建
 * - 无法归属 Buy/Sell 的非零执行或 OPEN 订单直接阻断，避免丢失执行事实或无法恢复挂单
 * - Buy/Sell 的 OPEN 订单保留原始结构进入 pending，交由恢复阶段继续跟踪或撤单
 * - 零累计成交的无法归属 TERMINAL 订单不代表执行事实，可直接忽略
 *
 * @param orders 单标的全量订单
 * @returns Execution/Pending 按买卖方向分流后的分类结果
 */
export function classifyOrdersForRebuild(
  orders: ReadonlyArray<RawOrderFromAPI>,
): OrderRebuildClassification {
  const executedBuyOrders: OrderRecord[] = [];
  const executedSellOrders: OrderRecord[] = [];
  const pendingBuyOrders: RawOrderFromAPI[] = [];
  const pendingSellOrders: RawOrderFromAPI[] = [];

  for (const order of orders) {
    const lifecycle = classifyOrderStatusLifecycle(order.status);
    assertNonZeroRebuildExecutionFact(order);

    const isBuyOrder = order.side === OrderSide.Buy;
    const isSellOrder = order.side === OrderSide.Sell;
    if (!isBuyOrder && !isSellOrder) {
      const executedQuantity = decimalToNumber(order.executedQuantity);
      if (executedQuantity !== 0 || lifecycle === 'OPEN') {
        throw new Error(
          `[订单记录] 订单方向不可归属: side=${order.side}, ` +
            `lifecycle=${lifecycle}, executedQuantity=${executedQuantity}`,
        );
      }

      continue;
    }

    if (lifecycle === 'OPEN') {
      if (isBuyOrder) {
        pendingBuyOrders.push(order);
      } else {
        pendingSellOrders.push(order);
      }

      continue;
    }

    const converted = convertOrderToRecord(order, isBuyOrder);
    if (!converted) {
      continue;
    }

    if (isBuyOrder) {
      executedBuyOrders.push(converted);
    } else {
      executedSellOrders.push(converted);
    }
  }

  return {
    executedBuyOrders,
    executedSellOrders,
    pendingBuyOrders,
    pendingSellOrders,
  };
}
