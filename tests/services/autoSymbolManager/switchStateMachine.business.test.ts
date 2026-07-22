/**
 * switchStateMachine 业务测试
 *
 * 功能：
 * - 验证换标状态机相关场景意图、边界条件与业务期望。
 */
import { describe, expect, it } from 'bun:test';
import { OrderSide, OrderType } from 'longbridge';
import { toMockDecimal } from '../../../mock/longbridge/decimal.js';
import { createSeatRuntimeCleanupDispatcher } from '../../../src/main/seatRuntimeCleanupDispatcher/index.js';
import { createMonitorTaskQueue } from '../../../src/main/asyncProgram/monitorTaskQueue/index.js';
import {
  createBuyTaskQueue,
  createSellTaskQueue,
} from '../../../src/main/asyncProgram/tradeTaskQueue/index.js';
import { createAutoSymbolManager } from '../../../src/services/autoSymbolManager/index.js';
import { createSwitchStateMachine as createProductionSwitchStateMachine } from '../../../src/services/autoSymbolManager/switchStateMachine.js';
import { createSeatStateManager } from '../../../src/services/autoSymbolManager/seatStateManager.js';
import { createSymbolRegistry } from '../../../src/services/autoSymbolManager/utils.js';
import {
  createSignalBuilder,
  calculateBuyQuantityByNotional,
  resolveDirectionSymbols,
} from '../../../src/services/autoSymbolManager/signalBuilder.js';
import { calculateTradingDurationMsBetween, getHKDateKey } from '../../../src/utils/time/index.js';
import { ORDER_QUOTE_RETRY, PENDING_ORDER_STATUSES } from '../../../src/constants/index.js';
import { createExternalApiRequestError } from '../../helpers/createExternalApiRequestError.js';
import type { PeriodicSwitchPendingState } from '../../../src/types/monitorContextPorts.js';
import type { MonitorTaskDataMap } from '../../../src/main/asyncProgram/monitorTaskProcessor/types.js';
import type {
  SwitchStateMachineDeps,
  SwitchState,
  SwitchSuppression,
} from '../../../src/services/autoSymbolManager/types.js';
import type { OrderRecorder, Trader } from '../../../src/types/services.js';
import type { Quote } from '../../../src/types/quote.js';
import {
  createWarrantDistanceInfoDouble,
  createMarketDataClientDouble,
  createMonitorConfigDouble,
  createMonitorContextDouble,
  createOrderRecorderDouble,
  createPositionDouble,
  createRiskCheckerDouble,
  createSymbolRegistryDouble,
  createTraderDouble,
} from '../../helpers/testDoubles.js';
import {
  createDirectionalAutoSearchPolicy,
  createFindBestWarrantInputDouble,
  createLoggerStub,
  createWarrantCandidate,
  createWarrantCandidateWithOverrides,
  getDefaultAutoSearchConfig,
} from './utils.js';

type TestStartSwitchParams = Omit<
  Parameters<ReturnType<typeof createProductionSwitchStateMachine>['startSwitchOnDistance']>[0],
  'canContinue'
> & {
  readonly canContinue?: () => boolean;
};

type TestAdvanceSwitchParams = Omit<
  Parameters<ReturnType<typeof createProductionSwitchStateMachine>['advancePendingSwitch']>[0],
  'canContinue'
> & {
  readonly canContinue?: () => boolean;
};

type TestPeriodicSwitchParams = Omit<
  Parameters<ReturnType<typeof createProductionSwitchStateMachine>['evaluatePeriodicSwitchDue']>[0],
  'canContinue'
> & {
  readonly canContinue?: () => boolean;
};

type TestSwitchStateMachine = Omit<
  ReturnType<typeof createProductionSwitchStateMachine>,
  'startSwitchOnDistance' | 'advancePendingSwitch' | 'evaluatePeriodicSwitchDue'
> & {
  readonly startSwitchOnDistance: (
    params: TestStartSwitchParams,
  ) => ReturnType<ReturnType<typeof createProductionSwitchStateMachine>['startSwitchOnDistance']>;
  readonly advancePendingSwitch: (
    params: TestAdvanceSwitchParams,
  ) => ReturnType<ReturnType<typeof createProductionSwitchStateMachine>['advancePendingSwitch']>;
  readonly evaluatePeriodicSwitchDue: (
    params: TestPeriodicSwitchParams,
  ) => ReturnType<
    ReturnType<typeof createProductionSwitchStateMachine>['evaluatePeriodicSwitchDue']
  >;
};

function createSwitchStateMachine(deps: SwitchStateMachineDeps): TestSwitchStateMachine {
  const machine = createProductionSwitchStateMachine(deps);
  return {
    ...machine,
    startSwitchOnDistance: (params) =>
      machine.startSwitchOnDistance({ ...params, canContinue: params.canContinue ?? (() => true) }),
    advancePendingSwitch: (params) =>
      machine.advancePendingSwitch({ ...params, canContinue: params.canContinue ?? (() => true) }),
    evaluatePeriodicSwitchDue: (params) =>
      machine.evaluatePeriodicSwitchDue({
        ...params,
        canContinue: params.canContinue ?? (() => true),
      }),
  };
}

function createQuotes(prices: Readonly<Record<string, number>>): ReadonlyMap<string, Quote | null> {
  const map = new Map<string, Quote | null>();
  for (const [symbol, price] of Object.entries(prices)) {
    map.set(symbol, {
      symbol,
      name: symbol,
      price,
      prevClose: price,
      timestamp: Date.now(),
      lotSize: 100,
    });
  }

  return map;
}

function createTradingCalendarSnapshot() {
  return new Map([
    ['2026-02-16', { isTradingDay: true, isHalfDay: false }],
    ['2026-02-17', { isTradingDay: true, isHalfDay: false }],
  ]);
}

function createSwitchStatesMap(): Map<'LONG' | 'SHORT', SwitchState> {
  return new Map<'LONG' | 'SHORT', SwitchState>();
}

function createSwitchSuppressionsMap(): Map<'LONG' | 'SHORT', SwitchSuppression> {
  return new Map<'LONG' | 'SHORT', SwitchSuppression>();
}

function createPeriodicSwitchPendingMap(): Map<'LONG' | 'SHORT', PeriodicSwitchPendingState> {
  return new Map<'LONG' | 'SHORT', PeriodicSwitchPendingState>();
}

function createDeferred<T = void>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });

  return { promise, resolve };
}

function createLongSwitchAdmissionHarness(params: {
  readonly nowMs: number;
  readonly now?: () => Date;
  readonly traderOverrides?: Partial<Trader>;
  readonly orderRecorder?: OrderRecorder;
  readonly findBestWarrant?: SwitchStateMachineDeps['findBestWarrant'];
  readonly marketDataClient?: SwitchStateMachineDeps['marketDataClient'];
}) {
  const monitorConfig = createMonitorConfigDouble({
    autoSearchConfig: {
      ...getDefaultAutoSearchConfig(),
      switchIntervalMinutes: 1,
    },
  });
  const symbolRegistry = createSymbolRegistryDouble({
    longSeat: {
      symbol: 'OLD_BULL.HK',
      status: 'ACTIVE',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: params.nowMs - 31 * 60_000,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    },
    longVersion: 1,
  });
  const switchStates = createSwitchStatesMap();
  const switchSuppressions = createSwitchSuppressionsMap();
  const now = params.now ?? (() => new Date(params.nowMs));
  const seatStateManager = createSeatStateManager({
    symbolRegistry,
    switchStates,
    switchSuppressions,
    now,
    logger: createLoggerStub(),
    getHKDateKey,
  });
  const signalBuilder = createSignalBuilder();
  const trader = createTraderDouble(params.traderOverrides);
  const machine = createSwitchStateMachine({
    autoSearchConfig: monitorConfig.autoSearchConfig,
    monitorSymbol: 'HSI.HK',
    symbolRegistry,
    trader,
    orderRecorder: params.orderRecorder ?? createOrderRecorderDouble(),
    riskChecker: createRiskCheckerDouble({
      getWarrantDistanceInfo: () =>
        createWarrantDistanceInfoDouble({
          warrantType: 'BULL',
          distanceToStrikePercent: 0.1,
        }),
    }),
    now,
    switchStates,
    periodicSwitchPending: createPeriodicSwitchPendingMap(),
    resolveSuppression: seatStateManager.resolveSuppression,
    markSuppression: seatStateManager.markSuppression,
    enterSwitchingSeat: seatStateManager.enterSwitchingSeat,
    updateSeatState: seatStateManager.updateSeatState,
    resolveDirectionalAutoSearchPolicy: () => createDirectionalAutoSearchPolicy('LONG'),
    buildFindBestWarrantInput: async () => createFindBestWarrantInputDouble(),
    findBestWarrant: params.findBestWarrant ?? (async () => createWarrantCandidate('NEW_BULL.HK')),
    resolveDirectionSymbols,
    calculateBuyQuantityByNotional,
    buildOrderSignal: signalBuilder.buildOrderSignal,
    pendingOrderStatuses: PENDING_ORDER_STATUSES,
    buySide: OrderSide.Buy,
    logger: createLoggerStub(),
    maxSearchFailuresPerDay: 3,
    getHKDateKey,
    calculateTradingDurationMsBetween,
    getTradingCalendarSnapshot: () => createTradingCalendarSnapshot(),
    marketDataClient:
      params.marketDataClient ??
      createMarketDataClientDouble({
        getQuotes: async () => new Map(),
      }),
  });

  return { machine, symbolRegistry, switchStates };
}

async function runDistanceSwitch(
  machine: ReturnType<typeof createSwitchStateMachine>,
  params: Omit<
    Parameters<ReturnType<typeof createSwitchStateMachine>['startSwitchOnDistance']>[0],
    'canContinue'
  >,
): Promise<void> {
  const switchParams = { ...params, canContinue: () => true };
  if (machine.hasPendingSwitch(params.direction)) {
    await machine.advancePendingSwitch(switchParams);
    return;
  }

  const startResult = await machine.startSwitchOnDistance(switchParams);
  if (startResult.started) {
    await machine.advancePendingSwitch(switchParams);
  }
}

