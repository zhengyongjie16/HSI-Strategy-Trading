/** P1 窄授权切片：迟到订阅/旧 snapshot 不得发布 risk、completion 或 fresh。 */
import { expect, test } from 'bun:test';
import { createPostTradeConsistencyRuntime } from '../../../src/app/runtime/createPostTradeConsistencyRuntime.js';
import { createAccountPositionSnapshot } from '../../../src/application/accountPositionSnapshot/index.js';
import type { RuntimeScheduler } from '../../../src/types/runtime.js';
import type { SnapshotToken } from '../../../src/types/accountPosition.js';
import {
  createAccountSnapshotDouble,
  createDailyLossTrackerDouble,
  createLiquidationCooldownTrackerDouble,
  createMonitorContextDouble,
  createProtectiveLiquidationEpisodeTrackerDouble,
  createRiskCheckerDouble,
  createTerminationDouble,
  createTraderDouble,
} from '../../helpers/testDoubles.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

async function flush() {
  for (let index = 0; index < 40; index++) await Promise.resolve();
}

function manual() {
  const timers: Array<() => void> = [];
  const scheduler: RuntimeScheduler = {
    scheduleTimer: (callback) => {
      timers.push(callback);
      const handle = setTimeout(() => {}, 2_147_483_647);
      clearTimeout(handle);
      return handle;
    },
    clearTimer: () => {},
  };
  return {
    scheduler,
    pendingCount: () => timers.length,
    run: async () => {
      const next = timers.shift();
      if (!next) throw new Error('no scheduled run');

      next();
      await flush();
    },
  };
}

test('superseded r10 subscription acknowledgement cannot publish risk or ready; follows r11 same waterline', async () => {
  const clock = manual();
  let acknowledge!: () => void;
  const acknowledgement = new Promise<void>((resolve) => {
    acknowledge = resolve;
  });
  const owner = createAccountPositionSnapshot({
    dayEpoch: 1,
    scheduler: { schedule: queueMicrotask },
    readPort: {
      getAccountSnapshot: async () => createAccountSnapshotDouble('1000'),
      getStockPositions: async () => [],
    },
    reportFatalError: (error) => {
      throw error;
    },
  });
  const acknowledged: SnapshotToken[] = [];
  const published: number[] = [];
  const riskChecker = createRiskCheckerDouble({
    publishUnrealizedLossData: () => {
      published.push(owner.getView().token.commitRevision);
    },
  });
  const monitorContext = createMonitorContextDouble({ riskChecker });
  const runtime = createPostTradeConsistencyRuntime({
    termination: createTerminationDouble(),
    getTrader: () => createTraderDouble(),
    snapshot: owner,
    scheduler: clock.scheduler,
    onPositionsCommitted: async (token) => {
      acknowledged.push(token);
      if (acknowledged.length === 1) await acknowledgement;
    },
  });
  runtime.bindBusinessDeps({
    monitorContext,
    dailyLossTracker: monitorContext.dailyLossTracker,
    liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
    protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
    mixedTradeLogRepository: { appendCompletionIdempotent: () => {} },
  });
  runtime.recordSettlementRefreshNeed({ refreshAccount: true, refreshPositions: true });
  runtime.start();
  const ready = runtime.waitForFresh();
  let reached = false;
  void ready.then(() => {
    reached = true;
  });
  await clock.run();
  expect(acknowledged).toHaveLength(1);
  expect(published).toEqual([]);
  const latest = await owner.requestRefresh({
    source: 'SEAT_ACTIVATION',
    dayEpoch: 1,
    refreshAccount: true,
    refreshPositions: true,
  }).result;
  expect(latest.status).toBe('COMMITTED');
  expect(reached).toBe(false);
  acknowledge();
  await flush();
  const receipt = await ready;
  expect(acknowledged).toHaveLength(2);
  expect(published).toEqual([
    receipt.snapshotToken.commitRevision,
    receipt.snapshotToken.commitRevision,
  ]);
  expect(receipt.snapshotToken).toEqual(owner.getView().token);
  expect(runtime.getStatus().staleVersion).toBe(1);
  expect(runtime.isCurrent(receipt)).toBe(true);
  await runtime.stopAndDrain();
});

