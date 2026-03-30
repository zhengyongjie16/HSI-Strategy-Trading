/**
 * 行情监控模块
 *
 * 功能：
 * - 监控做多/做空标的价格变化
 * - 监控单实例基础对象的 factor 快照变化
 * - 输出价格、持仓与 factor 摘要，避免继续依赖旧指标兼容层
 */
import { logger } from '../../utils/logger/index.js';
import { toHongKongTimeLog } from '../../utils/time/index.js';
import {
  formatQuoteDisplay,
  buildIndicatorDisplayString,
  formatPositionDisplay,
  formatWarrantDistanceDisplay,
  hasChanged,
} from './utils.js';
import { LOG_COLORS, MONITOR } from '../../constants/index.js';
import type { StrategyState } from '../../types/state.js';
import type { FactorSnapshot } from '../../types/factor.js';
import type { Quote } from '../../types/quote.js';
import type { MonitorIndicatorChangesParams, MarketMonitor, PriceDisplayInfo } from './types.js';

/**
 * 格式化 K 线时间戳为日志前缀（仅显示时分秒）。
 *
 * @param timestamp 时间戳（毫秒），为 0 或 falsy 时不显示
 * @returns 格式化的时间前缀字符串，如 "[K线时间: 10:30:15] " 或空字符串
 */
function formatKlineTimePrefix(timestamp: number | null | undefined): string {
  if (timestamp && Number.isFinite(timestamp)) {
    const timeStr = toHongKongTimeLog(new Date(timestamp));
    return `[K线时间: ${timeStr.split(' ')[1]}] `;
  }

  return '';
}

/**
 * 从因子快照与行情信息构造展示签名。
 *
 * @param params 当前价格、涨跌幅与 factor 快照
 * @returns 用于变化检测的展示签名
 */
function buildDisplaySignature(params: {
  readonly currentPrice: number;
  readonly changePercent: number | null;
  readonly factorSnapshot: FactorSnapshot | null;
}): string {
  const priceText = Number.isFinite(params.currentPrice) ? params.currentPrice.toFixed(3) : 'NaN';
  const changeText =
    params.changePercent === null || !Number.isFinite(params.changePercent)
      ? 'NaN'
      : params.changePercent.toFixed(2);
  const factorText = buildIndicatorDisplayString(params.factorSnapshot);
  return `P=${priceText}|C=${changeText}|${factorText}`;
}

/**
 * 格式化当前价格文本。
 *
 * @param price 当前价格
 * @returns 显示价格文本
 */
function formatCurrentPriceText(price: number): string {
  return Number.isFinite(price) ? price.toFixed(3) : '-';
}

/**
 * 格式化涨跌幅文本。
 *
 * @param changePercent 涨跌幅（百分比）
 * @returns 显示涨跌幅文本
 */
function formatChangePercentText(changePercent: number | null): string {
  if (changePercent === null || !Number.isFinite(changePercent)) {
    return '-';
  }

  const prefix = changePercent >= 0 ? '+' : '';
  return `${prefix}${changePercent.toFixed(2)}%`;
}

/**
 * 构造监控标的 factor 日志文本。
 *
 * @param params 当前价格、涨跌幅、factor 快照及展示前缀
 * @returns 完整日志文本
 */
function buildMonitorIndicatorLogText(params: {
  readonly timePrefix: string;
  readonly baseInstrumentName: string;
  readonly baseInstrumentSymbol: string;
  readonly currentPrice: number;
  readonly changePercent: number | null;
  readonly factorSnapshot: FactorSnapshot;
}): string {
  const factorText = buildIndicatorDisplayString(params.factorSnapshot);
  const priceText = formatCurrentPriceText(params.currentPrice);
  const changeText = formatChangePercentText(params.changePercent);
  return (
    `${LOG_COLORS.cyan}${params.timePrefix}[监控标的] ` +
    `${params.baseInstrumentName}(${params.baseInstrumentSymbol}) ` +
    `价格=${priceText} 涨跌幅=${changeText} 因子=${factorText}${LOG_COLORS.reset}`
  );
}

/**
 * 将标的行情与距回收价信息格式化并输出到日志。
 *
 * @param quote 行情数据，可为 null
 * @param symbol 标的代码
 * @param label 显示标签（如「做多标的」）
 * @param displayInfo 展示附加信息（距回收价、持仓市值/持仓盈亏、持仓数量）
 * @returns void
 */
