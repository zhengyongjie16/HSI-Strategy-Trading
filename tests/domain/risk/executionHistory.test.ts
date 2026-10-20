/**
 * 恢复完整历史校验：revision/数量/金额/phase/T 的一致性与同量合法修订。
 * 所有冲突必须在状态发布前失败；合法历史只做校验，不合并事实。
 */
import { mergeExecutionFact } from '../../../src/domain/order/executionFact.js';
import type { BrokerOrderExecutionFact } from '../../../src/types/orderRecorder.js';
import { describe, expect, it } from 'bun:test';
import { assertExecutionHistory } from '../../../src/domain/risk/executionHistory.js';
import type { ExecutionHistorySnapshot } from '../../../src/domain/risk/types.js';

function snap(overrides: Partial<ExecutionHistorySnapshot> = {}): ExecutionHistorySnapshot {
  return {
    orderId: 'ORDER-1',
    symbol: 'BULL.HK',
    side: 'SELL',
    factStage: 'TERMINAL',
    cumulativeQuantity: 10,
    cumulativeAmount: '100',
    lastExecutionTimeMs: 100,
    orderUpdatedAtMs: 100,
    ...overrides,
  };
}

describe('assertExecutionHistory', () => {
  it('accepts same-quantity legal amount revision at a higher revision with unchanged T', () => {
    assertExecutionHistory({
      snapshots: [
        snap({ cumulativeAmount: '100', orderUpdatedAtMs: 100 }),
        snap({ cumulativeAmount: '90', orderUpdatedAtMs: 110 }),
      ],
      finalSnapshot: snap({ cumulativeAmount: '90', orderUpdatedAtMs: 110 }),
    });
  });

  it('accepts same-revision OPEN to TERMINAL amount correction with unchanged T', () => {
    assertExecutionHistory({
      snapshots: [
        snap({ factStage: 'OPEN', cumulativeAmount: '44' }),
        snap({ factStage: 'TERMINAL', cumulativeAmount: '45' }),
      ],
      finalSnapshot: snap({ cumulativeAmount: '45' }),
    });
  });

  it('rejects same revision/quantity amount conflict within the same phase', () => {
    expect(() => {
      assertExecutionHistory({
        snapshots: [snap({ cumulativeAmount: '100' }), snap({ cumulativeAmount: '90' })],
        finalSnapshot: snap({ cumulativeAmount: '100' }),
      });
    }).toThrow(/phase amount conflict/);
  });

  it('rejects same revision/quantity two-phase execution time conflict in either order', () => {
    for (const snapshots of [
      [snap({ factStage: 'OPEN', lastExecutionTimeMs: 100 }), snap({ lastExecutionTimeMs: 105 })],
      [snap({ lastExecutionTimeMs: 105 }), snap({ factStage: 'OPEN', lastExecutionTimeMs: 100 })],
    ]) {
      expect(() => {
        assertExecutionHistory({ snapshots });
      }).toThrow(/same revision\/quantity execution time conflict/);
    }
  });

  it('accepts same-quantity execution time revision across revisions for historical compatibility', () => {
    expect(() => {
      assertExecutionHistory({
        snapshots: [
          snap({ orderUpdatedAtMs: 100 }),
          snap({ orderUpdatedAtMs: 110, lastExecutionTimeMs: 105 }),
        ],
      });
    }).not.toThrow();
  });

  it('rejects quantity regression and quantity advance without amount advance', () => {
    expect(() => {
      assertExecutionHistory({
        snapshots: [
          snap({ cumulativeQuantity: 10 }),
          snap({ cumulativeQuantity: 5, orderUpdatedAtMs: 110, lastExecutionTimeMs: 110 }),
        ],
      });
    }).toThrow(/累计数量倒退/);

    expect(() => {
      assertExecutionHistory({
        snapshots: [
          snap({ cumulativeQuantity: 5, cumulativeAmount: '50' }),
          snap({
            cumulativeQuantity: 10,
            cumulativeAmount: '50',
            orderUpdatedAtMs: 110,
            lastExecutionTimeMs: 110,
          }),
        ],
      });
    }).toThrow(/正成交增量缺少正金额增量/);
  });

  it('rejects execution time regression on quantity advance', () => {
    expect(() => {
      assertExecutionHistory({
        snapshots: [
          snap({ cumulativeQuantity: 5, cumulativeAmount: '50', lastExecutionTimeMs: 120 }),
          snap({
            cumulativeQuantity: 10,
            cumulativeAmount: '100',
            orderUpdatedAtMs: 110,
            lastExecutionTimeMs: 110,
          }),
        ],
      });
    }).toThrow(/execution time regression/);
  });

  it('rejects phase regression even through an unknown-phase baseline group', () => {
    expect(() => {
      assertExecutionHistory({
        snapshots: [
          snap({ factStage: 'TERMINAL', cumulativeQuantity: 5, cumulativeAmount: '50' }),
          snap({
            factStage: null,
            cumulativeQuantity: 10,
            cumulativeAmount: '100',
            orderUpdatedAtMs: 110,
            lastExecutionTimeMs: 110,
          }),
          snap({
            factStage: 'OPEN',
            cumulativeQuantity: 10,
            cumulativeAmount: '100',
            orderUpdatedAtMs: 120,
            lastExecutionTimeMs: 110,
          }),
        ],
      });
    }).toThrow(/phase regression/);
  });

  it('rejects unknown-phase baseline amount not anchored to a proven phase payload', () => {
    expect(() => {
      assertExecutionHistory({
        snapshots: [
          snap({ factStage: 'OPEN', cumulativeAmount: '44' }),
          snap({ factStage: 'TERMINAL', cumulativeAmount: '45' }),
          snap({ factStage: null, cumulativeAmount: '46' }),
        ],
      });
    }).toThrow(/unknown-phase baseline amount is not anchored/);
  });

  it('rejects history exceeding the final fact and selects latest known snapshot', () => {
    expect(() => {
      assertExecutionHistory({
        snapshots: [snap({ cumulativeQuantity: 10 })],
        finalSnapshot: snap({ cumulativeQuantity: 5 }),
      });
    }).toThrow(/exceeds current fact/);

    expect(
      assertExecutionHistory({ snapshots: [
        snap({ factStage: 'OPEN', cumulativeAmount: '44' }),
        snap({ factStage: 'TERMINAL', cumulativeAmount: '45' }),
        snap({ factStage: null, cumulativeAmount: '45' }),
      ] }),
    ).toMatchObject({ factStage: 'TERMINAL', cumulativeAmount: '45' });
  });
});

