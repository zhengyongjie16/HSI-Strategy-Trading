/** 真实离线 SDK callback：正量终态首次缺价即停在 mapper，完整终态才进入共享累计裁决。 */
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

test.each([null, '0'] as const)(
  'registered SDK terminal callback rejects raw price %s on its first decode, before merge',
  async (price) => {
    const f = await createBrokerIngressFixture({ ...frame, status: 'Filled' });
    const results: OrderFact[] = [];
    let callbacks = 0;
    f.createPushPort().setOnOrderChanged((_error, decoder) => {
      callbacks++;
      const mapped = decoder.decode();
      if (mapped !== null) results.push(mapped);
    });

    if (price === null) f.setPushExecutedPriceMissing();
    else f.setPushExecutedPriceText(price);

    expect(() => { f.emitOrderChanged(); }).toThrow(TypeError);
    expect(callbacks).toBe(1);
    expect(results).toEqual([]);
    expect(f.nativeReadCounts()).toEqual({ cancel: 0, detail: 0 });
    expect(f.nativeMutations()).toEqual([]);
  },
);

test('complete registered terminal callback may revise amount without advancing known execution time', async () => {
  const f = await createBrokerIngressFixture(frame);
  const known = knownFrom(f.queryObservation);
  const results: Array<ReturnType<typeof mergeMonotonicOrderFact>> = [];
  f.createPushPort().setOnOrderChanged((_error, decoder) => {
    const mapped = decoder.decode();
    if (mapped === null) throw new Error('HK push sample must decode');

    results.push(mergeMonotonicOrderFact(known, {
      status: mapped.status,
      executionPhase: mapped.executionPhase,
      executedQuantity: mapped.executedQuantity,
      executedAmount: mapped.executedAmount,
      executedPrice: mapped.executedPrice,
      executedTimeMs: mapped.executionTimeMs,
      updatedAtMs: mapped.updatedAtMs,
    }));
  });
  f.emitOrderChangedFrame({ ...frame, status: 'Filled', executedPrice: '1.1', updatedAtMs: 200 });
  expect(results).toEqual([{
    status: 'FILLED',
    executionPhase: 'TERMINAL',
    executedQuantity: 40,
    executedAmount: '44',
    executedPrice: '1.1',
    executedTimeMs: 150,
    updatedAtMs: 200,
  }]);
});
