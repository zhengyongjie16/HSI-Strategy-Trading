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

/** 真实行情 adapter 的离线控制能力；只接收中性输入，不暴露 SDK context 或原生 push。 */
export interface MarketFixtureController {
  readonly seedSymbolMetadata: (
    symbols: ReadonlyArray<string>,
    previousClose: string,
    lotSize: number,
  ) => void;
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
