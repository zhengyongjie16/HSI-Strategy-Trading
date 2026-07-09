/**
 * Mock 配置工厂
 *
 * 功能：
 * - 提供可覆盖默认值的监控配置与全局交易配置构建能力
 */
import type { MonitorConfig, TradingConfig } from '../../src/types/config.js';
import type { SignalConfig } from '../../src/types/signalConfig.js';

const DEFAULT_SIGNAL_CONFIG: SignalConfig = {
  conditionGroups: [
    {
      conditions: [{ indicator: 'K', operator: '>', threshold: 1 }],
      requiredCount: null,
    },
  ],
};

/**
 * 构造单监控配置，供测试或 Mock 使用；未传字段使用默认监控/风控参数。
 */
export function createMonitorConfig(overrides: Partial<MonitorConfig> = {}): MonitorConfig {
  return {
    monitorSymbol: 'HSI.HK',
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
    verificationConfig: {
      buy: {
        delaySeconds: 60,
        indicators: ['K', 'MACD'],
      },
      sell: {
        delaySeconds: 60,
        indicators: ['K', 'MACD'],
      },
    },
    signalConfig: {
      buycall: DEFAULT_SIGNAL_CONFIG,
      sellcall: DEFAULT_SIGNAL_CONFIG,
      buyput: DEFAULT_SIGNAL_CONFIG,
      sellput: DEFAULT_SIGNAL_CONFIG,
    },
    smartCloseEnabled: true,
    smartCloseTimeoutMinutes: null,
    ...overrides,
  };
}

/**
 * 构造单监控交易配置（含 monitor 与 global），供测试使用；支持部分覆盖。
 */
export function createTradingConfig(overrides: Partial<TradingConfig> = {}): TradingConfig {
  return {
    monitor: createMonitorConfig(),
    global: {
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
    },
    ...overrides,
  };
}
