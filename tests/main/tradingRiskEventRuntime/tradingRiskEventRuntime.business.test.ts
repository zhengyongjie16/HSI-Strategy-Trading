/**
 * TradingRiskEventRuntime 业务测试
 *
 * 功能：
 * - 验证路由索引、门禁、seat 版本校验与 single-flight latest-only 语义
 * - 验证单方向浮亏执行器会把 seatVersion 写入清仓信号
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import {
  createMonitorContextDouble,
  createOrderRecorderDouble,
  createRiskCheckerDouble,
  createSymbolRegistryDouble,
  createTraderDouble,
  createUnrealizedLossMonitorDouble,
  createQuoteDouble,
  createDailyLossTrackerDouble,
} from '../../helpers/testDoubles.js';
import { createMonitorConfig } from '../../../mock/factories/configFactory.js';
import { createTradingRiskEventRuntime } from '../../../src/main/tradingRiskEventRuntime/tradingRiskEventRuntime.js';
import { buildTradingRiskRoutingIndex } from '../../../src/main/tradingRiskEventRuntime/routingIndex.js';
import { logger } from '../../../src/utils/logger/index.js';
import { resolveTradingRiskRoute } from '../../../src/main/tradingRiskEventRuntime/routeValidation.js';
import { createUnrealizedLossMonitor } from '../../../src/core/riskController/unrealizedLossMonitor.js';
import { createExternalApiRequestError } from '../../../src/utils/apiFailure/index.js';
import type { TradingRiskEventRuntimeDeps } from '../../../src/main/tradingRiskEventRuntime/types.js';
import type { QuoteUpdatedEvent } from '../../../src/types/services.js';
import type { Logger } from '../../../src/utils/logger/types.js';
import type { SeatState, SymbolRegistry } from '../../../src/types/seat.js';

type TestTradingRiskConsistencyStatus = ReturnType<
  TradingRiskEventRuntimeDeps['postTradeConsistencyRuntime']['getStatus']
>;

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

function createConsistencyPort(initialStatus: TestTradingRiskConsistencyStatus) {
  let status = initialStatus;
  let freshDeferred: ReturnType<typeof createDeferred<void>> | null = null;
  return {
    enablePendingFreshWait: () => {
      freshDeferred = createDeferred();
    },
    port: {
      getStatus: () => status,
      waitForFresh: async () => {
        if (freshDeferred) {
          await freshDeferred.promise;
        }
      },
    },
    setStatus: (nextStatus: TestTradingRiskConsistencyStatus) => {
      status = nextStatus;
    },
    resolveFresh: () => {
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
    const monitorContext = createMonitorContextDouble({
      config: createMonitorConfig({ monitorSymbol: 'HSI.HK' }),
      symbolRegistry,
    });

    expect(() =>
      buildTradingRiskRoutingIndex({
        monitorContext,
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
    const monitorContext = createMonitorContextDouble({
      config: createMonitorConfig({ monitorSymbol: 'HSI.HK' }),
      symbolRegistry,
    });
    const routingIndex = buildTradingRiskRoutingIndex({
      monitorContext,
      symbolRegistry,
    });

    const longRoute = resolveTradingRiskRoute(routingIndex, 'BULL.HK');
    expect(longRoute?.routeKey).toBe('LONG');
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

  function createRuntimeDeps(
    params: {
      readonly lastState?: {
        readonly canTrade: boolean | null;
        readonly isTradingEnabled: boolean;
        readonly isHalfDay: boolean | null;
      };
      readonly doomsdayProtectionEnabled?: boolean;
      readonly consistencyPort?: ReturnType<typeof createConsistencyPort>;
      readonly consistencyStatus?: TestTradingRiskConsistencyStatus;
      readonly monitorContext?: ReturnType<typeof createMonitorContextDouble>;
      readonly now?: () => Date;
      readonly symbolRegistry?: SymbolRegistry;
      readonly trader?: ReturnType<typeof createTraderDouble>;
      readonly unrealizedLossMonitor?: ReturnType<typeof createUnrealizedLossMonitorDouble>;
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
        monitorDirectionalUnrealizedLoss: async () => {},
      });
    const monitorContext =
      params.monitorContext ??
      createMonitorContextDouble({
        config: createMonitorConfig({ monitorSymbol: 'HSI.HK' }),
        symbolRegistry,
        unrealizedLossMonitor,
      });
    const consistencyPort =
      params.consistencyPort ??
      createConsistencyPort(
        params.consistencyStatus ?? {
          started: true,
          currentVersion: 1,
          staleVersion: 1,
        },
      );

    return {
      deps: {
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
        lastState: params.lastState ?? {
          canTrade: true,
          isTradingEnabled: true,
          isHalfDay: false,
        },
        postTradeConsistencyRuntime: consistencyPort.port,
        doomsdayProtectionEnabled: params.doomsdayProtectionEnabled ?? false,
        now: params.now ?? (() => new Date('2026-04-06T01:30:00.000Z')),
      },
      consistencyPort,
      trader,
    };
  }

  function emitQuoteUpdated(symbol: string, price: number): void {
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
    const { deps } = createRuntimeDeps({
      unrealizedLossMonitor: createUnrealizedLossMonitorDouble({
        monitorDirectionalUnrealizedLoss: async () => {
          throw new TypeError('risk route broken');
        },
      }),
    });
    const runtime = createTradingRiskEventRuntime({
      ...deps,
      onFatalError: (error: unknown) => {
        fatalErrors.push(error);
      },
    });

    runtime.start();
    emitQuoteUpdated('BULL.HK', 1.23);
    await waitTick();
    await waitTick();
    await runtime.stopAndDrain();

    expect(fatalErrors).toHaveLength(1);
    expect(fatalErrors[0]).toBeInstanceOf(TypeError);
    expect((fatalErrors[0] as Error).message).toContain('risk route broken');
  });

  it('exposes protective liquidation submitOrder uncertainty to fatal handler', async () => {
    const submitError = createExternalApiRequestError({
      operation: 'TradeContext.submitOrder',
      attempts: 1,
      cause: new Error('submit timeout'),
    });
    const fatalErrors: unknown[] = [];
    const { deps } = createRuntimeDeps({
      unrealizedLossMonitor: createUnrealizedLossMonitorDouble({
        monitorDirectionalUnrealizedLoss: async () => {
          throw submitError;
        },
      }),
    });
    const runtime = createTradingRiskEventRuntime({
      ...deps,
      onFatalError: (error: unknown) => {
        fatalErrors.push(error);
      },
    });

    runtime.start();
    emitQuoteUpdated('BULL.HK', 1.23);
    await waitTick();
    await waitTick();
    await runtime.stopAndDrain();

    expect(fatalErrors).toEqual([submitError]);
  });

  it('drops non-submit ExternalApiRequestError without entering fatal state', async () => {
    const quoteError = createExternalApiRequestError({
      operation: 'QuoteContext.realtimeQuote',
      attempts: 1,
      cause: new Error('quote timeout'),
    });
    const fatalErrors: unknown[] = [];
    const executedPrices: number[] = [];
    let shouldFail = true;
    const { deps } = createRuntimeDeps({
      unrealizedLossMonitor: createUnrealizedLossMonitorDouble({
        monitorDirectionalUnrealizedLoss: async ({ quote }) => {
          if (shouldFail) {
            shouldFail = false;
            throw quoteError;
          }

          executedPrices.push(quote.price);
        },
      }),
    });
    const runtime = createTradingRiskEventRuntime({
      ...deps,
      onFatalError: (error: unknown) => {
        fatalErrors.push(error);
      },
    });

    runtime.start();
    emitQuoteUpdated('BULL.HK', 1.23);
    await waitTick();
    await waitTick();

    emitQuoteUpdated('BULL.HK', 2.34);
    await waitTick();
    await waitTick();
    await runtime.stopAndDrain();

    expect(fatalErrors).toEqual([]);
    expect(executedPrices).toEqual([2.34]);
  });

  it('starts and stops quote push processing', async () => {
    const executedPrices: number[] = [];
    const { deps } = createRuntimeDeps({
      unrealizedLossMonitor: createUnrealizedLossMonitorDouble({
        monitorDirectionalUnrealizedLoss: async ({ quote }) => {
          executedPrices.push(quote.price);
        },
      }),
    });
    const runtime = createTradingRiskEventRuntime(deps);

    runtime.start();
    emitQuoteUpdated('BULL.HK', 1.23);
    await waitTick();

    await runtime.stopAndDrain();

    emitQuoteUpdated('BULL.HK', 9.87);
    await waitTick();

    expect(executedPrices).toEqual([1.23]);
  });

  it('does not rebuild routing index on quote events after start', async () => {
    let getSeatStateCalls = 0;
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
        return baseRegistry.getSeatState(direction);
      },
      getSeatVersion: (direction) => {
        getSeatVersionCalls += 1;
        return baseRegistry.getSeatVersion(direction);
      },
    };
    const executedPrices: number[] = [];
    const { deps } = createRuntimeDeps({
      symbolRegistry,
      unrealizedLossMonitor: createUnrealizedLossMonitorDouble({
        monitorDirectionalUnrealizedLoss: async ({ quote }) => {
          executedPrices.push(quote.price);
        },
      }),
    });
    const runtime = createTradingRiskEventRuntime(deps);

    runtime.start();
    const stateCallsAfterStart = getSeatStateCalls;
    const versionCallsAfterStart = getSeatVersionCalls;

    emitQuoteUpdated('BULL.HK', 1.23);
    await waitTick();

    expect(executedPrices).toEqual([1.23]);
    expect(getSeatStateCalls).toBe(stateCallsAfterStart);
    expect(getSeatVersionCalls).toBe(versionCallsAfterStart);
    await runtime.stopAndDrain();
  });

  it('projects routing index only on start and seat events, not quote or freshness checks', async () => {
    let getSeatStateCalls = 0;
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
        return baseRegistry.getSeatState(direction);
      },
      getSeatVersion: (direction) => {
        getSeatVersionCalls += 1;
        return baseRegistry.getSeatVersion(direction);
      },
    };
    const consistencyPort = createConsistencyPort({
      started: true,
      currentVersion: 1,
      staleVersion: 1,
    });
    consistencyPort.enablePendingFreshWait();
    const { deps } = createRuntimeDeps({
      consistencyPort,
      symbolRegistry,
    });
    const runtime = createTradingRiskEventRuntime(deps);

    runtime.start();
    const stateCallsAfterStart = getSeatStateCalls;
    const versionCallsAfterStart = getSeatVersionCalls;

    emitQuoteUpdated('BULL.HK', 1.23);
    await waitTick();
    expect(getSeatStateCalls).toBe(stateCallsAfterStart);
    expect(getSeatVersionCalls).toBe(versionCallsAfterStart);

    consistencyPort.resolveFresh();
    await waitTick();
    expect(getSeatStateCalls).toBe(stateCallsAfterStart);
    expect(getSeatVersionCalls).toBe(versionCallsAfterStart);

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
    const { deps } = createRuntimeDeps({ symbolRegistry });
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
    const { deps } = createRuntimeDeps({
      symbolRegistry,
      unrealizedLossMonitor: createUnrealizedLossMonitorDouble({
        monitorDirectionalUnrealizedLoss: async ({ seatVersion }) => {
          executedSeatVersions.push(seatVersion);
        },
      }),
    });
    const runtime = createTradingRiskEventRuntime(deps);

    runtime.start();
    symbolRegistry.updateSeatStateWithVersionBump('LONG', symbolRegistry.getSeatState('LONG'));
    emitQuoteUpdated('BULL.HK', 1.23);
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
    const { deps } = createRuntimeDeps({ symbolRegistry });
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
      monitorSymbol: 'HSI.HK',
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
        },
      }),
    });
    const { deps } = createRuntimeDeps({
      symbolRegistry,
      monitorContext,
    });
    const runtime = createTradingRiskEventRuntime({
      ...deps,
      onFatalError: (error) => {
        fatalErrors.push(error instanceof Error ? error : new Error(String(error)));
      },
    });

    runtime.start();
    subscribeQuoteProbe(probeSymbols);

    expect(() => {
      symbolRegistry.updateSeatState('SHORT', {
        ...hsiShort,
        symbol: 'BULL.HK',
      });
    }).not.toThrow();

    expect(() => {
      emitQuoteUpdated('BULL.HK', 1.23);
    }).not.toThrow();
    await waitTick();

    expect(fatalErrors.some((error) => error.message.includes('重复归属'))).toBe(true);
    expect(executedSymbols).toEqual([]);
    expect(probeSymbols).toEqual(['BULL.HK']);

    symbolRegistry.updateSeatStateWithVersionBump('SHORT', {
      ...hsiShort,
      symbol: 'BEAR2.HK',
    });
    emitQuoteUpdated('BULL.HK', 2.34);
    await waitTick();

    expect(executedSymbols).toEqual([]);
    expect(probeSymbols).toEqual(['BULL.HK', 'BULL.HK']);
    await runtime.stopAndDrain();
  });

  it('stops an in-flight route on routing fatal without ordinary processing failure logs', async () => {
    const originalErrorLogger = logger.error;
    const errorLogs: string[] = [];
    logger.error = ((message: string) => {
      errorLogs.push(message);
    }) satisfies Logger['error'];

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
      monitorSymbol: 'HSI.HK',
      longSeat: hsiLong,
      shortSeat: hsiShort,
      longVersion: 1,
      shortVersion: 1,
    });
    const consistencyPort = createConsistencyPort({
      started: true,
      currentVersion: 1,
      staleVersion: 1,
    });
    consistencyPort.enablePendingFreshWait();
    const executedSymbols: string[] = [];
    const monitorContext = createMonitorContextDouble({
      config: createMonitorConfig({ monitorSymbol: 'HSI.HK' }),
      symbolRegistry,
      unrealizedLossMonitor: createUnrealizedLossMonitorDouble({
        monitorDirectionalUnrealizedLoss: async ({ symbol }) => {
          executedSymbols.push(symbol);
        },
      }),
    });
    const { deps } = createRuntimeDeps({
      consistencyPort,
      symbolRegistry,
      monitorContext,
    });
    const runtime = createTradingRiskEventRuntime(deps);

    try {
      runtime.start();
      emitQuoteUpdated('BULL.HK', 1.23);
      await waitTick();

      expect(() => {
        symbolRegistry.updateSeatState('SHORT', {
          ...hsiShort,
          symbol: 'BULL.HK',
        });
      }).not.toThrow();
      consistencyPort.resolveFresh();
      await waitTick();

      expect(executedSymbols).toEqual([]);
      expect(errorLogs).not.toContain('[TradingRiskEventRuntime] 风险事件处理失败');
      await runtime.stopAndDrain();
    } finally {
      logger.error = originalErrorLogger;
    }
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
        symbol: 'BULL.HK',
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
    const { deps } = createRuntimeDeps({
      symbolRegistry,
      monitorContext,
    });
    const runtime = createTradingRiskEventRuntime(deps);

    expect(() => {
      runtime.start();
    }).toThrow('重复归属');
  });

  it('skips when trading gate is closed', async () => {
    const executedPrices: number[] = [];
    const { deps } = createRuntimeDeps({
      lastState: {
        canTrade: false,
        isTradingEnabled: true,
        isHalfDay: false,
      },
      unrealizedLossMonitor: createUnrealizedLossMonitorDouble({
        monitorDirectionalUnrealizedLoss: async ({ quote }) => {
          executedPrices.push(quote.price);
        },
      }),
    });
    const runtime = createTradingRiskEventRuntime(deps);

    runtime.start();
    emitQuoteUpdated('BULL.HK', 1.23);
    await waitTick();

    expect(executedPrices).toEqual([]);
    await runtime.stopAndDrain();
  });

  it('skips when baseline is not ready', async () => {
    const executedPrices: number[] = [];
    const consistencyPort = createConsistencyPort({
      started: false,
      currentVersion: 1,
      staleVersion: 1,
    });
    const { deps } = createRuntimeDeps({
      consistencyPort,
      unrealizedLossMonitor: createUnrealizedLossMonitorDouble({
        monitorDirectionalUnrealizedLoss: async ({ quote }) => {
          executedPrices.push(quote.price);
        },
      }),
    });
    const runtime = createTradingRiskEventRuntime(deps);

    runtime.start();
    emitQuoteUpdated('BULL.HK', 1.23);
    await waitTick();

    expect(executedPrices).toEqual([]);
    await runtime.stopAndDrain();
  });

  it('skips stale routes when seat version changes during freshness wait', async () => {
    const executedPrices: number[] = [];
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
    const consistencyPort = createConsistencyPort({
      started: true,
      currentVersion: 1,
      staleVersion: 1,
    });
    consistencyPort.enablePendingFreshWait();
    const { deps } = createRuntimeDeps({
      consistencyPort,
      symbolRegistry,
      unrealizedLossMonitor: createUnrealizedLossMonitorDouble({
        monitorDirectionalUnrealizedLoss: async ({ quote }) => {
          executedPrices.push(quote.price);
        },
      }),
    });
    const runtime = createTradingRiskEventRuntime(deps);

    runtime.start();
    emitQuoteUpdated('BULL.HK', 1.23);
    await waitTick();

    symbolRegistry.updateSeatStateWithVersionBump('LONG', symbolRegistry.getSeatState('LONG'));
    consistencyPort.resolveFresh();
    await waitTick();

    expect(executedPrices).toEqual([]);
    await runtime.stopAndDrain();
  });

  it('skips when doomsday protection takes over in the final five minutes', async () => {
    const executedPrices: number[] = [];
    const { deps } = createRuntimeDeps({
      doomsdayProtectionEnabled: true,
      now: () => new Date('2026-04-06T07:56:00.000Z'),
      unrealizedLossMonitor: createUnrealizedLossMonitorDouble({
        monitorDirectionalUnrealizedLoss: async ({ quote }) => {
          executedPrices.push(quote.price);
        },
      }),
    });
    const runtime = createTradingRiskEventRuntime(deps);

    runtime.start();
    emitQuoteUpdated('BULL.HK', 1.23);
    await waitTick();

    expect(executedPrices).toEqual([]);
    await runtime.stopAndDrain();
  });

  it('skips when baseline becomes stale again after freshness wait', async () => {
    const executedPrices: number[] = [];
    const consistencyPort = createConsistencyPort({
      started: true,
      currentVersion: 1,
      staleVersion: 1,
    });
    consistencyPort.enablePendingFreshWait();
    const { deps } = createRuntimeDeps({
      consistencyPort,
      unrealizedLossMonitor: createUnrealizedLossMonitorDouble({
        monitorDirectionalUnrealizedLoss: async ({ quote }) => {
          executedPrices.push(quote.price);
        },
      }),
    });
    const runtime = createTradingRiskEventRuntime(deps);

    runtime.start();
    emitQuoteUpdated('BULL.HK', 1.23);
    await waitTick();

    consistencyPort.setStatus({
      started: true,
      currentVersion: 1,
      staleVersion: 2,
    });
    consistencyPort.resolveFresh();
    await waitTick();

    expect(executedPrices).toEqual([]);
    await runtime.stopAndDrain();
  });

  it('skips when trading gate closes after freshness wait', async () => {
    const executedPrices: number[] = [];
    const consistencyPort = createConsistencyPort({
      started: true,
      currentVersion: 1,
      staleVersion: 1,
    });
    consistencyPort.enablePendingFreshWait();
    const lastState = {
      canTrade: true,
      isTradingEnabled: true,
      isHalfDay: false,
    };
    const { deps } = createRuntimeDeps({
      consistencyPort,
      lastState,
      unrealizedLossMonitor: createUnrealizedLossMonitorDouble({
        monitorDirectionalUnrealizedLoss: async ({ quote }) => {
          executedPrices.push(quote.price);
        },
      }),
    });
    const runtime = createTradingRiskEventRuntime(deps);

    runtime.start();
    emitQuoteUpdated('BULL.HK', 1.23);
    await waitTick();

    lastState.canTrade = false;
    consistencyPort.resolveFresh();
    await waitTick();

    expect(executedPrices).toEqual([]);
    await runtime.stopAndDrain();
  });

  it('collapses concurrent events to the latest quote for the same route', async () => {
    const executedPrices: number[] = [];
    const firstCall = createDeferred();
    let callCount = 0;
    const { deps } = createRuntimeDeps({
      unrealizedLossMonitor: createUnrealizedLossMonitorDouble({
        monitorDirectionalUnrealizedLoss: async ({ quote }) => {
          callCount += 1;
          executedPrices.push(quote.price);
          if (callCount === 1) {
            await firstCall.promise;
          }
        },
      }),
    });
    const runtime = createTradingRiskEventRuntime(deps);

    runtime.start();
    emitQuoteUpdated('BULL.HK', 1);
    await waitTick();

    emitQuoteUpdated('BULL.HK', 2);
    emitQuoteUpdated('BULL.HK', 3);
    await waitTick();

    firstCall.resolve();
    await waitTick();
    await waitTick();

    expect(executedPrices).toEqual([1, 3]);
    await runtime.stopAndDrain();
  });
});

describe('unrealizedLossMonitor directional execution', () => {
  it('writes seatVersion into the liquidation signal', async () => {
    const executedSignals: Array<{ readonly seatVersion: number | null; readonly action: string }> =
      [];
    const trader = createTraderDouble({
      executeSignals: async (signals) => {
        for (const signal of signals) {
          executedSignals.push({
            seatVersion: signal.seatVersion,
            action: signal.action,
          });
        }

        return { submittedCount: signals.length, submittedOrderIds: [] };
      },
    });
    const riskChecker = createRiskCheckerDouble({
      checkUnrealizedLoss: () => ({
        shouldLiquidate: true,
        reason: 'test-liquidation',
        quantity: 1,
      }),
      refreshUnrealizedLossData: async () => ({ r1: 0, n1: 0 }),
    });
    const monitor = createUnrealizedLossMonitor({
      maxUnrealizedLossPerSymbol: 1,
    });

    await monitor.monitorDirectionalUnrealizedLoss({
      symbol: 'BULL.HK',
      isLong: true,
      seatVersion: 7,
      quote: createQuoteDouble('BULL.HK', 1.23, 100),
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
