/** T28 离线恢复链：真实 orderOps、权威查询、recoveryFlow、settlement 与订单记录共用运行态。 */
import { OrderSide, OrderStatus, OrderType } from 'longbridge';
import { createOrder } from '../../../mock/factories/tradeFactory.js';
import { createTradingConfig } from '../../../mock/factories/configFactory.js';
import { createTradeContextMock } from '../../../mock/longbridge/tradeContextMock.js';
import { createRecoveryFlow } from '../../../src/core/trader/orderMonitor/recoveryFlow.js';
import { createOrderOps } from '../../../src/core/trader/orderMonitor/orderOps.js';
import { createSettlementFlow } from '../../../src/core/trader/orderMonitor/settlementFlow.js';
import { createOrderStatusQuery } from '../../../src/core/trader/orderMonitor/orderStatusQuery.js';
import { createOrderRecorder } from '../../../src/core/orderRecorder/index.js';
import { createOrderHoldRegistry } from '../../../src/core/trader/orderHoldRegistry.js';
import type { OrderMonitorRuntimeStore } from '../../../src/core/trader/orderMonitor/types.js';
import type { RawOrderFromAPI, OrderStateChangedEvent } from '../../../src/types/services.js';
import {
  createDailyLossTrackerDouble,
  createProtectiveLiquidationEpisodeTrackerDouble,
  createRateLimiterDouble,
  createSymbolRegistryDouble,
  createTerminationDouble,
  createTradeContextDouble,
} from '../../helpers/testDoubles.js';
import type { RecoveryScenario, RecoveryHarness } from './types.js';

/** 可控 broker 撤单结束前不允许恢复提交；撤单接受与权威终态保持独立。 */
export function createRecoveryHarness(
  scenario: RecoveryScenario,
  externalError?: unknown,
): RecoveryHarness {
  const entered = Promise.withResolvers<undefined>();
  const completion = Promise.withResolvers<undefined>();
  const steps: string[] = [];
  const events: OrderStateChangedEvent[] = [];
  const broker = createTradeContextMock();
  const now = new Date('2026-04-29T01:31:00Z');
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
  let mode = scenario;
  const ctx = createTradeContextDouble({
    ...broker,
    cancelOrder: async () => {
      steps.push('cancel.enter');
      entered.resolve();
      await completion.promise;
      steps.push('cancel.complete');
      if (mode === 'external') throw externalError;

      if (mode !== 'accepted')
        throw Object.assign(new Error('order already closed'), { code: '601011' });
    },
  });
  const terminal = createOrder({
    orderId: 'T28-BUY',
    symbol: 'OLD.HK',
    status: OrderStatus.Canceled,
  });
  broker.seedTodayOrders([terminal]);
  const rateLimiter = createRateLimiterDouble();
  const orderRecorder = createOrderRecorder({ ctx, rateLimiter });
  const orderHoldRegistry = createOrderHoldRegistry();
  orderHoldRegistry.trackOrder('T28-BUY', 'OLD.HK');
  const settlement = createSettlementFlow({
    runtime,
    orderRecorder,
    orderHoldRegistry,
    dailyLossTracker: createDailyLossTrackerDouble(),
    protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
    persistProtectiveLiquidationExecutionProgress: () => {},
    postTradeConsistencyRuntime: {
      recordSettlementRefreshNeed: () => {
        steps.push('refresh');
      },
    },
    emitOrderStateChanged: (event) => {
      events.push(event);
      steps.push('settlement.event');
    },
  });
  const tradingConfig = createTradingConfig();
  const termination = createTerminationDouble();
  const orderOps = createOrderOps({
    runtime,
    ctx,
    rateLimiter,
    orderRecorder,
    orderHoldRegistry,
    monitorConfig: tradingConfig.monitor,
    cacheManager: { clearCache: () => {}, getPendingOrders: async () => [] },
    orderStatusQuery: createOrderStatusQuery({ ctx, rateLimiter }),
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
  const snapshot: RawOrderFromAPI = {
    orderId: 'T28-BUY',
    symbol: 'OLD.HK',
    stockName: 'UNOWNED RC',
    side: OrderSide.Buy,
    status: OrderStatus.New,
    orderType: OrderType.ELO,
    remark: '',
    quantity: '100',
    price: '1',
    executedQuantity: scenario === 'conflict' ? '10' : '0',
    executedPrice: scenario === 'conflict' ? '1' : '0',
    submittedAt: now,
    updatedAt: now,
  };
  let recoveryError: unknown;
  return {
    runtime,
    broker,
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
