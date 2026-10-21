/**
 * 订单累计事实唯一裁决矩阵。
 * 覆盖 zero/T、首次正成交、增量推进、同量修订、乱序/重复、phase-null durable baseline
 * 与普通/保护 SELL 终态原始缺价、FILLED 零量准入；不启动任何 broker IO。
 */
import { describe, expect, it } from 'bun:test';
import {
  mergeBrokerOrderExecutionFact,
  mergeExecutionFact,
} from '../../../src/domain/order/executionFact.js';
import {
  assertOrderObservedFactsReady,
  assertProtectiveSellRawObservationFactsReady,
  assertStateCheckRawExecutionFactsReady,
  mergeMonotonicOrderFact,
  normalizeTerminalStateSnapshot,
} from '../../../src/domain/order/orderFactMerge.js';
import type {
  KnownExecutionBaseline,
  KnownOrderFact,
  OrderObservedFact,
  TerminalStateSnapshot,
} from '../../../src/domain/order/types.js';
import type { BrokerOrderExecutionFact } from '../../../src/types/orderRecorder.js';

function executionFact(
  overrides: Partial<BrokerOrderExecutionFact> = {},
): BrokerOrderExecutionFact {
  return {
    brokerOrderId: 'ORDER-1',
    symbol: 'BULL.HK',
    side: 'BUY',
    cumulativeQuantity: 40,
    cumulativeAmount: '40.8',
    executionTimeMs: 100,
    updatedAtMs: 100,
    phase: 'OPEN',
    ...overrides,
  };
}

function knownOrder(overrides: Partial<KnownOrderFact> = {}): KnownOrderFact {
  return {
    orderId: 'ORDER-1',
    symbol: 'BULL.HK',
    executionSide: 'BUY',
    executionPhase: 'OPEN',
    submittedQuantity: 100,
    status: 'PARTIALLY_FILLED',
    executedQuantity: 40,
    executedPrice: '1.02',
    executedAmount: '40.8',
    lastExecutedTimeMs: 100,
    lastOrderUpdateAtMs: 100,
    ...overrides,
  };
}

function observed(overrides: Partial<OrderObservedFact> = {}): OrderObservedFact {
  return {
    status: 'PARTIALLY_FILLED',
    executionPhase: 'OPEN',
    executedQuantity: 40,
    executedPrice: '1.02',
    executedAmount: '40.8',
    executedTimeMs: 100,
    updatedAtMs: 100,
    ...overrides,
  };
}

function terminalSnapshot(
  overrides: Partial<TerminalStateSnapshot> = {},
): TerminalStateSnapshot {
  return {
    kind: 'TERMINAL',
    executionStatus: 'PARTIAL',
    closedReason: 'CANCELED',
    executedPrice: '1.02',
    executedQuantity: 40,
    executedAmount: '40.8',
    executionTimeMs: 200,
    submittedQuantity: 100,
    orderUpdatedAtMs: 200,
    status: 'CANCELED',
    ...overrides,
  };
}

