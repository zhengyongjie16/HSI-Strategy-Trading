/** app settlement wiring 测试：窄能力映射、配置绑定和启动构造环，业务案例由 application owner 测试。 */
import { describe, expect, test } from 'bun:test';
import { createPostTradeConsistencyRuntime } from '../../../src/app/runtime/createPostTradeConsistencyRuntime.js';
import { createAccountPositionSnapshot } from '../../../src/application/accountPositionSnapshot/index.js';
import { createProtectiveLiquidationEpisodeTracker } from '../../../src/core/trader/protectiveLiquidationEpisodeTracker/index.js';
import type { PostTradeConsistencyRuntimeBusinessDeps } from '../../../src/app/types.js';
import type { RuntimeScheduler } from '../../../src/types/runtime.js';
import {
  createAccountSnapshotDouble,
  createDailyLossTrackerDouble,
  createLiquidationCooldownTrackerDouble,
  createMonitorConfigDouble,
  createMonitorContextDouble,
  createOrderRecorderDouble,
  createRiskCheckerDouble,
  createTerminationDouble,
  createTraderDouble,
} from '../../helpers/testDoubles.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 40; index++) await Promise.resolve();
}

function createFixture(onPositionsCommitted: () => Promise<void> = async () => {}) {
  const callbacks = new Map<ReturnType<typeof setTimeout>, () => void>();
  const scheduler: RuntimeScheduler = {
    scheduleTimer: (callback) => {
      const handle = setTimeout(() => {}, 2_147_483_647);
      clearTimeout(handle);
      callbacks.set(handle, callback);
      return handle;
    },
    clearTimer: (handle) => {
      callbacks.delete(handle);
    },
  };
  const trader = createTraderDouble();
  const snapshot = createAccountPositionSnapshot({
    dayEpoch: 1,
    scheduler: { schedule: queueMicrotask },
    reportFatalError: () => {},
    readPort: {
      getAccountSnapshot: async () => createAccountSnapshotDouble('10000'),
      getStockPositions: async () => [],
    },
  });
  const runtime = createPostTradeConsistencyRuntime({
    termination: createTerminationDouble(),
    getTrader: () => trader,
    snapshot,
    scheduler,
    onPositionsCommitted,
  });
  const businessDeps: PostTradeConsistencyRuntimeBusinessDeps = {
    monitorContext: createMonitorContextDouble(),
    dailyLossTracker: createDailyLossTrackerDouble(),
    protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTracker(),
    liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
    mixedTradeLogRepository: { appendCompletionIdempotent: () => {} },
  };
  return {
    runtime,
    snapshot,
    businessDeps,
    run: async () => {
      const next = callbacks.entries().next().value;
      if (next === undefined) throw new Error('missing workflow timer');

      callbacks.delete(next[0]);
      next[1]();
      await flush();
    },
  };
}

