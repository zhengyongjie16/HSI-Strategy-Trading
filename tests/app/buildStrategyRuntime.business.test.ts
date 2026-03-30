/**
 * buildStrategyRuntime 业务测试
 *
 * 覆盖：
 * - 单实例 strategy runtime 会按 monitorConfig 正确装配
 * - 支持注入自定义策略工厂
 */
import { describe, expect, it } from 'bun:test';
import type { MutableStrategyRuntimePostGateRuntime, PreGateRuntime } from '../../src/app/types.js';
import { buildStrategyRuntime } from '../../src/app/buildStrategyRuntime.js';
import type { TradingSignalStrategyFactory } from '../../src/core/strategy/types.js';
import { createWarrantListCache } from '../../src/services/autoSymbolFinder/utils.js';
import type { StrategyRuntimeConfig } from '../../src/types/config.js';
import type { Quote } from '../../src/types/quote.js';
import type { Signal } from '../../src/types/signal.js';
import type { StrategyState } from '../../src/types/state.js';
import { createTradingConfigFixture } from '../../mock/factories/configFactory.js';
import {
  createDailyLossTrackerDouble,
  createMarketDataClientDouble,
  createStrategyRuntimeConfigDouble,
  createPositionCacheDouble,
  createProtectiveLiquidationEpisodeTrackerDouble,
  createSdkConfigDouble,
  createSymbolRegistryDouble,
  createTraderDouble,
} from '../helpers/testDoubles.js';

function createStrategyState(baseInstrumentSymbol: string): StrategyState {
  return {
    baseInstrumentSymbol,
    monitorPrice: null,
    longPrice: null,
    shortPrice: null,
    signal: null,
    pendingSignals: [],
    monitorValues: null,
    lastMonitorSnapshot: null,
    lastCandlestickCacheVersion: null,
  };
}

function createRuntime(monitorConfig: StrategyRuntimeConfig): {
  preGateRuntime: PreGateRuntime;
  postGateRuntime: MutableStrategyRuntimePostGateRuntime;
  quotesMap: ReadonlyMap<string, Quote | null>;
} {
  const symbolRegistry = createSymbolRegistryDouble({
    baseInstrumentSymbol: monitorConfig.baseInstrumentSymbol,
  });
  const trader = createTraderDouble();

  const preGateRuntime: PreGateRuntime = {
    config: createSdkConfigDouble(),
    tradingConfig: createTradingConfigFixture({
      baseInstrument: monitorConfig.baseInstrumentSymbol,
    }),
    monitorConfig,
    symbolRegistry,
    warrantListCache: createWarrantListCache(),
    warrantListCacheConfig: {
      cache: createWarrantListCache(),
      ttlMs: 60_000,
      nowMs: () => Date.now(),
    },
    marketDataClient: createMarketDataClientDouble(),
    runMode: 'prod',
    gatePolicies: {
      startupGate: 'strict',
      runtimeGate: 'strict',
    },
    startupTradingDayInfo: {
      isTradingDay: true,
      isHalfDay: false,
    },
    startupGate: {
      wait: async () => ({
        isTradingDay: true,
        isHalfDay: false,
      }),
    },
  };

  const postGateRuntime: MutableStrategyRuntimePostGateRuntime = {
    liquidationCooldownTracker: {
      recordLiquidationTrigger: () => ({
        currentCount: 1,
        cooldownActivated: false,
      }),
      recordCooldown: () => {},
      restoreTriggerCount: () => {},
      getRemainingMs: () => 0,
      clearMidnightEligible: () => {},
      resetAllTriggerCounts: () => {},
    },
    dailyLossTracker: createDailyLossTrackerDouble(),
    protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
    monitorContext: null,
    refreshGate: {
      markStale: () => 0,
      markFresh: () => {},
      waitForFresh: async () => {},
      getStatus: () => ({
        currentVersion: 1,
        staleVersion: 1,
      }),
    },
    lastState: {
      canTrade: true,
      isHalfDay: false,
      openProtectionActive: false,
      currentDayKey: '2026-03-23',
      lifecycleState: 'ACTIVE',
      pendingOpenRebuild: false,
      targetTradingDayKey: null,
      isTradingEnabled: true,
      cachedAccount: null,
      cachedPositions: [],
      positionCache: createPositionCacheDouble(),
      cachedTradingDayInfo: {
        isTradingDay: true,
        isHalfDay: false,
      },
      monitorState: createStrategyState(monitorConfig.baseInstrumentSymbol),
      allTradingSymbols: new Set<string>(),
    },
    trader,
    tradeLogHydrator: {
      hydrate: () => new Map<'LONG' | 'SHORT', number>(),
    },
    loadTradingDayRuntimeSnapshot: async () => ({
      allOrders: [],
      quotesMap: new Map(),
    }),
    marketMonitor: {
      monitorPriceChanges: () => false,
      monitorIndicatorChanges: () => false,
    },
    doomsdayProtection: {
      shouldRejectBuy: () => false,
      executeClearance: async () => ({
        executed: false,
        signalCount: 0,
      }),
      cancelPendingBuyOrders: async () => ({
        executed: false,
        cancelRequestAcceptedCount: 0,
      }),
    },
    signalProcessor: {
      processSellSignals: ({ signals }) => signals,
      applyRiskChecks: async (signals) => signals,
      resetRiskCheckCooldown: () => {},
    },
    buyTaskQueue: {
      push: () => {},
      pop: () => null,
      isEmpty: () => true,
      removeTasks: () => 0,
      clearAll: () => 0,
      onTaskAdded: () => () => {},
    },
    sellTaskQueue: {
      push: () => {},
      pop: () => null,
      isEmpty: () => true,
      removeTasks: () => 0,
      clearAll: () => 0,
      onTaskAdded: () => () => {},
    },
    monitorTaskQueue: {
      scheduleLatest: () => {},
      pop: () => null,
      isEmpty: () => true,
      removeTasks: () => 0,
      clearAll: () => 0,
      onTaskAdded: () => () => {},
    },
  };

  return {
    preGateRuntime,
    postGateRuntime,
    quotesMap: new Map<string, Quote | null>(),
  };
}

