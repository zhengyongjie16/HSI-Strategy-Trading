import type { RuntimeStateFixtures } from '../../helpers/types.js';
import {
  createLoggerDouble,
  createSeatSwitchWorkflowDouble,
  createMonitorContextDouble,
  createOrderRecorderDouble,
  createAccountSnapshotDouble,
  createPositionDouble,
  createQuoteDouble,
  createRiskCheckerDouble,
  createSymbolRegistryDouble,
  createTradeRuntimeDouble,
  createMarketDataClientDouble,
  createWarrantDistanceInfoDouble,
} from '../../helpers/testDoubles.js';
import type { TradeRuntime } from '../../../src/app/runtime/types.js';
import { createDistanceSwitchPublicationFixture } from './distanceSwitchPublication.js';
import { createSnapshotFixture } from '../../helpers/accountPositionSnapshot.js';
import { createSettlementRuntimeFixture } from '../../helpers/settlementRuntime.js';
import { createTerminationRuntime } from '../../../src/runtime/lifecycle/terminationRuntime.js';
import { describe, expect, it } from 'bun:test';

import { createMonitorConfig } from '../../../mock/factories/configFactory.js';
import { createSeatSwitchWorkflow } from '../../../src/application/seatSwitch/index.js';
import {
  getDefaultAutoSearchConfig,
  createWarrantCandidate,
  createLoggerStub,
} from '../../helpers/seatTestUtils.js';
import { ORDER_QUOTE_RETRY, TRADING } from '../../../src/constants/index.js';
import { createStaticLiquidationExecutor } from '../../../src/application/staticLiquidation/index.js';
import { createDefaultMonitorQuoteEventRuntime as createDefaultMonitorQuoteEventRuntimeImpl } from '../../../src/runtime/monitorQuoteEventRuntime/monitorQuoteEventRuntime.js';
import { createExternalApiRequestError } from '../../helpers/createExternalApiRequestError.js';
import type {
  CreateDefaultMonitorQuoteEventRuntimeDeps,
  MonitorQuoteEventRuntime,
} from '../../../src/runtime/monitorQuoteEventRuntime/types.js';
import type { MonitorContextAssembly } from '../../../src/app/context/types.js';
import type { StartSwitchOnDistanceResult } from '../../../src/types/seatSwitch.js';
import type { QuoteUpdatedEvent } from '../../../src/types/marketPorts.js';
import type { AccountPositionSnapshot } from '../../../src/types/accountPosition.js';

/**
 * MonitorQuoteEventRuntime 业务测试
 *
 * 功能：
 * - 验证 monitor quote 事件运行时的公开默认工厂与生产行为契约
 */

type TestMonitorQuoteRuntimeDeps = Omit<
  CreateDefaultMonitorQuoteEventRuntimeDeps,
  | 'logger'
  | 'monitorContext'
  | 'lifecycleState'
  | 'scheduleTimer'
  | 'clearTimer'
  | 'termination'
  | 'postTradeConsistencyRuntime'
  | 'snapshot'
  | 'executeStaticLiquidation'
> & {
  readonly snapshot: AccountPositionSnapshot;
  readonly monitorContext: MonitorContextAssembly;
  readonly lifecycleState: Pick<RuntimeStateFixtures['lifecycleState'], 'isTradingEnabled'>;
  readonly tradeRuntime: TradeRuntime;
} & Partial<
    Pick<CreateDefaultMonitorQuoteEventRuntimeDeps, 'scheduleTimer' | 'clearTimer' | 'termination'>
  >;

async function createDefaultMonitorQuoteEventRuntime(
  deps: TestMonitorQuoteRuntimeDeps,
): Promise<MonitorQuoteEventRuntime> {
  const {
    scheduleTimer = (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer = (handle) => {
      clearTimeout(handle);
    },
    termination: externalTermination,
    tradeRuntime,
    ...requiredDeps
  } = deps;
  const ownerTermination = createTerminationRuntime({
    closeTradingGate: () => {
      deps.lifecycleState.isTradingEnabled = false;
    },
    closeProducerAdmission: () => {},
    stopProducers: [],
    onSecondaryError: (error) => {
      throw error;
    },
  });
  const termination = {
    ...ownerTermination,
    isTerminated: () =>
      externalTermination === undefined
        ? ownerTermination.isTerminated()
        : externalTermination.isTerminated(),
    reportFatalError: (error: unknown) => {
      if (externalTermination === undefined) ownerTermination.reportFatalError(error);
      else externalTermination.reportFatalError(error);
    },
  };
  const settlement = createSettlementRuntimeFixture({
    logger: createLoggerDouble(),
    snapshot: deps.snapshot,
    termination,
    monitorContext: deps.monitorContext,
    getProtectiveOrderReader: () => createTradeRuntimeDouble().orderMonitor,
    onPositionsCommitted: async (token) => {
      if (!deps.snapshot.isCurrent(token, { account: true, positions: true, paired: true }))
        throw new Error('Stale settlement positions callback');
    },
    scheduler: {
      scheduleTimer: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimer: (handle) => {
        clearTimeout(handle);
      },
    },
  });
  settlement.start();
  expect(await settlement.completeRebuildBaseline()).toBeTrue();
  const completed = await settlement.waitForFresh();
  // 所有真实 quote 路径从普通 seat commit 后启动，不能靠重签 settlement 为消费授权续租。
  for (const refreshAccount of [true, false]) {
    await deps.snapshot.requestRefresh({
      source: 'SEAT_ACTIVATION',
      dayEpoch: completed.snapshotToken.dayEpoch,
      refreshAccount,
      refreshPositions: true,
    }).result;
    expect(settlement.isCurrent(completed)).toBe(true);
    expect(await settlement.waitForFresh()).toBe(completed);
  }

  return createDefaultMonitorQuoteEventRuntimeImpl({
    executeStaticLiquidation: createStaticLiquidationExecutor({
      orderExecutor: tradeRuntime.orderExecutor,
      marketDataClient: deps.marketDataClient,
      snapshot: deps.snapshot,
      postTradeConsistencyRuntime: settlement,
      now: deps.now,
    }),
    postTradeConsistencyRuntime: settlement,
    logger: { error: () => {} },
    ...requiredDeps,
    scheduleTimer,
    clearTimer,
    termination,
  });
}

type RuntimeHarness = Readonly<{
  runtime: MonitorQuoteEventRuntime;
  emitQuoteUpdated: (event: QuoteUpdatedEvent) => void;
}>;

type RetainReleaseCall = Readonly<{
  ownerKey: string;
  reason: string;
}>;

type DistanceSwitchTimerHarness = Readonly<{
  now: () => Date;
  setNow: (nextNowMs: number) => void;
  scheduleTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer: (handle: ReturnType<typeof setTimeout>) => void;
  fireDueTimers: () => void;
  getPendingTimerCount: () => number;
  getPendingTimerAtMs: () => ReadonlyArray<number>;
}>;

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });

  return {
    promise,
    resolve,
  };
}

function createDistanceSwitchTimerHarness(initialNowMs: number): DistanceSwitchTimerHarness {
  let currentNowMs = initialNowMs;
  const timers = new Map<ReturnType<typeof setTimeout>, { atMs: number; callback: () => void }>();

  function scheduleTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    const handle = setTimeout(() => {}, delayMs);
    timers.set(handle, {
      atMs: currentNowMs + delayMs,
      callback,
    });
    return handle;
  }

  function clearTimer(handle: ReturnType<typeof setTimeout>): void {
    clearTimeout(handle);
    timers.delete(handle);
  }

  function fireDueTimers(): void {
    const dueTimers = [...timers.entries()].filter(([, timer]) => timer.atMs <= currentNowMs);
    for (const [handle, timer] of dueTimers) {
      clearTimeout(handle);
      timers.delete(handle);
      timer.callback();
    }
  }

  return {
    now: () => new Date(currentNowMs),
    setNow: (nextNowMs: number) => {
      currentNowMs = nextNowMs;
    },
    scheduleTimer,
    clearTimer,
    fireDueTimers,
    getPendingTimerCount: () => timers.size,
    getPendingTimerAtMs: () => [...timers.values()].map((timer) => timer.atMs),
  };
}

