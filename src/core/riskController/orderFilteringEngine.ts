/**
 * 订单过滤算法引擎
 *
 * 职责：
 * - 实现按卖出成交递进过滤未平仓买单的纯函数算法
 * - 供当日亏损回算共享使用
 */
import type { OrderFilteringEngine } from '../../types/risk.js';
import type { OrderRecord } from '../../types/services.js';
import type { FilteringState } from './types.js';
import { calculateTotalQuantity } from './orderRecords.js';
import { deductSellQuantityFromBuyOrders } from './sellDeductionPolicy.js';

/** 初始化过滤状态：拆出 M0（最新卖出时间之后成交的买入订单）与待过滤候选订单。 */
function initializeFilteringState(
  allBuyOrders: ReadonlyArray<OrderRecord>,
  sortedSellOrders: ReadonlyArray<OrderRecord>,
): FilteringState | null {
  const lastSellOrder = sortedSellOrders.at(-1);
  if (!lastSellOrder) {
    return null;
  }

  const latestSellTime = lastSellOrder.executedTime;
  const m0Orders: OrderRecord[] = [];
  const candidateOrders: OrderRecord[] = [];

  for (const buyOrder of allBuyOrders) {
    if (buyOrder.executedTime > latestSellTime) {
      m0Orders.push(buyOrder);
      continue;
    }

    candidateOrders.push(buyOrder);
  }

  return { m0Orders, candidateOrders };
}

/** 应用单个卖出订单过滤。 */
function applySingleSellOrderFilter(
  currentBuyOrders: ReadonlyArray<OrderRecord>,
  candidateOrders: ReadonlyArray<OrderRecord>,
  sellOrder: OrderRecord,
  nextSellOrder: OrderRecord | null,
  latestSellTime: number,
): ReadonlyArray<OrderRecord> {
  const sellTime = sellOrder.executedTime;
  const sellQuantity = sellOrder.executedQuantity;
  const nextSellTime = nextSellOrder ? nextSellOrder.executedTime : latestSellTime + 1;

  const buyOrdersBeforeSell = currentBuyOrders.filter(
    (buyOrder) => buyOrder.executedTime < sellTime,
  );
  const totalBuyQuantity = calculateTotalQuantity(buyOrdersBeforeSell);
  const buyOrdersBetweenSells = candidateOrders.filter(
    (buyOrder) => buyOrder.executedTime > sellTime && buyOrder.executedTime < nextSellTime,
  );

  if (sellQuantity >= totalBuyQuantity || buyOrdersBeforeSell.length === 0) {
    return [...buyOrdersBetweenSells];
  }

  const filteredBuyOrders = deductSellQuantityFromBuyOrders(buyOrdersBeforeSell, sellQuantity);
  return [...filteredBuyOrders, ...buyOrdersBetweenSells];
}

/** 依次应用每个卖出订单的过滤（从旧到新累积）。 */
function applySequentialFiltering(
  state: FilteringState,
  sortedSellOrders: ReadonlyArray<OrderRecord>,
): ReadonlyArray<OrderRecord> {
  const firstSellTime = sortedSellOrders[0]?.executedTime ?? 0;
  const latestSellTime = sortedSellOrders.at(-1)?.executedTime ?? 0;

  let currentBuyOrders: ReadonlyArray<OrderRecord> = state.candidateOrders.filter(
    (buyOrder) => buyOrder.executedTime < firstSellTime,
  );

  for (let index = 0; index < sortedSellOrders.length; index += 1) {
    const sellOrder = sortedSellOrders[index];
    if (!sellOrder) {
      continue;
    }

    currentBuyOrders = applySingleSellOrderFilter(
      currentBuyOrders,
      state.candidateOrders,
      sellOrder,
      sortedSellOrders[index + 1] ?? null,
      latestSellTime,
    );
  }

  return currentBuyOrders;
}

/** 按时间顺序处理卖出订单，返回当前仍持有的买入订单。 */
function applyFilteringAlgorithm(
  allBuyOrders: ReadonlyArray<OrderRecord>,
  filledSellOrders: ReadonlyArray<OrderRecord>,
): ReadonlyArray<OrderRecord> {
  const sortedSellOrders = [...filledSellOrders].sort(
    (left, right) => left.executedTime - right.executedTime,
  );
  if (sortedSellOrders.length === 0) {
    return allBuyOrders;
  }

  const state = initializeFilteringState(allBuyOrders, sortedSellOrders);
  if (!state) {
    return allBuyOrders;
  }

  const filteredOrders = applySequentialFiltering(state, sortedSellOrders);
  return [...state.m0Orders, ...filteredOrders];
}

/**
 * 创建订单过滤引擎。
 *
 * @returns OrderFilteringEngine 接口实例
 */
export function createOrderFilteringEngine(): OrderFilteringEngine {
  return {
    applyFilteringAlgorithm,
  };
}
