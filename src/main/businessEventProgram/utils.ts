import type { CandleData } from '../../types/data.js';
import type { CandlestickCacheSnapshot } from '../../types/services.js';
import type { StrategyCandlestickSnapshot, StrategyDecision } from '../../core/strategy/types.js';

/**
 * 保留 primitive 原值，把 SDK Decimal 脱离缓存转换为字符串。
 * @param value 权威缓存字段
 * @returns 不含缓存对象引用的字段值
 */
function projectCandleValue(value: CandleData['close']): number | string | null | undefined {
  return typeof value === 'object' && value !== null ? value.toString() : value;
}

/**
 * 深冻结完整 K 线投影；不补缺失值，不按版本过滤策略采样。
 * @param snapshot 当前权威缓存快照
 * @returns 与缓存后续 mutation 隔离的只读行情
 */
export function projectCandlesticks(
  snapshot: CandlestickCacheSnapshot,
): StrategyCandlestickSnapshot {
  return Object.freeze({
    symbol: snapshot.symbol,
    period: snapshot.period,
    version: snapshot.version,
    initialized: snapshot.initialized,
    lastBarTimestamp: snapshot.lastBarTimestamp,
    lastBarConfirmed: snapshot.lastBarConfirmed,
    candles: Object.freeze(
      snapshot.candles.map((candle) =>
        Object.freeze({
          ...(candle.timestamp === undefined ? {} : { timestamp: candle.timestamp }),
          open: projectCandleValue(candle.open),
          high: projectCandleValue(candle.high),
          low: projectCandleValue(candle.low),
          close: projectCandleValue(candle.close),
          volume: projectCandleValue(candle.volume),
        }),
      ),
    ),
  });
}

/**
 * 检查可无损映射 Date 的整数毫秒，避免 NaN、越界和小数截断。
 * @param value 时间值
 * @returns 是否为有效毫秒
 */
export function isValidTimeMs(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isInteger(value) && new Date(value).getTime() === value
  );
}

/**
 * 检查完整有效的交易日键，拒绝空值和日期归一化产生的伪日期。
 * @param value 生命周期交易日键
 * @returns 是否为有效 YYYY-MM-DD
 */
export function isValidDayKey(value: string | null): value is string {
  if (value === null || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * 严格验证自身键和字段形状，并拷贝白名单决策，拒绝 accessor/额外授权字段。
 * @param value 策略输出的不可信边界对象
 * @returns 已验证决策；内部契约损坏时抛错，由调用边界同步报告 fatal
 */
export function validateDecision(value: unknown): StrategyDecision {
  if (typeof value !== 'object' || value === null) {
    throw new Error('策略 decision 必须是普通对象');
  }

  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('策略 decision 必须是普通对象');
  }

  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => key !== 'action' && key !== 'triggerTimeMs' && key !== 'reason')) {
    throw new Error('策略 decision 存在白名单之外的自身字段');
  }

  const actionDescriptor = Object.getOwnPropertyDescriptor(value, 'action');
  const timeDescriptor = Object.getOwnPropertyDescriptor(value, 'triggerTimeMs');
  const reasonDescriptor = Object.getOwnPropertyDescriptor(value, 'reason');
  if (
    !actionDescriptor ||
    !timeDescriptor ||
    keys.some((key) => !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value'))
  ) {
    throw new Error('策略 decision 缺少字段或含 accessor');
  }

  const action: unknown = actionDescriptor.value;
  const triggerTimeMs: unknown = timeDescriptor.value;
  const reason: unknown = reasonDescriptor?.value;
  if (
    action !== 'BUYCALL' &&
    action !== 'BUYPUT' &&
    action !== 'SELLCALL' &&
    action !== 'SELLPUT'
  ) {
    throw new Error('策略 decision action 非法');
  }

  if (!isValidTimeMs(triggerTimeMs)) {
    throw new Error('策略 decision triggerTimeMs 非法');
  }

  if (reasonDescriptor !== undefined && typeof reason !== 'string') {
    throw new Error('策略 decision reason 非法');
  }

  return { action, triggerTimeMs, ...(typeof reason === 'string' ? { reason } : {}) };
}
