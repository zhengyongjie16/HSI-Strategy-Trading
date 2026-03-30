/**
 * full-business-simulation 集成测试
 *
 * 用一个最小闭环覆盖当前主链路：
 * - strategy 基于 positionCache 生成入场信号
 * - orderMonitor 成交后产出 post-trade refresh
 * - postTradeRefresher 刷新持仓缓存后，strategy 不再重复开仓
 */
import { describe, expect, it } from 'bun:test';
import {
  OrderSide,
  OrderStatus,
  OrderType,
  type PushOrderChanged,
  type TradeContext,
} from 'longbridge';
import { createTrendContinuationStrategy } from '../../src/core/strategy/index.js';
import { createOrderMonitor } from '../../src/core/trader/orderMonitor/index.js';
import { createOrderHoldRegistry } from '../../src/core/trader/orderHoldRegistry.js';
import { createPostTradeRefresher } from '../../src/main/asyncProgram/postTradeRefresher/index.js';
import { createRefreshGate } from '../../src/utils/refreshGate/index.js';
import type { OrderMonitorDeps } from '../../src/core/trader/types.js';
import type { LastState } from '../../src/types/state.js';
import {
  createGlobalConfig,
  createStrategyRuntimeConfig,
} from '../../mock/factories/configFactory.js';
import { createPushOrderChanged } from '../../mock/factories/tradeFactory.js';
import { createTradeContextMock } from '../../mock/longbridge/tradeContextMock.js';
import {
  createAccountSnapshotDouble,
  createDailyLossTrackerDouble,
  createFactorSnapshotDouble,
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

describe('full-business-simulation integration', () => {
  it('uses positionCache as the single holding source across strategy, settlement and refresh', async () => {
    const monitorConfig = createStrategyRuntimeConfig();
    const positionCache = createPositionCacheDouble();
    const strategy = createTrendContinuationStrategy(monitorConfig.strategyConfig);

    const initialSignals = strategy.generateSignals(
      createFactorSnapshotDouble(),
      'BULL.HK',
      'BEAR.HK',
      positionCache,
    );
    expect(initialSignals.map((signal) => signal.action)).toEqual(['BUYCALL']);

    let handleOrderChanged: (event: PushOrderChanged) => void = () => {};
    const tradeCtx = createTradeContextMock();
    const orderMonitorDeps: OrderMonitorDeps = {
      ctxPromise: Promise.resolve(tradeCtx as unknown as TradeContext),
      rateLimiter: {
        throttle: async () => {},
      },
      cacheManager: {
        clearCache: () => {},
        getPendingOrders: async () => [],
      },
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () => new Map([['BULL.HK', createQuoteDouble('BULL.HK', 1.02)]]),
      }),
      globalConfig: createGlobalConfig(),
      monitorConfig,
      dailyLossTracker: createDailyLossTrackerDouble(),
      orderHoldRegistry: createOrderHoldRegistry(),
      protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
      symbolRegistry: createSymbolRegistryDouble(),
      isExecutionAllowed: () => true,
      testHooks: {
        setHandleOrderChanged: (handler) => {
          handleOrderChanged = handler;
        },
      },
    };
    const orderMonitor = createOrderMonitor(orderMonitorDeps);
    await orderMonitor.initialize();
    await orderMonitor.recoverOrderTrackingFromSnapshot([]);
    orderMonitor.trackOrder({
      orderId: 'BUY-001',
      symbol: 'BULL.HK',
      side: OrderSide.Buy,
      price: 1.02,
      initialSubmittedPrice: 1.02,
      quantity: 100,
      isLongSymbol: true,
      baseInstrumentSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: OrderType.ELO,
    });

    handleOrderChanged(
      createPushOrderChanged({
        orderId: 'BUY-001',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
        status: OrderStatus.Filled,
        submittedQuantity: 100,
        executedQuantity: 100,
        executedPrice: 1.02,
        submittedPrice: 1.02,
        orderType: OrderType.ELO,
        updatedAtMs: Date.parse('2026-02-16T01:30:00.000Z'),
      }),
    );

    const refreshGate = createRefreshGate();
    refreshGate.markStale();
    const lastState: LastState = {
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
      positionCache,
      cachedTradingDayInfo: null,
      monitorState: {
        baseInstrumentSymbol: 'HSI.HK',
        monitorPrice: null,
        longPrice: null,
        shortPrice: null,
        signal: null,
        pendingSignals: [],
        lastMonitorSnapshot: null,
        lastCandlestickCacheVersion: null,
        lastDisplaySignature: null,
        displayPlan: ['price', 'changePercent'] as const,
      },
      allTradingSymbols: new Set<string>(),
    };
    const monitorContext = createStrategyRuntimeDouble({
      config: monitorConfig,
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
      riskChecker: createRiskCheckerDouble(),
    });
    const trader = createTraderDouble({
      getAccountSnapshot: async () => createAccountSnapshotDouble(90_000),
      getStockPositions: async () => [
        createPositionDouble({
          symbol: 'BULL.HK',
          quantity: 100,
          availableQuantity: 100,
        }),
      ],
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
      pending: orderMonitor.getAndClearPendingRefreshSymbols(),
      quotesMap: new Map([['BULL.HK', createQuoteDouble('BULL.HK', 1.02)]]),
    });

    await Bun.sleep(60);
    await refresher.stopAndDrain();

    expect(positionCache.get('BULL.HK')?.quantity).toBe(100);

    const postFillSignals = strategy.generateSignals(
      createFactorSnapshotDouble(),
      'BULL.HK',
      'BEAR.HK',
      positionCache,
    );
    expect(postFillSignals.some((signal) => signal.action === 'BUYCALL')).toBeFalse();
  });
});
