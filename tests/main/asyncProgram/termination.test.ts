import { describe, expect, test } from 'bun:test';
import { createBaseProcessor } from '../../../src/main/asyncProgram/utils.js';
import { createBuyTaskQueue } from '../../../src/main/asyncProgram/tradeTaskQueue/index.js';
import { createTerminationRuntime } from '../../../src/app/runtime/createTerminationRuntime.js';
import { createSignalDouble } from '../../helpers/testDoubles.js';

/** 异步处理器最终终态与可恢复 stop 的离线回归。 */

async function flushImmediate(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

describe('processor termination', () => {
  test('普通 stop/restart 可恢复；最终 close 后 restart 不重新订阅或消费', async () => {
    const queue = createBuyTaskQueue();
    const calls: string[] = [];
    let subscriptions = 0;
    const termination = createTerminationRuntime({
      closeTradingGate: () => {},
      closeProducerAdmission: queue.close,
      stopProducers: [],
      onSecondaryError: () => {},
    });
    const processor = createBaseProcessor({
      loggerPrefix: 'test',
      taskQueue: {
        ...queue,
        onTaskAdded: (callback) => {
          subscriptions += 1;
          return queue.onTaskAdded(callback);
        },
      },
      processTask: async (task) => {
        calls.push(task.data.symbol);
      },
      termination,
    });
    processor.start();
    processor.stop();
    expect(
      queue.push({ type: 'STRATEGY_BUY', data: createSignalDouble('BUYCALL', 'FIRST.HK') }),
    ).toBe(true);
    processor.restart();
    await flushImmediate();
    expect(calls).toEqual(['FIRST.HK']);
    termination.requestShutdown();
    const before = subscriptions;
    processor.restart();
    processor.start();
    expect(
      queue.push({ type: 'STRATEGY_BUY', data: createSignalDouble('BUYCALL', 'LATE.HK') }),
    ).toBe(false);
    await flushImmediate();
    expect(subscriptions).toBe(before);
    expect(calls).toEqual(['FIRST.HK']);
    await processor.stopAndDrain();
  });
});
