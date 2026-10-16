import { scheduleBoundedOneShotAt } from '../../src/runtime/timer/index.js';
import { wrapExternalApiRequest } from '../../src/infrastructure/externalApi/index.js';
import { nowMonotonicMs, wait } from '../../src/infrastructure/time/index.js';

import type { TradeRuntime } from '../../src/app/runtime/types.js';

/**
 * 业务 mutation 授权跨 owner 交错测试。
 * 真实 switch/风险 runtime、monitor、Trader、FIFO、snapshot、settlement 与 broker adapter
 * 共同验证原票失效后的撤单阻断及未 accepted 风险工作的原 owner 重评，不伪造 ACK/READY。
 */

import { describe, expect, it } from 'bun:test';
import { createMonitorConfig, createTradingConfig } from '../../mock/factories/configFactory.js';
import { createPostTradeConsistencyRuntime } from '../../src/app/runtime/createPostTradeConsistencyRuntime.js';
import { createTerminationRuntime } from '../../src/runtime/lifecycle/terminationRuntime.js';
import { createAccountPositionSnapshot } from '../../src/application/accountPositionSnapshot/index.js';
import { createProtectiveLiquidationWorkflow } from '../../src/application/protectiveLiquidation/index.js';
import { createUnrealizedLossMonitor } from '../../src/application/protectiveLiquidation/unrealizedLossExecutor.js';
import { createSeatSwitchWorkflow } from '../../src/application/seatSwitch/index.js';
import { createProtectiveLiquidationEpisodeTracker } from '../../src/domain/liquidation/episode/index.js';
import { orderAnalysis } from '../../src/domain/order/orderAnalysis.js';
import { createDailyLossTracker } from '../../src/domain/risk/dailyLossTracker.js';
import { createRiskChecker } from '../../src/domain/risk/index.js';
import { createPositionLimitChecker } from '../../src/domain/risk/positionLimitChecker.js';
import { createUnrealizedLossChecker } from '../../src/domain/risk/unrealizedLossChecker.js';
import { createWarrantRiskChecker } from '../../src/domain/risk/warrantRiskChecker.js';
import { createSymbolRegistry } from '../../src/domain/seat/symbolRegistry.js';
import { createTradingRiskEventRuntime } from '../../src/runtime/tradingRiskEventRuntime/tradingRiskEventRuntime.js';
import type { QuoteUpdatedEvent } from '../../src/types/marketPorts.js';
import type { Quote } from '../../src/types/quote.js';
import { getRequiredHKDateKey, toHongKongTimeIso } from '../../src/utils/time/index.js';
import {
  createLoggerStub,
  createWarrantCandidate,
  getDefaultAutoSearchConfig,
} from '../helpers/seatTestUtils.js';
import {
  createLiquidationCooldownTrackerDouble,
  createLoggerDouble,
  createMarketDataClientDouble,
  createMonitorContextDouble,
  createQuoteDouble,
  createRateLimiterDouble,
} from '../helpers/testDoubles.js';
import type { BrokerIngressInput } from '../infrastructure/longbridge/trade/brokerIngressFixture.js';
import { createBrokerIngressFixture } from './architectureRefactoringP1Native/trade/brokerIngressFixture.js';

const NOW_MS = Date.parse('2026-07-10T02:00:00.000Z');

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((callback) => {
    resolve = callback;
  });
  return { promise, resolve };
}

function createOrderFrame(
  orderId: string,
  status: 'New' | 'Filled',
  quantity = '200',
): BrokerIngressInput {
  return {
    orderId,
    tradeId: `${orderId}-trade`,
    symbol: 'BULL.HK',
    stockName: 'HSI RC',
    remark: '',
    side: 'BUY',
    status,
    orderType: 'ELO',
    quantity,
    executedQuantity: status === 'Filled' ? quantity : '0',
    submittedPrice: '2',
    executedPrice: status === 'Filled' ? '2' : '0',
    submittedAtMs: NOW_MS - 1000,
    executionTimeMs: status === 'Filled' ? NOW_MS - 1000 : null,
    updatedAtMs: NOW_MS,
  };
}

