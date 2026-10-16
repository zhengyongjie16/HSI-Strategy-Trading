/**
 * marketMonitor 模块
 *
 * 职责：
 * - 作为终端显示纯渲染器，直接格式化并输出 monitor indicators / trading quote
 * - 不再承担任何本地变化检测与显示缓存所有权
 */
import { logger } from '../../logger/index.js';
import { toHongKongTimeLog } from '../../../utils/time/index.js';
import {
  formatQuoteDisplay,
  formatPositionDisplay,
  formatWarrantDistanceDisplay,
} from './utils.js';
import { LOG_COLORS } from '../../../constants/index.js';
import {
  exactCompare,
  exactMultiply,
  exactSubtract,
  formatDecimal,
  formatRatio,
} from '../../../utils/numeric/exact.js';
import type { Quote } from '../../../types/quote.js';
import type {
  MarketMonitor,
  RenderMonitorIndicatorsParams,
  RenderTradingQuoteParams,
} from '../../../types/display.js';

function formatKlineTimePrefix(timestamp: number | null | undefined): string {
  if (timestamp && Number.isFinite(timestamp)) {
    const timeText = toHongKongTimeLog(new Date(timestamp));
    return `[K线时间: ${timeText.split(' ')[1]}] `;
  }

  return '';
}

function calculateChangePercentText(currentPrice: string | null, prevClose: string | null): string {
  if (
    currentPrice === null ||
    prevClose === null ||
    exactCompare(currentPrice, '0') <= 0 ||
    exactCompare(prevClose, '0') <= 0
  )
    return '-';

  const numerator = exactMultiply(exactSubtract(currentPrice, prevClose), '100');
  return `${exactCompare(numerator, '0') >= 0 ? '+' : ''}${formatRatio(numerator, prevClose, 2, 'preserve')}%`;
}

function resolveTradingQuoteLabel(direction: RenderTradingQuoteParams['direction']): string {
  return direction === 'LONG' ? '做多标的' : '做空标的';
}

function resolveDisplayQuote(params: RenderTradingQuoteParams): Quote | null {
  if (params.event.symbol !== params.tradingSymbol) {
    return null;
  }

  return params.event.quote;
}

function renderTradingQuote(params: RenderTradingQuoteParams): void {
  const label = resolveTradingQuoteLabel(params.direction);
  const quote = resolveDisplayQuote(params);
  const display = formatQuoteDisplay(quote, params.tradingSymbol);
  if (display === null) {
    logger.warn(`未获取到${label}行情。`);
    return;
  }

  const timePrefix = formatKlineTimePrefix(quote?.timestamp);
  const distanceText = formatWarrantDistanceDisplay(
    params.displayInfo?.warrantDistanceInfo ?? null,
  );
  const distanceSuffix = distanceText ? ` ${distanceText}` : '';
  const positionText = formatPositionDisplay(
    params.displayInfo?.unrealizedLossMetrics ?? null,
    params.displayInfo?.orderCount ?? null,
  );
  logger.info(
    `${timePrefix}[${label}] ${display.nameText}(${display.codeText}) 最新价格=${display.priceText} 涨跌额=${display.changeAmountText} 涨跌幅度=${display.changePercentText}${distanceSuffix} ${positionText}`,
  );
}

/**
 * 渲染监控标的指标日志。
 * 策略决定指标标签、顺序和文本；宿主只补充实时行情事实，不解释具体指标。
 *
 * @param params 策略显示投影、monitor quote、monitorSymbol 与缓存 K 线时间
 */
function renderMonitorIndicators(params: RenderMonitorIndicatorsParams): void {
  const currentPrice = params.monitorQuote?.price ?? null;
  const prevClose = params.monitorQuote?.prevClose ?? null;
  const changePercentText = calculateChangePercentText(currentPrice, prevClose);
  const priceText = currentPrice === null ? '-' : formatDecimal(currentPrice, 3, 'preserve');
  const indicators = [
    `价格=${priceText}`,
    `涨跌幅=${changePercentText}`,
    ...params.items.map((item) => `${item.label}=${item.valueText}`),
  ];

  const monitorSymbolName = params.monitorQuote?.name ?? params.monitorSymbol;
  const timePrefix = formatKlineTimePrefix(params.klineTimestamp);
  logger.info(
    `${LOG_COLORS.cyan}${timePrefix}[监控标的] ${monitorSymbolName}(${params.monitorSymbol}) ${indicators.join(' ')}${LOG_COLORS.reset}`,
  );
}

export function createMarketMonitor(): MarketMonitor {
  return {
    renderTradingQuote,
    renderMonitorIndicators,
  };
}
