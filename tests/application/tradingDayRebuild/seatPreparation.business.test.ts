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
import { rejects } from 'node:assert/strict';
import type { MarketQuoteContext, SecurityTradingStatus } from '../../../src/types/marketPorts.js';
import type { PrepareSeatsForRuntimeDeps } from '../../../src/application/tradingDayRebuild/types.js';
import type { OrderFact } from '../../../src/types/trade.js';

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

/** 带真实归属信息的最近完全成交订单，候选准入不改变其买卖方向口径。 */
function createRecoveryOrder(
  symbol: string,
  direction: 'LONG' | 'SHORT',
  updatedAt = new Date('2026-02-16T01:00:00.000Z'),
): OrderFact {
  return {
    orderId: `${symbol}-${updatedAt.getTime()}`,
    symbol,
    stockName: direction === 'LONG' ? 'HSI RC' : 'HSI RP',
    executionSide: 'BUY',
    executionStatus: 'FILLED',
    executionPhase: 'TERMINAL',
    status: 'FILLED',
    orderType: 'ELO',
    price: '1',
    quantity: 100,
    executedPrice: '1',
    executedQuantity: 100,
    executedAmount: '100',
    executionTimeMs: updatedAt.getTime(),
    updatedAtMs: updatedAt.getTime(),
    submittedAt: updatedAt,
    updatedAt,
  };
}

/** 原候选、真实启动寻标与可控状态端口，直接见证发布与寻标边界。 */
function createStatusAdmissionHarness(overrides: Partial<PrepareSeatsForRuntimeDeps> = {}) {
  const monitor = createMonitorConfigDouble({
    ...createAutoSearchMonitor(),
    orderOwnershipMapping: ['HSI'],
  });
  const registry = createEmptySymbolRegistry();
  const quoteContext = createWarrantQuoteHarness();
  const warnings: unknown[][] = [];
  const statusRequests: ReadonlyArray<string>[] = [];
  const publicationDirections: string[] = [];
  const symbolRegistry = {
    ...registry,
    updateSeatState: (...args: Parameters<typeof registry.updateSeatState>) => {
      publicationDirections.push(args[0]);
      registry.updateSeatState(...args);
    },
  };
  const marketDataClient = createMarketDataClientDouble({
    getQuoteContext: async () => quoteContext.port,
    getSecurityTradingStatuses: async (symbols) => {
      statusRequests.push(symbols);
      return new Map(symbols.map((symbol) => [symbol, 'NORMAL'] as const));
    },
  });
  const deps: PrepareSeatsForRuntimeDeps = {
    tradingConfig: createTradingConfig({ monitor }),
    symbolRegistry,
    marketDataClient,
    logger: { warn: (...args) => { warnings.push(args); } },
    positions: ['OLD_LONG.HK', 'OLD_SHORT.HK'].map((symbol) => ({
      accountChannel: 'lb',
      symbol,
      symbolName: symbol,
      quantity: 100,
      availableQuantity: 0,
      currency: 'HKD',
      costPrice: '1',
    })),
    orders: [
      createRecoveryOrder('OLD_LONG.HK', 'LONG'),
      createRecoveryOrder('OLD_SHORT.HK', 'SHORT'),
    ],
    startupSeatSearch: createStartupSeatSearch({
      monitorSymbol: monitor.monitorSymbol,
      symbolRegistry,
      candidateSearch: createWarrantCandidateSearch({
        monitorSymbol: monitor.monitorSymbol,
        autoSearchConfig: monitor.autoSearchConfig,
        marketDataClient,
        logger: createLoggerStub(),
        getTradingMinutesSinceOpen: () => 10,
      }),
      logger: createLoggerStub(),
    }),
    now: () => new Date('2026-02-16T02:00:00.000Z'),
    canContinue: () => true,
    resolveCanAutoSearchNow: () => false,
    ...overrides,
  };
  return { deps, registry, quoteContext, warnings, statusRequests, publicationDirections };
}

