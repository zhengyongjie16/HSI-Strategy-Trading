/** 交易日生命周期诊断测试：重建真实完成后开门，既有失败计数与重试安排分开记录，取消不冒报成功。 */
import { describe, expect, it } from 'bun:test';
import { DIAGNOSTIC_OPERATIONS } from '../../../src/constants/diagnostics.js';
import { createDayLifecycleManager } from '../../../src/runtime/lifecycle/dayLifecycleManager.js';
import { createTerminationRuntime } from '../../../src/runtime/lifecycle/terminationRuntime.js';
import type { CacheDomain, OpenRebuildContext } from '../../../src/runtime/lifecycle/types.js';
import type { LifecycleMutableState } from '../../../src/types/lifecycle.js';
import type { DiagnosticFields } from '../../../src/types/diagnostics.js';
import { createSnapshotFixture } from '../../helpers/accountPositionSnapshot.js';
import { createAccountSnapshotDouble, createLoggerDouble } from '../../helpers/testDoubles.js';
import { createExternalApiRequestError } from '../../helpers/createExternalApiRequestError.js';

const runtimeFlags = { dayKey: '2026-03-09', isTradingDay: true, canTradeNow: true };

async function createHarness() {
  const state: LifecycleMutableState = {
    currentDayKey: runtimeFlags.dayKey,
    lifecycleState: 'MIDNIGHT_CLEANED',
    isTradingEnabled: false,
    pendingOpenRebuild: true,
  };
  const snapshot = await createSnapshotFixture({ account: createAccountSnapshotDouble('100000') });
  const termination = createTerminationRuntime({
    closeTradingGate: () => {
      state.isTradingEnabled = false;
    },
    closeProducerAdmission: () => {},
    stopProducers: [],
    onSecondaryError: () => {},
  });
  const events: DiagnosticFields[] = [];
  const diagnosticObserver = {
    record: (operation: string, fields: DiagnosticFields) => {
      events.push({ ...fields, operation });
    },
  };

  async function commit(ctx: OpenRebuildContext) {
    const result = await snapshot.requestRefresh({
      source: 'LIFECYCLE_REBUILD',
      dayEpoch: ctx.dayEpoch,
      refreshAccount: true,
      refreshPositions: true,
    }).result;
    if (result.status !== 'COMMITTED') return { status: 'ABORTED' as const };

    return { status: 'COMMITTED' as const, snapshotToken: result.snapshotToken };
  }

  function createManager(domain: CacheDomain, diagnostics = diagnosticObserver) {
    return createDayLifecycleManager({
      mutableState: state,
      snapshot,
      termination,
      diagnostics,
      cacheDomains: [domain],
      logger: createLoggerDouble(),
      rebuildRetryDelayMs: 100,
    });
  }
  return { state, snapshot, termination, events, commit, createManager };
}

