/** 席位被动诊断测试：启动首次真实版本变更、完整激活周期含重试等待、失效退出与 stop 注销。 */
import { describe, expect, it } from 'bun:test';
import { createSymbolRegistry } from '../../../src/domain/seat/symbolRegistry.js';
import { createSeatDiagnosticRuntime } from '../../../src/runtime/seatDiagnosticRuntime/index.js';
import { DIAGNOSTIC_OPERATIONS } from '../../../src/constants/diagnostics.js';
import type { DiagnosticFields } from '../../../src/types/diagnostics.js';
import type { RuntimeWritableSeatState } from '../../../src/types/seat.js';
import { createMonitorConfigDouble } from '../../helpers/testDoubles.js';

const activatingSeat: RuntimeWritableSeatState = {
  symbol: 'NEW_BULL.HK',
  status: 'ACTIVATING',
  lastSwitchAt: 0,
  lastSearchAt: 0,
  lastSeatActivatedAt: null,
  callPrice: '20000',
  searchFailCountToday: 0,
  frozenTradingDayKey: null,
};

describe('seat diagnostic runtime', () => {
  it('observes the first startup version mutation and the whole ACTIVATING interval across retry wait', () => {
    let nowMs = 100;
    const invalidated: DiagnosticFields[] = [];
    const completed: DiagnosticFields[] = [];
    const registry = createSymbolRegistry(createMonitorConfigDouble());
    const runtime = createSeatDiagnosticRuntime({
      symbolRegistry: registry,
      clock: { now: () => new Date(nowMs) },
      diagnostics: {
        record: (operation, fields) => {
          if (operation === DIAGNOSTIC_OPERATIONS.SEAT_VERSION_INVALIDATED)
            invalidated.push(fields);

          if (operation === DIAGNOSTIC_OPERATIONS.SEAT_ACTIVATION_COMPLETED) completed.push(fields);
        },
      },
    });
    const previousVersion = registry.getSeatVersion('LONG');
    const previousSeat = registry.getSeatState('LONG');
    runtime.start();
    runtime.start();
    registry.updateSeatStateWithVersionBump('LONG', activatingSeat);
    const seatVersion = registry.getSeatVersion('LONG');
    expect(invalidated).toEqual([
      {
        source: 'SYMBOL_REGISTRY',
        seatDirection: 'LONG',
        previousSeatVersion: previousVersion,
        seatVersion,
        previousSymbol: previousSeat.symbol,
        symbol: 'NEW_BULL.HK',
        previousStatus: previousSeat.status,
        status: 'ACTIVATING',
      },
    ]);
    nowMs = 400;
    registry.updateSeatState('LONG', { ...activatingSeat, lastSearchAt: nowMs });
    // 没有 registry 迁移的 attempt 失败与重试等待不能结束或重置周期。
    nowMs = 5_400;
    expect(completed).toEqual([]);
    registry.updateSeatState('LONG', { ...activatingSeat, lastSearchAt: nowMs });
    nowMs = 5_700;
    registry.updateSeatState('LONG', {
      ...activatingSeat,
      status: 'ACTIVE',
      lastSeatActivatedAt: nowMs,
    });

    expect(completed).toEqual([
      {
        source: 'SYMBOL_REGISTRY',
        seatDirection: 'LONG',
        seatVersion,
        symbol: 'NEW_BULL.HK',
        outcome: 'ACTIVE',
        exitStatus: 'ACTIVE',
        nextSeatVersion: seatVersion,
        durationMs: 5_600,
      },
    ]);
    nowMs = 8_000;
    registry.updateSeatState('LONG', {
      ...activatingSeat,
      status: 'ACTIVE',
      lastSeatActivatedAt: 5_700,
    });
    expect(completed).toHaveLength(1);
    expect(invalidated).toHaveLength(1);
    runtime.stop();
    runtime.stop();
    registry.updateSeatStateWithVersionBump('LONG', activatingSeat);
    expect(invalidated).toHaveLength(1);
  });

  it('closes an invalidated activation as EXITED and starts the new identity without combining intervals', () => {
    let nowMs = 10;
    const completed: DiagnosticFields[] = [];
    const registry = createSymbolRegistry(createMonitorConfigDouble());
    const runtime = createSeatDiagnosticRuntime({
      symbolRegistry: registry,
      clock: { now: () => new Date(nowMs) },
      diagnostics: {
        record: (operation, fields) => {
          if (operation === DIAGNOSTIC_OPERATIONS.SEAT_ACTIVATION_COMPLETED) completed.push(fields);
        },
      },
    });
    runtime.start();
    registry.updateSeatStateWithVersionBump('LONG', activatingSeat);
    const oldVersion = registry.getSeatVersion('LONG');
    nowMs = 210;
    registry.updateSeatStateWithVersionBump('LONG', { ...activatingSeat, symbol: 'NEWER_BULL.HK' });
    expect(completed[0]).toMatchObject({
      outcome: 'EXITED',
      durationMs: 200,
      seatVersion: oldVersion,
    });
    nowMs = 260;
    registry.updateSeatState('LONG', {
      ...activatingSeat,
      symbol: null,
      status: 'EMPTY',
      lastSeatActivatedAt: null,
    });
    expect(completed[1]).toMatchObject({ outcome: 'EXITED', exitStatus: 'EMPTY', durationMs: 50 });
    runtime.stop();
  });

  it('does not scan historical ACTIVATING seats or let diagnostic failures interrupt registry listeners', () => {
    const registry = createSymbolRegistry(createMonitorConfigDouble());
    registry.updateSeatStateWithVersionBump('LONG', activatingSeat);
    let recorded = 0;
    let nextListenerCalls = 0;
    const runtime = createSeatDiagnosticRuntime({
      symbolRegistry: registry,
      clock: {
        now: () => {
          throw new Error('clock failed');
        },
      },
      diagnostics: {
        record: () => {
          recorded += 1;
          throw new Error('observer failed');
        },
      },
    });
    runtime.start();
    registry.onSeatStateChanged(() => {
      nextListenerCalls += 1;
    });
    registry.updateSeatState('LONG', { ...activatingSeat, lastSearchAt: 5 });
    registry.updateSeatState('LONG', {
      ...activatingSeat,
      status: 'ACTIVE',
      lastSeatActivatedAt: 10,
    });
    expect(recorded).toBe(0);
    registry.updateSeatStateWithVersionBump('LONG', activatingSeat);
    registry.updateSeatState('LONG', {
      ...activatingSeat,
      status: 'ACTIVE',
      lastSeatActivatedAt: 20,
    });
    expect(recorded).toBe(2);
    expect(nextListenerCalls).toBe(4);
    expect(registry.getSeatState('LONG').status).toBe('ACTIVE');
    runtime.stop();
  });
});
