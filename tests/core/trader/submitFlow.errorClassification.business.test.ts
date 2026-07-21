/**
 * submitFlow 错误分类业务测试
 *
 * 覆盖最终下单边界按提交阶段区分内部失败、已明确的 broker 业务拒绝、
 * 提交结果不确定以及 broker 接受后的本地同步失败的约束。
 */
import { describe, expect, it } from 'bun:test';
import type { SubmitOrderOptions, SubmitOrderResponse, TradeContext } from 'longbridge';
import { createOrderExecutor } from '../../../src/core/trader/orderExecutor/index.js';
import type { OrderMonitor, TrackOrderParams } from '../../../src/core/trader/types.js';
import { createExternalApiRequestError } from '../../helpers/createExternalApiRequestError.js';
import { logger } from '../../../src/utils/logger/index.js';
import type { Logger } from '../../../src/utils/logger/types.js';
import type {
  OrderRecord,
  OrderRecorder,
  RateLimiter,
  TradeMutationPermit,
} from '../../../src/types/services.js';
import { createMonitorConfig, createTradingConfig } from '../../../mock/factories/configFactory.js';
import { createSignal } from '../../../mock/factories/signalFactory.js';
import { createStockPositionsResponse } from '../../../mock/factories/tradeFactory.js';
import {
  createMarketDataClientDouble,
  createOrderRecorderDouble,
  createQuoteDouble,
  createRiskCheckerDouble,
  createSymbolRegistryDouble,
} from '../../helpers/testDoubles.js';

type SubmitOrderImplementation = (options: SubmitOrderOptions) => Promise<SubmitOrderResponse>;

type SubmitFlowFixtureParams = {
  readonly submitOrder?: SubmitOrderImplementation;
  readonly getQuote?: () => Promise<ReturnType<typeof createQuoteDouble>>;
  readonly clearCache?: () => void;
  readonly trackOrder?: (params: TrackOrderParams) => void;
  readonly orderRecorder?: OrderRecorder;
  readonly targetNotional?: number;
};

function createMutationRateLimiter(): RateLimiter {
  return {
    throttle: async () => {},
    withTradeMutation: async <T>(
      callback: (permit: TradeMutationPermit) => Promise<T>,
    ): Promise<T> => {
      let invoked = false;
      const permit: TradeMutationPermit = {
        invoke: async <TResult>(operation: () => Promise<TResult>): Promise<TResult> => {
          if (invoked) {
            throw new Error('mutation permit invoked more than once');
          }

          invoked = true;
          return operation();
        },
      };

      return callback(permit);
    },
  };
}

function createOrderMonitorDouble(trackOrder: (params: TrackOrderParams) => void): OrderMonitor {
  return {
    initialize: async () => {},
    onOrderStateChanged: () => () => {},
    trackOrder,
    cancelOrder: async () => ({
      kind: 'CANCEL_CONFIRMED',
      closedReason: 'CANCELED',
      source: 'API',
      relatedBuyOrderIds: null,
    }),
    replaceOrderPrice: async () => ({ kind: 'BROKER_CONFIRMED' }),
    replaceOrderPriceWithPermit: async () => ({ kind: 'BROKER_CONFIRMED' }),
    startRuntime: () => {},
    stopRuntimeAndDrain: async () => {},
    recoverOrderTrackingFromSnapshot: async () => {},
    getPendingSellOrders: () => [],
    hasPendingProtectiveLiquidationOrders: () => false,
    clearTrackedOrders: () => {},
  } as unknown as OrderMonitor;
}

