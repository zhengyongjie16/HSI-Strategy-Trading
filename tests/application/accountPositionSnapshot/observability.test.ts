/** Snapshot 被动诊断回归：真实 issued 批身份、双路落定耗时与跨重排队累计 pending wait。 */
import { describe, expect, test } from 'bun:test';
import { createAccountPositionSnapshot } from '../../../src/application/accountPositionSnapshot/index.js';
import { DIAGNOSTIC_OPERATIONS } from '../../../src/constants/diagnostics.js';
import type { AccountSnapshot, Position } from '../../../src/types/account.js';
import type { SnapshotReadPort } from '../../../src/types/accountPosition.js';
import type { DiagnosticFields } from '../../../src/types/diagnostics.js';
import type { RuntimeClock } from '../../../src/types/runtime.js';
import { createExternalApiRequestError } from '../../helpers/createExternalApiRequestError.js';

const account: AccountSnapshot = {
  currency: 'HKD',
  totalCash: '100.0000000000000000001',
  netAssets: '120.0000000000000000002',
  positionValue: '20.0000000000000000001',
  cashInfos: [{ currency: 'HKD', availableCash: '99.0000000000000000001' }],
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
const request = {
  source: 'TEST',
  dayEpoch: 1,
  refreshAccount: true,
  refreshPositions: true,
};

function deferred<T>() {
  return Promise.withResolvers<T>();
}

async function flush() {
  for (let index = 0; index < 30; index++) await Promise.resolve();
}

function createHarness(readPort: SnapshotReadPort, clock: RuntimeClock) {
  const events: Array<{ readonly operation: string; readonly fields: DiagnosticFields }> = [];
  const scheduled: Array<() => void> = [];
  const fatal: unknown[] = [];
  const owner = createAccountPositionSnapshot({
    dayEpoch: 1,
    clock,
    diagnostics: {
      record: (operation, fields) => {
        events.push({ operation, fields });
      },
    },
    scheduler: {
      schedule: (callback) => {
        scheduled.push(callback);
      },
    },
    readPort,
    reportFatalError: (error) => {
      fatal.push(error);
    },
  });
  return {
    owner,
    fatal,
    events,
    forOperation: (operation: string) =>
      events.filter((event) => event.operation === operation).map((event) => event.fields),
    issue: () => {
      const callback = scheduled.shift();
      if (!callback) throw new Error('Expected a scheduled snapshot pump');

      callback();
    },
  };
}

describe('snapshot observability', () => {
  test('coalesces pending sources into a unique set, retains issued sources after cancellation, and publishes exact revisions', async () => {
    let nowMs = 10;
    const accountRead = deferred<AccountSnapshot>();
    const positionsRead = deferred<ReadonlyArray<Position>>();
    let accountCalls = 0;
    let positionCalls = 0;
    const harness = createHarness(
      {
        getAccountSnapshot: () => {
          accountCalls++;
          return accountRead.promise;
        },
        getStockPositions: () => {
          positionCalls++;
          return positionsRead.promise;
        },
      },
      { now: () => new Date(nowMs) },
    );
    const a = harness.owner.requestRefresh({
      ...request,
      source: 'ACCOUNT',
      refreshPositions: false,
    });
    nowMs = 12;
    const b = harness.owner.requestRefresh({
      ...request,
      source: 'POSITIONS',
      refreshAccount: false,
    });
    nowMs = 14;
    const c = harness.owner.requestRefresh({
      ...request,
      source: 'ACCOUNT',
      refreshPositions: false,
    });
    expect(harness.forOperation(DIAGNOSTIC_OPERATIONS.SNAPSHOT_REQUEST_STARTED)).toEqual([]);
    nowMs = 20;
    harness.issue();
    expect(accountCalls).toBe(1);
    expect(positionCalls).toBe(1);
    expect(harness.forOperation(DIAGNOSTIC_OPERATIONS.SNAPSHOT_REQUEST_STARTED)).toMatchObject([
      {
        sources: ['ACCOUNT', 'POSITIONS'],
        participantCount: 3,
        refreshAccount: true,
        refreshPositions: true,
        dayEpoch: 1,
        snapshotGeneration: 0,
        snapshotCommitRevision: 0,
      },
    ]);
    nowMs = 30;
    c.cancel();
    c.cancel();
    expect(await c.result).toEqual({ status: 'ABORTED' });
    nowMs = 45;
    accountRead.resolve(account);
    await flush();
    expect(harness.forOperation(DIAGNOSTIC_OPERATIONS.SNAPSHOT_REFRESH_COMPLETED)).toEqual([]);
    nowMs = 65;
    positionsRead.resolve(positions);
    const [aReceipt, bReceipt] = await Promise.all([a.result, b.result]);
    await flush();
    expect(aReceipt).toBe(bReceipt);
    expect(aReceipt.status).toBe('COMMITTED');
    expect(harness.forOperation(DIAGNOSTIC_OPERATIONS.SNAPSHOT_RESPONSE_ACCEPTED)).toMatchObject([
      { sources: ['ACCOUNT', 'POSITIONS'], participantCount: 3, snapshotGeneration: 0 },
    ]);

    expect(harness.forOperation(DIAGNOSTIC_OPERATIONS.SNAPSHOT_REFRESH_COMPLETED)).toMatchObject([
      { outcome: 'success', refreshDurationMs: 45 },
    ]);

    expect(harness.forOperation(DIAGNOSTIC_OPERATIONS.SNAPSHOT_COMMITTED)).toMatchObject([
      {
        sources: ['ACCOUNT', 'POSITIONS'],
        participantCount: 3,
        snapshotCommitRevision: 1,
        accountRevision: 1,
        positionRevision: 1,
        pairedCommitRevision: 1,
      },
    ]);

    expect(harness.forOperation(DIAGNOSTIC_OPERATIONS.SNAPSHOT_PENDING_WAIT_COMPLETED)).toEqual([
      { source: 'ACCOUNT', dayEpoch: 1, outcome: 'aborted', pendingWaitDurationMs: 6 },
      { source: 'ACCOUNT', dayEpoch: 1, outcome: 'committed', pendingWaitDurationMs: 10 },
      { source: 'POSITIONS', dayEpoch: 1, outcome: 'committed', pendingWaitDurationMs: 8 },
    ]);
    expect(harness.owner.getView().account?.totalCash).toBe(account.totalCash);
    expect(JSON.stringify(harness.events)).not.toContain(account.totalCash);
    expect(JSON.stringify(harness.events)).not.toContain(positions[0]?.costPrice);
    expect(harness.fatal).toEqual([]);
  });

  test('a late pending participant has its own issued event and counts queue time behind earlier IO', async () => {
    let nowMs = 0;
    const firstAccount = deferred<AccountSnapshot>();
    let accountCalls = 0;
    const harness = createHarness(
      {
        getAccountSnapshot: () => {
          accountCalls++;
          return firstAccount.promise;
        },
        getStockPositions: async () => positions,
      },
      { now: () => new Date(nowMs) },
    );
    const a = harness.owner.requestRefresh({ ...request, source: 'A', refreshPositions: false });
    nowMs = 10;
    harness.issue();
    nowMs = 20;
    const b = harness.owner.requestRefresh({ ...request, source: 'B', refreshAccount: false });
    expect(harness.forOperation(DIAGNOSTIC_OPERATIONS.SNAPSHOT_REQUEST_STARTED)).toHaveLength(1);
    nowMs = 70;
    firstAccount.resolve(account);
    await Promise.all([a.result, b.result]);
    await flush();
    expect(accountCalls).toBe(1);
    expect(harness.forOperation(DIAGNOSTIC_OPERATIONS.SNAPSHOT_REQUEST_STARTED)).toMatchObject([
      { sources: ['A'], refreshPositions: false },
      { sources: ['B'], refreshAccount: false },
    ]);

    expect(
      harness.forOperation(DIAGNOSTIC_OPERATIONS.SNAPSHOT_PENDING_WAIT_COMPLETED),
    ).toMatchObject([
      { source: 'A', pendingWaitDurationMs: 10 },
      { source: 'B', pendingWaitDurationMs: 50 },
    ]);

    expect(harness.forOperation(DIAGNOSTIC_OPERATIONS.SNAPSHOT_COMMITTED)).toMatchObject([
      {
        snapshotCommitRevision: 1,
        accountRevision: 1,
        positionRevision: 0,
        pairedCommitRevision: 0,
      },
      {
        snapshotCommitRevision: 2,
        accountRevision: 1,
        positionRevision: 1,
        pairedCommitRevision: 0,
      },
    ]);
  });

  test('generation discard counts once and participant pending wait accumulates requeue intervals without IO', async () => {
    const sampleTimes = [100, 110, 160, 165, 180, 230];
    const first = deferred<AccountSnapshot>();
    const second = deferred<AccountSnapshot>();
    let calls = 0;
    const harness = createHarness(
      {
        getAccountSnapshot: () => (++calls === 1 ? first.promise : second.promise),
        getStockPositions: async () => positions,
      },
      {
        now: () => {
          const sample = sampleTimes.shift();
          if (sample === undefined) throw new Error('Unexpected clock observation');

          return new Date(sample);
        },
      },
    );
    const handle = harness.owner.requestRefresh(request);
    harness.issue();
    harness.owner.invalidate();
    first.resolve({ ...account, totalCash: '1' });
    await flush();
    expect(harness.forOperation(DIAGNOSTIC_OPERATIONS.SNAPSHOT_RESPONSE_DISCARDED)).toMatchObject([
      { discardReason: 'stale_generation', discardCount: 1, currentSnapshotGeneration: 1 },
    ]);
    expect(harness.forOperation(DIAGNOSTIC_OPERATIONS.SNAPSHOT_PENDING_WAIT_COMPLETED)).toEqual([]);
    expect(harness.owner.getView().token.commitRevision).toBe(0);
    second.resolve(account);
    const receipt = await handle.result;
    expect(receipt.status).toBe('COMMITTED');
    await flush();
    expect(sampleTimes).toEqual([]);
    expect(harness.forOperation(DIAGNOSTIC_OPERATIONS.SNAPSHOT_REQUEST_STARTED)).toMatchObject([
      { sources: ['TEST'], snapshotGeneration: 0 },
      { sources: ['TEST'], snapshotGeneration: 1 },
    ]);

    expect(harness.forOperation(DIAGNOSTIC_OPERATIONS.SNAPSHOT_REFRESH_COMPLETED)).toMatchObject([
      { outcome: 'discarded', refreshDurationMs: 50 },
      { outcome: 'success', refreshDurationMs: 50 },
    ]);

    expect(harness.forOperation(DIAGNOSTIC_OPERATIONS.SNAPSHOT_PENDING_WAIT_COMPLETED)).toEqual([
      { source: 'TEST', dayEpoch: 1, outcome: 'committed', pendingWaitDurationMs: 25 },
    ]);
    expect(harness.forOperation(DIAGNOSTIC_OPERATIONS.SNAPSHOT_COMMITTED)).toHaveLength(1);
    expect(harness.owner.getView().account?.totalCash).toBe(account.totalCash);
  });

  test('epoch wins over simultaneous stale generation and clear still waits both issued IO', async () => {
    let nowMs = 0;
    const accountRead = deferred<AccountSnapshot>();
    const positionsRead = deferred<ReadonlyArray<Position>>();
    const harness = createHarness(
      {
        getAccountSnapshot: () => accountRead.promise,
        getStockPositions: () => positionsRead.promise,
      },
      { now: () => new Date(nowMs) },
    );
    const handle = harness.owner.requestRefresh(request);
    nowMs = 10;
    harness.issue();
    nowMs = 20;
    const cleared = harness.owner.requestClear({ reason: 'DAY_CUT', dayEpoch: 2 });
    expect(harness.owner.getStatus().admission).toBe('CLOSED');
    expect(await handle.result).toEqual({ status: 'ABORTED' });
    nowMs = 30;
    accountRead.resolve(account);
    await flush();
    expect(harness.forOperation(DIAGNOSTIC_OPERATIONS.SNAPSHOT_REFRESH_COMPLETED)).toEqual([]);
    nowMs = 60;
    positionsRead.resolve(positions);
    await cleared;
    expect(harness.forOperation(DIAGNOSTIC_OPERATIONS.SNAPSHOT_RESPONSE_DISCARDED)).toMatchObject([
      {
        discardReason: 'stale_epoch',
        discardCount: 1,
        dayEpoch: 1,
        snapshotGeneration: 0,
        currentDayEpoch: 2,
        currentSnapshotGeneration: 1,
      },
    ]);

    expect(harness.forOperation(DIAGNOSTIC_OPERATIONS.SNAPSHOT_REFRESH_COMPLETED)).toMatchObject([
      { outcome: 'discarded', refreshDurationMs: 50, discardReason: 'stale_epoch' },
    ]);
    expect(harness.forOperation(DIAGNOSTIC_OPERATIONS.SNAPSHOT_RESPONSE_ACCEPTED)).toEqual([]);
    expect(harness.forOperation(DIAGNOSTIC_OPERATIONS.SNAPSHOT_COMMITTED)).toEqual([]);
    expect(
      harness.forOperation(DIAGNOSTIC_OPERATIONS.SNAPSHOT_PENDING_WAIT_COMPLETED),
    ).toMatchObject([{ outcome: 'aborted', pendingWaitDurationMs: 10 }]);
  });

  test('external failure retains classification over stale generation, duration waits its successful sibling', async () => {
    const external = await createExternalApiRequestError({
      operation: 'TradeContext.accountBalance',
      attempts: 1,
      cause: new Error('account unavailable'),
    });
    let nowMs = 0;
    const accountRead = deferred<AccountSnapshot>();
    const positionsRead = deferred<ReadonlyArray<Position>>();
    const harness = createHarness(
      {
        getAccountSnapshot: () => accountRead.promise,
        getStockPositions: () => positionsRead.promise,
      },
      { now: () => new Date(nowMs) },
    );
    const result = harness.owner.requestRefresh(request).result.catch((error: unknown) => error);
    nowMs = 10;
    harness.issue();
    nowMs = 20;
    accountRead.reject(external);
    await flush();
    harness.owner.invalidate();
    expect(harness.forOperation(DIAGNOSTIC_OPERATIONS.SNAPSHOT_REFRESH_COMPLETED)).toEqual([]);
    nowMs = 75;
    positionsRead.resolve(positions);
    expect(await result).toBe(external);
    await flush();
    expect(harness.forOperation(DIAGNOSTIC_OPERATIONS.SNAPSHOT_REFRESH_COMPLETED)).toMatchObject([
      { outcome: 'failure', failureKind: 'external', refreshDurationMs: 65 },
    ]);
    expect(harness.forOperation(DIAGNOSTIC_OPERATIONS.SNAPSHOT_RESPONSE_DISCARDED)).toEqual([]);
    expect(harness.forOperation(DIAGNOSTIC_OPERATIONS.SNAPSHOT_RESPONSE_ACCEPTED)).toEqual([]);
    expect(
      harness.forOperation(DIAGNOSTIC_OPERATIONS.SNAPSHOT_PENDING_WAIT_COMPLETED),
    ).toMatchObject([{ outcome: 'failure', pendingWaitDurationMs: 10 }]);
    expect(harness.fatal).toEqual([]);
    expect(harness.owner.getStatus().admission).toBe('OPEN');
  });

  test('internal failure reports immediately but records duration only when both issued IO settle after clear', async () => {
    let nowMs = 0;
    const fault = new TypeError('malformed account fact');
    const positionsRead = deferred<ReadonlyArray<Position>>();
    const harness = createHarness(
      {
        getAccountSnapshot: async () => {
          throw fault;
        },
        getStockPositions: () => positionsRead.promise,
      },
      { now: () => new Date(nowMs) },
    );
    const handle = harness.owner.requestRefresh(request);
    nowMs = 10;
    harness.issue();
    await flush();
    expect(harness.fatal).toEqual([fault]);
    const cleared = harness.owner
      .requestClear({ reason: 'DAY_CUT', dayEpoch: 2 })
      .catch((error: unknown) => error);
    expect(await handle.result).toEqual({ status: 'ABORTED' });
    expect(harness.forOperation(DIAGNOSTIC_OPERATIONS.SNAPSHOT_REFRESH_COMPLETED)).toEqual([]);
    nowMs = 90;
    positionsRead.resolve(positions);
    expect(await cleared).toBe(fault);
    expect(harness.forOperation(DIAGNOSTIC_OPERATIONS.SNAPSHOT_REFRESH_COMPLETED)).toMatchObject([
      { outcome: 'failure', failureKind: 'internal', refreshDurationMs: 80 },
    ]);
    expect(harness.forOperation(DIAGNOSTIC_OPERATIONS.SNAPSHOT_RESPONSE_DISCARDED)).toEqual([]);
    expect(
      harness.forOperation(DIAGNOSTIC_OPERATIONS.SNAPSHOT_PENDING_WAIT_COMPLETED),
    ).toHaveLength(1);
    expect(harness.fatal).toEqual([fault]);
    expect(harness.owner.getView().token.commitRevision).toBe(0);
  });

  test('queued cancellation ends pending time once without issuing or inventing refresh duration', async () => {
    let nowMs = 10;
    const harness = createHarness(
      {
        getAccountSnapshot: async () => account,
        getStockPositions: async () => positions,
      },
      { now: () => new Date(nowMs) },
    );
    const handle = harness.owner.requestRefresh(request);
    nowMs = 35;
    handle.cancelIfNotIssued();
    handle.cancel();
    expect(await handle.result).toEqual({ status: 'ABORTED' });
    harness.issue();
    await flush();
    expect(harness.forOperation(DIAGNOSTIC_OPERATIONS.SNAPSHOT_REQUEST_STARTED)).toEqual([]);
    expect(harness.forOperation(DIAGNOSTIC_OPERATIONS.SNAPSHOT_REFRESH_COMPLETED)).toEqual([]);
    expect(harness.forOperation(DIAGNOSTIC_OPERATIONS.SNAPSHOT_PENDING_WAIT_COMPLETED)).toEqual([
      { source: 'TEST', dayEpoch: 1, outcome: 'aborted', pendingWaitDurationMs: 25 },
    ]);
  });

  test('diagnostic observer and clock exceptions cannot change commit, cancellation, error identity or fatal reporting', async () => {
    const diagnosticFault = new Error('diagnostic unavailable');
    const businessFault = new TypeError('invalid broker fact');
    const fatal: unknown[] = [];
    let failRead = false;
    const owner = createAccountPositionSnapshot({
      dayEpoch: 1,
      scheduler: { schedule: queueMicrotask },
      clock: {
        now: () => {
          throw diagnosticFault;
        },
      },
      diagnostics: {
        record: () => {
          throw diagnosticFault;
        },
      },
      readPort: {
        getAccountSnapshot: async () => {
          if (failRead) throw businessFault;

          return account;
        },
        getStockPositions: async () => positions,
      },
      reportFatalError: (error) => {
        fatal.push(error);
      },
    });
    const cancelled = owner.requestRefresh(request);
    cancelled.cancel();
    expect(await cancelled.result).toEqual({ status: 'ABORTED' });
    const receipt = await owner.requestRefresh(request).result;
    expect(receipt.status).toBe('COMMITTED');
    failRead = true;
    expect(await owner.requestRefresh(request).result.catch((error: unknown) => error)).toBe(
      businessFault,
    );
    expect(await owner.waitForIssuedDrain().catch((error: unknown) => error)).toBe(businessFault);
    expect(fatal).toEqual([businessFault]);
    expect(owner.getView().token.commitRevision).toBe(1);
  });
});
