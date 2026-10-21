/** SDK mapper 单测：保真原文/元数据/观察时间，正成交缺价与 FILLED 零量首次即拒绝。 */
import { expect, test } from 'bun:test';
import { Decimal, OrderSide, OrderStatus, OrderType } from 'longbridge';
import {
  mapBrokerOrder,
  mapBrokerOrderPush,
} from '../../../../src/infrastructure/longbridge/trade/orderMapper.js';
import type { BrokerOrderSdkFields } from '../../../../src/infrastructure/longbridge/trade/types.js';
import type { OrderPushDecoder } from '../../../../src/types/orderPushPorts.js';
import { createBrokerIngressFixture } from './brokerIngressFixture.js';

function sdkOrder(): BrokerOrderSdkFields {
  const signedZero = new Decimal('0');
  Object.defineProperty(signedZero, 'toString', { value: () => '-0' });
  return {
    orderId: 'order',
    symbol: 'A.HK',
    stockName: 'A',
    side: OrderSide.Buy,
    status: OrderStatus.Filled,
    orderType: OrderType.LO,
    remark: 'QuantDemo|PL',
    price: signedZero,
    quantity: new Decimal('100'),
    executedQuantity: new Decimal('100'),
    executedPrice: new Decimal('1.2345678901234567890123456789'),
    submittedAt: new Date(1000),
    updatedAt: new Date(3000),
  };
}

test('high significant SDK text maps by exact text; order observation time proxies the raw revision', () => {
  const mapped = mapBrokerOrder(sdkOrder());
  expect(mapped).toMatchObject({
    executedPrice: '1.2345678901234567890123456789',
    executedAmount: '123.45678901234567890123456789',
    price: '-0',
    executedQuantity: 100,
    executionStatus: 'FILLED',
    executionPhase: 'TERMINAL',
    remark: 'QuantDemo|PL',
    // 订单级观察时间代理：正成交取订单原始 updatedAt，不伪称逐笔执行时间。
    executionTimeMs: 3000,
    updatedAtMs: 3000,
  });
  expect(mapped.updatedAt?.getTime()).toBe(3000);
  expect(mapped.submittedAt.getTime()).toBe(1000);
});

test('every positive-quantity terminal requires its own positive price on the first mapping', () => {
  for (const status of [OrderStatus.Filled, OrderStatus.Canceled, OrderStatus.Expired, OrderStatus.Rejected]) {
    for (const executedPrice of [null, new Decimal('0')]) {
      expect(() => mapBrokerOrder({ ...sdkOrder(), status, executedPrice })).toThrow(
        'invalid cumulative execution quantity/price',
      );
    }
  }
});

test.each(['history', 'today'] as const)('the first bad positive terminal in %s rejects the snapshot without retry or later-read fallback', async (source) => {
  const frame = {
    orderId: 'SNAPSHOT-TERMINAL',
    symbol: 'BULL.HK',
    stockName: 'HSI',
    remark: '',
    side: 'BUY' as const,
    status: 'Filled' as const,
    quantity: '100',
    executedQuantity: '100',
    submittedPrice: '1',
    executedPrice: '1',
    submittedAtMs: 1000,
    updatedAtMs: 2000,
  };
  const native = await createBrokerIngressFixture(frame);
  const bad = { ...frame, executedPrice: '0' };
  native.setOrderSnapshotReplies(source === 'history' ? [bad] : [], source === 'today' ? [bad] : []);
  const port = native.ports.createOrderSnapshotReadPort({ rateLimiter: { throttle: async () => {} } });
  const error: unknown = await port.fetchSnapshots().catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(TypeError);
  expect(error).toMatchObject({ message: '[orderMapper] invalid cumulative execution quantity/price' });
  expect(native.orderSnapshotReadCounts()).toEqual({ history: 1, today: source === 'today' ? 1 : 0 });
});

test('open-phase positive quantity without price and negative prices stay structural errors', () => {
  for (const status of [OrderStatus.New, OrderStatus.PartialFilled]) {
    expect(() =>
      mapBrokerOrder({ ...sdkOrder(), status, executedPrice: null }),
    ).toThrow('invalid cumulative execution quantity/price');
  }

  expect(() =>
    mapBrokerOrder({ ...sdkOrder(), executedPrice: new Decimal('-1') }),
  ).toThrow('invalid cumulative execution quantity/price');

  expect(() =>
    mapBrokerOrder({
      ...sdkOrder(),
      status: OrderStatus.Canceled,
      executedQuantity: new Decimal('0'),
      executedPrice: new Decimal('-1'),
    }),
  ).toThrow('invalid cumulative execution quantity/price');
});

test('FILLED requires positive cumulative quantity for either side, regardless of price', () => {
  for (const side of [OrderSide.Buy, OrderSide.Sell]) {
    for (const executedPrice of [null, new Decimal('0'), new Decimal('1')]) {
      expect(() => mapBrokerOrder({
        ...sdkOrder(),
        side,
        executedQuantity: new Decimal('0'),
        executedPrice,
      })).toThrow('FILLED order requires positive cumulative execution quantity');
    }
  }
});

