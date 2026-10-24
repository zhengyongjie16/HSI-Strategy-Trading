import type { RuntimeStateFixtures } from '../../../helpers/types.js';

/**
 * 全局状态缓存域单元测试。
 * 午夜清理由真实 snapshot owner 清除事实；同步失效和关门先于已发 IO drain。
 * 开盘重建仍使用调用方提供的当前时间。
 */
import { describe, it, expect } from 'bun:test';
import { createGlobalStateDomain } from '../../../../src/runtime/lifecycle/cacheDomains/globalStateDomain.js';
import type { AccountSnapshot, Position } from '../../../../src/types/account.js';
import { createSnapshotFixture } from '../../../helpers/accountPositionSnapshot.js';
import {
  createAccountSnapshotDouble,
  createLoggerDouble,
  createPositionDouble,
} from '../../../helpers/testDoubles.js';

function createRuntimeStates(): RuntimeStateFixtures {
  return {
    tradingTimeState: { canTrade: true, isHalfDay: false, openProtectionActive: false },
    lifecycleState: {
      currentDayKey: null,
      lifecycleState: 'ACTIVE',
      pendingOpenRebuild: false,
      isTradingEnabled: true,
    },
    tradingCalendarState: { cachedTradingDayInfo: null, tradingCalendarSnapshot: new Map() },
    quoteSubscriptionState: { allTradingSymbols: new Set(['12345.HK']) },
  };
}