describe('buildStrategyRuntime strategy factory behavior', () => {
  it('uses the default strategy factory for the runtime', () => {
    const monitorConfig = createStrategyRuntimeConfigDouble({
      baseInstrumentSymbol: 'HSI.HK',
    });
    const { preGateRuntime, postGateRuntime, quotesMap } = createRuntime(monitorConfig);

    buildStrategyRuntime({
      preGateRuntime,
      postGateRuntime,
      quotesMap,
    });

    const context = postGateRuntime.monitorContext;
    expect(context).toBeDefined();
    if (!context) {
      throw new Error('expected strategy runtime to be created');
    }

    const output = context.strategy.generateSignals(
      null,
      'BULL.HK',
      'BEAR.HK',
      postGateRuntime.trader.orderRecorder,
    );

    expect(context.config.baseInstrumentSymbol).toBe('HSI.HK');
    expect(context.state.baseInstrumentSymbol).toBe('HSI.HK');
    expect(output).toEqual([]);
  });

  it('supports injected strategy factory for the runtime', () => {
    const monitorConfig = createStrategyRuntimeConfigDouble({
      baseInstrumentSymbol: 'HSI.HK',
    });
    const { preGateRuntime, postGateRuntime, quotesMap } = createRuntime(monitorConfig);
    const factoryCalls: StrategyRuntimeConfig['strategyConfig'][] = [];
    const strategyFactory: TradingSignalStrategyFactory = (strategyConfig) => {
      factoryCalls.push(strategyConfig);
      return {
        generateSignals: () =>
          [
            {
              symbol: 'INJECTED.HK',
              action: 'BUYCALL',
              symbolName: null,
              seatVersion: null,
              triggerTime: new Date('2026-03-23T09:30:00.000Z'),
            },
          ] satisfies ReadonlyArray<Signal>,
      };
    };

    buildStrategyRuntime({
      preGateRuntime,
      postGateRuntime,
      quotesMap,
      strategyFactory,
    });

    expect(factoryCalls).toEqual([monitorConfig.strategyConfig]);
    const context = postGateRuntime.monitorContext;
    if (!context) {
      throw new Error('expected strategy runtime to be created');
    }

    const output = context.strategy.generateSignals(
      null,
      'BULL.HK',
      'BEAR.HK',
      postGateRuntime.trader.orderRecorder,
    );

    expect(output[0]?.symbol).toBe('INJECTED.HK');
  });
});
