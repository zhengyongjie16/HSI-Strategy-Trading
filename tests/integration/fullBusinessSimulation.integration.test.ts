import { createDiagnosticObserverDouble } from '../helpers/diagnostics.js';
import { createRuntimeStateFixtures } from '../helpers/runtimeStateFixtures.js';
import { scheduleBoundedOneShotAt } from '../../src/runtime/timer/index.js';
import { wrapExternalApiRequest } from '../../src/infrastructure/externalApi/index.js';
import { wait } from '../../src/infrastructure/time/index.js';
import type {
  TradeRuntime,
  PostTradeConsistencyRuntime,
  PostTradeConsistencyRuntimeDeps,
} from '../../src/app/runtime/types.js';
import type { RuntimeStateFixtures } from '../helpers/types.js';

/**
 * full-business-simulation 集成测试
 *
 * 功能：
 * - 验证完整业务仿真端到端场景与业务期望。
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { createTradingConfig } from '../../mock/factories/configFactory.js';
import { createSignal } from '../../mock/factories/signalFactory.js';
import { createPostTradeConsistencyRuntime } from '../../src/app/runtime/createPostTradeConsistencyRuntime.js';

import { createAutoSearch } from '../../src/application/autoSearch/index.js';
import type { OrderExecutor } from '../../src/application/orderExecution/types.js';
import { createOrderHoldRegistry } from '../../src/application/orderTracking/orderHoldRegistry.js';
import { createOrdinaryBuyWorkflow } from '../../src/application/ordinaryBuy/index.js';
import { createOrdinarySellWorkflow } from '../../src/application/ordinarySell/index.js';
import { createSeatSwitchWorkflow } from '../../src/application/seatSwitch/index.js';
import { createStaticLiquidationExecutor } from '../../src/application/staticLiquidation/index.js';
import { orderAnalysis } from '../../src/domain/order/orderAnalysis.js';
import { createDailyLossTracker } from '../../src/domain/risk/dailyLossTracker.js';
import { createGlobalStateDomain } from '../../src/runtime/lifecycle/cacheDomains/globalStateDomain.js';
import { createSignalRuntimeDomain } from '../../src/runtime/lifecycle/cacheDomains/signalRuntimeDomain.js';
import { createDayLifecycleManager } from '../../src/runtime/lifecycle/dayLifecycleManager.js';
import { createQuoteSubscriptionRuntime } from '../../src/runtime/quoteSubscriptionRuntime/index.js';
import { createTradingGateEventRuntime as createProductionTradingGateEventRuntime } from '../../src/runtime/tradingGateEventRuntime/index.js';
import { createBuyProcessor } from '../../src/runtime/asyncProgram/buyProcessor/index.js';
import type { MonitorTaskDataMap } from '../../src/runtime/asyncProgram/monitorTaskProcessor/types.js';
import { createMonitorTaskQueue } from '../../src/runtime/asyncProgram/monitorTaskQueue/index.js';
import { createSellProcessor } from '../../src/runtime/asyncProgram/sellProcessor/index.js';
import {
  createBuyTaskQueue,
  createSellTaskQueue,
} from '../../src/runtime/asyncProgram/tradeTaskQueue/index.js';
import { createAutoSearchWakeupRuntime } from '../../src/runtime/autoSearchWakeupRuntime/index.js';
import { createBusinessEventProgram } from '../../src/runtime/businessEventProgram/index.js';
import { createDefaultMonitorQuoteEventRuntime } from '../../src/runtime/monitorQuoteEventRuntime/monitorQuoteEventRuntime.js';
import { createSwitchWakeupRuntime } from '../../src/runtime/monitorQuoteEventRuntime/switchWakeupRuntime.js';
import { createPeriodicSwitchWakeupRuntime } from '../../src/runtime/periodicSwitchWakeupRuntime/index.js';
import { createSeatActivationDispatcher } from '../../src/runtime/seatActivationDispatcher/index.js';
import { timeWakeupEvaluationProgram } from '../../src/runtime/timeWakeupEvaluationProgram/index.js';
import type { Position } from '../../src/types/account.js';
import type { AccountPositionSnapshot } from '../../src/types/accountPosition.js';
import type { MonitorConfig, TradingConfig } from '../../src/types/config.js';
import type { NormalizedCandle } from '../../src/types/data.js';
import type {
  CandlestickCacheSnapshot,
  CandlestickUpdatedEvent,
  MarketDataClient,
  QuoteUpdatedEvent,
} from '../../src/types/marketPorts.js';
import type { DailyLossTracker } from '../../src/types/risk.js';
import type { UnrealizedLossMonitor } from '../../src/types/unrealizedLoss.js';
import type { SymbolRegistry } from '../../src/types/seat.js';
import type { OrderRecorder } from '../../src/types/orderRecorder.js';
import type { OrderStateChangedEvent } from '../../src/types/orderTracking.js';
import type { RiskChecker } from '../../src/types/riskCheck.js';
import type { MonitorContextAssembly } from '../../src/app/context/types.js';
import type { OrderFact } from '../../src/types/trade.js';
import { toHongKongTimeIso } from '../../src/utils/time/index.js';
import { createWarrantCandidateWithOverrides } from '../helpers/seatTestUtils.js';
import {
  createAutoSearchWakeupRuntimeDouble,
  createDoomsdayClearanceWorkflowDouble,
  createLiquidationCooldownTrackerDouble,
  createLoggerDouble,
  createMarketDataClientDouble,
  createMonitorConfigDouble,
  createMonitorContextDouble,
  createPeriodicSwitchWakeupRuntimeDouble,
  createPositionDouble,
  createProtectiveLiquidationEpisodeTrackerDouble,
  createQuoteDouble,
  createQuoteSubscriptionRuntimeDouble,
  createRateLimiterDouble,
  createRiskCheckerDouble,
  createSeatActivationDispatcherDouble,
  createSeatRuntimeCleanupDispatcherDouble,
  createStrategyDouble,
  createSymbolRegistryDouble,
  createTerminationDouble,
  createTradeRuntimeDouble,
  createTradingGateEventRuntimeDouble,
  createWarrantDistanceInfoDouble,
} from '../helpers/testDoubles.js';
import type { BrokerIngressInput } from '../infrastructure/longbridge/trade/brokerIngressFixture.js';
import { waitUntil } from '../helpers/asyncProgram.js';
import { createSnapshotFixture } from '../helpers/accountPositionSnapshot.js';
import { createMonitorTaskRuntimeFixture } from '../runtime/asyncProgram/monitorTaskProcessor/fixtures.js';
import { createBrokerIngressFixture } from './architectureRefactoringP1Native/trade/brokerIngressFixture.js';

function rethrowFatalError(error: unknown): never {
  throw error;
}

const ASYNC_PROCESSOR_RUNTIME = {
  clock: { now: () => new Date('2026-02-16T01:31:00.000Z') },
  scheduler: {
    scheduleTimer: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
    clearTimer: (handle: ReturnType<typeof setTimeout>) => {
      clearTimeout(handle);
    },
  },
};

function createTradingGateEventRuntime() {
  return createProductionTradingGateEventRuntime({ logger: createLoggerDouble() });
}

let autoSymbolCandidates: Array<ReturnType<typeof createWarrantCandidateWithOverrides> | null> = [];

function createCandles(length: number, start: number, step: number): NormalizedCandle[] {
  const candles: NormalizedCandle[] = [];
  for (let index = 0; index < length; index += 1) {
    const close = start + index * step;
    candles.push(
      Object.freeze({
        open: close - 0.2,
        high: close + 0.3,
        low: close - 0.4,
        close,
        volume: 5_000 + index,
      }),
    );
  }

  return candles;
}

function createCandlestickSnapshot(
  symbol: string,
  candles: ReadonlyArray<NormalizedCandle>,
  version: number = 1,
): CandlestickCacheSnapshot | null {
  if (candles.length === 0) {
    return null;
  }

  const latest = candles.at(-1);
  const lastBarTimestamp =
    latest && typeof latest.timestamp === 'number' && Number.isFinite(latest.timestamp)
      ? latest.timestamp
      : null;
  return {
    symbol,
    period: 'MIN_1',
    version,
    candles,
    lastBarTimestamp,
    lastBarConfirmed: false,
    initialized: true,
  };
}

/** 原累计金额/数量与独立成交 T 从 actual native mapper 进入唯一 O，不再注入均价 getter。 */
async function createSimulationOrderRecorder(
  ingress: Awaited<ReturnType<typeof createBrokerIngressFixture>>,
  snapshot: AccountPositionSnapshot,
  monitorConfig: MonitorConfig,
  dailyLossTracker: DailyLossTracker,
  frames: ReadonlyArray<BrokerIngressInput>,
) {
  ingress.setOrderDetailReplies(frames);
  ingress.setOrderSnapshotReplies([], frames);
  ingress.setExecutionReplies(
    frames.flatMap((frame) =>
      frame.executionTimeMs === null
        ? []
        : [
            {
              orderId: frame.orderId,
              tradeId: frame.tradeId,
              symbol: frame.symbol,
              quantity: frame.executedQuantity,
              price: frame.executedPrice,
              tradeDoneAtMs: frame.executionTimeMs,
            },
          ],
    ),
  );
  const orders: OrderFact[] = [];
  for (const frame of frames) {
    const [order] = await ingress.createQueryOrdersReader(frame.orderId)();
    if (order === undefined) throw new Error('Simulation native observation missing');

    expect(order.executionTimeMs).toBe(frame.executionTimeMs);
    expect(order.updatedAtMs).toBe(frame.updatedAtMs);
    orders.push(order);
  }

  let settlement: PostTradeConsistencyRuntime | null = null;
  const orderRecorder = ingress.createRecorder({
    logger: createLoggerDouble(),
    rateLimiter: createRateLimiterDouble(),
    getExecutionTimeEvidence: () => [],
    settlementRefreshNeedRecorder: {
      recordSettlementRefreshNeed: (need) => {
        if (settlement === null) throw new Error('Simulation settlement is not bound');

        settlement.recordSettlementRefreshNeed(need);
      },
    },
  });
  const bindSettlement = (runtime: PostTradeConsistencyRuntime) => {
    settlement = runtime;
  };

  const hydrate = (now: Date) => {
    const token = snapshot.getView().token;
    const isCurrent = () =>
      snapshot.isCurrent(token, { account: true, positions: true, paired: true });
    if (!isCurrent()) throw new Error('Simulation O baseline requires paired H');

    dailyLossTracker.recalculateFromAllOrders(orders, monitorConfig, now, new Map());
    const targets = [...new Set(orders.map((order) => order.symbol))].map((symbol) => ({
      symbol,
      isLongSymbol: symbol !== 'BEAR.HK',
    }));
    const result = orderRecorder.commitRebuildSnapshot(targets, orders, isCurrent, 'REBUILD');
    if (result.status !== 'COMMITTED') throw new Error('Simulation O baseline aborted');

    return token;
  };
  return { orderRecorder, hydrate, bindSettlement };
}

