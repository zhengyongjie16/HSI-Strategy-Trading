/**
 * 当日亏损追踪器模块
 *
 * 功能/职责：按唯一监控标的的 LONG/SHORT 方向累计已实现亏损偏移；内部基于当日成交订单与过滤算法（filteringEngine）计算未平仓买入成本。
 * 执行流程：调用方通过 recalculateFromAllOrders 或 recordCumulativeExecution 提供累计订单事实，通过 getLossOffset(direction) 获取当日亏损偏移；内部只维护唯一 monitor 的方向级状态。
 */
import { mergeBrokerOrderExecutionFact } from '../order/executionFact.js';
import type { BrokerOrderExecutionFact, OrderRecord } from '../../types/orderRecorder.js';
import type {
  DailyLossCumulativeExecutionInput,
  DailyLossCumulativeExecutionResult,
  DailyLossAuthoritativeFactSnapshot,
  DailyLossTracker,
  DailyLossTrackerDeps,
  DailyLossOrderSnapshot,
  DailyLossMonitorScope,
  StartNewProtectionEpisodeParams,
  PreparedDailyLossProtectionBoundary,
  PreparedDailyLossRecalculation,
} from '../../types/risk.js';

import {
  canonicalDecimal,
  exactAdd,
  exactCompare,
  exactMultiply,
  exactSubtract,
  safeQuantityNumber,
} from '../../utils/numeric/exact.js';
import type {
  DailyLossDirection,
  DailyLossDirectionStates,
  DailyLossExecutionSnapshot,
  DailyLossOrderBaseline,
  DailyLossOrderFact,
  DailyLossOwnedInDayExecution,
  DailyLossState,
} from './types.js';
import {
  collectOrderOwnershipDiagnostics,
  resolveHongKongDayKey,
  sumOrderCost,
} from './dailyLossRules.js';

/** OPEN 事实必须先于 TERMINAL 事实排序，保证同 identity 的终态覆盖开放态。 */
function compareFactStage(left: 'OPEN' | 'TERMINAL', right: 'OPEN' | 'TERMINAL'): number {
  if (left === right) {
    return 0;
  }

  return left === 'OPEN' ? -1 : 1;
}

/**
 * 选择不晚于保护边界的最新累计成交快照。
 * 优先级固定为执行时间、订单 revision、累计数量，数值完全相同时由 TERMINAL 覆盖 OPEN。
 */
function selectLatestExecutionSnapshotAtBoundary(
  snapshots: ReadonlyArray<DailyLossExecutionSnapshot>,
  boundaryExecutedTimeMs: number,
): DailyLossExecutionSnapshot | undefined {
  let selected: DailyLossExecutionSnapshot | undefined;
  for (const snapshot of snapshots) {
    if (snapshot.lastExecutionTimeMs > boundaryExecutedTimeMs) {
      continue;
    }

    if (
      selected === undefined ||
      snapshot.lastExecutionTimeMs > selected.lastExecutionTimeMs ||
      (snapshot.lastExecutionTimeMs === selected.lastExecutionTimeMs &&
        (snapshot.orderUpdatedAtMs > selected.orderUpdatedAtMs ||
          (snapshot.orderUpdatedAtMs === selected.orderUpdatedAtMs &&
            (snapshot.cumulativeQuantity > selected.cumulativeQuantity ||
              (snapshot.cumulativeQuantity === selected.cumulativeQuantity &&
                selected.factStage === 'OPEN' &&
                snapshot.factStage === 'TERMINAL')))))
    ) {
      selected = snapshot;
    }
  }

  return selected;
}

/**
 * 提取原始订单提交时间的可信毫秒值。
 * submittedAt 仅用于证明订单严格晚于保护边界创建；缺失、无效或非正值都不能构成该证明。
 */
function resolveTrustedSubmittedAtMs(submittedAt: Date | null | undefined): number | null {
  if (!(submittedAt instanceof Date)) {
    return null;
  }

  const submittedAtMs = submittedAt.getTime();
  if (!Number.isFinite(submittedAtMs) || submittedAtMs <= 0) {
    return null;
  }

  return submittedAtMs;
}

/**
 * 构建空状态，避免分支重复初始化。
 *
 * @returns 无买入/卖出订单、亏损偏移为 0 的 DailyLossState
 */
function createEmptyState(): DailyLossState {
  return {
    dailyLossOffset: '0',
  };
}

/**
 * 构建唯一 monitor 的双方向空状态。
 *
 * @returns LONG/SHORT 均为空的状态集合
 */
function createEmptyDirectionStates(): DailyLossDirectionStates {
  return {
    long: createEmptyState(),
    short: createEmptyState(),
  };
}

/**
 * 解析保护性清仓边界方向键。
 * @param key 输入边界键，格式为 LONG 或 SHORT
 * @returns 方向键
 */
function parseProtectionBoundaryDirectionKey(key: string): DailyLossDirection {
  if (key !== 'LONG' && key !== 'SHORT') {
    throw new Error(`[DailyLossTracker] protection boundary direction 非法: ${key}`);
  }

  return key;
}

/**
 * 计算当日盈亏偏移：realizedPnL = totalSell - (totalBuy - openBuyCost)。
 * 仅记录亏损偏移：当 realizedPnL > 0（当日盈利）时按 0 处理；负值表示当日亏损偏移。
 *
 * @param buyOrders 买入订单记录
 * @param sellOrders 卖出订单记录
 * @param filteringEngine 过滤引擎（用于计算未平仓买入成本）
 * @returns 当日亏损偏移（非正数，0 表示无亏损或盈利）
 */
