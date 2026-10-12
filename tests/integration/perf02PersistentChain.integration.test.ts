/** PERF-02 持久化全链路回归：真实 quoteClient → D-event 宿主 → intraday-regression → 生命周期清理/重建。 */
import { describe, expect, it } from 'bun:test';
import { Period, type Candlestick, type PushCandlestickEvent } from 'longbridge';
import { toMockDecimal } from '../../mock/longbridge/decimal.js';
import { createQuoteContextMock } from '../../mock/longbridge/quoteContextMock.js';
import { createBusinessEventProgram } from '../../src/main/businessEventProgram/index.js';
import { createDayLifecycleManager } from '../../src/main/lifecycle/dayLifecycleManager.js';
import { createMarketDataDomain } from '../../src/main/lifecycle/cacheDomains/marketDataDomain.js';
import { createSignalRuntimeDomain } from '../../src/main/lifecycle/cacheDomains/signalRuntimeDomain.js';
import { createMonitorTaskQueue } from '../../src/main/asyncProgram/monitorTaskQueue/index.js';
import { createTerminationRuntime } from '../../src/app/runtime/createTerminationRuntime.js';
import { createMarketDataClient } from '../../src/services/quoteClient/index.js';
import type { TradingSignalStrategy } from '../../src/core/strategy/types.js';
import type { BusinessEventProgram } from '../../src/main/businessEventProgram/types.js';
import type { Processor } from '../../src/main/asyncProgram/types.js';
import type { LifecycleMutableState } from '../../src/main/lifecycle/types.js';
import type {
  CandlestickUpdatedEvent,
  MarketDataClient,
  Trader,
} from '../../src/types/services.js';
import { prepareFixture, configObject } from '../core/strategy/intradayRegression/fixtures.js';
import { createEventHarness, monitorConfig } from '../main/businessEventProgram/fixtures.js';
import type { EventHarness } from '../main/businessEventProgram/types.js';
import {
  createLoggerDouble,
  createMonitorContextDouble,
  createRateLimiterDouble,
  createLiquidationCooldownTrackerDouble,
  createRiskCheckerDouble,
  createSdkConfigDouble,
} from '../helpers/testDoubles.js';

import { createBrokerIngressFixture } from './architectureRefactoringP1Native/trade/brokerIngressFixture.js';
import { createAccountPositionSnapshot } from '../../src/application/accountPositionSnapshot/index.js';
import { createPostTradeConsistencyRuntime } from '../../src/app/runtime/createPostTradeConsistencyRuntime.js';
import { createGlobalStateDomain } from '../../src/main/lifecycle/cacheDomains/globalStateDomain.js';
import { createQuoteSubscriptionRuntime } from '../../src/main/quoteSubscriptionRuntime/index.js';
import { createDailyLossOrderAnalysisDeps } from '../../src/core/orderRecorder/index.js';
import { createDailyLossTracker } from '../../src/core/riskController/dailyLossTracker.js';
import { createProtectiveLiquidationEpisodeTracker } from '../../src/core/trader/protectiveLiquidationEpisodeTracker/index.js';
import { createTradingConfig } from '../../mock/factories/configFactory.js';
import { toHongKongTimeIso } from '../../src/utils/time/index.js';
import type { QuoteSubscriptionRuntime } from '../../src/main/quoteSubscriptionRuntime/types.js';
import type { LastState } from '../../src/types/state.js';

const SYMBOL = 'HSI.HK';
const PERIOD = Period.Min_1;
const MINUTE_MS = 60_000;
const INITIAL_NOW_MS = Date.parse('2026-07-15T02:00:00.000Z');
const RESEEDED_NOW_MS = Date.parse('2026-07-16T02:00:00.000Z');
const SEED_LENGTH = 21;

type StrategyTimer = {
  readonly callback: () => void;
  readonly handle: ReturnType<typeof setTimeout>;
  cleared: boolean;
};

type ChainHarness = {
  readonly quoteMock: ReturnType<typeof createQuoteContextMock>;
  readonly marketDataClient: MarketDataClient;
  readonly marketDataEvents: ReadonlyArray<CandlestickUpdatedEvent>;
  readonly removeMarketDataObserver: () => void;
  readonly eventHarness: EventHarness;
  readonly program: BusinessEventProgram;
  readonly timers: StrategyTimer[];
  readonly fatalErrors: unknown[];
  readonly setNow: (nowMs: number) => void;
  readonly getHostListener: () => ((event: CandlestickUpdatedEvent) => void) | null;
};

