import type { CandlestickPeriod, MarketDataClient } from '../../../../src/types/marketPorts.js';
import type { Quote } from '../../../../src/types/quote.js';

/** 中性离线 K 线输入，由集成或工具测试显式给定；SDK Decimal、Date 与 DTO 只在 infra fixture 内构造。 */
export type MarketCandleInput = {
  readonly timestampMs: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
  readonly turnover: number;
};

/** 场景所需的中性实时报价：名称与手数进入静态 metadata，价格/昨收保持金融文本，时间为毫秒。 */
export type MarketQuoteSeed = {
  readonly symbol: string;
  readonly name: string;
  readonly price: string;
  readonly previousClose: string;
  readonly timestampMs: number;
  readonly lotSize?: number;

  /** 缺省正常；null 显式制造应用边界可见的损坏状态响应。 */
  readonly tradingStatus?: 'NORMAL' | 'SUSPEND' | null;
};

/** 场景所需的中性轮证行：金融字段保持文本，仅表达牛/熊方向；状态由 fixture 播种为正常。 */
export type MarketWarrantSeed = {
  readonly symbol: string;
  readonly name: string;
  readonly price: string;
  readonly callPrice: string;
  readonly toCallPrice: string;
  readonly turnover: string;
  readonly direction: 'BULL' | 'BEAR';
};

/** 首次完整或 realtime 报价读取的暂停闸门：底层结果取得后进入，释放后原请求继续。 */
export type MarketQuoteReadGate = {
  readonly entered: Promise<void>;
  readonly release: () => void;
};

/** fixture 允许观察的 SDK 调用；只发布请求标的，不发布 SDK 参数或 context。 */
export type MarketFixtureCallMethod =
  'quote' | 'subscribe' | 'unsubscribe' | 'realtimeQuote' | 'warrantList';

/** 真实行情 adapter 的离线控制能力；只接收中性输入，不暴露 SDK context 或原生 push。 */
export interface MarketFixtureController {
  /**
   * 整批播种订阅 metadata：静态信息按标的覆盖写 nameCn=标的代码占位名与给定手数，
   * 报价缓存整批替换为仅含给定昨收的记录（无 lastDone/timestamp），未列入参数的标的报价被清空。
   * 名称语义：extractName 优先 nameHk，占位名仅在无 nameHk 时生效；同标的 staticInfo
   * 整条覆盖，若在 seedQuotes 之后调用，名称退回代码占位名。
   */
  readonly seedSymbolMetadata: (
    symbols: ReadonlyArray<string>,
    previousClose: string,
    lotSize: number,
  ) => void;

  /**
   * 整批播种 realtime 报价：静态信息按标的覆盖写 nameHk 名称与可选手数，
   * 报价缓存整批替换为给定价格/昨收/时间，未列入参数的标的报价被清空。
   * 名称语义：本次传入标的的 staticInfo 整条覆盖并写入本次 nameHk，与是否先调用 seedSymbolMetadata 无关。
   * 此操作仅更新 mock 数据源，不会刷新客户端已有的订阅 metadata 缓存。
   */
  readonly seedQuotes: (quotes: ReadonlyArray<MarketQuoteSeed>) => void;

  /** 为监控标的播种轮证列表；类型由方向决定，状态固定为正常。 */
  readonly seedWarrants: (
    monitorSymbol: string,
    warrants: ReadonlyArray<MarketWarrantSeed>,
  ) => void;

  /** 武装下一次 realtime 读取的暂停闸门；只暂停一次，未武装时读取不受影响。 */
  readonly pauseFirstRealtimeQuote: () => MarketQuoteReadGate;

  /** 暂停首个完整 quote 响应，用于恢复准入等待期间的原 receipt 失效场景。 */
  readonly pauseFirstSecurityTradingStatusRead: () => MarketQuoteReadGate;

  /** 读取指定调用的首个参数标的列表；字符串参数归一为单元素数组，
   * 非字符串且非全字符串数组抛 TypeError，不静默丢弃。 */
  readonly readSymbolCalls: (
    method: MarketFixtureCallMethod,
  ) => ReadonlyArray<ReadonlyArray<string>>;
  readonly seedCandlesticks: (
    symbol: string,
    period: CandlestickPeriod,
    candles: ReadonlyArray<MarketCandleInput>,
  ) => void;
  readonly emitCandlestick: (
    symbol: string,
    period: CandlestickPeriod,
    candle: MarketCandleInput,
    isConfirmed: boolean,
  ) => void;
  readonly flushAllEvents: () => number;
}

/** 离线行情 port；quote reader 只接收符号数组，不发布标准库 Iterable 的开放 iterator 类型参数。 */
export interface MarketFixtureClient extends Omit<MarketDataClient, 'getQuotes'> {
  readonly getQuotes: (symbols: ReadonlyArray<string>) => Promise<Map<string, Quote | null>>;
}

/** 行情 fixture 对外唯一出口：真实行情能力与私有离线 producer 的中性 controller。 */
export type MarketFixture = {
  readonly client: MarketFixtureClient;
  readonly controller: MarketFixtureController;
};
