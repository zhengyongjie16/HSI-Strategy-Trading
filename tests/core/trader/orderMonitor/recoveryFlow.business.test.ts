/**
 * orderMonitor/recoveryFlow 业务测试
 *
 * 覆盖：
 * - resetRecoveryTrackingState 会清空 routing index 与 route states
 * - recovery restore 在 BOOTSTRAPPING 期间不触发 TRACKED，恢复成功后仅切换到 ACTIVE，不直接拥有 route bootstrap
 */
import { describe, expect, it } from 'bun:test';
import { Decimal, OrderSide, OrderStatus, OrderType, type Order } from 'longbridge';
import { createOrderRecorder } from '../../../../src/core/orderRecorder/index.js';
import { createRecoveryFlow } from '../../../../src/core/trader/orderMonitor/recoveryFlow.js';
import { createEventFlow } from '../../../../src/core/trader/orderMonitor/eventFlow.js';
import { createPushOrderChanged } from '../../../../mock/factories/tradeFactory.js';
import type {
  OrderMonitorRuntimeStore,
  OrderMonitorTrackedOrder,
} from '../../../../src/core/trader/orderMonitor/types.js';
import type { OrderHoldRegistry, TrackOrderParams } from '../../../../src/core/trader/types.js';
import type { OrderRecorder, RawOrderFromAPI } from '../../../../src/types/services.js';
import type { MonitorConfig } from '../../../../src/types/config.js';
import { createTradingConfig } from '../../../../mock/factories/configFactory.js';
import { attachTrackedOrder } from '../../../../src/core/trader/orderMonitor/routingIndex.js';
import {
  createOrderRecorderDouble,
  createRateLimiterDouble,
  createSymbolRegistryDouble,
  createTradeContextDouble,
} from '../../../helpers/testDoubles.js';
import { createTradeContextMock } from '../../../../mock/longbridge/tradeContextMock.js';

function createRuntimeStore(): OrderMonitorRuntimeStore {
  return {
    trackedOrders: new Map<string, OrderMonitorTrackedOrder>(),
    trackedOrderLifecycles: new Map(),
    bootstrappingOrderEvents: new Map(),
    closedOrderIds: new Set(),
    queriedTerminalStateByOrderId: new Map(),
    latestReplaceOutcomeByOrderId: new Map(),
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
    getHoldSymbols: () => new Set<string>(),
    onOrderHoldSymbolsChanged: () => () => {},
    clear: () => {},
  };
}

function createTrackedOrder(
  orderId: string,
  symbol: string,
  status: OrderStatus = OrderStatus.New,
): OrderMonitorTrackedOrder {
  const now = Date.now();
  return {
    orderId,
    symbol,
    side: OrderSide.Buy,
    isLongSymbol: true,
    monitorSymbol: 'HSI.HK',
    isProtectiveLiquidation: false,
    orderType: OrderType.ELO,
    submittedPrice: 1,
    initialSubmittedPrice: 1,
    submittedQuantity: 100,
    executedQuantity: 0,
    executedPrice: null,
    lastExecutedTimeMs: null,
    lastOrderUpdateAtMs: null,
    status,
    submittedAt: now,
    lastPriceUpdateAt: now,
    convertedToMarket: false,
    nextCancelAttemptAt: now,
    cancelRetryCount: 0,
    replaceCapability: 'SUPPORTED',
    replaceBlockedUntilAt: null,
    quoteRetryAttempts: 0,
    quoteRetryNextAt: null,
    quoteRetryExhausted: false,
    replaceTempBlockedCount: 0,
    replaceResumeMode: 'TIME_BACKOFF',
    timeoutMarketConversionPending: false,
    timeoutMarketConversionTerminalState: null,
  };
}

function createMonitorConfigWithOwnership(): MonitorConfig {
  const monitor = createTradingConfig().monitor;

  return {
    ...monitor,
    orderOwnershipMapping: ['HSI'],
  };
}