/** 只等自然异步链收口；未满足断言立即失败，不替生产 owner 安排交易重试。 */
async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;

    await Bun.sleep(5);
  }

  throw new Error('自然 owner 链未在测试等待内收口');
}

/** 真实经济 owner 共用同一中性 broker；只替换外部行情与订阅 IO。 */
async function createFixture() {
  const frame = createOrderFrame('ORIGINAL-BUY', 'Filled');
  const native = await createBrokerIngressFixture(frame);
  native.setAccountBalance({
    currency: 'HKD',
    totalCash: '100000',
    netAssets: '100400',
    availableCash: '100000',
  });
  function setPosition(quantity: string): void {
    native.setStockPositions([
      {
        symbol: 'BULL.HK',
        symbolName: 'HSI RC',
        accountChannel: 'lb_papertrading',
        currency: 'HKD',
        quantity,
        availableQuantity: quantity,
        costPrice: '2',
      },
    ]);
  }
  setPosition('200');
  const config = createMonitorConfig({
    maxUnrealizedLossPerSymbol: '10',
    autoSearchConfig: getDefaultAutoSearchConfig(),
  });
  const symbolRegistry = createSymbolRegistry(config);
  symbolRegistry.updateSeatState('LONG', {
    ...symbolRegistry.getSeatState('LONG'),
    symbol: 'BULL.HK',
    status: 'ACTIVE',
    callPrice: '20000',
    lastSeatActivatedAt: NOW_MS,
  });
  const daily = createDailyLossTracker({
    onOwnershipWarning: () => {},
    ...orderAnalysis,
    toHongKongTimeIso,
  });
  daily.resetAll(new Date(NOW_MS));
  const gate = { isTradingEnabled: true, canTrade: true, isHalfDay: false };
  const fatalErrors: unknown[] = [];
  const termination = createTerminationRuntime({
    closeTradingGate: () => {
      gate.isTradingEnabled = false;
    },
    closeProducerAdmission: () => {},
    stopProducers: [],
    onSecondaryError: (error) => {
      fatalErrors.push(error);
    },
  });
  const account = native.createAccountService({ rateLimiter: createRateLimiterDouble() });
  let snapshotReadBarrier: Promise<void> | null = null;
  const snapshot = createAccountPositionSnapshot({
    dayEpoch: 1,
    scheduler: { schedule: queueMicrotask },
    readPort: {
      getAccountSnapshot: async () => {
        if (snapshotReadBarrier !== null) await snapshotReadBarrier;

        return account.getAccountSnapshot();
      },
      getStockPositions: async () => {
        if (snapshotReadBarrier !== null) await snapshotReadBarrier;

        return account.getStockPositions();
      },
    },
    reportFatalError: termination.reportFatalError,
  });
  const risk = createRiskChecker({
    warrantRiskChecker: createWarrantRiskChecker({
      onInvalidCallPrice: () => {},
      onWarrantInfoSet: () => {},
    }),
    positionLimitChecker: createPositionLimitChecker({ maxPositionNotional: '50000' }),
    unrealizedLossChecker: createUnrealizedLossChecker({
      maxUnrealizedLossPerSymbol: '10',
      onMissingData: () => {},
    }),
  });
  risk.setWarrantInfoFromCallPrice('BULL.HK', '20000', true);
  const episodeTracker = createProtectiveLiquidationEpisodeTracker();
  let tradeRuntime: TradeRuntime | null = null;
  const settlement = createPostTradeConsistencyRuntime({
    logger: createLoggerDouble(),
    snapshot,
    termination,
    getProtectiveOrderReader: () => {
      if (tradeRuntime === null) throw new Error('Trader 未装配');

      return tradeRuntime.orderMonitor;
    },
    onPositionsCommitted: async () => {},
    scheduler: { scheduleTimer: setTimeout, clearTimer: clearTimeout },
  });
  const quoteListeners = new Set<(event: QuoteUpdatedEvent) => void>();
  let nextQuote: (() => Promise<Quote>) | null = null;
  let quoteReads = 0;
  const marketDataClient = createMarketDataClientDouble({
    onQuoteUpdated: (listener) => {
      quoteListeners.add(listener);
      return () => {
        quoteListeners.delete(listener);
      };
    },
    getQuotes: async (symbols) => {
      quoteReads++;
      const read = nextQuote;
      nextQuote = null;
      const quote = read === null ? createQuoteDouble('BULL.HK', '1', 100) : await read();
      return new Map([...symbols].map((symbol) => [symbol, { ...quote, symbol }]));
    },
  });
  const actualTrader = await native.createTradeRuntime({
    logger: createLoggerDouble(),
    wait: wait,
    nowMonotonicMs: nowMonotonicMs,
    requestExternalApi: wrapExternalApiRequest,
    scheduleBoundedOneShotAt: scheduleBoundedOneShotAt,
    tradingConfig: createTradingConfig({ monitor: config }),
    marketDataClient,
    symbolRegistry,
    dailyLossTracker: daily,
    protectiveLiquidationEpisodeTracker: episodeTracker,
    persistProtectiveLiquidationExecutionProgress: () => {
      throw new Error('无成交场景不得持久化保护性 progress');
    },
    postTradeConsistencyRuntime: settlement,
    isExecutionAllowed: () => gate.isTradingEnabled,
    isContinuousTradingAllowed: () => gate.canTrade,
    now: () => new Date(NOW_MS),
    scheduleTimer: setTimeout,
    clearTimer: clearTimeout,
    readCurrentTradingDayInfo: () => ({
      dateKey: getRequiredHKDateKey(new Date(NOW_MS)),
      info: { isTradingDay: true, isHalfDay: false },
    }),
    unrealizedLossBuyGate: risk,
    termination,
  });
  tradeRuntime = actualTrader;
  const monitor = createUnrealizedLossMonitor({
    logger: createLoggerDouble(),
    maxUnrealizedLossPerSymbol: '10',
  });
  let monitorCalls = 0;
  const monitorResults: boolean[] = [];
  const monitorContext = createMonitorContextDouble({
    config,
    symbolRegistry,
    orderRecorder: actualTrader.orderRecorder,
    dailyLossTracker: daily,
    riskChecker: risk,
    unrealizedLossMonitor: {
      monitorDirectionalUnrealizedLoss: async (context) => {
        monitorCalls++;
        const accepted = await monitor.monitorDirectionalUnrealizedLoss(context);
        monitorResults.push(accepted);
        return accepted;
      },
    },
  });
  settlement.bindBusinessDeps({
    monitorContext,
    dailyLossTracker: daily,
    liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
    protectiveLiquidationEpisodeTracker: episodeTracker,
    mixedTradeLogRepository: {
      appendCompletionIdempotent: () => {
        throw new Error('无成交场景不得发布保护性 completion');
      },
    },
  });
  await actualTrader.orderMonitor.initialize();
  await actualTrader.orderMonitor.recoverOrderTrackingFromSnapshot([]);
  native.setOrderSnapshotReplies([], [frame]);
  const allOrders = await actualTrader.orderRecorder.fetchAllOrdersFromAPI();
  daily.recalculateFromAllOrders(allOrders, config, new Date(NOW_MS));
  expect(
    actualTrader.orderRecorder.commitRebuildSnapshot(
      [{ symbol: 'BULL.HK', isLongSymbol: true }],
      allOrders,
      () => true,
      'REBUILD',
    ).status,
  ).toBe('COMMITTED');
  const baseline = await snapshot.requestRefresh({
    source: 'TEST_REBUILD',
    dayEpoch: 1,
    refreshAccount: true,
    refreshPositions: true,
  }).result;
  expect(baseline.status).toBe('COMMITTED');
  settlement.start();
  await settlement.completeRebuildBaseline();
  await settlement.waitForFresh();
  const workflow = createProtectiveLiquidationWorkflow({
    logger: createLoggerDouble(),
    orderExecutor: actualTrader.orderExecutor,
    symbolRegistry,
    monitorContext,
    tradingTimeState: gate,
    lifecycleState: gate,
    postTradeConsistencyRuntime: settlement,
    snapshot,
    doomsdayProtectionEnabled: false,
    now: () => new Date(NOW_MS),
    termination,
  });
  const runtime = createTradingRiskEventRuntime({
    logger: createLoggerDouble(),
    marketDataClient,
    symbolRegistry,
    postTradeConsistencyRuntime: settlement,
    workflow,
    termination,
  });
  return {
    native,
    tradeRuntime: actualTrader,
    snapshot,
    settlement,
    symbolRegistry,
    monitorContext,
    marketDataClient,
    gate,
    risk,
    runtime,
    quoteReads: () => quoteReads,
    monitorCalls: () => monitorCalls,
    monitorResults: () => [...monitorResults],
    setPosition,
    deferSnapshotReads: () => {
      const barrier = createDeferred();
      snapshotReadBarrier = barrier.promise;
      return () => {
        snapshotReadBarrier = null;
        barrier.resolve();
      };
    },
    deferFinalQuote: () => {
      const entered = createDeferred();
      const delayed = Promise.withResolvers<Quote>();
      nextQuote = () => {
        entered.resolve();
        return delayed.promise;
      };
      return {
        entered: entered.promise,
        release: () => {
          delayed.resolve(createQuoteDouble('BULL.HK', '1', 100));
        },
      };
    },
    emitQuote: () => {
      for (const listener of quoteListeners)
        listener({ symbol: 'BULL.HK', quote: createQuoteDouble('BULL.HK', '1', 100) });
    },
    cleanup: async () => {
      settlement.abortWaiting();
      await runtime.stopAndDrain();
      await settlement.stopAndDrain();
      await actualTrader.orderMonitor.stopRuntimeAndDrain();
      await actualTrader.orderMonitor.teardown();
      expect(termination.isTerminated()).toBe(false);
      expect(fatalErrors).toEqual([]);
    },
  };
}

