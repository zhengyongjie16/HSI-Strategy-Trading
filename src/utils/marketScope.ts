/**
 * 市场范围判定：只判断标的所属市场，不验证 ticker 是否真实存在。
 * Longbridge 以 `ticker.region` 表达市场；ticker 允许子代码点号（美股类别股等）。
 * 破坏该结构（空值、缺代码/缺市场、大小写不一致、空白等）不静默降级，直接抛内部契约错误。
 * 调用方仍负责确认标的在当前业务中真实可用（行情、配置、席位等）。
 */
const SYMBOL_WITH_REGION_PATTERN = /^[A-Z0-9][A-Z0-9._-]*\.[A-Z]{2,5}$/;

/**
 * 判断标的是否属于港股市场。
 *
 * @param symbol Longbridge `ticker.region` 标的代码
 * @returns 港股返回 true；格式合法但非港股返回 false
 * @throws {TypeError} 非字符串、空值或缺少代码/市场区间等坏结构
 */
export function isHongKongSymbol(symbol: unknown): symbol is string {
  if (typeof symbol !== 'string' || !SYMBOL_WITH_REGION_PATTERN.test(symbol)) {
    throw new TypeError(`Invalid Longbridge symbol structure: ${String(symbol)}`);
  }

  return symbol.endsWith('.HK');
}
