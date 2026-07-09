/**
 * monitorTaskQueue 业务测试
 *
 * 功能：
 * - 验证监控任务队列相关场景意图、边界条件与业务期望。
 */
import { describe, expect, it } from 'bun:test';

import { createMonitorTaskQueue } from '../../../../src/main/asyncProgram/monitorTaskQueue/index.js';

import type { MonitorTaskDataMap } from '../../../../src/main/asyncProgram/monitorTaskProcessor/types.js';

function createAutoSymbolTickTask(params: {
  readonly dedupeKey: string;
  readonly monitorSymbol: string;
  readonly direction: 'LONG' | 'SHORT';
  readonly seatVersion: number;
}): Parameters<ReturnType<typeof createMonitorTaskQueue<MonitorTaskDataMap>>['scheduleLatest']>[0] {
  return {
    type: 'AUTO_SYMBOL_TICK',
    dedupeKey: params.dedupeKey,
    monitorSymbol: params.monitorSymbol,
    data: {
      monitorSymbol: params.monitorSymbol,
      direction: params.direction,
      seatVersion: params.seatVersion,
      symbol: `${params.monitorSymbol}:${params.direction}`,
      lastSeatActivatedAt: params.seatVersion,
      currentTimeMs: params.seatVersion,
    },
  };
}

