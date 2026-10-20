import { createDiagnosticObserverDouble } from '../helpers/diagnostics.js';
import type { RuntimeStateFixtures } from '../helpers/types.js';
import { scheduleBoundedOneShotAt } from '../../src/runtime/timer/index.js';
import { wrapExternalApiRequest } from '../../src/infrastructure/externalApi/index.js';
import { wait } from '../../src/infrastructure/time/index.js';
import type { TradeRuntime } from '../../src/app/runtime/types.js';

/**
 * M1 真实连接回归：SDK bootstrap 缓冲成交 → 同一 O/Daily/H/S → loader 重载 → quote/业务 ready → lifecycle 开门。
 * 仅券商、行情 IO 与 timer 可控；不为 S 改 source，不人工清 need 或直接签 freshness。
 */

import { describe, expect, it } from 'bun:test';
import { createMonitorConfig, createTradingConfig } from '../../mock/factories/configFactory.js';
import { executeTradingDayOpenRebuild } from '../../src/application/tradingDayRebuild/openRebuild.js';
import { createPostTradeConsistencyRuntime } from '../../src/app/runtime/createPostTradeConsistencyRuntime.js';
import { createTerminationRuntime } from '../../src/runtime/lifecycle/terminationRuntime.js';
import { createAccountPositionSnapshot } from '../../src/application/accountPositionSnapshot/index.js';
import { createWarrantCandidateSearch } from '../../src/application/autoSearch/candidateSearch.js';
import { createStartupSeatSearch } from '../../src/application/autoSearch/startupSeatSearch.js';
import { createOrderHoldRegistry } from '../../src/application/orderTracking/orderHoldRegistry.js';
import { createWarrantRiskRefresh } from '../../src/application/riskRefresh/warrantRiskRefresh.js';
import { createProtectiveLiquidationEpisodeTracker } from '../../src/domain/liquidation/episode/index.js';
import { orderAnalysis } from '../../src/domain/order/orderAnalysis.js';
import { createDailyLossTracker } from '../../src/domain/risk/dailyLossTracker.js';
import { createRiskChecker } from '../../src/domain/risk/index.js';
import { createPositionLimitChecker } from '../../src/domain/risk/positionLimitChecker.js';
import { createUnrealizedLossChecker } from '../../src/domain/risk/unrealizedLossChecker.js';
import { createWarrantRiskChecker } from '../../src/domain/risk/warrantRiskChecker.js';
import { createSymbolRegistry } from '../../src/domain/seat/symbolRegistry.js';
import { createDayLifecycleManager } from '../../src/runtime/lifecycle/dayLifecycleManager.js';
import { createLoadTradingDayRuntimeSnapshot } from '../../src/application/tradingDayRebuild/loadTradingDayRuntimeSnapshot.js';
import { createRebuildTradingDayState } from '../../src/application/tradingDayRebuild/rebuildTradingDayState.js';
import { createQuoteSubscriptionRuntime } from '../../src/runtime/quoteSubscriptionRuntime/index.js';
import type { QuoteSubscriptionRuntime } from '../../src/runtime/quoteSubscriptionRuntime/types.js';
import type { RuntimeScheduler } from '../../src/types/runtime.js';
import { getTradingMinutesSinceOpen } from '../../src/domain/tradingSession/index.js';
import { toHongKongTimeIso } from '../../src/utils/time/index.js';
import { createExternalApiRequestError } from '../helpers/createExternalApiRequestError.js';
import {
  createLiquidationCooldownTrackerDouble,
  createLoggerDouble,
  createMarketDataClientDouble,
  createMonitorContextDouble,
  createQuoteDouble,
  createRateLimiterDouble,
  createTradeRuntimeDouble,
} from '../helpers/testDoubles.js';
import { createBrokerIngressFixture } from './architectureRefactoringP1Native/trade/brokerIngressFixture.js';

const now = new Date('2026-07-10T02:00:00.000Z');
const timeMs = now.getTime();
const dayKey = '2026-07-10';

async function flush(): Promise<void> {
  for (let count = 0; count < 120; count++) await Promise.resolve();
}

