import { createDiagnosticObserverDouble } from '../helpers/diagnostics.js';
import { scheduleBoundedOneShotAt } from '../../src/runtime/timer/index.js';
import { wrapExternalApiRequest } from '../../src/infrastructure/externalApi/index.js';
import { wait } from '../../src/infrastructure/time/index.js';
import {
  createLoggerDouble,
  createMarketDataClientDouble,
  createRateLimiterDouble,
  createSymbolRegistryDouble,
} from '../helpers/testDoubles.js';

/** 保护性清仓：真实 native push/ledger 经同 O/Daily/S owner 收口，原一次性进度与终态经济断言不变。 */

import { describe, expect, it } from 'bun:test';
import { createTradingConfig } from '../../mock/factories/configFactory.js';
import type { DailyLossCumulativeExecutionInput } from '../../src/types/risk.js';
import { createExecutionFixture } from '../application/orderTracking/recorder/executionFixture.js';

import { waitUntil } from '../helpers/asyncProgram.js';
import { createBrokerIngressFixture } from './architectureRefactoringP1Native/trade/brokerIngressFixture.js';

const EXECUTION_MS = Date.parse('2026-03-13T02:00:01.000Z');

describe('protective-liquidation integration', () => {
  it('records protective episode progress + local sell update after protective liquidation fill event', async () => {
    let commitSellCount = 0;
    let markSellFilledCount = 0;
    const terminalExecutionFacts: Array<
      Pick<
        DailyLossCumulativeExecutionInput,
        | 'direction'
        | 'executedPrice'
        | 'executedQuantity'
        | 'factStage'
        | 'orderId'
        | 'side'
        | 'symbol'
      >
    > = [];
    const episodeProgressPayloads: Array<{
      direction: 'LONG' | 'SHORT';
      symbol: string;
      executedTimeMs: number;
    }> = [];
    const refreshNeeds: Array<{
      readonly refreshAccount: boolean;
      readonly refreshPositions: boolean;
    }> = [];
    const native = await createBrokerIngressFixture({
      orderId: 'PL-001',
      tradeId: 'PL-001-trade',
      symbol: 'BULL.HK',
      stockName: 'HSI RC',
      remark: '',
      side: 'SELL',
      status: 'New',
      orderType: 'MO',
      quantity: '200',
      executedQuantity: '0',
      submittedPrice: '1',
      executedPrice: '0',
      submittedAtMs: EXECUTION_MS - 1000,
      executionTimeMs: null,
      updatedAtMs: EXECUTION_MS - 1000,
    });
    native.setAccountBalance({
      currency: 'HKD',
      totalCash: '0',
      netAssets: '0',
      availableCash: '0',
    });
    native.setStockPositions([]);
    const f = createExecutionFixture({
      nowMs: EXECUTION_MS,
      readPort: native.createAccountService({ rateLimiter: createRateLimiterDouble() }),
      createRecorder: native.createRecorder,
      observeRefresh: (need) => {
        refreshNeeds.push(need);
      },
      observeDaily: (daily) => {
        const record = daily.recordCumulativeExecution;
        return {
          ...daily,
          recordCumulativeExecution: (input, beforeCommit) => {
            terminalExecutionFacts.push({
              factStage: input.factStage,
              orderId: input.orderId,
              direction: input.direction,
              symbol: input.symbol,
              side: input.side,
              executedPrice: input.executedPrice,
              executedQuantity: input.executedQuantity,
            });
            return record(input, beforeCommit);
          },
        };
      },
      observeRecorder: (recorder) => {
        const commit = recorder.commitExecutionFact;
        const mark = recorder.markSellFilled;
        return {
          ...recorder,
          commitExecutionFact: (...args) => {
            const receipt = commit(...args);
            if (args[0].side === 'SELL' && receipt.authoritativeFactChanged) commitSellCount++;

            return receipt;
          },
          markSellFilled: (...args) => {
            markSellFilledCount++;
            return mark(...args);
          },
        };
      },
    });
    const recordProgress = f.episode.recordProtectiveFillProgress;
    f.episode.recordProtectiveFillProgress = (params) => {
      recordProgress(params);
      episodeProgressPayloads.push(params);
    };
    const paired = await f.snapshot.requestRefresh({
      source: 'PROTECTIVE_MONITOR_H',
      dayEpoch: 1,
      refreshAccount: true,
      refreshPositions: true,
    }).result;
    if (paired.status !== 'COMMITTED') throw new Error('Protective paired H refresh aborted');

    const monitor = native.createMonitor({
      diagnostics: createDiagnosticObserverDouble(),
      logger: createLoggerDouble(),
      wait: wait,
      requestExternalApi: wrapExternalApiRequest,
      scheduleBoundedOneShotAt: scheduleBoundedOneShotAt,
      now: () => new Date(EXECUTION_MS),
      scheduleTimer: setTimeout,
      clearTimer: clearTimeout,
      rateLimiter: createRateLimiterDouble(),
      cacheManager: { clearCache: () => {}, getPendingOrders: async () => [] },
      marketDataClient: createMarketDataClientDouble(),
      orderRecorder: f.recorder,
      dailyLossTracker: f.daily,
      orderHoldRegistry: f.holds,
      persistProtectiveLiquidationExecutionProgress: () => {},
      protectiveLiquidationEpisodeTracker: f.episode,
      postTradeConsistencyRuntime: f.sink,
      tradingConfig: createTradingConfig(),
      symbolRegistry: createSymbolRegistryDouble(),
      isContinuousTradingAllowed: () => false,
      termination: f.termination,
    });
    try {
      await monitor.initialize();
      await monitor.recoverOrderTrackingFromSnapshot([]);
      expect(native.subscriptionMembership()).toEqual(['PRIVATE']);
      f.recorder.submitSellOrder('PL-001', 'BULL.HK', 'LONG', 200, [], true, EXECUTION_MS - 1000);
      monitor.trackOrder({
        orderId: 'PL-001',
        symbol: 'BULL.HK',
        side: 'SELL',
        executionSide: 'SELL',
        initialExecutionPhase: 'OPEN',
        price: '1',
        initialSubmittedPrice: '1',
        quantity: 200,
        isLongSymbol: true,
        monitorSymbol: 'HSI.HK',
        isProtectiveLiquidation: true,
        orderType: 'MO',
      });

      native.setExecutionReplies([
        {
          orderId: 'PL-001',
          tradeId: 'PL-001-trade',
          symbol: 'BULL.HK',
          quantity: '200',
          price: '1',
          tradeDoneAtMs: EXECUTION_MS,
        },
      ]);

      native.emitOrderChangedFrame({
        orderId: 'PL-001',
        tradeId: 'PL-001-trade',
        symbol: 'BULL.HK',
        stockName: 'HSI RC',
        remark: '',
        side: 'SELL',
        status: 'Filled',
        orderType: 'MO',
        quantity: '200',
        executedQuantity: '200',
        submittedPrice: '1',
        executedPrice: '1',
        submittedAtMs: EXECUTION_MS - 1000,
        executionTimeMs: EXECUTION_MS,
        updatedAtMs: EXECUTION_MS + 30_000,
      });
      await waitUntil(() => f.recorder.getExecutionFact('PL-001')?.phase === 'TERMINAL');
      expect(commitSellCount).toBe(1);
      expect(markSellFilledCount).toBe(1);
      expect(terminalExecutionFacts).toEqual([
        {
          factStage: 'TERMINAL',
          orderId: 'PL-001',
          direction: 'LONG',
          symbol: 'BULL.HK',
          side: 'SELL',
          executedPrice: '1',
          executedQuantity: 200,
        },
      ]);

      expect(episodeProgressPayloads).toEqual([
        { direction: 'LONG', symbol: 'BULL.HK', executedTimeMs: EXECUTION_MS },
      ]);
      expect(refreshNeeds).toEqual([{ refreshAccount: true, refreshPositions: true }]);
      expect(f.recorder.getExecutionFact('PL-001')).toMatchObject({
        cumulativeQuantity: 200,
        cumulativeAmount: '200',
        executionTimeMs: EXECUTION_MS,
        updatedAtMs: EXECUTION_MS + 30_000,
        phase: 'TERMINAL',
      });

      expect(
        f.snapshot.isCurrent(paired.snapshotToken, {
          account: true,
          positions: true,
          paired: true,
        }),
      ).toBeFalse();
      expect(f.sink.getStatus().staleVersion).toBe(1);
      expect(f.recorder.getPendingSellSnapshot()).toEqual([]);
      expect(f.recorder.getSellRecordByOrderId('PL-001')).toMatchObject({
        orderId: 'PL-001',
        costAmount: '200',
        executedQuantity: 200,
        executedTime: EXECUTION_MS,
      });
    } finally {
      await monitor.stopRuntimeAndDrain();
    }
  });
});
