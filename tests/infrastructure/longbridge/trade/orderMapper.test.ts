/** SDK mapper 单测：保真原文/元数据/时间，并显式委托中性经济能力；真实规则由 domain/integration 验证。 */
import { expect, test } from 'bun:test';
import { Decimal, OrderSide, OrderStatus, OrderType, type Execution } from 'longbridge';
import {
  mapBrokerOrder,
  mapBrokerExecutions,
} from '../../../../src/infrastructure/longbridge/trade/orderMapper.js';
import type { BrokerOrderSdkFields } from '../../../../src/infrastructure/longbridge/trade/types.js';
import type { OrderEconomics } from '../../../../src/types/orderEconomics.js';

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
    remark: '',
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
