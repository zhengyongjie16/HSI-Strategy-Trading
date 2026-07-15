/**
 * 交易日运行时快照加载单元测试
 *
 * 覆盖：requireTradingDay 且非交易日时抛错、账户信息缺失时抛错、
 * 订单拉取失败时抛错、正常返回 allOrders 与 quotesMap
 */
import { describe, it, expect } from 'bun:test';
import { OrderSide, OrderStatus, OrderType, WarrantStatus, WarrantType } from 'longbridge';
import { createLoadTradingDayRuntimeSnapshot } from '../../../src/main/lifecycle/loadTradingDayRuntimeSnapshot.js';
import { createQuoteContextMock } from '../../../mock/longbridge/quoteContextMock.js';
import { toMockDecimal } from '../../../mock/longbridge/decimal.js';
import { createSymbolRegistry } from '../../../src/services/autoSymbolManager/utils.js';
import { TRADING } from '../../../src/constants/index.js';
import { createSeatActivationDispatcher } from '../../../src/main/seatActivationDispatcher/index.js';
import { createProtectiveLiquidationEpisodeTracker } from '../../../src/core/trader/protectiveLiquidationEpisodeTracker/index.js';
import { createDailyLossTracker } from '../../../src/core/riskController/dailyLossTracker.js';
import { createDailyLossOrderAnalysisDeps } from '../../../src/core/orderRecorder/index.js';
import { toHongKongTimeIso } from '../../../src/utils/time/index.js';
import { createMonitorTaskQueue } from '../../../src/main/asyncProgram/monitorTaskQueue/index.js';
import type {
  LoadTradingDayRuntimeSnapshotDeps,
  LoadTradingDayRuntimeSnapshotParams,
} from '../../../src/main/lifecycle/types.js';
import type { MonitorTaskDataMap } from '../../../src/main/asyncProgram/monitorTaskProcessor/types.js';
import type { LastState, MonitorState } from '../../../src/types/state.js';
import type { RawOrderFromAPI } from '../../../src/types/services.js';
import type { ProtectiveLiquidationEpisodeTracker } from '../../../src/core/trader/protectiveLiquidationEpisodeTracker/types.js';
import type { MixedTradeLogRepository } from '../../../src/services/mixedTradeLogRepository/types.js';
import type { ProtectiveOrderParams } from './types.js';
import { createTradingConfig as createTradingConfigFactory } from '../../../mock/factories/configFactory.js';
import {
  createAccountSnapshotDouble,
  createDailyLossTrackerDouble,
  createMarketDataClientDouble,
  createMonitorConfigDouble,
  createPositionCacheDouble,
  createProtectiveLiquidationEpisodeTrackerDouble,
  createQuoteContextDouble,
  createSeatActivationDispatcherDouble,
  createTraderDouble,
} from '../../helpers/testDoubles.js';

function getEntry(_key: string): undefined {
  return;
}

function getInFlight(_key: string): undefined {
  return;
}

function createMinimalMonitorState(monitorSymbol = 'HSI.HK'): MonitorState {
  return {
    monitorSymbol,
    lastMonitorSnapshot: null,
    incrementalIndicatorRuntime: null,
  };
}

function createMinimalLastState(): LastState {
  return {
    canTrade: null,
    isHalfDay: null,
    openProtectionActive: null,
    currentDayKey: null,
    lifecycleState: 'ACTIVE',
    pendingOpenRebuild: false,
    targetTradingDayKey: null,
    isTradingEnabled: true,
    cachedAccount: null,
    cachedPositions: [],
    positionCache: createPositionCacheDouble(),
    cachedTradingDayInfo: null,
    tradingCalendarSnapshot: new Map(),
    monitorState: createMinimalMonitorState(),
    allTradingSymbols: new Set<string>(),
  };
}

function createTradingConfig(
  monitor: LoadTradingDayRuntimeSnapshotDeps['tradingConfig']['monitor'] = createMonitorConfigDouble(),
): LoadTradingDayRuntimeSnapshotDeps['tradingConfig'] {
  return createTradingConfigFactory({ monitor });
}

function createWarrantListCacheConfig(): LoadTradingDayRuntimeSnapshotDeps['warrantListCacheConfig'] {
  return {
    cache: {
      getEntry,
      setEntry: () => {},
      getInFlight,
      setInFlight: () => {},
      deleteInFlight: () => {},
      clear: () => {},
    },
    ttlMs: 60_000,
    nowMs: () => Date.now(),
  };
}

