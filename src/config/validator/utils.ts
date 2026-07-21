import { logger } from '../../utils/logger/index.js';
import type { LiquidationCooldownConfig, MonitorConfig, NumberRange } from '../../types/config.js';
import type { Quote } from '../../types/quote.js';
import {
  getBooleanConfig,
  getStringConfig,
  isSymbolWithRegion,
  parseVerificationIndicators,
} from '../utils.js';
import { validateLongbridgeConfig } from '../auth/utils.js';
import type { SignalConfigKey, SymbolValidationContext, ValidationResult } from './types.js';

const AUTO_SEARCH_DISTANCE_UNIT_HINT =
  'Longbridge warrantList.toCallPrice 原始值会先从小数比值转换为该百分比值口径。';

/**
 * 生成标的代码格式错误提示信息。
 * @param prefix 配置项前缀
 * @param envKey 环境变量键名
 * @param symbol 当前配置的标的代码
 * @returns 格式化错误提示
 */
function formatSymbolFormatError(prefix: string, envKey: string, symbol: string): string {
  return `${prefix}: ${envKey} 必须使用 ticker.region 格式（如 68711.HK），当前值: ${symbol}`;
}

/**
 * 将清仓冷却配置格式化为可读字符串。
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
 * 验证必填标的代码是否已配置且格式正确。
 * @param context 标的校验上下文
 * @returns 更新后的错误集合
 */
function validateRequiredSymbol({
  prefix,
  symbol,
  envKey,
  errors,
}: SymbolValidationContext): Readonly<{
  errors: ReadonlyArray<string>;
}> {
  if (!symbol || symbol.trim() === '') {
    return {
      errors: [...errors, `${prefix}: ${envKey} 未配置`],
    };
  }

  if (!isSymbolWithRegion(symbol)) {
    return {
      errors: [...errors, formatSymbolFormatError(prefix, envKey, symbol)],
    };
  }

  return { errors };
}

/**
 * 校验自动寻标降级区间与主阈值的相对关系。
 * @param params 校验参数
 * @returns 错误文案或 null
 */
function validateDegradedRangeRelationship(params: {
  readonly prefix: string;
  readonly direction: 'LONG' | 'SHORT';
  readonly primaryThreshold: number;
  readonly switchDistanceRange: NumberRange;
}): string | null {
  if (params.direction === 'LONG') {
    if (params.switchDistanceRange.min >= params.primaryThreshold) {
      return (
        `${params.prefix}: SWITCH_DISTANCE_RANGE_BULL 无效（降级区间必须满足 ` +
        `SWITCH_DISTANCE_RANGE_BULL.min < ` +
        `AUTO_SEARCH_MIN_DISTANCE_PCT_BULL，` +
        `运行时单位为百分比值，0.35 表示 0.35%；${AUTO_SEARCH_DISTANCE_UNIT_HINT}）`
      );
    }

    if (params.primaryThreshold >= params.switchDistanceRange.max) {
      return (
        `${params.prefix}: SWITCH_DISTANCE_RANGE_BULL 无效（主阈值必须满足 ` +
        `AUTO_SEARCH_MIN_DISTANCE_PCT_BULL < ` +
        `SWITCH_DISTANCE_RANGE_BULL.max，` +
        `确保自动寻标候选严格位于换标安全区间内部，运行时单位为百分比值，0.35 表示 0.35%；${AUTO_SEARCH_DISTANCE_UNIT_HINT}）`
      );
    }

    return null;
  }

  if (params.switchDistanceRange.min >= params.primaryThreshold) {
    return (
      `${params.prefix}: SWITCH_DISTANCE_RANGE_BEAR 无效（主阈值必须满足 ` +
      `SWITCH_DISTANCE_RANGE_BEAR.min < ` +
      `AUTO_SEARCH_MIN_DISTANCE_PCT_BEAR，` +
      `确保自动寻标候选严格位于换标安全区间内部，运行时单位为百分比值，-0.35 表示 -0.35%；${AUTO_SEARCH_DISTANCE_UNIT_HINT}）`
    );
  }

  if (params.primaryThreshold >= params.switchDistanceRange.max) {
    return (
      `${params.prefix}: SWITCH_DISTANCE_RANGE_BEAR 无效（降级区间必须满足 ` +
      `AUTO_SEARCH_MIN_DISTANCE_PCT_BEAR < ` +
      `SWITCH_DISTANCE_RANGE_BEAR.max，` +
      `运行时单位为百分比值，-0.35 表示 -0.35%；${AUTO_SEARCH_DISTANCE_UNIT_HINT}）`
    );
  }

  return null;
}