describe('monitorTaskQueue business behavior', () => {
  it('scheduleLatest keeps only the latest task for the same dedupeKey', () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();

    queue.scheduleLatest(
      createAutoSymbolTickTask({
        dedupeKey: 'AUTO_SYMBOL_TICK:LONG',
        monitorSymbol: 'HSI.HK',
        direction: 'LONG',
        seatVersion: 1,
      }),
    );

    queue.scheduleLatest(
      createAutoSymbolTickTask({
        dedupeKey: 'AUTO_SYMBOL_TICK:LONG',
        monitorSymbol: 'HSI.HK',
        direction: 'LONG',
        seatVersion: 2,
      }),
    );

    const first = queue.pop();

    expect(first?.type).toBe('AUTO_SYMBOL_TICK');
    expect(first?.data.seatVersion).toBe(2);
    expect(queue.isEmpty()).toBeTrue();
  });

  it('keeps FIFO order for different dedupe keys', () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();

    queue.scheduleLatest(
      createAutoSymbolTickTask({
        dedupeKey: 'AUTO_SYMBOL_TICK:LONG:1',
        monitorSymbol: 'HSI.HK',
        direction: 'LONG',
        seatVersion: 1,
      }),
    );

    queue.scheduleLatest(
      createAutoSymbolTickTask({
        dedupeKey: 'AUTO_SYMBOL_TICK:SHORT:2',
        monitorSymbol: 'HSI.HK',
        direction: 'SHORT',
        seatVersion: 2,
      }),
    );

    queue.scheduleLatest(
      createAutoSymbolTickTask({
        dedupeKey: 'AUTO_SYMBOL_TICK:LONG:3',
        monitorSymbol: 'HSI.HK',
        direction: 'LONG',
        seatVersion: 3,
      }),
    );

    expect(queue.pop()?.dedupeKey).toBe('AUTO_SYMBOL_TICK:LONG:1');
    expect(queue.pop()?.dedupeKey).toBe('AUTO_SYMBOL_TICK:SHORT:2');
    expect(queue.pop()?.dedupeKey).toBe('AUTO_SYMBOL_TICK:LONG:3');
    expect(queue.isEmpty()).toBeTrue();
  });

  it('notifies onTaskAdded callbacks for replacement tasks and supports unregister', () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();

    let calls = 0;
    const unregister = queue.onTaskAdded(() => {
      calls += 1;
    });

    queue.scheduleLatest({
      type: 'SEAT_REFRESH',
      dedupeKey: 'SEAT_REFRESH:LONG',
      monitorSymbol: 'HSI.HK',
      data: {
        monitorSymbol: 'HSI.HK',
        direction: 'LONG',
        seatVersion: 1,
        previousSymbol: 'OLD_BULL.HK',
        nextSymbol: 'BULL.HK',
        callPrice: 20_000,
        symbolName: 'BULL',
      },
    });

    queue.scheduleLatest({
      type: 'SEAT_REFRESH',
      dedupeKey: 'SEAT_REFRESH:LONG',
      monitorSymbol: 'HSI.HK',
      data: {
        monitorSymbol: 'HSI.HK',
        direction: 'LONG',
        seatVersion: 2,
        previousSymbol: 'BULL.HK',
        nextSymbol: 'NEXT_BULL.HK',
        callPrice: 20_010,
        symbolName: 'NEXT_BULL',
      },
    });

    unregister();

    queue.scheduleLatest({
      type: 'SEAT_REFRESH',
      dedupeKey: 'SEAT_REFRESH:LONG:2',
      monitorSymbol: 'HSI.HK',
      data: {
        monitorSymbol: 'HSI.HK',
        direction: 'SHORT',
        seatVersion: 2,
        previousSymbol: 'OLD_BEAR.HK',
        nextSymbol: 'BEAR.HK',
        callPrice: 20_100,
        symbolName: 'BEAR',
      },
    });

    expect(calls).toBe(2);
  });

  it('removeTasks and clearAll return removed count and call onRemove', () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();

    queue.scheduleLatest(
      createAutoSymbolTickTask({
        dedupeKey: 'AUTO_SYMBOL_TICK:LONG:1',
        monitorSymbol: 'HSI.HK',
        direction: 'LONG',
        seatVersion: 1,
      }),
    );

    queue.scheduleLatest(
      createAutoSymbolTickTask({
        dedupeKey: 'AUTO_SYMBOL_TICK:SHORT:2',
        monitorSymbol: 'HSI.HK',
        direction: 'SHORT',
        seatVersion: 2,
      }),
    );

    const removedKeys: string[] = [];
    const removed = queue.removeTasks(
      (task) => task.data.direction === 'LONG',
      (task) => {
        removedKeys.push(task.dedupeKey);
      },
    );

    expect(removed).toBe(1);
    expect(removedKeys).toEqual(['AUTO_SYMBOL_TICK:LONG:1']);

    const clearedKeys: string[] = [];
    const cleared = queue.clearAll((task) => {
      clearedKeys.push(task.dedupeKey);
    });

    expect(cleared).toBe(1);
    expect(clearedKeys).toEqual(['AUTO_SYMBOL_TICK:SHORT:2']);
    expect(queue.isEmpty()).toBeTrue();
  });

  it('removeTasks prevents removed tasks from being popped', () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();

    queue.scheduleLatest(
      createAutoSymbolTickTask({
        dedupeKey: 'AUTO_SYMBOL_TICK:LONG:1',
        monitorSymbol: 'HSI.HK',
        direction: 'LONG',
        seatVersion: 1,
      }),
    );

    queue.scheduleLatest(
      createAutoSymbolTickTask({
        dedupeKey: 'AUTO_SYMBOL_TICK:SHORT:2',
        monitorSymbol: 'HSI.HK',
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

  it('clearAll clears active tasks after earlier pops', () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();

    queue.scheduleLatest(
      createAutoSymbolTickTask({
        dedupeKey: 'AUTO_SYMBOL_TICK:LONG:1',
        monitorSymbol: 'HSI.HK',
        direction: 'LONG',
        seatVersion: 1,
      }),
    );

    queue.scheduleLatest(
      createAutoSymbolTickTask({
        dedupeKey: 'AUTO_SYMBOL_TICK:SHORT:2',
        monitorSymbol: 'HSI.HK',
        direction: 'SHORT',
        seatVersion: 2,
      }),
    );

    expect(queue.pop()?.dedupeKey).toBe('AUTO_SYMBOL_TICK:LONG:1');

    const clearedKeys: string[] = [];
    const cleared = queue.clearAll((task) => {
      clearedKeys.push(task.dedupeKey);
    });

    expect(cleared).toBe(1);
    expect(clearedKeys).toEqual(['AUTO_SYMBOL_TICK:SHORT:2']);
    expect(queue.isEmpty()).toBeTrue();
  });
});
