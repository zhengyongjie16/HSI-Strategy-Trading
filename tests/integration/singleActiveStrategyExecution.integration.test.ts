import { scheduleBoundedOneShotAt } from '../../src/runtime/timer/index.js';
import { wrapExternalApiRequest } from '../../src/infrastructure/externalApi/index.js';
import { wait } from '../../src/infrastructure/time/index.js';
import type { TradeRuntime } from '../../src/app/runtime/types.js';

/**
 * 单策略执行集成：补齐真实保护清仓、订单终态、PostTrade freshness 与延迟卖出之间的交接。
 * 仅使用离线 SDK、行情源和外围风险替身，不启动账户或应用入口。
 */

import { describe, expect, it } from 'bun:test';
import { rejects } from 'node:assert/strict';
import { createTradingConfig } from '../../mock/factories/configFactory.js';
import { createPostTradeConsistencyRuntime } from '../../src/app/runtime/createPostTradeConsistencyRuntime.js';
import { createAccountPositionSnapshot } from '../../src/application/accountPositionSnapshot/index.js';
import { createOrderHoldRegistry } from '../../src/application/orderTracking/orderHoldRegistry.js';
import { createOrdinaryBuyWorkflow } from '../../src/application/ordinaryBuy/index.js';
import { createBuyRiskChecks } from '../../src/application/ordinaryBuy/riskChecks.js';
import type { BuyRiskCheckContext } from '../../src/application/ordinaryBuy/types.js';
import { createOrdinarySellWorkflow } from '../../src/application/ordinarySell/index.js';
import { createUnrealizedLossMonitor } from '../../src/application/protectiveLiquidation/unrealizedLossExecutor.js';
import { createSymbolRegistry } from '../../src/domain/seat/symbolRegistry.js';
import { createBuyProcessor } from '../../src/runtime/asyncProgram/buyProcessor/index.js';
import { createSellProcessor } from '../../src/runtime/asyncProgram/sellProcessor/index.js';
import {
  createBuyTaskQueue,
  createSellTaskQueue,
} from '../../src/runtime/asyncProgram/tradeTaskQueue/index.js';
import { createStrategyEmitter } from '../../src/runtime/businessEventProgram/emissionAdapter.js';
import type { ExecutableSignal } from '../../src/types/signal.js';
import { marketContext } from '../domain/strategy/intradayRegression/fixtures.js';
import { captureSwitchSeatAuthorization } from '../helpers/seatTestUtils.js';
import {
  createDailyLossTrackerDouble,
  createLiquidationCooldownTrackerDouble,
  createLoggerDouble,
  createMarketDataClientDouble,
  createMonitorConfigDouble,
  createMonitorContextDouble,
  createProtectiveLiquidationEpisodeTrackerDouble,
  createQuoteDouble,
  createRateLimiterDouble,
  createRiskCheckerDouble,
  createTerminationDouble,
  createTradeRuntimeDouble,
} from '../helpers/testDoubles.js';
import { createRuntimeStates, waitUntil } from '../helpers/asyncProgram.js';
import { createHarness, prepareFixture } from '../runtime/strategy/intradayRegression/fixtures.js';
import { createBrokerIngressFixture } from './architectureRefactoringP1Native/trade/brokerIngressFixture.js';

