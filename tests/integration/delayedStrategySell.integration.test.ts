import { createDiagnosticObserverDouble } from '../helpers/diagnostics.js';
import type { RuntimeStateFixtures } from '../helpers/types.js';
import { scheduleBoundedOneShotAt } from '../../src/runtime/timer/index.js';
import { wrapExternalApiRequest } from '../../src/infrastructure/externalApi/index.js';
import { wait } from '../../src/infrastructure/time/index.js';

/** 延迟 SELL 回流：原策略验证与 caller route 保留；真实同 ctx H/O/Daily/S 及 native executor 读取最新可卖事实。 */

import { describe, expect, it } from 'bun:test';
import { createTradingConfig } from '../../mock/factories/configFactory.js';
import { createPostTradeConsistencyRuntime } from '../../src/app/runtime/createPostTradeConsistencyRuntime.js';
import type { PostTradeConsistencyRuntime } from '../../src/app/runtime/types.js';
import { createAccountPositionSnapshot } from '../../src/application/accountPositionSnapshot/index.js';
import { createOrderHoldRegistry } from '../../src/application/orderTracking/orderHoldRegistry.js';
import { createOrdinarySellWorkflow } from '../../src/application/ordinarySell/index.js';
import { createProtectiveLiquidationEpisodeTracker } from '../../src/domain/liquidation/episode/index.js';
import { orderAnalysis } from '../../src/domain/order/orderAnalysis.js';
import { createDailyLossTracker } from '../../src/domain/risk/dailyLossTracker.js';
import { createSellProcessor } from '../../src/runtime/asyncProgram/sellProcessor/index.js';
import {
  createBuyTaskQueue,
  createSellTaskQueue,
} from '../../src/runtime/asyncProgram/tradeTaskQueue/index.js';
import { createStrategyEmitter } from '../../src/runtime/businessEventProgram/emissionAdapter.js';
import type { Signal } from '../../src/types/signal.js';
import { toHongKongTimeIso } from '../../src/utils/time/index.js';
import { marketContext } from '../strategies/intradayRegression/indicatorFixtures.js';
import {
  createLiquidationCooldownTrackerDouble,
  createLoggerDouble,
  createMarketDataClientDouble,
  createMonitorConfigDouble,
  createMonitorContextDouble,
  createQuoteDouble,
  createRateLimiterDouble,
  createTerminationDouble,
  createTradeRuntimeDouble,
} from '../helpers/testDoubles.js';
import { waitUntil } from '../helpers/asyncProgram.js';
import { createHarness, prepareFixture } from '../strategies/intradayRegression/runtimeFixtures.js';
import { createBrokerIngressFixture } from './architectureRefactoringP1Native/trade/brokerIngressFixture.js';
import { toRecalculationOrders } from './recalculationOrders.js';

