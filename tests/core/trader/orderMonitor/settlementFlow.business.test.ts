/**
 * orderMonitor/settlementFlow 业务测试
 *
 * 覆盖：
 * - 买单与卖单终态结算的幂等、副作用与关联单语义
 * - 缺少归属上下文时拒绝结算，避免错误记账
 */
import { describe, expect, it, mock } from 'bun:test';
import { OrderSide, OrderStatus, OrderType } from 'longbridge';
import { createDailyLossTracker } from '../../../../src/core/riskController/dailyLossTracker.js';
import { createDailyLossOrderAnalysisDeps } from '../../../../src/core/orderRecorder/index.js';
import { toHongKongTimeIso } from '../../../../src/utils/time/index.js';
import {
  createDailyLossTrackerDouble,
  createOrderRecorderDouble,
  createProtectiveLiquidationEpisodeTrackerDouble,
} from '../../../helpers/testDoubles.js';
import type { OrderRecord, OrderStateChangedEvent } from '../../../../src/types/services.js';
import type { DailyLossCumulativeExecutionInput } from '../../../../src/types/risk.js';
import type { OrderHoldRegistry } from '../../../../src/core/trader/types.js';
import type {
  FinalizeOrderSettlementParams,
  OrderMonitorRuntimeStore,
  OrderMonitorTrackedOrder,
} from '../../../../src/core/trader/orderMonitor/types.js';

mock.module('../../../../src/utils/logger/index.js', () => ({
  logger: {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  },
}));

import { createSettlementFlow } from '../../../../src/core/trader/orderMonitor/settlementFlow.js';

function createRuntime(): OrderMonitorRuntimeStore {
  return {
    trackedOrders: new Map<string, OrderMonitorTrackedOrder>(),
    trackedOrderLifecycles: new Map(),
    bootstrappingOrderEvents: new Map(),
    closedOrderIds: new Set(),
    queriedTerminalStateByOrderId: new Map(),
    latestReplaceOutcomeByOrderId: new Map(),
    orderStateChangedListeners: new Set(),
    trackedOrderIdsBySymbol: new Map(),
    routeStatesBySymbol: new Map(),
    latestRouteGenerationBySymbol: new Map(),
    runtimeState: 'ACTIVE',
    running: false,
    unsubscribeQuoteUpdated: null,
  };
}

function createOrderHoldRegistry(): OrderHoldRegistry {
  return {
    trackOrder: () => {},
    markOrderClosed: () => {},
    seedFromOrders: () => {},
    getHoldSymbols: () => new Set<string>(),
    onOrderHoldSymbolsChanged: () => () => {},
    clear: () => {},
  };
}

const PROTECTIVE_EXECUTION_TIME_MS = Date.parse('2026-02-25T03:11:00.000Z');

function createTrackedProtectiveSell(orderId: string): OrderMonitorTrackedOrder {
  return {
    orderId,
    symbol: 'BULL.HK',
    side: OrderSide.Sell,
    isLongSymbol: true,
    monitorSymbol: 'HSI.HK',
    isProtectiveLiquidation: true,
    orderType: OrderType.ELO,
    submittedPrice: 1,
    initialSubmittedPrice: 1,
    submittedQuantity: 100,
    executedQuantity: 0,
    executedPrice: null,
    lastExecutedTimeMs: null,
    lastOrderUpdateAtMs: null,
    status: OrderStatus.New,
    submittedAt: PROTECTIVE_EXECUTION_TIME_MS - 60_000,
    lastPriceUpdateAt: PROTECTIVE_EXECUTION_TIME_MS - 60_000,
    convertedToMarket: false,
    nextCancelAttemptAt: PROTECTIVE_EXECUTION_TIME_MS - 60_000,
    cancelRetryCount: 0,
    replaceCapability: 'SUPPORTED',
    replaceBlockedUntilAt: null,
    quoteRetryAttempts: 0,
    quoteRetryNextAt: null,
    quoteRetryExhausted: false,
    replaceTempBlockedCount: 0,
    replaceResumeMode: 'TIME_BACKOFF',
    timeoutMarketConversionPending: false,
    timeoutMarketConversionTerminalState: null,
  };
}

