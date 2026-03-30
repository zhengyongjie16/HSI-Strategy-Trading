import type { OrderType } from 'longbridge';
import { ORDER_TYPE_CONFIG_TO_OPEN_API, SYMBOL_WITH_REGION_REGEX } from '../constants/index.js';
import type { LiquidationCooldownConfig, NumberRange } from '../types/config.js';
import type { OrderTypeConfig } from '../types/signal.js';
import { logger } from '../utils/logger/index.js';
import type { ConfigValidationError } from './types.js';

/**
 * 创建配置验证错误对象。
 *
 * @param message 错误消息
 * @param missingFields 缺失或非法的字段列表
 * @returns 带 `name` 与 `missingFields` 的 ConfigValidationError
 */
export function createConfigValidationError(
  message: string,
  missingFields: ReadonlyArray<string> = [],
): ConfigValidationError {
  return Object.assign(new Error(message), {
    name: 'ConfigValidationError' as const,
    missingFields,
  });
}

/**
 * 判断配置值是否仍是模板占位符。
 *
 * @param value 原始配置值
 * @param envKey 环境变量键名
 * @returns true 表示该值仍是占位符，不应视为有效配置
 */
function isPlaceholderConfigValue(value: string, envKey: string): boolean {
  const normalizedValue = value.trim();
  const normalizedKey = envKey.toLowerCase();
  return (
    normalizedValue === `your_${normalizedKey}` || normalizedValue === `your_${normalizedKey}_here`
  );
}

/**
 * 读取字符串配置，未设置、空串或模板占位符（形如 your_xxx / your_xxx_here）时返回 null。
 *
 * @param env 进程环境变量对象
 * @param envKey 环境变量键名
 * @returns 去除首尾空白后的字符串，或 null
 */
export function getStringConfig(env: NodeJS.ProcessEnv, envKey: string): string | null {
  const value = env[envKey];
  if (!value || value.trim() === '' || isPlaceholderConfigValue(value, envKey)) {
    return null;
  }

  return value.trim();
}

/**
 * 读取数字配置，未设置、非有限数或小于最小值时返回 null。
 *
 * @param env 进程环境变量对象
 * @param envKey 环境变量键名
 * @param minValue 允许的最小值，默认为 0
 * @returns 解析后的数字，或 null
 */
export function getNumberConfig(
  env: NodeJS.ProcessEnv,
  envKey: string,
  minValue: number = 0,
): number | null {
  const value = env[envKey];
  if (!value || value.trim() === '') {
    return null;
  }

  const num = Number(value);
  if (!Number.isFinite(num) || num < minValue) {
    return null;
  }

  return num;
}

/**
 * 读取布尔配置，仅识别 'true'/'false'，其他值返回默认值。
 *
 * @param env 进程环境变量对象
 * @param envKey 环境变量键名
 * @param defaultValue 未设置或无法识别时的默认值，默认为 false
 * @returns 解析后的布尔值
 */
export function getBooleanConfig(
  env: NodeJS.ProcessEnv,
  envKey: string,
  defaultValue: boolean = false,
): boolean {
  const value = env[envKey];
  if (value === undefined || value.trim() === '') {
    return defaultValue;
  }

  const normalizedValue = value.trim().toLowerCase();
  if (normalizedValue === 'true') {
    return true;
  }

  if (normalizedValue === 'false') {
    return false;
  }

  return defaultValue;
}

/**
 * 解析保护性清仓冷却配置，支持 minutes / half-day / one-day 三种模式。
 *
 * @param env 进程环境变量对象
 * @param envKey 环境变量键名
 * @returns 解析后的冷却配置对象，无效或未设置时返回 null
 */
export function parseLiquidationCooldownConfig(
  env: NodeJS.ProcessEnv,
  envKey: string,
): LiquidationCooldownConfig | null {
  const value = getStringConfig(env, envKey);
  if (!value) {
    return null;
  }

  const normalizedValue = value.trim().toLowerCase();
  if (normalizedValue === 'half-day') {
    return { mode: 'half-day' };
  }

  if (normalizedValue === 'one-day') {
    return { mode: 'one-day' };
  }

  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 120) {
    return null;
  }

  return { mode: 'minutes', minutes };
}

