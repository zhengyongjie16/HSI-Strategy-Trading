/** 订单经济回归 fixture：真实 O/Daily 同步准入和同实例 H/S stale 登记，不提供伪 readiness。 */
import { createPostTradeConsistencyRuntime } from '../../../src/app/runtime/createPostTradeConsistencyRuntime.js';
import { createTerminationRuntime } from '../../../src/app/runtime/createTerminationRuntime.js';
import { createAccountPositionSnapshot } from '../../../src/application/accountPositionSnapshot/index.js';
import {
  createDailyLossOrderAnalysisDeps,
  createOrderRecorder,
} from '../../../src/core/orderRecorder/index.js';
import { createDailyLossTracker } from '../../../src/core/riskController/dailyLossTracker.js';
import { createOrderHoldRegistry } from '../../../src/core/trader/orderHoldRegistry.js';
import { createSettlementFlow } from '../../../src/core/trader/orderMonitor/settlementFlow.js';
import { createProtectiveLiquidationEpisodeTracker } from '../../../src/core/trader/protectiveLiquidationEpisodeTracker/index.js';
import type {
  OrderCumulativeExecutionParams,
  OrderMonitorRuntimeStore,
  SettlementFlowDeps,
} from '../../../src/core/trader/orderMonitor/types.js';
import { toHongKongTimeIso } from '../../../src/utils/time/index.js';
import { createOfflineBrokerPort } from '../../integration/accountPositionConsistency/offlinePorts.js';
import { createRateLimiter } from '../../../src/core/trader/rateLimiter.js';
import type { OrderStateChangedEvent, Trader } from '../../../src/types/services.js';
import type { SnapshotReadPort } from '../../../src/types/accountPosition.js';
import type { OrderRecorderFactoryDeps } from '../../../src/core/orderRecorder/types.js';

