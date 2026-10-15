import { expect, test } from 'bun:test';
import { mergeMonotonicOrderFact } from '../../../../src/domain/order/orderFactMerge.js';
import type { KnownOrderFact, OrderObservedFact } from '../../../../src/domain/order/types.js';
import type { OrderFact } from '../../../../src/types/trade.js';
import { createBrokerIngressFixture } from './brokerIngressFixture.js';

const input = {
  orderId: 'PHASE',
  tradeId: 'T',
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
  executionTimeMs: 1700000000100,
  updatedAtMs: 1700000000200,
};
function known(order: OrderFact): KnownOrderFact {
  return {
    orderId: order.orderId,
    symbol: order.symbol,
    side: order.executionSide,
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

test('actual mapper phase admits same revision OPEN→TERMINAL without inventing economic T/revision', async () => {
  const open = await createBrokerIngressFixture(input);
  const terminal = await createBrokerIngressFixture({ ...input, status: 'Canceled' });
  expect(
    mergeMonotonicOrderFact(known(open.queryObservation), observed(terminal.queryObservation)),
  ).toMatchObject({
    executionPhase: 'TERMINAL',
    executedQuantity: 40,
    executedAmount: '40.8',
    executedTimeMs: 1700000000100,
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
    executionTimeMs: null,
  });
  expect(
    mergeMonotonicOrderFact(known(strongest.queryObservation), observed(zeroLate.queryObservation)),
  ).toBeNull();
  expect(strongest.queryObservation.executionTimeMs).toBe(1700000000100);
  const terminal = await createBrokerIngressFixture({
    ...input,
    status: 'Canceled',
    executedQuantity: '0',
    executedPrice: '0',
    executionTimeMs: null,
  });
  const lateOpen = await createBrokerIngressFixture({
    ...input,
    status: 'New',
    executedQuantity: '0',
    executedPrice: '0',
    executionTimeMs: null,
    updatedAtMs: 1700000000300,
  });
  expect(
    mergeMonotonicOrderFact(known(terminal.queryObservation), observed(lateOpen.queryObservation)),
  ).toBeNull();

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

test('missing or unknown neutral phase never defaults from SDK metadata or V1 unknown state', async () => {
  const f = await createBrokerIngressFixture(input);
  const missing = observed(f.queryObservation);
  Reflect.deleteProperty(missing, 'executionPhase');
  expect(() => mergeMonotonicOrderFact(known(f.queryObservation), missing)).toThrow(
    '缺少已验证中性executionPhase',
  );
  const unknown = observed(f.queryObservation);
  Reflect.set(unknown, 'executionPhase', 'UNKNOWN');
  expect(() => mergeMonotonicOrderFact(known(f.queryObservation), unknown)).toThrow(
    '缺少已验证中性executionPhase',
  );

  expect(() =>
    mergeMonotonicOrderFact(
      { ...known(f.queryObservation), executionPhase: null },
      observed(f.queryObservation),
    ),
  ).toThrow('缺少已验证中性executionPhase');
});
