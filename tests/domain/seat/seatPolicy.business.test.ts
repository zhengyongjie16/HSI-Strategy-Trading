/** 席位纯校验规则业务测试：ACTIVE/方向/版本/标的一致性与失败描述。 */
import { describe, expect, it } from 'bun:test';
import {
  describeSignalSeatValidationFailure,
  hasSeatSymbol,
  isSeatActive,
  resolveBoundSeatSymbol,
  validateSignalSeat,
} from '../../../src/domain/seat/seatPolicy.js';
import { createSignalDouble, createSymbolRegistryDouble } from '../../helpers/testDoubles.js';

describe('seatPolicy signal identity', () => {
  it('accepts signal when current seat version and symbol both match', () => {
    const symbolRegistry = createSymbolRegistryDouble({
      longSeat: {
        symbol: 'BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      longVersion: 2,
    });
    let signal = createSignalDouble('BUYCALL', 'BULL.HK');
    signal = { ...signal, seatVersion: 2 };

    const result = validateSignalSeat({
      signal,
      symbolRegistry,
    });

    expect(result.valid).toBe(true);
  });

  it('reports seat-unavailable reason when seat is not ready', () => {
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
    });
    let signal = createSignalDouble('BUYCALL', 'BULL.HK');
    signal = { ...signal, seatVersion: 1 };

    const result = validateSignalSeat({
      signal,
      symbolRegistry,
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('SEAT_UNAVAILABLE');
      expect(describeSignalSeatValidationFailure(result)).toBe('席位为空');
    }
  });

  it('reports version mismatch before symbol mismatch', () => {
    const symbolRegistry = createSymbolRegistryDouble({
      shortSeat: {
        symbol: 'BEAR_NEW.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      shortVersion: 5,
    });
    let signal = createSignalDouble('BUYPUT', 'BEAR_OLD.HK');
    signal = { ...signal, seatVersion: 4 };

    const versionMismatch = validateSignalSeat({
      signal,
      symbolRegistry,
    });

    expect(versionMismatch.valid).toBe(false);
    if (!versionMismatch.valid) {
      expect(versionMismatch.reason).toBe('SEAT_VERSION_MISMATCH');
      expect(describeSignalSeatValidationFailure(versionMismatch)).toBe('席位版本不匹配');
    }

    signal = { ...signal, seatVersion: 5 };
    const symbolMismatch = validateSignalSeat({
      signal,
      symbolRegistry,
    });

    expect(symbolMismatch.valid).toBe(false);
    if (!symbolMismatch.valid) {
      expect(symbolMismatch.reason).toBe('SEAT_SYMBOL_MISMATCH');
      expect(describeSignalSeatValidationFailure(symbolMismatch)).toBe('标的已切换');
    }
  });

  it('rejects HOLD signal without throwing', () => {
    const symbolRegistry = createSymbolRegistryDouble({
      longSeat: {
        symbol: 'BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      longVersion: 2,
    });
    let signal = createSignalDouble('HOLD', 'BULL.HK');
    signal = { ...signal, seatVersion: 2 };

    const result = validateSignalSeat({
      signal,
      symbolRegistry,
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('INVALID_SIGNAL_ACTION');
      expect(describeSignalSeatValidationFailure(result)).toBe('信号动作不支持席位校验');
    }
  });
});

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

  it('绑定 symbol 不等于 ACTIVE；symbol 仅检查非空，不新增 trim 或状态兜底', () => {
    const registry = createSymbolRegistryDouble();
    const state = registry.getSeatState('LONG');
    const activating = { ...state, status: 'ACTIVATING', symbol: 'BOUND.HK' } as const;
    expect(hasSeatSymbol(activating)).toBeTrue();
    expect(isSeatActive(activating)).toBeFalse();
    const active = { ...state, status: 'ACTIVE', lastSeatActivatedAt: 1 } as const;
    expect(isSeatActive({ ...active, symbol: '' })).toBeFalse();
    expect(isSeatActive({ ...active, symbol: ' ' })).toBeTrue();
    expect(hasSeatSymbol(null)).toBeFalse();
    expect(isSeatActive(null)).toBeFalse();
  });
});
