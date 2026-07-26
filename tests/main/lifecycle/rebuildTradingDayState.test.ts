/**
 * 交易日状态重建单元测试
 *
 * 覆盖：
 * - 重建主链路（订单重建 → 日历预热 → 风险缓存 → 恢复追踪 → 展示）
 * - 交易日历预热按“仍持仓买单”确定起点，并按自然月分块查询
 * - 预热失败时重建 fail-fast
 */
import { describe, it, expect } from 'bun:test';
import { OrderSide, OrderStatus, OrderType } from 'longbridge';
import { TIME } from '../../../src/constants/index.js';
import {
  captureSeatActivationCarryover,
  clearSeatActivationCarryover,
} from '../../../src/main/lifecycle/seatActivationCarryover.js';
import { createRebuildTradingDayState } from '../../../src/main/lifecycle/rebuildTradingDayState.js';
import { listHKDateKeysBetween } from '../../../src/main/lifecycle/utils.js';
import { classifyOrdersForRebuild } from '../../../src/core/orderRecorder/utils.js';
import type { RebuildTradingDayStateDeps } from '../../../src/main/lifecycle/types.js';
import type { MonitorContext } from '../../../src/types/state.js';
import type { SeatState, SymbolRegistry } from '../../../src/types/seat.js';
import type { Quote } from '../../../src/types/quote.js';
import { getHKDateKey, getRequiredHKDateKey } from '../../../src/utils/time/index.js';
import type {
  MarketDataClient,
  OrderRecord,
  RawOrderFromAPI,
  Trader,
  TradingDaysResult,
} from '../../../src/types/services.js';
import { createSymbolRegistryDouble } from '../../helpers/testDoubles.js';

const emptyQuotesMap = new Map<string, Quote | null>();
const emptyOrders: ReadonlyArray<RawOrderFromAPI> = [];
const REBUILD_TEST_NOW = new Date('2026-03-13T02:00:00.000Z');
const emptySeatState: SeatState = {
  symbol: null,
  status: 'EMPTY',
  lastSwitchAt: null as number | null,
  lastSearchAt: null as number | null,
  lastSeatActivatedAt: null,
  callPrice: null,
  searchFailCountToday: 0,
  frozenTradingDayKey: null as string | null,
};
function createMinimalLastState(): RebuildTradingDayStateDeps['lastState'] {
  return {
    tradingCalendarSnapshot: new Map(),
    cachedTradingDayInfo: null,
  } as unknown as RebuildTradingDayStateDeps['lastState'];
}

function createSymbolRegistry(
  seatStatus: 'ACTIVE' | 'EMPTY',
  symbol: string = 'BULL.HK',
): SymbolRegistry {
  let readySeatState: SeatState =
    seatStatus === 'ACTIVE'
      ? {
          symbol,
          status: 'ACTIVE' as const,
          lastSwitchAt: null,
          lastSearchAt: null,
          lastSeatActivatedAt: 1,
          callPrice: null,
          searchFailCountToday: 0,
          frozenTradingDayKey: null,
        }
      : emptySeatState;
  return {
    getSeatState: (_direction: 'LONG' | 'SHORT') => readySeatState,
    getSeatVersion: () => 1,
    resolveSeatBySymbol: () => null,
    updateSeatState: (_direction: 'LONG' | 'SHORT', nextState: SeatState) => {
      readySeatState = nextState;
      return readySeatState;
    },
    updateSeatStateWithVersionBump: (_direction: 'LONG' | 'SHORT', nextState: SeatState) => {
      readySeatState = nextState;
      return { seatState: readySeatState, seatVersion: 2 };
    },
    onSeatStateChanged: () => () => {},
    onSeatTruthChanged: () => {
      throw new Error('rebuildTradingDayState test must not subscribe to seat truth events');
    },
  };
}

function createBuyOrder(executedTime: number, symbol: string): OrderRecord {
  return {
    orderId: `BUY-${executedTime}`,
    symbol,
    executedPrice: 1,
    executedQuantity: 100,
    executedTime,
    submittedAt: new Date(executedTime),
    updatedAt: new Date(executedTime),
  };
}

