/**
 * validator 配置校验模块。
 *
 * 负责聚合 Longbridge 认证校验与单实例交易配置校验，
 * 校验席位模式、策略阈值关系、全局风控配置与废弃配置项。
 */
import { STRATEGY } from '../../constants/index.js';
import type { TradingConfig } from '../../types/config.js';
import type { Quote } from '../../types/quote.js';
import { logger } from '../../utils/logger/index.js';
import { readAuthMode } from '../auth/utils.js';
import { createConfigValidationError, getStringConfig } from '../utils.js';
import type { RuntimeSymbolValidationInput, RuntimeSymbolValidationResult } from '../types.js';
import type { ValidationResult } from './types.js';
import {
  formatLiquidationCooldownConfig,
  formatNumberRange,
  validateAutoSearchRangeRelationship,
  validateCriticalBoundedNumberConfig,
  validateLongbridgeAuthConfig,
  validateRequiredSymbol,
  validateSymbolFromQuote,
} from './utils.js';

const LEGACY_INDEXED_ENV_PREFIXES = [
  'BASE_INSTRUMENT_SYMBOL',
  'LONG_SYMBOL',
  'SHORT_SYMBOL',
  'ORDER_OWNERSHIP_MAPPING',
  'TARGET_NOTIONAL',
  'MAX_POSITION_NOTIONAL',
  'MAX_UNREALIZED_LOSS_PER_SYMBOL',
  'BUY_INTERVAL_SECONDS',
  'AUTO_SEARCH_ENABLED',
  'AUTO_SEARCH_MIN_DISTANCE_PCT_BULL',
  'AUTO_SEARCH_MIN_DISTANCE_PCT_BEAR',
  'AUTO_SEARCH_MIN_TURNOVER_PER_MINUTE_BULL',
  'AUTO_SEARCH_MIN_TURNOVER_PER_MINUTE_BEAR',
  'AUTO_SEARCH_EXPIRY_MIN_MONTHS',
  'AUTO_SEARCH_OPEN_DELAY_MINUTES',
  'SWITCH_INTERVAL_MINUTES',
  'SWITCH_DISTANCE_RANGE_BULL',
  'SWITCH_DISTANCE_RANGE_BEAR',
  'LIQUIDATION_COOLDOWN_MINUTES',
  'LIQUIDATION_TRIGGER_LIMIT',
  'SIGNAL_BUYCALL',
  'SIGNAL_SELLCALL',
  'SIGNAL_BUYPUT',
  'SIGNAL_SELLPUT',
  'VERIFICATION_DELAY_SECONDS_BUY',
  'VERIFICATION_DELAY_SECONDS_SELL',
  'VERIFICATION_INDICATORS_BUY',
  'VERIFICATION_INDICATORS_SELL',
  'SMART_CLOSE_ENABLED',
  'SMART_CLOSE_TIMEOUT_MINUTES',
] as const;

const DEPRECATED_SINGLE_INSTANCE_ENV_KEYS = [
  'BASE_INSTRUMENT_SYMBOL',
  'MAX_UNREALIZED_LOSS',
  'SIGNAL_BUYCALL',
  'SIGNAL_SELLCALL',
  'SIGNAL_BUYPUT',
  'SIGNAL_SELLPUT',
  'VERIFICATION_DELAY_SECONDS_BUY',
  'VERIFICATION_DELAY_SECONDS_SELL',
  'VERIFICATION_INDICATORS_BUY',
  'VERIFICATION_INDICATORS_SELL',
  'SMART_CLOSE_ENABLED',
  'SMART_CLOSE_TIMEOUT_MINUTES',
] as const;

const REQUIRED_STRATEGY_ENV_KEYS = [
  'SEAT_MODE',
  'ORDER_OWNERSHIP_MAPPING',
  'TARGET_NOTIONAL',
  'MAX_POSITION_NOTIONAL',
  'MAX_UNREALIZED_LOSS_PER_SYMBOL',
  'BUY_INTERVAL_SECONDS',
  'LIQUIDATION_TRIGGER_LIMIT',
  'REGIME_THRESHOLDS_ATR_SHORT_PERIOD',
  'REGIME_THRESHOLDS_ATR_LONG_PERIOD',
  'REGIME_THRESHOLDS_RV_QUANTILE_WINDOW_DAYS',
  'REGIME_THRESHOLDS_TREND_ON_VOL_EXPANSION',
  'REGIME_THRESHOLDS_TREND_OFF_VOL_EXPANSION',
  'REGIME_THRESHOLDS_EXTREME_VOL_EXPANSION',
  'REGIME_THRESHOLDS_TREND_ON_VOL_QUANTILE',
  'REGIME_THRESHOLDS_TREND_OFF_VOL_QUANTILE',
  'REGIME_THRESHOLDS_EXTREME_VOL_QUANTILE',
  'TREND_SCORE_THRESHOLDS_W15',
  'TREND_SCORE_THRESHOLDS_W30',
  'TREND_SCORE_THRESHOLDS_W60',
  'TREND_SCORE_THRESHOLDS_CLASSIFICATION_THRESHOLD',
  'TREND_SCORE_THRESHOLDS_ENTRY_THRESHOLD',
  'TREND_SCORE_THRESHOLDS_EXIT_THRESHOLD',
  'TREND_SCORE_THRESHOLDS_REVERSE_INVALIDATION_THRESHOLD',
  'ER_THRESHOLDS_ER15_ENTRY_MIN',
  'ER_THRESHOLDS_ER30_ENTRY_MIN',
  'ER_THRESHOLDS_ER15_EXIT_MAX',
  'ER_THRESHOLDS_ER30_EXIT_MAX',
  'ER_THRESHOLDS_STRONG_TREND_ER_FLOOR',
  'VWAP_CONFIRM_RULES_DISTANCE_BAND_ATR',
  'VWAP_CONFIRM_RULES_SLOPE_WINDOW_BARS',
  'VWAP_CONFIRM_RULES_MAX_CROSS_COUNT_LAST10M',
  'OPENING_STRUCTURE_RULES_OR_WINDOW_MINUTES',
  'OPENING_STRUCTURE_RULES_MORNING_NOISE_WINDOW_MINUTES',
  'OPENING_STRUCTURE_RULES_AFTERNOON_NOISE_WINDOW_MINUTES',
  'OPENING_STRUCTURE_RULES_BREAKOUT_SCORE_MIN',
  'OPENING_STRUCTURE_RULES_OUTSIDE_PERSISTENCE_WINDOW_BARS',
  'OPENING_STRUCTURE_RULES_OUTSIDE_PERSISTENCE_MIN',
  'OPENING_STRUCTURE_RULES_RETEST_TOLERANCE_ATR',
  'OPENING_STRUCTURE_RULES_CONFIRM_BARS',
  'PM_CONTINUATION_RULES_AM_MOVE_Z_MIN',
  'PM_CONTINUATION_RULES_MIDDAY_HOLD_MIN',
  'PM_CONTINUATION_RULES_PM_RE_EXPANSION_TREND_SCORE_MIN',
  'PM_CONTINUATION_RULES_PM_RE_EXPANSION_ER15_MIN',
  'PM_CONTINUATION_RULES_PM_CONFIRM_CUTOFF_TIME',
  'INSTRUMENT_ADAPTATION_RULES_BULL_BUY_MIN_DISTANCE_PCT',
  'INSTRUMENT_ADAPTATION_RULES_BEAR_BUY_MAX_DISTANCE_PCT',
  'INSTRUMENT_ADAPTATION_RULES_BULL_LIQUIDATION_DISTANCE_PCT',
  'INSTRUMENT_ADAPTATION_RULES_BEAR_LIQUIDATION_DISTANCE_PCT',
] as const;

