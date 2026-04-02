/**
 * Decimal 辅助（Mock）
 *
 * 功能：
 * - 统一处理 Mock 场景下的数值到 Decimal 转换
 */
import { Decimal } from 'longbridge';
import type { MockDecimalInput } from './types.js';

/**
 * 将字符串、数字或 Decimal 统一转换为 Decimal 实例。
 * 若已是 Decimal 则直接返回，避免重复构造。
 * @param value 待转换的数值，支持 string、number 或 Decimal
 * @returns 对应的 Decimal 实例
 */
export function toMockDecimal(value: MockDecimalInput): Decimal {
  if (value instanceof Decimal) {
    return value;
  }

  return new Decimal(value);
}
