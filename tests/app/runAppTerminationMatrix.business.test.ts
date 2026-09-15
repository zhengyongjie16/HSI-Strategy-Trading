import { strategyDefinition } from '../../src/core/strategy/intradayRegression/definition.js';

/** T20/T21：离线真实 post-gate owner 的 root 挂起终止矩阵，不访问账户或入口。 */
import { describe, expect, it, mock } from 'bun:test';
import { createCleanup } from '../../src/app/shutdown/createCleanup.js';
import { createMonitorContext } from '../../src/app/context/createMonitorContext.js';
import { createTimeWakeupRuntime } from '../../src/main/timeWakeupRuntime/index.js';

import { createTradingConfig } from '../../mock/factories/configFactory.js';
import { createWarrantListCache } from '../../src/services/autoSymbolFinder/utils.js';
import {
  prepareFixture,
  configObject,
  createHarness,
} from '../core/strategy/intradayRegression/fixtures.js';
import type {
  RunAppDeps,
  RuntimeAssemblyResources,
  CreatePostGateRuntimeParams,
  AppEnvironmentParams,
} from '../../src/app/types.js';
import type { RuntimeTermination } from '../../src/types/runtime.js';
import type { TraderDeps } from '../../src/core/trader/types.js';
import type { StrategyDeps, TradingSignalStrategy } from '../../src/core/strategy/types.js';
import type { Processor } from '../../src/main/asyncProgram/types.js';
import {
  createLoggerDouble,
  createSignalDouble,
  createMarketDataClientDouble,
  createSdkConfigDouble,
  createSymbolRegistryDouble,
  createTraderDouble,
} from '../helpers/testDoubles.js';

/** 挂起工作由真实 owner 持有，不相关处理器仅补齐端口。 */
function idleProcessor(): Processor {
  return { start: () => {}, stop: () => {}, restart: () => {}, stopAndDrain: async () => {} };
}
let importSequence = 0;

