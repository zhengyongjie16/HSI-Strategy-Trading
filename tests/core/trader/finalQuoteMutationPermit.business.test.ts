/**
 * 终态行情与 trade mutation permit 业务测试
 *
 * 覆盖最终 SDK 下单边界必须在 permit 内读取行情、重新授权并基于终态行情构造 payload 的约束。
 */
import { describe, expect, it } from 'bun:test';
import { OrderSide, OrderStatus, OrderType } from 'longbridge';
import { createUnrealizedLossChecker } from '../../../src/core/riskController/unrealizedLossChecker.js';
import { createOrderExecutor } from '../../../src/core/trader/orderExecutor/index.js';
import type { OrderMonitor, TrackOrderParams } from '../../../src/core/trader/types.js';
import { createTradingConfig } from '../../../mock/factories/configFactory.js';
import { createSignal } from '../../../mock/factories/signalFactory.js';
import { createStockPositionsResponse } from '../../../mock/factories/tradeFactory.js';
import { createTradeContextMock } from '../../../mock/longbridge/tradeContextMock.js';
import {
  createMarketDataClientDouble,
  createOrderMonitorDouble as createBaseOrderMonitorDouble,
  createOrderRecorderDouble,
  createQuoteDouble,
  createRateLimiterDouble,
  createSymbolRegistryDouble,
  createTradeContextDouble,
} from '../../helpers/testDoubles.js';
import type { RateLimiter, RiskChecker } from '../../../src/types/services.js';

const EXECUTION_NOW_MS = Date.parse('2026-07-10T02:00:00.000Z');

function createMutationRateLimiter(events: string[]): RateLimiter {
  return createRateLimiterDouble({
    onThrottle: () => {
      events.push('throttle');
    },
    onMutationPermitAcquired: () => {
      events.push('permit');
    },
    onMutationInvoked: () => {
      events.push('invoke');
    },
  });
}

function createOrderMonitorDouble(trackedOrders: TrackOrderParams[]): OrderMonitor {
  return createBaseOrderMonitorDouble({
    trackOrder: (params) => {
      trackedOrders.push(params);
    },
  });
}

function readSubmittedPrice(submitCall: unknown): number | null {
  if (typeof submitCall !== 'object' || submitCall === null) {
    return null;
  }

  const args = Reflect.get(submitCall, 'args');
  if (!Array.isArray(args)) {
    return null;
  }

  const payload = args[0];
  if (typeof payload !== 'object' || payload === null) {
    return null;
  }

  const submittedPrice = Reflect.get(payload, 'submittedPrice');
  return submittedPrice === undefined ? null : Number(String(submittedPrice));
}

function readSubmittedQuantity(submitCall: unknown): number | null {
  if (typeof submitCall !== 'object' || submitCall === null) {
    return null;
  }

  const args = Reflect.get(submitCall, 'args');
  if (!Array.isArray(args)) {
    return null;
  }

  const payload = args[0];
  if (typeof payload !== 'object' || payload === null) {
    return null;
  }

  return Number(String(Reflect.get(payload, 'submittedQuantity')));
}

