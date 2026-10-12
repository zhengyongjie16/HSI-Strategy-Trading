/** Snapshot owner 离线协议测试：批次冻结、失效重排、取消与真实 IO drain。 */
import { describe, expect, test } from 'bun:test';
import { createAccountPositionSnapshot } from '../../../src/application/accountPositionSnapshot/index.js';
import type { AccountSnapshot, Position } from '../../../src/types/account.js';
import { isExternalApiRequestError } from '../../../src/utils/apiFailure/index.js';
import { createExternalApiRequestError } from '../../helpers/createExternalApiRequestError.js';

function deferred<T>() {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  return { promise, resolve, reject };
}
const account: AccountSnapshot = {
  currency: 'HKD',
  totalCash: '100.0000001',
  netAssets: '120.0000002',
  positionValue: '20.0000001',
  cashInfos: [{ currency: 'HKD', availableCash: '99.0000001' }],
};
const positions: ReadonlyArray<Position> = [
  {
    accountChannel: 'cash',
    symbol: 'A.HK',
    symbolName: 'A',
    quantity: 100,
    availableQuantity: 0,
    currency: 'HKD',
    costPrice: '0.333333333333333333333',
  },
];
const scheduler = {
  schedule: (callback: () => void) => {
    queueMicrotask(callback);
  },
};
const request = { source: 'TEST', dayEpoch: 1, refreshAccount: true, refreshPositions: true };