describe('mergeExecutionFact：共享累计事实唯一裁决', () => {
  it('zero => T 必须 null，且不得声明金额/执行时间', () => {
    const merged = mergeExecutionFact(undefined, executionFact({
      cumulativeQuantity: 0,
      cumulativeAmount: '0',
      executionTimeMs: null,
      phase: 'TERMINAL',
    }));
    expect(merged).not.toBeNull();
    expect(merged?.executionTimeMs).toBeNull();

    expect(() =>
      mergeExecutionFact(undefined, executionFact({
        cumulativeQuantity: 0,
        cumulativeAmount: '1',
        executionTimeMs: null,
      })),
    ).toThrow();

    expect(() =>
      mergeExecutionFact(undefined, executionFact({
        cumulativeQuantity: 0,
        cumulativeAmount: '0',
        executionTimeMs: 10,
      })),
    ).toThrow();
  });

  it('首次正成交无 known 时使用本次原始 updatedAt 代理作为 T', () => {
    const merged = mergeExecutionFact(undefined, executionFact({
      executionTimeMs: 150,
      updatedAtMs: 150,
    }));
    expect(merged?.executionTimeMs).toBe(150);
    expect(merged?.cumulativeAmount).toBe('40.8');
  });

  it('累计量推进才推进 T，且接受本次原始时间与正金额增量', () => {
    const known = executionFact({ updatedAtMs: 100, executionTimeMs: 100 });
    const merged = mergeExecutionFact(known, executionFact({
      cumulativeQuantity: 80,
      cumulativeAmount: '81.6',
      executionTimeMs: 200,
      updatedAtMs: 200,
    }));
    expect(merged?.executionTimeMs).toBe(200);
    expect(merged?.cumulativeQuantity).toBe(80);
  });

  it('同量状态或合法金额修订保留 known T，revision 可推进', () => {
    const known = executionFact({ updatedAtMs: 100, executionTimeMs: 100 });
    const amountRevised = mergeExecutionFact(known, executionFact({
      cumulativeAmount: '41.2',
      executionTimeMs: 250,
      updatedAtMs: 200,
    }));
    expect(amountRevised?.executionTimeMs).toBe(100);
    expect(amountRevised?.cumulativeAmount).toBe('41.2');
    expect(amountRevised?.updatedAtMs).toBe(200);

    const statusRevised = mergeExecutionFact(known, executionFact({
      executionTimeMs: 250,
      updatedAtMs: 200,
    }));
    expect(statusRevised?.executionTimeMs).toBe(100);
    expect(statusRevised?.updatedAtMs).toBe(200);
  });

  it('重复幂等；旧 revision 纯重复忽略，但旧 revision 增量拒绝', () => {
    const known = executionFact();
    expect(mergeExecutionFact(known, executionFact())).toBe(known);

    expect(
      mergeExecutionFact(known, executionFact({ cumulativeQuantity: 0, cumulativeAmount: '0', executionTimeMs: null, updatedAtMs: 50 })),
    ).toBeNull();

    expect(() =>
      mergeExecutionFact(known, executionFact({
        cumulativeQuantity: 80,
        cumulativeAmount: '81.6',
        updatedAtMs: 50,
      })),
    ).toThrow();
  });

  it('数量回退/金额增量非正/phase 倒退都拒绝', () => {
    const known = executionFact({ phase: 'TERMINAL' });
    expect(() =>
      mergeExecutionFact(known, executionFact({ cumulativeQuantity: 20, cumulativeAmount: '20' })),
    ).toThrow();

    expect(() =>
      mergeExecutionFact(executionFact(), executionFact({
        cumulativeQuantity: 80,
        cumulativeAmount: '40.8',
        updatedAtMs: 200,
      })),
    ).toThrow();

    expect(() =>
      mergeExecutionFact(executionFact({ phase: 'TERMINAL' }), executionFact({ phase: 'OPEN' })),
    ).toThrow();
  });

  it('phase-null durable baseline：旧 API 返回 null，新 API 由观察自身声明 phase 且同量保留 known T', () => {
    const baseline: KnownExecutionBaseline = {
      ...executionFact({ phase: 'OPEN' }),
      phase: null,
    };
    expect(
      mergeExecutionFact(baseline, executionFact({ updatedAtMs: 50, executionTimeMs: 50 })),
    ).toBeNull();

    const sameQuantity = mergeExecutionFact(baseline, executionFact({
      executionTimeMs: 300,
      updatedAtMs: 200,
    }));
    expect(sameQuantity?.phase).toBe('OPEN');
    expect(sameQuantity?.executionTimeMs).toBe(100);

    const advanced = mergeExecutionFact(baseline, executionFact({
      cumulativeQuantity: 80,
      cumulativeAmount: '81.6',
      executionTimeMs: 200,
      updatedAtMs: 200,
      phase: 'TERMINAL',
    }));
    expect(advanced?.phase).toBe('TERMINAL');
    expect(advanced?.executionTimeMs).toBe(200);

    // phase 未知的 baseline 不得授权同 revision 的金额修订（即使观察声明 TERMINAL）。
    expect(() =>
      mergeExecutionFact(baseline, executionFact({
        cumulativeAmount: '45',
        executionTimeMs: 300,
        updatedAtMs: 100,
        phase: 'TERMINAL',
      })),
    ).toThrow(/同 revision/);
  });

  it('共享累计裁决拒绝缺失/未知 observed phase，但允许 known baseline phase 未知', () => {
    for (const phase of [undefined, null, 'UNKNOWN'] as const) {
      expect(() =>
        mergeExecutionFact(undefined, {
          ...executionFact(),
          phase,
        } as unknown as BrokerOrderExecutionFact),
      ).toThrow('[订单事实] broker identity、数量、phase 或 revision 无效');
    }

    const baseline: KnownExecutionBaseline = {
      ...executionFact({ phase: 'OPEN' }),
      phase: null,
    };
    expect(mergeExecutionFact(baseline, executionFact())).not.toBeNull();
  });

  it('旧兼容入口对旧 revision 纯重复返回既有事实', () => {
    const known = executionFact();
    expect(
      mergeBrokerOrderExecutionFact(known, executionFact({ updatedAtMs: 50, executionTimeMs: 50 })),
    ).toBe(known);
  });
});

