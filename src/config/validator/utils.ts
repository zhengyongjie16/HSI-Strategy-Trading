import { logger } from '../../utils/logger/index.js';
import { validateLongbridgeConfig } from '../auth/utils.js';
import { isSymbolWithRegion } from '../utils.js';
import type { LiquidationCooldownConfig, NumberRange } from '../../types/config.js';
import type { Quote } from '../../types/quote.js';
import type { SymbolValidationContext, ValidationResult } from './types.js';

/**
 * 生成标的代码格式错误提示信息。
 *
 * @param prefix 配置项前缀
 * @param envKey 环境变量键名
 * @param symbol 当前配置的标的代码
 * @returns 格式化错误提示
 */
export function formatSymbolFormatError(prefix: string, envKey: string, symbol: string): string {
  return `${prefix}: ${envKey} 必须使用 ticker.region 格式（如 68711.HK），当前值: ${symbol}`;
}

/**
 * 将清仓冷却配置格式化为可读字符串。
 *
 * @param config 清仓冷却配置
 * @returns 可读描述
 */
export function formatLiquidationCooldownConfig(config: LiquidationCooldownConfig | null): string {
  if (!config) {
    return '未配置（不冷却）';
  }

  if (config.mode === 'minutes') {
    return `${config.minutes} 分钟`;
  }

  return config.mode;
}

/**
 * 将数值范围格式化为可读字符串。
 *
 * @param range 数值范围
 * @returns 可读描述
 */
export function formatNumberRange(range: NumberRange | null): string {
  if (!range) {
    return '未配置';
  }

  return `${range.min},${range.max}`;
}

/**
 * 验证必填标的代码是否已配置且格式正确。
 *
 * @param context 标的校验上下文
 * @returns 更新后的错误与缺失字段集合
 */
export function validateRequiredSymbol({
  prefix,
  symbol,
  envKey,
  errors,
  missingFields,
}: SymbolValidationContext): Readonly<{
  errors: ReadonlyArray<string>;
  missingFields: ReadonlyArray<string>;
}> {
  if (!symbol || symbol.trim() === '') {
    return {
      errors: [...errors, `${prefix}: ${envKey} 未配置`],
      missingFields: [...missingFields, envKey],
    };
  }

  if (!isSymbolWithRegion(symbol)) {
    return {
      errors: [...errors, formatSymbolFormatError(prefix, envKey, symbol)],
      missingFields,
    };
  }

  return { errors, missingFields };
}

/**
 * 验证自动寻标的主阈值与换标区间、静态风控阈值的关系。
 *
 * @param params 校验参数
 * @returns 错误文案或 null
 */
export function validateAutoSearchRangeRelationship(params: {
  readonly prefix: string;
  readonly direction: 'LONG' | 'SHORT';
  readonly primaryThreshold: number;
  readonly switchDistanceRange: NumberRange;
  readonly liquidationThreshold: number;
}): string | null {
  if (params.direction === 'LONG') {
    if (params.switchDistanceRange.min >= params.primaryThreshold) {
      return (
        `${params.prefix}: SWITCH_DISTANCE_RANGE_BULL 无效（换标区间必须满足 ` +
        `SWITCH_DISTANCE_RANGE_BULL.min < AUTO_SEARCH_MIN_DISTANCE_PCT_BULL < ` +
        `SWITCH_DISTANCE_RANGE_BULL.max）`
      );
    }

    if (params.primaryThreshold >= params.switchDistanceRange.max) {
      return (
        `${params.prefix}: SWITCH_DISTANCE_RANGE_BULL 无效（换标区间必须满足 ` +
        `SWITCH_DISTANCE_RANGE_BULL.min < AUTO_SEARCH_MIN_DISTANCE_PCT_BULL < ` +
        `SWITCH_DISTANCE_RANGE_BULL.max）`
      );
    }

    if (params.liquidationThreshold >= params.switchDistanceRange.min) {
      return (
        `${params.prefix}: SWITCH_DISTANCE_RANGE_BULL 无效（换标区间危险侧必须早于 ` +
        `INSTRUMENT_ADAPTATION_RULES_BULL_LIQUIDATION_DISTANCE_PCT）`
      );
    }

    return null;
  }

  if (params.switchDistanceRange.min >= params.primaryThreshold) {
    return (
      `${params.prefix}: SWITCH_DISTANCE_RANGE_BEAR 无效（换标区间必须满足 ` +
      `SWITCH_DISTANCE_RANGE_BEAR.min < AUTO_SEARCH_MIN_DISTANCE_PCT_BEAR < ` +
      `SWITCH_DISTANCE_RANGE_BEAR.max）`
    );
  }

  if (params.primaryThreshold >= params.switchDistanceRange.max) {
    return (
      `${params.prefix}: SWITCH_DISTANCE_RANGE_BEAR 无效（换标区间必须满足 ` +
      `SWITCH_DISTANCE_RANGE_BEAR.min < AUTO_SEARCH_MIN_DISTANCE_PCT_BEAR < ` +
      `SWITCH_DISTANCE_RANGE_BEAR.max）`
    );
  }

  if (params.liquidationThreshold <= params.switchDistanceRange.max) {
    return (
      `${params.prefix}: SWITCH_DISTANCE_RANGE_BEAR 无效（换标区间危险侧必须早于 ` +
      `INSTRUMENT_ADAPTATION_RULES_BEAR_LIQUIDATION_DISTANCE_PCT）`
    );
  }

  return null;
}

