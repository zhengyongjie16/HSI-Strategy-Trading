import { createDiagnosticObserverDouble } from '../../helpers/diagnostics.js';
import { createRuntimeStateFixtures } from '../../helpers/runtimeStateFixtures.js';
import type { RuntimeStateFixtures } from '../../helpers/types.js';

/**
 * P1 snapshot 跨来源安全回归。
 * 真实 coordinator 统一准入和提交，午夜使用真实 globalState domain；
 * broker 读取与时钟可控，不再允许旧 writer 迟到提交的两可观测分支。
 */
import { describe, expect, it } from 'bun:test';
import { createAccountPositionSnapshot } from '../../../src/application/accountPositionSnapshot/index.js';
import { createGlobalStateDomain } from '../../../src/runtime/lifecycle/cacheDomains/globalStateDomain.js';
import type { AccountSnapshot, Position } from '../../../src/types/account.js';
import { createLoggerDouble } from '../../helpers/testDoubles.js';
import { createExternalApiRequestError } from '../../helpers/createExternalApiRequestError.js';

function account(cash: string): AccountSnapshot {
  return {
    currency: 'HKD',
    totalCash: cash,
    netAssets: cash,
    positionValue: '0',
    cashInfos: [{ currency: 'HKD', availableCash: cash }],
  };
}

function position(symbol: string): Position {
  return {
    accountChannel: 'cash',
    symbol,
    symbolName: symbol,
    quantity: 100,
    availableQuantity: 100,
    currency: 'HKD',
    costPrice: '1',
  };
}

