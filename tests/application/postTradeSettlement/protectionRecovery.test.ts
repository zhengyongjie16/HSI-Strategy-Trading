/** 同一 completion 事务恢复测试：精确 baseline、同步顺序、hydrate 唯一冷却、最后事实复核和失败不提交。 */
import { describe, expect, test } from 'bun:test';
import { createPostTradeSettlementWorkflow } from '../../../src/application/postTradeSettlement/index.js';
import { createAccountPositionSnapshot } from '../../../src/application/accountPositionSnapshot/index.js';
import { createProtectiveLiquidationEpisodeTracker } from '../../../src/domain/liquidation/episode/index.js';
import type {
  PostTradeSettlementBusinessDeps,
  SettlementProtectionCompletion,
  SettlementProtectionOrderBaseline,
} from '../../../src/application/postTradeSettlement/types.js';
import { API } from '../../../src/constants/index.js';
import { isExternalApiRequestError } from '../../../src/utils/apiFailure/index.js';
import {
  createAccountSnapshotDouble,
  createLoggerDouble,
  createPositionDouble,
  createTerminationDouble,
} from '../../helpers/testDoubles.js';

async function createFixture(positions = false) {
  const calls: string[] = [];
  const completions: SettlementProtectionCompletion[] = [];
  const boundaryExecutedTimeMs = 1000;
  const snapshot = createAccountPositionSnapshot({
    dayEpoch: 1,
    scheduler: { schedule: queueMicrotask },
    reportFatalError: () => {},
    readPort: {
      getAccountSnapshot: async () => createAccountSnapshotDouble('10000'),
      getStockPositions: async () =>
        positions
          ? [createPositionDouble({ symbol: 'BULL.HK', quantity: 1, availableQuantity: 1 })]
          : [],
    },
  });
  const episodes = createProtectiveLiquidationEpisodeTracker();
  episodes.restoreInProgressEpisode({
    direction: 'LONG',
    symbol: 'BULL.HK',
    latestExecutedTimeMs: boundaryExecutedTimeMs,
  });
  const orderBaselines: ReadonlyArray<SettlementProtectionOrderBaseline> = [
    {
      orderId: 'sell-1',
      symbol: 'BULL.HK',
      side: 'SELL',
      cumulativeQuantity: '3000',
      cumulativeAmount: '1000.0000000000000001',
      lastExecutionTimeMs: 1000,
      orderRevisionMs: 1010,
    },
  ];
  let longVersion = 1;
  const termination = createTerminationDouble();
  const runtime = createPostTradeSettlementWorkflow({
    snapshot,
    hasPendingProtectiveOrders: () => false,
    onPositionsCommitted: async () => {
      calls.push('subscription');
    },
    scheduler: {
      scheduleTimer: () => {
        const handle = setTimeout(() => {}, 2_147_483_647);
        clearTimeout(handle);
        return handle;
      },
      clearTimer: () => {},
    },
    termination,
    logger: createLoggerDouble(),
    retryDelayMs: API.DEFAULT_RETRY_DELAY_MS,
    isExternalFailure: isExternalApiRequestError,
  });
  const businessDeps: PostTradeSettlementBusinessDeps = {
    monitorSymbol: 'HSI.HK',
    seats: {
      getSeatState: () => ({ status: 'EMPTY', symbol: null }),
      getSeatVersion: (direction) => (direction === 'LONG' ? longVersion : 1),
    },
    episodes: {
      ...episodes,
      prepareCompletion: (params) => {
        calls.push('prepare-episode');
        return episodes.prepareCompletion(params);
      },
      commitCompletion: (prepared) => {
        calls.push('episode');
        episodes.commitCompletion(prepared);
      },
    },
    lossBoundaries: {
      prepareProtectionBoundary: (params) => {
        calls.push('prepare-boundary');
        return { ...params, orderBaselines };
      },
      commitProtectionBoundary: () => {
        calls.push('boundary');
      },
      getLossOffset: () => '0',
    },
    completionPersistence: {
      appendCompletionIdempotent: (completion) => {
        calls.push('append');
        completions.push(completion);
      },
    },
    cooldownTriggers: {
      recordLiquidationTrigger: () => {
        calls.push('cooldown');
      },
    },
    riskProjection: {
      prepare: (symbol) => {
        calls.push('risk-prepare');
        return { symbol, data: { r1: '0', n1: 0 } };
      },
      publish: () => {
        calls.push('risk');
      },
    },
  };
  const receipt = await snapshot.requestRefresh({
    source: 'LIFECYCLE_REBUILD',
    dayEpoch: 1,
    refreshAccount: true,
    refreshPositions: true,
  }).result;
  if (receipt.status !== 'COMMITTED') throw new Error('missing paired baseline');

  return {
    runtime,
    snapshot,
    calls,
    episodes,
    businessDeps,
    completions,
    orderBaselines,
    termination,
    token: receipt.snapshotToken,
    boundaryExecutedTimeMs,
    bumpSeat: () => {
      longVersion += 1;
    },
  };
}

