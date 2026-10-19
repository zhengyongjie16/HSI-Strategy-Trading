import {
  createLoggerDouble,
  createAccountSnapshotDouble,
  createMarketDataClientDouble,
  createQuoteSubscriptionRuntimeDouble,
} from '../../helpers/testDoubles.js';

/**
 * SEAT_REFRESH 分阶段追赶：真实 snapshot、订单与日损 owner 共享一次合法基线。
 * 在持仓订阅 await 中插入成对提交/新成交，仅后置准备追赶；不运行 SDK 或自然 WS 链。
 */

import { describe, expect, it, spyOn } from 'bun:test';
import { createOrderRecorder } from '../../../src/application/orderTracking/recorder/index.js';
import { createUnrealizedLossChecker } from '../../../src/domain/risk/unrealizedLossChecker.js';
import type { SnapshotToken } from '../../../src/types/accountPosition.js';
import type { BrokerOrderExecutionFact } from '../../../src/types/orderRecorder.js';
import type { OrderFact } from '../../../src/types/trade.js';

import { createMonitorContext } from '../../helpers/asyncProgram.js';
import { createSnapshotFixture } from '../../helpers/accountPositionSnapshot.js';
import { createSeatActivationFixture } from './fixtures.js';

async function createCatchUpFixture() {
  const now = new Date('2026-03-13T03:00:00.000Z');
  const executionTimeMs = now.getTime() - 60_000;
  const initialContext = createMonitorContext();
  initialContext.symbolRegistry.updateSeatState('LONG', {
    ...initialContext.symbolRegistry.getSeatState('LONG'),
    symbol: 'BULL.HK',
    status: 'ACTIVATING',
    callPrice: '20000',
  });
  const snapshot = await createSnapshotFixture({
    account: createAccountSnapshotDouble('100000'),
    positions: [],
  });
  const baseline: OrderFact = {
    orderId: 'BASELINE-BUY',
    symbol: 'BULL.HK',
    stockName: `${initialContext.config.orderOwnershipMapping[0]} RC`,
    executionSide: 'BUY',
    executionStatus: 'FILLED',
    executionPhase: 'TERMINAL',
    status: 'FILLED',
    orderType: 'ELO',
    quantity: 5,
    price: null,
    executedQuantity: 5,
    executedPrice: '10',
    executedAmount: '50',
    executionTimeMs,
    updatedAtMs: executionTimeMs,
    submittedAt: new Date(executionTimeMs - 1000),
    updatedAt: new Date(executionTimeMs),
  };
  const brokerCalls: string[] = [];
  const refreshNeeds: string[] = [];
  const recorder = createOrderRecorder({
    logger: createLoggerDouble(),
    orderSnapshotReadPort: {
      fetchSnapshots: async () => {
        brokerCalls.push('unauthorized');
        throw new Error('此测试不授权 broker IO');
      },
    },
    getExecutionTimeEvidence: initialContext.dailyLossTracker.getExecutionTimeEvidence,
    settlementRefreshNeedRecorder: {
      recordSettlementRefreshNeed: () => {
        refreshNeeds.push('execution');
        snapshot.invalidate();
      },
    },
  });
  const context = { ...initialContext, orderRecorder: recorder };
  context.dailyLossTracker.resetAll(now);
  const risk = createUnrealizedLossChecker({
    maxUnrealizedLossPerSymbol: null,
    onMissingData: () => {},
  });
  const preparedTokens: SnapshotToken[] = [];
  const publishedTokens: SnapshotToken[] = [];
  const activatedTokens: SnapshotToken[] = [];
  spyOn(context.riskChecker, 'prepareUnrealizedLossData').mockImplementation((...args) => {
    preparedTokens.push(snapshot.getView().token);
    return risk.prepare(...args);
  });
  const updateSeatState = context.symbolRegistry.updateSeatState;
  spyOn(context.symbolRegistry, 'updateSeatState').mockImplementation((direction, seat) => {
    if (seat.status === 'ACTIVE') activatedTokens.push(snapshot.getView().token);

    updateSeatState(direction, seat);
  });

  spyOn(context.riskChecker, 'publishUnrealizedLossData').mockImplementation((candidate) => {
    publishedTokens.push(snapshot.getView().token);
    risk.publish(candidate);
  });
  const commit = spyOn(recorder, 'commitRebuildSnapshot');
  const dailyPublish = spyOn(context.dailyLossTracker, 'publishRecalculation');
  spyOn(recorder, 'fetchAllOrdersFromAPI').mockImplementation(async () => [baseline]);
  const orderReads = spyOn(recorder, 'fetchAllOrdersFromAPI');
  const requests = spyOn(snapshot, 'requestRefresh');
  const subscriptionStarted = Promise.withResolvers<null>();
  const subscription = Promise.withResolvers<null>();
  const releaseStarted = Promise.withResolvers<null>();
  const release = Promise.withResolvers<null>();
  const reconciledTokens: SnapshotToken[] = [];
  const owners: string[] = [];
  const workflow = createSeatActivationFixture({
    clock: { now: () => now },
    monitorContext: context,
    snapshot,
    marketDataClient: createMarketDataClientDouble({ getQuotes: async () => new Map() }),
    quoteSubscriptionRuntime: createQuoteSubscriptionRuntimeDouble({
      retainSymbols: async ({ ownerKey }) => {
        owners.push(`retain:${ownerKey}`);
      },
      reconcilePositionHoldFromCurrentTruth: async (token) => {
        expect(snapshot.isCurrent(token, { account: true, positions: true, paired: true })).toBe(
          true,
        );
        reconciledTokens.push(token);
        if (reconciledTokens.length === 1) {
          subscriptionStarted.resolve(null);
          await subscription.promise;
        }
      },
      releaseRetain: async ({ ownerKey }) => {
        owners.push(`release:${ownerKey}`);
        releaseStarted.resolve(null);
        await release.promise;
      },
    }),
  });
  const handling = workflow.activate(
    {
      dayEpoch: snapshot.getView().token.dayEpoch,
      direction: 'LONG',
      seatVersion: 2,
      previousSymbol: 'OLD_BULL.HK',
      nextSymbol: 'BULL.HK',
      callPrice: '20000',
      symbolName: 'BULL.HK',
    },
    () => true,
  );
  await subscriptionStarted.promise;
  expect(commit).toHaveBeenCalledTimes(1);
  expect(dailyPublish).toHaveBeenCalledTimes(1);
  expect(recorder.getCostBasis('BULL.HK', true)).toEqual({ costAmount: '50', quantity: 5 });
  expect(risk.getUnrealizedLossData('BULL.HK')).toBeUndefined();
  expect(context.symbolRegistry.getSeatState('LONG').status).toBe('ACTIVATING');
  return {
    context,
    snapshot,
    recorder,
    risk,
    baseline,
    orderReads,
    commit,
    dailyPublish,
    requests,
    subscription,
    releaseStarted,
    release,
    handling,
    reconciledTokens,
    preparedTokens,
    publishedTokens,
    activatedTokens,
    owners,
    brokerCalls,
    refreshNeeds,
  };
}

