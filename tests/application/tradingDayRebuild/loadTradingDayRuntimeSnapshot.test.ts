import { createDiagnosticObserverDouble } from '../../helpers/diagnostics.js';
import type { AccountService } from '../../../src/types/accountReadPorts.js';
import type { RuntimeStateFixtures } from '../../helpers/types.js';

/**
 * 交易日运行时快照加载单元测试
 *
 * 覆盖：requireTradingDay 且非交易日时抛错、账户信息缺失时抛错、
 * 订单拉取失败时抛错、正常返回 allOrders 与 quotesMap
 */

import { describe, expect, it, spyOn } from 'bun:test';
import { rejects } from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTradingConfig as createTradingConfigFactory } from '../../../mock/factories/configFactory.js';
import { createPostTradeConsistencyRuntime } from '../../../src/app/runtime/createPostTradeConsistencyRuntime.js';
import { createTerminationRuntime } from '../../../src/runtime/lifecycle/terminationRuntime.js';
import { createWarrantCandidateSearch } from '../../../src/application/autoSearch/candidateSearch.js';
import { createStartupSeatSearch } from '../../../src/application/autoSearch/startupSeatSearch.js';
import { TRADING } from '../../../src/constants/index.js';
import { createProtectiveLiquidationEpisodeTracker } from '../../../src/domain/liquidation/episode/index.js';
import type { ProtectiveLiquidationEpisodeTracker } from '../../../src/domain/liquidation/episode/types.js';
import { orderAnalysis } from '../../../src/domain/order/orderAnalysis.js';
import { createDailyLossTracker } from '../../../src/domain/risk/dailyLossTracker.js';
import { createSymbolRegistry } from '../../../src/domain/seat/symbolRegistry.js';
import { createMixedTradeLogRepository } from '../../../src/infrastructure/persistence/mixedTradeLogRepository/index.js';
import { createLoadTradingDayRuntimeSnapshot } from '../../../src/application/tradingDayRebuild/loadTradingDayRuntimeSnapshot.js';
import { loadStartupSnapshot } from '../../../src/application/tradingDayRebuild/startupSnapshot.js';
import { executeTradingDayOpenRebuild } from '../../../src/application/tradingDayRebuild/openRebuild.js';
import { applyStartupSnapshotFailureState } from '../../../src/application/tradingDayRebuild/startupFailureState.js';
import { createDayLifecycleManager } from '../../../src/runtime/lifecycle/dayLifecycleManager.js';
import { createMarketFixture } from '../../infrastructure/longbridge/market/marketFixture.js';
import { createQuoteSubscriptionRuntime } from '../../../src/runtime/quoteSubscriptionRuntime/index.js';
import type {
  LoadTradingDayRuntimeSnapshotDeps,
  LoadTradingDayRuntimeSnapshotParams,
  RunTradingDayOpenRebuildParams,
} from '../../../src/application/tradingDayRebuild/types.js';
import type { MonitorTaskDataMap } from '../../../src/runtime/asyncProgram/monitorTaskProcessor/types.js';
import { createMonitorTaskQueue } from '../../../src/runtime/asyncProgram/monitorTaskQueue/index.js';
import { createSeatActivationDispatcher } from '../../../src/runtime/seatActivationDispatcher/index.js';
import type {
  MarketQuoteContext,
  MarketWarrantListRequest,
} from '../../../src/types/marketPorts.js';
import type { BullBearWarrantType } from '../../../src/types/warrantRisk.js';
import type { OrderFact } from '../../../src/types/trade.js';
import type { MixedTradeLogRepository } from '../../../src/types/tradeLog.js';
import { getTradingMinutesSinceOpen } from '../../../src/domain/tradingSession/index.js';
import { toHongKongTimeIso } from '../../../src/utils/time/index.js';
import { buildTradeLogPath } from '../../../src/infrastructure/persistence/mixedTradeLogRepository/tradeLogPath.js';
import { createExternalApiRequestError } from '../../helpers/createExternalApiRequestError.js';
import {
  createAccountSnapshotDouble,
  createDailyLossTrackerDouble,
  createLiquidationCooldownTrackerDouble,
  createLoggerDouble,
  createMarketDataClientDouble,
  createMonitorConfigDouble,
  createMonitorContextDouble,
  createProtectiveLiquidationEpisodeTrackerDouble,
  createQuoteContextDouble,
  createSeatActivationDispatcherDouble,
  createTradeRuntimeDouble,
} from '../../helpers/testDoubles.js';
import { createBrokerIngressFixture } from '../../integration/architectureRefactoringP1Native/trade/brokerIngressFixture.js';
import { createEmptySnapshotFixture } from '../../helpers/accountPositionSnapshot.js';

function createMinimalRuntimeStates(): RuntimeStateFixtures {
  return {
    tradingTimeState: { canTrade: null, isHalfDay: null, openProtectionActive: null },
    lifecycleState: {
      currentDayKey: null,
      lifecycleState: 'ACTIVE',
      pendingOpenRebuild: false,
      isTradingEnabled: true,
    },
    tradingCalendarState: { cachedTradingDayInfo: null, tradingCalendarSnapshot: new Map() },
    quoteSubscriptionState: { allTradingSymbols: new Set<string>() },
  };
}

function createTradingConfig(
  monitor: LoadTradingDayRuntimeSnapshotDeps['tradingConfig']['monitor'] = createMonitorConfigDouble(),
): LoadTradingDayRuntimeSnapshotDeps['tradingConfig'] {
  return createTradingConfigFactory({ monitor });
}

/** loader 测试夹具：除注入依赖外保留真实 termination 的 reportFatalError，供 snapshot fatal 验证使用。 */
type LoadTradingDayRuntimeSnapshotHarness = LoadTradingDayRuntimeSnapshotDeps & {
  readonly reportFatalError: (error: unknown) => void;
  readonly termination: ReturnType<typeof createTerminationRuntime>;
  readonly postTradeConsistencyRuntime: ReturnType<typeof createPostTradeConsistencyRuntime>;
  readonly lifecycleState: RuntimeStateFixtures['lifecycleState'];
};

function createBaseDeps(
  overrides: Partial<LoadTradingDayRuntimeSnapshotHarness> & {
    readonly accountService?: AccountService;
    readonly orderMonitor?: ReturnType<typeof createTradeRuntimeDouble>['orderMonitor'];
    readonly orderRecorder?: ReturnType<typeof createTradeRuntimeDouble>['orderRecorder'];
  } = {},
): LoadTradingDayRuntimeSnapshotHarness {
  const tradingConfig = overrides.tradingConfig ?? createTradingConfig();
  const marketDataClient = overrides.marketDataClient ?? createMarketDataClientDouble();
  const tradeRuntime = createTradeRuntimeDouble();
  const accountService = overrides.accountService ?? tradeRuntime.accountService;
  const stateFixtures = createMinimalRuntimeStates();
  const orderMonitor = overrides.orderMonitor ?? tradeRuntime.orderMonitor;
  const orderRecorder = overrides.orderRecorder ?? tradeRuntime.orderRecorder;
  const termination = createTerminationRuntime({
    closeTradingGate: () => {
      stateFixtures.lifecycleState.isTradingEnabled = false;
    },
    closeProducerAdmission: () => {},
    stopProducers: [],
    onSecondaryError: () => {},
  });
  const reportFatalError = overrides.reportFatalError ?? termination.reportFatalError;
  const snapshot =
    overrides.snapshot ??
    createEmptySnapshotFixture({
      reportFatalError,
      readPort: {
        getAccountSnapshot: () => accountService.getAccountSnapshot(),
        getStockPositions: () => accountService.getStockPositions(),
      },
    });

  const symbolRegistry = overrides.symbolRegistry ?? createSymbolRegistry(tradingConfig.monitor);
  const dailyLossTracker = overrides.dailyLossTracker ?? createDailyLossTrackerDouble();
  const protectiveLiquidationEpisodeTracker =
    overrides.protectiveLiquidationEpisodeTracker ??
    createProtectiveLiquidationEpisodeTrackerDouble();
  const mixedTradeLogRepository =
    overrides.mixedTradeLogRepository ?? createMixedTradeLogRepositoryDouble();
  const postTrade = createPostTradeConsistencyRuntime({
    diagnostics: createDiagnosticObserverDouble(),
    clock: { now: () => new Date() },
    logger: createLoggerDouble(),
    snapshot,
    termination,
    getProtectiveOrderReader: () => orderMonitor,
    onPositionsCommitted: async () => {},
    scheduler: { scheduleTimer: setTimeout, clearTimer: clearTimeout },
  });
  // loader 的 crash-gap 仍走真实唯一 owner，复用场景中的 tracker/daily/repository，不能以 noop 伪造完成。
  postTrade.bindBusinessDeps({
    monitorContext: createMonitorContextDouble({
      config: tradingConfig.monitor,
      symbolRegistry,
      orderRecorder,
      dailyLossTracker,
    }),
    dailyLossTracker,
    protectiveLiquidationEpisodeTracker,
    mixedTradeLogRepository,
    liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
  });

  return {
    logger: createLoggerDouble(),
    snapshot,
    marketDataClient,
    orderRecorder: tradeRuntime.orderRecorder,
    orderHoldRegistry: tradeRuntime.orderHoldRegistry,
    orderMonitor: tradeRuntime.orderMonitor,
    ...stateFixtures,
    tradingConfig,
    symbolRegistry,
    dailyLossTracker,
    protectiveLiquidationEpisodeTracker,
    tradeLogHydrator: overrides.tradeLogHydrator ?? {
      hydrate: () => {},
    },
    mixedTradeLogRepository,
    protectionRecovery: overrides.protectionRecovery ?? postTrade,
    startupSeatSearch:
      overrides.startupSeatSearch ??
      createStartupSeatSearch({
        monitorSymbol: tradingConfig.monitor.monitorSymbol,
        symbolRegistry,
        candidateSearch: createWarrantCandidateSearch({
          monitorSymbol: tradingConfig.monitor.monitorSymbol,
          autoSearchConfig: tradingConfig.monitor.autoSearchConfig,
          marketDataClient,
          logger: createLoggerDouble(),
          getTradingMinutesSinceOpen,
        }),
        logger: createLoggerDouble(),
      }),
    seatActivationDispatcher:
      overrides.seatActivationDispatcher ?? createSeatActivationDispatcherDouble(),
    reportFatalError,
    termination,
    postTradeConsistencyRuntime: postTrade,
    ...overrides,
  };
}

function createMixedTradeLogRepositoryDouble(
  overrides: Partial<MixedTradeLogRepository> = {},
): MixedTradeLogRepository {
  return {
    loadCompletionRecords: () => [],
    loadExecutionProgressRecords: () => [],
    appendCompletionIdempotent: () => {},
    appendExecutionProgressIdempotent: () => {},
    appendTradeRecord: () => {},
    ...overrides,
  };
}

function createReadyTrader(
  overrides: Parameters<typeof createTradeRuntimeDouble>[0] = {},
): ReturnType<typeof createTradeRuntimeDouble> {
  return createTradeRuntimeDouble({
    ...overrides,
    accountService: {
      getAccountSnapshot: async () => createAccountSnapshotDouble('100000'),
      getStockPositions: async () => [],
      ...overrides.accountService,
    },
    orderRecorder: { fetchAllOrdersFromAPI: async () => [], ...overrides.orderRecorder },
  });
}

function createLoadParams(
  overrides: Partial<LoadTradingDayRuntimeSnapshotParams> = {},
): LoadTradingDayRuntimeSnapshotParams {
  return {
    requireTradingDay: false,
    resetRuntimeSubscriptions: false,
    hydrateCooldownFromTradeLog: false,
    source: 'STARTUP',
    ...overrides,
    now: overrides.now ?? new Date(),
  };
}

/** 真实 adapter 场景的中性历史输入；SDK DTO 仅由 infra fixture 生成。 */
function createStartupSnapshotOrderInput(
  nowMs: number,
): Parameters<typeof createBrokerIngressFixture>[0] {
  return {
    orderId: 'STARTUP-SNAPSHOT-BUY',
    symbol: 'BULL.HK',
    stockName: 'HSI RC',
    remark: 'AUTO',
    side: 'BUY',
    status: 'Canceled',
    quantity: '10',
    executedQuantity: '10',
    submittedPrice: '12',
    executedPrice: '12',
    submittedAtMs: nowMs - 10_000,
    updatedAtMs: nowMs - 1_000,
  };
}

async function expectPromiseToRejectWithMessage(
  promise: Promise<unknown>,
  messagePattern: RegExp | string,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }

    if (typeof messagePattern === 'string') expect(error.message).toBe(messagePattern);
    else expect(error.message).toMatch(messagePattern);

    return;
  }

  throw new Error(
    `Expected promise to reject with message matching ${typeof messagePattern === 'string' ? messagePattern : messagePattern.source}`,
  );
}

function createProtectiveMonitor(): LoadTradingDayRuntimeSnapshotDeps['tradingConfig']['monitor'] {
  return createMonitorConfigDouble({
    monitorSymbol: 'HSI.HK',
    orderOwnershipMapping: ['HSI'],
  });
}

function createAutoSearchMonitor(): LoadTradingDayRuntimeSnapshotDeps['tradingConfig']['monitor'] {
  return createMonitorConfigDouble({
    monitorSymbol: 'HSI.HK',
    autoSearchConfig: {
      autoSearchEnabled: true,
      autoSearchMinDistancePctBull: '0.35',
      autoSearchMinDistancePctBear: '-0.35',
      autoSearchMinTurnoverPerMinuteBull: '100000',
      autoSearchMinTurnoverPerMinuteBear: '100000',
      autoSearchExpiryMinMonths: 3,
      autoSearchOpenDelayMinutes: 5,
      switchIntervalMinutes: 0,
      switchDistanceRangeBull: { min: '0.2', max: '1.5' },
      switchDistanceRangeBear: { min: '-1.5', max: '-0.2' },
    },
  });
}

/** 中性列表项不再携带牛熊类型；harness 保留创建时类型以模拟 adapter 按 request.types 过滤。 */
const warrantTypesByItem = new WeakMap<object, 'BULL' | 'BEAR'>();

function createWarrantInfo(params: {
  readonly symbol: string;
  readonly warrantType: 'Bull' | 'Bear';
  readonly apiDistanceRatio: string;
  readonly turnover: string;
  readonly callPrice: string;
}): Awaited<ReturnType<MarketQuoteContext['warrantList']>>[number] {
  const item = {
    symbol: params.symbol,
    toCallPrice: params.apiDistanceRatio,
    turnover: params.turnover,
    callPrice: params.callPrice,
    status: 'NORMAL' as const,
  };
  warrantTypesByItem.set(item, params.warrantType === 'Bull' ? 'BULL' : 'BEAR');
  return item;
}

function createWarrantQuoteContextHarness() {
  const lists = new Map<string, Awaited<ReturnType<MarketQuoteContext['warrantList']>>>();
  const calls: Parameters<MarketQuoteContext['warrantList']>[0][] = [];
  const port: MarketQuoteContext = createQuoteContextDouble({
    warrantList: async (request) => {
      calls.push(request);
      return (lists.get(request.symbol) ?? []).filter((item) => {
        const warrantType = warrantTypesByItem.get(item);
        return warrantType !== undefined && request.types.includes(warrantType);
      });
    },
  });
  return {
    port,
    seedWarrantList: (
      symbol: string,
      items: Awaited<ReturnType<MarketQuoteContext['warrantList']>>,
    ) => {
      lists.set(symbol, items);
    },
    getCalls: (_method: 'warrantList') => calls,
  };
}

/** 原生 query mapper 生成 phase/累计事实；空流水保留未知 T，由 recovery 匹配真实持久化证据。 */
async function createProtectiveOrder(
  params: Pick<
    OrderFact,
    | 'orderId'
    | 'executionStatus'
    | 'price'
    | 'quantity'
    | 'executedPrice'
    | 'executedQuantity'
    | 'executedAmount'
    | 'updatedAtMs'
  > &
    Readonly<{ status: 'New' | 'Filled' | 'PartialFilled' | 'Canceled'; side?: 'BUY' | 'SELL' }>,
): Promise<OrderFact> {
  if (params.price === null || params.executedPrice === null)
    throw new Error('Scene must supply exact native price texts');

  const ingress = await createBrokerIngressFixture({
    orderId: params.orderId,
    symbol: 'BULL.HK',
    stockName: 'HSI RC',
    remark: params.side === 'BUY' ? 'AUTO' : 'AUTO|PL',
    side: params.side ?? 'SELL',
    status: params.status,
    submittedPrice: params.price,
    quantity: String(params.quantity),
    executedPrice: params.executedPrice,
    executedQuantity: String(params.executedQuantity),
    submittedAtMs: Date.parse('2026-03-13T02:00:00.000Z'),
    updatedAtMs: params.updatedAtMs,
  });
  const expectedExecutionTimeMs = params.executedQuantity > 0 ? params.updatedAtMs : null;
  expect(ingress.queryObservation.executionTimeMs).toBe(expectedExecutionTimeMs);
  expect(ingress.queryObservation.updatedAtMs).toBe(params.updatedAtMs);
  expect(ingress.queryObservation.executedAmount).toBe(params.executedAmount);
  expect(ingress.queryObservation.executionStatus).toBe(params.executionStatus);
  return ingress.queryObservation;
}

