/**
 * orderMonitor/eventFlow 业务测试
 *
 * 覆盖：
 * - truth 推进后触发 ORDER_EVENT wakeup
 * - timeoutMarketConversionPending 收到终态后写入 terminal snapshot 并显式唤醒 route
 * - 普通终态结算后若同 symbol route 仍存在，会继续触发 ORDER_EVENT wakeup
 * - 未追踪订单的 closed event 不触发 route wakeup
 */

import { describe, expect, it, mock } from 'bun:test';
import { createEventFlow as createProductionEventFlow } from '../../../../src/application/orderTracking/orderMonitor/eventFlow.js';
import type {
  EventFlowDeps,
  FinalizeOrderSettlementParams,
  OrderMonitorRuntimeStore,
} from '../../../../src/application/orderTracking/orderMonitor/types.js';
import { ORDER_MONITOR_WAIT_WS_ONLY_BLOCK_UNTIL_MS } from '../../../../src/constants/index.js';
import type { OrderMonitorTrackedOrder } from '../../../../src/domain/order/types.js';
import type { OrderReadStatus } from '../../../../src/types/orderReadMetadata.js';
import { exactMultiply } from '../../../../src/utils/numeric/exact.js';
import {
  createMonitorConfigDouble,
  createOrderRecorderDouble,
} from '../../../helpers/testDoubles.js';
import { createBrokerIngressFixture } from '../../../integration/architectureRefactoringP1Native/trade/brokerIngressFixture.js';
import { createExecutionFixture } from '../recorder/executionFixture.js';

type TestEventFlowDeps = Omit<EventFlowDeps, 'now' | 'monitorConfig'> &
  Partial<Pick<EventFlowDeps, 'now' | 'monitorConfig'>>;

type NativePushFixture = Awaited<ReturnType<typeof createBrokerIngressFixture>>;
type NativePushFrame = Readonly<{
  native: NativePushFixture;
  executions: Awaited<ReturnType<NativePushFixture['executionLedgerPort']['todayExecutions']>>;
}>;

function nativeStatus(
  status: OrderReadStatus,
): Parameters<typeof createBrokerIngressFixture>[0]['status'] {
  const names: ReadonlyMap<
    OrderReadStatus,
    Parameters<typeof createBrokerIngressFixture>[0]['status']
  > = new Map([
    ['WORKING', 'New'],
    ['FILLED', 'Filled'],
    ['PARTIALLY_FILLED', 'PartialFilled'],
    ['CANCELED', 'Canceled'],
    ['REJECTED', 'Rejected'],
    ['CANCELLATION_REQUESTED', 'WaitToCancel'],
    ['CANCELLATION_PENDING', 'PendingCancel'],
    ['REPLACED', 'Replaced'],
    ['REPLACEMENT_PENDING', 'PendingReplace'],
  ]);
  const name = names.get(status);
  if (name === undefined)
    throw new TypeError('native frame fixture requires an explicit supported status');

  return name;
}

async function createNativePushFrame(
  input: Readonly<{
    orderId: string;
    symbol: string;
    side: 'BUY' | 'SELL';
    status: OrderReadStatus;
    executedQuantity?: number;
    executedPrice?: string;
    executionTimeMs: number;
    updatedAtMs?: number;
  }>,
): Promise<NativePushFrame> {
  if (!['BUY', 'SELL'].includes(input.side)) {
    throw new TypeError('native frame fixture requires validated BUY or SELL');
  }

  const quantity = input.executedQuantity ?? 0;
  if (!Number.isSafeInteger(quantity) || quantity < 0) {
    throw new TypeError('native frame fixture requires safe nonnegative quantity');
  }

  const price = input.executedPrice ?? '0';
  // Seed the real private DTO with valid facts; negative raw price is installed only on the lazy native callback.
  const native = await createBrokerIngressFixture({
    orderId: input.orderId,
    tradeId: 'FRAME-' + input.orderId,
    symbol: input.symbol,
    stockName: input.symbol,
    remark: '',
    side: input.side,
    orderType: 'ELO',
    status: nativeStatus(input.status),
    quantity: '100',
    executedQuantity: String(Math.min(quantity, 100)),
    submittedPrice: '1',
    executedPrice: quantity > 0 && price === '0' ? '1' : price,
    submittedAtMs: input.updatedAtMs ?? input.executionTimeMs,
    executionTimeMs: input.executionTimeMs,
    updatedAtMs: input.updatedAtMs ?? input.executionTimeMs,
  });
  const executions = await native.executionLedgerPort.todayExecutions({ orderId: input.orderId });
  if (quantity > 0 && price === '0') native.setPushExecutedPriceText(price);

  if (quantity > 100) native.setPushExecutedQuantityText(String(quantity));

  return { native, executions };
}

function createEventFlow(deps: TestEventFlowDeps) {
  const production = createProductionEventFlow({
    now: () => new Date(Date.now()),
    monitorConfig: createMonitorConfigDouble(),
    ...deps,
  });
  function dispatch(frame: NativePushFrame, active: boolean): void {
    let callbacks = 0;
    frame.native.createPushPort().setOnOrderChanged((error, decoder) => {
      callbacks += 1;
      if (error !== null) throw error;

      const readFact = decoder.inspect();
      const known = deps.runtime.trackedOrders.get(readFact.orderId);
      const confirmed =
        known?.lastOrderUpdateAtMs !== undefined &&
        known.lastOrderUpdateAtMs !== null &&
        known.executionPhase !== null
          ? {
              brokerOrderId: known.orderId,
              symbol: known.symbol,
              side: known.executionSide,
              cumulativeQuantity: known.executedQuantity,
              cumulativeAmount: known.executedAmount,
              executionTimeMs: known.lastExecutedTimeMs,
              updatedAtMs: known.lastOrderUpdateAtMs,
              phase: known.executionPhase,
              executedPrice: known.executedPrice,
            }
          : undefined;
      const observation = decoder.decode(frame.executions, confirmed);
      if (active) production.handleOrderChangedWhenActive(observation);
      else production.handleOrderChanged(observation);
    });

    try {
      frame.native.emitOrderChanged();
    } finally {
      expect(callbacks).toBe(1);
      expect(frame.native.nativeMutations()).toEqual([]);
      expect(frame.native.nativeReadCounts()).toEqual({ cancel: 0, detail: 0 });
    }
  }
  return {
    handleOrderChangedWhenActive: (frame: NativePushFrame) => {
      dispatch(frame, true);
    },
    handleOrderChanged: (frame: NativePushFrame) => {
      dispatch(frame, false);
    },
  };
}

mock.module('../../../../src/utils/logger/index.js', () => ({
  logger: {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  },
}));

function createRuntimeStore(): OrderMonitorRuntimeStore {
  return {
    trackedOrders: new Map<string, OrderMonitorTrackedOrder>(),
    trackedOrderLifecycles: new Map(),
    bootstrappingOrderEvents: new Map(),
    closedOrderIds: new Set(),
    queriedTerminalStateByOrderId: new Map(),
    latestReplaceTerminalByOrderId: new Map(),
    orderStateChangedListeners: new Set(),
    trackedOrderIdsBySymbol: new Map(),
    routeStatesBySymbol: new Map(),
    latestRouteGenerationBySymbol: new Map(),
    runtimeState: 'ACTIVE',
    running: true,
    unsubscribeQuoteUpdated: null,
  };
}

async function createTrackedOrder(params: {
  readonly orderId: string;
  readonly symbol: string;
  readonly side: 'BUY' | 'SELL';
  readonly status?: OrderReadStatus;
  readonly timeoutMarketConversionPending?: boolean;
  readonly isProtectiveLiquidation?: boolean;
}): Promise<OrderMonitorTrackedOrder> {
  const now = Date.now();
  if (!['BUY', 'SELL'].includes(params.side)) {
    throw new TypeError('tracked fixture requires a validated BUY or SELL side');
  }

  const originalFrame = await createNativePushFrame({
    orderId: params.orderId,
    symbol: params.symbol,
    side: params.side,
    status: params.status ?? 'WORKING',
    executedQuantity: 0,
    executedPrice: '0',
    executionTimeMs: now,
    updatedAtMs: now,
  });
  const originalFact = originalFrame.native.queryObservation;

  return {
    orderId: params.orderId,
    symbol: params.symbol,
    side: originalFact.executionSide,
    executionSide: originalFact.executionSide,
    executionPhase: originalFact.executionPhase,
    isLongSymbol: true,
    monitorSymbol: 'HSI.HK',
    isProtectiveLiquidation: params.isProtectiveLiquidation ?? false,
    orderType: originalFact.orderType,
    submittedPrice: '1',
    initialSubmittedPrice: '1',
    submittedQuantity: 100,
    executedQuantity: 0,
    executedPrice: null,
    executedAmount: '0',
    lastExecutedTimeMs: null,
    lastOrderUpdateAtMs: null,
    status: originalFact.status,
    submittedAt: now,
    lastPriceUpdateAt: now,
    convertedToMarket: false,
    nextCancelAttemptAt: now,
    cancelRetryCount: 0,
    replaceCapability: 'SUPPORTED',
    replaceBlockedUntilAt: null,
    quoteRetryAttempts: 0,
    quoteRetryNextAt: null,
    quoteRetryExhausted: false,
    replaceTempBlockedCount: 0,
    replaceResumeMode: 'TIME_BACKOFF',
    timeoutMarketConversionPending: params.timeoutMarketConversionPending ?? false,
    timeoutMarketConversionTerminalState: null,
  };
}

