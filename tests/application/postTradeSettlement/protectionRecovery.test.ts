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
import { DIAGNOSTIC_OPERATIONS } from '../../../src/constants/diagnostics.js';
import type { DiagnosticFields } from '../../../src/types/diagnostics.js';
import { isExternalApiRequestError } from '../../../src/utils/apiFailure/index.js';
import {
  createAccountSnapshotDouble,
  createLoggerDouble,
  createPositionDouble,
  createTerminationDouble,
} from '../../helpers/testDoubles.js';

async function createFixture(positions = false) {
  const calls: string[] = [];
  const observations: Array<{
    readonly operation: string;
    readonly fields: DiagnosticFields;
    readonly callsAtObservation: ReadonlyArray<string>;
    readonly remainingEpisodes: number;
  }> = [];
  let diagnosticsFail = false;
  const completions: SettlementProtectionCompletion[] = [];
  const boundaryExecutedTimeMs = 1000;
  const snapshot = createAccountPositionSnapshot({
    clock: { now: () => new Date(0) },
    diagnostics: { record: () => {} },
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
    clock: { now: () => new Date(0) },
    diagnostics: {
      record: (operation, fields) => {
        observations.push({
          operation,
          fields,
          callsAtObservation: [...calls],
          remainingEpisodes: episodes.getInProgressEpisodes().length,
        });

        if (diagnosticsFail) throw new Error('diagnostic failed');
      },
    },
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
    observations,
    failDiagnostics: () => {
      diagnosticsFail = true;
    },
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
    expect(fixture.observations).toEqual([
      {
        operation: DIAGNOSTIC_OPERATIONS.LIQUIDATION_COMPLETION_COMMITTED,
        fields: {
          source: 'POST_TRADE_SETTLEMENT',
          monitorSymbol: 'HSI.HK',
          symbol: 'BULL.HK',
          seatDirection: 'LONG',
          boundaryExecutedTimeMs: fixture.boundaryExecutedTimeMs,
          cooldownProjection: 'LOG_HYDRATION',
          settlementVersion: 0,
          dayEpoch: token.dayEpoch,
          snapshotGeneration: token.snapshotGeneration,
          snapshotCommitRevision: token.commitRevision,
          accountRevision: token.accountRevision,
          positionRevision: token.positionRevision,
          pairedCommitRevision: token.pairedRevision,
        },
        callsAtObservation: [
          'prepare-episode',
          'prepare-boundary',
          'append',
          'boundary',
          'episode',
        ],
        remainingEpisodes: 0,
      },
    ]);
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
    expect(
      fixture.observations.filter(
        ({ operation }) => operation === DIAGNOSTIC_OPERATIONS.LIQUIDATION_COMPLETION_COMMITTED,
      ),
    ).toHaveLength(1);
    await runtime.stopAndDrain();
  });

  test('live completion is observed only after synchronous durable, boundary, cooldown and episode commits, before risk and unchanged fresh notifications', async () => {
    const { runtime, businessDeps, calls, observations, episodes } = await createFixture();
    runtime.bindBusinessDeps({
      ...businessDeps,
      seats: {
        ...businessDeps.seats,
        getSeatState: (direction) =>
          direction === 'LONG'
            ? { status: 'ACTIVE', symbol: 'BULL.HK' }
            : { status: 'EMPTY', symbol: null },
      },
      lossBoundaries: {
        ...businessDeps.lossBoundaries,
        prepareProtectionBoundary: (prepared) => {
          queueMicrotask(() => {
            calls.push('microtask');
          });
          return businessDeps.lossBoundaries.prepareProtectionBoundary(prepared);
        },
      },
    });

    runtime.onFreshReached(() => {
      calls.push('fresh');
    });
    runtime.start();
    expect(await runtime.completeRebuildBaseline()).toBe(true);
    expect(calls).toEqual([
      'subscription',
      'prepare-episode',
      'prepare-boundary',
      'append',
      'boundary',
      'cooldown',
      'episode',
      'risk-prepare',
      'risk',
      'fresh',
      'microtask',
    ]);

    expect(observations.map(({ operation }) => operation)).toEqual([
      DIAGNOSTIC_OPERATIONS.LIQUIDATION_COMPLETION_COMMITTED,
      DIAGNOSTIC_OPERATIONS.SETTLEMENT_READY,
    ]);

    expect(observations[0]).toMatchObject({
      fields: { cooldownProjection: 'LIVE_TRIGGER', settlementVersion: 0 },
      callsAtObservation: calls.slice(0, 7),
      remainingEpisodes: 0,
    });
    expect(observations[1]?.callsAtObservation).toEqual(calls.slice(0, 9));
    expect(episodes.getInProgressEpisodes()).toEqual([]);
    await runtime.stopAndDrain();
  });

  test.each(['append', 'boundary', 'cooldown', 'episode'] as const)(
    'failed live %s commit never reports completion or ready and preserves the original fatal',
    async (failedStage) => {
      const fixture = await createFixture();
      const { runtime, businessDeps, observations, termination, episodes, calls } = fixture;
      const failure = new Error(`failed ${failedStage}`);
      const fail = () => {
        calls.push(`failed-${failedStage}`);
        throw failure;
      };
      runtime.bindBusinessDeps({
        ...businessDeps,
        completionPersistence: {
          appendCompletionIdempotent:
            failedStage === 'append'
              ? fail
              : businessDeps.completionPersistence.appendCompletionIdempotent,
        },
        lossBoundaries: {
          ...businessDeps.lossBoundaries,
          commitProtectionBoundary:
            failedStage === 'boundary'
              ? fail
              : businessDeps.lossBoundaries.commitProtectionBoundary,
        },
        cooldownTriggers: {
          recordLiquidationTrigger:
            failedStage === 'cooldown'
              ? fail
              : businessDeps.cooldownTriggers.recordLiquidationTrigger,
        },
        episodes: {
          ...businessDeps.episodes,
          commitCompletion:
            failedStage === 'episode' ? fail : businessDeps.episodes.commitCompletion,
        },
      });
      runtime.recordSettlementRefreshNeed({ refreshAccount: true, refreshPositions: true });
      await fixture.snapshot.requestRefresh({
        source: 'LIFECYCLE_REBUILD',
        dayEpoch: 1,
        refreshAccount: true,
        refreshPositions: true,
      }).result;
      const waiting = runtime.waitForFresh().catch((error: unknown) => error);
      runtime.start();
      fixture.failDiagnostics();
      expect(await runtime.completeRebuildBaseline().catch((error: unknown) => error)).toBe(
        failure,
      );
      expect(String(await waiting)).toContain('FATAL_INVARIANT');
      expect(termination.getFatalState()).toEqual({ hasFatalError: true, error: failure });
      expect(episodes.getInProgressEpisodes()).toHaveLength(1);
      expect(observations.map(({ operation }) => operation)).toEqual([
        DIAGNOSTIC_OPERATIONS.SETTLEMENT_STALE,
        DIAGNOSTIC_OPERATIONS.SETTLEMENT_READINESS_COMPLETED,
      ]);

      expect(observations.at(-1)?.fields).toMatchObject({
        outcome: 'ABORTED',
        reason: 'FATAL_INVARIANT',
      });
      const committedStages = ['append', 'boundary', 'cooldown', 'episode'];
      expect(calls).toEqual([
        'subscription',
        'prepare-episode',
        'prepare-boundary',
        ...committedStages.slice(0, committedStages.indexOf(failedStage)),
        `failed-${failedStage}`,
      ]);
      expect(await runtime.stopAndDrain().catch((error: unknown) => error)).toBe(failure);
    },
  );

  test('throwing completion diagnostics cannot break live commit, risk, ready or subsequent fresh notification', async () => {
    const { runtime, businessDeps, calls, observations, failDiagnostics, termination } =
      await createFixture();
    runtime.bindBusinessDeps({
      ...businessDeps,
      seats: {
        ...businessDeps.seats,
        getSeatState: (direction) =>
          direction === 'LONG'
            ? { status: 'ACTIVE', symbol: 'BULL.HK' }
            : { status: 'EMPTY', symbol: null },
      },
    });

    runtime.onFreshReached(() => {
      calls.push('fresh');
    });
    failDiagnostics();
    runtime.start();
    expect(await runtime.completeRebuildBaseline()).toBe(true);
    expect(calls).toEqual([
      'subscription',
      'prepare-episode',
      'prepare-boundary',
      'append',
      'boundary',
      'cooldown',
      'episode',
      'risk-prepare',
      'risk',
      'fresh',
    ]);

    expect(observations.map(({ operation }) => operation)).toEqual([
      DIAGNOSTIC_OPERATIONS.LIQUIDATION_COMPLETION_COMMITTED,
      DIAGNOSTIC_OPERATIONS.SETTLEMENT_READY,
    ]);
    expect(termination.getFatalState()).toEqual({ hasFatalError: false });
    const receipt = await runtime.waitForFresh();
    expect(runtime.isCurrent(receipt)).toBe(true);
    await runtime.stopAndDrain();
  });

  test('completion remains committed if later risk publication fails; throwing diagnostics cannot mask that original fatal or report ready', async () => {
    const fixture = await createFixture();
    const { runtime, businessDeps, failDiagnostics, observations, termination, episodes } = fixture;
    const failure = new Error('risk publication failed');
    runtime.bindBusinessDeps({
      ...businessDeps,
      seats: {
        ...businessDeps.seats,
        getSeatState: (direction) =>
          direction === 'LONG'
            ? { status: 'ACTIVE', symbol: 'BULL.HK' }
            : { status: 'EMPTY', symbol: null },
      },
      riskProjection: {
        ...businessDeps.riskProjection,
        publish: () => {
          throw failure;
        },
      },
    });
    runtime.recordSettlementRefreshNeed({ refreshAccount: true, refreshPositions: true });
    await fixture.snapshot.requestRefresh({
      source: 'LIFECYCLE_REBUILD',
      dayEpoch: 1,
      refreshAccount: true,
      refreshPositions: true,
    }).result;
    failDiagnostics();
    runtime.start();
    expect(await runtime.completeRebuildBaseline().catch((error: unknown) => error)).toBe(failure);
    expect(episodes.getInProgressEpisodes()).toEqual([]);
    expect(termination.getFatalState()).toEqual({ hasFatalError: true, error: failure });
    expect(observations.map(({ operation }) => operation)).toEqual([
      DIAGNOSTIC_OPERATIONS.SETTLEMENT_STALE,
      DIAGNOSTIC_OPERATIONS.LIQUIDATION_COMPLETION_COMMITTED,
      DIAGNOSTIC_OPERATIONS.SETTLEMENT_READINESS_COMPLETED,
    ]);

    expect(observations.at(-1)?.fields).toMatchObject({
      outcome: 'ABORTED',
      reason: 'FATAL_INVARIANT',
    });
    expect(await runtime.stopAndDrain().catch((error: unknown) => error)).toBe(failure);
  });

  test('recovery completion diagnostics failure cannot prevent synchronous return or fabricate live cooldown and ready', async () => {
    const { runtime, businessDeps, token, observations, calls, failDiagnostics } =
      await createFixture();
    runtime.bindBusinessDeps(businessDeps);
    failDiagnostics();
    expect(
      runtime.completeProtectionRecovery({
        snapshotToken: token,
        pendingProtectiveDirections: new Set(),
      }),
    ).toBe(true);
    expect(calls).toEqual(['prepare-episode', 'prepare-boundary', 'append', 'boundary', 'episode']);
    expect(observations.map(({ operation }) => operation)).toEqual([
      DIAGNOSTIC_OPERATIONS.LIQUIDATION_COMPLETION_COMMITTED,
    ]);
    expect(observations[0]?.fields['cooldownProjection']).toBe('LOG_HYDRATION');
    await runtime.stopAndDrain();
  });

  test.each([true, false])(
    'actual original-symbol position or pending protective direction prevents recovery completion: position=%s',
    async (hasPosition) => {
      const { runtime, token, businessDeps, completions, episodes, observations } =
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
      expect(observations).toEqual([]);
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
