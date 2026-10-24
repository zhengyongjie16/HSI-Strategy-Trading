import { createDiagnosticObserverDouble } from '../../helpers/diagnostics.js';
import { createLoggerDouble, createSignalDouble } from '../../helpers/testDoubles.js';

/** FIFO processor 终态与可恢复 stop/restart；不会重新打开最终 admission。 */
import { describe, expect, test } from 'bun:test';
import { DIAGNOSTIC_OPERATIONS } from '../../../src/constants/diagnostics.js';
import { createBaseProcessor } from '../../../src/runtime/asyncProgram/processor.js';
import type { DiagnosticFields } from '../../../src/types/diagnostics.js';
import { createBuyTaskQueue } from '../../../src/runtime/asyncProgram/tradeTaskQueue/index.js';
import { createTerminationRuntime } from '../../../src/runtime/lifecycle/terminationRuntime.js';

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
  test.each(['normal', 'observerThrows', 'fieldThrows', 'invalidTime'] as const)(
    'pop 后关闭门禁的 %s 诊断不改检查次数、FIFO 或 fatal 路由',
    async (mode) => {
      const queue = createBuyTaskQueue({
        clock: { now: () => new Date(0) },
        diagnostics: createDiagnosticObserverDouble(),
      });
      const events: DiagnosticFields[] = [];
      const popped: string[] = [];
      const fatals: unknown[] = [];
      let gateCalls = 0;
      let businessCalls = 0;
      const first = {
        action: 'BUYCALL' as const,
        symbol: 'FIRST.HK',
        symbolName: null,
        seatVersion: 1,
        ...(mode === 'invalidTime' ? { triggerTime: new Date(Number.NaN) } : {}),
      };
      const second = { ...first, symbol: 'SECOND.HK', triggerTime: new Date(123) };
      if (mode === 'fieldThrows') {
        Object.defineProperty(first, 'triggerTime', {
          get: () => {
            throw new Error('diagnostic field failure');
          },
        });
      }

      for (const data of [first, second]) queue.push({ type: 'STRATEGY_BUY', data });

      const processor = createBaseProcessor({
        diagnostics: {
          record: (operation, fields) => {
            expect(operation).toBe(DIAGNOSTIC_OPERATIONS.SIGNAL_PROCESSING_OUTCOME);
            events.push(fields);
            if (mode === 'observerThrows') throw new Error('observer unavailable');
          },
        },
        logger: createLoggerDouble(),
        loggerPrefix: 'gate',
        taskQueue: {
          ...queue,
          pop: () => {
            const task = queue.pop();
            if (task) popped.push(task.data.symbol);

            return task;
          },
        },
        getCanProcessTask: () => {
          gateCalls += 1;
          return false;
        },
        processTask: async () => {
          businessCalls += 1;
        },
        termination: {
          isTerminated: () => false,
          reportFatalError: (error) => {
            fatals.push(error);
          },
        },
      });
      processor.start();
      await flushImmediate();
      await processor.stopAndDrain();
      expect(popped).toEqual(['FIRST.HK', 'SECOND.HK']);
      expect(gateCalls).toBe(2);
      expect(businessCalls).toBe(0);
      expect(fatals).toEqual([]);
      expect(events).toHaveLength(mode === 'fieldThrows' ? 1 : 2);
      expect(events.at(-1)).toEqual({
        stage: 'PROCESSOR',
        outcome: 'SKIPPED',
        reasonCode: 'PROCESSOR_GATE_CLOSED',
        symbol: 'SECOND.HK',
        action: 'BUYCALL',
        seatVersion: second.seatVersion,
        triggerTimeMs: 123,
      });

      if (mode !== 'fieldThrows') expect(events[0]).not.toHaveProperty('triggerTimeMs');
    },
  );

  test('普通 stop/restart 可恢复；最终 close 后 restart 不重新订阅或消费', async () => {
    const queue = createBuyTaskQueue({
      clock: { now: () => new Date() },
      diagnostics: createDiagnosticObserverDouble(),
    });
    const calls: string[] = [];
    let subscriptions = 0;
    const termination = createTerminationRuntime({
      closeTradingGate: () => {},
      closeProducerAdmission: queue.close,
      stopProducers: [],
      onSecondaryError: () => {},
    });
    const processor = createBaseProcessor({
      diagnostics: createDiagnosticObserverDouble(),
      logger: createLoggerDouble(),
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
