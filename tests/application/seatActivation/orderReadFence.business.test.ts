import { recalculateDailyLoss } from '../../helpers/dailyLossRecalculation.js';
import {
  createLoggerDouble,
  createAccountSnapshotDouble,
  createMarketDataClientDouble,
  createQuoteSubscriptionRuntimeDouble,
} from '../../helpers/testDoubles.js';

/**
 * 激活订单读取栅栏集成。
 * 同一真实 recorder/Daily owner 中 LONG 旧订单读取与 SHORT 新 SELL 交错；旧输入不得覆盖新事实，追赶不消耗外部重试。
 */

import { describe, expect, it, spyOn } from 'bun:test';
import { createOrderRecorder } from '../../../src/application/orderTracking/recorder/index.js';
import { createUnrealizedLossChecker } from '../../../src/domain/risk/unrealizedLossChecker.js';
import type { DailyLossOrderSnapshot } from '../../../src/types/risk.js';
import type { OrderFact } from '../../../src/types/trade.js';

import { createMonitorContext } from '../../helpers/asyncProgram.js';
import { createSnapshotFixture } from '../../helpers/accountPositionSnapshot.js';
import { createSeatActivationFixture } from './fixtures.js';

function createExecutedOrder(params: {
  readonly orderId: string;
  readonly symbol: string;
  readonly side: 'BUY' | 'SELL';
  readonly price: string;
  readonly amount: string;
  readonly timeMs: number;
  readonly stockName: string;
}): OrderFact & DailyLossOrderSnapshot {
  return {
    orderId: params.orderId,
    symbol: params.symbol,
    stockName: params.stockName,
    executionSide: params.side,
    executionStatus: 'FILLED',
    executionPhase: 'TERMINAL',
    status: 'FILLED',
    orderType: 'ELO',
    quantity: 5,
    price: params.price,
    executedQuantity: 5,
    executedPrice: params.price,
    executedAmount: params.amount,
    executionTimeMs: params.timeMs,
    updatedAtMs: params.timeMs,
    submittedAt: new Date(params.timeMs - 1000),
    updatedAt: new Date(params.timeMs),
  };
}