describe('共享 owner：数量下降与 known 完整性', () => {
  const knownOpen = executionFact({
    cumulativeQuantity: 10,
    cumulativeAmount: '100',
    executionTimeMs: 1500,
    updatedAtMs: 2000,
    phase: 'OPEN',
  });

  it.each([
    ['OPEN->OPEN 同 revision', { phase: 'OPEN' as const, cumulativeQuantity: 5, cumulativeAmount: '50', executionTimeMs: 1500, updatedAtMs: 2000 }],
    ['OPEN->OPEN 同 revision 归零', { phase: 'OPEN' as const, cumulativeQuantity: 0, cumulativeAmount: '0', executionTimeMs: null, updatedAtMs: 2000 }],
    ['TERMINAL->TERMINAL 同 revision', { phase: 'TERMINAL' as const, cumulativeQuantity: 5, cumulativeAmount: '50', executionTimeMs: 1500, updatedAtMs: 2000 }],
    ['新 revision 正->小正', { phase: 'OPEN' as const, cumulativeQuantity: 5, cumulativeAmount: '50', executionTimeMs: 2500, updatedAtMs: 2500 }],
    ['新 revision 正->零', { phase: 'OPEN' as const, cumulativeQuantity: 0, cumulativeAmount: '0', executionTimeMs: null, updatedAtMs: 2500 }],
  ])('同/新 revision 数量下降拒绝：%s（KEEP_KNOWN 不吞冲突）', (_label, overrides) => {
    const observedDecrease = executionFact(overrides);
    expect(() => mergeExecutionFact(knownOpen, observedDecrease)).toThrow(/累计数量倒退/);
    expect(() => mergeBrokerOrderExecutionFact(knownOpen, observedDecrease)).toThrow(
      /累计数量倒退/,
    );
  });

  it('known 正量必须正金额与有效 T；缺失在同/新 revision 都拒绝', () => {
    const missingTime: KnownExecutionBaseline = {
      ...knownOpen,
      executionTimeMs: null,
    };
    expect(() =>
      mergeExecutionFact(missingTime, executionFact({
        cumulativeQuantity: 10,
        cumulativeAmount: '100',
        executionTimeMs: 1000,
        updatedAtMs: 2000,
      })),
    ).toThrow(/缺少可信执行时间/);

    expect(() =>
      mergeExecutionFact(missingTime, executionFact({
        cumulativeQuantity: 10,
        cumulativeAmount: '100',
        executionTimeMs: 3000,
        updatedAtMs: 3000,
      })),
    ).toThrow(/缺少可信执行时间/);

    const missingAmount: KnownExecutionBaseline = {
      ...knownOpen,
      cumulativeAmount: '0',
    };
    expect(() =>
      mergeExecutionFact(missingAmount, executionFact({
        cumulativeQuantity: 10,
        cumulativeAmount: '100',
        executionTimeMs: 1000,
        updatedAtMs: 2000,
      })),
    ).toThrow(/缺少可信金额/);
  });

  it('历史 T>revision 继续接受，同量修订保留 known T', () => {
    const historical = executionFact({
      cumulativeQuantity: 10,
      cumulativeAmount: '100',
      executionTimeMs: 2500,
      updatedAtMs: 2000,
      phase: 'OPEN',
    });
    const merged = mergeExecutionFact(historical, executionFact({
      cumulativeQuantity: 10,
      cumulativeAmount: '110',
      executionTimeMs: 2100,
      updatedAtMs: 2100,
      phase: 'OPEN',
    }));
    expect(merged?.executionTimeMs).toBe(2500);
    expect(merged?.cumulativeAmount).toBe('110');
    expect(merged?.updatedAtMs).toBe(2100);
  });
});

