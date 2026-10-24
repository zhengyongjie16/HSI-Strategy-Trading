import { createDiagnosticObserverDouble } from '../../helpers/diagnostics.js';
import {
  createLoggerDouble,
  createAccountSnapshotDouble,
  createMonitorConfigDouble,
} from '../../helpers/testDoubles.js';
import { createTerminationRuntime } from '../../../src/runtime/lifecycle/terminationRuntime.js';
import { beforeEach, describe, expect, it } from 'bun:test';
import { createSeatActivationDispatcher } from '../../../src/runtime/seatActivationDispatcher/index.js';
import { createMonitorTaskQueue } from '../../../src/runtime/asyncProgram/monitorTaskQueue/index.js';
import type { MonitorTaskDataMap } from '../../../src/runtime/asyncProgram/monitorTaskProcessor/types.js';
import { createSymbolRegistry } from '../../../src/domain/seat/symbolRegistry.js';
import type { RuntimeWritableSeatState } from '../../../src/types/seat.js';

import { createSnapshotFixture } from '../../helpers/accountPositionSnapshot.js';
import type { AccountPositionSnapshot } from '../../../src/types/accountPosition.js';

let termination: ReturnType<typeof createTerminationRuntime>;
let snapshot: AccountPositionSnapshot;
beforeEach(async () => {
  snapshot = await createSnapshotFixture({ account: createAccountSnapshotDouble('100000') });
  termination = createTerminationRuntime({
    closeTradingGate: () => {},
    closeProducerAdmission: () => {},
    stopProducers: [],
    onSecondaryError: () => {},
  });
});

/**
 * SeatActivationDispatcher 业务测试
 *
 * 覆盖：runtime 阶段 seat 进入 ACTIVATING 后立即调度 SEAT_REFRESH。
 */

