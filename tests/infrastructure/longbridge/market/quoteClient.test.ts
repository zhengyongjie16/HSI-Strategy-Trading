/**
 * quoteClient 业务测试
 *
 * 功能：
 * - 验证行情客户端相关场景意图、边界条件与业务期望。
 */
import { beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { logger } from '../../../../src/infrastructure/logger/index.js';

class TestDecimal {
  private readonly value: number;

  public constructor(value: number | string) {
    this.value = Number(value);
  }

  public static ZERO(): TestDecimal {
    return new TestDecimal(0);
  }

  public toNumber(): number {
    return this.value;
  }

  public toString(): string {
    return String(this.value);
  }

  public equals(other: TestDecimal): boolean {
    return this.value === other.toNumber();
  }

  public add(other: TestDecimal): TestDecimal {
    return new TestDecimal(this.value + other.toNumber());
  }

  public sub(other: TestDecimal): TestDecimal {
    return new TestDecimal(this.value - other.toNumber());
  }

  public abs(): TestDecimal {
    return new TestDecimal(Math.abs(this.value));
  }

  public comparedTo(other: TestDecimal): number {
    const otherValue = other.toNumber();
    if (this.value < otherValue) {
      return -1;
    }

    if (this.value > otherValue) {
      return 1;
    }

    return 0;
  }
}

class TestNaiveDate {
  private readonly year: number;
  private readonly month: number;
  private readonly day: number;

  public constructor(year: number, month: number, day: number) {
    this.year = year;
    this.month = month;
    this.day = day;
  }

  public toString(): string {
    return `${String(this.year)}-${String(this.month).padStart(2, '0')}-${String(this.day).padStart(2, '0')}`;
  }
}

import {
  Market as RealMarket,
  Period as RealPeriod,
  SortOrderType,
  TradeStatus,
  TradeSessions as RealTradeSessions,
  WarrantSortBy,
  WarrantStatus,
  WarrantType,
} from 'longbridge';
import type { createMarketDataClient as actualCreateMarketDataClient } from '../../../../src/infrastructure/longbridge/market/quoteClient.js';
import type { CandlestickPeriod } from '../../../../src/types/marketPorts.js';
import { isExternalApiRequestError } from '../../../../src/utils/apiFailure/index.js';

import {
  createPushCandlestickEvent,
  createPushQuoteEvent,
  createWarrantInfo,
  createWarrantQuote,
} from '../../../../mock/factories/quoteFactory.js';
import { createQuoteContextMock } from '../../../../mock/longbridge/quoteContextMock.js';
import { createSdkConfigDouble } from '../trade/sdkConfigDouble.js';

const { createMarketDataClient } = (await import(
  // @ts-expect-error Bun 查询后缀用于隔离模块；TypeScript 不解析该路径，返回类型取同一真实入口。
  '../../../../src/infrastructure/longbridge/market/quoteClient.js?quote-client-business-test'
)) as {
  readonly createMarketDataClient: typeof actualCreateMarketDataClient;
};

let quoteMock: ReturnType<typeof createQuoteContextMock>;

function makeSeedQuote(
  symbol: string,
  lastDone: number,
  prevClose: number,
): {
  symbol: string;
  lastDone: TestDecimal;
  prevClose: TestDecimal;
  timestamp: Date;
} {
  return {
    symbol,
    lastDone: new TestDecimal(lastDone),
    prevClose: new TestDecimal(prevClose),
    timestamp: new Date('2026-02-16T01:00:00.000Z'),
  };
}

function makeCandlestick(close: number, timestampIso: string) {
  return {
    open: new TestDecimal(close),
    close: new TestDecimal(close),
    high: new TestDecimal(close),
    low: new TestDecimal(close),
    volume: 1000,
    turnover: new TestDecimal(close * 1000),
    timestamp: new Date(timestampIso),
    tradeSession: 0,
    toJSON: () => ({}),
  };
}

beforeEach(() => {
  quoteMock = createQuoteContextMock();
});

describe('security trading status reads', () => {
  it('空集合不请求；未订阅也批量去重读取，按 symbol 匹配乱序结果且每轮重新读取', async () => {
    const client = await createMarketDataClient({
      config: createSdkConfigDouble(),
      quoteContextFactory: () => ({
        ...quoteMock,
        quote: async (symbols) => {
          const quotes = await quoteMock.quote(symbols);
          const reversed: unknown[] = [];
          for (const row of quotes) reversed.unshift(row);

          return reversed;
        },
      }),
    });
    expect(await client.getSecurityTradingStatuses([])).toEqual(new Map());
    expect(quoteMock.getCalls('quote')).toHaveLength(0);
    quoteMock.seedQuotes([
      { symbol: 'LONG.HK', quote: { symbol: 'LONG.HK', tradeStatus: TradeStatus.Normal } },
      { symbol: 'SHORT.HK', quote: { symbol: 'SHORT.HK', tradeStatus: TradeStatus.Suspend } },
    ]);
    const statuses = await client.getSecurityTradingStatuses(['LONG.HK', 'SHORT.HK', 'LONG.HK']);
    expect(statuses.get('LONG.HK')).toBe('NORMAL');
    expect(statuses.get('SHORT.HK')).toBe('SUSPEND');
    expect(quoteMock.getCalls('quote')[0]?.args[0]).toEqual(['LONG.HK', 'SHORT.HK']);
    quoteMock.seedQuotes([
      { symbol: 'LONG.HK', quote: { symbol: 'LONG.HK', tradeStatus: TradeStatus.Halted } },
    ]);
    const nextStatuses = await client.getSecurityTradingStatuses(['LONG.HK']);
    expect(nextStatuses.get('LONG.HK')).toBe('HALTED');
    expect(quoteMock.getCalls('quote')).toHaveLength(2);
    for (const method of ['subscribe', 'staticInfo', 'realtimeQuote'] as const) {
      expect(quoteMock.getCalls(method)).toHaveLength(0);
    }
  });

  it.each([
    ['缺少请求行', []],
    ['缺少请求行但数量相同', [{ symbol: 'OTHER.HK', tradeStatus: TradeStatus.Normal }]],
    ['缺少状态', [{ symbol: 'LONG.HK' }]],
    ['null 状态', [{ symbol: 'LONG.HK', tradeStatus: null }]],
    ['未知状态', [{ symbol: 'LONG.HK', tradeStatus: 99999 }]],
    ['非法状态类型', [{ symbol: 'LONG.HK', tradeStatus: String(TradeStatus.Normal) }]],
    ['损坏状态对象', [{ symbol: 'LONG.HK', tradeStatus: {} }]],
    ['缺少 symbol', [{ tradeStatus: TradeStatus.Normal }]],
    ['非法 symbol 类型', [{ symbol: 1, tradeStatus: TradeStatus.Normal }]],
    ['空 symbol', [{ symbol: '', tradeStatus: TradeStatus.Normal }]],
    ['null 行', [null]],
    ['损坏行', [false]],
    ['数组行', [[]]],
    ['非数组响应', {}],
    ['null 响应', null],
  ] as const)('%s 是内部契约错误，不重试或外部化', async (_name, response) => {
    let requests = 0;
    const client = await createMarketDataClient({
      config: createSdkConfigDouble(),
      quoteContextFactory: () => ({
        ...quoteMock,
        quote: async () => {
          requests += 1;
          return response as unknown as ReadonlyArray<unknown>;
        },
      }),
    });
    const error: unknown = await client.getSecurityTradingStatuses(['LONG.HK']).then(
      () => null,
      (error_: unknown) => error_,
    );
    expect(error).toBeInstanceOf(TypeError);
    expect(isExternalApiRequestError(error)).toBeFalse();
    expect(requests).toBe(1);
  });

  it('真实 quote 请求失败保留现有外部分类与重试，不变为空状态集合', async () => {
    quoteMock.setFailureRule('quote', {
      failAtCalls: [1, 2, 3],
      maxFailures: 3,
      errorMessage: 'service unavailable',
    });
    const client = await createMarketDataClient({
      config: createSdkConfigDouble(),
      quoteContextFactory: () => quoteMock,
    });
    const error: unknown = await client.getSecurityTradingStatuses(['LONG.HK']).then(
      () => null,
      (error_: unknown) => error_,
    );
    expect(isExternalApiRequestError(error)).toBeTrue();
    expect(quoteMock.getCalls('quote')).toHaveLength(3);
  });
});

describe('quoteClient business flow', () => {
  it('subscribes symbols and serves realtime quotes with static info fields', async () => {
    quoteMock.seedStaticInfo([
      {
        symbol: 'BULL.HK',
        info: {
          symbol: 'BULL.HK',
          nameHk: '测试牛证',
          lotSize: 500,
        },
      },
    ]);

    quoteMock.seedQuotes([
      {
        symbol: 'BULL.HK',
        quote: makeSeedQuote('BULL.HK', 1.23, 1.2),
      },
    ]);

    const client = await createMarketDataClient({
      config: createSdkConfigDouble(),
      quoteContextFactory: async () => quoteMock,
    });

    await client.subscribeSymbols(['BULL.HK']);
    const quotes = await client.getQuotes(['BULL.HK']);

    const quote = quotes.get('BULL.HK');
    expect(quote?.name).toBe('测试牛证');
    expect(quote?.lotSize).toBe(500);
    expect(quote?.price).toBe('1.23');

    expect(quoteMock.getCalls('staticInfo')).toHaveLength(1);
    expect(quoteMock.getCalls('quote')).toHaveLength(1);
    expect(quoteMock.getCalls('subscribe')).toHaveLength(1);
    expect(quoteMock.getCalls('realtimeQuote')).toHaveLength(1);
  });

  it('returns null for realtime quotes with non-positive lastDone', async () => {
    quoteMock.seedStaticInfo([
      {
        symbol: 'BULL.HK',
        info: {
          symbol: 'BULL.HK',
          nameHk: '测试牛证',
          lotSize: 500,
        },
      },
    ]);

    quoteMock.seedQuotes([
      {
        symbol: 'BULL.HK',
        quote: makeSeedQuote('BULL.HK', 0, 1.2),
      },
    ]);
    const client = await createMarketDataClient({
      config: createSdkConfigDouble(),
      quoteContextFactory: async () => quoteMock,
    });

    await client.subscribeSymbols(['BULL.HK']);
    const quotes = await client.getQuotes(['BULL.HK']);

    expect(quotes.get('BULL.HK')).toBeNull();
  });

  it('retries quote subscription after a transient API failure', async () => {
    quoteMock.seedStaticInfo([
      {
        symbol: 'BULL.HK',
        info: {
          symbol: 'BULL.HK',
          nameHk: '测试牛证',
          lotSize: 500,
        },
      },
    ]);

    quoteMock.seedQuotes([
      {
        symbol: 'BULL.HK',
        quote: makeSeedQuote('BULL.HK', 1.23, 1.2),
      },
    ]);

    quoteMock.setFailureRule('subscribe', {
      failAtCalls: [1],
      errorMessage: 'service unavailable',
    });
    const client = await createMarketDataClient({
      config: createSdkConfigDouble(),
      quoteContextFactory: async () => quoteMock,
    });

    let error: unknown = null;
    try {
      await client.subscribeSymbols(['BULL.HK']);
    } catch (error_) {
      error = error_;
    }

    expect(quoteMock.getCalls('subscribe')).toHaveLength(2);
    expect(error).toBeNull();
  });

  it('retries quote unsubscribe after a transient API failure', async () => {
    quoteMock.seedStaticInfo([
      {
        symbol: 'BULL.HK',
        info: {
          symbol: 'BULL.HK',
          nameHk: '测试牛证',
          lotSize: 500,
        },
      },
    ]);

    quoteMock.seedQuotes([
      {
        symbol: 'BULL.HK',
        quote: makeSeedQuote('BULL.HK', 1.23, 1.2),
      },
    ]);
    const client = await createMarketDataClient({
      config: createSdkConfigDouble(),
      quoteContextFactory: async () => quoteMock,
    });
    await client.subscribeSymbols(['BULL.HK']);
    quoteMock.setFailureRule('unsubscribe', {
      failAtCalls: [1],
      errorMessage: 'service unavailable',
    });

    let error: unknown = null;
    try {
      await client.unsubscribeSymbols(['BULL.HK']);
    } catch (error_) {
      error = error_;
    }

    expect(quoteMock.getCalls('unsubscribe')).toHaveLength(2);
    expect(error).toBeNull();
  });

  it('publishes standardized quote updates for subscribed symbols and supports listener disposal', async () => {
    quoteMock.seedStaticInfo([
      {
        symbol: 'BULL.HK',
        info: {
          symbol: 'BULL.HK',
          nameHk: '测试牛证',
          lotSize: 500,
        },
      },
    ]);

    quoteMock.seedQuotes([
      {
        symbol: 'BULL.HK',
        quote: makeSeedQuote('BULL.HK', 1.23, 1.2),
      },
    ]);

    const client = await createMarketDataClient({
      config: createSdkConfigDouble(),
      quoteContextFactory: async () => quoteMock,
    });

    await client.subscribeSymbols(['BULL.HK']);

    const received: Array<{
      readonly symbol: string;
      readonly price: string;
      readonly name: string | null;
      readonly prevClose: string;
      readonly lotSize: number | undefined;
    }> = [];
    const dispose = client.onQuoteUpdated((event) => {
      received.push({
        symbol: event.symbol,
        price: event.quote.price,
        name: event.quote.name,
        prevClose: event.quote.prevClose,
        lotSize: event.quote.lotSize,
      });
    });

    quoteMock.emitQuote(createPushQuoteEvent({ symbol: 'BULL.HK', price: 1.31 }));
    quoteMock.flushAllEvents();

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({
      symbol: 'BULL.HK',
      price: '1.31',
      name: '测试牛证',
      prevClose: '1.2',
      lotSize: 500,
    });

    dispose();
    quoteMock.emitQuote(createPushQuoteEvent({ symbol: 'BULL.HK', price: 1.32 }));
    quoteMock.flushAllEvents();

    expect(received).toHaveLength(1);
  });

  it('fails fast when a standardized quote listener throws', async () => {
    quoteMock.seedStaticInfo([
      {
        symbol: 'BULL.HK',
        info: {
          symbol: 'BULL.HK',
          nameHk: '测试牛证',
          lotSize: 500,
        },
      },
    ]);

    quoteMock.seedQuotes([
      {
        symbol: 'BULL.HK',
        quote: makeSeedQuote('BULL.HK', 1.23, 1.2),
      },
    ]);

    const client = await createMarketDataClient({
      config: createSdkConfigDouble(),
      quoteContextFactory: async () => quoteMock,
    });

    await client.subscribeSymbols(['BULL.HK']);
    client.onQuoteUpdated(() => {
      throw new Error('listener failed');
    });

    expect(() => {
      quoteMock.emitQuote(createPushQuoteEvent({ symbol: 'BULL.HK', price: 1.31 }));
      quoteMock.flushAllEvents();
    }).toThrow('listener failed');
  });

  it('drops standardized quote updates when lastDone is not a valid positive value', async () => {
    quoteMock.seedStaticInfo([
      {
        symbol: 'BULL.HK',
        info: {
          symbol: 'BULL.HK',
          nameHk: '测试牛证',
          lotSize: 500,
        },
      },
    ]);

    quoteMock.seedQuotes([
      {
        symbol: 'BULL.HK',
        quote: makeSeedQuote('BULL.HK', 1.23, 1.2),
      },
    ]);

    const client = await createMarketDataClient({
      config: createSdkConfigDouble(),
      quoteContextFactory: async () => quoteMock,
    });

    await client.subscribeSymbols(['BULL.HK']);

    const received: string[] = [];
    client.onQuoteUpdated((event) => {
      received.push(event.symbol);
    });

    quoteMock.emitQuote(createPushQuoteEvent({ symbol: 'BULL.HK', price: 0 }));
    quoteMock.flushAllEvents();

    expect(received).toHaveLength(0);
  });

  it('stops standardized quote updates after symbol unsubscribe', async () => {
    quoteMock.seedStaticInfo([
      {
        symbol: 'BULL.HK',
        info: {
          symbol: 'BULL.HK',
          nameHk: '测试牛证',
          lotSize: 500,
        },
      },
    ]);

    quoteMock.seedQuotes([
      {
        symbol: 'BULL.HK',
        quote: makeSeedQuote('BULL.HK', 1.23, 1.2),
      },
    ]);

    const client = await createMarketDataClient({
      config: createSdkConfigDouble(),
      quoteContextFactory: async () => quoteMock,
    });

    await client.subscribeSymbols(['BULL.HK']);

    const received: Array<string> = [];
    client.onQuoteUpdated((event) => {
      received.push(event.symbol);
    });

    await client.unsubscribeSymbols(['BULL.HK']);
    quoteMock.emitQuote(createPushQuoteEvent({ symbol: 'BULL.HK', price: 1.31 }));
    quoteMock.flushAllEvents();

    expect(received).toHaveLength(0);
  });

  it('publishes standardized candlestick update notifications for subscribed symbols and supports listener disposal', async () => {
    quoteMock.seedCandlesticks('BULL.HK', RealPeriod.Min_1, [
      makeCandlestick(100, '2026-02-16T01:00:00.000Z'),
      makeCandlestick(101, '2026-02-16T01:01:00.000Z'),
    ]);

    const client = await createMarketDataClient({
      config: createSdkConfigDouble(),
      quoteContextFactory: async () => quoteMock,
    });

    await client.subscribeCandlesticks('BULL.HK', 'MIN_1');

    const received: Array<{
      readonly symbol: string;
      readonly period: CandlestickPeriod;
    }> = [];
    const dispose = client.onCandlestickUpdated((event) => {
      received.push({ symbol: event.symbol, period: event.period });
    });

    quoteMock.emitCandlestick(
      createPushCandlestickEvent({
        symbol: 'BULL.HK',
        close: 105,
        timestampMs: Date.parse('2026-02-16T01:02:00.000Z'),
        period: RealPeriod.Min_1,
        isConfirmed: false,
      }),
    );
    quoteMock.flushAllEvents();

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ symbol: 'BULL.HK', period: 'MIN_1' });

    const pushedSnapshot = client.getCandlestickSnapshot('BULL.HK', 'MIN_1');
    expect(pushedSnapshot?.version).toBe(2);
    expect(pushedSnapshot?.lastBarConfirmed).toBe(false);
    expect(Number(pushedSnapshot?.candles.at(-1)?.close?.toString() ?? Number.NaN)).toBe(105);

    dispose();
    quoteMock.emitCandlestick(
      createPushCandlestickEvent({
        symbol: 'BULL.HK',
        close: 106,
        timestampMs: Date.parse('2026-02-16T01:03:00.000Z'),
        period: RealPeriod.Min_1,
        isConfirmed: false,
      }),
    );
    quoteMock.flushAllEvents();

    expect(received).toHaveLength(1);
    expect(quoteMock.getCalls('subscribeCandlesticks')[0]?.args[2]).toBe(
      RealTradeSessions.Intraday,
    );
  });

  it('映射非默认周期与全部时段，返回中性冻结 candle，并在 reset 映射原 SDK 退订周期', async () => {
    const candle = makeCandlestick(101, '2026-02-16T01:00:00.000Z');
    quoteMock.seedCandlesticks('BULL.HK', RealPeriod.Min_5, [candle]);
    const client = await createMarketDataClient({
      config: createSdkConfigDouble(),
      quoteContextFactory: async () => quoteMock,
    });
    const initial = await client.subscribeCandlesticks('BULL.HK', 'MIN_5', 'ALL');
    expect(quoteMock.getCalls('subscribeCandlesticks')[0]?.args).toEqual([
      'BULL.HK',
      RealPeriod.Min_5,
      RealTradeSessions.All,
    ]);

    expect(initial).toEqual([
      {
        timestamp: Date.parse('2026-02-16T01:00:00.000Z'),
        open: 101,
        high: 101,
        low: 101,
        close: 101,
        volume: 1000,
      },
    ]);
    expect(Object.isFrozen(initial[0])).toBe(true);
    expect(client.getCandlestickSnapshot('BULL.HK', 'MIN_5')?.candles).toEqual(initial);
    expect(client.getCandlestickSnapshot('BULL.HK', 'MIN_1')).toBeNull();
    await client.resetRuntimeSubscriptionsAndCaches();
    expect(quoteMock.getCalls('unsubscribeCandlesticks')[0]?.args).toEqual([
      'BULL.HK',
      RealPeriod.Min_5,
    ]);
    expect(client.getCandlestickSnapshot('BULL.HK', 'MIN_5')).toBeNull();
  });

  it('bridges quote context warrant queries without altering request or response data', async () => {
    quoteMock.seedWarrantQuotes([
      createWarrantQuote({ symbol: 'BULL-CALL.HK', callPrice: 18800, category: 1 }),
    ]);

    quoteMock.seedWarrantList('HSI.HK', [
      createWarrantInfo({ symbol: 'BULL-CALL.HK', warrantType: 'Bull', callPrice: 18800 }),
      createWarrantInfo({ symbol: 'BEAR-CALL.HK', warrantType: 'Bear', callPrice: 21200 }),
    ]);

    const client = await createMarketDataClient({
      config: createSdkConfigDouble(),
      quoteContextFactory: async () => quoteMock,
    });

    const quoteContext = await client.getQuoteContext();
    const warrantQuotes = await quoteContext.warrantQuote(['BULL-CALL.HK']);
    const warrantList = await quoteContext.warrantList({
      symbol: 'HSI.HK',
      sortBy: 'TURNOVER',
      sortOrder: 'DESCENDING',
      types: ['BULL'],
      issuerIds: [1, 2],
      status: ['NORMAL'],
    });

    expect(warrantQuotes).toHaveLength(1);
    expect(warrantQuotes[0]).toEqual({ callPrice: '18800', category: 1 });
    expect(warrantList.map((item) => item.symbol)).toEqual(['BULL-CALL.HK']);
    expect(quoteMock.getCalls('warrantQuote')[0]?.args).toEqual([['BULL-CALL.HK']]);
    expect(quoteMock.getCalls('warrantList')[0]?.args).toEqual([
      'HSI.HK',
      WarrantSortBy.Turnover,
      SortOrderType.Descending,
      [WarrantType.Bull],
      [1, 2],
      undefined,
      undefined,
      [WarrantStatus.Normal],
    ]);
  });

  it('retries quote context warrant requests before returning authoritative data', async () => {
    quoteMock.seedWarrantQuotes([
      createWarrantQuote({ symbol: 'BULL-CALL.HK', callPrice: 18800, category: 1 }),
    ]);

    quoteMock.seedWarrantList('HSI.HK', [
      createWarrantInfo({ symbol: 'BULL-CALL.HK', warrantType: 'Bull', callPrice: 18800 }),
    ]);

    quoteMock.setFailureRule('warrantQuote', {
      failAtCalls: [1],
      errorMessage: 'network unavailable',
    });

    quoteMock.setFailureRule('warrantList', {
      failAtCalls: [1],
      errorMessage: 'network unavailable',
    });
    const client = await createMarketDataClient({
      config: createSdkConfigDouble(),
      quoteContextFactory: async () => quoteMock,
    });

    const quoteContext = await client.getQuoteContext();
    const warrantQuotes = await quoteContext.warrantQuote(['BULL-CALL.HK']);
    const warrantList = await quoteContext.warrantList({
      symbol: 'HSI.HK',
      sortBy: 'TURNOVER',
      sortOrder: 'DESCENDING',
      types: ['BULL'],
    });

    expect(warrantQuotes).toHaveLength(1);
    expect(warrantList).toHaveLength(1);
    expect(quoteMock.getCalls('warrantQuote')).toHaveLength(2);
    expect(quoteMock.getCalls('warrantList')).toHaveLength(2);
  });

  it('does not locally retry realtimeQuote failures on the quote read path', async () => {
    quoteMock.seedStaticInfo([
      {
        symbol: 'BULL.HK',
        info: {
          symbol: 'BULL.HK',
          nameHk: '测试牛证',
          lotSize: 500,
        },
      },
    ]);

    quoteMock.seedQuotes([
      {
        symbol: 'BULL.HK',
        quote: makeSeedQuote('BULL.HK', 1.23, 1.2),
      },
    ]);
    const client = await createMarketDataClient({
      config: createSdkConfigDouble(),
      quoteContextFactory: async () => quoteMock,
    });
    await client.subscribeSymbols(['BULL.HK']);
    quoteMock.setFailureRule('realtimeQuote', {
      failAtCalls: [1],
      errorMessage: 'service unavailable',
    });

    let error: unknown = null;
    try {
      await client.getQuotes(['BULL.HK']);
    } catch (error_) {
      error = error_;
    }

    expect(quoteMock.getCalls('realtimeQuote')).toHaveLength(1);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe('ExternalApiRequestError');
  });

  it('returns null for subscribed symbol when realtime quote is not warmed', async () => {
    quoteMock.seedStaticInfo([
      {
        symbol: 'BULL.HK',
        info: {
          symbol: 'BULL.HK',
          nameHk: '测试牛证',
          lotSize: 500,
        },
      },
    ]);

    quoteMock.seedQuotes([
      {
        symbol: 'BULL.HK',
        quote: makeSeedQuote('BULL.HK', 1.23, 1.2),
      },
    ]);

    const client = await createMarketDataClient({
      config: createSdkConfigDouble(),
      quoteContextFactory: async () => quoteMock,
    });

    await client.subscribeSymbols(['BULL.HK']);
    quoteMock.seedRealtimeQuotes([]);
    const quotes = await client.getQuotes(['BULL.HK']);

    expect(quotes.get('BULL.HK')).toBeNull();
    expect(quoteMock.getCalls('quote')).toHaveLength(1);
    expect(quoteMock.getCalls('realtimeQuote')).toHaveLength(1);
  });

  it('throws when getQuotes is called for an unsubscribed symbol', async () => {
    const client = await createMarketDataClient({
      config: createSdkConfigDouble(),
      quoteContextFactory: async () => quoteMock,
    });

    expect(client.getQuotes(['NOT_SUBSCRIBED.HK'])).rejects.toThrow('未订阅');
    expect(quoteMock.getCalls('realtimeQuote')).toHaveLength(0);
  });

  it.each(['staticInfo', 'prevClose'] as const)(
    'rejects subscription without real %s before quote-read admission',
    async (missingMetadata) => {
      if (missingMetadata !== 'staticInfo') {
        quoteMock.seedStaticInfo([{ symbol: 'BULL.HK', info: { symbol: 'BULL.HK' } }]);
      }

      quoteMock.seedQuotes([
        {
          symbol: 'BULL.HK',
          quote: {
            ...makeSeedQuote('BULL.HK', 1.23, 1.2),
            ...(missingMetadata === 'prevClose' ? { prevClose: undefined } : {}),
          },
        },
      ]);
      const client = await createMarketDataClient({
        config: createSdkConfigDouble(),
        quoteContextFactory: () => quoteMock,
      });
      expect(client.subscribeSymbols(['BULL.HK'])).rejects.toThrow(
        missingMetadata === 'staticInfo' ? '静态信息初始化不完整' : 'prevClose 初始化不完整',
      );
      expect(quoteMock.getCalls('subscribe')).toHaveLength(0);
      expect(client.getQuotes(['BULL.HK'])).rejects.toThrow('未订阅');
      expect(quoteMock.getCalls('realtimeQuote')).toHaveLength(0);
    },
  );

  it('allows admitted static info without optional name and lot size', async () => {
    quoteMock.seedStaticInfo([{ symbol: 'BULL.HK', info: { symbol: 'BULL.HK' } }]);
    quoteMock.seedQuotes([{ symbol: 'BULL.HK', quote: makeSeedQuote('BULL.HK', 1.23, 1.2) }]);
    const client = await createMarketDataClient({
      config: createSdkConfigDouble(),
      quoteContextFactory: () => quoteMock,
    });
    await client.subscribeSymbols(['BULL.HK']);
    const quotes = await client.getQuotes(['BULL.HK']);
    expect(quotes.get('BULL.HK')).toEqual({
      symbol: 'BULL.HK',
      name: null,
      price: '1.23',
      prevClose: '1.2',
      timestamp: Date.parse('2026-02-16T01:00:00.000Z'),
    });
  });

  it.each(['quote', 'missing'] as const)(
    'uses entry metadata for %s realtime result after unsubscribe and resubscribe',
    async (realtimeState) => {
      quoteMock.seedStaticInfo([
        { symbol: 'BULL.HK', info: { symbol: 'BULL.HK', nameHk: '入口名称', lotSize: 500 } },
      ]);
      quoteMock.seedQuotes([{ symbol: 'BULL.HK', quote: makeSeedQuote('BULL.HK', 1.23, 1.2) }]);
      const entered = Promise.withResolvers<undefined>();
      const release = Promise.withResolvers<undefined>();
      const client = await createMarketDataClient({
        config: createSdkConfigDouble(),
        quoteContextFactory: () => ({
          ...quoteMock,
          realtimeQuote: async (symbols) => {
            const quotes = await quoteMock.realtimeQuote(symbols);
            entered.resolve();
            await release.promise;
            return quotes;
          },
        }),
      });
      await client.subscribeSymbols(['BULL.HK']);
      if (realtimeState === 'missing') quoteMock.seedRealtimeQuotes([]);

      const warnings: string[] = [];
      const warn = spyOn(logger, 'warn').mockImplementation((message) => {
        warnings.push(message);
      });
      const reading = client.getQuotes(['BULL.HK']);
      try {
        await entered.promise;
        await client.unsubscribeSymbols(['BULL.HK']);
        quoteMock.seedStaticInfo([
          { symbol: 'BULL.HK', info: { symbol: 'BULL.HK', nameHk: '新名称', lotSize: 2000 } },
        ]);
        quoteMock.seedQuotes([{ symbol: 'BULL.HK', quote: makeSeedQuote('BULL.HK', 2.23, 2.2) }]);
        await client.subscribeSymbols(['BULL.HK']);
        release.resolve();
        const quotes = await reading;
        if (realtimeState === 'missing') {
          expect(quotes.get('BULL.HK')).toBeNull();
          expect(warnings).toEqual(['[行情获取] 标的 入口名称(BULL.HK) 无 realtime 数据']);
        } else {
          expect(quotes.get('BULL.HK')).toEqual({
            symbol: 'BULL.HK',
            name: '入口名称',
            price: '1.23',
            prevClose: '1.2',
            timestamp: Date.parse('2026-02-16T01:00:00.000Z'),
            lotSize: 500,
          });
          expect(warnings).toEqual([]);
        }
      } finally {
        release.resolve();
        try {
          await reading;
        } finally {
          warn.mockRestore();
        }
      }
    },
  );

  it('deduplicates candlestick subscription for the same symbol+period', async () => {
    quoteMock.seedCandlesticks('BULL.HK', RealPeriod.Min_1, [
      {
        open: new TestDecimal(1),
        close: new TestDecimal(1.1),
        high: new TestDecimal(1.2),
        low: new TestDecimal(0.9),
        volume: 1000,
        turnover: new TestDecimal(1000),
        timestamp: new Date('2026-02-16T01:00:00.000Z'),
      },
    ]);

    const client = await createMarketDataClient({
      config: createSdkConfigDouble(),
      quoteContextFactory: async () => quoteMock,
    });

    const first = await client.subscribeCandlesticks('BULL.HK', 'MIN_1');
    const second = await client.subscribeCandlesticks('BULL.HK', 'MIN_1');

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
    expect(quoteMock.getCalls('subscribeCandlesticks')).toHaveLength(1);
  });

  it('seeds local candlestick cache from subscribeCandlesticks result', async () => {
    const seedCandles = Array.from({ length: 200 }, (_value, index) =>
      makeCandlestick(
        100 + index * 0.1,
        `2026-02-16T01:${String(index % 60).padStart(2, '0')}:00.000Z`,
      ),
    );
    quoteMock.seedCandlesticks('BULL.HK', RealPeriod.Min_1, seedCandles);

    const client = await createMarketDataClient({
      config: createSdkConfigDouble(),
      quoteContextFactory: async () => quoteMock,
    });

    await client.subscribeCandlesticks('BULL.HK', 'MIN_1');
    const snapshot = client.getCandlestickSnapshot('BULL.HK', 'MIN_1');

    expect(snapshot).not.toBeNull();
    expect(snapshot?.initialized).toBe(true);
    expect(snapshot?.version).toBe(1);
    expect(snapshot?.candles.length).toBe(200);
  });

  it('replaces active bar when push timestamp matches current last bar', async () => {
    const seedCandles = [
      makeCandlestick(100, '2026-02-16T01:00:00.000Z'),
      makeCandlestick(101, '2026-02-16T01:01:00.000Z'),
    ];
    quoteMock.seedCandlesticks('BULL.HK', RealPeriod.Min_1, seedCandles);

    const client = await createMarketDataClient({
      config: createSdkConfigDouble(),
      quoteContextFactory: async () => quoteMock,
    });
    await client.subscribeCandlesticks('BULL.HK', 'MIN_1');

    const before = client.getCandlestickSnapshot('BULL.HK', 'MIN_1');
    expect(before).not.toBeNull();
    if (!before) {
      throw new Error('expected candlestick snapshot before push');
    }

    quoteMock.emitCandlestick(
      createPushCandlestickEvent({
        symbol: 'BULL.HK',
        close: 105,
        timestampMs: Date.parse('2026-02-16T01:01:00.000Z'),
        period: RealPeriod.Min_1,
        isConfirmed: false,
      }),
    );
    quoteMock.flushAllEvents();

    const after = client.getCandlestickSnapshot('BULL.HK', 'MIN_1');
    expect(after).not.toBeNull();
    expect(after?.candles.length).toBe(before.candles.length);
    expect(after?.version).toBe(before.version + 1);
    const latestClose = Number(after?.candles.at(-1)?.close?.toString() ?? Number.NaN);
    expect(latestClose).toBe(105);
  });

  it('marks last bar confirmed when same-timestamp confirmed push arrives', async () => {
    const seedCandles = [
      { ...makeCandlestick(100, '2026-02-16T01:00:00.000Z'), volume: 1 },
      { ...makeCandlestick(101, '2026-02-16T01:01:00.000Z'), volume: 1 },
    ];
    quoteMock.seedCandlesticks('BULL.HK', RealPeriod.Min_1, seedCandles);

    const client = await createMarketDataClient({
      config: createSdkConfigDouble(),
      quoteContextFactory: async () => quoteMock,
    });
    await client.subscribeCandlesticks('BULL.HK', 'MIN_1');

    const before = client.getCandlestickSnapshot('BULL.HK', 'MIN_1');
    expect(before).not.toBeNull();
    if (before === null) {
      throw new Error('expected candlestick snapshot before confirmation');
    }

    const beforeCandles = before.candles;
    const beforeCandle = before.candles.at(-1);
    const events: Array<{ readonly symbol: string; readonly period: CandlestickPeriod }> = [];
    const dispose = client.onCandlestickUpdated((event) => {
      events.push({ symbol: event.symbol, period: event.period });
    });

    quoteMock.emitCandlestick(
      createPushCandlestickEvent({
        symbol: 'BULL.HK',
        close: 101,
        timestampMs: Date.parse('2026-02-16T01:01:00.000Z'),
        period: RealPeriod.Min_1,
        isConfirmed: true,
      }),
    );
    quoteMock.flushAllEvents();

    const snapshot = client.getCandlestickSnapshot('BULL.HK', 'MIN_1');
    expect(snapshot).not.toBeNull();
    if (snapshot === null) {
      throw new Error('expected confirmed snapshot');
    }

    expect(snapshot.lastBarConfirmed).toBe(true);
    expect(snapshot.version).toBe(before.version + 1);
    expect(snapshot.candles).toBe(beforeCandles);
    expect(snapshot.candles.at(-1)).toBe(beforeCandle);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ symbol: 'BULL.HK', period: 'MIN_1' });

    const firstVersion = snapshot.version;
    quoteMock.emitCandlestick(
      createPushCandlestickEvent({
        symbol: 'BULL.HK',
        close: 101,
        timestampMs: Date.parse('2026-02-16T01:01:00.000Z'),
        period: RealPeriod.Min_1,
        isConfirmed: true,
      }),
    );
    quoteMock.flushAllEvents();

    const replaySnapshot = client.getCandlestickSnapshot('BULL.HK', 'MIN_1');
    expect(replaySnapshot?.version).toBe(firstVersion);

    const replayVersion = replaySnapshot?.version ?? 0;
    quoteMock.emitCandlestick(
      createPushCandlestickEvent({
        symbol: 'BULL.HK',
        close: 99,
        timestampMs: Date.parse('2026-02-16T01:01:00.000Z'),
        period: RealPeriod.Min_1,
        isConfirmed: false,
      }),
    );
    quoteMock.flushAllEvents();

    const rollbackSnapshot = client.getCandlestickSnapshot('BULL.HK', 'MIN_1');
    expect(rollbackSnapshot?.version).toBe(replayVersion);
    expect(rollbackSnapshot?.lastBarConfirmed).toBe(true);
    const rollbackClose = Number(rollbackSnapshot?.candles.at(-1)?.close?.toString() ?? Number.NaN);
    expect(rollbackClose).toBe(101);
    expect(events).toHaveLength(1);
    dispose();
  });

  it('appends next bar when push timestamp advances', async () => {
    const seedCandles = [
      makeCandlestick(100, '2026-02-16T01:00:00.000Z'),
      makeCandlestick(101, '2026-02-16T01:01:00.000Z'),
    ];
    quoteMock.seedCandlesticks('BULL.HK', RealPeriod.Min_1, seedCandles);

    const client = await createMarketDataClient({
      config: createSdkConfigDouble(),
      quoteContextFactory: async () => quoteMock,
    });
    await client.subscribeCandlesticks('BULL.HK', 'MIN_1');

    quoteMock.emitCandlestick(
      createPushCandlestickEvent({
        symbol: 'BULL.HK',
        close: 102,
        timestampMs: Date.parse('2026-02-16T01:02:00.000Z'),
        period: RealPeriod.Min_1,
        isConfirmed: false,
      }),
    );
    quoteMock.flushAllEvents();

    const snapshot = client.getCandlestickSnapshot('BULL.HK', 'MIN_1');
    expect(snapshot).not.toBeNull();
    expect(snapshot?.candles.length).toBe(seedCandles.length + 1);
    const latestClose = Number(snapshot?.candles.at(-1)?.close?.toString() ?? Number.NaN);
    expect(latestClose).toBe(102);
  });

  it('preserves retained candlestick snapshots across active replacement and full-window append', async () => {
    const firstTimestampMs = Date.parse('2026-02-16T01:00:00.000Z');
    const seedCandles = Array.from({ length: 200 }, (_value, index) =>
      makeCandlestick(100 + index, new Date(firstTimestampMs + index * 60_000).toISOString()),
    );
    quoteMock.seedCandlesticks('BULL.HK', RealPeriod.Min_1, seedCandles);

    const client = await createMarketDataClient({
      config: createSdkConfigDouble(),
      quoteContextFactory: async () => quoteMock,
    });
    await client.subscribeCandlesticks('BULL.HK', 'MIN_1');

    const seedSnapshot = client.getCandlestickSnapshot('BULL.HK', 'MIN_1');
    expect(seedSnapshot).not.toBeNull();
    if (!seedSnapshot) {
      throw new Error('expected seeded candlestick snapshot');
    }

    quoteMock.emitCandlestick(
      createPushCandlestickEvent({
        symbol: 'BULL.HK',
        close: 999,
        timestampMs: firstTimestampMs + 199 * 60_000,
        period: RealPeriod.Min_1,
        isConfirmed: false,
      }),
    );
    quoteMock.flushAllEvents();

    const replacedSnapshot = client.getCandlestickSnapshot('BULL.HK', 'MIN_1');
    expect(replacedSnapshot).not.toBeNull();
    if (!replacedSnapshot) {
      throw new Error('expected replaced candlestick snapshot');
    }

    expect(replacedSnapshot.candles).not.toBe(seedSnapshot.candles);
    expect(Number(seedSnapshot.candles.at(-1)?.close?.toString() ?? Number.NaN)).toBe(299);
    expect(Number(replacedSnapshot.candles.at(-1)?.close?.toString() ?? Number.NaN)).toBe(999);

    quoteMock.emitCandlestick(
      createPushCandlestickEvent({
        symbol: 'BULL.HK',
        close: 1000,
        timestampMs: firstTimestampMs + 200 * 60_000,
        period: RealPeriod.Min_1,
        isConfirmed: false,
      }),
    );
    quoteMock.flushAllEvents();

    const appendedSnapshot = client.getCandlestickSnapshot('BULL.HK', 'MIN_1');
    expect(appendedSnapshot).not.toBeNull();
    if (!appendedSnapshot) {
      throw new Error('expected appended candlestick snapshot');
    }

    expect(appendedSnapshot.candles).not.toBe(replacedSnapshot.candles);
    expect(replacedSnapshot.candles).toHaveLength(200);
    expect(Number(replacedSnapshot.candles.at(0)?.close?.toString() ?? Number.NaN)).toBe(100);
    expect(Number(replacedSnapshot.candles.at(-1)?.close?.toString() ?? Number.NaN)).toBe(999);
    expect(appendedSnapshot.candles).toHaveLength(200);
    expect(Number(appendedSnapshot.candles.at(0)?.close?.toString() ?? Number.NaN)).toBe(101);
    expect(Number(appendedSnapshot.candles.at(-1)?.close?.toString() ?? Number.NaN)).toBe(1000);
  });

  it('caches trading-day result and avoids duplicate API calls within TTL', async () => {
    const date = new Date('2026-02-16T01:00:00.000Z');
    const naive = new TestNaiveDate(2026, 2, 16);
    quoteMock.seedTradingDays(`${String(RealMarket.HK)}:${naive.toString()}:${naive.toString()}`, {
      tradingDays: [naive],
      halfTradingDays: [],
    });

    const client = await createMarketDataClient({
      config: createSdkConfigDouble(),
      quoteContextFactory: async () => quoteMock,
    });

    const first = await client.isTradingDay(date, 'HK');
    const second = await client.isTradingDay(date, 'HK');

    expect(first.isTradingDay).toBeTrue();
    expect(second.isTradingDay).toBeTrue();
    expect(quoteMock.getCalls('tradingDays')).toHaveLength(1);
  });

  it('rejects malformed trading-day responses without caching otherwise valid entries', async () => {
    const date = new Date('2026-02-16T01:00:00.000Z');
    const naive = new TestNaiveDate(2026, 2, 16);
    const key = `${String(RealMarket.HK)}:${naive.toString()}:${naive.toString()}`;
    quoteMock.seedTradingDays(key, {
      tradingDays: [naive, {}],
      halfTradingDays: [],
    });

    const client = await createMarketDataClient({
      config: createSdkConfigDouble(),
      quoteContextFactory: async () => quoteMock,
    });

    expect(client.getTradingDays(date, date, 'HK')).rejects.toThrow('[交易日历接口响应]');

    quoteMock.seedTradingDays(key, {
      tradingDays: [naive],
      halfTradingDays: [],
    });
    const dayInfo = await client.isTradingDay(date, 'HK');

    expect(dayInfo.isTradingDay).toBeTrue();
    expect(quoteMock.getCalls('tradingDays')).toHaveLength(2);
  });

  it('resetRuntimeSubscriptionsAndCaches clears runtime caches and quote subscriptions', async () => {
    quoteMock.seedStaticInfo([
      {
        symbol: 'BULL.HK',
        info: {
          symbol: 'BULL.HK',
          nameHk: '测试牛证',
          lotSize: 500,
        },
      },
    ]);

    quoteMock.seedQuotes([
      {
        symbol: 'BULL.HK',
        quote: makeSeedQuote('BULL.HK', 1.23, 1.2),
      },
    ]);

    const client = await createMarketDataClient({
      config: createSdkConfigDouble(),
      quoteContextFactory: async () => quoteMock,
    });

    await client.subscribeSymbols(['BULL.HK']);
    await client.subscribeCandlesticks('BULL.HK', 'MIN_1');

    const received: string[] = [];
    client.onQuoteUpdated((event) => {
      received.push(event.symbol);
    });

    await client.resetRuntimeSubscriptionsAndCaches();
    quoteMock.emitQuote(createPushQuoteEvent({ symbol: 'BULL.HK', price: 1.31 }));
    quoteMock.flushAllEvents();

    expect(client.getQuotes(['BULL.HK'])).rejects.toThrow('未订阅');
    expect(received).toHaveLength(0);
    expect(quoteMock.getCalls('unsubscribe')).toHaveLength(1);
    expect(quoteMock.getCalls('unsubscribeCandlesticks')).toHaveLength(1);
  });

  it('restores quote metadata after unsubscribe failure during reset and a later subscribe', async () => {
    quoteMock.seedStaticInfo([
      {
        symbol: 'BULL.HK',
        info: {
          symbol: 'BULL.HK',
          nameHk: '测试牛证',
          lotSize: 500,
        },
      },
    ]);

    quoteMock.seedQuotes([
      {
        symbol: 'BULL.HK',
        quote: makeSeedQuote('BULL.HK', 1.23, 1.2),
      },
    ]);

    const client = await createMarketDataClient({
      config: createSdkConfigDouble(),
      quoteContextFactory: async () => quoteMock,
    });

    await client.subscribeSymbols(['BULL.HK']);
    quoteMock.setFailureRule('unsubscribe', {
      failAtCalls: [1, 2, 3],
      maxFailures: 3,
      errorMessage: 'service unavailable',
    });

    expect(client.resetRuntimeSubscriptionsAndCaches()).rejects.toThrow('外部 API 请求失败');

    quoteMock.clearFailureRules();

    await client.subscribeSymbols(['BULL.HK']);
    const quotes = await client.getQuotes(['BULL.HK']);
    const quote = quotes.get('BULL.HK');

    expect(quote?.name).toBe('测试牛证');
    expect(quote?.lotSize).toBe(500);
    expect(quote?.prevClose).toBe('1.2');
  });

  it('keeps external API classification for pure unsubscribe failures during reset', async () => {
    quoteMock.seedStaticInfo([
      {
        symbol: 'BULL.HK',
        info: {
          symbol: 'BULL.HK',
          nameHk: '测试牛证',
          lotSize: 500,
        },
      },
    ]);

    quoteMock.seedQuotes([
      {
        symbol: 'BULL.HK',
        quote: makeSeedQuote('BULL.HK', 1.23, 1.2),
      },
    ]);

    const client = await createMarketDataClient({
      config: createSdkConfigDouble(),
      quoteContextFactory: async () => quoteMock,
    });

    await client.subscribeSymbols(['BULL.HK']);
    quoteMock.setFailureRule('unsubscribe', {
      failAtCalls: [1, 2, 3],
      maxFailures: 3,
      errorMessage: 'service unavailable',
    });

    let caught: unknown = null;
    try {
      await client.resetRuntimeSubscriptionsAndCaches();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    expect(isExternalApiRequestError(caught)).toBeTrue();
  });

  it('keeps mixed reset failures outside external API retry classification', async () => {
    quoteMock.seedStaticInfo([
      {
        symbol: 'BULL.HK',
        info: {
          symbol: 'BULL.HK',
          nameHk: '测试牛证',
          lotSize: 500,
        },
      },
    ]);

    quoteMock.seedQuotes([
      {
        symbol: 'BULL.HK',
        quote: makeSeedQuote('BULL.HK', 1.23, 1.2),
      },
    ]);

    const client = await createMarketDataClient({
      config: createSdkConfigDouble(),
      quoteContextFactory: async () => quoteMock,
    });

    await client.subscribeSymbols(['BULL.HK']);
    await client.subscribeCandlesticks('', 'MIN_1');
    quoteMock.setFailureRule('unsubscribe', {
      failAtCalls: [1, 2, 3],
      maxFailures: 3,
      errorMessage: 'service unavailable',
    });

    let caught: unknown = null;
    try {
      await client.resetRuntimeSubscriptionsAndCaches();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    expect(isExternalApiRequestError(caught)).toBeFalse();
  });

  it('keeps local candlestick cache for unsubscribe-failed keys during reset', async () => {
    quoteMock.seedCandlesticks('BULL.HK', RealPeriod.Min_1, [
      makeCandlestick(100, '2026-02-16T01:00:00.000Z'),
    ]);

    quoteMock.seedCandlesticks('BEAR.HK', RealPeriod.Min_1, [
      makeCandlestick(200, '2026-02-16T01:00:00.000Z'),
    ]);

    const client = await createMarketDataClient({
      config: createSdkConfigDouble(),
      quoteContextFactory: async () => quoteMock,
    });

    await client.subscribeCandlesticks('BULL.HK', 'MIN_1');
    await client.subscribeCandlesticks('BEAR.HK', 'MIN_1');
    quoteMock.setFailureRule('unsubscribeCandlesticks', {
      failAtCalls: [2, 3, 4],
      maxFailures: 3,
      errorMessage: 'service unavailable',
    });

    expect(client.resetRuntimeSubscriptionsAndCaches()).rejects.toThrow('外部 API 请求失败');

    const bullSnapshot = client.getCandlestickSnapshot('BULL.HK', 'MIN_1');
    const bearSnapshot = client.getCandlestickSnapshot('BEAR.HK', 'MIN_1');
    expect(bullSnapshot).toBeNull();
    expect(bearSnapshot?.initialized).toBe(true);
  });
});
