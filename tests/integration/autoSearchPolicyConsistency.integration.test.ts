import {
  createMarketDataClientDouble,
  createMonitorConfigDouble,
  createOrderRecorderDouble,
  createQuoteContextDouble,
  createQuoteDouble,
  createRiskCheckerDouble,
  createTradeRuntimeDouble,
} from '../helpers/testDoubles.js';

/**
 * 自动寻标三入口一致性集成测试。
 * 使用真实候选用例、启动补席、运行期空席位 owner 与距离换标 owner，验证共享筛选但失败政策不合并。
 */
import { describe, expect, it } from 'bun:test';
import { rejects } from 'node:assert/strict';
import { createTradingConfig } from '../../mock/factories/configFactory.js';
import { createWarrantCandidateSearch } from '../../src/application/autoSearch/candidateSearch.js';
import { createAutoSearch } from '../../src/application/autoSearch/index.js';
import { createStartupSeatSearch } from '../../src/application/autoSearch/startupSeatSearch.js';
import { createSeatSwitchWorkflow } from '../../src/application/seatSwitch/index.js';
import { createSymbolRegistry } from '../../src/domain/seat/symbolRegistry.js';
import { prepareSeatsForRuntime } from '../../src/application/tradingDayRebuild/seatPreparation.js';
import type { MarketWarrantListItem } from '../../src/types/marketPorts.js';
import type { MonitorConfig } from '../../src/types/config.js';
import type { SymbolRegistry } from '../../src/types/seat.js';
import type { WarrantCandidateSearch } from '../../src/application/autoSearch/types.js';
import { createExternalApiRequestError } from '../helpers/createExternalApiRequestError.js';

import {
  captureSearchSeatAuthorization,
  captureSwitchSeatAuthorization,
  createLoggerStub,
  getDefaultAutoSearchConfig,
} from '../helpers/seatTestUtils.js';

const currentTime = new Date('2026-02-16T02:00:00.000Z');

function createCandidateSearch(
  config: MonitorConfig,
  query: () => Promise<ReadonlyArray<MarketWarrantListItem>>,
) {
  const marketDataClient = createMarketDataClientDouble({
    getQuoteContext: async () => createQuoteContextDouble({ warrantList: query }),
    getQuotes: async (symbols) =>
      new Map([...symbols].map((symbol) => [symbol, createQuoteDouble(symbol, '0.07', 10000)])),
  });
  const candidateSearch = createWarrantCandidateSearch({
    monitorSymbol: config.monitorSymbol,
    autoSearchConfig: config.autoSearchConfig,
    marketDataClient,
    logger: createLoggerStub(),
    getTradingMinutesSinceOpen: () => 10,
  });
  return { candidateSearch, marketDataClient };
}

function setEmpty(registry: SymbolRegistry, direction: 'LONG' | 'SHORT', failures = 0): void {
  registry.updateSeatState(direction, {
    symbol: null,
    status: 'EMPTY',
    lastSwitchAt: null,
    lastSearchAt: null,
    lastSeatActivatedAt: null,
    callPrice: null,
    searchFailCountToday: failures,
    frozenTradingDayKey: null,
  });
}

function createSwitch(
  config: MonitorConfig,
  registry: SymbolRegistry,
  candidateSearch: WarrantCandidateSearch,
) {
  const market = createMarketDataClientDouble({
    getQuotes: async (symbols) =>
      new Map([...symbols].map((symbol) => [symbol, createQuoteDouble(symbol, '0.07', 10000)])),
  });
  return createSeatSwitchWorkflow({
    readSwitchPositions: async () => [],
    monitorConfig: config,
    symbolRegistry: registry,
    marketDataClient: market,
    ...createTradeRuntimeDouble(),
    orderRecorder: createOrderRecorderDouble(),
    riskChecker: createRiskCheckerDouble({
      getWarrantDistanceInfo: (isLongSymbol) => ({
        distanceNumerator: isLongSymbol ? '0.1' : '-0.1',
        distanceDenominator: '100',
      }),
    }),
    candidateSearch,
    logger: createLoggerStub(),
    getTradingCalendarSnapshot: () => new Map(),
    clock: { now: () => currentTime },
  });
}

