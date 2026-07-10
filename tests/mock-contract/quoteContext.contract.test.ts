/**
 * quoteContext 契约测试
 *
 * 功能：
 * - 验证 QuoteContext Mock 契约与调用行为。
 */
import { describe, expect, it } from 'bun:test';
import {
  Market,
  Period,
  SortOrderType,
  SubType,
  TradeSessions,
  WarrantSortBy,
  WarrantType,
} from 'longbridge';
import { createQuoteContextMock } from '../../mock/longbridge/quoteContextMock.js';
import {
  createCandlestick,
  createPushCandlestickEvent,
  createPushQuoteEvent,
  createWarrantInfo,
  createWarrantQuote,
} from '../../mock/factories/quoteFactory.js';
import { toMockDecimal } from '../../mock/longbridge/decimal.js';

describe('QuoteContext mock contract', () => {
  it('implements required quote APIs and keeps subscription/cache semantics', async () => {
    const quoteCtx = createQuoteContextMock();

    quoteCtx.seedQuotes([
      {
        symbol: '700.HK',
        quote: {
          symbol: '700.HK',
          lastDone: toMockDecimal(320),
          prevClose: toMockDecimal(320),
          timestamp: new Date(),
        },
      },
    ]);

    quoteCtx.seedStaticInfo([
      {
        symbol: '700.HK',
        info: {
          symbol: '700.HK',
          nameCn: 'Tencent',
          nameHk: 'Tencent',
          nameEn: 'Tencent',
          lotSize: 100,
        },
      },
    ]);

    quoteCtx.seedCandlesticks('700.HK', Period.Min_1, [
      createCandlestick({ close: 320 }),
      createCandlestick({ close: 321 }),
    ]);

    quoteCtx.seedWarrantQuotes([
      createWarrantQuote({ symbol: '12345.HK', callPrice: 20000, category: 3 }),
    ]);

    quoteCtx.seedWarrantList('HSI.HK', [
      createWarrantInfo({ symbol: '12345.HK', warrantType: 'Bull', callPrice: 20000 }),
      createWarrantInfo({ symbol: '54321.HK', warrantType: 'Bear', callPrice: 22000 }),
    ]);

    quoteCtx.seedTradingDays(`${String(Market.HK)}:2026-02-16:2026-02-16`, {
      tradingDays: ['2026-02-16'],
      halfTradingDays: [],
    });

    await quoteCtx.subscribe(['700.HK'], [SubType.Quote]);
    const quotes = await quoteCtx.quote(['700.HK']);
    const staticInfos = await quoteCtx.staticInfo(['700.HK']);
    const candles = await quoteCtx.subscribeCandlesticks('700.HK', Period.Min_1, TradeSessions.All);
    const tradingDays = await quoteCtx.tradingDays(Market.HK, '2026-02-16', '2026-02-16');
    const warrantQuotes = await quoteCtx.warrantQuote(['12345.HK']);
    const warrantBullList = await quoteCtx.warrantList(
      'HSI.HK',
      WarrantSortBy.LastDone,
      SortOrderType.Descending,
      [WarrantType.Bull],
    );

    expect(quotes).toHaveLength(1);
    expect(staticInfos).toHaveLength(1);
    expect(candles).toHaveLength(2);
    expect(tradingDays.tradingDays.map(String)).toEqual(['2026-02-16']);
    expect(warrantQuotes).toHaveLength(1);
    expect(warrantBullList).toHaveLength(1);

    await quoteCtx.unsubscribe(['700.HK'], [SubType.Quote]);
  });

  it('supports out-of-order push delivery and callback hooks', () => {
    const quoteCtx = createQuoteContextMock();
    const quotePrices: number[] = [];
    const candlePrices: number[] = [];
    const deliverAtMs = Date.parse('2026-02-16T01:00:00.000Z');

    quoteCtx.setOnQuote((_err, event) => {
      quotePrices.push(event.data.lastDone.toNumber());
    });

    quoteCtx.setOnCandlestick((_err, event) => {
      const data = event.data as unknown as {
        readonly candlestick: { readonly close: { readonly toNumber: () => number } };
      };
      candlePrices.push(data.candlestick.close.toNumber());
    });

    quoteCtx.emitQuote(createPushQuoteEvent({ symbol: '700.HK', price: 320 }), {
      deliverAtMs,
      sequence: 2,
    });

    quoteCtx.emitQuote(createPushQuoteEvent({ symbol: '700.HK', price: 319 }), {
      deliverAtMs,
      sequence: 1,
    });

    quoteCtx.emitCandlestick(createPushCandlestickEvent({ symbol: '700.HK', close: 320 }), {
      deliverAtMs,
      sequence: 1,
    });

    expect(quoteCtx.flushAllEvents()).toBe(3);
    expect(quotePrices).toEqual([319, 320]);
    expect(candlePrices).toEqual([320]);
  });

  it('delivers only due events at the requested time and flushes remaining events', () => {
    const quoteCtx = createQuoteContextMock();
    const quotePrices: number[] = [];
    const firstDeliverAtMs = Date.parse('2026-02-16T01:00:00.000Z');

    quoteCtx.setOnQuote((_err, event) => {
      quotePrices.push(event.data.lastDone.toNumber());
    });

    quoteCtx.emitQuote(createPushQuoteEvent({ symbol: '700.HK', price: 320 }), {
      deliverAtMs: firstDeliverAtMs,
    });

    expect(quoteCtx.flushEvents(firstDeliverAtMs - 1)).toBe(0);
    expect(quotePrices).toEqual([]);
    expect(quoteCtx.flushEvents(firstDeliverAtMs)).toBe(1);
    expect(quotePrices).toEqual([320]);
    expect(quoteCtx.flushEvents(firstDeliverAtMs)).toBe(0);
    expect(quotePrices).toEqual([320]);

    quoteCtx.emitQuote(createPushQuoteEvent({ symbol: '700.HK', price: 321 }), {
      deliverAtMs: firstDeliverAtMs + 60_000,
    });

    expect(quoteCtx.flushAllEvents()).toBe(1);
    expect(quotePrices).toEqual([320, 321]);
  });

  it('supports deterministic failure injection and invocation logs', async () => {
    const quoteCtx = createQuoteContextMock();
    quoteCtx.setFailureRule('quote', {
      failAtCalls: [2],
      errorMessage: 'quote call failed by rule',
    });

    await quoteCtx.quote(['700.HK']);

    expect(async () => {
      await quoteCtx.quote(['700.HK']);
    }).toThrow('quote call failed by rule');

    const logs = quoteCtx.getCalls('quote');
    expect(logs).toHaveLength(2);
    expect(logs[0]?.error).toBeNull();
    expect(logs[1]?.error?.message).toContain('quote call failed by rule');
  });
});
