import { createRuntimeStateFixtures } from '../helpers/runtimeStateFixtures.js';
import { scheduleBoundedOneShotAt } from '../../src/runtime/timer/index.js';
import { wrapExternalApiRequest } from '../../src/infrastructure/externalApi/index.js';
import { nowMonotonicMs, wait } from '../../src/infrastructure/time/index.js';

import type { TradeRuntime } from '../../src/app/runtime/types.js';
import type { RuntimeStateFixtures } from '../helpers/types.js';

/**
 * doomsday 集成测试
 *
 * 功能：
 * - 验证末日保护端到端场景与业务期望。
 */
import { createTradeRuntime } from '../../src/app/runtime/createTradeRuntime.js';
import { afterEach, describe, expect, it, setSystemTime } from 'bun:test';

import { createTradingConfig } from '../../mock/factories/configFactory.js';
import { createSignal } from '../../mock/factories/signalFactory.js';
import { createDoomsdayBrokerFixture } from '../infrastructure/longbridge/trade/doomsdayBrokerFixture.js';
import type { BrokerAccess } from '../../src/types/brokerAccessPorts.js';
import { createAccountPositionSnapshot } from '../../src/application/accountPositionSnapshot/index.js';
import type { AccountPositionSnapshot } from '../../src/types/accountPosition.js';
import type { Position } from '../../src/types/account.js';
import { createDoomsdayClearanceWorkflow } from '../../src/application/doomsdayClearance/index.js';
import { createOrderExecutor as createOrderExecutorCore } from '../../src/application/orderExecution/index.js';
import { timeWakeupEvaluationProgram } from '../../src/runtime/timeWakeupEvaluationProgram/index.js';
import type { PendingSellOrderSnapshot, TrackOrderParams } from '../../src/domain/order/types.js';
import type { DoomsdayClearanceCommand } from '../../src/types/signal.js';
import type { PendingOrder } from '../../src/types/orderReadMetadata.js';
import type { MarketDataClient } from '../../src/types/marketPorts.js';
import type { TimeWakeupEvaluationContext } from '../../src/runtime/timeWakeupEvaluationProgram/types.js';
import type { CancelOrderOutcome } from '../../src/types/orderCancellation.js';
import { createBrokerIngressFixture } from './architectureRefactoringP1Native/trade/brokerIngressFixture.js';
import { createExternalApiRequestError } from '../helpers/createExternalApiRequestError.js';
import { getRequiredHKDateKey } from '../../src/utils/time/index.js';

import type { MonitorContextAssembly } from '../../src/app/context/types.js';

import {
  createTerminationDouble,
  createAccountSnapshotDouble,
  createSeatSwitchWorkflowDouble,
  createDailyLossTrackerDouble,
  createMarketDataClientDouble,
  createLoggerDouble,
  createMonitorConfigDouble,
  createMonitorContextDouble,
  createOrderMonitorDouble,
  createOrderRecorderDouble,
  createPositionDouble,
  createProtectiveLiquidationEpisodeTrackerDouble,
  createQuoteDouble,
  createRateLimiterDouble,
  createRiskCheckerDouble,
  createStrategyDouble,
  createSymbolRegistryDouble,
  createTradeRuntimeDouble,
  createUnrealizedLossMonitorDouble,
} from '../helpers/testDoubles.js';

async function createPendingDoomsdayOrder(
  orderId: string,
  submittedAtMs: number,
): Promise<PendingSellOrderSnapshot> {
  const native = await createBrokerIngressFixture({
    orderId,
    tradeId: `T-${orderId}`,
    symbol: 'BULL.HK',
    stockName: 'BULL',
    remark: '',
    side: 'SELL',
    orderType: 'ELO',
    status: 'New',
    quantity: '100',
    executedQuantity: '0',
    submittedPrice: '1',
    executedPrice: '0',
    submittedAtMs,
    executionTimeMs: null,
    updatedAtMs: submittedAtMs,
  });
  const fact = native.queryObservation;
  return {
    orderId: fact.orderId,
    symbol: fact.symbol,
    side: fact.executionSide,
    status: fact.status,
    orderType: fact.orderType,
    submittedPrice: fact.price,
    submittedQuantity: fact.quantity,
    executedQuantity: fact.executedQuantity,
    submittedAt: fact.submittedAt.getTime(),
    isProtectiveLiquidation: false,
  };
}

const BUY_CUTOFF_TEST_NOW = new Date('2026-02-16T07:50:00.000Z');

async function createPendingCutoffOrder(
  input: Readonly<{
    orderId: string;
    symbol: string;
    side: 'BUY' | 'SELL';
    submittedPrice: string | null;
    quantity: number;
    executedQuantity: number;
    orderType: 'ELO' | 'MO';
  }>,
): Promise<PendingOrder> {
  const native = await createBrokerIngressFixture({
    orderId: input.orderId,
    tradeId: 'T-' + input.orderId,
    symbol: input.symbol,
    stockName: input.symbol,
    remark: '',
    side: input.side,
    orderType: input.orderType,
    status: 'New',
    quantity: String(input.quantity),
    executedQuantity: String(input.executedQuantity),
    submittedPrice: input.submittedPrice ?? '0',
    executedPrice: '0',
    submittedAtMs: BUY_CUTOFF_TEST_NOW.getTime(),
    executionTimeMs: null,
    updatedAtMs: BUY_CUTOFF_TEST_NOW.getTime(),
  });
  const fact = native.queryObservation;
  return {
    orderId: fact.orderId,
    symbol: fact.symbol,
    side: fact.executionSide,
    status: fact.status,
    orderType: fact.orderType,
    submittedPrice: input.submittedPrice,
    quantity: fact.quantity,
    executedQuantity: fact.executedQuantity,
  };
}

const alwaysLive = (): boolean => true;
const CLEARANCE_TEST_NOW = new Date('2026-02-16T07:56:00.000Z');

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
      new Map([...symbols].map((symbol) => [symbol, createQuoteDouble(symbol, '1.1', 100)])),
  });
}

