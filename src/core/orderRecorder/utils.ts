import { TIME } from '../../constants/index.js';
import { calculateTradingDurationMsBetween } from '../../utils/time/index.js';
import {
  canonicalDecimal,
  exactAdd,
  exactCompare,
  exactMultiply,
  exactSubtract,
  integerQuotient,
} from '../../utils/numeric/exact.js';
import type { OrderRecord } from '../../types/services.js';
import type { OrderExecutionRecordObservation } from '../../types/orderRecorder.js';
import type { OrderTimeoutCheckParams } from '../../types/tradingCalendar.js';
import type { OrderRebuildClassification, OrderStatistics } from './types.js';

/**
 * 校验精确金额、安全整数数量与独立可信执行时间。
 * @param costAmount 权威累计成交金额文本
 * @param executedQuantity 经证明的安全整数数量
 * @param executedTimeMs 可信执行时间
 * @returns 无返回值；非法事实立即失败
 */
export function assertCompleteExecutionFact(
  costAmount: string,
  executedQuantity: number,
  executedTimeMs: number,
): void {
  if (
    exactCompare(costAmount, '0') <= 0 ||
    !Number.isSafeInteger(executedQuantity) ||
    executedQuantity <= 0 ||
    !Number.isSafeInteger(executedTimeMs) ||
    executedTimeMs <= 0
  ) {
    throw new Error('[订单记录] 金额、数量或执行时间无效');
  }
}

/**
 * 精确汇总成本依据，均价只允许在显示边界计算。
 * @param orders 已校验订单记录
 * @returns 总成本金额与安全整数总数量
 */
export function calculateOrderStatistics(orders: ReadonlyArray<OrderRecord>): OrderStatistics {
  let totalQuantity = 0;
  let costAmount = '0';
  for (const order of orders) {
    assertCompleteExecutionFact(order.costAmount, order.executedQuantity, order.executedTime);
    totalQuantity += order.executedQuantity;
    if (!Number.isSafeInteger(totalQuantity)) {
      throw new RangeError('[订单记录] 汇总数量超出安全整数范围');
    }

    costAmount = exactAdd(costAmount, order.costAmount);
  }

  return { totalQuantity, costAmount };
}

/**
 * 按原累计金额/数量依据精确分配仍有效的经济范围，不计算或舍入均价。
 * SDK 的累计金额由有限十进制均价原文×累计量形成，故此比例必须能精确有限表示；不造近似成本。
 * @param cumulativeAmount 权威累计金额文本
 * @param quantity 当前范围的安全整数数量
 * @param basisQuantity 权威累计安全整数数量
 * @returns 精确成本金额；无有效有限比例时内部契约立即失败
 */
export function proportionExecutionCost(
  cumulativeAmount: string,
  quantity: number,
  basisQuantity: number,
): string {
  if (
    !Number.isSafeInteger(quantity) ||
    quantity < 0 ||
    !Number.isSafeInteger(basisQuantity) ||
    basisQuantity <= 0 ||
    quantity > basisQuantity ||
    exactCompare(cumulativeAmount, '0') <= 0
  ) {
    throw new RangeError('[订单记录] 无效成本范围或累计依据');
  }

  if (quantity === 0) return '0';

  if (quantity === basisQuantity) return canonicalDecimal(cumulativeAmount);

  const numerator = canonicalDecimal(exactMultiply(cumulativeAmount, String(quantity)));
  const [whole = '0', fraction = ''] = numerator.split('.');
  const coefficient = (whole + fraction).replace(/^0+(?=\d)/, '');
  let a = BigInt(coefficient);
  let b = BigInt(basisQuantity);
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }

  let denominator = BigInt(basisQuantity) / a;
  while (denominator % 2n === 0n) denominator /= 2n;

  while (denominator % 5n === 0n) denominator /= 5n;

  if (denominator !== 1n) throw new RangeError('[订单记录] 成本范围不能精确表示为有限十进制');

  const divisor = String(basisQuantity);
  let digits = integerQuotient(coefficient, divisor);
  let remainder = exactSubtract(coefficient, exactMultiply(digits, divisor));
  let places = fraction.length;
  while (exactCompare(remainder, '0') !== 0) {
    const shifted = exactMultiply(remainder, '10');
    const digit = integerQuotient(shifted, divisor);
    digits += digit;
    places += 1;
    remainder = exactSubtract(shifted, exactMultiply(digit, divisor));
  }

  const padded = digits.padStart(places + 1, '0');
  return canonicalDecimal(
    places === 0 ? padded : `${padded.slice(0, -places)}.${padded.slice(-places)}`,
  );
}

