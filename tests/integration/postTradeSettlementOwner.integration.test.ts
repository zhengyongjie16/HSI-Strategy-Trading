import { createDiagnosticObserverDouble } from '../helpers/diagnostics.js';
import { createRuntimeStateFixtures } from '../helpers/runtimeStateFixtures.js';
import { scheduleBoundedOneShotAt } from '../../src/runtime/timer/index.js';
import { wrapExternalApiRequest } from '../../src/infrastructure/externalApi/index.js';
import { nowMonotonicMs, wait } from '../../src/infrastructure/time/index.js';

/**
 * 单实例成交后业务闭环：native tracking → O/Daily → H commit → 实际 Quote 订阅 ack → completion → R1/N1 → ready。
 * 复用既有离线 broker/execution fixture，只在真实订阅 mutation 返回前设屏障，不手工推进 readiness 或完成 episode。
 */

import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTradingConfig } from '../../mock/factories/configFactory.js';
import { createRateLimiter } from '../../src/application/orderExecution/rateLimiter.js';
import { createLiquidationCooldownTracker } from '../../src/domain/liquidation/cooldown/index.js';
import { createRiskChecker } from '../../src/domain/risk/index.js';
import { createPositionLimitChecker } from '../../src/domain/risk/positionLimitChecker.js';
import { createUnrealizedLossChecker } from '../../src/domain/risk/unrealizedLossChecker.js';
import { createWarrantRiskChecker } from '../../src/domain/risk/warrantRiskChecker.js';
import { createMixedTradeLogRepository } from '../../src/infrastructure/persistence/mixedTradeLogRepository/index.js';
import { createQuoteSubscriptionRuntime } from '../../src/runtime/quoteSubscriptionRuntime/index.js';
import { createExecutionFixture } from '../application/orderTracking/recorder/executionFixture.js';
import {
  createLoggerDouble,
  createMarketDataClientDouble,
  createMonitorConfigDouble,
  createMonitorContextDouble,
  createSymbolRegistryDouble,
  createTradeRuntimeDouble,
} from '../helpers/testDoubles.js';
import { createBrokerIngressFixture } from './architectureRefactoringP1Native/trade/brokerIngressFixture.js';

const T = Date.parse('2026-10-07T02:00:00.000Z');
const sellTime = T + 1_000;
const dayKey = '2026-10-07';

/** 原始 broker frame 只交给既有私有 producer；本测试不构造或接收 SDK DTO。 */
function protectiveSellFrame() {
  return {
    orderId: 'NATIVE-PROTECTIVE-SELL',
    tradeId: 'NATIVE-SELL-EXECUTION',
    symbol: 'BULL.HK',
    stockName: 'HSI RC',
    remark: '|PL',
    side: 'SELL' as const,
    status: 'Filled' as const,
    quantity: '100',
    executedQuantity: '100',
    submittedPrice: '0.9',
    executedPrice: '0.9',
    submittedAtMs: T + 100,
    executionTimeMs: sellTime,
    updatedAtMs: sellTime + 20,
  };
}

