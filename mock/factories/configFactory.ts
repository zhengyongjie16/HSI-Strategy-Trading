/**
 * Mock 配置工厂
 *
 * 功能：
 * - 提供可覆盖默认值的监控配置与全局交易配置构建能力
 */
import type { GlobalConfig, StrategyRuntimeConfig, TradingConfig } from '../../src/types/config.js';
import type { StrategyThresholdConfig } from '../../src/types/factor.js';

function createStrategyThresholdConfig(): StrategyThresholdConfig {
  return {
    regimeThresholds: {
      atrShortPeriod: 5,
      atrLongPeriod: 30,
      rvQuantileWindowDays: 20,
      trendOnVolExpansion: 1.2,
      trendOffVolExpansion: 0.9,
      extremeVolExpansion: 1.8,
      trendOnVolQuantile: 0.7,
      trendOffVolQuantile: 0.4,
      extremeVolQuantile: 0.95,
    },
    trendScoreThresholds: {
      w15: 0.25,
      w30: 0.35,
      w60: 0.4,
      classificationThreshold: 0.8,
      entryThreshold: 0.9,
      exitThreshold: 0.35,
      reverseInvalidationThreshold: 0.5,
    },
    erThresholds: {
      er15EntryMin: 0.4,
      er30EntryMin: 0.35,
      er15ExitMax: 0.25,
      er30ExitMax: 0.2,
      strongTrendErFloor: 0.45,
    },
    vwapConfirmRules: {
      distanceBandAtr: 0.1,
      slopeWindowBars: 5,
      maxCrossCountLast10m: 2,
    },
    openingStructureRules: {
      openingRangeMinutes: 20,
      breakoutScoreMin: 0.8,
      outsidePersistenceWindowBars: 5,
      outsidePersistenceMin: 0.6,
      retestToleranceAtr: 0.2,
      confirmBars: 2,
      morningNoiseWindowMinutes: 20,
      afternoonNoiseWindowMinutes: 15,
    },
    pmContinuationRules: {
      amMoveZMin: 0.8,
      middayHoldMin: 0.6,
      pmReExpansionTrendScoreMin: 0.9,
      pmReExpansionEr15Min: 0.35,
      pmConfirmCutoffMinutes: 13 * 60 + 30,
    },
    instrumentAdaptationRules: {
      bullBuyMinDistancePct: 0.35,
      bearBuyMaxDistancePct: -0.35,
      bullLiquidationDistancePct: 0.3,
      bearLiquidationDistancePct: -0.3,
      autoSearchOpenDelayMinutes: 5,
      autoSearchPrimaryDistanceBull: 0.8,
      autoSearchPrimaryDistanceBear: -0.8,
      switchDistanceRangeBull: [0.6, 1.5],
      switchDistanceRangeBear: [-1.5, -0.6],
      autoSearchMinTurnoverPerMinuteBull: 300000,
      autoSearchMinTurnoverPerMinuteBear: 300000,
      autoSearchExpiryMinMonths: 6,
    },
  };
}

/**
 * 构造运行时配置，供测试或 Mock 使用；未传字段使用默认监控/风控参数。
 */
export function createStrategyRuntimeConfig(
  overrides: Partial<StrategyRuntimeConfig> = {},
): StrategyRuntimeConfig {
  return {
    baseInstrumentSymbol: 'HSI.HK',
    longSymbol: 'BULL.HK',
    shortSymbol: 'BEAR.HK',
    autoSearchConfig: {
      autoSearchEnabled: false,
      autoSearchMinDistancePctBull: null,
      autoSearchMinDistancePctBear: null,
      autoSearchMinTurnoverPerMinuteBull: null,
      autoSearchMinTurnoverPerMinuteBear: null,
      autoSearchExpiryMinMonths: 3,
      autoSearchOpenDelayMinutes: 5,
      switchIntervalMinutes: 0,
      switchDistanceRangeBull: null,
      switchDistanceRangeBear: null,
    },

    orderOwnershipMapping: ['HSI'],
    targetNotional: 5000,
    maxPositionNotional: 50000,
    maxUnrealizedLossPerSymbol: 2000,
    buyIntervalSeconds: 60,
    liquidationCooldown: null,
    liquidationTriggerLimit: 1,
    seatMode: 'static',
    strategyConfig: createStrategyThresholdConfig(),
    ...overrides,
  };
}

/**
 * 构造全局交易配置，供测试或 Mock 使用；未传字段使用默认全局参数。
 */
export function createGlobalConfig(overrides: Partial<GlobalConfig> = {}): GlobalConfig {
  return {
    doomsdayProtection: true,
    debug: false,
    openProtection: {
      morning: {
        enabled: false,
        minutes: null,
      },
      afternoon: {
        enabled: false,
        minutes: null,
      },
    },
    orderMonitorPriceUpdateInterval: 1,
    allowBuyOrderTrackingAboveInitialPrice: true,
    tradingOrderType: 'ELO',
    liquidationOrderType: 'MO',
    buyOrderTimeout: {
      enabled: true,
      timeoutSeconds: 180,
    },
    sellOrderTimeout: {
      enabled: true,
      timeoutSeconds: 180,
    },
    ...overrides,
  };
}

