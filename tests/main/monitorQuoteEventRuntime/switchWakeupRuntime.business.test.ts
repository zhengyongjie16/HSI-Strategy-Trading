/**
 * SwitchWakeupRuntime 业务测试
 *
 * 覆盖：
 * - WAIT wakeups 可由 ORDER_EVENT / FRESHNESS / SYMBOL_QUOTE / RETRY_TIMER 继续推进 pending switch
 * - route key 需要按 direction + seatVersion 隔离，并对旧 seatVersion 自然失效
 * - stopAndDrain 后旧事件与旧 timer 不再继续推进
 * - baseline / gate 关闭时事件只唤醒不推进，恢复后再由新事件继续推进
 * - 同一路由使用 single-flight + latest-only collapse
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import {
  createMonitorContextDouble,
  createAutoSymbolManagerDouble,
  createQuoteDouble,
  createSymbolRegistryDouble,
  createTraderDouble,
  createPositionDouble,
} from '../../helpers/testDoubles.js';
import { createMonitorConfig } from '../../../mock/factories/configFactory.js';
import { createSwitchWakeupRuntime } from '../../../src/main/monitorQuoteEventRuntime/switchWakeupRuntime.js';
import { createExternalApiRequestError } from '../../helpers/createExternalApiRequestError.js';
import type {
  AutoSymbolManagerPort,
  SwitchDriveResult,
  SwitchWakeupRequirement,
} from '../../../src/types/monitorContextPorts.js';
import type {
  OrderStateChangedEvent,
  PostTradeConsistencyFreshReachedEvent,
  QuoteUpdatedEvent,
} from '../../../src/types/services.js';
import type { MonitorContext } from '../../../src/types/state.js';
import type { SymbolRegistry } from '../../../src/types/seat.js';
import type { QuoteSubscriptionRuntime } from '../../../src/main/quoteSubscriptionRuntime/types.js';
import type {
  TradingGateEventRuntime,
  TradingGateStateChangedEvent,
} from '../../../src/main/tradingGateEventRuntime/types.js';

function createDeferred<voidValue = void>(): {
  readonly promise: Promise<voidValue>;
  readonly resolve: (value: voidValue) => void;
} {
  let resolve!: (value: voidValue) => void;
  const promise = new Promise<voidValue>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function waitTick(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

type ConsistencyStatus = Readonly<{
  started: boolean;
  currentVersion: number;
  staleVersion: number;
}>;

function createConsistencyHarness(initialStatus: ConsistencyStatus) {
  let status = initialStatus;
  let freshDeferred: ReturnType<typeof createDeferred<void>> | null = null;
  let freshReachedListener: ((event: PostTradeConsistencyFreshReachedEvent) => void) | null = null;

  return {
    port: {
      getStatus: () => status,
      waitForFresh: async () => {
        if (freshDeferred !== null) {
          await freshDeferred.promise;
        }
      },
      onFreshReached: (listener: (event: PostTradeConsistencyFreshReachedEvent) => void) => {
        freshReachedListener = listener;
        return () => {
          if (freshReachedListener === listener) {
            freshReachedListener = null;
          }
        };
      },
    },
    setStatus: (nextStatus: ConsistencyStatus) => {
      status = nextStatus;
    },
    blockFreshWait: () => {
      freshDeferred = createDeferred();
    },
    resolveFreshWait: () => {
      freshDeferred?.resolve();
      freshDeferred = null;
    },
    emitFreshReached: (trigger: PostTradeConsistencyFreshReachedEvent['trigger'] = 'REFRESH') => {
      freshReachedListener?.({
        currentVersion: status.currentVersion,
        staleVersion: status.staleVersion,
        trigger,
      });
    },
  };
}

function createTimerHarness(nowMs: number = 1_000) {
  let currentNowMs = nowMs;
  const timers = new Map<ReturnType<typeof setTimeout>, { atMs: number; callback: () => void }>();

  return {
    now: () => currentNowMs,
    setNow: (nextNowMs: number) => {
      currentNowMs = nextNowMs;
    },
    schedule: (callback: () => void, delayMs: number) => {
      const handle = setTimeout(() => {}, delayMs);
      timers.set(handle, {
        atMs: currentNowMs + delayMs,
        callback,
      });
      return handle;
    },
    clear: (handle: ReturnType<typeof setTimeout>) => {
      clearTimeout(handle);
      timers.delete(handle);
    },
    fireDueTimers: () => {
      const dueTimers = [...timers.entries()].filter(([, timer]) => timer.atMs <= currentNowMs);
      for (const [handle, timer] of dueTimers) {
        clearTimeout(handle);
        timers.delete(handle);
        timer.callback();
      }
    },
    getPendingTimerCount: () => timers.size,
  };
}

function createTradingGateHarness(): Readonly<{
  port: Pick<TradingGateEventRuntime, 'onGateStateChanged'>;
  emit: (event: TradingGateStateChangedEvent) => void;
}> {
  let listener: ((event: TradingGateStateChangedEvent) => void) | null = null;

  return {
    port: {
      onGateStateChanged: (nextListener) => {
        listener = nextListener;
        return () => {
          if (listener === nextListener) {
            listener = null;
          }
        };
      },
    },
    emit: (event) => {
      listener?.(event);
    },
  };
}

describe('switchWakeupRuntime', () => {
  let quoteUpdatedListener: ((event: QuoteUpdatedEvent) => void) | null;
  let orderStateChangedListener: ((event: OrderStateChangedEvent) => void) | null;

  beforeEach(() => {
    quoteUpdatedListener = null;
    orderStateChangedListener = null;
  });

  function createBaseHarness(
    params: {
      readonly monitorContext?: MonitorContext;
      readonly symbolRegistry?: SymbolRegistry;
      readonly lastState?: {
        canTrade: boolean | null;
        isTradingEnabled: boolean;
        isHalfDay: boolean | null;
        cachedPositions: ReturnType<typeof createPositionDouble>[];
      };
      readonly consistencyStatus?: ConsistencyStatus;
      readonly doomsdayProtectionEnabled?: boolean;
      readonly now?: () => Date;
      readonly timerHarness?: ReturnType<typeof createTimerHarness>;
      readonly autoSymbolManager?: AutoSymbolManagerPort;
      readonly quoteSubscriptionRuntime?: Pick<
        QuoteSubscriptionRuntime,
        'retainSymbols' | 'releaseRetain'
      >;
      readonly tradingGateEventRuntime?: Pick<TradingGateEventRuntime, 'onGateStateChanged'>;
      readonly onFatalError?: (error: unknown) => void;
    } = {},
  ): Readonly<{
    runtime: ReturnType<typeof createSwitchWakeupRuntime>;
    symbolRegistry: SymbolRegistry;
    monitorContext: MonitorContext;
    lastState: {
      canTrade: boolean | null;
      isTradingEnabled: boolean;
      isHalfDay: boolean | null;
      cachedPositions: ReturnType<typeof createPositionDouble>[];
    };
    consistencyHarness: ReturnType<typeof createConsistencyHarness>;
    timerHarness: ReturnType<typeof createTimerHarness>;
  }> {
    const symbolRegistry =
      params.symbolRegistry ??
      createSymbolRegistryDouble({
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
        longVersion: 1,
        shortVersion: 1,
      });
    const consistencyHarness = createConsistencyHarness(
      params.consistencyStatus ?? {
        started: true,
        currentVersion: 1,
        staleVersion: 1,
      },
    );
    const timerHarness = params.timerHarness ?? createTimerHarness();
    const lastState = params.lastState ?? {
      canTrade: true,
      isTradingEnabled: true,
      isHalfDay: false,
      cachedPositions: [
        createPositionDouble({ symbol: 'BULL.HK', quantity: 100, availableQuantity: 100 }),
      ],
    };
    const monitorContext =
      params.monitorContext ??
      createMonitorContextDouble({
        config: createMonitorConfig({ monitorSymbol: 'HSI.HK' }),
        symbolRegistry,
        state: {
          monitorSymbol: 'HSI.HK',
          lastMonitorSnapshot: null,
          incrementalIndicatorRuntime: null,
        },
        ...(params.autoSymbolManager ? { autoSymbolManager: params.autoSymbolManager } : {}),
      });
    const trader = createTraderDouble({
      onOrderStateChanged: (listener) => {
        orderStateChangedListener = listener;
        return () => {
          if (orderStateChangedListener === listener) {
            orderStateChangedListener = null;
          }
        };
      },
    });
    const tradingGateEventRuntime = params.tradingGateEventRuntime ?? {
      onGateStateChanged: () => () => {},
    };
    const runtimeDeps = {
      marketDataClient: {
        onQuoteUpdated: (listener: (event: QuoteUpdatedEvent) => void) => {
          quoteUpdatedListener = listener;
          return () => {
            if (quoteUpdatedListener === listener) {
              quoteUpdatedListener = null;
            }
          };
        },
      },
      trader,
      symbolRegistry,
      monitorContext,
      lastState,
      postTradeConsistencyRuntime: consistencyHarness.port,
      tradingGateEventRuntime,
      doomsdayProtectionEnabled: params.doomsdayProtectionEnabled ?? false,
      now:
        params.now ??
        (() => {
          return new Date('2026-04-07T02:00:00.000Z');
        }),
      scheduleTimer: (callback: () => void, delayMs: number) =>
        timerHarness.schedule(callback, delayMs),
      clearTimer: (handle: ReturnType<typeof setTimeout>) => {
        timerHarness.clear(handle);
      },
      ...(params.quoteSubscriptionRuntime
        ? { quoteSubscriptionRuntime: params.quoteSubscriptionRuntime }
        : {}),
      ...(params.onFatalError ? { onFatalError: params.onFatalError } : {}),
    };
    const runtime = createSwitchWakeupRuntime(runtimeDeps);

    return {
      runtime,
      symbolRegistry,
      monitorContext,
      lastState,
      consistencyHarness,
      timerHarness,
    };
  }

  function emitQuoteUpdated(symbol: string, price: number): void {
    quoteUpdatedListener?.({
      symbol,
      quote: createQuoteDouble(symbol, price, 100),
    });
  }

  function emitOrderStateChanged(symbol: string | null): void {
    orderStateChangedListener?.({
      orderId: `order-${symbol}`,
      symbol,
      side: 'BUY',
      source: 'WS',
      status: 'FILLED',
      monitorSymbol: 'HSI.HK',
      isLongSymbol: true,
      isProtectiveLiquidation: false,
      executedPrice: 1,
      executedQuantity: 1,
      executedTimeMs: Date.now(),
    });
  }

  function createWaitResult(
    wakeups: readonly [SwitchWakeupRequirement, ...SwitchWakeupRequirement[]],
  ): Extract<SwitchDriveResult, { kind: 'WAIT' }> {
    return {
      kind: 'WAIT',
      wakeups,
    };
  }

  it('exposes pending switch route errors to fatal handler', async () => {
    const fatalErrors: unknown[] = [];
    const runtimeHarness = createBaseHarness({
      onFatalError: (error) => {
        fatalErrors.push(error);
      },
      autoSymbolManager: {
        maybeSearchOnEvent: async () => {},
        evaluatePeriodicSwitchDue: async () => ({ kind: 'NOOP' }),
        startSwitchOnDistance: async (params) => ({
          started: false,
          direction: params.direction,
          driveResult: { kind: 'NOOP' },
        }),
        advancePendingSwitch: async () => {
          throw await createExternalApiRequestError({
            operation: 'AutoSymbolManager.advancePendingSwitch',
            attempts: 1,
            cause: new Error('switch route broken'),
          });
        },
        hasPendingSwitch: () => true,
        getPeriodicSwitchPendingState: () => ({
          pending: false,
          pendingSinceMs: null,
        }),
        resetAllState: () => {},
      },
    });
    const monitorContext = runtimeHarness.monitorContext;

    runtimeHarness.runtime.start();
    runtimeHarness.runtime.handoffPendingSwitch({
      direction: 'LONG',
      monitorContext,
      driveResult: createWaitResult([{ kind: 'SYMBOL_QUOTE', symbol: 'BULL.HK' }]),
    });

    emitQuoteUpdated('BULL.HK', 1.23);
    await waitTick();
    await waitTick();
    await runtimeHarness.runtime.stopAndDrain();

    expect(fatalErrors).toHaveLength(1);
    expect(fatalErrors[0]).toMatchObject({
      name: 'ExternalApiRequestError',
      operation: 'AutoSymbolManager.advancePendingSwitch',
    });
  });

  it('reports a malformed advance result when the lifecycle gate closes during advance', async () => {
    const fatalErrors: unknown[] = [];
    const advanceStarted = createDeferred();
    const releaseAdvance = createDeferred();
    let advanceCalls = 0;
    const runtimeHarness = createBaseHarness({
      onFatalError: (error) => {
        fatalErrors.push(error);
      },
      autoSymbolManager: {
        maybeSearchOnEvent: async () => {},
        evaluatePeriodicSwitchDue: async () => ({ kind: 'NOOP' }),
        startSwitchOnDistance: async (params) => ({
          started: false,
          direction: params.direction,
          driveResult: { kind: 'NOOP' },
        }),
        advancePendingSwitch: async () => {
          advanceCalls += 1;
          advanceStarted.resolve();
          await releaseAdvance.promise;

          return {
            advanced: true,
            direction: 'SHORT',
            stillPending: true,
            driveResult: createWaitResult([
              { kind: 'RETRY_TIMER', atMs: 1_100 },
              { kind: 'SYMBOL_QUOTE', symbol: 'NEXT.HK' },
            ]),
          };
        },
        hasPendingSwitch: () => true,
        getPeriodicSwitchPendingState: () => ({
          pending: false,
          pendingSinceMs: null,
        }),
        resetAllState: () => {},
      },
    });

    runtimeHarness.runtime.start();
    runtimeHarness.runtime.handoffPendingSwitch({
      direction: 'LONG',
      monitorContext: runtimeHarness.monitorContext,
      driveResult: createWaitResult([{ kind: 'FRESHNESS' }]),
    });
    runtimeHarness.consistencyHarness.emitFreshReached();
    await advanceStarted.promise;

    runtimeHarness.lastState.isTradingEnabled = false;
    releaseAdvance.resolve();
    await waitTick();
    await waitTick();

    expect(fatalErrors).toEqual([
      expect.objectContaining({
        message: '[SwitchWakeupRuntime] advance result direction mismatch',
      }),
    ]);
    expect(runtimeHarness.timerHarness.getPendingTimerCount()).toBe(0);

    runtimeHarness.lastState.isTradingEnabled = true;
    emitQuoteUpdated('NEXT.HK', 1.23);
    await waitTick();

    expect(advanceCalls).toBe(1);
    await runtimeHarness.runtime.stopAndDrain();
  });

  it('re-drives the same pending switch on order, freshness, quote and retry-timer wakeups', async () => {
    const advanceCalls: Array<{
      direction: 'LONG' | 'SHORT';
      positionQuantities: ReadonlyArray<number>;
    }> = [];
    const timerHarness = createTimerHarness(10_000);
    const runtimeHarness = createBaseHarness({
      timerHarness,
      autoSymbolManager: {
        maybeSearchOnEvent: async () => {},
        evaluatePeriodicSwitchDue: async () => ({ kind: 'NOOP' }),
        startSwitchOnDistance: async (params) => ({
          started: false,
          direction: params.direction,
          driveResult: { kind: 'NOOP' },
        }),
        advancePendingSwitch: async (params) => {
          advanceCalls.push({
            direction: params.direction,
            positionQuantities: params.positions.map(
              (position: { readonly quantity: number }) => position.quantity,
            ),
          });

          switch (advanceCalls.length) {
            case 1: {
              return {
                advanced: true,
                direction: params.direction,
                stillPending: true,
                driveResult: createWaitResult([{ kind: 'FRESHNESS' }]),
              };
            }

            case 2: {
              return {
                advanced: true,
                direction: params.direction,
                stillPending: true,
                driveResult: createWaitResult([{ kind: 'SYMBOL_QUOTE', symbol: 'BULL.HK' }]),
              };
            }

            case 3: {
              return {
                advanced: true,
                direction: params.direction,
                stillPending: true,
                driveResult: createWaitResult([
                  { kind: 'RETRY_TIMER', atMs: 10_100 },
                  { kind: 'SYMBOL_QUOTE', symbol: 'BULL.HK' },
                ]),
              };
            }

            default: {
              return {
                advanced: true,
                direction: params.direction,
                stillPending: false,
                driveResult: { kind: 'COMPLETED' },
              };
            }
          }
        },
        hasPendingSwitch: () => true,
        getPeriodicSwitchPendingState: () => ({
          pending: false,
          pendingSinceMs: null,
        }),
        resetAllState: () => {},
      },
    });
    const firstMonitorContext = runtimeHarness.monitorContext;

    runtimeHarness.runtime.start();
    runtimeHarness.runtime.handoffPendingSwitch({
      direction: 'LONG',
      monitorContext: firstMonitorContext,
      driveResult: createWaitResult([{ kind: 'ORDER_EVENT', symbols: ['BULL.HK'] }]),
    });

    emitOrderStateChanged('OTHER.HK');
    await waitTick();
    expect(advanceCalls).toHaveLength(0);

    runtimeHarness.lastState.cachedPositions = [
      createPositionDouble({ symbol: 'BULL.HK', quantity: 1, availableQuantity: 1 }),
    ];

    runtimeHarness.lastState.cachedPositions = [
      createPositionDouble({ symbol: 'BULL.HK', quantity: 200, availableQuantity: 200 }),
    ];
    emitOrderStateChanged('BULL.HK');
    await waitTick();

    runtimeHarness.lastState.cachedPositions = [
      createPositionDouble({ symbol: 'BULL.HK', quantity: 300, availableQuantity: 300 }),
    ];
    runtimeHarness.consistencyHarness.emitFreshReached();
    await waitTick();

    emitQuoteUpdated('OTHER.HK', 1.2);
    await waitTick();
    expect(advanceCalls).toHaveLength(2);

    runtimeHarness.lastState.cachedPositions = [
      createPositionDouble({ symbol: 'BULL.HK', quantity: 400, availableQuantity: 400 }),
    ];
    emitQuoteUpdated('BULL.HK', 1.23);
    await waitTick();

    runtimeHarness.lastState.cachedPositions = [
      createPositionDouble({ symbol: 'BULL.HK', quantity: 500, availableQuantity: 500 }),
    ];
    timerHarness.setNow(10_100);
    timerHarness.fireDueTimers();
    await waitTick();

    expect(advanceCalls).toEqual([
      {
        direction: 'LONG',
        positionQuantities: [200],
      },
      {
        direction: 'LONG',
        positionQuantities: [300],
      },
      {
        direction: 'LONG',
        positionQuantities: [400],
      },
      {
        direction: 'LONG',
        positionQuantities: [500],
      },
    ]);
    expect(timerHarness.getPendingTimerCount()).toBe(0);

    await runtimeHarness.runtime.stopAndDrain();
  });

  it('naturally invalidates old seatVersion registrations before and after freshness wait', async () => {
    const advanceCalls: number[] = [];
    const symbolRegistry = createSymbolRegistryDouble({
      longVersion: 1,
      shortVersion: 1,
    });
    const consistencyHarness = createConsistencyHarness({
      started: true,
      currentVersion: 1,
      staleVersion: 2,
    });
    const tradingGateHarness = createTradingGateHarness();
    consistencyHarness.blockFreshWait();
    const monitorContext = createMonitorContextDouble({
      config: createMonitorConfig({ monitorSymbol: 'HSI.HK' }),
      symbolRegistry,
      autoSymbolManager: {
        maybeSearchOnEvent: async () => {},
        evaluatePeriodicSwitchDue: async () => ({ kind: 'NOOP' }),
        startSwitchOnDistance: async (params) => ({
          started: false,
          direction: params.direction,
          driveResult: { kind: 'NOOP' },
        }),
        advancePendingSwitch: async (params) => {
          advanceCalls.push(symbolRegistry.getSeatVersion(params.direction));
          return {
            advanced: true,
            direction: params.direction,
            stillPending: false,
            driveResult: { kind: 'COMPLETED' },
          };
        },
        hasPendingSwitch: () => true,
        getPeriodicSwitchPendingState: () => ({
          pending: false,
          pendingSinceMs: null,
        }),
        resetAllState: () => {},
      },
    });
    const runtime = createSwitchWakeupRuntime({
      marketDataClient: {
        onQuoteUpdated: (listener) => {
          quoteUpdatedListener = listener;
          return () => {
            if (quoteUpdatedListener === listener) {
              quoteUpdatedListener = null;
            }
          };
        },
      },
      trader: createTraderDouble({
        onOrderStateChanged: (listener) => {
          orderStateChangedListener = listener;
          return () => {
            if (orderStateChangedListener === listener) {
              orderStateChangedListener = null;
            }
          };
        },
      }),
      symbolRegistry,
      monitorContext,
      lastState: {
        canTrade: true,
        isTradingEnabled: true,
        isHalfDay: false,
        cachedPositions: [],
      },
      postTradeConsistencyRuntime: consistencyHarness.port,
      tradingGateEventRuntime: tradingGateHarness.port,
      doomsdayProtectionEnabled: false,
      now: () => new Date('2026-04-07T02:00:00.000Z'),
      scheduleTimer: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimer: (handle) => {
        clearTimeout(handle);
      },
    });

    runtime.start();
    runtime.handoffPendingSwitch({
      direction: 'LONG',
      monitorContext,
      driveResult: createWaitResult([{ kind: 'ORDER_EVENT', symbols: ['BULL.HK'] }]),
    });

    symbolRegistry.updateSeatStateWithVersionBump('LONG', {
      ...symbolRegistry.getSeatState('LONG'),
      lastSeatActivatedAt: 1,
    });
    emitOrderStateChanged('BULL.HK');
    await waitTick();
    expect(advanceCalls).toEqual([]);

    runtime.handoffPendingSwitch({
      direction: 'LONG',
      monitorContext,
      driveResult: createWaitResult([{ kind: 'FRESHNESS' }]),
    });

    runtime.handoffPendingSwitch({
      direction: 'LONG',
      monitorContext,
      driveResult: createWaitResult([{ kind: 'FRESHNESS' }]),
    });

    runtime.handoffPendingSwitch({
      direction: 'LONG',
      monitorContext,
      driveResult: createWaitResult([{ kind: 'ORDER_EVENT', symbols: ['BULL.HK'] }]),
    });
    emitOrderStateChanged('BULL.HK');
    await waitTick();

    symbolRegistry.updateSeatStateWithVersionBump('LONG', {
      ...symbolRegistry.getSeatState('LONG'),
      lastSeatActivatedAt: 1,
    });

    consistencyHarness.setStatus({
      started: true,
      currentVersion: 2,
      staleVersion: 2,
    });
    consistencyHarness.resolveFreshWait();
    await waitTick();

    expect(advanceCalls).toEqual([]);
    await runtime.stopAndDrain();
  });

  it('deletes the route when pending switch is cleared before a wakeup is handled', async () => {
    let advanceCalls = 0;
    let pendingSwitchActive = true;
    const runtimeHarness = createBaseHarness({
      autoSymbolManager: {
        maybeSearchOnEvent: async () => {},
        evaluatePeriodicSwitchDue: async () => ({ kind: 'NOOP' }),
        startSwitchOnDistance: async (params) => ({
          started: false,
          direction: params.direction,
          driveResult: { kind: 'NOOP' },
        }),
        advancePendingSwitch: async (params) => {
          advanceCalls += 1;
          return {
            advanced: true,
            direction: params.direction,
            stillPending: false,
            driveResult: { kind: 'COMPLETED' },
          };
        },
        hasPendingSwitch: () => pendingSwitchActive,
        getPeriodicSwitchPendingState: () => ({
          pending: false,
          pendingSinceMs: null,
        }),
        resetAllState: () => {},
      },
    });
    const monitorContext = runtimeHarness.monitorContext;

    runtimeHarness.runtime.start();
    runtimeHarness.runtime.handoffPendingSwitch({
      direction: 'LONG',
      monitorContext,
      driveResult: createWaitResult([{ kind: 'SYMBOL_QUOTE', symbol: 'BULL.HK' }]),
    });

    pendingSwitchActive = false;
    emitQuoteUpdated('BULL.HK', 1.1);
    await waitTick();

    pendingSwitchActive = true;
    emitQuoteUpdated('BULL.HK', 1.2);
    await waitTick();

    expect(advanceCalls).toBe(0);
    await runtimeHarness.runtime.stopAndDrain();
  });

  it('deletes the route when pending switch is cleared during freshness wait', async () => {
    let advanceCalls = 0;
    let pendingSwitchActive = true;
    const runtimeHarness = createBaseHarness({
      autoSymbolManager: {
        maybeSearchOnEvent: async () => {},
        evaluatePeriodicSwitchDue: async () => ({ kind: 'NOOP' }),
        startSwitchOnDistance: async (params) => ({
          started: false,
          direction: params.direction,
          driveResult: { kind: 'NOOP' },
        }),
        advancePendingSwitch: async (params) => {
          advanceCalls += 1;
          return {
            advanced: true,
            direction: params.direction,
            stillPending: false,
            driveResult: { kind: 'COMPLETED' },
          };
        },
        hasPendingSwitch: () => pendingSwitchActive,
        getPeriodicSwitchPendingState: () => ({
          pending: false,
          pendingSinceMs: null,
        }),
        resetAllState: () => {},
      },
    });
    const monitorContext = runtimeHarness.monitorContext;

    runtimeHarness.consistencyHarness.blockFreshWait();
    runtimeHarness.runtime.start();
    runtimeHarness.runtime.handoffPendingSwitch({
      direction: 'LONG',
      monitorContext,
      driveResult: createWaitResult([{ kind: 'FRESHNESS' }]),
    });

    runtimeHarness.consistencyHarness.emitFreshReached();
    await waitTick();

    pendingSwitchActive = false;
    runtimeHarness.consistencyHarness.resolveFreshWait();
    await waitTick();
    await waitTick();

    pendingSwitchActive = true;
    runtimeHarness.consistencyHarness.emitFreshReached();
    await waitTick();

    expect(advanceCalls).toBe(0);
    await runtimeHarness.runtime.stopAndDrain();
  });

  it('re-drives the route after quote retain resolves for the current route', async () => {
    const retainDeferred = createDeferred<() => void>();
    let advanceCalls = 0;
    const runtimeHarness = createBaseHarness({
      quoteSubscriptionRuntime: {
        retainSymbols: async () => await retainDeferred.promise,
        releaseRetain: async () => {},
      },
      autoSymbolManager: {
        maybeSearchOnEvent: async () => {},
        evaluatePeriodicSwitchDue: async () => ({ kind: 'NOOP' }),
        startSwitchOnDistance: async (params) => ({
          started: false,
          direction: params.direction,
          driveResult: { kind: 'NOOP' },
        }),
        advancePendingSwitch: async (params) => {
          advanceCalls += 1;
          return {
            advanced: true,
            direction: params.direction,
            stillPending: true,
            driveResult: createWaitResult([{ kind: 'SYMBOL_QUOTE', symbol: 'BULL.HK' }]),
          };
        },
        hasPendingSwitch: () => true,
        getPeriodicSwitchPendingState: () => ({
          pending: false,
          pendingSinceMs: null,
        }),
        resetAllState: () => {},
      },
    });
    const monitorContext = runtimeHarness.monitorContext;

    runtimeHarness.runtime.start();
    runtimeHarness.runtime.handoffPendingSwitch({
      direction: 'LONG',
      monitorContext,
      driveResult: createWaitResult([{ kind: 'SYMBOL_QUOTE', symbol: 'BULL.HK' }]),
    });

    await waitTick();
    expect(advanceCalls).toBe(0);

    retainDeferred.resolve(() => {});
    await waitTick();
    await waitTick();

    expect(advanceCalls).toBe(1);
    await runtimeHarness.runtime.stopAndDrain();
  });

  it('does not re-drive a stale route when quote retain resolves after seatVersion changes', async () => {
    const retainDeferred = createDeferred<() => void>();
    let advanceCalls = 0;
    const symbolRegistry = createSymbolRegistryDouble({ longVersion: 1, shortVersion: 1 });
    const runtimeHarness = createBaseHarness({
      symbolRegistry,
      quoteSubscriptionRuntime: {
        retainSymbols: async () => await retainDeferred.promise,
        releaseRetain: async () => {},
      },
      autoSymbolManager: {
        maybeSearchOnEvent: async () => {},
        evaluatePeriodicSwitchDue: async () => ({ kind: 'NOOP' }),
        startSwitchOnDistance: async (params) => ({
          started: false,
          direction: params.direction,
          driveResult: { kind: 'NOOP' },
        }),
        advancePendingSwitch: async (params) => {
          advanceCalls += 1;
          return {
            advanced: true,
            direction: params.direction,
            stillPending: true,
            driveResult: createWaitResult([{ kind: 'SYMBOL_QUOTE', symbol: 'BULL.HK' }]),
          };
        },
        hasPendingSwitch: () => true,
        getPeriodicSwitchPendingState: () => ({
          pending: false,
          pendingSinceMs: null,
        }),
        resetAllState: () => {},
      },
    });
    const monitorContext = runtimeHarness.monitorContext;

    runtimeHarness.runtime.start();
    runtimeHarness.runtime.handoffPendingSwitch({
      direction: 'LONG',
      monitorContext,
      driveResult: createWaitResult([{ kind: 'SYMBOL_QUOTE', symbol: 'BULL.HK' }]),
    });

    await waitTick();
    expect(advanceCalls).toBe(0);

    symbolRegistry.updateSeatStateWithVersionBump('LONG', {
      ...symbolRegistry.getSeatState('LONG'),
      lastSeatActivatedAt: 1,
    });
    retainDeferred.resolve(() => {});
    await waitTick();
    await waitTick();

    expect(advanceCalls).toBe(0);
    await runtimeHarness.runtime.stopAndDrain();
  });

  it('ignores an outdated retain promise after WAIT quote symbols change on the same route', async () => {
    const bullRetainDeferred = createDeferred<() => void>();
    const bearRetainDeferred = createDeferred<() => void>();
    const retainCalls: string[] = [];
    let advanceCalls = 0;
    const runtimeHarness = createBaseHarness({
      quoteSubscriptionRuntime: {
        retainSymbols: async ({ symbols }) => {
          const [symbol] = [...symbols];
          if (symbol === undefined) {
            throw new Error('expected retain symbol');
          }

          retainCalls.push(symbol);
          if (symbol === 'BULL.HK') {
            return await bullRetainDeferred.promise;
          }

          if (symbol === 'BEAR.HK') {
            return await bearRetainDeferred.promise;
          }

          throw new Error(`unexpected retain symbol: ${symbol}`);
        },
        releaseRetain: async () => {},
      },
      autoSymbolManager: {
        maybeSearchOnEvent: async () => {},
        evaluatePeriodicSwitchDue: async () => ({ kind: 'NOOP' }),
        startSwitchOnDistance: async (params) => ({
          started: false,
          direction: params.direction,
          driveResult: { kind: 'NOOP' },
        }),
        advancePendingSwitch: async (params) => {
          advanceCalls += 1;
          return {
            advanced: true,
            direction: params.direction,
            stillPending: true,
            driveResult: createWaitResult([{ kind: 'SYMBOL_QUOTE', symbol: 'BEAR.HK' }]),
          };
        },
        hasPendingSwitch: () => true,
        getPeriodicSwitchPendingState: () => ({
          pending: false,
          pendingSinceMs: null,
        }),
        resetAllState: () => {},
      },
    });
    const monitorContext = runtimeHarness.monitorContext;

    runtimeHarness.runtime.start();
    runtimeHarness.runtime.handoffPendingSwitch({
      direction: 'LONG',
      monitorContext,
      driveResult: createWaitResult([{ kind: 'SYMBOL_QUOTE', symbol: 'BULL.HK' }]),
    });

    runtimeHarness.runtime.handoffPendingSwitch({
      direction: 'LONG',
      monitorContext,
      driveResult: createWaitResult([{ kind: 'SYMBOL_QUOTE', symbol: 'BEAR.HK' }]),
    });

    expect(retainCalls).toEqual(['BULL.HK', 'BEAR.HK']);

    bullRetainDeferred.resolve(() => {});
    await waitTick();
    await waitTick();
    expect(advanceCalls).toBe(0);

    bearRetainDeferred.resolve(() => {});
    await waitTick();
    await waitTick();
    expect(advanceCalls).toBe(1);
    await runtimeHarness.runtime.stopAndDrain();
  });

  it('retries unchanged switch quote retain after previous retain failure', async () => {
    const retainCalls: ReadonlyArray<string>[] = [];
    let remainingRetainFailures = 1;
    const runtimeHarness = createBaseHarness({
      quoteSubscriptionRuntime: {
        retainSymbols: async ({ symbols }) => {
          retainCalls.push([...symbols]);
          if (remainingRetainFailures > 0) {
            remainingRetainFailures -= 1;
            throw new Error('retain failed');
          }

          return () => {};
        },
        releaseRetain: async () => {},
      },
      autoSymbolManager: {
        maybeSearchOnEvent: async () => {},
        evaluatePeriodicSwitchDue: async () => ({ kind: 'NOOP' }),
        startSwitchOnDistance: async (params) => ({
          started: false,
          direction: params.direction,
          driveResult: { kind: 'NOOP' },
        }),
        advancePendingSwitch: async (params) => ({
          advanced: true,
          direction: params.direction,
          stillPending: true,
          driveResult: createWaitResult([{ kind: 'SYMBOL_QUOTE', symbol: 'BULL.HK' }]),
        }),
        hasPendingSwitch: () => true,
        getPeriodicSwitchPendingState: () => ({
          pending: false,
          pendingSinceMs: null,
        }),
        resetAllState: () => {},
      },
    });
    const monitorContext = runtimeHarness.monitorContext;

    runtimeHarness.runtime.start();
    runtimeHarness.runtime.handoffPendingSwitch({
      direction: 'LONG',
      monitorContext,
      driveResult: createWaitResult([{ kind: 'SYMBOL_QUOTE', symbol: 'BULL.HK' }]),
    });

    await waitTick();
    expect(retainCalls).toEqual([['BULL.HK']]);

    emitQuoteUpdated('BULL.HK', 1.1);
    await waitTick();

    expect(retainCalls).toEqual([['BULL.HK'], ['BULL.HK']]);
    await runtimeHarness.runtime.stopAndDrain();
  });

  it('releases switch quote retain owner after failed retain when runtime stops', async () => {
    const releaseCalls: Array<{ readonly ownerKey: string; readonly reason: string }> = [];
    const runtimeHarness = createBaseHarness({
      quoteSubscriptionRuntime: {
        retainSymbols: async () => {
          throw new Error('retain failed');
        },
        releaseRetain: async ({ ownerKey, reason }) => {
          releaseCalls.push({ ownerKey, reason });
        },
      },
    });
    const monitorContext = runtimeHarness.monitorContext;

    runtimeHarness.runtime.start();
    runtimeHarness.runtime.handoffPendingSwitch({
      direction: 'LONG',
      monitorContext,
      driveResult: createWaitResult([{ kind: 'SYMBOL_QUOTE', symbol: 'BULL.HK' }]),
    });

    await waitTick();
    await runtimeHarness.runtime.stopAndDrain();

    expect(releaseCalls).toEqual([{ ownerKey: 'LONG:1', reason: 'SWITCH_WAKEUP' }]);
  });

  it('switches symbol quote wakeup membership when WAIT wakeups change', async () => {
    const advanceCalls: string[] = [];
    const runtimeHarness = createBaseHarness({
      autoSymbolManager: {
        maybeSearchOnEvent: async () => {},
        evaluatePeriodicSwitchDue: async () => ({ kind: 'NOOP' }),
        startSwitchOnDistance: async (params) => ({
          started: false,
          direction: params.direction,
          driveResult: { kind: 'NOOP' },
        }),
        advancePendingSwitch: async (params) => {
          advanceCalls[advanceCalls.length] = params.direction;
          if (advanceCalls.length === 1) {
            return {
              advanced: true,
              direction: params.direction,
              stillPending: true,
              driveResult: createWaitResult([{ kind: 'SYMBOL_QUOTE', symbol: 'BEAR.HK' }]),
            };
          }

          return {
            advanced: true,
            direction: params.direction,
            stillPending: false,
            driveResult: { kind: 'COMPLETED' },
          };
        },
        hasPendingSwitch: () => true,
        getPeriodicSwitchPendingState: () => ({
          pending: false,
          pendingSinceMs: null,
        }),
        resetAllState: () => {},
      },
    });
    const monitorContext = runtimeHarness.monitorContext;

    runtimeHarness.runtime.start();
    runtimeHarness.runtime.handoffPendingSwitch({
      direction: 'LONG',
      monitorContext,
      driveResult: createWaitResult([{ kind: 'SYMBOL_QUOTE', symbol: 'BULL.HK' }]),
    });

    emitQuoteUpdated('BULL.HK', 1.1);
    await waitTick();
    emitQuoteUpdated('BULL.HK', 1.2);
    await waitTick();
    emitQuoteUpdated('BEAR.HK', 1.3);
    await waitTick();

    expect(advanceCalls).toEqual(['LONG', 'LONG']);
    await runtimeHarness.runtime.stopAndDrain();
  });

  it('removes old order event wakeup membership when WAIT wakeups change', async () => {
    const advanceCalls: string[] = [];
    const runtimeHarness = createBaseHarness({
      autoSymbolManager: {
        maybeSearchOnEvent: async () => {},
        evaluatePeriodicSwitchDue: async () => ({ kind: 'NOOP' }),
        startSwitchOnDistance: async (params) => ({
          started: false,
          direction: params.direction,
          driveResult: { kind: 'NOOP' },
        }),
        advancePendingSwitch: async (params) => {
          advanceCalls[advanceCalls.length] = params.direction;
          if (advanceCalls.length === 1) {
            return {
              advanced: true,
              direction: params.direction,
              stillPending: true,
              driveResult: createWaitResult([{ kind: 'ORDER_EVENT', symbols: ['BEAR.HK'] }]),
            };
          }

          return {
            advanced: true,
            direction: params.direction,
            stillPending: false,
            driveResult: { kind: 'COMPLETED' },
          };
        },
        hasPendingSwitch: () => true,
        getPeriodicSwitchPendingState: () => ({
          pending: false,
          pendingSinceMs: null,
        }),
        resetAllState: () => {},
      },
    });
    const monitorContext = runtimeHarness.monitorContext;

    runtimeHarness.runtime.start();
    runtimeHarness.runtime.handoffPendingSwitch({
      direction: 'LONG',
      monitorContext,
      driveResult: createWaitResult([{ kind: 'ORDER_EVENT', symbols: ['BULL.HK'] }]),
    });

    emitOrderStateChanged('BULL.HK');
    await waitTick();
    emitOrderStateChanged('BULL.HK');
    await waitTick();
    emitOrderStateChanged('BEAR.HK');
    await waitTick();

    expect(advanceCalls).toEqual(['LONG', 'LONG']);
    await runtimeHarness.runtime.stopAndDrain();
  });

  it('ignores order events without a symbol', async () => {
    let advanceCalls = 0;
    const runtimeHarness = createBaseHarness({
      autoSymbolManager: {
        maybeSearchOnEvent: async () => {},
        evaluatePeriodicSwitchDue: async () => ({ kind: 'NOOP' }),
        startSwitchOnDistance: async (params) => ({
          started: false,
          direction: params.direction,
          driveResult: { kind: 'NOOP' },
        }),
        advancePendingSwitch: async (params) => {
          advanceCalls += 1;
          return {
            advanced: true,
            direction: params.direction,
            stillPending: false,
            driveResult: { kind: 'COMPLETED' },
          };
        },
        hasPendingSwitch: () => true,
        getPeriodicSwitchPendingState: () => ({
          pending: false,
          pendingSinceMs: null,
        }),
        resetAllState: () => {},
      },
    });
    const monitorContext = runtimeHarness.monitorContext;

    runtimeHarness.runtime.start();
    runtimeHarness.runtime.handoffPendingSwitch({
      direction: 'LONG',
      monitorContext,
      driveResult: createWaitResult([{ kind: 'ORDER_EVENT', symbols: ['BULL.HK'] }]),
    });

    emitOrderStateChanged(null);
    await waitTick();

    expect(advanceCalls).toBe(0);
    await runtimeHarness.runtime.stopAndDrain();
  });

  it('fails fast when handoff monitorContext identity does not match the unique context', async () => {
    const runtimeHarness = createBaseHarness();
    const detachedMonitorContext = createMonitorContextDouble({
      config: createMonitorConfig({ monitorSymbol: 'HSI.HK' }),
      symbolRegistry: runtimeHarness.symbolRegistry,
    });

    runtimeHarness.runtime.start();

    expect(() => {
      runtimeHarness.runtime.handoffPendingSwitch({
        direction: 'LONG',
        monitorContext: detachedMonitorContext,
        driveResult: createWaitResult([{ kind: 'SYMBOL_QUOTE', symbol: 'BULL.HK' }]),
      });
    }).toThrow('[SwitchWakeupRuntime] handoff monitorContext identity mismatch');

    await runtimeHarness.runtime.stopAndDrain();
  });

  it('fails fast on empty WAIT handoff before replacing a valid route owner', async () => {
    let advanceCalls = 0;
    const runtimeHarness = createBaseHarness({
      autoSymbolManager: {
        maybeSearchOnEvent: async () => {},
        evaluatePeriodicSwitchDue: async () => ({ kind: 'NOOP' }),
        startSwitchOnDistance: async (params) => ({
          started: false,
          direction: params.direction,
          driveResult: { kind: 'NOOP' },
        }),
        advancePendingSwitch: async (params) => {
          advanceCalls += 1;
          return {
            advanced: true,
            direction: params.direction,
            stillPending: false,
            driveResult: { kind: 'COMPLETED' },
          };
        },
        hasPendingSwitch: () => true,
        getPeriodicSwitchPendingState: () => ({
          pending: false,
          pendingSinceMs: null,
        }),
        resetAllState: () => {},
      },
    });

    runtimeHarness.runtime.start();
    runtimeHarness.runtime.handoffPendingSwitch({
      direction: 'LONG',
      monitorContext: runtimeHarness.monitorContext,
      driveResult: createWaitResult([{ kind: 'ORDER_EVENT', symbols: ['BULL.HK'] }]),
    });

    expect(() => {
      Reflect.apply(runtimeHarness.runtime.handoffPendingSwitch, undefined, [
        {
          direction: 'LONG',
          monitorContext: runtimeHarness.monitorContext,
          driveResult: { kind: 'WAIT', wakeups: [] },
        },
      ]);
    }).toThrow('[SwitchWakeupRuntime] WAIT must contain at least one wakeup owner');

    expect(() => {
      Reflect.apply(runtimeHarness.runtime.handoffPendingSwitch, undefined, [
        {
          direction: 'LONG',
          monitorContext: runtimeHarness.monitorContext,
          driveResult: { kind: 'WAIT', wakeups: [{ kind: 'BOGUS' }] },
        },
      ]);
    }).toThrow('[SwitchWakeupRuntime] WAIT contains an invalid wakeup owner');

    emitOrderStateChanged('BULL.HK');
    await waitTick();
    expect(advanceCalls).toBe(1);
    await runtimeHarness.runtime.stopAndDrain();
  });

  it('fails fast on illegal still-pending result before removing valid wakeup indexes', async () => {
    let advanceCalls = 0;
    const fatalErrors: unknown[] = [];
    const autoSymbolManager = createAutoSymbolManagerDouble({
      hasPendingSwitch: () => true,
    });
    Object.defineProperty(autoSymbolManager, 'advancePendingSwitch', {
      value: async (params: { readonly direction: 'LONG' | 'SHORT' }) => {
        advanceCalls += 1;
        return {
          advanced: true,
          direction: params.direction,
          stillPending: true,
          driveResult: { kind: 'COMPLETED' },
        };
      },
    });
    const runtimeHarness = createBaseHarness({
      autoSymbolManager,
      onFatalError: (error) => {
        fatalErrors.push(error);
      },
    });

    runtimeHarness.runtime.start();
    runtimeHarness.runtime.handoffPendingSwitch({
      direction: 'LONG',
      monitorContext: runtimeHarness.monitorContext,
      driveResult: createWaitResult([{ kind: 'SYMBOL_QUOTE', symbol: 'BULL.HK' }]),
    });

    emitQuoteUpdated('BULL.HK', 1.23);
    await waitTick();
    emitQuoteUpdated('BULL.HK', 1.24);
    await waitTick();

    expect(fatalErrors).toHaveLength(2);
    expect(fatalErrors[0]).toMatchObject({
      message: '[SwitchWakeupRuntime] stillPending=true requires a non-empty WAIT result',
    });
    expect(advanceCalls).toBe(2);
    await runtimeHarness.runtime.stopAndDrain();
  });

  it('fails fast on a bogus drive kind before removing valid wakeup indexes', async () => {
    let advanceCalls = 0;
    const fatalErrors: unknown[] = [];
    const autoSymbolManager = createAutoSymbolManagerDouble({ hasPendingSwitch: () => true });
    Object.defineProperty(autoSymbolManager, 'advancePendingSwitch', {
      value: async () => {
        advanceCalls += 1;
        return {
          advanced: true,
          direction: 'LONG',
          stillPending: false,
          driveResult: { kind: 'BOGUS' },
        };
      },
    });
    const runtimeHarness = createBaseHarness({
      autoSymbolManager,
      onFatalError: (error) => {
        fatalErrors.push(error);
      },
    });
    runtimeHarness.runtime.start();
    runtimeHarness.runtime.handoffPendingSwitch({
      direction: 'LONG',
      monitorContext: runtimeHarness.monitorContext,
      driveResult: createWaitResult([{ kind: 'SYMBOL_QUOTE', symbol: 'BULL.HK' }]),
    });

    emitQuoteUpdated('BULL.HK', 1.23);
    await waitTick();
    emitQuoteUpdated('BULL.HK', 1.24);
    await waitTick();

    expect(fatalErrors).toHaveLength(2);
    expect(fatalErrors[0]).toMatchObject({
      message: '[SwitchWakeupRuntime] advance result contains an invalid drive kind',
    });
    expect(advanceCalls).toBe(2);
    await runtimeHarness.runtime.stopAndDrain();
  });

  it('fails fast when advance result direction does not match the route', async () => {
    const fatalErrors: unknown[] = [];
    const autoSymbolManager = createAutoSymbolManagerDouble({ hasPendingSwitch: () => true });
    Object.defineProperty(autoSymbolManager, 'advancePendingSwitch', {
      value: async () => ({
        advanced: true,
        direction: 'SHORT',
        stillPending: true,
        driveResult: { kind: 'WAIT', wakeups: [{ kind: 'FRESHNESS' }] },
      }),
    });
    const runtimeHarness = createBaseHarness({
      autoSymbolManager,
      onFatalError: (error) => {
        fatalErrors.push(error);
      },
    });
    runtimeHarness.runtime.start();
    runtimeHarness.runtime.handoffPendingSwitch({
      direction: 'LONG',
      monitorContext: runtimeHarness.monitorContext,
      driveResult: createWaitResult([{ kind: 'SYMBOL_QUOTE', symbol: 'BULL.HK' }]),
    });

    emitQuoteUpdated('BULL.HK', 1.23);
    await waitTick();

    expect(fatalErrors).toHaveLength(1);
    expect(fatalErrors[0]).toMatchObject({
      message: '[SwitchWakeupRuntime] advance result direction mismatch',
    });
    await runtimeHarness.runtime.stopAndDrain();
  });

  it('prunes old seat-version wakeups and stops matching old events', async () => {
    const timerHarness = createTimerHarness(40_000);
    const symbolRegistry = createSymbolRegistryDouble({ longVersion: 1, shortVersion: 1 });
    const advanceCalls: string[] = [];
    const runtimeHarness = createBaseHarness({
      symbolRegistry,
      timerHarness,
      autoSymbolManager: {
        maybeSearchOnEvent: async () => {},
        evaluatePeriodicSwitchDue: async () => ({ kind: 'NOOP' }),
        startSwitchOnDistance: async (params) => ({
          started: false,
          direction: params.direction,
          driveResult: { kind: 'NOOP' },
        }),
        advancePendingSwitch: async (params) => {
          advanceCalls[advanceCalls.length] =
            `${params.direction}:${symbolRegistry.getSeatVersion(params.direction)}`;
          return {
            advanced: true,
            direction: params.direction,
            stillPending: false,
            driveResult: { kind: 'COMPLETED' },
          };
        },
        hasPendingSwitch: () => true,
        getPeriodicSwitchPendingState: () => ({
          pending: false,
          pendingSinceMs: null,
        }),
        resetAllState: () => {},
      },
    });
    const monitorContext = runtimeHarness.monitorContext;

    runtimeHarness.runtime.start();
    runtimeHarness.runtime.handoffPendingSwitch({
      direction: 'LONG',
      monitorContext,
      driveResult: createWaitResult([
        { kind: 'ORDER_EVENT', symbols: ['BULL.HK'] },
        { kind: 'SYMBOL_QUOTE', symbol: 'BULL.HK' },
        { kind: 'RETRY_TIMER', atMs: 40_100 },
      ]),
    });

    symbolRegistry.updateSeatStateWithVersionBump('LONG', {
      ...symbolRegistry.getSeatState('LONG'),
      lastSeatActivatedAt: 1,
    });

    runtimeHarness.runtime.handoffPendingSwitch({
      direction: 'LONG',
      monitorContext,
      driveResult: createWaitResult([{ kind: 'SYMBOL_QUOTE', symbol: 'BEAR.HK' }]),
    });

    emitOrderStateChanged('BULL.HK');
    emitQuoteUpdated('BULL.HK', 1.1);
    timerHarness.setNow(40_100);
    timerHarness.fireDueTimers();
    await waitTick();
    emitQuoteUpdated('BEAR.HK', 1.2);
    await waitTick();

    expect(advanceCalls).toEqual(['LONG:2']);
    expect(timerHarness.getPendingTimerCount()).toBe(0);
    await runtimeHarness.runtime.stopAndDrain();
  });

  it('ignores old events and retry timers after stopAndDrain', async () => {
    const timerHarness = createTimerHarness(20_000);
    let advanceCalls = 0;
    const runtimeHarness = createBaseHarness({
      timerHarness,
      autoSymbolManager: {
        maybeSearchOnEvent: async () => {},
        evaluatePeriodicSwitchDue: async () => ({ kind: 'NOOP' }),
        startSwitchOnDistance: async (params) => ({
          started: false,
          direction: params.direction,
          driveResult: { kind: 'NOOP' },
        }),
        advancePendingSwitch: async (params) => {
          advanceCalls += 1;
          return {
            advanced: true,
            direction: params.direction,
            stillPending: true,
            driveResult: createWaitResult([{ kind: 'RETRY_TIMER', atMs: 20_100 }]),
          };
        },
        hasPendingSwitch: () => true,
        getPeriodicSwitchPendingState: () => ({
          pending: false,
          pendingSinceMs: null,
        }),
        resetAllState: () => {},
      },
    });
    const stopMonitorContext = runtimeHarness.monitorContext;

    runtimeHarness.runtime.start();
    runtimeHarness.runtime.handoffPendingSwitch({
      direction: 'LONG',
      monitorContext: stopMonitorContext,
      driveResult: createWaitResult([{ kind: 'ORDER_EVENT', symbols: ['BULL.HK'] }]),
    });

    emitOrderStateChanged('BULL.HK');
    await waitTick();
    expect(advanceCalls).toBe(1);
    expect(timerHarness.getPendingTimerCount()).toBe(1);

    await runtimeHarness.runtime.stopAndDrain();

    emitOrderStateChanged('BULL.HK');
    emitQuoteUpdated('BULL.HK', 1.23);
    runtimeHarness.consistencyHarness.emitFreshReached();
    timerHarness.setNow(20_100);
    timerHarness.fireDueTimers();
    await waitTick();

    expect(advanceCalls).toBe(1);
    expect(timerHarness.getPendingTimerCount()).toBe(0);
  });

  it('does not keep retry timers registered when stopAndDrain races with an in-flight advance', async () => {
    const timerHarness = createTimerHarness(30_000);
    const firstAdvance = createDeferred();
    let advanceCalls = 0;
    const runtimeHarness = createBaseHarness({
      timerHarness,
      autoSymbolManager: {
        maybeSearchOnEvent: async () => {},
        evaluatePeriodicSwitchDue: async () => ({ kind: 'NOOP' }),
        startSwitchOnDistance: async (params) => ({
          started: false,
          direction: params.direction,
          driveResult: { kind: 'NOOP' },
        }),
        advancePendingSwitch: async (params) => {
          advanceCalls += 1;
          await firstAdvance.promise;
          return {
            advanced: true,
            direction: params.direction,
            stillPending: true,
            driveResult: createWaitResult([{ kind: 'RETRY_TIMER', atMs: 30_100 }]),
          };
        },
        hasPendingSwitch: () => true,
        getPeriodicSwitchPendingState: () => ({
          pending: false,
          pendingSinceMs: null,
        }),
        resetAllState: () => {},
      },
    });
    const monitorContext = runtimeHarness.monitorContext;

    runtimeHarness.runtime.start();
    runtimeHarness.runtime.handoffPendingSwitch({
      direction: 'LONG',
      monitorContext,
      driveResult: createWaitResult([{ kind: 'ORDER_EVENT', symbols: ['BULL.HK'] }]),
    });

    emitOrderStateChanged('BULL.HK');
    await waitTick();
    expect(advanceCalls).toBe(1);

    const stopPromise = runtimeHarness.runtime.stopAndDrain();
    firstAdvance.resolve();
    await stopPromise;

    expect(timerHarness.getPendingTimerCount()).toBe(0);
    timerHarness.setNow(30_100);
    timerHarness.fireDueTimers();
    await waitTick();
    expect(advanceCalls).toBe(1);
  });

  it('does not retain a pending-switch handoff while the lifecycle gate is closed', async () => {
    let advanceCalls = 0;
    const runtimeHarness = createBaseHarness({
      consistencyStatus: {
        started: false,
        currentVersion: 0,
        staleVersion: 0,
      },
      lastState: {
        canTrade: false,
        isTradingEnabled: false,
        isHalfDay: false,
        cachedPositions: [],
      },
      autoSymbolManager: {
        maybeSearchOnEvent: async () => {},
        evaluatePeriodicSwitchDue: async () => ({ kind: 'NOOP' }),
        startSwitchOnDistance: async (params) => ({
          started: false,
          direction: params.direction,
          driveResult: { kind: 'NOOP' },
        }),
        advancePendingSwitch: async (params) => {
          advanceCalls += 1;
          return {
            advanced: true,
            direction: params.direction,
            stillPending: false,
            driveResult: { kind: 'COMPLETED' },
          };
        },
        hasPendingSwitch: () => true,
        getPeriodicSwitchPendingState: () => ({
          pending: false,
          pendingSinceMs: null,
        }),
        resetAllState: () => {},
      },
    });
    const monitorContext = runtimeHarness.monitorContext;

    runtimeHarness.runtime.start();
    runtimeHarness.runtime.handoffPendingSwitch({
      direction: 'LONG',
      monitorContext,
      driveResult: createWaitResult([{ kind: 'FRESHNESS' }]),
    });

    runtimeHarness.consistencyHarness.emitFreshReached();
    await waitTick();
    expect(advanceCalls).toBe(0);

    runtimeHarness.lastState.canTrade = true;
    runtimeHarness.lastState.isTradingEnabled = true;
    runtimeHarness.consistencyHarness.setStatus({
      started: true,
      currentVersion: 1,
      staleVersion: 1,
    });
    runtimeHarness.consistencyHarness.emitFreshReached();
    await waitTick();

    expect(advanceCalls).toBe(0);
    await runtimeHarness.runtime.stopAndDrain();
  });

  it('keeps an existing pending switch route through lunch and re-drives it when the gate reopens', async () => {
    let advanceCalls = 0;
    const tradingGateHarness = createTradingGateHarness();
    const runtimeHarness = createBaseHarness({
      tradingGateEventRuntime: tradingGateHarness.port,
      autoSymbolManager: {
        maybeSearchOnEvent: async () => {},
        evaluatePeriodicSwitchDue: async () => ({ kind: 'NOOP' }),
        startSwitchOnDistance: async (params) => ({
          started: false,
          direction: params.direction,
          driveResult: { kind: 'NOOP' },
        }),
        advancePendingSwitch: async (params) => {
          advanceCalls += 1;
          return {
            advanced: true,
            direction: params.direction,
            stillPending: false,
            driveResult: { kind: 'COMPLETED' },
          };
        },
        hasPendingSwitch: () => true,
        getPeriodicSwitchPendingState: () => ({
          pending: false,
          pendingSinceMs: null,
        }),
        resetAllState: () => {},
      },
    });

    runtimeHarness.runtime.start();
    runtimeHarness.runtime.handoffPendingSwitch({
      direction: 'LONG',
      monitorContext: runtimeHarness.monitorContext,
      driveResult: createWaitResult([{ kind: 'FRESHNESS' }]),
    });

    runtimeHarness.lastState.canTrade = false;
    tradingGateHarness.emit({ previousCanTrade: true, nextCanTrade: false });
    await waitTick();
    expect(advanceCalls).toBe(0);

    runtimeHarness.lastState.canTrade = true;
    tradingGateHarness.emit({ previousCanTrade: false, nextCanTrade: true });
    await waitTick();

    expect(advanceCalls).toBe(1);
    await runtimeHarness.runtime.stopAndDrain();
  });

  it('retains the current route when lunch aborts an in-flight advance and re-drives it after the gate reopens', async () => {
    const advanceStarted = createDeferred();
    const releaseFirstAdvance = createDeferred();
    const canContinueDuringLunch: boolean[] = [];
    let advanceCalls = 0;
    const tradingGateHarness = createTradingGateHarness();
    const runtimeHarness = createBaseHarness({
      tradingGateEventRuntime: tradingGateHarness.port,
      autoSymbolManager: {
        maybeSearchOnEvent: async () => {},
        evaluatePeriodicSwitchDue: async () => ({ kind: 'NOOP' }),
        startSwitchOnDistance: async (params) => ({
          started: false,
          direction: params.direction,
          driveResult: { kind: 'NOOP' },
        }),
        advancePendingSwitch: async (params) => {
          advanceCalls += 1;
          if (advanceCalls === 1) {
            advanceStarted.resolve();
            await releaseFirstAdvance.promise;
            const canContinue = params.canContinue();
            canContinueDuringLunch.push(canContinue);
            if (!canContinue) {
              return {
                advanced: false,
                direction: params.direction,
                stillPending: false,
                driveResult: { kind: 'NOOP' },
              };
            }
          }

          return {
            advanced: true,
            direction: params.direction,
            stillPending: false,
            driveResult: { kind: 'COMPLETED' },
          };
        },
        hasPendingSwitch: () => true,
        getPeriodicSwitchPendingState: () => ({
          pending: false,
          pendingSinceMs: null,
        }),
        resetAllState: () => {},
      },
    });

    runtimeHarness.runtime.start();
    runtimeHarness.runtime.handoffPendingSwitch({
      direction: 'LONG',
      monitorContext: runtimeHarness.monitorContext,
      driveResult: createWaitResult([{ kind: 'FRESHNESS' }]),
    });
    runtimeHarness.consistencyHarness.emitFreshReached();
    await advanceStarted.promise;

    runtimeHarness.lastState.canTrade = false;
    tradingGateHarness.emit({ previousCanTrade: true, nextCanTrade: false });
    releaseFirstAdvance.resolve();
    await waitTick();
    await waitTick();

    expect(canContinueDuringLunch).toEqual([false]);
    expect(advanceCalls).toBe(1);

    runtimeHarness.lastState.canTrade = true;
    tradingGateHarness.emit({ previousCanTrade: false, nextCanTrade: true });
    await waitTick();
    await waitTick();

    expect(advanceCalls).toBe(2);
    await runtimeHarness.runtime.stopAndDrain();
  });

  it('revokes in-flight manager continuation before stopAndDrain waits for the route to drain', async () => {
    const advanceStarted = createDeferred();
    const releaseAdvance = createDeferred();
    const observedCanContinue: boolean[] = [];
    let managerStateMutations = 0;
    const runtimeHarness = createBaseHarness({
      autoSymbolManager: {
        maybeSearchOnEvent: async () => {},
        evaluatePeriodicSwitchDue: async () => ({ kind: 'NOOP' }),
        startSwitchOnDistance: async (params) => ({
          started: false,
          direction: params.direction,
          driveResult: { kind: 'NOOP' },
        }),
        advancePendingSwitch: async (params) => {
          advanceStarted.resolve();
          await releaseAdvance.promise;
          const canContinue = params.canContinue();
          observedCanContinue.push(canContinue);
          if (canContinue) {
            managerStateMutations += 1;
          }

          return {
            advanced: false,
            direction: params.direction,
            stillPending: false,
            driveResult: { kind: 'NOOP' },
          };
        },
        hasPendingSwitch: () => true,
        getPeriodicSwitchPendingState: () => ({
          pending: false,
          pendingSinceMs: null,
        }),
        resetAllState: () => {},
      },
    });

    runtimeHarness.runtime.start();
    runtimeHarness.runtime.handoffPendingSwitch({
      direction: 'LONG',
      monitorContext: runtimeHarness.monitorContext,
      driveResult: createWaitResult([{ kind: 'FRESHNESS' }]),
    });
    runtimeHarness.consistencyHarness.emitFreshReached();
    await advanceStarted.promise;

    const stopPromise = runtimeHarness.runtime.stopAndDrain();
    releaseAdvance.resolve();
    await stopPromise;

    expect(observedCanContinue).toEqual([false]);
    expect(managerStateMutations).toBe(0);
  });

  it('deletes an existing pending switch route when the lifecycle gate closes', async () => {
    let advanceCalls = 0;
    const tradingGateHarness = createTradingGateHarness();
    const runtimeHarness = createBaseHarness({
      tradingGateEventRuntime: tradingGateHarness.port,
      autoSymbolManager: {
        maybeSearchOnEvent: async () => {},
        evaluatePeriodicSwitchDue: async () => ({ kind: 'NOOP' }),
        startSwitchOnDistance: async (params) => ({
          started: false,
          direction: params.direction,
          driveResult: { kind: 'NOOP' },
        }),
        advancePendingSwitch: async (params) => {
          advanceCalls += 1;
          return {
            advanced: true,
            direction: params.direction,
            stillPending: false,
            driveResult: { kind: 'COMPLETED' },
          };
        },
        hasPendingSwitch: () => true,
        getPeriodicSwitchPendingState: () => ({
          pending: false,
          pendingSinceMs: null,
        }),
        resetAllState: () => {},
      },
    });

    runtimeHarness.runtime.start();
    runtimeHarness.runtime.handoffPendingSwitch({
      direction: 'LONG',
      monitorContext: runtimeHarness.monitorContext,
      driveResult: createWaitResult([{ kind: 'FRESHNESS' }]),
    });

    runtimeHarness.lastState.isTradingEnabled = false;
    runtimeHarness.lastState.canTrade = false;
    tradingGateHarness.emit({ previousCanTrade: true, nextCanTrade: false });
    await waitTick();

    runtimeHarness.lastState.isTradingEnabled = true;
    runtimeHarness.lastState.canTrade = true;
    runtimeHarness.consistencyHarness.emitFreshReached();
    await waitTick();

    expect(advanceCalls).toBe(0);
    await runtimeHarness.runtime.stopAndDrain();
  });

  it('collapses concurrent wakeups to the latest pending execution for the same route', async () => {
    const firstAdvance = createDeferred();
    const observedPositionQuantities: ReadonlyArray<number>[] = [];
    let callCount = 0;
    const runtimeHarness = createBaseHarness({
      autoSymbolManager: {
        maybeSearchOnEvent: async () => {},
        evaluatePeriodicSwitchDue: async () => ({ kind: 'NOOP' }),
        startSwitchOnDistance: async (params) => ({
          started: false,
          direction: params.direction,
          driveResult: { kind: 'NOOP' },
        }),
        advancePendingSwitch: async (params) => {
          callCount += 1;
          observedPositionQuantities.push(params.positions.map((position) => position.quantity));
          if (callCount === 1) {
            await firstAdvance.promise;
            return {
              advanced: true,
              direction: params.direction,
              stillPending: true,
              driveResult: createWaitResult([{ kind: 'ORDER_EVENT', symbols: ['BULL.HK'] }]),
            };
          }

          return {
            advanced: true,
            direction: params.direction,
            stillPending: false,
            driveResult: { kind: 'COMPLETED' },
          };
        },
        hasPendingSwitch: () => true,
        getPeriodicSwitchPendingState: () => ({
          pending: false,
          pendingSinceMs: null,
        }),
        resetAllState: () => {},
      },
    });
    const monitorContext = runtimeHarness.monitorContext;

    runtimeHarness.lastState.cachedPositions = [
      createPositionDouble({ symbol: 'BULL.HK', quantity: 100, availableQuantity: 100 }),
    ];

    runtimeHarness.runtime.start();
    runtimeHarness.runtime.handoffPendingSwitch({
      direction: 'LONG',
      monitorContext,
      driveResult: createWaitResult([{ kind: 'ORDER_EVENT', symbols: ['BULL.HK'] }]),
    });

    emitOrderStateChanged('BULL.HK');
    await waitTick();
    runtimeHarness.lastState.cachedPositions = [
      createPositionDouble({ symbol: 'BULL.HK', quantity: 200, availableQuantity: 200 }),
    ];

    runtimeHarness.lastState.cachedPositions = [
      createPositionDouble({ symbol: 'BULL.HK', quantity: 300, availableQuantity: 300 }),
    ];
    emitOrderStateChanged('BULL.HK');
    await waitTick();

    firstAdvance.resolve();
    await waitTick();
    await waitTick();

    expect(observedPositionQuantities).toEqual([[100], [300]]);
    await runtimeHarness.runtime.stopAndDrain();
  });

  it('does not requeue a pending switch after doomsday takeover begins during advance', async () => {
    const beforeTakeoverMs = Date.parse('2026-02-16T07:54:59.000Z');
    const takeoverMs = Date.parse('2026-02-16T07:55:00.000Z');
    let currentNowMs = beforeTakeoverMs;
    const advanceStarted = createDeferred();
    const releaseAdvance = createDeferred();
    const runtimeHarness = createBaseHarness({
      doomsdayProtectionEnabled: true,
      now: () => new Date(currentNowMs),
      autoSymbolManager: {
        maybeSearchOnEvent: async () => {},
        evaluatePeriodicSwitchDue: async () => ({ kind: 'NOOP' }),
        startSwitchOnDistance: async (params) => ({
          started: false,
          direction: params.direction,
          driveResult: { kind: 'NOOP' },
        }),
        advancePendingSwitch: async (params) => {
          advanceStarted.resolve();
          await releaseAdvance.promise;
          return {
            advanced: true,
            direction: params.direction,
            stillPending: true,
            driveResult: createWaitResult([{ kind: 'RETRY_TIMER', atMs: takeoverMs + 1_000 }]),
          };
        },
        hasPendingSwitch: () => true,
        getPeriodicSwitchPendingState: () => ({ pending: false, pendingSinceMs: null }),
        resetAllState: () => {},
      },
    });

    runtimeHarness.runtime.start();
    runtimeHarness.runtime.handoffPendingSwitch({
      direction: 'LONG',
      monitorContext: runtimeHarness.monitorContext,
      driveResult: createWaitResult([{ kind: 'SYMBOL_QUOTE', symbol: 'BULL.HK' }]),
    });
    emitQuoteUpdated('BULL.HK', 1.23);
    await advanceStarted.promise;

    currentNowMs = takeoverMs;
    releaseAdvance.resolve();
    await waitTick();

    expect(runtimeHarness.timerHarness.getPendingTimerCount()).toBe(0);
    await runtimeHarness.runtime.stopAndDrain();
  });
});