describe('app settlement composition', () => {
  test('real application owner enforces late binding before start and single assignment', async () => {
    const { runtime, businessDeps } = createFixture();
    expect(() => {
      runtime.start();
    }).toThrow('businessDeps 尚未绑定');
    runtime.bindBusinessDeps(businessDeps);
    expect(() => {
      runtime.bindBusinessDeps(businessDeps);
    }).toThrow('businessDeps 已绑定');
    runtime.start();
    expect(runtime.getStatus().started).toBe(true);
    await runtime.stopAndDrain();
  });

  test('subscription ack precedes synchronous completion; exact loss, cost owner and cooldown config reach real collaborators', async () => {
    const acknowledgement = deferred();
    const { runtime, snapshot, businessDeps, run } = createFixture(() => acknowledgement.promise);
    const calls: string[] = [];
    const boundaryExecutedTimeMs = Date.parse('2026-07-11T03:00:00.000Z');
    const episodeTracker = createProtectiveLiquidationEpisodeTracker();
    episodeTracker.recordProtectiveFillProgress({
      direction: 'LONG',
      symbol: 'BULL.HK',
      executedTimeMs: boundaryExecutedTimeMs,
    });
    let offset = '-1.0001';
    const dailyLossTracker = createDailyLossTrackerDouble({
      prepareProtectionBoundary: (params) => ({ ...params, orderBaselines: [] }),
      commitProtectionBoundary: () => {
        calls.push('boundary');
        offset = '0';
      },
      getLossOffset: () => offset,
    });
    const orderRecorder = createOrderRecorderDouble();
    const config = createMonitorConfigDouble({
      monitorSymbol: 'HSI.HK',
      liquidationTriggerLimit: 2,
      liquidationCooldown: { mode: 'minutes', minutes: 7 },
    });
    runtime.bindBusinessDeps({
      ...businessDeps,
      monitorContext: createMonitorContextDouble({
        config,
        dailyLossTracker,
        orderRecorder,
        riskChecker: createRiskCheckerDouble({
          prepareUnrealizedLossData: (recorder, symbol, isLong, lossOffset) => {
            expect(recorder).toBe(orderRecorder);
            expect(isLong).toBe(symbol === 'BULL.HK');
            expect(lossOffset).toBe('0');
            calls.push(`prepare:${symbol}`);
            return { symbol, data: { r1: '0.0001', n1: 0 } };
          },
          publishUnrealizedLossData: ({ symbol }) => {
            calls.push(`risk:${symbol}`);
          },
        }),
      }),
      dailyLossTracker,
      protectiveLiquidationEpisodeTracker: {
        ...episodeTracker,
        commitCompletion: (prepared) => {
          calls.push('episode');
          episodeTracker.commitCompletion(prepared);
        },
      },
      liquidationCooldownTracker: createLiquidationCooldownTrackerDouble({
        recordLiquidationTrigger: (params) => {
          expect(params).toEqual({
            direction: 'LONG',
            executedTimeMs: boundaryExecutedTimeMs,
            triggerLimit: 2,
            cooldownConfig: config.liquidationCooldown,
          });
          calls.push('cooldown');
        },
      }),
      mixedTradeLogRepository: {
        appendCompletionIdempotent: (completion) => {
          expect(completion.monitorSymbol).toBe('HSI.HK');
          calls.push('append');
        },
      },
    });

    runtime.onFreshReached(() => {
      calls.push('ready');
    });
    runtime.recordSettlementRefreshNeed({ refreshAccount: true, refreshPositions: true });
    runtime.start();
    const waiting = runtime.waitForFresh();
    await run();
    expect(snapshot.getView().positionsInitialized).toBe(true);
    expect(calls).toEqual([]);
    acknowledgement.resolve();
    const receipt = await waiting;
    expect(calls).toEqual([
      'append',
      'boundary',
      'cooldown',
      'episode',
      'prepare:BULL.HK',
      'prepare:BEAR.HK',
      'risk:BULL.HK',
      'risk:BEAR.HK',
      'ready',
    ]);
    expect(runtime.isCurrent(receipt)).toBe(true);
    expect(episodeTracker.getInProgressEpisodes()).toEqual([]);
    await runtime.stopAndDrain();
  });

  test('loader receives same synchronous completion capability without live cooldown, risk or ready', async () => {
    const { runtime, snapshot, businessDeps } = createFixture();
    const episodeTracker = createProtectiveLiquidationEpisodeTracker();
    episodeTracker.restoreInProgressEpisode({
      direction: 'SHORT',
      symbol: 'BEAR.HK',
      latestExecutedTimeMs: 1000,
    });
    const calls: string[] = [];
    runtime.bindBusinessDeps({
      ...businessDeps,
      dailyLossTracker: createDailyLossTrackerDouble({
        prepareProtectionBoundary: (params) => ({ ...params, orderBaselines: [] }),
        commitProtectionBoundary: () => {
          calls.push('boundary');
        },
      }),
      protectiveLiquidationEpisodeTracker: episodeTracker,
      liquidationCooldownTracker: createLiquidationCooldownTrackerDouble({
        recordLiquidationTrigger: () => {
          calls.push('cooldown');
        },
      }),
      mixedTradeLogRepository: {
        appendCompletionIdempotent: () => {
          calls.push('append');
        },
      },
    });
    const committed = await snapshot.requestRefresh({
      source: 'LIFECYCLE_REBUILD',
      dayEpoch: 1,
      refreshAccount: true,
      refreshPositions: true,
    }).result;
    if (committed.status !== 'COMMITTED') throw new Error('missing recovery snapshot');

    expect(
      runtime.completeProtectionRecovery({
        snapshotToken: committed.snapshotToken,
        pendingProtectiveDirections: new Set(),
      }),
    ).toBe(true);

    expect(
      runtime.completeProtectionRecovery({
        snapshotToken: committed.snapshotToken,
        pendingProtectiveDirections: new Set(),
      }),
    ).toBe(true);
    expect(calls).toEqual(['append', 'boundary']);
    expect(runtime.getStatus()).toEqual({ started: false, currentVersion: 0, staleVersion: 0 });
    await runtime.stopAndDrain();
  });
});
