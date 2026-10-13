/** 离线行情测试入口：私有构造 SDK candle/push/config，用真实行情 client 或工具计算得到中性出口。 */
import { Decimal, TradeSession, type Candlestick, type PushCandlestickEvent } from 'longbridge';
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

/** 创建生产 client，SDK Config 与离线 context 的装配留在合法 infra 测试边界。 */
export async function createMarketFixture(): Promise<MarketFixture> {
  const context = createQuoteContextMock();
  const client = await createMarketDataClient({
    config: {
      refreshAccessToken: () => {
        throw new Error('offline market fixture cannot refresh SDK credentials');
      },
    },
    quoteContextFactory: () => context,
  });
  return {
    client: {
      getQuoteContext: client.getQuoteContext,
      getQuotes: (symbols) => client.getQuotes(symbols),
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
