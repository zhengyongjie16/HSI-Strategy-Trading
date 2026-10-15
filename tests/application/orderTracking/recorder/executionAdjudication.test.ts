/** O共享累计事实裁决：原同revision/phase/累计整单经济oracle，同O/Daily/H/S真实准入。 */

import { expect, test } from 'bun:test';
import {
  mergeBrokerOrderExecutionFact,
  withTrustedOrderExecutionTimes,
} from '../../../../src/domain/order/executionFact.js';
import type {
  BrokerOrderExecutionFact,
  OrderExecutionTimeEvidence,
} from '../../../../src/types/orderRecorder.js';
import type { OrderFact } from '../../../../src/types/trade.js';
import {
  createAccountSnapshotDouble,
  createMonitorConfigDouble,
} from '../../../helpers/testDoubles.js';
import { createExecutionFixture } from './executionFixture.js';

function fact(
  quantity: number,
  amount: string,
  phase: 'OPEN' | 'TERMINAL' = 'OPEN',
): BrokerOrderExecutionFact {
  return {
    brokerOrderId: 'a',
    symbol: 'A.HK',
    side: 'BUY',
    cumulativeQuantity: quantity,
    cumulativeAmount: amount,
    executionTimeMs: 1000,
    updatedAtMs: 2000,
    phase,
  };
}

function raw(amount: string): OrderFact {
  // 正累计金额与未知执行时间均为用例事实；空价格元数据不能制造或抹除 T。
  return {
    orderId: 'a',
    symbol: 'A.HK',
    stockName: 'A RC',
    remark: '',
    executionSide: 'BUY',
    executionStatus: 'FILLED',
    executionPhase: 'TERMINAL',
    status: 'FILLED',
    orderType: 'LO',
    quantity: 100,
    executedQuantity: 100,
    price: null,
    executedPrice: null,
    executedAmount: amount,
    submittedAt: new Date(1),
    executionTimeMs: null,
    updatedAtMs: 2000,
    updatedAt: new Date(2000),
  };
}

function evidence(amount: string, phase: 'OPEN' | 'TERMINAL'): OrderExecutionTimeEvidence {
  return {
    brokerOrderId: 'a',
    symbol: 'A.HK',
    side: 'BUY',
    cumulativeQuantity: 100,
    cumulativeAmount: amount,
    lastExecutionTimeMs: 1000,
    orderRevisionMs: 2000,
    phase,
  };
}

function commit(
  f: ReturnType<typeof createExecutionFixture>,
  input: BrokerOrderExecutionFact,
  price: string,
) {
  if (input.executionTimeMs === null)
    throw new Error('positive fixture requires real execution time');

  const executionTimeMs = input.executionTimeMs;
  return f.recorder.commitExecutionFact(
    input,
    true,
    [],
    () =>
      f.daily.recordCumulativeExecution({
        orderId: input.brokerOrderId,
        symbol: input.symbol,
        direction: 'LONG',
        side: input.side,
        factStage: input.phase,
        executedPrice: price,
        executedQuantity: input.cumulativeQuantity,
        executedTimeMs: executionTimeMs,
        orderUpdatedAtMs: input.updatedAtMs,
      }).admission,
  );
}

async function ready() {
  const f = createExecutionFixture({
    nowMs: 1000,
    readPort: {
      getAccountSnapshot: async () => createAccountSnapshotDouble('10000'),
      getStockPositions: async () => [],
    },
  });
  const issued = f.snapshot.requestRefresh({
    source: 'ADJUDICATION_BASELINE',
    dayEpoch: f.snapshot.getView().token.dayEpoch,
    refreshAccount: true,
    refreshPositions: true,
  });
  const receipt = await issued.result;
  if (receipt.status !== 'COMMITTED') throw new Error('adjudication paired refresh aborted');

  return f;
}

function baseline(
  f: ReturnType<typeof createExecutionFixture>,
  orders: Parameters<typeof f.recorder.commitRebuildSnapshot>[1],
  origin: 'ACTIVATION' | 'REBUILD',
) {
  const captured = f.snapshot.getView().token;
  const prepared = f.daily.prepareRecalculationFromAllOrders(
    orders,
    createMonitorConfigDouble({ monitorSymbol: 'HSI.HK', orderOwnershipMapping: ['A'] }),
    new Date(2000),
  );
  const result = f.recorder.commitRebuildSnapshot(
    [{ symbol: 'A.HK', isLongSymbol: true }],
    orders,
    () =>
      f.snapshot.isCurrent(captured, { account: true, positions: true, paired: true }) &&
      prepared.isCurrent(),
    origin,
  );
  if (result.status === 'COMMITTED') f.daily.publishRecalculation(prepared);

  return result;
}

test('same revision positive quantity advance and OPEN->TERMINAL final amount accepted, real conflicts/regressions rejected', () => {
  const open = fact(100, '44');
  expect(mergeBrokerOrderExecutionFact(open, fact(200, '90')).cumulativeQuantity).toBe(200);
  const terminal = mergeBrokerOrderExecutionFact(open, fact(100, '45', 'TERMINAL'));
  expect(terminal.cumulativeAmount).toBe('45');
  expect(terminal.phase).toBe('TERMINAL');
  expect(() => mergeBrokerOrderExecutionFact(open, fact(100, '45'))).toThrow(/同 revision/);
  expect(() => mergeBrokerOrderExecutionFact(terminal, fact(100, '45'))).toThrow(
    /TERMINAL -> OPEN/,
  );

  expect(() =>
    mergeBrokerOrderExecutionFact(open, { ...fact(200, '90'), updatedAtMs: 1999 }),
  ).toThrow(/revision 倒退/);
  expect(() => mergeBrokerOrderExecutionFact(open, fact(50, '22'))).toThrow(/累计数量倒退/);
});

