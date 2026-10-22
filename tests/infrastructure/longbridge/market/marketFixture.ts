/** 离线行情测试入口：私有构造 SDK candle/push/config，用真实行情 client 或工具计算得到中性出口。 */
import {
  Decimal,
  TradeSession,
  TradeStatus,
  WarrantStatus,
  WarrantType,
  type Candlestick,
  type PushCandlestickEvent,
} from 'longbridge';
import { createQuoteContextMock } from '../../../../mock/longbridge/quoteContextMock.js';
import { createMarketDataClient } from '../../../../src/infrastructure/longbridge/market/quoteClient.js';
import { mapCandlestickPeriodToSdk } from '../../../../src/infrastructure/longbridge/market/marketEnumMapper.js';
import type { CandlestickPeriod } from '../../../../src/types/marketPorts.js';
import { computeMinuteRows } from '../../../../tools/dailyIndicatorAnalysis/utils.js';
import type {
  ComputeMinuteRowsOptions,
  ComputeMinuteRowsResult,
} from '../../../../tools/dailyIndicatorAnalysis/types.js';
import type { MarketCandleInput, MarketFixture } from './types.js';

/** 完整满足 SDK candle 静态契约；Decimal 与 Date 不离开 infra producer。 */
function createSdkCandlestick(input: MarketCandleInput): Candlestick {
  return {
    open: new Decimal(input.open),
    high: new Decimal(input.high),
    low: new Decimal(input.low),
    close: new Decimal(input.close),
    volume: input.volume,
    turnover: new Decimal(input.turnover),
    timestamp: new Date(input.timestampMs),
    tradeSession: TradeSession.Intraday,
    toString: () => JSON.stringify(input),
    toJSON: () => input,
  };
}

/** SDK push 完整形状仅交给私有 QuoteContext mock；调用者给定的是中性事实。 */
function createSdkCandlestickPush(
  symbol: string,
  period: CandlestickPeriod,
  candle: MarketCandleInput,
  isConfirmed: boolean,
): PushCandlestickEvent {
  const data = {
    period: mapCandlestickPeriodToSdk(period),
    candlestick: createSdkCandlestick(candle),
    isConfirmed,
    toString: () => JSON.stringify({ period, candle, isConfirmed }),
    toJSON: () => ({ period, candle, isConfirmed }),
  };
  return {
    symbol,
    data,
    toString: () => JSON.stringify({ symbol, period, candle, isConfirmed }),
  };
}

/** 调用首参的合法形态只有标的字符串或全字符串标的数组；其余形态是 fixture 契约破裂，不静默降级。 */
function isSymbolList(value: unknown): value is ReadonlyArray<string> {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === 'string');
}

