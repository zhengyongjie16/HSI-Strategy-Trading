/**
 * 牛熊证风险检查：缓存中性回收价文本，阈值通过原始距离分子与回收价交叉相乘判断。
 * 百分比除法只用于最终日志/显示；不把显示舍入用于买入、清仓或换标判断。
 */
import { logger } from '../../utils/logger/index.js';
import { formatSymbolDisplay } from '../../utils/display/index.js';
import { formatError } from '../../utils/error/index.js';
import { isExternalApiRequestError, isProgramError } from '../../utils/apiFailure/index.js';
import {
  canonicalDecimal,
  exactCompare,
  exactMultiply,
  exactSubtract,
  formatDecimal,
  formatRatio,
} from '../../utils/numeric/exact.js';
import {
  BULL_WARRANT_MIN_DISTANCE_PERCENT,
  BEAR_WARRANT_MAX_DISTANCE_PERCENT,
  BULL_WARRANT_LIQUIDATION_DISTANCE_PERCENT,
  BEAR_WARRANT_LIQUIDATION_DISTANCE_PERCENT,
  MIN_MONITOR_PRICE_THRESHOLD,
  DEFAULT_PRICE_DECIMALS,
  DEFAULT_PERCENT_DECIMALS,
  WARRANT_TYPE_NAMES,
} from '../../constants/index.js';
import type { SignalType } from '../../types/signal.js';
import type {
  BullBearWarrantType,
  MarketDataClient,
  RiskCheckResult,
  WarrantDistanceInfo,
  WarrantDistanceLiquidationResult,
  WarrantRefreshResult,
} from '../../types/services.js';
import type { WarrantInfo, WarrantRiskChecker } from './types.js';

/** 沿用轮证类型识别规则；类型枚举不是金融数据。 */
function parseWarrantType(category: unknown): BullBearWarrantType | null {
  if (category === 3 || category === 'Bull' || category === 'BULL') return 'BULL';

  if (category === 4 || category === 'Bear' || category === 'BEAR') return 'BEAR';

  return null;
}

/** 合法非正回收价沿旧业务拒绝；非法内部文本立即失败。 */
function validateCallPrice(symbol: string, callPrice: string | null): RiskCheckResult | null {
  if (callPrice === null || exactCompare(callPrice, '0') <= 0) {
    logger.warn(`[风险检查] ${symbol} 的回收价无效（${callPrice}），拒绝买入`);
    return {
      allowed: false,
      reason: `回收价无效（${callPrice}），无法进行牛熊证风险检查，拒绝买入`,
    };
  }

  return null;
}

/** 监控价格仍须满足原监控标的最小有效价；不把牛熊证本身价格误作监控价。 */
function validateMonitorPrice(price: string): RiskCheckResult | null {
  if (exactCompare(price, '0') <= 0)
    return { allowed: false, reason: `监控标的价格无效（${price}），无法进行牛熊证风险检查` };

  if (exactCompare(price, MIN_MONITOR_PRICE_THRESHOLD) < 0)
    return {
      allowed: false,
      reason: `监控标的价格异常（${price}），无法进行牛熊证风险检查，拒绝买入`,
    };

  return null;
}

/** 买入/静态清仓使用的百分比分子：原始价差乘 100，回收价为已验证正分母。 */
function distancePercentNumerator(price: string, callPrice: string): string {
  return exactMultiply(exactSubtract(price, callPrice), '100');
}

/**
 * 获取中性轮证事实，先验证文本再返回；查询失败不替换已有缓存。
 * SDK 原值映射只允许在 market adapter 内完成。
 */
async function checkWarrantType(
  client: MarketDataClient,
  symbol: string,
  expectedType: 'CALL' | 'PUT',
): Promise<WarrantInfo> {
  const context = await client.getQuoteContext();
  const quotes = await context.warrantQuote([symbol]);
  const quote = quotes[0];
  if (!quote) return { isWarrant: false };

  const warrantType = parseWarrantType(quote.category);
  if (warrantType === null) return { isWarrant: false };

  const callPrice =
    quote.callPrice === null || quote.callPrice === undefined
      ? null
      : canonicalDecimal(quote.callPrice);
  if ((expectedType === 'CALL') !== (warrantType === 'BULL')) {
    logger.warn(
      `[风险检查警告] ${symbol} 的牛熊证类型不符合预期：期望${expectedType === 'CALL' ? '牛证' : '熊证'}，实际是${WARRANT_TYPE_NAMES[warrantType]}`,
    );
  }

  return { isWarrant: true, warrantType, callPrice, symbol };
}

