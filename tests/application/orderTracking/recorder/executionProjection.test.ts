/** 同实例 API/在线事实投影回归：真实 H issued token、Daily 准入和 S stale；无默认 current/ADMITTED。 */

import { describe, expect, test } from 'bun:test';
import type { SnapshotToken } from '../../../../src/types/accountPosition.js';
import type { BrokerOrderExecutionFact } from '../../../../src/types/orderRecorder.js';
import type { OrderFact } from '../../../../src/types/trade.js';
import {
  createAccountSnapshotDouble,
  createMonitorConfigDouble,
} from '../../../helpers/testDoubles.js';
import { createExecutionFixture } from './executionFixture.js';
import {
  factToRecord,
  prepareExecutionCommit,
  projectRecords,
} from '../../../../src/domain/order/executionProjection.js';
import { applyFilteringAlgorithm } from '../../../../src/domain/order/orderFilteringEngine.js';
import { deductSellQuantityFromBuyOrders } from '../../../../src/domain/order/sellDeductionPolicy.js';

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

type RawOrder = OrderFact & Readonly<{ executedAmount: string }>;

function raw(input: BrokerOrderExecutionFact, price: string): RawOrder {
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
  orders: ReadonlyArray<RawOrder>,
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

  f.recorder.commitExecutionFact(
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
  test('pure HISTORY replay preserves the legacy survivor array order across time partitions and stable equal-time SELLs', () => {
    const times = [900, 1000, 1050, 1100, 1200];
    const buyTimes = times.flatMap((a) =>
      times.flatMap((b) => times.map((c) => [a, b, c] as const)),
    );
    for (const [aTime, bTime, cTime] of buyTimes) {
      for (const sellTime of [1000, 1100]) {
        for (const quantity of [25, 50]) {
          for (const reverse of [false, true]) {
            const buys = [
              fact('A', 'BUY', 50, '50', aTime),
              fact('C', 'BUY', 50, '150', cTime),
              fact('B', 'BUY', 100, '200', bTime),
            ];
            const sells = [
              fact('S1', 'SELL', quantity, String(quantity), 1000),
              fact('S2', 'SELL', 50, '50', sellTime),
            ];
            if (reverse) {
              buys.reverse();
              sells.reverse();
            }

            const facts = new Map(
              [...buys, ...sells].map((input) => [
                input.brokerOrderId,
                prepareExecutionCommit(input, true, undefined, [], 1, 'HISTORY'),
              ]),
            );
            const expected = applyFilteringAlgorithm(
              buys.map(factToRecord),
              sells.map(factToRecord),
              (candidates, sell) => {
                const retained = new Set(
                  deductSellQuantityFromBuyOrders(candidates, sell.executedQuantity).map(
                    (buy) => buy.orderId,
                  ),
                );
                return candidates.filter((buy) => retained.has(buy.orderId));
              },
            );
            expect(projectRecords(facts, 'A.HK', true)).toEqual(expected);
          }
        }
      }
    }
  });

  for (const scenario of [
    { name: 'future association', aTime: 2000, bTime: 900, growthTime: 1100, second: false },
    { name: 'unrelated equal-time BUY', aTime: 900, bTime: 1000, growthTime: 1000, second: false },
    { name: 'later SELL in same batch', aTime: 2000, bTime: 900, growthTime: 1100, second: true },
  ]) {
    test(`M5 exact settlement precedes every historical partition: ${scenario.name}`, async () => {
      const f = await fixture();
      const a = fact('A', 'BUY', 100, '100', scenario.aTime);
      const b = fact('B', 'BUY', 200, '400', scenario.bTime);
      expect(baseline(f, [raw(a, '1'), raw(b, '2')], f.token, 'ACTIVATION').status).toBe(
        'COMMITTED',
      );
      const selected = f.recorder.selectSellableOrders({
        symbol: 'A.HK',
        direction: 'LONG',
        strategy: 'ALL',
        currentPrice: '3',
        maxSellQuantity: 300,
      });
      expect(selected.totalQuantity).toBe(300);
      f.recorder.submitSellOrder(
        'S',
        'A.HK',
        'LONG',
        300,
        selected.orders.map((order) => order.orderId),
        BASE + 900,
      );

      expect(
        f.flow.settleOrder({
          orderId: 'S',
          closedReason: 'CANCELED',
          source: 'WS',
          symbol: 'A.HK',
          side: 'SELL',
          monitorSymbol: 'HSI.HK',
          isLongSymbol: true,
          isProtectiveLiquidation: false,
          executedPrice: '1.5',
          executedAmount: '150',
          executedQuantity: 100,
          executedTimeMs: BASE + 1000,
          orderUpdatedAtMs: BASE + 1000,
        }),
      ).toMatchObject({ handled: true, relatedBuyOrderIds: ['B'] });
      expect(f.recorder.getPendingSellSnapshot()).toEqual([]);
      expect(f.recorder.getCostBasis('A.HK', true)).toEqual({ costAmount: '400', quantity: 200 });
      const growth = raw(fact('S', 'SELL', 200, '300', scenario.growthTime, 1100), '1.5');
      const orders = [raw(a, '1'), raw(b, '2'), growth];
      if (scenario.second) orders.unshift(raw(fact('S2', 'SELL', 50, '150', 2100), '3'));

      const token = await capturedRefresh(f);
      for (let repeat = 0; repeat < 2; repeat += 1) {
        expect(baseline(f, orders, token, 'ACTIVATION').status).toBe('COMMITTED');
        expect(
          f.recorder.getBuyOrdersForSymbol('A.HK', true).map((order) => order.orderId),
        ).toEqual(['B']);
        expect(f.recorder.getCostBasis('A.HK', true)).toEqual({ costAmount: '400', quantity: 200 });
      }
    });
  }

  for (const future of [false, true]) {
    test(`M${future ? 8 : 7} historical SELL growth retains its earlier online candidate evidence`, async () => {
      const f = await fixture();
      const a = raw(fact('A', 'BUY', 100, '100', future ? 2000 : 1000), '1');
      const buys = future ? [a] : [a, raw(fact('B', 'BUY', 200, '400', 1000), '2')];
      expect(baseline(f, buys, f.token, 'ACTIVATION').status).toBe('COMMITTED');
      commit(f, fact('S', 'SELL', 100, '150', 1000), '1.5');
      const expected = future ? null : { costAmount: '400', quantity: 200 };
      expect(f.recorder.getCostBasis('A.HK', true)).toEqual(expected);
      const growth = raw(fact('S', 'SELL', 200, '300', future ? 1100 : 1000, 1100), '1.5');
      expect(baseline(f, [...buys, growth], await capturedRefresh(f), 'ACTIVATION').status).toBe(
        'COMMITTED',
      );
      expect(f.recorder.getCostBasis('A.HK', true)).toEqual(expected);
    });
  }

  for (const origin of ['ONLINE', 'ACTIVATION'] as const) {
    test(`M9 ${origin} growth uses only the applicable online sequence cut`, async () => {
      const f = await fixture();
      commit(f, fact('S', 'SELL', 100, '150', 1000), '1.5');
      const future = raw(fact('F', 'BUY', 100, '100', 2000), '1');
      expect(baseline(f, [future], await capturedRefresh(f), 'ACTIVATION').status).toBe(
        'COMMITTED',
      );
      const growth = fact('S', 'SELL', 200, '300', 1100);
      if (origin === 'ONLINE') commit(f, growth, '1.5');
      else
        expect(
          baseline(f, [raw(growth, '1.5')], await capturedRefresh(f), 'ACTIVATION').status,
        ).toBe('COMMITTED');

      const expected = origin === 'ONLINE' ? null : { costAmount: '100', quantity: 100 };
      expect(f.recorder.getCostBasis('A.HK', true)).toEqual(expected);
      commit(f, { ...growth, cumulativeAmount: '320', updatedAtMs: BASE + 1300 }, '1.6');
      // 同量在线金额修订不能把 HISTORY 增长位置升级为新的 onlineCut。
      expect(f.recorder.getCostBasis('A.HK', true)).toEqual(expected);
    });
  }

  for (const removal of ['SELL', 'CLEAR'] as const) {
    for (const origin of ['ONLINE', 'HISTORY'] as const) {
      test(`M10 ${removal} of ${origin} range cannot lend online evidence to its later same-ID HISTORY range`, async () => {
        const f = await fixture();
        const a = fact('A', 'BUY', 200, '200', 900);
        if (origin === 'ONLINE') commit(f, a, '1');
        else expect(baseline(f, [raw(a, '1')], f.token, 'ACTIVATION').status).toBe('COMMITTED');

        commit(f, fact('S', 'SELL', 100, '150', 1000), '1.5');
        expect(f.recorder.getCostBasis('A.HK', true)).toEqual({ costAmount: '200', quantity: 200 });
        if (removal === 'SELL') commit(f, fact('Q', 'SELL', 200, '300', 1050), '1.5');
        else f.recorder.clearBuyOrders('A.HK', true);

        expect(f.recorder.getCostBasis('A.HK', true)).toBeNull();
        const fresh = raw(fact('A', 'BUY', 300, '300', 2000), '1');
        expect(baseline(f, [fresh], await capturedRefresh(f), 'ACTIVATION').status).toBe(
          'COMMITTED',
        );
        const growth = raw(fact('S', 'SELL', 200, '300', 1100), '1.5');
        expect(baseline(f, [fresh, growth], await capturedRefresh(f), 'ACTIVATION').status).toBe(
          'COMMITTED',
        );

        expect(f.recorder.getBuyOrdersForSymbol('A.HK', true)).toMatchObject([
          { orderId: 'A', executedQuantity: 100, costAmount: '100', executedTime: BASE + 2000 },
        ]);
      });
    }
  }

  test('online equal-time SELL preserves unconsumed BUY and repeated ACTIVATION retains its original scope', async () => {
    for (const equalTime of [false, true]) {
      const f = await fixture();
      const a = fact('a', 'BUY', 100, '100', equalTime ? 1100 : 1000);
      const b = fact('b', 'BUY', 100, '200', 1100);
      const sell = fact('sell', 'SELL', 100, '150', 1100);
      for (const [input, price] of [
        [a, '1'],
        [b, '2'],
        [sell, '1.5'],
      ] as const)
        commit(f, input, price);

      expect(f.recorder.getBuyOrdersForSymbol('A.HK', true).map((o) => o.orderId)).toEqual(['b']);
      expect(f.recorder.getCostBasis('A.HK', true)).toEqual({ costAmount: '200', quantity: 100 });
      expect(f.daily.getLossOffset('LONG')).toBe('-150');
      const token = await capturedRefresh(f);
      const orders = [raw(sell, '1.5'), raw(b, '2'), raw(a, '1')];
      expect(baseline(f, orders, token, 'ACTIVATION').status).toBe('COMMITTED');
      expect(baseline(f, orders, token, 'ACTIVATION').status).toBe('COMMITTED');
      commit(f, { ...sell, updatedAtMs: BASE + 1200 }, '1.5');
      expect(f.recorder.getCostBasis('A.HK', true)).toEqual({ costAmount: '200', quantity: 100 });
      // 显式历史重建才重新解释历史时间分区；不能借 ACTIVATION 静默改写在线消费。
      expect(baseline(f, orders, token, 'REBUILD').status).toBe('COMMITTED');
      expect(f.recorder.getBuyOrdersForSymbol('A.HK', true)).toEqual([]);
    }
  });

  test('mixed history SELL batch shares each whole quantity once and cannot acquire late cheaper candidates', async () => {
    for (const lateOrigin of ['ONLINE', 'ACTIVATION'] as const) {
      const f = await fixture();
      const low = fact('low', 'BUY', 100, '100', 1000);
      const high = fact('high', 'BUY', 100, '400', 1000);
      const online = fact('online', 'BUY', 100, '200', 2000);
      const tie = fact('history-tie', 'BUY', 100, '300', 2000);
      const future = fact('future', 'BUY', 100, '500', 2200);
      const first = fact('S1', 'SELL', 100, '100', 2000);
      const second = fact('S2', 'SELL', 100, '100', 2100);
      expect(baseline(f, [raw(low, '1'), raw(high, '4')], f.token, 'ACTIVATION').status).toBe(
        'COMMITTED',
      );
      commit(f, online, '2');
      const token = await capturedRefresh(f);
      const orders = [raw(second, '1'), raw(tie, '3'), raw(future, '5'), raw(first, '1')];
      expect(baseline(f, orders, token, 'ACTIVATION').status).toBe('COMMITTED');
      // S1 消除历史 low，S2 消除在线 online；不能每个来源各消费 100，也不能抹掉等时在线候选。
      expect(
        f.recorder
          .getBuyOrdersForSymbol('A.HK', true)
          .map((order) => order.orderId)
          .sort((left, right) => left.localeCompare(right)),
      ).toEqual(['future', 'high']);
      expect(f.recorder.getCostBasis('A.HK', true)).toEqual({ costAmount: '900', quantity: 200 });
      expect(baseline(f, orders, token, 'ACTIVATION').status).toBe('COMMITTED');

      const late = fact('late', 'BUY', 100, '50', 900);
      if (lateOrigin === 'ONLINE') commit(f, late, '0.5');
      else expect(baseline(f, [raw(late, '0.5')], token, 'ACTIVATION').status).toBe('COMMITTED');

      const corrected = { ...low, cumulativeAmount: '600', updatedAtMs: BASE + 2300 };
      commit(f, corrected, '6');
      const refreshed = await capturedRefresh(f);
      expect(
        baseline(f, [...orders, raw(corrected, '6'), raw(late, '0.5')], refreshed, 'ACTIVATION')
          .status,
      ).toBe('COMMITTED');

      // 金额修订只能在旧候选中改选 online、high；晚到低价 BUY 即使 broker 时间更早也不能加入旧 SELL。
      expect(
        f.recorder
          .getBuyOrdersForSymbol('A.HK', true)
          .map((order) => order.orderId)
          .sort((left, right) => left.localeCompare(right)),
      ).toEqual(['future', 'late', 'low']);
      expect(f.recorder.getCostBasis('A.HK', true)).toEqual({ costAmount: '1150', quantity: 300 });
    }
  });

  test('mixed slices of one BUY remain a whole order and clear does not consume later historical growth', async () => {
    const f = await fixture();
    const first = fact('a', 'BUY', 100, '100', 1000);
    expect(baseline(f, [raw(first, '1')], f.token, 'ACTIVATION').status).toBe('COMMITTED');
    const grown = fact('a', 'BUY', 200, '200', 1100);
    commit(f, grown, '1');
    commit(f, fact('b', 'BUY', 100, '300', 1100), '3');
    const token = await capturedRefresh(f);
    const sell = fact('sell', 'SELL', 100, '150', 1200);
    expect(baseline(f, [raw(sell, '1.5')], token, 'ACTIVATION').status).toBe('COMMITTED');
    // a 的历史+在线共 200 股不可拆，100 股 SELL 只能整笔消除 b。
    expect(f.recorder.getBuyOrdersForSymbol('A.HK', true).map((order) => order.orderId)).toEqual([
      'a',
    ]);
    expect(f.recorder.getCostBasis('A.HK', true)).toEqual({ costAmount: '200', quantity: 200 });
    f.recorder.clearBuyOrders('A.HK', true);
    const corrected = { ...grown, cumulativeAmount: '400', updatedAtMs: BASE + 1250 };
    commit(f, corrected, '2');
    expect(f.recorder.getCostBasis('A.HK', true)).toBeNull();
    const refreshed = await capturedRefresh(f);
    const latest = fact('a', 'BUY', 300, '600', 1300);
    expect(baseline(f, [raw(latest, '2'), raw(sell, '1.5')], refreshed, 'ACTIVATION').status).toBe(
      'COMMITTED',
    );
    expect(f.recorder.getCostBasis('A.HK', true)).toEqual({ costAmount: '200', quantity: 100 });
    expect(baseline(f, [raw(latest, '2'), raw(sell, '1.5')], refreshed, 'ACTIVATION').status).toBe(
      'COMMITTED',
    );
    expect(f.recorder.getCostBasis('A.HK', true)).toEqual({ costAmount: '200', quantity: 100 });
  });

  test('history increments cannot split a live ONLINE identity across multiple SELLs in one batch', async () => {
    const f = await fixture();
    commit(f, fact('a', 'BUY', 100, '100', 1000), '1');
    const a200 = fact('a', 'BUY', 200, '200', 1100);
    const token = await capturedRefresh(f);
    expect(baseline(f, [raw(a200, '1')], token, 'ACTIVATION').status).toBe('COMMITTED');
    commit(f, fact('b', 'BUY', 100, '300', 1100), '3');
    const orders = [
      raw(fact('second', 'SELL', 100, '150', 1200), '1.5'),
      raw(fact('first', 'SELL', 100, '150', 1000), '1.5'),
      raw(a200, '1'),
    ];
    const refreshed = await capturedRefresh(f);
    expect(baseline(f, orders, refreshed, 'ACTIVATION').status).toBe('COMMITTED');
    // 两轮 SELL 各 100 都不能拆 A=200；首轮消 B 后，次轮也不能复活 B 或重扣 A 的一个来源。
    expect(f.recorder.getBuyOrdersForSymbol('A.HK', true).map((order) => order.orderId)).toEqual([
      'a',
    ]);
    expect(f.recorder.getCostBasis('A.HK', true)).toEqual({ costAmount: '200', quantity: 200 });
    expect(baseline(f, orders, refreshed, 'ACTIVATION').status).toBe('COMMITTED');
    expect(f.recorder.getCostBasis('A.HK', true)).toEqual({ costAmount: '200', quantity: 200 });
  });

  for (const removal of ['SELL', 'CLEAR'] as const) {
    test(`mixed identity excludes ${removal} ranges when later history increments arrive`, async () => {
      const f = await fixture();
      const a100 = fact('a', 'BUY', 100, '100', 1000);
      expect(baseline(f, [raw(a100, '1')], f.token, 'ACTIVATION').status).toBe('COMMITTED');
      const a200 = fact('a', 'BUY', 200, '200', 1100);
      commit(f, a200, '1');
      commit(f, fact('b', 'BUY', 100, '300', 1100), '3');
      const token = await capturedRefresh(f);
      expect(
        baseline(f, [raw(fact('first', 'SELL', 100, '150', 1000), '1.5')], token, 'ACTIVATION')
          .status,
      ).toBe('COMMITTED');
      expect(f.recorder.getCostBasis('A.HK', true)).toEqual({ costAmount: '200', quantity: 200 });
      if (removal === 'SELL') commit(f, fact('remove', 'SELL', 200, '300', 1150), '1.5');
      else f.recorder.clearBuyOrders('A.HK', true);

      expect(f.recorder.getCostBasis('A.HK', true)).toBeNull();
      const a300 = fact('a', 'BUY', 300, '300', 1300);
      const refreshed = await capturedRefresh(f);
      expect(baseline(f, [raw(a300, '1')], refreshed, 'ACTIVATION').status).toBe('COMMITTED');
      commit(f, fact('c', 'BUY', 100, '400', 1300), '4');
      const sell = fact('last', 'SELL', 100, '150', 1200);
      const latest = await capturedRefresh(f);
      expect(baseline(f, [raw(sell, '1.5'), raw(a300, '1')], latest, 'ACTIVATION').status).toBe(
        'COMMITTED',
      );

      // 只剩新增的历史 100；已消费/clear 的 ONLINE 不能把它重新标成完整在线 300。
      expect(f.recorder.getBuyOrdersForSymbol('A.HK', true).map((order) => order.orderId)).toEqual([
        'a',
      ]);
      expect(f.recorder.getCostBasis('A.HK', true)).toEqual({ costAmount: '100', quantity: 100 });
      commit(f, { ...a300, cumulativeAmount: '600', updatedAtMs: BASE + 1400 }, '2');
      expect(f.recorder.getCostBasis('A.HK', true)).toEqual({ costAmount: '200', quantity: 100 });
      // 同量 revision 保留原 T/范围；新的历史等时 SELL 才能证明旧 ONLINE 来源没有泄漏。
      commit(f, { ...sell, executionTimeMs: BASE + 1300, updatedAtMs: BASE + 1401 }, '1.5');
      expect(f.recorder.getCostBasis('A.HK', true)).toEqual({ costAmount: '200', quantity: 100 });
      const equalTime = await capturedRefresh(f);
      expect(
        baseline(f, [raw(fact('equal', 'SELL', 50, '75', 1300), '1.5')], equalTime, 'ACTIVATION')
          .status,
      ).toBe('COMMITTED');
      expect(f.recorder.getCostBasis('A.HK', true)).toBeNull();
    });
  }

  test('late cheaper BUY cannot join an old SELL, while amount correction reselects within its original candidates', async () => {
    for (const lateTime of [900, 1200]) {
      const f = await fixture();
      const a = fact('a', 'BUY', 100, '100', 1000);
      const b = fact('b', 'BUY', 100, '200', 1100);
      const sell = fact('sell', 'SELL', 100, '150', 1200);
      commit(f, a, '1');
      commit(f, b, '2');
      commit(f, sell, '1.5');
      commit(f, fact('late', 'BUY', 100, '50', lateTime), '0.5');
      expect(f.recorder.getBuyOrdersForSymbol('A.HK', true).map((o) => o.orderId)).toEqual([
        'b',
        'late',
      ]);
      commit(f, { ...a, cumulativeAmount: '300', updatedAtMs: BASE + 1300 }, '3');
      expect(f.recorder.getBuyOrdersForSymbol('A.HK', true).map((o) => o.orderId)).toEqual([
        'a',
        'late',
      ]);
      expect(f.recorder.getCostBasis('A.HK', true)).toEqual({ costAmount: '350', quantity: 200 });
      commit(f, { ...sell, cumulativeAmount: '160', updatedAtMs: BASE + 1400 }, '1.6');
      expect(f.recorder.getCostBasis('A.HK', true)).toEqual({ costAmount: '350', quantity: 200 });
    }
  });

  test('OPEN identity and failed or suppressed commits do not establish economic candidate priority', async () => {
    const f = await fixture();
    const openBuy = { ...fact('open', 'BUY', 100, '50', 900), phase: 'OPEN' as const };
    const a = fact('a', 'BUY', 100, '100', 1000);
    const b = fact('b', 'BUY', 100, '200', 1100);
    const sell = fact('sell', 'SELL', 100, '150', 1200);
    commit(f, openBuy, '0.5');
    commit(f, a, '1');
    commit(f, b, '2');
    expect(() => {
      f.recorder.commitExecutionFact(sell, true, [], () => {
        throw new Error('admission rejected');
      });
    }).toThrow('admission rejected');
    f.recorder.commitExecutionFact(sell, true, [], () => 'SUPPRESSED');
    expect(f.recorder.getExecutionFact('sell')).toBeNull();
    expect(f.recorder.getCostBasis('A.HK', true)).toEqual({ costAmount: '300', quantity: 200 });
    commit(f, sell, '1.5');
    commit(f, { ...openBuy, phase: 'TERMINAL', updatedAtMs: BASE + 1300 }, '0.5');
    expect(f.recorder.getBuyOrdersForSymbol('A.HK', true).map((o) => o.orderId)).toEqual([
      'b',
      'open',
    ]);
    expect(f.recorder.getCostBasis('A.HK', true)).toEqual({ costAmount: '250', quantity: 200 });
  });

  test('equal-time noncommutative SELLs replay successful admission rather than OPEN Map insertion order', async () => {
    const f = await fixture();
    const a = fact('a', 'BUY', 50, '50', 1000);
    const b = fact('b', 'BUY', 100, '200', 1000);
    const c = fact('c', 'BUY', 50, '150', 1000);
    const sell100 = fact('sell100', 'SELL', 100, '100', 1000);
    const sell50 = fact('sell50', 'SELL', 50, '50', 1000);
    commit(f, { ...sell100, phase: 'OPEN' }, '1');
    commit(f, a, '1');
    commit(f, b, '2');
    commit(f, c, '3');
    commit(f, sell50, '1');
    commit(f, { ...sell100, updatedAtMs: BASE + 1100 }, '1');
    // 50→100 消除 a、b 留 c；若按 Map 中的 100→50 重放则会错误留 b。
    expect(f.recorder.getBuyOrdersForSymbol('A.HK', true).map((o) => o.orderId)).toEqual(['c']);
    commit(f, { ...sell50, cumulativeAmount: '55', updatedAtMs: BASE + 1200 }, '1.1');
    commit(f, { ...sell100, updatedAtMs: BASE + 1300 }, '1');
    expect(f.recorder.getCostBasis('A.HK', true)).toEqual({ costAmount: '150', quantity: 50 });
    const token = await capturedRefresh(f);
    expect(
      baseline(
        f,
        [raw(a, '1'), raw(b, '2'), raw(c, '3'), raw(sell100, '1'), raw(sell50, '1')],
        token,
        'ACTIVATION',
      ).status,
    ).toBe('COMMITTED');
    expect(f.recorder.getCostBasis('A.HK', true)).toEqual({ costAmount: '150', quantity: 50 });
  });

  for (const delivery of ['ONLINE', 'ACTIVATION'] as const)
    test(`cumulative ${delivery} SELL moves one whole deduction past intervening BUY and SELL without consuming later increments`, async () => {
      const f = await fixture();
      commit(f, fact('a', 'BUY', 150, '150', 1000), '1');
      commit(f, fact('b', 'BUY', 50, '100', 1100), '2');
      commit(f, fact('sell', 'SELL', 100, '120', 1200), '1.2');
      commit(f, fact('c', 'BUY', 100, '300', 1100), '3');
      commit(f, fact('sell2', 'SELL', 50, '50', 1200), '1');
      const advanced = fact('sell', 'SELL', 200, '240', 1200, 1300);
      if (delivery === 'ONLINE') commit(f, advanced, '1.2');
      else
        expect(
          baseline(f, [raw(advanced, '1.2')], await capturedRefresh(f), 'ACTIVATION').status,
        ).toBe('COMMITTED');

      // 先重放 sell2=50 消除 b，再由累计 sell=200 消除 a；不是两个独立的 sell=100。
      expect(f.recorder.getBuyOrdersForSymbol('A.HK', true).map((o) => o.orderId)).toEqual(['c']);
      commit(f, fact('a', 'BUY', 250, '250', 1200, 1400), '1');
      commit(f, fact('late', 'BUY', 50, '25', 1000), '0.5');
      commit(f, { ...advanced, cumulativeAmount: '260', updatedAtMs: BASE + 1500 }, '1.3');
      expect(f.recorder.getCostBasis('A.HK', true)).toEqual({ costAmount: '425', quantity: 250 });
      expect(f.recorder.getBuyOrdersForSymbol('A.HK', true).map((o) => o.orderId)).toEqual([
        'c',
        'a',
        'late',
      ]);
    });

  test('clear retains only its original scope across replay and does not preclude corrected or new economic ranges', async () => {
    const f = await fixture();
    const a = fact('a', 'BUY', 100, '100', 1000);
    const b = fact('b', 'BUY', 100, '200', 1000);
    const sell = fact('sell', 'SELL', 100, '150', 1000);
    commit(f, a, '1');
    commit(f, b, '2');
    commit(f, sell, '1.5');
    f.recorder.clearBuyOrders('A.HK', true);
    commit(f, { ...a, cumulativeAmount: '300', updatedAtMs: BASE + 1100 }, '3');
    // clear 当时仅覆盖 b；金额修订在旧候选内改为消除 b，a 没有被扩大 clear 范围。
    expect(f.recorder.getBuyOrdersForSymbol('A.HK', true).map((o) => o.orderId)).toEqual(['a']);
    commit(f, fact('b', 'BUY', 200, '400', 1000, 1200), '2');
    expect(f.recorder.getCostBasis('A.HK', true)).toEqual({ costAmount: '500', quantity: 200 });
    commit(f, fact('sell2', 'SELL', 100, '100', 1000, 1300), '1');
    expect(f.recorder.getCostBasis('A.HK', true)).toEqual({ costAmount: '300', quantity: 100 });
    const token = await capturedRefresh(f);
    expect(baseline(f, [raw(b, '2'), raw(sell, '1.5')], token, 'ACTIVATION').status).toBe(
      'COMMITTED',
    );
    expect(f.recorder.getCostBasis('A.HK', true)).toEqual({ costAmount: '300', quantity: 100 });
  });

  test('API baseline then identical WS/query never consumes economic quantity twice', async () => {
    const f = await fixture();
    const buy = fact('buy', 'BUY', 100, '100', 1000);
    expect(baseline(f, [raw(buy, '1')], f.token, 'ACTIVATION').status).toBe('COMMITTED');
    commit(f, buy, '1');
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
    const eliminated = f.recorder.getBuyOrdersForSymbol('A.HK', true);
    commit(f, a, '1');
    commit(f, sell, '1.5');
    expect(f.recorder.getBuyOrdersForSymbol('A.HK', true)).toEqual(eliminated);
    // 合法金额修订只重跑过滤，不推进累计数量。
    expect(f.recorder.getExecutionFact('a')?.cumulativeQuantity).toBe(100);
    commit(f, { ...a, cumulativeAmount: '300', updatedAtMs: BASE + 1300 }, '3');
    expect(f.recorder.getExecutionFact('a')?.cumulativeQuantity).toBe(100);
    expect(f.recorder.getBuyOrdersForSymbol('A.HK', true).map((order) => order.orderId)).toEqual([
      'a',
    ]);
    commit(f, fact('sell2', 'SELL', 100, '100', 1400), '1');
    expect(f.recorder.getBuyOrdersForSymbol('A.HK', true)).toEqual([]);
    commit(f, sell, '1.5');
    expect(f.recorder.getBuyOrdersForSymbol('A.HK', true)).toEqual([]);
    expect(f.sink.getStatus().staleVersion).toBe(2);
  });

  test('OPEN partial is not covered; same quantity terminal first projects and actual stale batch aborts', async () => {
    const f = await fixture();
    const open = { ...fact('open', 'BUY', 100, '100', 1000), phase: 'OPEN' as const };
    commit(f, open, '1');
    expect(f.recorder.getBuyOrdersForSymbol('A.HK', true)).toEqual([]);
    commit(f, { ...open, phase: 'TERMINAL', updatedAtMs: BASE + 1100 }, '1');
    expect(f.recorder.getExecutionFact('open')?.cumulativeQuantity).toBe(100);
    expect(f.recorder.getCostBasis('A.HK', true)).toEqual({ costAmount: '100', quantity: 100 });
    f.snapshot.invalidate();
    expect(
      baseline(f, [raw(fact('late', 'BUY', 100, '200', 1200), '2')], f.token, 'ACTIVATION').status,
    ).toBe('ABORTED');
    expect(f.recorder.getExecutionFact('late')).toBeNull();
    expect(f.recorder.getCostBasis('A.HK', true)?.quantity).toBe(100);
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
