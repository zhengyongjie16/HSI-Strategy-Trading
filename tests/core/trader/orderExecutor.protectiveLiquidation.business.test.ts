/**
 * orderExecutor 清仓执行契约测试
 *
 * 验证保护性清仓与末日清仓在受损载荷、跨日命令及最终提交授权下，
 * 都不会越过订单副作用边界。
 */
import { describe, expect, it, setSystemTime } from 'bun:test';
import { OrderSide, OrderType, type TradeContext } from 'longbridge';
import { TRADING } from '../../../src/constants/index.js';
import { createOrderExecutor as createOrderExecutorCore } from '../../../src/core/trader/orderExecutor/index.js';
import type {
  OrderExecutorDeps,
  OrderMonitor,
  TrackOrderParams,
} from '../../../src/core/trader/types.js';
import type { RateLimiter, TradeMutationPermit } from '../../../src/types/services.js';
import type {
  DoomsdayClearanceExecutionResult,
  ExecuteSignalsResult,
} from '../../../src/types/trader.js';
import type {
  DoomsdayClearanceCommand,
  ExecutableSignal,
  ProtectiveLiquidationSellSignal,
} from '../../../src/types/signal.js';
import { createTradingConfig } from '../../../mock/factories/configFactory.js';
import { createSignal } from '../../../mock/factories/signalFactory.js';
import { createStockPositionsResponse } from '../../../mock/factories/tradeFactory.js';
import { createTradeContextMock } from '../../../mock/longbridge/tradeContextMock.js';
import { getRequiredHKDateKey } from '../../../src/utils/time/index.js';
import {
  createMarketDataClientDouble,
  createOrderRecorderDouble,
  createQuoteDouble,
  createRiskCheckerDouble,
  createSymbolRegistryDouble,
  createTradeContextDouble,
} from '../../helpers/testDoubles.js';

type OrderExecutorTestDeps = Omit<OrderExecutorDeps, 'unrealizedLossBuyGate'> &
  Partial<Pick<OrderExecutorDeps, 'unrealizedLossBuyGate'>>;

function createOrderExecutor(deps: OrderExecutorTestDeps) {
  return createOrderExecutorCore({
    unrealizedLossBuyGate: createRiskCheckerDouble(),
    ...deps,
  });
}

/** 构造保护性清仓测试所需的 callback permit 限流器。 */
function createRateLimiterDouble(
  onRateLimiterCall: () => void,
  onThrottle?: () => void,
  onMutationPermitAcquired?: () => void,
): RateLimiter {
  return {
    throttle: async () => {
      onRateLimiterCall();
      onThrottle?.();
    },
    withTradeMutation: async <T>(
      callback: (permit: TradeMutationPermit) => Promise<T>,
    ): Promise<T> => {
      onRateLimiterCall();
      onMutationPermitAcquired?.();
      return callback({
        invoke: async <TResult>(operation: () => Promise<TResult>): Promise<TResult> => operation(),
      });
    },
  };
}

/** 构造只服务于最终执行报价读取的行情替身。 */
function createFinalQuoteMarketDataClient() {
  return createMarketDataClientDouble({
    getQuotes: async () => new Map([['BULL.HK', createQuoteDouble('BULL.HK', 5)]]),
  });
}

function createOrderMonitorDouble(params: {
  readonly onTrackOrder: (trackedOrder: TrackOrderParams) => void;
}): OrderMonitor {
  return {
    initialize: async () => {},
    onOrderStateChanged: () => () => {},
    trackOrder: (trackedOrder) => {
      params.onTrackOrder(trackedOrder);
    },
    cancelOrder: async () => ({
      kind: 'CANCEL_CONFIRMED',
      relatedBuyOrderIds: null,
    }),
    cancelDoomsdayOrder: async () => ({
      kind: 'CANCEL_CONFIRMED',
      relatedBuyOrderIds: null,
    }),
    replaceOrderPriceWithPermit: async () => ({ kind: 'BROKER_CONFIRMED' }),
    startRuntime: () => {},
    stopRuntimeAndDrain: async () => {},
    recoverOrderTrackingFromSnapshot: async () => {},
    getPendingSellOrders: () => [],
    hasPendingProtectiveLiquidationOrders: () => false,
    clearTrackedOrders: () => {},
  };
}