describe('mergeMonotonicOrderFact：状态与缺价边界', () => {
  it('OPEN 增量缺价直接拒绝，不用 known 补价', () => {
    expect(() =>
      mergeMonotonicOrderFact(knownOrder(), observed({
        executedQuantity: 80,
        executedAmount: null,
        executedPrice: null,
        updatedAtMs: 200,
        executedTimeMs: 200,
      })),
    ).toThrow();
  });

  it('首次/恢复正成交无 known 且缺价拒绝', () => {
    expect(() =>
      mergeMonotonicOrderFact(knownOrder({ executedQuantity: 0, executedPrice: null, executedAmount: '0', lastExecutedTimeMs: null, lastOrderUpdateAtMs: null, status: 'WORKING' }), observed({
        executedQuantity: 40,
        executedAmount: null,
        executedPrice: null,
        updatedAtMs: 200,
        executedTimeMs: 200,
      })),
    ).toThrow();
  });

  it('增量推进使用本次原始时间；同量修订保留 known T', () => {
    const advanced = mergeMonotonicOrderFact(knownOrder(), observed({
      executedQuantity: 80,
      executedPrice: '1.02',
      executedAmount: '81.6',
      updatedAtMs: 200,
      executedTimeMs: 200,
    }));
    expect(advanced?.executedTimeMs).toBe(200);
    expect(advanced?.executedQuantity).toBe(80);

    const revised = mergeMonotonicOrderFact(knownOrder(), observed({
      executedPrice: '1.03',
      executedAmount: '41.2',
      updatedAtMs: 200,
      executedTimeMs: 200,
    }));
    expect(revised?.executedTimeMs).toBe(100);
    expect(revised?.executedPrice).toBe('1.03');
    expect(revised?.updatedAtMs).toBe(200);
  });

  it('缺失或未知 executionPhase 直接拒绝，不进入累计裁决', () => {
    const base = observed();

    for (const executionPhase of [undefined, null, 'UNKNOWN'] as const) {
      expect(() =>
        mergeMonotonicOrderFact(knownOrder(), {
          ...base,
          executionPhase,
        } as unknown as OrderObservedFact),
      ).toThrow('[订单监控] broker事实缺少已验证中性executionPhase');
    }
  });

  it('仅 OPEN->OPEN 同 revision 的弱观察被忽略，不扩展到终态/金额增加/时间推进', () => {
    const known = knownOrder({
      executedQuantity: 10,
      executedPrice: '10',
      executedAmount: '100',
      lastExecutedTimeMs: 1500,
      lastOrderUpdateAtMs: 2000,
    });

    expect(
      mergeMonotonicOrderFact(
        known,
        observed({
          executedQuantity: 5,
          executedPrice: '10',
          executedAmount: '50',
          executedTimeMs: 1500,
          updatedAtMs: 2000,
        }),
      ),
    ).toBeNull();

    expect(
      mergeMonotonicOrderFact(
        known,
        observed({
          executedQuantity: 0,
          executedPrice: null,
          executedAmount: '0',
          executedTimeMs: null,
          updatedAtMs: 2000,
        }),
      ),
    ).toBeNull();

    // 终态观察、金额增加、执行时间推进都不得被弱观察过滤吞掉。
    expect(() =>
      mergeMonotonicOrderFact(
        known,
        observed({
          status: 'CANCELED',
          executionPhase: 'TERMINAL',
          executedQuantity: 5,
          executedPrice: '10',
          executedAmount: '50',
          executedTimeMs: 1500,
          updatedAtMs: 2000,
        }),
      ),
    ).toThrow(/累计数量倒退/);

    expect(() =>
      mergeMonotonicOrderFact(
        known,
        observed({
          executedQuantity: 5,
          executedPrice: '22',
          executedAmount: '110',
          executedTimeMs: 1500,
          updatedAtMs: 2000,
        }),
      ),
    ).toThrow(/累计数量倒退/);

    expect(() =>
      mergeMonotonicOrderFact(
        known,
        observed({
          executedQuantity: 5,
          executedPrice: '10',
          executedAmount: '50',
          executedTimeMs: 1600,
          updatedAtMs: 2000,
        }),
      ),
    ).toThrow(/累计数量倒退/);
  });

  it('known 正量缺 T/零金额在入口同样拒绝', () => {
    expect(() =>
      mergeMonotonicOrderFact(
        knownOrder({ lastExecutedTimeMs: null }),
        observed({ executedTimeMs: 100, updatedAtMs: 100 }),
      ),
    ).toThrow(/缺少可信执行时间/);

    expect(() =>
      mergeMonotonicOrderFact(
        knownOrder({ executedAmount: '0' }),
        observed({ executedTimeMs: 100, updatedAtMs: 100 }),
      ),
    ).toThrow(/缺少可信金额/);
  });

  it('重复 push 幂等，旧 revision 非增量忽略、增量拒绝', () => {
    const known = knownOrder();
    expect(mergeMonotonicOrderFact(known, observed())).toBeNull();
    expect(
      mergeMonotonicOrderFact(known, observed({ updatedAtMs: 50, executedTimeMs: 50 })),
    ).toBeNull();

    expect(() =>
      mergeMonotonicOrderFact(known, observed({
        executedQuantity: 80,
        executedAmount: '81.6',
        updatedAtMs: 50,
        executedTimeMs: 50,
      })),
    ).toThrow();
  });
});