/** 换标入口只消费真实 pending cache 与 snapshot/settlement/席位票。 */
async function createPendingSwitch(f: Awaited<ReturnType<typeof createFixture>>) {
  const manager = createSeatSwitchWorkflow({
    logger: createLoggerStub(),
    monitorConfig: f.monitorContext.config,
    symbolRegistry: f.symbolRegistry,
    marketDataClient: f.marketDataClient,
    cacheManager: f.tradeRuntime.cacheManager,
    orderHoldRegistry: f.tradeRuntime.orderHoldRegistry,
    orderMonitor: f.tradeRuntime.orderMonitor,
    orderExecutor: f.tradeRuntime.orderExecutor,
    orderRecorder: f.tradeRuntime.orderRecorder,
    riskChecker: f.risk,
    candidateSearch: {
      resolveDistanceRange: (direction) =>
        f.monitorContext.config.autoSearchConfig[
          direction === 'LONG' ? 'switchDistanceRangeBull' : 'switchDistanceRangeBear'
        ],
      findCandidate: async () => createWarrantCandidate('NEXT.HK'),
    },
    clock: { now: () => new Date(NOW_MS) },
    getTradingCalendarSnapshot: () =>
      new Map([['2026-07-10', { isTradingDay: true, isHalfDay: false }]]),
  });
  const activeVersion = f.symbolRegistry.getSeatVersion('LONG');
  const admission = await f.settlement.waitForFresh();
  const activeView = f.snapshot.getView();
  const started = await manager.startSwitchOnDistance({
    direction: 'LONG',
    monitorPrice: '20000',
    positions: activeView.positions,
    canContinue: () =>
      f.gate.isTradingEnabled &&
      f.gate.canTrade &&
      f.settlement.isCurrent(admission) &&
      f.snapshot.isCurrent(activeView.token, { account: false, positions: true }) &&
      f.symbolRegistry.getSeatVersion('LONG') === activeVersion,
  });
  expect(started.started).toBe(true);
  expect(manager.hasPendingSwitch('LONG')).toBe(true);
  return manager;
}

