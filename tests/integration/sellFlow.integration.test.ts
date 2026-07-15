/**
 * sell-flow 集成测试
 *
 * 功能：
 * - 验证卖出流程端到端场景与业务期望。
 */
import { describe, expect, it, setSystemTime } from 'bun:test';
import { OrderSide, OrderStatus, OrderType } from 'longbridge';
import { createSignalProcessor } from '../../src/core/signalProcessor/index.js';
import { createOrderStorage } from '../../src/core/orderRecorder/orderStorage.js';
import { createOrderExecutor as createOrderExecutorCore } from '../../src/core/trader/orderExecutor/index.js';
import { createOrderMonitor } from '../../src/core/trader/orderMonitor/index.js';
import { createTradingConfig } from '../../mock/factories/configFactory.js';
import { createSignal } from '../../mock/factories/signalFactory.js';
import { createTradeContextMock } from '../../mock/longbridge/tradeContextMock.js';
import {
  createOrder,
  createPushOrderChanged,
  createStockPositionsResponse,
} from '../../mock/factories/tradeFactory.js';
import {
  createDailyLossTrackerDouble,
  createMarketDataClientDouble,
  createOrderMonitorDouble,
  createOrderRecorderDouble,
  createPositionDouble,
  createProtectiveLiquidationEpisodeTrackerDouble,
  createQuoteDouble,
  createRateLimiterDouble,
  createRiskCheckerDouble,
  createSymbolRegistryDouble,
  createTradeContextDouble,
} from '../helpers/testDoubles.js';
import type { ExecutableSellSignal, Signal } from '../../src/types/signal.js';
import type { OrderRecord } from '../../src/types/services.js';
import type {
  OrderExecutorDeps,
  OrderMonitor,
  OrderMonitorDeps,
} from '../../src/core/trader/types.js';
import { getRequiredHKDateKey } from '../../src/utils/time/index.js';

type OrderMonitorTestOverrides = Omit<Partial<OrderMonitor>, 'replaceOrderPrice'>;

type OrderExecutorTestDeps = Omit<
  OrderExecutorDeps,
  | 'isContinuousTradingAllowed'
  | 'now'
  | 'readCurrentTradingDayInfo'
  | 'orderMonitor'
  | 'unrealizedLossBuyGate'
> & {
  readonly orderMonitor: OrderMonitorTestOverrides;
} & Partial<
    Pick<
      OrderExecutorDeps,
      'isContinuousTradingAllowed' | 'now' | 'readCurrentTradingDayInfo' | 'unrealizedLossBuyGate'
    >
  >;

function createOrderExecutor(deps: OrderExecutorTestDeps) {
  const defaultNow = (): Date => {
    const hongKongDate = new Date(Date.now() + 8 * 60 * 60 * 1000);
    return new Date(
      Date.UTC(
        hongKongDate.getUTCFullYear(),
        hongKongDate.getUTCMonth(),
        hongKongDate.getUTCDate(),
        2,
      ),
    );
  };
  const {
    isContinuousTradingAllowed = () => true,
    now = defaultNow,
    readCurrentTradingDayInfo = () => ({
      dateKey: getRequiredHKDateKey(now()),
      info: { isTradingDay: true, isHalfDay: false },
    }),
    unrealizedLossBuyGate = createRiskCheckerDouble(),
    orderMonitor,
    ...remainingDeps
  } = deps;

  return createOrderExecutorCore({
    ...remainingDeps,
    isContinuousTradingAllowed,
    now,
    readCurrentTradingDayInfo,
    unrealizedLossBuyGate,
    orderMonitor: createOrderMonitorDouble(orderMonitor),
  });
}

/** 创建卖出提交可在 permit 内读取的显式终态行情。 */
function createExecutableQuoteClient() {
  return createMarketDataClientDouble({
    getQuotes: async (symbols) =>
      new Map([...symbols].map((symbol) => [symbol, createQuoteDouble(symbol, 1.1, 100)])),
  });
}

async function withMockedNow<T>(nowMs: number, operation: () => Promise<T>): Promise<T> {
  setSystemTime(nowMs);
  try {
    return await operation();
  } finally {
    setSystemTime();
  }
}

function requireExecutableSellSignals(signals: ReadonlyArray<Signal>): ExecutableSellSignal[] {
  return signals.map((signal) => {
    if (signal.action !== 'SELLCALL' && signal.action !== 'SELLPUT') {
      throw new Error(`Expected executable sell signal, got ${signal.action}`);
    }

    const seatVersion = signal.seatVersion;
    if (typeof seatVersion !== 'number' || !Number.isFinite(seatVersion)) {
      throw new TypeError('Expected executable sell signal with finite seatVersion');
    }

    if (signal.isProtectiveLiquidation === true) {
      return {
        ...signal,
        action: signal.action,
        seatVersion,
        isProtectiveLiquidation: true,
      };
    }

    return {
      ...signal,
      action: signal.action,
      seatVersion,
    };
  });
}

function createRecordedBuyOrder(
  orderId: string,
  executedQuantity: number,
  symbol: string = 'BULL.HK',
): OrderRecord {
  return {
    orderId,
    symbol,
    executedPrice: 1,
    executedQuantity,
    executedTime: Date.parse('2026-02-25T03:00:00.000Z'),
    submittedAt: undefined,
    updatedAt: undefined,
  };
}

