/**
 * 中性轮证到期日筛选区间。
 * 数据来源：自动寻标、换标预寻标与席位恢复链路的查询策略。
 * 使用范围：轮证列表请求及共享到期日筛选常量，不携带 SDK 枚举。
 */
export type MarketWarrantExpiryRange = 'MONTHS_3_TO_6' | 'MONTHS_6_TO_12' | 'OVER_12_MONTHS';

/**
 * 跨 reader 的中性轮证列表请求。
 * 数据来源：自动寻标、换标预寻标与席位恢复链路组装的筛选条件。
 * 使用范围：行情查询 port；SDK 位置参数与枚举仅由 infra mapper 装配。
 */
export type MarketWarrantListRequest = Readonly<{
  symbol: string;
  sortBy: 'TURNOVER';
  sortOrder: 'DESCENDING';
  types: readonly ('BULL' | 'BEAR')[];
  issuerIds?: ReadonlyArray<number> | null;
  expiryFilters?: ReadonlyArray<MarketWarrantExpiryRange>;
  inOutBoundsTypes?: ReadonlyArray<'IN'>;
  status?: ReadonlyArray<'NORMAL'>;
}>;
