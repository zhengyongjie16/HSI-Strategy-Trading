/**
 * 当日亏损追踪器模块
 *
 * 功能/职责：按唯一监控标的的 LONG/SHORT 方向累计已实现亏损偏移；内部基于当日成交订单与过滤算法（filteringEngine）计算未平仓买入成本。
 * 执行流程：调用方通过 recalculateFromAllOrders 或 recordFilledOrder 传入/增量订单，通过 getLossOffset(direction) 获取当日亏损偏移；内部只维护唯一 monitor 的方向级状态。
 */
import { OrderSide } from 'longbridge';
import { logger } from '../../utils/logger/index.js';
import type { MonitorConfig } from '../../types/config.js';
import type {
  DailyLossFilledOrderInput,
  DailyLossTracker,
  DailyLossTrackerDeps,
  StartNewProtectionEpisodeParams,
} from '../../types/risk.js';
import type { OrderRecord, RawOrderFromAPI } from '../../types/services.js';
import {
  decimalAdd,
  decimalGt,
  decimalSub,
  decimalToNumberValue,
  toDecimalValue,
} from '../../utils/numeric/index.js';
import { decimalToNumber, isValidPositiveNumber } from '../../utils/helpers/index.js';
import type { DailyLossDirection, DailyLossDirectionStates, DailyLossState } from './types.js';
import { collectOrderOwnershipDiagnostics, resolveHongKongDayKey, sumOrderCost } from './utils.js';

/**
 * 构建空状态，避免分支重复初始化。
 *
 * @returns 无买入/卖出订单、亏损偏移为 0 的 DailyLossState
 */
