/**
 * 持仓展示所需的可选行情信息。
 * 类型用途：缓存单个持仓标的的展示名称与最新价格，避免调用方重复内联对象类型。
 * 数据来源：由 displayAccountAndPositions 从 quotesMap 中提取。
 * 使用范围：仅 accountDisplay 显示 adapter 内部使用。
 */
export type SymbolDisplayInfo = Readonly<{
  name: string | null;
  price: string | null;
}>;
