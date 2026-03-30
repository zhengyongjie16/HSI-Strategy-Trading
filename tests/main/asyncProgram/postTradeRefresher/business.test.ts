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

    await Bun.sleep(60);
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

  it('retries failed refresh and eventually updates caches', async () => {
    const refreshGate = createRefreshGate();
    refreshGate.markStale();
    const lastState = createLastState();
    let accountCalls = 0;

    const trader = createTraderDouble({
      getAccountSnapshot: async () => {
        accountCalls += 1;
        if (accountCalls === 1) {
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
      monitorContext: createStrategyRuntimeDouble(),
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
      quotesMap: new Map([['BULL.HK', createQuoteDouble('BULL.HK', 1.05)]]),
    });

    await Bun.sleep(1300);
    await refresher.stopAndDrain();

    expect(accountCalls).toBeGreaterThanOrEqual(2);
    expect(lastState.cachedAccount?.buyPower).toBe(66_000);
    expect(lastState.positionCache.get('BULL.HK')?.quantity).toBe(300);
  });
});
