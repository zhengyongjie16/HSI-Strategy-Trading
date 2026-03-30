/**
 * api-flaky-recovery 混沌测试
 *
 * 覆盖：
 * - 卖单超时撤单失败后的退避重试
 * - 交易后刷新在 API 短暂失败后的 backlog 合并恢复
 */
import { describe, expect, it } from 'bun:test';
import { OrderSide, OrderType, type TradeContext } from 'longbridge';
import { createOrderMonitor } from '../../src/core/trader/orderMonitor/index.js';
import { createOrderHoldRegistry } from '../../src/core/trader/orderHoldRegistry.js';
import type { OrderMonitorDeps } from '../../src/core/trader/types.js';
import { createPostTradeRefresher } from '../../src/main/asyncProgram/postTradeRefresher/index.js';
import { createRefreshGate } from '../../src/utils/refreshGate/index.js';
import type { LastState } from '../../src/types/state.js';
import {
  createGlobalConfig,
  createStrategyRuntimeConfig,
} from '../../mock/factories/configFactory.js';
import { createTradeContextMock } from '../../mock/longbridge/tradeContextMock.js';
import {
  createAccountSnapshotDouble,
  createDailyLossTrackerDouble,
  createLiquidationCooldownTrackerDouble,
  createMarketDataClientDouble,
  createPositionCacheDouble,
  createPositionDouble,
  createProtectiveLiquidationEpisodeTrackerDouble,
  createQuoteDouble,
  createRiskCheckerDouble,
  createStrategyRuntimeDouble,
  createSymbolRegistryDouble,
  createTraderDouble,
} from '../helpers/testDoubles.js';

function createLastState(): LastState {
  return {
    canTrade: true,
    isHalfDay: false,
    openProtectionActive: false,
    currentDayKey: '2026-02-16',
    lifecycleState: 'ACTIVE' as const,
    pendingOpenRebuild: false,
    targetTradingDayKey: null,
    isTradingEnabled: true,
    cachedAccount: null,
    cachedPositions: [],
    positionCache: createPositionCacheDouble(),
    cachedTradingDayInfo: null,
    monitorState: {
      baseInstrumentSymbol: 'HSI.HK',
      monitorPrice: null,
      longPrice: null,
      shortPrice: null,
      signal: null,
      pendingSignals: [],
      monitorValues: null,
      lastMonitorSnapshot: null,
      lastCandlestickCacheVersion: null,
      lastDisplaySignature: null,
      displayPlan: ['price', 'changePercent'] as const,
    },
    allTradingSymbols: new Set<string>(),
  };
}

function createOrderMonitorDeps(params?: { readonly sellTimeoutSeconds?: number }) {
  const tradeCtx = createTradeContextMock();
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
      getQuotes: async () => new Map([['BULL.HK', createQuoteDouble('BULL.HK', 1.01, 100)]]),
    }),
    globalConfig: createGlobalConfig({
      buyOrderTimeout: {
        enabled: true,
        timeoutSeconds: 999,
      },
      sellOrderTimeout: {
        enabled: true,
        timeoutSeconds: params?.sellTimeoutSeconds ?? 0,
      },
      orderMonitorPriceUpdateInterval: 0,
    }),
    monitorConfig: createStrategyRuntimeConfig(),
    dailyLossTracker: createDailyLossTrackerDouble(),
    orderHoldRegistry: createOrderHoldRegistry(),
    protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
    symbolRegistry: createSymbolRegistryDouble(),
    isExecutionAllowed: () => true,
  };

  return { deps, tradeCtx };
}

describe('chaos: api flaky recovery', () => {
  it('retries timeout cancel after backoff and still waits for WS after cancel succeeds', async () => {
    const { deps, tradeCtx } = createOrderMonitorDeps({
      sellTimeoutSeconds: 0,
    });
    tradeCtx.setFailureRule('cancelOrder', {
      failAtCalls: [1],
      maxFailures: 1,
      errorMessage: 'transient cancelOrder failure',
    });

    const monitor = createOrderMonitor(deps);
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.trackOrder({
      orderId: 'SELL-CHAOS-001',
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

    await Bun.sleep(1100);
    await monitor.processWithLatestQuotes();

    expect(tradeCtx.getCalls('cancelOrder')).toHaveLength(2);
    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(0);
  });

  it('keeps merged refresh backlog and completes once account API recovers', async () => {
    const refreshGate = createRefreshGate();
    refreshGate.markStale();
    const lastState = createLastState();
    const refreshedSymbols: string[] = [];
    let accountCallCount = 0;

    const trader = createTraderDouble({
      getAccountSnapshot: async () => {
        accountCallCount += 1;
        if (accountCallCount === 1) {
          throw new Error('account API temporary unavailable');
        }

        return createAccountSnapshotDouble(66_000);
      },
      getStockPositions: async () => [
        createPositionDouble({
          symbol: 'BULL.HK',
          quantity: 300,
          availableQuantity: 300,
        }),
      ],
    });
    const monitorContext = createStrategyRuntimeDouble({
      config: createStrategyRuntimeConfig({
        baseInstrumentSymbol: 'HSI.HK',
      }),
      symbolRegistry: createSymbolRegistryDouble({
        baseInstrumentSymbol: 'HSI.HK',
        longSeat: {
          symbol: 'BULL.HK',
          status: 'ACTIVE',
          lastSwitchAt: null,
          lastSearchAt: null,
          lastSeatActivatedAt: null,
          callPrice: null,
          searchFailCountToday: 0,
          frozenTradingDayKey: null,
        },
      }),
      longSymbolName: 'BULL',
      shortSymbolName: 'BEAR',
      riskChecker: createRiskCheckerDouble({
        refreshUnrealizedLossData: async (symbol) => {
          refreshedSymbols.push(symbol);
          return { r1: 100, n1: 300 };
        },
      }),
    });

    const refresher = createPostTradeRefresher({
      refreshGate,
      trader,
      lastState,
      monitorContext,
      dailyLossTracker: createDailyLossTrackerDouble(),
      liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
      protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
      displayAccountAndPositions: async () => {},
    });

    refresher.enqueue({
      pending: [
        {
          symbol: 'BULL.HK',
          isLongSymbol: true,
          refreshAccount: true,
          refreshPositions: true,
        },
      ],
      quotesMap: new Map([['BULL.HK', createQuoteDouble('BULL.HK', 1.02)]]),
    });

    await Bun.sleep(50);
    refresher.enqueue({
      pending: [
        {
          symbol: 'BULL.HK',
          isLongSymbol: true,
          refreshAccount: true,
          refreshPositions: true,
        },
      ],
      quotesMap: new Map([['BULL.HK', createQuoteDouble('BULL.HK', 1.03)]]),
    });

    await Bun.sleep(1300);

    expect(accountCallCount).toBeGreaterThanOrEqual(2);
    expect(lastState.cachedAccount).not.toBeNull();
    expect(lastState.cachedAccount?.buyPower).toBe(66_000);
    expect(lastState.positionCache.get('BULL.HK')?.quantity).toBe(300);
    expect(refreshedSymbols).toContain('BULL.HK');
  });
});
