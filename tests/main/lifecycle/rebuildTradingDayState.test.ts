/**
 * 交易日状态重建单元测试
 *
 * 覆盖：
 * - 重建主链路（日历预热 → 风险缓存 → 恢复追踪 → 展示）
 * - 交易日历预热使用固定 fallback 窗口，并按自然月分块查询
 * - 预热失败时重建 fail-fast
 */
import { describe, it, expect } from 'bun:test';
import { LIFECYCLE, TIME } from '../../../src/constants/index.js';
import { createRebuildTradingDayState } from '../../../src/main/lifecycle/rebuildTradingDayState.js';
import { listHKDateKeysBetween } from '../../../src/main/lifecycle/utils.js';
import type { RebuildTradingDayStateDeps } from '../../../src/main/lifecycle/types.js';
import type { StrategyRuntime } from '../../../src/types/state.js';
import type { SymbolRegistry } from '../../../src/types/seat.js';
import type { Quote } from '../../../src/types/quote.js';
import { getHKDateKey } from '../../../src/utils/time/index.js';
import type {
  MarketDataClient,
  RawOrderFromAPI,
  Trader,
  TradingDaysResult,
} from '../../../src/types/services.js';
import {
  createPositionCacheDouble,
  createPositionDouble,
  createRiskCheckerDouble,
  createStrategyRuntimeConfigDouble,
  createStrategyRuntimeDouble,
} from '../../helpers/testDoubles.js';

const emptyQuotesMap = new Map<string, Quote | null>();
const emptyOrders: ReadonlyArray<RawOrderFromAPI> = [];
const emptySeatState = {
  symbol: null as string | null,
  status: 'EMPTY' as const,
  lastSwitchAt: null as number | null,
  lastSearchAt: null as number | null,
  lastSeatActivatedAt: null,
  searchFailCountToday: 0,
  frozenTradingDayKey: null as string | null,
};
function createMinimalLastState(): RebuildTradingDayStateDeps['lastState'] {
  return {
    tradingCalendarSnapshot: new Map(),
    cachedTradingDayInfo: null,
    cachedPositions: [],
    positionCache: createPositionCacheDouble(),
  } as unknown as RebuildTradingDayStateDeps['lastState'];
}

function createSymbolRegistry(
  seatStatus: 'ACTIVE' | 'EMPTY',
  symbol: string = 'BULL.HK',
): SymbolRegistry {
  const readySeatState =
    seatStatus === 'ACTIVE'
      ? {
          ...emptySeatState,
          symbol,
          status: 'ACTIVE' as const,
        }
      : emptySeatState;
  return {
    getSeatState: (direction: 'LONG' | 'SHORT') => {
      if (direction === 'LONG') {
        return readySeatState;
      }

      return emptySeatState;
    },
    getSeatVersion: () => 1,
    resolveSeatBySymbol: () => null,
    updateSeatState: (_direction: 'LONG' | 'SHORT') => readySeatState,
    bumpSeatVersion: () => 1,
  };
}

function createStrategyRuntime(params: {
  symbolRegistry: SymbolRegistry;
  baseInstrumentSymbol?: string;
  riskChecker?: StrategyRuntime['riskChecker'];
}): StrategyRuntime {
  const { symbolRegistry, baseInstrumentSymbol = 'HSI.HK', riskChecker } = params;
  return createStrategyRuntimeDouble({
    config: createStrategyRuntimeConfigDouble({
      baseInstrumentSymbol,
    }),
    symbolRegistry,
    riskChecker: riskChecker ?? createRiskCheckerDouble(),
  });
}

function createDefaultMarketDataClient(
  tradingDayCalls: Array<{ startDate: Date; endDate: Date }>,
): MarketDataClient {
  return {
    getTradingDays: async (startDate: Date, endDate: Date): Promise<TradingDaysResult> => {
      tradingDayCalls.push({ startDate, endDate });
      return {
        tradingDays: listHKDateKeysBetween(startDate.getTime(), endDate.getTime()),
        halfTradingDays: [],
      };
    },
    isTradingDay: async () => ({ isTradingDay: true, isHalfDay: false }),
  } as unknown as MarketDataClient;
}