function createBoundaryCaptureDailyLossTracker(
  onCapture: (
    protectionBoundaryByDirection: NonNullable<
      Parameters<
        LoadTradingDayRuntimeSnapshotDeps['dailyLossTracker']['prepareRecalculationFromAllOrders']
      >[3]
    >,
  ) => void,
): LoadTradingDayRuntimeSnapshotDeps['dailyLossTracker'] {
  const tracker = createDailyLossTracker({
    onOwnershipWarning: () => {},
    ...orderAnalysis,
    resolveOrderOwnership: (order) => {
      if (order.symbol === 'BULL.HK') return { monitorSymbol: 'HSI.HK', direction: 'LONG' };

      if (order.symbol === 'BEAR.HK') return { monitorSymbol: 'HSI.HK', direction: 'SHORT' };

      return null;
    },
    toHongKongTimeIso,
  });
  return {
    ...tracker,
    prepareRecalculationFromAllOrders: (
      allOrders,
      monitor,
      now,
      protectionBoundaryByDirection,
      relatedTradingSymbols,
      recovery,
    ) => {
      const prepared = tracker.prepareRecalculationFromAllOrders(
        allOrders,
        monitor,
        now,
        protectionBoundaryByDirection,
        relatedTradingSymbols,
        recovery,
      );

      if (protectionBoundaryByDirection !== undefined) onCapture(protectionBoundaryByDirection);

      return prepared;
    },
    restoreProtectionBoundary: (prepared) => {
      tracker.restoreProtectionBoundary(prepared);
      onCapture(new Map([[prepared.direction, prepared.boundaryExecutedTimeMs]]));
    },
    commitProtectionBoundary: (prepared) => {
      tracker.commitProtectionBoundary(prepared);
      onCapture(new Map([[prepared.direction, prepared.boundaryExecutedTimeMs]]));
    },
  };
}

function createCompletionRecord(params: {
  readonly direction: 'LONG' | 'SHORT';
  readonly boundaryExecutedTimeMs: number;
  readonly monitorSymbol?: string;
  readonly orderBaselines?: ReadonlyArray<{
    readonly orderId: string;
    readonly symbol: string;
    readonly side: 'BUY' | 'SELL';
    readonly cumulativeQuantity: string;
    readonly cumulativeAmount: string;
    readonly lastExecutionTimeMs: number;
    readonly orderRevisionMs: number;
  }>;
}) {
  const monitorSymbol = params.monitorSymbol ?? 'HSI.HK';
  return {
    recordType: 'PROTECTIVE_LIQUIDATION_COMPLETION' as const,
    schemaVersion: 1 as const,
    completionId:
      `v1:2026-03-13:${monitorSymbol}:${params.direction}:` + String(params.boundaryExecutedTimeMs),
    tradingDayKey: '2026-03-13',
    monitorSymbol,
    direction: params.direction,
    boundaryExecutedTimeMs: params.boundaryExecutedTimeMs,
    orderBaselines: params.orderBaselines ?? [],
  };
}

function createExecutionProgressRecord(params: {
  readonly orderId: string;
  readonly direction: 'LONG' | 'SHORT';
  readonly symbol?: string;
  readonly cumulativeQuantity: string;
  readonly cumulativeAmount: string;
  readonly lastExecutionTimeMs: number;
  readonly orderRevisionMs: number;
  readonly factStage?: 'OPEN' | 'TERMINAL';
}) {
  const symbol = params.symbol ?? 'BULL.HK';
  const factStage = params.factStage ?? 'OPEN';
  return {
    recordType: 'PROTECTIVE_LIQUIDATION_EXECUTION_PROGRESS' as const,
    schemaVersion: 1 as const,
    progressId:
      `v1:2026-03-13:HSI.HK:${params.direction}:${symbol}:${params.orderId}:` +
      `${String(params.orderRevisionMs)}:${params.cumulativeQuantity}:${factStage}`,
    tradingDayKey: '2026-03-13',
    monitorSymbol: 'HSI.HK',
    direction: params.direction,
    symbol,
    orderId: params.orderId,
    factStage,
    cumulativeQuantity: params.cumulativeQuantity,
    cumulativeAmount: params.cumulativeAmount,
    lastExecutionTimeMs: params.lastExecutionTimeMs,
    orderRevisionMs: params.orderRevisionMs,
  };
}

function createProtectiveTrackerRecorder(): {
  readonly tracker: ProtectiveLiquidationEpisodeTracker;
  readonly restoreCompletedCalls: Array<
    Parameters<ProtectiveLiquidationEpisodeTracker['restoreCompletedBoundary']>[0]
  >;
  readonly restoreInProgressCalls: Array<
    Parameters<ProtectiveLiquidationEpisodeTracker['restoreInProgressEpisode']>[0]
  >;
} {
  const restoreCompletedCalls: Array<
    Parameters<ProtectiveLiquidationEpisodeTracker['restoreCompletedBoundary']>[0]
  > = [];
  const restoreInProgressCalls: Array<
    Parameters<ProtectiveLiquidationEpisodeTracker['restoreInProgressEpisode']>[0]
  > = [];

  return {
    tracker: createProtectiveLiquidationEpisodeTrackerDouble({
      restoreCompletedBoundary: (params) => {
        restoreCompletedCalls.push(params);
      },
      restoreInProgressEpisode: (params) => {
        restoreInProgressCalls.push(params);
      },
      resetAll: () => {},
    }),
    restoreCompletedCalls,
    restoreInProgressCalls,
  };
}

/** 记录恢复链路的关键副作用，用于验证 damaged persisted facts 在消费前被拒绝。 */
function createRecoverySideEffectRecorder(): {
  readonly tracker: ProtectiveLiquidationEpisodeTracker;
  readonly dailyLossTracker: LoadTradingDayRuntimeSnapshotDeps['dailyLossTracker'];
  readonly effects: {
    restoreCompletedBoundary: number;
    restoreInProgressEpisode: number;
    restoreExecutionSnapshot: number;
    restoreProtectionBoundary: number;
    prepareProtectionBoundary: number;
    commitProtectionBoundary: number;
    commitCompletion: number;
    hydrate: number;
  };
} {
  const episodeTracker = createProtectiveLiquidationEpisodeTracker();
  const effects = {
    restoreCompletedBoundary: 0,
    restoreInProgressEpisode: 0,
    restoreExecutionSnapshot: 0,
    restoreProtectionBoundary: 0,
    prepareProtectionBoundary: 0,
    commitProtectionBoundary: 0,
    commitCompletion: 0,
    hydrate: 0,
  };
  const tracker: ProtectiveLiquidationEpisodeTracker = {
    ...episodeTracker,
    restoreCompletedBoundary: (params) => {
      effects.restoreCompletedBoundary += 1;
      episodeTracker.restoreCompletedBoundary(params);
    },
    restoreInProgressEpisode: (params) => {
      effects.restoreInProgressEpisode += 1;
      episodeTracker.restoreInProgressEpisode(params);
    },
    commitCompletion: (params) => {
      effects.commitCompletion += 1;
      episodeTracker.commitCompletion(params);
    },
  };

  return {
    tracker,
    dailyLossTracker: createDailyLossTrackerDouble({
      restoreExecutionSnapshot: () => {
        effects.restoreExecutionSnapshot += 1;
      },
      restoreProtectionBoundary: () => {
        effects.restoreProtectionBoundary += 1;
      },
      prepareProtectionBoundary: (params) => {
        effects.prepareProtectionBoundary += 1;
        return { ...params, orderBaselines: [] };
      },
      commitProtectionBoundary: () => {
        effects.commitProtectionBoundary += 1;
      },
    }),
    effects,
  };
}

function drainMonitorTasks(
  monitorTaskQueue: ReturnType<typeof createMonitorTaskQueue<MonitorTaskDataMap>>,
): Array<ReturnType<typeof monitorTaskQueue.pop>> {
  const tasks: Array<ReturnType<typeof monitorTaskQueue.pop>> = [];
  while (!monitorTaskQueue.isEmpty()) {
    tasks.push(monitorTaskQueue.pop());
  }

  return tasks;
}

/** 使用真实行情 adapter、canonical snapshot、loader 与原启动寻标组装状态准入场景。 */
async function createTradingStatusRecoveryHarness(tradingStatus: 'NORMAL' | 'SUSPEND' | null) {
  const now = new Date('2026-02-16T01:31:00.000Z');
  const monitor = createMonitorConfigDouble({
    ...createAutoSearchMonitor(), orderOwnershipMapping: ['HSI'],
  });
  const market = await createMarketFixture();
  market.controller.seedQuotes(['HSI.HK', 'BULL.HK', 'BEAR.HK'].map((symbol) => ({
    symbol, name: symbol, price: '1', previousClose: '1', timestampMs: now.getTime(),
    lotSize: 100, tradingStatus: symbol === 'BULL.HK' ? tradingStatus : 'NORMAL',
  })));
  const orders = await Promise.all((['LONG', 'SHORT'] as const).map(async (direction) => {
    const ingress = await createBrokerIngressFixture({
      ...createStartupSnapshotOrderInput(now.getTime()),
      orderId: `STATUS-${direction}`,
      symbol: direction === 'LONG' ? 'BULL.HK' : 'BEAR.HK',
      stockName: direction === 'LONG' ? 'HSI RC' : 'HSI RP',
      status: 'Filled',
    });
    return ingress.queryObservation;
  }));
  const positions = ['BULL.HK', 'BEAR.HK'].map((symbol) => ({
    accountChannel: 'lb', symbol, symbolName: symbol,
    quantity: 10, availableQuantity: 0, currency: 'HKD', costPrice: '12',
  }));
  const trader = createReadyTrader({
    accountService: { getStockPositions: async () => positions },
    orderRecorder: { fetchAllOrdersFromAPI: async () => orders },
  });
  const warnings: unknown[][] = [];
  const deps = createBaseDeps({
    tradingConfig: createTradingConfig(monitor),
    marketDataClient: {
      ...market.client,
      getQuotes: (symbols) => market.client.getQuotes([...symbols]),
      isTradingDay: async () => ({ isTradingDay: true, isHalfDay: false }),
    },
    accountService: trader.accountService,
    orderRecorder: trader.orderRecorder,
    orderMonitor: trader.orderMonitor,
    orderHoldRegistry: trader.orderHoldRegistry,
    logger: { ...createLoggerDouble(), warn: (...args) => { warnings.push(args); } },
  });
  const publications: string[] = [];
  const updateSeatState = deps.symbolRegistry.updateSeatState;
  spyOn(deps.symbolRegistry, 'updateSeatState').mockImplementation((direction, state) => {
    publications.push(direction);
    updateSeatState(direction, state);
  });
  const quoteSubscriptionRuntime = createQuoteSubscriptionRuntime({
    snapshot: deps.snapshot, termination: deps.termination,
    symbolRegistry: deps.symbolRegistry, tradingConfig: deps.tradingConfig,
    orderHoldRegistry: trader.orderHoldRegistry, quoteSubscriptionState: deps.quoteSubscriptionState,
    logger: deps.logger, marketDataClient: deps.marketDataClient,
  });
  const load = createLoadTradingDayRuntimeSnapshot(deps);
  const rebuiltOrders: ReadonlyArray<OrderFact>[] = [];
  const openParams: RunTradingDayOpenRebuildParams = {
    now, termination: deps.termination, snapshot: deps.snapshot,
    loadTradingDayRuntimeSnapshot: load,
    rebuildTradingDayState: async ({ snapshotToken, allOrders }) => {
      rebuiltOrders.push(allOrders);
      return { status: 'COMMITTED', snapshotToken };
    },
    postTradeConsistencyRuntime: deps.postTradeConsistencyRuntime,
    quoteSubscriptionRuntime,
  };
  const startup = () => loadStartupSnapshot({
    now, lifecycleState: deps.lifecycleState, termination: deps.termination,
    snapshot: deps.snapshot, loadTradingDayRuntimeSnapshot: load,
    applyStartupSnapshotFailureState, logger: deps.logger, formatError: String,
  });
  const dispose = async () => {
    await deps.postTradeConsistencyRuntime.stopAndDrain();
    await quoteSubscriptionRuntime.stopAndDrain();
  };
  return { now, market, deps, load, openParams, startup, dispose, positions, orders, publications, warnings, rebuiltOrders };
}

describe('真实 loader 的历史席位交易状态准入', () => {
  it.each(['STARTUP', 'OPEN_REBUILD'] as const)('%s owner 真实接线拒绝终止交易，保留订单/持仓与残仓订阅', async (source) => {
    const harness = await createTradingStatusRecoveryHarness('SUSPEND');
    try {
      const result = source === 'STARTUP'
        ? await harness.startup()
        : await executeTradingDayOpenRebuild(harness.openParams);
      expect(source === 'STARTUP' ? 'kind' in result && result.kind : 'status' in result && result.status)
        .toBe(source === 'STARTUP' ? 'READY' : 'COMMITTED');
      expect(harness.market.controller.readSymbolCalls('quote')[0]).toEqual(['BULL.HK', 'BEAR.HK']);
      expect(harness.deps.symbolRegistry.getSeatState('LONG')).toMatchObject({ symbol: null, status: 'EMPTY', searchFailCountToday: 0 });
      expect(harness.deps.symbolRegistry.getSeatState('SHORT')).toMatchObject({ symbol: 'BEAR.HK', status: 'ACTIVATING' });
      expect(harness.market.controller.readSymbolCalls('warrantList')).toEqual([]);
      expect(harness.deps.snapshot.getView().positions).toEqual(harness.positions);
      if ('allOrders' in result) expect(result.allOrders).toEqual(harness.orders);
      else expect(harness.rebuiltOrders[0]).toEqual(harness.orders);

      expect(harness.market.controller.readSymbolCalls('subscribe').flat()).toContain('BULL.HK');
      expect(harness.warnings[0]?.[0]).toContain('SUSPEND');
    } finally { await harness.dispose(); }
  });

  it.each(['NORMAL', 'SUSPEND', null] as const)('新 await 期间 receipt 被成对刷新替代，状态 %p 不获得新 token 授权', async (status) => {
    const harness = await createTradingStatusRecoveryHarness(status);
    const gate = harness.market.controller.pauseFirstSecurityTradingStatusRead();
    try {
      const running = harness.load(createLoadParams({ now: harness.now }));
      await gate.entered;
      expect(harness.publications).toEqual([]);
      const captured = harness.deps.snapshot.getView().token;
      const refresh = await harness.deps.snapshot.requestRefresh({
        source: 'TEST_REFRESH', dayEpoch: captured.dayEpoch, refreshAccount: true, refreshPositions: true,
      }).result;
      expect(refresh.status).toBe('COMMITTED');
      expect(harness.deps.snapshot.isCurrent(captured, { account: true, positions: true, paired: true })).toBe(false);
      gate.release();
      if (status === null) await rejects(running, TypeError);
      else expect(await running).toEqual({ status: 'SUPERSEDED' });

      expect(harness.publications).toEqual([]);
      expect(harness.market.controller.readSymbolCalls('warrantList')).toEqual([]);
      expect(harness.warnings).toEqual([]);
      expect(harness.market.controller.readSymbolCalls('subscribe')).toEqual([]);
    } finally { gate.release(); await harness.dispose(); }
  });

  it('状态等待期间 epoch 失效保持 ABORTED，不发布旧候选', async () => {
    const harness = await createTradingStatusRecoveryHarness('NORMAL');
    const gate = harness.market.controller.pauseFirstSecurityTradingStatusRead();
    try {
      const running = harness.load(createLoadParams({ now: harness.now }));
      await gate.entered;
      await harness.deps.snapshot.requestClear({ reason: 'DAY_CUT', dayEpoch: 1 });
      gate.release();
      expect(await running).toEqual({ status: 'ABORTED' });
      expect(harness.publications).toEqual([]);
    } finally { gate.release(); await harness.dispose(); }
  });

  it('STARTUP 状态请求外部失败关门待重建；成功响应损坏仍为 fatal 而非 API pending', async () => {
    const externalHarness = await createTradingStatusRecoveryHarness('NORMAL');
    const external = await createExternalApiRequestError({
      operation: 'QuoteContext.quote', attempts: 1, cause: new Error('network unavailable'),
    });
    spyOn(externalHarness.deps.marketDataClient, 'getSecurityTradingStatuses').mockRejectedValue(external);
    try {
      expect(await externalHarness.startup()).toEqual({ kind: 'API_RETRY_PENDING' });
      expect(externalHarness.deps.lifecycleState).toMatchObject({
        isTradingEnabled: false, pendingOpenRebuild: true, lifecycleState: 'OPEN_REBUILD_FAILED',
      });
      expect(externalHarness.publications).toEqual([]);
    } finally { await externalHarness.dispose(); }

    const broken = await createTradingStatusRecoveryHarness(null);
    try {
      await rejects(broken.startup(), TypeError);
      expect(broken.deps.lifecycleState.pendingOpenRebuild).toBe(false);
      expect(broken.publications).toEqual([]);
    } finally { await broken.dispose(); }
  });

  it.each(['外部请求', '内部契约'] as const)('OPEN_REBUILD 真实 loader 的%s失败由原生命周期分类，内部错误不降级', async (failure) => {
    const harness = await createTradingStatusRecoveryHarness(failure === '内部契约' ? null : 'NORMAL');
    let statusRequests = 0;
    if (failure === '外部请求') {
      const external = await createExternalApiRequestError({
        operation: 'QuoteContext.quote', attempts: 1, cause: new Error('network unavailable'),
      });
      spyOn(harness.deps.marketDataClient, 'getSecurityTradingStatuses').mockImplementation(async () => {
        statusRequests += 1;
        throw external;
      });
    }

    const state = harness.deps.lifecycleState;
    state.currentDayKey = '2026-02-16';
    state.pendingOpenRebuild = true;
    state.lifecycleState = 'MIDNIGHT_CLEANED';
    state.isTradingEnabled = false;
    const manager = createDayLifecycleManager({
      diagnostics: createDiagnosticObserverDouble(), termination: harness.deps.termination,
      mutableState: state, snapshot: harness.deps.snapshot, logger: harness.deps.logger,
      rebuildRetryDelayMs: 1000,
      cacheDomains: [{ midnightClear: () => {}, openRebuild: ({ now }) => executeTradingDayOpenRebuild({ ...harness.openParams, now }) }],
    });
    const runtime = { dayKey: '2026-02-16', canTradeNow: true, isTradingDay: true };
    try {
      if (failure === '外部请求') {
        const first = await manager.tick(harness.now, runtime);
        expect(state).toMatchObject({ lifecycleState: 'OPEN_REBUILD_FAILED', isTradingEnabled: false, pendingOpenRebuild: true });
        expect(first.nextRetryAtMs).toBe(harness.now.getTime() + 1000);
        await manager.tick(new Date(harness.now.getTime() + 2000), runtime);
        expect(statusRequests).toBe(2);
      } else {
        await rejects(manager.tick(harness.now, runtime), TypeError);
        expect(state.lifecycleState).not.toBe('OPEN_REBUILD_FAILED');
        expect(state.isTradingEnabled).toBe(false);
      }

      expect(harness.publications).toEqual([]);
    } finally { await harness.dispose(); }
  });
});

