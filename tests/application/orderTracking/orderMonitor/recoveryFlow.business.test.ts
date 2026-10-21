import {
  createLoggerDouble,
  createOrderRecorderDouble,
  createRateLimiterDouble,
  createSymbolRegistryDouble,
} from '../../../helpers/testDoubles.js';

/**
 * orderMonitor/recoveryFlow 业务测试
 *
 * 覆盖：
 * - resetRecoveryTrackingState 会清空 routing index 与 route states
 * - recovery restore 在 BOOTSTRAPPING 期间不触发 TRACKED，恢复成功后仅切换到 ACTIVE，不直接拥有 route bootstrap
 */

import { describe, expect, it } from 'bun:test';
import { createDiagnosticObserverDouble } from '../../../helpers/diagnostics.js';
import { createTradingConfig } from '../../../../mock/factories/configFactory.js';
import { createTerminationRuntime } from '../../../../src/runtime/lifecycle/terminationRuntime.js';
import { createEventFlow as createProductionEventFlow } from '../../../../src/application/orderTracking/orderMonitor/eventFlow.js';
import { createRecoveryFlow as createProductionRecoveryFlow } from '../../../../src/application/orderTracking/orderMonitor/recoveryFlow.js';
import { attachTrackedOrder } from '../../../../src/application/orderTracking/orderMonitor/routingIndex.js';
import type {
  EventFlowDeps,
  OrderMonitorRuntimeStore,
  RecoveryFlowDeps,
} from '../../../../src/application/orderTracking/orderMonitor/types.js';
import type { OrderHoldRegistry } from '../../../../src/application/orderTracking/types.js';
import type {
  OrderMonitorTrackedOrder,
  TrackOrderParams,
} from '../../../../src/domain/order/types.js';
import type { MonitorConfig } from '../../../../src/types/config.js';
import type { OrderReadStatus } from '../../../../src/types/orderReadMetadata.js';
import type { OrderRecorder } from '../../../../src/types/orderRecorder.js';
import type { OrderFact } from '../../../../src/types/trade.js';
import { createExternalApiRequestError } from '../../../helpers/createExternalApiRequestError.js';

import { createBrokerIngressFixture } from '../../../integration/architectureRefactoringP1Native/trade/brokerIngressFixture.js';

type TestEventFlowDeps = Omit<EventFlowDeps, 'now' | 'monitorConfig' | 'diagnostics'> &
  Partial<Pick<EventFlowDeps, 'now' | 'monitorConfig' | 'diagnostics'>>;

type TestRecoveryFlowDeps = Omit<RecoveryFlowDeps, 'now' | 'diagnostics'> &
  Partial<Pick<RecoveryFlowDeps, 'now' | 'diagnostics'>>;

function createRecoveryFlow(deps: TestRecoveryFlowDeps) {
  return createProductionRecoveryFlow({
    diagnostics: createDiagnosticObserverDouble(),
    now: () => new Date('2031-01-02T03:04:05.000Z'),
    ...deps,
  });
}

function createEventFlow(deps: TestEventFlowDeps) {
  return createProductionEventFlow({
    diagnostics: createDiagnosticObserverDouble(),
    now: () => new Date('2031-01-02T03:04:05.000Z'),
    ...deps,
    monitorConfig: deps.monitorConfig ?? createMonitorConfigWithOwnership(),
  });
}

function createRuntimeStore(): OrderMonitorRuntimeStore {
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
    getHoldSymbols: () => new Set<string>(),
    onOrderHoldSymbolsChanged: () => () => {},
    clear: () => {},
  };
}

const trackedFixtureFacts = new Map<string, OrderFact>();

