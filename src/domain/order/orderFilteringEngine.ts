/**
 * 订单过滤算法引擎
 *
 * 职责：
 * - 实现复杂的订单过滤算法（智能清仓决策）
 * - 无状态，纯函数式设计
 * - 易于单元测试
 *
 * 过滤算法（从旧到新累积过滤）：
 * 1. M0：成交时间 > 最新卖出订单时间的买入订单（无条件保留）
 * 2. 从最旧的卖出订单 D1 开始依次处理：
 *    - 获取成交时间 < D1 的买入订单
 *    - 若 D1 数量 >= 这些买入订单总量，视为全部卖出
 *    - 否则使用'低价优先整笔消除'策略扣减 D1 数量
 *    - M1 = 扣减结果 + 成交时间在 (D1, D2) 之间的买入订单（从原始候选订单获取）
 * 3. 对 D2 使用 M1 重复上述过程，得到 M2，以此类推
 * 4. 最终记录 = M0 + MN
 *
 * 关键约束：
 * - 必须按时间顺序从旧到新处理卖出订单
 * - 每轮过滤基于上一轮的结果（累积过滤）
 * - 时间间隔订单必须从原始候选订单获取，而非上一轮结果
 * - 使用'低价优先整笔消除'策略,不拆分订单
 */
import type { OrderRecord } from '../../types/orderRecorder.js';
import type { FilteringState } from './types.js';
import { deductSellQuantityFromBuyOrders } from './sellDeductionPolicy.js';
import { calculateTotalQuantity } from './orderQuantity.js';

/** 默认单轮扣减保持原整笔/总量预检规则，时间区间由共用过滤流程负责。 */
function deductBuyOrdersBeforeSell(
  buys: ReadonlyArray<OrderRecord>,
  sell: OrderRecord,
): ReadonlyArray<OrderRecord> {
  return sell.executedQuantity >= calculateTotalQuantity(buys) || buys.length === 0
    ? []
    : deductSellQuantityFromBuyOrders(buys, sell.executedQuantity);
}

/**
 * 初始化过滤状态：拆出 M0（最新卖出时间之后成交的买入订单）与待过滤候选订单。
 *
 * @param allBuyOrders 全部买入订单记录
 * @param sortedSellOrders 已按成交时间升序排列的卖出订单
 * @returns 含 m0Orders 与 candidateOrders 的 FilteringState；无卖出订单时返回 null
 */
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

/**
 * 应用单个卖出订单的过滤
 * 1. 获取成交时间 < 卖出时间的买入订单
 * 2. 将严格早于 SELL 的候选交给既有扣减策略
 * 3. 合并时间间隔内的订单作为下一轮输入；同毫秒 BUY 不进入任何区间
 */
function applySingleSellOrderFilter(
  currentBuyOrders: ReadonlyArray<OrderRecord>,
  candidateOrders: ReadonlyArray<OrderRecord>,
  sellOrder: OrderRecord,
  nextSellOrder: OrderRecord | null,
  latestSellTime: number,
  deduct: (
    buyOrders: ReadonlyArray<OrderRecord>,
    sellOrder: OrderRecord,
  ) => ReadonlyArray<OrderRecord>,
): ReadonlyArray<OrderRecord> {
  const sellTime = sellOrder.executedTime;

  const nextSellTime = nextSellOrder ? nextSellOrder.executedTime : latestSellTime + 1;

  const buyOrdersBeforeSell = currentBuyOrders.filter(
    (buyOrder) => buyOrder.executedTime < sellTime,
  );

  const buyOrdersBetweenSells = candidateOrders.filter(
    (buyOrder) => buyOrder.executedTime > sellTime && buyOrder.executedTime < nextSellTime,
  );

  const filteredBuyOrders = deduct(buyOrdersBeforeSell, sellOrder);

  return [...filteredBuyOrders, ...buyOrdersBetweenSells];
}

/**
 * 依次应用每个卖出订单的过滤（从旧到新累积）
 * 每轮基于上一轮结果过滤，时间间隔订单从原始候选获取
 */
function applySequentialFiltering(
  state: FilteringState,
  sortedSellOrders: ReadonlyArray<OrderRecord>,
  deduct: (
    buyOrders: ReadonlyArray<OrderRecord>,
    sellOrder: OrderRecord,
  ) => ReadonlyArray<OrderRecord>,
): ReadonlyArray<OrderRecord> {
  const firstSellTime = sortedSellOrders[0]?.executedTime ?? 0;
  const latestSellTime = sortedSellOrders.at(-1)?.executedTime ?? 0;

  let currentBuyOrders: ReadonlyArray<OrderRecord> = state.candidateOrders.filter(
    (buyOrder) => buyOrder.executedTime < firstSellTime,
  );

  for (let i = 0; i < sortedSellOrders.length; i++) {
    const sellOrder = sortedSellOrders[i];
    if (sellOrder) {
      currentBuyOrders = applySingleSellOrderFilter(
        currentBuyOrders,
        state.candidateOrders,
        sellOrder,
        sortedSellOrders[i + 1] ?? null,
        latestSellTime,
        deduct,
      );
    }
  }

  return currentBuyOrders;
}

/**
 * 复用原过滤算法的严格时间区间：同毫秒 BUY 不因输入顺序进入未平仓结果。
 * Recorder 的 clear/关联策略只影响扣减，不改变 Daily 与重建共用的时间口径。
 * @param allBuyOrders 全部买入投影输入
 * @param executedSellOrders 全部已消费 SELL 输入
 * @param deduct 单轮原扣减策略
 * @returns 按原时间区间与扣减策略得到的买入幸存输入
 */
export function applyFilteringAlgorithm(
  allBuyOrders: ReadonlyArray<OrderRecord>,
  executedSellOrders: ReadonlyArray<OrderRecord>,
  deduct: (
    buyOrders: ReadonlyArray<OrderRecord>,
    sellOrder: OrderRecord,
  ) => ReadonlyArray<OrderRecord> = deductBuyOrdersBeforeSell,
): ReadonlyArray<OrderRecord> {
  const sortedSellOrders = [...executedSellOrders].sort(
    (left, right) => left.executedTime - right.executedTime,
  );

  if (sortedSellOrders.length === 0) {
    return allBuyOrders;
  }

  const state = initializeFilteringState(allBuyOrders, sortedSellOrders);

  if (!state) {
    return allBuyOrders;
  }

  const filteredOrders = applySequentialFiltering(state, sortedSellOrders, deduct);

  return [...state.m0Orders, ...filteredOrders];
}
