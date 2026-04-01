/**
 * 交易日运行时快照加载单元测试
 *
 * 覆盖：requireTradingDay 且非交易日时抛错、账户信息缺失时抛错、
 * failOnOrderFetchError 且订单拉取失败时抛错、正常返回 allOrders 与 quotesMap
 */
import { describe, it, expect } from 'bun:test';
import { OrderSide, OrderStatus, OrderType, Period } from 'longbridge';
import { createLoadTradingDayRuntimeSnapshot } from '../../../src/main/lifecycle/loadTradingDayRuntimeSnapshot.js';
import { createSymbolRegistry } from '../../../src/services/autoSymbolManager/utils.js';
import { TRADING } from '../../../src/constants/index.js';
import { buildTrendFactorSnapshot } from '../../../src/services/factors/runtime/index.js';
import type {
  LoadTradingDayRuntimeSnapshotDeps,
  LoadTradingDayRuntimeSnapshotParams,
} from '../../../src/main/lifecycle/types.js';
import type { LastState } from '../../../src/types/state.js';
import type { RawOrderFromAPI } from '../../../src/types/services.js';
import type { ProtectiveLiquidationEpisodeTracker } from '../../../src/core/trader/protectiveLiquidationEpisodeTracker/types.js';
import { createStrategyRuntimeConfig } from '../../../mock/factories/configFactory.js';
import {
  createAccountSnapshotDouble,
  createDailyLossTrackerDouble,
  createMarketDataClientDouble,
  createStrategyRuntimeConfigDouble,
  createPositionCacheDouble,
  createProtectiveLiquidationEpisodeTrackerDouble,
  createTraderDouble,
} from '../../helpers/testDoubles.js';

const DEFAULT_LOAD_NOW = new Date('2026-02-25T03:00:00.000Z');

function getEntry(_key: string): undefined {
  return;
}

function getInFlight(_key: string): undefined {
  return;
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
    monitorState: {
      baseInstrumentSymbol: 'HSI.HK',
      monitorPrice: null,
      longPrice: null,
      shortPrice: null,
      signal: null,
      pendingSignals: [],
      lastMonitorSnapshot: null,
      lastCandlestickCacheVersion: null,
    },
    allTradingSymbols: new Set<string>(),
  };
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

function createFixtureCandlestick(timestampMs: number, basePrice: number) {
  return {
    open: basePrice,
    high: basePrice + 1,
    low: basePrice - 1,
    close: basePrice,
    volume: 1000,
    timestamp: new Date(timestampMs),
  };
}

function createMin1BarsForTradingDay(params: {
  readonly dayStartUtcMs: number;
  readonly basePrice: number;
  readonly count: number;
}): ReadonlyArray<ReturnType<typeof createFixtureCandlestick>> {
  return Array.from({ length: params.count }, (_value, index) =>
    createFixtureCandlestick(
      params.dayStartUtcMs + index * 60_000,
      params.basePrice + index * 0.01,
    ),
  );
}

function createHistoryReadyMarketDataClient(
  currentDayUtcIso: string = '2026-02-25T01:30:00.000Z',
  historicalMin1CandlesOverride?: ReadonlyArray<ReturnType<typeof createFixtureCandlestick>>,
): LoadTradingDayRuntimeSnapshotDeps['marketDataClient'] {
  const currentDayStartUtcMs = Date.parse(currentDayUtcIso);
  const currentDayMin1Candles = createMin1BarsForTradingDay({
    dayStartUtcMs: currentDayStartUtcMs,
    basePrice: 20_000,
    count: 60,
  });
  const historicalMin1Candles =
    historicalMin1CandlesOverride ??
    Array.from({ length: 20 }, (_value, index) =>
      createMin1BarsForTradingDay({
        dayStartUtcMs: currentDayStartUtcMs - (20 - index) * 24 * 60 * 60 * 1000,
        basePrice: 19_500 + index * 10,
        count: 330,
      }),
    ).flat();
  const currentDayHigherPeriodCandles = [createFixtureCandlestick(currentDayStartUtcMs, 20_000)];

  return createMarketDataClientDouble({
    subscribeCandlesticks: async (_symbol, period) => {
      if (period === Period.Min_1) {
        return currentDayMin1Candles as never;
      }

      return currentDayHigherPeriodCandles as never;
    },
    fetchHistoricalCandlesticksByOffset: async (_symbol, period, beforeTime, count) => {
      if (period !== Period.Min_1) {
        return [];
      }

      const beforeTimestamp = beforeTime?.getTime() ?? Number.POSITIVE_INFINITY;
      const eligible = historicalMin1Candles.filter(
        (candle) => candle.timestamp.getTime() < beforeTimestamp,
      );
      return eligible.slice(Math.max(eligible.length - count, 0)) as never;
    },
  });
}

