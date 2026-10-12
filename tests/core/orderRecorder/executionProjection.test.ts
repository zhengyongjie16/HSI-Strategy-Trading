/** 同实例 API/在线事实投影回归：真实 H issued token、Daily 准入和 S stale；无默认 current/ADMITTED。 */
import { describe, expect, test } from 'bun:test';
import type { BrokerOrderExecutionFact } from '../../../src/types/orderRecorder.js';
import type { RawOrderFromAPI } from '../../../src/types/services.js';
import type { SnapshotToken } from '../../../src/types/accountPosition.js';
import {
  createAccountSnapshotDouble,
  createMonitorConfigDouble,
} from '../../helpers/testDoubles.js';
import { createExecutionFixture } from './executionFixture.js';

const BASE = Date.parse('2026-03-13T02:00:00.000Z');
const target = [{ symbol: 'A.HK', isLongSymbol: true }];

function fact(
  id: string,
  side: 'BUY' | 'SELL',
  quantity: number,
  amount: string,
  time: number,
  revision = time,
): BrokerOrderExecutionFact {
  return {
    brokerOrderId: id,
    symbol: 'A.HK',
    side,
    cumulativeQuantity: quantity,
    cumulativeAmount: amount,
    executionTimeMs: quantity === 0 ? null : BASE + time,
    updatedAtMs: BASE + revision,
    phase: 'TERMINAL',
  };
}

function raw(input: BrokerOrderExecutionFact, price: string): RawOrderFromAPI {
  return {
    orderId: input.brokerOrderId,
    symbol: input.symbol,
    stockName: 'A RC',
    remark: '',
    executionSide: input.side,
    executionStatus: input.phase === 'OPEN' ? 'PARTIAL' : 'FILLED',
    executionPhase: input.phase,
    status: input.phase === 'OPEN' ? 'PARTIALLY_FILLED' : 'FILLED',
    orderType: 'LO',
    quantity: input.cumulativeQuantity,
    executedQuantity: input.cumulativeQuantity,
    price,
    executedPrice: price,
    executedAmount: input.cumulativeAmount,
    submittedAt: new Date(BASE),
    executionTimeMs: input.executionTimeMs,
    updatedAtMs: input.updatedAtMs,
    updatedAt: new Date(input.updatedAtMs),
  };
}

async function capturedRefresh(
  f: ReturnType<typeof createExecutionFixture>,
): Promise<SnapshotToken> {
  const issued = f.snapshot.requestRefresh({
    source: 'PROJECTION_BASELINE_TEST',
    dayEpoch: 1,
    refreshAccount: true,
    refreshPositions: true,
  });
  const receipt = await issued.result;
  if (receipt.status !== 'COMMITTED') throw new Error('projection snapshot operation aborted');

  return receipt.snapshotToken;
}

async function fixture() {
  const f = createExecutionFixture({
    nowMs: BASE,
    readPort: {
      getAccountSnapshot: async () => createAccountSnapshotDouble('10000'),
      getStockPositions: async () => [],
    },
  });
  const token = await capturedRefresh(f);
  return { ...f, token };
}

function baseline(
  f: ReturnType<typeof createExecutionFixture>,
  orders: ReadonlyArray<RawOrderFromAPI>,
  capturedToken: SnapshotToken,
  mode: 'ACTIVATION' | 'REBUILD',
) {
  const prepared = f.daily.prepareRecalculationFromAllOrders(
    orders,
    createMonitorConfigDouble({ monitorSymbol: 'HSI.HK', orderOwnershipMapping: ['A'] }),
    new Date(BASE + 10_000),
  );
  const result = f.recorder.commitRebuildSnapshot(
    target,
    orders,
    () =>
      f.snapshot.isCurrent(capturedToken, { account: true, positions: true, paired: true }) &&
      prepared.isCurrent(),
    mode,
  );
  if (result.status === 'COMMITTED') f.daily.publishRecalculation(prepared);

  return result;
}

function commit(
  f: ReturnType<typeof createExecutionFixture>,
  input: BrokerOrderExecutionFact,
  price: string,
) {
  if (input.executionTimeMs === null)
    throw new Error('positive projection fixture needs independent execution time');

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
        executedTimeMs: input.executionTimeMs!,
        orderUpdatedAtMs: input.updatedAtMs,
      }).admission,
  );
}