test.each([OrderStatus.New, OrderStatus.Canceled, OrderStatus.Rejected])(
  'non-FILLED status %s keeps a true zero amount and no observation time',
  (status) => {
    const initial = mapBrokerOrder({
      ...sdkOrder(),
      status,
      executedQuantity: new Decimal('0'),
      executedPrice: null,
      updatedAt: null,
    });
    expect(initial.executedAmount).toBe('0');
    expect(initial.executionTimeMs).toBeNull();
    expect(initial.updatedAtMs).toBe(1000);
    expect(initial.updatedAt).toBeNull();
  },
);

test('positive execution requires an independent broker revision', () => {
  expect(() => mapBrokerOrder({ ...sdkOrder(), updatedAt: null })).toThrow(
    'executed order lacks independent broker revision',
  );
});

test('executed quantity above submitted quantity is rejected', () => {
  expect(() => mapBrokerOrder({ ...sdkOrder(), quantity: new Decimal('99') })).toThrow(
    'invalid cumulative execution quantity/price',
  );
});

test('rejects missing order identity or provenance instead of inventing ordinary order facts', () => {
  expect(() => mapBrokerOrder({ ...sdkOrder(), orderId: '' })).toThrow(
    'invalid SDK order identity/provenance',
  );
  const order = sdkOrder();
  Reflect.set(order, 'remark', null);
  expect(() => mapBrokerOrder(order)).toThrow('invalid SDK order identity/provenance');
});

test('unknown SDK lifecycle status fails before publishing an OrderFact', () => {
  for (const invalidStatus of [OrderStatus.Unknown, 999, undefined]) {
    const order = sdkOrder();
    Reflect.set(order, 'status', invalidStatus);
    expect(() => mapBrokerOrder(order)).toThrow('未知订单状态');
  }
});

test('SDK getter failures retain original internal error identity', () => {
  const failure = new TypeError('native provenance getter failed');
  const order = sdkOrder();
  Object.defineProperty(order, 'remark', {
    get: () => {
      throw failure;
    },
  });
  let caught: unknown = null;
  try {
    mapBrokerOrder(order);
  } catch (error) {
    caught = error;
  }

  expect(caught).toBe(failure);
});

test('push decodes the same neutral fact for HK and drops explicit non-HK without any execution IO', async () => {
  const native = await createBrokerIngressFixture({
    orderId: 'SELL-ORIGINAL',
    symbol: 'A.HK',
    stockName: 'A',
    side: 'SELL',
    orderType: 'ELO',
    status: 'PartialWithdrawal',
    remark: 'QuantDemo|PL',
    quantity: '200',
    executedQuantity: '100',
    submittedPrice: '1.2345678901234567890123456789',
    executedPrice: '1.2345678901234567890123456789',
    submittedAtMs: 1000,
    updatedAtMs: 3000,
  });
  const detail = await native.ports.createOrderDetailReadPort().read('SELL-ORIGINAL');
  const delivered: OrderPushDecoder[] = [];
  native.ports.createOrderPushPort().setOnOrderChanged((error, decoder) => {
    expect(error).toBeNull();
    delivered.push(decoder);
  });
  native.emitOrderChanged();
  const decoder = delivered[0];
  if (decoder === undefined) throw new Error('expected real SDK callback decoder');

  expect(decoder.decode()).toEqual(detail);
  expect(native.queryObservation).toEqual(detail);
  expect(native.pushObservation).toEqual(detail);
  expect(detail).toMatchObject({
    remark: 'QuantDemo|PL',
    executionPhase: 'TERMINAL',
    status: 'PARTIALLY_CANCELED',
    executedQuantity: 100,
    executedAmount: '123.45678901234567890123456789',
    executedPrice: '1.2345678901234567890123456789',
    executionTimeMs: 3000,
    updatedAtMs: 3000,
  });

  const usPush = mapBrokerOrderPush({
    orderId: 'US-ODD',
    symbol: 'AAPL.US',
    stockName: 'APPLE',
    remark: '',
    side: OrderSide.Buy,
    status: OrderStatus.Filled,
    orderType: OrderType.LO,
    submittedQuantity: new Decimal('1.5'),
    submittedPrice: new Decimal('100'),
    executedQuantity: new Decimal('1.5'),
    executedPrice: new Decimal('100'),
    submittedAt: new Date(1000),
    updatedAt: new Date(2000),
    currency: 'USD',
    tag: 0,
    accountNo: 'MOCK',
    msg: '',
    triggerPrice: null,
    triggerStatus: null,
    triggerAt: null,
    trailingAmount: null,
    trailingPercent: null,
    limitOffset: null,
    lastShare: null,
    lastPrice: null,
    toString: () => 'US-ODD',
    toJSON: () => ({}),
  });
  expect(usPush).toBeNull();
});