function simulationExecutionFrame(
  orderId: string,
  symbol: string,
  side: 'BUY' | 'SELL',
  price: string,
  executionTimeMs: number,
): BrokerIngressInput {
  return {
    orderId,
    tradeId: `${orderId}-trade`,
    symbol,
    stockName: 'HSI RC',
    remark: 'AUTO',
    side,
    status: 'Filled',
    quantity: '100',
    executedQuantity: '100',
    submittedPrice: price,
    executedPrice: price,
    submittedAtMs: executionTimeMs === 1 ? 1 : executionTimeMs - 1,
    executionTimeMs,
    updatedAtMs: executionTimeMs + 1,
  };
}

function createSimulationDailyLossTracker(): DailyLossTracker {
  return createDailyLossTracker({
    onOwnershipWarning: () => {},
    ...orderAnalysis,
    toHongKongTimeIso,
  });
}

/** 原账户与持仓数据经同 ctx adapter 成对刷新 H；这里不启动 S 或签发 readiness。 */
async function createSimulationSnapshot(positions: ReadonlyArray<Position>) {
  const nowMs = Date.parse('2026-02-16T01:31:00.000Z');
  const ingress = await createBrokerIngressFixture({
    orderId: 'SIMULATION-BOOTSTRAP',
    tradeId: 'SIMULATION-BOOTSTRAP-TRADE',
    symbol: 'BULL.HK',
    stockName: 'BULL.HK',
    remark: '',
    side: 'BUY',
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
    totalCash: '200000',
    netAssets: '200000',
    availableCash: '200000',
  });
  const setPositions = (rows: ReadonlyArray<Position>) => {
    ingress.setStockPositions(
      rows.map((position) => ({
        symbol: position.symbol,
        symbolName: position.symbolName,
        accountChannel: position.accountChannel,
        currency: position.currency,
        quantity: String(position.quantity),
        availableQuantity: String(position.availableQuantity),
        costPrice: position.costPrice,
      })),
    );
  };
  setPositions(positions);
  const accountService = ingress.createAccountService({ rateLimiter: createRateLimiterDouble() });
  const snapshot = await createSnapshotFixture({
    readPort: accountService,
    account: await accountService.getAccountSnapshot(),
    positions: await accountService.getStockPositions(),
  });
  const refreshPositions = async (
    rows: ReadonlyArray<Position>,
    source: 'TEST_SETUP' | 'LIFECYCLE_REBUILD' = 'TEST_SETUP',
  ) => {
    setPositions(rows);
    const dayEpoch = snapshot.getView().token.dayEpoch;
    const result = await snapshot.requestRefresh({
      source,
      dayEpoch,
      refreshAccount: true,
      refreshPositions: true,
    }).result;
    if (result.status !== 'COMMITTED') throw new Error('Simulation paired refresh aborted');

    return result;
  };
  return { ingress, accountService, snapshot, refreshPositions };
}

const settlementCleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of settlementCleanups.splice(0)) await cleanup();
});

/** S 与业务使用同一个 H、monitorContext 和 Daily；不自动预热、start 或签发 READY。 */
function createSimulationSettlement(
  params: Pick<PostTradeConsistencyRuntimeDeps, 'snapshot' | 'termination'> & {
    readonly tradeRuntime: TradeRuntime;
    readonly monitorContext: MonitorContextAssembly;
  },
) {
  const runtime = createPostTradeConsistencyRuntime({
    diagnostics: createDiagnosticObserverDouble(),
    clock: { now: () => new Date() },
    logger: createLoggerDouble(),
    snapshot: params.snapshot,
    termination: params.termination,
    getProtectiveOrderReader: () => params.tradeRuntime.orderMonitor,
    onPositionsCommitted: async (token) => {
      if (!params.snapshot.isCurrent(token, { account: true, positions: true, paired: true })) {
        throw new Error('Simulation positions commit is stale');
      }
    },
    scheduler: ASYNC_PROCESSOR_RUNTIME.scheduler,
  });
  runtime.bindBusinessDeps({
    monitorContext: params.monitorContext,
    dailyLossTracker: params.monitorContext.dailyLossTracker,
    liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
    protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
    mixedTradeLogRepository: {
      appendCompletionIdempotent: () => {
        throw new Error('Simulation protective completion persistence is not configured');
      },
    },
  });
  settlementCleanups.push(runtime.stopAndDrain);
  return runtime;
}

/** 实际 submit/Monitor 共享 native ctx；调用者的原授权直接交给 executor，ACK 由 native reply 给出。 */
async function createSimulationExecutor(params: {
  readonly ingress: Awaited<ReturnType<typeof createBrokerIngressFixture>>;
  readonly tradingConfig: TradingConfig;
  readonly symbolRegistry: SymbolRegistry;
  readonly orderRecorder: OrderRecorder;
  readonly dailyLossTracker: DailyLossTracker;
  readonly riskChecker: RiskChecker;
  readonly postTradeConsistencyRuntime: PostTradeConsistencyRuntime;
  readonly marketDataClient: MarketDataClient;
  readonly now: () => Date;
  readonly isExecutionAllowed: () => boolean;
  readonly onOrderStateChanged?: (event: OrderStateChangedEvent) => void;
}) {
  const rateLimiter = createRateLimiterDouble();
  const cacheManager = { clearCache: () => {}, getPendingOrders: async () => [] };
  const orderMonitor = params.ingress.createMonitor({
    diagnostics: createDiagnosticObserverDouble(),
    logger: createLoggerDouble(),
    wait: wait,
    requestExternalApi: wrapExternalApiRequest,
    scheduleBoundedOneShotAt: scheduleBoundedOneShotAt,
    rateLimiter,
    cacheManager,
    marketDataClient: params.marketDataClient,
    orderRecorder: params.orderRecorder,
    dailyLossTracker: params.dailyLossTracker,
    orderHoldRegistry: createOrderHoldRegistry(),
    protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
    persistProtectiveLiquidationExecutionProgress: () => {
      throw new Error('Simulation protective progress persistence is not configured');
    },
    postTradeConsistencyRuntime: params.postTradeConsistencyRuntime,
    tradingConfig: params.tradingConfig,
    symbolRegistry: params.symbolRegistry,
    isContinuousTradingAllowed: params.isExecutionAllowed,
    now: params.now,
    scheduleTimer: ASYNC_PROCESSOR_RUNTIME.scheduler.scheduleTimer,
    clearTimer: ASYNC_PROCESSOR_RUNTIME.scheduler.clearTimer,
    termination: createTerminationDouble({ reportFatalError: rethrowFatalError }),
  });
  await orderMonitor.initialize();
  await orderMonitor.recoverOrderTrackingFromSnapshot([]);
  if (params.onOrderStateChanged !== undefined) {
    const unsubscribe = orderMonitor.onOrderStateChanged(params.onOrderStateChanged);
    settlementCleanups.push(async () => {
      unsubscribe();
    });
  }

  settlementCleanups.push(orderMonitor.stopRuntimeAndDrain);
  return params.ingress.createExecutor({
    diagnostics: createDiagnosticObserverDouble(),
    logger: createLoggerDouble(),
    rateLimiter,
    cacheManager,
    marketDataClient: params.marketDataClient,
    orderMonitor,
    orderRecorder: params.orderRecorder,
    unrealizedLossBuyGate: params.riskChecker,
    tradingConfig: params.tradingConfig,
    symbolRegistry: params.symbolRegistry,
    isExecutionAllowed: params.isExecutionAllowed,
    isContinuousTradingAllowed: params.isExecutionAllowed,
    now: params.now,
    readCurrentTradingDayInfo: () => ({
      dateKey: '2026-02-16',
      info: { isTradingDay: true, isHalfDay: false },
    }),
  });
}