function createSubmitFlowFixture(params: SubmitFlowFixtureParams = {}) {
  let submitCallCount = 0;
  const trackedOrders: TrackOrderParams[] = [];
  const getQuote = params.getQuote ?? (async () => createQuoteDouble('BULL.HK', 5, 100));
  const orderRecorder =
    params.orderRecorder ??
    createOrderRecorderDouble({
      getLatestBuyOrderPrice: () => null,
      getBuyOrdersForSymbol: () => [],
      submitSellOrder: () => {},
    });
  const ctx = {
    submitOrder: async (options: SubmitOrderOptions): Promise<SubmitOrderResponse> => {
      submitCallCount += 1;
      if (params.submitOrder) {
        return params.submitOrder(options);
      }

      return { orderId: 'ORDER-1' } as unknown as SubmitOrderResponse;
    },
    stockPositions: async () =>
      createStockPositionsResponse({
        symbol: 'BULL.HK',
        quantity: 100,
        availableQuantity: 100,
      }),
  } as unknown as TradeContext;
  const executor = createOrderExecutor({
    ctx,
    rateLimiter: createMutationRateLimiter(),
    marketDataClient: createMarketDataClientDouble({
      getQuotes: async (symbols) => {
        expect([...symbols]).toEqual(['BULL.HK']);
        const quote = await getQuote();
        return new Map([['BULL.HK', quote]]);
      },
    }),
    cacheManager: {
      clearCache: params.clearCache ?? (() => {}),
      getPendingOrders: async () => [],
    },
    orderMonitor: createOrderMonitorDouble((trackParams) => {
      trackedOrders.push(trackParams);
      params.trackOrder?.(trackParams);
    }),
    orderRecorder,
    unrealizedLossBuyGate: createRiskCheckerDouble(),
    tradingConfig: createTradingConfig({
      monitor: createMonitorConfig({ targetNotional: params.targetNotional ?? 5_000 }),
    }),
    symbolRegistry: createSymbolRegistryDouble(),
    isExecutionAllowed: () => true,
    isContinuousTradingAllowed: () => true,
    now: () => new Date('2026-07-10T02:00:00.000Z'),
    readCurrentTradingDayInfo: () => ({
      dateKey: '2026-07-10',
      info: { isTradingDay: true, isHalfDay: false },
    }),
  });

  return {
    executor,
    submitCallCount: () => submitCallCount,
    trackedOrders,
  };
}

function createBuySignal() {
  return createSignal({
    symbol: 'BULL.HK',
    action: 'BUYCALL',
    price: 5,
    lotSize: 100,
    triggerTimeMs: Date.now(),
    reason: 'submit-flow-error-classification',
  });
}

function createSellSignal() {
  return {
    ...createSignal({
      symbol: 'BULL.HK',
      action: 'SELLCALL',
      price: 5,
      lotSize: 100,
      triggerTimeMs: Date.now(),
      reason: 'submit-flow-local-order-record-failure',
    }),
    quantity: 100,
    relatedBuyOrderIds: ['BUY-1'],
  };
}

async function captureRejection(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }

  throw new Error('expected the submit flow to reject');
}

function expectAcceptedLocalSyncFailure(error: unknown, cause: Error): void {
  expect(error).toBeInstanceOf(Error);
  if (!(error instanceof Error)) {
    throw new Error('expected an Error instance');
  }

  expect(error.name).toBe('AcceptedOrderLocalSyncError');
  expect(Reflect.get(error, 'orderId')).toBe('ORDER-1');
  expect(error.cause).toBe(cause);
}

