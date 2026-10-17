/** 监控任务队列诊断测试：失效 dedupe 占位不计深度/年龄，替换、移除、清空均观察真实有效 FIFO。 */
import { describe, expect, it } from 'bun:test';
import { DIAGNOSTIC_OPERATIONS } from '../../../../src/constants/diagnostics.js';
import { createMonitorTaskQueue } from '../../../../src/runtime/asyncProgram/monitorTaskQueue/index.js';
import type { DiagnosticFields } from '../../../../src/types/diagnostics.js';
import { createLoggerDouble } from '../../../helpers/testDoubles.js';

describe('monitor task queue diagnostics', () => {
  it('excludes cancelled placeholders, resets replacement age and records all effective mutations', () => {
    let nowMs = 100;
    const events: DiagnosticFields[] = [];
    const queue = createMonitorTaskQueue<Readonly<Record<'TICK', { readonly value: number }>>>({
      clock: { now: () => new Date(nowMs) },
      logger: createLoggerDouble(),
      diagnostics: {
        record: (operation, fields) => {
          expect(operation).toBe(DIAGNOSTIC_OPERATIONS.QUEUE_STATE);
          events.push(fields);
        },
      },
    });
    const original = Object.freeze({ value: 1 });
    queue.scheduleLatest({ type: 'TICK', dedupeKey: 'A', data: original });
    nowMs = 200;
    queue.scheduleLatest({ type: 'TICK', dedupeKey: 'B', data: { value: 2 } });
    nowMs = 300;
    queue.scheduleLatest({ type: 'TICK', dedupeKey: 'A', data: original });
    expect(events.at(-1)).toEqual({
      queue: 'MONITOR',
      mutation: 'replace',
      changedTaskCount: 1,
      depth: 2,
      oldestTaskAgeMs: 100,
    });
    nowMs = 350;
    expect(queue.removeTasks((task) => task.dedupeKey === 'B')).toBe(1);
    expect(events.at(-1)).toMatchObject({ mutation: 'remove', depth: 1, oldestTaskAgeMs: 50 });
    nowMs = 400;
    const task = queue.pop();
    expect(task?.data).toBe(original);
    expect(Object.keys(task ?? {}).sort((a, b) => a.localeCompare(b))).toEqual([
      'data',
      'dedupeKey',
      'id',
      'type',
    ]);
    expect(events.at(-1)).toMatchObject({ mutation: 'pop', depth: 0, oldestTaskAgeMs: 0 });
    expect(queue.pop()).toBeNull();
    expect(events.at(-1)).toMatchObject({ mutation: 'pop', changedTaskCount: 0, depth: 0 });
    queue.scheduleLatest({ type: 'TICK', dedupeKey: 'A', data: original });
    nowMs = 450;
    queue.scheduleLatest({ type: 'TICK', dedupeKey: 'A', data: original });
    expect(events.at(-1)).toMatchObject({ mutation: 'replace', depth: 1, oldestTaskAgeMs: 0 });
    expect(queue.clearAll()).toBe(1);
    expect(events.at(-1)).toMatchObject({ mutation: 'clear', changedTaskCount: 1, depth: 0 });
    expect(queue.clearAll()).toBe(0);
    expect(events.at(-1)).toMatchObject({ mutation: 'clear', changedTaskCount: 0, depth: 0 });
    queue.close();
    const recorded = events.length;
    expect(queue.scheduleLatest({ type: 'TICK', dedupeKey: 'A', data: original })).toBe(false);
    expect(events).toHaveLength(recorded);
  });

  it('samples push before synchronous consumer pop and isolates logger, observer and clock failures', () => {
    const events: DiagnosticFields[] = [];
    const queue = createMonitorTaskQueue<
      Readonly<Record<'SEAT_REFRESH', { readonly direction: string }>>
    >({
      clock: {
        now: () => {
          throw new Error('clock failed');
        },
      },
      logger: {
        ...createLoggerDouble(),
        debug: () => {
          throw new Error('logger failed');
        },
      },
      diagnostics: {
        record: (_operation, fields) => {
          events.push(fields);
          throw new Error('observer failed');
        },
      },
    });
    queue.scheduleLatest({ type: 'SEAT_REFRESH', dedupeKey: 'A', data: { direction: 'LONG' } });
    queue.scheduleLatest({ type: 'SEAT_REFRESH', dedupeKey: 'A', data: { direction: 'LONG' } });
    expect(events.at(-1)).toMatchObject({ mutation: 'replace', depth: 1, oldestTaskAgeMs: null });
    expect(queue.pop()?.data.direction).toBe('LONG');
    queue.onTaskAdded(() => {
      queue.pop();
    });

    expect(
      queue.scheduleLatest({ type: 'SEAT_REFRESH', dedupeKey: 'A', data: { direction: 'SHORT' } }),
    ).toBe(true);

    expect(events.slice(-2)).toMatchObject([
      { mutation: 'push', depth: 1 },
      { mutation: 'pop', depth: 0 },
    ]);
    expect(queue.isEmpty()).toBe(true);
  });
});
