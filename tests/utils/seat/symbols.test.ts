import { describe, expect, it } from 'bun:test';
import { resolveBoundSeatSymbol } from '../../../src/utils/seat/symbols.js';
import { createSymbolRegistryDouble } from '../../helpers/testDoubles.js';

describe('seat symbol helpers', () => {
  it('returns symbol only when seat has a bound symbol', () => {
    const registry = createSymbolRegistryDouble({
      longSeat: {
        symbol: 'BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
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
    });

    expect(resolveBoundSeatSymbol(registry, 'LONG')).toBe('BULL.HK');
    expect(resolveBoundSeatSymbol(registry, 'SHORT')).toBeNull();
  });
});