/** 创建独立方向缓存的检查器；金融显示保持旧 formatDecimal 的 unsigned 负零政策。 */
export function createWarrantRiskChecker(): WarrantRiskChecker {
  let longWarrantInfo: WarrantInfo | null = null;
  let shortWarrantInfo: WarrantInfo | null = null;

  /** 查询完成后发布对应方向缓存；明确外部请求错误保留原错误与旧缓存。 */
  async function initializeSymbolWarrantInfo(
    client: MarketDataClient,
    symbol: string,
    isLong: boolean,
    name: string | null,
  ): Promise<WarrantRefreshResult> {
    let info: WarrantInfo;
    try {
      info = await checkWarrantType(client, symbol, isLong ? 'CALL' : 'PUT');
    } catch (error) {
      if (isExternalApiRequestError(error) || isProgramError(error) || error instanceof RangeError)
        throw error;

      const reason = formatError(error);
      logger.warn(
        `[风险检查] 检查${isLong ? '做多' : '做空'}标的 ${formatSymbolDisplay(symbol, name)} 牛熊证信息时出错：`,
        reason,
      );
      return { status: 'error', isWarrant: false, reason };
    }

    if (isLong) longWarrantInfo = info;
    else shortWarrantInfo = info;

    if (!info.isWarrant) {
      logger.info(
        `[风险检查] ${isLong ? '做多' : '做空'}标的 ${formatSymbolDisplay(symbol, name)} 不是牛熊证`,
      );
      return { status: 'notWarrant', isWarrant: false };
    }

    logger.info(
      `[风险检查] ${isLong ? '做多' : '做空'}标的 ${formatSymbolDisplay(symbol, name)} 是${WARRANT_TYPE_NAMES[info.warrantType]}，回收价=${info.callPrice === null ? '未知' : formatDecimal(info.callPrice, 3, 'unsigned')}`,
    );
    return { status: 'ok', isWarrant: true };
  }

  /** 买入阈值保持牛证严格小于拒绝、熊证严格大于拒绝，不比较舍入后的比率。 */
  function checkRisk(
    symbol: string,
    signalType: SignalType,
    monitorCurrentPrice: string,
  ): RiskCheckResult {
    const info = signalType === 'BUYCALL' ? longWarrantInfo : shortWarrantInfo;
    if (!info?.isWarrant) return { allowed: true };

    const invalid =
      validateCallPrice(symbol, info.callPrice) ?? validateMonitorPrice(monitorCurrentPrice);
    if (invalid !== null) return invalid;

    const callPrice = info.callPrice;
    if (callPrice === null) throw new TypeError('Validated warrant call price is missing');

    const numerator = distancePercentNumerator(monitorCurrentPrice, callPrice);
    const bull = info.warrantType === 'BULL';
    const threshold = bull ? BULL_WARRANT_MIN_DISTANCE_PERCENT : BEAR_WARRANT_MAX_DISTANCE_PERCENT;
    const comparison = exactCompare(numerator, exactMultiply(threshold, callPrice));
    const rejected = bull ? comparison < 0 : comparison > 0;
    const percent = formatRatio(numerator, callPrice, DEFAULT_PERCENT_DECIMALS, 'unsigned');
    const prefix = bull ? '牛证' : '熊证';
    const comparisonText = bull ? '低于' : '高于';
    const reason = rejected
      ? `${prefix}距离回收价百分比为 ${percent}%，${comparisonText}${formatDecimal(threshold, DEFAULT_PERCENT_DECIMALS, 'unsigned')}%阈值，停止买入（回收价=${formatDecimal(callPrice, DEFAULT_PRICE_DECIMALS, 'unsigned')}，监控标的当前价=${formatDecimal(monitorCurrentPrice, DEFAULT_PRICE_DECIMALS, 'unsigned')}）`
      : `${prefix}距离回收价百分比为 ${percent}%，在安全范围内`;
    return {
      allowed: !rejected,
      reason,
      warrantInfo: {
        isWarrant: true,
        warrantType: info.warrantType,
        distanceToStrikePercent: percent,
      },
    };
  }

  /** 静态清仓包含阈值等号；数量/持仓授权由调用方最终门禁负责。 */
  function checkWarrantDistanceLiquidation(
    symbol: string,
    isLong: boolean,
    price: string,
  ): WarrantDistanceLiquidationResult {
    const info = isLong ? longWarrantInfo : shortWarrantInfo;
    if (!info?.isWarrant) return { shouldLiquidate: false };

    if (validateCallPrice(symbol, info.callPrice) !== null)
      return {
        shouldLiquidate: false,
        warrantType: info.warrantType,
        distancePercent: null,
        reason: `回收价无效（${info.callPrice}），无法进行距回收价清仓判断`,
      };

    if (validateMonitorPrice(price) !== null)
      return {
        shouldLiquidate: false,
        warrantType: info.warrantType,
        distancePercent: null,
        reason: `监控标的价格无效（${price}），无法进行距回收价清仓判断`,
      };

    const callPrice = info.callPrice;
    if (callPrice === null) throw new TypeError('Validated warrant call price is missing');

    const numerator = distancePercentNumerator(price, callPrice);
    const bull = info.warrantType === 'BULL';
    const threshold = bull
      ? BULL_WARRANT_LIQUIDATION_DISTANCE_PERCENT
      : BEAR_WARRANT_LIQUIDATION_DISTANCE_PERCENT;
    const comparison = exactCompare(numerator, exactMultiply(threshold, callPrice));
    const shouldLiquidate = bull ? comparison <= 0 : comparison >= 0;
    const percent = formatRatio(numerator, callPrice, DEFAULT_PERCENT_DECIMALS, 'unsigned');
    const prefix = bull ? '牛证' : '熊证';
    const prices = `回收价=${formatDecimal(callPrice, DEFAULT_PRICE_DECIMALS, 'unsigned')}，监控标的当前价=${formatDecimal(price, DEFAULT_PRICE_DECIMALS, 'unsigned')}`;
    const comparisonText = bull ? '低于或等于' : '高于或等于';
    return {
      shouldLiquidate,
      warrantType: info.warrantType,
      distancePercent: percent,
      reason: shouldLiquidate
        ? `${prefix}距离回收价百分比为 ${percent}%，${comparisonText}${threshold}%阈值，触发清仓（${prices}）`
        : `${prefix}距离回收价百分比为 ${percent}%，未触发清仓阈值（${prices}）`,
    };
  }

  /** 距离事实保留未乘 100 的原始价差/正回收价；百分比单位换算由换标和显示消费者各执行一次。 */
  function getWarrantDistanceInfo(
    isLong: boolean,
    symbol: string,
    price: string | null,
  ): WarrantDistanceInfo | null {
    const info = isLong ? longWarrantInfo : shortWarrantInfo;
    if (!symbol || !info?.isWarrant || info.symbol !== symbol) return null;

    const callPrice = info.callPrice;
    if (
      callPrice === null ||
      exactCompare(callPrice, '0') <= 0 ||
      price === null ||
      exactCompare(price, '0') <= 0
    ) {
      return { warrantType: info.warrantType, distanceNumerator: null, distanceDenominator: null };
    }

    return {
      warrantType: info.warrantType,
      distanceNumerator: exactSubtract(price, callPrice),
      distanceDenominator: callPrice,
    };
  }

  /** 已知回收价无需外部查询；无效业务值不清掉之前合法的方向事实。 */
  function setWarrantInfoFromCallPrice(
    symbol: string,
    callPrice: string,
    isLong: boolean,
    name: string | null = null,
  ): WarrantRefreshResult {
    if (exactCompare(callPrice, '0') <= 0)
      return {
        status: 'error',
        isWarrant: false,
        reason: `回收价无效（${callPrice}），无法设置牛熊证信息`,
      };

    const info: WarrantInfo = {
      isWarrant: true,
      warrantType: isLong ? 'BULL' : 'BEAR',
      callPrice: canonicalDecimal(callPrice),
      symbol,
    };
    if (isLong) longWarrantInfo = info;
    else shortWarrantInfo = info;

    logger.info(
      `[风险检查] ${isLong ? '做多' : '做空'}标的 ${formatSymbolDisplay(symbol, name)}，回收价=${formatDecimal(callPrice, 3, 'unsigned')}`,
    );
    return { status: 'ok', isWarrant: true };
  }

  /** API 刷新只在提供客户端时执行，不制造缺省行情/回收价。 */
  async function refreshWarrantInfoForSymbol(
    client: MarketDataClient | null,
    symbol: string,
    isLong: boolean,
    name: string | null = null,
  ): Promise<WarrantRefreshResult> {
    if (!client) return { status: 'skipped', isWarrant: false };

    return initializeSymbolWarrantInfo(client, symbol, isLong, name);
  }
  return {
    checkRisk,
    checkWarrantDistanceLiquidation,
    getWarrantDistanceInfo,
    setWarrantInfoFromCallPrice,
    refreshWarrantInfoForSymbol,
    clearLongWarrantInfo: () => {
      longWarrantInfo = null;
    },
    clearShortWarrantInfo: () => {
      shortWarrantInfo = null;
    },
  };
}
