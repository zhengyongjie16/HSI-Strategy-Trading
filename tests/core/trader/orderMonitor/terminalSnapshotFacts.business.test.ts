/**
 * orderMonitor 权威终态快照事实边界测试。
 *
 * 验证 state-check 的 TERMINAL 快照只能在新增累计成交具备本次 broker revision 时推进经济事实，
 * 数量未增加时则仅允许使用已确认事实完成生命周期收口。
 */
import { describe, expect, it } from 'bun:test';
import { createDailyLossOrderAnalysisDeps } from '../../../../src/core/orderRecorder/index.js';
import { createDailyLossTracker } from '../../../../src/core/riskController/dailyLossTracker.js';
import {
  assertProtectiveSellRawTerminalStateFactsReady,
  normalizeTerminalStateSnapshot,
} from '../../../../src/core/trader/orderMonitor/orderFactMerge.js';
import type {
  KnownOrderFact,
  OrderMonitorTrackedOrder,
  TerminalStateSnapshot,
} from '../../../../src/core/trader/orderMonitor/types.js';
import { toHongKongTimeIso } from '../../../../src/utils/time/index.js';

const FIRST_REVISION_MS = Date.parse('2026-07-14T02:00:00.000Z');
const FIRST_EXECUTION_MS = Date.parse('2026-07-14T02:00:00.000Z');

function createKnownFact(overrides: Partial<KnownOrderFact> = {}): KnownOrderFact {
  return {
    orderId: 'ORDER-TERMINAL-FACT-BOUNDARY',
    symbol: 'BULL.HK',
    side: 'BUY',
    executionSide: 'BUY',
    executionPhase: 'OPEN',
    submittedQuantity: 100,
    status: 'PARTIALLY_FILLED',
    executedQuantity: 40,
    executedAmount: '40.8',
    executedPrice: '1.02',
    lastExecutedTimeMs: FIRST_EXECUTION_MS,
    lastOrderUpdateAtMs: FIRST_REVISION_MS,
    ...overrides,
  };
}

function createTerminalState(
  overrides: Partial<TerminalStateSnapshot> = {},
): TerminalStateSnapshot {
  return {
    executionStatus: 'PARTIAL',
    kind: 'TERMINAL',
    closedReason: 'CANCELED',
    status: 'CANCELED',
    submittedQuantity: 100,
    executedQuantity: 100,
    executedAmount: '103',
    executedPrice: '1.03',
    executionTimeMs: FIRST_EXECUTION_MS,
    orderUpdatedAtMs: FIRST_REVISION_MS,
    ...overrides,
  };
}

function createProtectiveSellKnownFact(): Pick<
  OrderMonitorTrackedOrder,
  'orderId' | 'side' | 'isProtectiveLiquidation' | 'executedQuantity' | 'lastOrderUpdateAtMs'
> &
  KnownOrderFact {
  return {
    ...createKnownFact(),
    side: 'BUY',
    executionSide: 'SELL',
    isProtectiveLiquidation: true,
  };
}

