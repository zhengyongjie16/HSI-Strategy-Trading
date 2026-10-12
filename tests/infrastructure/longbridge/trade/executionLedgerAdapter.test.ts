/** 实际SDK Decimal + injected same receiver原生ledger方法，不构造SDKcontext或使用网络。 */
import { describe, expect, it } from 'bun:test';
import { Decimal, OrderSide, OrderStatus, OrderType } from 'longbridge';
import { createExecutionLedgerAdapter } from '../../../../src/infrastructure/longbridge/trade/executionLedgerAdapter.js';
import { mapBrokerOrder } from '../../../../src/infrastructure/longbridge/trade/orderMapper.js';
import type { OrderEconomics } from '../../../../src/types/orderEconomics.js';
import type { BrokerOrderSdkFields } from '../../../../src/infrastructure/longbridge/trade/types.js';

// 这里只检查 mapper 显式规则调用的输出与 native ledger 映射，不复制任何经济算法。
const orderEconomics: OrderEconomics = {
  cumulativeAmount: (price, quantity) => {
    expect(price).toBe('9.234567891234567891');
    expect(quantity).toBe(100);
    return '923.4567891234567891';
  },
  executionTime: () => 1700000000100,
  compatibleTerminalPrice: () => null,
};

function ledgerRow() {
  return {
    orderId: 'O',
    tradeId: 'E',
    symbol: 'S.HK',
    quantity: new Decimal('100'),
    price: new Decimal('9.234567891234567891'),
    tradeDoneAt: new Date(1700000000100),
  };
}

function order(): BrokerOrderSdkFields {
  return {
    orderId: 'O',
    symbol: 'S.HK',
    stockName: 'Stock',
    side: OrderSide.Buy,
    status: OrderStatus.Filled,
    orderType: OrderType.LO,
    remark: '',
    price: new Decimal('9.3'),
    quantity: new Decimal('100'),
    executedPrice: new Decimal('9.234567891234567891'),
    executedQuantity: new Decimal('100'),
    submittedAt: new Date(1700000000000),
    updatedAt: new Date(1700000000200),
  };
}

describe('execution ledger actual SDK boundary', () => {
  it('uses original context receiver and native filter, retaining price text and independent execution time', async () => {
    const calls: unknown[] = [];
    const context = {
      async todayExecutions(params: unknown) {
        expect(this).toBe(context);
        calls.push(params);
        return [ledgerRow()];
      },
      async historyExecutions(params: unknown) {
        expect(this).toBe(context);
        calls.push(params);
        return [];
      },
    };
    const port = createExecutionLedgerAdapter(context);
    const facts = await port.todayExecutions({ orderId: 'O' });
    expect(facts[0]).toEqual({
      orderId: 'O',
      tradeId: 'E',
      symbol: 'S.HK',
      quantity: 100,
      price: '9.234567891234567891',
      tradeDoneAtMs: 1700000000100,
    });
    const mapped = mapBrokerOrder(order(), facts, orderEconomics);
    expect(mapped.executionSide).toBe('BUY');
    expect(mapped.executionStatus).toBe('FILLED');
    expect(mapped.executedAmount).toBe('923.4567891234567891');
    expect(mapped.executionTimeMs).toBe(1700000000100);
    expect(mapped.updatedAtMs).toBe(1700000000200);
    const endAt = new Date(1700000000300);
    await port.historyExecutions({ endAt });
    expect(calls).toEqual([{ orderId: 'O' }, { endAt }]);
  });

  it('does not broaden Filled to other terminal statuses', () => {
    expect(
      mapBrokerOrder({ ...order(), status: OrderStatus.Canceled }, [], orderEconomics)
        .executionStatus,
    ).toBe('PARTIAL');

    expect(
      mapBrokerOrder(
        {
          ...order(),
          status: OrderStatus.Canceled,
          executedQuantity: new Decimal('0'),
          executedPrice: null,
        },
        [],
        { ...orderEconomics, cumulativeAmount: () => '0', executionTime: () => null },
      ).executionStatus,
    ).toBe('NONE');
  });

  it('rejects unsafe quantity and missing independent execution timestamp', async () => {
    for (const row of [
      { ...ledgerRow(), quantity: new Decimal('9007199254740992') },
      { ...ledgerRow(), tradeDoneAt: new Date('invalid') },
    ]) {
      const port = createExecutionLedgerAdapter({
        todayExecutions: async () => [row],
        historyExecutions: async () => [],
      });
      let rejected: unknown;
      try {
        await port.todayExecutions();
      } catch (error) {
        rejected = error;
      }

      expect(rejected).toBeInstanceOf(Error);
    }
  });

  it('preserves issued internal native error identity rather than retrying or disguising it', async () => {
    const fault = new TypeError('native ledger contract');
    let calls = 0;
    const port = createExecutionLedgerAdapter({
      todayExecutions: async () => {
        calls++;
        throw fault;
      },
      historyExecutions: async () => [],
    });
    let rejected: unknown;
    try {
      await port.todayExecutions();
    } catch (error) {
      rejected = error;
    }

    expect(rejected).toBe(fault);
    expect(calls).toBe(1);
  });
});
