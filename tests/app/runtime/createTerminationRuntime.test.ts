import { describe, expect, test } from 'bun:test';
import { createTerminationRuntime } from '../../../src/app/runtime/createTerminationRuntime.js';
import { createBuyTaskQueue } from '../../../src/main/asyncProgram/tradeTaskQueue/index.js';
import { createMonitorTaskQueue } from '../../../src/main/asyncProgram/monitorTaskQueue/index.js';

/** 终止入口同步顺序、原始首错及队列终态回归。 */

describe('RuntimeTermination', () => {
  test.each([null, undefined, new Error('first')])('首错不依赖 truthy：%s', async (error) => {
    const calls: string[] = [];
    const runtime = createTerminationRuntime({
      closeTradingGate: () => {
        calls.push('gate');
      },
      closeProducerAdmission: () => {
        calls.push('queues');
      },
      stopProducers: [
        () => {
          calls.push('stop1');
          throw new Error('secondary');
        },
        () => {
          calls.push('stop2');
        },
      ],
      onSecondaryError: () => {
        calls.push('secondary');
      },
    });
    runtime.reportFatalError(error);
    expect(runtime.isTerminated()).toBe(true);
    expect(calls).toEqual(['gate', 'queues', 'stop1', 'secondary', 'stop2']);
    expect(runtime.getFatalState()).toEqual({ hasFatalError: true, error });
    runtime.reportFatalError(new Error('later'));
    runtime.requestShutdown();
    expect(runtime.getFatalState()).toEqual({ hasFatalError: true, error });
    expect(calls.filter((call) => call === 'gate')).toHaveLength(1);
    await runtime.waitForTermination();
  });

  test('正常退出不制造 fatal，退出后的真实错误仍可锁存', async () => {
    const queue = createBuyTaskQueue();
    const monitorQueue = createMonitorTaskQueue<{ CHECK: { readonly value: number } }>();
    let trading = true;
    let notifications = 0;
    const runtime = createTerminationRuntime({
      closeTradingGate: () => {
        trading = false;
      },
      closeProducerAdmission: () => {
        queue.close();
        monitorQueue.close();
      },
      stopProducers: [],
      onSecondaryError: () => {},
    });
    monitorQueue.onTaskAdded(() => {
      notifications += 1;
    });

    expect(monitorQueue.scheduleLatest({ type: 'CHECK', dedupeKey: 'x', data: { value: 1 } })).toBe(
      true,
    );
    runtime.requestShutdown();
    expect(trading).toBe(false);
    expect(runtime.getFatalState()).toEqual({ hasFatalError: false });
    expect(monitorQueue.scheduleLatest({ type: 'CHECK', dedupeKey: 'x', data: { value: 2 } })).toBe(
      false,
    );
    expect(monitorQueue.pop()?.data.value).toBe(1);
    monitorQueue.clearAll();
    expect(monitorQueue.scheduleLatest({ type: 'CHECK', dedupeKey: 'x', data: { value: 3 } })).toBe(
      false,
    );

    monitorQueue.onTaskAdded(() => {
      notifications += 1;
    });
    expect(notifications).toBe(1);
    const lateError: unknown = undefined;
    runtime.reportFatalError(lateError);
    expect(runtime.getFatalState()).toEqual({ hasFatalError: true, error: undefined });
    await runtime.waitForTermination();
  });
});
