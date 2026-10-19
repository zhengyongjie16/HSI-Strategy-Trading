import {
  createMarketDataClientDouble,
  createMonitorConfigDouble,
  createQuoteContextDouble,
  createSymbolRegistryDouble,
} from '../../helpers/testDoubles.js';

/**
 * 交易日重建席位恢复业务测试
 *
 * 功能：
 * - 验证席位解析与就绪状态的场景与边界。
 */
import { describe, expect, it } from 'bun:test';
import type { MarketQuoteContext } from '../../../src/types/marketPorts.js';

import { prepareSeatsForRuntime } from '../../../src/application/tradingDayRebuild/seatPreparation.js';
import { createWarrantCandidateSearch } from '../../../src/application/autoSearch/candidateSearch.js';
import { createStartupSeatSearch } from '../../../src/application/autoSearch/startupSeatSearch.js';
import { AUTO_SYMBOL_MAX_SEARCH_FAILURES_PER_DAY } from '../../../src/constants/index.js';
import { getHKDateKey } from '../../../src/utils/time/index.js';

import { createTradingConfig } from '../../../mock/factories/configFactory.js';
import type { Logger } from '../../../src/types/logger.js';
import { createExternalApiRequestError } from '../../helpers/createExternalApiRequestError.js';

function createLoggerStub(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

/** 中性列表项不再携带牛熊类型；harness 保留创建时类型以模拟 adapter 按 request.types 过滤。 */
const warrantTypesByItem = new WeakMap<object, 'BULL' | 'BEAR'>();

function createWarrantInfo(
  params: Readonly<{
    symbol: string;
    warrantType: 'BULL' | 'BEAR';
    apiDistanceRatio: string;
    turnover: string;
    callPrice: string;
  }>,
): Awaited<ReturnType<MarketQuoteContext['warrantList']>>[number] {
  const item = {
    symbol: params.symbol,
    toCallPrice: params.apiDistanceRatio,
    turnover: params.turnover,
    callPrice: params.callPrice,
    status: 'NORMAL' as const,
  };
  warrantTypesByItem.set(item, params.warrantType);
  return item;
}

/** 中性查询端口，只记录实际 finder request，不制造 SDK monetary DTO。 */
function createWarrantQuoteHarness() {
  const lists = new Map<string, Awaited<ReturnType<MarketQuoteContext['warrantList']>>>();
  const calls: Parameters<MarketQuoteContext['warrantList']>[0][] = [];
  const port: MarketQuoteContext = createQuoteContextDouble({
    warrantList: async (request) => {
      calls.push(request);
      return (lists.get(request.symbol) ?? []).filter((item) => {
        const warrantType = warrantTypesByItem.get(item);
        return warrantType !== undefined && request.types.includes(warrantType);
      });
    },
  });
  return {
    port,
    seedWarrantList: (
      symbol: string,
      items: Awaited<ReturnType<MarketQuoteContext['warrantList']>>,
    ) => {
      lists.set(symbol, items);
    },
    getCalls: (_method: 'warrantList') => calls,
  };
}

function createAutoSearchMonitor() {
  return createMonitorConfigDouble({
    monitorSymbol: 'HSI.HK',
    autoSearchConfig: {
      autoSearchEnabled: true,
      autoSearchMinDistancePctBull: '0.35',
      autoSearchMinDistancePctBear: '-0.35',
      autoSearchMinTurnoverPerMinuteBull: '100000',
      autoSearchMinTurnoverPerMinuteBear: '100000',
      autoSearchExpiryMinMonths: 3,
      autoSearchOpenDelayMinutes: 5,
      switchIntervalMinutes: 0,
      switchDistanceRangeBull: { min: '0.2', max: '1.5' },
      switchDistanceRangeBear: { min: '-1.5', max: '-0.2' },
    },
  });
}

function createEmptySymbolRegistry() {
  return createSymbolRegistryDouble({
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
  });
}

function seedAutoSearchCandidates(quoteCtx: ReturnType<typeof createWarrantQuoteHarness>): void {
  quoteCtx.seedWarrantList('HSI.HK', [
    createWarrantInfo({
      symbol: 'AUTO_BULL.HK',
      warrantType: 'BULL',
      apiDistanceRatio: '0.0055',
      turnover: '30000000',
      callPrice: '20500',
    }),
    createWarrantInfo({
      symbol: 'AUTO_BEAR.HK',
      warrantType: 'BEAR',
      apiDistanceRatio: '-0.0055',
      turnover: '30000000',
      callPrice: '19500',
    }),
  ]);
}

describe('recovery seat preparation business flow', () => {
  it('restores configured symbols on startup when auto-search is disabled', async () => {
    const startupTime = '2026-02-16T01:00:00.000Z';
    const monitor = createMonitorConfigDouble({
      longSymbol: 'BULL.HK',
      shortSymbol: 'BEAR.HK',
      autoSearchConfig: {
        autoSearchEnabled: false,
        autoSearchMinDistancePctBull: null,
        autoSearchMinDistancePctBear: null,
        autoSearchMinTurnoverPerMinuteBull: null,
        autoSearchMinTurnoverPerMinuteBear: null,
        autoSearchExpiryMinMonths: 3,
        autoSearchOpenDelayMinutes: 0,
        switchIntervalMinutes: 0,
        switchDistanceRangeBull: null,
        switchDistanceRangeBear: null,
      },
    });

    const symbolRegistry = createSymbolRegistryDouble({
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
    });

    const quoteCtx = createWarrantQuoteHarness();

    let quoteContextCalls = 0;
    await prepareSeatsForRuntime({
      tradingConfig: createTradingConfig({ monitor }),
      symbolRegistry,
      positions: [],
      orders: [],
      startupSeatSearch: createStartupSeatSearch({
        monitorSymbol: monitor.monitorSymbol,
        symbolRegistry,
        candidateSearch: createWarrantCandidateSearch({
          monitorSymbol: monitor.monitorSymbol,
          autoSearchConfig: monitor.autoSearchConfig,
          marketDataClient: createMarketDataClientDouble({
            getQuoteContext: async () => {
              quoteContextCalls += 1;
              return quoteCtx.port;
            },
          }),
          logger: createLoggerStub(),
          getTradingMinutesSinceOpen: () => 5,
        }),
        logger: createLoggerStub(),
      }),
      now: () => new Date(startupTime),
      canContinue: () => true,
      resolveCanAutoSearchNow: () => true,
    });

    expect(quoteCtx.getCalls('warrantList')).toHaveLength(0);
    expect(quoteContextCalls).toBe(0);
    const longSeat = symbolRegistry.getSeatState('LONG');
    const shortSeat = symbolRegistry.getSeatState('SHORT');
    expect(longSeat.lastSeatActivatedAt).toBeNull();
    expect(shortSeat.lastSeatActivatedAt).toBeNull();
  });

  it('tracks failure counts when auto-search cannot find candidates on startup', async () => {
    const monitor = createMonitorConfigDouble({
      autoSearchConfig: {
        autoSearchEnabled: true,
        autoSearchMinDistancePctBull: '0.35',
        autoSearchMinDistancePctBear: '-0.35',
        autoSearchMinTurnoverPerMinuteBull: '100000',
        autoSearchMinTurnoverPerMinuteBear: '100000',
        autoSearchExpiryMinMonths: 3,
        autoSearchOpenDelayMinutes: 0,
        switchIntervalMinutes: 0,
        switchDistanceRangeBull: { min: '0.2', max: '1.5' },
        switchDistanceRangeBear: { min: '-1.5', max: '-0.2' },
      },
      orderOwnershipMapping: ['A'],
    });

    const symbolRegistry = createSymbolRegistryDouble({
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
    });

    const quoteCtx = createWarrantQuoteHarness();

    await prepareSeatsForRuntime({
      tradingConfig: createTradingConfig({ monitor }),
      symbolRegistry,
      positions: [],
      orders: [],
      startupSeatSearch: createStartupSeatSearch({
        monitorSymbol: monitor.monitorSymbol,
        symbolRegistry,
        candidateSearch: createWarrantCandidateSearch({
          monitorSymbol: monitor.monitorSymbol,
          autoSearchConfig: monitor.autoSearchConfig,
          marketDataClient: createMarketDataClientDouble({
            getQuoteContext: async () => quoteCtx.port,
          }),
          logger: createLoggerStub(),
          getTradingMinutesSinceOpen: () => 10,
        }),
        logger: createLoggerStub(),
      }),
      now: () => new Date('2026-02-16T01:00:00.000Z'),
      canContinue: () => true,
      resolveCanAutoSearchNow: () => true,
    });

    const longSeat = symbolRegistry.getSeatState('LONG');
    const shortSeat = symbolRegistry.getSeatState('SHORT');
    expect(longSeat.status).toBe('EMPTY');
    expect(longSeat.searchFailCountToday).toBe(1);
    expect(shortSeat.status).toBe('EMPTY');
    expect(shortSeat.searchFailCountToday).toBe(1);
  });

  it('skips startup recovery search for frozen empty seats', async () => {
    const monitor = createAutoSearchMonitor();
    const symbolRegistry = createSymbolRegistryDouble({
      longSeat: {
        symbol: null,
        status: 'EMPTY',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 2,
        frozenTradingDayKey: '2026-02-15',
      },
      shortSeat: {
        symbol: null,
        status: 'EMPTY',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 1,
        frozenTradingDayKey: '2026-02-15',
      },
    });

    await prepareSeatsForRuntime({
      tradingConfig: createTradingConfig({ monitor }),
      symbolRegistry,
      positions: [],
      orders: [],
      startupSeatSearch: createStartupSeatSearch({
        monitorSymbol: monitor.monitorSymbol,
        symbolRegistry,
        candidateSearch: createWarrantCandidateSearch({
          monitorSymbol: monitor.monitorSymbol,
          autoSearchConfig: monitor.autoSearchConfig,
          marketDataClient: createMarketDataClientDouble({
            getQuoteContext: async () => {
              throw new Error('should not request quote context');
            },
          }),
          logger: createLoggerStub(),
          getTradingMinutesSinceOpen: () => 5,
        }),
        logger: createLoggerStub(),
      }),
      now: () => new Date('2026-02-16T01:35:00.000Z'),
      canContinue: () => true,
      resolveCanAutoSearchNow: () => true,
    });

    expect(symbolRegistry.getSeatState('LONG').frozenTradingDayKey).toBe('2026-02-15');

    expect(symbolRegistry.getSeatState('SHORT').frozenTradingDayKey).toBe('2026-02-15');
  });

  it('rethrows ExternalApiRequestError during startup recovery search and preserves prior failure state', async () => {
    const monitor = createAutoSearchMonitor();
    const symbolRegistry = createSymbolRegistryDouble({
      longSeat: {
        symbol: null,
        status: 'EMPTY',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 2,
        frozenTradingDayKey: '2026-02-15',
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
    });
    let error: unknown = null;
    try {
      await prepareSeatsForRuntime({
        tradingConfig: createTradingConfig({ monitor }),
        symbolRegistry,
        positions: [],
        orders: [],
        startupSeatSearch: createStartupSeatSearch({
          monitorSymbol: monitor.monitorSymbol,
          symbolRegistry,
          candidateSearch: createWarrantCandidateSearch({
            monitorSymbol: monitor.monitorSymbol,
            autoSearchConfig: monitor.autoSearchConfig,
            marketDataClient: createMarketDataClientDouble({
              getQuoteContext: async () => ({
                warrantQuote: async () => [],
                warrantList: async () => {
                  throw await createExternalApiRequestError({
                    operation: 'QuoteContext.warrantList',
                    attempts: 3,
                    cause: new Error('network'),
                  });
                },
              }),
            }),
            logger: createLoggerStub(),
            getTradingMinutesSinceOpen: () => 5,
          }),
          logger: createLoggerStub(),
        }),
        now: () => new Date('2026-02-16T01:35:00.000Z'),
        canContinue: () => true,
        resolveCanAutoSearchNow: () => true,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({
      name: 'ExternalApiRequestError',
      operation: 'QuoteContext.warrantList',
    });

    const longSeat = symbolRegistry.getSeatState('LONG');
    expect(longSeat.status).toBe('EMPTY');
    expect(longSeat.searchFailCountToday).toBe(2);
    expect(longSeat.frozenTradingDayKey).toBe('2026-02-15');
  });

  it('rethrows TypeError during startup recovery search and preserves prior failure state', async () => {
    const monitor = createAutoSearchMonitor();
    const symbolRegistry = createSymbolRegistryDouble({
      longSeat: {
        symbol: null,
        status: 'EMPTY',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 1,
        frozenTradingDayKey: '2026-02-14',
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
    });

    let error: unknown = null;
    try {
      await prepareSeatsForRuntime({
        tradingConfig: createTradingConfig({ monitor }),
        symbolRegistry,
        positions: [],
        orders: [],
        startupSeatSearch: createStartupSeatSearch({
          monitorSymbol: monitor.monitorSymbol,
          symbolRegistry,
          candidateSearch: createWarrantCandidateSearch({
            monitorSymbol: monitor.monitorSymbol,
            autoSearchConfig: monitor.autoSearchConfig,
            marketDataClient: createMarketDataClientDouble({
              getQuoteContext: async () => ({
                warrantQuote: async () => [],
                warrantList: async () => {
                  throw new TypeError('warrant payload contract broken');
                },
              }),
            }),
            logger: createLoggerStub(),
            getTradingMinutesSinceOpen: () => 5,
          }),
          logger: createLoggerStub(),
        }),
        now: () => new Date('2026-02-16T01:35:00.000Z'),
        canContinue: () => true,
        resolveCanAutoSearchNow: () => true,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(TypeError);
    expect(error).toMatchObject({ message: 'warrant payload contract broken' });

    const longSeat = symbolRegistry.getSeatState('LONG');
    expect(longSeat.status).toBe('EMPTY');
    expect(longSeat.searchFailCountToday).toBe(1);
    expect(longSeat.frozenTradingDayKey).toBe('2026-02-14');
  });

  it('freezes seat when startup auto-search misses candidate at daily failure threshold', async () => {
    const monitor = createAutoSearchMonitor();
    const symbolRegistry = createSymbolRegistryDouble({
      longSeat: {
        symbol: null,
        status: 'EMPTY',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: AUTO_SYMBOL_MAX_SEARCH_FAILURES_PER_DAY - 1,
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
    });
    const currentTime = new Date('2026-02-16T01:35:00.000Z');
    await prepareSeatsForRuntime({
      tradingConfig: createTradingConfig({ monitor }),
      symbolRegistry,
      positions: [],
      orders: [],
      startupSeatSearch: createStartupSeatSearch({
        monitorSymbol: monitor.monitorSymbol,
        symbolRegistry,
        candidateSearch: createWarrantCandidateSearch({
          monitorSymbol: monitor.monitorSymbol,
          autoSearchConfig: monitor.autoSearchConfig,
          marketDataClient: createMarketDataClientDouble({
            getQuoteContext: async () => createWarrantQuoteHarness().port,
          }),
          logger: createLoggerStub(),
          getTradingMinutesSinceOpen: () => 5,
        }),
        logger: createLoggerStub(),
      }),
      now: () => currentTime,
      canContinue: () => true,
      resolveCanAutoSearchNow: () => true,
    });

    const longSeat = symbolRegistry.getSeatState('LONG');
    expect(longSeat.status).toBe('EMPTY');
    expect(longSeat.searchFailCountToday).toBe(AUTO_SYMBOL_MAX_SEARCH_FAILURES_PER_DAY);
    expect(longSeat.frozenTradingDayKey).toBe(getHKDateKey(currentTime));
  });

  it('skips startup search during morning open protection window', async () => {
    const monitor = createMonitorConfigDouble({
      autoSearchConfig: {
        autoSearchEnabled: true,
        autoSearchMinDistancePctBull: '0.35',
        autoSearchMinDistancePctBear: '-0.35',
        autoSearchMinTurnoverPerMinuteBull: '100000',
        autoSearchMinTurnoverPerMinuteBear: '100000',
        autoSearchExpiryMinMonths: 3,
        autoSearchOpenDelayMinutes: 5,
        switchIntervalMinutes: 0,
        switchDistanceRangeBull: { min: '0.2', max: '1.5' },
        switchDistanceRangeBear: { min: '-1.5', max: '-0.2' },
      },
    });

    const symbolRegistry = createSymbolRegistryDouble({
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
    });

    const quoteCtx = createWarrantQuoteHarness();
    quoteCtx.seedWarrantList('HSI.HK', [
      createWarrantInfo({
        symbol: 'AUTO_BULL.HK',
        warrantType: 'BULL',
        apiDistanceRatio: '0.0055',
        turnover: '30000000',
        callPrice: '20500',
      }),
      createWarrantInfo({
        symbol: 'AUTO_BEAR.HK',
        warrantType: 'BEAR',
        apiDistanceRatio: '-0.0055',
        turnover: '30000000',
        callPrice: '19500',
      }),
    ]);

    await prepareSeatsForRuntime({
      tradingConfig: createTradingConfig({ monitor }),
      symbolRegistry,
      positions: [],
      orders: [],
      startupSeatSearch: createStartupSeatSearch({
        monitorSymbol: monitor.monitorSymbol,
        symbolRegistry,
        candidateSearch: createWarrantCandidateSearch({
          monitorSymbol: monitor.monitorSymbol,
          autoSearchConfig: monitor.autoSearchConfig,
          marketDataClient: createMarketDataClientDouble({
            getQuoteContext: async () => quoteCtx.port,
          }),
          logger: createLoggerStub(),
          getTradingMinutesSinceOpen: () => 1,
        }),
        logger: createLoggerStub(),
      }),
      now: () => new Date('2026-02-16T01:01:00.000Z'),
      canContinue: () => true,
      resolveCanAutoSearchNow: () => false,
    });

    expect(quoteCtx.getCalls('warrantList')).toHaveLength(0);
  });

  it.each([
    ['before continuous session starts', '2026-02-16T01:29:00.000Z'],
    ['during morning open delay', '2026-02-16T01:31:00.000Z'],
    ['when trading day info is unknown', '2026-02-16T01:35:00.000Z'],
    ['on non-trading day', '2026-02-16T01:35:00.000Z'],
  ])('skips startup auto-search %s', async (_caseName, currentTime) => {
    const monitor = createAutoSearchMonitor();
    const symbolRegistry = createEmptySymbolRegistry();
    const quoteCtx = createWarrantQuoteHarness();
    seedAutoSearchCandidates(quoteCtx);

    await prepareSeatsForRuntime({
      tradingConfig: createTradingConfig({ monitor }),
      symbolRegistry,
      positions: [],
      orders: [],
      startupSeatSearch: createStartupSeatSearch({
        monitorSymbol: monitor.monitorSymbol,
        symbolRegistry,
        candidateSearch: createWarrantCandidateSearch({
          monitorSymbol: monitor.monitorSymbol,
          autoSearchConfig: monitor.autoSearchConfig,
          marketDataClient: createMarketDataClientDouble({
            getQuoteContext: async () => quoteCtx.port,
          }),
          logger: createLoggerStub(),
          getTradingMinutesSinceOpen: () => 0,
        }),
        logger: createLoggerStub(),
      }),
      now: () => new Date(currentTime),
      canContinue: () => true,
      resolveCanAutoSearchNow: () => false,
    });

    expect(quoteCtx.getCalls('warrantList')).toHaveLength(0);
    expect(symbolRegistry.getSeatState('LONG').status).toBe('EMPTY');
    expect(symbolRegistry.getSeatState('SHORT').status).toBe('EMPTY');
  });

  it('runs startup auto-search after morning open delay ends', async () => {
    const monitor = createAutoSearchMonitor();
    const symbolRegistry = createEmptySymbolRegistry();
    const quoteCtx = createWarrantQuoteHarness();
    seedAutoSearchCandidates(quoteCtx);

    await prepareSeatsForRuntime({
      tradingConfig: createTradingConfig({ monitor }),
      symbolRegistry,
      positions: [],
      orders: [],
      startupSeatSearch: createStartupSeatSearch({
        monitorSymbol: monitor.monitorSymbol,
        symbolRegistry,
        candidateSearch: createWarrantCandidateSearch({
          monitorSymbol: monitor.monitorSymbol,
          autoSearchConfig: monitor.autoSearchConfig,
          marketDataClient: createMarketDataClientDouble({
            getQuoteContext: async () => quoteCtx.port,
          }),
          logger: createLoggerStub(),
          getTradingMinutesSinceOpen: () => 5,
        }),
        logger: createLoggerStub(),
      }),
      now: () => new Date('2026-02-16T01:35:00.000Z'),
      canContinue: () => true,
      resolveCanAutoSearchNow: () => true,
    });

    const longSeat = symbolRegistry.getSeatState('LONG');
    const shortSeat = symbolRegistry.getSeatState('SHORT');
    expect(quoteCtx.getCalls('warrantList')).toHaveLength(2);
    expect(longSeat.status).toBe('ACTIVATING');
    expect(longSeat.symbol).toBe('AUTO_BULL.HK');
    expect(shortSeat.status).toBe('ACTIVATING');
    expect(shortSeat.symbol).toBe('AUTO_BEAR.HK');
  });

  it('runs startup auto-search in afternoon continuous session', async () => {
    const monitor = createAutoSearchMonitor();
    const symbolRegistry = createEmptySymbolRegistry();
    const quoteCtx = createWarrantQuoteHarness();
    seedAutoSearchCandidates(quoteCtx);

    await prepareSeatsForRuntime({
      tradingConfig: createTradingConfig({ monitor }),
      symbolRegistry,
      positions: [],
      orders: [],
      startupSeatSearch: createStartupSeatSearch({
        monitorSymbol: monitor.monitorSymbol,
        symbolRegistry,
        candidateSearch: createWarrantCandidateSearch({
          monitorSymbol: monitor.monitorSymbol,
          autoSearchConfig: monitor.autoSearchConfig,
          marketDataClient: createMarketDataClientDouble({
            getQuoteContext: async () => quoteCtx.port,
          }),
          logger: createLoggerStub(),
          getTradingMinutesSinceOpen: () => 150,
        }),
        logger: createLoggerStub(),
      }),
      now: () => new Date('2026-02-16T05:00:00.000Z'),
      canContinue: () => true,
      resolveCanAutoSearchNow: () => true,
    });

    const longSeat = symbolRegistry.getSeatState('LONG');
    const shortSeat = symbolRegistry.getSeatState('SHORT');
    expect(quoteCtx.getCalls('warrantList')).toHaveLength(2);
    expect(longSeat.status).toBe('ACTIVATING');
    expect(shortSeat.status).toBe('ACTIVATING');
  });

  it('binds degraded bear candidate for SHORT seat during startup auto-search and keeps it ACTIVATING', async () => {
    const monitor = createMonitorConfigDouble({
      autoSearchConfig: {
        autoSearchEnabled: true,
        autoSearchMinDistancePctBull: '0.35',
        autoSearchMinDistancePctBear: '-0.35',
        autoSearchMinTurnoverPerMinuteBull: '100000',
        autoSearchMinTurnoverPerMinuteBear: '100000',
        autoSearchExpiryMinMonths: 3,
        autoSearchOpenDelayMinutes: 0,
        switchIntervalMinutes: 0,
        switchDistanceRangeBull: { min: '0.2', max: '1.5' },
        switchDistanceRangeBear: { min: '-1.5', max: '-0.2' },
      },
      orderOwnershipMapping: ['HSI'],
    });

    const symbolRegistry = createSymbolRegistryDouble({
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
    });

    const quoteCtx = createWarrantQuoteHarness();
    quoteCtx.seedWarrantList('HSI.HK', [
      createWarrantInfo({
        symbol: 'AUTO_BEAR_1.HK',
        warrantType: 'BEAR',
        apiDistanceRatio: '-0.0022',
        turnover: '1500000',
        callPrice: '19300',
      }),
      createWarrantInfo({
        symbol: 'AUTO_BEAR_BEST.HK',
        warrantType: 'BEAR',
        apiDistanceRatio: '-0.003499',
        turnover: '1800000',
        callPrice: '19500',
      }),
    ]);

    await prepareSeatsForRuntime({
      tradingConfig: createTradingConfig({ monitor }),
      symbolRegistry,
      positions: [],
      orders: [],
      startupSeatSearch: createStartupSeatSearch({
        monitorSymbol: monitor.monitorSymbol,
        symbolRegistry,
        candidateSearch: createWarrantCandidateSearch({
          monitorSymbol: monitor.monitorSymbol,
          autoSearchConfig: monitor.autoSearchConfig,
          marketDataClient: createMarketDataClientDouble({
            getQuoteContext: async () => quoteCtx.port,
          }),
          logger: createLoggerStub(),
          getTradingMinutesSinceOpen: () => 10,
        }),
        logger: createLoggerStub(),
      }),
      now: () => new Date('2026-02-16T01:00:00.000Z'),
      canContinue: () => true,
      resolveCanAutoSearchNow: () => true,
    });

    const shortSeat = symbolRegistry.getSeatState('SHORT');
    expect(shortSeat.status).toBe('ACTIVATING');
    expect(shortSeat.symbol).toBe('AUTO_BEAR_BEST.HK');
    expect(shortSeat.callPrice).toBe('19500');
  });
});
