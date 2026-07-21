/**
 * doomsday 集成测试
 *
 * 功能：
 * - 验证末日保护端到端场景与业务期望。
 */
import { afterEach, describe, expect, it, mock, setSystemTime } from 'bun:test';
import { OrderSide, OrderStatus, OrderType } from 'longbridge';
import * as longbridgeModule from 'longbridge';

import { createTradingConfig } from '../../mock/factories/configFactory.js';
import { createSignal } from '../../mock/factories/signalFactory.js';
import { createStockPositionsResponse } from '../../mock/factories/tradeFactory.js';
import { createTradeContextMock } from '../../mock/longbridge/tradeContextMock.js';
import { createDoomsdayProtection } from '../../src/core/doomsdayProtection/index.js';
import { createOrderExecutor as createOrderExecutorCore } from '../../src/core/trader/orderExecutor/index.js';
import { timeWakeupEvaluationProgram } from '../../src/main/timeWakeupEvaluationProgram/index.js';
import type { TrackOrderParams, TraderDeps } from '../../src/core/trader/types.js';
import type { DoomsdayClearanceCommand } from '../../src/types/signal.js';
import type { MarketDataClient, Trader } from '../../src/types/services.js';
import type { TimeWakeupEvaluationContext } from '../../src/main/timeWakeupEvaluationProgram/types.js';
import type { CancelOrderOutcome } from '../../src/types/trader.js';
import { createExternalApiRequestError } from '../helpers/createExternalApiRequestError.js';
import { initMonitorState } from '../../src/utils/helpers/index.js';
import { getRequiredHKDateKey } from '../../src/utils/time/index.js';

import type { LastState, MonitorContext } from '../../src/types/state.js';

import {
  createAccountSnapshotDouble,
  createAutoSymbolManagerDouble,
  createDailyLossTrackerDouble,
  createDelayedSignalVerifierDouble,
  createIndicatorUsageProfileDouble,
  createMarketDataClientDouble,
  createMonitorConfigDouble,
  createMonitorContextDouble,
  createOrderMonitorDouble,
  createOrderRecorderDouble,
  createPositionCacheDouble,
  createPositionDouble,
  createProtectiveLiquidationEpisodeTrackerDouble,
  createQuoteSubscriptionRuntimeDouble,
  createQuoteDouble,
  createRateLimiterDouble,
  createRiskCheckerDouble,
  createStrategyDouble,
  createSymbolRegistryDouble,
  createTradeContextDouble,
  createTraderDouble,
  createUnrealizedLossMonitorDouble,
} from '../helpers/testDoubles.js';

type TraderModuleShape = Readonly<{
  createTrader: (deps: TraderDeps) => Promise<Trader>;
}>;

const alwaysLive = (): boolean => true;

type OrderExecutorTestDeps = Omit<
  Parameters<typeof createOrderExecutorCore>[0],
  'unrealizedLossBuyGate'
> &
  Partial<Pick<Parameters<typeof createOrderExecutorCore>[0], 'unrealizedLossBuyGate'>>;

function createOrderExecutor(deps: OrderExecutorTestDeps) {
  return createOrderExecutorCore({
    unrealizedLossBuyGate: createRiskCheckerDouble(),
    ...deps,
  });
}

/** 创建末日清仓提交路径可在 permit 内读取的显式终态行情。 */
function createDoomsdayExecutionQuoteClient() {
  return createMarketDataClientDouble({
    getQuotes: async (symbols) =>
      new Map([...symbols].map((symbol) => [symbol, createQuoteDouble(symbol, 1.1, 100)])),
  });
}

function isTraderModuleShape(value: unknown): value is TraderModuleShape {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'createTrader') === 'function'
  );
}

async function loadCreateTraderWithStubbedTradeContext(
  suffix: string,
  tradeContextFactory: Readonly<{ new: () => object }>,
): Promise<TraderModuleShape['createTrader']> {
  void mock.module('longbridge', () => ({
    ...longbridgeModule,
    TradeContext: tradeContextFactory,
  }));

  const modulePath = `../../src/core/trader/index.js?doomsday-clearance-${suffix}`;
  const traderModule: unknown = await import(modulePath);
  if (!isTraderModuleShape(traderModule)) {
    throw new TypeError('expected createTrader module export');
  }

  return traderModule.createTrader;
}

async function createRealDoomsdayTrader(params: {
  readonly suffix: string;
  readonly tradeContext: ReturnType<typeof createTradeContextMock>;
  readonly tradingConfig: ReturnType<typeof createTradingConfig>;
  readonly marketDataClient: MarketDataClient;
  readonly symbolRegistry: MonitorContext['symbolRegistry'];
  readonly now: () => Date;
  readonly isExecutionAllowed?: () => boolean;
}): Promise<Trader> {
  const createTrader = await loadCreateTraderWithStubbedTradeContext(params.suffix, {
    new: () => createTradeContextDouble(params.tradeContext),
  });

  return createTrader({
    config: { refreshAccessToken: () => Promise.resolve('') },
    tradingConfig: params.tradingConfig,
    marketDataClient: params.marketDataClient,
    unrealizedLossBuyGate: createRiskCheckerDouble(),
    symbolRegistry: params.symbolRegistry,
    dailyLossTracker: createDailyLossTrackerDouble(),
    protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
    persistProtectiveLiquidationExecutionProgress: () => {},
    postTradeConsistencyRuntime: {
      recordSettlementRefreshNeed: () => {},
    },
    isExecutionAllowed: params.isExecutionAllowed ?? (() => true),
    isContinuousTradingAllowed: () => true,
    onFatalError: (error) => {
      throw error;
    },
    now: params.now,
    readCurrentTradingDayInfo: () => {
      const currentTime = params.now();
      return {
        dateKey: getRequiredHKDateKey(currentTime),
        info: { isTradingDay: true, isHalfDay: false },
      };
    },
  });
}

function createLastState(): LastState {
  return {
    canTrade: true,
    isHalfDay: false,
    openProtectionActive: false,
    currentDayKey: '2026-02-16',
    lifecycleState: 'ACTIVE',
    pendingOpenRebuild: false,
    targetTradingDayKey: null,
    isTradingEnabled: true,
    cachedAccount: createAccountSnapshotDouble(100_000),
    cachedPositions: [
      createPositionDouble({ symbol: 'BULL.HK', quantity: 500, availableQuantity: 500 }),
      createPositionDouble({ symbol: 'BEAR.HK', quantity: 300, availableQuantity: 300 }),
    ],
    positionCache: createPositionCacheDouble([
      createPositionDouble({ symbol: 'BULL.HK', quantity: 500, availableQuantity: 500 }),
      createPositionDouble({ symbol: 'BEAR.HK', quantity: 300, availableQuantity: 300 }),
    ]),
    cachedTradingDayInfo: null,
    tradingCalendarSnapshot: new Map(),
    monitorState: initMonitorState(createMonitorConfigDouble()),
    allTradingSymbols: new Set(['BULL.HK', 'BEAR.HK']),
  };
}

function createMonitorContext(
  config = createMonitorConfigDouble(),
  orderRecorder = createOrderRecorderDouble(),
): MonitorContext {
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
  });

  return createMonitorContextDouble({
    config,
    state: {
      monitorSymbol: config.monitorSymbol,
      lastMonitorSnapshot: null,
      incrementalIndicatorRuntime: null,
    },
    symbolRegistry,
    autoSymbolManager: createAutoSymbolManagerDouble(),
    strategy: createStrategyDouble(),
    orderRecorder,
    dailyLossTracker: createDailyLossTrackerDouble(),
    riskChecker: createRiskCheckerDouble(),
    unrealizedLossMonitor: createUnrealizedLossMonitorDouble(),
    delayedSignalVerifier: createDelayedSignalVerifierDouble(),
    longSymbolName: 'BULL.HK',
    shortSymbolName: 'BEAR.HK',
    monitorSymbolName: config.monitorSymbol,
    indicatorProfile: createIndicatorUsageProfileDouble(),
  });
}

function createDoomsdayClearanceCommand(triggerTime: Date): DoomsdayClearanceCommand {
  return {
    symbol: 'BULL.HK',
    symbolName: 'BULL.HK',
    action: 'SELLCALL',
    triggerTime,
    seatVersion: 1,
  } satisfies DoomsdayClearanceCommand;
}

function createTerminalCancelOutcome(params: {
  readonly closedReason: 'FILLED' | 'CANCELED';
  readonly submittedQuantity: number;
  readonly executedQuantity: number;
}): CancelOrderOutcome {
  return {
    kind: 'ALREADY_CLOSED',
    closedReason: params.closedReason,
    source: 'API_ERROR',
    relatedBuyOrderIds: ['OLD-BUY'],
    terminalExecution: {
      submittedQuantity: params.submittedQuantity,
      executedQuantity: params.executedQuantity,
    },
  };
}

afterEach(() => {
  mock.restore();
  void mock.module('longbridge', () => ({ ...longbridgeModule }));
});

