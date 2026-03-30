/**
 * 席位缓存域单元测试
 *
 * 覆盖：midnightClear 调用 autoSymbolManager.resetAllState、warrantListCache.clear、
 * clearAllSeatBindings、syncMonitorSeatSnapshots；openRebuild 为空操作
 */
import { describe, it, expect } from 'bun:test';
import { createSeatDomain } from '../../../../src/main/lifecycle/cacheDomains/seatDomain.js';
import { createTradingConfigFixture } from '../../../../mock/factories/configFactory.js';
import type { SeatState, SymbolRegistry } from '../../../../src/types/seat.js';
import type { StrategyRuntime } from '../../../../src/types/state.js';
import type { WarrantListCache } from '../../../../src/services/autoSymbolFinder/types.js';

const emptySeatState = {
  symbol: null,
  status: 'EMPTY' as const,
  lastSwitchAt: null,
  lastSearchAt: null,
  lastSeatActivatedAt: null,
  searchFailCountToday: 0,
  frozenTradingDayKey: null,
};

describe('createSeatDomain', () => {
  it('midnightClear 依次调用 resetAllState、warrantListCache.clear、席位清空与同步', async () => {
    let resetAllStateCount = 0;
    let clearCount = 0;
    const longBeforeClear: SeatState = {
      symbol: 'OLD_BULL.HK',
      status: 'ACTIVE',
      lastSwitchAt: 100,
      lastSearchAt: 200,
      lastSeatActivatedAt: 300,
      callPrice: 20_000,
      searchFailCountToday: 2,
      frozenTradingDayKey: '2026-02-15',
    };
    const shortBeforeClear: SeatState = {
      symbol: 'OLD_BEAR.HK',
      status: 'ACTIVE',
      lastSwitchAt: 110,
      lastSearchAt: 210,
      lastSeatActivatedAt: 310,
      callPrice: 19_000,
      searchFailCountToday: 1,
      frozenTradingDayKey: null,
    };
    const updateCalls: Array<{
      direction: string;
      nextState: SeatState;
    }> = [];
    const bumpCalls: Array<{ direction: string }> = [];
    const monitorContext = {
      config: { baseInstrumentSymbol: 'HSI.HK' },
      seatState: { long: emptySeatState, short: emptySeatState },
      seatVersion: { long: 1, short: 1 },
      autoSymbolManager: {
        resetAllState: () => {
          resetAllStateCount += 1;
        },
      },
    } as unknown as StrategyRuntime;
    const tradingConfig = createTradingConfigFixture({
      baseInstrument: 'HSI.HK',
    });
    const monitorConfig = {
      baseInstrumentSymbol: 'HSI.HK',
    } as never;
    const symbolRegistry: SymbolRegistry = {
      getSeatState: (direction: 'LONG' | 'SHORT') => {
        return direction === 'LONG' ? longBeforeClear : shortBeforeClear;
      },
      getSeatVersion: () => 1,
      resolveSeatBySymbol: () => null,
      updateSeatState: (direction: 'LONG' | 'SHORT', nextState: SeatState) => {
        updateCalls.push({ direction, nextState });
        return nextState;
      },
      bumpSeatVersion: (direction: 'LONG' | 'SHORT') => {
        bumpCalls.push({ direction });
        return 2;
      },
    };
    const warrantListCache: WarrantListCache = {
      clear: () => {
        clearCount += 1;
      },
    } as unknown as WarrantListCache;

    const domain = createSeatDomain({
      tradingConfig,
      monitorConfig,
      symbolRegistry,
      monitorContext,
      warrantListCache,
    });

    await domain.midnightClear({
      now: new Date(),
      runtime: { dayKey: '2025-02-15', canTradeNow: true, isTradingDay: true },
    });

    expect(resetAllStateCount).toBe(1);
    expect(clearCount).toBe(1);
    expect(updateCalls).toHaveLength(2);
    expect(
      updateCalls.map((c) => c.direction).sort((left, right) => left.localeCompare(right, 'en')),
    ).toEqual(['LONG', 'SHORT']);
    const longAfterClear = updateCalls.find((item) => item.direction === 'LONG')?.nextState;
    const shortAfterClear = updateCalls.find((item) => item.direction === 'SHORT')?.nextState;
    expect(longAfterClear?.status).toBe('EMPTY');
    expect(longAfterClear?.symbol).toBeNull();
    expect(longAfterClear?.lastSwitchAt).toBe(100);
    expect(longAfterClear?.lastSearchAt).toBe(200);
    expect(longAfterClear?.lastSeatActivatedAt).toBeNull();
    expect(shortAfterClear?.status).toBe('EMPTY');
    expect(shortAfterClear?.symbol).toBeNull();
    expect(shortAfterClear?.lastSwitchAt).toBe(110);
    expect(shortAfterClear?.lastSearchAt).toBe(210);
    expect(shortAfterClear?.lastSeatActivatedAt).toBeNull();
    expect(bumpCalls).toHaveLength(2);
  });

  it('openRebuild 为空操作，不抛错', async () => {
    const tradingConfig = createTradingConfigFixture({
      baseInstrument: 'HSI.HK',
    });
    const monitorConfig = {
      baseInstrumentSymbol: 'HSI.HK',
    } as never;
    const symbolRegistry = {
      getSeatState: () => emptySeatState,
      getSeatVersion: () => 0,
      updateSeatState: () => emptySeatState,
      bumpSeatVersion: () => 0,
    } as unknown as SymbolRegistry;
    const warrantListCache = { clear: () => {} } as unknown as WarrantListCache;

    const domain = createSeatDomain({
      tradingConfig,
      monitorConfig,
      symbolRegistry,
      monitorContext: {
        config: { baseInstrumentSymbol: 'HSI.HK' },
        seatState: { long: emptySeatState, short: emptySeatState },
        seatVersion: { long: 0, short: 0 },
        autoSymbolManager: { resetAllState: () => {} },
      } as unknown as StrategyRuntime,
      warrantListCache,
    });
    await domain.openRebuild({
      now: new Date(),
      runtime: { dayKey: '2025-02-15', canTradeNow: true, isTradingDay: true },
    });
  });
});
