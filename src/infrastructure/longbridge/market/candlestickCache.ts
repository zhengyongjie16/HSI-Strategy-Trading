/**
 * quoteClient K 线本地缓存模块
 *
 * 职责：
 * - 维护 symbol + period 维度的 K 线快照
 * - 处理订阅 seed 与 push 增量更新（append / replace / ignore-old-event）
 * - 提供只读快照读取与清理能力
 */
import type { CandlestickPeriod, CandlestickCacheSnapshot } from '../../../types/marketPorts.js';
import type { NormalizedCandle } from '../../../types/data.js';
import type {
  ApplyCandlestickPushParams,
  CandlestickCacheStore,
  SeedCandlestickSeriesParams,
} from './types.js';
import { mapCandlestick, mapCandlestickSeries } from './candlestickMapper.js';

/**
 * 创建缓存 key（symbol:period）。
 *
 * @param symbol 标的代码
 * @param period K 线周期
 * @returns 缓存 key
 */
function createCandlestickKey(symbol: string, period: CandlestickPeriod): string {
  return `${symbol}:${period}`;
}

/**
 * 判断两根 K 线语义是否一致（用于 push 幂等判定）。
 * 这里保留严格相等，以维持原有版本与事件语义。
 *
 * @param left 左值
 * @param right 右值
 * @returns 是否语义一致
 */
function areCandlesEqual(
  left: NormalizedCandle | undefined,
  right: NormalizedCandle | undefined,
): boolean {
  if (!left || !right) {
    return false;
  }

  return (
    left.timestamp === right.timestamp &&
    left.open === right.open &&
    left.high === right.high &&
    left.low === right.low &&
    left.close === right.close &&
    left.volume === right.volume
  );
}

/**
 * 判断两根 K 线字段是否精确一致（用于确认事件中的数据复用）。
 *
 * @param left 左值
 * @param right 右值
 * @returns 是否每个字段均保持精确表示
 */
function areCandlesExactlyEqual(
  left: NormalizedCandle | undefined,
  right: NormalizedCandle | undefined,
): boolean {
  if (!left || !right) {
    return false;
  }

  return (
    Object.is(left.timestamp, right.timestamp) &&
    Object.is(left.open, right.open) &&
    Object.is(left.high, right.high) &&
    Object.is(left.low, right.low) &&
    Object.is(left.close, right.close) &&
    Object.is(left.volume, right.volume)
  );
}

/**
 * 通过当前 candles 与 lastBarConfirmed 构造快照。
 *
 * @param params 快照构建参数
 * @returns CandlestickCacheSnapshot
 */
function buildSnapshot(params: {
  readonly symbol: string;
  readonly version: number;
  readonly candles: ReadonlyArray<NormalizedCandle>;
  readonly lastBarConfirmed: boolean | null;
}): CandlestickCacheSnapshot {
  const latestCandle = params.candles.at(-1);
  const lastBarTimestamp =
    latestCandle &&
    typeof latestCandle.timestamp === 'number' &&
    Number.isFinite(latestCandle.timestamp)
      ? latestCandle.timestamp
      : null;
  return {
    symbol: params.symbol,
    version: params.version,
    candles: params.candles,
    lastBarTimestamp,
    lastBarConfirmed: params.lastBarConfirmed,
    initialized: true,
  };
}

/**
 * 创建 K 线缓存存储。
 *
 * @param params 可选参数（maxCandles）
 * @returns 缓存存储对象
 */
export function createCandlestickCacheStore(params: {
  readonly maxCandles: number;
}): CandlestickCacheStore {
  return {
    maxCandles: params.maxCandles,
    snapshots: new Map<string, CandlestickCacheSnapshot>(),
  };
}

/**
 * 订阅 seed：写入初始 K 线快照。
 *
 * @param params seed 参数
 * @returns 写入后的快照
 */
export function seedCandlestickSeries(
  params: SeedCandlestickSeriesParams,
): CandlestickCacheSnapshot {
  const { store, symbol, period, candles } = params;
  const key = createCandlestickKey(symbol, period);
  const existing = store.snapshots.get(key) ?? null;
  const normalizedCandles = mapCandlestickSeries(candles, store.maxCandles);
  const nextVersion = existing === null ? 1 : existing.version + 1;
  const snapshot = buildSnapshot({
    symbol,
    version: nextVersion,
    candles: normalizedCandles,
    lastBarConfirmed: null,
  });
  store.snapshots.set(key, snapshot);
  return snapshot;
}

