/**
 * SEAT_REFRESH 的 API 归一失败必须在 Daily prepare/O commit 之前阻断，不得进入重算或半提交。
 */
import { describe, expect, it, spyOn } from 'bun:test';
import type { OrderFact } from '../../../src/types/trade.js';
import { createMonitorContext } from '../../helpers/asyncProgram.js';
import { createSnapshotFixture } from '../../helpers/accountPositionSnapshot.js';
import {
  createAccountSnapshotDouble,
  createMarketDataClientDouble,
  createQuoteSubscriptionRuntimeDouble,
} from '../../helpers/testDoubles.js';
import { createSeatActivationFixture } from './fixtures.js';
import { createTerminationRuntime } from '../../../src/runtime/lifecycle/terminationRuntime.js';

function positiveOrderMissingAmount(): OrderFact {
  const updatedAtMs = Date.parse('2026-03-13T02:59:00.000Z');
  return {
    orderId: 'POSITIVE-MISSING-AMOUNT',
    symbol: 'BULL.HK',
    stockName: 'HSI RC',
    executionSide: 'BUY',
    executionStatus: 'NONE',
    executionPhase: 'TERMINAL',
    status: 'FILLED',
    orderType: 'ELO',
    price: null,
    quantity: 10,
    executedPrice: null,
    executedQuantity: 10,
    executedAmount: null,
    executionTimeMs: updatedAtMs,
    updatedAtMs,
    submittedAt: new Date(updatedAtMs - 1000),
    updatedAt: new Date(updatedAtMs),
  };
}

describe('SEAT_REFRESH API 归一失败', () => {
  it('正成交缺原始金额时不进入 Daily prepare/publish、O 预检或 commit', async () => {
    const context = createMonitorContext();
    context.symbolRegistry.updateSeatState('LONG', {
      ...context.symbolRegistry.getSeatState('LONG'),
      status: 'ACTIVATING',
      symbol: 'BULL.HK',
      callPrice: '20000',
    });
    const snapshot = await createSnapshotFixture({
      account: createAccountSnapshotDouble('100000'),
      positions: [],
    });
    spyOn(context.orderRecorder, 'fetchAllOrdersFromAPI').mockImplementation(async () => [
      positiveOrderMissingAmount(),
    ]);
    const dailyPrepare = spyOn(
      context.dailyLossTracker,
      'prepareRecalculationFromAllOrders',
    );
    const dailyPublish = spyOn(context.dailyLossTracker, 'publishRecalculation');
    const validate = spyOn(context.orderRecorder, 'validateRebuildSnapshot');
    const commit = spyOn(context.orderRecorder, 'commitRebuildSnapshot');
    const termination = createTerminationRuntime({
      closeTradingGate: () => {},
      closeProducerAdmission: () => {},
      stopProducers: [],
      onSecondaryError: () => {},
    });
    const workflow = createSeatActivationFixture({
      termination,
      clock: { now: () => new Date('2026-03-13T03:00:00.000Z') },
      monitorContext: context,
      snapshot,
      marketDataClient: createMarketDataClientDouble({ getQuotes: async () => new Map() }),
      quoteSubscriptionRuntime: createQuoteSubscriptionRuntimeDouble(),
    });
    const request = {
      dayEpoch: snapshot.getView().token.dayEpoch,
      direction: 'LONG' as const,
      seatVersion: 2,
      previousSymbol: 'OLD_BULL.HK',
      nextSymbol: 'BULL.HK',
      callPrice: '20000',
      symbolName: 'BULL.HK',
    };

    let caught: unknown = null;
    try {
      await workflow.activate(request, () => true);
    } catch (error) {
      caught = error;
    }

    expect(termination.getFatalState()).toEqual({ hasFatalError: true, error: caught });
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('正成交缺少本次原始金额');
    expect(dailyPrepare).not.toHaveBeenCalled();
    expect(dailyPublish).not.toHaveBeenCalled();
    expect(validate).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(context.dailyLossTracker.getLossOffset('LONG')).toBe('0');
    expect(context.symbolRegistry.getSeatState('LONG').status).toBe('ACTIVATING');
  });
});
