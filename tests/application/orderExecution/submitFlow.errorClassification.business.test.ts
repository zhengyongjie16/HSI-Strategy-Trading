import { spyOn, describe, expect, it } from 'bun:test';
import { createDiagnosticObserverDouble } from '../../helpers/diagnostics.js';
import { DIAGNOSTIC_OPERATIONS } from '../../../src/constants/diagnostics.js';
import type { DiagnosticFields, DiagnosticObserver } from '../../../src/types/diagnostics.js';
import {
  createLoggerDouble,
  createMarketDataClientDouble,
  createOrderMonitorDouble,
  createOrderRecorderDouble,
  createPositionDouble,
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
import type {
  OrderExecutionTrackingPort,
  OrderExecutorDeps,
} from '../../../src/application/orderExecution/types.js';
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
  readonly getQuote?: () => Promise<ReturnType<typeof createQuoteDouble> | null>;
  readonly clearCache?: () => void;
  readonly trackOrder?: (params: TrackOrderParams) => void;
  readonly orderRecorder?: OrderRecorder;
  readonly targetNotional?: string;
  readonly orderMonitor?: Partial<OrderExecutionTrackingPort>;
  readonly submitMutation?: TradeMutationPort['submitOrder'];
  readonly nowMs?: number;
  readonly isExecutionAllowed?: () => boolean;
  readonly now?: () => Date;
  readonly readSellPositions?: OrderExecutorDeps['readSellPositions'];
  readonly rateLimiter?: OrderExecutorDeps['rateLimiter'];
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
    readSellPositions: params.readSellPositions ?? native.readSellPositions,
    rateLimiter: params.rateLimiter ?? createRateLimiterDouble(),
    marketDataClient: createMarketDataClientDouble({
      getQuotes: async (symbols) => {
        expect([...symbols]).toEqual(['BULL.HK']);
        const quote = await getQuote();
        return quote === null ? new Map() : new Map([['BULL.HK', quote]]);
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
    isExecutionAllowed: params.isExecutionAllowed ?? (() => true),
    isContinuousTradingAllowed: () => true,
    now: params.now ?? (() => new Date(params.nowMs ?? EXECUTION_NOW_MS)),
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
            submittedQuantity: fact.quantity,
            executedQuantity: fact.executedQuantity,
            status: fact.status,
            orderType: fact.orderType,
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
  it.each([false, true])(
    'keeps UNKNOWN fatal despite a rejection-looking cause and a stale original caller (throwing observer: %s)',
    async (throwingObserver) => {
      let current = true;
      let attempts = 0;
      const cause = Object.assign(new Error('openapi error: code=601011'), { code: 601011 });
      const records: Array<{ readonly operation: string; readonly fields: DiagnosticFields }> = [];
      const fixture = createSubmitFlowFixture({
        diagnostics: {
          record: (operation, fields) => {
            records.push({ operation, fields });
            if (throwingObserver)
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
            stage: 'submitOrder.brokerResult',
            outcome: 'UNKNOWN',
            reasonCode: 'BROKER_SUBMIT_UNKNOWN',
            symbol: 'BULL.HK',
            action: 'BUYCALL',
            seatVersion: 1,
            triggerTimeMs: EXECUTION_NOW_MS,
            mutation: 'SUBMIT',
            localSyncStatus: 'NOT_STARTED',
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
    },
  );

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

/** 数量解析的 0 兼作授权拒绝哨兵；授权恢复后只能报告派生执行结果，不能伪造持仓事实。 */
describe('sell quantity diagnostic sentinel provenance', () => {
  for (const scenario of ['ORDINARY', 'DOOMSDAY', 'SWITCH_MOVE', 'CANCEL_AND_SUBMIT'] as const) {
    it.each(['BEFORE_THROTTLE', 'AFTER_THROTTLE', 'AFTER_POSITION_READ', 'REAL_ZERO'] as const)(
      `${scenario} keeps quantity evidence conservative and business counts unchanged (%s)`,
      async (quantityResult) => {
        const snapshots = [];
        for (const throwingObserver of [false, true]) {
          const records: Array<{ readonly operation: string; readonly fields: DiagnosticFields }> =
            [];
          const authorizationResults: boolean[] = [];
          let positionReads = 0;
          let throttleCalls = 0;
          let quoteReads = 0;
          let gateChecks = 0;
          let clockReads = 0;
          let cancelCalls = 0;
          let replaceCalls = 0;
          let mutationPermits = 0;
          const isReplan = scenario === 'CANCEL_AND_SUBMIT';
          const initialAuthorizationCalls = isReplan ? 8 : 3;
          const denialOffsets = {
            BEFORE_THROTTLE: 1,
            AFTER_THROTTLE: 2,
            AFTER_POSITION_READ: 3,
            REAL_ZERO: 0,
          };
          const denyAuthorizationAt = initialAuthorizationCalls + denialOffsets[quantityResult];
          const nowMs =
            scenario === 'DOOMSDAY' ? Date.parse('2026-07-10T07:57:00.000Z') : EXECUTION_NOW_MS;
          const fixture = createSubmitFlowFixture({
            diagnostics: {
              record: (operation, fields) => {
                records.push({ operation, fields });
                if (throwingObserver) throw new Error('observer unavailable');
              },
            },
            isExecutionAllowed: () => {
              gateChecks += 1;
              return true;
            },
            now: () => {
              clockReads += 1;
              return new Date(nowMs);
            },
            rateLimiter: createRateLimiterDouble({
              onThrottle: () => {
                throttleCalls += 1;
              },
              onMutationPermitAcquired: () => {
                mutationPermits += 1;
              },
            }),
            readSellPositions: async () => {
              positionReads += 1;
              const isTargetRead = !isReplan || positionReads === 2;
              const availableQuantity = quantityResult === 'REAL_ZERO' && isTargetRead ? 0 : 100;
              return [
                createPositionDouble({ symbol: 'BULL.HK', quantity: 100, availableQuantity }),
              ];
            },
            getQuote: async () => {
              quoteReads += 1;
              return createQuoteDouble('BULL.HK', '5', 100);
            },
            orderMonitor: {
              getPendingSellOrders: () =>
                isReplan && cancelCalls === 0
                  ? [
                      {
                        orderId: 'SELL-OLD',
                        status: 'WORKING',
                        orderType: 'ELO',
                        submittedQuantity: 100,
                        executedQuantity: 0,
                        isProtectiveLiquidation: true,
                        submittedAt: EXECUTION_NOW_MS,
                      },
                    ]
                  : [],
              cancelOrder: async () => {
                cancelCalls += 1;
                return {
                  kind: 'ALREADY_CLOSED',
                  closedReason: 'CANCELED',
                  relatedBuyOrderIds: null,
                  terminalExecution: { submittedQuantity: 100, executedQuantity: 0 },
                };
              },
              replaceOrderPriceWithPermit: async () => {
                replaceCalls += 1;
                return { kind: 'BROKER_CONFIRMED' };
              },
            },
          });
          const callerAuthorization = () => {
            const allowed =
              quantityResult === 'REAL_ZERO' ||
              authorizationResults.length + 1 !== denyAuthorizationAt;
            authorizationResults.push(allowed);
            return allowed;
          };
          const signal = {
            ...createSellSignal(),
            relatedBuyOrderIds: null,
            ...(scenario === 'SWITCH_MOVE' ? { executionOrigin: 'SWITCH_MOVE' as const } : {}),
          };
          const result =
            scenario === 'DOOMSDAY'
              ? await fixture.executor.executeDoomsdayClearanceSignals(
                  [
                    {
                      symbol: 'BULL.HK',
                      symbolName: 'BULL',
                      action: 'SELLCALL',
                      triggerTime: new Date(nowMs),
                      seatVersion: 1,
                    },
                  ],
                  callerAuthorization,
                )
              : await fixture.executor.executeSignals([signal], callerAuthorization);
          const expectedQuantityAuthorizationCalls = quantityResult === 'BEFORE_THROTTLE' ? 2 : 4;
          const expectedTotalAuthorizationCalls =
            quantityResult === 'AFTER_THROTTLE'
              ? initialAuthorizationCalls + 3
              : initialAuthorizationCalls + expectedQuantityAuthorizationCalls;
          expect(authorizationResults).toHaveLength(expectedTotalAuthorizationCalls);
          expect(authorizationResults.filter((allowed) => !allowed)).toHaveLength(
            quantityResult === 'REAL_ZERO' ? 0 : 1,
          );
          if (quantityResult !== 'REAL_ZERO') {
            expect(authorizationResults[denyAuthorizationAt - 1]).toBe(false);
            expect(authorizationResults[denyAuthorizationAt]).toBe(true);
          }

          const expectedThrottleCalls =
            (isReplan ? 1 : 0) + (quantityResult === 'BEFORE_THROTTLE' ? 0 : 1);
          const expectedPositionReads =
            (isReplan ? 1 : 0) +
            (quantityResult === 'AFTER_POSITION_READ' || quantityResult === 'REAL_ZERO' ? 1 : 0);
          expect(throttleCalls).toBe(expectedThrottleCalls);
          expect(positionReads).toBe(expectedPositionReads);
          expect(gateChecks).toBe(
            expectedTotalAuthorizationCalls +
              (isReplan ? 1 : 0) +
              (quantityResult === 'REAL_ZERO' ? 2 : 1),
          );
          const expectedClockReads =
            expectedTotalAuthorizationCalls -
            (quantityResult === 'REAL_ZERO' ? 0 : 1) -
            (scenario === 'DOOMSDAY' ? 1 : 0);
          expect(clockReads).toBe(expectedClockReads);
          expect(cancelCalls).toBe(isReplan ? 1 : 0);
          expect(replaceCalls).toBe(0);
          expect(quoteReads).toBe(0);
          expect(mutationPermits).toBe(0);
          expect(fixture.submitCallCount()).toBe(0);
          expect(fixture.submittedCommands).toEqual([]);
          expect(fixture.trackedOrders).toEqual([]);
          if (scenario === 'DOOMSDAY') {
            expect(result).toEqual({
              executedOrderIds: [],
              reevaluationSymbols: [],
              unresolvedQuoteSymbols: [],
            });
          } else if (scenario === 'SWITCH_MOVE') {
            expect(result).toEqual({
              executedOrderIds: [],
              quoteFailures: [],
              sellDecisionResults: [{ signal, kind: 'NO_AVAILABLE_QUANTITY' }],
            });
          } else {
            expect(result).toEqual({ executedOrderIds: [], quoteFailures: [] });
          }

          expect(records).toHaveLength(quantityResult === 'REAL_ZERO' ? 1 : 2);
          const summary = records.at(-1);
          expect(summary?.operation).toBe(DIAGNOSTIC_OPERATIONS.ORDER_EXECUTION_OUTCOME);
          const initialQuantityStage =
            scenario === 'DOOMSDAY'
              ? 'submitDoomsdayClearanceSell.quantity'
              : 'submitTargetOrder.quantity';
          expect(summary?.fields).toMatchObject({
            stage: isReplan ? 'cancelAndSubmit.quantity' : initialQuantityStage,
            outcome: isReplan ? 'BLOCKED' : 'SKIPPED',
            reasonCode: isReplan ? 'SELL_REPLAN_UNTRUSTED' : 'NO_POSITIVE_EXECUTABLE_QUANTITY',
            mutation: 'SUBMIT',
          });

          for (const record of records) {
            expect(record.fields).not.toHaveProperty('quantity');
            expect(record.fields).not.toHaveProperty('availableQuantity');
            expect(record.fields).not.toHaveProperty('requestAttempted');
            expect(record.fields['reasonCode']).not.toBe('NO_AVAILABLE_QUANTITY');
          }

          snapshots.push({
            result,
            authorizationResults,
            positionReads,
            throttleCalls,
            quoteReads,
            gateChecks,
            clockReads,
            cancelCalls,
            replaceCalls,
            mutationPermits,
            records,
          });
        }

        expect(snapshots[0]).toEqual(snapshots[1]);
      },
    );
  }
});

/** 诊断只观察真实分支；正常与故障 observer 不改变订单、原票、时钟与 fatal。 */
describe('shared execution passive outcome diagnostics', () => {
  it('keeps business results, native submit count, authorization and clock reads identical with a throwing observer', async () => {
    const snapshots = [];
    for (const throwingObserver of [false, true]) {
      const records: DiagnosticFields[] = [];
      const events: string[] = [];
      let callerChecks = 0;
      let gateChecks = 0;
      let clockReads = 0;
      const fixture = createSubmitFlowFixture({
        diagnostics: {
          record: (operation, fields) => {
            expect(operation).toBe(DIAGNOSTIC_OPERATIONS.ORDER_EXECUTION_OUTCOME);
            records.push(fields);
            events.push(String(fields['outcome']));
            if (throwingObserver) throw new Error('observer unavailable');
          },
        },
        clearCache: () => {
          events.push('clearCache');
        },
        trackOrder: () => {
          events.push('trackOrder');
        },
        isExecutionAllowed: () => {
          gateChecks += 1;
          return true;
        },
        now: () => {
          clockReads += 1;
          return new Date(EXECUTION_NOW_MS);
        },
        getQuote: async () => createQuoteDouble('BULL.HK', '0.12345678901234567890123456', 100),
      });
      const result = await fixture.executor.executeSignals(
        [{ ...createBuySignal(), quantity: 100 }],
        () => {
          callerChecks += 1;
          return true;
        },
      );
      expect(events).toEqual([
        'BROKER_ACCEPTED',
        'clearCache',
        'trackOrder',
        'LOCAL_SYNC_SUCCEEDED',
      ]);
      expect(records.filter((fields) => fields['outcome'] === 'BROKER_ACCEPTED')).toHaveLength(1);
      expect(records[0]).toMatchObject({
        stage: 'submitOrder.brokerResult',
        outcome: 'BROKER_ACCEPTED',
        reasonCode: 'BROKER_ACCEPTED',
        symbol: 'BULL.HK',
        action: 'BUYCALL',
        seatVersion: 1,
        triggerTimeMs: EXECUTION_NOW_MS,
        mutation: 'SUBMIT',
        orderId: 'ORDER-1',
        requestAttempted: true,
        localSyncStatus: 'PENDING',
        price: '0.12345678901234567890123456',
        quantity: '100',
      });

      snapshots.push({
        result,
        nativeCalls: fixture.submitCallCount(),
        commands: fixture.submittedCommands,
        tracked: fixture.trackedOrders,
        records,
        callerChecks,
        gateChecks,
        clockReads,
      });
    }

    expect(snapshots[0]).toEqual(snapshots[1]);
    expect(snapshots[0]).toMatchObject({
      result: { executedOrderIds: ['ORDER-1'], quoteFailures: [] },
      nativeCalls: 1,
    });
  });

  it.each([false, true])(
    'preserves initial caller/gate short circuit (throwing observer: %s)',
    async (throwingObserver) => {
      for (const callerAuthorized of [false, true]) {
        const records: DiagnosticFields[] = [];
        let callerChecks = 0;
        let gateChecks = 0;
        let clockReads = 0;
        const fixture = createSubmitFlowFixture({
          diagnostics: {
            record: (_operation, fields) => {
              records.push(fields);
              if (throwingObserver) throw new Error('observer unavailable');
            },
          },
          isExecutionAllowed: () => {
            gateChecks += 1;
            return false;
          },
          now: () => {
            clockReads += 1;
            return new Date(EXECUTION_NOW_MS);
          },
        });
        expect(
          await fixture.executor.executeSignals([createBuySignal()], () => {
            callerChecks += 1;
            return callerAuthorized;
          }),
        ).toEqual({ executedOrderIds: [], quoteFailures: [] });
        expect(callerChecks).toBe(1);
        expect(gateChecks).toBe(callerAuthorized ? 1 : 0);
        expect(clockReads).toBe(0);
        expect(fixture.submitCallCount()).toBe(0);
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
          stage: 'executeSignals',
          outcome: 'BLOCKED',
          reasonCode: callerAuthorized ? 'EXECUTION_GATE_CLOSED' : 'CALLER_AUTHORIZATION_INVALID',
        });
        expect(records[0]).not.toHaveProperty('requestAttempted');
      }
    },
  );

  it.each([false, true])(
    'records final authorization from the original evaluation without replaying it (throwing observer: %s)',
    async (throwingObserver) => {
      for (const failedBoundary of ['CALLER', 'GATE']) {
        const records: DiagnosticFields[] = [];
        let quoteReturned = false;
        let callerChecks = 0;
        let gateChecks = 0;
        let clockReads = 0;
        const fixture = createSubmitFlowFixture({
          diagnostics: {
            record: (_operation, fields) => {
              records.push(fields);
              if (throwingObserver) throw new Error('observer unavailable');
            },
          },
          getQuote: async () => {
            quoteReturned = true;
            return createQuoteDouble('BULL.HK', '5', 100);
          },
          isExecutionAllowed: () => {
            gateChecks += 1;
            return failedBoundary !== 'GATE' || !quoteReturned;
          },
          now: () => {
            clockReads += 1;
            return new Date(EXECUTION_NOW_MS);
          },
        });
        expect(
          await fixture.executor.executeSignals([createBuySignal()], () => {
            callerChecks += 1;
            return failedBoundary !== 'CALLER' || !quoteReturned;
          }),
        ).toEqual({ executedOrderIds: [], quoteFailures: [] });
        expect(callerChecks).toBe(5);
        expect(gateChecks).toBe(failedBoundary === 'CALLER' ? 7 : 8);
        expect(clockReads).toBe(4);
        expect(fixture.submitCallCount()).toBe(0);
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
          stage: 'submitOrder.beforeApi',
          outcome: 'BLOCKED',
          reasonCode:
            failedBoundary === 'CALLER' ? 'CALLER_AUTHORIZATION_INVALID' : 'EXECUTION_GATE_CLOSED',
        });
        expect(records[0]).not.toHaveProperty('requestAttempted');
      }
    },
  );

  it.each([false, true])(
    'does not infer an attempted broker request from adapter entry or onRemoteIssued (throwing observer: %s)',
    async (throwingObserver) => {
      const records: DiagnosticFields[] = [];
      let current = true;
      let adapterCalls = 0;
      let callerChecks = 0;
      let gateChecks = 0;
      const fixture = createSubmitFlowFixture({
        diagnostics: {
          record: (_operation, fields) => {
            records.push(fields);
            if (throwingObserver) throw new Error('observer unavailable');
          },
        },
        isExecutionAllowed: () => {
          gateChecks += 1;
          return true;
        },
        submitMutation: async (_command, onRemoteIssued) => {
          adapterCalls += 1;
          current = false;
          onRemoteIssued();
          throw new Error('invalid original authorization must abort before the remote request');
        },
      });
      expect(
        await fixture.executor.executeSignals([createBuySignal()], () => {
          callerChecks += 1;
          return current;
        }),
      ).toEqual({ executedOrderIds: [], quoteFailures: [] });
      expect(adapterCalls).toBe(1);
      expect(fixture.submitCallCount()).toBe(0);
      expect(callerChecks).toBe(9);
      expect(gateChecks).toBe(11);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        stage: 'submitOrder.beforeApi',
        outcome: 'BLOCKED',
        reasonCode: 'CALLER_AUTHORIZATION_INVALID',
      });
      expect(records[0]).not.toHaveProperty('requestAttempted');
    },
  );

  it.each(['clearCache', 'trackOrder', 'submitSellOrder'] as const)(
    'records accepted before %s failure and preserves the typed fatal and orderId',
    async (failurePoint) => {
      for (const throwingObserver of [false, true]) {
        const records: DiagnosticFields[] = [];
        const events: string[] = [];
        const localFailure = new Error('original local sync failure');
        const fail = () => {
          events.push(failurePoint);
          throw localFailure;
        };
        const fixture = createSubmitFlowFixture({
          diagnostics: {
            record: (_operation, fields) => {
              records.push(fields);
              events.push(String(fields['outcome']));
              if (throwingObserver) throw new Error('observer unavailable');
            },
          },
          clearCache: failurePoint === 'clearCache' ? fail : () => {},
          trackOrder: failurePoint === 'trackOrder' ? fail : () => {},
          ...(failurePoint === 'submitSellOrder'
            ? {
                orderRecorder: createOrderRecorderDouble({
                  getBuyOrdersForSymbol: () => [
                    {
                      orderId: 'BUY-1',
                      symbol: 'BULL.HK',
                      costAmount: '500',
                      executedQuantity: 100,
                      executedTime: EXECUTION_NOW_MS,
                    },
                  ],
                  submitSellOrder: fail,
                }),
              }
            : {}),
        });
        const error = await captureRejection(() =>
          fixture.executor.executeSignals(
            [failurePoint === 'submitSellOrder' ? createSellSignal() : createBuySignal()],
            () => true,
          ),
        );
        expectAcceptedLocalSyncFailure(error, localFailure);
        expect(events).toEqual(['BROKER_ACCEPTED', failurePoint, 'ACCEPTED_LOCAL_SYNC_FAILED']);
        expect(records).toHaveLength(2);
        expect(records[0]).toMatchObject({
          outcome: 'BROKER_ACCEPTED',
          orderId: 'ORDER-1',
          localSyncStatus: 'PENDING',
        });
        expect(records[1]).toMatchObject({
          stage: 'submitOrder.localSync',
          outcome: 'ACCEPTED_LOCAL_SYNC_FAILED',
          orderId: 'ORDER-1',
          requestAttempted: true,
          localSyncStatus: 'FAILED',
        });
        expect(fixture.submitCallCount()).toBe(1);
      }
    },
  );

  it.each([false, true])(
    'isolates quantity field formatting failures without changing accepted results or fatal (local failure: %s)',
    async (failLocalSync) => {
      const localFailure = new Error('original tracking failure');
      let attempts = 0;
      const fixture = createSubmitFlowFixture({
        trackOrder: () => {
          if (failLocalSync) throw localFailure;
        },
        submitMutation: async (_command, onRemoteIssued) => {
          onRemoteIssued();
          attempts += 1;
          return {
            kind: 'ACCEPTED',
            operation: 'TradeContext.submitOrder',
            requestAttempted: true,
            orderId: 'ORDER-1',
          };
        },
      });
      const formatter = spyOn(Number.prototype, 'toString').mockImplementation(() => {
        throw new Error('diagnostic financial formatting failed');
      });
      let error: unknown;
      let result: unknown;
      try {
        if (failLocalSync) {
          error = await captureRejection(() =>
            fixture.executor.executeSignals([createBuySignal()], () => true),
          );
        } else {
          result = await fixture.executor.executeSignals([createBuySignal()], () => true);
        }
      } finally {
        formatter.mockRestore();
      }

      if (failLocalSync) expectAcceptedLocalSyncFailure(error, localFailure);
      else expect(result).toEqual({ executedOrderIds: ['ORDER-1'], quoteFailures: [] });

      expect(attempts).toBe(1);
      expect(fixture.trackedOrders).toHaveLength(1);
    },
  );

  it.each([false, true])(
    'records replacement only as confirmation of the old order (throwing observer: %s)',
    async (throwingObserver) => {
      const records: DiagnosticFields[] = [];
      const replacedIds: string[] = [];
      const fixture = createSubmitFlowFixture({
        diagnostics: {
          record: (_operation, fields) => {
            records.push(fields);
            if (throwingObserver) throw new Error('observer unavailable');
          },
        },
        orderMonitor: {
          getPendingSellOrders: () => [
            {
              orderId: 'SELL-OLD',
              status: 'WORKING',
              orderType: 'LO',
              submittedQuantity: 100,
              executedQuantity: 0,
              isProtectiveLiquidation: false,
              submittedAt: EXECUTION_NOW_MS,
            },
          ],
          replaceOrderPriceWithPermit: async (orderId) => {
            replacedIds.push(orderId);
            return { kind: 'BROKER_CONFIRMED' };
          },
        },
      });
      expect(
        await fixture.executor.executeSignals(
          [{ ...createSellSignal(), relatedBuyOrderIds: null, orderTypeOverride: 'LO' }],
          () => true,
        ),
      ).toEqual({ executedOrderIds: ['SELL-OLD'], quoteFailures: [] });
      expect(replacedIds).toEqual(['SELL-OLD']);
      expect(fixture.submitCallCount()).toBe(0);
      expect(fixture.trackedOrders).toEqual([]);
      expect(records).toEqual([
        {
          stage: 'replaceOrder.result',
          outcome: 'REPLACED',
          reasonCode: 'REPLACE_BROKER_CONFIRMED',
          symbol: 'BULL.HK',
          action: 'SELLCALL',
          seatVersion: 1,
          triggerTimeMs: EXECUTION_NOW_MS,
          mutation: 'REPLACE',
          orderId: 'SELL-OLD',
          quantity: '200',
        },
      ]);
      expect(records[0]).not.toHaveProperty('requestAttempted');
      expect(records[0]).not.toHaveProperty('newOrderId');
    },
  );

  it.each([false, true])(
    'records an explicit rejection without accepted facts or retry (throwing observer: %s)',
    async (throwingObserver) => {
      const records: DiagnosticFields[] = [];
      let attempts = 0;
      const fixture = createSubmitFlowFixture({
        diagnostics: {
          record: (_operation, fields) => {
            records.push(fields);
            if (throwingObserver) throw new Error('observer unavailable');
          },
        },
        submitMutation: async (_command, onRemoteIssued) => {
          onRemoteIssued();
          attempts += 1;
          return {
            kind: 'REJECTED',
            operation: 'TradeContext.submitOrder',
            requestAttempted: true,
            code: '601011',
            cause: new Error('rejected'),
          };
        },
      });
      expect(await fixture.executor.executeSignals([createBuySignal()], () => true)).toEqual({
        executedOrderIds: [],
        quoteFailures: [],
      });
      expect(attempts).toBe(1);
      expect(fixture.trackedOrders).toEqual([]);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        stage: 'submitOrder.brokerResult',
        outcome: 'REJECTED',
        reasonCode: 'BROKER_REJECTED',
        mutation: 'SUBMIT',
        requestAttempted: true,
        code: '601011',
      });
      expect(records[0]).not.toHaveProperty('orderId');
    },
  );

  it.each([false, true])(
    'records quote and quantity skips from existing results (throwing observer: %s)',
    async (throwingObserver) => {
      for (const reasonCode of [
        'QUOTE_MISSING',
        'QUOTE_INVALID',
        'NO_SUBMITTABLE_QUANTITY',
      ] as const) {
        const records: DiagnosticFields[] = [];
        const fixture = createSubmitFlowFixture({
          diagnostics: {
            record: (_operation, fields) => {
              records.push(fields);
              if (throwingObserver) throw new Error('observer unavailable');
            },
          },
          getQuote: async () => {
            if (reasonCode === 'QUOTE_MISSING') return null;

            return createQuoteDouble('BULL.HK', reasonCode === 'QUOTE_INVALID' ? '0' : '5', 100);
          },
        });
        const signal = {
          ...createBuySignal(),
          ...(reasonCode === 'NO_SUBMITTABLE_QUANTITY' ? { quantity: 1 } : {}),
        };
        const result = await fixture.executor.executeSignals([signal], () => true);
        expect(result.executedOrderIds).toEqual([]);
        expect(result.quoteFailures.map((failure) => failure.kind)).toEqual(
          reasonCode === 'NO_SUBMITTABLE_QUANTITY' ? [] : [reasonCode],
        );
        expect(fixture.submitCallCount()).toBe(0);
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({ outcome: 'SKIPPED', reasonCode, mutation: 'SUBMIT' });
        expect(records[0]).not.toHaveProperty('requestAttempted');
      }
    },
  );

  it('does not claim that a final submit gate prevented prior cancel side effects', async () => {
    const records: DiagnosticFields[] = [];
    let current = true;
    const canceledIds: string[] = [];
    const pending = ['SELL-A', 'SELL-B'].map((orderId) => ({
      orderId,
      status: 'WORKING' as const,
      orderType: 'LO' as const,
      submittedQuantity: 100,
      executedQuantity: 0,
      isProtectiveLiquidation: false,
      submittedAt: EXECUTION_NOW_MS,
    }));
    const fixture = createSubmitFlowFixture({
      diagnostics: {
        record: (_operation, fields) => {
          records.push(fields);
        },
      },
      orderMonitor: {
        getPendingSellOrders: () => (canceledIds.length === 2 ? [] : pending),
        cancelOrder: async (orderId) => {
          canceledIds.push(orderId);
          return {
            kind: 'ALREADY_CLOSED',
            closedReason: 'CANCELED',
            relatedBuyOrderIds: null,
            terminalExecution: { submittedQuantity: 100, executedQuantity: 0 },
          };
        },
      },
      getQuote: async () => {
        current = false;
        return createQuoteDouble('BULL.HK', '5', 100);
      },
    });
    expect(
      await fixture.executor.executeSignals(
        [{ ...createSellSignal(), relatedBuyOrderIds: null }],
        () => current,
      ),
    ).toEqual({ executedOrderIds: [], quoteFailures: [] });
    expect(canceledIds).toEqual(['SELL-A', 'SELL-B']);
    expect(fixture.submitCallCount()).toBe(0);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      stage: 'submitOrder.beforeApi',
      outcome: 'BLOCKED',
      reasonCode: 'CALLER_AUTHORIZATION_INVALID',
    });
    expect(records[0]).not.toHaveProperty('requestAttempted');
    expect(records[0]).not.toHaveProperty('remoteSideEffects');
  });
});
