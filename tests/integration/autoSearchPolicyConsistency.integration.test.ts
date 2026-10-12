/**
 * auto-search-policy-consistency 集成测试
 *
 * 功能：
 * - 验证启动寻标、运行时空席位自动寻标、距回收价换标预寻标三条入口在同一候选集下使用同一策略并得到一致结果。
 */
import {
  ORDER_READ_STATUS_VALUES,
  isOpenOrderReadStatus,
} from '../../src/constants/orderReadMetadata.js';
import { describe, expect, it } from 'bun:test';
import { createBrokerIngressFixture } from './architectureRefactoringP1Native/trade/brokerIngressFixture.js';
import {
  captureSearchSeatAuthorization,
  captureSwitchSeatAuthorization,
} from '../services/autoSymbolManager/utils.js';

import { createTradingConfig } from '../../mock/factories/configFactory.js';
import type { SymbolRegistry } from '../../src/types/seat.js';
import type { MarketQuoteContext } from '../../src/types/services.js';
import { prepareSeatsForRuntime } from '../../src/main/recovery/seatPreparation.js';
import { findBestWarrant } from '../../src/services/autoSymbolFinder/index.js';
import {
  buildFindBestWarrantInputFromPolicy,
  resolveDirectionalAutoSearchPolicy,
} from '../../src/services/autoSymbolFinder/policyResolver.js';
import { createSymbolRegistry } from '../../src/services/autoSymbolManager/utils.js';
import { createAutoSearch } from '../../src/services/autoSymbolManager/autoSearch.js';
import {
  calculateBuyQuantityByNotional,
  createSignalBuilder,
  resolveDirectionSymbols,
} from '../../src/services/autoSymbolManager/signalBuilder.js';
import { createSeatStateManager } from '../../src/services/autoSymbolManager/seatStateManager.js';
import { createSwitchStateMachine } from '../../src/services/autoSymbolManager/switchStateMachine.js';
import type { Logger } from '../../src/utils/logger/types.js';
import { getHKDateKey } from '../../src/utils/time/index.js';
import {
  createMarketDataClientDouble,
  createMonitorConfigDouble,
  createOrderRecorderDouble,
  createQuoteContextDouble,
  createQuoteDouble,
  createRiskCheckerDouble,
  createTraderDouble,
  createWarrantDistanceInfoDouble,
} from '../helpers/testDoubles.js';

function createLoggerRecorder(): {
  readonly logger: Logger;
  readonly infos: string[];
  readonly warns: string[];
  readonly errors: string[];
} {
  const infos: string[] = [];
  const warns: string[] = [];
  const errors: string[] = [];

  return {
    logger: {
      debug: () => {},
      info: (message: string) => {
        infos.push(message);
      },
      warn: (message: string) => {
        warns.push(message);
      },
      error: (message: string) => {
        errors.push(message);
      },
    },
    infos,
    warns,
    errors,
  };
}

function createWarrantInfo(params: {
  readonly symbol: string;
  readonly warrantType: 'BULL' | 'BEAR';
  readonly apiDistanceRatio: string;
  readonly turnover: string;
  readonly callPrice: string;
}): Awaited<ReturnType<MarketQuoteContext['warrantList']>>[number] {
  return {
    symbol: params.symbol,
    name: params.symbol,
    lastDone: '0.1',
    toCallPrice: params.apiDistanceRatio,
    turnover: params.turnover,
    callPrice: params.callPrice,
    warrantType: params.warrantType,
    status: 'NORMAL',
  };
}

/** 中性 query 按真实对象请求返回方向事实，并记录请求以证明三个入口均执行了查询。 */
function createWarrantQuery(warrants: Awaited<ReturnType<MarketQuoteContext['warrantList']>>): {
  readonly context: MarketQuoteContext;
  readonly requests: Array<Parameters<MarketQuoteContext['warrantList']>[0]>;
} {
  const requests: Array<Parameters<MarketQuoteContext['warrantList']>[0]> = [];
  const context = createQuoteContextDouble({
    warrantList: async (request) => {
      requests.push(request);
      expect(request.types).toHaveLength(1);
      return request.symbol === 'HSI.HK'
        ? warrants.filter((warrant) => request.types[0] === warrant.warrantType)
        : [];
    },
  });
  return { context, requests };
}