/** 装配真实下单、订单终态和刷新流程；唯一可控阻塞位于账户服务的上游请求。 */
async function createExecutionFixture(smartCloseEnabled = false) {
  const h = createHarness();
  const generatedAtMs = Date.parse('2026-02-16T01:31:00.000Z');
  h.setNow(generatedAtMs);
  const strategy = prepareFixture({
    signals: {
      BUYCALL: '(K>1000)',
      SELLCALL: '(K>-1000)',
      BUYPUT: '(K>1000)',
      SELLPUT: '(K>1000)',
    },
    verification: {
      buy: { delaySeconds: 0, indicators: [] },
      sell: { delaySeconds: 60, indicators: ['K'] },
    },
  }).create(h.deps);
  const native = await createBrokerIngressFixture({
    orderId: 'LOCAL-BUY',
    tradeId: 'LOCAL-BUY-T',
    symbol: 'BULL.HK',
    stockName: 'HSI BULL',
    remark: 'HSI',
    side: 'BUY',
    status: 'Filled',
    quantity: '400',
    executedQuantity: '400',
    submittedPrice: '2',
    executedPrice: '2',
    submittedAtMs: generatedAtMs - 2000,
    executionTimeMs: generatedAtMs - 1000,
    updatedAtMs: generatedAtMs - 500,
  });
  native.setAccountBalance({
    currency: 'HKD',
    totalCash: '100000',
    netAssets: '100800',
    availableCash: '100000',
  });

  native.setStockPositions([
    {
      symbol: 'BULL.HK',
      symbolName: 'BULL',
      accountChannel: 'lb_papertrading',
      currency: 'HKD',
      quantity: '400',
      availableQuantity: '400',
      costPrice: '2',
    },
  ]);
  const callerAuthorizations: Array<
    Parameters<TradeRuntime['orderExecutor']['executeSignals']>[1]
  > = [];
  let submissions = 0;
  native.setSubmitBehavior(async () => {
    const originalAuthorization = callerAuthorizations.at(-1);
    if (originalAuthorization === undefined)
      throw new Error('native entry requires original caller');

    expect(originalAuthorization()).toBeTrue();
    submissions += 1;
    return `STRATEGY-${submissions}`;
  });
  const rateLimiter = createRateLimiterDouble();
  const accountService = native.createAccountService({ rateLimiter });
  const positionsRelease = Promise.withResolvers<undefined>();
  let positionsRequested = false;
  let blockRefresh = false;
  const snapshot = createAccountPositionSnapshot({
    dayEpoch: 1,
    readPort: {
      getAccountSnapshot: accountService.getAccountSnapshot,
      getStockPositions: async () => {
        if (blockRefresh) {
          positionsRequested = true;
          await positionsRelease.promise;
        }

        return accountService.getStockPositions();
      },
    },
    scheduler: { schedule: queueMicrotask },
    reportFatalError: (error) => {
      throw error;
    },
  });
  const committed = await snapshot.requestRefresh({
    source: 'single-active-baseline',
    dayEpoch: 1,
    refreshAccount: true,
    refreshPositions: true,
  }).result;
  if (committed.status !== 'COMMITTED') throw new Error('expected paired baseline');

  const stateFixtures = createRuntimeStates();
  const dailyLossTracker = createDailyLossTrackerDouble();
  let boundTrader: TradeRuntime | null = null;
  const postTrade = createPostTradeConsistencyRuntime({
    logger: createLoggerDouble(),
    snapshot,
    termination: createTerminationDouble(),
    getProtectiveOrderReader: () => {
      if (boundTrader === null) throw new Error('Trader 尚未装配');

      return boundTrader.orderMonitor;
    },
    scheduler: h.deps.scheduler,
    onPositionsCommitted: async (token) => {
      if (!snapshot.isCurrent(token, { account: false, positions: true }))
        throw new Error('stale subscription fact');
    },
  });
  const orderRecorder = native.createRecorder({
    logger: createLoggerDouble(),
    rateLimiter,
    getExecutionTimeEvidence: dailyLossTracker.getExecutionTimeEvidence,
    settlementRefreshNeedRecorder: postTrade,
  });

  const config = createMonitorConfigDouble({ smartCloseEnabled, orderOwnershipMapping: ['HSI'] });
  const tradingConfig = createTradingConfig({ monitor: config });
  const riskChecker = createRiskCheckerDouble({
    checkUnrealizedLoss: () => ({ shouldLiquidate: true, quantity: 400, reason: '离线保护清仓' }),
  });
  const symbolRegistry = createSymbolRegistry(config);
  symbolRegistry.updateSeatState('LONG', {
    symbol: 'BULL.HK',
    status: 'ACTIVE',
    lastSwitchAt: null,
    lastSearchAt: null,
    lastSeatActivatedAt: generatedAtMs - 1000,
    searchFailCountToday: 0,
    frozenTradingDayKey: null,
    callPrice: null,
  });

  symbolRegistry.updateSeatState('SHORT', {
    symbol: 'BEAR.HK',
    status: 'ACTIVE',
    lastSwitchAt: null,
    lastSearchAt: null,
    lastSeatActivatedAt: generatedAtMs - 1000,
    searchFailCountToday: 0,
    frozenTradingDayKey: null,
    callPrice: null,
  });
  const monitorContext = createMonitorContextDouble({
    symbolRegistry,
    config,
    strategy,
    orderRecorder,
    riskChecker,
    dailyLossTracker,
  });
  let quotePrice = '1';
  let quoteReads = 0;
  const marketDataClient = createMarketDataClientDouble({
    getQuotes: async (symbols) => {
      quoteReads += 1;
      return new Map(
        [...symbols].map((symbol) => [symbol, createQuoteDouble(symbol, quotePrice, 100)]),
      );
    },
  });
  const termination = createTerminationDouble();
  const liquidationCooldownTracker = createLiquidationCooldownTrackerDouble();
  const protectiveLiquidationEpisodeTracker = createProtectiveLiquidationEpisodeTrackerDouble();
  const cacheManager = { clearCache: () => {}, getPendingOrders: async () => [] };
  const orderMonitor = native.createMonitor({
    logger: createLoggerDouble(),
    wait: wait,
    requestExternalApi: wrapExternalApiRequest,
    scheduleBoundedOneShotAt: scheduleBoundedOneShotAt,
    rateLimiter,
    cacheManager,
    marketDataClient,
    orderRecorder,
    dailyLossTracker,
    orderHoldRegistry: createOrderHoldRegistry(),
    protectiveLiquidationEpisodeTracker,
    persistProtectiveLiquidationExecutionProgress: () => {},
    postTradeConsistencyRuntime: postTrade,
    tradingConfig,
    symbolRegistry: monitorContext.symbolRegistry,
    isContinuousTradingAllowed: () =>
      stateFixtures.tradingTimeState.canTrade === true &&
      stateFixtures.lifecycleState.isTradingEnabled,
    now: h.deps.clock.now,
    scheduleTimer: h.deps.scheduler.scheduleTimer,
    clearTimer: h.deps.scheduler.clearTimer,
    termination,
  });
  const executor = native.createExecutor({
    logger: createLoggerDouble(),
    rateLimiter,
    cacheManager,
    marketDataClient,
    orderRecorder,
    orderMonitor,
    unrealizedLossBuyGate: riskChecker,
    tradingConfig,
    symbolRegistry: monitorContext.symbolRegistry,
    isExecutionAllowed: () => stateFixtures.lifecycleState.isTradingEnabled,
    isContinuousTradingAllowed: () => stateFixtures.tradingTimeState.canTrade === true,
    now: h.deps.clock.now,
    readCurrentTradingDayInfo: () => ({
      dateKey: '2026-02-16',
      info: { isTradingDay: true, isHalfDay: false },
    }),
  });
  const executedSignals: ExecutableSignal[] = [];
  const tradeRuntime = createTradeRuntimeDouble({
    ...executor,
    orderRecorder,
    orderExecutor: {
      executeSignals: async (signals, callerAuthorization) => {
        executedSignals.push(...signals);
        callerAuthorizations.push(callerAuthorization);
        expect(callerAuthorization()).toBeTrue();
        return executor.executeSignals(signals, callerAuthorization);
      },
      executeDoomsdayClearanceSignals: async (signals, callerAuthorization) => {
        callerAuthorizations.push(callerAuthorization);
        return executor.executeDoomsdayClearanceSignals(signals, callerAuthorization);
      },
    },
    accountService: {
      getStockPositions: async () => {
        positionsRequested = true;
        await positionsRelease.promise;
        return accountService.getStockPositions();
      },
    },
    orderMonitor: {
      hasPendingProtectiveLiquidationOrders: orderMonitor.hasPendingProtectiveLiquidationOrders,
    },
  });
  boundTrader = tradeRuntime;
  postTrade.bindBusinessDeps({
    monitorContext,
    dailyLossTracker,
    liquidationCooldownTracker,
    protectiveLiquidationEpisodeTracker,
    mixedTradeLogRepository: { appendCompletionIdempotent: () => {} },
  });
  const buyTaskQueue = createBuyTaskQueue();
  const sellTaskQueue = createSellTaskQueue();
  const sellWorkflow = createOrdinarySellWorkflow({
    logger: createLoggerDouble(),
    clock: h.deps.clock,
    config,
    symbolRegistry,

    orderRecorder: tradeRuntime.orderRecorder,
    orderExecutor: tradeRuntime.orderExecutor,
    marketDataClient,
    snapshot,
    settlement: postTrade,
    getTradingCalendar: () => ({
      isHalfDay: stateFixtures.tradingTimeState.isHalfDay ?? false,
      tradingCalendarSnapshot: stateFixtures.tradingCalendarState.tradingCalendarSnapshot,
    }),
    getCanProcessTask: () => stateFixtures.lifecycleState.isTradingEnabled,
    termination,
  });
  const sellProcessor = createSellProcessor({
    logger: createLoggerDouble(),
    scheduler: h.deps.scheduler,
    termination,
    taskQueue: sellTaskQueue,
    workflow: sellWorkflow,
    getCanProcessTask: () => stateFixtures.lifecycleState.isTradingEnabled,
  });
  await orderMonitor.initialize();
  await orderMonitor.recoverOrderTrackingFromSnapshot([native.queryObservation]);
  const rebuilt = orderRecorder.commitRebuildSnapshot(
    [{ symbol: 'BULL.HK', isLongSymbol: true }],
    [native.queryObservation],
    () =>
      snapshot.isCurrent(committed.snapshotToken, { account: true, positions: true, paired: true }),
    'ACTIVATION',
  );
  expect(rebuilt.status).toBe('COMMITTED');
  const prepared = dailyLossTracker.prepareRecalculationFromAllOrders(
    [native.queryObservation],
    config,
    new Date(generatedAtMs),
    undefined,
    new Set(['BULL.HK', 'BEAR.HK']),
  );
  dailyLossTracker.publishRecalculation(prepared);
  postTrade.start();
  expect(await postTrade.completeRebuildBaseline()).toBeTrue();
  const baselineReceipt = await postTrade.waitForFresh();
  expect(baselineReceipt.snapshotToken).toEqual(committed.snapshotToken);
  expect(postTrade.isCurrent(baselineReceipt)).toBeTrue();
  const baselineReadCounts = native.accountReadCounts();
  blockRefresh = true;
  return {
    h,
    generatedAtMs,
    strategy,
    native,
    snapshot,
    baselineReadCounts,
    baselineReceipt,
    orderMonitor,
    orderRecorder,
    monitorContext,
    ...stateFixtures,
    postTrade,
    tradeRuntime,
    sellProcessor,
    buyTaskQueue,
    sellTaskQueue,
    termination,
    executedSignals,
    callerAuthorizations,
    liquidationCooldownTracker,
    positionsRelease,
    tradingConfig,
    marketDataClient,
    riskChecker,
    dailyLossTracker,
    getPositionsRequested: () => positionsRequested,
    getQuoteReads: () => quoteReads,
    setQuotePrice: (value: string) => {
      quotePrice = value;
    },
  };
}

