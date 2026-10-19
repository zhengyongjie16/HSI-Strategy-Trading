/** 订单交易时长超时边界测试：达到阈值不超时，严格超过才触发。 */
import { describe, expect, it } from 'bun:test';
import { selectTimedOutOrders } from '../../../src/domain/order/orderRecordPolicy.js';
import type { OrderRecord } from '../../../src/types/orderRecorder.js';
import type { TradingCalendarSnapshot } from '../../../src/types/tradingCalendar.js';

function createCalendar(
  entries: ReadonlyArray<[string, { isTradingDay: boolean; isHalfDay: boolean }]>,
): TradingCalendarSnapshot {
  return new Map(entries);
}

function createOrder(orderId: string, executedTime: number): OrderRecord {
  return { orderId, symbol: 'TEST.HK', costAmount: '100', executedQuantity: 100, executedTime };
}

describe('order timeout boundary', () => {
  it('heldTradingMs == timeoutMs 不触发，+1ms 触发', () => {
    const calendar = createCalendar([['2026-02-24', { isTradingDay: true, isHalfDay: false }]]);
    const order = createOrder('O1', Date.parse('2026-02-24T01:30:00.000Z')); // 09:30 HK

    expect(
      selectTimedOutOrders({
        allOrders: [order],
        timeoutMinutes: 60,
        nowMs: Date.parse('2026-02-24T02:30:00.000Z'), // 10:30 HK，刚好 60 分钟
        calendarSnapshot: calendar,
      }),
    ).toEqual([]);

    expect(
      selectTimedOutOrders({
        allOrders: [order],
        timeoutMinutes: 60,
        nowMs: Date.parse('2026-02-24T02:30:00.001Z'),
        calendarSnapshot: calendar,
      }),
    ).toEqual([order]);
  });
});
