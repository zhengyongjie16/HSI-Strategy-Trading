/** 普通 BUY runtime 镜像：FIFO 串行、入队门禁、独立 stop/drain 只调度 application。 */
import { describe, expect, it } from 'bun:test';
import { createBuyProcessor } from '../../../../src/runtime/asyncProgram/buyProcessor/index.js';
import { createBuyTaskQueue } from '../../../../src/runtime/asyncProgram/tradeTaskQueue/index.js';
import { createSignalDouble } from '../../../helpers/testDoubles.js';
import { waitUntil } from '../../../main/asyncProgram/utils.js';

const termination = {
  isTerminated: () => false,
  reportFatalError: (error: unknown) => {
    throw error;
  },
};

describe('BUY FIFO worker', () => {
  it('processes one task at a time in original FIFO order and drains the in-flight owner', async () => {
    const queue = createBuyTaskQueue();
    const calls: string[] = [];
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const worker = createBuyProcessor({
      taskQueue: queue,
      termination,
      getCanProcessTask: () => true,
      workflow: {
        execute: async (signal) => {
          calls.push(signal.symbol);
          if (signal.symbol === 'FIRST.HK') await pending;
        },
      },
    });
    worker.start();
    for (const symbol of ['FIRST.HK', 'SECOND.HK'])
      queue.push({ type: 'STRATEGY_BUY', data: createSignalDouble('BUYCALL', symbol) });

    await waitUntil(() => calls.length === 1);
    await Bun.sleep(5);
    expect(calls).toEqual(['FIRST.HK']);
    if (release === undefined) throw new Error('release not installed');

    release();
    await waitUntil(() => calls.length === 2);
    await worker.stopAndDrain();
    expect(calls).toEqual(['FIRST.HK', 'SECOND.HK']);
  });

  it('does not enter the application when the queue admission gate is closed', async () => {
    const queue = createBuyTaskQueue();
    let calls = 0;
    const worker = createBuyProcessor({
      taskQueue: queue,
      termination,
      getCanProcessTask: () => false,
      workflow: {
        execute: async () => {
          calls += 1;
        },
      },
    });
    worker.start();
    queue.push({ type: 'STRATEGY_BUY', data: createSignalDouble('BUYCALL', 'BULL.HK') });
    await waitUntil(queue.isEmpty);
    await worker.stopAndDrain();
    expect(calls).toBe(0);
  });
});
