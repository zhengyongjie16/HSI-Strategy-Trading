import { createDiagnosticObserverDouble } from '../helpers/diagnostics.js';
import type { RuntimeStateFixtures } from '../helpers/types.js';

/**
 * Quote 订阅失败归属集成回归。
 * 连接真实 canonical H、PostTrade、Quote owner、SymbolRegistry 与 Termination，
 * 验证双向 broker await 交错不转移工作责任，失败不偷重试，ACK 与迟到持仓事实如实收口。
 */
import { describe, expect, it } from 'bun:test';
import { API } from '../../src/constants/index.js';
import { createAccountPositionSnapshot } from '../../src/application/accountPositionSnapshot/index.js';
import { createPostTradeConsistencyRuntime } from '../../src/app/runtime/createPostTradeConsistencyRuntime.js';
import { createTerminationRuntime } from '../../src/runtime/lifecycle/terminationRuntime.js';
import { createQuoteSubscriptionRuntime } from '../../src/runtime/quoteSubscriptionRuntime/index.js';
import { createSymbolRegistry } from '../../src/domain/seat/symbolRegistry.js';
import { createTradingConfig } from '../../mock/factories/configFactory.js';
import type { Position } from '../../src/types/account.js';
import type { OrderHoldSymbolsChangedEvent } from '../../src/types/orderHold.js';
import { createExternalApiRequestError } from '../helpers/createExternalApiRequestError.js';
import {
  createAccountSnapshotDouble,
  createDailyLossTrackerDouble,
  createLiquidationCooldownTrackerDouble,
  createLoggerDouble,
  createMonitorConfigDouble,
  createMonitorContextDouble,
  createPositionDouble,
  createProtectiveLiquidationEpisodeTrackerDouble,
  createRiskCheckerDouble,
  createTradeRuntimeDouble,
} from '../helpers/testDoubles.js';

/** 排空已排入的微任务，不推进失败重试 timer。 */
async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 60; index += 1) await Promise.resolve();
}

/** 手动 timer 只供真实 PostTrade 调度使用，断言失败重试的延迟与次数。 */
function createManualScheduler() {
  const timers = new Map<
    ReturnType<typeof setTimeout>,
    Readonly<{ callback: () => void; delayMs: number }>
  >();
  return {
    runtime: {
      scheduleTimer: (callback: () => void, delayMs: number) => {
        const handle = setTimeout(() => {}, 2_147_483_647);
        clearTimeout(handle);
        timers.set(handle, { callback, delayMs });
        return handle;
      },
      clearTimer: (handle: ReturnType<typeof setTimeout>) => {
        timers.delete(handle);
      },
    },
    pendingDelays: () => [...timers.values()].map((timer) => timer.delayMs),
    runNext: async (expectedDelayMs: number) => {
      const entry = timers.entries().next().value;
      if (entry === undefined) throw new Error('没有可推进的 PostTrade timer');

      const [handle, timer] = entry;
      expect(timer.delayMs).toBe(expectedDelayMs);
      timers.delete(handle);
      timer.callback();
      await flushMicrotasks();
    },
  };
}