function calculateLossOffsetFromRecords(
  buyOrders: ReadonlyArray<OrderRecord>,
  sellOrders: ReadonlyArray<OrderRecord>,
  filteringEngine: DailyLossTrackerDeps['filteringEngine'],
): string {
  if (buyOrders.length === 0 && sellOrders.length === 0) {
    return '0';
  }

  const totalBuy = sumOrderCost(buyOrders);
  const totalSell = sumOrderCost(sellOrders);
  if (exactCompare(totalBuy, '0') === 0 && exactCompare(totalSell, '0') === 0) {
    return '0';
  }

  const openBuyOrders =
    buyOrders.length > 0
      ? filteringEngine.applyFilteringAlgorithm([...buyOrders], [...sellOrders])
      : [];
  const openBuyCost = sumOrderCost(openBuyOrders);
  const realizedPnL = exactAdd(exactSubtract(totalSell, totalBuy), openBuyCost);
  return exactCompare(realizedPnL, '0') > 0 ? '0' : realizedPnL;
}

/**
 * 从 orderId 权威事实集合构建单方向状态并计算亏损偏移。
 *
 * @param facts 当日当前分段的累计成交事实
 * @param direction 目标方向
 * @param filteringEngine 过滤引擎
 * @returns 计算后的当日亏损偏移状态
 */
function buildStateFromFacts(
  facts: ReadonlyMap<string, DailyLossOrderFact>,
  baselines: ReadonlyMap<string, DailyLossOrderBaseline>,
  direction: DailyLossDirection,
  filteringEngine: DailyLossTrackerDeps['filteringEngine'],
): DailyLossState {
  const buyOrders: OrderRecord[] = [];
  const sellOrders: OrderRecord[] = [];
  for (const fact of facts.values()) {
    if (fact.direction !== direction) {
      continue;
    }

    const baseline = baselines.get(fact.orderId);
    const baselineQuantity = baseline?.cumulativeQuantity ?? 0;
    const baselineAmount = baseline?.cumulativeAmount ?? '0';
    const segmentQuantity = fact.cumulativeQuantity - baselineQuantity;
    if (!Number.isSafeInteger(segmentQuantity))
      throw new RangeError('[DailyLossTracker] segment quantity overflow');

    const segmentAmount = exactSubtract(fact.cumulativeAmount, baselineAmount);
    if (segmentQuantity <= 0) {
      continue;
    }

    if (exactCompare(segmentAmount, '0') <= 0) {
      throw new Error(
        `[DailyLossTracker] orderId=${fact.orderId} segment amount 非法: quantity=${segmentQuantity} amount=${segmentAmount}`,
      );
    }

    const record: OrderRecord = {
      orderId: fact.orderId,
      symbol: fact.symbol,
      costAmount: segmentAmount,
      executedQuantity: segmentQuantity,
      executedTime: fact.lastExecutionTimeMs,
    };
    if (fact.side === 'BUY') {
      buyOrders.push(record);
    } else {
      sellOrders.push(record);
    }
  }

  const dailyLossOffset = calculateLossOffsetFromRecords(buyOrders, sellOrders, filteringEngine);
  return {
    dailyLossOffset,
  };
}

/**
 * 基于候选订单事实构建单方向保护边界基线。
 * @param facts 候选累计成交事实
 * @param direction 目标方向
 * @param boundaryMs 保护性清仓完成时刻
 * @returns 对应方向的 per-order 累计成交基线
 */
function buildDirectionBaselines(
  facts: ReadonlyMap<string, DailyLossOrderFact>,
  direction: DailyLossDirection,
  boundaryMs: number,
): Map<string, DailyLossOrderBaseline> {
  const nextBaselines = new Map<string, DailyLossOrderBaseline>();
  for (const fact of facts.values()) {
    if (fact.direction !== direction) {
      continue;
    }

    const boundarySnapshot = selectLatestExecutionSnapshotAtBoundary(
      fact.executionSnapshots,
      boundaryMs,
    );

    if (boundarySnapshot) {
      nextBaselines.set(fact.orderId, {
        cumulativeQuantity: boundarySnapshot.cumulativeQuantity,
        cumulativeAmount: boundarySnapshot.cumulativeAmount,
      });
    }
  }

  return nextBaselines;
}

/**
 * 将成交回报转换为订单记录，若数据不完整则返回 null。
 *
 * @param input 成交回报（订单 ID、标的、成交价、成交量、成交时间等）
 * @returns 累计权威成交事实；价格、数量、执行时间或 revision 非法时返回 null
 */
function createOrderFactFromFill(
  input: DailyLossCumulativeExecutionInput,
): DailyLossOrderFact | null {
  const executedPrice = input.executedPrice;
  const executedQuantity = input.executedQuantity;
  const executedTime = input.executedTimeMs;
  const orderUpdatedAtMs = input.orderUpdatedAtMs;
  if (
    exactCompare(executedPrice, '0') <= 0 ||
    !Number.isSafeInteger(executedQuantity) ||
    executedQuantity <= 0 ||
    !Number.isSafeInteger(executedTime) ||
    executedTime <= 0 ||
    !Number.isSafeInteger(orderUpdatedAtMs) ||
    orderUpdatedAtMs <= 0
  ) {
    return null;
  }

  const cumulativeAmount = exactMultiply(executedPrice, String(executedQuantity));
  return {
    orderId: input.orderId,
    symbol: input.symbol,
    direction: input.direction,
    side: input.side,
    submittedAtMs: null,
    factStage: input.factStage,
    cumulativeQuantity: executedQuantity,
    cumulativeAmount,
    lastExecutionTimeMs: executedTime,
    orderUpdatedAtMs,
    executionSnapshots: [
      {
        factStage: input.factStage,
        cumulativeQuantity: executedQuantity,
        cumulativeAmount,
        lastExecutionTimeMs: executedTime,
        orderUpdatedAtMs,
      },
    ],
    historyCompleteFromZero: true,
  };
}

/**
 * 将原始订单中的累计成交转换为权威事实。
 *
 * @param order 原始 API 订单
 * @param direction 已解析的订单方向
 * @param classifyAndConvertOrders 订单转换依赖
 * @returns 有效累计成交事实；无有效成交时返回 null
 */