describe('normalizeTerminalStateSnapshot：本次完整原始证据先于任何 known/stale 收口', () => {
  it.each([
    {
      label: '首次 BUY',
      executionSide: 'BUY' as const,
      executionPhase: 'OPEN' as const,
      status: 'WORKING' as const,
      quantity: 0,
      revision: null,
    },
    {
      label: '旧 revision SELL',
      executionSide: 'SELL' as const,
      executionPhase: 'OPEN' as const,
      status: 'PARTIALLY_FILLED' as const,
      quantity: 40,
      revision: 50,
    },
    {
      label: '已终态旧 revision',
      executionSide: 'SELL' as const,
      executionPhase: 'TERMINAL' as const,
      status: 'FILLED' as const,
      quantity: 40,
      revision: 50,
    },
  ])('$label 的 FILLED 零量在原始准入拒绝，不得被 known/stale 旁路', (scenario) => {
    const known = knownOrder({
      executionSide: scenario.executionSide,
      executionPhase: scenario.executionPhase,
      executedQuantity: scenario.quantity,
      executedAmount: scenario.quantity === 0 ? '0' : '40.8',
      executedPrice: scenario.quantity === 0 ? null : '1.02',
      lastExecutedTimeMs: scenario.quantity === 0 ? null : 100,
      lastOrderUpdateAtMs: scenario.quantity === 0 ? null : 100,
      status: scenario.status,
    });
    const terminal = terminalSnapshot({
      status: 'FILLED',
      closedReason: 'FILLED',
      executionStatus: 'FILLED',
      executedQuantity: 0,
      executedPrice: '0',
      executedAmount: '0',
      executionTimeMs: null,
      orderUpdatedAtMs: scenario.revision,
    });
    const raw = observed({
      status: terminal.status,
      executionPhase: 'TERMINAL',
      executedQuantity: 0,
      executedPrice: '0',
      executedAmount: '0',
      executedTimeMs: null,
      updatedAtMs: scenario.revision,
    });
    const before = structuredClone(known);
    const error = 'FILLED 观察必须具有正累计成交数量';
    expect(() => assertOrderObservedFactsReady(raw)).toThrow(error);
    expect(() => mergeMonotonicOrderFact(known, raw)).toThrow(error);
    expect(() => { assertStateCheckRawExecutionFactsReady(known, terminal); }).toThrow(error);
    expect(() => { assertStateCheckRawExecutionFactsReady(null, terminal); }).toThrow(error);
    expect(() => normalizeTerminalStateSnapshot(known, terminal)).toThrow(error);
    expect(known).toEqual(before);
  });

  it.each([
    { label: '同量缺价金额', raw: { executedPrice: null, executedAmount: null }, known: {} },
    { label: '旧 revision 单边缺价', raw: { executedPrice: null, orderUpdatedAtMs: 50 }, known: {} },
    { label: '旧 revision 单边缺金额', raw: { executedAmount: null, orderUpdatedAtMs: 50 }, known: {} },
    { label: '已终态零价金额', raw: { executedPrice: '0', executedAmount: '0' }, known: { executionPhase: 'TERMINAL' as const } },
    { label: '已终态负金额', raw: { executedAmount: '-40.8' }, known: { executionPhase: 'TERMINAL' as const } },
    { label: '重复观察 NaN 价', raw: { executedPrice: 'NaN', orderUpdatedAtMs: 100 }, known: {} },
    { label: '旧 revision NaN 金额', raw: { executedAmount: 'NaN', orderUpdatedAtMs: 50 }, known: {} },
    { label: '重复观察价量金额不符', raw: { executedAmount: '41', orderUpdatedAtMs: 100 }, known: {} },
    { label: '同量缺 revision', raw: { orderUpdatedAtMs: null }, known: {} },
    { label: '同量无效 revision', raw: { orderUpdatedAtMs: Number.NaN }, known: {} },
    { label: '同量无效 T', raw: { executionTimeMs: Number.NaN }, known: {} },
  ])('$label 不得被 known、重复或旧 revision 旁路', ({ raw, known: overrides }) => {
    const known = knownOrder(overrides);
    const terminal = terminalSnapshot(raw);
    const before = structuredClone(known);
    expect(() => normalizeTerminalStateSnapshot(known, terminal)).toThrow();
    expect(() => mergeMonotonicOrderFact(known, observed({
      status: terminal.status,
      executionPhase: 'TERMINAL',
      executedQuantity: terminal.executedQuantity,
      executedPrice: terminal.executedPrice,
      executedAmount: terminal.executedAmount,
      executedTimeMs: terminal.executionTimeMs,
      updatedAtMs: terminal.orderUpdatedAtMs,
    }))).toThrow();
    expect(known).toEqual(before);
  });

  it.each([20, 40])('完整旧 revision 非增量终态（本次量 %s）仍用更强 known 事实收口', (executedQuantity) => {
    const normalized = normalizeTerminalStateSnapshot(knownOrder(), terminalSnapshot({
      executedQuantity,
      executedPrice: '1',
      executedAmount: String(executedQuantity),
      executionTimeMs: 50,
      orderUpdatedAtMs: 50,
    }));
    expect(normalized).toMatchObject({
      executedQuantity: 40,
      executedPrice: '1.02',
      executedAmount: '40.8',
      executedTimeMs: 100,
      orderUpdatedAtMs: 100,
      status: 'CANCELED',
    });
  });

  it('完整旧 revision 的增量终态仍拒绝', () => {
    expect(() => normalizeTerminalStateSnapshot(knownOrder(), terminalSnapshot({
      executedQuantity: 80,
      executedAmount: '81.6',
      executionTimeMs: 50,
      orderUpdatedAtMs: 50,
    }))).toThrow(/累计数量推进但 revision 倒退/);
  });

  it('共享 merge 对完整旧 revision 同量终态仍以 known 关闭资源', () => {
    expect(mergeMonotonicOrderFact(knownOrder(), observed({
      status: 'CANCELED',
      executionPhase: 'TERMINAL',
      executedPrice: '1',
      executedAmount: '40',
      executedTimeMs: 50,
      updatedAtMs: 50,
    }))).toEqual({
      status: 'CANCELED',
      executionPhase: 'TERMINAL',
      executedQuantity: 40,
      executedPrice: '1.02',
      executedAmount: '40.8',
      executedTimeMs: 100,
      updatedAtMs: 100,
    });
  });

  it('同量完整观察 T=null 沿用本次有效 revision 代理，最终仍保留 known T', () => {
    const normalized = normalizeTerminalStateSnapshot(
      knownOrder({ lastExecutedTimeMs: 300 }),
      terminalSnapshot({ executionTimeMs: null, orderUpdatedAtMs: 200 }),
    );
    expect(normalized.executedTimeMs).toBe(300);
    expect(normalized.orderUpdatedAtMs).toBe(200);
  });

  it('普通同量终态 raw 完整时保留 known T 并接受合法金额修订', () => {
    const normalized = normalizeTerminalStateSnapshot(knownOrder(), terminalSnapshot({
      executedPrice: '1.03',
      executedAmount: '41.2',
      executionTimeMs: 200,
      orderUpdatedAtMs: 200,
    }));
    expect(normalized.executedTimeMs).toBe(100);
    expect(normalized.executedPrice).toBe('1.03');
    expect(normalized.executedAmount).toBe('41.2');
    expect(normalized.orderUpdatedAtMs).toBe(200);
  });

  it('普通增量终态缺价拒绝', () => {
    expect(() =>
      normalizeTerminalStateSnapshot(knownOrder(), terminalSnapshot({
        executedQuantity: 80,
        executedPrice: null,
        executedAmount: null,
        executionTimeMs: null,
      })),
    ).toThrow();
  });

  it('保护 SELL 部分成交后 cancel/reject 缺价必须在终态收口前拒绝', () => {
    const protective = knownOrder({
      executionSide: 'SELL',
      isProtectiveLiquidation: true,
    } as Partial<KnownOrderFact>);
    for (const closedReason of ['CANCELED', 'REJECTED'] as const) {
      expect(() =>
        normalizeTerminalStateSnapshot(
          protective,
          terminalSnapshot({
            closedReason,
            status: closedReason,
            executedPrice: null,
            executedAmount: null,
            executionTimeMs: null,
          }),
        ),
      ).toThrow();
    }
  });

  it('保护 SELL 同量 raw 完整时保留 known T', () => {
    const protective = knownOrder({
      executionSide: 'SELL',
      isProtectiveLiquidation: true,
    } as Partial<KnownOrderFact>);
    const normalized = normalizeTerminalStateSnapshot(
      protective,
      terminalSnapshot({ executionTimeMs: 400, orderUpdatedAtMs: 500 }),
    );
    expect(normalized.executedTimeMs).toBe(100);
    expect(normalized.executedAmount).toBe('40.8');
    expect(normalized.status).toBe('CANCELED');
  });

  it('保护 SELL 纯零关闭不造正成交事实', () => {
    const protective = knownOrder({
      executionSide: 'SELL',
      isProtectiveLiquidation: true,
      submittedQuantity: 100,
      executedQuantity: 0,
      executedPrice: null,
      executedAmount: '0',
      lastExecutedTimeMs: null,
      lastOrderUpdateAtMs: null,
      status: 'WORKING',
    } as Partial<KnownOrderFact>);
    const normalized = normalizeTerminalStateSnapshot(
      protective,
      terminalSnapshot({
        executionStatus: 'NONE',
        executedQuantity: 0,
        executedPrice: null,
        executedAmount: null,
        executionTimeMs: null,
      }),
    );
    expect(normalized.executedQuantity).toBe(0);
    expect(normalized.executedTimeMs).toBeNull();
    expect(normalized.executedAmount).toBe('0');
  });

  it('无 revision 零关闭不得否认 known 正量，BUY/SELL 都拒绝', () => {
    for (const executionSide of ['BUY', 'SELL'] as const) {
      const known = knownOrder({
        executionSide,
        executedQuantity: 10,
        executedPrice: '10',
        executedAmount: '100',
        lastExecutedTimeMs: 1500,
        lastOrderUpdateAtMs: 2000,
      });
      const zeroTerminal = terminalSnapshot({
        executionStatus: 'NONE',
        executedQuantity: 0,
        executedAmount: null,
        executedPrice: null,
        executionTimeMs: null,
        orderUpdatedAtMs: null,
      });

      expect(() =>
        mergeMonotonicOrderFact(known, {
          status: 'CANCELED',
          executionPhase: 'TERMINAL',
          executedQuantity: 0,
          executedAmount: null,
          executedPrice: null,
          executedTimeMs: null,
          updatedAtMs: null,
        }),
      ).toThrow(/无 revision 零关闭/);

      expect(() => normalizeTerminalStateSnapshot(known, zeroTerminal)).toThrow(
        /无 revision 零关闭/,
      );
    }
  });

  it('known 完整为零时允许无 revision 零关闭', () => {
    const zeroKnown = knownOrder({
      executionPhase: 'OPEN',
      status: 'WORKING',
      executedQuantity: 0,
      executedPrice: null,
      executedAmount: '0',
      lastExecutedTimeMs: null,
      lastOrderUpdateAtMs: 2000,
    });
    const normalized = normalizeTerminalStateSnapshot(
      zeroKnown,
      terminalSnapshot({
        executionStatus: 'NONE',
        executedQuantity: 0,
        executedAmount: null,
        executedPrice: null,
        executionTimeMs: null,
        orderUpdatedAtMs: null,
      }),
    );

    expect(normalized).toMatchObject({
      executedQuantity: 0,
      executedAmount: '0',
      executedTimeMs: null,
      orderUpdatedAtMs: 2000,
      status: 'CANCELED',
    });
  });

  it('保护 SELL 原始声明 PARTIAL/FILLED 但量价缺失时拒绝', () => {
    expect(() =>
      { assertProtectiveSellRawObservationFactsReady(
        {
          orderId: 'ORDER-1',
          executionSide: 'SELL',
          isProtectiveLiquidation: true,
          executedQuantity: 0,
          lastOrderUpdateAtMs: null,
        },
        observed({
          status: 'PARTIALLY_FILLED',
          executedQuantity: null,
          executedPrice: null,
          executedAmount: null,
          executedTimeMs: null,
          updatedAtMs: 200,
        }),
      ); },
    ).toThrow();
  });
});