function createBaseDeps(
  overrides: Partial<LoadTradingDayRuntimeSnapshotDeps> = {},
): LoadTradingDayRuntimeSnapshotDeps {
  const tradingConfig = overrides.tradingConfig ?? createTradingConfig();

  return {
    marketDataClient: overrides.marketDataClient ?? createMarketDataClientDouble(),
    trader: overrides.trader ?? createTraderDouble(),
    lastState: overrides.lastState ?? createMinimalLastState(),
    tradingConfig,
    symbolRegistry: overrides.symbolRegistry ?? createSymbolRegistry(tradingConfig.monitor),
    dailyLossTracker: overrides.dailyLossTracker ?? createDailyLossTrackerDouble(),
    protectiveLiquidationEpisodeTracker:
      overrides.protectiveLiquidationEpisodeTracker ??
      createProtectiveLiquidationEpisodeTrackerDouble(),
    tradeLogHydrator: overrides.tradeLogHydrator ?? {
      hydrate: () => new Map<'LONG' | 'SHORT', number>(),
    },
    mixedTradeLogRepository:
      overrides.mixedTradeLogRepository ?? createMixedTradeLogRepositoryDouble(),
    warrantListCacheConfig: overrides.warrantListCacheConfig ?? createWarrantListCacheConfig(),
    seatActivationDispatcher:
      overrides.seatActivationDispatcher ?? createSeatActivationDispatcherDouble(),
  };
}

function createMixedTradeLogRepositoryDouble(
  overrides: Partial<MixedTradeLogRepository> = {},
): MixedTradeLogRepository {
  return {
    loadCompletionRecords: () => [],
    loadExecutionProgressRecords: () => [],
    appendCompletionIdempotent: () => 'APPENDED',
    appendExecutionProgressIdempotent: () => 'APPENDED',
    appendTradeRecord: () => {},
    ...overrides,
  };
}

function createReadyTrader(
  overrides: Partial<LoadTradingDayRuntimeSnapshotDeps['trader']> = {},
): LoadTradingDayRuntimeSnapshotDeps['trader'] {
  return createTraderDouble({
    getAccountSnapshot: async () => createAccountSnapshotDouble(100_000),
    getStockPositions: async () => [],
    fetchAllOrdersFromAPI: async () => [],
    ...overrides,
  });
}

function createLoadParams(
  overrides: Partial<LoadTradingDayRuntimeSnapshotParams> = {},
): LoadTradingDayRuntimeSnapshotParams {
  return {
    requireTradingDay: false,
    resetRuntimeSubscriptions: false,
    hydrateCooldownFromTradeLog: false,
    forceOrderRefresh: false,
    ...overrides,
    now: overrides.now ?? new Date(),
  };
}

async function expectPromiseToRejectWithMessage(
  promise: Promise<unknown>,
  messagePattern: RegExp,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }

    expect(error.message).toMatch(messagePattern);
    return;
  }

  throw new Error(`Expected promise to reject with message matching ${messagePattern.source}`);
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
      autoSearchMinDistancePctBull: 0.35,
      autoSearchMinDistancePctBear: -0.35,
      autoSearchMinTurnoverPerMinuteBull: 100_000,
      autoSearchMinTurnoverPerMinuteBear: 100_000,
      autoSearchExpiryMinMonths: 3,
      autoSearchOpenDelayMinutes: 5,
      switchIntervalMinutes: 0,
      switchDistanceRangeBull: { min: 0.2, max: 1.5 },
      switchDistanceRangeBear: { min: -1.5, max: -0.2 },
    },
  });
}

function createWarrantInfo(params: {
  readonly symbol: string;
  readonly warrantType: WarrantType;
  readonly apiDistanceRatio: number;
  readonly turnover: number;
  readonly callPrice: number;
}): Parameters<ReturnType<typeof createQuoteContextMock>['seedWarrantList']>[1][number] {
  const warrantType = params.warrantType === WarrantType.Bull ? 'Bull' : 'Bear';
  return {
    symbol: params.symbol,
    name: params.symbol,
    lastDone: toMockDecimal(0.1),
    toCallPrice: toMockDecimal(params.apiDistanceRatio),
    turnover: toMockDecimal(params.turnover),
    callPrice: toMockDecimal(params.callPrice),
    warrantType,
    status: WarrantStatus.Normal,
  };
}

function toApiDistanceRatio(percentValue: number): number {
  return percentValue / 100;
}

function createProtectiveOrder(params: ProtectiveOrderParams): RawOrderFromAPI {
  const updatedAt = params.updatedAtMs === undefined ? null : new Date(params.updatedAtMs);
  const submittedAt =
    params.updatedAtMs === undefined ? null : new Date(params.updatedAtMs - 30_000);

  return {
    orderId: params.orderId,
    symbol: 'BULL.HK',
    stockName: 'HSI RC',
    side: OrderSide.Sell,
    status: params.status,
    orderType: OrderType.MO,
    remark: 'AUTO|PL',
    price: params.price,
    quantity: params.quantity,
    executedPrice: params.executedPrice,
    executedQuantity: params.executedQuantity,
    submittedAt,
    updatedAt,
  };
}