describe('day lifecycle diagnostics', () => {
  it('emits rebuilt only after actual captured domain completion and restored admission/gate', async () => {
    const harness = await createHarness();
    let resume = () => {};
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let entered = false;
    const manager = harness.createManager({
      midnightClear: () => {},
      openRebuild: async (ctx) => {
        entered = true;
        await gate;
        return harness.commit(ctx);
      },
    });
    const running = manager.tick(new Date(1_000), runtimeFlags);
    expect(entered).toBe(true);
    expect(harness.events).toEqual([]);
    expect(harness.state.isTradingEnabled).toBe(false);
    resume();
    await running;
    expect(harness.state.isTradingEnabled).toBe(true);
    expect(harness.snapshot.getStatus().admission).toBe('OPEN');
    expect(harness.events).toEqual([
      expect.objectContaining({
        operation: DIAGNOSTIC_OPERATIONS.TRADING_DAY_REBUILT,
        source: 'OPEN_REBUILD',
        dayKey: runtimeFlags.dayKey,
        retryCount: 0,
        lifecycleState: 'ACTIVE',
        isTradingEnabled: true,
        pendingOpenRebuild: false,
        dayEpoch: harness.snapshot.getStatus().token.dayEpoch,
        snapshotCommitRevision: harness.snapshot.getStatus().token.commitRevision,
      }),
    ]);
    await manager.tick(new Date(1_001), runtimeFlags);
    expect(harness.events).toHaveLength(1);
  });

  it('reports external failure and the existing scheduled retry separately, without adding retries while waiting', async () => {
    const harness = await createHarness();
    const external = await createExternalApiRequestError({
      operation: 'test.openRebuild',
      attempts: 1,
      cause: new Error('offline failure'),
    });
    let calls = 0;
    const manager = harness.createManager({
      midnightClear: () => {},
      openRebuild: async (ctx) => {
        calls += 1;
        if (calls === 1) throw external;

        return harness.commit(ctx);
      },
    });
    const failedTick = await manager.tick(new Date(1_000), runtimeFlags);
    expect(failedTick.nextRetryAtMs).toBe(1_100);
    expect(harness.events).toEqual([
      expect.objectContaining({
        operation: DIAGNOSTIC_OPERATIONS.OPEN_REBUILD_RETRY,
        phase: 'FAILED',
        retryCount: 1,
      }),
      expect.objectContaining({
        operation: DIAGNOSTIC_OPERATIONS.OPEN_REBUILD_RETRY,
        phase: 'SCHEDULED',
        retryCount: 1,
        retryDelayMs: 100,
        nextRetryAtMs: 1_100,
      }),
    ]);
    await manager.tick(new Date(1_099), runtimeFlags);
    expect(calls).toBe(1);
    expect(harness.events).toHaveLength(2);
    await manager.tick(new Date(1_100), runtimeFlags);
    expect(calls).toBe(2);
    expect(harness.events.at(-1)).toMatchObject({
      operation: DIAGNOSTIC_OPERATIONS.TRADING_DAY_REBUILT,
      retryCount: 1,
    });
    expect(harness.state.isTradingEnabled).toBe(true);
  });

  it('does not emit success/retry for ABORTED or replace internal fatal identity with diagnostics', async () => {
    const harness = await createHarness();
    const aborted = harness.createManager({
      midnightClear: () => {},
      openRebuild: () => ({ status: 'ABORTED' }),
    });
    const abortedTick = await aborted.tick(new Date(0), runtimeFlags);
    expect(abortedTick.nextRetryAtMs).toBeNull();
    expect(harness.events).toEqual([]);
    expect(harness.state.pendingOpenRebuild).toBe(true);
    const internal = new TypeError('broken invariant');
    const failed = harness.createManager({
      midnightClear: () => {},
      openRebuild: () => {
        throw internal;
      },
    });
    expect(await failed.tick(new Date(1), runtimeFlags).catch((error: unknown) => error)).toBe(
      internal,
    );
    expect(harness.events).toEqual([]);
    expect(harness.state.isTradingEnabled).toBe(false);
  });

  it('keeps real failure retry and successful gate transitions when the observer itself throws', async () => {
    const harness = await createHarness();
    const external = await createExternalApiRequestError({
      operation: 'test.openRebuild',
      attempts: 1,
      cause: new Error('offline failure'),
    });
    let calls = 0;
    const manager = harness.createManager(
      {
        midnightClear: () => {},
        openRebuild: async (ctx) => {
          calls += 1;
          if (calls === 1) throw external;

          return harness.commit(ctx);
        },
      },
      {
        record: () => {
          throw new Error('observer failed');
        },
      },
    );
    const failedTick = await manager.tick(new Date(0), runtimeFlags);
    expect(failedTick.nextRetryAtMs).toBe(100);
    expect(harness.state.lifecycleState).toBe('OPEN_REBUILD_FAILED');
    await manager.tick(new Date(100), runtimeFlags);
    expect(harness.state.lifecycleState).toBe('ACTIVE');
    expect(harness.state.isTradingEnabled).toBe(true);
    expect(calls).toBe(2);
  });
});
