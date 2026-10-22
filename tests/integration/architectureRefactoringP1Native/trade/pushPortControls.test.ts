import { expect, test } from 'bun:test';
import { createBrokerIngressFixture } from './brokerIngressFixture.js';

const input = {
  orderId: 'PUSH',
  symbol: 'BULL.HK',
  stockName: 'SDK',
  remark: '',
  side: 'SELL' as const,
  status: 'PartialFilled' as const,
  quantity: '100',
  executedQuantity: '10',
  submittedPrice: '9.2',
  executedPrice: '9.2',
  submittedAtMs: 1700000000000,
  updatedAtMs: 1700000000200,
};

test('push/query share one mapper fact without any execution IO capability', async () => {
  const f = await createBrokerIngressFixture(input);
  expect(f.queryObservation).toMatchObject({
    executionSide: 'SELL',
    executionStatus: 'PARTIAL',
    executionPhase: 'OPEN',
    executedQuantity: 10,
    executedAmount: '92',
    // 订单级观察时间代理：正成交取原始 updatedAt，不是逐笔执行时间。
    executionTimeMs: 1700000000200,
    updatedAtMs: 1700000000200,
  });
  expect('executionLedgerPort' in f).toBe(false);
  expect('setExecutionReplies' in f).toBe(false);
});

test('actual callback registration emits lazy decoder; internal SDK getter fault occurs at decode with original identity', async () => {
  const f = await createBrokerIngressFixture(input);
  let callbacks = 0;
  const cause = new RangeError('native quantity getter');
  f.createPushPort().setOnOrderChanged((error, decoder) => {
    callbacks++;
    expect(error).toBeNull();
    expect(() => decoder.decode()).toThrow(cause);
  });
  f.setPushExecutedQuantityGetterFailure(cause);
  expect(callbacks).toBe(0);
  f.emitOrderChanged();
  expect(callbacks).toBe(1);
});

test('nullable raw SDK price and invalid revision controls are lazy mapper-stage faults, not setup throws', async () => {
  const f = await createBrokerIngressFixture(input);
  f.setPushExecutedPriceMissing();
  f.createPushPort().setOnOrderChanged((_error, decoder) => {
    expect(() => decoder.decode()).toThrow(
      '[orderMapper] invalid cumulative execution quantity/price',
    );
  });
  f.emitOrderChanged();
  const invalidRevision = await createBrokerIngressFixture(input);
  invalidRevision.setPushUpdatedAtMs(Number.NaN);
  invalidRevision.createPushPort().setOnOrderChanged((_error, decoder) => {
    expect(() => decoder.decode()).toThrow('[orderMapper] invalid updatedAt');
  });
  invalidRevision.emitOrderChanged();
  const unknownSide = await createBrokerIngressFixture(input);
  unknownSide.setPushSideUnknown();
  unknownSide.createPushPort().setOnOrderChanged((_error, decoder) => {
    expect(() => decoder.decode()).toThrow('[orderMapper] unknown SDK execution side');
  });
  unknownSide.emitOrderChanged();
});

test('explicit native price/quantity controls reject only at registered callback decode', async () => {
  const f = await createBrokerIngressFixture(input);
  let callbacks = 0;
  f.createPushPort().setOnOrderChanged((_error, decoder) => {
    callbacks++;
    expect(() => decoder.decode()).toThrow(TypeError);
  });
  f.setPushExecutedPriceText('0');
  expect(callbacks).toBe(0);
  f.emitOrderChanged();
  f.setPushExecutedPriceText('9.2');
  f.setPushExecutedQuantityText('101');
  f.emitOrderChanged();
  f.setPushExecutedQuantityMissing();
  f.emitOrderChanged();
  expect(callbacks).toBe(3);
});

test('dynamic frames reuse one registered native context and decode each original id/phase/revision; invalid revision fails in callback', async () => {
  const f = await createBrokerIngressFixture(input);
  const observations: Array<{ orderId: string; phase: string; revision: number }> = [];
  f.createPushPort().setOnOrderChanged((_error, decoder) => {
    const mapped = decoder.decode();
    if (mapped === null) throw new Error('HK push sample must decode');

    observations.push({
      orderId: mapped.orderId,
      phase: mapped.executionPhase,
      revision: mapped.updatedAtMs,
    });
  });

  f.emitOrderChangedFrame({
    ...input,
    orderId: 'FIRST',
    status: 'New',
    executedQuantity: '0',
    executedPrice: '0',
  });

  f.emitOrderChangedFrame({
    ...input,
    orderId: 'SECOND',
    status: 'Canceled',
    executedQuantity: '0',
    executedPrice: '0',
    updatedAtMs: 1700000000300,
  });

  expect(observations).toEqual([
    { orderId: 'FIRST', phase: 'OPEN', revision: 1700000000200 },
    { orderId: 'SECOND', phase: 'TERMINAL', revision: 1700000000300 },
  ]);

  expect(() => {
    f.emitOrderChangedFrame({ ...input, updatedAtMs: Number.NaN });
  }).toThrow('[orderMapper] invalid updatedAt');
  expect(observations).toHaveLength(2);
});

test('explicit non-HK push decodes to null and never enters management; bad symbol structure throws', async () => {
  const f = await createBrokerIngressFixture(input);
  const decoded: Array<unknown> = [];
  f.createPushPort().setOnOrderChanged((_error, decoder) => {
    decoded.push(decoder.decode());
  });

  f.emitOrderChangedFrame({ ...input, orderId: 'US-ODD', symbol: 'AAPL.US', quantity: '1.5' });
  expect(decoded).toEqual([null]);

  // 坏 symbol 结构不得降级为“非HK”静默丢弃：保留原始内部错误。
  expect(() => {
    f.emitOrderChangedFrame({ ...input, symbol: 'BROKEN' });
  }).toThrow(/symbol structure/);
  expect(decoded).toEqual([null]);
});
