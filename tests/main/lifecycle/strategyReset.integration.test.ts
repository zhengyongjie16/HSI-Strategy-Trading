/** T24/T27：真实策略跨日重置与真实 PostTrade 内部拒绝的生命周期集成验收。 */
import { describe, expect, it } from 'bun:test';
import { createSignalRuntimeDomain } from '../../../src/main/lifecycle/cacheDomains/signalRuntimeDomain.js';
import { createDayLifecycleManager } from '../../../src/main/lifecycle/dayLifecycleManager.js';
import { createTerminationRuntime } from '../../../src/app/runtime/createTerminationRuntime.js';
import { createPostTradeConsistencyRuntime } from '../../../src/app/runtime/createPostTradeConsistencyRuntime.js';
import { createQuoteSubscriptionRuntime } from '../../../src/main/quoteSubscriptionRuntime/index.js';
import { createCleanup } from '../../../src/app/shutdown/createCleanup.js';
import {
  createBuyTaskQueue,
  createSellTaskQueue,
} from '../../../src/main/asyncProgram/tradeTaskQueue/index.js';
import { createMonitorTaskQueue } from '../../../src/main/asyncProgram/monitorTaskQueue/index.js';

import { createTradingConfig } from '../../../mock/factories/configFactory.js';
import {
  prepareFixture,
  configObject,
  createHarness,
  marketContext,
} from '../../core/strategy/intradayRegression/fixtures.js';
import { waitUntil } from '../../main/asyncProgram/utils.js';
import type { StrategyDecision, TradingSignalStrategy } from '../../../src/core/strategy/types.js';
import type { LastState } from '../../../src/types/state.js';
import type { Position } from '../../../src/types/account.js';
import type { SignalRuntimeDomainDeps } from '../../../src/main/lifecycle/cacheDomains/types.js';
import {
  createDailyLossTrackerDouble,
  createLiquidationCooldownTrackerDouble,
  createProtectiveLiquidationEpisodeTrackerDouble,
  createLoggerDouble,
  createMarketDataClientDouble,
  createMonitorContextDouble,
  createPositionCacheDouble,
  createTraderDouble,
} from '../../helpers/testDoubles.js';

/** 组装真实 domain、manager、PostTrade 和 Quote，共享同一状态与策略实例。 */
function lifecycleHarness(
  strategy: TradingSignalStrategy,
  getPositions: () => Promise<ReadonlyArray<Position>> = async () => [],
) {
  const h = createHarness();
  const trace: string[] = [];
  const state: LastState = {
    canTrade: true,
    isHalfDay: false,
    openProtectionActive: false,
    currentDayKey: '2026-02-16',
    lifecycleState: 'ACTIVE',
    pendingOpenRebuild: false,
    isTradingEnabled: true,
    cachedAccount: null,
    cachedPositions: [],
    positionCache: createPositionCacheDouble(),
    cachedTradingDayInfo: null,
    tradingCalendarSnapshot: new Map(),
    allTradingSymbols: new Set(),
  };
  const termination = createTerminationRuntime({
    closeTradingGate: () => {
      state.isTradingEnabled = false;
    },
    closeProducerAdmission: () => {},
    stopProducers: [],
    onSecondaryError: () => {},
  });
  const context = createMonitorContextDouble({ strategy });
  const trader = createTraderDouble({ getStockPositions: getPositions });
  const quotes = createQuoteSubscriptionRuntime({
    logger: createLoggerDouble(),
    tradingConfig: createTradingConfig(),
    symbolRegistry: context.symbolRegistry,
    marketDataClient: createMarketDataClientDouble(),
    trader,
    lastState: state,
    termination,
  });
  const postTrade = createPostTradeConsistencyRuntime({
    termination,
    getTrader: () => trader,
    lastState: state,
    scheduler: h.deps.scheduler,
    onPositionsCommitted: () => quotes.reconcilePositionHoldFromCurrentTruth(),
  });
  postTrade.bindBusinessDeps({
    monitorContext: context,
    dailyLossTracker: createDailyLossTrackerDouble(),
    liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
    protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
    mixedTradeLogRepository: { appendCompletionIdempotent: () => {} },
  });
  const idle = { start: () => {}, stop: () => {}, stopAndDrain: async () => {}, restart: () => {} };
  const deps: SignalRuntimeDomainDeps = {
    termination,
    logger: createLoggerDouble(),
    monitorContext: context,
    buyProcessor: idle,
    sellProcessor: idle,
    monitorTaskProcessor: idle,
    businessEventProgram: idle,
    tradingRiskEventRuntime: idle,
    monitorQuoteEventRuntime: idle,
    monitorDisplayRuntime: idle,
    tradingQuoteDisplayRuntime: idle,
    switchWakeupRuntime: idle,
    periodicSwitchWakeupRuntime: idle,
    autoSearchWakeupRuntime: idle,
    seatActivationDispatcher: idle,
    seatRuntimeCleanupDispatcher: idle,
    trader,
    postTradeConsistencyRuntime: postTrade,
    quoteSubscriptionRuntime: quotes,
    buyTaskQueue: createBuyTaskQueue(),
    sellTaskQueue: createSellTaskQueue(),
    monitorTaskQueue: createMonitorTaskQueue(),
  };
  const domain = createSignalRuntimeDomain(deps);
  const manager = createDayLifecycleManager({
    termination,
    mutableState: state,
    logger: createLoggerDouble(),
    cacheDomains: [
      domain,
      {
        midnightClear: () => {
          trace.push('later-midnight-domain');
        },
        openRebuild: () => {
          trace.push('later-open-domain');
        },
      },
    ],
  });
  return { h, trace, state, termination, context, quotes, postTrade, manager };
}

