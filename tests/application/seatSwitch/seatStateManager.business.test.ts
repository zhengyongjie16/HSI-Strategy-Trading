/**
 * seatStateManager 业务测试
 *
 * 功能：
 * - 验证席位状态管理相关场景意图、边界条件与业务期望。
 */
import { describe, expect, it } from 'bun:test';
import { createSeatStateManager } from '../../../src/application/seatSwitch/seatStateManager.js';
import type { SwitchSuppression } from '../../../src/domain/seat/types.js';

import { createSymbolRegistryDouble } from '../../helpers/testDoubles.js';
import { getHKDateKey } from '../../../src/utils/time/index.js';
import { createLoggerStub } from '../../helpers/seatTestUtils.js';

function createSwitchSuppressionsMap(): Map<'LONG' | 'SHORT', SwitchSuppression> {
  return new Map<'LONG' | 'SHORT', SwitchSuppression>();
}

describe('autoSymbolManager seatStateManager business flow', () => {
  it('enterSwitchingSeat publishes listeners after SWITCHING state and version are both current', () => {
    const symbolRegistry = createSymbolRegistryDouble({
      longSeat: {
        symbol: 'OLD_BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
    });
    const switchSuppressions = createSwitchSuppressionsMap();
    const nowMs = Date.parse('2026-02-16T01:00:00.000Z');
    const observed: Array<{
      readonly eventKind: 'state';
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
    const manager = createSeatStateManager({
      symbolRegistry,
      switchSuppressions,
      now: () => new Date(nowMs),
      logger: createLoggerStub(),
      getHKDateKey,
    });

    manager.enterSwitchingSeat({
      direction: 'LONG',
      reason: 'test-enter-switching-seat',
    });

    expect(observed).toEqual([{ eventKind: 'state', status: 'SWITCHING', version: 2 }]);
  });

  it('enterSwitchingSeat bumps seat version and puts seat into SWITCHING without a duplicate switch plan', () => {
    const symbolRegistry = createSymbolRegistryDouble({
      longSeat: {
        symbol: 'OLD_BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
    });
    const switchSuppressions = createSwitchSuppressionsMap();
    const nowMs = Date.parse('2026-02-16T01:00:00.000Z');
    const manager = createSeatStateManager({
      symbolRegistry,
      switchSuppressions,
      now: () => new Date(nowMs),
      logger: createLoggerStub(),
      getHKDateKey,
    });
    const nextVersion = manager.enterSwitchingSeat({
      direction: 'LONG',
      reason: 'test-enter-switching-seat',
    });
    expect(nextVersion).toBe(2);
    expect(symbolRegistry.getSeatVersion('LONG')).toBe(2);
    const seat = symbolRegistry.getSeatState('LONG');
    expect(seat.status).toBe('SWITCHING');
    expect(seat.symbol).toBe('OLD_BULL.HK');
  });

  it('suppression is valid on same HK date and auto-clears on date rollover', () => {
    const symbolRegistry = createSymbolRegistryDouble({});
    const switchSuppressions = createSwitchSuppressionsMap();
    let now = new Date('2026-02-16T01:00:00.000Z');
    const manager = createSeatStateManager({
      symbolRegistry,
      switchSuppressions,
      now: () => now,
      logger: createLoggerStub(),
      getHKDateKey,
    });
    manager.markSuppression('LONG', 'OLD_BULL.HK', 'PERIODIC');
    const sameDay = manager.resolveSuppression('LONG', 'OLD_BULL.HK', 'PERIODIC');
    expect(sameDay?.symbol).toBe('OLD_BULL.HK');
    now = new Date('2026-02-17T01:00:00.000Z');
    const nextDay = manager.resolveSuppression('LONG', 'OLD_BULL.HK', 'PERIODIC');
    expect(nextDay).toBeNull();
    expect(switchSuppressions.size).toBe(0);
  });

  it('keeps PERIODIC and DISTANCE_SAFE_SIDE suppressions independent on same symbol and day', () => {
    const symbolRegistry = createSymbolRegistryDouble({});
    const switchSuppressions = createSwitchSuppressionsMap();
    const now = new Date('2026-02-16T01:00:00.000Z');
    const manager = createSeatStateManager({
      symbolRegistry,
      switchSuppressions,
      now: () => now,
      logger: createLoggerStub(),
      getHKDateKey,
    });

    manager.markSuppression('LONG', 'OLD_BULL.HK', 'PERIODIC');

    expect(manager.resolveSuppression('LONG', 'OLD_BULL.HK', 'DISTANCE_SAFE_SIDE')).toBeNull();
    expect(manager.resolveSuppression('LONG', 'OLD_BULL.HK', 'PERIODIC')).not.toBeNull();

    manager.markSuppression('LONG', 'OLD_BULL.HK', 'DISTANCE_SAFE_SIDE');

    const periodicSuppression = manager.resolveSuppression('LONG', 'OLD_BULL.HK', 'PERIODIC');
    const safeSideSuppression = manager.resolveSuppression(
      'LONG',
      'OLD_BULL.HK',
      'DISTANCE_SAFE_SIDE',
    );

    expect(periodicSuppression).not.toBeNull();
    expect(safeSideSuppression).not.toBeNull();

    const expectedTriggerKinds = ['DISTANCE_SAFE_SIDE', 'PERIODIC'] as const;
    const expectedTriggerKindsList = [...expectedTriggerKinds];
    const compareTriggerKind = (
      left: (typeof expectedTriggerKinds)[number],
      right: (typeof expectedTriggerKinds)[number],
    ): number => expectedTriggerKinds.indexOf(left) - expectedTriggerKinds.indexOf(right);

    const periodicTriggerKinds = [...(periodicSuppression?.suppressedTriggerKinds ?? [])].sort(
      compareTriggerKind,
    );
    const safeSideTriggerKinds = [...(safeSideSuppression?.suppressedTriggerKinds ?? [])].sort(
      compareTriggerKind,
    );

    expect(periodicTriggerKinds).toEqual(expectedTriggerKindsList);
    expect(safeSideTriggerKinds).toEqual(expectedTriggerKindsList);
  });

  it('keeps suppression independent when DISTANCE_SAFE_SIDE is recorded before PERIODIC', () => {
    const symbolRegistry = createSymbolRegistryDouble({});
    const switchSuppressions = createSwitchSuppressionsMap();
    const now = new Date('2026-02-16T01:00:00.000Z');
    const manager = createSeatStateManager({
      symbolRegistry,
      switchSuppressions,
      now: () => now,
      logger: createLoggerStub(),
      getHKDateKey,
    });

    manager.markSuppression('LONG', 'OLD_BULL.HK', 'DISTANCE_SAFE_SIDE');
    manager.markSuppression('LONG', 'OLD_BULL.HK', 'PERIODIC');

    expect(manager.resolveSuppression('LONG', 'OLD_BULL.HK', 'DISTANCE_SAFE_SIDE')).not.toBeNull();
    expect(manager.resolveSuppression('LONG', 'OLD_BULL.HK', 'PERIODIC')).not.toBeNull();
  });

  it('keeps LONG and SHORT suppressions isolated on same symbol and day', () => {
    const symbolRegistry = createSymbolRegistryDouble({});
    const switchSuppressions = createSwitchSuppressionsMap();
    const now = new Date('2026-02-16T01:00:00.000Z');
    const manager = createSeatStateManager({
      symbolRegistry,
      switchSuppressions,
      now: () => now,
      logger: createLoggerStub(),
      getHKDateKey,
    });

    manager.markSuppression('LONG', 'OLD_BULL.HK', 'PERIODIC');

    expect(manager.resolveSuppression('LONG', 'OLD_BULL.HK', 'PERIODIC')).not.toBeNull();
    expect(manager.resolveSuppression('SHORT', 'OLD_BULL.HK', 'PERIODIC')).toBeNull();
  });

  it('auto-clears suppression when symbol changes on same day', () => {
    const symbolRegistry = createSymbolRegistryDouble({});
    const switchSuppressions = createSwitchSuppressionsMap();
    const now = new Date('2026-02-16T01:00:00.000Z');
    const manager = createSeatStateManager({
      symbolRegistry,
      switchSuppressions,
      now: () => now,
      logger: createLoggerStub(),
      getHKDateKey,
    });

    manager.markSuppression('LONG', 'OLD_BULL.HK', 'PERIODIC');

    expect(manager.resolveSuppression('LONG', 'NEW_BULL.HK', 'PERIODIC')).toBeNull();
    expect(switchSuppressions.size).toBe(0);
  });
});
