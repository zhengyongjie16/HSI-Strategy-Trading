/**
 * orderMonitor routeProcessor 业务测试
 *
 * 功能：
 * - 锁定 quoteFlow 迁移到 routeProcessor 后必须保持的超时与动作选择语义。
 */
import { describe, expect, it } from 'bun:test';
import type { OrderReadStatus } from '../../../../src/types/orderReadMetadata.js';
import {
  ORDER_MONITOR_WAIT_WS_ONLY_BLOCK_UNTIL_MS,
  ORDER_QUOTE_RETRY,
} from '../../../../src/constants/index.js';
import { createDailyLossOrderAnalysisDeps } from '../../../../src/core/orderRecorder/index.js';
import { createDailyLossTracker } from '../../../../src/domain/risk/dailyLossTracker.js';
import { toHongKongTimeIso } from '../../../../src/utils/time/index.js';
import { createBrokerIngressFixture } from '../../../integration/architectureRefactoringP1Native/trade/brokerIngressFixture.js';
import { createExecutionFixture } from '../../orderRecorder/executionFixture.js';
import type { createSettlementFlow } from '../../../../src/core/trader/orderMonitor/settlementFlow.js';
import type {
  FinalizeOrderSettlementParams,
  OrderMonitorRuntimeStore,
  OrderMonitorTrackedOrder,
  TerminalStateSnapshot,
  RouteProcessorDeps,
} from '../../../../src/core/trader/orderMonitor/types.js';
import type { OrderMonitorConfig } from '../../../../src/core/trader/types.js';
import type { TrackOrderParams } from '../../../../src/domain/order/types.js';
import type { OrderRecorder, TradeMutationPermit } from '../../../../src/types/services.js';
import { exactMultiply } from '../../../../src/utils/numeric/exact.js';
import {
  createOrderRecorderDouble,
  createRateLimiterDouble,
  createQuoteDouble,
} from '../../../helpers/testDoubles.js';

function createRuntimeStore(): OrderMonitorRuntimeStore {
  return {
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
}

function createConfig(params?: {
  readonly buyTimeoutMs?: number;
  readonly sellTimeoutMs?: number;
  readonly priceUpdateIntervalMs?: number;
  readonly allowBuyOrderTrackingAboveInitialPrice?: boolean;
}): OrderMonitorConfig {
  return {
    buyTimeout: {
      enabled: true,
      timeoutMs: params?.buyTimeoutMs ?? 0,
    },
    sellTimeout: {
      enabled: true,
      timeoutMs: params?.sellTimeoutMs ?? 0,
    },
    priceUpdateIntervalMs: params?.priceUpdateIntervalMs ?? 0,
    priceDiffThreshold: '0.001',
    allowBuyOrderTrackingAboveInitialPrice: params?.allowBuyOrderTrackingAboveInitialPrice ?? true,
  };
}

async function createTrackedOrder(
  params: Partial<OrderMonitorTrackedOrder> &
    Pick<OrderMonitorTrackedOrder, 'orderId' | 'symbol' | 'side'>,
): Promise<OrderMonitorTrackedOrder> {
  const now = Date.now();
  if (!['BUY', 'SELL'].includes(params.side)) {
    throw new TypeError('tracked fixture requires a validated BUY or SELL side');
  }

  const fixtureStatusNames: ReadonlyMap<
    OrderReadStatus,
    Parameters<typeof createBrokerIngressFixture>[0]['status']
  > = new Map([
    ['WORKING', 'New'],
    ['CANCELED', 'Canceled'],
    ['FILLED', 'Filled'],
    ['PARTIALLY_FILLED', 'PartialFilled'],
  ]);
  const fixtureStatus = fixtureStatusNames.get(params.status ?? 'WORKING');
  if (fixtureStatus === undefined)
    throw new TypeError('route fixture requires an explicit supported broker status');

  const frameOrderType = params.orderType ?? 'ELO';
  if (frameOrderType !== 'ELO' && frameOrderType !== 'LO' && frameOrderType !== 'MO') {
    throw new TypeError('route fixture requires an explicit supported native order type');
  }

  const native = await createBrokerIngressFixture({
    orderId: params.orderId,
    tradeId: 'TRACKED-' + params.orderId,
    symbol: params.symbol,
    stockName: params.symbol,
    remark: '',
    side: params.side,
    orderType: frameOrderType,
    status: fixtureStatus,
    quantity: String(params.submittedQuantity ?? 100),
    executedQuantity: String(params.executedQuantity ?? 0),
    submittedPrice: params.submittedPrice ?? '1',
    executedPrice: params.executedPrice ?? ((params.executedQuantity ?? 0) > 0 ? '1' : '0'),
    submittedAtMs: params.submittedAt ?? now - 5000,
    executionTimeMs: params.lastExecutedTimeMs ?? now,
    updatedAtMs: params.lastOrderUpdateAtMs ?? params.lastExecutedTimeMs ?? now,
  });
  const fact = native.queryObservation;

  return {
    orderId: params.orderId,
    symbol: params.symbol,
    side: fact.executionSide,
    executionSide: fact.executionSide,
    executionPhase: fact.executionPhase,
    isLongSymbol: params.isLongSymbol ?? true,
    monitorSymbol: params.monitorSymbol ?? 'HSI.HK',
    isProtectiveLiquidation: params.isProtectiveLiquidation ?? false,
    orderType: fact.orderType,
    submittedPrice: params.submittedPrice ?? '1',
    initialSubmittedPrice: params.initialSubmittedPrice ?? '1',
    submittedQuantity: params.submittedQuantity ?? 100,
    executedQuantity: params.executedQuantity ?? 0,
    executedPrice: params.executedPrice ?? null,
    executedAmount:
      params.executedAmount ??
      exactMultiply(params.executedPrice ?? '0', String(params.executedQuantity ?? 0)),
    lastExecutedTimeMs: params.lastExecutedTimeMs ?? null,
    lastOrderUpdateAtMs: params.lastOrderUpdateAtMs ?? null,
    status: fact.status,
    submittedAt: params.submittedAt ?? now - 5_000,
    lastPriceUpdateAt: params.lastPriceUpdateAt ?? now - 5_000,
    convertedToMarket: params.convertedToMarket ?? false,
    nextCancelAttemptAt: params.nextCancelAttemptAt ?? now - 1,
    cancelRetryCount: params.cancelRetryCount ?? 0,
    replaceCapability: params.replaceCapability ?? 'SUPPORTED',
    replaceBlockedUntilAt: params.replaceBlockedUntilAt ?? null,
    quoteRetryAttempts: params.quoteRetryAttempts ?? 0,
    quoteRetryNextAt: params.quoteRetryNextAt ?? null,
    quoteRetryExhausted: params.quoteRetryExhausted ?? false,
    replaceTempBlockedCount: params.replaceTempBlockedCount ?? 0,
    replaceResumeMode: params.replaceResumeMode ?? 'TIME_BACKOFF',
    timeoutMarketConversionPending: params.timeoutMarketConversionPending ?? false,
    timeoutMarketConversionTerminalState: params.timeoutMarketConversionTerminalState ?? null,
  };
}

function setLatestReplaceTerminal(
  runtime: OrderMonitorRuntimeStore,
  orderId: string,
  outcome: TerminalStateSnapshot,
): void {
  runtime.latestReplaceTerminalByOrderId.set(orderId, outcome);
}

function attachTrackedOrders(
  runtime: OrderMonitorRuntimeStore,
  symbol: string,
  orders: ReadonlyArray<OrderMonitorTrackedOrder>,
): void {
  const orderIds = new Set<string>();
  for (const order of orders) {
    runtime.trackedOrders.set(order.orderId, order);
    runtime.trackedOrderLifecycles.set(order.orderId, 'OPEN');
    orderIds.add(order.orderId);
  }

  runtime.trackedOrderIdsBySymbol.set(symbol, orderIds);
  runtime.routeStatesBySymbol.set(symbol, {
    symbol,
    generation: 1,
    inFlight: false,
    dirty: false,
    latestQuote: null,
    pendingWakeupKind: null,
    timerHandles: new Map(),
  });
  runtime.latestRouteGenerationBySymbol.set(symbol, 1);
}

function createDeferredValue<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
  };
}

function createActualDailyTracker(now = new Date('2026-04-08T09:00:00.000Z')) {
  const daily = createDailyLossTracker({
    onOwnershipWarning: () => {},
    ...createDailyLossOrderAnalysisDeps(),
    toHongKongTimeIso,
  });
  daily.recalculateFromAllOrders(
    [],
    { monitorSymbol: 'HSI.HK', orderOwnershipMapping: ['HSI'] },
    now,
    new Map(),
    new Set(['BULL.HK']),
  );
  return daily;
}

async function createTimeoutSellHandoffHarness(orderId: string): Promise<{
  readonly runtime: OrderMonitorRuntimeStore;
  readonly storage: OrderRecorder;
  readonly orderRecorder: RouteProcessorDeps['orderRecorder'];
  readonly settlementFlow: ReturnType<typeof createSettlementFlow>;
}> {
  const native = await createNativeFixture();
  const economic = createExecutionFixture({
    nowMs: Date.parse('2026-04-08T09:00:00.000Z'),
    createRecorder: native.createRecorder,
  });
  const runtime = economic.runtime;
  runtime.running = true;
  runtime.runtimeState = 'ACTIVE';
  attachTrackedOrders(runtime, 'BULL.HK', [
    await createTrackedOrder({
      orderId,
      symbol: 'BULL.HK',
      side: 'SELL',
      status: 'CANCELED',
      submittedQuantity: 200,
      executedQuantity: 0,
      submittedAt: Date.now() - 10_000,
      timeoutMarketConversionPending: true,
      timeoutMarketConversionTerminalState: {
        closedReason: 'CANCELED',
        source: 'WS',
        executedPrice: '0',
        executedAmount: exactMultiply('0', String(0)),
        executedQuantity: 0,
        executedTimeMs: null,
        orderUpdatedAtMs: Date.parse('2026-04-08T09:00:01.000Z'),
      },
    }),
  ]);

  const orderRecorder = economic.recorder;
  for (const [brokerOrderId, price, executionTimeMs] of [
    ['BUY-1', '1', Date.parse('2026-04-08T08:30:00.000Z')],
    ['BUY-2', '1.1', Date.parse('2026-04-08T08:31:00.000Z')],
  ] as const) {
    const ingress = await createBrokerIngressFixture({
      orderId: brokerOrderId,
      tradeId: 'T-' + brokerOrderId,
      symbol: 'BULL.HK',
      stockName: 'HSI RC',
      remark: '',
      side: 'BUY',
      status: 'Filled',
      quantity: '100',
      executedQuantity: '100',
      submittedPrice: price,
      executedPrice: price,
      submittedAtMs: executionTimeMs - 1000,
      executionTimeMs,
      updatedAtMs: executionTimeMs + 100,
    });
    const raw = ingress.queryObservation;
    if (raw.executionTimeMs === null)
      throw new Error('fixture executions must prove independent T');

    economic.flow.recordCumulativeExecution({
      factStage: 'TERMINAL',
      orderId: raw.orderId,
      symbol: raw.symbol,
      side: raw.executionSide,
      monitorSymbol: 'HSI.HK',
      isLongSymbol: true,
      isProtectiveLiquidation: false,
      executedPrice: price,
      executedQuantity: raw.executedQuantity,
      executedAmount: raw.executedAmount,
      executedTimeMs: raw.executionTimeMs,
      orderUpdatedAtMs: raw.updatedAtMs,
    });
  }

  orderRecorder.submitSellOrder(
    orderId,
    'BULL.HK',
    'LONG',
    200,
    ['BUY-1', 'BUY-2'],
    false,
    Date.parse('2026-04-08T09:00:00.000Z'),
  );
  const storage = orderRecorder;
  const settlementFlow = economic.flow;

  return {
    runtime,
    storage,
    orderRecorder,
    settlementFlow,
  };
}

type TestRouteDeps = Omit<RouteProcessorDeps, 'ctx' | 'tradeMutationPort'> &
  Readonly<{ native: Awaited<ReturnType<typeof createBrokerIngressFixture>> }>;
function createRouteProcessor(deps: TestRouteDeps) {
  return deps.native.createRoute(deps);
}

async function readTerminalExecutionStatus(
  status: 'Canceled' | 'Filled',
  quantity: number,
  price: string,
) {
  const frame = await createBrokerIngressFixture({
    orderId: 'TERMINAL-METADATA',
    tradeId: 'TERMINAL-METADATA-EXECUTION',
    symbol: 'BULL.HK',
    stockName: 'BULL.HK',
    remark: '',
    side: 'SELL',
    status,
    quantity: '100',
    executedQuantity: String(quantity),
    submittedPrice: '1',
    executedPrice: price,
    submittedAtMs: 100,
    executionTimeMs: 150,
    updatedAtMs: 200,
  });
  return Object.freeze({
    executionStatus: frame.queryObservation.executionStatus,
    status: frame.queryObservation.status,
  });
}

async function createNativeFixture() {
  return createBrokerIngressFixture({
    orderId: 'ROUTE-OBSERVATION',
    tradeId: 'NO-FILL',
    symbol: 'BULL.HK',
    stockName: 'BULL',
    remark: '',
    side: 'SELL',
    status: 'New',
    quantity: '100',
    executedQuantity: '0',
    submittedPrice: '1',
    executedPrice: '0',
    submittedAtMs: Date.parse('2026-04-08T09:00:00.000Z'),
    executionTimeMs: Date.parse('2026-04-08T09:00:00.100Z'),
    updatedAtMs: Date.parse('2026-04-08T09:00:00.200Z'),
  });
}

