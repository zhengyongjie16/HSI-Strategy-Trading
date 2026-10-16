/**
 * sellDeductionPolicy 业务测试
 *
 * 验证卖出抵扣买入记录时的稳定优先级与数量扣减规则。
 */
import { describe, expect, it } from 'bun:test';
import type { OrderRecord } from '../../../src/types/orderRecorder.js';
import {
  compareBuyOrdersBySellPriority,
  deductSellQuantityFromBuyOrders,
} from '../../../src/domain/order/sellDeductionPolicy.js';

function createOrder(params: {
  readonly orderId: string;
  readonly costAmount: string;
  readonly executedTime: number;
  readonly executedQuantity?: number;
}): OrderRecord {
  return {
    orderId: params.orderId,
    symbol: 'BULL.HK',
    costAmount: params.costAmount,
    executedQuantity: params.executedQuantity ?? 100,
    executedTime: params.executedTime,
    submittedAt: undefined,
    updatedAt: undefined,
  };
}

describe('sellDeductionPolicy', () => {
  it('按价格、成交时间、orderId 形成唯一稳定顺序且不受输入顺序影响', () => {
    const orders = [
      createOrder({ orderId: 'BUY-C', costAmount: '100', executedTime: 100 }),
      createOrder({ orderId: 'BUY-B', costAmount: '100', executedTime: 100 }),
      createOrder({ orderId: 'BUY-D', costAmount: '100', executedTime: 200 }),
      createOrder({ orderId: 'BUY-A', costAmount: '90', executedTime: 300 }),
    ];

    const forward = [...orders].sort(compareBuyOrdersBySellPriority).map((order) => order.orderId);
    const reversed = [orders[3]!, orders[2]!, orders[1]!, orders[0]!]
      .sort(compareBuyOrdersBySellPriority)
      .map((order) => order.orderId);

    expect(forward).toEqual(['BUY-A', 'BUY-B', 'BUY-C', 'BUY-D']);
    expect(reversed).toEqual(forward);
  });

  it('同价订单按更早成交时间扣减而不是沿用输入顺序', () => {
    const later = createOrder({ orderId: 'BUY-LATER', costAmount: '100', executedTime: 200 });
    const earlier = createOrder({ orderId: 'BUY-EARLIER', costAmount: '100', executedTime: 100 });

    const remaining = deductSellQuantityFromBuyOrders([later, earlier], 100);

    expect(remaining.map((order) => order.orderId)).toEqual(['BUY-LATER']);
  });

  it('按低价优先整笔扣减且不拆分无法完全覆盖的订单', () => {
    const low = createOrder({
      orderId: 'BUY-LOW',
      costAmount: '48',
      executedTime: 300,
      executedQuantity: 60,
    });
    const middle = createOrder({
      orderId: 'BUY-MIDDLE',
      costAmount: '90',
      executedTime: 100,
      executedQuantity: 100,
    });
    const high = createOrder({
      orderId: 'BUY-HIGH',
      costAmount: '40',
      executedTime: 200,
      executedQuantity: 40,
    });

    const remaining = deductSellQuantityFromBuyOrders([high, middle, low], 110);

    expect(remaining.map((order) => order.orderId)).toEqual(['BUY-MIDDLE']);
    expect(remaining[0]?.executedQuantity).toBe(100);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    '卖出数量非法时 fail-fast: %p',
    (sellQuantity) => {
      expect(() => deductSellQuantityFromBuyOrders([], sellQuantity)).toThrow(
        '[卖出扣减策略] 卖出数量必须为有限正数',
      );
    },
  );
});
