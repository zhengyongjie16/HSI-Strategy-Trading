import { createDiagnosticObserverDouble } from '../../helpers/diagnostics.js';
import { createRuntimeStateFixtures } from '../../helpers/runtimeStateFixtures.js';
import type { RuntimeStateFixtures } from '../../helpers/types.js';
import {
  createLoggerDouble,
  createMonitorContextDouble,
  createSeatSwitchWorkflowDouble,
  createQuoteDouble,
  createSymbolRegistryDouble,
  createTradeRuntimeDouble,
  createPositionDouble,
  createAccountSnapshotDouble,
} from '../../helpers/testDoubles.js';
import { createSnapshotFixture } from '../../helpers/accountPositionSnapshot.js';
import { createSettlementRuntimeFixture } from '../../helpers/settlementRuntime.js';
import type { AccountPositionSnapshot } from '../../../src/types/accountPosition.js';
import type { PostTradeConsistencyRuntime } from '../../../src/app/runtime/types.js';
import type {
  SettlementFreshnessReader,
  SettlementReadinessReceipt,
} from '../../../src/types/settlement.js';
import { createTerminationRuntime } from '../../../src/runtime/lifecycle/terminationRuntime.js';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { createMonitorConfig } from '../../../mock/factories/configFactory.js';
import { createSwitchWakeupRuntime } from '../../../src/runtime/monitorQuoteEventRuntime/switchWakeupRuntime.js';
import { createExternalApiRequestError } from '../../helpers/createExternalApiRequestError.js';
import type {
  SeatSwitchWorkflow,
  SwitchDriveResult,
  SwitchWakeupRequirement,
} from '../../../src/types/seatSwitch.js';
import type { QuoteUpdatedEvent } from '../../../src/types/marketPorts.js';
import type { OrderStateChangedEvent } from '../../../src/types/orderTracking.js';
import type { MonitorContextAssembly } from '../../../src/app/context/types.js';
import type { SymbolRegistry } from '../../../src/types/seat.js';
import type { QuoteRetainPort } from '../../../src/types/quoteSubscription.js';
import type { TradingGateEventRuntime } from '../../../src/runtime/tradingGateEventRuntime/types.js';
import type { TradingGateStateChangedEvent } from '../../../src/types/timeControlPlane.js';

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

const settlementCleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of settlementCleanups.splice(0)) await cleanup();
});

