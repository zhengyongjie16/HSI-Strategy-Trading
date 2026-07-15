/**
 * createMonitorContext 业务测试
 *
 * 覆盖：
 * - 默认策略工厂按 monitor 配置构造策略实例
 * - 支持注入自定义策略工厂并按唯一 monitor 配置调用
 */
import { describe, expect, it } from 'bun:test';
import type { MonitorContextBootstrapRuntime, PreGateRuntime } from '../../../src/app/types.js';
import { createMonitorContext } from '../../../src/app/context/createMonitorContext.js';
import { parseSignalConfig } from '../../../src/config/utils.js';
import type { TradingSignalStrategyFactory } from '../../../src/core/strategy/types.js';
import { createWarrantListCache } from '../../../src/services/autoSymbolFinder/utils.js';
import type { MonitorConfig, TradingConfig } from '../../../src/types/config.js';
import type { Quote } from '../../../src/types/quote.js';
import type { MonitorState } from '../../../src/types/state.js';
import {
  createDailyLossTrackerDouble,
  createMarketDataClientDouble,
  createMonitorConfigDouble,
  createPositionCacheDouble,
  createQuoteDouble,
  createRiskCheckerDouble,
  createSdkConfigDouble,
  createSymbolRegistryDouble,
  createTraderDouble,
} from '../../helpers/testDoubles.js';

function createMonitorState(monitorSymbol: string): MonitorState {
  return {
    monitorSymbol,
    lastMonitorSnapshot: null,
    incrementalIndicatorRuntime: null,
  };
}

function requireSignalConfig(configText: string) {
  const signalConfig = parseSignalConfig(configText);
  if (signalConfig === null) {
    throw new Error(`failed to parse signal config: ${configText}`);
  }

  return signalConfig;
}

function createTradingConfig(monitor: MonitorConfig): TradingConfig {
  return {
    monitor,
    global: {
      doomsdayProtection: true,
      debug: false,
      openProtection: {
        morning: {
          enabled: true,
          minutes: 3,
        },
        afternoon: {
          enabled: true,
          minutes: 3,
        },
      },
      orderMonitorPriceUpdateInterval: 3,
      allowBuyOrderTrackingAboveInitialPrice: true,
      tradingOrderType: 'LO',
      liquidationOrderType: 'ELO',
      buyOrderTimeout: {
        enabled: true,
        timeoutSeconds: 30,
      },
      sellOrderTimeout: {
        enabled: true,
        timeoutSeconds: 30,
      },
    },
  };
}

function createRuntime(
  monitor: MonitorConfig,
  symbolRegistry = createSymbolRegistryDouble({}),
): {
  preGateRuntime: PreGateRuntime;
  postGateRuntime: MonitorContextBootstrapRuntime;
  quotesMap: ReadonlyMap<string, Quote | null>;
} {
  const monitorState = createMonitorState(monitor.monitorSymbol);

  const trader = createTraderDouble();
  const marketDataClient = createMarketDataClientDouble();

  const preGateRuntime: PreGateRuntime = {
    config: createSdkConfigDouble(),
    tradingConfig: createTradingConfig(monitor),
    symbolRegistry,
    warrantListCache: createWarrantListCache(),
    warrantListCacheConfig: {
      cache: createWarrantListCache(),
      ttlMs: 60_000,
      nowMs: () => Date.now(),
    },
    marketDataClient,
    startupTradingDayInfo: {
      dateKey: '2026-03-09',
      info: {
        isTradingDay: true,
        isHalfDay: false,
      },
    },
  };

  const postGateRuntime: MonitorContextBootstrapRuntime = {
    dailyLossTracker: createDailyLossTrackerDouble(),
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
        dateKey: '2026-03-23',
        info: {
          isTradingDay: true,
          isHalfDay: false,
        },
      },
      tradingCalendarSnapshot: new Map([['2026-03-23', { isTradingDay: true, isHalfDay: false }]]),
      monitorState,
      allTradingSymbols: new Set<string>(),
    },
    trader,
    riskChecker: createRiskCheckerDouble(),
    indicatorCache: {
      push: () => {},
      getClosest: () => null,
      clearAll: () => {},
    },
    onFatalError: (error) => {
      throw error;
    },
  };

  return {
    preGateRuntime,
    postGateRuntime,
    quotesMap: new Map<string, Quote | null>(),
  };
}