function createBuyExecutionFixture(params: {
  readonly getQuote: () => Promise<ReturnType<typeof createQuoteDouble> | null>;
  readonly latestBuyPrice?: number | null;
  readonly isExecutionAllowed?: () => boolean;
  readonly symbolRegistry?: ReturnType<typeof createSymbolRegistryDouble>;
  readonly unrealizedLossBuyGate?: Pick<RiskChecker, 'checkUnrealizedLoss'>;
}) {
  const currentTime = new Date(EXECUTION_NOW_MS);
  const tradeContext = createTradeContextMock();
  const events: string[] = [];
  const trackedOrders: TrackOrderParams[] = [];
  let quoteReadCount = 0;
  const unrealizedLossBuyGate: Pick<RiskChecker, 'checkUnrealizedLoss'> =
    params.unrealizedLossBuyGate ?? {
      checkUnrealizedLoss: () => ({ shouldLiquidate: false }),
    };
  const executorDeps = {
    ctx: createTradeContextDouble(tradeContext),
    rateLimiter: createMutationRateLimiter(events),
    marketDataClient: createMarketDataClientDouble({
      getQuotes: async (symbols) => {
        const requestedSymbols = [...symbols];
        expect(requestedSymbols).toEqual(['BULL.HK']);
        quoteReadCount += 1;
        events.push('quote');
        const quote = await params.getQuote();
        return new Map([['BULL.HK', quote]]);
      },
    }),
    cacheManager: {
      clearCache: () => {},
      getPendingOrders: async () => [],
    },
    orderMonitor: createOrderMonitorDouble(trackedOrders),
    orderRecorder: createOrderRecorderDouble({
      getLatestBuyOrderPrice: () => params.latestBuyPrice ?? null,
    }),
    tradingConfig: createTradingConfig(),
    symbolRegistry: params.symbolRegistry ?? createSymbolRegistryDouble(),
    isExecutionAllowed: params.isExecutionAllowed ?? (() => true),
    isContinuousTradingAllowed: () => true,
    now: () => currentTime,
    readCurrentTradingDayInfo: () => ({
      dateKey: '2026-07-10',
      info: { isTradingDay: true, isHalfDay: false },
    }),
    unrealizedLossBuyGate,
  };
  const executor = createOrderExecutor(executorDeps);

  return {
    events,
    executor,
    quoteReadCount: () => quoteReadCount,
    trackedOrders,
    tradeContext,
  };
}

function createSellExecutionFixture(params: {
  readonly getQuote: () => Promise<ReturnType<typeof createQuoteDouble> | null>;
  readonly currentTime?: Date;
  readonly pendingSellOrders?: ReturnType<OrderMonitor['getPendingSellOrders']>;
  readonly cancelOrder?: OrderMonitor['cancelOrder'];
  readonly replaceOrderPriceWithPermit?: OrderMonitor['replaceOrderPriceWithPermit'];
  readonly unrealizedLossBuyGate?: Pick<RiskChecker, 'checkUnrealizedLoss'>;
}) {
  const currentTime = params.currentTime ?? new Date(EXECUTION_NOW_MS);
  const tradeContext = createTradeContextMock();
  tradeContext.seedStockPositions(
    createStockPositionsResponse({
      symbol: 'BULL.HK',
      quantity: 300,
      availableQuantity: 300,
    }),
  );
  const events: string[] = [];
  const trackedOrders: TrackOrderParams[] = [];
  let quoteReadCount = 0;
  const orderMonitorOverrides: Partial<OrderMonitor> = {
    trackOrder: (trackedOrder: TrackOrderParams) => {
      trackedOrders.push(trackedOrder);
    },
    cancelOrder:
      params.cancelOrder ??
      (async () => ({
        kind: 'CANCEL_CONFIRMED' as const,
        relatedBuyOrderIds: null,
      })),
    getPendingSellOrders: () => params.pendingSellOrders ?? [],
  };

  if (params.replaceOrderPriceWithPermit !== undefined) {
    orderMonitorOverrides.replaceOrderPriceWithPermit = params.replaceOrderPriceWithPermit;
  }

  const orderMonitor = createBaseOrderMonitorDouble(orderMonitorOverrides);
  const executor = createOrderExecutor({
    ctx: createTradeContextDouble(tradeContext),
    rateLimiter: createMutationRateLimiter(events),
    marketDataClient: createMarketDataClientDouble({
      getQuotes: async (symbols) => {
        expect([...symbols]).toEqual(['BULL.HK']);
        quoteReadCount += 1;
        events.push('quote');
        const quote = await params.getQuote();
        return new Map([['BULL.HK', quote]]);
      },
    }),
    cacheManager: {
      clearCache: () => {},
      getPendingOrders: async () => [],
    },
    orderMonitor,
    orderRecorder: createOrderRecorderDouble(),
    unrealizedLossBuyGate: params.unrealizedLossBuyGate ?? {
      checkUnrealizedLoss: () => ({ shouldLiquidate: false }),
    },
    tradingConfig: createTradingConfig(),
    symbolRegistry: createSymbolRegistryDouble(),
    isExecutionAllowed: () => true,
    isContinuousTradingAllowed: () => true,
    now: () => currentTime,
    readCurrentTradingDayInfo: () => ({
      dateKey: '2026-07-10',
      info: { isTradingDay: true, isHalfDay: false },
    }),
  });

  return {
    events,
    executor,
    quoteReadCount: () => quoteReadCount,
    trackedOrders,
    tradeContext,
  };
}

