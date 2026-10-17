import { createDiagnosticObserverDouble } from '../../../helpers/diagnostics.js';
import { createLoggerDouble, createSignalDouble } from '../../../helpers/testDoubles.js';

/** 普通 SELL runtime 镜像：application 重试指令回流 FIFO，取消句柄与迟到结果不恢复旧任务。 */
import { describe, expect, it } from 'bun:test';
import { createSellProcessor } from '../../../../src/runtime/asyncProgram/sellProcessor/index.js';
import { createSellTaskQueue } from '../../../../src/runtime/asyncProgram/tradeTaskQueue/index.js';

import { waitUntil } from '../../../helpers/asyncProgram.js';
import type { ExecutableSellSignal } from '../../../../src/types/signal.js';
import type {
  OrdinarySellWorkflow,
  SellQuoteRetry,
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
  let cancelled = 0;
  return {
    callbacks,
    getCancelled: () => cancelled,
    scheduler: {
      scheduleTimer: (callback: () => void) => {
        callbacks.push(callback);
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
      const queue = createSellTaskQueue({
        clock: { now: () => new Date() },
        diagnostics: createDiagnosticObserverDouble(),
      });
      const timers = schedulerFixture();
      const original = signal();
      const retrySignal = { ...original, triggerTime: new Date(original.triggerTime) };
      const normalSameDemand = { ...original };
      const normalAfter = signal('SECOND.HK');
      const calls: ExecutableSellSignal[] = [];
      const worker = createSellProcessor({
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
    },
  );

  it('cancels timer on stopAndDrain and an already-dispatched callback cannot enqueue after restart', async () => {
    const queue = createSellTaskQueue({
      clock: { now: () => new Date() },
      diagnostics: createDiagnosticObserverDouble(),
    });
    const timers = schedulerFixture();
    let calls = 0;
    const worker = createSellProcessor({
      logger: createLoggerDouble(),
      taskQueue: queue,
      scheduler: timers.scheduler,
      termination,
      getCanProcessTask: () => true,
      workflow: {
        execute: async (value) => {
          calls += 1;
          return { status: 'RETRY', retry: retry(value, 1) };
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
  });
});