function createQuoteUpdatedEvent(symbol: string, price: string): QuoteUpdatedEvent {
  return {
    symbol,
    quote: createQuoteDouble(symbol, price, 100),
  };
}

function createMonitorQuoteUpdatedEvent(price: string = '20000'): QuoteUpdatedEvent {
  return createQuoteUpdatedEvent('HSI.HK', price);
}

function waitTick(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

async function createDefaultStaticLiquidationHarness(): Promise<
  RuntimeHarness &
    Readonly<{
      submittedActions: ReadonlyArray<string>;
      getClearedOrders: () => number;
      getRefreshUnrealizedCalls: () => number;
    }>
> {
  let quoteUpdatedListener: ((event: QuoteUpdatedEvent) => void) | null = null;
  const submittedActions: string[] = [];
  let clearedOrders = 0;
  let refreshUnrealizedCalls = 0;
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
  const monitorContext = createMonitorContextDouble({
    config: createMonitorConfig({
      monitorSymbol: 'HSI.HK',
      autoSearchConfig: {
        autoSearchEnabled: false,
        autoSearchMinDistancePctBull: null,
        autoSearchMinDistancePctBear: null,
        autoSearchMinTurnoverPerMinuteBull: null,
        autoSearchMinTurnoverPerMinuteBear: null,
        autoSearchExpiryMinMonths: 3,
        autoSearchOpenDelayMinutes: 5,
        switchIntervalMinutes: 0,
        switchDistanceRangeBull: null,
        switchDistanceRangeBear: null,
      },
      longSymbol: 'BULL.HK',
      shortSymbol: 'BEAR.HK',
    }),
    symbolRegistry,
    orderRecorder: createOrderRecorderDouble({
      clearBuyOrders: () => {
        clearedOrders += 1;
      },
    }),
    riskChecker: createRiskCheckerDouble({
      checkWarrantDistanceLiquidation: (_symbol, isLongSymbol) => ({
        shouldLiquidate: isLongSymbol,
        ...(isLongSymbol ? { reason: '触发清仓阈值' } : {}),
      }),
      publishUnrealizedLossData: () => {
        refreshUnrealizedCalls += 1;
      },
    }),
  });
  const runtime = await createDefaultMonitorQuoteEventRuntime({
    snapshot: await createSnapshotFixture({
      account: createAccountSnapshotDouble('100000'),
      positions: [
        createPositionDouble({
          symbol: 'BULL.HK',
          quantity: 200,
          availableQuantity: 200,
        }),
      ],
    }),
    marketDataClient: {
      onQuoteUpdated: (listener) => {
        quoteUpdatedListener = listener;
        return () => {
          if (quoteUpdatedListener === listener) {
            quoteUpdatedListener = null;
          }
        };
      },
      getQuotes: async () =>
        new Map([
          ['HSI.HK', createQuoteDouble('HSI.HK', '20000', 100)],
          ['BULL.HK', createQuoteDouble('BULL.HK', '1', 100)],
          ['BEAR.HK', createQuoteDouble('BEAR.HK', '1', 100)],
        ]),
    },
    monitorContext,
    tradeRuntime: createTradeRuntimeDouble({
      orderExecutor: {
        executeSignals: async (signals) => {
          for (const signal of signals) {
            submittedActions.push(signal.action);
          }

          return {
            executedOrderIds: signals.map(() => `EXECUTED-ORDER`),
            quoteFailures: [],
          };
        },
      },
    }),

    tradingTimeState: { canTrade: true, isHalfDay: false },
    lifecycleState: { isTradingEnabled: true },

    doomsdayProtectionEnabled: false,
    now: () => new Date('2026-04-08T10:00:00+08:00'),
  });

  // baseline 的真实风险数据发布已完成；计数从后续 quote 静态清仓阶段开始。
  refreshUnrealizedCalls = 0;
  return {
    runtime,
    emitQuoteUpdated(event: QuoteUpdatedEvent): void {
      quoteUpdatedListener?.(event);
    },
    submittedActions,
    getClearedOrders: () => clearedOrders,
    getRefreshUnrealizedCalls: () => refreshUnrealizedCalls,
  };
}

async function createDefaultDistanceSwitchHarness(
  params: {
    readonly waitForDistanceResult?: Promise<ReadonlyArray<StartSwitchOnDistanceResult>>;
    readonly waitForLongAdmission?: Promise<true>;
    readonly canTrade?: boolean | null;
    readonly switchFailures?: ReadonlyArray<Error | Promise<Error>>;
    readonly timerHarness?: DistanceSwitchTimerHarness;
    readonly doomsdayProtectionEnabled?: boolean;
    readonly markPendingSwitchBeforeFailure?: boolean;
    readonly termination?: {
      readonly isTerminated: () => boolean;
      readonly reportFatalError: (error: unknown) => void;
    };
    readonly invalidStartedResult?: boolean;
  } = {},
): Promise<
  RuntimeHarness &
    Readonly<{
      startSwitchDirections: ReadonlyArray<'LONG' | 'SHORT'>;
      startSwitchPrices: ReadonlyArray<string | null>;
      replaceLongSeatDuringPrecheck: () => void;
      switchMonitorRouteToStaticMode: () => void;
      switchWakeupHandoffs: ReadonlyArray<{
        readonly direction: 'LONG' | 'SHORT';
        readonly driveResultKind: string;
      }>;
    }>
> {
  let quoteUpdatedListener: ((event: QuoteUpdatedEvent) => void) | null = null;
  const startSwitchDirections: Array<'LONG' | 'SHORT'> = [];
  const startSwitchPrices: Array<string | null> = [];
  const switchFailures = [...(params.switchFailures ?? [])];
  let hasPendingSwitch = false;
  const pendingSwitchDirections = new Set<'LONG' | 'SHORT'>();
  const switchWakeupHandoffs: Array<{
    readonly direction: 'LONG' | 'SHORT';
    readonly driveResultKind: string;
  }> = [];
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
  let publicationManager: ReturnType<typeof createSeatSwitchWorkflow> | null = null;
  const seatSwitch = createSeatSwitchWorkflowDouble({
    hasPendingSwitch: (direction) =>
      hasPendingSwitch ||
      pendingSwitchDirections.has(direction) ||
      publicationManager?.hasPendingSwitch(direction) === true,
    startSwitchOnDistance: async (startParams) => {
      const { direction, monitorPrice, canContinue } = startParams;
      startSwitchDirections.push(direction);
      startSwitchPrices.push(monitorPrice);
      const switchFailure = switchFailures.shift();
      if (switchFailure) {
        const resolvedFailure = await switchFailure;
        if (params.markPendingSwitchBeforeFailure) {
          hasPendingSwitch = true;
        }

        throw resolvedFailure;
      }

      if (params.waitForLongAdmission) {
        if (pendingSwitchDirections.has(direction)) {
          return { started: false, direction, driveResult: { kind: 'NOOP' } };
        }

        if (direction === 'LONG') {
          await params.waitForLongAdmission;
        }

        if (!canContinue()) {
          return { started: false, direction, driveResult: { kind: 'NOOP' } };
        }

        pendingSwitchDirections.add(direction);
      }

      if (params.waitForDistanceResult) {
        const result = await params.waitForDistanceResult;
        return result[0] ?? { started: false, direction, driveResult: { kind: 'NOOP' } };
      }

      if (publicationManager === null)
        throw new Error('Distance publication manager not initialized');

      return publicationManager.startSwitchOnDistance(startParams);
    },
  });
  if (params.invalidStartedResult) {
    Object.defineProperty(seatSwitch, 'startSwitchOnDistance', {
      value: async ({ direction }: { readonly direction: 'LONG' | 'SHORT' }) => ({
        started: true,
        direction,
        driveResult: { kind: 'COMPLETED' },
      }),
    });
  }

  let autoSearchEnabled = true;
  const distanceMonitorConfig = createMonitorConfig({
    monitorSymbol: 'HSI.HK',
    autoSearchConfig: { ...getDefaultAutoSearchConfig(), switchIntervalMinutes: 0 },
    longSymbol: 'BULL.HK',
    shortSymbol: 'BEAR.HK',
  });
  const staticMonitorConfig = {
    ...distanceMonitorConfig,
    autoSearchConfig: {
      ...distanceMonitorConfig.autoSearchConfig,
      autoSearchEnabled: false,
    },
  };
  const distanceMonitorContext = createMonitorContextDouble({
    config: distanceMonitorConfig,
    symbolRegistry,
    seatSwitch,
    riskChecker: createRiskCheckerDouble({
      getWarrantDistanceInfo: (_symbol, _monitorPrice, isLong) =>
        createWarrantDistanceInfoDouble({
          warrantType: isLong ? 'BULL' : 'BEAR',
          distanceNumerator: isLong ? '0.1' : '-0.1',
          distanceDenominator: '100',
        }),
    }),
  });
  const marketDataClient = createMarketDataClientDouble({
    getQuotes: async (symbols) =>
      new Map([...symbols].map((symbol) => [symbol, createQuoteDouble(symbol, '1')])),
  });
  publicationManager = createSeatSwitchWorkflow({
    logger: createLoggerStub(),
    monitorConfig: distanceMonitorConfig,
    symbolRegistry,
    marketDataClient,
    ...createTradeRuntimeDouble({
      orderExecutor: {
        executeSignals: async () => {
          throw new Error('Initial distance admission must not execute signals');
        },
      },
    }),
    riskChecker: distanceMonitorContext.riskChecker,
    orderRecorder: distanceMonitorContext.orderRecorder,
    clock: { now: params.timerHarness?.now ?? (() => new Date('2026-04-08T10:00:00+08:00')) },
    getTradingCalendarSnapshot: () => new Map(),
    candidateSearch: {
      resolveDistanceRange: (direction) =>
        distanceMonitorConfig.autoSearchConfig[
          direction === 'LONG' ? 'switchDistanceRangeBull' : 'switchDistanceRangeBear'
        ],
      findCandidate: async (input) =>
        createWarrantCandidate(input.direction === 'LONG' ? 'NEXT_BULL.HK' : 'NEXT_BEAR.HK'),
    },
  });
  const monitorContext: MonitorContextAssembly = {
    ...distanceMonitorContext,
    get config() {
      return autoSearchEnabled ? distanceMonitorConfig : staticMonitorConfig;
    },
  };
  const runtime = await createDefaultMonitorQuoteEventRuntime({
    snapshot: await createSnapshotFixture({
      account: createAccountSnapshotDouble('100000'),
      positions: [],
    }),
    marketDataClient: {
      onQuoteUpdated: (listener) => {
        quoteUpdatedListener = listener;
        return () => {
          if (quoteUpdatedListener === listener) {
            quoteUpdatedListener = null;
          }
        };
      },
      getQuotes: async () => new Map(),
    },
    monitorContext,
    tradeRuntime: createTradeRuntimeDouble(),

    tradingTimeState: { canTrade: params.canTrade ?? true, isHalfDay: false },
    lifecycleState: { isTradingEnabled: true },

    doomsdayProtectionEnabled: params.doomsdayProtectionEnabled ?? false,
    now: params.timerHarness?.now ?? (() => new Date('2026-04-08T10:00:00+08:00')),
    ...(params.timerHarness
      ? {
          scheduleTimer: params.timerHarness.scheduleTimer,
          clearTimer: params.timerHarness.clearTimer,
        }
      : {}),
    ...(params.termination ? { termination: params.termination } : {}),
    handoffPendingSwitch: (handoffParams) => {
      switchWakeupHandoffs.push({
        direction: handoffParams.direction,
        driveResultKind: handoffParams.driveResult.kind,
      });
    },
  });

  return {
    runtime,
    emitQuoteUpdated(event: QuoteUpdatedEvent): void {
      quoteUpdatedListener?.(event);
    },
    startSwitchDirections,
    startSwitchPrices,
    replaceLongSeatDuringPrecheck: () => {
      symbolRegistry.updateSeatStateWithVersionBump('LONG', {
        symbol: 'BULL-NEXT.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: 1,
        callPrice: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      });
    },
    switchMonitorRouteToStaticMode: () => {
      autoSearchEnabled = false;
    },
    switchWakeupHandoffs,
  };
}

async function createDefaultStaticWaitHarness(
  params: {
    readonly retainFailureCount?: number;
    readonly shouldLiquidateShort?: boolean;
    readonly longQuoteAvailable?: boolean;
    readonly shortQuoteAvailable?: boolean;
    readonly failShortSubmissionOnce?: boolean;
    readonly deferQuoteResponse?: boolean;
    readonly retainError?: Error;
    readonly releaseError?: Error;
    readonly termination?: ReturnType<typeof createTerminationRuntime>;
    readonly retainWork?: () => Promise<void>;
    readonly releaseWork?: () => Promise<void>;
  } = {},
): Promise<
  RuntimeHarness &
    Readonly<{
      getQuoteRequestCount: () => number;
      getRetainCalls: () => ReadonlyArray<ReadonlyArray<string>>;
      getReleaseCalls: () => ReadonlyArray<RetainReleaseCall>;
      getSubmittedActions: () => ReadonlyArray<string>;
      getFatalErrorCount: () => number;
      getFatalErrors: () => ReadonlyArray<unknown>;
      resolveQuoteResponse: () => void;
      setLongQuoteAvailable: (available: boolean) => void;
      switchLongSeatToNextSymbol: () => void;
      switchMonitorRouteToDistanceMode: () => void;
    }>
> {
  let quoteUpdatedListener: ((event: QuoteUpdatedEvent) => void) | null = null;
  const quoteRequests: string[][] = [];
  const retainCalls: string[][] = [];
  const releaseCalls: RetainReleaseCall[] = [];
  const submittedActions: string[] = [];
  let remainingRetainFailures = params.retainFailureCount ?? 0;
  let remainingShortSubmissionFailures = params.failShortSubmissionOnce ? 1 : 0;
  const fatalErrors: unknown[] = [];
  let longQuoteAvailable = params.longQuoteAvailable ?? false;
  const shortQuoteAvailable = params.shortQuoteAvailable ?? false;
  const quoteResponseGate = params.deferQuoteResponse ? createDeferred<true>() : null;
  let routeMode: 'STATIC_LIQUIDATION' | 'DISTANCE_SWITCH' = 'STATIC_LIQUIDATION';
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
  const staticMonitorContext = createMonitorContextDouble({
    config: createMonitorConfig({
      monitorSymbol: 'HSI.HK',
      autoSearchConfig: {
        autoSearchEnabled: false,
        autoSearchMinDistancePctBull: null,
        autoSearchMinDistancePctBear: null,
        autoSearchMinTurnoverPerMinuteBull: null,
        autoSearchMinTurnoverPerMinuteBear: null,
        autoSearchExpiryMinMonths: 3,
        autoSearchOpenDelayMinutes: 5,
        switchIntervalMinutes: 0,
        switchDistanceRangeBull: null,
        switchDistanceRangeBear: null,
      },
      longSymbol: 'BULL.HK',
      shortSymbol: 'BEAR.HK',
    }),
    symbolRegistry,
    riskChecker: createRiskCheckerDouble({
      checkWarrantDistanceLiquidation: (_symbol, isLongSymbol) => ({
        shouldLiquidate: isLongSymbol || (params.shouldLiquidateShort ?? false),
        ...(isLongSymbol || params.shouldLiquidateShort ? { reason: '触发清仓阈值' } : {}),
      }),
    }),
  });
  const distanceMonitorContext = createMonitorContextDouble({
    config: createMonitorConfig({
      monitorSymbol: 'HSI.HK',
      autoSearchConfig: {
        autoSearchEnabled: true,
        autoSearchMinDistancePctBull: null,
        autoSearchMinDistancePctBear: null,
        autoSearchMinTurnoverPerMinuteBull: null,
        autoSearchMinTurnoverPerMinuteBear: null,
        autoSearchExpiryMinMonths: 3,
        autoSearchOpenDelayMinutes: 5,
        switchIntervalMinutes: 0,
        switchDistanceRangeBull: null,
        switchDistanceRangeBear: null,
      },
      longSymbol: 'BULL.HK',
      shortSymbol: 'BEAR.HK',
    }),
    symbolRegistry,
    seatSwitch: createSeatSwitchWorkflowDouble({
      startSwitchOnDistance: async ({ direction }) => ({
        started: false,
        direction,
        driveResult: { kind: 'NOOP' },
      }),
    }),
  });
  const monitorContext: MonitorContextAssembly = {
    ...staticMonitorContext,
    get config() {
      return routeMode === 'STATIC_LIQUIDATION'
        ? staticMonitorContext.config
        : distanceMonitorContext.config;
    },
    get seatSwitch() {
      return routeMode === 'STATIC_LIQUIDATION'
        ? staticMonitorContext.seatSwitch
        : distanceMonitorContext.seatSwitch;
    },
  };
  const runtime = await createDefaultMonitorQuoteEventRuntime({
    snapshot: await createSnapshotFixture({
      account: createAccountSnapshotDouble('100000'),
      positions: [
        createPositionDouble({
          symbol: 'BULL.HK',
          quantity: 200,
          availableQuantity: 200,
        }),
        createPositionDouble({
          symbol: 'BEAR.HK',
          quantity: 300,
          availableQuantity: 300,
        }),
        createPositionDouble({
          symbol: 'NEXT_BULL.HK',
          quantity: 200,
          availableQuantity: 200,
        }),
      ],
    }),
    marketDataClient: {
      onQuoteUpdated: (listener) => {
        quoteUpdatedListener = listener;
        return () => {
          if (quoteUpdatedListener === listener) {
            quoteUpdatedListener = null;
          }
        };
      },
      getQuotes: async (symbols) => {
        quoteRequests.push([...symbols]);
        await quoteResponseGate?.promise;
        return new Map([
          ['HSI.HK', createQuoteDouble('HSI.HK', '20000', 100)],
          ['BULL.HK', longQuoteAvailable ? createQuoteDouble('BULL.HK', '1', 100) : null],
          ['BEAR.HK', shortQuoteAvailable ? createQuoteDouble('BEAR.HK', '1', 100) : null],
        ]);
      },
    },
    monitorContext,
    tradeRuntime: createTradeRuntimeDouble({
      orderExecutor: {
        executeSignals: async (signals) => {
          if (
            signals.some((signal) => signal.action === 'SELLPUT') &&
            remainingShortSubmissionFailures > 0
          ) {
            remainingShortSubmissionFailures -= 1;
            throw new Error('short submission failed');
          }

          submittedActions.push(...signals.map((signal) => signal.action));
          return {
            executedOrderIds: signals.map(
              (_, index) => `ORDER-${submittedActions.length}-${index}`,
            ),
            quoteFailures: [],
          };
        },
      },
    }),

    tradingTimeState: { canTrade: true, isHalfDay: false },
    lifecycleState: { isTradingEnabled: true },

    doomsdayProtectionEnabled: false,
    now: () => new Date('2026-04-08T10:00:00+08:00'),
    termination: params.termination ?? {
      isTerminated: () => false,
      reportFatalError: (error) => {
        fatalErrors.push(error);
      },
    },
    quoteSubscriptionRuntime: {
      retainSymbols: async ({ symbols }) => {
        retainCalls.push([...symbols]);
        await params.retainWork?.();
        if (remainingRetainFailures > 0) {
          remainingRetainFailures -= 1;
          throw params.retainError ?? new Error('retain failed');
        }
      },
      releaseRetain: async ({ ownerKey, reason }) => {
        releaseCalls.push({ ownerKey, reason });
        await params.releaseWork?.();
        if (params.releaseError !== undefined) {
          throw params.releaseError;
        }
      },
    },
  });

  return {
    runtime,
    emitQuoteUpdated(event: QuoteUpdatedEvent): void {
      quoteUpdatedListener?.(event);
    },
    getQuoteRequestCount: () => quoteRequests.length,
    getRetainCalls: () => retainCalls.map((symbols) => [...symbols]),
    getReleaseCalls: () => releaseCalls.map((call) => ({ ...call })),
    getSubmittedActions: () => [...submittedActions],
    getFatalErrorCount: () => fatalErrors.length,
    getFatalErrors: () => [...fatalErrors],
    resolveQuoteResponse(): void {
      quoteResponseGate?.resolve(true);
    },
    setLongQuoteAvailable(available: boolean): void {
      longQuoteAvailable = available;
    },
    switchLongSeatToNextSymbol(): void {
      symbolRegistry.updateSeatState('LONG', {
        symbol: 'NEXT_BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: 1,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      });
    },
    switchMonitorRouteToDistanceMode(): void {
      routeMode = 'DISTANCE_SWITCH';
    },
  };
}

describe('monitorQuoteEventRuntime exports', () => {
  it('exports the public default monitor quote runtime factory', async () => {
    const module =
      await import('../../../src/runtime/monitorQuoteEventRuntime/monitorQuoteEventRuntime.js');

    expect(Object.keys(module)).toEqual(['createDefaultMonitorQuoteEventRuntime']);
  });
});

describe('monitorQuoteEventRuntime contract', () => {
  it('creates default runtime with start and stopAndDrain methods', async () => {
    const harness = await createDefaultDistanceSwitchHarness();

    expect(harness.runtime).toMatchObject({
      start: expect.any(Function),
      stopAndDrain: expect.any(Function),
    });
  });

  it('subscribes on start and unsubscribes on stopAndDrain', async () => {
    let subscribed = 0;
    let unsubscribed = 0;
    const runtime = await createDefaultMonitorQuoteEventRuntime({
      snapshot: await createSnapshotFixture({
        account: createAccountSnapshotDouble('100000'),
        positions: [],
      }),
      marketDataClient: {
        onQuoteUpdated: () => {
          subscribed += 1;
          return () => {
            unsubscribed += 1;
          };
        },
        getQuotes: async () => new Map(),
      },
      monitorContext: createMonitorContextDouble(),
      tradeRuntime: createTradeRuntimeDouble(),

      tradingTimeState: { canTrade: true, isHalfDay: false },
      lifecycleState: { isTradingEnabled: true },

      doomsdayProtectionEnabled: false,
      now: () => new Date('2026-04-08T10:00:00+08:00'),
    });

    runtime.start();
    expect(subscribed).toBe(1);

    await runtime.stopAndDrain();
    expect(unsubscribed).toBe(1);
  });

  it('executes real static liquidation when autoSearch is disabled', async () => {
    const harness = await createDefaultStaticLiquidationHarness();

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());

    await waitTick();
    await harness.runtime.stopAndDrain();
    expect(harness.submittedActions).toEqual(['SELLCALL']);
    expect(harness.getClearedOrders()).toBe(1);
    expect(harness.getRefreshUnrealizedCalls()).toBe(1);
  });

  it('matches only registered static liquidation wakeup symbols', async () => {
    const harness = await createDefaultStaticWaitHarness();

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());

    await waitTick();
    expect(harness.getQuoteRequestCount()).toBe(1);

    harness.emitQuoteUpdated(createQuoteUpdatedEvent('IGNORED.HK', '1'));

    await waitTick();
    expect(harness.getQuoteRequestCount()).toBe(1);

    harness.emitQuoteUpdated(createQuoteUpdatedEvent('BULL.HK', '1'));

    await waitTick();
    expect(harness.getQuoteRequestCount()).toBe(2);

    harness.emitQuoteUpdated(createQuoteUpdatedEvent('BEAR.HK', '1'));

    await waitTick();
    expect(harness.getQuoteRequestCount()).toBe(3);

    await harness.runtime.stopAndDrain();
  });

  it('does not re-retain unchanged static liquidation wakeup symbols', async () => {
    const harness = await createDefaultStaticWaitHarness();

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());

    await waitTick();
    expect(harness.getRetainCalls()).toEqual([['HSI.HK', 'BULL.HK', 'BEAR.HK']]);

    harness.emitQuoteUpdated(createQuoteUpdatedEvent('BULL.HK', '1'));

    await waitTick();
    expect(harness.getRetainCalls()).toEqual([['HSI.HK', 'BULL.HK', 'BEAR.HK']]);

    await harness.runtime.stopAndDrain();
  });

  it('does not resubmit a completed direction while another static liquidation direction is waiting', async () => {
    const harness = await createDefaultStaticWaitHarness({
      shouldLiquidateShort: true,
      shortQuoteAvailable: true,
    });

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());

    await waitTick();
    expect(harness.getSubmittedActions()).toEqual(['SELLPUT']);

    harness.setLongQuoteAvailable(true);
    harness.emitQuoteUpdated(createQuoteUpdatedEvent('BULL.HK', '1'));

    await waitTick();
    expect(harness.getSubmittedActions()).toEqual(['SELLPUT', 'SELLCALL']);

    await harness.runtime.stopAndDrain();
  });

  it('retains a submitted direction when the following direction throws', async () => {
    const harness = await createDefaultStaticWaitHarness({
      shouldLiquidateShort: true,
      longQuoteAvailable: true,
      shortQuoteAvailable: true,
      failShortSubmissionOnce: true,
    });

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());

    await waitTick();
    expect(harness.getSubmittedActions()).toEqual(['SELLCALL']);
    expect(harness.getFatalErrorCount()).toBe(1);

    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());

    await waitTick();
    expect(harness.getSubmittedActions()).toEqual(['SELLCALL', 'SELLPUT']);

    await harness.runtime.stopAndDrain();
  });

  it('retries unchanged static liquidation retain after previous retain failure', async () => {
    const retainError = new Error('retain failed');
    const harness = await createDefaultStaticWaitHarness({
      retainFailureCount: 1,
      retainError,
    });

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());

    await waitTick();
    expect(harness.getRetainCalls()).toEqual([['HSI.HK', 'BULL.HK', 'BEAR.HK']]);
    expect(harness.getFatalErrors()).toEqual([retainError]);

    harness.emitQuoteUpdated(createQuoteUpdatedEvent('BULL.HK', '1'));

    await waitTick();
    expect(harness.getRetainCalls()).toEqual([
      ['HSI.HK', 'BULL.HK', 'BEAR.HK'],
      ['HSI.HK', 'BULL.HK', 'BEAR.HK'],
    ]);

    expect(await harness.runtime.stopAndDrain().catch((error: unknown) => error)).toBeInstanceOf(
      Error,
    );
  });

  it('forwards static liquidation retain release failures to fatal handler', async () => {
    const releaseError = new Error('release failed');
    const harness = await createDefaultStaticWaitHarness({ releaseError });

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());

    await waitTick();
    expect(await harness.runtime.stopAndDrain().catch((error: unknown) => error)).toBe(
      releaseError,
    );
    await waitTick();

    expect(harness.getReleaseCalls()).toEqual([
      { ownerKey: 'HSI.HK', reason: 'STATIC_LIQUIDATION_WAIT' },
    ]);
    expect(harness.getFatalErrors()).toEqual([releaseError]);
  });

  it('releases static liquidation retain owner after failed retain when runtime stops', async () => {
    const harness = await createDefaultStaticWaitHarness({ retainFailureCount: 1 });

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());

    await waitTick();
    expect(await harness.runtime.stopAndDrain().catch((error: unknown) => error)).toBeInstanceOf(
      Error,
    );

    expect(harness.getReleaseCalls()).toEqual([
      { ownerKey: 'HSI.HK', reason: 'STATIC_LIQUIDATION_WAIT' },
    ]);
  });

  it('switches static liquidation wakeup membership when WAIT symbols change', async () => {
    const harness = await createDefaultStaticWaitHarness();

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());

    await waitTick();
    expect(harness.getQuoteRequestCount()).toBe(1);

    harness.switchLongSeatToNextSymbol();
    harness.emitQuoteUpdated(createQuoteUpdatedEvent('BULL.HK', '1'));

    await waitTick();
    expect(harness.getQuoteRequestCount()).toBe(2);

    harness.emitQuoteUpdated(createQuoteUpdatedEvent('BULL.HK', '1'));

    await waitTick();
    expect(harness.getQuoteRequestCount()).toBe(2);

    harness.emitQuoteUpdated(createQuoteUpdatedEvent('NEXT_BULL.HK', '1'));

    await waitTick();
    expect(harness.getQuoteRequestCount()).toBe(3);

    await harness.runtime.stopAndDrain();
  });

  it('clears static liquidation wakeups when route switches to distance mode', async () => {
    const harness = await createDefaultStaticWaitHarness();

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());

    await waitTick();
    expect(harness.getQuoteRequestCount()).toBe(1);

    harness.switchMonitorRouteToDistanceMode();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());

    await waitTick();
    expect(harness.getQuoteRequestCount()).toBe(1);

    harness.emitQuoteUpdated(createQuoteUpdatedEvent('BULL.HK', '1'));

    await waitTick();
    expect(harness.getQuoteRequestCount()).toBe(1);

    await harness.runtime.stopAndDrain();
  });

  it('discards an in-flight static WAIT result after the route switches to distance mode', async () => {
    const harness = await createDefaultStaticWaitHarness({
      deferQuoteResponse: true,
      longQuoteAvailable: true,
    });

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());
    await waitTick();
    expect(harness.getQuoteRequestCount()).toBe(1);

    harness.switchMonitorRouteToDistanceMode();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());
    harness.resolveQuoteResponse();
    await waitTick();
    await waitTick();

    expect(harness.getRetainCalls()).toEqual([]);
    expect(harness.getSubmittedActions()).toEqual([]);

    await harness.runtime.stopAndDrain();
  });

  it('clears static liquidation wakeups after stopAndDrain', async () => {
    const harness = await createDefaultStaticWaitHarness();

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());

    await waitTick();
    expect(harness.getQuoteRequestCount()).toBe(1);

    await harness.runtime.stopAndDrain();
    harness.emitQuoteUpdated(createQuoteUpdatedEvent('BULL.HK', '1'));

    await waitTick();
    expect(harness.getQuoteRequestCount()).toBe(1);
  });

  it('starts distance switch through monitorContext seatSwitch when autoSearch is enabled', async () => {
    const harness = await createDefaultDistanceSwitchHarness();

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());

    await waitTick();
    expect(harness.startSwitchDirections).toEqual(['LONG', 'SHORT']);
    expect(harness.switchWakeupHandoffs).toEqual([
      {
        direction: 'LONG',
        driveResultKind: 'WAIT',
      },
      {
        direction: 'SHORT',
        driveResultKind: 'WAIT',
      },
    ]);

    await harness.runtime.stopAndDrain();
  });

  it('skips distance switch when execution gate is closed', async () => {
    const harness = await createDefaultDistanceSwitchHarness({ canTrade: false });

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());

    await waitTick();
    expect(harness.startSwitchDirections).toEqual([]);
    expect(harness.switchWakeupHandoffs).toEqual([]);

    await harness.runtime.stopAndDrain();
  });

  it('does not hand WAIT distance switch result after stopAndDrain', async () => {
    const deferred = createDeferred<ReadonlyArray<StartSwitchOnDistanceResult>>();
    const harness = await createDefaultDistanceSwitchHarness({
      waitForDistanceResult: deferred.promise,
    });

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());
    const stopPromise = harness.runtime.stopAndDrain();

    await waitTick();
    deferred.resolve([
      {
        started: true,
        direction: 'LONG',
        driveResult: {
          kind: 'WAIT',
          wakeups: [{ kind: 'ORDER_EVENT', symbols: ['BULL.HK'] }],
        },
      },
    ]);
    await stopPromise;

    expect(harness.switchWakeupHandoffs).toEqual([]);
  });

  it('keeps a deferred LONG admission owned while a newer quote drives only the still-unpending SHORT direction', async () => {
    const longAdmission = createDeferred<true>();
    const harness = await createDefaultDistanceSwitchHarness({
      waitForLongAdmission: longAdmission.promise,
    });

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent('100'));
    await waitTick();
    expect(harness.startSwitchDirections).toEqual(['LONG']);

    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent('200'));
    longAdmission.resolve(true);
    await waitTick();
    await waitTick();

    expect(harness.startSwitchDirections).toEqual(['LONG', 'LONG', 'SHORT']);
    expect(harness.startSwitchPrices).toEqual(['100', '200', '200']);
    expect(harness.switchWakeupHandoffs).toEqual([
      { direction: 'LONG', driveResultKind: 'WAIT' },
      { direction: 'SHORT', driveResultKind: 'WAIT' },
    ]);
    await harness.runtime.stopAndDrain();
  });

  it('retries a true external precheck failure and hands off only after a later full distance evaluation', async () => {
    const fatalErrors: unknown[] = [];
    const nowMs = Date.parse('2026-04-08T02:00:00.000Z');
    const timerHarness = createDistanceSwitchTimerHarness(nowMs);
    const precheckError = await createExternalApiRequestError({
      operation: 'AutoSymbolManager.startSwitchOnDistance',
      attempts: 1,
      cause: new Error('candidate query unavailable'),
    });
    const harness = await createDefaultDistanceSwitchHarness({
      switchFailures: [precheckError],
      timerHarness,
      termination: {
        isTerminated: () => false,
        reportFatalError: (error) => {
          fatalErrors.push(error);
        },
      },
    });

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());

    await waitTick();

    expect(fatalErrors).toEqual([]);
    expect(harness.startSwitchDirections).toEqual(['LONG']);
    expect(harness.switchWakeupHandoffs).toEqual([]);
    expect(timerHarness.getPendingTimerAtMs()).toEqual([nowMs + TRADING.INTERVAL_MS]);

    timerHarness.setNow(nowMs + TRADING.INTERVAL_MS);
    timerHarness.fireDueTimers();
    await waitTick();

    expect(harness.startSwitchDirections).toEqual(['LONG', 'LONG', 'SHORT']);
    expect(harness.switchWakeupHandoffs).toEqual([
      { direction: 'LONG', driveResultKind: 'WAIT' },
      { direction: 'SHORT', driveResultKind: 'WAIT' },
    ]);
    expect(timerHarness.getPendingTimerCount()).toBe(0);
    await harness.runtime.stopAndDrain();
  });

  it('allows only one safe external-precheck retry for the current monitor quote', async () => {
    const fatalErrors: unknown[] = [];
    const nowMs = Date.parse('2026-04-08T02:00:00.000Z');
    const timerHarness = createDistanceSwitchTimerHarness(nowMs);
    const firstPrecheckError = await createExternalApiRequestError({
      operation: 'AutoSymbolManager.startSwitchOnDistance',
      attempts: 1,
      cause: new Error('candidate query unavailable'),
    });
    const secondPrecheckError = await createExternalApiRequestError({
      operation: 'AutoSymbolManager.startSwitchOnDistance',
      attempts: 1,
      cause: new Error('candidate query remains unavailable'),
    });
    const harness = await createDefaultDistanceSwitchHarness({
      switchFailures: [firstPrecheckError, secondPrecheckError],
      timerHarness,
      termination: {
        isTerminated: () => false,
        reportFatalError: (error) => {
          fatalErrors.push(error);
        },
      },
    });

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());
    await waitTick();
    expect(timerHarness.getPendingTimerAtMs()).toEqual([nowMs + TRADING.INTERVAL_MS]);

    timerHarness.setNow(nowMs + TRADING.INTERVAL_MS);
    timerHarness.fireDueTimers();
    await waitTick();

    expect(harness.startSwitchDirections).toEqual(['LONG', 'LONG']);
    expect(fatalErrors).toEqual([secondPrecheckError]);
    expect(timerHarness.getPendingTimerCount()).toBe(0);
    await harness.runtime.stopAndDrain();
  });

  it('keeps an external precheck error fatal when the seat symbol and version change while awaiting it', async () => {
    const fatalErrors: unknown[] = [];
    const timerHarness = createDistanceSwitchTimerHarness(Date.parse('2026-04-08T02:00:00.000Z'));
    const delayedPrecheckError = createDeferred<Error>();
    const precheckError = await createExternalApiRequestError({
      operation: 'AutoSymbolManager.startSwitchOnDistance',
      attempts: 1,
      cause: new Error('candidate query unavailable after seat replacement'),
    });
    const harness = await createDefaultDistanceSwitchHarness({
      switchFailures: [delayedPrecheckError.promise],
      timerHarness,
      termination: {
        isTerminated: () => false,
        reportFatalError: (error) => {
          fatalErrors.push(error);
        },
      },
    });

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());
    await waitTick();
    harness.replaceLongSeatDuringPrecheck();
    delayedPrecheckError.resolve(precheckError);
    await waitTick();

    expect(fatalErrors).toEqual([precheckError]);
    expect(timerHarness.getPendingTimerCount()).toBe(0);
    await harness.runtime.stopAndDrain();
  });

  it('keeps ordinary distance-switch errors fatal instead of scheduling a retry', async () => {
    const fatalErrors: unknown[] = [];
    const timerHarness = createDistanceSwitchTimerHarness(Date.parse('2026-04-08T02:00:00.000Z'));
    const routeError = new Error('distance switch route broken');
    const harness = await createDefaultDistanceSwitchHarness({
      switchFailures: [routeError],
      timerHarness,
      termination: {
        isTerminated: () => false,
        reportFatalError: (error) => {
          fatalErrors.push(error);
        },
      },
    });

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());
    await waitTick();

    expect(fatalErrors).toEqual([routeError]);
    expect(timerHarness.getPendingTimerCount()).toBe(0);
    await harness.runtime.stopAndDrain();
  });

  it('keeps TypeError distance-switch failures fatal instead of scheduling a retry', async () => {
    const fatalErrors: unknown[] = [];
    const timerHarness = createDistanceSwitchTimerHarness(Date.parse('2026-04-08T02:00:00.000Z'));
    const routeError = new TypeError('distance switch invariant broken');
    const harness = await createDefaultDistanceSwitchHarness({
      switchFailures: [routeError],
      timerHarness,
      termination: {
        isTerminated: () => false,
        reportFatalError: (error) => {
          fatalErrors.push(error);
        },
      },
    });

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());
    await waitTick();

    expect(fatalErrors).toEqual([routeError]);
    expect(timerHarness.getPendingTimerCount()).toBe(0);
    await harness.runtime.stopAndDrain();
  });

  it('keeps a fake ExternalApiRequestError distance-switch failure fatal', async () => {
    const fatalErrors: unknown[] = [];
    const timerHarness = createDistanceSwitchTimerHarness(Date.parse('2026-04-08T02:00:00.000Z'));
    const routeError = Object.assign(new Error('forged external API error'), {
      name: 'ExternalApiRequestError',
      operation: 'AutoSymbolManager.startSwitchOnDistance',
      attempts: 1,
    });
    const harness = await createDefaultDistanceSwitchHarness({
      switchFailures: [routeError],
      timerHarness,
      termination: {
        isTerminated: () => false,
        reportFatalError: (error) => {
          fatalErrors.push(error);
        },
      },
    });

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());
    await waitTick();

    expect(fatalErrors).toEqual([routeError]);
    expect(timerHarness.getPendingTimerCount()).toBe(0);
    await harness.runtime.stopAndDrain();
  });

  it('keeps a true external distance-switch failure fatal after a pending switch was created', async () => {
    const fatalErrors: unknown[] = [];
    const timerHarness = createDistanceSwitchTimerHarness(Date.parse('2026-04-08T02:00:00.000Z'));
    const routeError = await createExternalApiRequestError({
      operation: 'AutoSymbolManager.startSwitchOnDistance',
      attempts: 1,
      cause: new Error('post-admission state failure'),
    });
    const harness = await createDefaultDistanceSwitchHarness({
      switchFailures: [routeError],
      timerHarness,
      markPendingSwitchBeforeFailure: true,
      termination: {
        isTerminated: () => false,
        reportFatalError: (error) => {
          fatalErrors.push(error);
        },
      },
    });

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());
    await waitTick();

    expect(fatalErrors).toEqual([routeError]);
    expect(timerHarness.getPendingTimerCount()).toBe(0);
    expect(harness.switchWakeupHandoffs).toEqual([]);
    await harness.runtime.stopAndDrain();
  });

  it('grants a new monitor quote its own one-shot external-precheck retry', async () => {
    const initialNowMs = Date.parse('2026-04-08T02:00:00.000Z');
    const latestQuoteNowMs = initialNowMs + 500;
    const timerHarness = createDistanceSwitchTimerHarness(initialNowMs);
    const fatalErrors: unknown[] = [];
    const harness = await createDefaultDistanceSwitchHarness({
      switchFailures: [
        await createExternalApiRequestError({
          operation: 'AutoSymbolManager.startSwitchOnDistance',
          attempts: 1,
          cause: new Error('candidate query unavailable'),
        }),
        await createExternalApiRequestError({
          operation: 'AutoSymbolManager.startSwitchOnDistance',
          attempts: 1,
          cause: new Error('pending-order admission unavailable'),
        }),
      ],
      timerHarness,
      termination: {
        isTerminated: () => false,
        reportFatalError: (error) => {
          fatalErrors.push(error);
        },
      },
    });

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent('20000'));
    await waitTick();
    expect(timerHarness.getPendingTimerAtMs()).toEqual([initialNowMs + TRADING.INTERVAL_MS]);

    timerHarness.setNow(latestQuoteNowMs);
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent('20100'));
    await waitTick();
    expect(timerHarness.getPendingTimerAtMs()).toEqual([latestQuoteNowMs + TRADING.INTERVAL_MS]);

    timerHarness.setNow(initialNowMs + TRADING.INTERVAL_MS);
    timerHarness.fireDueTimers();
    await waitTick();
    expect(harness.startSwitchPrices).toEqual(['20000', '20100']);

    timerHarness.setNow(latestQuoteNowMs + TRADING.INTERVAL_MS);
    timerHarness.fireDueTimers();
    await waitTick();
    expect(harness.startSwitchPrices).toEqual(['20000', '20100', '20100', '20100']);
    expect(fatalErrors).toEqual([]);
    await harness.runtime.stopAndDrain();
  });

  it('cancels an external-precheck retry timer during stopAndDrain', async () => {
    const nowMs = Date.parse('2026-04-08T02:00:00.000Z');
    const timerHarness = createDistanceSwitchTimerHarness(nowMs);
    const harness = await createDefaultDistanceSwitchHarness({
      switchFailures: [
        await createExternalApiRequestError({
          operation: 'AutoSymbolManager.startSwitchOnDistance',
          attempts: 1,
          cause: new Error('candidate query unavailable'),
        }),
      ],
      timerHarness,
    });

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());
    await waitTick();
    expect(timerHarness.getPendingTimerCount()).toBe(1);

    await harness.runtime.stopAndDrain();
    timerHarness.setNow(nowMs + TRADING.INTERVAL_MS);
    timerHarness.fireDueTimers();
    await waitTick();

    expect(harness.startSwitchDirections).toEqual(['LONG']);
    expect(harness.switchWakeupHandoffs).toEqual([]);
    expect(timerHarness.getPendingTimerCount()).toBe(0);
  });

  it('cancels an external-precheck retry timer when the monitor route changes mode', async () => {
    const nowMs = Date.parse('2026-04-08T02:00:00.000Z');
    const timerHarness = createDistanceSwitchTimerHarness(nowMs);
    const harness = await createDefaultDistanceSwitchHarness({
      switchFailures: [
        await createExternalApiRequestError({
          operation: 'AutoSymbolManager.startSwitchOnDistance',
          attempts: 1,
          cause: new Error('candidate query unavailable'),
        }),
      ],
      timerHarness,
    });

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());
    await waitTick();
    expect(timerHarness.getPendingTimerCount()).toBe(1);

    harness.switchMonitorRouteToStaticMode();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());
    await waitTick();
    expect(timerHarness.getPendingTimerAtMs()).toEqual([nowMs + ORDER_QUOTE_RETRY.INTERVAL_MS]);

    timerHarness.setNow(nowMs + TRADING.INTERVAL_MS);
    timerHarness.fireDueTimers();
    await waitTick();

    expect(harness.startSwitchDirections).toEqual(['LONG']);
    await harness.runtime.stopAndDrain();
  });

  it('fails fast when started distance switch does not return WAIT', async () => {
    const fatalErrors: unknown[] = [];
    const harness = await createDefaultDistanceSwitchHarness({
      invalidStartedResult: true,
      termination: {
        isTerminated: () => false,
        reportFatalError: (error) => {
          fatalErrors.push(error);
        },
      },
    });

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());
    await waitTick();

    expect(fatalErrors).toHaveLength(1);
    expect(fatalErrors[0]).toMatchObject({
      message: '[MonitorQuoteEventRuntime] started switch must return WAIT',
    });
    expect(harness.switchWakeupHandoffs).toEqual([]);
    await harness.runtime.stopAndDrain();
  });

  it('still hands off ordinary distance switches at 15:55 when doomsday protection is disabled', async () => {
    const takeoverMs = Date.parse('2026-02-16T07:55:00.000Z');
    const timerHarness = createDistanceSwitchTimerHarness(takeoverMs);
    const harness = await createDefaultDistanceSwitchHarness({
      timerHarness,
      doomsdayProtectionEnabled: false,
    });

    harness.runtime.start();
    harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());
    await waitTick();

    expect(harness.startSwitchDirections).toEqual(['LONG', 'SHORT']);
    expect(harness.switchWakeupHandoffs).toEqual([
      { direction: 'LONG', driveResultKind: 'WAIT' },
      { direction: 'SHORT', driveResultKind: 'WAIT' },
    ]);
    await harness.runtime.stopAndDrain();
  });

  it('does not publish or hand off when doomsday pauses real distance admission before publication', async () => {
    const beforeTakeoverMs = Date.parse('2026-02-16T07:54:59.000Z');
    const takeoverMs = Date.parse('2026-02-16T07:55:00.000Z');
    const timers = createDistanceSwitchTimerHarness(beforeTakeoverMs);
    const h = await createDistanceSwitchPublicationFixture({
      stage: 'BEFORE_PUBLICATION',
      now: timers.now,
      scheduler: { scheduleTimer: timers.scheduleTimer, clearTimer: timers.clearTimer },
    });
    h.receiver.start();
    h.monitor.start();
    h.emit(createMonitorQuoteUpdatedEvent());
    await h.stageReached;
    expect(h.symbolRegistry.getSeatState('LONG').status).toBe('ACTIVE');
    expect(h.symbolRegistry.getSeatVersion('LONG')).toBe(1);
    timers.setNow(takeoverMs);
    h.releaseStage();
    await waitTick();
    await waitTick();
    expect(h.getPublication()).toEqual({
      started: false,
      direction: 'LONG',
      driveResult: { kind: 'NOOP' },
    });
    expect(h.handoffs).toEqual([]);
    expect(h.getCounts().advanceCalls).toBe(0);
    expect(h.getCounts().brokerCalls).toBe(0);
    expect(timers.getPendingTimerCount()).toBe(0);
    await h.stopAndDrain();
    expect(h.getCounts().listeners).toBe(0);
  });

  it('keeps an actual published distance WAIT across purpose pause without renewing mutation authority', async () => {
    const beforeTakeoverMs = Date.parse('2026-02-16T07:54:59.000Z');
    const takeoverMs = Date.parse('2026-02-16T07:55:00.000Z');
    const timers = createDistanceSwitchTimerHarness(beforeTakeoverMs);
    const h = await createDistanceSwitchPublicationFixture({
      stage: 'AFTER_PUBLICATION',
      now: timers.now,
      scheduler: { scheduleTimer: timers.scheduleTimer, clearTimer: timers.clearTimer },
    });
    h.receiver.start();
    h.monitor.start();
    h.emit(createMonitorQuoteUpdatedEvent());
    await h.stageReached;
    const publication = h.getPublication();
    if (
      publication === null ||
      !publication.started ||
      publication.driveResult.publishedRoute === undefined
    )
      throw new Error('Expected actual distance published WAIT');

    expect(h.symbolRegistry.getSeatState('LONG').status).toBe('SWITCHING');
    expect(h.symbolRegistry.getSeatVersion('LONG')).toBe(
      publication.driveResult.publishedRoute.seatVersion,
    );
    expect(publication.driveResult.publishedRoute.isCurrent()).toBe(true);
    expect(
      h.snapshot.isCurrent(h.originalReceipt.snapshotToken, {
        account: true,
        positions: true,
        paired: true,
      }),
    ).toBe(true);
    timers.setNow(takeoverMs);
    h.releaseStage();
    await waitTick();
    await waitTick();
    expect(h.handoffs).toHaveLength(1);
    expect(h.handoffs[0]?.driveResult).toBe(publication.driveResult);
    expect(h.handoffs[0]?.originalDayEpoch).toBe(h.originalDayEpoch);
    expect(publication.driveResult.wakeups).toEqual([
      { kind: 'RETRY_TIMER', atMs: beforeTakeoverMs },
    ]);
    expect(timers.getPendingTimerCount()).toBe(1);
    expect(h.getCounts().retains).toBe(0);
    timers.fireDueTimers();
    await waitTick();
    expect(h.getCounts().advanceCalls).toBe(0);
    expect(h.getCounts().brokerCalls).toBe(0);
    expect(publication.driveResult.publishedRoute.isCurrent()).toBe(true);
    await h.snapshot.requestClear({ reason: 'DAY_CUT', dayEpoch: h.originalDayEpoch + 1 });
    await h.stopAndDrain();
    expect(h.getCounts().listeners).toBe(0);
    expect(timers.getPendingTimerCount()).toBe(0);
    h.receiver.start();
    const originalHandoff = h.handoffs[0];
    if (originalHandoff === undefined) throw new Error('Missing original handoff');

    h.receiver.handoffPendingSwitch(originalHandoff);
    expect(timers.getPendingTimerCount()).toBe(0);
    expect(h.getCounts().advanceCalls).toBe(0);
    expect(h.getCounts().brokerCalls).toBe(0);
    await h.receiver.stopAndDrain();
  });
});

