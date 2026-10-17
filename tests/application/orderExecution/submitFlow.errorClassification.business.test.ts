import { spyOn, describe, expect, it } from 'bun:test';
import { createDiagnosticObserverDouble } from '../../helpers/diagnostics.js';
import { DIAGNOSTIC_OPERATIONS } from '../../../src/constants/diagnostics.js';
import type { DiagnosticFields, DiagnosticObserver } from '../../../src/types/diagnostics.js';
import {
  createLoggerDouble,
  createMarketDataClientDouble,
  createOrderMonitorDouble,
  createOrderRecorderDouble,
  createRateLimiterDouble,
  createQuoteDouble,
  createRiskCheckerDouble,
  createSymbolRegistryDouble,
} from '../../helpers/testDoubles.js';

/**
 * submitFlow 错误分类业务测试
 *
 * 覆盖最终下单边界按提交阶段区分内部失败、已明确的 broker 业务拒绝、
 * 提交结果不确定以及 broker 接受后的本地同步失败的约束。
 */

import { createSubmitFlowFailureFixture } from '../../infrastructure/longbridge/trade/submitFlowFailureFixture.js';
import { createOrderExecutor } from '../../../src/application/orderExecution/index.js';
import type { OrderExecutionTrackingPort } from '../../../src/application/orderExecution/types.js';
import type { TrackOrderParams } from '../../../src/domain/order/types.js';
import { createExternalApiRequestError } from '../../helpers/createExternalApiRequestError.js';
import { isExternalApiRequestError } from '../../../src/utils/apiFailure/index.js';
import type {
  TradeMutationPort,
  TradeSubmitCommand,
} from '../../../src/types/tradeMutationPorts.js';
import { logger } from '../../../src/infrastructure/logger/index.js';
import type { Logger } from '../../../src/types/logger.js';
import type { OrderRecord, OrderRecorder } from '../../../src/types/orderRecorder.js';
import type { OrderFact } from '../../../src/types/trade.js';
import { createMonitorConfig, createTradingConfig } from '../../../mock/factories/configFactory.js';
import { createSignal } from '../../../mock/factories/signalFactory.js';

const EXECUTION_NOW_MS = Date.parse('2026-07-10T02:00:00.000Z');

type SubmitFlowFixtureParams = {
  readonly logger?: Logger;
  readonly diagnostics?: DiagnosticObserver;
  readonly submitOrder?: Parameters<typeof createSubmitFlowFailureFixture>[0];
  readonly getQuote?: () => Promise<ReturnType<typeof createQuoteDouble>>;
  readonly clearCache?: () => void;
  readonly trackOrder?: (params: TrackOrderParams) => void;
  readonly orderRecorder?: OrderRecorder;
  readonly targetNotional?: string;
  readonly orderMonitor?: Partial<OrderExecutionTrackingPort>;
  readonly submitMutation?: TradeMutationPort['submitOrder'];
  readonly nowMs?: number;
};

