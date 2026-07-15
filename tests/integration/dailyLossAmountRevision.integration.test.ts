/**
 * DailyLoss 金额修订链路集成测试。
 *
 * 覆盖保护性卖单在数量不变、权威 revision 提高成交金额时，
 * WS → DailyLoss → progress 持久化 → 风险刷新以及 crash-gap baseline 的一致性。
 */
import { describe, expect, it } from 'bun:test';
import { OrderSide, OrderStatus, OrderType } from 'longbridge';
import { createTradingConfig } from '../../mock/factories/configFactory.js';
import { createPushOrderChanged } from '../../mock/factories/tradeFactory.js';
import { createPostTradeConsistencyRuntime } from '../../src/app/runtime/createPostTradeConsistencyRuntime.js';
import { createDailyLossOrderAnalysisDeps } from '../../src/core/orderRecorder/index.js';
import { createDailyLossTracker } from '../../src/core/riskController/dailyLossTracker.js';
import { createEventFlow } from '../../src/core/trader/orderMonitor/eventFlow.js';
import { createSettlementFlow } from '../../src/core/trader/orderMonitor/settlementFlow.js';
import { createProtectiveLiquidationEpisodeTracker } from '../../src/core/trader/protectiveLiquidationEpisodeTracker/index.js';
import type {
  OrderMonitorRuntimeStore,
  OrderMonitorTrackedOrder,
} from '../../src/core/trader/orderMonitor/types.js';
import type { OrderHoldRegistry } from '../../src/core/trader/types.js';
import type { RawOrderFromAPI } from '../../src/types/services.js';
import type { LastState } from '../../src/types/state.js';
import { toHongKongTimeIso } from '../../src/utils/time/index.js';
import {
  createLiquidationCooldownTrackerDouble,
  createMonitorContextDouble,
  createOrderRecorderDouble,
  createPositionCacheDouble,
  createRiskCheckerDouble,
  createTraderDouble,
} from '../helpers/testDoubles.js';

function createRuntime(): OrderMonitorRuntimeStore {
  return {
    trackedOrders: new Map(),
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
    running: true,
    unsubscribeQuoteUpdated: null,
  };
}

function createOrderHoldRegistry(): OrderHoldRegistry {
  return {
    trackOrder: () => {},
    markOrderClosed: () => {},
    seedFromOrders: () => {},
    getHoldSymbols: () => new Set(),
    onOrderHoldSymbolsChanged: () => () => {},
    clear: () => {},
  };
}

function createLastState(): LastState {
  return {
    canTrade: true,
    isHalfDay: false,
    openProtectionActive: false,
    currentDayKey: '2026-07-11',
    lifecycleState: 'ACTIVE',
    pendingOpenRebuild: false,
    targetTradingDayKey: null,
    isTradingEnabled: true,
    cachedAccount: null,
    cachedPositions: [],
    positionCache: createPositionCacheDouble(),
    cachedTradingDayInfo: null,
    tradingCalendarSnapshot: new Map(),
    monitorState: {
      monitorSymbol: 'HSI.HK',
      lastMonitorSnapshot: null,
      incrementalIndicatorRuntime: null,
    },
    allTradingSymbols: new Set(),
  };
}