function createMonitorContext(params: {
  symbolRegistry: SymbolRegistry;
  monitorSymbol?: string;
  buyOrders?: ReadonlyArray<OrderRecord>;
  onRefreshLong?: (
    symbol: string,
    allOrders: ReadonlyArray<RawOrderFromAPI>,
    quote?: Quote | null,
  ) => Promise<ReadonlyArray<OrderRecord>>;
}): MonitorContext {
  const {
    symbolRegistry,
    monitorSymbol = 'HSI.HK',
    buyOrders = [],
    onRefreshLong = async () => [],
  } = params;
  return {
    config: { monitorSymbol },
    symbolRegistry,
    orderRecorder: {
      refreshOrdersFromAllOrdersForLong: onRefreshLong,
      refreshOrdersFromAllOrdersForShort: async () => [],
      getBuyOrdersForSymbol: () => buyOrders,
    },
    riskChecker: {
      setWarrantInfoFromCallPrice: () => ({ status: 'ok' as const }),
      refreshWarrantInfoForSymbol: async () => ({ status: 'ok' as const }),
      refreshUnrealizedLossData: async () => {},
    },
  } as unknown as MonitorContext;
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
    monitorContext: createMonitorContext({
      symbolRegistry: createSymbolRegistry('EMPTY'),
    }),
    dailyLossTracker: {
      getLossOffset: () => 0,
    } as unknown as RebuildTradingDayStateDeps['dailyLossTracker'],
    displayAccountAndPositions: () => {},
    ...overrides,
  };
}
describe('createRebuildTradingDayState', () => {
  it('无 ACTIVE 席位时仍调用 recoverOrderTrackingFromSnapshot 与 displayAccountAndPositions', async () => {
    let recoverCalled = false;
    let displayCalled = false;
    const registry = createSymbolRegistry('EMPTY');
    const monitorContext = createMonitorContext({
      symbolRegistry: registry,
    });
    const deps = createRebuildDeps({
      symbolRegistry: registry,
      trader: {
        recoverOrderTrackingFromSnapshot: async () => {
          recoverCalled = true;
        },
      } as unknown as Trader,
      displayAccountAndPositions: () => {
        displayCalled = true;
      },
      monitorContext,
    });
    const rebuild = createRebuildTradingDayState(deps);
    await rebuild({ allOrders: emptyOrders, quotesMap: emptyQuotesMap, now: REBUILD_TEST_NOW });
    expect(recoverCalled).toBe(true);
    expect(displayCalled).toBe(true);
  });

  it('仅存在已平仓历史订单时，预热起点不会回溯到历史订单时间', async () => {
    const oldExecutedTime = new Date('2024-01-05T03:00:00.000Z').getTime();
    const now = new Date('2026-02-20T03:00:00.000Z');
    const tradingDayCalls: Array<{ startDate: Date; endDate: Date }> = [];
    const registry = createSymbolRegistry('ACTIVE');
    const monitorContext = createMonitorContext({
      symbolRegistry: registry,
      buyOrders: [],
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
    expect(earliestRequestedMs).toBeGreaterThan(oldExecutedTime);
  });

  it('存在仍持仓老单时，预热起点回溯到该老单成交时间', async () => {
    const oldOpenOrderTime = new Date('2025-12-15T03:00:00.000Z').getTime();
    const tradingDayCalls: Array<{ startDate: Date; endDate: Date }> = [];
    const registry = createSymbolRegistry('ACTIVE');
    const monitorContext = createMonitorContext({
      symbolRegistry: registry,
      buyOrders: [createBuyOrder(oldOpenOrderTime, 'BULL.HK')],
    });
    const lastState = createMinimalLastState();
    const deps = createRebuildDeps({
      marketDataClient: createDefaultMarketDataClient(tradingDayCalls),
      symbolRegistry: registry,
      monitorContext,
      lastState,
    });
    const rebuild = createRebuildTradingDayState(deps);
    await rebuild({
      allOrders: emptyOrders,
      quotesMap: emptyQuotesMap,
      now: new Date('2026-02-20T03:00:00.000Z'),
    });
    expect(tradingDayCalls.length).toBeGreaterThan(0);
    const earliestRequestedMs = Math.min(
      ...tradingDayCalls.map((call) => call.startDate.getTime()),
    );
    expect(earliestRequestedMs).toBeLessThanOrEqual(oldOpenOrderTime);
    const oldOrderDateKey = getHKDateKey(new Date(oldOpenOrderTime));
    expect(oldOrderDateKey).not.toBeNull();
    if (oldOrderDateKey) {
      expect(lastState.tradingCalendarSnapshot.has(oldOrderDateKey)).toBe(true);
    }
  });

  it('交易日历查询会按自然月分块，不跨月请求', async () => {
    const openOrderTime = new Date('2025-11-15T03:00:00.000Z').getTime();
    const now = new Date('2026-02-20T03:00:00.000Z');
    const tradingDayCalls: Array<{ startDate: Date; endDate: Date }> = [];
    const registry = createSymbolRegistry('ACTIVE');
    const monitorContext = createMonitorContext({
      symbolRegistry: registry,
      buyOrders: [createBuyOrder(openOrderTime, 'BULL.HK')],
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
      const startMonthKey = getRequiredHKDateKey(call.startDate).slice(0, 7);
      const endMonthKey = getRequiredHKDateKey(call.endDate).slice(0, 7);
      expect(startMonthKey).toBe(endMonthKey);
    }
  });

  it('最近一年边界按毫秒判断，同日更早时刻也应判定为超限', async () => {
    const now = new Date('2026-02-20T12:00:00.000Z');
    const earliestAllowedMs = now.getTime() - 365 * TIME.MILLISECONDS_PER_DAY;
    const openOrderTime = earliestAllowedMs - 60 * 60 * 1000;
    const tradingDayCalls: Array<{ startDate: Date; endDate: Date }> = [];
    const registry = createSymbolRegistry('ACTIVE');
    const monitorContext = createMonitorContext({
      symbolRegistry: registry,
      buyOrders: [createBuyOrder(openOrderTime, 'BULL.HK')],
    });
    const deps = createRebuildDeps({
      marketDataClient: createDefaultMarketDataClient(tradingDayCalls),
      symbolRegistry: registry,
      monitorContext,
    });
    const rebuild = createRebuildTradingDayState(deps);
    let caughtError: unknown = null;
    try {
      await rebuild({ allOrders: emptyOrders, quotesMap: emptyQuotesMap, now });
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(Error);
    expect((caughtError as Error).message).toMatch(/\[Lifecycle\] 重建交易日状态失败/);
    expect(tradingDayCalls.length).toBe(0);
  });

  it('rebuildOrderRecords 中抛错时抛出带 [Lifecycle] 重建交易日状态失败 前缀的错误', async () => {
    const registry = createSymbolRegistry('ACTIVE');
    const monitorContext = createMonitorContext({
      symbolRegistry: registry,
      onRefreshLong: async () => {
        throw new Error('order refresh fail');
      },
    });
    const deps = createRebuildDeps({
      symbolRegistry: registry,
      monitorContext,
    });
    const rebuild = createRebuildTradingDayState(deps);
    expect(
      rebuild({ allOrders: emptyOrders, quotesMap: emptyQuotesMap, now: REBUILD_TEST_NOW }),
    ).rejects.toThrow(/\[Lifecycle\] 重建交易日状态失败/);
  });

  it('正成交事实无效时在席位激活、恢复追踪和展示前阻断 open rebuild', async () => {
    let activationWrites = 0;
    let recoverOrderTrackingCalls = 0;
    let displayCalls = 0;
    const registry = createSymbolRegistry('ACTIVE');
    const updateSeatState = registry.updateSeatState;
    registry.updateSeatState = (direction, nextState) => {
      if (nextState.status === 'ACTIVE') {
        activationWrites += 1;
      }

      return updateSeatState(direction, nextState);
    };
    const monitorContext = createMonitorContext({
      symbolRegistry: registry,
      onRefreshLong: async (_symbol, allOrders) =>
        classifyOrdersForRebuild(allOrders).executedBuyOrders,
    });
    const malformedPositiveExecution: RawOrderFromAPI = {
      orderId: 'INVALID-OPEN-REBUILD-EXECUTION',
      symbol: 'BULL.HK',
      stockName: 'Bull',
      side: OrderSide.Buy,
      status: OrderStatus.Filled,
      orderType: OrderType.ELO,
      price: 1,
      quantity: 100,
      executedPrice: 0,
      executedQuantity: 100,
      submittedAt: new Date('2026-03-13T02:00:00.000Z'),
      updatedAt: new Date('2026-03-13T02:01:00.000Z'),
    };
    const rebuild = createRebuildTradingDayState(
      createRebuildDeps({
        symbolRegistry: registry,
        monitorContext,
        trader: {
          recoverOrderTrackingFromSnapshot: async () => {
            recoverOrderTrackingCalls += 1;
          },
        } as unknown as Trader,
        displayAccountAndPositions: () => {
          displayCalls += 1;
        },
      }),
    );

    let caughtError: unknown = null;
    try {
      await rebuild({
        allOrders: [malformedPositiveExecution],
        quotesMap: emptyQuotesMap,
        now: REBUILD_TEST_NOW,
      });
    } catch (error) {
      caughtError = error;
    }

    if (!(caughtError instanceof Error)) {
      throw new Error('expected malformed execution fact to block open rebuild');
    }

    expect(caughtError.message).toMatch(/\[Lifecycle\] 重建交易日状态失败/);
    expect(activationWrites).toBe(0);
    expect(recoverOrderTrackingCalls).toBe(0);
    expect(displayCalls).toBe(0);
  });

  for (const unknownSideCase of [
    {
      label: 'Filled with positive execution',
      status: OrderStatus.Filled,
      executedPrice: 1,
      executedQuantity: 100,
    },
    {
      label: 'PartialFilled with zero execution',
      status: OrderStatus.PartialFilled,
      executedPrice: 0,
      executedQuantity: 0,
    },
  ]) {
    it(`Unknown-side ${unknownSideCase.label} blocks open rebuild before activation, recovery, and display`, async () => {
      let activationWrites = 0;
      let recoverOrderTrackingCalls = 0;
      let displayCalls = 0;
      const registry = createSymbolRegistry('ACTIVE');
      const updateSeatState = registry.updateSeatState;
      registry.updateSeatState = (direction, nextState) => {
        if (nextState.status === 'ACTIVE') {
          activationWrites += 1;
        }

        return updateSeatState(direction, nextState);
      };
      const monitorContext = createMonitorContext({
        symbolRegistry: registry,
        onRefreshLong: async (_symbol, allOrders) =>
          classifyOrdersForRebuild(allOrders).executedBuyOrders,
      });
      const unknownSideOrder: RawOrderFromAPI = {
        orderId: `UNKNOWN-OPEN-REBUILD-${unknownSideCase.label}`,
        symbol: 'BULL.HK',
        stockName: 'Bull',
        side: OrderSide.Unknown,
        status: unknownSideCase.status,
        orderType: OrderType.ELO,
        price: 1,
        quantity: 100,
        executedPrice: unknownSideCase.executedPrice,
        executedQuantity: unknownSideCase.executedQuantity,
        submittedAt: new Date('2026-03-13T02:00:00.000Z'),
        updatedAt: new Date('2026-03-13T02:01:00.000Z'),
      };
      const rebuild = createRebuildTradingDayState(
        createRebuildDeps({
          symbolRegistry: registry,
          monitorContext,
          trader: {
            recoverOrderTrackingFromSnapshot: async () => {
              recoverOrderTrackingCalls += 1;
            },
          } as unknown as Trader,
          displayAccountAndPositions: () => {
            displayCalls += 1;
          },
        }),
      );

      let caughtError: unknown = null;
      try {
        await rebuild({
          allOrders: [unknownSideOrder],
          quotesMap: emptyQuotesMap,
          now: REBUILD_TEST_NOW,
        });
      } catch (error) {
        caughtError = error;
      }

      const rebuildWasBlocked =
        caughtError instanceof Error &&
        caughtError.message.includes('[Lifecycle] 重建交易日状态失败');

      expect({
        rebuildWasBlocked,
        activationWrites,
        recoverOrderTrackingCalls,
        displayCalls,
      }).toEqual({
        rebuildWasBlocked: true,
        activationWrites: 0,
        recoverOrderTrackingCalls: 0,
        displayCalls: 0,
      });
    });
  }

  it('交易日历预热失败时，rebuildTradingDayState 会抛错', async () => {
    const registry = createSymbolRegistry('ACTIVE');
    const monitorContext = createMonitorContext({
      symbolRegistry: registry,
      buyOrders: [
        createBuyOrder(REBUILD_TEST_NOW.getTime() - 2 * TIME.MILLISECONDS_PER_DAY, 'BULL.HK'),
      ],
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
    expect(
      rebuild({ allOrders: emptyOrders, quotesMap: emptyQuotesMap, now: REBUILD_TEST_NOW }),
    ).rejects.toThrow(/\[Lifecycle\] 重建交易日状态失败/);
  });

  it('displayAccountAndPositions 抛错时同样抛出带前缀的错误', async () => {
    const deps = createRebuildDeps({
      displayAccountAndPositions: () => {
        throw new Error('display fail');
      },
    });
    const rebuild = createRebuildTradingDayState(deps);
    expect(
      rebuild({ allOrders: emptyOrders, quotesMap: emptyQuotesMap, now: REBUILD_TEST_NOW }),
    ).rejects.toThrow(/\[Lifecycle\] 重建交易日状态失败/);
  });

  it('open rebuild 恢复出同一 symbol 时保留前一交易日的 lastSeatActivatedAt', async () => {
    const carriedActivatedAt = Date.parse('2026-02-16T07:59:00.000Z');
    const rebuildNow = new Date('2026-02-17T01:31:00.000Z');
    const registry = createSymbolRegistryDouble({
      longSeat: {
        ...emptySeatState,
        symbol: 'OLD_BULL.HK',
        status: 'ACTIVE',
        lastSeatActivatedAt: carriedActivatedAt,
      },
      shortSeat: emptySeatState,
    });
    captureSeatActivationCarryover({ symbolRegistry: registry });

    registry.updateSeatState('LONG', {
      ...emptySeatState,
      symbol: 'OLD_BULL.HK',
      status: 'ACTIVATING',
      lastSeatActivatedAt: null,
    });

    const monitorContext = createMonitorContext({
      symbolRegistry: registry,
    });
    const rebuild = createRebuildTradingDayState(
      createRebuildDeps({
        symbolRegistry: registry,
        monitorContext,
      }),
    );

    await rebuild({
      allOrders: emptyOrders,
      quotesMap: emptyQuotesMap,
      now: rebuildNow,
    });

    expect(registry.getSeatState('LONG').lastSeatActivatedAt).toBe(carriedActivatedAt);
    clearSeatActivationCarryover(registry);
  });

  it('open rebuild 恢复出新 symbol 时重置为本次重建激活时间', async () => {
    const carriedActivatedAt = Date.parse('2026-02-16T07:59:00.000Z');
    const rebuildNow = new Date('2026-02-17T01:31:00.000Z');
    const registry = createSymbolRegistryDouble({
      longSeat: {
        ...emptySeatState,
        symbol: 'OLD_BULL.HK',
        status: 'ACTIVE',
        lastSeatActivatedAt: carriedActivatedAt,
      },
      shortSeat: emptySeatState,
    });
    captureSeatActivationCarryover({ symbolRegistry: registry });

    registry.updateSeatState('LONG', {
      ...emptySeatState,
      symbol: 'NEW_BULL.HK',
      status: 'ACTIVATING',
      lastSeatActivatedAt: null,
    });

    const monitorContext = createMonitorContext({
      symbolRegistry: registry,
    });
    const rebuild = createRebuildTradingDayState(
      createRebuildDeps({
        symbolRegistry: registry,
        monitorContext,
      }),
    );

    await rebuild({
      allOrders: emptyOrders,
      quotesMap: emptyQuotesMap,
      now: rebuildNow,
    });

    expect(registry.getSeatState('LONG').lastSeatActivatedAt).toBe(rebuildNow.getTime());
    expect(registry.getSeatState('LONG').lastSeatActivatedAt).not.toBe(carriedActivatedAt);

    clearSeatActivationCarryover(registry);
  });

  it('跨多个非交易日等待 open rebuild 时仍保留旧 carryover，后续同 symbol rebuild 继续使用原激活时间', async () => {
    const carriedActivatedAt = Date.parse('2026-02-16T07:59:00.000Z');
    const rebuildNow = new Date('2026-02-18T01:31:00.000Z');
    const registry = createSymbolRegistryDouble({
      longSeat: {
        ...emptySeatState,
        symbol: 'OLD_BULL.HK',
        status: 'ACTIVE',
        lastSeatActivatedAt: carriedActivatedAt,
      },
      shortSeat: emptySeatState,
    });
    captureSeatActivationCarryover({ symbolRegistry: registry });

    registry.updateSeatState('LONG', {
      ...emptySeatState,
      status: 'EMPTY',
      symbol: null,
      lastSeatActivatedAt: null,
    });

    captureSeatActivationCarryover({ symbolRegistry: registry });

    captureSeatActivationCarryover({ symbolRegistry: registry });

    registry.updateSeatState('LONG', {
      ...emptySeatState,
      symbol: 'OLD_BULL.HK',
      status: 'ACTIVATING',
      lastSeatActivatedAt: null,
    });

    const monitorContext = createMonitorContext({
      symbolRegistry: registry,
    });
    const rebuild = createRebuildTradingDayState(
      createRebuildDeps({
        symbolRegistry: registry,
        monitorContext,
      }),
    );

    await rebuild({
      allOrders: emptyOrders,
      quotesMap: emptyQuotesMap,
      now: rebuildNow,
    });

    expect(registry.getSeatState('LONG').lastSeatActivatedAt).toBe(carriedActivatedAt);
    clearSeatActivationCarryover(registry);
  });
});