async function runStartup(
  config: MonitorConfig,
  registry: SymbolRegistry,
  candidateSearch: WarrantCandidateSearch,
): Promise<void> {
  await prepareSeatsForRuntime({
    tradingConfig: createTradingConfig({ monitor: config }),
    symbolRegistry: registry,
    positions: [],
    orders: [],
    startupSeatSearch: createStartupSeatSearch({
      monitorSymbol: config.monitorSymbol,
      symbolRegistry: registry,
      candidateSearch,
      logger: createLoggerStub(),
    }),
    canContinue: () => true,
    now: () => currentTime,
    resolveCanAutoSearchNow: () => true,
  });
}

function item(symbol: string, ratio: string, turnover: string): MarketWarrantListItem {
  return {
    symbol,
    callPrice: '20000.1234567890123456789',
    toCallPrice: ratio,
    turnover,
    status: 'NORMAL',
  };
}

describe('three-entry shared candidate policy', () => {
  it.each(['LONG', 'SHORT'] as const)(
    'uses the same exact degraded %s candidate through startup, runtime and distance presearch',
    async (direction) => {
      const config = createMonitorConfigDouble({ autoSearchConfig: getDefaultAutoSearchConfig() });
      const near = direction === 'LONG' ? '0.003499999999999999999' : '-0.003499999999999999999';
      const far = direction === 'LONG' ? '0.0022' : '-0.0022';
      const rows = [
        item('LOWER.HK', far, '3000000'),
        item('TIE.HK', near, '2000000.000000000000000001'),
        item('BEST.HK', near, '2000000.000000000000000002'),
      ];
      let queries = 0;
      const { candidateSearch } = createCandidateSearch(config, async () => {
        queries += 1;
        return rows;
      });
      const direct = await candidateSearch.findCandidate({
        direction,
        currentTime,
        canContinue: () => true,
      });
      expect(direct).toEqual({
        symbol: 'BEST.HK',
        callPrice: '20000.1234567890123456789',
      });

      const startup = createSymbolRegistry(config);
      await runStartup(config, startup, candidateSearch);
      expect(startup.getSeatState(direction)).toMatchObject({
        status: 'ACTIVATING',
        symbol: 'BEST.HK',
        callPrice: direct?.callPrice,
      });

      const runtime = createSymbolRegistry(config);
      const autoSearch = createAutoSearch({
        monitorSymbol: config.monitorSymbol,
        autoSearchConfig: config.autoSearchConfig,
        symbolRegistry: runtime,
        candidateSearch,
        logger: createLoggerStub(),
      });
      await autoSearch.maybeSearchOnEvent({
        direction,
        currentTime,
        canContinue: captureSearchSeatAuthorization(runtime, direction),
      });

      expect(runtime.getSeatState(direction)).toMatchObject({
        status: 'ACTIVATING',
        symbol: 'BEST.HK',
        callPrice: direct?.callPrice,
      });

      const switching = createSymbolRegistry(config);
      switching.updateSeatState(direction, {
        symbol: direction === 'LONG' ? 'OLD_BULL.HK' : 'OLD_BEAR.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: currentTime.getTime() - 1,
        callPrice: '20000',
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      });
      const seatSwitch = createSwitch(config, switching, candidateSearch);
      const start = await seatSwitch.startSwitchOnDistance({
        direction,
        monitorPrice: '20000',
        positions: [],
        canContinue: captureSwitchSeatAuthorization(switching, direction),
      });
      expect(start.started).toBeTrue();
      await seatSwitch.advancePendingSwitch({
        direction,
        positions: [],
        canContinue: captureSwitchSeatAuthorization(switching, direction),
      });

      expect(switching.getSeatState(direction)).toMatchObject({
        status: 'ACTIVATING',
        symbol: 'BEST.HK',
        callPrice: direct?.callPrice,
      });
      expect(queries).toBeGreaterThanOrEqual(4);
    },
  );

  it('keeps primary-layer selection independent of the safe/danger trigger side', async () => {
    const config = createMonitorConfigDouble({ autoSearchConfig: getDefaultAutoSearchConfig() });
    const { candidateSearch } = createCandidateSearch(config, async () => [
      item('PRIMARY.HK', '0.003500000000000000001', '2000000'),
      item('DEGRADED.HK', '0.003499999999999999999', '9000000'),
    ]);
    const before = await candidateSearch.findCandidate({
      direction: 'LONG',
      currentTime,
      canContinue: () => true,
    });
    expect(before?.symbol).toBe('PRIMARY.HK');
    expect(before).toEqual({
      symbol: 'PRIMARY.HK',
      callPrice: '20000.1234567890123456789',
    });
    expect(candidateSearch.resolveDistanceRange('LONG')).toEqual({ min: '0.2', max: '1.5' });
  });
});

