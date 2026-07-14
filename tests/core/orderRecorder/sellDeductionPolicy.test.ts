import { describe, expect, it } from 'bun:test';
import type { OrderRecord } from '../../../src/types/services.js';
import {
  compareBuyOrdersBySellPriority,
  deductSellQuantityFromBuyOrders,
} from '../../../src/core/orderRecorder/sellDeductionPolicy.js';

function createOrder(params: {
  readonly orderId: string;
  readonly executedPrice: number;
  readonly executedTime: number;
  readonly executedQuantity?: number;
}): OrderRecord {
  return {
    orderId: params.orderId,
    symbol: 'BULL.HK',
    executedPrice: params.executedPrice,
    executedQuantity: params.executedQuantity ?? 100,
    executedTime: params.executedTime,
    submittedAt: undefined,
    updatedAt: undefined,
  };
}

describe('sellDeductionPolicy', () => {
  it('按价格、成交时间、orderId 形成唯一稳定顺序且不受输入顺序影响', () => {
    const orders = [
      createOrder({ orderId: 'BUY-C', executedPrice: 1, executedTime: 100 }),
      createOrder({ orderId: 'BUY-B', executedPrice: 1, executedTime: 100 }),
      createOrder({ orderId: 'BUY-D', executedPrice: 1, executedTime: 200 }),
      createOrder({ orderId: 'BUY-A', executedPrice: 0.9, executedTime: 300 }),
    ];

    const forward = [...orders].sort(compareBuyOrdersBySellPriority).map((order) => order.orderId);
    const reversed = [orders[3]!, orders[2]!, orders[1]!, orders[0]!]
      .sort(compareBuyOrdersBySellPriority)
      .map((order) => order.orderId);

    expect(forward).toEqual(['BUY-A', 'BUY-B', 'BUY-C', 'BUY-D']);
    expect(reversed).toEqual(forward);
  });

  it('同价订单按更早成交时间扣减而不是沿用输入顺序', () => {
    const later = createOrder({ orderId: 'BUY-LATER', executedPrice: 1, executedTime: 200 });
    const earlier = createOrder({ orderId: 'BUY-EARLIER', executedPrice: 1, executedTime: 100 });

    const remaining = deductSellQuantityFromBuyOrders([later, earlier], 100);

    expect(remaining.map((order) => order.orderId)).toEqual(['BUY-LATER']);
  });
});
