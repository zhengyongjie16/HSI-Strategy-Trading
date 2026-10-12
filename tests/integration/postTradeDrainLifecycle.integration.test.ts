/**
 * T25：挂起真实 PostTrade 持仓请求，验证午夜/正常退出/fatal 排空均先完成 Quote 回调。
 * 测试只连接离线交易和行情端口，不启动真实应用或 Broker。
 */
import { describe, expect, it } from 'bun:test';
import { createPostTradeConsistencyRuntime } from '../../src/app/runtime/createPostTradeConsistencyRuntime.js';
import { createTerminationRuntime } from '../../src/app/runtime/createTerminationRuntime.js';
import { createQuoteSubscriptionRuntime } from '../../src/main/quoteSubscriptionRuntime/index.js';
import { createSignalRuntimeDomain } from '../../src/main/lifecycle/cacheDomains/signalRuntimeDomain.js';
import { createCleanup } from '../../src/app/shutdown/createCleanup.js';
import {
  createBuyTaskQueue,
  createSellTaskQueue,
} from '../../src/main/asyncProgram/tradeTaskQueue/index.js';
import { createMonitorTaskQueue } from '../../src/main/asyncProgram/monitorTaskQueue/index.js';
import { createTradingConfig } from '../../mock/factories/configFactory.js';
import type { PostTradeConsistencyRuntime } from '../../src/app/types.js';
import type { LastState } from '../../src/types/state.js';
import type { Position } from '../../src/types/account.js';
import type { Processor } from '../../src/main/asyncProgram/types.js';
import { createAccountPositionSnapshot } from '../../src/application/accountPositionSnapshot/index.js';
import {
  createDailyLossOrderAnalysisDeps,
  createOrderRecorder,
} from '../../src/core/orderRecorder/index.js';
import { createDailyLossTracker } from '../../src/core/riskController/dailyLossTracker.js';
import { createProtectiveLiquidationEpisodeTracker } from '../../src/core/trader/protectiveLiquidationEpisodeTracker/index.js';
import { toHongKongTimeIso } from '../../src/utils/time/index.js';
import { createHarness } from '../core/strategy/intradayRegression/fixtures.js';
import { waitUntil } from '../main/asyncProgram/utils.js';
import {
  createAccountSnapshotDouble,
  createAutoSearchWakeupRuntimeDouble,
  createLiquidationCooldownTrackerDouble,
  createLoggerDouble,
  createMarketDataClientDouble,
  createMonitorContextDouble,
  createPeriodicSwitchWakeupRuntimeDouble,
  createPositionDouble,
  createSeatActivationDispatcherDouble,
  createSeatRuntimeCleanupDispatcherDouble,
  createTraderDouble,
} from '../helpers/testDoubles.js';

/** 不承担待测在途工作的处理器，提供生命周期必需的完整启停端口。 */
function createIdleProcessor(): Processor {
  return { start: () => {}, stop: () => {}, stopAndDrain: async () => {}, restart: () => {} };
}