async function createHarness(
  options: {
    readonly partial?: boolean;
    readonly emitRecovery?: boolean;
    readonly subscribe?: () => Promise<void>;
    readonly afterPositions?: () => Promise<void>;
  } = {},
) {
  const quantity = options.partial ? '200' : '100';
  const openFrame = {
    orderId: 'REBUILD-BUY',
    symbol: 'BULL.HK',
    stockName: 'HSI RC',
    remark: '',
    side: 'BUY' as const,
    status: 'New' as const,
    quantity,
    executedQuantity: '0',
    submittedPrice: '10',
    executedPrice: '0',
    submittedAtMs: timeMs - 60_000,
    updatedAtMs: timeMs - 60_000,
  };
  const filledFrame = {
    ...openFrame,
    status: options.partial ? ('PartialFilled' as const) : ('Filled' as const),
    executedQuantity: '100',
    executedPrice: '10',
    updatedAtMs: timeMs + 1_000,
  };
  const native = await createBrokerIngressFixture(openFrame);
  native.setOrderSnapshotReplies([], [openFrame]);

  native.setAccountBalance({
    currency: 'HKD',
    totalCash: '100000',
    netAssets: '101000',
    availableCash: '100000',
  });
  const setPositions = (positionQuantity: string): void => {
    native.setStockPositions([
      {
        symbol: 'BULL.HK',
        symbolName: 'HSI RC',
        currency: 'HKD',
        accountChannel: 'cash',
        quantity: positionQuantity,
        availableQuantity: positionQuantity,
        costPrice: '10',
      },
    ]);
  };
  setPositions(options.emitRecovery === false ? '0' : '100');
  const stateFixtures: RuntimeStateFixtures = {
    tradingTimeState: { canTrade: false, isHalfDay: false, openProtectionActive: false },
    lifecycleState: {
      currentDayKey: dayKey,
      lifecycleState: 'MIDNIGHT_CLEANED',
      pendingOpenRebuild: true,
      isTradingEnabled: false,
    },
    tradingCalendarState: { cachedTradingDayInfo: null, tradingCalendarSnapshot: new Map() },
    quoteSubscriptionState: { allTradingSymbols: new Set() },
  };
  const termination = createTerminationRuntime({
    closeTradingGate: () => {
      stateFixtures.lifecycleState.isTradingEnabled = false;
    },
    closeProducerAdmission: () => {},
    stopProducers: [],
    onSecondaryError: () => {},
  });
  const timerCallbacks = new Map<ReturnType<typeof setTimeout>, () => void>();
  const scheduler: RuntimeScheduler = {
    scheduleTimer: (callback) => {
      const handle = setTimeout(() => {}, 2_147_483_647);
      clearTimeout(handle);
      timerCallbacks.set(handle, callback);
      return handle;
    },
    clearTimer: (handle) => {
      timerCallbacks.delete(handle);
    },
  };
  const config = createMonitorConfig({
    monitorSymbol: 'HSI.HK',
    longSymbol: 'BULL.HK',
    shortSymbol: 'BEAR.HK',
    orderOwnershipMapping: ['HSI'],
  });
  const tradingConfig = createTradingConfig({ monitor: config });
  const symbolRegistry = createSymbolRegistry(config);
  const daily = createDailyLossTracker({
    onOwnershipWarning: () => {},
    ...orderAnalysis,
    toHongKongTimeIso,
  });
  const episode = createProtectiveLiquidationEpisodeTracker();
  const rateLimiter = createRateLimiterDouble();
  const snapshot = createAccountPositionSnapshot({
    clock: { now: () => new Date() },
    diagnostics: createDiagnosticObserverDouble(),
    dayEpoch: 1,
    scheduler: { schedule: queueMicrotask },
    readPort: native.createAccountService({ rateLimiter }),
    reportFatalError: termination.reportFatalError,
  });
  let recovered = false;
  const market = createMarketDataClientDouble({
    getQuotes: async (symbols) => {
      if (!recovered && options.emitRecovery !== false) {
        recovered = true;
        native.setOrderSnapshotReplies([], [filledFrame]);
        native.emitOrderChangedFrame(filledFrame);
      }

      return new Map(
        [...symbols].map((symbol) => [
          symbol,
          createQuoteDouble(symbol, symbol === 'HSI.HK' ? '20000' : '10', 1),
        ]),
      );
    },
    getTradingDays: async () => ({ tradingDays: [dayKey], halfTradingDays: [] }),
    subscribeSymbols: async () => {
      if (recovered) await options.subscribe?.();
    },
  });
  let tradeRuntime: TradeRuntime | null = null;
  let quote: QuoteSubscriptionRuntime | null = null;
  const postTrade = createPostTradeConsistencyRuntime({
    diagnostics: createDiagnosticObserverDouble(),
    clock: { now: () => new Date() },
    logger: createLoggerDouble(),
    snapshot,
    termination,
    scheduler,
    getProtectiveOrderReader: () => {
      if (tradeRuntime === null) throw new Error('Trader must be assembled before S starts');

      return tradeRuntime.orderMonitor;
    },
    onPositionsCommitted: async (token) => {
      if (quote === null) throw new Error('Quote owner must be assembled before S starts');

      await quote.reconcilePositionHoldFromCurrentTruth(token);
      await options.afterPositions?.();
    },
  });
  const recorder = native.createRecorder({
    logger: createLoggerDouble(),
    rateLimiter,
    settlementRefreshNeedRecorder: postTrade,
  });
  const holds = createOrderHoldRegistry();
  const monitor = native.createMonitor({
    diagnostics: createDiagnosticObserverDouble(),
    logger: createLoggerDouble(),
    wait: wait,
    requestExternalApi: wrapExternalApiRequest,
    scheduleBoundedOneShotAt: scheduleBoundedOneShotAt,
    rateLimiter,
    marketDataClient: market,
    orderRecorder: recorder,
    cacheManager: { clearCache: () => {}, getPendingOrders: async () => [] },
    dailyLossTracker: daily,
    protectiveLiquidationEpisodeTracker: episode,
    orderHoldRegistry: holds,
    persistProtectiveLiquidationExecutionProgress: () => {
      throw new Error('ordinary BUY must not persist protection');
    },
    postTradeConsistencyRuntime: postTrade,
    tradingConfig,
    symbolRegistry,
    isContinuousTradingAllowed: () => false,
    termination,
    now: () => now,
    scheduleTimer: setTimeout,
    clearTimer: clearTimeout,
  });
  tradeRuntime = createTradeRuntimeDouble({
    orderMonitor: {
      initialize: monitor.initialize,
      recoverOrderTrackingFromSnapshot: monitor.recoverOrderTrackingFromSnapshot,
    },
    orderRecorder: { fetchAllOrdersFromAPI: recorder.fetchAllOrdersFromAPI },
    orderHoldRegistry: {
      seedFromOrders: holds.seedFromOrders,
      getHoldSymbols: holds.getHoldSymbols,
    },
  });
  const warrantRiskChecker = createWarrantRiskChecker({
    onInvalidCallPrice: () => {},
    onWarrantInfoSet: () => {},
  });
  const risk = createRiskChecker({
    warrantRiskChecker,
    positionLimitChecker: createPositionLimitChecker({ maxPositionNotional: null }),
    unrealizedLossChecker: createUnrealizedLossChecker({
      maxUnrealizedLossPerSymbol: null,
      onMissingData: () => {},
    }),
  });
  const context = createMonitorContextDouble({
    config,
    symbolRegistry,
    orderRecorder: recorder,
    dailyLossTracker: daily,
    riskChecker: risk,
  });
  quote = createQuoteSubscriptionRuntime({
    snapshot,
    termination,
    orderHoldRegistry: tradeRuntime.orderHoldRegistry,
    symbolRegistry,
    tradingConfig,
    ...stateFixtures,
    logger: createLoggerDouble(),
    marketDataClient: {
      subscribeSymbols: async () => {
        await options.subscribe?.();
      },
      unsubscribeSymbols: async () => {},
    },
  });
  const repository = {
    appendTradeRecord: () => {
      throw new Error('rebuild must not write trade display log');
    },
    loadCompletionRecords: () => [],
    loadExecutionProgressRecords: () => [],
    appendCompletionIdempotent: () => {
      throw new Error('ordinary BUY must not complete protection');
    },
    appendExecutionProgressIdempotent: () => {
      throw new Error('ordinary BUY must not persist protection');
    },
  };
  postTrade.bindBusinessDeps({
    monitorContext: context,
    dailyLossTracker: daily,
    protectiveLiquidationEpisodeTracker: episode,
    liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
    mixedTradeLogRepository: repository,
  });
  const load = createLoadTradingDayRuntimeSnapshot({
    logger: createLoggerDouble(),
    snapshot,
    marketDataClient: market,
    orderRecorder: tradeRuntime.orderRecorder,
    orderHoldRegistry: tradeRuntime.orderHoldRegistry,
    orderMonitor: tradeRuntime.orderMonitor,
    ...stateFixtures,
    tradingConfig,
    symbolRegistry,
    dailyLossTracker: daily,
    protectiveLiquidationEpisodeTracker: episode,
    tradeLogHydrator: { hydrate: () => {} },
    mixedTradeLogRepository: repository,
    protectionRecovery: postTrade,
    seatActivationDispatcher: { dispatchCurrentActivatingSeats: () => {} },
    startupSeatSearch: createStartupSeatSearch({
      monitorSymbol: tradingConfig.monitor.monitorSymbol,
      symbolRegistry,
      candidateSearch: createWarrantCandidateSearch({
        monitorSymbol: tradingConfig.monitor.monitorSymbol,
        autoSearchConfig: tradingConfig.monitor.autoSearchConfig,
        marketDataClient: market,
        logger: createLoggerDouble(),
        getTradingMinutesSinceOpen,
      }),
      logger: createLoggerDouble(),
    }),
  });
  const rebuild = createRebuildTradingDayState({
    snapshot,
    termination,
    marketDataClient: market,
    warrantRiskRefresh: createWarrantRiskRefresh({
      marketDataClient: market,
      warrantRiskChecker,
      logger: createLoggerDouble(),
    }),
    orderMonitor: tradeRuntime.orderMonitor,
    ...stateFixtures,
    symbolRegistry,
    monitorContext: context,
    dailyLossTracker: daily,
    displayAccountAndPositions: () => {},
  });
  let loads = 0;
  const manager = createDayLifecycleManager({
    diagnostics: createDiagnosticObserverDouble(),
    snapshot,
    termination,
    mutableState: stateFixtures.lifecycleState,
    logger: createLoggerDouble(),
    rebuildRetryDelayMs: 1000,
    cacheDomains: [
      {
        midnightClear: () => {},
        openRebuild: () =>
          executeTradingDayOpenRebuild({
            snapshot,
            termination,
            now,
            postTradeConsistencyRuntime: postTrade,
            quoteSubscriptionRuntime: quote,
            loadTradingDayRuntimeSnapshot: async (params) => {
              loads++;
              return load(params);
            },
            rebuildTradingDayState: rebuild,
          }),
      },
    ],
  });
  return {
    snapshot,
    postTrade,
    quote,
    native,
    recorder,
    context,
    termination,
    ...stateFixtures,
    manager,
    loads: () => loads,
    pendingTimers: () => timerCallbacks.size,
    fillRemainder: async () => {
      setPositions('200');
      const finalFrame = {
        ...filledFrame,
        status: 'Filled' as const,
        executedQuantity: '200',
        updatedAtMs: timeMs + 3_000,
      };
      native.setOrderSnapshotReplies([], [finalFrame]);
      native.emitOrderChangedFrame(finalFrame);
      await flush();
    },
    cleanup: async () => {
      await postTrade.stopAndDrain();
      await quote.stopAndDrain();
      await monitor.stopRuntimeAndDrain();
      await monitor.teardown();
    },
  };
}
const flags = { dayKey, canTradeNow: true, isTradingDay: true };

