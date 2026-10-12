import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createSnapshotFixture } from '../fixtures/accountPositionSnapshot.js';
import { createSettlementRuntimeFixture } from '../fixtures/settlementRuntime.js';
import { createTerminationRuntime } from '../../../src/app/runtime/createTerminationRuntime.js';
import type { PostTradeConsistencyRuntime } from '../../../src/app/types.js';
import {
  createMonitorContextDouble,
  createAccountSnapshotDouble,
  createPositionDouble,
  createOrderRecorderDouble,
  createRiskCheckerDouble,
  createSymbolRegistryDouble,
  createTraderDouble,
  createUnrealizedLossMonitorDouble,
  createQuoteDouble,
  createDailyLossTrackerDouble,
  createLoggerDouble,
} from '../../helpers/testDoubles.js';
import { createMonitorConfig } from '../../../mock/factories/configFactory.js';
import { createTradingRiskEventRuntime } from '../../../src/main/tradingRiskEventRuntime/tradingRiskEventRuntime.js';
import { buildTradingRiskRoutingIndex } from '../../../src/main/tradingRiskEventRuntime/routingIndex.js';
import { resolveTradingRiskRoute } from '../../../src/main/tradingRiskEventRuntime/routeValidation.js';
import { createUnrealizedLossMonitor } from '../../../src/core/riskController/unrealizedLossMonitor.js';
import { createExternalApiRequestError } from '../../helpers/createExternalApiRequestError.js';
import type { TradingRiskEventRuntimeDeps } from '../../../src/main/tradingRiskEventRuntime/types.js';
import type { QuoteUpdatedEvent } from '../../../src/types/services.js';
import type { SeatState, SymbolRegistry } from '../../../src/types/seat.js';

/**
 * TradingRiskEventRuntime 业务测试
 *
 * 功能：
 * - 验证路由索引、门禁、seat 版本校验与 single-flight latest-only 语义
 * - 验证单方向浮亏执行器会把 seatVersion 写入清仓信号
 */

interface TestSymbolRegistry extends SymbolRegistry {
  getSeatStateChangedListenerCount: () => number;
  getSeatTruthChangedListenerCount: () => number;
}

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

const settlementCleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of settlementCleanups.splice(0)) await cleanup();
});

/** Pause delivery of an actual original S receipt; never replace it with a later ticket. */
function createConsistencyPort(initialStatus: Readonly<{ started: boolean }>) {
  let runtime: PostTradeConsistencyRuntime | null = null;
  let blockNextRead: (() => void) | null = null;
  let freshDeferred: ReturnType<typeof createDeferred<void>> | null = null;
  return {
    started: initialStatus.started,
    bind: (owner: PostTradeConsistencyRuntime, blockRead: () => void) => {
      runtime = owner;
      blockNextRead = blockRead;
    },
    enablePendingFreshWait: () => {
      freshDeferred = createDeferred();
    },
    get port(): TradingRiskEventRuntimeDeps['postTradeConsistencyRuntime'] {
      const owner = runtime;
      if (owner === null) throw new Error('Settlement owner has not been bound');

      return {
        getStatus: owner.getStatus,
        isCurrent: owner.isCurrent,
        onFreshReached: owner.onFreshReached,
        waitForFresh: async () => {
          const capturedReceipt = await owner.waitForFresh();
          if (freshDeferred !== null) await freshDeferred.promise;

          return capturedReceipt;
        },
      };
    },
    registerNewRefreshNeed: () => {
      if (runtime === null || blockNextRead === null) throw new Error('Settlement owner not bound');

      blockNextRead();
      runtime.recordSettlementRefreshNeed({ refreshAccount: true, refreshPositions: true });
    },
    resolveFresh: () => {
      freshDeferred?.resolve();
    },
    releaseReceiptDelivery: () => {
      freshDeferred?.resolve();
    },
  };
}

