import type { TradeRuntime } from '../../../src/app/runtime/types.js';
import type { RuntimeStateFixtures } from '../../helpers/types.js';

/** 成交后 workflow 业务测试：完整刷新/完成事务、单次绑定、受控 baseline、重试与生命周期排空。 */
import { createAccountPositionSnapshot } from '../../../src/application/accountPositionSnapshot/index.js';
import { createQuoteSubscriptionRuntime } from '../../../src/runtime/quoteSubscriptionRuntime/index.js';
import { createTradingConfig } from '../../../mock/factories/configFactory.js';
import { beforeEach, describe, expect, it } from 'bun:test';
import { createTerminationRuntime } from '../../../src/runtime/lifecycle/terminationRuntime.js';
import { createPostTradeSettlementWorkflow } from '../../../src/application/postTradeSettlement/index.js';
import { createExternalApiRequestError } from '../../helpers/createExternalApiRequestError.js';
import { isExternalApiRequestError } from '../../../src/utils/apiFailure/index.js';
import { API } from '../../../src/constants/index.js';
import type { PostTradeSettlementWorkflow } from '../../../src/application/postTradeSettlement/types.js';
import type { SnapshotToken, AccountPositionSnapshot } from '../../../src/types/accountPosition.js';
import type { RuntimeScheduler } from '../../../src/types/runtime.js';
import type { RiskChecker } from '../../../src/types/riskCheck.js';
import type { PreparedUnrealizedLossData } from '../../../src/types/unrealizedLoss.js';
import {
  createLoggerDouble,
  createSettlementBusinessDeps,
  createAccountSnapshotDouble,
  createDailyLossTrackerDouble,
  createLiquidationCooldownTrackerDouble,
  createMonitorContextDouble,
  createMonitorConfigDouble,
  createOrderRecorderDouble,
  createPositionDouble,
  createProtectiveLiquidationEpisodeTrackerDouble,
  createRiskCheckerDouble,
  createSymbolRegistryDouble,
  createTradeRuntimeDouble,
} from '../../helpers/testDoubles.js';

/**
 * 创建可由测试手动控制完成与失败时机的 Promise。
 *
 * @returns 暴露 promise、resolve 与 reject 的 deferred 对象
 */
function createDeferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return {
    promise,
    resolve,
    reject,
  };
}

type ManualScheduler = Readonly<{
  runtime: RuntimeScheduler;
  runNext: (expectedDelayMs: number) => Promise<void>;
  pendingDelays: () => ReadonlyArray<number>;
}>;

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 40; index += 1) {
    await Promise.resolve();
  }
}

/**
 * 创建完全由测试推进的 scheduler，避免成交后一致性测试依赖墙钟。
 *
 * @returns scheduler 契约与按期望延迟推进下一个 timer 的测试端口
 */
function createManualScheduler(onScheduled?: (callback: () => void) => void): ManualScheduler {
  const timers = new Map<
    ReturnType<typeof setTimeout>,
    Readonly<{ callback: () => void; delayMs: number }>
  >();

  return {
    runtime: {
      scheduleTimer: (callback, delayMs) => {
        const handle = setTimeout(() => {}, 2_147_483_647);
        clearTimeout(handle);
        timers.set(handle, { callback, delayMs });
        onScheduled?.(callback);
        return handle;
      },
      clearTimer: (handle) => {
        timers.delete(handle);
      },
    },
    runNext: async (expectedDelayMs) => {
      const next = timers.entries().next().value;
      if (next === undefined) {
        throw new Error(`没有可推进的 ${String(expectedDelayMs)}ms timer`);
      }

      const [handle, timer] = next;
      if (timer.delayMs !== expectedDelayMs) {
        throw new Error(
          `期望推进 ${String(expectedDelayMs)}ms timer，实际为 ${String(timer.delayMs)}ms`,
        );
      }

      timers.delete(handle);
      timer.callback();
      await flushMicrotasks();
    },
    pendingDelays: () => Array.from(timers.values(), ({ delayMs }) => delayMs),
  };
}

let manualScheduler: ManualScheduler;
let termination: ReturnType<typeof createTerminationRuntime>;

beforeEach(() => {
  manualScheduler = createManualScheduler();
  termination = createTerminationRuntime({
    closeTradingGate: () => {},
    closeProducerAdmission: () => {},
    stopProducers: [],
    onSecondaryError: () => {},
  });
});

function createPostTradeHarness(deps: {
  readonly getTradeRuntime: () => TradeRuntime;
  readonly onPositionsCommitted: (token: SnapshotToken) => Promise<void>;
}): { readonly runtime: PostTradeSettlementWorkflow; readonly snapshot: AccountPositionSnapshot } {
  const snapshot = createAccountPositionSnapshot({
    clock: { now: () => new Date(0) },
    diagnostics: { record: () => {} },
    readPort: {
      getAccountSnapshot: () => deps.getTradeRuntime().accountService.getAccountSnapshot(),
      getStockPositions: () => deps.getTradeRuntime().accountService.getStockPositions(),
    },
    scheduler: { schedule: queueMicrotask },
    reportFatalError: termination.reportFatalError,
    dayEpoch: 0,
  });
  return {
    snapshot,
    runtime: createPostTradeSettlementWorkflow({
      clock: { now: () => new Date(0) },
      diagnostics: { record: () => {} },
      hasPendingProtectiveOrders: (direction) =>
        deps.getTradeRuntime().orderMonitor.hasPendingProtectiveLiquidationOrders(direction),
      onPositionsCommitted: deps.onPositionsCommitted,
      snapshot,
      scheduler: manualScheduler.runtime,
      termination,
      logger: createLoggerDouble(),
      retryDelayMs: API.DEFAULT_RETRY_DELAY_MS,
      isExternalFailure: isExternalApiRequestError,
    }),
  };
}

/** 发布阶段才触发业务观察，避免把 prepare 的调用误当作浮亏缓存已发布。 */
function createObservedRiskChecker(
  onPublish: (...params: Parameters<RiskChecker['prepareUnrealizedLossData']>) => void,
): RiskChecker {
  const preparedParams = new WeakMap<
    PreparedUnrealizedLossData,
    Parameters<RiskChecker['prepareUnrealizedLossData']>
  >();
  return createRiskCheckerDouble({
    prepareUnrealizedLossData: (...params) => {
      const prepared = { symbol: params[1], data: { r1: '0', n1: 0 } };
      preparedParams.set(prepared, params);
      return prepared;
    },
    publishUnrealizedLossData: (prepared) => {
      const params = preparedParams.get(prepared);
      if (params === undefined) throw new Error('未准备的浮亏投影');

      onPublish(...params);
    },
  });
}

function createRuntimeStates(): RuntimeStateFixtures {
  return {
    tradingTimeState: { canTrade: true, isHalfDay: false, openProtectionActive: false },
    lifecycleState: {
      currentDayKey: '2026-04-04',
      lifecycleState: 'ACTIVE',
      pendingOpenRebuild: false,
      isTradingEnabled: true,
    },
    tradingCalendarState: { cachedTradingDayInfo: null, tradingCalendarSnapshot: new Map() },
    quoteSubscriptionState: { allTradingSymbols: new Set() },
  };
}

/**
 * 为运行时绑定最小业务依赖，满足 fail-fast 启动前置条件。
 *
 * @param runtime 待绑定的成交后一致性运行时
 */
