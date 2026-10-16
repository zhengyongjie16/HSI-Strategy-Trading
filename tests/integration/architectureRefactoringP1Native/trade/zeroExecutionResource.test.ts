import { spyOn, describe, expect, it } from 'bun:test';
import { nowMonotonicMs, wait } from '../../../../src/infrastructure/time/index.js';

import {
  createLoggerDouble,
  createProtectiveLiquidationEpisodeTrackerDouble,
} from '../../../helpers/testDoubles.js';

/** 真normalize→settlement→O pending/tracking/hold资源链：不造经济revision/T或假admission。 */

import { createTradingConfig } from '../../../../mock/factories/configFactory.js';
import { createRateLimiter } from '../../../../src/application/orderExecution/rateLimiter.js';
import { createOrderHoldRegistry } from '../../../../src/application/orderTracking/orderHoldRegistry.js';
import { createSettlementFlow } from '../../../../src/application/orderTracking/orderMonitor/settlementFlow.js';
import type { OrderMonitorRuntimeStore } from '../../../../src/application/orderTracking/orderMonitor/types.js';
import { orderAnalysis } from '../../../../src/domain/order/orderAnalysis.js';
import { normalizeTerminalStateSnapshot } from '../../../../src/domain/order/orderFactMerge.js';
import type { TerminalStateSnapshot } from '../../../../src/domain/order/types.js';
import { createDailyLossTracker } from '../../../../src/domain/risk/dailyLossTracker.js';
import { logger } from '../../../../src/infrastructure/logger/index.js';
import { toHongKongTimeIso } from '../../../../src/utils/time/index.js';

import { createBrokerIngressFixture } from './brokerIngressFixture.js';

async function fixture() {
  const native = await createBrokerIngressFixture({
    orderId: 'RESOURCE',
    tradeId: 'E',
    symbol: 'BULL.HK',
    stockName: 'SDK',
    remark: '',
    side: 'SELL',
    status: 'New',
    quantity: '100',
    executedQuantity: '0',
    submittedPrice: '9.2',
    executedPrice: '0',
    submittedAtMs: 1700000000000,
    executionTimeMs: 1700000000100,
    updatedAtMs: 1700000000200,
  });
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
    runtimeState: 'ACTIVE',
    running: true,
    unsubscribeQuoteUpdated: null,
  };
  let staleCalls = 0;
  let durableCalls = 0;
  let episodeCalls = 0;
  let resourceEvents = 0;
  const recorder = native.createRecorder({
    logger: createLoggerDouble(),
    rateLimiter: createRateLimiter({
      wait: wait,
      nowMonotonicMs: nowMonotonicMs,
      logger: createLoggerDouble(),
    }),
    getExecutionTimeEvidence: () => [],
    settlementRefreshNeedRecorder: {
      recordSettlementRefreshNeed: () => {
        staleCalls++;
      },
    },
  });
  const daily = createDailyLossTracker({
    onOwnershipWarning: () => {},
    ...orderAnalysis,
    toHongKongTimeIso,
  });
  const hold = createOrderHoldRegistry();
  const config = createTradingConfig();
  const ops = native.createOperations({
    logger: createLoggerDouble(),
    wait: wait,
    runtime,
    rateLimiter: createRateLimiter({
      wait: wait,
      nowMonotonicMs: nowMonotonicMs,
      logger: createLoggerDouble(),
    }),
    orderRecorder: recorder,
    orderHoldRegistry: hold,
    monitorConfig: config.monitor,
    now: () => new Date(1700000000300),
    captureWorkGuard: () => () => true,
    termination: {
      isTerminated: () => false,
      reportFatalError: () => {
        throw new Error('unexpected fatal');
      },
    },
    cacheManager: { clearCache: () => {}, getPendingOrders: async () => [] },
    recordCumulativeExecution: () => {},
    triggerRoute: () => {},
    getExecutionTimeEvidence: () => [],
  });
  ops.trackOrder({
    orderId: 'RESOURCE',
    symbol: 'BULL.HK',
    side: 'SELL',
    executionSide: 'SELL',
    price: '9.2',
    initialSubmittedPrice: '9.2',
    quantity: 100,
    submittedAtMs: 1700000000000,
    isLongSymbol: true,
    monitorSymbol: config.monitor.monitorSymbol,
    isProtectiveLiquidation: false,
    orderType: 'ELO',
  });
  recorder.submitSellOrder('RESOURCE', 'BULL.HK', 'LONG', 100, [], false, 1700000000000);
  const tracked = runtime.trackedOrders.get('RESOURCE');
  if (tracked === undefined) throw new Error('actual tracking missing');

  const flow = createSettlementFlow({
    postTradeConsistencyRuntime: {
      recordSettlementRefreshNeed: () => {
        staleCalls++;
      },
    },
    runtime,
    orderRecorder: recorder,
    dailyLossTracker: daily,
    orderHoldRegistry: hold,
    protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble({
      recordProtectiveFillProgress: () => {
        episodeCalls++;
      },
    }),
    persistProtectiveLiquidationExecutionProgress: () => {
      durableCalls++;
    },
    emitOrderStateChanged: () => {
      resourceEvents++;
    },
  });
  return {
    runtime,
    recorder,
    daily,
    hold,
    tracked,
    flow,
    counts: () => ({ staleCalls, durableCalls, episodeCalls, resourceEvents }),
  };
}