function createEmptyState(): DailyLossState {
  return {
    buyOrders: [],
    sellOrders: [],
    dailyLossOffset: 0,
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
): number {
  if (buyOrders.length === 0 && sellOrders.length === 0) {
    return 0;
  }

  const totalBuy = toDecimalValue(sumOrderCost(buyOrders));
  const totalSell = toDecimalValue(sumOrderCost(sellOrders));
  if (totalBuy.isZero() && totalSell.isZero()) {
    return 0;
  }

  const openBuyOrders =
    buyOrders.length > 0
      ? filteringEngine.applyFilteringAlgorithm([...buyOrders], [...sellOrders])
      : [];
  const openBuyCost = toDecimalValue(sumOrderCost(openBuyOrders));
  const realizedPnL = decimalAdd(decimalSub(totalSell, totalBuy), openBuyCost);
  if (decimalGt(realizedPnL, 0)) {
    return 0;
  }

  return decimalToNumberValue(realizedPnL);
}

/**
 * 将订单列表转换为当日状态并计算亏损偏移。
 *
 * @param orders 原始 API 订单列表
 * @param deps 依赖（filteringEngine、classifyAndConvertOrders）
 * @returns 含 buyOrders、sellOrders、dailyLossOffset 的状态
 */
function buildStateFromOrders(
  orders: ReadonlyArray<RawOrderFromAPI>,
  deps: Pick<DailyLossTrackerDeps, 'filteringEngine' | 'classifyAndConvertOrders'>,
): DailyLossState {
  const { buyOrders, sellOrders } = deps.classifyAndConvertOrders(orders);
  const dailyLossOffset = calculateLossOffsetFromRecords(
    buyOrders,
    sellOrders,
    deps.filteringEngine,
  );
  return {
    buyOrders,
    sellOrders,
    dailyLossOffset,
  };
}

/**
 * 将成交回报转换为订单记录，若数据不完整则返回 null。
 *
 * @param input 成交回报（订单 ID、标的、成交价、成交量、成交时间等）
 * @returns OrderRecord 或 null（价格/数量/时间非法时）
 */
function createOrderRecordFromFill(input: DailyLossFilledOrderInput): OrderRecord | null {
  const executedPrice = input.executedPrice;
  const executedQuantity = input.executedQuantity;
  const executedTime = input.executedTimeMs;
  if (
    !Number.isFinite(executedPrice) ||
    executedPrice <= 0 ||
    !Number.isFinite(executedQuantity) ||
    executedQuantity <= 0 ||
    !Number.isFinite(executedTime) ||
    executedTime <= 0
  ) {
    return null;
  }

  return {
    orderId: input.orderId ?? `${input.symbol}-${executedTime}`,
    symbol: input.symbol,
    executedPrice,
    executedQuantity,
    executedTime,
    submittedAt: undefined,
    updatedAt: new Date(executedTime),
  };
}

/**
 * 判断 API 原始订单是否包含有效成交事实。
 * @param order API 原始订单
 * @returns 成交价与成交量均有效时返回 true
 */
function hasValidExecution(order: RawOrderFromAPI): boolean {
  return (
    isValidPositiveNumber(decimalToNumber(order.executedPrice)) &&
    isValidPositiveNumber(decimalToNumber(order.executedQuantity))
  );
}

/**
 * 相关交易标的的当日成交订单无法归属时直接阻断恢复，避免低估风控偏移。
 * @param params 订单、监控配置与相关交易标的集合
 */
function assertUnownedOrderIsNotRelevant(params: {
  readonly order: RawOrderFromAPI;
  readonly monitor: Pick<MonitorConfig, 'monitorSymbol'>;
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
 * 创建当日亏损追踪器实例。
 * 按唯一 monitor 的 LONG/SHORT 方向维护当日买入/卖出订单与亏损偏移，支持 resetAll、recalculateFromAllOrders、recordFilledOrder、getLossOffset。
 * 风控与浮亏计算依赖当日已实现盈亏偏移，需在跨日时重置、启动时从全量订单初始化、成交时增量更新。
 * @param deps 依赖（filteringEngine、resolveOrderOwnership、classifyAndConvertOrders、toHongKongTimeIso）
 * @returns 实现 DailyLossTracker 接口的实例
 */
export function createDailyLossTracker(deps: DailyLossTrackerDeps): DailyLossTracker {
  let dayKey: string | null = null;
  let statesByDirection = createEmptyDirectionStates();

  /** 最新已完成保护性清仓边界：仅计入 executedTimeMs > boundary 的成交。 */
  const latestProtectionBoundaryByDirection = new Map<DailyLossDirection, number>();

  /** 幂等保护：记录已应用边界，保证边界仅单向前进。 */
  const lastAppliedProtectionBoundaryByDirection = new Map<DailyLossDirection, number>();

  /**
   * 显式重置 dayKey、states 与分段元数据。
   */
  function resetAll(now: Date): void {
    const nextKey = resolveHongKongDayKey(deps.toHongKongTimeIso, now);
    dayKey = nextKey;
    statesByDirection = createEmptyDirectionStates();
    latestProtectionBoundaryByDirection.clear();
    lastAppliedProtectionBoundaryByDirection.clear();
  }

  /**
   * 启动时根据历史成交订单初始化当日状态。
   * protectionBoundaryByDirection 可选：按方向键恢复唯一 monitor 的方向级保护性边界。
   */
  function initializeFromOrders(
    allOrders: ReadonlyArray<RawOrderFromAPI>,
    monitor: Pick<MonitorConfig, 'monitorSymbol' | 'orderOwnershipMapping'>,
    now: Date,
    protectionBoundaryByDirection?: ReadonlyMap<'LONG' | 'SHORT', number>,
    relatedTradingSymbols?: ReadonlySet<string>,
  ): void {
    const nextKey = resolveHongKongDayKey(deps.toHongKongTimeIso, now);
    const previousDayKey = dayKey;
    const isSameTradingDay = previousDayKey !== null && previousDayKey === nextKey;
    dayKey = nextKey;
    statesByDirection = createEmptyDirectionStates();

    // 边界来源优先级：
    // 1) 显式传入（启动恢复）；
    // 2) 同日重算沿用当前运行态边界（如 SEAT_REFRESH）；
    // 3) 跨日重算清空边界，避免旧日边界泄漏。
    if (protectionBoundaryByDirection) {
      latestProtectionBoundaryByDirection.clear();
      lastAppliedProtectionBoundaryByDirection.clear();
      for (const [key, boundaryMs] of protectionBoundaryByDirection) {
        if (!Number.isFinite(boundaryMs) || boundaryMs <= 0) {
          continue;
        }

        const direction = parseProtectionBoundaryDirectionKey(key);
        latestProtectionBoundaryByDirection.set(direction, boundaryMs);
        lastAppliedProtectionBoundaryByDirection.set(direction, boundaryMs);
      }
    } else if (!isSameTradingDay) {
      latestProtectionBoundaryByDirection.clear();
      lastAppliedProtectionBoundaryByDirection.clear();
    }

    if (!nextKey) {
      return;
    }

    const grouped: { long: RawOrderFromAPI[]; short: RawOrderFromAPI[] } = {
      long: [],
      short: [],
    };
    for (const order of allOrders) {
      if (!(order.updatedAt instanceof Date)) {
        continue;
      }

      const orderDayKey = resolveHongKongDayKey(deps.toHongKongTimeIso, order.updatedAt);
      if (!orderDayKey || orderDayKey !== nextKey) {
        continue;
      }

      const ownership = deps.resolveOrderOwnership(order, monitor);
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

      // 边界过滤：仅计入 executedTime > latestProtectionBoundaryMs 的成交
      const protectionBoundary = latestProtectionBoundaryByDirection.get(ownership.direction);
      if (protectionBoundary !== undefined) {
        const orderTimeMs = order.updatedAt.getTime();
        if (orderTimeMs <= protectionBoundary) {
          continue;
        }
      }

      if (ownership.direction === 'LONG') {
        grouped.long.push(order);
      } else {
        grouped.short.push(order);
      }
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
      logger.warn(
        `[日内亏损追踪] 未归属订单: 当日成交${diagnostics.inDayFilled}笔, ` +
          `未归属${diagnostics.unmatchedFilled}笔, 样例=${sampleText}`,
      );
    }

    statesByDirection = {
      long: buildStateFromOrders(grouped.long, deps),
      short: buildStateFromOrders(grouped.short, deps),
    };
  }

  function getDirectionState(direction: DailyLossDirection): DailyLossState {
    return direction === 'LONG' ? statesByDirection.long : statesByDirection.short;
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

  function resetDirectionState(direction: DailyLossDirection): void {
    setDirectionState(direction, createEmptyState());
  }

  /**
   * 使用完整订单重新计算状态，作为纠偏手段。
   * protectionBoundaryByDirection 可选：提供保护性边界以过滤旧段成交。
   */
  function recalculateFromAllOrders(
    allOrders: ReadonlyArray<RawOrderFromAPI>,
    monitor: Pick<MonitorConfig, 'monitorSymbol' | 'orderOwnershipMapping'>,
    now: Date,
    protectionBoundaryByDirection?: ReadonlyMap<'LONG' | 'SHORT', number>,
    relatedTradingSymbols?: ReadonlySet<string>,
  ): void {
    initializeFromOrders(
      allOrders,
      monitor,
      now,
      protectionBoundaryByDirection,
      relatedTradingSymbols,
    );
  }

  /**
   * 增量记录成交订单并更新亏损偏移。
   * dayKey 由 lifecycle riskDomain.midnightClear 通过 resetAll 统一驱动，此处仅记录当日成交。
   * 边界过滤：仅接受 executedTimeMs > 当前保护性边界的成交。
   */
  function recordFilledOrder(input: DailyLossFilledOrderInput): void {
    if (!dayKey) {
      return;
    }

    const fillDayKey = resolveHongKongDayKey(
      deps.toHongKongTimeIso,
      new Date(input.executedTimeMs),
    );
    if (fillDayKey !== dayKey) {
      return;
    }

    // 边界过滤：成交时间小于等于保护性边界的不纳入
    const directionKey = input.direction;
    const protectionBoundary = latestProtectionBoundaryByDirection.get(directionKey);
    if (protectionBoundary !== undefined && input.executedTimeMs <= protectionBoundary) {
      return;
    }

    const record = createOrderRecordFromFill(input);
    if (!record) {
      return;
    }

    if (input.side !== OrderSide.Buy && input.side !== OrderSide.Sell) {
      return;
    }

    const currentState = getDirectionState(directionKey);
    const isBuy = input.side === OrderSide.Buy;
    const nextBuyOrders = isBuy ? [...currentState.buyOrders, record] : currentState.buyOrders;
    const nextSellOrders = isBuy ? currentState.sellOrders : [...currentState.sellOrders, record];
    const nextState: DailyLossState = {
      buyOrders: nextBuyOrders,
      sellOrders: nextSellOrders,
      dailyLossOffset: calculateLossOffsetFromRecords(
        nextBuyOrders,
        nextSellOrders,
        deps.filteringEngine,
      ),
    };

    setDirectionState(directionKey, nextState);
  }

  /**
   * 获取指定标的与方向的当日亏损偏移。
   */
  function getLossOffset(direction: 'LONG' | 'SHORT'): number {
    return direction === 'LONG'
      ? statesByDirection.long.dailyLossOffset
      : statesByDirection.short.dailyLossOffset;
  }

  /** 推进保护性边界并开启新周期。 */
  function startNewProtectionEpisode({
    direction,
    boundaryExecutedTimeMs,
  }: StartNewProtectionEpisodeParams): void {
    if (!Number.isFinite(boundaryExecutedTimeMs) || boundaryExecutedTimeMs <= 0) {
      return;
    }

    const lastAppliedBoundary = lastAppliedProtectionBoundaryByDirection.get(direction);
    if (lastAppliedBoundary !== undefined && boundaryExecutedTimeMs <= lastAppliedBoundary) {
      return;
    }

    lastAppliedProtectionBoundaryByDirection.set(direction, boundaryExecutedTimeMs);
    latestProtectionBoundaryByDirection.set(direction, boundaryExecutedTimeMs);
    resetDirectionState(direction);
  }

  return {
    resetAll,
    recalculateFromAllOrders,
    recordFilledOrder,
    getLossOffset,
    startNewProtectionEpisode,
  };
}
