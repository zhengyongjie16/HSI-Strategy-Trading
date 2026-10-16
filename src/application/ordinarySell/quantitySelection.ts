/** 普通 SELL 卖量用例：读取唯一订单账的选单事实，按纯规则选择三阶段，且不创建订单占用。 */
import { exactCompare, formatDecimal, formatRatio } from '../../utils/numeric/exact.js';
import {
  isOverallProfitable,
  remainingSellQuantity,
  sumSmartCloseQuantities,
} from '../../domain/order/smartClose.js';
import type { Position } from '../../types/account.js';
import type { Quote } from '../../types/quote.js';
import type { OrderRecorder } from '../../types/orderRecorder.js';
import type { TradingCalendarSnapshot } from '../../types/tradingCalendar.js';
import type { SellContextValidationResult } from './types.js';

/**
 * 类型保护：验证持仓和行情数据是否满足卖出条件（内部辅助函数）。
 * 默认行为：持仓或行情缺失、可用数量≤0、价格≤0 时返回 false。
 *
 * @param position 持仓对象，可为 null
 * @param quote 行情对象，可为 null
 * @returns true 表示持仓和行情均有效，同时收窄 position 类型为 Position & { availableQuantity: number }
 */
function isValidPositionAndQuote(
  position: Position | null,
  quote: Quote | null,
): position is Position & { availableQuantity: number } {
  if (quote !== null) exactCompare(quote.price, '0');

  if (position === null || quote === null) return false;

  if (!Number.isSafeInteger(position.availableQuantity) || position.availableQuantity < 0) {
    throw new RangeError('可用持仓数量必须为非负安全整数');
  }

  return position.availableQuantity > 0 && exactCompare(quote.price, '0') > 0;
}

/**
 * 构建卖出原因文本（将原始原因与详细说明用中文逗号拼接）。
 * 默认行为：原始原因为空或仅空白时直接返回 detail。
 *
 * @param originalReason 原始原因字符串，可为空
 * @param detail 详细说明
 * @returns 拼接后的原因字符串；若原始原因为空则直接返回 detail
 */
export function buildSellReason(originalReason: string, detail: string): string {
  const trimmedReason = originalReason.trim();
  if (!trimmedReason) {
    return detail;
  }

  return `${trimmedReason}，${detail}`;
}

/**
 * 校验卖出上下文数据有效性。
 * 默认行为：持仓或行情无效时返回 { valid: false, reason: '持仓或行情数据无效' }。
 *
 * @param position 持仓对象，可为 null
 * @param quote 行情对象，可为 null
 * @returns 校验结果联合类型，valid=true 时包含 availableQuantity 和 currentPrice
 */
export function validateSellContext(
  position: Position | null,
  quote: Quote | null,
): SellContextValidationResult {
  if (!isValidPositionAndQuote(position, quote) || !quote) {
    return { valid: false, reason: '持仓或行情数据无效' };
  }

  return {
    valid: true,
    availableQuantity: position.availableQuantity,
    currentPrice: quote.price,
  };
}

/**
 * 智能平仓：三阶段卖出策略
 *
 * 阶段顺序：
 * 1. 整体盈利命中时全卖（命中即结束）
 * 2. 整体未盈利先卖盈利订单
 * 3. 在第二阶段剩余额度内卖出超时订单（可关闭）
 *
 * @param orderRecorder 原订单账只读能力，为 null 时保持持仓、不提交
 * @param currentPrice 当前行情价格
 * @param availableQuantity 当前可用持仓数量
 * @param direction 方向，LONG 或 SHORT
 * @param symbol 标的代码，用于精确筛选订单记录
 * @param smartCloseTimeoutMinutes 智能平仓第三阶段超时阈值（分钟）
 * @param nowMs 当前时间戳（毫秒）
 * @param isHalfDay 是否半日市（仅用于日志标注）
 * @param tradingCalendarSnapshot 交易日历快照（严格交易时段累计）
 * @returns 包含可卖出数量、是否持有、原因说明以及关联买入订单ID列表的结果
 */