function displayQuoteInfo(
  quote: Quote | null,
  symbol: string,
  label: string,
  displayInfo: PriceDisplayInfo | null,
): void {
  const display = formatQuoteDisplay(quote, symbol);
  if (display) {
    const timePrefix = formatKlineTimePrefix(quote?.timestamp);
    const distanceText = formatWarrantDistanceDisplay(displayInfo?.warrantDistanceInfo ?? null);
    const distanceSuffix = distanceText ? ` ${distanceText}` : '';
    const positionRealtimeText = formatPositionDisplay(
      displayInfo?.unrealizedLossMetrics ?? null,
      displayInfo?.positionCount ?? null,
    );
    logger.info(
      `${timePrefix}[${label}] ${display.nameText}(${display.codeText}) 最新价格=${display.priceText} 涨跌额=${display.changeAmountText} 涨跌幅度=${display.changePercentText}${distanceSuffix} ${positionRealtimeText}`,
    );
  } else {
    logger.warn(`未获取到${label}行情。`);
  }
}

/**
 * 创建行情监控器，供主循环每 tick 调用以检测价格与 factor 变化并输出到控制台。
 *
 * 职责：监控做多/做空标的价格变化、监控基础对象 factor 摘要变化，并格式化显示。
 */
export function createMarketMonitor(): MarketMonitor {
  return {
    monitorPriceChanges: (
      longQuote: Quote | null,
      shortQuote: Quote | null,
      longSymbol: string,
      shortSymbol: string,
      monitorState: StrategyState,
      longDisplayInfo: PriceDisplayInfo | null = null,
      shortDisplayInfo: PriceDisplayInfo | null = null,
    ): boolean => {
      const longPrice = longQuote?.price;
      const shortPrice = shortQuote?.price;

      const longPriceChanged =
        monitorState.longPrice === null && Number.isFinite(longPrice)
          ? true
          : hasChanged(
              longPrice ?? null,
              monitorState.longPrice ?? null,
              MONITOR.PRICE_CHANGE_THRESHOLD,
            );

      const shortPriceChanged =
        monitorState.shortPrice === null && Number.isFinite(shortPrice)
          ? true
          : hasChanged(
              shortPrice ?? null,
              monitorState.shortPrice ?? null,
              MONITOR.PRICE_CHANGE_THRESHOLD,
            );

      if (longPriceChanged || shortPriceChanged) {
        displayQuoteInfo(longQuote, longSymbol, '做多标的', longDisplayInfo);
        displayQuoteInfo(shortQuote, shortSymbol, '做空标的', shortDisplayInfo);

        if (Number.isFinite(longPrice)) {
          monitorState.longPrice = longPrice ?? null;
        }

        if (Number.isFinite(shortPrice)) {
          monitorState.shortPrice = shortPrice ?? null;
        }

        return true;
      }

      return false;
    },

    monitorIndicatorChanges: (params: MonitorIndicatorChangesParams): boolean => {
      const { monitorSnapshot, monitorQuote, baseInstrumentSymbol, klineTimestamp, monitorState } =
        params;

      if (!monitorSnapshot) {
        return false;
      }

      const factorSnapshot = monitorSnapshot.factorSnapshot ?? null;
      if (!factorSnapshot) {
        logger.warn(
          `未获取到监控标的 ${baseInstrumentSymbol} 的 factor 快照，跳过本次 factor 展示`,
        );
        return false;
      }

      const currentPrice = monitorSnapshot.price;
      const prevClose = monitorQuote?.prevClose ?? null;
      let changePercent: number | null = null;
      if (
        Number.isFinite(currentPrice) &&
        currentPrice > 0 &&
        Number.isFinite(prevClose) &&
        prevClose !== null &&
        prevClose > 0
      ) {
        changePercent = ((currentPrice - prevClose) / prevClose) * 100;
      }

      const signature = buildDisplaySignature({
        currentPrice,
        changePercent,
        factorSnapshot,
      });
      if (monitorState.lastDisplaySignature === signature) {
        return false;
      }

      const baseInstrumentName = monitorQuote?.name ?? baseInstrumentSymbol;
      const timePrefix = formatKlineTimePrefix(klineTimestamp);
      logger.info(
        buildMonitorIndicatorLogText({
          timePrefix,
          baseInstrumentName,
          baseInstrumentSymbol,
          currentPrice,
          changePercent,
          factorSnapshot,
        }),
      );

      monitorState.lastDisplaySignature = signature;
      monitorState.lastMonitorSnapshot = monitorSnapshot;
      return true;
    },
  };
}
