import type { OrderType } from 'longbridge';
import type { MonitorConfig } from '../../types/config.js';
import type { OrderTypeConfig } from '../../types/signal.js';
import type { SignalConfig } from '../../types/signalConfig.js';
import { logger } from '../../utils/logger/index.js';
import { OPEN_API_ORDER_TYPE_TO_CONFIG } from '../../constants/index.js';
import {
  createConfigValidationError,
  getBooleanConfig,
  getNumberConfig,
  getStringConfig,
  parseLiquidationCooldownConfig,
  parseNumberRangeConfig,
  parseOrderOwnershipMapping,
  parseOrderTypeConfig,
  parseSignalConfig,
  parseSmartCloseTimeoutMinutesConfig,
  parseVerificationDelay,
  parseVerificationIndicators,
} from '../utils.js';
import type { BoundedNumberConfig, MinimumNumberConfig } from './types.js';

/**
 * 从环境变量解析信号配置字符串，未配置或解析失败时返回 null。
 * @param env 进程环境变量对象
 * @param envKey 环境变量键名
 * @returns 解析后的信号配置，无效时返回 null
 */
function parseSignalConfigFromEnv(env: NodeJS.ProcessEnv, envKey: string): SignalConfig | null {
  const configStr = getStringConfig(env, envKey);
  if (!configStr) {
    return null;
  }

  const config = parseSignalConfig(configStr);
  if (!config) {
    logger.error(`[配置错误] ${envKey} 格式无效`);
    return null;
  }

  return config;
}

/**
 * 解析关键数值配置：未配置时使用默认值，显式配置非法或越界时立即失败。
 * @param options 包含 env、envKey、defaultValue、min、max 的配置对象
 * @returns 合法范围内的数值
 */
export function parseFailFastBoundedNumberConfig({
  env,
  envKey,
  defaultValue,
  min,
  max,
}: BoundedNumberConfig): number {
  const raw = env[envKey];
  if (raw === undefined || raw.trim() === '') {
    return defaultValue;
  }

  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw createConfigValidationError(
      `[配置错误] ${envKey} 无效（必须为数字，范围 ${min}-${max}）`,
    );
  }

  return value;
}

/**
 * 解析关键整数配置：未配置时使用默认值，显式配置非法、非整数或越界时立即失败。
 * @param options 包含 env、envKey、defaultValue、min、max 的配置对象
 * @returns 合法范围内的整数数值
 */
function parseFailFastIntegerBoundedNumberConfig({
  env,
  envKey,
  defaultValue,
  min,
  max,
}: BoundedNumberConfig): number {
  const raw = env[envKey];
  if (raw === undefined || raw.trim() === '') {
    return defaultValue;
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw createConfigValidationError(
      `[配置错误] ${envKey} 无效（必须为整数，范围 ${min}-${max}）`,
    );
  }

  return value;
}

/**
 * 解析关键数值配置：未配置时使用默认值，显式配置非法或小于下限时立即失败。
 * @param options 包含 env、envKey、defaultValue、min 的配置对象
 * @returns 大于等于 min 的合法数值
 */
function parseFailFastMinimumNumberConfig({
  env,
  envKey,
  defaultValue,
  min,
}: MinimumNumberConfig): number {
  const raw = env[envKey];
  if (raw === undefined || raw.trim() === '') {
    return defaultValue;
  }

  const value = Number(raw);
  if (!Number.isFinite(value) || value < min) {
    throw createConfigValidationError(`[配置错误] ${envKey} 无效（必须为数字且 >= ${min}）`);
  }

  return value;
}

/**
 * 读取百分比值配置并保持运行时口径不变。
 * @param env 进程环境变量对象
 * @param envKey 环境变量键名
 * @param minValue 允许的最小原始数值
 * @returns 百分比值或 null
 */
function getPercentValueConfig(
  env: NodeJS.ProcessEnv,
  envKey: string,
  minValue: number = 0,
): number | null {
  return getNumberConfig(env, envKey, minValue);
}

/**
 * 将 OpenAPI 订单类型映射为内部订单类型配置。
 * @param orderType OpenAPI 订单类型
 * @returns 内部订单类型配置
 */
function mapOrderTypeConfig(orderType: OrderType): OrderTypeConfig {
  const mappedConfig = OPEN_API_ORDER_TYPE_TO_CONFIG[orderType];
  if (mappedConfig === undefined) {
    throw new Error(`[TradingConfig] 未知 OpenAPI 订单类型: ${String(orderType)}`);
  }

  return mappedConfig;
}

/**
 * 解析唯一监控标的配置。
 * @param env 进程环境变量对象
 * @returns 解析后的监控配置，未配置时返回 null
 */