/** 构造包含稳定 OHLC 区间的 seed K 线，避免测试依赖 SDK Decimal 对象继续流入策略。 */
function createSeedCandles(
  lastTimestampMs: number,
  close: number,
  high: number,
  low: number,
): ReadonlyArray<Candlestick> {
  return Array.from({ length: SEED_LENGTH }, (_, index) => {
    const timestampMs = lastTimestampMs - (SEED_LENGTH - 1 - index) * MINUTE_MS;
    return createCandle(timestampMs, close, high, low);
  });
}

/** 构造 SDK mock 可消费的单根 K 线；真实 quoteClient 负责标准化与冻结。 */
function createCandle(timestampMs: number, close: number, high: number, low: number): Candlestick {
  return {
    open: toMockDecimal(close),
    high: toMockDecimal(high),
    low: toMockDecimal(low),
    close: toMockDecimal(close),
    volume: 1_000,
    turnover: toMockDecimal(close * 1_000),
    timestamp: new Date(timestampMs),
    tradeSession: 0,
  } as unknown as Candlestick;
}

/** 构造真实 QuoteContext push，覆盖同柱替换、确认和下一柱追加。 */
function createPush(
  timestampMs: number,
  close: number,
  high: number,
  low: number,
  isConfirmed: boolean,
): PushCandlestickEvent {
  return {
    symbol: SYMBOL,
    data: {
      period: PERIOD,
      candlestick: createCandle(timestampMs, close, high, low),
      isConfirmed,
    },
  } as unknown as PushCandlestickEvent;
}