describe('createMonitorContext strategy factory behavior', () => {
  it('hydrates seat names without creating a second seat truth cache', () => {
    const monitorConfig = createMonitorConfigDouble({
      monitorSymbol: 'HSI.HK',
      signalConfig: {
        buycall: null,
        sellcall: null,
        buyput: null,
        sellput: null,
      },
      verificationConfig: {
        buy: {
          delaySeconds: 60,
          indicators: ['K'],
        },
        sell: {
          delaySeconds: 60,
          indicators: ['K'],
        },
      },
    });
    const symbolRegistry = createSymbolRegistryDouble({
      longSeat: {
        symbol: 'LONG_READY.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      shortSeat: {
        symbol: 'SHORT_READY.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      longVersion: 3,
      shortVersion: 4,
    });
    const { preGateRuntime, postGateRuntime } = createRuntime(monitorConfig, symbolRegistry);

    const context = createMonitorContext({
      preGateRuntime,
      postGateRuntime,
      quotesMap: new Map<string, Quote | null>([
        ['LONG_READY.HK', { ...createQuoteDouble('LONG_READY.HK', 1.01), name: 'LongReady' }],
        ['SHORT_READY.HK', { ...createQuoteDouble('SHORT_READY.HK', 1.02), name: 'ShortReady' }],
        ['HSI.HK', { ...createQuoteDouble('HSI.HK', 20_001), name: 'HangSeng' }],
      ]),
    });

    expect(context.longSymbolName).toBe('LongReady');
    expect(context.shortSymbolName).toBe('ShortReady');
    expect(context.monitorSymbolName).toBe('HangSeng');
    expect('seatState' in context).toBeFalse();
    expect('seatVersion' in context).toBeFalse();
  });

  it('keeps inactive seat name empty, falls back to symbol names and compiles indicatorProfile', () => {
    const monitorConfig = createMonitorConfigDouble({
      monitorSymbol: 'HSI.HK',
      signalConfig: {
        buycall: null,
        sellcall: null,
        buyput: null,
        sellput: null,
      },
      verificationConfig: {
        buy: {
          delaySeconds: 60,
          indicators: ['K'],
        },
        sell: {
          delaySeconds: 60,
          indicators: ['K'],
        },
      },
    });
    const symbolRegistry = createSymbolRegistryDouble({
      longSeat: {
        symbol: null,
        status: 'EMPTY',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      shortSeat: {
        symbol: 'SHORT_READY.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
    });
    const { preGateRuntime, postGateRuntime } = createRuntime(monitorConfig, symbolRegistry);

    const context = createMonitorContext({
      preGateRuntime,
      postGateRuntime,
      quotesMap: new Map<string, Quote | null>(),
    });

    expect(context.longSymbolName).toBe('');
    expect(context.shortSymbolName).toBe('SHORT_READY.HK');
    expect(context.monitorSymbolName).toBe('HSI.HK');
    expect(context.indicatorProfile.requiredFamilies.kdj).toBe(true);
    expect(context.indicatorProfile.requiredPeriods.ema).toEqual([]);
    expect(context.indicatorProfile.requiredPeriods.rsi).toEqual([]);
    expect(context.indicatorProfile.requiredPeriods.psy).toEqual([]);
    expect(context.indicatorProfile.displayPlan).toEqual(['price', 'changePercent', 'K', 'D', 'J']);
  });

  it('uses the default strategy factory and wires the unique monitor verification config into strategy output', () => {
    const monitorConfig = createMonitorConfigDouble({
      monitorSymbol: 'HSI.HK',
      signalConfig: {
        buycall: requireSignalConfig('(K>80)'),
        sellcall: null,
        buyput: null,
        sellput: null,
      },
      verificationConfig: {
        buy: {
          delaySeconds: 15,
          indicators: ['K'],
        },
        sell: {
          delaySeconds: 15,
          indicators: ['K'],
        },
      },
    });
    const { preGateRuntime, postGateRuntime, quotesMap } = createRuntime(monitorConfig);

    const context = createMonitorContext({
      preGateRuntime,
      postGateRuntime,
      quotesMap,
    });

    const signals = context.strategy.generateSignals(
      {
        price: 1,
        changePercent: 0,
        ema: null,
        rsi: null,
        psy: null,
        mfi: null,
        kdj: {
          k: 90,
          d: 80,
          j: 95,
        },
        macd: null,
        adx: null,
      },
      'BULL.HK',
      'BEAR.HK',
      postGateRuntime.trader.orderRecorder,
      context.indicatorProfile,
    );

    expect(signals.immediateSignals.length).toBe(0);
    expect(signals.delayedSignals.length).toBeGreaterThan(0);
  });

  it('supports injected strategy factory and passes the unique monitor config subset to the factory', () => {
    const monitorConfig = createMonitorConfigDouble({
      monitorSymbol: 'HSI.HK',
    });
    const { preGateRuntime, postGateRuntime, quotesMap } = createRuntime(monitorConfig);
    const factoryCalls: string[] = [];
    const strategyFactory: TradingSignalStrategyFactory = (strategyConfig) => {
      const buyIndicators = strategyConfig.verificationConfig.buy.indicators ?? [];
      factoryCalls.push(buyIndicators.join(','));
      return {
        generateSignals: () => ({
          immediateSignals: [
            {
              symbol: `${buyIndicators.join('|')}.INJECTED`,
              action: 'BUYCALL',
              symbolName: null,
              seatVersion: null,
              triggerTime: new Date('2026-03-23T09:30:00.000Z'),
            },
          ],
          delayedSignals: [],
        }),
      };
    };

    const context = createMonitorContext({
      preGateRuntime,
      postGateRuntime,
      quotesMap,
      strategyFactory,
    });

    expect(factoryCalls).toHaveLength(1);

    const output = context.strategy.generateSignals(
      null,
      'BULL.HK',
      'BEAR.HK',
      postGateRuntime.trader.orderRecorder,
      context.indicatorProfile,
    );

    expect(output.immediateSignals[0]?.symbol).toBe('K|MACD.INJECTED');
  });

  it('creates monitorContext as a pure returned value without mutating bootstrap runtime', () => {
    const monitorConfig = createMonitorConfigDouble({
      monitorSymbol: 'HSI.HK',
    });
    const { preGateRuntime, postGateRuntime, quotesMap } = createRuntime(monitorConfig);
    const strategyFactory: TradingSignalStrategyFactory = () => ({
      generateSignals: () => ({
        immediateSignals: [],
        delayedSignals: [],
      }),
    });

    const postGateRuntimeKeysBefore = Object.keys(postGateRuntime).sort((left, right) =>
      left.localeCompare(right),
    );

    const firstContext = createMonitorContext({
      preGateRuntime,
      postGateRuntime,
      quotesMap,
      strategyFactory,
    });

    const secondContext = createMonitorContext({
      preGateRuntime,
      postGateRuntime,
      quotesMap,
      strategyFactory,
    });

    expect(secondContext).not.toBe(firstContext);
    expect(Object.keys(postGateRuntime).sort((left, right) => left.localeCompare(right))).toEqual(
      postGateRuntimeKeysBefore,
    );
  });

  it('rejects a runtime assembled without the required trading calendar snapshot', () => {
    const monitorConfig = createMonitorConfigDouble({ monitorSymbol: 'HSI.HK' });
    const { preGateRuntime, postGateRuntime, quotesMap } = createRuntime(monitorConfig);
    Reflect.set(postGateRuntime.lastState, 'tradingCalendarSnapshot', undefined);

    expect(() =>
      createMonitorContext({
        preGateRuntime,
        postGateRuntime,
        quotesMap,
      }),
    ).toThrow('交易日历快照');
  });
});
