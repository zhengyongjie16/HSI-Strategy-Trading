/**
 * 席位激活的真实订单快照入站链路。
 * SDK DTO 留在 infra fixture，adapter 先整条择优再严格映射；recorder/Daily/risk 共享获选事实完成激活。
 */
import { describe, expect, it, spyOn } from 'bun:test';
import { createOrderRecorder } from '../../../src/application/orderTracking/recorder/index.js';
import { orderAnalysis } from '../../../src/domain/order/orderAnalysis.js';
import { createDailyLossTracker } from '../../../src/domain/risk/dailyLossTracker.js';
import { createUnrealizedLossChecker } from '../../../src/domain/risk/unrealizedLossChecker.js';
import { createSymbolRegistry } from '../../../src/domain/seat/symbolRegistry.js';
import { createTerminationRuntime } from '../../../src/runtime/lifecycle/terminationRuntime.js';
import { toHongKongTimeIso } from '../../../src/utils/time/index.js';
import { createSnapshotFixture } from '../../helpers/accountPositionSnapshot.js';
import { createMonitorContext } from '../../helpers/asyncProgram.js';
import {
  createAccountSnapshotDouble,
  createLoggerDouble,
  createMarketDataClientDouble,
  createMonitorConfigDouble,
  createQuoteSubscriptionRuntimeDouble,
  createRiskCheckerDouble,
} from '../../helpers/testDoubles.js';
import { createBrokerIngressFixture } from '../../infrastructure/longbridge/trade/brokerIngressFixture.js';
import { createSeatActivationFixture } from './fixtures.js';

/** 使用真实经济 owner 装配激活，仅账户与行情 IO 由离线端口提供。 */
async function createSnapshotActivationFixture() {
  const now = new Date('2026-03-13T03:00:00.000Z');
  const history = {
    orderId: 'ACTIVATION-SNAPSHOT-BUY',
    symbol: 'BULL.HK',
    stockName: 'HSI RC',
    remark: 'AUTO',
    side: 'BUY' as const,
    status: 'Canceled' as const,
    quantity: '10',
    executedQuantity: '10',
    submittedPrice: '12',
    executedPrice: '12',
    submittedAtMs: now.getTime() - 10_000,
    updatedAtMs: now.getTime() - 1_000,
  };
  const today = {
    ...history,
    status: 'Filled' as const,
    quantity: '5',
    executedQuantity: '5',
    submittedPrice: '10',
    executedPrice: '10',
    updatedAtMs: now.getTime() - 3_000,
  };
  const sell = {
    ...today,
    orderId: 'ACTIVATION-SNAPSHOT-SELL',
    side: 'SELL' as const,
    executedPrice: '9',
    updatedAtMs: now.getTime() - 2_000,
  };
  const native = await createBrokerIngressFixture(history);
  native.setOrderSnapshotReplies([history], [today, sell]);
  const recorder = createOrderRecorder({
    logger: createLoggerDouble(),
    orderSnapshotReadPort: native.ports.createOrderSnapshotReadPort({
      rateLimiter: { throttle: async () => {} },
    }),
    settlementRefreshNeedRecorder: { recordSettlementRefreshNeed: () => {} },
  });
  const daily = createDailyLossTracker({
    onOwnershipWarning: () => {},
    ...orderAnalysis,
    toHongKongTimeIso,
  });
  daily.resetAll(now);
  const risk = createUnrealizedLossChecker({
    maxUnrealizedLossPerSymbol: null,
    onMissingData: () => {},
  });
  const config = createMonitorConfigDouble();
  const symbolRegistry = createSymbolRegistry(config);
  symbolRegistry.updateSeatState('LONG', {
    ...symbolRegistry.getSeatState('LONG'),
    symbol: 'BULL.HK',
    status: 'ACTIVATING',
    callPrice: '20000',
  });
  const context = createMonitorContext({
    config,
    symbolRegistry,
    orderRecorder: recorder,
    dailyLossTracker: daily,
    riskChecker: createRiskCheckerDouble({
      prepareUnrealizedLossData: risk.prepare,
      publishUnrealizedLossData: risk.publish,
    }),
  });
  const snapshot = await createSnapshotFixture({
    account: createAccountSnapshotDouble('100000'),
    positions: [],
  });
  const closedGates: string[] = [];
  const termination = createTerminationRuntime({
    closeTradingGate: () => {
      closedGates.push('trading');
    },
    closeProducerAdmission: () => {
      closedGates.push('producer');
    },
    stopProducers: [],
    onSecondaryError: () => {},
  });
  const subscriptions = createQuoteSubscriptionRuntimeDouble();
  const workflow = createSeatActivationFixture({
    termination,
    clock: { now: () => now },
    monitorContext: context,
    snapshot,
    marketDataClient: createMarketDataClientDouble({ getQuotes: async () => new Map() }),
    quoteSubscriptionRuntime: subscriptions,
  });
  const request = {
    dayEpoch: snapshot.getView().token.dayEpoch,
    direction: 'LONG' as const,
    seatVersion: symbolRegistry.getSeatVersion('LONG'),
    previousSymbol: null,
    nextSymbol: 'BULL.HK',
    callPrice: '20000',
    symbolName: null,
  };
  return {
    native,
    recorder,
    daily,
    risk,
    context,
    snapshot,
    termination,
    closedGates,
    subscriptions,
    workflow,
    request,
    history,
    today,
  };
}