describe('monitor owner drain settlement', () => {
  for (const fatal of [false, true]) {
    it('keeps final cleanup behind owner settlement and preserves the global first fatal', async () => {
      const retainGate = createDeferred<true>();
      const releaseGate = createDeferred<true>();
      const retainError = new Error('retain');
      const firstFatal = new Error('first fatal');
      let stopOwner = (): void => {};
      const termination = createTerminationRuntime({
        closeTradingGate: () => {},
        closeProducerAdmission: () => {},
        stopProducers: [
          () => {
            stopOwner();
          },
        ],
        onSecondaryError: () => {},
      });
      let retainCount = 0;
      const retainWork = async (): Promise<void> => {
        retainCount += 1;
        await retainGate.promise;
        throw retainError;
      };

      const releaseWork = async (): Promise<void> => {
        await releaseGate.promise;
        throw new Error('release');
      };
      const harness = await createDefaultStaticWaitHarness({
        termination,
        retainWork,
        releaseWork,
      });
      stopOwner = () => {
        harness.runtime.stop();
      };
      harness.runtime.start();
      harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());
      await waitTick();
      if (fatal) termination.reportFatalError(firstFatal);
      else termination.requestShutdown();

      let quoteStopped = false;
      const cleanup = (async () => {
        try {
          await harness.runtime.stopAndDrain();
        } finally {
          quoteStopped = true;
        }
      })().catch((error: unknown) => error);
      retainGate.resolve(true);
      await waitTick();
      expect(quoteStopped).toBe(false);
      releaseGate.resolve(true);
      expect(await cleanup).toBe(retainError);
      expect(quoteStopped).toBe(true);
      expect(termination.getFatalState()).toEqual({
        hasFatalError: true,
        error: fatal ? firstFatal : retainError,
      });
      harness.runtime.start();
      harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());
      await waitTick();
      expect(retainCount).toBe(1);
    });
  }

  for (const failure of [new Error('controlled retain failure'), null, undefined]) {
    it('waits for pending release before propagating the original retain rejection', async () => {
      const retainGate = createDeferred<true>();
      const releaseGate = createDeferred<true>();
      let releaseFinished = false;
      let retainStarted = false;
      let releaseStarted = false;
      let failRetain = true;
      const retainWork = async (): Promise<void> => {
        retainStarted = true;
        await retainGate.promise;
        if (failRetain) {
          const originalFailure: unknown = failure;
          throw originalFailure;
        }
      };

      const releaseWork = async (): Promise<void> => {
        releaseStarted = true;
        await releaseGate.promise;
        releaseFinished = true;
      };
      const harness = await createDefaultStaticWaitHarness({ retainWork, releaseWork });
      harness.runtime.start();
      harness.emitQuoteUpdated(createMonitorQuoteUpdatedEvent());
      await waitTick();
      expect(retainStarted).toBe(true);
      const drain = harness.runtime.stopAndDrain();
      expect(harness.runtime.stopAndDrain()).toBe(drain);
      let settled = false;
      const outcome = drain.then(
        () => {
          settled = true;
          return { rejected: false, error: undefined };
        },
        (error: unknown) => {
          settled = true;
          return { rejected: true, error };
        },
      );
      expect(releaseStarted).toBe(true);
      retainGate.resolve(true);
      await waitTick();
      expect(settled).toBe(false);
      expect(releaseFinished).toBe(false);
      releaseGate.resolve(true);
      expect(await outcome).toEqual({ rejected: true, error: failure });
      expect(releaseFinished).toBe(true);
      expect(harness.runtime.stopAndDrain()).toBe(drain);
      failRetain = false;
      harness.runtime.start();
      await harness.runtime.stopAndDrain();
    });
  }
});
