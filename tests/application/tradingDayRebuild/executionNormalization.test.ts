/**
 * API 观察归一的零量/正量、revision 与 stale 策略矩阵。
 * 所有观察必须经过共享 executionFact 裁决；known 正量不得被零观察回退或清空。
 */
import { describe, expect, it } from 'bun:test';
import { normalizeExecutionOrder } from '../../../src/application/tradingDayRebuild/executionNormalization.js';
import type { KnownExecutionBaseline } from '../../../src/domain/order/types.js';
import type { OrderFact } from '../../../src/types/trade.js';

function order(overrides: Partial<OrderFact> = {}): OrderFact {
  return {
    orderId: 'ORDER-1',
    symbol: 'BULL.HK',
    stockName: 'HSI RC',
    executionSide: 'BUY',
    executionStatus: 'NONE',
    executionPhase: 'OPEN',
    status: 'WORKING',
    orderType: 'ELO',
    price: null,
    quantity: 10,
    executedPrice: null,
    executedQuantity: 0,
    executedAmount: '0',
    executionTimeMs: null,
    updatedAtMs: 90,
    submittedAt: new Date(1),
    updatedAt: new Date(90),
    ...overrides,
  };
}

function known(overrides: Partial<KnownExecutionBaseline> = {}): KnownExecutionBaseline {
  return {
    brokerOrderId: 'ORDER-1',
    symbol: 'BULL.HK',
    side: 'BUY',
    cumulativeQuantity: 10,
    cumulativeAmount: '100',
    executionTimeMs: 100,
    updatedAtMs: 100,
    phase: 'TERMINAL',
    ...overrides,
  };
}