function createBaseDeps(
  overrides: Partial<LoadTradingDayRuntimeSnapshotDeps> = {},
): LoadTradingDayRuntimeSnapshotDeps {
  const monitorConfig = overrides.monitorConfig ?? createStrategyRuntimeConfig();

  return {
    marketDataClient: overrides.marketDataClient ?? createHistoryReadyMarketDataClient(),
    trader: overrides.trader ?? createTraderDouble(),
    lastState: overrides.lastState ?? createMinimalLastState(),
    monitorConfig,
    symbolRegistry: overrides.symbolRegistry ?? createSymbolRegistry([monitorConfig]),
    dailyLossTracker: overrides.dailyLossTracker ?? createDailyLossTrackerDouble(),
    protectiveLiquidationEpisodeTracker:
      overrides.protectiveLiquidationEpisodeTracker ??
      createProtectiveLiquidationEpisodeTrackerDouble(),
    tradeLogHydrator: overrides.tradeLogHydrator ?? {
      hydrate: () => new Map<'LONG' | 'SHORT', number>(),
    },
    warrantListCacheConfig: overrides.warrantListCacheConfig ?? createWarrantListCacheConfig(),
  };
}

function buildLoadedFactorSnapshot(params: {
  readonly marketDataClient: LoadTradingDayRuntimeSnapshotDeps['marketDataClient'];
  readonly monitorConfig: LoadTradingDayRuntimeSnapshotDeps['monitorConfig'];
}): ReturnType<typeof buildTrendFactorSnapshot> {
  const min1Snapshot = params.marketDataClient.getCandlestickSnapshot('HSI.HK', Period.Min_1);
  const min5Snapshot = params.marketDataClient.getCandlestickSnapshot('HSI.HK', Period.Min_5);
  const min15Snapshot = params.marketDataClient.getCandlestickSnapshot('HSI.HK', Period.Min_15);
  const latestClose = Number(min1Snapshot?.candles.at(-1)?.close ?? 0);

  return buildTrendFactorSnapshot({
    candlesByPeriod: {
      min1: min1Snapshot?.candles ?? [],
      min5: min5Snapshot?.candles ?? [],
      min15: min15Snapshot?.candles ?? [],
    },
    currentPrice: latestClose,
    strategyConfig: params.monitorConfig.strategyConfig,
  });
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
    failOnOrderFetchError: false,
    resetRuntimeSubscriptions: false,
    hydrateCooldownFromTradeLog: false,
    forceOrderRefresh: false,
    ...overrides,
    now: overrides.now ?? DEFAULT_LOAD_NOW,
  };
}

function createProtectiveMonitor(): LoadTradingDayRuntimeSnapshotDeps['monitorConfig'] {
  return createStrategyRuntimeConfigDouble({
    baseInstrumentSymbol: 'HSI.HK',
    orderOwnershipMapping: ['HSI'],
  });
}

type ProtectiveOrderParams = Readonly<{
  orderId: string;
  status: RawOrderFromAPI['status'];
  price: number;
  quantity: number;
  executedPrice: number;
  executedQuantity: number;
  updatedAtMs: number;
}>;