describe('single active strategy execution integration', () => {
  it('hands real protection settlement to delayed SELL through actual PostTrade freshness and SDK submission', async () => {
    const f = await createExecutionFixture();
    try {
      const emitter = createStrategyEmitter(
        {
          clock: f.h.deps.clock,

          ...f,
          tradingConfig: f.tradingConfig,
          buyTaskQueue: f.buyTaskQueue,
          sellTaskQueue: f.sellTaskQueue,
          monitorDisplayRuntime: { requestRender: () => {} },
          termination: f.termination,
        },
        {
          dayKey: '2026-02-16',
          routes: [
            {
              direction: 'LONG',
              symbol: 'BULL.HK',
              seatVersion: f.monitorContext.symbolRegistry.getSeatVersion('LONG'),
              hasFilledBuyOrders: f.orderRecorder.getBuyOrdersForSymbol('BULL.HK', true).length > 0,
            },
          ],
        },
      );
      const origin = marketContext(50, 1, f.generatedAtMs);
      f.strategy.onCandlestick(
        { ...origin, seats: origin.seats.filter((seat) => seat.direction === 'LONG') },
        emitter,
      );
      const verificationTimer = f.h.timers[0];
      if (!verificationTimer) throw new Error('策略未创建验证 timer');

      expect(f.sellTaskQueue.isEmpty()).toBeTrue();
      const protectionSeatAuthorization = captureSwitchSeatAuthorization(
        f.monitorContext.symbolRegistry,
        'LONG',
      );
      const protectionOrigin = () =>
        f.lifecycleState.isTradingEnabled &&
        f.tradingTimeState.canTrade === true &&
        f.postTrade.isCurrent(f.baselineReceipt) &&
        f.snapshot.isCurrent(f.baselineReceipt.snapshotToken, {
          account: false,
          positions: true,
        }) &&
        protectionSeatAuthorization() &&
        f.snapshot.getView().token.dayEpoch === f.baselineReceipt.snapshotToken.dayEpoch;
      await createUnrealizedLossMonitor({
        logger: createLoggerDouble(),
        maxUnrealizedLossPerSymbol: '1',
      }).monitorDirectionalUnrealizedLoss({
        symbol: 'BULL.HK',
        isLong: true,
        seatVersion: f.monitorContext.symbolRegistry.getSeatVersion('LONG'),
        quote: createQuoteDouble('BULL.HK', '1', 100),
        riskChecker: f.riskChecker,
        orderExecutor: f.tradeRuntime.orderExecutor,
        orderRecorder: f.orderRecorder,
        dailyLossTracker: f.dailyLossTracker,
        isCurrent: protectionOrigin,
      });
      expect(f.native.nativeSubmitObservations()).toHaveLength(1);
      expect(f.executedSignals[0]?.isProtectiveLiquidation).toBeTrue();
      expect(f.callerAuthorizations[0]).toBe(protectionOrigin);
      expect(f.orderRecorder.getBuyOrdersForSymbol('BULL.HK', true)).toEqual([]);
      expect(
        f.snapshot.getView().positions.find((position) => position.symbol === 'BULL.HK')?.quantity,
      ).toBe(400);
      const protectionId = f.orderMonitor.getPendingSellOrders('BULL.HK')[0]?.orderId;
      if (!protectionId) throw new Error('保护清仓未登记真实挂单');

      // 真实订单监控根据累计成交事实推进 stale；不直接调用 recordSettlementRefreshNeed。
      f.native.setExecutionReplies([
        {
          orderId: protectionId,
          tradeId: 'PROTECTION-T',
          symbol: 'BULL.HK',
          quantity: '100',
          price: '1',
          tradeDoneAtMs: f.generatedAtMs + 1000,
        },
      ]);

      f.native.emitOrderChangedFrame({
        orderId: protectionId,
        tradeId: 'PROTECTION-T',
        symbol: 'BULL.HK',
        stockName: 'HSI BULL',
        remark: 'HSI',
        side: 'SELL',
        orderType: 'MO',
        status: 'PartialWithdrawal',
        quantity: '400',
        executedQuantity: '100',
        submittedPrice: '1',
        executedPrice: '1',
        submittedAtMs: f.generatedAtMs,
        executionTimeMs: f.generatedAtMs + 1000,
        updatedAtMs: f.generatedAtMs + 1000,
      });
      await Bun.sleep(0);
      for (const timer of f.h.timers) {
        if (timer !== verificationTimer && !timer.cleared && timer.delay === 0) timer.callback();
      }

      await waitUntil(f.getPositionsRequested);
      expect(f.orderMonitor.getPendingSellOrders('BULL.HK')).toEqual([]);
      expect(f.postTrade.getStatus().staleVersion).toBeGreaterThan(
        f.postTrade.getStatus().currentVersion,
      );

      for (const [index, delta] of [60_000, 65_000, 70_000].entries()) {
        f.h.setNow(f.generatedAtMs + delta);
        f.strategy.onCandlestick(
          {
            ...marketContext(20 - index, index + 2, f.generatedAtMs + delta),
            allowNewEvaluation: false,
            seats: [],
          },
          () => {
            throw new Error('pending 必须回调 T0 的 emitter');
          },
        );
      }

      verificationTimer.callback();
      expect(f.sellTaskQueue.isEmpty()).toBeFalse();
      expect(f.buyTaskQueue.isEmpty()).toBeTrue();
      const quoteReadsBeforeWait = f.getQuoteReads();
      f.sellProcessor.start();
      await waitUntil(() => f.sellTaskQueue.isEmpty());
      expect(f.executedSignals).toHaveLength(1);
      expect(f.native.nativeSubmitObservations()).toHaveLength(1);
      expect(f.native.nativeReadCounts().cancel).toBe(0);
      expect(f.getQuoteReads()).toBe(quoteReadsBeforeWait);
      expect(
        f.snapshot.getView().positions.find((position) => position.symbol === 'BULL.HK')?.quantity,
      ).toBe(400);
      f.setQuotePrice('1.23');
      f.native.setStockPositions([
        {
          symbol: 'BULL.HK',
          symbolName: 'BULL',
          accountChannel: 'lb_papertrading',
          currency: 'HKD',
          quantity: '300',
          availableQuantity: '200',
          costPrice: '2',
        },
      ]);
      f.positionsRelease.resolve();
      await f.postTrade.waitForFresh();
      await waitUntil(() => f.executedSignals.length === 2);
      await f.sellProcessor.stopAndDrain();
      expect(f.snapshot.getAvailablePosition('BULL.HK')?.availableQuantity).toBe(200);
      expect(f.h.errors).toEqual([]);
      expect(f.termination.getFatalState()).toEqual({ hasFatalError: false });
      const sell = f.executedSignals[1];
      // T0 是生成时刻加配置 delay，不能被回调到达的 T0+10s 改写。
      expect(sell?.triggerTime?.getTime()).toBe(f.generatedAtMs + 60_000);
      expect(sell?.quantity).toBe(200);
      expect(sell?.isProtectiveLiquidation).not.toBeTrue();
      expect(f.native.nativeSubmitObservations()).toHaveLength(2);
      const payload = f.native.nativeSubmitObservations()[1];
      expect(payload).toMatchObject({
        symbol: 'BULL.HK',
        side: 'SELL',
        orderType: 'ELO',
      });

      if (payload === undefined) throw new Error('缺少实际卖出 payload');

      expect(payload.quantity).toBe('200');
      expect(payload.price).toBe('1.23');
      expect(payload.timeInForce).toBe('DAY');
      expect(f.orderRecorder.getSellRecordByOrderId(protectionId)?.costAmount).toBe('100');
      expect(f.orderRecorder.getExecutionFact(protectionId)).toMatchObject({
        cumulativeQuantity: 100,
        cumulativeAmount: '100',
        executionTimeMs: f.generatedAtMs + 1000,
        phase: 'TERMINAL',
      });
      expect(f.orderMonitor.getPendingSellOrders('BULL.HK')).toHaveLength(1);
      expect(f.native.nativeMutations().filter((mutation) => mutation.kind === 'REPLACE')).toEqual(
        [],
      );
      expect(f.orderRecorder.getBuyOrdersForSymbol('BULL.HK', true)).toEqual([]);
    } finally {
      f.positionsRelease.resolve();
      await f.sellProcessor.stopAndDrain();
      await f.postTrade.stopAndDrain();
      await f.orderMonitor.stopRuntimeAndDrain();
      await f.snapshot.requestClear({ reason: 'STOP', dayEpoch: 1 });
      f.strategy.destroy();
    }
  });
});

