/**
 * factor runtime 数值计算辅助模块
 *
 * 职责：
 * - 提供趋势、波动率、VWAP 与确认层共享的纯数值计算工具
 * - 将与业务决策无关的数学细节从主编排模块中拆出
 */
import type { NormalizedBar } from './types.js';

/**
 * 将未知值规整为有限数值。
 *
 * @param value 待检查值
 * @returns 有限数值，否则返回 null
 */
export function toSimpleNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * 从数组尾部截取指定数量的数据。
 *
 * @param bars 输入数组
 * @param count 截取数量
 * @returns 截取后的尾部数组
 */
export function sliceBarsFromEnd<Value>(
  bars: ReadonlyArray<Value>,
  count: number,
): ReadonlyArray<Value> {
  if (count <= 0) {
    return [];
  }

  if (bars.length <= count) {
    return bars;
  }

  return bars.slice(bars.length - count);
}

/**
 * 计算对数收益序列。
 *
 * @param bars 归一化后的 K 线集合
 * @returns 对数收益数组
 */
export function computeReturns(bars: ReadonlyArray<NormalizedBar>): ReadonlyArray<number> {
  const returns: number[] = [];
  for (let index = 1; index < bars.length; index += 1) {
    const previousClose = bars[index - 1]?.close;
    const currentClose = bars[index]?.close;
    if (
      previousClose === undefined ||
      currentClose === undefined ||
      previousClose <= 0 ||
      currentClose <= 0
    ) {
      continue;
    }

    returns.push(Math.log(currentClose / previousClose));
  }

  return returns;
}

/**
 * 计算实现波动率。
 *
 * @param returns 对数收益序列
 * @returns 实现波动率；无样本时返回 null
 */
export function computeRealizedVolatility(returns: ReadonlyArray<number>): number | null {
  if (returns.length === 0) {
    return null;
  }

  let squaredSum = 0;
  for (const value of returns) {
    squaredSum += value * value;
  }

  return Math.sqrt(squaredSum);
}

/**
 * 计算指定回看窗口的多空推进幅度。
 *
 * @param bars 归一化后的 K 线集合
 * @param lookback 回看长度
 * @returns 对数动量；样本不足时返回 null
 */
export function computeMomentum(
  bars: ReadonlyArray<NormalizedBar>,
  lookback: number,
): number | null {
  if (bars.length <= lookback) {
    return null;
  }

  const startBar = bars[bars.length - 1 - lookback];
  const endBar = bars.at(-1);
  if (!startBar || !endBar || startBar.close <= 0 || endBar.close <= 0) {
    return null;
  }

  return Math.log(endBar.close / startBar.close);
}

/**
 * 计算指定窗口的推进效率 ER。
 *
 * @param bars 归一化后的 K 线集合
 * @param lookback 回看长度
 * @returns ER 值；样本不足时返回 null
 */
export function computeEr(bars: ReadonlyArray<NormalizedBar>, lookback: number): number | null {
  if (bars.length <= lookback) {
    return null;
  }

  const windowBars = sliceBarsFromEnd(bars, lookback + 1);
  const firstBar = windowBars[0];
  const lastBar = windowBars.at(-1);
  if (!firstBar || !lastBar) {
    return null;
  }

  let denominator = 0;
  for (let index = 1; index < windowBars.length; index += 1) {
    const previousClose = windowBars[index - 1]?.close;
    const currentClose = windowBars[index]?.close;
    if (previousClose === undefined || currentClose === undefined) {
      continue;
    }

    denominator += Math.abs(currentClose - previousClose);
  }

  if (denominator <= 0) {
    return null;
  }

  return Math.abs(lastBar.close - firstBar.close) / denominator;
}

/**
 * 计算单根 K 线真实波幅序列。
 *
 * @param bars 归一化后的 K 线集合
 * @returns 真实波幅序列
 */
export function computeTrueRanges(bars: ReadonlyArray<NormalizedBar>): ReadonlyArray<number> {
  const trueRanges: number[] = [];
  for (let index = 0; index < bars.length; index += 1) {
    const bar = bars[index];
    if (!bar) {
      continue;
    }

    if (index === 0) {
      trueRanges.push(bar.high - bar.low);
      continue;
    }

    const previousClose = bars[index - 1]?.close;
    if (previousClose === undefined) {
      continue;
    }

    trueRanges.push(
      Math.max(
        bar.high - bar.low,
        Math.abs(bar.high - previousClose),
        Math.abs(bar.low - previousClose),
      ),
    );
  }

  return trueRanges;
}

/**
 * 计算数值均值。
 *
 * @param values 输入序列
 * @returns 均值；空序列返回 null
 */
export function average(values: ReadonlyArray<number>): number | null {
  if (values.length === 0) {
    return null;
  }

  let total = 0;
  for (const value of values) {
    total += value;
  }

  return total / values.length;
}

/**
 * 计算 ATR。
 *
 * @param bars 归一化后的 K 线集合
 * @param period 回看周期
 * @returns ATR；样本不足时返回 null
 */
export function computeAtr(bars: ReadonlyArray<NormalizedBar>, period: number): number | null {
  const ranges = computeTrueRanges(bars);
  if (ranges.length < period) {
    return null;
  }

  return average(sliceBarsFromEnd(ranges, period));
}