/**
 * 验证 Longbridge 认证启动配置是否已配置且合法。
 * @param env 进程环境变量
 * @returns 验证结果
 */
export function validateLongbridgeAuthConfig(env: NodeJS.ProcessEnv): ValidationResult {
  const issues = validateLongbridgeConfig(env);

  return {
    errors: issues.map((issue) => issue.message),
  };
}

/**
 * 校验显式配置的关键数值是否是指定范围内的有限数字。
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
 * @param options 校验参数
 * @returns 缺失时返回 null；显式配置但非法时返回错误信息
 */
function validateCriticalMinimumNumberConfig({
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
 * 校验显式布尔配置只能为 true/false。
 * @param options 校验参数
 * @returns 缺失时返回 null；显式配置但非法时返回错误信息
 */
export function validateExplicitBooleanConfig({
  env,
  envKey,
}: {
  readonly env: NodeJS.ProcessEnv;
  readonly envKey: string;
}): string | null {
  try {
    getBooleanConfig(env, envKey, false);
    return null;
  } catch {
    return `${envKey} 无效（必须为 true 或 false）`;
  }
}

/**
 * 校验显式延迟验证指标配置不能包含非法项。
 * @param options 校验参数
 * @returns 缺失或空列表时返回 null；显式配置但非法时返回错误信息
 */
function validateVerificationIndicatorsConfig({
  env,
  envKey,
}: {
  readonly env: NodeJS.ProcessEnv;
  readonly envKey: string;
}): string | null {
  try {
    parseVerificationIndicators(env, envKey);
    return null;
  } catch {
    return `${envKey} 无效（必须为 K/D/J/MACD/DIF/DEA/ADX/EMA:N/PSY:N）`;
  }
}

/**
 * 从行情数据验证标的有效性。
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

/**
 * 验证唯一监控标的配置完整性。
 * @param config 监控标的配置
 * @param env 进程环境变量
 * @returns 监控标的验证结果
 */
export function validateMonitorConfig(
  config: MonitorConfig,
  env: NodeJS.ProcessEnv,
): ValidationResult {
  let errors: ReadonlyArray<string> = [];
  const prefix = '监控标的';

  const result1 = validateRequiredSymbol({
    prefix,
    symbol: config.monitorSymbol,
    envKey: 'MONITOR_SYMBOL',
    errors,
  });
  errors = result1.errors;

  const autoSearchEnabled = config.autoSearchConfig.autoSearchEnabled;
  const autoSearchEnabledValidationError = validateExplicitBooleanConfig({
    env,
    envKey: 'AUTO_SEARCH_ENABLED',
  });
  if (autoSearchEnabledValidationError !== null) {
    errors = [...errors, `${prefix}: ${autoSearchEnabledValidationError}`];
  }

  if (config.orderOwnershipMapping.length === 0) {
    errors = [
      ...errors,
      `${prefix}: ORDER_OWNERSHIP_MAPPING 未配置或为空（用于 stockName 归属解析）`,
    ];
  }

  if (!autoSearchEnabled) {
    const result2 = validateRequiredSymbol({
      prefix,
      symbol: config.longSymbol,
      envKey: 'LONG_SYMBOL',
      errors,
    });
    errors = result2.errors;

    const result3 = validateRequiredSymbol({
      prefix,
      symbol: config.shortSymbol,
      envKey: 'SHORT_SYMBOL',
      errors,
    });
    errors = result3.errors;
  }

  if (
    config.longSymbol.trim() !== '' &&
    config.shortSymbol.trim() !== '' &&
    config.longSymbol === config.shortSymbol
  ) {
    errors = [...errors, `${prefix}: LONG_SYMBOL 与 SHORT_SYMBOL 不得相同`];
  }

  const targetNotionalEnvKey = 'TARGET_NOTIONAL';
  const targetNotionalValidationError = validateCriticalMinimumNumberConfig({
    env,
    envKey: targetNotionalEnvKey,
    min: 1,
  });
  if (targetNotionalValidationError !== null) {
    errors = [...errors, `${prefix}: ${targetNotionalValidationError}`];
  }

  if (!Number.isFinite(config.targetNotional) || config.targetNotional <= 0) {
    errors = [...errors, `${prefix}: ${targetNotionalEnvKey} 未配置或无效（必须为正数）`];
  }

  const maxPositionNotionalEnvKey = 'MAX_POSITION_NOTIONAL';
  const maxPositionNotionalValidationError = validateCriticalMinimumNumberConfig({
    env,
    envKey: maxPositionNotionalEnvKey,
    min: 1,
  });
  if (maxPositionNotionalValidationError !== null) {
    errors = [...errors, `${prefix}: ${maxPositionNotionalValidationError}`];
  }

  if (!Number.isFinite(config.maxPositionNotional) || config.maxPositionNotional <= 0) {
    errors = [...errors, `${prefix}: ${maxPositionNotionalEnvKey} 未配置或无效（必须为正数）`];
  }

  const maxUnrealizedLossEnvKey = 'MAX_UNREALIZED_LOSS_PER_SYMBOL';
  const maxUnrealizedLossValidationError = validateCriticalMinimumNumberConfig({
    env,
    envKey: maxUnrealizedLossEnvKey,
    min: 0,
  });
  if (maxUnrealizedLossValidationError !== null) {
    errors = [...errors, `${prefix}: ${maxUnrealizedLossValidationError}`];
  }

  if (
    !Number.isFinite(config.maxUnrealizedLossPerSymbol) ||
    config.maxUnrealizedLossPerSymbol < 0
  ) {
    errors = [...errors, `${prefix}: ${maxUnrealizedLossEnvKey} 无效（必须为非负数）`];
  }

  const buyIntervalEnvKey = 'BUY_INTERVAL_SECONDS';
  const buyIntervalValidationError = validateCriticalBoundedNumberConfig({
    env,
    envKey: buyIntervalEnvKey,
    min: 10,
    max: 600,
  });
  if (buyIntervalValidationError !== null) {
    errors = [...errors, `${prefix}: ${buyIntervalValidationError}`];
  }

  if (
    !Number.isFinite(config.buyIntervalSeconds) ||
    config.buyIntervalSeconds < 10 ||
    config.buyIntervalSeconds > 600
  ) {
    errors = [...errors, `${prefix}: ${buyIntervalEnvKey} 无效（范围 10-600）`];
  }

  const liquidationCooldownEnvKey = 'LIQUIDATION_COOLDOWN_MINUTES';
  const configuredCooldown = getStringConfig(env, liquidationCooldownEnvKey);
  const isCooldownParsingFailed = Boolean(configuredCooldown) && !config.liquidationCooldown;
  const isMinutesOutOfRange =
    config.liquidationCooldown?.mode === 'minutes' &&
    (!Number.isFinite(config.liquidationCooldown.minutes) ||
      config.liquidationCooldown.minutes < 1 ||
      config.liquidationCooldown.minutes > 120);
  if (isCooldownParsingFailed || isMinutesOutOfRange) {
    errors = [
      ...errors,
      `${prefix}: ${liquidationCooldownEnvKey} 无效（范围 1-120 或 half-day / one-day）`,
    ];
  }

  const liquidationTriggerLimitValidationError = validateCriticalBoundedNumberConfig({
    env,
    envKey: 'LIQUIDATION_TRIGGER_LIMIT',
    min: 1,
    max: 10,
  });
  if (liquidationTriggerLimitValidationError !== null) {
    errors = [...errors, `${prefix}: ${liquidationTriggerLimitValidationError}`];
  }

  const triggerLimit = config.liquidationTriggerLimit;
  if (!Number.isInteger(triggerLimit) || triggerLimit < 1 || triggerLimit > 10) {
    errors = [...errors, `${prefix}: LIQUIDATION_TRIGGER_LIMIT 无效（必须为整数，范围 1-10）`];
  }

  const verificationDelayEnvKeys = [
    'VERIFICATION_DELAY_SECONDS_BUY',
    'VERIFICATION_DELAY_SECONDS_SELL',
  ] as const;
  for (const envKey of verificationDelayEnvKeys) {
    const verificationDelayValidationError = validateCriticalBoundedNumberConfig({
      env,
      envKey,
      min: 0,
      max: 120,
    });
    if (verificationDelayValidationError !== null) {
      errors = [...errors, `${prefix}: ${verificationDelayValidationError}`];
    }
  }

  const verificationIndicatorEnvKeys = [
    'VERIFICATION_INDICATORS_BUY',
    'VERIFICATION_INDICATORS_SELL',
  ] as const;
  for (const envKey of verificationIndicatorEnvKeys) {
    const verificationIndicatorsValidationError = validateVerificationIndicatorsConfig({
      env,
      envKey,
    });
    if (verificationIndicatorsValidationError !== null) {
      errors = [...errors, `${prefix}: ${verificationIndicatorsValidationError}`];
    }
  }

  const smartCloseEnabledValidationError = validateExplicitBooleanConfig({
    env,
    envKey: 'SMART_CLOSE_ENABLED',
  });
  if (smartCloseEnabledValidationError !== null) {
    errors = [...errors, `${prefix}: ${smartCloseEnabledValidationError}`];
  }

  const smartCloseTimeoutEnvKey = 'SMART_CLOSE_TIMEOUT_MINUTES';
  const smartCloseTimeoutRaw = env[smartCloseTimeoutEnvKey];
  if (smartCloseTimeoutRaw !== undefined) {
    const trimmed = smartCloseTimeoutRaw.trim();
    const isDisabledValue = trimmed === '' || trimmed.toLowerCase() === 'null';
    if (!isDisabledValue) {
      const parsed = Number(trimmed);
      if (!Number.isInteger(parsed) || parsed < 0) {
        errors = [
          ...errors,
          `${prefix}: ${smartCloseTimeoutEnvKey} 无效（必须为非负整数或留空/null）`,
        ];
      }
    }
  }

  const signalConfigKeys: ReadonlyArray<SignalConfigKey> = [
    'buycall',
    'sellcall',
    'buyput',
    'sellput',
  ];
  const signalConfigEnvNames: Record<SignalConfigKey, string> = {
    buycall: 'SIGNAL_BUYCALL',
    sellcall: 'SIGNAL_SELLCALL',
    buyput: 'SIGNAL_BUYPUT',
    sellput: 'SIGNAL_SELLPUT',
  };

  for (const key of signalConfigKeys) {
    const envName = signalConfigEnvNames[key];
    const signalConfig = config.signalConfig[key];
    if (!signalConfig?.conditionGroups || signalConfig.conditionGroups.length === 0) {
      errors = [...errors, `${prefix}: ${envName} 未配置或解析失败（信号配置为必需项）`];
    }
  }

  const autoSearchExpiryValidationError = validateCriticalBoundedNumberConfig({
    env,
    envKey: 'AUTO_SEARCH_EXPIRY_MIN_MONTHS',
    min: 1,
    max: 120,
  });
  if (autoSearchExpiryValidationError !== null) {
    errors = [...errors, `${prefix}: ${autoSearchExpiryValidationError}`];
  }

  if (
    !Number.isFinite(config.autoSearchConfig.autoSearchExpiryMinMonths) ||
    config.autoSearchConfig.autoSearchExpiryMinMonths < 1 ||
    config.autoSearchConfig.autoSearchExpiryMinMonths > 120
  ) {
    errors = [...errors, `${prefix}: AUTO_SEARCH_EXPIRY_MIN_MONTHS 无效（范围 1-120）`];
  }

  const autoSearchOpenDelayValidationError = validateCriticalBoundedNumberConfig({
    env,
    envKey: 'AUTO_SEARCH_OPEN_DELAY_MINUTES',
    min: 0,
    max: 60,
  });
  if (autoSearchOpenDelayValidationError !== null) {
    errors = [...errors, `${prefix}: ${autoSearchOpenDelayValidationError}`];
  }

  if (
    !Number.isFinite(config.autoSearchConfig.autoSearchOpenDelayMinutes) ||
    config.autoSearchConfig.autoSearchOpenDelayMinutes < 0 ||
    config.autoSearchConfig.autoSearchOpenDelayMinutes > 60
  ) {
    errors = [...errors, `${prefix}: AUTO_SEARCH_OPEN_DELAY_MINUTES 无效（范围 0-60）`];
  }

  if (autoSearchEnabled) {
    const autoSearchConfig = config.autoSearchConfig;
    const switchIntervalEnvKey = 'SWITCH_INTERVAL_MINUTES';
    const requiredNumberFields = [
      {
        value: autoSearchConfig.autoSearchMinDistancePctBull,
        envKey: 'AUTO_SEARCH_MIN_DISTANCE_PCT_BULL',
      },
      {
        value: autoSearchConfig.autoSearchMinDistancePctBear,
        envKey: 'AUTO_SEARCH_MIN_DISTANCE_PCT_BEAR',
      },
      {
        value: autoSearchConfig.autoSearchMinTurnoverPerMinuteBull,
        envKey: 'AUTO_SEARCH_MIN_TURNOVER_PER_MINUTE_BULL',
      },
      {
        value: autoSearchConfig.autoSearchMinTurnoverPerMinuteBear,
        envKey: 'AUTO_SEARCH_MIN_TURNOVER_PER_MINUTE_BEAR',
      },
    ] as const;

    for (const field of requiredNumberFields) {
      if (field.value === null || !Number.isFinite(field.value)) {
        errors = [...errors, `${prefix}: ${field.envKey} 未配置或无效`];
      }
    }

    const switchIntervalValidationError = validateCriticalBoundedNumberConfig({
      env,
      envKey: switchIntervalEnvKey,
      min: 0,
      max: 120,
    });
    if (switchIntervalValidationError !== null) {
      errors = [...errors, `${prefix}: ${switchIntervalValidationError}`];
    }

    if (
      !Number.isFinite(autoSearchConfig.switchIntervalMinutes) ||
      autoSearchConfig.switchIntervalMinutes < 0 ||
      autoSearchConfig.switchIntervalMinutes > 120
    ) {
      errors = [...errors, `${prefix}: ${switchIntervalEnvKey} 无效（范围 0-120）`];
    }

    const bullRange = autoSearchConfig.switchDistanceRangeBull;
    if (
      !bullRange ||
      !Number.isFinite(bullRange.min) ||
      !Number.isFinite(bullRange.max) ||
      bullRange.min > bullRange.max
    ) {
      errors = [
        ...errors,
        `${prefix}: SWITCH_DISTANCE_RANGE_BULL 未配置或无效（格式 min,max 且 min<=max）`,
      ];
    } else if (
      autoSearchConfig.autoSearchMinDistancePctBull !== null &&
      Number.isFinite(autoSearchConfig.autoSearchMinDistancePctBull)
    ) {
      const bullRangeRelationshipError = validateDegradedRangeRelationship({
        prefix,
        direction: 'LONG',
        primaryThreshold: autoSearchConfig.autoSearchMinDistancePctBull,
        switchDistanceRange: bullRange,
      });
      if (bullRangeRelationshipError !== null) {
        errors = [...errors, bullRangeRelationshipError];
      }
    }

    const bearRange = autoSearchConfig.switchDistanceRangeBear;
    if (
      !bearRange ||
      !Number.isFinite(bearRange.min) ||
      !Number.isFinite(bearRange.max) ||
      bearRange.min > bearRange.max
    ) {
      errors = [
        ...errors,
        `${prefix}: SWITCH_DISTANCE_RANGE_BEAR 未配置或无效（格式 min,max 且 min<=max）`,
      ];
    } else if (
      autoSearchConfig.autoSearchMinDistancePctBear !== null &&
      Number.isFinite(autoSearchConfig.autoSearchMinDistancePctBear)
    ) {
      const bearRangeRelationshipError = validateDegradedRangeRelationship({
        prefix,
        direction: 'SHORT',
        primaryThreshold: autoSearchConfig.autoSearchMinDistancePctBear,
        switchDistanceRange: bearRange,
      });
      if (bearRangeRelationshipError !== null) {
        errors = [...errors, bearRangeRelationshipError];
      }
    }
  }

  return { errors };
}
