/** 策略对象配置与依赖离线 fixture。 */
import { parseStrategyConfig } from '../../../../src/core/strategy/intradayRegression/config.js';
import { createIntradayRegressionStrategy } from '../../../../src/core/strategy/intradayRegression/index.js';
import { Period } from 'longbridge';
import type {
  PreparedStrategy,
  StrategyDeps,
  StrategyMarketContext,
  StrategyCandlestickSnapshot,
} from '../../../../src/core/strategy/types.js';
import type { ConfigFixture, Harness, TimerEntry } from './types.js';

/** 策略数学回归的本地 fixture，不经宿主旧画像替身。 */
import type {
  IndicatorUsageProfile,
  DisplayIndicatorItem,
} from '../../../../src/core/strategy/intradayRegression/profile/types.js';
import type { CandleData } from '../../../../src/types/data.js';

export function createIndicatorUsageProfileDouble(overrides?: {
  readonly requiredFamilies?: Partial<IndicatorUsageProfile['requiredFamilies']>;
  readonly requiredPeriods?: Partial<IndicatorUsageProfile['requiredPeriods']>;
  readonly verificationIndicatorsBySide?: Partial<
    IndicatorUsageProfile['verificationIndicatorsBySide']
  >;
  readonly displayPlan?: ReadonlyArray<DisplayIndicatorItem>;
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

  const defaultDisplayPlan: ReadonlyArray<DisplayIndicatorItem> = [
    'price',
    'changePercent',
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
  candles: ReadonlyArray<CandleData>,
): StrategyCandlestickSnapshot['candles'] {
  return candles.map((candle) => ({
    ...(typeof candle.timestamp === 'number' ? { timestamp: candle.timestamp } : {}),
    open: primitive(candle.open),
    high: primitive(candle.high),
    low: primitive(candle.low),
    close: primitive(candle.close),
    volume: primitive(candle.volume),
  }));
}

function primitive(value: CandleData['close']): number | string | null | undefined {
  return typeof value === 'object' && value !== null ? value.toString() : value;
}

/** 产生全显式离线配置，测试参数不写入正式 config.json。 */
export function configObject(
  buyDelay = 0,
  sellDelay = 0,
  buyIndicators: ReadonlyArray<string> = [],
  sellIndicators: ReadonlyArray<string> = [],
): ConfigFixture {
  return {
    signals: {
      BUYCALL: '(K>-1000)',
      SELLCALL: '(K>-1000)',
      BUYPUT: '(K>-1000)',
      SELLPUT: '(K>-1000)',
    },
    verification: {
      buy: { delaySeconds: buyDelay, indicators: buyIndicators },
      sell: { delaySeconds: sellDelay, indicators: sellIndicators },
    },
  };
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
      period: Period.Min_1,
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

/** 注入可控时钟与 scheduler，不睡眠、不在登记栈运行回调。 */
export function createHarness(): Harness {
  let now = 1_700_000_000_000;
  let reads: number[] = [];
  const events: string[] = [];
  const errors: unknown[] = [];
  const timers: TimerEntry[] = [];
  const deps: StrategyDeps = {
    clock: {
      now() {
        const value = reads.shift() ?? now;
        events.push(`clock:${value}`);
        return new Date(value);
      },
    },
    scheduler: {
      scheduleTimer(callback, delay) {
        events.push(`timer:${delay}`);
        const handle = setTimeout(() => {}, 0);
        clearTimeout(handle);
        timers.push({ callback, delay, handle, cleared: false });
        return handle;
      },
      clearTimer(handle) {
        const entry = timers.find((timer) => timer.handle === handle);
        if (entry) entry.cleared = true;
      },
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    onFatalError(error) {
      errors.push(error);
      events.push('fatal');
    },
  };
  return {
    deps,
    timers,
    events,
    errors,
    setNow(value) {
      now = value;
    },
    setReads(values) {
      reads = [...values];
    },
  };
}

/** 准备测试自定义配置；生产 definition 始终使用静态 JSON。 */
export function prepareFixture(value: unknown): PreparedStrategy {
  const config = parseStrategyConfig(value);
  return { create: (deps: StrategyDeps) => createIntradayRegressionStrategy(config, deps) };
}