describe('历史持仓交易状态准入', () => {
  it('正常交易批量准入两方向，只进入 ACTIVATING，清零计数与冻结；零可用持仓仍是候选', async () => {
    const harness = createStatusAdmissionHarness();
    harness.registry.updateSeatState('LONG', {
      ...harness.registry.getSeatState('LONG'),
      symbol: null, status: 'EMPTY',
      searchFailCountToday: 2,
      frozenTradingDayKey: '2026-02-16',
    });
    await prepareSeatsForRuntime(harness.deps);
    expect(harness.statusRequests).toEqual([['OLD_LONG.HK', 'OLD_SHORT.HK']]);
    for (const direction of ['LONG', 'SHORT'] as const) {
      expect(harness.registry.getSeatState(direction)).toMatchObject({
        symbol: `OLD_${direction}.HK`,
        status: 'ACTIVATING',
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      });
    }

    expect(harness.warnings).toHaveLength(0);
  });

  it.each([
    'HALTED', 'DELISTED', 'FUSE', 'PREPARE_LIST', 'CODE_MOVED', 'TO_BE_OPENED',
    'SPLIT_STOCK_HALTS', 'EXPIRED', 'WARRANT_PREPARE_LIST', 'SUSPEND',
  ] as const)('已确认 %s 拒绝但不计寻标失败，日志带实际状态', async (status) => {
    const harness = createStatusAdmissionHarness({
      marketDataClient: {
        getSecurityTradingStatuses: async () => new Map([
          ['OLD_SHORT.HK', 'NORMAL'], ['OLD_LONG.HK', status],
        ]),
      },
    });
    harness.registry.updateSeatState('LONG', {
      ...harness.registry.getSeatState('LONG'), symbol: null, status: 'EMPTY', searchFailCountToday: 1,
    });
    await prepareSeatsForRuntime(harness.deps);
    expect(harness.registry.getSeatState('LONG')).toMatchObject({
      symbol: null, status: 'EMPTY', searchFailCountToday: 1,
    });
    expect(harness.registry.getSeatState('SHORT').symbol).toBe('OLD_SHORT.HK');
    expect(harness.quoteContext.getCalls('warrantList')).toHaveLength(0);
    expect(harness.warnings[0]?.[0]).toContain(`方向 LONG 拒绝历史候选 OLD_LONG.HK，交易状态 ${status}`);
    expect(harness.warnings[0]?.[0]).toContain('HSI.HK');
  });

  it.each([false, true])('非正常候选按原门禁补席；frozen=%p 时不搜索且保留冻结/计数', async (frozen) => {
    const harness = createStatusAdmissionHarness({
      resolveCanAutoSearchNow: () => true,
      marketDataClient: {
        getSecurityTradingStatuses: async (symbols) => new Map(symbols.map((symbol) => [symbol, 'SUSPEND'] as const)),
      },
    });
    if (frozen) {
      for (const direction of ['LONG', 'SHORT'] as const) {
        harness.registry.updateSeatState(direction, {
          ...harness.registry.getSeatState(direction),
          symbol: null, status: 'EMPTY',
          frozenTradingDayKey: '2026-02-16', searchFailCountToday: 2,
        });
      }
    }

    seedAutoSearchCandidates(harness.quoteContext);
    await prepareSeatsForRuntime(harness.deps);
    expect(harness.quoteContext.getCalls('warrantList')).toHaveLength(frozen ? 0 : 2);
    expect(harness.registry.getSeatState('LONG')).toMatchObject({
      status: frozen ? 'EMPTY' : 'ACTIVATING',
      symbol: frozen ? null : 'AUTO_BULL.HK',
      searchFailCountToday: frozen ? 2 : 0,
      frozenTradingDayKey: frozen ? '2026-02-16' : null,
    });
  });

  it.each(['缺少第二方向', '外部请求失败'] as const)('%s 时两方向零提前发布、不寻标', async (failure) => {
    const error = await createExternalApiRequestError({
      operation: 'QuoteContext.quote', attempts: 1, cause: new Error('quote failed'),
    });
    const harness = createStatusAdmissionHarness({
      resolveCanAutoSearchNow: () => true,
      marketDataClient: {
        getSecurityTradingStatuses: async () => {
          if (failure === '外部请求失败') throw error;

          return new Map([['OLD_LONG.HK', 'NORMAL']]);
        },
      },
    });
    const caught: unknown = await prepareSeatsForRuntime(harness.deps).then(() => null, (e: unknown) => e);
    if (failure === '外部请求失败') expect(caught).toBe(error);
    else expect(caught).toBeInstanceOf(TypeError);

    expect(harness.publicationDirections).toEqual([]);
    expect(harness.quoteContext.getCalls('warrantList')).toHaveLength(0);
  });

  it.each([false, true])('等待状态期间原授权失效；损坏端口=%p 仍先暴露内部错误', async (broken) => {
    let authorized = true;
    const gate = Promise.withResolvers<ReadonlyMap<string, SecurityTradingStatus>>();
    const harness = createStatusAdmissionHarness({
      resolveCanAutoSearchNow: () => true,
      canContinue: () => authorized,
      marketDataClient: { getSecurityTradingStatuses: () => gate.promise },
    });
    const pending = prepareSeatsForRuntime(harness.deps);
    expect(harness.publicationDirections).toEqual([]);
    authorized = false;
    gate.resolve(new Map(broken ? [['OLD_LONG.HK', 'NORMAL']] : [
      ['OLD_LONG.HK', 'SUSPEND'], ['OLD_SHORT.HK', 'NORMAL'],
    ]));

    await (broken ? rejects(pending, TypeError) : pending);
    expect(harness.publicationDirections).toEqual([]);
    expect(harness.quoteContext.getCalls('warrantList')).toHaveLength(0);
    expect(harness.warnings).toHaveLength(0);
  });

  it('状态请求抛错即使原授权已失效也保留外部失败身份，不静默返回', async () => {
    let authorized = true;
    const error = await createExternalApiRequestError({
      operation: 'QuoteContext.quote', attempts: 1, cause: new Error('network unavailable'),
    });
    const gate = Promise.withResolvers<ReadonlyMap<string, SecurityTradingStatus>>();
    const harness = createStatusAdmissionHarness({
      canContinue: () => authorized,
      marketDataClient: { getSecurityTradingStatuses: () => gate.promise },
    });
    const pending = prepareSeatsForRuntime(harness.deps);
    authorized = false;
    gate.reject(error);
    expect(await pending.catch((caught: unknown) => caught)).toBe(error);
    expect(harness.publicationDirections).toEqual([]);
    expect(harness.quoteContext.getCalls('warrantList')).toHaveLength(0);
  });

  it('入口授权失效不读状态；无候选不发状态请求', async () => {
    const unauthorized = createStatusAdmissionHarness({ canContinue: () => false });
    await prepareSeatsForRuntime(unauthorized.deps);
    expect(unauthorized.statusRequests).toEqual([]);
    expect(unauthorized.publicationDirections).toEqual([]);
    const empty = createStatusAdmissionHarness({ positions: [] });
    await prepareSeatsForRuntime(empty.deps);
    expect(empty.statusRequests).toEqual([]);
  });

  it('最新完全成交候选被拒后不回溯更早持仓，也不改用未完全成交订单', async () => {
    const harness = createStatusAdmissionHarness({
      marketDataClient: { getSecurityTradingStatuses: async () => new Map([['LATEST.HK', 'EXPIRED']]) },
    });
    await prepareSeatsForRuntime({
      ...harness.deps,
      orders: [
        createRecoveryOrder('EARLY.HK', 'LONG', new Date('2026-02-16T00:00:00Z')),
        createRecoveryOrder('LATEST.HK', 'LONG'),
        { ...createRecoveryOrder('PARTIAL.HK', 'LONG', new Date('2026-02-16T01:30:00Z')), executionStatus: 'PARTIAL' },
      ],
      positions: ['EARLY.HK', 'LATEST.HK', 'PARTIAL.HK'].map((symbol) => ({
        ...harness.deps.positions[0]!, symbol,
      })),
    });
    expect(harness.registry.getSeatState('LONG').symbol).toBeNull();
    expect(harness.warnings[0]?.[0]).toContain('LATEST.HK');
  });
});

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
      marketDataClient: {
        getSecurityTradingStatuses: async () => {
          throw new Error('静态模式不得查询交易状态');
        },
      },
      logger: createLoggerStub(),
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
    expect(longSeat).toMatchObject({ symbol: 'BULL.HK', status: 'ACTIVATING' });
    expect(shortSeat).toMatchObject({ symbol: 'BEAR.HK', status: 'ACTIVATING' });
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
      marketDataClient: createMarketDataClientDouble(),
      logger: createLoggerStub(),
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
      marketDataClient: createMarketDataClientDouble(),
      logger: createLoggerStub(),
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
        marketDataClient: createMarketDataClientDouble(),
        logger: createLoggerStub(),
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
        marketDataClient: createMarketDataClientDouble(),
        logger: createLoggerStub(),
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
      marketDataClient: createMarketDataClientDouble(),
      logger: createLoggerStub(),
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
      marketDataClient: createMarketDataClientDouble(),
      logger: createLoggerStub(),
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
      marketDataClient: createMarketDataClientDouble(),
      logger: createLoggerStub(),
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
      marketDataClient: createMarketDataClientDouble(),
      logger: createLoggerStub(),
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
      marketDataClient: createMarketDataClientDouble(),
      logger: createLoggerStub(),
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
      marketDataClient: createMarketDataClientDouble(),
      logger: createLoggerStub(),
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