describe('doomsday integration', () => {
  it('routes valid close-5 clearance through the dedicated Trader entry to OrderExecutor submission', async () => {
    const currentTime = new Date('2026-02-16T07:56:00.000Z');
    const monitorConfig = createMonitorConfigDouble();
    const tradingConfig = createTradingConfig({ monitor: monitorConfig });
    const monitorContext = createMonitorContext(monitorConfig);
    const tradeContext = createTradeContextMock();
    tradeContext.seedStockPositions(
      createStockPositionsResponse({
        symbol: 'BULL.HK',
        quantity: 100,
        availableQuantity: 100,
      }),
    );
    const marketDataClient = createMarketDataClientDouble({
      getQuotes: async () => new Map([['BULL.HK', createQuoteDouble('BULL.HK', 1.1, 100)]]),
    });
    const trader = await createRealDoomsdayTrader({
      suffix: 'valid-close-5',
      tradeContext,
      tradingConfig,
      marketDataClient,
      symbolRegistry: monitorContext.symbolRegistry,
      now: () => currentTime,
    });
    const lastState = createLastState();
    const position = createPositionDouble({
      symbol: 'BULL.HK',
      quantity: 100,
      availableQuantity: 100,
    });
    lastState.cachedPositions = [position];
    lastState.positionCache.update(lastState.cachedPositions);

    setSystemTime(currentTime);
    try {
      const result = await createDoomsdayProtection({ now: () => currentTime }).executeClearance({
        currentTime,
        isHalfDay: false,
        isLive: alwaysLive,
        positions: lastState.cachedPositions,
        monitorContext,
        trader,
        marketDataClient,
        lastState,
      });

      expect(result).toEqual({ executed: true, nextRetryAtMs: null });
      const submitPayload = tradeContext.getCalls('submitOrder')[0]?.args[0];
      if (typeof submitPayload !== 'object' || submitPayload === null) {
        throw new TypeError('expected OrderExecutor to submit the clearance order');
      }

      expect(tradeContext.getCalls('submitOrder')).toHaveLength(1);
      expect(Reflect.get(submitPayload, 'side')).toBe(OrderSide.Sell);
      expect(Number(String(Reflect.get(submitPayload, 'submittedQuantity')))).toBe(100);
    } finally {
      setSystemTime();
    }
  });

  it('attributes a legal pre-takeover SWITCHING old-symbol holding to doomsday clearance', async () => {
    const currentTime = new Date('2026-02-16T07:55:00.000Z');
    const monitorContext = createMonitorContext();
    monitorContext.symbolRegistry.updateSeatStateWithVersionBump('LONG', {
      status: 'SWITCHING',
      symbol: 'BULL.HK',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    });
    const switchingMonitorContext: MonitorContext = {
      ...monitorContext,
      autoSymbolManager: {
        ...monitorContext.autoSymbolManager,
        hasPendingSwitch: () => true,
      },
    };
    const lastState = createLastState();
    const bullPosition = createPositionDouble({
      symbol: 'BULL.HK',
      quantity: 500,
      availableQuantity: 500,
    });
    lastState.cachedPositions = [bullPosition];
    lastState.positionCache.update(lastState.cachedPositions);
    const submittedCommands: ReadonlyArray<unknown>[] = [];
    const trader = createTraderDouble({
      executeDoomsdayClearanceSignals: async (commands) => {
        submittedCommands.push([...commands]);
        return {
          executedOrderIds: ['DOOMSDAY-SWITCHING-OLD'],
          awaitingAuthoritativeTerminalSymbols: [],
          unresolvedQuoteSymbols: [],
        };
      },
    });

    const result = await createDoomsdayProtection({ now: () => currentTime }).executeClearance({
      currentTime,
      isHalfDay: false,
      isLive: alwaysLive,
      positions: lastState.cachedPositions,
      monitorContext: switchingMonitorContext,
      trader,
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () => new Map([['BULL.HK', createQuoteDouble('BULL.HK', 1.1, 100)]]),
      }),
      lastState,
    });

    expect(result).toEqual({ executed: true, nextRetryAtMs: null });
    expect(submittedCommands).toEqual([
      [
        expect.objectContaining({
          symbol: 'BULL.HK',
          action: 'SELLCALL',
          seatVersion: switchingMonitorContext.symbolRegistry.getSeatVersion('LONG'),
        }),
      ],
    ]);
  });

  it('waits for an authoritative terminal without repeated cancellation, then submits the fresh unlinked doomsday ELO', async () => {
    const currentTime = new Date('2026-02-16T07:56:00.000Z');
    const tradingConfig = createTradingConfig();
    const tradeContext = createTradeContextMock();
    tradeContext.seedStockPositions(
      createStockPositionsResponse({
        symbol: 'BULL.HK',
        quantity: 500,
        availableQuantity: 500,
      }),
    );

    const cancelOrderIds: string[] = [];
    let pendingSellVisible = true;
    const trackedOrders: TrackOrderParams[] = [];
    const orderMonitor = createOrderMonitorDouble({
      trackOrder: (params) => {
        trackedOrders.push(params);
      },
      cancelOrder: async (orderId) => {
        cancelOrderIds.push(orderId);
        return {
          kind: 'CANCEL_CONFIRMED' as const,
          closedReason: 'CANCELED' as const,
          source: 'API' as const,
          relatedBuyOrderIds: ['BUY-ORDINARY'],
        };
      },
      getPendingSellOrders: () =>
        pendingSellVisible
          ? [
              {
                orderId: 'SELL-ORDINARY-ELO',
                symbol: 'BULL.HK',
                side: OrderSide.Sell,
                status: OrderStatus.New,
                orderType: OrderType.ELO,
                submittedPrice: 1,
                submittedQuantity: 100,
                executedQuantity: 0,
                submittedAt: currentTime.getTime(),
              },
            ]
          : [],
    });

    const submittedSellLinks: Array<ReadonlyArray<string>> = [];
    const orderRecorder = createOrderRecorderDouble({
      getBuyOrdersForSymbol: () => [
        {
          orderId: 'BUY-ORDINARY',
          symbol: 'BULL.HK',
          executedPrice: 1,
          executedQuantity: 100,
          executedTime: currentTime.getTime(),
          submittedAt: undefined,
          updatedAt: undefined,
        },
        {
          orderId: 'BUY-FRESH',
          symbol: 'BULL.HK',
          executedPrice: 1,
          executedQuantity: 100,
          executedTime: currentTime.getTime(),
          submittedAt: undefined,
          updatedAt: undefined,
        },
      ],
      getPendingSellSnapshot: () => [
        {
          orderId: 'SELL-ORDINARY-ELO',
          symbol: 'BULL.HK',
          direction: 'LONG',
          submittedQuantity: 100,
          filledQuantity: 0,
          relatedBuyOrderIds: ['BUY-ORDINARY'],
          status: 'pending',
          submittedAt: currentTime.getTime(),
        },
      ],
      submitSellOrder: (_orderId, _symbol, _direction, _quantity, relatedBuyOrderIds) => {
        submittedSellLinks.push(relatedBuyOrderIds);
      },
    });

    const orderExecutor = createOrderExecutor({
      ctx: createTradeContextDouble(tradeContext),
      rateLimiter: createRateLimiterDouble(),
      marketDataClient: createDoomsdayExecutionQuoteClient(),
      cacheManager: { clearCache: () => {}, getPendingOrders: async () => [] },
      orderMonitor,
      orderRecorder,
      tradingConfig,
      symbolRegistry: createSymbolRegistryDouble(),
      isExecutionAllowed: () => true,
      isContinuousTradingAllowed: () => true,
      now: () => currentTime,
      readCurrentTradingDayInfo: () => ({
        dateKey: getRequiredHKDateKey(currentTime),
        info: { isTradingDay: true, isHalfDay: false },
      }),
    });
    const clearanceCommand = createDoomsdayClearanceCommand(currentTime);

    const beforeTerminalResult = await orderExecutor.executeDoomsdayClearanceSignals([
      clearanceCommand,
    ]);

    expect(tradeContext.getCalls('replaceOrder')).toHaveLength(0);
    expect(beforeTerminalResult.executedOrderIds).toEqual([]);
    expect(Reflect.get(beforeTerminalResult, 'awaitingAuthoritativeTerminalSymbols')).toEqual([
      'BULL.HK',
    ]);
    expect(tradeContext.getCalls('stockPositions')).toHaveLength(0);
    expect(tradeContext.getCalls('submitOrder')).toHaveLength(0);

    const repeatedBeforeTerminalResult = await orderExecutor.executeDoomsdayClearanceSignals([
      clearanceCommand,
    ]);

    expect(repeatedBeforeTerminalResult.executedOrderIds).toEqual([]);
    expect(
      Reflect.get(repeatedBeforeTerminalResult, 'awaitingAuthoritativeTerminalSymbols'),
    ).toEqual(['BULL.HK']);
    expect(cancelOrderIds).toEqual(['SELL-ORDINARY-ELO']);
    expect(tradeContext.getCalls('stockPositions')).toHaveLength(0);
    expect(tradeContext.getCalls('submitOrder')).toHaveLength(0);

    // WebSocket/权威订单终态已经从 pending 视图移除该旧单。
    pendingSellVisible = false;
    const result = await orderExecutor.executeDoomsdayClearanceSignals([clearanceCommand]);

    expect(result.executedOrderIds).toEqual(['MOCK-000001']);
    expect(cancelOrderIds).toEqual(['SELL-ORDINARY-ELO']);
    expect(tradeContext.getCalls('stockPositions')).toHaveLength(1);
    expect(tradeContext.getCalls('submitOrder')).toHaveLength(1);
    expect(submittedSellLinks).toEqual([]);

    const submitPayload = tradeContext.getCalls('submitOrder')[0]?.args[0];
    if (typeof submitPayload !== 'object' || submitPayload === null) {
      throw new TypeError('expected doomsday clearance submit payload');
    }

    expect(Reflect.get(submitPayload, 'orderType')).toBe(OrderType.ELO);
    expect(Reflect.get(submitPayload, 'side')).toBe(OrderSide.Sell);
    expect(Number(String(Reflect.get(submitPayload, 'submittedQuantity')))).toBe(500);
    expect(Reflect.get(submitPayload, 'remark')).toBe('QuantDemo');
    expect(trackedOrders).toHaveLength(1);
    expect(trackedOrders[0]?.isProtectiveLiquidation).toBeFalse();
    expect(trackedOrders[0]?.orderType).toBe(OrderType.ELO);
  });

  it('uses the actual time-wakeup chain to retry an acknowledged cancellation, then submits only after a WebSocket terminal fact', async () => {
    let currentTime = new Date('2026-02-16T07:56:00.000Z');
    const retryIntervalMs = 1_000;
    const monitorConfig = createMonitorConfigDouble();
    const monitorContext = createMonitorContext(monitorConfig);
    const tradingConfig = createTradingConfig({ monitor: monitorConfig });
    const tradeContext = createTradeContextMock();
    tradeContext.seedStockPositions(
      createStockPositionsResponse({
        symbol: 'BULL.HK',
        quantity: 500,
        availableQuantity: 500,
      }),
    );
    const cancelOrderIds: string[] = [];
    let pendingSellVisible = true;
    const orderExecutor = createOrderExecutor({
      ctx: createTradeContextDouble(tradeContext),
      rateLimiter: createRateLimiterDouble(),
      marketDataClient: createDoomsdayExecutionQuoteClient(),
      cacheManager: { clearCache: () => {}, getPendingOrders: async () => [] },
      orderMonitor: createOrderMonitorDouble({
        trackOrder: () => {},
        cancelOrder: async (orderId) => {
          cancelOrderIds.push(orderId);
          return {
            kind: 'CANCEL_CONFIRMED',
            closedReason: 'CANCELED',
            source: 'API',
            relatedBuyOrderIds: null,
          };
        },
        getPendingSellOrders: () =>
          pendingSellVisible
            ? [
                {
                  orderId: 'SELL-WAITING-WS',
                  symbol: 'BULL.HK',
                  side: OrderSide.Sell,
                  status: OrderStatus.New,
                  orderType: OrderType.ELO,
                  submittedPrice: 1,
                  submittedQuantity: 100,
                  executedQuantity: 0,
                  submittedAt: currentTime.getTime(),
                },
              ]
            : [],
      }),
      orderRecorder: createOrderRecorderDouble(),
      tradingConfig,
      symbolRegistry: monitorContext.symbolRegistry,
      isExecutionAllowed: () => true,
      isContinuousTradingAllowed: () => true,
      now: () => currentTime,
      readCurrentTradingDayInfo: () => ({
        dateKey: getRequiredHKDateKey(currentTime),
        info: { isTradingDay: true, isHalfDay: false },
      }),
    });
    const trader = createTraderDouble({
      executeDoomsdayClearanceSignals: (commands) =>
        orderExecutor.executeDoomsdayClearanceSignals(commands),
    });
    const lastState = createLastState();
    lastState.cachedPositions = [
      createPositionDouble({ symbol: 'BULL.HK', quantity: 500, availableQuantity: 500 }),
    ];
    lastState.positionCache.update(lastState.cachedPositions);
    const context: TimeWakeupEvaluationContext = {
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () => new Map([['BULL.HK', createQuoteDouble('BULL.HK', 1.1, 100)]]),
      }),
      trader,
      lastState,
      doomsdayProtection: createDoomsdayProtection({
        now: () => currentTime,
        quoteRetryIntervalMs: retryIntervalMs,
      }),
      tradingConfig,
      monitorContext,
      tradingGateEventRuntime: {
        emitGateStateChanged: () => {},
        emitAutoSearchAuthorizationChanged: () => {},
      },
      quoteSubscriptionRuntime: createQuoteSubscriptionRuntimeDouble(),
      dayLifecycleManager: {
        tick: async () => ({ nextRetryAtMs: null, pendingOpenRebuild: false }),
      },
      now: () => currentTime,
    };

    setSystemTime(currentTime);
    try {
      const firstResult = await timeWakeupEvaluationProgram(context);
      const retryAtMs = currentTime.getTime() + retryIntervalMs;

      expect(firstResult.plan.candidates).toContainEqual({
        source: 'DOOMSDAY_RETRY',
        atMs: retryAtMs,
      });
      expect(cancelOrderIds).toEqual(['SELL-WAITING-WS']);
      expect(tradeContext.getCalls('submitOrder')).toHaveLength(0);

      // 模拟订单 WebSocket 已将撤单终态收敛到 OrderMonitor 的 pending 事实。
      pendingSellVisible = false;
      currentTime = new Date(retryAtMs);
      setSystemTime(currentTime);
      const afterTerminalResult = await timeWakeupEvaluationProgram(context);

      expect(
        afterTerminalResult.plan.candidates.some(
          (candidate) => candidate.source === 'DOOMSDAY_RETRY',
        ),
      ).toBeFalse();
      expect(cancelOrderIds).toEqual(['SELL-WAITING-WS']);
      expect(tradeContext.getCalls('stockPositions')).toHaveLength(1);
      expect(tradeContext.getCalls('submitOrder')).toHaveLength(1);
      const submitPayload = tradeContext.getCalls('submitOrder')[0]?.args[0];
      if (typeof submitPayload !== 'object' || submitPayload === null) {
        throw new TypeError('expected fresh doomsday order after WebSocket terminal');
      }

      expect(Number(String(Reflect.get(submitPayload, 'submittedQuantity')))).toBe(500);
    } finally {
      setSystemTime();
    }
  });

  it('uses only fresh available quantity after partial, multiple, or filled old sell terminals', async () => {
    const currentTime = new Date('2026-02-16T07:56:00.000Z');
    const scenarios: ReadonlyArray<{
      readonly name: string;
      readonly freshAvailableQuantity: number;
      readonly terminalOutcomes: ReadonlyArray<CancelOrderOutcome>;
    }> = [
      {
        name: 'partial fill',
        freshAvailableQuantity: 500,
        terminalOutcomes: [
          createTerminalCancelOutcome({
            closedReason: 'CANCELED',
            submittedQuantity: 100,
            executedQuantity: 50,
          }),
        ],
      },
      {
        name: 'multiple pending sells',
        freshAvailableQuantity: 500,
        terminalOutcomes: [
          createTerminalCancelOutcome({
            closedReason: 'CANCELED',
            submittedQuantity: 300,
            executedQuantity: 0,
          }),
          createTerminalCancelOutcome({
            closedReason: 'CANCELED',
            submittedQuantity: 200,
            executedQuantity: 100,
          }),
        ],
      },
      {
        name: 'already filled sell',
        freshAvailableQuantity: 300,
        terminalOutcomes: [
          createTerminalCancelOutcome({
            closedReason: 'FILLED',
            submittedQuantity: 200,
            executedQuantity: 200,
          }),
        ],
      },
    ];

    for (const scenario of scenarios) {
      const tradeContext = createTradeContextMock();
      tradeContext.seedStockPositions(
        createStockPositionsResponse({
          symbol: 'BULL.HK',
          quantity: scenario.freshAvailableQuantity,
          availableQuantity: scenario.freshAvailableQuantity,
        }),
      );
      const cancelOrderIds: string[] = [];
      let outcomeIndex = 0;
      const orderExecutor = createOrderExecutor({
        ctx: createTradeContextDouble(tradeContext),
        rateLimiter: createRateLimiterDouble(),
        marketDataClient: createDoomsdayExecutionQuoteClient(),
        cacheManager: { clearCache: () => {}, getPendingOrders: async () => [] },
        orderMonitor: createOrderMonitorDouble({
          trackOrder: () => {},
          cancelOrder: async (orderId) => {
            cancelOrderIds.push(orderId);
            const outcome = scenario.terminalOutcomes[outcomeIndex];
            outcomeIndex += 1;
            if (outcome === undefined) {
              throw new Error(`unexpected cancel request for ${scenario.name}: ${orderId}`);
            }

            return outcome;
          },
          getPendingSellOrders: () =>
            scenario.terminalOutcomes.map((_, index) => ({
              orderId: `SELL-OLD-${String(index + 1)}`,
              symbol: 'BULL.HK',
              side: OrderSide.Sell,
              status: OrderStatus.New,
              orderType: OrderType.ELO,
              submittedPrice: 1,
              submittedQuantity: 100,
              executedQuantity: 0,
              submittedAt: currentTime.getTime(),
            })),
        }),
        orderRecorder: createOrderRecorderDouble(),
        tradingConfig: createTradingConfig(),
        symbolRegistry: createSymbolRegistryDouble(),
        isExecutionAllowed: () => true,
        isContinuousTradingAllowed: () => true,
        now: () => currentTime,
        readCurrentTradingDayInfo: () => ({
          dateKey: getRequiredHKDateKey(currentTime),
          info: { isTradingDay: true, isHalfDay: false },
        }),
      });

      const result = await orderExecutor.executeDoomsdayClearanceSignals([
        createDoomsdayClearanceCommand(currentTime),
      ]);

      expect(result.executedOrderIds).toEqual(['MOCK-000001']);
      expect(cancelOrderIds).toHaveLength(scenario.terminalOutcomes.length);
      expect(tradeContext.getCalls('replaceOrder')).toHaveLength(0);
      expect(tradeContext.getCalls('stockPositions')).toHaveLength(1);
      const submitPayload = tradeContext.getCalls('submitOrder')[0]?.args[0];
      if (typeof submitPayload !== 'object' || submitPayload === null) {
        throw new TypeError(`expected fresh doomsday order for ${scenario.name}`);
      }

      expect(Number(String(Reflect.get(submitPayload, 'submittedQuantity')))).toBe(
        scenario.freshAvailableQuantity,
      );
    }
  });

  it('does not schedule a terminal wait past close or submit after the clearance window', async () => {
    const closeTime = new Date('2026-02-16T08:00:00.000Z');
    const beforeClose = new Date(closeTime.getTime() - 100);
    const monitorConfig = createMonitorConfigDouble();
    const monitorContext = createMonitorContext(monitorConfig);
    const lastState = createLastState();
    lastState.cachedPositions = [
      createPositionDouble({ symbol: 'BULL.HK', quantity: 500, availableQuantity: 500 }),
    ];
    lastState.positionCache.update(lastState.cachedPositions);
    let executionCalls = 0;
    const trader = createTraderDouble({
      executeDoomsdayClearanceSignals: async () => {
        executionCalls += 1;
        return {
          executedOrderIds: [],
          awaitingAuthoritativeTerminalSymbols: ['BULL.HK'],
          unresolvedQuoteSymbols: [],
        };
      },
    });
    const doomsdayProtection = createDoomsdayProtection({
      now: () => beforeClose,
      quoteRetryIntervalMs: 200,
    });
    const context = {
      isHalfDay: false,
      isLive: alwaysLive,
      positions: lastState.cachedPositions,
      monitorContext,
      trader,
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () => new Map([['BULL.HK', createQuoteDouble('BULL.HK', 1.1, 100)]]),
      }),
      lastState,
    };

    const beforeCloseResult = await doomsdayProtection.executeClearance({
      ...context,
      currentTime: beforeClose,
    });
    const afterCloseResult = await doomsdayProtection.executeClearance({
      ...context,
      currentTime: closeTime,
    });

    expect(beforeCloseResult.nextRetryAtMs).toBeNull();
    expect(afterCloseResult.executed).toBeFalse();
    expect(executionCalls).toBe(1);
  });

  it('keeps every doomsday retry strictly before normal and half-day close', async () => {
    const closeScenarios: ReadonlyArray<{
      readonly label: string;
      readonly closeMs: number;
      readonly isHalfDay: boolean;
    }> = [
      {
        label: 'normal day',
        closeMs: new Date('2026-02-16T08:00:00.000Z').getTime(),
        isHalfDay: false,
      },
      {
        label: 'half day',
        closeMs: new Date('2026-02-16T04:00:00.000Z').getTime(),
        isHalfDay: true,
      },
    ];

    for (const scenario of closeScenarios) {
      const currentTime = new Date(scenario.closeMs - 100);
      const monitorContext = createMonitorContext();
      const lastState = createLastState();
      lastState.cachedPositions = [
        createPositionDouble({ symbol: 'BULL.HK', quantity: 100, availableQuantity: 100 }),
      ];
      lastState.positionCache.update(lastState.cachedPositions);

      const terminalResult = await createDoomsdayProtection({
        now: () => currentTime,
        quoteRetryIntervalMs: 200,
      }).executeClearance({
        currentTime,
        isHalfDay: scenario.isHalfDay,
        isLive: alwaysLive,
        positions: lastState.cachedPositions,
        monitorContext,
        trader: createTraderDouble({
          executeDoomsdayClearanceSignals: async () => ({
            executedOrderIds: [],
            awaitingAuthoritativeTerminalSymbols: ['BULL.HK'],
            unresolvedQuoteSymbols: [],
          }),
        }),
        marketDataClient: createMarketDataClientDouble({
          getQuotes: async () => new Map([['BULL.HK', createQuoteDouble('BULL.HK', 1.1, 100)]]),
        }),
        lastState,
      });

      expect(terminalResult.nextRetryAtMs, `${scenario.label} terminal`).toBeNull();

      const missingQuoteState = createLastState();
      missingQuoteState.cachedPositions = [
        createPositionDouble({ symbol: 'BULL.HK', quantity: 100, availableQuantity: 100 }),
      ];
      missingQuoteState.positionCache.update(missingQuoteState.cachedPositions);
      const missingQuoteResult = await createDoomsdayProtection({
        now: () => currentTime,
        quoteRetryIntervalMs: 200,
      }).executeClearance({
        currentTime,
        isHalfDay: scenario.isHalfDay,
        isLive: alwaysLive,
        positions: missingQuoteState.cachedPositions,
        monitorContext: createMonitorContext(),
        trader: createTraderDouble(),
        marketDataClient: createMarketDataClientDouble({
          getQuotes: async () => new Map([['BULL.HK', null]]),
        }),
        lastState: missingQuoteState,
      });

      expect(missingQuoteResult.nextRetryAtMs, `${scenario.label} missing quote`).toBeNull();

      const unknownCancelResult = await createDoomsdayProtection({
        now: () => currentTime,
        quoteRetryIntervalMs: 200,
      }).cancelPendingBuyOrders({
        currentTime,
        isHalfDay: scenario.isHalfDay,
        isLive: alwaysLive,
        monitorContext: createMonitorContext(),
        trader: createTraderDouble({
          getPendingOrders: async () => [
            {
              orderId: `UNKNOWN-CANCEL-${scenario.label}`,
              symbol: 'BULL.HK',
              side: OrderSide.Buy,
              submittedPrice: 1,
              quantity: 100,
              executedQuantity: 0,
              status: OrderStatus.New,
              orderType: OrderType.ELO,
            },
          ],
          cancelDoomsdayOrder: async () => ({
            kind: 'UNKNOWN_FAILURE',
            errorCode: null,
            message: 'cancel result unknown',
          }),
        }),
      });

      expect(unknownCancelResult.nextRetryAtMs, `${scenario.label} unknown cancel`).toBeNull();
    }
  });

  it('clears a missing-quote retry due time when the close window rejects its candidate', async () => {
    const closeMs = new Date('2026-02-16T08:00:00.000Z').getTime();
    let currentTime = new Date(closeMs - 100);
    const lastState = createLastState();
    lastState.cachedPositions = [
      createPositionDouble({ symbol: 'BULL.HK', quantity: 100, availableQuantity: 100 }),
    ];
    lastState.positionCache.update(lastState.cachedPositions);
    const doomsday = createDoomsdayProtection({
      now: () => currentTime,
      quoteRetryIntervalMs: 200,
    });
    const context = {
      isHalfDay: false,
      isLive: alwaysLive,
      positions: lastState.cachedPositions,
      monitorContext: createMonitorContext(),
      trader: createTraderDouble(),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () => new Map([['BULL.HK', null]]),
      }),
      lastState,
    };

    const firstResult = await doomsday.executeClearance({
      ...context,
      currentTime,
    });

    expect(firstResult.nextRetryAtMs).toBeNull();

    currentTime = new Date(closeMs - 50);
    const secondResult = await doomsday.executeClearance({
      ...context,
      currentTime,
    });

    expect(secondResult.nextRetryAtMs).toBeNull();
  });

  it('keeps every doomsday retry scheduled while 200ms remains inside the close window', async () => {
    const closeScenarios: ReadonlyArray<{
      readonly label: string;
      readonly closeMs: number;
      readonly isHalfDay: boolean;
    }> = [
      {
        label: 'normal day',
        closeMs: new Date('2026-02-16T08:00:00.000Z').getTime(),
        isHalfDay: false,
      },
      {
        label: 'half day',
        closeMs: new Date('2026-02-16T04:00:00.000Z').getTime(),
        isHalfDay: true,
      },
    ];

    for (const scenario of closeScenarios) {
      const currentTime = new Date(scenario.closeMs - 300);
      const expectedRetryAtMs = scenario.closeMs - 100;
      const terminalState = createLastState();
      terminalState.cachedPositions = [
        createPositionDouble({ symbol: 'BULL.HK', quantity: 100, availableQuantity: 100 }),
      ];
      terminalState.positionCache.update(terminalState.cachedPositions);
      const terminalResult = await createDoomsdayProtection({
        now: () => currentTime,
        quoteRetryIntervalMs: 200,
      }).executeClearance({
        currentTime,
        isHalfDay: scenario.isHalfDay,
        isLive: alwaysLive,
        positions: terminalState.cachedPositions,
        monitorContext: createMonitorContext(),
        trader: createTraderDouble({
          executeDoomsdayClearanceSignals: async () => ({
            executedOrderIds: [],
            awaitingAuthoritativeTerminalSymbols: ['BULL.HK'],
            unresolvedQuoteSymbols: [],
          }),
        }),
        marketDataClient: createMarketDataClientDouble({
          getQuotes: async () => new Map([['BULL.HK', createQuoteDouble('BULL.HK', 1.1, 100)]]),
        }),
        lastState: terminalState,
      });

      expect(terminalResult.nextRetryAtMs, `${scenario.label} terminal`).toBe(expectedRetryAtMs);

      const missingQuoteState = createLastState();
      missingQuoteState.cachedPositions = [
        createPositionDouble({ symbol: 'BULL.HK', quantity: 100, availableQuantity: 100 }),
      ];
      missingQuoteState.positionCache.update(missingQuoteState.cachedPositions);
      const missingQuoteResult = await createDoomsdayProtection({
        now: () => currentTime,
        quoteRetryIntervalMs: 200,
      }).executeClearance({
        currentTime,
        isHalfDay: scenario.isHalfDay,
        isLive: alwaysLive,
        positions: missingQuoteState.cachedPositions,
        monitorContext: createMonitorContext(),
        trader: createTraderDouble(),
        marketDataClient: createMarketDataClientDouble({
          getQuotes: async () => new Map([['BULL.HK', null]]),
        }),
        lastState: missingQuoteState,
      });

      expect(missingQuoteResult.nextRetryAtMs, `${scenario.label} missing quote`).toBe(
        expectedRetryAtMs,
      );

      const unknownCancelResult = await createDoomsdayProtection({
        now: () => currentTime,
        quoteRetryIntervalMs: 200,
      }).cancelPendingBuyOrders({
        currentTime,
        isHalfDay: scenario.isHalfDay,
        isLive: alwaysLive,
        monitorContext: createMonitorContext(),
        trader: createTraderDouble({
          getPendingOrders: async () => [
            {
              orderId: `UNKNOWN-CANCEL-INNER-${scenario.label}`,
              symbol: 'BULL.HK',
              side: OrderSide.Buy,
              submittedPrice: 1,
              quantity: 100,
              executedQuantity: 0,
              status: OrderStatus.New,
              orderType: OrderType.ELO,
            },
          ],
          cancelDoomsdayOrder: async () => ({
            kind: 'UNKNOWN_FAILURE',
            errorCode: null,
            message: 'cancel result unknown',
          }),
        }),
      });

      expect(unknownCancelResult.nextRetryAtMs, `${scenario.label} unknown cancel`).toBe(
        expectedRetryAtMs,
      );
    }
  });

  it('rejects ordinary Trader execution during the close-5 takeover window before SDK submission', async () => {
    const currentTime = new Date('2026-02-16T07:56:00.000Z');
    const monitorConfig = createMonitorConfigDouble();
    const monitorContext = createMonitorContext(monitorConfig);
    const tradeContext = createTradeContextMock();
    const trader = await createRealDoomsdayTrader({
      suffix: 'ordinary-close-5',
      tradeContext,
      tradingConfig: createTradingConfig({ monitor: monitorConfig }),
      marketDataClient: createMarketDataClientDouble(),
      symbolRegistry: monitorContext.symbolRegistry,
      now: () => currentTime,
    });
    const ordinarySell = {
      ...createSignal({
        symbol: 'BULL.HK',
        action: 'SELLCALL',
        price: 1.1,
        triggerTimeMs: Date.now(),
        reason: 'ordinary-sell-during-takeover',
      }),
      quantity: 100,
    };

    const result = await trader.executeSignals([ordinarySell]);

    expect(result.executedOrderIds).toEqual([]);
    expect(tradeContext.getCalls('stockPositions')).toHaveLength(0);
    expect(tradeContext.getCalls('submitOrder')).toHaveLength(0);
  });

  it('rejects the dedicated Trader clearance entry outside the close-5 window before SDK submission', async () => {
    const currentTime = new Date('2026-02-16T07:50:00.000Z');
    const monitorConfig = createMonitorConfigDouble();
    const monitorContext = createMonitorContext(monitorConfig);
    const tradeContext = createTradeContextMock();
    const trader = await createRealDoomsdayTrader({
      suffix: 'clearance-outside-close-5',
      tradeContext,
      tradingConfig: createTradingConfig({ monitor: monitorConfig }),
      marketDataClient: createMarketDataClientDouble(),
      symbolRegistry: monitorContext.symbolRegistry,
      now: () => currentTime,
    });
    const clearanceCommand = createDoomsdayClearanceCommand(currentTime);

    const result = await trader.executeDoomsdayClearanceSignals([clearanceCommand]);

    expect(result.executedOrderIds).toEqual([]);
    expect(tradeContext.getCalls('stockPositions')).toHaveLength(0);
    expect(tradeContext.getCalls('submitOrder')).toHaveLength(0);
  });

  it('cancels pending buy orders once per trading day within close-15 window', async () => {
    const doomsday = createDoomsdayProtection();
    const monitorConfig = createMonitorConfigDouble();

    const trader = createTraderDouble({
      getPendingOrders: async () => [
        {
          orderId: 'B-1',
          symbol: 'BULL.HK',
          side: OrderSide.Buy,
          submittedPrice: 1,
          quantity: 100,
          executedQuantity: 0,
          status: OrderStatus.New,
          orderType: OrderType.ELO,
        },
        {
          orderId: 'S-1',
          symbol: 'BULL.HK',
          side: OrderSide.Sell,
          submittedPrice: 1,
          quantity: 100,
          executedQuantity: 0,
          status: OrderStatus.New,
          orderType: OrderType.ELO,
        },
      ],
      cancelDoomsdayOrder: async () => ({
        kind: 'CANCEL_CONFIRMED',
        closedReason: 'CANCELED',
        source: 'API',
        relatedBuyOrderIds: null,
      }),
    });

    const result1 = await doomsday.cancelPendingBuyOrders({
      currentTime: new Date('2026-02-16T07:50:00.000Z'),
      isHalfDay: false,
      isLive: alwaysLive,
      monitorContext: createMonitorContext(monitorConfig),
      trader,
    });

    const result2 = await doomsday.cancelPendingBuyOrders({
      currentTime: new Date('2026-02-16T07:51:00.000Z'),
      isHalfDay: false,
      isLive: alwaysLive,
      monitorContext: createMonitorContext(monitorConfig),
      trader,
    });

    expect(result1.executed).toBeTrue();
    expect(result1.cancelRequestAcceptedCount).toBe(1);
    expect(result2.executed).toBeFalse();

    expect(trader.getPendingOrders).toBeDefined();
  });

  it('throws non API cancel errors without marking close-15 check completed', async () => {
    const doomsday = createDoomsdayProtection();
    const monitorConfig = createMonitorConfigDouble();
    let cancelCalls = 0;
    const trader = createTraderDouble({
      getPendingOrders: async () => [
        {
          orderId: 'B-1',
          symbol: 'BULL.HK',
          side: OrderSide.Buy,
          submittedPrice: 1,
          quantity: 100,
          executedQuantity: 0,
          status: OrderStatus.New,
          orderType: OrderType.ELO,
        },
      ],
      cancelDoomsdayOrder: async () => {
        cancelCalls += 1;
        throw new TypeError('cancel contract broken');
      },
    });
    const context = {
      currentTime: new Date('2026-02-16T07:50:00.000Z'),
      isHalfDay: false,
      isLive: alwaysLive,
      monitorContext: createMonitorContext(monitorConfig),
      trader,
    };

    let error: unknown = null;
    try {
      await doomsday.cancelPendingBuyOrders(context);
    } catch (err) {
      error = err;
    }

    let retryError: unknown = null;
    try {
      await doomsday.cancelPendingBuyOrders(context);
    } catch (err) {
      retryError = err;
    }

    expect(error).toBeInstanceOf(TypeError);
    expect(retryError).toBeInstanceOf(TypeError);
    expect((retryError as Error).message).toBe('cancel contract broken');
    expect(cancelCalls).toBe(2);
  });

  it('does not count already-filled buy orders as cancelled in close-15 window', async () => {
    const doomsday = createDoomsdayProtection();
    const monitorConfig = createMonitorConfigDouble();

    const trader = createTraderDouble({
      getPendingOrders: async () => [
        {
          orderId: 'B-FILLED',
          symbol: 'BULL.HK',
          side: OrderSide.Buy,
          submittedPrice: 1,
          quantity: 100,
          executedQuantity: 0,
          status: OrderStatus.New,
          orderType: OrderType.ELO,
        },
      ],
      cancelDoomsdayOrder: async () => ({
        kind: 'ALREADY_CLOSED',
        closedReason: 'FILLED',
        source: 'API_ERROR',
        relatedBuyOrderIds: null,
        terminalExecution: {
          submittedQuantity: 100,
          executedQuantity: 100,
        },
      }),
    });

    const result = await doomsday.cancelPendingBuyOrders({
      currentTime: new Date('2026-02-16T07:50:00.000Z'),
      isHalfDay: false,
      isLive: alwaysLive,
      monitorContext: createMonitorContext(monitorConfig),
      trader,
    });

    expect(result.executed).toBeTrue();
    expect(result.cancelRequestAcceptedCount).toBe(0);
  });

  it('rethrows pending-order API failures without marking close-15 check completed', async () => {
    const doomsday = createDoomsdayProtection();
    const monitorConfig = createMonitorConfigDouble();
    let getPendingOrdersCalls = 0;
    const trader = createTraderDouble({
      getPendingOrders: async () => {
        getPendingOrdersCalls += 1;
        throw await createExternalApiRequestError({
          operation: 'test.getPendingOrders',
          attempts: getPendingOrdersCalls,
          cause: new Error('pending orders unavailable'),
        });
      },
    });
    const context = {
      currentTime: new Date('2026-02-16T07:50:00.000Z'),
      isHalfDay: false,
      isLive: alwaysLive,
      monitorContext: createMonitorContext(monitorConfig),
      trader,
    };

    let firstError: unknown = null;
    try {
      await doomsday.cancelPendingBuyOrders(context);
    } catch (error) {
      firstError = error;
    }

    let secondError: unknown = null;
    try {
      await doomsday.cancelPendingBuyOrders(context);
    } catch (error) {
      secondError = error;
    }

    expect(firstError).toMatchObject({ name: 'ExternalApiRequestError' });
    expect(secondError).toMatchObject({ name: 'ExternalApiRequestError' });
    expect(getPendingOrdersCalls).toBe(2);
  });

  it('executes close-5 liquidation, clears caches and order records for both sides', async () => {
    const doomsday = createDoomsdayProtection();
    const monitorConfig = createMonitorConfigDouble();

    let executedSignals = 0;
    const trader = createTraderDouble({
      executeDoomsdayClearanceSignals: async (signals) => {
        executedSignals = signals.length;
        return {
          executedOrderIds: signals.map(() => `EXECUTED-ORDER`),
          awaitingAuthoritativeTerminalSymbols: [],
          unresolvedQuoteSymbols: [],
        };
      },
    });

    const clearCallsBySide: [number, number] = [0, 0];
    const orderRecorder = createOrderRecorderDouble({
      clearBuyOrders: (_symbol, isLongSymbol) => {
        const sideIndex = Number(isLongSymbol) as 0 | 1;
        clearCallsBySide[sideIndex] += 1;
      },
    });

    const monitorContext = createMonitorContext(monitorConfig, orderRecorder);

    const lastState = createLastState();

    const result = await doomsday.executeClearance({
      currentTime: new Date('2026-02-16T07:56:00.000Z'),
      isHalfDay: false,
      isLive: alwaysLive,
      positions: lastState.cachedPositions,
      monitorContext,
      trader,
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () =>
          new Map([
            ['BULL.HK', createQuoteDouble('BULL.HK', 1.1, 100)],
            ['BEAR.HK', createQuoteDouble('BEAR.HK', 0.9, 100)],
          ]),
      }),
      lastState,
    });

    expect(result.executed).toBeTrue();
    expect(executedSignals).toBe(2);

    expect(clearCallsBySide[1]).toBe(1);
    expect(clearCallsBySide[0]).toBe(1);

    expect(lastState.cachedAccount).toBeNull();
    expect(lastState.cachedPositions).toHaveLength(0);
    expect(lastState.positionCache.get('BULL.HK')).toBeNull();
  });

  it('fails fast when close-5 window sees positive positions outside current seat symbols', async () => {
    const doomsday = createDoomsdayProtection();
    const monitorConfig = createMonitorConfigDouble();
    const lastState = createLastState();
    lastState.cachedPositions = [
      ...lastState.cachedPositions,
      createPositionDouble({
        symbol: 'OLD_BULL.HK',
        quantity: 200,
        availableQuantity: 200,
      }),
    ];
    lastState.positionCache.update(lastState.cachedPositions);

    let quoteCalls = 0;
    const marketDataClient = createMarketDataClientDouble({
      getQuotes: async () => {
        quoteCalls += 1;
        return new Map([
          ['BULL.HK', createQuoteDouble('BULL.HK', 1.1, 100)],
          ['BEAR.HK', createQuoteDouble('BEAR.HK', 0.9, 100)],
        ]);
      },
    });

    let executeCalls = 0;
    const trader = createTraderDouble({
      executeDoomsdayClearanceSignals: async (signals) => {
        executeCalls += 1;
        return {
          executedOrderIds: signals.map(() => `EXECUTED-ORDER`),
          awaitingAuthoritativeTerminalSymbols: [],
          unresolvedQuoteSymbols: [],
        };
      },
    });

    let clearCalls = 0;
    const monitorContext = createMonitorContext(
      monitorConfig,
      createOrderRecorderDouble({
        clearBuyOrders: () => {
          clearCalls += 1;
        },
      }),
    );

    let error: unknown = null;
    try {
      await doomsday.executeClearance({
        currentTime: new Date('2026-02-16T07:56:00.000Z'),
        isHalfDay: false,
        isLive: alwaysLive,
        positions: lastState.cachedPositions,
        monitorContext,
        trader,
        marketDataClient,
        lastState,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('非当前席位持仓');
    expect((error as Error).message).toContain('OLD_BULL.HK');
    expect(quoteCalls).toBe(0);
    expect(executeCalls).toBe(0);
    expect(clearCalls).toBe(0);
    expect(lastState.cachedAccount).not.toBeNull();
    expect(lastState.cachedPositions).toHaveLength(3);
    expect(lastState.positionCache.get('OLD_BULL.HK')).not.toBeNull();
  });

  it('keeps caches and order records when close-5 liquidation signals are not actually submitted', async () => {
    const doomsday = createDoomsdayProtection();
    const monitorConfig = createMonitorConfigDouble();

    const trader = createTraderDouble({
      executeDoomsdayClearanceSignals: async () => ({
        executedOrderIds: [],
        awaitingAuthoritativeTerminalSymbols: [],
        unresolvedQuoteSymbols: [],
      }),
    });

    let clearCalls = 0;
    const orderRecorder = createOrderRecorderDouble({
      clearBuyOrders: () => {
        clearCalls += 1;
      },
    });
    const lastState = createLastState();

    const result = await doomsday.executeClearance({
      currentTime: new Date('2026-02-16T07:56:00.000Z'),
      isHalfDay: false,
      isLive: alwaysLive,
      positions: lastState.cachedPositions,
      monitorContext: createMonitorContext(monitorConfig, orderRecorder),
      trader,
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () =>
          new Map([
            ['BULL.HK', createQuoteDouble('BULL.HK', 1.1, 100)],
            ['BEAR.HK', createQuoteDouble('BEAR.HK', 0.9, 100)],
          ]),
      }),
      lastState,
    });

    expect(result).toEqual({ executed: false, nextRetryAtMs: null });
    expect(clearCalls).toBe(0);
    expect(lastState.cachedAccount).not.toBeNull();
    expect(lastState.cachedPositions).toHaveLength(2);
    expect(lastState.positionCache.get('BULL.HK')).not.toBeNull();
  });

  it('returns next retry time when close-5 clearance quote is missing', async () => {
    const doomsday = createDoomsdayProtection({
      now: () => new Date('2026-02-16T07:56:00.000Z'),
      quoteRetryIntervalMs: 2_000,
      quoteRetryMaxAttempts: 2,
    });
    const monitorConfig = createMonitorConfigDouble();

    let executedSignals = 0;
    let clearCalls = 0;
    const orderRecorder = createOrderRecorderDouble({
      clearBuyOrders: () => {
        clearCalls += 1;
      },
    });
    const trader = createTraderDouble({
      executeDoomsdayClearanceSignals: async (signals) => {
        executedSignals += signals.length;
        return {
          executedOrderIds: signals.map(() => `EXECUTED-ORDER`),
          awaitingAuthoritativeTerminalSymbols: [],
          unresolvedQuoteSymbols: [],
        };
      },
    });

    const lastState = createLastState();
    lastState.cachedPositions = [
      createPositionDouble({ symbol: 'BULL.HK', quantity: 500, availableQuantity: 500 }),
    ];
    lastState.positionCache.update(lastState.cachedPositions);

    const marketDataClient = createMarketDataClientDouble({
      getQuotes: async () =>
        new Map([
          ['BULL.HK', null],
          ['BEAR.HK', null],
        ]),
    });

    const result = await doomsday.executeClearance({
      currentTime: new Date('2026-02-16T07:56:00.000Z'),
      isHalfDay: false,
      isLive: alwaysLive,
      positions: lastState.cachedPositions,
      monitorContext: createMonitorContext(monitorConfig, orderRecorder),
      trader,
      marketDataClient,
      lastState,
    });

    expect(result).toEqual({
      executed: false,
      nextRetryAtMs: new Date('2026-02-16T07:56:02.000Z').getTime(),
    });
    expect(executedSignals).toBe(0);
    expect(clearCalls).toBe(0);
  });

  it('does not schedule close-5 retry when clearance quote has invalid price', async () => {
    const doomsday = createDoomsdayProtection({
      now: () => new Date('2026-02-16T07:56:00.000Z'),
      quoteRetryIntervalMs: 2_000,
      quoteRetryMaxAttempts: 2,
    });
    const monitorConfig = createMonitorConfigDouble();

    let executedSignals = 0;
    let clearCalls = 0;
    const orderRecorder = createOrderRecorderDouble({
      clearBuyOrders: () => {
        clearCalls += 1;
      },
    });
    const trader = createTraderDouble({
      executeDoomsdayClearanceSignals: async (signals) => {
        executedSignals += signals.length;
        return {
          executedOrderIds: signals.map(() => `EXECUTED-ORDER`),
          awaitingAuthoritativeTerminalSymbols: [],
          unresolvedQuoteSymbols: [],
        };
      },
    });

    const lastState = createLastState();
    lastState.cachedPositions = [
      createPositionDouble({ symbol: 'BULL.HK', quantity: 500, availableQuantity: 500 }),
    ];
    lastState.positionCache.update(lastState.cachedPositions);

    const marketDataClient = createMarketDataClientDouble({
      getQuotes: async () =>
        new Map([
          ['BULL.HK', createQuoteDouble('BULL.HK', 0, 100)],
          ['BEAR.HK', null],
        ]),
    });

    const result = await doomsday.executeClearance({
      currentTime: new Date('2026-02-16T07:56:00.000Z'),
      isHalfDay: false,
      isLive: alwaysLive,
      positions: lastState.cachedPositions,
      monitorContext: createMonitorContext(monitorConfig, orderRecorder),
      trader,
      marketDataClient,
      lastState,
    });

    expect(result).toEqual({ executed: false, nextRetryAtMs: null });
    expect(executedSignals).toBe(0);
    expect(clearCalls).toBe(0);
    expect(lastState.cachedAccount).not.toBeNull();
    expect(lastState.cachedPositions).toHaveLength(1);
    expect(lastState.positionCache.get('BULL.HK')).not.toBeNull();
  });

  it('skips planned close-5 retry execution when lifecycle gate closes before retry call', async () => {
    let now = new Date('2026-02-16T07:56:00.000Z');
    const doomsday = createDoomsdayProtection({
      now: () => now,
      quoteRetryIntervalMs: 2_000,
      quoteRetryMaxAttempts: 2,
    });
    const monitorConfig = createMonitorConfigDouble();

    let quoteReady = false;
    let executedSignals = 0;
    let clearCalls = 0;
    const orderRecorder = createOrderRecorderDouble({
      clearBuyOrders: () => {
        clearCalls += 1;
      },
    });
    const trader = createTraderDouble({
      executeDoomsdayClearanceSignals: async (signals) => {
        executedSignals += signals.length;
        return {
          executedOrderIds: signals.map(() => `EXECUTED-ORDER`),
          awaitingAuthoritativeTerminalSymbols: [],
          unresolvedQuoteSymbols: [],
        };
      },
    });

    const lastState = createLastState();
    lastState.cachedPositions = [
      createPositionDouble({ symbol: 'BULL.HK', quantity: 500, availableQuantity: 500 }),
    ];
    lastState.positionCache.update(lastState.cachedPositions);

    const marketDataClient = createMarketDataClientDouble({
      getQuotes: async () =>
        new Map([
          ['BULL.HK', quoteReady ? createQuoteDouble('BULL.HK', 1.1, 100) : null],
          ['BEAR.HK', null],
        ]),
    });

    const result = await doomsday.executeClearance({
      currentTime: new Date('2026-02-16T07:56:00.000Z'),
      isHalfDay: false,
      isLive: alwaysLive,
      positions: lastState.cachedPositions,
      monitorContext: createMonitorContext(monitorConfig, orderRecorder),
      trader,
      marketDataClient,
      lastState,
    });

    expect(result).toEqual({
      executed: false,
      nextRetryAtMs: new Date('2026-02-16T07:56:02.000Z').getTime(),
    });
    expect(executedSignals).toBe(0);
    expect(clearCalls).toBe(0);

    quoteReady = true;
    lastState.isTradingEnabled = false;
    now = new Date('2026-02-16T07:56:02.000Z');
    const retryResult = await doomsday.executeClearance({
      currentTime: now,
      isHalfDay: false,
      isLive: alwaysLive,
      positions: lastState.cachedPositions,
      monitorContext: createMonitorContext(monitorConfig, orderRecorder),
      trader,
      marketDataClient,
      lastState,
    });

    expect(retryResult).toEqual({ executed: false, nextRetryAtMs: null });
    expect(executedSignals).toBe(0);
    expect(clearCalls).toBe(0);
  });

  it('executes ready subset first and returns retry time for unresolved subset in close-5 window', async () => {
    let now = new Date('2026-02-16T07:56:00.000Z');
    const doomsday = createDoomsdayProtection({
      now: () => now,
      quoteRetryIntervalMs: 2_000,
      quoteRetryMaxAttempts: 2,
    });
    const monitorConfig = createMonitorConfigDouble();

    let shortQuoteReady = false;
    const submittedSymbols: string[] = [];
    const trader = createTraderDouble({
      executeDoomsdayClearanceSignals: async (signals) => {
        for (const signal of signals) {
          submittedSymbols.push(signal.symbol);
        }

        return {
          executedOrderIds: signals.map(() => `EXECUTED-ORDER`),
          awaitingAuthoritativeTerminalSymbols: [],
          unresolvedQuoteSymbols: [],
        };
      },
    });
    const orderRecorder = createOrderRecorderDouble();
    const lastState = createLastState();
    const marketDataClient = createMarketDataClientDouble({
      getQuotes: async () =>
        new Map([
          ['BULL.HK', createQuoteDouble('BULL.HK', 1.1, 100)],
          ['BEAR.HK', shortQuoteReady ? createQuoteDouble('BEAR.HK', 0.9, 100) : null],
        ]),
    });

    const result = await doomsday.executeClearance({
      currentTime: now,
      isHalfDay: false,
      isLive: alwaysLive,
      positions: lastState.cachedPositions,
      monitorContext: createMonitorContext(monitorConfig, orderRecorder),
      trader,
      marketDataClient,
      lastState,
    });

    expect(result).toEqual({
      executed: true,
      nextRetryAtMs: new Date('2026-02-16T07:56:02.000Z').getTime(),
    });
    expect(submittedSymbols).toEqual(['BULL.HK']);

    shortQuoteReady = true;
    now = new Date('2026-02-16T07:56:02.000Z');
    const retryResult = await doomsday.executeClearance({
      currentTime: now,
      isHalfDay: false,
      isLive: alwaysLive,
      positions: lastState.cachedPositions,
      monitorContext: createMonitorContext(monitorConfig, orderRecorder),
      trader,
      marketDataClient,
      lastState,
    });

    expect(retryResult).toEqual({ executed: true, nextRetryAtMs: null });
    expect(submittedSymbols).toEqual(['BULL.HK', 'BEAR.HK']);
  });

  it('keeps unresolved symbols pending before planned retry time', async () => {
    let now = new Date('2026-02-16T07:56:00.000Z');
    const doomsday = createDoomsdayProtection({
      now: () => now,
      quoteRetryIntervalMs: 2_000,
      quoteRetryMaxAttempts: 2,
    });
    const monitorConfig = createMonitorConfigDouble();

    let shortQuoteReady = false;
    const submittedSymbols: string[] = [];
    const trader = createTraderDouble({
      executeDoomsdayClearanceSignals: async (signals) => {
        for (const signal of signals) {
          submittedSymbols.push(signal.symbol);
        }

        return {
          executedOrderIds: signals.map(() => `EXECUTED-ORDER`),
          awaitingAuthoritativeTerminalSymbols: [],
          unresolvedQuoteSymbols: [],
        };
      },
    });
    const orderRecorder = createOrderRecorderDouble();
    const lastState = createLastState();
    const marketDataClient = createMarketDataClientDouble({
      getQuotes: async () =>
        new Map([
          ['BULL.HK', createQuoteDouble('BULL.HK', 1.1, 100)],
          ['BEAR.HK', shortQuoteReady ? createQuoteDouble('BEAR.HK', 0.9, 100) : null],
        ]),
    });

    const result = await doomsday.executeClearance({
      currentTime: now,
      isHalfDay: false,
      isLive: alwaysLive,
      positions: lastState.cachedPositions,
      monitorContext: createMonitorContext(monitorConfig, orderRecorder),
      trader,
      marketDataClient,
      lastState,
    });

    expect(result).toEqual({
      executed: true,
      nextRetryAtMs: new Date('2026-02-16T07:56:02.000Z').getTime(),
    });

    now = new Date('2026-02-16T07:56:01.000Z');
    const earlyResult = await doomsday.executeClearance({
      currentTime: now,
      isHalfDay: false,
      isLive: alwaysLive,
      positions: lastState.cachedPositions,
      monitorContext: createMonitorContext(monitorConfig, orderRecorder),
      trader,
      marketDataClient,
      lastState,
    });

    shortQuoteReady = true;
    now = new Date('2026-02-16T07:56:02.000Z');
    const finalResult = await doomsday.executeClearance({
      currentTime: now,
      isHalfDay: false,
      isLive: alwaysLive,
      positions: lastState.cachedPositions,
      monitorContext: createMonitorContext(monitorConfig, orderRecorder),
      trader,
      marketDataClient,
      lastState,
    });

    expect(earlyResult).toEqual({
      executed: false,
      nextRetryAtMs: new Date('2026-02-16T07:56:02.000Z').getTime(),
    });
    expect(finalResult).toEqual({ executed: true, nextRetryAtMs: null });
    expect(submittedSymbols).toEqual(['BULL.HK', 'BEAR.HK']);
  });

  it('strictly terminates exhausted unresolved symbols in close-5 window', async () => {
    let now = new Date('2026-02-16T07:56:00.000Z');
    const doomsday = createDoomsdayProtection({
      now: () => now,
      quoteRetryIntervalMs: 2_000,
      quoteRetryMaxAttempts: 1,
    });
    const monitorConfig = createMonitorConfigDouble();

    let shortQuoteReady = false;
    const submittedSymbols: string[] = [];
    const trader = createTraderDouble({
      executeDoomsdayClearanceSignals: async (signals) => {
        for (const signal of signals) {
          submittedSymbols.push(signal.symbol);
        }

        return {
          executedOrderIds: signals.map(() => `EXECUTED-ORDER`),
          awaitingAuthoritativeTerminalSymbols: [],
          unresolvedQuoteSymbols: [],
        };
      },
    });
    const orderRecorder = createOrderRecorderDouble();
    const lastState = createLastState();
    const marketDataClient = createMarketDataClientDouble({
      getQuotes: async () =>
        new Map([
          ['BULL.HK', createQuoteDouble('BULL.HK', 1.1, 100)],
          ['BEAR.HK', shortQuoteReady ? createQuoteDouble('BEAR.HK', 0.9, 100) : null],
        ]),
    });

    const result = await doomsday.executeClearance({
      currentTime: now,
      isHalfDay: false,
      isLive: alwaysLive,
      positions: lastState.cachedPositions,
      monitorContext: createMonitorContext(monitorConfig, orderRecorder),
      trader,
      marketDataClient,
      lastState,
    });

    expect(result).toEqual({
      executed: true,
      nextRetryAtMs: new Date('2026-02-16T07:56:02.000Z').getTime(),
    });

    now = new Date('2026-02-16T07:56:02.000Z');
    const exhaustedResult = await doomsday.executeClearance({
      currentTime: now,
      isHalfDay: false,
      isLive: alwaysLive,
      positions: lastState.cachedPositions,
      monitorContext: createMonitorContext(monitorConfig, orderRecorder),
      trader,
      marketDataClient,
      lastState,
    });

    shortQuoteReady = true;
    const finalResult = await doomsday.executeClearance({
      currentTime: new Date('2026-02-16T07:56:05.000Z'),
      isHalfDay: false,
      isLive: alwaysLive,
      positions: lastState.cachedPositions,
      monitorContext: createMonitorContext(monitorConfig, orderRecorder),
      trader,
      marketDataClient,
      lastState,
    });

    expect(exhaustedResult).toEqual({ executed: false, nextRetryAtMs: null });
    expect(finalResult).toEqual({ executed: false, nextRetryAtMs: null });
    expect(submittedSymbols).toEqual(['BULL.HK']);
  });

  it('rethrows clearance quote API failures without mutating cached facts', async () => {
    const doomsday = createDoomsdayProtection();
    const monitorConfig = createMonitorConfigDouble();
    const lastState = createLastState();
    let clearCalls = 0;
    const marketDataClient = createMarketDataClientDouble({
      getQuotes: async () => {
        throw await createExternalApiRequestError({
          operation: 'test.getQuotes',
          attempts: 1,
          cause: new Error('quote unavailable'),
        });
      },
    });
    const trader = createTraderDouble();
    const monitorContext = createMonitorContext(
      monitorConfig,
      createOrderRecorderDouble({
        clearBuyOrders: () => {
          clearCalls += 1;
        },
      }),
    );

    let error: unknown = null;
    try {
      await doomsday.executeClearance({
        currentTime: new Date('2026-02-16T07:56:00.000Z'),
        isHalfDay: false,
        isLive: alwaysLive,
        positions: lastState.cachedPositions,
        monitorContext,
        trader,
        marketDataClient,
        lastState,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({ name: 'ExternalApiRequestError' });
    expect(clearCalls).toBe(0);
    expect(lastState.cachedAccount).not.toBeNull();
    expect(lastState.cachedPositions).toHaveLength(2);
    expect(lastState.positionCache.get('BULL.HK')).not.toBeNull();
  });

  it('rethrows clearance execution API failures without clearing caches or order records', async () => {
    const doomsday = createDoomsdayProtection();
    const monitorConfig = createMonitorConfigDouble();
    const lastState = createLastState();
    let clearCalls = 0;
    const trader = createTraderDouble({
      executeDoomsdayClearanceSignals: async () => {
        throw await createExternalApiRequestError({
          operation: 'test.executeSignals',
          attempts: 1,
          cause: new Error('submit unavailable'),
        });
      },
    });
    const monitorContext = createMonitorContext(
      monitorConfig,
      createOrderRecorderDouble({
        clearBuyOrders: () => {
          clearCalls += 1;
        },
      }),
    );
    const marketDataClient = createMarketDataClientDouble({
      getQuotes: async () =>
        new Map([
          ['BULL.HK', createQuoteDouble('BULL.HK', 1.1, 100)],
          ['BEAR.HK', createQuoteDouble('BEAR.HK', 0.9, 100)],
        ]),
    });

    let error: unknown = null;
    try {
      await doomsday.executeClearance({
        currentTime: new Date('2026-02-16T07:56:00.000Z'),
        isHalfDay: false,
        isLive: alwaysLive,
        positions: lastState.cachedPositions,
        monitorContext,
        trader,
        marketDataClient,
        lastState,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({ name: 'ExternalApiRequestError' });
    expect(clearCalls).toBe(0);
    expect(lastState.cachedAccount).not.toBeNull();
    expect(lastState.cachedPositions).toHaveLength(2);
    expect(lastState.positionCache.get('BULL.HK')).not.toBeNull();
  });

  it('propagates clearance execution error when duplicate signals are deduplicated', async () => {
    const doomsday = createDoomsdayProtection();
    const monitorConfig = createMonitorConfigDouble({ monitorSymbol: 'HSI.HK' });
    const lastState = createLastState();

    const trader = createTraderDouble({
      executeDoomsdayClearanceSignals: async () => {
        throw new Error('submit failed');
      },
    });

    let caught: unknown = null;
    try {
      await doomsday.executeClearance({
        currentTime: new Date('2026-02-16T07:56:00.000Z'),
        isHalfDay: false,
        isLive: alwaysLive,
        positions: [
          ...lastState.cachedPositions,
          createPositionDouble({ symbol: 'BULL.HK', quantity: 200, availableQuantity: 200 }),
        ],
        monitorContext: createMonitorContext(monitorConfig),
        trader,
        marketDataClient: createMarketDataClientDouble({
          getQuotes: async () =>
            new Map([
              ['BULL.HK', createQuoteDouble('BULL.HK', 1.1, 100)],
              ['BEAR.HK', createQuoteDouble('BEAR.HK', 0.9, 100)],
            ]),
        }),
        lastState,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      message: 'submit failed',
    });
  });

  it('does not cancel a pending buy after the close-15 live gate expires while loading pending orders', async () => {
    const closeTime = new Date('2026-02-16T08:00:00.000Z');
    let currentTime = new Date('2026-02-16T07:46:00.000Z');
    let cancelCalls = 0;
    const doomsday = createDoomsdayProtection({ now: () => currentTime });
    const trader = createTraderDouble({
      getPendingOrders: async () => {
        currentTime = new Date('2026-02-16T08:01:00.000Z');
        return [
          {
            orderId: 'PENDING-BUY',
            symbol: 'BULL.HK',
            side: OrderSide.Buy,
            submittedPrice: 1,
            quantity: 100,
            executedQuantity: 0,
            status: OrderStatus.New,
            orderType: OrderType.ELO,
          },
        ];
      },
      cancelDoomsdayOrder: async () => {
        cancelCalls += 1;
        return {
          kind: 'CANCEL_CONFIRMED',
          closedReason: 'CANCELED',
          source: 'API',
          relatedBuyOrderIds: null,
        };
      },
    });

    const result = await doomsday.cancelPendingBuyOrders({
      currentTime: new Date('2026-02-16T07:46:00.000Z'),
      isHalfDay: false,
      monitorContext: createMonitorContext(),
      trader,
      isLive: () => currentTime.getTime() < closeTime.getTime(),
    });

    expect(result).toEqual({
      executed: false,
      cancelRequestAcceptedCount: 0,
      nextRetryAtMs: null,
    });
    expect(cancelCalls).toBe(0);
  });

  it('passes the doomsday live gate into Trader cancellation and stops before broker mutation after the gate closes', async () => {
    let isLive = true;
    let cancelSdkCalls = 0;
    const doomsday = createDoomsdayProtection({ now: () => new Date('2026-02-16T07:46:00.000Z') });
    const trader = createTraderDouble({
      getPendingOrders: async () => [
        {
          orderId: 'DOOMSDAY-PENDING-BUY',
          symbol: 'BULL.HK',
          side: OrderSide.Buy,
          submittedPrice: 1,
          quantity: 100,
          executedQuantity: 0,
          status: OrderStatus.New,
          orderType: OrderType.ELO,
        },
      ],
      cancelDoomsdayOrder: async (
        _orderId: string,
        authorization: {
          readonly kind: 'DOOMSDAY_WINDOW';
          readonly beforeBrokerCancel: () => boolean;
        },
      ) => {
        isLive = false;
        if (!authorization.beforeBrokerCancel()) {
          return {
            kind: 'CANCEL_NOT_STARTED',
          };
        }

        cancelSdkCalls += 1;
        return {
          kind: 'CANCEL_CONFIRMED',
          closedReason: 'CANCELED',
          source: 'API',
          relatedBuyOrderIds: null,
        };
      },
    });

    const result = await doomsday.cancelPendingBuyOrders({
      currentTime: new Date('2026-02-16T07:46:00.000Z'),
      isHalfDay: false,
      monitorContext: createMonitorContext(),
      trader,
      isLive: () => isLive,
    });

    expect(result).toEqual({
      executed: false,
      cancelRequestAcceptedCount: 0,
      nextRetryAtMs: null,
    });
    expect(cancelSdkCalls).toBe(0);
  });

  it('keeps doomsday pending-buy cancellation when the permit-internal gate remains open', async () => {
    let cancelSdkCalls = 0;
    const doomsday = createDoomsdayProtection({ now: () => new Date('2026-02-16T07:46:00.000Z') });
    const trader = createTraderDouble({
      getPendingOrders: async () => [
        {
          orderId: 'DOOMSDAY-PENDING-BUY-OPEN',
          symbol: 'BULL.HK',
          side: OrderSide.Buy,
          submittedPrice: 1,
          quantity: 100,
          executedQuantity: 0,
          status: OrderStatus.New,
          orderType: OrderType.ELO,
        },
      ],
      cancelDoomsdayOrder: async (
        _orderId: string,
        authorization: {
          readonly kind: 'DOOMSDAY_WINDOW';
          readonly beforeBrokerCancel: () => boolean;
        },
      ) => {
        expect(authorization.beforeBrokerCancel()).toBeTrue();
        cancelSdkCalls += 1;
        return {
          kind: 'CANCEL_CONFIRMED',
          closedReason: 'CANCELED',
          source: 'API',
          relatedBuyOrderIds: null,
        };
      },
    });

    const result = await doomsday.cancelPendingBuyOrders({
      currentTime: new Date('2026-02-16T07:46:00.000Z'),
      isHalfDay: false,
      monitorContext: createMonitorContext(),
      trader,
      isLive: alwaysLive,
    });

    expect(result).toEqual({
      executed: true,
      cancelRequestAcceptedCount: 1,
      nextRetryAtMs: null,
    });
    expect(cancelSdkCalls).toBe(1);
  });

  it('does not submit clearance after the close-5 live gate expires while loading quotes', async () => {
    const closeTime = new Date('2026-02-16T08:00:00.000Z');
    let currentTime = new Date('2026-02-16T07:56:00.000Z');
    const lastState = createLastState();
    const originalPosition = createPositionDouble({
      symbol: 'BULL.HK',
      quantity: 500,
      availableQuantity: 500,
    });
    lastState.cachedPositions = [originalPosition];
    lastState.positionCache.update(lastState.cachedPositions);
    let executionCalls = 0;
    let clearBuyOrderCalls = 0;
    const monitorContext = createMonitorContext(
      createMonitorConfigDouble(),
      createOrderRecorderDouble({
        clearBuyOrders: () => {
          clearBuyOrderCalls += 1;
        },
      }),
    );
    const doomsday = createDoomsdayProtection({ now: () => currentTime });
    const trader = createTraderDouble({
      executeDoomsdayClearanceSignals: async () => {
        executionCalls += 1;
        return {
          executedOrderIds: ['STALE-CLEARANCE'],
          awaitingAuthoritativeTerminalSymbols: [],
          unresolvedQuoteSymbols: [],
        };
      },
    });

    const result = await doomsday.executeClearance({
      currentTime: new Date('2026-02-16T07:56:00.000Z'),
      isHalfDay: false,
      positions: lastState.cachedPositions,
      monitorContext,
      trader,
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () => {
          currentTime = new Date('2026-02-16T08:01:00.000Z');
          return new Map([['BULL.HK', createQuoteDouble('BULL.HK', 1.1, 100)]]);
        },
      }),
      lastState,
      isLive: () => currentTime.getTime() < closeTime.getTime() && lastState.isTradingEnabled,
    });

    expect(result).toEqual({ executed: false, nextRetryAtMs: null });
    expect(executionCalls).toBe(0);
    expect(clearBuyOrderCalls).toBe(0);
    expect(lastState.cachedAccount).not.toBeNull();
    expect(lastState.cachedPositions).toEqual([originalPosition]);
    expect(lastState.positionCache.get('BULL.HK')).toEqual(originalPosition);
  });

  it('does not mutate local clearance state when the lifecycle gate closes during broker submission', async () => {
    const currentTime = new Date('2026-02-16T07:56:00.000Z');
    const lastState = createLastState();
    const originalPosition = createPositionDouble({
      symbol: 'BULL.HK',
      quantity: 500,
      availableQuantity: 500,
    });
    lastState.cachedPositions = [originalPosition];
    lastState.positionCache.update(lastState.cachedPositions);
    let executionCalls = 0;
    let committedCalls = 0;
    let clearBuyOrderCalls = 0;
    const monitorContext = createMonitorContext(
      createMonitorConfigDouble(),
      createOrderRecorderDouble({
        clearBuyOrders: () => {
          clearBuyOrderCalls += 1;
        },
      }),
    );
    const doomsday = createDoomsdayProtection({ now: () => currentTime });
    const trader = createTraderDouble({
      executeDoomsdayClearanceSignals: async () => {
        executionCalls += 1;
        lastState.isTradingEnabled = false;
        return {
          executedOrderIds: ['SUBMITTED-BEFORE-CLOSE'],
          awaitingAuthoritativeTerminalSymbols: [],
          unresolvedQuoteSymbols: [],
        };
      },
    });

    const result = await doomsday.executeClearance({
      currentTime,
      isHalfDay: false,
      positions: lastState.cachedPositions,
      monitorContext,
      trader,
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () => new Map([['BULL.HK', createQuoteDouble('BULL.HK', 1.1, 100)]]),
      }),
      lastState,
      onPositionsCommitted: async () => {
        committedCalls += 1;
      },
      isLive: () => lastState.isTradingEnabled,
    });

    expect(result).toEqual({ executed: true, nextRetryAtMs: null });
    expect(executionCalls).toBe(1);
    expect(committedCalls).toBe(0);
    expect(clearBuyOrderCalls).toBe(0);
    expect(lastState.cachedAccount).not.toBeNull();
    expect(lastState.cachedPositions).toEqual([originalPosition]);
    expect(lastState.positionCache.get('BULL.HK')).toEqual(originalPosition);
  });
});
