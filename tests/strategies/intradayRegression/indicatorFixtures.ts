/** 纯指标与中性行情数学 fixture：不创建策略实例、clock、timer 或 emitter。 */
import type {
  StrategyMarketContext,
  StrategyCandlestickSnapshot,
} from '../../../src/types/strategy.js';

/** 策略数学回归的本地 fixture，不经宿主旧画像替身。 */
import type {
  IndicatorUsageProfile,
  ProfileIndicator,
} from '../../../src/strategies/intradayRegression/profile/types.js';
import type { FixtureCandle } from './types.js';

export function createIndicatorUsageProfileDouble(overrides?: {
  readonly requiredFamilies?: Partial<IndicatorUsageProfile['requiredFamilies']>;
  readonly requiredPeriods?: Partial<IndicatorUsageProfile['requiredPeriods']>;
  readonly verificationIndicatorsBySide?: Partial<
    IndicatorUsageProfile['verificationIndicatorsBySide']
  >;
  readonly displayPlan?: ReadonlyArray<ProfileIndicator>;
}): IndicatorUsageProfile {
  const requiredFamilies: IndicatorUsageProfile['requiredFamilies'] = {
    mfi: overrides?.requiredFamilies?.mfi ?? true,
    kdj: overrides?.requiredFamilies?.kdj ?? true,
    macd: overrides?.requiredFamilies?.macd ?? true,
    adx: overrides?.requiredFamilies?.adx ?? true,
  };
  const requiredPeriods: IndicatorUsageProfile['requiredPeriods'] = {
    rsi: overrides?.requiredPeriods?.rsi ?? [6],
    ema: overrides?.requiredPeriods?.ema ?? [7],
    psy: overrides?.requiredPeriods?.psy ?? [13],
  };

  const verificationIndicatorsBySide: IndicatorUsageProfile['verificationIndicatorsBySide'] = {
    buy: overrides?.verificationIndicatorsBySide?.buy ?? ['K', 'D', 'J'],
    sell: overrides?.verificationIndicatorsBySide?.sell ?? ['K', 'D', 'J'],
  };

  const defaultDisplayPlan: ReadonlyArray<ProfileIndicator> = [
    ...requiredPeriods.ema.map((period) => `EMA:${period}` as const),
    ...requiredPeriods.rsi.map((period) => `RSI:${period}` as const),
    ...(requiredFamilies.mfi ? (['MFI'] as const) : []),
    ...requiredPeriods.psy.map((period) => `PSY:${period}` as const),
    ...(requiredFamilies.kdj ? (['K', 'D', 'J'] as const) : []),
    ...(requiredFamilies.adx ? (['ADX'] as const) : []),
    ...(requiredFamilies.macd ? (['MACD', 'DIF', 'DEA'] as const) : []),
  ];

  return {
    requiredFamilies,
    requiredPeriods,
    verificationIndicatorsBySide,
    displayPlan: overrides?.displayPlan ?? defaultDisplayPlan,
  };
}

/** 只在旧数学 fixture 边界标准化 primitive，保持缺失/非有限值。 */
export function normalizeCandles(
  candles: ReadonlyArray<FixtureCandle>,
): StrategyCandlestickSnapshot['candles'] {
  return candles.map((candle) =>
    Object.freeze({
      ...(typeof candle.timestamp === 'number' ? { timestamp: candle.timestamp } : {}),
      open: primitive(candle.open),
      high: primitive(candle.high),
      low: primitive(candle.low),
      close: primitive(candle.close),
      volume: primitive(candle.volume),
    }),
  );
}

function primitive(value: FixtureCandle['close']): number | string | null | undefined {
  return typeof value === 'object' && value !== null ? value.toString() : value;
}

/** 固定高低区间生成可控 KDJ 活动柱快照，默认两方向均有已成交买单。 */
export function marketContext(
  close = 50,
  version = 1,
  observedAtMs = 1_700_000_000_000,
): StrategyMarketContext {
  return {
    candlesticks: {
      symbol: 'HSI.HK',
      version,
      initialized: true,
      lastBarTimestamp: 1200000,
      lastBarConfirmed: false,
      candles: Array.from({ length: 21 }, (_, index) => ({
        timestamp: index * 60000,
        open: 50,
        high: 100,
        low: 1,
        close: index === 20 ? close : 50,
        volume: 1000,
      })),
    },
    observedAtMs,
    allowNewEvaluation: true,
    seats: [
      { direction: 'LONG', symbol: 'BULL.HK', hasFilledBuyOrders: true },
      { direction: 'SHORT', symbol: 'BEAR.HK', hasFilledBuyOrders: true },
    ],
  };
}
