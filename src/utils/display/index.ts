/**
 * 从行情对象生成标的显示字符串，保持缺名称与空名称的原始呈现语义。
 * @param quote 行情对象，缺失时仅显示代码
 * @param symbol 标的代码
 * @returns 行情名称(代码)，名称为 null/undefined 时使用 -
 */

import type { Quote } from '../../types/quote.js';

export function formatSymbolDisplayFromQuote(
  quote: Quote | null | undefined,
  symbol: string,
): string {
  if (!quote) return symbol;

  const nameText = quote.name ?? '-';
  return `${nameText}(${symbol})`;
}

/**
 * 格式化标的显示为「中文名称(代码)》。
 * 默认行为：symbol 为空返回空串；symbolName 为空时仅返回代码。
 *
 * @param symbol 标的代码
 * @param symbolName 标的中文名称，默认 null
 * @returns 格式化后的显示字符串
 */
export function formatSymbolDisplay(
  symbol: string | null | undefined,
  symbolName: string | null = null,
): string {
  if (!symbol) {
    return '';
  }

  if (symbolName) {
    return `${symbolName}(${symbol})`;
  }

  return symbol;
}