test('trusted evidence terminal dominates same-revision OPEN44/TERMINAL45 regardless input order, no fabricated T', () => {
  const order = raw('45'),
    open = evidence('44', 'OPEN'),
    terminal = evidence('45', 'TERMINAL');
  for (const items of [
    [open, terminal],
    [terminal, open],
  ])
    expect(withTrustedOrderExecutionTimes([order], items)[0]?.executionTimeMs).toBe(1000);

  expect(order.executionTimeMs).toBeNull();
  expect(
    withTrustedOrderExecutionTimes([order], [{ ...terminal, cumulativeQuantity: 50 }])[0]
      ?.executionTimeMs,
  ).toBeNull();

  expect(() =>
    withTrustedOrderExecutionTimes([order], [terminal, { ...terminal, cumulativeAmount: '46' }]),
  ).toThrow(/同 revision/);
  const conflicting = raw('46');
  expect(() => withTrustedOrderExecutionTimes([conflicting], [terminal])).toThrow(/同 revision/);
});

test('one SELL cumulative100->200 is one whole-order filter, consumption deltas never become two SELL inputs', () => {
  const f = createExecutionFixture({ nowMs: 1000 });
  commit(f, { ...fact(150, '150', 'TERMINAL'), brokerOrderId: 'buy150' }, '1');
  commit(
    f,
    { ...fact(50, '25', 'TERMINAL'), brokerOrderId: 'buy50', executionTimeMs: 1100 },
    '0.5',
  );
  const sell: BrokerOrderExecutionFact = {
    ...fact(100, '100', 'TERMINAL'),
    brokerOrderId: 'sell',
    side: 'SELL',
    executionTimeMs: 1200,
  };
  commit(f, sell, '1');
  expect(f.recorder.getCostBasis('A.HK', true)?.quantity).toBe(150);
  const advanced = {
    ...sell,
    cumulativeQuantity: 200,
    cumulativeAmount: '200',
    executionTimeMs: 1300,
    updatedAtMs: 2100,
  };
  commit(f, advanced, '1');
  expect(f.recorder.getBuyOrdersForSymbol('A.HK', true)).toEqual([]);
  const generation = f.snapshot.getView().token.snapshotGeneration;
  expect(commit(f, advanced, '1').economicProjectionChanged).toBe(false);
  expect(f.snapshot.getView().token.snapshotGeneration).toBe(generation);
});

test('V1 baseline unknown phase needs matching real progress/API payload; never fabricates OPEN amount permission', () => {
  const unknown = { ...evidence('44', 'OPEN'), phase: null },
    open = evidence('44', 'OPEN'),
    terminal = evidence('45', 'TERMINAL');
  const amount45 = raw('45'),
    amount44 = raw('44');
  expect(
    withTrustedOrderExecutionTimes([amount45], [unknown, open, terminal])[0]?.executionTimeMs,
  ).toBe(1000);
  expect(withTrustedOrderExecutionTimes([amount44], [unknown])[0]?.executionTimeMs).toBe(1000);
  expect(() => withTrustedOrderExecutionTimes([amount45], [unknown])).toThrow(/未知 phase/);
  expect(() => withTrustedOrderExecutionTimes([amount45], [unknown, terminal])).toThrow(
    /未知 phase/,
  );

  expect(() =>
    withTrustedOrderExecutionTimes(
      [amount45],
      [{ ...unknown, lastExecutionTimeMs: 900 }, open, terminal],
    ),
  ).toThrow(/执行时间冲突/);
});

test('API activation/rebuild coverage baseline never manufactures stale; only actual online fact changes register once', async () => {
  const f = await ready();
  const order = { ...raw('100'), executionTimeMs: 1000 };
  expect(baseline(f, [order], 'ACTIVATION').status).toBe('COMMITTED');
  const initial = f.snapshot.getView().token.snapshotGeneration;
  commit(f, fact(100, '100', 'TERMINAL'), '1');
  expect(f.snapshot.getView().token.snapshotGeneration).toBe(initial);
  const advanced = { ...fact(200, '200', 'TERMINAL'), executionTimeMs: 1500, updatedAtMs: 2500 };
  commit(f, advanced, '1');
  expect(f.snapshot.getView().token.snapshotGeneration).toBe(initial + 1);
  commit(f, advanced, '1');
  expect(f.snapshot.getView().token.snapshotGeneration).toBe(initial + 1);
  const refreshed = f.snapshot.requestRefresh({
    source: 'ADJUDICATION_NEXT_REBUILD',
    dayEpoch: f.snapshot.getView().token.dayEpoch,
    refreshAccount: true,
    refreshPositions: true,
  });
  const receipt = await refreshed.result;
  if (receipt.status !== 'COMMITTED') throw new Error('next adjudication refresh aborted');

  expect(baseline(f, [], 'REBUILD').status).toBe('COMMITTED');
  expect(f.snapshot.getView().token.snapshotGeneration).toBe(initial + 1);
});
