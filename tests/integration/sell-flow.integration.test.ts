/**
 * sell-flow 集成测试
 *
 * 覆盖当前卖出链路：
 * - quantity 仅来自 position.availableQuantity
 * - 卖单合并仅依赖 orderMonitor pending sell 快照
 */
import { describe, expect, it } from 'bun:test';
import { OrderSide, OrderStatus, OrderType, type TradeContext } from 'longbridge';
import { createSignalProcessor } from '../../src/core/signalProcessor/index.js';
import { createOrderExecutor } from '../../src/core/trader/orderExecutor/index.js';
import {
  createGlobalConfig,
  createStrategyRuntimeConfig,
} from '../../mock/factories/configFactory.js';
import { createSignal } from '../../mock/factories/signalFactory.js';
import { createStockPositionsResponse } from '../../mock/factories/tradeFactory.js';
import { createTradeContextMock } from '../../mock/longbridge/tradeContextMock.js';
import {
  createLiquidationCooldownTrackerDouble,
  createOrderMonitorDouble,
  createPositionDouble,
  createQuoteDouble,
  createSymbolRegistryDouble,
} from '../helpers/testDoubles.js';

function createFixture() {
  return {
    globalConfig: createGlobalConfig(),
    monitorConfig: createStrategyRuntimeConfig(),
    signalProcessor: createSignalProcessor({
      globalConfig: createGlobalConfig(),
      liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
    }),
  };
}

describe('sell-flow integration', () => {
  it('resolves full-close quantity from current available position and submits one sell order', async () => {
    const { globalConfig, monitorConfig, signalProcessor } = createFixture();
    const signal = createSignal({
      symbol: 'BULL.HK',
      action: 'SELLCALL',
      triggerTimeMs: Date.now(),
      reason: 'integration-sell',
    });
    const processed = signalProcessor.processSellSignals({
      signals: [signal],
      longPosition: createPositionDouble({
        symbol: 'BULL.HK',
        quantity: 300,
        availableQuantity: 240,
      }),
      shortPosition: null,
      longQuote: createQuoteDouble('BULL.HK', 1.05),
      shortQuote: null,
    });

    expect(processed[0]?.action).toBe('SELLCALL');
    expect(processed[0]?.quantity).toBe(240);
    expect(processed[0]?.price).toBe(1.05);

    const tradeCtx = createTradeContextMock();
    tradeCtx.seedStockPositions(
      createStockPositionsResponse({
        symbol: 'BULL.HK',
        quantity: 240,
        availableQuantity: 240,
      }),
    );
    const trackedOrders: Array<{
      readonly orderId: string;
      readonly quantity: number;
      readonly side: OrderSide;
    }> = [];
    const orderExecutor = createOrderExecutor({
      ctxPromise: Promise.resolve(tradeCtx as unknown as TradeContext),
      rateLimiter: {
        throttle: async () => {},
      },
      cacheManager: {
        clearCache: () => {},
        getPendingOrders: async () => [],
      },
      orderMonitor: createOrderMonitorDouble({
        trackOrder: ({ orderId, quantity, side }) => {
          trackedOrders.push({ orderId, quantity, side });
        },
      }),
      globalConfig,
      monitorConfig,
      symbolRegistry: createSymbolRegistryDouble(),
      isExecutionAllowed: () => true,
    });

    const result = await orderExecutor.executeSignals(processed);

    expect(result.submittedCount).toBe(1);
    expect(trackedOrders).toHaveLength(1);
    expect(trackedOrders[0]?.side).toBe(OrderSide.Sell);
    expect(trackedOrders[0]?.quantity).toBe(240);
    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(1);
    expect(tradeCtx.getCalls('stockPositions')).toHaveLength(0);
  });

  it('merges against current pending sell snapshot without any orderRecorder dependency', async () => {
    const { globalConfig, monitorConfig, signalProcessor } = createFixture();
    const signal = createSignal({
      symbol: 'BULL.HK',
      action: 'SELLCALL',
      triggerTimeMs: Date.now(),
      reason: 'integration-sell-merge',
    });
    const processed = signalProcessor.processSellSignals({
      signals: [signal],
      longPosition: createPositionDouble({
        symbol: 'BULL.HK',
        quantity: 300,
        availableQuantity: 300,
      }),
      shortPosition: null,
      longQuote: createQuoteDouble('BULL.HK', 1.05),
      shortQuote: null,
    });

    const tradeCtx = createTradeContextMock();
    tradeCtx.seedStockPositions(
      createStockPositionsResponse({
        symbol: 'BULL.HK',
        quantity: 300,
        availableQuantity: 300,
      }),
    );
    const replaceCalls: Array<{
      readonly orderId: string;
      readonly newPrice: number;
      readonly quantity: number | null | undefined;
    }> = [];
    const orderExecutor = createOrderExecutor({
      ctxPromise: Promise.resolve(tradeCtx as unknown as TradeContext),
      rateLimiter: {
        throttle: async () => {},
      },
      cacheManager: {
        clearCache: () => {},
        getPendingOrders: async () => [],
      },
      orderMonitor: createOrderMonitorDouble({
        getPendingSellOrders: () => [
          {
            orderId: 'SELL-EXISTING-001',
            symbol: 'BULL.HK',
            side: OrderSide.Sell,
            status: OrderStatus.New,
            orderType: OrderType.ELO,
            submittedPrice: 1.01,
            submittedQuantity: 100,
            executedQuantity: 0,
            submittedAt: Date.parse('2026-02-16T01:00:00.000Z'),
          },
        ],
        replaceOrderPrice: async (orderId, newPrice, quantity) => {
          replaceCalls.push({ orderId, newPrice, quantity });
        },
      }),
      globalConfig,
      monitorConfig,
      symbolRegistry: createSymbolRegistryDouble(),
      isExecutionAllowed: () => true,
    });

    const result = await orderExecutor.executeSignals(processed);

    expect(result.submittedCount).toBe(0);
    expect(replaceCalls).toHaveLength(1);
    expect(replaceCalls[0]?.orderId).toBe('SELL-EXISTING-001');
    expect(replaceCalls[0]?.quantity).toBe(400);
    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(0);
    expect(tradeCtx.getCalls('stockPositions')).toHaveLength(0);
  });
});
