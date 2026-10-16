/**
 * 订单成交审计用例回归。
 * 从 post-gate 审计场景拆出同步记录、成交过滤、精确文本/安全数量、终态 reason 与保护性非完成语义。
 */
import { describe, expect, it } from 'bun:test';
import { createOrderTradeAudit } from '../../../../src/application/orderTracking/tradeAudit/index.js';
import type { OrderStateChangedEvent } from '../../../../src/types/orderTracking.js';
import type { PersistableTradeRecord } from '../../../../src/types/tradeLog.js';

const recordedAt = new Date('2026-03-13T02:36:00.000Z');
const appendFailures: ReadonlyArray<{ readonly rejection: unknown }> = [
  { rejection: new Error('append failed') },
  { rejection: null },
  { rejection: undefined },
];

function createEvent(overrides: Partial<OrderStateChangedEvent> = {}): OrderStateChangedEvent {
  return {
    orderId: 'ORDER-001',
    symbol: 'BULL.HK',
    side: 'BUY',
    source: 'WS',
    status: 'FILLED',
    monitorSymbol: 'HSI.HK',
    isLongSymbol: true,
    isProtectiveLiquidation: false,
    executedPrice: '1.2300',
    executedQuantity: 100,
    executedTimeMs: Date.parse('2026-03-13T01:35:00.000Z'),
    ...overrides,
  };
}

function formatAuditTime(date: Date): string {
  return date.toISOString();
}

describe('createOrderTradeAudit', () => {
  it.each([
    { side: 'BUY' as const, isLongSymbol: true, action: 'BUYCALL', source: 'WS' as const },
    { side: 'BUY' as const, isLongSymbol: false, action: 'BUYPUT', source: 'API' as const },
    {
      side: 'SELL' as const,
      isLongSymbol: true,
      action: 'SELLCALL',
      source: 'STATE_CHECK' as const,
    },
    { side: 'SELL' as const, isLongSymbol: false, action: 'SELLPUT', source: 'RECOVERY' as const },
  ])(
    'synchronously appends $action from the existing $source event',
    ({ side, isLongSymbol, action, source }) => {
      const records: PersistableTradeRecord[] = [];
      const audit = createOrderTradeAudit({
        expectedMonitorSymbol: 'HSI.HK',
        appendTradeRecord: (record) => {
          records.push(record);
        },
        toHongKongTimeIso: formatAuditTime,
      });
      const event = Object.freeze(createEvent({ side, isLongSymbol, source }));

      audit(event, recordedAt);
      expect(records).toEqual([
        {
          orderId: event.orderId,
          symbol: event.symbol,
          symbolName: null,
          monitorSymbol: event.monitorSymbol,
          action,
          side,
          quantity: '100',
          price: '1.2300',
          orderType: null,
          status: 'FILLED',
          error: null,
          reason: null,
          signalTriggerTime: null,
          executedAt: '2026-03-13T01:35:00.000Z',
          executedAtMs: 1773365700000,
          timestamp: recordedAt.toISOString(),
          isProtectiveClearance: false,
        },
      ]);
    },
  );

  it.each([{ status: 'CANCELED' as const }, { status: 'REJECTED' as const }])(
    'keeps positive partial execution with $status as reason and FILLED audit status',
    ({ status }) => {
      const records: PersistableTradeRecord[] = [];
      const audit = createOrderTradeAudit({
        expectedMonitorSymbol: 'HSI.HK',
        appendTradeRecord: (record) => {
          records.push(record);
        },
        toHongKongTimeIso: formatAuditTime,
      });

      audit(createEvent({ status, executedQuantity: 1 }), recordedAt);
      expect(records[0]).toMatchObject({ status: 'FILLED', reason: status, quantity: '1' });
    },
  );

  it('filters incomplete and nonpositive execution facts before monitor identity or timestamp formatting', () => {
    const audit = createOrderTradeAudit({
      expectedMonitorSymbol: 'HSI.HK',
      appendTradeRecord: () => {
        throw new Error('filtered event must not append');
      },
      toHongKongTimeIso: () => {
        throw new Error('filtered event must not format time');
      },
    });
    const filtered: ReadonlyArray<Partial<OrderStateChangedEvent>> = [
      { symbol: null },
      { side: null },
      { isLongSymbol: null },
      { executedPrice: null },
      { executedPrice: '0' },
      { executedPrice: '-0.001' },
      { executedQuantity: null },
      { executedQuantity: 0 },
      { executedQuantity: -1 },
      { executedQuantity: 0.5 },
      { executedQuantity: Number.NaN },
      { executedQuantity: Number.POSITIVE_INFINITY },
      { executedQuantity: Number.MAX_SAFE_INTEGER + 1 },
      { executedTimeMs: null },
      { executedTimeMs: 0 },
      { executedTimeMs: -1 },
      { executedTimeMs: 0.5 },
      { executedTimeMs: Number.NaN },
      { executedTimeMs: Number.POSITIVE_INFINITY },
      { executedTimeMs: Number.MAX_SAFE_INTEGER + 1 },
      { symbol: null, executedPrice: 'malformed' },
    ];

    for (const overrides of filtered) {
      expect(() => {
        audit(createEvent({ monitorSymbol: 'OTHER.HK', ...overrides }), recordedAt);
      }).not.toThrow();
    }
  });

  it('rejects a complete foreign-monitor execution but does not reinterpret malformed financial text', () => {
    const audit = createOrderTradeAudit({
      expectedMonitorSymbol: 'HSI.HK',
      appendTradeRecord: () => {
        throw new Error('invalid event must not append');
      },
      toHongKongTimeIso: formatAuditTime,
    });

    expect(() => {
      audit(createEvent({ monitorSymbol: 'OTHER.HK' }), recordedAt);
    }).toThrow('monitorSymbol mismatch');

    expect(() => {
      audit(createEvent({ monitorSymbol: null }), recordedAt);
    }).toThrow('monitorSymbol mismatch');

    expect(() => {
      audit(createEvent({ executedPrice: '1e2' }), recordedAt);
    }).toThrow(TypeError);
  });

  it('preserves exact financial text and safe integer quantity without a second ledger or protective completion', () => {
    const records: PersistableTradeRecord[] = [];
    const audit = createOrderTradeAudit({
      expectedMonitorSymbol: 'HSI.HK',
      appendTradeRecord: (record) => {
        records.push(record);
      },
      toHongKongTimeIso: formatAuditTime,
    });
    const event = createEvent({
      side: 'SELL',
      executedPrice: '9007199254740993.0000000000000001',
      executedQuantity: Number.MAX_SAFE_INTEGER,
      isProtectiveLiquidation: true,
    });

    audit(event, recordedAt);
    audit(event, recordedAt);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      price: event.executedPrice,
      quantity: '9007199254740991',
      action: 'SELLCALL',
      reason: null,
      isProtectiveClearance: true,
    });
    expect(records[0]).not.toHaveProperty('recordType');
  });

  it.each([...appendFailures])(
    'rethrows synchronous append failure without replacing the original value',
    ({ rejection }) => {
      const audit = createOrderTradeAudit({
        expectedMonitorSymbol: 'HSI.HK',
        appendTradeRecord: () => {
          throw rejection;
        },
        toHongKongTimeIso: formatAuditTime,
      });
      let caught: unknown = 'unset';
      try {
        audit(createEvent(), recordedAt);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBe(rejection);
    },
  );
});
