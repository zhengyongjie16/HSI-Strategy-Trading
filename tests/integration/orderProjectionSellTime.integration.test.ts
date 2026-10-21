/** O 在线准入与历史时间分区分别回归；经真实 Daily/RiskChecker 验证等时成交、clear 与关联扣减的 R1/N1。 */

import { expect, test } from 'bun:test';
import { resolveSellQuantityBySmartClose } from '../../src/application/ordinarySell/quantitySelection.js';
import { createRiskChecker } from '../../src/domain/risk/index.js';
import { createPositionLimitChecker } from '../../src/domain/risk/positionLimitChecker.js';
import { createUnrealizedLossChecker } from '../../src/domain/risk/unrealizedLossChecker.js';
import { createWarrantRiskChecker } from '../../src/domain/risk/warrantRiskChecker.js';
import type { OrderFact } from '../../src/types/trade.js';
import { createExecutionFixture } from '../application/orderTracking/recorder/executionFixture.js';
import { createAccountSnapshotDouble, createMonitorConfigDouble } from '../helpers/testDoubles.js';
import { createBrokerIngressFixture } from './architectureRefactoringP1Native/trade/brokerIngressFixture.js';
import { toRecalculationOrders } from './recalculationOrders.js';

const T = Date.parse('2026-10-07T02:00:00.000Z');
const monitor = createMonitorConfigDouble({
  monitorSymbol: 'HSI.HK',
  orderOwnershipMapping: ['HSI'],
});

async function observation(
  id: string,
  side: 'BUY' | 'SELL',
  quantity: number,
  price: string,
  time: number,
  revision = time,
  submittedQuantity = quantity,
) {
  const native = await createBrokerIngressFixture({
    orderId: id,
    symbol: 'BULL.HK',
    stockName: 'HSI RC',
    remark: '',
    side,
    status: quantity === submittedQuantity ? 'Filled' : 'Canceled',
    quantity: String(submittedQuantity),
    executedQuantity: String(quantity),
    submittedPrice: price,
    executedPrice: price,
    submittedAtMs: T - 1000,
    updatedAtMs: T + revision,
  });
  return native.pushObservation;
}

function commit(
  f: ReturnType<typeof createExecutionFixture>,
  o: OrderFact,
  related: ReadonlyArray<string> = [],
) {
  const { executedAmount, executedPrice, executionTimeMs } = o;
  if (executionTimeMs === null || executedPrice === null || executedAmount === null)
    throw new Error('fixture must have full execution facts');

  if (related.length === 0) {
    f.flow.recordCumulativeExecution({
      orderId: o.orderId,
      symbol: o.symbol,
      side: o.executionSide,
      monitorSymbol: monitor.monitorSymbol,
      isLongSymbol: true,
      isProtectiveLiquidation: false,
      factStage: o.executionPhase,
      executedPrice,
      executedQuantity: o.executedQuantity,
      executedAmount,
      executedTimeMs: executionTimeMs,
      orderUpdatedAtMs: o.updatedAtMs,
    });
    return;
  }

  f.recorder.commitExecutionFact(
    {
      brokerOrderId: o.orderId,
      symbol: o.symbol,
      side: o.executionSide,
      phase: o.executionPhase,
      cumulativeQuantity: o.executedQuantity,
      cumulativeAmount: executedAmount,
      executionTimeMs,
      updatedAtMs: o.updatedAtMs,
    },
    true,
    related,
    () =>
      f.daily.recordCumulativeExecution({
        orderId: o.orderId,
        direction: 'LONG',
        symbol: o.symbol,
        side: o.executionSide,
        factStage: o.executionPhase,
        executedQuantity: o.executedQuantity,
        executedPrice,
        executedTimeMs: executionTimeMs,
        orderUpdatedAtMs: o.updatedAtMs,
      }).admission,
  );
}

function fixture() {
  return createExecutionFixture({
    nowMs: T,
    readPort: {
      getAccountSnapshot: async () => createAccountSnapshotDouble('10000'),
      getStockPositions: async () => [],
    },
  });
}