function createBoundaryCaptureDailyLossTracker(
  onCapture: (
    protectionBoundaryByDirection: NonNullable<
      Parameters<
        LoadTradingDayRuntimeSnapshotDeps['dailyLossTracker']['recalculateFromAllOrders']
      >[3]
    >,
  ) => void,
): LoadTradingDayRuntimeSnapshotDeps['dailyLossTracker'] {
  return createDailyLossTrackerDouble({
    recalculateFromAllOrders: (_allOrders, _monitor, _now, protectionBoundaryByDirection) => {
      if (protectionBoundaryByDirection === undefined) {
        return;
      }

      onCapture(protectionBoundaryByDirection);
    },
    restoreProtectionBoundary: (prepared) => {
      onCapture(new Map([[prepared.direction, prepared.boundaryExecutedTimeMs]]));
    },
    commitProtectionBoundary: (prepared) => {
      onCapture(new Map([[prepared.direction, prepared.boundaryExecutedTimeMs]]));
    },
  });
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
  const boundaryByDirection = new Map<'LONG' | 'SHORT', number>();
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
        boundaryByDirection.set(params.direction, params.boundaryExecutedTimeMs);
      },
      restoreInProgressEpisode: (params) => {
        restoreInProgressCalls.push(params);
      },
      getLatestProtectionBoundaryByDirection: () =>
        new Map<'LONG' | 'SHORT', number>(boundaryByDirection),
      resetAll: () => {
        boundaryByDirection.clear();
      },
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

