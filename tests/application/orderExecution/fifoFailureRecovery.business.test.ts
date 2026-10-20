import { nowMonotonicMs, wait } from '../../../src/infrastructure/time/index.js';
import { createDiagnosticObserverDouble } from '../../helpers/diagnostics.js';

import {
  createLoggerDouble,
  createMarketDataClientDouble,
  createOrderMonitorDouble,
  createOrderRecorderDouble,
  createPositionDouble,
  createQuoteDouble,
  createRiskCheckerDouble,
  createSymbolRegistryDouble,
} from '../../helpers/testDoubles.js';

/** 实际executor REPLACE→OrderOps→同context query与同一FIFO；保602013退避/WAIT_WS_ONLY及ACK事实。 */

import { describe, expect, it } from 'bun:test';
import { createTradingConfig } from '../../../mock/factories/configFactory.js';
import { createSignal } from '../../../mock/factories/signalFactory.js';
import { createOrderExecutor } from '../../../src/application/orderExecution/index.js';
import { createRateLimiter } from '../../../src/application/orderExecution/rateLimiter.js';
import { createOrderHoldRegistry } from '../../../src/application/orderTracking/orderHoldRegistry.js';
import type { OrderMonitorRuntimeStore } from '../../../src/application/orderTracking/orderMonitor/types.js';
import type { RateLimiter } from '../../../src/types/rateLimit.js';

import { createBrokerIngressFixture } from '../../integration/architectureRefactoringP1Native/trade/brokerIngressFixture.js';

