import {
  createLoggerDouble,
  createRiskCheckerDouble,
  createDailyLossTrackerDouble,
  createWarrantCandidateSearchDouble,
  createMonitorContextDouble,
  createMarketDataClientDouble,
  createMonitorConfigDouble,
  createQuoteDouble,
  createSymbolRegistryDouble,
  createTradeRuntimeDouble,
} from '../../helpers/testDoubles.js';

/**
 * createMonitorContext 业务测试
 *
 * 覆盖：
 * - 宿主持有注入的唯一策略与风险实例
 * - 名称从席位与行情派生，不复制策略或席位状态
 */
import { describe, expect, it } from 'bun:test';
import { createDiagnosticObserverDouble } from '../../helpers/diagnostics.js';
import type { PreGateRuntime } from '../../../src/app/types.js';
import type { CreateMonitorContextParams } from '../../../src/app/context/types.js';
import { createMonitorContext as createMonitorContextImpl } from '../../../src/app/context/createMonitorContext.js';
import { createWarrantListCache } from '../../../src/infrastructure/longbridge/market/warrantListCache/index.js';
import type { MonitorConfig, TradingConfig } from '../../../src/types/config.js';
import type { Quote } from '../../../src/types/quote.js';
import { createBrokerClientFactoryDouble } from '../../helpers/brokerClientFactoryDouble.js';

function createMonitorContext(
  params: Omit<CreateMonitorContextParams, 'clock' | 'strategy'> &
    Partial<Pick<CreateMonitorContextParams, 'strategy'>>,
) {
  return createMonitorContextImpl({
    ...params,
    strategy: params.strategy ?? createMonitorContextDouble().strategy,
    clock: { now: () => new Date() },
  });
}

function createTradingConfig(monitor: MonitorConfig): TradingConfig {
  return {
    monitor,
    global: {
      doomsdayProtection: true,
      openProtection: {
        morning: {
          enabled: true,
          minutes: 3,
        },
        afternoon: {
          enabled: true,
          minutes: 3,
        },
      },
      orderMonitorPriceUpdateInterval: 3,
      allowBuyOrderTrackingAboveInitialPrice: true,
      tradingOrderType: 'LO',
      liquidationOrderType: 'ELO',
      buyOrderTimeout: {
        enabled: true,
        timeoutSeconds: 30,
      },
      sellOrderTimeout: {
        enabled: true,
        timeoutSeconds: 30,
      },
    },
  };
}

function createRuntime(
  monitor: MonitorConfig,
  symbolRegistry = createSymbolRegistryDouble({}),
): {
  preGateRuntime: PreGateRuntime;
  postGateRuntime: CreateMonitorContextParams['postGateRuntime'];
  quotesMap: ReadonlyMap<string, Quote | null>;
} {
  const tradeRuntime = createTradeRuntimeDouble();
  const marketDataClient = createMarketDataClientDouble();

  const preGateRuntime: PreGateRuntime = {
    diagnostics: createDiagnosticObserverDouble(),
    brokerClientFactory: createBrokerClientFactoryDouble(),
    tradingConfig: createTradingConfig(monitor),
    symbolRegistry,
    warrantListCache: createWarrantListCache(),
    marketDataClient,
    startupTradingDayInfo: {
      dateKey: '2026-03-09',
      info: {
        isTradingDay: true,
        isHalfDay: false,
      },
    },
  };

  const postGateRuntime: CreateMonitorContextParams['postGateRuntime'] = {
    dailyLossTracker: createDailyLossTrackerDouble(),
    candidateSearch: createWarrantCandidateSearchDouble(),

    tradingCalendarState: {
      cachedTradingDayInfo: {
        dateKey: '2026-03-23',
        info: {
          isTradingDay: true,
          isHalfDay: false,
        },
      },
      tradingCalendarSnapshot: new Map([['2026-03-23', { isTradingDay: true, isHalfDay: false }]]),
    },
    tradeRuntime,
    riskChecker: createRiskCheckerDouble(),
  };

  return {
    preGateRuntime,
    postGateRuntime,
    quotesMap: new Map<string, Quote | null>(),
  };
}

describe('createMonitorContext host assembly', () => {
  it('holds the injected strategy identity and does not expose private strategy state', () => {
    const runtime = createRuntime(createMonitorConfigDouble({ monitorSymbol: 'HSI.HK' }));
    const strategy = createMonitorContextDouble().strategy;
    const context = createMonitorContext({ logger: createLoggerDouble(), ...runtime, strategy });
    expect(context.strategy).toBe(strategy);
    expect(context.riskChecker).toBe(runtime.postGateRuntime.riskChecker);
    for (const field of ['state', 'indicatorProfile', 'delayedSignalVerifier', 'indicatorCache']) {
      expect(field in context).toBeFalse();
    }

    expect('monitorState' in runtime.postGateRuntime.tradingCalendarState).toBeFalse();
  });

  it('hydrates active seat names from registry and quotes without copying seat truth', () => {
    const symbolRegistry = createSymbolRegistryDouble({
      longSeat: {
        symbol: 'LONG.HK',
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
    });
    const runtime = createRuntime(
      createMonitorConfigDouble({ monitorSymbol: 'HSI.HK' }),
      symbolRegistry,
    );
    const context = createMonitorContext({
      logger: createLoggerDouble(),
      ...runtime,
      quotesMap: new Map([
        ['LONG.HK', { ...createQuoteDouble('LONG.HK', '1'), name: 'LongName' }],
        ['HSI.HK', { ...createQuoteDouble('HSI.HK', '20000'), name: 'HangSeng' }],
      ]),
    });
    expect(context.longSymbolName).toBe('LongName');
    expect(context.shortSymbolName).toBe('');
    expect(context.monitorSymbolName).toBe('HangSeng');
    expect(context.symbolRegistry).toBe(symbolRegistry);
    expect('seatState' in context).toBeFalse();
    expect('seatVersion' in context).toBeFalse();
  });
});
