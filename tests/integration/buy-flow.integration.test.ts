/**
 * buy-flow 集成测试
 *
 * 覆盖当前买入链路：
 * - 风险检查不再依赖 latest buy price / orderRecorder
 * - 风险通过后仍可提交买单并进入订单追踪
 */
import { describe, expect, it } from 'bun:test';
import { OrderSide, type TradeContext } from 'longbridge';
import { createSignalProcessor } from '../../src/core/signalProcessor/index.js';
import { createOrderExecutor } from '../../src/core/trader/orderExecutor/index.js';
import { isRuntimeExecutionAllowed } from '../../src/app/runtime/executionGate.js';
import type { RiskCheckContext } from '../../src/types/services.js';
import {
  createGlobalConfig,
  createStrategyRuntimeConfig,
} from '../../mock/factories/configFactory.js';
import { createSignal } from '../../mock/factories/signalFactory.js';
import { createTradeContextMock } from '../../mock/longbridge/tradeContextMock.js';
import {
  createAccountSnapshotDouble,
  createDoomsdayProtectionDouble,
  createLiquidationCooldownTrackerDouble,
  createOrderMonitorDouble,
  createPositionCacheDouble,
  createQuoteDouble,
  createRiskCheckerDouble,
  createSymbolRegistryDouble,
  createTraderDouble,
} from '../helpers/testDoubles.js';

function createRiskContext(params?: {
  readonly trader?: ReturnType<typeof createTraderDouble>;
  readonly riskChecker?: ReturnType<typeof createRiskCheckerDouble>;
}): RiskCheckContext {
  return {
    trader:
      params?.trader ??
      createTraderDouble({
        getAccountSnapshot: async () => createAccountSnapshotDouble(100_000),
        getStockPositions: async () => [],
      }),
    riskChecker: params?.riskChecker ?? createRiskCheckerDouble(),
    longQuote: createQuoteDouble('BULL.HK', 1.02, 100),
    shortQuote: createQuoteDouble('BEAR.HK', 1.01, 100),
    monitorQuote: createQuoteDouble('HSI.HK', 20_000, 1),
    monitorSnapshot: null,
    longSymbol: 'BULL.HK',
    shortSymbol: 'BEAR.HK',
    longSymbolName: 'BULL',
    shortSymbolName: 'BEAR',
    account: createAccountSnapshotDouble(100_000),
    positions: [],
    lastState: {
      cachedAccount: createAccountSnapshotDouble(100_000),
      cachedPositions: [],
      positionCache: createPositionCacheDouble(),
    },
    currentTime: new Date('2026-02-16T02:00:00.000Z'),
    isHalfDay: false,
    doomsdayProtection: createDoomsdayProtectionDouble(),
    config: createStrategyRuntimeConfig(),
  };
}

describe('buy-flow integration', () => {
  it('passes buy risk checks without any latest-buy-price dependency and submits order', async () => {
    const globalConfig = createGlobalConfig();
    const monitorConfig = createStrategyRuntimeConfig();
    const signalProcessor = createSignalProcessor({
      globalConfig,
      liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
    });
    const signal = createSignal({
      symbol: 'BULL.HK',
      action: 'BUYCALL',
      triggerTimeMs: Date.now(),
      reason: 'integration-buy',
    });

    const checkedSignals = await signalProcessor.applyRiskChecks([signal], createRiskContext());

    expect(checkedSignals).toHaveLength(1);
    expect(checkedSignals[0]?.action).toBe('BUYCALL');
    if (checkedSignals[0]) {
      checkedSignals[0].price = 1.02;
      checkedSignals[0].lotSize = 100;
    }

    const tradeCtx = createTradeContextMock();
    const trackedOrders: Array<{ readonly orderId: string; readonly side: OrderSide }> = [];
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
        trackOrder: ({ orderId, side }) => {
          trackedOrders.push({ orderId, side });
        },
      }),
      globalConfig,
      monitorConfig,
      symbolRegistry: createSymbolRegistryDouble(),
      isExecutionAllowed: () => true,
    });

    const result = await orderExecutor.executeSignals(checkedSignals);

    expect(result.submittedCount).toBe(1);
    expect(trackedOrders).toHaveLength(1);
    expect(trackedOrders[0]?.side).toBe(OrderSide.Buy);
    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(1);
  });

  it('still blocks buy when base risk check rejects, without consulting orderRecorder history', async () => {
    const signalProcessor = createSignalProcessor({
      globalConfig: createGlobalConfig(),
      liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
    });
    const signal = createSignal({
      symbol: 'BULL.HK',
      action: 'BUYCALL',
      triggerTimeMs: Date.now(),
      reason: 'integration-buy-risk-block',
    });
    const blockedSignals = await signalProcessor.applyRiskChecks(
      [signal],
      createRiskContext({
        riskChecker: createRiskCheckerDouble({
          checkBeforeOrder: () => ({
            allowed: false,
            reason: 'position-limit',
          }),
        }),
      }),
    );

    expect(blockedSignals).toHaveLength(0);
  });

  it('does not submit buy orders when lifecycle gate is open but continuous-session execution gate is closed', async () => {
    const globalConfig = createGlobalConfig();
    const monitorConfig = createStrategyRuntimeConfig();
    const signal = createSignal({
      symbol: 'BULL.HK',
      action: 'BUYCALL',
      triggerTimeMs: Date.now(),
      reason: 'integration-buy-execution-gate',
      price: 1.02,
      lotSize: 100,
    });
    const tradeCtx = createTradeContextMock();
    const orderExecutor = createOrderExecutor({
      ctxPromise: Promise.resolve(tradeCtx as unknown as TradeContext),
      rateLimiter: {
        throttle: async () => {},
      },
      cacheManager: {
        clearCache: () => {},
        getPendingOrders: async () => [],
      },
      orderMonitor: createOrderMonitorDouble(),
      globalConfig,
      monitorConfig,
      symbolRegistry: createSymbolRegistryDouble(),
      isExecutionAllowed: () =>
        isRuntimeExecutionAllowed({
          isTradingEnabled: true,
          canTrade: false,
        }),
    });

    const result = await orderExecutor.executeSignals([signal]);

    expect(result.submittedCount).toBe(0);
    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(0);
  });
});
