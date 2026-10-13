/** K 线 SDK 数值与时间边界：只为既有指标算法投影 primitive OHLCV，不用于财务价格计算。 */
import type { NormalizedCandle } from '../../../types/data.js';
import { isRecord } from '../../../utils/helpers/index.js';

function normalizeRecordToNumber(value: Record<string, unknown>): number | undefined {
  const toNumberFn: unknown = Reflect.get(value, 'toNumber');
  if (typeof toNumberFn !== 'function') {
    return undefined;
  }

  const normalized: unknown = Reflect.apply(toNumberFn, value, []);
  return typeof normalized === 'number' && Number.isFinite(normalized) ? normalized : undefined;
}

/**
 * 标准化 K 线数值字段。
 *
 * @param value 原始字段值
 * @returns 标准化后的 primitive 值
 */
function normalizeCandleValue(value: unknown): number | string | null | undefined {
  if (
    value === null ||
    value === undefined ||
    typeof value === 'number' ||
    typeof value === 'string'
  ) {
    return value;
  }

  if (isRecord(value)) {
    return normalizeRecordToNumber(value);
  }

  return undefined;
}

/**
 * 标准化 K 线时间戳（毫秒）。
 *
 * @param value 原始 timestamp 字段
 * @returns 有效毫秒时间戳；无效时返回 undefined
 */
function normalizeTimestamp(value: unknown): number | undefined {
  if (value instanceof Date) {
    const timestamp = value.getTime();
    return Number.isFinite(timestamp) ? timestamp : undefined;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : undefined;
  }

  return undefined;
}

/**
 * 标准化单根 K 线。
 *
 * @param candle 原始 K 线
 * @returns 标准化 K 线（当结构非法时返回 null）
 */
export function mapCandlestick(candle: unknown): NormalizedCandle | null {
  if (!isRecord(candle)) {
    return null;
  }

  const normalizedTimestamp = normalizeTimestamp(candle['timestamp']);
  return {
    open: normalizeCandleValue(candle['open']),
    high: normalizeCandleValue(candle['high']),
    low: normalizeCandleValue(candle['low']),
    close: normalizeCandleValue(candle['close']),
    volume: normalizeCandleValue(candle['volume']),
    ...(normalizedTimestamp === undefined ? {} : { timestamp: normalizedTimestamp }),
  };
}

/**
 * 标准化 K 线序列并裁剪到最大长度。
 *
 * @param candles 原始 K 线序列
 * @param maxCandles 最大保留根数
 * @returns 标准化后的 K 线数组
 */
export function mapCandlestickSeries(
  candles: ReadonlyArray<unknown>,
  maxCandles: number,
): ReadonlyArray<NormalizedCandle> {
  const normalized: NormalizedCandle[] = [];
  for (const candle of candles) {
    const normalizedCandle = mapCandlestick(candle);
    if (normalizedCandle !== null) {
      normalized.push(normalizedCandle);
    }
  }

  const retained =
    normalized.length <= maxCandles ? normalized : normalized.slice(normalized.length - maxCandles);
  for (const candle of retained) {
    Object.freeze(candle);
  }

  return retained;
}
