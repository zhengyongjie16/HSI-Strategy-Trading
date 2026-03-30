/**
 * 订单归属解析模块
 *
 * 职责：
 * - 根据订单 stockName 中的 RC/RP（牛证/熊证）与配置 orderOwnershipMapping 缩写，判断订单属于哪个基础对象及多/空方向
 * - 供 DailyLossTracker、OrderRecorder 等做订单归属与当日亏损分组
 *
 * 执行流程：
 * - 标准化 stockName（大写、去除非字母数字）→ 先解析 direction（RC/BULL/CALL/牛 vs RP/BEAR/PUT/熊）→ 再匹配归属缩写 → 返回 baseInstrumentSymbol + direction
 */
import { OrderStatus } from 'longbridge';
import { ORDER_OWNERSHIP } from '../../constants/index.js';
import type { StrategyRuntimeConfig } from '../../types/config.js';
import type { OrderOwnership } from '../../types/orderRecorder.js';
import type { RawOrderFromAPI } from '../../types/services.js';

/** 统一转大写并去除非字母数字字符，避免大小写与分隔符导致误判 */
function normalizeForMatching(str: string): string {
  return str.trim().toUpperCase().replaceAll(ORDER_OWNERSHIP.NORMALIZE_PATTERN, '');
}

/** 根据标准化后的股票名称判断多空方向，同时包含多空标记时返回 null */
function resolveDirectionFromNormalizedName(normalizedStockName: string): 'LONG' | 'SHORT' | null {
  const hasLongMarker = ORDER_OWNERSHIP.LONG_MARKERS.some((marker) =>
    normalizedStockName.includes(marker),
  );
  const hasShortMarker = ORDER_OWNERSHIP.SHORT_MARKERS.some((marker) =>
    normalizedStockName.includes(marker),
  );
  if (hasLongMarker && !hasShortMarker) {
    return 'LONG';
  }

  if (hasShortMarker && !hasLongMarker) {
    return 'SHORT';
  }

  return null;
}

/**
 * 解析订单归属方向
 * stockName 需同时满足：1) 包含 RC(牛证/做多) 或 RP(熊证/做空)；2) 包含配置映射中的归属缩写
 */
function parseOrderOwnership(
  stockName: string | null | undefined,
  orderOwnershipMapping: ReadonlyArray<string>,
): 'LONG' | 'SHORT' | null {
  if (!stockName) {
    return null;
  }

  if (orderOwnershipMapping.length === 0) {
    return null;
  }

  const normalizedStockName = normalizeForMatching(stockName);
  const direction = resolveDirectionFromNormalizedName(normalizedStockName);
  if (!direction) {
    return null;
  }

  for (const alias of orderOwnershipMapping) {
    const normalizedAlias = normalizeForMatching(alias);
    if (!normalizedAlias) {
      continue;
    }

    if (normalizedStockName.includes(normalizedAlias)) {
      return direction;
    }
  }

  return null;
}

/**
 * 在多监控标的场景下解析订单归属。
 * 先根据 direction 语义完成订单方向解析，再根据 orderOwnershipMapping 匹配基础对象。
 *
 * @param order 原始 API 订单（含 stockName）
 * @param monitors 监控配置列表，每项含 baseInstrumentSymbol 与 orderOwnershipMapping
 * @returns 归属结果（baseInstrumentSymbol + direction），无法匹配时返回 null
 */
export function resolveOrderOwnership(
  order: RawOrderFromAPI,
  monitors: ReadonlyArray<
    Pick<StrategyRuntimeConfig, 'baseInstrumentSymbol' | 'orderOwnershipMapping'>
  >,
): OrderOwnership | null {
  for (const monitor of monitors) {
    const direction = parseOrderOwnership(order.stockName, monitor.orderOwnershipMapping);
    if (direction) {
      return {
        baseInstrumentSymbol: monitor.baseInstrumentSymbol,
        direction,
      };
    }
  }

  return null;
}

/**
 * 在单实例场景下解析订单归属。
 * 该路径优先完成 direction 解析，再补充 baseInstrumentSymbol。
 *
 * @param order 原始 API 订单（含 stockName）
 * @param monitor 单实例 monitor 配置
 * @returns 归属结果（baseInstrumentSymbol + direction），无法匹配时返回 null
 */
export function resolveOrderOwnershipForMonitor(
  order: RawOrderFromAPI,
  monitor: Pick<StrategyRuntimeConfig, 'baseInstrumentSymbol' | 'orderOwnershipMapping'>,
): OrderOwnership | null {
  const direction = parseOrderOwnership(order.stockName, monitor.orderOwnershipMapping);
  if (!direction) {
    return null;
  }

  return {
    baseInstrumentSymbol: monitor.baseInstrumentSymbol,
    direction,
  };
}

/**
 * 获取指定监控标的与方向下最新成交的交易标的（按 updatedAt 取最大）。
 * @param orders 原始 API 订单列表（通常为当日或历史成交）
 * @param orderOwnershipMapping 该监控标的的订单归属映射缩写
 * @param direction 方向（LONG 或 SHORT）
 * @returns 该方向下最近一笔成交的标的代码，无匹配时返回 null
 */
export function getLatestTradedSymbol(
  orders: ReadonlyArray<RawOrderFromAPI>,
  orderOwnershipMapping: ReadonlyArray<string>,
  direction: 'LONG' | 'SHORT',
): string | null {
  let latestSymbol: string | null = null;
  let latestTime = 0;

  for (const order of orders) {
    if (order.status !== OrderStatus.Filled) {
      continue;
    }

    const orderDirection = parseOrderOwnership(order.stockName, orderOwnershipMapping);
    if (orderDirection !== direction) {
      continue;
    }

    // updatedAt 代表成交后更新时间，取最大值作为最近成交
    const resolvedTime = order.updatedAt ? order.updatedAt.getTime() : 0;
    if (resolvedTime <= latestTime) {
      continue;
    }

    latestTime = resolvedTime;
    latestSymbol = order.symbol;
  }

  return latestSymbol;
}