async function baseline(
  f: ReturnType<typeof createExecutionFixture>,
  orders: ReadonlyArray<OrderFact>,
  mode: 'ACTIVATION' | 'REBUILD' = 'ACTIVATION',
) {
  const receipt = await f.snapshot.requestRefresh({
    source: 'MIXED_PROJECTION_TEST',
    dayEpoch: 1,
    refreshAccount: true,
    refreshPositions: true,
  }).result;
  if (receipt.status !== 'COMMITTED') throw new Error('projection snapshot refresh aborted');

  const prepared = f.daily.prepareRecalculationFromAllOrders(
    toRecalculationOrders(orders),
    monitor,
    new Date(T),
  );
  expect(
    f.recorder.commitRebuildSnapshot(
      [{ symbol: 'BULL.HK', isLongSymbol: true }],
      orders,
      () =>
        f.snapshot.isCurrent(receipt.snapshotToken, {
          account: true,
          positions: true,
          paired: true,
        }) && prepared.isCurrent(),
      mode,
    ).status,
  ).toBe('COMMITTED');
  f.daily.publishRecalculation(prepared);
}

/** 真实金融消费者读取当前 O 成本与 Daily offset；prepare 不发布，publish 后 cache/metrics 使用确切 R1/N1。 */
function assertRiskProjection(
  f: ReturnType<typeof createExecutionFixture>,
  expectedR1: string,
  expectedN1: number,
): ReturnType<typeof createRiskChecker> {
  const unrealizedLossChecker = createUnrealizedLossChecker({
    maxUnrealizedLossPerSymbol: '50',
    onMissingData: () => {},
  });
  const riskChecker = createRiskChecker({
    warrantRiskChecker: createWarrantRiskChecker({
      onInvalidCallPrice: () => {},
      onWarrantInfoSet: () => {},
    }),
    positionLimitChecker: createPositionLimitChecker({ maxPositionNotional: null }),
    unrealizedLossChecker,
  });
  const prepared = riskChecker.prepareUnrealizedLossData(
    f.recorder,
    'BULL.HK',
    true,
    f.daily.getLossOffset('LONG'),
  );
  expect(prepared.data).toEqual({ r1: expectedR1, n1: expectedN1 });
  expect(unrealizedLossChecker.getUnrealizedLossData('BULL.HK')).toBeUndefined();
  riskChecker.publishUnrealizedLossData(prepared);
  expect(unrealizedLossChecker.getUnrealizedLossData('BULL.HK')).toEqual({
    r1: expectedR1,
    n1: expectedN1,
  });
  // 价格 5 的独立整数 oracle，不用生产 exact helper 构造期望金额。
  const expectedR2 = BigInt(expectedN1) * 5n;
  expect(riskChecker.getUnrealizedLossMetrics('BULL.HK', '5')).toEqual({
    r2: String(expectedR2),
    unrealizedPnL: String(expectedR2 - BigInt(expectedR1)),
  });
  return riskChecker;
}

/** 对照生产消费者，防止仅修正列表而风险保护或智能平仓仍使用空成本。 */
function assertMixedProjection(
  f: ReturnType<typeof createExecutionFixture>,
  id: string,
  costAmount: string,
  lossOffset: string,
  r1: string,
  quantity = 100,
  riskPrice = '1',
): void {
  expect(f.recorder.getBuyOrdersForSymbol('BULL.HK', true).map((order) => order.orderId)).toEqual([
    id,
  ]);
  expect(f.recorder.getCostBasis('BULL.HK', true)).toEqual({ costAmount, quantity });
  expect(f.daily.getLossOffset('LONG')).toBe(lossOffset);
  const risk = assertRiskProjection(f, r1, quantity);
  expect(risk.checkUnrealizedLoss('BULL.HK', riskPrice, true)).toMatchObject({
    shouldLiquidate: true,
    quantity,
  });

  expect(
    resolveSellQuantityBySmartClose({
      orderRecorder: f.recorder,
      currentPrice: '4',
      availableQuantity: quantity,
      direction: 'LONG',
      symbol: 'BULL.HK',
      smartCloseTimeoutMinutes: null,
      nowMs: T + 2000,
      isHalfDay: false,
      tradingCalendarSnapshot: new Map(),
    }),
  ).toMatchObject({ quantity, shouldHold: false, relatedBuyOrderIds: [id] });
}

