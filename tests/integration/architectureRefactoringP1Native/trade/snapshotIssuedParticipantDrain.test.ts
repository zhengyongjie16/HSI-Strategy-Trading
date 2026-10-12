import { expect, test } from 'bun:test';
import { createAccountPositionSnapshot } from '../../../../src/application/accountPositionSnapshot/index.js';
import type { Position } from '../../../../src/types/account.js';

function fixture() {
  let finishRead: ((positions: ReadonlyArray<Position>) => void) | null = null;
  let reads = 0;
  const scheduled: Array<() => void> = [];
  const snapshot = createAccountPositionSnapshot({
    dayEpoch: 1,
    scheduler: {
      schedule: (callback) => {
        scheduled.push(callback);
      },
    },
    readPort: {
      getAccountSnapshot: async () => {
        throw new Error('no account read authorized');
      },
      getStockPositions: async () => {
        reads++;
        return new Promise<ReadonlyArray<Position>>((resolve) => {
          finishRead = resolve;
        });
      },
    },
    reportFatalError: (error) => {
      throw error;
    },
  });
  return {
    snapshot,
    enter: () => {
      const callback = scheduled.shift();
      if (callback === undefined) throw new Error('no scheduled batch');

      callback();
    },
    settle: () => {
      if (finishRead === null) throw new Error('read not entered');

      finishRead([]);
    },
    readCount: () => reads,
  };
}
const request = {
  source: 'POST_TRADE_SETTLEMENT' as const,
  dayEpoch: 1,
  refreshAccount: false,
  refreshPositions: true,
};

test('participant-specific cancelIfNotIssued preserves actual issued result/drain but cancels queued peer without issuing another read', async () => {
  const f = fixture();
  const issued = f.snapshot.requestRefresh(request);
  f.enter();
  expect(f.readCount()).toBe(1);
  const queued = f.snapshot.requestRefresh(request);
  queued.cancelIfNotIssued();
  expect(await queued.result).toEqual({ status: 'ABORTED' });
  issued.cancelIfNotIssued();
  let delivered = false;
  void issued.result.then(() => {
    delivered = true;
  });
  let drained = false;
  const drain = f.snapshot.waitForIssuedDrain().then(() => {
    drained = true;
  });
  await Promise.resolve();
  expect(delivered).toBe(false);
  expect(drained).toBe(false);
  f.settle();
  const receipt = await issued.result;
  expect(receipt.status).toBe('COMMITTED');
  await drain;
  expect(drained).toBe(true);
  expect(f.readCount()).toBe(1);
});

test('ordinary participant cancel remains abortable after issue and does not cancel actual native read drain', async () => {
  const f = fixture();
  const participant = f.snapshot.requestRefresh(request);
  f.enter();
  participant.cancel();
  expect(await participant.result).toEqual({ status: 'ABORTED' });
  let drained = false;
  const drain = f.snapshot.waitForIssuedDrain().then(() => {
    drained = true;
  });
  await Promise.resolve();
  expect(drained).toBe(false);
  f.settle();
  await drain;
  expect(drained).toBe(true);
  expect(f.readCount()).toBe(1);
});
