/**
 * 席位缓存域单元测试
 *
 * 覆盖：midnightClear 调用 autoSymbolManager.resetAllState、warrantListCache.clear、
 * clearAllSeatBindings；openRebuild 为空操作
 */
import { describe, it, expect } from 'bun:test';
import { createSeatDomain } from '../../../../src/main/lifecycle/cacheDomains/seatDomain.js';
import {
  clearSeatActivationCarryover,
  resolveSeatActivationCarryover,
} from '../../../../src/main/lifecycle/seatActivationCarryover.js';
import type { SeatState, SymbolRegistry } from '../../../../src/types/seat.js';
import { createLoggerDouble, createSymbolRegistryDouble } from '../../../helpers/testDoubles.js';

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
  it('midnightClear 依次调用 resetAllState、warrantListCache.clear 与席位清空', async () => {
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
    const atomicUpdateCalls: Array<{
      direction: string;
      nextState: SeatState;
    }> = [];
    const autoSymbolManager = {
      resetAllState: () => {
        resetAllStateCount += 1;
      },
    };
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
      updateSeatStateWithVersionBump: (direction: 'LONG' | 'SHORT', nextState: SeatState) => {
        atomicUpdateCalls.push({ direction, nextState });
        return { seatState: nextState, seatVersion: 2 };
      },
      onSeatStateChanged: () => () => {},
      onSeatTruthChanged: () => {
        throw new Error('seatDomain test must not subscribe to seat truth events');
      },
    };
    const warrantListCache = {
      clear: () => {
        clearCount += 1;
      },
    };

    const domain = createSeatDomain({
      logger: createLoggerDouble(),
      symbolRegistry,
      autoSymbolManager,
      warrantListCache,
    });

    await domain.midnightClear({
      now: new Date(),
      runtime: { dayKey: '2025-02-15', canTradeNow: true, isTradingDay: true },
    });

    expect(resetAllStateCount).toBe(1);
    expect(clearCount).toBe(1);
    expect(updateCalls).toHaveLength(0);
    expect(atomicUpdateCalls).toHaveLength(2);
    expect(
      atomicUpdateCalls
        .map((c) => c.direction)
        .sort((left, right) => left.localeCompare(right, 'en')),
    ).toEqual(['LONG', 'SHORT']);
    const longAfterClear = atomicUpdateCalls.find((item) => item.direction === 'LONG')?.nextState;
    const shortAfterClear = atomicUpdateCalls.find((item) => item.direction === 'SHORT')?.nextState;
    expect(longAfterClear?.status).toBe('EMPTY');
    expect(longAfterClear?.symbol).toBeNull();
    expect(longAfterClear?.lastSwitchAt).toBe(100);
    expect(longAfterClear?.lastSearchAt).toBe(200);
    expect(longAfterClear?.lastSeatActivatedAt).toBeNull();
    expect(
      resolveSeatActivationCarryover({
        symbolRegistry,
        direction: 'LONG',
        symbol: 'OLD_BULL.HK',
      }),
    ).toBe(300);
    expect(shortAfterClear?.status).toBe('EMPTY');
    expect(shortAfterClear?.symbol).toBeNull();
    expect(shortAfterClear?.lastSwitchAt).toBe(110);
    expect(shortAfterClear?.lastSearchAt).toBe(210);
    expect(shortAfterClear?.lastSeatActivatedAt).toBeNull();
    expect(
      resolveSeatActivationCarryover({
        symbolRegistry,
        direction: 'SHORT',
        symbol: 'OLD_BEAR.HK',
      }),
    ).toBe(310);
    clearSeatActivationCarryover(symbolRegistry);
  });

  it('跨非交易日再次 midnightClear 时保留已保存的 activation carryover，直到后续 open rebuild 消费', async () => {
    let longSeatState: SeatState = {
      symbol: 'OLD_BULL.HK',
      status: 'ACTIVE',
      lastSwitchAt: 100,
      lastSearchAt: 200,
      lastSeatActivatedAt: 300,
      callPrice: 20_000,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    };
    let shortSeatState: SeatState = {
      ...emptySeatState,
      symbol: 'OLD_BEAR.HK',
      status: 'ACTIVE',
      lastSeatActivatedAt: 310,
    };
    const autoSymbolManager = { resetAllState: () => {} };
    const symbolRegistry: SymbolRegistry = {
      getSeatState: (direction: 'LONG' | 'SHORT') => {
        return direction === 'LONG' ? longSeatState : shortSeatState;
      },
      getSeatVersion: () => 1,
      resolveSeatBySymbol: () => null,
      updateSeatState: (direction, nextState) => {
        if (direction === 'LONG') {
          longSeatState = nextState;
        } else {
          shortSeatState = nextState;
        }

        return nextState;
      },
      updateSeatStateWithVersionBump: (direction, nextState) => {
        if (direction === 'LONG') {
          longSeatState = nextState;
        } else {
          shortSeatState = nextState;
        }

        return { seatState: nextState, seatVersion: 2 };
      },
      onSeatStateChanged: () => () => {},
      onSeatTruthChanged: () => () => {},
    };
    const warrantListCache = { clear: () => {} };
    const domain = createSeatDomain({
      logger: createLoggerDouble(),
      symbolRegistry,
      autoSymbolManager,
      warrantListCache,
    });

    await domain.midnightClear({
      now: new Date('2026-02-21T00:00:00.000+08:00'),
      runtime: { dayKey: '2026-02-21', canTradeNow: false, isTradingDay: false },
    });

    expect(
      resolveSeatActivationCarryover({
        symbolRegistry,
        direction: 'LONG',
        symbol: 'OLD_BULL.HK',
      }),
    ).toBe(300);

    await domain.midnightClear({
      now: new Date('2026-02-22T00:00:00.000+08:00'),
      runtime: { dayKey: '2026-02-22', canTradeNow: false, isTradingDay: false },
    });

    expect(
      resolveSeatActivationCarryover({
        symbolRegistry,
        direction: 'LONG',
        symbol: 'OLD_BULL.HK',
      }),
    ).toBe(300);
    clearSeatActivationCarryover(symbolRegistry);
  });

  it('跨失败交易日再次 midnightClear 时会失效旧 activation carryover', async () => {
    const longSeatState: SeatState = {
      symbol: 'OLD_BULL.HK',
      status: 'ACTIVE',
      lastSwitchAt: 100,
      lastSearchAt: 200,
      lastSeatActivatedAt: 300,
      callPrice: 20_000,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    };
    const shortSeatState: SeatState = {
      ...emptySeatState,
      symbol: 'OLD_BEAR.HK',
      status: 'ACTIVE',
      lastSeatActivatedAt: 310,
    };
    const autoSymbolManager = { resetAllState: () => {} };
    const symbolRegistry: SymbolRegistry = {
      getSeatState: (direction: 'LONG' | 'SHORT') => {
        return direction === 'LONG' ? longSeatState : shortSeatState;
      },
      getSeatVersion: () => 1,
      resolveSeatBySymbol: () => null,
      updateSeatState: (_direction, nextState) => nextState,
      updateSeatStateWithVersionBump: (_direction, nextState) => {
        return { seatState: nextState, seatVersion: 2 };
      },
      onSeatStateChanged: () => () => {},
      onSeatTruthChanged: () => () => {},
    };
    const warrantListCache = { clear: () => {} };
    const domain = createSeatDomain({
      logger: createLoggerDouble(),
      symbolRegistry,
      autoSymbolManager,
      warrantListCache,
    });

    await domain.midnightClear({
      now: new Date('2026-02-21T00:00:00.000+08:00'),
      runtime: { dayKey: '2026-02-21', canTradeNow: false, isTradingDay: false },
    });

    expect(
      resolveSeatActivationCarryover({
        symbolRegistry,
        direction: 'LONG',
        symbol: 'OLD_BULL.HK',
      }),
    ).toBe(300);

    await domain.midnightClear({
      now: new Date('2026-02-24T00:00:00.000+08:00'),
      runtime: { dayKey: '2026-02-24', canTradeNow: false, isTradingDay: true },
      invalidateSeatActivationCarryover: true,
    });

    expect(
      resolveSeatActivationCarryover({
        symbolRegistry,
        direction: 'LONG',
        symbol: 'OLD_BULL.HK',
      }),
    ).toBeNull();
    clearSeatActivationCarryover(symbolRegistry);
  });

  it('openRebuild 为空操作，不抛错', async () => {
    const autoSymbolManager = { resetAllState: () => {} };
    const symbolRegistry = createSymbolRegistryDouble();
    const warrantListCache = { clear: () => {} };

    const domain = createSeatDomain({
      logger: createLoggerDouble(),
      symbolRegistry,
      autoSymbolManager,
      warrantListCache,
    });
    await domain.openRebuild({
      now: new Date(),
      runtime: { dayKey: '2025-02-15', canTradeNow: true, isTradingDay: true },
    });
  });
});
