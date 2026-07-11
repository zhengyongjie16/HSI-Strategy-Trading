/**
 * registerDelayedSignalHandlers 业务测试
 *
 * 功能：
 * - 验证延迟验证通过后的信号分流边界。
 */
import { describe, expect, it } from 'bun:test';

import { registerDelayedSignalHandlers } from '../../../src/app/wiring/registerDelayedSignalHandlers.js';
import { createIndicatorCache } from '../../../src/main/asyncProgram/indicatorCache/index.js';
import { createDelayedSignalVerifier } from '../../../src/main/asyncProgram/delayedSignalVerifier/index.js';
import { createLastState } from '../../main/asyncProgram/utils.js';
import { createSignal } from '../../../mock/factories/signalFactory.js';
import {
  createDelayedSignalVerifierDouble,
  createMonitorContextDouble,
  createSignalDouble,
  createSymbolRegistryDouble,
} from '../../helpers/testDoubles.js';

import type { Signal } from '../../../src/types/signal.js';
import type {
  BuyTaskType,
  SellTaskType,
  TaskQueue,
} from '../../../src/main/asyncProgram/tradeTaskQueue/types.js';

type QueuedTask<TType extends string> = Parameters<TaskQueue<TType>['push']>[0];

type TimerHarness = Readonly<{
  advanceBy: (delayMs: number) => void;
  restore: () => void;
}>;

type DelayedSignalHandlerHarness = Readonly<{
  callbackRef: { current: (signal: Signal) => void };
  monitorSymbol: string;
  buyTasks: QueuedTask<BuyTaskType>[];
  sellTasks: QueuedTask<SellTaskType>[];
  buyTaskQueue: TaskQueue<BuyTaskType>;
  sellTaskQueue: TaskQueue<SellTaskType>;
  monitorContext: ReturnType<typeof createMonitorContext>;
}>;

function createTimerHarness(initialNowMs: number): TimerHarness {
  const originalNow = Date.now;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let nowMs = initialNowMs;
  const timers = new Map<unknown, { readonly atMs: number; readonly callback: () => void }>();

  const fakeSetTimeout = Object.assign(
    (
      handler: Parameters<typeof globalThis.setTimeout>[0],
      timeout?: number,
    ): ReturnType<typeof originalSetTimeout> => {
      if (typeof handler !== 'function') {
        throw new TypeError('[测试] fake timer 仅支持函数回调');
      }

      const handle = originalSetTimeout(() => {}, 0);
      originalClearTimeout(handle);
      timers.set(handle, {
        atMs: nowMs + (typeof timeout === 'number' ? timeout : 0),
        callback: () => {
          handler();
        },
      });
      return handle;
    },
    {
      __promisify__: originalSetTimeout.__promisify__,
    },
  );

  Date.now = () => nowMs;
  globalThis.setTimeout = fakeSetTimeout;
  globalThis.clearTimeout = (handle) => {
    timers.delete(handle);
  };

  return {
    advanceBy: (delayMs: number): void => {
      nowMs += delayMs;
      const dueTimers = [...timers.entries()].filter(([, timer]) => timer.atMs <= nowMs);
      for (const [handle, timer] of dueTimers) {
        timers.delete(handle);
        timer.callback();
      }
    },
    restore: (): void => {
      Date.now = originalNow;
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    },
  };
}

function createTaskQueueDouble<TType extends string>(): TaskQueue<TType> {
  return {
    push: () => {},
    pop: () => null,
    isEmpty: () => true,
    removeTasks: () => 0,
    clearAll: () => 0,
    onTaskAdded: () => () => {},
  };
}

function createMonitorContext(
  monitorSymbol: string,
  callbackRef: { current: (signal: Signal) => void },
) {
  const symbolRegistry = createSymbolRegistryDouble();
  const monitorContext = createMonitorContextDouble({
    symbolRegistry,
    monitorSymbolName: monitorSymbol,
    delayedSignalVerifier: createDelayedSignalVerifierDouble({
      onVerified: (callback: (signal: Signal) => void) => {
        callbackRef.current = callback;
      },
    }),
  });

  return monitorContext;
}

function createHarness(): DelayedSignalHandlerHarness {
  const callbackRef: { current: (signal: Signal) => void } = {
    current: () => {
      throw new Error('verified callback not registered');
    },
  };
  const buyTasks: QueuedTask<BuyTaskType>[] = [];
  const sellTasks: QueuedTask<SellTaskType>[] = [];
  const buyTaskQueue = createTaskQueueDouble<BuyTaskType>();
  const sellTaskQueue = createTaskQueueDouble<SellTaskType>();
  const monitorSymbol = 'HSI.HK';

  buyTaskQueue.push = (task) => {
    buyTasks.push(task);
  };

  sellTaskQueue.push = (task) => {
    sellTasks.push(task);
  };

  return {
    callbackRef,
    monitorSymbol,
    buyTasks,
    sellTasks,
    buyTaskQueue,
    sellTaskQueue,
    monitorContext: createMonitorContext(monitorSymbol, callbackRef),
  };
}