function waitTick(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe('tradingRiskEventRuntime routing', () => {
  it('throws when the same trading symbol is owned by both LONG and SHORT seats', () => {
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
    expect(() =>
      buildTradingRiskRoutingIndex({
        symbolRegistry,
      }),
    ).toThrow('重复归属');
  });

  it('resolves the current route from the registry snapshot', () => {
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
    const routingIndex = buildTradingRiskRoutingIndex({
      symbolRegistry,
    });

    const longRoute = resolveTradingRiskRoute(routingIndex, 'BULL.HK');
    expect(routingIndex.activeRouteKeys).toEqual(new Set(['LONG', 'SHORT']));
    expect(longRoute?.direction).toBe('LONG');
    expect(longRoute?.tradingSymbol).toBe('BULL.HK');
    expect(longRoute?.seatVersion).toBe(1);
  });
});

describe('tradingRiskEventRuntime runtime flow', () => {
  let quoteUpdatedListeners: Set<(event: QuoteUpdatedEvent) => void>;

  beforeEach(() => {
    quoteUpdatedListeners = new Set();
  });

  async function createRuntimeDeps(
    params: {
      readonly lastState?: {
        readonly canTrade: boolean | null;
        isTradingEnabled: boolean;
        readonly isHalfDay: boolean | null;
      };
      readonly doomsdayProtectionEnabled?: boolean;
      readonly consistencyPort?: ReturnType<typeof createConsistencyPort>;
      readonly monitorContext?: ReturnType<typeof createMonitorContextDouble>;
      readonly now?: () => Date;
      readonly symbolRegistry?: SymbolRegistry;
      readonly trader?: ReturnType<typeof createTraderDouble>;
      readonly unrealizedLossMonitor?: ReturnType<typeof createUnrealizedLossMonitorDouble>;
      readonly riskChecker?: ReturnType<typeof createRiskCheckerDouble>;
      readonly logger?: TradingRiskEventRuntimeDeps['logger'];
    } = {},
  ) {
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
      });
    const trader = params.trader ?? createTraderDouble();
    const unrealizedLossMonitor =
      params.unrealizedLossMonitor ??
      createUnrealizedLossMonitorDouble({
        monitorDirectionalUnrealizedLoss: async () => false,
      });
    const monitorContext =
      params.monitorContext ??
      createMonitorContextDouble({
        config: createMonitorConfig({ monitorSymbol: 'HSI.HK' }),
        symbolRegistry,
        unrealizedLossMonitor,
        ...(params.riskChecker === undefined ? {} : { riskChecker: params.riskChecker }),
      });
    const consistencyPort = params.consistencyPort ?? createConsistencyPort({ started: true });

    const lastState = params.lastState ?? {
      canTrade: true,
      isTradingEnabled: true,
      isHalfDay: false,
    };
    const termination = createTerminationRuntime({
      closeTradingGate: () => {
        lastState.isTradingEnabled = false;
      },
      closeProducerAdmission: () => {},
      stopProducers: [],
      onSecondaryError: () => {},
    });
    let readBlocked = false;
    const blockedRead = createDeferred();
    const account = createAccountSnapshotDouble('100000');
    const positions = [
      createPositionDouble({
        symbol: 'BULL.HK',
        quantity: 100,
        availableQuantity: 100,
        costPrice: '1',
      }),
      createPositionDouble({
        symbol: 'BEAR.HK',
        quantity: 100,
        availableQuantity: 100,
        costPrice: '1',
      }),
    ];
    const snapshot = await createSnapshotFixture({
      account,
      positions,
      readPort: {
        getAccountSnapshot: async () => {
          if (readBlocked) await blockedRead.promise;

          return account;
        },
        getStockPositions: async () => {
          if (readBlocked) await blockedRead.promise;

          return positions;
        },
      },
    });
    const settlement = createSettlementRuntimeFixture({
      snapshot,
      termination,
      getTrader: () => trader,
      monitorContext,
      onPositionsCommitted: async (token) => {
        if (!snapshot.isCurrent(token, { account: true, positions: true, paired: true }))
          throw new Error('Stale settlement commit');
      },
      scheduler: {
        scheduleTimer: (callback, delayMs) => setTimeout(callback, delayMs),
        clearTimer: (handle) => {
          clearTimeout(handle);
        },
      },
    });
    if (consistencyPort.started) {
      settlement.start();
      expect(await settlement.completeRebuildBaseline()).toBeTrue();
      const receipt = await settlement.waitForFresh();
      expect(receipt.snapshotToken).toBe(snapshot.getView().token);
      // 普通 pair/position commit 不全局重结算；R owner 仍须用当前 view 独立授权。
      for (const refreshAccount of [true, false]) {
        await snapshot.requestRefresh({
          source: 'SEAT_ACTIVATION',
          dayEpoch: receipt.snapshotToken.dayEpoch,
          refreshAccount,
          refreshPositions: true,
        }).result;
        expect(settlement.isCurrent(receipt)).toBe(true);
        expect(await settlement.waitForFresh()).toBe(receipt);
      }

      // Settle the actual startup task before observing R's index projection counters.
      await waitTick();
    }

    consistencyPort.bind(settlement, () => {
      readBlocked = true;
    });

    settlementCleanups.push(async () => {
      consistencyPort.releaseReceiptDelivery();
      blockedRead.resolve();
      await settlement.stopAndDrain();
    });

    return {
      deps: {
        snapshot,
        logger: params.logger ?? createLoggerDouble(),
        marketDataClient: {
          onQuoteUpdated: (listener: (event: QuoteUpdatedEvent) => void) => {
            quoteUpdatedListeners.add(listener);
            return () => {
              quoteUpdatedListeners.delete(listener);
            };
          },
        },
        trader,
        symbolRegistry,
        monitorContext,
        lastState,
        postTradeConsistencyRuntime: consistencyPort.port,
        doomsdayProtectionEnabled: params.doomsdayProtectionEnabled ?? false,
        now: params.now ?? (() => new Date('2026-04-06T01:30:00.000Z')),
        termination,
      },
      consistencyPort,
      trader,
    };
  }

  function emitQuoteUpdated(symbol: string, price: string): void {
    const event = {
      symbol,
      quote: createQuoteDouble(symbol, price, 100),
    };

    for (const listener of quoteUpdatedListeners) {
      listener(event);
    }
  }

  function subscribeQuoteProbe(receivedSymbols: string[]): () => void {
    const listener = (event: QuoteUpdatedEvent) => {
      receivedSymbols.push(event.symbol);
    };
    quoteUpdatedListeners.add(listener);
    return () => {
      quoteUpdatedListeners.delete(listener);
    };
  }

  it('exposes route processing errors to fatal handler', async () => {
    const fatalErrors: unknown[] = [];
    const { deps } = await createRuntimeDeps({
      unrealizedLossMonitor: createUnrealizedLossMonitorDouble({
        monitorDirectionalUnrealizedLoss: async () => {
          throw new TypeError('risk route broken');
        },
      }),
    });
    const runtime = createTradingRiskEventRuntime({
      ...deps,
      termination: {
        isTerminated: () => false,
        reportFatalError: (error: unknown) => {
          fatalErrors.push(error);
        },
      },
    });

    runtime.start();
    emitQuoteUpdated('BULL.HK', '1.23');
    await waitTick();
    await waitTick();
    await runtime.stopAndDrain();

    expect(fatalErrors).toHaveLength(1);
    expect(fatalErrors[0]).toBeInstanceOf(TypeError);
    expect((fatalErrors[0] as Error).message).toContain('risk route broken');
  });

  it('routes internal protective-liquidation execution errors to the fatal handler', async () => {
    const internalError = new TypeError('trader execution invariant broken');
    const fatalErrors: unknown[] = [];
    let executionAttempts = 0;
    const { deps } = await createRuntimeDeps({
      trader: createTraderDouble({
        executeSignals: async () => {
          executionAttempts += 1;
          throw internalError;
        },
      }),
      riskChecker: createRiskCheckerDouble({
        checkUnrealizedLoss: () => ({
          shouldLiquidate: true,
          reason: 'loss limit',
          quantity: 100,
        }),
      }),
      unrealizedLossMonitor: createUnrealizedLossMonitor({
        maxUnrealizedLossPerSymbol: '1000',
      }),
    });
    const runtime = createTradingRiskEventRuntime({
      ...deps,
      termination: {
        isTerminated: () => false,
        reportFatalError: (error: unknown) => {
          fatalErrors.push(error);
        },
      },
    });

    runtime.start();
    emitQuoteUpdated('BULL.HK', '1.23');
    await waitTick();
    await waitTick();
    await runtime.stopAndDrain();

    expect(executionAttempts).toBe(1);
    expect(fatalErrors).toEqual([internalError]);
  });

  it('exposes protective liquidation submitOrder uncertainty to fatal handler', async () => {
    const submitError = await createExternalApiRequestError({
      operation: 'TradeContext.submitOrder',
      attempts: 1,
      cause: new Error('submit timeout'),
    });
    const fatalErrors: unknown[] = [];
    const { deps } = await createRuntimeDeps({
      unrealizedLossMonitor: createUnrealizedLossMonitorDouble({
        monitorDirectionalUnrealizedLoss: async () => {
          throw submitError;
        },
      }),
    });
    const runtime = createTradingRiskEventRuntime({
      ...deps,
      termination: {
        isTerminated: () => false,
        reportFatalError: (error: unknown) => {
          fatalErrors.push(error);
        },
      },
    });

    runtime.start();
    emitQuoteUpdated('BULL.HK', '1.23');
    await waitTick();
    await waitTick();
    await runtime.stopAndDrain();

    expect(fatalErrors).toEqual([submitError]);
  });

  it('drops non-submit ExternalApiRequestError without entering fatal state', async () => {
    const quoteError = await createExternalApiRequestError({
      operation: 'QuoteContext.realtimeQuote',
      attempts: 1,
      cause: new Error('quote timeout'),
    });
    const fatalErrors: unknown[] = [];
    const executedPrices: string[] = [];
    let shouldFail = true;
    const { deps } = await createRuntimeDeps({
      unrealizedLossMonitor: createUnrealizedLossMonitorDouble({
        monitorDirectionalUnrealizedLoss: async ({ quote }) => {
          if (shouldFail) {
            shouldFail = false;
            throw quoteError;
          }

          executedPrices.push(quote.price);
          return false;
        },
      }),
    });
    const runtime = createTradingRiskEventRuntime({
      ...deps,
      termination: {
        isTerminated: () => false,
        reportFatalError: (error: unknown) => {
          fatalErrors.push(error);
        },
      },
    });

    runtime.start();
    emitQuoteUpdated('BULL.HK', '1.23');
    await waitTick();
    await waitTick();

    emitQuoteUpdated('BULL.HK', '2.34');
    await waitTick();
    await waitTick();
    await runtime.stopAndDrain();

    expect(fatalErrors).toEqual([]);
    expect(executedPrices).toEqual(['2.34']);
  });

  it('starts and stops quote push processing', async () => {
    const executedPrices: string[] = [];
    const { deps } = await createRuntimeDeps({
      unrealizedLossMonitor: createUnrealizedLossMonitorDouble({
        monitorDirectionalUnrealizedLoss: async ({ quote }) => {
          executedPrices.push(quote.price);
          return false;
        },
      }),
    });
    const runtime = createTradingRiskEventRuntime(deps);

    runtime.start();
    emitQuoteUpdated('BULL.HK', '1.23');
    await waitTick();

    await runtime.stopAndDrain();

    emitQuoteUpdated('BULL.HK', '9.87');
    await waitTick();

    expect(executedPrices).toEqual(['1.23']);
  });

  it('does not rebuild routing index on quote events after start', async () => {
    let getSeatStateCalls = 0;
    let shortStateCalls = 0;
    let shortVersionCalls = 0;
    let getSeatVersionCalls = 0;
    const baseRegistry = createSymbolRegistryDouble({
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
    const symbolRegistry: TestSymbolRegistry = {
      ...baseRegistry,
      getSeatState: (direction) => {
        getSeatStateCalls += 1;
        if (direction === 'SHORT') shortStateCalls += 1;

        return baseRegistry.getSeatState(direction);
      },
      getSeatVersion: (direction) => {
        getSeatVersionCalls += 1;
        if (direction === 'SHORT') shortVersionCalls += 1;

        return baseRegistry.getSeatVersion(direction);
      },
    };
    const executedPrices: string[] = [];
    const { deps } = await createRuntimeDeps({
      symbolRegistry,
      unrealizedLossMonitor: createUnrealizedLossMonitorDouble({
        monitorDirectionalUnrealizedLoss: async ({ quote }) => {
          executedPrices.push(quote.price);
          return false;
        },
      }),
    });
    const runtime = createTradingRiskEventRuntime(deps);

    runtime.start();
    const stateCallsAfterStart = getSeatStateCalls;
    const versionCallsAfterStart = getSeatVersionCalls;
    const shortStateAfterStart = shortStateCalls;
    const shortVersionAfterStart = shortVersionCalls;

    emitQuoteUpdated('BULL.HK', '1.23');
    await waitTick();

    expect(executedPrices).toEqual(['1.23']);
    expect(getSeatStateCalls).toBe(stateCallsAfterStart + 5);
    expect(getSeatVersionCalls).toBe(versionCallsAfterStart + 5);
    expect(shortStateCalls).toBe(shortStateAfterStart);
    expect(shortVersionCalls).toBe(shortVersionAfterStart);
    await runtime.stopAndDrain();
  });

  it('projects routing index only on start and seat events, not quote or freshness checks', async () => {
    let getSeatStateCalls = 0;
    let shortStateCalls = 0;
    let shortVersionCalls = 0;
    let getSeatVersionCalls = 0;
    const baseRegistry = createSymbolRegistryDouble({
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
    const symbolRegistry: TestSymbolRegistry = {
      ...baseRegistry,
      getSeatState: (direction) => {
        getSeatStateCalls += 1;
        if (direction === 'SHORT') shortStateCalls += 1;

        return baseRegistry.getSeatState(direction);
      },
      getSeatVersion: (direction) => {
        getSeatVersionCalls += 1;
        if (direction === 'SHORT') shortVersionCalls += 1;

        return baseRegistry.getSeatVersion(direction);
      },
    };
    const consistencyPort = createConsistencyPort({ started: true });
    consistencyPort.enablePendingFreshWait();
    const { deps } = await createRuntimeDeps({
      consistencyPort,
      symbolRegistry,
    });
    const runtime = createTradingRiskEventRuntime(deps);

    runtime.start();
    const stateCallsAfterStart = getSeatStateCalls;
    const versionCallsAfterStart = getSeatVersionCalls;
    const shortStateAfterStart = shortStateCalls;
    const shortVersionAfterStart = shortVersionCalls;

    emitQuoteUpdated('BULL.HK', '1.23');
    await waitTick();
    expect(getSeatStateCalls).toBe(stateCallsAfterStart);
    expect(getSeatVersionCalls).toBe(versionCallsAfterStart);

    consistencyPort.resolveFresh();
    await waitTick();
    expect(getSeatStateCalls).toBe(stateCallsAfterStart + 5);
    expect(getSeatVersionCalls).toBe(versionCallsAfterStart + 5);
    expect(shortStateCalls).toBe(shortStateAfterStart);
    expect(shortVersionCalls).toBe(shortVersionAfterStart);

    symbolRegistry.updateSeatState('LONG', {
      symbol: 'BULL2.HK',
      status: 'ACTIVE',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: Date.now(),
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    });
    expect(getSeatStateCalls).toBeGreaterThan(stateCallsAfterStart);
    expect(getSeatVersionCalls).toBeGreaterThan(versionCallsAfterStart);
    expect(shortStateCalls).toBe(shortStateAfterStart + 1);
    expect(shortVersionCalls).toBe(shortVersionAfterStart + 1);

    await runtime.stopAndDrain();
  });

  it('reprojects routing index once for one atomic seat truth update', async () => {
    let getSeatStateCalls = 0;
    const baseRegistry = createSymbolRegistryDouble({
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
    const symbolRegistry: TestSymbolRegistry = {
      ...baseRegistry,
      getSeatState: (direction) => {
        getSeatStateCalls += 1;
        return baseRegistry.getSeatState(direction);
      },
    };
    const { deps } = await createRuntimeDeps({ symbolRegistry });
    const runtime = createTradingRiskEventRuntime(deps);

    runtime.start();
    const stateCallsAfterStart = getSeatStateCalls;

    symbolRegistry.updateSeatStateWithVersionBump('LONG', {
      symbol: 'BULL2.HK',
      status: 'ACTIVE',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: Date.now(),
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    });

    expect(getSeatStateCalls - stateCallsAfterStart).toBe(2);
    await runtime.stopAndDrain();
  });

  it('uses the refreshed seat version for quotes after an atomic seat update', async () => {
    const executedSeatVersions: number[] = [];
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
      longVersion: 1,
    });
    const { deps } = await createRuntimeDeps({
      symbolRegistry,
      unrealizedLossMonitor: createUnrealizedLossMonitorDouble({
        monitorDirectionalUnrealizedLoss: async ({ seatVersion }) => {
          executedSeatVersions.push(seatVersion);
          return false;
        },
      }),
    });
    const runtime = createTradingRiskEventRuntime(deps);

    runtime.start();
    symbolRegistry.updateSeatStateWithVersionBump('LONG', {
      ...symbolRegistry.getSeatState('LONG'),
      lastSeatActivatedAt: 1,
    });
    emitQuoteUpdated('BULL.HK', '1.23');
    await waitTick();

    expect(executedSeatVersions).toEqual([2]);
    await runtime.stopAndDrain();
  });

  it('unsubscribes from seat truth events after stopAndDrain', async () => {
    let getSeatStateCalls = 0;
    const baseRegistry = createSymbolRegistryDouble({
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
    const symbolRegistry: TestSymbolRegistry = {
      ...baseRegistry,
      getSeatState: (direction) => {
        getSeatStateCalls += 1;
        return baseRegistry.getSeatState(direction);
      },
    };
    const { deps } = await createRuntimeDeps({ symbolRegistry });
    const runtime = createTradingRiskEventRuntime(deps);

    runtime.start();
    expect(symbolRegistry.getSeatStateChangedListenerCount()).toBe(0);
    expect(symbolRegistry.getSeatTruthChangedListenerCount()).toBe(1);

    await runtime.stopAndDrain();
    const stateCallsAfterStop = getSeatStateCalls;
    symbolRegistry.updateSeatState('LONG', {
      symbol: 'BULL2.HK',
      status: 'ACTIVE',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: Date.now(),
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    });

    expect(symbolRegistry.getSeatTruthChangedListenerCount()).toBe(0);
    expect(getSeatStateCalls).toBe(stateCallsAfterStop);
    expect(quoteUpdatedListeners.size).toBe(0);
  });

  it('propagates runtime duplicate routing fatal and stops later risk processing', async () => {
    const hsiLong: SeatState = {
      symbol: 'BULL.HK',
      status: 'ACTIVE',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    };
    const hsiShort: SeatState = {
      symbol: 'BEAR.HK',
      status: 'ACTIVE',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    };
    const symbolRegistry = createSymbolRegistryDouble({
      longSeat: hsiLong,
      shortSeat: hsiShort,
      longVersion: 1,
      shortVersion: 1,
    });
    const executedSymbols: string[] = [];
    const fatalErrors: Error[] = [];
    const probeSymbols: string[] = [];
    const monitorContext = createMonitorContextDouble({
      config: createMonitorConfig({ monitorSymbol: 'HSI.HK' }),
      symbolRegistry,
      unrealizedLossMonitor: createUnrealizedLossMonitorDouble({
        monitorDirectionalUnrealizedLoss: async ({ symbol }) => {
          executedSymbols.push(symbol);
          return false;
        },
      }),
    });
    const { deps } = await createRuntimeDeps({
      symbolRegistry,
      monitorContext,
    });
    const runtime = createTradingRiskEventRuntime({
      ...deps,
      termination: {
        isTerminated: () => false,
        reportFatalError: (error) => {
          fatalErrors.push(error instanceof Error ? error : new Error(String(error)));
        },
      },
    });

    runtime.start();
    subscribeQuoteProbe(probeSymbols);

    expect(() => {
      symbolRegistry.updateSeatState('SHORT', {
        ...hsiShort,
        symbol: 'BULL.HK',
        lastSeatActivatedAt: 1,
      });
    }).not.toThrow();

    expect(() => {
      emitQuoteUpdated('BULL.HK', '1.23');
    }).not.toThrow();
    await waitTick();

    expect(fatalErrors.some((error) => error.message.includes('重复归属'))).toBe(true);
    expect(executedSymbols).toEqual([]);
    expect(probeSymbols).toEqual(['BULL.HK']);

    symbolRegistry.updateSeatStateWithVersionBump('SHORT', {
      ...hsiShort,
      symbol: 'BEAR2.HK',
      lastSeatActivatedAt: 1,
    });
    emitQuoteUpdated('BULL.HK', '2.34');
    await waitTick();

    expect(executedSymbols).toEqual([]);
    expect(probeSymbols).toEqual(['BULL.HK', 'BULL.HK']);
    await runtime.stopAndDrain();
  });

  it('stops an in-flight route on routing fatal without ordinary processing failure logs', async () => {
    const errorLogs: string[] = [];
    const testLogger = {
      error: (message: string) => {
        errorLogs.push(message);
      },
    };

    const hsiLong: SeatState = {
      symbol: 'BULL.HK',
      status: 'ACTIVE',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    };
    const hsiShort: SeatState = {
      symbol: 'BEAR.HK',
      status: 'ACTIVE',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    };
    const symbolRegistry = createSymbolRegistryDouble({
      longSeat: hsiLong,
      shortSeat: hsiShort,
      longVersion: 1,
      shortVersion: 1,
    });
    const consistencyPort = createConsistencyPort({ started: true });
    consistencyPort.enablePendingFreshWait();
    const executedSymbols: string[] = [];
    const monitorContext = createMonitorContextDouble({
      config: createMonitorConfig({ monitorSymbol: 'HSI.HK' }),
      symbolRegistry,
      unrealizedLossMonitor: createUnrealizedLossMonitorDouble({
        monitorDirectionalUnrealizedLoss: async ({ symbol }) => {
          executedSymbols.push(symbol);
          return false;
        },
      }),
    });
    const { deps } = await createRuntimeDeps({
      consistencyPort,
      symbolRegistry,
      monitorContext,
      logger: testLogger,
    });
    const runtime = createTradingRiskEventRuntime(deps);

    runtime.start();
    emitQuoteUpdated('BULL.HK', '1.23');
    await waitTick();

    expect(() => {
      symbolRegistry.updateSeatState('SHORT', {
        ...hsiShort,
        symbol: 'BULL.HK',
        lastSeatActivatedAt: 1,
      });
    }).not.toThrow();
    consistencyPort.resolveFresh();
    await waitTick();

    expect(executedSymbols).toEqual([]);
    expect(errorLogs).not.toContain('[TradingRiskEventRuntime] 风险事件处理失败');
    await runtime.stopAndDrain();
  });

  it('fails fast on start when duplicate trading-symbol ownership already exists', async () => {
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
      config: createMonitorConfig({ monitorSymbol: 'HSI.HK' }),
      symbolRegistry,
    });
    const { deps } = await createRuntimeDeps({
      symbolRegistry,
      monitorContext,
    });
    symbolRegistry.updateSeatState('SHORT', {
      ...symbolRegistry.getSeatState('SHORT'),
      symbol: 'BULL.HK',
      status: 'ACTIVE',
      lastSeatActivatedAt: 1,
      callPrice: null,
    });
    const runtime = createTradingRiskEventRuntime(deps);

    expect(() => {
      runtime.start();
    }).toThrow('重复归属');
  });

  it('skips when trading gate is closed', async () => {
    const executedPrices: string[] = [];
    const { deps } = await createRuntimeDeps({
      lastState: {
        canTrade: false,
        isTradingEnabled: true,
        isHalfDay: false,
      },
      unrealizedLossMonitor: createUnrealizedLossMonitorDouble({
        monitorDirectionalUnrealizedLoss: async ({ quote }) => {
          executedPrices.push(quote.price);
          return false;
        },
      }),
    });
    const runtime = createTradingRiskEventRuntime(deps);

    runtime.start();
    emitQuoteUpdated('BULL.HK', '1.23');
    await waitTick();

    expect(executedPrices).toEqual([]);
    await runtime.stopAndDrain();
  });

  it('skips when baseline is not ready', async () => {
    const executedPrices: string[] = [];
    const consistencyPort = createConsistencyPort({ started: false });
    const { deps } = await createRuntimeDeps({
      consistencyPort,
      unrealizedLossMonitor: createUnrealizedLossMonitorDouble({
        monitorDirectionalUnrealizedLoss: async ({ quote }) => {
          executedPrices.push(quote.price);
          return false;
        },
      }),
    });
    const runtime = createTradingRiskEventRuntime(deps);

    runtime.start();
    emitQuoteUpdated('BULL.HK', '1.23');
    await waitTick();

    expect(executedPrices).toEqual([]);
    await runtime.stopAndDrain();
  });

  it('skips stale routes when seat version changes during freshness wait', async () => {
    const executedPrices: string[] = [];
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
      longVersion: 1,
      shortVersion: 1,
    });
    const consistencyPort = createConsistencyPort({ started: true });
    consistencyPort.enablePendingFreshWait();
    const { deps } = await createRuntimeDeps({
      consistencyPort,
      symbolRegistry,
      unrealizedLossMonitor: createUnrealizedLossMonitorDouble({
        monitorDirectionalUnrealizedLoss: async ({ quote }) => {
          executedPrices.push(quote.price);
          return false;
        },
      }),
    });
    const runtime = createTradingRiskEventRuntime(deps);

    runtime.start();
    emitQuoteUpdated('BULL.HK', '1.23');
    await waitTick();

    symbolRegistry.updateSeatStateWithVersionBump('LONG', {
      ...symbolRegistry.getSeatState('LONG'),
      lastSeatActivatedAt: 1,
    });
    consistencyPort.resolveFresh();
    await waitTick();

    expect(executedPrices).toEqual([]);
    await runtime.stopAndDrain();
  });

  it('skips when doomsday protection takes over in the final five minutes', async () => {
    const executedPrices: string[] = [];
    const { deps } = await createRuntimeDeps({
      doomsdayProtectionEnabled: true,
      now: () => new Date('2026-04-06T07:56:00.000Z'),
      unrealizedLossMonitor: createUnrealizedLossMonitorDouble({
        monitorDirectionalUnrealizedLoss: async ({ quote }) => {
          executedPrices.push(quote.price);
          return false;
        },
      }),
    });
    const runtime = createTradingRiskEventRuntime(deps);

    runtime.start();
    emitQuoteUpdated('BULL.HK', '1.23');
    await waitTick();

    expect(executedPrices).toEqual([]);
    await runtime.stopAndDrain();
  });

  it('skips when baseline becomes stale again after freshness wait', async () => {
    const executedPrices: string[] = [];
    const consistencyPort = createConsistencyPort({ started: true });
    consistencyPort.enablePendingFreshWait();
    const { deps } = await createRuntimeDeps({
      consistencyPort,
      unrealizedLossMonitor: createUnrealizedLossMonitorDouble({
        monitorDirectionalUnrealizedLoss: async ({ quote }) => {
          executedPrices.push(quote.price);
          return false;
        },
      }),
    });
    const runtime = createTradingRiskEventRuntime(deps);

    runtime.start();
    emitQuoteUpdated('BULL.HK', '1.23');
    await waitTick();

    consistencyPort.registerNewRefreshNeed();
    consistencyPort.resolveFresh();
    await waitTick();

    expect(executedPrices).toEqual([]);
    await runtime.stopAndDrain();
  });

  it('skips when trading gate closes after freshness wait', async () => {
    const executedPrices: string[] = [];
    const consistencyPort = createConsistencyPort({ started: true });
    consistencyPort.enablePendingFreshWait();
    const lastState = {
      canTrade: true,
      isTradingEnabled: true,
      isHalfDay: false,
    };
    const { deps } = await createRuntimeDeps({
      consistencyPort,
      lastState,
      unrealizedLossMonitor: createUnrealizedLossMonitorDouble({
        monitorDirectionalUnrealizedLoss: async ({ quote }) => {
          executedPrices.push(quote.price);
          return false;
        },
      }),
    });
    const runtime = createTradingRiskEventRuntime(deps);

    runtime.start();
    emitQuoteUpdated('BULL.HK', '1.23');
    await waitTick();

    lastState.canTrade = false;
    consistencyPort.resolveFresh();
    await waitTick();

    expect(executedPrices).toEqual([]);
    await runtime.stopAndDrain();
  });

  it('collapses concurrent events to the latest quote for the same route', async () => {
    const executedPrices: string[] = [];
    const firstCall = createDeferred();
    let callCount = 0;
    const { deps } = await createRuntimeDeps({
      unrealizedLossMonitor: createUnrealizedLossMonitorDouble({
        monitorDirectionalUnrealizedLoss: async ({ quote }) => {
          callCount += 1;
          executedPrices.push(quote.price);
          if (callCount === 1) {
            await firstCall.promise;
          }

          return false;
        },
      }),
    });
    const runtime = createTradingRiskEventRuntime(deps);

    runtime.start();
    emitQuoteUpdated('BULL.HK', '1');
    await waitTick();

    emitQuoteUpdated('BULL.HK', '2');
    emitQuoteUpdated('BULL.HK', '3');
    await waitTick();

    firstCall.resolve();
    await waitTick();
    await waitTick();

    expect(executedPrices).toEqual(['1', '3']);
    await runtime.stopAndDrain();
  });
});

describe('unrealizedLossMonitor directional execution', () => {
  it('writes seatVersion into the liquidation signal', async () => {
    const executedSignals: Array<{ readonly seatVersion: number | null; readonly action: string }> =
      [];
    const trader = createTraderDouble({
      executeSignals: async (signals, callerAuthorization) => {
        expect(callerAuthorization()).toBe(true);
        for (const signal of signals) {
          executedSignals.push({
            seatVersion: signal.seatVersion,
            action: signal.action,
          });
        }

        return { executedOrderIds: signals.map(() => `EXECUTED-ORDER`) };
      },
    });
    const riskChecker = createRiskCheckerDouble({
      checkUnrealizedLoss: () => ({
        shouldLiquidate: true,
        reason: 'test-liquidation',
        quantity: 1,
      }),
    });
    const monitor = createUnrealizedLossMonitor({
      maxUnrealizedLossPerSymbol: '1',
    });

    const symbolRegistry = createSymbolRegistryDouble({ longVersion: 7 });
    const context = createMonitorContextDouble({ symbolRegistry, riskChecker });
    const snapshot = await createSnapshotFixture({
      account: createAccountSnapshotDouble('100000'),
      positions: [],
    });
    const termination = createTerminationRuntime({
      closeTradingGate: () => {},
      closeProducerAdmission: () => {},
      stopProducers: [],
      onSecondaryError: () => {},
    });
    const settlement = createSettlementRuntimeFixture({
      snapshot,
      termination,
      monitorContext: context,
      getTrader: () => trader,
      onPositionsCommitted: async (token) => {
        expect(token).toBe(snapshot.getView().token);
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
    const capturedReceipt = await settlement.waitForFresh();
    const capturedSeatVersion = symbolRegistry.getSeatVersion('LONG');
    const isCurrent = () =>
      !termination.isTerminated() &&
      settlement.isCurrent(capturedReceipt) &&
      snapshot.isCurrent(capturedReceipt.snapshotToken, { account: false, positions: true }) &&
      symbolRegistry.getSeatVersion('LONG') === capturedSeatVersion;
    settlementCleanups.push(settlement.stopAndDrain);

    await monitor.monitorDirectionalUnrealizedLoss({
      isCurrent,
      symbol: 'BULL.HK',
      isLong: true,
      seatVersion: 7,
      quote: createQuoteDouble('BULL.HK', '1.23', 100),
      riskChecker,
      trader,
      orderRecorder: createOrderRecorderDouble(),
      dailyLossTracker: createDailyLossTrackerDouble(),
    });

    expect(executedSignals).toEqual([
      {
        seatVersion: 7,
        action: 'SELLCALL',
      },
    ]);
  });
});