const REQUIRED_GLOBAL_ENV_KEYS = [
  'DEBUG',
  'DOOMSDAY_PROTECTION',
  'MORNING_OPENING_PROTECTION_ENABLED',
  'AFTERNOON_OPENING_PROTECTION_ENABLED',
  'BUY_ORDER_TIMEOUT_ENABLED',
  'SELL_ORDER_TIMEOUT_ENABLED',
  'ALLOW_BUY_ORDER_TRACKING_ABOVE_INITIAL_PRICE',
  'TRADING_ORDER_TYPE',
  'LIQUIDATION_ORDER_TYPE',
  'ORDER_MONITOR_PRICE_UPDATE_INTERVAL',
] as const;

/**
 * 合并多个校验结果。
 *
 * @param results 待合并的校验结果
 * @returns 合并后的校验结果
 */
function mergeValidationResults(...results: ReadonlyArray<ValidationResult>): ValidationResult {
  const errors: string[] = [];
  const missingFields: string[] = [];

  for (const result of results) {
    errors.push(...result.errors);
    missingFields.push(...result.missingFields);
  }

  return {
    valid: errors.length === 0,
    errors,
    missingFields,
  };
}

function appendMissingEnvKey(
  env: NodeJS.ProcessEnv,
  envKey: string,
  errors: string[],
  missingFields: string[],
): void {
  if (getStringConfig(env, envKey) !== null) {
    return;
  }

  errors.push(`${envKey} 未配置`);
  missingFields.push(envKey);
}

function appendMissingEnvKeys(
  env: NodeJS.ProcessEnv,
  envKeys: ReadonlyArray<string>,
  errors: string[],
  missingFields: string[],
): void {
  for (const envKey of envKeys) {
    appendMissingEnvKey(env, envKey, errors, missingFields);
  }
}

function readNormalizedBooleanEnvValue(env: NodeJS.ProcessEnv, envKey: string): string | null {
  const rawValue = getStringConfig(env, envKey);
  if (rawValue === null) {
    return null;
  }

  return rawValue.toLowerCase();
}

function validateRequiredBooleanEnvKey(params: {
  readonly env: NodeJS.ProcessEnv;
  readonly envKey: string;
  readonly expectedValue: boolean;
  readonly errors: string[];
  readonly missingFields: string[];
}): void {
  const normalizedValue = readNormalizedBooleanEnvValue(params.env, params.envKey);
  if (normalizedValue === null) {
    return;
  }

  if (normalizedValue !== 'true' && normalizedValue !== 'false') {
    params.errors.push(`${params.envKey} 无效（必须为 true 或 false）`);
    params.missingFields.push(params.envKey);
    return;
  }

  const parsedValue = normalizedValue === 'true';
  if (parsedValue !== params.expectedValue) {
    params.errors.push(`${params.envKey} 与 tradingConfig.global 不一致`);
    params.missingFields.push(params.envKey);
  }
}

/**
 * 识别是否配置了已废弃的单实例环境变量。
 *
 * @param env 进程环境变量对象
 * @returns 废弃配置校验结果
 */
function validateDeprecatedSingleInstanceEnvKeys(env: NodeJS.ProcessEnv): ValidationResult {
  const errors: string[] = [];
  const missingFields: string[] = [];

  for (const envKey of DEPRECATED_SINGLE_INSTANCE_ENV_KEYS) {
    if (!(envKey in env)) {
      continue;
    }

    errors.push(`已废弃的配置项: ${envKey} 不再支持，请改用单实例趋势延续配置`);
    missingFields.push(envKey);
  }

  return {
    valid: errors.length === 0,
    errors,
    missingFields,
  };
}

/**
 * 识别是否配置了废弃的 indexed 环境变量。
 *
 * @param env 进程环境变量对象
 * @returns 废弃配置校验结果
 */
