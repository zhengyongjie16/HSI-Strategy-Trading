/**
 * orderMonitor 业务测试
 *
 * 覆盖当前核心职责：
 * - pending buy / sell 快照与 recent filled 摘要
 * - filled / rejected 终态处理
 * - 启动恢复后重建 pending sell 追踪
 * - BOOTSTRAPPING 阶段旧事件不得回退终态
 * - 浮点阈值边界与禁追高边界
 * - 卖单超时撤单的等待 WS / backoff 重试 / 剩余数量转市价
 */
import { describe, expect, it } from 'bun:test';
import {
  OrderSide,
  OrderStatus,
  OrderType,
  type PushOrderChanged,
  type TradeContext,
} from 'longbridge';
import { createOrderMonitor } from '../../../src/core/trader/orderMonitor/index.js';
import { createOrderHoldRegistry } from '../../../src/core/trader/orderHoldRegistry.js';
import type { OrderMonitorDeps } from '../../../src/core/trader/types.js';
import {
  createGlobalConfig,
  createStrategyRuntimeConfig,
} from '../../../mock/factories/configFactory.js';
import { createOrder, createPushOrderChanged } from '../../../mock/factories/tradeFactory.js';
import { createTradeContextMock } from '../../../mock/longbridge/tradeContextMock.js';
import {
  createDailyLossTrackerDouble,
  createMarketDataClientDouble,
  createProtectiveLiquidationEpisodeTrackerDouble,
  createQuoteDouble,
  createSymbolRegistryDouble,
} from '../../helpers/testDoubles.js';

async function waitUntil(
  predicate: () => boolean,
  params: {
    readonly timeoutMs?: number;
    readonly intervalMs?: number;
    readonly tick?: () => Promise<void>;
  } = {},
): Promise<void> {
  const { timeoutMs = 800, intervalMs = 20, tick } = params;
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('waitUntil timeout');
    }

    await Bun.sleep(intervalMs);
    if (tick) {
      await tick();
    }
  }
}