function createTrackedOrder(
  orderId: string,
  symbol: string,
  status: OrderReadStatus = 'WORKING',
): OrderMonitorTrackedOrder {
  const now = Date.now();
  const original = trackedFixtureFacts.get(orderId);
  if (original === undefined)
    throw new Error('tracked recovery fixture must bind actual mapper fact');

  return {
    orderId,
    symbol,
    side: original.executionSide,
    executionSide: original.executionSide,
    executionPhase: original.executionPhase,
    isLongSymbol: true,
    monitorSymbol: 'HSI.HK',
    isProtectiveLiquidation: false,
    orderType: original.orderType,
    submittedPrice: '1',
    initialSubmittedPrice: '1',
    submittedQuantity: 100,
    executedQuantity: 0,
    executedPrice: null,
    executedAmount: '0',
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

const fixtureStatusNames: ReadonlyMap<
  OrderReadStatus,
  Parameters<typeof createBrokerIngressFixture>[0]['status']
> = new Map([
  ['WORKING', 'New'],
  ['REPLACEMENT_PENDING', 'PendingReplace'],
  ['UNREPORTED', 'NotReported'],
  ['REPLACEMENT_UNREPORTED', 'ReplacedNotReported'],
  ['PROTECTION_UNREPORTED', 'ProtectedNotReported'],
  ['CONDITIONAL_UNREPORTED', 'VarietiesNotReported'],
  ['FILLED', 'Filled'],
  ['CANCELED', 'Canceled'],
]);
async function createPendingOrder(params: {
  readonly orderId: string;
  readonly symbol: string;
  readonly side: 'BUY' | 'SELL';
  readonly stockName?: string;
  readonly status?: OrderReadStatus;
  readonly orderType?: 'ELO' | 'MO';
  readonly price?: string | null;
  readonly updatedAtMs?: number;
  readonly executedPrice?: string;
  readonly executedQuantity?: number;
}): Promise<OrderFact> {
  const status = fixtureStatusNames.get(params.status ?? 'WORKING');
  if (status === undefined) throw new TypeError('unsupported recovery fixture status');

  const now = Date.parse('2026-04-08T09:00:00.000Z');
  const frame = {
    orderId: params.orderId,
    symbol: params.symbol,
    stockName: params.stockName ?? 'HSI RC',
    remark: '',
    side: params.side,
    status,
    orderType: params.orderType ?? 'ELO',
    quantity: '100',
    executedQuantity: String(params.executedQuantity ?? 0),
    submittedPrice: params.price ?? '1.01',
    executedPrice: params.executedPrice ?? '0',
    submittedAtMs: now,
    updatedAtMs: params.updatedAtMs ?? now,
  };
  const native = await createBrokerIngressFixture({
    ...frame,
    status: 'New',
    executedQuantity: '0',
    executedPrice: '0',
  });
  native.setOrderSnapshotReplies([], [frame]);
  if (params.price === null) native.setOrderSnapshotSubmittedPriceNull(params.orderId);

  const settlementRefreshNeeds: unknown[] = [];
  const reader = native.createRecorder({
    logger: createLoggerDouble(),
    rateLimiter: createRateLimiterDouble(),
    settlementRefreshNeedRecorder: {
      recordSettlementRefreshNeed: (need) => {
        settlementRefreshNeeds.push(need);
      },
    },
  });
  const orders = await reader.fetchAllOrdersFromAPI();
  if (settlementRefreshNeeds.length > 0)
    throw new Error('snapshot read must not issue settlement refresh');

  const fact = orders[0];
  if (fact === undefined) throw new Error('expected original recovery snapshot identity');

  trackedFixtureFacts.set(fact.orderId, fact);
  return fact;
}

async function createNativeRecoveryEvent(
  input: Readonly<{
    orderId: string;
    symbol: string;
    side: 'BUY' | 'SELL';
    status: OrderReadStatus;
    updatedAtMs?: number;
  }>,
): Promise<OrderFact> {
  const status = fixtureStatusNames.get(input.status);
  if (status === undefined) throw new TypeError('unsupported native recovery event status');

  const atMs = input.updatedAtMs ?? Date.parse('2026-04-08T09:00:00.000Z');
  const native = await createBrokerIngressFixture({
    orderId: input.orderId,
    symbol: input.symbol,
    stockName: input.symbol,
    remark: '',
    side: input.side,
    status,
    orderType: 'ELO',
    quantity: '100',
    executedQuantity: '0',
    submittedPrice: '1.01',
    executedPrice: '0',
    submittedAtMs: atMs,
    updatedAtMs: atMs,
  });
  const observations: OrderFact[] = [];
  const port = native.createPushPort();
  port.setOnOrderChanged((error, decoder) => {
    if (error !== null) throw error;

    const observation = decoder.decode();
    if (observation !== null) observations.push(observation);
  });
  native.emitOrderChanged();
  const observation = observations[0];
  if (observation === undefined) throw new Error('native recovery event did not dispatch');

  return observation;
}

async function createRecoveryRecorder(): Promise<OrderRecorder> {
  const atMs = Date.parse('2026-04-08T09:00:00.000Z');
  const native = await createBrokerIngressFixture({
    orderId: 'RECOVERY-OWNER',
    symbol: 'BULL.HK',
    stockName: 'HSI RC',
    remark: '',
    side: 'BUY',
    orderType: 'ELO',
    status: 'New',
    quantity: '100',
    executedQuantity: '0',
    submittedPrice: '1.01',
    executedPrice: '0',
    submittedAtMs: atMs,
    updatedAtMs: atMs,
  });
  const settlementRefreshNeeds: unknown[] = [];
  const recorder = native.createRecorder({
    logger: createLoggerDouble(),
    rateLimiter: createRateLimiterDouble(),
    settlementRefreshNeedRecorder: {
      recordSettlementRefreshNeed: (need) => {
        settlementRefreshNeeds.push(need);
      },
    },
  });
  return Object.assign(recorder, { settlementRefreshNeeds });
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
  const validSubmittedAt = Date.parse('2026-04-08T09:00:00.000Z');
  const validUpdatedAt = Date.parse('2026-04-08T09:01:00.000Z');
  const base = {
    orderId: 'ORDER-INVALID-SDK-SUBMITTED-AT',
    symbol: 'BULL.HK',
    stockName: 'HSI RC',
    remark: '',
    side: 'SELL' as const,
    orderType: 'ELO' as const,
    status: 'New' as const,
    quantity: '100',
    executedQuantity: '0',
    submittedPrice: '1.01',
    executedPrice: '0',
    submittedAtMs: validSubmittedAt,
    updatedAtMs: validUpdatedAt,
  };
  const native = await createBrokerIngressFixture(base);
  native.setOrderSnapshotReplies(
    [],
    [
      {
        ...base,
        submittedAtMs:
          params.field === 'submittedAt' ? params.invalidDate.getTime() : validSubmittedAt,
        updatedAtMs: params.field === 'updatedAt' ? params.invalidDate.getTime() : validUpdatedAt,
      },
    ],
  );
  const settlementRefreshNeeds: unknown[] = [];
  const orderRecorder = native.createRecorder({
    logger: createLoggerDouble(),
    rateLimiter: createRateLimiterDouble(),
    settlementRefreshNeedRecorder: {
      recordSettlementRefreshNeed: (need) => {
        settlementRefreshNeeds.push(need);
      },
    },
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
    logger: createLoggerDouble(),
    termination: { isTerminated: () => false, reportFatalError: () => {} },
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
    const allOrders = await orderRecorder.fetchAllOrdersFromAPI();
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

  expect(caught.message).toBe('[订单记录] TradeContext.todayOrders 订单数据结构无效');
  expect(trackCalls).toBe(0);
  expect(runtime.trackedOrders.size).toBe(0);
  expect(runtime.trackedOrderIdsBySymbol.size).toBe(0);
  expect(pendingSellCalls).toBe(0);
  expect(orderRecorder.getPendingSellSnapshot()).toEqual([]);
  expect(dateNowCalls).toBe(0);
  expect(settlementRefreshNeeds).toHaveLength(0);
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
      logger: createLoggerDouble(),
      termination: { isTerminated: () => false, reportFatalError: () => {} },
      runtime,
      orderHoldRegistry: createOrderHoldRegistry(),
      orderRecorder: await createRecoveryRecorder(),
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
        relatedBuyOrderIds: null,
      }),
      settleOrder: () => ({ handled: true, relatedBuyOrderIds: null }),
      handleOrderChangedWhenActive: () => {},
    });
    await recoveryFlow.recoverOrderTrackingFromSnapshot([
      await createPendingOrder({
        orderId: 'ORDER-RECOVER-UPDATED-AT',
        symbol: 'BULL.HK',
        side: 'BUY',
        status: 'REPLACEMENT_PENDING',
        updatedAtMs: snapshotUpdatedAtMs,
      }),
    ]);
    const trackedOrder = runtime.trackedOrders.get('ORDER-RECOVER-UPDATED-AT');
    if (!trackedOrder) {
      throw new Error('expected recovered tracked order');
    }

    const eventFlow = createEventFlow({
      logger: createLoggerDouble(),
      runtime,
      orderRecorder: await createRecoveryRecorder(),
      recordCumulativeExecution: () => {},
      prepareProtectiveTerminalExecution: () => null,
      settleOrder: () => ({ handled: false, relatedBuyOrderIds: null }),
      cacheBootstrappingEvent: () => {},
      triggerRoute: () => {},
    });
    eventFlow.handleOrderChangedWhenActive(
      await createNativeRecoveryEvent({
        orderId: trackedOrder.orderId,
        symbol: trackedOrder.symbol,
        side: trackedOrder.side,
        status: 'WORKING',
        updatedAtMs: snapshotUpdatedAtMs - 100,
      }),
    );

    expect(trackedOrder.status).toBe('REPLACEMENT_PENDING');
    expect(trackedOrder.lastOrderUpdateAtMs).toBe(snapshotUpdatedAtMs);
    expect(trackedOrder.lastExecutedTimeMs).toBeNull();
  });

  it('将四种 NotReported 开放状态全部恢复为 tracked order', async () => {
    const runtime = createRuntimeStore();
    const trackCalls: Array<Readonly<{ orderId: string; status: OrderReadStatus | undefined }>> =
      [];
    const recoveryFlow = createRecoveryFlow({
      logger: createLoggerDouble(),
      termination: { isTerminated: () => false, reportFatalError: () => {} },
      runtime,
      orderHoldRegistry: createOrderHoldRegistry(),
      orderRecorder: await createRecoveryRecorder(),
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
        relatedBuyOrderIds: null,
      }),
      settleOrder: () => ({ handled: true, relatedBuyOrderIds: null }),
      handleOrderChangedWhenActive: () => {},
    });
    const statuses: ReadonlyArray<OrderReadStatus> = [
      'UNREPORTED',
      'REPLACEMENT_UNREPORTED',
      'PROTECTION_UNREPORTED',
      'CONDITIONAL_UNREPORTED',
    ];

    await recoveryFlow.recoverOrderTrackingFromSnapshot(
      await Promise.all(
        statuses.map((status, index) =>
          createPendingOrder({
            orderId: `ORDER-NOT-REPORTED-${index}`,
            symbol: 'BULL.HK',
            side: 'SELL',
            status,
          }),
        ),
      ),
    );

    expect(trackCalls.map((call) => call.status)).toEqual([...statuses]);
  });

  it('恢复市价挂单时保留 nullable 委托价，不伪造零价格', async () => {
    const runtime = createRuntimeStore();
    const trackCalls: TrackOrderParams[] = [];
    const recoveryFlow = createRecoveryFlow({
      logger: createLoggerDouble(),
      termination: { isTerminated: () => false, reportFatalError: () => {} },
      runtime,
      orderHoldRegistry: createOrderHoldRegistry(),
      orderRecorder: await createRecoveryRecorder(),
      tradingConfig: createTradingConfig({ monitor: createMonitorConfigWithOwnership() }),
      symbolRegistry: createSymbolRegistryDouble(),
      trackOrder: (params) => {
        trackCalls.push(params);
        const trackedOrder = createTrackedOrder(
          params.orderId,
          params.symbol,
          params.initialStatus,
        );
        trackedOrder.submittedPrice = params.price;
        runtime.trackedOrders.set(params.orderId, trackedOrder);
        attachTrackedOrder(runtime, params.symbol, params.orderId);
      },
      cancelOrder: async () => ({
        kind: 'CANCEL_CONFIRMED',
        relatedBuyOrderIds: null,
      }),
      settleOrder: () => ({ handled: true, relatedBuyOrderIds: null }),
      handleOrderChangedWhenActive: () => {},
    });

    await recoveryFlow.recoverOrderTrackingFromSnapshot([
      await createPendingOrder({
        orderId: 'ORDER-MARKET',
        symbol: 'BULL.HK',
        side: 'BUY',
        orderType: 'MO',
        price: null,
      }),
    ]);

    expect(trackCalls).toHaveLength(1);
    expect(trackCalls[0]?.price).toBeNull();
    expect(trackCalls[0]?.initialSubmittedPrice).toBeNull();
    expect(trackCalls[0]?.orderType).toBe('MO');
  });

  it('恢复非市价空价卖单时在 track、pendingSell 与 route 副作用前 fail-fast', async () => {
    const runtime = createRuntimeStore();
    let trackCalls = 0;
    let pendingSellAllocationCalls = 0;
    let pendingSellSubmitCalls = 0;
    let routeCalls = 0;
    const recoveryFlow = createRecoveryFlow({
      logger: createLoggerDouble(),
      termination: { isTerminated: () => false, reportFatalError: () => {} },
      runtime,
      orderHoldRegistry: createOrderHoldRegistry(),
      orderRecorder: createOrderRecorderDouble({
        allocateRelatedBuyOrderIdsForRecovery: () => {
          pendingSellAllocationCalls += 1;
          return [];
        },
        submitSellOrder: () => {
          pendingSellSubmitCalls += 1;
        },
      }),
      tradingConfig: createTradingConfig({ monitor: createMonitorConfigWithOwnership() }),
      symbolRegistry: createSymbolRegistryDouble(),
      trackOrder: () => {
        trackCalls += 1;
      },
      cancelOrder: async () => ({
        kind: 'CANCEL_CONFIRMED',
        relatedBuyOrderIds: null,
      }),
      settleOrder: () => ({ handled: true, relatedBuyOrderIds: null }),
      handleOrderChangedWhenActive: () => {
        routeCalls += 1;
      },
    });
    recoveryFlow.cacheBootstrappingEvent(
      await createNativeRecoveryEvent({
        orderId: 'ORDER-BUFFERED',
        symbol: 'BULL.HK',
        side: 'BUY',
        status: 'WORKING',
      }),
    );

    let caught: unknown = null;
    try {
      await recoveryFlow.recoverOrderTrackingFromSnapshot([
        await createPendingOrder({
          orderId: 'ORDER-NON-MARKET-NULL-PRICE',
          symbol: 'BULL.HK',
          side: 'SELL',
          orderType: 'ELO',
          price: null,
        }),
      ]);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe(
      '[订单监控] 非市价订单 ORDER-NON-MARKET-NULL-PRICE 缺少委托价格，无法恢复追踪',
    );
    expect(trackCalls).toBe(0);
    expect(pendingSellAllocationCalls).toBe(0);
    expect(pendingSellSubmitCalls).toBe(0);
    expect(routeCalls).toBe(0);
    expect(runtime.trackedOrders.size).toBe(0);
    expect(runtime.trackedOrderIdsBySymbol.size).toBe(0);
    expect(runtime.bootstrappingOrderEvents.size).toBe(0);
    expect(runtime.runtimeState).toBe('STOPPED');
  });

  it('resetRecoveryTrackingState 会清空 symbol 索引与 route states', async () => {
    const runtime = createRuntimeStore();
    await createPendingOrder({ orderId: 'ORDER-1', symbol: 'BULL.HK', side: 'BUY' });
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
      logger: createLoggerDouble(),
      termination: { isTerminated: () => false, reportFatalError: () => {} },
      runtime,
      orderHoldRegistry: createOrderHoldRegistry(),
      orderRecorder: await createRecoveryRecorder(),
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
      logger: createLoggerDouble(),
      termination: { isTerminated: () => false, reportFatalError: () => {} },
      runtime,
      orderHoldRegistry: createOrderHoldRegistry(),
      orderRecorder: await createRecoveryRecorder(),
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
        relatedBuyOrderIds: null,
      }),
      settleOrder: () => ({ handled: true, relatedBuyOrderIds: null }),
      handleOrderChangedWhenActive: () => {},
    });

    await recoveryFlow.recoverOrderTrackingFromSnapshot([
      await createPendingOrder({ orderId: 'ORDER-1', symbol: 'BULL.HK', side: 'BUY' }),
      await createPendingOrder({ orderId: 'ORDER-2', symbol: 'BULL.HK', side: 'SELL' }),
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
      logger: createLoggerDouble(),
      termination: { isTerminated: () => false, reportFatalError: () => {} },
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
        relatedBuyOrderIds: null,
      }),
      settleOrder: () => ({ handled: true, relatedBuyOrderIds: null }),
      handleOrderChangedWhenActive: () => {},
    });

    const originalFact = await createPendingOrder({
      orderId: 'ORDER-RECOVER-EXCEEDS-SUBMITTED',
      symbol: 'BULL.HK',
      side: 'SELL',
      executedPrice: '1.02',
      executedQuantity: 100,
    });
    // This unit deliberately corrupts an internal contract copy, not the SDK frame or mapper output.
    const corruptedInternalFact: OrderFact = Object.freeze({
      ...originalFact,
      executedQuantity: 101,
    });
    expect(originalFact.quantity).toBe(100);
    expect(originalFact.executedQuantity).toBe(100);
    expect(runtime.runtimeState).toBe('ACTIVE');
    const originalNow = Date.now;
    let dateNowCalls = 0;
    Date.now = () => {
      dateNowCalls += 1;
      return originalNow();
    };
    let recoveryFailure: unknown;
    try {
      recoveryFailure = await recoveryFlow
        .recoverOrderTrackingFromSnapshot([corruptedInternalFact])
        .then(
          () => null,
          (error: unknown) => error,
        );
    } finally {
      Date.now = originalNow;
    }

    expect(recoveryFailure).toBeInstanceOf(Error);
    if (!(recoveryFailure instanceof Error)) throw new Error('expected internal recovery failure');

    expect(recoveryFailure.message).toMatch(/累计成交量超过有效委托数量/);
    expect(dateNowCalls).toBe(0);
    expect(originalFact.executedQuantity).toBe(100);
    expect(corruptedInternalFact.executedPrice).toBe('1.02');
    expect(corruptedInternalFact.executionTimeMs).toBe(originalFact.executionTimeMs);
    expect(corruptedInternalFact.updatedAtMs).toBe(originalFact.updatedAtMs);
    expect(runtime.trackedOrderIdsBySymbol.size).toBe(0);

    expect(trackCalls).toBe(0);
    expect(pendingSellCalls).toBe(0);
    expect(runtime.trackedOrders.size).toBe(0);
    expect(runtime.runtimeState).toBe('STOPPED');
  });

  it('blocks recovery when mismatched pending buy terminal state contains executed quantity', async () => {
    const runtime = createRuntimeStore();
    const recoveryFlow = createRecoveryFlow({
      logger: createLoggerDouble(),
      termination: { isTerminated: () => false, reportFatalError: () => {} },
      runtime,
      orderHoldRegistry: createOrderHoldRegistry(),
      orderRecorder: await createRecoveryRecorder(),
      tradingConfig: createTradingConfig({
        monitor: createMonitorConfigWithOwnership(),
      }),
      symbolRegistry: createSymbolRegistryDouble(),
      trackOrder: () => {},
      cancelOrder: async () => {
        const terminalFact = await createPendingOrder({
          orderId: 'ORDER-MISMATCHED-FILLED',
          symbol: 'OLD_BULL.HK',
          side: 'BUY',
          status: 'FILLED',
          executedQuantity: 100,
          executedPrice: '1.02',
          updatedAtMs: Date.parse('2026-04-08T09:01:00.000Z'),
        });
        runtime.queriedTerminalStateByOrderId.set('ORDER-MISMATCHED-FILLED', {
          executionStatus: terminalFact.executionStatus,
          executedAmount: terminalFact.executedAmount,
          executionTimeMs: terminalFact.executionTimeMs,

          kind: 'TERMINAL',
          closedReason: 'FILLED',
          executedPrice: '1.02',
          executedQuantity: 100,
          submittedQuantity: 100,
          orderUpdatedAtMs: Date.parse('2026-04-08T09:01:00.000Z'),
          status: 'FILLED',
        });
        return {
          kind: 'ALREADY_CLOSED',
          closedReason: 'FILLED',
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
        await createPendingOrder({
          orderId: 'ORDER-MISMATCHED-FILLED',
          symbol: 'OLD_BULL.HK',
          side: 'BUY',
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
      logger: createLoggerDouble(),
      termination: { isTerminated: () => false, reportFatalError: () => {} },
      runtime,
      orderHoldRegistry: createOrderHoldRegistry(),
      orderRecorder: await createRecoveryRecorder(),
      tradingConfig: createTradingConfig({ monitor: createMonitorConfigWithOwnership() }),
      symbolRegistry: createSymbolRegistryDouble(),
      trackOrder: () => {},
      cancelOrder: async () => {
        const terminalFact = await createPendingOrder({
          orderId: 'ORDER-MISMATCHED-SNAPSHOT-PARTIAL',
          symbol: 'OLD_BULL.HK',
          side: 'BUY',
          status: 'CANCELED',
          executedQuantity: 0,
          executedPrice: '0',
          updatedAtMs: Date.parse('2026-04-08T09:00:00.100Z'),
        });
        runtime.queriedTerminalStateByOrderId.set('ORDER-MISMATCHED-SNAPSHOT-PARTIAL', {
          executionStatus: terminalFact.executionStatus,
          executedAmount: terminalFact.executedAmount,
          executionTimeMs: terminalFact.executionTimeMs,

          kind: 'TERMINAL',
          closedReason: 'CANCELED',
          executedPrice: null,
          executedQuantity: 0,
          submittedQuantity: 100,
          orderUpdatedAtMs: Date.parse('2026-04-08T09:00:00.100Z'),
          status: 'CANCELED',
        });
        return {
          kind: 'ALREADY_CLOSED',
          closedReason: 'CANCELED',
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
        await createPendingOrder({
          orderId: 'ORDER-MISMATCHED-SNAPSHOT-PARTIAL',
          symbol: 'OLD_BULL.HK',
          side: 'BUY',
          executedPrice: '1.05',
          executedQuantity: 30,
          updatedAtMs: Date.parse('2026-04-08T09:00:00.200Z'),
        }),
      ]),
    ).rejects.toThrow(/不匹配但.*存在成交事实/);
    expect(runtime.runtimeState).toBe('STOPPED');
  });
});

describe('recovery termination and unmatched BUY', () => {
  it.each(['accepted', 'unknown', 'external', 'safe', 'unhandled', 'shutdown'] as const)(
    '安全收口分类 %s',
    async (mode) => {
      const runtime = createRuntimeStore();
      const termination = createTerminationRuntime({
        closeTradingGate: () => {},
        closeProducerAdmission: () => {},
        stopProducers: [],
        onSecondaryError: () => {},
      });
      const gate = Promise.withResolvers<null>();
      const external = await createExternalApiRequestError({
        operation: 'TradeContext.cancelOrder',
        attempts: 1,
        cause: new Error('network'),
      });
      let settlements = 0;
      const flow = createRecoveryFlow({
        logger: createLoggerDouble(),
        termination,
        runtime,
        orderHoldRegistry: createOrderHoldRegistry(),
        orderRecorder: await createRecoveryRecorder(),
        tradingConfig: createTradingConfig({ monitor: createMonitorConfigWithOwnership() }),
        symbolRegistry: createSymbolRegistryDouble(),
        trackOrder: () => {},
        cancelOrder: async () => {
          if (mode === 'shutdown') await gate.promise;

          if (mode === 'external') throw external;

          if (mode === 'accepted' || mode === 'shutdown')
            return { kind: 'CANCEL_CONFIRMED', relatedBuyOrderIds: null };

          if (mode !== 'unknown') {
            const terminalFact = await createPendingOrder({
              orderId: 'MISMATCH',
              symbol: 'OLD_BULL.HK',
              side: 'BUY',
              status: 'CANCELED',
              executedQuantity: 0,
              executedPrice: '0',
              updatedAtMs: Date.parse('2026-04-08T09:01:00.000Z'),
            });
            runtime.queriedTerminalStateByOrderId.set('MISMATCH', {
              executionStatus: terminalFact.executionStatus,
              executedAmount: terminalFact.executedAmount,
              executionTimeMs: terminalFact.executionTimeMs,

              kind: 'TERMINAL',
              closedReason: 'CANCELED',
              executedPrice: null,
              executedQuantity: 0,
              submittedQuantity: 100,
              orderUpdatedAtMs: Date.parse('2026-04-08T09:01:00.000Z'),
              status: 'CANCELED',
            });
          }

          return {
            kind: 'ALREADY_CLOSED',
            closedReason: 'CANCELED',
            relatedBuyOrderIds: null,
            terminalExecution: { submittedQuantity: 100, executedQuantity: 0 },
          };
        },
        settleOrder: () => {
          settlements += 1;
          return { handled: mode === 'safe', relatedBuyOrderIds: null };
        },
        handleOrderChangedWhenActive: () => {},
      });
      const promise = flow.recoverOrderTrackingFromSnapshot([
        await createPendingOrder({ orderId: 'MISMATCH', symbol: 'OLD_BULL.HK', side: 'BUY' }),
      ]);
      if (mode === 'shutdown') {
        termination.requestShutdown();
        gate.resolve(null);
      }

      const error = await promise.then(
        () => null,
        (rejection: unknown) => rejection,
      );
      if (mode === 'safe') {
        expect(error).toBeNull();
        expect(runtime.runtimeState).toBe('ACTIVE');
        expect(settlements).toBe(1);
      } else if (mode === 'shutdown') {
        expect(error).toBeNull();
        expect(runtime.runtimeState).toBe('STOPPED');
        expect(settlements).toBe(0);
      } else {
        expect(error).toBeInstanceOf(Error);
        expect(runtime.runtimeState).toBe('STOPPED');
        if (mode === 'external') expect(error).toBe(external);

        expect(runtime.trackedOrders.size).toBe(0);
      }
    },
  );
});

describe('recovery market scope', () => {
  function createUsPendingOrder(
    orderId: string,
    executionSide: 'BUY' | 'SELL',
    status: OrderReadStatus = 'WORKING',
  ): OrderFact {
    const atMs = Date.parse('2026-04-08T09:00:00.000Z');
    return {
      orderId,
      symbol: 'AAPL.US',
      stockName: 'US STOCK',
      executionSide,
      executionStatus: 'NONE',
      executionPhase: 'OPEN',
      status,
      orderType: 'ELO',
      remark: '',
      price: '1',
      quantity: 100,
      executedPrice: null,
      executedQuantity: 0,
      executedAmount: '0',
      executionTimeMs: null,
      updatedAtMs: atMs,
      submittedAt: new Date(atMs - 1000),
      updatedAt: new Date(atMs),
    };
  }

  it('US pending orders are zero-op in the common recovery entry and reconciliation set', async () => {
    const runtime = createRuntimeStore();
    const cancelCalls: string[] = [];
    const trackCalls: string[] = [];
    const settleCalls: string[] = [];
    const replayCalls: string[] = [];
    const recoveryFlow = createRecoveryFlow({
      logger: createLoggerDouble(),
      termination: { isTerminated: () => false, reportFatalError: () => {} },
      runtime,
      orderHoldRegistry: createOrderHoldRegistry(),
      orderRecorder: await createRecoveryRecorder(),
      tradingConfig: createTradingConfig({ monitor: createMonitorConfigWithOwnership() }),
      symbolRegistry: createSymbolRegistryDouble(),
      trackOrder: (params) => {
        trackCalls.push(params.orderId);
      },
      cancelOrder: async (orderId) => {
        cancelCalls.push(orderId);
        return { kind: 'CANCEL_CONFIRMED', relatedBuyOrderIds: null };
      },
      settleOrder: (params) => {
        settleCalls.push(params.orderId);
        return { handled: true, relatedBuyOrderIds: null };
      },
      handleOrderChangedWhenActive: (event) => {
        replayCalls.push(event.orderId);
      },
    });

    await recoveryFlow.recoverOrderTrackingFromSnapshot([
      createUsPendingOrder('US-BUY-PENDING', 'BUY'),
      createUsPendingOrder('US-SELL-PENDING', 'SELL'),
    ]);

    expect(cancelCalls).toEqual([]);
    expect(trackCalls).toEqual([]);
    expect(settleCalls).toEqual([]);
    expect(replayCalls).toEqual([]);
    expect(runtime.runtimeState).toBe('ACTIVE');
    expect(runtime.trackedOrders.size).toBe(0);
  });

  it('keeps the original HK old-seat SELL recovery block', async () => {
    const runtime = createRuntimeStore();
    const recoveryFlow = createRecoveryFlow({
      logger: createLoggerDouble(),
      termination: { isTerminated: () => false, reportFatalError: () => {} },
      runtime,
      orderHoldRegistry: createOrderHoldRegistry(),
      orderRecorder: await createRecoveryRecorder(),
      tradingConfig: createTradingConfig({ monitor: createMonitorConfigWithOwnership() }),
      symbolRegistry: createSymbolRegistryDouble(),
      trackOrder: () => {},
      cancelOrder: async () => ({ kind: 'CANCEL_CONFIRMED', relatedBuyOrderIds: null }),
      settleOrder: () => ({ handled: true, relatedBuyOrderIds: null }),
      handleOrderChangedWhenActive: () => {},
    });

    const error = await recoveryFlow
      .recoverOrderTrackingFromSnapshot([
        await createPendingOrder({
          orderId: 'HK-OLD-SEAT-SELL',
          symbol: 'OLD_BULL.HK',
          side: 'SELL',
          status: 'WORKING',
        }),
      ])
      .then(
        () => null,
        (rejection: unknown) => rejection,
      );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/卖单.*与当前席位不匹配/);
    expect(runtime.runtimeState).toBe('STOPPED');
    expect(runtime.trackedOrders.size).toBe(0);
  });
});

describe('recovery zero-close revision boundary', () => {
  it('wrong-seat BUY positive known is not closed by a no-revision zero terminal', async () => {
    const runtime = createRuntimeStore();
    let settleCalls = 0;
    const recorder = await createRecoveryRecorder();
    const recoveryFlow = createRecoveryFlow({
      logger: createLoggerDouble(),
      termination: { isTerminated: () => false, reportFatalError: () => {} },
      runtime,
      orderHoldRegistry: createOrderHoldRegistry(),
      orderRecorder: recorder,
      tradingConfig: createTradingConfig({ monitor: createMonitorConfigWithOwnership() }),
      symbolRegistry: createSymbolRegistryDouble(),
      trackOrder: () => {},
      cancelOrder: async () => {
        runtime.queriedTerminalStateByOrderId.set('WRONG-SEAT-BUY-ZERO', {
          kind: 'TERMINAL',
          executionStatus: 'NONE',
          executedAmount: null,
          executionTimeMs: null,
          closedReason: 'CANCELED',
          executedPrice: null,
          executedQuantity: 0,
          submittedQuantity: 100,
          orderUpdatedAtMs: null,
          status: 'CANCELED',
        });
        return {
          kind: 'ALREADY_CLOSED',
          closedReason: 'CANCELED',
          relatedBuyOrderIds: null,
          terminalExecution: { submittedQuantity: 100, executedQuantity: 0 },
        };
      },
      settleOrder: () => {
        settleCalls += 1;
        return { handled: true, relatedBuyOrderIds: null };
      },
      handleOrderChangedWhenActive: () => {},
    });

    const error = await recoveryFlow
      .recoverOrderTrackingFromSnapshot([
        await createPendingOrder({
          orderId: 'WRONG-SEAT-BUY-ZERO',
          symbol: 'OLD_BULL.HK',
          side: 'BUY',
          status: 'WORKING',
          executedQuantity: 10,
          executedPrice: '1.05',
        }),
      ])
      .then(
        () => null,
        (rejection: unknown) => rejection,
      );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/无 revision 零关闭/);
    expect(settleCalls).toBe(0);
    expect(runtime.trackedOrders.size).toBe(0);
    expect(runtime.runtimeState).toBe('STOPPED');
    expect(recorder.getExecutionFact('WRONG-SEAT-BUY-ZERO')).toBeNull();
    expect(recorder.getPendingSellSnapshot()).toEqual([]);
  });
});