async function createRealDoomsdayTrader(params: {
  readonly brokerAccess: () => BrokerAccess;
  readonly tradingConfig: ReturnType<typeof createTradingConfig>;
  readonly marketDataClient: MarketDataClient;
  readonly symbolRegistry: MonitorContextAssembly['symbolRegistry'];
  readonly now: () => Date;
  readonly isExecutionAllowed?: () => boolean;
}): Promise<TradeRuntime> {
  return createTradeRuntime({
    logger: createLoggerDouble(),
    wait: wait,
    nowMonotonicMs: nowMonotonicMs,
    requestExternalApi: wrapExternalApiRequest,
    scheduleBoundedOneShotAt: scheduleBoundedOneShotAt,
    brokerAccess: params.brokerAccess,
    scheduleTimer: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer: (handle) => {
      clearTimeout(handle);
    },
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
    termination: createTerminationDouble({
      reportFatalError: (error) => {
        throw error;
      },
    }),
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

const snapshotFixtures = new WeakMap<
  RuntimeStateFixtures,
  Readonly<{
    snapshot: AccountPositionSnapshot;
    publishPositions: (positions: ReadonlyArray<Position>) => Promise<void>;
  }>
>();
function snapshotOf(state: RuntimeStateFixtures): AccountPositionSnapshot {
  const fixture = snapshotFixtures.get(state);
  if (!fixture) throw new Error('missing canonical fixture');

  return fixture.snapshot;
}

async function publishPositions(
  state: RuntimeStateFixtures,
  positions: ReadonlyArray<Position>,
): Promise<void> {
  const fixture = snapshotFixtures.get(state);
  if (!fixture) throw new Error('missing canonical fixture');

  await fixture.publishPositions(positions);
}

async function createRuntimeStates(): Promise<RuntimeStateFixtures> {
  const state: RuntimeStateFixtures = createRuntimeStateFixtures({
    tradingTimeState: { canTrade: true, isHalfDay: false, openProtectionActive: false },
    lifecycleState: {
      currentDayKey: '2026-02-16',
      lifecycleState: 'ACTIVE',
      pendingOpenRebuild: false,
      isTradingEnabled: true,
    },
    tradingCalendarState: { cachedTradingDayInfo: null, tradingCalendarSnapshot: new Map() },
    quoteSubscriptionState: { allTradingSymbols: new Set(['BULL.HK', 'BEAR.HK']) },
  });
  let brokerPositions: ReadonlyArray<Position> = [
    createPositionDouble({ symbol: 'BULL.HK', quantity: 500, availableQuantity: 500 }),
    createPositionDouble({ symbol: 'BEAR.HK', quantity: 300, availableQuantity: 300 }),
  ];
  const snapshot = createAccountPositionSnapshot({
    dayEpoch: 1,
    scheduler: { schedule: queueMicrotask },
    readPort: {
      getAccountSnapshot: async () => createAccountSnapshotDouble('100000'),
      getStockPositions: async () => brokerPositions,
    },
    reportFatalError: (error) => {
      throw error;
    },
  });
  const publish = async (positions: ReadonlyArray<Position>) => {
    brokerPositions = positions;
    const handle = snapshot.requestRefresh({
      source: 'TEST_BROKER_FACT',
      dayEpoch: 1,
      refreshAccount: true,
      refreshPositions: true,
    });
    const receipt = await handle.result.finally(handle.cancel);
    if (receipt.status !== 'COMMITTED') throw new Error('fixture refresh aborted');
  };
  snapshotFixtures.set(state, { snapshot, publishPositions: publish });
  await publish(brokerPositions);
  return state;
}

function createMonitorContext(
  config = createMonitorConfigDouble(),
  orderRecorder = createOrderRecorderDouble(),
): MonitorContextAssembly {
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

    symbolRegistry,
    seatSwitch: createSeatSwitchWorkflowDouble(),
    strategy: createStrategyDouble(),
    orderRecorder,
    dailyLossTracker: createDailyLossTrackerDouble(),
    riskChecker: createRiskCheckerDouble(),
    unrealizedLossMonitor: createUnrealizedLossMonitorDouble(),
    longSymbolName: 'BULL.HK',
    shortSymbolName: 'BEAR.HK',
    monitorSymbolName: config.monitorSymbol,
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
    relatedBuyOrderIds: ['OLD-BUY'],
    terminalExecution: {
      submittedQuantity: params.submittedQuantity,
      executedQuantity: params.executedQuantity,
    },
  };
}

afterEach(() => {});

describe('doomsday integration', () => {
  it('routes valid close-5 clearance through the dedicated Trader entry to OrderExecutor submission', async () => {
    const currentTime = new Date('2026-02-16T07:56:00.000Z');
    const monitorConfig = createMonitorConfigDouble();
    const tradingConfig = createTradingConfig({ monitor: monitorConfig });
    const monitorContext = createMonitorContext(monitorConfig);
    const broker = createDoomsdayBrokerFixture([
      {
        symbol: 'BULL.HK',
        quantity: 100,
        availableQuantity: 100,
      },
    ]);
    const marketDataClient = createMarketDataClientDouble({
      getQuotes: async () => new Map([['BULL.HK', createQuoteDouble('BULL.HK', '1.1', 100)]]),
    });
    const tradeRuntime = await createRealDoomsdayTrader({
      brokerAccess: broker.brokerAccess,
      tradingConfig,
      marketDataClient,
      symbolRegistry: monitorContext.symbolRegistry,
      now: () => currentTime,
    });
    const stateFixtures = await createRuntimeStates();
    const position = createPositionDouble({
      symbol: 'BULL.HK',
      quantity: 100,
      availableQuantity: 100,
    });
    await publishPositions(stateFixtures, [position]);

    setSystemTime(currentTime);
    try {
      const result = await createDoomsdayClearanceWorkflow({
        logger: createLoggerDouble(),
        now: () => currentTime,
      }).executeClearance({
        currentTime,
        isHalfDay: false,
        isLive: alwaysLive,
        positions: snapshotOf(stateFixtures).getView().positions,
        monitorContext,
        orderExecutor: tradeRuntime.orderExecutor,
        marketDataClient,
        ...stateFixtures,
        snapshot: snapshotOf(stateFixtures),
      });

      expect(result).toEqual({ executed: true, nextRetryAtMs: null });
      const submitPayload = broker.getSubmissions()[0];
      if (submitPayload === undefined) {
        throw new TypeError('expected OrderExecutor to submit the clearance order');
      }

      expect(broker.getCallCounts().submitOrder).toBe(1);
      expect(submitPayload.side).toBe('SELL');
      expect(submitPayload.quantity).toBe('100');
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
    const switchingMonitorContext: MonitorContextAssembly = {
      ...monitorContext,
      seatSwitch: {
        ...monitorContext.seatSwitch,
        hasPendingSwitch: () => true,
      },
    };
    const stateFixtures = await createRuntimeStates();
    const bullPosition = createPositionDouble({
      symbol: 'BULL.HK',
      quantity: 500,
      availableQuantity: 500,
    });
    await publishPositions(stateFixtures, [bullPosition]);

    const submittedCommands: ReadonlyArray<unknown>[] = [];
    const tradeRuntime = createTradeRuntimeDouble({
      orderExecutor: {
        executeDoomsdayClearanceSignals: async (commands) => {
          submittedCommands.push([...commands]);
          return {
            executedOrderIds: ['DOOMSDAY-SWITCHING-OLD'],
            awaitingAuthoritativeTerminalSymbols: [],
            unresolvedQuoteSymbols: [],
          };
        },
      },
    });

    const result = await createDoomsdayClearanceWorkflow({
      logger: createLoggerDouble(),
      now: () => currentTime,
    }).executeClearance({
      currentTime,
      isHalfDay: false,
      isLive: alwaysLive,
      positions: snapshotOf(stateFixtures).getView().positions,
      monitorContext: switchingMonitorContext,
      orderExecutor: tradeRuntime.orderExecutor,
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () => new Map([['BULL.HK', createQuoteDouble('BULL.HK', '1.1', 100)]]),
      }),
      ...stateFixtures,
      snapshot: snapshotOf(stateFixtures),
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
    const broker = createDoomsdayBrokerFixture([
      {
        symbol: 'BULL.HK',
        quantity: 500,
        availableQuantity: 500,
      },
    ]);

    const cancelOrderIds: string[] = [];
    let pendingSellVisible = true;
    const trackedOrders: TrackOrderParams[] = [];
    const pendingOrder = await createPendingDoomsdayOrder(
      'SELL-ORDINARY-ELO',
      currentTime.getTime(),
    );
    const orderMonitor = createOrderMonitorDouble({
      trackOrder: (params) => {
        trackedOrders.push(params);
      },
      cancelOrder: async (orderId) => {
        cancelOrderIds.push(orderId);
        return {
          kind: 'CANCEL_CONFIRMED' as const,
          relatedBuyOrderIds: ['BUY-ORDINARY'],
        };
      },
      getPendingSellOrders: () =>
        pendingSellVisible
          ? [
              {
                ...pendingOrder,
                submittedAt: currentTime.getTime(),
              },
            ]
          : [],
    });

    const mappedBuys = await Promise.all(
      ['BUY-ORDINARY', 'BUY-FRESH'].map(async (orderId) => {
        const ingress = await createBrokerIngressFixture({
          orderId,
          tradeId: 'T-' + orderId,
          symbol: 'BULL.HK',
          stockName: 'BULL',
          remark: '',
          side: 'BUY',
          status: 'Filled',
          quantity: '100',
          executedQuantity: '100',
          submittedPrice: '1',
          executedPrice: '1',
          submittedAtMs: currentTime.getTime(),
          executionTimeMs: currentTime.getTime(),
          updatedAtMs: currentTime.getTime(),
        });
        const fact = ingress.queryObservation;
        if (fact.executionTimeMs === null)
          throw new Error('expected actual ingress execution time');

        return {
          orderId: fact.orderId,
          symbol: fact.symbol,
          costAmount: fact.executedAmount,
          executedQuantity: fact.executedQuantity,
          executedTime: fact.executionTimeMs,
          submittedAt: fact.submittedAt,
          updatedAt: fact.updatedAt ?? undefined,
        };
      }),
    );
    const submittedSellLinks: Array<ReadonlyArray<string>> = [];
    const orderRecorder = createOrderRecorderDouble({
      getBuyOrdersForSymbol: () => mappedBuys,
      getPendingSellSnapshot: () => [
        {
          orderId: 'SELL-ORDINARY-ELO',
          symbol: 'BULL.HK',
          direction: 'LONG',
          submittedQuantity: 100,
          filledQuantity: 0,
          relatedBuyOrderIds: ['BUY-ORDINARY'],
          status: 'pending',
          isProtectiveLiquidation: false,
          submittedAt: currentTime.getTime(),
        },
      ],
      submitSellOrder: (_orderId, _symbol, _direction, _quantity, relatedBuyOrderIds) => {
        submittedSellLinks.push(relatedBuyOrderIds);
      },
    });

    const orderExecutor = createOrderExecutor({
      logger: createLoggerDouble(),
      tradeMutationPort: broker.ports.createTradeMutationPort(),
      readSellPositions: broker.ports.createSellPositionReader(),
      rateLimiter: createRateLimiterDouble(),
      marketDataClient: createDoomsdayExecutionQuoteClient(),
      cacheManager: { clearCache: () => {} },
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

    const beforeTerminalResult = await orderExecutor.executeDoomsdayClearanceSignals(
      [clearanceCommand],
      alwaysLive,
    );

    expect(broker.getCallCounts().replaceOrder).toBe(0);
    expect(beforeTerminalResult.executedOrderIds).toEqual([]);
    expect(Reflect.get(beforeTerminalResult, 'awaitingAuthoritativeTerminalSymbols')).toEqual([
      'BULL.HK',
    ]);
    expect(broker.getCallCounts().stockPositions).toBe(0);
    expect(broker.getCallCounts().submitOrder).toBe(0);

    const repeatedBeforeTerminalResult = await orderExecutor.executeDoomsdayClearanceSignals(
      [clearanceCommand],
      alwaysLive,
    );

    expect(repeatedBeforeTerminalResult.executedOrderIds).toEqual([]);
    expect(
      Reflect.get(repeatedBeforeTerminalResult, 'awaitingAuthoritativeTerminalSymbols'),
    ).toEqual(['BULL.HK']);
    expect(cancelOrderIds).toEqual(['SELL-ORDINARY-ELO']);
    expect(broker.getCallCounts().stockPositions).toBe(0);
    expect(broker.getCallCounts().submitOrder).toBe(0);

    // WebSocket/权威订单终态已经从 pending 视图移除该旧单。
    pendingSellVisible = false;
    const result = await orderExecutor.executeDoomsdayClearanceSignals(
      [clearanceCommand],
      alwaysLive,
    );

    expect(result.executedOrderIds).toEqual(['MOCK-000001']);
    expect(cancelOrderIds).toEqual(['SELL-ORDINARY-ELO']);
    expect(broker.getCallCounts().stockPositions).toBe(1);
    expect(broker.getCallCounts().submitOrder).toBe(1);
    expect(submittedSellLinks).toEqual([]);

    const submitPayload = broker.getSubmissions()[0];
    if (submitPayload === undefined) {
      throw new TypeError('expected doomsday clearance submit payload');
    }

    expect(trackedOrders[0]?.side).toBe('SELL');
    expect(submitPayload.side).toBe('SELL');
    expect(submitPayload.orderType).toBe('ELO');
    expect(submitPayload.quantity).toBe('500');
    expect(submitPayload.remark).toBe('QuantDemo');
    expect(trackedOrders).toHaveLength(1);
    expect(trackedOrders[0]?.isProtectiveLiquidation).toBeFalse();
    expect(trackedOrders[0]?.orderType).toBe('ELO');
  });

  it('uses the actual time-wakeup chain to retry an acknowledged cancellation, then submits only after a WebSocket terminal fact', async () => {
    let currentTime = new Date('2026-02-16T07:56:00.000Z');
    const retryIntervalMs = 1_000;
    const monitorConfig = createMonitorConfigDouble();
    const monitorContext = createMonitorContext(monitorConfig);
    const tradingConfig = createTradingConfig({ monitor: monitorConfig });
    const broker = createDoomsdayBrokerFixture([
      {
        symbol: 'BULL.HK',
        quantity: 500,
        availableQuantity: 500,
      },
    ]);
    const cancelOrderIds: string[] = [];
    let pendingSellVisible = true;
    const pendingOrder = await createPendingDoomsdayOrder('SELL-WAITING-WS', currentTime.getTime());
    const orderExecutor = createOrderExecutor({
      logger: createLoggerDouble(),
      tradeMutationPort: broker.ports.createTradeMutationPort(),
      readSellPositions: broker.ports.createSellPositionReader(),
      rateLimiter: createRateLimiterDouble(),
      marketDataClient: createDoomsdayExecutionQuoteClient(),
      cacheManager: { clearCache: () => {} },
      orderMonitor: createOrderMonitorDouble({
        trackOrder: () => {},
        cancelOrder: async (orderId) => {
          cancelOrderIds.push(orderId);
          return {
            kind: 'CANCEL_CONFIRMED',
            relatedBuyOrderIds: null,
          };
        },
        getPendingSellOrders: () =>
          pendingSellVisible
            ? [
                {
                  ...pendingOrder,
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
    const tradeRuntime = createTradeRuntimeDouble({
      orderExecutor: {
        executeDoomsdayClearanceSignals: (commands) =>
          orderExecutor.executeDoomsdayClearanceSignals(commands, alwaysLive),
      },
    });
    const stateFixtures = await createRuntimeStates();
    await publishPositions(stateFixtures, [
      createPositionDouble({ symbol: 'BULL.HK', quantity: 500, availableQuantity: 500 }),
    ]);

    const context: TimeWakeupEvaluationContext = {
      logger: createLoggerDouble(),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () => new Map([['BULL.HK', createQuoteDouble('BULL.HK', '1.1', 100)]]),
      }),
      cacheManager: tradeRuntime.cacheManager,
      orderMonitor: tradeRuntime.orderMonitor,
      orderExecutor: tradeRuntime.orderExecutor,
      ...stateFixtures,
      doomsdayClearanceWorkflow: createDoomsdayClearanceWorkflow({
        logger: createLoggerDouble(),
        now: () => currentTime,
        quoteRetryIntervalMs: retryIntervalMs,
      }),
      tradingConfig,
      monitorContext,
      tradingGateEventRuntime: {
        emitGateStateChanged: () => {},
        emitAutoSearchAuthorizationChanged: () => {},
      },
      snapshot: snapshotOf(stateFixtures),
      dayLifecycleManager: {
        tick: async () => ({ nextRetryAtMs: null, pendingOpenRebuild: false }),
      },
      now: () => currentTime,
    };

    setSystemTime(currentTime);
    try {
      const firstResult = await timeWakeupEvaluationProgram(context);
      const retryAtMs = currentTime.getTime() + retryIntervalMs;

      expect(firstResult.plan.nextWakeupAtMs).toBe(retryAtMs);
      expect(cancelOrderIds).toEqual(['SELL-WAITING-WS']);
      expect(broker.getCallCounts().submitOrder).toBe(0);

      // 模拟订单 WebSocket 已将撤单终态收敛到 OrderMonitor 的 pending 事实。
      pendingSellVisible = false;
      currentTime = new Date(retryAtMs);
      setSystemTime(currentTime);
      const afterTerminalResult = await timeWakeupEvaluationProgram(context);

      expect(afterTerminalResult.plan.nextWakeupAtMs).not.toBe(retryAtMs);
      expect(cancelOrderIds).toEqual(['SELL-WAITING-WS']);
      expect(broker.getCallCounts().stockPositions).toBe(1);
      expect(broker.getCallCounts().submitOrder).toBe(1);
      const submitPayload = broker.getSubmissions()[0];
      if (submitPayload === undefined) {
        throw new TypeError('expected fresh doomsday order after WebSocket terminal');
      }

      expect(submitPayload.quantity).toBe('500');
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
      const broker = createDoomsdayBrokerFixture([
        {
          symbol: 'BULL.HK',
          quantity: scenario.freshAvailableQuantity,
          availableQuantity: scenario.freshAvailableQuantity,
        },
      ]);
      const cancelOrderIds: string[] = [];
      const pendingOrders = await Promise.all(
        scenario.terminalOutcomes.map((_, index) =>
          createPendingDoomsdayOrder(`SELL-OLD-${String(index + 1)}`, currentTime.getTime()),
        ),
      );
      let outcomeIndex = 0;
      const closedOrderIds = new Set<string>();
      const orderExecutor = createOrderExecutor({
        logger: createLoggerDouble(),
        tradeMutationPort: broker.ports.createTradeMutationPort(),
        readSellPositions: broker.ports.createSellPositionReader(),
        rateLimiter: createRateLimiterDouble(),
        marketDataClient: createDoomsdayExecutionQuoteClient(),
        cacheManager: { clearCache: () => {} },
        orderMonitor: createOrderMonitorDouble({
          trackOrder: () => {},
          cancelOrder: async (orderId) => {
            cancelOrderIds.push(orderId);
            const outcome = scenario.terminalOutcomes[outcomeIndex];
            outcomeIndex += 1;
            if (outcome === undefined) {
              throw new Error(`unexpected cancel request for ${scenario.name}: ${orderId}`);
            }

            if (outcome.kind === 'ALREADY_CLOSED') closedOrderIds.add(orderId);

            return outcome;
          },
          getPendingSellOrders: () =>
            pendingOrders
              .filter((pendingOrder) => !closedOrderIds.has(pendingOrder.orderId))
              .map((pendingOrder) => ({
                ...pendingOrder,
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

      const result = await orderExecutor.executeDoomsdayClearanceSignals(
        [createDoomsdayClearanceCommand(currentTime)],
        alwaysLive,
      );

      expect(result.executedOrderIds).toEqual(['MOCK-000001']);
      expect(cancelOrderIds).toHaveLength(scenario.terminalOutcomes.length);
      expect(broker.getCallCounts().replaceOrder).toBe(0);
      expect(broker.getCallCounts().stockPositions).toBe(1);
      const submitPayload = broker.getSubmissions()[0];
      if (submitPayload === undefined) {
        throw new TypeError(`expected fresh doomsday order for ${scenario.name}`);
      }

      expect(submitPayload.quantity).toBe(String(scenario.freshAvailableQuantity));
    }
  });

  it('does not schedule a terminal wait past close or submit after the clearance window', async () => {
    const closeTime = new Date('2026-02-16T08:00:00.000Z');
    const beforeClose = new Date(closeTime.getTime() - 100);
    const monitorConfig = createMonitorConfigDouble();
    const monitorContext = createMonitorContext(monitorConfig);
    const stateFixtures = await createRuntimeStates();
    await publishPositions(stateFixtures, [
      createPositionDouble({ symbol: 'BULL.HK', quantity: 500, availableQuantity: 500 }),
    ]);

    let executionCalls = 0;
    const tradeRuntime = createTradeRuntimeDouble({
      orderExecutor: {
        executeDoomsdayClearanceSignals: async () => {
          executionCalls += 1;
          return {
            executedOrderIds: [],
            awaitingAuthoritativeTerminalSymbols: ['BULL.HK'],
            unresolvedQuoteSymbols: [],
          };
        },
      },
    });
    const doomsdayWorkflow = createDoomsdayClearanceWorkflow({
      logger: createLoggerDouble(),
      now: () => beforeClose,
      quoteRetryIntervalMs: 200,
    });
    const context = {
      isHalfDay: false,
      isLive: alwaysLive,
      positions: snapshotOf(stateFixtures).getView().positions,
      monitorContext,
      cacheManager: tradeRuntime.cacheManager,
      orderMonitor: tradeRuntime.orderMonitor,
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () => new Map([['BULL.HK', createQuoteDouble('BULL.HK', '1.1', 100)]]),
      }),
      ...stateFixtures,
      snapshot: snapshotOf(stateFixtures),
    };

    const beforeCloseResult = await doomsdayWorkflow.executeClearance({
      orderExecutor: tradeRuntime.orderExecutor,
      ...context,
      currentTime: beforeClose,
    });
    const afterCloseResult = await doomsdayWorkflow.executeClearance({
      orderExecutor: tradeRuntime.orderExecutor,
      ...context,
      currentTime: closeTime,
    });

    expect(beforeCloseResult.nextRetryAtMs).toBeNull();
    expect(afterCloseResult.executed).toBeFalse();
    expect(executionCalls).toBe(1);
  });

  it('uses the injected clock for close-15 retry and close-5 signal time when system time differs', async () => {
    const systemTime = new Date('2035-01-02T02:00:00.000Z');
    const buyCutoffTime = new Date('2026-02-16T07:50:00.000Z');
    const clearanceTime = new Date('2026-02-16T07:56:00.000Z');
    setSystemTime(systemTime);

    try {
      const cancelResult = await createDoomsdayClearanceWorkflow({
        logger: createLoggerDouble(),
        now: () => buyCutoffTime,
        quoteRetryIntervalMs: 2_000,
      }).cancelPendingBuyOrders({
        currentTime: buyCutoffTime,
        isHalfDay: false,
        isLive: alwaysLive,
        monitorContext: createMonitorContext(),
        ...createTradeRuntimeDouble({
          cacheManager: {
            getPendingOrders: async () => [
              await createPendingCutoffOrder({
                orderId: 'BUY-INJECTED-CLOCK',
                symbol: 'BULL.HK',
                side: 'BUY',
                submittedPrice: '1',
                quantity: 100,
                executedQuantity: 0,
                orderType: 'ELO',
              }),
            ],
          },
          orderMonitor: {
            cancelDoomsdayOrder: async () => ({
              kind: 'UNKNOWN_FAILURE',
              errorCode: null,
            }),
          },
        }),
      });

      const submittedSignalTimes: Date[] = [];
      const stateFixtures = await createRuntimeStates();
      await publishPositions(stateFixtures, [
        createPositionDouble({ symbol: 'BULL.HK', quantity: 100, availableQuantity: 100 }),
      ]);

      await createDoomsdayClearanceWorkflow({
        logger: createLoggerDouble(),
        now: () => clearanceTime,
      }).executeClearance({
        currentTime: clearanceTime,
        isHalfDay: false,
        isLive: alwaysLive,
        positions: snapshotOf(stateFixtures).getView().positions,
        monitorContext: createMonitorContext(),
        ...createTradeRuntimeDouble({
          orderExecutor: {
            executeDoomsdayClearanceSignals: async (signals) => {
              const signalTime = signals[0]?.triggerTime;
              if (signalTime) {
                submittedSignalTimes.push(signalTime);
              }

              return {
                executedOrderIds: ['SELL-INJECTED-CLOCK'],
                awaitingAuthoritativeTerminalSymbols: [],
                unresolvedQuoteSymbols: [],
              };
            },
          },
        }),
        marketDataClient: createMarketDataClientDouble({
          getQuotes: async () => new Map([['BULL.HK', createQuoteDouble('BULL.HK', '1.1', 100)]]),
        }),
        ...stateFixtures,
        snapshot: snapshotOf(stateFixtures),
      });

      expect(new Date()).toEqual(systemTime);
      expect(cancelResult.nextRetryAtMs).toBe(buyCutoffTime.getTime() + 2_000);
      expect(submittedSignalTimes).toEqual([clearanceTime]);
    } finally {
      setSystemTime();
    }
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
      const stateFixtures = await createRuntimeStates();
      await publishPositions(stateFixtures, [
        createPositionDouble({ symbol: 'BULL.HK', quantity: 100, availableQuantity: 100 }),
      ]);

      const terminalResult = await createDoomsdayClearanceWorkflow({
        logger: createLoggerDouble(),
        now: () => currentTime,
        quoteRetryIntervalMs: 200,
      }).executeClearance({
        currentTime,
        isHalfDay: scenario.isHalfDay,
        isLive: alwaysLive,
        positions: snapshotOf(stateFixtures).getView().positions,
        monitorContext,
        ...createTradeRuntimeDouble({
          orderExecutor: {
            executeDoomsdayClearanceSignals: async () => ({
              executedOrderIds: [],
              awaitingAuthoritativeTerminalSymbols: ['BULL.HK'],
              unresolvedQuoteSymbols: [],
            }),
          },
        }),
        marketDataClient: createMarketDataClientDouble({
          getQuotes: async () => new Map([['BULL.HK', createQuoteDouble('BULL.HK', '1.1', 100)]]),
        }),
        ...stateFixtures,
        snapshot: snapshotOf(stateFixtures),
      });

      expect(terminalResult.nextRetryAtMs, `${scenario.label} terminal`).toBeNull();

      const missingQuoteState = await createRuntimeStates();
      await publishPositions(missingQuoteState, [
        createPositionDouble({ symbol: 'BULL.HK', quantity: 100, availableQuantity: 100 }),
      ]);

      const missingQuoteResult = await createDoomsdayClearanceWorkflow({
        logger: createLoggerDouble(),
        now: () => currentTime,
        quoteRetryIntervalMs: 200,
      }).executeClearance({
        currentTime,
        isHalfDay: scenario.isHalfDay,
        isLive: alwaysLive,
        positions: snapshotOf(missingQuoteState).getView().positions,
        monitorContext: createMonitorContext(),
        ...createTradeRuntimeDouble(),
        marketDataClient: createMarketDataClientDouble({
          getQuotes: async () => new Map([['BULL.HK', null]]),
        }),
        ...missingQuoteState,
        snapshot: snapshotOf(missingQuoteState),
      });

      expect(missingQuoteResult.nextRetryAtMs, `${scenario.label} missing quote`).toBeNull();

      const unknownCancelResult = await createDoomsdayClearanceWorkflow({
        logger: createLoggerDouble(),
        now: () => currentTime,
        quoteRetryIntervalMs: 200,
      }).cancelPendingBuyOrders({
        currentTime,
        isHalfDay: scenario.isHalfDay,
        isLive: alwaysLive,
        monitorContext: createMonitorContext(),
        ...createTradeRuntimeDouble({
          cacheManager: {
            getPendingOrders: async () => [
              await createPendingCutoffOrder({
                orderId: `UNKNOWN-CANCEL-${scenario.label}`,
                symbol: 'BULL.HK',
                side: 'BUY',
                submittedPrice: '1',
                quantity: 100,
                executedQuantity: 0,
                orderType: 'ELO',
              }),
            ],
          },
          orderMonitor: {
            cancelDoomsdayOrder: async () => ({
              kind: 'UNKNOWN_FAILURE',
              errorCode: null,
            }),
          },
        }),
      });

      expect(unknownCancelResult.nextRetryAtMs, `${scenario.label} unknown cancel`).toBeNull();
    }
  });

  it('clears a missing-quote retry due time when the close window rejects its candidate', async () => {
    const closeMs = new Date('2026-02-16T08:00:00.000Z').getTime();
    let currentTime = new Date(closeMs - 100);
    const stateFixtures = await createRuntimeStates();
    await publishPositions(stateFixtures, [
      createPositionDouble({ symbol: 'BULL.HK', quantity: 100, availableQuantity: 100 }),
    ]);

    const doomsday = createDoomsdayClearanceWorkflow({
      logger: createLoggerDouble(),
      now: () => currentTime,
      quoteRetryIntervalMs: 200,
    });
    const context = {
      isHalfDay: false,
      isLive: alwaysLive,
      positions: snapshotOf(stateFixtures).getView().positions,
      monitorContext: createMonitorContext(),
      tradeRuntime: createTradeRuntimeDouble(),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () => new Map([['BULL.HK', null]]),
      }),
      ...stateFixtures,
      snapshot: snapshotOf(stateFixtures),
    };

    const firstResult = await doomsday.executeClearance({
      orderExecutor: context.tradeRuntime.orderExecutor,
      ...context,
      currentTime,
    });

    expect(firstResult.nextRetryAtMs).toBeNull();

    currentTime = new Date(closeMs - 50);
    const secondResult = await doomsday.executeClearance({
      orderExecutor: context.tradeRuntime.orderExecutor,
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
      const terminalState = await createRuntimeStates();
      await publishPositions(terminalState, [
        createPositionDouble({ symbol: 'BULL.HK', quantity: 100, availableQuantity: 100 }),
      ]);

      const terminalResult = await createDoomsdayClearanceWorkflow({
        logger: createLoggerDouble(),
        now: () => currentTime,
        quoteRetryIntervalMs: 200,
      }).executeClearance({
        currentTime,
        isHalfDay: scenario.isHalfDay,
        isLive: alwaysLive,
        positions: snapshotOf(terminalState).getView().positions,
        monitorContext: createMonitorContext(),
        ...createTradeRuntimeDouble({
          orderExecutor: {
            executeDoomsdayClearanceSignals: async () => ({
              executedOrderIds: [],
              awaitingAuthoritativeTerminalSymbols: ['BULL.HK'],
              unresolvedQuoteSymbols: [],
            }),
          },
        }),
        marketDataClient: createMarketDataClientDouble({
          getQuotes: async () => new Map([['BULL.HK', createQuoteDouble('BULL.HK', '1.1', 100)]]),
        }),
        ...terminalState,
        snapshot: snapshotOf(terminalState),
      });

      expect(terminalResult.nextRetryAtMs, `${scenario.label} terminal`).toBe(expectedRetryAtMs);

      const missingQuoteState = await createRuntimeStates();
      await publishPositions(missingQuoteState, [
        createPositionDouble({ symbol: 'BULL.HK', quantity: 100, availableQuantity: 100 }),
      ]);

      const missingQuoteResult = await createDoomsdayClearanceWorkflow({
        logger: createLoggerDouble(),
        now: () => currentTime,
        quoteRetryIntervalMs: 200,
      }).executeClearance({
        currentTime,
        isHalfDay: scenario.isHalfDay,
        isLive: alwaysLive,
        positions: snapshotOf(missingQuoteState).getView().positions,
        monitorContext: createMonitorContext(),
        ...createTradeRuntimeDouble(),
        marketDataClient: createMarketDataClientDouble({
          getQuotes: async () => new Map([['BULL.HK', null]]),
        }),
        ...missingQuoteState,
        snapshot: snapshotOf(missingQuoteState),
      });

      expect(missingQuoteResult.nextRetryAtMs, `${scenario.label} missing quote`).toBe(
        expectedRetryAtMs,
      );

      const unknownCancelResult = await createDoomsdayClearanceWorkflow({
        logger: createLoggerDouble(),
        now: () => currentTime,
        quoteRetryIntervalMs: 200,
      }).cancelPendingBuyOrders({
        currentTime,
        isHalfDay: scenario.isHalfDay,
        isLive: alwaysLive,
        monitorContext: createMonitorContext(),
        ...createTradeRuntimeDouble({
          cacheManager: {
            getPendingOrders: async () => [
              await createPendingCutoffOrder({
                orderId: `UNKNOWN-CANCEL-INNER-${scenario.label}`,
                symbol: 'BULL.HK',
                side: 'BUY',
                submittedPrice: '1',
                quantity: 100,
                executedQuantity: 0,
                orderType: 'ELO',
              }),
            ],
          },
          orderMonitor: {
            cancelDoomsdayOrder: async () => ({
              kind: 'UNKNOWN_FAILURE',
              errorCode: null,
            }),
          },
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
    const broker = createDoomsdayBrokerFixture([]);
    const tradeRuntime = await createRealDoomsdayTrader({
      brokerAccess: broker.brokerAccess,
      tradingConfig: createTradingConfig({ monitor: monitorConfig }),
      marketDataClient: createMarketDataClientDouble(),
      symbolRegistry: monitorContext.symbolRegistry,
      now: () => currentTime,
    });
    const ordinarySell = {
      ...createSignal({
        symbol: 'BULL.HK',
        action: 'SELLCALL',
        triggerTimeMs: Date.now(),
        reason: 'ordinary-sell-during-takeover',
      }),
      quantity: 100,
    };

    const result = await tradeRuntime.orderExecutor.executeSignals([ordinarySell], alwaysLive);

    expect(result.executedOrderIds).toEqual([]);
    expect(broker.getCallCounts().stockPositions).toBe(0);
    expect(broker.getCallCounts().submitOrder).toBe(0);
  });

  it('rejects the dedicated Trader clearance entry outside the close-5 window before SDK submission', async () => {
    const currentTime = new Date('2026-02-16T07:50:00.000Z');
    const monitorConfig = createMonitorConfigDouble();
    const monitorContext = createMonitorContext(monitorConfig);
    const broker = createDoomsdayBrokerFixture([]);
    const tradeRuntime = await createRealDoomsdayTrader({
      brokerAccess: broker.brokerAccess,
      tradingConfig: createTradingConfig({ monitor: monitorConfig }),
      marketDataClient: createMarketDataClientDouble(),
      symbolRegistry: monitorContext.symbolRegistry,
      now: () => currentTime,
    });
    const clearanceCommand = createDoomsdayClearanceCommand(currentTime);

    const result = await tradeRuntime.orderExecutor.executeDoomsdayClearanceSignals(
      [clearanceCommand],
      alwaysLive,
    );

    expect(result.executedOrderIds).toEqual([]);
    expect(broker.getCallCounts().stockPositions).toBe(0);
    expect(broker.getCallCounts().submitOrder).toBe(0);
  });

  it('cancels pending buy orders once per trading day within close-15 window', async () => {
    const doomsday = createDoomsdayClearanceWorkflow({
      logger: createLoggerDouble(),
      now: () => BUY_CUTOFF_TEST_NOW,
    });
    const monitorConfig = createMonitorConfigDouble();

    const tradeRuntime = createTradeRuntimeDouble({
      cacheManager: {
        getPendingOrders: async () => [
          await createPendingCutoffOrder({
            orderId: 'B-1',
            symbol: 'BULL.HK',
            side: 'BUY',
            submittedPrice: '1',
            quantity: 100,
            executedQuantity: 0,
            orderType: 'ELO',
          }),
          await createPendingCutoffOrder({
            orderId: 'S-1',
            symbol: 'BULL.HK',
            side: 'SELL',
            submittedPrice: '1',
            quantity: 100,
            executedQuantity: 0,
            orderType: 'ELO',
          }),
        ],
      },
      orderMonitor: {
        cancelDoomsdayOrder: async () => ({
          kind: 'CANCEL_CONFIRMED',
          relatedBuyOrderIds: null,
        }),
      },
    });

    const result1 = await doomsday.cancelPendingBuyOrders({
      currentTime: new Date('2026-02-16T07:50:00.000Z'),
      isHalfDay: false,
      isLive: alwaysLive,
      monitorContext: createMonitorContext(monitorConfig),
      cacheManager: tradeRuntime.cacheManager,
      orderMonitor: tradeRuntime.orderMonitor,
    });

    const result2 = await doomsday.cancelPendingBuyOrders({
      currentTime: new Date('2026-02-16T07:51:00.000Z'),
      isHalfDay: false,
      isLive: alwaysLive,
      monitorContext: createMonitorContext(monitorConfig),
      cacheManager: tradeRuntime.cacheManager,
      orderMonitor: tradeRuntime.orderMonitor,
    });

    expect(result1.executed).toBeTrue();
    expect(result1.cancelRequestAcceptedCount).toBe(1);
    expect(result2.executed).toBeFalse();

    expect(tradeRuntime.cacheManager.getPendingOrders).toBeDefined();
  });

  it('cancels a pending market buy with nullable submitted price', async () => {
    const doomsday = createDoomsdayClearanceWorkflow({
      logger: createLoggerDouble(),
      now: () => BUY_CUTOFF_TEST_NOW,
    });
    const monitorConfig = createMonitorConfigDouble();
    let cancelCalls = 0;
    const tradeRuntime = createTradeRuntimeDouble({
      cacheManager: {
        getPendingOrders: async () => [
          await createPendingCutoffOrder({
            orderId: 'B-MARKET',
            symbol: 'BULL.HK',
            side: 'BUY',
            submittedPrice: null,
            quantity: 100,
            executedQuantity: 0,
            orderType: 'MO',
          }),
        ],
      },
      orderMonitor: {
        cancelDoomsdayOrder: async () => {
          cancelCalls += 1;
          return {
            kind: 'CANCEL_CONFIRMED',
            relatedBuyOrderIds: null,
          };
        },
      },
    });

    const result = await doomsday.cancelPendingBuyOrders({
      currentTime: BUY_CUTOFF_TEST_NOW,
      isHalfDay: false,
      isLive: alwaysLive,
      monitorContext: createMonitorContext(monitorConfig),
      cacheManager: tradeRuntime.cacheManager,
      orderMonitor: tradeRuntime.orderMonitor,
    });

    expect(result.cancelRequestAcceptedCount).toBe(1);
    expect(cancelCalls).toBe(1);
  });

  it('throws non API cancel errors without marking close-15 check completed', async () => {
    const doomsday = createDoomsdayClearanceWorkflow({
      logger: createLoggerDouble(),
      now: () => BUY_CUTOFF_TEST_NOW,
    });
    const monitorConfig = createMonitorConfigDouble();
    let cancelCalls = 0;
    const tradeRuntime = createTradeRuntimeDouble({
      cacheManager: {
        getPendingOrders: async () => [
          await createPendingCutoffOrder({
            orderId: 'B-1',
            symbol: 'BULL.HK',
            side: 'BUY',
            submittedPrice: '1',
            quantity: 100,
            executedQuantity: 0,
            orderType: 'ELO',
          }),
        ],
      },
      orderMonitor: {
        cancelDoomsdayOrder: async () => {
          cancelCalls += 1;
          throw new TypeError('cancel contract broken');
        },
      },
    });
    const context = {
      currentTime: new Date('2026-02-16T07:50:00.000Z'),
      isHalfDay: false,
      isLive: alwaysLive,
      monitorContext: createMonitorContext(monitorConfig),
      cacheManager: tradeRuntime.cacheManager,
      orderMonitor: tradeRuntime.orderMonitor,
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
    const doomsday = createDoomsdayClearanceWorkflow({
      logger: createLoggerDouble(),
      now: () => BUY_CUTOFF_TEST_NOW,
    });
    const monitorConfig = createMonitorConfigDouble();

    const tradeRuntime = createTradeRuntimeDouble({
      cacheManager: {
        getPendingOrders: async () => [
          await createPendingCutoffOrder({
            orderId: 'B-FILLED',
            symbol: 'BULL.HK',
            side: 'BUY',
            submittedPrice: '1',
            quantity: 100,
            executedQuantity: 0,
            orderType: 'ELO',
          }),
        ],
      },
      orderMonitor: {
        cancelDoomsdayOrder: async () => ({
          kind: 'ALREADY_CLOSED',
          closedReason: 'FILLED',
          relatedBuyOrderIds: null,
          terminalExecution: {
            submittedQuantity: 100,
            executedQuantity: 100,
          },
        }),
      },
    });

    const result = await doomsday.cancelPendingBuyOrders({
      currentTime: new Date('2026-02-16T07:50:00.000Z'),
      isHalfDay: false,
      isLive: alwaysLive,
      monitorContext: createMonitorContext(monitorConfig),
      cacheManager: tradeRuntime.cacheManager,
      orderMonitor: tradeRuntime.orderMonitor,
    });

    expect(result.executed).toBeTrue();
    expect(result.cancelRequestAcceptedCount).toBe(0);
  });

  it('rethrows pending-order API failures without marking close-15 check completed', async () => {
    const doomsday = createDoomsdayClearanceWorkflow({
      logger: createLoggerDouble(),
      now: () => BUY_CUTOFF_TEST_NOW,
    });
    const monitorConfig = createMonitorConfigDouble();
    let getPendingOrdersCalls = 0;
    const tradeRuntime = createTradeRuntimeDouble({
      cacheManager: {
        getPendingOrders: async () => {
          getPendingOrdersCalls += 1;
          throw await createExternalApiRequestError({
            operation: 'test.getPendingOrders',
            attempts: getPendingOrdersCalls,
            cause: new Error('pending orders unavailable'),
          });
        },
      },
    });
    const context = {
      currentTime: new Date('2026-02-16T07:50:00.000Z'),
      isHalfDay: false,
      isLive: alwaysLive,
      monitorContext: createMonitorContext(monitorConfig),
      cacheManager: tradeRuntime.cacheManager,
      orderMonitor: tradeRuntime.orderMonitor,
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

  it('executes close-5 liquidation, invalidates only account and clears local buy records for both sides', async () => {
    const doomsday = createDoomsdayClearanceWorkflow({
      logger: createLoggerDouble(),
      now: () => CLEARANCE_TEST_NOW,
    });
    const monitorConfig = createMonitorConfigDouble();

    let executedSignals = 0;
    const tradeRuntime = createTradeRuntimeDouble({
      orderExecutor: {
        executeDoomsdayClearanceSignals: async (signals) => {
          executedSignals = signals.length;
          return {
            executedOrderIds: signals.map(() => `EXECUTED-ORDER`),
            awaitingAuthoritativeTerminalSymbols: [],
            unresolvedQuoteSymbols: [],
          };
        },
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

    const stateFixtures = await createRuntimeStates();

    const result = await doomsday.executeClearance({
      currentTime: new Date('2026-02-16T07:56:00.000Z'),
      isHalfDay: false,
      isLive: alwaysLive,
      positions: snapshotOf(stateFixtures).getView().positions,
      monitorContext,
      orderExecutor: tradeRuntime.orderExecutor,
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () =>
          new Map([
            ['BULL.HK', createQuoteDouble('BULL.HK', '1.1', 100)],
            ['BEAR.HK', createQuoteDouble('BEAR.HK', '0.9', 100)],
          ]),
      }),
      ...stateFixtures,
      snapshot: snapshotOf(stateFixtures),
    });

    expect(result.executed).toBeTrue();
    expect(executedSignals).toBe(2);

    expect(clearCallsBySide[1]).toBe(1);
    expect(clearCallsBySide[0]).toBe(1);

    expect(snapshotOf(stateFixtures).getView().accountValid).toBeFalse();
    expect(snapshotOf(stateFixtures).getView().account).not.toBeNull();
    expect(snapshotOf(stateFixtures).getView().positions).toHaveLength(2);
    expect(snapshotOf(stateFixtures).getAvailablePosition('BULL.HK')).not.toBeNull();
  });

  it('fails fast when close-5 window sees positive positions outside current seat symbols', async () => {
    const doomsday = createDoomsdayClearanceWorkflow({
      logger: createLoggerDouble(),
      now: () => CLEARANCE_TEST_NOW,
    });
    const monitorConfig = createMonitorConfigDouble();
    const stateFixtures = await createRuntimeStates();
    await publishPositions(stateFixtures, [
      ...snapshotOf(stateFixtures).getView().positions,
      createPositionDouble({
        symbol: 'OLD_BULL.HK',
        quantity: 200,
        availableQuantity: 200,
      }),
    ]);

    let quoteCalls = 0;
    const marketDataClient = createMarketDataClientDouble({
      getQuotes: async () => {
        quoteCalls += 1;
        return new Map([
          ['BULL.HK', createQuoteDouble('BULL.HK', '1.1', 100)],
          ['BEAR.HK', createQuoteDouble('BEAR.HK', '0.9', 100)],
        ]);
      },
    });

    let executeCalls = 0;
    const tradeRuntime = createTradeRuntimeDouble({
      orderExecutor: {
        executeDoomsdayClearanceSignals: async (signals) => {
          executeCalls += 1;
          return {
            executedOrderIds: signals.map(() => `EXECUTED-ORDER`),
            awaitingAuthoritativeTerminalSymbols: [],
            unresolvedQuoteSymbols: [],
          };
        },
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
        positions: snapshotOf(stateFixtures).getView().positions,
        monitorContext,
        orderExecutor: tradeRuntime.orderExecutor,
        marketDataClient,
        ...stateFixtures,
        snapshot: snapshotOf(stateFixtures),
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
    expect(snapshotOf(stateFixtures).getView().account).not.toBeNull();
    expect(snapshotOf(stateFixtures).getView().positions).toHaveLength(3);
    expect(snapshotOf(stateFixtures).getAvailablePosition('OLD_BULL.HK')).not.toBeNull();
  });

  it('keeps canonical facts and local buy records when close-5 signals are not submitted', async () => {
    const doomsday = createDoomsdayClearanceWorkflow({
      logger: createLoggerDouble(),
      now: () => CLEARANCE_TEST_NOW,
    });
    const monitorConfig = createMonitorConfigDouble();

    const tradeRuntime = createTradeRuntimeDouble({
      orderExecutor: {
        executeDoomsdayClearanceSignals: async () => ({
          executedOrderIds: [],
          awaitingAuthoritativeTerminalSymbols: [],
          unresolvedQuoteSymbols: [],
        }),
      },
    });

    let clearCalls = 0;
    const orderRecorder = createOrderRecorderDouble({
      clearBuyOrders: () => {
        clearCalls += 1;
      },
    });
    const stateFixtures = await createRuntimeStates();

    const result = await doomsday.executeClearance({
      currentTime: new Date('2026-02-16T07:56:00.000Z'),
      isHalfDay: false,
      isLive: alwaysLive,
      positions: snapshotOf(stateFixtures).getView().positions,
      monitorContext: createMonitorContext(monitorConfig, orderRecorder),
      orderExecutor: tradeRuntime.orderExecutor,
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () =>
          new Map([
            ['BULL.HK', createQuoteDouble('BULL.HK', '1.1', 100)],
            ['BEAR.HK', createQuoteDouble('BEAR.HK', '0.9', 100)],
          ]),
      }),
      ...stateFixtures,
      snapshot: snapshotOf(stateFixtures),
    });

    expect(result).toEqual({ executed: false, nextRetryAtMs: null });
    expect(clearCalls).toBe(0);
    expect(snapshotOf(stateFixtures).getView().account).not.toBeNull();
    expect(snapshotOf(stateFixtures).getView().positions).toHaveLength(2);
    expect(snapshotOf(stateFixtures).getAvailablePosition('BULL.HK')).not.toBeNull();
  });

  it('returns next retry time when close-5 clearance quote is missing', async () => {
    const doomsday = createDoomsdayClearanceWorkflow({
      logger: createLoggerDouble(),
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
    const tradeRuntime = createTradeRuntimeDouble({
      orderExecutor: {
        executeDoomsdayClearanceSignals: async (signals) => {
          executedSignals += signals.length;
          return {
            executedOrderIds: signals.map(() => `EXECUTED-ORDER`),
            awaitingAuthoritativeTerminalSymbols: [],
            unresolvedQuoteSymbols: [],
          };
        },
      },
    });

    const stateFixtures = await createRuntimeStates();
    await publishPositions(stateFixtures, [
      createPositionDouble({ symbol: 'BULL.HK', quantity: 500, availableQuantity: 500 }),
    ]);

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
      positions: snapshotOf(stateFixtures).getView().positions,
      monitorContext: createMonitorContext(monitorConfig, orderRecorder),
      orderExecutor: tradeRuntime.orderExecutor,
      marketDataClient,
      ...stateFixtures,
      snapshot: snapshotOf(stateFixtures),
    });

    expect(result).toEqual({
      executed: false,
      nextRetryAtMs: new Date('2026-02-16T07:56:02.000Z').getTime(),
    });
    expect(executedSignals).toBe(0);
    expect(clearCalls).toBe(0);
  });

  it('does not schedule close-5 retry when clearance quote has invalid price', async () => {
    const doomsday = createDoomsdayClearanceWorkflow({
      logger: createLoggerDouble(),
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
    const tradeRuntime = createTradeRuntimeDouble({
      orderExecutor: {
        executeDoomsdayClearanceSignals: async (signals) => {
          executedSignals += signals.length;
          return {
            executedOrderIds: signals.map(() => `EXECUTED-ORDER`),
            awaitingAuthoritativeTerminalSymbols: [],
            unresolvedQuoteSymbols: [],
          };
        },
      },
    });

    const stateFixtures = await createRuntimeStates();
    await publishPositions(stateFixtures, [
      createPositionDouble({ symbol: 'BULL.HK', quantity: 500, availableQuantity: 500 }),
    ]);

    const marketDataClient = createMarketDataClientDouble({
      getQuotes: async () =>
        new Map([
          ['BULL.HK', createQuoteDouble('BULL.HK', '0', 100)],
          ['BEAR.HK', null],
        ]),
    });

    const result = await doomsday.executeClearance({
      currentTime: new Date('2026-02-16T07:56:00.000Z'),
      isHalfDay: false,
      isLive: alwaysLive,
      positions: snapshotOf(stateFixtures).getView().positions,
      monitorContext: createMonitorContext(monitorConfig, orderRecorder),
      orderExecutor: tradeRuntime.orderExecutor,
      marketDataClient,
      ...stateFixtures,
      snapshot: snapshotOf(stateFixtures),
    });

    expect(result).toEqual({ executed: false, nextRetryAtMs: null });
    expect(executedSignals).toBe(0);
    expect(clearCalls).toBe(0);
    expect(snapshotOf(stateFixtures).getView().account).not.toBeNull();
    expect(snapshotOf(stateFixtures).getView().positions).toHaveLength(1);
    expect(snapshotOf(stateFixtures).getAvailablePosition('BULL.HK')).not.toBeNull();
  });

  it('skips planned close-5 retry execution when lifecycle gate closes before retry call', async () => {
    let now = new Date('2026-02-16T07:56:00.000Z');
    const doomsday = createDoomsdayClearanceWorkflow({
      logger: createLoggerDouble(),
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
    const tradeRuntime = createTradeRuntimeDouble({
      orderExecutor: {
        executeDoomsdayClearanceSignals: async (signals) => {
          executedSignals += signals.length;
          return {
            executedOrderIds: signals.map(() => `EXECUTED-ORDER`),
            awaitingAuthoritativeTerminalSymbols: [],
            unresolvedQuoteSymbols: [],
          };
        },
      },
    });

    const stateFixtures = await createRuntimeStates();
    await publishPositions(stateFixtures, [
      createPositionDouble({ symbol: 'BULL.HK', quantity: 500, availableQuantity: 500 }),
    ]);

    const marketDataClient = createMarketDataClientDouble({
      getQuotes: async () =>
        new Map([
          ['BULL.HK', quoteReady ? createQuoteDouble('BULL.HK', '1.1', 100) : null],
          ['BEAR.HK', null],
        ]),
    });

    const result = await doomsday.executeClearance({
      currentTime: new Date('2026-02-16T07:56:00.000Z'),
      isHalfDay: false,
      isLive: alwaysLive,
      positions: snapshotOf(stateFixtures).getView().positions,
      monitorContext: createMonitorContext(monitorConfig, orderRecorder),
      orderExecutor: tradeRuntime.orderExecutor,
      marketDataClient,
      ...stateFixtures,
      snapshot: snapshotOf(stateFixtures),
    });

    expect(result).toEqual({
      executed: false,
      nextRetryAtMs: new Date('2026-02-16T07:56:02.000Z').getTime(),
    });
    expect(executedSignals).toBe(0);
    expect(clearCalls).toBe(0);

    quoteReady = true;
    stateFixtures.lifecycleState.isTradingEnabled = false;
    now = new Date('2026-02-16T07:56:02.000Z');
    const retryResult = await doomsday.executeClearance({
      currentTime: now,
      isHalfDay: false,
      isLive: alwaysLive,
      positions: snapshotOf(stateFixtures).getView().positions,
      monitorContext: createMonitorContext(monitorConfig, orderRecorder),
      orderExecutor: tradeRuntime.orderExecutor,
      marketDataClient,
      ...stateFixtures,
      snapshot: snapshotOf(stateFixtures),
    });

    expect(retryResult).toEqual({ executed: false, nextRetryAtMs: null });
    expect(executedSignals).toBe(0);
    expect(clearCalls).toBe(0);
  });

  it('executes ready subset first and returns retry time for unresolved subset in close-5 window', async () => {
    let now = new Date('2026-02-16T07:56:00.000Z');
    const doomsday = createDoomsdayClearanceWorkflow({
      logger: createLoggerDouble(),
      now: () => now,
      quoteRetryIntervalMs: 2_000,
      quoteRetryMaxAttempts: 2,
    });
    const monitorConfig = createMonitorConfigDouble();

    let shortQuoteReady = false;
    const submittedSymbols: string[] = [];
    const tradeRuntime = createTradeRuntimeDouble({
      orderExecutor: {
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
      },
    });
    const orderRecorder = createOrderRecorderDouble();
    const stateFixtures = await createRuntimeStates();
    const marketDataClient = createMarketDataClientDouble({
      getQuotes: async () =>
        new Map([
          ['BULL.HK', createQuoteDouble('BULL.HK', '1.1', 100)],
          ['BEAR.HK', shortQuoteReady ? createQuoteDouble('BEAR.HK', '0.9', 100) : null],
        ]),
    });

    const result = await doomsday.executeClearance({
      currentTime: now,
      isHalfDay: false,
      isLive: alwaysLive,
      positions: snapshotOf(stateFixtures).getView().positions,
      monitorContext: createMonitorContext(monitorConfig, orderRecorder),
      orderExecutor: tradeRuntime.orderExecutor,
      marketDataClient,
      ...stateFixtures,
      snapshot: snapshotOf(stateFixtures),
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
      positions: snapshotOf(stateFixtures).getView().positions,
      monitorContext: createMonitorContext(monitorConfig, orderRecorder),
      orderExecutor: tradeRuntime.orderExecutor,
      marketDataClient,
      ...stateFixtures,
      snapshot: snapshotOf(stateFixtures),
    });

    expect(retryResult).toEqual({ executed: true, nextRetryAtMs: null });
    expect(submittedSymbols).toEqual(['BULL.HK', 'BEAR.HK']);
  });

  it('keeps unresolved symbols pending before planned retry time', async () => {
    let now = new Date('2026-02-16T07:56:00.000Z');
    const doomsday = createDoomsdayClearanceWorkflow({
      logger: createLoggerDouble(),
      now: () => now,
      quoteRetryIntervalMs: 2_000,
      quoteRetryMaxAttempts: 2,
    });
    const monitorConfig = createMonitorConfigDouble();

    let shortQuoteReady = false;
    const submittedSymbols: string[] = [];
    const tradeRuntime = createTradeRuntimeDouble({
      orderExecutor: {
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
      },
    });
    const orderRecorder = createOrderRecorderDouble();
    const stateFixtures = await createRuntimeStates();
    const marketDataClient = createMarketDataClientDouble({
      getQuotes: async () =>
        new Map([
          ['BULL.HK', createQuoteDouble('BULL.HK', '1.1', 100)],
          ['BEAR.HK', shortQuoteReady ? createQuoteDouble('BEAR.HK', '0.9', 100) : null],
        ]),
    });

    const result = await doomsday.executeClearance({
      currentTime: now,
      isHalfDay: false,
      isLive: alwaysLive,
      positions: snapshotOf(stateFixtures).getView().positions,
      monitorContext: createMonitorContext(monitorConfig, orderRecorder),
      orderExecutor: tradeRuntime.orderExecutor,
      marketDataClient,
      ...stateFixtures,
      snapshot: snapshotOf(stateFixtures),
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
      positions: snapshotOf(stateFixtures).getView().positions,
      monitorContext: createMonitorContext(monitorConfig, orderRecorder),
      orderExecutor: tradeRuntime.orderExecutor,
      marketDataClient,
      ...stateFixtures,
      snapshot: snapshotOf(stateFixtures),
    });

    shortQuoteReady = true;
    now = new Date('2026-02-16T07:56:02.000Z');
    const finalResult = await doomsday.executeClearance({
      currentTime: now,
      isHalfDay: false,
      isLive: alwaysLive,
      positions: snapshotOf(stateFixtures).getView().positions,
      monitorContext: createMonitorContext(monitorConfig, orderRecorder),
      orderExecutor: tradeRuntime.orderExecutor,
      marketDataClient,
      ...stateFixtures,
      snapshot: snapshotOf(stateFixtures),
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
    const doomsday = createDoomsdayClearanceWorkflow({
      logger: createLoggerDouble(),
      now: () => now,
      quoteRetryIntervalMs: 2_000,
      quoteRetryMaxAttempts: 1,
    });
    const monitorConfig = createMonitorConfigDouble();

    let shortQuoteReady = false;
    const submittedSymbols: string[] = [];
    const tradeRuntime = createTradeRuntimeDouble({
      orderExecutor: {
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
      },
    });
    const orderRecorder = createOrderRecorderDouble();
    const stateFixtures = await createRuntimeStates();
    const marketDataClient = createMarketDataClientDouble({
      getQuotes: async () =>
        new Map([
          ['BULL.HK', createQuoteDouble('BULL.HK', '1.1', 100)],
          ['BEAR.HK', shortQuoteReady ? createQuoteDouble('BEAR.HK', '0.9', 100) : null],
        ]),
    });

    const result = await doomsday.executeClearance({
      currentTime: now,
      isHalfDay: false,
      isLive: alwaysLive,
      positions: snapshotOf(stateFixtures).getView().positions,
      monitorContext: createMonitorContext(monitorConfig, orderRecorder),
      orderExecutor: tradeRuntime.orderExecutor,
      marketDataClient,
      ...stateFixtures,
      snapshot: snapshotOf(stateFixtures),
    });

    expect(result).toEqual({
      executed: true,
      nextRetryAtMs: new Date('2026-02-16T07:56:02.000Z').getTime(),
    });

    // accepted 不虚裁 canonical position；只有后续券商持仓观察确认 BULL 已平才发布新事实。
    expect(snapshotOf(stateFixtures).getView().positions).toHaveLength(2);
    await publishPositions(stateFixtures, [
      createPositionDouble({ symbol: 'BEAR.HK', quantity: 300, availableQuantity: 300 }),
    ]);
    now = new Date('2026-02-16T07:56:02.000Z');
    const exhaustedResult = await doomsday.executeClearance({
      currentTime: now,
      isHalfDay: false,
      isLive: alwaysLive,
      positions: snapshotOf(stateFixtures).getView().positions,
      monitorContext: createMonitorContext(monitorConfig, orderRecorder),
      orderExecutor: tradeRuntime.orderExecutor,
      marketDataClient,
      ...stateFixtures,
      snapshot: snapshotOf(stateFixtures),
    });

    shortQuoteReady = true;
    const finalResult = await doomsday.executeClearance({
      currentTime: new Date('2026-02-16T07:56:05.000Z'),
      isHalfDay: false,
      isLive: alwaysLive,
      positions: snapshotOf(stateFixtures).getView().positions,
      monitorContext: createMonitorContext(monitorConfig, orderRecorder),
      orderExecutor: tradeRuntime.orderExecutor,
      marketDataClient,
      ...stateFixtures,
      snapshot: snapshotOf(stateFixtures),
    });

    expect(exhaustedResult).toEqual({ executed: false, nextRetryAtMs: null });
    expect(finalResult).toEqual({ executed: false, nextRetryAtMs: null });
    expect(submittedSymbols).toEqual(['BULL.HK']);
  });

  it('rethrows clearance quote API failures without mutating canonical facts', async () => {
    const doomsday = createDoomsdayClearanceWorkflow({
      logger: createLoggerDouble(),
      now: () => CLEARANCE_TEST_NOW,
    });
    const monitorConfig = createMonitorConfigDouble();
    const stateFixtures = await createRuntimeStates();
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
    const tradeRuntime = createTradeRuntimeDouble();
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
        positions: snapshotOf(stateFixtures).getView().positions,
        monitorContext,
        orderExecutor: tradeRuntime.orderExecutor,
        marketDataClient,
        ...stateFixtures,
        snapshot: snapshotOf(stateFixtures),
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({ name: 'ExternalApiRequestError' });
    expect(clearCalls).toBe(0);
    expect(snapshotOf(stateFixtures).getView().account).not.toBeNull();
    expect(snapshotOf(stateFixtures).getView().positions).toHaveLength(2);
    expect(snapshotOf(stateFixtures).getAvailablePosition('BULL.HK')).not.toBeNull();
  });

  it('rethrows clearance execution API failures without mutating canonical facts or local buy records', async () => {
    const doomsday = createDoomsdayClearanceWorkflow({
      logger: createLoggerDouble(),
      now: () => CLEARANCE_TEST_NOW,
    });
    const monitorConfig = createMonitorConfigDouble();
    const stateFixtures = await createRuntimeStates();
    let clearCalls = 0;
    const tradeRuntime = createTradeRuntimeDouble({
      orderExecutor: {
        executeDoomsdayClearanceSignals: async () => {
          throw await createExternalApiRequestError({
            operation: 'test.executeSignals',
            attempts: 1,
            cause: new Error('submit unavailable'),
          });
        },
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
          ['BULL.HK', createQuoteDouble('BULL.HK', '1.1', 100)],
          ['BEAR.HK', createQuoteDouble('BEAR.HK', '0.9', 100)],
        ]),
    });

    let error: unknown = null;
    try {
      await doomsday.executeClearance({
        currentTime: new Date('2026-02-16T07:56:00.000Z'),
        isHalfDay: false,
        isLive: alwaysLive,
        positions: snapshotOf(stateFixtures).getView().positions,
        monitorContext,
        orderExecutor: tradeRuntime.orderExecutor,
        marketDataClient,
        ...stateFixtures,
        snapshot: snapshotOf(stateFixtures),
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({ name: 'ExternalApiRequestError' });
    expect(clearCalls).toBe(0);
    expect(snapshotOf(stateFixtures).getView().account).not.toBeNull();
    expect(snapshotOf(stateFixtures).getView().positions).toHaveLength(2);
    expect(snapshotOf(stateFixtures).getAvailablePosition('BULL.HK')).not.toBeNull();
  });

  it('propagates clearance execution error when duplicate signals are deduplicated', async () => {
    const doomsday = createDoomsdayClearanceWorkflow({
      logger: createLoggerDouble(),
      now: () => CLEARANCE_TEST_NOW,
    });
    const monitorConfig = createMonitorConfigDouble({ monitorSymbol: 'HSI.HK' });
    const stateFixtures = await createRuntimeStates();

    const tradeRuntime = createTradeRuntimeDouble({
      orderExecutor: {
        executeDoomsdayClearanceSignals: async () => {
          throw new Error('submit failed');
        },
      },
    });

    let caught: unknown = null;
    try {
      await doomsday.executeClearance({
        currentTime: new Date('2026-02-16T07:56:00.000Z'),
        isHalfDay: false,
        isLive: alwaysLive,
        positions: [
          ...snapshotOf(stateFixtures).getView().positions,
          createPositionDouble({ symbol: 'BULL.HK', quantity: 200, availableQuantity: 200 }),
        ],
        monitorContext: createMonitorContext(monitorConfig),
        orderExecutor: tradeRuntime.orderExecutor,
        marketDataClient: createMarketDataClientDouble({
          getQuotes: async () =>
            new Map([
              ['BULL.HK', createQuoteDouble('BULL.HK', '1.1', 100)],
              ['BEAR.HK', createQuoteDouble('BEAR.HK', '0.9', 100)],
            ]),
        }),
        ...stateFixtures,
        snapshot: snapshotOf(stateFixtures),
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
    const doomsday = createDoomsdayClearanceWorkflow({
      logger: createLoggerDouble(),
      now: () => currentTime,
    });
    const tradeRuntime = createTradeRuntimeDouble({
      cacheManager: {
        getPendingOrders: async () => {
          currentTime = new Date('2026-02-16T08:01:00.000Z');
          return [
            await createPendingCutoffOrder({
              orderId: 'PENDING-BUY',
              symbol: 'BULL.HK',
              side: 'BUY',
              submittedPrice: '1',
              quantity: 100,
              executedQuantity: 0,
              orderType: 'ELO',
            }),
          ];
        },
      },
      orderMonitor: {
        cancelDoomsdayOrder: async () => {
          cancelCalls += 1;
          return {
            kind: 'CANCEL_CONFIRMED',
            relatedBuyOrderIds: null,
          };
        },
      },
    });

    const result = await doomsday.cancelPendingBuyOrders({
      currentTime: new Date('2026-02-16T07:46:00.000Z'),
      isHalfDay: false,
      monitorContext: createMonitorContext(),
      cacheManager: tradeRuntime.cacheManager,
      orderMonitor: tradeRuntime.orderMonitor,
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
    const doomsday = createDoomsdayClearanceWorkflow({
      logger: createLoggerDouble(),
      now: () => new Date('2026-02-16T07:46:00.000Z'),
    });
    const tradeRuntime = createTradeRuntimeDouble({
      cacheManager: {
        getPendingOrders: async () => [
          await createPendingCutoffOrder({
            orderId: 'DOOMSDAY-PENDING-BUY',
            symbol: 'BULL.HK',
            side: 'BUY',
            submittedPrice: '1',
            quantity: 100,
            executedQuantity: 0,
            orderType: 'ELO',
          }),
        ],
      },
      orderMonitor: {
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
            relatedBuyOrderIds: null,
          };
        },
      },
    });

    const result = await doomsday.cancelPendingBuyOrders({
      currentTime: new Date('2026-02-16T07:46:00.000Z'),
      isHalfDay: false,
      monitorContext: createMonitorContext(),
      cacheManager: tradeRuntime.cacheManager,
      orderMonitor: tradeRuntime.orderMonitor,
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
    const doomsday = createDoomsdayClearanceWorkflow({
      logger: createLoggerDouble(),
      now: () => new Date('2026-02-16T07:46:00.000Z'),
    });
    const tradeRuntime = createTradeRuntimeDouble({
      cacheManager: {
        getPendingOrders: async () => [
          await createPendingCutoffOrder({
            orderId: 'DOOMSDAY-PENDING-BUY-OPEN',
            symbol: 'BULL.HK',
            side: 'BUY',
            submittedPrice: '1',
            quantity: 100,
            executedQuantity: 0,
            orderType: 'ELO',
          }),
        ],
      },
      orderMonitor: {
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
            relatedBuyOrderIds: null,
          };
        },
      },
    });

    const result = await doomsday.cancelPendingBuyOrders({
      currentTime: new Date('2026-02-16T07:46:00.000Z'),
      isHalfDay: false,
      monitorContext: createMonitorContext(),
      cacheManager: tradeRuntime.cacheManager,
      orderMonitor: tradeRuntime.orderMonitor,
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
    const stateFixtures = await createRuntimeStates();
    const originalPosition = createPositionDouble({
      symbol: 'BULL.HK',
      quantity: 500,
      availableQuantity: 500,
    });
    await publishPositions(stateFixtures, [originalPosition]);

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
    const doomsday = createDoomsdayClearanceWorkflow({
      logger: createLoggerDouble(),
      now: () => currentTime,
    });
    const tradeRuntime = createTradeRuntimeDouble({
      orderExecutor: {
        executeDoomsdayClearanceSignals: async () => {
          executionCalls += 1;
          return {
            executedOrderIds: ['STALE-CLEARANCE'],
            awaitingAuthoritativeTerminalSymbols: [],
            unresolvedQuoteSymbols: [],
          };
        },
      },
    });

    const result = await doomsday.executeClearance({
      currentTime: new Date('2026-02-16T07:56:00.000Z'),
      isHalfDay: false,
      positions: snapshotOf(stateFixtures).getView().positions,
      monitorContext,
      orderExecutor: tradeRuntime.orderExecutor,
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () => {
          currentTime = new Date('2026-02-16T08:01:00.000Z');
          return new Map([['BULL.HK', createQuoteDouble('BULL.HK', '1.1', 100)]]);
        },
      }),
      ...stateFixtures,
      isLive: () =>
        currentTime.getTime() < closeTime.getTime() &&
        stateFixtures.lifecycleState.isTradingEnabled,
      snapshot: snapshotOf(stateFixtures),
    });

    expect(result).toEqual({ executed: false, nextRetryAtMs: null });
    expect(executionCalls).toBe(0);
    expect(clearBuyOrderCalls).toBe(0);
    expect(snapshotOf(stateFixtures).getView().account).not.toBeNull();
    expect(snapshotOf(stateFixtures).getView().positions).toEqual([originalPosition]);
    expect(snapshotOf(stateFixtures).getAvailablePosition('BULL.HK')).toEqual(originalPosition);
  });

  it('does not mutate local clearance state when the lifecycle gate closes during broker submission', async () => {
    const currentTime = new Date('2026-02-16T07:56:00.000Z');
    const stateFixtures = await createRuntimeStates();
    const originalPosition = createPositionDouble({
      symbol: 'BULL.HK',
      quantity: 500,
      availableQuantity: 500,
    });
    await publishPositions(stateFixtures, [originalPosition]);

    let executionCalls = 0;
    let accountInvalidationCalls = 0;
    let clearBuyOrderCalls = 0;
    const monitorContext = createMonitorContext(
      createMonitorConfigDouble(),
      createOrderRecorderDouble({
        clearBuyOrders: () => {
          clearBuyOrderCalls += 1;
        },
      }),
    );
    const doomsday = createDoomsdayClearanceWorkflow({
      logger: createLoggerDouble(),
      now: () => currentTime,
    });
    const tradeRuntime = createTradeRuntimeDouble({
      orderExecutor: {
        executeDoomsdayClearanceSignals: async () => {
          executionCalls += 1;
          stateFixtures.lifecycleState.isTradingEnabled = false;
          return {
            executedOrderIds: ['SUBMITTED-BEFORE-CLOSE'],
            awaitingAuthoritativeTerminalSymbols: [],
            unresolvedQuoteSymbols: [],
          };
        },
      },
    });

    const result = await doomsday.executeClearance({
      currentTime,
      isHalfDay: false,
      positions: snapshotOf(stateFixtures).getView().positions,
      monitorContext,
      orderExecutor: tradeRuntime.orderExecutor,
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () => new Map([['BULL.HK', createQuoteDouble('BULL.HK', '1.1', 100)]]),
      }),
      ...stateFixtures,
      isLive: () => stateFixtures.lifecycleState.isTradingEnabled,
      snapshot: {
        ...snapshotOf(stateFixtures),
        invalidateAccount: () => {
          accountInvalidationCalls++;
          snapshotOf(stateFixtures).invalidateAccount();
        },
      },
    });

    expect(result).toEqual({ executed: true, nextRetryAtMs: null });
    expect(executionCalls).toBe(1);
    expect(accountInvalidationCalls).toBe(0);
    expect(clearBuyOrderCalls).toBe(0);
    expect(snapshotOf(stateFixtures).getView().account).not.toBeNull();
    expect(snapshotOf(stateFixtures).getView().positions).toEqual([originalPosition]);
    expect(snapshotOf(stateFixtures).getAvailablePosition('BULL.HK')).toEqual(originalPosition);
  });
});