/** 只有 IO 与风险发布观察口为替身；事实提交、事件派发、订阅和失败分类使用真实组件。 */
async function createOwnershipHarness(params: {
  readonly positions?: ReadonlyArray<Position>;
  readonly orderHolds?: ReadonlyArray<string>;
  readonly onSubscribe: (symbols: ReadonlyArray<string>) => Promise<void>;
  readonly onUnsubscribe?: (symbols: ReadonlyArray<string>) => Promise<void>;
}) {
  const monitor = createMonitorConfigDouble({ monitorSymbol: 'HSI.HK' });
  const symbolRegistry = createSymbolRegistry(monitor);
  const scheduler = createManualScheduler();
  const stateFixtures: RuntimeStateFixtures = {
    tradingTimeState: { canTrade: true, isHalfDay: false, openProtectionActive: false },
    lifecycleState: {
      currentDayKey: '2026-04-10',
      lifecycleState: 'ACTIVE',
      pendingOpenRebuild: false,
      isTradingEnabled: true,
    },
    tradingCalendarState: { cachedTradingDayInfo: null, tradingCalendarSnapshot: new Map() },
    quoteSubscriptionState: { allTradingSymbols: new Set() },
  };
  let positions = params.positions ?? [];
  let positionReads = 0;
  const holdSymbols = new Set(params.orderHolds);
  const holdListeners = new Set<(event: OrderHoldSymbolsChangedEvent) => void>();
  const actualSubscriptions = new Set<string>();
  const subscribed: string[][] = [];
  const unsubscribed: string[][] = [];
  const positionErrors: unknown[] = [];
  const positionAcks: number[] = [];
  const publishedRisk: string[] = [];
  const secondaryErrors: unknown[] = [];
  const snapshotDrains: Promise<void>[] = [];
  const snapshot = createAccountPositionSnapshot({
    clock: { now: () => new Date() },
    diagnostics: createDiagnosticObserverDouble(),
    dayEpoch: 1,
    scheduler: { schedule: queueMicrotask },
    reportFatalError: reportSnapshotFatalError,
    readPort: {
      getAccountSnapshot: async () => createAccountSnapshotDouble('100000'),
      getStockPositions: async () => {
        positionReads += 1;
        return positions;
      },
    },
  });
  const termination = createTerminationRuntime({
    closeTradingGate: () => {
      stateFixtures.lifecycleState.isTradingEnabled = false;
    },
    closeProducerAdmission: () => {
      const drain = snapshot.requestClear({
        reason: 'STOP',
        dayEpoch: snapshot.getView().token.dayEpoch,
      });
      snapshotDrains.push(drain);
      void drain.catch((error: unknown) => {
        secondaryErrors.push(error);
      });
    },
    stopProducers: [],
    onSecondaryError: (error) => {
      secondaryErrors.push(error);
    },
  });

  /** H 与终止准入互相连接；所有内部错误仍由唯一 Termination 锁存。 */
  function reportSnapshotFatalError(error: unknown): void {
    termination.reportFatalError(error);
  }

  const tradeRuntime = createTradeRuntimeDouble({
    orderHoldRegistry: {
      getHoldSymbols: () => new Set(holdSymbols),
      onOrderHoldSymbolsChanged: (listener) => {
        holdListeners.add(listener);
        return () => {
          holdListeners.delete(listener);
        };
      },
    },
  });
  const quote = createQuoteSubscriptionRuntime({
    snapshot,
    termination,
    logger: createLoggerDouble(),
    tradingConfig: createTradingConfig({ monitor }),
    symbolRegistry,
    orderHoldRegistry: tradeRuntime.orderHoldRegistry,
    ...stateFixtures,
    marketDataClient: {
      subscribeSymbols: async (symbols) => {
        subscribed.push([...symbols]);
        await params.onSubscribe(symbols);
        for (const symbol of symbols) actualSubscriptions.add(symbol);
      },
      unsubscribeSymbols: async (symbols) => {
        unsubscribed.push([...symbols]);
        await params.onUnsubscribe?.(symbols);
        for (const symbol of symbols) actualSubscriptions.delete(symbol);
      },
    },
  });
  const dailyLossTracker = createDailyLossTrackerDouble();
  const context = createMonitorContextDouble({
    orderRecorder: tradeRuntime.orderRecorder,
    config: monitor,
    symbolRegistry,
    dailyLossTracker,
    riskChecker: createRiskCheckerDouble({
      publishUnrealizedLossData: (prepared) => {
        publishedRisk.push(prepared.symbol);
      },
    }),
  });
  const postTrade = createPostTradeConsistencyRuntime({
    diagnostics: createDiagnosticObserverDouble(),
    clock: { now: () => new Date() },
    logger: createLoggerDouble(),
    termination,
    snapshot,
    scheduler: scheduler.runtime,
    getProtectiveOrderReader: () => tradeRuntime.orderMonitor,
    onPositionsCommitted: async (token) => {
      try {
        await quote.reconcilePositionHoldFromCurrentTruth(token);
        positionAcks.push(token.commitRevision);
      } catch (error: unknown) {
        positionErrors.push(error);
        throw error;
      }
    },
  });
  postTrade.bindBusinessDeps({
    monitorContext: context,
    dailyLossTracker,
    liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
    protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
    mixedTradeLogRepository: { appendCompletionIdempotent: () => {} },
  });
  const baseline = await snapshot.requestRefresh({
    source: 'QUOTE_OWNERSHIP_BASELINE',
    dayEpoch: 1,
    refreshAccount: true,
    refreshPositions: true,
  }).result;
  if (baseline.status !== 'COMMITTED') throw new Error('订阅归属基线未提交');

  await quote.reconcileFromCurrentTruth();
  quote.start();
  postTrade.start();
  if (!(await postTrade.completeRebuildBaseline())) throw new Error('成交后基线尚未完成');

  positionAcks.length = 0;
  publishedRisk.length = 0;
  const baselineSubscriptions = new Set(actualSubscriptions);

  return {
    quote,
    postTrade,
    snapshot,
    termination,
    scheduler,
    symbolRegistry,
    ...stateFixtures,
    actualSubscriptions,
    baselineSubscriptions,
    subscribed,
    unsubscribed,
    positionErrors,
    positionAcks,
    publishedRisk,
    secondaryErrors,
    getPositionReads: () => positionReads,
    setPositions: (next: ReadonlyArray<Position>) => {
      positions = next;
    },
    changeOrderHold: (symbol: string, action: OrderHoldSymbolsChangedEvent['action']) => {
      if (action === 'ADDED') holdSymbols.add(symbol);
      else holdSymbols.delete(symbol);

      for (const listener of holdListeners) listener({ symbol, action });
    },
    stop: async () => {
      await postTrade.stopAndDrain();
      await quote.stopAndDrain().catch(() => quote.stopAndDrain());
      termination.requestShutdown();
      await Promise.all(snapshotDrains);
    },
  };
}