describe('execution authority at buy and clearance boundaries', () => {
  it('keeps an emitter reason ordinary through smart-close HOLD but permits the typed clearance path', async () => {
    const f = await createExecutionFixture(true);
    try {
      const emitter = createStrategyEmitter(
        {
          clock: f.h.deps.clock,

          ...f,
          tradingConfig: f.tradingConfig,
          buyTaskQueue: f.buyTaskQueue,
          sellTaskQueue: f.sellTaskQueue,
          monitorDisplayRuntime: { requestRender: () => {} },
          termination: f.termination,
        },
        {
          dayKey: '2026-02-16',
          routes: [
            {
              direction: 'LONG',
              symbol: 'BULL.HK',
              seatVersion: f.monitorContext.symbolRegistry.getSeatVersion('LONG'),
              hasFilledBuyOrders: true,
            },
          ],
        },
      );
      emitter({
        action: 'SELLCALL',
        triggerTimeMs: f.generatedAtMs,
        reason: '末日保护程序：策略要求全量清仓',
      });
      expect(f.sellTaskQueue.isEmpty()).toBeFalse();
      const quoteReadsBeforeSell = f.getQuoteReads();
      f.sellProcessor.start();
      await waitUntil(() => f.getQuoteReads() > quoteReadsBeforeSell);
      await f.sellProcessor.stopAndDrain();
      expect(f.native.nativeSubmitObservations()).toEqual([]);
      expect(f.executedSignals).toEqual([]);
      expect(f.orderRecorder.getBuyOrdersForSymbol('BULL.HK', true)).toHaveLength(1);
      f.h.setNow(Date.parse('2026-02-16T07:56:00.000Z'));
      f.native.setStockPositions([
        {
          symbol: 'BULL.HK',
          symbolName: 'BULL',
          accountChannel: 'lb_papertrading',
          currency: 'HKD',
          quantity: '300',
          availableQuantity: '200',
          costPrice: '2',
        },
      ]);
      const clearanceReceipt = await f.postTrade.waitForFresh();
      const originalSeat = f.monitorContext.symbolRegistry.getSeatState('LONG');
      const result = await f.tradeRuntime.orderExecutor.executeDoomsdayClearanceSignals(
        [
          {
            symbol: 'BULL.HK',
            symbolName: null,
            action: 'SELLCALL',
            triggerTime: f.h.deps.clock.now(),
            seatVersion: f.monitorContext.symbolRegistry.getSeatVersion('LONG'),
          },
        ],
        () =>
          f.lifecycleState.isTradingEnabled &&
          f.postTrade.isCurrent(clearanceReceipt) &&
          f.snapshot.isCurrent(clearanceReceipt.snapshotToken, {
            account: false,
            positions: true,
          }) &&
          f.monitorContext.symbolRegistry.getSeatState('LONG') === originalSeat,
      );
      expect(result.executedOrderIds).toHaveLength(1);
      const payload = f.native.nativeSubmitObservations()[0];
      expect(payload).toMatchObject({
        symbol: 'BULL.HK',
        side: 'SELL',
        orderType: 'ELO',
      });

      if (payload === undefined) throw new Error('缺少 typed 清仓 payload');

      expect(payload.quantity).toBe('200');
      expect(f.termination.getFatalState()).toEqual({ hasFatalError: false });
    } finally {
      f.positionsRelease.resolve();
      await f.sellProcessor.stopAndDrain();
      await f.postTrade.stopAndDrain();
      await f.orderMonitor.stopRuntimeAndDrain();
      f.strategy.destroy();
    }
  });

  it.each([null, '0', Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid monitor quote %s at the actual buy queue without account reads or SDK mutations',
    async (price) => {
      const f = await createExecutionFixture();
      let quoteRequested = false;
      const processor = createBuyProcessor({
        logger: createLoggerDouble(),
        taskQueue: f.buyTaskQueue,
        workflow: createOrdinaryBuyWorkflow({
          accountService: f.tradeRuntime.accountService,
          orderExecutor: f.tradeRuntime.orderExecutor,
          tradeFrequencyReader: f.tradeRuntime.orderExecutor,
          logger: createLoggerDouble(),
          config: f.monitorContext.config,
          doomsdayProtection: f.tradingConfig.global.doomsdayProtection,
          symbolRegistry: f.monitorContext.symbolRegistry,

          riskChecker: f.riskChecker,
          orderRecorder: f.tradeRuntime.orderRecorder,
          marketDataClient: createMarketDataClientDouble({
            getQuotes: async () => {
              quoteRequested = true;
              const quotes = new Map([['BULL.HK', createQuoteDouble('BULL.HK', '1', 100)]]);
              if (price !== null)
                quotes.set(
                  f.monitorContext.config.monitorSymbol,
                  createQuoteDouble(
                    f.monitorContext.config.monitorSymbol,
                    typeof price === 'string' ? price : '1',
                  ),
                );

              if (typeof price === 'number') {
                const malformed = quotes.get(f.monitorContext.config.monitorSymbol);
                if (malformed !== undefined) Reflect.set(malformed, 'price', price);
              }

              return quotes;
            },
          }),
          liquidationCooldownTracker: f.liquidationCooldownTracker,
          getIsHalfDay: () => false,
          now: f.h.deps.clock.now,
          snapshot: f.snapshot,
          getCanProcessTask: () =>
            f.lifecycleState.isTradingEnabled && f.tradingTimeState.canTrade === true,
          termination: f.termination,
        }),
        getCanProcessTask: () =>
          f.lifecycleState.isTradingEnabled && f.tradingTimeState.canTrade === true,
        termination: f.termination,
      });
      try {
        f.buyTaskQueue.push({
          type: 'STRATEGY_BUY',
          data: {
            symbol: 'BULL.HK',
            symbolName: null,
            action: 'BUYCALL',
            triggerTime: new Date(f.generatedAtMs),
            seatVersion: f.monitorContext.symbolRegistry.getSeatVersion('LONG'),
          },
        });
        processor.start();
        await waitUntil(() => quoteRequested);
        await processor.stopAndDrain();
        expect(f.getPositionsRequested()).toBeFalse();
        expect(f.native.accountReadCounts().balance).toBe(f.baselineReadCounts.balance);
        expect(f.native.nativeSubmitObservations()).toEqual([]);
        expect(f.executedSignals).toEqual([]);
        if (typeof price === 'number') {
          const fatal = f.termination.getFatalState();
          if (!fatal.hasFatalError) throw new Error('malformed financial input must be fatal');

          expect(fatal.error).toBeInstanceOf(TypeError);
          expect(fatal.error instanceof Error && fatal.error.message).toBe(
            'Financial input must be plain decimal text',
          );
        } else expect(f.termination.getFatalState()).toEqual({ hasFatalError: false });
      } finally {
        f.positionsRelease.resolve();
        await processor.stopAndDrain();
        await f.postTrade.stopAndDrain();
        await f.orderMonitor.stopRuntimeAndDrain();
        f.strategy.destroy();
      }
    },
  );

  it('fails fast if the internal buy risk context bypasses the monitor quote admission contract', async () => {
    const f = await createExecutionFixture();
    try {
      const invalidContext = {
        accountService: f.tradeRuntime.accountService,
        tradeFrequencyReader: f.tradeRuntime.orderExecutor,

        riskChecker: f.riskChecker,
        orderRecorder: f.orderRecorder,
        longQuote: createQuoteDouble('BULL.HK', '1', 100),
        shortQuote: null,
        monitorQuote: createQuoteDouble(f.monitorContext.config.monitorSymbol, '20000'),
        longSymbol: 'BULL.HK',
        shortSymbol: 'BEAR.HK',
        longSymbolName: null,
        shortSymbolName: null,
        currentTime: new Date(f.generatedAtMs),
        isHalfDay: false,
        config: f.monitorContext.config,
      } satisfies BuyRiskCheckContext;
      Reflect.set(invalidContext, 'monitorQuote', null);
      await rejects(
        createBuyRiskChecks({
          logger: createLoggerDouble(),
          doomsdayProtection: f.tradingConfig.global.doomsdayProtection,
          liquidationCooldownTracker: f.liquidationCooldownTracker,
          lastRiskCheckTime: new Map(),
          reportFatalError: f.termination.reportFatalError,
        })(
          [
            {
              symbol: 'BULL.HK',
              symbolName: null,
              action: 'BUYCALL',
              seatVersion: f.monitorContext.symbolRegistry.getSeatVersion('LONG'),
            },
          ],
          invalidContext,
        ),
      );
      expect(f.getPositionsRequested()).toBeFalse();
      expect(f.native.nativeSubmitObservations()).toEqual([]);
    } finally {
      f.positionsRelease.resolve();
      await f.postTrade.stopAndDrain();
      await f.orderMonitor.stopRuntimeAndDrain();
      f.strategy.destroy();
    }
  });
});
