/**
 * autoSymbolManager 工具业务测试
 *
 * 覆盖：
 * - 校验席位状态更新、事件发布顺序与信号席位校验辅助逻辑
 * - 防止工具层破坏自动寻标状态机依赖的不变量
 */
import { describe, expect, it } from 'bun:test';

import {
  createSymbolRegistry,
  describeSignalSeatValidationFailure,
  validateSignalSeat,
} from '../../../src/services/autoSymbolManager/utils.js';
import type { RuntimeWritableSeatState } from '../../../src/types/seat.js';
import {
  createMonitorConfigDouble,
  createSignalDouble,
  createSymbolRegistryDouble,
} from '../../helpers/testDoubles.js';

describe('autoSymbolManager utils business flow', () => {
  it('keeps the static configured bootstrap ACTIVE state as a narrow exception', () => {
    const symbolRegistry = createSymbolRegistry(
      createMonitorConfigDouble({
        monitorSymbol: 'HSI.HK',
        longSymbol: 'STATIC_BULL.HK',
      }),
    );

    expect(symbolRegistry.getSeatState('LONG')).toEqual({
      symbol: 'STATIC_BULL.HK',
      status: 'ACTIVE',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: null,
      callPrice: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    });
  });

  it('accepts finite runtime ACTIVE state when auto-search is enabled', () => {
    const symbolRegistry = createSymbolRegistry(
      createMonitorConfigDouble({
        monitorSymbol: 'HSI.HK',
        autoSearchConfig: {
          ...createMonitorConfigDouble().autoSearchConfig,
          autoSearchEnabled: true,
        },
      }),
    );

    const nextState = symbolRegistry.updateSeatState('LONG', {
      symbol: 'RUNTIME_BULL.HK',
      status: 'ACTIVE',
      lastSwitchAt: 100,
      lastSearchAt: 100,
      lastSeatActivatedAt: 120,
      callPrice: 20_000,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    });

    expect(nextState.lastSeatActivatedAt).toBe(120);
  });

  it('rejects static-shaped ACTIVE null after runtime transition before mutating truth', () => {
    const symbolRegistry = createSymbolRegistry(
      createMonitorConfigDouble({
        monitorSymbol: 'HSI.HK',
        longSymbol: 'STATIC_BULL.HK',
      }),
    );
    symbolRegistry.updateSeatState('LONG', {
      symbol: 'NEXT_BULL.HK',
      status: 'ACTIVATING',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: null,
      callPrice: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    });
    const observed: string[] = [];
    symbolRegistry.onSeatStateChanged(() => {
      observed.push('state');
    });

    symbolRegistry.onSeatTruthChanged(() => {
      observed.push('truth');
    });
    const previousState = symbolRegistry.getSeatState('LONG');
    const previousVersion = symbolRegistry.getSeatVersion('LONG');

    expect(() =>
      symbolRegistry.updateSeatStateWithVersionBump('LONG', {
        symbol: 'RUNTIME_BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        callPrice: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      } as unknown as RuntimeWritableSeatState),
    ).toThrow('运行时 ACTIVE 必须具有有效激活时间');
    expect(symbolRegistry.getSeatState('LONG')).toEqual(previousState);
    expect(symbolRegistry.getSeatVersion('LONG')).toBe(previousVersion);
    expect(observed).toEqual([]);
  });

  it('rejects invalid auto-search ACTIVE state before mutating truth', () => {
    const symbolRegistry = createSymbolRegistry(
      createMonitorConfigDouble({
        monitorSymbol: 'HSI.HK',
        autoSearchConfig: {
          ...createMonitorConfigDouble().autoSearchConfig,
          autoSearchEnabled: true,
        },
      }),
    );
    const observed: string[] = [];
    symbolRegistry.onSeatStateChanged(() => {
      observed.push('state');
    });

    symbolRegistry.onSeatTruthChanged(() => {
      observed.push('truth');
    });

    const previousState = symbolRegistry.getSeatState('LONG');
    const previousVersion = symbolRegistry.getSeatVersion('LONG');
    expect(() =>
      symbolRegistry.updateSeatStateWithVersionBump('LONG', {
        symbol: 'BAD.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        callPrice: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      } as unknown as RuntimeWritableSeatState),
    ).toThrow('运行时 ACTIVE 必须具有有效激活时间');
    expect(symbolRegistry.getSeatState('LONG')).toEqual(previousState);
    expect(symbolRegistry.getSeatVersion('LONG')).toBe(previousVersion);
    expect(observed).toEqual([]);
  });

  it('rejects non-finite ACTIVE activation time before mutating truth', () => {
    const symbolRegistry = createSymbolRegistry(
      createMonitorConfigDouble({
        monitorSymbol: 'HSI.HK',
        autoSearchConfig: {
          ...createMonitorConfigDouble().autoSearchConfig,
          autoSearchEnabled: true,
        },
      }),
    );
    const previousState = symbolRegistry.getSeatState('LONG');
    const previousVersion = symbolRegistry.getSeatVersion('LONG');

    expect(() =>
      symbolRegistry.updateSeatState('LONG', {
        symbol: 'BAD.HK',
        status: 'ACTIVE',
        lastSwitchAt: 100,
        lastSearchAt: 100,
        lastSeatActivatedAt: Number.POSITIVE_INFINITY,
        callPrice: 20_000,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      }),
    ).toThrow('lastSeatActivatedAt 必须是有限时间戳');
    expect(symbolRegistry.getSeatState('LONG')).toEqual(previousState);
    expect(symbolRegistry.getSeatVersion('LONG')).toBe(previousVersion);
  });

  it('does not resolve unowned lifecycle states by symbol', () => {
    const symbolRegistry = createSymbolRegistry(
      createMonitorConfigDouble({
        monitorSymbol: 'HSI.HK',
      }),
    );
    const illegalState = {
      symbol: 'BAD.HK',
      status: 'EMPTY',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: null,
      callPrice: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    } as unknown as RuntimeWritableSeatState;

    expect(() => symbolRegistry.updateSeatState('LONG', illegalState)).toThrow(
      'EMPTY 不得绑定标的',
    );
    expect(symbolRegistry.resolveSeatBySymbol('BAD.HK')).toBeNull();
  });

  it('atomically updates seat state and version before publishing events', () => {
    const symbolRegistry = createSymbolRegistry(
      createMonitorConfigDouble({
        monitorSymbol: 'HSI.HK',
        longSymbol: 'OLD_BULL.HK',
      }),
    );
    const observed: Array<{
      readonly eventKind: 'state' | 'truth';
      readonly status: string;
      readonly version: number;
    }> = [];
    symbolRegistry.onSeatStateChanged(() => {
      observed.push({
        eventKind: 'state',
        status: symbolRegistry.getSeatState('LONG').status,
        version: symbolRegistry.getSeatVersion('LONG'),
      });
    });

    symbolRegistry.onSeatTruthChanged(() => {
      observed.push({
        eventKind: 'truth',
        status: symbolRegistry.getSeatState('LONG').status,
        version: symbolRegistry.getSeatVersion('LONG'),
      });
    });

    const result = symbolRegistry.updateSeatStateWithVersionBump('LONG', {
      symbol: 'NEW_BULL.HK',
      status: 'ACTIVATING',
      lastSwitchAt: 100,
      lastSearchAt: 100,
      lastSeatActivatedAt: null,
      callPrice: 20_000,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    });

    expect(result.seatVersion).toBe(2);
    expect(result.seatState.status).toBe('ACTIVATING');
    const resolvedSeat = symbolRegistry.resolveSeatBySymbol('NEW_BULL.HK');
    expect(resolvedSeat?.direction).toBe('LONG');
    expect(resolvedSeat?.seatVersion).toBe(2);
    expect(symbolRegistry.getSeatVersion('LONG')).toBe(2);
    expect(symbolRegistry.getSeatState('LONG').symbol).toBe('NEW_BULL.HK');
    expect(observed).toEqual([
      { eventKind: 'state', status: 'ACTIVATING', version: 2 },
      { eventKind: 'truth', status: 'ACTIVATING', version: 2 },
    ]);
  });

  it('updates seat state without bumping version', () => {
    const symbolRegistry = createSymbolRegistry(
      createMonitorConfigDouble({
        monitorSymbol: 'HSI.HK',
        longSymbol: 'OLD_BULL.HK',
      }),
    );
    const stateEvents: Array<{
      readonly previousVersion: number;
      readonly nextVersion: number;
      readonly observedVersion: number;
      readonly status: string;
    }> = [];
    const truthEvents: Array<{
      readonly direction: 'LONG' | 'SHORT';
      readonly observedVersion: number;
      readonly status: string;
    }> = [];
    symbolRegistry.onSeatStateChanged((event) => {
      stateEvents.push({
        previousVersion: event.previousVersion,
        nextVersion: event.nextVersion,
        observedVersion: symbolRegistry.getSeatVersion('LONG'),
        status: symbolRegistry.getSeatState('LONG').status,
      });
    });

    symbolRegistry.onSeatTruthChanged((event) => {
      truthEvents.push({
        direction: event.direction,
        observedVersion: symbolRegistry.getSeatVersion('LONG'),
        status: symbolRegistry.getSeatState('LONG').status,
      });
    });

    const nextState = symbolRegistry.updateSeatState('LONG', {
      symbol: 'OLD_BULL.HK',
      status: 'ACTIVATING',
      lastSwitchAt: 100,
      lastSearchAt: 100,
      lastSeatActivatedAt: null,
      callPrice: 20_000,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    });

    expect(nextState.status).toBe('ACTIVATING');
    expect(symbolRegistry.getSeatVersion('LONG')).toBe(1);
    expect(stateEvents).toEqual([
      {
        previousVersion: 1,
        nextVersion: 1,
        observedVersion: 1,
        status: 'ACTIVATING',
      },
    ]);

    expect(truthEvents).toEqual([
      {
        direction: 'LONG',
        observedVersion: 1,
        status: 'ACTIVATING',
      },
    ]);
  });

  it('提交席位状态与版本后汇总所有 listener 错误', () => {
    const symbolRegistry = createSymbolRegistry(
      createMonitorConfigDouble({
        monitorSymbol: 'HSI.HK',
        longSymbol: 'OLD_BULL.HK',
      }),
    );
    const stateListenerError = new Error('state listener failed');
    const truthListenerError = new Error('truth listener failed');
    const events: string[] = [];
    symbolRegistry.onSeatStateChanged(() => {
      events.push('state:first');
      throw stateListenerError;
    });

    symbolRegistry.onSeatStateChanged(() => {
      events.push('state:second');
    });

    symbolRegistry.onSeatTruthChanged(() => {
      events.push('truth:first');
      throw truthListenerError;
    });

    symbolRegistry.onSeatTruthChanged(() => {
      events.push('truth:second');
    });

    let caught: unknown = null;
    try {
      symbolRegistry.updateSeatStateWithVersionBump('LONG', {
        symbol: 'NEW_BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: 100,
        lastSearchAt: 100,
        lastSeatActivatedAt: 120,
        callPrice: 20_000,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    if (!(caught instanceof AggregateError)) {
      throw new Error('预期 SymbolRegistry 暴露 AggregateError');
    }

    expect(caught.errors).toEqual([stateListenerError, truthListenerError]);
    expect(symbolRegistry.getSeatState('LONG')).toMatchObject({
      symbol: 'NEW_BULL.HK',
      status: 'ACTIVE',
    });
    expect(symbolRegistry.getSeatVersion('LONG')).toBe(2);
    expect(events).toEqual(['state:first', 'state:second', 'truth:first', 'truth:second']);
  });

  it('无版本递增写入也在完成两类 listener 后暴露聚合错误', () => {
    const symbolRegistry = createSymbolRegistry(
      createMonitorConfigDouble({
        monitorSymbol: 'HSI.HK',
        longSymbol: 'OLD_BULL.HK',
      }),
    );
    const stateListenerError = new Error('state listener failed');
    const truthListenerError = new Error('truth listener failed');
    const events: string[] = [];
    symbolRegistry.onSeatStateChanged(() => {
      events.push('state:first');
      throw stateListenerError;
    });

    symbolRegistry.onSeatStateChanged(() => {
      events.push('state:second');
    });

    symbolRegistry.onSeatTruthChanged(() => {
      events.push('truth:first');
      throw truthListenerError;
    });

    symbolRegistry.onSeatTruthChanged(() => {
      events.push('truth:second');
    });

    let caught: unknown = null;
    try {
      symbolRegistry.updateSeatState('LONG', {
        symbol: 'OLD_BULL.HK',
        status: 'ACTIVATING',
        lastSwitchAt: 100,
        lastSearchAt: 100,
        lastSeatActivatedAt: null,
        callPrice: 20_000,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    if (!(caught instanceof AggregateError)) {
      throw new Error('预期 SymbolRegistry 暴露 AggregateError');
    }

    expect(caught.errors).toEqual([stateListenerError, truthListenerError]);
    expect(symbolRegistry.getSeatState('LONG').status).toBe('ACTIVATING');
    expect(symbolRegistry.getSeatVersion('LONG')).toBe(1);
    expect(events).toEqual(['state:first', 'state:second', 'truth:first', 'truth:second']);
  });

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
