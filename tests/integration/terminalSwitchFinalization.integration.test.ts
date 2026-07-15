/**
 * terminal-switch-finalization 集成测试
 *
 * 职责：覆盖真实 monitor quote 与 pending-switch runtime 在终态同步收尾时的席位与结果一致性。
 */
import { describe, expect, it } from 'bun:test';

import { createAutoSymbolManager } from '../../src/services/autoSymbolManager/index.js';
import { createDefaultMonitorQuoteEventRuntime } from '../../src/main/monitorQuoteEventRuntime/monitorQuoteEventRuntime.js';
import { createSwitchWakeupRuntime } from '../../src/main/monitorQuoteEventRuntime/switchWakeupRuntime.js';
import { createTradingGateEventRuntime } from '../../src/main/tradingGateEventRuntime/index.js';

import type {
  AdvancePendingSwitchResult,
  AutoSymbolManagerPort,
} from '../../src/types/monitorContextPorts.js';
import type { QuoteUpdatedEvent } from '../../src/types/services.js';

import {
  createMarketDataClientDouble,
  createMonitorConfigDouble,
  createMonitorContextDouble,
  createOrderRecorderDouble,
  createPositionCacheDouble,
  createPositionDouble,
  createQuoteDouble,
  createRiskCheckerDouble,
  createSymbolRegistryDouble,
  createTraderDouble,
  createWarrantDistanceInfoDouble,
} from '../helpers/testDoubles.js';
import { createWarrantCandidateWithOverrides } from '../services/autoSymbolManager/utils.js';

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
  it('clears a distance switch after SELL_OUT receives an invalid quote through the real runtime', async () => {
    const nowMs = Date.parse('2026-02-16T01:31:00.000Z');
    const quoteListeners = new Set<(event: QuoteUpdatedEvent) => void>();
    const monitorConfig = createMonitorConfigDouble({
      monitorSymbol: 'HSI.HK',
      autoSearchConfig: {
        autoSearchEnabled: true,
        autoSearchMinDistancePctBull: 0.35,
        autoSearchMinDistancePctBear: -0.35,
        autoSearchMinTurnoverPerMinuteBull: 100_000,
        autoSearchMinTurnoverPerMinuteBear: 100_000,
        autoSearchExpiryMinMonths: 3,
        autoSearchOpenDelayMinutes: 0,
        switchIntervalMinutes: 0,
        switchDistanceRangeBull: { min: 0.2, max: 1.5 },
        switchDistanceRangeBear: { min: -1.5, max: -0.2 },
      },
    });
    const symbolRegistry = createSymbolRegistryDouble({
      longSeat: {
        symbol: 'OLD_BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: nowMs - 60_000,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      shortSeat: {
        symbol: null,
        status: 'EMPTY',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      longVersion: 1,
      shortVersion: 1,
    });
    const marketDataClient = createMarketDataClientDouble({
      getQuotes: async (symbols) =>
        new Map(
          [...symbols].map((symbol) => [
            symbol,
            createQuoteDouble(symbol, symbol === 'OLD_BULL.HK' ? 0 : 1),
          ]),
        ),
      onQuoteUpdated: (listener) => {
        quoteListeners.add(listener);
        return () => {
          quoteListeners.delete(listener);
        };
      },
    });
    const trader = createTraderDouble({
      getPendingOrders: async () => [],
    });
    const orderRecorder = createOrderRecorderDouble({
      getBuyOrdersForSymbol: () => [],
    });
    const riskChecker = createRiskCheckerDouble({
      getWarrantDistanceInfo: (isLongSymbol) => {
        if (!isLongSymbol) {
          return null;
        }

        return createWarrantDistanceInfoDouble({
          warrantType: 'BULL',
          distanceToStrikePercent: 0.1,
        });
      },
    });
    const actualAutoSymbolManager = createAutoSymbolManager({
      monitorConfig,
      symbolRegistry,
      marketDataClient,
      trader,
      orderRecorder,
      riskChecker,
      findBestWarrant: async () =>
        createWarrantCandidateWithOverrides('NEW_BULL.HK', { callPrice: 21_000 }),
      now: () => new Date(nowMs),
      getTradingCalendarSnapshot: () =>
        new Map([['2026-02-16', { isTradingDay: true, isHalfDay: false }]]),
    });
    const advanceResults: AdvancePendingSwitchResult[] = [];
    const autoSymbolManager: AutoSymbolManagerPort = {
      maybeSearchOnEvent: actualAutoSymbolManager.maybeSearchOnEvent,
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
    const monitorContext = createMonitorContextDouble({
      config: monitorConfig,
      symbolRegistry,
      autoSymbolManager,
      orderRecorder,
      riskChecker,
      longSymbolName: 'OLD_BULL.HK',
      monitorSymbolName: 'HSI.HK',
    });
    const lastState = {
      positionCache: createPositionCacheDouble(),
      cachedPositions: [
        createPositionDouble({
          symbol: 'OLD_BULL.HK',
          quantity: 100,
          availableQuantity: 100,
        }),
      ],
      isTradingEnabled: true,
      canTrade: true,
      isHalfDay: false,
    };
    const postTradeConsistencyRuntime = {
      waitForFresh: async () => {},
      getStatus: () => ({ started: true, currentVersion: 0, staleVersion: 0 }),
      onFreshReached: () => () => {},
    };
    const switchWakeupRuntime = createSwitchWakeupRuntime({
      marketDataClient,
      trader,
      symbolRegistry,
      monitorContext,
      lastState,
      postTradeConsistencyRuntime,
      tradingGateEventRuntime: createTradingGateEventRuntime(),
      doomsdayProtectionEnabled: false,
      now: () => new Date(nowMs),
      scheduleTimer: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimer: (handle) => {
        clearTimeout(handle);
      },
    });
    const monitorQuoteRuntime = createDefaultMonitorQuoteEventRuntime({
      marketDataClient,
      monitorContext,
      trader,
      lastState,
      postTradeConsistencyRuntime,
      doomsdayProtectionEnabled: false,
      now: () => new Date(nowMs),
      handoffPendingSwitch: switchWakeupRuntime.handoffPendingSwitch,
    });

    switchWakeupRuntime.start();
    monitorQuoteRuntime.start();
    try {
      for (const listener of quoteListeners) {
        listener({
          symbol: 'HSI.HK',
          quote: createQuoteDouble('HSI.HK', 20_000),
        });
      }

      await waitUntil(() => advanceResults.length === 1);

      expect(advanceResults).toEqual([
        {
          advanced: true,
          direction: 'LONG',
          stillPending: false,
          driveResult: { kind: 'FAILED', reason: 'INVALID_QUOTE:SELL_OUT' },
        },
      ]);

      expect(symbolRegistry.getSeatState('LONG')).toMatchObject({
        symbol: null,
        status: 'EMPTY',
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      });
      expect(actualAutoSymbolManager.hasPendingSwitch('LONG')).toBeFalse();
    } finally {
      await monitorQuoteRuntime.stopAndDrain();
      await switchWakeupRuntime.stopAndDrain();
    }
  });
});