describe('Quote 双向交错的工作失败归属', () => {
  it('普通 A await 后的新持仓 X 失败交回 PostTrade，保持 stale；普通后继不偷重试', async () => {
    const entered = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const failure = await createExternalApiRequestError({
      operation: 'subscribeSymbols',
      attempts: 1,
      cause: new Error('position X unavailable'),
    });
    let positionAttempts = 0;
    const h = await createOwnershipHarness({
      onSubscribe: async (symbols) => {
        if (symbols.includes('A.HK')) {
          entered.resolve();
          await release.promise;
        }

        if (symbols.includes('X.HK') && ++positionAttempts === 1) throw failure;
      },
    });
    try {
      h.changeOrderHold('A.HK', 'ADDED');
      await entered.promise;
      h.setPositions([
        createPositionDouble({ symbol: 'X.HK', quantity: 100, availableQuantity: 100 }),
      ]);
      h.postTrade.recordSettlementRefreshNeed({ refreshAccount: true, refreshPositions: true });
      let freshReached = false;
      const fresh = h.postTrade.waitForFresh().then((receipt) => {
        freshReached = true;
        return receipt;
      });
      await h.scheduler.runNext(0);
      expect(h.snapshot.getView().positions.map((position) => position.symbol)).toEqual(['X.HK']);
      expect(h.quoteSubscriptionState.allTradingSymbols.has('X.HK')).toBe(false);
      release.resolve();
      await flushMicrotasks();

      expect(h.positionErrors).toEqual([failure]);
      expect(h.positionAcks).toEqual([]);
      expect(h.termination.getFatalState()).toEqual({ hasFatalError: false });
      expect(h.postTrade.getStatus()).toEqual({
        started: true,
        currentVersion: 0,
        staleVersion: 1,
      });
      expect(h.scheduler.pendingDelays()).toEqual([API.DEFAULT_RETRY_DELAY_MS]);
      expect(h.publishedRisk).toEqual([]);
      expect(freshReached).toBe(false);
      expect(h.quoteSubscriptionState.allTradingSymbols).toEqual(h.actualSubscriptions);
      expect(h.actualSubscriptions).toEqual(new Set([...h.baselineSubscriptions, 'A.HK']));

      h.changeOrderHold('UNRELATED.HK', 'ADDED');
      await h.quote.waitForAdmission(['UNRELATED.HK']);
      await h.quote.waitForAdmission(['X.HK']);
      expect(positionAttempts).toBe(1);
      expect(h.getPositionReads()).toBe(2);
      expect(freshReached).toBe(false);
      expect(h.termination.getFatalState()).toEqual({ hasFatalError: false });

      await h.scheduler.runNext(API.DEFAULT_RETRY_DELAY_MS);
      await h.scheduler.runNext(0);
      const receipt = await fresh;
      expect(positionAttempts).toBe(2);
      expect(h.getPositionReads()).toBe(3);
      expect(h.postTrade.isCurrent(receipt)).toBe(true);
      expect(receipt.settlementVersion).toBe(1);
      expect(h.publishedRisk).toEqual(['BULL.HK', 'BEAR.HK']);
      expect(h.positionErrors).toEqual([failure]);
      expect(h.quoteSubscriptionState.allTradingSymbols).toEqual(h.actualSubscriptions);
      expect(h.actualSubscriptions.has('X.HK')).toBe(true);
      expect(h.scheduler.pendingDelays()).toEqual([]);
      expect(h.secondaryErrors).toEqual([]);
    } finally {
      release.resolve();
      await h.stop();
    }
  });

  it.each(['order-add', 'seat-add', 'order-remove', 'seat-remove'])(
    'awaited position await 后的普通 %s 错误仍 fatal，不降级为 PostTrade 重试',
    async (change) => {
      const entered = Promise.withResolvers<undefined>();
      const release = Promise.withResolvers<undefined>();
      const failure = await createExternalApiRequestError({
        operation: change.endsWith('add') ? 'subscribeSymbols' : 'unsubscribeSymbols',
        attempts: 1,
        cause: new Error('ordinary mutation unavailable'),
      });
      const affectedSymbol = change === 'seat-remove' ? 'BULL.HK' : 'ORDINARY.HK';
      let ordinaryAttempts = 0;
      const h = await createOwnershipHarness({
        orderHolds: change === 'order-remove' ? [affectedSymbol] : [],
        onSubscribe: async (symbols) => {
          if (symbols.includes('POSITION.HK')) {
            entered.resolve();
            await release.promise;
          }

          if (change.endsWith('add') && symbols.includes(affectedSymbol)) {
            ordinaryAttempts += 1;
            throw failure;
          }
        },
        onUnsubscribe: async (symbols) => {
          if (change.endsWith('remove') && symbols.includes(affectedSymbol)) {
            ordinaryAttempts += 1;
            if (ordinaryAttempts === 1) throw failure;
          }
        },
      });
      try {
        h.setPositions([
          createPositionDouble({ symbol: 'POSITION.HK', quantity: 100, availableQuantity: 100 }),
        ]);
        h.postTrade.recordSettlementRefreshNeed({ refreshAccount: true, refreshPositions: true });
        await h.scheduler.runNext(0);
        await entered.promise;
        if (change.startsWith('order')) {
          h.changeOrderHold(affectedSymbol, change.endsWith('add') ? 'ADDED' : 'REMOVED');
        } else {
          const previous = h.symbolRegistry.getSeatState('LONG');
          h.symbolRegistry.updateSeatState(
            'LONG',
            change.endsWith('add')
              ? { ...previous, symbol: affectedSymbol, status: 'ACTIVE', lastSeatActivatedAt: 1000 }
              : { ...previous, symbol: null, status: 'EMPTY', lastSeatActivatedAt: null },
          );
        }

        release.resolve();
        await flushMicrotasks();
        expect(h.termination.getFatalState()).toEqual({ hasFatalError: true, error: failure });
        expect(h.termination.isTerminated()).toBe(true);
        expect(h.lifecycleState.isTradingEnabled).toBe(false);
        expect(h.positionErrors).toEqual([]);
        expect(h.positionAcks).toHaveLength(1);
        expect(ordinaryAttempts).toBe(1);
        expect(h.getPositionReads()).toBe(2);
        expect(h.scheduler.pendingDelays()).toEqual([]);
        expect(h.quoteSubscriptionState.allTradingSymbols).toEqual(h.actualSubscriptions);
        expect(h.actualSubscriptions.has('POSITION.HK')).toBe(true);
        expect(h.secondaryErrors).toEqual([]);
      } finally {
        release.resolve();
        await h.stop();
      }
    },
  );

  it('r10 持仓订阅 await 中 r11 到达，当前事实保护旧持仓并完成同一 settlement', async () => {
    const entered = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const oldPosition = createPositionDouble({
      symbol: 'OLD_POSITION.HK',
      quantity: 100,
      availableQuantity: 100,
    });
    const h = await createOwnershipHarness({
      positions: [oldPosition],
      onSubscribe: async (symbols) => {
        if (symbols.includes('SLOW.HK')) {
          entered.resolve();
          await release.promise;
        }
      },
    });
    try {
      h.setPositions([
        createPositionDouble({ symbol: 'SLOW.HK', quantity: 100, availableQuantity: 100 }),
      ]);
      h.postTrade.recordSettlementRefreshNeed({ refreshAccount: true, refreshPositions: true });
      const fresh = h.postTrade.waitForFresh();
      await h.scheduler.runNext(0);
      await entered.promise;
      const oldToken = h.snapshot.getView().token;
      h.setPositions([
        oldPosition,
        createPositionDouble({ symbol: 'LATEST.HK', quantity: 100, availableQuantity: 100 }),
      ]);
      const currentReceipt = await h.snapshot.requestRefresh({
        source: 'SEAT_ACTIVATION',
        dayEpoch: oldToken.dayEpoch,
        refreshAccount: true,
        refreshPositions: true,
      }).result;
      if (currentReceipt.status !== 'COMMITTED') throw new Error('交错的新持仓未提交');

      expect(h.publishedRisk).toEqual([]);
      const lateNotification = h.quote.reconcilePositionHoldFromCurrentTruth(oldToken);
      release.resolve();
      await lateNotification;
      const ready = await fresh;
      expect(ready.snapshotToken).toEqual(currentReceipt.snapshotToken);
      expect(h.postTrade.isCurrent(ready)).toBe(true);
      expect(ready.settlementVersion).toBe(1);
      expect(h.getPositionReads()).toBe(3);
      expect(h.subscribed.slice(1)).toEqual([['SLOW.HK'], ['LATEST.HK']]);
      expect(h.unsubscribed).toEqual([['SLOW.HK']]);
      expect(h.quoteSubscriptionState.allTradingSymbols).toEqual(h.actualSubscriptions);
      expect(h.actualSubscriptions).toEqual(new Set([...h.baselineSubscriptions, 'LATEST.HK']));
      expect(h.positionErrors).toEqual([]);
      expect(h.termination.getFatalState()).toEqual({ hasFatalError: false });
      expect(h.scheduler.pendingDelays()).toEqual([]);
    } finally {
      release.resolve();
      await h.stop();
    }
  });
});
