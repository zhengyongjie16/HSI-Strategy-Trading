import { createDiagnosticObserverDouble } from '../../../helpers/diagnostics.js';
import { nowMonotonicMs, wait } from '../../../../src/infrastructure/time/index.js';

import { createLoggerDouble, createOrderRecorderDouble } from '../../../helpers/testDoubles.js';

/** 实际Route/OrderOps→生产FIFO→同一adapter/native entry；静态SDKDTO，不构造联网context。 */

import { describe, expect, it } from 'bun:test';
import { createTradingConfig } from '../../../../mock/factories/configFactory.js';
import { createRateLimiter } from '../../../../src/application/orderExecution/rateLimiter.js';
import { createOrderHoldRegistry } from '../../../../src/application/orderTracking/orderHoldRegistry.js';
import type { OrderMonitorRuntimeStore } from '../../../../src/application/orderTracking/orderMonitor/types.js';
import { buildOrderMonitorConfig } from '../../../../src/domain/order/orderTrackingPolicy.js';

import { interceptNativeDecimalSerialization } from '../../../infrastructure/longbridge/trade/mutationStageFixture.js';
import { createBrokerIngressFixture } from './brokerIngressFixture.js';

async function fixture() {
  const native = await createBrokerIngressFixture({
    orderId: 'OLD',
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
    latestRouteGenerationBySymbol: new Map([['BULL.HK', 1]]),
    runtimeState: 'ACTIVE',
    running: true,
    unsubscribeQuoteUpdated: null,
  };
  const rateLimiter = createRateLimiter({
    wait: wait,
    nowMonotonicMs: nowMonotonicMs,
    logger: createLoggerDouble(),
  });
  const orderRecorder = createOrderRecorderDouble();
  const config = createTradingConfig();
  let live = true;
  const hold = createOrderHoldRegistry();
  const ops = native.createOperations({
    diagnostics: createDiagnosticObserverDouble(),
    logger: createLoggerDouble(),
    wait: wait,
    runtime,
    rateLimiter,
    orderRecorder,
    orderHoldRegistry: hold,
    monitorConfig: config.monitor,
    now: () => new Date(1700000200000),
    captureWorkGuard: () => () => live,
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
    orderId: 'OLD',
    symbol: 'BULL.HK',
    side: native.queryObservation.executionSide,
    executionSide: native.queryObservation.executionSide,
    price: '9.2',
    initialSubmittedPrice: '9.2',
    quantity: 100,
    submittedAtMs: 1700000000000,
    isLongSymbol: true,
    monitorSymbol: config.monitor.monitorSymbol,
    isProtectiveLiquidation: false,
    orderType: native.queryObservation.orderType,
  });
  const tracked = runtime.trackedOrders.get('OLD');
  if (tracked === undefined) throw new Error('production track missing');

  return {
    native,
    runtime,
    ops,
    rateLimiter,
    orderRecorder,
    config,
    tracked,
    hold,
    request: { kind: 'SIGNAL_AUTHORIZED' as const, authorize: () => live },
    revoke: () => {
      live = false;
    },
  };
}

async function rejection(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }

  throw new Error('expected rejection');
}