function createProtectivePersistenceHarness(params: {
  readonly orderId: string;
  readonly closedReason: 'FILLED' | 'CANCELED' | 'REJECTED';
  readonly executedTimeMs?: number;
  readonly orderUpdatedAtMs?: number;
}): {
  readonly settle: () => void;
  readonly prepare: () => void;
  readonly allowPersistence: () => void;
  readonly recorderCalls: ReadonlyArray<string>;
  readonly episodeCalls: ReadonlyArray<string>;
  readonly refreshCalls: ReadonlyArray<string>;
  readonly holdClosedOrderIds: ReadonlyArray<string>;
  readonly stateEvents: ReadonlyArray<OrderStateChangedEvent>;
  readonly persistedOrderIds: ReadonlyArray<string>;
  readonly runtime: OrderMonitorRuntimeStore;
  readonly persistenceError: Error;
} {
  const runtime = createRuntime();
  runtime.trackedOrders.set(params.orderId, createTrackedProtectiveSell(params.orderId));
  const recorderCalls: string[] = [];
  const episodeCalls: string[] = [];
  const refreshCalls: string[] = [];
  const holdClosedOrderIds: string[] = [];
  const stateEvents: OrderStateChangedEvent[] = [];
  const persistedOrderIds: string[] = [];
  const persistenceError = new Error('protective progress persistence failed');
  let shouldThrowOnPersist = true;
  const dailyLossTracker = createDailyLossTracker({
    ...createDailyLossOrderAnalysisDeps(),
    resolveOrderOwnership: () => ({ monitorSymbol: 'HSI.HK', direction: 'LONG' }),
    toHongKongTimeIso,
  });
  dailyLossTracker.resetAll(new Date(PROTECTIVE_EXECUTION_TIME_MS));
  const orderHoldRegistry = createOrderHoldRegistry();
  const settlementFlow = createSettlementFlow({
    runtime,
    orderHoldRegistry: {
      ...orderHoldRegistry,
      markOrderClosed: (orderId) => {
        holdClosedOrderIds.push(orderId);
      },
    },
    orderRecorder: createOrderRecorderDouble({
      markSellFilled: () => {
        recorderCalls.push('markSellFilled');
        return null;
      },
      markSellCancelled: () => {
        recorderCalls.push('markSellCancelled');
        return null;
      },
      recordLocalSell: () => {
        recorderCalls.push('recordLocalSell');
      },
    }),
    dailyLossTracker,
    persistProtectiveLiquidationExecutionProgress: (input) => {
      persistedOrderIds.push(input.orderId);
      if (shouldThrowOnPersist) {
        throw persistenceError;
      }
    },
    protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble({
      recordProtectiveFillProgress: () => {
        episodeCalls.push('recordProtectiveFillProgress');
      },
    }),
    postTradeConsistencyRuntime: {
      recordSettlementRefreshNeed: () => {
        refreshCalls.push('recordSettlementRefreshNeed');
      },
    },
    emitOrderStateChanged: (event) => {
      stateEvents.push(event);
    },
  });
  const createSettlementParams = (): FinalizeOrderSettlementParams => ({
    orderId: params.orderId,
    closedReason: params.closedReason,
    source: 'WS',
    symbol: 'BULL.HK',
    side: 'SELL',
    monitorSymbol: 'HSI.HK',
    isLongSymbol: true,
    isProtectiveLiquidation: true,
    executedPrice: 1.02,
    executedQuantity: params.closedReason === 'FILLED' ? 100 : 40,
    executedTimeMs: params.executedTimeMs ?? PROTECTIVE_EXECUTION_TIME_MS,
    orderUpdatedAtMs: params.orderUpdatedAtMs ?? PROTECTIVE_EXECUTION_TIME_MS,
  });
  const settle = (): void => {
    settlementFlow.settleOrder(createSettlementParams());
  };

  const prepare = (): void => {
    settlementFlow.prepareProtectiveTerminalExecution(createSettlementParams());
  };

  return {
    settle,
    prepare,
    allowPersistence: () => {
      shouldThrowOnPersist = false;
    },
    recorderCalls,
    episodeCalls,
    refreshCalls,
    holdClosedOrderIds,
    stateEvents,
    persistedOrderIds,
    runtime,
    persistenceError,
  };
}