describe('zero execution actual shared resource settlement', () => {
  it('verified nonfilled zero/no revision closes pending/tracking/hold exactly once, with no economic/watermark/log publication', async () => {
    const f = await fixture();
    const raw: TerminalStateSnapshot = {
      kind: 'TERMINAL',
      executionStatus: 'NONE',
      closedReason: 'CANCELED',
      status: 'CANCELED',
      executedPrice: null,
      executedQuantity: 0,
      executedAmount: '0',
      executionTimeMs: null,
      submittedQuantity: 100,
      orderUpdatedAtMs: null,
    };
    const normalized = normalizeTerminalStateSnapshot(f.tracked, raw);
    const beforeEvidence = f.daily.getExecutionTimeEvidence();
    const infoLogs: string[] = [];
    const originalInfo = logger.info;
    spyOn(logger, 'info').mockImplementation((message) => {
      infoLogs.push(message);
    });

    try {
      const params = {
        orderId: 'RESOURCE',
        closedReason: normalized.closedReason,
        source: 'API' as const,
        executedPrice: normalized.executedPrice,
        executedQuantity: normalized.executedQuantity,
        executedAmount: normalized.executedAmount,
        executedTimeMs: normalized.executedTimeMs,
        orderUpdatedAtMs: normalized.orderUpdatedAtMs,
      };
      expect(f.flow.settleOrder(params)).toEqual({ handled: true, relatedBuyOrderIds: null });
      expect(f.flow.settleOrder(params)).toEqual({ handled: false, relatedBuyOrderIds: null });
      expect(f.recorder.getPendingSellSnapshot()).toEqual([]);
      expect(f.runtime.trackedOrders.has('RESOURCE')).toBe(false);
      expect(f.runtime.trackedOrderLifecycles.get('RESOURCE')).toBe('CLOSED');
      expect(f.runtime.closedOrderIds.has('RESOURCE')).toBe(true);
      expect(f.hold.getHoldSymbols().has('BULL.HK')).toBe(false);
      expect(f.recorder.getExecutionFact('RESOURCE')).toBeNull();
      expect(f.recorder.getBuyOrdersForSymbol('BULL.HK', true)).toEqual([]);
      expect(f.daily.getExecutionTimeEvidence()).toEqual(beforeEvidence);
      expect(f.counts()).toEqual({
        staleCalls: 0,
        durableCalls: 0,
        episodeCalls: 0,
        resourceEvents: 1,
      });
      expect(infoLogs).toEqual([]);
    } finally {
      spyOn(logger, 'info').mockImplementation(originalInfo);
    }
  });

  it('positive execution lacking T remains internal failure and cannot close resources', async () => {
    const f = await fixture();
    expect(() =>
      f.flow.settleOrder({
        orderId: 'RESOURCE',
        closedReason: 'CANCELED',
        source: 'API',
        executedPrice: '9.2',
        executedQuantity: 10,
        executedAmount: '92',
        executedTimeMs: null,
        orderUpdatedAtMs: 1700000000200,
      }),
    ).toThrow();
    expect(f.runtime.trackedOrders.has('RESOURCE')).toBe(true);
    expect(f.hold.getHoldSymbols().has('BULL.HK')).toBe(true);
    expect(f.recorder.getExecutionFact('RESOURCE')).toBeNull();
    expect(f.counts()).toEqual({
      staleCalls: 0,
      durableCalls: 0,
      episodeCalls: 0,
      resourceEvents: 0,
    });
  });
});