/** 每格通过唯一模块 URL 捕获独立装配依赖，真实 PostTrade/Quote/context 保留不替换。 */
async function harness(stage: 'trader' | 'rebuild' | 'quote' | 'time', teardownError?: Error) {
  const controlled = Promise.withResolvers<undefined>();
  const reached = Promise.withResolvers<undefined>();
  const trace: string[] = [];
  const resources: { current?: RuntimeAssemblyResources } = {};
  const termination: { current?: RuntimeTermination } = {};
  const listeners = new Set<() => void>();
  const h = createHarness();
  const prepared = prepareFixture(configObject());
  let prepareCount = 0;
  let createCount = 0;
  let destroyCount = 0;
  let cleanupCount = 0;
  let contextCount = 0;
  let traderListeners = 0;
  let quoteBlocked = false;
  let ownedStrategy: TradingSignalStrategy | undefined;
  const trader = createTraderDouble({
    teardown: async () => {
      trace.push('trader-teardown');
      if (teardownError) throw teardownError;
    },
    stopOrderMonitorRuntimeAndDrain: async () => {
      trace.push('trader-drain');
    },
    onOrderStateChanged: () => {
      traderListeners++;
      return () => {
        traderListeners--;
        trace.push('trader-unsubscribe');
      };
    },
  });
  mock.module('../../src/app/runtime/createPostGateRuntimeDeps.js', () => ({
    DEFAULT_CREATE_POST_GATE_RUNTIME_DEPS: {
      createTrader: async (_deps: TraderDeps) => {
        trace.push('trader-acquire');
        if (stage === 'trader') {
          reached.resolve();
          await controlled.promise;
        }

        trace.push('trader-return');
        return trader;
      },
      createMonitorContext: (params: Parameters<typeof createMonitorContext>[0]) => {
        contextCount++;
        expect(trace).toContain('trader-return');
        expect(ownedStrategy).toBe(params.strategy);
        expect(params.postGateRuntime.trader).toBe(trader);
        trace.push('context');
        return createMonitorContext(params);
      },
    },
  }));
  const postGateModule = await import(
    `../../src/app/runtime/createPostGateRuntime.js?termination-matrix=${importSequence++}`
  );
  const buildPostGate = postGateModule.createPostGateRuntime as (
    params: CreatePostGateRuntimeParams,
  ) => ReturnType<RunAppDeps['createPostGateRuntime']>;
  const logger = createLoggerDouble();
  const deps: RunAppDeps = {
    prepareStrategy: async () => {
      prepareCount++;
      return {
        strategyId: strategyDefinition.id,
        prepared: {
          create: (strategyDeps: StrategyDeps) => {
            createCount++;
            const strategy = prepared.create(strategyDeps);
            ownedStrategy = {
              ...strategy,
              destroy: () => {
                destroyCount++;
                strategy.destroy();
              },
            };
            return ownedStrategy;
          },
        },
      };
    },
    createPreGateRuntime: async ({ termination: owner }) => {
      termination.current = owner;
      return {
        config: createSdkConfigDouble(),
        tradingConfig: createTradingConfig(),
        symbolRegistry: createSymbolRegistryDouble(),
        startupTradingDayInfo: null,
        warrantListCacheConfig: { cache: createWarrantListCache(), ttlMs: 60000, nowMs: () => 0 },
        marketDataClient: createMarketDataClientDouble({
          subscribeSymbols: async () => {
            if (stage === 'quote' && !quoteBlocked) {
              quoteBlocked = true;
              reached.resolve();
              await controlled.promise;
            }
          },
        }),
      };
    },
    createPostGateRuntime: async (params) => {
      resources.current = params.resources;
      const runtime = await buildPostGate({
        ...params,
        clock: h.deps.clock,
        scheduler: h.deps.scheduler,
      });
      if (runtime !== null) {
        expect(ownedStrategy).toBe(runtime.monitorContext.strategy);
        expect(params.resources.lastState).toBe(runtime.lastState);
        expect(params.resources.buyTaskQueue).toBe(runtime.buyTaskQueue);
        expect(params.resources.sellTaskQueue).toBe(runtime.sellTaskQueue);
      }

      return runtime;
    },
    loadStartupSnapshot: async () => ({
      kind: 'READY',
      allOrders: [],
      quotesMap: new Map(),
      now: h.deps.clock.now(),
    }),
    collectRuntimeValidationSymbols: () => ({ runtimeValidationInputs: [] }),
    validateRuntimeSymbolsFromQuotesMap: () => ({ valid: true, warnings: [], errors: [] }),
    createRebuildTradingDayState: () => async () => {
      if (stage === 'rebuild') {
        reached.resolve();
        await controlled.promise;
      }
    },
    displayAccountAndPositions: () => {},
    createBusinessEventProgram: () => idleProcessor(),
    createAsyncRuntime: () => ({
      buyProcessor: idleProcessor(),
      sellProcessor: idleProcessor(),
      monitorTaskProcessor: idleProcessor(),
    }),
    createLifecycleRuntime: () => ({
      tick: async () => ({ nextRetryAtMs: null, pendingOpenRebuild: false }),
    }),
    createTimeWakeupRuntime: (params) =>
      createTimeWakeupRuntime({
        ...params,
        evaluate: async () => {
          if (stage === 'time') {
            reached.resolve();
            await controlled.promise;
          }

          return { plan: { hasWork: false, nextWakeupAtMs: null } };
        },
      }),
    subscribeShutdownSignal: (callback) => {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
        trace.push('shutdown-unsubscribe');
      };
    },
    createCleanup: () => {
      const cleanup = createCleanup();
      cleanup.register({
        phase: 'CLOSE_TRADING_GATE',
        step: '记录最终清理',
        handler: () => {
          cleanupCount++;
        },
      });
      return cleanup;
    },
    logger,
    formatError: String,
    applyStartupSnapshotFailureState: () => {},
  };
  mock.module('../../src/app/runAppDeps.js', () => ({ DEFAULT_RUN_APP_DEPS: deps }));
  const root = await import(`../../src/app/runApp.js?termination-matrix=${importSequence++}`);
  const runApp = root.runApp as (params: AppEnvironmentParams) => Promise<void>;
  const outcome = runApp({ env: { APP_RUNTIME_PROFILE: 'test' } }).then(
    () => ({ error: undefined }),
    (error: unknown) => ({ error }),
  );
  await Promise.race([
    reached.promise,
    outcome.then(({ error }) => {
      throw new Error('root exited before controlled boundary', { cause: error });
    }),
  ]);
  return {
    controlled,
    trace,
    resources,
    termination,
    outcome,
    shutdown: () => {
      for (const listener of listeners) listener();
    },
    counts: () => ({
      prepareCount,
      createCount,
      destroyCount,
      cleanupCount,
      contextCount,
      traderListeners,
      shutdownListeners: listeners.size,
    }),
  };
}

