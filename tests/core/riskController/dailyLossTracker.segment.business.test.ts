/**
 * dailyLossTracker 分段业务测试
 *
 * 功能：
 * - 验证保护性清仓边界推进后的分段过滤、幂等重置与启动恢复边界语义。
 */
import { describe, expect, it } from 'bun:test';
import { OrderSide, OrderStatus, OrderType } from 'longbridge';
import { createDailyLossTracker } from '../../../src/core/riskController/dailyLossTracker.js';
import { createDailyLossOrderAnalysisDeps } from '../../../src/core/orderRecorder/index.js';
import { toHongKongTimeIso } from '../../../src/utils/time/index.js';
import type { MonitorConfig } from '../../../src/types/config.js';
import type { OrderOwnership } from '../../../src/types/orderRecorder.js';
import type {
  DailyLossCumulativeExecutionInput,
  DailyLossTracker,
} from '../../../src/types/risk.js';
import type { RawOrderFromAPI } from '../../../src/types/services.js';

function createExecutedOrder(params: {
  readonly orderId: string;
  readonly symbol: string;
  readonly side: OrderSide;
  readonly status?: OrderStatus;
  readonly stockName?: string;
  readonly executedPrice: number;
  readonly executedQuantity: number;
  readonly updatedAtMs: number;
}): RawOrderFromAPI {
  const updatedAt = new Date(params.updatedAtMs);
  return {
    orderId: params.orderId,
    symbol: params.symbol,
    stockName: params.stockName ?? params.symbol,
    side: params.side,
    status: params.status ?? OrderStatus.Filled,
    orderType: OrderType.ELO,
    remark: null,
    price: params.executedPrice,
    quantity: params.executedQuantity,
    executedPrice: params.executedPrice,
    executedQuantity: params.executedQuantity,
    submittedAt: updatedAt,
    updatedAt,
  };
}

function createMonitor(): Pick<MonitorConfig, 'monitorSymbol' | 'orderOwnershipMapping'> {
  return {
    monitorSymbol: 'HSI.HK',
    orderOwnershipMapping: [],
  };
}

function resolveOrderOwnership(order: RawOrderFromAPI): OrderOwnership | null {
  if (order.symbol === 'BULL.HK') {
    return { monitorSymbol: 'HSI.HK', direction: 'LONG' };
  }

  if (order.symbol === 'BEAR.HK') {
    return { monitorSymbol: 'HSI.HK', direction: 'SHORT' };
  }

  return null;
}

type SegmentTestTracker = Omit<DailyLossTracker, 'recordCumulativeExecution'> & {
  readonly recordCumulativeExecution: (
    input: Omit<DailyLossCumulativeExecutionInput, 'factStage'> & {
      readonly factStage?: DailyLossCumulativeExecutionInput['factStage'];
    },
  ) => ReturnType<DailyLossTracker['recordCumulativeExecution']>;
};

function createSegmentTracker(): SegmentTestTracker {
  const orderAnalysisDeps = createDailyLossOrderAnalysisDeps();
  const tracker = createDailyLossTracker({
    ...orderAnalysisDeps,
    resolveOrderOwnership: (order) => resolveOrderOwnership(order),
    toHongKongTimeIso,
  });
  return {
    ...tracker,
    recordCumulativeExecution: (input) =>
      tracker.recordCumulativeExecution({ factStage: 'TERMINAL', ...input }),
  };
}

function commitPreparedBoundary(
  tracker: DailyLossTracker,
  params: Parameters<DailyLossTracker['prepareProtectionBoundary']>[0],
): void {
  tracker.commitProtectionBoundary(tracker.prepareProtectionBoundary(params));
}

