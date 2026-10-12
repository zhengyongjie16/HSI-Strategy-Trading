/**
 * sell-flow 集成测试
 *
 * 功能：
 * - 验证卖出流程端到端场景与业务期望。
 */
import { afterEach, describe, expect, it, setSystemTime } from 'bun:test';
import { createBrokerIngressFixture } from './architectureRefactoringP1Native/trade/brokerIngressFixture.js';
import { createSnapshotFixture } from '../main/fixtures/accountPositionSnapshot.js';
import { createPostTradeConsistencyRuntime } from '../../src/app/runtime/createPostTradeConsistencyRuntime.js';
import { createDailyLossOrderAnalysisDeps } from '../../src/core/orderRecorder/index.js';
import { createDailyLossTracker } from '../../src/domain/risk/dailyLossTracker.js';
import type { BrokerIngressInput } from '../infrastructure/longbridge/trade/brokerIngressFixture.js';
import { createSignalProcessor } from '../../src/core/signalProcessor/index.js';
import { createOrderStorage } from '../../src/core/orderRecorder/orderStorage.js';
import { createTradingConfig } from '../../mock/factories/configFactory.js';
import { createSignal } from '../../mock/factories/signalFactory.js';
import {
  createMonitorContextDouble,
  createTraderDouble,
  createTerminationDouble,
  createDailyLossTrackerDouble,
  createLiquidationCooldownTrackerDouble,
  createMarketDataClientDouble,
  createOrderMonitorDouble,
  createOrderRecorderDouble,
  createPositionDouble,
  createProtectiveLiquidationEpisodeTrackerDouble,
  createQuoteDouble,
  createRateLimiterDouble,
  createRiskCheckerDouble,
  createSymbolRegistryDouble,
} from '../helpers/testDoubles.js';
import type { ProcessedSellSignal } from '../../src/core/signalProcessor/types.js';
import type {
  ExecutableSellSignal,
  ProtectiveLiquidationSellSignal,
} from '../../src/types/signal.js';
import type { OrderRecord, OrderRecorder, RateLimiter } from '../../src/types/services.js';
import type { OrderStorage } from '../../src/core/orderRecorder/types.js';
import type { DailyLossTracker } from '../../src/types/risk.js';
import type { PostTradeConsistencyRuntime } from '../../src/app/types.js';
import type { OrderExecutorDeps, OrderMonitor } from '../../src/core/trader/types.js';
import { waitUntil } from '../main/asyncProgram/utils.js';
import { getRequiredHKDateKey, toHongKongTimeIso } from '../../src/utils/time/index.js';

type NativeSellIngress = Awaited<ReturnType<typeof createBrokerIngressFixture>>;
const ownerCleanups: Array<() => Promise<void>> = [];
const monitorDailyOwners = new WeakMap<NativeSellIngress, DailyLossTracker>();
afterEach(async () => {
  for (const cleanup of ownerCleanups.splice(0)) await cleanup();
});

type OrderExecutorTestDeps = Omit<
  OrderExecutorDeps,
  | 'tradeMutationPort'
  | 'readSellPositions'
  | 'isContinuousTradingAllowed'
  | 'now'
  | 'readCurrentTradingDayInfo'
  | 'orderMonitor'
  | 'unrealizedLossBuyGate'
> & {
  readonly orderMonitor: Partial<OrderMonitor>;
  readonly ingress: NativeSellIngress;
} & Partial<
    Pick<
      OrderExecutorDeps,
      'isContinuousTradingAllowed' | 'now' | 'readCurrentTradingDayInfo' | 'unrealizedLossBuyGate'
    >
  >;

async function createOrderExecutor(deps: OrderExecutorTestDeps) {
  const defaultNow = (): Date => {
    const hongKongDate = new Date(Date.now() + 8 * 60 * 60 * 1000);
    return new Date(
      Date.UTC(
        hongKongDate.getUTCFullYear(),
        hongKongDate.getUTCMonth(),
        hongKongDate.getUTCDate(),
        2,
      ),
    );
  };
  const {
    isContinuousTradingAllowed = () => true,
    now = defaultNow,
    readCurrentTradingDayInfo = () => ({
      dateKey: getRequiredHKDateKey(now()),
      info: { isTradingDay: true, isHalfDay: false },
    }),
    unrealizedLossBuyGate = createRiskCheckerDouble(),
    orderMonitor,
    ingress,
    ...remainingDeps
  } = deps;

  const accountService = ingress.createAccountService({ rateLimiter: createRateLimiterDouble() });
  const snapshot = await createSnapshotFixture({
    readPort: accountService,
    account: await accountService.getAccountSnapshot(),
    positions: await accountService.getStockPositions(),
  });
  const dailyLossTracker =
    monitorDailyOwners.get(ingress) ??
    createDailyLossTracker({
      onOwnershipWarning: () => {},
      ...createDailyLossOrderAnalysisDeps(),
      toHongKongTimeIso,
    });
  if (!monitorDailyOwners.has(ingress))
    dailyLossTracker.recalculateFromAllOrders([], deps.tradingConfig.monitor, now(), new Map());

  const monitorContext = createMonitorContextDouble({
    config: deps.tradingConfig.monitor,
    symbolRegistry: deps.symbolRegistry,
    orderRecorder: deps.orderRecorder,
    dailyLossTracker,
  });
  const termination = createTerminationDouble({
    reportFatalError: (error) => {
      throw error;
    },
  });
  const settlement = createPostTradeConsistencyRuntime({
    snapshot,
    termination,
    getTrader: () => createTraderDouble(accountService),
    onPositionsCommitted: async (token) => {
      if (!snapshot.isCurrent(token, { account: true, positions: true, paired: true }))
        throw new Error('SELL paired commit stale');
    },
    scheduler: { scheduleTimer: setTimeout, clearTimer: clearTimeout },
  });
  settlement.bindBusinessDeps({
    monitorContext,
    dailyLossTracker,
    liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
    protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
    mixedTradeLogRepository: {
      appendCompletionIdempotent: () => {
        throw new Error('SELL completion persistence not configured');
      },
    },
  });
  settlement.start();
  expect(await settlement.completeRebuildBaseline()).toBeTrue();
  const receipt = await settlement.waitForFresh();
  const seats = (['LONG', 'SHORT'] as const).map((direction) => ({
    direction,
    version: deps.symbolRegistry.getSeatVersion(direction),
    symbol: deps.symbolRegistry.getSeatState(direction).symbol,
  }));
  const callerAuthorization = () =>
    !termination.isTerminated() &&
    settlement.isCurrent(receipt) &&
    snapshot.isCurrent(receipt.snapshotToken, { account: true, positions: true, paired: true }) &&
    seats.every(
      ({ direction, version, symbol }) =>
        deps.symbolRegistry.getSeatVersion(direction) === version &&
        deps.symbolRegistry.getSeatState(direction).symbol === symbol,
    );
  ownerCleanups.push(settlement.stopAndDrain);
  const executor = ingress.createExecutor({
    ...remainingDeps,
    isContinuousTradingAllowed,
    now,
    readCurrentTradingDayInfo,
    unrealizedLossBuyGate,
    orderMonitor: createOrderMonitorDouble(orderMonitor),
  });
  return { ...executor, callerAuthorization, snapshot, settlement, receipt };
}

/** 卖出新增 paired H 前置明确真实主账户零现金；原数量/可卖量不受资金影响。 */
async function createNativeSellIngress(): Promise<NativeSellIngress> {
  const nowMs = Date.parse('2026-07-11T03:00:00.000Z');
  const ingress = await createBrokerIngressFixture({
    orderId: 'SELL-BASELINE',
    tradeId: 'SELL-BASELINE-trade',
    symbol: 'BULL.HK',
    stockName: 'HSI RC',
    remark: '',
    side: 'SELL',
    status: 'New',
    quantity: '100',
    executedQuantity: '0',
    submittedPrice: '1',
    executedPrice: '0',
    submittedAtMs: nowMs,
    executionTimeMs: null,
    updatedAtMs: nowMs,
  });
  ingress.setAccountBalance({
    currency: 'HKD',
    totalCash: '0',
    netAssets: '0',
    availableCash: '0',
  });
  ingress.setSubmitBehavior(async () => 'MOCK-000001');
  return ingress;
}

/** 原私有SDK持仓fixture的明确中性输入，数量才作文本传输。 */
function nativePositions(params: {
  readonly symbol: string;
  readonly quantity: number;
  readonly availableQuantity: number;
}) {
  return [
    {
      symbol: params.symbol,
      symbolName: params.symbol,
      accountChannel: 'lb_papertrading',
      currency: 'HKD',
      costPrice: '1',
      quantity: String(params.quantity),
      availableQuantity: String(params.availableQuantity),
    },
  ];
}

/** Pending/track SDK元数据仅从真实mapper观察取得，金融字段不由enum模板伪造。 */
async function createNativeOrderFact(orderId: string, orderType: 'ELO' | 'MO') {
  const producer = await createBrokerIngressFixture({
    orderId,
    tradeId: orderId + '-trade',
    symbol: 'BULL.HK',
    stockName: 'HSI RC',
    remark: '',
    side: 'SELL',
    orderType,
    status: 'New',
    quantity: '100',
    executedQuantity: '0',
    submittedPrice: '1',
    executedPrice: '0',
    submittedAtMs: Date.parse('2026-02-25T03:00:00.000Z'),
    executionTimeMs: null,
    updatedAtMs: Date.parse('2026-02-25T03:00:01.000Z'),
  });
  return producer.queryObservation;
}

let seedOrderSequence = 0;

/** 原单价和数量经真实 SDK ledger/mapper 得到成本金额，然后初始化实际 storage。 */
async function seedStorageFromNative(
  storage: OrderStorage,
  symbol: string,
  price: string,
  quantity: number,
  isLong: boolean,
  executedAtMs: number,
) {
  const orderId = `BUY-SEED-${++seedOrderSequence}`;
  const producer = await createBrokerIngressFixture({
    orderId,
    tradeId: `${orderId}-trade`,
    symbol,
    stockName: 'HSI RC',
    remark: 'AUTO',
    side: 'BUY',
    status: 'Filled',
    quantity: String(quantity),
    executedQuantity: String(quantity),
    submittedPrice: price,
    executedPrice: price,
    submittedAtMs: executedAtMs - 1,
    executionTimeMs: executedAtMs,
    updatedAtMs: executedAtMs + 1,
  });
  const [order] = await producer.createQueryOrdersReader()();
  if (order?.executionTimeMs === undefined || order.executionTimeMs === null)
    throw new Error('BUY native seed missing execution');

  const record: OrderRecord = {
    orderId,
    symbol,
    costAmount: order.executedAmount,
    executedQuantity: order.executedQuantity,
    executedTime: order.executionTimeMs,
    submittedAt: order.submittedAt,
    updatedAt: order.updatedAt ?? undefined,
  };
  const rows = [...storage.getBuyOrdersList(symbol, isLong), record];
  if (isLong) storage.setBuyOrdersListForLong(symbol, rows);
  else storage.setBuyOrdersListForShort(symbol, rows);
}

