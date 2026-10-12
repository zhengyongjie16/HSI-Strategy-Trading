/**
 * submitFlow 错误分类业务测试
 *
 * 覆盖最终下单边界按提交阶段区分内部失败、已明确的 broker 业务拒绝、
 * 提交结果不确定以及 broker 接受后的本地同步失败的约束。
 */
import { describe, expect, it } from 'bun:test';
import { createSubmitFlowFailureFixture } from '../../infrastructure/longbridge/trade/submitFlowFailureFixture.js';
import { createOrderExecutor } from '../../../src/core/trader/orderExecutor/index.js';
import type { OrderMonitor, TrackOrderParams } from '../../../src/core/trader/types.js';
import { createExternalApiRequestError } from '../../helpers/createExternalApiRequestError.js';
import { logger } from '../../../src/utils/logger/index.js';
import type { Logger } from '../../../src/utils/logger/types.js';
import type { OrderRecord, OrderRecorder, RawOrderFromAPI } from '../../../src/types/services.js';
import { createMonitorConfig, createTradingConfig } from '../../../mock/factories/configFactory.js';
import { createSignal } from '../../../mock/factories/signalFactory.js';
import {
  createMarketDataClientDouble,
  createOrderMonitorDouble,
  createOrderRecorderDouble,
  createRateLimiterDouble,
  createQuoteDouble,
  createRiskCheckerDouble,
  createSymbolRegistryDouble,
} from '../../helpers/testDoubles.js';

const EXECUTION_NOW_MS = Date.parse('2026-07-10T02:00:00.000Z');

type SubmitFlowFixtureParams = {
  readonly submitOrder?: Parameters<typeof createSubmitFlowFailureFixture>[0];
  readonly getQuote?: () => Promise<ReturnType<typeof createQuoteDouble>>;
  readonly clearCache?: () => void;
  readonly trackOrder?: (params: TrackOrderParams) => void;
  readonly orderRecorder?: OrderRecorder;
  readonly targetNotional?: string;
  readonly orderMonitor?: Partial<OrderMonitor>;
};

function createOrderMonitorForSubmitFlow(
  trackOrder: (params: TrackOrderParams) => void,
  overrides: Partial<OrderMonitor> = {},
): ReturnType<typeof createOrderMonitorDouble> {
  return createOrderMonitorDouble({
    trackOrder,
    replaceOrderPriceWithPermit: async () => ({ kind: 'BROKER_CONFIRMED' }),
    ...overrides,
  });
}

function createSubmitFlowFixture(params: SubmitFlowFixtureParams = {}) {
  const native = createSubmitFlowFailureFixture(params.submitOrder);
  const trackedOrders: TrackOrderParams[] = [];
  const getQuote = params.getQuote ?? (async () => createQuoteDouble('BULL.HK', '5', 100));
  const orderRecorder =
    params.orderRecorder ??
    createOrderRecorderDouble({
      getLatestBuyOrderCost: () => null,
      getBuyOrdersForSymbol: () => [],
      submitSellOrder: () => {},
    });
  const executor = createOrderExecutor({
    tradeMutationPort: native.tradeMutationPort,
    readSellPositions: native.readSellPositions,
    rateLimiter: createRateLimiterDouble(),
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
    orderMonitor: createOrderMonitorForSubmitFlow((trackParams) => {
      trackedOrders.push(trackParams);
      params.trackOrder?.(trackParams);
    }, params.orderMonitor),
    orderRecorder,
    unrealizedLossBuyGate: createRiskCheckerDouble(),
    tradingConfig: createTradingConfig({
      monitor: createMonitorConfig({ targetNotional: params.targetNotional ?? '5000' }),
    }),
    symbolRegistry: createSymbolRegistryDouble(),
    isExecutionAllowed: () => true,
    isContinuousTradingAllowed: () => true,
    now: () => new Date(EXECUTION_NOW_MS),
    readCurrentTradingDayInfo: () => ({
      dateKey: '2026-07-10',
      info: { isTradingDay: true, isHalfDay: false },
    }),
  });

  return {
    executor,
    submitCallCount: native.submitCallCount,
    trackedOrders,
  };
}

function createBuySignal() {
  return createSignal({
    symbol: 'BULL.HK',
    action: 'BUYCALL',
    triggerTimeMs: EXECUTION_NOW_MS,
    reason: 'submit-flow-error-classification',
  });
}

