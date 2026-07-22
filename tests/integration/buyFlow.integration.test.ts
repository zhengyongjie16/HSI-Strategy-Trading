/**
 * buy-flow 集成测试
 *
 * 功能：
 * - 验证买入流程风险管道与下单执行的端到端场景与业务期望。
 */
import { describe, expect, it, setSystemTime } from 'bun:test';
import { OrderSide, OrderType, TimeInForceType } from 'longbridge';
import { createSignalProcessor } from '../../src/core/signalProcessor/index.js';
import { createOrderExecutor as createOrderExecutorCore } from '../../src/core/trader/orderExecutor/index.js';
import { VERIFICATION } from '../../src/constants/index.js';
import { createTradingConfig } from '../../mock/factories/configFactory.js';
import { createSignal } from '../../mock/factories/signalFactory.js';
import { createTradeContextMock } from '../../mock/longbridge/tradeContextMock.js';
import {
  createAccountSnapshotDouble,
  createDoomsdayProtectionDouble,
  createMarketDataClientDouble,
  createOrderMonitorDouble,
  createOrderRecorderDouble,
  createQuoteDouble,
  createRateLimiterDouble,
  createRiskCheckerDouble,
  createSymbolRegistryDouble,
  createTradeContextDouble,
  createTraderDouble,
} from '../helpers/testDoubles.js';
import type { ExecutableSignal } from '../../src/types/signal.js';
import type { BuyRiskCheckContext } from '../../src/types/services.js';
import type { OrderExecutorDeps, OrderMonitor } from '../../src/core/trader/types.js';

type OrderMonitorTestOverrides = Omit<Partial<OrderMonitor>, 'replaceOrderPriceWithPermit'>;

type OrderExecutorTestDeps = Omit<
  OrderExecutorDeps,
  'isContinuousTradingAllowed' | 'orderMonitor' | 'unrealizedLossBuyGate'
> & {
  readonly orderMonitor: OrderMonitorTestOverrides;
} & Partial<Pick<OrderExecutorDeps, 'isContinuousTradingAllowed' | 'unrealizedLossBuyGate'>>;

function createOrderExecutor(deps: OrderExecutorTestDeps) {
  const {
    isContinuousTradingAllowed = () => true,
    unrealizedLossBuyGate = createRiskCheckerDouble(),
    orderMonitor,
    ...remainingDeps
  } = deps;

  return createOrderExecutorCore({
    ...remainingDeps,
    isContinuousTradingAllowed,
    unrealizedLossBuyGate,
    orderMonitor: createOrderMonitorDouble(orderMonitor),
  });
}

function createMutationRateLimiter() {
  return createRateLimiterDouble();
}

/** 创建可供最终提交阶段读取的显式行情客户端。 */
function createExecutableQuoteClient() {
  return createMarketDataClientDouble({
    getQuotes: async (symbols) =>
      new Map([...symbols].map((symbol) => [symbol, createQuoteDouble(symbol, 5, 100)])),
  });
}

function withMockedNow<T>(
  nowMs: number,
  run: () => Promise<T>,
  useSystemTime: boolean = false,
): Promise<T> {
  if (useSystemTime) {
    setSystemTime(nowMs);
    return run().finally(() => {
      setSystemTime();
    });
  }

  const originalNow = Date.now;
  Date.now = () => nowMs;
  return run().finally(() => {
    Date.now = originalNow;
  });
}

function createRiskContext(params: {
  readonly trader: ReturnType<typeof createTraderDouble>;
  readonly riskChecker: ReturnType<typeof createRiskCheckerDouble>;
  readonly orderRecorder: ReturnType<typeof createOrderRecorderDouble>;
}): BuyRiskCheckContext {
  const monitorConfig = createTradingConfig().monitor;

  return {
    trader: params.trader,
    riskChecker: params.riskChecker,
    orderRecorder: params.orderRecorder,
    longQuote: createQuoteDouble('BULL.HK', 5, 100),
    shortQuote: createQuoteDouble('BEAR.HK', 5, 100),
    monitorQuote: createQuoteDouble('HSI.HK', 20000),
    monitorSnapshot: {
      price: 20000,
      changePercent: 0,
      ema: null,
      rsi: null,
      psy: null,
      mfi: null,
      kdj: { k: 50, d: 50, j: 50 },
      macd: { macd: 0, dif: 0, dea: 0 },
      adx: null,
    },
    longSymbol: 'BULL.HK',
    shortSymbol: 'BEAR.HK',
    longSymbolName: 'BULL.HK',
    shortSymbolName: 'BEAR.HK',
    currentTime: new Date(),
    isHalfDay: false,
    doomsdayProtection: createDoomsdayProtectionDouble(),
    config: monitorConfig,
  };
}