/** 相同离线下一日上下文分别回放到重置实例与新实例，对比显示和完整决策。 */
describe('strategy reset through the real lifecycle domain', () => {
  it('keeps identity, drops old indicators/samples/pending, and rejects old callbacks before destroy', async () => {
    const h = createHarness();
    const freshHarness = createHarness();
    const prepared = prepareFixture(configObject(60, 0, ['K'], []));
    const original = prepared.create(h.deps);
    let destroyed = 0;
    const strategy = {
      ...original,
      destroy: () => {
        destroyed++;
        original.destroy();
      },
    };
    const oldEmitted: StrategyDecision[] = [];
    const oldNow = h.deps.clock.now().getTime();
    strategy.onCandlestick(marketContext(), (decision) => {
      oldEmitted.push(decision);
    });

    strategy.onCandlestick(
      { ...marketContext(80, 2, oldNow + 65000), allowNewEvaluation: false },
      () => {},
    );
    const oldCallbacks = h.timers.map((timer) => timer.callback);
    expect(oldCallbacks).toHaveLength(2);
    const oldDecisions = [...oldEmitted];
    const lifecycle = lifecycleHarness(strategy);
    await lifecycle.manager.tick(new Date('2026-02-17T00:00:00+08:00'), {
      dayKey: '2026-02-17',
      canTradeNow: false,
      isTradingDay: true,
    });
    expect(lifecycle.context.strategy).toBe(strategy);
    expect(destroyed).toBe(0);
    for (const callback of oldCallbacks) callback();

    expect(oldEmitted).toEqual(oldDecisions);
    expect(h.errors).toEqual([]);

    // 刻意重用受控观察时间，使旧样本若泄漏不会被自然时间窗裁剪掩盖。
    const fresh = prepared.create(freshHarness.deps);
    const nextEmitted: StrategyDecision[] = [];
    const freshEmitted: StrategyDecision[] = [];
    const nextContext = marketContext(20, 1, oldNow);
    const nextDisplay = strategy.onCandlestick(nextContext, (decision) => {
      nextEmitted.push(decision);
    });
    const freshDisplay = fresh.onCandlestick(nextContext, (decision) => {
      freshEmitted.push(decision);
    });
    expect(nextDisplay).toEqual(freshDisplay);
    expect(nextEmitted).toEqual(freshEmitted);
    expect(nextEmitted.map((decision) => decision.action)).toEqual(['SELLCALL', 'SELLPUT']);
    for (const callback of oldCallbacks) callback();

    expect(oldEmitted).toEqual(oldDecisions);
    for (const timer of h.timers) timer.callback();

    for (const timer of freshHarness.timers) timer.callback();

    // 只有新日初始样本；旧日上涨样本不能帮助新 pending 的 BUYCALL 通过。
    expect(nextEmitted).toEqual(freshEmitted);
    expect(nextEmitted.map((decision) => decision.action)).toEqual(['SELLCALL', 'SELLPUT']);
    expect(destroyed).toBe(0);
    strategy.destroy();
    fresh.destroy();
  });

  it('manager receives a real PostTrade drain rejection and final cleanup still releases later owners', async () => {
    const h = createHarness();
    const original = prepareFixture(configObject()).create(h.deps);
    let destroyed = 0;
    const strategy = {
      ...original,
      destroy: () => {
        destroyed++;
        original.destroy();
      },
    };
    const positions = Promise.withResolvers<ReadonlyArray<Position>>();
    let requested = false;
    const lifecycle = lifecycleHarness(strategy, () => {
      requested = true;
      return positions.promise;
    });
    await lifecycle.quotes.reconcileFromCurrentTruth();
    lifecycle.quotes.start();
    lifecycle.postTrade.start();
    lifecycle.postTrade.recordSettlementRefreshNeed({
      refreshAccount: false,
      refreshPositions: true,
    });

    for (const timer of lifecycle.h.timers) timer.callback();

    await waitUntil(() => requested);
    const flags = { dayKey: '2026-02-17', canTradeNow: false, isTradingDay: true };
    const tick = lifecycle.manager.tick(new Date('2026-02-17T00:00:00+08:00'), flags).then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    );
    expect(lifecycle.state.isTradingEnabled).toBe(false);
    expect(lifecycle.trace).toEqual([]);
    const failure = new TypeError('post-trade position invariant');
    positions.reject(failure);
    const result = await tick;
    expect(result.error).toBe(failure);
    expect(lifecycle.termination.getFatalState()).toEqual({ hasFatalError: true, error: failure });
    expect(lifecycle.trace).toEqual([]);
    expect(destroyed).toBe(0);
    await lifecycle.manager.tick(new Date('2026-02-17T09:30:00+08:00'), {
      ...flags,
      canTradeNow: true,
    });
    expect(lifecycle.trace).toEqual([]);
    const shutdownListeners = new Set<() => void>();
    const requestShutdown = lifecycle.termination.requestShutdown;
    shutdownListeners.add(requestShutdown);
    const cleanup = createCleanup();
    cleanup.register({
      phase: 'STOP_POST_TRADE_CONSISTENCY_RUNTIME',
      step: '再次排空真实 PostTrade',
      handler: () => lifecycle.postTrade.stopAndDrain(),
    });

    cleanup.register({
      phase: 'STOP_QUOTE_SUBSCRIPTION_RUNTIME',
      step: '释放真实 Quote',
      handler: async () => {
        await lifecycle.quotes.stopAndDrain();
        lifecycle.trace.push('quote-drained');
      },
    });

    cleanup.register({
      phase: 'DESTROY_STRATEGY',
      step: '释放策略',
      handler: () => {
        strategy.destroy();
      },
    });

    cleanup.register({
      phase: 'UNSUBSCRIBE_SHUTDOWN_SIGNAL',
      step: '取消退出监听',
      handler: () => {
        shutdownListeners.delete(requestShutdown);
        lifecycle.trace.push('unsubscribed');
      },
    });
    const cleanupResult = await cleanup.execute().then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    );
    expect(cleanupResult.error).toBeDefined();
    expect(lifecycle.trace).toEqual(['quote-drained', 'unsubscribed']);
    expect(destroyed).toBe(1);
    expect(shutdownListeners.size).toBe(0);
    expect(lifecycle.termination.getFatalState()).toEqual({ hasFatalError: true, error: failure });
  });
});
