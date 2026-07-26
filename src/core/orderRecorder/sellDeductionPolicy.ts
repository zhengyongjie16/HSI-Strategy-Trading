/**
 * 卖出扣减策略模块
 *
 * 职责：
 * - 实现统一的"低价优先整笔消除"策略
 * - 用于订单过滤引擎、本地更新、智能平仓选单
 * - 确保四条链路(启动重建、运行时更新、智能平仓、风控)口径一致
 *
 * 核心原则：
 * - 纯函数,无副作用
 * - 稳定排序,可复现
 * - 整笔语义,不拆分订单
 * - 价格解耦,卖出成交价不参与判定
 */
import type { OrderRecord } from '../../types/services.js';

/**
 * 比较两笔买单的卖出扣减优先级。
 *
 * @param left 左侧买单
 * @param right 右侧买单
 * @returns 负数表示 left 优先，正数表示 right 优先，零表示完全相同
 */
export function compareBuyOrdersBySellPriority(left: OrderRecord, right: OrderRecord): number {
  if (left.executedPrice !== right.executedPrice) {
    return left.executedPrice - right.executedPrice;
  }

  if (left.executedTime !== right.executedTime) {
    return left.executedTime - right.executedTime;
  }

  return left.orderId.localeCompare(right.orderId);
}

/**
 * 从买入订单列表中扣减卖出数量
 *
 * 算法逻辑：
 * 1. 按 executedPrice asc → executedTime asc → orderId asc 稳定排序
 * 2. 从低到高遍历,订单数量 <= 剩余扣减量则消除,否则整笔保留
 * 3. 返回剩余订单列表
 *
 * @param candidateBuyOrders 候选买入订单列表
 * @param sellQuantity 有限且严格大于零的卖出数量
 * @returns 扣减后剩余的买入订单列表
 * @throws 卖出数量非有限数或小于等于零时抛出内部契约错误
 */
export function deductSellQuantityFromBuyOrders(
  candidateBuyOrders: ReadonlyArray<OrderRecord>,
  sellQuantity: number,
): ReadonlyArray<OrderRecord> {
  if (!Number.isFinite(sellQuantity) || sellQuantity <= 0) {
    throw new Error(`[卖出扣减策略] 卖出数量必须为有限正数: ${sellQuantity}`);
  }

  if (candidateBuyOrders.length === 0) {
    return [];
  }

  // 稳定排序: executedPrice asc → executedTime asc → orderId asc
  const sortedOrders = [...candidateBuyOrders].sort(compareBuyOrdersBySellPriority);

  // 整笔扣减: 从低到高遍历,订单数量 <= 剩余扣减量则消除,否则整笔保留
  const remainingOrders: OrderRecord[] = [];
  let remainingDeduction = sellQuantity;

  for (const order of sortedOrders) {
    if (remainingDeduction <= 0) {
      // 扣减量已用完,保留剩余所有订单
      remainingOrders.push(order);
      continue;
    }

    if (order.executedQuantity <= remainingDeduction) {
      // 订单数量 <= 剩余扣减量,消除该订单
      remainingDeduction -= order.executedQuantity;
    } else {
      // 订单数量 > 剩余扣减量,整笔保留(不拆分)
      remainingOrders.push(order);
    }
  }

  return remainingOrders;
}