describe('createLoadTradingDayRuntimeSnapshot', () => {
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
    const deps = createBaseDeps({
      trader: createTraderDouble({
        getAccountSnapshot: async () => {
          throw new TypeError('TradeContext.accountBalance returned no primary account');
        },
        getStockPositions: async () => [],
      }),
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
  });

  it('持仓快照拉取失败时 fail-fast，不能按空持仓继续重建', async () => {
    let fetchAllOrdersCalled = false;
    const deps = createBaseDeps({
      trader: createReadyTrader({
        getStockPositions: async () => {
          throw new Error('positions unavailable');
        },
        fetchAllOrdersFromAPI: async () => {
          fetchAllOrdersCalled = true;
          return [];
        },
      }),
    });

    const load = createLoadTradingDayRuntimeSnapshot(deps);

    let caughtError: unknown = null;
    try {
      await load(createLoadParams());
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(Error);
    expect((caughtError as Error).message).toMatch(/无法刷新账户和持仓信息/);
    expect(fetchAllOrdersCalled).toBe(false);
  });

  it('订单拉取失败时直接抛出原始错误，不按空订单继续初始化', async () => {
    const deps = createBaseDeps({
      trader: createReadyTrader({
        fetchAllOrdersFromAPI: async () => {
          throw new Error('API 超时');
        },
      }),
    });

    const load = createLoadTradingDayRuntimeSnapshot(deps);

    expect(load(createLoadParams())).rejects.toThrow(/API 超时/);
  });

  it('only runs startup auto-search after continuous session and morning delay are both satisfied', async () => {
    const monitor = createAutoSearchMonitor();
    const tradingConfig = createTradingConfig(monitor);
    const quoteContext = createQuoteContextMock();
    quoteContext.seedWarrantList('HSI.HK', [
      createWarrantInfo({
        symbol: 'AUTO_BULL.HK',
        warrantType: WarrantType.Bull,
        apiDistanceRatio: toApiDistanceRatio(0.55),
        turnover: 30_000_000,
        callPrice: 20_500,
      }),
      createWarrantInfo({
        symbol: 'AUTO_BEAR.HK',
        warrantType: WarrantType.Bear,
        apiDistanceRatio: toApiDistanceRatio(-0.55),
        turnover: 30_000_000,
        callPrice: 19_500,
      }),
    ]);

    let isTradingDayCalls = 0;
    const marketDataClient = createMarketDataClientDouble({
      getQuoteContext: async () => createQuoteContextDouble(quoteContext),
      isTradingDay: async () => {
        isTradingDayCalls += 1;
        return { isTradingDay: true, isHalfDay: false };
      },
    });
    const blockedLastState = createMinimalLastState();
    blockedLastState.cachedTradingDayInfo = {
      dateKey: '2026-02-16',
      info: { isTradingDay: true, isHalfDay: false },
    };
    const blockedDeps = createBaseDeps({
      lastState: blockedLastState,
      tradingConfig,
      marketDataClient,
      trader: createReadyTrader(),
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

    const allowedLastState = createMinimalLastState();
    allowedLastState.cachedTradingDayInfo = {
      dateKey: '2026-02-16',
      info: { isTradingDay: true, isHalfDay: false },
    };
    const allowedDeps = createBaseDeps({
      lastState: allowedLastState,
      tradingConfig,
      marketDataClient,
      trader: createReadyTrader(),
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
    expect(allowedDeps.symbolRegistry.getSeatState('LONG').status).toBe('ACTIVATING');
    expect(allowedDeps.symbolRegistry.getSeatState('SHORT').status).toBe('ACTIVATING');
  });

  it('schedules SEAT_REFRESH for ACTIVATING seats restored during recovery', async () => {
    const monitor = createAutoSearchMonitor();
    const tradingConfig = createTradingConfig(monitor);
    const quoteContext = createQuoteContextMock();
    quoteContext.seedWarrantList('HSI.HK', [
      createWarrantInfo({
        symbol: 'AUTO_BULL.HK',
        warrantType: WarrantType.Bull,
        apiDistanceRatio: toApiDistanceRatio(0.55),
        turnover: 30_000_000,
        callPrice: 20_500,
      }),
      createWarrantInfo({
        symbol: 'AUTO_BEAR.HK',
        warrantType: WarrantType.Bear,
        apiDistanceRatio: toApiDistanceRatio(-0.55),
        turnover: 30_000_000,
        callPrice: 19_500,
      }),
    ]);

    const marketDataClient = createMarketDataClientDouble({
      getQuoteContext: async () => createQuoteContextDouble(quoteContext),
    });
    const lastState = createMinimalLastState();
    lastState.cachedTradingDayInfo = {
      dateKey: '2026-02-16',
      info: { isTradingDay: true, isHalfDay: false },
    };
    const symbolRegistry = createSymbolRegistry(tradingConfig.monitor);
    const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const seatActivationDispatcher = createSeatActivationDispatcher({
      symbolRegistry,
      monitorTaskQueue,
    });
    const deps = createBaseDeps({
      lastState,
      tradingConfig,
      marketDataClient,
      trader: createReadyTrader(),
      symbolRegistry,
      seatActivationDispatcher,
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
    const lastState = createMinimalLastState();
    const initialTradingCalendarSnapshot = lastState.tradingCalendarSnapshot;

    const deps = createBaseDeps({
      lastState,
      marketDataClient: createMarketDataClientDouble({
        getTradingDays: async () => {
          getTradingDaysCalls += 1;
          return {
            tradingDays: [],
            halfTradingDays: [],
          };
        },
      }),
      trader: createReadyTrader(),
    });

    const load = createLoadTradingDayRuntimeSnapshot(deps);

    await load(
      createLoadParams({
        now,
        requireTradingDay: true,
      }),
    );

    expect(getTradingDaysCalls).toBe(0);
    expect(lastState.tradingCalendarSnapshot).toBe(initialTradingCalendarSnapshot);
    expect(lastState.tradingCalendarSnapshot.size).toBe(0);
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
    const deps = createBaseDeps({
      tradingConfig: createTradingConfig(monitor),
      marketDataClient,
      trader: createReadyTrader(),
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
    const allOrders: ReadonlyArray<RawOrderFromAPI> = [];

    const deps = createBaseDeps({
      trader: createReadyTrader({
        fetchAllOrdersFromAPI: async () => allOrders,
      }),
      dailyLossTracker: createDailyLossTrackerDouble({
        recalculateFromAllOrders: (receivedOrders, _monitor, _now, receivedSegments) => {
          callOrder.push('recalculate');
          expect(receivedOrders).toBe(allOrders);
          expect(receivedSegments).toBeInstanceOf(Map);
        },
      }),
      tradeLogHydrator: {
        hydrate: () => {
          callOrder.push('hydrate');
          return new Map();
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
    const ordinaryOrder: RawOrderFromAPI = {
      ...createProtectiveOrder({
        orderId: 'ordinary-in-day-missing-updated-at',
        status: OrderStatus.Filled,
        price: 10,
        quantity: 10,
        executedPrice: 10,
        executedQuantity: 10,
        updatedAtMs: protectiveRevisionMs,
      }),
      side: OrderSide.Buy,
      orderType: OrderType.ELO,
      remark: 'AUTO',
      updatedAt: null,
    };
    const protectiveOrder = createProtectiveOrder({
      orderId: 'protective-progress-after-daily-loss-preflight',
      status: OrderStatus.PartialFilled,
      price: 9,
      quantity: 10,
      executedPrice: 9,
      executedQuantity: 5,
      updatedAtMs: protectiveRevisionMs,
    });
    const actualDailyLossTracker = createDailyLossTracker({
      ...createDailyLossOrderAnalysisDeps(),
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
    const deps = createBaseDeps({
      tradingConfig: createTradingConfig(monitor),
      trader: createReadyTrader({
        fetchAllOrdersFromAPI: async () => [ordinaryOrder, protectiveOrder],
      }),
      dailyLossTracker,
      protectiveLiquidationEpisodeTracker: tracker,
      marketDataClient,
      tradeLogHydrator: {
        hydrate: () => {
          laterEffects.hydrate += 1;
          return new Map();
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
          return 'APPENDED';
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
      /DailyLossTracker.*缺少有效更新时间.*ordinary-in-day-missing-updated-at/i,
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
    expect(tracker.getLatestProtectionBoundaryByDirection().get('LONG')).toBe(existingBoundaryMs);
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
    const lastState = createMinimalLastState();
    const { tracker, restoreCompletedCalls, restoreInProgressCalls } =
      createProtectiveTrackerRecorder();
    let receivedBoundaryMap: ReadonlyMap<string, number> | undefined;

    const protectiveOrder = createProtectiveOrder({
      orderId: 'protective-canceled-1',
      status: OrderStatus.Canceled,
      price: 9,
      quantity: 10,
      executedPrice: 9,
      executedQuantity: 10,
      updatedAtMs: executedAtMs,
    });

    const deps = createBaseDeps({
      lastState,
      tradingConfig: createTradingConfig(monitor),
      trader: createReadyTrader({
        fetchAllOrdersFromAPI: async () => [protectiveOrder],
      }),
      dailyLossTracker: createBoundaryCaptureDailyLossTracker((protectionBoundaryByDirection) => {
        receivedBoundaryMap = protectionBoundaryByDirection;
      }),
      protectiveLiquidationEpisodeTracker: tracker,
      tradeLogHydrator: {
        hydrate: () => new Map(),
      },
    });

    const load = createLoadTradingDayRuntimeSnapshot(deps);
    await load(createLoadParams({ now }));

    expect(restoreCompletedCalls).toHaveLength(0);
    expect(restoreInProgressCalls).toHaveLength(0);
    expect(receivedBoundaryMap?.get('LONG')).toBeUndefined();
  });

  it('restores an in-progress episode from exact progress for a partial-filled pending order', async () => {
    const now = new Date('2026-03-13T03:00:00.000Z');
    const executedAtMs = Date.parse('2026-03-13T02:30:00.000Z');
    const monitor = createProtectiveMonitor();
    const lastState = createMinimalLastState();
    const { tracker, restoreCompletedCalls, restoreInProgressCalls } =
      createProtectiveTrackerRecorder();
    let receivedBoundaryMap: ReadonlyMap<string, number> | undefined;

    const protectiveOrder = createProtectiveOrder({
      orderId: 'protective-partial-1',
      status: OrderStatus.PartialFilled,
      price: 9,
      quantity: 10,
      executedPrice: 9,
      executedQuantity: 5,
      updatedAtMs: executedAtMs,
    });

    const deps = createBaseDeps({
      lastState,
      tradingConfig: createTradingConfig(monitor),
      trader: createReadyTrader({
        fetchAllOrdersFromAPI: async () => [protectiveOrder],
      }),
      dailyLossTracker: createBoundaryCaptureDailyLossTracker((protectionBoundaryByDirection) => {
        receivedBoundaryMap = protectionBoundaryByDirection;
      }),
      protectiveLiquidationEpisodeTracker: tracker,
      tradeLogHydrator: {
        hydrate: () => new Map(),
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

  it('restores the persisted boundary but blocks an unpersisted pending execution without exact time', async () => {
    const now = new Date('2026-03-13T03:00:00.000Z');
    const completedBoundaryMs = Date.parse('2026-03-13T02:20:00.000Z');
    const pendingLatestExecutedMs = Date.parse('2026-03-13T02:30:00.000Z');
    const monitor = createProtectiveMonitor();
    const lastState = createMinimalLastState();
    const { tracker, restoreCompletedCalls, restoreInProgressCalls } =
      createProtectiveTrackerRecorder();
    let receivedBoundaryMap: ReadonlyMap<string, number> | undefined;

    const completedOrder = createProtectiveOrder({
      orderId: 'protective-completed-1',
      status: OrderStatus.Canceled,
      price: 9,
      quantity: 10,
      executedPrice: 9,
      executedQuantity: 10,
      updatedAtMs: completedBoundaryMs,
    });
    const pendingOrder = createProtectiveOrder({
      orderId: 'protective-pending-1',
      status: OrderStatus.PartialFilled,
      price: 8.8,
      quantity: 10,
      executedPrice: 8.8,
      executedQuantity: 5,
      updatedAtMs: pendingLatestExecutedMs,
    });

    const deps = createBaseDeps({
      lastState,
      tradingConfig: createTradingConfig(monitor),
      trader: createReadyTrader({
        fetchAllOrdersFromAPI: async () => [completedOrder, pendingOrder],
      }),
      dailyLossTracker: createBoundaryCaptureDailyLossTracker((protectionBoundaryByDirection) => {
        receivedBoundaryMap = protectionBoundaryByDirection;
      }),
      protectiveLiquidationEpisodeTracker: tracker,
      tradeLogHydrator: {
        hydrate: () => new Map<'LONG' | 'SHORT', number>([['LONG', completedBoundaryMs]]),
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
    expect(
      load(
        createLoadParams({
          now,
          hydrateCooldownFromTradeLog: true,
        }),
      ),
    ).rejects.toThrow(/缺少精确成交时间.*protective-pending-1/);

    expect(restoreCompletedCalls).toEqual([
      {
        direction: 'LONG',
        boundaryExecutedTimeMs: completedBoundaryMs,
      },
    ]);

    expect(restoreInProgressCalls).toEqual([]);
    expect(receivedBoundaryMap?.get('LONG')).toBe(completedBoundaryMs);
  });

  it('fails startup recovery when a completion omits a collapsed cross-boundary ordinary BUY baseline', async () => {
    const now = new Date('2026-03-13T03:00:00.000Z');
    const boundaryMs = Date.parse('2026-03-13T02:20:00.000Z');
    const finalExecutionMs = boundaryMs + 60_000;
    const monitor = createProtectiveMonitor();
    const ordinaryBuy: RawOrderFromAPI = {
      ...createProtectiveOrder({
        orderId: 'ordinary-buy-crossing-persisted-boundary',
        status: OrderStatus.Filled,
        price: 16,
        quantity: 100,
        executedPrice: 16,
        executedQuantity: 100,
        updatedAtMs: finalExecutionMs,
      }),
      side: OrderSide.Buy,
      orderType: OrderType.ELO,
      remark: 'AUTO',
      submittedAt: new Date(boundaryMs - 60_000),
    };
    const protectiveOrder = createProtectiveOrder({
      orderId: 'protective-sell-at-persisted-boundary',
      status: OrderStatus.Canceled,
      price: 9,
      quantity: 40,
      executedPrice: 9,
      executedQuantity: 40,
      updatedAtMs: boundaryMs,
    });
    const dailyLossTracker = createDailyLossTracker({
      ...createDailyLossOrderAnalysisDeps(),
      resolveOrderOwnership: (order) =>
        order.symbol === 'BULL.HK' ? { monitorSymbol: 'HSI.HK', direction: 'LONG' } : null,
      toHongKongTimeIso,
    });
    const deps = createBaseDeps({
      tradingConfig: createTradingConfig(monitor),
      trader: createReadyTrader({
        fetchAllOrdersFromAPI: async () => [ordinaryBuy, protectiveOrder],
      }),
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
    const ordinaryBuy: RawOrderFromAPI = {
      ...createProtectiveOrder({
        orderId: 'ordinary-buy-crossing-restored-boundary',
        status: OrderStatus.Filled,
        price: 16,
        quantity: 100,
        executedPrice: 16,
        executedQuantity: 100,
        updatedAtMs: finalExecutionMs,
      }),
      side: OrderSide.Buy,
      orderType: OrderType.ELO,
      remark: 'AUTO',
      submittedAt: new Date(boundaryMs - 120_000),
    };
    const protectiveOrder = createProtectiveOrder({
      orderId: 'protective-sell-at-restored-boundary',
      status: OrderStatus.Canceled,
      price: 9,
      quantity: 40,
      executedPrice: 9,
      executedQuantity: 40,
      updatedAtMs: boundaryMs,
    });
    const dailyLossTracker = createDailyLossTracker({
      ...createDailyLossOrderAnalysisDeps(),
      resolveOrderOwnership: (order) =>
        order.symbol === 'BULL.HK' ? { monitorSymbol: 'HSI.HK', direction: 'LONG' } : null,
      toHongKongTimeIso,
    });
    const deps = createBaseDeps({
      tradingConfig: createTradingConfig(monitor),
      trader: createReadyTrader({
        fetchAllOrdersFromAPI: async () => [ordinaryBuy, protectiveOrder],
      }),
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

    expect(snapshot.allOrders).toEqual([ordinaryBuy, protectiveOrder]);
    expect(dailyLossTracker.getLossOffset('LONG')).toBe(0);
  });

  it('restores hydrated protective boundary from direction-only key', async () => {
    const now = new Date('2026-03-13T03:00:00.000Z');
    const completedBoundaryMs = Date.parse('2026-03-13T02:20:00.000Z');
    const monitor = createProtectiveMonitor();
    const { tracker, restoreCompletedCalls } = createProtectiveTrackerRecorder();
    const deps = createBaseDeps({
      tradingConfig: createTradingConfig(monitor),
      trader: createReadyTrader(),
      protectiveLiquidationEpisodeTracker: tracker,
      tradeLogHydrator: {
        hydrate: () => new Map<'LONG' | 'SHORT', number>([['LONG', completedBoundaryMs]]),
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
    const protectiveOrder = createProtectiveOrder({
      orderId: 'protective-foreign-completion-progress',
      status: OrderStatus.Canceled,
      price: 9,
      quantity: 10,
      executedPrice: 9,
      executedQuantity: 5,
      updatedAtMs: orderRevisionMs,
    });
    const deps = createBaseDeps({
      tradingConfig: createTradingConfig(monitor),
      trader: createReadyTrader({
        fetchAllOrdersFromAPI: async () => [protectiveOrder],
      }),
      dailyLossTracker,
      protectiveLiquidationEpisodeTracker: tracker,
      tradeLogHydrator: {
        hydrate: () => {
          effects.hydrate += 1;
          return new Map();
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
          return 'APPENDED';
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
    const ordinarySellOrder: RawOrderFromAPI = {
      ...createProtectiveOrder({
        orderId: 'ordinary-sell-forged-progress',
        status: OrderStatus.Canceled,
        price: 9,
        quantity: 10,
        executedPrice: 9,
        executedQuantity: 5,
        updatedAtMs: orderRevisionMs,
      }),
      remark: 'AUTO',
    };
    const deps = createBaseDeps({
      tradingConfig: createTradingConfig(monitor),
      trader: createReadyTrader({
        fetchAllOrdersFromAPI: async () => [ordinarySellOrder],
      }),
      dailyLossTracker,
      protectiveLiquidationEpisodeTracker: tracker,
      tradeLogHydrator: {
        hydrate: () => {
          effects.hydrate += 1;
          return new Map();
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
          return 'APPENDED';
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
    const unmatchedProtectiveOrder: RawOrderFromAPI = {
      ...createProtectiveOrder({
        orderId: 'protective-unmatched-1',
        status: OrderStatus.Canceled,
        price: 9,
        quantity: 10,
        executedPrice: 9,
        executedQuantity: 10,
        updatedAtMs: executedAtMs,
      }),
      stockName: 'UNMATCHED RC',
    };
    const deps = createBaseDeps({
      tradingConfig: createTradingConfig(monitor),
      trader: createReadyTrader({
        fetchAllOrdersFromAPI: async () => [unmatchedProtectiveOrder],
      }),
      tradeLogHydrator: {
        hydrate: () => new Map(),
      },
    });

    const load = createLoadTradingDayRuntimeSnapshot(deps);

    try {
      await load(createLoadParams({ now }));
      throw new Error('expected loadTradingDayRuntimeSnapshot to reject');
    } catch (error) {
      expect((error as Error).message).toContain('保护性清仓订单无法归属到唯一监控标的');
    }
  });

  it('fails fast when protective order misses updatedAt during recovery', async () => {
    const now = new Date('2026-03-13T03:00:00.000Z');
    const monitor = createProtectiveMonitor();
    const protectiveOrder = createProtectiveOrder({
      orderId: 'protective-missing-updated-at-1',
      status: OrderStatus.Canceled,
      price: 9,
      quantity: 10,
      executedPrice: 9,
      executedQuantity: 10,
    });
    const deps = createBaseDeps({
      tradingConfig: createTradingConfig(monitor),
      trader: createReadyTrader({
        fetchAllOrdersFromAPI: async () => [protectiveOrder],
      }),
      tradeLogHydrator: {
        hydrate: () => new Map(),
      },
    });

    const load = createLoadTradingDayRuntimeSnapshot(deps);

    try {
      await load(createLoadParams({ now }));
      throw new Error('expected loadTradingDayRuntimeSnapshot to reject');
    } catch (error) {
      expect((error as Error).message).toContain('保护性清仓订单缺少有效更新时间');
    }
  });

  it('fails fast instead of auto-writing a crash-gap completion from RawOrder.updatedAt', async () => {
    const now = new Date('2026-03-13T03:00:00.000Z');
    const hydratedBoundaryMs = Date.parse('2026-03-13T02:20:00.000Z');
    const newerCompletedFillMs = Date.parse('2026-03-13T02:35:00.000Z');
    const monitor = createProtectiveMonitor();
    const lastState = createMinimalLastState();
    const { tracker, restoreCompletedCalls } = createProtectiveTrackerRecorder();
    let receivedBoundaryMap: ReadonlyMap<string, number> | undefined;
    const appendedBoundaryMs: number[] = [];

    const completedOrder = createProtectiveOrder({
      orderId: 'protective-completed-newer-1',
      status: OrderStatus.Canceled,
      price: 9,
      quantity: 10,
      executedPrice: 9,
      executedQuantity: 10,
      updatedAtMs: newerCompletedFillMs,
    });

    const deps = createBaseDeps({
      lastState,
      tradingConfig: createTradingConfig(monitor),
      trader: createReadyTrader({
        fetchAllOrdersFromAPI: async () => [completedOrder],
      }),
      dailyLossTracker: createBoundaryCaptureDailyLossTracker((protectionBoundaryByDirection) => {
        receivedBoundaryMap = protectionBoundaryByDirection;
      }),
      protectiveLiquidationEpisodeTracker: tracker,
      tradeLogHydrator: {
        hydrate: () => new Map<'LONG' | 'SHORT', number>([['LONG', hydratedBoundaryMs]]),
      },
      mixedTradeLogRepository: createMixedTradeLogRepositoryDouble({
        loadCompletionRecords: () => [
          createCompletionRecord({ direction: 'LONG', boundaryExecutedTimeMs: hydratedBoundaryMs }),
        ],
        appendCompletionIdempotent: (record) => {
          appendedBoundaryMs.push(record.boundaryExecutedTimeMs);
          return 'APPENDED';
        },
      }),
    });

    const load = createLoadTradingDayRuntimeSnapshot(deps);
    expect(
      load(
        createLoadParams({
          now,
          hydrateCooldownFromTradeLog: true,
        }),
      ),
    ).rejects.toThrow(/缺少精确成交时间.*protective-completed-newer-1/);

    expect(restoreCompletedCalls).toEqual([
      {
        direction: 'LONG',
        boundaryExecutedTimeMs: hydratedBoundaryMs,
      },
    ]);
    expect(appendedBoundaryMs).toEqual([]);
    expect(receivedBoundaryMap?.get('LONG')).toBe(hydratedBoundaryMs);
  });

  it('restores an old partial-canceled episode while a zero-fill protective order is still pending', async () => {
    const now = new Date('2026-03-13T03:00:00.000Z');
    const oldPartialUpdatedAtMs = Date.parse('2026-03-13T02:20:00.000Z');
    const pendingUpdatedAtMs = Date.parse('2026-03-13T02:40:00.000Z');
    const monitor = createProtectiveMonitor();
    const tracker = createProtectiveLiquidationEpisodeTracker();
    const deps = createBaseDeps({
      tradingConfig: createTradingConfig(monitor),
      trader: createReadyTrader({
        fetchAllOrdersFromAPI: async () => [
          createProtectiveOrder({
            orderId: 'protective-old-partial-canceled',
            status: OrderStatus.Canceled,
            price: 9,
            quantity: 10,
            executedPrice: 9,
            executedQuantity: 5,
            updatedAtMs: oldPartialUpdatedAtMs,
          }),
          createProtectiveOrder({
            orderId: 'protective-zero-pending',
            status: OrderStatus.New,
            price: 8.8,
            quantity: 10,
            executedPrice: 0,
            executedQuantity: 0,
            updatedAtMs: pendingUpdatedAtMs,
          }),
        ],
      }),
      protectiveLiquidationEpisodeTracker: tracker,
      tradeLogHydrator: {
        hydrate: () => new Map(),
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
      symbol: 'BULL.HK',
      boundaryExecutedTimeMs: oldPartialUpdatedAtMs - 10_000,
    });
  });

  it('persists and commits a flat crash-gap completion when exact progress can freeze a baseline', async () => {
    const now = new Date('2026-03-13T03:00:00.000Z');
    const orderRevisionMs = Date.parse('2026-03-13T02:30:00.000Z');
    const lastExecutionTimeMs = orderRevisionMs - 10_000;
    const monitor = createProtectiveMonitor();
    const protectiveOrder = createProtectiveOrder({
      orderId: 'protective-crash-gap-exact',
      status: OrderStatus.Canceled,
      price: 9,
      quantity: 10,
      executedPrice: 9,
      executedQuantity: 5,
      updatedAtMs: orderRevisionMs,
    });
    const dailyLossTracker = createDailyLossTracker({
      ...createDailyLossOrderAnalysisDeps(),
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
    const deps = createBaseDeps({
      tradingConfig: createTradingConfig(monitor),
      trader: createReadyTrader({
        fetchAllOrdersFromAPI: async () => [protectiveOrder],
      }),
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
          return 'APPENDED';
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
    expect(tracker.getLatestProtectionBoundaryByDirection().get('LONG')).toBe(lastExecutionTimeMs);
  });

  it('restores same-revision OPEN then TERMINAL amount correction and freezes the final authoritative amount', async () => {
    const now = new Date('2026-03-13T03:00:00.000Z');
    const revisionMs = Date.parse('2026-03-13T02:30:00.000Z');
    const monitor = createProtectiveMonitor();
    const protectiveOrder = createProtectiveOrder({
      orderId: 'protective-same-revision-correction',
      status: OrderStatus.Canceled,
      price: 9.4,
      quantity: 10,
      executedPrice: 9.4,
      executedQuantity: 5,
      updatedAtMs: revisionMs,
    });
    const dailyLossTracker = createDailyLossTracker({
      ...createDailyLossOrderAnalysisDeps(),
      resolveOrderOwnership: (order) =>
        order.orderId === protectiveOrder.orderId
          ? { monitorSymbol: 'HSI.HK', direction: 'LONG' }
          : null,
      toHongKongTimeIso,
    });
    const appendedRecords: Array<
      Parameters<MixedTradeLogRepository['appendCompletionIdempotent']>[0]
    > = [];
    const deps = createBaseDeps({
      tradingConfig: createTradingConfig(monitor),
      trader: createReadyTrader({
        fetchAllOrdersFromAPI: async () => [protectiveOrder],
      }),
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
          return 'APPENDED';
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
      ...createDailyLossOrderAnalysisDeps(),
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
    const restartedDeps = createBaseDeps({
      tradingConfig: createTradingConfig(monitor),
      trader: createReadyTrader({
        fetchAllOrdersFromAPI: async () => [protectiveOrder],
      }),
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
          return 'APPENDED';
        },
      }),
    });

    await createLoadTradingDayRuntimeSnapshot(restartedDeps)(
      createLoadParams({ now, hydrateCooldownFromTradeLog: true }),
    );

    expect(secondRestartAppends).toEqual([]);
    expect(restartedEpisodeTracker.getLatestProtectionBoundaryByDirection().get('LONG')).toBe(
      revisionMs,
    );
  });
});