/** Real H/S producer; a paused await delivers the captured original receipt, never a replacement. */
async function createConsistencyHarness(
  params: Readonly<{
    snapshot: AccountPositionSnapshot;
    monitorContext: MonitorContextAssembly;
    started: boolean;
  }>,
) {
  let deliveryGate: ReturnType<typeof createDeferred<void>> | null = null;
  const owner = createSettlementRuntimeFixture({
    diagnostics: createDiagnosticObserverDouble(),
    clock: { now: () => new Date() },
    logger: createLoggerDouble(),
    snapshot: params.snapshot,
    monitorContext: params.monitorContext,
    termination: createTerminationRuntime({
      closeTradingGate: () => {},
      closeProducerAdmission: () => {},
      stopProducers: [],
      onSecondaryError: () => {},
    }),
    getProtectiveOrderReader: () => createTradeRuntimeDouble().orderMonitor,
    onPositionsCommitted: async (token) => {
      if (!params.snapshot.isCurrent(token, { account: true, positions: true, paired: true }))
        throw new Error('Stale settlement positions callback');
    },
    scheduler: {
      scheduleTimer: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimer: (handle) => {
        clearTimeout(handle);
      },
    },
  });
  if (params.started) {
    owner.start();
    expect(await owner.completeRebuildBaseline()).toBeTrue();
    const completed = await owner.waitForFresh();
    // pending-switch 消费当前持仓，不要求原完成 receipt 与普通 commit 的 revision 相等。
    for (const refreshAccount of [true, false]) {
      await params.snapshot.requestRefresh({
        source: 'SEAT_ACTIVATION',
        dayEpoch: completed.snapshotToken.dayEpoch,
        refreshAccount,
        refreshPositions: true,
      }).result;
      expect(owner.isCurrent(completed)).toBe(true);
      expect(await owner.waitForFresh()).toBe(completed);
    }
  }

  let freshListenerCount = 0;
  let waitingReceipt: SettlementReadinessReceipt | null = null;
  let deliveredReceipt: SettlementReadinessReceipt | null = null;
  const port: SettlementFreshnessReader & Pick<PostTradeConsistencyRuntime, 'getStatus'> = {
    getStatus: owner.getStatus,
    isCurrent: owner.isCurrent,
    onFreshReached: (listener) => {
      freshListenerCount += 1;
      const unsubscribe = owner.onFreshReached(listener);
      return () => {
        freshListenerCount -= 1;
        unsubscribe();
      };
    },
    waitForFresh: async () => {
      const receipt = await owner.waitForFresh();
      waitingReceipt = receipt;
      const gate = deliveryGate;
      if (gate !== null) await gate.promise;

      deliveredReceipt = receipt;
      return receipt;
    },
  };
  settlementCleanups.push(async () => {
    deliveryGate?.resolve();
    await owner.stopAndDrain();
  });
  return {
    port,
    owner,
    getFreshListenerCount: () => freshListenerCount,
    getWaitingReceipt: () => waitingReceipt,
    getDeliveredReceipt: () => deliveredReceipt,
    blockFreshWait: () => {
      deliveryGate = createDeferred();
    },
    resolveFreshWait: () => {
      deliveryGate?.resolve();
      deliveryGate = null;
    },
    startBaseline: async () => {
      const rebuilt = await params.snapshot.requestRefresh({
        source: 'TEST_REBUILD',
        dayEpoch: params.snapshot.getView().token.dayEpoch,
        refreshAccount: true,
        refreshPositions: true,
      }).result;
      expect(rebuilt.status).toBe('COMMITTED');
      owner.start();
      expect(await owner.completeRebuildBaseline()).toBeTrue();
      await owner.waitForFresh();
    },
    refreshFacts: async () => {
      owner.recordSettlementRefreshNeed({ refreshAccount: true, refreshPositions: true });
      if (owner.getStatus().started) await owner.waitForFresh();
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

  async function createBaseHarness(
    params: {
      readonly monitorContext?: MonitorContextAssembly;
      readonly symbolRegistry?: SymbolRegistry;
      readonly stateFixtures?: RuntimeStateFixtures;
      readonly startSettlement?: boolean;
      readonly doomsdayProtectionEnabled?: boolean;
      readonly now?: () => Date;
      readonly timerHarness?: ReturnType<typeof createTimerHarness>;
      readonly seatSwitch?: SeatSwitchWorkflow;
      readonly quoteSubscriptionRuntime?: Pick<QuoteRetainPort, 'retainSymbols' | 'releaseRetain'>;
      readonly tradingGateEventRuntime?: Pick<TradingGateEventRuntime, 'onGateStateChanged'>;
      readonly termination?: {
        readonly isTerminated: () => boolean;
        readonly reportFatalError: (error: unknown) => void;
      };
    } = {},
  ): Promise<
    Readonly<{
      snapshot: AccountPositionSnapshot;
      commitPositions: (
        positions: ReadonlyArray<ReturnType<typeof createPositionDouble>>,
      ) => Promise<void>;
      runtime: ReturnType<typeof createSwitchWakeupRuntime>;
      symbolRegistry: SymbolRegistry;
      monitorContext: MonitorContextAssembly;
      stateFixtures: RuntimeStateFixtures;
      consistencyHarness: Awaited<ReturnType<typeof createConsistencyHarness>>;
      timerHarness: ReturnType<typeof createTimerHarness>;
    }>
  > {
    const symbolRegistry =
      params.symbolRegistry ??
      createSymbolRegistryDouble({
        longSeat: {
          symbol: 'BULL.HK',
          status: 'SWITCHING',
          lastSwitchAt: null,
          lastSearchAt: null,
          lastSeatActivatedAt: null,
          searchFailCountToday: 0,
          frozenTradingDayKey: null,
        },
        shortSeat: {
          symbol: 'BEAR.HK',
          status: 'SWITCHING',
          lastSwitchAt: null,
          lastSearchAt: null,
          lastSeatActivatedAt: null,
          searchFailCountToday: 0,
          frozenTradingDayKey: null,
        },
        longVersion: 1,
        shortVersion: 1,
      });
    const timerHarness = params.timerHarness ?? createTimerHarness();
    const stateFixtures =
      params.stateFixtures ??
      createRuntimeStateFixtures({
        tradingTimeState: { canTrade: true, isHalfDay: false },
        lifecycleState: { isTradingEnabled: true },
      });
    const monitorContext = params.monitorContext ?? {
      ...createMonitorContextDouble({
        config: createMonitorConfig({ monitorSymbol: 'HSI.HK' }),
        symbolRegistry,
      }),
      seatSwitch: params.seatSwitch ?? createSeatSwitchWorkflowDouble(),
    };
    let positions: ReadonlyArray<ReturnType<typeof createPositionDouble>> = [
      createPositionDouble({ symbol: 'BULL.HK', quantity: 100, availableQuantity: 100 }),
    ];
    const snapshot = await createSnapshotFixture({
      account: createAccountSnapshotDouble('100000'),
      positions,
      readPort: {
        getAccountSnapshot: async () => createAccountSnapshotDouble('100000'),
        getStockPositions: async () => positions,
      },
    });
    const consistencyHarness = await createConsistencyHarness({
      snapshot,
      monitorContext,
      started: params.startSettlement ?? true,
    });
    const tradeRuntime = createTradeRuntimeDouble({
      orderMonitor: {
        onOrderStateChanged: (listener) => {
          orderStateChangedListener = listener;
          return () => {
            if (orderStateChangedListener === listener) {
              orderStateChangedListener = null;
            }
          };
        },
      },
    });
    const tradingGateEventRuntime = params.tradingGateEventRuntime ?? {
      onGateStateChanged: () => () => {},
    };
    const runtimeDeps = {
      logger: { error: () => {} },
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
      orderMonitor: tradeRuntime.orderMonitor,
      symbolRegistry,
      monitorContext,
      ...stateFixtures,
      snapshot,
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
      termination: {
        isTerminated: params.termination?.isTerminated ?? (() => false),
        reportFatalError: params.termination?.reportFatalError ?? (() => {}),
      },
    };
    const runtime = createSwitchWakeupRuntime(runtimeDeps);
    const originalDayEpoch = snapshot.getView().token.dayEpoch;

    return {
      snapshot,
      commitPositions: async (nextPositions) => {
        positions = nextPositions;
        await consistencyHarness.refreshFacts();
      },
      runtime: {
        ...runtime,
        handoffPendingSwitch: (handoff) => {
          runtime.handoffPendingSwitch({ ...handoff, originalDayEpoch });
        },
      },
      symbolRegistry,
      monitorContext,
      stateFixtures,
      consistencyHarness,
      timerHarness,
    };
  }

  function emitQuoteUpdated(symbol: string, price: number): void {
    quoteUpdatedListener?.({
      symbol,
      quote: createQuoteDouble(symbol, String(price), 100),
    });
  }

  function emitOrderStateChanged(symbol: string | null): void {
    orderStateChangedListener?.({
      orderId: `order-${symbol}`,
      symbol,
      side: 'BUY',
      status: 'FILLED',
      monitorSymbol: 'HSI.HK',
      isLongSymbol: true,
      isProtectiveLiquidation: false,
      executedPrice: '1',
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
    const runtimeHarness = await createBaseHarness({
      termination: {
        isTerminated: () => false,
        reportFatalError: (error) => {
          fatalErrors.push(error);
        },
      },
      seatSwitch: {
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

  it('forwards a dedicated re-entry route failure to the fatal handler unchanged', async () => {
    const firstAdvanceStarted = createDeferred();
    const releaseFirstAdvance = createDeferred();
    const firstError = new Error('first route failure');
    const reentryError = new Error('re-entry route failure');
    const fatalErrors: unknown[] = [];
    let advanceCalls = 0;
    const runtimeHarness = await createBaseHarness({
      termination: {
        isTerminated: () => false,
        reportFatalError: (error) => {
          fatalErrors.push(error);
        },
      },
      seatSwitch: {
        evaluatePeriodicSwitchDue: async () => ({ kind: 'NOOP' }),
        startSwitchOnDistance: async (params) => ({
          started: false,
          direction: params.direction,
          driveResult: { kind: 'NOOP' },
        }),
        advancePendingSwitch: async () => {
          advanceCalls += 1;
          if (advanceCalls === 1) {
            firstAdvanceStarted.resolve();
            await releaseFirstAdvance.promise;
            throw firstError;
          }

          throw reentryError;
        },
        hasPendingSwitch: () => true,
        getPeriodicSwitchPendingState: () => ({
          pending: false,
        }),
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
    await firstAdvanceStarted.promise;
    emitQuoteUpdated('BULL.HK', 1.24);
    releaseFirstAdvance.resolve();
    await waitTick();
    await waitTick();

    expect(advanceCalls).toBe(2);
    expect(fatalErrors).toContain(firstError);
    expect(fatalErrors).toContain(reentryError);
    await runtimeHarness.runtime.stopAndDrain();
  });

  it('reports a malformed advance result when the lifecycle gate closes during advance', async () => {
    const fatalErrors: unknown[] = [];
    const advanceStarted = createDeferred();
    const releaseAdvance = createDeferred();
    let advanceCalls = 0;
    const runtimeHarness = await createBaseHarness({
      termination: {
        isTerminated: () => false,
        reportFatalError: (error) => {
          fatalErrors.push(error);
        },
      },
      seatSwitch: {
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
    await runtimeHarness.consistencyHarness.refreshFacts();
    await advanceStarted.promise;

    runtimeHarness.stateFixtures.lifecycleState.isTradingEnabled = false;
    releaseAdvance.resolve();
    await waitTick();
    await waitTick();

    expect(fatalErrors).toEqual([
      expect.objectContaining({
        message: '[SwitchWakeupRuntime] advance result direction mismatch',
      }),
    ]);
    expect(runtimeHarness.timerHarness.getPendingTimerCount()).toBe(0);

    runtimeHarness.stateFixtures.lifecycleState.isTradingEnabled = true;
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
    const runtimeHarness = await createBaseHarness({
      timerHarness,
      seatSwitch: {
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

    await runtimeHarness.commitPositions([
      createPositionDouble({ symbol: 'BULL.HK', quantity: 1, availableQuantity: 1 }),
    ]);

    await runtimeHarness.commitPositions([
      createPositionDouble({ symbol: 'BULL.HK', quantity: 200, availableQuantity: 200 }),
    ]);
    emitOrderStateChanged('BULL.HK');
    await waitTick();

    await runtimeHarness.commitPositions([
      createPositionDouble({ symbol: 'BULL.HK', quantity: 300, availableQuantity: 300 }),
    ]);
    await waitTick();

    emitQuoteUpdated('OTHER.HK', 1.2);
    await waitTick();
    expect(advanceCalls).toHaveLength(2);

    await runtimeHarness.commitPositions([
      createPositionDouble({ symbol: 'BULL.HK', quantity: 400, availableQuantity: 400 }),
    ]);
    emitQuoteUpdated('BULL.HK', 1.23);
    await waitTick();

    await runtimeHarness.commitPositions([
      createPositionDouble({ symbol: 'BULL.HK', quantity: 500, availableQuantity: 500 }),
    ]);
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
    const tradingGateHarness = createTradingGateHarness();
    const monitorContext: MonitorContextAssembly = {
      ...createMonitorContextDouble({
        config: createMonitorConfig({ monitorSymbol: 'HSI.HK' }),
        symbolRegistry,
      }),
      seatSwitch: {
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
        }),
        resetAllState: () => {},
      },
    };
    const customHarness = await createBaseHarness({
      symbolRegistry,
      monitorContext,
      tradingGateEventRuntime: tradingGateHarness.port,
    });
    const { runtime, consistencyHarness } = customHarness;
    consistencyHarness.blockFreshWait();

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
    const originalReceipt = consistencyHarness.getWaitingReceipt();
    if (originalReceipt === null)
      throw new Error('Expected original producer-issued S receipt before the await barrier');

    expect(consistencyHarness.port.isCurrent(originalReceipt)).toBe(true);

    symbolRegistry.updateSeatStateWithVersionBump('LONG', {
      ...symbolRegistry.getSeatState('LONG'),
      lastSeatActivatedAt: 1,
    });

    await consistencyHarness.refreshFacts();
    expect(consistencyHarness.port.isCurrent(originalReceipt)).toBe(false);
    consistencyHarness.resolveFreshWait();
    await waitTick();

    expect(consistencyHarness.getDeliveredReceipt()).toBe(originalReceipt);
    expect(advanceCalls).toEqual([]);
    await runtime.stopAndDrain();
  });

  it('deletes the route when pending switch is cleared before a wakeup is handled', async () => {
    let advanceCalls = 0;
    let pendingSwitchActive = true;
    const runtimeHarness = await createBaseHarness({
      seatSwitch: {
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
    const runtimeHarness = await createBaseHarness({
      seatSwitch: {
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

    await runtimeHarness.consistencyHarness.refreshFacts();
    await waitTick();

    pendingSwitchActive = false;
    runtimeHarness.consistencyHarness.resolveFreshWait();
    await waitTick();
    await waitTick();

    pendingSwitchActive = true;
    await runtimeHarness.consistencyHarness.refreshFacts();
    await waitTick();

    expect(advanceCalls).toBe(0);
    await runtimeHarness.runtime.stopAndDrain();
  });

  it('re-drives the route after quote retain resolves for the current route', async () => {
    const retainDeferred = createDeferred<() => void>();
    let advanceCalls = 0;
    const runtimeHarness = await createBaseHarness({
      quoteSubscriptionRuntime: {
        retainSymbols: async () => {
          await retainDeferred.promise;
        },
        releaseRetain: async () => {},
      },
      seatSwitch: {
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
    const runtimeHarness = await createBaseHarness({
      symbolRegistry,
      quoteSubscriptionRuntime: {
        retainSymbols: async () => {
          await retainDeferred.promise;
        },
        releaseRetain: async () => {},
      },
      seatSwitch: {
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
    const runtimeHarness = await createBaseHarness({
      quoteSubscriptionRuntime: {
        retainSymbols: async ({ symbols }) => {
          const [symbol] = [...symbols];
          if (symbol === undefined) {
            throw new Error('expected retain symbol');
          }

          retainCalls.push(symbol);
          if (symbol === 'BULL.HK') {
            await bullRetainDeferred.promise;
            return;
          }

          if (symbol === 'BEAR.HK') {
            await bearRetainDeferred.promise;
            return;
          }

          throw new Error(`unexpected retain symbol: ${symbol}`);
        },
        releaseRetain: async () => {},
      },
      seatSwitch: {
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
    const retainError = new Error('retain failed');
    const fatalErrors: unknown[] = [];
    let remainingRetainFailures = 1;
    const runtimeHarness = await createBaseHarness({
      quoteSubscriptionRuntime: {
        retainSymbols: async ({ symbols }) => {
          retainCalls.push([...symbols]);
          if (remainingRetainFailures > 0) {
            remainingRetainFailures -= 1;
            throw retainError;
          }
        },
        releaseRetain: async () => {},
      },
      seatSwitch: {
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
        }),
        resetAllState: () => {},
      },
      termination: {
        isTerminated: () => false,
        reportFatalError: (error) => {
          fatalErrors.push(error);
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
    expect(retainCalls).toEqual([['BULL.HK']]);
    expect(fatalErrors).toEqual([retainError]);

    emitQuoteUpdated('BULL.HK', 1.1);
    await waitTick();

    expect(retainCalls).toEqual([['BULL.HK'], ['BULL.HK']]);
    expect(
      await runtimeHarness.runtime.stopAndDrain().catch((error: unknown) => error),
    ).toBeInstanceOf(Error);
  });

  it('releases switch quote retain owner after failed retain when runtime stops', async () => {
    const releaseCalls: Array<{ readonly ownerKey: string; readonly reason: string }> = [];
    const releaseError = new Error('release failed');
    const retainError = new Error('retain failed');
    const fatalErrors: unknown[] = [];
    const runtimeHarness = await createBaseHarness({
      quoteSubscriptionRuntime: {
        retainSymbols: async () => {
          throw retainError;
        },
        releaseRetain: async ({ ownerKey, reason }) => {
          releaseCalls.push({ ownerKey, reason });
          throw releaseError;
        },
      },
      termination: {
        isTerminated: () => false,
        reportFatalError: (error) => {
          fatalErrors.push(error);
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
    expect(await runtimeHarness.runtime.stopAndDrain().catch((error: unknown) => error)).toBe(
      retainError,
    );
    await waitTick();

    expect(releaseCalls).toEqual([{ ownerKey: 'LONG:1', reason: 'SWITCH_WAKEUP' }]);
    expect(fatalErrors).toEqual([expect.any(Error), releaseError]);
  });

  it('switches symbol quote wakeup membership when WAIT wakeups change', async () => {
    const advanceCalls: string[] = [];
    const runtimeHarness = await createBaseHarness({
      seatSwitch: {
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
    const runtimeHarness = await createBaseHarness({
      seatSwitch: {
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
    const runtimeHarness = await createBaseHarness({
      seatSwitch: {
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
    const runtimeHarness = await createBaseHarness();
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
    const runtimeHarness = await createBaseHarness({
      seatSwitch: {
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
    const seatSwitch = createSeatSwitchWorkflowDouble({
      hasPendingSwitch: () => true,
    });
    Object.defineProperty(seatSwitch, 'advancePendingSwitch', {
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
    const runtimeHarness = await createBaseHarness({
      seatSwitch,
      termination: {
        isTerminated: () => false,
        reportFatalError: (error) => {
          fatalErrors.push(error);
        },
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
    const seatSwitch = createSeatSwitchWorkflowDouble({ hasPendingSwitch: () => true });
    Object.defineProperty(seatSwitch, 'advancePendingSwitch', {
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
    const runtimeHarness = await createBaseHarness({
      seatSwitch,
      termination: {
        isTerminated: () => false,
        reportFatalError: (error) => {
          fatalErrors.push(error);
        },
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
    const seatSwitch = createSeatSwitchWorkflowDouble({ hasPendingSwitch: () => true });
    Object.defineProperty(seatSwitch, 'advancePendingSwitch', {
      value: async () => ({
        advanced: true,
        direction: 'SHORT',
        stillPending: true,
        driveResult: { kind: 'WAIT', wakeups: [{ kind: 'FRESHNESS' }] },
      }),
    });
    const runtimeHarness = await createBaseHarness({
      seatSwitch,
      termination: {
        isTerminated: () => false,
        reportFatalError: (error) => {
          fatalErrors.push(error);
        },
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
    const runtimeHarness = await createBaseHarness({
      symbolRegistry,
      timerHarness,
      seatSwitch: {
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
    const retainedOwners: string[] = [];
    const releasedOwners: string[] = [];
    const runtimeHarness = await createBaseHarness({
      timerHarness,
      quoteSubscriptionRuntime: {
        retainSymbols: async ({ ownerKey }) => {
          retainedOwners.push(ownerKey);
        },
        releaseRetain: async ({ ownerKey }) => {
          releasedOwners.push(ownerKey);
        },
      },
      seatSwitch: {
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
            driveResult: createWaitResult([
              { kind: 'RETRY_TIMER', atMs: 20_100 },
              { kind: 'SYMBOL_QUOTE', symbol: 'BULL.HK' },
            ]),
          };
        },
        hasPendingSwitch: () => true,
        getPeriodicSwitchPendingState: () => ({
          pending: false,
        }),
        resetAllState: () => {},
      },
    });
    const stopMonitorContext = runtimeHarness.monitorContext;

    runtimeHarness.runtime.start();
    runtimeHarness.runtime.handoffPendingSwitch({
      direction: 'LONG',
      monitorContext: stopMonitorContext,
      driveResult: createWaitResult([
        { kind: 'ORDER_EVENT', symbols: ['BULL.HK'] },
        { kind: 'SYMBOL_QUOTE', symbol: 'BULL.HK' },
      ]),
    });

    await waitTick();
    expect(advanceCalls).toBe(1); // Actual retain completion naturally wakes the registered quote route.
    emitOrderStateChanged('BULL.HK');
    await waitTick();
    expect(advanceCalls).toBe(1);
    expect(timerHarness.getPendingTimerCount()).toBe(1);
    expect(retainedOwners).toHaveLength(1);
    expect(releasedOwners).toEqual([]);
    expect(runtimeHarness.consistencyHarness.getFreshListenerCount()).toBe(1);

    await runtimeHarness.runtime.stopAndDrain();
    expect(releasedOwners).toEqual(retainedOwners);
    expect(runtimeHarness.consistencyHarness.getFreshListenerCount()).toBe(0);
    expect(quoteUpdatedListener).toBeNull();
    expect(orderStateChangedListener).toBeNull();

    emitOrderStateChanged('BULL.HK');
    emitQuoteUpdated('BULL.HK', 1.23);
    await runtimeHarness.consistencyHarness.refreshFacts();
    timerHarness.setNow(20_100);
    timerHarness.fireDueTimers();
    await waitTick();

    expect(advanceCalls).toBe(1);
    expect(timerHarness.getPendingTimerCount()).toBe(0);
    const oldEpoch = runtimeHarness.snapshot.getView().token.dayEpoch;
    await runtimeHarness.snapshot.requestClear({ reason: 'DAY_CUT', dayEpoch: oldEpoch + 1 });
    runtimeHarness.runtime.start();
    runtimeHarness.runtime.handoffPendingSwitch({
      direction: 'LONG',
      monitorContext: stopMonitorContext,
      driveResult: createWaitResult([
        { kind: 'SYMBOL_QUOTE', symbol: 'BULL.HK' },
        { kind: 'RETRY_TIMER', atMs: 20100 },
      ]),
    });
    await waitTick();
    expect(retainedOwners).toHaveLength(1);
    expect(releasedOwners).toEqual(retainedOwners);
    expect(timerHarness.getPendingTimerCount()).toBe(0);
    expect(advanceCalls).toBe(1);
    await runtimeHarness.runtime.stopAndDrain();
    expect(runtimeHarness.consistencyHarness.getFreshListenerCount()).toBe(0);
  });

  it('does not keep retry timers registered when stopAndDrain races with an in-flight advance', async () => {
    const timerHarness = createTimerHarness(30_000);
    const firstAdvance = createDeferred();
    let advanceCalls = 0;
    const runtimeHarness = await createBaseHarness({
      timerHarness,
      seatSwitch: {
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
    const runtimeHarness = await createBaseHarness({
      startSettlement: false,
      stateFixtures: createRuntimeStateFixtures({
        tradingTimeState: { canTrade: false, isHalfDay: false },
        lifecycleState: { isTradingEnabled: false },
      }),
      seatSwitch: {
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

    await runtimeHarness.consistencyHarness.refreshFacts();
    await waitTick();
    expect(advanceCalls).toBe(0);

    runtimeHarness.stateFixtures.tradingTimeState.canTrade = true;
    runtimeHarness.stateFixtures.lifecycleState.isTradingEnabled = true;
    await runtimeHarness.consistencyHarness.startBaseline();
    await runtimeHarness.consistencyHarness.refreshFacts();
    await waitTick();

    expect(advanceCalls).toBe(0);
    await runtimeHarness.runtime.stopAndDrain();
  });

  it('keeps an existing pending switch route through lunch and re-drives it when the gate reopens', async () => {
    let advanceCalls = 0;
    const tradingGateHarness = createTradingGateHarness();
    const runtimeHarness = await createBaseHarness({
      tradingGateEventRuntime: tradingGateHarness.port,
      seatSwitch: {
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

    runtimeHarness.stateFixtures.tradingTimeState.canTrade = false;
    tradingGateHarness.emit({ previousCanTrade: true, nextCanTrade: false });
    await waitTick();
    expect(advanceCalls).toBe(0);

    runtimeHarness.stateFixtures.tradingTimeState.canTrade = true;
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
    const runtimeHarness = await createBaseHarness({
      tradingGateEventRuntime: tradingGateHarness.port,
      seatSwitch: {
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
    await runtimeHarness.consistencyHarness.refreshFacts();
    await advanceStarted.promise;

    runtimeHarness.stateFixtures.tradingTimeState.canTrade = false;
    tradingGateHarness.emit({ previousCanTrade: true, nextCanTrade: false });
    releaseFirstAdvance.resolve();
    await waitTick();
    await waitTick();

    expect(canContinueDuringLunch).toEqual([false]);
    expect(advanceCalls).toBe(1);

    runtimeHarness.stateFixtures.tradingTimeState.canTrade = true;
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
    const runtimeHarness = await createBaseHarness({
      seatSwitch: {
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
    await runtimeHarness.consistencyHarness.refreshFacts();
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
    const runtimeHarness = await createBaseHarness({
      tradingGateEventRuntime: tradingGateHarness.port,
      seatSwitch: {
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

    runtimeHarness.stateFixtures.lifecycleState.isTradingEnabled = false;
    runtimeHarness.stateFixtures.tradingTimeState.canTrade = false;
    tradingGateHarness.emit({ previousCanTrade: true, nextCanTrade: false });
    await waitTick();

    runtimeHarness.stateFixtures.lifecycleState.isTradingEnabled = true;
    runtimeHarness.stateFixtures.tradingTimeState.canTrade = true;
    await runtimeHarness.consistencyHarness.refreshFacts();
    await waitTick();

    expect(advanceCalls).toBe(0);
    await runtimeHarness.runtime.stopAndDrain();
  });

  it.each(['OTHER_SYMBOL', 'STALE_ROUTE', 'STOPPED'] as const)(
    'does not latch an unindexed order event for %s during WAIT return',
    async (scope) => {
      const returning = createDeferred();
      let calls = 0;
      const h = await createBaseHarness({
        seatSwitch: createSeatSwitchWorkflowDouble({
          hasPendingSwitch: () => true,
          advancePendingSwitch: async (params) => {
            calls++;
            await returning.promise;
            return {
              advanced: true,
              direction: params.direction,
              stillPending: true,
              driveResult: createWaitResult([{ kind: 'ORDER_EVENT', symbols: ['BULL.HK'] }]),
            };
          },
        }),
      });
      try {
        h.runtime.start();
        h.runtime.handoffPendingSwitch({
          direction: 'LONG',
          monitorContext: h.monitorContext,
          driveResult: createWaitResult([{ kind: 'RETRY_TIMER', atMs: 1000 }]),
        });
        h.timerHarness.fireDueTimers();
        await waitTick();
        expect(calls).toBe(1);
        if (scope === 'STALE_ROUTE')
          h.symbolRegistry.updateSeatStateWithVersionBump('LONG', {
            ...h.symbolRegistry.getSeatState('LONG'),
            lastSeatActivatedAt: 2,
          });

        if (scope === 'STOPPED') h.runtime.stop();

        emitOrderStateChanged(scope === 'OTHER_SYMBOL' ? 'OTHER.HK' : 'BULL.HK');
        returning.resolve();
        await waitTick();
        await waitTick();
        expect(calls).toBe(1);
      } finally {
        returning.resolve();
        await h.runtime.stopAndDrain();
      }
    },
  );

  it('collapses concurrent wakeups to the latest pending execution for the same route', async () => {
    const firstAdvance = createDeferred();
    const observedPositionQuantities: ReadonlyArray<number>[] = [];
    let callCount = 0;
    const runtimeHarness = await createBaseHarness({
      seatSwitch: {
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
        }),
        resetAllState: () => {},
      },
    });
    const monitorContext = runtimeHarness.monitorContext;

    await runtimeHarness.commitPositions([
      createPositionDouble({ symbol: 'BULL.HK', quantity: 100, availableQuantity: 100 }),
    ]);

    runtimeHarness.runtime.start();
    runtimeHarness.runtime.handoffPendingSwitch({
      direction: 'LONG',
      monitorContext,
      driveResult: createWaitResult([{ kind: 'ORDER_EVENT', symbols: ['BULL.HK'] }]),
    });

    emitOrderStateChanged('BULL.HK');
    await waitTick();
    await runtimeHarness.commitPositions([
      createPositionDouble({ symbol: 'BULL.HK', quantity: 200, availableQuantity: 200 }),
    ]);

    await runtimeHarness.commitPositions([
      createPositionDouble({ symbol: 'BULL.HK', quantity: 300, availableQuantity: 300 }),
    ]);
    emitOrderStateChanged('BULL.HK');
    await waitTick();

    firstAdvance.resolve();
    await waitTick();
    await waitTick();

    expect(observedPositionQuantities).toEqual([[100], [300]]);
    await runtimeHarness.runtime.stopAndDrain();
  });

  it('keeps the pending owner but does not advance it after doomsday takeover begins during advance', async () => {
    const beforeTakeoverMs = Date.parse('2026-02-16T07:54:59.000Z');
    const takeoverMs = Date.parse('2026-02-16T07:55:00.000Z');
    let currentNowMs = beforeTakeoverMs;
    let advanceCalls = 0;
    let retained = 0;
    let released = 0;
    const advanceStarted = createDeferred();
    const releaseAdvance = createDeferred();
    const runtimeHarness = await createBaseHarness({
      quoteSubscriptionRuntime: {
        retainSymbols: async () => {
          retained += 1;
        },
        releaseRetain: async () => {
          released += 1;
        },
      },
      doomsdayProtectionEnabled: true,
      now: () => new Date(currentNowMs),
      seatSwitch: {
        evaluatePeriodicSwitchDue: async () => ({ kind: 'NOOP' }),
        startSwitchOnDistance: async (params) => ({
          started: false,
          direction: params.direction,
          driveResult: { kind: 'NOOP' },
        }),
        advancePendingSwitch: async (params) => {
          advanceCalls += 1;
          expect(params.canContinue()).toBe(true);
          advanceStarted.resolve();
          await releaseAdvance.promise;
          expect(params.canContinue()).toBe(false);
          return {
            advanced: true,
            direction: params.direction,
            stillPending: true,
            driveResult: createWaitResult([{ kind: 'RETRY_TIMER', atMs: takeoverMs + 1_000 }]),
          };
        },
        hasPendingSwitch: () => true,
        getPeriodicSwitchPendingState: () => ({ pending: false }),
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

    expect(advanceCalls).toBe(1);
    expect(retained).toBe(1);
    expect(released).toBe(1);
    expect(runtimeHarness.timerHarness.getPendingTimerCount()).toBe(1);
    runtimeHarness.timerHarness.setNow(takeoverMs + 1000);
    runtimeHarness.timerHarness.fireDueTimers();
    emitQuoteUpdated('BULL.HK', 1.24);
    emitOrderStateChanged('BULL.HK');
    await waitTick();
    expect(advanceCalls).toBe(1);
    await runtimeHarness.runtime.stopAndDrain();
    expect(runtimeHarness.timerHarness.getPendingTimerCount()).toBe(0);
    expect(quoteUpdatedListener).toBeNull();
    expect(orderStateChangedListener).toBeNull();
  });

  describe('switch owner drain settlement', () => {
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
        const harness = await createBaseHarness({
          termination,
          quoteSubscriptionRuntime: { retainSymbols: retainWork, releaseRetain: releaseWork },
        });
        stopOwner = () => {
          harness.runtime.stop();
        };
        harness.runtime.start();
        harness.runtime.handoffPendingSwitch({
          direction: 'LONG',
          monitorContext: harness.monitorContext,
          driveResult: createWaitResult([{ kind: 'SYMBOL_QUOTE', symbol: 'BULL.HK' }]),
        });
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
        harness.runtime.handoffPendingSwitch({
          direction: 'LONG',
          monitorContext: harness.monitorContext,
          driveResult: createWaitResult([{ kind: 'SYMBOL_QUOTE', symbol: 'BULL.HK' }]),
        });
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
        const harness = await createBaseHarness({
          quoteSubscriptionRuntime: { retainSymbols: retainWork, releaseRetain: releaseWork },
        });
        harness.runtime.start();
        harness.runtime.handoffPendingSwitch({
          direction: 'LONG',
          monitorContext: harness.monitorContext,
          driveResult: createWaitResult([{ kind: 'SYMBOL_QUOTE', symbol: 'BULL.HK' }]),
        });
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
});
