/**
 * postTradeRefresher 业务测试
 *
 * 覆盖：
 * - 成交后刷新账户/持仓/浮亏缓存
 * - 失败重试后最终将 refreshGate 标记 fresh
 */
import { describe, expect, it } from 'bun:test';
import { createPostTradeRefresher } from '../../../../src/main/asyncProgram/postTradeRefresher/index.js';
import { createRefreshGate } from '../../../../src/utils/refreshGate/index.js';
import type { LastState } from '../../../../src/types/state.js';
import { waitUntil } from '../utils.js';
import {
  createAccountSnapshotDouble,
  createDailyLossTrackerDouble,
  createLiquidationCooldownTrackerDouble,
  createPositionCacheDouble,
  createPositionDouble,
  createProtectiveLiquidationEpisodeTrackerDouble,
  createQuoteDouble,
  createRiskCheckerDouble,
  createStrategyRuntimeDouble,
  createStrategyRuntimeConfigDouble,
  createSymbolRegistryDouble,
  createTraderDouble,
} from '../../../helpers/testDoubles.js';

function createLastState(): LastState {
  return {
    canTrade: true,
    isHalfDay: false,
    openProtectionActive: false,
    currentDayKey: '2026-02-16',
    lifecycleState: 'ACTIVE',
    pendingOpenRebuild: false,
    targetTradingDayKey: null,
    isTradingEnabled: true,
    cachedAccount: null,
    cachedPositions: [],
    positionCache: createPositionCacheDouble(),
    cachedTradingDayInfo: null,
    monitorState: {
      baseInstrumentSymbol: 'HSI.HK',
      monitorPrice: null,
      longPrice: null,
      shortPrice: null,
      signal: null,
      pendingSignals: [],
      lastMonitorSnapshot: null,
      lastCandlestickCacheVersion: null,
      lastDisplaySignature: null,
      displayPlan: ['price', 'changePercent'],
    },
    allTradingSymbols: new Set<string>(),
  };
}

type Deferred = {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
};

function createDeferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve;
  });

  return {
    promise,
    resolve,
  };
}

