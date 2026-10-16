import type { Logger } from '../../types/logger.js';
import type { MonitorConfig } from '../../types/config.js';
import type { OrderTypeConfig } from '../../types/signal.js';
import {
  createConfigValidationError,
  getBooleanConfig,
  getFinancialConfig,
  getStringConfig,
  parseLiquidationCooldownConfig,
  parseDecimalRangeConfig,
  parseOrderOwnershipMapping,
  parseOrderTypeConfig,
  parseSmartCloseTimeoutMinutesConfig,
} from '../utils.js';
import type { BoundedNumberConfig } from './types.js';
import { FINANCIAL_CONFIG_DEFAULTS } from '../../constants/financialConfig.js';

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
 * 解析唯一监控标的配置。
 * @param env 进程环境变量对象
 * @returns 解析后的监控配置，未配置时返回 null
 */
export function parseMonitorConfig(logger: Logger, env: NodeJS.ProcessEnv): MonitorConfig | null {
  const monitorSymbol = getStringConfig(env, 'MONITOR_SYMBOL');
  if (!monitorSymbol) {
    return null;
  }

  const longSymbol = getStringConfig(env, 'LONG_SYMBOL') ?? '';
  const shortSymbol = getStringConfig(env, 'SHORT_SYMBOL') ?? '';
  const autoSearchEnabled = getBooleanConfig(env, 'AUTO_SEARCH_ENABLED', false);
  const autoSearchMinDistancePctBull = getFinancialConfig(
    env,
    'AUTO_SEARCH_MIN_DISTANCE_PCT_BULL',
    '0',
    false,
  );
  const autoSearchMinDistancePctBear = getFinancialConfig(
    env,
    'AUTO_SEARCH_MIN_DISTANCE_PCT_BEAR',
    '-100',
    false,
  );
  const autoSearchMinTurnoverPerMinuteBull = getFinancialConfig(
    env,
    'AUTO_SEARCH_MIN_TURNOVER_PER_MINUTE_BULL',
    '0',
    true,
  );
  const autoSearchMinTurnoverPerMinuteBear = getFinancialConfig(
    env,
    'AUTO_SEARCH_MIN_TURNOVER_PER_MINUTE_BEAR',
    '0',
    true,
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
  const switchDistanceRangeBull = parseDecimalRangeConfig(
    logger,
    env,
    'SWITCH_DISTANCE_RANGE_BULL',
  );
  const switchDistanceRangeBear = parseDecimalRangeConfig(
    logger,
    env,
    'SWITCH_DISTANCE_RANGE_BEAR',
  );
  const orderOwnershipMapping = parseOrderOwnershipMapping(logger, env, 'ORDER_OWNERSHIP_MAPPING');
  const targetNotional =
    getFinancialConfig(env, 'TARGET_NOTIONAL', '1', true) ??
    FINANCIAL_CONFIG_DEFAULTS.targetNotional;
  const maxPositionNotional =
    getFinancialConfig(env, 'MAX_POSITION_NOTIONAL', '1', true) ??
    FINANCIAL_CONFIG_DEFAULTS.maxPositionNotional;
  const maxUnrealizedLossPerSymbol =
    getFinancialConfig(env, 'MAX_UNREALIZED_LOSS_PER_SYMBOL', '0', true) ??
    FINANCIAL_CONFIG_DEFAULTS.maxUnrealizedLossPerSymbol;
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
  const smartCloseEnabled = getBooleanConfig(env, 'SMART_CLOSE_ENABLED', true);
  const smartCloseTimeoutMinutes = parseSmartCloseTimeoutMinutesConfig(
    env,
    'SMART_CLOSE_TIMEOUT_MINUTES',
  );
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
  return parseOrderTypeConfig(env, envKey, defaultType);
}
