/**
 * websocket-out-of-order 混沌测试
 *
 * 验证 BOOTSTRAPPING 阶段乱序 WS 事件不会把恢复后的订单状态拉回旧状态。
 */
import { describe, expect, it } from 'bun:test';
import {
  OrderSide,
  OrderStatus,
  OrderType,
  type PushOrderChanged,
  type TradeContext,
} from 'longbridge';
import { createOrderMonitor } from '../../src/core/trader/orderMonitor/index.js';
import { createOrderHoldRegistry } from '../../src/core/trader/orderHoldRegistry.js';
import type { OrderMonitorDeps } from '../../src/core/trader/types.js';
import {
  createGlobalConfig,
  createStrategyRuntimeConfig,
} from '../../mock/factories/configFactory.js';
import { createPushOrderChanged } from '../../mock/factories/tradeFactory.js';
import { createTradeContextMock } from '../../mock/longbridge/tradeContextMock.js';
import {
  createDailyLossTrackerDouble,
  createMarketDataClientDouble,
  createProtectiveLiquidationEpisodeTrackerDouble,
  createQuoteDouble,
  createSymbolRegistryDouble,
} from '../helpers/testDoubles.js';

describe('chaos: websocket out of order', () => {
  it('keeps latest terminal event during bootstrapping replay', async () => {
    let handleOrderChanged: (event: PushOrderChanged) => void = () => {};
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
        getQuotes: async () => new Map([['BULL.HK', createQuoteDouble('BULL.HK', 1.02)]]),
      }),
      globalConfig: createGlobalConfig(),
      monitorConfig: createStrategyRuntimeConfig({
        orderOwnershipMapping: ['HSI'],
      }),
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

    const monitor = createOrderMonitor(deps);
    await monitor.initialize();

    handleOrderChanged(
      createPushOrderChanged({
        orderId: 'SELL-BOOT-001',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.Filled,
        submittedQuantity: 100,
        executedQuantity: 100,
        executedPrice: 1.04,
        submittedPrice: 1,
        orderType: OrderType.ELO,
        updatedAtMs: Date.parse('2026-02-16T01:31:00.000Z'),
      }),
    );

    handleOrderChanged(
      createPushOrderChanged({
        orderId: 'SELL-BOOT-001',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.PartialFilled,
        submittedQuantity: 100,
        executedQuantity: 30,
        executedPrice: 1.02,
        submittedPrice: 1,
        orderType: OrderType.ELO,
        updatedAtMs: Date.parse('2026-02-16T01:30:00.000Z'),
      }),
    );

    await monitor.recoverOrderTrackingFromSnapshot([
      {
        orderId: 'SELL-BOOT-001',
        symbol: 'BULL.HK',
        stockName: 'HSI RC',
        side: OrderSide.Sell,
        status: OrderStatus.New,
        orderType: OrderType.ELO,
        remark: '',
        price: '1',
        quantity: '100',
        executedPrice: '0',
        executedQuantity: '0',
        submittedAt: new Date('2026-02-16T01:00:00.000Z'),
        updatedAt: new Date('2026-02-16T01:00:00.000Z'),
      },
    ]);

    expect(monitor.hasPendingSellOrders('BULL.HK')).toBeFalse();
    expect(monitor.getRecentFilledOrder('SELL-BOOT-001')).toEqual({
      orderId: 'SELL-BOOT-001',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      executedPrice: 1.04,
      executedQuantity: 100,
      executedTimeMs: Date.parse('2026-02-16T01:31:00.000Z'),
    });
  });
});
