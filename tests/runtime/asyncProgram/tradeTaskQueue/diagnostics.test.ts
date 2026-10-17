/** 买卖任务队列诊断测试：真实 mutation 的深度/最旧年龄、私有时间与旁路失败隔离。 */
import { describe, expect, it } from 'bun:test';
import { DIAGNOSTIC_OPERATIONS } from '../../../../src/constants/diagnostics.js';
import {
  createBuyTaskQueue,
  createSellTaskQueue,
} from '../../../../src/runtime/asyncProgram/tradeTaskQueue/index.js';
import type { DiagnosticFields } from '../../../../src/types/diagnostics.js';
import type { BuySignal, SellSignal } from '../../../../src/types/signal.js';

const buySignal: BuySignal = Object.freeze({
  symbol: 'BULL.HK',
  symbolName: null,
  action: 'BUYCALL',
  seatVersion: 1,
});
const sellSignal: SellSignal = Object.freeze({ ...buySignal, action: 'SELLCALL' });

describe('trade task queue diagnostics', () => {
  it('reports BUY depth and oldest age after each mutation, without changing signal identity', () => {
    let nowMs = 100;
    const events: DiagnosticFields[] = [];
    const queue = createBuyTaskQueue({
      clock: { now: () => new Date(nowMs) },
      diagnostics: {
        record: (operation, fields) => {
          expect(operation).toBe(DIAGNOSTIC_OPERATIONS.QUEUE_STATE);
          events.push(fields);
        },
      },
    });
    expect(queue.push({ type: 'STRATEGY_BUY', data: buySignal })).toBe(true);
    nowMs = 130;
    queue.push({ type: 'STRATEGY_BUY', data: buySignal });
    nowMs = 160;
    const task = queue.pop();
    expect(task?.data).toBe(buySignal);
    expect(Object.keys(task ?? {}).sort((a, b) => a.localeCompare(b))).toEqual(['data', 'type']);
    expect(Object.keys(buySignal).sort((a, b) => a.localeCompare(b))).toEqual([
      'action',
      'seatVersion',
      'symbol',
      'symbolName',
    ]);
    nowMs = 200;
    expect(queue.removeTasks(() => false)).toBe(0);
    nowMs = 250;
    expect(queue.clearAll()).toBe(1);
    expect(queue.pop()).toBeNull();
    expect(events).toEqual([
      { queue: 'BUY', mutation: 'push', changedTaskCount: 1, depth: 1, oldestTaskAgeMs: 0 },
      { queue: 'BUY', mutation: 'push', changedTaskCount: 1, depth: 2, oldestTaskAgeMs: 30 },
      { queue: 'BUY', mutation: 'pop', changedTaskCount: 1, depth: 1, oldestTaskAgeMs: 30 },
      { queue: 'BUY', mutation: 'remove', changedTaskCount: 0, depth: 1, oldestTaskAgeMs: 70 },
      { queue: 'BUY', mutation: 'clear', changedTaskCount: 1, depth: 0, oldestTaskAgeMs: 0 },
      { queue: 'BUY', mutation: 'pop', changedTaskCount: 0, depth: 0, oldestTaskAgeMs: 0 },
    ]);
    queue.close();
    expect(queue.push({ type: 'STRATEGY_BUY', data: buySignal })).toBe(false);
    expect(events).toHaveLength(6);
  });

  it('keeps SELL timing after remove and FIFO compaction', () => {
    let nowMs = 1_000;
    const events: DiagnosticFields[] = [];
    const queue = createSellTaskQueue({
      clock: { now: () => new Date(nowMs) },
      diagnostics: {
        record: (_operation, fields) => {
          events.push(fields);
        },
      },
    });
    for (let index = 0; index < 70; index += 1) {
      queue.push({ type: 'STRATEGY_SELL', data: { ...sellSignal, symbol: String(index) } });
    }

    nowMs = 1_500;
    for (let index = 0; index < 65; index += 1) queue.pop();

    expect(events.at(-1)).toMatchObject({ queue: 'SELL', depth: 5, oldestTaskAgeMs: 500 });
    expect(queue.removeTasks((task) => task.data.symbol === '65')).toBe(1);
    expect(events.at(-1)).toMatchObject({ mutation: 'remove', depth: 4, oldestTaskAgeMs: 500 });
    nowMs = 1_600;
    expect(queue.pop()?.data.symbol).toBe('66');
    expect(events.at(-1)).toMatchObject({ mutation: 'pop', depth: 3, oldestTaskAgeMs: 600 });
    expect(queue.clearAll()).toBe(3);
    expect(events.at(-1)).toMatchObject({ mutation: 'clear', depth: 0, oldestTaskAgeMs: 0 });
  });

  it('does not let diagnostic observer or private clock failures change admission, callbacks or pop', () => {
    const queue = createBuyTaskQueue({
      clock: {
        now: () => {
          throw new Error('clock unavailable');
        },
      },
      diagnostics: {
        record: () => {
          throw new Error('diagnostic unavailable');
        },
      },
    });
    let notified = 0;
    queue.onTaskAdded(() => {
      notified += 1;
    });
    expect(queue.push({ type: 'STRATEGY_BUY', data: buySignal })).toBe(true);
    expect(notified).toBe(1);
    expect(queue.pop()?.data).toBe(buySignal);
    expect(queue.removeTasks(() => true)).toBe(0);
    expect(queue.clearAll()).toBe(0);
  });
});
