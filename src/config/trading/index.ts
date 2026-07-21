/**
 * trading 配置模块。
 *
 * 负责解析唯一 monitor/global 两级交易配置。
 */
import type { TradingConfig } from '../../types/config.js';
import { createConfigValidationError, getBooleanConfig, getNumberConfig } from '../utils.js';
import {
  parseFailFastBoundedNumberConfig,
  parseMonitorConfig,
  parseTradingOrderType,
} from './utils.js';

/**
 * 解析唯一监控标的配置。
 * @param params.env 进程环境变量对象
 * @returns 单 monitor 交易配置
 */
export function createTradingConfig({ env }: { env: NodeJS.ProcessEnv }): TradingConfig {
  const monitor = parseMonitorConfig(env);
  if (monitor === null) {
    throw createConfigValidationError('[配置错误] MONITOR_SYMBOL 未配置');
  }

  const buyOrderTimeoutEnabled = getBooleanConfig(env, 'BUY_ORDER_TIMEOUT_ENABLED', true);
  const buyOrderTimeoutSeconds = buyOrderTimeoutEnabled
    ? parseFailFastBoundedNumberConfig({
        env,
        envKey: 'BUY_ORDER_TIMEOUT_SECONDS',
        defaultValue: 180,
        min: 30,
        max: 600,
      })
    : 180;
  const sellOrderTimeoutEnabled = getBooleanConfig(env, 'SELL_ORDER_TIMEOUT_ENABLED', true);
  const sellOrderTimeoutSeconds = sellOrderTimeoutEnabled
    ? parseFailFastBoundedNumberConfig({
        env,
        envKey: 'SELL_ORDER_TIMEOUT_SECONDS',
        defaultValue: 180,
        min: 30,
        max: 600,
      })
    : 180;
  const orderMonitorPriceUpdateInterval = parseFailFastBoundedNumberConfig({
    env,
    envKey: 'ORDER_MONITOR_PRICE_UPDATE_INTERVAL',
    defaultValue: 5,
    min: 1,
    max: 60,
  });
  const allowBuyOrderTrackingAboveInitialPrice = getBooleanConfig(
    env,
    'ALLOW_BUY_ORDER_TRACKING_ABOVE_INITIAL_PRICE',
    true,
  );
  const morningOpenProtectionEnabled = getBooleanConfig(
    env,
    'MORNING_OPENING_PROTECTION_ENABLED',
    false,
  );
  const morningOpenProtectionMinutes = getNumberConfig(
    env,
    'MORNING_OPENING_PROTECTION_MINUTES',
    0,
  );
  const afternoonOpenProtectionEnabled = getBooleanConfig(
    env,
    'AFTERNOON_OPENING_PROTECTION_ENABLED',
    false,
  );
  const afternoonOpenProtectionMinutes = getNumberConfig(
    env,
    'AFTERNOON_OPENING_PROTECTION_MINUTES',
    0,
  );
  const tradingOrderType = parseTradingOrderType(env, 'TRADING_ORDER_TYPE', 'ELO');
  const liquidationOrderType = parseTradingOrderType(env, 'LIQUIDATION_ORDER_TYPE', 'MO');

  return {
    monitor,
    global: {
      doomsdayProtection: getBooleanConfig(env, 'DOOMSDAY_PROTECTION', true),
      debug: getBooleanConfig(env, 'DEBUG', false),
      openProtection: {
        morning: {
          enabled: morningOpenProtectionEnabled,
          minutes: morningOpenProtectionMinutes,
        },
        afternoon: {
          enabled: afternoonOpenProtectionEnabled,
          minutes: afternoonOpenProtectionMinutes,
        },
      },
      orderMonitorPriceUpdateInterval,
      allowBuyOrderTrackingAboveInitialPrice,
      tradingOrderType,
      liquidationOrderType,
      buyOrderTimeout: {
        enabled: buyOrderTimeoutEnabled,
        timeoutSeconds: buyOrderTimeoutSeconds,
      },
      sellOrderTimeout: {
        enabled: sellOrderTimeoutEnabled,
        timeoutSeconds: sellOrderTimeoutSeconds,
      },
    },
  };
}
