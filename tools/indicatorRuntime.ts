/**
 * tools 指标计算模块
 *
 * 职责：
 * - 为 `tools/*` 提供独立的低阶指标计算能力
 * - 避免工具脚本重新依赖已删除的 `src/services/indicators` 旧实现
 * - 只覆盖工具当前实际需要的 EMA / RSI / MFI / KDJ / MACD 与快照构造
 */
import type { CandleData } from '../src/types/data.js';
import type { IndicatorComputationProfile } from '../src/types/indicatorProfile.js';
import type { IndicatorSnapshot, KDJIndicator, MACDIndicator } from '../src/types/quote.js';

function toNumber(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}

function isFinitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function roundToFixed(value: number, digits: number = 2): number {
  return Number(value.toFixed(digits));
}

/**
 * 计算 EMA。
 *
 * @param candles K 线数组
 * @param period EMA 周期
 * @returns EMA 值或 null
 */
export function calculateEMA(candles: ReadonlyArray<CandleData>, period: number): number | null {
  if (!Number.isInteger(period) || period <= 0 || candles.length < period) {
    return null;
  }

  let seedCount = 0;
  let seedSum = 0;
  let emaValue: number | null = null;
  const multiplier = 2 / (period + 1);
  for (const candle of candles) {
    const close = toNumber(candle.close);
    if (!isFinitePositive(close)) {
      continue;
    }

    if (emaValue === null) {
      seedSum += close;
      seedCount += 1;
      if (seedCount === period) {
        emaValue = seedSum / period;
      }

      continue;
    }

    emaValue = emaValue + (close - emaValue) * multiplier;
  }

  return emaValue === null ? null : roundToFixed(emaValue);
}

/**
 * 计算 RSI。
 *
 * @param candles K 线数组
 * @param period RSI 周期
 * @returns RSI 值或 null
 */
export function calculateRSI(candles: ReadonlyArray<CandleData>, period: number): number | null {
  if (!Number.isInteger(period) || period <= 0 || candles.length <= period) {
    return null;
  }

  let previousClose: number | null = null;
  let seedDiffCount = 0;
  let seedUpSum = 0;
  let seedDownSum = 0;
  let smoothUp = 0;
  let smoothDown = 0;
  let lastValue: number | null = null;
  for (const candle of candles) {
    const close = toNumber(candle.close);
    if (!isFinitePositive(close)) {
      continue;
    }

    if (previousClose === null) {
      previousClose = close;
      continue;
    }

    const upward = close > previousClose ? close - previousClose : 0;
    const downward = close < previousClose ? previousClose - close : 0;
    if (seedDiffCount < period) {
      seedUpSum += upward;
      seedDownSum += downward;
      seedDiffCount += 1;
      if (seedDiffCount === period) {
        smoothUp = seedUpSum / period;
        smoothDown = seedDownSum / period;
        lastValue = smoothUp + smoothDown === 0 ? 100 : 100 * (smoothUp / (smoothUp + smoothDown));
      }
    } else {
      smoothUp = (smoothUp * (period - 1) + upward) / period;
      smoothDown = (smoothDown * (period - 1) + downward) / period;
      lastValue = smoothUp + smoothDown === 0 ? 100 : 100 * (smoothUp / (smoothUp + smoothDown));
    }

    previousClose = close;
  }

  return lastValue === null ? null : roundToFixed(lastValue);
}

/**
 * 计算 MFI。
 *
 * @param candles K 线数组
 * @param period MFI 周期
 * @returns MFI 值或 null
 */
export function calculateMFI(
  candles: ReadonlyArray<CandleData>,
  period: number = 14,
): number | null {
  if (!Number.isInteger(period) || period <= 0 || candles.length < period + 1) {
    return null;
  }

  let previousTypicalPrice: number | null = null;
  const positiveFlows: number[] = [];
  const negativeFlows: number[] = [];
  for (const candle of candles) {
    const high = toNumber(candle.high);
    const low = toNumber(candle.low);
    const close = toNumber(candle.close);
    const volume = toNumber(candle.volume ?? 0);
    if (
      !isFinitePositive(high) ||
      !isFinitePositive(low) ||
      !isFinitePositive(close) ||
      !Number.isFinite(volume) ||
      volume < 0
    ) {
      continue;
    }

    const typicalPrice = (high + low + close) / 3;
    if (previousTypicalPrice === null) {
      previousTypicalPrice = typicalPrice;
      continue;
    }

    const moneyFlow = typicalPrice * volume;
    positiveFlows.push(typicalPrice > previousTypicalPrice ? moneyFlow : 0);
    negativeFlows.push(typicalPrice < previousTypicalPrice ? moneyFlow : 0);
    previousTypicalPrice = typicalPrice;
  }

  if (positiveFlows.length < period || negativeFlows.length < period) {
    return null;
  }

  const positiveSum = positiveFlows.slice(-period).reduce((sum, value) => sum + value, 0);
  const negativeSum = negativeFlows.slice(-period).reduce((sum, value) => sum + value, 0);
  const denominator = positiveSum + negativeSum;
  if (denominator <= 0) {
    return null;
  }

  return roundToFixed((positiveSum / denominator) * 100);
}

/**
 * 计算 KDJ。
 *
 * @param candles K 线数组
 * @param period RSV 周期
 * @returns KDJ 值或 null
 */