describe('rebuild settlement readiness real owner integration', () => {
  it('baseline 在途日切 ABORTED 不签 ready、不自动重调；旧工作仍完整 settled 后交 lifecycle 接管', async () => {
    const entered = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const f = await createHarness({
      afterPositions: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    let events = 0;
    f.postTrade.onFreshReached(() => {
      events++;
    });
    const opening = f.manager.tick(now, flags);
    try {
      await entered.promise;
      await f.snapshot.requestClear({ reason: 'DAY_CUT', dayEpoch: 2 });
      release.resolve();
      await opening;
      expect(f.lifecycleState.pendingOpenRebuild).toBe(true);
      expect(f.lifecycleState.isTradingEnabled).toBe(false);
      expect(f.snapshot.getStatus().admission).toBe('CLOSED');
      expect(f.postTrade.getStatus()).toMatchObject({ currentVersion: 0, staleVersion: 1 });
      expect(events).toBe(0);
      expect(f.pendingTimers()).toBe(0);
      expect(f.termination.getFatalState()).toEqual({ hasFatalError: false });
    } finally {
      release.resolve();
      await opening;
      await f.cleanup();
    }
  });

  it('恢复成交使旧基线失效后重载；quote 未成功不 fresh/开门，S 普通请求仍拒绝且无 0ms 空转', async () => {
    const entered = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const f = await createHarness({
      subscribe: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    const opening = f.manager.tick(now, flags);
    try {
      await entered.promise;
      expect(f.loads()).toBe(2);
      expect(f.postTrade.getStatus()).toMatchObject({ currentVersion: 0, staleVersion: 1 });
      expect(f.lifecycleState.isTradingEnabled).toBe(false);
      expect(f.snapshot.getStatus().admission).toBe('REBUILD');
      // S 即使已经在 failed/retry 生命周期中启动，也不能普通 admission 发读或 0ms 自转。
      f.postTrade.start();
      let readyBeforeQuote = false;
      const waiting = f.postTrade.waitForFresh().then(() => {
        readyBeforeQuote = true;
      });
      const reads = f.native.accountReadCounts();
      expect(
        await f.snapshot.requestRefresh({
          source: 'POST_TRADE_SETTLEMENT',
          dayEpoch: 1,
          refreshAccount: true,
          refreshPositions: true,
        }).result,
      ).toEqual({ status: 'ABORTED' });
      await flush();
      expect(f.native.accountReadCounts()).toEqual(reads);
      expect(f.pendingTimers()).toBe(0);
      expect(readyBeforeQuote).toBe(false);
      release.resolve();
      await opening;
      await waiting;
      expect(f.postTrade.getStatus()).toMatchObject({ currentVersion: 1, staleVersion: 1 });
      expect(f.recorder.getCostBasis('BULL.HK', true)).toEqual({
        costAmount: '1000',
        quantity: 100,
      });
      expect(f.lifecycleState.isTradingEnabled).toBe(true);
      expect(f.snapshot.getStatus().admission).toBe('OPEN');
      expect(f.native.accountReadCounts()).toEqual(reads);
      expect(f.termination.getFatalState()).toEqual({ hasFatalError: false });
    } finally {
      release.resolve();
      await opening;
      await f.cleanup();
    }
  });

  it('baseline 后置 await 中新成交保留新旧 need，由同一 open owner 再重载到当前事实，不伪 fresh', async () => {
    const entered = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    let callbacks = 0;
    const f = await createHarness({
      partial: true,
      afterPositions: async () => {
        callbacks++;
        if (callbacks === 1) {
          entered.resolve();
          await release.promise;
        }
      },
    });
    const opening = f.manager.tick(now, flags);
    try {
      await entered.promise;
      expect(f.postTrade.getStatus().staleVersion).toBe(1);
      await f.fillRemainder();
      expect(f.postTrade.getStatus()).toMatchObject({ currentVersion: 0, staleVersion: 2 });
      expect(f.pendingTimers()).toBe(0);
      expect(f.lifecycleState.isTradingEnabled).toBe(false);
      release.resolve();
      await opening;
      expect(f.loads()).toBe(3);
      expect(callbacks).toBe(2);
      const ready = await f.postTrade.waitForFresh();
      expect(ready.settlementVersion).toBe(2);
      expect(ready.snapshotToken).toEqual(f.snapshot.getView().token);
      expect(f.recorder.getCostBasis('BULL.HK', true)).toEqual({
        costAmount: '2000',
        quantity: 200,
      });
      expect(f.lifecycleState.isTradingEnabled).toBe(true);
    } finally {
      release.resolve();
      await opening;
      await f.cleanup();
    }
  });

  it('无成交 need 的 baseline 后置外部失败仍保持 businessDirty，原 lifecycle 重试完成业务才 fresh', async () => {
    const fault = await createExternalApiRequestError({
      operation: 'QuoteContext.subscribe',
      attempts: 1,
      cause: new Error('subscription unavailable'),
    });
    let callbacks = 0;
    const f = await createHarness({
      emitRecovery: false,
      afterPositions: async () => {
        callbacks++;
        if (callbacks === 1) throw fault;
      },
    });
    try {
      const failed = await f.manager.tick(now, flags);
      expect(failed.nextRetryAtMs).toBe(timeMs + 1000);
      expect(f.lifecycleState.lifecycleState).toBe('OPEN_REBUILD_FAILED');
      expect(f.lifecycleState.isTradingEnabled).toBe(false);
      expect(f.postTrade.getStatus()).toMatchObject({ currentVersion: 0, staleVersion: 0 });
      expect(f.pendingTimers()).toBe(0);
      let fresh = false;
      const waiting = f.postTrade.waitForFresh().then(() => {
        fresh = true;
      });
      await flush();
      expect(fresh).toBe(false);
      expect(f.pendingTimers()).toBe(0);
      await f.manager.tick(new Date(timeMs + 1000), flags);
      await waiting;
      expect(callbacks).toBe(2);
      expect(f.lifecycleState.isTradingEnabled).toBe(true);
      expect(f.termination.getFatalState()).toEqual({ hasFatalError: false });
    } finally {
      await f.cleanup();
    }
  });
});