async function tick() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('canonical snapshot', () => {
  test('single external failure retains identity; paired failures retain both causes and retry classification', async () => {
    const accountError = await createExternalApiRequestError({
      operation: 'TradeContext.accountBalance',
      attempts: 1,
      cause: new Error('account unavailable'),
    });
    const positionsError = await createExternalApiRequestError({
      operation: 'TradeContext.stockPositions',
      attempts: 1,
      cause: new Error('positions unavailable'),
    });
    const fatal: unknown[] = [];
    let failPositions = false;
    const owner = createAccountPositionSnapshot({
      dayEpoch: 1,
      scheduler,
      reportFatalError: (error) => {
        fatal.push(error);
      },
      readPort: {
        getAccountSnapshot: async () => {
          throw accountError;
        },
        getStockPositions: async () => {
          if (failPositions) throw positionsError;

          return positions;
        },
      },
    });
    expect(await owner.requestRefresh(request).result.catch((error: unknown) => error)).toBe(
      accountError,
    );
    failPositions = true;
    const aggregate: unknown = await owner
      .requestRefresh(request)
      .result.catch((error: unknown) => error);
    expect(isExternalApiRequestError(aggregate)).toBe(true);
    expect(aggregate).toBeInstanceOf(AggregateError);
    if (!(aggregate instanceof AggregateError))
      throw new Error('Expected classified paired failure');

    expect(aggregate.errors).toEqual([accountError, positionsError]);
    expect(fatal).toEqual([]);
    expect(owner.getView().token.commitRevision).toBe(0);
    expect(owner.getStatus().admission).toBe('OPEN');
  });

  test('deep immutable detail store and available lookup do not confuse total with available', async () => {
    const owner = createAccountPositionSnapshot({
      dayEpoch: 1,
      scheduler,
      reportFatalError: () => {},
      readPort: {
        getAccountSnapshot: async () => account,
        getStockPositions: async () => positions,
      },
    });
    const receipt = await owner.requestRefresh(request).result;
    expect(receipt.status).toBe('COMMITTED');
    const view = owner.getView();
    expect(view.positions[0]?.quantity).toBe(100);
    expect(owner.getAvailablePosition('A.HK')).toBeNull();
    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.isFrozen(view.positions[0])).toBe(true);
    expect(Object.isFrozen(view.account?.cashInfos[0])).toBe(true);
    expect(view.account?.totalCash).toBe('100.0000001');
    expect(view.token.pairedRevision).toBe(1);
    expect(owner.isCurrent(view.token, { account: true, positions: true, paired: true })).toBe(
      true,
    );
    owner.invalidateAccount();
    expect(owner.getView().positionsValid).toBe(true);
    expect(owner.getView().accountValid).toBe(false);
    expect(owner.isCurrent(view.token, { account: false, positions: true })).toBe(false);
  });

  test('new participant cannot join issued batch; single-component commit does not advance paired', async () => {
    const first = deferred<AccountSnapshot>();
    let accountCalls = 0;
    let positionCalls = 0;
    const owner = createAccountPositionSnapshot({
      dayEpoch: 1,
      scheduler,
      reportFatalError: () => {},
      readPort: {
        getAccountSnapshot: () => {
          accountCalls++;
          return first.promise;
        },
        getStockPositions: async () => {
          positionCalls++;
          return positions;
        },
      },
    });
    const a = owner.requestRefresh({ ...request, refreshPositions: false });
    await tick();
    const b = owner.requestRefresh({ ...request, refreshAccount: false });
    expect(positionCalls).toBe(0);
    first.resolve(account);
    const observedResult1 = await a.result;
    expect(observedResult1.status).toBe('COMMITTED');
    const observedResult2 = await b.result;
    expect(observedResult2.status).toBe('COMMITTED');
    expect(accountCalls).toBe(1);
    expect(positionCalls).toBe(1);
    expect(owner.getView().token.commitRevision).toBe(2);
    expect(owner.getView().token.pairedRevision).toBe(0);
  });

  test('generation superseded participants requeue without publishing old success', async () => {
    const first = deferred<AccountSnapshot>();
    let calls = 0;
    const owner = createAccountPositionSnapshot({
      dayEpoch: 1,
      scheduler,
      reportFatalError: () => {},
      readPort: {
        getAccountSnapshot: () => {
          calls++;
          return calls === 1 ? first.promise : Promise.resolve(account);
        },
        getStockPositions: async () => positions,
      },
    });
    const handle = owner.requestRefresh(request);
    await tick();
    owner.invalidate();
    first.resolve({ ...account, totalCash: '1' });
    const receipt = await handle.result;
    expect(receipt.status).toBe('COMMITTED');
    expect(calls).toBe(2);
    expect(owner.getView().account?.totalCash).toBe(account.totalCash);
    expect(owner.getView().token.commitRevision).toBe(1);
    expect(owner.getView().token.snapshotGeneration).toBe(1);
  });

  test('one cancelled participant does not cancel siblings or IO', async () => {
    const first = deferred<AccountSnapshot>();
    const owner = createAccountPositionSnapshot({
      dayEpoch: 1,
      scheduler,
      reportFatalError: () => {},
      readPort: {
        getAccountSnapshot: () => first.promise,
        getStockPositions: async () => positions,
      },
    });
    const a = owner.requestRefresh(request);
    const b = owner.requestRefresh(request);
    await tick();
    a.cancel();
    const observedResult3 = await a.result;
    expect(observedResult3.status).toBe('ABORTED');
    first.resolve(account);
    const observedResult4 = await b.result;
    expect(observedResult4.status).toBe('COMMITTED');
    expect(owner.getView().token.commitRevision).toBe(1);
  });

  test('internal failure reports immediately, paired batch never half commits and clear drains sibling', async () => {
    const sibling = deferred<ReadonlyArray<Position>>();
    const fault = new TypeError('malformed broker fact');
    const fatal: unknown[] = [];
    const owner = createAccountPositionSnapshot({
      dayEpoch: 1,
      scheduler,
      reportFatalError: (error) => {
        fatal.push(error);
      },
      readPort: {
        getAccountSnapshot: async () => {
          throw fault;
        },
        getStockPositions: () => sibling.promise,
      },
    });
    const handle = owner.requestRefresh(request);
    await tick();
    await tick();
    expect(fatal).toEqual([fault]);
    let drained = false;
    // Immediate fatal reporting does not mean a successful drain. The already-issued
    // sibling must settle before clear rejects with the original internal failure.
    const clear = owner.requestClear({ reason: 'DAY_CUT', dayEpoch: 2 });
    const observedClear = clear.then(
      () => {
        drained = true;
        return { kind: 'RESOLVED' as const };
      },
      (error: unknown) => {
        drained = true;
        return { kind: 'REJECTED' as const, error };
      },
    );
    expect(owner.getStatus().admission).toBe('CLOSED');
    const observedResult5 = await handle.result;
    expect(observedResult5.status).toBe('ABORTED');
    await tick();
    expect(drained).toBe(false);
    sibling.resolve(positions);
    expect(clear).rejects.toBe(fault);
    expect(await observedClear).toEqual({ kind: 'REJECTED', error: fault });
    expect(drained).toBe(true);
    expect(fatal).toEqual([fault]);
    expect(owner.getStatus().admission).toBe('CLOSED');
    expect(owner.getStatus().inFlight).toBe(false);
    expect(owner.getView().token.commitRevision).toBe(0);
    expect(owner.getView().token.dayEpoch).toBe(2);
  });

  test('day clear is idempotent and rebuild admits only controlled requests in the established epoch', async () => {
    const owner = createAccountPositionSnapshot({
      dayEpoch: 1,
      scheduler,
      reportFatalError: () => {},
      readPort: {
        getAccountSnapshot: async () => account,
        getStockPositions: async () => positions,
      },
    });
    await owner.requestRefresh(request).result;
    await owner.requestClear({ reason: 'DAY_CUT', dayEpoch: 2 });
    const afterCut = owner.getView().token;
    await owner.requestClear({ reason: 'DAY_CUT', dayEpoch: 2 });
    expect(owner.getView().token).toEqual(afterCut);
    owner.beginRebuild();
    expect(owner.getView().token.dayEpoch).toBe(2);
    const observedResult6 = await owner.requestRefresh({ ...request, dayEpoch: 2 }).result;
    expect(observedResult6.status).toBe('ABORTED');
    const controlledRebuild = await owner.requestRefresh({
      ...request,
      dayEpoch: 2,
      source: 'LIFECYCLE_REBUILD',
    }).result;
    expect(controlledRebuild.status).toBe('COMMITTED');
    expect(owner.getStatus().admission).toBe('REBUILD');
    owner.openAdmission();
    const observedResult7 = await owner.requestRefresh({ ...request, dayEpoch: 2 }).result;
    expect(observedResult7.status).toBe('COMMITTED');
  });
});
