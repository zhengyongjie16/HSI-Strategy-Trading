import { createLoggerDouble } from '../../helpers/testDoubles.js';

/**
 * 已封存 execution T 的修订必须沿真实共享 settlementFlow → O beforeCommit → Daily 准入 → S sink 被抑制。
 * 保留原 V1 字节与 9.2/T/revision+1 输入；真实 recorder、Daily、repository、snapshot、S 和 hold 各自验真。
 * 这是共享结算规则线，不启动 WS ingress/settlement 消费，不以手动 release 或假 readiness 代替自然接线。
 */

import { expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPostTradeConsistencyRuntime } from '../../../src/app/runtime/createPostTradeConsistencyRuntime.js';
import { createTerminationRuntime } from '../../../src/runtime/lifecycle/terminationRuntime.js';
import { createAccountPositionSnapshot } from '../../../src/application/accountPositionSnapshot/index.js';
import { createOrderHoldRegistry } from '../../../src/application/orderTracking/orderHoldRegistry.js';
import { createSettlementFlow } from '../../../src/application/orderTracking/orderMonitor/settlementFlow.js';
import type {
  FinalizeOrderSettlementParams,
  OrderCumulativeExecutionParams,
  OrderMonitorRuntimeStore,
} from '../../../src/application/orderTracking/orderMonitor/types.js';
import { createOrderRecorder } from '../../../src/application/orderTracking/recorder/index.js';
import { createProtectiveLiquidationEpisodeTracker } from '../../../src/domain/liquidation/episode/index.js';
import { orderAnalysis } from '../../../src/domain/order/orderAnalysis.js';
import { createDailyLossTracker } from '../../../src/domain/risk/dailyLossTracker.js';
import { createMixedTradeLogRepository } from '../../../src/infrastructure/persistence/mixedTradeLogRepository/index.js';
import type { OrderStateChangedEvent } from '../../../src/types/orderTracking.js';
import { toHongKongTimeIso } from '../../../src/utils/time/index.js';
import { buildTradeLogPath } from '../../../src/infrastructure/persistence/mixedTradeLogRepository/tradeLogPath.js';
import { createOfflineBrokerPort } from './offlinePorts.js';