function bindMinimalBusinessDeps(runtime: PostTradeSettlementWorkflow): void {
  runtime.bindBusinessDeps(
    createSettlementBusinessDeps({
      monitorContext: createMonitorContextDouble({
        config: createMonitorConfigDouble({
          monitorSymbol: 'HSI.HK',
        }),
        symbolRegistry: createSymbolRegistryDouble({
          longSeat: {
            symbol: null,
            status: 'EMPTY',
            lastSwitchAt: null,
            lastSearchAt: null,
            lastSeatActivatedAt: null,
            searchFailCountToday: 0,
            frozenTradingDayKey: null,
          },
          shortSeat: {
            symbol: null,
            status: 'EMPTY',
            lastSwitchAt: null,
            lastSearchAt: null,
            lastSeatActivatedAt: null,
            searchFailCountToday: 0,
            frozenTradingDayKey: null,
          },
        }),
      }),
      dailyLossTracker: createDailyLossTrackerDouble(),
      liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
      protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
      mixedTradeLogRepository: {
        appendCompletionIdempotent: () => {},
      },
    }),
  );
}

describe('PostTradeSettlementWorkflow', () => {
  it('paired external snapshot failure keeps S stale and on its original retry owner, not fatal', async () => {
    const accountError = await createExternalApiRequestError({
      operation: 'TradeContext.accountBalance',
      attempts: 1,
      cause: new Error('account unavailable'),
    });
    const positionsError = await createExternalApiRequestError({
      operation: 'TradeContext.stockPositions',
      attempts: 1,
      cause: new Error('positions unavailable'),
    });
    let failing = true;
    const tradeRuntime = createTradeRuntimeDouble({
      accountService: {
        getAccountSnapshot: async () => {
          if (failing) throw accountError;

          return createAccountSnapshotDouble('100000');
        },
        getStockPositions: async () => {
          if (failing) throw positionsError;

          return [];
        },
      },
    });
    const { runtime } = createPostTradeHarness({
      getTradeRuntime: () => tradeRuntime,
      onPositionsCommitted: async () => {},
    });
    bindMinimalBusinessDeps(runtime);
    runtime.recordSettlementRefreshNeed({ refreshAccount: true, refreshPositions: true });
    runtime.start();
    const waiting = runtime.waitForFresh();
    await manualScheduler.runNext(0);
    expect(runtime.getStatus()).toMatchObject({ currentVersion: 0, staleVersion: 1 });
    expect(manualScheduler.pendingDelays()).toEqual([300]);
    expect(termination.getFatalState()).toEqual({ hasFatalError: false });
    failing = false;
    await manualScheduler.runNext(300);
    await manualScheduler.runNext(0);
    const readiness = await waiting;
    expect(readiness.settlementVersion).toBe(1);
    expect(runtime.getStatus()).toMatchObject({ currentVersion: 1, staleVersion: 1 });
    await runtime.stopAndDrain();
  });

  it('in-flight baseline waiters do not create a second dirty refresh or duplicate ready event', async () => {
    const entered = createDeferred<null>();
    const release = createDeferred<null>();
    let callbacks = 0;
    let events = 0;
    const { runtime, snapshot } = createPostTradeHarness({
      getTradeRuntime: () => createTradeRuntimeDouble(),
      onPositionsCommitted: async () => {
        callbacks += 1;
        entered.resolve(null);
        await release.promise;
      },
    });
    bindMinimalBusinessDeps(runtime);
    await snapshot.requestRefresh({
      source: 'LIFECYCLE_REBUILD',
      dayEpoch: 0,
      refreshAccount: true,
      refreshPositions: true,
    }).result;

    runtime.onFreshReached(() => {
      events += 1;
    });
    runtime.start();
    const completing = runtime.completeRebuildBaseline();
    await entered.promise;
    const first = runtime.waitForFresh();
    const second = runtime.waitForFresh();
    expect(events).toBe(0);
    release.resolve(null);
    expect(await completing).toBe(true);
    expect(await first).toBe(await second);
    expect(callbacks).toBe(1);
    expect(events).toBe(1);
    expect(manualScheduler.pendingDelays()).toEqual([]);
    await runtime.stopAndDrain();
  });

  it('signs a readiness receipt for the paired canonical token and invalidates it on newer settlement demand', async () => {
    const { runtime, snapshot } = createPostTradeHarness({
      getTradeRuntime: () => createTradeRuntimeDouble(),
      onPositionsCommitted: async () => {},
    });
    bindMinimalBusinessDeps(runtime);
    runtime.recordSettlementRefreshNeed({ refreshAccount: true, refreshPositions: true });
    runtime.start();
    const firstWait = runtime.waitForFresh();
    await manualScheduler.runNext(0);
    const first = await firstWait;

    expect(first.snapshotToken).toEqual(snapshot.getView().token);
    expect(first.settlementVersion).toBe(1);
    expect(runtime.isCurrent(first)).toBe(true);
    expect(
      snapshot.isCurrent(first.snapshotToken, { account: true, positions: true, paired: true }),
    ).toBe(true);

    runtime.recordSettlementRefreshNeed({ refreshAccount: true, refreshPositions: true });
    expect(runtime.isCurrent(first)).toBe(false);
    const secondWait = runtime.waitForFresh();
    await manualScheduler.runNext(0);
    const second = await secondWait;
    expect(second.settlementVersion).toBe(2);
    expect(second.snapshotToken.snapshotGeneration).toBeGreaterThan(
      first.snapshotToken.snapshotGeneration,
    );
    expect(runtime.isCurrent(second)).toBe(true);
    expect(runtime.isCurrent(first)).toBe(false);
    await runtime.stopAndDrain();
  });

  it('marks stale before start and consumes the backlog after start while emitting fresh reached event', async () => {
    let accountRefreshCalls = 0;
    let positionRefreshCalls = 0;
    let freshEventCount = 0;

    const { runtime, snapshot } = createPostTradeHarness({
      getTradeRuntime: () =>
        createTradeRuntimeDouble({
          accountService: {
            getAccountSnapshot: async () => {
              accountRefreshCalls += 1;
              return createAccountSnapshotDouble('88000');
            },
            getStockPositions: async () => {
              positionRefreshCalls += 1;
              return [
                createPositionDouble({
                  symbol: 'BULL.HK',
                  quantity: 300,
                  availableQuantity: 300,
                }),
              ];
            },
          },
        }),
      onPositionsCommitted: async () => {},
    });

    runtime.onFreshReached(() => {
      freshEventCount += 1;
    });

    bindMinimalBusinessDeps(runtime);
    runtime.recordSettlementRefreshNeed({
      refreshAccount: true,
      refreshPositions: true,
    });

    expect(accountRefreshCalls).toBe(0);
    expect(positionRefreshCalls).toBe(0);
    expect(manualScheduler.pendingDelays()).toEqual([]);
    expect(runtime.getStatus()).toEqual({
      started: false,
      currentVersion: 0,
      staleVersion: 1,
    });

    const fresh = runtime.waitForFresh();
    runtime.start();
    expect(manualScheduler.pendingDelays()).toEqual([0]);
    await manualScheduler.runNext(0);
    await fresh;
    await runtime.stopAndDrain();

    expect(accountRefreshCalls).toBe(1);
    expect(positionRefreshCalls).toBe(1);
    expect(snapshot.getView().positions).toHaveLength(1);
    expect(snapshot.getAvailablePosition('BULL.HK')?.quantity).toBe(300);
    expect(freshEventCount).toBe(1);

    expect(runtime.getStatus()).toEqual({
      started: false,
      currentVersion: 1,
      staleVersion: 1,
    });
  });

  it('awaits positions committed hook after writing latest positions', async () => {
    const committedSnapshots: Array<{
      readonly cachedPositionCount: number;
      readonly cacheQuantity: number | null;
    }> = [];
    const { runtime, snapshot } = createPostTradeHarness({
      getTradeRuntime: () =>
        createTradeRuntimeDouble({
          accountService: {
            getAccountSnapshot: async () => createAccountSnapshotDouble('88000'),
            getStockPositions: async () => [
              createPositionDouble({
                symbol: 'BULL.HK',
                quantity: 300,
                availableQuantity: 300,
              }),
            ],
          },
        }),
      onPositionsCommitted: async () => {
        await Promise.resolve();
        committedSnapshots.push({
          cachedPositionCount: snapshot.getView().positions.length,
          cacheQuantity: snapshot.getAvailablePosition('BULL.HK')?.quantity ?? null,
        });
      },
    });

    bindMinimalBusinessDeps(runtime);
    runtime.recordSettlementRefreshNeed({
      refreshAccount: true,
      refreshPositions: true,
    });

    const fresh = runtime.waitForFresh();
    runtime.start();
    await manualScheduler.runNext(0);
    await fresh;
    await runtime.stopAndDrain();

    expect(committedSnapshots).toEqual([
      {
        cachedPositionCount: 1,
        cacheQuantity: 300,
      },
    ]);

    expect(runtime.getStatus()).toEqual({
      started: false,
      currentVersion: 1,
      staleVersion: 1,
    });
  });

  it('retries to the latest stale version after an in-flight failure receives a newer settlement need', async () => {
    const firstAccountRefresh = createDeferred<ReturnType<typeof createAccountSnapshotDouble>>();
    const firstPositionRefresh =
      createDeferred<ReadonlyArray<ReturnType<typeof createPositionDouble>>>();
    let accountRefreshCalls = 0;
    let positionRefreshCalls = 0;

    const { runtime, snapshot } = createPostTradeHarness({
      getTradeRuntime: () =>
        createTradeRuntimeDouble({
          accountService: {
            getAccountSnapshot: async () => {
              accountRefreshCalls += 1;
              if (accountRefreshCalls === 1) {
                return firstAccountRefresh.promise;
              }

              return createAccountSnapshotDouble('99000');
            },
            getStockPositions: async () => {
              positionRefreshCalls += 1;
              if (positionRefreshCalls === 1) {
                return firstPositionRefresh.promise;
              }

              return [
                createPositionDouble({
                  symbol: 'BULL.HK',
                  quantity: 500,
                  availableQuantity: 500,
                }),
              ];
            },
          },
        }),
      onPositionsCommitted: async () => {},
    });

    bindMinimalBusinessDeps(runtime);
    runtime.recordSettlementRefreshNeed({
      refreshAccount: true,
      refreshPositions: true,
    });
    runtime.start();
    await manualScheduler.runNext(0);
    expect(accountRefreshCalls).toBe(1);

    runtime.recordSettlementRefreshNeed({
      refreshAccount: true,
      refreshPositions: true,
    });

    const staleStatus = runtime.getStatus();
    expect(staleStatus.staleVersion).toBe(2);
    expect(staleStatus.currentVersion).toBe(0);

    firstAccountRefresh.reject(
      await createExternalApiRequestError({
        operation: 'TradeContext.accountBalance',
        attempts: 1,
        cause: new Error('first refresh fails'),
      }),
    );

    firstPositionRefresh.resolve([
      createPositionDouble({
        symbol: 'BULL.HK',
        quantity: 300,
        availableQuantity: 300,
      }),
    ]);
    await flushMicrotasks();

    expect(manualScheduler.pendingDelays()).toEqual([300]);
    await manualScheduler.runNext(300);
    expect(manualScheduler.pendingDelays()).toEqual([0]);
    const fresh = runtime.waitForFresh();
    await manualScheduler.runNext(0);
    await fresh;

    expect(accountRefreshCalls).toBe(2);
    expect(positionRefreshCalls).toBe(2);
    expect(snapshot.getView().positions).toHaveLength(1);
    expect(snapshot.getAvailablePosition('BULL.HK')?.quantity).toBe(500);
    expect(runtime.getStatus()).toEqual({
      started: true,
      currentVersion: 2,
      staleVersion: 2,
    });

    await runtime.stopAndDrain();
  });

  it('retries failed refresh and still refreshes all currently attributed seat symbols after recovery', async () => {
    let accountCallCount = 0;
    const refreshedSymbols: string[] = [];

    const monitorContext = createMonitorContextDouble({
      config: createMonitorConfigDouble({
        monitorSymbol: 'HSI.HK',
        maxUnrealizedLossPerSymbol: '2000',
      }),
      symbolRegistry: createSymbolRegistryDouble({
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
      }),
      orderRecorder: createOrderRecorderDouble(),
      dailyLossTracker: createDailyLossTrackerDouble({
        getLossOffset: () => '0',
      }),
      riskChecker: createObservedRiskChecker((_orderRecorder, symbol) => {
        refreshedSymbols.push(symbol);
      }),
    });

    const { runtime } = createPostTradeHarness({
      getTradeRuntime: () =>
        createTradeRuntimeDouble({
          accountService: {
            getAccountSnapshot: async () => {
              accountCallCount += 1;
              if (accountCallCount === 1) {
                throw await createExternalApiRequestError({
                  operation: 'TradeContext.accountBalance',
                  attempts: 1,
                  cause: new Error('account API temporary unavailable'),
                });
              }

              return createAccountSnapshotDouble('66000');
            },
            getStockPositions: async () => [
              createPositionDouble({
                symbol: 'BULL.HK',
                quantity: 300,
                availableQuantity: 300,
              }),
            ],
          },
        }),
      onPositionsCommitted: async () => {},
    });
    runtime.bindBusinessDeps(
      createSettlementBusinessDeps({
        monitorContext,
        dailyLossTracker: createDailyLossTrackerDouble(),
        liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
        protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
        mixedTradeLogRepository: {
          appendCompletionIdempotent: () => {},
        },
      }),
    );

    runtime.recordSettlementRefreshNeed({
      refreshAccount: true,
      refreshPositions: true,
    });
    const fresh = runtime.waitForFresh();
    runtime.start();
    await manualScheduler.runNext(0);
    expect(manualScheduler.pendingDelays()).toEqual([300]);
    await manualScheduler.runNext(300);
    await manualScheduler.runNext(0);
    await fresh;
    await runtime.stopAndDrain();

    expect(accountCallCount).toBeGreaterThanOrEqual(2);
    expect(new Set(refreshedSymbols)).toEqual(new Set(['BULL.HK', 'BEAR.HK']));
    expect(runtime.getStatus()).toEqual({
      started: false,
      currentVersion: 1,
      staleVersion: 1,
    });
  });

  it('lets a new settlement need preempt the 300ms retry and clears the superseded timer', async () => {
    let accountRefreshCalls = 0;
    const { runtime } = createPostTradeHarness({
      getTradeRuntime: () =>
        createTradeRuntimeDouble({
          accountService: {
            getAccountSnapshot: async () => {
              accountRefreshCalls += 1;
              if (accountRefreshCalls === 1) {
                throw await createExternalApiRequestError({
                  operation: 'TradeContext.accountBalance',
                  attempts: 1,
                  cause: new Error('temporary failure'),
                });
              }

              return createAccountSnapshotDouble('88000');
            },
          },
        }),
      onPositionsCommitted: async () => {},
    });

    bindMinimalBusinessDeps(runtime);
    runtime.recordSettlementRefreshNeed({ refreshAccount: true, refreshPositions: false });
    runtime.start();
    await manualScheduler.runNext(0);
    expect(manualScheduler.pendingDelays()).toEqual([300]);

    runtime.recordSettlementRefreshNeed({ refreshAccount: true, refreshPositions: false });
    expect(manualScheduler.pendingDelays()).toEqual([0]);

    const fresh = runtime.waitForFresh();
    await manualScheduler.runNext(0);
    await fresh;

    expect(accountRefreshCalls).toBe(2);
    expect(runtime.getStatus()).toEqual({
      started: true,
      currentVersion: 2,
      staleVersion: 2,
    });
    await runtime.stopAndDrain();
  });

  it('clears a queued 0ms run on stop but preserves its need for the next start', async () => {
    let accountRefreshCalls = 0;
    const { runtime } = createPostTradeHarness({
      getTradeRuntime: () =>
        createTradeRuntimeDouble({
          accountService: {
            getAccountSnapshot: async () => {
              accountRefreshCalls += 1;
              return createAccountSnapshotDouble('88000');
            },
          },
        }),
      onPositionsCommitted: async () => {},
    });

    bindMinimalBusinessDeps(runtime);
    runtime.recordSettlementRefreshNeed({ refreshAccount: true, refreshPositions: false });
    runtime.start();
    expect(manualScheduler.pendingDelays()).toEqual([0]);

    await runtime.stopAndDrain();
    expect(manualScheduler.pendingDelays()).toEqual([]);
    expect(accountRefreshCalls).toBe(0);

    runtime.resetAbort();
    const fresh = runtime.waitForFresh();
    runtime.start();
    expect(manualScheduler.pendingDelays()).toEqual([0]);
    await manualScheduler.runNext(0);
    await fresh;
    expect(accountRefreshCalls).toBe(1);
    await runtime.stopAndDrain();
  });

  it('clears a queued 300ms retry and discards its need during midnight cleanup', async () => {
    let accountRefreshCalls = 0;
    const { runtime } = createPostTradeHarness({
      getTradeRuntime: () =>
        createTradeRuntimeDouble({
          accountService: {
            getAccountSnapshot: async () => {
              accountRefreshCalls += 1;
              throw await createExternalApiRequestError({
                operation: 'TradeContext.accountBalance',
                attempts: 1,
                cause: new Error('temporary failure'),
              });
            },
          },
        }),
      onPositionsCommitted: async () => {},
    });

    bindMinimalBusinessDeps(runtime);
    runtime.recordSettlementRefreshNeed({ refreshAccount: true, refreshPositions: false });
    runtime.start();
    await manualScheduler.runNext(0);
    expect(manualScheduler.pendingDelays()).toEqual([300]);

    runtime.midnightClear();
    expect(manualScheduler.pendingDelays()).toEqual([]);
    runtime.start();
    expect(manualScheduler.pendingDelays()).toEqual([]);
    expect(accountRefreshCalls).toBe(1);
    await runtime.stopAndDrain();
  });

  it('keeps the attributed direction snapshot stable while refreshing seat symbols', async () => {
    const riskRefreshCalls: Array<{
      readonly symbol: string;
      readonly isLongSymbol: boolean;
      readonly dailyLossOffset: string | undefined;
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
    const monitorContext = createMonitorContextDouble({
      config: createMonitorConfigDouble({
        monitorSymbol: 'HSI.HK',
      }),
      symbolRegistry,
      dailyLossTracker: createDailyLossTrackerDouble({
        getLossOffset: (direction) => (direction === 'LONG' ? '11' : '22'),
      }),
      riskChecker: createObservedRiskChecker(
        (_orderRecorder, symbol, isLongSymbol, dailyLossOffset) => {
          riskRefreshCalls.push({ symbol, isLongSymbol, dailyLossOffset });
          if (symbol === 'BULL.HK') {
            symbolRegistry.updateSeatState('LONG', {
              symbol: 'BEAR.HK',
              status: 'ACTIVE',
              lastSwitchAt: null,
              lastSearchAt: null,
              lastSeatActivatedAt: 1,
              searchFailCountToday: 0,
              frozenTradingDayKey: null,
            });
          }
        },
      ),
    });
    const { runtime } = createPostTradeHarness({
      getTradeRuntime: () =>
        createTradeRuntimeDouble({
          accountService: {
            getAccountSnapshot: async () => createAccountSnapshotDouble('66000'),
            getStockPositions: async () => [],
          },
        }),
      onPositionsCommitted: async () => {},
    });
    runtime.bindBusinessDeps(
      createSettlementBusinessDeps({
        monitorContext,
        dailyLossTracker: createDailyLossTrackerDouble(),
        liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
        protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
        mixedTradeLogRepository: {
          appendCompletionIdempotent: () => {},
        },
      }),
    );

    runtime.recordSettlementRefreshNeed({
      refreshAccount: true,
      refreshPositions: true,
    });
    const fresh = runtime.waitForFresh();
    runtime.start();
    await manualScheduler.runNext(0);
    await fresh;
    await runtime.stopAndDrain();

    expect(riskRefreshCalls).toEqual([
      {
        symbol: 'BULL.HK',
        isLongSymbol: true,
        dailyLossOffset: '11',
      },
      {
        symbol: 'BEAR.HK',
        isLongSymbol: false,
        dailyLossOffset: '22',
      },
    ]);
  });

  it('fails fast when account refresh hits TypeError and exposes the fatal channel immediately', async () => {
    let accountCallCount = 0;
    const { runtime } = createPostTradeHarness({
      getTradeRuntime: () =>
        createTradeRuntimeDouble({
          accountService: {
            getAccountSnapshot: async () => {
              accountCallCount += 1;
              throw new TypeError('TradeContext.accountBalance returned no primary account');
            },
            getStockPositions: async () => [],
          },
        }),
      onPositionsCommitted: async () => {},
    });

    bindMinimalBusinessDeps(runtime);
    runtime.recordSettlementRefreshNeed({
      refreshAccount: true,
      refreshPositions: false,
    });

    const waiterResult = runtime.waitForFresh().then(
      () => null,
      (error: unknown) => error,
    );
    const fatalResult = termination
      .waitForTermination()
      .then(() => {
        const state = termination.getFatalState();
        if (state.hasFatalError) throw state.error;

        throw new Error('expected fatal');
      })
      .then(
        () => null,
        (error: unknown) => error,
      );

    runtime.start();
    await manualScheduler.runNext(0);

    const waitError = await waiterResult;
    const fatalError = await fatalResult;
    let drainError: unknown = null;
    try {
      await runtime.stopAndDrain();
    } catch (error) {
      drainError = error;
    }

    expect(fatalError).toBeInstanceOf(TypeError);
    expect((fatalError as Error).message).toBe(
      'TradeContext.accountBalance returned no primary account',
    );
    expect(drainError).toBeInstanceOf(TypeError);
    expect((drainError as Error).message).toBe(
      'TradeContext.accountBalance returned no primary account',
    );
    expect(waitError).toBeInstanceOf(Error);
    expect((waitError as Error).message).toBe(
      '[postTradeConsistencyRuntime] freshness wait aborted: FATAL_INVARIANT',
    );
    expect(accountCallCount).toBe(1);
    expect(runtime.getStatus()).toEqual({
      started: false,
      currentVersion: 0,
      staleVersion: 1,
    });
  });

  it('fails fast when positions committed hook throws ordinary Error', async () => {
    const internalError = new Error('position commit failed');
    const { runtime } = createPostTradeHarness({
      getTradeRuntime: () =>
        createTradeRuntimeDouble({
          accountService: {
            getAccountSnapshot: async () => createAccountSnapshotDouble('100'),
            getStockPositions: async () => [
              createPositionDouble({
                symbol: 'BULL.HK',
                quantity: 1,
                availableQuantity: 1,
              }),
            ],
          },
        }),
      onPositionsCommitted: async () => {
        throw internalError;
      },
    });

    bindMinimalBusinessDeps(runtime);
    runtime.recordSettlementRefreshNeed({
      refreshAccount: true,
      refreshPositions: true,
    });

    const fatalPromise = termination
      .waitForTermination()
      .then(() => {
        const state = termination.getFatalState();
        if (state.hasFatalError) throw state.error;

        throw new Error('expected fatal');
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    runtime.start();
    await manualScheduler.runNext(0);
    const fatalResult = await fatalPromise;

    let drainError: unknown = null;
    try {
      await runtime.stopAndDrain();
    } catch (error) {
      drainError = error;
    }

    expect(fatalResult).toBe(internalError);
    expect(drainError).toBe(internalError);
    expect(runtime.getStatus()).toEqual({
      started: false,
      currentVersion: 0,
      staleVersion: 1,
    });
  });

  it('fails fast when unrealized loss refresh hits TypeError and does not schedule retry', async () => {
    let accountCallCount = 0;
    let riskRefreshCallCount = 0;

    const monitorContext = createMonitorContextDouble({
      config: createMonitorConfigDouble({
        monitorSymbol: 'HSI.HK',
      }),
      symbolRegistry: createSymbolRegistryDouble({
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
          symbol: null,
          status: 'EMPTY',
          lastSwitchAt: null,
          lastSearchAt: null,
          lastSeatActivatedAt: null,
          searchFailCountToday: 0,
          frozenTradingDayKey: null,
        },
      }),
      riskChecker: createObservedRiskChecker(() => {
        riskRefreshCallCount += 1;
        throw new TypeError('refresh unrealized loss contract violated');
      }),
    });

    const { runtime } = createPostTradeHarness({
      getTradeRuntime: () =>
        createTradeRuntimeDouble({
          accountService: {
            getAccountSnapshot: async () => {
              accountCallCount += 1;
              return createAccountSnapshotDouble('77000');
            },
            getStockPositions: async () => [
              createPositionDouble({
                symbol: 'BULL.HK',
                quantity: 300,
                availableQuantity: 300,
              }),
            ],
          },
        }),
      onPositionsCommitted: async () => {},
    });

    runtime.bindBusinessDeps(
      createSettlementBusinessDeps({
        monitorContext,
        dailyLossTracker: createDailyLossTrackerDouble(),
        liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
        protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
        mixedTradeLogRepository: {
          appendCompletionIdempotent: () => {},
        },
      }),
    );

    runtime.recordSettlementRefreshNeed({
      refreshAccount: true,
      refreshPositions: true,
    });

    const waiterResult = runtime.waitForFresh().then(
      () => null,
      (error: unknown) => error,
    );

    runtime.start();
    await manualScheduler.runNext(0);

    const waitError = await waiterResult;
    let drainError: unknown = null;
    try {
      await runtime.stopAndDrain();
    } catch (error) {
      drainError = error;
    }

    expect(drainError).toBeInstanceOf(TypeError);
    expect((drainError as Error).message).toBe('refresh unrealized loss contract violated');
    expect(waitError).toBeInstanceOf(Error);
    expect((waitError as Error).message).toBe(
      '[postTradeConsistencyRuntime] freshness wait aborted: FATAL_INVARIANT',
    );
    expect(accountCallCount).toBe(1);
    expect(riskRefreshCallCount).toBe(1);
    expect(runtime.getStatus()).toEqual({
      started: false,
      currentVersion: 0,
      staleVersion: 1,
    });
  });

  it('completes protective liquidation episodes and advances daily loss plus cooldown after positions refresh', async () => {
    const committedProtectionBoundaryCalls: Array<{
      direction: 'LONG' | 'SHORT';
      boundaryExecutedTimeMs: number;
    }> = [];
    const cooldownCalls: Array<{
      direction: 'LONG' | 'SHORT';
      executedTimeMs: number;
      triggerLimit: number;
    }> = [];
    const pendingProtectiveDirections: Array<'LONG' | 'SHORT'> = [];
    const riskRefreshCalls: Array<{
      symbol: string;
      isLongSymbol: boolean;
      dailyLossOffset: string | undefined;
    }> = [];
    const protectiveBoundaryMs = 1_712_222_333_000;

    const monitorContext = createMonitorContextDouble({
      config: createMonitorConfigDouble({
        monitorSymbol: 'HSI.HK',
        liquidationTriggerLimit: 2,
      }),
      symbolRegistry: createSymbolRegistryDouble({
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
          symbol: null,
          status: 'EMPTY',
          lastSwitchAt: null,
          lastSearchAt: null,
          lastSeatActivatedAt: null,
          searchFailCountToday: 0,
          frozenTradingDayKey: null,
        },
      }),
      orderRecorder: createOrderRecorderDouble(),
      dailyLossTracker: createDailyLossTrackerDouble({
        getLossOffset: () => '88',
      }),
      riskChecker: createObservedRiskChecker(
        (_orderRecorder, symbol, isLongSymbol, dailyLossOffset) => {
          riskRefreshCalls.push({ symbol, isLongSymbol, dailyLossOffset });
        },
      ),
    });

    const { runtime, snapshot } = createPostTradeHarness({
      getTradeRuntime: () =>
        createTradeRuntimeDouble({
          accountService: {
            getAccountSnapshot: async () => createAccountSnapshotDouble('77000'),
            getStockPositions: async () => [],
          },
          orderMonitor: {
            hasPendingProtectiveLiquidationOrders: (direction) => {
              pendingProtectiveDirections.push(direction);
              return false;
            },
          },
        }),
      onPositionsCommitted: async () => {},
    });
    runtime.bindBusinessDeps(
      createSettlementBusinessDeps({
        monitorContext,
        dailyLossTracker: createDailyLossTrackerDouble({
          prepareProtectionBoundary: (params) => ({ ...params, orderBaselines: [] }),
          commitProtectionBoundary: (params) => {
            committedProtectionBoundaryCalls.push({
              direction: params.direction,
              boundaryExecutedTimeMs: params.boundaryExecutedTimeMs,
            });
          },
        }),
        liquidationCooldownTracker: createLiquidationCooldownTrackerDouble({
          recordLiquidationTrigger: (params) => {
            cooldownCalls.push({
              direction: params.direction,
              executedTimeMs: params.executedTimeMs,
              triggerLimit: params.triggerLimit,
            });
          },
        }),
        protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble({
          getInProgressEpisodes: () => [
            {
              direction: 'LONG',
              symbol: 'BULL.HK',
              latestExecutedTimeMs: protectiveBoundaryMs,
            },
          ],
          prepareCompletion: () => ({
            direction: 'LONG',
            boundaryExecutedTimeMs: protectiveBoundaryMs,
          }),
          commitCompletion: () => {},
        }),
        mixedTradeLogRepository: {
          appendCompletionIdempotent: () => {},
        },
      }),
    );

    runtime.recordSettlementRefreshNeed({
      refreshAccount: true,
      refreshPositions: true,
    });
    const fresh = runtime.waitForFresh();
    runtime.start();
    await manualScheduler.runNext(0);
    await fresh;
    await runtime.stopAndDrain();
    expect(snapshot.getView().positions).toEqual([]);
    expect(pendingProtectiveDirections).toEqual(['LONG', 'LONG']);
    expect(committedProtectionBoundaryCalls).toEqual([
      {
        direction: 'LONG',
        boundaryExecutedTimeMs: protectiveBoundaryMs,
      },
    ]);

    expect(cooldownCalls).toEqual([
      {
        direction: 'LONG',
        executedTimeMs: protectiveBoundaryMs,
        triggerLimit: 2,
      },
    ]);

    expect(riskRefreshCalls).toEqual([
      {
        symbol: 'BULL.HK',
        isLongSymbol: true,
        dailyLossOffset: '88',
      },
    ]);
  });

  it('keeps daily loss, cooldown, and episode uncommitted when completion persistence fails', async () => {
    const boundaryExecutedTimeMs = Date.parse('2026-07-11T03:00:00.000Z');
    const commits: string[] = [];
    const { runtime } = createPostTradeHarness({
      getTradeRuntime: () =>
        createTradeRuntimeDouble({
          accountService: {
            getAccountSnapshot: async () => createAccountSnapshotDouble('10000'),
            getStockPositions: async () => [],
          },
          orderMonitor: { hasPendingProtectiveLiquidationOrders: () => false },
        }),
      onPositionsCommitted: async () => {},
    });
    runtime.bindBusinessDeps(
      createSettlementBusinessDeps({
        monitorContext: createMonitorContextDouble({
          config: createMonitorConfigDouble({ monitorSymbol: 'HSI.HK' }),
        }),
        dailyLossTracker: createDailyLossTrackerDouble({
          prepareProtectionBoundary: (params) => ({ ...params, orderBaselines: [] }),
          commitProtectionBoundary: () => {
            commits.push('daily');
          },
        }),
        liquidationCooldownTracker: createLiquidationCooldownTrackerDouble({
          recordLiquidationTrigger: () => {
            commits.push('cooldown');
          },
        }),
        protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble({
          getInProgressEpisodes: () => [
            { direction: 'LONG', symbol: 'BULL.HK', latestExecutedTimeMs: boundaryExecutedTimeMs },
          ],
          prepareCompletion: () => ({
            direction: 'LONG',
            boundaryExecutedTimeMs,
          }),
          commitCompletion: () => {
            commits.push('episode');
          },
        }),
        mixedTradeLogRepository: {
          appendCompletionIdempotent: () => {
            throw new Error('persist failed');
          },
        },
      }),
    );

    runtime.recordSettlementRefreshNeed({ refreshAccount: true, refreshPositions: true });
    const waitResult = runtime.waitForFresh().catch((error: unknown) => error);
    runtime.start();
    await manualScheduler.runNext(0);

    const waitError = await waitResult;
    expect(runtime.stopAndDrain()).rejects.toThrow('persist failed');
    expect(waitError).toBeInstanceOf(Error);
    expect(commits).toEqual([]);
  });

  it('fails fast when start is called before bindBusinessDeps', () => {
    const { runtime } = createPostTradeHarness({
      getTradeRuntime: () => createTradeRuntimeDouble(),
      onPositionsCommitted: async () => {},
    });

    expect(() => {
      runtime.start();
    }).toThrow('[postTradeSettlement] businessDeps 尚未绑定，禁止启动');
  });

  it('fails fast when bindBusinessDeps is called more than once', () => {
    const { runtime } = createPostTradeHarness({
      getTradeRuntime: () => createTradeRuntimeDouble(),
      onPositionsCommitted: async () => {},
    });

    bindMinimalBusinessDeps(runtime);

    expect(() => {
      bindMinimalBusinessDeps(runtime);
    }).toThrow('[postTradeSettlement] businessDeps 已绑定，禁止重复绑定');
  });

  it('fails fast and stops retrying when attributed seat symbols are duplicated', async () => {
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
        symbol: 'BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
    });
    const duplicateMonitorContext = createMonitorContextDouble({
      config: createMonitorConfigDouble({ monitorSymbol: 'HSI.HK' }),
      symbolRegistry,
    });
    const { runtime } = createPostTradeHarness({
      getTradeRuntime: () =>
        createTradeRuntimeDouble({
          accountService: {
            getAccountSnapshot: async () => createAccountSnapshotDouble('10000'),
            getStockPositions: async () => [],
          },
        }),
      onPositionsCommitted: async () => {},
    });
    expect(() => {
      runtime.bindBusinessDeps(
        createSettlementBusinessDeps({
          monitorContext: duplicateMonitorContext,
          dailyLossTracker: createDailyLossTrackerDouble(),
          liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
          protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
          mixedTradeLogRepository: {
            appendCompletionIdempotent: () => {},
          },
        }),
      );
    }).toThrow('重复归属');
  });

  it('invalid baseline stops ordinary timers without clearing pending work; explicit rebuild consumes it before fresh', async () => {
    let freshEventCount = 0;
    const { runtime, snapshot } = createPostTradeHarness({
      getTradeRuntime: () => createTradeRuntimeDouble(),
      onPositionsCommitted: async () => {},
    });

    runtime.onFreshReached(() => {
      freshEventCount += 1;
    });

    bindMinimalBusinessDeps(runtime);
    runtime.start();
    runtime.recordSettlementRefreshNeed({
      refreshAccount: true,
      refreshPositions: false,
    });
    await runtime.completeRebuildBaseline();

    expect(runtime.getStatus()).toEqual({
      started: false,
      currentVersion: 0,
      staleVersion: 1,
    });
    expect(freshEventCount).toBe(0);
    expect(manualScheduler.pendingDelays()).toEqual([]);

    snapshot.beginRebuild();
    const baseline = await snapshot.requestRefresh({
      source: 'LIFECYCLE_REBUILD',
      dayEpoch: snapshot.getView().token.dayEpoch,
      refreshAccount: true,
      refreshPositions: true,
    }).result;
    expect(baseline.status).toBe('COMMITTED');
    runtime.start();
    expect(await runtime.completeRebuildBaseline()).toBe(true);

    expect(freshEventCount).toBe(1);

    expect(runtime.getStatus()).toEqual({
      started: true,
      currentVersion: 1,
      staleVersion: 1,
    });
    await runtime.stopAndDrain();
  });

  it('aborts waiters without marking fresh during shutdown', async () => {
    const { runtime } = createPostTradeHarness({
      getTradeRuntime: () => createTradeRuntimeDouble(),
      onPositionsCommitted: async () => {},
    });

    bindMinimalBusinessDeps(runtime);
    runtime.recordSettlementRefreshNeed({
      refreshAccount: true,
      refreshPositions: true,
    });

    const waiter = runtime.waitForFresh();
    runtime.abortWaiting();

    expect(waiter).rejects.toThrow(
      '[postTradeConsistencyRuntime] freshness wait aborted: STOP_AND_DRAIN',
    );

    expect(runtime.getStatus()).toEqual({
      started: false,
      currentVersion: 0,
      staleVersion: 1,
    });
  });

  it('does not report fatal when shutdown aborts waiters during a successful in-flight refresh', async () => {
    const accountRefresh = createDeferred<ReturnType<typeof createAccountSnapshotDouble>>();
    let accountRefreshCalls = 0;
    let freshEventCount = 0;

    const { runtime } = createPostTradeHarness({
      getTradeRuntime: () =>
        createTradeRuntimeDouble({
          accountService: {
            getAccountSnapshot: async () => {
              accountRefreshCalls += 1;
              return accountRefresh.promise;
            },
            getStockPositions: async () => [],
          },
        }),
      onPositionsCommitted: async () => {},
    });

    runtime.onFreshReached(() => {
      freshEventCount += 1;
    });

    bindMinimalBusinessDeps(runtime);
    runtime.recordSettlementRefreshNeed({
      refreshAccount: true,
      refreshPositions: false,
    });
    runtime.start();
    await manualScheduler.runNext(0);
    expect(accountRefreshCalls).toBe(1);
    runtime.abortWaiting();
    accountRefresh.resolve(createAccountSnapshotDouble('66000'));

    await runtime.stopAndDrain();

    expect(freshEventCount).toBe(0);
    expect(runtime.getStatus()).toEqual({
      started: false,
      currentVersion: 0,
      staleVersion: 1,
    });
  });

  it('continues consuming late settlement refresh after shutdown aborts waiters', async () => {
    const accountRefresh = createDeferred<ReturnType<typeof createAccountSnapshotDouble>>();
    let accountRefreshCalls = 0;
    let freshEventCount = 0;

    const { runtime } = createPostTradeHarness({
      getTradeRuntime: () =>
        createTradeRuntimeDouble({
          accountService: {
            getAccountSnapshot: async () => {
              accountRefreshCalls += 1;
              return accountRefresh.promise;
            },
            getStockPositions: async () => [],
          },
        }),
      onPositionsCommitted: async () => {},
    });

    runtime.onFreshReached(() => {
      freshEventCount += 1;
    });

    bindMinimalBusinessDeps(runtime);
    runtime.start();
    runtime.abortWaiting();

    expect(() => {
      runtime.recordSettlementRefreshNeed({
        refreshAccount: true,
        refreshPositions: false,
      });
    }).not.toThrow();

    await manualScheduler.runNext(0);
    expect(accountRefreshCalls).toBe(1);
    accountRefresh.resolve(createAccountSnapshotDouble('55000'));

    await runtime.stopAndDrain();

    expect(freshEventCount).toBe(0);
    expect(runtime.getStatus()).toEqual({
      started: false,
      currentVersion: 0,
      staleVersion: 1,
    });
  });

  it('does not complete protective liquidation when original liquidation symbol still has position after seat switch', async () => {
    const committedProtectionBoundaryCalls: Array<{
      direction: 'LONG' | 'SHORT';
      boundaryExecutedTimeMs: number;
    }> = [];
    const cooldownCalls: Array<{
      direction: 'LONG' | 'SHORT';
      executedTimeMs: number;
    }> = [];
    const protectiveBoundaryMs = 1_712_222_333_000;

    const monitorContext = createMonitorContextDouble({
      config: createMonitorConfigDouble({
        monitorSymbol: 'HSI.HK',
        liquidationTriggerLimit: 2,
      }),
      symbolRegistry: createSymbolRegistryDouble({
        longSeat: {
          symbol: 'BULL.NEW.HK',
          status: 'ACTIVE',
          lastSwitchAt: null,
          lastSearchAt: null,
          lastSeatActivatedAt: null,
          searchFailCountToday: 0,
          frozenTradingDayKey: null,
        },
        shortSeat: {
          symbol: null,
          status: 'EMPTY',
          lastSwitchAt: null,
          lastSearchAt: null,
          lastSeatActivatedAt: null,
          searchFailCountToday: 0,
          frozenTradingDayKey: null,
        },
      }),
      orderRecorder: createOrderRecorderDouble(),
      dailyLossTracker: createDailyLossTrackerDouble({
        getLossOffset: () => '0',
      }),
      riskChecker: createObservedRiskChecker(() => {}),
    });

    const { runtime } = createPostTradeHarness({
      getTradeRuntime: () =>
        createTradeRuntimeDouble({
          accountService: {
            getAccountSnapshot: async () => createAccountSnapshotDouble('77000'),
            getStockPositions: async () => [
              createPositionDouble({
                symbol: 'BULL.OLD.HK',
                quantity: 100,
                availableQuantity: 100,
              }),
            ],
          },
          orderMonitor: { hasPendingProtectiveLiquidationOrders: () => false },
        }),
      onPositionsCommitted: async () => {},
    });
    runtime.bindBusinessDeps(
      createSettlementBusinessDeps({
        monitorContext,
        dailyLossTracker: createDailyLossTrackerDouble({
          commitProtectionBoundary: (params) => {
            committedProtectionBoundaryCalls.push(params);
          },
        }),
        liquidationCooldownTracker: createLiquidationCooldownTrackerDouble({
          recordLiquidationTrigger: (params) => {
            cooldownCalls.push({
              direction: params.direction,
              executedTimeMs: params.executedTimeMs,
            });
          },
        }),
        protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble({
          getInProgressEpisodes: () => [
            {
              direction: 'LONG',
              symbol: 'BULL.OLD.HK',
              latestExecutedTimeMs: protectiveBoundaryMs,
            },
          ],
          prepareCompletion: ({ isDirectionFlat }) =>
            isDirectionFlat
              ? {
                  direction: 'LONG',
                  boundaryExecutedTimeMs: protectiveBoundaryMs,
                }
              : null,
        }),
        mixedTradeLogRepository: {
          appendCompletionIdempotent: () => {},
        },
      }),
    );

    runtime.recordSettlementRefreshNeed({
      refreshAccount: true,
      refreshPositions: true,
    });
    const fresh = runtime.waitForFresh();
    runtime.start();
    await manualScheduler.runNext(0);
    await fresh;
    await runtime.stopAndDrain();

    expect(committedProtectionBoundaryCalls).toEqual([]);
    expect(cooldownCalls).toEqual([]);
  });
});

