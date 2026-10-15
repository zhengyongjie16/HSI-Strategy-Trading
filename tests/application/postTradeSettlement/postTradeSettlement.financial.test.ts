/** 精确 settlement 金融链测试：同实例订单成本/日损益、高 revision 同量修正、completion baseline 与 R1/N1。 */

import { expect, test } from 'bun:test';
import { createAccountPositionSnapshot } from '../../../src/application/accountPositionSnapshot/index.js';
import { createOrderRecorder } from '../../../src/application/orderTracking/recorder/index.js';
import { createPostTradeSettlementWorkflow } from '../../../src/application/postTradeSettlement/index.js';
import type { SettlementProtectionCompletion } from '../../../src/application/postTradeSettlement/types.js';
import { API } from '../../../src/constants/index.js';
import { createProtectiveLiquidationEpisodeTracker } from '../../../src/domain/liquidation/episode/index.js';
import { orderAnalysis } from '../../../src/domain/order/orderAnalysis.js';
import { createDailyLossTracker } from '../../../src/domain/risk/dailyLossTracker.js';
import { createUnrealizedLossChecker } from '../../../src/domain/risk/unrealizedLossChecker.js';
import { isExternalApiRequestError } from '../../../src/utils/apiFailure/index.js';
import { exactMultiply } from '../../../src/utils/numeric/exact.js';
import { toHongKongTimeIso } from '../../../src/utils/time/index.js';
import {
  createAccountSnapshotDouble,
  createLoggerDouble,
  createTerminationDouble,
} from '../../helpers/testDoubles.js';