async function createDeps(params?: {
  readonly runtime?: OrderMonitorRuntimeStore;
  readonly config?: OrderMonitorConfig;
  readonly cancelOrder?: RouteProcessorDeps['cancelOrder'];
  readonly replaceOrderPrice?: RouteProcessorDeps['replaceOrderPrice'];
  readonly settleOrder?: RouteProcessorDeps['settleOrder'];
  readonly trackOrder?: RouteProcessorDeps['trackOrder'];
  readonly isContinuousTradingAllowed?: () => boolean;
  readonly orderRecorder?: RouteProcessorDeps['orderRecorder'];
  readonly native?: Awaited<ReturnType<typeof createBrokerIngressFixture>>;
  readonly rateLimiter?: RouteProcessorDeps['rateLimiter'];
  readonly now?: RouteProcessorDeps['now'];
}): Promise<{
  readonly runtime: OrderMonitorRuntimeStore;
  readonly native: Awaited<ReturnType<typeof createBrokerIngressFixture>>;
  readonly deps: TestRouteDeps;
}> {
  const runtime = params?.runtime ?? createRuntimeStore();
  const config = params?.config ?? createConfig();
  const native = params?.native ?? (await createNativeFixture());
  const deps: TestRouteDeps = {
    native,
    now: params?.now ?? (() => new Date(Date.now())),
    runtime,
    config,
    orderRecorder: params?.orderRecorder ?? createOrderRecorderDouble(),
    rateLimiter: params?.rateLimiter ?? createRateLimiterDouble(),
    isContinuousTradingAllowed: params?.isContinuousTradingAllowed ?? (() => true),
    trackOrder:
      params?.trackOrder ??
      ((_trackParams: TrackOrderParams) => {
        throw new Error('trackOrder was not stubbed');
      }),
    cancelOrder:
      params?.cancelOrder ??
      (async (_orderId: string) => ({
        kind: 'UNKNOWN_FAILURE',
        errorCode: null,
      })),
    replaceOrderPrice:
      params?.replaceOrderPrice ??
      (async (_orderId: string, _newPrice: string, _quantity?: number | null) => {}),
    settleOrder:
      params?.settleOrder ??
      ((_params) => ({
        handled: true,
        relatedBuyOrderIds: null,
      })),
  };

  return {
    runtime,
    native,
    deps,
  };
}

async function captureTimeoutMarketRouteError(deps: TestRouteDeps): Promise<string> {
  const routeProcessor = createRouteProcessor(deps);
  try {
    await routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'ORDER_EVENT',
      latestQuote: null,
    });
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }

  return '';
}

function expectTimeoutSellOccupancyReleased(storage: OrderRecorder): void {
  expect(storage.getPendingSellSnapshot()).toEqual([]);
  const sellableOrders = storage.selectSellableOrders({
    symbol: 'BULL.HK',
    direction: 'LONG',
    strategy: 'ALL',
    currentPrice: '1.2',
  });
  expect(sellableOrders.orders.map((order) => order.orderId)).toEqual(['BUY-1', 'BUY-2']);
  expect(sellableOrders.totalQuantity).toBe(200);
}