function createState(): RuntimeStateFixtures {
  return createRuntimeStateFixtures({
    tradingTimeState: { canTrade: false, isHalfDay: false, openProtectionActive: false },
    lifecycleState: {
      currentDayKey: '2026-07-10',
      lifecycleState: 'MIDNIGHT_CLEANING',
      pendingOpenRebuild: false,
      isTradingEnabled: false,
    },
    tradingCalendarState: { cachedTradingDayInfo: null, tradingCalendarSnapshot: new Map() },
    quoteSubscriptionState: { allTradingSymbols: new Set() },
  });
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

const scheduler = { schedule: queueMicrotask };
const request = { dayEpoch: 1, refreshAccount: true, refreshPositions: true };

describe('P1 snapshot cross-source targets', () => {
  it('keeps the previous pair when a later seat positions read fails', async () => {
    const failure = await createExternalApiRequestError({
      operation: 'positions',
      attempts: 1,
      cause: new Error('positions unavailable'),
    });
    let reads = 0;
    const owner = createAccountPositionSnapshot({
      clock: { now: () => new Date() },
      diagnostics: createDiagnosticObserverDouble(),
      dayEpoch: 1,
      scheduler,
      reportFatalError: (error) => {
        throw error;
      },
      readPort: {
        getAccountSnapshot: async () => account(reads === 0 ? '100' : '200'),
        getStockPositions: async () => {
          reads += 1;
          if (reads === 2) throw failure;

          return [position('INITIAL.HK')];
        },
      },
    });
    await owner.requestRefresh({ ...request, source: 'LIFECYCLE_REBUILD' }).result;
    const previous = owner.getView();
    const result = owner.requestRefresh({ ...request, source: 'SEAT_ACTIVATION' }).result;
    const rejected = await result.catch((error: unknown) => error);
    expect(rejected).toBe(failure);
    expect(owner.getView()).toBe(previous);
    expect(owner.getView().account?.totalCash).toBe('100');
    expect(owner.getView().positions[0]?.symbol).toBe('INITIAL.HK');
    expect(owner.getView().token.commitRevision).toBe(1);
  });

  it('cancels old seat admission before midnight domain drain and never repopulates cleared truth', async () => {
    const accounts = Promise.withResolvers<AccountSnapshot>();
    const positions = Promise.withResolvers<ReadonlyArray<Position>>();
    let issuedReads = 0;
    const owner = createAccountPositionSnapshot({
      clock: { now: () => new Date() },
      diagnostics: createDiagnosticObserverDouble(),
      dayEpoch: 1,
      scheduler,
      reportFatalError: (error) => {
        throw error;
      },
      readPort: {
        getAccountSnapshot: () => {
          issuedReads += 1;
          return accounts.promise;
        },
        getStockPositions: () => {
          issuedReads += 1;
          return positions.promise;
        },
      },
    });
    const seat = owner.requestRefresh({ ...request, source: 'SEAT_ACTIVATION' });
    await flushMicrotasks();
    expect(issuedReads).toBe(2);
    const clear = owner.requestClear({ reason: 'DAY_CUT', dayEpoch: 2 });
    const state = createState();
    const domain = createGlobalStateDomain({
      ...state,
      snapshot: owner,
      logger: createLoggerDouble(),
      runTradingDayOpenRebuild: async () => {
        throw new Error('Midnight interleaving case does not authorize open rebuild');
      },
    });
    let drained = false;
    const midnight = Promise.resolve(
      domain.midnightClear({
        now: new Date('2026-07-11T00:00:00+08:00'),
      }),
    ).then(() => {
      drained = true;
    });
    const seatReceipt = await seat.result;
    expect(seatReceipt.status).toBe('ABORTED');
    expect(owner.getStatus().admission).toBe('CLOSED');
    accounts.resolve(account('100'));
    await flushMicrotasks();
    expect(drained).toBe(false);
    positions.resolve([position('OLD.HK')]);
    await Promise.all([clear, midnight]);
    expect(owner.getView().account).toBeNull();
    expect(owner.getView().positions).toEqual([]);
    expect(owner.getAvailablePosition('OLD.HK')).toBeNull();
    expect(owner.getView().token.dayEpoch).toBe(2);
    expect(owner.getView().token.commitRevision).toBe(0);
    const afterCut = owner.getView().token;
    await owner.requestClear({ reason: 'DAY_CUT', dayEpoch: 2 });
    expect(owner.getView().token).toEqual(afterCut);
    expect(state.tradingTimeState.canTrade).toBe(false);
  });

  it('serializes issued settlement and pending seat requests and discards the superseded pair', async () => {
    const oldAccount = Promise.withResolvers<AccountSnapshot>();
    const oldPositions = Promise.withResolvers<ReadonlyArray<Position>>();
    const calls: string[] = [];
    let batches = 0;
    const owner = createAccountPositionSnapshot({
      clock: { now: () => new Date() },
      diagnostics: createDiagnosticObserverDouble(),
      dayEpoch: 1,
      scheduler,
      reportFatalError: (error) => {
        throw error;
      },
      readPort: {
        getAccountSnapshot: () => {
          batches += 1;
          calls.push(`account:${batches}`);
          return batches === 1 ? oldAccount.promise : Promise.resolve(account('200'));
        },
        getStockPositions: () => {
          calls.push(`positions:${batches}`);
          return batches === 1 ? oldPositions.promise : Promise.resolve([position('NEW.HK')]);
        },
      },
    });
    const settlement = owner.requestRefresh({ ...request, source: 'POST_TRADE_SETTLEMENT' });
    await flushMicrotasks();
    owner.invalidate();
    const seat = owner.requestRefresh({ ...request, source: 'SEAT_ACTIVATION' });
    oldAccount.resolve(account('100'));
    await flushMicrotasks();
    expect(calls).toEqual(['account:1', 'positions:1']);
    expect(owner.getView().token.commitRevision).toBe(0);
    oldPositions.resolve([position('OLD.HK')]);
    const [settlementReceipt, seatReceipt] = await Promise.all([settlement.result, seat.result]);
    expect(settlementReceipt.status).toBe('COMMITTED');
    expect(seatReceipt.status).toBe('COMMITTED');
    expect(settlementReceipt).toBe(seatReceipt);
    expect(calls).toEqual(['account:1', 'positions:1', 'account:2', 'positions:2']);
    expect(owner.getView().account?.totalCash).toBe('200');
    expect(owner.getView().positions[0]?.symbol).toBe('NEW.HK');
    expect(owner.getView().token).toMatchObject({ snapshotGeneration: 1, commitRevision: 1 });
    expect(owner.getAvailablePosition('OLD.HK')).toBeNull();
  });
});
