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
          if (operation === DIAGNOSTIC_OPERATIONS.QUEUE_STATE) events.push(fields);
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
        record: (operation, fields) => {
          if (operation === DIAGNOSTIC_OPERATIONS.QUEUE_STATE) events.push(fields);
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

  it('records each committed signal mutation once with its real cleanup reason and no empty/rejected facts', () => {
    const events: DiagnosticFields[] = [];
    const queue = createBuyTaskQueue({
      clock: { now: () => new Date(0) },
      diagnostics: {
        record: (operation, fields) => {
          if (operation === DIAGNOSTIC_OPERATIONS.SIGNAL_QUEUE_EVENT) events.push(fields);
        },
      },
    });
    const signals = ['FIRST', 'REMOVE', 'CLEAR', 'REMOVE_AGAIN'].map((symbol) => ({
      ...buySignal,
      symbol,
      ...(symbol === 'FIRST' ? { triggerTime: new Date(123) } : {}),
      ...(['REMOVE', 'CLEAR'].includes(symbol) ? { triggerTime: new Date(Number.NaN) } : {}),
    }));
    for (const data of signals) queue.push({ type: 'STRATEGY_BUY', data });

    expect(queue.pop()?.data).toBe(signals[0]);
    let predicateCalls = 0;
    expect(
      queue.removeTasks(
        (task) => {
          predicateCalls += 1;
          return task.data.symbol.startsWith('REMOVE');
        },
        { reasonCode: 'SEAT_RUNTIME_CLEANUP' },
      ),
    ).toBe(2);
    expect(predicateCalls).toBe(3);
    expect(queue.clearAll({ reasonCode: 'DAY_CLEAR' })).toBe(1);
    expect(
      events.map(({ mutation, symbol, outcome, reasonCode }) => ({
        mutation,
        symbol,
        outcome,
        reasonCode,
      })),
    ).toEqual([
      ...signals.map(({ symbol }) => ({
        mutation: 'push',
        symbol,
        outcome: 'ENQUEUED',
        reasonCode: 'QUEUE_PUSH',
      })),
      { mutation: 'pop', symbol: 'FIRST', outcome: 'DEQUEUED', reasonCode: 'QUEUE_POP' },
      {
        mutation: 'remove',
        symbol: 'REMOVE',
        outcome: 'REMOVED',
        reasonCode: 'SEAT_RUNTIME_CLEANUP',
      },
      {
        mutation: 'remove',
        symbol: 'REMOVE_AGAIN',
        outcome: 'REMOVED',
        reasonCode: 'SEAT_RUNTIME_CLEANUP',
      },
      { mutation: 'clear', symbol: 'CLEAR', outcome: 'CLEARED', reasonCode: 'DAY_CLEAR' },
    ]);

    expect(events[0]).toMatchObject({
      stage: 'TRADE_QUEUE',
      queue: 'BUY',
      action: 'BUYCALL',
      seatVersion: 1,
      triggerTimeMs: 123,
    });

    for (const event of events) {
      if (event['symbol'] === 'FIRST') expect(event['triggerTimeMs']).toBe(123);
      else expect(event).not.toHaveProperty('triggerTimeMs');
    }

    expect(queue.removeTasks(() => true)).toBe(0);
    expect(queue.clearAll()).toBe(0);
    expect(queue.pop()).toBeNull();
    queue.close();
    expect(queue.push({ type: 'STRATEGY_BUY', data: buySignal })).toBeFalse();
    expect(events).toHaveLength(8);
  });

  it('commits no removals or diagnostics when the original one-pass predicate throws', () => {
    const events: string[] = [];
    const queue = createBuyTaskQueue({
      clock: { now: () => new Date(0) },
      diagnostics: {
        record: (operation) => {
          events.push(operation);
        },
      },
    });
    for (const symbol of ['FIRST', 'SECOND', 'THIRD'])
      queue.push({ type: 'STRATEGY_BUY', data: { ...buySignal, symbol } });

    const before = events.length;
    let predicateCalls = 0;
    expect(() =>
      queue.removeTasks((task) => {
        predicateCalls += 1;
        if (task.data.symbol === 'SECOND') throw new Error('predicate failure');

        return true;
      }),
    ).toThrow('predicate failure');
    expect(predicateCalls).toBe(2);
    expect(events).toHaveLength(before);
    expect([queue.pop()?.data.symbol, queue.pop()?.data.symbol, queue.pop()?.data.symbol]).toEqual([
      'FIRST',
      'SECOND',
      'THIRD',
    ]);
  });

  it('records push before a synchronous consumer pop without additional diagnostic clock reads', () => {
    const facts: string[] = [];
    let clockReads = 0;
    const queue = createBuyTaskQueue({
      clock: {
        now: () => {
          clockReads += 1;
          return new Date(0);
        },
      },
      diagnostics: {
        record: (operation, fields) => {
          if (operation === DIAGNOSTIC_OPERATIONS.SIGNAL_QUEUE_EVENT)
            facts.push(String(fields['outcome']));
        },
      },
    });
    queue.onTaskAdded(() => {
      expect(queue.pop()?.data).toBe(buySignal);
    });
    expect(queue.push({ type: 'STRATEGY_BUY', data: buySignal })).toBeTrue();
    expect(facts).toEqual(['ENQUEUED', 'DEQUEUED']);
    expect(clockReads).toBe(3);
  });

  it('uses UNSPECIFIED only when a removal caller omits context', () => {
    const facts: DiagnosticFields[] = [];
    const queue = createSellTaskQueue({
      clock: { now: () => new Date(0) },
      diagnostics: {
        record: (operation, fields) => {
          if (operation === DIAGNOSTIC_OPERATIONS.SIGNAL_QUEUE_EVENT) facts.push(fields);
        },
      },
    });
    queue.push({ type: 'STRATEGY_SELL', data: sellSignal });
    expect(queue.removeTasks(() => true)).toBe(1);
    queue.push({ type: 'STRATEGY_SELL', data: sellSignal });
    expect(queue.clearAll()).toBe(1);
    expect(facts.filter((fields) => fields['reasonCode'] === 'UNSPECIFIED')).toHaveLength(2);
    expect(facts.at(-1)).toMatchObject({ queue: 'SELL', action: 'SELLCALL', outcome: 'CLEARED' });
  });

  it('isolates diagnostic field construction failures after every successful mutation', () => {
    let notifications = 0;
    const data = Object.defineProperty({ ...buySignal }, 'triggerTime', {
      get: () => {
        throw new Error('diagnostic field failure');
      },
    });
    const queue = createBuyTaskQueue({
      clock: { now: () => new Date(0) },
      diagnostics: { record: () => {} },
    });
    queue.onTaskAdded(() => {
      notifications += 1;
    });
    expect(queue.push({ type: 'STRATEGY_BUY', data })).toBeTrue();
    expect(queue.pop()?.data).toBe(data);
    queue.push({ type: 'STRATEGY_BUY', data });
    expect(queue.removeTasks(() => true)).toBe(1);
    queue.push({ type: 'STRATEGY_BUY', data });
    expect(queue.clearAll()).toBe(1);
    expect(notifications).toBe(3);
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
