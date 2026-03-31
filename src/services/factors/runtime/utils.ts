/**
 * factor runtime 数值计算辅助模块
 *
 * 职责：
 * - 提供趋势、波动率、VWAP 与确认层共享的纯数值计算工具
 * - 将与业务决策无关的数学细节从主编排模块中拆出
 */

import type { TradingSessionPhase } from '../../../types/factor';
import type { HongKongParts, NormalizedBar } from './types';

const HONG_KONG_TIMEZONE = 'Asia/Hong_Kong';
const HONG_KONG_PARTS_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: HONG_KONG_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
export const MORNING_SESSION_START = 9 * 60 + 30;
export const MORNING_SESSION_END = 12 * 60;
export const AFTERNOON_SESSION_START = 13 * 60;
export const AFTERNOON_SESSION_END = 16 * 60;

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
function computeTrueRanges(bars: ReadonlyArray<NormalizedBar>): ReadonlyArray<number> {
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
function average(values: ReadonlyArray<number>): number | null {
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
 * 计算完整 EMA 有效序列。
 *
 * @param values 输入序列
 * @param period EMA 周期
 * @returns 从首个有效 EMA 开始的连续 EMA 序列
 */
function computeEmaValueSeries(
  values: ReadonlyArray<number>,
  period: number,
): ReadonlyArray<number> {
  if (values.length < period) {
    return [];
  }

  const smoothing = 2 / (period + 1);
  const series: number[] = [];
  let seedSum = 0;
  let ema: number | null = null;
  for (const [index, value] of values.entries()) {
    if (index < period - 1) {
      seedSum += value;
      continue;
    }

    if (index === period - 1) {
      ema = (seedSum + value) / period;
      series.push(ema);
      continue;
    }

    if (ema === null) {
      continue;
    }

    ema = value * smoothing + ema * (1 - smoothing);
    series.push(ema);
  }

  return series;
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
  const fastSeries = computeEmaValueSeries(values, 12);
  const slowSeries = computeEmaValueSeries(values, 26);
  if (fastSeries.length === 0 || slowSeries.length === 0) {
    return {
      dif: null,
      dea: null,
      macd: null,
    };
  }

  const fastOffset = 12 - 1;
  const slowOffset = 26 - 1;
  const fastStartIndex = slowOffset - fastOffset;
  const macdBaseSeries: number[] = [];
  for (const [index, slowValue] of slowSeries.entries()) {
    const fastValue = fastSeries[index + fastStartIndex];
    if (fastValue === undefined) {
      continue;
    }

    macdBaseSeries.push(fastValue - slowValue);
  }

  const dif = macdBaseSeries.at(-1) ?? null;
  const dea = computeEmaSeries(macdBaseSeries, 9);
  return {
    dif,
    dea,
    macd: dif === null || dea === null ? null : (dif - dea) * 2,
  };
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

/**
 * 读取香港时区日期和分钟数。
 *
 * @param timestamp 时间戳
 * @returns 香港日期键与日内分钟数
 */
export function getHongKongParts(timestamp: number): HongKongParts {
  const parts = HONG_KONG_PARTS_FORMATTER.formatToParts(new Date(timestamp));
  let year = '';
  let month = '';
  let day = '';
  let hour = '';
  let minute = '';
  for (const part of parts) {
    if (part.type === 'year') {
      year = part.value;
      continue;
    }

    if (part.type === 'month') {
      month = part.value;
      continue;
    }

    if (part.type === 'day') {
      day = part.value;
      continue;
    }

    if (part.type === 'hour') {
      hour = part.value;
      continue;
    }

    if (part.type === 'minute') {
      minute = part.value;
    }
  }

  return {
    dayKey: `${year}-${month}-${day}`,
    minuteOfDay: Number(hour) * 60 + Number(minute),
  };
}

/**
 * 将分钟数映射到交易 session。
 *
 * @param minuteOfDay 香港时间分钟数
 * @returns session 标识
 */
export function getSessionPhase(minuteOfDay: number): TradingSessionPhase {
  if (minuteOfDay >= MORNING_SESSION_START && minuteOfDay < MORNING_SESSION_END) {
    return 'am';
  }

  if (minuteOfDay >= AFTERNOON_SESSION_START && minuteOfDay < AFTERNOON_SESSION_END) {
    return 'pm';
  }

  return 'closed';
}

/**
 * 按香港日期键过滤 bars。
 *
 * @param bars 归一化后的 K 线集合
 * @param dayKey 香港日期键
 * @returns 指定交易日的 bars
 */
export function filterBarsByDayKey(
  bars: ReadonlyArray<NormalizedBar>,
  dayKey: string,
): ReadonlyArray<NormalizedBar> {
  return bars.filter((bar) => bar.dayKey === dayKey);
}

/**
 * 按 session 过滤 bars。
 *
 * @param bars 归一化后的 K 线集合
 * @param session 交易 session
 * @returns 指定 session 的 bars
 */
export function filterBarsBySession(
  bars: ReadonlyArray<NormalizedBar>,
  session: Exclude<TradingSessionPhase, 'closed'>,
): ReadonlyArray<NormalizedBar> {
  return bars.filter((bar) => getSessionPhase(bar.minuteOfDay) === session);
}

/**
 * 收集历史交易日键。
 *
 * @param params bars/currentDayKey/lookbackDays
 * @returns 历史交易日键数组
 */
export function collectRecentTradingDayKeys(params: {
  readonly bars: ReadonlyArray<NormalizedBar>;
  readonly currentDayKey: string;
  readonly lookbackDays: number;
}): ReadonlyArray<string> {
  const maxDays = Math.max(0, Math.floor(params.lookbackDays));
  if (maxDays === 0) {
    return [];
  }

  const dayKeys: string[] = [];
  const seen = new Set<string>();
  for (let index = params.bars.length - 1; index >= 0; index -= 1) {
    const bar = params.bars[index];
    if (!bar) {
      continue;
    }

    const { dayKey } = bar;
    if (dayKey === params.currentDayKey || seen.has(dayKey)) {
      continue;
    }

    seen.add(dayKey);
    dayKeys.push(dayKey);
    if (dayKeys.length >= maxDays) {
      break;
    }
  }

  return dayKeys;
}

/**
 * 提取指定交易日、指定 session、截至某分钟的 bars。
 *
 * @param params bars/dayKey/session/cutoffMinuteOfDay
 * @returns 过滤后的 bars
 */
export function sliceSessionBarsForDay(params: {
  readonly bars: ReadonlyArray<NormalizedBar>;
  readonly dayKey: string;
  readonly session: Exclude<TradingSessionPhase, 'closed'>;
  readonly cutoffMinuteOfDay: number;
}): ReadonlyArray<NormalizedBar> {
  return params.bars.filter((bar) => {
    if (bar.dayKey !== params.dayKey) {
      return false;
    }

    if (params.session === 'am') {
      return (
        bar.minuteOfDay >= MORNING_SESSION_START && bar.minuteOfDay <= params.cutoffMinuteOfDay
      );
    }

    return (
      bar.minuteOfDay >= AFTERNOON_SESSION_START && bar.minuteOfDay <= params.cutoffMinuteOfDay
    );
  });
}

/**
 * 判定是否处于策略噪音窗口。
 *
 * @param params 时间戳与开盘结构规则
 * @returns 是否被噪音窗口拦截
 */
export function isBlockedByNoiseWindow(params: {
  readonly timestamp: number | null;
  readonly rules: {
    readonly morningNoiseWindowMinutes: number;
    readonly afternoonNoiseWindowMinutes: number;
  };
}): boolean {
  if (params.timestamp === null) {
    return true;
  }

  const { minuteOfDay } = getHongKongParts(params.timestamp);
  const amNoiseEnd = MORNING_SESSION_START + params.rules.morningNoiseWindowMinutes;
  const pmNoiseEnd = AFTERNOON_SESSION_START + params.rules.afternoonNoiseWindowMinutes;
  return (
    (minuteOfDay >= MORNING_SESSION_START && minuteOfDay < amNoiseEnd) ||
    (minuteOfDay >= AFTERNOON_SESSION_START && minuteOfDay < pmNoiseEnd)
  );
}
