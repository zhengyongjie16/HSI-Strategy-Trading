/** 共享替身契约测试：终态/首错使用真实运行时语义，strategy 不恢复旧 owner。 */
import { describe, expect, it } from 'bun:test';
import {
  createMonitorContextDouble,
  createStrategyDouble,
  createTerminationDouble,
} from './testDoubles.js';

describe('shared runtime doubles', () => {
  it.each([null, undefined])(
    'latches raw first fatal even with an observing override (%s)',
    async (error) => {
      const errors: unknown[] = [];
      const termination = createTerminationDouble({
        reportFatalError: (value) => {
          errors.push(value);
        },
      });
      termination.reportFatalError(error);
      expect(termination.isTerminated()).toBe(true);
      termination.reportFatalError(new Error('secondary'));
      expect(termination.getFatalState()).toEqual({ hasFatalError: true, error });
      expect(errors).toHaveLength(2);
      await termination.waitForTermination();
    },
  );

  it('normal shutdown does not invent fatal, while late real failure is retained', () => {
    const termination = createTerminationDouble();
    termination.requestShutdown();
    expect(termination.isTerminated()).toBe(true);
    expect(termination.getFatalState()).toEqual({ hasFatalError: false });
    const lateError = new Error('late resource failure');
    termination.reportFatalError(lateError);
    expect(termination.getFatalState()).toEqual({ hasFatalError: true, error: lateError });
  });

  it('injects the complete neutral strategy identity without old context owners', () => {
    const strategy = createStrategyDouble();
    const context = createMonitorContextDouble({ strategy });
    expect(context.strategy).toBe(strategy);
    expect(Object.keys(strategy).sort((left, right) => left.localeCompare(right))).toEqual([
      'destroy',
      'invalidateAll',
      'invalidateDirection',
      'onCandlestick',
      'resetForTradingDay',
      'strategyId',
    ]);
    expect(Object.hasOwn(context, 'state')).toBe(false);
    expect(Object.hasOwn(context, 'indicatorProfile')).toBe(false);
    expect(Object.hasOwn(context, 'delayedSignalVerifier')).toBe(false);
  });
});