async function publishPairedSnapshot(
  snapshot: Awaited<ReturnType<typeof createCatchUpFixture>>['snapshot'],
) {
  const handle = snapshot.requestRefresh({
    source: 'TEST_INTERLEAVED_PAIRED',
    dayEpoch: snapshot.getView().token.dayEpoch,
    refreshAccount: true,
    refreshPositions: true,
  });
  const receipt = await handle.result.finally(handle.cancel);
  expect(receipt.status).toBe('COMMITTED');
}

async function finishAndAssert(
  fixture: Awaited<ReturnType<typeof createCatchUpFixture>>,
  expectedRisk: { readonly r1: string; readonly n1: number },
  expectedRequests: number,
) {
  fixture.subscription.resolve(null);
  await fixture.releaseStarted.promise;
  const currentToken = fixture.snapshot.getView().token;
  expect(fixture.orderReads).toHaveBeenCalledTimes(1);
  expect(fixture.commit).toHaveBeenCalledTimes(1);
  expect(fixture.dailyPublish).toHaveBeenCalledTimes(1);
  expect(
    fixture.requests.mock.calls.filter(([request]) => request.source === 'SEAT_ACTIVATION'),
  ).toHaveLength(expectedRequests);
  expect(fixture.reconciledTokens).toHaveLength(2);
  expect(fixture.reconciledTokens[0]).not.toEqual(currentToken);
  expect(fixture.reconciledTokens[1]).toEqual(currentToken);
  expect(fixture.preparedTokens).toEqual([currentToken]);
  expect(fixture.publishedTokens).toEqual([currentToken]);
  expect(fixture.activatedTokens).toEqual([currentToken]);
  expect(fixture.risk.getUnrealizedLossData('BULL.HK')).toEqual(expectedRisk);
  expect(fixture.context.symbolRegistry.getSeatState('LONG').status).toBe('ACTIVE');
  expect(fixture.context.symbolRegistry.getSeatVersion('LONG')).toBe(2);
  expect(fixture.context.symbolRegistry.getSeatState('SHORT').status).toBe('ACTIVE');
  expect(fixture.context.dailyLossTracker.getLossOffset('LONG')).toBe('0');
  expect(fixture.brokerCalls).toEqual([]);
  expect(fixture.owners).toEqual([
    'retain:SEAT_REFRESH_WAIT:LONG:2',
    'release:SEAT_REFRESH_WAIT:LONG:2',
  ]);
  let settled = false;
  void fixture.handling.then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  fixture.release.resolve(null);
  expect(await fixture.handling).toEqual({ status: 'processed' });
}

