import type { Candlestick, Config, Market, NaiveDatetime, Period, TradeSessions } from 'longbridge';
import type { CandlestickCacheSnapshot } from '../../types/services.js';

/**
 * withRetry 重试配置。
 * 类型用途：控制 API 调用的重试次数与间隔，作为 withRetry 的参数。
 * 使用范围：仅 quoteClient 模块内部使用。
 * 数据来源：由当前模块的入参、返回值或运行时派生数据提供（如适用）。
 */
export type RetryConfig = {
  readonly retries: number;
  readonly delayMs: number;
};

/**
 * Longbridge 静态信息结构。
 * 类型用途：提取标的名称与每手股数，供行情缓存组装使用。
 * 数据来源：Longbridge staticInfo API 返回值的结构映射。
 * 使用范围：仅 quoteClient 模块内部使用。
 */
export type StaticInfo = {
  readonly nameHk?: string | null;
  readonly nameCn?: string | null;
  readonly nameEn?: string | null;
  readonly lotSize?: number | null;
};

/**
 * K 线 push 数据结构（最小语义子集）。
 * 类型用途：抽象 QuoteContext.setOnCandlestick 的 push data 数据形态。
 * 数据来源：Longbridge PushCandlestickEvent.data。
 * 使用范围：quoteClient 模块内部使用。
 */
type PushCandlestickLike = Readonly<{
  readonly period: Period;
  readonly candlestick: Candlestick;
  readonly isConfirmed: boolean;
}>;

/**
 * K 线 push 事件结构（最小语义子集）。
 * 类型用途：抽象 QuoteContext.setOnCandlestick 的事件形态。
 * 数据来源：Longbridge PushCandlestickEvent。
 * 使用范围：quoteClient 模块内部使用。
 */
type PushCandlestickEventLike = Readonly<{
  readonly symbol: string;
  readonly data: PushCandlestickLike;
}>;

/**
 * QuoteContext 最小契约。
 * 类型用途：约束 quoteClient 对 Longbridge QuoteContext 的依赖边界，便于测试替身注入与类型校验。
 * 数据来源：Longbridge QuoteContext API 能力映射。
 * 使用范围：quoteClient 模块内部使用。
 */
export interface QuoteContextLike {
  readonly quote: (symbols: string[]) => Promise<ReadonlyArray<unknown>>;
  readonly staticInfo: (symbols: string[]) => Promise<ReadonlyArray<unknown>>;
  readonly subscribe: (symbols: string[], subTypes: number[]) => Promise<void>;
  readonly unsubscribe: (symbols: string[], subTypes: number[]) => Promise<void>;
  readonly realtimeQuote: (symbols: string[]) => Promise<ReadonlyArray<unknown>>;
  readonly subscribeCandlesticks: (
    symbol: string,
    period: Period,
    tradeSessions?: TradeSessions,
  ) => Promise<ReadonlyArray<unknown>>;
  readonly unsubscribeCandlesticks: (symbol: string, period: Period) => Promise<void>;
  readonly realtimeCandlesticks: (
    symbol: string,
    period: Period,
    count: number,
  ) => Promise<ReadonlyArray<unknown>>;
  readonly historyCandlesticksByOffset: (
    symbol: string,
    period: Period,
    adjustType: number,
    forward: boolean,
    datetime: NaiveDatetime | undefined | null,
    count: number,
    tradeSessions: TradeSessions,
  ) => Promise<ReadonlyArray<unknown>>;
  readonly setOnCandlestick: (
    callback: (err: null | Error, event: PushCandlestickEventLike) => void,
  ) => void;
  readonly tradingDays: (
    market: Market,
    begin: unknown,
    end: unknown,
  ) => Promise<{
    readonly tradingDays: ReadonlyArray<unknown>;
    readonly halfTradingDays: ReadonlyArray<unknown>;
  }>;
}

/**
 * 行情数据客户端工厂依赖。
 * 类型用途：供 createMarketDataClient 注入 SDK Config 与可替换的 QuoteContext factory。
 * 数据来源：主程序或测试替身注入。
 * 使用范围：quoteClient 模块内部使用。
 */
export type MarketDataClientDeps = {
  readonly config: Config;
  readonly quoteContextFactory?: (config: Config) => Promise<QuoteContextLike>;
};

/**
 * K 线缓存存储结构。
 * 类型用途：维护 symbol+period 维度的本地快照映射与每个 key 的最大保留根数。
 * 数据来源：createCandlestickCacheStore 创建。
 * 使用范围：quoteClient/candlestickCache.ts。
 */
export type CandlestickCacheStore = Readonly<{
  maxCandles: number;
  snapshots: Map<string, CandlestickCacheSnapshot>;
}>;

/**
 * seed K 线序列参数。
 * 类型用途：订阅成功后写入初始 K 线序列到本地缓存。
 * 数据来源：QuoteContext.subscribeCandlesticks 返回值。
 * 使用范围：quoteClient/candlestickCache.ts。
 */
export type SeedCandlestickSeriesParams = Readonly<{
  store: CandlestickCacheStore;
  symbol: string;
  period: Period;
  candles: ReadonlyArray<unknown>;
}>;

/**
 * push 增量更新参数。
 * 类型用途：描述单条 candlestick push 更新所需输入。
 * 数据来源：QuoteContext.setOnCandlestick 推送事件。
 * 使用范围：quoteClient/candlestickCache.ts。
 */
export type ApplyCandlestickPushParams = Readonly<{
  store: CandlestickCacheStore;
  symbol: string;
  period: Period;
  candlestick: unknown;
  isConfirmed: boolean;
}>;

/**
 * 历史 K 线回填参数。
 * 类型用途：描述历史拉取结果写入本地缓存所需输入。
 * 数据来源：显式历史 K 线拉取结果。
 * 使用范围：quoteClient/candlestickCache.ts。
 */
export type BackfillCandlestickSeriesParams = Readonly<{
  store: CandlestickCacheStore;
  symbol: string;
  period: Period;
  candles: ReadonlyArray<unknown>;
}>;

/**
 * K 线字段可接受的归一化值。
 * 类型用途：约束 candle 数值字段在规范化后的允许取值。
 * 数据来源：normalizeCandleValue 对 SDK 数据进行兼容收敛后的结果。
 * 使用范围：quoteClient/candlestickCache.ts。
 */
export type NormalizedCandleValue = number | string | null | undefined;
