/** Settlement readiness 门禁：pending 严格追当前 token，完成水位不随普通 commit 撤销。 */
import { describe, expect, test } from 'bun:test';
import { createAccountPositionSnapshot } from '../../../src/application/accountPositionSnapshot/index.js';
import { DIAGNOSTIC_OPERATIONS } from '../../../src/constants/diagnostics.js';
import type { DiagnosticFields } from '../../../src/types/diagnostics.js';
import type { SettlementReadinessGateDeps } from '../../../src/application/postTradeSettlement/types.js';
import {
  createSettlementReadinessGate,
  isSettlementReadinessAbortError,
} from '../../../src/application/postTradeSettlement/readinessGate.js';

function createFixture(
  overrides: Partial<Pick<SettlementReadinessGateDeps, 'clock' | 'diagnostics'>> = {},
) {
  let nowMs = 0;
  const events: Array<{ readonly operation: string; readonly fields: DiagnosticFields }> = [];
  const snapshot = createAccountPositionSnapshot({
    clock: { now: () => new Date(0) },
    diagnostics: { record: () => {} },
    dayEpoch: 1,
    scheduler: {
      schedule: (callback) => {
        queueMicrotask(callback);
      },
    },
    reportFatalError: () => {},
    readPort: {
      getAccountSnapshot: async () => ({
        currency: 'HKD',
        totalCash: '100',
        netAssets: '120',
        positionValue: '20',
        cashInfos: [],
      }),
      getStockPositions: async () => [],
    },
  });
  const gate = createSettlementReadinessGate({
    snapshot,
    clock: overrides.clock ?? { now: () => new Date(nowMs) },
    diagnostics: overrides.diagnostics ?? {
      record: (operation, fields) => {
        events.push({ operation, fields });
      },
    },
  });
  const refresh = async () =>
    snapshot.requestRefresh({
      source: 'POST_TRADE_SETTLEMENT',
      dayEpoch: 1,
      refreshAccount: true,
      refreshPositions: true,
    }).result;
  return {
    snapshot,
    gate,
    refresh,
    events,
    setNow: (value: number) => {
      nowMs = value;
    },
  };
}