it('suppresses original 9.2/T/revision+1 through shared settlementFlow and real O/Daily/S while terminal resources close independently', () => {
  const dayKey = '2026-03-13';
  const executionT = 1773369000000;
  const revision = executionT + 30_000;
  const buyT = Date.parse('2026-03-13T02:00:00.000Z');
  const originalProgress = fs.readFileSync(
    new URL('../architectureRefactoringRecovery/fixtures/progress.jsonl', import.meta.url),
  );
  const originalCompletion = fs.readFileSync(
    new URL('../architectureRefactoringRecovery/fixtures/completion.jsonl', import.meta.url),
  );
  const originalBytes = Buffer.concat([originalProgress, originalCompletion]);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hsi-p1-shared-settlement-'));
  const logFile = buildTradeLogPath(root, new Date(executionT));
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.writeFileSync(logFile, originalBytes);
    const repository = createMixedTradeLogRepository({ resolveLogRootDir: () => root });
    const io = createOfflineBrokerPort();
    const lifecycleClosures: string[] = [];
    const termination = createTerminationRuntime({
      closeTradingGate: () => {
        lifecycleClosures.push('trading');
      },
      closeProducerAdmission: () => {
        lifecycleClosures.push('producer');
      },
      stopProducers: [],
      onSecondaryError: (error) => {
        throw error;
      },
    });
    const snapshot = createAccountPositionSnapshot({
      dayEpoch: 1,
      scheduler: { schedule: queueMicrotask },
      readPort: {
        getAccountSnapshot: async () => {
          throw new Error('shared-rule registration case must not read account');
        },
        getStockPositions: async () => {
          throw new Error('shared-rule registration case must not read positions');
        },
      },
      reportFatalError: termination.reportFatalError,
    });
    const sink = createPostTradeConsistencyRuntime({
      logger: createLoggerDouble(),
      snapshot,
      termination,
      getProtectiveOrderReader: () => {
        throw new Error('shared-rule case must not substitute a business refresh consumer');
      },
      onPositionsCommitted: async () => {
        throw new Error('shared-rule case must not claim subscription/readiness commit');
      },
      scheduler: { scheduleTimer: setTimeout, clearTimer: clearTimeout },
    });
    const daily = createDailyLossTracker({
      onOwnershipWarning: () => {},
      ...orderAnalysis,
      toHongKongTimeIso,
    });
    daily.resetAll(new Date(executionT));
    const owner = createOrderRecorder({
      logger: createLoggerDouble(),
      orderSnapshotReadPort: io.broker,
      getExecutionTimeEvidence: daily.getExecutionTimeEvidence,
      settlementRefreshNeedRecorder: sink,
    });
    const holds = createOrderHoldRegistry();
    const episode = createProtectiveLiquidationEpisodeTracker();
    const runtime: OrderMonitorRuntimeStore = {
      trackedOrders: new Map(),
      trackedOrderLifecycles: new Map(),
      bootstrappingOrderEvents: new Map(),
      closedOrderIds: new Set(),
      queriedTerminalStateByOrderId: new Map(),
      latestReplaceTerminalByOrderId: new Map(),
      orderStateChangedListeners: new Set(),
      trackedOrderIdsBySymbol: new Map(),
      routeStatesBySymbol: new Map(),
      latestRouteGenerationBySymbol: new Map(),
      runtimeState: 'STOPPED',
      running: false,
      unsubscribeQuoteUpdated: null,
    };
    const events: OrderStateChangedEvent[] = [];
    const flow = createSettlementFlow({
      runtime,
      orderRecorder: owner,
      dailyLossTracker: daily,
      orderHoldRegistry: holds,
      protectiveLiquidationEpisodeTracker: episode,
      persistProtectiveLiquidationExecutionProgress: repository.appendExecutionProgressIdempotent,
      postTradeConsistencyRuntime: sink,
      emitOrderStateChanged: (event) => {
        events.push(event);
      },
    });
    const buy: OrderCumulativeExecutionParams = {
      factStage: 'TERMINAL',
      orderId: 'OFFLINE-BUY',
      side: 'BUY',
      monitorSymbol: 'HSI.HK',
      symbol: 'BULL.HK',
      isLongSymbol: true,
      isProtectiveLiquidation: false,
      executedQuantity: 5,
      executedPrice: '10',
      executedAmount: '50',
      executedTimeMs: buyT,
      orderUpdatedAtMs: buyT,
    };
    expect(flow.recordCumulativeExecution(buy).admission).toBe('ADMITTED');
    expect(owner.getCostBasis('BULL.HK', true)).toEqual({ costAmount: '50', quantity: 5 });
    owner.submitSellOrder('OFFLINE-SELL', 'BULL.HK', 'LONG', 5, [], true, buyT);
    holds.trackOrder('OFFLINE-SELL', 'BULL.HK');
    const open: OrderCumulativeExecutionParams = {
      ...buy,
      factStage: 'OPEN',
      orderId: 'OFFLINE-SELL',
      side: 'SELL',
      isProtectiveLiquidation: true,
      executedPrice: '8.8',
      executedAmount: '44',
      executedTimeMs: executionT,
      orderUpdatedAtMs: revision,
    };
    expect(flow.recordCumulativeExecution(open).admission).toBe('ADMITTED');
    const terminal = {
      ...open,
      factStage: 'TERMINAL' as const,
      executedPrice: '9',
      executedAmount: '45',
    };
    const preparedTerminal = flow.recordCumulativeExecution(terminal);
    expect(preparedTerminal.admission).toBe('ADMITTED');
    expect(owner.getCostBasis('BULL.HK', true)).toBeNull();
    expect(daily.getLossOffset('LONG')).toBe(String(45n - 50n));
    expect(sink.getStatus()).toEqual({ started: false, currentVersion: 0, staleVersion: 3 });
    expect(snapshot.getView().token.snapshotGeneration).toBe(3);
    const sealed = daily.prepareProtectionBoundary({
      direction: 'LONG',
      boundaryExecutedTimeMs: executionT,
    });
    repository.appendCompletionIdempotent({
      monitorSymbol: 'HSI.HK',
      direction: 'LONG',
      boundaryExecutedTimeMs: executionT,
      orderBaselines: sealed.orderBaselines,
    });
    daily.commitProtectionBoundary(sealed);
    expect(daily.getLossOffset('LONG')).toBe('0');
    expect(fs.readFileSync(logFile)).toEqual(originalBytes);
    const before = {
      fact: owner.getExecutionFact('OFFLINE-SELL'),
      sell: owner.getSellRecordByOrderId('OFFLINE-SELL'),
      buyList: owner.getBuyOrdersForSymbol('BULL.HK', true),
      cost: owner.getCostBasis('BULL.HK', true),
      evidence: daily.getExecutionTimeEvidence(),
      baseline: daily.prepareProtectionBoundary({
        direction: 'LONG',
        boundaryExecutedTimeMs: executionT + 1,
      }),
      episode: episode.getInProgressEpisodes(),
      snapshotToken: snapshot.getView().token,
      sinkStatus: sink.getStatus(),
    };
    const suppressed = {
      ...terminal,
      executedPrice: '9.2',
      // 独立整数账本：9.2 × 5 = 46；不使用生产 exact 或均价 helper。
      executedAmount: String((92n * 5n) / 10n),
      executedTimeMs: executionT,
      orderUpdatedAtMs: revision + 1,
    };
    expect(flow.recordCumulativeExecution(suppressed)).toEqual({
      admission: 'SUPPRESSED',
      authoritativeFactChanged: false,
      executionAdvanced: false,
    });
    const close: FinalizeOrderSettlementParams = {
      orderId: suppressed.orderId,
      closedReason: 'FILLED',
      source: 'STATE_CHECK',
      symbol: suppressed.symbol,
      side: suppressed.side,
      monitorSymbol: suppressed.monitorSymbol,
      isLongSymbol: suppressed.isLongSymbol,
      isProtectiveLiquidation: suppressed.isProtectiveLiquidation,
      executedPrice: suppressed.executedPrice,
      executedAmount: suppressed.executedAmount,
      executedQuantity: suppressed.executedQuantity,
      executedTimeMs: suppressed.executedTimeMs,
      orderUpdatedAtMs: suppressed.orderUpdatedAtMs,
      preparedProtectiveTerminalExecution: preparedTerminal,
    };
    expect(flow.settleOrder(close)).toEqual({ handled: true, relatedBuyOrderIds: null });
    expect(flow.settleOrder(close)).toEqual({ handled: false, relatedBuyOrderIds: null });
    expect(owner.getExecutionFact('OFFLINE-SELL')).toEqual(before.fact);
    expect(owner.getSellRecordByOrderId('OFFLINE-SELL')).toEqual(before.sell);
    expect(owner.getBuyOrdersForSymbol('BULL.HK', true)).toEqual(before.buyList);
    expect(owner.getCostBasis('BULL.HK', true)).toEqual(before.cost);
    expect(daily.getExecutionTimeEvidence()).toEqual(before.evidence);
    expect(
      daily.prepareProtectionBoundary({
        direction: 'LONG',
        boundaryExecutedTimeMs: executionT + 1,
      }),
    ).toEqual(before.baseline);
    expect(daily.getLossOffset('LONG')).toBe('0');
    expect(episode.getInProgressEpisodes()).toEqual(before.episode);
    expect(snapshot.getView().token).toEqual(before.snapshotToken);
    expect(sink.getStatus()).toEqual(before.sinkStatus);
    expect(repository.loadExecutionProgressRecords(dayKey)).toHaveLength(2);
    expect(repository.loadCompletionRecords(dayKey)).toHaveLength(1);
    expect(fs.readFileSync(logFile)).toEqual(originalBytes);
    expect(owner.getPendingSellSnapshot()).toEqual([]);
    expect(holds.getHoldSymbols().size).toBe(0);
    expect(runtime.closedOrderIds.has('OFFLINE-SELL')).toBe(true);
    expect(runtime.trackedOrderLifecycles.get('OFFLINE-SELL')).toBe('CLOSED');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      orderId: 'OFFLINE-SELL',
      source: 'STATE_CHECK',
      status: 'FILLED',
    });
    expect(io.calls).toEqual([]);
    expect(lifecycleClosures).toEqual([]);
    expect(termination.getFatalState()).toEqual({ hasFatalError: false });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