describe('settlementFlow business flow', () => {
  for (const source of ['WS', 'STATE_CHECK'] as const) {
    for (const closedReason of ['FILLED', 'CANCELED', 'REJECTED'] as const) {
      it(`保护性 SELL 正累计成交缺少执行时间时，${source} ${closedReason} 在公共结算入口零副作用失败`, () => {
        const orderId = `PROTECTIVE-MISSING-TIME-${source}-${closedReason}`;
        const runtime = createRuntime();
        runtime.trackedOrders.set(orderId, createTrackedProtectiveSell(orderId));
        const recorderCalls: string[] = [];
        const dailyLossCalls: DailyLossCumulativeExecutionInput[] = [];
        const persistenceCalls: string[] = [];
        const episodeCalls: string[] = [];
        const refreshCalls: string[] = [];
        const holdClosedOrderIds: string[] = [];
        const stateEvents: OrderStateChangedEvent[] = [];
        const settlementFlow = createSettlementFlow({
          runtime,
          orderHoldRegistry: {
            ...createOrderHoldRegistry(),
            markOrderClosed: (closedOrderId) => {
              holdClosedOrderIds.push(closedOrderId);
            },
          },
          orderRecorder: createOrderRecorderDouble({
            markSellFilled: () => {
              recorderCalls.push('markSellFilled');
              return null;
            },
            markSellCancelled: () => {
              recorderCalls.push('markSellCancelled');
              return null;
            },
            recordLocalSell: () => {
              recorderCalls.push('recordLocalSell');
            },
          }),
          dailyLossTracker: createDailyLossTrackerDouble({
            recordCumulativeExecution: (input) => {
              dailyLossCalls.push(input);
              return { authoritativeFactChanged: true, executionAdvanced: true };
            },
          }),
          persistProtectiveLiquidationExecutionProgress: (input) => {
            persistenceCalls.push(input.orderId);
          },
          protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble({
            recordProtectiveFillProgress: () => {
              episodeCalls.push('recordProtectiveFillProgress');
            },
          }),
          postTradeConsistencyRuntime: {
            recordSettlementRefreshNeed: () => {
              refreshCalls.push('recordSettlementRefreshNeed');
            },
          },
          emitOrderStateChanged: (event) => {
            stateEvents.push(event);
          },
        });

        expect(() =>
          settlementFlow.settleOrder({
            orderId,
            closedReason,
            source,
            symbol: 'BULL.HK',
            side: 'SELL',
            monitorSymbol: 'HSI.HK',
            isLongSymbol: true,
            isProtectiveLiquidation: true,
            executedPrice: 1.02,
            executedQuantity: 40,
            executedTimeMs: null,
            orderUpdatedAtMs: PROTECTIVE_EXECUTION_TIME_MS,
          }),
        ).toThrow(/保护性 SELL 存在正累计成交但执行事实不完整/);

        expect(recorderCalls).toEqual([]);
        expect(dailyLossCalls).toEqual([]);
        expect(persistenceCalls).toEqual([]);
        expect(episodeCalls).toEqual([]);
        expect(refreshCalls).toEqual([]);
        expect(holdClosedOrderIds).toEqual([]);
        expect(stateEvents).toEqual([]);
        expect(runtime.closedOrderIds.has(orderId)).toBe(false);
        expect(runtime.trackedOrders.has(orderId)).toBe(true);
      });
    }
  }

  it.each(['FILLED', 'CANCELED', 'REJECTED'] as const)(
    '保护性 SELL %s 的执行时间晚于 revision 时不得把 DailyLoss no-op 当作本地结算许可',
    (closedReason) => {
      const orderId = `PROTECTIVE-LATE-EXECUTION-${closedReason}`;
      const harness = createProtectivePersistenceHarness({
        orderId,
        closedReason,
        executedTimeMs: PROTECTIVE_EXECUTION_TIME_MS + 1,
        orderUpdatedAtMs: PROTECTIVE_EXECUTION_TIME_MS,
      });

      expect(harness.settle).toThrow(/执行时间晚于 order revision/);
      expect(harness.persistedOrderIds).toEqual([]);
      expect(harness.recorderCalls).toEqual([]);
      expect(harness.episodeCalls).toEqual([]);
      expect(harness.refreshCalls).toEqual([]);
      expect(harness.holdClosedOrderIds).toEqual([]);
      expect(harness.stateEvents).toEqual([]);
      expect(harness.runtime.closedOrderIds.has(orderId)).toBe(false);
      expect(harness.runtime.trackedOrders.has(orderId)).toBe(true);
    },
  );

  it('保护性 SELL timeout prepare 的执行时间晚于 revision 时零副作用失败', () => {
    const harness = createProtectivePersistenceHarness({
      orderId: 'PROTECTIVE-TIMEOUT-PREPARE-LATE-EXECUTION',
      closedReason: 'CANCELED',
      executedTimeMs: PROTECTIVE_EXECUTION_TIME_MS + 1,
      orderUpdatedAtMs: PROTECTIVE_EXECUTION_TIME_MS,
    });

    expect(harness.prepare).toThrow(/执行时间晚于 order revision/);
    expect(harness.persistedOrderIds).toEqual([]);
    expect(harness.recorderCalls).toEqual([]);
    expect(harness.episodeCalls).toEqual([]);
    expect(harness.refreshCalls).toEqual([]);
    expect(harness.holdClosedOrderIds).toEqual([]);
    expect(harness.stateEvents).toEqual([]);
    expect(harness.runtime.closedOrderIds.has('PROTECTIVE-TIMEOUT-PREPARE-LATE-EXECUTION')).toBe(
      false,
    );
  });

  it('protective FILLED persists durable progress before any local settlement and retries the uncommitted fact', () => {
    const harness = createProtectivePersistenceHarness({
      orderId: 'PROTECTIVE-FILLED-PERSIST-FAIL',
      closedReason: 'FILLED',
    });

    expect(harness.settle).toThrow(harness.persistenceError);
    expect(harness.recorderCalls).toEqual([]);
    expect(harness.episodeCalls).toEqual([]);
    expect(harness.refreshCalls).toEqual([]);
    expect(harness.holdClosedOrderIds).toEqual([]);
    expect(harness.stateEvents).toEqual([]);
    expect(harness.runtime.closedOrderIds.has('PROTECTIVE-FILLED-PERSIST-FAIL')).toBe(false);
    expect(harness.runtime.trackedOrders.has('PROTECTIVE-FILLED-PERSIST-FAIL')).toBe(true);

    harness.allowPersistence();
    harness.settle();

    expect(harness.persistedOrderIds).toEqual([
      'PROTECTIVE-FILLED-PERSIST-FAIL',
      'PROTECTIVE-FILLED-PERSIST-FAIL',
    ]);
  });

  it('protective partially-filled CANCELED persists durable progress before releasing pending sell occupancy', () => {
    const harness = createProtectivePersistenceHarness({
      orderId: 'PROTECTIVE-CANCELED-PARTIAL-PERSIST-FAIL',
      closedReason: 'CANCELED',
    });

    expect(harness.settle).toThrow(harness.persistenceError);
    expect(harness.recorderCalls).toEqual([]);
    expect(harness.episodeCalls).toEqual([]);
    expect(harness.refreshCalls).toEqual([]);
    expect(harness.holdClosedOrderIds).toEqual([]);
    expect(harness.stateEvents).toEqual([]);
    expect(harness.runtime.closedOrderIds.has('PROTECTIVE-CANCELED-PARTIAL-PERSIST-FAIL')).toBe(
      false,
    );

    expect(harness.runtime.trackedOrders.has('PROTECTIVE-CANCELED-PARTIAL-PERSIST-FAIL')).toBe(
      true,
    );

    harness.allowPersistence();
    harness.settle();

    expect(harness.persistedOrderIds).toEqual([
      'PROTECTIVE-CANCELED-PARTIAL-PERSIST-FAIL',
      'PROTECTIVE-CANCELED-PARTIAL-PERSIST-FAIL',
    ]);
  });

  it('settles FILLED buy order once and records a post-trade refresh need plus order state event without closeSync runtime state', () => {
    const runtime = createRuntime();
    let localBuyCalls = 0;
    const refreshNeeds: Array<{
      readonly refreshAccount: boolean;
      readonly refreshPositions: boolean;
    }> = [];
    const orderStateEvents: OrderStateChangedEvent[] = [];
    const dailyLossFills: DailyLossCumulativeExecutionInput[] = [];
    const settlementFlow = createSettlementFlow({
      runtime,
      orderHoldRegistry: createOrderHoldRegistry(),
      orderRecorder: createOrderRecorderDouble({
        recordLocalBuy: () => {
          localBuyCalls += 1;
        },
      }),
      dailyLossTracker: createDailyLossTrackerDouble({
        recordCumulativeExecution: (input) => {
          dailyLossFills.push(input);
          return { authoritativeFactChanged: true, executionAdvanced: true };
        },
      }),
      persistProtectiveLiquidationExecutionProgress: () => {},
      protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
      postTradeConsistencyRuntime: {
        recordSettlementRefreshNeed: (need) => {
          refreshNeeds.push(need);
        },
      },
      emitOrderStateChanged: (event) => {
        orderStateEvents.push(event);
      },
    });

    const settledResult = settlementFlow.settleOrder({
      orderId: 'BUY-SETTLEMENT-IDEMPOTENT',
      closedReason: 'FILLED',
      source: 'WS',
      symbol: 'BULL.HK',
      side: 'BUY',
      monitorSymbol: 'HSI.HK',
      isLongSymbol: true,
      executedPrice: 1.02,
      executedQuantity: 100,
      executedTimeMs: Date.parse('2026-02-25T03:11:00.000Z'),
      orderUpdatedAtMs: Date.parse('2026-02-25T03:11:00.000Z'),
    });
    const duplicateResult = settlementFlow.settleOrder({
      orderId: 'BUY-SETTLEMENT-IDEMPOTENT',
      closedReason: 'FILLED',
      source: 'WS',
      symbol: 'BULL.HK',
      side: 'BUY',
      monitorSymbol: 'HSI.HK',
      isLongSymbol: true,
      executedPrice: 1.02,
      executedQuantity: 100,
      executedTimeMs: Date.parse('2026-02-25T03:11:00.000Z'),
      orderUpdatedAtMs: Date.parse('2026-02-25T03:11:00.000Z'),
    });

    expect(settledResult.handled).toBe(true);
    expect(duplicateResult.handled).toBe(false);
    expect(localBuyCalls).toBe(1);
    expect(dailyLossFills).toEqual([
      {
        factStage: 'TERMINAL',
        direction: 'LONG',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
        executedPrice: 1.02,
        executedQuantity: 100,
        executedTimeMs: Date.parse('2026-02-25T03:11:00.000Z'),
        orderUpdatedAtMs: Date.parse('2026-02-25T03:11:00.000Z'),
        orderId: 'BUY-SETTLEMENT-IDEMPOTENT',
      },
    ]);

    expect(refreshNeeds).toEqual([
      {
        refreshAccount: true,
        refreshPositions: true,
      },
    ]);

    expect(orderStateEvents).toEqual([
      {
        orderId: 'BUY-SETTLEMENT-IDEMPOTENT',
        symbol: 'BULL.HK',
        side: 'BUY',
        source: 'WS',
        status: 'FILLED',
        monitorSymbol: 'HSI.HK',
        isLongSymbol: true,
        isProtectiveLiquidation: false,
        executedPrice: 1.02,
        executedQuantity: 100,
        executedTimeMs: Date.parse('2026-02-25T03:11:00.000Z'),
      },
    ]);
    expect(runtime.closedOrderIds.has('BUY-SETTLEMENT-IDEMPOTENT')).toBe(true);
    expect('closeSyncQueue' in runtime).toBe(false);
  });

  it('settles partially-filled canceled sell with recovered quantity and records a post-trade refresh need', () => {
    const runtime = createRuntime();
    const orderStateEvents: OrderStateChangedEvent[] = [];
    const buyOrders: ReadonlyArray<OrderRecord> = [
      {
        orderId: 'BUY-A',
        symbol: 'BULL.HK',
        executedPrice: 1,
        executedQuantity: 70,
        executedTime: Date.parse('2026-02-25T03:00:00.000Z'),
        submittedAt: undefined,
        updatedAt: undefined,
      },
      {
        orderId: 'BUY-B',
        symbol: 'BULL.HK',
        executedPrice: 1.2,
        executedQuantity: 70,
        executedTime: Date.parse('2026-02-25T03:05:00.000Z'),
        submittedAt: undefined,
        updatedAt: undefined,
      },
    ];
    const localSellRelatedIds: Array<ReadonlyArray<string> | null> = [];
    const refreshNeeds: Array<{
      readonly refreshAccount: boolean;
      readonly refreshPositions: boolean;
    }> = [];
    const settlementFlow = createSettlementFlow({
      runtime,
      orderHoldRegistry: createOrderHoldRegistry(),
      orderRecorder: createOrderRecorderDouble({
        markSellCancelled: () => ({
          orderId: 'SELL-PARTIAL-FALLBACK',
          symbol: 'BULL.HK',
          direction: 'LONG',
          submittedQuantity: 140,
          filledQuantity: 100,
          relatedBuyOrderIds: ['BUY-A', 'BUY-B'],
          status: 'cancelled',
          submittedAt: Date.parse('2026-02-25T03:09:00.000Z'),
        }),
        getBuyOrdersForSymbol: () => buyOrders,
        recordLocalSell: (
          _symbol,
          _executedPrice,
          _executedQuantity,
          _isLongSymbol,
          _executedTimeMs,
          _orderId,
          relatedBuyOrderIds,
        ) => {
          localSellRelatedIds.push(relatedBuyOrderIds ?? null);
        },
      }),
      dailyLossTracker: createDailyLossTrackerDouble({
        recordCumulativeExecution: () => ({
          authoritativeFactChanged: true,
          executionAdvanced: true,
        }),
      }),
      persistProtectiveLiquidationExecutionProgress: () => {},
      protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
      postTradeConsistencyRuntime: {
        recordSettlementRefreshNeed: (need) => {
          refreshNeeds.push(need);
        },
      },
      emitOrderStateChanged: (event) => {
        orderStateEvents.push(event);
      },
    });

    const settledResult = settlementFlow.settleOrder({
      orderId: 'SELL-PARTIAL-FALLBACK',
      closedReason: 'CANCELED',
      source: 'WS',
      symbol: 'BULL.HK',
      side: 'SELL',
      monitorSymbol: 'HSI.HK',
      isLongSymbol: true,
      executedPrice: 1.05,
      executedQuantity: 100,
      executedTimeMs: Date.parse('2026-02-25T03:11:00.000Z'),
      orderUpdatedAtMs: Date.parse('2026-02-25T03:11:00.000Z'),
    });

    expect(settledResult.handled).toBe(true);
    expect(settledResult.relatedBuyOrderIds).toBeNull();
    expect(localSellRelatedIds).toEqual([null]);
    expect(refreshNeeds).toEqual([
      {
        refreshAccount: true,
        refreshPositions: true,
      },
    ]);

    expect(orderStateEvents).toEqual([
      {
        orderId: 'SELL-PARTIAL-FALLBACK',
        symbol: 'BULL.HK',
        side: 'SELL',
        source: 'WS',
        status: 'CANCELED',
        monitorSymbol: 'HSI.HK',
        isLongSymbol: true,
        isProtectiveLiquidation: false,
        executedPrice: 1.05,
        executedQuantity: 100,
        executedTimeMs: Date.parse('2026-02-25T03:11:00.000Z'),
      },
    ]);
  });

  it('保留 timeout->market follow-up 占用时会在旧 orderId 下重建连续 placeholder', () => {
    const runtime = createRuntime();
    const submittedFollowUpSells: Array<{
      readonly orderId: string;
      readonly quantity: number;
      readonly relatedBuyOrderIds: ReadonlyArray<string>;
    }> = [];
    const settlementFlow = createSettlementFlow({
      runtime,
      orderHoldRegistry: createOrderHoldRegistry(),
      orderRecorder: createOrderRecorderDouble({
        markSellCancelled: () => ({
          orderId: 'SELL-HANDOFF-PLACEHOLDER',
          symbol: 'BULL.HK',
          direction: 'LONG',
          submittedQuantity: 200,
          filledQuantity: 0,
          relatedBuyOrderIds: ['BUY-A', 'BUY-B'],
          status: 'cancelled',
          submittedAt: Date.parse('2026-02-25T03:09:00.000Z'),
        }),
        getBuyOrdersForSymbol: () => [
          {
            orderId: 'BUY-A',
            symbol: 'BULL.HK',
            executedPrice: 1,
            executedQuantity: 100,
            executedTime: Date.parse('2026-02-25T03:00:00.000Z'),
            submittedAt: undefined,
            updatedAt: undefined,
          },
          {
            orderId: 'BUY-B',
            symbol: 'BULL.HK',
            executedPrice: 1.1,
            executedQuantity: 100,
            executedTime: Date.parse('2026-02-25T03:05:00.000Z'),
            submittedAt: undefined,
            updatedAt: undefined,
          },
        ],
        submitSellOrder: (orderId, _symbol, _direction, quantity, relatedBuyOrderIds) => {
          submittedFollowUpSells.push({
            orderId,
            quantity,
            relatedBuyOrderIds,
          });
        },
      }),
      dailyLossTracker: createDailyLossTrackerDouble({
        recordCumulativeExecution: () => ({
          authoritativeFactChanged: true,
          executionAdvanced: true,
        }),
      }),
      persistProtectiveLiquidationExecutionProgress: () => {},
      protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
      postTradeConsistencyRuntime: {
        recordSettlementRefreshNeed: () => {},
      },
      emitOrderStateChanged: () => {},
    });

    const result = settlementFlow.settleOrder({
      orderId: 'SELL-HANDOFF-PLACEHOLDER',
      closedReason: 'CANCELED',
      source: 'WS',
      symbol: 'BULL.HK',
      side: 'SELL',
      monitorSymbol: 'HSI.HK',
      isLongSymbol: true,
      executedPrice: null,
      executedQuantity: null,
      executedTimeMs: null,
      pendingSellDisposition: {
        kind: 'HANDOFF_TO_FOLLOW_UP_SELL',
        followUpQuantity: 200,
      },
    });

    expect(result.handled).toBe(true);
    expect(result.relatedBuyOrderIds).toEqual(['BUY-A', 'BUY-B']);
    expect(submittedFollowUpSells).toEqual([
      {
        orderId: 'SELL-HANDOFF-PLACEHOLDER',
        quantity: 200,
        relatedBuyOrderIds: ['BUY-A', 'BUY-B'],
      },
    ]);
  });

  it('fails fast when executed close lacks attribution context', () => {
    const runtime = createRuntime();
    const settlementFlow = createSettlementFlow({
      runtime,
      orderHoldRegistry: createOrderHoldRegistry(),
      orderRecorder: createOrderRecorderDouble(),
      dailyLossTracker: createDailyLossTrackerDouble(),
      persistProtectiveLiquidationExecutionProgress: () => {},
      protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
      postTradeConsistencyRuntime: {
        recordSettlementRefreshNeed: () => {},
      },
      emitOrderStateChanged: () => {},
    });

    expect(() =>
      settlementFlow.settleOrder({
        orderId: 'BUY-PARTIAL-MISSING-ATTR',
        closedReason: 'CANCELED',
        source: 'RECOVERY',
        symbol: 'BULL.HK',
        side: 'BUY',
        executedPrice: 1.02,
        executedQuantity: 20,
        executedTimeMs: Date.parse('2026-02-25T03:11:00.000Z'),
      }),
    ).toThrow(/缺少唯一 monitor\/direction 归因/);
    expect(runtime.closedOrderIds.has('BUY-PARTIAL-MISSING-ATTR')).toBe(false);
  });

  it('fails fast when an attributed cumulative execution lacks explicit revision progress', () => {
    const runtime = createRuntime();
    const settlementFlow = createSettlementFlow({
      runtime,
      orderHoldRegistry: createOrderHoldRegistry(),
      orderRecorder: createOrderRecorderDouble(),
      dailyLossTracker: createDailyLossTrackerDouble(),
      persistProtectiveLiquidationExecutionProgress: () => {},
      protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
      postTradeConsistencyRuntime: {
        recordSettlementRefreshNeed: () => {},
      },
      emitOrderStateChanged: () => {},
    });

    expect(() =>
      settlementFlow.settleOrder({
        orderId: 'BUY-MISSING-REVISION-PROGRESS',
        closedReason: 'FILLED',
        source: 'WS',
        symbol: 'BULL.HK',
        side: 'BUY',
        monitorSymbol: 'HSI.HK',
        isLongSymbol: true,
        executedPrice: 1.02,
        executedQuantity: 20,
        executedTimeMs: Date.parse('2026-02-25T03:11:00.000Z'),
      }),
    ).toThrow(/order revision/);
    expect(runtime.closedOrderIds.has('BUY-MISSING-REVISION-PROGRESS')).toBe(false);
  });

  it('fails fast when executed close lacks monitor attribution', () => {
    const runtime = createRuntime();
    const refreshNeeds: Array<{
      readonly refreshAccount: boolean;
      readonly refreshPositions: boolean;
    }> = [];
    const orderStateEvents: OrderStateChangedEvent[] = [];
    const settlementFlow = createSettlementFlow({
      runtime,
      orderHoldRegistry: createOrderHoldRegistry(),
      orderRecorder: createOrderRecorderDouble(),
      dailyLossTracker: createDailyLossTrackerDouble({
        recordCumulativeExecution: () => ({
          authoritativeFactChanged: true,
          executionAdvanced: true,
        }),
      }),
      persistProtectiveLiquidationExecutionProgress: () => {},
      protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
      postTradeConsistencyRuntime: {
        recordSettlementRefreshNeed: (need) => {
          refreshNeeds.push(need);
        },
      },
      emitOrderStateChanged: (event) => {
        orderStateEvents.push(event);
      },
    });

    expect(() =>
      settlementFlow.settleOrder({
        orderId: 'SELL-PROTECTIVE-MISSING-MONITOR',
        closedReason: 'FILLED',
        source: 'WS',
        symbol: 'BULL.HK',
        side: 'SELL',
        isLongSymbol: true,
        isProtectiveLiquidation: true,
        executedPrice: 1.02,
        executedQuantity: 100,
        executedTimeMs: Date.parse('2026-02-25T03:11:00.000Z'),
      }),
    ).toThrow(/缺少唯一 monitor\/direction 归因/);
    expect(runtime.closedOrderIds.has('SELL-PROTECTIVE-MISSING-MONITOR')).toBe(false);
    expect(refreshNeeds).toEqual([]);
    expect(orderStateEvents).toEqual([]);
  });

  it('records original liquidation symbol when protective sell settlement updates episode progress', () => {
    const runtime = createRuntime();
    const orderStateEvents: OrderStateChangedEvent[] = [];
    const recordedProgressPayloads: Array<{
      direction: 'LONG' | 'SHORT';
      symbol: string;
      executedTimeMs: number;
    }> = [];
    const settlementFlow = createSettlementFlow({
      runtime,
      orderHoldRegistry: createOrderHoldRegistry(),
      orderRecorder: createOrderRecorderDouble({
        markSellFilled: () => null,
      }),
      dailyLossTracker: createDailyLossTrackerDouble({
        recordCumulativeExecution: () => ({
          authoritativeFactChanged: true,
          executionAdvanced: true,
        }),
      }),
      persistProtectiveLiquidationExecutionProgress: () => {},
      protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble({
        recordProtectiveFillProgress: (params) => {
          recordedProgressPayloads.push(params);
        },
      }),
      postTradeConsistencyRuntime: {
        recordSettlementRefreshNeed: () => {},
      },
      emitOrderStateChanged: (event) => {
        orderStateEvents.push(event);
      },
    });

    const result = settlementFlow.settleOrder({
      orderId: 'PL-SETTLEMENT-001',
      closedReason: 'FILLED',
      source: 'WS',
      symbol: 'BULL.OLD.HK',
      side: 'SELL',
      monitorSymbol: 'HSI.HK',
      isLongSymbol: true,
      isProtectiveLiquidation: true,
      executedPrice: 1.03,
      executedQuantity: 100,
      executedTimeMs: Date.parse('2026-02-25T03:11:00.000Z'),
      orderUpdatedAtMs: Date.parse('2026-02-25T03:11:00.000Z'),
    });

    expect(result.handled).toBe(true);
    expect(recordedProgressPayloads).toEqual([
      {
        direction: 'LONG',
        symbol: 'BULL.OLD.HK',
        executedTimeMs: Date.parse('2026-02-25T03:11:00.000Z'),
      },
    ]);

    expect(orderStateEvents).toEqual([
      {
        orderId: 'PL-SETTLEMENT-001',
        symbol: 'BULL.OLD.HK',
        side: 'SELL',
        source: 'WS',
        status: 'FILLED',
        monitorSymbol: 'HSI.HK',
        isLongSymbol: true,
        isProtectiveLiquidation: true,
        executedPrice: 1.03,
        executedQuantity: 100,
        executedTimeMs: Date.parse('2026-02-25T03:11:00.000Z'),
      },
    ]);
  });

  it('settlement 在关闭最后一个订单时移除 symbol bucket 并销毁 route state', () => {
    const runtime = createRuntime();
    runtime.trackedOrders.set('SELL-ROUTE-CLOSE-1', {
      orderId: 'SELL-ROUTE-CLOSE-1',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: OrderType.ELO,
      submittedPrice: 1,
      initialSubmittedPrice: 1,
      submittedQuantity: 100,
      executedQuantity: 0,
      executedPrice: null,
      lastExecutedTimeMs: null,
      lastOrderUpdateAtMs: null,
      status: OrderStatus.New,
      submittedAt: Date.parse('2026-02-25T03:00:00.000Z'),
      lastPriceUpdateAt: Date.parse('2026-02-25T03:00:00.000Z'),
      convertedToMarket: false,
      nextCancelAttemptAt: Date.parse('2026-02-25T03:00:00.000Z'),
      cancelRetryCount: 0,
      replaceCapability: 'SUPPORTED',
      replaceBlockedUntilAt: null,
      quoteRetryAttempts: 0,
      quoteRetryNextAt: null,
      quoteRetryExhausted: false,
      replaceTempBlockedCount: 0,
      replaceResumeMode: 'TIME_BACKOFF',
      timeoutMarketConversionPending: false,
      timeoutMarketConversionTerminalState: null,
    });
    runtime.trackedOrderIdsBySymbol.set('BULL.HK', new Set(['SELL-ROUTE-CLOSE-1']));
    runtime.routeStatesBySymbol.set('BULL.HK', {
      symbol: 'BULL.HK',
      generation: 1,
      inFlight: false,
      dirty: false,
      latestQuote: null,
      pendingWakeupKind: null,
      timerHandles: new Map(),
    });
    const settlementFlow = createSettlementFlow({
      runtime,
      orderHoldRegistry: createOrderHoldRegistry(),
      orderRecorder: createOrderRecorderDouble({
        markSellCancelled: () => ({
          orderId: 'SELL-ROUTE-CLOSE-1',
          symbol: 'BULL.HK',
          direction: 'LONG',
          submittedQuantity: 100,
          filledQuantity: 0,
          relatedBuyOrderIds: [],
          status: 'cancelled',
          submittedAt: Date.parse('2026-02-25T03:00:00.000Z'),
        }),
      }),
      dailyLossTracker: createDailyLossTrackerDouble(),
      persistProtectiveLiquidationExecutionProgress: () => {},
      protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
      postTradeConsistencyRuntime: {
        recordSettlementRefreshNeed: () => {},
      },
      emitOrderStateChanged: () => {},
    });

    const result = settlementFlow.settleOrder({
      orderId: 'SELL-ROUTE-CLOSE-1',
      closedReason: 'CANCELED',
      source: 'WS',
    });

    expect(result.handled).toBe(true);
    expect(runtime.trackedOrderIdsBySymbol.has('BULL.HK')).toBe(false);
    expect(runtime.routeStatesBySymbol.has('BULL.HK')).toBe(false);
  });
});