describe('entry-specific search failure owners', () => {
  it.each(['external', 'internal'] as const)(
    'does not flatten %s failure policy between runtime, startup and presearch',
    async (kind) => {
      const config = createMonitorConfigDouble({ autoSearchConfig: getDefaultAutoSearchConfig() });
      const failure =
        kind === 'internal'
          ? new TypeError('neutral warrant contract')
          : await createExternalApiRequestError({
              operation: 'QuoteContext.warrantList',
              attempts: 3,
              cause: new Error('network unavailable'),
            });
      const { candidateSearch } = createCandidateSearch(config, async () => {
        throw failure;
      });

      const runtime = createSymbolRegistry(config);
      setEmpty(runtime, 'LONG', 2);
      const autoSearch = createAutoSearch({
        monitorSymbol: config.monitorSymbol,
        autoSearchConfig: config.autoSearchConfig,
        symbolRegistry: runtime,
        candidateSearch,
        logger: createLoggerStub(),
      });
      const runtimeSearch = autoSearch.maybeSearchOnEvent({
        direction: 'LONG',
        currentTime,
        canContinue: captureSearchSeatAuthorization(runtime, 'LONG'),
      });
      await (kind === 'internal'
        ? rejects(runtimeSearch, (error: unknown) => error === failure)
        : runtimeSearch);

      expect(runtime.getSeatState('LONG')).toMatchObject({
        status: 'EMPTY',
        searchFailCountToday: 3,
        frozenTradingDayKey: '2026-02-16',
      });

      const startup = createSymbolRegistry(config);
      setEmpty(startup, 'LONG', 2);
      await rejects(
        runStartup(config, startup, candidateSearch),
        (error: unknown) => error === failure,
      );

      expect(startup.getSeatState('LONG')).toMatchObject({
        status: 'EMPTY',
        searchFailCountToday: 2,
        frozenTradingDayKey: null,
      });

      const presearch = createSymbolRegistry(config);
      presearch.updateSeatState('LONG', {
        symbol: 'OLD_BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: currentTime.getTime() - 1,
        callPrice: '20000',
        searchFailCountToday: 2,
        frozenTradingDayKey: null,
      });
      const seatSwitch = createSwitch(config, presearch, candidateSearch);
      await rejects(
        seatSwitch.startSwitchOnDistance({
          direction: 'LONG',
          monitorPrice: '20000',
          positions: [],
          canContinue: captureSwitchSeatAuthorization(presearch, 'LONG'),
        }),
        (error: unknown) => error === failure,
      );

      expect(presearch.getSeatState('LONG')).toMatchObject({
        status: 'ACTIVE',
        symbol: 'OLD_BULL.HK',
        searchFailCountToday: 2,
        frozenTradingDayKey: null,
      });
    },
  );

  it('counts completed startup no-candidate results, but skips inadmissible startup without a failure', async () => {
    const config = createMonitorConfigDouble({ autoSearchConfig: getDefaultAutoSearchConfig() });
    let queries = 0;
    const { candidateSearch } = createCandidateSearch(config, async () => {
      queries += 1;
      return [];
    });
    const registry = createSymbolRegistry(config);
    setEmpty(registry, 'LONG', 2);
    await runStartup(config, registry, candidateSearch);
    expect(registry.getSeatState('LONG')).toMatchObject({
      status: 'EMPTY',
      searchFailCountToday: 3,
      frozenTradingDayKey: '2026-02-16',
    });
    const skipped = createSymbolRegistry(config);
    await prepareSeatsForRuntime({
      tradingConfig: createTradingConfig({ monitor: config }),
      symbolRegistry: skipped,
      positions: [],
      orders: [],
      startupSeatSearch: createStartupSeatSearch({
        monitorSymbol: config.monitorSymbol,
        symbolRegistry: skipped,
        candidateSearch,
        logger: createLoggerStub(),
      }),
      canContinue: () => true,
      now: () => currentTime,
      resolveCanAutoSearchNow: () => false,
    });
    expect(skipped.getSeatState('LONG').searchFailCountToday).toBe(0);
    expect(queries).toBe(2);
  });
});
