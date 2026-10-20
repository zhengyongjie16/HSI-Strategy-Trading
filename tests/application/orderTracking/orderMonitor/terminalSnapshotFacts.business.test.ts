/**
 * orderMonitor 权威终态快照事实边界测试。
 *
 * 验证 state-check 的 TERMINAL 快照只能在新增累计成交具备本次 broker revision 时推进经济事实，
 * 数量未增加时则仅允许使用已确认事实完成生命周期收口。
 */

import { describe, expect, it } from 'bun:test';
import { orderAnalysis } from '../../../../src/domain/order/orderAnalysis.js';
import {
  assertProtectiveSellRawTerminalStateFactsReady,
  normalizeTerminalStateSnapshot,
} from '../../../../src/domain/order/orderFactMerge.js';
import type {
  KnownOrderFact,
  OrderMonitorTrackedOrder,
  TerminalStateSnapshot,
} from '../../../../src/domain/order/types.js';
import { createDailyLossTracker } from '../../../../src/domain/risk/dailyLossTracker.js';
import { toHongKongTimeIso } from '../../../../src/utils/time/index.js';

const FIRST_REVISION_MS = Date.parse('2026-07-14T02:00:00.000Z');
const FIRST_EXECUTION_MS = Date.parse('2026-07-14T02:00:00.000Z');

function createKnownFact(overrides: Partial<KnownOrderFact> = {}): KnownOrderFact {
  return {
    orderId: 'ORDER-TERMINAL-FACT-BOUNDARY',
    symbol: 'BULL.HK',
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
  for (const sideText of ['BUY', 'SELL'] as const) {
    it(`rejects ordinary ${sideText} terminal execution advance without a raw broker revision`, () => {
      expect(() => {
        normalizeTerminalStateSnapshot(
          createKnownFact({ executionSide: sideText }),
          createTerminalState({ orderUpdatedAtMs: null }),
        );
      }).toThrow(/订单观察缺少有效 broker revision|保护性 SELL 存在成交事实但本次观察缺少有效成交价|保护性 SELL 存在成交事实但本次观察缺少有效 broker revision/);
    });

    it(`rejects ordinary ${sideText} terminal execution advance with a stale raw broker revision`, () => {
      expect(() => {
        normalizeTerminalStateSnapshot(
          createKnownFact({ executionSide: sideText }),
          createTerminalState({
            executionTimeMs: FIRST_EXECUTION_MS - 1,
            orderUpdatedAtMs: FIRST_REVISION_MS - 1,
          }),
        );
      }).toThrow(/累计数量推进但 revision 倒退/);
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

  it('rejects a protective SELL terminal without raw facts even when a known fact is established', () => {
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
    }).toThrow(/保护性 SELL 存在成交事实但本次观察缺少有效成交价/);

    expect(() => {
      normalizeTerminalStateSnapshot(knownFact, terminalState, true);
    }).toThrow();
  });

  it('records a protective terminal lifecycle close from complete raw facts without advancing DailyLoss execution', () => {
    const knownFact = createProtectiveSellKnownFact();
    const terminalState = createTerminalState({
      executedQuantity: 40,
      executedAmount: '41.2',
      executedPrice: '1.03',
      executionTimeMs: FIRST_REVISION_MS + 1,
      orderUpdatedAtMs: FIRST_REVISION_MS + 1,
    });
    assertProtectiveSellRawTerminalStateFactsReady(knownFact, terminalState);
    const normalized = normalizeTerminalStateSnapshot(knownFact, terminalState, true);
    const dailyLossTracker = createDailyLossTracker({
      onOwnershipWarning: () => {},
      ...orderAnalysis,
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
    }).toThrow(/订单观察缺少有效 broker revision|保护性 SELL 存在成交事实但本次观察缺少有效成交价|保护性 SELL 存在成交事实但本次观察缺少有效 broker revision/);
  });
});
