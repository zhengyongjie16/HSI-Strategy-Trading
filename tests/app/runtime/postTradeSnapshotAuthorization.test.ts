/** app wiring 授权测试：订阅回调接收真实 canonical token，迟到 r10 不授权投影或 ready。 */
import { expect, test } from 'bun:test';
import { createPostTradeConsistencyRuntime } from '../../../src/app/runtime/createPostTradeConsistencyRuntime.js';
import { createAccountPositionSnapshot } from '../../../src/application/accountPositionSnapshot/index.js';
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

test('real app capability mapping follows r11 after r10 subscription returns without a second settlement need', async () => {
  let run!: () => void;
  let acknowledge!: () => void;
  const acknowledgement = new Promise<void>((resolve) => {
    acknowledge = resolve;
  });
  const snapshot = createAccountPositionSnapshot({
    dayEpoch: 1,
    scheduler: { schedule: queueMicrotask },
    readPort: {
      getAccountSnapshot: async () => createAccountSnapshotDouble('1000'),
      getStockPositions: async () => [],
    },
    reportFatalError: () => {},
  });
  const acknowledgements: SnapshotToken[] = [];
  const published: number[] = [];
  const monitorContext = createMonitorContextDouble({
    riskChecker: createRiskCheckerDouble({
      publishUnrealizedLossData: () => {
        published.push(snapshot.getView().token.commitRevision);
      },
    }),
  });
  const runtime = createPostTradeConsistencyRuntime({
    termination: createTerminationDouble(),
    getTrader: () => createTraderDouble(),
    snapshot,
    scheduler: {
      scheduleTimer: (callback) => {
        run = callback;
        const handle = setTimeout(() => {}, 2_147_483_647);
        clearTimeout(handle);
        return handle;
      },
      clearTimer: () => {},
    },
    onPositionsCommitted: async (token) => {
      acknowledgements.push(token);
      if (acknowledgements.length === 1) await acknowledgement;
    },
  });
  runtime.bindBusinessDeps({
    monitorContext,
    dailyLossTracker: createDailyLossTrackerDouble(),
    liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
    protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
    mixedTradeLogRepository: { appendCompletionIdempotent: () => {} },
  });
  runtime.recordSettlementRefreshNeed({ refreshAccount: true, refreshPositions: true });
  runtime.start();
  const ready = runtime.waitForFresh();
  run();
  for (let index = 0; index < 40; index++) await Promise.resolve();

  expect(acknowledgements).toHaveLength(1);
  expect(published).toEqual([]);
  await snapshot.requestRefresh({
    source: 'SEAT_ACTIVATION',
    dayEpoch: 1,
    refreshAccount: true,
    refreshPositions: true,
  }).result;
  acknowledge();
  const receipt = await ready;
  expect(acknowledgements).toHaveLength(2);
  expect(receipt.snapshotToken).toEqual(snapshot.getView().token);
  expect(receipt.snapshotToken.commitRevision).not.toBe(acknowledgements[0]?.commitRevision);
  expect(published).toEqual([
    receipt.snapshotToken.commitRevision,
    receipt.snapshotToken.commitRevision,
  ]);
  expect(runtime.getStatus().staleVersion).toBe(1);
  expect(runtime.isCurrent(receipt)).toBe(true);
  await runtime.stopAndDrain();
});
