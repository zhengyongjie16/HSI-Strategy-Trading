import type { TradingDayInfo } from './tradingCalendar.js';
import type { NormalizedCandle } from './data.js';
import type { Quote } from './quote.js';

/**
 * 轮证列表缓存的跨层清理能力。
 * 数据来源：行情 adapter 持有的唯一事实与在途请求缓存；clear 同时使旧请求失去写回资格。
 * 使用范围：app 共享对象装配与生命周期日切，不向业务暴露缓存读写、TTL 或 SDK 请求。
 */
export interface WarrantListCacheClearer {
  readonly clear: () => void;
}

/**
 * 中性 K 线周期。
 * 数据来源：market adapter 对已知 SDK 周期的一次映射，不携带 SDK 数值枚举。
 * 使用范围：行情订阅、缓存、事件宿主与策略快照；未知周期由 adapter 拒绝。
 */
export type CandlestickPeriod =
  | 'MIN_1'
  | 'MIN_2'
  | 'MIN_3'
  | 'MIN_5'
  | 'MIN_10'
  | 'MIN_15'
  | 'MIN_20'
  | 'MIN_30'
  | 'MIN_45'
  | 'MIN_60'
  | 'MIN_120'
  | 'MIN_180'
  | 'MIN_240'
  | 'DAY'
  | 'WEEK'
  | 'MONTH'
  | 'QUARTER'
  | 'YEAR';

/**
 * 交易日查询结果。
 * 数据来源：market adapter 校验后的港股交易日与半日市日期键。
 * 使用范围：交易日历预热与行情客户端，不包含 SDK 日期对象。
 */
export type TradingDaysResult = {
  readonly tradingDays: ReadonlyArray<string>;
  readonly halfTradingDays: ReadonlyArray<string>;
};

/**
 * 本地 K 线缓存快照。
 * 数据来源：market adapter 对订阅 seed 与推送更新维护的标准化缓存。
 * 使用范围：事件宿主与策略；只包含中性周期、primitive candle 与缓存版本。
 */
export type CandlestickCacheSnapshot = {
  readonly symbol: string;
  readonly period: CandlestickPeriod;
  readonly version: number;
  readonly candles: ReadonlyArray<NormalizedCandle>;
  readonly lastBarTimestamp: number | null;
  readonly lastBarConfirmed: boolean | null;
  readonly initialized: boolean;
};

/**
 * 标准化行情更新事件。
 * 数据来源：market adapter 的行情推送与本地缓存。
 * 使用范围：行情、风险与展示 runtime，不提供 broker 能力。
 */
export type QuoteUpdatedEvent = {
  readonly symbol: string;
  readonly quote: Quote;
};

/**
 * 标准化 K 线更新事件。
 * 数据来源：market adapter 在推送更新本地缓存后发布。
 * 使用范围：普通信号宿主与策略，只读取当前权威缓存快照。
 */
export type CandlestickUpdatedEvent = {
  readonly symbol: string;
  readonly period: CandlestickPeriod;
  readonly snapshot: CandlestickCacheSnapshot;
};

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

/**
 * 轮证报价最小事实。
 * 数据来源：market adapter 将 warrantQuote 金融原文适配为文本。
 * 使用范围：轮证风险刷新；结构字段保留原缺失语义，不伪造回收价。
 */
export type MarketWarrantQuote = {
  readonly symbol: string;
  readonly callPrice?: string | null | undefined;
  readonly category?: number | string | null;
};

/**
 * 轮证列表最小事实。
 * 数据来源：market adapter 将 warrantList 金融原文适配为文本。
 * 使用范围：候选筛选与寻标缓存；toCallPrice 保留外部小数比值口径。
 */
export type MarketWarrantListItem = {
  readonly symbol: string;
  readonly name?: string | null;
  readonly lastDone: string | null | undefined;
  readonly toCallPrice: string | null | undefined;
  readonly callPrice?: string | null | undefined;
  readonly turnover: string | null | undefined;
  readonly warrantType: number | string | null | undefined;
  readonly status: 'NORMAL' | 'NON_NORMAL' | null | undefined;
};

/**
 * 轮证查询能力。
 * 数据来源：composition root 注入唯一 market adapter 的实际读取方法。
 * 使用范围：自动寻标与风险刷新，不暴露 SDK context 或位置参数枚举。
 */
export interface MarketQuoteContext {
  readonly warrantQuote: (
    symbols: ReadonlyArray<string>,
  ) => Promise<ReadonlyArray<MarketWarrantQuote>>;
  readonly warrantList: (
    request: MarketWarrantListRequest,
  ) => Promise<ReadonlyArray<MarketWarrantListItem>>;
}

/**
 * 中性行情客户端端口。
 * 数据来源：composition root 组装的唯一 market adapter。
 * 使用范围：行情订阅、事件路由与 application 读路径；不携带 SDK 枚举、Decimal 或 candle。
 */
export interface MarketDataClient {
  readonly getQuoteContext: () => Promise<MarketQuoteContext>;
  readonly getQuotes: (symbols: Iterable<string>) => Promise<Map<string, Quote | null>>;
  readonly subscribeSymbols: (symbols: ReadonlyArray<string>) => Promise<void>;
  readonly unsubscribeSymbols: (symbols: ReadonlyArray<string>) => Promise<void>;
  readonly onQuoteUpdated: (listener: (event: QuoteUpdatedEvent) => void) => () => void;
  readonly onCandlestickUpdated: (listener: (event: CandlestickUpdatedEvent) => void) => () => void;

  /** seed 与 push 统一返回已标准化 candle；重复订阅仍由 adapter 返回空数组。 */
  readonly subscribeCandlesticks: (
    symbol: string,
    period: CandlestickPeriod,
    tradeSessions?: 'INTRADAY' | 'ALL',
  ) => Promise<ReadonlyArray<NormalizedCandle>>;
  readonly getCandlestickSnapshot: (
    symbol: string,
    period: CandlestickPeriod,
  ) => CandlestickCacheSnapshot | null;

  /** 当前系统只有港股交易日消费者，SDK market 映射由 adapter 完成。 */
  readonly isTradingDay: (date: Date, market?: 'HK') => Promise<TradingDayInfo>;
  readonly getTradingDays: (
    startDate: Date,
    endDate: Date,
    market?: 'HK',
  ) => Promise<TradingDaysResult>;
  readonly resetRuntimeSubscriptionsAndCaches: () => Promise<void>;
}
