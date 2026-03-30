import type { StrategyState } from '../../types/state.js';
import type { StrategyRuntimeConfig } from '../../types/config.js';
import type { SignalType } from '../../types/signal.js';
import type { DecimalLike } from './types.js';

/**
 * 类型保护：判断 unknown 是否为可索引对象。
 * 默认行为：仅当 typeof value === 'object' 且 value !== null 时返回 true，否则返回 false。
 *
 * @param value 待判断值
 * @returns true 表示可按键读取字段，否则返回 false
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * 将 Decimal 类型转换为数字。默认行为：null/undefined 返回 NaN，便于调用方用 Number.isFinite() 判断。
 *
 * @param decimalLike Decimal 对象、数字、字符串或 null/undefined
 * @returns 转换后的数字，null/undefined 时返回 NaN
 */
export function decimalToNumber(
  decimalLike: DecimalLike | number | string | null | undefined,
): number {
  if (decimalLike === null || decimalLike === undefined) {
    return Number.NaN;
  }

  if (typeof decimalLike === 'object' && 'toNumber' in decimalLike) {
    return decimalLike.toNumber();
  }

  return Number(decimalLike);
}

/**
 * 检查值是否为有效的正数（有限且大于 0）。默认行为：非 number 或非正数返回 false。
 *
 * @param value 待检查的值
 * @returns 为有限正数时返回 true，否则返回 false
 */
export function isValidPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * 判断是否为买入操作。默认行为：无。
 *
 * @param action 信号类型
 * @returns 为 BUYCALL 或 BUYPUT 时返回 true
 */
export function isBuyAction(action: SignalType): boolean {
  return action === 'BUYCALL' || action === 'BUYPUT';
}

/**
 * 根据单实例运行时配置初始化策略状态。默认行为：无；所有可更新字段初始为 null 或空。
 *
 * @param config 单实例运行时配置（baseInstrumentSymbol 等）
 * @returns 初始化的 StrategyState
 */
export function createStrategyState(config: StrategyRuntimeConfig): StrategyState {
  return {
    baseInstrumentSymbol: config.baseInstrumentSymbol,
    monitorPrice: null,
    longPrice: null,
    shortPrice: null,
    signal: null,
    pendingSignals: [],
    lastMonitorSnapshot: null,
    lastCandlestickCacheVersion: null,
  };
}