describe('autoSymbolManager switchStateMachine business flow', () => {
  it('将 cleanup listener 的聚合失败上抛给距离换标 admission，且不写入 pending switch', async () => {
    const nowMs = Date.parse('2026-02-16T01:31:00.000Z');
    const monitorConfig = createMonitorConfigDouble({
      autoSearchConfig: {
        ...getDefaultAutoSearchConfig(),
        switchIntervalMinutes: 1,
      },
    });
    const symbolRegistry = createSymbolRegistry(monitorConfig);
    symbolRegistry.updateSeatState('LONG', {
      symbol: 'OLD_BULL.HK',
      status: 'ACTIVE',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: nowMs - 31 * 60_000,
      callPrice: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    });

    const cleanupError = new Error('cleanup listener failed');
    const riskChecker = createRiskCheckerDouble({
      clearLongWarrantInfo: () => {
        throw cleanupError;
      },
      getWarrantDistanceInfo: () =>
        createWarrantDistanceInfoDouble({
          warrantType: 'BULL',
          distanceToStrikePercent: 0.1,
        }),
    });
    const autoSymbolManager = createAutoSymbolManager({
      monitorConfig,
      symbolRegistry,
      marketDataClient: createMarketDataClientDouble(),
      trader: createTraderDouble(),
      orderRecorder: createOrderRecorderDouble(),
      riskChecker,
      findBestWarrant: async () => createWarrantCandidate('NEW_BULL.HK'),
      getTradingCalendarSnapshot: () => createTradingCalendarSnapshot(),
      now: () => new Date(nowMs),
    });
    const dispatcher = createSeatRuntimeCleanupDispatcher({
      symbolRegistry,
      monitorContext: createMonitorContextDouble({
        config: monitorConfig,
        symbolRegistry,
        autoSymbolManager,
        riskChecker,
      }),
      buyTaskQueue: createBuyTaskQueue(),
      sellTaskQueue: createSellTaskQueue(),
      monitorTaskQueue: createMonitorTaskQueue<MonitorTaskDataMap>(),
    });
    const observedListeners: string[] = [];

    dispatcher.start();
    const unsubscribeStateFirst = symbolRegistry.onSeatStateChanged(() => {
      observedListeners.push('state:first');
    });
    const unsubscribeStateSecond = symbolRegistry.onSeatStateChanged(() => {
      observedListeners.push('state:second');
    });
    const unsubscribeTruthFirst = symbolRegistry.onSeatTruthChanged(() => {
      observedListeners.push('truth:first');
    });
    const unsubscribeTruthSecond = symbolRegistry.onSeatTruthChanged(() => {
      observedListeners.push('truth:second');
    });

    let caught: unknown = null;
    try {
      await autoSymbolManager.startSwitchOnDistance({
        direction: 'LONG',
        monitorPrice: 20_000,
        positions: [],
        canContinue: () => true,
      });
    } catch (error) {
      caught = error;
    } finally {
      unsubscribeStateFirst();
      unsubscribeStateSecond();
      unsubscribeTruthFirst();
      unsubscribeTruthSecond();
      dispatcher.stop();
    }

    expect(caught).toBeInstanceOf(AggregateError);
    if (!(caught instanceof AggregateError)) {
      throw new Error('预期距离换标 admission 接管 cleanup listener 的 AggregateError');
    }

    expect(caught.errors).toEqual([cleanupError]);
    expect(observedListeners).toEqual([
      'state:first',
      'state:second',
      'truth:first',
      'truth:second',
    ]);

    expect(symbolRegistry.getSeatState('LONG')).toMatchObject({
      symbol: 'OLD_BULL.HK',
      status: 'SWITCHING',
    });
    expect(symbolRegistry.getSeatVersion('LONG')).toBe(2);
    expect(autoSymbolManager.hasPendingSwitch('LONG')).toBeFalse();
  });

  it('keeps distance-switch seat ACTIVE when candidate precheck has a true external failure', async () => {
    const nowMs = Date.parse('2026-02-16T01:31:00.000Z');
    const candidateError = await createExternalApiRequestError({
      operation: 'test.findBestWarrant',
      attempts: 1,
      cause: new Error('candidate query unavailable'),
    });
    const harness = createLongSwitchAdmissionHarness({
      nowMs,
      findBestWarrant: async () => {
        throw candidateError;
      },
    });

    let caught: unknown = null;
    try {
      await harness.machine.startSwitchOnDistance({
        direction: 'LONG',
        monitorPrice: 20_000,
        positions: [],
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(candidateError);
    expect(harness.symbolRegistry.getSeatState('LONG')).toMatchObject({
      status: 'ACTIVE',
      symbol: 'OLD_BULL.HK',
    });
    expect(harness.symbolRegistry.getSeatVersion('LONG')).toBe(1);
    expect(harness.switchStates.size).toBe(0);
  });

  it('keeps distance-switch seat ACTIVE when pending-order admission has a true external failure', async () => {
    const nowMs = Date.parse('2026-02-16T01:31:00.000Z');
    const pendingOrderError = await createExternalApiRequestError({
      operation: 'test.getPendingOrders',
      attempts: 1,
      cause: new Error('pending orders unavailable'),
    });
    const harness = createLongSwitchAdmissionHarness({
      nowMs,
      traderOverrides: {
        getPendingOrders: async () => {
          throw pendingOrderError;
        },
      },
    });

    let caught: unknown = null;
    try {
      await harness.machine.startSwitchOnDistance({
        direction: 'LONG',
        monitorPrice: 20_000,
        positions: [],
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(pendingOrderError);

    expect(harness.symbolRegistry.getSeatState('LONG')).toMatchObject({
      status: 'ACTIVE',
      symbol: 'OLD_BULL.HK',
    });
    expect(harness.symbolRegistry.getSeatVersion('LONG')).toBe(1);
    expect(harness.switchStates.size).toBe(0);
  });

  it('keeps periodic-switch seat ACTIVE when pending-order admission read fails', async () => {
    const nowMs = Date.parse('2026-02-16T01:31:00.000Z');
    const harness = createLongSwitchAdmissionHarness({
      nowMs,
      traderOverrides: {
        getPendingOrders: async () => {
          throw new Error('pending orders unavailable');
        },
      },
    });

    let caught: unknown = null;
    try {
      await harness.machine.evaluatePeriodicSwitchDue({
        direction: 'LONG',
        currentTime: new Date(nowMs),
        canContinue: () => true,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({ message: 'pending orders unavailable' });

    expect(harness.symbolRegistry.getSeatState('LONG')).toMatchObject({
      status: 'ACTIVE',
      symbol: 'OLD_BULL.HK',
    });
    expect(harness.symbolRegistry.getSeatVersion('LONG')).toBe(1);
    expect(harness.switchStates.size).toBe(0);
  });

  it('abandons switch admission when seat identity changes during pending-order read', async () => {
    const nowMs = Date.parse('2026-02-16T01:31:00.000Z');
    let resolvePendingOrders = (): void => {
      throw new Error('pending-order resolver not initialized');
    };
    const pendingOrders = new Promise<ReadonlyArray<never>>((resolve) => {
      resolvePendingOrders = () => {
        resolve([]);
      };
    });
    const harness = createLongSwitchAdmissionHarness({
      nowMs,
      traderOverrides: {
        getPendingOrders: async () => await pendingOrders,
      },
    });

    const startPromise = harness.machine.startSwitchOnDistance({
      direction: 'LONG',
      monitorPrice: 20_000,
      positions: [],
    });
    await Bun.sleep(0);

    expect(harness.symbolRegistry.getSeatState('LONG').status).toBe('ACTIVE');
    expect(harness.symbolRegistry.getSeatVersion('LONG')).toBe(1);
    const currentSeat = harness.symbolRegistry.getSeatState('LONG');
    if (currentSeat.status !== 'ACTIVE' || currentSeat.lastSeatActivatedAt === null) {
      throw new Error('expected runtime ACTIVE LONG seat');
    }

    harness.symbolRegistry.updateSeatStateWithVersionBump('LONG', {
      ...currentSeat,
      symbol: 'OTHER_BULL.HK',
    });
    resolvePendingOrders();

    const result = await startPromise;
    expect(result).toMatchObject({
      started: false,
      driveResult: { kind: 'NOOP' },
    });

    expect(harness.symbolRegistry.getSeatState('LONG')).toMatchObject({
      status: 'ACTIVE',
      symbol: 'OTHER_BULL.HK',
    });
    expect(harness.switchStates.size).toBe(0);
  });

  it('returns a non-empty initial WAIT without executing switch side effects after mutation', async () => {
    const nowMs = Date.parse('2026-02-16T01:31:00.000Z');
    let cancelCalls = 0;
    let executeCalls = 0;
    let quoteCalls = 0;
    const harness = createLongSwitchAdmissionHarness({
      nowMs,
      traderOverrides: {
        getPendingOrders: async () => [],
        cancelOrder: async () => {
          cancelCalls += 1;
          return {
            kind: 'CANCEL_CONFIRMED',
            closedReason: 'CANCELED',
            source: 'API',
            relatedBuyOrderIds: null,
          };
        },
        executeSignals: async () => {
          executeCalls += 1;
          return { executedOrderIds: ['ORDER-1'] };
        },
      },
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () => {
          quoteCalls += 1;
          return new Map();
        },
      }),
    });

    const result = await harness.machine.startSwitchOnDistance({
      direction: 'LONG',
      monitorPrice: 20_000,
      positions: [],
    });

    expect(result).toEqual({
      started: true,
      direction: 'LONG',
      driveResult: {
        kind: 'WAIT',
        wakeups: [{ kind: 'RETRY_TIMER', atMs: nowMs }],
      },
    });
    expect(harness.symbolRegistry.getSeatState('LONG').status).toBe('SWITCHING');
    expect(harness.switchStates.size).toBe(1);
    expect(cancelCalls).toBe(0);
    expect(executeCalls).toBe(0);
    expect(quoteCalls).toBe(0);
  });

  it('replaces a consumed initial timer when pending-order refresh has an external failure', async () => {
    const nowMs = Date.parse('2026-02-16T01:31:00.000Z');
    let pendingOrderCalls = 0;
    const harness = createLongSwitchAdmissionHarness({
      nowMs,
      traderOverrides: {
        getPendingOrders: async () => {
          pendingOrderCalls += 1;
          if (pendingOrderCalls === 2) {
            throw await createExternalApiRequestError({
              operation: 'test.pendingOrders',
              attempts: 1,
              cause: new Error('pending orders unavailable'),
            });
          }

          return [];
        },
      },
    });

    const startResult = await harness.machine.startSwitchOnDistance({
      direction: 'LONG',
      monitorPrice: 20_000,
      positions: [],
    });
    expect(startResult.started).toBeTrue();

    const failedAdvance = await harness.machine.advancePendingSwitch({
      direction: 'LONG',
      positions: [],
    });
    expect(failedAdvance).toMatchObject({
      advanced: true,
      direction: 'LONG',
      stillPending: true,
      driveResult: {
        kind: 'WAIT',
        wakeups: [{ kind: 'RETRY_TIMER' }],
      },
    });
    expect(harness.machine.hasPendingSwitch('LONG')).toBeTrue();

    const nextAdvance = await harness.machine.advancePendingSwitch({
      direction: 'LONG',
      positions: [],
    });
    expect(nextAdvance).toMatchObject({
      advanced: true,
      stillPending: false,
      driveResult: { kind: 'COMPLETED' },
    });
    expect(harness.symbolRegistry.getSeatState('LONG').status).toBe('ACTIVATING');
  });

  it('replaces a consumed timer when SELL_OUT quote read has an external failure', async () => {
    const clock = { nowMs: Date.parse('2026-02-16T01:31:00.000Z') };
    const availableOldPosition = createPositionDouble({
      symbol: 'OLD_BULL.HK',
      quantity: 100,
      availableQuantity: 100,
    });
    let quoteCalls = 0;
    let executeCalls = 0;
    const harness = createLongSwitchAdmissionHarness({
      nowMs: clock.nowMs,
      now: () => new Date(clock.nowMs),
      traderOverrides: {
        getPendingOrders: async () => [],
        executeSignals: async () => {
          executeCalls += 1;
          return { executedOrderIds: ['SELL-ORDER-1'] };
        },
      },
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () => {
          quoteCalls += 1;
          if (quoteCalls === 1) {
            throw await createExternalApiRequestError({
              operation: 'test.sellOutQuote',
              attempts: 1,
              cause: new Error('sell quote unavailable'),
            });
          }

          return new Map(createQuotes({ 'OLD_BULL.HK': 1 }));
        },
      }),
    });

    const startResult = await harness.machine.startSwitchOnDistance({
      direction: 'LONG',
      monitorPrice: 20_000,
      positions: [],
    });
    expect(startResult.started).toBeTrue();

    const failedQuoteAdvance = await harness.machine.advancePendingSwitch({
      direction: 'LONG',
      positions: [availableOldPosition],
    });
    expect(failedQuoteAdvance).toEqual({
      advanced: true,
      direction: 'LONG',
      stillPending: true,
      driveResult: {
        kind: 'WAIT',
        wakeups: [
          { kind: 'SYMBOL_QUOTE', symbol: 'OLD_BULL.HK' },
          { kind: 'RETRY_TIMER', atMs: clock.nowMs + ORDER_QUOTE_RETRY.INTERVAL_MS },
        ],
      },
    });
    expect(harness.machine.hasPendingSwitch('LONG')).toBeTrue();
    expect(executeCalls).toBe(0);

    clock.nowMs += ORDER_QUOTE_RETRY.INTERVAL_MS;
    const successfulQuoteAdvance = await harness.machine.advancePendingSwitch({
      direction: 'LONG',
      positions: [availableOldPosition],
    });
    expect(successfulQuoteAdvance).toEqual({
      advanced: true,
      direction: 'LONG',
      stillPending: true,
      driveResult: {
        kind: 'WAIT',
        wakeups: [{ kind: 'ORDER_EVENT', symbols: ['OLD_BULL.HK'] }, { kind: 'FRESHNESS' }],
      },
    });
    expect(quoteCalls).toBe(2);
    expect(executeCalls).toBe(1);
  });

  it('replaces a consumed timer when WAIT_QUOTE read has an external failure without submitting rebuy', async () => {
    const clock = { nowMs: Date.parse('2026-02-16T01:31:00.000Z') };
    const availableOldPosition = createPositionDouble({
      symbol: 'OLD_BULL.HK',
      quantity: 100,
      availableQuantity: 100,
    });
    const executedActions: string[] = [];
    let nextQuoteCalls = 0;
    const harness = createLongSwitchAdmissionHarness({
      nowMs: clock.nowMs,
      now: () => new Date(clock.nowMs),
      traderOverrides: {
        getPendingOrders: async () => [],
        executeSignals: async (signals) => {
          const action = signals[0]?.action;
          if (action === undefined) {
            throw new Error('expected switch signal');
          }

          executedActions.push(action);
          return { executedOrderIds: [`${action}-ORDER-1`] };
        },
      },
      orderRecorder: createOrderRecorderDouble({
        getSellRecordByOrderId: (orderId) =>
          orderId === 'SELLCALL-ORDER-1'
            ? {
                orderId,
                symbol: 'OLD_BULL.HK',
                executedPrice: 2,
                executedQuantity: 100,
                executedTime: clock.nowMs,
                submittedAt: undefined,
                updatedAt: undefined,
              }
            : null,
      }),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async (symbols) => {
          const [symbol] = symbols;
          if (symbol === 'OLD_BULL.HK') {
            return new Map(createQuotes({ 'OLD_BULL.HK': 1 }));
          }

          nextQuoteCalls += 1;
          if (nextQuoteCalls === 1) {
            throw await createExternalApiRequestError({
              operation: 'test.waitQuote',
              attempts: 1,
              cause: new Error('next quote unavailable'),
            });
          }

          return new Map(createQuotes({ 'NEW_BULL.HK': 1 }));
        },
      }),
    });

    await harness.machine.startSwitchOnDistance({
      direction: 'LONG',
      monitorPrice: 20_000,
      positions: [availableOldPosition],
    });

    await harness.machine.advancePendingSwitch({
      direction: 'LONG',
      positions: [availableOldPosition],
    });

    await harness.machine.advancePendingSwitch({ direction: 'LONG', positions: [] });

    const failedWaitQuoteAdvance = await harness.machine.advancePendingSwitch({
      direction: 'LONG',
      positions: [],
    });

    expect(failedWaitQuoteAdvance).toEqual({
      advanced: true,
      direction: 'LONG',
      stillPending: true,
      driveResult: {
        kind: 'WAIT',
        wakeups: [
          { kind: 'SYMBOL_QUOTE', symbol: 'NEW_BULL.HK' },
          { kind: 'RETRY_TIMER', atMs: clock.nowMs + ORDER_QUOTE_RETRY.INTERVAL_MS },
        ],
      },
    });

    expect(harness.symbolRegistry.getSeatState('LONG')).toMatchObject({
      symbol: 'NEW_BULL.HK',
      status: 'SWITCHING',
    });
    expect(harness.machine.hasPendingSwitch('LONG')).toBeTrue();
    expect(executedActions).toEqual(['SELLCALL']);

    clock.nowMs += ORDER_QUOTE_RETRY.INTERVAL_MS;
    const successfulWaitQuoteAdvance = await harness.machine.advancePendingSwitch({
      direction: 'LONG',
      positions: [],
    });

    expect(successfulWaitQuoteAdvance).toMatchObject({
      advanced: true,
      direction: 'LONG',
      stillPending: false,
      driveResult: { kind: 'COMPLETED' },
    });
    expect(executedActions).toEqual(['SELLCALL', 'BUYCALL']);
  });

  it('propagates external failure from SELL_OUT order submission', async () => {
    const nowMs = Date.parse('2026-02-16T01:31:00.000Z');
    const availableOldPosition = createPositionDouble({
      symbol: 'OLD_BULL.HK',
      quantity: 100,
      availableQuantity: 100,
    });
    const submitError = await createExternalApiRequestError({
      operation: 'test.sellOutSubmit',
      attempts: 1,
      cause: new Error('sell submission unavailable'),
    });
    const harness = createLongSwitchAdmissionHarness({
      nowMs,
      traderOverrides: {
        getPendingOrders: async () => [],
        executeSignals: async () => {
          throw submitError;
        },
      },
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () => new Map(createQuotes({ 'OLD_BULL.HK': 1 })),
      }),
    });

    const startResult = await harness.machine.startSwitchOnDistance({
      direction: 'LONG',
      monitorPrice: 20_000,
      positions: [],
    });
    expect(startResult.started).toBeTrue();

    let caught: unknown = null;
    try {
      await harness.machine.advancePendingSwitch({
        direction: 'LONG',
        positions: [availableOldPosition],
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(submitError);
    expect(harness.machine.hasPendingSwitch('LONG')).toBeTrue();
  });

  it('treats periodic no-candidate as business closeout instead of state-machine failure', async () => {
    const monitorConfig = createMonitorConfigDouble({
      autoSearchConfig: {
        ...getDefaultAutoSearchConfig(),
        switchIntervalMinutes: 1,
      },
    });
    const symbolRegistry = createSymbolRegistryDouble({
      longSeat: {
        symbol: 'OLD_BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: Date.parse('2026-02-16T01:00:00.000Z'),
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      longVersion: 1,
    });
    const switchStates = createSwitchStatesMap();
    const switchSuppressions = createSwitchSuppressionsMap();
    const periodicSwitchPending = createPeriodicSwitchPendingMap();
    const nowMs = Date.parse('2026-02-16T01:31:00.000Z');
    const infoMessages: string[] = [];
    const errorMessages: string[] = [];
    const logger = {
      ...createLoggerStub(),
      info: (message: string) => {
        infoMessages.push(message);
      },
      error: (message: string) => {
        errorMessages.push(message);
      },
    };
    const seatStateManager = createSeatStateManager({
      symbolRegistry,
      switchStates,
      switchSuppressions,
      now: () => new Date(nowMs),
      logger,
      getHKDateKey,
    });
    periodicSwitchPending.set('LONG', {
      pending: true,
      pendingSinceMs: nowMs - 5_000,
      blockedBy: 'ORDER_RECORDER',
    });
    const signalBuilder = createSignalBuilder();
    const machine = createSwitchStateMachine({
      autoSearchConfig: monitorConfig.autoSearchConfig,
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      trader: createTraderDouble(),
      orderRecorder: createOrderRecorderDouble(),
      riskChecker: createRiskCheckerDouble({
        getWarrantDistanceInfo: () =>
          createWarrantDistanceInfoDouble({
            warrantType: 'BULL',
            distanceToStrikePercent: 0.1,
          }),
      }),
      now: () => new Date(nowMs),
      switchStates,
      periodicSwitchPending,
      resolveSuppression: seatStateManager.resolveSuppression,
      markSuppression: seatStateManager.markSuppression,
      enterSwitchingSeat: seatStateManager.enterSwitchingSeat,
      updateSeatState: seatStateManager.updateSeatState,
      resolveDirectionalAutoSearchPolicy: () => createDirectionalAutoSearchPolicy('LONG'),
      buildFindBestWarrantInput: async () => createFindBestWarrantInputDouble(),
      findBestWarrant: async () => null,
      resolveDirectionSymbols,
      calculateBuyQuantityByNotional,
      buildOrderSignal: signalBuilder.buildOrderSignal,
      pendingOrderStatuses: PENDING_ORDER_STATUSES,
      buySide: OrderSide.Buy,
      logger,
      maxSearchFailuresPerDay: 3,
      getHKDateKey,
      calculateTradingDurationMsBetween,
      getTradingCalendarSnapshot: () => createTradingCalendarSnapshot(),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async (symbols) =>
          new Map(createQuotes(Object.fromEntries([...symbols].map((symbol) => [symbol, 1])))),
      }),
    });

    await machine.evaluatePeriodicSwitchDue({
      direction: 'LONG',
      currentTime: new Date(nowMs),
      canContinue: () => true,
    });

    const seat = symbolRegistry.getSeatState('LONG');
    expect(seat.status).toBe('EMPTY');
    expect(seat.symbol).toBeNull();
    expect(seat.searchFailCountToday).toBe(1);
    expect(symbolRegistry.getSeatVersion('LONG')).toBe(2);
    expect(periodicSwitchPending.has('LONG')).toBeFalse();
    expect(machine.hasPendingSwitch('LONG')).toBeFalse();
    expect(infoMessages.some((message) => message.includes('周期换标无候选，清空席位'))).toBeTrue();
    expect(errorMessages.some((message) => message.includes('状态机失败并清席位'))).toBeFalse();
    expect(
      errorMessages.some((message) => message.includes('MISSING_NEXT_SYMBOL_ON_BIND')),
    ).toBeFalse();
  });

  it('marks suppression only for safe-side distance same-symbol and skips switching', async () => {
    const monitorConfig = createMonitorConfigDouble({
      autoSearchConfig: getDefaultAutoSearchConfig(),
    });
    const symbolRegistry = createSymbolRegistryDouble({
      longSeat: {
        symbol: 'OLD_BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
    });
    const switchStates = createSwitchStatesMap();
    const switchSuppressions = createSwitchSuppressionsMap();
    const nowMs = Date.parse('2026-02-16T01:00:00.000Z');
    const seatStateManager = createSeatStateManager({
      symbolRegistry,
      switchStates,
      switchSuppressions,
      now: () => new Date(nowMs),
      logger: createLoggerStub(),
      getHKDateKey,
    });
    const signalBuilder = createSignalBuilder();
    const machine = createSwitchStateMachine({
      autoSearchConfig: monitorConfig.autoSearchConfig,
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      trader: createTraderDouble(),
      orderRecorder: createOrderRecorderDouble(),
      riskChecker: createRiskCheckerDouble({
        getWarrantDistanceInfo: () =>
          createWarrantDistanceInfoDouble({
            warrantType: 'BULL',
            distanceToStrikePercent: 2,
          }),
      }),
      now: () => new Date(nowMs),
      switchStates,
      periodicSwitchPending: createPeriodicSwitchPendingMap(),
      resolveSuppression: seatStateManager.resolveSuppression,
      markSuppression: seatStateManager.markSuppression,
      enterSwitchingSeat: seatStateManager.enterSwitchingSeat,
      updateSeatState: seatStateManager.updateSeatState,
      resolveDirectionalAutoSearchPolicy: () => createDirectionalAutoSearchPolicy('LONG'),
      buildFindBestWarrantInput: async () => createFindBestWarrantInputDouble(),
      findBestWarrant: async () => ({
        ...createWarrantCandidate('OLD_BULL.HK'),
        callPrice: 20_000,
      }),
      resolveDirectionSymbols,
      calculateBuyQuantityByNotional,
      buildOrderSignal: signalBuilder.buildOrderSignal,
      pendingOrderStatuses: PENDING_ORDER_STATUSES,
      buySide: OrderSide.Buy,
      logger: createLoggerStub(),
      maxSearchFailuresPerDay: 3,
      getHKDateKey,
      calculateTradingDurationMsBetween,
      getTradingCalendarSnapshot: () => createTradingCalendarSnapshot(),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async (symbols) =>
          new Map(createQuotes(Object.fromEntries([...symbols].map((symbol) => [symbol, 1])))),
      }),
    });
    await runDistanceSwitch(machine, {
      direction: 'LONG',
      monitorPrice: 20_000,
      positions: [],
    });
    const seat = symbolRegistry.getSeatState('LONG');
    expect(seat.status).toBe('ACTIVE');
    expect(seat.symbol).toBe('OLD_BULL.HK');
    const suppression = seatStateManager.resolveSuppression(
      'LONG',
      'OLD_BULL.HK',
      'DISTANCE_SAFE_SIDE',
    );
    expect(suppression?.symbol).toBe('OLD_BULL.HK');
    expect(machine.hasPendingSwitch('LONG')).toBeFalse();
  });

  it('does not mark suppression for danger-side distance same-symbol and skips switching', async () => {
    const monitorConfig = createMonitorConfigDouble({
      autoSearchConfig: getDefaultAutoSearchConfig(),
    });
    const symbolRegistry = createSymbolRegistryDouble({
      longSeat: {
        symbol: 'OLD_BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
    });
    const switchStates = createSwitchStatesMap();
    const switchSuppressions = createSwitchSuppressionsMap();
    const nowMs = Date.parse('2026-02-16T01:00:00.000Z');
    const seatStateManager = createSeatStateManager({
      symbolRegistry,
      switchStates,
      switchSuppressions,
      now: () => new Date(nowMs),
      logger: createLoggerStub(),
      getHKDateKey,
    });
    const signalBuilder = createSignalBuilder();
    const machine = createSwitchStateMachine({
      autoSearchConfig: monitorConfig.autoSearchConfig,
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      trader: createTraderDouble(),
      orderRecorder: createOrderRecorderDouble(),
      riskChecker: createRiskCheckerDouble({
        getWarrantDistanceInfo: () =>
          createWarrantDistanceInfoDouble({
            warrantType: 'BULL',
            distanceToStrikePercent: 0.1,
          }),
      }),
      now: () => new Date(nowMs),
      switchStates,
      periodicSwitchPending: createPeriodicSwitchPendingMap(),
      resolveSuppression: seatStateManager.resolveSuppression,
      markSuppression: seatStateManager.markSuppression,
      enterSwitchingSeat: seatStateManager.enterSwitchingSeat,
      updateSeatState: seatStateManager.updateSeatState,
      resolveDirectionalAutoSearchPolicy: () => createDirectionalAutoSearchPolicy('LONG'),
      buildFindBestWarrantInput: async () => createFindBestWarrantInputDouble(),
      findBestWarrant: async () => ({
        ...createWarrantCandidate('OLD_BULL.HK'),
        callPrice: 20_000,
      }),
      resolveDirectionSymbols,
      calculateBuyQuantityByNotional,
      buildOrderSignal: signalBuilder.buildOrderSignal,
      pendingOrderStatuses: PENDING_ORDER_STATUSES,
      buySide: OrderSide.Buy,
      logger: createLoggerStub(),
      maxSearchFailuresPerDay: 3,
      getHKDateKey,
      calculateTradingDurationMsBetween,
      getTradingCalendarSnapshot: () => createTradingCalendarSnapshot(),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async (symbols) =>
          new Map(createQuotes(Object.fromEntries([...symbols].map((symbol) => [symbol, 1])))),
      }),
    });
    await runDistanceSwitch(machine, {
      direction: 'LONG',
      monitorPrice: 20_000,
      positions: [],
    });
    const seat = symbolRegistry.getSeatState('LONG');
    expect(seat.status).toBe('ACTIVE');
    expect(seat.symbol).toBe('OLD_BULL.HK');
    expect(
      seatStateManager.resolveSuppression('LONG', 'OLD_BULL.HK', 'DISTANCE_SAFE_SIDE'),
    ).toBeNull();
    expect(machine.hasPendingSwitch('LONG')).toBeFalse();
  });

  it('does not let periodic suppression block safe-side distance presearch on same symbol and day', async () => {
    const monitorConfig = createMonitorConfigDouble({
      autoSearchConfig: getDefaultAutoSearchConfig(),
    });
    const symbolRegistry = createSymbolRegistryDouble({
      longSeat: {
        symbol: 'OLD_BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
    });
    const switchStates = createSwitchStatesMap();
    const switchSuppressions = createSwitchSuppressionsMap();
    const nowMs = Date.parse('2026-02-16T01:00:00.000Z');
    const seatStateManager = createSeatStateManager({
      symbolRegistry,
      switchStates,
      switchSuppressions,
      now: () => new Date(nowMs),
      logger: createLoggerStub(),
      getHKDateKey,
    });
    seatStateManager.markSuppression('LONG', 'OLD_BULL.HK', 'PERIODIC');

    let findBestCalls = 0;
    const signalBuilder = createSignalBuilder();
    const machine = createSwitchStateMachine({
      autoSearchConfig: monitorConfig.autoSearchConfig,
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      trader: createTraderDouble(),
      orderRecorder: createOrderRecorderDouble(),
      riskChecker: createRiskCheckerDouble({
        getWarrantDistanceInfo: () =>
          createWarrantDistanceInfoDouble({
            warrantType: 'BULL',
            distanceToStrikePercent: 2,
          }),
      }),
      now: () => new Date(nowMs),
      switchStates,
      periodicSwitchPending: createPeriodicSwitchPendingMap(),
      resolveSuppression: seatStateManager.resolveSuppression,
      markSuppression: seatStateManager.markSuppression,
      enterSwitchingSeat: seatStateManager.enterSwitchingSeat,
      updateSeatState: seatStateManager.updateSeatState,
      resolveDirectionalAutoSearchPolicy: () => createDirectionalAutoSearchPolicy('LONG'),
      buildFindBestWarrantInput: async () => createFindBestWarrantInputDouble(),
      findBestWarrant: async () => {
        findBestCalls += 1;
        return {
          ...createWarrantCandidate('OLD_BULL.HK'),
          callPrice: 20_000,
        };
      },
      resolveDirectionSymbols,
      calculateBuyQuantityByNotional,
      buildOrderSignal: signalBuilder.buildOrderSignal,
      pendingOrderStatuses: PENDING_ORDER_STATUSES,
      buySide: OrderSide.Buy,
      logger: createLoggerStub(),
      maxSearchFailuresPerDay: 3,
      getHKDateKey,
      calculateTradingDurationMsBetween,
      getTradingCalendarSnapshot: () => createTradingCalendarSnapshot(),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async (symbols) =>
          new Map(createQuotes(Object.fromEntries([...symbols].map((symbol) => [symbol, 1])))),
      }),
    });

    await runDistanceSwitch(machine, {
      direction: 'LONG',
      monitorPrice: 20_000,
      positions: [],
    });

    expect(findBestCalls).toBe(1);
    expect(seatStateManager.resolveSuppression('LONG', 'OLD_BULL.HK', 'PERIODIC')).not.toBeNull();
    expect(
      seatStateManager.resolveSuppression('LONG', 'OLD_BULL.HK', 'DISTANCE_SAFE_SIDE'),
    ).not.toBeNull();
  });

  it('ignores presearch result when seat changes during candidate lookup', async () => {
    const monitorConfig = createMonitorConfigDouble({
      autoSearchConfig: getDefaultAutoSearchConfig(),
    });
    const symbolRegistry = createSymbolRegistryDouble({
      longSeat: {
        symbol: 'OLD_BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      longVersion: 1,
    });
    const switchStates = createSwitchStatesMap();
    const switchSuppressions = createSwitchSuppressionsMap();
    const nowMs = Date.parse('2026-02-16T01:00:00.000Z');
    const seatStateManager = createSeatStateManager({
      symbolRegistry,
      switchStates,
      switchSuppressions,
      now: () => new Date(nowMs),
      logger: createLoggerStub(),
      getHKDateKey,
    });
    const signalBuilder = createSignalBuilder();
    let resolveCandidate!: (value: ReturnType<typeof createWarrantCandidate> | null) => void;
    const pendingCandidate = new Promise<ReturnType<typeof createWarrantCandidate> | null>(
      (resolve) => {
        resolveCandidate = resolve;
      },
    );
    const machine = createSwitchStateMachine({
      autoSearchConfig: monitorConfig.autoSearchConfig,
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      trader: createTraderDouble(),
      orderRecorder: createOrderRecorderDouble(),
      riskChecker: createRiskCheckerDouble({
        getWarrantDistanceInfo: () =>
          createWarrantDistanceInfoDouble({
            warrantType: 'BULL',
            distanceToStrikePercent: 0.1,
          }),
      }),
      now: () => new Date(nowMs),
      switchStates,
      periodicSwitchPending: createPeriodicSwitchPendingMap(),
      resolveSuppression: seatStateManager.resolveSuppression,
      markSuppression: seatStateManager.markSuppression,
      enterSwitchingSeat: seatStateManager.enterSwitchingSeat,
      updateSeatState: seatStateManager.updateSeatState,
      resolveDirectionalAutoSearchPolicy: () => createDirectionalAutoSearchPolicy('LONG'),
      buildFindBestWarrantInput: async () => createFindBestWarrantInputDouble(),
      findBestWarrant: async () => await pendingCandidate,
      resolveDirectionSymbols,
      calculateBuyQuantityByNotional,
      buildOrderSignal: signalBuilder.buildOrderSignal,
      pendingOrderStatuses: PENDING_ORDER_STATUSES,
      buySide: OrderSide.Buy,
      logger: createLoggerStub(),
      maxSearchFailuresPerDay: 3,
      getHKDateKey,
      calculateTradingDurationMsBetween,
      getTradingCalendarSnapshot: () => createTradingCalendarSnapshot(),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async (symbols) =>
          new Map(createQuotes(Object.fromEntries([...symbols].map((symbol) => [symbol, 1])))),
      }),
    });

    const switchPromise = runDistanceSwitch(machine, {
      direction: 'LONG',
      monitorPrice: 20_000,
      positions: [],
    });

    const latestSeat = symbolRegistry.getSeatState('LONG');
    symbolRegistry.updateSeatStateWithVersionBump('LONG', {
      symbol: 'MANUAL_BULL.HK',
      status: 'ACTIVE',
      lastSearchAt: latestSeat.lastSearchAt,
      lastSwitchAt: Date.now(),
      lastSeatActivatedAt: latestSeat.lastSeatActivatedAt ?? Date.now(),
      callPrice: latestSeat.callPrice ?? null,
      searchFailCountToday: latestSeat.searchFailCountToday,
      frozenTradingDayKey: latestSeat.frozenTradingDayKey,
    });
    resolveCandidate(createWarrantCandidate('NEW_BULL.HK'));
    await switchPromise;

    const seat = symbolRegistry.getSeatState('LONG');
    expect(seat.status).toBe('ACTIVE');
    expect(seat.symbol).toBe('MANUAL_BULL.HK');
    expect(machine.hasPendingSwitch('LONG')).toBeFalse();
  });

  it('switches to new symbol directly when no position exists', async () => {
    const monitorConfig = createMonitorConfigDouble({
      autoSearchConfig: getDefaultAutoSearchConfig(),
    });
    const symbolRegistry = createSymbolRegistryDouble({
      longSeat: {
        symbol: 'OLD_BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      longVersion: 1,
    });
    const switchStates = createSwitchStatesMap();
    const switchSuppressions = createSwitchSuppressionsMap();
    const nowMs = Date.parse('2026-02-16T01:00:00.000Z');
    const seatStateManager = createSeatStateManager({
      symbolRegistry,
      switchStates,
      switchSuppressions,
      now: () => new Date(nowMs),
      logger: createLoggerStub(),
      getHKDateKey,
    });
    const signalBuilder = createSignalBuilder();
    let executeCalls = 0;
    const trader = createTraderDouble({
      executeSignals: async () => {
        executeCalls += 1;
        return { executedOrderIds: ['EXECUTED-ORDER-1'] };
      },
      getPendingOrders: async () => [],
    });
    const machine = createSwitchStateMachine({
      autoSearchConfig: monitorConfig.autoSearchConfig,
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      trader,
      orderRecorder: createOrderRecorderDouble(),
      riskChecker: createRiskCheckerDouble({
        getWarrantDistanceInfo: () =>
          createWarrantDistanceInfoDouble({
            warrantType: 'BULL',
            distanceToStrikePercent: 0.1,
          }),
      }),
      now: () => new Date(nowMs),
      switchStates,
      periodicSwitchPending: createPeriodicSwitchPendingMap(),
      resolveSuppression: seatStateManager.resolveSuppression,
      markSuppression: seatStateManager.markSuppression,
      enterSwitchingSeat: seatStateManager.enterSwitchingSeat,
      updateSeatState: seatStateManager.updateSeatState,
      resolveDirectionalAutoSearchPolicy: () => createDirectionalAutoSearchPolicy('LONG'),
      buildFindBestWarrantInput: async () => createFindBestWarrantInputDouble(),
      findBestWarrant: async () => createWarrantCandidate('NEW_BULL.HK'),
      resolveDirectionSymbols,
      calculateBuyQuantityByNotional,
      buildOrderSignal: signalBuilder.buildOrderSignal,
      pendingOrderStatuses: PENDING_ORDER_STATUSES,
      buySide: OrderSide.Buy,
      logger: createLoggerStub(),
      maxSearchFailuresPerDay: 3,
      getHKDateKey,
      calculateTradingDurationMsBetween,
      getTradingCalendarSnapshot: () => createTradingCalendarSnapshot(),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async (symbols) =>
          new Map(createQuotes(Object.fromEntries([...symbols].map((symbol) => [symbol, 1])))),
      }),
    });
    await runDistanceSwitch(machine, {
      direction: 'LONG',
      monitorPrice: 20_000,
      positions: [],
    });
    const seat = symbolRegistry.getSeatState('LONG');
    expect(seat.status).toBe('ACTIVATING');
    expect(seat.symbol).toBe('NEW_BULL.HK');
    expect(seat.callPrice).toBe(21_000);
    expect(symbolRegistry.getSeatVersion('LONG')).toBe(2);
    expect(executeCalls).toBe(0);
    expect(machine.hasPendingSwitch('LONG')).toBeFalse();
  });

  it('returns explicit wakeup requirements across distance switch start and advance', async () => {
    const monitorConfig = createMonitorConfigDouble({
      targetNotional: 5_000,
      autoSearchConfig: getDefaultAutoSearchConfig(),
    });
    const symbolRegistry = createSymbolRegistryDouble({
      longSeat: {
        symbol: 'OLD_BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      longVersion: 1,
    });
    const switchStates = createSwitchStatesMap();
    const switchSuppressions = createSwitchSuppressionsMap();
    let nowMs = Date.parse('2026-02-16T01:00:00.000Z');
    const seatStateManager = createSeatStateManager({
      symbolRegistry,
      switchStates,
      switchSuppressions,
      now: () => new Date(nowMs),
      logger: createLoggerStub(),
      getHKDateKey,
    });
    const signalBuilder = createSignalBuilder();
    const executedActions: Array<{
      action: string | null;
      symbol: string | null;
      quantity: number | null;
    }> = [];
    const trader = createTraderDouble({
      executeSignals: async (signals) => {
        const signal = signals[0];
        executedActions.push({
          action: signal?.action ?? null,
          symbol: signal?.symbol ?? null,
          quantity: signal?.quantity ?? null,
        });

        if (signal?.action === 'SELLCALL') {
          return { executedOrderIds: ['SELL-ORDER-1'] };
        }

        return { executedOrderIds: ['BUY-ORDER-1'] };
      },
      getPendingOrders: async () => [],
    });
    const orderRecorder = createOrderRecorderDouble({
      getSellRecordByOrderId: (orderId) =>
        orderId === 'SELL-ORDER-1'
          ? {
              orderId: 'SELL-ORDER-1',
              symbol: 'OLD_BULL.HK',
              executedPrice: 2,
              executedQuantity: 100,
              executedTime: 9_999_999_999_999,
              submittedAt: undefined,
              updatedAt: undefined,
            }
          : null,
    });
    const machine = createSwitchStateMachine({
      autoSearchConfig: monitorConfig.autoSearchConfig,
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      trader,
      orderRecorder,
      riskChecker: createRiskCheckerDouble({
        getWarrantDistanceInfo: () =>
          createWarrantDistanceInfoDouble({
            warrantType: 'BULL',
            distanceToStrikePercent: 0.1,
          }),
      }),
      now: () => new Date(nowMs),
      switchStates,
      periodicSwitchPending: createPeriodicSwitchPendingMap(),
      resolveSuppression: seatStateManager.resolveSuppression,
      markSuppression: seatStateManager.markSuppression,
      enterSwitchingSeat: seatStateManager.enterSwitchingSeat,
      updateSeatState: seatStateManager.updateSeatState,
      resolveDirectionalAutoSearchPolicy: () => createDirectionalAutoSearchPolicy('LONG'),
      buildFindBestWarrantInput: async () => createFindBestWarrantInputDouble(),
      findBestWarrant: async () => createWarrantCandidate('NEW_BULL.HK'),
      resolveDirectionSymbols,
      calculateBuyQuantityByNotional,
      buildOrderSignal: signalBuilder.buildOrderSignal,
      pendingOrderStatuses: PENDING_ORDER_STATUSES,
      buySide: OrderSide.Buy,
      logger: createLoggerStub(),
      maxSearchFailuresPerDay: 3,
      getHKDateKey,
      calculateTradingDurationMsBetween,
      getTradingCalendarSnapshot: () => createTradingCalendarSnapshot(),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async (symbols) =>
          new Map(createQuotes(Object.fromEntries([...symbols].map((symbol) => [symbol, 1])))),
      }),
    });
    const startResult = await machine.startSwitchOnDistance({
      direction: 'LONG',
      monitorPrice: 20_000,
      positions: [
        {
          symbol: 'OLD_BULL.HK',
          quantity: 100,
          availableQuantity: 100,
          symbolName: 'OLD_BULL',
          accountChannel: 'lb_papertrading',
          currency: 'HKD',
          costPrice: 1,
        },
      ],
    });
    expect(startResult).toMatchObject({
      started: true,
      direction: 'LONG',
      driveResult: {
        kind: 'WAIT',
        wakeups: [{ kind: 'RETRY_TIMER', atMs: nowMs }],
      },
    });
    expect(machine.hasPendingSwitch('LONG')).toBeTrue();
    expect(executedActions).toHaveLength(0);

    const sellResult = await machine.advancePendingSwitch({
      direction: 'LONG',
      positions: [
        {
          symbol: 'OLD_BULL.HK',
          quantity: 100,
          availableQuantity: 100,
          symbolName: 'OLD_BULL',
          accountChannel: 'lb_papertrading',
          currency: 'HKD',
          costPrice: 1,
        },
      ],
    });
    expect(sellResult).toMatchObject({
      advanced: true,
      stillPending: true,
      driveResult: {
        kind: 'WAIT',
        wakeups: [{ kind: 'ORDER_EVENT', symbols: ['OLD_BULL.HK'] }, { kind: 'FRESHNESS' }],
      },
    });
    expect(executedActions).toHaveLength(1);
    expect(executedActions[0]).toEqual({
      action: 'SELLCALL',
      symbol: 'OLD_BULL.HK',
      quantity: 100,
    });
    nowMs += 1_000;
    const barrierResult = await machine.advancePendingSwitch({
      direction: 'LONG',
      positions: [],
    });
    expect(barrierResult).toMatchObject({
      advanced: true,
      direction: 'LONG',
      stillPending: true,
      driveResult: {
        kind: 'WAIT',
        wakeups: [{ kind: 'SYMBOL_QUOTE', symbol: 'NEW_BULL.HK' }],
      },
    });

    const advanceResult = await machine.advancePendingSwitch({
      direction: 'LONG',
      positions: [],
    });
    expect(advanceResult).toMatchObject({
      advanced: true,
      direction: 'LONG',
      stillPending: false,
      driveResult: {
        kind: 'COMPLETED',
      },
    });
    expect(executedActions).toHaveLength(2);
    expect(executedActions[1]?.action).toBe('BUYCALL');
    expect(executedActions[1]?.symbol).toBe('NEW_BULL.HK');
    expect(executedActions[1]?.quantity).toBe(200);
    const finalSeat = symbolRegistry.getSeatState('LONG');
    expect(finalSeat.status).toBe('ACTIVATING');
    expect(finalSeat.symbol).toBe('NEW_BULL.HK');
    expect(machine.hasPendingSwitch('LONG')).toBeFalse();
  });

  it('allows SELL_OUT with execution-time price-only quote even when lotSize is missing', async () => {
    const monitorConfig = createMonitorConfigDouble({
      autoSearchConfig: getDefaultAutoSearchConfig(),
    });
    const symbolRegistry = createSymbolRegistryDouble({
      longSeat: {
        symbol: 'OLD_BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      longVersion: 1,
    });
    const switchStates = createSwitchStatesMap();
    const switchSuppressions = createSwitchSuppressionsMap();
    const nowMs = Date.parse('2026-02-16T01:00:00.000Z');
    const seatStateManager = createSeatStateManager({
      symbolRegistry,
      switchStates,
      switchSuppressions,
      now: () => new Date(nowMs),
      logger: createLoggerStub(),
      getHKDateKey,
    });
    const signalBuilder = createSignalBuilder();
    const executedActions: string[] = [];
    const quoteRequests: string[][] = [];
    const trader = createTraderDouble({
      executeSignals: async (signals) => {
        const signal = signals[0];
        if (signal?.action) {
          executedActions.push(signal.action);
        }

        return { executedOrderIds: ['SELL-ORDER-1'] };
      },
      getPendingOrders: async () => [],
    });
    const orderRecorder = createOrderRecorderDouble({
      getSellRecordByOrderId: (orderId) =>
        orderId === 'SELL-ORDER-1'
          ? {
              orderId: 'SELL-ORDER-1',
              symbol: 'OLD_BULL.HK',
              executedPrice: 2,
              executedQuantity: 100,
              executedTime: 9_999_999_999_999,
              submittedAt: undefined,
              updatedAt: undefined,
            }
          : null,
    });
    const marketDataClient = createMarketDataClientDouble({
      getQuotes: async (symbols) => {
        const requestedSymbols = [...symbols];
        quoteRequests.push(requestedSymbols);
        return new Map([
          [
            'OLD_BULL.HK',
            {
              symbol: 'OLD_BULL.HK',
              name: 'OLD_BULL.HK',
              price: 1,
              prevClose: 1,
              timestamp: Date.now(),
            },
          ],
        ]);
      },
    });
    const machine = createSwitchStateMachine({
      autoSearchConfig: monitorConfig.autoSearchConfig,
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      trader,
      orderRecorder,
      riskChecker: createRiskCheckerDouble({
        getWarrantDistanceInfo: () =>
          createWarrantDistanceInfoDouble({
            warrantType: 'BULL',
            distanceToStrikePercent: 0.1,
          }),
      }),
      now: () => new Date(nowMs),
      switchStates,
      periodicSwitchPending: createPeriodicSwitchPendingMap(),
      resolveSuppression: seatStateManager.resolveSuppression,
      markSuppression: seatStateManager.markSuppression,
      enterSwitchingSeat: seatStateManager.enterSwitchingSeat,
      updateSeatState: seatStateManager.updateSeatState,
      resolveDirectionalAutoSearchPolicy: () => createDirectionalAutoSearchPolicy('LONG'),
      buildFindBestWarrantInput: async () => createFindBestWarrantInputDouble(),
      findBestWarrant: async () => createWarrantCandidate('NEW_BULL.HK'),
      resolveDirectionSymbols,
      calculateBuyQuantityByNotional,
      buildOrderSignal: signalBuilder.buildOrderSignal,
      pendingOrderStatuses: PENDING_ORDER_STATUSES,
      buySide: OrderSide.Buy,
      logger: createLoggerStub(),
      maxSearchFailuresPerDay: 3,
      getHKDateKey,
      calculateTradingDurationMsBetween,
      getTradingCalendarSnapshot: () => createTradingCalendarSnapshot(),
      marketDataClient,
    });

    await runDistanceSwitch(machine, {
      direction: 'LONG',
      monitorPrice: 20_000,
      positions: [
        {
          symbol: 'OLD_BULL.HK',
          quantity: 100,
          availableQuantity: 100,
          symbolName: 'OLD_BULL',
          accountChannel: 'lb_papertrading',
          currency: 'HKD',
          costPrice: 1,
        },
      ],
    });

    expect(quoteRequests).toEqual([['OLD_BULL.HK']]);
    expect(executedActions).toContain('SELLCALL');
  });

  it('fails switch flow after WAIT_QUOTE/REBUY execution-time quote retries exhaust without lotSize', async () => {
    const monitorConfig = createMonitorConfigDouble({
      targetNotional: 5_000,
      autoSearchConfig: getDefaultAutoSearchConfig(),
    });
    const symbolRegistry = createSymbolRegistryDouble({
      longSeat: {
        symbol: 'OLD_BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      longVersion: 1,
    });
    const switchStates = createSwitchStatesMap();
    const switchSuppressions = createSwitchSuppressionsMap();
    let nowMs = Date.parse('2026-02-16T01:00:00.000Z');
    const seatStateManager = createSeatStateManager({
      symbolRegistry,
      switchStates,
      switchSuppressions,
      now: () => new Date(nowMs),
      logger: createLoggerStub(),
      getHKDateKey,
    });
    const signalBuilder = createSignalBuilder();
    const quoteRequests: string[][] = [];
    const trader = createTraderDouble({
      executeSignals: async (signals) => {
        const signal = signals[0];
        if (signal?.action === 'SELLCALL') {
          return { executedOrderIds: ['SELL-ORDER-1'] };
        }

        return { executedOrderIds: [] };
      },
      getPendingOrders: async () => [],
    });
    const orderRecorder = createOrderRecorderDouble({
      getSellRecordByOrderId: (orderId) =>
        orderId === 'SELL-ORDER-1'
          ? {
              orderId: 'SELL-ORDER-1',
              symbol: 'OLD_BULL.HK',
              executedPrice: 2,
              executedQuantity: 100,
              executedTime: 9_999_999_999_999,
              submittedAt: undefined,
              updatedAt: undefined,
            }
          : null,
    });
    const marketDataClient = createMarketDataClientDouble({
      getQuotes: async (symbols) => {
        const requestedSymbols = [...symbols];
        quoteRequests.push(requestedSymbols);
        if (requestedSymbols[0] === 'OLD_BULL.HK') {
          return new Map([
            ['OLD_BULL.HK', createQuotes({ 'OLD_BULL.HK': 1 }).get('OLD_BULL.HK') ?? null],
          ]);
        }

        return new Map([
          [
            'NEW_BULL.HK',
            {
              symbol: 'NEW_BULL.HK',
              name: 'NEW_BULL.HK',
              price: 1,
              prevClose: 1,
              timestamp: Date.now(),
            },
          ],
        ]);
      },
    });
    const machine = createSwitchStateMachine({
      autoSearchConfig: monitorConfig.autoSearchConfig,
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      trader,
      orderRecorder,
      riskChecker: createRiskCheckerDouble({
        getWarrantDistanceInfo: () =>
          createWarrantDistanceInfoDouble({
            warrantType: 'BULL',
            distanceToStrikePercent: 0.1,
          }),
      }),
      now: () => new Date(nowMs),
      switchStates,
      periodicSwitchPending: createPeriodicSwitchPendingMap(),
      resolveSuppression: seatStateManager.resolveSuppression,
      markSuppression: seatStateManager.markSuppression,
      enterSwitchingSeat: seatStateManager.enterSwitchingSeat,
      updateSeatState: seatStateManager.updateSeatState,
      resolveDirectionalAutoSearchPolicy: () => createDirectionalAutoSearchPolicy('LONG'),
      buildFindBestWarrantInput: async () => createFindBestWarrantInputDouble(),
      findBestWarrant: async () => createWarrantCandidate('NEW_BULL.HK'),
      resolveDirectionSymbols,
      calculateBuyQuantityByNotional,
      buildOrderSignal: signalBuilder.buildOrderSignal,
      pendingOrderStatuses: PENDING_ORDER_STATUSES,
      buySide: OrderSide.Buy,
      logger: createLoggerStub(),
      maxSearchFailuresPerDay: 3,
      getHKDateKey,
      calculateTradingDurationMsBetween,
      getTradingCalendarSnapshot: () => createTradingCalendarSnapshot(),
      marketDataClient,
    });

    await runDistanceSwitch(machine, {
      direction: 'LONG',
      monitorPrice: 20_000,
      positions: [
        {
          symbol: 'OLD_BULL.HK',
          quantity: 100,
          availableQuantity: 100,
          symbolName: 'OLD_BULL',
          accountChannel: 'lb_papertrading',
          currency: 'HKD',
          costPrice: 1,
        },
      ],
    });

    for (let attempts = 0; attempts < 6; attempts += 1) {
      nowMs += 2_000;
      await runDistanceSwitch(machine, {
        direction: 'LONG',
        monitorPrice: 20_000,
        positions: [],
      });
    }

    expect(quoteRequests[0]).toEqual(['OLD_BULL.HK']);
    expect(quoteRequests.slice(1).every((symbols) => symbols[0] === 'NEW_BULL.HK')).toBeTrue();
    expect(machine.hasPendingSwitch('LONG')).toBeFalse();
    const finalSeat = symbolRegistry.getSeatState('LONG');
    expect(finalSeat.status).toBe('EMPTY');
  });

  it('marks seat EMPTY when canceling pending buy orders fails during switch', async () => {
    const monitorConfig = createMonitorConfigDouble({
      autoSearchConfig: getDefaultAutoSearchConfig(),
    });
    const symbolRegistry = createSymbolRegistryDouble({
      longSeat: {
        symbol: 'OLD_BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      longVersion: 1,
    });
    const switchStates = createSwitchStatesMap();
    const switchSuppressions = createSwitchSuppressionsMap();
    const nowMs = Date.parse('2026-02-16T01:00:00.000Z');
    const seatStateManager = createSeatStateManager({
      symbolRegistry,
      switchStates,
      switchSuppressions,
      now: () => new Date(nowMs),
      logger: createLoggerStub(),
      getHKDateKey,
    });
    const signalBuilder = createSignalBuilder();
    const pendingStatus = [...PENDING_ORDER_STATUSES][0];
    if (!pendingStatus) {
      throw new Error('PENDING_ORDER_STATUSES must contain at least one status');
    }

    let executeCalls = 0;
    const trader = createTraderDouble({
      getPendingOrders: async () => [
        {
          orderId: 'BUY-PENDING-1',
          symbol: 'OLD_BULL.HK',
          side: OrderSide.Buy,
          submittedPrice: 1,
          quantity: 100,
          executedQuantity: 0,
          status: pendingStatus,
          orderType: OrderType.ELO,
        },
      ],
      cancelOrder: async () => ({
        kind: 'UNKNOWN_FAILURE',
        errorCode: null,
        message: 'simulated cancel failure',
      }),
      executeSignals: async () => {
        executeCalls += 1;
        return { executedOrderIds: ['EXECUTED-ORDER-1'] };
      },
    });
    const machine = createSwitchStateMachine({
      autoSearchConfig: monitorConfig.autoSearchConfig,
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      trader,
      orderRecorder: createOrderRecorderDouble(),
      riskChecker: createRiskCheckerDouble({
        getWarrantDistanceInfo: () =>
          createWarrantDistanceInfoDouble({
            warrantType: 'BULL',
            distanceToStrikePercent: 0.1,
          }),
      }),
      now: () => new Date(nowMs),
      switchStates,
      periodicSwitchPending: createPeriodicSwitchPendingMap(),
      resolveSuppression: seatStateManager.resolveSuppression,
      markSuppression: seatStateManager.markSuppression,
      enterSwitchingSeat: seatStateManager.enterSwitchingSeat,
      updateSeatState: seatStateManager.updateSeatState,
      resolveDirectionalAutoSearchPolicy: () => createDirectionalAutoSearchPolicy('LONG'),
      buildFindBestWarrantInput: async () => createFindBestWarrantInputDouble(),
      findBestWarrant: async () => createWarrantCandidate('NEW_BULL.HK'),
      resolveDirectionSymbols,
      calculateBuyQuantityByNotional,
      buildOrderSignal: signalBuilder.buildOrderSignal,
      pendingOrderStatuses: PENDING_ORDER_STATUSES,
      buySide: OrderSide.Buy,
      logger: createLoggerStub(),
      maxSearchFailuresPerDay: 3,
      getHKDateKey,
      calculateTradingDurationMsBetween,
      getTradingCalendarSnapshot: () => createTradingCalendarSnapshot(),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async (symbols) =>
          new Map(createQuotes(Object.fromEntries([...symbols].map((symbol) => [symbol, 1])))),
      }),
    });
    await runDistanceSwitch(machine, {
      direction: 'LONG',
      monitorPrice: 20_000,
      positions: [],
    });
    const longSeat = symbolRegistry.getSeatState('LONG');
    expect(longSeat.status).toBe('EMPTY');
    expect(longSeat.symbol).toBeNull();
    expect(machine.hasPendingSwitch('LONG')).toBeFalse();
    expect(executeCalls).toBe(0);
  });

  it('waits for pending buy order to disappear after cancel request is accepted', async () => {
    const monitorConfig = createMonitorConfigDouble({
      autoSearchConfig: getDefaultAutoSearchConfig(),
    });
    const symbolRegistry = createSymbolRegistryDouble({
      longSeat: {
        symbol: 'OLD_BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      longVersion: 1,
    });
    const switchStates = createSwitchStatesMap();
    const switchSuppressions = createSwitchSuppressionsMap();
    const nowMs = Date.parse('2026-02-16T01:00:00.000Z');
    const seatStateManager = createSeatStateManager({
      symbolRegistry,
      switchStates,
      switchSuppressions,
      now: () => new Date(nowMs),
      logger: createLoggerStub(),
      getHKDateKey,
    });
    const signalBuilder = createSignalBuilder();
    const pendingStatus = [...PENDING_ORDER_STATUSES][0];
    if (!pendingStatus) {
      throw new Error('PENDING_ORDER_STATUSES must contain at least one status');
    }

    let pendingOrdersCall = 0;
    let executeCalls = 0;
    const trader = createTraderDouble({
      getPendingOrders: async () => {
        pendingOrdersCall += 1;
        if (pendingOrdersCall <= 2) {
          return [
            {
              orderId: 'BUY-PENDING-ACCEPTED',
              symbol: 'OLD_BULL.HK',
              side: OrderSide.Buy,
              submittedPrice: 1,
              quantity: 100,
              executedQuantity: 0,
              status: pendingStatus,
              orderType: OrderType.ELO,
            },
          ];
        }

        return [];
      },
      cancelOrder: async () => ({
        kind: 'CANCEL_CONFIRMED',
        closedReason: 'CANCELED',
        source: 'API',
        relatedBuyOrderIds: null,
      }),
      executeSignals: async () => {
        executeCalls += 1;
        return { executedOrderIds: ['EXECUTED-ORDER-1'] };
      },
    });
    const machine = createSwitchStateMachine({
      autoSearchConfig: monitorConfig.autoSearchConfig,
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      trader,
      orderRecorder: createOrderRecorderDouble(),
      riskChecker: createRiskCheckerDouble({
        getWarrantDistanceInfo: () =>
          createWarrantDistanceInfoDouble({
            warrantType: 'BULL',
            distanceToStrikePercent: 0.1,
          }),
      }),
      now: () => new Date(nowMs),
      switchStates,
      periodicSwitchPending: createPeriodicSwitchPendingMap(),
      resolveSuppression: seatStateManager.resolveSuppression,
      markSuppression: seatStateManager.markSuppression,
      enterSwitchingSeat: seatStateManager.enterSwitchingSeat,
      updateSeatState: seatStateManager.updateSeatState,
      resolveDirectionalAutoSearchPolicy: () => createDirectionalAutoSearchPolicy('LONG'),
      buildFindBestWarrantInput: async () => createFindBestWarrantInputDouble(),
      findBestWarrant: async () => createWarrantCandidate('NEW_BULL.HK'),
      resolveDirectionSymbols,
      calculateBuyQuantityByNotional,
      buildOrderSignal: signalBuilder.buildOrderSignal,
      pendingOrderStatuses: PENDING_ORDER_STATUSES,
      buySide: OrderSide.Buy,
      logger: createLoggerStub(),
      maxSearchFailuresPerDay: 3,
      getHKDateKey,
      calculateTradingDurationMsBetween,
      getTradingCalendarSnapshot: () => createTradingCalendarSnapshot(),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async (symbols) =>
          new Map(createQuotes(Object.fromEntries([...symbols].map((symbol) => [symbol, 1])))),
      }),
    });

    const startResult = await machine.startSwitchOnDistance({
      direction: 'LONG',
      monitorPrice: 20_000,
      positions: [],
    });

    expect(startResult).toMatchObject({
      started: true,
      direction: 'LONG',
      driveResult: {
        kind: 'WAIT',
        wakeups: [{ kind: 'RETRY_TIMER', atMs: nowMs }],
      },
    });
    expect(machine.hasPendingSwitch('LONG')).toBeTrue();
    expect(symbolRegistry.getSeatState('LONG').status).toBe('SWITCHING');
    expect(executeCalls).toBe(0);

    const cancelResult = await machine.advancePendingSwitch({
      direction: 'LONG',
      positions: [],
    });
    expect(cancelResult).toMatchObject({
      advanced: true,
      stillPending: true,
      driveResult: {
        kind: 'WAIT',
        wakeups: [{ kind: 'ORDER_EVENT', symbols: ['OLD_BULL.HK'] }, { kind: 'FRESHNESS' }],
      },
    });

    await runDistanceSwitch(machine, {
      direction: 'LONG',
      monitorPrice: 20_000,
      positions: [],
    });

    expect(machine.hasPendingSwitch('LONG')).toBeFalse();
    expect(symbolRegistry.getSeatState('LONG').status).toBe('ACTIVATING');
    expect(symbolRegistry.getSeatState('LONG').symbol).toBe('NEW_BULL.HK');
    expect(executeCalls).toBe(0);
  });

  it('keeps periodic switch pending when canceled buy order is already filled and exposure remains', async () => {
    const monitorConfig = createMonitorConfigDouble({
      autoSearchConfig: getDefaultAutoSearchConfig(),
    });
    const symbolRegistry = createSymbolRegistryDouble({
      longSeat: {
        symbol: 'OLD_BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: Date.parse('2026-02-16T01:00:00.000Z'),
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      longVersion: 1,
    });
    const switchStates = createSwitchStatesMap();
    const switchSuppressions = createSwitchSuppressionsMap();
    const nowMs = Date.parse('2026-02-16T01:31:00.000Z');
    const seatStateManager = createSeatStateManager({
      symbolRegistry,
      switchStates,
      switchSuppressions,
      now: () => new Date(nowMs),
      logger: createLoggerStub(),
      getHKDateKey,
    });
    const signalBuilder = createSignalBuilder();
    const pendingStatus = [...PENDING_ORDER_STATUSES][0];
    if (!pendingStatus) {
      throw new Error('PENDING_ORDER_STATUSES must contain at least one status');
    }

    let pendingOrdersCall = 0;
    const trader = createTraderDouble({
      getPendingOrders: async () => {
        pendingOrdersCall += 1;
        if (pendingOrdersCall <= 2) {
          return [
            {
              orderId: 'BUY-PENDING-FILLED',
              symbol: 'OLD_BULL.HK',
              side: OrderSide.Buy,
              submittedPrice: 1,
              quantity: 100,
              executedQuantity: 0,
              status: pendingStatus,
              orderType: OrderType.ELO,
            },
          ];
        }

        return [];
      },
      cancelOrder: async () => ({
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
    const machine = createSwitchStateMachine({
      autoSearchConfig: monitorConfig.autoSearchConfig,
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      trader,
      orderRecorder: createOrderRecorderDouble({
        getBuyOrdersForSymbol: () => [
          {
            orderId: 'BUY-PENDING-FILLED',
            symbol: 'OLD_BULL.HK',
            executedPrice: 1,
            executedQuantity: 100,
            executedTime: nowMs,
            submittedAt: undefined,
            updatedAt: undefined,
          },
        ],
      }),
      riskChecker: createRiskCheckerDouble({
        getWarrantDistanceInfo: () =>
          createWarrantDistanceInfoDouble({
            warrantType: 'BULL',
            distanceToStrikePercent: 0.1,
          }),
      }),
      now: () => new Date(nowMs),
      switchStates,
      periodicSwitchPending: createPeriodicSwitchPendingMap(),
      resolveSuppression: seatStateManager.resolveSuppression,
      markSuppression: seatStateManager.markSuppression,
      enterSwitchingSeat: seatStateManager.enterSwitchingSeat,
      updateSeatState: seatStateManager.updateSeatState,
      resolveDirectionalAutoSearchPolicy: () => createDirectionalAutoSearchPolicy('LONG'),
      buildFindBestWarrantInput: async () => createFindBestWarrantInputDouble(),
      findBestWarrant: async () => createWarrantCandidate('NEW_BULL.HK'),
      resolveDirectionSymbols,
      calculateBuyQuantityByNotional,
      buildOrderSignal: signalBuilder.buildOrderSignal,
      pendingOrderStatuses: PENDING_ORDER_STATUSES,
      buySide: OrderSide.Buy,
      logger: createLoggerStub(),
      maxSearchFailuresPerDay: 3,
      getHKDateKey,
      calculateTradingDurationMsBetween,
      getTradingCalendarSnapshot: () => createTradingCalendarSnapshot(),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async (symbols) =>
          new Map(createQuotes(Object.fromEntries([...symbols].map((symbol) => [symbol, 1])))),
      }),
    });

    await machine.evaluatePeriodicSwitchDue({
      direction: 'LONG',
      currentTime: new Date(nowMs),
      canContinue: () => true,
    });

    expect(machine.hasPendingSwitch('LONG')).toBeFalse();

    await runDistanceSwitch(machine, {
      direction: 'LONG',
      monitorPrice: 20_000,
      positions: [],
    });

    const seat = symbolRegistry.getSeatState('LONG');
    expect(seat.status).toBe('SWITCHING');
    expect(seat.symbol).toBe('OLD_BULL.HK');
    expect(machine.hasPendingSwitch('LONG')).toBeTrue();
  });

  it('completes distance switch when filled cancel has no open exposure snapshot yet', async () => {
    const monitorConfig = createMonitorConfigDouble({
      autoSearchConfig: getDefaultAutoSearchConfig(),
    });
    const symbolRegistry = createSymbolRegistryDouble({
      longSeat: {
        symbol: 'OLD_BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      longVersion: 1,
    });
    const switchStates = createSwitchStatesMap();
    const switchSuppressions = createSwitchSuppressionsMap();
    const nowMs = Date.parse('2026-02-16T01:40:00.000Z');
    const seatStateManager = createSeatStateManager({
      symbolRegistry,
      switchStates,
      switchSuppressions,
      now: () => new Date(nowMs),
      logger: createLoggerStub(),
      getHKDateKey,
    });
    const signalBuilder = createSignalBuilder();
    const pendingStatus = [...PENDING_ORDER_STATUSES][0];
    if (!pendingStatus) {
      throw new Error('PENDING_ORDER_STATUSES must contain at least one status');
    }

    let pendingOrdersCall = 0;
    let executeCalls = 0;
    const trader = createTraderDouble({
      getPendingOrders: async () => {
        pendingOrdersCall += 1;
        if (pendingOrdersCall <= 2) {
          return [
            {
              orderId: 'BUY-PENDING-FILLED-NO-EXPOSURE',
              symbol: 'OLD_BULL.HK',
              side: OrderSide.Buy,
              submittedPrice: 1,
              quantity: 100,
              executedQuantity: 0,
              status: pendingStatus,
              orderType: OrderType.ELO,
            },
          ];
        }

        return [];
      },
      cancelOrder: async () => ({
        kind: 'ALREADY_CLOSED',
        closedReason: 'FILLED',
        source: 'API_ERROR',
        relatedBuyOrderIds: null,
        terminalExecution: {
          submittedQuantity: 100,
          executedQuantity: 100,
        },
      }),
      executeSignals: async () => {
        executeCalls += 1;
        return { executedOrderIds: ['EXECUTED-ORDER-1'] };
      },
    });
    const machine = createSwitchStateMachine({
      autoSearchConfig: monitorConfig.autoSearchConfig,
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      trader,
      orderRecorder: createOrderRecorderDouble(),
      riskChecker: createRiskCheckerDouble({
        getWarrantDistanceInfo: () =>
          createWarrantDistanceInfoDouble({
            warrantType: 'BULL',
            distanceToStrikePercent: 0.1,
          }),
      }),
      now: () => new Date(nowMs),
      switchStates,
      periodicSwitchPending: createPeriodicSwitchPendingMap(),
      resolveSuppression: seatStateManager.resolveSuppression,
      markSuppression: seatStateManager.markSuppression,
      enterSwitchingSeat: seatStateManager.enterSwitchingSeat,
      updateSeatState: seatStateManager.updateSeatState,
      resolveDirectionalAutoSearchPolicy: () => createDirectionalAutoSearchPolicy('LONG'),
      buildFindBestWarrantInput: async () => createFindBestWarrantInputDouble(),
      findBestWarrant: async () => createWarrantCandidate('NEW_BULL.HK'),
      resolveDirectionSymbols,
      calculateBuyQuantityByNotional,
      buildOrderSignal: signalBuilder.buildOrderSignal,
      pendingOrderStatuses: PENDING_ORDER_STATUSES,
      buySide: OrderSide.Buy,
      logger: createLoggerStub(),
      maxSearchFailuresPerDay: 3,
      getHKDateKey,
      calculateTradingDurationMsBetween,
      getTradingCalendarSnapshot: () => createTradingCalendarSnapshot(),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async (symbols) =>
          new Map(createQuotes(Object.fromEntries([...symbols].map((symbol) => [symbol, 1])))),
      }),
    });

    await runDistanceSwitch(machine, {
      direction: 'LONG',
      monitorPrice: 20_000,
      positions: [],
    });
    expect(machine.hasPendingSwitch('LONG')).toBeTrue();
    expect(symbolRegistry.getSeatState('LONG').status).toBe('SWITCHING');

    await runDistanceSwitch(machine, {
      direction: 'LONG',
      monitorPrice: 20_000,
      positions: [],
    });

    expect(machine.hasPendingSwitch('LONG')).toBeFalse();
    expect(symbolRegistry.getSeatState('LONG').status).toBe('ACTIVATING');
    expect(symbolRegistry.getSeatState('LONG').symbol).toBe('NEW_BULL.HK');
    expect(executeCalls).toBe(0);
  });

  it('promotes unexpected filled pending buy into distance sell-and-rebuy flow', async () => {
    const monitorConfig = createMonitorConfigDouble({
      targetNotional: 5_000,
      autoSearchConfig: getDefaultAutoSearchConfig(),
    });
    const symbolRegistry = createSymbolRegistryDouble({
      longSeat: {
        symbol: 'OLD_BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      longVersion: 1,
    });
    const switchStates = createSwitchStatesMap();
    const switchSuppressions = createSwitchSuppressionsMap();
    let nowMs = Date.parse('2026-02-16T01:00:00.000Z');
    const seatStateManager = createSeatStateManager({
      symbolRegistry,
      switchStates,
      switchSuppressions,
      now: () => new Date(nowMs),
      logger: createLoggerStub(),
      getHKDateKey,
    });
    const signalBuilder = createSignalBuilder();
    const pendingStatus = [...PENDING_ORDER_STATUSES][0];
    if (!pendingStatus) {
      throw new Error('PENDING_ORDER_STATUSES must contain at least one status');
    }

    let pendingOrdersCall = 0;
    const executedActions: Array<string | null> = [];
    const trader = createTraderDouble({
      getPendingOrders: async () => {
        pendingOrdersCall += 1;
        if (pendingOrdersCall <= 2) {
          return [
            {
              orderId: 'BUY-PENDING-FILLED-DISTANCE',
              symbol: 'OLD_BULL.HK',
              side: OrderSide.Buy,
              submittedPrice: 1,
              quantity: 100,
              executedQuantity: 0,
              status: pendingStatus,
              orderType: OrderType.ELO,
            },
          ];
        }

        return [];
      },
      cancelOrder: async () => ({
        kind: 'ALREADY_CLOSED',
        closedReason: 'FILLED',
        source: 'API_ERROR',
        relatedBuyOrderIds: null,
        terminalExecution: {
          submittedQuantity: 100,
          executedQuantity: 100,
        },
      }),
      executeSignals: async (signals) => {
        executedActions.push(signals[0]?.action ?? null);
        if (signals[0]?.action === 'SELLCALL') {
          return { executedOrderIds: ['SELL-ORDER-FILLED-PENDING'] };
        }

        return { executedOrderIds: ['BUY-ORDER-FILLED-PENDING'] };
      },
    });
    const orderRecorder = createOrderRecorderDouble({
      getSellRecordByOrderId: (orderId) =>
        orderId === 'SELL-ORDER-FILLED-PENDING'
          ? {
              orderId: 'SELL-ORDER-FILLED-PENDING',
              symbol: 'OLD_BULL.HK',
              executedPrice: 2,
              executedQuantity: 100,
              executedTime: nowMs,
              submittedAt: undefined,
              updatedAt: undefined,
            }
          : null,
    });
    const machine = createSwitchStateMachine({
      autoSearchConfig: monitorConfig.autoSearchConfig,
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      trader,
      orderRecorder,
      riskChecker: createRiskCheckerDouble({
        getWarrantDistanceInfo: () =>
          createWarrantDistanceInfoDouble({
            warrantType: 'BULL',
            distanceToStrikePercent: 0.1,
          }),
      }),
      now: () => new Date(nowMs),
      switchStates,
      periodicSwitchPending: createPeriodicSwitchPendingMap(),
      resolveSuppression: seatStateManager.resolveSuppression,
      markSuppression: seatStateManager.markSuppression,
      enterSwitchingSeat: seatStateManager.enterSwitchingSeat,
      updateSeatState: seatStateManager.updateSeatState,
      resolveDirectionalAutoSearchPolicy: () => createDirectionalAutoSearchPolicy('LONG'),
      buildFindBestWarrantInput: async () => createFindBestWarrantInputDouble(),
      findBestWarrant: async () => createWarrantCandidate('NEW_BULL.HK'),
      resolveDirectionSymbols,
      calculateBuyQuantityByNotional,
      buildOrderSignal: signalBuilder.buildOrderSignal,
      pendingOrderStatuses: PENDING_ORDER_STATUSES,
      buySide: OrderSide.Buy,
      logger: createLoggerStub(),
      maxSearchFailuresPerDay: 3,
      getHKDateKey,
      calculateTradingDurationMsBetween,
      getTradingCalendarSnapshot: () => createTradingCalendarSnapshot(),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async (symbols) =>
          new Map(createQuotes(Object.fromEntries([...symbols].map((symbol) => [symbol, 1])))),
      }),
    });

    await runDistanceSwitch(machine, {
      direction: 'LONG',
      monitorPrice: 20_000,
      positions: [],
    });
    expect(executedActions).toHaveLength(0);

    nowMs += 1_000;
    await runDistanceSwitch(machine, {
      direction: 'LONG',
      monitorPrice: 20_000,
      positions: [
        {
          symbol: 'OLD_BULL.HK',
          quantity: 100,
          availableQuantity: 100,
          symbolName: 'OLD_BULL',
          accountChannel: 'lb_papertrading',
          currency: 'HKD',
          costPrice: 1,
        },
      ],
    });
    expect(executedActions).toEqual(['SELLCALL']);

    nowMs += 1_000;
    await runDistanceSwitch(machine, {
      direction: 'LONG',
      monitorPrice: 20_000,
      positions: [],
    });
    expect(executedActions).toEqual(['SELLCALL']);

    await runDistanceSwitch(machine, {
      direction: 'LONG',
      monitorPrice: 20_000,
      positions: [],
    });
    expect(executedActions).toEqual(['SELLCALL', 'BUYCALL']);
    expect(symbolRegistry.getSeatState('LONG').status).toBe('ACTIVATING');
    expect(symbolRegistry.getSeatState('LONG').symbol).toBe('NEW_BULL.HK');
  });

  it('stops pending distance switch when seat version changes during SELL_OUT quote fetch', async () => {
    const monitorConfig = createMonitorConfigDouble({
      autoSearchConfig: getDefaultAutoSearchConfig(),
    });
    const symbolRegistry = createSymbolRegistryDouble({
      longSeat: {
        symbol: 'OLD_BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      longVersion: 1,
    });
    const switchStates = createSwitchStatesMap();
    const switchSuppressions = createSwitchSuppressionsMap();
    const nowMs = Date.parse('2026-02-16T01:00:00.000Z');
    const seatStateManager = createSeatStateManager({
      symbolRegistry,
      switchStates,
      switchSuppressions,
      now: () => new Date(nowMs),
      logger: createLoggerStub(),
      getHKDateKey,
    });
    const signalBuilder = createSignalBuilder();
    let executeCalls = 0;
    const trader = createTraderDouble({
      getPendingOrders: async () => [],
      executeSignals: async () => {
        executeCalls += 1;
        return { executedOrderIds: ['SELL-ORDER-SHOULD-NOT-HAPPEN'] };
      },
    });
    const marketDataClient = createMarketDataClientDouble({
      getQuotes: async (symbols) => {
        const currentSeat = symbolRegistry.getSeatState('LONG');
        symbolRegistry.updateSeatStateWithVersionBump('LONG', {
          symbol: 'MANUAL_BULL.HK',
          status: 'ACTIVE',
          lastSearchAt: currentSeat.lastSearchAt,
          lastSwitchAt: nowMs + 1_000,
          lastSeatActivatedAt: currentSeat.lastSeatActivatedAt ?? nowMs + 1_000,
          callPrice: currentSeat.callPrice ?? null,
          searchFailCountToday: currentSeat.searchFailCountToday,
          frozenTradingDayKey: currentSeat.frozenTradingDayKey,
        });

        return new Map(createQuotes(Object.fromEntries([...symbols].map((symbol) => [symbol, 1]))));
      },
    });
    const machine = createSwitchStateMachine({
      autoSearchConfig: monitorConfig.autoSearchConfig,
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      trader,
      orderRecorder: createOrderRecorderDouble(),
      riskChecker: createRiskCheckerDouble({
        getWarrantDistanceInfo: () =>
          createWarrantDistanceInfoDouble({
            warrantType: 'BULL',
            distanceToStrikePercent: 0.1,
          }),
      }),
      now: () => new Date(nowMs),
      switchStates,
      periodicSwitchPending: createPeriodicSwitchPendingMap(),
      resolveSuppression: seatStateManager.resolveSuppression,
      markSuppression: seatStateManager.markSuppression,
      enterSwitchingSeat: seatStateManager.enterSwitchingSeat,
      updateSeatState: seatStateManager.updateSeatState,
      resolveDirectionalAutoSearchPolicy: () => createDirectionalAutoSearchPolicy('LONG'),
      buildFindBestWarrantInput: async () => createFindBestWarrantInputDouble(),
      findBestWarrant: async () => createWarrantCandidate('NEW_BULL.HK'),
      resolveDirectionSymbols,
      calculateBuyQuantityByNotional,
      buildOrderSignal: signalBuilder.buildOrderSignal,
      pendingOrderStatuses: PENDING_ORDER_STATUSES,
      buySide: OrderSide.Buy,
      logger: createLoggerStub(),
      maxSearchFailuresPerDay: 3,
      getHKDateKey,
      calculateTradingDurationMsBetween,
      getTradingCalendarSnapshot: () => createTradingCalendarSnapshot(),
      marketDataClient,
    });

    const startResult = await machine.startSwitchOnDistance({
      direction: 'LONG',
      monitorPrice: 20_000,
      positions: [
        {
          symbol: 'OLD_BULL.HK',
          quantity: 100,
          availableQuantity: 100,
          symbolName: 'OLD_BULL',
          accountChannel: 'lb_papertrading',
          currency: 'HKD',
          costPrice: 1,
        },
      ],
    });

    expect(startResult.started).toBeTrue();
    const advanceResult = await machine.advancePendingSwitch({
      direction: 'LONG',
      positions: [
        {
          symbol: 'OLD_BULL.HK',
          quantity: 100,
          availableQuantity: 100,
          symbolName: 'OLD_BULL',
          accountChannel: 'lb_papertrading',
          currency: 'HKD',
          costPrice: 1,
        },
      ],
    });
    expect(advanceResult).toMatchObject({
      advanced: true,
      stillPending: false,
      driveResult: { kind: 'NOOP' },
    });
    expect(executeCalls).toBe(0);
    expect(machine.hasPendingSwitch('LONG')).toBeFalse();
    const seat = symbolRegistry.getSeatState('LONG');
    expect(seat.status).toBe('ACTIVE');
    expect(seat.symbol).toBe('MANUAL_BULL.HK');
  });

  it('stops pending distance switch when seat version changes during pending order fetch', async () => {
    const monitorConfig = createMonitorConfigDouble({
      autoSearchConfig: getDefaultAutoSearchConfig(),
    });
    const symbolRegistry = createSymbolRegistryDouble({
      longSeat: {
        symbol: 'OLD_BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      longVersion: 1,
    });
    const switchStates = createSwitchStatesMap();
    const switchSuppressions = createSwitchSuppressionsMap();
    const nowMs = Date.parse('2026-02-16T01:00:00.000Z');
    const seatStateManager = createSeatStateManager({
      symbolRegistry,
      switchStates,
      switchSuppressions,
      now: () => new Date(nowMs),
      logger: createLoggerStub(),
      getHKDateKey,
    });
    const signalBuilder = createSignalBuilder();
    let pendingOrderFetchCount = 0;
    let executeCalls = 0;
    const trader = createTraderDouble({
      getPendingOrders: async () => {
        pendingOrderFetchCount += 1;
        if (pendingOrderFetchCount === 1) {
          return [];
        }

        const currentSeat = symbolRegistry.getSeatState('LONG');
        symbolRegistry.updateSeatStateWithVersionBump('LONG', {
          symbol: 'MANUAL_BULL.HK',
          status: 'ACTIVE',
          lastSearchAt: currentSeat.lastSearchAt,
          lastSwitchAt: nowMs + 1_000,
          lastSeatActivatedAt: currentSeat.lastSeatActivatedAt ?? nowMs + 1_000,
          callPrice: currentSeat.callPrice ?? null,
          searchFailCountToday: currentSeat.searchFailCountToday,
          frozenTradingDayKey: currentSeat.frozenTradingDayKey,
        });

        return [];
      },
      executeSignals: async () => {
        executeCalls += 1;
        return { executedOrderIds: ['SELL-ORDER-SHOULD-NOT-HAPPEN'] };
      },
    });
    const machine = createSwitchStateMachine({
      autoSearchConfig: monitorConfig.autoSearchConfig,
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      trader,
      orderRecorder: createOrderRecorderDouble(),
      riskChecker: createRiskCheckerDouble({
        getWarrantDistanceInfo: () =>
          createWarrantDistanceInfoDouble({
            warrantType: 'BULL',
            distanceToStrikePercent: 0.1,
          }),
      }),
      now: () => new Date(nowMs),
      switchStates,
      periodicSwitchPending: createPeriodicSwitchPendingMap(),
      resolveSuppression: seatStateManager.resolveSuppression,
      markSuppression: seatStateManager.markSuppression,
      enterSwitchingSeat: seatStateManager.enterSwitchingSeat,
      updateSeatState: seatStateManager.updateSeatState,
      resolveDirectionalAutoSearchPolicy: () => createDirectionalAutoSearchPolicy('LONG'),
      buildFindBestWarrantInput: async () => createFindBestWarrantInputDouble(),
      findBestWarrant: async () => createWarrantCandidate('NEW_BULL.HK'),
      resolveDirectionSymbols,
      calculateBuyQuantityByNotional,
      buildOrderSignal: signalBuilder.buildOrderSignal,
      pendingOrderStatuses: PENDING_ORDER_STATUSES,
      buySide: OrderSide.Buy,
      logger: createLoggerStub(),
      maxSearchFailuresPerDay: 3,
      getHKDateKey,
      calculateTradingDurationMsBetween,
      getTradingCalendarSnapshot: () => createTradingCalendarSnapshot(),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async (symbols) =>
          new Map(createQuotes(Object.fromEntries([...symbols].map((symbol) => [symbol, 1])))),
      }),
    });

    const startResult = await machine.startSwitchOnDistance({
      direction: 'LONG',
      monitorPrice: 20_000,
      positions: [
        {
          symbol: 'OLD_BULL.HK',
          quantity: 100,
          availableQuantity: 0,
          symbolName: 'OLD_BULL',
          accountChannel: 'lb_papertrading',
          currency: 'HKD',
          costPrice: 1,
        },
      ],
    });
    expect(startResult).toMatchObject({
      started: true,
      direction: 'LONG',
      driveResult: {
        kind: 'WAIT',
        wakeups: [{ kind: 'RETRY_TIMER', atMs: nowMs }],
      },
    });
    expect(machine.hasPendingSwitch('LONG')).toBeTrue();

    const advanceResult = await machine.advancePendingSwitch({
      direction: 'LONG',
      positions: [],
    });

    expect(advanceResult).toMatchObject({
      advanced: true,
      direction: 'LONG',
      stillPending: false,
      driveResult: {
        kind: 'NOOP',
      },
    });
    expect(executeCalls).toBe(0);
    const seat = symbolRegistry.getSeatState('LONG');
    expect(seat.status).toBe('ACTIVE');
    expect(seat.symbol).toBe('MANUAL_BULL.HK');
  });

  it('does not read next-symbol quote in the same advance that binds the new seat symbol', async () => {
    const monitorConfig = createMonitorConfigDouble({
      targetNotional: 5_000,
      autoSearchConfig: getDefaultAutoSearchConfig(),
    });
    const symbolRegistry = createSymbolRegistryDouble({
      longSeat: {
        symbol: 'OLD_BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      longVersion: 1,
    });
    const switchStates = createSwitchStatesMap();
    const switchSuppressions = createSwitchSuppressionsMap();
    let nowMs = Date.parse('2026-02-16T01:00:00.000Z');
    const seatStateManager = createSeatStateManager({
      symbolRegistry,
      switchStates,
      switchSuppressions,
      now: () => new Date(nowMs),
      logger: createLoggerStub(),
      getHKDateKey,
    });
    const signalBuilder = createSignalBuilder();
    const trader = createTraderDouble({
      executeSignals: async (signals) => {
        const action = signals[0]?.action ?? null;
        if (action === 'SELLCALL') {
          return { executedOrderIds: ['SELL-ORDER-BARRIER'] };
        }

        return { executedOrderIds: [] };
      },
      getPendingOrders: async () => [],
    });
    const orderRecorder = createOrderRecorderDouble({
      getSellRecordByOrderId: (orderId) =>
        orderId === 'SELL-ORDER-BARRIER'
          ? {
              orderId: 'SELL-ORDER-BARRIER',
              symbol: 'OLD_BULL.HK',
              executedPrice: 2,
              executedQuantity: 100,
              executedTime: 9_999_999_999_999,
              submittedAt: undefined,
              updatedAt: undefined,
            }
          : null,
    });
    const quoteRequests: string[][] = [];
    const marketDataClient = createMarketDataClientDouble({
      getQuotes: async (symbols) => {
        const requestedSymbols = [...symbols];
        quoteRequests.push(requestedSymbols);
        if (requestedSymbols[0] === 'OLD_BULL.HK') {
          return new Map(createQuotes({ 'OLD_BULL.HK': 1 }));
        }

        throw new Error(`未订阅: ${requestedSymbols[0] ?? 'UNKNOWN'}`);
      },
    });
    const machine = createSwitchStateMachine({
      autoSearchConfig: monitorConfig.autoSearchConfig,
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      trader,
      orderRecorder,
      riskChecker: createRiskCheckerDouble({
        getWarrantDistanceInfo: () =>
          createWarrantDistanceInfoDouble({
            warrantType: 'BULL',
            distanceToStrikePercent: 0.1,
          }),
      }),
      now: () => new Date(nowMs),
      switchStates,
      periodicSwitchPending: createPeriodicSwitchPendingMap(),
      resolveSuppression: seatStateManager.resolveSuppression,
      markSuppression: seatStateManager.markSuppression,
      enterSwitchingSeat: seatStateManager.enterSwitchingSeat,
      updateSeatState: seatStateManager.updateSeatState,
      resolveDirectionalAutoSearchPolicy: () => createDirectionalAutoSearchPolicy('LONG'),
      buildFindBestWarrantInput: async () => createFindBestWarrantInputDouble(),
      findBestWarrant: async () => createWarrantCandidate('NEW_BULL.HK'),
      resolveDirectionSymbols,
      calculateBuyQuantityByNotional,
      buildOrderSignal: signalBuilder.buildOrderSignal,
      pendingOrderStatuses: PENDING_ORDER_STATUSES,
      buySide: OrderSide.Buy,
      logger: createLoggerStub(),
      maxSearchFailuresPerDay: 3,
      getHKDateKey,
      calculateTradingDurationMsBetween,
      getTradingCalendarSnapshot: () => createTradingCalendarSnapshot(),
      marketDataClient,
    });

    await runDistanceSwitch(machine, {
      direction: 'LONG',
      monitorPrice: 20_000,
      positions: [
        {
          symbol: 'OLD_BULL.HK',
          quantity: 100,
          availableQuantity: 100,
          symbolName: 'OLD_BULL',
          accountChannel: 'lb_papertrading',
          currency: 'HKD',
          costPrice: 1,
        },
      ],
    });

    nowMs += 1_000;
    const advanceResult = await machine.advancePendingSwitch({
      direction: 'LONG',
      positions: [],
    });

    expect(quoteRequests).toEqual([['OLD_BULL.HK']]);
    expect(advanceResult).toMatchObject({
      advanced: true,
      direction: 'LONG',
      stillPending: true,
      driveResult: {
        kind: 'WAIT',
        wakeups: [{ kind: 'SYMBOL_QUOTE', symbol: 'NEW_BULL.HK' }],
      },
    });
    expect(symbolRegistry.getSeatState('LONG').symbol).toBe('NEW_BULL.HK');
    expect(machine.hasPendingSwitch('LONG')).toBeTrue();
  });

  it('returns quote wakeup requirement when rebuy quote is not ready', async () => {
    const monitorConfig = createMonitorConfigDouble({
      targetNotional: 5_000,
      autoSearchConfig: getDefaultAutoSearchConfig(),
    });
    const symbolRegistry = createSymbolRegistryDouble({
      longSeat: {
        symbol: 'OLD_BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      longVersion: 1,
    });
    const switchStates = createSwitchStatesMap();
    const switchSuppressions = createSwitchSuppressionsMap();
    let nowMs = Date.parse('2026-02-16T01:00:00.000Z');
    const seatStateManager = createSeatStateManager({
      symbolRegistry,
      switchStates,
      switchSuppressions,
      now: () => new Date(nowMs),
      logger: createLoggerStub(),
      getHKDateKey,
    });
    const signalBuilder = createSignalBuilder();
    const executedActions: string[] = [];
    const trader = createTraderDouble({
      executeSignals: async (signals) => {
        executedActions.push(signals[0]?.action ?? 'UNKNOWN');
        return { executedOrderIds: ['SELL-ORDER-1'] };
      },
      getPendingOrders: async () => [],
    });
    const orderRecorder = createOrderRecorderDouble({
      getSellRecordByOrderId: (orderId) =>
        orderId === 'SELL-ORDER-1'
          ? {
              orderId: 'SELL-ORDER-1',
              symbol: 'OLD_BULL.HK',
              executedPrice: 2,
              executedQuantity: 100,
              executedTime: 9_999_999_999_999,
              submittedAt: undefined,
              updatedAt: undefined,
            }
          : null,
    });
    const machine = createSwitchStateMachine({
      autoSearchConfig: monitorConfig.autoSearchConfig,
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      trader,
      orderRecorder,
      riskChecker: createRiskCheckerDouble({
        getWarrantDistanceInfo: () =>
          createWarrantDistanceInfoDouble({
            warrantType: 'BULL',
            distanceToStrikePercent: 0.1,
          }),
      }),
      now: () => new Date(nowMs),
      switchStates,
      periodicSwitchPending: createPeriodicSwitchPendingMap(),
      resolveSuppression: seatStateManager.resolveSuppression,
      markSuppression: seatStateManager.markSuppression,
      enterSwitchingSeat: seatStateManager.enterSwitchingSeat,
      updateSeatState: seatStateManager.updateSeatState,
      resolveDirectionalAutoSearchPolicy: () => createDirectionalAutoSearchPolicy('LONG'),
      buildFindBestWarrantInput: async () => createFindBestWarrantInputDouble(),
      findBestWarrant: async () => createWarrantCandidate('NEW_BULL.HK'),
      resolveDirectionSymbols,
      calculateBuyQuantityByNotional,
      buildOrderSignal: signalBuilder.buildOrderSignal,
      pendingOrderStatuses: PENDING_ORDER_STATUSES,
      buySide: OrderSide.Buy,
      logger: createLoggerStub(),
      maxSearchFailuresPerDay: 3,
      getHKDateKey,
      calculateTradingDurationMsBetween,
      getTradingCalendarSnapshot: () => createTradingCalendarSnapshot(),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async (symbols) => {
          const requestedSymbols = [...symbols];
          if (requestedSymbols[0] === 'OLD_BULL.HK') {
            return new Map(createQuotes({ 'OLD_BULL.HK': 1 }));
          }

          return new Map([['NEW_BULL.HK', null]]);
        },
      }),
    });
    const startResult = await machine.startSwitchOnDistance({
      direction: 'LONG',
      monitorPrice: 20_000,
      positions: [
        {
          symbol: 'OLD_BULL.HK',
          quantity: 100,
          availableQuantity: 100,
          symbolName: 'OLD_BULL',
          accountChannel: 'lb_papertrading',
          currency: 'HKD',
          costPrice: 1,
        },
      ],
    });
    expect(startResult.started).toBeTrue();
    await machine.advancePendingSwitch({
      direction: 'LONG',
      positions: [
        {
          symbol: 'OLD_BULL.HK',
          quantity: 100,
          availableQuantity: 100,
          symbolName: 'OLD_BULL',
          accountChannel: 'lb_papertrading',
          currency: 'HKD',
          costPrice: 1,
        },
      ],
    });
    expect(executedActions).toEqual(['SELLCALL']);
    expect(machine.hasPendingSwitch('LONG')).toBeTrue();
    nowMs += 1_000;
    const barrierResult = await machine.advancePendingSwitch({
      direction: 'LONG',
      positions: [],
    });
    expect(barrierResult).toMatchObject({
      advanced: true,
      direction: 'LONG',
      stillPending: true,
      driveResult: {
        kind: 'WAIT',
        wakeups: [{ kind: 'SYMBOL_QUOTE', symbol: 'NEW_BULL.HK' }],
      },
    });

    const advanceResult = await machine.advancePendingSwitch({
      direction: 'LONG',
      positions: [],
    });
    expect(advanceResult).toMatchObject({
      advanced: true,
      direction: 'LONG',
      stillPending: true,
      driveResult: {
        kind: 'WAIT',
        wakeups: [
          { kind: 'SYMBOL_QUOTE', symbol: 'NEW_BULL.HK' },
          { kind: 'RETRY_TIMER', atMs: nowMs + 2_000 },
        ],
      },
    });
    expect(executedActions).toEqual(['SELLCALL']);
    expect(machine.hasPendingSwitch('LONG')).toBeTrue();
  });

  it('keeps pending switch state when rebuy submission is rejected', async () => {
    const monitorConfig = createMonitorConfigDouble({
      targetNotional: 5_000,
      autoSearchConfig: getDefaultAutoSearchConfig(),
    });
    const symbolRegistry = createSymbolRegistryDouble({
      longSeat: {
        symbol: 'OLD_BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      longVersion: 1,
    });
    const switchStates = createSwitchStatesMap();
    const switchSuppressions = createSwitchSuppressionsMap();
    let nowMs = Date.parse('2026-02-16T01:00:00.000Z');
    const seatStateManager = createSeatStateManager({
      symbolRegistry,
      switchStates,
      switchSuppressions,
      now: () => new Date(nowMs),
      logger: createLoggerStub(),
      getHKDateKey,
    });
    const signalBuilder = createSignalBuilder();
    const executedActions: Array<string | null> = [];
    const trader = createTraderDouble({
      executeSignals: async (signals) => {
        const action = signals[0]?.action ?? null;
        executedActions.push(action);
        if (action === 'SELLCALL') {
          return { executedOrderIds: ['SELL-ORDER-1'] };
        }

        return { executedOrderIds: [] };
      },
      getPendingOrders: async () => [],
    });
    const orderRecorder = createOrderRecorderDouble({
      getSellRecordByOrderId: (orderId) =>
        orderId === 'SELL-ORDER-1'
          ? {
              orderId: 'SELL-ORDER-1',
              symbol: 'OLD_BULL.HK',
              executedPrice: 2,
              executedQuantity: 100,
              executedTime: 9_999_999_999_999,
              submittedAt: undefined,
              updatedAt: undefined,
            }
          : null,
    });
    const machine = createSwitchStateMachine({
      autoSearchConfig: monitorConfig.autoSearchConfig,
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      trader,
      orderRecorder,
      riskChecker: createRiskCheckerDouble({
        getWarrantDistanceInfo: () =>
          createWarrantDistanceInfoDouble({
            warrantType: 'BULL',
            distanceToStrikePercent: 0.1,
          }),
      }),
      now: () => new Date(nowMs),
      switchStates,
      periodicSwitchPending: createPeriodicSwitchPendingMap(),
      resolveSuppression: seatStateManager.resolveSuppression,
      markSuppression: seatStateManager.markSuppression,
      enterSwitchingSeat: seatStateManager.enterSwitchingSeat,
      updateSeatState: seatStateManager.updateSeatState,
      resolveDirectionalAutoSearchPolicy: () => createDirectionalAutoSearchPolicy('LONG'),
      buildFindBestWarrantInput: async () => createFindBestWarrantInputDouble(),
      findBestWarrant: async () => createWarrantCandidate('NEW_BULL.HK'),
      resolveDirectionSymbols,
      calculateBuyQuantityByNotional,
      buildOrderSignal: signalBuilder.buildOrderSignal,
      pendingOrderStatuses: PENDING_ORDER_STATUSES,
      buySide: OrderSide.Buy,
      logger: createLoggerStub(),
      maxSearchFailuresPerDay: 3,
      getHKDateKey,
      calculateTradingDurationMsBetween,
      getTradingCalendarSnapshot: () => createTradingCalendarSnapshot(),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async (symbols) =>
          new Map(createQuotes(Object.fromEntries([...symbols].map((symbol) => [symbol, 1])))),
      }),
    });
    await runDistanceSwitch(machine, {
      direction: 'LONG',
      monitorPrice: 20_000,
      positions: [
        {
          symbol: 'OLD_BULL.HK',
          quantity: 100,
          availableQuantity: 100,
          symbolName: 'OLD_BULL',
          accountChannel: 'lb_papertrading',
          currency: 'HKD',
          costPrice: 1,
        },
      ],
    });
    expect(executedActions).toEqual(['SELLCALL']);
    expect(machine.hasPendingSwitch('LONG')).toBeTrue();

    nowMs += 1_000;
    await runDistanceSwitch(machine, {
      direction: 'LONG',
      monitorPrice: 20_000,
      positions: [],
    });

    expect(executedActions).toEqual(['SELLCALL']);
    expect(machine.hasPendingSwitch('LONG')).toBeTrue();

    await runDistanceSwitch(machine, {
      direction: 'LONG',
      monitorPrice: 20_000,
      positions: [],
    });

    expect(executedActions).toEqual(['SELLCALL', 'BUYCALL']);
    expect(machine.hasPendingSwitch('LONG')).toBeTrue();
    const seat = symbolRegistry.getSeatState('LONG');
    expect(seat.status).toBe('SWITCHING');
    expect(seat.symbol).toBe('NEW_BULL.HK');
  });

  it('propagates rebuy execution error after sell stage succeeds', async () => {
    const monitorConfig = createMonitorConfigDouble({
      targetNotional: 5_000,
      autoSearchConfig: getDefaultAutoSearchConfig(),
    });
    const symbolRegistry = createSymbolRegistryDouble({
      longSeat: {
        symbol: 'OLD_BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      longVersion: 1,
    });
    const switchStates = createSwitchStatesMap();
    const switchSuppressions = createSwitchSuppressionsMap();
    let nowMs = Date.parse('2026-02-16T01:00:00.000Z');
    const seatStateManager = createSeatStateManager({
      symbolRegistry,
      switchStates,
      switchSuppressions,
      now: () => new Date(nowMs),
      logger: createLoggerStub(),
      getHKDateKey,
    });
    const signalBuilder = createSignalBuilder();
    const executedActions: Array<string | null> = [];

    const trader = createTraderDouble({
      executeSignals: async (signals) => {
        const action = signals[0]?.action ?? null;
        executedActions.push(action);
        if (action === 'SELLCALL') {
          return { executedOrderIds: ['SELL-ORDER-REBUY-THROW'] };
        }

        throw new Error('rebuy submit failed');
      },
      getPendingOrders: async () => [],
    });
    const orderRecorder = createOrderRecorderDouble({
      getSellRecordByOrderId: (orderId) =>
        orderId === 'SELL-ORDER-REBUY-THROW'
          ? {
              orderId: 'SELL-ORDER-REBUY-THROW',
              symbol: 'OLD_BULL.HK',
              executedPrice: 2,
              executedQuantity: 100,
              executedTime: 9_999_999_999_999,
              submittedAt: undefined,
              updatedAt: undefined,
            }
          : null,
    });
    const machine = createSwitchStateMachine({
      autoSearchConfig: monitorConfig.autoSearchConfig,
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      trader,
      orderRecorder,
      riskChecker: createRiskCheckerDouble({
        getWarrantDistanceInfo: () =>
          createWarrantDistanceInfoDouble({
            warrantType: 'BULL',
            distanceToStrikePercent: 0.1,
          }),
      }),
      now: () => new Date(nowMs),
      switchStates,
      periodicSwitchPending: createPeriodicSwitchPendingMap(),
      resolveSuppression: seatStateManager.resolveSuppression,
      markSuppression: seatStateManager.markSuppression,
      enterSwitchingSeat: seatStateManager.enterSwitchingSeat,
      updateSeatState: seatStateManager.updateSeatState,
      resolveDirectionalAutoSearchPolicy: () => createDirectionalAutoSearchPolicy('LONG'),
      buildFindBestWarrantInput: async () => createFindBestWarrantInputDouble(),
      findBestWarrant: async () => createWarrantCandidate('NEW_BULL.HK'),
      resolveDirectionSymbols,
      calculateBuyQuantityByNotional,
      buildOrderSignal: signalBuilder.buildOrderSignal,
      pendingOrderStatuses: PENDING_ORDER_STATUSES,
      buySide: OrderSide.Buy,
      logger: createLoggerStub(),
      maxSearchFailuresPerDay: 3,
      getHKDateKey,
      calculateTradingDurationMsBetween,
      getTradingCalendarSnapshot: () => createTradingCalendarSnapshot(),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async (symbols) =>
          new Map(createQuotes(Object.fromEntries([...symbols].map((symbol) => [symbol, 1])))),
      }),
    });

    await runDistanceSwitch(machine, {
      direction: 'LONG',
      monitorPrice: 20_000,
      positions: [
        {
          symbol: 'OLD_BULL.HK',
          quantity: 100,
          availableQuantity: 100,
          symbolName: 'OLD_BULL',
          accountChannel: 'lb_papertrading',
          currency: 'HKD',
          costPrice: 1,
        },
      ],
    });

    nowMs += 1_000;
    await runDistanceSwitch(machine, {
      direction: 'LONG',
      monitorPrice: 20_000,
      positions: [],
    });

    let caught: unknown = null;
    try {
      await runDistanceSwitch(machine, {
        direction: 'LONG',
        monitorPrice: 20_000,
        positions: [],
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({ message: 'rebuy submit failed' });
    expect(executedActions).toEqual(['SELLCALL', 'BUYCALL']);
  });

  it('fails and clears seat when rebuy sell-notional is unavailable', async () => {
    const monitorConfig = createMonitorConfigDouble({
      autoSearchConfig: getDefaultAutoSearchConfig(),
    });
    const symbolRegistry = createSymbolRegistryDouble({
      longSeat: {
        symbol: 'OLD_BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      longVersion: 1,
    });
    const switchStates = createSwitchStatesMap();
    const switchSuppressions = createSwitchSuppressionsMap();
    let nowMs = Date.parse('2026-02-16T01:00:00.000Z');
    const seatStateManager = createSeatStateManager({
      symbolRegistry,
      switchStates,
      switchSuppressions,
      now: () => new Date(nowMs),
      logger: createLoggerStub(),
      getHKDateKey,
    });
    const signalBuilder = createSignalBuilder();
    const executedActions: string[] = [];
    const trader = createTraderDouble({
      executeSignals: async (signals) => {
        executedActions.push(signals[0]?.action ?? 'UNKNOWN');
        return { executedOrderIds: ['SELL-ORDER-NOTIONAL-MISS'] };
      },
      getPendingOrders: async () => [],
    });
    const orderRecorder = createOrderRecorderDouble({
      getSellRecordByOrderId: () => null,
    });
    const machine = createSwitchStateMachine({
      autoSearchConfig: monitorConfig.autoSearchConfig,
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      trader,
      orderRecorder,
      riskChecker: createRiskCheckerDouble({
        getWarrantDistanceInfo: () =>
          createWarrantDistanceInfoDouble({
            warrantType: 'BULL',
            distanceToStrikePercent: 0.1,
          }),
      }),
      now: () => new Date(nowMs),
      switchStates,
      periodicSwitchPending: createPeriodicSwitchPendingMap(),
      resolveSuppression: seatStateManager.resolveSuppression,
      markSuppression: seatStateManager.markSuppression,
      enterSwitchingSeat: seatStateManager.enterSwitchingSeat,
      updateSeatState: seatStateManager.updateSeatState,
      resolveDirectionalAutoSearchPolicy: () => createDirectionalAutoSearchPolicy('LONG'),
      buildFindBestWarrantInput: async () => createFindBestWarrantInputDouble(),
      findBestWarrant: async () => createWarrantCandidate('NEW_BULL.HK'),
      resolveDirectionSymbols,
      calculateBuyQuantityByNotional,
      buildOrderSignal: signalBuilder.buildOrderSignal,
      pendingOrderStatuses: PENDING_ORDER_STATUSES,
      buySide: OrderSide.Buy,
      logger: createLoggerStub(),
      maxSearchFailuresPerDay: 3,
      getHKDateKey,
      calculateTradingDurationMsBetween,
      getTradingCalendarSnapshot: () => createTradingCalendarSnapshot(),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async (symbols) =>
          new Map(createQuotes(Object.fromEntries([...symbols].map((symbol) => [symbol, 1])))),
      }),
    });
    await runDistanceSwitch(machine, {
      direction: 'LONG',
      monitorPrice: 20_000,
      positions: [
        {
          symbol: 'OLD_BULL.HK',
          quantity: 100,
          availableQuantity: 100,
          symbolName: 'OLD_BULL',
          accountChannel: 'lb_papertrading',
          currency: 'HKD',
          costPrice: 1,
        },
      ],
    });
    nowMs += 1_000;
    await runDistanceSwitch(machine, {
      direction: 'LONG',
      monitorPrice: 20_000,
      positions: [],
    });
    expect(executedActions).toEqual(['SELLCALL']);

    await runDistanceSwitch(machine, {
      direction: 'LONG',
      monitorPrice: 20_000,
      positions: [],
    });
    expect(executedActions).toEqual(['SELLCALL']);
    const longSeat = symbolRegistry.getSeatState('LONG');
    expect(longSeat.status).toBe('EMPTY');
    expect(longSeat.symbol).toBeNull();
    expect(machine.hasPendingSwitch('LONG')).toBeFalse();
  });

  it('does not trigger distance switch when Decimal distance is slightly above the lower bound', async () => {
    const monitorConfig = createMonitorConfigDouble({
      autoSearchConfig: getDefaultAutoSearchConfig(),
    });
    const symbolRegistry = createSymbolRegistryDouble({
      longSeat: {
        symbol: 'OLD_BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      longVersion: 1,
    });
    const switchStates = createSwitchStatesMap();
    const switchSuppressions = createSwitchSuppressionsMap();
    const nowMs = Date.parse('2026-02-16T01:00:00.000Z');
    const seatStateManager = createSeatStateManager({
      symbolRegistry,
      switchStates,
      switchSuppressions,
      now: () => new Date(nowMs),
      logger: createLoggerStub(),
      getHKDateKey,
    });
    const signalBuilder = createSignalBuilder();
    let findCalls = 0;
    const machine = createSwitchStateMachine({
      autoSearchConfig: monitorConfig.autoSearchConfig,
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      trader: createTraderDouble(),
      orderRecorder: createOrderRecorderDouble(),
      riskChecker: createRiskCheckerDouble({
        getWarrantDistanceInfo: () => ({
          warrantType: 'BULL',
          distanceToStrikePercent: toMockDecimal('0.20000000000000000001'),
        }),
      }),
      now: () => new Date(nowMs),
      switchStates,
      periodicSwitchPending: createPeriodicSwitchPendingMap(),
      resolveSuppression: seatStateManager.resolveSuppression,
      markSuppression: seatStateManager.markSuppression,
      enterSwitchingSeat: seatStateManager.enterSwitchingSeat,
      updateSeatState: seatStateManager.updateSeatState,
      resolveDirectionalAutoSearchPolicy: () => createDirectionalAutoSearchPolicy('LONG'),
      buildFindBestWarrantInput: async () => createFindBestWarrantInputDouble(),
      findBestWarrant: async () => {
        findCalls += 1;
        return createWarrantCandidate('NEW_BULL.HK');
      },
      resolveDirectionSymbols,
      calculateBuyQuantityByNotional,
      buildOrderSignal: signalBuilder.buildOrderSignal,
      pendingOrderStatuses: PENDING_ORDER_STATUSES,
      buySide: OrderSide.Buy,
      logger: createLoggerStub(),
      maxSearchFailuresPerDay: 3,
      getHKDateKey,
      calculateTradingDurationMsBetween,
      getTradingCalendarSnapshot: () => createTradingCalendarSnapshot(),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async (symbols) =>
          new Map(createQuotes(Object.fromEntries([...symbols].map((symbol) => [symbol, 1])))),
      }),
    });
    await runDistanceSwitch(machine, {
      direction: 'LONG',
      monitorPrice: 20_000,
      positions: [],
    });

    const seat = symbolRegistry.getSeatState('LONG');
    expect(findCalls).toBe(0);
    expect(seat.status).toBe('ACTIVE');
    expect(seat.symbol).toBe('OLD_BULL.HK');
    expect(machine.hasPendingSwitch('LONG')).toBeFalse();
  });

  it('switches SHORT seat when bear distance is outside the upper bound', async () => {
    const monitorConfig = createMonitorConfigDouble({
      autoSearchConfig: getDefaultAutoSearchConfig(),
    });
    const symbolRegistry = createSymbolRegistryDouble({
      shortSeat: {
        symbol: 'OLD_BEAR.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      shortVersion: 1,
    });
    const switchStates = createSwitchStatesMap();
    const switchSuppressions = createSwitchSuppressionsMap();
    const nowMs = Date.parse('2026-02-16T01:00:00.000Z');
    const seatStateManager = createSeatStateManager({
      symbolRegistry,
      switchStates,
      switchSuppressions,
      now: () => new Date(nowMs),
      logger: createLoggerStub(),
      getHKDateKey,
    });
    const signalBuilder = createSignalBuilder();
    let executeCalls = 0;
    const machine = createSwitchStateMachine({
      autoSearchConfig: monitorConfig.autoSearchConfig,
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      trader: createTraderDouble({
        executeSignals: async () => {
          executeCalls += 1;
          return { executedOrderIds: ['EXECUTED-ORDER-1'] };
        },
      }),
      orderRecorder: createOrderRecorderDouble(),
      riskChecker: createRiskCheckerDouble({
        getWarrantDistanceInfo: () =>
          createWarrantDistanceInfoDouble({
            warrantType: 'BEAR',
            distanceToStrikePercent: -0.1,
          }),
      }),
      now: () => new Date(nowMs),
      switchStates,
      periodicSwitchPending: createPeriodicSwitchPendingMap(),
      resolveSuppression: seatStateManager.resolveSuppression,
      markSuppression: seatStateManager.markSuppression,
      enterSwitchingSeat: seatStateManager.enterSwitchingSeat,
      updateSeatState: seatStateManager.updateSeatState,
      resolveDirectionalAutoSearchPolicy: () => createDirectionalAutoSearchPolicy('SHORT'),
      buildFindBestWarrantInput: async () =>
        createFindBestWarrantInputDouble(createDirectionalAutoSearchPolicy('SHORT')),
      findBestWarrant: async () =>
        createWarrantCandidateWithOverrides('NEW_BEAR.HK', {
          callPrice: 19_500,
          distancePct: -0.3499,
          selectionStage: 'DEGRADED',
          distanceDeltaToThreshold: 0.0001,
        }),
      resolveDirectionSymbols,
      calculateBuyQuantityByNotional,
      buildOrderSignal: signalBuilder.buildOrderSignal,
      pendingOrderStatuses: PENDING_ORDER_STATUSES,
      buySide: OrderSide.Buy,
      logger: createLoggerStub(),
      maxSearchFailuresPerDay: 3,
      getHKDateKey,
      calculateTradingDurationMsBetween,
      getTradingCalendarSnapshot: () => createTradingCalendarSnapshot(),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async (symbols) =>
          new Map(createQuotes(Object.fromEntries([...symbols].map((symbol) => [symbol, 1])))),
      }),
    });
    await runDistanceSwitch(machine, {
      direction: 'SHORT',
      monitorPrice: 20_000,
      positions: [],
    });

    const seat = symbolRegistry.getSeatState('SHORT');
    expect(seat.status).toBe('ACTIVATING');
    expect(seat.symbol).toBe('NEW_BEAR.HK');
    expect(seat.callPrice).toBe(19_500);
    expect(symbolRegistry.getSeatVersion('SHORT')).toBe(2);
    expect(executeCalls).toBe(0);
    expect(machine.hasPendingSwitch('SHORT')).toBeFalse();
  });

  it('marks suppression for SHORT safe-side same-symbol and skips switching', async () => {
    const monitorConfig = createMonitorConfigDouble({
      autoSearchConfig: getDefaultAutoSearchConfig(),
    });
    const symbolRegistry = createSymbolRegistryDouble({
      shortSeat: {
        symbol: 'OLD_BEAR.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
    });
    const switchStates = createSwitchStatesMap();
    const switchSuppressions = createSwitchSuppressionsMap();
    const nowMs = Date.parse('2026-02-16T01:00:00.000Z');
    const seatStateManager = createSeatStateManager({
      symbolRegistry,
      switchStates,
      switchSuppressions,
      now: () => new Date(nowMs),
      logger: createLoggerStub(),
      getHKDateKey,
    });
    const signalBuilder = createSignalBuilder();
    const machine = createSwitchStateMachine({
      autoSearchConfig: monitorConfig.autoSearchConfig,
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      trader: createTraderDouble(),
      orderRecorder: createOrderRecorderDouble(),
      riskChecker: createRiskCheckerDouble({
        getWarrantDistanceInfo: () =>
          createWarrantDistanceInfoDouble({
            warrantType: 'BEAR',
            distanceToStrikePercent: -2,
          }),
      }),
      now: () => new Date(nowMs),
      switchStates,
      periodicSwitchPending: createPeriodicSwitchPendingMap(),
      resolveSuppression: seatStateManager.resolveSuppression,
      markSuppression: seatStateManager.markSuppression,
      enterSwitchingSeat: seatStateManager.enterSwitchingSeat,
      updateSeatState: seatStateManager.updateSeatState,
      resolveDirectionalAutoSearchPolicy: () => createDirectionalAutoSearchPolicy('SHORT'),
      buildFindBestWarrantInput: async () =>
        createFindBestWarrantInputDouble(createDirectionalAutoSearchPolicy('SHORT')),
      findBestWarrant: async () => ({
        ...createWarrantCandidate('OLD_BEAR.HK'),
        callPrice: 19_500,
      }),
      resolveDirectionSymbols,
      calculateBuyQuantityByNotional,
      buildOrderSignal: signalBuilder.buildOrderSignal,
      pendingOrderStatuses: PENDING_ORDER_STATUSES,
      buySide: OrderSide.Buy,
      logger: createLoggerStub(),
      maxSearchFailuresPerDay: 3,
      getHKDateKey,
      calculateTradingDurationMsBetween,
      getTradingCalendarSnapshot: () => createTradingCalendarSnapshot(),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async (symbols) =>
          new Map(createQuotes(Object.fromEntries([...symbols].map((symbol) => [symbol, 1])))),
      }),
    });

    await runDistanceSwitch(machine, {
      direction: 'SHORT',
      monitorPrice: 20_000,
      positions: [],
    });

    const seat = symbolRegistry.getSeatState('SHORT');
    expect(seat.status).toBe('ACTIVE');
    expect(seat.symbol).toBe('OLD_BEAR.HK');
    expect(
      seatStateManager.resolveSuppression('SHORT', 'OLD_BEAR.HK', 'DISTANCE_SAFE_SIDE'),
    ).not.toBeNull();
    expect(machine.hasPendingSwitch('SHORT')).toBeFalse();
  });

  it('does not mark suppression for SHORT danger-side same-symbol and skips switching', async () => {
    const monitorConfig = createMonitorConfigDouble({
      autoSearchConfig: getDefaultAutoSearchConfig(),
    });
    const symbolRegistry = createSymbolRegistryDouble({
      shortSeat: {
        symbol: 'OLD_BEAR.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
    });
    const switchStates = createSwitchStatesMap();
    const switchSuppressions = createSwitchSuppressionsMap();
    const nowMs = Date.parse('2026-02-16T01:00:00.000Z');
    const seatStateManager = createSeatStateManager({
      symbolRegistry,
      switchStates,
      switchSuppressions,
      now: () => new Date(nowMs),
      logger: createLoggerStub(),
      getHKDateKey,
    });
    const signalBuilder = createSignalBuilder();
    const machine = createSwitchStateMachine({
      autoSearchConfig: monitorConfig.autoSearchConfig,
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      trader: createTraderDouble(),
      orderRecorder: createOrderRecorderDouble(),
      riskChecker: createRiskCheckerDouble({
        getWarrantDistanceInfo: () =>
          createWarrantDistanceInfoDouble({
            warrantType: 'BEAR',
            distanceToStrikePercent: -0.1,
          }),
      }),
      now: () => new Date(nowMs),
      switchStates,
      periodicSwitchPending: createPeriodicSwitchPendingMap(),
      resolveSuppression: seatStateManager.resolveSuppression,
      markSuppression: seatStateManager.markSuppression,
      enterSwitchingSeat: seatStateManager.enterSwitchingSeat,
      updateSeatState: seatStateManager.updateSeatState,
      resolveDirectionalAutoSearchPolicy: () => createDirectionalAutoSearchPolicy('SHORT'),
      buildFindBestWarrantInput: async () =>
        createFindBestWarrantInputDouble(createDirectionalAutoSearchPolicy('SHORT')),
      findBestWarrant: async () => ({
        ...createWarrantCandidate('OLD_BEAR.HK'),
        callPrice: 19_500,
      }),
      resolveDirectionSymbols,
      calculateBuyQuantityByNotional,
      buildOrderSignal: signalBuilder.buildOrderSignal,
      pendingOrderStatuses: PENDING_ORDER_STATUSES,
      buySide: OrderSide.Buy,
      logger: createLoggerStub(),
      maxSearchFailuresPerDay: 3,
      getHKDateKey,
      calculateTradingDurationMsBetween,
      getTradingCalendarSnapshot: () => createTradingCalendarSnapshot(),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async (symbols) =>
          new Map(createQuotes(Object.fromEntries([...symbols].map((symbol) => [symbol, 1])))),
      }),
    });

    await runDistanceSwitch(machine, {
      direction: 'SHORT',
      monitorPrice: 20_000,
      positions: [],
    });

    const seat = symbolRegistry.getSeatState('SHORT');
    expect(seat.status).toBe('ACTIVE');
    expect(seat.symbol).toBe('OLD_BEAR.HK');
    expect(
      seatStateManager.resolveSuppression('SHORT', 'OLD_BEAR.HK', 'DISTANCE_SAFE_SIDE'),
    ).toBeNull();
    expect(machine.hasPendingSwitch('SHORT')).toBeFalse();
  });

  it('abandons distance-switch admission when takeover begins during candidate lookup', async () => {
    const beforeTakeoverMs = Date.parse('2026-02-16T07:54:59.000Z');
    const takeoverMs = Date.parse('2026-02-16T07:55:00.000Z');
    let currentNowMs = beforeTakeoverMs;
    const candidateLookupStarted = createDeferred();
    const candidateLookup = createDeferred<ReturnType<typeof createWarrantCandidate>>();
    const harness = createLongSwitchAdmissionHarness({
      nowMs: beforeTakeoverMs,
      now: () => new Date(currentNowMs),
      findBestWarrant: async () => {
        candidateLookupStarted.resolve();
        return await candidateLookup.promise;
      },
    });

    const startPromise = harness.machine.startSwitchOnDistance({
      direction: 'LONG',
      monitorPrice: 20_000,
      positions: [],
      canContinue: () => currentNowMs < takeoverMs,
    });

    await candidateLookupStarted.promise;
    currentNowMs = takeoverMs;
    candidateLookup.resolve(createWarrantCandidate('NEW_BULL.HK'));

    const result = await startPromise;

    expect(result).toEqual({
      started: false,
      direction: 'LONG',
      driveResult: { kind: 'NOOP' },
    });

    expect(harness.symbolRegistry.getSeatState('LONG')).toMatchObject({
      status: 'ACTIVE',
      symbol: 'OLD_BULL.HK',
    });
    expect(harness.switchStates.size).toBe(0);
  });

  it('leaves a pending distance switch untouched when takeover begins during pending-order refresh', async () => {
    const beforeTakeoverMs = Date.parse('2026-02-16T07:54:59.000Z');
    const takeoverMs = Date.parse('2026-02-16T07:55:00.000Z');
    let currentNowMs = beforeTakeoverMs;
    let pendingOrderReads = 0;
    const pendingOrderReadStarted = createDeferred();
    const pendingOrderRead = createDeferred<ReadonlyArray<never>>();
    let executeSignalsCalls = 0;
    const harness = createLongSwitchAdmissionHarness({
      nowMs: beforeTakeoverMs,
      now: () => new Date(currentNowMs),
      traderOverrides: {
        getPendingOrders: async () => {
          pendingOrderReads += 1;
          if (pendingOrderReads === 1) {
            return [];
          }

          pendingOrderReadStarted.resolve();
          return await pendingOrderRead.promise;
        },
        executeSignals: async () => {
          executeSignalsCalls += 1;
          return { executedOrderIds: [] };
        },
      },
    });
    const canContinue = (): boolean => currentNowMs < takeoverMs;

    const started = await harness.machine.startSwitchOnDistance({
      direction: 'LONG',
      monitorPrice: 20_000,
      positions: [],
      canContinue,
    });
    expect(started.started).toBeTrue();

    const advancePromise = harness.machine.advancePendingSwitch({
      direction: 'LONG',
      positions: [],
      canContinue,
    });
    await pendingOrderReadStarted.promise;
    currentNowMs = takeoverMs;
    pendingOrderRead.resolve([]);

    const result = await advancePromise;

    expect(result).toEqual({
      advanced: false,
      direction: 'LONG',
      stillPending: false,
      driveResult: { kind: 'NOOP' },
    });

    expect(harness.symbolRegistry.getSeatState('LONG')).toMatchObject({
      status: 'SWITCHING',
      symbol: 'OLD_BULL.HK',
    });
    expect(harness.machine.hasPendingSwitch('LONG')).toBeTrue();
    expect(executeSignalsCalls).toBe(0);
  });
});