test('ready settlement survives ordinary pair and position commits without global work; a new fill waits', async () => {
  const clock = manual();
  let reads = 0;
  let subscriptions = 0;
  let publications = 0;
  let completions = 0;
  const owner = createAccountPositionSnapshot({
    dayEpoch: 1,
    scheduler: { schedule: queueMicrotask },
    readPort: {
      getAccountSnapshot: async () => {
        reads += 1;
        return createAccountSnapshotDouble('1000');
      },
      getStockPositions: async () => {
        reads += 1;
        return [];
      },
    },
    reportFatalError: (error) => {
      throw error;
    },
  });
  const monitorContext = createMonitorContextDouble({
    riskChecker: createRiskCheckerDouble({
      publishUnrealizedLossData: () => {
        publications += 1;
      },
    }),
  });
  const runtime = createPostTradeConsistencyRuntime({
    termination: createTerminationDouble(),
    getTrader: () => createTraderDouble(),
    snapshot: owner,
    scheduler: clock.scheduler,
    onPositionsCommitted: async () => {
      subscriptions += 1;
    },
  });
  runtime.bindBusinessDeps({
    monitorContext,
    dailyLossTracker: monitorContext.dailyLossTracker,
    liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
    protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
    mixedTradeLogRepository: {
      appendCompletionIdempotent: () => {
        completions += 1;
      },
    },
  });
  runtime.recordSettlementRefreshNeed({ refreshAccount: true, refreshPositions: true });
  runtime.start();
  const waiting = runtime.waitForFresh();
  await clock.run();
  const ready = await waiting;
  expect(subscriptions).toBe(1);
  expect(publications).toBe(2);
  expect(completions).toBe(0);
  expect(clock.pendingCount()).toBe(0);

  for (const refreshAccount of [true, false]) {
    const committed = await owner.requestRefresh({
      source: 'SEAT_ACTIVATION',
      dayEpoch: 1,
      refreshAccount,
      refreshPositions: true,
    }).result;
    expect(committed.status).toBe('COMMITTED');
    const readsAfterCommit = reads;
    let returned = false;
    const currentWaiting = runtime.waitForFresh().then((receipt) => {
      returned = true;
      return receipt;
    });
    await flush();
    expect(returned).toBe(true);
    expect(await currentWaiting).toBe(ready);
    expect(runtime.isCurrent(ready)).toBe(true);
    expect(runtime.getStatus()).toEqual({ started: true, currentVersion: 1, staleVersion: 1 });
    expect(clock.pendingCount()).toBe(0);
    expect(reads).toBe(readsAfterCommit);
    expect(subscriptions).toBe(1);
    expect(publications).toBe(2);
    expect(completions).toBe(0);
  }

  runtime.recordSettlementRefreshNeed({ refreshAccount: true, refreshPositions: true });
  expect(runtime.isCurrent(ready)).toBe(false);
  let returned = false;
  const nextWaiting = runtime.waitForFresh().then((receipt) => {
    returned = true;
    return receipt;
  });
  await flush();
  expect(returned).toBe(false);
  expect(clock.pendingCount()).toBe(1);
  await clock.run();
  const nextReady = await nextWaiting;
  expect(nextReady.settlementVersion).toBe(2);
  expect(runtime.isCurrent(nextReady)).toBe(true);
  expect(subscriptions).toBe(2);
  expect(publications).toBe(4);
  await runtime.stopAndDrain();
});

test('cancelled refresh participant does not let settlement drain finish before actual issued sibling IO', async () => {
  const clock = manual();
  const positions = deferred<ReadonlyArray<never>>();
  const owner = createAccountPositionSnapshot({
    dayEpoch: 1,
    scheduler: { schedule: queueMicrotask },
    readPort: {
      getAccountSnapshot: async () => createAccountSnapshotDouble('1000'),
      getStockPositions: () => positions.promise,
    },
    reportFatalError: (error) => {
      throw error;
    },
  });
  const runtime = createPostTradeConsistencyRuntime({
    termination: createTerminationDouble(),
    getTrader: () => createTraderDouble(),
    snapshot: owner,
    scheduler: clock.scheduler,
    onPositionsCommitted: async () => {},
  });
  const monitorContext = createMonitorContextDouble();
  runtime.bindBusinessDeps({
    monitorContext,
    dailyLossTracker: createDailyLossTrackerDouble(),
    liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
    protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
    mixedTradeLogRepository: { appendCompletionIdempotent: () => {} },
  });
  runtime.recordSettlementRefreshNeed({ refreshAccount: true, refreshPositions: true });
  runtime.start();
  await clock.run();
  let drained = false;
  const drain = runtime.stopAndDrain();
  void drain.then(() => {
    drained = true;
  });
  await flush();
  expect(drained).toBe(false);
  positions.resolve([]);
  await drain;
  expect(drained).toBe(true);
});