function createRebuildDeps(
  overrides?: Partial<RebuildTradingDayStateDeps>,
): RebuildTradingDayStateDeps {
  const tradingDayCalls: Array<{ startDate: Date; endDate: Date }> = [];
  const trader: Trader = {
    recoverOrderTrackingFromSnapshot: async () => {},
  } as unknown as Trader;
  return {
    marketDataClient: createDefaultMarketDataClient(tradingDayCalls),
    trader,
    lastState: createMinimalLastState(),
    symbolRegistry: createSymbolRegistry('EMPTY'),
    monitorContext: createStrategyRuntime({
      symbolRegistry: createSymbolRegistry('EMPTY'),
    }),
    dailyLossTracker: {
      getLossOffset: () => 0,
    } as unknown as RebuildTradingDayStateDeps['dailyLossTracker'],
    displayAccountAndPositions: async () => {},
    ...overrides,
  };
}
describe('createRebuildTradingDayState', () => {
  it('无 ACTIVE 席位时仍调用 recoverOrderTrackingFromSnapshot 与 displayAccountAndPositions', async () => {
    let recoverCalled = false;
    let displayCalled = false;
    const registry = createSymbolRegistry('EMPTY');
    const monitorContext = createStrategyRuntime({
      symbolRegistry: registry,
    });
    const deps = createRebuildDeps({
      symbolRegistry: registry,
      trader: {
        recoverOrderTrackingFromSnapshot: async () => {
          recoverCalled = true;
        },
      } as unknown as Trader,
      displayAccountAndPositions: async () => {
        displayCalled = true;
      },
      monitorContext,
    });
    const rebuild = createRebuildTradingDayState(deps);
    await rebuild({ allOrders: emptyOrders, quotesMap: emptyQuotesMap });
    expect(recoverCalled).toBe(true);
    expect(displayCalled).toBe(true);
  });

  it('交易日历预热使用固定 fallback 窗口，不再回溯历史订单时间', async () => {
    const oldExecutedTime = new Date('2024-01-05T03:00:00.000Z').getTime();
    const now = new Date('2026-02-20T03:00:00.000Z');
    const tradingDayCalls: Array<{ startDate: Date; endDate: Date }> = [];
    const registry = createSymbolRegistry('ACTIVE');
    const monitorContext = createStrategyRuntime({
      symbolRegistry: registry,
    });
    const deps = createRebuildDeps({
      marketDataClient: createDefaultMarketDataClient(tradingDayCalls),
      symbolRegistry: registry,
      monitorContext,
    });
    const rebuild = createRebuildTradingDayState(deps);
    await rebuild({
      allOrders: [
        {
          orderId: 'HISTORY-001',
          symbol: 'BULL.HK',
          stockName: 'Bull',
          side: 'Buy',
          status: 'Filled',
          orderType: 'LO',
          price: 1,
          quantity: 100,
          executedPrice: 1,
          executedQuantity: 100,
          submittedAt: new Date(oldExecutedTime),
          updatedAt: new Date(oldExecutedTime),
        } as unknown as RawOrderFromAPI,
      ],
      quotesMap: emptyQuotesMap,
      now,
    });
    expect(tradingDayCalls.length).toBeGreaterThan(0);
    const earliestRequestedMs = Math.min(
      ...tradingDayCalls.map((call) => call.startDate.getTime()),
    );
    const expectedStartKey = getHKDateKey(
      new Date(
        now.getTime() -
          LIFECYCLE.CALENDAR_PREWARM_FALLBACK_LOOKBACK_DAYS * TIME.MILLISECONDS_PER_DAY,
      ),
    );
    expect(earliestRequestedMs).toBeGreaterThan(oldExecutedTime);
    expect(getHKDateKey(new Date(earliestRequestedMs))).toBe(expectedStartKey);
  });

  it('重建浮亏缓存时直接从 positionCache 读取席位持仓', async () => {
    const registry = createSymbolRegistry('ACTIVE');
    const refreshedPositions: Array<{
      symbol: string;
      quantity: number;
      isLongSymbol: boolean;
    }> = [];
    const monitorContext = createStrategyRuntime({
      symbolRegistry: registry,
      riskChecker: createRiskCheckerDouble({
        refreshUnrealizedLossData: async (symbol, position, isLongSymbol) => {
          refreshedPositions.push({
            symbol,
            quantity: position?.quantity ?? 0,
            isLongSymbol,
          });
          return null;
        },
      }),
    });
    const heldPosition = createPositionDouble({
      symbol: 'BULL.HK',
      quantity: 300,
      availableQuantity: 300,
    });
    const lastState = {
      ...createMinimalLastState(),
      cachedPositions: [heldPosition],
      positionCache: createPositionCacheDouble([heldPosition]),
    } as RebuildTradingDayStateDeps['lastState'];
    const deps = createRebuildDeps({
      symbolRegistry: registry,
      monitorContext,
      lastState,
    });
    const rebuild = createRebuildTradingDayState(deps);
    await rebuild({ allOrders: emptyOrders, quotesMap: emptyQuotesMap });
    expect(refreshedPositions).toEqual([
      {
        symbol: 'BULL.HK',
        quantity: 300,
        isLongSymbol: true,
      },
    ]);
  });

  it('交易日历查询会按自然月分块，不跨月请求', async () => {
    const now = new Date('2026-03-10T03:00:00.000Z');
    const tradingDayCalls: Array<{ startDate: Date; endDate: Date }> = [];
    const registry = createSymbolRegistry('ACTIVE');
    const monitorContext = createStrategyRuntime({
      symbolRegistry: registry,
    });
    const deps = createRebuildDeps({
      marketDataClient: createDefaultMarketDataClient(tradingDayCalls),
      symbolRegistry: registry,
      monitorContext,
    });
    const rebuild = createRebuildTradingDayState(deps);
    await rebuild({ allOrders: emptyOrders, quotesMap: emptyQuotesMap, now });
    expect(tradingDayCalls.length).toBeGreaterThan(1);
    for (const call of tradingDayCalls) {
      const startMonthKey = getHKDateKey(call.startDate).slice(0, 7);
      const endMonthKey = getHKDateKey(call.endDate).slice(0, 7);
      expect(startMonthKey).toBe(endMonthKey);
    }
  });

  it('交易日历预热只请求快照中缺失的日期', async () => {
    const now = new Date('2026-02-20T12:00:00.000Z');
    const tradingDayCalls: Array<{ startDate: Date; endDate: Date }> = [];
    const registry = createSymbolRegistry('ACTIVE');
    const monitorContext = createStrategyRuntime({
      symbolRegistry: registry,
    });
    const prewarmedDateKeys = listHKDateKeysBetween(
      now.getTime() - LIFECYCLE.CALENDAR_PREWARM_FALLBACK_LOOKBACK_DAYS * TIME.MILLISECONDS_PER_DAY,
      now.getTime() + LIFECYCLE.CALENDAR_PREWARM_LOOKAHEAD_DAYS * TIME.MILLISECONDS_PER_DAY,
    );
    const tradingCalendarSnapshot = new Map(
      prewarmedDateKeys.map((dateKey) => [dateKey, { isTradingDay: true, isHalfDay: false }]),
    );
    const deps = createRebuildDeps({
      marketDataClient: createDefaultMarketDataClient(tradingDayCalls),
      symbolRegistry: registry,
      monitorContext,
      lastState: {
        ...createMinimalLastState(),
        tradingCalendarSnapshot,
      } as RebuildTradingDayStateDeps['lastState'],
    });
    const rebuild = createRebuildTradingDayState(deps);
    await rebuild({ allOrders: emptyOrders, quotesMap: emptyQuotesMap, now });
    expect(tradingDayCalls.length).toBe(0);
  });

  it('浮亏缓存刷新抛错时同样抛出带 [Lifecycle] 重建交易日状态失败 前缀的错误', async () => {
    const registry = createSymbolRegistry('ACTIVE');
    const monitorContext = createStrategyRuntime({
      symbolRegistry: registry,
      riskChecker: createRiskCheckerDouble({
        refreshUnrealizedLossData: async () => {
          throw new Error('unrealized refresh fail');
        },
      }),
    });
    const deps = createRebuildDeps({
      symbolRegistry: registry,
      monitorContext,
    });
    const rebuild = createRebuildTradingDayState(deps);
    expect(rebuild({ allOrders: emptyOrders, quotesMap: emptyQuotesMap })).rejects.toThrow(
      /\[Lifecycle\] 重建交易日状态失败/,
    );
  });

  it('交易日历预热失败时，rebuildTradingDayState 会抛错', async () => {
    const registry = createSymbolRegistry('ACTIVE');
    const monitorContext = createStrategyRuntime({
      symbolRegistry: registry,
    });
    const deps = createRebuildDeps({
      marketDataClient: {
        getTradingDays: async () => {
          throw new Error('calendar api fail');
        },
      } as unknown as MarketDataClient,
      symbolRegistry: registry,
      monitorContext,
    });
    const rebuild = createRebuildTradingDayState(deps);
    expect(rebuild({ allOrders: emptyOrders, quotesMap: emptyQuotesMap })).rejects.toThrow(
      /\[Lifecycle\] 重建交易日状态失败/,
    );
  });

  it('displayAccountAndPositions 抛错时同样抛出带前缀的错误', async () => {
    const deps = createRebuildDeps({
      displayAccountAndPositions: async () => {
        throw new Error('display fail');
      },
    });
    const rebuild = createRebuildTradingDayState(deps);
    expect(rebuild({ allOrders: emptyOrders, quotesMap: emptyQuotesMap })).rejects.toThrow(
      /\[Lifecycle\] 重建交易日状态失败/,
    );
  });
});