async function createFixture() {
  const originTime = Date.parse('2026-07-10T02:00:00Z');
  let currentMs = originTime;
  let held = false;
  let afterAck = () => {};
  const native = await createBrokerIngressFixture({
    orderId: 'OLD',
    symbol: 'BULL.HK',
    stockName: 'BULL',
    remark: '',
    side: 'SELL',
    status: 'New',
    quantity: '100',
    executedQuantity: '0',
    submittedPrice: '5',
    executedPrice: '0',
    submittedAtMs: originTime,
    updatedAtMs: originTime,
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
  const fifo = createRateLimiter({
    wait: wait,
    nowMonotonicMs: nowMonotonicMs,
    logger: createLoggerDouble(),
  });
  const limiter: RateLimiter = {
    throttle: async () => {
      expect(held).toBeFalse();
      await fifo.throttle();
    },
    withTradeMutation: (callback) =>
      fifo.withTradeMutation(async (permit) => {
        held = true;
        try {
          return await callback(permit);
        } finally {
          held = false;
        }
      }),
  };
  const baseConfig = createTradingConfig();
  const config = {
    ...baseConfig,
    global: { ...baseConfig.global, tradingOrderType: 'LO' as const },
  };
  const recorder = createOrderRecorderDouble();
  const ops = native.createOperations({
    logger: createLoggerDouble(),
    diagnostics: createDiagnosticObserverDouble(),
    wait: wait,
    runtime,
    rateLimiter: limiter,
    orderRecorder: recorder,
    orderHoldRegistry: createOrderHoldRegistry(),
    monitorConfig: config.monitor,
    now: () => new Date(currentMs),
    captureWorkGuard: () => () => true,
    termination: {
      isTerminated: () => false,
      reportFatalError: (error) => {
        throw error;
      },
    },
    cacheManager: { clearCache() {}, getPendingOrders: async () => [] },
    recordCumulativeExecution() {},
    triggerRoute() {},
  });
  ops.trackOrder({
    orderId: 'OLD',
    symbol: 'BULL.HK',
    side: native.queryObservation.executionSide,
    executionSide: native.queryObservation.executionSide,
    price: '5',
    initialSubmittedPrice: '5',
    quantity: 100,
    submittedAtMs: originTime,
    isLongSymbol: true,
    monitorSymbol: config.monitor.monitorSymbol,
    isProtectiveLiquidation: false,
    orderType: native.queryObservation.orderType,
  });
  const tracked = runtime.trackedOrders.get('OLD');
  if (!tracked) throw new Error('actual trackOrder must publish tracked state');

  const executor = createOrderExecutor({
    logger: createLoggerDouble(),
    diagnostics: createDiagnosticObserverDouble(),
    readSellPositions: async () => [
      createPositionDouble({ symbol: 'BULL.HK', quantity: 500, availableQuantity: 500 }),
    ],
    tradeMutationPort: {
      cancelOrder: async () => {
        throw new Error('REPLACE path must not cancel');
      },
      submitOrder: async () => {
        throw new Error('REPLACE path must never new-submit');
      },
      replaceOrder: async () => {
        throw new Error('OrderOps owns native replace');
      },
    },
    rateLimiter: limiter,
    marketDataClient: createMarketDataClientDouble({
      getQuotes: async () => new Map([['BULL.HK', createQuoteDouble('BULL.HK', '5', 100)]]),
    }),
    cacheManager: { clearCache() {} },
    orderMonitor: createOrderMonitorDouble({
      trackOrder: ops.trackOrder,
      cancelOrder: async () => {
        throw new Error('REPLACE path must not cancel');
      },
      replaceOrderPriceWithPermit: async (...args) => {
        const outcome = await ops.replaceOrderPriceWithPermit(...args);
        if (outcome.kind === 'BROKER_CONFIRMED') afterAck();

        return outcome;
      },
      getPendingSellOrders: () => [
        {
          orderId: tracked.orderId,
          status: tracked.status,
          orderType: tracked.orderType,
          submittedQuantity: tracked.submittedQuantity,
          executedQuantity: tracked.executedQuantity,
          submittedAt: originTime,
          isProtectiveLiquidation: false,
        },
      ],
    }),
    orderRecorder: recorder,
    unrealizedLossBuyGate: createRiskCheckerDouble(),
    tradingConfig: config,
    symbolRegistry: createSymbolRegistryDouble(),
    isExecutionAllowed: () => true,
    isContinuousTradingAllowed: () => true,
    now: () => new Date(currentMs),
    readCurrentTradingDayInfo: () => ({
      dateKey: '2026-07-10',
      info: { isTradingDay: true, isHalfDay: false },
    }),
  });
  return {
    native,
    ops,
    tracked,
    executor,
    setAfterAck: (callback: () => void) => {
      afterAck = callback;
    },
    advanceClock: () => {
      currentMs += 60000;
    },
    signal: {
      ...createSignal({
        symbol: 'BULL.HK',
        action: 'SELLCALL',
        triggerTimeMs: originTime,
      }),
      quantity: 100,
    },
    request: { kind: 'SIGNAL_AUTHORIZED' as const, authorize: () => true },
  };
}

describe('executor real FIFO failure recovery', () => {
  it('preserves four 602013 backoffs, then queries after outer FIFO release and preserves WAIT_WS_ONLY', async () => {
    const f = await createFixture();
    f.native.failReplace(Object.assign(new Error('temporarily blocked'), { code: '602013' }));
    for (let i = 1; i <= 4; i++) {
      expect(await f.ops.replaceOrderPrice('OLD', '5', f.request, 100)).toEqual({
        kind: 'NOT_EXECUTED',
      });
      expect(f.tracked.replaceTempBlockedCount).toBe(i);
      expect(f.tracked.replaceResumeMode).toBe('TIME_BACKOFF');
      f.advanceClock();
    }

    expect(f.native.nativeReadCounts().detail).toBe(0);
    expect(await f.executor.executeSignals([f.signal], () => true)).toEqual({
      executedOrderIds: [],
      quoteFailures: [],
    });
    expect(f.tracked.replaceTempBlockedCount).toBe(5);
    expect(f.tracked.replaceResumeMode).toBe('WAIT_WS_ONLY');
    expect(f.native.nativeReadCounts().detail).toBe(1);
    expect(f.native.nativeMutations()).toHaveLength(5);
    expect(await f.executor.executeSignals([f.signal], () => true)).toEqual({
      executedOrderIds: [],
      quoteFailures: [],
    });
    expect(f.native.nativeReadCounts().detail).toBe(1);
    expect(f.native.nativeMutations()).toHaveLength(5);
  }, 10000);

  it('keeps actual native replacement ACK and broker ID after the original caller becomes stale', async () => {
    const f = await createFixture();
    let live = true;
    f.setAfterAck(() => {
      live = false;
    });

    expect(await f.executor.executeSignals([f.signal], () => live)).toEqual({
      executedOrderIds: ['OLD'],
      quoteFailures: [],
    });
    expect(f.tracked.submittedQuantity).toBe(200);
    expect(f.native.nativeMutations()).toHaveLength(1);
    expect(live).toBeFalse();
  });
});