function createOrderMonitorForSubmitFlow(
  trackOrder: (params: TrackOrderParams) => void,
  overrides: Partial<OrderExecutionTrackingPort> = {},
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
  const submittedCommands: TradeSubmitCommand[] = [];
  const getQuote = params.getQuote ?? (async () => createQuoteDouble('BULL.HK', '5', 100));
  const orderRecorder =
    params.orderRecorder ??
    createOrderRecorderDouble({
      getLatestBuyOrderCost: () => null,
      getBuyOrdersForSymbol: () => [],
      submitSellOrder: () => {},
    });
  const executor = createOrderExecutor({
    logger: params.logger ?? createLoggerDouble(),
    diagnostics: params.diagnostics ?? createDiagnosticObserverDouble(),
    tradeMutationPort: {
      ...native.tradeMutationPort,
      submitOrder: async (command, onRemoteIssued) => {
        submittedCommands.push(command);
        return (params.submitMutation ?? native.tradeMutationPort.submitOrder)(
          command,
          onRemoteIssued,
        );
      },
    },
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
    now: () => new Date(params.nowMs ?? EXECUTION_NOW_MS),
    readCurrentTradingDayInfo: () => ({
      dateKey: '2026-07-10',
      info: { isTradingDay: true, isHalfDay: false },
    }),
  });

  return {
    executor,
    submitCallCount: native.submitCallCount,
    trackedOrders,
    submittedCommands,
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

  expect(error).toMatchObject({
    name: 'AcceptedOrderLocalSyncError',
    operation: 'TradeContext.submitOrder',
    requestAttempted: true,
    orderId: 'ORDER-1',
  });
  expect(error.cause).toBe(cause);
  expect(isExternalApiRequestError(error)).toBe(false);
}

describe('submitFlow staged error classification', () => {
  it('drains every issued cancel before exposing the original internal failure and never submits a replacement', async () => {
    const observations = ['SELL-A', 'SELL-B'].map((orderId): OrderFact => ({
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
        quoteFailures: [],
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
        return {
          kind: 'ACCEPTED' as const,
          operation: 'TradeContext.submitOrder' as const,
          requestAttempted: true as const,
          orderId: 'ORDER-1',
        };
      },
    });
    expect(
      await fixture.executor.executeSignals([createBuySignal()], () => originalCallerCurrent),
    ).toEqual({
      executedOrderIds: ['ORDER-1'],
      quoteFailures: [],
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
      logger,
      submitOrder: async () => {
        throw brokerRejection;
      },
    });
    const errorLogs: string[] = [];
    const originalErrorLogger = logger.error;
    spyOn(logger, 'error').mockImplementation(((message: string) => {
      errorLogs.push(message);
    }) satisfies Logger['error']);

    try {
      const result = await fixture.executor.executeSignals([createBuySignal()], () => true);
      expect(result).toEqual({
        executedOrderIds: [],
        quoteFailures: [],
      });
      expect(errorLogs).toHaveLength(1);
      expect(fixture.submitCallCount()).toBe(1);
    } finally {
      spyOn(logger, 'error').mockImplementation(originalErrorLogger);
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

    expect(error).toMatchObject({
      name: 'TradeMutationUnknownError',
      operation: 'TradeContext.submitOrder',
      requestAttempted: true,
      code: null,
    });
    expect(error).toHaveProperty('cause', unconfirmedSubmission);
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

    expect(error).toMatchObject({
      name: 'TradeMutationUnknownError',
      operation: 'TradeContext.submitOrder',
      requestAttempted: true,
      code: null,
    });
    expect(error).toHaveProperty('cause', unconfirmedSubmission);
    expect(fixture.submitCallCount()).toBe(1);
  });
});

/** application 只消费 port 的标签；原 SDK cause 仅为诊断证据，不能重新分类命令。 */
describe('submitFlow neutral mutation boundary', () => {
  it('keeps UNKNOWN fatal despite a rejection-looking cause and a stale original caller', async () => {
    let current = true;
    let attempts = 0;
    const cause = Object.assign(new Error('openapi error: code=601011'), { code: 601011 });
    const records: Array<{ readonly operation: string; readonly fields: DiagnosticFields }> = [];
    const fixture = createSubmitFlowFixture({
      diagnostics: {
        record: (operation, fields) => {
          records.push({ operation, fields });
          throw new Error('diagnostic failure must not replace UNKNOWN fatal');
        },
      },
      submitMutation: async (_command, onRemoteIssued) => {
        onRemoteIssued();
        attempts += 1;
        current = false;
        return {
          kind: 'UNKNOWN',
          operation: 'TradeContext.submitOrder',
          requestAttempted: true,
          code: '601011',
          cause,
        };
      },
    });
    const error = await captureRejection(() =>
      fixture.executor.executeSignals([createBuySignal()], () => current),
    );
    expect(error).toMatchObject({
      name: 'TradeMutationUnknownError',
      operation: 'TradeContext.submitOrder',
      requestAttempted: true,
      code: '601011',
    });
    expect(error).toHaveProperty('cause', cause);
    expect(isExternalApiRequestError(error)).toBe(false);
    expect(attempts).toBe(1);
    expect(fixture.trackedOrders).toEqual([]);
    expect(records).toEqual([
      {
        operation: DIAGNOSTIC_OPERATIONS.ORDER_SUBMIT_UNKNOWN_FATAL,
        fields: {
          symbol: 'BULL.HK',
          side: 'BUY',
          purpose: 'ORDINARY_BUY',
          orderType: 'ELO',
          sdkOperation: 'TradeContext.submitOrder',
          requestAttempted: true,
          code: '601011',
          count: 1,
        },
      },
    ]);
    expect(records[0]?.fields['orderId']).toBeUndefined();
  });

  it('skips an explicit REJECTED label without parsing its cause or tracking a nonexistent order', async () => {
    let attempts = 0;
    const fixture = createSubmitFlowFixture({
      submitMutation: async (_command, onRemoteIssued) => {
        onRemoteIssued();
        attempts += 1;
        return {
          kind: 'REJECTED',
          operation: 'TradeContext.submitOrder',
          requestAttempted: true,
          code: '601013',
          cause: new Error('network timeout; text is diagnostic only'),
        };
      },
    });
    expect(await fixture.executor.executeSignals([createBuySignal()], () => true)).toEqual({
      executedOrderIds: [],
      quoteFailures: [],
    });
    expect(attempts).toBe(1);
    expect(fixture.trackedOrders).toEqual([]);
  });
});

/** 七种目的必须由明确入口、动作或结构化用例来源构造，不读取自由 reason/remark。 */
describe('order command purpose provenance', () => {
  const ordinaryBuy = createBuySignal();
  const ordinarySell = { ...createSellSignal(), relatedBuyOrderIds: null };
  for (const [signal, purpose] of [
    [{ ...ordinaryBuy, reason: '自动换标-移仓买入' }, 'ORDINARY_BUY'],
    [{ ...ordinarySell, reason: '牛熊证距回收价触发清仓|PL' }, 'ORDINARY_SELL'],
    [{ ...ordinarySell, executionOrigin: 'SWITCH_MOVE' }, 'SWITCH_MOVE'],
    [{ ...ordinaryBuy, executionOrigin: 'SWITCH_REBUY' }, 'SWITCH_REBUY'],
    [{ ...ordinarySell, isProtectiveLiquidation: true }, 'PROTECTIVE_LIQUIDATION'],
    [
      { ...ordinarySell, executionOrigin: 'STATIC_DISTANCE_LIQUIDATION' },
      'STATIC_DISTANCE_LIQUIDATION',
    ],
  ] as const) {
    it(`submits ${purpose} from its explicit new-command facts`, async () => {
      const fixture = createSubmitFlowFixture();
      expect(await fixture.executor.executeSignals([signal], () => true)).toEqual({
        executedOrderIds: ['ORDER-1'],
        quoteFailures: [],
      });
      expect(fixture.submittedCommands).toMatchObject([{ purpose }]);
      expect(fixture.trackedOrders).toMatchObject([
        { isProtectiveLiquidation: purpose === 'PROTECTIVE_LIQUIDATION' },
      ]);
      expect(fixture.submitCallCount()).toBe(1);
    });
  }

  it('submits DOOMSDAY_CLEARANCE only through the dedicated takeover entry', async () => {
    const nowMs = Date.parse('2026-07-10T07:57:00.000Z');
    const fixture = createSubmitFlowFixture({ nowMs });
    const result = await fixture.executor.executeDoomsdayClearanceSignals(
      [
        {
          symbol: 'BULL.HK',
          symbolName: 'BULL',
          action: 'SELLCALL',
          triggerTime: new Date(nowMs),
          seatVersion: 1,
        },
      ],
      () => true,
    );
    expect(result.executedOrderIds).toEqual(['ORDER-1']);
    expect(fixture.submittedCommands).toMatchObject([
      { purpose: 'DOOMSDAY_CLEARANCE', side: 'SELL' },
    ]);
    expect(fixture.trackedOrders).toMatchObject([{ isProtectiveLiquidation: false }]);
    expect(fixture.submitCallCount()).toBe(1);
  });

  it('rejects inconsistent or unknown source facts before any mutation in the batch', async () => {
    for (const [baseSignal, executionOrigin] of [
      [ordinaryBuy, 'SWITCH_MOVE'],
      [ordinarySell, 'SWITCH_REBUY'],
      [ordinaryBuy, 'STATIC_DISTANCE_LIQUIDATION'],
      [ordinarySell, 'UNKNOWN'],
      [{ ...ordinarySell, isProtectiveLiquidation: true }, 'SWITCH_MOVE'],
    ] as const) {
      const signal = { ...baseSignal };
      Reflect.set(signal, 'executionOrigin', executionOrigin);
      const fixture = createSubmitFlowFixture();
      const error = await captureRejection(() =>
        fixture.executor.executeSignals([ordinaryBuy, signal], () => true),
      );
      expect(error).toBeInstanceOf(TypeError);
      expect(fixture.submittedCommands).toEqual([]);
      expect(fixture.submitCallCount()).toBe(0);
      expect(fixture.trackedOrders).toEqual([]);
    }
  });
});