describe('PostTrade drain dependency', () => {
  it('does not let a cancelled retry callback replace the restarted cycle retry', async () => {
    const callbacks: Array<() => void> = [];
    manualScheduler = createManualScheduler((callback) => {
      callbacks.push(callback);
    });
    const failure = await createExternalApiRequestError({
      operation: 'TradeContext.accountBalance',
      attempts: 1,
      cause: new Error('retry'),
    });
    let accountCalls = 0;
    const { runtime } = createPostTradeHarness({
      getTradeRuntime: () =>
        createTradeRuntimeDouble({
          accountService: {
            getAccountSnapshot: async () => {
              accountCalls += 1;
              throw failure;
            },
          },
        }),
      onPositionsCommitted: async () => {},
    });
    bindMinimalBusinessDeps(runtime);
    runtime.recordSettlementRefreshNeed({ refreshAccount: true, refreshPositions: false });
    runtime.start();
    await manualScheduler.runNext(0);
    const oldRetry = callbacks[1];
    if (oldRetry === undefined) throw new Error('missing old retry callback');

    await runtime.stopAndDrain();
    runtime.start();
    await manualScheduler.runNext(0);
    expect(manualScheduler.pendingDelays()).toEqual([300]);
    oldRetry();
    await flushMicrotasks();
    expect(accountCalls).toBe(2);
    expect(manualScheduler.pendingDelays()).toEqual([300]);
    await runtime.stopAndDrain();
    expect(manualScheduler.pendingDelays()).toEqual([]);
  });

  it.each([false, true])(
    'ignores cancelled run callbacks after restart while running=%s',
    async (fireWhileRunning) => {
      const callbacks: Array<() => void> = [];
      manualScheduler = createManualScheduler((callback) => {
        callbacks.push(callback);
      });
      const positions = createDeferred<ReadonlyArray<ReturnType<typeof createPositionDouble>>>();
      const committed = createDeferred<null>();
      const events: Array<string> = [];
      let positionCalls = 0;
      const { runtime } = createPostTradeHarness({
        getTradeRuntime: () =>
          createTradeRuntimeDouble({
            accountService: {
              getStockPositions: () => {
                positionCalls += 1;
                return positions.promise;
              },
            },
          }),
        onPositionsCommitted: async () => {
          events.push('callback-start');
          await committed.promise;
          events.push('callback-end');
        },
      });
      bindMinimalBusinessDeps(runtime);
      runtime.recordSettlementRefreshNeed({ refreshAccount: false, refreshPositions: true });
      runtime.start();
      const oldCallback = callbacks[0];
      if (oldCallback === undefined) throw new Error('missing old run callback');

      const oldDrain = runtime.stopAndDrain();
      await oldDrain;
      runtime.start();
      if (!fireWhileRunning) {
        oldCallback();
        expect(positionCalls).toBe(0);
        expect(manualScheduler.pendingDelays()).toEqual([0]);
        await runtime.stopAndDrain();
        expect(manualScheduler.pendingDelays()).toEqual([]);
        runtime.start();
      }

      await manualScheduler.runNext(0);
      oldCallback();
      await flushMicrotasks();
      expect(events).toEqual([]);
      expect(positionCalls).toBe(1);
      positions.resolve([]);
      await flushMicrotasks();
      expect(events).toEqual(['callback-start']);
      // consumer callback 已实际 issued，再关闭调度并等待它结束，不要求取消后发出新 callback。
      const drain = runtime.stopAndDrain();
      expect(drain).not.toBe(oldDrain);
      expect(runtime.stopAndDrain()).toBe(drain);
      void drain.then(() => events.push('drained'));
      await flushMicrotasks();
      expect(events).toEqual(['callback-start']);
      committed.resolve(null);
      await drain;
      expect(events).toEqual(['callback-start', 'callback-end', 'drained']);
      expect(manualScheduler.pendingDelays()).toEqual([]);
    },
  );

  it('同一周期共享排空，持仓请求及订阅回调均须结束，下一周期可恢复', async () => {
    const positions = createDeferred<ReadonlyArray<never>>();
    const committed = createDeferred<null>();
    const events: string[] = [];
    const { runtime } = createPostTradeHarness({
      getTradeRuntime: () =>
        createTradeRuntimeDouble({
          accountService: { getStockPositions: () => positions.promise },
        }),
      onPositionsCommitted: async () => {
        events.push('callback-start');
        await committed.promise;
        events.push('callback-end');
      },
    });
    bindMinimalBusinessDeps(runtime);
    runtime.recordSettlementRefreshNeed({ refreshAccount: false, refreshPositions: true });
    runtime.start();
    await manualScheduler.runNext(0);
    await flushMicrotasks();
    expect(events).toEqual([]);
    positions.resolve([]);
    await flushMicrotasks();
    expect(events).toEqual(['callback-start']);
    runtime.stopScheduling();
    const first = runtime.stopAndDrain();
    const second = runtime.stopAndDrain();
    expect(first).toBe(second);
    void first.then(() => {
      events.push('drained');
    });
    await flushMicrotasks();
    expect(events).toEqual(['callback-start']);
    committed.resolve(null);
    await Promise.all([first, second]);
    expect(events).toEqual(['callback-start', 'callback-end', 'drained']);
    runtime.resetAbort();
    runtime.start();
    const next = runtime.stopAndDrain();
    expect(next).not.toBe(first);
    expect(next).toBe(runtime.stopAndDrain());
    await next;
  });
});