describe('registerDelayedSignalHandlers business flow', () => {
  it('drops HOLD signal without enqueuing buy or sell tasks', () => {
    const harness = createHarness();

    registerDelayedSignalHandlers({
      monitorContext: harness.monitorContext,
      lastState: createLastState({
        isTradingEnabled: true,
        canTrade: true,
        isHalfDay: false,
      }),
      buyTaskQueue: harness.buyTaskQueue,
      sellTaskQueue: harness.sellTaskQueue,
      logger: {
        debug: () => {},
        warn: () => {},
      },
      doomsdayProtectionEnabled: false,
    });

    harness.callbackRef.current(createSignalDouble('HOLD', 'BULL.HK'));

    expect(harness.buyTasks).toHaveLength(0);
    expect(harness.sellTasks).toHaveLength(0);
  });

  it('enqueues previously pending verified buy signal during afternoon opening protection', () => {
    const triggerTimeMs = new Date('2026-03-09T12:59:50+08:00').getTime();
    const timerHarness = createTimerHarness(triggerTimeMs);
    const indicatorCache = createIndicatorCache({});
    const delayedSignalVerifier = createDelayedSignalVerifier({ indicatorCache });
    const harness = createHarness();
    const lastState = createLastState({
      isTradingEnabled: true,
      canTrade: true,
      openProtectionActive: false,
      isHalfDay: false,
    });
    const monitorContext = createMonitorContextDouble({
      ...harness.monitorContext,
      delayedSignalVerifier,
    });

    try {
      registerDelayedSignalHandlers({
        monitorContext,
        lastState,
        buyTaskQueue: harness.buyTaskQueue,
        sellTaskQueue: harness.sellTaskQueue,
        logger: {
          debug: () => {},
          warn: () => {},
        },
        doomsdayProtectionEnabled: true,
        now: () => new Date('2026-03-09T13:01:00+08:00'),
      });

      for (const [timestamp, value] of [
        [triggerTimeMs, 11],
        [triggerTimeMs + 5_000, 12],
        [triggerTimeMs + 10_000, 13],
      ] as const) {
        indicatorCache.push({ K: { kind: 'value', value } }, timestamp);
      }

      delayedSignalVerifier.addSignal({
        signal: createSignal({
          action: 'BUYCALL',
          symbol: 'BULL.HK',
          triggerTimeMs,
          indicators1: { K: 10 },
        }),
        verificationIndicators: ['K'],
      });

      expect(delayedSignalVerifier.getPendingCount()).toBe(1);
      expect(harness.buyTasks).toHaveLength(0);

      lastState.openProtectionActive = true;
      timerHarness.advanceBy(10_000);

      expect(delayedSignalVerifier.getPendingCount()).toBe(0);
      expect(harness.buyTasks).toHaveLength(1);
      expect(harness.buyTasks[0]?.type).toBe('VERIFIED_BUY');
      expect(harness.buyTasks[0]?.data.action).toBe('BUYCALL');
      expect(harness.buyTasks[0]?.data.symbol).toBe('BULL.HK');
      expect(harness.sellTasks).toHaveLength(0);
    } finally {
      delayedSignalVerifier.destroy();
      timerHarness.restore();
    }
  });

  it('enqueues verified sell signal', () => {
    const harness = createHarness();

    registerDelayedSignalHandlers({
      monitorContext: harness.monitorContext,
      lastState: createLastState({
        isTradingEnabled: true,
        canTrade: true,
        isHalfDay: false,
      }),
      buyTaskQueue: harness.buyTaskQueue,
      sellTaskQueue: harness.sellTaskQueue,
      logger: {
        debug: () => {},
        warn: () => {},
      },
      doomsdayProtectionEnabled: false,
      now: () => new Date('2026-03-09T09:35:00+08:00'),
    });

    harness.callbackRef.current(createSignalDouble('SELLPUT', 'BEAR.HK'));

    expect(harness.buyTasks).toHaveLength(0);
    expect(harness.sellTasks).toHaveLength(1);
    expect(harness.sellTasks[0]?.data.action).toBe('SELLPUT');
    expect(harness.sellTasks[0]?.data.symbol).toBe('BEAR.HK');
  });

  it('drops verified ordinary signal during doomsday clearance takeover window', () => {
    const harness = createHarness();

    registerDelayedSignalHandlers({
      monitorContext: harness.monitorContext,
      lastState: createLastState({
        isTradingEnabled: true,
        canTrade: true,
        isHalfDay: false,
      }),
      buyTaskQueue: harness.buyTaskQueue,
      sellTaskQueue: harness.sellTaskQueue,
      logger: {
        debug: () => {},
        warn: () => {},
      },
      doomsdayProtectionEnabled: true,
      now: () => new Date('2026-03-09T15:56:00+08:00'),
    });

    harness.callbackRef.current(createSignalDouble('BUYCALL', 'BULL.HK'));

    expect(harness.buyTasks).toHaveLength(0);
    expect(harness.sellTasks).toHaveLength(0);
  });
});
