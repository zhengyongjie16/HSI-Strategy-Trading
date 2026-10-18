import { createDiagnosticObserverDouble } from '../helpers/diagnostics.js';
import { createRuntimeStateFixtures } from '../helpers/runtimeStateFixtures.js';

/**
 * terminal-switch-finalization 集成测试
 *
 * 职责：覆盖真实 monitor quote 与 pending-switch runtime 在终态同步收尾时的席位与结果一致性。
 */
import { describe, expect, it } from 'bun:test';

import { createBrokerIngressFixture } from './architectureRefactoringP1Native/trade/brokerIngressFixture.js';
import { createAccountPositionSnapshot } from '../../src/application/accountPositionSnapshot/index.js';
import { createPostTradeConsistencyRuntime } from '../../src/app/runtime/createPostTradeConsistencyRuntime.js';
import { createSymbolRegistry } from '../../src/domain/seat/symbolRegistry.js';
import { createSeatSwitchWorkflow } from '../../src/application/seatSwitch/index.js';
import { createStaticLiquidationExecutor } from '../../src/application/staticLiquidation/index.js';
import { createDefaultMonitorQuoteEventRuntime } from '../../src/runtime/monitorQuoteEventRuntime/monitorQuoteEventRuntime.js';
import { createSwitchWakeupRuntime } from '../../src/runtime/monitorQuoteEventRuntime/switchWakeupRuntime.js';
import { createTradingGateEventRuntime as createProductionTradingGateEventRuntime } from '../../src/runtime/tradingGateEventRuntime/index.js';

import type { AdvancePendingSwitchResult, SeatSwitchWorkflow } from '../../src/types/seatSwitch.js';
import type { QuoteUpdatedEvent } from '../../src/types/marketPorts.js';

import {
  createTerminationDouble,
  createRateLimiterDouble,
  createDailyLossTrackerDouble,
  createLiquidationCooldownTrackerDouble,
  createProtectiveLiquidationEpisodeTrackerDouble,
  createMarketDataClientDouble,
  createLoggerDouble,
  createMonitorConfigDouble,
  createMonitorContextDouble,
  createQuoteDouble,
  createRiskCheckerDouble,
  createTradeRuntimeDouble,
  createWarrantDistanceInfoDouble,
} from '../helpers/testDoubles.js';
import { createWarrantCandidateWithOverrides, createLoggerStub } from '../helpers/seatTestUtils.js';

function createTradingGateEventRuntime() {
  return createProductionTradingGateEventRuntime({ logger: createLoggerDouble() });
}

async function waitUntil(predicate: () => boolean, timeoutMs: number = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('waitUntil timeout');
    }

    await Bun.sleep(10);
  }
}