test('same native tracking owners wait for real position subscription ack before durable completion, exact R1/N1 and readiness', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hsi-p2-settlement-owner-'));
  const native = await createBrokerIngressFixture(protectiveSellFrame());
  const subscriptionAck = Promise.withResolvers<null>();
  const subscriptionIssued = Promise.withResolvers<null>();
  const closed = Promise.withResolvers<null>();
  const trace: string[] = [];
  const config = createMonitorConfigDouble({
    monitorSymbol: 'HSI.HK',
    orderOwnershipMapping: ['HSI'],
    liquidationTriggerLimit: 1,
    liquidationCooldown: { mode: 'minutes', minutes: 5 },
  });
  const tradingConfig = createTradingConfig({ monitor: config });
  const symbolRegistry = createSymbolRegistryDouble();
  const repository = createMixedTradeLogRepository({ resolveLogRootDir: () => root });
  const rateLimiter = createRateLimiter({
    wait: wait,
    nowMonotonicMs: nowMonotonicMs,
    logger: createLoggerDouble(),
  });
  const account = native.createAccountService({ rateLimiter });
  native.setAccountBalance({
    currency: 'HKD',
    totalCash: '10000.0000000000000001',
    netAssets: '10200.0000000000000001',
    availableCash: '10000.0000000000000001',
  });

  native.setStockPositions([
    {
      symbol: 'BULL.HK',
      symbolName: 'HSI RC',
      accountChannel: 'HK',
      currency: 'HKD',
      quantity: '100',
      availableQuantity: '100',
      costPrice: '1',
    },
    {
      symbol: 'BEAR.HK',
      symbolName: 'HSI RP',
      accountChannel: 'HK',
      currency: 'HKD',
      quantity: '100',
      availableQuantity: '100',
      costPrice: '2.000000000000000001',
    },
  ]);
  let monitor: ReturnType<typeof native.createMonitor> | null = null;
  let quotes: ReturnType<typeof createQuoteSubscriptionRuntime> | null = null;
  const tradeRuntime = createTradeRuntimeDouble({
    orderMonitor: {
      hasPendingProtectiveLiquidationOrders: (direction) => {
        if (monitor === null) throw new Error('native tracking owner not assembled');

        return monitor.hasPendingProtectiveLiquidationOrders(direction);
      },
    },
  });
  const f = createExecutionFixture({
    nowMs: T,
    rateLimiter,
    createRecorder: native.createRecorder,
    readPort: account,
    persistProgress: repository.appendExecutionProgressIdempotent,
    getTradeRuntime: () => tradeRuntime,
    onPositionsCommitted: async (token) => {
      if (quotes === null) throw new Error('subscription owner not assembled');

      await quotes.reconcilePositionHoldFromCurrentTruth(token);
      trace.push('position-subscription-complete');
    },
  });
  const unrealized = createUnrealizedLossChecker({
    maxUnrealizedLossPerSymbol: null,
    onMissingData: () => {},
  });
  const risk = createRiskChecker({
    warrantRiskChecker: createWarrantRiskChecker({
      onInvalidCallPrice: () => {},
      onWarrantInfoSet: () => {},
    }),
    positionLimitChecker: createPositionLimitChecker({ maxPositionNotional: null }),
    unrealizedLossChecker: {
      ...unrealized,
      publish: (prepared) => {
        unrealized.publish(prepared);
        trace.push('risk-published:' + prepared.symbol);
      },
    },
  });
  const cooldown = createLiquidationCooldownTracker();
  const stateFixtures = createRuntimeStateFixtures({
    tradingTimeState: {},
    lifecycleState: {},
    tradingCalendarState: {},
    quoteSubscriptionState: { allTradingSymbols: new Set<string>() },
  });
  const market = createMarketDataClientDouble({
    subscribeSymbols: async (symbols) => {
      if (symbols.includes('POSITION-ONLY.HK')) {
        trace.push('subscription-issued');
        subscriptionIssued.resolve(null);
        await subscriptionAck.promise;
        trace.push('subscription-ack');
      }
    },
  });
  quotes = createQuoteSubscriptionRuntime({
    logger: createLoggerDouble(),
    tradingConfig,
    symbolRegistry,
    marketDataClient: market,
    orderHoldRegistry: {
      getHoldSymbols: f.holds.getHoldSymbols,
      onOrderHoldSymbolsChanged: f.holds.onOrderHoldSymbolsChanged,
    },
    ...stateFixtures,
    snapshot: f.snapshot,
    termination: f.termination,
  });

  f.sink.bindBusinessDeps({
    monitorContext: createMonitorContextDouble({
      config,
      symbolRegistry,
      orderRecorder: f.recorder,
      dailyLossTracker: f.daily,
      riskChecker: risk,
    }),
    dailyLossTracker: f.daily,
    protectiveLiquidationEpisodeTracker: f.episode,
    liquidationCooldownTracker: cooldown,
    mixedTradeLogRepository: {
      appendCompletionIdempotent: (completion) => {
        trace.push('completion-append');
        repository.appendCompletionIdempotent(completion);
      },
    },
  });

  monitor = native.createMonitor({
    diagnostics: createDiagnosticObserverDouble(),
    logger: createLoggerDouble(),
    wait: wait,
    requestExternalApi: wrapExternalApiRequest,
    scheduleBoundedOneShotAt: scheduleBoundedOneShotAt,
    now: () => new Date(sellTime),
    scheduleTimer: setTimeout,
    clearTimer: clearTimeout,
    rateLimiter: f.rateLimiter,
    cacheManager: { clearCache: () => {}, getPendingOrders: async () => [] },
    marketDataClient: market,
    orderRecorder: f.recorder,
    dailyLossTracker: f.daily,
    orderHoldRegistry: f.holds,
    protectiveLiquidationEpisodeTracker: f.episode,
    persistProtectiveLiquidationExecutionProgress: repository.appendExecutionProgressIdempotent,
    postTradeConsistencyRuntime: f.sink,
    tradingConfig,
    symbolRegistry,
    isContinuousTradingAllowed: () => false,
    termination: f.termination,
  });
  const unsubscribeClosed = monitor.onOrderStateChanged(() => {
    closed.resolve(null);
  });
  const unsubscribeFresh = f.sink.onFreshReached(() => {
    trace.push('ready');
  });
  try {
    // 同一 O/Daily 的初始开仓事实，不以第二实例或手造 risk/ready 值代替基线。
    f.commit('LONG-BUY', 'BUY', '1', '100', 100, -1_000, 'BULL.HK', true);
    f.commit(
      'SHORT-BUY',
      'BUY',
      '2.000000000000000001',
      '200.0000000000000001',
      100,
      -900,
      'BEAR.HK',
      false,
    );
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    expect(native.subscribeObservations()).toEqual([['PRIVATE']]);
    await quotes.reconcileFromCurrentTruth();
    quotes.start();
    f.sink.start();
    const baseline = await f.sink.waitForFresh();
    expect(f.sink.isCurrent(baseline)).toBeTrue();
    expect(unrealized.getUnrealizedLossData('BULL.HK')).toEqual({ r1: '100', n1: 100 });
    expect(unrealized.getUnrealizedLossData('BEAR.HK')).toEqual({
      r1: '200.0000000000000001',
      n1: 100,
    });
    const initialReads = native.accountReadCounts();
    trace.length = 0;

    monitor.trackOrder({
      orderId: 'NATIVE-PROTECTIVE-SELL',
      symbol: 'BULL.HK',
      side: 'SELL',
      executionSide: 'SELL',
      orderType: 'LO',
      price: '0.9',
      initialSubmittedPrice: '0.9',
      quantity: 100,
      submittedAtMs: T + 100,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: true,
    });

    f.recorder.submitSellOrder(
      'NATIVE-PROTECTIVE-SELL',
      'BULL.HK',
      'LONG',
      100,
      ['LONG-BUY'],
      true,
      T + 100,
    );
    expect(monitor.hasPendingProtectiveLiquidationOrders('LONG')).toBeTrue();
    expect(f.holds.getHoldSymbols().has('BULL.HK')).toBeTrue();
    native.setStockPositions([
      {
        symbol: 'BEAR.HK',
        symbolName: 'HSI RP',
        accountChannel: 'HK',
        currency: 'HKD',
        quantity: '100',
        availableQuantity: '100',
        costPrice: '2.000000000000000001',
      },
      {
        symbol: 'POSITION-ONLY.HK',
        symbolName: 'Existing independent holding',
        accountChannel: 'HK',
        currency: 'HKD',
        quantity: '25',
        availableQuantity: '25',
        costPrice: '1',
      },
    ]);
    native.emitOrderChanged();
    await closed.promise;
    await subscriptionIssued.promise;
    const pendingReady = f.sink.waitForFresh();
    let issuedReady = false;
    void pendingReady.then(() => {
      issuedReady = true;
    });
    const committed = f.snapshot.getView();
    expect(
      f.snapshot.isCurrent(committed.token, { account: true, positions: true, paired: true }),
    ).toBeTrue();
    expect(committed.positions.some((position) => position.symbol === 'BULL.HK')).toBeFalse();
    expect(native.accountReadCounts()).toEqual({
      balance: initialReads.balance + 1,
      positions: initialReads.positions + 1,
    });
    expect(f.sink.isCurrent(baseline)).toBeFalse();
    expect(issuedReady).toBeFalse();
    expect(f.sink.getStatus().currentVersion).toBeLessThan(f.sink.getStatus().staleVersion);
    expect(
      stateFixtures.quoteSubscriptionState.allTradingSymbols.has('POSITION-ONLY.HK'),
    ).toBeFalse();
    expect(repository.loadExecutionProgressRecords(dayKey)).toHaveLength(1);
    expect(repository.loadCompletionRecords(dayKey)).toEqual([]);
    expect(f.episode.getInProgressEpisodes()).toEqual([
      { direction: 'LONG', symbol: 'BULL.HK', latestExecutedTimeMs: sellTime },
    ]);
    expect(f.daily.getLossOffset('LONG')).toBe('-10');
    expect(unrealized.getUnrealizedLossData('BULL.HK')).toEqual({ r1: '100', n1: 100 });
    expect(
      cooldown.getRemainingMs({
        direction: 'LONG',
        cooldownConfig: config.liquidationCooldown,
        currentTimeMs: sellTime,
      }),
    ).toBe(0);
    expect(monitor.getPendingSellOrders('BULL.HK')).toEqual([]);
    expect(monitor.hasPendingProtectiveLiquidationOrders('LONG')).toBeFalse();
    expect(f.recorder.getPendingSellSnapshot()).toEqual([]);
    expect(f.holds.getHoldSymbols()).toEqual(new Set());

    subscriptionAck.resolve(null);
    const ready = await pendingReady;
    expect(f.sink.isCurrent(ready)).toBeTrue();
    expect(
      stateFixtures.quoteSubscriptionState.allTradingSymbols.has('POSITION-ONLY.HK'),
    ).toBeTrue();

    expect(trace).toEqual([
      'subscription-issued',
      'subscription-ack',
      'position-subscription-complete',
      'completion-append',
      'risk-published:BULL.HK',
      'risk-published:BEAR.HK',
      'ready',
    ]);

    expect(repository.loadCompletionRecords(dayKey)).toMatchObject([
      { boundaryExecutedTimeMs: sellTime, direction: 'LONG' },
    ]);
    expect(f.episode.getInProgressEpisodes()).toEqual([]);
    expect(f.daily.getLossOffset('LONG')).toBe('0');
    expect(unrealized.getUnrealizedLossData('BULL.HK')).toEqual({ r1: '0', n1: 0 });
    expect(unrealized.getUnrealizedLossData('BEAR.HK')).toEqual({
      r1: '200.0000000000000001',
      n1: 100,
    });

    expect(
      cooldown.getRemainingMs({
        direction: 'LONG',
        cooldownConfig: config.liquidationCooldown,
        currentTimeMs: sellTime,
      }),
    ).toBe(300_000);
    expect(f.termination.getFatalState()).toEqual({ hasFatalError: false });
  } finally {
    subscriptionAck.resolve(null);
    unsubscribeClosed();
    unsubscribeFresh();
    await monitor.teardown();
    await f.sink.stopAndDrain();
    await quotes.stopAndDrain();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