describe('PostTrade drain and Quote lifetime integration', () => {
  it.each(['midnight', 'shutdown', 'fatal'])(
    'drains committed positions before Quote stops on %s',
    async (mode) => {
      const h = createHarness();
      const positions = Promise.withResolvers<ReadonlyArray<Position>>();
      let requested = false;
      const trace: string[] = [];
      const daily = createDailyLossTracker({
        ...createDailyLossOrderAnalysisDeps(),
        toHongKongTimeIso,
      });
      daily.resetAll(new Date('2026-02-16T01:31:00.000Z'));
      const episode = createProtectiveLiquidationEpisodeTracker();
      const lastState: LastState = {
        canTrade: true,
        isHalfDay: false,
        openProtectionActive: false,
        currentDayKey: '2026-02-16',
        lifecycleState: 'ACTIVE',
        pendingOpenRebuild: false,
        isTradingEnabled: true,
        cachedTradingDayInfo: null,
        tradingCalendarSnapshot: new Map(),
        allTradingSymbols: new Set(),
      };
      const termination = createTerminationRuntime({
        closeTradingGate: () => {
          lastState.isTradingEnabled = false;
        },
        closeProducerAdmission: () => {},
        stopProducers: [],
        onSecondaryError: (error) => {
          throw error;
        },
      });
      let delayedRead = false;
      const snapshot = createAccountPositionSnapshot({
        dayEpoch: 1,
        scheduler: { schedule: queueMicrotask },
        reportFatalError: termination.reportFatalError,
        readPort: {
          getAccountSnapshot: async () => createAccountSnapshotDouble('100000'),
          getStockPositions: () => {
            if (!delayedRead) return Promise.resolve([]);

            requested = true;
            return positions.promise;
          },
        },
      });
      let recordNeedOwner: PostTradeConsistencyRuntime | null = null;
      const recorder = createOrderRecorder({
        orderSnapshotReadPort: {
          fetchSnapshots: async () => {
            throw new Error('Drain case does not authorize order IO');
          },
        },
        getExecutionTimeEvidence: daily.getExecutionTimeEvidence,
        settlementRefreshNeedRecorder: {
          recordSettlementRefreshNeed: (need) => {
            if (recordNeedOwner === null) throw new Error('PostTrade owner not yet assembled');

            recordNeedOwner.recordSettlementRefreshNeed(need);
          },
        },
      });
      const monitorContext = createMonitorContextDouble({
        orderRecorder: recorder,
        dailyLossTracker: daily,
      });
      const trader = createTraderDouble({
        orderRecorder: recorder,
        getAccountSnapshot: async () => createAccountSnapshotDouble('100000'),
        getStockPositions: () => {
          requested = true;
          return positions.promise;
        },
      });
      const marketDataClient = createMarketDataClientDouble({
        subscribeSymbols: async (symbols) => {
          trace.push('subscribe:' + [...symbols].join(','));
        },
      });
      const quotes = createQuoteSubscriptionRuntime({
        logger: createLoggerDouble(),
        tradingConfig: createTradingConfig(),
        symbolRegistry: monitorContext.symbolRegistry,
        marketDataClient,
        trader,
        lastState,
        snapshot,
        termination,
      });
      const baseline = await snapshot.requestRefresh({
        source: 'DRAIN_BASELINE',
        dayEpoch: 1,
        refreshAccount: true,
        refreshPositions: true,
      }).result;
      if (baseline.status !== 'COMMITTED') throw new Error('Drain paired H baseline aborted');

      // 启动前的显式 reconcile 必须可用；此处建立基线以辨认后续持仓订阅。
      await quotes.reconcileFromCurrentTruth();
      quotes.start();
      const postTrade = createPostTradeConsistencyRuntime({
        termination,
        getTrader: () => trader,
        snapshot,
        scheduler: h.deps.scheduler,
        onPositionsCommitted: async (token) => {
          await quotes.reconcilePositionHoldFromCurrentTruth(token);
          trace.push('positions-callback-complete');
        },
      });
      postTrade.bindBusinessDeps({
        monitorContext,
        dailyLossTracker: daily,
        liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
        protectiveLiquidationEpisodeTracker: episode,
        mixedTradeLogRepository: { appendCompletionIdempotent: () => {} },
      });
      recordNeedOwner = postTrade;
      expect(
        snapshot.isCurrent(baseline.snapshotToken, {
          account: true,
          positions: true,
          paired: true,
        }),
      ).toBeTrue();
      postTrade.start();
      expect(await postTrade.completeRebuildBaseline()).toBeTrue();
      const receipt = await postTrade.waitForFresh();
      expect(postTrade.isCurrent(receipt)).toBeTrue();
      trace.length = 0;
      delayedRead = true;
      postTrade.recordSettlementRefreshNeed({ refreshAccount: false, refreshPositions: true });
      for (const timer of h.timers) timer.callback();

      await waitUntil(() => requested);
      const drainPostTrade = async (): Promise<void> => {
        await postTrade.stopAndDrain();
        trace.push('post-trade-drain-complete');
      };

      const drainQuotes = async (): Promise<void> => {
        await quotes.stopAndDrain();
        trace.push('quote-stop-complete');
      };
      const fatal = new Error('injected-fatal');
      let cleanupPromise: Promise<void>;
      if (mode === 'midnight') {
        lastState.isTradingEnabled = false;
        const idle = createIdleProcessor();
        const domain = createSignalRuntimeDomain({
          termination,
          logger: createLoggerDouble(),
          monitorContext,
          buyProcessor: idle,
          sellProcessor: idle,
          monitorTaskProcessor: idle,
          businessEventProgram: idle,
          tradingRiskEventRuntime: idle,
          monitorQuoteEventRuntime: idle,
          monitorDisplayRuntime: idle,
          tradingQuoteDisplayRuntime: idle,
          switchWakeupRuntime: idle,
          periodicSwitchWakeupRuntime: createPeriodicSwitchWakeupRuntimeDouble(),
          autoSearchWakeupRuntime: createAutoSearchWakeupRuntimeDouble(),
          seatActivationDispatcher: createSeatActivationDispatcherDouble(),
          seatRuntimeCleanupDispatcher: createSeatRuntimeCleanupDispatcherDouble(),
          quoteSubscriptionRuntime: { ...quotes, stopAndDrain: drainQuotes },
          trader,
          postTradeConsistencyRuntime: { ...postTrade, stopAndDrain: drainPostTrade },
          buyTaskQueue: createBuyTaskQueue(),
          sellTaskQueue: createSellTaskQueue(),
          monitorTaskQueue: createMonitorTaskQueue(),
        });
        cleanupPromise = Promise.resolve(
          domain.midnightClear({
            now: new Date('2026-02-17T00:00:00+08:00'),
            runtime: { dayKey: '2026-02-17', canTradeNow: false, isTradingDay: true },
          }),
        );
      } else {
        if (mode === 'fatal') termination.reportFatalError(fatal);
        else termination.requestShutdown();

        const cleanup = createCleanup();
        cleanup.register({
          phase: 'STOP_QUOTE_SUBSCRIPTION_RUNTIME',
          step: 'quote',
          handler: drainQuotes,
        });

        cleanup.register({
          phase: 'STOP_POST_TRADE_CONSISTENCY_RUNTIME',
          step: 'post-trade',
          handler: drainPostTrade,
        });
        cleanupPromise = cleanup.execute();
        expect(cleanup.execute()).toBe(cleanupPromise);
      }

      expect(lastState.isTradingEnabled).toBe(false);
      await Promise.resolve();
      expect(trace).not.toContain('quote-stop-complete');
      expect(trace).not.toContain('post-trade-drain-complete');
      const held = createPositionDouble({
        symbol: 'LATE-POSITION.HK',
        quantity: 100,
        availableQuantity: 100,
      });
      positions.resolve([held]);
      await cleanupPromise;
      expect(trace.filter((event) => !event.startsWith('subscribe:'))).toEqual([
        'positions-callback-complete',
        'post-trade-drain-complete',
        'quote-stop-complete',
      ]);
      expect(snapshot.getView().positions).toEqual([held]);
      const finishedTrace = [...trace];
      postTrade.recordSettlementRefreshNeed({ refreshAccount: true, refreshPositions: true });
      for (const timer of h.timers) timer.callback();

      await Promise.resolve();
      expect(trace).toEqual(finishedTrace);
      expect(termination.getFatalState()).toEqual(
        mode === 'fatal' ? { hasFatalError: true, error: fatal } : { hasFatalError: false },
      );
    },
  );
});