describe('settlement readiness receipt', () => {
  test.each(['STOP_AND_DRAIN', 'FATAL_INVARIANT'] as const)(
    'formal abort classification shares pending and subsequent wait construction: %s',
    async (reason) => {
      const { gate } = createFixture();
      const waiting = gate.waitForFresh().catch((error: unknown) => error);
      gate.abortWaiting(reason);
      const pendingError = await waiting;
      const laterError = await gate.waitForFresh().catch((error: unknown) => error);
      expect(isSettlementReadinessAbortError(pendingError)).toBe(true);
      expect(isSettlementReadinessAbortError(laterError, reason)).toBe(true);
      expect(
        isSettlementReadinessAbortError(
          pendingError,
          reason === 'STOP_AND_DRAIN' ? 'FATAL_INVARIANT' : 'STOP_AND_DRAIN',
        ),
      ).toBe(false);
      expect(isSettlementReadinessAbortError(new Error('external failure'))).toBe(false);
      expect(isSettlementReadinessAbortError(String(pendingError), reason)).toBe(false);
    },
  );

  test('commit alone does not release waiters; completed settlement survives ordinary pair and position commits', async () => {
    const { snapshot, gate, refresh } = createFixture();
    const version = gate.markStale();
    let released = false;
    const waiting = gate.waitForFresh().then((receipt) => {
      released = true;
      return receipt;
    });
    const first = await refresh();
    if (first.status !== 'COMMITTED') throw new Error('test snapshot aborted');

    expect(released).toBe(false);
    expect(gate.markFresh(version, first.snapshotToken)).toBe(true);
    const ready = await waiting;
    expect(gate.isCurrent(ready)).toBe(true);
    await refresh();
    expect(gate.isCurrent(ready)).toBe(true);
    expect(gate.getStatus().staleVersion).toBe(version);
    expect(gate.markFresh(version, first.snapshotToken)).toBe(false);
    expect(await gate.waitForFresh()).toBe(ready);
    const positionOnly = await snapshot.requestRefresh({
      source: 'SEAT_ACTIVATION',
      dayEpoch: 1,
      refreshAccount: false,
      refreshPositions: true,
    }).result;
    expect(positionOnly.status).toBe('COMMITTED');
    expect(snapshot.isCurrent(ready.snapshotToken, { account: false, positions: true })).toBe(
      false,
    );
    expect(gate.getStatus().ready).toBe(true);
    expect(await gate.waitForFresh()).toBe(ready);
  });

  test('pending settlement rejects superseded token without advancing its waterline', async () => {
    const { snapshot, gate, refresh } = createFixture();
    const version = gate.markStale();
    await refresh();
    const pendingToken = snapshot.getView().token;
    await refresh();
    expect(gate.markFresh(version, pendingToken)).toBe(false);
    expect(gate.getStatus().ready).toBe(false);
    expect(gate.markFresh(version, snapshot.getView().token)).toBe(true);
    expect(gate.getStatus().staleVersion).toBe(version);
  });

  test('completed receipt expires on new settlement, generation, day cut and abort reset', async () => {
    const { snapshot, gate, refresh } = createFixture();
    await refresh();
    expect(gate.markFresh(0, snapshot.getView().token)).toBe(true);
    const baseline = await gate.waitForFresh();
    const version = gate.markStale();
    expect(gate.isCurrent(baseline)).toBe(false);
    let released = false;
    const waiting = gate.waitForFresh().then((receipt) => {
      released = true;
      return receipt;
    });
    await refresh();
    expect(released).toBe(false);
    expect(gate.markFresh(version, snapshot.getView().token)).toBe(true);
    const ready = await waiting;
    snapshot.invalidate();
    expect(gate.isCurrent(ready)).toBe(false);
    await refresh();
    expect(gate.isCurrent(ready)).toBe(false);
    expect(gate.markFresh(version, snapshot.getView().token)).toBe(true);
    const renewed = await gate.waitForFresh();
    gate.abortWaiting('STOP_AND_DRAIN');
    gate.resetAbort();
    expect(gate.isCurrent(renewed)).toBe(false);
    expect(gate.markFresh(version, snapshot.getView().token)).toBe(true);
    const beforeDayCut = await gate.waitForFresh();
    await snapshot.requestClear({ reason: 'DAY_CUT', dayEpoch: 2 });
    expect(gate.isCurrent(beforeDayCut)).toBe(false);
    expect(gate.getStatus().ready).toBe(false);
  });

  test('new execution waterline and generation reject old ready; lifecycle abort synchronously releases waiters', async () => {
    const { snapshot, gate, refresh } = createFixture();
    const oldVersion = gate.markStale();
    await refresh();
    const oldToken = snapshot.getView().token;
    const version = gate.markStale();
    snapshot.invalidate();
    expect(gate.markFresh(oldVersion, oldToken)).toBe(false);
    expect(gate.markFresh(version, oldToken)).toBe(false);
    const waiting = gate.waitForFresh().catch((error: unknown) => error);
    gate.abortWaiting('STOP_AND_DRAIN');
    expect(await waiting).toBeInstanceOf(Error);
    expect(String(await waiting)).toContain('STOP_AND_DRAIN');
    expect(gate.markFresh(version, snapshot.getView().token)).toBe(false);
  });
});