describe('switch cancellation original authorization through real FIFO', () => {
  it('原授权有效时沿真实撤单 ACK 进入原订单/ready WAIT，后续仍 pending 时不重复撤单', async () => {
    const f = await createFixture();
    f.native.setOrderSnapshotReplies([], [createOrderFrame('SWITCH-PENDING-BUY', 'New')]);
    const manager = await createPendingSwitch(f);
    f.native.setCancelBeforeReply(async () => {});
    const receipt = await f.settlement.waitForFresh();
    const view = f.snapshot.getView();
    const version = f.symbolRegistry.getSeatVersion('LONG');
    const params = {
      direction: 'LONG' as const,
      positions: view.positions,
      canContinue: () =>
        f.gate.isTradingEnabled &&
        f.gate.canTrade &&
        f.settlement.isCurrent(receipt) &&
        f.snapshot.isCurrent(view.token, { account: false, positions: true }) &&
        f.symbolRegistry.getSeatVersion('LONG') === version,
    };
    try {
      const first = await manager.advancePendingSwitch(params);
      expect(first.driveResult).toEqual({
        kind: 'WAIT',
        wakeups: [{ kind: 'ORDER_EVENT', symbols: ['BULL.HK'] }, { kind: 'FRESHNESS' }],
      });
      const second = await manager.advancePendingSwitch(params);
      expect(second.driveResult).toEqual(first.driveResult);
      expect(f.native.nativeCancelOrderIds()).toEqual(['SWITCH-PENDING-BUY']);
      expect(f.native.nativeMutations()).toEqual([]);
      expect(manager.hasPendingSwitch('LONG')).toBe(true);
    } finally {
      await f.cleanup();
    }
  });

  it('原 switch 撤单首次 transient 后 position 失效，真实 retry attempt 不借 ORDER_FACT 再发', async () => {
    const f = await createFixture();
    f.native.setOrderSnapshotReplies([], [createOrderFrame('SWITCH-PENDING-BUY', 'New')]);
    const manager = await createPendingSwitch(f);
    const receipt = await f.settlement.waitForFresh();
    const view = f.snapshot.getView();
    const version = f.symbolRegistry.getSeatVersion('LONG');
    f.native.setCancelBeforeReply(async () => {
      await f.snapshot.requestRefresh({
        source: 'SEAT_ACTIVATION',
        dayEpoch: 1,
        refreshAccount: false,
        refreshPositions: true,
      }).result;
    });
    f.native.setCancelFailure(Object.assign(new Error('rate limit'), { code: '429' }));
    try {
      const result = await manager.advancePendingSwitch({
        direction: 'LONG',
        positions: view.positions,
        canContinue: () =>
          f.gate.isTradingEnabled &&
          f.gate.canTrade &&
          f.settlement.isCurrent(receipt) &&
          f.snapshot.isCurrent(view.token, { account: false, positions: true }) &&
          f.symbolRegistry.getSeatVersion('LONG') === version,
      });
      expect(result.driveResult.kind).toBe('NOOP');
      expect(f.native.nativeCancelOrderIds()).toEqual(['SWITCH-PENDING-BUY']);
      expect(f.native.nativeMutations()).toEqual([]);
      expect(f.symbolRegistry.getSeatState('LONG').status).toBe('SWITCHING');
    } finally {
      await f.cleanup();
    }
  });

  for (const change of ['POSITION', 'SETTLEMENT', 'SEAT', 'LIFECYCLE'] as const) {
    it(`FIFO 等待期间 ${change} 失效不撤旧买单，真实 ORDER_FACT 收尾仍可执行`, async () => {
      const f = await createFixture();
      const pending = createOrderFrame('SWITCH-PENDING-BUY', 'New');
      f.native.setOrderSnapshotReplies([], [pending]);
      const manager = await createPendingSwitch(f);
      const issued = createDeferred();
      const release = createDeferred();
      f.native.setCancelBeforeReply(async () => {
        issued.resolve();
        await release.promise;
      });
      const blocker = f.tradeRuntime.orderMonitor.cancelOrder('ORDER-FACT-BLOCKER', {
        kind: 'ORDER_FACT',
      });
      await issued.promise;
      const receipt = await f.settlement.waitForFresh();
      const view = f.snapshot.getView();
      const switchVersion = f.symbolRegistry.getSeatVersion('LONG');
      let checks = 0;
      const advance = manager.advancePendingSwitch({
        direction: 'LONG',
        positions: view.positions,
        canContinue: () => {
          checks++;
          return (
            f.gate.isTradingEnabled &&
            f.gate.canTrade &&
            f.settlement.isCurrent(receipt) &&
            f.snapshot.isCurrent(view.token, { account: false, positions: true }) &&
            f.symbolRegistry.getSeatVersion('LONG') === switchVersion
          );
        },
      });
      try {
        // 真实 pending cache 命中后，第三次原 guard 已位于 cancelOrder 入队前。
        await waitUntil(() => checks >= 3);
        if (change === 'POSITION') {
          await f.snapshot.requestRefresh({
            source: 'SEAT_ACTIVATION',
            dayEpoch: 1,
            refreshAccount: false,
            refreshPositions: true,
          }).result;
        } else if (change === 'SETTLEMENT') {
          f.settlement.recordSettlementRefreshNeed({
            refreshAccount: true,
            refreshPositions: true,
          });
        } else if (change === 'SEAT') {
          f.symbolRegistry.updateSeatStateWithVersionBump('LONG', {
            ...f.symbolRegistry.getSeatState('LONG'),
            symbol: 'REPLACEMENT.HK',
            status: 'ACTIVE',
            lastSeatActivatedAt: NOW_MS,
          });
        } else {
          f.gate.isTradingEnabled = false;
        }

        release.resolve();
        const blockerOutcome = await blocker;
        const advanceOutcome = await advance;
        expect(blockerOutcome.kind).toBe('CANCEL_CONFIRMED');
        expect(advanceOutcome.driveResult.kind).toBe('NOOP');
        expect(f.native.nativeCancelOrderIds()).toEqual(['ORDER-FACT-BLOCKER']);
        expect(f.native.nativeMutations()).toEqual([]);
        expect(f.symbolRegistry.getSeatState('LONG').status).toBe(
          change === 'SEAT' ? 'ACTIVE' : 'SWITCHING',
        );
        const cleanupOutcome = await f.tradeRuntime.orderMonitor.cancelOrder('ORDER-FACT-CLEANUP', {
          kind: 'ORDER_FACT',
        });
        expect(cleanupOutcome.kind).toBe('CANCEL_CONFIRMED');
        expect(f.native.nativeCancelOrderIds()).toEqual([
          'ORDER-FACT-BLOCKER',
          'ORDER-FACT-CLEANUP',
        ]);
      } finally {
        release.resolve();
        await Promise.allSettled([blocker, advance]);
        await f.cleanup();
      }
    });
  }
});

