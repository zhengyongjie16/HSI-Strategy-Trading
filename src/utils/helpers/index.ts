import type { BuySignalAction, SignalType } from '../../types/signal.js';

/**
 * 类型保护：判断 unknown 是否为可索引对象。
 *
 * @param value 待判断值
 * @returns true 表示可按键读取字段，否则返回 false
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * 检查值是否为有效的正数。
 *
 * @param value 待检查的值
 * @returns 为有限正数时返回 true，否则返回 false
 */
export function isValidPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * 判断是否为买入操作。
 *
 * @param action 信号类型
 * @returns 为 BUYCALL 或 BUYPUT 时返回 true
 */
export function isBuyAction(action: SignalType): action is BuySignalAction {
  return action === 'BUYCALL' || action === 'BUYPUT';
}
