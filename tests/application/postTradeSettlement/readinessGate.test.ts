/** Settlement readiness 门禁：pending 严格追当前 token，完成水位不随普通 commit 撤销。 */
import { describe, expect, test } from 'bun:test';
import { createAccountPositionSnapshot } from '../../../src/application/accountPositionSnapshot/index.js';
import { createSettlementReadinessGate } from '../../../src/application/postTradeSettlement/readinessGate.js';

function createFixture() {
  const snapshot = createAccountPositionSnapshot({
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
  const gate = createSettlementReadinessGate({ snapshot });
  const refresh = async () =>
    snapshot.requestRefresh({
      source: 'POST_TRADE_SETTLEMENT',
      dayEpoch: 1,
      refreshAccount: true,
      refreshPositions: true,
    }).result;
  return { snapshot, gate, refresh };
}

describe('settlement readiness receipt', () => {
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
