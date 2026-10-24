import { recalculateDailyLoss } from '../helpers/dailyLossRecalculation.js';
import { createDiagnosticObserverDouble } from '../helpers/diagnostics.js';
import {
  createLoggerDouble,
  createLiquidationCooldownTrackerDouble,
  createMonitorContextDouble,
  createRateLimiterDouble,
  createRiskCheckerDouble,
  createTerminationDouble,
  createTradeRuntimeDouble,
} from '../helpers/testDoubles.js';

/**
 * DailyLoss 金额修订链路集成测试。
 *
 * 覆盖保护性卖单在数量不变、权威 revision 提高成交金额时，
 * WS → DailyLoss → progress 持久化 → 风险刷新以及 crash-gap baseline 的一致性。
 */

import { describe, expect, it } from 'bun:test';
import { createTradingConfig } from '../../mock/factories/configFactory.js';
import { createPostTradeConsistencyRuntime } from '../../src/app/runtime/createPostTradeConsistencyRuntime.js';
import { createAccountPositionSnapshot } from '../../src/application/accountPositionSnapshot/index.js';
import { createEventFlow as createProductionEventFlow } from '../../src/application/orderTracking/orderMonitor/eventFlow.js';
import { createSettlementFlow } from '../../src/application/orderTracking/orderMonitor/settlementFlow.js';
import type {
  EventFlowDeps,
  OrderMonitorRuntimeStore,
} from '../../src/application/orderTracking/orderMonitor/types.js';
import type { OrderHoldRegistry } from '../../src/application/orderTracking/types.js';
import { createProtectiveLiquidationEpisodeTracker } from '../../src/domain/liquidation/episode/index.js';
import { orderAnalysis } from '../../src/domain/order/orderAnalysis.js';
import type { OrderMonitorTrackedOrder } from '../../src/domain/order/types.js';
import { createDailyLossTracker } from '../../src/domain/risk/dailyLossTracker.js';
import type { OrderFact } from '../../src/types/trade.js';
import { toHongKongTimeIso } from '../../src/utils/time/index.js';

import { createBrokerIngressFixture } from './architectureRefactoringP1Native/trade/brokerIngressFixture.js';
import { toRecalculationOrders } from './recalculationOrders.js';

type TestEventFlowDeps = Omit<EventFlowDeps, 'now' | 'monitorConfig'> &
  Partial<Pick<EventFlowDeps, 'now'>>;

function createEventFlow(deps: TestEventFlowDeps) {
  return createProductionEventFlow({
    now: () => new Date('2031-01-02T03:04:05.000Z'),
    monitorConfig: createTradingConfig().monitor,
    ...deps,
  });
}