function createOrderFactFromRawOrder(
  order: DailyLossOrderSnapshot,
  direction: DailyLossDirection,
  classifyAndConvertOrders: DailyLossTrackerDeps['classifyAndConvertOrders'],
): DailyLossOrderFact | null {
  if (!['BUY', 'SELL'].includes(order.executionSide)) {
    return null;
  }

  if (!(order.updatedAt instanceof Date)) {
    return null;
  }

  const converted = classifyAndConvertOrders([order]);
  const record = order.executionSide === 'BUY' ? converted.buyOrders[0] : converted.sellOrders[0];
  if (!record) {
    return null;
  }

  const cumulativeAmount = record.costAmount;
  const orderUpdatedAtMs = order.updatedAtMs;
  return {
    orderId: record.orderId,
    direction,
    symbol: record.symbol,
    side: order.executionSide,
    submittedAtMs: resolveTrustedSubmittedAtMs(order.submittedAt),
    factStage: order.executionPhase,
    cumulativeQuantity: record.executedQuantity,
    cumulativeAmount,
    lastExecutionTimeMs: record.executedTime,
    orderUpdatedAtMs,
    executionSnapshots: [
      {
        factStage: order.executionPhase,
        cumulativeQuantity: record.executedQuantity,
        cumulativeAmount,
        lastExecutionTimeMs: record.executedTime,
        orderUpdatedAtMs,
      },
    ],
    historyCompleteFromZero: false,
  };
}

/** 同一 orderId 的方向、买卖侧与标的必须永久一致。 */
function assertMatchingOrderIdentity(
  current: DailyLossOrderFact,
  incoming: DailyLossOrderFact,
): void {
  if (
    current.direction === incoming.direction &&
    current.side === incoming.side &&
    current.symbol === incoming.symbol
  ) {
    return;
  }

  throw new Error(
    `[DailyLossTracker] orderId=${incoming.orderId} identity mismatch: ` +
      `current=${current.direction}/${current.side}/${current.symbol} ` +
      `incoming=${incoming.direction}/${incoming.side}/${incoming.symbol}`,
  );
}

/**
 * 按“订单更新时间 + 累计成交进度”合并权威事实。
 * 同一更新时间仍可能连续收到更大的累计成交量；只有等量且金额一致才幂等，等量金额冲突或累计事实倒退必须阻断。
 */
/** 将已归属日损事实交给共享累计量/revision/phase 裁决，不维护第二套合并政策。 */
function dailyLossFactToBroker(fact: DailyLossOrderFact): BrokerOrderExecutionFact {
  return {
    brokerOrderId: fact.orderId,
    symbol: fact.symbol,
    side: fact.side,
    cumulativeQuantity: fact.cumulativeQuantity,
    cumulativeAmount: fact.cumulativeAmount,
    executionTimeMs: fact.lastExecutionTimeMs,
    updatedAtMs: fact.orderUpdatedAtMs,
    phase: fact.factStage,
  };
}

function resolveAuthoritativeOrderFactMerge(
  current: DailyLossOrderFact | undefined,
  incoming: DailyLossOrderFact,
): Readonly<{
  result: DailyLossCumulativeExecutionResult;
  nextFact: DailyLossOrderFact | null;
}> {
  if (current !== undefined) assertMatchingOrderIdentity(current, incoming);

  const previous = current === undefined ? undefined : dailyLossFactToBroker(current);
  const merged = mergeBrokerOrderExecutionFact(previous, dailyLossFactToBroker(incoming));
  if (merged === previous) {
    return {
      result: { admission: 'DUPLICATE', authoritativeFactChanged: false, executionAdvanced: false },
      nextFact: null,
    };
  }

  const executionAdvanced =
    current === undefined || merged.cumulativeQuantity > current.cumulativeQuantity;
  if (merged.executionTimeMs === null) {
    throw new Error('[DailyLossTracker] admitted execution is missing trusted time');
  }

  const snapshot: DailyLossExecutionSnapshot = {
    factStage: merged.phase,
    cumulativeQuantity: merged.cumulativeQuantity,
    cumulativeAmount: merged.cumulativeAmount,
    lastExecutionTimeMs: merged.executionTimeMs,
    orderUpdatedAtMs: merged.updatedAtMs,
  };
  let snapshots: ReadonlyArray<DailyLossExecutionSnapshot>;
  if (current === undefined) {
    snapshots = [snapshot];
  } else if (executionAdvanced) {
    snapshots = [...current.executionSnapshots, snapshot];
  } else {
    snapshots = current.executionSnapshots.map((item, index, items) =>
      index === items.length - 1 ? snapshot : item,
    );
  }

  return {
    result: { admission: 'ADMITTED', authoritativeFactChanged: true, executionAdvanced },
    nextFact: {
      ...incoming,
      cumulativeAmount: merged.cumulativeAmount,
      factStage: merged.phase,
      lastExecutionTimeMs: merged.executionTimeMs,
      orderUpdatedAtMs: merged.updatedAtMs,
      executionSnapshots: snapshots,
    },
  };
}

/**
 * 判断 API 原始订单是否包含有效成交事实。
 * @param order API 原始订单
 * @returns 成交价与成交量均有效时返回 true
 */
function hasValidExecution(order: DailyLossOrderSnapshot): boolean {
  return (
    Number.isSafeInteger(order.executedQuantity) &&
    order.executedQuantity > 0 &&
    exactCompare(order.executedAmount, '0') > 0
  );
}

/**
 * 提取 RawOrder 的可信更新时间。
 * updatedAt 是启动重建中唯一可用于判定成交归属交易日与权威 revision 的时间，缺失、无效或非正值都不能继续计算亏损偏移。
 */
function resolveTrustedOrderUpdatedAt(updatedAt: Date | null | undefined): Date | null {
  if (!(updatedAt instanceof Date)) {
    return null;
  }

  const updatedAtMs = updatedAt.getTime();
  if (!Number.isFinite(updatedAtMs) || updatedAtMs <= 0) {
    return null;
  }

  return updatedAt;
}

