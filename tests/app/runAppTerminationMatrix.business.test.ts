import { strategyDefinition } from '../../src/strategies/intradayRegression/definition.js';

/** T20/T21：离线真实 post-gate owner 的 root 挂起终止矩阵，不访问账户或入口。 */
import { describe, expect, it, mock } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCleanup } from '../../src/app/shutdown/createCleanup.js';
import { createMixedTradeLogRepository } from '../../src/infrastructure/persistence/mixedTradeLogRepository/index.js';
import type { MixedTradeLogRepositoryDeps } from '../../src/infrastructure/persistence/mixedTradeLogRepository/types.js';
import { createMonitorContext } from '../../src/app/context/createMonitorContext.js';
import { createTimeWakeupRuntime } from '../../src/runtime/timeWakeupRuntime/index.js';
import { executeStartupRebuild } from '../../src/application/tradingDayRebuild/startupRebuild.js';

import { createTradingConfig } from '../../mock/factories/configFactory.js';
import { createBrokerClientFactoryDouble } from '../helpers/brokerClientFactoryDouble.js';
import { createWarrantListCache } from '../../src/infrastructure/longbridge/market/warrantListCache/index.js';
import { prepareFixture, createHarness } from '../strategies/intradayRegression/runtimeFixtures.js';
import { configObject } from '../strategies/intradayRegression/configFixtures.js';
import type {
  RunAppDeps,
  RuntimeAssemblyResources,
  CreatePostGateRuntimeParams,
  AppEnvironmentParams,
} from '../../src/app/types.js';
import type { RuntimeTermination } from '../../src/types/runtime.js';
import type { AccountPositionSnapshot } from '../../src/types/accountPosition.js';
import type { CreateTradeRuntimeDeps } from '../../src/app/runtime/types.js';
import type { StrategyDeps, TradingSignalStrategy } from '../../src/types/strategy.js';
import type { Processor } from '../../src/runtime/asyncProgram/types.js';
import {
  createLoggerDouble,
  createSignalDouble,
  createMarketDataClientDouble,
  createSymbolRegistryDouble,
  createTradeRuntimeDouble,
} from '../helpers/testDoubles.js';

/** 挂起工作由真实 owner 持有，不相关处理器仅补齐端口。 */
function idleProcessor(): Processor {
  return { start: () => {}, stop: () => {}, restart: () => {}, stopAndDrain: async () => {} };
}
let importSequence = 0;

