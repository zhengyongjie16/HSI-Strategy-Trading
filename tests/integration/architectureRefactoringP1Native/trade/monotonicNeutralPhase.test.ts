import { expect, test } from 'bun:test';
import { mergeMonotonicOrderFact } from '../../../../src/domain/order/orderFactMerge.js';
import type { KnownOrderFact, OrderObservedFact } from '../../../../src/domain/order/types.js';
import type { OrderFact } from '../../../../src/types/trade.js';
import { createBrokerIngressFixture } from './brokerIngressFixture.js';

const input = {
  orderId: 'PHASE',
  symbol: 'BULL.HK',
  stockName: 'SDK',
  remark: '',
  side: 'SELL' as const,
  status: 'PartialFilled' as const,
  quantity: '100',
  executedQuantity: '40',
  submittedPrice: '1',
  executedPrice: '1.02',
  submittedAtMs: 1700000000000,
  updatedAtMs: 1700000000200,
};
function known(order: OrderFact): KnownOrderFact {
  if (order.executedAmount === null) throw new Error('fixture order must carry an executed amount');

  return {
    orderId: order.orderId,
    symbol: order.symbol,
    executionSide: order.executionSide,
    executionPhase: order.executionPhase,
    submittedQuantity: order.quantity,
    status: order.status,
    executedQuantity: order.executedQuantity,
    executedPrice: order.executedPrice,
    executedAmount: order.executedAmount,
    lastExecutedTimeMs: order.executionTimeMs,
    lastOrderUpdateAtMs: order.updatedAtMs,
  };
}

function observed(order: OrderFact): OrderObservedFact {
  return {
    status: order.status,
    executionPhase: order.executionPhase,
    executedQuantity: order.executedQuantity,
    executedPrice: order.executedPrice,
    executedAmount: order.executedAmount,
    executedTimeMs: order.executionTimeMs,
    updatedAtMs: order.updatedAtMs,
  };
}

test('actual mapper phase admits same revision OPEN→TERMINAL using the order observation time proxy', async () => {
  const open = await createBrokerIngressFixture(input);
  const terminal = await createBrokerIngressFixture({ ...input, status: 'Canceled' });
  expect(
    mergeMonotonicOrderFact(known(open.queryObservation), observed(terminal.queryObservation)),
  ).toMatchObject({
    executionPhase: 'TERMINAL',
    executedQuantity: 40,
    executedAmount: '40.8',
    executedTimeMs: 1700000000200,
    updatedAtMs: 1700000000200,
  });
});

test('samebroker late weaker OPEN and no-economic-growth OPEN after terminal discard only at ingress; conflicts remain strict', async () => {
  const strongest = await createBrokerIngressFixture(input);
  const lower = await createBrokerIngressFixture({
    ...input,
    executedQuantity: '20',
    executedPrice: '1.01',
  });
  expect(
    mergeMonotonicOrderFact(known(strongest.queryObservation), observed(lower.queryObservation)),
  ).toBeNull();
  const zeroLate = await createBrokerIngressFixture({
    ...input,
    status: 'New',
    executedQuantity: '0',
    executedPrice: '0',
  });
  expect(
    mergeMonotonicOrderFact(known(strongest.queryObservation), observed(zeroLate.queryObservation)),
  ).toBeNull();
  expect(strongest.queryObservation.executionTimeMs).toBe(1700000000200);
  const terminal = await createBrokerIngressFixture({
    ...input,
    status: 'Canceled',
    executedQuantity: '0',
    executedPrice: '0',
  });
  const lateOpen = await createBrokerIngressFixture({
    ...input,
    status: 'New',
    executedQuantity: '0',
    executedPrice: '0',
    updatedAtMs: 1700000000300,
  });
  expect(
    mergeMonotonicOrderFact(known(terminal.queryObservation), observed(lateOpen.queryObservation)),
  ).toBeNull();

  // 同 revision 下累计量更小但金额冲突仍是事实冲突，必须严格拒绝。
  expect(() =>
    mergeMonotonicOrderFact(known(strongest.queryObservation), {
      ...observed(lower.queryObservation),
      executedAmount: '999',
    }),
  ).toThrow();

  expect(() =>
    mergeMonotonicOrderFact(known(strongest.queryObservation), {
      ...observed(strongest.queryObservation),
      executedAmount: '99',
    }),
  ).toThrow();

  expect(() =>
    mergeMonotonicOrderFact(known(strongest.queryObservation), {
      ...observed(strongest.queryObservation),
      executedQuantity: 41,
      executedTimeMs: null,
    }),
  ).toThrow();
});

/** 合并层对缺失/未知 phase 的拒绝边界归 W2；此处只固定 mapper 是 phase 的唯一来源。 */
test('mapper is the only neutral phase source: lifecycle statuses map to OPEN/TERMINAL, never defaults', async () => {
  for (const status of ['Filled', 'Canceled', 'Rejected', 'Expired'] as const) {
    const terminal = await createBrokerIngressFixture({ ...input, status });
    expect(terminal.queryObservation.executionPhase).toBe('TERMINAL');
    expect(terminal.pushObservation.executionPhase).toBe('TERMINAL');
  }

  for (const status of ['New', 'PartialFilled', 'WaitToCancel', 'PendingReplace'] as const) {
    const open = await createBrokerIngressFixture({ ...input, status });
    expect(open.queryObservation.executionPhase).toBe('OPEN');
    expect(open.pushObservation.executionPhase).toBe('OPEN');
  }
});
