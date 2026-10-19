import {
  createTradeRuntimeDouble,
  createAccountSnapshotDouble,
  createSymbolRegistryDouble,
  createWarrantRiskRefreshDouble,
} from '../../helpers/testDoubles.js';
import { createRuntimeStateFixtures } from '../../helpers/runtimeStateFixtures.js';
import { spyOn, describe, expect, it } from 'bun:test';
import type { TradeRuntime } from '../../../src/app/runtime/types.js';
import type { RuntimeStateFixtures } from '../../helpers/types.js';

/**
 * 交易日状态重建单元测试
 *
 * 覆盖：
 * - 重建主链路（订单重建 → 日历预热 → 风险缓存 → 恢复追踪 → 展示）
 * - 交易日历预热按“仍持仓买单”确定起点，并按自然月分块查询
 * - 预热失败时重建 fail-fast
 */

import { createTerminationRuntime } from '../../../src/runtime/lifecycle/terminationRuntime.js';
import { TIME } from '../../../src/constants/index.js';
import { validateOrdersForRebuild } from '../../../src/domain/order/orderRecordPolicy.js';
import { createRebuildTradingDayState } from '../../../src/application/tradingDayRebuild/rebuildTradingDayState.js';
import {
  captureSeatActivationCarryover,
  clearSeatActivationCarryover,
} from '../../../src/application/tradingDayRebuild/seatActivationCarryover.js';
import type { RebuildTradingDayStateDeps } from '../../../src/application/tradingDayRebuild/types.js';
import type { MarketDataClient, TradingDaysResult } from '../../../src/types/marketPorts.js';
import type { Quote } from '../../../src/types/quote.js';
import type { SeatState, SymbolRegistry } from '../../../src/types/seat.js';
import type { OrderRecord } from '../../../src/types/orderRecorder.js';
import type { MonitorContextAssembly } from '../../../src/app/context/types.js';
import type { OrderFact } from '../../../src/types/trade.js';
import {
  getHKDateKey,
  getRequiredHKDateKey,
  listHKDateKeysBetween,
} from '../../../src/utils/time/index.js';

import { createBrokerIngressFixture } from '../../integration/architectureRefactoringP1Native/trade/brokerIngressFixture.js';
import { createSnapshotFixture } from '../../helpers/accountPositionSnapshot.js';

/** 使用实际 native query mapper 生成订单观察；不由 domain 解析 SDK phase。 */
async function readNativeOrder(
  input: Parameters<typeof createBrokerIngressFixture>[0],
): Promise<OrderFact> {
  const ingress = await createBrokerIngressFixture(input);
  return ingress.queryObservation;
}

const emptyQuotesMap = new Map<string, Quote | null>();
const emptyOrders: ReadonlyArray<OrderFact> = [];
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
function createMinimalRuntimeStates(): RuntimeStateFixtures {
  return createRuntimeStateFixtures({ lifecycleState: { isTradingEnabled: false } });
}

function createSymbolRegistry(
  seatStatus: 'ACTIVE' | 'EMPTY',
  symbol: string = 'BULL.HK',
): SymbolRegistry {
  return createSymbolRegistryDouble({
    longSeat:
      seatStatus === 'ACTIVE'
        ? { ...emptySeatState, symbol, status: 'ACTIVE', lastSeatActivatedAt: 1 }
        : emptySeatState,
    shortSeat: emptySeatState,
  });
}

function createBuyOrder(executedTime: number, symbol: string): OrderRecord {
  return {
    orderId: `BUY-${executedTime}`,
    symbol,
    costAmount: '100',
    executedQuantity: 100,
    executedTime,
  };
}

