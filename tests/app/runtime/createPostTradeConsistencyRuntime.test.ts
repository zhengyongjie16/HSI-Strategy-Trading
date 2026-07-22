/**
 * createPostTradeConsistencyRuntime 测试
 *
 * 覆盖最小成交后一致性运行时切片：启动前积压 stale、启动后消费刷新、
 * 以及 completeRebuildBaseline 的最小 freshness 推进行为。
 */
import { describe, expect, it } from 'bun:test';

import { createPostTradeConsistencyRuntime } from '../../../src/app/runtime/createPostTradeConsistencyRuntime.js';
import { createExternalApiRequestError } from '../../helpers/createExternalApiRequestError.js';
import type { LastState } from '../../../src/types/state.js';

import {
  createAccountSnapshotDouble,
  createDailyLossTrackerDouble,
  createLiquidationCooldownTrackerDouble,
  createMonitorContextDouble,
  createMonitorConfigDouble,
  createOrderRecorderDouble,
  createPositionCacheDouble,
  createPositionDouble,
  createProtectiveLiquidationEpisodeTrackerDouble,
  createRiskCheckerDouble,
  createSymbolRegistryDouble,
  createTraderDouble,
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

/**
 * 轮询等待条件成立。
 *
 * @param predicate 需要等待变为 true 的条件
 * @param timeoutMs 超时时间，默认 1000ms
 * @returns 条件成立时 resolve；超时则抛错
 */
async function waitForCondition(predicate: () => boolean, timeoutMs: number = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for condition.');
    }

    await Bun.sleep(1);
  }
}

function createLastState(): LastState {
  return {
    canTrade: true,
    isHalfDay: false,
    openProtectionActive: false,
    currentDayKey: '2026-04-04',
    lifecycleState: 'ACTIVE',
    pendingOpenRebuild: false,
    isTradingEnabled: true,
    cachedAccount: null,
    cachedPositions: [],
    positionCache: createPositionCacheDouble(),
    cachedTradingDayInfo: null,
    tradingCalendarSnapshot: new Map(),
    monitorState: {
      monitorSymbol: 'HSI.HK',
      lastMonitorSnapshot: null,
      incrementalIndicatorRuntime: null,
    },
    allTradingSymbols: new Set(),
  };
}

/**
 * 为运行时绑定最小业务依赖，满足 fail-fast 启动前置条件。
 *
 * @param runtime 待绑定的成交后一致性运行时
 */
function bindMinimalBusinessDeps(
  runtime: ReturnType<typeof createPostTradeConsistencyRuntime>,
): void {
  runtime.bindBusinessDeps({
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
  });
}