for (const delivery of ['ONLINE', 'ACTIVATION'] as const) {
  for (const sellTime of [900, 1000, 1200]) {
    test(`whole mixed BUY identity: ${delivery} SELL at ${sellTime}`, async () => {
      const f = fixture();
      const a100 = await observation('A', 'BUY', 100, '1', 1000, 1000, 200);
      const a200 = await observation('A', 'BUY', 200, '1', 1100);
      const b = await observation('B', 'BUY', 100, '3', 1100);
      const sell = await observation('S', 'SELL', 100, '1.5', sellTime);
      await baseline(f, [a100]);
      commit(f, a200);
      commit(f, b);
      if (delivery === 'ONLINE') commit(f, sell);
      else await baseline(f, [a200, b, sell]);

      // 整笔 A=200 不能被 S=100 拆掉；只消 B=100。Daily 独立保持历史严格时间口径。
      const daily = sellTime === 1200 ? '-150' : '0';
      const r1 = sellTime === 1200 ? '350' : '200';
      assertMixedProjection(f, 'A', '200', daily, r1, 200, '0.5');
      await baseline(f, [a200, b, sell]);
      assertMixedProjection(f, 'A', '200', daily, r1, 200, '0.5');
    });
  }

  for (const sellDelay of [0, 1]) {
    test(`real exact association survives ${delivery} cumulative growth at +${sellDelay}ms`, async () => {
      const f = fixture();
      const b1 = await observation('B1', 'BUY', 100, '1', 1000);
      const b2 = await observation('B2', 'BUY', 200, '2', 1000);
      const sold100 = await observation(
        'S',
        'SELL',
        100,
        '1.5',
        1000 + sellDelay,
        1000 + sellDelay,
        300,
      );
      const sold200 = await observation(
        'S',
        'SELL',
        200,
        '1.5',
        1000 + sellDelay,
        1000 + sellDelay,
        300,
      );
      await baseline(f, [b1]);
      commit(f, b2);
      const selected = f.recorder.selectSellableOrders({
        symbol: 'BULL.HK',
        direction: 'LONG',
        strategy: 'ALL',
        currentPrice: '3',
        maxSellQuantity: 300,
      });
      expect(selected.totalQuantity).toBe(300);
      f.recorder.submitSellOrder(
        'S',
        'BULL.HK',
        'LONG',
        300,
        selected.orders.map((order) => order.orderId),
        T + 900,
      );
      expect(f.recorder.getPendingSellSnapshot()[0]?.relatedBuyOrderIds).toEqual(['B1', 'B2']);
      if (sold100.executedAmount === null) throw new Error('native SELL 缺少成交金额');

      // 只能由真实 settlement 按累计成交 100 从 pending 的 300 中证明 exact=[B1]。
      expect(
        f.flow.settleOrder({
          orderId: sold100.orderId,
          closedReason: 'CANCELED',
          source: 'WS',
          symbol: sold100.symbol,
          side: 'SELL',
          monitorSymbol: monitor.monitorSymbol,
          isLongSymbol: true,
          isProtectiveLiquidation: false,
          executedPrice: sold100.executedPrice,
          executedAmount: sold100.executedAmount,
          executedQuantity: sold100.executedQuantity,
          executedTimeMs: sold100.executionTimeMs,
          orderUpdatedAtMs: sold100.updatedAtMs,
        }),
      ).toMatchObject({ handled: true, relatedBuyOrderIds: ['B2'] });

      expect(f.recorder.getCostBasis('BULL.HK', true)).toEqual({
        costAmount: '400',
        quantity: 200,
      });

      if (delivery === 'ONLINE') commit(f, sold200);
      else await baseline(f, [b1, b2, sold200]);

      const daily = sellDelay === 0 ? '-200' : '0';
      const r1 = sellDelay === 0 ? '600' : '400';
      assertMixedProjection(f, 'B2', '400', daily, r1, 200);
      await baseline(f, [b1, b2, sold200]);
      assertMixedProjection(f, 'B2', '400', daily, r1, 200);
    });
  }
}

