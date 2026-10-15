/**
 * DailyLoss 全量重算的真实 owner 预检与同步发布回归。
 * 使用实际归属、金额、边界与双方向过滤路径，证明 prepare 无写、失败不污染已有基线，
 * 并拒绝伪造、跨实例、已变更状态和重复发布的候选；不替代 activation 的真实 O 原子性 oracle。
 */

import { describe, expect, it } from 'bun:test';
import { orderAnalysis } from '../../../src/domain/order/orderAnalysis.js';
import { createDailyLossTracker } from '../../../src/domain/risk/dailyLossTracker.js';
import type { MonitorConfig } from '../../../src/types/config.js';
import type { DailyLossTracker, DailyLossTrackerDeps } from '../../../src/types/risk.js';
import type { OrderFact } from '../../../src/types/trade.js';
import { toHongKongTimeIso } from '../../../src/utils/time/index.js';

const now = new Date('2026-10-07T04:00:00.000Z');
const executionTimeMs = now.getTime() - 120_000;
const boundaryExecutedTimeMs = executionTimeMs + 1_000;
const monitor: Pick<MonitorConfig, 'monitorSymbol' | 'orderOwnershipMapping'> = {
  monitorSymbol: 'HSI.HK',
  orderOwnershipMapping: ['HSI'],
};
const relatedTradingSymbols = new Set(['BULL.HK', 'BEAR.HK']);
const analysis = orderAnalysis;

function order(params: {
  readonly orderId: string;
  readonly direction: 'LONG' | 'SHORT';
  readonly side: 'BUY' | 'SELL';
  readonly price: string;
  readonly executedAmount: string;
  readonly quantity?: number;
  readonly executedAtMs?: number;
}): OrderFact {
  const quantity = params.quantity ?? 100;
  const executedAtMs = params.executedAtMs ?? executionTimeMs;
  return {
    orderId: params.orderId,
    symbol: params.direction === 'LONG' ? 'BULL.HK' : 'BEAR.HK',
    stockName: params.direction === 'LONG' ? 'HSI RC' : 'HSI RP',
    remark: '',
    executionSide: params.side,
    executionStatus: 'FILLED',
    executionPhase: 'TERMINAL',
    status: 'FILLED',
    orderType: 'LO',
    quantity,
    executedQuantity: quantity,
    price: params.price,
    executedPrice: params.price,
    executedAmount: params.executedAmount,
    executionTimeMs: executedAtMs,
    submittedAt: new Date(executedAtMs - 1000),
    updatedAtMs: executedAtMs + 30000,
    updatedAt: new Date(executedAtMs + 30000),
  };
}

const seedOrders = [
  order({
    orderId: 'LONG-BUY',
    direction: 'LONG',
    side: 'BUY',
    price: '1.25',
    executedAmount: '125',
  }),
  order({
    orderId: 'LONG-SELL',
    direction: 'LONG',
    side: 'SELL',
    price: '1.1',
    executedAmount: '110',
    executedAtMs: executionTimeMs + 10,
  }),
  order({
    orderId: 'SHORT-BUY',
    direction: 'SHORT',
    side: 'BUY',
    price: '2.75',
    executedAmount: '275',
  }),
  order({
    orderId: 'SHORT-SELL',
    direction: 'SHORT',
    side: 'SELL',
    price: '2.25',
    executedAmount: '225',
    executedAtMs: executionTimeMs + 20,
  }),
];

function createOwner(
  resolveOrderOwnership: DailyLossTrackerDeps['resolveOrderOwnership'] = analysis.resolveOrderOwnership,
): DailyLossTracker {
  return createDailyLossTracker({
    onOwnershipWarning: () => {},
    ...analysis,
    resolveOrderOwnership,
    toHongKongTimeIso,
  });
}

function inspect(owner: DailyLossTracker) {
  return {
    longOffset: owner.getLossOffset('LONG'),
    shortOffset: owner.getLossOffset('SHORT'),
    evidence: owner.getExecutionTimeEvidence(),
    longBaseline: owner.prepareProtectionBoundary({
      direction: 'LONG',
      boundaryExecutedTimeMs: now.getTime(),
    }),
    shortBaseline: owner.prepareProtectionBoundary({
      direction: 'SHORT',
      boundaryExecutedTimeMs: now.getTime(),
    }),
  };
}

function seed(owner: DailyLossTracker): void {
  owner.recalculateFromAllOrders(seedOrders, monitor, now, undefined, relatedTradingSymbols);
  expect(owner.getLossOffset('LONG')).toBe('-15');
  expect(owner.getLossOffset('SHORT')).toBe('-50');
  owner.commitProtectionBoundary(
    owner.prepareProtectionBoundary({ direction: 'LONG', boundaryExecutedTimeMs }),
  );

  owner.commitProtectionBoundary(
    owner.prepareProtectionBoundary({ direction: 'SHORT', boundaryExecutedTimeMs }),
  );
}

