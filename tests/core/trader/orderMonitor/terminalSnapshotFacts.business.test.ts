/**
 * orderMonitor 权威终态快照事实边界测试。
 *
 * 验证 state-check 的 TERMINAL 快照只能在新增累计成交具备本次 broker revision 时推进经济事实，
 * 数量未增加时则仅允许使用已确认事实完成生命周期收口。
 */
import { describe, expect, it } from 'bun:test';
import { OrderSide, OrderStatus } from 'longbridge';
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

function createKnownFact(overrides: Partial<KnownOrderFact> = {}): KnownOrderFact {
  return {
    orderId: 'ORDER-TERMINAL-FACT-BOUNDARY',
    submittedQuantity: 100,
    status: OrderStatus.PartialFilled,
    executedQuantity: 40,
    executedPrice: 1.02,
    lastExecutedTimeMs: FIRST_REVISION_MS,
    lastOrderUpdateAtMs: FIRST_REVISION_MS,
    ...overrides,
  };
}

function createTerminalState(
  overrides: Partial<TerminalStateSnapshot> = {},
): TerminalStateSnapshot {
  return {
    kind: 'TERMINAL',
    closedReason: 'CANCELED',
    status: OrderStatus.Canceled,
    submittedQuantity: 100,
    executedQuantity: 100,
    executedPrice: 1.03,
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
    side: OrderSide.Sell,
    isProtectiveLiquidation: true,
  };
}

describe('orderMonitor terminal snapshot raw fact boundary', () => {
  for (const ordinarySide of [OrderSide.Buy, OrderSide.Sell] as const) {
    const sideText = ordinarySide === OrderSide.Buy ? 'BUY' : 'SELL';

    it(`rejects ordinary ${sideText} terminal execution advance without a raw broker revision`, () => {
      expect(() => {
        normalizeTerminalStateSnapshot(
          createKnownFact(),
          createTerminalState({ orderUpdatedAtMs: null }),
        );
      }).toThrow(/累计成交数量推进但原始执行时间或 broker revision 无效/);
    });

    it(`rejects ordinary ${sideText} terminal execution advance with a stale raw broker revision`, () => {
      expect(() => {
        normalizeTerminalStateSnapshot(
          createKnownFact(),
          createTerminalState({ orderUpdatedAtMs: FIRST_REVISION_MS - 1 }),
        );
      }).toThrow(/累计成交数量推进但原始执行时间倒退/);
    });
  }

  it('accepts an ordinary terminal execution advance at the known broker revision', () => {
    const normalized = normalizeTerminalStateSnapshot(createKnownFact(), createTerminalState());

    expect(normalized).toMatchObject({
      executedQuantity: 100,
      executedPrice: 1.03,
      executedTimeMs: FIRST_REVISION_MS,
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
          status: OrderStatus.Filled,
          executedQuantity: 101,
        }),
      );
    }).toThrow(/累计成交量超过有效委托数量/);
  });

  it('allows a protective SELL terminal without new execution to close from an established fact', () => {
    const knownFact = createProtectiveSellKnownFact();
    const terminalState = createTerminalState({
      executedQuantity: 40,
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
      executedPrice: 1.02,
      executedTimeMs: FIRST_REVISION_MS,
      orderUpdatedAtMs: FIRST_REVISION_MS,
    });
  });

  it('records a protective terminal lifecycle close without advancing DailyLoss execution', () => {
    const knownFact = createProtectiveSellKnownFact();
    const terminalState = createTerminalState({
      executedQuantity: 40,
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
      side: OrderSide.Sell,
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
      side: OrderSide.Sell,
      executedPrice: normalized.executedPrice,
      executedQuantity: normalized.executedQuantity,
      executedTimeMs: normalized.executedTimeMs,
      orderUpdatedAtMs: normalized.orderUpdatedAtMs,
      orderId: knownFact.orderId,
    });

    expect(openResult).toEqual({ authoritativeFactChanged: true, executionAdvanced: true });
    expect(terminalResult).toEqual({
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
    }).toThrow(/保护性 SELL 存在正累计成交但执行事实不完整/);
  });
});
