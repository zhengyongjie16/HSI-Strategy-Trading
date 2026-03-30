/**
 * monitorTaskQueue 业务测试
 *
 * 功能：
 * - 验证监控任务队列相关场景意图、边界条件与业务期望。
 */
import { describe, expect, it } from 'bun:test';

import { createMonitorTaskQueue } from '../../../../src/main/asyncProgram/monitorTaskQueue/index.js';

import type { MonitorTaskDataMap } from '../../../../src/main/asyncProgram/monitorTaskProcessor/types.js';

describe('monitorTaskQueue business behavior', () => {
  it('scheduleLatest keeps only the latest task for the same dedupeKey', () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();

    queue.scheduleLatest({
      type: 'AUTO_SYMBOL_TICK',
      dedupeKey: 'HSI.HK:AUTO_SYMBOL_TICK:LONG',
      data: {
        direction: 'LONG',
        seatVersion: 1,
        symbol: 'BULL.HK',
        currentTimeMs: 100,
        canTradeNow: true,
        openProtectionActive: false,
      },
    });

    queue.scheduleLatest({
      type: 'AUTO_SYMBOL_TICK',
      dedupeKey: 'HSI.HK:AUTO_SYMBOL_TICK:LONG',
      data: {
        direction: 'LONG',
        seatVersion: 2,
        symbol: 'BULL.HK',
        currentTimeMs: 200,
        canTradeNow: true,
        openProtectionActive: false,
      },
    });

    const first = queue.pop();

    expect((first?.data as { seatVersion: number }).seatVersion).toBe(2);
    expect(queue.isEmpty()).toBeTrue();
  });

  it('notifies onTaskAdded callbacks and supports unregister', () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();

    let calls = 0;
    const unregister = queue.onTaskAdded(() => {
      calls += 1;
    });

    queue.scheduleLatest({
      type: 'UNREALIZED_LOSS_CHECK',
      dedupeKey: 'HSI.HK:UNREALIZED_LOSS_CHECK',
      data: {
        long: { seatVersion: 1, symbol: 'BULL.HK' },
        short: { seatVersion: 1, symbol: 'BEAR.HK' },
      },
    });

    unregister();

    queue.scheduleLatest({
      type: 'UNREALIZED_LOSS_CHECK',
      dedupeKey: 'HSI.HK:UNREALIZED_LOSS_CHECK:2',
      data: {
        long: { seatVersion: 1, symbol: 'BULL.HK' },
        short: { seatVersion: 1, symbol: 'BEAR.HK' },
      },
    });

    expect(calls).toBe(1);
  });

  it('removeTasks and clearAll return removed count and call onRemove', () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();

    queue.scheduleLatest({
      type: 'AUTO_SYMBOL_TICK',
      dedupeKey: 'A',
      data: {
        direction: 'LONG',
        seatVersion: 1,
        symbol: 'BULL.HK',
        currentTimeMs: 1,
        canTradeNow: true,
        openProtectionActive: false,
      },
    });

    queue.scheduleLatest({
      type: 'AUTO_SYMBOL_TICK',
      dedupeKey: 'B',
      data: {
        direction: 'SHORT',
        seatVersion: 2,
        symbol: 'BEAR.HK',
        currentTimeMs: 2,
        canTradeNow: true,
        openProtectionActive: false,
      },
    });

    const removedKeys: string[] = [];
    const removed = queue.removeTasks(
      (task) => task.dedupeKey === 'A',
      (task) => {
        removedKeys.push(task.dedupeKey);
      },
    );

    expect(removed).toBe(1);
    expect(removedKeys).toEqual(['A']);

    const clearedKeys: string[] = [];
    const cleared = queue.clearAll((task) => {
      clearedKeys.push(task.dedupeKey);
    });

    expect(cleared).toBe(1);
    expect(clearedKeys).toEqual(['B']);
    expect(queue.isEmpty()).toBeTrue();
  });
});