describe('historical execution time compatibility', () => {
  it('keeps historical T after revision without adding a T<=revision constraint', () => {
    assertExecutionHistory({
      snapshots: [
        snap({ orderUpdatedAtMs: 100, lastExecutionTimeMs: 120 }),
        snap({ orderUpdatedAtMs: 110, lastExecutionTimeMs: 120 }),
      ],
      finalSnapshot: snap({ orderUpdatedAtMs: 120, lastExecutionTimeMs: 120 }),
    });
  });

  it('still rejects same-revision execution time conflict when T is after revision', () => {
    expect(() => {
      assertExecutionHistory({
        snapshots: [
          snap({ factStage: 'OPEN', orderUpdatedAtMs: 100, lastExecutionTimeMs: 120 }),
          snap({ orderUpdatedAtMs: 100, lastExecutionTimeMs: 125 }),
        ],
      });
    }).toThrow(/same revision\/quantity execution time conflict/);
  });
});

describe('same-quantity cross-revision execution time', () => {
  it('rejects execution time regression across same-quantity revisions', () => {
    expect(() => {
      assertExecutionHistory({
        snapshots: [
          snap({ orderUpdatedAtMs: 100, lastExecutionTimeMs: 120 }),
          snap({ orderUpdatedAtMs: 110, lastExecutionTimeMs: 115 }),
        ],
      });
    }).toThrow(/execution time regression/);
  });
});

/** 三条独立事实的全部文件排列，不能靠到达顺序掩盖中间金额回退。 */
function permutations<T>(items: readonly T[]): T[][] {
  if (items.length === 0) return [[]];

  return items.flatMap((item, index) =>
    permutations(items.filter((_, other) => other !== index)).map((tail) => [item, ...tail]),
  );
}

for (const [openAmount, terminalAmount, accepted] of [
  ['90', '110', false],
  ['110', '90', true],
] as const) {
  it(`history matches online phase sequence 100 -> ${openAmount} -> ${terminalAmount} for all permutations`, () => {
    const ordered = [
      snap({ factStage: 'OPEN', cumulativeQuantity: 5, cumulativeAmount: '100' }),
      snap({
        factStage: 'OPEN',
        cumulativeAmount: openAmount,
        orderUpdatedAtMs: 110,
        lastExecutionTimeMs: 110,
      }),
      snap({
        factStage: 'TERMINAL',
        cumulativeAmount: terminalAmount,
        orderUpdatedAtMs: 110,
        lastExecutionTimeMs: 110,
      }),
    ];
    const online = () => {
      let known: BrokerOrderExecutionFact | undefined;
      for (const snapshot of ordered) {
        if (snapshot.factStage === null) throw new Error('test requires proven phase');

        known =
          mergeExecutionFact(known, {
            brokerOrderId: snapshot.orderId,
            symbol: snapshot.symbol,
            side: snapshot.side,
            phase: snapshot.factStage,
            cumulativeQuantity: snapshot.cumulativeQuantity,
            cumulativeAmount: snapshot.cumulativeAmount,
            executionTimeMs: snapshot.lastExecutionTimeMs,
            updatedAtMs: snapshot.orderUpdatedAtMs,
          }) ?? known;
      }
    };

    if (accepted) expect(online).not.toThrow();
    else expect(online).toThrow(/正成交增量缺少正金额增量/);

    for (const snapshots of permutations(ordered)) {
      const recover = () => {
        assertExecutionHistory({ snapshots });
      };

      if (accepted) expect(recover).not.toThrow();
      else expect(recover).toThrow(/正成交增量缺少正金额增量/);
    }
  });
}
