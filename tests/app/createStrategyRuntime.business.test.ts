/**
 * createStrategyRuntime 业务测试
 *
 * 功能：
 * - 验证单实例上下文会同步席位、名称缓存与最小指标画像
 */
import { describe, expect, it } from 'bun:test';
import { createStrategyRuntime } from '../../src/app/createStrategyRuntime.js';
import type { StrategyState } from '../../src/types/state.js';
import {
  createAutoSymbolManagerDouble,
  createDailyLossTrackerDouble,
  createStrategyRuntimeConfigDouble,
  createOrderRecorderDouble,
  createQuoteDouble,
  createRiskCheckerDouble,
  createStrategyDouble,
  createSymbolRegistryDouble,
  createUnrealizedLossMonitorDouble,
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
    displayPlan: ['price', 'changePercent'],
  };
}

describe('strategy runtime business flow', () => {
  it('hydrates ready seats, quote names and the trend indicator profile into context', () => {
    const config = createStrategyRuntimeConfigDouble({
      baseInstrumentSymbol: 'HSI.HK',
    });
    const symbolRegistry = createSymbolRegistryDouble({
      baseInstrumentSymbol: 'HSI.HK',
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

    const context = createStrategyRuntime({
      config,
      state: createStrategyState(config.baseInstrumentSymbol),
      symbolRegistry,
      quotesMap: new Map([
        ['LONG_READY.HK', { ...createQuoteDouble('LONG_READY.HK', 1.01), name: 'LongReady' }],
        ['SHORT_READY.HK', { ...createQuoteDouble('SHORT_READY.HK', 1.02), name: 'ShortReady' }],
        ['HSI.HK', { ...createQuoteDouble('HSI.HK', 20_001), name: 'Base Instrument' }],
      ]),
      strategy: createStrategyDouble(),
      orderRecorder: createOrderRecorderDouble(),
      dailyLossTracker: createDailyLossTrackerDouble(),
      riskChecker: createRiskCheckerDouble(),
      unrealizedLossMonitor: createUnrealizedLossMonitorDouble(),
      autoSymbolManager: createAutoSymbolManagerDouble(),
    });

    expect(context.longSymbolName).toBe('LongReady');
    expect(context.shortSymbolName).toBe('ShortReady');
    expect(context.baseInstrumentName).toBe('Base Instrument');
    expect(context.seatVersion.long).toBe(3);
    expect(context.seatVersion.short).toBe(4);
    expect(context.state.displayPlan).toEqual(['price', 'changePercent']);
    expect(context.indicatorProfile.displayPlan).toEqual(['price', 'changePercent']);
  });

  it('keeps quote/name empty when seat is not ACTIVE', () => {
    const config = createStrategyRuntimeConfigDouble({
      baseInstrumentSymbol: 'HSI.HK',
    });
    const symbolRegistry = createSymbolRegistryDouble({
      baseInstrumentSymbol: 'HSI.HK',
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

    const context = createStrategyRuntime({
      config,
      state: createStrategyState(config.baseInstrumentSymbol),
      symbolRegistry,
      quotesMap: new Map([
        ['SHORT_READY.HK', { ...createQuoteDouble('SHORT_READY.HK', 1.02), name: 'ShortReady' }],
        ['HSI.HK', { ...createQuoteDouble('HSI.HK', 20_001), name: 'Base Instrument' }],
      ]),
      strategy: createStrategyDouble(),
      orderRecorder: createOrderRecorderDouble(),
      dailyLossTracker: createDailyLossTrackerDouble(),
      riskChecker: createRiskCheckerDouble(),
      unrealizedLossMonitor: createUnrealizedLossMonitorDouble(),
      autoSymbolManager: createAutoSymbolManagerDouble(),
    });

    expect(context.longSymbolName).toBe('');
    expect(context.shortSymbolName).toBe('ShortReady');
  });
});