/**
 * 相关交易标的的当日成交订单无法归属时直接阻断恢复，避免低估风控偏移。
 * @param params 订单、监控配置与相关交易标的集合
 */
function assertUnownedOrderIsNotRelevant(params: {
  readonly order: DailyLossOrderSnapshot;
  readonly monitor: Pick<DailyLossMonitorScope, 'monitorSymbol'>;
  readonly relatedTradingSymbols: ReadonlySet<string> | undefined;
}): void {
  const { order, monitor, relatedTradingSymbols } = params;
  if (!relatedTradingSymbols?.has(order.symbol)) {
    return;
  }

  if (!hasValidExecution(order)) {
    return;
  }

  throw new Error(
    `[DailyLossTracker] 相关成交订单无法归属: monitorSymbol=${monitor.monitorSymbol} symbol=${order.symbol} orderId=${order.orderId}`,
  );
}

/**
 * 在任何 tracker 状态写入前，筛选可安全参与当日亏损重算的已成交订单。
 * 有效 BUY/SELL 成交必须先完成当前唯一 monitor 归属解析：相关但不可归属的数据直接阻断；
 * 可归属订单必须有可信 updatedAt，只有已知为非当日的历史成交才可跳过。
 */
function collectOwnedInDayExecutionsForRecalculation(params: {
  readonly allOrders: ReadonlyArray<DailyLossOrderSnapshot>;
  readonly monitor: DailyLossMonitorScope;
  readonly currentDayKey: string | null;
  readonly relatedTradingSymbols: ReadonlySet<string> | undefined;
  readonly resolveOrderOwnership: DailyLossTrackerDeps['resolveOrderOwnership'];
  readonly toHongKongTimeIso: DailyLossTrackerDeps['toHongKongTimeIso'];
}): ReadonlyArray<DailyLossOwnedInDayExecution> {
  const {
    allOrders,
    monitor,
    currentDayKey,
    relatedTradingSymbols,
    resolveOrderOwnership,
    toHongKongTimeIso,
  } = params;
  const ownedInDayExecutions: DailyLossOwnedInDayExecution[] = [];

  for (const order of allOrders) {
    if (!['BUY', 'SELL'].includes(order.executionSide) || !hasValidExecution(order)) {
      continue;
    }

    const ownership = resolveOrderOwnership(order, monitor);
    if (!ownership) {
      assertUnownedOrderIsNotRelevant({
        order,
        monitor,
        relatedTradingSymbols,
      });
      continue;
    }

    if (ownership.monitorSymbol !== monitor.monitorSymbol) {
      throw new Error(
        `[DailyLossTracker] order ownership monitorSymbol mismatch: expected=${monitor.monitorSymbol} actual=${ownership.monitorSymbol}`,
      );
    }

    const trustedUpdatedAt = resolveTrustedOrderUpdatedAt(order.updatedAt);
    if (trustedUpdatedAt === null) {
      throw new Error(
        `[DailyLossTracker] 已成交订单缺少有效更新时间: ` +
          `monitorSymbol=${monitor.monitorSymbol} symbol=${order.symbol} orderId=${order.orderId}`,
      );
    }

    if (currentDayKey === null) {
      throw new Error('[DailyLossTracker] 当前交易日无法解析，无法重算已成交订单');
    }

    if (
      order.executionTimeMs === null ||
      !Number.isSafeInteger(order.executionTimeMs) ||
      order.executionTimeMs <= 0
    ) {
      throw new Error(`[DailyLossTracker] 已成交订单缺少可信真实 execution time: ${order.orderId}`);
    }

    const orderDayKey = resolveHongKongDayKey(toHongKongTimeIso, new Date(order.executionTimeMs));
    if (orderDayKey === null) {
      throw new Error(
        `[DailyLossTracker] 已成交订单无法解析香港交易日: ` +
          `monitorSymbol=${monitor.monitorSymbol} symbol=${order.symbol} orderId=${order.orderId}`,
      );
    }

    if (orderDayKey !== currentDayKey) {
      continue;
    }

    ownedInDayExecutions.push({ order, direction: ownership.direction });
  }

  return ownedInDayExecutions;
}

/**
 * 创建当日亏损追踪器实例。
 * 按唯一 monitor 的 LONG/SHORT 方向维护当日买入/卖出订单与亏损偏移，支持 resetAll、全量重算、累计成交合并与事务化保护边界。
 * 风控与浮亏计算依赖当日已实现盈亏偏移，需在跨日时重置、启动或 SEAT_REFRESH 时通过全量订单重算、成交时增量更新。
 * @param deps 依赖（filteringEngine、resolveOrderOwnership、classifyAndConvertOrders、toHongKongTimeIso、onOwnershipWarning）
 * @returns 实现 DailyLossTracker 接口的实例
 */
