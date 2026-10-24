import { createDiagnosticObserverDouble } from '../../../helpers/diagnostics.js';
import { createLoggerDouble, createSignalDouble } from '../../../helpers/testDoubles.js';

/** 普通 SELL runtime 镜像：application 重试指令回流 FIFO，取消句柄与迟到结果不恢复旧任务。 */
import { describe, expect, it } from 'bun:test';
import { DIAGNOSTIC_OPERATIONS } from '../../../../src/constants/diagnostics.js';
import { createSellProcessor } from '../../../../src/runtime/asyncProgram/sellProcessor/index.js';
import type { DiagnosticFields } from '../../../../src/types/diagnostics.js';
import { createSellTaskQueue } from '../../../../src/runtime/asyncProgram/tradeTaskQueue/index.js';

import { waitUntil } from '../../../helpers/asyncProgram.js';
import type { ExecutableSellSignal } from '../../../../src/types/signal.js';
import type {
  OrdinarySellWorkflow,
  SellQuoteRetry,
  SellExecutionOutcome,
} from '../../../../src/application/ordinarySell/types.js';

const termination = {
  isTerminated: () => false,
  reportFatalError: (error: unknown) => {
    throw error;
  },
};

/** 只记录 callback；返回真实可取消句柄，测试显式触发调度，不自行实现业务重试。 */
function schedulerFixture() {
  const callbacks: Array<() => void> = [];
  const delays: number[] = [];
  let cancelled = 0;
  return {
    callbacks,
    delays,
    getCancelled: () => cancelled,
    scheduler: {
      scheduleTimer: (callback: () => void, delayMs: number) => {
        callbacks.push(callback);
        delays.push(delayMs);
        const handle = setTimeout(() => {}, 60_000);
        clearTimeout(handle);
        return handle;
      },
      clearTimer: (handle: ReturnType<typeof setTimeout>) => {
        cancelled += 1;
        clearTimeout(handle);
      },
    },
  };
}

function signal(symbol = 'BULL.HK') {
  return {
    ...createSignalDouble('SELLCALL', symbol),
    triggerTime: new Date('2026-02-16T02:00:00Z'),
  };
}

/** application 的明确重试指令替身，仅供验证 runtime 不改变次数/身份/授权。 */
function retry(signalValue: ExecutableSellSignal, attempts: number): SellQuoteRetry {
  return { signal: signalValue, attempts, dayEpoch: 7, delayMs: 123, isCurrent: () => true };
}