/** 构造直接覆盖末日命令授权边界的最小真实执行器。 */
function createDoomsdayAuthorizationHarness(params: {
  readonly initialTime: Date;
  readonly timeAfterFinalQuote?: Date;
}) {
  let currentTime = params.initialTime;
  let finalQuoteReadCount = 0;
  let throttleCount = 0;
  let mutationPermitCount = 0;
  let trackedOrderCount = 0;
  const tradeContext = createTradeContextMock();
  tradeContext.seedStockPositions(
    createStockPositionsResponse({
      symbol: 'BULL.HK',
      quantity: 100,
      availableQuantity: 100,
    }),
  );

  const orderExecutor = createOrderExecutor({
    ctx: createTradeContextDouble(tradeContext),
    rateLimiter: createRateLimiterDouble(
      () => {},
      () => {
        throttleCount += 1;
      },
      () => {
        mutationPermitCount += 1;
      },
    ),
    marketDataClient: createMarketDataClientDouble({
      getQuotes: async (symbols) => {
        finalQuoteReadCount += 1;
        if (params.timeAfterFinalQuote !== undefined) {
          currentTime = params.timeAfterFinalQuote;
        }

        return new Map([...symbols].map((symbol) => [symbol, createQuoteDouble(symbol, 5, 100)]));
      },
    }),
    cacheManager: {
      clearCache: () => {},
      getPendingOrders: async () => [],
    },
    orderMonitor: createOrderMonitorDouble({
      onTrackOrder: () => {
        trackedOrderCount += 1;
      },
    }),
    orderRecorder: createOrderRecorderDouble(),
    tradingConfig: createTradingConfig(),
    symbolRegistry: createSymbolRegistryDouble(),
    isExecutionAllowed: () => true,
    isContinuousTradingAllowed: () => true,
    now: () => currentTime,
    readCurrentTradingDayInfo: () => ({
      dateKey: getRequiredHKDateKey(currentTime),
      info: { isTradingDay: true, isHalfDay: false },
    }),
  } satisfies OrderExecutorTestDeps);

  return {
    orderExecutor,
    tradeContext,
    getFinalQuoteReadCount: () => finalQuoteReadCount,
    getThrottleCount: () => throttleCount,
    getMutationPermitCount: () => mutationPermitCount,
    getTrackedOrderCount: () => trackedOrderCount,
  };
}

/** 构造具备明确触发时间的末日清仓命令，避免测试意外依赖宿主时钟。 */
function createDoomsdayAuthorizationCommand(params: {
  readonly triggerTime: Date;
  readonly symbol?: string;
  readonly action?: 'SELLCALL' | 'SELLPUT';
}): DoomsdayClearanceCommand {
  const action = params.action ?? 'SELLCALL';
  const symbol = params.symbol ?? 'BULL.HK';
  return {
    symbol,
    symbolName: symbol,
    action,
    triggerTime: params.triggerTime,
    seatVersion: 1,
  };
}