function createMonitorContext(params: {
  symbolRegistry: SymbolRegistry;
  monitorSymbol?: string;
  buyOrders?: ReadonlyArray<OrderRecord>;
  onCommitBatch?: MonitorContextAssembly['orderRecorder']['commitRebuildSnapshot'];
}): MonitorContextAssembly {
  const { symbolRegistry, monitorSymbol = 'HSI.HK', buyOrders = [], onCommitBatch } = params;
  const context = {
    config: { monitorSymbol },
    symbolRegistry,
    orderRecorder: {
      validateRebuildSnapshot: (symbol: string, allOrders: ReadonlyArray<OrderFact>) => {
        validateOrdersForRebuild(allOrders.filter((order) => order.symbol === symbol));
      },
      commitRebuildSnapshot: ((targets, allOrders, isCurrent, mode) => {
        expect(mode).toBe('REBUILD');
        for (const target of targets) {
          validateOrdersForRebuild(allOrders.filter((order) => order.symbol === target.symbol));
        }

        if (!isCurrent()) return { status: 'ABORTED' };

        return (
          onCommitBatch?.(targets, allOrders, isCurrent, mode) ?? {
            status: 'COMMITTED',
            receipts: [],
          }
        );
      }) satisfies MonitorContextAssembly['orderRecorder']['commitRebuildSnapshot'],
      getBuyOrdersForSymbol: () => buyOrders,
    },
    riskChecker: {
      setWarrantInfoFromCallPrice: () => ({ status: 'ok' as const }),
      prepareUnrealizedLossData: ((recorder, symbol, _isLongSymbol, dailyLossOffset) => {
        expect(recorder).toBe(context.orderRecorder);
        expect(dailyLossOffset).toBe('0');
        return { symbol, data: { r1: '0', n1: 0 } };
      }) satisfies MonitorContextAssembly['riskChecker']['prepareUnrealizedLossData'],
      publishUnrealizedLossData: ((
        _prepared,
      ) => {}) satisfies MonitorContextAssembly['riskChecker']['publishUnrealizedLossData'],
    },
  } as unknown as MonitorContextAssembly;
  return context;
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

async function createRebuildDeps(
  overrides?: Partial<RebuildTradingDayStateDeps>,
): Promise<RebuildTradingDayStateDeps> {
  const tradingDayCalls: Array<{ startDate: Date; endDate: Date }> = [];
  const tradeRuntime = createTradeRuntimeDouble();
  return {
    termination: createTerminationRuntime({
      closeTradingGate: () => {},
      closeProducerAdmission: () => {},
      stopProducers: [],
      onSecondaryError: () => {},
    }),
    marketDataClient: createDefaultMarketDataClient(tradingDayCalls),
    warrantRiskRefresh: createWarrantRiskRefreshDouble(),
    orderMonitor: tradeRuntime.orderMonitor,
    ...createMinimalRuntimeStates(),
    snapshot: await createSnapshotFixture({
      account: createAccountSnapshotDouble('100000'),
      positions: [],
    }),
    symbolRegistry: createSymbolRegistry('EMPTY'),
    monitorContext: createMonitorContext({
      symbolRegistry: createSymbolRegistry('EMPTY'),
    }),
    dailyLossTracker: {
      getLossOffset: () => '0',
    } as unknown as RebuildTradingDayStateDeps['dailyLossTracker'],
    displayAccountAndPositions: () => {},
    ...overrides,
  };
}
describe('createRebuildTradingDayState', () => {
  it.each(['seat', 'snapshot', 'stop'] as const)(
    'maps late warrant INVALIDATED from original %s authorization without retry, risk publish or ACTIVE',
    async (invalidatedBy) => {
      const registry = createSymbolRegistryDouble({
        longSeat: { ...emptySeatState, symbol: 'BULL.HK', status: 'ACTIVATING' },
        shortSeat: emptySeatState,
      });
      const context = createMonitorContext({ symbolRegistry: registry });
      const queryIssued = Promise.withResolvers<undefined>();
      const readCompleted = Promise.withResolvers<undefined>();
      let refreshCalls = 0;
      let riskPrepares = 0;
      let trackingCalls = 0;
      let displayCalls = 0;
      const termination = createTerminationRuntime({
        closeTradingGate: () => {},
        closeProducerAdmission: () => {},
        stopProducers: [],
        onSecondaryError: () => {},
      });
      const prepareRisk = context.riskChecker.prepareUnrealizedLossData;
      spyOn(context.riskChecker, 'prepareUnrealizedLossData').mockImplementation((...args) => {
        riskPrepares += 1;
        return prepareRisk(...args);
      });
      const deps = await createRebuildDeps({
        termination,
        symbolRegistry: registry,
        monitorContext: context,
        warrantRiskRefresh: createWarrantRiskRefreshDouble({
          refreshWarrantInfoForSymbol: async (_symbol, _isLong, isCurrent) => {
            refreshCalls += 1;
            expect(isCurrent()).toBeTrue();
            queryIssued.resolve();
            await readCompleted.promise;
            expect(isCurrent()).toBeFalse();
            return { status: 'INVALIDATED' };
          },
        }),
        orderMonitor: {
          recoverOrderTrackingFromSnapshot: async () => {
            trackingCalls += 1;
          },
        } as unknown as TradeRuntime['orderMonitor'],
        displayAccountAndPositions: () => {
          displayCalls += 1;
        },
      });
      const pending = createRebuildTradingDayState(deps)({
        snapshotToken: deps.snapshot.getView().token,
        allOrders: emptyOrders,
        quotesMap: emptyQuotesMap,
        now: REBUILD_TEST_NOW,
      });
      await queryIssued.promise;
      if (invalidatedBy === 'seat') {
        registry.updateSeatStateWithVersionBump('LONG', {
          ...emptySeatState,
          status: 'ACTIVATING',
          symbol: 'NEW_BULL.HK',
        });
      } else if (invalidatedBy === 'snapshot') {
        deps.snapshot.invalidate();
      } else {
        termination.requestShutdown();
      }

      readCompleted.resolve();
      expect(await pending).toEqual({
        status: invalidatedBy === 'stop' ? 'ABORTED' : 'SUPERSEDED',
      });
      expect(refreshCalls).toBe(1);
      expect(riskPrepares).toBe(0);
      expect(trackingCalls).toBe(0);
      expect(displayCalls).toBe(0);
      expect(registry.getSeatState('LONG').status).toBe('ACTIVATING');
      expect(termination.getFatalState().hasFatalError).toBeFalse();
    },
  );

  it('commits both captured directions once in REBUILD mode, then prepares both before publishing without changing the snapshot', async () => {
    const registry = createSymbolRegistryDouble({
      longSeat: { ...emptySeatState, symbol: 'BULL.HK', status: 'ACTIVATING' },
      shortSeat: { ...emptySeatState, symbol: 'BEAR.HK', status: 'ACTIVATING' },
    });
    let commitCalls = 0;
    const context = createMonitorContext({
      symbolRegistry: registry,
      onCommitBatch: (targets, allOrders, isCurrent, mode) => {
        expect(targets.map(({ symbol, isLongSymbol }) => ({ symbol, isLongSymbol }))).toEqual([
          { symbol: 'BULL.HK', isLongSymbol: true },
          { symbol: 'BEAR.HK', isLongSymbol: false },
        ]);
        expect(allOrders).toBe(emptyOrders);
        expect(isCurrent()).toBe(true);
        expect(mode).toBe('REBUILD');
        commitCalls += 1;
        return { status: 'COMMITTED', receipts: [] };
      },
    });
    const trace: string[] = [];
    const prepare = context.riskChecker.prepareUnrealizedLossData;
    spyOn(context.riskChecker, 'prepareUnrealizedLossData').mockImplementation((...args) => {
      trace.push(`prepare:${args[1]}`);
      return prepare(...args);
    });

    spyOn(context.riskChecker, 'publishUnrealizedLossData').mockImplementation((prepared) => {
      trace.push(`publish:${prepared.symbol}`);
    });
    const deps = await createRebuildDeps({ symbolRegistry: registry, monitorContext: context });
    const snapshotToken = deps.snapshot.getView().token;
    await createRebuildTradingDayState(deps)({
      snapshotToken,
      allOrders: emptyOrders,
      quotesMap: emptyQuotesMap,
      now: REBUILD_TEST_NOW,
    });
    expect(commitCalls).toBe(1);
    expect(trace).toEqual([
      'prepare:BULL.HK',
      'prepare:BEAR.HK',
      'publish:BULL.HK',
      'publish:BEAR.HK',
    ]);
    expect(deps.snapshot.getView().token).toEqual(snapshotToken);
    expect(registry.getSeatState('LONG').status).toBe('ACTIVE');
    expect(registry.getSeatState('SHORT').status).toBe('ACTIVE');
  });

  it('SHORT invalid execution fails the whole preflight before any commit, prepare, publish, tracking or ACTIVE write', async () => {
    const registry = createSymbolRegistryDouble({
      longSeat: { ...emptySeatState, symbol: 'BULL.HK', status: 'ACTIVATING' },
      shortSeat: { ...emptySeatState, symbol: 'BEAR.HK', status: 'ACTIVATING' },
    });
    const sideEffects: string[] = [];
    const context = createMonitorContext({
      symbolRegistry: registry,
      onCommitBatch: () => {
        sideEffects.push('commit');
        return { status: 'COMMITTED', receipts: [] };
      },
    });
    const prepare = context.riskChecker.prepareUnrealizedLossData;
    spyOn(context.riskChecker, 'prepareUnrealizedLossData').mockImplementation((...args) => {
      sideEffects.push('prepare');
      return prepare(...args);
    });

    spyOn(context.riskChecker, 'publishUnrealizedLossData').mockImplementation(() => {
      sideEffects.push('publish');
    });
    const deps = await createRebuildDeps({
      symbolRegistry: registry,
      monitorContext: context,
      orderMonitor: {
        recoverOrderTrackingFromSnapshot: async () => {
          sideEffects.push('tracking');
        },
      } as unknown as TradeRuntime['orderMonitor'],
      displayAccountAndPositions: () => {
        sideEffects.push('display');
      },
    });
    const executionTimeMs = Date.parse('2026-03-13T02:00:00.000Z');
    expect(
      createRebuildTradingDayState(deps)({
        snapshotToken: deps.snapshot.getView().token,
        allOrders: [
          {
            ...(await readNativeOrder({
              orderId: 'INVALID-SHORT-EXECUTION',
              tradeId: 'INVALID-SHORT-EXECUTION' + '-trade',
              symbol: 'BEAR.HK',
              stockName: 'Bear',
              remark: '',
              side: 'BUY',
              status: 'Filled',
              submittedPrice: '1',
              quantity: '100',
              executedPrice: '1',
              executedQuantity: '100',
              submittedAtMs: new Date(executionTimeMs - 30_000).getTime(),
              executionTimeMs,
              updatedAtMs: executionTimeMs + 30_000,
            })),
            executedPrice: '0',
            executedAmount: '0',
          },
        ],
        quotesMap: emptyQuotesMap,
        now: REBUILD_TEST_NOW,
      }),
    ).rejects.toThrow('[订单记录] 金额、数量或执行时间无效');
    expect(sideEffects).toEqual([]);
    expect(registry.getSeatState('LONG').status).toBe('ACTIVATING');
    expect(registry.getSeatState('SHORT').status).toBe('ACTIVATING');
  });

  it('无 ACTIVE 席位时仍调用 recoverOrderTrackingFromSnapshot 与 displayAccountAndPositions', async () => {
    let recoverCalled = false;
    let displayCalled = false;
    const registry = createSymbolRegistry('EMPTY');
    const monitorContext = createMonitorContext({
      symbolRegistry: registry,
    });
    const deps = await createRebuildDeps({
      symbolRegistry: registry,
      orderMonitor: {
        recoverOrderTrackingFromSnapshot: async () => {
          recoverCalled = true;
        },
      } as unknown as TradeRuntime['orderMonitor'],
      displayAccountAndPositions: () => {
        displayCalled = true;
      },
      monitorContext,
    });
    const rebuild = createRebuildTradingDayState(deps);
    const snapshotToken = deps.snapshot.getView().token;
    await rebuild({
      snapshotToken,
      allOrders: emptyOrders,
      quotesMap: emptyQuotesMap,
      now: REBUILD_TEST_NOW,
    });
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
    const deps = await createRebuildDeps({
      marketDataClient: createDefaultMarketDataClient(tradingDayCalls),
      symbolRegistry: registry,
      monitorContext,
    });
    const rebuild = createRebuildTradingDayState(deps);
    const snapshotToken = deps.snapshot.getView().token;
    await rebuild({
      snapshotToken,
      allOrders: [
        await readNativeOrder({
          orderId: 'HISTORY-001',
          tradeId: 'HISTORY-001' + '-trade',
          symbol: 'BULL.HK',
          stockName: 'Bull',
          remark: '',
          side: 'BUY',
          status: 'Filled',
          submittedPrice: '1',
          quantity: '100',
          executedPrice: '1',
          executedQuantity: '100',
          submittedAtMs: new Date(oldExecutedTime).getTime(),
          executionTimeMs: oldExecutedTime,
          updatedAtMs: oldExecutedTime,
        }),
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
    const stateFixtures = createMinimalRuntimeStates();
    const deps = await createRebuildDeps({
      marketDataClient: createDefaultMarketDataClient(tradingDayCalls),
      symbolRegistry: registry,
      monitorContext,
      ...stateFixtures,
    });
    const rebuild = createRebuildTradingDayState(deps);
    const snapshotToken = deps.snapshot.getView().token;
    await rebuild({
      snapshotToken,
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
      expect(stateFixtures.tradingCalendarState.tradingCalendarSnapshot.has(oldOrderDateKey)).toBe(
        true,
      );
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
    const deps = await createRebuildDeps({
      marketDataClient: createDefaultMarketDataClient(tradingDayCalls),
      symbolRegistry: registry,
      monitorContext,
    });
    const rebuild = createRebuildTradingDayState(deps);
    const snapshotToken = deps.snapshot.getView().token;
    await rebuild({ snapshotToken, allOrders: emptyOrders, quotesMap: emptyQuotesMap, now });
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
    const deps = await createRebuildDeps({
      marketDataClient: createDefaultMarketDataClient(tradingDayCalls),
      symbolRegistry: registry,
      monitorContext,
    });
    const rebuild = createRebuildTradingDayState(deps);
    const snapshotToken = deps.snapshot.getView().token;
    let caughtError: unknown = null;
    try {
      await rebuild({ snapshotToken, allOrders: emptyOrders, quotesMap: emptyQuotesMap, now });
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(Error);
    if (!(caughtError instanceof Error))
      throw new Error('Expected actual calendar boundary rejection');

    expect(caughtError.message).toBe('[交易日历快照] 预热窗口超出接口最近一年限制，重建已阻断');
    expect(tradingDayCalls).toHaveLength(0);
  });

  it('rebuildOrderRecords 内部错误保持原始 identity', async () => {
    const failure = new Error('order batch commit fail');
    const registry = createSymbolRegistry('ACTIVE');
    const monitorContext = createMonitorContext({
      symbolRegistry: registry,
      onCommitBatch: () => {
        throw failure;
      },
    });
    const deps = await createRebuildDeps({
      symbolRegistry: registry,
      monitorContext,
    });
    const rebuild = createRebuildTradingDayState(deps);
    const snapshotToken = deps.snapshot.getView().token;
    expect(
      rebuild({
        snapshotToken,
        allOrders: emptyOrders,
        quotesMap: emptyQuotesMap,
        now: REBUILD_TEST_NOW,
      }),
    ).rejects.toBe(failure);
  });

  it('正成交事实无效时在席位激活、恢复追踪和展示前阻断 open rebuild', async () => {
    let activationWrites = 0;
    let recoverOrderTrackingCalls = 0;
    let displayCalls = 0;
    const registry = createSymbolRegistry('ACTIVE');
    const updateSeatState = registry.updateSeatState;
    spyOn(registry, 'updateSeatState').mockImplementation((direction, nextState) => {
      if (nextState.status === 'ACTIVE') {
        activationWrites += 1;
      }

      updateSeatState(direction, nextState);
    });
    const monitorContext = createMonitorContext({
      symbolRegistry: registry,
    });
    const malformedPositiveExecution: OrderFact = {
      ...(await readNativeOrder({
        orderId: 'INVALID-OPEN-REBUILD-EXECUTION',
        tradeId: 'INVALID-OPEN-REBUILD-EXECUTION' + '-trade',
        symbol: 'BULL.HK',
        stockName: 'Bull',
        remark: '',
        side: 'BUY',
        status: 'Filled',
        submittedPrice: '1',
        quantity: '100',
        executedPrice: '1',
        executedQuantity: '100',
        submittedAtMs: new Date('2026-03-13T02:00:00.000Z').getTime(),
        executionTimeMs: Date.parse('2026-03-13T02:01:00.000Z'),
        updatedAtMs: Date.parse('2026-03-13T02:01:30.000Z'),
      })),
      executedPrice: '0',
      executedAmount: '0',
    };
    const deps = await createRebuildDeps({
      symbolRegistry: registry,
      monitorContext,
      orderMonitor: {
        recoverOrderTrackingFromSnapshot: async () => {
          recoverOrderTrackingCalls += 1;
        },
      } as unknown as TradeRuntime['orderMonitor'],
      displayAccountAndPositions: () => {
        displayCalls += 1;
      },
    });
    const rebuild = createRebuildTradingDayState(deps);
    const snapshotToken = deps.snapshot.getView().token;

    let caughtError: unknown = null;
    try {
      await rebuild({
        snapshotToken,
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

    expect(caughtError.message).toBe('[订单记录] 金额、数量或执行时间无效');
    expect(activationWrites).toBe(0);
    expect(recoverOrderTrackingCalls).toBe(0);
    expect(displayCalls).toBe(0);
  });

  for (const unknownSideCase of [
    {
      label: 'Filled with positive execution',
      status: 'Filled',
      executedPrice: '1',
      executedAmount: '100',
      executedQuantity: 100,
    },
    {
      label: 'PartialFilled with zero execution',
      status: 'PartialFilled',
      executedPrice: '0',
      executedAmount: '0',
      executedQuantity: 0,
    },
  ] as const) {
    it(`Unknown-side ${unknownSideCase.label} blocks open rebuild before activation, recovery, and display`, async () => {
      let activationWrites = 0;
      let recoverOrderTrackingCalls = 0;
      let displayCalls = 0;
      const registry = createSymbolRegistry('ACTIVE');
      const updateSeatState = registry.updateSeatState;
      spyOn(registry, 'updateSeatState').mockImplementation((direction, nextState) => {
        if (nextState.status === 'ACTIVE') {
          activationWrites += 1;
        }

        updateSeatState(direction, nextState);
      });
      const monitorContext = createMonitorContext({
        symbolRegistry: registry,
      });
      const ingress = await createBrokerIngressFixture({
        orderId: `UNKNOWN-OPEN-REBUILD-${unknownSideCase.label}`,
        tradeId: `UNKNOWN-TRADE-${unknownSideCase.label}`,
        symbol: 'BULL.HK',
        stockName: 'Bull',
        remark: '',
        side: 'BUY',
        status: unknownSideCase.status,
        submittedPrice: '1',
        quantity: '100',
        executedPrice: unknownSideCase.executedPrice,
        executedQuantity: String(unknownSideCase.executedQuantity),
        executionTimeMs: Date.parse('2026-03-13T02:01:00.000Z'),
        updatedAtMs: Date.parse('2026-03-13T02:01:30.000Z'),
        submittedAtMs: Date.parse('2026-03-13T02:00:00.000Z'),
      });
      const query = ingress.createQueryOrdersReader();
      ingress.setQuerySideUnknown();
      expect(ingress.nativeReadCounts().detail).toBe(0);
      let queryFailure: unknown = null;
      let rebuildCalls = 0;
      const deps = await createRebuildDeps({
        symbolRegistry: registry,
        monitorContext,
        orderMonitor: {
          recoverOrderTrackingFromSnapshot: async () => {
            recoverOrderTrackingCalls += 1;
          },
        } as unknown as TradeRuntime['orderMonitor'],
        displayAccountAndPositions: () => {
          displayCalls += 1;
        },
      });
      const rebuild = createRebuildTradingDayState(deps);
      const snapshotToken = deps.snapshot.getView().token;

      let caughtError: unknown = null;
      try {
        let allOrders: ReadonlyArray<OrderFact>;
        try {
          allOrders = await query();
        } catch (error) {
          queryFailure = error;
          throw error;
        }

        rebuildCalls += 1;
        await rebuild({
          snapshotToken,
          allOrders,
          quotesMap: emptyQuotesMap,
          now: REBUILD_TEST_NOW,
        });
      } catch (error) {
        caughtError = error;
      }

      const rebuildWasBlocked =
        caughtError instanceof Error &&
        caughtError === queryFailure &&
        caughtError.message === '[orderMapper] unknown SDK execution side';

      expect(ingress.nativeReadCounts()).toEqual({ cancel: 0, detail: 1 });
      expect(ingress.nativeMutations()).toEqual([]);
      expect(rebuildCalls).toBe(0);
      expect(caughtError).toBe(queryFailure);
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

  it('交易日历预热内部错误保持原始 identity', async () => {
    const failure = new Error('calendar api fail');
    const registry = createSymbolRegistry('ACTIVE');
    const monitorContext = createMonitorContext({
      symbolRegistry: registry,
      buyOrders: [
        createBuyOrder(REBUILD_TEST_NOW.getTime() - 2 * TIME.MILLISECONDS_PER_DAY, 'BULL.HK'),
      ],
    });
    const deps = await createRebuildDeps({
      marketDataClient: {
        getTradingDays: async () => {
          throw failure;
        },
      } as unknown as MarketDataClient,
      symbolRegistry: registry,
      monitorContext,
    });
    const rebuild = createRebuildTradingDayState(deps);
    const snapshotToken = deps.snapshot.getView().token;
    expect(
      rebuild({
        snapshotToken,
        allOrders: emptyOrders,
        quotesMap: emptyQuotesMap,
        now: REBUILD_TEST_NOW,
      }),
    ).rejects.toBe(failure);
  });

  it('displayAccountAndPositions 内部错误保持原始 identity', async () => {
    const failure = new Error('display fail');
    const deps = await createRebuildDeps({
      displayAccountAndPositions: () => {
        throw failure;
      },
    });
    const rebuild = createRebuildTradingDayState(deps);
    const snapshotToken = deps.snapshot.getView().token;
    expect(
      rebuild({
        snapshotToken,
        allOrders: emptyOrders,
        quotesMap: emptyQuotesMap,
        now: REBUILD_TEST_NOW,
      }),
    ).rejects.toBe(failure);
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
    const deps = await createRebuildDeps({
      symbolRegistry: registry,
      monitorContext,
    });
    const rebuild = createRebuildTradingDayState(deps);
    const snapshotToken = deps.snapshot.getView().token;

    await rebuild({
      snapshotToken,
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
    const deps = await createRebuildDeps({
      symbolRegistry: registry,
      monitorContext,
    });
    const rebuild = createRebuildTradingDayState(deps);
    const snapshotToken = deps.snapshot.getView().token;

    await rebuild({
      snapshotToken,
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
    const deps = await createRebuildDeps({
      symbolRegistry: registry,
      monitorContext,
    });
    const rebuild = createRebuildTradingDayState(deps);
    const snapshotToken = deps.snapshot.getView().token;

    await rebuild({
      snapshotToken,
      allOrders: emptyOrders,
      quotesMap: emptyQuotesMap,
      now: rebuildNow,
    });

    expect(registry.getSeatState('LONG').lastSeatActivatedAt).toBe(carriedActivatedAt);
    clearSeatActivationCarryover(registry);
  });
});