function createRuntime(): OrderMonitorRuntimeStore {
  return {
    trackedOrders: new Map(),
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

function createProtectiveTrackedOrder(
  revisionMs: number,
  native: OrderFact,
): OrderMonitorTrackedOrder {
  return {
    orderId: 'PROTECTIVE-AMOUNT-REVISION',
    symbol: 'BULL.HK',
    side: native.executionSide,
    executionSide: 'SELL',
    isLongSymbol: true,
    monitorSymbol: 'HSI.HK',
    isProtectiveLiquidation: true,
    orderType: native.orderType,
    submittedPrice: '9',
    initialSubmittedPrice: '9',
    submittedQuantity: 5,
    executedQuantity: 0,
    executedAmount: '0',
    executedPrice: null,
    lastExecutedTimeMs: null,
    lastOrderUpdateAtMs: null,
    status: native.status,
    executionPhase: native.executionPhase,
    submittedAt: revisionMs - 10,
    lastPriceUpdateAt: revisionMs - 10,
    convertedToMarket: false,
    nextCancelAttemptAt: revisionMs,
    cancelRetryCount: 0,
    replaceCapability: 'SUPPORTED',
    replaceBlockedUntilAt: null,
    quoteRetryAttempts: 0,
    quoteRetryNextAt: null,
    replaceTempBlockedCount: 0,
    replaceResumeMode: 'TIME_BACKOFF',
    timeoutMarketConversionPending: false,
    timeoutMarketConversionTerminalState: null,
  };
}

async function createAmountActors(
  revisionMs: number,
  dailyLossTracker: ReturnType<typeof createDailyLossTracker>,
  protectiveLiquidationEpisodeTracker: ReturnType<typeof createProtectiveLiquidationEpisodeTracker>,
  appendCompletion: (boundary: number) => void,
  flat: boolean,
  onRefresh: () => void,
) {
  const native = await createBrokerIngressFixture({
    orderId: 'BUY-AMOUNT-REVISION-COST',
    symbol: 'BULL.HK',
    stockName: 'HSI BULL',
    remark: '',
    side: 'BUY',
    status: 'Filled',
    orderType: 'ELO',
    quantity: '5',
    executedQuantity: '5',
    submittedPrice: '10',
    executedPrice: '10',
    submittedAtMs: revisionMs - 10,
    updatedAtMs: revisionMs - 1,
  });
  native.setAccountBalance({
    currency: 'HKD',
    totalCash: '10000',
    netAssets: flat ? '10000' : '10050',
    availableCash: '10000',
  });

  native.setStockPositions(
    flat
      ? []
      : [
          {
            symbol: 'BULL.HK',
            symbolName: 'BULL',
            accountChannel: 'lb_papertrading',
            currency: 'HKD',
            quantity: '5',
            availableQuantity: '5',
            costPrice: '10',
          },
        ],
  );
  const account = native.createAccountService({ rateLimiter: createRateLimiterDouble() });
  const snapshot = createAccountPositionSnapshot({
    clock: { now: () => new Date() },
    diagnostics: createDiagnosticObserverDouble(),
    dayEpoch: 1,
    readPort: account,
    scheduler: { schedule: queueMicrotask },
    reportFatalError: (error) => {
      throw error;
    },
  });
  const committed = await snapshot.requestRefresh({
    source: 'amount-revision-baseline',
    dayEpoch: 1,
    refreshAccount: true,
    refreshPositions: true,
  }).result;
  if (committed.status !== 'COMMITTED') throw new Error('expected actual paired baseline');

  let boundTrader: ReturnType<typeof createTradeRuntimeDouble> | null = null;
  const postTrade = createPostTradeConsistencyRuntime({
    diagnostics: createDiagnosticObserverDouble(),
    clock: { now: () => new Date() },
    logger: createLoggerDouble(),
    snapshot,
    termination: createTerminationDouble(),
    getProtectiveOrderReader: () => {
      if (boundTrader === null) throw new Error('unbound tradeRuntime');

      return boundTrader.orderMonitor;
    },
    onPositionsCommitted: async (token) => {
      if (!snapshot.isCurrent(token, { account: false, positions: true }))
        throw new Error('stale commit');
    },
    scheduler: { scheduleTimer: setTimeout, clearTimer: clearTimeout },
  });
  const orderRecorder = native.createRecorder({
    logger: createLoggerDouble(),
    rateLimiter: createRateLimiterDouble(),
    settlementRefreshNeedRecorder: {
      recordSettlementRefreshNeed: (need) => {
        onRefresh();
        postTrade.recordSettlementRefreshNeed(need);
      },
    },
  });
  const config = createTradingConfig().monitor;
  dailyLossTracker.publishRecalculation(
    dailyLossTracker.prepareRecalculationFromAllOrders(
      [],
      config,
      new Date(revisionMs),
      undefined,
      new Set(['BULL.HK']),
    ),
  );

  orderRecorder.commitExecutionFact(
    {
      brokerOrderId: 'BUY-AMOUNT-REVISION-COST',
      symbol: 'BULL.HK',
      side: 'BUY',
      cumulativeQuantity: 5,
      cumulativeAmount: '50',
      executionTimeMs: revisionMs - 1,
      updatedAtMs: revisionMs - 1,
      phase: 'TERMINAL',
    },
    true,
    [],
    () =>
      dailyLossTracker.recordCumulativeExecution({
        factStage: 'TERMINAL',
        direction: 'LONG',
        symbol: 'BULL.HK',
        side: 'BUY',
        executedPrice: '10',
        executedQuantity: 5,
        executedTimeMs: revisionMs - 1,
        orderUpdatedAtMs: revisionMs - 1,
        orderId: 'BUY-AMOUNT-REVISION-COST',
      }).admission,
  );
  const tradeRuntime = createTradeRuntimeDouble({
    ...account,
    orderRecorder,
    orderExecutor: {
      executeSignals: async () => {
        throw new Error('revision facts never submit');
      },
    },
    orderMonitor: { hasPendingProtectiveLiquidationOrders: () => false },
  });
  boundTrader = tradeRuntime;
  const monitorContext = createMonitorContextDouble({
    config,
    orderRecorder,
    dailyLossTracker,
    riskChecker: createRiskCheckerDouble(),
  });
  postTrade.bindBusinessDeps({
    monitorContext,
    dailyLossTracker,
    protectiveLiquidationEpisodeTracker,
    liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
    mixedTradeLogRepository: {
      appendCompletionIdempotent: (completion) => {
        appendCompletion(completion.boundaryExecutedTimeMs);
      },
    },
  });
  // 上面的真实 BUY 提交已使初始 paired token 失效；baseline owner 必须先取得当前事实，不由 S 隐式补读。
  const rebuilt = await snapshot.requestRefresh({
    source: 'amount-revision-current-baseline',
    dayEpoch: 1,
    refreshAccount: true,
    refreshPositions: true,
  }).result;
  expect(rebuilt.status).toBe('COMMITTED');
  postTrade.start();
  expect(await postTrade.completeRebuildBaseline()).toBeTrue();
  const receipt = await postTrade.waitForFresh();
  expect(receipt.snapshotToken.dayEpoch).toBe(committed.snapshotToken.dayEpoch);
  expect(
    snapshot.isCurrent(receipt.snapshotToken, { account: true, positions: true, paired: true }),
  ).toBeTrue();
  expect(postTrade.isCurrent(receipt)).toBeTrue();
  const sellFrame = {
    orderId: 'PROTECTIVE-AMOUNT-REVISION',
    symbol: 'BULL.HK',
    stockName: 'HSI BULL',
    remark: '',
    side: 'SELL' as const,
    status: 'New' as const,
    orderType: 'ELO' as const,
    quantity: '5',
    executedQuantity: '0',
    submittedPrice: '9',
    executedPrice: '0',
    submittedAtMs: revisionMs - 10,
    updatedAtMs: revisionMs,
  };
  native.setOrderDetailReplies([sellFrame]);
  const [newSell] = await native.createQueryOrdersReader(sellFrame.orderId)();
  if (newSell === undefined) throw new Error('expected native new SELL fact');

  return { native, sellFrame, newSell, postTrade, snapshot, orderRecorder, monitorContext };
}

describe('DailyLoss protective amount revision integration', () => {
  it('keeps a live same-revision OPEN→TERMINAL amount correction legal while persisting progress before DailyLoss and episode', async () => {
    const revision = Date.parse('2026-07-11T02:05:00.000Z');
    const daily = createDailyLossTracker({
      onOwnershipWarning: () => {},
      ...orderAnalysis,
      resolveOrderOwnership: () => null,
      toHongKongTimeIso,
    });
    daily.resetAll(new Date('2026-07-11T01:00:00.000Z'));
    const episode = createProtectiveLiquidationEpisodeTracker();
    const actors = await createAmountActors(
      revision,
      daily,
      episode,
      () => {
        throw new Error('held positions must not complete');
      },
      false,
      () => {},
    );
    const progress: Array<{ readonly phase: 'OPEN' | 'TERMINAL'; readonly amount: string }> = [];
    const flow = createSettlementFlow({
      diagnostics: createDiagnosticObserverDouble(),
      now: () => new Date(),
      runtime: createRuntime(),
      orderHoldRegistry: createOrderHoldRegistry(),
      orderRecorder: actors.orderRecorder,
      dailyLossTracker: daily,
      protectiveLiquidationEpisodeTracker: episode,
      persistProtectiveLiquidationExecutionProgress: (record) => {
        expect(daily.getLossOffset('LONG')).toBe(progress.length === 0 ? '0' : '-5');
        expect(episode.getInProgressEpisodes()).toHaveLength(progress.length === 0 ? 0 : 1);
        progress.push({ phase: record.factStage, amount: record.cumulativeAmount });
      },
      postTradeConsistencyRuntime: actors.postTrade,
      emitOrderStateChanged: () => {},
    });
    try {
      for (const [status, price, phase] of [
        ['PartialFilled', '9', 'OPEN'],
        ['Filled', '9.4', 'TERMINAL'],
      ] as const) {
        actors.native.setOrderDetailReplies([
          {
            ...actors.sellFrame,
            status,
            executedPrice: price,
            executedQuantity: '5',
            updatedAtMs: revision,
          },
        ]);
        const [observation] = await actors.native.createQueryOrdersReader(
          actors.sellFrame.orderId,
        )();
        if (observation === undefined) throw new Error('Expected actual live revision observation');

        if (observation.executedAmount === null)
          throw new Error('Expected positive cumulative amount on live revision');

        const result = flow.recordCumulativeExecution({
          factStage: phase,
          orderId: observation.orderId,
          side: 'SELL',
          monitorSymbol: 'HSI.HK',
          symbol: observation.symbol,
          isLongSymbol: true,
          isProtectiveLiquidation: true,
          executedPrice: observation.executedPrice,
          executedAmount: observation.executedAmount,
          executedQuantity: observation.executedQuantity,
          executedTimeMs: observation.executionTimeMs,
          orderUpdatedAtMs: observation.updatedAtMs,
        });
        expect(result.authoritativeFactChanged).toBe(true);
        expect(result.executionAdvanced).toBe(phase === 'OPEN');
      }

      await actors.postTrade.waitForFresh();
      expect(progress).toEqual([
        { phase: 'OPEN', amount: '45' },
        { phase: 'TERMINAL', amount: '47' },
      ]);
      expect(daily.getLossOffset('LONG')).toBe('-3');
      expect(actors.orderRecorder.getExecutionFact(actors.sellFrame.orderId)).toMatchObject({
        phase: 'TERMINAL',
        cumulativeQuantity: 5,
        cumulativeAmount: '47',
        updatedAtMs: revision,
        executionTimeMs: revision,
      });
    } finally {
      await actors.postTrade.stopAndDrain();
      await actors.snapshot.requestClear({ reason: 'STOP', dayEpoch: 1 });
    }
  });

  it('persists an unsealed same-quantity amount revision, refreshes risk, and preserves its crash-gap baseline', async () => {
    const firstRevisionMs = Date.parse('2026-07-11T02:00:00.000Z');
    const secondRevisionMs = firstRevisionMs + 1_000;
    const runtime = createRuntime();
    const dailyLossTracker = createDailyLossTracker({
      onOwnershipWarning: () => {},
      ...orderAnalysis,
      resolveOrderOwnership: () => null,
      toHongKongTimeIso,
    });
    dailyLossTracker.resetAll(new Date('2026-07-11T01:00:00.000Z'));

    const protectiveLiquidationEpisodeTracker = createProtectiveLiquidationEpisodeTracker();
    const persistedProgress: Array<{
      readonly factStage: 'OPEN' | 'TERMINAL';
      readonly cumulativeQuantity: string;
      readonly cumulativeAmount: string;
      readonly lastExecutionTimeMs: number;
      readonly orderRevisionMs: number;
    }> = [];
    let refreshCount = 0;
    const actors = await createAmountActors(
      firstRevisionMs,
      dailyLossTracker,
      protectiveLiquidationEpisodeTracker,
      () => {
        throw new Error('held positions must not complete');
      },
      false,
      () => {
        refreshCount += 1;
      },
    );
    refreshCount = 0;
    const settlementFlow = createSettlementFlow({
      diagnostics: createDiagnosticObserverDouble(),
      now: () => new Date(),
      runtime,
      orderHoldRegistry: createOrderHoldRegistry(),
      orderRecorder: actors.orderRecorder,
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
        recordSettlementRefreshNeed: (need) => {
          actors.postTrade.recordSettlementRefreshNeed(need);
        },
      },
      emitOrderStateChanged: () => {},
    });
    const trackedOrder = createProtectiveTrackedOrder(firstRevisionMs, actors.newSell);
    runtime.trackedOrders.set(trackedOrder.orderId, trackedOrder);
    const eventFlow = createEventFlow({
      diagnostics: createDiagnosticObserverDouble(),
      logger: createLoggerDouble(),
      runtime,
      orderRecorder: actors.orderRecorder,
      recordCumulativeExecution: (params) => {
        settlementFlow.recordCumulativeExecution(params);
      },
      prepareProtectiveTerminalExecution: settlementFlow.prepareProtectiveTerminalExecution,
      settleOrder: settlementFlow.settleOrder,
      cacheBootstrappingEvent: () => {},
      triggerRoute: () => {},
    });

    for (const [revision, price, amount] of [
      [firstRevisionMs, '9', '45'],
      [secondRevisionMs, '9.4', '47'],
    ] as const) {
      actors.native.createPushPort().setOnOrderChanged((error, decoder) => {
        if (error !== null) throw error;

        const fact = decoder.decode();

        if (fact === null) throw new Error('expected HK order push fact');

        expect(fact.executedAmount).toBe(amount);
        eventFlow.handleOrderChangedWhenActive(fact);
      });

      actors.native.emitOrderChangedFrame({
        ...actors.sellFrame,
        status: 'PartialFilled',
        executedQuantity: '5',
        executedPrice: price,
        updatedAtMs: revision,
      });
    }

    await actors.postTrade.waitForFresh();
    expect(dailyLossTracker.getLossOffset('LONG')).toBe('-3');
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
      onOwnershipWarning: () => {},
      ...orderAnalysis,
      resolveOrderOwnership: () => ({ monitorSymbol: 'HSI.HK', direction: 'LONG' }),
      toHongKongTimeIso,
    });
    actors.native.setOrderDetailReplies([
      {
        ...actors.sellFrame,
        status: 'PartialFilled',
        executedQuantity: '5',
        executedPrice: '9.4',
        updatedAtMs: secondRevisionMs,
      },
    ]);
    const [currentOrder] = await actors.native.createQueryOrdersReader(trackedOrder.orderId)();
    if (currentOrder === undefined) throw new Error('expected actual revised order');

    recalculateDailyLoss(
      restartedTracker,
      toRecalculationOrders([currentOrder]),
      createTradingConfig().monitor,
      new Date(secondRevisionMs),
      new Map(),
      undefined,
      {
        executionSnapshots: [
          {
            factStage: 'OPEN',
            direction: 'LONG',
            symbol: 'BULL.HK',
            side: 'SELL',
            orderId: trackedOrder.orderId,
            cumulativeQuantity: '5',
            cumulativeAmount: '47',
            lastExecutionTimeMs: firstRevisionMs,
            orderRevisionMs: secondRevisionMs,
          },
        ],
        boundaries: [],
      },
    );

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
    await actors.postTrade.stopAndDrain();
    await actors.snapshot.requestClear({ reason: 'STOP', dayEpoch: 1 });
  });

  it('does not rewrite a completion sealed by the real post-trade path with a late pre-boundary revision', async () => {
    const firstRevisionMs = Date.parse('2026-07-11T02:10:00.000Z');
    const secondRevisionMs = firstRevisionMs + 1_000;
    const dailyLossTracker = createDailyLossTracker({
      onOwnershipWarning: () => {},
      ...orderAnalysis,
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
    const actors = await createAmountActors(
      firstRevisionMs,
      dailyLossTracker,
      protectiveLiquidationEpisodeTracker,
      (boundary) => {
        completionBoundaryMs.push(boundary);
      },
      true,
      () => {},
    );
    const { orderRecorder, postTrade: postTradeConsistencyRuntime } = actors;
    const settlementFlow = createSettlementFlow({
      diagnostics: createDiagnosticObserverDouble(),
      now: () => new Date(),
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

    actors.native.setOrderDetailReplies([
      {
        ...actors.sellFrame,
        orderId: 'SEALED-PROTECTIVE-AMOUNT-REVISION',
        status: 'PartialFilled',
        executedQuantity: '5',
        executedPrice: '9',
        updatedAtMs: firstRevisionMs,
      },
    ]);
    const [originalObservation] = await actors.native.createQueryOrdersReader(
      'SEALED-PROTECTIVE-AMOUNT-REVISION',
    )();
    if (originalObservation === undefined) throw new Error('missing actual sealed input');

    expect(originalObservation.executedAmount).toBe('45');
    if (originalObservation.executedAmount === null)
      throw new Error('sealed protective input lacks cumulative amount');

    settlementFlow.recordCumulativeExecution({
      factStage: 'OPEN',
      orderId: 'SEALED-PROTECTIVE-AMOUNT-REVISION',
      side: 'SELL',
      monitorSymbol: 'HSI.HK',
      symbol: 'BULL.HK',
      isLongSymbol: true,
      isProtectiveLiquidation: true,
      executedPrice: originalObservation.executedPrice,
      executedAmount: originalObservation.executedAmount,
      executedQuantity: originalObservation.executedQuantity,
      executedTimeMs: originalObservation.executionTimeMs,
      orderUpdatedAtMs: originalObservation.updatedAtMs,
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
      executedPrice: '9.4',
      executedAmount: '47',
      executedQuantity: 5,
      executedTimeMs: firstRevisionMs,
      orderUpdatedAtMs: secondRevisionMs,
    });

    expect(revisionResult).toMatchObject({
      authoritativeFactChanged: true,
      executionAdvanced: false,
    });
    expect(revisionResult.admission).toBe('ADMITTED');
    expect(persistedProgress).toEqual([
      {
        factStage: 'OPEN',
        cumulativeAmount: '45',
        orderRevisionMs: firstRevisionMs,
      },
      {
        factStage: 'TERMINAL',
        cumulativeAmount: '47',
        orderRevisionMs: secondRevisionMs,
      },
    ]);
    expect(dailyLossTracker.getLossOffset('LONG')).toBe('0');
    expect(completionBoundaryMs).toEqual([firstRevisionMs]);
    expect(protectiveLiquidationEpisodeTracker.getInProgressEpisodes()).toEqual([]);
    expect(postTradeConsistencyRuntime.getStatus()).toEqual({
      ...statusAfterCompletion,
      staleVersion: statusAfterCompletion.staleVersion + 1,
    });
    await actors.snapshot.requestClear({ reason: 'STOP', dayEpoch: 1 });
  });
});