describe('orderExecutor protective-liquidation contract', () => {
  it('rejects a complete doomsday batch with a corrupted BUY action before any order side effect', async () => {
    const currentTime = new Date('2026-07-10T07:56:00.000Z');
    const harness = createDoomsdayAuthorizationHarness({ initialTime: currentTime });
    const legalCommand = createDoomsdayAuthorizationCommand({ triggerTime: currentTime });
    // 模拟 JavaScript 调用方或受损内部载荷绕过 DoomsdayClearanceCommand 的静态卖出约束。
    const corruptedBuyCommand = {
      ...createDoomsdayAuthorizationCommand({
        triggerTime: currentTime,
        symbol: 'BEAR.HK',
      }),
      action: 'BUYCALL',
    } as unknown as DoomsdayClearanceCommand;

    let executionError: unknown = null;
    try {
      await harness.orderExecutor.executeDoomsdayClearanceSignals([
        legalCommand,
        corruptedBuyCommand,
      ]);
    } catch (error) {
      executionError = error;
    }

    expect({
      finalQuoteReadCount: harness.getFinalQuoteReadCount(),
      stockPositionsCalls: harness.tradeContext.getCalls('stockPositions').length,
      submitOrderCalls: harness.tradeContext.getCalls('submitOrder').length,
      trackedOrderCount: harness.getTrackedOrderCount(),
    }).toEqual({
      finalQuoteReadCount: 0,
      stockPositionsCalls: 0,
      submitOrderCalls: 0,
      trackedOrderCount: 0,
    });
    expect(executionError).toBeInstanceOf(Error);
    if (!(executionError instanceof Error)) {
      throw new Error('expected corrupted doomsday BUY action to fail fast');
    }

    expect(executionError.message).toContain('末日清仓');
  });

  it('rejects a cross-day doomsday command before quote, position, broker, or tracking work', async () => {
    const currentTime = new Date('2026-07-10T07:56:00.000Z');
    const harness = createDoomsdayAuthorizationHarness({ initialTime: currentTime });
    const result = await harness.orderExecutor.executeDoomsdayClearanceSignals([
      createDoomsdayAuthorizationCommand({
        triggerTime: new Date('2026-07-09T07:56:00.000Z'),
      }),
    ]);

    expect(result).toEqual({
      executedOrderIds: [],
      awaitingAuthoritativeTerminalSymbols: [],
      unresolvedQuoteSymbols: [],
    });

    expect({
      finalQuoteReadCount: harness.getFinalQuoteReadCount(),
      throttleCount: harness.getThrottleCount(),
      mutationPermitCount: harness.getMutationPermitCount(),
      stockPositionsCalls: harness.tradeContext.getCalls('stockPositions').length,
      submitOrderCalls: harness.tradeContext.getCalls('submitOrder').length,
      trackedOrderCount: harness.getTrackedOrderCount(),
    }).toEqual({
      finalQuoteReadCount: 0,
      throttleCount: 0,
      mutationPermitCount: 0,
      stockPositionsCalls: 0,
      submitOrderCalls: 0,
      trackedOrderCount: 0,
    });
  });

  it('rejects an invalid-time doomsday command before quote, position, broker, or tracking work', async () => {
    const currentTime = new Date('2026-07-10T07:56:00.000Z');
    const harness = createDoomsdayAuthorizationHarness({ initialTime: currentTime });
    const result = await harness.orderExecutor.executeDoomsdayClearanceSignals([
      createDoomsdayAuthorizationCommand({
        triggerTime: new Date(Number.NaN),
      }),
    ]);

    expect(result).toEqual({
      executedOrderIds: [],
      awaitingAuthoritativeTerminalSymbols: [],
      unresolvedQuoteSymbols: [],
    });

    expect({
      finalQuoteReadCount: harness.getFinalQuoteReadCount(),
      throttleCount: harness.getThrottleCount(),
      mutationPermitCount: harness.getMutationPermitCount(),
      stockPositionsCalls: harness.tradeContext.getCalls('stockPositions').length,
      submitOrderCalls: harness.tradeContext.getCalls('submitOrder').length,
      trackedOrderCount: harness.getTrackedOrderCount(),
    }).toEqual({
      finalQuoteReadCount: 0,
      throttleCount: 0,
      mutationPermitCount: 0,
      stockPositionsCalls: 0,
      submitOrderCalls: 0,
      trackedOrderCount: 0,
    });
  });

  it('does not invoke the broker when a same-day doomsday command becomes cross-day after its final quote', async () => {
    const currentTime = new Date('2026-07-10T07:56:00.000Z');
    const harness = createDoomsdayAuthorizationHarness({
      initialTime: currentTime,
      timeAfterFinalQuote: new Date('2026-07-11T07:56:00.000Z'),
    });
    const result = await harness.orderExecutor.executeDoomsdayClearanceSignals([
      createDoomsdayAuthorizationCommand({ triggerTime: currentTime }),
    ]);

    expect(result).toEqual({
      executedOrderIds: [],
      awaitingAuthoritativeTerminalSymbols: [],
      unresolvedQuoteSymbols: [],
    });

    expect({
      finalQuoteReadCount: harness.getFinalQuoteReadCount(),
      stockPositionsCalls: harness.tradeContext.getCalls('stockPositions').length,
      submitOrderCalls: harness.tradeContext.getCalls('submitOrder').length,
      trackedOrderCount: harness.getTrackedOrderCount(),
    }).toEqual({
      finalQuoteReadCount: 1,
      stockPositionsCalls: 1,
      submitOrderCalls: 0,
      trackedOrderCount: 0,
    });
  });

  it('continues a valid same-day doomsday command while rejecting only the stale command in the batch', async () => {
    const currentTime = new Date('2026-07-10T07:56:00.000Z');
    const harness = createDoomsdayAuthorizationHarness({ initialTime: currentTime });
    const result = await harness.orderExecutor.executeDoomsdayClearanceSignals([
      createDoomsdayAuthorizationCommand({ triggerTime: currentTime }),
      createDoomsdayAuthorizationCommand({
        triggerTime: new Date('2026-07-09T07:56:00.000Z'),
      }),
    ]);

    expect(result.executedOrderIds).toHaveLength(1);
    expect({
      finalQuoteReadCount: harness.getFinalQuoteReadCount(),
      stockPositionsCalls: harness.tradeContext.getCalls('stockPositions').length,
      submitOrderCalls: harness.tradeContext.getCalls('submitOrder').length,
      trackedOrderCount: harness.getTrackedOrderCount(),
    }).toEqual({
      finalQuoteReadCount: 1,
      stockPositionsCalls: 1,
      submitOrderCalls: 1,
      trackedOrderCount: 1,
    });
  });

  it('fails before every order side effect when a three-day-old BUY carries protective liquidation', async () => {
    const executionTime = new Date('2026-07-10T02:00:00.000Z');
    const tradeContext = createTradeContextMock();
    let rateLimiterCalls = 0;
    let trackedOrderCount = 0;
    let localRecordCount = 0;
    const orderExecutorDeps = {
      ctx: tradeContext as unknown as TradeContext,
      rateLimiter: createRateLimiterDouble(() => {
        rateLimiterCalls += 1;
      }),
      marketDataClient: createFinalQuoteMarketDataClient(),
      cacheManager: {
        clearCache: () => {},
        getPendingOrders: async () => [],
      },
      orderMonitor: createOrderMonitorDouble({
        onTrackOrder: () => {
          trackedOrderCount += 1;
        },
      }),
      orderRecorder: createOrderRecorderDouble({
        recordLocalBuy: () => {
          localRecordCount += 1;
        },
        recordLocalSell: () => {
          localRecordCount += 1;
        },
        submitSellOrder: () => {
          localRecordCount += 1;
        },
      }),
      tradingConfig: createTradingConfig(),
      symbolRegistry: createSymbolRegistryDouble(),
      isExecutionAllowed: () => true,
      isContinuousTradingAllowed: () => true,
      now: () => executionTime,
      readCurrentTradingDayInfo: () => ({
        dateKey: '2026-07-10',
        info: { isTradingDay: true, isHalfDay: false },
      }),
    } satisfies OrderExecutorTestDeps;
    const illegalSignal = {
      ...createSignal({
        symbol: 'BULL.HK',
        action: 'BUYCALL',
        triggerTimeMs: executionTime.getTime() - 3 * 24 * 60 * 60 * 1000,
        reason: 'illegal-protective-buy',
      }),
      isProtectiveLiquidation: true,
    } as unknown as ExecutableSignal;

    let executionError: unknown = null;
    setSystemTime(executionTime);
    try {
      await createOrderExecutor(orderExecutorDeps).executeSignals([illegalSignal]);
    } catch (error) {
      executionError = error;
    } finally {
      setSystemTime();
    }

    expect({
      rateLimiterCalls,
      submitOrderCalls: tradeContext.getCalls('submitOrder').length,
      trackedOrderCount,
      localRecordCount,
    }).toEqual({
      rateLimiterCalls: 0,
      submitOrderCalls: 0,
      trackedOrderCount: 0,
      localRecordCount: 0,
    });
    expect(executionError).toBeInstanceOf(Error);
    if (!(executionError instanceof Error)) {
      throw new Error('expected illegal protective BUY to fail fast');
    }

    expect(executionError.message).toContain('保护性清仓');
  });

  it('fails before the closed execution gate when a BUY carries protective liquidation', async () => {
    const executionTime = new Date('2026-07-10T02:00:00.000Z');
    const tradeContext = createTradeContextMock();
    let executionGateCalls = 0;
    let rateLimiterCalls = 0;
    let cacheClearCalls = 0;
    let trackedOrderCount = 0;
    const orderExecutorDeps = {
      ctx: tradeContext as unknown as TradeContext,
      rateLimiter: createRateLimiterDouble(() => {
        rateLimiterCalls += 1;
      }),
      marketDataClient: createFinalQuoteMarketDataClient(),
      cacheManager: {
        clearCache: () => {
          cacheClearCalls += 1;
        },
        getPendingOrders: async () => [],
      },
      orderMonitor: createOrderMonitorDouble({
        onTrackOrder: () => {
          trackedOrderCount += 1;
        },
      }),
      orderRecorder: createOrderRecorderDouble(),
      tradingConfig: createTradingConfig(),
      symbolRegistry: createSymbolRegistryDouble(),
      isExecutionAllowed: () => {
        executionGateCalls += 1;
        return false;
      },
      isContinuousTradingAllowed: () => true,
      now: () => executionTime,
      readCurrentTradingDayInfo: () => ({
        dateKey: '2026-07-10',
        info: { isTradingDay: true, isHalfDay: false },
      }),
    } satisfies OrderExecutorTestDeps;
    const illegalSignal = {
      ...createSignal({
        symbol: 'BULL.HK',
        action: 'BUYCALL',
        triggerTimeMs: executionTime.getTime(),
        reason: 'illegal-protective-buy-with-closed-gate',
      }),
      isProtectiveLiquidation: true,
    } as unknown as ExecutableSignal;

    let executionError: unknown = null;
    try {
      await createOrderExecutor(orderExecutorDeps).executeSignals([illegalSignal]);
    } catch (error) {
      executionError = error;
    }

    expect(executionError).toBeInstanceOf(Error);
    if (!(executionError instanceof Error)) {
      throw new Error('expected illegal protective BUY to fail before the execution gate');
    }

    expect(executionError.message).toContain('保护性清仓');

    expect({
      executionGateCalls,
      rateLimiterCalls,
      stockPositionsCalls: tradeContext.getCalls('stockPositions').length,
      submitOrderCalls: tradeContext.getCalls('submitOrder').length,
      cacheClearCalls,
      trackedOrderCount,
    }).toEqual({
      executionGateCalls: 0,
      rateLimiterCalls: 0,
      stockPositionsCalls: 0,
      submitOrderCalls: 0,
      cacheClearCalls: 0,
      trackedOrderCount: 0,
    });
  });

  it('preflights the complete batch before a preceding protective SELL can execute', async () => {
    const executionTime = new Date('2026-07-10T02:00:00.000Z');
    const tradeContext = createTradeContextMock();
    tradeContext.seedStockPositions(
      createStockPositionsResponse({
        symbol: 'BULL.HK',
        quantity: 100,
        availableQuantity: 100,
      }),
    );
    let executionGateCalls = 0;
    let rateLimiterCalls = 0;
    let cacheClearCalls = 0;
    let trackedOrderCount = 0;
    const orderExecutorDeps = {
      ctx: tradeContext as unknown as TradeContext,
      rateLimiter: createRateLimiterDouble(() => {
        rateLimiterCalls += 1;
      }),
      marketDataClient: createFinalQuoteMarketDataClient(),
      cacheManager: {
        clearCache: () => {
          cacheClearCalls += 1;
        },
        getPendingOrders: async () => [],
      },
      orderMonitor: createOrderMonitorDouble({
        onTrackOrder: () => {
          trackedOrderCount += 1;
        },
      }),
      orderRecorder: createOrderRecorderDouble(),
      tradingConfig: createTradingConfig(),
      symbolRegistry: createSymbolRegistryDouble(),
      isExecutionAllowed: () => {
        executionGateCalls += 1;
        return true;
      },
      isContinuousTradingAllowed: () => true,
      now: () => executionTime,
      readCurrentTradingDayInfo: () => ({
        dateKey: '2026-07-10',
        info: { isTradingDay: true, isHalfDay: false },
      }),
    } satisfies OrderExecutorTestDeps;
    const legalProtectiveSell: ProtectiveLiquidationSellSignal = {
      symbol: 'BULL.HK',
      symbolName: 'BULL.HK',
      action: 'SELLCALL',
      seatVersion: 1,
      triggerTime: executionTime,
      quantity: 100,
      reason: 'legal-protective-liquidation-before-invalid-signal',
      isProtectiveLiquidation: true,
    };
    const illegalProtectiveBuy = {
      ...createSignal({
        symbol: 'BULL.HK',
        action: 'BUYCALL',
        triggerTimeMs: executionTime.getTime(),
        reason: 'illegal-protective-buy-after-valid-sell',
      }),
      isProtectiveLiquidation: true,
    } as unknown as ExecutableSignal;

    let executionError: unknown = null;
    try {
      await createOrderExecutor(orderExecutorDeps).executeSignals([
        legalProtectiveSell,
        illegalProtectiveBuy,
      ]);
    } catch (error) {
      executionError = error;
    }

    expect(executionError).toBeInstanceOf(Error);
    if (!(executionError instanceof Error)) {
      throw new Error('expected invalid protective BUY to reject the complete batch');
    }

    expect(executionError.message).toContain('保护性清仓');

    expect({
      executionGateCalls,
      rateLimiterCalls,
      stockPositionsCalls: tradeContext.getCalls('stockPositions').length,
      submitOrderCalls: tradeContext.getCalls('submitOrder').length,
      cacheClearCalls,
      trackedOrderCount,
    }).toEqual({
      executionGateCalls: 0,
      rateLimiterCalls: 0,
      stockPositionsCalls: 0,
      submitOrderCalls: 0,
      cacheClearCalls: 0,
      trackedOrderCount: 0,
    });
  });

  it('does not inspect the ordinary protective-liquidation marker before submitting a doomsday clearance', async () => {
    const executionTime = new Date('2026-07-10T07:56:00.000Z');
    const tradeContext = createTradeContextMock();
    tradeContext.seedStockPositions(
      createStockPositionsResponse({
        symbol: 'BULL.HK',
        quantity: 100,
        availableQuantity: 100,
      }),
    );
    const orderExecutorDeps = {
      ctx: tradeContext as unknown as TradeContext,
      rateLimiter: createRateLimiterDouble(() => {}),
      marketDataClient: createFinalQuoteMarketDataClient(),
      cacheManager: {
        clearCache: () => {},
        getPendingOrders: async () => [],
      },
      orderMonitor: createOrderMonitorDouble({
        onTrackOrder: () => {},
      }),
      orderRecorder: createOrderRecorderDouble(),
      tradingConfig: createTradingConfig(),
      symbolRegistry: createSymbolRegistryDouble(),
      isExecutionAllowed: () => true,
      isContinuousTradingAllowed: () => true,
      now: () => executionTime,
      readCurrentTradingDayInfo: () => ({
        dateKey: '2026-07-10',
        info: { isTradingDay: true, isHalfDay: false },
      }),
    } satisfies OrderExecutorTestDeps;
    const command: DoomsdayClearanceCommand = {
      symbol: 'BULL.HK',
      symbolName: 'BULL.HK',
      action: 'SELLCALL',
      triggerTime: executionTime,
      seatVersion: 1,
    };
    const originalMarkerDescriptor = Object.getOwnPropertyDescriptor(
      Object.prototype,
      'isProtectiveLiquidation',
    );
    Object.defineProperty(Object.prototype, 'isProtectiveLiquidation', {
      configurable: true,
      get: () => {
        if (tradeContext.getCalls('submitOrder').length === 0) {
          throw new Error(
            'doomsday clearance must not enter ordinary protective-liquidation handling before broker submission',
          );
        }

        return false;
      },
    });

    let result: DoomsdayClearanceExecutionResult | null = null;
    let executionError: unknown = null;
    try {
      result = await createOrderExecutor(orderExecutorDeps).executeDoomsdayClearanceSignals([
        command,
      ]);
    } catch (error) {
      executionError = error;
    } finally {
      if (originalMarkerDescriptor) {
        Object.defineProperty(
          Object.prototype,
          'isProtectiveLiquidation',
          originalMarkerDescriptor,
        );
      } else {
        Reflect.deleteProperty(Object.prototype, 'isProtectiveLiquidation');
      }
    }

    expect(executionError).toBeNull();
    expect(result).toEqual({
      executedOrderIds: ['MOCK-000001'],
      awaitingAuthoritativeTerminalSymbols: [],
      unresolvedQuoteSymbols: [],
    });
    expect(tradeContext.getCalls('submitOrder')).toHaveLength(1);
  });

  it('preserves stale protective SELL liquidation type, PL remark, and tracking semantics', async () => {
    const executionTime = new Date('2026-07-10T02:00:00.000Z');
    const tradeContext = createTradeContextMock();
    tradeContext.seedStockPositions(
      createStockPositionsResponse({
        symbol: 'BULL.HK',
        quantity: 100,
        availableQuantity: 100,
      }),
    );
    let rateLimiterCalls = 0;
    const trackedOrders: TrackOrderParams[] = [];
    const orderExecutorDeps = {
      ctx: tradeContext as unknown as TradeContext,
      rateLimiter: createRateLimiterDouble(() => {
        rateLimiterCalls += 1;
      }),
      marketDataClient: createFinalQuoteMarketDataClient(),
      cacheManager: {
        clearCache: () => {},
        getPendingOrders: async () => [],
      },
      orderMonitor: createOrderMonitorDouble({
        onTrackOrder: (trackedOrder) => {
          trackedOrders.push(trackedOrder);
        },
      }),
      orderRecorder: createOrderRecorderDouble(),
      tradingConfig: createTradingConfig(),
      symbolRegistry: createSymbolRegistryDouble(),
      isExecutionAllowed: () => true,
      isContinuousTradingAllowed: () => true,
      now: () => executionTime,
      readCurrentTradingDayInfo: () => ({
        dateKey: '2026-07-10',
        info: { isTradingDay: true, isHalfDay: false },
      }),
    } satisfies OrderExecutorTestDeps;
    const protectiveSell: ProtectiveLiquidationSellSignal = {
      symbol: 'BULL.HK',
      symbolName: 'BULL.HK',
      action: 'SELLCALL',
      seatVersion: 1,
      triggerTime: new Date(executionTime.getTime() - 3 * 24 * 60 * 60 * 1000),
      quantity: 100,
      reason: 'valid-protective-liquidation',
      isProtectiveLiquidation: true,
    };

    setSystemTime(executionTime);
    let result: ExecuteSignalsResult;
    try {
      result = await createOrderExecutor(orderExecutorDeps).executeSignals([protectiveSell]);
    } finally {
      setSystemTime();
    }

    expect(result.executedOrderIds).toHaveLength(1);
    expect(rateLimiterCalls).toBe(2);
    expect(tradeContext.getCalls('submitOrder')).toHaveLength(1);
    const [trackedOrder] = trackedOrders;
    if (!trackedOrder) {
      throw new Error('expected protective SELL to be tracked');
    }

    expect(trackedOrder).toMatchObject({
      side: OrderSide.Sell,
      isProtectiveLiquidation: true,
      orderType: OrderType.MO,
    });
    const [submitCall] = tradeContext.getCalls('submitOrder');
    const submittedOptions = submitCall?.args[0];
    if (
      typeof submittedOptions !== 'object' ||
      submittedOptions === null ||
      !('remark' in submittedOptions) ||
      typeof submittedOptions.remark !== 'string'
    ) {
      throw new Error('expected protective SELL broker payload with a PL remark');
    }

    expect(submittedOptions.remark).toContain(TRADING.PROTECTIVE_LIQUIDATION_REMARK_SUFFIX);
  });
});