describe('createPostTradeConsistencyRuntime', () => {
  it('marks stale before start and consumes the backlog after start while emitting fresh reached event', async () => {
    const lastState = createLastState();
    let accountRefreshCalls = 0;
    let positionRefreshCalls = 0;
    let freshEventCount = 0;

    const runtime = createPostTradeConsistencyRuntime({
      getTrader: () =>
        createTraderDouble({
          getAccountSnapshot: async () => {
            accountRefreshCalls += 1;
            return createAccountSnapshotDouble(88_000);
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
        }),
      lastState,
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

    await Bun.sleep(30);

    expect(accountRefreshCalls).toBe(0);
    expect(positionRefreshCalls).toBe(0);
    expect(runtime.getStatus()).toEqual({
      started: false,
      currentVersion: 0,
      staleVersion: 1,
    });

    runtime.start();
    await runtime.waitForFresh();
    await runtime.stopAndDrain();

    expect(accountRefreshCalls).toBe(1);
    expect(positionRefreshCalls).toBe(1);
    expect(lastState.cachedPositions).toHaveLength(1);
    expect(lastState.positionCache.get('BULL.HK')?.quantity).toBe(300);
    expect(freshEventCount).toBe(1);

    expect(runtime.getStatus()).toEqual({
      started: false,
      currentVersion: 1,
      staleVersion: 1,
    });
  });

  it('awaits positions committed hook after writing latest positions', async () => {
    const lastState = createLastState();
    const committedSnapshots: Array<{
      readonly cachedPositionCount: number;
      readonly cacheQuantity: number | null;
    }> = [];
    const runtime = createPostTradeConsistencyRuntime({
      getTrader: () =>
        createTraderDouble({
          getAccountSnapshot: async () => createAccountSnapshotDouble(88_000),
          getStockPositions: async () => [
            createPositionDouble({
              symbol: 'BULL.HK',
              quantity: 300,
              availableQuantity: 300,
            }),
          ],
        }),
      lastState,
      onPositionsCommitted: async () => {
        await Bun.sleep(1);
        committedSnapshots.push({
          cachedPositionCount: lastState.cachedPositions.length,
          cacheQuantity: lastState.positionCache.get('BULL.HK')?.quantity ?? null,
        });
      },
    });

    bindMinimalBusinessDeps(runtime);
    runtime.recordSettlementRefreshNeed({
      refreshAccount: true,
      refreshPositions: true,
    });

    runtime.start();
    await runtime.waitForFresh();
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
    const lastState = createLastState();
    const firstAccountRefresh = createDeferred<ReturnType<typeof createAccountSnapshotDouble>>();
    const firstPositionRefresh =
      createDeferred<ReadonlyArray<ReturnType<typeof createPositionDouble>>>();
    let accountRefreshCalls = 0;
    let positionRefreshCalls = 0;

    const runtime = createPostTradeConsistencyRuntime({
      getTrader: () =>
        createTraderDouble({
          getAccountSnapshot: async () => {
            accountRefreshCalls += 1;
            if (accountRefreshCalls === 1) {
              return firstAccountRefresh.promise;
            }

            return createAccountSnapshotDouble(99_000);
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
        }),
      lastState,
      onPositionsCommitted: async () => {},
    });

    bindMinimalBusinessDeps(runtime);
    runtime.recordSettlementRefreshNeed({
      refreshAccount: true,
      refreshPositions: true,
    });
    runtime.start();

    await waitForCondition(() => accountRefreshCalls === 1);

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

    await runtime.waitForFresh();

    expect(accountRefreshCalls).toBe(2);
    expect(positionRefreshCalls).toBe(2);
    expect(lastState.cachedPositions).toHaveLength(1);
    expect(lastState.positionCache.get('BULL.HK')?.quantity).toBe(500);
    expect(runtime.getStatus()).toEqual({
      started: true,
      currentVersion: 2,
      staleVersion: 2,
    });

    await runtime.waitForFresh();
    await runtime.stopAndDrain();
  });

  it('retries failed refresh and still refreshes all currently attributed seat symbols after recovery', async () => {
    const lastState = createLastState();
    let accountCallCount = 0;
    const refreshedSymbols: string[] = [];

    const monitorContext = createMonitorContextDouble({
      config: createMonitorConfigDouble({
        monitorSymbol: 'HSI.HK',
        maxUnrealizedLossPerSymbol: 2_000,
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
        getLossOffset: () => 0,
      }),
      riskChecker: createRiskCheckerDouble({
        refreshUnrealizedLossData: async (_orderRecorder, symbol) => {
          refreshedSymbols.push(symbol);
        },
      }),
    });

    const runtime = createPostTradeConsistencyRuntime({
      getTrader: () =>
        createTraderDouble({
          getAccountSnapshot: async () => {
            accountCallCount += 1;
            if (accountCallCount === 1) {
              throw await createExternalApiRequestError({
                operation: 'TradeContext.accountBalance',
                attempts: 1,
                cause: new Error('account API temporary unavailable'),
              });
            }

            return createAccountSnapshotDouble(66_000);
          },
          getStockPositions: async () => [
            createPositionDouble({
              symbol: 'BULL.HK',
              quantity: 300,
              availableQuantity: 300,
            }),
          ],
        }),
      lastState,
      onPositionsCommitted: async () => {},
    });
    runtime.bindBusinessDeps({
      monitorContext,
      dailyLossTracker: createDailyLossTrackerDouble(),
      liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
      protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
      mixedTradeLogRepository: {
        appendCompletionIdempotent: () => {},
      },
    });

    runtime.recordSettlementRefreshNeed({
      refreshAccount: true,
      refreshPositions: true,
    });
    runtime.start();
    await runtime.waitForFresh();
    await runtime.stopAndDrain();

    expect(accountCallCount).toBeGreaterThanOrEqual(2);
    expect(new Set(refreshedSymbols)).toEqual(new Set(['BULL.HK', 'BEAR.HK']));
    expect(runtime.getStatus()).toEqual({
      started: false,
      currentVersion: 1,
      staleVersion: 1,
    });
  });

  it('keeps the attributed direction snapshot stable while refreshing seat symbols', async () => {
    const lastState = createLastState();
    const riskRefreshCalls: Array<{
      readonly symbol: string;
      readonly isLongSymbol: boolean;
      readonly dailyLossOffset: number | undefined;
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
        getLossOffset: (direction) => (direction === 'LONG' ? 11 : 22),
      }),
      riskChecker: createRiskCheckerDouble({
        refreshUnrealizedLossData: async (
          _orderRecorder,
          symbol,
          isLongSymbol,
          _quote,
          dailyLossOffset,
        ) => {
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
      }),
    });
    const runtime = createPostTradeConsistencyRuntime({
      getTrader: () =>
        createTraderDouble({
          getAccountSnapshot: async () => createAccountSnapshotDouble(66_000),
          getStockPositions: async () => [],
        }),
      lastState,
      onPositionsCommitted: async () => {},
    });
    runtime.bindBusinessDeps({
      monitorContext,
      dailyLossTracker: createDailyLossTrackerDouble(),
      liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
      protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
      mixedTradeLogRepository: {
        appendCompletionIdempotent: () => {},
      },
    });

    runtime.recordSettlementRefreshNeed({
      refreshAccount: true,
      refreshPositions: true,
    });
    runtime.start();
    await runtime.waitForFresh();
    await runtime.stopAndDrain();

    expect(riskRefreshCalls).toEqual([
      {
        symbol: 'BULL.HK',
        isLongSymbol: true,
        dailyLossOffset: 11,
      },
      {
        symbol: 'BEAR.HK',
        isLongSymbol: false,
        dailyLossOffset: 22,
      },
    ]);
  });

  it('fails fast when account refresh hits TypeError and exposes the fatal channel immediately', async () => {
    const lastState = createLastState();
    let accountCallCount = 0;
    const runtime = createPostTradeConsistencyRuntime({
      getTrader: () =>
        createTraderDouble({
          getAccountSnapshot: async () => {
            accountCallCount += 1;
            throw new TypeError('TradeContext.accountBalance returned no primary account');
          },
          getStockPositions: async () => [],
        }),
      lastState,
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
    const fatalResult = runtime.drainFatalError().then(
      () => null,
      (error: unknown) => error,
    );

    runtime.start();

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
    const lastState = createLastState();
    const internalError = new Error('position commit failed');
    const runtime = createPostTradeConsistencyRuntime({
      getTrader: () =>
        createTraderDouble({
          getAccountSnapshot: async () => createAccountSnapshotDouble(100),
          getStockPositions: async () => [
            createPositionDouble({
              symbol: 'BULL.HK',
              quantity: 1,
              availableQuantity: 1,
            }),
          ],
        }),
      lastState,
      onPositionsCommitted: async () => {
        throw internalError;
      },
    });

    bindMinimalBusinessDeps(runtime);
    runtime.recordSettlementRefreshNeed({
      refreshAccount: true,
      refreshPositions: true,
    });

    runtime.start();
    const fatalResult = await Promise.race([
      runtime.drainFatalError().then(
        () => null,
        (error: unknown) => error,
      ),
      Bun.sleep(80).then(() => null),
    ]);

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
    const lastState = createLastState();
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
      riskChecker: createRiskCheckerDouble({
        refreshUnrealizedLossData: async () => {
          riskRefreshCallCount += 1;
          throw new TypeError('refresh unrealized loss contract violated');
        },
      }),
    });

    const runtime = createPostTradeConsistencyRuntime({
      getTrader: () =>
        createTraderDouble({
          getAccountSnapshot: async () => {
            accountCallCount += 1;
            return createAccountSnapshotDouble(77_000);
          },
          getStockPositions: async () => [
            createPositionDouble({
              symbol: 'BULL.HK',
              quantity: 300,
              availableQuantity: 300,
            }),
          ],
        }),
      lastState,
      onPositionsCommitted: async () => {},
    });

    runtime.bindBusinessDeps({
      monitorContext,
      dailyLossTracker: createDailyLossTrackerDouble(),
      liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
      protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
      mixedTradeLogRepository: {
        appendCompletionIdempotent: () => {},
      },
    });

    runtime.recordSettlementRefreshNeed({
      refreshAccount: true,
      refreshPositions: true,
    });

    const waiterResult = runtime.waitForFresh().then(
      () => null,
      (error: unknown) => error,
    );

    runtime.start();

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
    const lastState = createLastState();
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
      dailyLossOffset: number | undefined;
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
        getLossOffset: () => 88,
      }),
      riskChecker: createRiskCheckerDouble({
        refreshUnrealizedLossData: async (
          _orderRecorder,
          symbol,
          isLongSymbol,
          _quote,
          dailyLossOffset,
        ) => {
          riskRefreshCalls.push({ symbol, isLongSymbol, dailyLossOffset });
        },
      }),
    });

    const runtime = createPostTradeConsistencyRuntime({
      getTrader: () =>
        createTraderDouble({
          getAccountSnapshot: async () => createAccountSnapshotDouble(77_000),
          getStockPositions: async () => [],
          hasPendingProtectiveLiquidationOrders: (direction) => {
            pendingProtectiveDirections.push(direction);
            return false;
          },
        }),
      lastState,
      onPositionsCommitted: async () => {},
    });
    runtime.bindBusinessDeps({
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
    });

    runtime.recordSettlementRefreshNeed({
      refreshAccount: true,
      refreshPositions: true,
    });
    runtime.start();
    await runtime.waitForFresh();
    await runtime.stopAndDrain();
    expect(lastState.cachedPositions).toEqual([]);
    expect(pendingProtectiveDirections).toEqual(['LONG']);
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
        dailyLossOffset: 88,
      },
    ]);
  });

  it('keeps daily loss, cooldown, and episode uncommitted when completion persistence fails', async () => {
    const boundaryExecutedTimeMs = Date.parse('2026-07-11T03:00:00.000Z');
    const commits: string[] = [];
    const runtime = createPostTradeConsistencyRuntime({
      getTrader: () =>
        createTraderDouble({
          getAccountSnapshot: async () => createAccountSnapshotDouble(10_000),
          getStockPositions: async () => [],
          hasPendingProtectiveLiquidationOrders: () => false,
        }),
      lastState: createLastState(),
      onPositionsCommitted: async () => {},
    });
    runtime.bindBusinessDeps({
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
    });

    runtime.recordSettlementRefreshNeed({ refreshAccount: true, refreshPositions: true });
    const waitResult = runtime.waitForFresh().catch((error: unknown) => error);
    runtime.start();

    const waitError = await waitResult;
    expect(runtime.stopAndDrain()).rejects.toThrow('persist failed');
    expect(waitError).toBeInstanceOf(Error);
    expect(commits).toEqual([]);
  });

  it('fails fast when start is called before bindBusinessDeps', () => {
    const runtime = createPostTradeConsistencyRuntime({
      getTrader: () => createTraderDouble(),
      lastState: createLastState(),
      onPositionsCommitted: async () => {},
    });

    expect(() => {
      runtime.start();
    }).toThrow('[postTradeConsistencyRuntime] businessDeps 尚未绑定，禁止启动');
  });

  it('fails fast when bindBusinessDeps is called more than once', () => {
    const runtime = createPostTradeConsistencyRuntime({
      getTrader: () => createTraderDouble(),
      lastState: createLastState(),
      onPositionsCommitted: async () => {},
    });

    bindMinimalBusinessDeps(runtime);

    expect(() => {
      bindMinimalBusinessDeps(runtime);
    }).toThrow('[postTradeConsistencyRuntime] businessDeps 已绑定，禁止重复绑定');
  });

  it('fails fast and stops retrying when attributed seat symbols are duplicated', async () => {
    const lastState = createLastState();
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
    const runtime = createPostTradeConsistencyRuntime({
      getTrader: () =>
        createTraderDouble({
          getAccountSnapshot: async () => createAccountSnapshotDouble(10_000),
          getStockPositions: async () => [],
        }),
      lastState,
      onPositionsCommitted: async () => {},
    });
    expect(() => {
      runtime.bindBusinessDeps({
        monitorContext: duplicateMonitorContext,
        dailyLossTracker: createDailyLossTrackerDouble(),
        liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
        protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
        mixedTradeLogRepository: {
          appendCompletionIdempotent: () => {},
        },
      });
    }).toThrow('重复归属');
  });

  it('completeRebuildBaseline advances freshness only after pending work is cleared and emits rebuild baseline event', () => {
    let freshEventCount = 0;
    const runtime = createPostTradeConsistencyRuntime({
      getTrader: () => createTraderDouble(),
      lastState: createLastState(),
      onPositionsCommitted: async () => {},
    });

    runtime.onFreshReached(() => {
      freshEventCount += 1;
    });

    runtime.recordSettlementRefreshNeed({
      refreshAccount: true,
      refreshPositions: false,
    });
    runtime.completeRebuildBaseline();

    expect(runtime.getStatus()).toEqual({
      started: false,
      currentVersion: 0,
      staleVersion: 1,
    });
    expect(freshEventCount).toBe(0);

    runtime.midnightClear();
    runtime.completeRebuildBaseline();

    expect(freshEventCount).toBe(1);

    expect(runtime.getStatus()).toEqual({
      started: false,
      currentVersion: 1,
      staleVersion: 1,
    });
  });

  it('aborts waiters without marking fresh during shutdown', async () => {
    const runtime = createPostTradeConsistencyRuntime({
      getTrader: () => createTraderDouble(),
      lastState: createLastState(),
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
    const lastState = createLastState();
    const accountRefresh = createDeferred<ReturnType<typeof createAccountSnapshotDouble>>();
    let accountRefreshCalls = 0;
    let freshEventCount = 0;

    const runtime = createPostTradeConsistencyRuntime({
      getTrader: () =>
        createTraderDouble({
          getAccountSnapshot: async () => {
            accountRefreshCalls += 1;
            return accountRefresh.promise;
          },
          getStockPositions: async () => [],
        }),
      lastState,
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

    await waitForCondition(() => accountRefreshCalls === 1);
    runtime.abortWaiting();
    accountRefresh.resolve(createAccountSnapshotDouble(66_000));

    await runtime.stopAndDrain();

    expect(freshEventCount).toBe(0);
    expect(runtime.getStatus()).toEqual({
      started: false,
      currentVersion: 0,
      staleVersion: 1,
    });
  });

  it('continues consuming late settlement refresh after shutdown aborts waiters', async () => {
    const lastState = createLastState();
    const accountRefresh = createDeferred<ReturnType<typeof createAccountSnapshotDouble>>();
    let accountRefreshCalls = 0;
    let freshEventCount = 0;

    const runtime = createPostTradeConsistencyRuntime({
      getTrader: () =>
        createTraderDouble({
          getAccountSnapshot: async () => {
            accountRefreshCalls += 1;
            return accountRefresh.promise;
          },
          getStockPositions: async () => [],
        }),
      lastState,
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

    await waitForCondition(() => accountRefreshCalls === 1);
    accountRefresh.resolve(createAccountSnapshotDouble(55_000));

    await runtime.stopAndDrain();

    expect(freshEventCount).toBe(0);
    expect(runtime.getStatus()).toEqual({
      started: false,
      currentVersion: 0,
      staleVersion: 1,
    });
  });

  it('does not complete protective liquidation when original liquidation symbol still has position after seat switch', async () => {
    const lastState = createLastState();
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
        getLossOffset: () => 0,
      }),
      riskChecker: createRiskCheckerDouble({
        refreshUnrealizedLossData: async () => {},
      }),
    });

    const runtime = createPostTradeConsistencyRuntime({
      getTrader: () =>
        createTraderDouble({
          getAccountSnapshot: async () => createAccountSnapshotDouble(77_000),
          getStockPositions: async () => [
            createPositionDouble({
              symbol: 'BULL.OLD.HK',
              quantity: 100,
              availableQuantity: 100,
            }),
          ],
          hasPendingProtectiveLiquidationOrders: () => false,
        }),
      lastState,
      onPositionsCommitted: async () => {},
    });
    runtime.bindBusinessDeps({
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
    });

    runtime.recordSettlementRefreshNeed({
      refreshAccount: true,
      refreshPositions: true,
    });
    runtime.start();
    await runtime.waitForFresh();
    await runtime.stopAndDrain();

    expect(committedProtectionBoundaryCalls).toEqual([]);
    expect(cooldownCalls).toEqual([]);
  });
});
