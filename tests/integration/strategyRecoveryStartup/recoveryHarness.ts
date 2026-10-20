import { createDiagnosticObserverDouble } from '../../helpers/diagnostics.js';
import { nowMonotonicMs, wait } from '../../../src/infrastructure/time/index.js';

import { createLoggerDouble, createSymbolRegistryDouble } from '../../helpers/testDoubles.js';

/** T28 real same-context recovery admission, authority query, O/Daily/H/S and resource close. */

import { createTradingConfig } from '../../../mock/factories/configFactory.js';
import type { PostGateRuntime } from '../../../src/app/types.js';
import { createRateLimiter } from '../../../src/application/orderExecution/rateLimiter.js';
import { createRecoveryFlow } from '../../../src/application/orderTracking/orderMonitor/recoveryFlow.js';
import { createSettlementFlow } from '../../../src/application/orderTracking/orderMonitor/settlementFlow.js';
import type { OrderStateChangedEvent } from '../../../src/types/orderTracking.js';
import { createExecutionFixture } from '../../application/orderTracking/recorder/executionFixture.js';

import { createBrokerIngressFixture } from '../architectureRefactoringP1Native/trade/brokerIngressFixture.js';
import type { RecoveryHarness, RecoveryScenario } from './types.js';

/** Issued cancellation completion and canonical terminal confirmation remain independent. */
export async function createRecoveryHarness(
  scenario: RecoveryScenario,
  getAppRuntime: () => Pick<PostGateRuntime, 'tradeRuntime' | 'quoteSubscriptionRuntime'>,
  externalError?: unknown,
): Promise<RecoveryHarness> {
  const entered = Promise.withResolvers<undefined>();
  const completion = Promise.withResolvers<undefined>();
  const steps: string[] = [];
  const now = new Date('2026-04-29T01:31:00Z');
  const frame = {
    orderId: 'T28-BUY',
    symbol: 'OLD.HK',
    stockName: 'UNOWNED RC',
    remark: '',
    side: 'BUY' as const,
    status: 'New' as const,
    orderType: 'ELO' as const,
    quantity: '100',
    executedQuantity: scenario === 'conflict' ? '10' : '0',
    submittedPrice: '1',
    executedPrice: scenario === 'conflict' ? '1' : '0',
    submittedAtMs: now.getTime(),
    updatedAtMs: now.getTime(),
  };
  const broker = await createBrokerIngressFixture(frame);
  broker.setAccountBalance({
    currency: 'HKD',
    totalCash: '100000',
    netAssets: '100000',
    availableCash: '100000',
  });
  broker.setStockPositions([]);
  const rateLimiter = createRateLimiter({
    wait: wait,
    nowMonotonicMs: nowMonotonicMs,
    logger: createLoggerDouble(),
  });
  const f = createExecutionFixture({
    nowMs: now.getTime(),
    rateLimiter,
    readPort: broker.createAccountService({ rateLimiter }),
    createRecorder: broker.createRecorder,
    // 同一 app 已组装的 collaborator 接续异步 baseline，不能复用 economic-only 的禁止 IO 默认值。
    getTradeRuntime: () => getAppRuntime().tradeRuntime,
    onPositionsCommitted: () =>
      getAppRuntime().quoteSubscriptionRuntime.reconcileFromCurrentTruth(),
  });
  const { runtime, recorder: orderRecorder, holds: orderHoldRegistry } = f;
  const events: OrderStateChangedEvent[] = [];
  orderHoldRegistry.trackOrder('T28-BUY', 'OLD.HK');
  let mode = scenario;
  broker.setCancelBeforeReply(async () => {
    steps.push('cancel.enter');
    entered.resolve();
    await completion.promise;
    steps.push('cancel.complete');
    if (mode === 'external') throw externalError;

    if (mode !== 'accepted')
      throw Object.assign(new Error('order already closed'), { code: '601011' });
  });

  broker.setOrderDetailReplies([
    {
      ...frame,
      status: 'Canceled',
      stockName: frame.symbol,
      submittedAtMs: Date.now(),
      updatedAtMs: Date.now(),
      // Conflict is the original q10/price1 basis, not a default q0 regression.
      // No independent execution row exists: strict normalization must reject missing T.
      executedQuantity: scenario === 'conflict' ? '10' : '0',
      executedPrice: scenario === 'conflict' ? '1' : '0',
    },
  ]);
  const settlement = createSettlementFlow({
    diagnostics: createDiagnosticObserverDouble(),
    now: () => new Date(),
    runtime,
    orderRecorder,
    orderHoldRegistry,
    dailyLossTracker: f.daily,
    protectiveLiquidationEpisodeTracker: f.episode,
    persistProtectiveLiquidationExecutionProgress: () => {
      throw new Error('ordinary recovery cannot persist protective execution');
    },
    postTradeConsistencyRuntime: {
      ...f.sink,
      recordSettlementRefreshNeed: (need) => {
        f.sink.recordSettlementRefreshNeed(need);
        steps.push('refresh');
      },
    },
    emitOrderStateChanged: (event) => {
      events.push(event);
      steps.push('settlement.event');
    },
  });
  const tradingConfig = createTradingConfig();
  const termination = f.termination;
  const orderOps = broker.createOperations({
    diagnostics: createDiagnosticObserverDouble(),
    logger: createLoggerDouble(),
    wait: wait,
    runtime,
    rateLimiter: f.rateLimiter,
    orderRecorder,
    orderHoldRegistry,
    monitorConfig: tradingConfig.monitor,
    cacheManager: {
      clearCache: () => {},
      getPendingOrders: async () => {
        throw new Error('recovery cannot fetch replacement pending cache');
      },
    },
    captureWorkGuard: () => {
      const captured = f.snapshot.getView().token;
      return () =>
        captured === f.snapshot.getView().token &&
        !termination.isTerminated() &&
        runtime.runtimeState !== 'STOPPED';
    },
    recordCumulativeExecution: (params) => {
      settlement.recordCumulativeExecution(params);
    },
    triggerRoute: () => {
      throw new Error('recovery must not start routes');
    },
    now: () => now,
    termination,
  });
  const recovery = createRecoveryFlow({
    diagnostics: createDiagnosticObserverDouble(),
    now: () => now,
    logger: createLoggerDouble(),
    runtime,
    orderRecorder,
    orderHoldRegistry,
    tradingConfig,
    symbolRegistry: createSymbolRegistryDouble(),
    termination,
    trackOrder: orderOps.trackOrder,
    cancelOrder: async (orderId) => {
      const outcome = await orderOps.cancelOrder(orderId, { kind: 'ORDER_FACT' });
      if (outcome.kind === 'CANCEL_NOT_STARTED')
        throw new Error('unexpected private cancel outcome');

      return outcome;
    },
    settleOrder: settlement.settleOrder,
    handleOrderChangedWhenActive: () => {
      throw new Error('no WS fixture events');
    },
  });
  const snapshot = broker.queryObservation;
  let recoveryError: unknown;
  return {
    runtime,
    broker,
    executionOwner: f,
    orderRecorder,
    orderHoldRegistry,
    events,
    steps,
    entered: entered.promise,
    complete: () => {
      completion.resolve();
    },
    useTrustedZero: () => {
      mode = 'zero';
      broker.setOrderDetailReplies([
        {
          ...frame,
          status: 'Canceled',
          executedQuantity: '0',
          executedPrice: '0',
        },
      ]);
    },
    error: () => recoveryError,
    recover: async () => {
      try {
        await recovery.recoverOrderTrackingFromSnapshot([snapshot]);
        steps.push('recovery.complete');
      } catch (error) {
        recoveryError = error;
        steps.push('recovery.reject');
        throw error;
      }
    },
  };
}
