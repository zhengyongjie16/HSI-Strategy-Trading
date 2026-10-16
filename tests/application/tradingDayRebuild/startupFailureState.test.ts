import type { RuntimeStateFixtures } from '../../helpers/types.js';

/**
 * startupFailureState 单元测试
 *
 * 功能：
 * - 验证启动快照失败时的全局状态切换（阻断交易并进入开盘重建重试态）
 */
import { describe, expect, it } from 'bun:test';
import { applyStartupSnapshotFailureState } from '../../../src/application/tradingDayRebuild/startupFailureState.js';

function createMinimalRuntimeStates(): RuntimeStateFixtures {
  return {
    tradingTimeState: { canTrade: true, isHalfDay: false, openProtectionActive: false },
    lifecycleState: {
      currentDayKey: '2026-02-25',
      lifecycleState: 'ACTIVE',
      pendingOpenRebuild: false,
      isTradingEnabled: true,
    },
    tradingCalendarState: { cachedTradingDayInfo: null, tradingCalendarSnapshot: new Map() },
    quoteSubscriptionState: { allTradingSymbols: new Set() },
  };
}

describe('startupFailureState', () => {
  it('switches to open-rebuild retry state when startup snapshot load fails', () => {
    const stateFixtures = createMinimalRuntimeStates();
    applyStartupSnapshotFailureState(stateFixtures.lifecycleState);

    expect(stateFixtures.lifecycleState.pendingOpenRebuild).toBe(true);
    expect(stateFixtures.lifecycleState.lifecycleState).toBe('OPEN_REBUILD_FAILED');
    expect(stateFixtures.lifecycleState.isTradingEnabled).toBe(false);
  });
});