function createProtectiveTrackedOrder(revisionMs: number): OrderMonitorTrackedOrder {
  return {
    orderId: 'PROTECTIVE-AMOUNT-REVISION',
    symbol: 'BULL.HK',
    side: OrderSide.Sell,
    isLongSymbol: true,
    monitorSymbol: 'HSI.HK',
    isProtectiveLiquidation: true,
    orderType: OrderType.ELO,
    submittedPrice: 9,
    initialSubmittedPrice: 9,
    submittedQuantity: 5,
    executedQuantity: 0,
    executedPrice: null,
    lastExecutedTimeMs: null,
    lastOrderUpdateAtMs: null,
    status: OrderStatus.New,
    submittedAt: revisionMs - 10,
    lastPriceUpdateAt: revisionMs - 10,
    convertedToMarket: false,
    nextCancelAttemptAt: revisionMs,
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

describe('DailyLoss protective amount revision integration', () => {
  it('persists an unsealed same-quantity amount revision, refreshes risk, and preserves its crash-gap baseline', () => {
    const firstRevisionMs = Date.parse('2026-07-11T02:00:00.000Z');
    const secondRevisionMs = firstRevisionMs + 1_000;
    const runtime = createRuntime();
    const dailyLossTracker = createDailyLossTracker({
      ...createDailyLossOrderAnalysisDeps(),
      resolveOrderOwnership: () => null,
      toHongKongTimeIso,
    });
    dailyLossTracker.resetAll(new Date('2026-07-11T01:00:00.000Z'));
    dailyLossTracker.recordCumulativeExecution({
      factStage: 'TERMINAL',
      direction: 'LONG',
      symbol: 'BULL.HK',
      side: OrderSide.Buy,
      executedPrice: 10,
      executedQuantity: 5,
      executedTimeMs: firstRevisionMs - 1,
      orderUpdatedAtMs: firstRevisionMs - 1,
      orderId: 'BUY-AMOUNT-REVISION-COST',
    });

    const protectiveLiquidationEpisodeTracker = createProtectiveLiquidationEpisodeTracker();
    const persistedProgress: Array<{
      readonly factStage: 'OPEN' | 'TERMINAL';
      readonly cumulativeQuantity: string;
      readonly cumulativeAmount: string;
      readonly lastExecutionTimeMs: number;
      readonly orderRevisionMs: number;
    }> = [];
    let refreshCount = 0;
    const settlementFlow = createSettlementFlow({
      runtime,
      orderHoldRegistry: createOrderHoldRegistry(),
      orderRecorder: createOrderRecorderDouble(),
      dailyLossTracker,
      protectiveLiquidationEpisodeTracker,
      persistProtectiveLiquidationExecutionProgress: (progress) => {
        persistedProgress.push({
          factStage: progress.factStage,
          cumulativeQuantity: progress.cumulativeQuantity,
          cumulativeAmount: progress.cumulativeAmount,
          lastExecutionTimeMs: progress.lastExecutionTimeMs,
          orderRevisionMs: progress.orderRevisionMs,
        });
      },
      postTradeConsistencyRuntime: {
        recordSettlementRefreshNeed: () => {
          refreshCount += 1;
        },
      },
      emitOrderStateChanged: () => {},
    });
    const trackedOrder = createProtectiveTrackedOrder(firstRevisionMs);
    runtime.trackedOrders.set(trackedOrder.orderId, trackedOrder);
    const eventFlow = createEventFlow({
      runtime,
      orderRecorder: createOrderRecorderDouble(),
      recordCumulativeExecution: (params) => {
        settlementFlow.recordCumulativeExecution(params);
      },
      prepareProtectiveTerminalExecution: settlementFlow.prepareProtectiveTerminalExecution,
      settleOrder: settlementFlow.settleOrder,
      cacheBootstrappingEvent: () => {},
      triggerRoute: () => {},
    });

    eventFlow.handleOrderChangedWhenActive(
      createPushOrderChanged({
        orderId: trackedOrder.orderId,
        symbol: trackedOrder.symbol,
        side: trackedOrder.side,
        status: OrderStatus.PartialFilled,
        executedQuantity: 5,
        executedPrice: 9,
        updatedAtMs: firstRevisionMs,
      }),
    );

    eventFlow.handleOrderChangedWhenActive(
      createPushOrderChanged({
        orderId: trackedOrder.orderId,
        symbol: trackedOrder.symbol,
        side: trackedOrder.side,
        status: OrderStatus.PartialFilled,
        executedQuantity: 5,
        executedPrice: 9.4,
        updatedAtMs: secondRevisionMs,
      }),
    );

    expect(dailyLossTracker.getLossOffset('LONG')).toBe(-3);
    expect(persistedProgress).toEqual([
      {
        factStage: 'OPEN',
        cumulativeQuantity: '5',
        cumulativeAmount: '45',
        lastExecutionTimeMs: firstRevisionMs,
        orderRevisionMs: firstRevisionMs,
      },
      {
        factStage: 'OPEN',
        cumulativeQuantity: '5',
        cumulativeAmount: '47',
        lastExecutionTimeMs: firstRevisionMs,
        orderRevisionMs: secondRevisionMs,
      },
    ]);
    expect(refreshCount).toBe(2);
    expect(protectiveLiquidationEpisodeTracker.getInProgressEpisodes()).toEqual([
      {
        direction: 'LONG',
        symbol: 'BULL.HK',
        latestExecutedTimeMs: firstRevisionMs,
      },
    ]);

    const restartedTracker = createDailyLossTracker({
      ...createDailyLossOrderAnalysisDeps(),
      resolveOrderOwnership: () => ({ monitorSymbol: 'HSI.HK', direction: 'LONG' }),
      toHongKongTimeIso,
    });
    const currentOrder: RawOrderFromAPI = {
      orderId: trackedOrder.orderId,
      symbol: trackedOrder.symbol,
      stockName: trackedOrder.symbol,
      side: OrderSide.Sell,
      status: OrderStatus.PartialFilled,
      orderType: OrderType.ELO,
      remark: null,
      price: 9.4,
      quantity: 5,
      executedPrice: 9.4,
      executedQuantity: 5,
      submittedAt: new Date(firstRevisionMs),
      updatedAt: new Date(secondRevisionMs),
    };
    restartedTracker.recalculateFromAllOrders(
      [currentOrder],
      createTradingConfig().monitor,
      new Date(secondRevisionMs),
      new Map(),
    );

    restartedTracker.restoreExecutionSnapshot({
      factStage: 'OPEN',
      direction: 'LONG',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      orderId: trackedOrder.orderId,
      cumulativeQuantity: '5',
      cumulativeAmount: '47',
      lastExecutionTimeMs: firstRevisionMs,
      orderRevisionMs: secondRevisionMs,
    });

    expect(
      restartedTracker.prepareProtectionBoundary({
        direction: 'LONG',
        boundaryExecutedTimeMs: firstRevisionMs,
      }).orderBaselines,
    ).toEqual([
      {
        orderId: trackedOrder.orderId,
        symbol: 'BULL.HK',
        side: 'SELL',
        cumulativeQuantity: '5',
        cumulativeAmount: '47',
        lastExecutionTimeMs: firstRevisionMs,
        orderRevisionMs: secondRevisionMs,
      },
    ]);
  });

  it('does not rewrite a completion sealed by the real post-trade path with a late pre-boundary revision', async () => {
    const firstRevisionMs = Date.parse('2026-07-11T02:10:00.000Z');
    const secondRevisionMs = firstRevisionMs + 1_000;
    const dailyLossTracker = createDailyLossTracker({
      ...createDailyLossOrderAnalysisDeps(),
      resolveOrderOwnership: () => null,
      toHongKongTimeIso,
    });
    dailyLossTracker.resetAll(new Date('2026-07-11T01:00:00.000Z'));
    const protectiveLiquidationEpisodeTracker = createProtectiveLiquidationEpisodeTracker();
    const persistedProgress: Array<{
      readonly factStage: 'OPEN' | 'TERMINAL';
      readonly cumulativeAmount: string;
      readonly orderRevisionMs: number;
    }> = [];
    const completionBoundaryMs: number[] = [];
    const orderRecorder = createOrderRecorderDouble();
    const trader = createTraderDouble({
      orderRecorder,
      getStockPositions: async () => [],
      hasPendingProtectiveLiquidationOrders: () => false,
    });
    const lastState = createLastState();
    const postTradeConsistencyRuntime = createPostTradeConsistencyRuntime({
      getTrader: () => trader,
      lastState,
      onPositionsCommitted: async () => {},
    });
    const monitorContext = createMonitorContextDouble({
      config: createTradingConfig().monitor,
      orderRecorder,
      dailyLossTracker,
      riskChecker: createRiskCheckerDouble({
        refreshUnrealizedLossData: async () => ({ r1: 1, n1: 1 }),
      }),
    });
    postTradeConsistencyRuntime.bindBusinessDeps({
      monitorContext,
      dailyLossTracker,
      liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
      protectiveLiquidationEpisodeTracker,
      mixedTradeLogRepository: {
        appendCompletionIdempotent: (completion) => {
          completionBoundaryMs.push(completion.boundaryExecutedTimeMs);
          return 'APPENDED';
        },
      },
    });
    const settlementFlow = createSettlementFlow({
      runtime: createRuntime(),
      orderHoldRegistry: createOrderHoldRegistry(),
      orderRecorder,
      dailyLossTracker,
      protectiveLiquidationEpisodeTracker,
      persistProtectiveLiquidationExecutionProgress: (progress) => {
        persistedProgress.push({
          factStage: progress.factStage,
          cumulativeAmount: progress.cumulativeAmount,
          orderRevisionMs: progress.orderRevisionMs,
        });
      },
      postTradeConsistencyRuntime,
      emitOrderStateChanged: () => {},
    });

    postTradeConsistencyRuntime.start();
    settlementFlow.recordCumulativeExecution({
      factStage: 'OPEN',
      orderId: 'SEALED-PROTECTIVE-AMOUNT-REVISION',
      side: 'SELL',
      monitorSymbol: 'HSI.HK',
      symbol: 'BULL.HK',
      isLongSymbol: true,
      isProtectiveLiquidation: true,
      executedPrice: 9,
      executedQuantity: 5,
      executedTimeMs: firstRevisionMs,
      orderUpdatedAtMs: firstRevisionMs,
    });
    await postTradeConsistencyRuntime.waitForFresh();
    await postTradeConsistencyRuntime.stopAndDrain();
    const statusAfterCompletion = postTradeConsistencyRuntime.getStatus();

    const revisionResult = settlementFlow.recordCumulativeExecution({
      factStage: 'TERMINAL',
      orderId: 'SEALED-PROTECTIVE-AMOUNT-REVISION',
      side: 'SELL',
      monitorSymbol: 'HSI.HK',
      symbol: 'BULL.HK',
      isLongSymbol: true,
      isProtectiveLiquidation: true,
      executedPrice: 9.4,
      executedQuantity: 5,
      executedTimeMs: firstRevisionMs,
      orderUpdatedAtMs: secondRevisionMs,
    });

    expect(revisionResult).toEqual({ authoritativeFactChanged: false, executionAdvanced: false });
    expect(persistedProgress).toEqual([
      {
        factStage: 'OPEN',
        cumulativeAmount: '45',
        orderRevisionMs: firstRevisionMs,
      },
    ]);
    expect(completionBoundaryMs).toEqual([firstRevisionMs]);
    expect(protectiveLiquidationEpisodeTracker.getInProgressEpisodes()).toEqual([]);
    expect([
      ...protectiveLiquidationEpisodeTracker.getLatestProtectionBoundaryByDirection().entries(),
    ]).toEqual([['LONG', firstRevisionMs]]);
    expect(postTradeConsistencyRuntime.getStatus()).toEqual(statusAfterCompletion);
  });
});
