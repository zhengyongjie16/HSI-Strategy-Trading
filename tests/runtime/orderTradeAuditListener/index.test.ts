/**
 * 订单成交审计 listener 生命周期回归。
 * 验证即刻订阅、逐事件 clock、同步 append/fatal+rethrow，以及直接返回唯一 unsubscribe 而不提前停订。
 */
import { describe, expect, it } from 'bun:test';
import { createOrderTradeAudit } from '../../../src/application/orderTracking/tradeAudit/index.js';
import { createOrderTradeAuditListener } from '../../../src/runtime/orderTradeAuditListener/index.js';
import type { OrderStateChangedEvent } from '../../../src/types/orderTracking.js';
import type { PersistableTradeRecord } from '../../../src/types/tradeLog.js';

const appendFailures: ReadonlyArray<{ readonly rejection: unknown }> = [
  { rejection: new TypeError('sync append failed') },
  { rejection: null },
  { rejection: undefined },
];

function createEvent(): OrderStateChangedEvent {
  return {
    orderId: 'ORDER-001',
    symbol: 'BULL.HK',
    side: 'SELL',
    source: 'WS',
    status: 'FILLED',
    monitorSymbol: 'HSI.HK',
    isLongSymbol: true,
    isProtectiveLiquidation: true,
    executedPrice: '1.0100',
    executedQuantity: 200,
    executedTimeMs: Date.parse('2026-03-13T02:00:00.000Z'),
  };
}

describe('createOrderTradeAuditListener', () => {
  it('subscribes immediately, reads clock per event and returns the original unsubscribe', () => {
    const listeners = new Set<(event: OrderStateChangedEvent) => void>();
    const records: PersistableTradeRecord[] = [];
    const fatalErrors: unknown[] = [];
    let unsubscribeCount = 0;
    let nowCalls = 0;
    let now = new Date('2026-03-13T02:01:00.000Z');
    const unsubscribe = (): void => {
      unsubscribeCount += 1;
      listeners.clear();
    };
    const stop = createOrderTradeAuditListener({
      onOrderStateChanged: (listener) => {
        listeners.add(listener);
        return unsubscribe;
      },
      audit: createOrderTradeAudit({
        expectedMonitorSymbol: 'HSI.HK',
        appendTradeRecord: (record) => {
          records.push(record);
        },
        toHongKongTimeIso: (date) => date.toISOString(),
      }),
      now: () => {
        nowCalls += 1;
        return now;
      },
      reportFatalError: (error) => {
        fatalErrors.push(error);
      },
    });

    expect(stop).toBe(unsubscribe);
    expect(listeners.size).toBe(1);
    expect(nowCalls).toBe(0);
    for (const listener of listeners) listener(createEvent());

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      action: 'SELLCALL',
      quantity: '200',
      price: '1.0100',
      reason: null,
      isProtectiveClearance: true,
      executedAt: '2026-03-13T02:00:00.000Z',
      timestamp: '2026-03-13T02:01:00.000Z',
    });
    expect(fatalErrors).toEqual([]);
    expect(unsubscribeCount).toBe(0);
    expect(nowCalls).toBe(1);

    now = new Date('2026-03-13T02:02:00.000Z');
    for (const listener of listeners) listener(createEvent());

    expect(records[1]).toMatchObject({
      executedAt: '2026-03-13T02:00:00.000Z',
      timestamp: '2026-03-13T02:02:00.000Z',
    });
    expect(nowCalls).toBe(2);
    stop();
    for (const listener of listeners) listener(createEvent());

    expect(records).toHaveLength(2);
    expect(unsubscribeCount).toBe(1);
    expect(nowCalls).toBe(2);
  });

  it.each([...appendFailures])(
    'reports and rethrows original append failure synchronously without unsubscribing',
    ({ rejection }) => {
      const listeners = new Set<(event: OrderStateChangedEvent) => void>();
      const order: string[] = [];
      const fatalErrors: unknown[] = [];
      createOrderTradeAuditListener({
        onOrderStateChanged: (listener) => {
          listeners.add(listener);
          return () => {
            order.push('unsubscribe');
          };
        },
        audit: createOrderTradeAudit({
          expectedMonitorSymbol: 'HSI.HK',
          appendTradeRecord: () => {
            order.push('append');
            throw rejection;
          },
          toHongKongTimeIso: (date) => date.toISOString(),
        }),
        now: () => new Date('2026-03-13T02:01:00.000Z'),
        reportFatalError: (error) => {
          order.push('fatal');
          fatalErrors.push(error);
        },
      });

      let caught: unknown = 'unset';
      try {
        for (const listener of listeners) listener(createEvent());
      } catch (error) {
        order.push('caller');
        caught = error;
      }

      expect(caught).toBe(rejection);
      expect(fatalErrors).toEqual([rejection]);
      expect(order).toEqual(['append', 'fatal', 'caller']);
      expect(listeners.size).toBe(1);
    },
  );
});
