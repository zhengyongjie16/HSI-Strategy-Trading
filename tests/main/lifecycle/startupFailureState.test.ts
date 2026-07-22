/**
 * startupFailureState 单元测试
 *
 * 功能：
 * - 验证启动快照失败时的全局状态切换（阻断交易并进入开盘重建重试态）
 */
import { describe, expect, it } from 'bun:test';
import { applyStartupSnapshotFailureState } from '../../../src/main/lifecycle/startupFailureState.js';
import type { LastState } from '../../../src/types/state.js';

function createMinimalLastState(): LastState {
  return {
    canTrade: true,
    isHalfDay: false,
    openProtectionActive: false,
    currentDayKey: '2026-02-25',
    lifecycleState: 'ACTIVE',
    pendingOpenRebuild: false,
    isTradingEnabled: true,
    cachedAccount: null,
    cachedPositions: [],
    positionCache: {
      update: () => {},
      get: () => null,
    },
    cachedTradingDayInfo: null,
    tradingCalendarSnapshot: new Map(),
    monitorState: {
      monitorSymbol: 'HSI.HK',
      lastMonitorSnapshot: null,
      incrementalIndicatorRuntime: null,
    },
    allTradingSymbols: new Set(),
  };
}

describe('startupFailureState', () => {
  it('switches to open-rebuild retry state when startup snapshot load fails', () => {
    const lastState = createMinimalLastState();
    applyStartupSnapshotFailureState(lastState);

    expect(lastState.pendingOpenRebuild).toBe(true);
    expect(lastState.lifecycleState).toBe('OPEN_REBUILD_FAILED');
    expect(lastState.isTradingEnabled).toBe(false);
  });
});
