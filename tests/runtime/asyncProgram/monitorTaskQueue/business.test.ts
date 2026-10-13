/**
 * monitorTaskQueue 业务测试
 *
 * 功能：
 * - 验证监控任务队列相关场景意图、边界条件与业务期望。
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { createIssuedPeriodicTasksFixture } from '../../../main/fixtures/issuedPeriodicTasks.js';
import { createSnapshotFixture } from '../../../main/fixtures/accountPositionSnapshot.js';
import { createTerminationRuntime } from '../../../../src/app/runtime/createTerminationRuntime.js';
import {
  createAccountSnapshotDouble,
  createMonitorConfigDouble,
  createMonitorContextDouble,
  createSymbolRegistryDouble,
  createTraderDouble,
} from '../../../helpers/testDoubles.js';

import { createMonitorTaskQueue } from '../../../../src/runtime/asyncProgram/monitorTaskQueue/index.js';

import type { MonitorTaskDataMap } from '../../../../src/runtime/asyncProgram/monitorTaskProcessor/types.js';

const taskOwners: Awaited<ReturnType<typeof createIssuedPeriodicTasksFixture>>[] = [];
afterEach(async () => {
  for (const owner of taskOwners.splice(0)) await owner.stopAndDrain();
});

async function createAutoSymbolTickTask(params: {
  readonly dedupeKey: string;
  readonly direction: 'LONG' | 'SHORT';
  readonly seatVersion: number;
}): Promise<
  Parameters<ReturnType<typeof createMonitorTaskQueue<MonitorTaskDataMap>>['scheduleLatest']>[0]
> {
  const seat = {
    symbol: `HSI.HK:${params.direction}`,
    status: 'ACTIVE' as const,
    lastSwitchAt: null,
    lastSearchAt: null,
    lastSeatActivatedAt: params.seatVersion,
    callPrice: null,
    searchFailCountToday: 0,
    frozenTradingDayKey: null,
  };
  const symbolRegistry = createSymbolRegistryDouble({
    ...(params.direction === 'LONG'
      ? { longSeat: seat, longVersion: params.seatVersion }
      : { shortSeat: seat, shortVersion: params.seatVersion }),
  });
  const config = createMonitorConfigDouble();
  const monitorContext = createMonitorContextDouble({
    symbolRegistry,
    config: createMonitorConfigDouble({
      ...config,
      autoSearchConfig: {
        ...config.autoSearchConfig,
        autoSearchEnabled: true,
        switchIntervalMinutes: 1,
      },
    }),
  });
  const snapshot = await createSnapshotFixture({
    account: createAccountSnapshotDouble('100000'),
    positions: [],
  });
  const termination = createTerminationRuntime({
    closeTradingGate: () => {},
    closeProducerAdmission: () => {},
    stopProducers: [],
    onSecondaryError: () => {},
  });
  const capturedSeatVersion = symbolRegistry.getSeatVersion(params.direction);
  const owner = await createIssuedPeriodicTasksFixture({
    snapshot,
    termination,
    monitorContext,
    trader: createTraderDouble(),
    getCanTradeNow: () =>
      !termination.isTerminated() &&
      symbolRegistry.getSeatVersion(params.direction) === capturedSeatVersion,
    nowMs: params.seatVersion,
  });
  taskOwners.push(owner);
  const task = owner.getTask(params.direction);
  expect(task.seatVersion).toBe(params.seatVersion);
  expect(task.canContinue()).toBe(true);
  return { type: 'AUTO_SYMBOL_TICK', dedupeKey: params.dedupeKey, data: task };
}

describe('monitorTaskQueue business behavior', () => {
  it('scheduleLatest keeps only the latest task for the same dedupeKey', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();

    queue.scheduleLatest(
      await createAutoSymbolTickTask({
        dedupeKey: 'AUTO_SYMBOL_TICK:LONG',
        direction: 'LONG',
        seatVersion: 1,
      }),
    );

    queue.scheduleLatest(
      await createAutoSymbolTickTask({
        dedupeKey: 'AUTO_SYMBOL_TICK:LONG',
        direction: 'LONG',
        seatVersion: 2,
      }),
    );

    const first = queue.pop();

    expect(first?.type).toBe('AUTO_SYMBOL_TICK');
    expect(first?.data.seatVersion).toBe(2);
    expect(queue.isEmpty()).toBeTrue();
  });

  it('keeps FIFO order for different dedupe keys', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();

    queue.scheduleLatest(
      await createAutoSymbolTickTask({
        dedupeKey: 'AUTO_SYMBOL_TICK:LONG:1',
        direction: 'LONG',
        seatVersion: 1,
      }),
    );

    queue.scheduleLatest(
      await createAutoSymbolTickTask({
        dedupeKey: 'AUTO_SYMBOL_TICK:SHORT:2',
        direction: 'SHORT',
        seatVersion: 2,
      }),
    );

    queue.scheduleLatest(
      await createAutoSymbolTickTask({
        dedupeKey: 'AUTO_SYMBOL_TICK:LONG:3',
        direction: 'LONG',
        seatVersion: 3,
      }),
    );

    expect(queue.pop()?.dedupeKey).toBe('AUTO_SYMBOL_TICK:LONG:1');
    expect(queue.pop()?.dedupeKey).toBe('AUTO_SYMBOL_TICK:SHORT:2');
    expect(queue.pop()?.dedupeKey).toBe('AUTO_SYMBOL_TICK:LONG:3');
    expect(queue.isEmpty()).toBeTrue();
  });

  it('notifies onTaskAdded callbacks for replacement tasks and supports unregister', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();

    let calls = 0;
    const unregister = queue.onTaskAdded(() => {
      calls += 1;
    });

    queue.scheduleLatest({
      type: 'SEAT_REFRESH',
      dedupeKey: 'SEAT_REFRESH:LONG',
      data: {
        dayEpoch: 0,
        direction: 'LONG',
        seatVersion: 1,
        previousSymbol: 'OLD_BULL.HK',
        nextSymbol: 'BULL.HK',
        callPrice: '20000',
        symbolName: 'BULL',
      },
    });

    queue.scheduleLatest({
      type: 'SEAT_REFRESH',
      dedupeKey: 'SEAT_REFRESH:LONG',
      data: {
        dayEpoch: 0,
        direction: 'LONG',
        seatVersion: 2,
        previousSymbol: 'BULL.HK',
        nextSymbol: 'NEXT_BULL.HK',
        callPrice: '20010',
        symbolName: 'NEXT_BULL',
      },
    });

    unregister();

    queue.scheduleLatest({
      type: 'SEAT_REFRESH',
      dedupeKey: 'SEAT_REFRESH:LONG:2',
      data: {
        dayEpoch: 0,
        direction: 'SHORT',
        seatVersion: 2,
        previousSymbol: 'OLD_BEAR.HK',
        nextSymbol: 'BEAR.HK',
        callPrice: '20100',
        symbolName: 'BEAR',
      },
    });

    expect(calls).toBe(2);
  });

  it('removeTasks and clearAll return removed count', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();

    queue.scheduleLatest(
      await createAutoSymbolTickTask({
        dedupeKey: 'AUTO_SYMBOL_TICK:LONG:1',
        direction: 'LONG',
        seatVersion: 1,
      }),
    );

    queue.scheduleLatest(
      await createAutoSymbolTickTask({
        dedupeKey: 'AUTO_SYMBOL_TICK:SHORT:2',
        direction: 'SHORT',
        seatVersion: 2,
      }),
    );

    const removed = queue.removeTasks((task) => task.data.direction === 'LONG');

    expect(removed).toBe(1);
    const cleared = queue.clearAll();

    expect(cleared).toBe(1);
    expect(queue.isEmpty()).toBeTrue();
  });

  it('removeTasks prevents removed tasks from being popped', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();

    queue.scheduleLatest(
      await createAutoSymbolTickTask({
        dedupeKey: 'AUTO_SYMBOL_TICK:LONG:1',
        direction: 'LONG',
        seatVersion: 1,
      }),
    );

    queue.scheduleLatest(
      await createAutoSymbolTickTask({
        dedupeKey: 'AUTO_SYMBOL_TICK:SHORT:2',
        direction: 'SHORT',
        seatVersion: 2,
      }),
    );

    const removed = queue.removeTasks((task) => task.dedupeKey === 'AUTO_SYMBOL_TICK:LONG:1');

    expect(removed).toBe(1);
    expect(queue.pop()?.dedupeKey).toBe('AUTO_SYMBOL_TICK:SHORT:2');
    expect(queue.pop()).toBeNull();
    expect(queue.isEmpty()).toBeTrue();
  });

  it('clearAll clears active tasks after earlier pops', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();

    queue.scheduleLatest(
      await createAutoSymbolTickTask({
        dedupeKey: 'AUTO_SYMBOL_TICK:LONG:1',
        direction: 'LONG',
        seatVersion: 1,
      }),
    );

    queue.scheduleLatest(
      await createAutoSymbolTickTask({
        dedupeKey: 'AUTO_SYMBOL_TICK:SHORT:2',
        direction: 'SHORT',
        seatVersion: 2,
      }),
    );

    expect(queue.pop()?.dedupeKey).toBe('AUTO_SYMBOL_TICK:LONG:1');

    const cleared = queue.clearAll();

    expect(cleared).toBe(1);
    expect(queue.isEmpty()).toBeTrue();
  });
});