describe('same-owner protection recovery', () => {
  test('durable append and exact boundary commit are synchronous; hydration is sole cooldown projection and subsequent live baseline cannot double-complete', async () => {
    const fixture = await createFixture();
    const { runtime, calls, businessDeps, completions, orderBaselines, episodes, token } = fixture;
    runtime.bindBusinessDeps(businessDeps);
    let reached = 0;
    runtime.onFreshReached(() => {
      reached += 1;
    });
    const result = runtime.completeProtectionRecovery({
      snapshotToken: token,
      pendingProtectiveDirections: new Set(),
    });
    expect(result).toBe(true);
    expect(calls).toEqual(['prepare-episode', 'prepare-boundary', 'append', 'boundary', 'episode']);
    expect(completions[0]?.orderBaselines).toBe(orderBaselines);
    expect(completions[0]?.orderBaselines[0]?.cumulativeAmount).toBe('1000.0000000000000001');
    expect(episodes.getInProgressEpisodes()).toEqual([]);
    expect(reached).toBe(0);
    expect(runtime.getStatus().started).toBe(false);
    // loader 紧随其后以全部 durable completion hydrate 冷却，而非再次发出实时 trigger。
    const hydrate = () => {
      expect(completions).toHaveLength(1);
      calls.push('hydrate');
    };
    hydrate();
    expect(
      runtime.completeProtectionRecovery({
        snapshotToken: token,
        pendingProtectiveDirections: new Set(),
      }),
    ).toBe(true);
    runtime.start();
    expect(await runtime.completeRebuildBaseline()).toBe(true);
    expect(completions).toHaveLength(1);
    expect(calls.filter((entry) => entry === 'cooldown')).toEqual([]);
    expect(reached).toBe(1);
    await runtime.stopAndDrain();
  });

  test.each([true, false])(
    'actual original-symbol position or pending protective direction prevents recovery completion: position=%s',
    async (hasPosition) => {
      const { runtime, token, businessDeps, completions, episodes } =
        await createFixture(hasPosition);
      runtime.bindBusinessDeps(businessDeps);
      expect(
        runtime.completeProtectionRecovery({
          snapshotToken: token,
          pendingProtectiveDirections: new Set<'LONG' | 'SHORT'>(hasPosition ? [] : ['LONG']),
        }),
      ).toBe(true);
      expect(completions).toEqual([]);
      expect(episodes.getInProgressEpisodes()).toHaveLength(1);
      await runtime.stopAndDrain();
    },
  );

  test('persist failure leaves boundary, cooldown and episode intact', async () => {
    const { runtime, token, businessDeps, calls, episodes } = await createFixture();
    runtime.bindBusinessDeps({
      ...businessDeps,
      completionPersistence: {
        appendCompletionIdempotent: () => {
          calls.push('failed-append');
          throw new Error('persistence failed');
        },
      },
    });

    expect(() =>
      runtime.completeProtectionRecovery({
        snapshotToken: token,
        pendingProtectiveDirections: new Set(),
      }),
    ).toThrow('persistence failed');
    expect(calls).toEqual(['prepare-episode', 'prepare-boundary', 'failed-append']);
    expect(episodes.getInProgressEpisodes()).toHaveLength(1);
    await runtime.stopAndDrain();
  });

  test.each(['SEAT', 'NEW_FILL', 'PENDING_ORDER'] as const)(
    'last synchronous fact validation rejects reentrancy during prepare: %s',
    async (change) => {
      const { runtime, token, businessDeps, completions, episodes, bumpSeat } =
        await createFixture();
      const pending = new Set<'LONG' | 'SHORT'>();
      runtime.bindBusinessDeps({
        ...businessDeps,
        lossBoundaries: {
          ...businessDeps.lossBoundaries,
          prepareProtectionBoundary: (prepared) => {
            if (change === 'SEAT') bumpSeat();
            else if (change === 'NEW_FILL')
              episodes.recordProtectiveFillProgress({
                direction: 'LONG',
                symbol: 'BULL.HK',
                executedTimeMs: 1001,
              });
            else pending.add('LONG');

            return businessDeps.lossBoundaries.prepareProtectionBoundary(prepared);
          },
        },
      });

      expect(
        runtime.completeProtectionRecovery({
          snapshotToken: token,
          pendingProtectiveDirections: pending,
        }),
      ).toBe(false);
      expect(completions).toEqual([]);
      expect(episodes.getInProgressEpisodes()).toHaveLength(1);
      await runtime.stopAndDrain();
    },
  );

  test.each(['GENERATION', 'CLOSED', 'TERMINATED'] as const)(
    'obsolete lifecycle authorization cannot enter the completion transaction: %s',
    async (change) => {
      const { runtime, token, businessDeps, calls, snapshot, termination } = await createFixture();
      runtime.bindBusinessDeps(businessDeps);
      if (change === 'GENERATION') snapshot.invalidate();
      else if (change === 'CLOSED') await snapshot.requestClear({ reason: 'STOP', dayEpoch: 1 });
      else termination.requestShutdown();

      expect(
        runtime.completeProtectionRecovery({
          snapshotToken: token,
          pendingProtectiveDirections: new Set(),
        }),
      ).toBe(false);
      expect(calls).toEqual([]);
      await runtime.stopAndDrain();
    },
  );
});