export function createDailyLossTracker(deps: DailyLossTrackerDeps): DailyLossTracker {
  let dayKey: string | null = null;
  let statesByDirection = createEmptyDirectionStates();
  let filledOrderFactsById = new Map<string, DailyLossOrderFact>();
  let baselinesByDirection = {
    long: new Map<string, DailyLossOrderBaseline>(),
    short: new Map<string, DailyLossOrderBaseline>(),
  };

  /** 最新已完成保护性清仓边界：仅计入 executedTimeMs > boundary 的成交。 */
  let latestProtectionBoundaryByDirection = new Map<DailyLossDirection, number>();

  // 仅用于候选的新鲜度与发行者校验；不暴露或复制金融状态。
  let stateIdentity = {};
  const preparedPublishers = new WeakMap<PreparedDailyLossRecalculation, () => void>();

  /**
   * 显式重置 dayKey、states 与分段元数据。
   */
  function resetAll(now: Date): void {
    const nextKey = resolveHongKongDayKey(deps.toHongKongTimeIso, now);
    stateIdentity = {};
    dayKey = nextKey;
    statesByDirection = createEmptyDirectionStates();
    filledOrderFactsById = new Map<string, DailyLossOrderFact>();
    baselinesByDirection = {
      long: new Map<string, DailyLossOrderBaseline>(),
      short: new Map<string, DailyLossOrderBaseline>(),
    };
    latestProtectionBoundaryByDirection.clear();
  }

  function getDirectionBaselines(
    direction: DailyLossDirection,
  ): Map<string, DailyLossOrderBaseline> {
    return direction === 'LONG' ? baselinesByDirection.long : baselinesByDirection.short;
  }

  /**
   * 全量重算使用真实 executionTimeMs 与独立 updatedAtMs；缺可信执行时间直接拒绝。
   * 可信 execution 流水/durable 匹配由输入 owner 完成，不能以订单 revision 洗白旧执行事实。
   * protectionBoundaryByDirection 可选：按方向键恢复唯一 monitor 的方向级保护性边界。
   * 订单事实合并、边界基线、诊断与双方向状态均先在局部 candidate 完成；任一失败不得改写现有运行态。
   */
  function prepareRecalculationFromAllOrders(
    allOrders: ReadonlyArray<DailyLossOrderSnapshot>,
    monitor: DailyLossMonitorScope,
    now: Date,
    protectionBoundaryByDirection?: ReadonlyMap<'LONG' | 'SHORT', number>,
    relatedTradingSymbols?: ReadonlySet<string>,
  ): PreparedDailyLossRecalculation {
    const sourceStateIdentity = stateIdentity;
    const nextKey = resolveHongKongDayKey(deps.toHongKongTimeIso, now);
    const ownedInDayExecutions = collectOwnedInDayExecutionsForRecalculation({
      allOrders,
      monitor,
      currentDayKey: nextKey,
      relatedTradingSymbols,
      resolveOrderOwnership: deps.resolveOrderOwnership,
      toHongKongTimeIso: deps.toHongKongTimeIso,
    });
    const previousDayKey = dayKey;
    const isSameTradingDay = previousDayKey !== null && previousDayKey === nextKey;
    const previousFactsById = filledOrderFactsById;
    const preserveSameDaySegment = isSameTradingDay && protectionBoundaryByDirection === undefined;
    let nextFactsById = filledOrderFactsById;
    let nextProtectionBoundaryByDirection = new Map(latestProtectionBoundaryByDirection);
    let nextBaselinesByDirection = {
      long: baselinesByDirection.long,
      short: baselinesByDirection.short,
    };
    let nextStatesByDirection = createEmptyDirectionStates();
    let ownershipWarning: string | null = null;

    // 边界来源优先级：
    // 1) 显式传入（启动恢复）；
    // 2) 同日重算沿用当前运行态边界（如 SEAT_REFRESH）；
    // 3) 跨日重算清空边界，避免旧日边界泄漏。
    if (protectionBoundaryByDirection) {
      nextProtectionBoundaryByDirection = new Map<DailyLossDirection, number>();
      nextBaselinesByDirection = {
        long: new Map<string, DailyLossOrderBaseline>(),
        short: new Map<string, DailyLossOrderBaseline>(),
      };

      for (const [key, boundaryMs] of protectionBoundaryByDirection) {
        if (!Number.isFinite(boundaryMs) || boundaryMs <= 0) {
          continue;
        }

        const direction = parseProtectionBoundaryDirectionKey(key);
        nextProtectionBoundaryByDirection.set(direction, boundaryMs);
      }
    } else if (!isSameTradingDay) {
      nextProtectionBoundaryByDirection = new Map<DailyLossDirection, number>();
      nextBaselinesByDirection = {
        long: new Map<string, DailyLossOrderBaseline>(),
        short: new Map<string, DailyLossOrderBaseline>(),
      };
    }

    if (nextKey) {
      nextFactsById = new Map<string, DailyLossOrderFact>();
      for (const { order, direction } of ownedInDayExecutions) {
        const fact = createOrderFactFromRawOrder(order, direction, deps.classifyAndConvertOrders);
        if (fact) {
          const previousFact = preserveSameDaySegment
            ? previousFactsById.get(fact.orderId)
            : undefined;
          if (previousFact) {
            nextFactsById.set(fact.orderId, previousFact);
          }

          const merged = resolveAuthoritativeOrderFactMerge(nextFactsById.get(fact.orderId), fact);
          if (merged.nextFact !== null) {
            nextFactsById.set(fact.orderId, merged.nextFact);
          }
        }
      }

      for (const [direction, boundaryMs] of nextProtectionBoundaryByDirection) {
        const nextBaselines = buildDirectionBaselines(nextFactsById, direction, boundaryMs);
        nextBaselinesByDirection =
          direction === 'LONG'
            ? { long: nextBaselines, short: nextBaselinesByDirection.short }
            : { long: nextBaselinesByDirection.long, short: nextBaselines };
      }

      const diagnostics = collectOrderOwnershipDiagnostics({
        orders: allOrders,
        monitor,
        now,
        resolveOrderOwnership: deps.resolveOrderOwnership,
        toHongKongTimeIso: deps.toHongKongTimeIso,
        maxSamples: 3,
      });
      if (diagnostics && diagnostics.unmatchedFilled > 0) {
        const sampleText = diagnostics.unmatchedSamples
          .map((sample) => `${sample.symbol}:${sample.stockName}`)
          .join(' | ');
        ownershipWarning =
          `[日内亏损追踪] 未归属订单: 当日成交${diagnostics.inDayFilled}笔, ` +
          `未归属${diagnostics.unmatchedFilled}笔, 样例=${sampleText}`;
      }

      nextStatesByDirection = {
        long: buildStateFromFacts(
          nextFactsById,
          nextBaselinesByDirection.long,
          'LONG',
          deps.filteringEngine,
        ),
        short: buildStateFromFacts(
          nextFactsById,
          nextBaselinesByDirection.short,
          'SHORT',
          deps.filteringEngine,
        ),
      };
    }

    if (ownershipWarning !== null) {
      deps.onOwnershipWarning(ownershipWarning);
    }

    const prepared: PreparedDailyLossRecalculation = Object.freeze({
      isCurrent: () => stateIdentity === sourceStateIdentity,
    });
    preparedPublishers.set(prepared, () => {
      if (stateIdentity !== sourceStateIdentity) {
        throw new Error('[DailyLossTracker] recalculation candidate is stale or already published');
      }

      stateIdentity = {};
      dayKey = nextKey;
      filledOrderFactsById = nextFactsById;
      latestProtectionBoundaryByDirection = nextProtectionBoundaryByDirection;
      baselinesByDirection = nextBaselinesByDirection;
      statesByDirection = nextStatesByDirection;
    });
    return prepared;
  }

  /** 仅本实例发行的候选可以进入同步发布段；不调用外部提供的授权或发布函数。 */
  function publishRecalculation(prepared: PreparedDailyLossRecalculation): void {
    const publish = preparedPublishers.get(prepared);
    if (publish === undefined) {
      throw new Error('[DailyLossTracker] recalculation candidate was not issued by this owner');
    }

    publish();
  }

  function setDirectionState(direction: DailyLossDirection, nextState: DailyLossState): void {
    if (direction === 'LONG') {
      statesByDirection = {
        long: nextState,
        short: statesByDirection.short,
      };
      return;
    }

    statesByDirection = {
      long: statesByDirection.long,
      short: nextState,
    };
  }

  function recalculateDirectionState(direction: DailyLossDirection): void {
    setDirectionState(
      direction,
      buildStateFromFacts(
        filledOrderFactsById,
        getDirectionBaselines(direction),
        direction,
        deps.filteringEngine,
      ),
    );
  }

  /**
   * 使用完整订单全量重算状态，供启动恢复或 SEAT_REFRESH 纠偏使用。
   * protectionBoundaryByDirection 可选：提供保护性边界以重建 per-order 分段基线。
   */
  function recalculateFromAllOrders(
    allOrders: ReadonlyArray<DailyLossOrderSnapshot>,
    monitor: DailyLossMonitorScope,
    now: Date,
    protectionBoundaryByDirection?: ReadonlyMap<'LONG' | 'SHORT', number>,
    relatedTradingSymbols?: ReadonlySet<string>,
  ): void {
    const prepared = prepareRecalculationFromAllOrders(
      allOrders,
      monitor,
      now,
      protectionBoundaryByDirection,
      relatedTradingSymbols,
    );
    publishRecalculation(prepared);
  }

  /**
   * 按 orderId 幂等合并累计成交事实并更新亏损偏移。
   * dayKey 由 lifecycle riskDomain.midnightClear 通过 resetAll 统一驱动，此处只接纳当日累计事实。
   * 已存在保护边界时，合并后按执行快照刷新 per-order baseline，再投影新段增量。
   * 未封存的重复事实仍执行 durable 回调；经济去重不能证明保护性进度已经落盘。
   */
  function recordCumulativeExecution(
    input: DailyLossCumulativeExecutionInput,
    beforeAuthoritativeFactCommit?: (snapshot: DailyLossAuthoritativeFactSnapshot) => void,
  ): DailyLossCumulativeExecutionResult {
    if (!dayKey) {
      return { admission: 'SUPPRESSED', authoritativeFactChanged: false, executionAdvanced: false };
    }

    const fillDayKey = resolveHongKongDayKey(
      deps.toHongKongTimeIso,
      new Date(input.executedTimeMs),
    );
    if (fillDayKey !== dayKey) {
      return { admission: 'SUPPRESSED', authoritativeFactChanged: false, executionAdvanced: false };
    }

    const directionKey = input.direction;
    const incomingFact = createOrderFactFromFill(input);
    if (!incomingFact) {
      return { admission: 'SUPPRESSED', authoritativeFactChanged: false, executionAdvanced: false };
    }

    const currentBoundary = latestProtectionBoundaryByDirection.get(directionKey);
    if (currentBoundary !== undefined && incomingFact.lastExecutionTimeMs <= currentBoundary) {
      return { admission: 'SUPPRESSED', authoritativeFactChanged: false, executionAdvanced: false };
    }

    const currentFact = filledOrderFactsById.get(input.orderId);
    if (currentFact) {
      assertMatchingOrderIdentity(currentFact, incomingFact);
    }

    const merge = resolveAuthoritativeOrderFactMerge(currentFact, incomingFact);
    if (!merge.result.authoritativeFactChanged || merge.nextFact === null) {
      if (currentFact !== undefined)
        beforeAuthoritativeFactCommit?.({
          factStage: currentFact.factStage,
          cumulativeQuantity: String(currentFact.cumulativeQuantity),
          cumulativeAmount: currentFact.cumulativeAmount,
          lastExecutionTimeMs: currentFact.lastExecutionTimeMs,
          orderRevisionMs: currentFact.orderUpdatedAtMs,
        });

      return merge.result;
    }

    if (currentBoundary !== undefined && merge.nextFact.lastExecutionTimeMs <= currentBoundary) {
      return { admission: 'SUPPRESSED', authoritativeFactChanged: false, executionAdvanced: false };
    }

    const economicInputChanged =
      merge.nextFact.cumulativeQuantity !== currentFact?.cumulativeQuantity ||
      exactCompare(merge.nextFact.cumulativeAmount, currentFact.cumulativeAmount) !== 0 ||
      merge.nextFact.lastExecutionTimeMs !== currentFact.lastExecutionTimeMs ||
      merge.nextFact.factStage !== currentFact.factStage;
    const candidateFacts = new Map(filledOrderFactsById);
    candidateFacts.set(input.orderId, merge.nextFact);
    const candidateBaselines =
      currentBoundary === undefined || !economicInputChanged
        ? getDirectionBaselines(directionKey)
        : buildDirectionBaselines(candidateFacts, directionKey, currentBoundary);
    // revision-only 只抬高权威冲突水位，不重新过滤或发布亏损投影。
    const candidateState = economicInputChanged
      ? buildStateFromFacts(candidateFacts, candidateBaselines, directionKey, deps.filteringEngine)
      : null;
    beforeAuthoritativeFactCommit?.({
      factStage: merge.nextFact.factStage,
      cumulativeQuantity: String(merge.nextFact.cumulativeQuantity),
      cumulativeAmount: merge.nextFact.cumulativeAmount,
      lastExecutionTimeMs: merge.nextFact.lastExecutionTimeMs,
      orderRevisionMs: merge.nextFact.orderUpdatedAtMs,
    });
    stateIdentity = {};
    filledOrderFactsById = candidateFacts;
    if (currentBoundary !== undefined) {
      baselinesByDirection =
        directionKey === 'LONG'
          ? { long: candidateBaselines, short: baselinesByDirection.short }
          : { long: baselinesByDirection.long, short: candidateBaselines };
    }

    if (candidateState !== null) setDirectionState(directionKey, candidateState);

    return merge.result;
  }

  /** 将正式 progress record 恢复为历史 execution snapshot，不覆盖 RawOrder 当前权威终态。 */
  function restoreExecutionSnapshot(
    params: Parameters<DailyLossTracker['restoreExecutionSnapshot']>[0],
  ): void {
    const fact = filledOrderFactsById.get(params.orderId);
    if (fact === undefined) {
      throw new Error(`[DailyLossTracker] execution progress order missing: ${params.orderId}`);
    }

    if (
      fact.direction !== params.direction ||
      fact.symbol !== params.symbol ||
      fact.side !== params.side
    ) {
      throw new Error(`[DailyLossTracker] execution progress identity conflict: ${params.orderId}`);
    }

    const cumulativeQuantity = safeQuantityNumber(params.cumulativeQuantity);
    const cumulativeAmount = canonicalDecimal(params.cumulativeAmount);
    if (
      cumulativeQuantity > fact.cumulativeQuantity ||
      exactCompare(cumulativeAmount, fact.cumulativeAmount) > 0 ||
      params.orderRevisionMs > fact.orderUpdatedAtMs
    ) {
      throw new Error(
        `[DailyLossTracker] execution progress exceeds current fact: ${params.orderId}`,
      );
    }

    const sameIdentity = fact.executionSnapshots.find(
      (snapshot) =>
        snapshot.factStage === params.factStage &&
        snapshot.orderUpdatedAtMs === params.orderRevisionMs &&
        snapshot.cumulativeQuantity === cumulativeQuantity &&
        snapshot.lastExecutionTimeMs === params.lastExecutionTimeMs,
    );
    if (sameIdentity !== undefined) {
      if (exactCompare(sameIdentity.cumulativeAmount, cumulativeAmount) !== 0) {
        throw new Error(
          `[DailyLossTracker] execution progress snapshot conflict: ${params.orderId}`,
        );
      }

      return;
    }

    const executionSnapshots = [
      ...fact.executionSnapshots,
      {
        factStage: params.factStage,
        cumulativeQuantity,
        cumulativeAmount,
        lastExecutionTimeMs: params.lastExecutionTimeMs,
        orderUpdatedAtMs: params.orderRevisionMs,
      },
    ].sort(
      (left, right) =>
        left.lastExecutionTimeMs - right.lastExecutionTimeMs ||
        left.orderUpdatedAtMs - right.orderUpdatedAtMs ||
        left.cumulativeQuantity - right.cumulativeQuantity ||
        compareFactStage(left.factStage, right.factStage),
    );
    stateIdentity = {};
    filledOrderFactsById.set(params.orderId, { ...fact, executionSnapshots });
  }

  /**
   * 获取指定标的与方向的当日亏损偏移。
   */
  function getLossOffset(direction: 'LONG' | 'SHORT'): string {
    return direction === 'LONG'
      ? statesByDirection.long.dailyLossOffset
      : statesByDirection.short.dailyLossOffset;
  }

  /** 冻结边界时的 per-order baseline；无法从折叠快照精确还原时直接阻断。 */
  function prepareProtectionBoundary({
    direction,
    boundaryExecutedTimeMs,
  }: StartNewProtectionEpisodeParams): PreparedDailyLossProtectionBoundary {
    if (!Number.isFinite(boundaryExecutedTimeMs) || boundaryExecutedTimeMs <= 0) {
      throw new TypeError('[DailyLossTracker] protection boundary 无效');
    }

    const currentBoundary = latestProtectionBoundaryByDirection.get(direction);
    if (currentBoundary !== undefined && boundaryExecutedTimeMs <= currentBoundary) {
      throw new Error('[DailyLossTracker] protection boundary 未向前推进');
    }

    const orderBaselines: PreparedDailyLossProtectionBoundary['orderBaselines'][number][] = [];
    for (const fact of filledOrderFactsById.values()) {
      if (fact.direction !== direction) {
        continue;
      }

      const boundarySnapshot = selectLatestExecutionSnapshotAtBoundary(
        fact.executionSnapshots,
        boundaryExecutedTimeMs,
      );

      if (boundarySnapshot === undefined) {
        if (!fact.historyCompleteFromZero && fact.lastExecutionTimeMs > boundaryExecutedTimeMs) {
          throw new Error(
            `[DailyLossTracker] orderId=${fact.orderId} 无法精确冻结 protection boundary baseline`,
          );
        }

        continue;
      }

      orderBaselines.push({
        orderId: fact.orderId,
        symbol: fact.symbol,
        side: fact.side,
        cumulativeQuantity: String(boundarySnapshot.cumulativeQuantity),
        cumulativeAmount: boundarySnapshot.cumulativeAmount,
        lastExecutionTimeMs: boundarySnapshot.lastExecutionTimeMs,
        orderRevisionMs: boundarySnapshot.orderUpdatedAtMs,
      });
    }

    orderBaselines.sort((left, right) => left.orderId.localeCompare(right.orderId));
    return { direction, boundaryExecutedTimeMs, orderBaselines };
  }

  /** 提交已持久化的保护边界。 */
  function commitProtectionBoundary(prepared: PreparedDailyLossProtectionBoundary): void {
    stateIdentity = {};
    latestProtectionBoundaryByDirection.set(prepared.direction, prepared.boundaryExecutedTimeMs);
    const nextBaselines = new Map<string, DailyLossOrderBaseline>();
    for (const baseline of prepared.orderBaselines) {
      nextBaselines.set(baseline.orderId, {
        cumulativeQuantity: safeQuantityNumber(baseline.cumulativeQuantity),
        cumulativeAmount: canonicalDecimal(baseline.cumulativeAmount),
      });
    }

    baselinesByDirection =
      prepared.direction === 'LONG'
        ? { long: nextBaselines, short: baselinesByDirection.short }
        : { long: baselinesByDirection.long, short: nextBaselines };

    recalculateDirectionState(prepared.direction);
  }

  /**
   * 严格校验持久化 baseline 的订单身份与累计事实单调性后恢复边界。
   * 只有未持久化且历史折叠的 RawOrder，才能以可信 submittedAt 严格晚于边界证明零基线；
   * 已持久化 baseline 继续由身份、时间与累计单调性校验恢复。
   */
  function restoreProtectionBoundary(prepared: PreparedDailyLossProtectionBoundary): void {
    const persistedByOrderId = new Map(
      prepared.orderBaselines.map((baseline) => [baseline.orderId, baseline] as const),
    );
    if (persistedByOrderId.size !== prepared.orderBaselines.length) {
      throw new Error('[DailyLossTracker] duplicate persisted baseline identity');
    }

    for (const fact of filledOrderFactsById.values()) {
      if (fact.direction !== prepared.direction) {
        continue;
      }

      const boundarySnapshot = selectLatestExecutionSnapshotAtBoundary(
        fact.executionSnapshots,
        prepared.boundaryExecutedTimeMs,
      );

      const persisted = persistedByOrderId.get(fact.orderId);
      if (boundarySnapshot === undefined) {
        if (persisted !== undefined && fact.historyCompleteFromZero) {
          throw new Error(`[DailyLossTracker] unexpected persisted baseline: ${fact.orderId}`);
        }

        if (
          persisted === undefined &&
          !fact.historyCompleteFromZero &&
          (fact.submittedAtMs === null || fact.submittedAtMs <= prepared.boundaryExecutedTimeMs)
        ) {
          throw new Error(
            `[DailyLossTracker] cannot reconstruct protection boundary baseline: ` +
              `orderId=${fact.orderId}`,
          );
        }

        continue;
      }

      if (persisted === undefined) {
        throw new Error(`[DailyLossTracker] persisted baseline set incomplete: ${fact.orderId}`);
      }

      if (
        safeQuantityNumber(persisted.cumulativeQuantity) !== boundarySnapshot.cumulativeQuantity ||
        exactCompare(persisted.cumulativeAmount, boundarySnapshot.cumulativeAmount) !== 0 ||
        persisted.lastExecutionTimeMs !== boundarySnapshot.lastExecutionTimeMs ||
        persisted.orderRevisionMs !== boundarySnapshot.orderUpdatedAtMs
      ) {
        throw new Error(
          `[DailyLossTracker] persisted baseline does not match boundary fact: ${fact.orderId}`,
        );
      }
    }

    for (const baseline of prepared.orderBaselines) {
      if (baseline.lastExecutionTimeMs > prepared.boundaryExecutedTimeMs) {
        throw new Error(
          `[DailyLossTracker] unexpected persisted baseline after boundary: ${baseline.orderId}`,
        );
      }

      const fact = filledOrderFactsById.get(baseline.orderId);
      if (fact === undefined) {
        throw new Error(`[DailyLossTracker] persisted baseline order missing: ${baseline.orderId}`);
      }

      const side = fact.side;
      if (
        fact.direction !== prepared.direction ||
        fact.symbol !== baseline.symbol ||
        side !== baseline.side
      ) {
        throw new Error(
          `[DailyLossTracker] persisted baseline identity conflict: ${baseline.orderId}`,
        );
      }

      const baselineQuantity = safeQuantityNumber(baseline.cumulativeQuantity);
      const baselineAmount = canonicalDecimal(baseline.cumulativeAmount);
      if (
        fact.cumulativeQuantity < baselineQuantity ||
        exactCompare(fact.cumulativeAmount, baselineAmount) < 0 ||
        fact.lastExecutionTimeMs < baseline.lastExecutionTimeMs ||
        fact.orderUpdatedAtMs < baseline.orderRevisionMs
      ) {
        throw new Error(
          `[DailyLossTracker] persisted baseline cumulative regression: ${baseline.orderId}`,
        );
      }
    }

    commitProtectionBoundary(prepared);
  }

  return {
    resetAll,
    prepareRecalculationFromAllOrders,
    publishRecalculation,
    recalculateFromAllOrders,
    recordCumulativeExecution,
    restoreExecutionSnapshot,
    getExecutionTimeEvidence: () =>
      [...filledOrderFactsById.values()].map((fact) =>
        Object.freeze({
          brokerOrderId: fact.orderId,
          symbol: fact.symbol,
          side: fact.side,
          cumulativeQuantity: fact.cumulativeQuantity,
          cumulativeAmount: fact.cumulativeAmount,
          lastExecutionTimeMs: fact.lastExecutionTimeMs,
          orderRevisionMs: fact.orderUpdatedAtMs,
          phase: fact.factStage,
        }),
      ),
    getLossOffset,
    prepareProtectionBoundary,
    commitProtectionBoundary,
    restoreProtectionBoundary,
  };
}
