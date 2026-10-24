/** 市场显示工具：金额/价格原文一次 half-even 输出，不把显示舍入回写金融事实。 */
import { DEFAULT_PERCENT_DECIMALS } from '../../../constants/common.js';
import {
  exactCompare,
  exactMultiply,
  exactSubtract,
  formatDecimal,
  formatRatio,
} from '../../../utils/numeric/exact.js';
import type { UnrealizedLossMetrics } from '../../../types/unrealizedLoss.js';
import type { WarrantDistanceInfo } from '../../../types/warrantRisk.js';
import type { Quote } from '../../../types/quote.js';
import type { QuoteDisplay } from './types.js';

/**
 * 格式化交易行情；非法金融文本穿透，合法零/负值沿用既有字段显示政策。
 * @param quote 保真行情或外部缺失值
 * @param symbol 展示标的
 * @returns 一次half-even的终态字段；缺行情时返回null
 */
export function formatQuoteDisplay(quote: Quote | null, symbol: string): QuoteDisplay | null {
  if (quote === null) return null;

  const priceText = formatDecimal(quote.price, 3, 'preserve');
  let changeAmountText = '-';
  let changePercentText = '-';
  const previous = exactCompare(quote.prevClose, '0');
  if (previous !== 0) {
    const delta = exactSubtract(quote.price, quote.prevClose);
    const sign = exactCompare(delta, '0') >= 0 ? '+' : '';
    changeAmountText = `${sign}${formatDecimal(delta, 3, 'preserve')}`;
    const numerator = exactMultiply(delta, previous > 0 ? '100' : '-100');
    const denominator = previous > 0 ? quote.prevClose : exactSubtract('0', quote.prevClose);
    changePercentText = `${exactCompare(numerator, '0') >= 0 ? '+' : ''}${formatRatio(numerator, denominator, 2, 'preserve')}%`;
  }

  return {
    nameText: quote.name ?? '-',
    codeText: symbol,
    priceText,
    changeAmountText,
    changePercentText,
  };
}

/**
 * 距回收价由原始比例一次展示舍入；旧formatter路径维持unsigned负零，与原生价格字段不同。
 * @param info 距回收价的原始分子/正分母；两者同时null表达未知
 * @param decimals 字段既定展示小数位
 * @returns 距离文本；无风险信息时返回null，内部损坏不伪装未知
 */
export function formatWarrantDistanceDisplay(
  info: WarrantDistanceInfo | null,
  decimals: number = DEFAULT_PERCENT_DECIMALS,
): string | null {
  if (info === null) return null;

  const { distanceNumerator, distanceDenominator } = info;
  if (distanceNumerator === null && distanceDenominator === null) return '距回收价=未知';

  if (distanceNumerator === null || distanceDenominator === null)
    throw new TypeError('Warrant distance basis must be jointly known or unknown');

  const numerator = exactMultiply(distanceNumerator, '100');
  return `距回收价=${exactCompare(numerator, '0') >= 0 ? '+' : ''}${formatRatio(numerator, distanceDenominator, decimals, 'unsigned')}%`;
}

/**
 * R1/N1派生金额一次展示舍入；价格/盈亏字段保留严格负数舍入为零的负号。
 * @param metrics 精确派生持仓指标或未获取值
 * @param orderCount 非负安全整数订单数或未获取值
 * @param decimals 字段既定展示小数位
 * @returns 既有标签及顺序的展示文本；内部损坏直接失败
 */
export function formatPositionDisplay(
  metrics: UnrealizedLossMetrics | null,
  orderCount: number | null,
  decimals: number = 2,
): string {
  if (orderCount !== null && (!Number.isSafeInteger(orderCount) || orderCount < 0))
    throw new RangeError('Display order count must be a nonnegative safe integer');

  if (metrics === null) return `持仓市值=- 持仓盈亏=- 订单数量=${orderCount ?? '-'}`;

  const market = formatDecimal(metrics.r2, decimals, 'preserve');
  const sign = exactCompare(metrics.unrealizedPnL, '0') >= 0 ? '+' : '';
  const pnl = `${sign}${formatDecimal(metrics.unrealizedPnL, decimals, 'preserve')}`;
  return `持仓市值=${market} 持仓盈亏=${pnl} 订单数量=${orderCount ?? '-'}`;
}