function validateLegacyIndexedEnvKeys(env: NodeJS.ProcessEnv): ValidationResult {
  const errors: string[] = [];
  const missingFields: string[] = [];

  for (const envKey of Object.keys(env)) {
    for (const prefix of LEGACY_INDEXED_ENV_PREFIXES) {
      const pattern = new RegExp(`^${prefix}_[0-9]+$`);
      if (!pattern.test(envKey)) {
        continue;
      }

      errors.push(`已废弃的配置项: ${envKey} 不再支持，请改用单实例根配置`);
      missingFields.push(envKey);
      break;
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    missingFields,
  };
}

/**
 * 校验全局配置。
 *
 * @param tradingConfig 单实例交易配置
 * @param env 进程环境变量
 * @returns 校验结果
 */
function validateGlobalConfig(
  tradingConfig: TradingConfig,
  env: NodeJS.ProcessEnv,
): ValidationResult {
  const errors: string[] = [];
  const missingFields: string[] = [];
  const globalConfig = tradingConfig.global;

  appendMissingEnvKeys(env, REQUIRED_GLOBAL_ENV_KEYS, errors, missingFields);
  validateRequiredBooleanEnvKey({
    env,
    envKey: 'DEBUG',
    expectedValue: globalConfig.debug,
    errors,
    missingFields,
  });

  validateRequiredBooleanEnvKey({
    env,
    envKey: 'DOOMSDAY_PROTECTION',
    expectedValue: globalConfig.doomsdayProtection,
    errors,
    missingFields,
  });

  validateRequiredBooleanEnvKey({
    env,
    envKey: 'MORNING_OPENING_PROTECTION_ENABLED',
    expectedValue: globalConfig.openProtection.morning.enabled,
    errors,
    missingFields,
  });

  validateRequiredBooleanEnvKey({
    env,
    envKey: 'AFTERNOON_OPENING_PROTECTION_ENABLED',
    expectedValue: globalConfig.openProtection.afternoon.enabled,
    errors,
    missingFields,
  });

  validateRequiredBooleanEnvKey({
    env,
    envKey: 'BUY_ORDER_TIMEOUT_ENABLED',
    expectedValue: globalConfig.buyOrderTimeout.enabled,
    errors,
    missingFields,
  });

  validateRequiredBooleanEnvKey({
    env,
    envKey: 'SELL_ORDER_TIMEOUT_ENABLED',
    expectedValue: globalConfig.sellOrderTimeout.enabled,
    errors,
    missingFields,
  });

  validateRequiredBooleanEnvKey({
    env,
    envKey: 'ALLOW_BUY_ORDER_TRACKING_ABOVE_INITIAL_PRICE',
    expectedValue: globalConfig.allowBuyOrderTrackingAboveInitialPrice,
    errors,
    missingFields,
  });

  if (globalConfig.buyOrderTimeout.enabled) {
    appendMissingEnvKey(env, 'BUY_ORDER_TIMEOUT_SECONDS', errors, missingFields);
    const timeoutValidationError = validateCriticalBoundedNumberConfig({
      env,
      envKey: 'BUY_ORDER_TIMEOUT_SECONDS',
      min: 30,
      max: 600,
    });
    if (timeoutValidationError !== null) {
      errors.push(timeoutValidationError);
      missingFields.push('BUY_ORDER_TIMEOUT_SECONDS');
    }

    if (
      !Number.isInteger(globalConfig.buyOrderTimeout.timeoutSeconds) ||
      !Number.isFinite(globalConfig.buyOrderTimeout.timeoutSeconds) ||
      globalConfig.buyOrderTimeout.timeoutSeconds < 30 ||
      globalConfig.buyOrderTimeout.timeoutSeconds > 600
    ) {
      errors.push('BUY_ORDER_TIMEOUT_SECONDS 无效（范围 30-600）');
      missingFields.push('BUY_ORDER_TIMEOUT_SECONDS');
    }
  }

  if (globalConfig.sellOrderTimeout.enabled) {
    appendMissingEnvKey(env, 'SELL_ORDER_TIMEOUT_SECONDS', errors, missingFields);
    const timeoutValidationError = validateCriticalBoundedNumberConfig({
      env,
      envKey: 'SELL_ORDER_TIMEOUT_SECONDS',
      min: 30,
      max: 600,
    });
    if (timeoutValidationError !== null) {
      errors.push(timeoutValidationError);
      missingFields.push('SELL_ORDER_TIMEOUT_SECONDS');
    }

    if (
      !Number.isInteger(globalConfig.sellOrderTimeout.timeoutSeconds) ||
      !Number.isFinite(globalConfig.sellOrderTimeout.timeoutSeconds) ||
      globalConfig.sellOrderTimeout.timeoutSeconds < 30 ||
      globalConfig.sellOrderTimeout.timeoutSeconds > 600
    ) {
      errors.push('SELL_ORDER_TIMEOUT_SECONDS 无效（范围 30-600）');
      missingFields.push('SELL_ORDER_TIMEOUT_SECONDS');
    }
  }

  const tradingOrderTypeRaw = getStringConfig(env, 'TRADING_ORDER_TYPE');
  if (
    tradingOrderTypeRaw !== null &&
    tradingOrderTypeRaw !== 'LO' &&
    tradingOrderTypeRaw !== 'ELO' &&
    tradingOrderTypeRaw !== 'MO'
  ) {
    errors.push('TRADING_ORDER_TYPE 无效（必须为 LO、ELO 或 MO）');
    missingFields.push('TRADING_ORDER_TYPE');
  }

  const liquidationOrderTypeRaw = getStringConfig(env, 'LIQUIDATION_ORDER_TYPE');
  if (
    liquidationOrderTypeRaw !== null &&
    liquidationOrderTypeRaw !== 'LO' &&
    liquidationOrderTypeRaw !== 'ELO' &&
    liquidationOrderTypeRaw !== 'MO'
  ) {
    errors.push('LIQUIDATION_ORDER_TYPE 无效（必须为 LO、ELO 或 MO）');
    missingFields.push('LIQUIDATION_ORDER_TYPE');
  }

  if (tradingOrderTypeRaw !== null && tradingOrderTypeRaw !== globalConfig.tradingOrderType) {
    errors.push('TRADING_ORDER_TYPE 与 tradingConfig.global.tradingOrderType 不一致');
    missingFields.push('TRADING_ORDER_TYPE');
  }

  if (
    liquidationOrderTypeRaw !== null &&
    liquidationOrderTypeRaw !== globalConfig.liquidationOrderType
  ) {
    errors.push('LIQUIDATION_ORDER_TYPE 与 tradingConfig.global.liquidationOrderType 不一致');
    missingFields.push('LIQUIDATION_ORDER_TYPE');
  }

  if (getStringConfig(env, 'ORDER_MONITOR_PRICE_UPDATE_INTERVAL') !== null) {
    const orderMonitorIntervalValidationError = validateCriticalBoundedNumberConfig({
      env,
      envKey: 'ORDER_MONITOR_PRICE_UPDATE_INTERVAL',
      min: 1,
      max: 60,
    });
    if (orderMonitorIntervalValidationError !== null) {
      errors.push(orderMonitorIntervalValidationError);
      missingFields.push('ORDER_MONITOR_PRICE_UPDATE_INTERVAL');
    }

    if (
      !Number.isInteger(globalConfig.orderMonitorPriceUpdateInterval) ||
      !Number.isFinite(globalConfig.orderMonitorPriceUpdateInterval) ||
      globalConfig.orderMonitorPriceUpdateInterval < 1 ||
      globalConfig.orderMonitorPriceUpdateInterval > 60
    ) {
      errors.push('ORDER_MONITOR_PRICE_UPDATE_INTERVAL 无效（范围 1-60）');
      missingFields.push('ORDER_MONITOR_PRICE_UPDATE_INTERVAL');
    }
  }

  const { morning, afternoon } = globalConfig.openProtection;
  if (morning.enabled) {
    if (morning.minutes === null) {
      errors.push('MORNING_OPENING_PROTECTION_MINUTES 未配置（启用早盘保护时为必填，范围 1-60）');
      missingFields.push('MORNING_OPENING_PROTECTION_MINUTES');
    } else if (!Number.isInteger(morning.minutes) || morning.minutes < 1 || morning.minutes > 60) {
      errors.push('MORNING_OPENING_PROTECTION_MINUTES 无效（范围 1-60）');
    }
  }

  if (afternoon.enabled) {
    if (afternoon.minutes === null) {
      errors.push('AFTERNOON_OPENING_PROTECTION_MINUTES 未配置（启用午盘保护时为必填，范围 1-60）');
      missingFields.push('AFTERNOON_OPENING_PROTECTION_MINUTES');
    } else if (
      !Number.isInteger(afternoon.minutes) ||
      afternoon.minutes < 1 ||
      afternoon.minutes > 60
    ) {
      errors.push('AFTERNOON_OPENING_PROTECTION_MINUTES 无效（范围 1-60）');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    missingFields,
  };
}

/**
 * 校验波动率阈值。
 *
 * @param tradingConfig 单实例交易配置
 * @returns 校验结果
 */
function validateRegimeThresholds(tradingConfig: TradingConfig): ValidationResult {
  const { regimeThresholds } = tradingConfig.strategy;
  const errors: string[] = [];
  const missingFields: string[] = [];

  if (!Number.isInteger(regimeThresholds.atrShortPeriod) || regimeThresholds.atrShortPeriod <= 0) {
    errors.push('REGIME_THRESHOLDS_ATR_SHORT_PERIOD 无效（必须为正整数）');
    missingFields.push('REGIME_THRESHOLDS_ATR_SHORT_PERIOD');
  }

  if (!Number.isInteger(regimeThresholds.atrLongPeriod) || regimeThresholds.atrLongPeriod <= 0) {
    errors.push('REGIME_THRESHOLDS_ATR_LONG_PERIOD 无效（必须为正整数）');
    missingFields.push('REGIME_THRESHOLDS_ATR_LONG_PERIOD');
  }

  if (
    !Number.isInteger(regimeThresholds.rvQuantileWindowDays) ||
    regimeThresholds.rvQuantileWindowDays <= 0
  ) {
    errors.push('REGIME_THRESHOLDS_RV_QUANTILE_WINDOW_DAYS 无效（必须为正整数）');
    missingFields.push('REGIME_THRESHOLDS_RV_QUANTILE_WINDOW_DAYS');
  }

  if (regimeThresholds.atrShortPeriod >= regimeThresholds.atrLongPeriod) {
    errors.push('REGIME_THRESHOLDS_ATR_SHORT_PERIOD 必须小于 ATR_LONG_PERIOD');
  }

  if (regimeThresholds.trendOffVolExpansion >= regimeThresholds.trendOnVolExpansion) {
    errors.push('REGIME_THRESHOLDS_TREND_OFF_VOL_EXPANSION 必须小于 TREND_ON_VOL_EXPANSION');
  }

  if (regimeThresholds.trendOnVolExpansion >= regimeThresholds.extremeVolExpansion) {
    errors.push('REGIME_THRESHOLDS_TREND_ON_VOL_EXPANSION 必须小于 EXTREME_VOL_EXPANSION');
  }

  if (regimeThresholds.trendOffVolQuantile >= regimeThresholds.trendOnVolQuantile) {
    errors.push('REGIME_THRESHOLDS_TREND_OFF_VOL_QUANTILE 必须小于 TREND_ON_VOL_QUANTILE');
  }

  if (regimeThresholds.trendOnVolQuantile >= regimeThresholds.extremeVolQuantile) {
    errors.push('REGIME_THRESHOLDS_TREND_ON_VOL_QUANTILE 必须小于 EXTREME_VOL_QUANTILE');
  }

  return {
    valid: errors.length === 0,
    errors,
    missingFields,
  };
}

/**
 * 校验趋势评分阈值。
 *
 * @param tradingConfig 单实例交易配置
 * @returns 校验结果
 */
function validateTrendScoreThresholds(tradingConfig: TradingConfig): ValidationResult {
  const { trendScoreThresholds } = tradingConfig.strategy;
  const errors: string[] = [];
  const missingFields: string[] = [];
  const weightSum = trendScoreThresholds.w15 + trendScoreThresholds.w30 + trendScoreThresholds.w60;

  if (
    trendScoreThresholds.w15 <= 0 ||
    trendScoreThresholds.w30 <= 0 ||
    trendScoreThresholds.w60 <= 0
  ) {
    errors.push('TREND_SCORE_THRESHOLDS 权重必须为正数');
  }

  if (Math.abs(weightSum - 1) > 0.0001) {
    errors.push('TREND_SCORE_THRESHOLDS 权重之和必须为 1');
  }

  if (trendScoreThresholds.exitThreshold >= trendScoreThresholds.reverseInvalidationThreshold) {
    errors.push('TREND_SCORE_THRESHOLDS_EXIT_THRESHOLD 必须小于 REVERSE_INVALIDATION_THRESHOLD');
  }

  if (
    trendScoreThresholds.reverseInvalidationThreshold >=
    trendScoreThresholds.classificationThreshold
  ) {
    errors.push(
      'TREND_SCORE_THRESHOLDS_REVERSE_INVALIDATION_THRESHOLD 必须小于 CLASSIFICATION_THRESHOLD',
    );
  }

  if (trendScoreThresholds.classificationThreshold >= trendScoreThresholds.entryThreshold) {
    errors.push('TREND_SCORE_THRESHOLDS_CLASSIFICATION_THRESHOLD 必须小于 ENTRY_THRESHOLD');
  }

  if (
    trendScoreThresholds.exitThreshold < 0 ||
    trendScoreThresholds.classificationThreshold < 0 ||
    trendScoreThresholds.entryThreshold < 0 ||
    trendScoreThresholds.reverseInvalidationThreshold < 0
  ) {
    errors.push('TREND_SCORE_THRESHOLDS 所有阈值必须为非负数');
  }

  return {
    valid: errors.length === 0,
    errors,
    missingFields,
  };
}

/**
 * 校验 ER 阈值。
 *
 * @param tradingConfig 单实例交易配置
 * @returns 校验结果
 */
function validateErThresholds(tradingConfig: TradingConfig): ValidationResult {
  const { erThresholds } = tradingConfig.strategy;
  const errors: string[] = [];
  const missingFields: string[] = [];

  if (erThresholds.er15ExitMax >= erThresholds.er15EntryMin) {
    errors.push('ER_THRESHOLDS_ER15_EXIT_MAX 必须小于 ER15_ENTRY_MIN');
  }

  if (erThresholds.er30ExitMax >= erThresholds.er30EntryMin) {
    errors.push('ER_THRESHOLDS_ER30_EXIT_MAX 必须小于 ER30_ENTRY_MIN');
  }

  if (
    erThresholds.strongTrendErFloor < erThresholds.er15EntryMin ||
    erThresholds.strongTrendErFloor < erThresholds.er30EntryMin
  ) {
    errors.push('ER_THRESHOLDS_STRONG_TREND_ER_FLOOR 必须不小于开仓效率阈值');
  }

  return {
    valid: errors.length === 0,
    errors,
    missingFields,
  };
}

/**
 * 校验 VWAP 确认阈值。
 *
 * @param tradingConfig 单实例交易配置
 * @returns 校验结果
 */
function validateVwapConfirmRules(tradingConfig: TradingConfig): ValidationResult {
  const { vwapConfirmRules } = tradingConfig.strategy;
  const errors: string[] = [];
  const missingFields: string[] = [];

  if (vwapConfirmRules.distanceBandAtr <= 0) {
    errors.push('VWAP_CONFIRM_RULES_DISTANCE_BAND_ATR 必须大于 0');
  }

  if (!Number.isInteger(vwapConfirmRules.slopeWindowBars) || vwapConfirmRules.slopeWindowBars < 2) {
    errors.push('VWAP_CONFIRM_RULES_SLOPE_WINDOW_BARS 必须为大于等于 2 的整数');
    missingFields.push('VWAP_CONFIRM_RULES_SLOPE_WINDOW_BARS');
  }

  if (
    !Number.isInteger(vwapConfirmRules.maxCrossCountLast10m) ||
    vwapConfirmRules.maxCrossCountLast10m < 0
  ) {
    errors.push('VWAP_CONFIRM_RULES_MAX_CROSS_COUNT_LAST10M 必须为非负整数');
    missingFields.push('VWAP_CONFIRM_RULES_MAX_CROSS_COUNT_LAST10M');
  }

  return {
    valid: errors.length === 0,
    errors,
    missingFields,
  };
}

/**
 * 校验开盘结构阈值。
 *
 * @param tradingConfig 单实例交易配置
 * @returns 校验结果
 */
function validateOpeningStructureRules(tradingConfig: TradingConfig): ValidationResult {
  const { openingStructureRules } = tradingConfig.strategy;
  const errors: string[] = [];
  const missingFields: string[] = [];

  if (
    !Number.isInteger(openingStructureRules.openingRangeMinutes) ||
    openingStructureRules.openingRangeMinutes <= 0
  ) {
    errors.push('OPENING_STRUCTURE_RULES_OR_WINDOW_MINUTES 必须为正整数');
    missingFields.push('OPENING_STRUCTURE_RULES_OR_WINDOW_MINUTES');
  }

  if (
    !Number.isInteger(openingStructureRules.morningNoiseWindowMinutes) ||
    openingStructureRules.morningNoiseWindowMinutes <= 0
  ) {
    errors.push('OPENING_STRUCTURE_RULES_MORNING_NOISE_WINDOW_MINUTES 必须为正整数');
    missingFields.push('OPENING_STRUCTURE_RULES_MORNING_NOISE_WINDOW_MINUTES');
  }

  if (
    !Number.isInteger(openingStructureRules.afternoonNoiseWindowMinutes) ||
    openingStructureRules.afternoonNoiseWindowMinutes <= 0
  ) {
    errors.push('OPENING_STRUCTURE_RULES_AFTERNOON_NOISE_WINDOW_MINUTES 必须为正整数');
    missingFields.push('OPENING_STRUCTURE_RULES_AFTERNOON_NOISE_WINDOW_MINUTES');
  }

  if (openingStructureRules.breakoutScoreMin <= 0) {
    errors.push('OPENING_STRUCTURE_RULES_BREAKOUT_SCORE_MIN 必须大于 0');
  }

  if (
    !Number.isInteger(openingStructureRules.outsidePersistenceWindowBars) ||
    openingStructureRules.outsidePersistenceWindowBars <= 0
  ) {
    errors.push('OPENING_STRUCTURE_RULES_OUTSIDE_PERSISTENCE_WINDOW_BARS 必须为正整数');
    missingFields.push('OPENING_STRUCTURE_RULES_OUTSIDE_PERSISTENCE_WINDOW_BARS');
  }

  if (
    openingStructureRules.outsidePersistenceMin < 0 ||
    openingStructureRules.outsidePersistenceMin > 1
  ) {
    errors.push('OPENING_STRUCTURE_RULES_OUTSIDE_PERSISTENCE_MIN 必须在 0-1 之间');
  }

  if (openingStructureRules.retestToleranceAtr < 0) {
    errors.push('OPENING_STRUCTURE_RULES_RETEST_TOLERANCE_ATR 不能小于 0');
  }

  if (
    !Number.isInteger(openingStructureRules.confirmBars) ||
    openingStructureRules.confirmBars <= 0
  ) {
    errors.push('OPENING_STRUCTURE_RULES_CONFIRM_BARS 必须为正整数');
    missingFields.push('OPENING_STRUCTURE_RULES_CONFIRM_BARS');
  }

  return {
    valid: errors.length === 0,
    errors,
    missingFields,
  };
}

/**
 * 校验午后延续阈值。
 *
 * @param tradingConfig 单实例交易配置
 * @returns 校验结果
 */
function validatePmContinuationRules(tradingConfig: TradingConfig): ValidationResult {
  const { pmContinuationRules, trendScoreThresholds, erThresholds } = tradingConfig.strategy;
  const errors: string[] = [];
  const missingFields: string[] = [];

  if (pmContinuationRules.amMoveZMin <= 0) {
    errors.push('PM_CONTINUATION_RULES_AM_MOVE_Z_MIN 必须大于 0');
  }

  if (pmContinuationRules.middayHoldMin < 0 || pmContinuationRules.middayHoldMin > 1) {
    errors.push('PM_CONTINUATION_RULES_MIDDAY_HOLD_MIN 必须在 0-1 之间');
  }

  if (pmContinuationRules.pmReExpansionTrendScoreMin < trendScoreThresholds.entryThreshold) {
    errors.push('PM_CONTINUATION_RULES_PM_RE_EXPANSION_TREND_SCORE_MIN 必须不小于趋势开仓阈值');
  }

  if (pmContinuationRules.pmReExpansionEr15Min < erThresholds.er15ExitMax) {
    errors.push('PM_CONTINUATION_RULES_PM_RE_EXPANSION_ER15_MIN 必须不小于 ER15 退出阈值');
  }

  if (!/^\d{2}:\d{2}$/.test(pmContinuationRules.pmConfirmCutoffTime)) {
    errors.push('PM_CONTINUATION_RULES_PM_CONFIRM_CUTOFF_TIME 必须为 HH:MM 格式');
  }

  return {
    valid: errors.length === 0,
    errors,
    missingFields,
  };
}

/**
 * 校验交易标的适配阈值。
 *
 * @param tradingConfig 单实例交易配置
 * @returns 校验结果
 */
function validateInstrumentAdaptationRules(tradingConfig: TradingConfig): ValidationResult {
  const { instrumentAdaptationRules } = tradingConfig.strategy;
  const errors: string[] = [];
  const missingFields: string[] = [];

  if (instrumentAdaptationRules.bullBuyMinDistancePct <= 0) {
    errors.push('INSTRUMENT_ADAPTATION_RULES_BULL_BUY_MIN_DISTANCE_PCT 必须大于 0');
  }

  if (instrumentAdaptationRules.bearBuyMaxDistancePct >= 0) {
    errors.push('INSTRUMENT_ADAPTATION_RULES_BEAR_BUY_MAX_DISTANCE_PCT 必须小于 0');
  }

  if (instrumentAdaptationRules.bullLiquidationDistancePct <= 0) {
    errors.push('INSTRUMENT_ADAPTATION_RULES_BULL_LIQUIDATION_DISTANCE_PCT 必须大于 0');
  }

  if (instrumentAdaptationRules.bearLiquidationDistancePct >= 0) {
    errors.push('INSTRUMENT_ADAPTATION_RULES_BEAR_LIQUIDATION_DISTANCE_PCT 必须小于 0');
  }

  if (
    instrumentAdaptationRules.bullLiquidationDistancePct >=
    instrumentAdaptationRules.bullBuyMinDistancePct
  ) {
    errors.push(
      'INSTRUMENT_ADAPTATION_RULES_BULL_LIQUIDATION_DISTANCE_PCT 必须小于 BULL_BUY_MIN_DISTANCE_PCT',
    );
  }

  if (
    instrumentAdaptationRules.bearLiquidationDistancePct <=
    instrumentAdaptationRules.bearBuyMaxDistancePct
  ) {
    errors.push(
      'INSTRUMENT_ADAPTATION_RULES_BEAR_LIQUIDATION_DISTANCE_PCT 必须大于 BEAR_BUY_MAX_DISTANCE_PCT',
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    missingFields,
  };
}

/**
 * 校验自动寻标配置与静态风控阈值的相对关系。
 *
 * @param tradingConfig 单实例交易配置
 * @returns 校验结果
 */
function validateAutoSearchConfig(tradingConfig: TradingConfig): ValidationResult {
  const { autoSearchConfig, instrumentAdaptationRules } = tradingConfig.strategy;
  const errors: string[] = [];
  const missingFields: string[] = [];

  if (!autoSearchConfig.autoSearchEnabled) {
    return {
      valid: true,
      errors,
      missingFields,
    };
  }

  if (!autoSearchConfig.switchDistanceRangeBull) {
    errors.push('SWITCH_DISTANCE_RANGE_BULL 未配置');
    missingFields.push('SWITCH_DISTANCE_RANGE_BULL');
  }

  if (!autoSearchConfig.switchDistanceRangeBear) {
    errors.push('SWITCH_DISTANCE_RANGE_BEAR 未配置');
    missingFields.push('SWITCH_DISTANCE_RANGE_BEAR');
  }

  if (autoSearchConfig.switchDistanceRangeBull) {
    const relationshipError = validateAutoSearchRangeRelationship({
      prefix: '自动寻标配置',
      direction: 'LONG',
      primaryThreshold: autoSearchConfig.autoSearchMinDistancePctBull ?? 0,
      switchDistanceRange: autoSearchConfig.switchDistanceRangeBull,
      liquidationThreshold: instrumentAdaptationRules.bullLiquidationDistancePct,
    });
    if (relationshipError !== null) {
      errors.push(relationshipError);
    }
  }

  if (autoSearchConfig.switchDistanceRangeBear) {
    const relationshipError = validateAutoSearchRangeRelationship({
      prefix: '自动寻标配置',
      direction: 'SHORT',
      primaryThreshold: autoSearchConfig.autoSearchMinDistancePctBear ?? 0,
      switchDistanceRange: autoSearchConfig.switchDistanceRangeBear,
      liquidationThreshold: instrumentAdaptationRules.bearLiquidationDistancePct,
    });
    if (relationshipError !== null) {
      errors.push(relationshipError);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    missingFields,
  };
}

/**
 * 校验单实例策略配置。
 *
 * @param tradingConfig 单实例交易配置
 * @param env 进程环境变量
 * @returns 校验结果
 */
function validateStrategyConfig(
  tradingConfig: TradingConfig,
  env: NodeJS.ProcessEnv,
): ValidationResult {
  const errors: string[] = [];
  const missingFields: string[] = [];
  const { strategy } = tradingConfig;
  appendMissingEnvKeys(env, REQUIRED_STRATEGY_ENV_KEYS, errors, missingFields);
  const seatMode = strategy.seatMode;
  const longSymbolProvided = getStringConfig(env, 'LONG_SYMBOL') !== null;
  const shortSymbolProvided = getStringConfig(env, 'SHORT_SYMBOL') !== null;
  const autoSearchKeys = [
    'AUTO_SEARCH_MIN_DISTANCE_PCT_BULL',
    'AUTO_SEARCH_MIN_DISTANCE_PCT_BEAR',
    'AUTO_SEARCH_MIN_TURNOVER_PER_MINUTE_BULL',
    'AUTO_SEARCH_MIN_TURNOVER_PER_MINUTE_BEAR',
    'AUTO_SEARCH_EXPIRY_MIN_MONTHS',
    'AUTO_SEARCH_OPEN_DELAY_MINUTES',
    'SWITCH_INTERVAL_MINUTES',
    'SWITCH_DISTANCE_RANGE_BULL',
    'SWITCH_DISTANCE_RANGE_BEAR',
  ] as const;

  if (tradingConfig.baseInstrument !== STRATEGY.BASE_INSTRUMENT_SYMBOL) {
    errors.push(`baseInstrument 必须固定为 ${STRATEGY.BASE_INSTRUMENT_SYMBOL}`);
  }

  if (seatMode === 'static') {
    const longSymbolResult = validateRequiredSymbol({
      prefix: '单实例策略',
      symbol: strategy.longSymbol ?? '',
      envKey: 'LONG_SYMBOL',
      errors,
      missingFields,
    });
    errors.push(...longSymbolResult.errors);
    missingFields.push(...longSymbolResult.missingFields);

    const shortSymbolResult = validateRequiredSymbol({
      prefix: '单实例策略',
      symbol: strategy.shortSymbol ?? '',
      envKey: 'SHORT_SYMBOL',
      errors,
      missingFields,
    });
    errors.push(...shortSymbolResult.errors);
    missingFields.push(...shortSymbolResult.missingFields);

    if (
      strategy.longSymbol &&
      strategy.shortSymbol &&
      strategy.longSymbol === strategy.shortSymbol
    ) {
      errors.push('LONG_SYMBOL 与 SHORT_SYMBOL 不能相同');
    }

    for (const envKey of autoSearchKeys) {
      const rawValue = env[envKey];
      if (rawValue === undefined || rawValue.trim() === '') {
        continue;
      }

      errors.push(`SEAT_MODE=static 时不应配置 ${envKey}`);
      missingFields.push(envKey);
    }
  } else {
    if (longSymbolProvided) {
      errors.push('SEAT_MODE=auto 时不应配置 LONG_SYMBOL');
      missingFields.push('LONG_SYMBOL');
    }

    if (shortSymbolProvided) {
      errors.push('SEAT_MODE=auto 时不应配置 SHORT_SYMBOL');
      missingFields.push('SHORT_SYMBOL');
    }

    for (const envKey of autoSearchKeys) {
      const rawValue = env[envKey];
      if (rawValue === undefined || rawValue.trim() === '') {
        errors.push(`SEAT_MODE=auto 时 ${envKey} 为必填项`);
        missingFields.push(envKey);
      }
    }
  }

  if (strategy.orderOwnershipMapping.length === 0) {
    errors.push('ORDER_OWNERSHIP_MAPPING 未配置或为空（用于 stockName 归属解析）');
    missingFields.push('ORDER_OWNERSHIP_MAPPING');
  }

  if (strategy.targetNotional <= 0) {
    errors.push('TARGET_NOTIONAL 必须大于 0');
  }

  if (strategy.maxPositionNotional <= 0) {
    errors.push('MAX_POSITION_NOTIONAL 必须大于 0');
  }

  if (strategy.maxUnrealizedLossPerSymbol < 0) {
    errors.push('MAX_UNREALIZED_LOSS_PER_SYMBOL 不能小于 0');
  }

  if (
    !Number.isInteger(strategy.buyIntervalSeconds) ||
    strategy.buyIntervalSeconds < 10 ||
    strategy.buyIntervalSeconds > 600
  ) {
    errors.push('BUY_INTERVAL_SECONDS 必须为 10-600 之间的整数');
  }

  if (
    !Number.isInteger(strategy.liquidationTriggerLimit) ||
    strategy.liquidationTriggerLimit < 1 ||
    strategy.liquidationTriggerLimit > 10
  ) {
    errors.push('LIQUIDATION_TRIGGER_LIMIT 必须在 1-10 之间');
  }

  const liquidationCooldownRaw = getStringConfig(env, 'LIQUIDATION_COOLDOWN');
  if (liquidationCooldownRaw !== null && strategy.liquidationCooldown === null) {
    errors.push('LIQUIDATION_COOLDOWN 无效（必须为 1-120 分钟、half-day 或 one-day）');
    missingFields.push('LIQUIDATION_COOLDOWN');
  }

  if (
    strategy.liquidationCooldown?.mode === 'minutes' &&
    (!Number.isInteger(strategy.liquidationCooldown.minutes) ||
      strategy.liquidationCooldown.minutes < 1 ||
      strategy.liquidationCooldown.minutes > 120)
  ) {
    errors.push('LIQUIDATION_COOLDOWN 的 minutes 模式必须在 1-120 之间');
  }

  const regimeValidation = validateRegimeThresholds(tradingConfig);
  const trendScoreValidation = validateTrendScoreThresholds(tradingConfig);
  const erValidation = validateErThresholds(tradingConfig);
  const vwapValidation = validateVwapConfirmRules(tradingConfig);
  const openingStructureValidation = validateOpeningStructureRules(tradingConfig);
  const pmContinuationValidation = validatePmContinuationRules(tradingConfig);
  const instrumentAdaptationValidation = validateInstrumentAdaptationRules(tradingConfig);
  const autoSearchValidation = validateAutoSearchConfig(tradingConfig);

  errors.push(
    ...regimeValidation.errors,
    ...trendScoreValidation.errors,
    ...erValidation.errors,
    ...vwapValidation.errors,
    ...openingStructureValidation.errors,
    ...pmContinuationValidation.errors,
    ...instrumentAdaptationValidation.errors,
    ...autoSearchValidation.errors,
  );

  missingFields.push(
    ...regimeValidation.missingFields,
    ...trendScoreValidation.missingFields,
    ...erValidation.missingFields,
    ...vwapValidation.missingFields,
    ...openingStructureValidation.missingFields,
    ...pmContinuationValidation.missingFields,
    ...instrumentAdaptationValidation.missingFields,
    ...autoSearchValidation.missingFields,
  );

  return {
    valid: errors.length === 0,
    errors,
    missingFields,
  };
}

/**
 * 验证单实例交易配置。
 *
 * @param tradingConfig 单实例交易配置
 * @param env 进程环境变量
 * @returns 聚合后的校验结果
 */
function validateTradingConfig(
  tradingConfig: TradingConfig,
  env: NodeJS.ProcessEnv,
): ValidationResult {
  return mergeValidationResults(
    validateDeprecatedSingleInstanceEnvKeys(env),
    validateLegacyIndexedEnvKeys(env),
    validateGlobalConfig(tradingConfig, env),
    validateStrategyConfig(tradingConfig, env),
  );
}

/**
 * 验证 Longbridge 认证启动配置与单实例交易配置完整性。
 *
 * @param options.env 进程环境变量
 * @param options.tradingConfig 单实例交易配置
 * @returns Promise<void>
 */
export function validateAllConfig({
  env,
  tradingConfig,
}: {
  readonly env: NodeJS.ProcessEnv;
  readonly tradingConfig: TradingConfig;
}): void {
  logger.info('开始验证配置...');

  const longbridgeAuthResult = validateLongbridgeAuthConfig(env);
  const tradingResult = validateTradingConfig(tradingConfig, env);
  const allErrors = [...longbridgeAuthResult.errors, ...tradingResult.errors];
  const allMissingFields = [
    ...new Set([...longbridgeAuthResult.missingFields, ...tradingResult.missingFields]),
  ];

  if (allErrors.length > 0) {
    logger.error('配置验证失败！');
    logger.error('='.repeat(60));
    logger.error('发现以下配置问题：');
    for (const [i, allError] of allErrors.entries()) {
      logger.error(`${i + 1}. ${allError}`);
    }

    logger.error('='.repeat(60));
    logger.error('');
    logger.error('请检查 .env.local 文件，确保所有必需的配置项都已正确设置。');
    logger.error('参考 .env.example 文件了解配置说明。');
    logger.error('');

    throw createConfigValidationError(
      `配置验证失败：发现 ${allErrors.length} 个问题`,
      allMissingFields,
    );
  }

  const currentAuthMode = readAuthMode(env);
  logger.info('配置验证通过，当前配置如下：');
  if (currentAuthMode !== null) {
    logger.info(`Longbridge 认证模式: ${currentAuthMode}`);
  }

  logger.info(`基础对象 preset: ${tradingConfig.baseInstrument}`);
  logger.info(`席位模式: ${tradingConfig.strategy.seatMode}`);
  if (tradingConfig.strategy.seatMode === 'static') {
    logger.info(`做多标的: ${tradingConfig.strategy.longSymbol}`);
    logger.info(`做空标的: ${tradingConfig.strategy.shortSymbol}`);
  } else {
    logger.info('做多标的: 自动寻标');
    logger.info('做空标的: 自动寻标');
    logger.info(
      `AUTO_SEARCH_MIN_DISTANCE_PCT_BULL / BEAR: ${tradingConfig.strategy.autoSearchConfig.autoSearchMinDistancePctBull} / ${tradingConfig.strategy.autoSearchConfig.autoSearchMinDistancePctBear}`,
    );

    logger.info(
      `SWITCH_INTERVAL_MINUTES: ${tradingConfig.strategy.autoSearchConfig.switchIntervalMinutes}`,
    );

    logger.info(
      `SWITCH_DISTANCE_RANGE_BULL: ${formatNumberRange(tradingConfig.strategy.autoSearchConfig.switchDistanceRangeBull)}`,
    );

    logger.info(
      `SWITCH_DISTANCE_RANGE_BEAR: ${formatNumberRange(tradingConfig.strategy.autoSearchConfig.switchDistanceRangeBear)}`,
    );
  }

  logger.info(`订单归属映射: ${tradingConfig.strategy.orderOwnershipMapping.join(', ')}`);
  logger.info(`目标买入金额: ${tradingConfig.strategy.targetNotional} HKD`);
  logger.info(`最大持仓市值: ${tradingConfig.strategy.maxPositionNotional} HKD`);
  logger.info(`每个执行标的独立最大浮亏: ${tradingConfig.strategy.maxUnrealizedLossPerSymbol} HKD`);
  logger.info(`同方向买入时间间隔: ${tradingConfig.strategy.buyIntervalSeconds} 秒`);
  logger.info(
    `保护性清仓后买入冷却: ${formatLiquidationCooldownConfig(tradingConfig.strategy.liquidationCooldown)}`,
  );
  logger.info(`止损触发冷却次数: ${tradingConfig.strategy.liquidationTriggerLimit}`);
  logger.info(
    `波动率阈值: ATR(${tradingConfig.strategy.regimeThresholds.atrShortPeriod}/${tradingConfig.strategy.regimeThresholds.atrLongPeriod})，RV window=${tradingConfig.strategy.regimeThresholds.rvQuantileWindowDays}`,
  );

  logger.info(
    `趋势评分阈值: entry=${tradingConfig.strategy.trendScoreThresholds.entryThreshold}，exit=${tradingConfig.strategy.trendScoreThresholds.exitThreshold}，reverse=${tradingConfig.strategy.trendScoreThresholds.reverseInvalidationThreshold}`,
  );

  logger.info(
    `ER 阈值: ${tradingConfig.strategy.erThresholds.er15EntryMin}/${tradingConfig.strategy.erThresholds.er30EntryMin}`,
  );

  logger.info(
    `VWAP 确认: band=${tradingConfig.strategy.vwapConfirmRules.distanceBandAtr}，slopeWindow=${tradingConfig.strategy.vwapConfirmRules.slopeWindowBars}，cross=${tradingConfig.strategy.vwapConfirmRules.maxCrossCountLast10m}`,
  );

  logger.info(
    `开盘结构: OR=${tradingConfig.strategy.openingStructureRules.openingRangeMinutes} 分钟，confirm=${tradingConfig.strategy.openingStructureRules.confirmBars}`,
  );

  logger.info(
    `午后延续: cutoff=${tradingConfig.strategy.pmContinuationRules.pmConfirmCutoffTime}，trendScore=${tradingConfig.strategy.pmContinuationRules.pmReExpansionTrendScoreMin}`,
  );

  logger.info(
    `执行载体适配: bullBuy=${tradingConfig.strategy.instrumentAdaptationRules.bullBuyMinDistancePct} / bearBuy=${tradingConfig.strategy.instrumentAdaptationRules.bearBuyMaxDistancePct}`,
  );
  logger.info('');
  logger.info(`是否启动末日保护: ${tradingConfig.global.doomsdayProtection ? '是' : '否'}`);
  logger.info(
    `买单跟价允许高于初始委托价: ${
      tradingConfig.global.allowBuyOrderTrackingAboveInitialPrice ? '是' : '否'
    }`,
  );
  logger.info('');
}

/**
 * 根据行情快照批量验证运行时标的有效性。
 *
 * @param options.inputs 待验证的标的列表
 * @param options.quotesMap 标的代码到行情数据的 Map
 * @returns 验证结果
 */
export function validateRuntimeSymbolsFromQuotesMap({
  inputs,
  quotesMap,
}: {
  readonly inputs: ReadonlyArray<RuntimeSymbolValidationInput>;
  readonly quotesMap: ReadonlyMap<string, Quote | null>;
}): RuntimeSymbolValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const input of inputs) {
    const quote = quotesMap.get(input.symbol) ?? null;
    const result = validateSymbolFromQuote(quote, input.symbol, input.label, input.requireLotSize);
    if (!result.valid) {
      const message = result.error ?? `${input.label} ${input.symbol} 验证失败`;
      if (input.required) {
        errors.push(message);
      } else {
        warnings.push(message);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