export function calculateKDJ(
  candles: ReadonlyArray<CandleData>,
  period: number = 9,
): KDJIndicator | null {
  if (!Number.isInteger(period) || period <= 0 || candles.length < period) {
    return null;
  }

  let k = 50;
  let d = 50;
  for (let index = period - 1; index < candles.length; index += 1) {
    const window = candles.slice(index - period + 1, index + 1);
    const highs = window.map((candle) => toNumber(candle.high)).filter(Number.isFinite);
    const lows = window.map((candle) => toNumber(candle.low)).filter(Number.isFinite);
    const close = toNumber(candles[index]?.close);
    if (
      !Number.isFinite(close) ||
      highs.length !== window.length ||
      lows.length !== window.length
    ) {
      continue;
    }

    const highestHigh = Math.max(...highs);
    const lowestLow = Math.min(...lows);
    const range = highestHigh - lowestLow;
    if (!Number.isFinite(range) || range === 0) {
      continue;
    }

    const rsv = ((close - lowestLow) / range) * 100;
    k = (2 * k + rsv) / 3;
    d = (2 * d + k) / 3;
  }

  const j = 3 * k - 2 * d;
  if (!Number.isFinite(k) || !Number.isFinite(d) || !Number.isFinite(j)) {
    return null;
  }

  return {
    k: roundToFixed(k),
    d: roundToFixed(d),
    j: roundToFixed(j),
  };
}

/**
 * 计算 MACD。
 *
 * @param candles K 线数组
 * @param fastPeriod 快线周期
 * @param slowPeriod 慢线周期
 * @param signalPeriod 信号线周期
 * @returns MACD 值或 null
 */
export function calculateMACD(
  candles: ReadonlyArray<CandleData>,
  fastPeriod: number = 12,
  slowPeriod: number = 26,
  signalPeriod: number = 9,
): MACDIndicator | null {
  if (
    !Number.isInteger(fastPeriod) ||
    !Number.isInteger(slowPeriod) ||
    !Number.isInteger(signalPeriod) ||
    fastPeriod <= 0 ||
    slowPeriod <= 0 ||
    signalPeriod <= 0 ||
    candles.length < slowPeriod + signalPeriod
  ) {
    return null;
  }

  let fastSeedSum = 0;
  let fastSeedCount = 0;
  let fastEma: number | null = null;
  const fastMultiplier = 2 / (fastPeriod + 1);

  let slowSeedSum = 0;
  let slowSeedCount = 0;
  let slowEma: number | null = null;
  const slowMultiplier = 2 / (slowPeriod + 1);

  let signalSeedSum = 0;
  let signalSeedCount = 0;
  let signalEma: number | null = null;
  const signalMultiplier = 2 / (signalPeriod + 1);

  let dif: number | null = null;
  for (const candle of candles) {
    const close = toNumber(candle.close);
    if (!isFinitePositive(close)) {
      continue;
    }

    if (fastEma === null) {
      fastSeedSum += close;
      fastSeedCount += 1;
      if (fastSeedCount === fastPeriod) {
        fastEma = fastSeedSum / fastPeriod;
      }
    } else {
      fastEma = fastEma + (close - fastEma) * fastMultiplier;
    }

    if (slowEma === null) {
      slowSeedSum += close;
      slowSeedCount += 1;
      if (slowSeedCount === slowPeriod) {
        slowEma = slowSeedSum / slowPeriod;
      }
    } else {
      slowEma = slowEma + (close - slowEma) * slowMultiplier;
    }

    if (fastEma === null || slowEma === null) {
      continue;
    }

    dif = fastEma - slowEma;
    if (signalEma === null) {
      signalSeedSum += dif;
      signalSeedCount += 1;
      if (signalSeedCount === signalPeriod) {
        signalEma = signalSeedSum / signalPeriod;
      }

      continue;
    }

    signalEma = signalEma + (dif - signalEma) * signalMultiplier;
  }

  if (dif === null || signalEma === null) {
    return null;
  }

  return {
    dif: roundToFixed(dif),
    dea: roundToFixed(signalEma),
    macd: roundToFixed((dif - signalEma) * 2),
  };
}

function buildPeriodRecord(
  periods: ReadonlyArray<number>,
  calculator: (period: number) => number | null,
): Readonly<Record<number, number>> | null {
  if (periods.length === 0) {
    return null;
  }

  const record: Record<number, number> = {};
  let hasValue = false;
  for (const period of periods) {
    const value = calculator(period);
    if (value === null) {
      continue;
    }

    record[period] = value;
    hasValue = true;
  }

  return hasValue ? record : null;
}

/**
 * 为工具脚本构造指标快照。
 *
 * @param symbol 标的代码
 * @param candles K 线数组
 * @param indicatorProfile 指标画像
 * @returns 指标快照或 null
 */
export function buildIndicatorSnapshot(
  symbol: string,
  candles: ReadonlyArray<CandleData>,
  indicatorProfile: IndicatorComputationProfile,
): IndicatorSnapshot | null {
  if (candles.length === 0) {
    return null;
  }

  const latestClose = toNumber(candles.at(-1)?.close);
  if (!isFinitePositive(latestClose)) {
    return null;
  }

  const previousClose = candles.length >= 2 ? toNumber(candles.at(-2)?.close) : Number.NaN;
  const changePercent =
    isFinitePositive(previousClose) && previousClose !== 0
      ? ((latestClose - previousClose) / previousClose) * 100
      : null;

  return {
    symbol,
    price: latestClose,
    changePercent,
    ema: buildPeriodRecord(indicatorProfile.requiredPeriods.ema, (period) => {
      return calculateEMA(candles, period);
    }),
    rsi: buildPeriodRecord(indicatorProfile.requiredPeriods.rsi, (period) => {
      return calculateRSI(candles, period);
    }),
    psy: buildPeriodRecord(indicatorProfile.requiredPeriods.psy, () => null),
    mfi: indicatorProfile.requiredFamilies.mfi ? calculateMFI(candles) : null,
    kdj: indicatorProfile.requiredFamilies.kdj ? calculateKDJ(candles) : null,
    macd: indicatorProfile.requiredFamilies.macd ? calculateMACD(candles) : null,
    adx: null,
  };
}