describe('buy-flow integration', () => {
  it.each([
    {
      label: '正常交易日',
      beforeCutoff: '2026-07-12T07:44:59.000Z',
      afterCutoff: '2026-07-12T07:45:01.000Z',
      isHalfDay: false,
    },
    {
      label: '半日交易日',
      beforeCutoff: '2026-07-12T03:44:59.000Z',
      afterCutoff: '2026-07-12T03:45:01.000Z',
      isHalfDay: true,
    },
  ])('$label 买入在 throttle 跨过末日截止后不得进入 broker API', async (scenario) => {
    const tradingConfig = createTradingConfig();
    const tradeCtx = createTradeContextMock();
    let currentTime = new Date(scenario.beforeCutoff);
    const orderExecutor = createOrderExecutor({
      ctx: createTradeContextDouble(tradeCtx),
      rateLimiter: createRateLimiterDouble({
        onThrottle: async () => {
          currentTime = new Date(scenario.afterCutoff);
        },
      }),
      marketDataClient: createExecutableQuoteClient(),
      cacheManager: {
        clearCache: () => {},
        getPendingOrders: async () => [],
      },
      orderMonitor: {
        initialize: async () => {},
        trackOrder: () => {},
        cancelOrder: async () => ({
          kind: 'CANCEL_CONFIRMED',
          relatedBuyOrderIds: null,
        }),
        startRuntime: () => {},
        stopRuntimeAndDrain: async () => {},
        recoverOrderTrackingFromSnapshot: async () => {},
        getPendingSellOrders: () => [],
        clearTrackedOrders: () => {},
        onOrderStateChanged: () => () => {},
        hasPendingProtectiveLiquidationOrders: () => false,
      },
      orderRecorder: createOrderRecorderDouble(),
      tradingConfig,
      symbolRegistry: createSymbolRegistryDouble(),
      isExecutionAllowed: () => true,
      now: () => currentTime,
      readCurrentTradingDayInfo: () => ({
        dateKey: scenario.afterCutoff.slice(0, 10),
        info: { isTradingDay: true, isHalfDay: scenario.isHalfDay },
      }),
    });

    const result = await orderExecutor.executeSignals([
      createSignal({
        symbol: 'BULL.HK',
        action: 'BUYCALL',
        triggerTimeMs: currentTime.getTime(),
        reason: 'cross-doomsday-buy-cutoff-during-throttle',
      }),
    ]);

    expect(result).toEqual({ executedOrderIds: [] });
    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(0);
    expect(orderExecutor.canTradeNow('BUYCALL')).toEqual({ canTrade: true });
  });

  it.each([
    {
      label: '正常交易日 exact close',
      finalTime: '2026-07-12T08:00:00.000Z',
      isHalfDay: false,
    },
    {
      label: '正常交易日 after close',
      finalTime: '2026-07-12T10:00:00.000Z',
      isHalfDay: false,
    },
    {
      label: '半日交易日 exact close',
      finalTime: '2026-07-12T04:00:00.000Z',
      isHalfDay: true,
    },
    {
      label: '半日交易日 after close',
      finalTime: '2026-07-12T06:00:00.000Z',
      isHalfDay: true,
    },
  ])('$label 达到截止起点后当日持续拒绝买入', async (scenario) => {
    const tradingConfig = createTradingConfig();
    const tradeCtx = createTradeContextMock();
    let currentTime = new Date('2026-07-12T03:30:00.000Z');
    const orderExecutor = createOrderExecutor({
      ctx: createTradeContextDouble(tradeCtx),
      rateLimiter: createRateLimiterDouble({
        onThrottle: async () => {
          currentTime = new Date(scenario.finalTime);
        },
      }),
      marketDataClient: createExecutableQuoteClient(),
      cacheManager: { clearCache: () => {}, getPendingOrders: async () => [] },
      orderMonitor: {
        initialize: async () => {},
        trackOrder: () => {},
        cancelOrder: async () => ({
          kind: 'CANCEL_CONFIRMED',
          relatedBuyOrderIds: null,
        }),
        startRuntime: () => {},
        stopRuntimeAndDrain: async () => {},
        recoverOrderTrackingFromSnapshot: async () => {},
        getPendingSellOrders: () => [],
        clearTrackedOrders: () => {},
        onOrderStateChanged: () => () => {},
        hasPendingProtectiveLiquidationOrders: () => false,
      },
      orderRecorder: createOrderRecorderDouble(),
      tradingConfig,
      symbolRegistry: createSymbolRegistryDouble(),
      isExecutionAllowed: () => true,
      now: () => currentTime,
      readCurrentTradingDayInfo: () => ({
        dateKey: '2026-07-12',
        info: { isTradingDay: true, isHalfDay: scenario.isHalfDay },
      }),
    });

    const result = await orderExecutor.executeSignals([
      createSignal({
        symbol: 'BULL.HK',
        action: 'BUYCALL',
        triggerTimeMs: currentTime.getTime(),
        reason: 'same-day-after-doomsday-cutoff',
      }),
    ]);

    expect(result).toEqual({ executedOrderIds: [] });
    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(0);
    expect(orderExecutor.canTradeNow('BUYCALL')).toEqual({ canTrade: true });
  });

  it.each([
    {
      label: '交易日历缺失',
      readCurrentTradingDayInfo: () => null,
    },
    {
      label: '交易日历日期不匹配',
      readCurrentTradingDayInfo: () => ({
        dateKey: '2026-07-11',
        info: { isTradingDay: true, isHalfDay: false },
      }),
    },
    {
      label: '当日不是交易日',
      readCurrentTradingDayInfo: () => ({
        dateKey: '2026-07-12',
        info: { isTradingDay: false, isHalfDay: false },
      }),
    },
  ])('$label 时末日保护买入最终授权 fail-closed', async (scenario) => {
    const tradingConfig = createTradingConfig();
    const tradeCtx = createTradeContextMock();
    const currentTime = new Date('2026-07-12T06:30:00.000Z');
    const orderExecutor = createOrderExecutor({
      ctx: createTradeContextDouble(tradeCtx),
      rateLimiter: createMutationRateLimiter(),
      marketDataClient: createExecutableQuoteClient(),
      cacheManager: { clearCache: () => {}, getPendingOrders: async () => [] },
      orderMonitor: {
        initialize: async () => {},
        trackOrder: () => {},
        cancelOrder: async () => ({
          kind: 'CANCEL_CONFIRMED',
          relatedBuyOrderIds: null,
        }),
        startRuntime: () => {},
        stopRuntimeAndDrain: async () => {},
        recoverOrderTrackingFromSnapshot: async () => {},
        getPendingSellOrders: () => [],
        clearTrackedOrders: () => {},
        onOrderStateChanged: () => () => {},
        hasPendingProtectiveLiquidationOrders: () => false,
      },
      orderRecorder: createOrderRecorderDouble(),
      tradingConfig,
      symbolRegistry: createSymbolRegistryDouble(),
      isExecutionAllowed: () => true,
      now: () => currentTime,
      readCurrentTradingDayInfo: scenario.readCurrentTradingDayInfo,
    });

    const result = await orderExecutor.executeSignals([
      createSignal({
        symbol: 'BEAR.HK',
        action: 'BUYPUT',
        triggerTimeMs: currentTime.getTime(),
        reason: 'missing-authoritative-trading-day-info',
      }),
    ]);

    expect(result.executedOrderIds.length).toBe(0);
    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(0);
    expect(orderExecutor.canTradeNow('BUYPUT')).toEqual({ canTrade: true });
  });

  it('末日保护关闭时普通买入仍在有效连续交易时段提交', async () => {
    const baseConfig = createTradingConfig();
    const tradingConfig = createTradingConfig({
      global: { ...baseConfig.global, doomsdayProtection: false },
    });
    const tradeCtx = createTradeContextMock();
    const currentTimeMs = Date.parse('2026-07-12T02:00:00.000Z');
    const orderExecutor = createOrderExecutor({
      ctx: createTradeContextDouble(tradeCtx),
      rateLimiter: createMutationRateLimiter(),
      marketDataClient: createExecutableQuoteClient(),
      cacheManager: { clearCache: () => {}, getPendingOrders: async () => [] },
      orderMonitor: {
        initialize: async () => {},
        trackOrder: () => {},
        cancelOrder: async () => ({
          kind: 'CANCEL_CONFIRMED',
          relatedBuyOrderIds: null,
        }),
        startRuntime: () => {},
        stopRuntimeAndDrain: async () => {},
        recoverOrderTrackingFromSnapshot: async () => {},
        getPendingSellOrders: () => [],
        clearTrackedOrders: () => {},
        onOrderStateChanged: () => () => {},
        hasPendingProtectiveLiquidationOrders: () => false,
      },
      orderRecorder: createOrderRecorderDouble(),
      tradingConfig,
      symbolRegistry: createSymbolRegistryDouble(),
      isExecutionAllowed: () => true,
      now: () => new Date(currentTimeMs),
      readCurrentTradingDayInfo: () => ({
        dateKey: '2026-07-12',
        info: { isTradingDay: true, isHalfDay: false },
      }),
    });

    const result = await withMockedNow(
      currentTimeMs,
      async () =>
        orderExecutor.executeSignals([
          createSignal({
            symbol: 'BULL.HK',
            action: 'BUYCALL',
            triggerTimeMs: Date.now(),
            reason: 'doomsday-protection-disabled',
          }),
        ]),
      true,
    );

    expect(result.executedOrderIds.length).toBe(1);
    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(1);
  });

  it('rejects broker success responses that do not contain a real orderId', async () => {
    const tradingConfig = createTradingConfig();
    const currentTime = new Date('2026-07-10T07:00:00.000Z');
    const trackedOrders: Array<{ orderId: string; quantity: number; side: OrderSide }> = [];
    let submitOrderCallCount = 0;
    const tradeCtx = createTradeContextMock();
    tradeCtx.submitOrder = async () => {
      submitOrderCallCount += 1;
      return {
        orderId: '',
        toString: () => '',
        toJSON: () => ({}),
      };
    };
    const orderExecutor = createOrderExecutor({
      ctx: createTradeContextDouble(tradeCtx),
      rateLimiter: createMutationRateLimiter(),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () => new Map([['BULL.HK', createQuoteDouble('BULL.HK', 5, 100)]]),
      }),
      cacheManager: {
        clearCache: () => {},
        getPendingOrders: async () => [],
      },
      orderMonitor: {
        initialize: async () => {},
        trackOrder: ({ orderId, quantity, side }) => {
          trackedOrders.push({ orderId, quantity, side });
        },
        cancelOrder: async () => ({
          kind: 'CANCEL_CONFIRMED',
          relatedBuyOrderIds: null,
        }),
        startRuntime: () => {},
        stopRuntimeAndDrain: async () => {},
        recoverOrderTrackingFromSnapshot: async () => {},
        getPendingSellOrders: () => [],
        clearTrackedOrders: () => {},
        onOrderStateChanged: () => () => {},
        hasPendingProtectiveLiquidationOrders: () => false,
      },
      orderRecorder: createOrderRecorderDouble(),
      tradingConfig,
      symbolRegistry: createSymbolRegistryDouble(),
      isExecutionAllowed: () => true,
      isContinuousTradingAllowed: () => true,
      now: () => currentTime,
      readCurrentTradingDayInfo: () => ({
        dateKey: '2026-07-10',
        info: { isTradingDay: true, isHalfDay: false },
      }),
    });

    await withMockedNow(
      currentTime.getTime(),
      async () => {
        const signal = createSignal({
          symbol: 'BULL.HK',
          action: 'BUYCALL',
          triggerTimeMs: Date.now(),
          reason: 'missing-order-id-should-fail',
        });

        let missingOrderIdError: unknown = null;
        try {
          await orderExecutor.executeSignals([signal]);
        } catch (error) {
          missingOrderIdError = error;
        }

        expect(missingOrderIdError).toBeInstanceOf(Error);
        expect(submitOrderCallCount).toBe(1);
        expect(trackedOrders).toHaveLength(0);
      },
      true,
    );
  });

  it('surfaces local tracking failures after broker submit succeeds', async () => {
    const tradingConfig = createTradingConfig();
    const tradeCtx = createTradeContextMock();
    const currentTime = new Date('2026-07-10T07:00:00.000Z');
    const localTrackingFailure = new Error('track failed after submit');
    const orderExecutor = createOrderExecutor({
      ctx: createTradeContextDouble(tradeCtx),
      rateLimiter: createMutationRateLimiter(),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () => new Map([['BULL.HK', createQuoteDouble('BULL.HK', 5, 100)]]),
      }),
      cacheManager: {
        clearCache: () => {},
        getPendingOrders: async () => [],
      },
      orderMonitor: {
        initialize: async () => {},
        trackOrder: () => {
          throw localTrackingFailure;
        },
        cancelOrder: async () => ({
          kind: 'CANCEL_CONFIRMED',
          relatedBuyOrderIds: null,
        }),
        startRuntime: () => {},
        stopRuntimeAndDrain: async () => {},
        recoverOrderTrackingFromSnapshot: async () => {},
        getPendingSellOrders: () => [],
        clearTrackedOrders: () => {},
        onOrderStateChanged: () => () => {},
        hasPendingProtectiveLiquidationOrders: () => false,
      },
      orderRecorder: createOrderRecorderDouble(),
      tradingConfig,
      symbolRegistry: createSymbolRegistryDouble(),
      isExecutionAllowed: () => true,
      isContinuousTradingAllowed: () => true,
      now: () => currentTime,
      readCurrentTradingDayInfo: () => ({
        dateKey: '2026-07-10',
        info: { isTradingDay: true, isHalfDay: false },
      }),
    });

    await withMockedNow(
      currentTime.getTime(),
      async () => {
        const signal = createSignal({
          symbol: 'BULL.HK',
          action: 'BUYCALL',
          triggerTimeMs: Date.now(),
          reason: 'track-order-failure-should-surface',
        });

        let localSyncError: unknown = null;
        try {
          await orderExecutor.executeSignals([signal]);
        } catch (error) {
          localSyncError = error;
        }

        expect(localSyncError).toBeInstanceOf(Error);
        expect(localSyncError).toMatchObject({
          name: 'AcceptedOrderLocalSyncError',
          orderId: 'MOCK-000001',
        });

        if (!(localSyncError instanceof Error)) {
          throw new Error('expected local sync failure to be an Error');
        }

        expect(localSyncError.cause).toBe(localTrackingFailure);
        expect(tradeCtx.getCalls('submitOrder')).toHaveLength(1);
      },
      true,
    );
  });

  it('skips stale seatVersion at final order execution gate', async () => {
    const tradingConfig = createTradingConfig();
    const tradeCtx = createTradeContextMock();
    const currentTime = new Date('2026-07-10T02:00:00.000Z');
    let trackedOrderCount = 0;
    const orderExecutor = createOrderExecutor({
      ctx: createTradeContextDouble(tradeCtx),
      rateLimiter: createMutationRateLimiter(),
      marketDataClient: createExecutableQuoteClient(),
      cacheManager: {
        clearCache: () => {},
        getPendingOrders: async () => [],
      },
      orderMonitor: {
        initialize: async () => {},
        trackOrder: () => {
          trackedOrderCount += 1;
        },
        cancelOrder: async () => ({
          kind: 'CANCEL_CONFIRMED',
          relatedBuyOrderIds: null,
        }),
        startRuntime: () => {},
        stopRuntimeAndDrain: async () => {},
        recoverOrderTrackingFromSnapshot: async () => {},
        getPendingSellOrders: () => [],
        clearTrackedOrders: () => {},
        onOrderStateChanged: () => () => {},
        hasPendingProtectiveLiquidationOrders: () => false,
      },
      orderRecorder: createOrderRecorderDouble(),
      tradingConfig,
      symbolRegistry: createSymbolRegistryDouble({ longVersion: 2 }),
      isExecutionAllowed: () => true,
      now: () => currentTime,
      readCurrentTradingDayInfo: () => ({
        dateKey: '2026-07-10',
        info: { isTradingDay: true, isHalfDay: false },
      }),
    });

    const staleSignal = {
      ...createSignal({
        symbol: 'BULL.HK',
        action: 'BUYCALL',
        triggerTimeMs: currentTime.getTime(),
        reason: 'stale-seat-version',
      }),
      seatVersion: 1,
    };

    const result = await withMockedNow(
      currentTime.getTime(),
      () => orderExecutor.executeSignals([staleSignal]),
      true,
    );

    expect(result).toEqual({ executedOrderIds: [] });
    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(0);
    expect(trackedOrderCount).toBe(0);
  });

  it('skips submit when the same symbol seatVersion advances after mutation permit acquisition', async () => {
    const tradingConfig = createTradingConfig();
    const tradeCtx = createTradeContextMock();
    const currentTime = new Date('2026-07-10T02:00:00.000Z');
    const symbolRegistry = createSymbolRegistryDouble();
    const staticSeat = symbolRegistry.getSeatState('LONG');
    symbolRegistry.updateSeatState('LONG', {
      ...staticSeat,
      lastSeatActivatedAt: currentTime.getTime(),
    });
    const initialSeatVersion = symbolRegistry.getSeatVersion('LONG');
    let mutationPermitAcquisitions = 0;
    const orderExecutor = createOrderExecutor({
      ctx: createTradeContextDouble(tradeCtx),
      rateLimiter: createRateLimiterDouble({
        onMutationPermitAcquired: async () => {
          mutationPermitAcquisitions += 1;
          const currentSeat = symbolRegistry.getSeatState('LONG');
          if (currentSeat.status !== 'ACTIVE' || currentSeat.lastSeatActivatedAt === null) {
            throw new Error('expected runtime ACTIVE LONG seat');
          }

          symbolRegistry.updateSeatStateWithVersionBump('LONG', currentSeat);
        },
      }),
      marketDataClient: createExecutableQuoteClient(),
      cacheManager: {
        clearCache: () => {},
        getPendingOrders: async () => [],
      },
      orderMonitor: {
        initialize: async () => {},
        trackOrder: () => {},
        cancelOrder: async () => ({
          kind: 'CANCEL_CONFIRMED',
          relatedBuyOrderIds: null,
        }),
        startRuntime: () => {},
        stopRuntimeAndDrain: async () => {},
        recoverOrderTrackingFromSnapshot: async () => {},
        getPendingSellOrders: () => [],
        clearTrackedOrders: () => {},
        onOrderStateChanged: () => () => {},
        hasPendingProtectiveLiquidationOrders: () => false,
      },
      orderRecorder: createOrderRecorderDouble(),
      tradingConfig,
      symbolRegistry,
      isExecutionAllowed: () => true,
      now: () => currentTime,
      readCurrentTradingDayInfo: () => ({
        dateKey: '2026-07-10',
        info: { isTradingDay: true, isHalfDay: false },
      }),
    });
    const signal = createSignal({
      symbol: 'BULL.HK',
      action: 'BUYCALL',
      triggerTimeMs: currentTime.getTime(),
      reason: 'seat-version-advanced-during-throttle',
    });

    const result = await withMockedNow(
      currentTime.getTime(),
      () => orderExecutor.executeSignals([signal]),
      true,
    );

    expect(mutationPermitAcquisitions).toBe(1);
    expect(symbolRegistry.getSeatVersion('LONG')).toBe(initialSeatVersion + 1);
    expect(result).toEqual({ executedOrderIds: [] });
    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(0);
  });

  it('fails fast when executable signal action does not match the resolved seat direction', async () => {
    const tradingConfig = createTradingConfig();
    const tradeCtx = createTradeContextMock();
    const currentTime = new Date('2026-07-10T02:00:00.000Z');
    let trackedOrderCount = 0;
    const orderExecutor = createOrderExecutor({
      ctx: createTradeContextDouble(tradeCtx),
      rateLimiter: createMutationRateLimiter(),
      marketDataClient: createExecutableQuoteClient(),
      cacheManager: {
        clearCache: () => {},
        getPendingOrders: async () => [],
      },
      orderMonitor: {
        initialize: async () => {},
        trackOrder: () => {
          trackedOrderCount += 1;
        },
        cancelOrder: async () => ({
          kind: 'CANCEL_CONFIRMED',
          relatedBuyOrderIds: null,
        }),
        startRuntime: () => {},
        stopRuntimeAndDrain: async () => {},
        recoverOrderTrackingFromSnapshot: async () => {},
        getPendingSellOrders: () => [],
        clearTrackedOrders: () => {},
        onOrderStateChanged: () => () => {},
        hasPendingProtectiveLiquidationOrders: () => false,
      },
      orderRecorder: createOrderRecorderDouble(),
      tradingConfig,
      symbolRegistry: createSymbolRegistryDouble(),
      isExecutionAllowed: () => true,
      now: () => currentTime,
      readCurrentTradingDayInfo: () => ({
        dateKey: '2026-07-10',
        info: { isTradingDay: true, isHalfDay: false },
      }),
    });
    const mismatchedSignal: ExecutableSignal = createSignal({
      symbol: 'BULL.HK',
      action: 'BUYPUT',
      triggerTimeMs: currentTime.getTime(),
      reason: 'mismatched-seat-direction',
    });

    let directionMismatchError: unknown = null;
    try {
      await withMockedNow(
        currentTime.getTime(),
        () => orderExecutor.executeSignals([mismatchedSignal]),
        true,
      );
    } catch (error) {
      directionMismatchError = error;
    }

    expect(directionMismatchError).toBeInstanceOf(Error);
    if (!(directionMismatchError instanceof Error)) {
      throw new Error('expected seat direction mismatch error');
    }

    expect(directionMismatchError.message).toContain('信号动作与席位方向不一致');
    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(0);
    expect(trackedOrderCount).toBe(0);
  });

  it('rejects missing seatVersion at final order execution gate', async () => {
    const tradingConfig = createTradingConfig();
    const tradeCtx = createTradeContextMock();
    const currentTime = new Date('2026-07-10T02:00:00.000Z');
    let trackedOrderCount = 0;
    const orderExecutor = createOrderExecutor({
      ctx: createTradeContextDouble(tradeCtx),
      rateLimiter: createMutationRateLimiter(),
      marketDataClient: createExecutableQuoteClient(),
      cacheManager: {
        clearCache: () => {},
        getPendingOrders: async () => [],
      },
      orderMonitor: {
        initialize: async () => {},
        trackOrder: () => {
          trackedOrderCount += 1;
        },
        cancelOrder: async () => ({
          kind: 'CANCEL_CONFIRMED',
          relatedBuyOrderIds: null,
        }),
        startRuntime: () => {},
        stopRuntimeAndDrain: async () => {},
        recoverOrderTrackingFromSnapshot: async () => {},
        getPendingSellOrders: () => [],
        clearTrackedOrders: () => {},
        onOrderStateChanged: () => () => {},
        hasPendingProtectiveLiquidationOrders: () => false,
      },
      orderRecorder: createOrderRecorderDouble(),
      tradingConfig,
      symbolRegistry: createSymbolRegistryDouble({ longVersion: 1 }),
      isExecutionAllowed: () => true,
      now: () => currentTime,
      readCurrentTradingDayInfo: () => ({
        dateKey: '2026-07-10',
        info: { isTradingDay: true, isHalfDay: false },
      }),
    });
    const { seatVersion: omittedSeatVersion, ...missingSeatVersionSignal } = createSignal({
      symbol: 'BULL.HK',
      action: 'BUYCALL',
      triggerTimeMs: currentTime.getTime(),
      reason: 'missing-seat-version',
    });
    void omittedSeatVersion;

    const invalidSignals = [missingSeatVersionSignal] as unknown as ReadonlyArray<ExecutableSignal>;
    const result = await withMockedNow(
      currentTime.getTime(),
      () => orderExecutor.executeSignals(invalidSignals),
      true,
    );

    expect(result).toEqual({ executedOrderIds: [] });
    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(0);
    expect(trackedOrderCount).toBe(0);
  });

  it('runs risk pipeline -> order execution and submits notional-based buy quantity', async () => {
    const tradingConfig = createTradingConfig();
    const currentTime = new Date('2026-07-10T07:00:00.000Z');
    const signalProcessor = createSignalProcessor({
      tradingConfig,
      liquidationCooldownTracker: {
        recordLiquidationTrigger: () => {},
        recordCooldown: () => {},
        restoreTriggerCount: () => {},
        getRemainingMs: () => 0,
        clearMidnightEligible: () => {},
        resetAllTriggerCounts: () => {},
      },
    });

    const tradeCtx = createTradeContextMock();
    const trackedOrders: Array<{ orderId: string; quantity: number; side: OrderSide }> = [];
    const orderExecutor = createOrderExecutor({
      ctx: createTradeContextDouble(tradeCtx),
      rateLimiter: createMutationRateLimiter(),
      marketDataClient: createExecutableQuoteClient(),
      cacheManager: {
        clearCache: () => {},
        getPendingOrders: async () => [],
      },
      orderMonitor: {
        initialize: async () => {},
        trackOrder: ({ orderId, quantity, side }) => {
          trackedOrders.push({ orderId, quantity, side });
        },
        cancelOrder: async () => ({
          kind: 'CANCEL_CONFIRMED',
          relatedBuyOrderIds: null,
        }),
        startRuntime: () => {},
        stopRuntimeAndDrain: async () => {},
        recoverOrderTrackingFromSnapshot: async () => {},
        getPendingSellOrders: () => [],
        clearTrackedOrders: () => {},
        onOrderStateChanged: () => () => {},
        hasPendingProtectiveLiquidationOrders: () => false,
      },
      orderRecorder: createOrderRecorderDouble(),
      tradingConfig,
      symbolRegistry: createSymbolRegistryDouble(),
      isExecutionAllowed: () => true,
      now: () => currentTime,
      readCurrentTradingDayInfo: () => ({
        dateKey: '2026-07-10',
        info: { isTradingDay: true, isHalfDay: false },
      }),
    });

    const trader = createTraderDouble({
      getAccountSnapshot: async () => createAccountSnapshotDouble(100000),
      getStockPositions: async () => [],
      canTradeNow: orderExecutor.canTradeNow,
    });
    const riskChecker = createRiskCheckerDouble();
    const orderRecorder = createOrderRecorderDouble();

    await withMockedNow(
      currentTime.getTime(),
      async () => {
        const signal = createSignal({
          symbol: 'BULL.HK',
          action: 'BUYCALL',
          triggerTimeMs: Date.now(),
          reason: 'integration-buy',
        });

        const checkedSignals = await signalProcessor.applyRiskChecks(
          [signal],
          createRiskContext({ trader, riskChecker, orderRecorder }),
        );
        const result = await orderExecutor.executeSignals(checkedSignals);

        expect(result.executedOrderIds.length).toBe(1);
        expect(trackedOrders).toHaveLength(1);
        expect(trackedOrders[0]?.side).toBe(OrderSide.Buy);
        expect(trackedOrders[0]?.quantity).toBe(1000);

        const submitCall = tradeCtx.getCalls('submitOrder')[0];
        const payload = submitCall?.args[0];
        if (
          !payload ||
          typeof payload !== 'object' ||
          !('orderType' in payload) ||
          !('timeInForce' in payload) ||
          !('side' in payload) ||
          !('symbol' in payload) ||
          !('submittedQuantity' in payload)
        ) {
          throw new TypeError('expected submitted buy payload');
        }

        expect(payload.orderType).toBe(OrderType.ELO);
        expect(payload.timeInForce).toBe(TimeInForceType.Day);
        expect(payload.side).toBe(OrderSide.Buy);
        expect(payload.symbol).toBe('BULL.HK');
        expect(Number(String(payload.submittedQuantity))).toBe(1000);
      },
      true,
    );
  });

  it('uses explicit signal quantity when valid quantity is provided', async () => {
    const tradingConfig = createTradingConfig();
    const tradeCtx = createTradeContextMock();
    const currentTime = new Date('2026-07-10T07:00:00.000Z');
    const trackedOrders: Array<{ orderId: string; quantity: number; side: OrderSide }> = [];
    const orderExecutor = createOrderExecutor({
      ctx: createTradeContextDouble(tradeCtx),
      rateLimiter: createMutationRateLimiter(),
      marketDataClient: createExecutableQuoteClient(),
      cacheManager: {
        clearCache: () => {},
        getPendingOrders: async () => [],
      },
      orderMonitor: {
        initialize: async () => {},
        trackOrder: ({ orderId, quantity, side }) => {
          trackedOrders.push({ orderId, quantity, side });
        },
        cancelOrder: async () => ({
          kind: 'CANCEL_CONFIRMED',
          relatedBuyOrderIds: null,
        }),
        startRuntime: () => {},
        stopRuntimeAndDrain: async () => {},
        recoverOrderTrackingFromSnapshot: async () => {},
        getPendingSellOrders: () => [],
        clearTrackedOrders: () => {},
        onOrderStateChanged: () => () => {},
        hasPendingProtectiveLiquidationOrders: () => false,
      },
      orderRecorder: createOrderRecorderDouble(),
      tradingConfig,
      symbolRegistry: createSymbolRegistryDouble(),
      isExecutionAllowed: () => true,
      now: () => currentTime,
      readCurrentTradingDayInfo: () => ({
        dateKey: '2026-07-10',
        info: { isTradingDay: true, isHalfDay: false },
      }),
    });

    await withMockedNow(
      currentTime.getTime(),
      async () => {
        let signal = createSignal({
          symbol: 'BULL.HK',
          action: 'BUYCALL',
          triggerTimeMs: Date.now(),
          reason: 'integration-buy-explicit-quantity',
        });
        signal = { ...signal, quantity: 200 };

        const result = await orderExecutor.executeSignals([signal]);

        expect(result.executedOrderIds.length).toBe(1);
        expect(trackedOrders).toHaveLength(1);
        expect(trackedOrders[0]?.side).toBe(OrderSide.Buy);
        expect(trackedOrders[0]?.quantity).toBe(200);

        const submitCall = tradeCtx.getCalls('submitOrder')[0];
        const payload = submitCall?.args[0];
        if (!payload || typeof payload !== 'object' || !('submittedQuantity' in payload)) {
          throw new TypeError('expected submitted buy payload');
        }

        expect(Number(String(payload.submittedQuantity))).toBe(200);
      },
      true,
    );
  });

  it('rejects invalid explicit buy quantity without silently using targetNotional', async () => {
    const tradingConfig = createTradingConfig();
    const tradeCtx = createTradeContextMock();
    const currentTime = new Date('2026-07-10T02:00:00.000Z');
    const trackedOrders: Array<{ orderId: string; quantity: number; side: OrderSide }> = [];
    const orderExecutor = createOrderExecutor({
      ctx: createTradeContextDouble(tradeCtx),
      rateLimiter: createMutationRateLimiter(),
      marketDataClient: createExecutableQuoteClient(),
      cacheManager: {
        clearCache: () => {},
        getPendingOrders: async () => [],
      },
      orderMonitor: {
        initialize: async () => {},
        trackOrder: ({ orderId, quantity, side }) => {
          trackedOrders.push({ orderId, quantity, side });
        },
        cancelOrder: async () => ({
          kind: 'CANCEL_CONFIRMED',
          relatedBuyOrderIds: null,
        }),
        startRuntime: () => {},
        stopRuntimeAndDrain: async () => {},
        recoverOrderTrackingFromSnapshot: async () => {},
        getPendingSellOrders: () => [],
        clearTrackedOrders: () => {},
        onOrderStateChanged: () => () => {},
        hasPendingProtectiveLiquidationOrders: () => false,
      },
      orderRecorder: createOrderRecorderDouble(),
      tradingConfig,
      symbolRegistry: createSymbolRegistryDouble(),
      isExecutionAllowed: () => true,
      now: () => currentTime,
      readCurrentTradingDayInfo: () => ({
        dateKey: '2026-07-10',
        info: { isTradingDay: true, isHalfDay: false },
      }),
    });

    let signal = createSignal({
      symbol: 'BULL.HK',
      action: 'BUYCALL',
      triggerTimeMs: currentTime.getTime(),
      reason: 'integration-buy-invalid-explicit-quantity',
    });
    signal = { ...signal, quantity: 250 };

    const result = await withMockedNow(
      currentTime.getTime(),
      () => orderExecutor.executeSignals([signal]),
      true,
    );

    expect(result.executedOrderIds.length).toBe(0);
    expect(trackedOrders).toHaveLength(0);
    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(0);
  });

  it('isolates successful buy throttling by direction', async () => {
    const fixedNow = 1_000_000;
    const authorizationTime = new Date('1970-01-01T02:00:00.000Z');
    const tradingConfig = createTradingConfig();
    const tradeCtx = createTradeContextMock({ now: () => fixedNow });
    const orderExecutor = createOrderExecutor({
      ctx: createTradeContextDouble(tradeCtx),
      rateLimiter: createMutationRateLimiter(),
      marketDataClient: createExecutableQuoteClient(),
      cacheManager: {
        clearCache: () => {},
        getPendingOrders: async () => [],
      },
      orderMonitor: {
        initialize: async () => {},
        trackOrder: () => {},
        cancelOrder: async () => ({
          kind: 'CANCEL_CONFIRMED',
          relatedBuyOrderIds: null,
        }),
        startRuntime: () => {},
        stopRuntimeAndDrain: async () => {},
        recoverOrderTrackingFromSnapshot: async () => {},
        getPendingSellOrders: () => [],
        clearTrackedOrders: () => {},
        onOrderStateChanged: () => () => {},
        hasPendingProtectiveLiquidationOrders: () => false,
      },
      orderRecorder: createOrderRecorderDouble(),
      tradingConfig,
      symbolRegistry: createSymbolRegistryDouble(),
      isExecutionAllowed: () => true,
      now: () => authorizationTime,
      readCurrentTradingDayInfo: () => ({
        dateKey: '1970-01-01',
        info: { isTradingDay: true, isHalfDay: false },
      }),
    });

    const firstSignal = createSignal({
      symbol: 'BULL.HK',
      action: 'BUYCALL',
      triggerTimeMs: Date.now(),
      reason: 'first-successful-buy',
    });

    await withMockedNow(fixedNow, async () => {
      const firstResult = await orderExecutor.executeSignals([firstSignal]);
      expect(firstResult.executedOrderIds.length).toBe(1);
    });

    const { secondCallCheck, firstPutCheck } = await withMockedNow(fixedNow, async () => ({
      secondCallCheck: orderExecutor.canTradeNow('BUYCALL'),
      firstPutCheck: orderExecutor.canTradeNow('BUYPUT'),
    }));

    expect(secondCallCheck.canTrade).toBe(false);
    expect(secondCallCheck.waitSeconds).toBe(60);
    expect(firstPutCheck).toEqual({ canTrade: true });

    orderExecutor.resetBuyThrottle();
    const firstPutSignal = createSignal({
      symbol: 'BEAR.HK',
      action: 'BUYPUT',
      triggerTimeMs: Date.now(),
      reason: 'first-successful-put-buy',
    });

    await withMockedNow(fixedNow, async () => {
      const firstPutResult = await orderExecutor.executeSignals([firstPutSignal]);
      expect(firstPutResult.executedOrderIds.length).toBe(1);
    });

    const { secondPutCheck, nextCallCheck } = await withMockedNow(fixedNow, async () => ({
      secondPutCheck: orderExecutor.canTradeNow('BUYPUT'),
      nextCallCheck: orderExecutor.canTradeNow('BUYCALL'),
    }));

    expect(secondPutCheck.canTrade).toBe(false);
    expect(secondPutCheck.waitSeconds).toBe(60);
    expect(nextCallCheck).toEqual({ canTrade: true });
  });

  it('still blocks the next same-direction buy when submit fails after frequency check passed', async () => {
    const fixedNow = 2_000_000;
    const authorizationTime = new Date('1970-01-01T02:00:00.000Z');
    const tradingConfig = createTradingConfig();
    const tradeCtx = createTradeContextMock({ now: () => fixedNow });
    tradeCtx.setFailureRule('submitOrder', {
      failAtCalls: [1],
      errorMessage: 'service unavailable',
    });

    const orderExecutor = createOrderExecutor({
      ctx: createTradeContextDouble(tradeCtx),
      rateLimiter: createMutationRateLimiter(),
      marketDataClient: createExecutableQuoteClient(),
      cacheManager: {
        clearCache: () => {},
        getPendingOrders: async () => [],
      },
      orderMonitor: {
        initialize: async () => {},
        trackOrder: () => {},
        cancelOrder: async () => ({
          kind: 'CANCEL_CONFIRMED',
          relatedBuyOrderIds: null,
        }),
        startRuntime: () => {},
        stopRuntimeAndDrain: async () => {},
        recoverOrderTrackingFromSnapshot: async () => {},
        getPendingSellOrders: () => [],
        clearTrackedOrders: () => {},
        onOrderStateChanged: () => () => {},
        hasPendingProtectiveLiquidationOrders: () => false,
      },
      orderRecorder: createOrderRecorderDouble(),
      tradingConfig,
      symbolRegistry: createSymbolRegistryDouble(),
      isExecutionAllowed: () => true,
      now: () => authorizationTime,
      readCurrentTradingDayInfo: () => ({
        dateKey: '1970-01-01',
        info: { isTradingDay: true, isHalfDay: false },
      }),
    });

    const failedSignal = createSignal({
      symbol: 'BULL.HK',
      action: 'BUYCALL',
      triggerTimeMs: Date.now(),
      reason: 'failed-submit-buy',
    });

    await withMockedNow(fixedNow, async () => {
      let submitError: unknown = null;
      try {
        await orderExecutor.executeSignals([failedSignal]);
      } catch (error) {
        submitError = error;
      }

      expect(submitError).toBeInstanceOf(Error);
      expect(submitError).toMatchObject({
        name: 'ExternalApiRequestError',
        operation: 'TradeContext.submitOrder',
      });
      expect(tradeCtx.getCalls('submitOrder')).toHaveLength(1);
      expect(tradeCtx.getCalls('submitOrder')[0]?.error?.message).toBe('service unavailable');
    });

    const nextCheck = await withMockedNow(fixedNow, async () =>
      orderExecutor.canTradeNow('BUYCALL'),
    );

    expect(nextCheck.canTrade).toBe(false);
    expect(nextCheck.waitSeconds).toBe(60);
  });

  it('blocks the next buy in applyRiskChecks once the previous buy has passed frequency check, regardless of submit success', async () => {
    const tradingConfig = createTradingConfig();
    const signalProcessor = createSignalProcessor({
      tradingConfig,
      liquidationCooldownTracker: {
        recordLiquidationTrigger: () => {},
        recordCooldown: () => {},
        restoreTriggerCount: () => {},
        getRemainingMs: () => 0,
        clearMidnightEligible: () => {},
        resetAllTriggerCounts: () => {},
      },
    });

    const successNow = 3_000_000;
    const successAuthorizationTime = new Date('1970-01-01T02:00:00.000Z');
    const successTradeCtx = createTradeContextMock({ now: () => successNow });
    const successOrderExecutor = createOrderExecutor({
      ctx: createTradeContextDouble(successTradeCtx),
      rateLimiter: createMutationRateLimiter(),
      marketDataClient: createExecutableQuoteClient(),
      cacheManager: {
        clearCache: () => {},
        getPendingOrders: async () => [],
      },
      orderMonitor: {
        initialize: async () => {},
        trackOrder: () => {},
        cancelOrder: async () => ({
          kind: 'CANCEL_CONFIRMED',
          relatedBuyOrderIds: null,
        }),
        startRuntime: () => {},
        stopRuntimeAndDrain: async () => {},
        recoverOrderTrackingFromSnapshot: async () => {},
        getPendingSellOrders: () => [],
        clearTrackedOrders: () => {},
        onOrderStateChanged: () => () => {},
        hasPendingProtectiveLiquidationOrders: () => false,
      },
      orderRecorder: createOrderRecorderDouble(),
      tradingConfig,
      symbolRegistry: createSymbolRegistryDouble(),
      isExecutionAllowed: () => true,
      now: () => successAuthorizationTime,
      readCurrentTradingDayInfo: () => ({
        dateKey: '1970-01-01',
        info: { isTradingDay: true, isHalfDay: false },
      }),
    });

    const successTrader = createTraderDouble({
      getAccountSnapshot: async () => createAccountSnapshotDouble(100000),
      getStockPositions: async () => [],
      canTradeNow: successOrderExecutor.canTradeNow,
    });
    const successRiskChecker = createRiskCheckerDouble();
    const successOrderRecorder = createOrderRecorderDouble();

    const successfulSignal = createSignal({
      symbol: 'BULL.HK',
      action: 'BUYCALL',
      triggerTimeMs: Date.now(),
      reason: 'successful-buy-before-next-risk-check',
    });

    await withMockedNow(successNow, async () => {
      const checkedSignals = await signalProcessor.applyRiskChecks(
        [successfulSignal],
        createRiskContext({
          trader: successTrader,
          riskChecker: successRiskChecker,
          orderRecorder: successOrderRecorder,
        }),
      );
      expect(checkedSignals).toHaveLength(1);
      const executeResult = await successOrderExecutor.executeSignals(checkedSignals);
      expect(executeResult.executedOrderIds.length).toBe(1);
    });

    const blockedSignal = createSignal({
      symbol: 'BULL.HK',
      action: 'BUYCALL',
      triggerTimeMs: Date.now() + VERIFICATION.VERIFIED_SIGNAL_COOLDOWN_SECONDS * 1000 + 1,
      reason: 'should-be-frequency-blocked',
    });

    await withMockedNow(
      successNow + VERIFICATION.VERIFIED_SIGNAL_COOLDOWN_SECONDS * 1000 + 1,
      async () => {
        const blockedResult = await signalProcessor.applyRiskChecks(
          [blockedSignal],
          createRiskContext({
            trader: successTrader,
            riskChecker: successRiskChecker,
            orderRecorder: successOrderRecorder,
          }),
        );
        expect(blockedResult).toHaveLength(0);
        expect(blockedSignal.reason).toBe('should-be-frequency-blocked');
      },
    );

    const failedNow = 4_000_000;
    const failedAuthorizationTime = new Date('1970-01-01T02:00:00.000Z');
    const failedTradeCtx = createTradeContextMock({ now: () => failedNow });
    failedTradeCtx.setFailureRule('submitOrder', {
      failAtCalls: [1],
      errorMessage: 'service unavailable',
    });

    const failedOrderExecutor = createOrderExecutor({
      ctx: createTradeContextDouble(failedTradeCtx),
      rateLimiter: createMutationRateLimiter(),
      marketDataClient: createExecutableQuoteClient(),
      cacheManager: {
        clearCache: () => {},
        getPendingOrders: async () => [],
      },
      orderMonitor: {
        initialize: async () => {},
        trackOrder: () => {},
        cancelOrder: async () => ({
          kind: 'CANCEL_CONFIRMED',
          relatedBuyOrderIds: null,
        }),
        startRuntime: () => {},
        stopRuntimeAndDrain: async () => {},
        recoverOrderTrackingFromSnapshot: async () => {},
        getPendingSellOrders: () => [],
        clearTrackedOrders: () => {},
        onOrderStateChanged: () => () => {},
        hasPendingProtectiveLiquidationOrders: () => false,
      },
      orderRecorder: createOrderRecorderDouble(),
      tradingConfig,
      symbolRegistry: createSymbolRegistryDouble(),
      isExecutionAllowed: () => true,
      now: () => failedAuthorizationTime,
      readCurrentTradingDayInfo: () => ({
        dateKey: '1970-01-01',
        info: { isTradingDay: true, isHalfDay: false },
      }),
    });

    const failedTrader = createTraderDouble({
      getAccountSnapshot: async () => createAccountSnapshotDouble(100000),
      getStockPositions: async () => [],
      canTradeNow: failedOrderExecutor.canTradeNow,
    });
    const failedRiskChecker = createRiskCheckerDouble();
    const failedOrderRecorder = createOrderRecorderDouble();

    const firstFailedSignal = createSignal({
      symbol: 'BULL.HK',
      action: 'BUYCALL',
      triggerTimeMs: Date.now(),
      reason: 'failed-buy-before-next-risk-check',
    });

    await withMockedNow(failedNow, async () => {
      const checkedSignals = await signalProcessor.applyRiskChecks(
        [firstFailedSignal],
        createRiskContext({
          trader: failedTrader,
          riskChecker: failedRiskChecker,
          orderRecorder: failedOrderRecorder,
        }),
      );
      expect(checkedSignals).toHaveLength(1);
      let submitError: unknown = null;
      try {
        await failedOrderExecutor.executeSignals(checkedSignals);
      } catch (error) {
        submitError = error;
      }

      expect(submitError).toBeInstanceOf(Error);
      expect(submitError).toMatchObject({
        name: 'ExternalApiRequestError',
        operation: 'TradeContext.submitOrder',
      });
      expect(failedTradeCtx.getCalls('submitOrder')).toHaveLength(1);
      expect(failedTradeCtx.getCalls('submitOrder')[0]?.error?.message).toBe('service unavailable');
    });

    const secondAllowedSignal = createSignal({
      symbol: 'BULL.HK',
      action: 'BUYCALL',
      triggerTimeMs: Date.now() + VERIFICATION.VERIFIED_SIGNAL_COOLDOWN_SECONDS * 1000 + 1,
      reason: 'should-pass-frequency-check-after-failed-submit',
    });

    await withMockedNow(
      failedNow + VERIFICATION.VERIFIED_SIGNAL_COOLDOWN_SECONDS * 1000 + 1,
      async () => {
        const allowedResult = await signalProcessor.applyRiskChecks(
          [secondAllowedSignal],
          createRiskContext({
            trader: failedTrader,
            riskChecker: failedRiskChecker,
            orderRecorder: failedOrderRecorder,
          }),
        );
        expect(allowedResult).toHaveLength(0);
        expect(secondAllowedSignal.reason).toBe('should-pass-frequency-check-after-failed-submit');
      },
    );
  });
});