describe('root termination with real post-gate ownership', () => {
  for (const stage of ['rebuild', 'quote', 'time'] as const) {
    for (const mode of ['shutdown', 'fatal'] as const) {
      it(`${stage} pending × ${mode}: waits for settlement and never reopens`, async () => {
        const h = await harness(stage);
        const failure = { stage, mode };
        const state = h.resources.current?.lastState;
        expect(state?.isTradingEnabled).toBe(true);
        if (mode === 'fatal') h.termination.current?.reportFatalError(failure);
        else h.shutdown();

        h.shutdown();
        h.shutdown();
        // 同栈关门，清理仍必须等待资源获取/在途评估落定。
        expect(state?.isTradingEnabled).toBe(false);
        expect(
          h.resources.current?.buyTaskQueue?.push({
            type: 'STRATEGY_BUY',
            data: createSignalDouble('BUYCALL', 'BULL.HK'),
          }),
        ).toBe(false);

        expect(
          h.resources.current?.sellTaskQueue?.push({
            type: 'STRATEGY_SELL',
            data: createSignalDouble('SELLCALL', 'BULL.HK'),
          }),
        ).toBe(false);
        expect(h.counts().cleanupCount).toBe(0);
        expect(
          h.resources.current?.monitorTaskQueue?.scheduleLatest({
            type: 'AUTO_SYMBOL_TICK',
            dedupeKey: 'terminated',
            data: {
              direction: 'LONG',
              seatVersion: 1,
              symbol: 'BULL.HK',
              lastSeatActivatedAt: 0,
              currentTimeMs: 0,
            },
          }),
        ).toBe(false);
        expect(h.counts().destroyCount).toBe(0);
        await Promise.resolve();
        expect(h.trace).not.toContain('trader-drain');
        h.controlled.resolve();
        const result = await h.outcome;
        expect(result.error).toBe(mode === 'fatal' ? failure : undefined);
        expect(state?.isTradingEnabled).toBe(false);
        expect(h.counts()).toEqual({
          prepareCount: 1,
          createCount: 1,
          destroyCount: 1,
          cleanupCount: 1,
          contextCount: 1,
          traderListeners: 0,
          shutdownListeners: 0,
        });
        expect(h.trace.filter((step) => step === 'trader-teardown')).toHaveLength(1);
        expect(h.trace.indexOf('trader-drain')).toBeLessThan(
          h.trace.lastIndexOf('trader-unsubscribe'),
        );

        expect(h.trace.lastIndexOf('trader-unsubscribe')).toBeLessThan(
          h.trace.indexOf('trader-teardown'),
        );
        h.shutdown();
        expect(h.counts().cleanupCount).toBe(1);
      });
    }
  }

  it('fatal during Trader acquire cleans the late owner without constructing context', async () => {
    const h = await harness('trader');
    const error = new Error('acquire fatal');
    h.termination.current?.reportFatalError(error);
    expect(h.resources.current?.lastState?.isTradingEnabled).toBe(false);
    expect(h.counts().cleanupCount).toBe(0);
    expect(h.counts().contextCount).toBe(0);
    h.controlled.resolve();
    const result = await h.outcome;
    expect(result.error).toBe(error);
    expect(h.trace).toEqual([
      'trader-acquire',
      'trader-return',
      'trader-drain',
      'trader-teardown',
      'shutdown-unsubscribe',
    ]);

    expect(h.counts()).toEqual({
      prepareCount: 1,
      createCount: 1,
      destroyCount: 1,
      cleanupCount: 1,
      contextCount: 0,
      traderListeners: 0,
      shutdownListeners: 0,
    });
  });

  it('terminal unsubscribe failure does not replace original fatal or stop later cleanup', async () => {
    const h = await harness('trader', new Error('unsubscribe failed'));
    const originalFatal = new Error('original fatal');
    h.termination.current?.reportFatalError(originalFatal);
    h.controlled.resolve();
    const result = await h.outcome;
    expect(result.error).toBe(originalFatal);
    expect(h.trace.filter((step) => step === 'trader-teardown')).toHaveLength(1);
    expect(h.trace).toContain('shutdown-unsubscribe');
    expect(h.counts().destroyCount).toBe(1);
  });

  it('normal shutdown followed by an internal rejection preserves its original value', async () => {
    const h = await harness('rebuild');
    const failure = { internal: 'rebuild-invariant' };
    h.shutdown();
    h.controlled.reject(failure);
    const result = await h.outcome;
    expect(result.error).toBe(failure);
    expect(h.counts().shutdownListeners).toBe(0);
    expect(h.counts().destroyCount).toBe(1);
  });
});