describe('terminal switch finalization integration', () => {
  it('finishes a distance switch after invalid SELL_OUT quote only when authoritative final positions are flat', async () => {
    const nowMs = Date.parse('2026-02-16T01:31:00.000Z');
    const quoteListeners = new Set<(event: QuoteUpdatedEvent) => void>();
    const monitorConfig = createMonitorConfigDouble({
      monitorSymbol: 'HSI.HK',
      autoSearchConfig: {
        autoSearchEnabled: true,
        autoSearchMinDistancePctBull: '0.35',
        autoSearchMinDistancePctBear: '-0.35',
        autoSearchMinTurnoverPerMinuteBull: '100000',
        autoSearchMinTurnoverPerMinuteBear: '100000',
        autoSearchExpiryMinMonths: 3,
        autoSearchOpenDelayMinutes: 0,
        switchIntervalMinutes: 0,
        switchDistanceRangeBull: { min: '0.2', max: '1.5' },
        switchDistanceRangeBear: { min: '-1.5', max: '-0.2' },
      },
    });
    const symbolRegistry = createSymbolRegistry(monitorConfig);
    symbolRegistry.updateSeatState('LONG', {
      symbol: 'OLD_BULL.HK',
      status: 'ACTIVE',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: nowMs - 60000,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
      callPrice: '20000',
    });
    const native = await createBrokerIngressFixture({
      orderId: 'BASELINE',
      tradeId: 'BASELINE-T',
      symbol: 'OLD_BULL.HK',
      stockName: 'OLD_BULL',
      remark: '',
      side: 'BUY',
      status: 'New',
      quantity: '100',
      executedQuantity: '0',
      submittedPrice: '1',
      executedPrice: '0',
      submittedAtMs: nowMs - 60000,
      executionTimeMs: null,
      updatedAtMs: nowMs,
    });
    native.setAccountBalance({
      currency: 'HKD',
      totalCash: '100000',
      netAssets: '100100',
      availableCash: '100000',
    });

    native.setStockPositions([
      {
        symbol: 'OLD_BULL.HK',
        symbolName: 'OLD_BULL',
        accountChannel: 'lb_papertrading',
        currency: 'HKD',
        quantity: '100',
        availableQuantity: '100',
        costPrice: '1',
      },
    ]);
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
      source: 'terminal-switch-baseline',
      dayEpoch: 1,
      refreshAccount: true,
      refreshPositions: true,
    }).result;
    if (committed.status !== 'COMMITTED') throw new Error('expected canonical baseline');

    const marketDataClient = createMarketDataClientDouble({
      getQuotes: async (symbols) =>
        new Map(
          [...symbols].map((symbol) => [
            symbol,
            createQuoteDouble(symbol, symbol === 'OLD_BULL.HK' ? '0' : '1'),
          ]),
        ),
      onQuoteUpdated: (listener) => {
        quoteListeners.add(listener);
        return () => {
          quoteListeners.delete(listener);
        };
      },
    });
    let mutationCalls = 0;
    const tradeRuntime = createTradeRuntimeDouble({
      ...account,
      orderExecutor: {
        executeSignals: async () => {
          mutationCalls += 1;
          throw new Error('invalid quote must prevent submission');
        },
      },
      cacheManager: { getPendingOrders: async () => [] },
    });
    const dailyLossTracker = createDailyLossTrackerDouble();
    const prepared = dailyLossTracker.prepareRecalculationFromAllOrders(
      [],
      monitorConfig,
      new Date(nowMs),
      undefined,
      new Set(['OLD_BULL.HK', 'NEW_BULL.HK']),
    );
    dailyLossTracker.publishRecalculation(prepared);
    const postTradeConsistencyRuntime = createPostTradeConsistencyRuntime({
      diagnostics: createDiagnosticObserverDouble(),
      clock: { now: () => new Date() },
      logger: createLoggerDouble(),
      snapshot,
      termination: createTerminationDouble(),
      getProtectiveOrderReader: () => tradeRuntime.orderMonitor,
      onPositionsCommitted: async (token) => {
        if (!snapshot.isCurrent(token, { account: false, positions: true }))
          throw new Error('stale committed token');
      },
      scheduler: { scheduleTimer: setTimeout, clearTimer: clearTimeout },
    });
    const orderRecorder = native.createRecorder({
      logger: createLoggerDouble(),
      rateLimiter: createRateLimiterDouble(),
      getExecutionTimeEvidence: dailyLossTracker.getExecutionTimeEvidence,
      settlementRefreshNeedRecorder: postTradeConsistencyRuntime,
    });
    const riskChecker = createRiskCheckerDouble({
      getWarrantDistanceInfo: (isLongSymbol) => {
        if (!isLongSymbol) {
          return null;
        }

        return createWarrantDistanceInfoDouble({
          warrantType: 'BULL',
          distanceNumerator: '0.1',
          distanceDenominator: '100',
        });
      },
    });
    const actualAutoSymbolManager = createSeatSwitchWorkflow({
      readSwitchPositions: async () => [],
      logger: createLoggerStub(),
      monitorConfig,
      symbolRegistry,
      marketDataClient,
      cacheManager: tradeRuntime.cacheManager,
      orderHoldRegistry: tradeRuntime.orderHoldRegistry,
      orderMonitor: tradeRuntime.orderMonitor,
      orderExecutor: tradeRuntime.orderExecutor,
      orderRecorder,
      riskChecker,
      candidateSearch: {
        resolveDistanceRange: (direction) =>
          monitorConfig.autoSearchConfig[
            direction === 'LONG' ? 'switchDistanceRangeBull' : 'switchDistanceRangeBear'
          ],
        findCandidate: async () =>
          createWarrantCandidateWithOverrides('NEW_BULL.HK', { callPrice: '21000' }),
      },
      clock: { now: () => new Date(nowMs) },
      getTradingCalendarSnapshot: () =>
        new Map([['2026-02-16', { isTradingDay: true, isHalfDay: false }]]),
    });
    const advanceResults: AdvancePendingSwitchResult[] = [];
    const seatSwitch: SeatSwitchWorkflow = {
      evaluatePeriodicSwitchDue: actualAutoSymbolManager.evaluatePeriodicSwitchDue,
      startSwitchOnDistance: actualAutoSymbolManager.startSwitchOnDistance,
      advancePendingSwitch: async (params) => {
        const result = await actualAutoSymbolManager.advancePendingSwitch(params);
        advanceResults.push(result);
        return result;
      },
      hasPendingSwitch: actualAutoSymbolManager.hasPendingSwitch,
      getPeriodicSwitchPendingState: actualAutoSymbolManager.getPeriodicSwitchPendingState,
      resetAllState: actualAutoSymbolManager.resetAllState,
    };
    const monitorContext = {
      ...createMonitorContextDouble({
        dailyLossTracker,
        config: monitorConfig,
        symbolRegistry,

        orderRecorder,
        riskChecker,
        longSymbolName: 'OLD_BULL.HK',
        monitorSymbolName: 'HSI.HK',
      }),
      seatSwitch: seatSwitch,
    };
    const stateFixtures = createRuntimeStateFixtures({
      tradingTimeState: { canTrade: true, isHalfDay: false },
      lifecycleState: { isTradingEnabled: true },
      tradingCalendarState: {},
      quoteSubscriptionState: {},
    });
    postTradeConsistencyRuntime.bindBusinessDeps({
      monitorContext,
      dailyLossTracker,
      liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
      protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
      mixedTradeLogRepository: {
        appendCompletionIdempotent: () => {
          throw new Error('switch is not protective completion');
        },
      },
    });
    postTradeConsistencyRuntime.start();
    expect(await postTradeConsistencyRuntime.completeRebuildBaseline()).toBeTrue();
    const receipt = await postTradeConsistencyRuntime.waitForFresh();
    expect(receipt.snapshotToken).toEqual(committed.snapshotToken);
    expect(postTradeConsistencyRuntime.isCurrent(receipt)).toBeTrue();
    const switchWakeupRuntime = createSwitchWakeupRuntime({
      logger: { error: () => {} },
      marketDataClient,
      orderMonitor: tradeRuntime.orderMonitor,
      symbolRegistry,
      monitorContext,
      ...stateFixtures,
      snapshot,
      postTradeConsistencyRuntime,
      tradingGateEventRuntime: createTradingGateEventRuntime(),
      doomsdayProtectionEnabled: false,
      now: () => new Date(nowMs),
      scheduleTimer: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimer: (handle) => {
        clearTimeout(handle);
      },
      termination: createTerminationDouble({
        reportFatalError: (error) => {
          throw error;
        },
      }),
    });
    const monitorQuoteRuntime = createDefaultMonitorQuoteEventRuntime({
      logger: { error: () => {} },
      scheduleTimer: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimer: (handle) => {
        clearTimeout(handle);
      },
      marketDataClient,
      monitorContext,
      executeStaticLiquidation: createStaticLiquidationExecutor({
        orderExecutor: tradeRuntime.orderExecutor,
        marketDataClient,
        snapshot,
        postTradeConsistencyRuntime,
        now: () => new Date(nowMs),
      }),
      ...stateFixtures,
      snapshot,
      postTradeConsistencyRuntime,
      doomsdayProtectionEnabled: false,
      now: () => new Date(nowMs),
      handoffPendingSwitch: (handoff) => {
        expect(handoff.originalDayEpoch).toBe(receipt.snapshotToken.dayEpoch);
        expect(handoff.driveResult.publishedRoute?.isCurrent()).toBeTrue();
        switchWakeupRuntime.handoffPendingSwitch(handoff);
      },
      termination: createTerminationDouble({
        reportFatalError: (error) => {
          throw error;
        },
      }),
    });

    switchWakeupRuntime.start();
    monitorQuoteRuntime.start();
    try {
      for (const listener of quoteListeners) {
        listener({
          symbol: 'HSI.HK',
          quote: createQuoteDouble('HSI.HK', '20000'),
        });
      }

      await waitUntil(() => advanceResults.length === 1);

      expect(advanceResults).toEqual([
        {
          advanced: true,
          direction: 'LONG',
          stillPending: false,
          driveResult: { kind: 'COMPLETED' },
        },
      ]);

      expect(symbolRegistry.getSeatState('LONG')).toMatchObject({
        symbol: 'NEW_BULL.HK',
        status: 'ACTIVATING',
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      });
      expect(actualAutoSymbolManager.hasPendingSwitch('LONG')).toBeFalse();
      expect(mutationCalls).toBe(0);
      expect(native.nativeMutations()).toEqual([]);
    } finally {
      await monitorQuoteRuntime.stopAndDrain();
      await switchWakeupRuntime.stopAndDrain();
      await postTradeConsistencyRuntime.stopAndDrain();
      await snapshot.requestClear({ reason: 'STOP', dayEpoch: 1 });
      expect(quoteListeners.size).toBe(0);
    }
  });
});
