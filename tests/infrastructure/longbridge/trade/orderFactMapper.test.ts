/** SDK mapper 单测：保真原文/元数据/时间，并显式委托中性经济能力；真实规则由 domain/integration 验证。 */
import { expect, test } from 'bun:test';
import { Decimal, OrderSide, OrderStatus, OrderType, type Execution } from 'longbridge';
import {
  mapBrokerOrder,
  mapBrokerExecutions,
} from '../../../../src/infrastructure/longbridge/trade/orderMapper.js';
import type { BrokerOrderSdkFields } from '../../../../src/infrastructure/longbridge/trade/types.js';
import type { OrderEconomics } from '../../../../src/types/orderEconomics.js';
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
const execution: Execution = {
  orderId: 'order',
  tradeId: 'trade',
  symbol: 'A.HK',
  tradeDoneAt: new Date(2000),
  quantity: new Decimal('100'),
  price: new Decimal('1.2345678901234567890123456789'),
  toString: () => 'trade',
  toJSON: () => ({ tradeId: 'trade' }),
};

// 中性 stub 只返回显式测试结果，不复制 domain 金额公式、ledger 或补价裁决。
const economics: OrderEconomics = {
  cumulativeAmount: () => '123.45678901234567890123456789',
  executionTime: () => 2000,
  compatibleTerminalPrice: () => null,
};

test('high significant SDK text and independent revision reach the injected pure rules unchanged', () => {
  const ledger = mapBrokerExecutions([execution]);
  const calls: string[] = [];
  const mapped = mapBrokerOrder(sdkOrder(), ledger, {
    ...economics,
    cumulativeAmount: (price, quantity) => {
      calls.push('amount');
      expect(price).toBe('1.2345678901234567890123456789');
      expect(quantity).toBe(100);
      return '123.45678901234567890123456789';
    },
    executionTime: (order, rows) => {
      calls.push('time');
      expect(order).toEqual({
        orderId: 'order',
        symbol: 'A.HK',
        executionSide: 'BUY',
        executedQuantity: 100,
        updatedAtMs: 3000,
      });
      expect(rows).toBe(ledger);
      return 2000;
    },
  });
  expect(calls).toEqual(['amount', 'time']);
  expect(mapped).toMatchObject({
    executedPrice: '1.2345678901234567890123456789',
    executedAmount: '123.45678901234567890123456789',
    price: '-0',
    executionTimeMs: 2000,
    updatedAtMs: 3000,
    executionPhase: 'TERMINAL',
    remark: 'QuantDemo|PL',
  });
});

test('unknown execution time from the rule stays unknown, never replaced by broker revision', () => {
  const mapped = mapBrokerOrder(sdkOrder(), [], { ...economics, executionTime: () => null });
  expect(mapped.executionTimeMs).toBeNull();
  expect(mapped.updatedAtMs).toBe(3000);
});

test('terminal missing-price mapping delegates its neutral observation and ledger, but still rejects unproven or negative price', () => {
  const terminal = { ...sdkOrder(), status: OrderStatus.Canceled, executedPrice: null };
  const ledger = mapBrokerExecutions([execution]);
  let calls = 0;
  const proven = mapBrokerOrder(terminal, ledger, {
    ...economics,
    compatibleTerminalPrice: (order, rows, confirmed) => {
      calls++;
      expect(order.executedQuantity).toBe(100);
      expect(order.executionSide).toBe('BUY');
      expect(rows).toBe(ledger);
      expect(confirmed).toBeUndefined();
      return '1.2345678901234567890123456789';
    },
  });
  expect(calls).toBe(1);
  expect(proven.executedPrice).toBe('1.2345678901234567890123456789');
  expect(proven.executionStatus).toBe('PARTIAL');
  expect(() => mapBrokerOrder(terminal, ledger, economics)).toThrow(
    'invalid cumulative execution quantity/price',
  );

  expect(() =>
    mapBrokerOrder({ ...terminal, executedPrice: new Decimal('-1') }, ledger, economics),
  ).toThrow('invalid cumulative execution quantity/price');
});