function createDeps(params?: {
  readonly sellTimeoutSeconds?: number;
  readonly buyTimeoutSeconds?: number;
  readonly allowBuyOrderTrackingAboveInitialPrice?: boolean;
  readonly onHandleOrderChanged?: (handler: (event: PushOrderChanged) => void) => void;
}): {
  readonly deps: OrderMonitorDeps;
  readonly tradeCtx: ReturnType<typeof createTradeContextMock>;
  readonly setQuote: (price: number) => void;
} {
  const tradeCtx = createTradeContextMock();
  let quotes = new Map<string, ReturnType<typeof createQuoteDouble> | null>([
    ['BULL.HK', createQuoteDouble('BULL.HK', 1.02, 100)],
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
    monitorConfig: createStrategyRuntimeConfig({
      orderOwnershipMapping: ['HSI'],
    }),
    dailyLossTracker: createDailyLossTrackerDouble(),
    orderHoldRegistry: createOrderHoldRegistry(),
    protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
    symbolRegistry: createSymbolRegistryDouble(),
    isExecutionAllowed: () => true,
    ...(params?.onHandleOrderChanged
      ? {
          testHooks: {
            setHandleOrderChanged: params.onHandleOrderChanged,
          },
        }
      : {}),
  };

  return {
    deps,
    tradeCtx,
    setQuote(price: number) {
      quotes = new Map([['BULL.HK', createQuoteDouble('BULL.HK', price)]]);
    },
  };
}

describe('orderMonitor business flow', () => {
  it('tracks pending sell orders and exposes pending-sell lookup helpers', async () => {
    const { deps } = createDeps();
    const monitor = createOrderMonitor(deps);

    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);

    monitor.trackOrder({
      orderId: 'SELL-PENDING-001',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      price: 1,
      initialSubmittedPrice: 1,
      quantity: 200,
      isLongSymbol: true,
      baseInstrumentSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: OrderType.ELO,
    });

    expect(monitor.hasPendingSellOrders('BULL.HK')).toBeTrue();
    expect(monitor.getPendingSellOrders('BULL.HK')).toEqual([
      {
        orderId: 'SELL-PENDING-001',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.New,
        orderType: OrderType.ELO,
        submittedPrice: 1,
        submittedQuantity: 200,
        executedQuantity: 0,
        submittedAt: expect.any(Number),
      },
    ]);
  });

  it('tracks pending buy orders and exposes pending-buy lookup helpers', async () => {
    let handleOrderChanged: (event: PushOrderChanged) => void = () => {};
    const { deps } = createDeps({
      onHandleOrderChanged: (handler) => {
        handleOrderChanged = handler;
      },
    });
    const monitor = createOrderMonitor(deps);

    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);

    monitor.trackOrder({
      orderId: 'BUY-PENDING-001',
      symbol: 'BULL.HK',
      side: OrderSide.Buy,
      price: 1,
      initialSubmittedPrice: 1,
      quantity: 150,
      isLongSymbol: true,
      baseInstrumentSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: OrderType.ELO,
    });

    expect(monitor.hasPendingBuyOrders('BULL.HK')).toBeTrue();
    expect(monitor.getPendingBuyOrders('BULL.HK')).toEqual([
      {
        orderId: 'BUY-PENDING-001',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
        status: OrderStatus.New,
        orderType: OrderType.ELO,
        submittedPrice: 1,
        submittedQuantity: 150,
        executedQuantity: 0,
        submittedAt: expect.any(Number),
      },
    ]);

    handleOrderChanged(
      createPushOrderChanged({
        orderId: 'BUY-PENDING-001',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
        status: OrderStatus.Filled,
        submittedQuantity: 150,
        executedQuantity: 150,
        executedPrice: 1.02,
        submittedPrice: 1,
        orderType: OrderType.ELO,
        updatedAtMs: Date.parse('2026-02-16T01:25:00.000Z'),
      }),
    );

    expect(monitor.hasPendingBuyOrders('BULL.HK')).toBeFalse();
    expect(monitor.getPendingBuyOrders('BULL.HK')).toEqual([]);
  });

  it('keeps partially filled buy orders occupied until the remaining quantity is settled', async () => {
    let handleOrderChanged: (event: PushOrderChanged) => void = () => {};
    const { deps } = createDeps({
      onHandleOrderChanged: (handler) => {
        handleOrderChanged = handler;
      },
    });
    const monitor = createOrderMonitor(deps);

    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);

    monitor.trackOrder({
      orderId: 'BUY-PARTIAL-001',
      symbol: 'BULL.HK',
      side: OrderSide.Buy,
      price: 1,
      initialSubmittedPrice: 1,
      quantity: 150,
      isLongSymbol: true,
      baseInstrumentSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: OrderType.ELO,
    });

    handleOrderChanged(
      createPushOrderChanged({
        orderId: 'BUY-PARTIAL-001',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
        status: OrderStatus.PartialFilled,
        submittedQuantity: 150,
        executedQuantity: 60,
        executedPrice: 1.01,
        submittedPrice: 1,
        orderType: OrderType.ELO,
        updatedAtMs: Date.parse('2026-02-16T01:26:00.000Z'),
      }),
    );

    expect(monitor.hasPendingBuyOrders('BULL.HK')).toBeTrue();
    expect(monitor.getPendingBuyOrders('BULL.HK')).toEqual([
      {
        orderId: 'BUY-PARTIAL-001',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
        status: OrderStatus.PartialFilled,
        orderType: OrderType.ELO,
        submittedPrice: 1,
        submittedQuantity: 150,
        executedQuantity: 60,
        submittedAt: expect.any(Number),
      },
    ]);
  });

  it('settles filled websocket event and stores recent filled summary', async () => {
    let handleOrderChanged: (event: PushOrderChanged) => void = () => {};
    const { deps } = createDeps({
      onHandleOrderChanged: (handler) => {
        handleOrderChanged = handler;
      },
    });
    const monitor = createOrderMonitor(deps);

    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.trackOrder({
      orderId: 'SELL-FILLED-001',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      price: 1,
      initialSubmittedPrice: 1,
      quantity: 300,
      isLongSymbol: true,
      baseInstrumentSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: OrderType.ELO,
    });

    handleOrderChanged(
      createPushOrderChanged({
        orderId: 'SELL-FILLED-001',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.Filled,
        submittedQuantity: 300,
        executedQuantity: 300,
        executedPrice: 1.05,
        submittedPrice: 1,
        orderType: OrderType.ELO,
        updatedAtMs: Date.parse('2026-02-16T01:30:00.000Z'),
      }),
    );

    expect(monitor.hasPendingSellOrders('BULL.HK')).toBeFalse();
    expect(monitor.getRecentFilledOrder('SELL-FILLED-001')).toEqual({
      orderId: 'SELL-FILLED-001',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      executedPrice: 1.05,
      executedQuantity: 300,
      executedTimeMs: Date.parse('2026-02-16T01:30:00.000Z'),
    });

    expect(monitor.getAndClearPendingRefreshSymbols()).toEqual([
      {
        symbol: 'BULL.HK',
        isLongSymbol: true,
        refreshAccount: true,
        refreshPositions: true,
      },
    ]);
  });

  it('settles rejected websocket event without producing recent filled summary', async () => {
    let handleOrderChanged: (event: PushOrderChanged) => void = () => {};
    const { deps } = createDeps({
      onHandleOrderChanged: (handler) => {
        handleOrderChanged = handler;
      },
    });
    const monitor = createOrderMonitor(deps);

    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.trackOrder({
      orderId: 'SELL-REJECTED-001',
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

    handleOrderChanged(
      createPushOrderChanged({
        orderId: 'SELL-REJECTED-001',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.Rejected,
        submittedQuantity: 100,
        executedQuantity: 0,
        executedPrice: 0,
        submittedPrice: 1,
        orderType: OrderType.ELO,
      }),
    );

    expect(monitor.hasPendingSellOrders('BULL.HK')).toBeFalse();
    expect(monitor.getRecentFilledOrder('SELL-REJECTED-001')).toBeNull();
    expect(monitor.getAndClearPendingRefreshSymbols()).toHaveLength(0);
  });

  it('rebuilds pending sell tracking from startup snapshot', async () => {
    const { deps } = createDeps();
    const monitor = createOrderMonitor(deps);

    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([
      {
        orderId: 'SELL-RECOVERY-001',
        symbol: 'BULL.HK',
        stockName: 'HSI RC',
        side: OrderSide.Sell,
        status: OrderStatus.New,
        orderType: OrderType.ELO,
        remark: '',
        price: '1',
        quantity: '250',
        executedPrice: '0',
        executedQuantity: '0',
        submittedAt: new Date('2026-02-16T01:00:00.000Z'),
        updatedAt: new Date('2026-02-16T01:01:00.000Z'),
      },
    ]);

    expect(monitor.hasPendingSellOrders('BULL.HK')).toBeTrue();
    expect(monitor.getPendingSellOrders('BULL.HK')[0]?.orderId).toBe('SELL-RECOVERY-001');
  });

  it('keeps latest terminal websocket event during bootstrapping replay', async () => {
    let handleOrderChanged: (event: PushOrderChanged) => void = () => {};
    const { deps } = createDeps({
      onHandleOrderChanged: (handler) => {
        handleOrderChanged = handler;
      },
    });
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

  it('rebuilds partially filled buy tracking from startup snapshot', async () => {
    const { deps } = createDeps();
    const monitor = createOrderMonitor(deps);

    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([
      {
        orderId: 'BUY-RECOVERY-PARTIAL-001',
        symbol: 'BULL.HK',
        stockName: 'HSI RC',
        side: OrderSide.Buy,
        status: OrderStatus.PartialFilled,
        orderType: OrderType.ELO,
        remark: '',
        price: '1',
        quantity: '150',
        executedPrice: '1.01',
        executedQuantity: '60',
        submittedAt: new Date('2026-02-16T01:00:00.000Z'),
        updatedAt: new Date('2026-02-16T01:01:00.000Z'),
      },
    ]);

    expect(monitor.hasPendingBuyOrders('BULL.HK')).toBeTrue();
    expect(monitor.getPendingBuyOrders('BULL.HK')).toEqual([
      {
        orderId: 'BUY-RECOVERY-PARTIAL-001',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
        status: OrderStatus.PartialFilled,
        orderType: OrderType.ELO,
        submittedPrice: 1,
        submittedQuantity: 150,
        executedQuantity: 60,
        submittedAt: expect.any(Number),
      },
    ]);
  });

  it('fails recovery when a non-market pending snapshot has no valid submitted price', async () => {
    const { deps } = createDeps();
    const monitor = createOrderMonitor(deps);

    await monitor.initialize();
    let caughtError: unknown = null;

    try {
      await monitor.recoverOrderTrackingFromSnapshot([
        {
          orderId: 'SELL-RECOVERY-INVALID-PRICE-001',
          symbol: 'BULL.HK',
          stockName: 'HSI RC',
          side: OrderSide.Sell,
          status: OrderStatus.New,
          orderType: OrderType.ELO,
          remark: '',
          price: '',
          quantity: '250',
          executedPrice: '0',
          executedQuantity: '0',
          submittedAt: new Date('2026-02-16T01:00:00.000Z'),
          updatedAt: new Date('2026-02-16T01:01:00.000Z'),
        },
      ]);
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(Error);
    expect((caughtError as Error).message).toMatch(/委托价格无效/);
  });

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

  it('blocks buy replace above initial submitted price when configured off', async () => {
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

  it('retries timed-out sell cancel after backoff and still waits for websocket terminal state', async () => {
    const { deps, tradeCtx } = createDeps({
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

    await waitUntil(() => tradeCtx.getCalls('cancelOrder').length >= 2, {
      timeoutMs: 1400,
      intervalMs: 20,
      tick: () => monitor.processWithLatestQuotes(),
    });

    expect(tradeCtx.getCalls('cancelOrder')).toHaveLength(2);
    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(0);
    expect(monitor.hasPendingSellOrders('BULL.HK')).toBeTrue();
  });

  it('converts timed-out sell to market order using tracked remaining quantity only', async () => {
    const { deps, tradeCtx } = createDeps({
      sellTimeoutSeconds: 0,
    });
    tradeCtx.seedTodayOrders([
      createOrder({
        orderId: 'SELL-TIMEOUT-001',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.Canceled,
        quantity: 100,
        executedQuantity: 30,
        price: 1,
        executedPrice: 1.01,
      }),
    ]);

    tradeCtx.setFailureRule('cancelOrder', {
      failAtCalls: [1],
      maxFailures: 1,
      errorMessage: 'openapi error: code=601011: order closed',
    });

    const monitor = createOrderMonitor(deps);
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.trackOrder({
      orderId: 'SELL-TIMEOUT-001',
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

    const submitCall = tradeCtx.getCalls('submitOrder')[0];
    const submitArgs = submitCall?.args[0];
    if (submitArgs === undefined) {
      throw new Error('expected market conversion submitOrder payload');
    }

    const submitPayload = submitArgs as {
      readonly orderType: OrderType;
      readonly submittedQuantity: { readonly toString: () => string };
    };

    expect(tradeCtx.getCalls('cancelOrder')).toHaveLength(1);
    expect(tradeCtx.getCalls('orderDetail')).toHaveLength(1);
    expect(tradeCtx.getCalls('submitOrder')).toHaveLength(1);
    expect(submitPayload.orderType).toBe(OrderType.MO);
    expect(Number(submitPayload.submittedQuantity.toString())).toBe(70);
  });
});