describe('postTradeRefresher business flow', () => {
  it('refreshes account positions and unrealized-loss cache, then marks gate fresh', async () => {
    const refreshGate = createRefreshGate();
    const staleVersion = refreshGate.markStale();
    const lastState = createLastState();
    const riskRefreshCalls: Array<{ readonly symbol: string; readonly isLongSymbol: boolean }> = [];
    let displayCalls = 0;

    const monitorContext = createStrategyRuntimeDouble({
      config: createStrategyRuntimeConfigDouble({
        baseInstrumentSymbol: 'HSI.HK',
      }),
      symbolRegistry: createSymbolRegistryDouble({
        baseInstrumentSymbol: 'HSI.HK',
        longSeat: {
          symbol: 'BULL.HK',
          status: 'ACTIVE',
          lastSwitchAt: null,
          lastSearchAt: null,
          lastSeatActivatedAt: null,
          callPrice: null,
          searchFailCountToday: 0,
          frozenTradingDayKey: null,
        },
      }),
      longSymbolName: 'BULL',
      riskChecker: createRiskCheckerDouble({
        refreshUnrealizedLossData: async (symbol, _position, isLongSymbol) => {
          riskRefreshCalls.push({ symbol, isLongSymbol });
          return { r1: 100, n1: 10 };
        },
      }),
    });
    const trader = createTraderDouble({
      getAccountSnapshot: async () => createAccountSnapshotDouble(80_000),
      getStockPositions: async () => [
        createPositionDouble({
          symbol: 'BULL.HK',
          quantity: 500,
          availableQuantity: 500,
        }),
      ],
    });

    const refresher = createPostTradeRefresher({
      refreshGate,
      trader,
      lastState,
      monitorContext,
      dailyLossTracker: createDailyLossTrackerDouble(),
      liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
      protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
      displayAccountAndPositions: async () => {
        displayCalls += 1;
      },
    });

    refresher.enqueue({
      pending: [
        {
          symbol: 'BULL.HK',
          isLongSymbol: true,
          refreshAccount: true,
          refreshPositions: true,
        },
      ],
      quotesMap: new Map([['BULL.HK', createQuoteDouble('BULL.HK', 1.1)]]),
    });

    await waitUntil(() => displayCalls === 1);
    await refresher.stopAndDrain();

    expect(lastState.cachedAccount?.buyPower).toBe(80_000);
    expect(lastState.cachedPositions).toHaveLength(1);
    expect(lastState.positionCache.get('BULL.HK')?.quantity).toBe(500);
    expect(riskRefreshCalls).toEqual([{ symbol: 'BULL.HK', isLongSymbol: true }]);
    expect(displayCalls).toBe(1);
    expect(refreshGate.getStatus()).toEqual({
      currentVersion: staleVersion,
      staleVersion,
    });
  });

  it('merges refresh backlog after a temporary account failure and eventually updates caches', async () => {
    const refreshGate = createRefreshGate();
    refreshGate.markStale();
    const lastState = createLastState();
    const refreshedSymbols: string[] = [];
    let accountCalls = 0;
    const firstAttemptStarted = createDeferred();
    const allowFirstAttemptToFail = createDeferred();

    const trader = createTraderDouble({
      getAccountSnapshot: async () => {
        accountCalls += 1;
        if (accountCalls === 1) {
          firstAttemptStarted.resolve();
          await allowFirstAttemptToFail.promise;
          throw new Error('account temporary unavailable');
        }

        return createAccountSnapshotDouble(66_000);
      },
      getStockPositions: async () => [
        createPositionDouble({
          symbol: 'BULL.HK',
          quantity: 300,
          availableQuantity: 300,
        }),
      ],
    });

    const refresher = createPostTradeRefresher({
      refreshGate,
      trader,
      lastState,
      monitorContext: createStrategyRuntimeDouble({
        config: createStrategyRuntimeConfigDouble({
          baseInstrumentSymbol: 'HSI.HK',
        }),
        symbolRegistry: createSymbolRegistryDouble({
          baseInstrumentSymbol: 'HSI.HK',
          longSeat: {
            symbol: 'BULL.HK',
            status: 'ACTIVE',
            lastSwitchAt: null,
            lastSearchAt: null,
            lastSeatActivatedAt: null,
            callPrice: null,
            searchFailCountToday: 0,
            frozenTradingDayKey: null,
          },
        }),
        longSymbolName: 'BULL',
        shortSymbolName: 'BEAR',
        riskChecker: createRiskCheckerDouble({
          refreshUnrealizedLossData: async (symbol) => {
            refreshedSymbols.push(symbol);
            return { r1: 100, n1: 300 };
          },
        }),
      }),
      dailyLossTracker: createDailyLossTrackerDouble(),
      liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
      protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
      displayAccountAndPositions: async () => {},
    });

    refresher.enqueue({
      pending: [
        {
          symbol: 'BULL.HK',
          isLongSymbol: true,
          refreshAccount: true,
          refreshPositions: true,
        },
      ],
      quotesMap: new Map([['BULL.HK', createQuoteDouble('BULL.HK', 1.02)]]),
    });

    await firstAttemptStarted.promise;
    refresher.enqueue({
      pending: [
        {
          symbol: 'BULL.HK',
          isLongSymbol: true,
          refreshAccount: true,
          refreshPositions: true,
        },
      ],
      quotesMap: new Map([['BULL.HK', createQuoteDouble('BULL.HK', 1.03)]]),
    });
    allowFirstAttemptToFail.resolve();

    await waitUntil(() => accountCalls >= 2 && lastState.cachedAccount?.buyPower === 66_000, 1200);
    await refresher.stopAndDrain();

    expect(accountCalls).toBe(2);
    expect(lastState.cachedAccount?.buyPower).toBe(66_000);
    expect(lastState.positionCache.get('BULL.HK')?.quantity).toBe(300);
    expect(refreshedSymbols).toContain('BULL.HK');
  });
});