/** 创建生产 client，SDK Config、离线 context 与场景 control 的装配留在合法 infra 测试边界。 */
export async function createMarketFixture(): Promise<MarketFixture> {
  const context = createQuoteContextMock();
  let armedRealtimeQuoteGate: {
    readonly entered: () => void;
    readonly released: Promise<void>;
  } | null = null;
  let armedSecurityStatusGate: {
    readonly entered: () => void;
    readonly released: Promise<void>;
  } | null = null;
  // 只暂停首次武装的读取，底层结果取得后不改写其原始事实。
  const quoteContext = {
    ...context,
    quote: async (symbols: ReadonlyArray<string>) => {
      const quotes = await context.quote(symbols);
      const gate = armedSecurityStatusGate;
      if (gate !== null) {
        armedSecurityStatusGate = null;
        gate.entered();
        await gate.released;
      }

      return quotes;
    },
    realtimeQuote: async (symbols: ReadonlyArray<string>) => {
      const quotes = await context.realtimeQuote(symbols);
      const gate = armedRealtimeQuoteGate;
      if (gate !== null) {
        armedRealtimeQuoteGate = null;
        gate.entered();
        await gate.released;
      }

      return quotes;
    },
  };
  const client = await createMarketDataClient({
    config: {
      refreshAccessToken: () => {
        throw new Error('offline market fixture cannot refresh SDK credentials');
      },
    },
    quoteContextFactory: () => quoteContext,
  });
  return {
    client: {
      getQuoteContext: client.getQuoteContext,
      getQuotes: (symbols) => client.getQuotes(symbols),
      getSecurityTradingStatuses: client.getSecurityTradingStatuses,
      subscribeSymbols: client.subscribeSymbols,
      unsubscribeSymbols: client.unsubscribeSymbols,
      onQuoteUpdated: client.onQuoteUpdated,
      onCandlestickUpdated: client.onCandlestickUpdated,
      subscribeCandlesticks: client.subscribeCandlesticks,
      getCandlestickSnapshot: client.getCandlestickSnapshot,
      isTradingDay: client.isTradingDay,
      getTradingDays: client.getTradingDays,
      resetRuntimeSubscriptionsAndCaches: client.resetRuntimeSubscriptionsAndCaches,
    },
    controller: {
      seedSymbolMetadata: (symbols, previousClose, lotSize) => {
        context.seedStaticInfo(
          symbols.map((symbol) => ({ symbol, info: { symbol, nameCn: symbol, lotSize } })),
        );

        context.seedQuotes(
          symbols.map((symbol) => ({ symbol, quote: { symbol, prevClose: previousClose } })),
        );
      },
      seedQuotes: (quotes) => {
        context.seedStaticInfo(
          quotes.map((quote) => ({
            symbol: quote.symbol,
            info: {
              symbol: quote.symbol,
              nameHk: quote.name,
              ...(quote.lotSize === undefined ? {} : { lotSize: quote.lotSize }),
            },
          })),
        );

        context.seedQuotes(
          quotes.map((quote) => {
            const tradeStatus =
              quote.tradingStatus === 'SUSPEND' ? TradeStatus.Suspend : TradeStatus.Normal;
            return {
              symbol: quote.symbol,
              quote: {
                symbol: quote.symbol,
                lastDone: new Decimal(quote.price),
                prevClose: new Decimal(quote.previousClose),
                timestamp: new Date(quote.timestampMs),
                tradeStatus: quote.tradingStatus === null ? null : tradeStatus,
              },
            };
          }),
        );
      },
      seedWarrants: (monitorSymbol, warrants) => {
        context.seedWarrantList(
          monitorSymbol,
          warrants.map((warrant) => ({
            symbol: warrant.symbol,
            name: warrant.name,
            lastDone: new Decimal(warrant.price),
            callPrice: new Decimal(warrant.callPrice),
            toCallPrice: new Decimal(warrant.toCallPrice),
            turnover: new Decimal(warrant.turnover),
            warrantType: warrant.direction === 'BULL' ? WarrantType.Bull : WarrantType.Bear,
            status: WarrantStatus.Normal,
          })),
        );
      },
      pauseFirstRealtimeQuote: () => {
        if (armedRealtimeQuoteGate !== null)
          throw new Error('market fixture realtime quote gate already armed');

        const entered = Promise.withResolvers<undefined>();
        const released = Promise.withResolvers<undefined>();
        armedRealtimeQuoteGate = {
          entered: () => {
            entered.resolve();
          },
          released: released.promise,
        };
        return {
          entered: entered.promise,
          release: () => {
            released.resolve();
          },
        };
      },
      pauseFirstSecurityTradingStatusRead: () => {
        if (armedSecurityStatusGate !== null)
          throw new Error('market fixture security trading status gate already armed');

        const entered = Promise.withResolvers<undefined>();
        const released = Promise.withResolvers<undefined>();
        armedSecurityStatusGate = {
          entered: () => {
            entered.resolve();
          },
          released: released.promise,
        };
        return {
          entered: entered.promise,
          release: () => {
            released.resolve();
          },
        };
      },
      readSymbolCalls: (method) =>
        context.getCalls(method).map((call, index) => {
          const first = call.args[0];
          if (typeof first === 'string') return [first];

          if (isSymbolList(first)) return first;

          throw new TypeError(
            `[marketFixture] ${method} call #${index} first argument is neither a symbol string nor a symbol string list`,
          );
        }),
      seedCandlesticks: (symbol, period, candles) => {
        context.seedCandlesticks(
          symbol,
          mapCandlestickPeriodToSdk(period),
          candles.map(createSdkCandlestick),
        );
      },
      emitCandlestick: (symbol, period, candle, isConfirmed) => {
        context.emitCandlestick(createSdkCandlestickPush(symbol, period, candle, isConfirmed));
      },
      flushAllEvents: () => context.flushAllEvents(),
    },
  };
}

/** 工具 driver 真实调用 SDK 入参计算，只向工具业务测试发布中性分钟指标结果。 */
export function computeDailyMinuteRows(
  candles: ReadonlyArray<MarketCandleInput>,
  options: ComputeMinuteRowsOptions,
): ComputeMinuteRowsResult {
  return computeMinuteRows(candles.map(createSdkCandlestick), options);
}