function createPendingOrder(params: {
  readonly orderId: string;
  readonly symbol: string;
  readonly side: OrderSide;
  readonly stockName?: string;
  readonly status?: OrderStatus;
  readonly updatedAtMs?: number;
  readonly executedPrice?: number;
  readonly executedQuantity?: number;
}): RawOrderFromAPI {
  return {
    orderId: params.orderId,
    symbol: params.symbol,
    stockName: params.stockName ?? 'HSI RC',
    side: params.side,
    status: params.status ?? OrderStatus.New,
    orderType: OrderType.ELO,
    remark: '',
    price: '1.01',
    quantity: '100',
    executedPrice: String(params.executedPrice ?? 0),
    executedQuantity: String(params.executedQuantity ?? 0),
    submittedAt: new Date('2026-04-08T09:00:00.000Z'),
    updatedAt: new Date(params.updatedAtMs ?? Date.parse('2026-04-08T09:00:00.000Z')),
  };
}

function createSdkPendingSellOrder(params: {
  readonly submittedAt: Date;
  readonly updatedAt: Date;
}): Order {
  // SDK 未公开 Order 构造函数；该 fixture 已覆盖 orderApiManager 消费的完整字段。
  return {
    orderId: 'ORDER-INVALID-SDK-SUBMITTED-AT',
    symbol: 'BULL.HK',
    stockName: 'HSI RC',
    side: OrderSide.Sell,
    status: OrderStatus.New,
    orderType: OrderType.ELO,
    remark: '',
    price: new Decimal('1.01'),
    quantity: new Decimal('100'),
    executedPrice: new Decimal('0'),
    executedQuantity: new Decimal('0'),
    submittedAt: params.submittedAt,
    updatedAt: params.updatedAt,
  } as unknown as Order;
}

const invalidSdkTimestampCases = [
  { label: 'Invalid Date', createDate: () => new Date(Number.NaN) },
  { label: 'epoch timestamp', createDate: () => new Date(0) },
  { label: 'negative timestamp', createDate: () => new Date(-1) },
] as const;

async function assertInvalidSdkTimestampStopsRecovery(params: {
  readonly field: 'submittedAt' | 'updatedAt';
  readonly invalidDate: Date;
}): Promise<void> {
  const runtime = createRuntimeStore();
  const tradeCtx = createTradeContextMock();
  const validSubmittedAt = new Date('2026-04-08T09:00:00.000Z');
  const validUpdatedAt = new Date('2026-04-08T09:01:00.000Z');
  tradeCtx.seedHistoryOrders([]);
  tradeCtx.seedTodayOrders([
    createSdkPendingSellOrder({
      submittedAt: params.field === 'submittedAt' ? params.invalidDate : validSubmittedAt,
      updatedAt: params.field === 'updatedAt' ? params.invalidDate : validUpdatedAt,
    }),
  ]);
  const orderRecorder = createOrderRecorder({
    ctx: createTradeContextDouble(tradeCtx),
    rateLimiter: createRateLimiterDouble(),
  });
  let trackCalls = 0;
  let pendingSellCalls = 0;
  const observedOrderRecorder: OrderRecorder = {
    ...orderRecorder,
    submitSellOrder: (...submitParams) => {
      pendingSellCalls += 1;
      orderRecorder.submitSellOrder(...submitParams);
    },
  };
  const recoveryFlow = createRecoveryFlow({
    runtime,
    orderHoldRegistry: createOrderHoldRegistry(),
    orderRecorder: observedOrderRecorder,
    tradingConfig: createTradingConfig({ monitor: createMonitorConfigWithOwnership() }),
    symbolRegistry: createSymbolRegistryDouble(),
    trackOrder: (trackParams) => {
      trackCalls += 1;
      runtime.trackedOrders.set(
        trackParams.orderId,
        createTrackedOrder(trackParams.orderId, trackParams.symbol, trackParams.initialStatus),
      );
      attachTrackedOrder(runtime, trackParams.symbol, trackParams.orderId);
    },
    cancelOrder: async () => ({
      kind: 'CANCEL_CONFIRMED',
      closedReason: 'CANCELED',
      source: 'API',
      relatedBuyOrderIds: null,
    }),
    settleOrder: () => ({ handled: true, relatedBuyOrderIds: null }),
    handleOrderChangedWhenActive: () => {},
  });
  const originalNow = Date.now;
  let dateNowCalls = 0;
  Date.now = () => {
    dateNowCalls += 1;
    return Date.parse('2026-04-08T09:00:00.000Z');
  };
  let caught: unknown = null;

  try {
    const allOrders = await orderRecorder.fetchAllOrdersFromAPI(true);
    await recoveryFlow.recoverOrderTrackingFromSnapshot(allOrders);
  } catch (error) {
    caught = error;
  } finally {
    Date.now = originalNow;
  }

  expect(caught).toBeInstanceOf(TypeError);
  if (!(caught instanceof Error)) {
    throw new Error('expected API boundary failure');
  }

  expect(caught.message).toContain('TradeContext.todayOrders 订单数据结构无效');
  expect(trackCalls).toBe(0);
  expect(runtime.trackedOrders.size).toBe(0);
  expect(runtime.trackedOrderIdsBySymbol.size).toBe(0);
  expect(pendingSellCalls).toBe(0);
  expect(orderRecorder.getPendingSellSnapshot()).toEqual([]);
  expect(dateNowCalls).toBe(0);
}