describe('orderMonitor terminal snapshot raw fact boundary', () => {
  for (const [ordinarySide, sideText] of [
    ['BUY', 'BUY'],
    ['BUY', 'SELL'],
  ] as const) {
    it(`rejects ordinary ${sideText} terminal execution advance without a raw broker revision`, () => {
      expect(() => {
        normalizeTerminalStateSnapshot(
          createKnownFact({ side: ordinarySide, executionSide: sideText }),
          createTerminalState({ orderUpdatedAtMs: null }),
        );
      }).toThrow(/正累计成交缺少有效金额、成交价格、真实执行时间或 broker revision/);
    });

    it(`rejects ordinary ${sideText} terminal execution advance with a stale raw broker revision`, () => {
      expect(() => {
        normalizeTerminalStateSnapshot(
          createKnownFact({ side: ordinarySide, executionSide: sideText }),
          createTerminalState({
            executionTimeMs: FIRST_EXECUTION_MS - 1,
            orderUpdatedAtMs: FIRST_REVISION_MS - 1,
          }),
        );
      }).toThrow(/broker revision.*倒退/);
    });
  }

  it('accepts an ordinary terminal execution advance at the known broker revision', () => {
    const normalized = normalizeTerminalStateSnapshot(createKnownFact(), createTerminalState());

    expect(normalized).toMatchObject({
      executedQuantity: 100,
      executedPrice: '1.03',
      executedAmount: '103',
      executedTimeMs: FIRST_EXECUTION_MS,
      orderUpdatedAtMs: FIRST_REVISION_MS,
    });
  });

  it('rejects a terminal cumulative execution that exceeds the tracked effective submitted quantity', () => {
    const knownFact = {
      ...createKnownFact(),
      submittedQuantity: 100,
    };

    expect(() => {
      normalizeTerminalStateSnapshot(
        knownFact,
        createTerminalState({
          closedReason: 'FILLED',
          executedQuantity: 101,
          executedAmount: '104.03',
          executionStatus: 'FILLED',
          status: 'FILLED',
        }),
      );
    }).toThrow(/累计成交量超过有效委托数量/);
  });

  it('allows a protective SELL terminal without new execution to close from an established fact', () => {
    const knownFact = createProtectiveSellKnownFact();
    const terminalState = createTerminalState({
      executedQuantity: 40,
      executedAmount: '40.8',
      executionTimeMs: null,
      executedPrice: null,
      orderUpdatedAtMs: null,
    });

    expect(() => {
      assertProtectiveSellRawTerminalStateFactsReady(knownFact, terminalState);
    }).not.toThrow();

    const normalized = normalizeTerminalStateSnapshot(knownFact, terminalState, true);

    expect(normalized).toMatchObject({
      closedReason: 'CANCELED',
      executedQuantity: 40,
      executedPrice: '1.02',
      executedTimeMs: FIRST_REVISION_MS,
      orderUpdatedAtMs: FIRST_REVISION_MS,
    });
  });

  it('records a protective terminal lifecycle close without advancing DailyLoss execution', () => {
    const knownFact = createProtectiveSellKnownFact();
    const terminalState = createTerminalState({
      executedQuantity: 40,
      executedAmount: '40.8',
      executionTimeMs: null,
      executedPrice: null,
      orderUpdatedAtMs: null,
    });
    assertProtectiveSellRawTerminalStateFactsReady(knownFact, terminalState);
    const normalized = normalizeTerminalStateSnapshot(knownFact, terminalState, true);
    const dailyLossTracker = createDailyLossTracker({
      ...createDailyLossOrderAnalysisDeps(),
      resolveOrderOwnership: () => null,
      toHongKongTimeIso,
    });
    dailyLossTracker.resetAll(new Date(FIRST_REVISION_MS - 60_000));
    if (
      knownFact.executedPrice === null ||
      knownFact.lastExecutedTimeMs === null ||
      knownFact.lastOrderUpdateAtMs === null ||
      normalized.executedPrice === null ||
      normalized.executedQuantity === null ||
      normalized.executedTimeMs === null ||
      normalized.orderUpdatedAtMs === null
    ) {
      throw new Error('expected established protective execution fact');
    }

    const openResult = dailyLossTracker.recordCumulativeExecution({
      factStage: 'OPEN',
      direction: 'LONG',
      symbol: 'BULL.HK',
      side: 'SELL',
      executedPrice: knownFact.executedPrice,
      executedQuantity: knownFact.executedQuantity,
      executedTimeMs: knownFact.lastExecutedTimeMs,
      orderUpdatedAtMs: knownFact.lastOrderUpdateAtMs,
      orderId: knownFact.orderId,
    });
    const terminalResult = dailyLossTracker.recordCumulativeExecution({
      factStage: 'TERMINAL',
      direction: 'LONG',
      symbol: 'BULL.HK',
      side: 'SELL',
      executedPrice: normalized.executedPrice,
      executedQuantity: normalized.executedQuantity,
      executedTimeMs: normalized.executedTimeMs,
      orderUpdatedAtMs: normalized.orderUpdatedAtMs,
      orderId: knownFact.orderId,
    });

    expect(openResult).toEqual({
      admission: 'ADMITTED',
      authoritativeFactChanged: true,
      executionAdvanced: true,
    });

    expect(terminalResult).toEqual({
      admission: 'ADMITTED',
      authoritativeFactChanged: true,
      executionAdvanced: false,
    });
  });

  it('continues to reject a protective SELL terminal execution advance without raw facts', () => {
    const knownFact = createProtectiveSellKnownFact();
    const terminalState = createTerminalState({
      orderUpdatedAtMs: null,
    });

    expect(() => {
      assertProtectiveSellRawTerminalStateFactsReady(knownFact, terminalState);
    }).toThrow(/正累计成交缺少有效金额、成交价格、真实执行时间或 broker revision/);
  });
});
