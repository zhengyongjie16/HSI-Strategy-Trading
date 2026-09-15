/**
 * createCleanup 业务测试
 *
 * 功能：
 * - 验证退出时排空处理器、销毁延迟验证器与释放资源的流程与边界。
 */
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { logger } from '../../../src/utils/logger/index.js';
import { formatError } from '../../../src/utils/error/index.js';
import { createCleanup } from '../../../src/app/shutdown/createCleanup.js';
import { createMonitorContextDouble } from '../../helpers/testDoubles.js';
import { createLastState, registerCleanupSteps } from './utils.js';

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

  it('drains processors, destroys the selected strategy after all quote consumers drain', async () => {
    const steps: string[] = [];
    const monitorContext = createMonitorContextDouble({
      strategy: {
        ...createMonitorContextDouble().strategy,
        destroy: () => {
          steps.push('destroyStrategy');
        },
      },
    });
    const lastState = createLastState();

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
      'postTradeConsistencyRuntime',
      'quoteSubscriptionRuntime',
      'destroyStrategy',
      'resetMarketData',
    ]);
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
      'postTradeConsistencyRuntime',
      'quoteSubscriptionRuntime',
      'resetMarketData',
    ]);
  });

  it('continues remaining cleanup steps and throws aggregate error when one step fails', async () => {
    const steps: string[] = [];
    const monitorContext = createMonitorContextDouble({
      strategy: {
        ...createMonitorContextDouble().strategy,
        destroy: () => {
          steps.push('destroyStrategy');
        },
      },
    });
    const lastState = createLastState();

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
      'postTradeConsistencyRuntime',
      'quoteSubscriptionRuntime',
      'destroyStrategy',
      'resetMarketData',
    ]);
  });

  it('closes trading gate before draining processors during cleanup', async () => {
    const steps: string[] = [];
    const lastState = createLastState();
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

  it('waits for PostTrade positions callback before stopping Quote even when drains overlap', async () => {
    const cleanup = createCleanup();
    const calls: string[] = [];
    let release: (() => void) | undefined;
    const positionsCallback = new Promise<void>((resolve) => {
      release = resolve;
    });
    cleanup.register({
      phase: 'STOP_QUOTE_SUBSCRIPTION_RUNTIME',
      step: 'quote',
      handler: () => {
        calls.push('quote.stop');
      },
    });

    cleanup.register({
      phase: 'STOP_POST_TRADE_CONSISTENCY_RUNTIME',
      step: 'postTrade',
      handler: async () => {
        calls.push('positions.begin');
        await positionsCallback;
        calls.push('positions.done');
      },
    });
    const draining = cleanup.execute();
    await Promise.resolve();
    expect(calls).toEqual(['positions.begin']);
    release?.();
    await draining;
    expect(calls).toEqual(['positions.begin', 'positions.done', 'quote.stop']);
  });
});

