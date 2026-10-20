/** O/Daily 共用原 SELL 时间区间，并经真实 RiskChecker 闭合 R1/N1：同毫秒排列、clear 与关联扣减回归。 */

import { expect, test } from 'bun:test';
import { createRiskChecker } from '../../src/domain/risk/index.js';
import { createPositionLimitChecker } from '../../src/domain/risk/positionLimitChecker.js';
import { createUnrealizedLossChecker } from '../../src/domain/risk/unrealizedLossChecker.js';
import { createWarrantRiskChecker } from '../../src/domain/risk/warrantRiskChecker.js';
import type { OrderFact } from '../../src/types/trade.js';
import { createExecutionFixture } from '../application/orderTracking/recorder/executionFixture.js';
import { createMonitorConfigDouble } from '../helpers/testDoubles.js';
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
) {
  const native = await createBrokerIngressFixture({
    orderId: id,
    symbol: 'BULL.HK',
    stockName: 'HSI RC',
    remark: '',
    side,
    status: 'Filled',
    quantity: String(quantity),
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

function baseline(f: ReturnType<typeof createExecutionFixture>, orders: ReadonlyArray<OrderFact>) {
  const prepared = f.daily.prepareRecalculationFromAllOrders(
    toRecalculationOrders(orders),
    monitor,
    new Date(T),
  );
  expect(
    f.recorder.commitRebuildSnapshot(
      [{ symbol: 'BULL.HK', isLongSymbol: true }],
      orders,
      prepared.isCurrent,
      'ACTIVATION',
    ).status,
  ).toBe('COMMITTED');
  f.daily.publishRecalculation(prepared);
}

/** 真实金融消费者读取当前 O 成本与 Daily offset；prepare 不发布，publish 后 cache/metrics 使用确切 R1/N1。 */
function assertRiskProjection(
  f: ReturnType<typeof createExecutionFixture>,
  expectedR1: string,
  expectedN1: number,
): void {
  const unrealizedLossChecker = createUnrealizedLossChecker({
    maxUnrealizedLossPerSymbol: null,
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
}

for (const mode of ['ONLINE', 'ACTIVATION', 'REBUILD'] as const)
  test(`M3 ${mode}: equal-millisecond BUY/SELL order does not change original empty projection or Daily loss`, async () => {
    const buy = await observation('buy', 'BUY', 100, '1', 0);
    const sell = await observation('sell', 'SELL', 100, '0.9', 0);
    for (const orders of [
      [buy, sell],
      [sell, buy],
    ]) {
      const f = createExecutionFixture({ nowMs: T });
      if (mode === 'ONLINE') for (const o of orders) commit(f, o);
      else {
        baseline(f, orders);
        if (mode === 'REBUILD')
          expect(
            f.recorder.commitRebuildSnapshot(
              [{ symbol: 'BULL.HK', isLongSymbol: true }],
              orders,
              () => true,
              'REBUILD',
            ).status,
          ).toBe('COMMITTED');
      }

      // HEAD 严格 < SELL 与 > SELL：等毫秒 BUY 不属于任何存活区间；独立金额 oracle 90-100=-10。
      expect(f.recorder.getBuyOrdersForSymbol('BULL.HK', true)).toEqual([]);
      expect(f.recorder.getCostBasis('BULL.HK', true)).toBeNull();
      expect(f.daily.getLossOffset('LONG')).toBe('-10');
      // 无幸存 BUY 也不能丢掉已实现日损：R1=0-(-10)=10，N1=0。
      assertRiskProjection(f, '10', 0);
      const before = f.snapshot.getView().token;
      for (const o of orders) commit(f, o);

      expect(f.recorder.getCostBasis('BULL.HK', true)).toBeNull();
      expect(f.daily.getLossOffset('LONG')).toBe('-10');
      assertRiskProjection(f, '10', 0);
      expect(f.snapshot.getView().token).toEqual(before);
    }
  });

test('M3 multi-SELL intervals and late M0 BUY use identical O/Daily history regardless BUY/SELL arrival order', async () => {
  const a = await observation('low', 'BUY', 100, '1', 0);
  const b = await observation('high', 'BUY', 100, '2', 100);
  const firstSell = await observation('sell1', 'SELL', 100, '0.9', 200);
  const tie = await observation('tie', 'BUY', 100, '3', 200);
  const later = await observation('later', 'BUY', 100, '4', 400);
  const secondSell = await observation('sell2', 'SELL', 50, '1', 300);
  for (const orders of [
    [a, b, firstSell, tie, secondSell, later],
    [secondSell, later, tie, firstSell, b, a],
    [tie, firstSell, a, later, secondSell, b],
  ]) {
    const f = createExecutionFixture({ nowMs: T });
    for (const o of orders) commit(f, o);

    expect(f.recorder.getBuyOrdersForSymbol('BULL.HK', true).map((o) => o.orderId)).toEqual([
      'later',
      'high',
    ]);
    expect(f.recorder.getCostBasis('BULL.HK', true)).toEqual({ costAmount: '600', quantity: 200 });
    // BUY=1000, SELL=140, open=600：同毫秒 tie 按原规则排除，realized=-260。
    expect(f.daily.getLossOffset('LONG')).toBe('-260');
    // 原过滤结果成本 600 加上已实现亏损 260：真实风险缓存 R1=860，N1=200。
    assertRiskProjection(f, '860', 200);
  }
});

test('M3 shared timing preserves active clear scope and exact related-buy deduction across revisions/new quantity', async () => {
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
  ]);
  commit(f, { ...cleared, executedPrice: '0.2', executedAmount: '20', updatedAtMs: T + 250 });
  commit(f, { ...related, executedPrice: '3', executedAmount: '300', updatedAtMs: T + 260 });
  expect(f.recorder.getCostBasis('BULL.HK', true)).toEqual({ costAmount: '50', quantity: 100 });
  commit(f, await observation('cleared', 'BUY', 200, '0.2', 300));
  expect(f.recorder.getCostBasis('BULL.HK', true)).toEqual({ costAmount: '70', quantity: 200 });
  expect(f.recorder.getBuyOrdersForSymbol('BULL.HK', true).map((o) => o.orderId)).toEqual([
    'cleared',
    'cheap',
  ]);

  expect(f.recorder.getExecutionFact('related')).toMatchObject({ cumulativeAmount: '300' });
});