/** 让业务事件宿主完成 single-flight 微任务，不等待真实 timer。 */
async function flushHost(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

/** 消费宿主队列中的 Signal，不连接任何交易执行器。 */
function drainSignalActions(harness: EventHarness): ReadonlyArray<string> {
  const actions: string[] = [];
  for (;;) {
    const task = harness.buyTaskQueue.pop();
    if (task === null) break;

    actions.push(task.data.action);
  }

  for (;;) {
    const task = harness.sellTaskQueue.pop();
    if (task === null) break;

    actions.push(task.data.action);
  }

  return actions;
}

/** 创建真实策略与真实 D-event 宿主；行情接入在本 helper 内始终使用生产 createMarketDataClient。 */
async function createChainHarness(strategyConfig: unknown): Promise<ChainHarness> {
  let nowMs = INITIAL_NOW_MS;
  const timers: StrategyTimer[] = [];
  const fatalErrors: unknown[] = [];
  const termination = createTerminationRuntime({
    closeTradingGate: () => {},
    closeProducerAdmission: () => {},
    stopProducers: [],
    onSecondaryError: () => {},
  });
  const strategy: TradingSignalStrategy = prepareFixture(strategyConfig).create({
    clock: { now: () => new Date(nowMs) },
    scheduler: {
      scheduleTimer: (callback) => {
        const handle = setTimeout(() => {}, 0);
        clearTimeout(handle);
        timers.push({ callback, handle, cleared: false });
        return handle;
      },
      clearTimer: (handle) => {
        const timer = timers.find((entry) => entry.handle === handle);
        if (timer) timer.cleared = true;
      },
    },
    logger: createLoggerDouble(),
    onFatalError: (error) => {
      fatalErrors.push(error);
      termination.reportFatalError(error);
    },
  });
  const eventHarness = createEventHarness({
    strategy,
    createTerminationRuntime: () => termination,
  });
  const quoteMock = createQuoteContextMock();
  quoteMock.seedCandlesticks(SYMBOL, PERIOD, createSeedCandles(INITIAL_NOW_MS, 50, 100, 1));
  const marketDataClient = await createMarketDataClient({
    config: createSdkConfigDouble(),
    quoteContextFactory: async () => quoteMock,
  });
  const marketDataEvents: CandlestickUpdatedEvent[] = [];
  const removeMarketDataObserver = marketDataClient.onCandlestickUpdated((event) => {
    marketDataEvents.push(event);
  });
  // observer 先于 quoteClient 的 subscribe seed 注册，seed 本身不应回放为更新事件。
  await marketDataClient.subscribeCandlesticks(SYMBOL, PERIOD);

  let hostListener: ((event: CandlestickUpdatedEvent) => void) | null = null;
  const hostMarketDataClient: Pick<
    MarketDataClient,
    'getCandlestickSnapshot' | 'onCandlestickUpdated'
  > = {
    getCandlestickSnapshot: (symbol, period) =>
      marketDataClient.getCandlestickSnapshot(symbol, period),
    onCandlestickUpdated: (listener) => {
      hostListener = listener;
      return marketDataClient.onCandlestickUpdated(listener);
    },
  };
  const program = createBusinessEventProgram({
    ...eventHarness.deps,
    marketDataClient: hostMarketDataClient,
    monitorContext: {
      ...eventHarness.deps.monitorContext,
      strategy: eventHarness.strategy,
    },
  });

  return {
    quoteMock,
    marketDataClient,
    marketDataEvents,
    removeMarketDataObserver,
    eventHarness,
    program,
    timers,
    fatalErrors,
    setNow: (value) => {
      nowMs = value;
      eventHarness.mutable.nowMs = value;
    },
    getHostListener: () => hostListener,
  };
}

/**
 * 通过真实 quote push、宿主 latest snapshot 和策略 timer 驱动延迟验证。
 * t+55s 写入反向样本，t+80s 写入正向样本；可选的 t+150s 同版本通知负责触发保留窗口裁剪。
 */
async function runDelayedSampleScenario(
  chain: ChainHarness,
  params: {
    readonly baseNowMs: number;
    readonly initialClose: number;
    readonly badClose: number;
    readonly goodClose: number;
    readonly high: number;
    readonly low: number;
    readonly includeSameVersionNotification: boolean;
  },
): Promise<ReadonlyArray<string>> {
  chain.program.start();
  chain.setNow(params.baseNowMs);
  chain.quoteMock.emitCandlestick(
    createPush(params.baseNowMs, params.initialClose, params.high, params.low, false),
  );
  chain.quoteMock.flushAllEvents();
  await flushHost();
  const pendingTimers = [...chain.timers];
  if (pendingTimers.length === 0) throw new Error('expected delayed verification timers');

  chain.eventHarness.lastState.openProtectionActive = true;
  chain.setNow(params.baseNowMs + 55_000);
  chain.quoteMock.emitCandlestick(
    createPush(params.baseNowMs, params.badClose, params.high, params.low, false),
  );
  chain.quoteMock.flushAllEvents();
  await flushHost();

  chain.setNow(params.baseNowMs + 80_000);
  chain.quoteMock.emitCandlestick(
    createPush(params.baseNowMs, params.goodClose, params.high, params.low, false),
  );
  chain.quoteMock.flushAllEvents();
  await flushHost();
  const sameVersionSource = chain.marketDataClient.getCandlestickSnapshot(SYMBOL, PERIOD);
  if (sameVersionSource === null) throw new Error('expected same-version source snapshot');

  chain.setNow(params.baseNowMs + 150_000);
  if (params.includeSameVersionNotification) {
    const hostListener = chain.getHostListener();
    if (hostListener === null) throw new Error('expected host listener');

    hostListener({
      symbol: SYMBOL,
      period: PERIOD,
      snapshot: sameVersionSource,
    });
    await flushHost();
  }

  // 延迟 timer 在 t+150s 才执行：通知会裁剪 t+55s 旧反向样本，否则该样本仍是最近点。
  for (const timer of pendingTimers) timer.callback();

  return drainSignalActions(chain.eventHarness);
}

/**
 * 接入真实 lifecycle manager 的 signalRuntime 与 marketData domain。
 * 订单、账户与完整 open-rebuild snapshot 不在本回归重复装配；该边界专门验证真实 reset owner 与 K 线重接入。
 */
async function createLifecycleHarness(chain: ChainHarness): Promise<{
  readonly manager: ReturnType<typeof createDayLifecycleManager>;
  readonly state: LifecycleMutableState;
  readonly snapshot: ReturnType<typeof createAccountPositionSnapshot>;
  readonly settlement: ReturnType<typeof createPostTradeConsistencyRuntime>;
  readonly stopAndDrain: () => Promise<void>;
}> {
  const idleRuntime = {
    start: () => {},
    stop: () => {},
    stopAndDrain: async () => {},
    restart: () => {},
    requestRender: () => {},
    handoffPendingSwitch: () => {},
    markWaitingEmpty: () => {},
    clearWaitingEmpty: () => {},
    replanRouteAfterTask: () => {},
    reconcileFromCurrentTruth: async () => {},
    reconcilePositionHoldFromCurrentTruth: async () => {},
    retainSymbols: async () => {},
    releaseRetain: async () => {},
    waitForAdmission: async () => {},
    dispatchCurrentActivatingSeats: () => {},
    startOrderMonitorRuntime: () => {},
    stopOrderMonitorRuntimeAndDrain: async () => {},
    abortWaiting: () => {},
    resetAbort: () => {},
    midnightClear: () => {},
    completeRebuildBaseline: () => {},
  };
  const idleProcessor: Processor = idleRuntime;
  const native = await createBrokerIngressFixture({
    orderId: 'PERF-LIFECYCLE',
    tradeId: 'PERF-LIFECYCLE-trade',
    symbol: 'BULL.HK',
    stockName: 'HSI RC',
    remark: '',
    side: 'BUY',
    status: 'New',
    orderType: 'ELO',
    quantity: '100',
    executedQuantity: '0',
    submittedPrice: '1',
    executedPrice: '0',
    submittedAtMs: INITIAL_NOW_MS,
    executionTimeMs: null,
    updatedAtMs: INITIAL_NOW_MS,
  });
  native.setAccountBalance({
    currency: 'HKD',
    totalCash: '100000',
    netAssets: '100000',
    availableCash: '100000',
  });
  native.setStockPositions([]);
  native.setOrderSnapshotReplies([], []);
  native.setExecutionReplies([]);
  const daily = createDailyLossTracker({
    ...createDailyLossOrderAnalysisDeps(),
    toHongKongTimeIso,
  });
  daily.resetAll(new Date(INITIAL_NOW_MS));
  const episode = createProtectiveLiquidationEpisodeTracker();
  const termination = chain.eventHarness.termination;
  const appState: LastState = Object.assign(chain.eventHarness.lastState, {
    lifecycleState: 'ACTIVE' as const,
    pendingOpenRebuild: false,
    cachedTradingDayInfo: null,
    tradingCalendarSnapshot: new Map(),
    allTradingSymbols: new Set<string>(),
  });
  let boundQuotes: QuoteSubscriptionRuntime | null = null;
  const account = native.createAccountService({ rateLimiter: createRateLimiterDouble() });
  const snapshot = createAccountPositionSnapshot({
    dayEpoch: 1,
    scheduler: { schedule: queueMicrotask },
    readPort: account,
    reportFatalError: termination.reportFatalError,
  });
  let traderOwner: Trader | null = null;
  const settlement = createPostTradeConsistencyRuntime({
    snapshot,
    termination,
    getTrader: () => {
      if (traderOwner === null) throw new Error('PERF trader assembly not completed');

      return traderOwner;
    },
    onPositionsCommitted: async (token) => {
      if (boundQuotes === null) throw new Error('PERF quote owner not assembled');

      await boundQuotes.reconcilePositionHoldFromCurrentTruth(token);
    },
    scheduler: { scheduleTimer: setTimeout, clearTimer: clearTimeout },
  });
  const tradingConfig = createTradingConfig({ monitor: monitorConfig() });
  const trader = await native.createTrader({
    tradingConfig,
    marketDataClient: chain.marketDataClient,
    symbolRegistry: chain.eventHarness.symbolRegistry,
    dailyLossTracker: daily,
    protectiveLiquidationEpisodeTracker: episode,
    persistProtectiveLiquidationExecutionProgress: () => {},
    postTradeConsistencyRuntime: settlement,
    isExecutionAllowed: () => chain.eventHarness.lastState.isTradingEnabled,
    isContinuousTradingAllowed: () => chain.eventHarness.lastState.canTrade === true,
    now: () => new Date(INITIAL_NOW_MS),
    scheduleTimer: setTimeout,
    clearTimer: clearTimeout,
    readCurrentTradingDayInfo: () => ({
      dateKey: appState.currentDayKey ?? '2026-07-15',
      info: { isTradingDay: true, isHalfDay: false },
    }),
    unrealizedLossBuyGate: createRiskCheckerDouble(),
    termination,
  });
  traderOwner = trader;
  const monitorContext = createMonitorContextDouble({
    config: monitorConfig(),
    strategy: chain.eventHarness.strategy,
    symbolRegistry: chain.eventHarness.symbolRegistry,
    orderRecorder: trader.orderRecorder,
    dailyLossTracker: daily,
  });
  const quoteRuntime = createQuoteSubscriptionRuntime({
    logger: createLoggerDouble(),
    tradingConfig,
    symbolRegistry: chain.eventHarness.symbolRegistry,
    marketDataClient: chain.marketDataClient,
    trader,
    lastState: appState,
    snapshot,
    termination,
  });
  boundQuotes = quoteRuntime;
  chain.quoteMock.seedStaticInfo(
    [SYMBOL, 'BULL.HK', 'BEAR.HK'].map((symbol) => ({
      symbol,
      info: { symbol, nameCn: symbol, lotSize: 100 },
    })),
  );

  chain.quoteMock.seedQuotes(
    [SYMBOL, 'BULL.HK', 'BEAR.HK'].map((symbol) => ({
      symbol,
      quote: { symbol, prevClose: '1' },
    })),
  );

  settlement.bindBusinessDeps({
    monitorContext,
    dailyLossTracker: daily,
    liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
    protectiveLiquidationEpisodeTracker: episode,
    mixedTradeLogRepository: { appendCompletionIdempotent: () => {} },
  });
  const initial = await snapshot.requestRefresh({
    source: 'PERF_LIFECYCLE_INITIAL',
    dayEpoch: 1,
    refreshAccount: true,
    refreshPositions: true,
  }).result;
  if (initial.status !== 'COMMITTED') throw new Error('PERF initial H refresh aborted');

  const globalState = createGlobalStateDomain({
    lastState: appState,
    snapshot,
    logger: createLoggerDouble(),
    runTradingDayOpenRebuild: async (now) => {
      const dayEpoch = snapshot.getStatus().token.dayEpoch;
      const refreshed = await snapshot.requestRefresh({
        source: 'LIFECYCLE_REBUILD',
        dayEpoch,
        refreshAccount: true,
        refreshPositions: true,
      }).result;
      if (refreshed.status !== 'COMMITTED') return { status: 'ABORTED' };

      const observations = await trader.fetchAllOrdersFromAPI();
      const prepared = daily.prepareRecalculationFromAllOrders(
        observations,
        monitorContext.config,
        now,
      );
      const commit = trader.orderRecorder.commitRebuildSnapshot(
        [
          { symbol: 'BULL.HK', isLongSymbol: true },
          { symbol: 'BEAR.HK', isLongSymbol: false },
        ],
        observations,
        () =>
          snapshot.isCurrent(refreshed.snapshotToken, {
            account: true,
            positions: true,
            paired: true,
          }) && prepared.isCurrent(),
        'REBUILD',
      );
      if (commit.status !== 'COMMITTED') return { status: 'ABORTED' };

      daily.publishRecalculation(prepared);
      appState.canTrade = true;
      appState.isHalfDay = false;
      appState.openProtectionActive = false;
      return { status: 'COMMITTED', snapshotToken: refreshed.snapshotToken };
    },
  });
  const signalRuntime = createSignalRuntimeDomain({
    termination: chain.eventHarness.termination,
    logger: createLoggerDouble(),
    monitorContext,
    buyProcessor: idleProcessor,
    sellProcessor: idleProcessor,
    monitorTaskProcessor: idleProcessor,
    businessEventProgram: chain.program,
    tradingRiskEventRuntime: idleRuntime,
    monitorQuoteEventRuntime: idleRuntime,
    monitorDisplayRuntime: idleRuntime,
    tradingQuoteDisplayRuntime: idleRuntime,
    switchWakeupRuntime: idleRuntime,
    periodicSwitchWakeupRuntime: idleRuntime,
    quoteSubscriptionRuntime: quoteRuntime,
    autoSearchWakeupRuntime: idleRuntime,
    seatActivationDispatcher: idleRuntime,
    seatRuntimeCleanupDispatcher: idleRuntime,
    trader,
    postTradeConsistencyRuntime: settlement,
    buyTaskQueue: chain.eventHarness.buyTaskQueue,
    sellTaskQueue: chain.eventHarness.sellTaskQueue,
    monitorTaskQueue: createMonitorTaskQueue(),
  });
  const marketDataDomain = createMarketDataDomain({
    logger: createLoggerDouble(),
    marketDataClient: chain.marketDataClient,
  });
  const state: LifecycleMutableState = appState;
  const manager = createDayLifecycleManager({
    termination: chain.eventHarness.termination,
    mutableState: state,
    cacheDomains: [signalRuntime, marketDataDomain, globalState],
    snapshot,
    logger: createLoggerDouble(),
    rebuildRetryDelayMs: 1,
  });
  return {
    manager,
    state,
    snapshot,
    settlement,
    stopAndDrain: async () => {
      await trader.stopOrderMonitorRuntimeAndDrain();
      await settlement.stopAndDrain();
      await quoteRuntime.stopAndDrain();
    },
  };
}

describe('PERF-02 真实持久化全链路', () => {
  it('seed 无事件，push/确认共享冻结 candle，宿主 latest-only 读取权威最新快照', async () => {
    const chain = await createChainHarness(configObject());
    const events = chain.marketDataEvents;

    try {
      expect(events).toHaveLength(0);
      const seeded = chain.marketDataClient.getCandlestickSnapshot(SYMBOL, PERIOD);
      expect(seeded).not.toBeNull();
      if (seeded === null) throw new Error('expected seed snapshot');

      expect(seeded.version).toBe(1);
      expect(seeded.candles).toHaveLength(SEED_LENGTH);
      expect(Object.isFrozen(seeded.candles)).toBeFalse();
      expect(Object.isFrozen(seeded.candles.at(-1))).toBeTrue();

      chain.program.start();
      await flushHost();
      expect(chain.eventHarness.contexts).toHaveLength(0);

      chain.quoteMock.emitCandlestick(createPush(INITIAL_NOW_MS, 50, 100, 1, false));
      chain.quoteMock.flushAllEvents();
      await flushHost();

      const afterPush = chain.marketDataClient.getCandlestickSnapshot(SYMBOL, PERIOD);
      expect(afterPush).not.toBeNull();
      if (afterPush === null) throw new Error('expected snapshot after push');

      expect(events).toHaveLength(1);
      expect(events[0]?.snapshot).toBe(afterPush);
      expect(afterPush.version).toBe(2);
      expect(afterPush.lastBarConfirmed).toBeFalse();
      const firstContext = chain.eventHarness.contexts[0];
      expect(firstContext?.candlesticks.version).toBe(afterPush.version);
      expect(firstContext?.candlesticks.candles).not.toBe(afterPush.candles);
      expect(Object.isFrozen(firstContext?.candlesticks.candles)).toBeTrue();
      expect(firstContext?.candlesticks.candles.at(-1)).toBe(afterPush.candles.at(-1));
      expect(Object.isFrozen(firstContext?.candlesticks.candles.at(-1))).toBeTrue();
      expect(chain.eventHarness.displays[0]?.some((item) => item.label === 'K')).toBeTrue();

      const beforeConfirmation = afterPush;
      const beforeConfirmationCandles = beforeConfirmation.candles;
      const beforeConfirmationCandle = beforeConfirmation.candles.at(-1);
      chain.quoteMock.emitCandlestick(createPush(INITIAL_NOW_MS, 50, 100, 1, true));
      chain.quoteMock.flushAllEvents();
      await flushHost();

      const confirmed = chain.marketDataClient.getCandlestickSnapshot(SYMBOL, PERIOD);
      expect(confirmed).not.toBeNull();
      if (confirmed === null) throw new Error('expected confirmed snapshot');

      expect(events).toHaveLength(2);
      expect(events[1]?.snapshot).toBe(confirmed);
      expect(confirmed.version).toBe(beforeConfirmation.version + 1);
      expect(confirmed.lastBarConfirmed).toBeTrue();
      expect(confirmed.candles).toBe(beforeConfirmationCandles);
      expect(confirmed.candles.at(-1)).toBe(beforeConfirmationCandle);
      expect(chain.eventHarness.contexts).toHaveLength(2);
      expect(chain.eventHarness.contexts[1]?.candlesticks.version).toBe(confirmed.version);
      expect(chain.eventHarness.contexts[1]?.candlesticks.candles.at(-1)).toBe(
        beforeConfirmationCandle,
      );

      chain.quoteMock.emitCandlestick(createPush(INITIAL_NOW_MS, 50, 100, 1, true));
      chain.quoteMock.emitCandlestick(createPush(INITIAL_NOW_MS, 50, 100, 1, false));
      chain.quoteMock.flushAllEvents();
      await flushHost();
      expect(events).toHaveLength(2);
      expect(chain.eventHarness.contexts).toHaveLength(2);

      chain.setNow(INITIAL_NOW_MS + 120_000);
      chain.quoteMock.emitCandlestick(createPush(INITIAL_NOW_MS + MINUTE_MS, 51, 100, 1, false));
      chain.quoteMock.emitCandlestick(
        createPush(INITIAL_NOW_MS + 2 * MINUTE_MS, 52, 100, 1, false),
      );
      chain.quoteMock.flushAllEvents();
      await flushHost();

      const authoritativeLatest = chain.marketDataClient.getCandlestickSnapshot(SYMBOL, PERIOD);
      expect(authoritativeLatest).not.toBeNull();
      if (authoritativeLatest === null) throw new Error('expected latest authoritative snapshot');

      expect(authoritativeLatest.version).toBe(5);
      expect(authoritativeLatest.candles.at(-1)?.close).toBe(52);
      expect(chain.eventHarness.contexts).toHaveLength(3);
      expect(chain.eventHarness.contexts[2]?.candlesticks.version).toBe(
        authoritativeLatest.version,
      );

      expect(chain.eventHarness.contexts[2]?.candlesticks.lastBarTimestamp).toBe(
        INITIAL_NOW_MS + 2 * MINUTE_MS,
      );
      expect(chain.eventHarness.contexts[2]?.candlesticks.candles.at(-1)?.close).toBe(52);
      expect(events).toHaveLength(4);
      expect(events.at(-1)?.snapshot).toBe(authoritativeLatest);
      expect(chain.fatalErrors).toEqual([]);
    } finally {
      chain.removeMarketDataObserver();
      await chain.program.stopAndDrain();
      chain.eventHarness.strategy.destroy();
      await chain.marketDataClient.resetRuntimeSubscriptionsAndCaches();
      expect(chain.marketDataClient.getCandlestickSnapshot(SYMBOL, PERIOD)).toBeNull();
    }
  });

  it('同版本采样的真实正负验证及 lifecycle reset 后旧 timer 不再产出', async () => {
    const chain = await createChainHarness(configObject(60, 60, ['K'], ['K']));
    const lifecycle = await createLifecycleHarness(chain);
    let negativeChain: ChainHarness | null = null;

    try {
      const positiveActions = await runDelayedSampleScenario(chain, {
        baseNowMs: INITIAL_NOW_MS,
        initialClose: 50,
        badClose: 20,
        goodClose: 80,
        high: 100,
        low: 1,
        includeSameVersionNotification: true,
      });

      negativeChain = await createChainHarness(configObject(60, 60, ['K'], ['K']));
      const negativeActions = await runDelayedSampleScenario(negativeChain, {
        baseNowMs: INITIAL_NOW_MS,
        initialClose: 50,
        badClose: 20,
        goodClose: 80,
        high: 100,
        low: 1,
        includeSameVersionNotification: false,
      });

      // 只增加 t+150s 的同版本通知即可裁掉 t+55s 反向样本；动作差异来自真实验证结果，而非宿主调用次数。
      expect(positiveActions).toEqual(['BUYCALL', 'SELLPUT']);
      expect(negativeActions).toEqual([]);
      expect(positiveActions).not.toEqual(negativeActions);
      expect(chain.fatalErrors).toEqual([]);
      expect(negativeChain.fatalErrors).toEqual([]);

      chain.eventHarness.lastState.openProtectionActive = false;
      const oldPendingTimerStart = chain.timers.length;
      chain.setNow(INITIAL_NOW_MS + 3 * MINUTE_MS);
      chain.quoteMock.emitCandlestick(
        createPush(INITIAL_NOW_MS + 3 * MINUTE_MS, 80, 100, 1, false),
      );
      chain.quoteMock.flushAllEvents();
      await flushHost();
      const oldPendingTimers = chain.timers.slice(oldPendingTimerStart);
      expect(oldPendingTimers.length).toBeGreaterThan(0);

      await lifecycle.manager.tick(new Date(RESEEDED_NOW_MS), {
        dayKey: '2026-07-16',
        canTradeNow: false,
        isTradingDay: true,
      });
      expect(lifecycle.state.lifecycleState).toBe('MIDNIGHT_CLEANED');
      expect(lifecycle.state.pendingOpenRebuild).toBeTrue();
      expect(chain.marketDataClient.getCandlestickSnapshot(SYMBOL, PERIOD)).toBeNull();
      expect(oldPendingTimers.every((timer) => timer.cleared)).toBeTrue();
      // 跨日清理后的旧回调不再产出旧动作；清理取消与回调调用分别验证。
      for (const timer of oldPendingTimers) timer.callback();

      expect(drainSignalActions(chain.eventHarness)).toEqual([]);

      const eventCountBeforeReseed = chain.marketDataEvents.length;
      chain.quoteMock.seedCandlesticks(
        SYMBOL,
        PERIOD,
        createSeedCandles(RESEEDED_NOW_MS, 200, 300, 100),
      );
      await chain.marketDataClient.subscribeCandlesticks(SYMBOL, PERIOD);
      expect(chain.marketDataEvents).toHaveLength(eventCountBeforeReseed);
      const reseeded = chain.marketDataClient.getCandlestickSnapshot(SYMBOL, PERIOD);
      expect(reseeded).not.toBeNull();
      if (reseeded === null) throw new Error('expected reseeded snapshot');

      expect(reseeded.version).toBe(1);
      expect(reseeded.candles.at(-1)?.close).toBe(200);

      chain.eventHarness.lastState.currentDayKey = '2026-07-16';
      chain.eventHarness.lastState.openProtectionActive = false;
      chain.eventHarness.lastState.isTradingEnabled = true;
      await lifecycle.manager.tick(new Date(RESEEDED_NOW_MS + 60 * MINUTE_MS), {
        dayKey: '2026-07-16',
        canTradeNow: true,
        isTradingDay: true,
      });
      expect(lifecycle.state.lifecycleState).toBe('ACTIVE');
      expect(lifecycle.state.pendingOpenRebuild).toBeFalse();
      const reopenedReceipt = await lifecycle.settlement.waitForFresh();
      expect(lifecycle.settlement.isCurrent(reopenedReceipt)).toBeTrue();
      expect(lifecycle.snapshot.getView().token.dayEpoch).toBe(2);

      const reseedActions = await runDelayedSampleScenario(chain, {
        baseNowMs: RESEEDED_NOW_MS,
        initialClose: 200,
        badClose: 120,
        goodClose: 280,
        high: 300,
        low: 100,
        includeSameVersionNotification: true,
      });
      expect(reseedActions).toEqual(['BUYCALL', 'SELLPUT']);
      expect(chain.fatalErrors).toEqual([]);
      expect(chain.eventHarness.termination.getFatalState()).toEqual({ hasFatalError: false });
    } finally {
      if (negativeChain !== null) {
        negativeChain.removeMarketDataObserver();
        await negativeChain.program.stopAndDrain();
        negativeChain.eventHarness.strategy.destroy();
        await negativeChain.marketDataClient.resetRuntimeSubscriptionsAndCaches();
        expect(negativeChain.marketDataClient.getCandlestickSnapshot(SYMBOL, PERIOD)).toBeNull();
      }

      chain.removeMarketDataObserver();
      await chain.program.stopAndDrain();
      await lifecycle.stopAndDrain();
      chain.eventHarness.strategy.destroy();
      await chain.marketDataClient.resetRuntimeSubscriptionsAndCaches();
      expect(chain.marketDataClient.getCandlestickSnapshot(SYMBOL, PERIOD)).toBeNull();
    }
  });
});
