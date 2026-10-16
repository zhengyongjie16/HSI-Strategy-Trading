import { createRuntimeStateFixtures } from '../../helpers/runtimeStateFixtures.js';

/**
 * 启动重建后的 runtime 协调单测。
 * 验证具体 owner 顺序、交易开关恢复、pending 时的持续时间唤醒以及终止/异常阻断。
 */
import { describe, expect, it } from 'bun:test';
import { startRuntimeAfterStartupRebuild } from '../../../src/runtime/lifecycle/startupRuntime.js';
import { createTerminationRuntime } from '../../../src/runtime/lifecycle/terminationRuntime.js';
import type { StartRuntimeAfterStartupRebuildParams } from '../../../src/runtime/lifecycle/startup/types.js';

function createStartHarness(initialRebuildSucceeded: boolean = true) {
  const calls: string[] = [];
  const tradingAtStart: boolean[] = [];
  const stateFixtures = createRuntimeStateFixtures({
    tradingTimeState: {},
    lifecycleState: { isTradingEnabled: false },
    tradingCalendarState: {},
    quoteSubscriptionState: {},
  });
  const termination = createTerminationRuntime({
    closeTradingGate: () => {
      stateFixtures.lifecycleState.isTradingEnabled = false;
    },
    closeProducerAdmission: () => {},
    stopProducers: [],
    onSecondaryError: () => {},
  });
  const recordStart = (name: string): void => {
    calls.push(name);
    tradingAtStart.push(stateFixtures.lifecycleState.isTradingEnabled);
  };
  const params: StartRuntimeAfterStartupRebuildParams = {
    termination,
    initialRebuildSucceeded,
    startupTradingEnabled: true,
    ...stateFixtures,
    tradingQuoteDisplayRuntime: {
      start: () => {
        recordStart('tradingQuoteDisplay');
      },
    },
    quoteSubscriptionRuntime: {
      start: () => {
        recordStart('quoteSubscription');
      },
    },
    seatRuntimeCleanupDispatcher: {
      start: () => {
        recordStart('seatRuntimeCleanup');
      },
    },
    seatActivationDispatcher: {
      start: () => {
        recordStart('seatActivation');
      },
    },
    autoSearchWakeupRuntime: {
      start: () => {
        recordStart('autoSearch');
      },
    },
    periodicSwitchWakeupRuntime: {
      start: () => {
        recordStart('periodicSwitch');
      },
    },
    monitorDisplayRuntime: {
      start: () => {
        recordStart('monitorDisplay');
      },
    },
    tradingRiskEventRuntime: {
      start: () => {
        recordStart('tradingRisk');
      },
    },
    monitorQuoteEventRuntime: {
      start: () => {
        recordStart('monitorQuote');
      },
    },
    switchWakeupRuntime: {
      start: () => {
        recordStart('switchWakeup');
      },
    },
    monitorTaskProcessor: {
      start: () => {
        recordStart('monitorProcessor');
      },
    },
    buyProcessor: {
      start: () => {
        recordStart('buyProcessor');
      },
    },
    sellProcessor: {
      start: () => {
        recordStart('sellProcessor');
      },
    },
    orderMonitor: {
      startRuntime: () => {
        recordStart('orderMonitor');
      },
    },
    timeWakeupRuntime: {
      start: async () => {
        recordStart('timeWakeup');
      },
    },
    businessEventProgram: {
      start: () => {
        recordStart('businessEventProgram');
      },
    },
  };
  return { params, calls, tradingAtStart, termination };
}

describe('startRuntimeAfterStartupRebuild', () => {
  it('恢复原交易开关，按既有 owner 顺序启动，首轮时间评估完成后才启动业务 owner', async () => {
    const { params, calls, tradingAtStart } = createStartHarness();
    const evaluation = Promise.withResolvers<undefined>();
    const started = startRuntimeAfterStartupRebuild({
      ...params,
      timeWakeupRuntime: {
        start: async () => {
          calls.push('timeWakeup');
          await evaluation.promise;
        },
      },
    });
    expect(calls).toEqual([
      'tradingQuoteDisplay',
      'quoteSubscription',
      'seatRuntimeCleanup',
      'seatActivation',
      'autoSearch',
      'periodicSwitch',
      'monitorDisplay',
      'tradingRisk',
      'monitorQuote',
      'switchWakeup',
      'monitorProcessor',
      'buyProcessor',
      'sellProcessor',
      'orderMonitor',
      'timeWakeup',
    ]);
    expect(params.lifecycleState.isTradingEnabled).toBe(true);
    expect(tradingAtStart.every(Boolean)).toBe(true);
    evaluation.resolve();
    await started;
    expect(calls.at(-1)).toBe('businessEventProgram');
  });

  it('原交易开关关闭时不擅自放行，但成功重建仍恢复 runtime owner', async () => {
    const { params, calls, tradingAtStart } = createStartHarness();
    await startRuntimeAfterStartupRebuild({ ...params, startupTradingEnabled: false });
    expect(params.lifecycleState.isTradingEnabled).toBe(false);
    expect(tradingAtStart.every((value) => !value)).toBe(true);
    expect(calls.at(-1)).toBe('businessEventProgram');
  });

  it('API_RETRY_PENDING 保持交易关闭且业务 owner 静止，但启动 TimeWakeup 等待生命周期恢复', async () => {
    const { params, calls } = createStartHarness(false);
    await startRuntimeAfterStartupRebuild(params);
    expect(params.lifecycleState.isTradingEnabled).toBe(false);
    expect(calls).toEqual(['timeWakeup']);
  });

  it('进入协调前已终止时，不恢复交易也不启动时间或业务 owner', async () => {
    const { params, calls, termination } = createStartHarness();
    termination.requestShutdown();
    await startRuntimeAfterStartupRebuild(params);
    expect(params.lifecycleState.isTradingEnabled).toBe(false);
    expect(calls).toEqual([]);
  });

  it('TimeWakeup 首轮评估触发终止后，不再启动 BusinessEventProgram', async () => {
    const { params, calls, termination } = createStartHarness();
    await startRuntimeAfterStartupRebuild({
      ...params,
      timeWakeupRuntime: {
        start: async () => {
          calls.push('timeWakeup');
          termination.requestShutdown();
        },
      },
    });
    expect(calls.at(-1)).toBe('timeWakeup');
    expect(calls).not.toContain('businessEventProgram');
    expect(params.lifecycleState.isTradingEnabled).toBe(false);
  });

  it('TimeWakeup 的原始失败交给顶层 fatal/cleanup，不吞错或继续启动业务 owner', async () => {
    const { params, calls } = createStartHarness();
    const failure = new Error('time wakeup failed');
    const started = startRuntimeAfterStartupRebuild({
      ...params,
      timeWakeupRuntime: {
        start: () => Promise.reject(failure),
      },
    });
    expect(await started.catch((error: unknown) => error)).toBe(failure);
    expect(calls).not.toContain('businessEventProgram');
  });

  it('具体 owner 同步启动失败立即向顶层传播，不启动后续 owner 或执行替代 cleanup', async () => {
    const { params, calls } = createStartHarness();
    const failure = new Error('subscription start failed');
    const started = startRuntimeAfterStartupRebuild({
      ...params,
      quoteSubscriptionRuntime: {
        start: () => {
          calls.push('quoteSubscription');
          throw failure;
        },
      },
    });
    expect(await started.catch((error: unknown) => error)).toBe(failure);
    expect(calls).toEqual(['tradingQuoteDisplay', 'quoteSubscription']);
  });
});
