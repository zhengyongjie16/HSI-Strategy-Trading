/**
 * 全局状态缓存域单元测试
 *
 * 覆盖：midnightClear 禁止交易、清空 allTradingSymbols、清空宿主账户与交易日事实；
 * openRebuild 调用 runTradingDayOpenRebuild(ctx.now)
 */
import { describe, it, expect } from 'bun:test';
import { createGlobalStateDomain } from '../../../../src/main/lifecycle/cacheDomains/globalStateDomain.js';
import type { LastState } from '../../../../src/types/state.js';
import {
  createAccountSnapshotDouble,
  createLoggerDouble,
  createPositionDouble,
} from '../../../helpers/testDoubles.js';

describe('createGlobalStateDomain', () => {
  it('midnightClear 设置 canTrade 为 false 并清空 allTradingSymbols 与缓存字段', async () => {
    const positionCacheUpdateSizes: number[] = [];
    const lastState: LastState = {
      canTrade: true,
      isHalfDay: false,
      openProtectionActive: false,
      currentDayKey: null,
      lifecycleState: 'ACTIVE',
      pendingOpenRebuild: false,
      isTradingEnabled: true,
      cachedAccount: createAccountSnapshotDouble(100000),
      cachedPositions: [
        createPositionDouble({
          symbol: 'BULL.HK',
          quantity: 100,
          availableQuantity: 100,
        }),
      ],
      positionCache: {
        update: (positions) => {
          positionCacheUpdateSizes.push(positions.length);
        },
        get: () => null,
      },
      cachedTradingDayInfo: null,
      tradingCalendarSnapshot: new Map(),
      allTradingSymbols: new Set(['12345.HK']),
    };

    let runOpenRebuildCalled = false;
    const domain = createGlobalStateDomain({
      logger: createLoggerDouble(),
      lastState,
      runTradingDayOpenRebuild: async () => {
        runOpenRebuildCalled = true;
      },
    });

    await domain.midnightClear({
      now: new Date(),
      runtime: { dayKey: '2025-02-15', canTradeNow: true, isTradingDay: true },
    });

    expect(lastState.canTrade).toBe(false);
    expect(lastState.allTradingSymbols.size).toBe(0);
    expect(lastState.isHalfDay).toBeNull();
    expect(lastState.openProtectionActive).toBeNull();
    expect(lastState.cachedAccount).toBeNull();
    expect(lastState.cachedPositions).toHaveLength(0);
    expect(positionCacheUpdateSizes).toEqual([0]);
    expect(lastState.cachedTradingDayInfo).toBeNull();
    expect('monitorState' in lastState).toBeFalse();

    expect(runOpenRebuildCalled).toBe(false);
  });

  it('openRebuild 调用 runTradingDayOpenRebuild(ctx.now)', async () => {
    const lastState: LastState = {
      canTrade: false,
      isHalfDay: null,
      openProtectionActive: null,
      currentDayKey: null,
      lifecycleState: 'MIDNIGHT_CLEANED',
      pendingOpenRebuild: true,
      isTradingEnabled: false,
      cachedAccount: null,
      cachedPositions: [],
      positionCache: { update: () => {}, get: () => null },
      cachedTradingDayInfo: null,
      tradingCalendarSnapshot: new Map(),
      allTradingSymbols: new Set(),
    };
    let capturedNow: Date | null = null as Date | null;
    const domain = createGlobalStateDomain({
      logger: createLoggerDouble(),
      lastState,
      runTradingDayOpenRebuild: async (now: Date) => {
        capturedNow = now;
      },
    });

    const now = new Date('2025-02-15T09:30:00Z');
    await domain.openRebuild({
      now,
      runtime: { dayKey: '2025-02-15', canTradeNow: true, isTradingDay: true },
    });

    expect(capturedNow).not.toBeNull();
    if (capturedNow !== null) {
      expect(capturedNow.getTime()).toBe(now.getTime());
    }
  });
});
