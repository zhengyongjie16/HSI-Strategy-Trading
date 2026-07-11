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
import { logger } from '../../../src/utils/logger/index.js';
import type { Logger } from '../../../src/utils/logger/types.js';
import {
  createMonitorConfigDouble,
  createSignalDouble,
  createSymbolRegistryDouble,
} from '../../helpers/testDoubles.js';

describe('autoSymbolManager utils business flow', () => {
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

  it('logs listener errors without failing committed seat mutations', () => {
    const originalErrorLogger = logger.error;
    const errorLogs: Array<{ readonly message: string; readonly extra: unknown }> = [];
    logger.error = ((message: string, extra?: unknown) => {
      errorLogs.push({ message, extra });
    }) satisfies Logger['error'];
    const symbolRegistry = createSymbolRegistry(
      createMonitorConfigDouble({
        monitorSymbol: 'HSI.HK',
        longSymbol: 'OLD_BULL.HK',
      }),
    );
    const events: string[] = [];
    symbolRegistry.onSeatStateChanged(() => {
      events.push('state:first');
      throw new Error('state listener failed');
    });

    symbolRegistry.onSeatStateChanged(() => {
      events.push('state:second');
    });

    symbolRegistry.onSeatTruthChanged(() => {
      events.push('truth:first');
      throw new Error('truth listener failed');
    });

    symbolRegistry.onSeatTruthChanged(() => {
      events.push('truth:second');
    });

    try {
      const result = symbolRegistry.updateSeatStateWithVersionBump('LONG', {
        symbol: 'NEW_BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: 100,
        lastSearchAt: 100,
        lastSeatActivatedAt: 120,
        callPrice: 20_000,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      });

      expect(result.seatVersion).toBe(2);
      expect(result.seatState.symbol).toBe('NEW_BULL.HK');
      expect(symbolRegistry.getSeatState('LONG').symbol).toBe('NEW_BULL.HK');
      expect(symbolRegistry.getSeatVersion('LONG')).toBe(2);
      expect(events).toEqual(['state:first', 'state:second', 'truth:first', 'truth:second']);

      expect(errorLogs).toEqual([
        {
          message: 'SymbolRegistry 席位状态 listener 执行失败',
          extra: 'state listener failed',
        },
        {
          message: 'SymbolRegistry 席位 truth listener 执行失败',
          extra: 'truth listener failed',
        },
      ]);
    } finally {
      logger.error = originalErrorLogger;
    }
  });

  it('logs state listener errors without failing non-version seat mutations', () => {
    const originalErrorLogger = logger.error;
    const errorLogs: Array<{ readonly message: string; readonly extra: unknown }> = [];
    logger.error = ((message: string, extra?: unknown) => {
      errorLogs.push({ message, extra });
    }) satisfies Logger['error'];
    const symbolRegistry = createSymbolRegistry(
      createMonitorConfigDouble({
        monitorSymbol: 'HSI.HK',
        longSymbol: 'OLD_BULL.HK',
      }),
    );

    symbolRegistry.onSeatStateChanged(() => {
      throw new Error('state listener failed');
    });

    symbolRegistry.onSeatTruthChanged(() => {
      throw new Error('truth listener failed');
    });

    try {
      const result = symbolRegistry.updateSeatState('LONG', {
        symbol: 'OLD_BULL.HK',
        status: 'ACTIVATING',
        lastSwitchAt: 100,
        lastSearchAt: 100,
        lastSeatActivatedAt: null,
        callPrice: 20_000,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      });

      expect(result.status).toBe('ACTIVATING');
      expect(symbolRegistry.getSeatState('LONG').status).toBe('ACTIVATING');
      expect(symbolRegistry.getSeatVersion('LONG')).toBe(1);
      expect(errorLogs).toEqual([
        {
          message: 'SymbolRegistry 席位状态 listener 执行失败',
          extra: 'state listener failed',
        },
        {
          message: 'SymbolRegistry 席位 truth listener 执行失败',
          extra: 'truth listener failed',
        },
      ]);
    } finally {
      logger.error = originalErrorLogger;
    }
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
