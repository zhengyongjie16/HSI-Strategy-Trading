/**
 * 跨日清理与开盘重建全链路集成测试
 *
 * 验证：dayKey 变化 → 午夜清理按域顺序执行 → MIDNIGHT_CLEANED →
 * 待开盘重建且交易日可交易 → 开盘重建按域逆序执行 → ACTIVE，交易门禁恢复
 */
import { createAccountSnapshotDouble } from '../../helpers/testDoubles.js';
import { createSnapshotFixture } from '../../helpers/accountPositionSnapshot.js';
import { createTerminationRuntime } from '../../../src/runtime/lifecycle/terminationRuntime.js';

import { describe, it, expect } from 'bun:test';
import type { CacheDomain } from '../../../src/runtime/lifecycle/types.js';
import type { LifecycleMutableState } from '../../../src/types/lifecycle.js';
import type { LifecycleRuntimeFlags } from '../../../src/types/timeControlPlane.js';
import { createDayLifecycleManager } from '../../../src/runtime/lifecycle/dayLifecycleManager.js';

function createMutableState(overrides?: Partial<LifecycleMutableState>): LifecycleMutableState {
  return {
    currentDayKey: null,
    lifecycleState: 'ACTIVE',
    pendingOpenRebuild: false,
    isTradingEnabled: true,
    ...overrides,
  };
}

function createRuntime(overrides?: Partial<LifecycleRuntimeFlags>): LifecycleRuntimeFlags {
  return {
    dayKey: '2025-02-15',
    canTradeNow: true,
    isTradingDay: true,
    ...overrides,
  };
}

describe('跨日清理与开盘重建全链路', () => {
  it('全链路：跨日后午夜清理完成，再 tick 满足开盘条件时执行开盘重建并恢复交易', async () => {
    const mutableState = createMutableState({ currentDayKey: '2025-02-14' });
    const steps: string[] = [];
    const snapshot = await createSnapshotFixture({
      account: createAccountSnapshotDouble('100000'),
      positions: [],
    });
    const domains: ReadonlyArray<CacheDomain> = [
      {
        midnightClear: () => {
          steps.push('midnight-1');
        },
        openRebuild: (ctx) => {
          steps.push('open-1');
          expect(
            snapshot.isCurrent(ctx.snapshotToken, { account: true, positions: true, paired: true }),
          ).toBe(true);
          return { status: 'COMMITTED', snapshotToken: ctx.snapshotToken };
        },
      },
      {
        midnightClear: () => {
          steps.push('midnight-2');
        },
        openRebuild: async (ctx) => {
          steps.push('open-2');
          const receipt = await snapshot.requestRefresh({
            source: 'LIFECYCLE_REBUILD',
            dayEpoch: ctx.dayEpoch,
            refreshAccount: true,
            refreshPositions: true,
          }).result;
          if (receipt.status === 'ABORTED' || !ctx.isCurrent()) return { status: 'ABORTED' };

          expect(receipt.snapshotToken.dayEpoch).toBe(ctx.dayEpoch);
          return { status: 'COMMITTED', snapshotToken: receipt.snapshotToken };
        },
      },
    ];
    const manager = createDayLifecycleManager({
      snapshot,
      termination: createTerminationRuntime({
        closeTradingGate: () => {},
        closeProducerAdmission: () => {},
        stopProducers: [],
        onSecondaryError: () => {},
      }),
      mutableState,
      cacheDomains: domains,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });

    await manager.tick(new Date(), createRuntime({ dayKey: '2025-02-15' }));
    expect(mutableState.lifecycleState).toBe('MIDNIGHT_CLEANED');
    expect(steps).toEqual(['midnight-1', 'midnight-2']);

    await manager.tick(new Date(), createRuntime());
    expect(mutableState.lifecycleState).toBe('ACTIVE');
    expect(mutableState.isTradingEnabled).toBe(true);
    expect(steps).toEqual(['midnight-1', 'midnight-2', 'open-2', 'open-1']);
  });

  it('全链路边界：开盘重建未满足前（非交易日）多次 tick 不执行 openRebuild', async () => {
    const mutableState = createMutableState({
      currentDayKey: '2025-02-15',
      pendingOpenRebuild: true,
      lifecycleState: 'MIDNIGHT_CLEANED',
      isTradingEnabled: false,
    });
    let openRebuildCount = 0;
    const snapshot = await createSnapshotFixture({
      account: createAccountSnapshotDouble('100000'),
      positions: [],
    });
    const domains: ReadonlyArray<CacheDomain> = [
      {
        midnightClear: () => {},
        openRebuild: () => {
          openRebuildCount += 1;
          throw new Error('Non-trading day must not enter rebuild');
        },
      },
    ];
    const manager = createDayLifecycleManager({
      snapshot,
      termination: createTerminationRuntime({
        closeTradingGate: () => {},
        closeProducerAdmission: () => {},
        stopProducers: [],
        onSecondaryError: () => {},
      }),
      mutableState,
      cacheDomains: domains,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });

    await manager.tick(new Date(), createRuntime({ isTradingDay: false }));
    await manager.tick(new Date(), createRuntime({ isTradingDay: false }));

    expect(openRebuildCount).toBe(0);
    expect(mutableState.lifecycleState).toBe('MIDNIGHT_CLEANED');
  });
});