describe('cleanup diagnostic markers', () => {
  let messages: string[] = [];

  beforeEach(() => {
    messages = [];
    spyOn(logger, 'info').mockImplementation(() => {
      throw new Error('正常退出诊断不得使用 info');
    });

    spyOn(logger, 'debug').mockImplementation((message) => {
      messages.push(message);
    });

    spyOn(logger, 'error').mockImplementation((message) => {
      messages.push(message);
    });
    spyOn(performance, 'now').mockReturnValue(100);
  });

  afterEach(() => {
    mock.restore();
  });

  it('logs phase order and stable same-phase registration order with settled success counts', async () => {
    const cleanup = createCleanup();
    const calls: string[] = [];
    cleanup.register({
      phase: 'RESET_MARKET_DATA_RUNTIME',
      step: 'last',
      handler: () => {
        calls.push('last');
      },
    });

    cleanup.register({
      phase: 'STOP_BUY_PROCESSOR',
      step: 'first',
      handler: () => {
        calls.push('first');
      },
    });

    cleanup.register({
      phase: 'STOP_BUY_PROCESSOR',
      step: 'second',
      handler: () => {
        calls.push('second');
      },
    });

    await cleanup.execute();

    expect(calls).toEqual(['first', 'second', 'last']);
    expect(messages).toEqual([
      'Program exiting, cleaning up resources...',
      '[Cleanup] phase=140 name=STOP_BUY_PROCESSOR step=first start',
      '[Cleanup] phase=140 name=STOP_BUY_PROCESSOR step=first done elapsedMs=0',
      '[Cleanup] phase=140 name=STOP_BUY_PROCESSOR step=second start',
      '[Cleanup] phase=140 name=STOP_BUY_PROCESSOR step=second done elapsedMs=0',
      '[Cleanup] phase=230 name=RESET_MARKET_DATA_RUNTIME step=last start',
      '[Cleanup] phase=230 name=RESET_MARKET_DATA_RUNTIME step=last done elapsedMs=0',
      '[Cleanup] completion status=success total=3 success=3 failure=0',
    ]);
  });

  it('logs failures, continues cleanup and preserves original thrown values in the aggregate', async () => {
    const cleanup = createCleanup();
    const originalError = new Error('drain failed');
    const originalValue = { reason: 'non-error failure' };
    cleanup.register({
      phase: 'STOP_BUY_PROCESSOR',
      step: 'buy',
      handler: () => {
        throw originalError;
      },
    });

    cleanup.register({
      phase: 'STOP_SELL_PROCESSOR',
      step: 'sell',
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- 验证第三方 handler 拒绝非 Error 原值时仍原样聚合
      handler: () => Promise.reject(originalValue),
    });
    cleanup.register({ phase: 'RESET_MARKET_DATA_RUNTIME', step: 'reset', handler: () => {} });

    const execution = cleanup.execute();
    let caught: unknown;
    try {
      await execution;
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    if (!(caught instanceof AggregateError)) throw new Error('Expected cleanup AggregateError');

    expect(caught.errors).toHaveLength(2);
    expect(caught.errors[0]).toBe(originalError);
    expect(caught.errors[1]).toBe(originalValue);
    expect(messages).toEqual([
      'Program exiting, cleaning up resources...',
      '[Cleanup] phase=140 name=STOP_BUY_PROCESSOR step=buy start',
      `[Cleanup] phase=140 name=STOP_BUY_PROCESSOR step=buy failed elapsedMs=0: ${formatError(originalError)}`,
      '[Cleanup] phase=150 name=STOP_SELL_PROCESSOR step=sell start',
      `[Cleanup] phase=150 name=STOP_SELL_PROCESSOR step=sell failed elapsedMs=0: ${formatError(originalValue)}`,
      '[Cleanup] phase=230 name=RESET_MARKET_DATA_RUNTIME step=reset start',
      '[Cleanup] phase=230 name=RESET_MARKET_DATA_RUNTIME step=reset done elapsedMs=0',
      '[Cleanup] completion status=failure total=3 success=1 failure=2',
    ]);
    const settledMessages = [...messages];
    expect(cleanup.execute()).toBe(execution);
    expect(messages).toEqual(settledMessages);
  });

  it('does not advance or report completion while pending and reuses execution without duplicate markers', async () => {
    const cleanup = createCleanup();
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[] = [];
    cleanup.register({
      phase: 'STOP_BUY_PROCESSOR',
      step: 'blocked',
      handler: () => {
        calls.push('blocked');
        return blocked;
      },
    });

    cleanup.register({
      phase: 'RESET_MARKET_DATA_RUNTIME',
      step: 'reset',
      handler: () => {
        calls.push('reset');
      },
    });

    const execution = cleanup.execute();
    try {
      expect(cleanup.execute()).toBe(execution);
      await Promise.resolve();
      expect(calls).toEqual(['blocked']);
      expect(messages).toEqual([
        'Program exiting, cleaning up resources...',
        '[Cleanup] phase=140 name=STOP_BUY_PROCESSOR step=blocked start',
      ]);
    } finally {
      release?.();
      await execution;
    }

    expect(calls).toEqual(['blocked', 'reset']);
    expect(messages).toEqual([
      'Program exiting, cleaning up resources...',
      '[Cleanup] phase=140 name=STOP_BUY_PROCESSOR step=blocked start',
      '[Cleanup] phase=140 name=STOP_BUY_PROCESSOR step=blocked done elapsedMs=0',
      '[Cleanup] phase=230 name=RESET_MARKET_DATA_RUNTIME step=reset start',
      '[Cleanup] phase=230 name=RESET_MARKET_DATA_RUNTIME step=reset done elapsedMs=0',
      '[Cleanup] completion status=success total=2 success=2 failure=0',
    ]);
    const settledMessages = [...messages];
    expect(cleanup.execute()).toBe(execution);
    await execution;
    expect(messages).toEqual(settledMessages);
  });
});

// 独立进程验证真实 logger 开关，避免模块缓存或环境修改污染其他测试。
describe('cleanup real logger debug gate', () => {
  for (const debug of ['false', 'true']) {
    for (const fails of [false, true]) {
      it('routes diagnostics with DEBUG=' + debug + ' and failure=' + String(fails), async () => {
        const logRoot = await mkdtemp(path.join(tmpdir(), 'cleanup-debug-'));
        try {
          const script = [
            "import { createCleanup } from './src/app/shutdown/createCleanup.ts';",
            'const cleanup = createCleanup(); const original = new Error("gate-test-failure"); let continued = false;',
            'cleanup.register({ phase: "STOP_BUY_PROCESSOR", step: "gate-first", handler() { if (' +
              String(fails) +
              ') throw original; }});',
            'cleanup.register({ phase: "RESET_MARKET_DATA_RUNTIME", step: "gate-last", handler() { continued = true; }});',
            'let caught; try { await cleanup.execute(); } catch (error) { caught = error; }',
            'if (!continued) throw new Error("Subsequent cleanup skipped");',
            fails
              ? 'if (!(caught instanceof AggregateError) || caught.errors.length !== 1 || caught.errors[0] !== original) throw new Error("Original cleanup failure lost");'
              : 'if (caught) throw caught;',
          ].join('\n');
          const child = Bun.spawn([process.execPath, '--no-env-file', '-e', script], {
            cwd: path.resolve(import.meta.dir, '../../..'),
            env: {
              DEBUG: debug,
              APP_RUNTIME_PROFILE: 'test',
              APP_ENABLE_PROCESS_HOOKS: 'false',
              APP_LOG_ROOT_DIR: logRoot,
            },
            stdout: 'pipe',
            stderr: 'pipe',
          });
          const [stdout, stderr, exitCode] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
          ]);
          expect(exitCode).toBe(0);
          const output = stdout + stderr;
          for (const marker of [
            'Program exiting, cleaning up resources...',
            'step=gate-first start',
            'step=gate-last done elapsedMs=',
          ]) {
            expect(output.includes(marker)).toBe(debug === 'true');
          }

          expect(output.includes('completion status=success total=2 success=2 failure=0')).toBe(
            debug === 'true' && !fails,
          );
          expect(output.includes('step=gate-first failed elapsedMs=')).toBe(fails);
          expect(output.includes('completion status=failure total=2 success=1 failure=1')).toBe(
            fails,
          );

          if (fails) {
            expect(stderr).toContain('gate-test-failure');
            expect(stderr).toContain('completion status=failure');
          }
        } finally {
          await rm(logRoot, { recursive: true, force: true });
        }
      });
    }
  }
});
