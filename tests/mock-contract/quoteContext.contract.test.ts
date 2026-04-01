/**
 * quoteContext 契约测试
 *
 * 功能：
 * - 验证 QuoteContext Mock 契约与调用行为。
 */
import { describe, expect, it } from 'bun:test';
import {
  AdjustType,
  Market,
  NaiveDate,
  NaiveDatetime,
  Period,
  SortOrderType,
  Time,
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
  createSecurityQuote,
  createSecurityStaticInfo,
  createTradingDaysResult,
  createWarrantInfo,
  createWarrantQuote,
} from '../../mock/factories/quoteFactory.js';

describe('QuoteContext mock contract', () => {
  it('implements required quote APIs and keeps subscription/cache semantics', async () => {
    const quoteCtx = createQuoteContextMock();

    quoteCtx.seedQuotes([{ symbol: '700.HK', quote: createSecurityQuote('700.HK', 320) }]);
    quoteCtx.seedStaticInfo([
      { symbol: '700.HK', info: createSecurityStaticInfo('700.HK', 'Tencent', 100) },
    ]);

    quoteCtx.seedCandlesticks('700.HK', Period.Min_1, [
      createCandlestick({ close: 320, timestampMs: Date.parse('2026-02-16T01:00:00.000Z') }),
      createCandlestick({ close: 321, timestampMs: Date.parse('2026-02-16T01:01:00.000Z') }),
    ]);

    quoteCtx.seedWarrantQuotes([
      createWarrantQuote({ symbol: '12345.HK', callPrice: 20000, category: 3 }),
    ]);

    quoteCtx.seedWarrantList('HSI.HK', [
      createWarrantInfo({ symbol: '12345.HK', warrantType: 'Bull', callPrice: 20000 }),
      createWarrantInfo({ symbol: '54321.HK', warrantType: 'Bear', callPrice: 22000 }),
    ]);

    quoteCtx.seedTradingDays(
      `${String(Market.HK)}:2026-02-16:2026-02-16`,
      createTradingDaysResult({
        tradingDays: ['2026-02-16'],
        halfTradingDays: [],
      }),
    );

    await quoteCtx.subscribe(['700.HK'], [SubType.Quote]);
    const quotes = await quoteCtx.quote(['700.HK']);
    const staticInfos = await quoteCtx.staticInfo(['700.HK']);
    const candles = await quoteCtx.subscribeCandlesticks('700.HK', Period.Min_1, TradeSessions.All);
    const latestCandle = await quoteCtx.realtimeCandlesticks('700.HK', Period.Min_1, 1);
    const historyCandles = await quoteCtx.historyCandlesticksByOffset(
      '700.HK',
      Period.Min_1,
      AdjustType.NoAdjust,
      false,
      new NaiveDatetime(new NaiveDate(2026, 2, 16), new Time(9, 3, 0)),
      2,
      TradeSessions.All,
    );
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
    expect(latestCandle).toHaveLength(1);
    expect(historyCandles).toHaveLength(2);
    expect(tradingDays.tradingDays.map(String)).toEqual(['2026-02-16']);
    expect(warrantQuotes).toHaveLength(1);
    expect(warrantBullList).toHaveLength(1);
    expect(quoteCtx.getSubscribedSymbols().has('700.HK')).toBe(true);
    expect(quoteCtx.getCalls('historyCandlesticksByOffset')).toHaveLength(1);

    await quoteCtx.unsubscribe(['700.HK'], [SubType.Quote]);
    expect(quoteCtx.getSubscribedSymbols().has('700.HK')).toBe(false);
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

  it('supports history candlestick pagination and failure injection', async () => {
    const quoteCtx = createQuoteContextMock();
    quoteCtx.seedCandlesticks('700.HK', Period.Min_1, [
      createCandlestick({ close: 100, timestampMs: Date.parse('2026-02-16T01:00:00.000Z') }),
      createCandlestick({ close: 101, timestampMs: Date.parse('2026-02-16T01:01:00.000Z') }),
      createCandlestick({ close: 102, timestampMs: Date.parse('2026-02-16T01:02:00.000Z') }),
      createCandlestick({ close: 103, timestampMs: Date.parse('2026-02-16T01:03:00.000Z') }),
    ]);

    const latestTwo = await quoteCtx.historyCandlesticksByOffset(
      '700.HK',
      Period.Min_1,
      AdjustType.NoAdjust,
      false,
      null,
      2,
      TradeSessions.All,
    );
    const olderTwo = await quoteCtx.historyCandlesticksByOffset(
      '700.HK',
      Period.Min_1,
      AdjustType.NoAdjust,
      false,
      new NaiveDatetime(new NaiveDate(2026, 2, 16), new Time(9, 3, 0)),
      2,
      TradeSessions.All,
    );

    const readClose = (candle: unknown): number => {
      const close = (candle as { readonly close: unknown }).close;
      if (typeof close === 'number') {
        return close;
      }

      if (close !== null && typeof close === 'object' && 'toNumber' in close) {
        return (close as { readonly toNumber: () => number }).toNumber();
      }

      return Number.parseFloat(String(close));
    };

    expect(latestTwo.map(readClose)).toEqual([102, 103]);
    expect(olderTwo.map(readClose)).toEqual([101, 102]);
    expect(quoteCtx.getCalls('historyCandlesticksByOffset')).toHaveLength(2);

    quoteCtx.setFailureRule('historyCandlesticksByOffset', {
      failAtCalls: [4],
      errorMessage: 'history candlestick call failed by rule',
    });

    await quoteCtx.historyCandlesticksByOffset(
      '700.HK',
      Period.Min_1,
      AdjustType.NoAdjust,
      false,
      null,
      1,
      TradeSessions.All,
    );

    expect(async () => {
      await quoteCtx.historyCandlesticksByOffset(
        '700.HK',
        Period.Min_1,
        AdjustType.NoAdjust,
        false,
        null,
        1,
        TradeSessions.All,
      );
    }).toThrow('history candlestick call failed by rule');
  });
});
