/**
 * 卖出扣减策略模块
 *
 * 职责：
 * - 实现统一的“低价优先整笔消除”策略
 * - 供订单过滤引擎共享使用
 */
import { logger } from '../../utils/logger/index.js';
import type { OrderRecord } from '../../types/services.js';

/**
 * 从买入订单列表中扣减卖出数量。
 *
 * @param candidateBuyOrders 候选买入订单列表
 * @param sellQuantity 卖出数量
 * @returns 扣减后剩余的买入订单列表
 */
export function deductSellQuantityFromBuyOrders(
  candidateBuyOrders: ReadonlyArray<OrderRecord>,
  sellQuantity: number,
): OrderRecord[] {
  if (candidateBuyOrders.length === 0) {
    return [];
  }

  if (sellQuantity <= 0) {
    if (sellQuantity < 0) {
      logger.warn(`[卖出扣减策略] 卖出数量为负数: ${sellQuantity},返回原列表`);
    }

    return [...candidateBuyOrders];
  }

  if (!Number.isFinite(sellQuantity)) {
    logger.warn(`[卖出扣减策略] 卖出数量非有限数: ${sellQuantity},返回原列表`);
    return [...candidateBuyOrders];
  }

  const sortedOrders = [...candidateBuyOrders].sort((a, b) => {
    if (a.executedPrice !== b.executedPrice) {
      return a.executedPrice - b.executedPrice;
    }

    if (a.executedTime !== b.executedTime) {
      return a.executedTime - b.executedTime;
    }

    return a.orderId.localeCompare(b.orderId);
  });

  const remainingOrders: OrderRecord[] = [];
  let remainingDeduction = sellQuantity;

  for (const order of sortedOrders) {
    if (remainingDeduction <= 0) {
      remainingOrders.push(order);
      continue;
    }

    if (order.executedQuantity <= remainingDeduction) {
      remainingDeduction -= order.executedQuantity;
      continue;
    }

    remainingOrders.push(order);
  }

  return remainingOrders;
}