/** 实际 Monitor 活跃生命周期及同ctx push ACK，硬停止必释放原监听/timer。 */
async function createSellMonitor(
  ingress: NativeSellIngress,
  deps: Parameters<NativeSellIngress['createMonitor']>[0],
) {
  deps.dailyLossTracker.recalculateFromAllOrders(
    [],
    deps.tradingConfig.monitor,
    deps.now(),
    new Map(),
  );
  monitorDailyOwners.set(ingress, deps.dailyLossTracker);
  const monitor = ingress.createMonitor(deps);
  await monitor.initialize();
  await monitor.recoverOrderTrackingFromSnapshot([]);
  ownerCleanups.push(monitor.stopRuntimeAndDrain);
  return monitor;
}

/** 创建卖出提交可在 permit 内读取的显式终态行情。 */
function createExecutableQuoteClient() {
  return createMarketDataClientDouble({
    getQuotes: async (symbols) =>
      new Map([...symbols].map((symbol) => [symbol, createQuoteDouble(symbol, '1.1', 100)])),
  });
}

async function withMockedNow<T>(nowMs: number, operation: () => Promise<T>): Promise<T> {
  setSystemTime(nowMs);
  try {
    return await operation();
  } finally {
    setSystemTime();
  }
}

function requireExecutableSellSignals(
  signals: ReadonlyArray<ProcessedSellSignal>,
): ExecutableSellSignal[] {
  return signals.map((signal) => {
    if (signal.action === 'HOLD') {
      throw new Error(`Expected executable sell signal, got ${signal.action}`);
    }

    return signal;
  });
}

function createRecordedBuyOrder(
  orderId: string,
  executedQuantity: number,
  symbol: string = 'BULL.HK',
): OrderRecord {
  return {
    orderId,
    symbol,
    costAmount: String(executedQuantity),
    executedQuantity,
    executedTime: Date.parse('2026-02-25T03:00:00.000Z'),
    submittedAt: undefined,
    updatedAt: undefined,
  };
}

