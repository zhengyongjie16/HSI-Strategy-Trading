/**
 * protective-liquidation 集成测试
 *
 * 功能：
 * - 验证保护性清仓端到端场景与业务期望。
 */
import { describe, expect, it } from 'bun:test';
import { OrderSide, OrderStatus, OrderType, TopicType, type TradeContext } from 'longbridge';
import { createOrderMonitor } from '../../src/core/trader/orderMonitor/index.js';
import type { OrderMonitorDeps } from '../../src/core/trader/types.js';
import type { DailyLossCumulativeExecutionInput } from '../../src/types/risk.js';
import { createTradingConfig } from '../../mock/factories/configFactory.js';
import { createPushOrderChanged } from '../../mock/factories/tradeFactory.js';
import { createTradeContextMock } from '../../mock/longbridge/tradeContextMock.js';
import {
  createMarketDataClientDouble,
  createOrderRecorderDouble,
  createProtectiveLiquidationEpisodeTrackerDouble,
  createRateLimiterDouble,
  createSymbolRegistryDouble,
} from '../helpers/testDoubles.js';

describe('protective-liquidation integration', () => {
  it('records protective episode progress + local sell update after protective liquidation fill event', async () => {
    let recordLocalSellCount = 0;
    let markSellFilledCount = 0;
    const terminalExecutionFacts: Array<
      Pick<
        DailyLossCumulativeExecutionInput,
        | 'direction'
        | 'executedPrice'
        | 'executedQuantity'
        | 'factStage'
        | 'orderId'
        | 'side'
        | 'symbol'
      >
    > = [];
    const episodeProgressPayloads: Array<{
      direction: 'LONG' | 'SHORT';
      symbol: string;
      executedTimeMs: number;
    }> = [];
    const refreshNeeds: Array<{
      readonly refreshAccount: boolean;
      readonly refreshPositions: boolean;
    }> = [];

    const tradeCtx = createTradeContextMock();
    const deps: OrderMonitorDeps = {
      now: () => new Date(),
      scheduleTimer: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimer: (handle) => {
        clearTimeout(handle);
      },
      ctx: tradeCtx as unknown as TradeContext,
      rateLimiter: createRateLimiterDouble(),
      cacheManager: {
        clearCache: () => {},
        getPendingOrders: async () => [],
      },
      marketDataClient: createMarketDataClientDouble(),
      orderRecorder: createOrderRecorderDouble({
        recordLocalSell: () => {
          recordLocalSellCount += 1;
        },
        markSellFilled: () => {
          markSellFilledCount += 1;
          return null;
        },
      }),
      dailyLossTracker: {
        resetAll: () => {},
        prepareProtectionBoundary: (params) => ({ ...params, orderBaselines: [] }),
        commitProtectionBoundary: () => {},
        restoreExecutionSnapshot: () => {},
        restoreProtectionBoundary: () => {},
        recalculateFromAllOrders: () => {},
        recordCumulativeExecution: (input) => {
          terminalExecutionFacts.push({
            factStage: input.factStage,
            orderId: input.orderId,
            direction: input.direction,
            symbol: input.symbol,
            side: input.side,
            executedPrice: input.executedPrice,
            executedQuantity: input.executedQuantity,
          });

          return { authoritativeFactChanged: true, executionAdvanced: true };
        },
        getLossOffset: () => 0,
      },
      orderHoldRegistry: {
        trackOrder: () => {},
        markOrderClosed: () => {},
        seedFromOrders: () => {},
        getHoldSymbols: () => new Set<string>(),
        onOrderHoldSymbolsChanged: () => () => {},
        clear: () => {},
      },
      persistProtectiveLiquidationExecutionProgress: () => {},
      protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble({
        recordProtectiveFillProgress: (params) => {
          episodeProgressPayloads.push(params);
        },
      }),
      postTradeConsistencyRuntime: {
        recordSettlementRefreshNeed: (need) => {
          refreshNeeds.push(need);
        },
      },
      tradingConfig: createTradingConfig(),
      symbolRegistry: createSymbolRegistryDouble(),
      isContinuousTradingAllowed: () => true,
      onFatalError: (error) => {
        throw error;
      },
    };

    const monitor = createOrderMonitor(deps);
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);

    monitor.trackOrder({
      orderId: 'PL-001',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      price: 1,
      initialSubmittedPrice: 1,
      quantity: 200,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: true,
      orderType: OrderType.MO,
    });

    expect(tradeCtx.getSubscribedTopics().has(TopicType.Private)).toBe(true);
    tradeCtx.emitOrderChanged(
      createPushOrderChanged({
        orderId: 'PL-001',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.Filled,
        orderType: OrderType.MO,
        submittedQuantity: 200,
        executedQuantity: 200,
        submittedPrice: 1,
        executedPrice: 1,
      }),
    );
    tradeCtx.flushAllEvents();

    expect(recordLocalSellCount).toBe(1);
    expect(markSellFilledCount).toBe(1);
    expect(terminalExecutionFacts).toEqual([
      {
        factStage: 'TERMINAL',
        orderId: 'PL-001',
        direction: 'LONG',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        executedPrice: 1,
        executedQuantity: 200,
      },
    ]);

    expect(episodeProgressPayloads).toEqual([
      {
        direction: 'LONG',
        symbol: 'BULL.HK',
        executedTimeMs: expect.any(Number),
      },
    ]);

    expect(refreshNeeds).toEqual([
      {
        refreshAccount: true,
        refreshPositions: true,
      },
    ]);
  });
});