describe('orderMonitor recoveryFlow', () => {
  for (const field of ['submittedAt', 'updatedAt'] as const) {
    for (const invalidTimestampCase of invalidSdkTimestampCases) {
      it(`rejects invalid SDK ${field} (${invalidTimestampCase.label}) before recovery tracks or creates a pending sell`, async () => {
        await assertInvalidSdkTimestampStopsRecovery({
          field,
          invalidDate: invalidTimestampCase.createDate(),
        });
      });
    }
  }

  it('恢复 qty=0 订单仍保留 order updatedAt，并拒绝更旧 WS 覆盖', async () => {
    const runtime = createRuntimeStore();
    const snapshotUpdatedAtMs = Date.parse('2026-04-08T09:00:00.200Z');
    const recoveryFlow = createRecoveryFlow({
      runtime,
      orderHoldRegistry: createOrderHoldRegistry(),
      orderRecorder: createOrderRecorderDouble(),
      tradingConfig: createTradingConfig({ monitor: createMonitorConfigWithOwnership() }),
      symbolRegistry: createSymbolRegistryDouble(),
      trackOrder: (params) => {
        runtime.trackedOrders.set(
          params.orderId,
          createTrackedOrder(params.orderId, params.symbol, params.initialStatus),
        );
        attachTrackedOrder(runtime, params.symbol, params.orderId);
      },
      cancelOrder: async () => ({
        kind: 'CANCEL_CONFIRMED',
        closedReason: 'CANCELED',
        source: 'API',
        relatedBuyOrderIds: null,
      }),
      settleOrder: () => ({ handled: true, relatedBuyOrderIds: null }),
      handleOrderChangedWhenActive: () => {},
    });
    await recoveryFlow.recoverOrderTrackingFromSnapshot([
      createPendingOrder({
        orderId: 'ORDER-RECOVER-UPDATED-AT',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
        status: OrderStatus.PendingReplace,
        updatedAtMs: snapshotUpdatedAtMs,
      }),
    ]);
    const trackedOrder = runtime.trackedOrders.get('ORDER-RECOVER-UPDATED-AT');
    if (!trackedOrder) {
      throw new Error('expected recovered tracked order');
    }

    const eventFlow = createEventFlow({
      runtime,
      orderRecorder: createOrderRecorderDouble(),
      recordCumulativeExecution: () => {},
      prepareProtectiveTerminalExecution: () => null,
      settleOrder: () => ({ handled: false, relatedBuyOrderIds: null }),
      cacheBootstrappingEvent: () => {},
      triggerRoute: () => {},
    });
    eventFlow.handleOrderChangedWhenActive(
      createPushOrderChanged({
        orderId: trackedOrder.orderId,
        symbol: trackedOrder.symbol,
        side: trackedOrder.side,
        status: OrderStatus.New,
        updatedAtMs: snapshotUpdatedAtMs - 100,
      }),
    );

    expect(trackedOrder.status).toBe(OrderStatus.PendingReplace);
    expect(trackedOrder.lastOrderUpdateAtMs).toBe(snapshotUpdatedAtMs);
    expect(trackedOrder.lastExecutedTimeMs).toBeNull();
  });

  it('将四种 NotReported 开放状态全部恢复为 tracked order', async () => {
    const runtime = createRuntimeStore();
    const trackCalls: Array<Readonly<{ orderId: string; status: OrderStatus | undefined }>> = [];
    const recoveryFlow = createRecoveryFlow({
      runtime,
      orderHoldRegistry: createOrderHoldRegistry(),
      orderRecorder: createOrderRecorderDouble(),
      tradingConfig: createTradingConfig({ monitor: createMonitorConfigWithOwnership() }),
      symbolRegistry: createSymbolRegistryDouble(),
      trackOrder: (params) => {
        trackCalls.push({ orderId: params.orderId, status: params.initialStatus });
        runtime.trackedOrders.set(
          params.orderId,
          createTrackedOrder(params.orderId, params.symbol),
        );
        attachTrackedOrder(runtime, params.symbol, params.orderId);
      },
      cancelOrder: async () => ({
        kind: 'CANCEL_CONFIRMED',
        closedReason: 'CANCELED',
        source: 'API',
        relatedBuyOrderIds: null,
      }),
      settleOrder: () => ({ handled: true, relatedBuyOrderIds: null }),
      handleOrderChangedWhenActive: () => {},
    });
    const statuses: ReadonlyArray<OrderStatus> = [
      OrderStatus.NotReported,
      OrderStatus.ReplacedNotReported,
      OrderStatus.ProtectedNotReported,
      OrderStatus.VarietiesNotReported,
    ];

    await recoveryFlow.recoverOrderTrackingFromSnapshot(
      statuses.map((status, index) =>
        createPendingOrder({
          orderId: `ORDER-NOT-REPORTED-${index}`,
          symbol: 'BULL.HK',
          side: OrderSide.Sell,
          status,
        }),
      ),
    );

    expect(trackCalls.map((call) => call.status)).toEqual([...statuses]);
  });

  it('resetRecoveryTrackingState 会清空 symbol 索引与 route states', () => {
    const runtime = createRuntimeStore();
    runtime.trackedOrders.set('ORDER-1', createTrackedOrder('ORDER-1', 'BULL.HK'));
    runtime.trackedOrderIdsBySymbol.set('BULL.HK', new Set(['ORDER-1']));
    runtime.routeStatesBySymbol.set('BULL.HK', {
      symbol: 'BULL.HK',
      generation: 1,
      inFlight: false,
      dirty: false,
      latestQuote: null,
      pendingWakeupKind: null,
      timerHandles: new Map(),
    });
    const recoveryFlow = createRecoveryFlow({
      runtime,
      orderHoldRegistry: createOrderHoldRegistry(),
      orderRecorder: createOrderRecorderDouble(),
      tradingConfig: createTradingConfig({
        monitor: createMonitorConfigWithOwnership(),
      }),
      symbolRegistry: createSymbolRegistryDouble(),
      trackOrder: (params: TrackOrderParams) => {
        runtime.trackedOrders.set(
          params.orderId,
          createTrackedOrder(params.orderId, params.symbol),
        );
        attachTrackedOrder(runtime, params.symbol, params.orderId);
      },
      cancelOrder: async () => ({
        kind: 'CANCEL_CONFIRMED',
        closedReason: 'CANCELED',
        source: 'API',
        relatedBuyOrderIds: null,
      }),
      settleOrder: () => ({ handled: true, relatedBuyOrderIds: null }),
      handleOrderChangedWhenActive: () => {},
    });

    recoveryFlow.resetRecoveryTrackingState();

    expect(runtime.trackedOrderIdsBySymbol.size).toBe(0);
    expect(runtime.routeStatesBySymbol.size).toBe(0);
  });

  it('恢复期间不触发 TRACKED，恢复成功后只切换到 ACTIVE', async () => {
    const runtime = createRuntimeStore();
    const trackCalls: string[] = [];
    const recoveryFlow = createRecoveryFlow({
      runtime,
      orderHoldRegistry: createOrderHoldRegistry(),
      orderRecorder: createOrderRecorderDouble(),
      tradingConfig: createTradingConfig({
        monitor: createMonitorConfigWithOwnership(),
      }),
      symbolRegistry: createSymbolRegistryDouble(),
      trackOrder: (params: TrackOrderParams) => {
        trackCalls.push(params.orderId);
        runtime.trackedOrders.set(
          params.orderId,
          createTrackedOrder(params.orderId, params.symbol),
        );
        attachTrackedOrder(runtime, params.symbol, params.orderId);
      },
      cancelOrder: async () => ({
        kind: 'CANCEL_CONFIRMED',
        closedReason: 'CANCELED',
        source: 'API',
        relatedBuyOrderIds: null,
      }),
      settleOrder: () => ({ handled: true, relatedBuyOrderIds: null }),
      handleOrderChangedWhenActive: () => {},
    });

    await recoveryFlow.recoverOrderTrackingFromSnapshot([
      createPendingOrder({ orderId: 'ORDER-1', symbol: 'BULL.HK', side: OrderSide.Buy }),
      createPendingOrder({ orderId: 'ORDER-2', symbol: 'BULL.HK', side: OrderSide.Sell }),
    ]);

    expect(trackCalls).toEqual(['ORDER-1', 'ORDER-2']);
    expect(runtime.runtimeState).toBe('ACTIVE');
  });

  it('恢复快照的累计成交量超过委托量时不创建跟踪或 pending sell 占用', async () => {
    const runtime = createRuntimeStore();
    let trackCalls = 0;
    let pendingSellCalls = 0;
    const recorder = createOrderRecorderDouble({
      submitSellOrder: () => {
        pendingSellCalls += 1;
      },
    });
    const recoveryFlow = createRecoveryFlow({
      runtime,
      orderHoldRegistry: createOrderHoldRegistry(),
      orderRecorder: recorder,
      tradingConfig: createTradingConfig({ monitor: createMonitorConfigWithOwnership() }),
      symbolRegistry: createSymbolRegistryDouble(),
      trackOrder: (params) => {
        trackCalls += 1;
        runtime.trackedOrders.set(
          params.orderId,
          createTrackedOrder(params.orderId, params.symbol, params.initialStatus),
        );
        attachTrackedOrder(runtime, params.symbol, params.orderId);
      },
      cancelOrder: async () => ({
        kind: 'CANCEL_CONFIRMED',
        closedReason: 'CANCELED',
        source: 'API',
        relatedBuyOrderIds: null,
      }),
      settleOrder: () => ({ handled: true, relatedBuyOrderIds: null }),
      handleOrderChangedWhenActive: () => {},
    });

    await expect(
      recoveryFlow.recoverOrderTrackingFromSnapshot([
        createPendingOrder({
          orderId: 'ORDER-RECOVER-EXCEEDS-SUBMITTED',
          symbol: 'BULL.HK',
          side: OrderSide.Sell,
          executedPrice: 1.02,
          executedQuantity: 101,
        }),
      ]),
    ).rejects.toThrow(/累计成交量超过有效委托数量/);

    expect(trackCalls).toBe(0);
    expect(pendingSellCalls).toBe(0);
    expect(runtime.trackedOrders.size).toBe(0);
    expect(runtime.runtimeState).toBe('STOPPED');
  });

  it('blocks recovery when mismatched pending buy terminal state contains executed quantity', async () => {
    const runtime = createRuntimeStore();
    const recoveryFlow = createRecoveryFlow({
      runtime,
      orderHoldRegistry: createOrderHoldRegistry(),
      orderRecorder: createOrderRecorderDouble(),
      tradingConfig: createTradingConfig({
        monitor: createMonitorConfigWithOwnership(),
      }),
      symbolRegistry: createSymbolRegistryDouble(),
      trackOrder: () => {},
      cancelOrder: async () => {
        runtime.queriedTerminalStateByOrderId.set('ORDER-MISMATCHED-FILLED', {
          kind: 'TERMINAL',
          closedReason: 'FILLED',
          executedPrice: 1.02,
          executedQuantity: 100,
          submittedQuantity: 100,
          orderUpdatedAtMs: Date.parse('2026-04-08T09:01:00.000Z'),
          status: OrderStatus.Filled,
        });
        return {
          kind: 'ALREADY_CLOSED',
          closedReason: 'FILLED',
          source: 'API_ERROR',
          relatedBuyOrderIds: null,
          terminalExecution: {
            submittedQuantity: 100,
            executedQuantity: 100,
          },
        };
      },
      settleOrder: () => {
        throw new Error('mismatched filled buy must not settle');
      },
      handleOrderChangedWhenActive: () => {},
    });

    try {
      await recoveryFlow.recoverOrderTrackingFromSnapshot([
        createPendingOrder({
          orderId: 'ORDER-MISMATCHED-FILLED',
          symbol: 'OLD_BULL.HK',
          side: OrderSide.Buy,
        }),
      ]);
      throw new Error('expected recovery to reject');
    } catch (error) {
      expect((error as Error).message).toMatch(/不匹配但.*存在成交事实/);
    }

    expect(runtime.runtimeState).toBe('STOPPED');
  });

  it('不匹配买单的启动快照已知部分成交时不得被陈旧零成交终态安全收口', async () => {
    const runtime = createRuntimeStore();
    const recoveryFlow = createRecoveryFlow({
      runtime,
      orderHoldRegistry: createOrderHoldRegistry(),
      orderRecorder: createOrderRecorderDouble(),
      tradingConfig: createTradingConfig({ monitor: createMonitorConfigWithOwnership() }),
      symbolRegistry: createSymbolRegistryDouble(),
      trackOrder: () => {},
      cancelOrder: async () => {
        runtime.queriedTerminalStateByOrderId.set('ORDER-MISMATCHED-SNAPSHOT-PARTIAL', {
          kind: 'TERMINAL',
          closedReason: 'CANCELED',
          executedPrice: null,
          executedQuantity: 0,
          submittedQuantity: 100,
          orderUpdatedAtMs: Date.parse('2026-04-08T09:00:00.100Z'),
          status: OrderStatus.Canceled,
        });
        return {
          kind: 'ALREADY_CLOSED',
          closedReason: 'CANCELED',
          source: 'API_ERROR',
          relatedBuyOrderIds: null,
          terminalExecution: {
            submittedQuantity: 100,
            executedQuantity: 0,
          },
        };
      },
      settleOrder: () => {
        throw new Error('mismatched partially-filled buy must not settle');
      },
      handleOrderChangedWhenActive: () => {},
    });

    expect(
      recoveryFlow.recoverOrderTrackingFromSnapshot([
        createPendingOrder({
          orderId: 'ORDER-MISMATCHED-SNAPSHOT-PARTIAL',
          symbol: 'OLD_BULL.HK',
          side: OrderSide.Buy,
          executedPrice: 1.05,
          executedQuantity: 30,
          updatedAtMs: Date.parse('2026-04-08T09:00:00.200Z'),
        }),
      ]),
    ).rejects.toThrow(/不匹配但.*存在成交事实/);
    expect(runtime.runtimeState).toBe('STOPPED');
  });
});