describe('SELL FIFO retry scheduling', () => {
  it.each([Date.parse('2026-02-16T02:00:00Z'), Number.NaN])(
    'records schedule and coalescence without changing timer, budget or authorization (trigger time: %s)',
    async (triggerTimeMs) => {
      const events: DiagnosticFields[] = [];
      const queue = createSellTaskQueue({
        clock: { now: () => new Date(0) },
        diagnostics: createDiagnosticObserverDouble(),
      });
      const timers = schedulerFixture();
      const first = { ...signal(), triggerTime: new Date(triggerTimeMs) };
      const duplicate = { ...first };
      let currentReads = 0;
      let gateReads = 0;
      const decision = {
        ...retry(first, 3),
        isCurrent: () => {
          currentReads += 1;
          return true;
        },
      };
      const attempts: Array<SellQuoteRetry | null> = [];
      const worker = createSellProcessor({
        diagnostics: {
          record: (operation, fields) => {
            if (operation === DIAGNOSTIC_OPERATIONS.SIGNAL_PROCESSING_OUTCOME) events.push(fields);
          },
        },
        logger: createLoggerDouble(),
        taskQueue: queue,
        scheduler: timers.scheduler,
        termination,
        getCanProcessTask: () => {
          gateReads += 1;
          return true;
        },
        workflow: {
          execute: async (value, attempt) => {
            attempts.push(attempt.retry);
            if (attempt.retry !== null) return { status: 'COMPLETED' };

            return { status: 'RETRY', retry: value === first ? decision : retry(duplicate, 99) };
          },
        },
      });
      worker.start();
      for (const data of [first, duplicate]) queue.push({ type: 'STRATEGY_SELL', data });

      await waitUntil(() => events.length === 2);
      expect(timers.callbacks).toHaveLength(1);
      expect(timers.delays).toEqual([123]);
      expect(currentReads).toBe(0);
      expect(
        events.map(({ outcome, reasonCode, retryAttempts }) => ({
          outcome,
          reasonCode,
          retryAttempts,
        })),
      ).toEqual([
        { outcome: 'RETRY_SCHEDULED', reasonCode: 'QUOTE_RETRY_REQUESTED', retryAttempts: 3 },
        { outcome: 'RETRY_COALESCED', reasonCode: 'RETRY_ALREADY_SCHEDULED', retryAttempts: 3 },
      ]);

      expect(events[0]).toMatchObject({
        stage: 'SELL_RETRY_RUNTIME',
        action: first.action,
        symbol: first.symbol,
        seatVersion: first.seatVersion,
      });

      for (const event of events) {
        if (Number.isFinite(triggerTimeMs)) expect(event['triggerTimeMs']).toBe(triggerTimeMs);
        else expect(event).not.toHaveProperty('triggerTimeMs');
      }

      timers.callbacks[0]?.();
      await waitUntil(() => attempts.length === 3);
      await worker.stopAndDrain();
      expect(currentReads).toBe(1);
      expect(gateReads).toBe(3);
      expect(attempts).toEqual([null, null, decision]);
      expect(events).toHaveLength(2);
    },
  );

  it('records authorization invalidation at the original single isCurrent check without re-enqueueing', async () => {
    const events: DiagnosticFields[] = [];
    const queue = createSellTaskQueue({
      clock: { now: () => new Date(0) },
      diagnostics: createDiagnosticObserverDouble(),
    });
    const timers = schedulerFixture();
    let currentReads = 0;
    const worker = createSellProcessor({
      diagnostics: {
        record: (operation, fields) => {
          if (operation === DIAGNOSTIC_OPERATIONS.SIGNAL_PROCESSING_OUTCOME) events.push(fields);
        },
      },
      logger: createLoggerDouble(),
      taskQueue: queue,
      scheduler: timers.scheduler,
      termination,
      getCanProcessTask: () => true,
      workflow: {
        execute: async (value) => ({
          status: 'RETRY',
          retry: {
            ...retry(value, 4),
            isCurrent: () => {
              currentReads += 1;
              return false;
            },
          },
        }),
      },
    });
    worker.start();
    queue.push({ type: 'STRATEGY_SELL', data: signal() });
    await waitUntil(() => timers.callbacks.length === 1);
    timers.callbacks[0]?.();
    await worker.stopAndDrain();
    expect(currentReads).toBe(1);
    expect(queue.isEmpty()).toBeTrue();
    expect(timers.getCancelled()).toBe(0);
    expect(
      events.map(({ outcome, reasonCode, retryAttempts }) => ({
        outcome,
        reasonCode,
        retryAttempts,
      })),
    ).toEqual([
      { outcome: 'RETRY_SCHEDULED', reasonCode: 'QUOTE_RETRY_REQUESTED', retryAttempts: 4 },
      { outcome: 'RETRY_DISCARDED', reasonCode: 'RETRY_NOT_CURRENT', retryAttempts: 4 },
    ]);
  });

  it('records a late in-flight result as inactive without scheduling an application-issued retry', async () => {
    const events: DiagnosticFields[] = [];
    const queue = createSellTaskQueue({
      clock: { now: () => new Date(0) },
      diagnostics: createDiagnosticObserverDouble(),
    });
    const timers = schedulerFixture();
    const deferred = Promise.withResolvers<SellExecutionOutcome>();
    let calls = 0;
    const worker = createSellProcessor({
      diagnostics: {
        record: (operation, fields) => {
          if (operation === DIAGNOSTIC_OPERATIONS.SIGNAL_PROCESSING_OUTCOME) events.push(fields);
        },
      },
      logger: createLoggerDouble(),
      taskQueue: queue,
      scheduler: timers.scheduler,
      termination,
      getCanProcessTask: () => true,
      workflow: {
        execute: () => {
          calls += 1;
          return deferred.promise;
        },
      },
    });
    worker.start();
    const value = signal();
    queue.push({ type: 'STRATEGY_SELL', data: value });
    await waitUntil(() => calls === 1);
    const draining = worker.stopAndDrain();
    deferred.resolve({ status: 'RETRY', retry: retry(value, 1) });
    await draining;
    expect(timers.callbacks).toHaveLength(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ outcome: 'ABORTED', reasonCode: 'PROCESSOR_INACTIVE' });
  });

  it.each(['observer', 'field'] as const)(
    'isolates %s failures from retry scheduling, authorization and FIFO consumption',
    async (failure) => {
      const queue = createSellTaskQueue({
        clock: { now: () => new Date(0) },
        diagnostics: createDiagnosticObserverDouble(),
      });
      const timers = schedulerFixture();
      const original = signal();
      const retrySignal = { ...original };
      let failField = failure === 'field';
      Object.defineProperty(retrySignal, 'triggerTime', {
        get: () => {
          if (failField) throw new Error('diagnostic field unavailable');

          return original.triggerTime;
        },
      });
      const attempts: Array<SellQuoteRetry | null> = [];
      let currentReads = 0;
      const decision = {
        ...retry(retrySignal, 2),
        isCurrent: () => {
          currentReads += 1;
          return true;
        },
      };
      const worker = createSellProcessor({
        diagnostics: {
          record: () => {
            throw new Error('observer unavailable');
          },
        },
        logger: createLoggerDouble(),
        taskQueue: queue,
        scheduler: timers.scheduler,
        termination,
        getCanProcessTask: () => true,
        workflow: {
          execute: async (_value, attempt) => {
            attempts.push(attempt.retry);
            return attempt.retry === null
              ? { status: 'RETRY', retry: decision }
              : { status: 'COMPLETED' };
          },
        },
      });
      worker.start();
      queue.push({ type: 'STRATEGY_SELL', data: original });
      await waitUntil(() => timers.callbacks.length === 1);
      failField = false;
      timers.callbacks[0]?.();
      await waitUntil(() => attempts.length === 2);
      await worker.stopAndDrain();
      expect(attempts).toEqual([null, decision]);
      expect(currentReads).toBe(1);
      expect(timers.delays).toEqual([123]);
      expect(queue.isEmpty()).toBeTrue();
    },
  );

  it('keeps FIFO moving while quote retry waits and passes the original instruction back to owner', async () => {
    const queue = createSellTaskQueue({
      clock: { now: () => new Date() },
      diagnostics: createDiagnosticObserverDouble(),
    });
    const timers = schedulerFixture();
    const calls: string[] = [];
    const first = signal();
    const decision = retry(first, 1);
    const workflow: OrdinarySellWorkflow = {
      execute: async (value, attempt) => {
        calls.push(value.symbol);
        if (value.symbol === 'BULL.HK' && attempt.retry === null)
          return { status: 'RETRY', retry: decision };

        if (value.symbol === 'BULL.HK') expect(attempt.retry).toBe(decision);

        return { status: 'COMPLETED' };
      },
    };
    const worker = createSellProcessor({
      diagnostics: createDiagnosticObserverDouble(),
      logger: createLoggerDouble(),
      taskQueue: queue,
      workflow,
      scheduler: timers.scheduler,
      termination,
      getCanProcessTask: () => true,
    });
    worker.start();
    for (const data of [first, signal('SECOND.HK')]) queue.push({ type: 'STRATEGY_SELL', data });

    await waitUntil(() => calls.length === 2);
    expect(calls).toEqual(['BULL.HK', 'SECOND.HK']);
    const callback = timers.callbacks[0];
    if (callback === undefined) throw new Error('retry not scheduled');

    callback();
    await waitUntil(() => calls.length === 3);
    await worker.stopAndDrain();
    expect(calls).toEqual(['BULL.HK', 'SECOND.HK', 'BULL.HK']);
  });

  it('schedules every unresolved round using application-issued attempts instead of losing the second retry', async () => {
    const queue = createSellTaskQueue({
      clock: { now: () => new Date() },
      diagnostics: createDiagnosticObserverDouble(),
    });
    const timers = schedulerFixture();
    const attempts: number[] = [];
    const worker = createSellProcessor({
      diagnostics: createDiagnosticObserverDouble(),
      logger: createLoggerDouble(),
      taskQueue: queue,
      scheduler: timers.scheduler,
      termination,
      getCanProcessTask: () => true,
      workflow: {
        execute: async (value, attempt) => {
          const next = (attempt.retry?.attempts ?? 0) + 1;
          attempts.push(next);
          return next <= 2
            ? { status: 'RETRY', retry: retry(value, next) }
            : { status: 'COMPLETED' };
        },
      },
    });
    worker.start();
    queue.push({ type: 'STRATEGY_SELL', data: signal() });
    await waitUntil(() => timers.callbacks.length === 1);
    const first = timers.callbacks[0];
    if (!first) throw new Error('first retry missing');

    first();
    await waitUntil(() => timers.callbacks.length === 2);
    const second = timers.callbacks[1];
    if (!second) throw new Error('second retry missing');

    second();
    await waitUntil(() => attempts.length === 3);
    await worker.stopAndDrain();
    expect(attempts).toEqual([1, 2, 3]);
  });

  it.each(['stop', 'stopAndDrain', 'restart'] as const)(
    '%s removes an already re-enqueued retry by exact signal identity and preserves ordinary FIFO tasks',
    async (operation) => {
      const facts: DiagnosticFields[] = [];
      const processing: DiagnosticFields[] = [];
      const diagnostics = {
        record: (name: string, fields: DiagnosticFields) => {
          if (name === DIAGNOSTIC_OPERATIONS.SIGNAL_QUEUE_EVENT) facts.push(fields);

          if (name === DIAGNOSTIC_OPERATIONS.SIGNAL_PROCESSING_OUTCOME) processing.push(fields);
        },
      };
      const queue = createSellTaskQueue({
        clock: { now: () => new Date() },
        diagnostics,
      });
      const timers = schedulerFixture();
      const original = signal();
      const retrySignal = { ...original, triggerTime: new Date(original.triggerTime) };
      const normalSameDemand = { ...original };
      const normalAfter = signal('SECOND.HK');
      const calls: ExecutableSellSignal[] = [];
      const worker = createSellProcessor({
        diagnostics,
        logger: createLoggerDouble(),
        taskQueue: queue,
        scheduler: timers.scheduler,
        termination,
        getCanProcessTask: () => true,
        workflow: {
          execute: async (value, attempt) => {
            calls.push(value);
            if (value === original) return { status: 'RETRY', retry: retry(retrySignal, 4) };

            expect(attempt.retry).toBeNull();
            return { status: 'COMPLETED' };
          },
        },
      });
      worker.start();
      queue.push({ type: 'STRATEGY_SELL', data: original });
      await waitUntil(() => timers.callbacks.length === 1);
      const callback = timers.callbacks[0];
      if (callback === undefined) throw new Error('retry missing');

      queue.push({ type: 'STRATEGY_SELL', data: normalSameDemand });
      callback();
      queue.push({ type: 'STRATEGY_SELL', data: normalAfter });
      // timer callback 已 push，但 worker 的下一轮 setImmediate 尚未消费。
      if (operation === 'stopAndDrain') await worker.stopAndDrain();
      else worker[operation]();

      if (operation !== 'restart') worker.restart();

      await waitUntil(() => calls.length >= 3);
      await worker.stopAndDrain();
      expect(calls).toEqual([original, normalSameDemand, normalAfter]);
      expect(calls.includes(retrySignal)).toBeFalse();
      expect(queue.isEmpty()).toBeTrue();
      expect(timers.callbacks).toHaveLength(1);
      expect(facts.filter((fact) => fact['outcome'] === 'REMOVED')).toEqual([
        {
          stage: 'TRADE_QUEUE',
          outcome: 'REMOVED',
          reasonCode: 'RETRY_CLEANUP',
          queue: 'SELL',
          mutation: 'remove',
          symbol: retrySignal.symbol,
          action: retrySignal.action,
          seatVersion: retrySignal.seatVersion,
          triggerTimeMs: retrySignal.triggerTime.getTime(),
        },
      ]);
      expect(processing.filter((event) => event['outcome'] === 'RETRY_CLEARED')).toHaveLength(1);
      expect(processing.at(-1)).toMatchObject({
        outcome: 'RETRY_CLEARED',
        reasonCode: 'PROCESSOR_STOPPED',
        retryAttempts: 4,
      });
    },
  );

  it('cancels timer on stopAndDrain and an already-dispatched callback cannot enqueue after restart', async () => {
    const events: DiagnosticFields[] = [];
    const queue = createSellTaskQueue({
      clock: { now: () => new Date() },
      diagnostics: createDiagnosticObserverDouble(),
    });
    const timers = schedulerFixture();
    let calls = 0;
    let currentReads = 0;
    const worker = createSellProcessor({
      diagnostics: {
        record: (operation, fields) => {
          if (operation === DIAGNOSTIC_OPERATIONS.SIGNAL_PROCESSING_OUTCOME) events.push(fields);
        },
      },
      logger: createLoggerDouble(),
      taskQueue: queue,
      scheduler: timers.scheduler,
      termination,
      getCanProcessTask: () => true,
      workflow: {
        execute: async (value) => {
          calls += 1;
          return {
            status: 'RETRY',
            retry: {
              ...retry(value, 1),
              isCurrent: () => {
                currentReads += 1;
                return true;
              },
            },
          };
        },
      },
    });
    worker.start();
    queue.push({ type: 'STRATEGY_SELL', data: signal() });
    await waitUntil(() => timers.callbacks.length === 1);
    const callback = timers.callbacks[0];
    if (!callback) throw new Error('retry missing');

    await worker.stopAndDrain();
    worker.restart();
    callback();
    await Bun.sleep(10);
    await worker.stopAndDrain();
    expect(timers.getCancelled()).toBe(1);
    expect(queue.isEmpty()).toBeTrue();
    expect(calls).toBe(1);
    expect(currentReads).toBe(0);
    expect(
      events.map(({ outcome, reasonCode, retryAttempts }) => ({
        outcome,
        reasonCode,
        retryAttempts,
      })),
    ).toEqual([
      { outcome: 'RETRY_SCHEDULED', reasonCode: 'QUOTE_RETRY_REQUESTED', retryAttempts: 1 },
      { outcome: 'RETRY_CLEARED', reasonCode: 'PROCESSOR_STOPPED', retryAttempts: 1 },
      { outcome: 'RETRY_DISCARDED', reasonCode: 'PROCESSOR_INACTIVE', retryAttempts: 1 },
    ]);
  });
});