const nextOrders = [
  order({
    orderId: 'NEXT-LONG-BUY',
    direction: 'LONG',
    side: 'BUY',
    price: '2.5000000000000000000000000001',
    executedAmount: '250.00000000000000000000000001',
    executedAtMs: executionTimeMs + 2_000,
  }),
  order({
    orderId: 'NEXT-LONG-SELL',
    direction: 'LONG',
    side: 'SELL',
    price: '1.8',
    executedAmount: '180',
    executedAtMs: executionTimeMs + 3_000,
  }),
  order({
    orderId: 'NEXT-SHORT-BUY',
    direction: 'SHORT',
    side: 'BUY',
    price: '3.75',
    executedAmount: '375',
    executedAtMs: executionTimeMs + 4_000,
  }),
  order({
    orderId: 'NEXT-SHORT-SELL',
    direction: 'SHORT',
    side: 'SELL',
    price: '3.3',
    executedAmount: '330',
    executedAtMs: executionTimeMs + 5_000,
  }),
];

function candidateOrders(): ReadonlyArray<OrderFact> {
  return [...seedOrders, ...nextOrders];
}

describe('DailyLoss rebuild preparation', () => {
  it('reports ownership diagnostics through the injected observation without publishing prepared state', () => {
    const warnings: string[] = [];
    const owner = createDailyLossTracker({
      ...analysis,
      toHongKongTimeIso,
      onOwnershipWarning: (message) => {
        warnings.push(message);
      },
    });
    const unowned = {
      ...order({
        orderId: 'UNOWNED',
        direction: 'LONG',
        side: 'BUY',
        price: '1',
        executedAmount: '100',
      }),
      symbol: 'UNRELATED.HK',
      stockName: 'UNRELATED RC',
    };
    const prepared = owner.prepareRecalculationFromAllOrders(
      [...seedOrders, unowned],
      monitor,
      now,
      undefined,
      relatedTradingSymbols,
    );
    expect(warnings).toEqual([
      '[日内亏损追踪] 未归属订单: 当日成交5笔, 未归属1笔, 样例=UNRELATED.HK:UNRELATED RC',
    ]);
    expect(owner.getExecutionTimeEvidence()).toEqual([]);
    expect(owner.getLossOffset('LONG')).toBe('0');
    owner.publishRecalculation(prepared);
    expect(owner.getLossOffset('LONG')).toBe('-15');
    expect(owner.getLossOffset('SHORT')).toBe('-50');
    expect(warnings).toHaveLength(1);
  });

  it('uses the actual instance resolver despite default-parser acceptance, preserving sealed baselines', () => {
    const owner = createOwner((input, config) =>
      input.orderId === 'INSTANCE-REJECTED' ? null : analysis.resolveOrderOwnership(input, config),
    );
    seed(owner);
    const before = inspect(owner);
    const rejected = order({
      orderId: 'INSTANCE-REJECTED',
      direction: 'LONG',
      side: 'BUY',
      price: '9.2',
      executedAmount: '920',
      executedAtMs: executionTimeMs + 2_000,
    });
    expect(analysis.resolveOrderOwnership(rejected, monitor)).toEqual({
      monitorSymbol: 'HSI.HK',
      direction: 'LONG',
    });

    expect(() =>
      owner.prepareRecalculationFromAllOrders(
        [...seedOrders, rejected],
        monitor,
        now,
        undefined,
        relatedTradingSymbols,
      ),
    ).toThrow();
    expect(inspect(owner)).toEqual(before);
    let durableCalls = 0;
    expect(
      owner.recordCumulativeExecution(
        {
          orderId: 'LONG-BUY',
          symbol: 'BULL.HK',
          direction: 'LONG',
          side: 'BUY',
          factStage: 'TERMINAL',
          executedPrice: '9.2',
          executedQuantity: 100,
          executedTimeMs: executionTimeMs,
          orderUpdatedAtMs: executionTimeMs + 60_000,
        },
        () => {
          durableCalls += 1;
        },
      ).admission,
    ).toBe('SUPPRESSED');
    expect(durableCalls).toBe(0);
    expect(inspect(owner)).toEqual(before);
  });

  it('finishes both-direction financial projection before issuing a candidate', () => {
    const fault = new Error('actual SHORT projection failure');
    let rejectShortProjection = false;
    const projectedSymbols: string[] = [];
    const owner = createDailyLossTracker({
      onOwnershipWarning: () => {},
      ...analysis,
      toHongKongTimeIso,
      filteringEngine: {
        applyFilteringAlgorithm: (buys, sells) => {
          if (rejectShortProjection) {
            const symbol = buys[0]?.symbol;
            if (symbol !== undefined) {
              projectedSymbols.push(symbol);
            }

            if (symbol === 'BEAR.HK') {
              throw fault;
            }
          }

          return analysis.filteringEngine.applyFilteringAlgorithm(buys, sells);
        },
      },
    });
    seed(owner);
    const before = inspect(owner);
    rejectShortProjection = true;
    // LONG 已完成真实过滤后，实际实例的 SHORT 财务依赖抛错，仍不得发布任何方向。
    expect(() =>
      owner.prepareRecalculationFromAllOrders(
        candidateOrders(),
        monitor,
        now,
        undefined,
        relatedTradingSymbols,
      ),
    ).toThrow(fault);
    expect(projectedSymbols).toEqual(['BULL.HK', 'BEAR.HK']);
    expect(inspect(owner)).toEqual(before);
  });

  it('does not publish a successful preparation, then synchronously matches five-argument recalculation', () => {
    const owner = createOwner();
    const reference = createOwner();
    seed(owner);
    seed(reference);
    const before = inspect(owner);
    const boundaries = new Map<'LONG' | 'SHORT', number>([
      ['LONG', boundaryExecutedTimeMs],
      ['SHORT', boundaryExecutedTimeMs],
    ]);
    const orders = candidateOrders();
    const prepared = owner.prepareRecalculationFromAllOrders(
      orders,
      monitor,
      now,
      boundaries,
      relatedTradingSymbols,
    );
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(prepared.isCurrent()).toBe(true);
    expect(inspect(owner)).toEqual(before);
    owner.publishRecalculation(prepared);
    reference.recalculateFromAllOrders(orders, monitor, now, boundaries, relatedTradingSymbols);
    expect(owner.getLossOffset('LONG')).toBe('-70.00000000000000000000000001');
    expect(owner.getLossOffset('SHORT')).toBe('-45');
    expect(owner.getExecutionTimeEvidence()).toHaveLength(8);
    expect(inspect(owner)).toEqual(inspect(reference));
    expect(prepared.isCurrent()).toBe(false);
    const committed = inspect(owner);
    expect(() => {
      owner.publishRecalculation(prepared);
    }).toThrow('stale');
    expect(inspect(owner)).toEqual(committed);
  });

  it('rejects foreign and fabricated candidates without consulting untrusted current callbacks', () => {
    const owner = createOwner();
    const other = createOwner();
    seed(owner);
    seed(other);
    const before = inspect(owner);
    const otherBefore = inspect(other);
    const prepared = owner.prepareRecalculationFromAllOrders(
      candidateOrders(),
      monitor,
      now,
      undefined,
      relatedTradingSymbols,
    );
    expect(() => {
      other.publishRecalculation(prepared);
    }).toThrow('not issued by this owner');
    expect(inspect(other)).toEqual(otherBefore);
    let untrustedChecks = 0;
    expect(() => {
      owner.publishRecalculation({
        isCurrent: () => {
          untrustedChecks += 1;
          return true;
        },
      });
    }).toThrow('not issued by this owner');
    expect(untrustedChecks).toBe(0);
    expect(inspect(owner)).toEqual(before);
    expect(prepared.isCurrent()).toBe(true);
    owner.publishRecalculation(prepared);
    expect(owner.getLossOffset('LONG')).toBe('-70.00000000000000000000000001');
    expect(owner.getLossOffset('SHORT')).toBe('-45');
  });

  it('cannot restore yesterday after a real trading-day reset between preparation and publication', () => {
    const owner = createOwner();
    seed(owner);
    const prepared = owner.prepareRecalculationFromAllOrders(
      candidateOrders(),
      monitor,
      now,
      undefined,
      relatedTradingSymbols,
    );
    const nextDay = new Date('2026-10-08T04:00:00.000Z');
    owner.resetAll(nextDay);
    const cleared = inspect(owner);
    expect(prepared.isCurrent()).toBe(false);
    expect(() => {
      owner.publishRecalculation(prepared);
    }).toThrow('stale');
    expect(inspect(owner)).toEqual(cleared);
    expect(owner.getExecutionTimeEvidence()).toEqual([]);
    expect(owner.getLossOffset('LONG')).toBe('0');
    expect(owner.getLossOffset('SHORT')).toBe('0');
  });

  it('invalidates preparation for restored execution history even when current amounts and offsets are unchanged', () => {
    const owner = createOwner();
    seed(owner);
    const prepared = owner.prepareRecalculationFromAllOrders(
      candidateOrders(),
      monitor,
      now,
      undefined,
      relatedTradingSymbols,
    );
    owner.restoreExecutionSnapshot({
      orderId: 'LONG-BUY',
      symbol: 'BULL.HK',
      direction: 'LONG',
      side: 'BUY',
      factStage: 'OPEN',
      cumulativeQuantity: '50',
      cumulativeAmount: '62.5',
      lastExecutionTimeMs: executionTimeMs - 1,
      orderRevisionMs: executionTimeMs,
    });
    const withHistory = inspect(owner);
    expect(prepared.isCurrent()).toBe(false);
    expect(() => {
      owner.publishRecalculation(prepared);
    }).toThrow('stale');
    expect(inspect(owner)).toEqual(withHistory);
  });
});
