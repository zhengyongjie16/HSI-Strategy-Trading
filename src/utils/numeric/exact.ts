/* eslint-disable unicorn/require-number-to-fixed-digits-argument -- BigNumber.toFixed() 无参数表示保真序列化，不能传 0 量化原值。 */
import BigNumber from 'bignumber.js';

// 库自身可表达的最大指数范围，不对历史文本或系数长度另设业务上限。
// clone 不公开；财务值只以普通十进制文本跨越此模块边界。
const Numeric = BigNumber.clone({ RANGE: [-1000000000, 1000000000] });

/**
 * 解析普通十进制财务文本；拒绝 number、指数、非有限值及非零下溢。
 * @param text 原始普通十进制文本，不接受隐式转换
 * @returns 私有精确值
 */
function parse(text: string): BigNumber {
  if (typeof text !== 'string' || !/^[+-]?\d+(?:\.\d+)?$/.test(text)) {
    throw new TypeError('Financial input must be plain decimal text');
  }

  const unsigned = text.replace(/^[+-]/, '');
  const first = unsigned.search(/[1-9]/);
  const dot = unsigned.indexOf('.');
  const point = dot === -1 ? unsigned.length : dot;
  const exponent = point - first - (first < point ? 1 : 0);
  const range = Numeric.config().RANGE;
  if (!Array.isArray(range)) {
    throw new TypeError('Private decimal range invariant violated');
  }

  if (first !== -1 && (exponent < range[0] || exponent > range[1])) {
    throw new RangeError('Decimal input exceeds library exponent range');
  }

  const value = new Numeric(text);
  return checked(value, first !== -1);
}

/**
 * 验证库结果有限，且预期非零的精确运算未发生下溢。
 * @param value 库运算结果
 * @param nonzero 精确数学结果是否非零
 * @returns 已验证的私有值
 */
function checked(value: BigNumber, nonzero: boolean): BigNumber {
  if (!value.isFinite() || (nonzero && value.isZero())) {
    throw new RangeError('Exact decimal overflow or nonzero underflow');
  }

  return value;
}

/**
 * 验证严格正分母；+0 与 -0 均非法。
 * @param text 分母文本
 * @returns 严格正的私有值
 */
function positive(text: string): BigNumber {
  const value = parse(text);
  if (!value.gt('0')) {
    throw new RangeError('Denominator must be strictly positive');
  }

  return value;
}

/**
 * 精确加法；不对中间状态量化。
 * @param left 左财务文本
 * @param right 右财务文本
 * @returns 无指数、无尾零的精确文本
 */
export function exactAdd(left: string, right: string): string {
  const a = parse(left);
  const b = parse(right);
  return checked(a.plus(b), !a.eq(b.negated())).toFixed();
}

/**
 * 精确减法，保留低位权威金额修订。
 * @param left 左财务文本
 * @param right 右财务文本
 * @returns 精确差额文本
 */
export function exactSubtract(left: string, right: string): string {
  const a = parse(left);
  const b = parse(right);
  return checked(a.minus(b), !a.eq(b)).toFixed();
}

/**
 * 精确乘法，不经过 number 或显示舍入。
 * @param left 左财务文本
 * @param right 右财务文本
 * @returns 精确乘积文本
 */
export function exactMultiply(left: string, right: string): string {
  const a = parse(left);
  const b = parse(right);
  return checked(a.multipliedBy(b), !a.isZero() && !b.isZero()).toFixed();
}

/**
 * 精确数值比较；非法内部状态立即失败。
 * @param left 左财务文本
 * @param right 右财务文本
 * @returns -1、0 或 1
 */
export function exactCompare(left: string, right: string): -1 | 0 | 1 {
  const result = parse(left).comparedTo(parse(right));
  if (result === null) {
    throw new Error('Finite comparison invariant violated');
  }

  return result;
}

/**
 * 求非负数除以严格正分母的精确整数商；不先做近似除法。
 * @param numerator 非负分子
 * @param denominator 严格正分母
 * @returns 向下取整的整数文本
 */
export function integerQuotient(numerator: string, denominator: string): string {
  const a = parse(numerator);
  const b = positive(denominator);
  if (a.lt('0')) {
    throw new RangeError('Integer quotient numerator must be nonnegative');
  }

  return checked(a.dividedToIntegerBy(b), a.gte(b)).toFixed();
}

/**
 * 直接求整数手数再乘每手数量，保持名义预算不等式；不足一手返回 0。
 * @param amount 严格正预算
 * @param price 严格正价格
 * @param lotSize 严格正整数手数
 * @returns 精确整数数量文本，不在此强制转为 number
 */
export function wholeLotQuantity(amount: string, price: string, lotSize: string): string {
  positive(amount);
  positive(price);
  const lot = positive(lotSize);
  if (!lot.isInteger()) {
    throw new RangeError('Lot size must be an integer');
  }

  return exactMultiply(integerQuotient(amount, exactMultiply(price, lotSize)), lotSize);
}

/**
 * 用 cross product 比较金额/数量或其他比率，不重建舍入均价。
 * @param leftNumerator 左分子（成本金额等）
 * @param leftDenominator 左严格正分母（数量等）
 * @param rightNumerator 右分子
 * @param rightDenominator 右严格正分母
 * @returns 左比率相对右比率的 -1、0 或 1
 */