describe('sell-flow integration', () => {
  it('preserves protective semantics on success and clears them when quantity processing returns HOLD', () => {
    const signalProcessor = createSignalProcessor({
      tradingConfig: createTradingConfig(),
      liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
      reportFatalError: () => {},
    });
    const protectiveSignal: ProtectiveLiquidationSellSignal = {
      symbol: 'BULL.HK',
      symbolName: 'BULL.HK',
      action: 'SELLCALL',
      reason: 'protective-type-boundary',
      seatVersion: 7,
      triggerTime: new Date('2026-07-12T07:45:01.000Z'),
      isProtectiveLiquidation: true,
    };
    const process = (longPosition: ReturnType<typeof createPositionDouble> | null) =>
      signalProcessor.processSellSignals({
        signals: [protectiveSignal],
        longPosition,
        shortPosition: null,
        longQuote: createQuoteDouble('BULL.HK', '1.05'),
        shortQuote: null,
        orderRecorder: createOrderRecorderDouble(),
        smartCloseEnabled: false,
        smartCloseTimeoutMinutes: null,
        nowMs: Date.parse('2026-07-12T07:45:01.000Z'),
        isHalfDay: false,
        tradingCalendarSnapshot: new Map(),
      });

    const successfulSignal = process(
      createPositionDouble({
        symbol: 'BULL.HK',
        quantity: 100,
        availableQuantity: 100,
      }),
    )[0];
    if (successfulSignal?.action !== 'SELLCALL') {
      throw new Error('expected executable protective sell signal');
    }

    const executableSignal: ExecutableSellSignal = successfulSignal;
    expect(executableSignal.isProtectiveLiquidation).toBeTrue();
    expect(executableSignal.seatVersion).toBe(7);
    expect(executableSignal.quantity).toBe(100);

    const heldResult = process(null)[0];
    if (heldResult?.action !== 'HOLD') {
      throw new Error('expected held sell signal');
    }

    const heldSignal = heldResult;
    expect(heldSignal.isProtectiveLiquidation).toBeFalse();
    expect(heldSignal.seatVersion).toBe(7);
  });

  it('throws ExternalApiRequestError without retry when sell quantity resolution reads stock positions', async () => {
    const tradingConfig = createTradingConfig();
    const tradeCtx = await createNativeSellIngress();
    tradeCtx.setStockPositions(
      nativePositions({
        symbol: 'BULL.HK',
        quantity: 300,
        availableQuantity: 300,
      }),
    );

    const positionFailure = new Error('service unavailable');

    const orderExecutor = await createOrderExecutor({
      ingress: tradeCtx,
      rateLimiter: createRateLimiterDouble(),
      marketDataClient: createExecutableQuoteClient(),
      cacheManager: {
        clearCache: () => {},
        getPendingOrders: async () => [],
      },
      orderMonitor: {
        initialize: async () => {},
        trackOrder: () => {},
        cancelOrder: async () => ({
          kind: 'CANCEL_CONFIRMED',
          relatedBuyOrderIds: null,
        }),
        startRuntime: () => {},
        stopRuntimeAndDrain: async () => {},
        recoverOrderTrackingFromSnapshot: async () => {},
        getPendingSellOrders: () => [],
        clearTrackedOrders: () => {},
        onOrderStateChanged: () => () => {},
        hasPendingProtectiveLiquidationOrders: () => false,
      },
      orderRecorder: createOrderRecorderDouble(),
      tradingConfig,
      symbolRegistry: createSymbolRegistryDouble(),
      isExecutionAllowed: () => true,
    });

    let signal = createSignal({
      symbol: 'BULL.HK',
      action: 'SELLCALL',
      triggerTimeMs: Date.now(),
      reason: 'sell-quantity-stock-positions-no-retry',
    });
    signal = { ...signal, quantity: 100 };

    const positionsIssuedBaseline = tradeCtx.accountReadCounts().positions;
    tradeCtx.setStockPositionsFailure(positionFailure);
    let caught: unknown = null;
    try {
      await orderExecutor.executeSignals([signal], orderExecutor.callerAuthorization);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    if (!(caught instanceof Error)) {
      throw new Error('expected Error');
    }

    expect(caught.name).toBe('ExternalApiRequestError');
    expect(Reflect.get(caught, 'operation')).toBe('TradeContext.stockPositions');
    expect(Reflect.get(caught, 'attempts')).toBe(1);
    expect(tradeCtx.accountReadCounts().positions - positionsIssuedBaseline).toBe(1);
    expect(caught).toHaveProperty('cause', positionFailure);
    tradeCtx.setStockPositionsFailure(null);
  });

  it('末日买入截止窗口不影响接管前的 smart-close 卖单提交', async () => {
    const tradingConfig = createTradingConfig();
    const currentTimeMs = Date.parse('2026-07-12T07:45:01.000Z');
    const signalProcessor = createSignalProcessor({
      tradingConfig,
      liquidationCooldownTracker: {
        recordLiquidationTrigger: () => {},
        recordCooldown: () => {},
        restoreTriggerCount: () => {},
        getRemainingMs: () => 0,
        clearMidnightEligible: () => {},
        resetAllTriggerCounts: () => {},
      },
      reportFatalError: () => {},
    });

    const storage = createOrderStorage();
    await seedStorageFromNative(storage, 'BULL.HK', '1', 100, true, Date.now() - 1000);
    await seedStorageFromNative(storage, 'BULL.HK', '1.2', 200, true, Date.now());

    const sellOrderLinks: Array<{ orderId: string; related: readonly string[] }> = [];
    const recorder = createOrderRecorderDouble({
      getCostBasis: (symbol, isLongSymbol) => storage.getCostBasis(symbol, isLongSymbol),
      getBuyOrdersForSymbol: (symbol, isLongSymbol) =>
        storage.getBuyOrdersList(symbol, isLongSymbol),
      selectSellableOrders: (params) => storage.selectSellableOrders(params),
      submitSellOrder: (orderId, _symbol, _direction, _quantity, relatedBuyOrderIds) => {
        sellOrderLinks.push({ orderId, related: relatedBuyOrderIds });
      },
    });

    const signal = createSignal({
      symbol: 'BULL.HK',
      action: 'SELLCALL',
      triggerTimeMs: currentTimeMs,
      reason: 'integration-sell',
    });

    const processed = signalProcessor.processSellSignals({
      signals: [signal],
      longPosition: createPositionDouble({
        symbol: 'BULL.HK',
        quantity: 300,
        availableQuantity: 300,
      }),
      shortPosition: null,
      longQuote: createQuoteDouble('BULL.HK', '1.05'),
      shortQuote: null,
      orderRecorder: recorder,
      smartCloseEnabled: true,
      smartCloseTimeoutMinutes: null,
      nowMs: Date.parse('2026-02-25T03:00:00.000Z'),
      isHalfDay: false,
      tradingCalendarSnapshot: new Map(),
    });

    expect(processed[0]?.action).toBe('SELLCALL');
    expect(processed[0]?.quantity).toBe(100);
    expect(processed[0]?.relatedBuyOrderIds?.length).toBe(1);

    const tradeCtx = await createNativeSellIngress();
    tradeCtx.setStockPositions(
      nativePositions({
        symbol: 'BULL.HK',
        quantity: 300,
        availableQuantity: 300,
      }),
    );

    const trackedOrders: Array<{
      orderId: string;
      quantity: number;
      executionSide: 'BUY' | 'SELL';
    }> = [];
    const orderExecutor = await createOrderExecutor({
      ingress: tradeCtx,
      rateLimiter: createRateLimiterDouble(),
      marketDataClient: createExecutableQuoteClient(),
      cacheManager: {
        clearCache: () => {},
        getPendingOrders: async () => [],
      },
      orderMonitor: {
        initialize: async () => {},
        trackOrder: ({ orderId, quantity, executionSide }) => {
          trackedOrders.push({ orderId, quantity, executionSide });
        },
        cancelOrder: async () => ({
          kind: 'CANCEL_CONFIRMED',
          relatedBuyOrderIds: null,
        }),
        startRuntime: () => {},
        stopRuntimeAndDrain: async () => {},
        recoverOrderTrackingFromSnapshot: async () => {},
        getPendingSellOrders: () => [],
        clearTrackedOrders: () => {},
        onOrderStateChanged: () => () => {},
        hasPendingProtectiveLiquidationOrders: () => false,
      },
      orderRecorder: recorder,
      tradingConfig,
      symbolRegistry: createSymbolRegistryDouble(),
      isExecutionAllowed: () => true,
      now: () => new Date(currentTimeMs),
      readCurrentTradingDayInfo: () => ({
        dateKey: '2026-07-12',
        info: { isTradingDay: true, isHalfDay: false },
      }),
    });

    const executeResult = await withMockedNow(currentTimeMs, () =>
      orderExecutor.executeSignals(
        requireExecutableSellSignals(processed),
        orderExecutor.callerAuthorization,
      ),
    );

    expect(executeResult.executedOrderIds).toHaveLength(1);
    expect(trackedOrders).toHaveLength(1);
    expect(trackedOrders[0]?.executionSide).toBe('SELL');
    expect(trackedOrders[0]?.quantity).toBe(100);

    const submitCall = tradeCtx.nativeSubmitObservations()[0];
    const payload = submitCall;
    if (
      !payload ||
      typeof payload !== 'object' ||
      !('orderType' in payload) ||
      !('side' in payload) ||
      !('quantity' in payload)
    ) {
      throw new TypeError('expected submitted sell payload');
    }

    expect(payload.orderType).toBe('ELO');
    expect(payload.side).toBe('SELL');
    expect(Number(payload.quantity)).toBe(100);
    expect(sellOrderLinks[0]?.related.length).toBe(1);
  });

  it('smart-close 最终可卖量不能把整单关联裁剪为不可表示数量', async () => {
    const tradingConfig = createTradingConfig();
    const signalProcessor = createSignalProcessor({
      tradingConfig,
      liquidationCooldownTracker: {
        recordLiquidationTrigger: () => {},
        recordCooldown: () => {},
        restoreTriggerCount: () => {},
        getRemainingMs: () => 0,
        clearMidnightEligible: () => {},
        resetAllTriggerCounts: () => {},
      },
      reportFatalError: () => {},
    });
    const storage = createOrderStorage();
    await seedStorageFromNative(storage, 'BULL.HK', '1', 100, true, Date.now() - 1_000);
    await seedStorageFromNative(storage, 'BULL.HK', '1', 100, true, Date.now());

    const trackedOrders: Array<{ readonly orderId: string; readonly quantity: number }> = [];
    const submittedSellLinks: Array<{
      readonly orderId: string;
      readonly quantity: number;
      readonly relatedBuyOrderIds: ReadonlyArray<string>;
    }> = [];
    const recorder = createOrderRecorderDouble({
      getCostBasis: (symbol, isLongSymbol) => storage.getCostBasis(symbol, isLongSymbol),
      getBuyOrdersForSymbol: (symbol, isLongSymbol) =>
        storage.getBuyOrdersList(symbol, isLongSymbol),
      selectSellableOrders: (params) => storage.selectSellableOrders(params),
      submitSellOrder: (orderId, _symbol, _direction, quantity, relatedBuyOrderIds) => {
        submittedSellLinks.push({ orderId, quantity, relatedBuyOrderIds });
      },
    });
    const processedSignals = signalProcessor.processSellSignals({
      signals: [
        createSignal({
          symbol: 'BULL.HK',
          action: 'SELLCALL',
          triggerTimeMs: Date.now(),
          reason: 'smart-close-final-available-clamp',
        }),
      ],
      longPosition: createPositionDouble({
        symbol: 'BULL.HK',
        quantity: 200,
        availableQuantity: 200,
      }),
      shortPosition: null,
      longQuote: createQuoteDouble('BULL.HK', '1.1'),
      shortQuote: null,
      orderRecorder: recorder,
      smartCloseEnabled: true,
      smartCloseTimeoutMinutes: null,
      nowMs: Date.parse('2026-02-25T03:00:00.000Z'),
      isHalfDay: false,
      tradingCalendarSnapshot: new Map(),
    });

    expect(processedSignals[0]?.quantity).toBe(200);
    expect(processedSignals[0]?.relatedBuyOrderIds).toHaveLength(2);

    const tradeCtx = await createNativeSellIngress();
    tradeCtx.setStockPositions(
      nativePositions({
        symbol: 'BULL.HK',
        quantity: 200,
        availableQuantity: 150,
      }),
    );
    const orderExecutor = await createOrderExecutor({
      ingress: tradeCtx,
      rateLimiter: createRateLimiterDouble(),
      marketDataClient: createExecutableQuoteClient(),
      cacheManager: { clearCache: () => {}, getPendingOrders: async () => [] },
      orderMonitor: {
        initialize: async () => {},
        trackOrder: ({ orderId, quantity }) => {
          trackedOrders.push({ orderId, quantity });
        },
        cancelOrder: async () => ({
          kind: 'CANCEL_CONFIRMED',
          relatedBuyOrderIds: null,
        }),
        startRuntime: () => {},
        stopRuntimeAndDrain: async () => {},
        recoverOrderTrackingFromSnapshot: async () => {},
        getPendingSellOrders: () => [],
        clearTrackedOrders: () => {},
        onOrderStateChanged: () => () => {},
        hasPendingProtectiveLiquidationOrders: () => false,
      },
      orderRecorder: recorder,
      tradingConfig,
      symbolRegistry: createSymbolRegistryDouble(),
      isExecutionAllowed: () => true,
    });

    const result = await orderExecutor.executeSignals(
      requireExecutableSellSignals(processedSignals),
      orderExecutor.callerAuthorization,
    );

    expect(result.executedOrderIds).toEqual([]);
    expect(tradeCtx.nativeSubmitObservations()).toHaveLength(0);
    expect(trackedOrders).toEqual([]);
    expect(submittedSellLinks).toEqual([]);
  });

  it('allows an unlinked sell to use the fresh available quantity', async () => {
    const tradingConfig = createTradingConfig();
    const tradeCtx = await createNativeSellIngress();
    tradeCtx.setStockPositions(
      nativePositions({
        symbol: 'BULL.HK',
        quantity: 200,
        availableQuantity: 150,
      }),
    );
    const orderExecutor = await createOrderExecutor({
      ingress: tradeCtx,
      rateLimiter: createRateLimiterDouble(),
      marketDataClient: createExecutableQuoteClient(),
      cacheManager: { clearCache: () => {}, getPendingOrders: async () => [] },
      orderMonitor: {
        initialize: async () => {},
        trackOrder: () => {},
        cancelOrder: async () => ({
          kind: 'CANCEL_CONFIRMED',
          relatedBuyOrderIds: null,
        }),
        startRuntime: () => {},
        stopRuntimeAndDrain: async () => {},
        recoverOrderTrackingFromSnapshot: async () => {},
        getPendingSellOrders: () => [],
        clearTrackedOrders: () => {},
        onOrderStateChanged: () => () => {},
        hasPendingProtectiveLiquidationOrders: () => false,
      },
      orderRecorder: createOrderRecorderDouble(),
      tradingConfig,
      symbolRegistry: createSymbolRegistryDouble(),
      isExecutionAllowed: () => true,
    });
    const signal = {
      ...createSignal({
        symbol: 'BULL.HK',
        action: 'SELLCALL',
        triggerTimeMs: Date.now(),
        reason: 'unlinked-sell-fresh-available-quantity',
      }),
      quantity: 200,
      relatedBuyOrderIds: [],
    };

    const result = await orderExecutor.executeSignals([signal], orderExecutor.callerAuthorization);

    expect(result.executedOrderIds).toHaveLength(1);
    const submitPayload = tradeCtx.nativeSubmitObservations()[0];
    if (!submitPayload || typeof submitPayload !== 'object') {
      throw new TypeError('expected submitted sell payload');
    }

    const submittedQuantity = submitPayload.quantity;
    expect(Number(submittedQuantity)).toBe(150);
  });

  it('runs stage2+stage3 with pending occupancy and submits remaining timeout quantity', async () => {
    const tradingConfig = createTradingConfig();
    const signalProcessor = createSignalProcessor({
      tradingConfig,
      liquidationCooldownTracker: {
        recordLiquidationTrigger: () => {},
        recordCooldown: () => {},
        restoreTriggerCount: () => {},
        getRemainingMs: () => 0,
        clearMidnightEligible: () => {},
        resetAllTriggerCounts: () => {},
      },
      reportFatalError: () => {},
    });

    const storage = createOrderStorage();
    const occupiedOrderExecutedTimeMs = Date.parse('2026-02-24T01:32:00.000Z');
    await seedStorageFromNative(
      storage,
      'BULL.HK',
      '0.9',
      100,
      true,
      Date.parse('2026-02-24T01:30:00.000Z'),
    );

    await seedStorageFromNative(
      storage,
      'BULL.HK',
      '1.2',
      100,
      true,
      Date.parse('2026-02-24T01:31:00.000Z'),
    );
    await seedStorageFromNative(storage, 'BULL.HK', '1.3', 100, true, occupiedOrderExecutedTimeMs);

    const occupiedOrder = storage
      .getBuyOrdersList('BULL.HK', true)
      .find((order) => order.executedTime === occupiedOrderExecutedTimeMs);
    if (!occupiedOrder) {
      throw new Error('missing occupied order');
    }

    storage.addPendingSell({
      orderId: 'PENDING-1',
      symbol: 'BULL.HK',
      direction: 'LONG',
      submittedQuantity: 100,
      relatedBuyOrderIds: [occupiedOrder.orderId],
      submittedAt: Date.now(),
      isProtectiveLiquidation: false,
    });

    const sellOrderLinks: Array<{ orderId: string; related: readonly string[] }> = [];
    const recorder = createOrderRecorderDouble({
      getCostBasis: (symbol, isLongSymbol) => storage.getCostBasis(symbol, isLongSymbol),
      getBuyOrdersForSymbol: (symbol, isLongSymbol) =>
        storage.getBuyOrdersList(symbol, isLongSymbol),
      selectSellableOrders: (params) => storage.selectSellableOrders(params),
      submitSellOrder: (orderId, _symbol, _direction, _quantity, relatedBuyOrderIds) => {
        sellOrderLinks.push({ orderId, related: relatedBuyOrderIds });
      },
    });

    const signal = createSignal({
      symbol: 'BULL.HK',
      action: 'SELLCALL',
      triggerTimeMs: Date.now(),
      reason: 'integration-sell-stage3',
    });

    const processed = signalProcessor.processSellSignals({
      signals: [signal],
      longPosition: createPositionDouble({
        symbol: 'BULL.HK',
        quantity: 300,
        availableQuantity: 300,
      }),
      shortPosition: null,
      longQuote: createQuoteDouble('BULL.HK', '1.05'),
      shortQuote: null,
      orderRecorder: recorder,
      smartCloseEnabled: true,
      smartCloseTimeoutMinutes: 60,
      nowMs: Date.parse('2026-02-25T03:00:00.000Z'),
      isHalfDay: false,
      tradingCalendarSnapshot: new Map([
        ['2026-02-24', { isTradingDay: true, isHalfDay: false }],
        ['2026-02-25', { isTradingDay: true, isHalfDay: false }],
      ]),
    });

    expect(processed[0]?.action).toBe('SELLCALL');
    expect(processed[0]?.quantity).toBe(200);
    expect(processed[0]?.relatedBuyOrderIds?.length).toBe(2);
    expect(processed[0]?.relatedBuyOrderIds).not.toContain(occupiedOrder.orderId);

    const tradeCtx = await createNativeSellIngress();
    tradeCtx.setStockPositions(
      nativePositions({
        symbol: 'BULL.HK',
        quantity: 300,
        availableQuantity: 300,
      }),
    );

    const trackedOrders: Array<{
      orderId: string;
      quantity: number;
      executionSide: 'BUY' | 'SELL';
    }> = [];
    const orderExecutor = await createOrderExecutor({
      ingress: tradeCtx,
      rateLimiter: createRateLimiterDouble(),
      marketDataClient: createExecutableQuoteClient(),
      cacheManager: {
        clearCache: () => {},
        getPendingOrders: async () => [],
      },
      orderMonitor: {
        initialize: async () => {},
        trackOrder: ({ orderId, quantity, executionSide }) => {
          trackedOrders.push({ orderId, quantity, executionSide });
        },
        cancelOrder: async () => ({
          kind: 'CANCEL_CONFIRMED',
          relatedBuyOrderIds: null,
        }),
        startRuntime: () => {},
        stopRuntimeAndDrain: async () => {},
        recoverOrderTrackingFromSnapshot: async () => {},
        getPendingSellOrders: () => [],
        clearTrackedOrders: () => {},
        onOrderStateChanged: () => () => {},
        hasPendingProtectiveLiquidationOrders: () => false,
      },
      orderRecorder: recorder,
      tradingConfig,
      symbolRegistry: createSymbolRegistryDouble(),
      isExecutionAllowed: () => true,
    });

    const executeResult = await orderExecutor.executeSignals(
      requireExecutableSellSignals(processed),
      orderExecutor.callerAuthorization,
    );

    expect(executeResult.executedOrderIds).toHaveLength(1);
    expect(trackedOrders).toHaveLength(1);
    expect(trackedOrders[0]?.executionSide).toBe('SELL');
    expect(trackedOrders[0]?.quantity).toBe(200);

    const submitCall = tradeCtx.nativeSubmitObservations()[0];
    const payload = submitCall;
    if (
      !payload ||
      typeof payload !== 'object' ||
      !('orderType' in payload) ||
      !('side' in payload) ||
      !('quantity' in payload)
    ) {
      throw new TypeError('expected submitted sell payload');
    }

    expect(payload.orderType).toBe('ELO');
    expect(payload.side).toBe('SELL');
    expect(Number(payload.quantity)).toBe(200);
    expect(sellOrderLinks[0]?.related.length).toBe(2);
  });

  it('supports SELLPUT symmetry with smart-close stage2+stage3 and submits short sell order', async () => {
    const tradingConfig = createTradingConfig();
    const signalProcessor = createSignalProcessor({
      tradingConfig,
      liquidationCooldownTracker: {
        recordLiquidationTrigger: () => {},
        recordCooldown: () => {},
        restoreTriggerCount: () => {},
        getRemainingMs: () => 0,
        clearMidnightEligible: () => {},
        resetAllTriggerCounts: () => {},
      },
      reportFatalError: () => {},
    });

    const storage = createOrderStorage();
    await seedStorageFromNative(
      storage,
      'BEAR.HK',
      '0.9',
      100,
      false,
      Date.parse('2026-02-24T01:30:00.000Z'),
    );

    await seedStorageFromNative(
      storage,
      'BEAR.HK',
      '1.2',
      100,
      false,
      Date.parse('2026-02-24T01:31:00.000Z'),
    );

    const sellOrderLinks: Array<{ orderId: string; related: readonly string[] }> = [];
    const recorder = createOrderRecorderDouble({
      getCostBasis: (symbol, isLongSymbol) => storage.getCostBasis(symbol, isLongSymbol),
      getBuyOrdersForSymbol: (symbol, isLongSymbol) =>
        storage.getBuyOrdersList(symbol, isLongSymbol),
      selectSellableOrders: (params) => storage.selectSellableOrders(params),
      submitSellOrder: (orderId, _symbol, _direction, _quantity, relatedBuyOrderIds) => {
        sellOrderLinks.push({ orderId, related: relatedBuyOrderIds });
      },
    });

    const signal = createSignal({
      symbol: 'BEAR.HK',
      action: 'SELLPUT',
      triggerTimeMs: Date.now(),
      reason: 'integration-sellput-stage3',
    });

    const processed = signalProcessor.processSellSignals({
      signals: [signal],
      longPosition: null,
      shortPosition: createPositionDouble({
        symbol: 'BEAR.HK',
        quantity: 200,
        availableQuantity: 200,
      }),
      longQuote: null,
      shortQuote: createQuoteDouble('BEAR.HK', '1.05'),
      orderRecorder: recorder,
      smartCloseEnabled: true,
      smartCloseTimeoutMinutes: 60,
      nowMs: Date.parse('2026-02-25T03:00:00.000Z'),
      isHalfDay: false,
      tradingCalendarSnapshot: new Map([
        ['2026-02-24', { isTradingDay: true, isHalfDay: false }],
        ['2026-02-25', { isTradingDay: true, isHalfDay: false }],
      ]),
    });

    expect(processed[0]?.action).toBe('SELLPUT');
    expect(processed[0]?.quantity).toBe(200);
    expect(processed[0]?.relatedBuyOrderIds?.length).toBe(2);

    const tradeCtx = await createNativeSellIngress();
    tradeCtx.setStockPositions(
      nativePositions({
        symbol: 'BEAR.HK',
        quantity: 200,
        availableQuantity: 200,
      }),
    );

    const trackedOrders: Array<{
      orderId: string;
      quantity: number;
      executionSide: 'BUY' | 'SELL';
    }> = [];
    const orderExecutor = await createOrderExecutor({
      ingress: tradeCtx,
      rateLimiter: createRateLimiterDouble(),
      marketDataClient: createExecutableQuoteClient(),
      cacheManager: {
        clearCache: () => {},
        getPendingOrders: async () => [],
      },
      orderMonitor: {
        initialize: async () => {},
        trackOrder: ({ orderId, quantity, executionSide }) => {
          trackedOrders.push({ orderId, quantity, executionSide });
        },
        cancelOrder: async () => ({
          kind: 'CANCEL_CONFIRMED',
          relatedBuyOrderIds: null,
        }),
        startRuntime: () => {},
        stopRuntimeAndDrain: async () => {},
        recoverOrderTrackingFromSnapshot: async () => {},
        getPendingSellOrders: () => [],
        clearTrackedOrders: () => {},
        onOrderStateChanged: () => () => {},
        hasPendingProtectiveLiquidationOrders: () => false,
      },
      orderRecorder: recorder,
      tradingConfig,
      symbolRegistry: createSymbolRegistryDouble(),
      isExecutionAllowed: () => true,
    });

    const executeResult = await orderExecutor.executeSignals(
      requireExecutableSellSignals(processed),
      orderExecutor.callerAuthorization,
    );

    expect(executeResult.executedOrderIds).toHaveLength(1);
    expect(trackedOrders).toHaveLength(1);
    expect(trackedOrders[0]?.executionSide).toBe('SELL');
    expect(trackedOrders[0]?.quantity).toBe(200);

    const submitCall = tradeCtx.nativeSubmitObservations()[0];
    const payload = submitCall;
    if (
      !payload ||
      typeof payload !== 'object' ||
      !('orderType' in payload) ||
      !('side' in payload) ||
      !('quantity' in payload)
    ) {
      throw new TypeError('expected submitted sell payload');
    }

    expect(payload.orderType).toBe('ELO');
    expect(payload.side).toBe('SELL');
    expect(Number(payload.quantity)).toBe(200);
    expect(sellOrderLinks[0]?.related.length).toBe(2);
  });

  it('executor returns the existing order ID for broker-confirmed REPLACE and preserves merged occupancy', async () => {
    const eloFact = await createNativeOrderFact('SELL-EXISTING', 'ELO');
    const tradingConfig = createTradingConfig();
    const tradeCtx = await createNativeSellIngress();
    tradeCtx.setStockPositions(
      nativePositions({
        symbol: 'BULL.HK',
        quantity: 300,
        availableQuantity: 300,
      }),
    );

    const replaceCalls: Array<{
      orderId: string;
      price: string;
      quantity: number | null | undefined;
    }> = [];
    const updatedPendingSells: Array<{
      orderId: string;
      submittedQuantity: number;
      relatedBuyOrderIds: ReadonlyArray<string>;
    }> = [];
    const submittedAt = Date.parse('2026-02-25T03:00:00.000Z');

    const orderExecutor = await createOrderExecutor({
      ingress: tradeCtx,
      rateLimiter: createRateLimiterDouble(),
      marketDataClient: createExecutableQuoteClient(),
      cacheManager: {
        clearCache: () => {},
        getPendingOrders: async () => [],
      },
      orderMonitor: {
        initialize: async () => {},
        trackOrder: () => {},
        cancelOrder: async () => ({
          kind: 'CANCEL_CONFIRMED',
          relatedBuyOrderIds: null,
        }),
        replaceOrderPriceWithPermit: async (orderId, price, _request, permit, quantity) =>
          permit.invoke(async () => {
            replaceCalls.push({ orderId, price, quantity });
            return { kind: 'BROKER_CONFIRMED' };
          }),
        startRuntime: () => {},
        stopRuntimeAndDrain: async () => {},
        recoverOrderTrackingFromSnapshot: async () => {},
        getPendingSellOrders: () => [
          {
            orderId: 'SELL-EXISTING',
            symbol: 'BULL.HK',
            side: eloFact.executionSide,
            executionSide: eloFact.executionSide,
            status: eloFact.status,
            orderType: eloFact.orderType,
            submittedPrice: '1',
            submittedQuantity: 100,
            executedQuantity: 0,
            submittedAt,
          },
        ],
        clearTrackedOrders: () => {},
        onOrderStateChanged: () => () => {},
        hasPendingProtectiveLiquidationOrders: () => false,
      },
      orderRecorder: createOrderRecorderDouble({
        getBuyOrdersForSymbol: () => [
          createRecordedBuyOrder('BUY-OLD', 100),
          createRecordedBuyOrder('BUY-NEW', 50),
        ],
        getPendingSellSnapshot: () => [
          {
            orderId: 'SELL-EXISTING',
            symbol: 'BULL.HK',
            direction: 'LONG',
            submittedQuantity: 100,
            filledQuantity: 0,
            relatedBuyOrderIds: ['BUY-OLD'],
            status: 'pending',
            isProtectiveLiquidation: false,
            submittedAt,
          },
        ],
        updatePendingSell: (orderId, params) => {
          updatedPendingSells.push({
            orderId,
            submittedQuantity: params.submittedQuantity,
            relatedBuyOrderIds: params.relatedBuyOrderIds,
          });
          return null;
        },
      }),
      tradingConfig,
      symbolRegistry: createSymbolRegistryDouble(),
      isExecutionAllowed: () => true,
    });

    let signal = createSignal({
      symbol: 'BULL.HK',
      action: 'SELLCALL',
      triggerTimeMs: Date.now(),
      reason: 'replace-merge',
    });
    signal = { ...signal, quantity: 50 };
    signal = { ...signal, relatedBuyOrderIds: ['BUY-NEW'] };

    const result = await orderExecutor.executeSignals([signal], orderExecutor.callerAuthorization);

    expect(result).toEqual({
      executedOrderIds: ['SELL-EXISTING'],
    });

    expect(replaceCalls).toEqual([
      {
        orderId: 'SELL-EXISTING',
        price: '1.1',
        quantity: 150,
      },
    ]);

    expect(updatedPendingSells).toEqual([
      {
        orderId: 'SELL-EXISTING',
        submittedQuantity: 150,
        relatedBuyOrderIds: ['BUY-OLD', 'BUY-NEW'],
      },
    ]);
    expect(tradeCtx.nativeSubmitObservations()).toHaveLength(0);
  });

  it('fails closed when a partial fill changes smart-close REPLACE facts during rate-limit wait', async () => {
    const eloFact = await createNativeOrderFact('SELL-EXISTING', 'ELO');
    const tradingConfig = createTradingConfig();
    const tradeCtx = await createNativeSellIngress();
    tradeCtx.setStockPositions(
      nativePositions({
        symbol: 'BULL.HK',
        quantity: 150,
        availableQuantity: 150,
      }),
    );
    const symbolRegistry = createSymbolRegistryDouble();
    const submittedAtMs = Date.parse('2026-07-13T03:00:00.000Z');
    const pendingSellUpdates: Array<{
      readonly orderId: string;
      readonly submittedQuantity: number;
      readonly relatedBuyOrderIds: ReadonlyArray<string>;
    }> = [];
    let isExistingPendingSellTracked = false;
    let capturedSettlement: PostTradeConsistencyRuntime | null = null;
    const settlementNeedRecorder = {
      recordSettlementRefreshNeed: (
        need: Parameters<PostTradeConsistencyRuntime['recordSettlementRefreshNeed']>[0],
      ) => {
        if (capturedSettlement === null)
          throw new Error('Partial ingress settlement is not assembled');

        capturedSettlement.recordSettlementRefreshNeed(need);
      },
    };
    const actualRecorder = tradeCtx.createRecorder({
      rateLimiter: createRateLimiterDouble(),
      getExecutionTimeEvidence: () => [],
      settlementRefreshNeedRecorder: settlementNeedRecorder,
    });
    const orderRecorder = {
      ...actualRecorder,
      getBuyOrdersForSymbol: () => [
        createRecordedBuyOrder('BUY-OLD', 100),
        createRecordedBuyOrder('BUY-NEW', 50),
      ],
      getPendingSellSnapshot: () =>
        isExistingPendingSellTracked
          ? [
              {
                orderId: 'SELL-EXISTING',
                symbol: 'BULL.HK',
                direction: 'LONG',
                submittedQuantity: 100,
                filledQuantity: 0,
                relatedBuyOrderIds: ['BUY-OLD'],
                status: 'pending',
                isProtectiveLiquidation: false,
                submittedAt: submittedAtMs,
              },
            ]
          : [],
      updatePendingSell: (orderId, params) => {
        pendingSellUpdates.push({
          orderId,
          submittedQuantity: params.submittedQuantity,
          relatedBuyOrderIds: params.relatedBuyOrderIds,
        });
        return null;
      },
    } satisfies OrderRecorder;
    let notifyReplaceMutationEntered: (() => void) | undefined;
    let releaseReplaceMutation: (() => void) | undefined;
    const replaceMutationEntered = new Promise<void>((resolve) => {
      notifyReplaceMutationEntered = resolve;
    });
    const mutationRateLimiter = createRateLimiterDouble();
    // 原场景等待的是 permit 准入，不能已占有同一 FIFO 后再等待需要读取 ledger 的 WS。
    const rateLimiter: RateLimiter = {
      throttle: mutationRateLimiter.throttle,
      withTradeMutation: async (callback) => {
        if (notifyReplaceMutationEntered === undefined) {
          throw new Error('replace mutation entry notifier is unavailable');
        }

        notifyReplaceMutationEntered();
        await new Promise<void>((resolve) => {
          releaseReplaceMutation = resolve;
        });
        return mutationRateLimiter.withTradeMutation(callback);
      },
    };
    const ingressFatalErrors: unknown[] = [];
    const ledgerIssuedBaseline = tradeCtx.readCounts();
    const orderMonitor = await createSellMonitor(tradeCtx, {
      now: () => new Date(submittedAtMs),
      scheduleTimer: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimer: (handle) => {
        clearTimeout(handle);
      },

      rateLimiter,
      cacheManager: {
        clearCache: () => {},
        getPendingOrders: async () => [],
      },
      marketDataClient: createMarketDataClientDouble(),
      orderRecorder,
      dailyLossTracker: createDailyLossTrackerDouble(),
      orderHoldRegistry: {
        trackOrder: () => {},
        markOrderClosed: () => {},
        seedFromOrders: () => {},
        getHoldSymbols: () => new Set<string>(),
        onOrderHoldSymbolsChanged: () => () => {},
        clear: () => {},
      },
      protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
      persistProtectiveLiquidationExecutionProgress: () => {},
      postTradeConsistencyRuntime: {
        recordSettlementRefreshNeed: () => {},
      },
      tradingConfig,
      symbolRegistry,
      isContinuousTradingAllowed: () => true,
      termination: createTerminationDouble({
        reportFatalError: (error) => {
          ingressFatalErrors.push(error);
        },
      }),
    });
    await orderMonitor.initialize();
    await orderMonitor.recoverOrderTrackingFromSnapshot([]);
    orderMonitor.trackOrder({
      orderId: 'SELL-EXISTING',
      symbol: 'BULL.HK',
      side: eloFact.executionSide,
      executionSide: eloFact.executionSide,
      price: '1',
      initialSubmittedPrice: '1',
      quantity: 100,
      submittedAtMs,
      initialStatus: eloFact.status,
      isLongSymbol: true,
      monitorSymbol: tradingConfig.monitor.monitorSymbol,
      isProtectiveLiquidation: false,
      orderType: eloFact.orderType,
    });
    isExistingPendingSellTracked = true;
    const orderExecutor = await createOrderExecutor({
      ingress: tradeCtx,
      rateLimiter,
      cacheManager: {
        clearCache: () => {},
        getPendingOrders: async () => [],
      },
      orderMonitor,
      orderRecorder,
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () => new Map([['BULL.HK', createQuoteDouble('BULL.HK', '1.02')]]),
      }),
      tradingConfig,
      symbolRegistry,
      isExecutionAllowed: () => true,
    });
    capturedSettlement = orderExecutor.settlement;
    const signal = {
      ...createSignal({
        symbol: 'BULL.HK',
        action: 'SELLCALL',
        triggerTimeMs: Date.now(),
        reason: 'replace-facts-changed-during-rate-limit-wait',
      }),
      quantity: 50,
      relatedBuyOrderIds: ['BUY-NEW'],
    };

    const resultPromise = orderExecutor.executeSignals([signal], orderExecutor.callerAuthorization);
    await replaceMutationEntered;
    tradeCtx.setExecutionReplies([
      {
        orderId: 'SELL-EXISTING',
        tradeId: 'SELL-EXISTING-partial',
        symbol: 'BULL.HK',
        quantity: '50',
        price: '1.01',
        tradeDoneAtMs: submittedAtMs + 1_000,
      },
    ]);

    tradeCtx.emitOrderChangedFrame({
      orderId: 'SELL-EXISTING',
      tradeId: 'SELL-EXISTING-partial',
      symbol: 'BULL.HK',
      stockName: 'HSI RC',
      remark: '',
      side: 'SELL',
      status: 'PartialFilled',
      orderType: 'ELO',
      quantity: '100',
      executedQuantity: '50',
      submittedPrice: '1',
      executedPrice: '1.01',
      submittedAtMs,
      executionTimeMs: submittedAtMs + 1_000,
      updatedAtMs: submittedAtMs + 1_000,
    });

    await waitUntil(
      () =>
        ingressFatalErrors.length > 0 ||
        orderMonitor.getPendingSellOrders('BULL.HK')[0]?.executedQuantity === 50,
    ).catch(async (error: unknown) => {
      releaseReplaceMutation?.();
      await resultPromise;
      throw new Error(
        `partial ingress stage: ledger=${JSON.stringify(tradeCtx.readCounts())}, fact=${JSON.stringify(actualRecorder.getExecutionFact('SELL-EXISTING'))}, offset=${monitorDailyOwners.get(tradeCtx)?.getLossOffset('LONG') ?? 'UNBOUND'}`,
        { cause: error },
      );
    });

    if (ingressFatalErrors.length > 0) {
      releaseReplaceMutation?.();
      await resultPromise;
      throw ingressFatalErrors[0];
    }

    expect(orderMonitor.getPendingSellOrders('BULL.HK')[0]?.executedQuantity).toBe(50);
    expect(ingressFatalErrors).toEqual([]);
    expect(tradeCtx.readCounts()).toEqual({
      today: ledgerIssuedBaseline.today + 1,
      history: ledgerIssuedBaseline.history + 1,
    });

    expect(actualRecorder.getExecutionFact('SELL-EXISTING')).toMatchObject({
      cumulativeQuantity: 50,
      cumulativeAmount: '50.5',
      executionTimeMs: submittedAtMs + 1_000,
      updatedAtMs: submittedAtMs + 1_000,
      phase: 'OPEN',
    });

    if (releaseReplaceMutation === undefined) {
      throw new Error('replace mutation release is unavailable');
    }

    releaseReplaceMutation();
    const result = await resultPromise;

    expect(result.executedOrderIds).toEqual([]);
    expect(
      tradeCtx.nativeMutations().filter((mutation) => mutation.kind === 'REPLACE'),
    ).toHaveLength(0);
    expect(tradeCtx.nativeSubmitObservations()).toHaveLength(0);
    expect(pendingSellUpdates).toEqual([]);
    const [pendingSell] = orderMonitor.getPendingSellOrders('BULL.HK');
    expect(pendingSell?.submittedQuantity).toBe(100);
    expect(pendingSell?.executedQuantity).toBe(50);
  });

  it('does not REPLACE when merged related buy orders cannot exactly represent target quantity', async () => {
    const eloFact = await createNativeOrderFact('SELL-EXISTING', 'ELO');
    const tradingConfig = createTradingConfig();
    const tradeCtx = await createNativeSellIngress();
    tradeCtx.setStockPositions(
      nativePositions({
        symbol: 'BULL.HK',
        quantity: 300,
        availableQuantity: 300,
      }),
    );
    const pendingUpdates: Array<{
      readonly orderId: string;
      readonly submittedQuantity: number;
      readonly relatedBuyOrderIds: ReadonlyArray<string>;
    }> = [];
    const submittedAt = Date.parse('2026-02-25T03:00:00.000Z');
    const orderExecutor = await createOrderExecutor({
      ingress: tradeCtx,
      rateLimiter: createRateLimiterDouble(),
      marketDataClient: createExecutableQuoteClient(),
      cacheManager: { clearCache: () => {}, getPendingOrders: async () => [] },
      orderMonitor: {
        initialize: async () => {},
        trackOrder: () => {},
        cancelOrder: async () => ({
          kind: 'CANCEL_CONFIRMED',
          relatedBuyOrderIds: null,
        }),
        startRuntime: () => {},
        stopRuntimeAndDrain: async () => {},
        recoverOrderTrackingFromSnapshot: async () => {},
        getPendingSellOrders: () => [
          {
            orderId: 'SELL-EXISTING-INEXACT',
            symbol: 'BULL.HK',
            side: eloFact.executionSide,
            executionSide: eloFact.executionSide,
            status: eloFact.status,
            orderType: eloFact.orderType,
            submittedPrice: '1',
            submittedQuantity: 100,
            executedQuantity: 0,
            submittedAt,
          },
        ],
        clearTrackedOrders: () => {},
        onOrderStateChanged: () => () => {},
        hasPendingProtectiveLiquidationOrders: () => false,
      },
      orderRecorder: createOrderRecorderDouble({
        getBuyOrdersForSymbol: () => [
          createRecordedBuyOrder('BUY-OLD', 100),
          createRecordedBuyOrder('BUY-NEW', 100),
        ],
        getPendingSellSnapshot: () => [
          {
            orderId: 'SELL-EXISTING-INEXACT',
            symbol: 'BULL.HK',
            direction: 'LONG',
            submittedQuantity: 100,
            filledQuantity: 0,
            relatedBuyOrderIds: ['BUY-OLD'],
            status: 'pending',
            isProtectiveLiquidation: false,
            submittedAt,
          },
        ],
        updatePendingSell: (orderId, params) => {
          pendingUpdates.push({
            orderId,
            submittedQuantity: params.submittedQuantity,
            relatedBuyOrderIds: params.relatedBuyOrderIds,
          });
          return null;
        },
      }),
      tradingConfig,
      symbolRegistry: createSymbolRegistryDouble(),
      isExecutionAllowed: () => true,
    });
    const signal = {
      ...createSignal({
        symbol: 'BULL.HK',
        action: 'SELLCALL',
        triggerTimeMs: Date.now(),
        reason: 'replace-inexact-related-buy-orders',
      }),
      quantity: 50,
      relatedBuyOrderIds: ['BUY-NEW'],
    };

    const result = await orderExecutor.executeSignals([signal], orderExecutor.callerAuthorization);

    expect(result.executedOrderIds).toEqual([]);
    expect(
      tradeCtx.nativeMutations().filter((mutation) => mutation.kind === 'REPLACE'),
    ).toHaveLength(0);
    expect(pendingUpdates).toEqual([]);
    expect(tradeCtx.nativeSubmitObservations()).toHaveLength(0);
  });

  it('does not submit after cancel when merged related buy orders cannot exactly represent replanned quantity', async () => {
    const eloFact = await createNativeOrderFact('SELL-EXISTING', 'ELO');
    const marketFact = await createNativeOrderFact('SELL-EXISTING', 'MO');
    const tradingConfig = createTradingConfig();
    const tradeCtx = await createNativeSellIngress();
    tradeCtx.setStockPositions(
      nativePositions({
        symbol: 'BULL.HK',
        quantity: 300,
        availableQuantity: 300,
      }),
    );
    const cancelCalls: string[] = [];
    const trackedOrders: Array<{ readonly orderId: string; readonly quantity: number }> = [];
    const submittedSellLinks: Array<{
      readonly orderId: string;
      readonly quantity: number;
      readonly relatedBuyOrderIds: ReadonlyArray<string>;
    }> = [];
    const submittedAt = Date.parse('2026-02-25T03:00:00.000Z');
    const orderExecutor = await createOrderExecutor({
      ingress: tradeCtx,
      rateLimiter: createRateLimiterDouble(),
      marketDataClient: createExecutableQuoteClient(),
      cacheManager: { clearCache: () => {}, getPendingOrders: async () => [] },
      orderMonitor: {
        initialize: async () => {},
        trackOrder: ({ orderId, quantity }) => {
          trackedOrders.push({ orderId, quantity });
        },
        cancelOrder: async (orderId) => {
          cancelCalls.push(orderId);
          return {
            kind: 'ALREADY_CLOSED',
            closedReason: 'CANCELED',
            relatedBuyOrderIds: ['BUY-OLD'],
            terminalExecution: { submittedQuantity: 100, executedQuantity: 0 },
          };
        },
        startRuntime: () => {},
        stopRuntimeAndDrain: async () => {},
        recoverOrderTrackingFromSnapshot: async () => {},
        getPendingSellOrders: () => [
          {
            orderId: 'SELL-NONREPLACEABLE-INEXACT',
            symbol: 'BULL.HK',
            side: eloFact.executionSide,
            executionSide: eloFact.executionSide,
            status: eloFact.status,
            orderType: marketFact.orderType,
            submittedPrice: null,
            submittedQuantity: 100,
            executedQuantity: 0,
            submittedAt,
          },
        ],
        clearTrackedOrders: () => {},
        onOrderStateChanged: () => () => {},
        hasPendingProtectiveLiquidationOrders: () => false,
      },
      orderRecorder: createOrderRecorderDouble({
        getBuyOrdersForSymbol: () => [
          createRecordedBuyOrder('BUY-OLD', 100),
          createRecordedBuyOrder('BUY-NEW', 100),
        ],
        submitSellOrder: (orderId, _symbol, _direction, quantity, relatedBuyOrderIds) => {
          submittedSellLinks.push({ orderId, quantity, relatedBuyOrderIds });
        },
      }),
      tradingConfig,
      symbolRegistry: createSymbolRegistryDouble(),
      isExecutionAllowed: () => true,
    });
    const signal = {
      ...createSignal({
        symbol: 'BULL.HK',
        action: 'SELLCALL',
        triggerTimeMs: Date.now(),
        reason: 'cancel-and-submit-inexact-related-buy-orders',
      }),
      quantity: 50,
      relatedBuyOrderIds: ['BUY-NEW'],
    };

    const result = await orderExecutor.executeSignals([signal], orderExecutor.callerAuthorization);

    expect(result.executedOrderIds).toEqual([]);
    expect(cancelCalls).toEqual(['SELL-NONREPLACEABLE-INEXACT']);
    expect(tradeCtx.nativeSubmitObservations()).toHaveLength(0);
    expect(trackedOrders).toEqual([]);
    expect(submittedSellLinks).toEqual([]);
  });

  it('does not update pending sell when REPLACE authorization expires inside the mutation permit', async () => {
    const eloFact = await createNativeOrderFact('SELL-EXISTING', 'ELO');
    const tradingConfig = createTradingConfig();
    const tradeCtx = await createNativeSellIngress();
    tradeCtx.setStockPositions(
      nativePositions({
        symbol: 'BULL.HK',
        quantity: 300,
        availableQuantity: 300,
      }),
    );

    let executionAllowed = true;
    let replaceSdkCallCount = 0;
    let updatePendingSellCallCount = 0;
    const submittedAt = Date.parse('2026-02-25T03:00:00.000Z');
    const orderExecutor = await createOrderExecutor({
      ingress: tradeCtx,
      rateLimiter: createRateLimiterDouble(),
      marketDataClient: createExecutableQuoteClient(),
      cacheManager: {
        clearCache: () => {},
        getPendingOrders: async () => [],
      },
      orderMonitor: {
        initialize: async () => {},
        trackOrder: () => {},
        cancelOrder: async () => ({
          kind: 'CANCEL_CONFIRMED',
          relatedBuyOrderIds: null,
        }),
        replaceOrderPriceWithPermit: async (_orderId, _price, request, permit) => {
          executionAllowed = false;
          if (request.kind === 'SIGNAL_AUTHORIZED' && request.authorize('replaceOrder.beforeApi')) {
            return permit.invoke(async () => {
              replaceSdkCallCount += 1;
              return { kind: 'BROKER_CONFIRMED' };
            });
          }

          return { kind: 'NOT_EXECUTED' };
        },
        startRuntime: () => {},
        stopRuntimeAndDrain: async () => {},
        recoverOrderTrackingFromSnapshot: async () => {},
        getPendingSellOrders: () => [
          {
            orderId: 'SELL-EXISTING-AUTH-REVOKED',
            symbol: 'BULL.HK',
            side: eloFact.executionSide,
            executionSide: eloFact.executionSide,
            status: eloFact.status,
            orderType: eloFact.orderType,
            submittedPrice: '1',
            submittedQuantity: 100,
            executedQuantity: 0,
            submittedAt,
          },
        ],
        clearTrackedOrders: () => {},
        onOrderStateChanged: () => () => {},
        hasPendingProtectiveLiquidationOrders: () => false,
      },
      orderRecorder: createOrderRecorderDouble({
        getBuyOrdersForSymbol: () => [
          createRecordedBuyOrder('BUY-OLD', 100),
          createRecordedBuyOrder('BUY-NEW', 50),
        ],
        getPendingSellSnapshot: () => [
          {
            orderId: 'SELL-EXISTING-AUTH-REVOKED',
            symbol: 'BULL.HK',
            direction: 'LONG',
            submittedQuantity: 100,
            filledQuantity: 0,
            relatedBuyOrderIds: ['BUY-OLD'],
            status: 'pending',
            isProtectiveLiquidation: false,
            submittedAt,
          },
        ],
        updatePendingSell: () => {
          updatePendingSellCallCount += 1;
          return null;
        },
      }),
      tradingConfig,
      symbolRegistry: createSymbolRegistryDouble(),
      isExecutionAllowed: () => executionAllowed,
    });

    let signal = createSignal({
      symbol: 'BULL.HK',
      action: 'SELLCALL',
      triggerTimeMs: Date.now(),
      reason: 'replace-auth-revoked-inside-throttle',
    });
    signal = { ...signal, quantity: 50 };
    signal = { ...signal, relatedBuyOrderIds: ['BUY-NEW'] };

    await orderExecutor.executeSignals(
      requireExecutableSellSignals([signal]),
      orderExecutor.callerAuthorization,
    );

    expect(replaceSdkCallCount).toBe(0);
    expect(updatePendingSellCallCount).toBe(0);
  });

  it('does not submit merged sell order before cancel reaches confirmed terminal close', async () => {
    const eloFact = await createNativeOrderFact('SELL-EXISTING', 'ELO');
    const marketFact = await createNativeOrderFact('SELL-EXISTING', 'MO');
    const tradingConfig = createTradingConfig();
    const tradeCtx = await createNativeSellIngress();
    tradeCtx.setStockPositions(
      nativePositions({
        symbol: 'BULL.HK',
        quantity: 300,
        availableQuantity: 300,
      }),
    );

    const cancelCalls: string[] = [];
    const orderExecutor = await createOrderExecutor({
      ingress: tradeCtx,
      rateLimiter: createRateLimiterDouble(),
      marketDataClient: createExecutableQuoteClient(),
      cacheManager: {
        clearCache: () => {},
        getPendingOrders: async () => [],
      },
      orderMonitor: {
        initialize: async () => {},
        trackOrder: () => {},
        cancelOrder: async (orderId) => {
          cancelCalls.push(orderId);
          return {
            kind: 'CANCEL_CONFIRMED',
            relatedBuyOrderIds: ['BUY-OLD'],
          };
        },
        startRuntime: () => {},
        stopRuntimeAndDrain: async () => {},
        recoverOrderTrackingFromSnapshot: async () => {},
        getPendingSellOrders: () => [
          {
            orderId: 'SELL-MARKET-EXISTING',
            symbol: 'BULL.HK',
            side: eloFact.executionSide,
            executionSide: eloFact.executionSide,
            status: eloFact.status,
            orderType: marketFact.orderType,
            submittedPrice: '1',
            submittedQuantity: 100,
            executedQuantity: 0,
            submittedAt: Date.parse('2026-02-25T03:00:00.000Z'),
          },
        ],
        clearTrackedOrders: () => {},
        onOrderStateChanged: () => () => {},
        hasPendingProtectiveLiquidationOrders: () => false,
      },
      orderRecorder: createOrderRecorderDouble(),
      tradingConfig,
      symbolRegistry: createSymbolRegistryDouble(),
      isExecutionAllowed: () => true,
    });

    let signal = createSignal({
      symbol: 'BULL.HK',
      action: 'SELLCALL',
      triggerTimeMs: Date.now(),
      reason: 'cancel-and-submit-wait-terminal',
    });
    signal = { ...signal, quantity: 50 };
    signal = { ...signal, relatedBuyOrderIds: ['BUY-NEW'] };

    const result = await orderExecutor.executeSignals([signal], orderExecutor.callerAuthorization);

    expect(result).toEqual({
      executedOrderIds: [],
    });
    expect(cancelCalls).toEqual(['SELL-MARKET-EXISTING']);
    expect(tradeCtx.nativeSubmitObservations()).toHaveLength(0);
  });

  it('carries original related buy orders into CANCEL_AND_SUBMIT merged sell order', async () => {
    const eloFact = await createNativeOrderFact('SELL-EXISTING', 'ELO');
    const marketFact = await createNativeOrderFact('SELL-EXISTING', 'MO');
    const tradingConfig = createTradingConfig();
    const tradeCtx = await createNativeSellIngress();
    tradeCtx.setStockPositions(
      nativePositions({
        symbol: 'BULL.HK',
        quantity: 300,
        availableQuantity: 300,
      }),
    );

    const cancelCalls: string[] = [];
    const trackedOrders: Array<{ orderId: string; quantity: number }> = [];
    const submittedSellLinks: Array<{
      orderId: string;
      quantity: number;
      relatedBuyOrderIds: ReadonlyArray<string>;
    }> = [];

    const orderExecutor = await createOrderExecutor({
      ingress: tradeCtx,
      rateLimiter: createRateLimiterDouble(),
      marketDataClient: createExecutableQuoteClient(),
      cacheManager: {
        clearCache: () => {},
        getPendingOrders: async () => [],
      },
      orderMonitor: {
        initialize: async () => {},
        trackOrder: ({ orderId, quantity }) => {
          trackedOrders.push({ orderId, quantity });
        },
        cancelOrder: async (orderId) => {
          cancelCalls.push(orderId);
          return {
            kind: 'ALREADY_CLOSED',
            closedReason: 'CANCELED',
            relatedBuyOrderIds: ['BUY-OLD'],
            terminalExecution: {
              submittedQuantity: 100,
              executedQuantity: 0,
            },
          };
        },
        startRuntime: () => {},
        stopRuntimeAndDrain: async () => {},
        recoverOrderTrackingFromSnapshot: async () => {},
        getPendingSellOrders: () => [
          {
            orderId: 'SELL-MARKET-EXISTING',
            symbol: 'BULL.HK',
            side: eloFact.executionSide,
            executionSide: eloFact.executionSide,
            status: eloFact.status,
            orderType: marketFact.orderType,
            submittedPrice: '1',
            submittedQuantity: 100,
            executedQuantity: 0,
            submittedAt: Date.parse('2026-02-25T03:00:00.000Z'),
          },
        ],
        clearTrackedOrders: () => {},
        onOrderStateChanged: () => () => {},
        hasPendingProtectiveLiquidationOrders: () => false,
      },
      orderRecorder: createOrderRecorderDouble({
        getBuyOrdersForSymbol: () => [
          createRecordedBuyOrder('BUY-OLD', 100),
          createRecordedBuyOrder('BUY-NEW', 50),
        ],
        submitSellOrder: (orderId, _symbol, _direction, quantity, relatedBuyOrderIds) => {
          submittedSellLinks.push({
            orderId,
            quantity,
            relatedBuyOrderIds,
          });
        },
      }),
      tradingConfig,
      symbolRegistry: createSymbolRegistryDouble(),
      isExecutionAllowed: () => true,
    });

    let signal = createSignal({
      symbol: 'BULL.HK',
      action: 'SELLCALL',
      triggerTimeMs: Date.now(),
      reason: 'cancel-and-submit-merge',
    });
    signal = { ...signal, quantity: 50 };
    signal = { ...signal, relatedBuyOrderIds: ['BUY-NEW'] };

    const result = await orderExecutor.executeSignals([signal], orderExecutor.callerAuthorization);

    expect(result.executedOrderIds).toHaveLength(1);
    expect(cancelCalls).toEqual(['SELL-MARKET-EXISTING']);
    expect(trackedOrders).toHaveLength(1);
    expect(trackedOrders[0]?.quantity).toBe(150);
    expect(submittedSellLinks).toHaveLength(1);
    expect(submittedSellLinks[0]?.quantity).toBe(150);
    expect(submittedSellLinks[0]?.relatedBuyOrderIds).toEqual(['BUY-NEW', 'BUY-OLD']);

    const submitCall = tradeCtx.nativeSubmitObservations()[0];
    const payload = submitCall;
    if (!payload || typeof payload !== 'object' || !('quantity' in payload)) {
      throw new TypeError('expected submitted sell payload');
    }

    expect(Number(payload.quantity)).toBe(150);
  });

  it('fails closed when partial cancel remainder cannot be represented by whole related buy orders', async () => {
    const eloFact = await createNativeOrderFact('SELL-EXISTING', 'ELO');
    const marketFact = await createNativeOrderFact('SELL-EXISTING', 'MO');
    const tradingConfig = createTradingConfig();
    const tradeCtx = await createNativeSellIngress();
    const symbolRegistry = createSymbolRegistryDouble();
    const submittedSellOccupancies: Array<{
      readonly orderId: string;
      readonly quantity: number;
    }> = [];
    const orderRecorder = createOrderRecorderDouble({
      getBuyOrdersForSymbol: () => [createRecordedBuyOrder('BUY-NEW', 50)],
      submitSellOrder: (orderId, _symbol, _direction, quantity) => {
        submittedSellOccupancies.push({ orderId, quantity });
      },
    });
    const initialAvailablePositions = nativePositions({
      symbol: 'BULL.HK',
      quantity: 150,
      availableQuantity: 150,
    });
    const postCancelAvailablePositions = nativePositions({
      symbol: 'BULL.HK',
      quantity: 110,
      availableQuantity: 110,
    });
    tradeCtx.setStockPositions(initialAvailablePositions);
    const terminalFrame: BrokerIngressInput = {
      orderId: 'SELL-PARTIAL-WITHDRAWAL',
      tradeId: 'SELL-PARTIAL-WITHDRAWAL-trade',
      symbol: 'BULL.HK',
      stockName: 'HSI RC',
      remark: '',
      side: 'SELL',
      status: 'PartialWithdrawal',
      orderType: 'MO',
      quantity: '100',
      executedQuantity: '40',
      submittedPrice: '1',
      executedPrice: '1.02',
      submittedAtMs: Date.parse('2026-07-11T02:59:00.000Z'),
      executionTimeMs: Date.now(),
      updatedAtMs: Date.now() + 1,
    };
    tradeCtx.setExecutionReplies([
      {
        orderId: terminalFrame.orderId,
        tradeId: terminalFrame.tradeId,
        symbol: 'BULL.HK',
        quantity: '40',
        price: '1.02',
        tradeDoneAtMs: terminalFrame.executionTimeMs ?? 0,
      },
    ]);
    tradeCtx.setOrderDetailReplies([terminalFrame]);

    tradeCtx.setCancelFailure(new Error('openapi error: code=601011: Order has been cancelled'));

    let throttleCallCount = 0;
    const rateLimiter = createRateLimiterDouble({
      onThrottle: async () => {
        throttleCallCount += 1;
        if (throttleCallCount === 4) {
          tradeCtx.setStockPositions(postCancelAvailablePositions);
        }
      },
    });
    const orderMonitorDeps: Parameters<NativeSellIngress['createMonitor']>[0] = {
      now: () => new Date(),
      scheduleTimer: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimer: (handle) => {
        clearTimeout(handle);
      },

      rateLimiter,
      cacheManager: {
        clearCache: () => {},
        getPendingOrders: async () => [],
      },
      marketDataClient: createMarketDataClientDouble(),
      orderRecorder,
      dailyLossTracker: createDailyLossTrackerDouble(),
      orderHoldRegistry: {
        trackOrder: () => {},
        markOrderClosed: () => {},
        seedFromOrders: () => {},
        getHoldSymbols: () => new Set<string>(),
        onOrderHoldSymbolsChanged: () => () => {},
        clear: () => {},
      },
      protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
      persistProtectiveLiquidationExecutionProgress: () => {},
      postTradeConsistencyRuntime: {
        recordSettlementRefreshNeed: () => {},
      },
      tradingConfig,
      symbolRegistry,
      isContinuousTradingAllowed: () => true,
      termination: createTerminationDouble({
        reportFatalError: (error) => {
          throw error;
        },
      }),
    };
    const orderMonitor = await createSellMonitor(tradeCtx, orderMonitorDeps);
    orderMonitor.trackOrder({
      orderId: 'SELL-PARTIAL-WITHDRAWAL',
      symbol: 'BULL.HK',
      side: eloFact.executionSide,
      executionSide: eloFact.executionSide,
      price: '1',
      initialSubmittedPrice: '1',
      quantity: 100,
      submittedAtMs: Date.parse('2026-07-11T02:59:00.000Z'),
      initialStatus: eloFact.status,
      isLongSymbol: true,
      monitorSymbol: tradingConfig.monitor.monitorSymbol,
      isProtectiveLiquidation: false,
      orderType: marketFact.orderType,
    });

    const orderExecutor = await createOrderExecutor({
      ingress: tradeCtx,
      rateLimiter,
      marketDataClient: createExecutableQuoteClient(),
      cacheManager: {
        clearCache: () => {},
        getPendingOrders: async () => [],
      },
      orderMonitor,
      orderRecorder,
      tradingConfig,
      symbolRegistry,
      isExecutionAllowed: () => true,
    });
    let signal = createSignal({
      symbol: 'BULL.HK',
      action: 'SELLCALL',
      triggerTimeMs: Date.now(),
      reason: 'cancel-and-submit-terminal-partial-fill-replan',
    });
    signal = { ...signal, quantity: 50, relatedBuyOrderIds: ['BUY-NEW'] };

    const result = await orderExecutor.executeSignals([signal], orderExecutor.callerAuthorization);

    expect(result.executedOrderIds).toEqual([]);
    expect(tradeCtx.nativeReadCounts().cancel).toBe(1);
    expect(tradeCtx.nativeReadCounts().detail).toBe(1);
    expect(submittedSellOccupancies).toEqual([]);
    expect(tradeCtx.accountReadCounts().positions).toBe(4);
    expect(tradeCtx.nativeSubmitObservations()).toHaveLength(0);
  });

  it('fails closed when CANCEL_AND_SUBMIT terminal execution quantity is unavailable', async () => {
    const eloFact = await createNativeOrderFact('SELL-EXISTING', 'ELO');
    const marketFact = await createNativeOrderFact('SELL-EXISTING', 'MO');
    const tradingConfig = createTradingConfig();
    const tradeCtx = await createNativeSellIngress();
    const symbolRegistry = createSymbolRegistryDouble();
    const submittedSellOccupancies: Array<{
      readonly orderId: string;
      readonly quantity: number;
    }> = [];
    const orderRecorder = createOrderRecorderDouble({
      submitSellOrder: (orderId, _symbol, _direction, quantity) => {
        submittedSellOccupancies.push({ orderId, quantity });
      },
    });
    tradeCtx.setStockPositions(
      nativePositions({
        symbol: 'BULL.HK',
        quantity: 150,
        availableQuantity: 150,
      }),
    );
    const terminalFrame: BrokerIngressInput = {
      orderId: 'SELL-PARTIAL-WITHDRAWAL-MISSING-EXECUTION',
      tradeId: 'SELL-PARTIAL-WITHDRAWAL-MISSING-EXECUTION-trade',
      symbol: 'BULL.HK',
      stockName: 'HSI RC',
      remark: '',
      side: 'SELL',
      status: 'PartialWithdrawal',
      orderType: 'MO',
      quantity: '100',
      executedQuantity: '0',
      submittedPrice: '1',
      executedPrice: '1.02',
      submittedAtMs: Date.parse('2026-07-11T02:59:00.000Z'),
      executionTimeMs: null,
      updatedAtMs: Date.parse('2026-07-11T03:00:00.000Z'),
    };
    tradeCtx.setOrderDetailReplies([terminalFrame]);
    tradeCtx.setExecutionReplies([]);
    tradeCtx.setCancelFailure(new Error('openapi error: code=601011: Order has been cancelled'));

    let throttleCallCount = 0;
    const rateLimiter = createRateLimiterDouble({
      onThrottle: async () => {
        throttleCallCount += 1;
        if (throttleCallCount === 4) {
          tradeCtx.setStockPositions(
            nativePositions({
              symbol: 'BULL.HK',
              quantity: 110,
              availableQuantity: 110,
            }),
          );
        }
      },
    });
    const orderMonitor = await createSellMonitor(tradeCtx, {
      now: () => new Date(),
      scheduleTimer: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimer: (handle) => {
        clearTimeout(handle);
      },

      rateLimiter,
      cacheManager: {
        clearCache: () => {},
        getPendingOrders: async () => [],
      },
      marketDataClient: createMarketDataClientDouble(),
      orderRecorder,
      dailyLossTracker: createDailyLossTrackerDouble(),
      orderHoldRegistry: {
        trackOrder: () => {},
        markOrderClosed: () => {},
        seedFromOrders: () => {},
        getHoldSymbols: () => new Set<string>(),
        onOrderHoldSymbolsChanged: () => () => {},
        clear: () => {},
      },
      protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
      persistProtectiveLiquidationExecutionProgress: () => {},
      postTradeConsistencyRuntime: {
        recordSettlementRefreshNeed: () => {},
      },
      tradingConfig,
      symbolRegistry,
      isContinuousTradingAllowed: () => true,
      termination: createTerminationDouble({
        reportFatalError: (error) => {
          throw error;
        },
      }),
    });
    orderMonitor.trackOrder({
      orderId: 'SELL-PARTIAL-WITHDRAWAL-MISSING-EXECUTION',
      symbol: 'BULL.HK',
      side: eloFact.executionSide,
      executionSide: eloFact.executionSide,
      price: '1',
      initialSubmittedPrice: '1',
      quantity: 100,
      submittedAtMs: Date.parse('2026-07-11T02:59:00.000Z'),
      initialStatus: eloFact.status,
      isLongSymbol: true,
      monitorSymbol: tradingConfig.monitor.monitorSymbol,
      isProtectiveLiquidation: false,
      orderType: marketFact.orderType,
    });
    const orderExecutor = await createOrderExecutor({
      ingress: tradeCtx,
      rateLimiter,
      cacheManager: {
        clearCache: () => {},
        getPendingOrders: async () => [],
      },
      orderMonitor,
      orderRecorder,
      marketDataClient: createExecutableQuoteClient(),
      tradingConfig,
      symbolRegistry,
      isExecutionAllowed: () => true,
    });
    const signal = {
      ...createSignal({
        symbol: 'BULL.HK',
        action: 'SELLCALL',
        triggerTimeMs: Date.now(),
        reason: 'cancel-and-submit-missing-terminal-execution-must-fail-closed',
      }),
      quantity: 10,
      relatedBuyOrderIds: ['BUY-NEW'],
    };

    const issuedLedgerBeforeMissingDetail = tradeCtx.readCounts();
    tradeCtx.setQueryExecutedQuantityMissing();
    let caughtError: unknown = null;
    try {
      await orderExecutor.executeSignals([signal], orderExecutor.callerAuthorization);
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(TypeError);
    expect(tradeCtx.readCounts()).toEqual(issuedLedgerBeforeMissingDetail);
    expect(orderExecutor.settlement.isCurrent(orderExecutor.receipt)).toBeTrue();
    expect(caughtError).toHaveProperty(
      'message',
      "null is not an object (evaluating 'order.executedQuantity.toString')",
    );

    expect(tradeCtx.nativeReadCounts().cancel).toBe(1);
    expect(tradeCtx.nativeReadCounts().detail).toBe(1);
    expect(tradeCtx.nativeSubmitObservations()).toHaveLength(0);
    expect(submittedSellOccupancies).toHaveLength(0);
  });
});