describe('SEAT_REFRESH 已提交后的分阶段追赶', () => {
  it('订单提交→订阅 await→另一 paired commit：不重读订单、不重复日损，只用当前 view 发布风险与 ACTIVE', async () => {
    const fixture = await createCatchUpFixture();
    const oldToken = fixture.snapshot.getView().token;
    await publishPairedSnapshot(fixture.snapshot);
    expect(fixture.snapshot.getView().token.snapshotGeneration).toBe(oldToken.snapshotGeneration);
    expect(fixture.snapshot.getView().token.commitRevision).toBe(oldToken.commitRevision + 1);
    expect(fixture.publishedTokens).toEqual([]);
    await finishAndAssert(fixture, { r1: '50', n1: 5 }, 1);
    expect(fixture.refreshNeeds).toEqual([]);
  });

  for (const pairedAlreadyAvailable of [true, false]) {
    it(`订阅期间新成交保留当前经济投影，不重建旧基线；当前成对字段已补齐=${pairedAlreadyAvailable}`, async () => {
      const fixture = await createCatchUpFixture();
      const oldToken = fixture.snapshot.getView().token;
      const executedTimeMs = fixture.baseline.executionTimeMs! + 1000;
      const fact: BrokerOrderExecutionFact = {
        brokerOrderId: 'NEW-BUY',
        symbol: 'BULL.HK',
        side: 'BUY',
        cumulativeQuantity: 5,
        cumulativeAmount: '60',
        executionTimeMs: executedTimeMs,
        updatedAtMs: executedTimeMs,
        phase: 'TERMINAL',
      };
      fixture.recorder.commitExecutionFact(
        fact,
        true,
        [],
        () =>
          fixture.context.dailyLossTracker.recordCumulativeExecution({
            factStage: 'TERMINAL',
            direction: 'LONG',
            symbol: 'BULL.HK',
            side: 'BUY',
            executedPrice: '12',
            executedQuantity: 5,
            executedTimeMs,
            orderUpdatedAtMs: executedTimeMs,
            orderId: 'NEW-BUY',
          }).admission,
      );

      expect(fixture.snapshot.getView().token.snapshotGeneration).toBe(
        oldToken.snapshotGeneration + 1,
      );

      expect(
        fixture.snapshot.isCurrent(oldToken, { account: true, positions: true, paired: true }),
      ).toBe(false);

      expect(fixture.recorder.getCostBasis('BULL.HK', true)).toEqual({
        costAmount: '110',
        quantity: 10,
      });

      if (pairedAlreadyAvailable) await publishPairedSnapshot(fixture.snapshot);

      expect(fixture.publishedTokens).toEqual([]);
      await finishAndAssert(fixture, { r1: '110', n1: 10 }, pairedAlreadyAvailable ? 1 : 2);
      expect(fixture.refreshNeeds).toEqual(['execution']);
      expect(fixture.recorder.getExecutionFact('NEW-BUY')).toEqual(fact);
      expect(fixture.context.dailyLossTracker.getExecutionTimeEvidence()).toHaveLength(2);
      expect(fixture.recorder.getCostBasis('BULL.HK', true)).toEqual({
        costAmount: '110',
        quantity: 10,
      });
    });
  }
});
