/**
 * orderMonitor 回归测试
 *
 * 保留几个容易回退的行为：
 * - 卖单改单阈值边界
 * - 禁止买单追价高于初始价
 * - 卖单超时撤单成功后不重复撤单
 */
import { describe, expect, it } from 'bun:test';
import { OrderSide, OrderType, type TradeContext } from 'longbridge';
import { createOrderMonitor } from '../../src/core/trader/orderMonitor/index.js';
import { createOrderHoldRegistry } from '../../src/core/trader/orderHoldRegistry.js';
import type { OrderMonitorDeps } from '../../src/core/trader/types.js';
import {
  createGlobalConfig,
  createStrategyRuntimeConfig,
} from '../../mock/factories/configFactory.js';
import { createTradeContextMock } from '../../mock/longbridge/tradeContextMock.js';
import {
  createDailyLossTrackerDouble,
  createMarketDataClientDouble,
  createProtectiveLiquidationEpisodeTrackerDouble,
  createQuoteDouble,
  createSymbolRegistryDouble,
} from '../helpers/testDoubles.js';

function createDeps(params?: {
  readonly sellTimeoutSeconds?: number;
  readonly buyTimeoutSeconds?: number;
  readonly allowBuyOrderTrackingAboveInitialPrice?: boolean;
}) {
  const tradeCtx = createTradeContextMock();
  let quotes = new Map<string, ReturnType<typeof createQuoteDouble> | null>([
    ['BULL.HK', createQuoteDouble('BULL.HK', 1.02)],
  ]);

  const deps: OrderMonitorDeps = {
    ctxPromise: Promise.resolve(tradeCtx as unknown as TradeContext),
    rateLimiter: {
      throttle: async () => {},
    },
    cacheManager: {
      clearCache: () => {},
      getPendingOrders: async () => [],
    },
    marketDataClient: createMarketDataClientDouble({
      getQuotes: async () => new Map(quotes),
    }),
    globalConfig: createGlobalConfig({
      buyOrderTimeout: {
        enabled: true,
        timeoutSeconds: params?.buyTimeoutSeconds ?? 999,
      },
      sellOrderTimeout: {
        enabled: true,
        timeoutSeconds: params?.sellTimeoutSeconds ?? 999,
      },
      orderMonitorPriceUpdateInterval: 0,
      allowBuyOrderTrackingAboveInitialPrice:
        params?.allowBuyOrderTrackingAboveInitialPrice ?? true,
    }),
    monitorConfig: createStrategyRuntimeConfig(),
    dailyLossTracker: createDailyLossTrackerDouble(),
    orderHoldRegistry: createOrderHoldRegistry(),
    protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
    symbolRegistry: createSymbolRegistryDouble(),
    isExecutionAllowed: () => true,
  };

  return {
    tradeCtx,
    deps,
    setQuote(price: number) {
      quotes = new Map([['BULL.HK', createQuoteDouble('BULL.HK', price)]]);
    },
  };
}

describe('orderMonitor regression', () => {
  it('keeps replace threshold stable on floating boundary', async () => {
    const { deps, tradeCtx, setQuote } = createDeps();
    const monitor = createOrderMonitor(deps);

    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);

    setQuote(0.05 + 0.008);
    monitor.trackOrder({
      orderId: 'SELL-BOUNDARY-EQUAL',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      price: 0.059,
      initialSubmittedPrice: 0.059,
      quantity: 100,
      isLongSymbol: true,
      baseInstrumentSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: OrderType.ELO,
    });
    await monitor.processWithLatestQuotes();
    expect(tradeCtx.getCalls('replaceOrder')).toHaveLength(1);

    setQuote(0.0581);
    monitor.trackOrder({
      orderId: 'SELL-BOUNDARY-LESS',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      price: 0.059,
      initialSubmittedPrice: 0.059,
      quantity: 100,
      isLongSymbol: true,
      baseInstrumentSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: OrderType.ELO,
    });
    await monitor.processWithLatestQuotes();

    expect(tradeCtx.getCalls('replaceOrder')).toHaveLength(1);
  });

  it('still blocks buy replace above initial submitted price when configured off', async () => {
    const { deps, tradeCtx, setQuote } = createDeps({
      allowBuyOrderTrackingAboveInitialPrice: false,
    });
    const monitor = createOrderMonitor(deps);

    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    setQuote(0.51);
    monitor.trackOrder({
      orderId: 'BUY-CHASE-BLOCK',
      symbol: 'BULL.HK',
      side: OrderSide.Buy,
      price: 0.5,
      initialSubmittedPrice: 0.5,
      quantity: 100,
      isLongSymbol: true,
      baseInstrumentSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: OrderType.ELO,
    });

    await monitor.processWithLatestQuotes();

    expect(tradeCtx.getCalls('replaceOrder')).toHaveLength(0);
  });

  it('does not repeatedly cancel timed-out sell after cancel request succeeds', async () => {
    const { deps, tradeCtx } = createDeps({
      sellTimeoutSeconds: 0,
    });
    const monitor = createOrderMonitor(deps);

    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.trackOrder({
      orderId: 'SELL-TIMEOUT-WAIT-WS',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      price: 1,
      initialSubmittedPrice: 1,
      quantity: 100,
      isLongSymbol: true,
      baseInstrumentSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: OrderType.ELO,
    });

    await monitor.processWithLatestQuotes();
    await monitor.processWithLatestQuotes();

    expect(tradeCtx.getCalls('cancelOrder')).toHaveLength(1);
    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(0);
    expect(monitor.hasPendingSellOrders('BULL.HK')).toBeTrue();
  });
});
