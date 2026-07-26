/**
 * OPEN state-check 金额修订业务测试。
 *
 * 验证数量不变但权威 revision 提高成交金额时，订单监控仍将事实交给 DailyLoss 链路，
 * 同时不得把它误当作新的部分成交而重复更新卖单数量。
 */
import { describe, expect, it } from 'bun:test';
import { OrderSide, OrderStatus, OrderType } from 'longbridge';
import { createTradingConfig } from '../../../../mock/factories/configFactory.js';
import { createPushOrderChanged } from '../../../../mock/factories/tradeFactory.js';
import { createTradeContextMock } from '../../../../mock/longbridge/tradeContextMock.js';
import { createDailyLossOrderAnalysisDeps } from '../../../../src/core/orderRecorder/index.js';
import { createDailyLossTracker } from '../../../../src/core/riskController/dailyLossTracker.js';
import { createEventFlow as createProductionEventFlow } from '../../../../src/core/trader/orderMonitor/eventFlow.js';
import { createOrderOps as createProductionOrderOps } from '../../../../src/core/trader/orderMonitor/orderOps.js';
import { createSettlementFlow } from '../../../../src/core/trader/orderMonitor/settlementFlow.js';
import { createProtectiveLiquidationEpisodeTracker } from '../../../../src/core/trader/protectiveLiquidationEpisodeTracker/index.js';
import type {
  OrderMonitorRuntimeStore,
  OrderMonitorTrackedOrder,
  EventFlowDeps,
  OrderOpsDeps,
} from '../../../../src/core/trader/orderMonitor/types.js';
import type { OrderCacheManager, OrderHoldRegistry } from '../../../../src/core/trader/types.js';
import type { RateLimiter, TradeMutationPermit } from '../../../../src/types/services.js';
import { toHongKongTimeIso } from '../../../../src/utils/time/index.js';
import {
  createOrderRecorderDouble,
  createTradeContextDouble,
} from '../../../helpers/testDoubles.js';

type TestEventFlowDeps = Omit<EventFlowDeps, 'now'> & Partial<Pick<EventFlowDeps, 'now'>>;
type TestOrderOpsDeps = Omit<OrderOpsDeps, 'now'> & Partial<Pick<OrderOpsDeps, 'now'>>;

function createEventFlow(deps: TestEventFlowDeps) {
  return createProductionEventFlow({
    now: () => new Date('2031-01-02T03:04:05.000Z'),
    ...deps,
  });
}

function createOrderOps(deps: TestOrderOpsDeps) {
  return createProductionOrderOps({
    now: () => new Date('2031-01-02T03:04:05.000Z'),
    ...deps,
  });
}

function createRuntime(): OrderMonitorRuntimeStore {
  return {
    trackedOrders: new Map<string, OrderMonitorTrackedOrder>(),
    trackedOrderLifecycles: new Map(),
    bootstrappingOrderEvents: new Map(),
    closedOrderIds: new Set(),
    queriedTerminalStateByOrderId: new Map(),
    latestReplaceTerminalByOrderId: new Map(),
    orderStateChangedListeners: new Set(),
    trackedOrderIdsBySymbol: new Map(),
    routeStatesBySymbol: new Map(),
    latestRouteGenerationBySymbol: new Map(),
    runtimeState: 'ACTIVE',
    running: true,
    unsubscribeQuoteUpdated: null,
  };
}

function createOrderHoldRegistry(): OrderHoldRegistry {
  return {
    trackOrder: () => {},
    markOrderClosed: () => {},
    seedFromOrders: () => {},
    getHoldSymbols: () => new Set(),
    onOrderHoldSymbolsChanged: () => () => {},
    clear: () => {},
  };
}

function createRateLimiter(): RateLimiter {
  return {
    throttle: async () => {},
    withTradeMutation: async <T>(
      callback: (permit: TradeMutationPermit) => Promise<T>,
    ): Promise<T> =>
      callback({
        invoke: async <TResult>(operation: () => Promise<TResult>): Promise<TResult> => operation(),
      }),
  };
}

function createCacheManager(): OrderCacheManager {
  return {
    getPendingOrders: async () => [],
    clearCache: () => {},
  };
}

