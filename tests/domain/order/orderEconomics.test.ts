/**
 * 订单经济规则纯测试：冻结原 SDK 均价权威、ledger 去重/累计与同量缺价终态证据口径。
 * 所有输入是中性事实，不创建 SDK、context 或第二账。
 */
import { describe, expect, it } from 'bun:test';
import {
  compatibleTerminalExecutionPrice,
  cumulativeExecutionAmount,
  matchingExecutionTime,
} from '../../../src/domain/order/orderEconomics.js';
import type { OrderExecutionLedgerFact } from '../../../src/types/orderExecutionLedger.js';
import type { OrderExecutionPriceEvidence } from '../../../src/types/orderPushPorts.js';
import type { OrderEconomicsObservation } from '../../../src/types/orderEconomics.js';

const order: OrderEconomicsObservation = {
  orderId: 'order',
  symbol: 'A.HK',
  executionSide: 'BUY',
  executedQuantity: 40,
  updatedAtMs: 200,
};
const fill: OrderExecutionLedgerFact = {
  orderId: 'order',
  tradeId: 'trade',
  symbol: 'A.HK',
  quantity: 40,
  price: '1',
  tradeDoneAtMs: 100,
};
const confirmed: OrderExecutionPriceEvidence = {
  brokerOrderId: 'order',
  symbol: 'A.HK',
  side: 'BUY',
  phase: 'OPEN',
  cumulativeQuantity: 40,
  cumulativeAmount: '40',
  executionTimeMs: 100,
  updatedAtMs: 150,
  executedPrice: '1',
};

describe('pure order economics', () => {
  it('uses exact SDK average times quantity, independently of the ledger price', () => {
    expect(cumulativeExecutionAmount('1.2345678901234567890123456789', 100)).toBe(
      '123.45678901234567890123456789',
    );
    expect(cumulativeExecutionAmount(null, 0)).toBe('0');
    expect(cumulativeExecutionAmount('1', 0)).toBe('0');
    expect(cumulativeExecutionAmount(null, 40)).toBe('0');
    expect(matchingExecutionTime(order, [{ ...fill, price: '2' }])).toBe(100);
    expect(cumulativeExecutionAmount('1', order.executedQuantity)).toBe('40');
  });

  it('deduplicates identical trade IDs and sorts execution time without modifying input', () => {
    const early = Object.freeze({ ...fill, tradeId: 'early', quantity: 15, tradeDoneAtMs: 80 });
    const late = Object.freeze({ ...fill, tradeId: 'late', quantity: 25 });
    const ledger = Object.freeze([late, early, late]);
    expect(matchingExecutionTime(order, ledger)).toBe(100);
    expect(compatibleTerminalExecutionPrice(order, ledger, confirmed)).toBe('1');
    expect(ledger).toEqual([late, early, late]);
  });

  it('leaves incomplete/excess quantity unknown and ignores future/foreign ledger for time only', () => {
    expect(matchingExecutionTime(order, [])).toBeNull();
    expect(matchingExecutionTime(order, [{ ...fill, quantity: 39 }])).toBeNull();
    expect(matchingExecutionTime(order, [{ ...fill, quantity: 41 }])).toBeNull();
    expect(matchingExecutionTime(order, [{ ...fill, tradeDoneAtMs: 201 }])).toBeNull();
    expect(matchingExecutionTime(order, [{ ...fill, orderId: 'other' }])).toBeNull();
    expect(
      matchingExecutionTime({ ...order, executedQuantity: 0 }, [{ ...fill, price: '0' }]),
    ).toBeNull();
    const future = { ...fill, tradeId: 'future', tradeDoneAtMs: 201 };
    expect(matchingExecutionTime(order, [fill, future])).toBe(100);
    expect(() => compatibleTerminalExecutionPrice(order, [fill, future], confirmed)).toThrow(
      'incompatible terminal execution ledger',
    );
  });

  it.each([
    { ...fill, price: '2' },
    { ...fill, quantity: 39 },
    { ...fill, tradeDoneAtMs: 99 },
  ])('rejects a duplicate trade identity with different payload', (conflicting) => {
    expect(() => matchingExecutionTime(order, [fill, conflicting])).toThrow(
      'same tradeId execution conflict',
    );

    expect(() => compatibleTerminalExecutionPrice(order, [fill, conflicting], confirmed)).toThrow(
      'same tradeId execution conflict',
    );
  });

  it('requires exact same-broker, same-quantity, same-time and amount evidence for terminal price', () => {
    expect(compatibleTerminalExecutionPrice(order, [fill, fill], confirmed)).toBe('1');
    expect(compatibleTerminalExecutionPrice(order, [fill])).toBeNull();
    expect(compatibleTerminalExecutionPrice(order, [], confirmed)).toBeNull();
    for (const evidence of [
      { ...confirmed, brokerOrderId: 'other' },
      { ...confirmed, side: 'SELL' as const },
      { ...confirmed, symbol: 'B.HK' },
      { ...confirmed, cumulativeQuantity: 41 },
      { ...confirmed, executionTimeMs: 99 },
      { ...confirmed, cumulativeAmount: '40.00000000000000000001' },
      { ...confirmed, executedPrice: '1.00000000000000000001' },
      { ...confirmed, updatedAtMs: 201 },
    ])
      expect(compatibleTerminalExecutionPrice(order, [fill], evidence)).toBeNull();

    expect(
      compatibleTerminalExecutionPrice(order, [{ ...fill, price: '2' }], confirmed),
    ).toBeNull();
  });

  it('keeps ownership, time, positive-price and safe cumulative quantity failures explicit', () => {
    expect(() => matchingExecutionTime(order, [{ ...fill, symbol: 'B.HK' }])).toThrow(
      'execution ownership or identity conflict',
    );

    expect(() => matchingExecutionTime(order, [{ ...fill, price: '0' }])).toThrow(
      'execution lacks positive quantity/price',
    );

    expect(() =>
      compatibleTerminalExecutionPrice(order, [fill], { ...confirmed, updatedAtMs: 0 }),
    ).toThrow('invalid confirmed terminal execution basis');
    const largeOrder = { ...order, executedQuantity: Number.MAX_SAFE_INTEGER };
    const largeFill = { ...fill, quantity: Number.MAX_SAFE_INTEGER - 1, tradeDoneAtMs: 90 };
    const remainder = { ...fill, tradeId: 'remainder', quantity: 2 };
    expect(() => matchingExecutionTime(largeOrder, [largeFill, remainder])).toThrow(
      'execution quantity overflow',
    );

    expect(() =>
      compatibleTerminalExecutionPrice(largeOrder, [largeFill, remainder], {
        ...confirmed,
        cumulativeQuantity: Number.MAX_SAFE_INTEGER,
      }),
    ).toThrow('execution quantity overflow');
  });
});