describe('delayed strategy sell integration', () => {
  it.each(['active', 'gate-closed', 'route-changed'])(
    'rechecks %s without rechecking cleared origin buy records',
    async (scenario) => {
      const h = createHarness();
      const now = Date.parse('2026-02-16T01:31:00.000Z');
      h.setNow(now);
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
        orderId: 'FILLED-BUY',
        symbol: 'BULL.HK',
        stockName: 'HSI RC',
        remark: '',
        side: 'BUY',
        status: 'Filled',
        orderType: 'ELO',
        quantity: '100',
        executedQuantity: '100',
        submittedPrice: '1',
        executedPrice: '1',
        submittedAtMs: now - 1000,
        updatedAtMs: now - 1000,
      });
      native.setAccountBalance({
        currency: 'HKD',
        totalCash: '0',
        netAssets: '0',
        availableCash: '0',
      });
      native.setStockPositions([]);
      const daily = createDailyLossTracker({
        onOwnershipWarning: () => {},
        ...orderAnalysis,
        toHongKongTimeIso,
      });
      daily.resetAll(new Date(now));
      let settlement: PostTradeConsistencyRuntime | null = null;
      const settlementNeedRecorder = {
        recordSettlementRefreshNeed: (
          need: Parameters<PostTradeConsistencyRuntime['recordSettlementRefreshNeed']>[0],
        ) => {
          if (settlement === null) throw new Error('Delayed settlement not assembled');

          settlement.recordSettlementRefreshNeed(need);
        },
      };
      const recorder = native.createRecorder({
        logger: createLoggerDouble(),
        rateLimiter: createRateLimiterDouble(),
        settlementRefreshNeedRecorder: settlementNeedRecorder,
      });
      const config = createMonitorConfigDouble({ smartCloseEnabled: false });
      const monitorContext = createMonitorContextDouble({
        config,
        strategy,
        orderRecorder: recorder,
        dailyLossTracker: daily,
      });
      const stateFixtures: RuntimeStateFixtures = {
        tradingTimeState: { canTrade: true, isHalfDay: false, openProtectionActive: false },
        lifecycleState: {
          currentDayKey: '2026-02-16',
          lifecycleState: 'ACTIVE',
          pendingOpenRebuild: false,
          isTradingEnabled: true,
        },
        tradingCalendarState: { cachedTradingDayInfo: null, tradingCalendarSnapshot: new Map() },
        quoteSubscriptionState: { allTradingSymbols: new Set(['BULL.HK']) },
      };
      const termination = createTerminationDouble();
      const account = native.createAccountService({ rateLimiter: createRateLimiterDouble() });
      const fresh = Promise.withResolvers<undefined>();
      let blockPositions = false;
      let waiting = false;
      const snapshot = createAccountPositionSnapshot({
        clock: { now: () => new Date() },
        diagnostics: createDiagnosticObserverDouble(),
        dayEpoch: 1,
        scheduler: { schedule: queueMicrotask },
        reportFatalError: termination.reportFatalError,
        readPort: {
          ...account,
          getStockPositions: async () => {
            if (blockPositions) {
              waiting = true;
              await fresh.promise;
            }

            return account.getStockPositions();
          },
        },
      });
      const baseline = await snapshot.requestRefresh({
        source: 'DELAYED_ORIGIN',
        dayEpoch: 1,
        refreshAccount: true,
        refreshPositions: true,
      }).result;
      if (baseline.status !== 'COMMITTED') throw new Error('Delayed origin H publication aborted');

      const prepared = daily.prepareRecalculationFromAllOrders(
        toRecalculationOrders([native.queryObservation]),
        config,
        new Date(now),
      );
      const seedCommit = recorder.commitRebuildSnapshot(
        [{ symbol: 'BULL.HK', isLongSymbol: true }],
        [native.queryObservation],
        () =>
          snapshot.isCurrent(baseline.snapshotToken, {
            account: true,
            positions: true,
            paired: true,
          }) && prepared.isCurrent(),
        'REBUILD',
      );
      if (seedCommit.status !== 'COMMITTED')
        throw new Error('Delayed origin O publication aborted');

      daily.publishRecalculation(prepared);
      expect(recorder.getCostBasis('BULL.HK', true)).toEqual({ costAmount: '100', quantity: 100 });
      const buyTaskQueue = createBuyTaskQueue({
        clock: { now: () => new Date() },
        diagnostics: createDiagnosticObserverDouble(),
      });
      const sellTaskQueue = createSellTaskQueue({
        clock: { now: () => new Date() },
        diagnostics: createDiagnosticObserverDouble(),
      });
      const tradingConfig = createTradingConfig({ monitor: config });
      const emitter = createStrategyEmitter(
        {
          clock: h.deps.clock,
          marketDataClient: createMarketDataClientDouble(),
          monitorContext,
          ...stateFixtures,
          tradingConfig,
          buyTaskQueue,
          sellTaskQueue,
          monitorDisplayRuntime: { requestRender: () => {} },
          termination,
        },
        {
          dayKey: '2026-02-16',
          routes: [
            {
              direction: 'LONG',
              symbol: 'BULL.HK',
              seatVersion: monitorContext.symbolRegistry.getSeatVersion('LONG'),
              hasFilledBuyOrders: recorder.getBuyOrdersForSymbol('BULL.HK', true).length > 0,
            },
          ],
        },
      );
      const origin = marketContext(50, 1, now);
      strategy.onCandlestick(
        { ...origin, seats: origin.seats.filter((seat) => seat.direction === 'LONG') },
        emitter,
      );
      expect(h.timers).toHaveLength(1);
      expect(sellTaskQueue.isEmpty()).toBe(true);
      recorder.resetAll();
      const sample = marketContext(20, 2, now + 65_000);
      strategy.onCandlestick({ ...sample, allowNewEvaluation: false, seats: [] }, () => {
        throw new Error('protected sample must not emit');
      });
      h.setNow(now + 70_000);
      if (scenario === 'gate-closed') stateFixtures.lifecycleState.isTradingEnabled = false;

      if (scenario === 'route-changed')
        monitorContext.symbolRegistry.updateSeatStateWithVersionBump('LONG', {
          ...monitorContext.symbolRegistry.getSeatState('LONG'),
          status: 'ACTIVE',
          symbol: 'BULL.HK',
          lastSeatActivatedAt: now,
        });

      for (const timer of h.timers) timer.callback();

      expect(h.errors).toEqual([]);
      expect(termination.getFatalState()).toEqual({ hasFatalError: false });
      expect(buyTaskQueue.isEmpty()).toBe(true);
      expect(sellTaskQueue.isEmpty()).toBe(scenario !== 'active');
      if (scenario !== 'active') {
        strategy.destroy();
        return;
      }

      const submitted: Signal[] = [];
      const acceptedOrderIds: string[] = [];
      const market = createMarketDataClientDouble({
        getQuotes: async () => new Map([['BULL.HK', createQuoteDouble('BULL.HK', '1.1', 100)]]),
      });
      const episode = createProtectiveLiquidationEpisodeTracker();
      const monitor = native.createMonitor({
        diagnostics: createDiagnosticObserverDouble(),
        logger: createLoggerDouble(),
        wait: wait,
        requestExternalApi: wrapExternalApiRequest,
        scheduleBoundedOneShotAt: scheduleBoundedOneShotAt,
        now: h.deps.clock.now,
        scheduleTimer: h.deps.scheduler.scheduleTimer,
        clearTimer: h.deps.scheduler.clearTimer,
        rateLimiter: createRateLimiterDouble(),
        marketDataClient: market,
        cacheManager: { clearCache: () => {}, getPendingOrders: async () => [] },
        orderRecorder: recorder,
        dailyLossTracker: daily,
        orderHoldRegistry: createOrderHoldRegistry(),
        persistProtectiveLiquidationExecutionProgress: () => {},
        protectiveLiquidationEpisodeTracker: episode,
        postTradeConsistencyRuntime: settlementNeedRecorder,
        tradingConfig,
        symbolRegistry: monitorContext.symbolRegistry,
        isContinuousTradingAllowed: () => stateFixtures.tradingTimeState.canTrade === true,
        termination,
      });
      await monitor.initialize();
      await monitor.recoverOrderTrackingFromSnapshot([]);
      let coordinationReads = 0;
      const executor = native.createExecutor({
        diagnostics: createDiagnosticObserverDouble(),
        logger: createLoggerDouble(),
        now: h.deps.clock.now,
        readCurrentTradingDayInfo: () => ({
          dateKey: '2026-02-16',
          info: { isTradingDay: true, isHalfDay: false },
        }),
        rateLimiter: createRateLimiterDouble(),
        marketDataClient: market,
        cacheManager: { clearCache: () => {} },
        orderMonitor: {
          ...monitor,
          getPendingSellOrders: (symbol) => {
            coordinationReads++;
            return monitor.getPendingSellOrders(symbol);
          },
        },
        orderRecorder: recorder,
        unrealizedLossBuyGate: monitorContext.riskChecker,
        tradingConfig,
        symbolRegistry: monitorContext.symbolRegistry,
        isExecutionAllowed: () => stateFixtures.lifecycleState.isTradingEnabled,
        isContinuousTradingAllowed: () => stateFixtures.tradingTimeState.canTrade === true,
      });
      const tradeRuntime = createTradeRuntimeDouble({
        ...account,
        orderRecorder: recorder,
        orderExecutor: {
          executeSignals: async (signals, authorization) => {
            submitted.push(...signals);
            const result = await executor.executeSignals(signals, authorization);
            acceptedOrderIds.push(...result.executedOrderIds);
            return result;
          },
        },
      });
      const postTrade = createPostTradeConsistencyRuntime({
        diagnostics: createDiagnosticObserverDouble(),
        clock: { now: () => new Date() },
        logger: createLoggerDouble(),
        termination,
        getProtectiveOrderReader: () => tradeRuntime.orderMonitor,
        snapshot,
        onPositionsCommitted: async () => {},
        scheduler: h.deps.scheduler,
      });
      settlement = postTrade;
      postTrade.bindBusinessDeps({
        monitorContext,
        dailyLossTracker: daily,
        liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
        protectiveLiquidationEpisodeTracker: episode,
        mixedTradeLogRepository: { appendCompletionIdempotent: () => {} },
      });
      postTrade.start();
      expect(await postTrade.completeRebuildBaseline()).toBeTrue();
      const originalReceipt = await postTrade.waitForFresh();
      expect(postTrade.isCurrent(originalReceipt)).toBeTrue();
      blockPositions = true;
      postTrade.recordSettlementRefreshNeed({ refreshAccount: false, refreshPositions: true });
      for (const timer of h.timers) timer.callback();

      const processor = createSellProcessor({
        logger: createLoggerDouble(),
        scheduler: h.deps.scheduler,
        termination,
        taskQueue: sellTaskQueue,
        workflow: createOrdinarySellWorkflow({
          logger: createLoggerDouble(),
          clock: h.deps.clock,
          config,
          symbolRegistry: monitorContext.symbolRegistry,

          orderRecorder: tradeRuntime.orderRecorder,
          orderExecutor: tradeRuntime.orderExecutor,
          marketDataClient: market,
          getTradingCalendar: () => ({
            isHalfDay: stateFixtures.tradingTimeState.isHalfDay ?? false,
            tradingCalendarSnapshot: stateFixtures.tradingCalendarState.tradingCalendarSnapshot,
          }),
          getCanProcessTask: () => stateFixtures.lifecycleState.isTradingEnabled,
          termination,
          snapshot,
          settlement: postTrade,
        }),
        getCanProcessTask: () => stateFixtures.lifecycleState.isTradingEnabled,
      });
      processor.start();
      try {
        await waitUntil(() => waiting);
        expect(submitted).toEqual([]);
        expect(native.nativeSubmitObservations()).toHaveLength(0);
        native.setStockPositions([
          {
            symbol: 'BULL.HK',
            symbolName: 'BULL.HK',
            accountChannel: 'lb_papertrading',
            currency: 'HKD',
            quantity: '300',
            availableQuantity: '200',
            costPrice: '1',
          },
        ]);
        fresh.resolve();
        await waitUntil(() => native.nativeSubmitObservations().length === 1);
        expect(submitted[0]?.action).toBe('SELLCALL');
        expect(submitted[0]?.quantity).toBe(200);
        expect(coordinationReads).toBeGreaterThan(0);
        expect(native.nativeSubmitObservations()[0]).toMatchObject({
          side: 'SELL',
          quantity: '200',
          price: '1.1',
          orderType: 'ELO',
          timeInForce: 'DAY',
        });
        await waitUntil(() => acceptedOrderIds.length === 1);
        expect(acceptedOrderIds).toEqual(['FOLLOW-UP']);
        expect(snapshot.getAvailablePosition('BULL.HK')).toMatchObject({
          quantity: 300,
          availableQuantity: 200,
        });
        expect(recorder.getBuyOrdersForSymbol('BULL.HK', true)).toEqual([]);
      } finally {
        fresh.resolve();
        await processor.stopAndDrain();
        await postTrade.stopAndDrain();
        await monitor.stopRuntimeAndDrain();
        strategy.destroy();
      }
    },
  );
});