export function compareRatios(
  leftNumerator: string,
  leftDenominator: string,
  rightNumerator: string,
  rightDenominator: string,
): -1 | 0 | 1 {
  positive(leftDenominator);
  positive(rightDenominator);
  return exactCompare(
    exactMultiply(leftNumerator, rightDenominator),
    exactMultiply(rightNumerator, leftDenominator),
  );
}

/**
 * 输出精确原值的普通规范文本；不使用显示位数，不改写历史记录。
 * @param value 精确财务文本
 * @returns 普通文本（无指数、尾零或负零）
 */
export function canonicalDecimal(value: string): string {
  return parse(value).toFixed();
}

/**
 * 检查现有 V1 规范十进制拼写；字段正负限制仍由 durable owner 验证。
 * @param value 待验证的原始文本
 * @returns 原始规范文本；非规范拼写立即失败，不归一化历史文本
 */
export function requireCanonicalDecimal(value: string): string {
  if (canonicalDecimal(value) !== value) {
    throw new TypeError('Noncanonical durable decimal text');
  }

  return value;
}

/**
 * 验证字段位数属于库可表达的整数范围，不自设更小的业务上限。
 * @param places 字段小数位数
 * @returns 无；非法内部契约立即失败
 */
function validatePlaces(places: number): void {
  if (!Number.isSafeInteger(places) || places < 0 || places > 1000000000) {
    throw new RangeError('Invalid decimal display places');
  }
}

/**
 * 按调用方既有字段政策处理舍入后零的符号；不替字段统一负零政策。
 * @param text 已完成一次舍入的定点输出
 * @param negative 原始值是否严格负数
 * @param negativeZero 字段政策：保留负号或无符号零，必须明确传入
 * @returns 仅用于展示的定点文本
 */
function displaySign(text: string, negative: boolean, negativeZero: string): string {
  if (negativeZero !== 'preserve' && negativeZero !== 'unsigned') {
    throw new TypeError('Display negative-zero policy must be explicit');
  }

  if (/^-?0(?:\.0+)?$/.test(text)) {
    const zero = text.replace(/^-/, '');
    return negative && negativeZero === 'preserve' ? `-${zero}` : zero;
  }

  return text;
}

/**
 * 直接按字段位数一次 half-even 舍入并补零；显示文本不得回流财务状态。
 * @param value 精确原值
 * @param places 字段既定小数位
 * @param negativeZero 字段现有负零政策（不提供默认值）
 * @returns 定点显示文本
 */
export function formatDecimal(
  value: string,
  places: number,
  negativeZero: 'preserve' | 'unsigned',
): string {
  validatePlaces(places);
  const exact = parse(value);
  return displaySign(exact.toFixed(places, Numeric.ROUND_HALF_EVEN), exact.lt('0'), negativeZero);
}

/**
 * 从原始分子/正分母按字段位数直接一次 half-even，不公开近似商。
 * @param numerator 原始分子（金额等）
 * @param denominator 原始严格正分母（数量等）
 * @param places 字段小数位
 * @param negativeZero 字段现有负零政策（不提供默认值）
 * @returns 终态定点显示文本；不能用于判断、状态或 durable
 */
export function formatRatio(
  numerator: string,
  denominator: string,
  places: number,
  negativeZero: 'preserve' | 'unsigned',
): string {
  validatePlaces(places);
  const a = parse(numerator);
  const b = positive(denominator);
  const range = Numeric.config().RANGE;
  if (!Array.isArray(range)) {
    throw new TypeError('Private decimal range invariant violated');
  }

  if (!a.isZero()) {
    const exponentA = a.e;
    const exponentB = b.e;
    if (exponentA === null || exponentB === null) {
      throw new Error('Finite ratio exponent invariant violated');
    }

    const adjustment = a.abs().shiftedBy(-exponentA).lt(b.shiftedBy(-exponentB)) ? 1 : 0;
    const exponent = exponentA - exponentB - adjustment;
    if (exponent < range[0] || exponent > range[1]) {
      throw new RangeError('Display ratio exceeds library exponent range');
    }
  }

  // BigNumber.clone 不继承调用方配置，显示后端必须显式沿用精确后端的范围。
  const Display = Numeric.clone({
    RANGE: range,
    DECIMAL_PLACES: places,
    ROUNDING_MODE: Numeric.ROUND_HALF_EVEN,
  });
  const rounded = checked(new Display(a).dividedBy(b), false);
  return displaySign(rounded.toFixed(places), a.lt('0'), negativeZero);
}

/**
 * 唯一财务相关 number 出口：先证明数量为非负安全整数，再转换并复验。
 * @param quantity 精确数量文本
 * @returns 安全整数数量；金额、非整数和越界数量不得走此出口
 */
export function safeQuantityNumber(quantity: string): number {
  const value = parse(quantity);
  if (!value.isInteger() || value.lt('0') || value.gt('9007199254740991')) {
    throw new RangeError('Quantity must be a nonnegative safe integer');
  }

  const result = value.toNumber();
  if (!Number.isSafeInteger(result) || result < 0 || String(result) !== value.toFixed()) {
    throw new Error('Safe quantity projection invariant violated');
  }

  return result;
}

/**
 * 精确累计数量并在聚合后重新验证安全整数边界。
 * @param quantities 各项非负整数数量文本
 * @returns 聚合后的安全整数数量
 */
export function sumSafeQuantities(quantities: ReadonlyArray<string>): number {
  let total = '0';
  for (const quantity of quantities) {
    safeQuantityNumber(quantity);
    total = exactAdd(total, quantity);
  }

  return safeQuantityNumber(total);
}