describe('submitFlow staged error classification', () => {
  it('throws the invalid targetNotional TypeError instead of treating it as a skipped order', async () => {
    const fixture = createSubmitFlowFixture({ targetNotional: 0 });

    const error = await captureRejection(() =>
      fixture.executor.executeSignals([createBuySignal()]),
    );

    expect(error).toBeInstanceOf(TypeError);
    expect(fixture.submitCallCount()).toBe(0);
  });

  it('throws a plain final-quote subscription failure instead of treating it as a skipped order', async () => {
    const quoteError = new Error('quote subscription failed');
    const fixture = createSubmitFlowFixture({
      getQuote: async () => {
        throw quoteError;
      },
    });

    const error = await captureRejection(() =>
      fixture.executor.executeSignals([createBuySignal()]),
    );

    expect(error).toBe(quoteError);
    expect(fixture.submitCallCount()).toBe(0);
  });

  it('throws a typed local-sync failure when cache invalidation fails after broker acceptance', async () => {
    const localFailure = new Error('cache invalidation failed');
    const fixture = createSubmitFlowFixture({
      clearCache: () => {
        throw localFailure;
      },
    });

    const error = await captureRejection(() =>
      fixture.executor.executeSignals([createBuySignal()]),
    );

    expectAcceptedLocalSyncFailure(error, localFailure);
    expect(fixture.submitCallCount()).toBe(1);
  });

  it('throws a typed local-sync failure when order tracking fails after broker acceptance', async () => {
    const localFailure = new Error('order tracking failed');
    const fixture = createSubmitFlowFixture({
      trackOrder: () => {
        throw localFailure;
      },
    });

    const error = await captureRejection(() =>
      fixture.executor.executeSignals([createBuySignal()]),
    );

    expectAcceptedLocalSyncFailure(error, localFailure);
    expect(fixture.submitCallCount()).toBe(1);
  });

  it('throws a typed local-sync failure when sell-order recording fails after broker acceptance', async () => {
    const localFailure = new Error('sell order recording failed');
    const buyRecord: OrderRecord = {
      orderId: 'BUY-1',
      symbol: 'BULL.HK',
      executedPrice: 5,
      executedQuantity: 100,
      executedTime: Date.now(),
      submittedAt: undefined,
      updatedAt: undefined,
    };
    const fixture = createSubmitFlowFixture({
      orderRecorder: createOrderRecorderDouble({
        getLatestBuyOrderPrice: () => null,
        getBuyOrdersForSymbol: () => [buyRecord],
        submitSellOrder: () => {
          throw localFailure;
        },
      }),
    });

    const error = await captureRejection(() =>
      fixture.executor.executeSignals([createSellSignal()]),
    );

    expectAcceptedLocalSyncFailure(error, localFailure);
    expect(fixture.submitCallCount()).toBe(1);
  });

  it('logs and skips an explicit structured broker business rejection, including one carried by the API wrapper', async () => {
    const brokerRejection = await createExternalApiRequestError({
      operation: 'TradeContext.submitOrder',
      attempts: 1,
      cause: Object.assign(new Error('broker denied the order'), { code: 601011 }),
    });
    const fixture = createSubmitFlowFixture({
      submitOrder: async () => {
        throw brokerRejection;
      },
    });
    const errorLogs: string[] = [];
    const originalErrorLogger = logger.error;
    logger.error = ((message: string) => {
      errorLogs.push(message);
    }) satisfies Logger['error'];

    try {
      const result = await fixture.executor.executeSignals([createBuySignal()]);
      expect(result).toEqual({
        executedOrderIds: [],
      });
      expect(errorLogs).toHaveLength(1);
      expect(fixture.submitCallCount()).toBe(1);
    } finally {
      logger.error = originalErrorLogger;
    }
  });

  it('throws an unconfirmed submit failure rather than silently treating it as a broker rejection', async () => {
    const unconfirmedSubmission = await createExternalApiRequestError({
      operation: 'TradeContext.submitOrder',
      attempts: 1,
      cause: new Error('submission outcome is unknown'),
    });
    const fixture = createSubmitFlowFixture({
      submitOrder: async () => {
        throw unconfirmedSubmission;
      },
    });

    const error = await captureRejection(() =>
      fixture.executor.executeSignals([createBuySignal()]),
    );

    expect(error).toBe(unconfirmedSubmission);
    expect(fixture.submitCallCount()).toBe(1);
  });

  it('throws an unstructured broker submit failure because its outcome is not confirmed', async () => {
    const unconfirmedSubmission = new Error('broker submit outcome is unknown');
    const fixture = createSubmitFlowFixture({
      submitOrder: async () => {
        throw unconfirmedSubmission;
      },
    });

    const error = await captureRejection(() =>
      fixture.executor.executeSignals([createBuySignal()]),
    );

    expect(error).toBe(unconfirmedSubmission);
    expect(fixture.submitCallCount()).toBe(1);
  });
});