describe('one order owner projection', () => {
  test('API baseline then identical WS/query never consumes economic quantity twice', async () => {
    const f = await fixture();
    const buy = fact('buy', 'BUY', 100, '100', 1000);
    expect(baseline(f, [raw(buy, '1')], f.token, 'ACTIVATION').status).toBe('COMMITTED');
    const receipt = commit(f, buy, '1');
    expect(receipt.authoritativeFactChanged).toBe(false);
    expect(receipt.economicProjectionChanged).toBe(false);
    expect(f.recorder.getCostBasis('A.HK', true)).toEqual({ costAmount: '100', quantity: 100 });
    expect(f.sink.getStatus().staleVersion).toBe(0);
    expect(f.snapshot.isCurrent(f.token, { account: true, positions: true, paired: true })).toBe(
      true,
    );
  });

  test('SELL-eliminated BUY and empty projection retain evidence; valid amount revision re-runs filtering', async () => {
    const f = await fixture();
    const a = fact('a', 'BUY', 100, '100', 1000);
    const b = fact('b', 'BUY', 100, '200', 1100);
    const sell = fact('sell', 'SELL', 100, '150', 1200);
    expect(
      baseline(f, [raw(a, '1'), raw(b, '2'), raw(sell, '1.5')], f.token, 'ACTIVATION').status,
    ).toBe('COMMITTED');

    expect(f.recorder.getBuyOrdersForSymbol('A.HK', true).map((order) => order.orderId)).toEqual([
      'b',
    ]);
    expect(commit(f, a, '1').economicProjectionChanged).toBe(false);
    expect(commit(f, sell, '1.5').economicProjectionChanged).toBe(false);
    const revised = commit(f, { ...a, cumulativeAmount: '300', updatedAtMs: BASE + 1300 }, '3');
    expect(revised.executionAdvanced).toBe(false);
    expect(revised.economicProjectionChanged).toBe(true);
    expect(f.recorder.getBuyOrdersForSymbol('A.HK', true).map((order) => order.orderId)).toEqual([
      'a',
    ]);
    commit(f, fact('sell2', 'SELL', 100, '100', 1400), '1');
    expect(f.recorder.getBuyOrdersForSymbol('A.HK', true)).toEqual([]);
    expect(commit(f, sell, '1.5').economicProjectionChanged).toBe(false);
    expect(f.sink.getStatus().staleVersion).toBe(2);
  });

  test('OPEN partial is not covered; same quantity terminal first projects and actual stale batch aborts', async () => {
    const f = await fixture();
    const open = { ...fact('open', 'BUY', 100, '100', 1000), phase: 'OPEN' as const };
    commit(f, open, '1');
    expect(f.recorder.getBuyOrdersForSymbol('A.HK', true)).toEqual([]);
    const terminal = commit(f, { ...open, phase: 'TERMINAL', updatedAtMs: BASE + 1100 }, '1');
    expect(terminal.executionAdvanced).toBe(false);
    expect(terminal.economicProjectionChanged).toBe(true);
    f.snapshot.invalidate();
    const beforeDaily = f.daily.getExecutionTimeEvidence();
    expect(
      baseline(f, [raw(fact('late', 'BUY', 100, '200', 1200), '2')], f.token, 'ACTIVATION').status,
    ).toBe('ABORTED');
    expect(f.recorder.getExecutionFact('late')).toBeNull();
    expect(f.recorder.getCostBasis('A.HK', true)?.quantity).toBe(100);
    expect(f.daily.getExecutionTimeEvidence()).toEqual(beforeDaily);
  });

  test('clear scope blocks then-current projected portion but not later increment; corrections do not resurrect it', async () => {
    const f = await fixture();
    const original = fact('a', 'BUY', 100, '100', 1000);
    commit(f, original, '1');
    f.recorder.clearBuyOrders('A.HK', true);
    commit(f, { ...original, cumulativeAmount: '120', updatedAtMs: BASE + 1100 }, '1.2');
    expect(f.recorder.getBuyOrdersForSymbol('A.HK', true)).toEqual([]);
    commit(f, fact('a', 'BUY', 200, '240', 1200), '1.2');
    expect(f.recorder.getCostBasis('A.HK', true)).toEqual({ costAmount: '120', quantity: 100 });
    commit(f, fact('b', 'BUY', 100, '100', 1300), '1');
    commit(f, fact('sell', 'SELL', 100, '100', 1400), '1');
    expect(f.recorder.getBuyOrdersForSymbol('A.HK', true).map((order) => order.orderId)).toEqual([
      'a',
    ]);
    // 完成在线动作后开始一轮新的重建操作：真实 issued refresh 为该新操作捕获 token。
    const rebuildToken = await capturedRefresh(f);
    expect(
      baseline(f, [raw(fact('a', 'BUY', 200, '240', 1200), '1.2')], rebuildToken, 'REBUILD').status,
    ).toBe('COMMITTED');
    expect(f.recorder.getCostBasis('A.HK', true)).toEqual({ costAmount: '240', quantity: 200 });
  });
});