/** 构造真实同步结算链；未启动消费者时不读取账户、不声称 fresh。 */
export function createExecutionFixture(
  params: {
    readonly nowMs?: number;
    readonly rateLimiter?: ReturnType<typeof createRateLimiter>;
    readonly termination?: ReturnType<typeof createTerminationRuntime>;
    readonly readPort?: SnapshotReadPort;
    readonly getTrader?: () => Trader;
    readonly onPositionsCommitted?: () => Promise<void>;
    readonly persistProgress?: SettlementFlowDeps['persistProtectiveLiquidationExecutionProgress'];
    readonly createRecorder?: (
      deps: Omit<OrderRecorderFactoryDeps, 'orderSnapshotReadPort'> &
        Readonly<{ rateLimiter: ReturnType<typeof createRateLimiter> }>,
    ) => ReturnType<typeof createOrderRecorder>;
    readonly observeRefresh?: (need: {
      readonly refreshAccount: boolean;
      readonly refreshPositions: boolean;
    }) => void;
    readonly observeDaily?: (
      owner: ReturnType<typeof createDailyLossTracker>,
    ) => ReturnType<typeof createDailyLossTracker>;
    readonly observeRecorder?: (
      owner: ReturnType<typeof createOrderRecorder>,
    ) => ReturnType<typeof createOrderRecorder>;
  } = {},
): {
  readonly recorder: ReturnType<typeof createOrderRecorder>;
  readonly daily: ReturnType<typeof createDailyLossTracker>;
  readonly snapshot: ReturnType<typeof createAccountPositionSnapshot>;
  readonly sink: ReturnType<typeof createPostTradeConsistencyRuntime>;
  readonly io: ReturnType<typeof createOfflineBrokerPort>;
  readonly rateLimiter: ReturnType<typeof createRateLimiter>;
  readonly flow: ReturnType<typeof createSettlementFlow>;
  readonly now: number;
  readonly events: ReadonlyArray<OrderStateChangedEvent>;
  readonly runtime: OrderMonitorRuntimeStore;
  readonly termination: ReturnType<typeof createTerminationRuntime>;
  readonly holds: ReturnType<typeof createOrderHoldRegistry>;
  readonly episode: ReturnType<typeof createProtectiveLiquidationEpisodeTracker>;
  readonly commit: (
    orderId: string,
    side: 'BUY' | 'SELL',
    price: string,
    amount: string,
    quantity: number,
    offsetMs: number,
    ...scope: readonly [symbol?: string, isLong?: boolean]
  ) => ReturnType<ReturnType<typeof createSettlementFlow>['recordCumulativeExecution']>;
} {
  const now = params.nowMs ?? Date.parse('2026-03-13T02:00:00.000Z');
  const io = createOfflineBrokerPort();
  const rateLimiter = params.rateLimiter ?? createRateLimiter();
  const rejectUnexpected = (): never => {
    throw new Error('economic fixture does not authorize IO or protective persistence');
  };
  const termination =
    params.termination ??
    createTerminationRuntime({
      closeTradingGate: rejectUnexpected,
      closeProducerAdmission: rejectUnexpected,
      stopProducers: [],
      onSecondaryError: rejectUnexpected,
    });
  const snapshot = createAccountPositionSnapshot({
    dayEpoch: 1,
    scheduler: { schedule: queueMicrotask },
    readPort: params.readPort ?? {
      getAccountSnapshot: async () => rejectUnexpected(),
      getStockPositions: async () => rejectUnexpected(),
    },
    reportFatalError: termination.reportFatalError,
  });
  const sinkOwner = createPostTradeConsistencyRuntime({
    snapshot,
    termination,
    getTrader: params.getTrader ?? rejectUnexpected,
    onPositionsCommitted: params.onPositionsCommitted ?? (async () => rejectUnexpected()),
    scheduler: { scheduleTimer: setTimeout, clearTimer: clearTimeout },
  });
  const sink =
    params.observeRefresh === undefined
      ? sinkOwner
      : {
          ...sinkOwner,
          recordSettlementRefreshNeed: (
            need: Parameters<typeof sinkOwner.recordSettlementRefreshNeed>[0],
          ) => {
            sinkOwner.recordSettlementRefreshNeed(need);
            params.observeRefresh?.(need);
          },
        };
  const dailyOwner = createDailyLossTracker({
    ...createDailyLossOrderAnalysisDeps(),
    toHongKongTimeIso,
  });
  dailyOwner.resetAll(new Date(now));
  const daily = params.observeDaily === undefined ? dailyOwner : params.observeDaily(dailyOwner);
  const recorderDeps = {
    rateLimiter,
    getExecutionTimeEvidence: daily.getExecutionTimeEvidence,
    settlementRefreshNeedRecorder: sink,
  };
  const recorderOwner =
    params.createRecorder === undefined
      ? createOrderRecorder({
          orderSnapshotReadPort: {
            fetchSnapshots: async () => rejectUnexpected(),
          },
          ...recorderDeps,
        })
      : params.createRecorder(recorderDeps);
  const recorder =
    params.observeRecorder === undefined ? recorderOwner : params.observeRecorder(recorderOwner);
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
  const holds = createOrderHoldRegistry();
  const episode = createProtectiveLiquidationEpisodeTracker();
  const flow = createSettlementFlow({
    runtime,
    orderRecorder: recorder,
    dailyLossTracker: daily,
    orderHoldRegistry: holds,
    protectiveLiquidationEpisodeTracker: episode,
    persistProtectiveLiquidationExecutionProgress: params.persistProgress ?? rejectUnexpected,
    postTradeConsistencyRuntime: sink,
    emitOrderStateChanged: (event) => {
      events.push(event);
    },
  });
  function commit(
    orderId: string,
    side: 'BUY' | 'SELL',
    price: string,
    amount: string,
    quantity: number,
    offsetMs: number,
    ...scope: readonly [symbol?: string, isLong?: boolean]
  ) {
    const [symbol = 'TEST.HK', isLong = true] = scope;
    const execution: OrderCumulativeExecutionParams = {
      factStage: 'TERMINAL',
      orderId,
      side,
      monitorSymbol: 'HSI.HK',
      symbol,
      isLongSymbol: isLong,
      isProtectiveLiquidation: false,
      executedQuantity: quantity,
      executedPrice: price,
      executedAmount: amount,
      executedTimeMs: now + offsetMs,
      orderUpdatedAtMs: now + offsetMs,
    };
    return flow.recordCumulativeExecution(execution);
  }
  return {
    recorder,
    daily,
    snapshot,
    sink,
    io,
    rateLimiter,
    flow,
    commit,
    now,
    events,
    runtime,
    termination,
    holds,
    episode,
  };
}