describe('risk original owner supersession without another quote', () => {
  it('最终行情 await 期间 position superseded 且未 accepted，由原 owner 重评最新持仓并只提交一次', async () => {
    const f = await createFixture();
    const delayed = f.deferFinalQuote();
    f.native.setSubmitBehavior(async () => 'RISK-CURRENT-ACK');
    try {
      f.runtime.start();
      const readiness = await f.settlement.waitForFresh();
      const before = f.snapshot.getView();
      f.emitQuote();
      await delayed.entered;
      expect(f.native.nativeMutations()).toEqual([]);
      f.setPosition('100');
      const newer = await f.snapshot.requestRefresh({
        source: 'SEAT_ACTIVATION',
        dayEpoch: 1,
        refreshAccount: false,
        refreshPositions: true,
      }).result;
      expect(newer.status).toBe('COMMITTED');
      expect(f.snapshot.isCurrent(before.token, { account: false, positions: true })).toBe(false);
      expect(f.settlement.isCurrent(readiness)).toBe(true);
      delayed.release();
      await waitUntil(() => f.monitorResults().length === 2);
      // 下一自然事件轮前微任务已排空，原 runtime 已消费 monitor 返回值；停止不能代替收口。
      await Bun.sleep(0);
      expect(f.monitorResults()).toEqual([false, true]);
      expect(f.monitorCalls()).toBe(2);
      expect(f.quoteReads()).toBe(2);
      expect(f.native.nativeSubmitObservations()).toMatchObject([
        { symbol: 'BULL.HK', side: 'SELL', quantity: '100', orderType: 'MO' },
      ]);

      expect(
        f.native.nativeMutations().filter((mutation) => mutation.kind === 'SUBMIT'),
      ).toHaveLength(1);
      expect(f.tradeRuntime.orderHoldRegistry.getHoldSymbols().has('BULL.HK')).toBe(true);
      expect(f.tradeRuntime.orderMonitor.hasPendingProtectiveLiquidationOrders('LONG')).toBe(true);
    } finally {
      delayed.release();
      await f.cleanup();
    }
  });

  it('原 SETTLEMENT stale 后阻塞且未 accepted，ready 事件由原 owner 重评，不等待新 quote', async () => {
    const f = await createFixture();
    const delayed = f.deferFinalQuote();
    const releaseRead = f.deferSnapshotReads();
    f.native.setSubmitBehavior(async () => 'RISK-SETTLEMENT-ACK');
    try {
      f.runtime.start();
      const originalReceipt = await f.settlement.waitForFresh();
      f.emitQuote();
      await delayed.entered;
      f.settlement.recordSettlementRefreshNeed({ refreshAccount: true, refreshPositions: true });
      expect(f.settlement.isCurrent(originalReceipt)).toBe(false);
      await waitUntil(() => f.snapshot.getStatus().inFlight);
      delayed.release();
      await waitUntil(() => f.monitorResults().length === 1);
      await Bun.sleep(0);
      expect(f.monitorResults()).toEqual([false]);
      expect(f.monitorCalls()).toBe(1);
      expect(f.native.nativeSubmitObservations()).toEqual([]);
      expect(f.settlement.getStatus().currentVersion).toBeLessThan(
        f.settlement.getStatus().staleVersion,
      );
      releaseRead();
      const fresh = await f.settlement.waitForFresh();
      expect(f.settlement.isCurrent(fresh)).toBe(true);
      await waitUntil(() => f.monitorResults().length === 2);
      await Bun.sleep(0);
      expect(f.monitorResults()).toEqual([false, true]);
      expect(f.monitorCalls()).toBe(2);
      expect(f.quoteReads()).toBe(2);
      expect(f.native.nativeSubmitObservations()).toHaveLength(1);
    } finally {
      releaseRead();
      delayed.release();
      await f.cleanup();
    }
  });

  it('原风险任务已排入真实 FIFO 后 position superseded，未 accepted 工作由原 owner 重评一次', async () => {
    const f = await createFixture();
    const issued = createDeferred();
    const release = createDeferred();
    f.native.setCancelBeforeReply(async () => {
      issued.resolve();
      await release.promise;
    });
    const blocker = f.tradeRuntime.orderMonitor.cancelOrder('RISK-FIFO-BLOCKER', {
      kind: 'ORDER_FACT',
    });
    f.native.setSubmitBehavior(async () => 'RISK-FIFO-ACK');
    try {
      await issued.promise;
      f.runtime.start();
      const positionReads = f.native.accountReadCounts().positions;
      f.emitQuote();
      await waitUntil(() => f.monitorCalls() === 1);
      // sell quantity resolver 已等待真实共享 FIFO；未读 broker 持仓，也未取得 quote permit。
      await Bun.sleep(0);
      expect(f.native.accountReadCounts().positions).toBe(positionReads);
      expect(f.quoteReads()).toBe(0);
      expect(f.monitorResults()).toEqual([]);
      f.setPosition('100');
      await f.snapshot.requestRefresh({
        source: 'SEAT_ACTIVATION',
        dayEpoch: 1,
        refreshAccount: false,
        refreshPositions: true,
      }).result;
      release.resolve();
      const blockerOutcome = await blocker;
      expect(blockerOutcome.kind).toBe('CANCEL_CONFIRMED');
      await waitUntil(() => f.monitorResults().length === 2);
      await Bun.sleep(0);
      expect(f.monitorResults()).toEqual([false, true]);
      expect(f.monitorCalls()).toBe(2);
      expect(f.quoteReads()).toBe(1);
      expect(f.native.nativeSubmitObservations()).toMatchObject([
        { symbol: 'BULL.HK', side: 'SELL', quantity: '100', orderType: 'MO' },
      ]);
      expect(f.native.nativeCancelOrderIds()).toEqual(['RISK-FIFO-BLOCKER']);
    } finally {
      release.resolve();
      await Promise.allSettled([blocker]);
      await f.cleanup();
    }
  });

  it('真实 submit issued 后 snapshot 失效，accepted ACK 不 dirty、不重提、不清旧票买单', async () => {
    const f = await createFixture();
    const entered = createDeferred();
    const reply = Promise.withResolvers<string>();
    f.native.setSubmitBehavior(() => {
      entered.resolve();
      return reply.promise;
    });

    try {
      f.runtime.start();
      f.emitQuote();
      await entered.promise;
      expect(f.native.nativeSubmitObservations()).toHaveLength(1);
      await f.snapshot.requestRefresh({
        source: 'SEAT_ACTIVATION',
        dayEpoch: 1,
        refreshAccount: false,
        refreshPositions: true,
      }).result;
      reply.resolve('RISK-ISSUED-ACK');
      await waitUntil(() => f.monitorResults().length === 1);
      await Bun.sleep(0);
      expect(f.monitorResults()).toEqual([true]);
      expect(f.monitorCalls()).toBe(1);
      expect(f.tradeRuntime.orderMonitor.hasPendingProtectiveLiquidationOrders('LONG')).toBe(true);
      expect(f.quoteReads()).toBe(1);
      expect(f.native.nativeSubmitObservations()).toHaveLength(1);
      expect(f.tradeRuntime.orderRecorder.getBuyOrdersForSymbol('BULL.HK', true)).toHaveLength(1);
      expect(f.tradeRuntime.orderHoldRegistry.getHoldSymbols().has('BULL.HK')).toBe(true);
    } finally {
      reply.resolve('RISK-ISSUED-ACK');
      await f.cleanup();
    }
  });

  for (const change of ['SEAT', 'DAY', 'LIFECYCLE'] as const) {
    it(`未 accepted 但 ${change} 身份已失效，不由原 owner 重提`, async () => {
      const f = await createFixture();
      const delayed = f.deferFinalQuote();
      try {
        f.runtime.start();
        f.emitQuote();
        await delayed.entered;
        if (change === 'SEAT') {
          f.symbolRegistry.updateSeatStateWithVersionBump('LONG', {
            ...f.symbolRegistry.getSeatState('LONG'),
            symbol: 'REPLACEMENT.HK',
            status: 'ACTIVE',
            lastSeatActivatedAt: NOW_MS,
          });
        } else if (change === 'DAY') {
          await f.snapshot.requestClear({ reason: 'DAY_CUT', dayEpoch: 2 });
        } else {
          f.gate.isTradingEnabled = false;
        }

        delayed.release();
        await waitUntil(() => f.monitorResults().length === 1);
        await Bun.sleep(0);
        expect(f.monitorResults()).toEqual([false]);
        expect(f.monitorCalls()).toBe(1);
        expect(f.quoteReads()).toBe(1);
        expect(f.native.nativeSubmitObservations()).toEqual([]);
        expect(f.tradeRuntime.orderRecorder.getBuyOrdersForSymbol('BULL.HK', true)).toHaveLength(1);
      } finally {
        delayed.release();
        await f.cleanup();
      }
    });
  }
});