describe('orderMonitor eventFlow', () => {
  it.each([
    [
      '成交价',
      (event: NativePushFrame) => {
        event.native.setPushExecutedPriceMissing();
      },
    ],
    [
      '累计成交数量',
      (event: NativePushFrame) => {
        event.native.setPushExecutedQuantityMissing();
      },
    ],
    [
      '原始执行/修订时间',
      (event: NativePushFrame) => {
        event.native.setPushUpdatedAtMs(Number.NaN);
      },
    ],
  ] as const)(
    '保护性 SELL PartialFilled WS 缺少原始%s时不得借用 tracked 事实推进本地状态',
    async (_missingField, removeRawField) => {
      const runtime = createRuntimeStore();
      const trackedOrder = await createTrackedOrder({
        orderId: 'ORDER-PROTECTIVE-RAW-PARTIAL',
        symbol: 'BULL.HK',
        side: 'SELL',
        status: 'PARTIALLY_FILLED',
        isProtectiveLiquidation: true,
      });
      trackedOrder.executedQuantity = 40;
      trackedOrder.executedPrice = '1';
      trackedOrder.executedAmount = exactMultiply(
        trackedOrder.executedPrice,
        String(trackedOrder.executedQuantity),
      );
      trackedOrder.lastExecutedTimeMs = 100;
      trackedOrder.lastOrderUpdateAtMs = 100;
      runtime.trackedOrders.set(trackedOrder.orderId, trackedOrder);
      const partialFills: number[] = [];
      let durableProgressCalls = 0;
      const routeWakeups: Array<{ readonly symbol: string; readonly kind: string }> = [];
      const eventFlow = createEventFlow({
        runtime,
        orderRecorder: createOrderRecorderDouble({
          markSellPartialFilled: (_orderId, filledQuantity) => {
            partialFills.push(filledQuantity);
            return null;
          },
        }),
        recordCumulativeExecution: () => {
          durableProgressCalls += 1;
        },
        prepareProtectiveTerminalExecution: () => null,
        settleOrder: () => ({ handled: false, relatedBuyOrderIds: null }),
        cacheBootstrappingEvent: () => {},
        triggerRoute: (symbol, kind) => {
          routeWakeups.push({ symbol, kind });
        },
      });
      const nativeFrame1 = await createNativePushFrame({
        orderId: trackedOrder.orderId,
        symbol: trackedOrder.symbol,
        side: trackedOrder.side,
        status: 'PARTIALLY_FILLED',
        executedQuantity: 40,
        executedPrice: '1.02',
        updatedAtMs: 200,
        executionTimeMs: 200,
      });
      if (_missingField === '累计成交数量') {
        const getterFrame = await createNativePushFrame({
          orderId: trackedOrder.orderId,
          symbol: trackedOrder.symbol,
          side: trackedOrder.side,
          status: 'PARTIALLY_FILLED',
          executedQuantity: 40,
          executedPrice: '1.02',
          updatedAtMs: 200,
          executionTimeMs: 200,
        });
        const getterError = new Error('original private native quantity getter failure');
        getterFrame.native.setPushExecutedQuantityGetterFailure(getterError);
        let caughtGetterError: unknown;
        try {
          eventFlow.handleOrderChangedWhenActive(getterFrame);
        } catch (error) {
          caughtGetterError = error;
        }

        expect(caughtGetterError).toBe(getterError);
        expect(partialFills).toEqual([]);
        expect(durableProgressCalls).toBe(0);
        expect(routeWakeups).toEqual([]);
      }

      const event = nativeFrame1;
      removeRawField(event);

      let expectedFailure = '[orderMapper] missing SDK cumulative execution quantity';
      if (_missingField === '原始执行/修订时间') {
        expectedFailure = '[orderMapper] invalid updatedAt';
      } else if (_missingField === '成交价') {
        expectedFailure = '[orderMapper] invalid cumulative execution quantity/price';
      }

      expect(() => {
        eventFlow.handleOrderChangedWhenActive(event);
      }).toThrow(expectedFailure);

      expect(trackedOrder).toMatchObject({
        status: 'PARTIALLY_FILLED',
        executedQuantity: 40,
        executedPrice: '1',
        executedAmount: exactMultiply('1', '40'),
        lastExecutedTimeMs: 100,
        lastOrderUpdateAtMs: 100,
      });
      expect(partialFills).toEqual([]);
      expect(durableProgressCalls).toBe(0);
      expect(routeWakeups).toEqual([]);
    },
  );

  it('保护性 SELL PartialFilled WS 的 durable progress 抛错时不得写入 tracked 或 pending sell', async () => {
    const runtime = createRuntimeStore();
    const trackedOrder = await createTrackedOrder({
      orderId: 'ORDER-PROTECTIVE-OPEN-DURABLE-FIRST',
      symbol: 'BULL.HK',
      side: 'SELL',
      isProtectiveLiquidation: true,
    });
    runtime.trackedOrders.set(trackedOrder.orderId, trackedOrder);
    const persistenceError = new Error('protective open progress persistence failed');
    const partialFills: number[] = [];
    const eventFlow = createEventFlow({
      runtime,
      orderRecorder: createOrderRecorderDouble({
        markSellPartialFilled: (_orderId, filledQuantity) => {
          partialFills.push(filledQuantity);
          return null;
        },
      }),
      recordCumulativeExecution: () => {
        throw persistenceError;
      },
      prepareProtectiveTerminalExecution: () => null,
      settleOrder: () => ({ handled: false, relatedBuyOrderIds: null }),
      cacheBootstrappingEvent: () => {},
      triggerRoute: () => {},
    });

    const nativeFrame2 = await createNativePushFrame({
      orderId: trackedOrder.orderId,
      symbol: trackedOrder.symbol,
      side: trackedOrder.side,
      status: 'PARTIALLY_FILLED',
      executedQuantity: 40,
      executedPrice: '1.02',
      updatedAtMs: 200,
      executionTimeMs: 200,
    });
    expect(() => {
      eventFlow.handleOrderChangedWhenActive(nativeFrame2);
    }).toThrow(persistenceError);

    expect(trackedOrder).toMatchObject({
      status: 'WORKING',
      executedQuantity: 0,
      executedPrice: null,
      lastExecutedTimeMs: null,
      lastOrderUpdateAtMs: null,
    });
    expect(partialFills).toEqual([]);
  });

  it('保护性 SELL FILLED WS 的累计成交量超过有效委托量时在任何结算前拒绝', async () => {
    const runtime = createRuntimeStore();
    const trackedOrder = await createTrackedOrder({
      orderId: 'ORDER-PROTECTIVE-FILLED-EXCEEDS-SUBMITTED',
      symbol: 'BULL.HK',
      side: 'SELL',
      isProtectiveLiquidation: true,
    });
    runtime.trackedOrders.set(trackedOrder.orderId, trackedOrder);
    let settlementCalls = 0;
    const eventFlow = createEventFlow({
      runtime,
      orderRecorder: createOrderRecorderDouble(),
      recordCumulativeExecution: () => {},
      prepareProtectiveTerminalExecution: () => null,
      settleOrder: () => {
        settlementCalls += 1;
        return { handled: true, relatedBuyOrderIds: null };
      },
      cacheBootstrappingEvent: () => {},
      triggerRoute: () => {},
    });

    const nativeFrame3 = await createNativePushFrame({
      orderId: trackedOrder.orderId,
      symbol: trackedOrder.symbol,
      side: trackedOrder.side,
      status: 'FILLED',
      executedQuantity: 101,
      executedPrice: '1.02',
      updatedAtMs: 200,
      executionTimeMs: 200,
    });
    expect(() => {
      eventFlow.handleOrderChangedWhenActive(nativeFrame3);
    }).toThrow('[orderMapper] invalid cumulative execution quantity/price');

    expect(trackedOrder.executedQuantity).toBe(0);
    expect(settlementCalls).toBe(0);
  });

  it.each(['CANCELED', 'REJECTED'] as const)(
    '已有部分成交的保护性 SELL 收到 %s WS 零值/缺失终态事实时不得由 tracked 值收口',
    async (terminalStatus) => {
      const runtime = createRuntimeStore();
      const trackedOrder = await createTrackedOrder({
        orderId: 'ORDER-PROTECTIVE-RAW-TERMINAL',
        symbol: 'BULL.HK',
        side: 'SELL',
        status: 'PARTIALLY_FILLED',
        isProtectiveLiquidation: true,
      });
      trackedOrder.executedQuantity = 40;
      trackedOrder.executedPrice = '1.02';
      trackedOrder.executedAmount = exactMultiply(
        trackedOrder.executedPrice,
        String(trackedOrder.executedQuantity),
      );
      trackedOrder.lastExecutedTimeMs = 100;
      trackedOrder.lastOrderUpdateAtMs = 100;
      runtime.trackedOrders.set(trackedOrder.orderId, trackedOrder);
      let settlementCalls = 0;
      const eventFlow = createEventFlow({
        runtime,
        orderRecorder: createOrderRecorderDouble(),
        recordCumulativeExecution: () => {},
        prepareProtectiveTerminalExecution: () => null,
        settleOrder: () => {
          settlementCalls += 1;
          return { handled: true, relatedBuyOrderIds: null };
        },
        cacheBootstrappingEvent: () => {},
        triggerRoute: () => {},
      });
      const nativeFrame4 = await createNativePushFrame({
        orderId: trackedOrder.orderId,
        symbol: trackedOrder.symbol,
        side: trackedOrder.side,
        status: terminalStatus,
        executedQuantity: 0,
        executedPrice: '0',
        updatedAtMs: 200,
        executionTimeMs: 200,
      });
      const terminalEvent = nativeFrame4;
      terminalEvent.native.setPushUpdatedAtMs(Number.NaN);

      expect(() => {
        eventFlow.handleOrderChangedWhenActive(terminalEvent);
      }).toThrow('[orderMapper] invalid updatedAt');

      expect(trackedOrder).toMatchObject({
        status: 'PARTIALLY_FILLED',
        executedQuantity: 40,
        executedPrice: '1.02',
        executedAmount: exactMultiply('1.02', '40'),
        lastExecutedTimeMs: 100,
        lastOrderUpdateAtMs: 100,
      });
      expect(settlementCalls).toBe(0);
    },
  );

  it('does not commit a protective terminal tracked fact before durable settlement succeeds', async () => {
    const runtime = createRuntimeStore();
    const trackedOrder = await createTrackedOrder({
      orderId: 'ORDER-PROTECTIVE-TERMINAL-DURABLE-FIRST',
      symbol: 'BULL.HK',
      side: 'SELL',
      isProtectiveLiquidation: true,
    });
    runtime.trackedOrders.set(trackedOrder.orderId, trackedOrder);
    const persistenceError = new Error('protective progress persistence failed');
    const eventFlow = createEventFlow({
      runtime,
      orderRecorder: createOrderRecorderDouble(),
      recordCumulativeExecution: () => {
        throw new Error('terminal execution must be delegated to settlement');
      },
      prepareProtectiveTerminalExecution: () => null,
      settleOrder: () => {
        throw persistenceError;
      },
      cacheBootstrappingEvent: () => {},
      triggerRoute: () => {},
    });

    const nativeFrame5 = await createNativePushFrame({
      orderId: trackedOrder.orderId,
      symbol: trackedOrder.symbol,
      side: trackedOrder.side,
      status: 'FILLED',
      executedQuantity: 100,
      executedPrice: '1.02',
      updatedAtMs: 200,
      executionTimeMs: 200,
    });
    expect(() => {
      eventFlow.handleOrderChangedWhenActive(nativeFrame5);
    }).toThrow(persistenceError);

    expect(trackedOrder).toMatchObject({
      status: 'WORKING',
      executedQuantity: 0,
      executedPrice: null,
      lastExecutedTimeMs: null,
      lastOrderUpdateAtMs: null,
    });
  });

  it('does not commit a protective timeout terminal snapshot before durable progress succeeds', async () => {
    const runtime = createRuntimeStore();
    const trackedOrder = await createTrackedOrder({
      orderId: 'ORDER-PROTECTIVE-TIMEOUT-DURABLE-FIRST',
      symbol: 'BULL.HK',
      side: 'SELL',
      isProtectiveLiquidation: true,
      timeoutMarketConversionPending: true,
    });
    runtime.trackedOrders.set(trackedOrder.orderId, trackedOrder);
    const persistenceError = new Error('protective timeout progress persistence failed');
    const routeWakeups: Array<{ readonly symbol: string; readonly kind: string }> = [];
    const eventFlow = createEventFlow({
      runtime,
      orderRecorder: createOrderRecorderDouble(),
      recordCumulativeExecution: () => {},
      settleOrder: () => ({ handled: false, relatedBuyOrderIds: null }),
      cacheBootstrappingEvent: () => {},
      triggerRoute: (symbol, kind) => {
        routeWakeups.push({ symbol, kind });
      },
      prepareProtectiveTerminalExecution: () => {
        throw persistenceError;
      },
    });

    const nativeFrame6 = await createNativePushFrame({
      orderId: trackedOrder.orderId,
      symbol: trackedOrder.symbol,
      side: trackedOrder.side,
      status: 'CANCELED',
      executedQuantity: 40,
      executedPrice: '1.02',
      updatedAtMs: 200,
      executionTimeMs: 200,
    });
    expect(() => {
      eventFlow.handleOrderChangedWhenActive(nativeFrame6);
    }).toThrow(persistenceError);

    expect(trackedOrder).toMatchObject({
      status: 'WORKING',
      executedQuantity: 0,
      executedPrice: null,
      lastExecutedTimeMs: null,
      lastOrderUpdateAtMs: null,
      timeoutMarketConversionTerminalState: null,
    });
    expect(routeWakeups).toEqual([]);
  });

  it('保护性 SELL timeout 终态将已准备的 durable progress 写入 route settlement snapshot', async () => {
    const runtime = createRuntimeStore();
    const trackedOrder = await createTrackedOrder({
      orderId: 'ORDER-PROTECTIVE-TIMEOUT-PREPARED-PROGRESS',
      symbol: 'BULL.HK',
      side: 'SELL',
      isProtectiveLiquidation: true,
      timeoutMarketConversionPending: true,
    });
    runtime.trackedOrders.set(trackedOrder.orderId, trackedOrder);
    const persistedPreparationOrderIds: string[] = [];
    const economic = createExecutionFixture({
      nowMs: 200,
      persistProgress: (progress) => {
        persistedPreparationOrderIds.push(progress.orderId);
      },
    });
    const preparedExecution = economic.flow.recordCumulativeExecution({
      factStage: 'TERMINAL',
      orderId: trackedOrder.orderId,
      symbol: trackedOrder.symbol,
      side: trackedOrder.executionSide,
      monitorSymbol: trackedOrder.monitorSymbol,
      isLongSymbol: trackedOrder.isLongSymbol,
      isProtectiveLiquidation: trackedOrder.isProtectiveLiquidation,
      executedPrice: '1.02',
      executedAmount: '40.8',
      executedQuantity: 40,
      executedTimeMs: 200,
      orderUpdatedAtMs: 200,
    });
    expect(persistedPreparationOrderIds).toEqual([trackedOrder.orderId]);
    expect(preparedExecution).toMatchObject({
      authoritativeFactChanged: true,
      executionAdvanced: true,
    });
    const preparationInputs: FinalizeOrderSettlementParams[] = [];
    const routeWakeups: Array<{ readonly symbol: string; readonly kind: string }> = [];
    let settlementCalls = 0;
    const eventFlow = createEventFlow({
      runtime,
      orderRecorder: createOrderRecorderDouble(),
      recordCumulativeExecution: () => {},
      prepareProtectiveTerminalExecution: (params) => {
        preparationInputs.push(params);
        return preparedExecution;
      },
      settleOrder: () => {
        settlementCalls += 1;
        return { handled: true, relatedBuyOrderIds: null };
      },
      cacheBootstrappingEvent: () => {},
      triggerRoute: (symbol, kind) => {
        routeWakeups.push({ symbol, kind });
      },
    });

    const nativeFrame7 = await createNativePushFrame({
      orderId: trackedOrder.orderId,
      symbol: trackedOrder.symbol,
      side: trackedOrder.side,
      status: 'CANCELED',
      executedQuantity: 40,
      executedPrice: '1.02',
      updatedAtMs: 200,
      executionTimeMs: 200,
    });
    eventFlow.handleOrderChangedWhenActive(nativeFrame7);

    expect(preparationInputs).toEqual([
      {
        orderId: trackedOrder.orderId,
        closedReason: 'CANCELED',
        source: 'WS',
        executedPrice: '1.02',
        executedAmount: exactMultiply('1.02', '40'),
        executedQuantity: 40,
        executedTimeMs: 200,
        orderUpdatedAtMs: 200,
      },
    ]);

    expect(trackedOrder.timeoutMarketConversionTerminalState).toMatchObject({
      closedReason: 'CANCELED',
      source: 'WS',
      preparedProtectiveTerminalExecution: preparedExecution,
    });
    expect(settlementCalls).toBe(0);
    expect(routeWakeups).toEqual([{ symbol: 'BULL.HK', kind: 'ORDER_EVENT' }]);
  });

  it('records only live partial execution and delegates an equal-quantity terminal revision to settlement', async () => {
    const runtime = createRuntimeStore();
    const trackedOrder = await createTrackedOrder({
      orderId: 'ORDER-LIVE-PARTIAL',
      symbol: 'BULL.HK',
      side: 'SELL',
      isProtectiveLiquidation: true,
    });
    runtime.trackedOrders.set(trackedOrder.orderId, trackedOrder);
    const cumulativeExecutions: Array<
      Readonly<{ executedQuantity: number; orderUpdatedAtMs: number }>
    > = [];
    const settlements: FinalizeOrderSettlementParams[] = [];
    const eventFlow = createEventFlow({
      runtime,
      orderRecorder: createOrderRecorderDouble(),
      recordCumulativeExecution: (params) => {
        cumulativeExecutions.push({
          executedQuantity: params.executedQuantity ?? -1,
          orderUpdatedAtMs: params.orderUpdatedAtMs ?? -1,
        });
      },
      prepareProtectiveTerminalExecution: () => null,
      settleOrder: (params) => {
        settlements.push(params);
        return { handled: true, relatedBuyOrderIds: null };
      },
      cacheBootstrappingEvent: () => {},
      triggerRoute: () => {},
    });

    const nativeFrame8 = await createNativePushFrame({
      orderId: trackedOrder.orderId,
      symbol: trackedOrder.symbol,
      side: trackedOrder.side,
      status: 'PARTIALLY_FILLED',
      executedQuantity: 40,
      executedPrice: '0.9',
      updatedAtMs: 100,
      executionTimeMs: 100,
    });
    eventFlow.handleOrderChangedWhenActive(nativeFrame8);

    const nativeFrame9 = await createNativePushFrame({
      orderId: trackedOrder.orderId,
      symbol: trackedOrder.symbol,
      side: trackedOrder.side,
      status: 'CANCELED',
      executedQuantity: 40,
      executedPrice: '0.9',
      updatedAtMs: 200,
      executionTimeMs: 100,
    });
    eventFlow.handleOrderChangedWhenActive(nativeFrame9);

    expect(cumulativeExecutions).toEqual([{ executedQuantity: 40, orderUpdatedAtMs: 100 }]);
    expect(settlements).toHaveLength(1);
    expect(settlements[0]).toMatchObject({
      executedQuantity: 40,
      executedTimeMs: 100,
      orderUpdatedAtMs: 200,
    });
    expect(settlements[0]).not.toHaveProperty('hasNewExecution');
  });

  it.each([null, 0] as const)(
    'equal-quantity terminal revision preserves the existing valid price when incoming price is %s',
    async (incomingPrice) => {
      const runtime = createRuntimeStore();
      const trackedOrder = await createTrackedOrder({
        orderId: 'ORDER-EQUAL-QTY-TERMINAL',
        symbol: 'BULL.HK',
        side: 'BUY',
        status: 'PARTIALLY_FILLED',
      });
      trackedOrder.executedQuantity = 40;
      trackedOrder.executedPrice = '1';
      trackedOrder.executedAmount = exactMultiply(
        trackedOrder.executedPrice,
        String(trackedOrder.executedQuantity),
      );
      trackedOrder.lastExecutedTimeMs = 100;
      trackedOrder.lastOrderUpdateAtMs = 100;
      runtime.trackedOrders.set(trackedOrder.orderId, trackedOrder);
      const settlements: FinalizeOrderSettlementParams[] = [];
      const eventFlow = createEventFlow({
        runtime,
        orderRecorder: createOrderRecorderDouble(),
        recordCumulativeExecution: () => {},
        prepareProtectiveTerminalExecution: () => null,
        settleOrder: (params) => {
          settlements.push(params);
          return { handled: true, relatedBuyOrderIds: null };
        },
        cacheBootstrappingEvent: () => {},
        triggerRoute: () => {},
      });

      const nativeFrame10 = await createNativePushFrame({
        orderId: trackedOrder.orderId,
        symbol: trackedOrder.symbol,
        side: trackedOrder.side,
        status: 'FILLED',
        executedQuantity: 40,
        executedPrice: '0',
        updatedAtMs: 200,
        executionTimeMs: 100,
      });
      const terminalEvent = nativeFrame10;
      if (incomingPrice === null) terminalEvent.native.setPushExecutedPriceMissing();
      else terminalEvent.native.setPushExecutedPriceText(String(incomingPrice));

      eventFlow.handleOrderChangedWhenActive(terminalEvent);

      expect(settlements).toEqual([
        {
          orderId: 'ORDER-EQUAL-QTY-TERMINAL',
          closedReason: 'FILLED',
          source: 'WS',
          executedPrice: '1',
          executedAmount: exactMultiply('1', '40'),
          executedQuantity: 40,
          executedTimeMs: 100,
          orderUpdatedAtMs: 200,
        },
      ]);
    },
  );

  it('equal-quantity terminal revision may revise price without advancing execution time', async () => {
    const runtime = createRuntimeStore();
    const trackedOrder = await createTrackedOrder({
      orderId: 'ORDER-EQUAL-QTY-PRICE-REVISION',
      symbol: 'BULL.HK',
      side: 'BUY',
      status: 'PARTIALLY_FILLED',
    });
    trackedOrder.executedQuantity = 40;
    trackedOrder.executedPrice = '1';
    trackedOrder.executedAmount = exactMultiply(
      trackedOrder.executedPrice,
      String(trackedOrder.executedQuantity),
    );
    trackedOrder.lastExecutedTimeMs = 100;
    trackedOrder.lastOrderUpdateAtMs = 100;
    runtime.trackedOrders.set(trackedOrder.orderId, trackedOrder);
    const settlements: FinalizeOrderSettlementParams[] = [];
    const eventFlow = createEventFlow({
      runtime,
      orderRecorder: createOrderRecorderDouble(),
      recordCumulativeExecution: () => {},
      prepareProtectiveTerminalExecution: () => null,
      settleOrder: (params) => {
        settlements.push(params);
        return { handled: true, relatedBuyOrderIds: null };
      },
      cacheBootstrappingEvent: () => {},
      triggerRoute: () => {},
    });

    const nativeFrame11 = await createNativePushFrame({
      orderId: trackedOrder.orderId,
      symbol: trackedOrder.symbol,
      side: trackedOrder.side,
      status: 'FILLED',
      executedQuantity: 40,
      executedPrice: '1.1',
      updatedAtMs: 200,
      executionTimeMs: 100,
    });
    eventFlow.handleOrderChangedWhenActive(nativeFrame11);

    expect(settlements).toMatchObject([
      {
        executedPrice: '1.1',
        executedAmount: exactMultiply('1.1', '40'),
        executedQuantity: 40,
        executedTimeMs: 100,
        orderUpdatedAtMs: 200,
      },
    ]);
  });

  it.each([null, 0] as const)(
    'quantity-advancing terminal revision rejects invalid incoming price %s before settlement side effects',
    async (incomingPrice) => {
      const runtime = createRuntimeStore();
      const trackedOrder = await createTrackedOrder({
        orderId: 'ORDER-ADVANCING-QTY-INVALID-PRICE',
        symbol: 'BULL.HK',
        side: 'SELL',
        status: 'PARTIALLY_FILLED',
        isProtectiveLiquidation: true,
      });
      trackedOrder.executedQuantity = 40;
      trackedOrder.executedPrice = '1';
      trackedOrder.executedAmount = exactMultiply(
        trackedOrder.executedPrice,
        String(trackedOrder.executedQuantity),
      );
      trackedOrder.lastExecutedTimeMs = 100;
      trackedOrder.lastOrderUpdateAtMs = 100;
      runtime.trackedOrders.set(trackedOrder.orderId, trackedOrder);
      let cumulativeExecutionCount = 0;
      let settlementCount = 0;
      const eventFlow = createEventFlow({
        runtime,
        orderRecorder: createOrderRecorderDouble(),
        recordCumulativeExecution: () => {
          cumulativeExecutionCount += 1;
        },
        prepareProtectiveTerminalExecution: () => null,
        settleOrder: () => {
          settlementCount += 1;
          return { handled: true, relatedBuyOrderIds: null };
        },
        cacheBootstrappingEvent: () => {},
        triggerRoute: () => {},
      });
      const nativeFrame12 = await createNativePushFrame({
        orderId: trackedOrder.orderId,
        symbol: trackedOrder.symbol,
        side: trackedOrder.side,
        status: 'FILLED',
        executedQuantity: 100,
        executedPrice: '0',
        updatedAtMs: 200,
        executionTimeMs: 200,
      });
      const terminalEvent = nativeFrame12;
      if (incomingPrice === null) terminalEvent.native.setPushExecutedPriceMissing();
      else terminalEvent.native.setPushExecutedPriceText(String(incomingPrice));

      expect(() => {
        eventFlow.handleOrderChangedWhenActive(terminalEvent);
      }).toThrow('[orderMapper] invalid cumulative execution quantity/price');

      expect(runtime.trackedOrders.get(trackedOrder.orderId)).toMatchObject({
        status: 'PARTIALLY_FILLED',
        executedQuantity: 40,
        executedPrice: '1',
        executedAmount: exactMultiply('1', '40'),
        lastExecutedTimeMs: 100,
        lastOrderUpdateAtMs: 100,
      });
      expect(cumulativeExecutionCount).toBe(0);
      expect(settlementCount).toBe(0);
    },
  );

  it.each([
    ['PARTIALLY_FILLED', 'WORKING', 'PARTIALLY_FILLED'],
    ['CANCELLATION_PENDING', 'WORKING', 'CANCELLATION_PENDING'],
    ['REPLACEMENT_PENDING', 'WORKING', 'WORKING'],
  ] as const)(
    '同 timestamp、同 quantity 的 OPEN 冲突 %s/%s 与到达顺序无关',
    async (leftStatus, rightStatus, expectedStatus) => {
      async function resolveStatus(
        sequence: ReadonlyArray<OrderReadStatus>,
      ): Promise<OrderReadStatus> {
        const runtime = createRuntimeStore();
        const trackedOrder = await createTrackedOrder({
          orderId: 'ORDER-SAME-TIME-CONFLICT',
          symbol: 'BULL.HK',
          side: 'BUY',
          status: 'WORKING',
        });
        runtime.trackedOrders.set(trackedOrder.orderId, trackedOrder);
        const eventFlow = createEventFlow({
          runtime,
          orderRecorder: createOrderRecorderDouble(),
          recordCumulativeExecution: () => {},
          prepareProtectiveTerminalExecution: () => null,
          settleOrder: () => ({ handled: false, relatedBuyOrderIds: null }),
          cacheBootstrappingEvent: () => {},
          triggerRoute: () => {},
        });
        for (const status of sequence) {
          const nativeFrame13 = await createNativePushFrame({
            orderId: trackedOrder.orderId,
            symbol: trackedOrder.symbol,
            side: trackedOrder.side,
            status,
            executedQuantity: 20,
            executedPrice: '1.01',
            updatedAtMs: 200,
            executionTimeMs: 200,
          });
          eventFlow.handleOrderChangedWhenActive(nativeFrame13);
        }

        return trackedOrder.status;
      }

      expect(await resolveStatus([leftStatus, rightStatus])).toBe(expectedStatus);
      expect(await resolveStatus([rightStatus, leftStatus])).toBe(expectedStatus);
    },
  );

  it('较新 timestamp 的 New 不得否认 PartialFilled 成交状态', async () => {
    const runtime = createRuntimeStore();
    const trackedOrder = await createTrackedOrder({
      orderId: 'ORDER-NEWER-REGRESSION',
      symbol: 'BULL.HK',
      side: 'BUY',
      status: 'PARTIALLY_FILLED',
    });
    const knownFrame = await createNativePushFrame({
      orderId: trackedOrder.orderId,
      symbol: trackedOrder.symbol,
      side: trackedOrder.side,
      status: 'PARTIALLY_FILLED',
      executedQuantity: 20,
      executedPrice: '1',
      executionTimeMs: 50,
      updatedAtMs: 100,
    });
    const known = knownFrame.native.queryObservation;
    const economic = createExecutionFixture({
      nowMs: 100,
      createRecorder: knownFrame.native.createRecorder,
    });
    economic.flow.recordCumulativeExecution({
      factStage: known.executionPhase,
      orderId: known.orderId,
      symbol: known.symbol,
      side: known.executionSide,
      monitorSymbol: trackedOrder.monitorSymbol,
      isLongSymbol: trackedOrder.isLongSymbol,
      isProtectiveLiquidation: false,
      executedQuantity: known.executedQuantity,
      executedPrice: known.executedPrice,
      executedAmount: known.executedAmount,
      executedTimeMs: known.executionTimeMs,
      orderUpdatedAtMs: known.updatedAtMs,
    });
    trackedOrder.executedQuantity = known.executedQuantity;
    trackedOrder.executedPrice = known.executedPrice;
    trackedOrder.executedAmount = known.executedAmount;
    trackedOrder.lastExecutedTimeMs = known.executionTimeMs;
    trackedOrder.lastOrderUpdateAtMs = known.updatedAtMs;
    trackedOrder.executionPhase = known.executionPhase;
    runtime.trackedOrders.set(trackedOrder.orderId, trackedOrder);
    let cumulativePublications = 0;
    let settlements = 0;
    const routeWakeups: string[] = [];
    const originalFact = economic.recorder.getExecutionFact(trackedOrder.orderId);
    const originalSnapshotToken = economic.snapshot.getView().token;
    const eventFlow = createEventFlow({
      runtime,
      orderRecorder: economic.recorder,
      recordCumulativeExecution: (params) => {
        cumulativePublications += 1;
        economic.flow.recordCumulativeExecution(params);
      },
      prepareProtectiveTerminalExecution: () => null,
      settleOrder: () => {
        settlements += 1;
        return { handled: false, relatedBuyOrderIds: null };
      },
      cacheBootstrappingEvent: () => {},
      triggerRoute: (symbol) => {
        routeWakeups.push(symbol);
      },
    });

    const nativeFrame14 = await createNativePushFrame({
      orderId: trackedOrder.orderId,
      symbol: trackedOrder.symbol,
      side: trackedOrder.side,
      status: 'WORKING',
      executedQuantity: 20,
      executedPrice: '1',
      updatedAtMs: 200,
      executionTimeMs: 50,
    });
    expect(knownFrame.executions).toMatchObject([
      { orderId: trackedOrder.orderId, quantity: 20, price: '1', tradeDoneAtMs: 50 },
    ]);
    eventFlow.handleOrderChangedWhenActive(nativeFrame14);

    expect(trackedOrder.status).toBe('PARTIALLY_FILLED');
    expect(trackedOrder.lastOrderUpdateAtMs).toBe(100);
    expect(trackedOrder).toMatchObject({
      executedQuantity: 20,
      executedPrice: '1',
      executedAmount: '20',
      lastExecutedTimeMs: 50,
    });
    expect(cumulativePublications).toBe(0);
    expect(settlements).toBe(0);
    expect(routeWakeups).toEqual([]);
    expect(economic.recorder.getExecutionFact(trackedOrder.orderId)).toBe(originalFact);
    expect(economic.snapshot.getView().token).toEqual(originalSnapshotToken);
  });

  it('权威较新 New 会让 PendingCancel 离开撤单暂态并恢复 retry owner', async () => {
    const runtime = createRuntimeStore();
    const injectedNowMs = Date.parse('2031-01-02T03:04:05.000Z');
    const trackedOrder = await createTrackedOrder({
      orderId: 'ORDER-CANCEL-REOPEN-NEW',
      symbol: 'BULL.HK',
      side: 'BUY',
      status: 'CANCELLATION_PENDING',
    });
    trackedOrder.lastOrderUpdateAtMs = 100;
    trackedOrder.nextCancelAttemptAt = ORDER_MONITOR_WAIT_WS_ONLY_BLOCK_UNTIL_MS;
    trackedOrder.cancelRetryCount = 4;
    runtime.trackedOrders.set(trackedOrder.orderId, trackedOrder);
    const eventFlow = createEventFlow({
      now: () => new Date(injectedNowMs),
      runtime,
      orderRecorder: createOrderRecorderDouble(),
      recordCumulativeExecution: () => {},
      prepareProtectiveTerminalExecution: () => null,
      settleOrder: () => ({ handled: false, relatedBuyOrderIds: null }),
      cacheBootstrappingEvent: () => {},
      triggerRoute: () => {},
    });

    const nativeFrame15 = await createNativePushFrame({
      orderId: trackedOrder.orderId,
      symbol: trackedOrder.symbol,
      side: trackedOrder.side,
      status: 'WORKING',
      updatedAtMs: 200,
      executionTimeMs: 200,
    });
    eventFlow.handleOrderChangedWhenActive(nativeFrame15);

    expect(trackedOrder.status).toBe('WORKING');
    expect(trackedOrder.cancelRetryCount).toBe(0);
    expect(trackedOrder.nextCancelAttemptAt).toBe(injectedNowMs);
    expect(injectedNowMs).not.toBe(Date.now());
  });

  it.each([
    ['CANCELLATION_REQUESTED', 'REPLACED', 0],
    ['CANCELLATION_PENDING', 'REPLACED', 0],
    ['CANCELLATION_REQUESTED', 'PARTIALLY_FILLED', 20],
    ['CANCELLATION_PENDING', 'PARTIALLY_FILLED', 20],
  ] as const)(
    '权威较新 OPEN 允许撤单暂态 %s 退出到 %s',
    async (currentStatus, nextStatus, executedQuantity) => {
      const runtime = createRuntimeStore();
      const trackedOrder = await createTrackedOrder({
        orderId: 'ORDER-CANCEL-TRANSIENT-EXIT',
        symbol: 'BULL.HK',
        side: 'BUY',
        status: currentStatus,
      });
      trackedOrder.lastOrderUpdateAtMs = 100;
      runtime.trackedOrders.set(trackedOrder.orderId, trackedOrder);
      const eventFlow = createEventFlow({
        runtime,
        orderRecorder: createOrderRecorderDouble(),
        recordCumulativeExecution: () => {},
        prepareProtectiveTerminalExecution: () => null,
        settleOrder: () => ({ handled: false, relatedBuyOrderIds: null }),
        cacheBootstrappingEvent: () => {},
        triggerRoute: () => {},
      });

      const nativeFrame16 = await createNativePushFrame({
        orderId: trackedOrder.orderId,
        symbol: trackedOrder.symbol,
        side: trackedOrder.side,
        status: nextStatus,
        executedQuantity,
        ...(executedQuantity > 0 ? { executedPrice: '1' } : {}),
        updatedAtMs: 200,
        executionTimeMs: 200,
      });
      eventFlow.handleOrderChangedWhenActive(nativeFrame16);

      expect(trackedOrder.status).toBe(nextStatus);
      expect(trackedOrder.lastOrderUpdateAtMs).toBe(200);
    },
  );

  it('允许 replace 暂态在较新 timestamp 合法回到 New', async () => {
    const runtime = createRuntimeStore();
    const trackedOrder = await createTrackedOrder({
      orderId: 'ORDER-REPLACE-REOPEN',
      symbol: 'BULL.HK',
      side: 'BUY',
      status: 'REPLACEMENT_PENDING',
    });
    trackedOrder.lastOrderUpdateAtMs = 100;
    runtime.trackedOrders.set(trackedOrder.orderId, trackedOrder);
    const eventFlow = createEventFlow({
      runtime,
      orderRecorder: createOrderRecorderDouble(),
      recordCumulativeExecution: () => {},
      prepareProtectiveTerminalExecution: () => null,
      settleOrder: () => ({ handled: false, relatedBuyOrderIds: null }),
      cacheBootstrappingEvent: () => {},
      triggerRoute: () => {},
    });

    const nativeFrame17 = await createNativePushFrame({
      orderId: trackedOrder.orderId,
      symbol: trackedOrder.symbol,
      side: trackedOrder.side,
      status: 'WORKING',
      updatedAtMs: 200,
      executionTimeMs: 200,
    });
    eventFlow.handleOrderChangedWhenActive(nativeFrame17);

    expect(trackedOrder.status).toBe('WORKING');
    expect(trackedOrder.lastOrderUpdateAtMs).toBe(200);
  });

  it('PartialFilled 回退事件携带更大累计成交时仅吸收成交事实并同步 pending-sell', async () => {
    const runtime = createRuntimeStore();
    const trackedOrder = await createTrackedOrder({
      orderId: 'ORDER-CANCEL-WITH-LATE-FILL',
      symbol: 'BULL.HK',
      side: 'SELL',
      status: 'PARTIALLY_FILLED',
    });
    trackedOrder.executedQuantity = 20;
    trackedOrder.lastOrderUpdateAtMs = 100;
    runtime.trackedOrders.set(trackedOrder.orderId, trackedOrder);
    const partialFills: number[] = [];
    const eventFlow = createEventFlow({
      runtime,
      orderRecorder: createOrderRecorderDouble({
        markSellPartialFilled: (_orderId, executedQuantity) => {
          partialFills.push(executedQuantity);
          return null;
        },
      }),
      recordCumulativeExecution: () => {},
      prepareProtectiveTerminalExecution: () => null,
      settleOrder: () => ({ handled: false, relatedBuyOrderIds: null }),
      cacheBootstrappingEvent: () => {},
      triggerRoute: () => {},
    });

    const nativeFrame18 = await createNativePushFrame({
      orderId: trackedOrder.orderId,
      symbol: trackedOrder.symbol,
      side: trackedOrder.side,
      status: 'WORKING',
      executedQuantity: 50,
      executedPrice: '1.02',
      updatedAtMs: 200,
      executionTimeMs: 200,
    });
    eventFlow.handleOrderChangedWhenActive(nativeFrame18);

    expect(trackedOrder.status).toBe('PARTIALLY_FILLED');
    expect(trackedOrder.executedQuantity).toBe(50);
    expect(trackedOrder.lastOrderUpdateAtMs).toBe(200);
    expect(partialFills).toEqual([50]);
  });

  it('ACTIVE 中较旧 WS 事件不能降低累计成交量或 pending-sell 成交事实', async () => {
    const runtime = createRuntimeStore();
    const trackedOrder = await createTrackedOrder({
      orderId: 'ORDER-OUT-OF-ORDER-1',
      symbol: 'BULL.HK',
      side: 'SELL',
      status: 'WORKING',
    });
    runtime.trackedOrders.set(trackedOrder.orderId, trackedOrder);
    const partialFills: number[] = [];
    const eventFlow = createEventFlow({
      runtime,
      orderRecorder: createOrderRecorderDouble({
        markSellPartialFilled: (_orderId, executedQuantity) => {
          partialFills.push(executedQuantity);
          return null;
        },
      }),
      recordCumulativeExecution: () => {},
      prepareProtectiveTerminalExecution: () => null,
      settleOrder: () => ({ handled: false, relatedBuyOrderIds: null }),
      cacheBootstrappingEvent: () => {},
      triggerRoute: () => {},
    });

    const nativeFrame19 = await createNativePushFrame({
      orderId: trackedOrder.orderId,
      symbol: trackedOrder.symbol,
      side: trackedOrder.side,
      status: 'PARTIALLY_FILLED',
      executedQuantity: 50,
      executedPrice: '1.01',
      updatedAtMs: 200,
      executionTimeMs: 200,
    });
    eventFlow.handleOrderChangedWhenActive(nativeFrame19);

    const nativeFrame20 = await createNativePushFrame({
      orderId: trackedOrder.orderId,
      symbol: trackedOrder.symbol,
      side: trackedOrder.side,
      status: 'PARTIALLY_FILLED',
      executedQuantity: 20,
      executedPrice: '1',
      updatedAtMs: 100,
      executionTimeMs: 100,
    });
    eventFlow.handleOrderChangedWhenActive(nativeFrame20);

    expect(trackedOrder.status).toBe('PARTIALLY_FILLED');
    expect(trackedOrder.executedQuantity).toBe(50);
    expect(trackedOrder.executedPrice).toBe('1.01');
    expect(trackedOrder.lastExecutedTimeMs).toBe(200);
    expect(partialFills).toEqual([50]);
  });

  it('相同 timestamp 选择累计成交量更大的事实且重复事件幂等', async () => {
    const runtime = createRuntimeStore();
    const trackedOrder = await createTrackedOrder({
      orderId: 'ORDER-SAME-TIME-1',
      symbol: 'BULL.HK',
      side: 'SELL',
      status: 'WORKING',
    });
    runtime.trackedOrders.set(trackedOrder.orderId, trackedOrder);
    const partialFills: number[] = [];
    const eventFlow = createEventFlow({
      runtime,
      orderRecorder: createOrderRecorderDouble({
        markSellPartialFilled: (_orderId, executedQuantity) => {
          partialFills.push(executedQuantity);
          return null;
        },
      }),
      recordCumulativeExecution: () => {},
      prepareProtectiveTerminalExecution: () => null,
      settleOrder: () => ({ handled: false, relatedBuyOrderIds: null }),
      cacheBootstrappingEvent: () => {},
      triggerRoute: () => {},
    });
    const nativeFrame21 = await createNativePushFrame({
      orderId: trackedOrder.orderId,
      symbol: trackedOrder.symbol,
      side: trackedOrder.side,
      status: 'PARTIALLY_FILLED',
      executedQuantity: 30,
      executedPrice: '1.02',
      updatedAtMs: 200,
      executionTimeMs: 200,
    });
    const strongerEvent = nativeFrame21;

    eventFlow.handleOrderChangedWhenActive(strongerEvent);
    eventFlow.handleOrderChangedWhenActive(strongerEvent);
    const nativeFrame22 = await createNativePushFrame({
      orderId: trackedOrder.orderId,
      symbol: trackedOrder.symbol,
      side: trackedOrder.side,
      status: 'WORKING',
      executedQuantity: 0,
      executedPrice: '0',
      updatedAtMs: 200,
      executionTimeMs: 200,
    });
    eventFlow.handleOrderChangedWhenActive(nativeFrame22);

    expect(trackedOrder.status).toBe('PARTIALLY_FILLED');
    expect(trackedOrder.executedQuantity).toBe(30);
    expect(partialFills).toEqual([30]);
  });

  it('timeout 等待链路一旦收到终态就不能被后续 OPEN 事件回退', async () => {
    const runtime = createRuntimeStore();
    const trackedOrder = await createTrackedOrder({
      orderId: 'ORDER-TERMINAL-NO-REOPEN-1',
      symbol: 'BULL.HK',
      side: 'SELL',
      timeoutMarketConversionPending: true,
    });
    runtime.trackedOrders.set(trackedOrder.orderId, trackedOrder);
    const eventFlow = createEventFlow({
      runtime,
      orderRecorder: createOrderRecorderDouble(),
      recordCumulativeExecution: () => {},
      prepareProtectiveTerminalExecution: () => null,
      settleOrder: () => ({ handled: false, relatedBuyOrderIds: null }),
      cacheBootstrappingEvent: () => {},
      triggerRoute: () => {},
    });

    const nativeFrame23 = await createNativePushFrame({
      orderId: trackedOrder.orderId,
      symbol: trackedOrder.symbol,
      side: trackedOrder.side,
      status: 'CANCELED',
      updatedAtMs: 200,
      executionTimeMs: 200,
    });
    eventFlow.handleOrderChangedWhenActive(nativeFrame23);

    const nativeFrame24 = await createNativePushFrame({
      orderId: trackedOrder.orderId,
      symbol: trackedOrder.symbol,
      side: trackedOrder.side,
      status: 'WORKING',
      updatedAtMs: 300,
      executionTimeMs: 300,
    });
    eventFlow.handleOrderChangedWhenActive(nativeFrame24);

    expect(trackedOrder.status).toBe('CANCELED');
    expect(trackedOrder.timeoutMarketConversionTerminalState?.closedReason).toBe('CANCELED');
  });

  it('STOPPED 阶段收到订单 WS 时会直接忽略，不缓存也不推进 truth', async () => {
    const runtime = createRuntimeStore();
    runtime.runtimeState = 'STOPPED';
    runtime.trackedOrders.set(
      'ORDER-STOPPED-IGNORED-1',
      await createTrackedOrder({
        orderId: 'ORDER-STOPPED-IGNORED-1',
        symbol: 'BULL.HK',
        side: 'BUY',
      }),
    );
    let cacheCalls = 0;
    let settlementCalls = 0;
    const routeWakeups: Array<{ readonly symbol: string; readonly kind: string }> = [];
    const eventFlow = createEventFlow({
      runtime,
      orderRecorder: createOrderRecorderDouble(),
      recordCumulativeExecution: () => {},
      prepareProtectiveTerminalExecution: () => null,
      settleOrder: () => {
        settlementCalls += 1;
        return { handled: false, relatedBuyOrderIds: null };
      },
      cacheBootstrappingEvent: () => {
        cacheCalls += 1;
      },
      triggerRoute: (symbol: string, kind: string) => {
        routeWakeups.push({ symbol, kind });
      },
    });

    const nativeFrame25 = await createNativePushFrame({
      orderId: 'ORDER-STOPPED-IGNORED-1',
      symbol: 'BULL.HK',
      side: 'BUY',
      status: 'FILLED',
      executionTimeMs: Date.now(),
    });
    eventFlow.handleOrderChanged(nativeFrame25);

    expect(cacheCalls).toBe(0);
    expect(settlementCalls).toBe(0);
    expect(routeWakeups).toEqual([]);
    expect(runtime.trackedOrders.get('ORDER-STOPPED-IGNORED-1')?.status).toBe('WORKING');
  });

  it('在 truth 推进后触发 tracked order symbol 的 ORDER_EVENT wakeup', async () => {
    const runtime = createRuntimeStore();
    runtime.trackedOrders.set(
      'ORDER-WS-1',
      await createTrackedOrder({
        orderId: 'ORDER-WS-1',
        symbol: 'BULL.HK',
        side: 'BUY',
      }),
    );
    const routeWakeups: Array<{ readonly symbol: string; readonly kind: string }> = [];
    const eventFlow = createEventFlow({
      runtime,
      orderRecorder: createOrderRecorderDouble(),
      recordCumulativeExecution: () => {},
      prepareProtectiveTerminalExecution: () => null,
      settleOrder: () => ({ handled: false, relatedBuyOrderIds: null }),
      cacheBootstrappingEvent: () => {},
      triggerRoute: (symbol: string, kind: string) => {
        routeWakeups.push({ symbol, kind });
      },
    });

    const nativeFrame26 = await createNativePushFrame({
      orderId: 'ORDER-WS-1',
      symbol: 'BULL.HK',
      side: 'BUY',
      status: 'CANCELLATION_PENDING',
      executionTimeMs: Date.now(),
    });
    eventFlow.handleOrderChangedWhenActive(nativeFrame26);

    expect(routeWakeups).toEqual([
      {
        symbol: 'BULL.HK',
        kind: 'ORDER_EVENT',
      },
    ]);
  });

  it('卖单 timeoutMarketConversionPending 收到终态后写入 terminal snapshot 并显式唤醒 route', async () => {
    const runtime = createRuntimeStore();
    runtime.trackedOrders.set(
      'ORDER-SELL-TIMEOUT-1',
      await createTrackedOrder({
        orderId: 'ORDER-SELL-TIMEOUT-1',
        symbol: 'BULL.HK',
        side: 'SELL',
        timeoutMarketConversionPending: true,
      }),
    );
    const routeWakeups: Array<{ readonly symbol: string; readonly kind: string }> = [];
    const eventFlow = createEventFlow({
      runtime,
      orderRecorder: createOrderRecorderDouble(),
      recordCumulativeExecution: () => {},
      prepareProtectiveTerminalExecution: () => null,
      settleOrder: () => ({ handled: false, relatedBuyOrderIds: null }),
      cacheBootstrappingEvent: () => {},
      triggerRoute: (symbol: string, kind: string) => {
        routeWakeups.push({ symbol, kind });
      },
    });

    const nativeFrame27 = await createNativePushFrame({
      orderId: 'ORDER-SELL-TIMEOUT-1',
      symbol: 'BULL.HK',
      side: 'SELL',
      status: 'CANCELED',
      executedPrice: '1.02',
      executedQuantity: 0,
      executionTimeMs: Date.now(),
    });
    eventFlow.handleOrderChangedWhenActive(nativeFrame27);

    expect(
      runtime.trackedOrders.get('ORDER-SELL-TIMEOUT-1')?.timeoutMarketConversionTerminalState,
    ).toMatchObject({
      closedReason: 'CANCELED',
      source: 'WS',
    });

    expect(routeWakeups).toEqual([
      {
        symbol: 'BULL.HK',
        kind: 'ORDER_EVENT',
      },
    ]);
  });

  it('tracked order 收到普通终态且 route 已空时不再触发 ORDER_EVENT wakeup', async () => {
    const runtime = createRuntimeStore();
    runtime.trackedOrders.set(
      'ORDER-TERMINAL-1',
      await createTrackedOrder({
        orderId: 'ORDER-TERMINAL-1',
        symbol: 'BULL.HK',
        side: 'BUY',
      }),
    );
    const routeWakeups: Array<{ readonly symbol: string; readonly kind: string }> = [];
    const settlementPayloads: Array<{
      readonly orderId: string;
      readonly closedReason: string;
      readonly source: string;
    }> = [];
    const eventFlow = createEventFlow({
      runtime,
      orderRecorder: createOrderRecorderDouble(),
      recordCumulativeExecution: () => {},
      prepareProtectiveTerminalExecution: () => null,
      settleOrder: (params) => {
        settlementPayloads.push({
          orderId: params.orderId,
          closedReason: params.closedReason,
          source: params.source,
        });
        runtime.trackedOrders.delete(params.orderId);
        runtime.trackedOrderLifecycles.set(params.orderId, 'CLOSED');
        runtime.trackedOrderIdsBySymbol.delete('BULL.HK');
        runtime.routeStatesBySymbol.delete('BULL.HK');
        return { handled: true, relatedBuyOrderIds: null };
      },
      cacheBootstrappingEvent: () => {},
      triggerRoute: (symbol: string, kind: string) => {
        routeWakeups.push({ symbol, kind });
      },
    });

    const nativeFrame28 = await createNativePushFrame({
      orderId: 'ORDER-TERMINAL-1',
      symbol: 'BULL.HK',
      side: 'BUY',
      status: 'FILLED',
      executedPrice: '1.05',
      executedQuantity: 100,
      executionTimeMs: Date.now(),
    });
    eventFlow.handleOrderChangedWhenActive(nativeFrame28);

    expect(settlementPayloads).toEqual([
      {
        orderId: 'ORDER-TERMINAL-1',
        closedReason: 'FILLED',
        source: 'WS',
      },
    ]);
    expect(routeWakeups).toEqual([]);
  });

  it('tracked order 收到普通终态后若 route 仍存在会继续触发 ORDER_EVENT wakeup', async () => {
    const runtime = createRuntimeStore();
    runtime.trackedOrders.set(
      'ORDER-TERMINAL-A',
      await createTrackedOrder({
        orderId: 'ORDER-TERMINAL-A',
        symbol: 'BULL.HK',
        side: 'BUY',
      }),
    );

    runtime.trackedOrders.set(
      'ORDER-TERMINAL-B',
      await createTrackedOrder({
        orderId: 'ORDER-TERMINAL-B',
        symbol: 'BULL.HK',
        side: 'SELL',
      }),
    );

    runtime.trackedOrderIdsBySymbol.set(
      'BULL.HK',
      new Set(['ORDER-TERMINAL-A', 'ORDER-TERMINAL-B']),
    );

    runtime.routeStatesBySymbol.set('BULL.HK', {
      symbol: 'BULL.HK',
      generation: 1,
      inFlight: false,
      dirty: false,
      latestQuote: null,
      pendingWakeupKind: null,
      timerHandles: new Map(),
    });
    const routeWakeups: Array<{ readonly symbol: string; readonly kind: string }> = [];
    const eventFlow = createEventFlow({
      runtime,
      orderRecorder: createOrderRecorderDouble(),
      recordCumulativeExecution: () => {},
      prepareProtectiveTerminalExecution: () => null,
      settleOrder: (params) => {
        runtime.trackedOrders.delete(params.orderId);
        runtime.trackedOrderLifecycles.set(params.orderId, 'CLOSED');
        const bucket = runtime.trackedOrderIdsBySymbol.get('BULL.HK');
        if (bucket) {
          bucket.delete(params.orderId);
          if (bucket.size === 0) {
            runtime.trackedOrderIdsBySymbol.delete('BULL.HK');
            runtime.routeStatesBySymbol.delete('BULL.HK');
          }
        }

        return { handled: true, relatedBuyOrderIds: null };
      },
      cacheBootstrappingEvent: () => {},
      triggerRoute: (symbol: string, kind: string) => {
        routeWakeups.push({ symbol, kind });
      },
    });

    const nativeFrame29 = await createNativePushFrame({
      orderId: 'ORDER-TERMINAL-A',
      symbol: 'BULL.HK',
      side: 'BUY',
      status: 'FILLED',
      executedPrice: '1.05',
      executedQuantity: 100,
      executionTimeMs: Date.now(),
    });
    eventFlow.handleOrderChangedWhenActive(nativeFrame29);

    expect(routeWakeups).toEqual([
      {
        symbol: 'BULL.HK',
        kind: 'ORDER_EVENT',
      },
    ]);
  });

  it('未追踪订单的 closed event 不触发 route wakeup', async () => {
    const runtime = createRuntimeStore();
    const routeWakeups: Array<{ readonly symbol: string; readonly kind: string }> = [];
    const eventFlow = createEventFlow({
      runtime,
      orderRecorder: createOrderRecorderDouble(),
      recordCumulativeExecution: () => {},
      prepareProtectiveTerminalExecution: () => null,
      settleOrder: () => ({ handled: false, relatedBuyOrderIds: null }),
      cacheBootstrappingEvent: () => {},
      triggerRoute: (symbol: string, kind: string) => {
        routeWakeups.push({ symbol, kind });
      },
    });

    const nativeFrame30 = await createNativePushFrame({
      orderId: 'UNTRACKED-CLOSED-1',
      symbol: 'BULL.HK',
      side: 'BUY',
      status: 'FILLED',
      executionTimeMs: Date.now(),
    });
    eventFlow.handleOrderChangedWhenActive(nativeFrame30);

    expect(routeWakeups).toEqual([]);
  });

  it.each(['CANCELLATION_PENDING', 'CANCELLATION_REQUESTED'] as const)(
    '已有部分成交的保护性 SELL 收到 %s WS 零值原始事实时拒绝推进',
    async (status) => {
      const runtime = createRuntimeStore();
      const trackedOrder = await createTrackedOrder({
        orderId: `ORDER-PROTECTIVE-${status}-RAW-ZERO`,
        symbol: 'BULL.HK',
        side: 'SELL',
        status: 'PARTIALLY_FILLED',
        isProtectiveLiquidation: true,
      });
      trackedOrder.executedQuantity = 40;
      trackedOrder.executedPrice = '1.02';
      trackedOrder.executedAmount = exactMultiply(
        trackedOrder.executedPrice,
        String(trackedOrder.executedQuantity),
      );
      trackedOrder.lastExecutedTimeMs = 200;
      trackedOrder.lastOrderUpdateAtMs = 200;
      runtime.trackedOrders.set(trackedOrder.orderId, trackedOrder);
      const partialFills: number[] = [];
      let durableProgressCalls = 0;
      let settlementCalls = 0;
      const routeWakeups: Array<{ readonly symbol: string; readonly kind: string }> = [];
      const eventFlow = createEventFlow({
        runtime,
        orderRecorder: createOrderRecorderDouble({
          markSellPartialFilled: (_orderId, filledQuantity) => {
            partialFills.push(filledQuantity);
            return null;
          },
        }),
        recordCumulativeExecution: () => {
          durableProgressCalls += 1;
        },
        prepareProtectiveTerminalExecution: () => null,
        settleOrder: () => {
          settlementCalls += 1;
          return { handled: true, relatedBuyOrderIds: null };
        },
        cacheBootstrappingEvent: () => {},
        triggerRoute: (symbol, kind) => {
          routeWakeups.push({ symbol, kind });
        },
      });

      const nativeFrame31 = await createNativePushFrame({
        orderId: trackedOrder.orderId,
        symbol: trackedOrder.symbol,
        side: trackedOrder.side,
        status,
        executedQuantity: 0,
        executedPrice: '0',
        updatedAtMs: 300,
        executionTimeMs: 300,
      });
      expect(() => {
        eventFlow.handleOrderChangedWhenActive(nativeFrame31);
      }).toThrow(/保护性 SELL/);

      expect(trackedOrder).toMatchObject({
        status: 'PARTIALLY_FILLED',
        executedQuantity: 40,
        executedPrice: '1.02',
        executedAmount: exactMultiply('1.02', '40'),
        lastExecutedTimeMs: 200,
        lastOrderUpdateAtMs: 200,
      });
      expect(partialFills).toEqual([]);
      expect(durableProgressCalls).toBe(0);
      expect(settlementCalls).toBe(0);
      expect(routeWakeups).toEqual([]);
    },
  );

  it('保护性 SELL 原始累计成交推进但 broker revision 倒退时拒绝 WS 终态', async () => {
    const runtime = createRuntimeStore();
    const trackedOrder = await createTrackedOrder({
      orderId: 'ORDER-PROTECTIVE-OLDER-REVISION-WS',
      symbol: 'BULL.HK',
      side: 'SELL',
      status: 'PARTIALLY_FILLED',
      isProtectiveLiquidation: true,
    });
    trackedOrder.executedQuantity = 40;
    trackedOrder.executedPrice = '1.02';
    trackedOrder.executedAmount = exactMultiply(
      trackedOrder.executedPrice,
      String(trackedOrder.executedQuantity),
    );
    trackedOrder.lastExecutedTimeMs = 190;
    trackedOrder.lastOrderUpdateAtMs = 200;
    runtime.trackedOrders.set(trackedOrder.orderId, trackedOrder);
    let settlementCalls = 0;
    const eventFlow = createEventFlow({
      runtime,
      orderRecorder: createOrderRecorderDouble(),
      recordCumulativeExecution: () => {},
      prepareProtectiveTerminalExecution: () => null,
      settleOrder: () => {
        settlementCalls += 1;
        return { handled: true, relatedBuyOrderIds: null };
      },
      cacheBootstrappingEvent: () => {},
      triggerRoute: () => {},
    });

    const nativeFrame32 = await createNativePushFrame({
      orderId: trackedOrder.orderId,
      symbol: trackedOrder.symbol,
      side: trackedOrder.side,
      status: 'CANCELED',
      executedQuantity: 80,
      executedPrice: '1.01',
      updatedAtMs: 100,
      executionTimeMs: 100,
    });
    expect(() => {
      eventFlow.handleOrderChangedWhenActive(nativeFrame32);
    }).toThrow(/revision/);

    expect(settlementCalls).toBe(0);
    expect(trackedOrder).toMatchObject({
      status: 'PARTIALLY_FILLED',
      executedQuantity: 40,
      executedPrice: '1.02',
      executedAmount: exactMultiply('1.02', '40'),
      lastExecutedTimeMs: 190,
      lastOrderUpdateAtMs: 200,
    });
  });
});