async function runDistanceSwitch(
  machine: ReturnType<typeof createSwitchStateMachine>,
  registry: SymbolRegistry,
  params: Omit<
    Parameters<ReturnType<typeof createSwitchStateMachine>['startSwitchOnDistance']>[0],
    'canContinue'
  >,
): Promise<void> {
  const switchParams = {
    ...params,
    canContinue: captureSwitchSeatAuthorization(registry, params.direction),
  };
  if (machine.hasPendingSwitch(params.direction)) {
    await machine.advancePendingSwitch(switchParams);
    return;
  }

  const startResult = await machine.startSwitchOnDistance(switchParams);
  if (startResult.started) {
    expect(startResult.driveResult.publishedRoute?.isCurrent()).toBeTrue();
    await machine.advancePendingSwitch({
      ...params,
      canContinue: captureSwitchSeatAuthorization(registry, params.direction),
    });
  }
}

describe('auto search policy consistency integration', () => {
  it('selects the same degraded candidate across startup search, runtime empty-seat search, and distance-switch presearch', async () => {
    const currentTime = new Date('2026-02-16T01:00:00.000Z');
    let mutationCalls = 0;
    const nativeBuy = await createBrokerIngressFixture({
      orderId: 'POLICY-BUY',
      tradeId: 'POLICY-BUY-T',
      symbol: 'POLICY.HK',
      stockName: 'Policy',
      remark: 'policy',
      side: 'BUY',
      status: 'Filled',
      quantity: '1',
      executedQuantity: '1',
      submittedPrice: '1',
      executedPrice: '1',
      submittedAtMs: currentTime.getTime(),
      executionTimeMs: currentTime.getTime(),
      updatedAtMs: currentTime.getTime(),
    });
    const buySide = nativeBuy.queryObservation.executionSide;
    expect(buySide).toBe('BUY');

    const monitorConfig = createMonitorConfigDouble({
      monitorSymbol: 'HSI.HK',
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
    const { context: quoteContext, requests: warrantRequests } = createWarrantQuery([
      createWarrantInfo({
        symbol: 'LOWER_BULL.HK',
        warrantType: 'BULL',
        apiDistanceRatio: '0.0022',
        turnover: '1500000',
        callPrice: '20300',
      }),
      createWarrantInfo({
        symbol: 'BEST_BULL.HK',
        warrantType: 'BULL',
        apiDistanceRatio: '0.003499',
        turnover: '1800000',
        callPrice: '20500',
      }),
    ]);

    const startupLogger = createLoggerRecorder();
    const startupRegistry = createSymbolRegistry(monitorConfig);
    startupRegistry.updateSeatState('LONG', {
      symbol: null,
      status: 'EMPTY',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
      callPrice: null,
    });

    startupRegistry.updateSeatState('SHORT', {
      symbol: null,
      status: 'EMPTY',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
      callPrice: null,
    });

    await prepareSeatsForRuntime({
      tradingConfig: createTradingConfig({ monitor: monitorConfig }),
      symbolRegistry: startupRegistry,
      positions: [],
      orders: [],
      marketDataClient: createMarketDataClientDouble({
        getQuoteContext: async () => quoteContext,
      }),
      now: () => currentTime,
      logger: startupLogger.logger,
      getTradingMinutesSinceOpen: () => 10,
      resolveCanAutoSearchNow: () =>
        monitorConfig.autoSearchConfig.autoSearchEnabled &&
        10 >= monitorConfig.autoSearchConfig.autoSearchOpenDelayMinutes,
    });

    const startupSeat = startupRegistry.getSeatState('LONG');
    expect(startupSeat.status).toBe('ACTIVATING');
    expect(startupSeat.symbol).toBe('BEST_BULL.HK');
    expect(
      startupLogger.infos.some(
        (message) =>
          message.includes('BEST_BULL.HK') && message.includes('selectionStage=DEGRADED'),
      ),
    ).toBe(true);

    const runtimeLogger = createLoggerRecorder();
    const runtimeRegistry = createSymbolRegistry(monitorConfig);
    runtimeRegistry.updateSeatState('LONG', {
      symbol: null,
      status: 'EMPTY',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
      callPrice: null,
    });
    const runtimeSeatStateManager = createSeatStateManager({
      symbolRegistry: runtimeRegistry,
      switchStates: new Map(),
      switchSuppressions: new Map(),
      now: () => currentTime,
      logger: runtimeLogger.logger,
      getHKDateKey,
    });
    const runtimeAutoSearch = createAutoSearch({
      autoSearchConfig: monitorConfig.autoSearchConfig,
      monitorSymbol: monitorConfig.monitorSymbol,
      symbolRegistry: runtimeRegistry,
      updateSeatState: runtimeSeatStateManager.updateSeatState,
      resolveDirectionalAutoSearchPolicy: (params) =>
        resolveDirectionalAutoSearchPolicy({
          ...params,
          autoSearchConfig: monitorConfig.autoSearchConfig,
          monitorSymbol: monitorConfig.monitorSymbol,
          logger: runtimeLogger.logger,
        }),
      buildFindBestWarrantInput: async ({ currentTime: nextTime, policy }) =>
        buildFindBestWarrantInputFromPolicy({
          ctx: quoteContext,
          monitorSymbol: monitorConfig.monitorSymbol,
          currentTime: nextTime,
          policy,
          expiryMinMonths: monitorConfig.autoSearchConfig.autoSearchExpiryMinMonths,
          logger: runtimeLogger.logger,
          getTradingMinutesSinceOpen: () => 10,
        }),
      findBestWarrant,
      isWithinMorningAutoSearchOpenDelay: () => false,
      searchCooldownMs: 10_000,
      getHKDateKey,
      maxSearchFailuresPerDay: 3,
      logger: runtimeLogger.logger,
    });
    await runtimeAutoSearch.maybeSearchOnEvent({
      direction: 'LONG',
      currentTime,
      canContinue: captureSearchSeatAuthorization(runtimeRegistry, 'LONG'),
    });

    const runtimeSeat = runtimeRegistry.getSeatState('LONG');
    expect(runtimeSeat.status).toBe('ACTIVATING');
    expect(runtimeSeat.symbol).toBe('BEST_BULL.HK');
    expect(
      runtimeLogger.infos.some(
        (message) =>
          message.includes('BEST_BULL.HK') && message.includes('selectionStage=DEGRADED'),
      ),
    ).toBe(true);

    const switchLogger = createLoggerRecorder();
    const switchStates = new Map();
    const switchSuppressions = new Map();
    const switchRegistry = createSymbolRegistry(monitorConfig);
    switchRegistry.updateSeatState('LONG', {
      symbol: 'OLD_BULL.HK',
      status: 'ACTIVE',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: currentTime.getTime(),
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
      callPrice: null,
    });
    const switchSeatStateManager = createSeatStateManager({
      symbolRegistry: switchRegistry,
      switchStates,
      switchSuppressions,
      now: () => currentTime,
      logger: switchLogger.logger,
      getHKDateKey,
    });
    const signalBuilder = createSignalBuilder({ now: () => currentTime });
    const switchStateMachine = createSwitchStateMachine({
      autoSearchConfig: monitorConfig.autoSearchConfig,
      monitorSymbol: monitorConfig.monitorSymbol,
      symbolRegistry: switchRegistry,
      trader: createTraderDouble({
        executeSignals: async () => {
          mutationCalls += 1;
          throw new Error('policy selection must not submit');
        },
        getPendingOrders: async () => [],
      }),
      orderRecorder: createOrderRecorderDouble(),
      riskChecker: createRiskCheckerDouble({
        getWarrantDistanceInfo: () =>
          createWarrantDistanceInfoDouble({
            warrantType: 'BULL',
            distanceNumerator: '0.1',
            distanceDenominator: '100',
          }),
      }),
      now: () => currentTime,
      switchStates,
      periodicSwitchPending: new Map(),
      resolveSuppression: switchSeatStateManager.resolveSuppression,
      markSuppression: switchSeatStateManager.markSuppression,
      enterSwitchingSeat: switchSeatStateManager.enterSwitchingSeat,
      updateSeatState: switchSeatStateManager.updateSeatState,
      resolveDirectionalAutoSearchPolicy: (params) =>
        resolveDirectionalAutoSearchPolicy({
          ...params,
          autoSearchConfig: monitorConfig.autoSearchConfig,
          monitorSymbol: monitorConfig.monitorSymbol,
          logger: switchLogger.logger,
        }),
      buildFindBestWarrantInput: async ({ currentTime: nextTime, policy }) =>
        buildFindBestWarrantInputFromPolicy({
          ctx: quoteContext,
          monitorSymbol: monitorConfig.monitorSymbol,
          currentTime: nextTime,
          policy,
          expiryMinMonths: monitorConfig.autoSearchConfig.autoSearchExpiryMinMonths,
          logger: switchLogger.logger,
          getTradingMinutesSinceOpen: () => 10,
        }),
      findBestWarrant,
      resolveDirectionSymbols,
      calculateBuyQuantityByNotional,
      buildOrderSignal: signalBuilder.buildOrderSignal,
      pendingOrderStatuses: new Set([...ORDER_READ_STATUS_VALUES].filter(isOpenOrderReadStatus)),
      buySide,
      logger: switchLogger.logger,
      maxSearchFailuresPerDay: 3,
      getHKDateKey,
      calculateTradingDurationMsBetween: () => 0,
      getTradingCalendarSnapshot: () => new Map(),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async (symbols) =>
          new Map([...symbols].map((symbol) => [symbol, createQuoteDouble(symbol, '1', 100)])),
      }),
    });
    await runDistanceSwitch(switchStateMachine, switchRegistry, {
      direction: 'LONG',
      monitorPrice: '20000',
      positions: [],
    });

    const switchedSeat = switchRegistry.getSeatState('LONG');
    expect(switchedSeat.status).toBe('ACTIVATING');
    expect(switchedSeat.symbol).toBe('BEST_BULL.HK');
    expect(
      switchLogger.infos.some(
        (message) =>
          message.includes('BEST_BULL.HK') && message.includes('selectionStage=DEGRADED'),
      ),
    ).toBe(true);

    expect(warrantRequests.map((request) => request.types)).toEqual([
      ['BULL'],
      ['BEAR'],
      ['BULL'],
      ['BULL'],
    ]);
    expect(warrantRequests).toHaveLength(4);
    expect(warrantRequests.map((request) => request.symbol)).toEqual([
      'HSI.HK',
      'HSI.HK',
      'HSI.HK',
      'HSI.HK',
    ]);

    expect(warrantRequests.map((request) => request.status)).toEqual([
      ['NORMAL'],
      ['NORMAL'],
      ['NORMAL'],
      ['NORMAL'],
    ]);

    expect(mutationCalls).toBe(0);
  });

  it('selects the same degraded SHORT candidate across startup search, runtime empty-seat search, and distance-switch presearch', async () => {
    const currentTime = new Date('2026-02-16T01:00:00.000Z');
    let mutationCalls = 0;
    const nativeBuy = await createBrokerIngressFixture({
      orderId: 'POLICY-BUY',
      tradeId: 'POLICY-BUY-T',
      symbol: 'POLICY.HK',
      stockName: 'Policy',
      remark: 'policy',
      side: 'BUY',
      status: 'Filled',
      quantity: '1',
      executedQuantity: '1',
      submittedPrice: '1',
      executedPrice: '1',
      submittedAtMs: currentTime.getTime(),
      executionTimeMs: currentTime.getTime(),
      updatedAtMs: currentTime.getTime(),
    });
    const buySide = nativeBuy.queryObservation.executionSide;
    expect(buySide).toBe('BUY');

    const monitorConfig = createMonitorConfigDouble({
      monitorSymbol: 'HSI.HK',
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
    const { context: quoteContext, requests: warrantRequests } = createWarrantQuery([
      createWarrantInfo({
        symbol: 'UPPER_BEAR.HK',
        warrantType: 'BEAR',
        apiDistanceRatio: '-0.0022',
        turnover: '1500000',
        callPrice: '19300',
      }),
      createWarrantInfo({
        symbol: 'BEST_BEAR.HK',
        warrantType: 'BEAR',
        apiDistanceRatio: '-0.003499',
        turnover: '1800000',
        callPrice: '19500',
      }),
    ]);

    const startupLogger = createLoggerRecorder();
    const startupRegistry = createSymbolRegistry(monitorConfig);
    startupRegistry.updateSeatState('LONG', {
      symbol: null,
      status: 'EMPTY',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
      callPrice: null,
    });

    startupRegistry.updateSeatState('SHORT', {
      symbol: null,
      status: 'EMPTY',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
      callPrice: null,
    });

    await prepareSeatsForRuntime({
      tradingConfig: createTradingConfig({ monitor: monitorConfig }),
      symbolRegistry: startupRegistry,
      positions: [],
      orders: [],
      marketDataClient: createMarketDataClientDouble({
        getQuoteContext: async () => quoteContext,
      }),
      now: () => currentTime,
      logger: startupLogger.logger,
      getTradingMinutesSinceOpen: () => 10,
      resolveCanAutoSearchNow: () =>
        monitorConfig.autoSearchConfig.autoSearchEnabled &&
        10 >= monitorConfig.autoSearchConfig.autoSearchOpenDelayMinutes,
    });

    const startupSeat = startupRegistry.getSeatState('SHORT');
    expect(startupSeat.status).toBe('ACTIVATING');
    expect(startupSeat.symbol).toBe('BEST_BEAR.HK');
    expect(
      startupLogger.infos.some(
        (message) =>
          message.includes('BEST_BEAR.HK') && message.includes('selectionStage=DEGRADED'),
      ),
    ).toBe(true);

    const runtimeLogger = createLoggerRecorder();
    const runtimeRegistry = createSymbolRegistry(monitorConfig);
    runtimeRegistry.updateSeatState('SHORT', {
      symbol: null,
      status: 'EMPTY',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
      callPrice: null,
    });
    const runtimeSeatStateManager = createSeatStateManager({
      symbolRegistry: runtimeRegistry,
      switchStates: new Map(),
      switchSuppressions: new Map(),
      now: () => currentTime,
      logger: runtimeLogger.logger,
      getHKDateKey,
    });
    const runtimeAutoSearch = createAutoSearch({
      autoSearchConfig: monitorConfig.autoSearchConfig,
      monitorSymbol: monitorConfig.monitorSymbol,
      symbolRegistry: runtimeRegistry,
      updateSeatState: runtimeSeatStateManager.updateSeatState,
      resolveDirectionalAutoSearchPolicy: (params) =>
        resolveDirectionalAutoSearchPolicy({
          ...params,
          autoSearchConfig: monitorConfig.autoSearchConfig,
          monitorSymbol: monitorConfig.monitorSymbol,
          logger: runtimeLogger.logger,
        }),
      buildFindBestWarrantInput: async ({ currentTime: nextTime, policy }) =>
        buildFindBestWarrantInputFromPolicy({
          ctx: quoteContext,
          monitorSymbol: monitorConfig.monitorSymbol,
          currentTime: nextTime,
          policy,
          expiryMinMonths: monitorConfig.autoSearchConfig.autoSearchExpiryMinMonths,
          logger: runtimeLogger.logger,
          getTradingMinutesSinceOpen: () => 10,
        }),
      findBestWarrant,
      isWithinMorningAutoSearchOpenDelay: () => false,
      searchCooldownMs: 10_000,
      getHKDateKey,
      maxSearchFailuresPerDay: 3,
      logger: runtimeLogger.logger,
    });
    await runtimeAutoSearch.maybeSearchOnEvent({
      direction: 'SHORT',
      currentTime,
      canContinue: captureSearchSeatAuthorization(runtimeRegistry, 'SHORT'),
    });

    const runtimeSeat = runtimeRegistry.getSeatState('SHORT');
    expect(runtimeSeat.status).toBe('ACTIVATING');
    expect(runtimeSeat.symbol).toBe('BEST_BEAR.HK');
    expect(
      runtimeLogger.infos.some(
        (message) =>
          message.includes('BEST_BEAR.HK') && message.includes('selectionStage=DEGRADED'),
      ),
    ).toBe(true);

    const switchLogger = createLoggerRecorder();
    const switchStates = new Map();
    const switchSuppressions = new Map();
    const switchRegistry = createSymbolRegistry(monitorConfig);
    switchRegistry.updateSeatState('SHORT', {
      symbol: 'OLD_BEAR.HK',
      status: 'ACTIVE',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: currentTime.getTime(),
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
      callPrice: null,
    });
    const switchSeatStateManager = createSeatStateManager({
      symbolRegistry: switchRegistry,
      switchStates,
      switchSuppressions,
      now: () => currentTime,
      logger: switchLogger.logger,
      getHKDateKey,
    });
    const signalBuilder = createSignalBuilder({ now: () => currentTime });
    const switchStateMachine = createSwitchStateMachine({
      autoSearchConfig: monitorConfig.autoSearchConfig,
      monitorSymbol: monitorConfig.monitorSymbol,
      symbolRegistry: switchRegistry,
      trader: createTraderDouble({
        executeSignals: async () => {
          mutationCalls += 1;
          throw new Error('policy selection must not submit');
        },
        getPendingOrders: async () => [],
      }),
      orderRecorder: createOrderRecorderDouble(),
      riskChecker: createRiskCheckerDouble({
        getWarrantDistanceInfo: () =>
          createWarrantDistanceInfoDouble({
            warrantType: 'BEAR',
            distanceNumerator: '-0.1',
            distanceDenominator: '100',
          }),
      }),
      now: () => currentTime,
      switchStates,
      periodicSwitchPending: new Map(),
      resolveSuppression: switchSeatStateManager.resolveSuppression,
      markSuppression: switchSeatStateManager.markSuppression,
      enterSwitchingSeat: switchSeatStateManager.enterSwitchingSeat,
      updateSeatState: switchSeatStateManager.updateSeatState,
      resolveDirectionalAutoSearchPolicy: (params) =>
        resolveDirectionalAutoSearchPolicy({
          ...params,
          autoSearchConfig: monitorConfig.autoSearchConfig,
          monitorSymbol: monitorConfig.monitorSymbol,
          logger: switchLogger.logger,
        }),
      buildFindBestWarrantInput: async ({ currentTime: nextTime, policy }) =>
        buildFindBestWarrantInputFromPolicy({
          ctx: quoteContext,
          monitorSymbol: monitorConfig.monitorSymbol,
          currentTime: nextTime,
          policy,
          expiryMinMonths: monitorConfig.autoSearchConfig.autoSearchExpiryMinMonths,
          logger: switchLogger.logger,
          getTradingMinutesSinceOpen: () => 10,
        }),
      findBestWarrant,
      resolveDirectionSymbols,
      calculateBuyQuantityByNotional,
      buildOrderSignal: signalBuilder.buildOrderSignal,
      pendingOrderStatuses: new Set([...ORDER_READ_STATUS_VALUES].filter(isOpenOrderReadStatus)),
      buySide,
      logger: switchLogger.logger,
      maxSearchFailuresPerDay: 3,
      getHKDateKey,
      calculateTradingDurationMsBetween: () => 0,
      getTradingCalendarSnapshot: () => new Map(),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async (symbols) =>
          new Map([...symbols].map((symbol) => [symbol, createQuoteDouble(symbol, '1', 100)])),
      }),
    });
    await runDistanceSwitch(switchStateMachine, switchRegistry, {
      direction: 'SHORT',
      monitorPrice: '20000',
      positions: [],
    });

    const switchedSeat = switchRegistry.getSeatState('SHORT');
    expect(switchedSeat.status).toBe('ACTIVATING');
    expect(switchedSeat.symbol).toBe('BEST_BEAR.HK');
    expect(
      switchLogger.infos.some(
        (message) =>
          message.includes('BEST_BEAR.HK') && message.includes('selectionStage=DEGRADED'),
      ),
    ).toBe(true);

    expect(warrantRequests.map((request) => request.types)).toEqual([
      ['BULL'],
      ['BEAR'],
      ['BEAR'],
      ['BEAR'],
    ]);
    expect(warrantRequests).toHaveLength(4);
    expect(warrantRequests.map((request) => request.symbol)).toEqual([
      'HSI.HK',
      'HSI.HK',
      'HSI.HK',
      'HSI.HK',
    ]);

    expect(warrantRequests.map((request) => request.status)).toEqual([
      ['NORMAL'],
      ['NORMAL'],
      ['NORMAL'],
      ['NORMAL'],
    ]);

    expect(mutationCalls).toBe(0);
  });

  it('keeps candidate selection unchanged when safe/danger trigger semantics differ', async () => {
    const currentTime = new Date('2026-02-16T01:00:00.000Z');
    let mutationCalls = 0;
    const nativeBuy = await createBrokerIngressFixture({
      orderId: 'POLICY-BUY',
      tradeId: 'POLICY-BUY-T',
      symbol: 'POLICY.HK',
      stockName: 'Policy',
      remark: 'policy',
      side: 'BUY',
      status: 'Filled',
      quantity: '1',
      executedQuantity: '1',
      submittedPrice: '1',
      executedPrice: '1',
      submittedAtMs: currentTime.getTime(),
      executionTimeMs: currentTime.getTime(),
      updatedAtMs: currentTime.getTime(),
    });
    const buySide = nativeBuy.queryObservation.executionSide;
    expect(buySide).toBe('BUY');

    const monitorConfig = createMonitorConfigDouble({
      monitorSymbol: 'HSI.HK',
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
    const { context: quoteContext, requests: warrantRequests } = createWarrantQuery([
      createWarrantInfo({
        symbol: 'LOWER_BULL.HK',
        warrantType: 'BULL',
        apiDistanceRatio: '0.0022',
        turnover: '1500000',
        callPrice: '20300',
      }),
      createWarrantInfo({
        symbol: 'BEST_BULL.HK',
        warrantType: 'BULL',
        apiDistanceRatio: '0.003499',
        turnover: '1800000',
        callPrice: '20500',
      }),
    ]);

    const runtimeLogger = createLoggerRecorder();
    const runtimeRegistry = createSymbolRegistry(monitorConfig);
    runtimeRegistry.updateSeatState('LONG', {
      symbol: null,
      status: 'EMPTY',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
      callPrice: null,
    });
    const runtimeSeatStateManager = createSeatStateManager({
      symbolRegistry: runtimeRegistry,
      switchStates: new Map(),
      switchSuppressions: new Map(),
      now: () => currentTime,
      logger: runtimeLogger.logger,
      getHKDateKey,
    });
    const runtimeAutoSearch = createAutoSearch({
      autoSearchConfig: monitorConfig.autoSearchConfig,
      monitorSymbol: monitorConfig.monitorSymbol,
      symbolRegistry: runtimeRegistry,
      updateSeatState: runtimeSeatStateManager.updateSeatState,
      resolveDirectionalAutoSearchPolicy: (params) =>
        resolveDirectionalAutoSearchPolicy({
          ...params,
          autoSearchConfig: monitorConfig.autoSearchConfig,
          monitorSymbol: monitorConfig.monitorSymbol,
          logger: runtimeLogger.logger,
        }),
      buildFindBestWarrantInput: async ({ currentTime: nextTime, policy }) =>
        buildFindBestWarrantInputFromPolicy({
          ctx: quoteContext,
          monitorSymbol: monitorConfig.monitorSymbol,
          currentTime: nextTime,
          policy,
          expiryMinMonths: monitorConfig.autoSearchConfig.autoSearchExpiryMinMonths,
          logger: runtimeLogger.logger,
          getTradingMinutesSinceOpen: () => 10,
        }),
      findBestWarrant,
      isWithinMorningAutoSearchOpenDelay: () => false,
      searchCooldownMs: 10_000,
      getHKDateKey,
      maxSearchFailuresPerDay: 3,
      logger: runtimeLogger.logger,
    });
    await runtimeAutoSearch.maybeSearchOnEvent({
      direction: 'LONG',
      currentTime,
      canContinue: captureSearchSeatAuthorization(runtimeRegistry, 'LONG'),
    });
    const runtimeSeat = runtimeRegistry.getSeatState('LONG');
    expect(runtimeSeat.symbol).toBe('BEST_BULL.HK');

    const safeLogger = createLoggerRecorder();
    const safeSwitchStates = new Map();
    const safeSwitchSuppressions = new Map();
    const safeRegistry = createSymbolRegistry(monitorConfig);
    safeRegistry.updateSeatState('LONG', {
      symbol: 'BEST_BULL.HK',
      status: 'ACTIVE',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: currentTime.getTime(),
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
      callPrice: null,
    });
    const safeSeatStateManager = createSeatStateManager({
      symbolRegistry: safeRegistry,
      switchStates: safeSwitchStates,
      switchSuppressions: safeSwitchSuppressions,
      now: () => currentTime,
      logger: safeLogger.logger,
      getHKDateKey,
    });
    const safeSignalBuilder = createSignalBuilder({ now: () => currentTime });
    const safeSwitchMachine = createSwitchStateMachine({
      autoSearchConfig: monitorConfig.autoSearchConfig,
      monitorSymbol: monitorConfig.monitorSymbol,
      symbolRegistry: safeRegistry,
      trader: createTraderDouble({
        executeSignals: async () => {
          mutationCalls += 1;
          throw new Error('policy selection must not submit');
        },
        getPendingOrders: async () => [],
      }),
      orderRecorder: createOrderRecorderDouble(),
      riskChecker: createRiskCheckerDouble({
        getWarrantDistanceInfo: () =>
          createWarrantDistanceInfoDouble({
            warrantType: 'BULL',
            distanceNumerator: '2',
            distanceDenominator: '100',
          }),
      }),
      now: () => currentTime,
      switchStates: safeSwitchStates,
      periodicSwitchPending: new Map(),
      resolveSuppression: safeSeatStateManager.resolveSuppression,
      markSuppression: safeSeatStateManager.markSuppression,
      enterSwitchingSeat: safeSeatStateManager.enterSwitchingSeat,
      updateSeatState: safeSeatStateManager.updateSeatState,
      resolveDirectionalAutoSearchPolicy: (params) =>
        resolveDirectionalAutoSearchPolicy({
          ...params,
          autoSearchConfig: monitorConfig.autoSearchConfig,
          monitorSymbol: monitorConfig.monitorSymbol,
          logger: safeLogger.logger,
        }),
      buildFindBestWarrantInput: async ({ currentTime: nextTime, policy }) =>
        buildFindBestWarrantInputFromPolicy({
          ctx: quoteContext,
          monitorSymbol: monitorConfig.monitorSymbol,
          currentTime: nextTime,
          policy,
          expiryMinMonths: monitorConfig.autoSearchConfig.autoSearchExpiryMinMonths,
          logger: safeLogger.logger,
          getTradingMinutesSinceOpen: () => 10,
        }),
      findBestWarrant,
      resolveDirectionSymbols,
      calculateBuyQuantityByNotional,
      buildOrderSignal: safeSignalBuilder.buildOrderSignal,
      pendingOrderStatuses: new Set([...ORDER_READ_STATUS_VALUES].filter(isOpenOrderReadStatus)),
      buySide,
      logger: safeLogger.logger,
      maxSearchFailuresPerDay: 3,
      getHKDateKey,
      calculateTradingDurationMsBetween: () => 0,
      getTradingCalendarSnapshot: () => new Map(),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async (symbols) =>
          new Map([...symbols].map((symbol) => [symbol, createQuoteDouble(symbol, '1', 100)])),
      }),
    });
    await runDistanceSwitch(safeSwitchMachine, safeRegistry, {
      direction: 'LONG',
      monitorPrice: '20000',
      positions: [],
    });

    const dangerLogger = createLoggerRecorder();
    const dangerSwitchStates = new Map();
    const dangerSwitchSuppressions = new Map();
    const dangerRegistry = createSymbolRegistry(monitorConfig);
    dangerRegistry.updateSeatState('LONG', {
      symbol: 'BEST_BULL.HK',
      status: 'ACTIVE',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: currentTime.getTime(),
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
      callPrice: null,
    });
    const dangerSeatStateManager = createSeatStateManager({
      symbolRegistry: dangerRegistry,
      switchStates: dangerSwitchStates,
      switchSuppressions: dangerSwitchSuppressions,
      now: () => currentTime,
      logger: dangerLogger.logger,
      getHKDateKey,
    });
    const dangerSignalBuilder = createSignalBuilder({ now: () => currentTime });
    const dangerSwitchMachine = createSwitchStateMachine({
      autoSearchConfig: monitorConfig.autoSearchConfig,
      monitorSymbol: monitorConfig.monitorSymbol,
      symbolRegistry: dangerRegistry,
      trader: createTraderDouble({
        executeSignals: async () => {
          mutationCalls += 1;
          throw new Error('policy selection must not submit');
        },
        getPendingOrders: async () => [],
      }),
      orderRecorder: createOrderRecorderDouble(),
      riskChecker: createRiskCheckerDouble({
        getWarrantDistanceInfo: () =>
          createWarrantDistanceInfoDouble({
            warrantType: 'BULL',
            distanceNumerator: '0.1',
            distanceDenominator: '100',
          }),
      }),
      now: () => currentTime,
      switchStates: dangerSwitchStates,
      periodicSwitchPending: new Map(),
      resolveSuppression: dangerSeatStateManager.resolveSuppression,
      markSuppression: dangerSeatStateManager.markSuppression,
      enterSwitchingSeat: dangerSeatStateManager.enterSwitchingSeat,
      updateSeatState: dangerSeatStateManager.updateSeatState,
      resolveDirectionalAutoSearchPolicy: (params) =>
        resolveDirectionalAutoSearchPolicy({
          ...params,
          autoSearchConfig: monitorConfig.autoSearchConfig,
          monitorSymbol: monitorConfig.monitorSymbol,
          logger: dangerLogger.logger,
        }),
      buildFindBestWarrantInput: async ({ currentTime: nextTime, policy }) =>
        buildFindBestWarrantInputFromPolicy({
          ctx: quoteContext,
          monitorSymbol: monitorConfig.monitorSymbol,
          currentTime: nextTime,
          policy,
          expiryMinMonths: monitorConfig.autoSearchConfig.autoSearchExpiryMinMonths,
          logger: dangerLogger.logger,
          getTradingMinutesSinceOpen: () => 10,
        }),
      findBestWarrant,
      resolveDirectionSymbols,
      calculateBuyQuantityByNotional,
      buildOrderSignal: dangerSignalBuilder.buildOrderSignal,
      pendingOrderStatuses: new Set([...ORDER_READ_STATUS_VALUES].filter(isOpenOrderReadStatus)),
      buySide,
      logger: dangerLogger.logger,
      maxSearchFailuresPerDay: 3,
      getHKDateKey,
      calculateTradingDurationMsBetween: () => 0,
      getTradingCalendarSnapshot: () => new Map(),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async (symbols) =>
          new Map([...symbols].map((symbol) => [symbol, createQuoteDouble(symbol, '1', 100)])),
      }),
    });
    await runDistanceSwitch(dangerSwitchMachine, dangerRegistry, {
      direction: 'LONG',
      monitorPrice: '20000',
      positions: [],
    });

    const safeSeat = safeRegistry.getSeatState('LONG');
    const dangerSeat = dangerRegistry.getSeatState('LONG');
    expect(safeSeat.status).toBe('ACTIVE');
    expect(dangerSeat.status).toBe('ACTIVE');
    expect(safeSeat.symbol).toBe('BEST_BULL.HK');
    expect(dangerSeat.symbol).toBe('BEST_BULL.HK');
    expect(
      safeLogger.infos.some(
        (message) =>
          message.includes('BEST_BULL.HK') && message.includes('selectionStage=DEGRADED'),
      ),
    ).toBe(true);

    expect(
      dangerLogger.infos.some(
        (message) =>
          message.includes('BEST_BULL.HK') && message.includes('selectionStage=DEGRADED'),
      ),
    ).toBe(true);
    expect(warrantRequests).toHaveLength(3);
    expect(warrantRequests.map((request) => request.symbol)).toEqual([
      'HSI.HK',
      'HSI.HK',
      'HSI.HK',
    ]);

    expect(warrantRequests.map((request) => request.types)).toEqual([['BULL'], ['BULL'], ['BULL']]);

    expect(mutationCalls).toBe(0);
  });
});