function createSellSignal() {
  return {
    ...createSignal({
      symbol: 'BULL.HK',
      action: 'SELLCALL',
      triggerTimeMs: EXECUTION_NOW_MS,
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
  it('drains every issued cancel before exposing the original internal failure and never submits a replacement', async () => {
    const observations = ['SELL-A', 'SELL-B'].map((orderId): RawOrderFromAPI => ({
      orderId,
      symbol: 'BULL.HK',
      stockName: 'BULL',
      remark: '',
      executionSide: 'SELL',
      executionPhase: 'OPEN',
      executionStatus: 'NONE',
      status: 'WORKING',
      orderType: 'LO',
      quantity: 100,
      executedQuantity: 0,
      price: '5',
      executedPrice: '0',
      executedAmount: '0',
      submittedAt: new Date(EXECUTION_NOW_MS),
      executionTimeMs: null,
      updatedAtMs: EXECUTION_NOW_MS,
      updatedAt: new Date(EXECUTION_NOW_MS),
    }));
    const originalFailure = new TypeError('original cancel failure');
    let settleSibling: () => void = () => {
      throw new Error('cancel sibling was not issued');
    };
    let issued = 0;
    let errorExposed = false;
    const sibling = new Promise<void>((resolve) => {
      settleSibling = resolve;
    });
    const fixture = createSubmitFlowFixture({
      orderMonitor: {
        getPendingSellOrders: () =>
          observations.map((fact) => ({
            orderId: fact.orderId,
            symbol: fact.symbol,
            side: fact.executionSide,
            submittedQuantity: fact.quantity,
            executedQuantity: fact.executedQuantity,
            status: fact.status,
            orderType: fact.orderType,
            submittedPrice: fact.price,
            submittedAt: EXECUTION_NOW_MS,
            isProtectiveLiquidation: false,
          })),
        cancelOrder: async (orderId) => {
          issued++;
          if (orderId === 'SELL-A') throw originalFailure;

          await sibling;
          return { kind: 'CANCEL_CONFIRMED', relatedBuyOrderIds: null };
        },
      },
    });
    const work = fixture.executor
      .executeSignals([createSellSignal()], () => true)
      .catch((error: unknown) => {
        errorExposed = true;
        throw error;
      });
    for (let i = 0; i < 30 && issued < 2; i++) await Promise.resolve();

    expect(issued).toBe(2);
    expect(errorExposed).toBeFalse();
    expect(fixture.submitCallCount()).toBe(0);
    settleSibling();
    expect(await captureRejection(() => work)).toBe(originalFailure);
    expect(fixture.submitCallCount()).toBe(0);
  });

  it('rejects SDK decimal capacity loss before the native submit stage without UNKNOWN classification', async () => {
    const fixture = createSubmitFlowFixture({
      getQuote: async () =>
        createQuoteDouble('BULL.HK', '1.0000000000000000000000000000000000000001', 100),
    });
    const error = await captureRejection(() =>
      fixture.executor.executeSignals([createBuySignal()], () => true),
    );
    expect(error).toBeInstanceOf(RangeError);
    expect(fixture.submitCallCount()).toBe(0);
    expect(fixture.trackedOrders).toHaveLength(0);
  });

  it('does not issue native submit when the original caller is invalidated during the final quote', async () => {
    let originalCallerCurrent = true;
    const callerAuthorization = () => originalCallerCurrent;
    const fixture = createSubmitFlowFixture({
      getQuote: async () => {
        await Promise.resolve();
        originalCallerCurrent = false;
        return createQuoteDouble('BULL.HK', '5', 100);
      },
    });
    expect(await fixture.executor.executeSignals([createBuySignal()], callerAuthorization)).toEqual(
      {
        executedOrderIds: [],
      },
    );
    expect(fixture.submitCallCount()).toBe(0);
    expect(fixture.trackedOrders).toHaveLength(0);
  });

  it('retains an accepted native order ID when the original caller becomes stale after issuance', async () => {
    let originalCallerCurrent = true;
    const fixture = createSubmitFlowFixture({
      submitOrder: async () => {
        originalCallerCurrent = false;
        return { orderId: 'ORDER-1' };
      },
    });
    expect(
      await fixture.executor.executeSignals([createBuySignal()], () => originalCallerCurrent),
    ).toEqual({
      executedOrderIds: ['ORDER-1'],
    });
    expect(fixture.submitCallCount()).toBe(1);
    expect(fixture.trackedOrders).toHaveLength(1);
  });

  it('throws the invalid targetNotional TypeError instead of treating it as a skipped order', async () => {
    const fixture = createSubmitFlowFixture({ targetNotional: '0' });

    const error = await captureRejection(() =>
      fixture.executor.executeSignals([createBuySignal()], () => true),
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
      fixture.executor.executeSignals([createBuySignal()], () => true),
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
      fixture.executor.executeSignals([createBuySignal()], () => true),
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
      fixture.executor.executeSignals([createBuySignal()], () => true),
    );

    expectAcceptedLocalSyncFailure(error, localFailure);
    expect(fixture.submitCallCount()).toBe(1);
  });

  it('throws a typed local-sync failure when sell-order recording fails after broker acceptance', async () => {
    const localFailure = new Error('sell order recording failed');
    const buyRecord: OrderRecord = {
      orderId: 'BUY-1',
      symbol: 'BULL.HK',
      costAmount: '500',
      executedQuantity: 100,
      executedTime: Date.now(),
      submittedAt: undefined,
      updatedAt: undefined,
    };
    const fixture = createSubmitFlowFixture({
      orderRecorder: createOrderRecorderDouble({
        getLatestBuyOrderCost: () => null,
        getBuyOrdersForSymbol: () => [buyRecord],
        submitSellOrder: () => {
          throw localFailure;
        },
      }),
    });

    const error = await captureRejection(() =>
      fixture.executor.executeSignals([createSellSignal()], () => true),
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
      const result = await fixture.executor.executeSignals([createBuySignal()], () => true);
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
      fixture.executor.executeSignals([createBuySignal()], () => true),
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
      fixture.executor.executeSignals([createBuySignal()], () => true),
    );

    expect(error).toBe(unconfirmedSubmission);
    expect(fixture.submitCallCount()).toBe(1);
  });
});
