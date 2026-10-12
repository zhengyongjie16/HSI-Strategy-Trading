/** P1 snapshot 配对组件身份与调用时已发批次 drain 的独立回归，不改既有 H 测试。 */
import { expect, test } from 'bun:test';
import { createAccountPositionSnapshot } from '../../../src/application/accountPositionSnapshot/index.js';
import type { Position } from '../../../src/types/account.js';
import { createAccountSnapshotDouble } from '../../helpers/testDoubles.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

async function flush() {
  for (let index = 0; index < 30; index++) await Promise.resolve();
}

test('pair then positions-only rejects paired authorization even for the new current token', async () => {
  const owner = createAccountPositionSnapshot({
    dayEpoch: 1,
    scheduler: { schedule: queueMicrotask },
    reportFatalError: (error) => {
      throw error;
    },
    readPort: {
      getAccountSnapshot: async () => createAccountSnapshotDouble('100'),
      getStockPositions: async () => [],
    },
  });
  const pair = await owner.requestRefresh({
    source: 'test',
    dayEpoch: 1,
    refreshAccount: true,
    refreshPositions: true,
  }).result;
  expect(pair.status).toBe('COMMITTED');
  const pairedToken = owner.getView().token;
  expect(owner.isCurrent(pairedToken, { account: true, positions: true, paired: true })).toBe(true);
  await owner.requestRefresh({
    source: 'test',
    dayEpoch: 1,
    refreshAccount: false,
    refreshPositions: true,
  }).result;
  const componentToken = owner.getView().token;
  expect(componentToken.pairedRevision).toBe(pairedToken.pairedRevision);
  expect(owner.isCurrent(componentToken, { account: true, positions: true })).toBe(true);
  expect(owner.isCurrent(componentToken, { account: true, positions: true, paired: true })).toBe(
    false,
  );

  await owner.requestRefresh({
    source: 'test',
    dayEpoch: 1,
    refreshAccount: true,
    refreshPositions: true,
  }).result;

  expect(
    owner.isCurrent(owner.getView().token, { account: true, positions: true, paired: true }),
  ).toBe(true);
});

test('captured issued A drain waits both A siblings, never later pending B IO', async () => {
  const aAccount = deferred<ReturnType<typeof createAccountSnapshotDouble>>();
  const aPositions = deferred<ReadonlyArray<Position>>();
  const bPositions = deferred<ReadonlyArray<Position>>();
  let positionReads = 0;
  const owner = createAccountPositionSnapshot({
    dayEpoch: 1,
    scheduler: { schedule: queueMicrotask },
    reportFatalError: (error) => {
      throw error;
    },
    readPort: {
      getAccountSnapshot: () => aAccount.promise,
      getStockPositions: () => (++positionReads === 1 ? aPositions.promise : bPositions.promise),
    },
  });
  const a = owner.requestRefresh({
    source: 'A',
    dayEpoch: 1,
    refreshAccount: true,
    refreshPositions: true,
  });
  await flush();
  const captured = owner.waitForIssuedDrain();
  let drained = false;
  void captured.then(() => {
    drained = true;
  });
  const b = owner.requestRefresh({
    source: 'B',
    dayEpoch: 1,
    refreshAccount: false,
    refreshPositions: true,
  });
  aAccount.resolve(createAccountSnapshotDouble('100'));
  await flush();
  expect(drained).toBe(false);
  aPositions.resolve([]);
  await captured;
  await a.result;
  await flush();
  expect(positionReads).toBe(2);
  expect(drained).toBe(true);
  const bDrain = owner.waitForIssuedDrain();
  let bDrained = false;
  void bDrain.then(() => {
    bDrained = true;
  });
  await flush();
  expect(bDrained).toBe(false);
  bPositions.resolve([]);
  await b.result;
  await bDrain;
  expect(bDrained).toBe(true);
});
