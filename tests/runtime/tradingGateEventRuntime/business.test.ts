/**
 * TradingGateEventRuntime 失败协议测试
 *
 * 覆盖快照 fanout、同步 fatal 关门、原始首错与 autoAuth fail-fast，防止异步生产逃逸。
 */
import { describe, expect, it, spyOn } from 'bun:test';
import { createTerminationRuntime } from '../../../src/runtime/lifecycle/terminationRuntime.js';
import { createTradingGateEventRuntime } from '../../../src/runtime/tradingGateEventRuntime/index.js';

/** 明确验证同步抛错，避免 undefined 与未抛错被当成同一结果。 */
function getThrownValue(action: () => void): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }

  throw new Error('expected a synchronous throw');
}

const listenerFailures: ReadonlyArray<unknown> = [new Error('listener failed'), null, undefined];

describe('tradingGateEventRuntime', () => {
  it('发布前取快照：退订不跳过本轮 listener，新增 listener 只参与下一轮', () => {
    const termination = createTerminationRuntime({
      closeTradingGate: () => {},
      closeProducerAdmission: () => {},
      stopProducers: [],
      onSecondaryError: () => {},
    });
    const runtime = createTradingGateEventRuntime({ termination });
    const calls: string[] = [];
    const addedListener = () => {
      calls.push('added');
    };

    let unsubscribeSecond = () => {};

    runtime.onGateStateChanged(() => {
      calls.push('first');
      unsubscribeSecond();
      runtime.onGateStateChanged(addedListener);
    });

    unsubscribeSecond = runtime.onGateStateChanged(() => {
      calls.push('second');
    });

    runtime.onGateStateChanged(() => {
      calls.push('third');
    });

    runtime.emitGateStateChanged({ previousCanTrade: false, nextCanTrade: true });
    expect(calls).toEqual(['first', 'second', 'third']);

    runtime.emitGateStateChanged({ previousCanTrade: true, nextCanTrade: false });
    expect(calls).toEqual(['first', 'second', 'third', 'first', 'third', 'added']);
    expect(termination.isTerminated()).toBeFalse();
  });

  for (const firstError of listenerFailures) {
    it(`gate 首错 ${String(firstError)} 立即关门，全部快照完成后抛原值且不被次错/stop 错覆盖`, async () => {
      const secondError = new Error('second listener failed');
      const stopError = new Error('stop failed');
      const calls: string[] = [];
      const secondaryErrors: unknown[] = [];
      let canTrade = true;
      let admissionOpen = true;
      let stopped = false;
      let microtaskObservedClosed = false;
      let unsubscribeSecond = () => {};
      const termination = createTerminationRuntime({
        closeTradingGate: () => {
          canTrade = false;
        },
        closeProducerAdmission: () => {
          admissionOpen = false;
        },
        stopProducers: [
          () => {
            calls.push('stop-throw');
            unsubscribeSecond();
            throw stopError;
          },
          () => {
            calls.push('stop-last');
            stopped = true;
          },
        ],
        onSecondaryError: (error) => {
          secondaryErrors.push(error);
        },
      });
      const reportFatalError = spyOn(termination, 'reportFatalError');
      const runtime = createTradingGateEventRuntime({ termination });
      runtime.onGateStateChanged(() => {
        calls.push('first');
        queueMicrotask(() => {
          microtaskObservedClosed =
            termination.isTerminated() && !canTrade && !admissionOpen && stopped;
        });
        throw firstError;
      });

      unsubscribeSecond = runtime.onGateStateChanged(() => {
        calls.push('second');
        expect(termination.isTerminated()).toBeTrue();
        expect(canTrade).toBeFalse();
        expect(admissionOpen).toBeFalse();
        expect(stopped).toBeTrue();
        expect(reportFatalError).toHaveBeenNthCalledWith(1, firstError);
        throw secondError;
      });

      runtime.onGateStateChanged(() => {
        calls.push('third');
        expect(reportFatalError).toHaveBeenNthCalledWith(2, secondError);
      });

      expect(
        getThrownValue(() => {
          runtime.emitGateStateChanged({ previousCanTrade: true, nextCanTrade: false });
        }),
      ).toBe(firstError);
      expect(calls).toEqual(['first', 'stop-throw', 'stop-last', 'second', 'third']);
      expect(reportFatalError).toHaveBeenCalledTimes(2);
      expect(termination.getFatalState()).toEqual({ hasFatalError: true, error: firstError });
      expect(secondaryErrors).toEqual([stopError, secondError]);
      await Promise.resolve();
      expect(microtaskObservedClosed).toBeTrue();
    });
  }

  for (const firstError of listenerFailures) {
    it(`autoAuth 首错 ${String(firstError)} 先同步 fatal 再抛原值，不通知后续 listener`, async () => {
      let canTrade = true;
      let stopped = false;
      let laterListenerCalled = false;
      let microtaskObservedClosed = false;
      const stopError = new Error('stop failed');
      const secondaryErrors: unknown[] = [];
      const termination = createTerminationRuntime({
        closeTradingGate: () => {
          canTrade = false;
        },
        closeProducerAdmission: () => {},
        stopProducers: [
          () => {
            throw stopError;
          },
          () => {
            stopped = true;
          },
        ],
        onSecondaryError: (error) => {
          secondaryErrors.push(error);
        },
      });
      const reportFatalError = spyOn(termination, 'reportFatalError');
      const runtime = createTradingGateEventRuntime({ termination });
      runtime.onAutoSearchAuthorizationChanged(() => {
        queueMicrotask(() => {
          microtaskObservedClosed = termination.isTerminated() && !canTrade && stopped;
        });
        throw firstError;
      });

      runtime.onAutoSearchAuthorizationChanged(() => {
        laterListenerCalled = true;
      });

      expect(
        getThrownValue(() => {
          runtime.emitAutoSearchAuthorizationChanged({
            previousAuthorized: true,
            nextAuthorized: false,
          });
        }),
      ).toBe(firstError);
      expect(reportFatalError).toHaveBeenCalledTimes(1);
      expect(reportFatalError).toHaveBeenCalledWith(firstError);
      expect(termination.getFatalState()).toEqual({ hasFatalError: true, error: firstError });
      expect(canTrade).toBeFalse();
      expect(stopped).toBeTrue();
      expect(laterListenerCalled).toBeFalse();
      expect(secondaryErrors).toEqual([stopError]);
      await Promise.resolve();
      expect(microtaskObservedClosed).toBeTrue();
    });
  }
});