describe('dailyLossTracker segment flow', () => {
  it('selects the protection-boundary snapshot by the established lexicographic priority', () => {
    const boundaryMs = Date.parse('2026-07-11T02:00:00.000Z');
    const currentUpdatedAtMs = boundaryMs + 100;
    const cases = [
      {
        name: 'filters snapshots after the boundary first',
        snapshots: [
          {
            factStage: 'TERMINAL' as const,
            cumulativeQuantity: '20',
            cumulativeAmount: '200',
            lastExecutionTimeMs: boundaryMs - 10,
            orderRevisionMs: boundaryMs - 5,
          },
          {
            factStage: 'TERMINAL' as const,
            cumulativeQuantity: '90',
            cumulativeAmount: '900',
            lastExecutionTimeMs: boundaryMs + 1,
            orderRevisionMs: boundaryMs + 1,
          },
        ],
        expectedQuantity: '20',
        expectedAmount: '200',
        expectedExecutionTimeMs: boundaryMs - 10,
        expectedRevisionMs: boundaryMs - 5,
      },
      {
        name: 'prefers the later execution time before all revision fields',
        snapshots: [
          {
            factStage: 'TERMINAL' as const,
            cumulativeQuantity: '90',
            cumulativeAmount: '900',
            lastExecutionTimeMs: boundaryMs - 20,
            orderRevisionMs: boundaryMs - 1,
          },
          {
            factStage: 'OPEN' as const,
            cumulativeQuantity: '10',
            cumulativeAmount: '100',
            lastExecutionTimeMs: boundaryMs - 10,
            orderRevisionMs: boundaryMs - 10,
          },
        ],
        expectedQuantity: '10',
        expectedAmount: '100',
        expectedExecutionTimeMs: boundaryMs - 10,
        expectedRevisionMs: boundaryMs - 10,
      },
      {
        name: 'prefers the later order revision at the same execution time',
        snapshots: [
          {
            factStage: 'TERMINAL' as const,
            cumulativeQuantity: '90',
            cumulativeAmount: '900',
            lastExecutionTimeMs: boundaryMs - 10,
            orderRevisionMs: boundaryMs - 5,
          },
          {
            factStage: 'OPEN' as const,
            cumulativeQuantity: '10',
            cumulativeAmount: '100',
            lastExecutionTimeMs: boundaryMs - 10,
            orderRevisionMs: boundaryMs - 1,
          },
        ],
        expectedQuantity: '10',
        expectedAmount: '100',
        expectedExecutionTimeMs: boundaryMs - 10,
        expectedRevisionMs: boundaryMs - 1,
      },
      {
        name: 'prefers the larger cumulative quantity at the same execution and revision',
        snapshots: [
          {
            factStage: 'TERMINAL' as const,
            cumulativeQuantity: '20',
            cumulativeAmount: '200',
            lastExecutionTimeMs: boundaryMs - 10,
            orderRevisionMs: boundaryMs - 5,
          },
          {
            factStage: 'OPEN' as const,
            cumulativeQuantity: '40',
            cumulativeAmount: '400',
            lastExecutionTimeMs: boundaryMs - 10,
            orderRevisionMs: boundaryMs - 5,
          },
        ],
        expectedQuantity: '40',
        expectedAmount: '400',
        expectedExecutionTimeMs: boundaryMs - 10,
        expectedRevisionMs: boundaryMs - 5,
      },
      {
        name: 'prefers TERMINAL over OPEN when all numeric fields tie',
        snapshots: [
          {
            factStage: 'OPEN' as const,
            cumulativeQuantity: '40',
            cumulativeAmount: '360',
            lastExecutionTimeMs: boundaryMs - 10,
            orderRevisionMs: boundaryMs - 5,
          },
          {
            factStage: 'TERMINAL' as const,
            cumulativeQuantity: '40',
            cumulativeAmount: '380',
            lastExecutionTimeMs: boundaryMs - 10,
            orderRevisionMs: boundaryMs - 5,
          },
        ],
        expectedQuantity: '40',
        expectedAmount: '380',
        expectedExecutionTimeMs: boundaryMs - 10,
        expectedRevisionMs: boundaryMs - 5,
      },
    ] as const;

    for (const testCase of cases) {
      const tracker = createSegmentTracker();
      tracker.recalculateFromAllOrders(
        [
          createExecutedOrder({
            orderId: 'BOUNDARY-SELECTOR',
            symbol: 'BULL.HK',
            side: OrderSide.Buy,
            executedPrice: 10,
            executedQuantity: 100,
            updatedAtMs: currentUpdatedAtMs,
          }),
        ],
        createMonitor(),
        new Date(currentUpdatedAtMs),
        new Map(),
      );

      for (const snapshot of testCase.snapshots) {
        tracker.restoreExecutionSnapshot({
          direction: 'LONG',
          symbol: 'BULL.HK',
          side: OrderSide.Buy,
          orderId: 'BOUNDARY-SELECTOR',
          ...snapshot,
        });
      }

      const prepared = tracker.prepareProtectionBoundary({
        direction: 'LONG',
        boundaryExecutedTimeMs: boundaryMs,
      });

      expect(prepared.orderBaselines, testCase.name).toEqual([
        {
          orderId: 'BOUNDARY-SELECTOR',
          symbol: 'BULL.HK',
          side: 'BUY',
          cumulativeQuantity: testCase.expectedQuantity,
          cumulativeAmount: testCase.expectedAmount,
          lastExecutionTimeMs: testCase.expectedExecutionTimeMs,
          orderRevisionMs: testCase.expectedRevisionMs,
        },
      ]);

      expect(() => {
        tracker.restoreProtectionBoundary(prepared);
      }, testCase.name).not.toThrow();
    }
  });

  it('keeps rebuild, prepare, and restore aligned on the same boundary snapshot', () => {
    const boundaryMs = Date.parse('2026-07-11T02:00:00.000Z');
    const currentUpdatedAtMs = boundaryMs + 100;
    const currentOrders = [
      createExecutedOrder({
        orderId: 'BUY-SELECTOR-CONSISTENCY',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
        executedPrice: 10,
        executedQuantity: 100,
        updatedAtMs: currentUpdatedAtMs,
      }),
      createExecutedOrder({
        orderId: 'SELL-SELECTOR-CONSISTENCY',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        executedPrice: 9,
        executedQuantity: 100,
        updatedAtMs: currentUpdatedAtMs,
      }),
    ];

    function restoreBoundarySnapshots(tracker: DailyLossTracker): void {
      for (const [orderId, side, cumulativeAmount] of [
        ['BUY-SELECTOR-CONSISTENCY', OrderSide.Buy, '400'],
        ['SELL-SELECTOR-CONSISTENCY', OrderSide.Sell, '360'],
      ] as const) {
        for (const factStage of ['OPEN', 'TERMINAL'] as const) {
          tracker.restoreExecutionSnapshot({
            factStage,
            direction: 'LONG',
            symbol: 'BULL.HK',
            side,
            cumulativeQuantity: '40',
            cumulativeAmount,
            lastExecutionTimeMs: boundaryMs - 10,
            orderRevisionMs: boundaryMs - 5,
            orderId,
          });
        }
      }
    }

    const live = createSegmentTracker();
    live.recalculateFromAllOrders(
      currentOrders,
      createMonitor(),
      new Date(currentUpdatedAtMs),
      new Map(),
    );
    restoreBoundarySnapshots(live);
    const prepared = live.prepareProtectionBoundary({
      direction: 'LONG',
      boundaryExecutedTimeMs: boundaryMs,
    });
    live.commitProtectionBoundary(prepared);
    expect(live.getLossOffset('LONG')).toBe(-60);

    live.recalculateFromAllOrders(currentOrders, createMonitor(), new Date(currentUpdatedAtMs));
    expect(live.getLossOffset('LONG')).toBe(-60);

    const restarted = createSegmentTracker();
    restarted.recalculateFromAllOrders(
      currentOrders,
      createMonitor(),
      new Date(currentUpdatedAtMs),
      new Map(),
    );
    restoreBoundarySnapshots(restarted);
    restarted.restoreProtectionBoundary(prepared);
    expect(restarted.getLossOffset('LONG')).toBe(-60);
  });

  it('derives execution progress from cumulative facts and keeps an equal terminal revision idempotent', () => {
    const tracker = createSegmentTracker();
    tracker.resetAll(new Date('2026-07-11T01:00:00.000Z'));

    const partialResult = tracker.recordCumulativeExecution({
      direction: 'LONG',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      executedPrice: 0.9,
      executedQuantity: 40,
      executedTimeMs: Date.parse('2026-07-11T02:00:00.000Z'),
      orderUpdatedAtMs: Date.parse('2026-07-11T02:00:00.000Z'),
      orderId: 'PROTECTIVE-1',
    });
    const terminalResult = tracker.recordCumulativeExecution({
      direction: 'LONG',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      executedPrice: 0.9,
      executedQuantity: 40,
      executedTimeMs: Date.parse('2026-07-11T02:00:00.000Z'),
      orderUpdatedAtMs: Date.parse('2026-07-11T02:01:00.000Z'),
      orderId: 'PROTECTIVE-1',
    });

    expect(partialResult).toEqual({ authoritativeFactChanged: true, executionAdvanced: true });
    expect(terminalResult).toEqual({ authoritativeFactChanged: true, executionAdvanced: false });
  });

  it('derives 40 to 100 cumulative execution as one further execution advance', () => {
    const tracker = createSegmentTracker();
    tracker.resetAll(new Date('2026-07-11T01:00:00.000Z'));

    tracker.recordCumulativeExecution({
      factStage: 'OPEN',
      direction: 'LONG',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      executedPrice: 0.9,
      executedQuantity: 40,
      executedTimeMs: Date.parse('2026-07-11T02:00:00.000Z'),
      orderUpdatedAtMs: Date.parse('2026-07-11T02:00:00.000Z'),
      orderId: 'PROTECTIVE-2',
    });
    const finalResult = tracker.recordCumulativeExecution({
      direction: 'LONG',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      executedPrice: 0.95,
      executedQuantity: 100,
      executedTimeMs: Date.parse('2026-07-11T02:02:00.000Z'),
      orderUpdatedAtMs: Date.parse('2026-07-11T02:02:00.000Z'),
      orderId: 'PROTECTIVE-2',
    });

    expect(finalResult).toEqual({ authoritativeFactChanged: true, executionAdvanced: true });
  });

  it('accepts cumulative quantity growth at the same order revision and updates the amount snapshot', () => {
    const tracker = createSegmentTracker();
    const revisionMs = Date.parse('2026-07-11T02:00:00.000Z');
    tracker.resetAll(new Date('2026-07-11T01:00:00.000Z'));

    tracker.recordCumulativeExecution({
      factStage: 'OPEN',
      direction: 'LONG',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      executedPrice: 0.9,
      executedQuantity: 40,
      executedTimeMs: revisionMs,
      orderUpdatedAtMs: revisionMs,
      orderId: 'PROTECTIVE-SAME-REVISION',
    });
    const advanced = tracker.recordCumulativeExecution({
      direction: 'LONG',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      executedPrice: 0.95,
      executedQuantity: 100,
      executedTimeMs: revisionMs,
      orderUpdatedAtMs: revisionMs,
      orderId: 'PROTECTIVE-SAME-REVISION',
    });

    expect(advanced).toEqual({ authoritativeFactChanged: true, executionAdvanced: true });
    expect(
      tracker.prepareProtectionBoundary({
        direction: 'LONG',
        boundaryExecutedTimeMs: revisionMs,
      }).orderBaselines,
    ).toEqual([
      {
        orderId: 'PROTECTIVE-SAME-REVISION',
        symbol: 'BULL.HK',
        side: 'SELL',
        cumulativeQuantity: '100',
        cumulativeAmount: '95',
        lastExecutionTimeMs: revisionMs,
        orderRevisionMs: revisionMs,
      },
    ]);
  });

  it('rejects equal-quantity amount conflicts at the same order revision', () => {
    const tracker = createSegmentTracker();
    const revisionMs = Date.parse('2026-07-11T02:00:00.000Z');
    tracker.resetAll(new Date('2026-07-11T01:00:00.000Z'));
    tracker.recordCumulativeExecution({
      factStage: 'OPEN',
      direction: 'LONG',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      executedPrice: 0.9,
      executedQuantity: 40,
      executedTimeMs: revisionMs,
      orderUpdatedAtMs: revisionMs,
      orderId: 'PROTECTIVE-SAME-REVISION-CONFLICT',
    });

    expect(() =>
      tracker.recordCumulativeExecution({
        factStage: 'OPEN',
        direction: 'LONG',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        executedPrice: 0.95,
        executedQuantity: 40,
        executedTimeMs: revisionMs,
        orderUpdatedAtMs: revisionMs,
        orderId: 'PROTECTIVE-SAME-REVISION-CONFLICT',
      }),
    ).toThrow(/revision conflict/);
  });

  it('allows same-revision equal-quantity amount correction only when OPEN advances to TERMINAL', () => {
    const tracker = createSegmentTracker();
    const revisionMs = Date.parse('2026-07-11T02:00:00.000Z');
    tracker.resetAll(new Date('2026-07-11T01:00:00.000Z'));

    tracker.recordCumulativeExecution({
      factStage: 'OPEN',
      direction: 'LONG',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      executedPrice: 0.9,
      executedQuantity: 40,
      executedTimeMs: revisionMs,
      orderUpdatedAtMs: revisionMs,
      orderId: 'PROTECTIVE-SAME-REVISION-TERMINAL-CORRECTION',
    });
    const correction = tracker.recordCumulativeExecution({
      factStage: 'TERMINAL',
      direction: 'LONG',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      executedPrice: 0.95,
      executedQuantity: 40,
      executedTimeMs: revisionMs,
      orderUpdatedAtMs: revisionMs,
      orderId: 'PROTECTIVE-SAME-REVISION-TERMINAL-CORRECTION',
    });

    expect(correction).toEqual({ authoritativeFactChanged: true, executionAdvanced: false });
    expect(
      tracker.prepareProtectionBoundary({
        direction: 'LONG',
        boundaryExecutedTimeMs: revisionMs,
      }).orderBaselines,
    ).toEqual([
      {
        orderId: 'PROTECTIVE-SAME-REVISION-TERMINAL-CORRECTION',
        symbol: 'BULL.HK',
        side: 'SELL',
        cumulativeQuantity: '40',
        cumulativeAmount: '38',
        lastExecutionTimeMs: revisionMs,
        orderRevisionMs: revisionMs,
      },
    ]);

    expect(() =>
      tracker.recordCumulativeExecution({
        factStage: 'OPEN',
        direction: 'LONG',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        executedPrice: 0.95,
        executedQuantity: 40,
        executedTimeMs: revisionMs,
        orderUpdatedAtMs: revisionMs,
        orderId: 'PROTECTIVE-SAME-REVISION-TERMINAL-CORRECTION',
      }),
    ).toThrow(/TERMINAL.*OPEN|stage regression/);
  });

  it('restores the same cross-boundary offset from persisted per-order baselines after restart', () => {
    const boundaryMs = Date.parse('2026-07-11T02:00:00.000Z');
    const finalMs = Date.parse('2026-07-11T02:02:00.000Z');
    const live = createSegmentTracker();
    live.resetAll(new Date('2026-07-11T01:00:00.000Z'));
    live.recordCumulativeExecution({
      direction: 'LONG',
      symbol: 'BULL.HK',
      side: OrderSide.Buy,
      executedPrice: 1,
      executedQuantity: 100,
      executedTimeMs: boundaryMs - 10,
      orderUpdatedAtMs: boundaryMs - 10,
      orderId: 'BUY-PRE',
    });

    live.recordCumulativeExecution({
      direction: 'LONG',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      executedPrice: 0.9,
      executedQuantity: 40,
      executedTimeMs: boundaryMs,
      orderUpdatedAtMs: boundaryMs,
      orderId: 'SELL-PROTECTIVE',
    });
    const persistedBoundary = live.prepareProtectionBoundary({
      direction: 'LONG',
      boundaryExecutedTimeMs: boundaryMs,
    });
    live.commitProtectionBoundary(persistedBoundary);
    live.recordCumulativeExecution({
      direction: 'LONG',
      symbol: 'BULL.HK',
      side: OrderSide.Buy,
      executedPrice: 1,
      executedQuantity: 60,
      executedTimeMs: finalMs - 10,
      orderUpdatedAtMs: finalMs - 10,
      orderId: 'BUY-POST',
    });

    live.recordCumulativeExecution({
      direction: 'LONG',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      executedPrice: 0.9,
      executedQuantity: 100,
      executedTimeMs: finalMs,
      orderUpdatedAtMs: finalMs,
      orderId: 'SELL-PROTECTIVE',
    });

    const restarted = createSegmentTracker();
    restarted.recalculateFromAllOrders(
      [
        createExecutedOrder({
          orderId: 'BUY-PRE',
          symbol: 'BULL.HK',
          side: OrderSide.Buy,
          executedPrice: 1,
          executedQuantity: 100,
          updatedAtMs: boundaryMs - 10,
        }),
        createExecutedOrder({
          orderId: 'BUY-POST',
          symbol: 'BULL.HK',
          side: OrderSide.Buy,
          executedPrice: 1,
          executedQuantity: 60,
          updatedAtMs: finalMs - 10,
        }),
        createExecutedOrder({
          orderId: 'SELL-PROTECTIVE',
          symbol: 'BULL.HK',
          side: OrderSide.Sell,
          executedPrice: 0.9,
          executedQuantity: 100,
          updatedAtMs: finalMs,
        }),
      ],
      createMonitor(),
      new Date(finalMs),
      new Map(),
    );
    restarted.restoreProtectionBoundary(persistedBoundary);

    expect(restarted.getLossOffset('LONG')).toBe(live.getLossOffset('LONG'));
    expect(restarted.getLossOffset('LONG')).toBe(-6);
  });

  it('blocks restart when a persisted baseline identity conflicts with the current order', () => {
    const tracker = createSegmentTracker();
    const boundaryMs = Date.parse('2026-07-11T02:00:00.000Z');
    tracker.recalculateFromAllOrders(
      [
        createExecutedOrder({
          orderId: 'BUY-1',
          symbol: 'BULL.HK',
          side: OrderSide.Buy,
          executedPrice: 1,
          executedQuantity: 100,
          updatedAtMs: boundaryMs,
        }),
      ],
      createMonitor(),
      new Date(boundaryMs),
      new Map(),
    );

    expect(() => {
      tracker.restoreProtectionBoundary({
        direction: 'LONG',
        boundaryExecutedTimeMs: boundaryMs,
        orderBaselines: [
          {
            orderId: 'BUY-1',
            symbol: 'BEAR.HK',
            side: 'BUY',
            cumulativeQuantity: '100',
            cumulativeAmount: '100',
            lastExecutionTimeMs: boundaryMs,
            orderRevisionMs: boundaryMs,
          },
        ],
      });
    }).toThrow(/identity conflict/);
  });

  it('blocks restart when a determinable pre-boundary order baseline is omitted', () => {
    const tracker = createSegmentTracker();
    const boundaryMs = Date.parse('2026-07-11T02:00:00.000Z');
    tracker.recalculateFromAllOrders(
      [
        createExecutedOrder({
          orderId: 'BUY-REQUIRED-BASELINE',
          symbol: 'BULL.HK',
          side: OrderSide.Buy,
          executedPrice: 1,
          executedQuantity: 100,
          updatedAtMs: boundaryMs,
        }),
      ],
      createMonitor(),
      new Date(boundaryMs),
      new Map(),
    );

    expect(() => {
      tracker.restoreProtectionBoundary({
        direction: 'LONG',
        boundaryExecutedTimeMs: boundaryMs,
        orderBaselines: [],
      });
    }).toThrow(/baseline set incomplete.*BUY-REQUIRED-BASELINE/);
  });

  it('blocks restart when a persisted baseline is extra for a post-boundary execution', () => {
    const tracker = createSegmentTracker();
    const boundaryMs = Date.parse('2026-07-11T02:00:00.000Z');
    const afterBoundaryMs = boundaryMs + 1;
    tracker.recalculateFromAllOrders(
      [
        createExecutedOrder({
          orderId: 'BUY-AFTER-BOUNDARY',
          symbol: 'BULL.HK',
          side: OrderSide.Buy,
          executedPrice: 1,
          executedQuantity: 100,
          updatedAtMs: afterBoundaryMs,
        }),
      ],
      createMonitor(),
      new Date(afterBoundaryMs),
      new Map(),
    );

    expect(() => {
      tracker.restoreProtectionBoundary({
        direction: 'LONG',
        boundaryExecutedTimeMs: boundaryMs,
        orderBaselines: [
          {
            orderId: 'BUY-AFTER-BOUNDARY',
            symbol: 'BULL.HK',
            side: 'BUY',
            cumulativeQuantity: '100',
            cumulativeAmount: '100',
            lastExecutionTimeMs: afterBoundaryMs,
            orderRevisionMs: afterBoundaryMs,
          },
        ],
      });
    }).toThrow(/unexpected persisted baseline.*BUY-AFTER-BOUNDARY/);
  });

  it('blocks restart when a collapsed cross-boundary ordinary BUY is absent from completion baselines', () => {
    const tracker = createSegmentTracker();
    const boundaryMs = Date.parse('2026-07-11T02:00:00.000Z');
    const finalExecutionMs = boundaryMs + 60_000;
    tracker.recalculateFromAllOrders(
      [
        // 业务事实为边界前 40@10、边界后累计 100@1600；RawOrder 只能给出折叠后的最终总值。
        {
          ...createExecutedOrder({
            orderId: 'ORDINARY-BUY-CROSSING-BOUNDARY',
            symbol: 'BULL.HK',
            side: OrderSide.Buy,
            executedPrice: 16,
            executedQuantity: 100,
            updatedAtMs: finalExecutionMs,
          }),
          submittedAt: new Date(boundaryMs - 60_000),
        },
        createExecutedOrder({
          orderId: 'PROTECTIVE-SELL-AT-BOUNDARY',
          symbol: 'BULL.HK',
          side: OrderSide.Sell,
          executedPrice: 9,
          executedQuantity: 40,
          updatedAtMs: boundaryMs,
        }),
      ],
      createMonitor(),
      new Date(finalExecutionMs),
      new Map(),
    );

    expect(() => {
      tracker.restoreProtectionBoundary({
        direction: 'LONG',
        boundaryExecutedTimeMs: boundaryMs,
        orderBaselines: [
          {
            orderId: 'PROTECTIVE-SELL-AT-BOUNDARY',
            symbol: 'BULL.HK',
            side: 'SELL',
            cumulativeQuantity: '40',
            cumulativeAmount: '360',
            lastExecutionTimeMs: boundaryMs,
            orderRevisionMs: boundaryMs,
          },
        ],
      });
    }).toThrow(/cannot reconstruct.*ORDINARY-BUY-CROSSING-BOUNDARY/i);
  });

  it('restores a collapsed cross-boundary ordinary BUY from its persisted completion baseline', () => {
    const tracker = createSegmentTracker();
    const boundaryMs = Date.parse('2026-07-11T02:00:00.000Z');
    const preBoundaryExecutionMs = boundaryMs - 60_000;
    const finalExecutionMs = boundaryMs + 60_000;
    tracker.recalculateFromAllOrders(
      [
        // 业务事实为边界前 40@10、边界后累计 100@1600；RawOrder 只保留边界后的最终累计值。
        {
          ...createExecutedOrder({
            orderId: 'ORDINARY-BUY-CROSSING-PERSISTED-BASELINE',
            symbol: 'BULL.HK',
            side: OrderSide.Buy,
            executedPrice: 16,
            executedQuantity: 100,
            updatedAtMs: finalExecutionMs,
          }),
          submittedAt: new Date(boundaryMs - 120_000),
        },
        createExecutedOrder({
          orderId: 'PROTECTIVE-SELL-AT-PERSISTED-BOUNDARY',
          symbol: 'BULL.HK',
          side: OrderSide.Sell,
          executedPrice: 9,
          executedQuantity: 40,
          updatedAtMs: boundaryMs,
        }),
      ],
      createMonitor(),
      new Date(finalExecutionMs),
      new Map(),
    );

    expect(() => {
      tracker.restoreProtectionBoundary({
        direction: 'LONG',
        boundaryExecutedTimeMs: boundaryMs,
        orderBaselines: [
          {
            orderId: 'ORDINARY-BUY-CROSSING-PERSISTED-BASELINE',
            symbol: 'BULL.HK',
            side: 'BUY',
            cumulativeQuantity: '40',
            cumulativeAmount: '400',
            lastExecutionTimeMs: preBoundaryExecutionMs,
            orderRevisionMs: preBoundaryExecutionMs,
          },
          {
            orderId: 'PROTECTIVE-SELL-AT-PERSISTED-BOUNDARY',
            symbol: 'BULL.HK',
            side: 'SELL',
            cumulativeQuantity: '40',
            cumulativeAmount: '360',
            lastExecutionTimeMs: boundaryMs,
            orderRevisionMs: boundaryMs,
          },
        ],
      });
    }).not.toThrow();
  });

  it('allows a collapsed post-boundary ordinary BUY to be absent from completion baselines', () => {
    const tracker = createSegmentTracker();
    const boundaryMs = Date.parse('2026-07-11T02:00:00.000Z');
    const finalExecutionMs = boundaryMs + 60_000;
    tracker.recalculateFromAllOrders(
      [
        {
          ...createExecutedOrder({
            orderId: 'ORDINARY-BUY-SUBMITTED-AFTER-BOUNDARY',
            symbol: 'BULL.HK',
            side: OrderSide.Buy,
            executedPrice: 16,
            executedQuantity: 100,
            updatedAtMs: finalExecutionMs,
          }),
          submittedAt: new Date(boundaryMs + 1),
        },
        createExecutedOrder({
          orderId: 'PROTECTIVE-SELL-AT-BOUNDARY',
          symbol: 'BULL.HK',
          side: OrderSide.Sell,
          executedPrice: 9,
          executedQuantity: 40,
          updatedAtMs: boundaryMs,
        }),
      ],
      createMonitor(),
      new Date(finalExecutionMs),
      new Map(),
    );

    expect(() => {
      tracker.restoreProtectionBoundary({
        direction: 'LONG',
        boundaryExecutedTimeMs: boundaryMs,
        orderBaselines: [
          {
            orderId: 'PROTECTIVE-SELL-AT-BOUNDARY',
            symbol: 'BULL.HK',
            side: 'SELL',
            cumulativeQuantity: '40',
            cumulativeAmount: '360',
            lastExecutionTimeMs: boundaryMs,
            orderRevisionMs: boundaryMs,
          },
        ],
      });
    }).not.toThrow();
  });

  for (const testCase of [
    { name: 'missing submittedAt', resolveSubmittedAt: (_boundaryMs: number) => null },
    {
      name: 'invalid submittedAt',
      resolveSubmittedAt: (_boundaryMs: number) => new Date(Number.NaN),
    },
    {
      name: 'submittedAt equal to the boundary',
      resolveSubmittedAt: (boundaryMs: number) => new Date(boundaryMs),
    },
  ]) {
    it(`blocks a collapsed ordinary BUY without a strict post-boundary submission proof: ${testCase.name}`, () => {
      const tracker = createSegmentTracker();
      const boundaryMs = Date.parse('2026-07-11T02:00:00.000Z');
      const finalExecutionMs = boundaryMs + 60_000;
      tracker.recalculateFromAllOrders(
        [
          {
            ...createExecutedOrder({
              orderId: 'ORDINARY-BUY-UNPROVEN-BOUNDARY',
              symbol: 'BULL.HK',
              side: OrderSide.Buy,
              executedPrice: 16,
              executedQuantity: 100,
              updatedAtMs: finalExecutionMs,
            }),
            submittedAt: testCase.resolveSubmittedAt(boundaryMs),
          },
          createExecutedOrder({
            orderId: 'PROTECTIVE-SELL-AT-BOUNDARY',
            symbol: 'BULL.HK',
            side: OrderSide.Sell,
            executedPrice: 9,
            executedQuantity: 40,
            updatedAtMs: boundaryMs,
          }),
        ],
        createMonitor(),
        new Date(finalExecutionMs),
        new Map(),
      );

      expect(() => {
        tracker.restoreProtectionBoundary({
          direction: 'LONG',
          boundaryExecutedTimeMs: boundaryMs,
          orderBaselines: [
            {
              orderId: 'PROTECTIVE-SELL-AT-BOUNDARY',
              symbol: 'BULL.HK',
              side: 'SELL',
              cumulativeQuantity: '40',
              cumulativeAmount: '360',
              lastExecutionTimeMs: boundaryMs,
              orderRevisionMs: boundaryMs,
            },
          ],
        });
      }).toThrow(/cannot reconstruct.*ORDINARY-BUY-UNPROVEN-BOUNDARY/i);
    });
  }

  it('blocks crash-gap completion when a collapsed startup order cannot reconstruct the boundary baseline', () => {
    const tracker = createSegmentTracker();
    const boundaryMs = Date.parse('2026-07-11T02:00:00.000Z');
    tracker.recalculateFromAllOrders(
      [
        createExecutedOrder({
          orderId: 'SELL-COLLAPSED',
          symbol: 'BULL.HK',
          side: OrderSide.Sell,
          executedPrice: 0.9,
          executedQuantity: 100,
          updatedAtMs: boundaryMs + 60_000,
        }),
      ],
      createMonitor(),
      new Date(boundaryMs + 60_000),
      new Map(),
    );

    expect(() =>
      tracker.prepareProtectionBoundary({
        direction: 'LONG',
        boundaryExecutedTimeMs: boundaryMs,
      }),
    ).toThrow(/无法精确冻结/);
  });

  it('keeps a pre-boundary partial watermark when an equal terminal revision arrives later', () => {
    const tracker = createSegmentTracker();
    const monitor = createMonitor();
    const now = new Date('2026-03-03T02:00:00.000Z');
    const partialTimeMs = Date.parse('2026-03-03T01:00:00.000Z');
    const boundaryMs = Date.parse('2026-03-03T01:10:00.000Z');

    tracker.recalculateFromAllOrders([], monitor, now);
    tracker.recordCumulativeExecution({
      direction: 'LONG',
      symbol: 'BULL.HK',
      side: OrderSide.Buy,
      executedPrice: 10,
      executedQuantity: 40,
      executedTimeMs: partialTimeMs,
      orderUpdatedAtMs: partialTimeMs,
      orderId: 'buy-cross-boundary',
    });

    commitPreparedBoundary(tracker, {
      direction: 'LONG',
      boundaryExecutedTimeMs: boundaryMs,
    });

    tracker.recordCumulativeExecution({
      direction: 'LONG',
      symbol: 'BULL.HK',
      side: OrderSide.Buy,
      executedPrice: 10,
      executedQuantity: 40,
      executedTimeMs: partialTimeMs,
      orderUpdatedAtMs: boundaryMs + 1,
      orderId: 'buy-cross-boundary',
    });

    tracker.recordCumulativeExecution({
      direction: 'LONG',
      symbol: 'BULL.HK',
      side: OrderSide.Buy,
      executedPrice: 10,
      executedQuantity: 100,
      executedTimeMs: boundaryMs + 2,
      orderUpdatedAtMs: boundaryMs + 2,
      orderId: 'buy-cross-boundary',
    });

    tracker.recordCumulativeExecution({
      direction: 'LONG',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      executedPrice: 9,
      executedQuantity: 60,
      executedTimeMs: boundaryMs + 3,
      orderUpdatedAtMs: boundaryMs + 3,
      orderId: 'sell-new-segment',
    });

    tracker.recordCumulativeExecution({
      direction: 'LONG',
      symbol: 'BULL.HK',
      side: OrderSide.Buy,
      executedPrice: 10,
      executedQuantity: 100,
      executedTimeMs: boundaryMs + 2,
      orderUpdatedAtMs: boundaryMs + 2,
      orderId: 'buy-cross-boundary',
    });

    expect(tracker.getLossOffset('LONG')).toBe(-60);
  });

  it('projects only cumulative quantity and amount growth after the boundary baseline', () => {
    const tracker = createSegmentTracker();
    const monitor = createMonitor();
    const now = new Date('2026-03-03T02:00:00.000Z');
    const partialTimeMs = Date.parse('2026-03-03T01:00:00.000Z');
    const boundaryMs = Date.parse('2026-03-03T01:10:00.000Z');

    tracker.recalculateFromAllOrders([], monitor, now);
    tracker.recordCumulativeExecution({
      direction: 'LONG',
      symbol: 'BULL.HK',
      side: OrderSide.Buy,
      executedPrice: 10,
      executedQuantity: 40,
      executedTimeMs: partialTimeMs,
      orderUpdatedAtMs: partialTimeMs,
      orderId: 'buy-amount-delta',
    });

    commitPreparedBoundary(tracker, {
      direction: 'LONG',
      boundaryExecutedTimeMs: boundaryMs,
    });

    tracker.recordCumulativeExecution({
      direction: 'LONG',
      symbol: 'BULL.HK',
      side: OrderSide.Buy,
      executedPrice: 9,
      executedQuantity: 100,
      executedTimeMs: boundaryMs + 1,
      orderUpdatedAtMs: boundaryMs + 1,
      orderId: 'buy-amount-delta',
    });

    tracker.recordCumulativeExecution({
      direction: 'LONG',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      executedPrice: 8,
      executedQuantity: 60,
      executedTimeMs: boundaryMs + 2,
      orderUpdatedAtMs: boundaryMs + 2,
      orderId: 'sell-amount-delta',
    });

    // 买单累计金额从 400 增至 900，新段成本为 500；卖出金额 480，亏损 20。
    expect(tracker.getLossOffset('LONG')).toBeCloseTo(-20, 10);
  });

  it('keeps runtime cumulative updates equal to a same-day full recalculation with the same baseline', () => {
    const monitor = createMonitor();
    const now = new Date('2026-03-03T02:00:00.000Z');
    const partialTimeMs = Date.parse('2026-03-03T01:00:00.000Z');
    const boundaryMs = Date.parse('2026-03-03T01:10:00.000Z');
    const partialBuy = createExecutedOrder({
      orderId: 'buy-runtime-recalc',
      symbol: 'BULL.HK',
      side: OrderSide.Buy,
      status: OrderStatus.PartialFilled,
      executedPrice: 10,
      executedQuantity: 40,
      updatedAtMs: partialTimeMs,
    });
    const finalBuy = createExecutedOrder({
      orderId: 'buy-runtime-recalc',
      symbol: 'BULL.HK',
      side: OrderSide.Buy,
      executedPrice: 10,
      executedQuantity: 100,
      updatedAtMs: boundaryMs + 1,
    });
    const newSell = createExecutedOrder({
      orderId: 'sell-runtime-recalc',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      executedPrice: 9,
      executedQuantity: 60,
      updatedAtMs: boundaryMs + 2,
    });
    const runtimeTracker = createSegmentTracker();
    const recalculatedTracker = createSegmentTracker();

    for (const tracker of [runtimeTracker, recalculatedTracker]) {
      tracker.recalculateFromAllOrders([partialBuy], monitor, now);
      commitPreparedBoundary(tracker, {
        direction: 'LONG',
        boundaryExecutedTimeMs: boundaryMs,
      });
    }

    runtimeTracker.recordCumulativeExecution({
      direction: 'LONG',
      symbol: 'BULL.HK',
      side: OrderSide.Buy,
      executedPrice: 10,
      executedQuantity: 100,
      executedTimeMs: boundaryMs + 1,
      orderUpdatedAtMs: boundaryMs + 1,
      orderId: 'buy-runtime-recalc',
    });

    runtimeTracker.recordCumulativeExecution({
      direction: 'LONG',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      executedPrice: 9,
      executedQuantity: 60,
      executedTimeMs: boundaryMs + 2,
      orderUpdatedAtMs: boundaryMs + 2,
      orderId: 'sell-runtime-recalc',
    });
    recalculatedTracker.recalculateFromAllOrders([finalBuy, newSell], monitor, now);

    expect(recalculatedTracker.getLossOffset('LONG')).toBe(runtimeTracker.getLossOffset('LONG'));
    expect(recalculatedTracker.getLossOffset('LONG')).toBe(-60);
  });

  it('allows a newer equal-quantity revision to correct cumulative amount without new execution', () => {
    const tracker = createSegmentTracker();
    const monitor = createMonitor();
    const now = new Date('2026-03-03T02:00:00.000Z');
    const executionTimeMs = Date.parse('2026-03-03T01:00:00.000Z');

    tracker.recalculateFromAllOrders([], monitor, now);
    tracker.recordCumulativeExecution({
      direction: 'LONG',
      symbol: 'BULL.HK',
      side: OrderSide.Buy,
      executedPrice: 10,
      executedQuantity: 100,
      executedTimeMs: executionTimeMs,
      orderUpdatedAtMs: executionTimeMs,
      orderId: 'buy-price-correction',
    });

    tracker.recordCumulativeExecution({
      direction: 'LONG',
      symbol: 'BULL.HK',
      side: OrderSide.Buy,
      executedPrice: 11,
      executedQuantity: 100,
      executedTimeMs: executionTimeMs,
      orderUpdatedAtMs: executionTimeMs + 1,
      orderId: 'buy-price-correction',
    });

    tracker.recordCumulativeExecution({
      direction: 'LONG',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      executedPrice: 10,
      executedQuantity: 100,
      executedTimeMs: executionTimeMs + 2,
      orderUpdatedAtMs: executionTimeMs + 2,
      orderId: 'sell-price-correction',
    });

    expect(tracker.getLossOffset('LONG')).toBe(-100);
  });

  it('fails fast when the same revision and quantity report conflicting cumulative amount', () => {
    const tracker = createSegmentTracker();
    const monitor = createMonitor();
    const now = new Date('2026-03-03T02:00:00.000Z');
    const revisionMs = Date.parse('2026-03-03T01:00:00.000Z');

    tracker.recalculateFromAllOrders([], monitor, now);
    tracker.recordCumulativeExecution({
      direction: 'LONG',
      symbol: 'BULL.HK',
      side: OrderSide.Buy,
      executedPrice: 10,
      executedQuantity: 40,
      executedTimeMs: revisionMs,
      orderUpdatedAtMs: revisionMs,
      orderId: 'same-revision-conflict',
    });

    expect(() => {
      tracker.recordCumulativeExecution({
        direction: 'LONG',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
        executedPrice: 11,
        executedQuantity: 40,
        executedTimeMs: revisionMs,
        orderUpdatedAtMs: revisionMs,
        orderId: 'same-revision-conflict',
      });
    }).toThrow(/same-revision-conflict.*revision conflict/);
  });

  it('ignores an older revision even when it reports a larger cumulative quantity', () => {
    const tracker = createSegmentTracker();
    const monitor = createMonitor();
    const now = new Date('2026-03-03T02:00:00.000Z');
    const executionTimeMs = Date.parse('2026-03-03T01:00:00.000Z');

    tracker.recalculateFromAllOrders([], monitor, now);
    tracker.recordCumulativeExecution({
      direction: 'LONG',
      symbol: 'BULL.HK',
      side: OrderSide.Buy,
      executedPrice: 10,
      executedQuantity: 40,
      executedTimeMs: executionTimeMs,
      orderUpdatedAtMs: executionTimeMs + 2,
      orderId: 'older-revision',
    });

    tracker.recordCumulativeExecution({
      direction: 'LONG',
      symbol: 'BULL.HK',
      side: OrderSide.Buy,
      executedPrice: 10,
      executedQuantity: 100,
      executedTimeMs: executionTimeMs + 1,
      orderUpdatedAtMs: executionTimeMs + 1,
      orderId: 'older-revision',
    });

    tracker.recordCumulativeExecution({
      direction: 'LONG',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      executedPrice: 9,
      executedQuantity: 40,
      executedTimeMs: executionTimeMs + 3,
      orderUpdatedAtMs: executionTimeMs + 3,
      orderId: 'older-revision-sell',
    });

    expect(tracker.getLossOffset('LONG')).toBe(-40);
  });

  it('does not move last execution time or segment contribution for a pure terminal update', () => {
    const tracker = createSegmentTracker();
    const monitor = createMonitor();
    const now = new Date('2026-03-03T02:00:00.000Z');
    const executionTimeMs = Date.parse('2026-03-03T01:00:00.000Z');
    const boundaryMs = Date.parse('2026-03-03T01:10:00.000Z');

    tracker.recalculateFromAllOrders([], monitor, now);
    tracker.recordCumulativeExecution({
      direction: 'LONG',
      symbol: 'BULL.HK',
      side: OrderSide.Buy,
      executedPrice: 10,
      executedQuantity: 40,
      executedTimeMs: executionTimeMs,
      orderUpdatedAtMs: executionTimeMs,
      orderId: 'pure-terminal-update',
    });

    tracker.recordCumulativeExecution({
      direction: 'LONG',
      symbol: 'BULL.HK',
      side: OrderSide.Buy,
      executedPrice: 10,
      executedQuantity: 40,
      executedTimeMs: boundaryMs + 1,
      orderUpdatedAtMs: boundaryMs + 1,
      orderId: 'pure-terminal-update',
    });

    commitPreparedBoundary(tracker, {
      direction: 'LONG',
      boundaryExecutedTimeMs: boundaryMs,
    });

    tracker.recordCumulativeExecution({
      direction: 'LONG',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      executedPrice: 9,
      executedQuantity: 40,
      executedTimeMs: boundaryMs + 2,
      orderUpdatedAtMs: boundaryMs + 2,
      orderId: 'pure-terminal-sell',
    });

    expect(tracker.getLossOffset('LONG')).toBe(0);
  });

  it('replaces a partial cumulative fill with the authoritative final quantity', () => {
    const tracker = createSegmentTracker();
    const monitor = createMonitor();
    const now = new Date('2026-03-03T02:00:00.000Z');

    tracker.recalculateFromAllOrders(
      [
        createExecutedOrder({
          orderId: 'buy-filled',
          symbol: 'BULL.HK',
          side: OrderSide.Buy,
          executedPrice: 10,
          executedQuantity: 100,
          updatedAtMs: Date.parse('2026-03-03T01:00:00.000Z'),
        }),
        createExecutedOrder({
          orderId: 'sell-partial',
          symbol: 'BULL.HK',
          side: OrderSide.Sell,
          status: OrderStatus.PartialFilled,
          executedPrice: 9,
          executedQuantity: 40,
          updatedAtMs: Date.parse('2026-03-03T01:01:00.000Z'),
        }),
      ],
      monitor,
      now,
    );

    tracker.recordCumulativeExecution({
      direction: 'LONG',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      executedPrice: 9,
      executedQuantity: 100,
      executedTimeMs: Date.parse('2026-03-03T01:02:00.000Z'),
      orderUpdatedAtMs: Date.parse('2026-03-03T01:02:00.000Z'),
      orderId: 'sell-partial',
    });

    expect(tracker.getLossOffset('LONG')).toBe(-100);
  });

  it('treats a repeated final cumulative fill as idempotent', () => {
    const tracker = createSegmentTracker();
    const monitor = createMonitor();
    const now = new Date('2026-03-03T02:00:00.000Z');

    tracker.recalculateFromAllOrders(
      [
        createExecutedOrder({
          orderId: 'buy-filled',
          symbol: 'BULL.HK',
          side: OrderSide.Buy,
          executedPrice: 10,
          executedQuantity: 100,
          updatedAtMs: Date.parse('2026-03-03T01:00:00.000Z'),
        }),
      ],
      monitor,
      now,
    );

    const finalFill = {
      factStage: 'TERMINAL' as const,
      direction: 'LONG' as const,
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      executedPrice: 9,
      executedQuantity: 100,
      executedTimeMs: Date.parse('2026-03-03T01:02:00.000Z'),
      orderUpdatedAtMs: Date.parse('2026-03-03T01:02:00.000Z'),
      orderId: 'sell-final',
    } satisfies DailyLossCumulativeExecutionInput;
    tracker.recordCumulativeExecution(finalFill);
    tracker.recordCumulativeExecution(finalFill);

    expect(tracker.getLossOffset('LONG')).toBe(-100);
  });

  it('ignores an older cumulative fill after a larger quantity was recorded', () => {
    const tracker = createSegmentTracker();
    const monitor = createMonitor();
    const now = new Date('2026-03-03T02:00:00.000Z');

    tracker.recalculateFromAllOrders(
      [
        createExecutedOrder({
          orderId: 'buy-filled',
          symbol: 'BULL.HK',
          side: OrderSide.Buy,
          executedPrice: 10,
          executedQuantity: 100,
          updatedAtMs: Date.parse('2026-03-03T01:00:00.000Z'),
        }),
      ],
      monitor,
      now,
    );

    tracker.recordCumulativeExecution({
      direction: 'LONG',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      executedPrice: 9,
      executedQuantity: 100,
      executedTimeMs: Date.parse('2026-03-03T01:02:00.000Z'),
      orderUpdatedAtMs: Date.parse('2026-03-03T01:02:00.000Z'),
      orderId: 'sell-cumulative',
    });

    tracker.recordCumulativeExecution({
      direction: 'LONG',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      executedPrice: 9,
      executedQuantity: 40,
      executedTimeMs: Date.parse('2026-03-03T01:01:00.000Z'),
      orderUpdatedAtMs: Date.parse('2026-03-03T01:01:00.000Z'),
      orderId: 'sell-cumulative',
    });

    expect(tracker.getLossOffset('LONG')).toBe(-100);
  });

  it('fails fast when the same orderId changes direction, side, or symbol', () => {
    const monitor = createMonitor();
    const now = new Date('2026-03-03T02:00:00.000Z');
    const identityChanges = [
      { direction: 'SHORT' as const, symbol: 'BULL.HK', side: OrderSide.Buy },
      { direction: 'LONG' as const, symbol: 'BULL.HK', side: OrderSide.Sell },
      { direction: 'LONG' as const, symbol: 'OTHER.HK', side: OrderSide.Buy },
    ] satisfies ReadonlyArray<
      Pick<DailyLossCumulativeExecutionInput, 'direction' | 'symbol' | 'side'>
    >;

    for (const identityChange of identityChanges) {
      const tracker = createSegmentTracker();
      tracker.recalculateFromAllOrders([], monitor, now);
      tracker.recordCumulativeExecution({
        direction: 'LONG',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
        executedPrice: 10,
        executedQuantity: 40,
        executedTimeMs: Date.parse('2026-03-03T01:00:00.000Z'),
        orderUpdatedAtMs: Date.parse('2026-03-03T01:00:00.000Z'),
        orderId: 'same-order',
      });

      expect(() => {
        tracker.recordCumulativeExecution({
          ...identityChange,
          executedPrice: 10,
          executedQuantity: 100,
          executedTimeMs: Date.parse('2026-03-03T01:01:00.000Z'),
          orderUpdatedAtMs: Date.parse('2026-03-03T01:01:00.000Z'),
          orderId: 'same-order',
        });
      }).toThrow(/same-order.*identity mismatch/);
    }
  });

  it('keeps same-day state intact when full recalculation rejects a conflicting order identity', () => {
    const tracker = createSegmentTracker();
    const monitor = createMonitor();
    const now = new Date('2026-03-03T02:00:00.000Z');
    const initialOrders = [
      createExecutedOrder({
        orderId: 'CONFLICT-ID',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
        executedPrice: 10,
        executedQuantity: 10,
        updatedAtMs: Date.parse('2026-03-03T01:00:00.000Z'),
      }),
      createExecutedOrder({
        orderId: 'SELL-ID',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        executedPrice: 9,
        executedQuantity: 10,
        updatedAtMs: Date.parse('2026-03-03T01:01:00.000Z'),
      }),
    ];

    tracker.recalculateFromAllOrders(initialOrders, monitor, now);
    expect(tracker.getLossOffset('LONG')).toBe(-10);

    expect(() => {
      tracker.recalculateFromAllOrders(
        [
          createExecutedOrder({
            orderId: 'CONFLICT-ID',
            symbol: 'BULL.HK',
            side: OrderSide.Sell,
            executedPrice: 10,
            executedQuantity: 1,
            updatedAtMs: Date.parse('2026-03-03T01:02:00.000Z'),
          }),
        ],
        monitor,
        now,
      );
    }).toThrow(/CONFLICT-ID.*identity mismatch/);

    expect(tracker.getLossOffset('LONG')).toBe(-10);

    tracker.recalculateFromAllOrders(initialOrders, monitor, now);
    expect(tracker.getLossOffset('LONG')).toBe(-10);
  });

  it('keeps the existing protection boundary when same-day recalculation rejects a revision conflict', () => {
    const tracker = createSegmentTracker();
    const monitor = createMonitor();
    const now = new Date('2026-03-03T02:00:00.000Z');
    const boundaryMs = Date.parse('2026-03-03T01:00:00.000Z');
    const executionMs = boundaryMs + 1_000;

    tracker.recalculateFromAllOrders([], monitor, now);
    tracker.recordCumulativeExecution({
      direction: 'LONG',
      symbol: 'BULL.HK',
      side: OrderSide.Buy,
      executedPrice: 10,
      executedQuantity: 10,
      executedTimeMs: boundaryMs,
      orderUpdatedAtMs: boundaryMs,
      orderId: 'PRE-BOUNDARY-BUY-ID',
    });

    tracker.recordCumulativeExecution({
      direction: 'LONG',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      executedPrice: 9,
      executedQuantity: 10,
      executedTimeMs: boundaryMs,
      orderUpdatedAtMs: boundaryMs,
      orderId: 'PRE-BOUNDARY-SELL-ID',
    });

    tracker.recordCumulativeExecution({
      direction: 'LONG',
      symbol: 'BULL.HK',
      side: OrderSide.Buy,
      executedPrice: 10,
      executedQuantity: 10,
      executedTimeMs: executionMs,
      orderUpdatedAtMs: executionMs,
      orderId: 'REVISION-CONFLICT-ID',
    });

    tracker.recordCumulativeExecution({
      direction: 'LONG',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      executedPrice: 9,
      executedQuantity: 10,
      executedTimeMs: executionMs + 1,
      orderUpdatedAtMs: executionMs + 1,
      orderId: 'POST-BOUNDARY-SELL-ID',
    });

    commitPreparedBoundary(tracker, {
      direction: 'LONG',
      boundaryExecutedTimeMs: boundaryMs,
    });
    expect(tracker.getLossOffset('LONG')).toBe(-10);

    expect(() => {
      tracker.recalculateFromAllOrders(
        [
          createExecutedOrder({
            orderId: 'REVISION-CONFLICT-ID',
            symbol: 'BULL.HK',
            side: OrderSide.Buy,
            executedPrice: 11,
            executedQuantity: 10,
            updatedAtMs: executionMs,
          }),
        ],
        monitor,
        now,
      );
    }).toThrow(/REVISION-CONFLICT-ID.*revision conflict/);

    expect(tracker.getLossOffset('LONG')).toBe(-10);

    expect(
      tracker.recordCumulativeExecution({
        direction: 'LONG',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
        executedPrice: 10,
        executedQuantity: 10,
        executedTimeMs: boundaryMs,
        orderUpdatedAtMs: boundaryMs,
        orderId: 'BOUNDARY-IGNORED-BUY-ID',
      }),
    ).toEqual({ authoritativeFactChanged: false, executionAdvanced: false });

    expect(tracker.getLossOffset('LONG')).toBe(-10);
  });

  it('keeps only fills strictly after a newly completed protection boundary', () => {
    const tracker = createSegmentTracker();
    const monitor = createMonitor();
    const now = new Date('2026-03-03T02:00:00.000Z');
    const boundaryMs = Date.parse('2026-03-03T01:10:00.000Z');

    tracker.recalculateFromAllOrders([], monitor, now);
    for (const [suffix, executedTimeMs] of [
      ['before', boundaryMs - 1],
      ['at', boundaryMs],
      ['after', boundaryMs + 1],
    ] as const) {
      tracker.recordCumulativeExecution({
        direction: 'LONG',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
        executedPrice: 10,
        executedQuantity: 10,
        executedTimeMs,
        orderUpdatedAtMs: executedTimeMs,
        orderId: `buy-${suffix}`,
      });

      tracker.recordCumulativeExecution({
        direction: 'LONG',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        executedPrice: 9,
        executedQuantity: 10,
        executedTimeMs,
        orderUpdatedAtMs: executedTimeMs,
        orderId: `sell-${suffix}`,
      });
    }

    expect(tracker.getLossOffset('LONG')).toBe(-30);

    commitPreparedBoundary(tracker, {
      direction: 'LONG',
      boundaryExecutedTimeMs: boundaryMs,
    });

    expect(tracker.getLossOffset('LONG')).toBe(-10);
  });

  it('keeps post-boundary fills across repeated or earlier boundary notifications', () => {
    const tracker = createSegmentTracker();
    const monitor = createMonitor();
    const now = new Date('2026-03-03T02:00:00.000Z');
    const boundaryMs = Date.parse('2026-03-03T01:10:00.000Z');

    tracker.recalculateFromAllOrders([], monitor, now);
    tracker.recordCumulativeExecution({
      direction: 'LONG',
      symbol: 'BULL.HK',
      side: OrderSide.Buy,
      executedPrice: 10,
      executedQuantity: 10,
      executedTimeMs: boundaryMs + 1,
      orderUpdatedAtMs: boundaryMs + 1,
      orderId: 'buy-after-boundary',
    });

    tracker.recordCumulativeExecution({
      direction: 'LONG',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      executedPrice: 9,
      executedQuantity: 10,
      executedTimeMs: boundaryMs + 2,
      orderUpdatedAtMs: boundaryMs + 2,
      orderId: 'sell-after-boundary',
    });

    commitPreparedBoundary(tracker, {
      direction: 'LONG',
      boundaryExecutedTimeMs: boundaryMs,
    });

    expect(() => {
      commitPreparedBoundary(tracker, {
        direction: 'LONG',
        boundaryExecutedTimeMs: boundaryMs,
      });
    }).toThrow(/未向前推进/);

    expect(() => {
      commitPreparedBoundary(tracker, {
        direction: 'LONG',
        boundaryExecutedTimeMs: boundaryMs - 1,
      });
    }).toThrow(/未向前推进/);

    expect(tracker.getLossOffset('LONG')).toBe(-10);
  });

  it('advances one direction without deleting the other direction or later fills', () => {
    const tracker = createSegmentTracker();
    const monitor = createMonitor();
    const now = new Date('2026-03-03T02:00:00.000Z');
    const boundaryMs = Date.parse('2026-03-03T01:10:00.000Z');

    tracker.recalculateFromAllOrders([], monitor, now);
    for (const [direction, symbol] of [
      ['LONG', 'BULL.HK'],
      ['SHORT', 'BEAR.HK'],
    ] as const) {
      tracker.recordCumulativeExecution({
        direction,
        symbol,
        side: OrderSide.Buy,
        executedPrice: 10,
        executedQuantity: 10,
        executedTimeMs: boundaryMs + 1,
        orderUpdatedAtMs: boundaryMs + 1,
        orderId: `${direction}-buy-after-boundary`,
      });

      tracker.recordCumulativeExecution({
        direction,
        symbol,
        side: OrderSide.Sell,
        executedPrice: 9,
        executedQuantity: 10,
        executedTimeMs: boundaryMs + 2,
        orderUpdatedAtMs: boundaryMs + 2,
        orderId: `${direction}-sell-after-boundary`,
      });
    }

    commitPreparedBoundary(tracker, {
      direction: 'LONG',
      boundaryExecutedTimeMs: boundaryMs,
    });

    expect(tracker.getLossOffset('LONG')).toBe(-10);
    expect(tracker.getLossOffset('SHORT')).toBe(-10);
  });

  it('matches a final full rebuild after startup partial fill reaches terminal quantity', () => {
    const monitor = createMonitor();
    const now = new Date('2026-03-03T02:00:00.000Z');
    const buyOrder = createExecutedOrder({
      orderId: 'buy-filled',
      symbol: 'BULL.HK',
      side: OrderSide.Buy,
      executedPrice: 10,
      executedQuantity: 100,
      updatedAtMs: Date.parse('2026-03-03T01:00:00.000Z'),
    });
    const partialSellOrder = createExecutedOrder({
      orderId: 'sell-recovered',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      status: OrderStatus.PartialFilled,
      executedPrice: 9,
      executedQuantity: 40,
      updatedAtMs: Date.parse('2026-03-03T01:01:00.000Z'),
    });
    const finalSellOrder = createExecutedOrder({
      orderId: 'sell-recovered',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      executedPrice: 9,
      executedQuantity: 100,
      updatedAtMs: Date.parse('2026-03-03T01:02:00.000Z'),
    });
    const resumedTracker = createSegmentTracker();
    const rebuiltTracker = createSegmentTracker();

    resumedTracker.recalculateFromAllOrders([buyOrder, partialSellOrder], monitor, now);
    resumedTracker.recordCumulativeExecution({
      direction: 'LONG',
      symbol: finalSellOrder.symbol,
      side: OrderSide.Sell,
      executedPrice: 9,
      executedQuantity: 100,
      executedTimeMs: finalSellOrder.updatedAt?.getTime() ?? 0,
      orderUpdatedAtMs: finalSellOrder.updatedAt?.getTime() ?? 0,
      orderId: finalSellOrder.orderId,
    });
    rebuiltTracker.recalculateFromAllOrders([buyOrder, finalSellOrder], monitor, now);

    expect(resumedTracker.getLossOffset('LONG')).toBe(rebuiltTracker.getLossOffset('LONG'));
    expect(resumedTracker.getLossOffset('LONG')).toBe(-100);
  });

  it('prepare/commit protection boundary baselines old segment facts and ignores pre-segment fills', () => {
    const tracker = createSegmentTracker();
    const monitor = createMonitor();
    const now = new Date('2026-03-03T02:00:00.000Z');

    tracker.recalculateFromAllOrders(
      [
        createExecutedOrder({
          orderId: 'buy-old',
          symbol: 'BULL.HK',
          side: OrderSide.Buy,
          executedPrice: 10,
          executedQuantity: 10,
          updatedAtMs: Date.parse('2026-03-03T01:00:00.000Z'),
        }),
        createExecutedOrder({
          orderId: 'sell-old',
          symbol: 'BULL.HK',
          side: OrderSide.Sell,
          executedPrice: 9,
          executedQuantity: 10,
          updatedAtMs: Date.parse('2026-03-03T01:05:00.000Z'),
        }),
      ],
      monitor,
      now,
    );
    expect(tracker.getLossOffset('LONG')).toBe(-10);

    commitPreparedBoundary(tracker, {
      direction: 'LONG',
      boundaryExecutedTimeMs: Date.parse('2026-03-03T01:10:00.000Z'),
    });
    expect(tracker.getLossOffset('LONG')).toBe(0);

    tracker.recordCumulativeExecution({
      direction: 'LONG',
      symbol: 'BULL.HK',
      side: OrderSide.Buy,
      executedPrice: 10,
      executedQuantity: 10,
      executedTimeMs: Date.parse('2026-03-03T01:09:00.000Z'),
      orderUpdatedAtMs: Date.parse('2026-03-03T01:09:00.000Z'),
      orderId: 'buy-before-segment',
    });
    expect(tracker.getLossOffset('LONG')).toBe(0);

    tracker.recordCumulativeExecution({
      direction: 'LONG',
      symbol: 'BULL.HK',
      side: OrderSide.Buy,
      executedPrice: 10,
      executedQuantity: 10,
      executedTimeMs: Date.parse('2026-03-03T01:11:00.000Z'),
      orderUpdatedAtMs: Date.parse('2026-03-03T01:11:00.000Z'),
      orderId: 'buy-new-segment',
    });

    tracker.recordCumulativeExecution({
      direction: 'LONG',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      executedPrice: 9,
      executedQuantity: 10,
      executedTimeMs: Date.parse('2026-03-03T01:12:00.000Z'),
      orderUpdatedAtMs: Date.parse('2026-03-03T01:12:00.000Z'),
      orderId: 'sell-new-segment',
    });
    expect(tracker.getLossOffset('LONG')).toBe(-10);
  });

  it('prepare/commit protection boundary advances only the SHORT segment and keeps LONG state intact', () => {
    const tracker = createSegmentTracker();
    const monitor = createMonitor();
    const now = new Date('2026-03-03T02:00:00.000Z');

    tracker.recalculateFromAllOrders(
      [
        createExecutedOrder({
          orderId: 'long-buy-existing',
          symbol: 'BULL.HK',
          side: OrderSide.Buy,
          executedPrice: 10,
          executedQuantity: 10,
          updatedAtMs: Date.parse('2026-03-03T01:00:00.000Z'),
        }),
        createExecutedOrder({
          orderId: 'long-sell-existing',
          symbol: 'BULL.HK',
          side: OrderSide.Sell,
          executedPrice: 9,
          executedQuantity: 10,
          updatedAtMs: Date.parse('2026-03-03T01:01:00.000Z'),
        }),
        createExecutedOrder({
          orderId: 'short-buy-old',
          symbol: 'BEAR.HK',
          side: OrderSide.Buy,
          executedPrice: 10,
          executedQuantity: 10,
          updatedAtMs: Date.parse('2026-03-03T01:02:00.000Z'),
        }),
        createExecutedOrder({
          orderId: 'short-sell-old',
          symbol: 'BEAR.HK',
          side: OrderSide.Sell,
          executedPrice: 9,
          executedQuantity: 10,
          updatedAtMs: Date.parse('2026-03-03T01:03:00.000Z'),
        }),
      ],
      monitor,
      now,
    );
    expect(tracker.getLossOffset('LONG')).toBe(-10);
    expect(tracker.getLossOffset('SHORT')).toBe(-10);

    commitPreparedBoundary(tracker, {
      direction: 'SHORT',
      boundaryExecutedTimeMs: Date.parse('2026-03-03T01:10:00.000Z'),
    });
    expect(tracker.getLossOffset('LONG')).toBe(-10);
    expect(tracker.getLossOffset('SHORT')).toBe(0);

    tracker.recordCumulativeExecution({
      direction: 'SHORT',
      symbol: 'BEAR.HK',
      side: OrderSide.Buy,
      executedPrice: 10,
      executedQuantity: 10,
      executedTimeMs: Date.parse('2026-03-03T01:09:00.000Z'),
      orderUpdatedAtMs: Date.parse('2026-03-03T01:09:00.000Z'),
      orderId: 'short-buy-before-segment',
    });
    expect(tracker.getLossOffset('SHORT')).toBe(0);

    tracker.recordCumulativeExecution({
      direction: 'SHORT',
      symbol: 'BEAR.HK',
      side: OrderSide.Buy,
      executedPrice: 10,
      executedQuantity: 10,
      executedTimeMs: Date.parse('2026-03-03T01:11:00.000Z'),
      orderUpdatedAtMs: Date.parse('2026-03-03T01:11:00.000Z'),
      orderId: 'short-buy-new-segment',
    });

    tracker.recordCumulativeExecution({
      direction: 'SHORT',
      symbol: 'BEAR.HK',
      side: OrderSide.Sell,
      executedPrice: 9,
      executedQuantity: 10,
      executedTimeMs: Date.parse('2026-03-03T01:12:00.000Z'),
      orderUpdatedAtMs: Date.parse('2026-03-03T01:12:00.000Z'),
      orderId: 'short-sell-new-segment',
    });

    expect(tracker.getLossOffset('LONG')).toBe(-10);
    expect(tracker.getLossOffset('SHORT')).toBe(-10);
  });

  it('prepare/commit protection boundary rejects stale for the same protection boundary', () => {
    const tracker = createSegmentTracker();
    const now = new Date('2026-03-03T02:00:00.000Z');
    const monitor = createMonitor();
    const firstBoundaryMs = Date.parse('2026-03-03T01:10:00.000Z');

    tracker.recalculateFromAllOrders([], monitor, now);

    commitPreparedBoundary(tracker, {
      direction: 'LONG',
      boundaryExecutedTimeMs: firstBoundaryMs,
    });

    tracker.recordCumulativeExecution({
      direction: 'LONG',
      symbol: 'BULL.HK',
      side: OrderSide.Buy,
      executedPrice: 10,
      executedQuantity: 10,
      executedTimeMs: Date.parse('2026-03-03T01:11:00.000Z'),
      orderUpdatedAtMs: Date.parse('2026-03-03T01:11:00.000Z'),
      orderId: 'buy-after-first-boundary',
    });

    tracker.recordCumulativeExecution({
      direction: 'LONG',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      executedPrice: 9,
      executedQuantity: 10,
      executedTimeMs: Date.parse('2026-03-03T01:12:00.000Z'),
      orderUpdatedAtMs: Date.parse('2026-03-03T01:12:00.000Z'),
      orderId: 'sell-after-first-boundary',
    });
    expect(tracker.getLossOffset('LONG')).toBe(-10);

    expect(() => {
      commitPreparedBoundary(tracker, {
        direction: 'LONG',
        boundaryExecutedTimeMs: firstBoundaryMs,
      });
    }).toThrow(/未向前推进/);
    expect(tracker.getLossOffset('LONG')).toBe(-10);
  });

  it('recalculateFromAllOrders respects external protectionBoundaryByDirection at startup', () => {
    const tracker = createSegmentTracker();
    const monitor = createMonitor();
    const protectionBoundaryByDirection = new Map<'LONG', number>([
      ['LONG', Date.parse('2026-03-03T01:10:00.000Z')],
    ]);

    tracker.recalculateFromAllOrders(
      [
        createExecutedOrder({
          orderId: 'buy-before-segment',
          symbol: 'BULL.HK',
          side: OrderSide.Buy,
          executedPrice: 10,
          executedQuantity: 10,
          updatedAtMs: Date.parse('2026-03-03T01:00:00.000Z'),
        }),
        createExecutedOrder({
          orderId: 'sell-before-segment',
          symbol: 'BULL.HK',
          side: OrderSide.Sell,
          executedPrice: 9,
          executedQuantity: 10,
          updatedAtMs: Date.parse('2026-03-03T01:05:00.000Z'),
        }),
        createExecutedOrder({
          orderId: 'buy-after-segment',
          symbol: 'BULL.HK',
          side: OrderSide.Buy,
          executedPrice: 10,
          executedQuantity: 10,
          updatedAtMs: Date.parse('2026-03-03T01:11:00.000Z'),
        }),
        createExecutedOrder({
          orderId: 'sell-after-segment',
          symbol: 'BULL.HK',
          side: OrderSide.Sell,
          executedPrice: 9,
          executedQuantity: 10,
          updatedAtMs: Date.parse('2026-03-03T01:12:00.000Z'),
        }),
      ],
      monitor,
      new Date('2026-03-03T02:00:00.000Z'),
      protectionBoundaryByDirection,
    );

    expect(tracker.getLossOffset('LONG')).toBe(-10);
  });

  it('recalculateFromAllOrders keeps same-day in-memory protection boundary when no boundary is passed', () => {
    const tracker = createSegmentTracker();
    const monitor = createMonitor();
    const now = new Date('2026-03-03T02:00:00.000Z');

    tracker.recalculateFromAllOrders(
      [
        createExecutedOrder({
          orderId: 'buy-old',
          symbol: 'BULL.HK',
          side: OrderSide.Buy,
          executedPrice: 10,
          executedQuantity: 10,
          updatedAtMs: Date.parse('2026-03-03T01:00:00.000Z'),
        }),
        createExecutedOrder({
          orderId: 'sell-old',
          symbol: 'BULL.HK',
          side: OrderSide.Sell,
          executedPrice: 9,
          executedQuantity: 10,
          updatedAtMs: Date.parse('2026-03-03T01:05:00.000Z'),
        }),
      ],
      monitor,
      now,
    );
    expect(tracker.getLossOffset('LONG')).toBe(-10);

    commitPreparedBoundary(tracker, {
      direction: 'LONG',
      boundaryExecutedTimeMs: Date.parse('2026-03-03T01:10:00.000Z'),
    });
    expect(tracker.getLossOffset('LONG')).toBe(0);

    tracker.recalculateFromAllOrders(
      [
        createExecutedOrder({
          orderId: 'buy-old',
          symbol: 'BULL.HK',
          side: OrderSide.Buy,
          executedPrice: 10,
          executedQuantity: 10,
          updatedAtMs: Date.parse('2026-03-03T01:00:00.000Z'),
        }),
        createExecutedOrder({
          orderId: 'sell-old',
          symbol: 'BULL.HK',
          side: OrderSide.Sell,
          executedPrice: 9,
          executedQuantity: 10,
          updatedAtMs: Date.parse('2026-03-03T01:05:00.000Z'),
        }),
        createExecutedOrder({
          orderId: 'buy-new',
          symbol: 'BULL.HK',
          side: OrderSide.Buy,
          executedPrice: 10,
          executedQuantity: 10,
          updatedAtMs: Date.parse('2026-03-03T01:11:00.000Z'),
        }),
        createExecutedOrder({
          orderId: 'sell-new',
          symbol: 'BULL.HK',
          side: OrderSide.Sell,
          executedPrice: 9,
          executedQuantity: 10,
          updatedAtMs: Date.parse('2026-03-03T01:12:00.000Z'),
        }),
      ],
      monitor,
      now,
    );

    expect(tracker.getLossOffset('LONG')).toBe(-10);
  });

  it('recalculateFromAllOrders includes canceled order executed part to keep restart consistency', () => {
    const tracker = createSegmentTracker();
    const monitor = createMonitor();
    const now = new Date('2026-03-03T02:00:00.000Z');

    tracker.recalculateFromAllOrders(
      [
        createExecutedOrder({
          orderId: 'buy-filled',
          symbol: 'BULL.HK',
          side: OrderSide.Buy,
          status: OrderStatus.Filled,
          executedPrice: 10,
          executedQuantity: 10,
          updatedAtMs: Date.parse('2026-03-03T01:00:00.000Z'),
        }),
        createExecutedOrder({
          orderId: 'sell-canceled-partial',
          symbol: 'BULL.HK',
          side: OrderSide.Sell,
          status: OrderStatus.Canceled,
          executedPrice: 9,
          executedQuantity: 10,
          updatedAtMs: Date.parse('2026-03-03T01:05:00.000Z'),
        }),
      ],
      monitor,
      now,
    );

    expect(tracker.getLossOffset('LONG')).toBe(-10);
  });

  it('recalculateFromAllOrders fails fast when a relevant in-day executed order cannot be owned', () => {
    const tracker = createDailyLossTracker({
      ...createDailyLossOrderAnalysisDeps(),
      resolveOrderOwnership: () => null,
      toHongKongTimeIso,
    });
    const monitor = createMonitor();
    const now = new Date('2026-03-03T02:00:00.000Z');

    expect(() => {
      tracker.recalculateFromAllOrders(
        [
          createExecutedOrder({
            orderId: 'unowned-relevant-long',
            symbol: 'BULL.HK',
            stockName: 'Unparseable Warrant',
            side: OrderSide.Buy,
            executedPrice: 10,
            executedQuantity: 10,
            updatedAtMs: Date.parse('2026-03-03T01:00:00.000Z'),
          }),
        ],
        monitor,
        now,
        undefined,
        new Set(['BULL.HK', 'BEAR.HK']),
      );
    }).toThrow(/相关成交订单无法归属.*BULL\.HK/);
  });

  for (const testCase of [
    { name: 'BUY with null updatedAt', side: OrderSide.Buy, updatedAt: null },
    {
      name: 'BUY with Invalid Date updatedAt',
      side: OrderSide.Buy,
      updatedAt: new Date(Number.NaN),
    },
    { name: 'BUY with epoch updatedAt', side: OrderSide.Buy, updatedAt: new Date(0) },
    { name: 'SELL with null updatedAt', side: OrderSide.Sell, updatedAt: null },
    {
      name: 'SELL with Invalid Date updatedAt',
      side: OrderSide.Sell,
      updatedAt: new Date(Number.NaN),
    },
    { name: 'SELL with epoch updatedAt', side: OrderSide.Sell, updatedAt: new Date(0) },
  ] as const) {
    it(`fails closed before replacing tracker state for an attributable ordinary ${testCase.name}`, () => {
      const tracker = createSegmentTracker();
      const monitor = createMonitor();
      const now = new Date('2026-03-03T02:00:00.000Z');
      const validBuy = createExecutedOrder({
        orderId: 'valid-buy-before-invalid-rebuild',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
        executedPrice: 10,
        executedQuantity: 10,
        updatedAtMs: Date.parse('2026-03-03T01:00:00.000Z'),
      });
      const validSell = createExecutedOrder({
        orderId: 'valid-sell-before-invalid-rebuild',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        executedPrice: 9,
        executedQuantity: 10,
        updatedAtMs: Date.parse('2026-03-03T01:01:00.000Z'),
      });
      tracker.recalculateFromAllOrders([validBuy, validSell], monitor, now);

      expect(tracker.getLossOffset('LONG')).toBe(-10);

      const validOrder = testCase.side === OrderSide.Buy ? validBuy : validSell;
      const invalidOrder: RawOrderFromAPI = {
        ...validOrder,
        orderId: `ordinary-${testCase.side}-missing-updated-at`,
        updatedAt: testCase.updatedAt,
      };

      expect(() => {
        tracker.recalculateFromAllOrders([invalidOrder], monitor, now);
      }).toThrow(/缺少有效更新时间.*ordinary-/);

      expect(tracker.getLossOffset('LONG')).toBe(-10);
    });
  }

  it('rejects a related executed order before a historical timestamp can hide missing ownership', () => {
    const tracker = createDailyLossTracker({
      ...createDailyLossOrderAnalysisDeps(),
      resolveOrderOwnership: () => null,
      toHongKongTimeIso,
    });
    const monitor = createMonitor();

    expect(() => {
      tracker.recalculateFromAllOrders(
        [
          createExecutedOrder({
            orderId: 'related-historical-unowned-order',
            symbol: 'BULL.HK',
            stockName: 'Unparseable Warrant',
            side: OrderSide.Buy,
            executedPrice: 10,
            executedQuantity: 10,
            updatedAtMs: Date.parse('2026-03-02T01:00:00.000Z'),
          }),
        ],
        monitor,
        new Date('2026-03-03T02:00:00.000Z'),
        undefined,
        new Set(['BULL.HK']),
      );
    }).toThrow(/相关成交订单无法归属.*related-historical-unowned-order/);
  });

  it('skips an external unfilled order and a known historical owned execution', () => {
    const tracker = createSegmentTracker();
    const monitor = createMonitor();
    const now = new Date('2026-03-03T02:00:00.000Z');
    const externalUnfilledOrder: RawOrderFromAPI = {
      ...createExecutedOrder({
        orderId: 'external-unfilled-noise',
        symbol: 'EXTERNAL.HK',
        side: OrderSide.Buy,
        executedPrice: 10,
        executedQuantity: 10,
        updatedAtMs: Date.parse('2026-03-03T01:00:00.000Z'),
      }),
      executedPrice: 0,
      executedQuantity: 0,
      updatedAt: null,
    };
    const historicalOwnedOrder = createExecutedOrder({
      orderId: 'historical-owned-execution',
      symbol: 'BULL.HK',
      side: OrderSide.Buy,
      executedPrice: 10,
      executedQuantity: 10,
      updatedAtMs: Date.parse('2026-03-02T01:00:00.000Z'),
    });

    expect(() => {
      tracker.recalculateFromAllOrders([externalUnfilledOrder, historicalOwnedOrder], monitor, now);
    }).not.toThrow();
    expect(tracker.getLossOffset('LONG')).toBe(0);
  });
});