export function parseMonitorConfig(env: NodeJS.ProcessEnv): MonitorConfig | null {
  const monitorSymbol = getStringConfig(env, 'MONITOR_SYMBOL');
  if (!monitorSymbol) {
    return null;
  }

  const longSymbol = getStringConfig(env, 'LONG_SYMBOL') ?? '';
  const shortSymbol = getStringConfig(env, 'SHORT_SYMBOL') ?? '';
  const autoSearchEnabled = getBooleanConfig(env, 'AUTO_SEARCH_ENABLED', false);
  const autoSearchMinDistancePctBull = getPercentValueConfig(
    env,
    'AUTO_SEARCH_MIN_DISTANCE_PCT_BULL',
    0,
  );
  const autoSearchMinDistancePctBear = getPercentValueConfig(
    env,
    'AUTO_SEARCH_MIN_DISTANCE_PCT_BEAR',
    -100,
  );
  const autoSearchMinTurnoverPerMinuteBull = getNumberConfig(
    env,
    'AUTO_SEARCH_MIN_TURNOVER_PER_MINUTE_BULL',
    0,
  );
  const autoSearchMinTurnoverPerMinuteBear = getNumberConfig(
    env,
    'AUTO_SEARCH_MIN_TURNOVER_PER_MINUTE_BEAR',
    0,
  );
  const autoSearchExpiryMinMonths = parseFailFastBoundedNumberConfig({
    env,
    envKey: 'AUTO_SEARCH_EXPIRY_MIN_MONTHS',
    defaultValue: 3,
    min: 1,
    max: 120,
  });
  const autoSearchOpenDelayMinutes = parseFailFastBoundedNumberConfig({
    env,
    envKey: 'AUTO_SEARCH_OPEN_DELAY_MINUTES',
    defaultValue: 5,
    min: 0,
    max: 60,
  });
  const switchIntervalMinutes = autoSearchEnabled
    ? parseFailFastBoundedNumberConfig({
        env,
        envKey: 'SWITCH_INTERVAL_MINUTES',
        defaultValue: 0,
        min: 0,
        max: 120,
      })
    : 0;
  const switchDistanceRangeBull = parseNumberRangeConfig(env, 'SWITCH_DISTANCE_RANGE_BULL');
  const switchDistanceRangeBear = parseNumberRangeConfig(env, 'SWITCH_DISTANCE_RANGE_BEAR');
  const orderOwnershipMapping = parseOrderOwnershipMapping(env, 'ORDER_OWNERSHIP_MAPPING');
  const targetNotional = parseFailFastMinimumNumberConfig({
    env,
    envKey: 'TARGET_NOTIONAL',
    defaultValue: 10000,
    min: 1,
  });
  const maxPositionNotional = parseFailFastMinimumNumberConfig({
    env,
    envKey: 'MAX_POSITION_NOTIONAL',
    defaultValue: 100000,
    min: 1,
  });
  const maxUnrealizedLossPerSymbol = parseFailFastMinimumNumberConfig({
    env,
    envKey: 'MAX_UNREALIZED_LOSS_PER_SYMBOL',
    defaultValue: 0,
    min: 0,
  });
  const buyIntervalSeconds = parseFailFastBoundedNumberConfig({
    env,
    envKey: 'BUY_INTERVAL_SECONDS',
    defaultValue: 60,
    min: 10,
    max: 600,
  });
  const liquidationCooldown = parseLiquidationCooldownConfig(env, 'LIQUIDATION_COOLDOWN_MINUTES');
  const liquidationTriggerLimit = parseFailFastIntegerBoundedNumberConfig({
    env,
    envKey: 'LIQUIDATION_TRIGGER_LIMIT',
    defaultValue: 1,
    min: 1,
    max: 10,
  });
  const verificationConfig = {
    buy: {
      delaySeconds: parseVerificationDelay(env, 'VERIFICATION_DELAY_SECONDS_BUY', 60),
      indicators: parseVerificationIndicators(env, 'VERIFICATION_INDICATORS_BUY'),
    },
    sell: {
      delaySeconds: parseVerificationDelay(env, 'VERIFICATION_DELAY_SECONDS_SELL', 60),
      indicators: parseVerificationIndicators(env, 'VERIFICATION_INDICATORS_SELL'),
    },
  };
  const smartCloseEnabled = getBooleanConfig(env, 'SMART_CLOSE_ENABLED', true);
  const smartCloseTimeoutMinutes = parseSmartCloseTimeoutMinutesConfig(
    env,
    'SMART_CLOSE_TIMEOUT_MINUTES',
  );
  const signalConfig = {
    buycall: parseSignalConfigFromEnv(env, 'SIGNAL_BUYCALL'),
    sellcall: parseSignalConfigFromEnv(env, 'SIGNAL_SELLCALL'),
    buyput: parseSignalConfigFromEnv(env, 'SIGNAL_BUYPUT'),
    sellput: parseSignalConfigFromEnv(env, 'SIGNAL_SELLPUT'),
  };

  return {
    monitorSymbol,
    longSymbol,
    shortSymbol,
    autoSearchConfig: {
      autoSearchEnabled,
      autoSearchMinDistancePctBull,
      autoSearchMinDistancePctBear,
      autoSearchMinTurnoverPerMinuteBull,
      autoSearchMinTurnoverPerMinuteBear,
      autoSearchExpiryMinMonths,
      autoSearchOpenDelayMinutes,
      switchIntervalMinutes,
      switchDistanceRangeBull,
      switchDistanceRangeBear,
    },
    orderOwnershipMapping,
    targetNotional,
    maxPositionNotional,
    maxUnrealizedLossPerSymbol,
    buyIntervalSeconds,
    liquidationCooldown,
    liquidationTriggerLimit,
    verificationConfig,
    signalConfig,
    smartCloseEnabled,
    smartCloseTimeoutMinutes,
  };
}

/**
 * 解析交易订单类型配置。
 * @param env 进程环境变量对象
 * @param envKey 环境变量键名
 * @param defaultType 默认订单类型
 * @returns 内部订单类型配置
 */
export function parseTradingOrderType(
  env: NodeJS.ProcessEnv,
  envKey: string,
  defaultType: OrderTypeConfig,
): OrderTypeConfig {
  return mapOrderTypeConfig(parseOrderTypeConfig(env, envKey, defaultType));
}