describe('SeatActivationWorkflow 真实订单读票', () => {
  it('LONG 旧 allOrders 迟到不能覆盖 SHORT 已确认 SELL；同 owner 追赶并保持 Daily prepare→O commit→Daily publish', async () => {
    const now = new Date('2026-03-13T03:00:00.000Z');
    const base = createMonitorContext();
    base.symbolRegistry.updateSeatState('LONG', {
      ...base.symbolRegistry.getSeatState('LONG'),
      status: 'ACTIVATING',
      symbol: 'BULL.HK',
      callPrice: '20000',
    });
    const snapshot = await createSnapshotFixture({
      account: createAccountSnapshotDouble('100000'),
      positions: [],
    });
    const needs: string[] = [];
    const recorder = createOrderRecorder({
      logger: createLoggerDouble(),
      orderSnapshotReadPort: {
        fetchSnapshots: async () => {
          throw new Error('本测试只授权已捕获 query 输入');
        },
      },
      settlementRefreshNeedRecorder: {
        recordSettlementRefreshNeed: () => {
          needs.push('execution');
          snapshot.invalidate();
        },
      },
    });
    const context = { ...base, orderRecorder: recorder };
    const shortBuy = createExecutedOrder({
      orderId: 'SHORT-BUY',
      symbol: 'BEAR.HK',
      side: 'BUY',
      price: '10',
      amount: '50',
      timeMs: now.getTime() - 4000,
      stockName: 'HSI RP',
    });
    const shortSell = createExecutedOrder({
      orderId: 'SHORT-SELL',
      symbol: 'BEAR.HK',
      side: 'SELL',
      price: '9',
      amount: '45',
      timeMs: now.getTime() - 2000,
      stockName: 'HSI RP',
    });
    const longBuy = createExecutedOrder({
      orderId: 'LONG-BUY',
      symbol: 'BULL.HK',
      side: 'BUY',
      price: '12',
      amount: '60',
      timeMs: now.getTime() - 3000,
      stockName: 'HSI RC',
    });
    recalculateDailyLoss(context.dailyLossTracker, [shortBuy], context.config, now);
    recorder.commitRebuildSnapshot(
      [{ symbol: 'BEAR.HK', isLongSymbol: false }],
      [shortBuy],
      () => true,
      'REBUILD',
    );
    const entered = Promise.withResolvers<undefined>();
    const oldRead = Promise.withResolvers<ReadonlyArray<OrderFact>>();
    let reads = 0;
    spyOn(recorder, 'fetchAllOrdersFromAPI').mockImplementation(async () => {
      reads++;
      if (reads === 1) {
        entered.resolve();
        return oldRead.promise;
      }

      expect(context.dailyLossTracker.getLossOffset('SHORT')).toBe('-5');
      expect(recorder.getBuyOrdersForSymbol('BEAR.HK', false)).toEqual([]);
      return [longBuy, shortBuy, shortSell];
    });
    const stages: string[] = [];
    const prepare = context.dailyLossTracker.prepareRecalculationFromAllOrders;
    spyOn(context.dailyLossTracker, 'prepareRecalculationFromAllOrders').mockImplementation(
      (...args) => {
        stages.push('Daily.prepare');
        return prepare(...args);
      },
    );
    const commit = recorder.commitRebuildSnapshot;
    const committed = spyOn(recorder, 'commitRebuildSnapshot').mockImplementation((...args) => {
      stages.push('O.commit');
      expect(context.dailyLossTracker.getLossOffset('SHORT')).toBe('-5');
      expect(args[3]).toBe('ACTIVATION');
      return commit(...args);
    });
    const publish = context.dailyLossTracker.publishRecalculation;
    spyOn(context.dailyLossTracker, 'publishRecalculation').mockImplementation((candidate) => {
      stages.push('Daily.publish');
      publish(candidate);
    });
    const risk = createUnrealizedLossChecker({
      maxUnrealizedLossPerSymbol: null,
      onMissingData: () => {},
    });
    spyOn(context.riskChecker, 'prepareUnrealizedLossData').mockImplementation(risk.prepare);
    spyOn(context.riskChecker, 'publishUnrealizedLossData').mockImplementation(risk.publish);
    const workflow = createSeatActivationFixture({
      termination: { reportFatalError: () => {} },
      clock: { now: () => now },
      monitorContext: context,
      snapshot,
      marketDataClient: createMarketDataClientDouble({ getQuotes: async () => new Map() }),
      quoteSubscriptionRuntime: createQuoteSubscriptionRuntimeDouble(),
    });
    const handling = workflow.activate(
      {
        dayEpoch: snapshot.getView().token.dayEpoch,
        direction: 'LONG',
        seatVersion: 2,
        previousSymbol: null,
        nextSymbol: 'BULL.HK',
        callPrice: '20000',
        symbolName: null,
      },
      () => true,
    );
    await entered.promise;
    recorder.commitExecutionFact(
      {
        brokerOrderId: shortSell.orderId,
        symbol: shortSell.symbol,
        side: 'SELL',
        cumulativeQuantity: 5,
        cumulativeAmount: '45',
        executionTimeMs: shortSell.executionTimeMs,
        updatedAtMs: shortSell.updatedAtMs,
        phase: 'TERMINAL',
      },
      false,
      [],
      () =>
        context.dailyLossTracker.recordCumulativeExecution({
          factStage: 'TERMINAL',
          direction: 'SHORT',
          symbol: shortSell.symbol,
          side: 'SELL',
          executedPrice: '9',
          executedQuantity: 5,
          executedTimeMs: shortSell.executionTimeMs!,
          orderUpdatedAtMs: shortSell.updatedAtMs,
          orderId: shortSell.orderId,
        }).admission,
    );
    expect(needs).toEqual(['execution']);
    oldRead.resolve([longBuy, shortBuy]);
    expect(await handling).toEqual({ status: 'processed' });
    expect(reads).toBe(2);
    expect(committed).toHaveBeenCalledTimes(1);
    expect(stages).toEqual(['Daily.prepare', 'O.commit', 'Daily.publish']);
    expect(context.dailyLossTracker.getLossOffset('SHORT')).toBe('-5');
    expect(recorder.getCostBasis('BULL.HK', true)).toEqual({ costAmount: '60', quantity: 5 });
    expect(recorder.getBuyOrdersForSymbol('BEAR.HK', false)).toEqual([]);
    expect(risk.getUnrealizedLossData('BULL.HK')).toEqual({ r1: '60', n1: 5 });
    expect(context.symbolRegistry.getSeatState('LONG').status).toBe('ACTIVE');
    expect(context.symbolRegistry.getSeatState('SHORT').status).toBe('ACTIVE');

    // API 已消费事实在同一 owner 在线重放不重复成本/数量/日损；正常事实准入仍执行。
    recorder.commitExecutionFact(
      {
        brokerOrderId: longBuy.orderId,
        symbol: longBuy.symbol,
        side: 'BUY',
        cumulativeQuantity: 5,
        cumulativeAmount: '60',
        executionTimeMs: longBuy.executionTimeMs,
        updatedAtMs: longBuy.updatedAtMs,
        phase: 'TERMINAL',
      },
      true,
      [],
      () =>
        context.dailyLossTracker.recordCumulativeExecution({
          factStage: 'TERMINAL',
          direction: 'LONG',
          symbol: longBuy.symbol,
          side: 'BUY',
          executedPrice: '12',
          executedQuantity: 5,
          executedTimeMs: longBuy.executionTimeMs!,
          orderUpdatedAtMs: longBuy.updatedAtMs,
          orderId: longBuy.orderId,
        }).admission,
    );
    expect(recorder.getCostBasis('BULL.HK', true)).toEqual({ costAmount: '60', quantity: 5 });
    expect(context.dailyLossTracker.getLossOffset('LONG')).toBe('0');
    expect(needs).toEqual(['execution']);
  });
});