test('rejects missing order identity or provenance instead of inventing ordinary order facts', () => {
  expect(() => mapBrokerOrder({ ...sdkOrder(), orderId: '' }, [], economics)).toThrow(
    'invalid SDK order identity/provenance',
  );
  const order = sdkOrder();
  Reflect.set(order, 'remark', null);
  expect(() => mapBrokerOrder(order, [], economics)).toThrow(
    'invalid SDK order identity/provenance',
  );
});

test('unknown SDK lifecycle status fails before publishing an OrderFact or invoking economic rules', () => {
  for (const invalidStatus of [OrderStatus.Unknown, 999, undefined]) {
    const order = sdkOrder();
    Reflect.set(order, 'status', invalidStatus);
    let calls = 0;
    const error = new TypeError('economic rule must not run');
    expect(() =>
      mapBrokerOrder(order, [], {
        ...economics,
        cumulativeAmount: () => {
          calls++;
          throw error;
        },
      }),
    ).toThrow('未知订单状态');
    expect(calls).toBe(0);
  }
});

test('query/detail/push publish the same neutral provenance, financial text and independent times', async () => {
  const native = await createBrokerIngressFixture(
    {
      orderId: 'SELL-ORIGINAL',
      tradeId: 'EXECUTION-ORIGINAL',
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
      executionTimeMs: 2000,
      updatedAtMs: 3000,
    },
    economics,
  );
  const executions = await native.executionLedgerPort.todayExecutions();
  const detail = await native.ports.createOrderDetailReadPort().read('SELL-ORIGINAL');
  const queried = detail.decode(executions);
  const delivered: OrderPushDecoder[] = [];
  native.ports.createOrderPushPort().setOnOrderChanged((error, decoder) => {
    expect(error).toBeNull();
    delivered.push(decoder);
  });
  native.emitOrderChanged();
  const decoder = delivered[0];
  if (decoder === undefined) throw new Error('expected real SDK callback decoder');

  expect(decoder.inspect()).toEqual({
    orderId: 'SELL-ORIGINAL',
    symbol: 'A.HK',
    executedQuantity: 100,
    updatedAtMs: 3000,
  });
  expect(decoder.decode(executions)).toEqual(queried);
  expect(native.queryObservation).toEqual(queried);
  expect(native.pushObservation).toEqual(queried);
  expect(queried).toMatchObject({
    remark: 'QuantDemo|PL',
    executionPhase: 'TERMINAL',
    status: 'PARTIALLY_CANCELED',
    executedQuantity: 100,
    executedAmount: '123.45678901234567890123456789',
    executedPrice: '1.2345678901234567890123456789',
    executionTimeMs: 2000,
    updatedAtMs: 3000,
  });
});

test('same-quantity amount correction keeps its newer revision and the original execution time', () => {
  const first = mapBrokerOrder(sdkOrder(), [], economics);
  const revised = mapBrokerOrder(
    {
      ...sdkOrder(),
      updatedAt: new Date(4000),
      executedPrice: new Decimal('1.234567890123456789012345679'),
    },
    [],
    { ...economics, cumulativeAmount: () => '123.4567890123456789012345679' },
  );
  expect(revised.executedQuantity).toBe(first.executedQuantity);
  expect(revised.executionTimeMs).toBe(first.executionTimeMs);
  expect(revised.updatedAtMs).toBe(4000);
  expect(revised.executedAmount).toBe('123.4567890123456789012345679');
  expect(first.executedAmount).toBe('123.45678901234567890123456789');
  expect(first.updatedAtMs).toBe(3000);
});

test('positive execution requires independent revision; zero execution does not fabricate execution time', () => {
  expect(() => mapBrokerOrder({ ...sdkOrder(), updatedAt: null }, [], economics)).toThrow(
    'executed order lacks independent broker revision',
  );
  const initial = mapBrokerOrder(
    {
      ...sdkOrder(),
      status: OrderStatus.New,
      executedQuantity: new Decimal('0'),
      executedPrice: null,
      updatedAt: null,
    },
    [],
    { ...economics, cumulativeAmount: () => '0', executionTime: () => null },
  );
  expect(initial.executionTimeMs).toBeNull();
  expect(initial.updatedAtMs).toBe(1000);
  expect(initial.updatedAt).toBeNull();
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
    mapBrokerOrder(order, [], economics);
  } catch (error) {
    caught = error;
  }

  expect(caught).toBe(failure);
});