export function resolveSellQuantityBySmartClose({
  orderRecorder,
  currentPrice,
  availableQuantity,
  direction,
  symbol,
  smartCloseTimeoutMinutes,
  nowMs,
  isHalfDay,
  tradingCalendarSnapshot,
}: {
  readonly orderRecorder: Pick<OrderRecorder, 'getCostBasis' | 'selectSellableOrders'> | null;
  readonly currentPrice: string;
  readonly availableQuantity: number;
  readonly direction: 'LONG' | 'SHORT';
  readonly symbol: string;
  readonly smartCloseTimeoutMinutes: number | null;
  readonly nowMs: number;
  readonly isHalfDay: boolean;
  readonly tradingCalendarSnapshot: TradingCalendarSnapshot;
}): {
  readonly quantity: number | null;
  readonly shouldHold: boolean;
  readonly reason: string;
  readonly relatedBuyOrderIds: readonly string[];
} {
  if (!orderRecorder) {
    return {
      quantity: null,
      shouldHold: true,
      reason: '智能平仓：订单记录不可用，保持持仓',
      relatedBuyOrderIds: [],
    };
  }

  if (!Number.isSafeInteger(availableQuantity) || availableQuantity < 0)
    throw new RangeError('可用数量必须为非负安全整数');

  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new TypeError('卖出时间必须为非负安全整数');

  const isLongSymbol = direction === 'LONG';
  const costBasis = orderRecorder.getCostBasis(symbol, isLongSymbol);
  const overallProfitable = isOverallProfitable(currentPrice, costBasis);
  const costAverageLabel =
    costBasis === null
      ? 'N/A'
      : formatRatio(costBasis.costAmount, String(costBasis.quantity), 3, 'preserve');
  const currentPriceLabel = formatDecimal(currentPrice, 3, 'preserve');
  const timeoutLabel = smartCloseTimeoutMinutes ?? 'null';

  if (overallProfitable) {
    const stage1Result = orderRecorder.selectSellableOrders({
      symbol,
      direction,
      strategy: 'ALL',
      currentPrice,
      maxSellQuantity: availableQuantity,
    });

    if (!Number.isSafeInteger(stage1Result.totalQuantity) || stage1Result.totalQuantity < 0)
      throw new RangeError('可卖订单数量必须为非负安全整数');

    if (stage1Result.totalQuantity > availableQuantity)
      throw new TypeError('可卖订单数量超过授权上限');

    if (stage1Result.totalQuantity > 0 && stage1Result.orders.length > 0) {
      const relatedBuyOrderIds = stage1Result.orders.map((order) => order.orderId);
      return {
        quantity: stage1Result.totalQuantity,
        shouldHold: false,
        reason:
          `智能平仓：当前价=${currentPriceLabel}，成本均价=${costAverageLabel}，` +
          `overallProfitMatched=true，stage2Quantity=0，stage3Quantity=0，timeoutMinutes=${timeoutLabel}，` +
          `timedOutOrderCount=0，remainingAfterStage2=0，isHalfDay=${isHalfDay}，可卖出=${stage1Result.totalQuantity}股，关联订单=${relatedBuyOrderIds.length}个`,
        relatedBuyOrderIds,
      };
    }

    return {
      quantity: null,
      shouldHold: true,
      reason: '智能平仓：整体盈利但无可用订单或已被占用，保持持仓',
      relatedBuyOrderIds: [],
    };
  }

  const stage2Result = orderRecorder.selectSellableOrders({
    symbol,
    direction,
    strategy: 'PROFIT_ONLY',
    currentPrice,
    maxSellQuantity: availableQuantity,
  });
  const stage2OrderIds = new Set(stage2Result.orders.map((order) => order.orderId));
  const stage2Quantity = stage2Result.totalQuantity;
  if (!Number.isSafeInteger(stage2Quantity) || stage2Quantity < 0)
    throw new RangeError('盈利订单数量必须为非负安全整数');

  if (stage2Quantity > availableQuantity) throw new TypeError('盈利订单数量超过授权上限');

  const remainingAfterStage2 = remainingSellQuantity(availableQuantity, stage2Quantity);

  let stage3Quantity = 0;
  let stage3OrdersCount = 0;
  const stage3OrderIds: string[] = [];

  if (smartCloseTimeoutMinutes !== null && remainingAfterStage2 > 0) {
    const stage3Result = orderRecorder.selectSellableOrders({
      symbol,
      direction,
      strategy: 'TIMEOUT_ONLY',
      currentPrice,
      maxSellQuantity: remainingAfterStage2,
      timeoutMinutes: smartCloseTimeoutMinutes,
      nowMs,
      calendarSnapshot: tradingCalendarSnapshot,
      excludeOrderIds: stage2OrderIds,
    });
    stage3Quantity = stage3Result.totalQuantity;
    if (!Number.isSafeInteger(stage3Quantity) || stage3Quantity < 0)
      throw new RangeError('超时订单数量必须为非负安全整数');

    if (stage3Quantity > remainingAfterStage2) throw new TypeError('超时订单数量超过授权上限');

    stage3OrdersCount = stage3Result.orders.length;
    for (const order of stage3Result.orders) {
      stage3OrderIds.push(order.orderId);
    }
  }

  const finalQuantity = sumSmartCloseQuantities(availableQuantity, stage2Quantity, stage3Quantity);
  if (finalQuantity > 0) {
    const relatedBuyOrderIds = [...stage2OrderIds, ...stage3OrderIds];
    return {
      quantity: finalQuantity,
      shouldHold: false,
      reason:
        `智能平仓：当前价=${currentPriceLabel}，成本均价=${costAverageLabel}，` +
        `overallProfitMatched=false，stage2Quantity=${stage2Quantity}，stage3Quantity=${stage3Quantity}，timeoutMinutes=${timeoutLabel}，` +
        `timedOutOrderCount=${stage3OrdersCount}，remainingAfterStage2=${remainingAfterStage2}，isHalfDay=${isHalfDay}，可卖出=${finalQuantity}股，关联订单=${relatedBuyOrderIds.length}个`,
      relatedBuyOrderIds,
    };
  }

  return {
    quantity: null,
    shouldHold: true,
    reason:
      smartCloseTimeoutMinutes === null
        ? '智能平仓：无盈利订单或已被占用'
        : '智能平仓：无盈利订单，且无超时订单或已被占用',
    relatedBuyOrderIds: [],
  };
}

/**
 * 全仓平仓：返回全部可用数量（智能平仓关闭时使用）。
 * 默认行为：直接返回 availableQuantity 作为卖出数量，不依赖订单记录。
 *
 * @param availableQuantity 当前可用持仓数量
 * @param directionName 方向中文名称，用于构建原因说明
 * @returns 包含全部可用数量、shouldHold=false、原因说明及空关联订单列表的结果
 */
export function resolveSellQuantityByFullClose({
  availableQuantity,
  directionName,
}: {
  readonly availableQuantity: number;
  readonly directionName: string;
}): {
  readonly quantity: number;
  readonly shouldHold: boolean;
  readonly reason: string;
  readonly relatedBuyOrderIds: readonly string[];
} {
  if (!Number.isSafeInteger(availableQuantity) || availableQuantity < 0) {
    throw new RangeError('可用数量必须为非负安全整数');
  }

  return {
    quantity: availableQuantity,
    shouldHold: false,
    reason: `智能平仓已关闭，直接清空所有${directionName}持仓`,
    relatedBuyOrderIds: [],
  };
}