describe('normalizeExecutionOrder zero observation adjudication', () => {
  for (const revision of [90, 100, 110]) {
    it(`known positive cannot be wiped by API zero at revision ${revision}`, () => {
      const target = order({ updatedAtMs: revision, updatedAt: new Date(revision) });
      expect(() => normalizeExecutionOrder(target, known(), 'THROW')).toThrow();
    });
  }

  it('older zero with THROW blocks stale observation before recalculation', () => {
    const target = order({ updatedAtMs: 90, updatedAt: new Date(90) });
    expect(() => normalizeExecutionOrder(target, known(), 'THROW')).toThrow(/早于 durable known/);
  });

  it('older zero with KEEP_KNOWN retains the known positive fact', () => {
    const target = order({ updatedAtMs: 90, updatedAt: new Date(90) });
    expect(normalizeExecutionOrder(target, known(), 'KEEP_KNOWN')).toMatchObject({
      executedQuantity: 10,
      executedAmount: '100',
      executionTimeMs: 100,
      updatedAtMs: 100,
      executionPhase: 'TERMINAL',
    });
  });

  for (const revision of [100, 110]) {
    for (const policy of ['THROW', 'KEEP_KNOWN'] as const) {
      it(`same/newer zero at revision ${revision} rejects quantity regression under ${policy}`, () => {
        const target = order({
          updatedAtMs: revision,
          updatedAt: new Date(revision),
          executionPhase: 'TERMINAL',
        });
        expect(() => normalizeExecutionOrder(target, known(), policy)).toThrow(/累计数量倒退/);
      });
    }
  }

  it('same revision zero OPEN against known TERMINAL still rejects phase regression', () => {
    const target = order({ updatedAtMs: 100, updatedAt: new Date(100) });
    expect(() => normalizeExecutionOrder(target, known(), 'KEEP_KNOWN')).toThrow(
      /fact stage regression/,
    );
  });

  it('older zero cannot keep an unknown-phase baseline known fact', () => {
    const target = order({ updatedAtMs: 90, updatedAt: new Date(90) });
    expect(() => normalizeExecutionOrder(target, known({ phase: null }), 'KEEP_KNOWN')).toThrow(
      /缺少 known phase/,
    );
  });

  it('known zero is adjudicated through merge instead of being bypassed', () => {
    const knownZero = known({
      cumulativeQuantity: 0,
      cumulativeAmount: '0',
      executionTimeMs: null,
      updatedAtMs: 100,
      phase: 'OPEN',
    });
    expect(() =>
      normalizeExecutionOrder(
        order({ updatedAtMs: 90, updatedAt: new Date(90) }),
        knownZero,
        'THROW',
      ),
    ).toThrow(/早于 durable known/);

    expect(
      normalizeExecutionOrder(
        order({ updatedAtMs: 90, updatedAt: new Date(90) }),
        knownZero,
        'KEEP_KNOWN',
      ),
    ).toMatchObject({ executedQuantity: 0, executedAmount: '0', executionTimeMs: null });

    expect(
      normalizeExecutionOrder(
        order({
          updatedAtMs: 110,
          updatedAt: new Date(110),
          executionPhase: 'TERMINAL',
        }),
        knownZero,
        'THROW',
      ),
    ).toMatchObject({
      executedQuantity: 0,
      executedAmount: '0',
      executionTimeMs: null,
      updatedAtMs: 110,
      executionPhase: 'TERMINAL',
    });
  });

  it('known zero is adjudicated through merge at same and newer revisions under both policies', () => {
    const knownZero = known({
      cumulativeQuantity: 0,
      cumulativeAmount: '0',
      executionTimeMs: null,
      updatedAtMs: 100,
      phase: 'OPEN',
    });

    for (const policy of ['THROW', 'KEEP_KNOWN'] as const) {
      expect(
        normalizeExecutionOrder(
          order({ updatedAtMs: 100, updatedAt: new Date(100) }),
          knownZero,
          policy,
        ),
      ).toMatchObject({ executedQuantity: 0, executedAmount: '0', updatedAtMs: 100 });

      expect(
        normalizeExecutionOrder(
          order({
            updatedAtMs: 110,
            updatedAt: new Date(110),
            executionPhase: 'TERMINAL',
          }),
          knownZero,
          policy,
        ),
      ).toMatchObject({
        executedQuantity: 0,
        executedAmount: '0',
        updatedAtMs: 110,
        executionPhase: 'TERMINAL',
      });
    }
  });

  it('zero observation without known normalizes to canonical zero', () => {
    expect(normalizeExecutionOrder(order(), undefined, 'THROW')).toMatchObject({
      executedQuantity: 0,
      executedAmount: '0',
      executionTimeMs: null,
    });
  });

  it('zero observation declaring amount or execution time is rejected', () => {
    expect(() =>
      normalizeExecutionOrder(order({ executedAmount: '1' }), undefined, 'THROW'),
    ).toThrow(/零成交订单声明金额或执行时间/);

    expect(() =>
      normalizeExecutionOrder(
        order({ executedAmount: null, executionTimeMs: 1 }),
        undefined,
        'THROW',
      ),
    ).toThrow(/零成交订单声明金额或执行时间/);
  });

  it('positive observation with null raw amount is rejected even when known amount exists', () => {
    const target = order({
      executedQuantity: 10,
      executedAmount: null,
      executionTimeMs: 110,
      updatedAtMs: 110,
      updatedAt: new Date(110),
      executionPhase: 'TERMINAL',
    });
    expect(() => normalizeExecutionOrder(target, known(), 'KEEP_KNOWN')).toThrow(
      /正成交缺少本次原始金额/,
    );
  });

  it('known identity conflict still fails through the shared merge', () => {
    const target = order({ symbol: 'BEAR.HK' });
    expect(() => normalizeExecutionOrder(target, known(), 'KEEP_KNOWN')).toThrow(/归属冲突/);
  });
});

describe('normalizeExecutionOrder historical known T after revision', () => {
  const historicalKnown = known({ executionTimeMs: 120, updatedAtMs: 100, phase: 'OPEN' });

  it('same quantity keeps historical known T even when known T is after revision', () => {
    expect(
      normalizeExecutionOrder(
        order({
          executedQuantity: 10,
          executedAmount: '100',
          executionTimeMs: 100,
          updatedAtMs: 100,
          updatedAt: new Date(100),
        }),
        historicalKnown,
        'THROW',
      ),
    ).toMatchObject({ executionTimeMs: 120, updatedAtMs: 100, executionPhase: 'OPEN' });
  });

  it('increment whose raw updatedAt regresses below known T blocks instead of taking max', () => {
    expect(() =>
      normalizeExecutionOrder(
        order({
          executedQuantity: 20,
          executedAmount: '200',
          executionTimeMs: 110,
          updatedAtMs: 110,
          updatedAt: new Date(110),
        }),
        historicalKnown,
        'THROW',
      ),
    ).toThrow(/执行时间倒退/);
  });
});
