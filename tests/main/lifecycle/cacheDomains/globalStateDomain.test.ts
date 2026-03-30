/**
 * 全局状态缓存域单元测试
 *
 * 覆盖：midnightClear 禁止交易、清空 allTradingSymbols、重置各 monitorState；
 * openRebuild 调用 runTradingDayOpenRebuild(ctx.now)
 */
import { describe, it, expect } from 'bun:test';
import { createGlobalStateDomain } from '../../../../src/main/lifecycle/cacheDomains/globalStateDomain.js';
import type { LastState, StrategyState } from '../../../../src/types/state.js';
import { createAccountSnapshotDouble, createPositionDouble } from '../../../helpers/testDoubles.js';

function createMockStrategyState(baseInstrumentSymbol: string): StrategyState {
  return {
    baseInstrumentSymbol,
    monitorPrice: 1,
    longPrice: null,
    shortPrice: null,
    signal: null,
    pendingSignals: [],
    monitorValues: null,
    lastMonitorSnapshot: null,
    lastCandlestickCacheVersion: null,
  };
}

describe('createGlobalStateDomain', () => {
  it('midnightClear 设置 canTrade 为 false 并清空 allTradingSymbols 与缓存字段', async () => {
    const monitorState = createMockStrategyState('HSI.HK');
    const positionCacheUpdateSizes: number[] = [];
    const lastState: LastState = {
      canTrade: true,
      isHalfDay: false,
      openProtectionActive: false,
      currentDayKey: null,
      lifecycleState: 'ACTIVE',
      pendingOpenRebuild: false,
      targetTradingDayKey: null,
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
      monitorState,
      allTradingSymbols: new Set(['12345.HK']),
    };

    let runOpenRebuildCalled = false;
    const domain = createGlobalStateDomain({
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
    expect(lastState.isHalfDay).toBe(null);
    expect(lastState.openProtectionActive).toBe(null);
    expect(lastState.cachedAccount).toBe(null);
    expect(lastState.cachedPositions).toHaveLength(0);
    expect(positionCacheUpdateSizes).toEqual([0]);
    expect(lastState.cachedTradingDayInfo).toBe(null);
    expect(monitorState.monitorPrice).toBe(null);
    expect(monitorState.longPrice).toBe(null);
    expect(monitorState.signal).toBe(null);
    expect(monitorState.pendingSignals).toHaveLength(0);
    expect(monitorState.monitorValues).toBe(null);
    expect(monitorState.lastMonitorSnapshot).toBe(null);

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
      targetTradingDayKey: null,
      isTradingEnabled: false,
      cachedAccount: null,
      cachedPositions: [],
      positionCache: { update: () => {}, get: () => null },
      cachedTradingDayInfo: null,
      monitorState: {
        baseInstrumentSymbol: 'HSI.HK',
        monitorPrice: null,
        longPrice: null,
        shortPrice: null,
        signal: null,
        pendingSignals: [],
        monitorValues: null,
        lastMonitorSnapshot: null,
        lastCandlestickCacheVersion: null,
      },
      allTradingSymbols: new Set(),
    };
    let capturedNow: Date | null = null as Date | null;
    const domain = createGlobalStateDomain({
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

    expect(capturedNow).not.toBe(null);
    if (capturedNow !== null) {
      expect(capturedNow.getTime()).toBe(now.getTime());
    }
  });
});