/**
 * 计算分位排名。
 *
 * @param series 历史样本序列
 * @param currentValue 当前值
 * @returns 分位数；样本不足时返回 null
 */
export function computePercentileRank(
  series: ReadonlyArray<number>,
  currentValue: number | null,
): number | null {
  if (series.length === 0 || currentValue === null) {
    return null;
  }

  let lessOrEqualCount = 0;
  for (const value of series) {
    if (value <= currentValue) {
      lessOrEqualCount += 1;
    }
  }

  return lessOrEqualCount / series.length;
}

/**
 * 计算 EMA 序列末端值。
 *
 * @param values 输入序列
 * @param period EMA 周期
 * @returns EMA 末端值；样本不足时返回 null
 */
export function computeEmaSeries(values: ReadonlyArray<number>, period: number): number | null {
  if (values.length < period) {
    return null;
  }

  const smoothing = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((total, value) => total + value, 0) / period;
  for (let index = period; index < values.length; index += 1) {
    const value = values[index];
    if (value === undefined) {
      continue;
    }

    ema = value * smoothing + ema * (1 - smoothing);
  }

  return ema;
}

/**
 * 计算 MACD。
 *
 * @param values 输入序列
 * @returns MACD 的 dif / dea / macd 值
 */
export function computeMacd(values: ReadonlyArray<number>): {
  readonly dif: number | null;
  readonly dea: number | null;
  readonly macd: number | null;
} {
  const fast = computeEmaSeries(values, 12);
  const slow = computeEmaSeries(values, 26);
  if (fast === null || slow === null) {
    return {
      dif: null,
      dea: null,
      macd: null,
    };
  }

  const dif = fast - slow;
  const macdBaseSeries: number[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const seriesFast = computeEmaSeries(values.slice(0, index + 1), 12);
    const seriesSlow = computeEmaSeries(values.slice(0, index + 1), 26);
    if (seriesFast !== null && seriesSlow !== null) {
      macdBaseSeries.push(seriesFast - seriesSlow);
    }
  }

  const dea = computeEmaSeries(macdBaseSeries, 9);
  return {
    dif,
    dea,
    macd: dea === null ? null : (dif - dea) * 2,
  };
}

/**
 * 对周期键值记录按周期从小到大排序。
 *
 * @param record 周期记录
 * @returns 排序后的键值对
 */
export function getSortedPeriodEntries(
  record: Readonly<Record<number, number>> | null,
): ReadonlyArray<readonly [number, number]> {
  if (!record) {
    return [];
  }

  return Object.entries(record)
    .map(([period, value]) => [Number(period), value] as const)
    .filter(([period, value]) => Number.isFinite(period) && Number.isFinite(value))
    .sort((left, right) => left[0] - right[0]);
}

/**
 * 读取周期记录的最小值与最大值。
 *
 * @param record 周期记录
 * @returns fast / slow 组合
 */
export function getRecordFastSlow(record: Readonly<Record<number, number>> | null): {
  readonly fast: number | null;
  readonly slow: number | null;
} {
  const entries = getSortedPeriodEntries(record);
  if (entries.length === 0) {
    return {
      fast: null,
      slow: null,
    };
  }

  return {
    fast: entries[0]?.[1] ?? null,
    slow: entries.at(-1)?.[1] ?? null,
  };
}

/**
 * 读取周期记录的均值。
 *
 * @param record 周期记录
 * @returns 均值；空记录返回 null
 */
export function getRecordAverage(record: Readonly<Record<number, number>> | null): number | null {
  const entries = getSortedPeriodEntries(record);
  if (entries.length === 0) {
    return null;
  }

  let total = 0;
  for (const [, value] of entries) {
    total += value;
  }

  return total / entries.length;
}

/**
 * 计算 VWAP 序列。
 *
 * @param bars 归一化后的 K 线集合
 * @returns 累积 VWAP 序列
 */
export function computeCumulativeVwapSeries(
  bars: ReadonlyArray<NormalizedBar>,
): ReadonlyArray<number> {
  if (bars.length === 0) {
    return [];
  }

  const series: number[] = [];
  let notional = 0;
  let volume = 0;
  for (const bar of bars) {
    const effectiveVolume = Math.max(bar.volume, 1);
    notional += bar.close * effectiveVolume;
    volume += effectiveVolume;
    series.push(notional / volume);
  }

  return series;
}

/**
 * 使用线性回归估计斜率。
 *
 * @param values 输入序列
 * @returns 斜率；样本不足时返回 null
 */
export function computeSlope(values: ReadonlyArray<number>): number | null {
  if (values.length < 2) {
    return null;
  }

  const n = values.length;
  const meanX = (n - 1) / 2;
  const meanY = values.reduce((total, value) => total + value, 0) / n;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < n; index += 1) {
    const deltaX = index - meanX;
    const value = values[index];
    if (value === undefined) {
      continue;
    }

    numerator += deltaX * (value - meanY);
    denominator += deltaX * deltaX;
  }

  if (denominator === 0) {
    return null;
  }

  return numerator / denominator;
}
