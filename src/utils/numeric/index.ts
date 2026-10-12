import BigNumber from 'bignumber.js';
import type { DecimalInput } from './types.js';
import { canonicalDecimal } from './exact.js';

/**
 * 将实际指标number或结构数量文本转换为独立十进制比较值，不接纳SDK Decimal。
 * 金融文本从原文校验，不经Number投影；number仅供已有指标/安全数量调用边界使用。
 * @param value 指标有限number或规范数量文本
 * @returns 保真的独立BigNumber比较值
 */
function toDecimalValue(value: DecimalInput): BigNumber {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Invalid numeric comparison input');

    return new BigNumber(value.toString());
  }

  return new BigNumber(canonicalDecimal(value));
}

/**
 * 按独立十进制值比较严格小于，保留现有指标与数量的比较边界。
 * @param left 左比较值
 * @param right 右比较值
 * @returns left严格小于right
 */
export function decimalLt(left: DecimalInput, right: DecimalInput): boolean {
  return toDecimalValue(left).isLessThan(toDecimalValue(right));
}

/**
 * 按独立十进制值比较严格大于，保留恢复数量与指标的比较边界。
 * @param left 左比较值
 * @param right 右比较值
 * @returns left严格大于right
 */
export function decimalGt(left: DecimalInput, right: DecimalInput): boolean {
  return toDecimalValue(left).isGreaterThan(toDecimalValue(right));
}