describe('sell-flow integration', () => {
  it('throws ExternalApiRequestError without retry when sell quantity resolution reads stock positions', async () => {
    const tradingConfig = createTradingConfig();
    const tradeCtx = createTradeContextMock();
    tradeCtx.seedStockPositions(
      createStockPositionsResponse({
        symbol: 'BULL.HK',
        quantity: 300,
        availableQuantity: 300,
      }),
    );

    tradeCtx.setFailureRule('stockPositions', {
      failAtCalls: [1, 2, 3],
      maxFailures: 3,
      errorMessage: 'service unavailable',
    });

    const orderExecutor = createOrderExecutor({
      ctx: createTradeContextDouble(tradeCtx),
      rateLimiter: createRateLimiterDouble(),
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
          closedReason: 'CANCELED',
          source: 'API',
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
    });

    let signal = createSignal({
      symbol: 'BULL.HK',
      action: 'SELLCALL',
      price: 1.01,
      triggerTimeMs: Date.now(),
      reason: 'sell-quantity-stock-positions-no-retry',
    });
    signal = { ...signal, quantity: 100 };

    let caught: unknown = null;
    try {
      await orderExecutor.executeSignals([signal]);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    if (!(caught instanceof Error)) {
      throw new Error('expected Error');
    }

    expect(caught.name).toBe('ExternalApiRequestError');
    expect(Reflect.get(caught, 'operation')).toBe('TradeContext.stockPositions.quantityResolver');
    expect(Reflect.get(caught, 'attempts')).toBe(1);
    expect(tradeCtx.getCalls('stockPositions')).toHaveLength(1);
  });

  it('末日买入截止窗口不影响接管前的 smart-close 卖单提交', async () => {
    const tradingConfig = createTradingConfig();
    const currentTimeMs = Date.parse('2026-07-12T07:45:01.000Z');
    const signalProcessor = createSignalProcessor({
      tradingConfig,
      liquidationCooldownTracker: {
        recordLiquidationTrigger: () => ({ currentCount: 0, cooldownActivated: false }),
        recordCooldown: () => {},
        restoreTriggerCount: () => {},
        getRemainingMs: () => 0,
        clearMidnightEligible: () => {},
        resetAllTriggerCounts: () => {},
      },
    });

    const storage = createOrderStorage();
    storage.addBuyOrder('BULL.HK', 1, 100, true, Date.now() - 1000);
    storage.addBuyOrder('BULL.HK', 1.2, 200, true, Date.now());

    const sellOrderLinks: Array<{ orderId: string; related: readonly string[] }> = [];
    const recorder = createOrderRecorderDouble({
      getCostAveragePrice: (symbol, isLongSymbol) =>
        storage.getCostAveragePrice(symbol, isLongSymbol),
      getBuyOrdersForSymbol: (symbol, isLongSymbol) =>
        storage.getBuyOrdersList(symbol, isLongSymbol),
      selectSellableOrders: (params) => storage.selectSellableOrders(params),
      submitSellOrder: (orderId, _symbol, _direction, _quantity, relatedBuyOrderIds) => {
        sellOrderLinks.push({ orderId, related: relatedBuyOrderIds });
      },
    });

    const signal = createSignal({
      symbol: 'BULL.HK',
      action: 'SELLCALL',
      triggerTimeMs: currentTimeMs,
      reason: 'integration-sell',
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
      orderRecorder: recorder,
      smartCloseEnabled: true,
      smartCloseTimeoutMinutes: null,
      nowMs: Date.parse('2026-02-25T03:00:00.000Z'),
      isHalfDay: false,
      tradingCalendarSnapshot: new Map(),
    });

    expect(processed[0]?.action).toBe('SELLCALL');
    expect(processed[0]?.quantity).toBe(100);
    expect(processed[0]?.relatedBuyOrderIds?.length).toBe(1);

    const tradeCtx = createTradeContextMock();
    tradeCtx.seedStockPositions(
      createStockPositionsResponse({
        symbol: 'BULL.HK',
        quantity: 300,
        availableQuantity: 300,
      }),
    );

    const trackedOrders: Array<{ orderId: string; quantity: number; side: OrderSide }> = [];
    const orderExecutor = createOrderExecutor({
      ctx: createTradeContextDouble(tradeCtx),
      rateLimiter: createRateLimiterDouble(),
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
          closedReason: 'CANCELED',
          source: 'API',
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
      orderRecorder: recorder,
      tradingConfig,
      symbolRegistry: createSymbolRegistryDouble(),
      isExecutionAllowed: () => true,
      now: () => new Date(currentTimeMs),
      readCurrentTradingDayInfo: () => ({
        dateKey: '2026-07-12',
        info: { isTradingDay: true, isHalfDay: false },
      }),
    });

    const executeResult = await withMockedNow(currentTimeMs, () =>
      orderExecutor.executeSignals(requireExecutableSellSignals(processed)),
    );

    expect(executeResult.executedOrderIds.length).toBe(1);
    expect(trackedOrders).toHaveLength(1);
    expect(trackedOrders[0]?.side).toBe(OrderSide.Sell);
    expect(trackedOrders[0]?.quantity).toBe(100);

    const submitCall = tradeCtx.getCalls('submitOrder')[0];
    const payload = submitCall?.args[0];
    if (
      !payload ||
      typeof payload !== 'object' ||
      !('orderType' in payload) ||
      !('side' in payload) ||
      !('submittedQuantity' in payload)
    ) {
      throw new TypeError('expected submitted sell payload');
    }

    expect(payload.orderType).toBe(OrderType.ELO);
    expect(payload.side).toBe(OrderSide.Sell);
    expect(Number(String(payload.submittedQuantity))).toBe(100);
    expect(sellOrderLinks[0]?.related.length).toBe(1);
  });

  it('smart-close 最终可卖量不能把整单关联裁剪为不可表示数量', async () => {
    const tradingConfig = createTradingConfig();
    const signalProcessor = createSignalProcessor({
      tradingConfig,
      liquidationCooldownTracker: {
        recordLiquidationTrigger: () => ({ currentCount: 0, cooldownActivated: false }),
        recordCooldown: () => {},
        restoreTriggerCount: () => {},
        getRemainingMs: () => 0,
        clearMidnightEligible: () => {},
        resetAllTriggerCounts: () => {},
      },
    });
    const storage = createOrderStorage();
    storage.addBuyOrder('BULL.HK', 1, 100, true, Date.now() - 1_000);
    storage.addBuyOrder('BULL.HK', 1, 100, true, Date.now());

    const trackedOrders: Array<{ readonly orderId: string; readonly quantity: number }> = [];
    const submittedSellLinks: Array<{
      readonly orderId: string;
      readonly quantity: number;
      readonly relatedBuyOrderIds: ReadonlyArray<string>;
    }> = [];
    const recorder = createOrderRecorderDouble({
      getCostAveragePrice: (symbol, isLongSymbol) =>
        storage.getCostAveragePrice(symbol, isLongSymbol),
      getBuyOrdersForSymbol: (symbol, isLongSymbol) =>
        storage.getBuyOrdersList(symbol, isLongSymbol),
      selectSellableOrders: (params) => storage.selectSellableOrders(params),
      submitSellOrder: (orderId, _symbol, _direction, quantity, relatedBuyOrderIds) => {
        submittedSellLinks.push({ orderId, quantity, relatedBuyOrderIds });
      },
    });
    const processedSignals = signalProcessor.processSellSignals({
      signals: [
        createSignal({
          symbol: 'BULL.HK',
          action: 'SELLCALL',
          triggerTimeMs: Date.now(),
          reason: 'smart-close-final-available-clamp',
        }),
      ],
      longPosition: createPositionDouble({
        symbol: 'BULL.HK',
        quantity: 200,
        availableQuantity: 200,
      }),
      shortPosition: null,
      longQuote: createQuoteDouble('BULL.HK', 1.1),
      shortQuote: null,
      orderRecorder: recorder,
      smartCloseEnabled: true,
      smartCloseTimeoutMinutes: null,
      nowMs: Date.parse('2026-02-25T03:00:00.000Z'),
      isHalfDay: false,
      tradingCalendarSnapshot: new Map(),
    });

    expect(processedSignals[0]?.quantity).toBe(200);
    expect(processedSignals[0]?.relatedBuyOrderIds).toHaveLength(2);

    const tradeCtx = createTradeContextMock();
    tradeCtx.seedStockPositions(
      createStockPositionsResponse({
        symbol: 'BULL.HK',
        quantity: 200,
        availableQuantity: 150,
      }),
    );
    const orderExecutor = createOrderExecutor({
      ctx: createTradeContextDouble(tradeCtx),
      rateLimiter: createRateLimiterDouble(),
      marketDataClient: createExecutableQuoteClient(),
      cacheManager: { clearCache: () => {}, getPendingOrders: async () => [] },
      orderMonitor: {
        initialize: async () => {},
        trackOrder: ({ orderId, quantity }) => {
          trackedOrders.push({ orderId, quantity });
        },
        cancelOrder: async () => ({
          kind: 'CANCEL_CONFIRMED',
          closedReason: 'CANCELED',
          source: 'API',
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
      orderRecorder: recorder,
      tradingConfig,
      symbolRegistry: createSymbolRegistryDouble(),
      isExecutionAllowed: () => true,
    });

    const result = await orderExecutor.executeSignals(
      requireExecutableSellSignals(processedSignals),
    );

    expect(result.executedOrderIds).toEqual([]);
    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(0);
    expect(trackedOrders).toEqual([]);
    expect(submittedSellLinks).toEqual([]);
  });

  it('allows an unlinked sell to use the fresh available quantity', async () => {
    const tradingConfig = createTradingConfig();
    const tradeCtx = createTradeContextMock();
    tradeCtx.seedStockPositions(
      createStockPositionsResponse({
        symbol: 'BULL.HK',
        quantity: 200,
        availableQuantity: 150,
      }),
    );
    const orderExecutor = createOrderExecutor({
      ctx: createTradeContextDouble(tradeCtx),
      rateLimiter: createRateLimiterDouble(),
      marketDataClient: createExecutableQuoteClient(),
      cacheManager: { clearCache: () => {}, getPendingOrders: async () => [] },
      orderMonitor: {
        initialize: async () => {},
        trackOrder: () => {},
        cancelOrder: async () => ({
          kind: 'CANCEL_CONFIRMED',
          closedReason: 'CANCELED',
          source: 'API',
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
    });
    const signal = {
      ...createSignal({
        symbol: 'BULL.HK',
        action: 'SELLCALL',
        price: 1.02,
        triggerTimeMs: Date.now(),
        reason: 'unlinked-sell-fresh-available-quantity',
      }),
      quantity: 200,
      relatedBuyOrderIds: [],
    };

    const result = await orderExecutor.executeSignals([signal]);

    expect(result.executedOrderIds).toHaveLength(1);
    const submitPayload = tradeCtx.getCalls('submitOrder')[0]?.args[0];
    if (!submitPayload || typeof submitPayload !== 'object') {
      throw new TypeError('expected submitted sell payload');
    }

    const submittedQuantity = Reflect.get(submitPayload, 'submittedQuantity');
    expect(Number(String(submittedQuantity))).toBe(150);
  });

  it('runs stage2+stage3 with pending occupancy and submits remaining timeout quantity', async () => {
    const tradingConfig = createTradingConfig();
    const signalProcessor = createSignalProcessor({
      tradingConfig,
      liquidationCooldownTracker: {
        recordLiquidationTrigger: () => ({ currentCount: 0, cooldownActivated: false }),
        recordCooldown: () => {},
        restoreTriggerCount: () => {},
        getRemainingMs: () => 0,
        clearMidnightEligible: () => {},
        resetAllTriggerCounts: () => {},
      },
    });

    const storage = createOrderStorage();
    storage.addBuyOrder('BULL.HK', 0.9, 100, true, Date.parse('2026-02-24T01:30:00.000Z'));
    storage.addBuyOrder('BULL.HK', 1.2, 100, true, Date.parse('2026-02-24T01:31:00.000Z'));
    storage.addBuyOrder('BULL.HK', 1.3, 100, true, Date.parse('2026-02-24T01:32:00.000Z'));

    const occupiedOrder = storage
      .getBuyOrdersList('BULL.HK', true)
      .find((order) => order.executedPrice === 1.3);
    if (!occupiedOrder) {
      throw new Error('missing occupied order');
    }

    storage.addPendingSell({
      orderId: 'PENDING-1',
      symbol: 'BULL.HK',
      direction: 'LONG',
      submittedQuantity: 100,
      relatedBuyOrderIds: [occupiedOrder.orderId],
      submittedAt: Date.now(),
    });

    const sellOrderLinks: Array<{ orderId: string; related: readonly string[] }> = [];
    const recorder = createOrderRecorderDouble({
      getCostAveragePrice: (symbol, isLongSymbol) =>
        storage.getCostAveragePrice(symbol, isLongSymbol),
      getBuyOrdersForSymbol: (symbol, isLongSymbol) =>
        storage.getBuyOrdersList(symbol, isLongSymbol),
      selectSellableOrders: (params) => storage.selectSellableOrders(params),
      submitSellOrder: (orderId, _symbol, _direction, _quantity, relatedBuyOrderIds) => {
        sellOrderLinks.push({ orderId, related: relatedBuyOrderIds });
      },
    });

    const signal = createSignal({
      symbol: 'BULL.HK',
      action: 'SELLCALL',
      triggerTimeMs: Date.now(),
      reason: 'integration-sell-stage3',
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
      orderRecorder: recorder,
      smartCloseEnabled: true,
      smartCloseTimeoutMinutes: 60,
      nowMs: Date.parse('2026-02-25T03:00:00.000Z'),
      isHalfDay: false,
      tradingCalendarSnapshot: new Map([
        ['2026-02-24', { isTradingDay: true, isHalfDay: false }],
        ['2026-02-25', { isTradingDay: true, isHalfDay: false }],
      ]),
    });

    expect(processed[0]?.action).toBe('SELLCALL');
    expect(processed[0]?.quantity).toBe(200);
    expect(processed[0]?.relatedBuyOrderIds?.length).toBe(2);
    expect(processed[0]?.relatedBuyOrderIds).not.toContain(occupiedOrder.orderId);

    const tradeCtx = createTradeContextMock();
    tradeCtx.seedStockPositions(
      createStockPositionsResponse({
        symbol: 'BULL.HK',
        quantity: 300,
        availableQuantity: 300,
      }),
    );

    const trackedOrders: Array<{ orderId: string; quantity: number; side: OrderSide }> = [];
    const orderExecutor = createOrderExecutor({
      ctx: createTradeContextDouble(tradeCtx),
      rateLimiter: createRateLimiterDouble(),
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
          closedReason: 'CANCELED',
          source: 'API',
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
      orderRecorder: recorder,
      tradingConfig,
      symbolRegistry: createSymbolRegistryDouble(),
      isExecutionAllowed: () => true,
    });

    const executeResult = await orderExecutor.executeSignals(
      requireExecutableSellSignals(processed),
    );

    expect(executeResult.executedOrderIds.length).toBe(1);
    expect(trackedOrders).toHaveLength(1);
    expect(trackedOrders[0]?.side).toBe(OrderSide.Sell);
    expect(trackedOrders[0]?.quantity).toBe(200);

    const submitCall = tradeCtx.getCalls('submitOrder')[0];
    const payload = submitCall?.args[0];
    if (
      !payload ||
      typeof payload !== 'object' ||
      !('orderType' in payload) ||
      !('side' in payload) ||
      !('submittedQuantity' in payload)
    ) {
      throw new TypeError('expected submitted sell payload');
    }

    expect(payload.orderType).toBe(OrderType.ELO);
    expect(payload.side).toBe(OrderSide.Sell);
    expect(Number(String(payload.submittedQuantity))).toBe(200);
    expect(sellOrderLinks[0]?.related.length).toBe(2);
  });

  it('supports SELLPUT symmetry with smart-close stage2+stage3 and submits short sell order', async () => {
    const tradingConfig = createTradingConfig();
    const signalProcessor = createSignalProcessor({
      tradingConfig,
      liquidationCooldownTracker: {
        recordLiquidationTrigger: () => ({ currentCount: 0, cooldownActivated: false }),
        recordCooldown: () => {},
        restoreTriggerCount: () => {},
        getRemainingMs: () => 0,
        clearMidnightEligible: () => {},
        resetAllTriggerCounts: () => {},
      },
    });

    const storage = createOrderStorage();
    storage.addBuyOrder('BEAR.HK', 0.9, 100, false, Date.parse('2026-02-24T01:30:00.000Z'));
    storage.addBuyOrder('BEAR.HK', 1.2, 100, false, Date.parse('2026-02-24T01:31:00.000Z'));

    const sellOrderLinks: Array<{ orderId: string; related: readonly string[] }> = [];
    const recorder = createOrderRecorderDouble({
      getCostAveragePrice: (symbol, isLongSymbol) =>
        storage.getCostAveragePrice(symbol, isLongSymbol),
      getBuyOrdersForSymbol: (symbol, isLongSymbol) =>
        storage.getBuyOrdersList(symbol, isLongSymbol),
      selectSellableOrders: (params) => storage.selectSellableOrders(params),
      submitSellOrder: (orderId, _symbol, _direction, _quantity, relatedBuyOrderIds) => {
        sellOrderLinks.push({ orderId, related: relatedBuyOrderIds });
      },
    });

    const signal = createSignal({
      symbol: 'BEAR.HK',
      action: 'SELLPUT',
      triggerTimeMs: Date.now(),
      reason: 'integration-sellput-stage3',
    });

    const processed = signalProcessor.processSellSignals({
      signals: [signal],
      longPosition: null,
      shortPosition: createPositionDouble({
        symbol: 'BEAR.HK',
        quantity: 200,
        availableQuantity: 200,
      }),
      longQuote: null,
      shortQuote: createQuoteDouble('BEAR.HK', 1.05),
      orderRecorder: recorder,
      smartCloseEnabled: true,
      smartCloseTimeoutMinutes: 60,
      nowMs: Date.parse('2026-02-25T03:00:00.000Z'),
      isHalfDay: false,
      tradingCalendarSnapshot: new Map([
        ['2026-02-24', { isTradingDay: true, isHalfDay: false }],
        ['2026-02-25', { isTradingDay: true, isHalfDay: false }],
      ]),
    });

    expect(processed[0]?.action).toBe('SELLPUT');
    expect(processed[0]?.quantity).toBe(200);
    expect(processed[0]?.relatedBuyOrderIds?.length).toBe(2);

    const tradeCtx = createTradeContextMock();
    tradeCtx.seedStockPositions(
      createStockPositionsResponse({
        symbol: 'BEAR.HK',
        quantity: 200,
        availableQuantity: 200,
      }),
    );

    const trackedOrders: Array<{ orderId: string; quantity: number; side: OrderSide }> = [];
    const orderExecutor = createOrderExecutor({
      ctx: createTradeContextDouble(tradeCtx),
      rateLimiter: createRateLimiterDouble(),
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
          closedReason: 'CANCELED',
          source: 'API',
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
      orderRecorder: recorder,
      tradingConfig,
      symbolRegistry: createSymbolRegistryDouble(),
      isExecutionAllowed: () => true,
    });

    const executeResult = await orderExecutor.executeSignals(
      requireExecutableSellSignals(processed),
    );

    expect(executeResult.executedOrderIds.length).toBe(1);
    expect(trackedOrders).toHaveLength(1);
    expect(trackedOrders[0]?.side).toBe(OrderSide.Sell);
    expect(trackedOrders[0]?.quantity).toBe(200);

    const submitCall = tradeCtx.getCalls('submitOrder')[0];
    const payload = submitCall?.args[0];
    if (
      !payload ||
      typeof payload !== 'object' ||
      !('orderType' in payload) ||
      !('side' in payload) ||
      !('submittedQuantity' in payload)
    ) {
      throw new TypeError('expected submitted sell payload');
    }

    expect(payload.orderType).toBe(OrderType.ELO);
    expect(payload.side).toBe(OrderSide.Sell);
    expect(Number(String(payload.submittedQuantity))).toBe(200);
    expect(sellOrderLinks[0]?.related.length).toBe(2);
  });

  it('executor returns the existing order ID for broker-confirmed REPLACE and preserves merged occupancy', async () => {
    const tradingConfig = createTradingConfig();
    const tradeCtx = createTradeContextMock();
    tradeCtx.seedStockPositions(
      createStockPositionsResponse({
        symbol: 'BULL.HK',
        quantity: 300,
        availableQuantity: 300,
      }),
    );

    const replaceCalls: Array<{
      orderId: string;
      price: number;
      quantity: number | null | undefined;
    }> = [];
    const updatedPendingSells: Array<{
      orderId: string;
      submittedQuantity: number;
      relatedBuyOrderIds: ReadonlyArray<string>;
    }> = [];
    const submittedAt = Date.parse('2026-02-25T03:00:00.000Z');

    const orderExecutor = createOrderExecutor({
      ctx: createTradeContextDouble(tradeCtx),
      rateLimiter: createRateLimiterDouble(),
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
          closedReason: 'CANCELED',
          source: 'API',
          relatedBuyOrderIds: null,
        }),
        replaceOrderPriceWithPermit: async (orderId, price, _request, permit, quantity) =>
          permit.invoke(async () => {
            replaceCalls.push({ orderId, price, quantity });
            return { kind: 'BROKER_CONFIRMED' };
          }),
        startRuntime: () => {},
        stopRuntimeAndDrain: async () => {},
        recoverOrderTrackingFromSnapshot: async () => {},
        getPendingSellOrders: () => [
          {
            orderId: 'SELL-EXISTING',
            symbol: 'BULL.HK',
            side: OrderSide.Sell,
            status: OrderStatus.New,
            orderType: OrderType.ELO,
            submittedPrice: 1,
            submittedQuantity: 100,
            executedQuantity: 0,
            submittedAt,
          },
        ],
        clearTrackedOrders: () => {},
        onOrderStateChanged: () => () => {},
        hasPendingProtectiveLiquidationOrders: () => false,
      },
      orderRecorder: createOrderRecorderDouble({
        getBuyOrdersForSymbol: () => [
          createRecordedBuyOrder('BUY-OLD', 100),
          createRecordedBuyOrder('BUY-NEW', 50),
        ],
        getPendingSellSnapshot: () => [
          {
            orderId: 'SELL-EXISTING',
            symbol: 'BULL.HK',
            direction: 'LONG',
            submittedQuantity: 100,
            filledQuantity: 0,
            relatedBuyOrderIds: ['BUY-OLD'],
            status: 'pending',
            submittedAt,
          },
        ],
        updatePendingSell: (orderId, params) => {
          updatedPendingSells.push({
            orderId,
            submittedQuantity: params.submittedQuantity,
            relatedBuyOrderIds: params.relatedBuyOrderIds,
          });
          return null;
        },
      }),
      tradingConfig,
      symbolRegistry: createSymbolRegistryDouble(),
      isExecutionAllowed: () => true,
    });

    let signal = createSignal({
      symbol: 'BULL.HK',
      action: 'SELLCALL',
      price: 1.02,
      triggerTimeMs: Date.now(),
      reason: 'replace-merge',
    });
    signal = { ...signal, quantity: 50 };
    signal = { ...signal, relatedBuyOrderIds: ['BUY-NEW'] };

    const result = await orderExecutor.executeSignals([signal]);

    expect(result).toEqual({
      executedOrderIds: ['SELL-EXISTING'],
    });

    expect(replaceCalls).toEqual([
      {
        orderId: 'SELL-EXISTING',
        price: 1.1,
        quantity: 150,
      },
    ]);

    expect(updatedPendingSells).toEqual([
      {
        orderId: 'SELL-EXISTING',
        submittedQuantity: 150,
        relatedBuyOrderIds: ['BUY-OLD', 'BUY-NEW'],
      },
    ]);
    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(0);
  });

  it('fails closed when a partial fill changes smart-close REPLACE facts during rate-limit wait', async () => {
    const tradingConfig = createTradingConfig();
    const tradeCtx = createTradeContextMock();
    tradeCtx.seedStockPositions(
      createStockPositionsResponse({
        symbol: 'BULL.HK',
        quantity: 150,
        availableQuantity: 150,
      }),
    );
    const symbolRegistry = createSymbolRegistryDouble();
    const submittedAtMs = Date.parse('2026-07-13T03:00:00.000Z');
    const pendingSellUpdates: Array<{
      readonly orderId: string;
      readonly submittedQuantity: number;
      readonly relatedBuyOrderIds: ReadonlyArray<string>;
    }> = [];
    let isExistingPendingSellTracked = false;
    const orderRecorder = createOrderRecorderDouble({
      getBuyOrdersForSymbol: () => [
        createRecordedBuyOrder('BUY-OLD', 100),
        createRecordedBuyOrder('BUY-NEW', 50),
      ],
      getPendingSellSnapshot: () =>
        isExistingPendingSellTracked
          ? [
              {
                orderId: 'SELL-EXISTING',
                symbol: 'BULL.HK',
                direction: 'LONG',
                submittedQuantity: 100,
                filledQuantity: 0,
                relatedBuyOrderIds: ['BUY-OLD'],
                status: 'pending',
                submittedAt: submittedAtMs,
              },
            ]
          : [],
      updatePendingSell: (orderId, params) => {
        pendingSellUpdates.push({
          orderId,
          submittedQuantity: params.submittedQuantity,
          relatedBuyOrderIds: params.relatedBuyOrderIds,
        });
        return null;
      },
    });
    let notifyReplaceMutationEntered: (() => void) | undefined;
    let releaseReplaceMutation: (() => void) | undefined;
    const replaceMutationEntered = new Promise<void>((resolve) => {
      notifyReplaceMutationEntered = resolve;
    });
    const rateLimiter = createRateLimiterDouble({
      onMutationPermitAcquired: async () => {
        if (notifyReplaceMutationEntered === undefined) {
          throw new Error('replace mutation entry notifier is unavailable');
        }

        notifyReplaceMutationEntered();
        await new Promise<void>((resolve) => {
          releaseReplaceMutation = resolve;
        });
      },
    });
    const orderMonitor = createOrderMonitor({
      ctx: createTradeContextDouble(tradeCtx),
      rateLimiter,
      cacheManager: {
        clearCache: () => {},
        getPendingOrders: async () => [],
      },
      marketDataClient: createMarketDataClientDouble(),
      orderRecorder,
      dailyLossTracker: createDailyLossTrackerDouble(),
      orderHoldRegistry: {
        trackOrder: () => {},
        markOrderClosed: () => {},
        seedFromOrders: () => {},
        getHoldSymbols: () => new Set<string>(),
        onOrderHoldSymbolsChanged: () => () => {},
        clear: () => {},
      },
      protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
      persistProtectiveLiquidationExecutionProgress: () => {},
      postTradeConsistencyRuntime: {
        recordSettlementRefreshNeed: () => {},
      },
      tradingConfig,
      symbolRegistry,
      isContinuousTradingAllowed: () => true,
      onFatalError: (error) => {
        throw error;
      },
    });
    await orderMonitor.initialize();
    await orderMonitor.recoverOrderTrackingFromSnapshot([]);
    orderMonitor.trackOrder({
      orderId: 'SELL-EXISTING',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      price: 1,
      initialSubmittedPrice: 1,
      quantity: 100,
      submittedAtMs,
      initialStatus: OrderStatus.New,
      isLongSymbol: true,
      monitorSymbol: tradingConfig.monitor.monitorSymbol,
      isProtectiveLiquidation: false,
      orderType: OrderType.ELO,
    });
    isExistingPendingSellTracked = true;
    const orderExecutor = createOrderExecutor({
      ctx: createTradeContextDouble(tradeCtx),
      rateLimiter,
      cacheManager: {
        clearCache: () => {},
        getPendingOrders: async () => [],
      },
      orderMonitor,
      orderRecorder,
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () => new Map([['BULL.HK', createQuoteDouble('BULL.HK', 1.02)]]),
      }),
      tradingConfig,
      symbolRegistry,
      isExecutionAllowed: () => true,
    });
    const signal = {
      ...createSignal({
        symbol: 'BULL.HK',
        action: 'SELLCALL',
        price: 1.02,
        triggerTimeMs: Date.now(),
        reason: 'replace-facts-changed-during-rate-limit-wait',
      }),
      quantity: 50,
      relatedBuyOrderIds: ['BUY-NEW'],
    };

    const resultPromise = orderExecutor.executeSignals([signal]);
    await replaceMutationEntered;
    tradeCtx.emitOrderChanged(
      createPushOrderChanged({
        orderId: 'SELL-EXISTING',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.PartialFilled,
        orderType: OrderType.ELO,
        submittedQuantity: 100,
        executedQuantity: 50,
        submittedPrice: 1,
        executedPrice: 1.01,
        updatedAtMs: submittedAtMs + 1_000,
      }),
    );
    expect(tradeCtx.flushAllEvents()).toBe(1);

    if (releaseReplaceMutation === undefined) {
      throw new Error('replace mutation release is unavailable');
    }

    releaseReplaceMutation();
    const result = await resultPromise;

    expect(result.executedOrderIds).toEqual([]);
    expect(tradeCtx.getCalls('replaceOrder')).toHaveLength(0);
    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(0);
    expect(pendingSellUpdates).toEqual([]);
    const [pendingSell] = orderMonitor.getPendingSellOrders('BULL.HK');
    expect(pendingSell?.submittedQuantity).toBe(100);
    expect(pendingSell?.executedQuantity).toBe(50);
  });

  it('does not REPLACE when merged related buy orders cannot exactly represent target quantity', async () => {
    const tradingConfig = createTradingConfig();
    const tradeCtx = createTradeContextMock();
    tradeCtx.seedStockPositions(
      createStockPositionsResponse({
        symbol: 'BULL.HK',
        quantity: 300,
        availableQuantity: 300,
      }),
    );
    const pendingUpdates: Array<{
      readonly orderId: string;
      readonly submittedQuantity: number;
      readonly relatedBuyOrderIds: ReadonlyArray<string>;
    }> = [];
    const submittedAt = Date.parse('2026-02-25T03:00:00.000Z');
    const orderExecutor = createOrderExecutor({
      ctx: createTradeContextDouble(tradeCtx),
      rateLimiter: createRateLimiterDouble(),
      marketDataClient: createExecutableQuoteClient(),
      cacheManager: { clearCache: () => {}, getPendingOrders: async () => [] },
      orderMonitor: {
        initialize: async () => {},
        trackOrder: () => {},
        cancelOrder: async () => ({
          kind: 'CANCEL_CONFIRMED',
          closedReason: 'CANCELED',
          source: 'API',
          relatedBuyOrderIds: null,
        }),
        startRuntime: () => {},
        stopRuntimeAndDrain: async () => {},
        recoverOrderTrackingFromSnapshot: async () => {},
        getPendingSellOrders: () => [
          {
            orderId: 'SELL-EXISTING-INEXACT',
            symbol: 'BULL.HK',
            side: OrderSide.Sell,
            status: OrderStatus.New,
            orderType: OrderType.ELO,
            submittedPrice: 1,
            submittedQuantity: 100,
            executedQuantity: 0,
            submittedAt,
          },
        ],
        clearTrackedOrders: () => {},
        onOrderStateChanged: () => () => {},
        hasPendingProtectiveLiquidationOrders: () => false,
      },
      orderRecorder: createOrderRecorderDouble({
        getBuyOrdersForSymbol: () => [
          createRecordedBuyOrder('BUY-OLD', 100),
          createRecordedBuyOrder('BUY-NEW', 100),
        ],
        getPendingSellSnapshot: () => [
          {
            orderId: 'SELL-EXISTING-INEXACT',
            symbol: 'BULL.HK',
            direction: 'LONG',
            submittedQuantity: 100,
            filledQuantity: 0,
            relatedBuyOrderIds: ['BUY-OLD'],
            status: 'pending',
            submittedAt,
          },
        ],
        updatePendingSell: (orderId, params) => {
          pendingUpdates.push({
            orderId,
            submittedQuantity: params.submittedQuantity,
            relatedBuyOrderIds: params.relatedBuyOrderIds,
          });
          return null;
        },
      }),
      tradingConfig,
      symbolRegistry: createSymbolRegistryDouble(),
      isExecutionAllowed: () => true,
    });
    const signal = {
      ...createSignal({
        symbol: 'BULL.HK',
        action: 'SELLCALL',
        price: 1.02,
        triggerTimeMs: Date.now(),
        reason: 'replace-inexact-related-buy-orders',
      }),
      quantity: 50,
      relatedBuyOrderIds: ['BUY-NEW'],
    };

    const result = await orderExecutor.executeSignals([signal]);

    expect(result.executedOrderIds).toEqual([]);
    expect(tradeCtx.getCalls('replaceOrder')).toHaveLength(0);
    expect(pendingUpdates).toEqual([]);
    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(0);
  });

  it('does not submit after cancel when merged related buy orders cannot exactly represent replanned quantity', async () => {
    const tradingConfig = createTradingConfig();
    const tradeCtx = createTradeContextMock();
    tradeCtx.seedStockPositions(
      createStockPositionsResponse({
        symbol: 'BULL.HK',
        quantity: 300,
        availableQuantity: 300,
      }),
    );
    const cancelCalls: string[] = [];
    const trackedOrders: Array<{ readonly orderId: string; readonly quantity: number }> = [];
    const submittedSellLinks: Array<{
      readonly orderId: string;
      readonly quantity: number;
      readonly relatedBuyOrderIds: ReadonlyArray<string>;
    }> = [];
    const submittedAt = Date.parse('2026-02-25T03:00:00.000Z');
    const orderExecutor = createOrderExecutor({
      ctx: createTradeContextDouble(tradeCtx),
      rateLimiter: createRateLimiterDouble(),
      marketDataClient: createExecutableQuoteClient(),
      cacheManager: { clearCache: () => {}, getPendingOrders: async () => [] },
      orderMonitor: {
        initialize: async () => {},
        trackOrder: ({ orderId, quantity }) => {
          trackedOrders.push({ orderId, quantity });
        },
        cancelOrder: async (orderId) => {
          cancelCalls.push(orderId);
          return {
            kind: 'ALREADY_CLOSED',
            closedReason: 'CANCELED',
            source: 'API_ERROR',
            relatedBuyOrderIds: ['BUY-OLD'],
            terminalExecution: { submittedQuantity: 100, executedQuantity: 0 },
          };
        },
        startRuntime: () => {},
        stopRuntimeAndDrain: async () => {},
        recoverOrderTrackingFromSnapshot: async () => {},
        getPendingSellOrders: () => [
          {
            orderId: 'SELL-NONREPLACEABLE-INEXACT',
            symbol: 'BULL.HK',
            side: OrderSide.Sell,
            status: OrderStatus.New,
            orderType: OrderType.MO,
            submittedPrice: 0,
            submittedQuantity: 100,
            executedQuantity: 0,
            submittedAt,
          },
        ],
        clearTrackedOrders: () => {},
        onOrderStateChanged: () => () => {},
        hasPendingProtectiveLiquidationOrders: () => false,
      },
      orderRecorder: createOrderRecorderDouble({
        getBuyOrdersForSymbol: () => [
          createRecordedBuyOrder('BUY-OLD', 100),
          createRecordedBuyOrder('BUY-NEW', 100),
        ],
        submitSellOrder: (orderId, _symbol, _direction, quantity, relatedBuyOrderIds) => {
          submittedSellLinks.push({ orderId, quantity, relatedBuyOrderIds });
        },
      }),
      tradingConfig,
      symbolRegistry: createSymbolRegistryDouble(),
      isExecutionAllowed: () => true,
    });
    const signal = {
      ...createSignal({
        symbol: 'BULL.HK',
        action: 'SELLCALL',
        price: 1.02,
        triggerTimeMs: Date.now(),
        reason: 'cancel-and-submit-inexact-related-buy-orders',
      }),
      quantity: 50,
      relatedBuyOrderIds: ['BUY-NEW'],
    };

    const result = await orderExecutor.executeSignals([signal]);

    expect(result.executedOrderIds).toEqual([]);
    expect(cancelCalls).toEqual(['SELL-NONREPLACEABLE-INEXACT']);
    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(0);
    expect(trackedOrders).toEqual([]);
    expect(submittedSellLinks).toEqual([]);
  });

  it('does not update pending sell when REPLACE authorization expires inside the mutation permit', async () => {
    const tradingConfig = createTradingConfig();
    const tradeCtx = createTradeContextMock();
    tradeCtx.seedStockPositions(
      createStockPositionsResponse({
        symbol: 'BULL.HK',
        quantity: 300,
        availableQuantity: 300,
      }),
    );

    let executionAllowed = true;
    let replaceSdkCallCount = 0;
    let updatePendingSellCallCount = 0;
    const submittedAt = Date.parse('2026-02-25T03:00:00.000Z');
    const orderExecutor = createOrderExecutor({
      ctx: createTradeContextDouble(tradeCtx),
      rateLimiter: createRateLimiterDouble(),
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
          closedReason: 'CANCELED',
          source: 'API',
          relatedBuyOrderIds: null,
        }),
        replaceOrderPriceWithPermit: async (_orderId, _price, request, permit) => {
          executionAllowed = false;
          if (request.kind === 'SIGNAL_AUTHORIZED' && request.authorize('replaceOrder.beforeApi')) {
            return permit.invoke(async () => {
              replaceSdkCallCount += 1;
              return { kind: 'BROKER_CONFIRMED' };
            });
          }

          return { kind: 'NOT_EXECUTED' };
        },
        startRuntime: () => {},
        stopRuntimeAndDrain: async () => {},
        recoverOrderTrackingFromSnapshot: async () => {},
        getPendingSellOrders: () => [
          {
            orderId: 'SELL-EXISTING-AUTH-REVOKED',
            symbol: 'BULL.HK',
            side: OrderSide.Sell,
            status: OrderStatus.New,
            orderType: OrderType.ELO,
            submittedPrice: 1,
            submittedQuantity: 100,
            executedQuantity: 0,
            submittedAt,
          },
        ],
        clearTrackedOrders: () => {},
        onOrderStateChanged: () => () => {},
        hasPendingProtectiveLiquidationOrders: () => false,
      },
      orderRecorder: createOrderRecorderDouble({
        getBuyOrdersForSymbol: () => [
          createRecordedBuyOrder('BUY-OLD', 100),
          createRecordedBuyOrder('BUY-NEW', 50),
        ],
        getPendingSellSnapshot: () => [
          {
            orderId: 'SELL-EXISTING-AUTH-REVOKED',
            symbol: 'BULL.HK',
            direction: 'LONG',
            submittedQuantity: 100,
            filledQuantity: 0,
            relatedBuyOrderIds: ['BUY-OLD'],
            status: 'pending',
            submittedAt,
          },
        ],
        updatePendingSell: () => {
          updatePendingSellCallCount += 1;
          return null;
        },
      }),
      tradingConfig,
      symbolRegistry: createSymbolRegistryDouble(),
      isExecutionAllowed: () => executionAllowed,
    });

    let signal = createSignal({
      symbol: 'BULL.HK',
      action: 'SELLCALL',
      price: 1.02,
      triggerTimeMs: Date.now(),
      reason: 'replace-auth-revoked-inside-throttle',
    });
    signal = { ...signal, quantity: 50 };
    signal = { ...signal, relatedBuyOrderIds: ['BUY-NEW'] };

    await orderExecutor.executeSignals(requireExecutableSellSignals([signal]));

    expect(replaceSdkCallCount).toBe(0);
    expect(updatePendingSellCallCount).toBe(0);
  });

  it('does not submit merged sell order before cancel reaches confirmed terminal close', async () => {
    const tradingConfig = createTradingConfig();
    const tradeCtx = createTradeContextMock();
    tradeCtx.seedStockPositions(
      createStockPositionsResponse({
        symbol: 'BULL.HK',
        quantity: 300,
        availableQuantity: 300,
      }),
    );

    const cancelCalls: string[] = [];
    const orderExecutor = createOrderExecutor({
      ctx: createTradeContextDouble(tradeCtx),
      rateLimiter: createRateLimiterDouble(),
      marketDataClient: createExecutableQuoteClient(),
      cacheManager: {
        clearCache: () => {},
        getPendingOrders: async () => [],
      },
      orderMonitor: {
        initialize: async () => {},
        trackOrder: () => {},
        cancelOrder: async (orderId) => {
          cancelCalls.push(orderId);
          return {
            kind: 'CANCEL_CONFIRMED',
            closedReason: 'CANCELED',
            source: 'API',
            relatedBuyOrderIds: ['BUY-OLD'],
          };
        },
        startRuntime: () => {},
        stopRuntimeAndDrain: async () => {},
        recoverOrderTrackingFromSnapshot: async () => {},
        getPendingSellOrders: () => [
          {
            orderId: 'SELL-MARKET-EXISTING',
            symbol: 'BULL.HK',
            side: OrderSide.Sell,
            status: OrderStatus.New,
            orderType: OrderType.MO,
            submittedPrice: 1,
            submittedQuantity: 100,
            executedQuantity: 0,
            submittedAt: Date.parse('2026-02-25T03:00:00.000Z'),
          },
        ],
        clearTrackedOrders: () => {},
        onOrderStateChanged: () => () => {},
        hasPendingProtectiveLiquidationOrders: () => false,
      },
      orderRecorder: createOrderRecorderDouble(),
      tradingConfig,
      symbolRegistry: createSymbolRegistryDouble(),
      isExecutionAllowed: () => true,
    });

    let signal = createSignal({
      symbol: 'BULL.HK',
      action: 'SELLCALL',
      price: 1.03,
      triggerTimeMs: Date.now(),
      reason: 'cancel-and-submit-wait-terminal',
    });
    signal = { ...signal, quantity: 50 };
    signal = { ...signal, relatedBuyOrderIds: ['BUY-NEW'] };

    const result = await orderExecutor.executeSignals([signal]);

    expect(result).toEqual({
      executedOrderIds: [],
    });
    expect(cancelCalls).toEqual(['SELL-MARKET-EXISTING']);
    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(0);
  });

  it('carries original related buy orders into CANCEL_AND_SUBMIT merged sell order', async () => {
    const tradingConfig = createTradingConfig();
    const tradeCtx = createTradeContextMock();
    tradeCtx.seedStockPositions(
      createStockPositionsResponse({
        symbol: 'BULL.HK',
        quantity: 300,
        availableQuantity: 300,
      }),
    );

    const cancelCalls: string[] = [];
    const trackedOrders: Array<{ orderId: string; quantity: number }> = [];
    const submittedSellLinks: Array<{
      orderId: string;
      quantity: number;
      relatedBuyOrderIds: ReadonlyArray<string>;
    }> = [];

    const orderExecutor = createOrderExecutor({
      ctx: createTradeContextDouble(tradeCtx),
      rateLimiter: createRateLimiterDouble(),
      marketDataClient: createExecutableQuoteClient(),
      cacheManager: {
        clearCache: () => {},
        getPendingOrders: async () => [],
      },
      orderMonitor: {
        initialize: async () => {},
        trackOrder: ({ orderId, quantity }) => {
          trackedOrders.push({ orderId, quantity });
        },
        cancelOrder: async (orderId) => {
          cancelCalls.push(orderId);
          return {
            kind: 'ALREADY_CLOSED',
            closedReason: 'CANCELED',
            source: 'API_ERROR',
            relatedBuyOrderIds: ['BUY-OLD'],
            terminalExecution: {
              submittedQuantity: 100,
              executedQuantity: 0,
            },
          };
        },
        startRuntime: () => {},
        stopRuntimeAndDrain: async () => {},
        recoverOrderTrackingFromSnapshot: async () => {},
        getPendingSellOrders: () => [
          {
            orderId: 'SELL-MARKET-EXISTING',
            symbol: 'BULL.HK',
            side: OrderSide.Sell,
            status: OrderStatus.New,
            orderType: OrderType.MO,
            submittedPrice: 1,
            submittedQuantity: 100,
            executedQuantity: 0,
            submittedAt: Date.parse('2026-02-25T03:00:00.000Z'),
          },
        ],
        clearTrackedOrders: () => {},
        onOrderStateChanged: () => () => {},
        hasPendingProtectiveLiquidationOrders: () => false,
      },
      orderRecorder: createOrderRecorderDouble({
        getBuyOrdersForSymbol: () => [
          createRecordedBuyOrder('BUY-OLD', 100),
          createRecordedBuyOrder('BUY-NEW', 50),
        ],
        submitSellOrder: (orderId, _symbol, _direction, quantity, relatedBuyOrderIds) => {
          submittedSellLinks.push({
            orderId,
            quantity,
            relatedBuyOrderIds,
          });
        },
      }),
      tradingConfig,
      symbolRegistry: createSymbolRegistryDouble(),
      isExecutionAllowed: () => true,
    });

    let signal = createSignal({
      symbol: 'BULL.HK',
      action: 'SELLCALL',
      price: 1.03,
      triggerTimeMs: Date.now(),
      reason: 'cancel-and-submit-merge',
    });
    signal = { ...signal, quantity: 50 };
    signal = { ...signal, relatedBuyOrderIds: ['BUY-NEW'] };

    const result = await orderExecutor.executeSignals([signal]);

    expect(result.executedOrderIds.length).toBe(1);
    expect(cancelCalls).toEqual(['SELL-MARKET-EXISTING']);
    expect(trackedOrders).toHaveLength(1);
    expect(trackedOrders[0]?.quantity).toBe(150);
    expect(submittedSellLinks).toHaveLength(1);
    expect(submittedSellLinks[0]?.quantity).toBe(150);
    expect(submittedSellLinks[0]?.relatedBuyOrderIds).toEqual(['BUY-NEW', 'BUY-OLD']);

    const submitCall = tradeCtx.getCalls('submitOrder')[0];
    const payload = submitCall?.args[0];
    if (!payload || typeof payload !== 'object' || !('submittedQuantity' in payload)) {
      throw new TypeError('expected submitted sell payload');
    }

    expect(Number(String(payload.submittedQuantity))).toBe(150);
  });

  it('fails closed when partial cancel remainder cannot be represented by whole related buy orders', async () => {
    const tradingConfig = createTradingConfig();
    const tradeCtx = createTradeContextMock();
    const symbolRegistry = createSymbolRegistryDouble();
    const submittedSellOccupancies: Array<{
      readonly orderId: string;
      readonly quantity: number;
    }> = [];
    const orderRecorder = createOrderRecorderDouble({
      getBuyOrdersForSymbol: () => [createRecordedBuyOrder('BUY-NEW', 50)],
      submitSellOrder: (orderId, _symbol, _direction, quantity) => {
        submittedSellOccupancies.push({ orderId, quantity });
      },
    });
    const initialAvailablePositions = createStockPositionsResponse({
      symbol: 'BULL.HK',
      quantity: 150,
      availableQuantity: 150,
    });
    const postCancelAvailablePositions = createStockPositionsResponse({
      symbol: 'BULL.HK',
      quantity: 110,
      availableQuantity: 110,
    });
    tradeCtx.seedStockPositions(initialAvailablePositions);
    tradeCtx.seedTodayOrders([
      createOrder({
        orderId: 'SELL-PARTIAL-WITHDRAWAL',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.PartialWithdrawal,
        orderType: OrderType.MO,
        quantity: 100,
        executedQuantity: 40,
        price: 1,
        executedPrice: 1.02,
      }),
    ]);

    tradeCtx.setFailureRule('cancelOrder', {
      failAtCalls: [1],
      maxFailures: 1,
      errorMessage: 'openapi error: code=601011: Order has been cancelled',
    });

    let throttleCallCount = 0;
    const rateLimiter = createRateLimiterDouble({
      onThrottle: async () => {
        throttleCallCount += 1;
        if (throttleCallCount === 4) {
          tradeCtx.seedStockPositions(postCancelAvailablePositions);
        }
      },
    });
    const orderMonitorDeps: OrderMonitorDeps = {
      ctx: createTradeContextDouble(tradeCtx),
      rateLimiter,
      cacheManager: {
        clearCache: () => {},
        getPendingOrders: async () => [],
      },
      marketDataClient: createMarketDataClientDouble(),
      orderRecorder,
      dailyLossTracker: createDailyLossTrackerDouble(),
      orderHoldRegistry: {
        trackOrder: () => {},
        markOrderClosed: () => {},
        seedFromOrders: () => {},
        getHoldSymbols: () => new Set<string>(),
        onOrderHoldSymbolsChanged: () => () => {},
        clear: () => {},
      },
      protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
      persistProtectiveLiquidationExecutionProgress: () => {},
      postTradeConsistencyRuntime: {
        recordSettlementRefreshNeed: () => {},
      },
      tradingConfig,
      symbolRegistry,
      isContinuousTradingAllowed: () => true,
      onFatalError: (error) => {
        throw error;
      },
    };
    const orderMonitor = createOrderMonitor(orderMonitorDeps);
    orderMonitor.trackOrder({
      orderId: 'SELL-PARTIAL-WITHDRAWAL',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      price: 1,
      initialSubmittedPrice: 1,
      quantity: 100,
      submittedAtMs: Date.parse('2026-07-11T02:59:00.000Z'),
      initialStatus: OrderStatus.New,
      isLongSymbol: true,
      monitorSymbol: tradingConfig.monitor.monitorSymbol,
      isProtectiveLiquidation: false,
      orderType: OrderType.MO,
    });

    const orderExecutor = createOrderExecutor({
      ctx: createTradeContextDouble(tradeCtx),
      rateLimiter,
      marketDataClient: createExecutableQuoteClient(),
      cacheManager: {
        clearCache: () => {},
        getPendingOrders: async () => [],
      },
      orderMonitor,
      orderRecorder,
      tradingConfig,
      symbolRegistry,
      isExecutionAllowed: () => true,
    });
    let signal = createSignal({
      symbol: 'BULL.HK',
      action: 'SELLCALL',
      price: 1.03,
      triggerTimeMs: Date.now(),
      reason: 'cancel-and-submit-terminal-partial-fill-replan',
    });
    signal = { ...signal, quantity: 50, relatedBuyOrderIds: ['BUY-NEW'] };

    const result = await orderExecutor.executeSignals([signal]);

    expect(result.executedOrderIds).toEqual([]);
    expect(tradeCtx.getCalls('cancelOrder')).toHaveLength(1);
    expect(tradeCtx.getCalls('orderDetail')).toHaveLength(1);
    expect(submittedSellOccupancies).toEqual([]);
    expect(tradeCtx.getCalls('stockPositions')).toHaveLength(2);
    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(0);
  });

  it('fails closed when CANCEL_AND_SUBMIT terminal execution quantity is unavailable', async () => {
    const tradingConfig = createTradingConfig();
    const tradeCtx = createTradeContextMock();
    const symbolRegistry = createSymbolRegistryDouble();
    const submittedSellOccupancies: Array<{
      readonly orderId: string;
      readonly quantity: number;
    }> = [];
    const orderRecorder = createOrderRecorderDouble({
      submitSellOrder: (orderId, _symbol, _direction, quantity) => {
        submittedSellOccupancies.push({ orderId, quantity });
      },
    });
    tradeCtx.seedStockPositions(
      createStockPositionsResponse({
        symbol: 'BULL.HK',
        quantity: 150,
        availableQuantity: 150,
      }),
    );
    const terminalOrder = createOrder({
      orderId: 'SELL-PARTIAL-WITHDRAWAL-MISSING-EXECUTION',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      status: OrderStatus.PartialWithdrawal,
      orderType: OrderType.MO,
      quantity: 100,
      executedQuantity: 0,
      price: 1,
      executedPrice: 1.02,
    });
    // SDK 运行时可能缺失该字段；仅在测试外部不透明边界注入原始事实。
    Object.defineProperty(terminalOrder, 'executedQuantity', {
      value: null,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    tradeCtx.seedTodayOrders([terminalOrder]);
    tradeCtx.setFailureRule('cancelOrder', {
      failAtCalls: [1],
      maxFailures: 1,
      errorMessage: 'openapi error: code=601011: Order has been cancelled',
    });

    let throttleCallCount = 0;
    const rateLimiter = createRateLimiterDouble({
      onThrottle: async () => {
        throttleCallCount += 1;
        if (throttleCallCount === 4) {
          tradeCtx.seedStockPositions(
            createStockPositionsResponse({
              symbol: 'BULL.HK',
              quantity: 110,
              availableQuantity: 110,
            }),
          );
        }
      },
    });
    const orderMonitor = createOrderMonitor({
      ctx: createTradeContextDouble(tradeCtx),
      rateLimiter,
      cacheManager: {
        clearCache: () => {},
        getPendingOrders: async () => [],
      },
      marketDataClient: createMarketDataClientDouble(),
      orderRecorder,
      dailyLossTracker: createDailyLossTrackerDouble(),
      orderHoldRegistry: {
        trackOrder: () => {},
        markOrderClosed: () => {},
        seedFromOrders: () => {},
        getHoldSymbols: () => new Set<string>(),
        onOrderHoldSymbolsChanged: () => () => {},
        clear: () => {},
      },
      protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
      persistProtectiveLiquidationExecutionProgress: () => {},
      postTradeConsistencyRuntime: {
        recordSettlementRefreshNeed: () => {},
      },
      tradingConfig,
      symbolRegistry,
      isContinuousTradingAllowed: () => true,
      onFatalError: (error) => {
        throw error;
      },
    });
    orderMonitor.trackOrder({
      orderId: 'SELL-PARTIAL-WITHDRAWAL-MISSING-EXECUTION',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      price: 1,
      initialSubmittedPrice: 1,
      quantity: 100,
      submittedAtMs: Date.parse('2026-07-11T02:59:00.000Z'),
      initialStatus: OrderStatus.New,
      isLongSymbol: true,
      monitorSymbol: tradingConfig.monitor.monitorSymbol,
      isProtectiveLiquidation: false,
      orderType: OrderType.MO,
    });
    const orderExecutor = createOrderExecutor({
      ctx: createTradeContextDouble(tradeCtx),
      rateLimiter,
      cacheManager: {
        clearCache: () => {},
        getPendingOrders: async () => [],
      },
      orderMonitor,
      orderRecorder,
      marketDataClient: createExecutableQuoteClient(),
      tradingConfig,
      symbolRegistry,
      isExecutionAllowed: () => true,
    });
    const signal = {
      ...createSignal({
        symbol: 'BULL.HK',
        action: 'SELLCALL',
        price: 1.03,
        triggerTimeMs: Date.now(),
        reason: 'cancel-and-submit-missing-terminal-execution-must-fail-closed',
      }),
      quantity: 10,
      relatedBuyOrderIds: ['BUY-NEW'],
    };

    let caughtError: unknown = null;
    try {
      await orderExecutor.executeSignals([signal]);
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toHaveProperty(
      'message',
      expect.stringMatching(/state-check 收到无效累计成交数量，拒绝推进订单状态/),
    );

    expect(tradeCtx.getCalls('cancelOrder')).toHaveLength(1);
    expect(tradeCtx.getCalls('orderDetail')).toHaveLength(1);
    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(0);
    expect(submittedSellOccupancies).toHaveLength(0);
  });
});