describe('orderMonitor OPEN state-check amount revision', () => {
  it('routes a higher-revision equal-quantity correction through DailyLoss without re-marking partial fill', async () => {
    const firstRevisionMs = Date.parse('2026-07-11T02:00:00.000Z');
    const secondRevisionMs = firstRevisionMs + 1_000;
    const runtime = createRuntime();
    const tradeContext = createTradeContextMock();
    tradeContext.cancelOrder = async () => {
      throw new Error('openapi error: code=601011: order cannot be cancelled');
    };
    const partialFills: number[] = [];
    const persistedProgress: Array<{
      readonly factStage: 'OPEN' | 'TERMINAL';
      readonly cumulativeQuantity: string;
      readonly cumulativeAmount: string;
      readonly lastExecutionTimeMs: number;
      readonly orderRevisionMs: number;
    }> = [];
    let refreshCount = 0;
    const orderRecorder = createOrderRecorderDouble({
      markSellPartialFilled: (_orderId, quantity) => {
        partialFills.push(quantity);
        return null;
      },
    });
    const dailyLossTracker = createDailyLossTracker({
      ...createDailyLossOrderAnalysisDeps(),
      resolveOrderOwnership: () => null,
      toHongKongTimeIso,
    });
    dailyLossTracker.resetAll(new Date('2026-07-11T01:00:00.000Z'));
    const settlementFlow = createSettlementFlow({
      runtime,
      orderHoldRegistry: createOrderHoldRegistry(),
      orderRecorder,
      dailyLossTracker,
      protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTracker(),
      persistProtectiveLiquidationExecutionProgress: (progress) => {
        persistedProgress.push({
          factStage: progress.factStage,
          cumulativeQuantity: progress.cumulativeQuantity,
          cumulativeAmount: progress.cumulativeAmount,
          lastExecutionTimeMs: progress.lastExecutionTimeMs,
          orderRevisionMs: progress.orderRevisionMs,
        });
      },
      postTradeConsistencyRuntime: {
        recordSettlementRefreshNeed: () => {
          refreshCount += 1;
        },
      },
      emitOrderStateChanged: () => {},
    });
    const orderOps = createOrderOps({
      runtime,
      monitorConfig: createTradingConfig().monitor,
      ctx: createTradeContextDouble(tradeContext),
      rateLimiter: createRateLimiter(),
      cacheManager: createCacheManager(),
      orderHoldRegistry: createOrderHoldRegistry(),
      orderRecorder,
      recordCumulativeExecution: (params) => {
        settlementFlow.recordCumulativeExecution(params);
      },
      orderStatusQuery: {
        checkOrderState: async () => ({
          kind: 'OPEN' as const,
          status: OrderStatus.PartialFilled,
          executedPrice: 9.4,
          executedQuantity: 40,
          updatedAtMs: secondRevisionMs,
        }),
      },
      triggerRoute: () => {},
    });
    orderOps.trackOrder({
      orderId: 'OPEN-STATE-AMOUNT-REVISION',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      price: 9,
      initialSubmittedPrice: 9,
      quantity: 100,
      initialStatus: OrderStatus.PartialFilled,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: true,
      orderType: OrderType.ELO,
    });
    const trackedOrder = runtime.trackedOrders.get('OPEN-STATE-AMOUNT-REVISION');
    if (trackedOrder === undefined) {
      throw new Error('missing tracked order');
    }

    const eventFlow = createEventFlow({
      runtime,
      orderRecorder,
      recordCumulativeExecution: (params) => {
        settlementFlow.recordCumulativeExecution(params);
      },
      prepareProtectiveTerminalExecution: settlementFlow.prepareProtectiveTerminalExecution,
      settleOrder: settlementFlow.settleOrder,
      cacheBootstrappingEvent: () => {},
      triggerRoute: () => {},
    });
    eventFlow.handleOrderChangedWhenActive(
      createPushOrderChanged({
        orderId: trackedOrder.orderId,
        symbol: trackedOrder.symbol,
        side: trackedOrder.side,
        status: OrderStatus.PartialFilled,
        executedQuantity: 40,
        executedPrice: 9,
        updatedAtMs: firstRevisionMs,
      }),
    );

    await orderOps.cancelOrder('OPEN-STATE-AMOUNT-REVISION', { kind: 'ORDER_FACT' });

    expect(persistedProgress).toEqual([
      {
        factStage: 'OPEN',
        cumulativeQuantity: '40',
        cumulativeAmount: '360',
        lastExecutionTimeMs: firstRevisionMs,
        orderRevisionMs: firstRevisionMs,
      },
      {
        factStage: 'OPEN',
        cumulativeQuantity: '40',
        cumulativeAmount: '376',
        lastExecutionTimeMs: firstRevisionMs,
        orderRevisionMs: secondRevisionMs,
      },
    ]);
    expect(partialFills).toEqual([40]);
    expect(refreshCount).toBe(2);
  });
});