/**
 * 处理单条 push 更新。
 *
 * @param params push 参数
 * @returns 最新快照；若对应 key 尚未 seed 则返回 null
 */
export function applyCandlestickPush(
  params: ApplyCandlestickPushParams,
): CandlestickCacheSnapshot | null {
  const { store, symbol, period, candlestick, isConfirmed } = params;
  const key = createCandlestickKey(symbol, period);
  const currentSnapshot = store.snapshots.get(key) ?? null;
  if (currentSnapshot === null) {
    return null;
  }

  const normalizedCandle = mapCandlestick(candlestick);
  if (normalizedCandle?.timestamp === undefined) {
    return currentSnapshot;
  }

  const incomingTimestamp = normalizedCandle.timestamp;
  const lastTimestamp = currentSnapshot.lastBarTimestamp;
  const currentCandles = currentSnapshot.candles;
  if (lastTimestamp !== null && incomingTimestamp < lastTimestamp) {
    return currentSnapshot;
  }

  if (lastTimestamp !== null && incomingTimestamp === lastTimestamp) {
    // 收线确认具有单调性：同 timestamp 一旦 confirmed=true，后续 false 事件视为乱序旧事件直接忽略。
    if (currentSnapshot.lastBarConfirmed === true && !isConfirmed) {
      return currentSnapshot;
    }

    const nextLastBarConfirmed = currentSnapshot.lastBarConfirmed === true ? true : isConfirmed;
    const previousLastCandle = currentCandles.at(-1);
    const candleChanged = !areCandlesEqual(previousLastCandle, normalizedCandle);
    const confirmedChanged = currentSnapshot.lastBarConfirmed !== nextLastBarConfirmed;
    if (!candleChanged && !confirmedChanged) {
      return currentSnapshot;
    }

    // 事件门禁沿用严格相等；只有复用数据时才要求字段保持精确表示。
    const reuseCurrentCandle =
      !candleChanged && areCandlesExactlyEqual(previousLastCandle, normalizedCandle);
    const nextCandles = reuseCurrentCandle
      ? currentCandles
      : [...currentCandles.slice(0, -1), Object.freeze(normalizedCandle)];
    const updatedSnapshot = buildSnapshot({
      symbol,
      version: currentSnapshot.version + 1,
      candles: nextCandles,
      lastBarConfirmed: nextLastBarConfirmed,
    });
    store.snapshots.set(key, updatedSnapshot);
    return updatedSnapshot;
  }

  const frozenCandle = Object.freeze(normalizedCandle);
  const appendedCandles =
    currentCandles.length + 1 <= store.maxCandles
      ? [...currentCandles, frozenCandle]
      : [...currentCandles.slice(currentCandles.length + 1 - store.maxCandles), frozenCandle];
  const updatedSnapshot = buildSnapshot({
    symbol,
    version: currentSnapshot.version + 1,
    candles: appendedCandles,
    lastBarConfirmed: isConfirmed,
  });
  store.snapshots.set(key, updatedSnapshot);
  return updatedSnapshot;
}

/**
 * 读取指定 symbol + period 的快照。
 *
 * @param params 查询参数
 * @returns 快照，不存在时返回 null
 */
export function getCandlestickSnapshot(params: {
  readonly store: CandlestickCacheStore;
  readonly symbol: string;
  readonly period: CandlestickPeriod;
}): CandlestickCacheSnapshot | null {
  const key = createCandlestickKey(params.symbol, params.period);
  return params.store.snapshots.get(key) ?? null;
}

/**
 * 清理 K 线快照。
 * 未传 keys 时清空全部；传 keys 时仅删除指定 key。
 *
 * @param params 清理参数
 * @returns void
 */
export function clearCandlestickSnapshots(params: {
  readonly store: CandlestickCacheStore;
  readonly keys?: ReadonlyArray<{ readonly symbol: string; readonly period: CandlestickPeriod }>;
}): void {
  const { store, keys } = params;
  if (!keys || keys.length === 0) {
    store.snapshots.clear();
    return;
  }

  for (const key of keys) {
    store.snapshots.delete(createCandlestickKey(key.symbol, key.period));
  }
}
