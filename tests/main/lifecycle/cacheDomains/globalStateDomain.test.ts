/**
 * 全局状态缓存域单元测试。
 * 午夜清理由真实 snapshot owner 清除事实；同步失效和关门先于已发 IO drain。
 * 开盘重建仍使用调用方提供的当前时间。
 */
import { describe, it, expect } from 'bun:test';
import { createGlobalStateDomain } from '../../../../src/main/lifecycle/cacheDomains/globalStateDomain.js';
import type { LastState } from '../../../../src/types/state.js';
import type { AccountSnapshot, Position } from '../../../../src/types/account.js';
import { createSnapshotFixture } from '../../fixtures/accountPositionSnapshot.js';
import {
  createAccountSnapshotDouble,
  createLoggerDouble,
  createPositionDouble,
} from '../../../helpers/testDoubles.js';

function createLastState(): LastState {
  return {
    canTrade: true,
    isHalfDay: false,
    openProtectionActive: false,
    currentDayKey: null,
    lifecycleState: 'ACTIVE',
    pendingOpenRebuild: false,
    isTradingEnabled: true,
    cachedTradingDayInfo: null,
    tradingCalendarSnapshot: new Map(),
    allTradingSymbols: new Set(['12345.HK']),
  };
}

describe('createGlobalStateDomain', () => {
  it('open ABORTED 保持交易门闭，不返回成功 token', async () => {
    const snapshot = await createSnapshotFixture({
      account: createAccountSnapshotDouble('100000'),
      positions: [],
    });
    const token = snapshot.getView().token;
    const lastState = createLastState();
    lastState.isTradingEnabled = false;
    lastState.pendingOpenRebuild = true;
    const domain = createGlobalStateDomain({
      snapshot,
      lastState,
      logger: createLoggerDouble(),
      runTradingDayOpenRebuild: async () => ({ status: 'ABORTED' }),
    });
    const result = await domain.openRebuild({
      now: new Date('2025-02-15T09:30:00Z'),
      runtime: { dayKey: '2025-02-15', canTradeNow: true, isTradingDay: true },
      dayEpoch: token.dayEpoch,
      snapshotToken: token,
      isCurrent: () => snapshot.isCurrent(token, { account: true, positions: true, paired: true }),
    });
    expect(result).toEqual({ status: 'ABORTED' });
    expect(lastState.isTradingEnabled).toBe(false);
    expect(lastState.pendingOpenRebuild).toBe(true);
  });

  it('midnightClear 禁止交易、清空标的集合和 canonical 账户持仓事实', async () => {
    const lastState = createLastState();
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
      lastState,
      snapshot,
      runTradingDayOpenRebuild: async () => {
        runOpenRebuildCalled = true;
        throw new Error('midnight test must not start open rebuild');
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
    expect(snapshot.getView().account).toBeNull();
    expect(snapshot.getView().positions).toHaveLength(0);
    expect(snapshot.getAvailablePosition('BULL.HK')).toBeNull();
    expect(snapshot.getView().accountInitialized).toBe(false);
    expect(snapshot.getView().positionsInitialized).toBe(false);
    expect(snapshot.isCurrent(oldToken, { account: true, positions: true })).toBe(false);
    expect(snapshot.getStatus().admission).toBe('CLOSED');
    expect(lastState.cachedTradingDayInfo).toBeNull();
    expect('monitorState' in lastState).toBeFalse();
    expect(runOpenRebuildCalled).toBe(false);
  });

  it('midnightClear 同步取消与失效，但必须等待账户及持仓两项已发 IO 都落定', async () => {
    let resolveAccount: ((value: AccountSnapshot) => void) | undefined;
    let resolvePositions: ((value: ReadonlyArray<Position>) => void) | undefined;
    const accountRead = new Promise<AccountSnapshot>((resolve) => {
      resolveAccount = resolve;
    });
    const positionsRead = new Promise<ReadonlyArray<Position>>((resolve) => {
      resolvePositions = resolve;
    });
    const snapshot = await createSnapshotFixture({
      readPort: {
        getAccountSnapshot: () => accountRead,
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
    expect(snapshot.getStatus().inFlight).toBe(true);
    const domain = createGlobalStateDomain({
      logger: createLoggerDouble(),
      lastState: createLastState(),
      snapshot,
      runTradingDayOpenRebuild: async () => {
        throw new Error('clear drain must not start open rebuild');
      },
    });
    let cleared = false;
    const clear = Promise.resolve(
      domain.midnightClear({
        now: new Date(),
        runtime: { dayKey: '2025-02-15', canTradeNow: true, isTradingDay: true },
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
    resolvePositions([
      createPositionDouble({ symbol: 'BULL.HK', quantity: 100, availableQuantity: 100 }),
    ]);
    await clear;
    expect(cleared).toBe(true);
    expect(snapshot.getView().account).toBeNull();
    expect(snapshot.getView().positions).toEqual([]);
  });

  it('openRebuild 调用 runTradingDayOpenRebuild(ctx.now)', async () => {
    const lastState = createLastState();
    lastState.lifecycleState = 'MIDNIGHT_CLEANED';
    lastState.pendingOpenRebuild = true;
    lastState.isTradingEnabled = false;
    let capturedNow: Date | null = null as Date | null;
    const snapshot = await createSnapshotFixture({
      account: createAccountSnapshotDouble('100000'),
      positions: [],
    });
    const capturedToken = snapshot.getView().token;
    const domain = createGlobalStateDomain({
      logger: createLoggerDouble(),
      lastState,
      snapshot,
      runTradingDayOpenRebuild: async (now: Date) => {
        capturedNow = now;
        return { status: 'COMMITTED', snapshotToken: capturedToken };
      },
    });
    const now = new Date('2025-02-15T09:30:00Z');
    const result = await domain.openRebuild({
      now,
      runtime: { dayKey: '2025-02-15', canTradeNow: true, isTradingDay: true },
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