test('high-revision same-quantity authoritative corrections preserve exact cost/loss and completion uses that same baseline before risk ready', async () => {
  const now = Date.parse('2026-07-11T03:00:00.000Z');
  const boundaryTime = now + 200;
  const snapshot = createAccountPositionSnapshot({
    dayEpoch: 1,
    scheduler: { schedule: queueMicrotask },
    reportFatalError: () => {},
    readPort: {
      getAccountSnapshot: async () => createAccountSnapshotDouble('10000.0000000000000001'),
      getStockPositions: async () => [],
    },
  });
  let run!: () => void;
  let pendingProtective = true;
  const workflow = createPostTradeSettlementWorkflow({
    snapshot,
    termination: createTerminationDouble(),
    logger: createLoggerDouble(),
    hasPendingProtectiveOrders: () => pendingProtective,
    onPositionsCommitted: async () => {},
    retryDelayMs: API.DEFAULT_RETRY_DELAY_MS,
    isExternalFailure: isExternalApiRequestError,
    scheduler: {
      scheduleTimer: (callback) => {
        run = callback;
        const handle = setTimeout(() => {}, 2_147_483_647);
        clearTimeout(handle);
        return handle;
      },
      clearTimer: () => {},
    },
  });
  const daily = createDailyLossTracker({
    onOwnershipWarning: () => {},
    ...orderAnalysis,
    toHongKongTimeIso,
  });
  daily.resetAll(new Date(now));
  const recorder = createOrderRecorder({
    orderSnapshotReadPort: {
      fetchSnapshots: async () => {
        throw new Error('financial test does not issue order IO');
      },
    },
    getExecutionTimeEvidence: daily.getExecutionTimeEvidence,
    settlementRefreshNeedRecorder: workflow,
  });
  const episodes = createProtectiveLiquidationEpisodeTracker();
  const risk = createUnrealizedLossChecker({
    maxUnrealizedLossPerSymbol: '1000',
    onMissingData: () => {},
  });
  const completions: SettlementProtectionCompletion[] = [];
  const cooldowns: number[] = [];
  workflow.bindBusinessDeps({
    monitorSymbol: 'HSI.HK',
    seats: {
      getSeatState: (direction) =>
        direction === 'LONG'
          ? { status: 'ACTIVE', symbol: 'BULL.HK' }
          : { status: 'EMPTY', symbol: null },
      getSeatVersion: () => 1,
    },
    episodes,
    lossBoundaries: daily,
    completionPersistence: {
      appendCompletionIdempotent: (completion) => {
        completions.push(completion);
      },
    },
    cooldownTriggers: {
      recordLiquidationTrigger: ({ executedTimeMs }) => {
        cooldowns.push(executedTimeMs);
      },
    },
    riskProjection: {
      prepare: (symbol, direction, lossOffset) =>
        risk.prepare(recorder, symbol, direction === 'LONG', lossOffset),
      publish: risk.publish,
    },
  });

  // 测试只组装已校验中性累计事实；financial owner 与 workflow 为全程同一实例。
  function commit(
    orderId: string,
    side: 'BUY' | 'SELL',
    price: string,
    phase: 'OPEN' | 'TERMINAL',
    time: number,
    revision: number,
  ) {
    const amount = exactMultiply(price, '1000');
    let advanced = false;
    recorder.commitExecutionFact(
      {
        brokerOrderId: orderId,
        symbol: 'BULL.HK',
        side,
        cumulativeQuantity: 1000,
        cumulativeAmount: amount,
        executionTimeMs: time,
        updatedAtMs: revision,
        phase,
      },
      true,
      [],
      () => {
        const result = daily.recordCumulativeExecution({
          orderId,
          symbol: 'BULL.HK',
          direction: 'LONG',
          side,
          executedQuantity: 1000,
          executedPrice: price,
          factStage: phase,
          executedTimeMs: time,
          orderUpdatedAtMs: revision,
        });
        advanced = result.executionAdvanced;
        if (side === 'SELL' && result.executionAdvanced)
          episodes.recordProtectiveFillProgress({
            direction: 'LONG',
            symbol: 'BULL.HK',
            executedTimeMs: time,
          });

        return result.admission;
      },
    );
    return advanced;
  }

  async function refresh() {
    const waiting = workflow.waitForFresh();
    run();
    return waiting;
  }

  expect(commit('buy-1', 'BUY', '0.1000000000000000001', 'TERMINAL', now, now + 1)).toBe(true);
  workflow.start();
  const originalReady = await refresh();
  expect(risk.getUnrealizedLossData('BULL.HK')).toEqual({ r1: '100.0000000000000001', n1: 1000 });
  expect(commit('buy-1', 'BUY', '0.1000000000000000002', 'TERMINAL', now, now + 2)).toBe(false);
  expect(workflow.isCurrent(originalReady)).toBe(false);
  await refresh();
  expect(recorder.getCostBasis('BULL.HK', true)).toEqual({
    costAmount: '100.0000000000000002',
    quantity: 1000,
  });
  expect(risk.getUnrealizedLossData('BULL.HK')).toEqual({ r1: '100.0000000000000002', n1: 1000 });

  expect(commit('protective-sell', 'SELL', '0.09', 'OPEN', boundaryTime, boundaryTime + 1)).toBe(
    true,
  );
  await refresh();
  expect(daily.getLossOffset('LONG')).toBe('-10.0000000000000002');
  expect(risk.getUnrealizedLossData('BULL.HK')).toEqual({ r1: '110.0000000000000004', n1: 1000 });
  expect(completions).toEqual([]);
  expect(
    commit(
      'protective-sell',
      'SELL',
      '0.0900000000000000001',
      'OPEN',
      boundaryTime,
      boundaryTime + 2,
    ),
  ).toBe(false);
  await refresh();
  expect(daily.getLossOffset('LONG')).toBe('-10.0000000000000001');
  expect(risk.getUnrealizedLossData('BULL.HK')).toEqual({ r1: '110.0000000000000003', n1: 1000 });
  expect(episodes.getInProgressEpisodes()[0]?.latestExecutedTimeMs).toBe(boundaryTime);

  pendingProtective = false;
  expect(
    commit(
      'protective-sell',
      'SELL',
      '0.0900000000000000001',
      'TERMINAL',
      boundaryTime,
      boundaryTime + 3,
    ),
  ).toBe(false);
  const completedReady = await refresh();
  expect(workflow.isCurrent(completedReady)).toBe(true);
  expect(completions).toHaveLength(1);
  const baseline = completions[0]?.orderBaselines;
  expect(baseline?.find((entry) => entry.orderId === 'buy-1')?.cumulativeAmount).toBe(
    '100.0000000000000002',
  );

  expect(baseline?.find((entry) => entry.orderId === 'protective-sell')?.cumulativeAmount).toBe(
    '90.0000000000000001',
  );
  expect(completions[0]?.boundaryExecutedTimeMs).toBe(boundaryTime);
  expect(daily.getLossOffset('LONG')).toBe('0');
  expect(risk.getUnrealizedLossData('BULL.HK')).toEqual({ r1: '0', n1: 0 });
  expect(cooldowns).toEqual([boundaryTime]);

  commit(
    'buy-2',
    'BUY',
    '0.1000000000000000003',
    'TERMINAL',
    boundaryTime + 100,
    boundaryTime + 101,
  );
  await refresh();
  expect(daily.getLossOffset('LONG')).toBe('0');
  expect(risk.getUnrealizedLossData('BULL.HK')).toEqual({ r1: '100.0000000000000003', n1: 1000 });
  expect(completions).toHaveLength(1);
  expect(cooldowns).toEqual([boundaryTime]);
  await workflow.stopAndDrain();
});