describe('PostTrade → Quote shutdown dependency', () => {
  it('正常终止等待已发出的持仓订阅提交，两个 owner 排空后不再 mutation', async () => {
    const pendingPositions =
      createDeferred<ReadonlyArray<ReturnType<typeof createPositionDouble>>>();
    const subscription = createDeferred<null>();
    const stateFixtures = createRuntimeStates();
    const events: string[] = [];
    const tradeRuntime = createTradeRuntimeDouble({
      accountService: { getStockPositions: () => pendingPositions.promise },
    });
    let quoteOwner: ReturnType<typeof createQuoteSubscriptionRuntime> | null = null;
    const { runtime, snapshot } = createPostTradeHarness({
      getTradeRuntime: () => tradeRuntime,
      onPositionsCommitted: async (capturedToken) => {
        if (quoteOwner === null) throw new Error('quote owner has not been bound');

        await quoteOwner.reconcilePositionHoldFromCurrentTruth(capturedToken);
        events.push('committed');
      },
    });
    const quote = createQuoteSubscriptionRuntime({
      snapshot,
      logger: createLoggerDouble(),
      tradingConfig: createTradingConfig(),
      symbolRegistry: createSymbolRegistryDouble(),
      orderHoldRegistry: tradeRuntime.orderHoldRegistry,
      ...stateFixtures,
      termination,
      marketDataClient: {
        subscribeSymbols: async () => {
          events.push('subscribe-start');
          await subscription.promise;
          events.push('subscribe-end');
        },
        unsubscribeSymbols: async () => {
          events.push('unsubscribe');
        },
      },
    });
    quoteOwner = quote;
    bindMinimalBusinessDeps(runtime);
    runtime.recordSettlementRefreshNeed({ refreshAccount: false, refreshPositions: true });
    runtime.start();
    await manualScheduler.runNext(0);
    pendingPositions.resolve([
      createPositionDouble({ symbol: 'LATE.HK', quantity: 100, availableQuantity: 100 }),
    ]);
    await flushMicrotasks();
    expect(events).toEqual(['subscribe-start']);
    termination.requestShutdown();
    runtime.stopScheduling();
    const drain = runtime.stopAndDrain();
    await flushMicrotasks();
    expect(events).toEqual(['subscribe-start']);
    subscription.resolve(null);
    await drain;
    events.push('posttrade-drained');
    await quote.stopAndDrain();
    events.push('quote-drained');
    expect(events).toEqual([
      'subscribe-start',
      'subscribe-end',
      'committed',
      'posttrade-drained',
      'unsubscribe',
      'quote-drained',
    ]);
    await quote.reconcilePositionHoldFromCurrentTruth(snapshot.getView().token);
    await quote.retainSymbols({
      reason: 'SEAT_REFRESH_WAIT',
      ownerKey: 'late',
      symbols: ['AFTER.HK'],
    });
    expect(events.at(-1)).toBe('quote-drained');
    expect(stateFixtures.quoteSubscriptionState.allTradingSymbols.size).toBe(0);
  });
});

describe('PostTrade rejected request drain', () => {
  it('账户请求已失败仍等待未返回的持仓请求，不提前宣称排空', async () => {
    const positions = createDeferred<ReadonlyArray<ReturnType<typeof createPositionDouble>>>();
    const failure = new TypeError('account invariant');
    let drained = false;
    const { runtime } = createPostTradeHarness({
      getTradeRuntime: () =>
        createTradeRuntimeDouble({
          accountService: {
            getAccountSnapshot: async () => {
              throw failure;
            },
            getStockPositions: () => positions.promise,
          },
        }),
      onPositionsCommitted: async () => {},
    });
    bindMinimalBusinessDeps(runtime);
    runtime.recordSettlementRefreshNeed({ refreshAccount: true, refreshPositions: true });
    runtime.start();
    await manualScheduler.runNext(0);
    const drain = runtime.stopAndDrain().then(
      () => {
        drained = true;
      },
      (error: unknown) => {
        drained = true;
        return error;
      },
    );
    await flushMicrotasks();
    expect(drained).toBe(false);
    positions.resolve([]);
    expect(await drain).toBe(failure);
    expect(drained).toBe(true);
  });
});