describe('createLoadTradingDayRuntimeSnapshot', () => {
  for (const missing of ['EXECUTED_PRICE', 'REVISION'] as const) {
    it(`真实 adapter→recorder→启动 loader：正成交终态 history 缺 ${missing} 被完整 today 覆盖，日损与加载完成`, async () => {
      const now = new Date('2026-03-13T03:00:00.000Z');
      const history = createStartupSnapshotOrderInput(now.getTime());
      const today = {
        ...history,
        status: 'Filled' as const,
        quantity: '5',
        executedQuantity: '5',
        submittedPrice: '10',
        executedPrice: '10',
        updatedAtMs: now.getTime() - 3_000,
      };
      const sell = {
        ...today,
        orderId: 'STARTUP-SNAPSHOT-SELL',
        side: 'SELL' as const,
        executedPrice: '9',
        updatedAtMs: now.getTime() - 2_000,
      };
      const native = await createBrokerIngressFixture(history);
      native.setOrderSnapshotReplies([history], [today, sell]);
      if (missing === 'EXECUTED_PRICE') native.setOrderSnapshotExecutedPriceMissing('history');
      else native.setOrderSnapshotUpdatedAtAbsent('history', 'OMITTED');

      const recorder = native.createRecorder({
        logger: createLoggerDouble(),
        rateLimiter: { throttle: async () => {} },
        settlementRefreshNeedRecorder: { recordSettlementRefreshNeed: () => {} },
      });
      const reads = spyOn(recorder, 'fetchAllOrdersFromAPI');
      const ready = createReadyTrader();
      const deps = createBaseDeps({
        accountService: ready.accountService,
        orderRecorder: recorder,
      });
      const hydrate = spyOn(deps.tradeLogHydrator, 'hydrate');
      const publish = spyOn(deps.dailyLossTracker, 'publishRecalculation');
      const result = await createLoadTradingDayRuntimeSnapshot(deps)(
        createLoadParams({ now, hydrateCooldownFromTradeLog: true }),
      );
      expect(result.status).toBe('COMMITTED');
      if (result.status !== 'COMMITTED') throw new Error('启动订单快照未完成');

      expect(reads).toHaveBeenCalledTimes(1);
      expect(native.orderSnapshotReadCounts()).toEqual({ history: 1, today: 1 });
      expect(result.allOrders).toHaveLength(2);
      expect(result.allOrders.find((order) => order.orderId === history.orderId)).toMatchObject({
        status: 'FILLED',
        executionPhase: 'TERMINAL',
        quantity: 5,
        price: '10',
        executedQuantity: 5,
        executedPrice: '10',
        executedAmount: '50',
        executionTimeMs: today.updatedAtMs,
        updatedAtMs: today.updatedAtMs,
      });
      expect(deps.dailyLossTracker.getLossOffset('LONG')).toBe('-5');
      expect(publish).toHaveBeenCalledTimes(1);
      expect(hydrate).toHaveBeenCalledTimes(1);
      expect(deps.quoteSubscriptionState.allTradingSymbols.has('BULL.HK')).toBeTrue();
      expect(native.nativeMutations()).toEqual([]);
    });
  }

  for (const invalid of ['EXECUTED_PRICE', 'REVISION', 'UNKNOWN_TYPE'] as const) {
    it(`真实 adapter→recorder→启动 loader：获选 today ${invalid} 在本次订单/Daily 与 hydrate 发布前拒绝`, async () => {
      const now = new Date('2026-03-13T03:00:00.000Z');
      const input = createStartupSnapshotOrderInput(now.getTime());
      const native = await createBrokerIngressFixture(input);
      native.setOrderSnapshotReplies([input], [input]);
      if (invalid === 'EXECUTED_PRICE') native.setOrderSnapshotExecutedPriceMissing('today');
      else if (invalid === 'REVISION') native.setOrderSnapshotUpdatedAtAbsent('today', 'NULL');
      else native.setOrderSnapshotOrderTypeUnknown('today');

      const recorder = native.createRecorder({
        logger: createLoggerDouble(),
        rateLimiter: { throttle: async () => {} },
        settlementRefreshNeedRecorder: { recordSettlementRefreshNeed: () => {} },
      });
      const ready = createReadyTrader();
      const accountReads = spyOn(ready.accountService, 'getAccountSnapshot');
      const deps = createBaseDeps({
        accountService: ready.accountService,
        orderRecorder: recorder,
      });
      const commit = spyOn(recorder, 'commitRebuildSnapshot');
      const prepare = spyOn(deps.dailyLossTracker, 'prepareRecalculationFromAllOrders');
      const publish = spyOn(deps.dailyLossTracker, 'publishRecalculation');
      const holds = spyOn(deps.orderHoldRegistry, 'seedFromOrders');
      const dispatch = spyOn(deps.seatActivationDispatcher, 'dispatchCurrentActivatingSeats');
      const hydrate = spyOn(deps.tradeLogHydrator, 'hydrate');
      const failure: unknown = await createLoadTradingDayRuntimeSnapshot(deps)(
        createLoadParams({ now, hydrateCooldownFromTradeLog: true }),
      ).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(TypeError);
      expect(native.orderSnapshotReadCounts()).toEqual({ history: 1, today: 1 });
      // loader 的账户 refresh 本来就先于订单读取；这里只禁止本次业务订单/Daily 发布。
      expect(accountReads).toHaveBeenCalledTimes(1);
      expect(commit).not.toHaveBeenCalled();
      expect(recorder.getExecutionFact(input.orderId)).toBeNull();
      expect(prepare).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
      expect(holds).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();
      expect(hydrate).not.toHaveBeenCalled();
      expect(native.nativeMutations()).toEqual([]);
    });
  }

  it('publishes symbols on the same subscription-state object before awaiting native subscription', async () => {
    const subscribed = Promise.withResolvers<ReadonlyArray<string>>();
    const release = Promise.withResolvers<undefined>();
    const deps = createBaseDeps({
      marketDataClient: createMarketDataClientDouble({
        subscribeSymbols: async (symbols) => {
          subscribed.resolve([...symbols]);
          await release.promise;
        },
      }),
    });
    const state = deps.quoteSubscriptionState;
    let finished = false;
    const loading = createLoadTradingDayRuntimeSnapshot(deps)(createLoadParams()).then((result) => {
      finished = true;
      return result;
    });
    const symbols = await subscribed.promise;
    expect(finished).toBeFalse();
    expect(deps.quoteSubscriptionState).toBe(state);
    expect([...state.allTradingSymbols]).toEqual([...symbols]);
    expect(state.allTradingSymbols.size).toBeGreaterThan(0);
    release.resolve();
    const result = await loading;
    expect(result.status).toBe('COMMITTED');
    expect(deps.quoteSubscriptionState).toBe(state);
  });

  it('requireTradingDay 为 true 且 isTradingDay 为 false 时抛出"重建触发时交易日信息无效"', async () => {
    const deps = createBaseDeps({
      marketDataClient: createMarketDataClientDouble({
        isTradingDay: async () => ({ isTradingDay: false, isHalfDay: false }),
      }),
    });

    const load = createLoadTradingDayRuntimeSnapshot(deps);

    expect(load(createLoadParams({ requireTradingDay: true }))).rejects.toThrow(
      '重建触发时交易日信息无效',
    );
  });

  it('账户快照契约失败时 fail-fast，不能按空账户继续重建', async () => {
    const reportFatalErrors: unknown[] = [];
    const tradeInstances15 = createTradeRuntimeDouble({
      accountService: {
        getAccountSnapshot: async () => {
          throw new TypeError('TradeContext.accountBalance returned no primary account');
        },
        getStockPositions: async () => [],
      },
    });
    const deps = createBaseDeps({
      reportFatalError: (error) => {
        reportFatalErrors.push(error);
      },
      accountService: tradeInstances15.accountService,
      orderRecorder: tradeInstances15.orderRecorder,
      orderHoldRegistry: tradeInstances15.orderHoldRegistry,
      orderMonitor: tradeInstances15.orderMonitor,
    });

    const load = createLoadTradingDayRuntimeSnapshot(deps);

    let caught: unknown = null;
    try {
      await load(createLoadParams());
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TypeError);
    expect((caught as Error).message).toBe(
      'TradeContext.accountBalance returned no primary account',
    );
    expect(reportFatalErrors).toEqual([caught]);
  });

  it('持仓快照拉取失败时 fail-fast，不能按空持仓继续重建', async () => {
    let fetchAllOrdersCalled = false;
    const tradeInstances16 = createReadyTrader({
      accountService: {
        getStockPositions: async () => {
          throw new Error('positions unavailable');
        },
      },
      orderRecorder: {
        fetchAllOrdersFromAPI: async () => {
          fetchAllOrdersCalled = true;
          return [];
        },
      },
    });
    const deps = createBaseDeps({
      accountService: tradeInstances16.accountService,
      orderRecorder: tradeInstances16.orderRecorder,
      orderHoldRegistry: tradeInstances16.orderHoldRegistry,
      orderMonitor: tradeInstances16.orderMonitor,
    });

    const load = createLoadTradingDayRuntimeSnapshot(deps);

    let caughtError: unknown = null;
    try {
      await load(createLoadParams());
    } catch (error) {
      caughtError = error;
    }

    // 保留原始错误身份，不再包装成“无法刷新账户和持仓信息”。
    expect(caughtError).toBeInstanceOf(Error);
    expect((caughtError as Error).message).toBe('positions unavailable');
    expect(fetchAllOrdersCalled).toBe(false);
  });

  it('订单拉取失败时直接抛出原始错误，不按空订单继续初始化', async () => {
    const tradeInstances17 = createReadyTrader({
      orderRecorder: {
        fetchAllOrdersFromAPI: async () => {
          throw new Error('API 超时');
        },
      },
    });
    const deps = createBaseDeps({
      accountService: tradeInstances17.accountService,
      orderRecorder: tradeInstances17.orderRecorder,
      orderHoldRegistry: tradeInstances17.orderHoldRegistry,
      orderMonitor: tradeInstances17.orderMonitor,
    });

    const load = createLoadTradingDayRuntimeSnapshot(deps);

    expect(load(createLoadParams())).rejects.toThrow(/API 超时/);
  });

  it('外部先失败且内部后失败时等待两个请求落定，保留内部错误并上报 fatal', async () => {
    const externalError = await createExternalApiRequestError({
      operation: 'TradeContext.accountBalance',
      attempts: 1,
      cause: new Error('temporary'),
    });
    const internalError = new TypeError('positions contract broken');
    const positionsRelease = Promise.withResolvers<undefined>();
    const reportFatalErrors: unknown[] = [];
    let fetchAllOrdersCalled = false;
    const stateFixtures = createMinimalRuntimeStates();

    const tradeInstances18 = createReadyTrader({
      accountService: {
        getAccountSnapshot: async () => {
          throw externalError;
        },
        getStockPositions: async () => {
          await positionsRelease.promise;
          throw internalError;
        },
      },
      orderRecorder: {
        fetchAllOrdersFromAPI: async () => {
          fetchAllOrdersCalled = true;
          return [];
        },
      },
    });
    const deps = createBaseDeps({
      ...stateFixtures,
      reportFatalError: (error) => {
        reportFatalErrors.push(error);
      },
      accountService: tradeInstances18.accountService,
      orderRecorder: tradeInstances18.orderRecorder,
      orderHoldRegistry: tradeInstances18.orderHoldRegistry,
      orderMonitor: tradeInstances18.orderMonitor,
    });
    const load = createLoadTradingDayRuntimeSnapshot(deps);

    let settled = false;
    const outcome = load(createLoadParams()).then(
      () => ({ kind: 'resolved' as const }),
      (error: unknown) => ({ kind: 'rejected' as const, error }),
    );
    void outcome.then(() => {
      settled = true;
    });

    await Bun.sleep(0);
    // 仅外部失败时不得提前上报 fatal，也不得提前结束排空。
    expect(reportFatalErrors).toEqual([]);
    expect(settled).toBe(false);

    positionsRelease.resolve();
    const result = await outcome;
    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') {
      throw new Error('expected loadTradingDayRuntimeSnapshot to reject');
    }

    expect(result.error).toBe(internalError);
    expect(reportFatalErrors).toEqual([internalError]);
    // 无半提交：失败时不得写入账户缓存，也不得继续拉取订单。
    expect(deps.snapshot.getView().account).toBeNull();
    expect(deps.snapshot.getView().positions).toEqual([]);
    expect(deps.snapshot.getView().accountInitialized).toBe(false);
    expect(deps.snapshot.getView().positionsInitialized).toBe(false);
    expect(fetchAllOrdersCalled).toBe(false);
  });

  it('纯外部读取失败时原样透传且不上报 fatal，不进行半提交', async () => {
    const externalError = await createExternalApiRequestError({
      operation: 'TradeContext.stockPositions',
      attempts: 1,
      cause: new Error('positions api down'),
    });
    const reportFatalErrors: unknown[] = [];
    let fetchAllOrdersCalled = false;
    const stateFixtures = createMinimalRuntimeStates();

    const tradeInstances19 = createReadyTrader({
      accountService: {
        getStockPositions: async () => {
          throw externalError;
        },
      },
      orderRecorder: {
        fetchAllOrdersFromAPI: async () => {
          fetchAllOrdersCalled = true;
          return [];
        },
      },
    });
    const deps = createBaseDeps({
      ...stateFixtures,
      reportFatalError: (error) => {
        reportFatalErrors.push(error);
      },
      accountService: tradeInstances19.accountService,
      orderRecorder: tradeInstances19.orderRecorder,
      orderHoldRegistry: tradeInstances19.orderHoldRegistry,
      orderMonitor: tradeInstances19.orderMonitor,
    });
    const load = createLoadTradingDayRuntimeSnapshot(deps);

    let caught: unknown = null;
    try {
      await load(createLoadParams());
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(externalError);
    expect(reportFatalErrors).toEqual([]);
    expect(deps.snapshot.getView().account).toBeNull();
    expect(deps.snapshot.getView().accountInitialized).toBe(false);
    expect(fetchAllOrdersCalled).toBe(false);
  });

  it('only runs startup auto-search after continuous session and morning delay are both satisfied', async () => {
    const monitor = createAutoSearchMonitor();
    const tradingConfig = createTradingConfig(monitor);
    const quoteContext = createWarrantQuoteContextHarness();
    quoteContext.seedWarrantList('HSI.HK', [
      createWarrantInfo({
        symbol: 'AUTO_BULL.HK',
        warrantType: 'Bull',
        apiDistanceRatio: '0.0055',
        turnover: '30000000',
        callPrice: '20500',
      }),
      createWarrantInfo({
        symbol: 'AUTO_BEAR.HK',
        warrantType: 'Bear',
        apiDistanceRatio: '-0.0055',
        turnover: '30000000',
        callPrice: '19500',
      }),
    ]);

    let isTradingDayCalls = 0;
    const marketDataClient = createMarketDataClientDouble({
      getQuoteContext: async () => quoteContext.port,
      isTradingDay: async () => {
        isTradingDayCalls += 1;
        return { isTradingDay: true, isHalfDay: false };
      },
    });
    const blockedLastState = createMinimalRuntimeStates();
    blockedLastState.tradingCalendarState.cachedTradingDayInfo = {
      dateKey: '2026-02-16',
      info: { isTradingDay: true, isHalfDay: false },
    };
    const tradeInstances20 = createReadyTrader();
    const blockedDeps = createBaseDeps({
      ...blockedLastState,
      tradingConfig,
      marketDataClient,
      accountService: tradeInstances20.accountService,
      orderRecorder: tradeInstances20.orderRecorder,
      orderHoldRegistry: tradeInstances20.orderHoldRegistry,
      orderMonitor: tradeInstances20.orderMonitor,
      symbolRegistry: createSymbolRegistry(tradingConfig.monitor),
    });
    const blockedLoad = createLoadTradingDayRuntimeSnapshot(blockedDeps);
    await blockedLoad(
      createLoadParams({
        now: new Date('2026-02-16T01:31:00.000Z'),
        requireTradingDay: false,
      }),
    );

    expect(isTradingDayCalls).toBe(0);
    expect(quoteContext.getCalls('warrantList')).toHaveLength(0);

    const allowedLastState = createMinimalRuntimeStates();
    allowedLastState.tradingCalendarState.cachedTradingDayInfo = {
      dateKey: '2026-02-16',
      info: { isTradingDay: true, isHalfDay: false },
    };
    const tradeInstances21 = createReadyTrader();
    const allowedDeps = createBaseDeps({
      ...allowedLastState,
      tradingConfig,
      marketDataClient,
      accountService: tradeInstances21.accountService,
      orderRecorder: tradeInstances21.orderRecorder,
      orderHoldRegistry: tradeInstances21.orderHoldRegistry,
      orderMonitor: tradeInstances21.orderMonitor,
      symbolRegistry: createSymbolRegistry(tradingConfig.monitor),
    });
    const allowedLoad = createLoadTradingDayRuntimeSnapshot(allowedDeps);
    await allowedLoad(
      createLoadParams({
        now: new Date('2026-02-16T01:35:00.000Z'),
        requireTradingDay: false,
      }),
    );

    expect(isTradingDayCalls).toBe(0);
    expect(quoteContext.getCalls('warrantList')).toHaveLength(2);
    const requestedTypes: ReadonlyArray<BullBearWarrantType> = ['BULL', 'BEAR'];
    expect(quoteContext.getCalls('warrantList')).toEqual(
      requestedTypes.map<MarketWarrantListRequest>((type) => ({
        symbol: 'HSI.HK',
        sortBy: 'TURNOVER',
        sortOrder: 'DESCENDING',
        types: [type],
        issuerIds: null,
        expiryFilters: ['MONTHS_3_TO_6', 'MONTHS_6_TO_12', 'OVER_12_MONTHS'],
        inOutBoundsTypes: ['IN'],
        status: ['NORMAL'],
      })),
    );
    expect(allowedDeps.symbolRegistry.getSeatState('LONG').status).toBe('ACTIVATING');
    expect(allowedDeps.symbolRegistry.getSeatState('SHORT').status).toBe('ACTIVATING');
  });

  it('schedules SEAT_REFRESH for ACTIVATING seats restored during recovery', async () => {
    const monitor = createAutoSearchMonitor();
    const tradingConfig = createTradingConfig(monitor);
    const quoteContext = createWarrantQuoteContextHarness();
    quoteContext.seedWarrantList('HSI.HK', [
      createWarrantInfo({
        symbol: 'AUTO_BULL.HK',
        warrantType: 'Bull',
        apiDistanceRatio: '0.0055',
        turnover: '30000000',
        callPrice: '20500',
      }),
      createWarrantInfo({
        symbol: 'AUTO_BEAR.HK',
        warrantType: 'Bear',
        apiDistanceRatio: '-0.0055',
        turnover: '30000000',
        callPrice: '19500',
      }),
    ]);

    const marketDataClient = createMarketDataClientDouble({
      getQuoteContext: async () => quoteContext.port,
    });
    const stateFixtures = createMinimalRuntimeStates();

    stateFixtures.tradingCalendarState.cachedTradingDayInfo = {
      dateKey: '2026-02-16',
      info: { isTradingDay: true, isHalfDay: false },
    };
    const symbolRegistry = createSymbolRegistry(tradingConfig.monitor);
    const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskDataMap>({
      logger: createLoggerDouble(),
      clock: { now: () => new Date() },
      diagnostics: createDiagnosticObserverDouble(),
    });
    const snapshot = createEmptySnapshotFixture({ readPort: createReadyTrader().accountService });
    const seatActivationDispatcher = createSeatActivationDispatcher({
      logger: createLoggerDouble(),
      snapshot,
      termination: {
        isTerminated: () => false,
        reportFatalError: (error) => {
          throw error;
        },
      },
      symbolRegistry,
      monitorTaskQueue,
    });
    const tradeInstances22 = createReadyTrader();
    const deps = createBaseDeps({
      ...stateFixtures,
      tradingConfig,
      marketDataClient,
      accountService: tradeInstances22.accountService,
      orderRecorder: tradeInstances22.orderRecorder,
      orderHoldRegistry: tradeInstances22.orderHoldRegistry,
      orderMonitor: tradeInstances22.orderMonitor,
      symbolRegistry,
      seatActivationDispatcher,
      snapshot,
    });

    const load = createLoadTradingDayRuntimeSnapshot(deps);
    await load(
      createLoadParams({
        now: new Date('2026-02-16T01:35:00.000Z'),
        requireTradingDay: false,
      }),
    );

    const queueItems = drainMonitorTasks(monitorTaskQueue);
    expect(queueItems).toContainEqual(
      expect.objectContaining({
        type: 'SEAT_REFRESH',
        data: expect.objectContaining({
          direction: 'LONG',
          nextSymbol: 'AUTO_BULL.HK',
        }),
      }),
    );
  });

  it('load 阶段不再承担交易日历预热职责', async () => {
    const now = new Date('2026-02-25T03:00:00.000Z');
    let getTradingDaysCalls = 0;
    const stateFixtures = createMinimalRuntimeStates();

    const initialTradingCalendarSnapshot =
      stateFixtures.tradingCalendarState.tradingCalendarSnapshot;

    const tradeInstances23 = createReadyTrader();
    const deps = createBaseDeps({
      ...stateFixtures,
      marketDataClient: createMarketDataClientDouble({
        getTradingDays: async () => {
          getTradingDaysCalls += 1;
          return {
            tradingDays: [],
            halfTradingDays: [],
          };
        },
      }),
      accountService: tradeInstances23.accountService,
      orderRecorder: tradeInstances23.orderRecorder,
      orderHoldRegistry: tradeInstances23.orderHoldRegistry,
      orderMonitor: tradeInstances23.orderMonitor,
    });

    const load = createLoadTradingDayRuntimeSnapshot(deps);

    await load(
      createLoadParams({
        now,
        requireTradingDay: true,
      }),
    );

    expect(getTradingDaysCalls).toBe(0);
    expect(stateFixtures.tradingCalendarState.tradingCalendarSnapshot).toBe(
      initialTradingCalendarSnapshot,
    );
    expect(stateFixtures.tradingCalendarState.tradingCalendarSnapshot.size).toBe(0);
  });

  it('subscribes candlesticks for the unique monitor and leaves seeded local cache snapshots observable', async () => {
    const monitor = createMonitorConfigDouble({ monitorSymbol: 'HSI.HK' });
    const subscribedSymbols: string[] = [];
    const seededBySymbol = new Set<string>();
    const marketDataClient = createMarketDataClientDouble({
      subscribeCandlesticks: async (symbol) => {
        subscribedSymbols.push(symbol);
        seededBySymbol.add(symbol);
        return [
          {
            open: 100,
            high: 101,
            low: 99,
            close: 100,
            volume: 1000,
            timestamp: new Date('2026-02-25T01:00:00.000Z'),
          },
        ] as never;
      },
      getCandlestickSnapshot: (symbol, period) => {
        if (!seededBySymbol.has(symbol)) {
          return null;
        }

        return {
          symbol,
          period,
          version: 1,
          candles: [
            {
              open: 100,
              high: 101,
              low: 99,
              close: 100,
              volume: 1000,
              timestamp: Date.parse('2026-02-25T01:00:00.000Z'),
            },
          ],
          lastBarTimestamp: Date.parse('2026-02-25T01:00:00.000Z'),
          lastBarConfirmed: null,
          initialized: true,
        };
      },
    });
    const tradeInstances24 = createReadyTrader();
    const deps = createBaseDeps({
      tradingConfig: createTradingConfig(monitor),
      marketDataClient,
      accountService: tradeInstances24.accountService,
      orderRecorder: tradeInstances24.orderRecorder,
      orderHoldRegistry: tradeInstances24.orderHoldRegistry,
      orderMonitor: tradeInstances24.orderMonitor,
    });

    const load = createLoadTradingDayRuntimeSnapshot(deps);
    await load(createLoadParams({ requireTradingDay: true }));

    expect(subscribedSymbols).toEqual(['HSI.HK']);
    expect(
      marketDataClient.getCandlestickSnapshot('HSI.HK', TRADING.CANDLE_PERIOD)?.initialized,
    ).toBe(true);
  });

  it('hydrateCooldownFromTradeLog=true 时先重建并补齐 completion 再 hydrate cooldown', async () => {
    const now = new Date('2026-02-25T03:00:00.000Z');
    const callOrder: string[] = [];
    const allOrders: ReadonlyArray<OrderFact> = [];

    const dailyOwner = createDailyLossTrackerDouble();
    const tradeInstances25 = createReadyTrader({
      orderRecorder: { fetchAllOrdersFromAPI: async () => allOrders },
    });
    const deps = createBaseDeps({
      accountService: tradeInstances25.accountService,
      orderRecorder: tradeInstances25.orderRecorder,
      orderHoldRegistry: tradeInstances25.orderHoldRegistry,
      orderMonitor: tradeInstances25.orderMonitor,
      dailyLossTracker: {
        ...dailyOwner,
        prepareRecalculationFromAllOrders: (
          receivedOrders,
          monitor,
          currentTime,
          receivedSegments,
          relatedSymbols,
          recovery,
        ) => {
          callOrder.push('recalculate');
          expect(receivedOrders).toEqual([]);
          expect(receivedSegments).toBeInstanceOf(Map);
          return dailyOwner.prepareRecalculationFromAllOrders(
            receivedOrders,
            monitor,
            currentTime,
            receivedSegments,
            relatedSymbols,
            recovery,
          );
        },
      },
      tradeLogHydrator: {
        hydrate: () => {
          callOrder.push('hydrate');
        },
      },
    });

    const load = createLoadTradingDayRuntimeSnapshot(deps);
    await load(
      createLoadParams({
        now,
        hydrateCooldownFromTradeLog: true,
      }),
    );

    expect(callOrder).toEqual(['recalculate', 'hydrate']);
  });

  it('fails a normal attributable execution without updatedAt before restoring a persisted completion or later stages', async () => {
    const now = new Date('2026-03-13T03:00:00.000Z');
    const existingBoundaryMs = Date.parse('2026-03-13T02:10:00.000Z');
    const completionBoundaryMs = Date.parse('2026-03-13T02:20:00.000Z');
    const protectiveRevisionMs = Date.parse('2026-03-13T02:30:00.000Z');
    const monitor = createProtectiveMonitor();
    const ordinaryOrder: OrderFact = {
      ...(await createProtectiveOrder({
        orderId: 'ordinary-in-day-missing-updated-at',
        side: 'BUY',
        status: 'Filled',
        executionStatus: 'FILLED',
        price: '10',
        quantity: 10,
        executedPrice: '10',
        executedQuantity: 10,
        updatedAtMs: protectiveRevisionMs,

        executedAmount: '100',
      })),
      remark: 'AUTO',
      updatedAt: null,
      updatedAtMs: Number.NaN,
    };
    const protectiveOrder = await createProtectiveOrder({
      orderId: 'protective-progress-after-daily-loss-preflight',
      status: 'PartialFilled',
      executionStatus: 'PARTIAL',
      price: '9',
      quantity: 10,
      executedPrice: '9',
      executedQuantity: 5,
      updatedAtMs: protectiveRevisionMs,

      executedAmount: '45',
    });
    const actualDailyLossTracker = createDailyLossTracker({
      onOwnershipWarning: () => {},
      ...orderAnalysis,
      resolveOrderOwnership: (order) =>
        order.symbol === 'BULL.HK' ? { monitorSymbol: 'HSI.HK', direction: 'LONG' } : null,
      toHongKongTimeIso,
    });
    actualDailyLossTracker.commitProtectionBoundary(
      actualDailyLossTracker.prepareProtectionBoundary({
        direction: 'LONG',
        boundaryExecutedTimeMs: existingBoundaryMs,
      }),
    );
    const laterEffects = {
      restoreExecutionSnapshot: 0,
      restoreProtectionBoundary: 0,
      hydrate: 0,
      appendCompletion: 0,
      resetSubscriptions: 0,
      subscribeSymbols: 0,
      subscribeCandlesticks: 0,
      getQuotes: 0,
    };
    const dailyLossTracker = {
      ...actualDailyLossTracker,
      restoreExecutionSnapshot: (params) => {
        laterEffects.restoreExecutionSnapshot += 1;
        actualDailyLossTracker.restoreExecutionSnapshot(params);
      },
      restoreProtectionBoundary: (params) => {
        laterEffects.restoreProtectionBoundary += 1;
        actualDailyLossTracker.restoreProtectionBoundary(params);
      },
    } satisfies LoadTradingDayRuntimeSnapshotDeps['dailyLossTracker'];
    const actualEpisodeTracker = createProtectiveLiquidationEpisodeTracker();
    actualEpisodeTracker.restoreCompletedBoundary({
      direction: 'LONG',
      boundaryExecutedTimeMs: existingBoundaryMs,
    });
    let resetAllCalls = 0;
    const tracker: ProtectiveLiquidationEpisodeTracker = {
      ...actualEpisodeTracker,
      resetAll: () => {
        resetAllCalls += 1;
        actualEpisodeTracker.resetAll();
      },
    };
    const marketDataClient = createMarketDataClientDouble({
      resetRuntimeSubscriptionsAndCaches: async () => {
        laterEffects.resetSubscriptions += 1;
      },
      subscribeSymbols: async () => {
        laterEffects.subscribeSymbols += 1;
      },
      subscribeCandlesticks: async () => {
        laterEffects.subscribeCandlesticks += 1;
        return [];
      },
      getQuotes: async () => {
        laterEffects.getQuotes += 1;
        return new Map();
      },
    });
    const tradeInstances26 = createReadyTrader({
      orderRecorder: { fetchAllOrdersFromAPI: async () => [ordinaryOrder, protectiveOrder] },
    });
    const deps = createBaseDeps({
      tradingConfig: createTradingConfig(monitor),
      accountService: tradeInstances26.accountService,
      orderRecorder: tradeInstances26.orderRecorder,
      orderHoldRegistry: tradeInstances26.orderHoldRegistry,
      orderMonitor: tradeInstances26.orderMonitor,
      dailyLossTracker,
      protectiveLiquidationEpisodeTracker: tracker,
      marketDataClient,
      tradeLogHydrator: {
        hydrate: () => {
          laterEffects.hydrate += 1;
        },
      },
      mixedTradeLogRepository: createMixedTradeLogRepositoryDouble({
        loadCompletionRecords: () => [
          createCompletionRecord({
            direction: 'LONG',
            boundaryExecutedTimeMs: completionBoundaryMs,
          }),
        ],
        loadExecutionProgressRecords: () => [
          createExecutionProgressRecord({
            orderId: protectiveOrder.orderId,
            direction: 'LONG',
            cumulativeQuantity: '5',
            cumulativeAmount: '45',
            lastExecutionTimeMs: protectiveRevisionMs - 10_000,
            orderRevisionMs: protectiveRevisionMs,
          }),
        ],
        appendCompletionIdempotent: () => {
          laterEffects.appendCompletion += 1;
        },
      }),
    });

    await expectPromiseToRejectWithMessage(
      createLoadTradingDayRuntimeSnapshot(deps)(
        createLoadParams({
          now,
          hydrateCooldownFromTradeLog: true,
          resetRuntimeSubscriptions: true,
        }),
      ),
      /\[订单事实\] broker identity、数量、phase 或 revision 无效/,
    );

    expect(laterEffects).toEqual({
      restoreExecutionSnapshot: 0,
      restoreProtectionBoundary: 0,
      hydrate: 0,
      appendCompletion: 0,
      resetSubscriptions: 0,
      subscribeSymbols: 0,
      subscribeCandlesticks: 0,
      getQuotes: 0,
    });
    expect(resetAllCalls).toBe(0);
    expect(tracker.getInProgressEpisodes()).toEqual([]);
    expect(() =>
      actualDailyLossTracker.prepareProtectionBoundary({
        direction: 'LONG',
        boundaryExecutedTimeMs: existingBoundaryMs,
      }),
    ).toThrow(/protection boundary .*推进/);
  });

  it('does not infer a completed boundary from a canceled protective order without a completion record', async () => {
    const now = new Date('2026-03-13T03:00:00.000Z');
    const executedAtMs = Date.parse('2026-03-13T02:30:00.000Z');
    const monitor = createProtectiveMonitor();
    const stateFixtures = createMinimalRuntimeStates();

    const { tracker, restoreCompletedCalls, restoreInProgressCalls } =
      createProtectiveTrackerRecorder();
    let receivedBoundaryMap: ReadonlyMap<string, number> | undefined;

    const protectiveOrder = await createProtectiveOrder({
      orderId: 'protective-canceled-1',
      status: 'Canceled',
      executionStatus: 'PARTIAL',
      price: '9',
      quantity: 10,
      executedPrice: '9',
      executedQuantity: 10,
      updatedAtMs: executedAtMs,

      executedAmount: '90',
    });

    const tradeInstances27 = createReadyTrader({
      orderRecorder: { fetchAllOrdersFromAPI: async () => [protectiveOrder] },
    });
    const deps = createBaseDeps({
      ...stateFixtures,
      tradingConfig: createTradingConfig(monitor),
      accountService: tradeInstances27.accountService,
      orderRecorder: tradeInstances27.orderRecorder,
      orderHoldRegistry: tradeInstances27.orderHoldRegistry,
      orderMonitor: tradeInstances27.orderMonitor,
      dailyLossTracker: createBoundaryCaptureDailyLossTracker((protectionBoundaryByDirection) => {
        receivedBoundaryMap = protectionBoundaryByDirection;
      }),
      protectiveLiquidationEpisodeTracker: tracker,
      tradeLogHydrator: {
        hydrate: () => {},
      },
    });

    const load = createLoadTradingDayRuntimeSnapshot(deps);
    const snapshot = await load(createLoadParams({ now }));
    expect(snapshot.status).toBe('COMMITTED');
    expect(restoreCompletedCalls).toHaveLength(0);
    expect(restoreInProgressCalls).toHaveLength(0);
    expect(receivedBoundaryMap?.get('LONG')).toBeUndefined();
  });

  it('restores an in-progress episode from exact progress for a partial-filled pending order', async () => {
    const now = new Date('2026-03-13T03:00:00.000Z');
    const executedAtMs = Date.parse('2026-03-13T02:30:00.000Z');
    const monitor = createProtectiveMonitor();
    const stateFixtures = createMinimalRuntimeStates();

    const { tracker, restoreCompletedCalls, restoreInProgressCalls } =
      createProtectiveTrackerRecorder();
    let receivedBoundaryMap: ReadonlyMap<string, number> | undefined;

    const protectiveOrder = await createProtectiveOrder({
      orderId: 'protective-partial-1',
      status: 'PartialFilled',
      executionStatus: 'PARTIAL',
      price: '9',
      quantity: 10,
      executedPrice: '9',
      executedQuantity: 5,
      updatedAtMs: executedAtMs,

      executedAmount: '45',
    });

    const tradeInstances28 = createReadyTrader({
      orderRecorder: { fetchAllOrdersFromAPI: async () => [protectiveOrder] },
    });
    const deps = createBaseDeps({
      ...stateFixtures,
      tradingConfig: createTradingConfig(monitor),
      accountService: tradeInstances28.accountService,
      orderRecorder: tradeInstances28.orderRecorder,
      orderHoldRegistry: tradeInstances28.orderHoldRegistry,
      orderMonitor: tradeInstances28.orderMonitor,
      dailyLossTracker: createBoundaryCaptureDailyLossTracker((protectionBoundaryByDirection) => {
        receivedBoundaryMap = protectionBoundaryByDirection;
      }),
      protectiveLiquidationEpisodeTracker: tracker,
      tradeLogHydrator: {
        hydrate: () => {},
      },
      mixedTradeLogRepository: createMixedTradeLogRepositoryDouble({
        loadExecutionProgressRecords: () => [
          createExecutionProgressRecord({
            orderId: 'protective-partial-1',
            direction: 'LONG',
            cumulativeQuantity: '5',
            cumulativeAmount: '45',
            lastExecutionTimeMs: executedAtMs - 10_000,
            orderRevisionMs: executedAtMs,
          }),
        ],
      }),
    });

    const load = createLoadTradingDayRuntimeSnapshot(deps);
    await load(
      createLoadParams({
        now,
        hydrateCooldownFromTradeLog: true,
      }),
    );

    expect(restoreCompletedCalls).toHaveLength(0);
    expect(restoreInProgressCalls).toEqual([
      {
        direction: 'LONG',
        symbol: 'BULL.HK',
        latestExecutedTimeMs: executedAtMs - 10_000,
      },
    ]);
    expect(receivedBoundaryMap?.size).toBe(0);
  });

  it('recovers online 100→90 same-quantity amount revision without rejecting older progress', async () => {
    const now = new Date('2026-03-13T03:00:00.000Z');
    const firstRevisionMs = Date.parse('2026-03-13T02:30:00.000Z');
    const secondRevisionMs = firstRevisionMs + 1_000;
    const executionTimeMs = firstRevisionMs;
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-amount-revision-recovery-'));
    const monitor = createProtectiveMonitor();
    const buy = await createProtectiveOrder({
      orderId: 'amount-revision-buy',
      side: 'BUY',
      status: 'Filled',
      executionStatus: 'FILLED',
      price: '10',
      quantity: 10,
      executedPrice: '10',
      executedQuantity: 10,
      updatedAtMs: firstRevisionMs,
      executedAmount: '100',
    });
    const sell = await createProtectiveOrder({
      orderId: 'amount-revision-sell',
      status: 'Filled',
      executionStatus: 'FILLED',
      price: '9',
      quantity: 10,
      executedPrice: '9',
      executedQuantity: 10,
      updatedAtMs: secondRevisionMs,
      executedAmount: '90',
    });

    try {
      const repository = createMixedTradeLogRepository({ resolveLogRootDir: () => tempRoot });
      // 在线事实：先 100 落盘，再同量更高 revision 合法减额 90 落盘；T 不随同量修订变化。
      repository.appendExecutionProgressIdempotent({
        monitorSymbol: 'HSI.HK',
        direction: 'LONG',
        symbol: 'BULL.HK',
        orderId: sell.orderId,
        factStage: 'TERMINAL',
        cumulativeQuantity: '10',
        cumulativeAmount: '100',
        lastExecutionTimeMs: executionTimeMs,
        orderRevisionMs: firstRevisionMs,
      });

      repository.appendExecutionProgressIdempotent({
        monitorSymbol: 'HSI.HK',
        direction: 'LONG',
        symbol: 'BULL.HK',
        orderId: sell.orderId,
        factStage: 'TERMINAL',
        cumulativeQuantity: '10',
        cumulativeAmount: '90',
        lastExecutionTimeMs: executionTimeMs,
        orderRevisionMs: secondRevisionMs,
      });

      const dailyLossTracker = createDailyLossTracker({
        onOwnershipWarning: () => {},
        ...orderAnalysis,
        resolveOrderOwnership: (order) =>
          order.symbol === 'BULL.HK' ? { monitorSymbol: 'HSI.HK', direction: 'LONG' } : null,
        toHongKongTimeIso,
      });
      const tradeInstances47 = createReadyTrader({
        orderRecorder: { fetchAllOrdersFromAPI: async () => [buy, sell] },
      });
      const deps = createBaseDeps({
        tradingConfig: createTradingConfig(monitor),
        accountService: tradeInstances47.accountService,
        orderRecorder: tradeInstances47.orderRecorder,
        orderHoldRegistry: tradeInstances47.orderHoldRegistry,
        orderMonitor: tradeInstances47.orderMonitor,
        dailyLossTracker,
        mixedTradeLogRepository: repository,
        protectionRecovery: { completeProtectionRecovery: () => true },
        tradeLogHydrator: { hydrate: () => {} },
      });

      const snapshot = await createLoadTradingDayRuntimeSnapshot(deps)(
        createLoadParams({ now, hydrateCooldownFromTradeLog: true }),
      );
      expect(snapshot.status).toBe('COMMITTED');
      expect(dailyLossTracker.getLossOffset('LONG')).toBe('-10');
      expect(repository.loadExecutionProgressRecords('2026-03-13')).toHaveLength(2);
      expect(repository.loadCompletionRecords('2026-03-13')).toEqual([]);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  for (const fileOrder of [
    ['OPEN', 'TERMINAL'],
    ['TERMINAL', 'OPEN'],
  ] as const) {
    it(`rejects same revision/quantity two-phase execution time conflict before side effects: ${fileOrder.join('->')}`, async () => {
      const now = new Date('2026-03-13T03:00:00.000Z');
      const revisionMs = Date.parse('2026-03-13T02:30:00.000Z');
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-time-conflict-'));
      const monitor = createProtectiveMonitor();
      const sell = await createProtectiveOrder({
        orderId: 'history-time-conflict',
        status: 'Filled',
        executionStatus: 'FILLED',
        price: '9',
        quantity: 10,
        executedPrice: '9',
        executedQuantity: 10,
        updatedAtMs: revisionMs,
        executedAmount: '90',
      });
      const sideEffects = createRecoverySideEffectRecorder();
      let hydrateCalls = 0;

      try {
        const repository = createMixedTradeLogRepository({ resolveLogRootDir: () => tempRoot });
        for (const stage of fileOrder) {
          repository.appendExecutionProgressIdempotent({
            monitorSymbol: 'HSI.HK',
            direction: 'LONG',
            symbol: 'BULL.HK',
            orderId: sell.orderId,
            factStage: stage,
            cumulativeQuantity: '10',
            cumulativeAmount: '90',
            lastExecutionTimeMs: stage === 'OPEN' ? revisionMs : revisionMs + 5_000,
            orderRevisionMs: revisionMs,
          });
        }

        const tradeInstances48 = createReadyTrader({
          orderRecorder: { fetchAllOrdersFromAPI: async () => [sell] },
        });
        const deps = createBaseDeps({
          tradingConfig: createTradingConfig(monitor),
          accountService: tradeInstances48.accountService,
          orderRecorder: tradeInstances48.orderRecorder,
          orderHoldRegistry: tradeInstances48.orderHoldRegistry,
          orderMonitor: tradeInstances48.orderMonitor,
          dailyLossTracker: sideEffects.dailyLossTracker,
          protectiveLiquidationEpisodeTracker: sideEffects.tracker,
          mixedTradeLogRepository: repository,
          protectionRecovery: { completeProtectionRecovery: () => true },
          tradeLogHydrator: {
            hydrate: () => {
              hydrateCalls += 1;
            },
          },
        });
        const seed = spyOn(deps.orderHoldRegistry, 'seedFromOrders');
        const recalculate = spyOn(deps.dailyLossTracker, 'publishRecalculation');

        await expectPromiseToRejectWithMessage(
          createLoadTradingDayRuntimeSnapshot(deps)(
            createLoadParams({ now, hydrateCooldownFromTradeLog: true }),
          ),
          /same revision\/quantity execution time conflict/,
        );
        expect(seed).not.toHaveBeenCalled();
        expect(recalculate).not.toHaveBeenCalled();
        expect(hydrateCalls).toBe(0);
        expect(sideEffects.effects).toEqual({
          restoreCompletedBoundary: 0,
          restoreInProgressEpisode: 0,
          restoreExecutionSnapshot: 0,
          restoreProtectionBoundary: 0,
          prepareProtectionBoundary: 0,
          commitProtectionBoundary: 0,
          commitCompletion: 0,
          hydrate: 0,
        });
      } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    });
  }

  it('rejects same revision/quantity progress-baseline execution time conflict before side effects', async () => {
    const now = new Date('2026-03-13T03:00:00.000Z');
    const revisionMs = Date.parse('2026-03-13T02:30:00.000Z');
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-baseline-time-conflict-'));
    const monitor = createProtectiveMonitor();
    const sell = await createProtectiveOrder({
      orderId: 'history-baseline-time-conflict',
      status: 'Filled',
      executionStatus: 'FILLED',
      price: '9',
      quantity: 10,
      executedPrice: '9',
      executedQuantity: 10,
      updatedAtMs: revisionMs,
      executedAmount: '90',
    });
    const sideEffects = createRecoverySideEffectRecorder();
    let hydrateCalls = 0;

    try {
      const repository = createMixedTradeLogRepository({ resolveLogRootDir: () => tempRoot });
      repository.appendExecutionProgressIdempotent({
        monitorSymbol: 'HSI.HK',
        direction: 'LONG',
        symbol: 'BULL.HK',
        orderId: sell.orderId,
        factStage: 'TERMINAL',
        cumulativeQuantity: '10',
        cumulativeAmount: '90',
        lastExecutionTimeMs: revisionMs,
        orderRevisionMs: revisionMs,
      });

      repository.appendCompletionIdempotent({
        monitorSymbol: 'HSI.HK',
        direction: 'LONG',
        boundaryExecutedTimeMs: revisionMs,
        orderBaselines: [
          {
            orderId: sell.orderId,
            symbol: 'BULL.HK',
            side: 'SELL',
            cumulativeQuantity: '10',
            cumulativeAmount: '90',
            lastExecutionTimeMs: revisionMs + 5_000,
            orderRevisionMs: revisionMs,
          },
        ],
      });

      const tradeInstances49 = createReadyTrader({
        orderRecorder: { fetchAllOrdersFromAPI: async () => [sell] },
      });
      const deps = createBaseDeps({
        tradingConfig: createTradingConfig(monitor),
        accountService: tradeInstances49.accountService,
        orderRecorder: tradeInstances49.orderRecorder,
        orderHoldRegistry: tradeInstances49.orderHoldRegistry,
        orderMonitor: tradeInstances49.orderMonitor,
        dailyLossTracker: sideEffects.dailyLossTracker,
        protectiveLiquidationEpisodeTracker: sideEffects.tracker,
        mixedTradeLogRepository: repository,
        protectionRecovery: { completeProtectionRecovery: () => true },
        tradeLogHydrator: {
          hydrate: () => {
            hydrateCalls += 1;
          },
        },
      });
      const seed = spyOn(deps.orderHoldRegistry, 'seedFromOrders');
      const recalculate = spyOn(deps.dailyLossTracker, 'publishRecalculation');

      await expectPromiseToRejectWithMessage(
        createLoadTradingDayRuntimeSnapshot(deps)(
          createLoadParams({ now, hydrateCooldownFromTradeLog: true }),
        ),
        /same revision\/quantity execution time conflict/,
      );
      expect(seed).not.toHaveBeenCalled();
      expect(recalculate).not.toHaveBeenCalled();
      expect(hydrateCalls).toBe(0);
      expect(sideEffects.effects).toEqual({
        restoreCompletedBoundary: 0,
        restoreInProgressEpisode: 0,
        restoreExecutionSnapshot: 0,
        restoreProtectionBoundary: 0,
        prepareProtectionBoundary: 0,
        commitProtectionBoundary: 0,
        commitCompletion: 0,
        hydrate: 0,
      });
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('restores legal post-boundary same-quantity amount revision against the frozen baseline', async () => {
    const now = new Date('2026-03-13T03:00:00.000Z');
    const revisionMs = Date.parse('2026-03-13T02:30:00.000Z');
    const executionTimeMs = revisionMs;
    const buyUpdatedAtMs = revisionMs - 1_000;
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-baseline-revision-'));
    const monitor = createProtectiveMonitor();
    const buy = await createProtectiveOrder({
      orderId: 'boundary-amount-revision-buy',
      side: 'BUY',
      status: 'Filled',
      executionStatus: 'FILLED',
      price: '10',
      quantity: 10,
      executedPrice: '10',
      executedQuantity: 10,
      updatedAtMs: buyUpdatedAtMs,
      executedAmount: '100',
    });
    const sell = await createProtectiveOrder({
      orderId: 'boundary-amount-revision-sell',
      status: 'Filled',
      executionStatus: 'FILLED',
      price: '10',
      quantity: 10,
      executedPrice: '10',
      executedQuantity: 10,
      updatedAtMs: revisionMs,
      executedAmount: '100',
    });

    try {
      const repository = createMixedTradeLogRepository({ resolveLogRootDir: () => tempRoot });
      repository.appendExecutionProgressIdempotent({
        monitorSymbol: 'HSI.HK',
        direction: 'LONG',
        symbol: 'BULL.HK',
        orderId: sell.orderId,
        factStage: 'TERMINAL',
        cumulativeQuantity: '10',
        cumulativeAmount: '100',
        lastExecutionTimeMs: executionTimeMs,
        orderRevisionMs: revisionMs,
      });

      repository.appendExecutionProgressIdempotent({
        monitorSymbol: 'HSI.HK',
        direction: 'LONG',
        symbol: 'BULL.HK',
        orderId: sell.orderId,
        factStage: 'TERMINAL',
        cumulativeQuantity: '10',
        cumulativeAmount: '90',
        lastExecutionTimeMs: executionTimeMs,
        orderRevisionMs: revisionMs + 1_000,
      });

      repository.appendCompletionIdempotent({
        monitorSymbol: 'HSI.HK',
        direction: 'LONG',
        boundaryExecutedTimeMs: executionTimeMs,
        orderBaselines: [
          {
            orderId: buy.orderId,
            symbol: 'BULL.HK',
            side: 'BUY',
            cumulativeQuantity: '10',
            cumulativeAmount: '100',
            lastExecutionTimeMs: buyUpdatedAtMs,
            orderRevisionMs: buyUpdatedAtMs,
          },
          {
            orderId: sell.orderId,
            symbol: 'BULL.HK',
            side: 'SELL',
            cumulativeQuantity: '10',
            cumulativeAmount: '100',
            lastExecutionTimeMs: executionTimeMs,
            orderRevisionMs: revisionMs,
          },
        ],
      });

      const finalSell = await createProtectiveOrder({
        orderId: sell.orderId,
        status: 'Filled',
        executionStatus: 'FILLED',
        price: '9',
        quantity: 10,
        executedPrice: '9',
        executedQuantity: 10,
        updatedAtMs: revisionMs + 1_000,
        executedAmount: '90',
      });
      const dailyLossTracker = createDailyLossTracker({
        onOwnershipWarning: () => {},
        ...orderAnalysis,
        resolveOrderOwnership: (order) =>
          order.symbol === 'BULL.HK' ? { monitorSymbol: 'HSI.HK', direction: 'LONG' } : null,
        toHongKongTimeIso,
      });
      const tradeInstances50 = createReadyTrader({
        orderRecorder: { fetchAllOrdersFromAPI: async () => [buy, finalSell] },
      });
      const deps = createBaseDeps({
        tradingConfig: createTradingConfig(monitor),
        accountService: tradeInstances50.accountService,
        orderRecorder: tradeInstances50.orderRecorder,
        orderHoldRegistry: tradeInstances50.orderHoldRegistry,
        orderMonitor: tradeInstances50.orderMonitor,
        dailyLossTracker,
        mixedTradeLogRepository: repository,
        protectionRecovery: { completeProtectionRecovery: () => true },
        tradeLogHydrator: { hydrate: () => {} },
      });

      const snapshot = await createLoadTradingDayRuntimeSnapshot(deps)(
        createLoadParams({ now, hydrateCooldownFromTradeLog: true }),
      );
      expect(snapshot.status).toBe('COMMITTED');
      expect(dailyLossTracker.getLossOffset('LONG')).toBe('0');
      expect(repository.loadExecutionProgressRecords('2026-03-13')).toHaveLength(2);
      expect(repository.loadCompletionRecords('2026-03-13')).toHaveLength(1);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects a positive execution with null raw amount before daily recalculation', async () => {
    const now = new Date('2026-03-13T03:00:00.000Z');
    const monitor = createProtectiveMonitor();
    const mappedOrder = await createProtectiveOrder({
      orderId: 'positive-null-amount',
      status: 'Filled',
      executionStatus: 'FILLED',
      price: '9',
      quantity: 10,
      executedPrice: '9',
      executedQuantity: 10,
      updatedAtMs: Date.parse('2026-03-13T02:30:00.000Z'),
      executedAmount: '90',
    });
    const rawOrder: OrderFact = {
      ...mappedOrder,
      executedPrice: null,
      executedAmount: null,
    };
    const tradeInstances46 = createReadyTrader({
      orderRecorder: { fetchAllOrdersFromAPI: async () => [rawOrder] },
    });
    const dailyLossTracker = createDailyLossTrackerDouble();
    const recalculate = spyOn(dailyLossTracker, 'publishRecalculation');
    const deps = createBaseDeps({
      tradingConfig: createTradingConfig(monitor),
      accountService: tradeInstances46.accountService,
      orderRecorder: tradeInstances46.orderRecorder,
      orderHoldRegistry: tradeInstances46.orderHoldRegistry,
      orderMonitor: tradeInstances46.orderMonitor,
      dailyLossTracker,
      tradeLogHydrator: {
        hydrate: () => {},
      },
    });

    await expectPromiseToRejectWithMessage(
      createLoadTradingDayRuntimeSnapshot(deps)(
        createLoadParams({ now, hydrateCooldownFromTradeLog: true }),
      ),
      /正成交缺少本次原始金额/,
    );
    expect(recalculate).not.toHaveBeenCalled();
    expect(dailyLossTracker.getLossOffset('LONG')).toBe('0');
  });

  it('restores new-ledger progress whose execution time is after its order revision', async () => {
    const now = new Date('2026-03-13T03:00:00.000Z');
    const executedAtMs = Date.parse('2026-03-13T02:30:00.000Z');
    const durableExecutionTimeMs = executedAtMs + 5_000;
    const monitor = createProtectiveMonitor();
    const stateFixtures = createMinimalRuntimeStates();

    const { tracker, restoreInProgressCalls } = createProtectiveTrackerRecorder();
    const protectiveOrder = await createProtectiveOrder({
      orderId: 'protective-late-execution-1',
      status: 'PartialFilled',
      executionStatus: 'PARTIAL',
      price: '9',
      quantity: 10,
      executedPrice: '9',
      executedQuantity: 5,
      updatedAtMs: executedAtMs,
      executedAmount: '45',
    });
    const tradeInstances44 = createReadyTrader({
      orderRecorder: { fetchAllOrdersFromAPI: async () => [protectiveOrder] },
    });
    const deps = createBaseDeps({
      ...stateFixtures,
      tradingConfig: createTradingConfig(monitor),
      accountService: tradeInstances44.accountService,
      orderRecorder: tradeInstances44.orderRecorder,
      orderHoldRegistry: tradeInstances44.orderHoldRegistry,
      orderMonitor: tradeInstances44.orderMonitor,
      protectiveLiquidationEpisodeTracker: tracker,
      tradeLogHydrator: {
        hydrate: () => {},
      },
      mixedTradeLogRepository: createMixedTradeLogRepositoryDouble({
        loadExecutionProgressRecords: () => [
          createExecutionProgressRecord({
            orderId: 'protective-late-execution-1',
            direction: 'LONG',
            cumulativeQuantity: '5',
            cumulativeAmount: '45',
            lastExecutionTimeMs: durableExecutionTimeMs,
            orderRevisionMs: executedAtMs,
          }),
        ],
      }),
    });

    const snapshot = await createLoadTradingDayRuntimeSnapshot(deps)(
      createLoadParams({ now, hydrateCooldownFromTradeLog: true }),
    );
    expect(snapshot.status).toBe('COMMITTED');
    if (snapshot.status !== 'COMMITTED') throw new Error('Expected committed load receipt');

    const restored = snapshot.allOrders.find(
      (order) => order.orderId === 'protective-late-execution-1',
    );
    expect(restored?.executionTimeMs).toBe(durableExecutionTimeMs);
    expect(restored?.updatedAtMs).toBe(executedAtMs);
    expect(restoreInProgressCalls).toEqual([
      {
        direction: 'LONG',
        symbol: 'BULL.HK',
        latestExecutedTimeMs: durableExecutionTimeMs,
      },
    ]);
  });

  it('restores new-ledger incremental progress whose execution time is after its revision', async () => {
    const now = new Date('2026-03-13T03:00:00.000Z');
    const revisionMs = Date.parse('2026-03-13T02:30:00.000Z');
    const durableExecutionTimeMs = revisionMs + 5_000;
    const monitor = createProtectiveMonitor();
    const stateFixtures = createMinimalRuntimeStates();

    const { tracker, restoreInProgressCalls } = createProtectiveTrackerRecorder();
    const protectiveOrder = await createProtectiveOrder({
      orderId: 'protective-incremental-late-execution',
      status: 'PartialFilled',
      executionStatus: 'PARTIAL',
      price: '9',
      quantity: 10,
      executedPrice: '9',
      executedQuantity: 10,
      updatedAtMs: revisionMs,
      executedAmount: '90',
    });
    const tradeInstances45 = createReadyTrader({
      orderRecorder: { fetchAllOrdersFromAPI: async () => [protectiveOrder] },
    });
    const deps = createBaseDeps({
      ...stateFixtures,
      tradingConfig: createTradingConfig(monitor),
      accountService: tradeInstances45.accountService,
      orderRecorder: tradeInstances45.orderRecorder,
      orderHoldRegistry: tradeInstances45.orderHoldRegistry,
      orderMonitor: tradeInstances45.orderMonitor,
      protectiveLiquidationEpisodeTracker: tracker,
      tradeLogHydrator: {
        hydrate: () => {},
      },
      mixedTradeLogRepository: createMixedTradeLogRepositoryDouble({
        loadExecutionProgressRecords: () => [
          createExecutionProgressRecord({
            orderId: 'protective-incremental-late-execution',
            direction: 'LONG',
            cumulativeQuantity: '5',
            cumulativeAmount: '45',
            lastExecutionTimeMs: revisionMs - 60_000,
            orderRevisionMs: revisionMs - 60_000,
          }),
          createExecutionProgressRecord({
            orderId: 'protective-incremental-late-execution',
            direction: 'LONG',
            cumulativeQuantity: '10',
            cumulativeAmount: '90',
            lastExecutionTimeMs: durableExecutionTimeMs,
            orderRevisionMs: revisionMs,
          }),
        ],
      }),
    });

    const snapshot = await createLoadTradingDayRuntimeSnapshot(deps)(
      createLoadParams({ now, hydrateCooldownFromTradeLog: true }),
    );
    expect(snapshot.status).toBe('COMMITTED');
    if (snapshot.status !== 'COMMITTED') throw new Error('Expected committed load receipt');

    const restored = snapshot.allOrders.find(
      (order) => order.orderId === 'protective-incremental-late-execution',
    );
    expect(restored?.executionTimeMs).toBe(durableExecutionTimeMs);
    expect(restored?.updatedAtMs).toBe(revisionMs);
    expect(restoreInProgressCalls).toEqual([
      {
        direction: 'LONG',
        symbol: 'BULL.HK',
        latestExecutedTimeMs: durableExecutionTimeMs,
      },
    ]);
  });

  it('prevalidates an unpersisted pending execution before restoring the persisted boundary', async () => {
    const now = new Date('2026-03-13T03:00:00.000Z');
    const completedBoundaryMs = Date.parse('2026-03-13T02:20:00.000Z');
    const pendingLatestExecutedMs = Date.parse('2026-03-13T02:30:00.000Z');
    const monitor = createProtectiveMonitor();
    const stateFixtures = createMinimalRuntimeStates();

    const { tracker, restoreCompletedCalls, restoreInProgressCalls } =
      createProtectiveTrackerRecorder();
    let receivedBoundaryMap: ReadonlyMap<string, number> | undefined;

    const completedOrder = await createProtectiveOrder({
      orderId: 'protective-completed-1',
      status: 'Canceled',
      executionStatus: 'PARTIAL',
      price: '9',
      quantity: 10,
      executedPrice: '9',
      executedQuantity: 10,
      updatedAtMs: completedBoundaryMs,

      executedAmount: '90',
    });
    const pendingOrder = await createProtectiveOrder({
      orderId: 'protective-pending-1',
      status: 'PartialFilled',
      executionStatus: 'PARTIAL',
      price: '8.8',
      quantity: 10,
      executedPrice: '8.8',
      executedQuantity: 5,
      updatedAtMs: pendingLatestExecutedMs,

      executedAmount: '44',
    });

    const tradeInstances29 = createReadyTrader({
      orderRecorder: { fetchAllOrdersFromAPI: async () => [completedOrder, pendingOrder] },
    });
    const deps = createBaseDeps({
      ...stateFixtures,
      tradingConfig: createTradingConfig(monitor),
      accountService: tradeInstances29.accountService,
      orderRecorder: tradeInstances29.orderRecorder,
      orderHoldRegistry: tradeInstances29.orderHoldRegistry,
      orderMonitor: tradeInstances29.orderMonitor,
      dailyLossTracker: createBoundaryCaptureDailyLossTracker((protectionBoundaryByDirection) => {
        receivedBoundaryMap = protectionBoundaryByDirection;
      }),
      protectiveLiquidationEpisodeTracker: tracker,
      tradeLogHydrator: {
        hydrate: () => {},
      },
      mixedTradeLogRepository: createMixedTradeLogRepositoryDouble({
        loadCompletionRecords: () => [
          createCompletionRecord({
            direction: 'LONG',
            boundaryExecutedTimeMs: completedBoundaryMs,
            orderBaselines: [
              {
                orderId: 'protective-completed-1',
                symbol: 'BULL.HK',
                side: 'SELL',
                cumulativeQuantity: '10',
                cumulativeAmount: '90',
                lastExecutionTimeMs: completedBoundaryMs,
                orderRevisionMs: completedBoundaryMs,
              },
            ],
          }),
        ],
      }),
    });

    const load = createLoadTradingDayRuntimeSnapshot(deps);
    await expectPromiseToRejectWithMessage(
      load(
        createLoadParams({
          now,
          hydrateCooldownFromTradeLog: true,
        }),
      ),
      /cannot reconstruct protection boundary baseline: orderId=protective-pending-1/,
    );

    expect(restoreCompletedCalls).toEqual([]);
    expect(restoreInProgressCalls).toEqual([]);
    expect(receivedBoundaryMap?.get('LONG')).toBeUndefined();
  });

  it('fails startup recovery when a completion omits a collapsed cross-boundary ordinary BUY baseline', async () => {
    const now = new Date('2026-03-13T03:00:00.000Z');
    const boundaryMs = Date.parse('2026-03-13T02:20:00.000Z');
    const finalExecutionMs = boundaryMs + 60_000;
    const monitor = createProtectiveMonitor();
    const ordinaryBuy: OrderFact = {
      ...(await createProtectiveOrder({
        orderId: 'ordinary-buy-crossing-persisted-boundary',
        side: 'BUY',
        status: 'Filled',
        executionStatus: 'FILLED',
        price: '16',
        quantity: 100,
        executedPrice: '16',
        executedQuantity: 100,
        updatedAtMs: finalExecutionMs,

        executedAmount: '1600',
      })),
      remark: 'AUTO',
      submittedAt: new Date(boundaryMs - 60_000),
    };
    const protectiveOrder = await createProtectiveOrder({
      orderId: 'protective-sell-at-persisted-boundary',
      status: 'Canceled',
      executionStatus: 'PARTIAL',
      price: '9',
      quantity: 40,
      executedPrice: '9',
      executedQuantity: 40,
      updatedAtMs: boundaryMs,

      executedAmount: '360',
    });
    const dailyLossTracker = createDailyLossTracker({
      onOwnershipWarning: () => {},
      ...orderAnalysis,
      resolveOrderOwnership: (order) =>
        order.symbol === 'BULL.HK' ? { monitorSymbol: 'HSI.HK', direction: 'LONG' } : null,
      toHongKongTimeIso,
    });
    const tradeInstances30 = createReadyTrader({
      orderRecorder: { fetchAllOrdersFromAPI: async () => [ordinaryBuy, protectiveOrder] },
    });
    const deps = createBaseDeps({
      tradingConfig: createTradingConfig(monitor),
      accountService: tradeInstances30.accountService,
      orderRecorder: tradeInstances30.orderRecorder,
      orderHoldRegistry: tradeInstances30.orderHoldRegistry,
      orderMonitor: tradeInstances30.orderMonitor,
      dailyLossTracker,
      mixedTradeLogRepository: createMixedTradeLogRepositoryDouble({
        loadCompletionRecords: () => [
          createCompletionRecord({
            direction: 'LONG',
            boundaryExecutedTimeMs: boundaryMs,
            orderBaselines: [
              {
                orderId: protectiveOrder.orderId,
                symbol: protectiveOrder.symbol,
                side: 'SELL',
                cumulativeQuantity: '40',
                cumulativeAmount: '360',
                lastExecutionTimeMs: boundaryMs,
                orderRevisionMs: boundaryMs,
              },
            ],
          }),
        ],
      }),
    });

    await expectPromiseToRejectWithMessage(
      createLoadTradingDayRuntimeSnapshot(deps)(
        createLoadParams({ now, hydrateCooldownFromTradeLog: true }),
      ),
      /cannot reconstruct.*ordinary-buy-crossing-persisted-boundary/i,
    );
  });

  it('restores a persisted cross-boundary ordinary BUY baseline during startup recovery', async () => {
    const now = new Date('2026-03-13T03:00:00.000Z');
    const boundaryMs = Date.parse('2026-03-13T02:20:00.000Z');
    const preBoundaryExecutionMs = boundaryMs - 60_000;
    const finalExecutionMs = boundaryMs + 60_000;
    const monitor = createProtectiveMonitor();
    const ordinaryBuy: OrderFact = {
      ...(await createProtectiveOrder({
        orderId: 'ordinary-buy-crossing-restored-boundary',
        side: 'BUY',
        status: 'Filled',
        executionStatus: 'FILLED',
        price: '16',
        quantity: 100,
        executedPrice: '16',
        executedQuantity: 100,
        updatedAtMs: finalExecutionMs,

        executedAmount: '1600',
      })),
      remark: 'AUTO',
      submittedAt: new Date(boundaryMs - 120_000),
    };
    const protectiveOrder = await createProtectiveOrder({
      orderId: 'protective-sell-at-restored-boundary',
      status: 'Canceled',
      executionStatus: 'PARTIAL',
      price: '9',
      quantity: 40,
      executedPrice: '9',
      executedQuantity: 40,
      updatedAtMs: boundaryMs,

      executedAmount: '360',
    });
    const dailyLossTracker = createDailyLossTracker({
      onOwnershipWarning: () => {},
      ...orderAnalysis,
      resolveOrderOwnership: (order) =>
        order.symbol === 'BULL.HK' ? { monitorSymbol: 'HSI.HK', direction: 'LONG' } : null,
      toHongKongTimeIso,
    });
    const tradeInstances31 = createReadyTrader({
      orderRecorder: { fetchAllOrdersFromAPI: async () => [ordinaryBuy, protectiveOrder] },
    });
    const deps = createBaseDeps({
      tradingConfig: createTradingConfig(monitor),
      accountService: tradeInstances31.accountService,
      orderRecorder: tradeInstances31.orderRecorder,
      orderHoldRegistry: tradeInstances31.orderHoldRegistry,
      orderMonitor: tradeInstances31.orderMonitor,
      dailyLossTracker,
      mixedTradeLogRepository: createMixedTradeLogRepositoryDouble({
        loadCompletionRecords: () => [
          createCompletionRecord({
            direction: 'LONG',
            boundaryExecutedTimeMs: boundaryMs,
            orderBaselines: [
              {
                orderId: ordinaryBuy.orderId,
                symbol: ordinaryBuy.symbol,
                side: 'BUY',
                cumulativeQuantity: '40',
                cumulativeAmount: '400',
                lastExecutionTimeMs: preBoundaryExecutionMs,
                orderRevisionMs: preBoundaryExecutionMs,
              },
              {
                orderId: protectiveOrder.orderId,
                symbol: protectiveOrder.symbol,
                side: 'SELL',
                cumulativeQuantity: '40',
                cumulativeAmount: '360',
                lastExecutionTimeMs: boundaryMs,
                orderRevisionMs: boundaryMs,
              },
            ],
          }),
        ],
      }),
    });

    const snapshot = await createLoadTradingDayRuntimeSnapshot(deps)(
      createLoadParams({ now, hydrateCooldownFromTradeLog: true }),
    );

    expect(snapshot.status).toBe('COMMITTED');
    if (snapshot.status !== 'COMMITTED') throw new Error('Expected committed load receipt');

    expect(snapshot.snapshotToken).toEqual(deps.snapshot.getView().token);
    expect(snapshot.allOrders).toEqual([
      ordinaryBuy,
      { ...protectiveOrder, executionTimeMs: boundaryMs },
    ]);
    expect(dailyLossTracker.getLossOffset('LONG')).toBe('0');
  });

  it('restores hydrated protective boundary from direction-only key', async () => {
    const now = new Date('2026-03-13T03:00:00.000Z');
    const completedBoundaryMs = Date.parse('2026-03-13T02:20:00.000Z');
    const monitor = createProtectiveMonitor();
    const { tracker, restoreCompletedCalls } = createProtectiveTrackerRecorder();
    const tradeInstances32 = createReadyTrader();
    const deps = createBaseDeps({
      tradingConfig: createTradingConfig(monitor),
      accountService: tradeInstances32.accountService,
      orderRecorder: tradeInstances32.orderRecorder,
      orderHoldRegistry: tradeInstances32.orderHoldRegistry,
      orderMonitor: tradeInstances32.orderMonitor,
      protectiveLiquidationEpisodeTracker: tracker,
      tradeLogHydrator: {
        hydrate: () => {},
      },
      mixedTradeLogRepository: createMixedTradeLogRepositoryDouble({
        loadCompletionRecords: () => [
          createCompletionRecord({
            direction: 'LONG',
            boundaryExecutedTimeMs: completedBoundaryMs,
          }),
        ],
      }),
    });

    const load = createLoadTradingDayRuntimeSnapshot(deps);
    await load(
      createLoadParams({
        now,
        hydrateCooldownFromTradeLog: true,
      }),
    );

    expect(restoreCompletedCalls).toEqual([
      {
        direction: 'LONG',
        boundaryExecutedTimeMs: completedBoundaryMs,
      },
    ]);
  });

  it('rejects a foreign completion before protective recovery consumes any persisted fact', async () => {
    const now = new Date('2026-03-13T03:00:00.000Z');
    const completionBoundaryMs = Date.parse('2026-03-13T02:20:00.000Z');
    const orderRevisionMs = Date.parse('2026-03-13T02:30:00.000Z');
    const lastExecutionTimeMs = orderRevisionMs - 10_000;
    const monitor = createProtectiveMonitor();
    const { tracker, dailyLossTracker, effects } = createRecoverySideEffectRecorder();
    const appendedRecords: Array<
      Parameters<MixedTradeLogRepository['appendCompletionIdempotent']>[0]
    > = [];
    const protectiveOrder = await createProtectiveOrder({
      orderId: 'protective-foreign-completion-progress',
      status: 'Canceled',
      executionStatus: 'PARTIAL',
      price: '9',
      quantity: 10,
      executedPrice: '9',
      executedQuantity: 5,
      updatedAtMs: orderRevisionMs,

      executedAmount: '45',
    });
    const tradeInstances33 = createReadyTrader({
      orderRecorder: { fetchAllOrdersFromAPI: async () => [protectiveOrder] },
    });
    const deps = createBaseDeps({
      tradingConfig: createTradingConfig(monitor),
      accountService: tradeInstances33.accountService,
      orderRecorder: tradeInstances33.orderRecorder,
      orderHoldRegistry: tradeInstances33.orderHoldRegistry,
      orderMonitor: tradeInstances33.orderMonitor,
      dailyLossTracker,
      protectiveLiquidationEpisodeTracker: tracker,
      tradeLogHydrator: {
        hydrate: () => {
          effects.hydrate += 1;
        },
      },
      mixedTradeLogRepository: createMixedTradeLogRepositoryDouble({
        loadCompletionRecords: () => [
          createCompletionRecord({
            monitorSymbol: 'FOREIGN.HK',
            direction: 'LONG',
            boundaryExecutedTimeMs: completionBoundaryMs,
            orderBaselines: [
              {
                orderId: 'foreign-completion-baseline',
                symbol: 'FOREIGN-BULL.HK',
                side: 'SELL',
                cumulativeQuantity: '1',
                cumulativeAmount: '9',
                lastExecutionTimeMs: completionBoundaryMs,
                orderRevisionMs: completionBoundaryMs,
              },
            ],
          }),
        ],
        loadExecutionProgressRecords: () => [
          createExecutionProgressRecord({
            orderId: protectiveOrder.orderId,
            direction: 'LONG',
            cumulativeQuantity: '5',
            cumulativeAmount: '45',
            lastExecutionTimeMs,
            orderRevisionMs,
          }),
        ],
        appendCompletionIdempotent: (record) => {
          appendedRecords.push(record);
        },
      }),
    });

    await expectPromiseToRejectWithMessage(
      createLoadTradingDayRuntimeSnapshot(deps)(
        createLoadParams({ now, hydrateCooldownFromTradeLog: true }),
      ),
      /completion.*monitorSymbol/i,
    );

    expect(effects).toEqual({
      restoreCompletedBoundary: 0,
      restoreInProgressEpisode: 0,
      restoreExecutionSnapshot: 0,
      restoreProtectionBoundary: 0,
      prepareProtectionBoundary: 0,
      commitProtectionBoundary: 0,
      commitCompletion: 0,
      hydrate: 0,
    });
    expect(appendedRecords).toEqual([]);
  });

  it('rejects a progress record forged from an ordinary sell before protective recovery side effects', async () => {
    const now = new Date('2026-03-13T03:00:00.000Z');
    const orderRevisionMs = Date.parse('2026-03-13T02:30:00.000Z');
    const lastExecutionTimeMs = orderRevisionMs - 10_000;
    const monitor = createProtectiveMonitor();
    const { tracker, dailyLossTracker, effects } = createRecoverySideEffectRecorder();
    const appendedRecords: Array<
      Parameters<MixedTradeLogRepository['appendCompletionIdempotent']>[0]
    > = [];
    const ordinarySellOrder: OrderFact = {
      ...(await createProtectiveOrder({
        orderId: 'ordinary-sell-forged-progress',
        status: 'Canceled',
        executionStatus: 'PARTIAL',
        price: '9',
        quantity: 10,
        executedPrice: '9',
        executedQuantity: 5,
        updatedAtMs: orderRevisionMs,

        executedAmount: '45',
      })),
      remark: 'AUTO',
    };
    const tradeInstances34 = createReadyTrader({
      orderRecorder: { fetchAllOrdersFromAPI: async () => [ordinarySellOrder] },
    });
    const deps = createBaseDeps({
      tradingConfig: createTradingConfig(monitor),
      accountService: tradeInstances34.accountService,
      orderRecorder: tradeInstances34.orderRecorder,
      orderHoldRegistry: tradeInstances34.orderHoldRegistry,
      orderMonitor: tradeInstances34.orderMonitor,
      dailyLossTracker,
      protectiveLiquidationEpisodeTracker: tracker,
      tradeLogHydrator: {
        hydrate: () => {
          effects.hydrate += 1;
        },
      },
      mixedTradeLogRepository: createMixedTradeLogRepositoryDouble({
        loadExecutionProgressRecords: () => [
          createExecutionProgressRecord({
            orderId: ordinarySellOrder.orderId,
            direction: 'LONG',
            cumulativeQuantity: '5',
            cumulativeAmount: '45',
            lastExecutionTimeMs,
            orderRevisionMs,
          }),
        ],
        appendCompletionIdempotent: (record) => {
          appendedRecords.push(record);
        },
      }),
    });

    await expectPromiseToRejectWithMessage(
      createLoadTradingDayRuntimeSnapshot(deps)(
        createLoadParams({ now, hydrateCooldownFromTradeLog: true }),
      ),
      /progress.*保护性清仓/i,
    );

    expect(effects).toEqual({
      restoreCompletedBoundary: 0,
      restoreInProgressEpisode: 0,
      restoreExecutionSnapshot: 0,
      restoreProtectionBoundary: 0,
      prepareProtectionBoundary: 0,
      commitProtectionBoundary: 0,
      commitCompletion: 0,
      hydrate: 0,
    });
    expect(appendedRecords).toEqual([]);
  });

  it('fails fast when protective order ownership cannot be resolved to the unique monitor', async () => {
    const now = new Date('2026-03-13T03:00:00.000Z');
    const executedAtMs = Date.parse('2026-03-13T02:30:00.000Z');
    const monitor = createProtectiveMonitor();
    let hydrateCalls = 0;
    const unmatchedProtectiveOrder: OrderFact = {
      ...(await createProtectiveOrder({
        orderId: 'protective-unmatched-1',
        status: 'Canceled',
        executionStatus: 'PARTIAL',
        price: '9',
        quantity: 10,
        executedPrice: '9',
        executedQuantity: 10,
        updatedAtMs: executedAtMs,

        executedAmount: '90',
      })),
      stockName: 'UNMATCHED RC',
    };
    const tradeInstances35 = createReadyTrader({
      orderRecorder: { fetchAllOrdersFromAPI: async () => [unmatchedProtectiveOrder] },
    });
    const deps = createBaseDeps({
      tradingConfig: createTradingConfig(monitor),
      accountService: tradeInstances35.accountService,
      orderRecorder: tradeInstances35.orderRecorder,
      orderHoldRegistry: tradeInstances35.orderHoldRegistry,
      orderMonitor: tradeInstances35.orderMonitor,
      tradeLogHydrator: {
        hydrate: () => {
          hydrateCalls += 1;
        },
      },
    });

    const load = createLoadTradingDayRuntimeSnapshot(deps);

    try {
      await load(createLoadParams({ now }));
      throw new Error('expected loadTradingDayRuntimeSnapshot to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error)) throw error;

      expect(error.message).toBe(
        '[DailyLossTracker] 相关成交订单无法归属: monitorSymbol=HSI.HK symbol=BULL.HK orderId=protective-unmatched-1',
      );
      expect(hydrateCalls).toBe(0);
    }
  });

  it('fails fast when protective order misses updatedAt during recovery', async () => {
    const now = new Date('2026-03-13T03:00:00.000Z');
    const monitor = createProtectiveMonitor();
    let hydrateCalls = 0;
    const ingress = await createBrokerIngressFixture({
      orderId: 'protective-missing-updated-at-1',
      symbol: 'BULL.HK',
      stockName: 'HSI RC',
      remark: 'AUTO|PL',
      side: 'SELL',
      status: 'Canceled',
      submittedPrice: '9',
      quantity: '10',
      executedPrice: '9',
      executedQuantity: '10',
      submittedAtMs: Date.parse('2026-03-13T02:00:00.000Z'),
      updatedAtMs: Date.parse('2026-03-13T02:01:00.000Z'),
    });
    const query = ingress.createQueryOrdersReader();
    ingress.setQueryUpdatedAtMs(Number.NaN);
    expect(ingress.nativeReadCounts().detail).toBe(0);
    let queryFailure: unknown = null;
    const tradeInstances36 = createReadyTrader({
      orderRecorder: {
        fetchAllOrdersFromAPI: async () => {
          try {
            return await query();
          } catch (error) {
            queryFailure = error;
            throw error;
          }
        },
      },
    });
    const deps = createBaseDeps({
      tradingConfig: createTradingConfig(monitor),
      accountService: tradeInstances36.accountService,
      orderRecorder: tradeInstances36.orderRecorder,
      orderHoldRegistry: tradeInstances36.orderHoldRegistry,
      orderMonitor: tradeInstances36.orderMonitor,
      tradeLogHydrator: {
        hydrate: () => {},
      },
    });

    const load = createLoadTradingDayRuntimeSnapshot({
      ...deps,
      tradeLogHydrator: {
        hydrate: () => {
          hydrateCalls += 1;
        },
      },
    });

    try {
      await load(createLoadParams({ now }));
      throw new Error('expected loadTradingDayRuntimeSnapshot to reject');
    } catch (error) {
      expect(error).toBe(queryFailure);
      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error)) throw error;

      expect(error.message).toBe('[orderMapper] invalid updatedAt');
      expect(ingress.nativeReadCounts()).toEqual({ cancel: 0, detail: 1 });
      expect(ingress.nativeMutations()).toEqual([]);
      expect(hydrateCalls).toBe(0);
    }
  });

  it('fails fast instead of auto-writing a crash-gap completion from RawOrder.updatedAt', async () => {
    const now = new Date('2026-03-13T03:00:00.000Z');
    const hydratedBoundaryMs = Date.parse('2026-03-13T02:20:00.000Z');
    const newerCompletedFillMs = Date.parse('2026-03-13T02:35:00.000Z');
    const monitor = createProtectiveMonitor();
    const stateFixtures = createMinimalRuntimeStates();

    const { tracker, restoreCompletedCalls } = createProtectiveTrackerRecorder();
    let receivedBoundaryMap: ReadonlyMap<string, number> | undefined;
    const appendedBoundaryMs: number[] = [];

    const completedOrder = await createProtectiveOrder({
      orderId: 'protective-completed-newer-1',
      status: 'Canceled',
      executionStatus: 'PARTIAL',
      price: '9',
      quantity: 10,
      executedPrice: '9',
      executedQuantity: 10,
      updatedAtMs: newerCompletedFillMs,

      executedAmount: '90',
    });

    const tradeInstances37 = createReadyTrader({
      orderRecorder: { fetchAllOrdersFromAPI: async () => [completedOrder] },
    });
    const deps = createBaseDeps({
      ...stateFixtures,
      tradingConfig: createTradingConfig(monitor),
      accountService: tradeInstances37.accountService,
      orderRecorder: tradeInstances37.orderRecorder,
      orderHoldRegistry: tradeInstances37.orderHoldRegistry,
      orderMonitor: tradeInstances37.orderMonitor,
      dailyLossTracker: createBoundaryCaptureDailyLossTracker((protectionBoundaryByDirection) => {
        receivedBoundaryMap = protectionBoundaryByDirection;
      }),
      protectiveLiquidationEpisodeTracker: tracker,
      tradeLogHydrator: {
        hydrate: () => {},
      },
      mixedTradeLogRepository: createMixedTradeLogRepositoryDouble({
        loadCompletionRecords: () => [
          createCompletionRecord({ direction: 'LONG', boundaryExecutedTimeMs: hydratedBoundaryMs }),
        ],
        appendCompletionIdempotent: (record) => {
          appendedBoundaryMs.push(record.boundaryExecutedTimeMs);
        },
      }),
    });

    const load = createLoadTradingDayRuntimeSnapshot(deps);
    await expectPromiseToRejectWithMessage(
      load(
        createLoadParams({
          now,
          hydrateCooldownFromTradeLog: true,
        }),
      ),
      /cannot reconstruct protection boundary baseline: orderId=protective-completed-newer-1/,
    );

    expect(restoreCompletedCalls).toEqual([]);
    expect(appendedBoundaryMs).toEqual([]);
    expect(receivedBoundaryMap?.get('LONG')).toBeUndefined();
  });

  it('restores an old partial-canceled episode while a zero-fill protective order is still pending', async () => {
    const now = new Date('2026-03-13T03:00:00.000Z');
    const oldPartialUpdatedAtMs = Date.parse('2026-03-13T02:20:00.000Z');
    const pendingUpdatedAtMs = Date.parse('2026-03-13T02:40:00.000Z');
    const monitor = createProtectiveMonitor();
    const tracker = createProtectiveLiquidationEpisodeTracker();
    const tradeInstances38 = createReadyTrader({
      orderRecorder: {
        fetchAllOrdersFromAPI: async () => [
          await createProtectiveOrder({
            orderId: 'protective-old-partial-canceled',
            status: 'Canceled',
            executionStatus: 'PARTIAL',
            price: '9',
            quantity: 10,
            executedPrice: '9',
            executedQuantity: 5,
            updatedAtMs: oldPartialUpdatedAtMs,

            executedAmount: '45',
          }),
          await createProtectiveOrder({
            orderId: 'protective-zero-pending',
            status: 'New',
            executionStatus: 'NONE',
            price: '8.8',
            quantity: 10,
            executedPrice: '0',
            executedQuantity: 0,
            updatedAtMs: pendingUpdatedAtMs,

            executedAmount: '0',
          }),
        ],
      },
    });
    const deps = createBaseDeps({
      tradingConfig: createTradingConfig(monitor),
      accountService: tradeInstances38.accountService,
      orderRecorder: tradeInstances38.orderRecorder,
      orderHoldRegistry: tradeInstances38.orderHoldRegistry,
      orderMonitor: tradeInstances38.orderMonitor,
      protectiveLiquidationEpisodeTracker: tracker,
      tradeLogHydrator: {
        hydrate: () => {},
      },
      mixedTradeLogRepository: createMixedTradeLogRepositoryDouble({
        loadExecutionProgressRecords: () => [
          createExecutionProgressRecord({
            orderId: 'protective-old-partial-canceled',
            direction: 'LONG',
            cumulativeQuantity: '5',
            cumulativeAmount: '45',
            lastExecutionTimeMs: oldPartialUpdatedAtMs - 10_000,
            orderRevisionMs: oldPartialUpdatedAtMs,
          }),
        ],
      }),
    });

    const load = createLoadTradingDayRuntimeSnapshot(deps);
    await load(
      createLoadParams({
        now,
        hydrateCooldownFromTradeLog: true,
      }),
    );

    expect(tracker.getInProgressEpisodes()).toEqual([
      {
        direction: 'LONG',
        symbol: 'BULL.HK',
        latestExecutedTimeMs: oldPartialUpdatedAtMs - 10_000,
      },
    ]);

    expect(
      tracker.prepareCompletion({
        direction: 'LONG',
        isDirectionFlat: true,
        hasPendingProtectiveOrders: false,
      }),
    ).toEqual({
      direction: 'LONG',
      boundaryExecutedTimeMs: oldPartialUpdatedAtMs - 10_000,
    });
  });

  it('persists and commits a flat crash-gap completion when exact progress can freeze a baseline', async () => {
    const now = new Date('2026-03-13T03:00:00.000Z');
    const orderRevisionMs = Date.parse('2026-03-13T02:30:00.000Z');
    const lastExecutionTimeMs = orderRevisionMs - 10_000;
    const monitor = createProtectiveMonitor();
    const protectiveOrder = await createProtectiveOrder({
      orderId: 'protective-crash-gap-exact',
      status: 'Canceled',
      executionStatus: 'PARTIAL',
      price: '9',
      quantity: 10,
      executedPrice: '9',
      executedQuantity: 5,
      updatedAtMs: orderRevisionMs,

      executedAmount: '45',
    });
    const dailyLossTracker = createDailyLossTracker({
      onOwnershipWarning: () => {},
      ...orderAnalysis,
      resolveOrderOwnership: (order) =>
        order.orderId === protectiveOrder.orderId
          ? { monitorSymbol: 'HSI.HK', direction: 'LONG' }
          : null,
      toHongKongTimeIso,
    });
    const tracker = createProtectiveLiquidationEpisodeTracker();
    const appendedRecords: Array<
      Parameters<MixedTradeLogRepository['appendCompletionIdempotent']>[0]
    > = [];
    const tradeInstances39 = createReadyTrader({
      orderRecorder: { fetchAllOrdersFromAPI: async () => [protectiveOrder] },
    });
    const deps = createBaseDeps({
      tradingConfig: createTradingConfig(monitor),
      accountService: tradeInstances39.accountService,
      orderRecorder: tradeInstances39.orderRecorder,
      orderHoldRegistry: tradeInstances39.orderHoldRegistry,
      orderMonitor: tradeInstances39.orderMonitor,
      dailyLossTracker,
      protectiveLiquidationEpisodeTracker: tracker,
      mixedTradeLogRepository: createMixedTradeLogRepositoryDouble({
        loadExecutionProgressRecords: () => [
          createExecutionProgressRecord({
            orderId: protectiveOrder.orderId,
            direction: 'LONG',
            cumulativeQuantity: '5',
            cumulativeAmount: '45',
            lastExecutionTimeMs,
            orderRevisionMs,
          }),
        ],
        appendCompletionIdempotent: (record) => {
          appendedRecords.push(record);
        },
      }),
    });

    await createLoadTradingDayRuntimeSnapshot(deps)(
      createLoadParams({ now, hydrateCooldownFromTradeLog: true }),
    );

    expect(appendedRecords).toHaveLength(1);
    expect(appendedRecords[0]?.boundaryExecutedTimeMs).toBe(lastExecutionTimeMs);
    expect(appendedRecords[0]?.orderBaselines).toEqual([
      {
        orderId: protectiveOrder.orderId,
        symbol: 'BULL.HK',
        side: 'SELL',
        cumulativeQuantity: '5',
        cumulativeAmount: '45',
        lastExecutionTimeMs,
        orderRevisionMs,
      },
    ]);
    expect(tracker.getInProgressEpisodes()).toEqual([]);
  });

  it('replays file-backed JSONL progress and persists the crash-gap completion for the next rebuild', async () => {
    const now = new Date('2026-03-13T03:00:00.000Z');
    const orderRevisionMs = Date.parse('2026-03-13T02:30:00.000Z');
    const lastExecutionTimeMs = orderRevisionMs - 10_000;
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-trade-log-recovery-'));
    const monitor = createProtectiveMonitor();
    const protectiveOrder = await createProtectiveOrder({
      orderId: 'file-backed-protective-recovery',
      status: 'Canceled',
      executionStatus: 'PARTIAL',
      price: '9',
      quantity: 10,
      executedPrice: '9',
      executedQuantity: 5,
      updatedAtMs: orderRevisionMs,

      executedAmount: '45',
    });
    const createDailyLossTrackerForRecovery = () =>
      createDailyLossTracker({
        onOwnershipWarning: () => {},
        ...orderAnalysis,
        resolveOrderOwnership: (order) =>
          order.orderId === protectiveOrder.orderId
            ? { monitorSymbol: 'HSI.HK', direction: 'LONG' }
            : null,
        toHongKongTimeIso,
      });

    try {
      const repository = createMixedTradeLogRepository({ resolveLogRootDir: () => tempRoot });
      repository.appendExecutionProgressIdempotent({
        monitorSymbol: 'HSI.HK',
        direction: 'LONG',
        symbol: 'BULL.HK',
        orderId: protectiveOrder.orderId,
        factStage: 'TERMINAL',
        cumulativeQuantity: '5',
        cumulativeAmount: '45',
        lastExecutionTimeMs,
        orderRevisionMs,
      });

      const episodeTracker = createProtectiveLiquidationEpisodeTracker();
      const tradeInstances40 = createReadyTrader({
        orderRecorder: { fetchAllOrdersFromAPI: async () => [protectiveOrder] },
      });
      const deps = createBaseDeps({
        tradingConfig: createTradingConfig(monitor),
        accountService: tradeInstances40.accountService,
        orderRecorder: tradeInstances40.orderRecorder,
        orderHoldRegistry: tradeInstances40.orderHoldRegistry,
        orderMonitor: tradeInstances40.orderMonitor,
        dailyLossTracker: createDailyLossTrackerForRecovery(),
        protectiveLiquidationEpisodeTracker: episodeTracker,
        mixedTradeLogRepository: repository,
      });

      await createLoadTradingDayRuntimeSnapshot(deps)(
        createLoadParams({ now, hydrateCooldownFromTradeLog: true }),
      );

      const logFile = buildTradeLogPath(tempRoot, now);
      expect(path.basename(logFile)).toBe('2026-03-13.jsonl');
      expect(fs.existsSync(logFile)).toBe(true);
      expect(repository.loadCompletionRecords('2026-03-13')).toHaveLength(1);
      expect(repository.loadCompletionRecords('2026-03-13')[0]?.boundaryExecutedTimeMs).toBe(
        lastExecutionTimeMs,
      );
      expect(episodeTracker.getInProgressEpisodes()).toEqual([]);

      const restartedRepository = createMixedTradeLogRepository({
        resolveLogRootDir: () => tempRoot,
      });
      const restartedEpisodeTracker = createProtectiveTrackerRecorder();
      const tradeInstances41 = createReadyTrader({
        orderRecorder: { fetchAllOrdersFromAPI: async () => [protectiveOrder] },
      });
      await createLoadTradingDayRuntimeSnapshot(
        createBaseDeps({
          tradingConfig: createTradingConfig(monitor),
          accountService: tradeInstances41.accountService,
          orderRecorder: tradeInstances41.orderRecorder,
          orderHoldRegistry: tradeInstances41.orderHoldRegistry,
          orderMonitor: tradeInstances41.orderMonitor,
          dailyLossTracker: createDailyLossTrackerForRecovery(),
          protectiveLiquidationEpisodeTracker: restartedEpisodeTracker.tracker,
          mixedTradeLogRepository: restartedRepository,
        }),
      )(createLoadParams({ now, hydrateCooldownFromTradeLog: true }));

      expect(restartedRepository.loadCompletionRecords('2026-03-13')).toHaveLength(1);
      expect(restartedRepository.loadExecutionProgressRecords('2026-03-13')).toHaveLength(1);
      expect(restartedEpisodeTracker.restoreCompletedCalls).toEqual([
        { direction: 'LONG', boundaryExecutedTimeMs: lastExecutionTimeMs },
      ]);
      expect(restartedEpisodeTracker.restoreInProgressCalls).toEqual([]);
      expect(fs.readFileSync(logFile, 'utf8').trimEnd().split('\n')).toHaveLength(2);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('restores same-revision OPEN then TERMINAL amount correction and freezes the final authoritative amount', async () => {
    const now = new Date('2026-03-13T03:00:00.000Z');
    const revisionMs = Date.parse('2026-03-13T02:30:00.000Z');
    const monitor = createProtectiveMonitor();
    const protectiveOrder = await createProtectiveOrder({
      orderId: 'protective-same-revision-correction',
      status: 'Canceled',
      executionStatus: 'PARTIAL',
      price: '9.4',
      quantity: 10,
      executedPrice: '9.4',
      executedQuantity: 5,
      updatedAtMs: revisionMs,

      executedAmount: '47',
    });
    const dailyLossTracker = createDailyLossTracker({
      onOwnershipWarning: () => {},
      ...orderAnalysis,
      resolveOrderOwnership: (order) =>
        order.orderId === protectiveOrder.orderId
          ? { monitorSymbol: 'HSI.HK', direction: 'LONG' }
          : null,
      toHongKongTimeIso,
    });
    const appendedRecords: Array<
      Parameters<MixedTradeLogRepository['appendCompletionIdempotent']>[0]
    > = [];
    const tradeInstances42 = createReadyTrader({
      orderRecorder: { fetchAllOrdersFromAPI: async () => [protectiveOrder] },
    });
    const deps = createBaseDeps({
      tradingConfig: createTradingConfig(monitor),
      accountService: tradeInstances42.accountService,
      orderRecorder: tradeInstances42.orderRecorder,
      orderHoldRegistry: tradeInstances42.orderHoldRegistry,
      orderMonitor: tradeInstances42.orderMonitor,
      dailyLossTracker,
      protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTracker(),
      mixedTradeLogRepository: createMixedTradeLogRepositoryDouble({
        loadExecutionProgressRecords: () => [
          createExecutionProgressRecord({
            orderId: protectiveOrder.orderId,
            direction: 'LONG',
            cumulativeQuantity: '5',
            cumulativeAmount: '45',
            lastExecutionTimeMs: revisionMs,
            orderRevisionMs: revisionMs,
            factStage: 'OPEN',
          }),
          createExecutionProgressRecord({
            orderId: protectiveOrder.orderId,
            direction: 'LONG',
            cumulativeQuantity: '5',
            cumulativeAmount: '47',
            lastExecutionTimeMs: revisionMs,
            orderRevisionMs: revisionMs,
            factStage: 'TERMINAL',
          }),
        ],
        appendCompletionIdempotent: (record) => {
          appendedRecords.push(record);
        },
      }),
    });

    await createLoadTradingDayRuntimeSnapshot(deps)(
      createLoadParams({ now, hydrateCooldownFromTradeLog: true }),
    );

    expect(appendedRecords).toHaveLength(1);
    expect(appendedRecords[0]?.orderBaselines).toEqual([
      {
        orderId: protectiveOrder.orderId,
        symbol: 'BULL.HK',
        side: 'SELL',
        cumulativeQuantity: '5',
        cumulativeAmount: '47',
        lastExecutionTimeMs: revisionMs,
        orderRevisionMs: revisionMs,
      },
    ]);

    const appendedCompletion = appendedRecords[0]!;
    const persistedCompletion = createCompletionRecord({
      direction: appendedCompletion.direction,
      boundaryExecutedTimeMs: appendedCompletion.boundaryExecutedTimeMs,
      orderBaselines: appendedCompletion.orderBaselines,
    });
    const restartedDailyLossTracker = createDailyLossTracker({
      onOwnershipWarning: () => {},
      ...orderAnalysis,
      resolveOrderOwnership: (order) =>
        order.orderId === protectiveOrder.orderId
          ? { monitorSymbol: 'HSI.HK', direction: 'LONG' }
          : null,
      toHongKongTimeIso,
    });
    const restartedEpisodeTracker = createProtectiveLiquidationEpisodeTracker();
    const secondRestartAppends: Array<
      Parameters<MixedTradeLogRepository['appendCompletionIdempotent']>[0]
    > = [];
    const tradeInstances43 = createReadyTrader({
      orderRecorder: { fetchAllOrdersFromAPI: async () => [protectiveOrder] },
    });
    const restartedDeps = createBaseDeps({
      tradingConfig: createTradingConfig(monitor),
      accountService: tradeInstances43.accountService,
      orderRecorder: tradeInstances43.orderRecorder,
      orderHoldRegistry: tradeInstances43.orderHoldRegistry,
      orderMonitor: tradeInstances43.orderMonitor,
      dailyLossTracker: restartedDailyLossTracker,
      protectiveLiquidationEpisodeTracker: restartedEpisodeTracker,
      mixedTradeLogRepository: createMixedTradeLogRepositoryDouble({
        loadCompletionRecords: () => [persistedCompletion],
        loadExecutionProgressRecords: () => [
          createExecutionProgressRecord({
            orderId: protectiveOrder.orderId,
            direction: 'LONG',
            cumulativeQuantity: '5',
            cumulativeAmount: '47',
            lastExecutionTimeMs: revisionMs,
            orderRevisionMs: revisionMs,
            factStage: 'TERMINAL',
          }),
          createExecutionProgressRecord({
            orderId: protectiveOrder.orderId,
            direction: 'LONG',
            cumulativeQuantity: '5',
            cumulativeAmount: '45',
            lastExecutionTimeMs: revisionMs,
            orderRevisionMs: revisionMs,
            factStage: 'OPEN',
          }),
        ],
        appendCompletionIdempotent: (record) => {
          secondRestartAppends.push(record);
        },
      }),
    });

    await createLoadTradingDayRuntimeSnapshot(restartedDeps)(
      createLoadParams({ now, hydrateCooldownFromTradeLog: true }),
    );

    expect(secondRestartAppends).toEqual([]);
  });
});