for (const delivery of ['ONLINE', 'ACTIVATION'] as const)
  for (const growth of [false, true])
    test(`mixed ${delivery}: ${growth ? 'cumulative SELL growth' : 'first SELL after historical baseline'} preserves admitted online BUY`, async () => {
      const f = fixture();
      const b1 = await observation('B1', 'BUY', 100, '1', 1000);
      const b2 = await observation('B2', 'BUY', 100, '2', 1100);
      const b3 = await observation('B3', 'BUY', 100, '3', 1200);
      const firstSell = await observation('S', 'SELL', 100, '1.5', 1100);
      const sell = growth ? await observation('S', 'SELL', 200, '1.5', 1200) : firstSell;
      if (growth) {
        for (const order of [b1, b2, firstSell, b3]) commit(f, order);
      } else {
        await baseline(f, [b1]);
        commit(f, b2);
      }

      const buys = growth ? [b1, b2, b3] : [b1, b2];
      if (delivery === 'ONLINE') commit(f, sell);
      else await baseline(f, [...buys, sell]);

      const id = growth ? 'B3' : 'B2';
      const cost = growth ? '300' : '200';
      const loss = growth ? '-300' : '-150';
      const r1 = growth ? '600' : '350';
      assertMixedProjection(f, id, cost, loss, r1);
      for (let repeat = 0; repeat < 2; repeat++) {
        await baseline(f, [...buys, sell]);
        assertMixedProjection(f, id, cost, loss, r1);
      }

      // 同量金额/revision 修订不移动消费位置；broker 新更新时间不是新增成交时间。
      const revised = await observation('S', 'SELL', sell.executedQuantity, '1.6', 1400);
      if (delivery === 'ONLINE') commit(f, revised);
      else await baseline(f, [...buys, revised]);

      const revisedLoss = growth ? '-280' : '-140';
      const revisedR1 = growth ? '580' : '340';
      assertMixedProjection(f, id, cost, revisedLoss, revisedR1);
      expect(f.recorder.getExecutionFact('S')?.executionTimeMs).toBe(sell.executionTimeMs);
      await baseline(f, [...buys, revised]);
      assertMixedProjection(f, id, cost, revisedLoss, revisedR1);

      const revisedBuy = await observation(id, 'BUY', 100, growth ? '3.5' : '2.5', 1500);
      const revisedBuys = buys.map((order) => (order.orderId === id ? revisedBuy : order));
      if (delivery === 'ONLINE') commit(f, revisedBuy);
      else await baseline(f, [...revisedBuys, revised]);

      const finalCost = growth ? '350' : '250';
      const finalLoss = growth ? '-330' : '-190';
      const finalR1 = growth ? '680' : '440';
      assertMixedProjection(f, id, finalCost, finalLoss, finalR1);
      await baseline(f, [...revisedBuys, revised]);
      assertMixedProjection(f, id, finalCost, finalLoss, finalR1);

      // 只有显式 REBUILD 重新建立全历史范围；等时 BUY 仍按原严格时间解释，Daily 不变。
      await baseline(f, [...revisedBuys, revised], 'REBUILD');
      expect(f.recorder.getBuyOrdersForSymbol('BULL.HK', true)).toEqual([]);
      expect(f.recorder.getCostBasis('BULL.HK', true)).toBeNull();
      expect(f.daily.getLossOffset('LONG')).toBe(finalLoss);
      const rebuiltRisk = assertRiskProjection(f, growth ? '330' : '190', 0);
      expect(rebuiltRisk.checkUnrealizedLoss('BULL.HK', '1', true).shouldLiquidate).toBe(false);
      expect(
        resolveSellQuantityBySmartClose({
          orderRecorder: f.recorder,
          currentPrice: '4',
          availableQuantity: 100,
          direction: 'LONG',
          symbol: 'BULL.HK',
          smartCloseTimeoutMinutes: null,
          nowMs: T + 2000,
          isHalfDay: false,
          tradingCalendarSnapshot: new Map(),
        }),
      ).toMatchObject({ quantity: null, shouldHold: true, relatedBuyOrderIds: [] });
    });

for (const mode of ['ONLINE', 'ACTIVATION', 'REBUILD'] as const)
  test(`M3 ${mode}: equal-time projection respects online admission or explicit historical partition`, async () => {
    const buy = await observation('buy', 'BUY', 100, '1', 0);
    const sell = await observation('sell', 'SELL', 100, '0.9', 0);
    for (const orders of [
      [buy, sell],
      [sell, buy],
    ]) {
      const f = fixture();
      if (mode === 'ONLINE') for (const o of orders) commit(f, o);
      else {
        await baseline(f, orders, mode);
      }

      // 在线晚到 BUY 不追加入已执行 SELL；历史仍严格分区。Daily 始终沿用原历史日损 -10。
      const retainsBuy = mode === 'ONLINE' && orders[0] === sell;
      const expectedCost = retainsBuy ? { costAmount: '100', quantity: 100 } : null;
      expect(f.recorder.getBuyOrdersForSymbol('BULL.HK', true).map((o) => o.orderId)).toEqual(
        retainsBuy ? ['buy'] : [],
      );
      expect(f.recorder.getCostBasis('BULL.HK', true)).toEqual(expectedCost);
      expect(f.daily.getLossOffset('LONG')).toBe('-10');
      assertRiskProjection(f, retainsBuy ? '110' : '10', retainsBuy ? 100 : 0);
      const before = f.snapshot.getView().token;
      for (const o of orders) commit(f, o);

      expect(f.recorder.getCostBasis('BULL.HK', true)).toEqual(expectedCost);
      expect(f.daily.getLossOffset('LONG')).toBe('-10');
      assertRiskProjection(f, retainsBuy ? '110' : '10', retainsBuy ? 100 : 0);
      expect(f.snapshot.getView().token).toEqual(before);
    }
  });

