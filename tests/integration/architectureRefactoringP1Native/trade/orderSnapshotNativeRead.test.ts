/** 真实 native snapshot port→recorder→重建提交链路；SDK DTO/context 只由 infra fixture 持有。 */
import { expect, test } from 'bun:test';
import { createLoggerDouble, createRateLimiterDouble } from '../../../helpers/testDoubles.js';
import { createBrokerIngressFixture } from './brokerIngressFixture.js';

const frame = {
  orderId: 'NATIVE-BUY',
  symbol: 'BULL.HK',
  stockName: 'HSI RC',
  side: 'BUY' as const,
  status: 'Filled' as const,
  orderType: 'ELO' as const,
  remark: 'QuantDemo|PL',
  quantity: '100',
  executedQuantity: '100',
  submittedPrice: '1.000000000000000001',
  executedPrice: '1.2345678901234567890123456789',
  submittedAtMs: 1000,
  updatedAtMs: 3000,
};

test('真实 recorder 读取完整 today 覆盖的正成交终态，只在显式 rebuild 后提交精确成本', async () => {
  const native = await createBrokerIngressFixture(frame);
  native.setOrderSnapshotReplies([{ ...frame, updatedAtMs: 9000 }], [frame]);
  native.setOrderSnapshotExecutedPriceMissing('history');
  native.setOrderSnapshotUpdatedAtAbsent('history', 'OMITTED');
  let refreshNeeds = 0;
  let throttles = 0;
  const recorder = native.createRecorder({
    logger: createLoggerDouble(),
    rateLimiter: createRateLimiterDouble({
      onThrottle: () => {
        throttles += 1;
      },
    }),
    settlementRefreshNeedRecorder: {
      recordSettlementRefreshNeed: () => {
        refreshNeeds += 1;
      },
    },
  });
  const orders = await recorder.fetchAllOrdersFromAPI();
  expect(orders).toMatchObject([
    {
      orderId: frame.orderId,
      executedAmount: '123.45678901234567890123456789',
      executionTimeMs: 3000,
      updatedAtMs: 3000,
    },
  ]);
  expect(recorder.getBuyOrdersForSymbol(frame.symbol, true)).toEqual([]);
  expect(recorder.getExecutionFact(frame.orderId)).toBeNull();
  expect(
    recorder.commitRebuildSnapshot(
      [{ symbol: frame.symbol, isLongSymbol: true }],
      orders,
      () => true,
      'REBUILD',
    ),
  ).toEqual({ status: 'COMMITTED' });
  expect(recorder.getCostBasis(frame.symbol, true)).toEqual({
    quantity: 100,
    costAmount: '123.45678901234567890123456789',
  });
  expect(native.orderSnapshotReadCounts()).toEqual({ history: 1, today: 1 });
  expect(throttles).toBe(2);
  expect(refreshNeeds).toBe(0);
  expect(native.nativeMutations()).toEqual([]);
});

test('真实 recorder 的后续读取失败保留原错误及已提交列表，不发布坏批次的成功前缀', async () => {
  const native = await createBrokerIngressFixture(frame);
  native.setOrderSnapshotReplies([], [frame]);
  const recorder = native.createRecorder({
    logger: createLoggerDouble(),
    rateLimiter: createRateLimiterDouble(),
    settlementRefreshNeedRecorder: { recordSettlementRefreshNeed: () => {} },
  });
  const initial = await recorder.fetchAllOrdersFromAPI();
  recorder.commitRebuildSnapshot(
    [{ symbol: frame.symbol, isLongSymbol: true }],
    initial,
    () => true,
    'REBUILD',
  );
  const before = recorder.getBuyOrdersForSymbol(frame.symbol, true);
  native.setOrderSnapshotReplies(
    [],
    [
      { ...frame, orderId: 'NEW-GOOD' },
      { ...frame, orderId: 'NEW-BAD' },
    ],
  );
  const failure = new TypeError('native selected order provenance');
  native.setOrderSnapshotGetterFailure('today', 'NEW-BAD', 'remark', failure);
  expect(await recorder.fetchAllOrdersFromAPI().catch((error: unknown) => error)).toBe(failure);
  expect(recorder.getBuyOrdersForSymbol(frame.symbol, true)).toEqual(before);
  expect(recorder.getExecutionFact('NEW-GOOD')).toBeNull();
  expect(recorder.getExecutionFact('NEW-BAD')).toBeNull();
  expect(native.orderSnapshotReadCounts()).toEqual({ history: 2, today: 2 });
  expect(native.nativeMutations()).toEqual([]);
});