describe('SeatActivationDispatcher', () => {
  it('在 SWITCHING -> ACTIVATING 正常换标链路中写入真实旧标的', () => {
    const monitorConfig = createMonitorConfigDouble({
      monitorSymbol: 'HSI.HK',
      longSymbol: 'OLD_BULL.HK',
    });
    const symbolRegistry = createSymbolRegistry(monitorConfig);
    const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskDataMap>({
      logger: createLoggerDouble(),
      clock: { now: () => new Date() },
      diagnostics: createDiagnosticObserverDouble(),
    });
    const dispatcher = createSeatActivationDispatcher({
      logger: createLoggerDouble(),
      termination,
      symbolRegistry,
      snapshot,
      monitorTaskQueue,
    });

    dispatcher.start();
    const { seatVersion: nextVersion } = symbolRegistry.updateSeatStateWithVersionBump('LONG', {
      symbol: 'NEW_BULL.HK',
      status: 'SWITCHING',
      lastSwitchAt: 123,
      lastSearchAt: 456,
      lastSeatActivatedAt: null,
      callPrice: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    });

    symbolRegistry.updateSeatState('LONG', {
      symbol: 'NEW_BULL.HK',
      status: 'ACTIVATING',
      lastSwitchAt: 789,
      lastSearchAt: 790,
      lastSeatActivatedAt: null,
      callPrice: '20000',
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    });
    dispatcher.stop();

    const task = monitorTaskQueue.pop();
    expect(task?.type).toBe('SEAT_REFRESH');
    if (task?.type !== 'SEAT_REFRESH') {
      throw new Error('expected SEAT_REFRESH task');
    }

    expect(task.data.direction).toBe('LONG');
    expect(task.data.nextSymbol).toBe('NEW_BULL.HK');
    expect(task.data.previousSymbol).toBe('OLD_BULL.HK');
    expect(task.data.seatVersion).toBe(nextVersion);
    expect(task.data.callPrice).toBe('20000');
    expect(task.data.dayEpoch).toBe(snapshot.getView().token.dayEpoch);
  });

  it('启动时不扫描既存 ACTIVATING seat', () => {
    const monitorConfig = createMonitorConfigDouble({
      monitorSymbol: 'HSI.HK',
      longSymbol: 'OLD_BULL.HK',
    });
    const symbolRegistry = createSymbolRegistry(monitorConfig);
    const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskDataMap>({
      logger: createLoggerDouble(),
      clock: { now: () => new Date() },
      diagnostics: createDiagnosticObserverDouble(),
    });
    const dispatcher = createSeatActivationDispatcher({
      logger: createLoggerDouble(),
      termination,
      symbolRegistry,
      snapshot,
      monitorTaskQueue,
    });

    symbolRegistry.updateSeatStateWithVersionBump('LONG', {
      symbol: 'NEW_BULL.HK',
      status: 'ACTIVATING',
      lastSwitchAt: 123,
      lastSearchAt: 456,
      lastSeatActivatedAt: null,
      callPrice: '20000',
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    });

    dispatcher.start();
    dispatcher.stop();

    expect(monitorTaskQueue.isEmpty()).toBeTrue();
  });

  it('运行中显式扫描不会覆盖事件路径写入的 previousSymbol', () => {
    const monitorConfig = createMonitorConfigDouble({
      monitorSymbol: 'HSI.HK',
      longSymbol: 'OLD_BULL.HK',
    });
    const symbolRegistry = createSymbolRegistry(monitorConfig);
    const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskDataMap>({
      logger: createLoggerDouble(),
      clock: { now: () => new Date() },
      diagnostics: createDiagnosticObserverDouble(),
    });
    const dispatcher = createSeatActivationDispatcher({
      logger: createLoggerDouble(),
      termination,
      symbolRegistry,
      snapshot,
      monitorTaskQueue,
    });

    dispatcher.start();
    const { seatVersion: nextVersion } = symbolRegistry.updateSeatStateWithVersionBump('LONG', {
      symbol: 'NEW_BULL.HK',
      status: 'SWITCHING',
      lastSwitchAt: 123,
      lastSearchAt: 456,
      lastSeatActivatedAt: null,
      callPrice: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    });

    symbolRegistry.updateSeatState('LONG', {
      symbol: 'NEW_BULL.HK',
      status: 'ACTIVATING',
      lastSwitchAt: 789,
      lastSearchAt: 790,
      lastSeatActivatedAt: null,
      callPrice: '20000',
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    });

    dispatcher.dispatchCurrentActivatingSeats();
    dispatcher.stop();

    const task = monitorTaskQueue.pop();
    expect(task?.type).toBe('SEAT_REFRESH');
    if (task?.type !== 'SEAT_REFRESH') {
      throw new Error('expected SEAT_REFRESH task');
    }

    expect(task.data.direction).toBe('LONG');
    expect(task.data.nextSymbol).toBe('NEW_BULL.HK');
    expect(task.data.previousSymbol).toBe('OLD_BULL.HK');
    expect(task.data.seatVersion).toBe(nextVersion);
    expect(monitorTaskQueue.isEmpty()).toBeTrue();
  });

  it('ACTIVATING seat 缺少标的时由 SymbolRegistry 写入边界拒绝', () => {
    const monitorConfig = createMonitorConfigDouble({
      monitorSymbol: 'HSI.HK',
      longSymbol: 'OLD_BULL.HK',
    });
    const symbolRegistry = createSymbolRegistry(monitorConfig);
    const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskDataMap>({
      logger: createLoggerDouble(),
      clock: { now: () => new Date() },
      diagnostics: createDiagnosticObserverDouble(),
    });
    const dispatcher = createSeatActivationDispatcher({
      logger: createLoggerDouble(),
      termination,
      symbolRegistry,
      snapshot,
      monitorTaskQueue,
    });

    dispatcher.start();
    let caught: unknown = null;
    try {
      const invalidActivatingSeat: RuntimeWritableSeatState = {
        symbol: 'NEW_BULL.HK',
        status: 'ACTIVATING',
        lastSwitchAt: 123,
        lastSearchAt: 456,
        lastSeatActivatedAt: null,
        callPrice: '20000',
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      };
      Object.defineProperty(invalidActivatingSeat, 'symbol', { get: () => null });
      symbolRegistry.updateSeatStateWithVersionBump('LONG', invalidActivatingSeat);
    } catch (error) {
      caught = error;
    } finally {
      dispatcher.stop();
    }

    expect(caught).toBeInstanceOf(Error);
    if (!(caught instanceof Error)) throw new Error('Expected actual registry rejection');

    expect(caught.message).toContain('ACTIVATING 必须绑定标的');
    expect(symbolRegistry.getSeatState('LONG').status).toBe('ACTIVE');
    expect(monitorTaskQueue.isEmpty()).toBeTrue();
  });
});
