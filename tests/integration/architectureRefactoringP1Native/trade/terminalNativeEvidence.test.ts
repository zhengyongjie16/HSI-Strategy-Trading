import { expect, test } from 'bun:test';
import { mergeMonotonicOrderFact } from '../../../../src/domain/order/orderFactMerge.js';
import type { KnownOrderFact } from '../../../../src/domain/order/types.js';
import type { OrderFact } from '../../../../src/types/trade.js';
import { createBrokerIngressFixture } from './brokerIngressFixture.js';

/** 已确认经济事实：本 fixture 的订单带价，金额不得缺失。 */
function knownFrom(order: OrderFact): KnownOrderFact {
  if (order.executedAmount === null)
    throw new Error('fixture order must carry an executed amount');

  return {
    orderId: order.orderId,
    symbol: order.symbol,
    executionSide: order.executionSide,
    executionPhase: order.executionPhase,
    submittedQuantity: order.quantity,
    status: order.status,
    executedQuantity: order.executedQuantity,
    executedAmount: order.executedAmount,
    executedPrice: order.executedPrice,
    lastExecutedTimeMs: order.executionTimeMs,
    lastOrderUpdateAtMs: order.updatedAtMs,
  };
}

const frame = {
  orderId: 'TERMINAL',
  symbol: 'BULL.HK',
  stockName: 'SDK',
  remark: '',
  side: 'SELL' as const,
  status: 'PartialFilled' as const,
  quantity: '100',
  executedQuantity: '40',
  submittedPrice: '1',
  executedPrice: '1',
  submittedAtMs: 50,
  updatedAtMs: 150,
};

test('registered SDK terminal callback with missing raw price reaches the shared merge and keeps confirmed economics', async () => {
  const f = await createBrokerIngressFixture(frame);
  const original = f.queryObservation;
  const known = knownFrom(original);
  const results: Array<ReturnType<typeof mergeMonotonicOrderFact>> = [];
  const mappedFacts: string[] = [];
  let callbacks = 0;
  f.createPushPort().setOnOrderChanged((_error, decoder) => {
    callbacks++;
    const mapped = decoder.decode();
    if (mapped === null) throw new Error('HK push sample must decode');

    mappedFacts.push(mapped.executionStatus);
    results.push(
      mergeMonotonicOrderFact(known, {
        status: mapped.status,
        executionPhase: mapped.executionPhase,
        executedQuantity: mapped.executedQuantity,
        executedAmount: mapped.executedAmount,
        executedPrice: mapped.executedPrice,
        executedTimeMs: mapped.executionTimeMs,
        updatedAtMs: mapped.updatedAtMs,
      }),
    );
  });

  // 终态零价是显式缺价：合并保留已确认经济事实，既不拒绝也不伪造新价。
  f.emitOrderChangedFrame({ ...frame, status: 'Canceled', executedPrice: '0', updatedAtMs: 200 });
  expect(results[0]).toMatchObject({
    executionPhase: 'TERMINAL',
    executedQuantity: 40,
    executedAmount: '40',
    executedPrice: '1',
  });

  f.emitOrderChangedFrame({ ...frame, status: 'Filled', executedPrice: '0', updatedAtMs: 200 });
  expect(mappedFacts).toEqual(['PARTIAL', 'FILLED']);
  expect(callbacks).toBe(2);
  expect(results).toHaveLength(2);
});

test('increment terminal observation still requires its own raw price; missing price cannot invent economics', async () => {
  const f = await createBrokerIngressFixture(frame);
  const original = f.queryObservation;
  let rejection: unknown = null;
  f.createPushPort().setOnOrderChanged((_error, decoder) => {
    const mapped = decoder.decode();
    if (mapped === null) throw new Error('HK push sample must decode');

    try {
      mergeMonotonicOrderFact(
        knownFrom(original),
        {
          status: mapped.status,
          executionPhase: mapped.executionPhase,
          executedQuantity: mapped.executedQuantity + 10,
          executedAmount: mapped.executedAmount,
          executedPrice: mapped.executedPrice,
          executedTimeMs: mapped.executionTimeMs,
          updatedAtMs: mapped.updatedAtMs,
        },
      );
    } catch (error) {
      rejection = error;
    }
  });

  f.emitOrderChangedFrame({
    ...frame,
    status: 'Canceled',
    executedQuantity: '50',
    executedPrice: '0',
    updatedAtMs: 200,
  });
  expect(rejection).toBeInstanceOf(Error);
});
