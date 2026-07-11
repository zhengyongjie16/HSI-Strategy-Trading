/**
 * createCleanup 业务测试
 *
 * 功能：
 * - 验证退出时排空处理器、销毁延迟验证器与释放资源的流程与边界。
 */
import { describe, expect, it } from 'bun:test';
import { createCleanup } from '../../../src/app/shutdown/createCleanup.js';
import {
  createDelayedSignalVerifierDouble,
  createMonitorContextDouble,
} from '../../helpers/testDoubles.js';
import { createLastState, createMonitorState, registerCleanupSteps } from './utils.js';

describe('cleanup business flow', () => {
  it('executes each registered disposer exactly once across repeated execute calls', async () => {
    let disposeCount = 0;
    const cleanup = createCleanup();
    cleanup.register({
      phase: 'RESET_MARKET_DATA_RUNTIME',
      step: '释放测试资源',
      handler: () => {
        disposeCount += 1;
      },
    });

    await cleanup.execute();
    await cleanup.execute();

    expect(disposeCount).toBe(1);
  });

  it('fails fast when a cleanup handler reenters execute without running disposers twice', async () => {
    let disposeCount = 0;
    const cleanup = createCleanup();
    cleanup.register({
      phase: 'RESET_MARKET_DATA_RUNTIME',
      step: '触发 execute 重入',
      handler: async () => {
        disposeCount += 1;
        await cleanup.execute();
      },
    });

    const outcome = await Promise.race([
      cleanup.execute().then(
        () => ({ status: 'fulfilled' as const }),
        (error: unknown) => ({ status: 'rejected' as const, error }),
      ),
      Bun.sleep(50).then(() => ({ status: 'timeout' as const })),
    ]);

    expect(outcome.status).toBe('rejected');
    if (outcome.status !== 'rejected') {
      throw new Error('cleanup.execute 未按预期拒绝重入');
    }

    expect(outcome.error).toBeInstanceOf(AggregateError);
    if (!(outcome.error instanceof AggregateError)) {
      throw new Error('cleanup.execute 未聚合重入失败');
    }

    expect(outcome.error.errors).toHaveLength(1);
    expect(outcome.error.errors[0]).toEqual(
      new Error('[Cleanup] cleanup 正在同步启动，禁止从清理 handler 重入 execute'),
    );
    expect(disposeCount).toBe(1);
  });

  it('rejects synchronous resource registration after cleanup execution starts', async () => {
    let disposeCount = 0;
    const cleanup = createCleanup();
    cleanup.register({
      phase: 'RESET_MARKET_DATA_RUNTIME',
      step: '触发执行中登记',
      handler: () => {
        disposeCount += 1;
        expect(() => {
          cleanup.register({
            phase: 'RESET_MARKET_DATA_RUNTIME',
            step: '迟到的资源',
            handler: () => {
              disposeCount += 100;
            },
          });
        }).toThrow('[Cleanup] cleanup 已开始执行，禁止继续登记资源');
      },
    });

    const firstExecution = cleanup.execute();
    const repeatedExecution = cleanup.execute();

    expect(repeatedExecution).toBe(firstExecution);
    await firstExecution;
    expect(disposeCount).toBe(1);
  });

  it('drains the order monitor before unsubscribing its final order-state listener', async () => {
    const steps: string[] = [];
    const cleanup = createCleanup();
    cleanup.register({
      phase: 'UNSUBSCRIBE_TRADER_LISTENER',
      step: '取消 Trader 订单状态监听',
      handler: () => {
        steps.push('unsubscribe');
      },
    });

    cleanup.register({
      phase: 'STOP_ORDER_MONITOR_RUNTIME',
      step: '停止订单监控 runtime',
      handler: () => {
        steps.push('stopAndDrain');
      },
    });

    await cleanup.execute();

    expect(steps).toEqual(['stopAndDrain', 'unsubscribe']);
  });

  it('drains processors, destroys delayed verifiers and releases monitor snapshots', async () => {
    const steps: string[] = [];
    const monitorState = createMonitorState('HSI.HK');
    const monitorContext = createMonitorContextDouble({
      delayedSignalVerifier: createDelayedSignalVerifierDouble({
        destroy: () => {
          steps.push('destroyVerifier');
        },
      }),
    });
    const lastState = createLastState(monitorState);

    const cleanup = createCleanup();
    registerCleanupSteps(cleanup, steps, { monitorContext, lastState });

    await cleanup.execute();

    expect(steps).toEqual([
      'abortWaiting',
      'timeWakeupRuntime',
      'businessEventProgram',
      'tradingRiskEventRuntime',
      'monitorQuoteEventRuntime',
      'monitorDisplayRuntime',
      'tradingQuoteDisplayRuntime',
      'switchWakeupRuntime',
      'periodicSwitchWakeupRuntime',
      'autoSearchWakeupRuntime',
      'seatActivationDispatcher',
      'monitorTask',
      'seatRuntimeCleanupDispatcher',
      'buy',
      'sell',
      'stopOrderMonitorRuntimeAndDrain',
      'unsubscribeTraderListener',
      'quoteSubscriptionRuntime',
      'postTradeConsistencyRuntime',
      'destroyVerifier',
      'clearIndicatorCache',
      'resetMarketData',
    ]);
    expect(monitorState.lastMonitorSnapshot).toBeNull();
  });

  it('does not mutate detached snapshot objects during cleanup', async () => {
    const steps: string[] = [];
    const monitorState = createMonitorState('HSI.HK');
    const detachedSnapshot = monitorState.lastMonitorSnapshot;
    const monitorContext = createMonitorContextDouble({
      delayedSignalVerifier: createDelayedSignalVerifierDouble({
        destroy: () => {
          steps.push('destroyVerifier');
        },
      }),
    });
    const lastState = createLastState(monitorState);

    const cleanup = createCleanup();
    registerCleanupSteps(cleanup, steps, { monitorContext, lastState });

    await cleanup.execute();

    expect(detachedSnapshot?.kdj).toEqual({ k: 50, d: 50, j: 50 });
    expect(detachedSnapshot?.macd).toEqual({ macd: 0, dif: 0, dea: 0 });
  });

  it('resets market data runtime at the end of cleanup', async () => {
    const steps: string[] = [];
    const cleanup = createCleanup();
    registerCleanupSteps(cleanup, steps);

    await cleanup.execute();

    expect(steps).toEqual([
      'abortWaiting',
      'timeWakeupRuntime',
      'businessEventProgram',
      'tradingRiskEventRuntime',
      'monitorQuoteEventRuntime',
      'monitorDisplayRuntime',
      'tradingQuoteDisplayRuntime',
      'switchWakeupRuntime',
      'periodicSwitchWakeupRuntime',
      'autoSearchWakeupRuntime',
      'seatActivationDispatcher',
      'monitorTask',
      'seatRuntimeCleanupDispatcher',
      'buy',
      'sell',
      'stopOrderMonitorRuntimeAndDrain',
      'unsubscribeTraderListener',
      'quoteSubscriptionRuntime',
      'postTradeConsistencyRuntime',
      'clearIndicatorCache',
      'resetMarketData',
    ]);
  });

  it('continues remaining cleanup steps and throws aggregate error when one step fails', async () => {
    const steps: string[] = [];
    const monitorState = createMonitorState('HSI.HK');
    const monitorContext = createMonitorContextDouble({
      delayedSignalVerifier: createDelayedSignalVerifierDouble({
        destroy: () => {
          steps.push('destroyVerifier');
        },
      }),
    });
    const lastState = createLastState(monitorState);

    const cleanup = createCleanup();
    registerCleanupSteps(cleanup, steps, {
      monitorContext,
      lastState,
      stopBuyProcessorAndDrain: async () => {
        steps.push('buy');
        throw new Error('buy failed');
      },
    });

    let caught: unknown = null;
    try {
      await cleanup.execute();
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    expect(steps).toEqual([
      'abortWaiting',
      'timeWakeupRuntime',
      'businessEventProgram',
      'tradingRiskEventRuntime',
      'monitorQuoteEventRuntime',
      'monitorDisplayRuntime',
      'tradingQuoteDisplayRuntime',
      'switchWakeupRuntime',
      'periodicSwitchWakeupRuntime',
      'autoSearchWakeupRuntime',
      'seatActivationDispatcher',
      'monitorTask',
      'seatRuntimeCleanupDispatcher',
      'buy',
      'sell',
      'stopOrderMonitorRuntimeAndDrain',
      'unsubscribeTraderListener',
      'quoteSubscriptionRuntime',
      'postTradeConsistencyRuntime',
      'destroyVerifier',
      'clearIndicatorCache',
      'resetMarketData',
    ]);
    expect(monitorState.lastMonitorSnapshot).toBeNull();
  });

  it('closes trading gate before draining processors during cleanup', async () => {
    const steps: string[] = [];
    const lastState = createLastState(createMonitorState('HSI.HK'));
    const cleanup = createCleanup();
    registerCleanupSteps(cleanup, steps, {
      lastState,
      stopBuyProcessorAndDrain: async () => {
        steps.push(`buy:${lastState.isTradingEnabled ? 'open' : 'closed'}`);
      },
    });

    await cleanup.execute();

    expect(steps).toContain('buy:closed');
  });

  it('aborts freshness waiters before draining blocked processors', async () => {
    const steps: string[] = [];
    let releaseBlockedProcessor: (() => void) | null = null;
    const blockedProcessor = new Promise<void>((resolve) => {
      releaseBlockedProcessor = resolve;
    });

    const cleanup = createCleanup();
    registerCleanupSteps(cleanup, steps, {
      stopBuyProcessorAndDrain: async () => {
        steps.push('buy');
        await blockedProcessor;
      },
      abortWaiting: () => {
        steps.push('abortWaiting');
        releaseBlockedProcessor?.();
      },
    });

    const outcome = await Promise.race([
      cleanup.execute().then(() => 'done' as const),
      Bun.sleep(50).then(() => 'timeout' as const),
    ]);

    if (outcome === 'timeout') {
      throw new Error('cleanup.execute timed out while waiting for blocked processor');
    }

    expect(outcome).toBe('done');
    expect(steps[0]).toBe('abortWaiting');
    expect(steps[1]).toBe('timeWakeupRuntime');
    expect(steps[2]).toBe('businessEventProgram');
    expect(steps[3]).toBe('tradingRiskEventRuntime');
    expect(steps[4]).toBe('monitorQuoteEventRuntime');
    expect(steps[5]).toBe('monitorDisplayRuntime');
    expect(steps[6]).toBe('tradingQuoteDisplayRuntime');
    expect(steps[7]).toBe('switchWakeupRuntime');
    expect(steps[8]).toBe('periodicSwitchWakeupRuntime');
    expect(steps[9]).toBe('autoSearchWakeupRuntime');
    expect(steps[10]).toBe('seatActivationDispatcher');
    expect(steps[11]).toBe('monitorTask');
    expect(steps[12]).toBe('seatRuntimeCleanupDispatcher');
    expect(steps[steps.indexOf('stopOrderMonitorRuntimeAndDrain') - 1]).toBe('sell');
    expect(steps).toContain('buy');
    expect(steps).toContain('postTradeConsistencyRuntime');
  });
});
