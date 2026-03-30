import type { Position } from '../../types/account.js';
import type { Quote } from '../../types/quote.js';
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
  return (
    position !== null &&
    Number.isFinite(position.availableQuantity) &&
    position.availableQuantity > 0 &&
    quote !== null &&
    Number.isFinite(quote.price) &&
    quote.price > 0
  );
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
 * 全仓平仓：返回全部可用数量。
 *
 * @param availableQuantity 当前可用持仓数量
 * @param directionName 方向中文名称，用于构建原因说明
 * @returns 包含全部可用数量、shouldHold=false 与原因说明的结果
 */
export function resolveSellQuantityByFullClose({
  availableQuantity,
  directionName,
}: {
  availableQuantity: number;
  directionName: string;
}): {
  quantity: number;
  shouldHold: boolean;
  reason: string;
} {
  return {
    quantity: availableQuantity,
    shouldHold: false,
    reason: `趋势退出触发全平，直接清空所有${directionName}持仓`,
  };
}

/**
 * 根据标的代码获取对应的中文名称。
 * 默认行为：匹配做多/做空标的代码返回对应名称，未匹配时返回 signalSymbol 本身。
 *
 * @param signalSymbol 信号中的标的代码
 * @param longSymbol 做多标的代码，可为 null
 * @param shortSymbol 做空标的代码，可为 null
 * @param longSymbolName 做多标的中文名称，可为 null
 * @param shortSymbolName 做空标的中文名称，可为 null
 * @returns 匹配到的中文名称；未匹配时返回 signalSymbol 本身
 */
export function getSymbolName(
  signalSymbol: string,
  longSymbol: string | null,
  shortSymbol: string | null,
  longSymbolName: string | null,
  shortSymbolName: string | null,
): string | null {
  if (longSymbol && signalSymbol === longSymbol) {
    return longSymbolName;
  }

  if (shortSymbol && signalSymbol === shortSymbol) {
    return shortSymbolName;
  }

  return signalSymbol;
}