describe('monitor actual native mutation stages', () => {
  it('OrderOps keeps exact high precision price and safe quantity through native replace ACK', async () => {
    const f = await fixture();
    expect(await f.ops.replaceOrderPrice('OLD', '9.234567891234567891', f.request, 100)).toEqual({
      kind: 'BROKER_CONFIRMED',
    });

    expect(f.native.nativeMutations()).toEqual([
      {
        kind: 'REPLACE',
        orderId: 'OLD',
        symbol: null,
        price: '9.234567891234567891',
        quantity: '100',
        market: false,
        day: false,
      },
    ]);
    expect(f.tracked.submittedPrice).toBe('9.234567891234567891');
  });

  it('replace native capacity/underflow/unsafe quantity fail PRE_IO, even when serialization detaches the original tracked object', async () => {
    for (const [price, quantity] of [
      ['18800.12345678901234567890123456', 100],
      ['0.00000000000000000000000000001', 100],
      ['9.2', 100.5],
    ] as const) {
      const f = await fixture();
      const restoreSerialization = interceptNativeDecimalSerialization(() => {
        f.runtime.trackedOrders.delete('OLD');
      });

      try {
        expect(
          await rejection(() => f.ops.replaceOrderPrice('OLD', price, f.request, quantity)),
        ).toBeInstanceOf(RangeError);
        expect(f.native.nativeMutations()).toEqual([]);
      } finally {
        restoreSerialization();
      }
    }
  });

  it('replace rechecks original caller at serialization-complete native edge, current gate is not an authority substitute', async () => {
    const f = await fixture();
    const restoreSerialization = interceptNativeDecimalSerialization(f.revoke);

    try {
      expect(await f.ops.replaceOrderPrice('OLD', '9.3', f.request)).toEqual({
        kind: 'NOT_EXECUTED',
      });
      expect(f.native.nativeMutations()).toEqual([]);
      expect(f.tracked.submittedPrice).toBe('9.2');
    } finally {
      restoreSerialization();
    }
  });

  it('issued native RangeError retains identity even after the original tracked object detaches', async () => {
    const f = await fixture();
    const fault = new RangeError('native internal contract');
    f.native.setReplaceBeforeReply(async () => {
      f.runtime.trackedOrders.delete('OLD');
      throw fault;
    });
    expect(await rejection(() => f.ops.replaceOrderPrice('OLD', '9.3', f.request))).toBe(fault);
    expect(f.native.nativeMutations()).toHaveLength(1);
  });

  it('cancel closed-business error reaches lazy invalid SDK revision decoder before ledger IO or local writes', async () => {
    const f = await fixture();
    const failure = new Error('already closed');
    Reflect.set(failure, 'code', '601011');
    f.native.setCancelFailure(failure);
    f.native.setQueryUpdatedAtMs(Number.NaN);
    const error = await rejection(() => f.ops.cancelOrder('OLD', { kind: 'ORDER_FACT' }));
    expect(error).toBeInstanceOf(TypeError);
    expect(error).toHaveProperty('message', '[orderMapper] invalid updatedAt');
    expect(f.native.nativeReadCounts()).toEqual({ cancel: 1, detail: 1 });
    expect(f.native.readCounts()).toEqual({ today: 1, history: 0 });
    expect(f.tracked.executedQuantity).toBe(0);
    expect(f.runtime.queriedTerminalStateByOrderId.size).toBe(0);
  });

  it('fifth 602013 confirms via actual native query only outside the outermost production FIFO, then WAIT_WS_ONLY', async () => {
    const f = await fixture();
    const failure = new Error('status does not allow amendment');
    Reflect.set(failure, 'code', '602013');
    f.native.failReplace(failure);
    f.tracked.replaceTempBlockedCount = 4;
    const result = await f.rateLimiter.withTradeMutation((permit) =>
      f.ops.replaceOrderPriceWithPermit('OLD', '9.3', f.request, permit),
    );
    expect(result.kind).toBe('POST_FAILURE_CONFIRMATION_REQUIRED');
    expect(f.native.readCounts()).toEqual({ today: 1, history: 0 });
    if (result.kind !== 'POST_FAILURE_CONFIRMATION_REQUIRED')
      throw new Error('expected deferred confirmation');

    expect(await result.confirmAfterPermitReleased()).toEqual({ kind: 'NOT_EXECUTED' });
    expect(f.native.readCounts()).toEqual({ today: 2, history: 0 });
    expect(f.tracked.replaceResumeMode).toBe('WAIT_WS_ONLY');
    expect(f.native.nativeMutations()).toHaveLength(1);
  });

  it('RouteProcessor timeout converts confirmed nonfill remainder into native MO/no-price/DAY exactly once and holds actual new identity', async () => {
    const f = await fixture();
    f.tracked.timeoutMarketConversionPending = true;
    f.tracked.timeoutMarketConversionTerminalState = {
      source: 'WS',
      closedReason: 'CANCELED',
      executedPrice: null,
      executedQuantity: 0,
      executedAmount: '0',
      executedTimeMs: null,
      orderUpdatedAtMs: 1700000000200,
    };
    const acceptedContinuations: Array<readonly [string, string]> = [];
    const route = f.native.createRoute({
      diagnostics: createDiagnosticObserverDouble(),
      logger: createLoggerDouble(),
      runtime: f.runtime,
      rateLimiter: f.rateLimiter,
      orderRecorder: f.orderRecorder,
      config: buildOrderMonitorConfig(f.config.global),
      now: () => new Date(1700000200000),
      isContinuousTradingAllowed: () => true,
      releaseSellHandoff: (orderId) => {
        f.orderRecorder.markSellCancelled(orderId);
      },
      recordAcceptedSellContinuation: (originalId, marketId) => {
        acceptedContinuations.push([originalId, marketId]);
      },
      trackOrder: f.ops.trackOrder,
      cancelOrder: async () => {
        throw new Error('confirmed terminal must not cancel again');
      },
      settleOrder: () => ({ handled: true, relatedBuyOrderIds: [] }),
      replaceOrderPrice: async () => {
        throw new Error('timeout must not replace');
      },
    });
    const generation = f.runtime.latestRouteGenerationBySymbol.get('BULL.HK');
    if (generation === undefined) throw new Error('production route generation missing');

    await route.processRoute({
      symbol: 'BULL.HK',
      generation,
      wakeupKind: 'TIMER',
      latestQuote: null,
    });

    expect(f.native.nativeMutations()).toEqual([
      {
        kind: 'SUBMIT',
        orderId: null,
        symbol: 'BULL.HK',
        price: null,
        quantity: '100',
        market: true,
        day: true,
      },
    ]);
    expect(acceptedContinuations).toEqual([[f.tracked.orderId, 'FOLLOW-UP']]);
    expect(f.runtime.trackedOrders.has('FOLLOW-UP')).toBe(true);
    expect(f.hold.getHoldSymbols().has('BULL.HK')).toBe(true);
  });
});