describe('settlement readiness diagnostics', () => {
  test('only actual stale advances and successful receipts emit; continuous stale keeps its first start and ready token', async () => {
    const { snapshot, gate, refresh, events, setNow } = createFixture();
    expect(gate.markFresh(0, snapshot.getView().token)).toBe(false);
    expect(() => gate.markFresh(Number.NaN, snapshot.getView().token)).toThrow(
      'invalid settlement version',
    );
    expect(events).toEqual([]);
    // 两个独立计数域刻意错开：snapshot 推进不能被当作 settlement 的版本差值。
    await refresh();
    await refresh();

    setNow(100);
    const firstVersion = gate.markStale();
    await refresh();
    const supersededToken = snapshot.getView().token;
    setNow(160);
    const version = gate.markStale();
    expect(gate.markFresh(firstVersion, supersededToken)).toBe(false);
    await refresh();
    expect(gate.markFresh(version, supersededToken)).toBe(false);
    expect(events.map(({ operation }) => operation)).toEqual([
      DIAGNOSTIC_OPERATIONS.SETTLEMENT_STALE,
      DIAGNOSTIC_OPERATIONS.SETTLEMENT_STALE,
    ]);
    expect(events.map(({ fields }) => fields['settlementVersion'])).toEqual([1, 2]);

    setNow(250);
    const waiting = gate.waitForFresh();
    expect(gate.markFresh(version, snapshot.getView().token)).toBe(true);
    const receipt = await waiting;
    expect(receipt.snapshotToken.commitRevision).not.toBe(receipt.settlementVersion);
    const expectedReady = {
      source: 'POST_TRADE_SETTLEMENT',
      settlementVersion: receipt.settlementVersion,
      dayEpoch: receipt.snapshotToken.dayEpoch,
      snapshotGeneration: receipt.snapshotToken.snapshotGeneration,
      snapshotCommitRevision: receipt.snapshotToken.commitRevision,
      accountRevision: receipt.snapshotToken.accountRevision,
      positionRevision: receipt.snapshotToken.positionRevision,
      pairedCommitRevision: receipt.snapshotToken.pairedRevision,
    };
    expect(events.slice(2)).toEqual([
      { operation: DIAGNOSTIC_OPERATIONS.SETTLEMENT_READY, fields: expectedReady },
      {
        operation: DIAGNOSTIC_OPERATIONS.SETTLEMENT_READINESS_COMPLETED,
        fields: {
          ...expectedReady,
          firstSettlementVersion: firstVersion,
          durationMs: 150,
          outcome: 'READY',
        },
      },
    ]);

    setNow(900);
    await refresh();
    await snapshot.requestRefresh({
      source: 'SEAT_ACTIVATION',
      dayEpoch: 1,
      refreshAccount: false,
      refreshPositions: true,
    }).result;
    expect(gate.getStatus().ready).toBe(true);
    expect(await gate.waitForFresh()).toBe(receipt);
    expect(gate.markFresh(version, receipt.snapshotToken)).toBe(false);
    expect(events).toHaveLength(4);
    snapshot.invalidate();
    expect(gate.getStatus().ready).toBe(false);
    expect(events).toHaveLength(4);
  });

  test.each(['STOP_AND_DRAIN', 'FATAL_INVARIANT'] as const)(
    'abort closes one continuous stale duration without fabricating ready or repeating on subsequent abort: %s',
    async (reason) => {
      const { gate, events, setNow } = createFixture();
      setNow(10);
      gate.markStale();
      setNow(50);
      gate.markStale();
      const waiting = gate.waitForFresh().catch((error: unknown) => error);
      setNow(100);
      gate.abortWaiting(reason);
      expect(isSettlementReadinessAbortError(await waiting, reason)).toBe(true);
      gate.abortWaiting(reason);
      expect(events).toEqual([
        {
          operation: DIAGNOSTIC_OPERATIONS.SETTLEMENT_STALE,
          fields: { source: 'POST_TRADE_SETTLEMENT', settlementVersion: 1 },
        },
        {
          operation: DIAGNOSTIC_OPERATIONS.SETTLEMENT_STALE,
          fields: { source: 'POST_TRADE_SETTLEMENT', settlementVersion: 2 },
        },
        {
          operation: DIAGNOSTIC_OPERATIONS.SETTLEMENT_READINESS_COMPLETED,
          fields: {
            source: 'POST_TRADE_SETTLEMENT',
            firstSettlementVersion: 1,
            settlementVersion: 2,
            durationMs: 90,
            outcome: 'ABORTED',
            reason,
          },
        },
      ]);
    },
  );

  test('successful baseline without stale emits only ready; abort reset starts the next real stale duration', async () => {
    const { snapshot, gate, refresh, events, setNow } = createFixture();
    await refresh();
    expect(gate.markFresh(0, snapshot.getView().token)).toBe(true);
    expect(events.map(({ operation }) => operation)).toEqual([
      DIAGNOSTIC_OPERATIONS.SETTLEMENT_READY,
    ]);
    setNow(10);
    gate.markStale();
    setNow(20);
    gate.abortWaiting('STOP_AND_DRAIN');
    gate.resetAbort();
    setNow(100);
    const version = gate.markStale();
    await refresh();
    setNow(130);
    expect(gate.markFresh(version, snapshot.getView().token)).toBe(true);
    expect(events.at(-1)?.fields).toMatchObject({
      firstSettlementVersion: 2,
      settlementVersion: 2,
      durationMs: 30,
      outcome: 'READY',
    });
  });

  test('readiness duration ends at receipt success, before synchronous diagnostic serialization', async () => {
    let nowMs = 10;
    const completed: DiagnosticFields[] = [];
    const { snapshot, gate, refresh } = createFixture({
      clock: { now: () => new Date(nowMs) },
      diagnostics: {
        record: (operation, fields) => {
          if (operation === DIAGNOSTIC_OPERATIONS.SETTLEMENT_READY) nowMs = 1000;
          else if (operation === DIAGNOSTIC_OPERATIONS.SETTLEMENT_READINESS_COMPLETED)
            completed.push(fields);
        },
      },
    });
    const version = gate.markStale();
    await refresh();
    nowMs = 60;
    expect(gate.markFresh(version, snapshot.getView().token)).toBe(true);
    expect(completed).toHaveLength(1);
    expect(completed[0]?.['durationMs']).toBe(50);
  });

  test('throwing observer cannot change successful receipt or formal abort and fatal guard', async () => {
    const { snapshot, gate, refresh } = createFixture({
      diagnostics: {
        record: () => {
          throw new Error('diagnostic failed');
        },
      },
    });
    const version = gate.markStale();
    const waiting = gate.waitForFresh();
    await refresh();
    expect(gate.markFresh(version, snapshot.getView().token)).toBe(true);
    const receipt = await waiting;
    expect(receipt.settlementVersion).toBe(version);
    gate.markStale();
    const aborted = gate.waitForFresh().catch((error: unknown) => error);
    expect(() => {
      gate.abortWaiting('FATAL_INVARIANT');
    }).not.toThrow();
    expect(isSettlementReadinessAbortError(await aborted, 'FATAL_INVARIANT')).toBe(true);
    expect(() => gate.markStale()).toThrow('cannot mark stale after fatal invariant');
  });

  test.each(['THROW', 'INVALID_DATE'] as const)(
    'diagnostic clock failure never restarts the first stale time or changes the gate result: %s',
    async (failureMode) => {
      let clockFails = true;
      const { snapshot, gate, refresh, events } = createFixture({
        clock: {
          now: () => {
            if (clockFails) {
              if (failureMode === 'THROW') throw new Error('clock failed');

              return new Date(Number.NaN);
            }

            return new Date(100);
          },
        },
      });
      gate.markStale();
      clockFails = false;
      const version = gate.markStale();
      await refresh();
      expect(gate.markFresh(version, snapshot.getView().token)).toBe(true);
      expect(events.at(-1)?.fields).toMatchObject({
        firstSettlementVersion: 1,
        settlementVersion: 2,
        outcome: 'READY',
      });
      expect(events.at(-1)?.fields).not.toHaveProperty('durationMs');
    },
  );
});