/**
 * 验证 Longbridge 认证启动配置是否已配置且合法。
 *
 * @param env 进程环境变量
 * @returns 验证结果
 */
export function validateLongbridgeAuthConfig(env: NodeJS.ProcessEnv): ValidationResult {
  const issues = validateLongbridgeConfig(env);

  return {
    valid: issues.length === 0,
    errors: issues.map((issue) => issue.message),
    missingFields: issues.map((issue) => issue.envKey),
  };
}

/**
 * 校验显式配置的关键数值是否是指定范围内的有限数字。
 *
 * @param options 校验参数
 * @returns 缺失时返回 null；显式配置但非法时返回错误信息
 */
export function validateCriticalBoundedNumberConfig({
  env,
  envKey,
  min,
  max,
}: {
  readonly env: NodeJS.ProcessEnv;
  readonly envKey: string;
  readonly min: number;
  readonly max: number;
}): string | null {
  const raw = env[envKey];
  if (raw === undefined || raw.trim() === '') {
    return null;
  }

  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    return `${envKey} 无效（必须为数字，范围 ${min}-${max}）`;
  }

  return null;
}

/**
 * 校验显式配置的关键数值是否是大于等于下限的有限数字。
 *
 * @param options 校验参数
 * @returns 缺失时返回 null；显式配置但非法时返回错误信息
 */
export function validateCriticalMinimumNumberConfig({
  env,
  envKey,
  min,
}: {
  readonly env: NodeJS.ProcessEnv;
  readonly envKey: string;
  readonly min: number;
}): string | null {
  const raw = env[envKey];
  if (raw === undefined || raw.trim() === '') {
    return null;
  }

  const value = Number(raw);
  if (!Number.isFinite(value) || value < min) {
    return `${envKey} 无效（必须为数字且 >= ${min}）`;
  }

  return null;
}

/**
 * 从行情数据验证标的有效性。
 *
 * @param quote 标的行情数据
 * @param symbol 标的代码
 * @param symbolLabel 用于错误信息的标签
 * @param requireLotSize 是否要求 lotSize
 * @returns 验证结果
 */
export function validateSymbolFromQuote(
  quote: Quote | null,
  symbol: string,
  symbolLabel: string,
  requireLotSize: boolean = false,
): { readonly valid: boolean; readonly error?: string } {
  if (!quote) {
    return {
      valid: false,
      error: `${symbolLabel} ${symbol} 不存在或无法获取行情数据`,
    };
  }

  const errors: string[] = [];

  if (!quote.name) {
    logger.warn(`${symbolLabel} ${symbol} 缺少中文名称信息`);
  }

  if (requireLotSize && (quote.lotSize === undefined || quote.lotSize <= 0)) {
    errors.push(`${symbolLabel} ${symbol} 缺少每手股数(lotSize)信息，无法进行交易计算`);
  }

  if (errors.length > 0) {
    return {
      valid: false,
      error: errors.join('；'),
    };
  }

  return { valid: true };
}