describe('orderMonitor routeProcessor', () => {
  it('将 timeout snapshot 已准备的保护性 progress 原样传入终态结算', async () => {
    const runtime = createRuntimeStore();
    const preparedTime = Date.parse('2026-07-13T05:00:00.000Z');
    const preparedExecution = createActualDailyTracker(
      new Date(preparedTime),
    ).recordCumulativeExecution({
      factStage: 'TERMINAL',
      direction: 'LONG',
      symbol: 'BULL.HK',
      side: 'SELL',
      executedPrice: '1.02',
      executedQuantity: 40,
      executedTimeMs: preparedTime,
      orderUpdatedAtMs: preparedTime + 100,
      orderId: 'SELL-TIMEOUT-PREPARED-PROGRESS',
    });
    attachTrackedOrders(runtime, 'BULL.HK', [
      await createTrackedOrder({
        orderId: 'SELL-TIMEOUT-PREPARED-PROGRESS',
        symbol: 'BULL.HK',
        side: 'SELL',
        status: 'FILLED',
        submittedQuantity: 40,
        executedQuantity: 40,
        executedPrice: '1.02',
        executedAmount: exactMultiply('1.02', String(40)),
        isProtectiveLiquidation: true,
        timeoutMarketConversionPending: true,
        timeoutMarketConversionTerminalState: {
          closedReason: 'FILLED',
          source: 'WS',
          executedPrice: '1.02',
          executedAmount: exactMultiply('1.02', String(40)),
          executedQuantity: 40,
          executedTimeMs: Date.parse('2026-07-13T05:00:00.000Z'),
          orderUpdatedAtMs: Date.parse('2026-07-13T05:00:00.000Z'),
          preparedProtectiveTerminalExecution: preparedExecution,
        },
      }),
    ]);
    const settlementInputs: FinalizeOrderSettlementParams[] = [];
    const { deps } = await createDeps({
      runtime,
      settleOrder: (params) => {
        settlementInputs.push(params);
        return { handled: true, relatedBuyOrderIds: null };
      },
    });

    await createRouteProcessor(deps).processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'ORDER_EVENT',
      latestQuote: null,
    });

    expect(settlementInputs).toHaveLength(1);
    const settlementInput = settlementInputs[0];
    if (settlementInput === undefined) {
      throw new Error('missing timeout settlement input');
    }

    expect(settlementInput.preparedProtectiveTerminalExecution).toBe(preparedExecution);
  });

  it('submits timeout market conversion through a callback permit instead of read throttle', async () => {
    const runtime = createRuntimeStore();
    attachTrackedOrders(runtime, 'BULL.HK', [
      await createTrackedOrder({
        orderId: 'SELL-TIMEOUT-PERMIT',
        symbol: 'BULL.HK',
        side: 'SELL',
        status: 'CANCELED',
        timeoutMarketConversionPending: true,
        timeoutMarketConversionTerminalState: {
          closedReason: 'CANCELED',
          source: 'WS',
          executedPrice: '0',
          executedAmount: exactMultiply('0', String(0)),
          executedQuantity: 0,
          executedTimeMs: null,
          orderUpdatedAtMs: Date.now(),
        },
      }),
    ]);
    const events: string[] = [];
    const rateLimiter = {
      throttle: async (): Promise<void> => {
        throw new Error('timeout market submit must not use read throttle');
      },
      withTradeMutation: async <T>(
        callback: (permit: {
          readonly invoke: <TResult>(operation: () => Promise<TResult>) => Promise<TResult>;
        }) => Promise<T>,
      ): Promise<T> => {
        events.push('permit');
        let invoked = false;
        return callback({
          invoke: async <TResult>(operation: () => Promise<TResult>): Promise<TResult> => {
            if (invoked) {
              throw new Error('mutation permit invoked more than once');
            }

            invoked = true;
            events.push('invoke');
            return operation();
          },
        });
      },
    };
    const trackedOrders: TrackOrderParams[] = [];
    const { deps, native } = await createDeps({
      runtime,
      rateLimiter,
      settleOrder: () => ({
        handled: true,
        relatedBuyOrderIds: ['BUY-1'],
      }),
      trackOrder: (params) => {
        trackedOrders.push(params);
      },
    });

    await createRouteProcessor(deps).processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'ORDER_EVENT',
      latestQuote: null,
    });

    expect(native.nativeMutations().filter((entry) => entry.kind === 'SUBMIT')).toHaveLength(1);
    expect(trackedOrders).toHaveLength(1);
    expect(events).toEqual(['permit', 'invoke']);
  });

  it('买单超时只触发 cancel，不转市价', async () => {
    const runtime = createRuntimeStore();
    attachTrackedOrders(runtime, 'BULL.HK', [
      await createTrackedOrder({
        orderId: 'BUY-TIMEOUT-1',
        symbol: 'BULL.HK',
        side: 'BUY',
      }),
    ]);
    const cancelOrderIds: string[] = [];
    const { deps, native } = await createDeps({
      runtime,
      cancelOrder: async (orderId) => {
        cancelOrderIds.push(orderId);
        return {
          kind: 'CANCEL_CONFIRMED',
          relatedBuyOrderIds: null,
        };
      },
    });
    const routeProcessor = createRouteProcessor(deps);

    await routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'TIMER',
      latestQuote: null,
    });

    expect(cancelOrderIds).toEqual(['BUY-TIMEOUT-1']);
    expect(native.nativeMutations().filter((entry) => entry.kind === 'SUBMIT')).toHaveLength(0);
    const trackedOrder = runtime.trackedOrders.get('BUY-TIMEOUT-1');
    expect(trackedOrder?.nextCancelAttemptAt).toBe(ORDER_MONITOR_WAIT_WS_ONLY_BLOCK_UNTIL_MS);
  });

  it('普通终态订单不会再次进入 timeout 处理', async () => {
    const runtime = createRuntimeStore();
    attachTrackedOrders(runtime, 'BULL.HK', [
      await createTrackedOrder({
        orderId: 'BUY-CLOSED-SHOULD-SKIP-TIMEOUT',
        symbol: 'BULL.HK',
        side: 'BUY',
        status: 'FILLED',
      }),
    ]);
    const cancelOrderIds: string[] = [];
    const { deps } = await createDeps({
      runtime,
      cancelOrder: async (orderId) => {
        cancelOrderIds.push(orderId);
        return {
          kind: 'CANCEL_CONFIRMED',
          relatedBuyOrderIds: null,
        };
      },
    });
    const routeProcessor = createRouteProcessor(deps);

    await routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'TIMER',
      latestQuote: null,
    });

    expect(cancelOrderIds).toEqual([]);
  });

  it('超时等待中的完整成交卖单即使剩余数量为零也会消费终态快照完成 settlement', async () => {
    const runtime = createRuntimeStore();
    attachTrackedOrders(runtime, 'BULL.HK', [
      await createTrackedOrder({
        orderId: 'SELL-TIMEOUT-FILLED-SETTLEMENT',
        symbol: 'BULL.HK',
        side: 'SELL',
        status: 'FILLED',
        submittedQuantity: 100,
        executedQuantity: 100,
        timeoutMarketConversionPending: true,
        timeoutMarketConversionTerminalState: {
          closedReason: 'FILLED',
          source: 'WS',
          executedPrice: '1.02',
          executedAmount: exactMultiply('1.02', String(100)),
          executedQuantity: 100,
          executedTimeMs: Date.parse('2026-04-08T09:00:01.000Z'),
          orderUpdatedAtMs: Date.parse('2026-04-08T09:00:01.000Z'),
        },
      }),
    ]);
    const settlementOrderIds: string[] = [];
    const { deps, native } = await createDeps({
      runtime,
      settleOrder: (params) => {
        settlementOrderIds.push(params.orderId);
        return {
          handled: true,
          relatedBuyOrderIds: null,
        };
      },
    });
    const routeProcessor = createRouteProcessor(deps);

    await routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'ORDER_EVENT',
      latestQuote: null,
    });

    expect(settlementOrderIds).toEqual(['SELL-TIMEOUT-FILLED-SETTLEMENT']);
    expect(native.nativeMutations().filter((entry) => entry.kind === 'SUBMIT')).toHaveLength(0);
  });

  it('卖单超时撤单请求成功后进入等待 WS，不立即转市价', async () => {
    const runtime = createRuntimeStore();
    attachTrackedOrders(runtime, 'BULL.HK', [
      await createTrackedOrder({
        orderId: 'SELL-TIMEOUT-1',
        symbol: 'BULL.HK',
        side: 'SELL',
      }),
    ]);
    const cancelOrderIds: string[] = [];
    const { deps, native } = await createDeps({
      runtime,
      cancelOrder: async (orderId, beforeBrokerCancel?: () => boolean) => {
        cancelOrderIds.push(orderId);
        if (beforeBrokerCancel === undefined) {
          throw new Error('[测试] 超时卖单撤单前必须执行 route preflight');
        }

        expect(beforeBrokerCancel()).toBe(true);
        return {
          kind: 'CANCEL_CONFIRMED',
          relatedBuyOrderIds: null,
        };
      },
    });
    const routeProcessor = createRouteProcessor(deps);

    await routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'TIMER',
      latestQuote: null,
    });

    expect(cancelOrderIds).toEqual(['SELL-TIMEOUT-1']);
    expect(native.nativeMutations().filter((entry) => entry.kind === 'SUBMIT')).toHaveLength(0);
    const trackedOrder = runtime.trackedOrders.get('SELL-TIMEOUT-1');
    expect(trackedOrder?.timeoutMarketConversionPending).toBe(true);
    expect(trackedOrder?.nextCancelAttemptAt).toBe(ORDER_MONITOR_WAIT_WS_ONLY_BLOCK_UNTIL_MS);
  });

  it('卖单等待终态快照时会先 settlement，再转 MO', async () => {
    const runtime = createRuntimeStore();
    attachTrackedOrders(runtime, 'BULL.HK', [
      await createTrackedOrder({
        orderId: 'SELL-CONVERT-1',
        symbol: 'BULL.HK',
        side: 'SELL',
        status: 'CANCELED',
        timeoutMarketConversionPending: true,
        timeoutMarketConversionTerminalState: {
          closedReason: 'CANCELED',
          source: 'WS',
          executedPrice: '0',
          executedAmount: exactMultiply('0', String(0)),
          executedQuantity: 0,
          executedTimeMs: null,
          orderUpdatedAtMs: Date.parse('2026-04-08T09:00:01.000Z'),
        },
      }),
    ]);
    const callSequence: string[] = [];
    const trackedOrders: TrackOrderParams[] = [];
    const { deps, native } = await createDeps({
      runtime,
      settleOrder: (_params) => {
        callSequence.push('settle');
        return {
          handled: true,
          relatedBuyOrderIds: ['BUY-1'],
        };
      },
      trackOrder: (params) => {
        callSequence.push('track');
        trackedOrders.push(params);
      },
    });
    native.setSubmitBehavior(async () => {
      callSequence.push('submit');
      return 'FOLLOW-UP';
    });
    const routeProcessor = createRouteProcessor(deps);

    await routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'ORDER_EVENT',
      latestQuote: null,
    });

    expect(callSequence).toEqual(['settle', 'submit', 'track']);
    expect(callSequence).not.toContain('cancel');
    expect(trackedOrders).toHaveLength(1);
    expect(trackedOrders[0]?.orderId).toBe('FOLLOW-UP');
    expect(trackedOrders[0]?.orderType).toBe('MO');
    expect(trackedOrders[0]?.quantity).toBe(100);
  });

  it('连续交易关闭时仍结算超时卖单终态，但不提交新的市价单', async () => {
    const runtime = createRuntimeStore();
    attachTrackedOrders(runtime, 'BULL.HK', [
      await createTrackedOrder({
        orderId: 'SELL-CONVERT-CLOSED-CONTINUOUS-SESSION',
        symbol: 'BULL.HK',
        side: 'SELL',
        status: 'CANCELED',
        timeoutMarketConversionPending: true,
        timeoutMarketConversionTerminalState: {
          closedReason: 'CANCELED',
          source: 'WS',
          executedPrice: '0',
          executedAmount: exactMultiply('0', String(0)),
          executedQuantity: 0,
          executedTimeMs: null,
          orderUpdatedAtMs: Date.parse('2026-04-08T09:00:01.000Z'),
        },
      }),
    ]);
    const settlementOrderIds: string[] = [];
    const { deps, native } = await createDeps({
      runtime,
      isContinuousTradingAllowed: () => false,
      settleOrder: (params) => {
        settlementOrderIds.push(params.orderId);
        return {
          handled: true,
          relatedBuyOrderIds: ['BUY-1'],
        };
      },
      trackOrder: () => {},
    });

    await createRouteProcessor(deps).processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'ORDER_EVENT',
      latestQuote: null,
    });

    expect(settlementOrderIds).toEqual(['SELL-CONVERT-CLOSED-CONTINUOUS-SESSION']);
    expect(native.nativeMutations().filter((entry) => entry.kind === 'SUBMIT')).toHaveLength(0);
  });

  it('卖单 timeout 结算为无剩余量后，同轮仍允许后续订单基于 quote 继续 replace', async () => {
    const runtime = createRuntimeStore();
    attachTrackedOrders(runtime, 'BULL.HK', [
      await createTrackedOrder({
        orderId: 'SELL-TIMEOUT-NO-REMAINDER',
        symbol: 'BULL.HK',
        side: 'SELL',
        status: 'CANCELED',
        submittedAt: Date.now() - 10_000,
        timeoutMarketConversionPending: true,
        timeoutMarketConversionTerminalState: {
          closedReason: 'CANCELED',
          source: 'WS',
          executedPrice: '0',
          executedAmount: exactMultiply('0', String(100)),
          executedQuantity: 100,
          executedTimeMs: Date.now(),
          orderUpdatedAtMs: Date.now(),
        },
        submittedQuantity: 100,
        executedQuantity: 0,
      }),
      await createTrackedOrder({
        orderId: 'SELL-REPLACE-AFTER-NO-REMAINDER',
        symbol: 'BULL.HK',
        side: 'SELL',
        submittedAt: Date.now() - 1_000,
        submittedPrice: '1',
        initialSubmittedPrice: '1',
        lastPriceUpdateAt: 0,
      }),
    ]);
    const replaceOrderIds: string[] = [];
    const { deps } = await createDeps({
      runtime,
      config: createConfig({
        buyTimeoutMs: 60_000,
        sellTimeoutMs: 5_000,
      }),
      settleOrder: () => {
        runtime.trackedOrders.delete('SELL-TIMEOUT-NO-REMAINDER');
        runtime.trackedOrderLifecycles.set('SELL-TIMEOUT-NO-REMAINDER', 'CLOSED');
        runtime.closedOrderIds.add('SELL-TIMEOUT-NO-REMAINDER');
        runtime.trackedOrderIdsBySymbol.get('BULL.HK')?.delete('SELL-TIMEOUT-NO-REMAINDER');
        return {
          handled: true,
          relatedBuyOrderIds: null,
        };
      },
      replaceOrderPrice: async (orderId) => {
        replaceOrderIds.push(orderId);
      },
    });
    const routeProcessor = createRouteProcessor(deps);

    await routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'ORDER_EVENT',
      latestQuote: createQuoteDouble('BULL.HK', '1.02'),
    });

    expect(replaceOrderIds).toEqual(['SELL-REPLACE-AFTER-NO-REMAINDER']);
  });

  it('单次 pass 最多只执行一个 broker mutation', async () => {
    const runtime = createRuntimeStore();
    attachTrackedOrders(runtime, 'BULL.HK', [
      await createTrackedOrder({
        orderId: 'BUY-TIMEOUT-OLDER',
        symbol: 'BULL.HK',
        side: 'BUY',
        submittedAt: Date.parse('2026-04-08T08:59:00.000Z'),
      }),
      await createTrackedOrder({
        orderId: 'BUY-TIMEOUT-NEWER',
        symbol: 'BULL.HK',
        side: 'BUY',
        submittedAt: Date.parse('2026-04-08T08:59:30.000Z'),
      }),
    ]);
    const cancelOrderIds: string[] = [];
    const { deps } = await createDeps({
      runtime,
      cancelOrder: async (orderId) => {
        cancelOrderIds.push(orderId);
        return {
          kind: 'RETRYABLE_FAILURE',
          errorCode: 'NETWORK',
        };
      },
    });
    const routeProcessor = createRouteProcessor(deps);

    await routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'TIMER',
      latestQuote: null,
    });

    expect(cancelOrderIds).toEqual(['BUY-TIMEOUT-OLDER']);
  });

  it('同一订单同时满足 timeout 与 replace 时优先走 timeout', async () => {
    const runtime = createRuntimeStore();
    attachTrackedOrders(runtime, 'BULL.HK', [
      await createTrackedOrder({
        orderId: 'BUY-TIMEOUT-AND-REPLACE',
        symbol: 'BULL.HK',
        side: 'BUY',
        submittedPrice: '1',
        initialSubmittedPrice: '1',
        lastPriceUpdateAt: 0,
      }),
    ]);
    const cancelOrderIds: string[] = [];
    const replaceOrderIds: string[] = [];
    const { deps } = await createDeps({
      runtime,
      cancelOrder: async (orderId) => {
        cancelOrderIds.push(orderId);
        return {
          kind: 'RETRYABLE_FAILURE',
          errorCode: 'NETWORK',
        };
      },
      replaceOrderPrice: async (orderId) => {
        replaceOrderIds.push(orderId);
      },
    });
    const routeProcessor = createRouteProcessor(deps);

    await routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'QUOTE',
      latestQuote: createQuoteDouble('BULL.HK', '1.02'),
    });

    expect(cancelOrderIds).toEqual(['BUY-TIMEOUT-AND-REPLACE']);
    expect(replaceOrderIds).toEqual([]);
  });

  it('前序 timeout 订单处于 WAIT_WS_ONLY 时不会饿死后续可改价订单', async () => {
    const runtime = createRuntimeStore();
    attachTrackedOrders(runtime, 'BULL.HK', [
      await createTrackedOrder({
        orderId: 'BUY-WAIT-WS-ONLY',
        symbol: 'BULL.HK',
        side: 'BUY',
        nextCancelAttemptAt: ORDER_MONITOR_WAIT_WS_ONLY_BLOCK_UNTIL_MS,
        submittedAt: Date.now() - 10_000,
      }),
      await createTrackedOrder({
        orderId: 'SELL-REPLACE-AFTER-WAIT-WS',
        symbol: 'BULL.HK',
        side: 'SELL',
        submittedAt: Date.now() - 5_000,
        submittedPrice: '1',
        initialSubmittedPrice: '1',
        lastPriceUpdateAt: 0,
      }),
    ]);
    const replaceOrderIds: string[] = [];
    const { deps } = await createDeps({
      runtime,
      config: createConfig({
        buyTimeoutMs: 0,
        sellTimeoutMs: 60_000,
      }),
      replaceOrderPrice: async (orderId) => {
        replaceOrderIds.push(orderId);
      },
    });
    const routeProcessor = createRouteProcessor(deps);

    await routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'QUOTE',
      latestQuote: createQuoteDouble('BULL.HK', '1.02'),
    });

    expect(replaceOrderIds).toEqual(['SELL-REPLACE-AFTER-WAIT-WS']);
  });

  it('超时转出的 MO 新订单不会再次进入 timeout 路径', async () => {
    const runtime = createRuntimeStore();
    attachTrackedOrders(runtime, 'BULL.HK', [
      await createTrackedOrder({
        orderId: 'SELL-CONVERT-MO-SKIP-TIMEOUT',
        symbol: 'BULL.HK',
        side: 'SELL',
        timeoutMarketConversionPending: true,
        timeoutMarketConversionTerminalState: {
          closedReason: 'CANCELED',
          source: 'WS',
          executedPrice: '0',
          executedAmount: exactMultiply('0', String(0)),
          executedQuantity: 0,
          executedTimeMs: null,
          orderUpdatedAtMs: Date.now(),
        },
      }),
    ]);
    const trackedOrders: TrackOrderParams[] = [];
    const cancelOrderIds: string[] = [];
    const { deps, native } = await createDeps({
      runtime,
      settleOrder: () => ({
        handled: true,
        relatedBuyOrderIds: ['BUY-1'],
      }),
      trackOrder: (params) => {
        trackedOrders.push(params);
      },
      cancelOrder: async (orderId) => {
        cancelOrderIds.push(orderId);
        return {
          kind: 'CANCEL_CONFIRMED',
          relatedBuyOrderIds: null,
        };
      },
    });
    native.setSubmitBehavior(async () => 'FOLLOW-UP');
    const routeProcessor = createRouteProcessor(deps);

    await routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'ORDER_EVENT',
      latestQuote: null,
    });

    expect(trackedOrders).toHaveLength(1);
    const convertedOrder = await createTrackedOrder({
      orderId: 'FOLLOW-UP',
      symbol: 'BULL.HK',
      side: 'SELL',
      orderType: 'MO',
      submittedPrice: null,
      initialSubmittedPrice: null,
      submittedAt: Date.now() - 10_000,
    });
    attachTrackedOrders(runtime, 'BULL.HK', [convertedOrder]);

    await routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'TIMER',
      latestQuote: null,
    });

    expect(cancelOrderIds).toEqual([]);
    expect(native.nativeMutations().filter((entry) => entry.kind === 'SUBMIT')).toHaveLength(1);
  });

  it('卖单等待阶段遇到非法终态快照时会阻断本轮后续动作', async () => {
    const runtime = createRuntimeStore();
    const invalidTerminalState = {
      closedReason: 'UNKNOWN',
      source: 'WS',
      executedPrice: null,
      executedAmount: '0',
      executedQuantity: null,
      executedTimeMs: null,
    } as unknown as NonNullable<OrderMonitorTrackedOrder['timeoutMarketConversionTerminalState']>;
    attachTrackedOrders(runtime, 'BULL.HK', [
      await createTrackedOrder({
        orderId: 'SELL-PENDING-INVALID-TERMINAL',
        symbol: 'BULL.HK',
        side: 'SELL',
        submittedAt: Date.now() - 10_000,
        timeoutMarketConversionPending: true,
        timeoutMarketConversionTerminalState: invalidTerminalState,
      }),
      await createTrackedOrder({
        orderId: 'SELL-SHOULD-NOT-REPLACE-AFTER-INVALID-TERMINAL',
        symbol: 'BULL.HK',
        side: 'SELL',
        submittedAt: Date.now() - 1_000,
        submittedPrice: '1',
        initialSubmittedPrice: '1',
        lastPriceUpdateAt: 0,
      }),
    ]);
    const replaceOrderIds: string[] = [];
    const { deps } = await createDeps({
      runtime,
      config: createConfig({
        buyTimeoutMs: 60_000,
        sellTimeoutMs: 5_000,
      }),
      replaceOrderPrice: async (orderId) => {
        replaceOrderIds.push(orderId);
      },
    });
    const routeProcessor = createRouteProcessor(deps);

    await routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'QUOTE',
      latestQuote: createQuoteDouble('BULL.HK', '1.02'),
    });

    expect(replaceOrderIds).toEqual([]);
    expect(runtime.trackedOrders.get('SELL-PENDING-INVALID-TERMINAL')?.cancelRetryCount).toBe(1);
  });

  it('卖单 timeout 在剩余数量不明确时会保留 timeout conversion owner 并继续等待或重试', async () => {
    const runtime = createRuntimeStore();
    attachTrackedOrders(runtime, 'BULL.HK', [
      await createTrackedOrder({
        orderId: 'SELL-PENDING-UNKNOWN-REMAINING',
        symbol: 'BULL.HK',
        side: 'SELL',
        status: 'CANCELED',
        submittedAt: Date.now() - 10_000,
        timeoutMarketConversionPending: true,
        timeoutMarketConversionTerminalState: {
          closedReason: 'CANCELED',
          source: 'WS',
          executedPrice: '0',
          executedAmount: '0',
          executedQuantity: null,
          executedTimeMs: Date.now(),
          orderUpdatedAtMs: Date.now(),
        },
      }),
    ]);
    const trackedOrder = runtime.trackedOrders.get('SELL-PENDING-UNKNOWN-REMAINING');
    if (!trackedOrder) {
      throw new Error('missing tracked order for timeout remaining test');
    }

    trackedOrder.cancelRetryCount = 3;
    trackedOrder.nextCancelAttemptAt = Date.now() - 1;

    const { deps, native } = await createDeps({
      runtime,
      settleOrder: () => ({
        handled: true,
        relatedBuyOrderIds: ['BUY-1'],
      }),
      trackOrder: (_params) => {
        throw new Error('should not submit market order when remaining quantity is unknown');
      },
    });
    const routeProcessor = createRouteProcessor(deps);

    await routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'ORDER_EVENT',
      latestQuote: null,
    });

    expect(native.nativeMutations().filter((entry) => entry.kind === 'SUBMIT')).toHaveLength(0);
    expect(trackedOrder.timeoutMarketConversionPending).toBe(true);
    expect(trackedOrder.timeoutMarketConversionTerminalState).not.toBeNull();
    expect(trackedOrder.cancelRetryCount).toBeGreaterThanOrEqual(3);
  });

  it('卖单 timeout 转市价在 broker submit 返回前保持 related buy orders 占用连续', async () => {
    const { runtime, storage, orderRecorder, settlementFlow } =
      await createTimeoutSellHandoffHarness('SELL-TIMEOUT-CONTINUOUS');
    const native = await createNativeFixture();
    const submitStarted = createDeferredValue<null>();
    const submitFinished = createDeferredValue<null>();
    native.setSubmitBehavior(async () => {
      submitStarted.resolve(null);
      await submitFinished.promise;
      return 'FOLLOW-UP';
    });
    const trackedOrders: TrackOrderParams[] = [];
    const { deps } = await createDeps({
      runtime,
      orderRecorder,
      settleOrder: settlementFlow.settleOrder,
      native,
      trackOrder: (params) => {
        trackedOrders.push(params);
      },
    });
    const routeProcessor = createRouteProcessor(deps);

    const processPromise = routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'ORDER_EVENT',
      latestQuote: null,
    });

    await submitStarted.promise;

    const inFlightSellableOrders = storage.selectSellableOrders({
      symbol: 'BULL.HK',
      direction: 'LONG',
      strategy: 'ALL',
      currentPrice: '1.2',
    });
    expect(inFlightSellableOrders.orders).toEqual([]);
    expect(inFlightSellableOrders.totalQuantity).toBe(0);
    expect(storage.getPendingSellSnapshot().map((pendingSell) => pendingSell.orderId)).toEqual([
      'SELL-TIMEOUT-CONTINUOUS',
    ]);

    submitFinished.resolve(null);
    await processPromise;

    const pendingSellSnapshot = storage.getPendingSellSnapshot();
    expect(pendingSellSnapshot).toHaveLength(1);
    expect(pendingSellSnapshot[0]).toMatchObject({
      orderId: 'FOLLOW-UP',
      submittedQuantity: 200,
      relatedBuyOrderIds: ['BUY-1', 'BUY-2'],
    });
    expect(trackedOrders).toHaveLength(1);
  });

  it('卖单 timeout 转市价在 submitOrder 已发起后 reject 时保留 follow-up placeholder', async () => {
    const { runtime, storage, orderRecorder, settlementFlow } =
      await createTimeoutSellHandoffHarness('SELL-TIMEOUT-SUBMIT-RESULT-UNKNOWN');
    const native = await createNativeFixture();
    const submitStarted = createDeferredValue<null>();
    const submitResult = createDeferredValue<string>();
    native.setSubmitBehavior(async () => {
      submitStarted.resolve(null);
      return submitResult.promise;
    });
    const trackedOrders: TrackOrderParams[] = [];
    const { deps } = await createDeps({
      runtime,
      orderRecorder,
      settleOrder: settlementFlow.settleOrder,
      native,
      trackOrder: (params) => {
        trackedOrders.push(params);
      },
    });

    const processPromise = createRouteProcessor(deps).processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'ORDER_EVENT',
      latestQuote: null,
    });
    await submitStarted.promise;
    submitResult.reject(new Error('network unavailable after request'));

    let receivedError: unknown = null;
    try {
      await processPromise;
    } catch (error) {
      receivedError = error;
    }

    expect(receivedError).toMatchObject({
      name: 'ExternalApiRequestError',
      operation: 'TradeContext.submitOrder.timeoutMarketConversion',
    });

    expect(storage.getPendingSellSnapshot().map((pendingSell) => pendingSell.orderId)).toEqual([
      'SELL-TIMEOUT-SUBMIT-RESULT-UNKNOWN',
    ]);
    const sellableOrders = storage.selectSellableOrders({
      symbol: 'BULL.HK',
      direction: 'LONG',
      strategy: 'ALL',
      currentPrice: '1.2',
    });
    expect(sellableOrders.orders).toEqual([]);
    expect(sellableOrders.totalQuantity).toBe(0);
    expect(trackedOrders).toEqual([]);
  });

  it('卖单 timeout 转市价在 mutation permit 抛错时释放 follow-up placeholder', async () => {
    const { runtime, storage, orderRecorder, settlementFlow } =
      await createTimeoutSellHandoffHarness('SELL-TIMEOUT-RATE-LIMITER-FAIL');
    const trackedOrders: TrackOrderParams[] = [];
    const { deps, native } = await createDeps({
      runtime,
      orderRecorder,
      settleOrder: settlementFlow.settleOrder,
      rateLimiter: {
        throttle: async () => {},
        withTradeMutation: async <T>(
          _callback: (permit: TradeMutationPermit) => Promise<T>,
        ): Promise<T> => {
          throw new Error('rate limiter failed before broker accept');
        },
      },
      trackOrder: (params) => {
        trackedOrders.push(params);
      },
    });

    const errorMessage = await captureTimeoutMarketRouteError(deps);
    expect(errorMessage).toContain('rate limiter failed before broker accept');
    expectTimeoutSellOccupancyReleased(storage);
    expect(native.nativeMutations().filter((entry) => entry.kind === 'SUBMIT')).toHaveLength(0);
    expect(trackedOrders).toEqual([]);
  });

  it('卖单 timeout 转市价在取得 mutation permit 后 route generation 失效时释放 follow-up placeholder 且不调用 SDK', async () => {
    const { runtime, storage, orderRecorder, settlementFlow } =
      await createTimeoutSellHandoffHarness('SELL-TIMEOUT-ROUTE-STALE-BEFORE-SUBMIT');
    const { deps, native } = await createDeps({
      runtime,
      orderRecorder,
      settleOrder: settlementFlow.settleOrder,
      rateLimiter: {
        throttle: async () => {},
        withTradeMutation: async <T>(
          callback: (permit: TradeMutationPermit) => Promise<T>,
        ): Promise<T> => {
          runtime.latestRouteGenerationBySymbol.set('BULL.HK', 2);
          return callback({
            invoke: async <TResult>(operation: () => Promise<TResult>): Promise<TResult> =>
              operation(),
          });
        },
      },
      trackOrder: () => {},
    });

    const errorMessage = await captureTimeoutMarketRouteError(deps);

    expect(errorMessage).toBe('');
    expectTimeoutSellOccupancyReleased(storage);
    expect(native.nativeMutations().filter((entry) => entry.kind === 'SUBMIT')).toHaveLength(0);
  });

  it('卖单 timeout 转市价在取得 mutation permit 后连续交易关闭时释放 follow-up placeholder 且不调用 SDK', async () => {
    const { runtime, storage, orderRecorder, settlementFlow } =
      await createTimeoutSellHandoffHarness('SELL-TIMEOUT-CONTINUOUS-CLOSED-BEFORE-SUBMIT');
    let isContinuousTradingAllowed = true;
    const { deps, native } = await createDeps({
      runtime,
      orderRecorder,
      settleOrder: settlementFlow.settleOrder,
      rateLimiter: {
        throttle: async () => {},
        withTradeMutation: async <T>(
          callback: (permit: TradeMutationPermit) => Promise<T>,
        ): Promise<T> => {
          isContinuousTradingAllowed = false;
          return callback({
            invoke: async <TResult>(operation: () => Promise<TResult>): Promise<TResult> =>
              operation(),
          });
        },
      },
      isContinuousTradingAllowed: () => isContinuousTradingAllowed,
      trackOrder: () => {},
    });

    const errorMessage = await captureTimeoutMarketRouteError(deps);

    expect(errorMessage).toBe('');
    expectTimeoutSellOccupancyReleased(storage);
    expect(native.nativeMutations().filter((entry) => entry.kind === 'SUBMIT')).toHaveLength(0);
  });

  it('卖单 timeout 转市价在 broker 已接受后即使 runtime 停止也承认远端订单事实', async () => {
    const { runtime, storage, orderRecorder, settlementFlow } =
      await createTimeoutSellHandoffHarness('SELL-TIMEOUT-STOPPED-AFTER-SUBMIT');
    const native = await createNativeFixture();
    const submitStarted = createDeferredValue<null>();
    const submitFinished = createDeferredValue<null>();
    const trackedOrders: TrackOrderParams[] = [];
    native.setSubmitBehavior(async () => {
      submitStarted.resolve(null);
      await submitFinished.promise;
      return 'FOLLOW-UP';
    });
    const { deps } = await createDeps({
      runtime,
      orderRecorder,
      settleOrder: settlementFlow.settleOrder,
      native,
      trackOrder: (params) => {
        trackedOrders.push(params);
      },
    });
    const routeProcessor = createRouteProcessor(deps);

    const processPromise = routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'ORDER_EVENT',
      latestQuote: null,
    });

    await submitStarted.promise;
    runtime.running = false;
    runtime.runtimeState = 'STOPPED';
    submitFinished.resolve(null);

    await processPromise;
    expect(trackedOrders.map((trackedOrder) => trackedOrder.orderId)).toEqual(['FOLLOW-UP']);
    expect(storage.getPendingSellSnapshot().map((pendingSell) => pendingSell.orderId)).toEqual([
      'FOLLOW-UP',
    ]);
  });

  it('卖单 timeout 转市价在 broker 已接受后即使 route generation 变化也承认远端订单事实', async () => {
    const { runtime, storage, orderRecorder, settlementFlow } =
      await createTimeoutSellHandoffHarness('SELL-TIMEOUT-GENERATION-CHANGED');
    const native = await createNativeFixture();
    const submitStarted = createDeferredValue<null>();
    const submitFinished = createDeferredValue<null>();
    const trackedOrders: TrackOrderParams[] = [];
    native.setSubmitBehavior(async () => {
      submitStarted.resolve(null);
      await submitFinished.promise;
      return 'FOLLOW-UP';
    });
    const { deps } = await createDeps({
      runtime,
      orderRecorder,
      settleOrder: settlementFlow.settleOrder,
      native,
      trackOrder: (params) => {
        trackedOrders.push(params);
      },
    });
    const routeProcessor = createRouteProcessor(deps);

    const processPromise = routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'ORDER_EVENT',
      latestQuote: null,
    });

    await submitStarted.promise;
    const routeState = runtime.routeStatesBySymbol.get('BULL.HK');
    if (routeState) {
      routeState.generation = 2;
    }

    runtime.latestRouteGenerationBySymbol.set('BULL.HK', 2);
    submitFinished.resolve(null);

    await processPromise;
    expect(trackedOrders.map((trackedOrder) => trackedOrder.orderId)).toEqual(['FOLLOW-UP']);
    expect(storage.getPendingSellSnapshot().map((pendingSell) => pendingSell.orderId)).toEqual([
      'FOLLOW-UP',
    ]);
  });

  it('broker ack 后 trackOrder 抛错仍保留旧 placeholder 且错误携带 newOrderId', async () => {
    const { runtime, storage, orderRecorder, settlementFlow } =
      await createTimeoutSellHandoffHarness('SELL-TIMEOUT-TRACK-FAIL');
    const trackAttempts: string[] = [];
    const { deps } = await createDeps({
      runtime,
      orderRecorder,
      settleOrder: settlementFlow.settleOrder,
      trackOrder: (params) => {
        trackAttempts.push(params.orderId);
        throw new Error('track local fact failed');
      },
    });

    const errorMessage = await captureTimeoutMarketRouteError(deps);

    expect(trackAttempts).toEqual(['FOLLOW-UP']);
    expect(errorMessage).toContain('order submitted but local sync failed: FOLLOW-UP');
    expect(storage.getPendingSellSnapshot().map((pendingSell) => pendingSell.orderId)).toEqual([
      'SELL-TIMEOUT-TRACK-FAIL',
    ]);
  });

  it('ORDER_EVENT 唤醒会基于 latestQuote 继续推进 replace', async () => {
    const runtime = createRuntimeStore();
    attachTrackedOrders(runtime, 'BULL.HK', [
      await createTrackedOrder({
        orderId: 'SELL-ORDER-EVENT-REPLACE',
        symbol: 'BULL.HK',
        side: 'SELL',
        submittedAt: Date.now() - 1_000,
        submittedPrice: '1',
        initialSubmittedPrice: '1',
        lastPriceUpdateAt: 0,
      }),
    ]);
    const replaceOrderIds: string[] = [];
    const { deps } = await createDeps({
      runtime,
      config: createConfig({
        buyTimeoutMs: 60_000,
        sellTimeoutMs: 60_000,
      }),
      replaceOrderPrice: async (orderId) => {
        replaceOrderIds.push(orderId);
      },
    });
    const routeProcessor = createRouteProcessor(deps);

    await routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'ORDER_EVENT',
      latestQuote: createQuoteDouble('BULL.HK', '1.02'),
    });

    expect(replaceOrderIds).toEqual(['SELL-ORDER-EVENT-REPLACE']);
  });

  it('TRACKED 唤醒即使带有 latestQuote 也不会触发普通 replace', async () => {
    const runtime = createRuntimeStore();
    attachTrackedOrders(runtime, 'BULL.HK', [
      await createTrackedOrder({
        orderId: 'SELL-TRACKED-NO-REPLACE',
        symbol: 'BULL.HK',
        side: 'SELL',
        submittedAt: Date.now() - 1_000,
        submittedPrice: '1',
        initialSubmittedPrice: '1',
        lastPriceUpdateAt: 0,
      }),
    ]);
    const replaceOrderIds: string[] = [];
    const { deps } = await createDeps({
      runtime,
      config: createConfig({
        buyTimeoutMs: 60_000,
        sellTimeoutMs: 60_000,
      }),
      replaceOrderPrice: async (orderId) => {
        replaceOrderIds.push(orderId);
      },
    });
    const routeProcessor = createRouteProcessor(deps);

    await routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'TRACKED',
      latestQuote: createQuoteDouble('BULL.HK', '1.02'),
    });

    expect(replaceOrderIds).toEqual([]);
  });

  it('TIMER 唤醒会在 replace backoff 到期后基于缓存 latestQuote 补跑 replace', async () => {
    const runtime = createRuntimeStore();
    attachTrackedOrders(runtime, 'BULL.HK', [
      await createTrackedOrder({
        orderId: 'SELL-REPLACE-RETRY-TIMER',
        symbol: 'BULL.HK',
        side: 'SELL',
        submittedAt: Date.now() - 1_000,
        submittedPrice: '1',
        initialSubmittedPrice: '1',
        lastPriceUpdateAt: 0,
        replaceCapability: 'TEMP_BLOCKED_BY_STATUS',
        replaceBlockedUntilAt: Date.now() - 1,
        replaceResumeMode: 'TIME_BACKOFF',
        replaceTempBlockedCount: 1,
      }),
    ]);
    const replaceOrderIds: string[] = [];
    const { deps } = await createDeps({
      runtime,
      config: createConfig({
        buyTimeoutMs: 60_000,
        sellTimeoutMs: 60_000,
      }),
      replaceOrderPrice: async (orderId) => {
        replaceOrderIds.push(orderId);
      },
    });
    const routeProcessor = createRouteProcessor(deps);

    await routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'TIMER',
      latestQuote: createQuoteDouble('BULL.HK', '1.02'),
    });

    expect(replaceOrderIds).toEqual(['SELL-REPLACE-RETRY-TIMER']);
  });

  it('QUOTE 唤醒遇到不可用行情时会推进 quote retry 状态', async () => {
    const originalNow = Date.now;
    const nowMs = Date.parse('2026-04-09T10:00:00.000Z');
    Date.now = () => nowMs - 86_400_000;

    try {
      const runtime = createRuntimeStore();
      attachTrackedOrders(runtime, 'BULL.HK', [
        await createTrackedOrder({
          orderId: 'SELL-QUOTE-RETRY-STATE',
          symbol: 'BULL.HK',
          side: 'SELL',
          submittedAt: nowMs - 1_000,
          submittedPrice: '1',
          initialSubmittedPrice: '1',
          lastPriceUpdateAt: 0,
          quoteRetryAttempts: 0,
          quoteRetryNextAt: null,
          quoteRetryExhausted: false,
        }),
      ]);
      const replaceOrderIds: string[] = [];
      const { deps } = await createDeps({
        runtime,
        now: () => new Date(nowMs),
        config: createConfig({
          buyTimeoutMs: 60_000,
          sellTimeoutMs: 60_000,
        }),
        replaceOrderPrice: async (orderId) => {
          replaceOrderIds.push(orderId);
        },
      });
      const routeProcessor = createRouteProcessor(deps);

      await routeProcessor.processRoute({
        symbol: 'BULL.HK',
        generation: 1,
        wakeupKind: 'QUOTE',
        latestQuote: null,
      });

      expect(replaceOrderIds).toEqual([]);
      const order = runtime.trackedOrders.get('SELL-QUOTE-RETRY-STATE');
      expect(order?.quoteRetryAttempts).toBe(1);
      expect(order?.quoteRetryNextAt).toBe(nowMs + ORDER_QUOTE_RETRY.INTERVAL_MS);
      expect(order?.quoteRetryExhausted).toBe(false);
    } finally {
      Date.now = originalNow;
    }
  });

  it('QUOTE 唤醒遇到无效价格时不会推进 quote retry 状态', async () => {
    const originalNow = Date.now;
    const nowMs = Date.parse('2026-04-09T10:02:00.000Z');
    Date.now = () => nowMs;

    try {
      const runtime = createRuntimeStore();
      attachTrackedOrders(runtime, 'BULL.HK', [
        await createTrackedOrder({
          orderId: 'SELL-INVALID-QUOTE-NO-RETRY',
          symbol: 'BULL.HK',
          side: 'SELL',
          submittedAt: nowMs - 1_000,
          submittedPrice: '1',
          initialSubmittedPrice: '1',
          lastPriceUpdateAt: 0,
          quoteRetryAttempts: 0,
          quoteRetryNextAt: null,
          quoteRetryExhausted: false,
        }),
      ]);
      const replaceOrderIds: string[] = [];
      const { deps } = await createDeps({
        runtime,
        config: createConfig({
          buyTimeoutMs: 60_000,
          sellTimeoutMs: 60_000,
        }),
        replaceOrderPrice: async (orderId) => {
          replaceOrderIds.push(orderId);
        },
      });
      const routeProcessor = createRouteProcessor(deps);

      await routeProcessor.processRoute({
        symbol: 'BULL.HK',
        generation: 1,
        wakeupKind: 'QUOTE',
        latestQuote: createQuoteDouble('BULL.HK', '0'),
      });

      expect(replaceOrderIds).toEqual([]);
      const order = runtime.trackedOrders.get('SELL-INVALID-QUOTE-NO-RETRY');
      expect(order?.quoteRetryAttempts).toBe(0);
      expect(order?.quoteRetryNextAt).toBeNull();
      expect(order?.quoteRetryExhausted).toBe(false);
    } finally {
      Date.now = originalNow;
    }
  });

  it('TIMER 唤醒会在 quote retry 到期后继续推进 quote retry 状态', async () => {
    const originalNow = Date.now;
    const nowMs = Date.parse('2026-04-09T10:05:00.000Z');
    Date.now = () => nowMs;

    try {
      const runtime = createRuntimeStore();
      attachTrackedOrders(runtime, 'BULL.HK', [
        await createTrackedOrder({
          orderId: 'SELL-QUOTE-RETRY-TIMER',
          symbol: 'BULL.HK',
          side: 'SELL',
          submittedAt: nowMs - 1_000,
          submittedPrice: '1',
          initialSubmittedPrice: '1',
          lastPriceUpdateAt: 0,
          quoteRetryAttempts: 1,
          quoteRetryNextAt: nowMs - 1,
          quoteRetryExhausted: false,
        }),
      ]);
      const replaceOrderIds: string[] = [];
      const { deps } = await createDeps({
        runtime,
        config: createConfig({
          buyTimeoutMs: 60_000,
          sellTimeoutMs: 60_000,
        }),
        replaceOrderPrice: async (orderId) => {
          replaceOrderIds.push(orderId);
        },
      });
      const routeProcessor = createRouteProcessor(deps);

      await routeProcessor.processRoute({
        symbol: 'BULL.HK',
        generation: 1,
        wakeupKind: 'TIMER',
        latestQuote: null,
      });

      expect(replaceOrderIds).toEqual([]);
      const order = runtime.trackedOrders.get('SELL-QUOTE-RETRY-TIMER');
      expect(order?.quoteRetryAttempts).toBe(2);
      expect(order?.quoteRetryNextAt).toBe(nowMs + ORDER_QUOTE_RETRY.INTERVAL_MS);
      expect(order?.quoteRetryExhausted).toBe(false);
    } finally {
      Date.now = originalNow;
    }
  });

  it('QUOTE 唤醒拿到有效行情后会清空 quote retry 状态并继续 replace', async () => {
    const originalNow = Date.now;
    const nowMs = Date.parse('2026-04-09T10:08:00.000Z');
    Date.now = () => nowMs;

    try {
      const runtime = createRuntimeStore();
      attachTrackedOrders(runtime, 'BULL.HK', [
        await createTrackedOrder({
          orderId: 'SELL-QUOTE-RETRY-RESET',
          symbol: 'BULL.HK',
          side: 'SELL',
          submittedAt: nowMs - 1_000,
          submittedPrice: '1',
          initialSubmittedPrice: '1',
          lastPriceUpdateAt: 0,
          quoteRetryAttempts: 2,
          quoteRetryNextAt: nowMs + ORDER_QUOTE_RETRY.INTERVAL_MS,
          quoteRetryExhausted: false,
        }),
      ]);
      const replaceOrderIds: string[] = [];
      const { deps } = await createDeps({
        runtime,
        config: createConfig({
          buyTimeoutMs: 60_000,
          sellTimeoutMs: 60_000,
        }),
        replaceOrderPrice: async (orderId) => {
          replaceOrderIds.push(orderId);
        },
      });
      const routeProcessor = createRouteProcessor(deps);

      await routeProcessor.processRoute({
        symbol: 'BULL.HK',
        generation: 1,
        wakeupKind: 'QUOTE',
        latestQuote: createQuoteDouble('BULL.HK', '1.02'),
      });

      expect(replaceOrderIds).toEqual(['SELL-QUOTE-RETRY-RESET']);
      const order = runtime.trackedOrders.get('SELL-QUOTE-RETRY-RESET');
      expect(order?.quoteRetryAttempts).toBe(0);
      expect(order?.quoteRetryNextAt).toBeNull();
      expect(order?.quoteRetryExhausted).toBe(false);
    } finally {
      Date.now = originalNow;
    }
  });

  it('有效 quote 即使因 guard 未触发 replace 也会清空 quote retry 状态', async () => {
    const originalNow = Date.now;
    const nowMs = Date.parse('2026-04-09T10:09:00.000Z');
    Date.now = () => nowMs;

    try {
      const runtime = createRuntimeStore();
      attachTrackedOrders(runtime, 'BULL.HK', [
        await createTrackedOrder({
          orderId: 'BUY-QUOTE-RETRY-GUARD-RESET',
          symbol: 'BULL.HK',
          side: 'BUY',
          submittedAt: nowMs - 1_000,
          submittedPrice: '1',
          initialSubmittedPrice: '1',
          lastPriceUpdateAt: 0,
          quoteRetryAttempts: 2,
          quoteRetryNextAt: nowMs + ORDER_QUOTE_RETRY.INTERVAL_MS,
          quoteRetryExhausted: false,
        }),
      ]);
      const replaceOrderIds: string[] = [];
      const { deps } = await createDeps({
        runtime,
        config: createConfig({
          buyTimeoutMs: 60_000,
          sellTimeoutMs: 60_000,
          allowBuyOrderTrackingAboveInitialPrice: false,
        }),
        replaceOrderPrice: async (orderId) => {
          replaceOrderIds.push(orderId);
        },
      });
      const routeProcessor = createRouteProcessor(deps);

      await routeProcessor.processRoute({
        symbol: 'BULL.HK',
        generation: 1,
        wakeupKind: 'QUOTE',
        latestQuote: createQuoteDouble('BULL.HK', '1.02'),
      });

      expect(replaceOrderIds).toEqual([]);
      const order = runtime.trackedOrders.get('BUY-QUOTE-RETRY-GUARD-RESET');
      expect(order?.quoteRetryAttempts).toBe(0);
      expect(order?.quoteRetryNextAt).toBeNull();
      expect(order?.quoteRetryExhausted).toBe(false);
    } finally {
      Date.now = originalNow;
    }
  });

  it('replace await 内确认 terminal 后订单脱离 route 时保留 evidence，重建后只结算一次', async () => {
    const runtime = createRuntimeStore();
    const trackedOrder = await createTrackedOrder({
      orderId: 'SELL-REPLACE-TERMINAL-DETACHED',
      symbol: 'BULL.HK',
      side: 'SELL',
      submittedAt: Date.now() - 1_000,
      submittedPrice: '1',
      initialSubmittedPrice: '1',
      lastPriceUpdateAt: 0,
    });
    attachTrackedOrders(runtime, 'BULL.HK', [trackedOrder]);
    const terminalExecutionStatus1 = await readTerminalExecutionStatus('Canceled', 0, '0');
    const rawTerminal = {
      executionStatus: terminalExecutionStatus1.executionStatus,
      kind: 'TERMINAL' as const,
      closedReason: 'CANCELED' as const,
      executedPrice: null,
      executedAmount: '0',
      executedQuantity: 0,
      executionTimeMs: null,
      submittedQuantity: 100,
      orderUpdatedAtMs: Date.now(),
      status: terminalExecutionStatus1.status,
    };
    const terminalOutcome: TerminalStateSnapshot = rawTerminal;
    const replaceStateWritten = createDeferredValue<null>();
    const allowReplaceToFinish = createDeferredValue<null>();
    const settlementOrderIds: string[] = [];
    let replaceAttempts = 0;
    const { deps } = await createDeps({
      runtime,
      config: createConfig({ buyTimeoutMs: 60_000, sellTimeoutMs: 60_000 }),
      replaceOrderPrice: async (orderId) => {
        replaceAttempts += 1;
        if (replaceAttempts !== 1) {
          return;
        }

        runtime.queriedTerminalStateByOrderId.set(orderId, rawTerminal);
        setLatestReplaceTerminal(runtime, orderId, terminalOutcome);
        replaceStateWritten.resolve(null);
        await allowReplaceToFinish.promise;
      },
      settleOrder: (params) => {
        settlementOrderIds.push(params.orderId);
        return { handled: true, relatedBuyOrderIds: null };
      },
    });
    const routeProcessor = createRouteProcessor(deps);

    const processPromise = routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'QUOTE',
      latestQuote: createQuoteDouble('BULL.HK', '1.02'),
    });
    await replaceStateWritten.promise;
    runtime.closedOrderIds.add(trackedOrder.orderId);
    allowReplaceToFinish.resolve(null);
    await processPromise;

    expect(settlementOrderIds).toEqual([]);
    expect(runtime.latestReplaceTerminalByOrderId.get(trackedOrder.orderId)).toBe(terminalOutcome);
    expect(runtime.queriedTerminalStateByOrderId.get(trackedOrder.orderId)).toBe(rawTerminal);

    runtime.closedOrderIds.delete(trackedOrder.orderId);
    await routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'ORDER_EVENT',
      latestQuote: createQuoteDouble('BULL.HK', '1.02'),
    });

    expect(settlementOrderIds).toEqual([trackedOrder.orderId]);
    expect(runtime.latestReplaceTerminalByOrderId.has(trackedOrder.orderId)).toBe(false);
    expect(runtime.queriedTerminalStateByOrderId.has(trackedOrder.orderId)).toBe(false);

    await routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'ORDER_EVENT',
      latestQuote: createQuoteDouble('BULL.HK', '1.02'),
    });

    expect(settlementOrderIds).toEqual([trackedOrder.orderId]);
  });

  it('replace terminal 未被 gateway 处理时保留 identity-bound evidence', async () => {
    const runtime = createRuntimeStore();
    const trackedOrder = await createTrackedOrder({
      orderId: 'SELL-REPLACE-TERMINAL-UNHANDLED',
      symbol: 'BULL.HK',
      side: 'SELL',
      submittedAt: Date.now() - 1_000,
      submittedPrice: '1',
      initialSubmittedPrice: '1',
      lastPriceUpdateAt: 0,
    });
    attachTrackedOrders(runtime, 'BULL.HK', [trackedOrder]);
    const terminalExecutionStatus2 = await readTerminalExecutionStatus('Canceled', 0, '0');
    const rawTerminal = {
      executionStatus: terminalExecutionStatus2.executionStatus,
      kind: 'TERMINAL' as const,
      closedReason: 'CANCELED' as const,
      executedPrice: null,
      executedAmount: '0',
      executedQuantity: 0,
      executionTimeMs: null,
      submittedQuantity: 100,
      orderUpdatedAtMs: Date.now(),
      status: terminalExecutionStatus2.status,
    };
    const terminalOutcome: TerminalStateSnapshot = rawTerminal;
    const { deps } = await createDeps({
      runtime,
      config: createConfig({ buyTimeoutMs: 60_000, sellTimeoutMs: 60_000 }),
      replaceOrderPrice: async (orderId) => {
        runtime.queriedTerminalStateByOrderId.set(orderId, rawTerminal);
        setLatestReplaceTerminal(runtime, orderId, terminalOutcome);
      },
      settleOrder: () => ({ handled: false, relatedBuyOrderIds: null }),
    });
    const routeProcessor = createRouteProcessor(deps);

    await routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'QUOTE',
      latestQuote: createQuoteDouble('BULL.HK', '1.02'),
    });

    expect(runtime.latestReplaceTerminalByOrderId.get(trackedOrder.orderId)).toBe(terminalOutcome);
    expect(runtime.queriedTerminalStateByOrderId.get(trackedOrder.orderId)).toBe(rawTerminal);
  });

  it('replace 确认 TERMINAL_CONFIRMED 时会立即结算并消费 outcome', async () => {
    const runtime = createRuntimeStore();
    attachTrackedOrders(runtime, 'BULL.HK', [
      await createTrackedOrder({
        orderId: 'SELL-REPLACE-TERMINAL',
        symbol: 'BULL.HK',
        side: 'SELL',
        submittedAt: Date.now() - 1_000,
        submittedPrice: '1',
        initialSubmittedPrice: '1',
        lastPriceUpdateAt: 0,
      }),
    ]);
    const settlementCalls: Array<{ readonly orderId: string; readonly closedReason: string }> = [];
    const { deps } = await createDeps({
      runtime,
      config: createConfig({
        buyTimeoutMs: 60_000,
        sellTimeoutMs: 60_000,
      }),
      replaceOrderPrice: async (orderId) => {
        const terminalExecutionStatus3 = await readTerminalExecutionStatus('Canceled', 0, '0');
        const rawTerminal = {
          executionStatus: terminalExecutionStatus3.executionStatus,
          kind: 'TERMINAL' as const,
          closedReason: 'CANCELED' as const,
          executedPrice: null,
          executedAmount: '0',
          executedQuantity: 0,
          executionTimeMs: null,
          submittedQuantity: 100,
          orderUpdatedAtMs: Date.now(),
          status: terminalExecutionStatus3.status,
        };
        runtime.queriedTerminalStateByOrderId.set(orderId, rawTerminal);
        setLatestReplaceTerminal(runtime, orderId, rawTerminal);
      },
      settleOrder: (params) => {
        settlementCalls.push({
          orderId: params.orderId,
          closedReason: params.closedReason,
        });
        return {
          handled: true,
          relatedBuyOrderIds: null,
        };
      },
    });
    const routeProcessor = createRouteProcessor(deps);

    await routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'QUOTE',
      latestQuote: createQuoteDouble('BULL.HK', '1.02'),
    });

    expect(settlementCalls).toMatchObject([
      {
        orderId: 'SELL-REPLACE-TERMINAL',
        closedReason: 'CANCELED',
      },
    ]);
    expect(runtime.latestReplaceTerminalByOrderId.has('SELL-REPLACE-TERMINAL')).toBe(false);
  });

  it('replace 终态查询陈旧时使用 tracked 已知的更强成交事实结算', async () => {
    const runtime = createRuntimeStore();
    const trackedExecutedAtMs = Date.parse('2026-04-08T09:00:00.200Z');
    attachTrackedOrders(runtime, 'BULL.HK', [
      await createTrackedOrder({
        orderId: 'SELL-REPLACE-STALE-TERMINAL',
        symbol: 'BULL.HK',
        side: 'SELL',
        submittedAt: Date.now() - 1_000,
        lastPriceUpdateAt: 0,
        executedQuantity: 50,
        executedPrice: '1.05',
        executedAmount: exactMultiply('1.05', String(50)),
        lastExecutedTimeMs: trackedExecutedAtMs,
        lastOrderUpdateAtMs: trackedExecutedAtMs,
        status: 'PARTIALLY_FILLED',
      }),
    ]);
    const settlementCalls: Array<
      Readonly<{
        executedPrice?: string | null;
        executedQuantity?: number | null;
        executedTimeMs?: number | null;
        orderUpdatedAtMs?: number | null;
      }>
    > = [];
    const { deps } = await createDeps({
      runtime,
      config: createConfig({ buyTimeoutMs: 60_000, sellTimeoutMs: 60_000 }),
      replaceOrderPrice: async (orderId) => {
        const terminalExecutionStatus4 = await readTerminalExecutionStatus('Canceled', 20, '0.9');
        const rawTerminal = {
          executionStatus: terminalExecutionStatus4.executionStatus,
          kind: 'TERMINAL' as const,
          closedReason: 'CANCELED' as const,
          executedPrice: '0.9',
          executedAmount: exactMultiply('0.9', String(20)),
          executedQuantity: 20,
          executionTimeMs: trackedExecutedAtMs - 200,
          submittedQuantity: 100,
          orderUpdatedAtMs: trackedExecutedAtMs - 100,
          status: terminalExecutionStatus4.status,
        };
        runtime.queriedTerminalStateByOrderId.set(orderId, rawTerminal);
        setLatestReplaceTerminal(runtime, orderId, rawTerminal);
      },
      settleOrder: (params) => {
        settlementCalls.push(params);
        return { handled: true, relatedBuyOrderIds: null };
      },
    });

    await createRouteProcessor(deps).processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'QUOTE',
      latestQuote: createQuoteDouble('BULL.HK', '1.02'),
    });

    expect(settlementCalls).toMatchObject([
      {
        executedPrice: '1.05',
        executedAmount: exactMultiply('1.05', String(50)),
        executedQuantity: 50,
        executedTimeMs: trackedExecutedAtMs,
        orderUpdatedAtMs: trackedExecutedAtMs,
      },
    ]);
  });

  it('replace 等量较新终态可修订成交价但不推进成交时间', async () => {
    const runtime = createRuntimeStore();
    const trackedExecutedAtMs = Date.parse('2026-04-08T09:00:00.100Z');
    const terminalRevisionAtMs = Date.parse('2026-04-08T09:00:00.200Z');
    attachTrackedOrders(runtime, 'BULL.HK', [
      await createTrackedOrder({
        orderId: 'SELL-REPLACE-EQUAL-QTY-PRICE-REVISION',
        symbol: 'BULL.HK',
        side: 'SELL',
        submittedAt: Date.now() - 1_000,
        lastPriceUpdateAt: 0,
        executedQuantity: 40,
        executedPrice: '1',
        executedAmount: exactMultiply('1', String(40)),
        lastExecutedTimeMs: trackedExecutedAtMs,
        lastOrderUpdateAtMs: trackedExecutedAtMs,
        status: 'PARTIALLY_FILLED',
      }),
    ]);
    const settlementCalls: FinalizeOrderSettlementParams[] = [];
    const { deps } = await createDeps({
      runtime,
      config: createConfig({ buyTimeoutMs: 60_000, sellTimeoutMs: 60_000 }),
      replaceOrderPrice: async (orderId) => {
        const terminalExecutionStatus5 = await readTerminalExecutionStatus('Canceled', 40, '1.1');
        const rawTerminal = {
          executionStatus: terminalExecutionStatus5.executionStatus,
          kind: 'TERMINAL' as const,
          closedReason: 'CANCELED' as const,
          executedPrice: '1.1',
          executedAmount: exactMultiply('1.1', String(40)),
          executedQuantity: 40,
          executionTimeMs: trackedExecutedAtMs,
          submittedQuantity: 100,
          orderUpdatedAtMs: terminalRevisionAtMs,
          status: terminalExecutionStatus5.status,
        };
        runtime.queriedTerminalStateByOrderId.set(orderId, rawTerminal);
        setLatestReplaceTerminal(runtime, orderId, rawTerminal);
      },
      settleOrder: (params) => {
        settlementCalls.push(params);
        return { handled: true, relatedBuyOrderIds: null };
      },
    });

    await createRouteProcessor(deps).processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'QUOTE',
      latestQuote: createQuoteDouble('BULL.HK', '1.02'),
    });

    expect(settlementCalls).toMatchObject([
      {
        executedPrice: '1.1',
        executedAmount: exactMultiply('1.1', String(40)),
        executedQuantity: 40,
        executedTimeMs: trackedExecutedAtMs,
        orderUpdatedAtMs: terminalRevisionAtMs,
      },
    ]);
  });

  it('replace 终态查询成交量更大但 revision 更旧时在结算前拒绝伪造事实', async () => {
    const runtime = createRuntimeStore();
    const trackedExecutedAtMs = Date.parse('2026-04-08T09:00:00.200Z');
    attachTrackedOrders(runtime, 'BULL.HK', [
      await createTrackedOrder({
        orderId: 'SELL-REPLACE-NEW-QTY-OLD-REVISION',
        symbol: 'BULL.HK',
        side: 'SELL',
        submittedAt: Date.now() - 1_000,
        lastPriceUpdateAt: 0,
        executedQuantity: 50,
        executedPrice: '1.05',
        executedAmount: exactMultiply('1.05', String(50)),
        lastExecutedTimeMs: trackedExecutedAtMs,
        lastOrderUpdateAtMs: trackedExecutedAtMs,
        status: 'PARTIALLY_FILLED',
      }),
    ]);
    const settlementCalls: Array<
      Readonly<{
        executedPrice?: string | null;
        executedQuantity?: number | null;
        executedTimeMs?: number | null;
        orderUpdatedAtMs?: number | null;
      }>
    > = [];
    const { deps } = await createDeps({
      runtime,
      config: createConfig({ buyTimeoutMs: 60_000, sellTimeoutMs: 60_000 }),
      replaceOrderPrice: async (orderId) => {
        const terminalExecutionStatus6 = await readTerminalExecutionStatus('Canceled', 80, '0.9');
        const rawTerminal = {
          executionStatus: terminalExecutionStatus6.executionStatus,
          kind: 'TERMINAL' as const,
          closedReason: 'CANCELED' as const,
          executedPrice: '0.9',
          executedAmount: exactMultiply('0.9', String(80)),
          executedQuantity: 80,
          executionTimeMs: trackedExecutedAtMs - 200,
          submittedQuantity: 100,
          orderUpdatedAtMs: trackedExecutedAtMs - 100,
          status: terminalExecutionStatus6.status,
        };
        runtime.queriedTerminalStateByOrderId.set(orderId, rawTerminal);
        setLatestReplaceTerminal(runtime, orderId, rawTerminal);
      },
      settleOrder: (params) => {
        settlementCalls.push(params);
        return { handled: true, relatedBuyOrderIds: null };
      },
    });

    let caughtError: unknown = null;
    try {
      await createRouteProcessor(deps).processRoute({
        symbol: 'BULL.HK',
        generation: 1,
        wakeupKind: 'QUOTE',
        latestQuote: createQuoteDouble('BULL.HK', '1.02'),
      });
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toHaveProperty('message', '[订单监控] 累计成交推进但 broker revision 倒退');
    expect(settlementCalls).toEqual([]);
    expect(runtime.closedOrderIds.has('SELL-REPLACE-NEW-QTY-OLD-REVISION')).toBe(false);
    expect(runtime.trackedOrders.get('SELL-REPLACE-NEW-QTY-OLD-REVISION')).toMatchObject({
      executedQuantity: 50,
      executedPrice: '1.05',
      executedAmount: exactMultiply('1.05', String(50)),
      lastExecutedTimeMs: trackedExecutedAtMs,
      lastOrderUpdateAtMs: trackedExecutedAtMs,
    });
  });

  it('买单 timeout 在 cancel 返回 ALREADY_CLOSED 时会立即结算', async () => {
    const runtime = createRuntimeStore();
    attachTrackedOrders(runtime, 'BULL.HK', [
      await createTrackedOrder({
        orderId: 'BUY-TIMEOUT-ALREADY-CLOSED',
        symbol: 'BULL.HK',
        side: 'BUY',
      }),
    ]);

    const terminalExecutionStatus7 = await readTerminalExecutionStatus('Canceled', 0, '0');
    runtime.queriedTerminalStateByOrderId.set('BUY-TIMEOUT-ALREADY-CLOSED', {
      executionStatus: terminalExecutionStatus7.executionStatus,
      kind: 'TERMINAL',
      closedReason: 'CANCELED',
      executedPrice: null,
      executedAmount: '0',
      executedQuantity: 0,
      executionTimeMs: null,
      submittedQuantity: 100,
      orderUpdatedAtMs: Date.now(),
      status: terminalExecutionStatus7.status,
    });
    const settlementCalls: Array<{ readonly orderId: string; readonly closedReason: string }> = [];
    const { deps } = await createDeps({
      runtime,
      cancelOrder: async () => ({
        kind: 'ALREADY_CLOSED',
        closedReason: 'CANCELED',
        relatedBuyOrderIds: null,
        terminalExecution: {
          submittedQuantity: 100,
          executedQuantity: 0,
        },
      }),
      settleOrder: (params) => {
        settlementCalls.push({
          orderId: params.orderId,
          closedReason: params.closedReason,
        });
        return {
          handled: true,
          relatedBuyOrderIds: null,
        };
      },
    });
    const routeProcessor = createRouteProcessor(deps);

    await routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'TIMER',
      latestQuote: null,
    });

    expect(settlementCalls).toMatchObject([
      {
        orderId: 'BUY-TIMEOUT-ALREADY-CLOSED',
        closedReason: 'CANCELED',
      },
    ]);
  });

  it('买单 timeout 终态查询陈旧时不否认 tracked 已知部分成交', async () => {
    const runtime = createRuntimeStore();
    const trackedExecutedAtMs = Date.parse('2026-04-08T09:00:00.200Z');
    attachTrackedOrders(runtime, 'BULL.HK', [
      await createTrackedOrder({
        orderId: 'BUY-TIMEOUT-STALE-TERMINAL',
        symbol: 'BULL.HK',
        side: 'BUY',
        executedQuantity: 50,
        executedPrice: '1.05',
        executedAmount: exactMultiply('1.05', String(50)),
        lastExecutedTimeMs: trackedExecutedAtMs,
        lastOrderUpdateAtMs: trackedExecutedAtMs,
        status: 'PARTIALLY_FILLED',
      }),
    ]);

    const terminalExecutionStatus8 = await readTerminalExecutionStatus('Canceled', 20, '0.9');
    runtime.queriedTerminalStateByOrderId.set('BUY-TIMEOUT-STALE-TERMINAL', {
      executionStatus: terminalExecutionStatus8.executionStatus,
      kind: 'TERMINAL',
      closedReason: 'CANCELED',
      executedPrice: '0.9',
      executedAmount: exactMultiply('0.9', String(20)),
      executedQuantity: 20,
      executionTimeMs: trackedExecutedAtMs - 200,
      submittedQuantity: 100,
      orderUpdatedAtMs: trackedExecutedAtMs - 100,
      status: terminalExecutionStatus8.status,
    });
    const settlementCalls: Array<
      Readonly<{
        executedPrice?: string | null;
        executedQuantity?: number | null;
        executedTimeMs?: number | null;
        orderUpdatedAtMs?: number | null;
      }>
    > = [];
    const { deps } = await createDeps({
      runtime,
      cancelOrder: async () => ({
        kind: 'ALREADY_CLOSED',
        closedReason: 'CANCELED',
        relatedBuyOrderIds: null,
        terminalExecution: {
          submittedQuantity: 100,
          executedQuantity: 20,
        },
      }),
      settleOrder: (params) => {
        settlementCalls.push(params);
        return { handled: true, relatedBuyOrderIds: null };
      },
    });

    await createRouteProcessor(deps).processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'TIMER',
      latestQuote: null,
    });

    expect(settlementCalls).toMatchObject([
      {
        executedPrice: '1.05',
        executedAmount: exactMultiply('1.05', String(50)),
        executedQuantity: 50,
        executedTimeMs: trackedExecutedAtMs,
        orderUpdatedAtMs: trackedExecutedAtMs,
      },
    ]);
  });

  it('保护性 SELL timeout state-check 的原始 executedQuantity 为 null 时不得由 tracked 部分成交收口', async () => {
    const runtime = createRuntimeStore();
    const trackedExecutionMs = Date.parse('2026-04-08T09:00:00.200Z');
    const trackedOrder = await createTrackedOrder({
      orderId: 'SELL-PROTECTIVE-STATE-CHECK-NULL-QUANTITY',
      symbol: 'BULL.HK',
      side: 'SELL',
      isProtectiveLiquidation: true,
      submittedAt: Date.now() - 1_000,
      submittedQuantity: 100,
      executedQuantity: 40,
      executedPrice: '1.02',
      executedAmount: exactMultiply('1.02', String(40)),
      lastExecutedTimeMs: trackedExecutionMs,
      lastOrderUpdateAtMs: trackedExecutionMs,
      status: 'PARTIALLY_FILLED',
    });
    attachTrackedOrders(runtime, 'BULL.HK', [trackedOrder]);
    const terminalExecutionStatus9 = await readTerminalExecutionStatus('Canceled', 0, '1.02');
    runtime.queriedTerminalStateByOrderId.set(trackedOrder.orderId, {
      executionStatus: terminalExecutionStatus9.executionStatus,
      kind: 'TERMINAL',
      closedReason: 'CANCELED',
      executedPrice: '1.02',
      executedAmount: '0',
      executedQuantity: null,
      executionTimeMs: null,
      submittedQuantity: 100,
      orderUpdatedAtMs: trackedExecutionMs + 1_000,
      status: terminalExecutionStatus9.status,
    });
    let settlementCalls = 0;
    const { deps } = await createDeps({
      runtime,
      cancelOrder: async () => ({
        kind: 'ALREADY_CLOSED',
        closedReason: 'CANCELED',
        relatedBuyOrderIds: null,
        terminalExecution: {
          submittedQuantity: 100,
          executedQuantity: null,
        },
      }),
      settleOrder: () => {
        settlementCalls += 1;
        return { handled: true, relatedBuyOrderIds: null };
      },
    });

    let caughtError: unknown = null;
    try {
      await createRouteProcessor(deps).processRoute({
        symbol: 'BULL.HK',
        generation: 1,
        wakeupKind: 'TIMER',
        latestQuote: null,
      });
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(Error);
    expect(caughtError).toHaveProperty('message', '[订单监控] 无效累计成交数量');

    expect(settlementCalls).toBe(0);
    expect(runtime.closedOrderIds.has(trackedOrder.orderId)).toBe(false);
    expect(runtime.trackedOrders.get(trackedOrder.orderId)).toMatchObject({
      status: 'PARTIALLY_FILLED',
      executedQuantity: 40,
      executedPrice: '1.02',
      executedAmount: exactMultiply('1.02', String(40)),
      lastExecutedTimeMs: trackedExecutionMs,
      lastOrderUpdateAtMs: trackedExecutionMs,
    });
  });

  it('保护性 SELL state-check 的等量终态可用已确认事实完成结算', async () => {
    const runtime = createRuntimeStore();
    const trackedExecutionMs = Date.parse('2026-04-08T09:00:00.200Z');
    const trackedOrder = await createTrackedOrder({
      orderId: 'SELL-PROTECTIVE-STATE-CHECK-EQUAL-QUANTITY',
      symbol: 'BULL.HK',
      side: 'SELL',
      isProtectiveLiquidation: true,
      submittedAt: Date.now() - 1_000,
      submittedQuantity: 40,
      executedQuantity: 40,
      executedPrice: '1.02',
      executedAmount: exactMultiply('1.02', String(40)),
      lastExecutedTimeMs: trackedExecutionMs,
      lastOrderUpdateAtMs: trackedExecutionMs,
      status: 'PARTIALLY_FILLED',
    });
    attachTrackedOrders(runtime, 'BULL.HK', [trackedOrder]);
    const terminalExecutionStatus10 = await readTerminalExecutionStatus('Canceled', 40, '1.02');
    const rawTerminal = {
      executionStatus: terminalExecutionStatus10.executionStatus,
      kind: 'TERMINAL' as const,
      closedReason: 'CANCELED' as const,
      executedPrice: null,
      executedAmount: '0',
      executedQuantity: 40,
      executionTimeMs: 190,
      submittedQuantity: 40,
      orderUpdatedAtMs: null,
      status: terminalExecutionStatus10.status,
    };
    runtime.queriedTerminalStateByOrderId.set(trackedOrder.orderId, rawTerminal);
    setLatestReplaceTerminal(runtime, trackedOrder.orderId, rawTerminal);
    const settlementCalls: FinalizeOrderSettlementParams[] = [];
    const { deps } = await createDeps({
      runtime,
      cancelOrder: async () => ({
        kind: 'ALREADY_CLOSED',
        closedReason: 'CANCELED',
        relatedBuyOrderIds: null,
        terminalExecution: {
          submittedQuantity: 40,
          executedQuantity: 40,
        },
      }),
      settleOrder: (params) => {
        settlementCalls.push(params);
        return { handled: true, relatedBuyOrderIds: null };
      },
    });

    await createRouteProcessor(deps).processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'QUOTE',
      latestQuote: createQuoteDouble('BULL.HK', '1.02'),
    });

    expect(settlementCalls).toEqual([
      {
        orderId: trackedOrder.orderId,
        closedReason: 'CANCELED',
        source: 'STATE_CHECK',
        executedPrice: '1.02',
        executedAmount: exactMultiply('1.02', String(40)),
        executedQuantity: 40,
        executedTimeMs: trackedExecutionMs,
        orderUpdatedAtMs: trackedExecutionMs,
      },
    ]);
    expect(runtime.queriedTerminalStateByOrderId.has(trackedOrder.orderId)).toBe(false);
  });

  it('卖单 timeout 使用规范化成交量计算补卖数量', async () => {
    const runtime = createRuntimeStore();
    const trackedExecutedAtMs = Date.parse('2026-04-08T09:00:00.200Z');
    attachTrackedOrders(runtime, 'BULL.HK', [
      await createTrackedOrder({
        orderId: 'SELL-TIMEOUT-NORMALIZED-REMAINDER',
        symbol: 'BULL.HK',
        side: 'SELL',
        submittedQuantity: 100,
        executedQuantity: 50,
        executedPrice: '1.05',
        executedAmount: exactMultiply('1.05', String(50)),
        lastExecutedTimeMs: trackedExecutedAtMs,
        lastOrderUpdateAtMs: trackedExecutedAtMs,
        status: 'PARTIALLY_FILLED',
      }),
    ]);

    const terminalExecutionStatus11 = await readTerminalExecutionStatus('Canceled', 20, '0.9');
    runtime.queriedTerminalStateByOrderId.set('SELL-TIMEOUT-NORMALIZED-REMAINDER', {
      executionStatus: terminalExecutionStatus11.executionStatus,
      kind: 'TERMINAL',
      closedReason: 'CANCELED',
      executedPrice: '0.9',
      executedAmount: exactMultiply('0.9', String(20)),
      executedQuantity: 20,
      executionTimeMs: trackedExecutedAtMs - 200,
      submittedQuantity: 100,
      orderUpdatedAtMs: trackedExecutedAtMs - 100,
      status: terminalExecutionStatus11.status,
    });
    const trackedOrders: TrackOrderParams[] = [];
    const { deps } = await createDeps({
      runtime,
      cancelOrder: async () => ({
        kind: 'ALREADY_CLOSED',
        closedReason: 'CANCELED',
        relatedBuyOrderIds: null,
        terminalExecution: {
          submittedQuantity: 100,
          executedQuantity: 20,
        },
      }),
      settleOrder: () => ({ handled: true, relatedBuyOrderIds: ['BUY-1'] }),
      trackOrder: (params) => {
        trackedOrders.push(params);
      },
    });

    await createRouteProcessor(deps).processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'TIMER',
      latestQuote: null,
    });

    expect(trackedOrders).toHaveLength(1);
    expect(trackedOrders[0]?.quantity).toBe(50);
  });

  it('route generation 已推进时，旧的 timeout->market continuation 不会再提交 MO', async () => {
    const runtime = createRuntimeStore();
    attachTrackedOrders(runtime, 'BULL.HK', [
      await createTrackedOrder({
        orderId: 'SELL-STALE-CONVERT',
        symbol: 'BULL.HK',
        side: 'SELL',
        status: 'CANCELED',
        timeoutMarketConversionPending: true,
        timeoutMarketConversionTerminalState: {
          closedReason: 'CANCELED',
          source: 'WS',
          executedPrice: '0',
          executedAmount: exactMultiply('0', String(0)),
          executedQuantity: 0,
          executedTimeMs: null,
          orderUpdatedAtMs: Date.parse('2026-04-08T09:00:01.000Z'),
        },
      }),
    ]);

    const native = await createNativeFixture();
    const deferredPermit = createDeferredValue<null>();
    const trackedOrders: TrackOrderParams[] = [];
    const nextOrder = await createTrackedOrder({
      orderId: 'SELL-NEWER-GENERATION',
      symbol: 'BULL.HK',
      side: 'SELL',
      submittedAt: Date.now(),
    });
    const { deps } = await createDeps({
      runtime,
      native,
      rateLimiter: {
        throttle: async () => {},
        withTradeMutation: async <T>(
          callback: (permit: TradeMutationPermit) => Promise<T>,
        ): Promise<T> => {
          await deferredPermit.promise;
          return callback({
            invoke: async <TResult>(operation: () => Promise<TResult>): Promise<TResult> =>
              operation(),
          });
        },
      },
      trackOrder: (params) => {
        trackedOrders.push(params);
      },
      settleOrder: () => {
        runtime.trackedOrders.delete('SELL-STALE-CONVERT');
        runtime.trackedOrderLifecycles.set('SELL-STALE-CONVERT', 'CLOSED');
        runtime.closedOrderIds.add('SELL-STALE-CONVERT');
        runtime.trackedOrderIdsBySymbol.delete('BULL.HK');
        runtime.routeStatesBySymbol.delete('BULL.HK');

        runtime.trackedOrders.set(nextOrder.orderId, nextOrder);
        runtime.trackedOrderLifecycles.set(nextOrder.orderId, 'OPEN');
        runtime.trackedOrderIdsBySymbol.set('BULL.HK', new Set([nextOrder.orderId]));
        runtime.routeStatesBySymbol.set('BULL.HK', {
          symbol: 'BULL.HK',
          generation: 2,
          inFlight: false,
          dirty: false,
          latestQuote: null,
          pendingWakeupKind: null,
          timerHandles: new Map(),
        });
        runtime.latestRouteGenerationBySymbol.set('BULL.HK', 2);

        return {
          handled: true,
          relatedBuyOrderIds: ['BUY-1'],
        };
      },
    });
    const routeProcessor = createRouteProcessor(deps);

    const processPromise = routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'ORDER_EVENT',
      latestQuote: null,
    });

    deferredPermit.resolve(null);
    await processPromise;

    expect(native.nativeMutations().filter((entry) => entry.kind === 'SUBMIT')).toHaveLength(0);
    expect(trackedOrders).toEqual([]);
  });

  it.each(['FILLED', 'CANCELED'] as const)(
    '保护性 SELL timeout 收到 ALREADY_CLOSED/%s 但无 raw terminal snapshot 时阻断 route',
    async (closedReason) => {
      const runtime = createRuntimeStore();
      const trackedOrder = await createTrackedOrder({
        orderId: `SELL-PROTECTIVE-NO-RAW-${closedReason}`,
        symbol: 'BULL.HK',
        side: 'SELL',
        status: 'PARTIALLY_FILLED',
        submittedAt: Date.now() - 10_000,
        isProtectiveLiquidation: true,
        executedQuantity: 40,
        executedPrice: '1.02',
        executedAmount: exactMultiply('1.02', String(40)),
        lastExecutedTimeMs: 190,
        lastOrderUpdateAtMs: 200,
      });
      attachTrackedOrders(runtime, 'BULL.HK', [trackedOrder]);
      const native = await createNativeFixture();
      let cancelCalls = 0;
      let settlementCalls = 0;
      const { deps } = await createDeps({
        runtime,
        native,
        cancelOrder: async () => {
          cancelCalls += 1;
          return {
            kind: 'ALREADY_CLOSED',
            closedReason,
            relatedBuyOrderIds: null,
            terminalExecution: {
              submittedQuantity: 100,
              executedQuantity: null,
            },
          };
        },
        settleOrder: () => {
          settlementCalls += 1;
          return { handled: true, relatedBuyOrderIds: ['BUY-1'] };
        },
      });

      let caughtError: unknown = null;
      try {
        await createRouteProcessor(deps).processRoute({
          symbol: 'BULL.HK',
          generation: 1,
          wakeupKind: 'TIMER',
          latestQuote: null,
        });
      } catch (error) {
        caughtError = error;
      }

      expect(caughtError).toBeInstanceOf(Error);
      expect(caughtError).toHaveProperty('message', expect.stringMatching(/raw terminal snapshot/));
      expect(settlementCalls).toBe(0);
      expect(native.nativeMutations().filter((entry) => entry.kind === 'SUBMIT')).toHaveLength(0);
      expect(cancelCalls).toBe(1);
      expect(trackedOrder.nextCancelAttemptAt).toBe(ORDER_MONITOR_WAIT_WS_ONLY_BLOCK_UNTIL_MS);
      expect(runtime.closedOrderIds.has(trackedOrder.orderId)).toBe(false);
    },
  );

  it('保护性 SELL terminal raw 校验失败后保留 terminal snapshot，不允许用 tracked 事实改写', async () => {
    const runtime = createRuntimeStore();
    const trackedOrder = await createTrackedOrder({
      orderId: 'SELL-PROTECTIVE-INVALID-RAW-RETAINED',
      symbol: 'BULL.HK',
      side: 'SELL',
      status: 'PARTIALLY_FILLED',
      submittedAt: Date.now() - 10_000,
      isProtectiveLiquidation: true,
      executedQuantity: 40,
      executedPrice: '1.02',
      executedAmount: exactMultiply('1.02', String(40)),
      lastExecutedTimeMs: 190,
      lastOrderUpdateAtMs: 200,
    });
    attachTrackedOrders(runtime, 'BULL.HK', [trackedOrder]);
    const terminalExecutionStatus12 = await readTerminalExecutionStatus('Filled', 0, '1.02');
    const rawTerminal = {
      executionStatus: terminalExecutionStatus12.executionStatus,
      kind: 'TERMINAL' as const,
      closedReason: 'FILLED' as const,
      status: terminalExecutionStatus12.status,
      submittedQuantity: 100,
      executedQuantity: null,
      executionTimeMs: null,
      executedPrice: '1.02',
      executedAmount: '0',
      orderUpdatedAtMs: 300,
    };
    runtime.queriedTerminalStateByOrderId.set(trackedOrder.orderId, rawTerminal);
    let settlementCalls = 0;
    const { deps } = await createDeps({
      runtime,
      cancelOrder: async () => ({
        kind: 'ALREADY_CLOSED',
        closedReason: 'FILLED',
        relatedBuyOrderIds: null,
        terminalExecution: {
          submittedQuantity: 100,
          executedQuantity: null,
        },
      }),
      settleOrder: () => {
        settlementCalls += 1;
        return { handled: true, relatedBuyOrderIds: null };
      },
    });

    let caughtError: unknown = null;
    try {
      await createRouteProcessor(deps).processRoute({
        symbol: 'BULL.HK',
        generation: 1,
        wakeupKind: 'TIMER',
        latestQuote: null,
      });
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(Error);
    expect(caughtError).toHaveProperty('message', '[订单监控] 无效累计成交数量');
    expect(runtime.queriedTerminalStateByOrderId.get(trackedOrder.orderId)).toBe(rawTerminal);
    expect(settlementCalls).toBe(0);
    expect(runtime.closedOrderIds.has(trackedOrder.orderId)).toBe(false);
  });

  it('保护性 SELL terminal 本地结算失败后保留同一 raw snapshot，重试成功只确认一次', async () => {
    const runtime = createRuntimeStore();
    const trackedOrder = await createTrackedOrder({
      orderId: 'SELL-PROTECTIVE-SETTLEMENT-RETRY',
      symbol: 'BULL.HK',
      side: 'SELL',
      status: 'PARTIALLY_FILLED',
      submittedAt: Date.now() - 10_000,
      isProtectiveLiquidation: true,
      executedQuantity: 40,
      executedPrice: '1.02',
      executedAmount: exactMultiply('1.02', String(40)),
      lastExecutedTimeMs: 190,
      lastOrderUpdateAtMs: 200,
    });
    attachTrackedOrders(runtime, 'BULL.HK', [trackedOrder]);
    const terminalExecutionStatus13 = await readTerminalExecutionStatus('Filled', 80, '1.01');
    const rawTerminal = {
      executionStatus: terminalExecutionStatus13.executionStatus,
      kind: 'TERMINAL' as const,
      closedReason: 'FILLED' as const,
      status: terminalExecutionStatus13.status,
      submittedQuantity: 100,
      executedQuantity: 80,
      executionTimeMs: 250,
      executedPrice: '1.01',
      executedAmount: exactMultiply('1.01', String(80)),
      orderUpdatedAtMs: 300,
    };
    runtime.queriedTerminalStateByOrderId.set(trackedOrder.orderId, rawTerminal);
    const settlementError = new Error('local settlement failed');
    let settlementAttempts = 0;
    let settledCount = 0;
    const { deps } = await createDeps({
      runtime,
      cancelOrder: async () => ({
        kind: 'ALREADY_CLOSED',
        closedReason: 'FILLED',
        relatedBuyOrderIds: null,
        terminalExecution: {
          submittedQuantity: 100,
          executedQuantity: 80,
        },
      }),
      settleOrder: () => {
        settlementAttempts += 1;
        if (settlementAttempts === 1) {
          throw settlementError;
        }

        settledCount += 1;
        return { handled: true, relatedBuyOrderIds: null };
      },
    });
    const routeProcessor = createRouteProcessor(deps);

    let caughtError: unknown = null;
    try {
      await routeProcessor.processRoute({
        symbol: 'BULL.HK',
        generation: 1,
        wakeupKind: 'TIMER',
        latestQuote: null,
      });
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBe(settlementError);
    expect(runtime.queriedTerminalStateByOrderId.get(trackedOrder.orderId)).toBe(rawTerminal);
    expect(runtime.closedOrderIds.has(trackedOrder.orderId)).toBe(false);

    await routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'TIMER',
      latestQuote: null,
    });

    expect(settlementAttempts).toBe(2);
    expect(settledCount).toBe(1);
    expect(runtime.queriedTerminalStateByOrderId.has(trackedOrder.orderId)).toBe(false);
  });

  it('保护性 SELL replace terminal 的本地结算失败后保留 outcome 与 raw snapshot', async () => {
    const runtime = createRuntimeStore();
    const trackedOrder = await createTrackedOrder({
      orderId: 'SELL-PROTECTIVE-REPLACE-OUTCOME-RETRY',
      symbol: 'BULL.HK',
      side: 'SELL',
      status: 'WORKING',
      submittedAt: Date.now(),
      lastPriceUpdateAt: Date.now() - 10_000,
      isProtectiveLiquidation: true,
      executedQuantity: 40,
      executedPrice: '1.02',
      executedAmount: exactMultiply('1.02', String(40)),
      lastExecutedTimeMs: 190,
      lastOrderUpdateAtMs: 200,
    });
    attachTrackedOrders(runtime, 'BULL.HK', [trackedOrder]);
    const terminalExecutionStatus14 = await readTerminalExecutionStatus('Filled', 80, '1.01');
    const rawTerminal = {
      executionStatus: terminalExecutionStatus14.executionStatus,
      kind: 'TERMINAL' as const,
      closedReason: 'FILLED' as const,
      status: terminalExecutionStatus14.status,
      submittedQuantity: 100,
      executedQuantity: 80,
      executionTimeMs: 250,
      executedPrice: '1.01',
      executedAmount: exactMultiply('1.01', String(80)),
      orderUpdatedAtMs: 300,
    };
    const terminalOutcome: TerminalStateSnapshot = rawTerminal;
    runtime.queriedTerminalStateByOrderId.set(trackedOrder.orderId, rawTerminal);
    const settlementError = new Error('replace local settlement failed');
    let settlementAttempts = 0;
    const { deps } = await createDeps({
      runtime,
      config: createConfig({ sellTimeoutMs: 60_000 }),
      replaceOrderPrice: async () => {
        runtime.latestReplaceTerminalByOrderId.set(trackedOrder.orderId, terminalOutcome);
      },
      settleOrder: () => {
        settlementAttempts += 1;
        if (settlementAttempts === 1) {
          throw settlementError;
        }

        return { handled: true, relatedBuyOrderIds: null };
      },
    });
    const routeProcessor = createRouteProcessor(deps);
    const routeParams = {
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'QUOTE' as const,
      latestQuote: createQuoteDouble('BULL.HK', '1.1'),
    };

    let caughtError: unknown = null;
    try {
      await routeProcessor.processRoute(routeParams);
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBe(settlementError);
    expect(runtime.latestReplaceTerminalByOrderId.get(trackedOrder.orderId)).toBe(terminalOutcome);
    expect(runtime.queriedTerminalStateByOrderId.get(trackedOrder.orderId)).toBe(rawTerminal);

    await routeProcessor.processRoute(routeParams);

    expect(settlementAttempts).toBe(2);
    expect(runtime.latestReplaceTerminalByOrderId.has(trackedOrder.orderId)).toBe(false);
    expect(runtime.queriedTerminalStateByOrderId.has(trackedOrder.orderId)).toBe(false);
  });

  it('cancel ALREADY_CLOSED 后 route generation 失效时保留未 ack raw terminal，后续 gateway 只结算一次', async () => {
    const runtime = createRuntimeStore();
    const trackedOrder = await createTrackedOrder({
      orderId: 'SELL-CANCEL-TERMINAL-GENERATION-STALE',
      symbol: 'BULL.HK',
      side: 'SELL',
      submittedAt: Date.now() - 10_000,
    });
    attachTrackedOrders(runtime, 'BULL.HK', [trackedOrder]);
    const terminalExecutionStatus15 = await readTerminalExecutionStatus('Filled', 100, '1.01');
    const rawTerminal = {
      executionStatus: terminalExecutionStatus15.executionStatus,
      kind: 'TERMINAL' as const,
      closedReason: 'FILLED' as const,
      status: terminalExecutionStatus15.status,
      submittedQuantity: 100,
      executedQuantity: 100,
      executionTimeMs: Date.parse('2026-07-13T05:09:59.500Z'),
      executedPrice: '1.01',
      executedAmount: exactMultiply('1.01', String(100)),
      orderUpdatedAtMs: Date.parse('2026-07-13T05:10:00.000Z'),
    };
    let cancelCalls = 0;
    let settlementCalls = 0;
    const marketOrderTracks: TrackOrderParams[] = [];
    const pendingSellReleaseOrderIds: string[] = [];
    const { deps, native } = await createDeps({
      runtime,
      config: createConfig({ buyTimeoutMs: 60_000, sellTimeoutMs: 0 }),
      orderRecorder: createOrderRecorderDouble({
        markSellCancelled: (orderId) => {
          pendingSellReleaseOrderIds.push(orderId);
          return null;
        },
      }),
      cancelOrder: async () => {
        cancelCalls += 1;
        runtime.queriedTerminalStateByOrderId.set(trackedOrder.orderId, rawTerminal);
        runtime.latestRouteGenerationBySymbol.set('BULL.HK', 2);
        return {
          kind: 'ALREADY_CLOSED' as const,
          closedReason: 'FILLED' as const,
          relatedBuyOrderIds: null,
          terminalExecution: {
            submittedQuantity: 100,
            executedQuantity: 100,
          },
        };
      },
      settleOrder: () => {
        settlementCalls += 1;
        return { handled: true, relatedBuyOrderIds: null };
      },
      trackOrder: (params) => {
        marketOrderTracks.push(params);
      },
    });
    const routeProcessor = createRouteProcessor(deps);

    await routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'TIMER',
      latestQuote: null,
    });

    expect(runtime.queriedTerminalStateByOrderId.get(trackedOrder.orderId)).toBe(rawTerminal);
    expect(settlementCalls).toBe(0);
    expect(pendingSellReleaseOrderIds).toEqual([]);
    expect(marketOrderTracks).toEqual([]);
    expect(native.nativeMutations().filter((entry) => entry.kind === 'SUBMIT')).toHaveLength(0);
    expect(cancelCalls).toBe(1);

    runtime.routeStatesBySymbol.get('BULL.HK')!.generation = 2;
    await routeProcessor.processRoute({
      symbol: 'BULL.HK',
      generation: 2,
      wakeupKind: 'TIMER',
      latestQuote: null,
    });

    expect(cancelCalls).toBe(1);
    expect(settlementCalls).toBe(1);
    expect(runtime.queriedTerminalStateByOrderId.has(trackedOrder.orderId)).toBe(false);
    expect(pendingSellReleaseOrderIds).toEqual([]);
    expect(marketOrderTracks).toEqual([]);
    expect(native.nativeMutations().filter((entry) => entry.kind === 'SUBMIT')).toHaveLength(0);
  });

  it('replace TERMINAL_CONFIRMED 后 runtime stop 时保留未 ack outcome 与 raw terminal，重启 gateway 只结算一次', async () => {
    const runtime = createRuntimeStore();
    const trackedOrder = await createTrackedOrder({
      orderId: 'SELL-REPLACE-TERMINAL-RUNTIME-STOPPED',
      symbol: 'BULL.HK',
      side: 'SELL',
      submittedAt: Date.now() - 1_000,
      lastPriceUpdateAt: 0,
    });
    attachTrackedOrders(runtime, 'BULL.HK', [trackedOrder]);
    const terminalExecutionStatus16 = await readTerminalExecutionStatus('Filled', 100, '1.01');
    const rawTerminal = {
      executionStatus: terminalExecutionStatus16.executionStatus,
      kind: 'TERMINAL' as const,
      closedReason: 'FILLED' as const,
      status: terminalExecutionStatus16.status,
      submittedQuantity: 100,
      executedQuantity: 100,
      executionTimeMs: Date.parse('2026-07-13T05:10:59.500Z'),
      executedPrice: '1.01',
      executedAmount: exactMultiply('1.01', String(100)),
      orderUpdatedAtMs: Date.parse('2026-07-13T05:11:00.000Z'),
    };
    const terminalOutcome: TerminalStateSnapshot = rawTerminal;
    let replaceCalls = 0;
    let settlementCalls = 0;
    const marketOrderTracks: TrackOrderParams[] = [];
    const pendingSellReleaseOrderIds: string[] = [];
    const { deps, native } = await createDeps({
      runtime,
      config: createConfig({ buyTimeoutMs: 60_000, sellTimeoutMs: 60_000 }),
      orderRecorder: createOrderRecorderDouble({
        markSellCancelled: (orderId) => {
          pendingSellReleaseOrderIds.push(orderId);
          return null;
        },
      }),
      replaceOrderPrice: async () => {
        replaceCalls += 1;
        runtime.queriedTerminalStateByOrderId.set(trackedOrder.orderId, rawTerminal);
        setLatestReplaceTerminal(runtime, trackedOrder.orderId, terminalOutcome);
        runtime.running = false;
      },
      settleOrder: () => {
        settlementCalls += 1;
        return { handled: true, relatedBuyOrderIds: null };
      },
      trackOrder: (params) => {
        marketOrderTracks.push(params);
      },
    });
    const routeProcessor = createRouteProcessor(deps);
    const routeParams = {
      symbol: 'BULL.HK',
      generation: 1,
      wakeupKind: 'QUOTE' as const,
      latestQuote: createQuoteDouble('BULL.HK', '1.02'),
    };

    await routeProcessor.processRoute(routeParams);

    expect(runtime.latestReplaceTerminalByOrderId.get(trackedOrder.orderId)).toBe(terminalOutcome);
    expect(runtime.queriedTerminalStateByOrderId.get(trackedOrder.orderId)).toBe(rawTerminal);
    expect(settlementCalls).toBe(0);
    expect(pendingSellReleaseOrderIds).toEqual([]);
    expect(marketOrderTracks).toEqual([]);
    expect(native.nativeMutations().filter((entry) => entry.kind === 'SUBMIT')).toHaveLength(0);
    expect(replaceCalls).toBe(1);

    runtime.running = true;
    await routeProcessor.processRoute(routeParams);

    expect(replaceCalls).toBe(1);
    expect(settlementCalls).toBe(1);
    expect(runtime.latestReplaceTerminalByOrderId.has(trackedOrder.orderId)).toBe(false);
    expect(runtime.queriedTerminalStateByOrderId.has(trackedOrder.orderId)).toBe(false);
    expect(pendingSellReleaseOrderIds).toEqual([]);
    expect(marketOrderTracks).toEqual([]);
    expect(native.nativeMutations().filter((entry) => entry.kind === 'SUBMIT')).toHaveLength(0);
  });
});