/** 保持原模拟终态行情：金额文本与技术/整手字段分离。 */
function createSimulationQuoteClient() {
  return createMarketDataClientDouble({
    getQuotes: async (symbols) => {
      const quotes = new Map<string, ReturnType<typeof createQuoteDouble> | null>();
      for (const symbol of symbols) {
        if (symbol === 'HSI.HK') quotes.set(symbol, createQuoteDouble(symbol, '20000', 1));
        else if (symbol === 'BULL.HK') quotes.set(symbol, createQuoteDouble(symbol, '1.05', 100));
        else if (symbol === 'BEAR.HK') quotes.set(symbol, createQuoteDouble(symbol, '0.95', 100));
        else quotes.set(symbol, null);
      }

      return quotes;
    },
  });
}

function createNoopUnrealizedLossMonitor(): UnrealizedLossMonitor {
  return {
    monitorDirectionalUnrealizedLoss: async () => false,
  };
}

function createTradingConfigForMonitor(monitorConfig: MonitorConfig): TradingConfig {
  const base = createTradingConfig();
  return {
    monitor: monitorConfig,
    global: {
      ...base.global,
      doomsdayProtection: false,
    },
  };
}

function createSimulationLastState(params: {
  readonly monitorConfig: MonitorConfig;
  readonly positions: ReadonlyArray<ReturnType<typeof createPositionDouble>>;
  readonly currentDayKey: string;
}): RuntimeStateFixtures {
  return createRuntimeStateFixtures({
    tradingTimeState: { canTrade: true, isHalfDay: false, openProtectionActive: false },
    lifecycleState: {
      currentDayKey: params.currentDayKey,
      lifecycleState: 'ACTIVE',
      pendingOpenRebuild: false,
      isTradingEnabled: true,
    },
    tradingCalendarState: {
      cachedTradingDayInfo: {
        dateKey: params.currentDayKey,
        info: {
          isTradingDay: true,
          isHalfDay: false,
        },
      },
      tradingCalendarSnapshot: new Map([
        [params.currentDayKey, { isTradingDay: true, isHalfDay: false }],
      ]),
    },
    quoteSubscriptionState: { allTradingSymbols: new Set<string>() },
  });
}

function createSingleListenerEventSource<T>(): {
  readonly subscribe: (listener: (event: T) => void) => () => void;
  readonly emit: (event: T) => void;
} {
  let listener: ((event: T) => void) | null = null;

  return {
    subscribe(nextListener) {
      listener = nextListener;
      return function unsubscribe(): void {
        if (listener === nextListener) {
          listener = null;
        }
      };
    },
    emit(event) {
      listener?.(event);
    },
  };
}