/**
 * 构造交易配置测试夹具，供 app/main/lifecycle 测试使用。
 */
export function createTradingConfigFixture(overrides: Partial<TradingConfig> = {}): TradingConfig {
  const monitorConfig = createStrategyRuntimeConfig();
  return {
    baseInstrument: monitorConfig.baseInstrumentSymbol,
    global: createGlobalConfig(),
    strategy: {
      seatMode: 'static',
      longSymbol: monitorConfig.longSymbol,
      shortSymbol: monitorConfig.shortSymbol,
      autoSearchConfig: monitorConfig.autoSearchConfig,
      orderOwnershipMapping: monitorConfig.orderOwnershipMapping,
      targetNotional: monitorConfig.targetNotional,
      maxPositionNotional: monitorConfig.maxPositionNotional,
      maxUnrealizedLoss: monitorConfig.maxUnrealizedLossPerSymbol,
      buyIntervalSeconds: monitorConfig.buyIntervalSeconds,
      liquidationCooldown: monitorConfig.liquidationCooldown,
      liquidationTriggerLimit: monitorConfig.liquidationTriggerLimit,
      regimeThresholds: {
        atrShortPeriod: 14,
        atrLongPeriod: 60,
        rvQuantileWindowDays: 20,
        trendOnVolExpansion: 1.2,
        trendOffVolExpansion: 0.9,
        extremeVolExpansion: 1.8,
        trendOnVolQuantile: 0.7,
        trendOffVolQuantile: 0.5,
        extremeVolQuantile: 0.95,
      },
      trendScoreThresholds: {
        w15: 0.3,
        w30: 0.3,
        w60: 0.4,
        classificationThreshold: 0.4,
        entryThreshold: 0.6,
        exitThreshold: 0.2,
        reverseInvalidationThreshold: 0.3,
      },
      erThresholds: {
        er15EntryMin: 0.35,
        er30EntryMin: 0.3,
        er15ExitMax: 0.15,
        er30ExitMax: 0.1,
        strongTrendErFloor: 0.45,
      },
      vwapConfirmRules: {
        distanceBandAtr: 0.6,
        slopeWindowBars: 5,
        maxCrossCountLast10m: 2,
      },
      openingStructureRules: {
        openingRangeMinutes: 30,
        breakoutScoreMin: 1.2,
        outsidePersistenceWindowBars: 5,
        outsidePersistenceMin: 0.6,
        retestToleranceAtr: 0.3,
        confirmBars: 2,
        morningNoiseWindowMinutes: 20,
        afternoonNoiseWindowMinutes: 15,
      },
      pmContinuationRules: {
        amMoveZMin: 1.2,
        middayHoldMin: 0.5,
        pmReExpansionTrendScoreMin: 0.6,
        pmReExpansionEr15Min: 0.35,
        pmConfirmCutoffTime: '14:30',
      },
      instrumentAdaptationRules: {
        bullBuyMinDistancePct: 0.35,
        bearBuyMaxDistancePct: -0.35,
        bullLiquidationDistancePct: 0.2,
        bearLiquidationDistancePct: -0.2,
      },
    },
    ...overrides,
  };
}

/**
 * 基于运行时配置构造 TradingConfig，便于 app/main 测试在保留 runtimeConfig 的同时使用新配置根对象。
 */
export function createTradingConfigFixtureFromRuntimeConfig(
  runtimeConfig: StrategyRuntimeConfig,
  overrides: Partial<TradingConfig> = {},
): TradingConfig {
  const baseConfig = createTradingConfigFixture();
  return {
    ...baseConfig,
    baseInstrument: runtimeConfig.baseInstrumentSymbol,
    strategy: {
      ...baseConfig.strategy,
      seatMode: runtimeConfig.seatMode,
      longSymbol: runtimeConfig.longSymbol || null,
      shortSymbol: runtimeConfig.shortSymbol || null,
      autoSearchConfig: runtimeConfig.autoSearchConfig,
      orderOwnershipMapping: runtimeConfig.orderOwnershipMapping,
      targetNotional: runtimeConfig.targetNotional,
      maxPositionNotional: runtimeConfig.maxPositionNotional,
      maxUnrealizedLoss: runtimeConfig.maxUnrealizedLossPerSymbol,
      buyIntervalSeconds: runtimeConfig.buyIntervalSeconds,
      liquidationCooldown: runtimeConfig.liquidationCooldown,
      liquidationTriggerLimit: runtimeConfig.liquidationTriggerLimit,
    },
    ...overrides,
  };
}