/**
 * 解析数值范围配置，格式为 "min,max"。
 *
 * @param env 进程环境变量对象
 * @param envKey 环境变量键名
 * @returns 解析后的 NumberRange 对象，格式无效或未设置时返回 null
 */
export function parseNumberRangeConfig(env: NodeJS.ProcessEnv, envKey: string): NumberRange | null {
  const value = getStringConfig(env, envKey);
  if (!value) {
    return null;
  }

  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  if (parts.length !== 2) {
    logger.warn(`[配置警告] ${envKey} 格式无效，必须为 "min,max"`);
    return null;
  }

  const min = Number(parts[0]);
  const max = Number(parts[1]);

  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    logger.warn(`[配置警告] ${envKey} 格式无效，min/max 必须为数字`);
    return null;
  }

  if (min > max) {
    logger.warn(`[配置警告] ${envKey} 格式无效，min 不能大于 max`);
    return null;
  }

  return { min, max };
}

/**
 * 解析订单归属映射，从逗号分隔的缩写列表中提取唯一缩写，按长度降序排列。
 *
 * @param env 进程环境变量对象
 * @param envKey 环境变量键名
 * @returns 去重并排序后的缩写数组，未设置或为空时返回空数组
 */
export function parseOrderOwnershipMapping(
  env: NodeJS.ProcessEnv,
  envKey: string,
): ReadonlyArray<string> {
  const value = getStringConfig(env, envKey);
  if (!value) {
    return [];
  }

  const items = value
    .split(',')
    .map((item) => item.trim().toUpperCase())
    .filter((item) => item !== '');

  if (items.length === 0) {
    logger.warn(`[配置警告] ${envKey} 未包含有效缩写`);
    return [];
  }

  const uniqueItems = [...new Set(items)];
  uniqueItems.sort((a, b) => b.length - a.length || a.localeCompare(b));

  return uniqueItems;
}

/**
 * 判断标的代码格式是否为 ticker.region。
 *
 * @param symbol 标的代码，例如 "68547.HK"
 * @returns 符合 ticker.region 格式时返回 true，否则返回 false
 */
export function isSymbolWithRegion(symbol: string | null | undefined): symbol is string {
  if (!symbol || typeof symbol !== 'string') {
    return false;
  }

  return SYMBOL_WITH_REGION_REGEX.test(symbol);
}

/**
 * 类型保护：判断字符串是否为受支持的订单类型配置代码。
 *
 * @param value 待判断的字符串
 * @returns true 表示值属于 OrderTypeConfig
 */
function isOrderTypeConfig(value: string): value is OrderTypeConfig {
  return Object.hasOwn(ORDER_TYPE_CONFIG_TO_OPEN_API, value);
}

/**
 * 解析订单类型配置（LO/ELO/MO），必须大写，无效时回退默认值。
 *
 * @param env 进程环境变量对象
 * @param envKey 环境变量键名
 * @param defaultType 无效或未设置时的默认订单类型，默认为 'ELO'
 * @returns 对应的 OrderType 枚举值
 */
export function parseOrderTypeConfig(
  env: NodeJS.ProcessEnv,
  envKey: string,
  defaultType: OrderTypeConfig = 'ELO',
): OrderType {
  const value = getStringConfig(env, envKey);
  if (value) {
    if (isOrderTypeConfig(value)) {
      return ORDER_TYPE_CONFIG_TO_OPEN_API[value];
    }

    logger.warn(
      `[配置警告] ${envKey} 值无效: ${value}，必须使用全大写: LO, ELO, MO。已使用默认值: ${defaultType}`,
    );
  }

  return ORDER_TYPE_CONFIG_TO_OPEN_API[defaultType];
}