describe('full business simulation integration', () => {
  it('simulates candlestick event -> risk checks -> sell execution while buy is blocked by risk rule', async () => {
    const monitorConfig = createMonitorConfigDouble({
      monitorSymbol: 'HSI.HK',
      longSymbol: 'BULL.HK',
      shortSymbol: 'BEAR.HK',
      smartCloseEnabled: true,
    });
    const tradingConfig = createTradingConfigForMonitor(monitorConfig);
    const symbolRegistry = createSymbolRegistryDouble({
      longSeat: {
        symbol: 'BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      shortSeat: {
        symbol: 'BEAR.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      longVersion: 1,
      shortVersion: 1,
    });

    const buyTaskQueue = createBuyTaskQueue({
      clock: { now: () => new Date() },
      diagnostics: createDiagnosticObserverDouble(),
    });
    const sellTaskQueue = createSellTaskQueue({
      clock: { now: () => new Date() },
      diagnostics: createDiagnosticObserverDouble(),
    });
    const positions = [
      createPositionDouble({ symbol: 'BULL.HK', quantity: 300, availableQuantity: 300 }),
    ];
    const stateFixtures = createSimulationLastState({
      monitorConfig,
      positions,
      currentDayKey: '2026-02-16',
    });
    const { ingress, accountService, snapshot } = await createSimulationSnapshot(positions);
    const dailyLossTracker = createSimulationDailyLossTracker();

    const riskChecker = createRiskCheckerDouble({
      checkBeforeOrder: ({ signal }) =>
        signal.action === 'BUYCALL'
          ? { allowed: false, reason: '模拟风险规则：买入被拒绝' }
          : { allowed: true },
    });

    const { orderRecorder, hydrate, bindSettlement } = await createSimulationOrderRecorder(
      ingress,
      snapshot,
      monitorConfig,
      dailyLossTracker,
      [
        simulationExecutionFrame('BUY-ORIGIN', 'BULL.HK', 'BUY', '1', 1),
        simulationExecutionFrame('BUY-001', 'BULL.HK', 'BUY', '1', Date.now()),
      ],
    );

    const strategy = createStrategyDouble({
      onCandlestick: (context, emit) => {
        emit({
          action: 'BUYCALL',
          reason: 'full-simulation-buy',
          triggerTimeMs: context.observedAtMs,
        });

        emit({
          action: 'SELLCALL',
          reason: 'full-simulation-sell',
          triggerTimeMs: context.observedAtMs,
        });
        return null;
      },
    });

    const monitorContext = createMonitorContextDouble({
      config: monitorConfig,
      symbolRegistry,
      strategy,
      orderRecorder,
      dailyLossTracker: dailyLossTracker,
      riskChecker,
      unrealizedLossMonitor: createNoopUnrealizedLossMonitor(),
      seatSwitch: {
        evaluatePeriodicSwitchDue: async () => ({
          kind: 'NOOP',
        }),
        startSwitchOnDistance: async (params) => ({
          started: false,
          direction: params.direction,
          driveResult: {
            kind: 'NOOP',
          },
        }),
        advancePendingSwitch: async (params) => ({
          advanced: false,
          direction: params.direction,
          stillPending: false,
          driveResult: {
            kind: 'NOOP',
          },
        }),
        hasPendingSwitch: () => false,
        getPeriodicSwitchPendingState: () => ({
          pending: false,
        }),
        resetAllState: () => {},
      },
    });
    const submittedActions: string[] = [];
    let executor: OrderExecutor | null = null;
    const tradeRuntime = createTradeRuntimeDouble({
      accountService,
      orderRecorder,
      orderExecutor: {
        executeSignals: async (signals, callerAuthorization) => {
          if (executor === null) throw new Error('Simulation executor not assembled');

          const result = await executor.executeSignals(signals, callerAuthorization);
          if (result.executedOrderIds.length > 0)
            for (const signal of signals) submittedActions.push(signal.action);

          return result;
        },
      },
    });

    const postTradeConsistencyRuntime = createSimulationSettlement({
      snapshot,
      tradeRuntime,
      monitorContext,
      termination: createTerminationDouble({ reportFatalError: rethrowFatalError }),
    });
    bindSettlement(postTradeConsistencyRuntime);
    hydrate(ASYNC_PROCESSOR_RUNTIME.clock.now());
    expect(orderRecorder.getCostBasis('BULL.HK', true)).toEqual({
      costAmount: '200',
      quantity: 200,
    });
    expect(dailyLossTracker.getLossOffset('LONG')).toBe('0');
    postTradeConsistencyRuntime.start();
    expect(await postTradeConsistencyRuntime.completeRebuildBaseline()).toBeTrue();
    const originalReceipt = await postTradeConsistencyRuntime.waitForFresh();
    expect(postTradeConsistencyRuntime.isCurrent(originalReceipt)).toBeTrue();
    expect(originalReceipt.snapshotToken).toBe(snapshot.getView().token);
    ingress.setSubmitBehavior(async () => 'EXECUTED-ORDER');
    executor = await createSimulationExecutor({
      ingress,
      tradingConfig,
      symbolRegistry,
      orderRecorder,
      dailyLossTracker,
      riskChecker: monitorContext.riskChecker,
      postTradeConsistencyRuntime,
      marketDataClient: createSimulationQuoteClient(),
      now: ASYNC_PROCESSOR_RUNTIME.clock.now,
      isExecutionAllowed: () =>
        stateFixtures.tradingTimeState.canTrade === true &&
        stateFixtures.lifecycleState.isTradingEnabled,
    });
    const buyProcessor = createBuyProcessor({
      logger: createLoggerDouble(),
      taskQueue: buyTaskQueue,
      workflow: createOrdinaryBuyWorkflow({
        accountService: tradeRuntime.accountService,
        orderExecutor: tradeRuntime.orderExecutor,
        tradeFrequencyReader: tradeRuntime.orderExecutor,
        logger: createLoggerDouble(),
        config: monitorContext.config,
        symbolRegistry,

        orderRecorder,
        marketDataClient: createMarketDataClientDouble({
          getQuotes: async (symbols: Iterable<string>) => {
            const quotes = new Map<string, ReturnType<typeof createQuoteDouble> | null>();
            for (const symbol of symbols) {
              if (symbol === 'HSI.HK') {
                quotes.set(symbol, createQuoteDouble(symbol, '20000', 1));
              } else if (symbol === 'BULL.HK') {
                quotes.set(symbol, createQuoteDouble(symbol, '1.05', 100));
              } else if (symbol === 'BEAR.HK') {
                quotes.set(symbol, createQuoteDouble(symbol, '0.95', 100));
              } else {
                quotes.set(symbol, null);
              }
            }

            return quotes;
          },
        }),
        snapshot,
        getCanProcessTask: () => stateFixtures.lifecycleState.isTradingEnabled,
        termination: createTerminationDouble({ reportFatalError: rethrowFatalError }),
        riskChecker: monitorContext.riskChecker,
        doomsdayProtection: tradingConfig.global.doomsdayProtection,
        liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
        getIsHalfDay: () => stateFixtures.tradingTimeState.isHalfDay ?? false,
        now: ASYNC_PROCESSOR_RUNTIME.clock.now,
      }),
      getCanProcessTask: () => stateFixtures.lifecycleState.isTradingEnabled,
      termination: createTerminationDouble({ reportFatalError: rethrowFatalError }),
    });
    const sellProcessor = createSellProcessor({
      logger: createLoggerDouble(),
      taskQueue: sellTaskQueue,
      scheduler: ASYNC_PROCESSOR_RUNTIME.scheduler,
      workflow: createOrdinarySellWorkflow({
        logger: createLoggerDouble(),
        config: monitorContext.config,
        symbolRegistry,

        orderRecorder,
        orderExecutor: tradeRuntime.orderExecutor,
        marketDataClient: createMarketDataClientDouble({
          getQuotes: async (symbols: Iterable<string>) => {
            const quotes = new Map<string, ReturnType<typeof createQuoteDouble> | null>();
            for (const symbol of symbols) {
              if (symbol === 'HSI.HK') {
                quotes.set(symbol, createQuoteDouble(symbol, '20000', 1));
              } else if (symbol === 'BULL.HK') {
                quotes.set(symbol, createQuoteDouble(symbol, '1.05', 100));
              } else if (symbol === 'BEAR.HK') {
                quotes.set(symbol, createQuoteDouble(symbol, '0.95', 100));
              } else {
                quotes.set(symbol, null);
              }
            }

            return quotes;
          },
        }),
        snapshot,
        getCanProcessTask: () => stateFixtures.lifecycleState.isTradingEnabled,
        termination: createTerminationDouble({ reportFatalError: rethrowFatalError }),
        clock: ASYNC_PROCESSOR_RUNTIME.clock,
        settlement: postTradeConsistencyRuntime,
        getTradingCalendar: () => ({
          isHalfDay: stateFixtures.tradingTimeState.isHalfDay ?? false,
          tradingCalendarSnapshot: stateFixtures.tradingCalendarState.tradingCalendarSnapshot,
        }),
      }),
      getCanProcessTask: () => stateFixtures.lifecycleState.isTradingEnabled,
      termination: createTerminationDouble({ reportFatalError: rethrowFatalError }),
    });

    const candles = createCandles(120, 100, 0.2);
    const candlestickSnapshot = createCandlestickSnapshot(monitorConfig.monitorSymbol, candles);
    if (candlestickSnapshot === null) {
      throw new Error('missing candlestick snapshot for full business simulation');
    }

    const candlestickUpdatedEvents = createSingleListenerEventSource<CandlestickUpdatedEvent>();
    const businessEventProgram = createBusinessEventProgram({
      termination: createTerminationDouble({ reportFatalError: rethrowFatalError }),
      clock: { now: () => new Date('2026-02-16T01:31:00.000Z') },
      marketDataClient: {
        ...createMarketDataClientDouble({
          getQuotes: async () => {
            throw new Error('businessEventProgram must not read realtime quotes');
          },
          getCandlestickSnapshot: (symbol) =>
            symbol === monitorConfig.monitorSymbol ? candlestickSnapshot : null,
        }),
        onCandlestickUpdated: candlestickUpdatedEvents.subscribe,
      },
      monitorContext,
      ...stateFixtures,
      tradingConfig,
      buyTaskQueue,
      sellTaskQueue,
      monitorDisplayRuntime: {
        requestRender: () => {},
      },
    });

    buyProcessor.start();
    sellProcessor.start();
    businessEventProgram.start();
    try {
      candlestickUpdatedEvents.emit({
        symbol: monitorConfig.monitorSymbol,
        period: 'MIN_1',
        snapshot: candlestickSnapshot,
      });

      await Bun.sleep(80);

      expect(submittedActions).toEqual(['SELLCALL']);
    } finally {
      await postTradeConsistencyRuntime.stopAndDrain();
      await businessEventProgram.stopAndDrain();
      await Promise.all([buyProcessor.stopAndDrain(), sellProcessor.stopAndDrain()]);
    }
  });

  it('simulates event-driven auto-search and auto-switch end to end', async () => {
    autoSymbolCandidates = [
      createWarrantCandidateWithOverrides('OLD_BULL.HK', { callPrice: '20000' }),
      null,
      createWarrantCandidateWithOverrides('NEW_BULL.HK', { callPrice: '21000' }),
    ];

    const monitorConfig = createMonitorConfigDouble({
      monitorSymbol: 'HSI.HK',
      longSymbol: 'BULL.HK',
      shortSymbol: 'BEAR.HK',
      targetNotional: '5000',
      autoSearchConfig: {
        autoSearchEnabled: true,
        autoSearchMinDistancePctBull: '0.35',
        autoSearchMinDistancePctBear: '-0.35',
        autoSearchMinTurnoverPerMinuteBull: '100000',
        autoSearchMinTurnoverPerMinuteBear: '100000',
        autoSearchExpiryMinMonths: 3,
        autoSearchOpenDelayMinutes: 0,
        switchIntervalMinutes: 0,
        switchDistanceRangeBull: { min: '0.2', max: '1.5' },
        switchDistanceRangeBear: { min: '-1.5', max: '-0.2' },
      },
    });
    const tradingConfig = createTradingConfigForMonitor(monitorConfig);
    const symbolRegistry = createSymbolRegistryDouble({
      longSeat: {
        symbol: null,
        status: 'EMPTY',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      shortSeat: {
        symbol: null,
        status: 'EMPTY',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      longVersion: 1,
      shortVersion: 1,
    });

    const buyTaskQueue = createBuyTaskQueue({
      clock: { now: () => new Date() },
      diagnostics: createDiagnosticObserverDouble(),
    });
    const sellTaskQueue = createSellTaskQueue({
      clock: { now: () => new Date() },
      diagnostics: createDiagnosticObserverDouble(),
    });
    const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskDataMap>({
      logger: createLoggerDouble(),
      clock: { now: () => new Date() },
      diagnostics: createDiagnosticObserverDouble(),
    });
    const stateFixtures = createSimulationLastState({
      monitorConfig,
      positions: [],
      currentDayKey: '2026-02-16',
    });
    const { ingress, accountService, snapshot, refreshPositions } = await createSimulationSnapshot(
      [],
    );
    const dailyLossTracker = createSimulationDailyLossTracker();

    const executedActions: Array<{ action: string; symbol: string }> = [];
    const executionAttempts: Array<{
      readonly originalAuthorization: boolean;
      readonly acceptedIds: ReadonlyArray<string>;
      readonly nativeIssued: number;
    }> = [];
    const { orderRecorder, hydrate, bindSettlement } = await createSimulationOrderRecorder(
      ingress,
      snapshot,
      monitorConfig,
      dailyLossTracker,
      [simulationExecutionFrame('SELL-1', 'OLD_BULL.HK', 'SELL', '2', 9_999_999_999_999)],
    );

    const orderStateChangedEvents = createSingleListenerEventSource<OrderStateChangedEvent>();
    let executor: OrderExecutor | null = null;
    const tradeRuntime = createTradeRuntimeDouble({
      accountService,
      orderRecorder,
      orderExecutor: {
        executeSignals: async (signals, callerAuthorization) => {
          if (executor === null) throw new Error('Simulation executor not assembled');

          const originalAuthorization = callerAuthorization();
          const result = await executor.executeSignals(signals, callerAuthorization);
          executionAttempts.push({
            originalAuthorization,
            acceptedIds: result.executedOrderIds,
            nativeIssued: ingress.nativeSubmitObservations().length,
          });

          if (result.executedOrderIds.length > 0)
            for (const signal of signals)
              executedActions.push({ action: signal.action, symbol: signal.symbol });

          return result;
        },
      },
      cacheManager: { getPendingOrders: async () => [] },
      orderMonitor: {
        cancelOrder: async () => ({
          kind: 'CANCEL_CONFIRMED',
          relatedBuyOrderIds: null,
        }),
        onOrderStateChanged: orderStateChangedEvents.subscribe,
      },
    });

    const riskChecker = createRiskCheckerDouble({
      getWarrantDistanceInfo: (isLongSymbol, seatSymbol) => {
        if (!isLongSymbol || seatSymbol !== 'OLD_BULL.HK') {
          return null;
        }

        return createWarrantDistanceInfoDouble({
          warrantType: 'BULL',
          distanceNumerator: '1',
          distanceDenominator: '1000',
        });
      },
    });
    const quoteUpdatedEvents = createSingleListenerEventSource<QuoteUpdatedEvent>();
    const autoSwitchMarketDataClient = createMarketDataClientDouble({
      getQuotes: async (symbols: Iterable<string>) => {
        const quotes = new Map<string, ReturnType<typeof createQuoteDouble> | null>();
        for (const symbol of symbols) {
          if (symbol === 'HSI.HK') {
            quotes.set(symbol, createQuoteDouble(symbol, '20000', 1));
            continue;
          }

          quotes.set(symbol, createQuoteDouble(symbol, '1', 100));
        }

        return quotes;
      },
      onQuoteUpdated: quoteUpdatedEvents.subscribe,
    });

    let simulationNowMs = ASYNC_PROCESSOR_RUNTIME.clock.now().getTime();
    const runtimeNow = () => new Date(simulationNowMs);
    const candidateSearch = {
      resolveDistanceRange: (direction: 'LONG' | 'SHORT') =>
        monitorConfig.autoSearchConfig[
          direction === 'LONG' ? 'switchDistanceRangeBull' : 'switchDistanceRangeBear'
        ],
      findCandidate: async () => {
        const candidate = autoSymbolCandidates.shift();
        return candidate ? { symbol: candidate.symbol, callPrice: candidate.callPrice } : null;
      },
    };
    const seatSwitch = createSeatSwitchWorkflow({
      readSwitchPositions: async () => [],
      logger: createLoggerDouble(),
      monitorConfig,
      symbolRegistry,
      marketDataClient: autoSwitchMarketDataClient,
      cacheManager: tradeRuntime.cacheManager,
      orderHoldRegistry: tradeRuntime.orderHoldRegistry,
      orderMonitor: tradeRuntime.orderMonitor,
      orderExecutor: tradeRuntime.orderExecutor,
      orderRecorder,
      riskChecker,
      candidateSearch,
      clock: { now: runtimeNow },
      getTradingCalendarSnapshot: () => stateFixtures.tradingCalendarState.tradingCalendarSnapshot,
    });
    const autoSearch = createAutoSearch({
      monitorSymbol: monitorConfig.monitorSymbol,
      autoSearchConfig: monitorConfig.autoSearchConfig,
      symbolRegistry,
      candidateSearch,
      logger: createLoggerDouble(),
    });

    const monitorContext = createMonitorContextDouble({
      config: monitorConfig,
      symbolRegistry,
      strategy: createStrategyDouble(),
      orderRecorder,
      dailyLossTracker: dailyLossTracker,
      riskChecker,
      unrealizedLossMonitor: createNoopUnrealizedLossMonitor(),
      seatSwitch,
    });
    const postTradeConsistencyRuntime = createSimulationSettlement({
      snapshot,
      tradeRuntime,
      monitorContext,
      termination: createTerminationDouble({ reportFatalError: rethrowFatalError }),
    });
    bindSettlement(postTradeConsistencyRuntime);
    hydrate(ASYNC_PROCESSOR_RUNTIME.clock.now());
    expect(orderRecorder.getSellRecordByOrderId('SELL-1')).toMatchObject({
      costAmount: '200',
      executedQuantity: 100,
      executedTime: 9_999_999_999_999,
    });
    expect(dailyLossTracker.getLossOffset('LONG')).toBe('0');
    postTradeConsistencyRuntime.start();
    expect(await postTradeConsistencyRuntime.completeRebuildBaseline()).toBeTrue();
    const originalReceipt = await postTradeConsistencyRuntime.waitForFresh();
    expect(postTradeConsistencyRuntime.isCurrent(originalReceipt)).toBeTrue();
    expect(originalReceipt.snapshotToken).toBe(snapshot.getView().token);
    ingress.setSubmitBehavior(async () =>
      ingress.nativeSubmitObservations().at(-1)?.side === 'SELL' ? 'SELL-1' : 'BUY-1',
    );

    executor = await createSimulationExecutor({
      ingress,
      tradingConfig,
      symbolRegistry,
      orderRecorder,
      dailyLossTracker,
      riskChecker: monitorContext.riskChecker,
      postTradeConsistencyRuntime,
      marketDataClient: autoSwitchMarketDataClient,
      now: runtimeNow,
      isExecutionAllowed: () =>
        stateFixtures.tradingTimeState.canTrade === true &&
        stateFixtures.lifecycleState.isTradingEnabled,
      onOrderStateChanged: orderStateChangedEvents.emit,
    });
    const tradingGateEventRuntime = createTradingGateEventRuntime();
    const quoteSubscriptionRuntime = createQuoteSubscriptionRuntime({
      snapshot,
      logger: createLoggerDouble(),
      tradingConfig,
      symbolRegistry,
      marketDataClient: autoSwitchMarketDataClient,
      orderHoldRegistry: tradeRuntime.orderHoldRegistry,
      ...stateFixtures,
      termination: createTerminationDouble({ reportFatalError: rethrowFatalError }),
    });
    const switchWakeupRuntime = createSwitchWakeupRuntime({
      snapshot,
      logger: { error: () => {} },
      marketDataClient: autoSwitchMarketDataClient,
      orderMonitor: tradeRuntime.orderMonitor,
      symbolRegistry,
      monitorContext,
      ...stateFixtures,
      postTradeConsistencyRuntime,
      tradingGateEventRuntime,
      doomsdayProtectionEnabled: false,
      now: runtimeNow,
      scheduleTimer: (callback, delayMs) => {
        return setTimeout(callback, delayMs);
      },
      clearTimer: (handle) => {
        clearTimeout(handle);
      },
      quoteSubscriptionRuntime,
      termination: createTerminationDouble({ reportFatalError: rethrowFatalError }),
    });
    const autoSearchWakeupRuntime = createAutoSearchWakeupRuntime({
      termination: createTerminationDouble({ reportFatalError: rethrowFatalError }),
      symbolRegistry,
      autoSearch,
      autoSearchConfig: monitorConfig.autoSearchConfig,
      ...stateFixtures,
      tradingGateEventRuntime,
      doomsdayProtectionEnabled: false,
      now: runtimeNow,
      scheduleTimer: (callback, delayMs) => {
        return setTimeout(callback, delayMs);
      },
      clearTimer: (handle) => {
        clearTimeout(handle);
      },
    });
    const periodicSwitchWakeupRuntime = createPeriodicSwitchWakeupRuntime({
      getCanTradeNow: () =>
        stateFixtures.tradingTimeState.canTrade === true &&
        stateFixtures.lifecycleState.isTradingEnabled,
      snapshot,
      termination: createTerminationDouble({ reportFatalError: rethrowFatalError }),
      monitorContext,
      symbolRegistry,
      monitorTaskQueue,
      orderMonitor: tradeRuntime.orderMonitor,
      postTradeConsistencyRuntime,
      tradingGateEventRuntime,
      calculateDueAtMs: ({ startMs, switchIntervalMinutes }) =>
        startMs + switchIntervalMinutes * 60_000,
      now: runtimeNow,
      scheduleTimer: (callback, delayMs) => {
        return setTimeout(callback, delayMs);
      },
      clearTimer: (handle) => {
        clearTimeout(handle);
      },
    });
    const seatActivationDispatcher = createSeatActivationDispatcher({
      logger: createLoggerDouble(),
      termination: createTerminationDouble({ reportFatalError: rethrowFatalError }),
      symbolRegistry,
      snapshot,
      monitorTaskQueue,
    });
    const monitorTaskProcessor = createMonitorTaskRuntimeFixture({
      snapshot,
      clock: { now: runtimeNow },
      scheduler: ASYNC_PROCESSOR_RUNTIME.scheduler,
      monitorTaskQueue,
      monitorContext,
      tradeRuntime,
      marketDataClient: autoSwitchMarketDataClient,
      quoteSubscriptionRuntime,
      switchWakeupRuntime,
      periodicSwitchWakeupRuntime,

      getCanProcessTask: () => true,
      getCanTradeNow: () => stateFixtures.tradingTimeState.canTrade === true,
      termination: createTerminationDouble({ reportFatalError: rethrowFatalError }),
    });
    const monitorQuoteEventRuntime = createDefaultMonitorQuoteEventRuntime({
      snapshot,
      logger: { error: () => {} },
      scheduleTimer: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimer: (handle) => {
        clearTimeout(handle);
      },
      marketDataClient: autoSwitchMarketDataClient,
      monitorContext,
      executeStaticLiquidation: createStaticLiquidationExecutor({
        orderExecutor: tradeRuntime.orderExecutor,
        marketDataClient: autoSwitchMarketDataClient,
        snapshot,
        postTradeConsistencyRuntime,
        now: runtimeNow,
      }),
      ...stateFixtures,
      postTradeConsistencyRuntime,
      doomsdayProtectionEnabled: false,
      termination: createTerminationDouble({ reportFatalError: rethrowFatalError }),
      now: runtimeNow,
      handoffPendingSwitch: switchWakeupRuntime.handoffPendingSwitch,
      quoteSubscriptionRuntime,
    });

    const buyProcessor = createBuyProcessor({
      logger: createLoggerDouble(),
      taskQueue: buyTaskQueue,
      workflow: createOrdinaryBuyWorkflow({
        accountService: tradeRuntime.accountService,
        orderExecutor: tradeRuntime.orderExecutor,
        tradeFrequencyReader: tradeRuntime.orderExecutor,
        logger: createLoggerDouble(),
        config: monitorContext.config,
        symbolRegistry,

        orderRecorder,
        marketDataClient: createMarketDataClientDouble({
          getQuotes: autoSwitchMarketDataClient.getQuotes,
        }),
        snapshot,
        getCanProcessTask: () => stateFixtures.lifecycleState.isTradingEnabled,
        termination: createTerminationDouble({ reportFatalError: rethrowFatalError }),
        riskChecker: monitorContext.riskChecker,
        doomsdayProtection: tradingConfig.global.doomsdayProtection,
        liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
        getIsHalfDay: () => stateFixtures.tradingTimeState.isHalfDay ?? false,
        now: ASYNC_PROCESSOR_RUNTIME.clock.now,
      }),
      getCanProcessTask: () => stateFixtures.lifecycleState.isTradingEnabled,
      termination: createTerminationDouble({ reportFatalError: rethrowFatalError }),
    });
    const sellProcessor = createSellProcessor({
      logger: createLoggerDouble(),
      taskQueue: sellTaskQueue,
      scheduler: ASYNC_PROCESSOR_RUNTIME.scheduler,
      workflow: createOrdinarySellWorkflow({
        logger: createLoggerDouble(),
        config: monitorContext.config,
        symbolRegistry,

        orderRecorder,
        orderExecutor: tradeRuntime.orderExecutor,
        marketDataClient: createMarketDataClientDouble({
          getQuotes: autoSwitchMarketDataClient.getQuotes,
        }),
        snapshot,
        getCanProcessTask: () => stateFixtures.lifecycleState.isTradingEnabled,
        termination: createTerminationDouble({ reportFatalError: rethrowFatalError }),
        clock: ASYNC_PROCESSOR_RUNTIME.clock,
        settlement: postTradeConsistencyRuntime,
        getTradingCalendar: () => ({
          isHalfDay: stateFixtures.tradingTimeState.isHalfDay ?? false,
          tradingCalendarSnapshot: stateFixtures.tradingCalendarState.tradingCalendarSnapshot,
        }),
      }),
      getCanProcessTask: () => stateFixtures.lifecycleState.isTradingEnabled,
      termination: createTerminationDouble({ reportFatalError: rethrowFatalError }),
    });

    function emitMonitorQuoteUpdated(price: string): void {
      quoteUpdatedEvents.emit({
        symbol: monitorConfig.monitorSymbol,
        quote: createQuoteDouble(monitorConfig.monitorSymbol, price, 1),
      });
    }

    function emitOrderStateChanged(symbol: string): void {
      const frame = simulationExecutionFrame('SELL-1', symbol, 'SELL', '2', 9_999_999_999_999);
      ingress.setOrderDetailReplies([frame]);
      ingress.setExecutionReplies([
        {
          orderId: frame.orderId,
          tradeId: frame.tradeId,
          symbol,
          quantity: '100',
          price: '2',
          tradeDoneAtMs: 9_999_999_999_999,
        },
      ]);
      ingress.emitOrderChangedFrame(frame);
    }

    buyProcessor.start();
    sellProcessor.start();
    monitorTaskProcessor.start();
    await quoteSubscriptionRuntime.reconcileFromCurrentTruth();
    quoteSubscriptionRuntime.start();
    seatActivationDispatcher.start();
    autoSearchWakeupRuntime.start();
    periodicSwitchWakeupRuntime.start();
    switchWakeupRuntime.start();
    monitorQuoteEventRuntime.start();
    try {
      await waitUntil(() => {
        const seat = symbolRegistry.getSeatState('LONG');
        return (
          seat.symbol === 'OLD_BULL.HK' &&
          (seat.status === 'ACTIVATING' || seat.status === 'ACTIVE')
        );
      }).catch((error: unknown) => {
        throw new Error(
          `initial auto-search timeout: seat=${JSON.stringify(symbolRegistry.getSeatState('LONG'))}, cause=${error instanceof Error ? error.message : String(error)}`,
        );
      });

      const searchedSeat = symbolRegistry.getSeatState('LONG');
      expect(searchedSeat.symbol).toBe('OLD_BULL.HK');
      expect(['ACTIVATING', 'ACTIVE']).toContain(searchedSeat.status);
      expect(symbolRegistry.getSeatVersion('LONG')).toBe(2);

      await waitUntil(() => {
        const seat = symbolRegistry.getSeatState('LONG');
        return seat.status === 'ACTIVE' && seat.symbol === 'OLD_BULL.HK';
      }).catch((error: unknown) => {
        throw new Error(
          `seat activation timeout after second monitor cycle: seat=${JSON.stringify(symbolRegistry.getSeatState('LONG'))}, cause=${error instanceof Error ? error.message : String(error)}`,
        );
      });

      const activatedSeat = symbolRegistry.getSeatState('LONG');
      expect(activatedSeat.status).toBe('ACTIVE');
      expect(activatedSeat.symbol).toBe('OLD_BULL.HK');

      const oldPosition = createPositionDouble({
        symbol: 'OLD_BULL.HK',
        quantity: 100,
        availableQuantity: 100,
      });
      await refreshPositions([oldPosition]);
      const positionedReceipt = await postTradeConsistencyRuntime.waitForFresh();
      expect(postTradeConsistencyRuntime.isCurrent(positionedReceipt)).toBeTrue();
      await quoteSubscriptionRuntime.reconcileFromCurrentTruth();

      // 寻标与订单执行都处于真实连续交易授权；行情事件只触发距离换标，不再承担补席。
      simulationNowMs = ASYNC_PROCESSOR_RUNTIME.clock.now().getTime();
      emitMonitorQuoteUpdated('20010');
      await waitUntil(() => executedActions.length > 0).catch((error: unknown) => {
        throw new Error(
          `native switch SELL timeout: originalClock=${runtimeNow().toISOString()}, attempts=${JSON.stringify(executionAttempts)}, seat=${JSON.stringify(symbolRegistry.getSeatState('LONG'))}`,
          { cause: error },
        );
      });

      expect(executedActions[0]?.action).toBe('SELLCALL');
      expect(executedActions[0]?.symbol).toBe('OLD_BULL.HK');

      await refreshPositions([]);
      const clearedReceipt = await postTradeConsistencyRuntime.waitForFresh();
      expect(postTradeConsistencyRuntime.isCurrent(clearedReceipt)).toBeTrue();
      await quoteSubscriptionRuntime.reconcileFromCurrentTruth();
      emitOrderStateChanged('OLD_BULL.HK');

      await waitUntil(() => executedActions.length > 1).catch((error: unknown) => {
        throw new Error(
          `rebuy action timeout: seat=${JSON.stringify(symbolRegistry.getSeatState('LONG'))}, actions=${JSON.stringify(executedActions)}, cause=${error instanceof Error ? error.message : String(error)}`,
        );
      });

      await waitUntil(() => {
        const seat = symbolRegistry.getSeatState('LONG');
        return (
          seat.symbol === 'NEW_BULL.HK' &&
          (seat.status === 'ACTIVATING' || seat.status === 'ACTIVE')
        );
      }).catch((error: unknown) => {
        throw new Error(
          `rebuy seat transition timeout: seat=${JSON.stringify(symbolRegistry.getSeatState('LONG'))}, actions=${JSON.stringify(executedActions)}, cause=${error instanceof Error ? error.message : String(error)}`,
        );
      });

      expect(executedActions[1]?.action).toBe('BUYCALL');
      expect(executedActions[1]?.symbol).toBe('NEW_BULL.HK');
      expect(executedActions).toHaveLength(2);

      await waitUntil(() => {
        const seat = symbolRegistry.getSeatState('LONG');
        return seat.status === 'ACTIVE' && seat.symbol === 'NEW_BULL.HK';
      }).catch((error: unknown) => {
        throw new Error(
          `final seat activation timeout: seat=${JSON.stringify(symbolRegistry.getSeatState('LONG'))}, actions=${JSON.stringify(executedActions)}, cause=${error instanceof Error ? error.message : String(error)}`,
        );
      });

      const finalSeat = symbolRegistry.getSeatState('LONG');
      expect(finalSeat.status).toBe('ACTIVE');
      expect(finalSeat.symbol).toBe('NEW_BULL.HK');
      expect(symbolRegistry.getSeatVersion('LONG')).toBe(3);
    } finally {
      await postTradeConsistencyRuntime.stopAndDrain();
      await Promise.all([
        autoSearchWakeupRuntime.stopAndDrain(),
        quoteSubscriptionRuntime.stopAndDrain(),
        monitorQuoteEventRuntime.stopAndDrain(),
        switchWakeupRuntime.stopAndDrain(),
        periodicSwitchWakeupRuntime.stopAndDrain(),
        buyProcessor.stopAndDrain(),
        sellProcessor.stopAndDrain(),
        monitorTaskProcessor.stopAndDrain(),
      ]);
      seatActivationDispatcher.stop();
    }
  });

  it('simulates cross-day cleanup and open rebuild via time wakeup lifecycle domains', async () => {
    const originalNow = Date.now;
    Date.now = () => new Date('2026-02-16T05:00:00.000Z').getTime();

    const monitorConfig = createMonitorConfigDouble({
      monitorSymbol: 'HSI.HK',
      longSymbol: 'BULL.HK',
      shortSymbol: 'BEAR.HK',
      smartCloseEnabled: true,
    });
    const tradingConfig = createTradingConfigForMonitor(monitorConfig);
    const symbolRegistry = createSymbolRegistryDouble({
      longSeat: {
        symbol: 'BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      shortSeat: {
        symbol: 'BEAR.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      longVersion: 1,
      shortVersion: 1,
    });

    const buyTaskQueue = createBuyTaskQueue({
      clock: { now: () => new Date() },
      diagnostics: createDiagnosticObserverDouble(),
    });
    const sellTaskQueue = createSellTaskQueue({
      clock: { now: () => new Date() },
      diagnostics: createDiagnosticObserverDouble(),
    });
    const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskDataMap>({
      logger: createLoggerDouble(),
      clock: { now: () => new Date() },
      diagnostics: createDiagnosticObserverDouble(),
    });
    const longPosition = createPositionDouble({
      symbol: 'BULL.HK',
      quantity: 200,
      availableQuantity: 200,
    });
    const stateFixtures = createSimulationLastState({
      monitorConfig,
      positions: [longPosition],
      currentDayKey: '1999-01-01',
    });
    const { ingress, accountService, snapshot, refreshPositions } = await createSimulationSnapshot([
      longPosition,
    ]);
    const dailyLossTracker = createSimulationDailyLossTracker();

    const { orderRecorder, hydrate, bindSettlement } = await createSimulationOrderRecorder(
      ingress,
      snapshot,
      monitorConfig,
      dailyLossTracker,
      [
        simulationExecutionFrame('BUY-ORIGIN', 'BULL.HK', 'BUY', '1', 1),
        simulationExecutionFrame('BUY-100', 'BULL.HK', 'BUY', '1', Date.now()),
      ],
    );

    let resetForTradingDayCalls = 0;

    const monitorContext = createMonitorContextDouble({
      config: monitorConfig,
      symbolRegistry,
      strategy: createStrategyDouble({
        resetForTradingDay: () => {
          resetForTradingDayCalls += 1;
        },
      }),
      orderRecorder,
      dailyLossTracker: dailyLossTracker,
      riskChecker: createRiskCheckerDouble(),
      unrealizedLossMonitor: createNoopUnrealizedLossMonitor(),
      seatSwitch: {
        evaluatePeriodicSwitchDue: async () => ({
          kind: 'NOOP',
        }),
        startSwitchOnDistance: async (params) => ({
          started: false,
          direction: params.direction,
          driveResult: {
            kind: 'NOOP',
          },
        }),
        advancePendingSwitch: async (params) => ({
          advanced: false,
          direction: params.direction,
          stillPending: false,
          driveResult: {
            kind: 'NOOP',
          },
        }),
        hasPendingSwitch: () => false,
        getPeriodicSwitchPendingState: () => ({
          pending: false,
        }),
        resetAllState: () => {},
      },
    });
    const submittedActions: string[] = [];
    let executor: OrderExecutor | null = null;
    const tradeRuntime = createTradeRuntimeDouble({
      accountService,
      orderRecorder,
      orderExecutor: {
        executeSignals: async (signals, callerAuthorization) => {
          if (executor === null) throw new Error('Simulation executor not assembled');

          const result = await executor.executeSignals(signals, callerAuthorization);
          if (result.executedOrderIds.length > 0)
            for (const signal of signals) submittedActions.push(signal.action);

          return result;
        },
      },
    });

    const postTradeConsistencyRuntime = createSimulationSettlement({
      snapshot,
      tradeRuntime,
      monitorContext,
      termination: createTerminationDouble({ reportFatalError: rethrowFatalError }),
    });
    bindSettlement(postTradeConsistencyRuntime);
    hydrate(ASYNC_PROCESSOR_RUNTIME.clock.now());
    expect(orderRecorder.getCostBasis('BULL.HK', true)).toEqual({
      costAmount: '200',
      quantity: 200,
    });
    expect(dailyLossTracker.getLossOffset('LONG')).toBe('0');
    postTradeConsistencyRuntime.start();
    expect(await postTradeConsistencyRuntime.completeRebuildBaseline()).toBeTrue();
    const originalReceipt = await postTradeConsistencyRuntime.waitForFresh();
    expect(postTradeConsistencyRuntime.isCurrent(originalReceipt)).toBeTrue();
    expect(originalReceipt.snapshotToken).toBe(snapshot.getView().token);
    ingress.setSubmitBehavior(async () => 'EXECUTED-ORDER');
    executor = await createSimulationExecutor({
      ingress,
      tradingConfig,
      symbolRegistry,
      orderRecorder,
      dailyLossTracker,
      riskChecker: monitorContext.riskChecker,
      postTradeConsistencyRuntime,
      marketDataClient: createSimulationQuoteClient(),
      now: ASYNC_PROCESSOR_RUNTIME.clock.now,
      isExecutionAllowed: () =>
        stateFixtures.tradingTimeState.canTrade === true &&
        stateFixtures.lifecycleState.isTradingEnabled,
    });
    const buyProcessor = createBuyProcessor({
      logger: createLoggerDouble(),
      taskQueue: buyTaskQueue,
      workflow: createOrdinaryBuyWorkflow({
        accountService: tradeRuntime.accountService,
        orderExecutor: tradeRuntime.orderExecutor,
        tradeFrequencyReader: tradeRuntime.orderExecutor,
        logger: createLoggerDouble(),
        config: monitorContext.config,
        symbolRegistry,

        orderRecorder,
        marketDataClient: createMarketDataClientDouble({
          getQuotes: async (symbols: Iterable<string>) => {
            const quotes = new Map<string, ReturnType<typeof createQuoteDouble> | null>();
            for (const symbol of symbols) {
              if (symbol === 'HSI.HK') {
                quotes.set(symbol, createQuoteDouble(symbol, '20000', 1));
              } else if (symbol === 'BULL.HK') {
                quotes.set(symbol, createQuoteDouble(symbol, '1.05', 100));
              } else if (symbol === 'BEAR.HK') {
                quotes.set(symbol, createQuoteDouble(symbol, '0.95', 100));
              } else {
                quotes.set(symbol, null);
              }
            }

            return quotes;
          },
        }),
        snapshot,
        getCanProcessTask: () => stateFixtures.lifecycleState.isTradingEnabled,
        termination: createTerminationDouble({ reportFatalError: rethrowFatalError }),
        riskChecker: monitorContext.riskChecker,
        doomsdayProtection: tradingConfig.global.doomsdayProtection,
        liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
        getIsHalfDay: () => stateFixtures.tradingTimeState.isHalfDay ?? false,
        now: ASYNC_PROCESSOR_RUNTIME.clock.now,
      }),
      getCanProcessTask: () => stateFixtures.lifecycleState.isTradingEnabled,
      termination: createTerminationDouble({ reportFatalError: rethrowFatalError }),
    });
    const sellProcessor = createSellProcessor({
      logger: createLoggerDouble(),
      taskQueue: sellTaskQueue,
      scheduler: ASYNC_PROCESSOR_RUNTIME.scheduler,
      workflow: createOrdinarySellWorkflow({
        logger: createLoggerDouble(),
        config: monitorContext.config,
        symbolRegistry,

        orderRecorder,
        orderExecutor: tradeRuntime.orderExecutor,
        marketDataClient: createMarketDataClientDouble({
          getQuotes: async (symbols: Iterable<string>) => {
            const quotes = new Map<string, ReturnType<typeof createQuoteDouble> | null>();
            for (const symbol of symbols) {
              if (symbol === 'HSI.HK') {
                quotes.set(symbol, createQuoteDouble(symbol, '20000', 1));
              } else if (symbol === 'BULL.HK') {
                quotes.set(symbol, createQuoteDouble(symbol, '1.05', 100));
              } else if (symbol === 'BEAR.HK') {
                quotes.set(symbol, createQuoteDouble(symbol, '0.95', 100));
              } else {
                quotes.set(symbol, null);
              }
            }

            return quotes;
          },
        }),
        snapshot,
        getCanProcessTask: () => stateFixtures.lifecycleState.isTradingEnabled,
        termination: createTerminationDouble({ reportFatalError: rethrowFatalError }),
        clock: ASYNC_PROCESSOR_RUNTIME.clock,
        settlement: postTradeConsistencyRuntime,
        getTradingCalendar: () => ({
          isHalfDay: stateFixtures.tradingTimeState.isHalfDay ?? false,
          tradingCalendarSnapshot: stateFixtures.tradingCalendarState.tradingCalendarSnapshot,
        }),
      }),
      getCanProcessTask: () => stateFixtures.lifecycleState.isTradingEnabled,
      termination: createTerminationDouble({ reportFatalError: rethrowFatalError }),
    });
    const monitorTaskProcessor = createMonitorTaskRuntimeFixture({
      snapshot,
      ...ASYNC_PROCESSOR_RUNTIME,
      monitorTaskQueue,
      monitorContext,
      tradeRuntime,
      marketDataClient: createMarketDataClientDouble(),
      quoteSubscriptionRuntime: createQuoteSubscriptionRuntimeDouble(),
      switchWakeupRuntime: {
        handoffPendingSwitch: () => {},
      },
      periodicSwitchWakeupRuntime: createPeriodicSwitchWakeupRuntimeDouble(),

      getCanProcessTask: () => stateFixtures.lifecycleState.isTradingEnabled,
      getCanTradeNow: () => stateFixtures.tradingTimeState.canTrade === true,
      termination: createTerminationDouble({ reportFatalError: rethrowFatalError }),
    });

    let runOpenRebuildCount = 0;
    let postTradeStartCount = 0;
    let postTradeStopCount = 0;

    const signalRuntimeDomain = createSignalRuntimeDomain({
      termination: createTerminationDouble({ reportFatalError: rethrowFatalError }),
      logger: createLoggerDouble(),
      monitorContext,
      buyProcessor,
      sellProcessor,
      monitorTaskProcessor,
      businessEventProgram: {
        start: () => {},
        stopAndDrain: async () => {},
      },
      postTradeConsistencyRuntime: {
        ...postTradeConsistencyRuntime,
        start: () => {
          postTradeStartCount += 1;
          postTradeConsistencyRuntime.start();
        },
        stopAndDrain: async () => {
          postTradeStopCount += 1;
          await postTradeConsistencyRuntime.stopAndDrain();
        },
        completeRebuildBaseline: async () => {
          hydrate(ASYNC_PROCESSOR_RUNTIME.clock.now());
          return postTradeConsistencyRuntime.completeRebuildBaseline();
        },
      },
      tradingRiskEventRuntime: {
        start: () => {},
        stopAndDrain: async () => {},
      },
      monitorQuoteEventRuntime: {
        stop: () => {},
        start: () => {},
        stopAndDrain: async () => {},
      },
      monitorDisplayRuntime: {
        start: () => {},
        stopAndDrain: async () => {},
      },
      tradingQuoteDisplayRuntime: {
        start: () => {},
        stopAndDrain: async () => {},
      },
      switchWakeupRuntime: {
        start: () => {},
        stopAndDrain: async () => {},
      },
      periodicSwitchWakeupRuntime: createPeriodicSwitchWakeupRuntimeDouble(),
      quoteSubscriptionRuntime: createQuoteSubscriptionRuntimeDouble(),
      autoSearchWakeupRuntime: createAutoSearchWakeupRuntimeDouble(),
      seatActivationDispatcher: createSeatActivationDispatcherDouble(),
      seatRuntimeCleanupDispatcher: createSeatRuntimeCleanupDispatcherDouble(),
      orderMonitor: tradeRuntime.orderMonitor,
      buyTaskQueue,
      sellTaskQueue,
      monitorTaskQueue,
    });

    const globalStateDomain = createGlobalStateDomain({
      snapshot,
      logger: createLoggerDouble(),
      ...stateFixtures,
      runTradingDayOpenRebuild: async () => {
        runOpenRebuildCount += 1;
        // 当日恢复读取同 ctx 金融事实，发布成对 H；不写回已退役的 RuntimeStateFixtures 缓存。
        const rebuiltPositions = [
          createPositionDouble({
            symbol: 'BULL.HK',
            quantity: 500,
            availableQuantity: 500,
          }),
        ];
        return await refreshPositions(rebuiltPositions, 'LIFECYCLE_REBUILD');
      },
    });

    const dayLifecycleManager = createDayLifecycleManager({
      diagnostics: createDiagnosticObserverDouble(),
      snapshot,
      termination: createTerminationDouble(),
      mutableState: stateFixtures.lifecycleState,
      cacheDomains: [signalRuntimeDomain, globalStateDomain],
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
      rebuildRetryDelayMs: 10,
    });

    buyTaskQueue.push({
      type: 'STRATEGY_BUY',
      data: createSignal({
        symbol: 'BULL.HK',
        action: 'BUYCALL',
        reason: 'queued-before-midnight',
        triggerTimeMs: Date.now(),
      }),
    });

    sellTaskQueue.push({
      type: 'STRATEGY_SELL',
      data: createSignal({
        symbol: 'BULL.HK',
        action: 'SELLCALL',
        reason: 'queued-before-midnight',
        triggerTimeMs: Date.now(),
      }),
    });

    try {
      const marketDataClient = createMarketDataClientDouble({
        getQuotes: async (symbols: Iterable<string>) => {
          const quotes = new Map<string, ReturnType<typeof createQuoteDouble> | null>();
          for (const symbol of symbols) {
            if (symbol === 'HSI.HK') {
              quotes.set(symbol, createQuoteDouble(symbol, '20000', 1));
            } else if (symbol === 'BULL.HK') {
              quotes.set(symbol, createQuoteDouble(symbol, '1.05', 100));
            } else if (symbol === 'BEAR.HK') {
              quotes.set(symbol, createQuoteDouble(symbol, '0.95', 100));
            } else {
              quotes.set(symbol, null);
            }
          }

          return quotes;
        },
        getCandlestickSnapshot: (symbol) =>
          symbol === monitorConfig.monitorSymbol
            ? createCandlestickSnapshot(symbol, createCandles(120, 100, 0.2))
            : null,
      });

      await timeWakeupEvaluationProgram({
        snapshot,
        logger: createLoggerDouble(),
        marketDataClient,
        cacheManager: tradeRuntime.cacheManager,
        orderMonitor: tradeRuntime.orderMonitor,
        orderExecutor: tradeRuntime.orderExecutor,
        ...stateFixtures,
        doomsdayClearanceWorkflow: createDoomsdayClearanceWorkflowDouble(),
        tradingConfig,
        monitorContext,
        tradingGateEventRuntime: createTradingGateEventRuntimeDouble(),

        dayLifecycleManager,
        now: () => new Date(Date.now()),
      });

      expect(stateFixtures.lifecycleState.lifecycleState).toBe('MIDNIGHT_CLEANED');
      expect(stateFixtures.lifecycleState.pendingOpenRebuild).toBeTrue();
      expect(stateFixtures.lifecycleState.isTradingEnabled).toBeFalse();
      expect(buyTaskQueue.isEmpty()).toBeTrue();
      expect(sellTaskQueue.isEmpty()).toBeTrue();
      expect(resetForTradingDayCalls).toBe(1);
      expect(postTradeStopCount).toBe(1);

      await timeWakeupEvaluationProgram({
        snapshot,
        logger: createLoggerDouble(),
        marketDataClient,
        cacheManager: tradeRuntime.cacheManager,
        orderMonitor: tradeRuntime.orderMonitor,
        orderExecutor: tradeRuntime.orderExecutor,
        ...stateFixtures,
        doomsdayClearanceWorkflow: createDoomsdayClearanceWorkflowDouble(),
        tradingConfig,
        monitorContext,
        tradingGateEventRuntime: createTradingGateEventRuntimeDouble(),

        dayLifecycleManager,
        now: () => new Date(Date.now()),
      });

      expect(runOpenRebuildCount).toBe(1);
      expect(stateFixtures.lifecycleState.lifecycleState).toBe('ACTIVE');
      expect(stateFixtures.lifecycleState.pendingOpenRebuild).toBeFalse();
      expect(stateFixtures.lifecycleState.isTradingEnabled).toBeTrue();
      expect(postTradeStartCount).toBe(1);

      sellTaskQueue.push({
        type: 'STRATEGY_SELL',
        data: createSignal({
          symbol: 'BULL.HK',
          action: 'SELLCALL',
          reason: 'after-open-rebuild',
          triggerTimeMs: Date.now(),
        }),
      });
      await Bun.sleep(80);

      expect(submittedActions).toEqual(['SELLCALL']);
    } finally {
      await postTradeConsistencyRuntime.stopAndDrain();
      Date.now = originalNow;
      await Promise.all([
        buyProcessor.stopAndDrain(),
        sellProcessor.stopAndDrain(),
        monitorTaskProcessor.stopAndDrain(),
      ]);
    }
  });
});