describe('createGlobalStateDomain', () => {
  it('open ABORTED 保持交易门闭，不返回成功 token', async () => {
    const snapshot = await createSnapshotFixture({
      account: createAccountSnapshotDouble('100000'),
      positions: [],
    });
    const token = snapshot.getView().token;
    const stateFixtures = createRuntimeStates();
    stateFixtures.lifecycleState.isTradingEnabled = false;
    stateFixtures.lifecycleState.pendingOpenRebuild = true;
    const domain = createGlobalStateDomain({
      snapshot,
      ...stateFixtures,
      logger: createLoggerDouble(),
      runTradingDayOpenRebuild: async () => ({ status: 'ABORTED' }),
    });
    const result = await domain.openRebuild({
      now: new Date('2025-02-15T09:30:00Z'),
      dayEpoch: token.dayEpoch,
      snapshotToken: token,
      isCurrent: () => snapshot.isCurrent(token, { account: true, positions: true, paired: true }),
    });
    expect(result).toEqual({ status: 'ABORTED' });
    expect(stateFixtures.lifecycleState.isTradingEnabled).toBe(false);
    expect(stateFixtures.lifecycleState.pendingOpenRebuild).toBe(true);
  });

  it('midnightClear 禁止交易、清空标的集合和 canonical 账户持仓事实', async () => {
    const stateFixtures = createRuntimeStates();
    const snapshot = await createSnapshotFixture({
      account: createAccountSnapshotDouble('100000'),
      positions: [
        createPositionDouble({ symbol: 'BULL.HK', quantity: 100, availableQuantity: 100 }),
      ],
    });
    const oldToken = snapshot.getView().token;
    let runOpenRebuildCalled = false;
    const domain = createGlobalStateDomain({
      logger: createLoggerDouble(),
      ...stateFixtures,
      snapshot,
      runTradingDayOpenRebuild: async () => {
        runOpenRebuildCalled = true;
        throw new Error('midnight test must not start open rebuild');
      },
    });

    await domain.midnightClear({
      now: new Date(),
    });

    expect(stateFixtures.tradingTimeState.canTrade).toBe(false);
    expect(stateFixtures.quoteSubscriptionState.allTradingSymbols.size).toBe(0);
    expect(stateFixtures.tradingTimeState.isHalfDay).toBeNull();
    expect(stateFixtures.tradingTimeState.openProtectionActive).toBeNull();
    expect(snapshot.getView().account).toBeNull();
    expect(snapshot.getView().positions).toHaveLength(0);
    expect(snapshot.getAvailablePosition('BULL.HK')).toBeNull();
    expect(snapshot.getView().accountInitialized).toBe(false);
    expect(snapshot.getView().positionsInitialized).toBe(false);
    expect(snapshot.isCurrent(oldToken, { account: true, positions: true })).toBe(false);
    expect(snapshot.getStatus().admission).toBe('CLOSED');
    expect(stateFixtures.tradingCalendarState.cachedTradingDayInfo).toBeNull();
    expect('monitorState' in stateFixtures).toBeFalse();
    expect(runOpenRebuildCalled).toBe(false);
  });

  it('midnightClear 同步取消与失效，但必须等待账户及持仓两项已发 IO 都落定', async () => {
    let resolveAccount: ((value: AccountSnapshot) => void) | undefined;
    let resolvePositions: ((value: ReadonlyArray<Position>) => void) | undefined;
    let accountIssued = false;
    const accountRead = new Promise<AccountSnapshot>((resolve) => {
      resolveAccount = resolve;
    });
    const positionsRead = new Promise<ReadonlyArray<Position>>((resolve) => {
      resolvePositions = resolve;
    });
    const snapshot = await createSnapshotFixture({
      readPort: {
        getAccountSnapshot: () => {
          accountIssued = true;
          return accountRead;
        },
        getStockPositions: () => positionsRead,
      },
    });
    const token = snapshot.getView().token;
    const refresh = snapshot.requestRefresh({
      source: 'TEST_ISSUED_READ',
      dayEpoch: token.dayEpoch,
      refreshAccount: true,
      refreshPositions: true,
    });
    await Promise.resolve();
    expect(accountIssued).toBeTrue();
    const states = createRuntimeStates();
    const timeReference = states.tradingTimeState;
    const calendarReference = states.tradingCalendarState;
    const subscriptionReference = states.quoteSubscriptionState;
    const originalSymbols = states.quoteSubscriptionState.allTradingSymbols;
    const domain = createGlobalStateDomain({
      logger: createLoggerDouble(),
      ...states,
      snapshot,
      runTradingDayOpenRebuild: async () => {
        throw new Error('clear drain must not start open rebuild');
      },
    });
    let cleared = false;
    const clear = Promise.resolve(
      domain.midnightClear({
        now: new Date(),
      }),
    ).then(() => {
      cleared = true;
    });

    expect(snapshot.getStatus().admission).toBe('CLOSED');
    expect(snapshot.getView().token.snapshotGeneration).toBeGreaterThan(token.snapshotGeneration);
    expect(await refresh.result).toEqual({ status: 'ABORTED' });
    expect(cleared).toBe(false);
    if (resolveAccount === undefined || resolvePositions === undefined)
      throw new Error('读取未发出');

    resolveAccount(createAccountSnapshotDouble('100000'));
    await Promise.resolve();
    await Promise.resolve();
    expect(cleared).toBe(false);
    expect(states.tradingTimeState.canTrade).toBeTrue();
    expect(states.quoteSubscriptionState.allTradingSymbols).toBe(originalSymbols);
    resolvePositions([
      createPositionDouble({ symbol: 'BULL.HK', quantity: 100, availableQuantity: 100 }),
    ]);
    await clear;
    expect(cleared).toBe(true);
    expect(states.tradingTimeState).toBe(timeReference);
    expect(states.tradingCalendarState).toBe(calendarReference);
    expect(states.quoteSubscriptionState).toBe(subscriptionReference);
    expect(states.tradingTimeState.canTrade).toBeFalse();
    expect(states.quoteSubscriptionState.allTradingSymbols.size).toBe(0);
    expect(snapshot.getView().account).toBeNull();
    expect(snapshot.getView().positions).toEqual([]);
  });

  it('openRebuild 调用 runTradingDayOpenRebuild(ctx.now)', async () => {
    const stateFixtures = createRuntimeStates();
    stateFixtures.lifecycleState.lifecycleState = 'MIDNIGHT_CLEANED';
    stateFixtures.lifecycleState.pendingOpenRebuild = true;
    stateFixtures.lifecycleState.isTradingEnabled = false;
    let capturedNow: Date | null = null as Date | null;
    const snapshot = await createSnapshotFixture({
      account: createAccountSnapshotDouble('100000'),
      positions: [],
    });
    const capturedToken = snapshot.getView().token;
    const domain = createGlobalStateDomain({
      logger: createLoggerDouble(),
      ...stateFixtures,
      snapshot,
      runTradingDayOpenRebuild: async (now: Date) => {
        capturedNow = now;
        return { status: 'COMMITTED', snapshotToken: capturedToken };
      },
    });
    const now = new Date('2025-02-15T09:30:00Z');
    const result = await domain.openRebuild({
      now,
      dayEpoch: capturedToken.dayEpoch,
      snapshotToken: capturedToken,
      isCurrent: () =>
        snapshot.isCurrent(capturedToken, { account: true, positions: true, paired: true }),
    });
    expect(result).toEqual({ status: 'COMMITTED', snapshotToken: capturedToken });
    expect(capturedNow).not.toBeNull();
    if (capturedNow !== null) expect(capturedNow.getTime()).toBe(now.getTime());
  });
});