function createProtectiveOrder(params: ProtectiveOrderParams): RawOrderFromAPI {
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
    submittedAt: new Date(params.updatedAtMs - 30_000),
    updatedAt: new Date(params.updatedAtMs),
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
    recalculateFromAllOrders: (_allOrders, _monitors, _now, protectionBoundaryByDirection) => {
      if (protectionBoundaryByDirection === undefined) {
        return;
      }

      onCapture(protectionBoundaryByDirection);
    },
  });
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
      getLatestProtectionBoundaryByDirection: () => new Map(boundaryByDirection),
      resetAll: () => {
        boundaryByDirection.clear();
      },
    }),
    restoreCompletedCalls,
    restoreInProgressCalls,
  };
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

  it('账户信息缺失（cachedAccount 为 null）时抛出"无法获取账户信息"', async () => {
    const deps = createBaseDeps({
      trader: createTraderDouble({
        getAccountSnapshot: async () => null,
        getStockPositions: async () => [],
      }),
    });

    const load = createLoadTradingDayRuntimeSnapshot(deps);

    expect(load(createLoadParams())).rejects.toThrow('无法获取账户信息');
  });

  it('持仓拉取异常时直接抛错，不再按空持仓继续初始化', async () => {
    const deps = createBaseDeps({
      trader: createTraderDouble({
        getAccountSnapshot: async () => createAccountSnapshotDouble(100_000),
        getStockPositions: async () => {
          throw new Error('positions api failed');
        },
      }),
    });

    const load = createLoadTradingDayRuntimeSnapshot(deps);

    expect(load(createLoadParams())).rejects.toThrow('positions api failed');
  });

  it('failOnOrderFetchError 为 true 且订单拉取失败时抛出带"全量订单获取失败"的错误', async () => {
    const deps = createBaseDeps({
      trader: createReadyTrader({
        fetchAllOrdersFromAPI: async () => {
          throw new Error('API 超时');
        },
      }),
    });

    const load = createLoadTradingDayRuntimeSnapshot(deps);

    expect(load(createLoadParams({ failOnOrderFetchError: true }))).rejects.toThrow(
      /全量订单获取失败/,
    );
  });

  it('load 阶段不再承担交易日历预热职责', async () => {
    const now = new Date('2026-02-25T03:00:00.000Z');
    let getTradingDaysCalls = 0;
    const lastState = createMinimalLastState();
    const marketDataClient = createHistoryReadyMarketDataClient('2026-02-25T01:30:00.000Z');
    marketDataClient.getTradingDays = async () => {
      getTradingDaysCalls += 1;
      return {
        tradingDays: [],
        halfTradingDays: [],
      };
    };

    const deps = createBaseDeps({
      lastState,
      marketDataClient,
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
    expect(lastState.tradingCalendarSnapshot).toBeUndefined();
  });

  it('subscribes candlesticks and leaves seeded local cache snapshots observable', async () => {
    const monitorConfig = createStrategyRuntimeConfigDouble({ baseInstrumentSymbol: 'HSI.HK' });
    const subscribedSymbols: string[] = [];
    const marketDataClient = createHistoryReadyMarketDataClient('2026-02-25T01:30:00.000Z');
    const originalSubscribe = marketDataClient.subscribeCandlesticks;
    marketDataClient.subscribeCandlesticks = async (symbol, period, tradeSessions) => {
      subscribedSymbols.push(symbol);
      return originalSubscribe(symbol, period, tradeSessions);
    };
    const deps = createBaseDeps({
      monitorConfig,
      marketDataClient,
      trader: createReadyTrader(),
    });

    const load = createLoadTradingDayRuntimeSnapshot(deps);
    await load(createLoadParams({ requireTradingDay: true }));

    expect(subscribedSymbols).toHaveLength(TRADING.CANDLE_PERIODS.length);
    expect(subscribedSymbols.every((symbol) => symbol === 'HSI.HK')).toBeTrue();
    expect(
      marketDataClient.getCandlestickSnapshot('HSI.HK', TRADING.FACTOR_CANDLE_PERIOD)?.initialized,
    ).toBe(true);
  });

  it('prewarms paged historical 1m baseline before completing load', async () => {
    let historicalFetchCalls = 0;
    const marketDataClient = createHistoryReadyMarketDataClient();
    const originalFetch = marketDataClient.fetchHistoricalCandlesticksByOffset;
    marketDataClient.fetchHistoricalCandlesticksByOffset = async (
      symbol,
      period,
      beforeTime,
      count,
      tradeSessions,
    ) => {
      historicalFetchCalls += 1;
      return originalFetch(symbol, period, beforeTime, count, tradeSessions);
    };

    const deps = createBaseDeps({
      marketDataClient,
      trader: createReadyTrader(),
    });

    const load = createLoadTradingDayRuntimeSnapshot(deps);
    await load(createLoadParams({ requireTradingDay: true }));

    const snapshot = marketDataClient.getCandlestickSnapshot('HSI.HK', Period.Min_1);
    expect(historicalFetchCalls).toBeGreaterThan(0);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.candles.length).toBeGreaterThanOrEqual(6_660);
  });

  it('uses non-default rvQuantileWindowDays as the historical readiness source', async () => {
    const currentDayUtcIso = '2026-02-25T05:00:00.000Z';
    const currentDayStartUtcMs = Date.parse(currentDayUtcIso);
    const now = new Date('2026-02-25T06:00:00.000Z');
    const historicalMin1Candles = Array.from({ length: 18 }, (_value, index) =>
      createMin1BarsForTradingDay({
        dayStartUtcMs: currentDayStartUtcMs - (18 - index) * 24 * 60 * 60 * 1000,
        basePrice: 19_500 + index * 10,
        count: 60,
      }),
    ).flat();
    const marketDataClient = createHistoryReadyMarketDataClient(
      currentDayUtcIso,
      historicalMin1Candles,
    );
    const baseMonitorConfig = createStrategyRuntimeConfigDouble();
    const monitorConfig = {
      ...baseMonitorConfig,
      strategyConfig: {
        ...baseMonitorConfig.strategyConfig,
        regimeThresholds: {
          ...baseMonitorConfig.strategyConfig.regimeThresholds,
          rvQuantileWindowDays: 18,
        },
      },
    };
    const deps = createBaseDeps({
      marketDataClient,
      monitorConfig,
      trader: createReadyTrader(),
    });

    const load = createLoadTradingDayRuntimeSnapshot(deps);
    await load(createLoadParams({ requireTradingDay: true, now }));

    const snapshot = buildLoadedFactorSnapshot({
      marketDataClient,
      monitorConfig,
    });
    expect(snapshot).not.toBeNull();
    expect(snapshot?.readiness.regimeReady).toBeTrue();
    expect(snapshot?.readiness.reasons).not.toContain('波动率基线未就绪');
  });

  it('keeps PM regime readiness aligned when a half-day enters the recent historical window', async () => {
    const currentDayUtcIso = '2026-02-25T05:00:00.000Z';
    const currentDayStartUtcMs = Date.parse(currentDayUtcIso);
    const now = new Date('2026-02-25T06:00:00.000Z');
    const historicalMin1Candles = [
      ...Array.from({ length: 20 }, (_value, index) =>
        createMin1BarsForTradingDay({
          dayStartUtcMs: currentDayStartUtcMs - (21 - index) * 24 * 60 * 60 * 1000,
          basePrice: 19_200 + index * 10,
          count: 60,
        }),
      ).flat(),
      ...createMin1BarsForTradingDay({
        dayStartUtcMs: currentDayStartUtcMs - 24 * 60 * 60 * 1000,
        basePrice: 19_500,
        count: 150,
      }),
    ].sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime());
    let historicalFetchCalls = 0;
    const marketDataClient = createHistoryReadyMarketDataClient(
      currentDayUtcIso,
      historicalMin1Candles,
    );
    const originalFetch = marketDataClient.fetchHistoricalCandlesticksByOffset;
    marketDataClient.fetchHistoricalCandlesticksByOffset = async (
      symbol,
      period,
      beforeTime,
      count,
      tradeSessions,
    ) => {
      historicalFetchCalls += 1;
      return originalFetch(symbol, period, beforeTime, count, tradeSessions);
    };
    const deps = createBaseDeps({
      marketDataClient,
      trader: createReadyTrader(),
    });

    const load = createLoadTradingDayRuntimeSnapshot(deps);
    await load(createLoadParams({ requireTradingDay: true, now }));

    const snapshot = buildLoadedFactorSnapshot({
      marketDataClient,
      monitorConfig: deps.monitorConfig,
    });
    expect(historicalFetchCalls).toBeGreaterThan(1);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.session).toBe('pm');
    expect(snapshot?.readiness.regimeReady).toBeTrue();
    expect(snapshot?.readiness.reasons).not.toContain('波动率基线未就绪');
  });

  it('throws when higher-period current-day seed is missing during trading session', async () => {
    const marketDataClient = createMarketDataClientDouble({
      subscribeCandlesticks: async (_symbol, period) => {
        if (period === Period.Min_1) {
          return createMin1BarsForTradingDay({
            dayStartUtcMs: Date.parse('2026-02-25T01:30:00.000Z'),
            basePrice: 20_000,
            count: 60,
          }) as never;
        }

        return [createFixtureCandlestick(Date.parse('2026-02-24T01:30:00.000Z'), 20_000)] as never;
      },
      fetchHistoricalCandlesticksByOffset: async (_symbol, period, beforeTime, count) => {
        if (period !== Period.Min_1) {
          return [];
        }

        const history = Array.from({ length: 20 }, (_value, index) =>
          createMin1BarsForTradingDay({
            dayStartUtcMs: Date.parse('2026-02-05T01:30:00.000Z') + index * 24 * 60 * 60 * 1000,
            basePrice: 19_500 + index * 10,
            count: 330,
          }),
        ).flat();
        const beforeTimestamp = beforeTime?.getTime() ?? Number.POSITIVE_INFINITY;
        const eligible = history.filter((candle) => candle.timestamp.getTime() < beforeTimestamp);
        return eligible.slice(Math.max(eligible.length - count, 0)) as never;
      },
    });
    const deps = createBaseDeps({
      marketDataClient,
      trader: createReadyTrader(),
    });

    const load = createLoadTradingDayRuntimeSnapshot(deps);
    expect(load(createLoadParams({ requireTradingDay: true }))).rejects.toThrow(
      '缺少当前交易日样本',
    );
  });

  it('hydrateCooldownFromTradeLog=true 时先 hydrate 再 recalculate', async () => {
    const now = new Date('2026-02-25T03:00:00.000Z');
    const callOrder: string[] = [];
    const allOrders: ReadonlyArray<RawOrderFromAPI> = [];

    const deps = createBaseDeps({
      trader: createReadyTrader({
        fetchAllOrdersFromAPI: async () => allOrders,
      }),
      dailyLossTracker: createDailyLossTrackerDouble({
        recalculateFromAllOrders: (receivedOrders, _monitors, _now, receivedSegments) => {
          callOrder.push('recalculate');
          expect(receivedOrders).toBe(allOrders);
          expect(receivedSegments).toBeInstanceOf(Map);
        },
      }),
      tradeLogHydrator: {
        hydrate: () => {
          callOrder.push('hydrate');
          return new Map<'LONG' | 'SHORT', number>();
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

    expect(callOrder).toEqual(['hydrate', 'recalculate']);
  });

  it('restores protective boundary from canceled protective order with executed quantity', async () => {
    const now = new Date('2026-03-13T03:00:00.000Z');
    const executedAtMs = Date.parse('2026-03-13T02:30:00.000Z');
    const monitor = createProtectiveMonitor();
    const lastState = createMinimalLastState();
    const { tracker, restoreCompletedCalls, restoreInProgressCalls } =
      createProtectiveTrackerRecorder();
    let receivedBoundaryMap: ReadonlyMap<'LONG' | 'SHORT', number> | undefined;

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
      marketDataClient: createHistoryReadyMarketDataClient('2026-03-13T01:30:00.000Z'),
      monitorConfig: monitor,
      trader: createReadyTrader({
        fetchAllOrdersFromAPI: async () => [protectiveOrder],
      }),
      dailyLossTracker: createBoundaryCaptureDailyLossTracker((protectionBoundaryByDirection) => {
        receivedBoundaryMap = protectionBoundaryByDirection;
      }),
      protectiveLiquidationEpisodeTracker: tracker,
      tradeLogHydrator: { hydrate: () => new Map<'LONG' | 'SHORT', number>() },
    });

    const load = createLoadTradingDayRuntimeSnapshot(deps);
    await load(createLoadParams({ now }));

    expect(restoreCompletedCalls).toHaveLength(1);
    expect(restoreCompletedCalls[0]).toEqual({
      direction: 'LONG',
      boundaryExecutedTimeMs: executedAtMs,
    });
    expect(restoreInProgressCalls).toHaveLength(0);
    expect(receivedBoundaryMap?.get('LONG')).toBe(executedAtMs);
  });

  it('restores in-progress protective episode for partial-filled pending order', async () => {
    const now = new Date('2026-03-13T03:00:00.000Z');
    const executedAtMs = Date.parse('2026-03-13T02:30:00.000Z');
    const monitor = createProtectiveMonitor();
    const lastState = createMinimalLastState();
    const { tracker, restoreCompletedCalls, restoreInProgressCalls } =
      createProtectiveTrackerRecorder();
    let receivedBoundaryMap: ReadonlyMap<'LONG' | 'SHORT', number> | undefined;

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
      marketDataClient: createHistoryReadyMarketDataClient('2026-03-13T01:30:00.000Z'),
      monitorConfig: monitor,
      trader: createReadyTrader({
        fetchAllOrdersFromAPI: async () => [protectiveOrder],
      }),
      dailyLossTracker: createBoundaryCaptureDailyLossTracker((protectionBoundaryByDirection) => {
        receivedBoundaryMap = protectionBoundaryByDirection;
      }),
      protectiveLiquidationEpisodeTracker: tracker,
      tradeLogHydrator: { hydrate: () => new Map<'LONG' | 'SHORT', number>() },
    });

    const load = createLoadTradingDayRuntimeSnapshot(deps);
    await load(createLoadParams({ now }));

    expect(restoreCompletedCalls).toHaveLength(0);
    expect(restoreInProgressCalls).toHaveLength(1);
    expect(restoreInProgressCalls[0]).toEqual({
      direction: 'LONG',
      latestExecutedTimeMs: executedAtMs,
    });
    expect(receivedBoundaryMap?.size).toBe(0);
  });

  it('restores completed boundary and in-progress episode together when both coexist in same direction', async () => {
    const now = new Date('2026-03-13T03:00:00.000Z');
    const completedBoundaryMs = Date.parse('2026-03-13T02:20:00.000Z');
    const pendingLatestExecutedMs = Date.parse('2026-03-13T02:30:00.000Z');
    const monitor = createProtectiveMonitor();
    const lastState = createMinimalLastState();
    const { tracker, restoreCompletedCalls, restoreInProgressCalls } =
      createProtectiveTrackerRecorder();
    let receivedBoundaryMap: ReadonlyMap<'LONG' | 'SHORT', number> | undefined;

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
      marketDataClient: createHistoryReadyMarketDataClient('2026-03-13T01:30:00.000Z'),
      monitorConfig: monitor,
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

    expect(restoreInProgressCalls).toEqual([
      {
        direction: 'LONG',
        latestExecutedTimeMs: pendingLatestExecutedMs,
      },
    ]);
    expect(receivedBoundaryMap?.get('LONG')).toBe(completedBoundaryMs);
  });

  it('advances restored completed boundary when a newer completed protective fill exists and direction is flat', async () => {
    const now = new Date('2026-03-13T03:00:00.000Z');
    const hydratedBoundaryMs = Date.parse('2026-03-13T02:20:00.000Z');
    const newerCompletedFillMs = Date.parse('2026-03-13T02:35:00.000Z');
    const monitor = createProtectiveMonitor();
    const lastState = createMinimalLastState();
    const { tracker, restoreCompletedCalls } = createProtectiveTrackerRecorder();
    let receivedBoundaryMap: ReadonlyMap<'LONG' | 'SHORT', number> | undefined;

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
      marketDataClient: createHistoryReadyMarketDataClient('2026-03-13T01:30:00.000Z'),
      monitorConfig: monitor,
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
        boundaryExecutedTimeMs: hydratedBoundaryMs,
      },
      {
        direction: 'LONG',
        boundaryExecutedTimeMs: newerCompletedFillMs,
      },
    ]);
    expect(receivedBoundaryMap?.get('LONG')).toBe(newerCompletedFillMs);
  });
});