/** 每格通过唯一模块 URL 捕获独立装配依赖，真实 PostTrade/Quote/context 保留不替换。 */
async function harness(
  stage: 'tradeRuntime' | 'rebuild' | 'quote' | 'time',
  teardownError?: Error,
) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'post-gate-matrix-'));
  const tradesDir = path.join(tempRoot, 'trades');
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
  const tradeRuntime = createTradeRuntimeDouble({
    orderMonitor: {
      teardown: async () => {
        trace.push('tradeRuntime-teardown');
        if (teardownError) throw teardownError;
      },
      stopRuntimeAndDrain: async () => {
        trace.push('tradeRuntime-drain');
      },
      onOrderStateChanged: () => {
        traderListeners++;
        return () => {
          traderListeners--;
          trace.push('tradeRuntime-unsubscribe');
        };
      },
    },
  });
  mock.module('../../src/app/runtime/createPostGateRuntimeDeps.js', () => ({
    DEFAULT_CREATE_POST_GATE_RUNTIME_DEPS: {
      createTradeRuntime: async (_deps: CreateTradeRuntimeDeps) => {
        trace.push('tradeRuntime-acquire');
        if (stage === 'tradeRuntime') {
          reached.resolve();
          await controlled.promise;
        }

        trace.push('tradeRuntime-return');
        return tradeRuntime;
      },
      createMonitorContext: (params: Parameters<typeof createMonitorContext>[0]) => {
        contextCount++;
        expect(trace).toContain('tradeRuntime-return');
        expect(ownedStrategy).toBe(params.strategy);
        expect(params.postGateRuntime.tradeRuntime).toBe(tradeRuntime);
        trace.push('context');
        return createMonitorContext(params);
      },
      createMixedTradeLogRepository: (repositoryDeps: MixedTradeLogRepositoryDeps) =>
        createMixedTradeLogRepository({
          ...repositoryDeps,
          tradesDir,
        }),
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
    executeStartupRebuild,
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
    createPreGateRuntime: async ({ termination: owner, diagnostics }) => {
      termination.current = owner;
      return {
        diagnostics,
        brokerClientFactory: createBrokerClientFactoryDouble(),
        tradingConfig: createTradingConfig(),
        symbolRegistry: createSymbolRegistryDouble(),
        startupTradingDayInfo: null,
        warrantListCache: createWarrantListCache(),
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
        expect(params.resources.lifecycleState).toBe(runtime.lifecycleState);
        expect(params.resources.buyTaskQueue).toBe(runtime.buyTaskQueue);
        expect(params.resources.sellTaskQueue).toBe(runtime.sellTaskQueue);
      }

      return runtime;
    },
    loadStartupSnapshot: async ({ snapshot }) => {
      // runApp 传入的正是 PostGateRuntime.snapshot；契约只声明读取能力，这里需驱动真实 refresh 批次。
      const canonicalSnapshot = snapshot as AccountPositionSnapshot;
      const timerCount = h.timers.length;
      const refresh = canonicalSnapshot.requestRefresh({
        source: 'TEST_STARTUP',
        dayEpoch: canonicalSnapshot.getView().token.dayEpoch,
        refreshAccount: true,
        refreshPositions: true,
      });
      const issuedTimer = h.timers[timerCount];
      if (issuedTimer === undefined || issuedTimer.cleared || issuedTimer.delay !== 0) {
        throw new Error('canonical refresh did not schedule its issued batch');
      }

      issuedTimer.callback();
      const refreshed = await refresh.result;
      if (refreshed.status !== 'COMMITTED') throw new Error('startup snapshot refresh was aborted');

      return {
        kind: 'READY',
        snapshotToken: refreshed.snapshotToken,
        allOrders: [],
        quotesMap: new Map(),
        now: h.deps.clock.now(),
      };
    },
    collectRuntimeValidationSymbols: () => ({ runtimeValidationInputs: [] }),
    validateRuntimeSymbolsFromQuotesMap: () => ({ valid: true, warnings: [], errors: [] }),
    createRebuildTradingDayState:
      () =>
      async ({ snapshotToken }) => {
        if (stage === 'rebuild') {
          reached.resolve();
          await controlled.promise;
        }

        return { status: 'COMMITTED', snapshotToken };
      },
    displayAccountAndPositions: () => {},
    createBusinessEventProgram: () => idleProcessor(),
    createAsyncRuntime: () => ({
      buyProcessor: idleProcessor(),
      sellProcessor: idleProcessor(),
      monitorTaskProcessor: idleProcessor(),
    }),
    createLifecycleRuntime: () => ({
      tick: async () => ({ nextRetryAtMs: null }),
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
  const outcome = runApp({ env: { APP_RUNTIME_PROFILE: 'test' } })
    .then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    )
    .finally(() => {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    });
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
        const state = h.resources.current?.lifecycleState;
        // 重建与订阅对账等待期间保持门闭，只有完成同 token H/S 准入后才进入 time 阶段。
        expect(state?.isTradingEnabled).toBe(stage === 'time');
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
            type: 'SEAT_REFRESH',
            dedupeKey: 'terminated',
            data: {
              dayEpoch: 0,
              direction: 'LONG',
              seatVersion: 1,
              previousSymbol: null,
              nextSymbol: 'BULL.HK',
              symbolName: null,
            },
          }),
        ).toBe(false);
        expect(h.counts().destroyCount).toBe(0);
        await Promise.resolve();
        expect(h.trace).not.toContain('tradeRuntime-drain');
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
        expect(h.trace.filter((step) => step === 'tradeRuntime-teardown')).toHaveLength(1);
        expect(h.trace.indexOf('tradeRuntime-drain')).toBeLessThan(
          h.trace.lastIndexOf('tradeRuntime-unsubscribe'),
        );

        expect(h.trace.lastIndexOf('tradeRuntime-unsubscribe')).toBeLessThan(
          h.trace.indexOf('tradeRuntime-teardown'),
        );
        h.shutdown();
        expect(h.counts().cleanupCount).toBe(1);
      });
    }
  }

  it('fatal during Trader acquire cleans the late owner without constructing context', async () => {
    const h = await harness('tradeRuntime');
    const error = new Error('acquire fatal');
    h.termination.current?.reportFatalError(error);
    expect(h.resources.current?.lifecycleState?.isTradingEnabled).toBe(false);
    expect(h.counts().cleanupCount).toBe(0);
    expect(h.counts().contextCount).toBe(0);
    h.controlled.resolve();
    const result = await h.outcome;
    expect(result.error).toBe(error);
    expect(h.trace).toEqual([
      'tradeRuntime-acquire',
      'tradeRuntime-return',
      'tradeRuntime-drain',
      'tradeRuntime-teardown',
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
    const h = await harness('tradeRuntime', new Error('unsubscribe failed'));
    const originalFatal = new Error('original fatal');
    h.termination.current?.reportFatalError(originalFatal);
    h.controlled.resolve();
    const result = await h.outcome;
    expect(result.error).toBe(originalFatal);
    expect(h.trace.filter((step) => step === 'tradeRuntime-teardown')).toHaveLength(1);
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