/**
 * 按原严格交易时长口径判定超时。
 * @param params 成交时间、当前时间、超时分钟及交易日历
 * @returns heldTradingMs 严格大于阈值时为 true
 */
export function isOrderTimedOut(params: OrderTimeoutCheckParams): boolean {
  const { orderExecutedTimeMs, nowMs, timeoutMinutes, calendarSnapshot } = params;
  if (!Number.isInteger(timeoutMinutes) || timeoutMinutes < 0) {
    return false;
  }

  return (
    calculateTradingDurationMsBetween({
      startMs: orderExecutedTimeMs,
      endMs: nowMs,
      calendarSnapshot,
    }) >
    timeoutMinutes * TIME.MILLISECONDS_PER_MINUTE
  );
}

/**
 * 从已映射 API 事实提取完整成本依据，不从均价往返成本。
 * @param order 中立金融字段 API 订单
 * @param isBuyOrder 是否保留提交时间
 * @returns 正成交记录或零成交的 null
 */
function convertOrderToRecord(
  order: OrderExecutionRecordObservation,
  isBuyOrder: boolean,
): OrderRecord | null {
  if (order.executedQuantity === 0) {
    if (exactCompare(order.executedAmount, '0') !== 0) {
      throw new Error('[订单记录] 零数量的累计金额冲突');
    }

    return null;
  }

  if (order.executionTimeMs === null) {
    throw new Error('[订单记录] 非零成交缺少可信执行时间');
  }

  assertCompleteExecutionFact(order.executedAmount, order.executedQuantity, order.executionTimeMs);
  return {
    orderId: order.orderId,
    symbol: order.symbol,
    costAmount: order.executedAmount,
    executedQuantity: order.executedQuantity,
    executedTime: order.executionTimeMs,
    submittedAt: isBuyOrder ? order.submittedAt : undefined,
    updatedAt: new Date(order.updatedAtMs),
  };
}

/**
 * 将完整累计成交分类，包含 OPEN 成交供 DailyLoss 核算。
 * @param orders 已映射全量订单
 * @returns 买卖两类成本记录
 */
export function classifyAndConvertOrders(orders: ReadonlyArray<OrderExecutionRecordObservation>): {
  buyOrders: ReadonlyArray<OrderRecord>;
  sellOrders: ReadonlyArray<OrderRecord>;
} {
  const buyOrders: OrderRecord[] = [];
  const sellOrders: OrderRecord[] = [];
  for (const order of orders) {
    const record = convertOrderToRecord(order, order.executionSide === 'BUY');
    if (record === null) {
      continue;
    }

    if (!['BUY', 'SELL'].includes(order.executionSide))
      throw new Error('[订单记录] 正成交方向不可归属');

    if (order.executionSide === 'BUY') buyOrders.push(record);
    else sellOrders.push(record);
  }

  return { buyOrders, sellOrders };
}

/**
 * 预检完整重建事实，OPEN 的 partial 保留 pending、不提前做经济终态投影。
 * @param orders 单标的全量 API 事实
 * @returns terminal 执行记录与 OPEN pending 分流
 */
export function classifyOrdersForRebuild<T extends OrderExecutionRecordObservation>(
  orders: ReadonlyArray<T>,
): OrderRebuildClassification<T> {
  const executedBuyOrders: OrderRecord[] = [];
  const executedSellOrders: OrderRecord[] = [];
  const pendingBuyOrders: T[] = [];
  const pendingSellOrders: T[] = [];
  for (const order of orders) {
    const lifecycle = order.executionPhase;
    const isBuyOrder = order.executionSide === 'BUY';
    const isSellOrder = order.executionSide === 'SELL';
    const record = convertOrderToRecord(order, isBuyOrder);
    if (!isBuyOrder && !isSellOrder) {
      if (record !== null || lifecycle === 'OPEN') {
        throw new Error('[订单记录] 订单方向不可归属');
      }

      continue;
    }

    if (lifecycle === 'OPEN') {
      (isBuyOrder ? pendingBuyOrders : pendingSellOrders).push(order);
    } else if (record !== null) {
      (isBuyOrder ? executedBuyOrders : executedSellOrders).push(record);
    }
  }

  return { executedBuyOrders, executedSellOrders, pendingBuyOrders, pendingSellOrders };
}