test('M3 multi-SELL replays online admission while historical O and Daily remain order-independent', async () => {
  const a = await observation('low', 'BUY', 100, '1', 0);
  const b = await observation('high', 'BUY', 100, '2', 100);
  const firstSell = await observation('sell1', 'SELL', 100, '0.9', 200);
  const tie = await observation('tie', 'BUY', 100, '3', 200);
  const later = await observation('later', 'BUY', 100, '4', 400);
  const secondSell = await observation('sell2', 'SELL', 50, '1', 300);
  for (const { orders, ids, cost, r1 } of [
    {
      orders: [a, b, firstSell, tie, secondSell, later],
      ids: ['high', 'tie', 'later'],
      cost: '900',
      r1: '1160',
    },
    {
      orders: [secondSell, later, tie, firstSell, b, a],
      ids: ['later', 'high', 'low'],
      cost: '700',
      r1: '960',
    },
    {
      orders: [tie, firstSell, a, later, secondSell, b],
      ids: ['low', 'later', 'high'],
      cost: '700',
      r1: '960',
    },
  ]) {
    const online = fixture();
    for (const o of orders) commit(online, o);

    expect(online.recorder.getBuyOrdersForSymbol('BULL.HK', true).map((o) => o.orderId)).toEqual(
      ids,
    );

    expect(online.recorder.getCostBasis('BULL.HK', true)).toEqual({
      costAmount: cost,
      quantity: 300,
    });
    expect(online.daily.getLossOffset('LONG')).toBe('-260');
    assertRiskProjection(online, r1, 300);

    const history = fixture();
    await baseline(history, orders);
    expect(history.recorder.getBuyOrdersForSymbol('BULL.HK', true).map((o) => o.orderId)).toEqual([
      'later',
      'high',
    ]);

    expect(history.recorder.getCostBasis('BULL.HK', true)).toEqual({
      costAmount: '600',
      quantity: 200,
    });
    // 历史仍排除等时 tie：BUY=1000, SELL=140, open=600，realized=-260。
    expect(history.daily.getLossOffset('LONG')).toBe('-260');
    assertRiskProjection(history, '860', 200);
  }
});

test('M3 online admission preserves active clear scope and related-buy deduction across revisions/new quantity', async () => {
  const f = createExecutionFixture({ nowMs: T });
  const cleared = await observation('cleared', 'BUY', 100, '0.1', 0);
  commit(f, cleared);
  f.recorder.clearBuyOrders('BULL.HK', true);
  const related = await observation('related', 'BUY', 100, '2', 100);
  const cheap = await observation('cheap', 'BUY', 100, '0.5', 150);
  const tie = await observation('tie', 'BUY', 100, '1', 200);
  const sell = await observation('sell', 'SELL', 100, '0.9', 200);
  commit(f, related);
  commit(f, cheap);
  commit(f, sell, ['related']);
  commit(f, tie);
  expect(f.recorder.getBuyOrdersForSymbol('BULL.HK', true).map((o) => o.orderId)).toEqual([
    'cheap',
    'tie',
  ]);
  commit(f, { ...cleared, executedPrice: '0.2', executedAmount: '20', updatedAtMs: T + 250 });
  commit(f, { ...related, executedPrice: '3', executedAmount: '300', updatedAtMs: T + 260 });
  expect(f.recorder.getCostBasis('BULL.HK', true)).toEqual({ costAmount: '150', quantity: 200 });
  commit(f, await observation('cleared', 'BUY', 200, '0.2', 300));
  expect(f.recorder.getCostBasis('BULL.HK', true)).toEqual({ costAmount: '170', quantity: 300 });
  expect(f.recorder.getBuyOrdersForSymbol('BULL.HK', true).map((o) => o.orderId)).toEqual([
    'cheap',
    'tie',
    'cleared',
  ]);

  expect(f.recorder.getExecutionFact('related')).toMatchObject({ cumulativeAmount: '300' });
});
