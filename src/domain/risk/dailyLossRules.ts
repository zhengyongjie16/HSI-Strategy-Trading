/**
 * 当日亏损纯规则：香港日键、精确订单成本汇总与归属诊断；不持有状态或 IO。
 */
import { isValidPositiveNumber } from '../../utils/helpers/index.js';
import { exactAdd, exactCompare } from '../../utils/numeric/exact.js';
import type { DailyLossMonitorScope, DailyLossOrderSnapshot } from '../../types/risk.js';
import type { OrderOwnership, OrderRecord } from '../../types/orderRecorder.js';

import type { OrderOwnershipDiagnostics, OrderOwnershipDiagnosticSample } from './types.js';

/**
 * 生成香港时间日键（YYYY/MM/DD），用于筛选当日订单与诊断。
 * 日期无效或 toHongKongTimeIso 返回格式不含至少三段时返回 null。
 *
 * @param toHongKongTimeIso 将日期转为香港时间 ISO 字符串的函数（如 "YYYY/MM/DD HH:mm:ss"）
 * @param date 待转换的日期
 * @returns 日键字符串 "YYYY/MM/DD"，无效时返回 null
 */
export function resolveHongKongDayKey(
  toHongKongTimeIso: (date: Date) => string,
  date: Date,
): string | null {
  if (!Number.isFinite(date.getTime())) {
    return null;
  }

  const iso = toHongKongTimeIso(date);
  const parts = iso.split('/');
  if (parts.length < 3) {
    return null;
  }

  return `${parts[0]}/${parts[1]}/${parts[2]}`;
}

/**
 * 汇总订单保真的累计成本金额，用于当日亏损偏移计算，不从展示均价反算。
 * 成交数量不是正安全整数或成本金额无效时立即暴露内部契约错误。
 *
 * @param orders 订单记录列表
 * @returns 总成本金额（港币）
 */
export function sumOrderCost(orders: ReadonlyArray<OrderRecord>): string {
  let total = '0';
  for (const order of orders) {
    if (
      !Number.isSafeInteger(order.executedQuantity) ||
      order.executedQuantity <= 0 ||
      exactCompare(order.costAmount, '0') <= 0
    ) {
      throw new TypeError('[risk] invalid order cost basis');
    }

    total = exactAdd(total, order.costAmount);
  }

  return total;
}

/**
 * 收集订单归属诊断信息，用于启动时检测当日成交订单中未能归属到任何监控标的的订单数量与样例。
 * @param orders 全量原始订单列表
 * @param monitor 唯一监控配置，用于归属匹配
 * @param now 当前时间，用于确定当日日键
 * @param resolveOrderOwnership 订单归属解析函数
 * @param toHongKongTimeIso 日期转香港时间 ISO 字符串的函数
 * @param maxSamples 未归属订单最大样例数，默认 3
 * @returns 诊断结果，日键无效时返回 null
 */
export function collectOrderOwnershipDiagnostics({
  orders,
  monitor,
  now,
  resolveOrderOwnership,
  toHongKongTimeIso,
  maxSamples = 3,
}: {
  readonly orders: ReadonlyArray<DailyLossOrderSnapshot>;
  readonly monitor: DailyLossMonitorScope;
  readonly now: Date;
  readonly resolveOrderOwnership: (
    order: DailyLossOrderSnapshot,
    monitor: DailyLossMonitorScope,
  ) => OrderOwnership | null;
  readonly toHongKongTimeIso: (date: Date) => string;
  readonly maxSamples?: number;
}): OrderOwnershipDiagnostics | null {
  const dayKey = resolveHongKongDayKey(toHongKongTimeIso, now);
  if (!dayKey) {
    return null;
  }

  const sampleLimit = isValidPositiveNumber(maxSamples) ? Math.floor(maxSamples) : 0;

  let inDayFilled = 0;
  let unmatchedFilled = 0;
  const unmatchedSamples: OrderOwnershipDiagnosticSample[] = [];

  for (const order of orders) {
    if (order.executionStatus !== 'FILLED') {
      continue;
    }

    if (order.executionTimeMs === null) {
      continue;
    }

    const orderDayKey = resolveHongKongDayKey(toHongKongTimeIso, new Date(order.executionTimeMs));
    if (!orderDayKey || orderDayKey !== dayKey) {
      continue;
    }

    inDayFilled += 1;

    const ownership = resolveOrderOwnership(order, monitor);
    if (ownership) {
      continue;
    }

    unmatchedFilled += 1;
    if (sampleLimit > 0 && unmatchedSamples.length < sampleLimit) {
      unmatchedSamples.push({
        symbol: order.symbol,
        stockName: order.stockName,
      });
    }
  }

  return {
    inDayFilled,
    unmatchedFilled,
    unmatchedSamples,
  };
}