describe('SeatActivationWorkflow 真实快照择优入站', () => {
  for (const missing of ['EXECUTED_PRICE', 'REVISION'] as const) {
    it(`正成交终态 history 缺 ${missing} 由完整 today 覆盖，完成订单/Daily/risk 与 ACTIVE 发布`, async () => {
      const f = await createSnapshotActivationFixture();
      if (missing === 'EXECUTED_PRICE') f.native.setOrderSnapshotExecutedPriceMissing('history');
      else f.native.setOrderSnapshotUpdatedAtAbsent('history', 'OMITTED');

      const stages: string[] = [];
      const prepare = f.daily.prepareRecalculationFromAllOrders;
      spyOn(f.daily, 'prepareRecalculationFromAllOrders').mockImplementation((...args) => {
        stages.push('Daily.prepare');
        return prepare(...args);
      });
      const commit = f.recorder.commitRebuildSnapshot;
      spyOn(f.recorder, 'commitRebuildSnapshot').mockImplementation((...args) => {
        stages.push('O.commit');
        return commit(...args);
      });
      const publish = f.daily.publishRecalculation;
      spyOn(f.daily, 'publishRecalculation').mockImplementation((candidate) => {
        stages.push('Daily.publish');
        publish(candidate);
      });
      const reads = spyOn(f.recorder, 'fetchAllOrdersFromAPI');
      const release = spyOn(f.subscriptions, 'releaseRetain');
      expect(await f.workflow.activate(f.request, () => true)).toEqual({ status: 'processed' });

      expect(reads).toHaveBeenCalledTimes(1);
      expect(f.native.orderSnapshotReadCounts()).toEqual({ history: 1, today: 1 });
      expect(stages).toEqual(['Daily.prepare', 'O.commit', 'Daily.publish']);
      expect(f.recorder.getExecutionFact(f.history.orderId)).toMatchObject({
        cumulativeQuantity: 5,
        cumulativeAmount: '50',
        executionTimeMs: f.today.updatedAtMs,
        updatedAtMs: f.today.updatedAtMs,
        phase: 'TERMINAL',
      });

      expect(f.recorder.getExecutionFact('ACTIVATION-SNAPSHOT-SELL')).toMatchObject({
        cumulativeQuantity: 5,
        cumulativeAmount: '45',
        phase: 'TERMINAL',
      });
      expect(f.recorder.getCostBasis('BULL.HK', true)).toBeNull();
      expect(f.daily.getLossOffset('LONG')).toBe('-5');
      expect(f.risk.getUnrealizedLossData('BULL.HK')).toEqual({ r1: '5', n1: 0 });
      expect(f.context.symbolRegistry.getSeatState('LONG').status).toBe('ACTIVE');
      expect(release).toHaveBeenCalledTimes(1);
      expect(f.termination.getFatalState().hasFatalError).toBeFalse();
      expect(f.closedGates).toEqual([]);
      expect(f.native.nativeMutations()).toEqual([]);
      await f.snapshot.waitForIssuedDrain();
    });
  }

  for (const invalid of ['EXECUTED_PRICE', 'REVISION', 'UNKNOWN_TYPE'] as const) {
    it(`获选 today ${invalid} 不借完整 history 补齐，在本次订单/Daily/ACTIVE 发布前 fatal`, async () => {
      const f = await createSnapshotActivationFixture();
      if (invalid === 'EXECUTED_PRICE') f.native.setOrderSnapshotExecutedPriceMissing('today');
      else if (invalid === 'REVISION') f.native.setOrderSnapshotUpdatedAtAbsent('today', 'NULL');
      else f.native.setOrderSnapshotOrderTypeUnknown('today');

      const commit = spyOn(f.recorder, 'commitRebuildSnapshot');
      const prepare = spyOn(f.daily, 'prepareRecalculationFromAllOrders');
      const publish = spyOn(f.daily, 'publishRecalculation');
      const riskPublish = spyOn(f.context.riskChecker, 'publishUnrealizedLossData');
      const requests = spyOn(f.snapshot, 'requestRefresh');
      const release = spyOn(f.subscriptions, 'releaseRetain');
      const failure: unknown = await f.workflow
        .activate(f.request, () => true)
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(failure).toBeInstanceOf(TypeError);
      expect(f.native.orderSnapshotReadCounts()).toEqual({ history: 1, today: 1 });
      expect(commit).not.toHaveBeenCalled();
      expect(f.recorder.getExecutionFact(f.history.orderId)).toBeNull();
      expect(prepare).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
      expect(f.daily.getLossOffset('LONG')).toBe('0');
      expect(riskPublish).not.toHaveBeenCalled();
      expect(f.risk.getUnrealizedLossData('BULL.HK')).toBeUndefined();
      expect(requests).not.toHaveBeenCalled();
      expect(f.context.symbolRegistry.getSeatState('LONG').status).toBe('ACTIVATING');
      const fatal = f.termination.getFatalState();
      expect(fatal.hasFatalError).toBeTrue();
      if (fatal.hasFatalError) expect(fatal.error).toBe(failure);

      expect(f.closedGates).toEqual(['trading', 'producer']);
      expect(release).toHaveBeenCalledTimes(1);
      expect(f.native.nativeMutations()).toEqual([]);
      await f.snapshot.waitForIssuedDrain();
    });
  }
});