describe('OrderExecutor terminal quote mutation permit', () => {
  it('uses P1 read after the permit for buy payload quantity and tracked price', async () => {
    const fixture = createBuyExecutionFixture({
      getQuote: async () => createQuoteDouble('BULL.HK', 2.5, 100),
    });
    const signal = createSignal({
      symbol: 'BULL.HK',
      action: 'BUYCALL',
      triggerTimeMs: EXECUTION_NOW_MS,
      reason: 'P0 must not reach broker payload',
    });

    const result = await fixture.executor.executeSignals([signal]);

    expect(result.executedOrderIds).toHaveLength(1);
    expect(fixture.events).toEqual(['permit', 'quote', 'invoke']);
    expect(fixture.quoteReadCount()).toBe(1);
    expect(readSubmittedPrice(fixture.tradeContext.getCalls('submitOrder')[0])).toBe(2.5);
    expect(readSubmittedQuantity(fixture.tradeContext.getCalls('submitOrder')[0])).toBe(2_000);
    expect(fixture.trackedOrders).toHaveLength(1);
    expect(fixture.trackedOrders[0]?.side).toBe(OrderSide.Buy);
    expect(fixture.trackedOrders[0]?.price).toBe(2.5);
    expect(fixture.trackedOrders[0]?.quantity).toBe(2_000);
  });

  it('rejects a buy when the permit-time REST quote exposes an exceeded unrealized loss', async () => {
    let unrealizedLossGateCalls = 0;
    const fixture = createBuyExecutionFixture({
      getQuote: async () => createQuoteDouble('BULL.HK', 2.5, 100),
      unrealizedLossBuyGate: {
        checkUnrealizedLoss: (symbol, price, isLongSymbol) => {
          unrealizedLossGateCalls += 1;
          expect(symbol).toBe('BULL.HK');
          expect(price).toBe(2.5);
          expect(isLongSymbol).toBeTrue();
          return {
            shouldLiquidate: true,
            reason: 'P1 price crosses the existing unrealized-loss protection threshold',
            quantity: 100,
          };
        },
      },
    });
    const signal = createSignal({
      symbol: 'BULL.HK',
      action: 'BUYCALL',
      triggerTimeMs: EXECUTION_NOW_MS,
      reason: 'the signal snapshot must not bypass the P1 loss gate',
    });

    const result = await fixture.executor.executeSignals([signal]);

    expect(result).toEqual({ executedOrderIds: [] });
    expect(unrealizedLossGateCalls).toBe(1);
    expect(fixture.events).toEqual(['permit', 'quote']);
    expect(fixture.tradeContext.getCalls('submitOrder')).toHaveLength(0);
    expect(fixture.trackedOrders).toEqual([]);
    expect(fixture.executor.canTradeNow('BUYCALL')).toEqual({ canTrade: true });
  });

  it('passes false to the loss gate for a short-direction buy', async () => {
    const symbolRegistry = createSymbolRegistryDouble({
      longSeat: {
        symbol: null,
        status: 'EMPTY',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      shortSeat: {
        symbol: 'BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: 1,
        lastSearchAt: 1,
        lastSeatActivatedAt: 1,
        callPrice: 20_000,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
    });
    let lossGateDirection: boolean | null = null;
    const fixture = createBuyExecutionFixture({
      getQuote: async () => createQuoteDouble('BULL.HK', 2.5, 100),
      symbolRegistry,
      unrealizedLossBuyGate: {
        checkUnrealizedLoss: (_symbol, _price, isLongSymbol) => {
          lossGateDirection = isLongSymbol;
          return { shouldLiquidate: false };
        },
      },
    });
    const signal = createSignal({
      symbol: 'BULL.HK',
      action: 'BUYPUT',
      triggerTimeMs: EXECUTION_NOW_MS,
      reason: 'short-direction final loss gate',
    });

    const result = await fixture.executor.executeSignals([signal]);

    expect(result.executedOrderIds).toHaveLength(1);
    expect(lossGateDirection).toBeFalse();
  });

  it('allows a buy exactly at the configured unrealized-loss threshold', async () => {
    const unrealizedLossChecker = createUnrealizedLossChecker({
      maxUnrealizedLossPerSymbol: 100,
    });
    await unrealizedLossChecker.refresh(
      createOrderRecorderDouble({
        getBuyOrdersForSymbol: () => [
          {
            orderId: 'BULL-OPEN-1',
            symbol: 'BULL.HK',
            executedPrice: 10,
            executedQuantity: 100,
            executedTime: Date.now(),
            submittedAt: new Date(),
            updatedAt: new Date(),
          },
        ],
      }),
      'BULL.HK',
      true,
    );
    let unrealizedLossGateCalls = 0;
    const fixture = createBuyExecutionFixture({
      getQuote: async () => createQuoteDouble('BULL.HK', 9, 100),
      unrealizedLossBuyGate: {
        checkUnrealizedLoss: (symbol, price, isLongSymbol) => {
          unrealizedLossGateCalls += 1;
          return unrealizedLossChecker.check(symbol, price, isLongSymbol);
        },
      },
    });
    const signal = createSignal({
      symbol: 'BULL.HK',
      action: 'BUYCALL',
      triggerTimeMs: EXECUTION_NOW_MS,
      reason: 'loss exactly at threshold remains a valid buy',
    });

    const result = await fixture.executor.executeSignals([signal]);

    expect(result.executedOrderIds).toHaveLength(1);
    expect(unrealizedLossGateCalls).toBe(1);
    expect(fixture.events).toEqual(['permit', 'quote', 'invoke']);
    expect(fixture.tradeContext.getCalls('submitOrder')).toHaveLength(1);
  });

  it('does not invoke the loss gate when the permit-time quote is invalid', async () => {
    let unrealizedLossGateCalls = 0;
    const fixture = createBuyExecutionFixture({
      getQuote: async () => createQuoteDouble('BULL.HK', 0, 100),
      unrealizedLossBuyGate: {
        checkUnrealizedLoss: () => {
          unrealizedLossGateCalls += 1;
          return { shouldLiquidate: false };
        },
      },
    });
    const signal = createSignal({
      symbol: 'BULL.HK',
      action: 'BUYCALL',
      triggerTimeMs: EXECUTION_NOW_MS,
      reason: 'invalid final quote cannot be treated as a loss-gate input',
    });

    const result = await fixture.executor.executeSignals([signal]);

    expect(result).toEqual({ executedOrderIds: [] });
    expect(unrealizedLossGateCalls).toBe(0);
    expect(fixture.events).toEqual(['permit', 'quote']);
    expect(fixture.tradeContext.getCalls('submitOrder')).toHaveLength(0);
  });

  it.each([
    {
      label: 'invalid final price',
      finalQuote: createQuoteDouble('BULL.HK', 0, 100),
      latestBuyPrice: null,
    },
    {
      label: 'latest buy price collision',
      finalQuote: createQuoteDouble('BULL.HK', 1, 100),
      latestBuyPrice: 1,
    },
  ])('skips buy without SDK or buy attempt when P1 has $label', async (scenario) => {
    const fixture = createBuyExecutionFixture({
      getQuote: async () => scenario.finalQuote,
      latestBuyPrice: scenario.latestBuyPrice,
    });
    const signal = createSignal({
      symbol: 'BULL.HK',
      action: 'BUYCALL',
      triggerTimeMs: EXECUTION_NOW_MS,
      reason: `P1 ${scenario.label}`,
    });

    const result = await fixture.executor.executeSignals([signal]);

    expect(result.executedOrderIds).toEqual([]);
    expect(fixture.events).toEqual(['permit', 'quote']);
    expect(fixture.tradeContext.getCalls('submitOrder')).toHaveLength(0);
    expect(fixture.trackedOrders).toEqual([]);
    expect(fixture.executor.canTradeNow('BUYCALL')).toEqual({ canTrade: true });
  });

  it('does not mutate when the execution gate closes while final quote awaits', async () => {
    let executionAllowed = true;
    let unrealizedLossGateCalls = 0;
    let resolveQuote: ((quote: ReturnType<typeof createQuoteDouble>) => void) | undefined;
    const finalQuote = new Promise<ReturnType<typeof createQuoteDouble>>((resolve) => {
      resolveQuote = resolve;
    });
    const fixture = createBuyExecutionFixture({
      getQuote: async () => finalQuote,
      isExecutionAllowed: () => executionAllowed,
      unrealizedLossBuyGate: {
        checkUnrealizedLoss: () => {
          unrealizedLossGateCalls += 1;
          return { shouldLiquidate: false };
        },
      },
    });
    const signal = createSignal({
      symbol: 'BULL.HK',
      action: 'BUYCALL',
      triggerTimeMs: EXECUTION_NOW_MS,
      reason: 'gate may close while P1 awaits',
    });

    const execution = fixture.executor.executeSignals([signal]);
    for (let index = 0; index < 4; index += 1) {
      await Promise.resolve();
    }

    expect(fixture.quoteReadCount()).toBe(1);
    executionAllowed = false;
    if (resolveQuote === undefined) {
      throw new Error('final quote resolver is unavailable');
    }

    resolveQuote(createQuoteDouble('BULL.HK', 2.5, 100));
    const result = await execution;

    expect(result).toEqual({ executedOrderIds: [] });
    expect(fixture.events).toEqual(['permit', 'quote']);
    expect(unrealizedLossGateCalls).toBe(0);
    expect(fixture.tradeContext.getCalls('submitOrder')).toHaveLength(0);
    expect(fixture.trackedOrders).toEqual([]);
  });

  it('rejects a stale seat after P1 before invoking the unrealized-loss gate', async () => {
    const symbolRegistry = createSymbolRegistryDouble({
      longSeat: {
        symbol: 'BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: 1,
        lastSearchAt: 1,
        lastSeatActivatedAt: 1,
        callPrice: 20_000,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      longVersion: 1,
    });
    let unrealizedLossGateCalls = 0;
    let resolveQuote: ((quote: ReturnType<typeof createQuoteDouble>) => void) | undefined;
    const finalQuote = new Promise<ReturnType<typeof createQuoteDouble>>((resolve) => {
      resolveQuote = resolve;
    });
    const fixture = createBuyExecutionFixture({
      getQuote: async () => finalQuote,
      symbolRegistry,
      unrealizedLossBuyGate: {
        checkUnrealizedLoss: () => {
          unrealizedLossGateCalls += 1;
          return { shouldLiquidate: false };
        },
      },
    });
    const signal = createSignal({
      symbol: 'BULL.HK',
      action: 'BUYCALL',
      triggerTimeMs: EXECUTION_NOW_MS,
      reason: 'seat version can change while P1 is pending',
    });

    const execution = fixture.executor.executeSignals([signal]);
    for (let index = 0; index < 4; index += 1) {
      await Promise.resolve();
    }

    expect(fixture.quoteReadCount()).toBe(1);
    symbolRegistry.updateSeatStateWithVersionBump('LONG', {
      symbol: 'BULL.HK',
      status: 'ACTIVE',
      lastSwitchAt: 1,
      lastSearchAt: 1,
      lastSeatActivatedAt: 1,
      callPrice: 20_000,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    });

    if (resolveQuote === undefined) {
      throw new Error('final quote resolver is unavailable');
    }

    resolveQuote(createQuoteDouble('BULL.HK', 2.5, 100));
    const result = await execution;

    expect(result).toEqual({ executedOrderIds: [] });
    expect(fixture.events).toEqual(['permit', 'quote']);
    expect(unrealizedLossGateCalls).toBe(0);
    expect(fixture.tradeContext.getCalls('submitOrder')).toHaveLength(0);
    expect(fixture.trackedOrders).toEqual([]);
  });

  it('uses P1 read after the permit for an ordinary sell submit payload and tracking price', async () => {
    const fixture = createSellExecutionFixture({
      getQuote: async () => createQuoteDouble('BULL.HK', 1.6, 100),
    });
    const signal = {
      ...createSignal({
        symbol: 'BULL.HK',
        action: 'SELLCALL',
        triggerTimeMs: EXECUTION_NOW_MS,
        reason: 'sell P0 must not reach broker payload',
      }),
      quantity: 200,
    };

    const result = await fixture.executor.executeSignals([signal]);

    expect(result.executedOrderIds).toHaveLength(1);
    expect(fixture.events.slice(-3)).toEqual(['permit', 'quote', 'invoke']);
    expect(fixture.quoteReadCount()).toBe(1);
    expect(readSubmittedPrice(fixture.tradeContext.getCalls('submitOrder')[0])).toBe(1.6);
    expect(readSubmittedQuantity(fixture.tradeContext.getCalls('submitOrder')[0])).toBe(200);
    expect(fixture.trackedOrders[0]?.price).toBe(1.6);
  });

  it('never invokes the unrealized-loss buy gate for an ordinary sell', async () => {
    let unrealizedLossGateCalls = 0;
    const fixture = createSellExecutionFixture({
      getQuote: async () => createQuoteDouble('BULL.HK', 1.6, 100),
      unrealizedLossBuyGate: {
        checkUnrealizedLoss: () => {
          unrealizedLossGateCalls += 1;
          return { shouldLiquidate: true };
        },
      },
    });
    const signal = {
      ...createSignal({
        symbol: 'BULL.HK',
        action: 'SELLCALL',
        triggerTimeMs: EXECUTION_NOW_MS,
        reason: 'a sell must not consume the buy-only loss gate',
      }),
      quantity: 200,
    };

    const result = await fixture.executor.executeSignals([signal]);

    expect(result.executedOrderIds).toHaveLength(1);
    expect(unrealizedLossGateCalls).toBe(0);
    expect(fixture.tradeContext.getCalls('submitOrder')).toHaveLength(1);
  });

  it('never invokes the unrealized-loss buy gate for a protective liquidation sell', async () => {
    let unrealizedLossGateCalls = 0;
    const fixture = createSellExecutionFixture({
      getQuote: async () => createQuoteDouble('BULL.HK', 1.6, 100),
      unrealizedLossBuyGate: {
        checkUnrealizedLoss: () => {
          unrealizedLossGateCalls += 1;
          return { shouldLiquidate: true };
        },
      },
    });
    const signal = {
      ...createSignal({
        symbol: 'BULL.HK',
        action: 'SELLCALL',
        triggerTimeMs: EXECUTION_NOW_MS,
        reason: 'protective liquidation must bypass the buy gate',
      }),
      quantity: 200,
      isProtectiveLiquidation: true as const,
    };

    const result = await fixture.executor.executeSignals([signal]);

    expect(result.executedOrderIds).toHaveLength(1);
    expect(unrealizedLossGateCalls).toBe(0);
    expect(fixture.tradeContext.getCalls('submitOrder')).toHaveLength(1);
  });

  it('reads P1 only after CANCEL_AND_SUBMIT has a terminal cancel and fresh quantity', async () => {
    const cancelOrderIds: string[] = [];
    const fixture = createSellExecutionFixture({
      getQuote: async () => createQuoteDouble('BULL.HK', 1.7, 100),
      pendingSellOrders: [
        {
          orderId: 'SELL-OLD-MO',
          symbol: 'BULL.HK',
          side: OrderSide.Sell,
          status: OrderStatus.New,
          orderType: OrderType.MO,
          submittedPrice: null,
          submittedQuantity: 100,
          executedQuantity: 0,
          submittedAt: Date.now(),
        },
      ],
      cancelOrder: async (orderId) => {
        cancelOrderIds.push(orderId);
        return {
          kind: 'ALREADY_CLOSED',
          closedReason: 'CANCELED',
          relatedBuyOrderIds: null,
          terminalExecution: {
            submittedQuantity: 100,
            executedQuantity: 0,
          },
        };
      },
    });
    const signal = {
      ...createSignal({
        symbol: 'BULL.HK',
        action: 'SELLCALL',
        triggerTimeMs: EXECUTION_NOW_MS,
        reason: 'cancel then P1',
      }),
      quantity: 50,
    };

    const result = await fixture.executor.executeSignals([signal]);

    expect(result.executedOrderIds).toHaveLength(1);
    expect(cancelOrderIds).toEqual(['SELL-OLD-MO']);
    expect(fixture.events.slice(-3)).toEqual(['permit', 'quote', 'invoke']);
    expect(readSubmittedPrice(fixture.tradeContext.getCalls('submitOrder')[0])).toBe(1.7);
    expect(readSubmittedQuantity(fixture.tradeContext.getCalls('submitOrder')[0])).toBe(150);
    expect(fixture.trackedOrders[0]?.price).toBe(1.7);
    expect(fixture.trackedOrders[0]?.quantity).toBe(150);
  });

  it('uses P1 inside a permit for merge REPLACE rather than the signal decision price', async () => {
    const replaceCalls: Array<{
      readonly orderId: string;
      readonly price: number;
      readonly quantity: number | null | undefined;
    }> = [];
    const fixture = createSellExecutionFixture({
      getQuote: async () => createQuoteDouble('BULL.HK', 1.8, 100),
      pendingSellOrders: [
        {
          orderId: 'SELL-EXISTING-ELO',
          symbol: 'BULL.HK',
          side: OrderSide.Sell,
          status: OrderStatus.New,
          orderType: OrderType.ELO,
          submittedPrice: 1,
          submittedQuantity: 100,
          executedQuantity: 0,
          submittedAt: Date.now(),
        },
      ],
      replaceOrderPriceWithPermit: async (orderId, price, _request, permit, quantity) =>
        permit.invoke(async () => {
          replaceCalls.push({ orderId, price, quantity });
          return { kind: 'BROKER_CONFIRMED' };
        }),
    });
    const signal = {
      ...createSignal({
        symbol: 'BULL.HK',
        action: 'SELLCALL',
        triggerTimeMs: EXECUTION_NOW_MS,
        reason: 'replace must use P1',
      }),
      quantity: 50,
    };

    const result = await fixture.executor.executeSignals([signal]);

    expect(result.executedOrderIds).toEqual(['SELL-EXISTING-ELO']);
    expect(fixture.events.slice(-3)).toEqual(['permit', 'quote', 'invoke']);
    expect(fixture.quoteReadCount()).toBe(1);
    expect(replaceCalls).toEqual([
      {
        orderId: 'SELL-EXISTING-ELO',
        price: 1.8,
        quantity: 150,
      },
    ]);
    expect(fixture.tradeContext.getCalls('submitOrder')).toHaveLength(0);
  });

  it('cancels old doomsday sells, reads fresh quantity, then submits and tracks with P1', async () => {
    const currentTime = new Date('2026-07-10T07:56:00.000Z');
    const cancelOrderIds: string[] = [];
    let unrealizedLossGateCalls = 0;
    const fixture = createSellExecutionFixture({
      currentTime,
      getQuote: async () => createQuoteDouble('BULL.HK', 1.9, 100),
      unrealizedLossBuyGate: {
        checkUnrealizedLoss: () => {
          unrealizedLossGateCalls += 1;
          return { shouldLiquidate: true };
        },
      },
      pendingSellOrders: [
        {
          orderId: 'SELL-OLD-DOOMSDAY',
          symbol: 'BULL.HK',
          side: OrderSide.Sell,
          status: OrderStatus.New,
          orderType: OrderType.ELO,
          submittedPrice: 1,
          submittedQuantity: 100,
          executedQuantity: 0,
          submittedAt: Date.now(),
        },
      ],
      cancelOrder: async (orderId) => {
        cancelOrderIds.push(orderId);
        return {
          kind: 'ALREADY_CLOSED',
          closedReason: 'CANCELED',
          relatedBuyOrderIds: null,
          terminalExecution: {
            submittedQuantity: 100,
            executedQuantity: 0,
          },
        };
      },
    });
    const clearanceCommand = {
      symbol: 'BULL.HK',
      symbolName: 'BULL.HK',
      action: 'SELLCALL' as const,
      triggerTime: currentTime,
      seatVersion: 1,
    };

    const result = await fixture.executor.executeDoomsdayClearanceSignals([clearanceCommand]);

    expect(result.executedOrderIds).toHaveLength(1);
    expect(cancelOrderIds).toEqual(['SELL-OLD-DOOMSDAY']);
    expect(fixture.events.slice(-3)).toEqual(['permit', 'quote', 'invoke']);
    expect(readSubmittedPrice(fixture.tradeContext.getCalls('submitOrder')[0])).toBe(1.9);
    expect(readSubmittedQuantity(fixture.tradeContext.getCalls('submitOrder')[0])).toBe(300);
    expect(fixture.trackedOrders[0]?.price).toBe(1.9);
    expect(fixture.trackedOrders[0]?.quantity).toBe(300);
    expect(unrealizedLossGateCalls).toBe(0);
  });

  it('skips ordinary and protective tasks without SDK or local writes when final quote is missing', async () => {
    const ordinaryFixture = createBuyExecutionFixture({
      getQuote: async () => null,
    });
    const ordinaryResult = await ordinaryFixture.executor.executeSignals([
      createSignal({
        symbol: 'BULL.HK',
        action: 'BUYCALL',
        triggerTimeMs: EXECUTION_NOW_MS,
        reason: 'ordinary final quote missing',
      }),
    ]);

    expect(ordinaryResult.executedOrderIds).toEqual([]);
    expect(ordinaryFixture.events).toEqual(['permit', 'quote']);
    expect(ordinaryFixture.tradeContext.getCalls('submitOrder')).toHaveLength(0);
    expect(ordinaryFixture.trackedOrders).toEqual([]);

    const protectiveFixture = createSellExecutionFixture({
      getQuote: async () => null,
    });
    const protectiveSignal = {
      ...createSignal({
        symbol: 'BULL.HK',
        action: 'SELLCALL',
        triggerTimeMs: EXECUTION_NOW_MS,
        reason: 'protective final quote missing',
      }),
      quantity: 200,
      isProtectiveLiquidation: true as const,
    };
    const protectiveResult = await protectiveFixture.executor.executeSignals([protectiveSignal]);

    expect(protectiveResult.executedOrderIds).toEqual([]);
    expect(protectiveFixture.events.slice(-2)).toEqual(['permit', 'quote']);
    expect(protectiveFixture.tradeContext.getCalls('submitOrder')).toHaveLength(0);
    expect(protectiveFixture.trackedOrders).toEqual([]);
  });

  it('returns doomsday final-quote unavailability to the window retry owner without submitting', async () => {
    const currentTime = new Date('2026-07-10T07:56:00.000Z');
    const fixture = createSellExecutionFixture({
      currentTime,
      getQuote: async () => null,
    });
    const clearanceCommand = {
      symbol: 'BULL.HK',
      symbolName: 'BULL.HK',
      action: 'SELLCALL' as const,
      triggerTime: currentTime,
      seatVersion: 1,
    };

    const result = await fixture.executor.executeDoomsdayClearanceSignals([clearanceCommand]);

    expect(result.executedOrderIds).toEqual([]);
    expect(result.unresolvedQuoteSymbols).toEqual(['BULL.HK']);
    expect(fixture.events.slice(-2)).toEqual(['permit', 'quote']);
    expect(fixture.tradeContext.getCalls('submitOrder')).toHaveLength(0);
    expect(fixture.trackedOrders).toEqual([]);
  });
});
