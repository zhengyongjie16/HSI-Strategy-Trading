import type { OrderType } from 'longbridge';
import type {
  AutoSearchConfig,
  ErThresholdConfig,
  GlobalConfig,
  InstrumentAdaptationRulesConfig,
  NumberRange,
  OpeningStructureRulesConfig,
  PmContinuationRulesConfig,
  RegimeThresholdConfig,
  SeatMode,
  StrategyConfig,
  TrendScoreThresholdConfig,
  VwapConfirmRulesConfig,
} from '../../types/config.js';
import type { OrderTypeConfig } from '../../types/signal.js';
import { OPEN_API_ORDER_TYPE_TO_CONFIG, STRATEGY, TRADING } from '../../constants/index.js';
import {
  createConfigValidationError,
  getBooleanConfig,
  getNumberConfig,
  getStringConfig,
  parseLiquidationCooldownConfig,
  parseNumberRangeConfig,
  parseOrderOwnershipMapping,
  parseOrderTypeConfig,
} from '../utils.js';
import type { BoundedNumberConfig, MinimumNumberConfig } from './types.js';

/**
 * 解析数值配置的通用内部实现。
 *
 * @param options 解析参数
 * @returns 合法数值，或在配置缺失时返回 defaultValue / null
 */
function parseNumericConfig({
  env,
  envKey,
  defaultValue,
  min,
  max,
  integer = false,
  required = false,
  nullable = false,
}: {
  readonly env: NodeJS.ProcessEnv;
  readonly envKey: string;
  readonly defaultValue: number;
  readonly min: number;
  readonly max: number;
  readonly integer?: boolean;
  readonly required?: boolean;
  readonly nullable?: boolean;
}): number | null {
  const raw = env[envKey];
  if (raw === undefined || raw.trim() === '') {
    if (required) {
      throw createConfigValidationError(`[配置错误] ${envKey} 未配置`, [envKey]);
    }

    return nullable ? null : defaultValue;
  }

  const value = Number(raw);
  const isOutOfRange = !Number.isFinite(value) || value < min || value > max;
  const isIntegerInvalid = integer && !Number.isInteger(value);
  if (isOutOfRange || isIntegerInvalid) {
    let rangeText: string;
    if (Number.isFinite(max)) {
      rangeText = integer ? `整数且范围 ${min}-${max}` : `数字且范围 ${min}-${max}`;
    } else {
      rangeText = integer ? `整数且 >= ${min}` : `数字且 >= ${min}`;
    }

    throw createConfigValidationError(`[配置错误] ${envKey} 无效（必须为${rangeText}）`, [envKey]);
  }

  return value;
}

/**
 * 解析关键数值配置的必填结果。
 *
 * @param options 解析参数
 * @returns 合法范围内的数值
 */
function parseRequiredNumericConfig(options: {
  readonly env: NodeJS.ProcessEnv;
  readonly envKey: string;
  readonly defaultValue: number;
  readonly min: number;
  readonly max: number;
  readonly integer?: boolean;
}): number {
  const value = parseNumericConfig(options);
  if (value === null) {
    throw createConfigValidationError(`[配置错误] ${options.envKey} 未配置`, [options.envKey]);
  }

  return value;
}

/**
 * 解析数值范围配置的必填版本。
 *
 * @param env 进程环境变量对象
 * @param envKey 环境变量键名
 * @returns 合法的数值范围
 */
function parseRequiredNumberRangeConfig(env: NodeJS.ProcessEnv, envKey: string): NumberRange {
  const range = parseNumberRangeConfig(env, envKey);
  if (range) {
    return range;
  }

  throw createConfigValidationError(`[配置错误] ${envKey} 未配置或格式无效（必须为 "min,max"）`, [
    envKey,
  ]);
}

/**
 * 解析 HH:MM 形式的时间配置。
 *
 * @param options 解析参数
 * @returns 合法的 HH:MM 时间字符串
 */
function parseTimeOfDayConfig({
  env,
  envKey,
  defaultValue,
  required = false,
}: {
  readonly env: NodeJS.ProcessEnv;
  readonly envKey: string;
  readonly defaultValue: string;
  readonly required?: boolean;
}): string {
  const value = getStringConfig(env, envKey);
  if (!value) {
    if (required) {
      throw createConfigValidationError(`[配置错误] ${envKey} 未配置`, [envKey]);
    }

    return defaultValue;
  }

  const timePattern = /^(\d{2}):(\d{2})$/;
  const match = timePattern.exec(value);
  if (!match) {
    throw createConfigValidationError(`[配置错误] ${envKey} 无效（必须为 HH:MM 格式）`, [envKey]);
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours > 23 || minutes > 59) {
    throw createConfigValidationError(`[配置错误] ${envKey} 无效（必须为合法的 24 小时制时间）`, [
      envKey,
    ]);
  }

  return `${match[1]}:${match[2]}`;
}

/**
 * 解析席位模式。
 *
 * @param env 进程环境变量对象
 * @returns 单实例席位模式
 */
export function parseSeatModeConfig(env: NodeJS.ProcessEnv): SeatMode {
  const value = getStringConfig(env, 'SEAT_MODE');
  if (!value) {
    return STRATEGY.DEFAULT_SEAT_MODE;
  }

  if (value === 'static' || value === 'auto') {
    return value;
  }

  throw createConfigValidationError('[配置错误] SEAT_MODE 无效（必须为 static 或 auto）', [
    'SEAT_MODE',
  ]);
}

/**
 * 解析关键数值配置：未配置时使用默认值，显式配置非法或越界时立即失败。
 *
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
  return parseRequiredNumericConfig({
    env,
    envKey,
    defaultValue,
    min,
    max,
  });
}

/**
 * 解析关键整数配置：未配置时使用默认值，显式配置非法、非整数或越界时立即失败。
 *
 * @param options 包含 env、envKey、defaultValue、min、max 的配置对象
 * @returns 合法范围内的整数
 */
export function parseFailFastIntegerBoundedNumberConfig({
  env,
  envKey,
  defaultValue,
  min,
  max,
}: BoundedNumberConfig): number {
  return parseRequiredNumericConfig({
    env,
    envKey,
    defaultValue,
    min,
    max,
    integer: true,
  });
}

/**
 * 解析关键数值配置：未配置时使用默认值，显式配置非法或小于下限时立即失败。
 *
 * @param options 包含 env、envKey、defaultValue、min 的配置对象
 * @returns 大于等于 min 的合法数值
 */
export function parseFailFastMinimumNumberConfig({
  env,
  envKey,
  defaultValue,
  min,
}: MinimumNumberConfig): number {
  return parseRequiredNumericConfig({
    env,
    envKey,
    defaultValue,
    min,
    max: Number.POSITIVE_INFINITY,
  });
}

/**
 * 解析关键整数配置：未配置时使用默认值，显式配置非法、非整数或小于下限时立即失败。
 *
 * @param options 包含 env、envKey、defaultValue、min 的配置对象
 * @returns 大于等于 min 的合法整数
 */
export function parseFailFastIntegerMinimumNumberConfig({
  env,
  envKey,
  defaultValue,
  min,
}: MinimumNumberConfig): number {
  return parseRequiredNumericConfig({
    env,
    envKey,
    defaultValue,
    min,
    max: Number.POSITIVE_INFINITY,
    integer: true,
  });
}

/**
 * 读取百分比值配置并保持运行时口径不变。
 *
 * @param env 进程环境变量对象
 * @param envKey 环境变量键名
 * @param minValue 允许的最小原始数值
 * @returns 百分比值或 null
 */
export function getPercentValueConfig(
  env: NodeJS.ProcessEnv,
  envKey: string,
  minValue: number = 0,
): number | null {
  return getNumberConfig(env, envKey, minValue);
}

/**
 * 将 OpenAPI 订单类型映射为内部订单类型配置。
 *
 * @param orderType OpenAPI 订单类型
 * @returns 内部订单类型配置
 */
export function mapOrderTypeConfig(orderType: OrderType): OrderTypeConfig {
  return OPEN_API_ORDER_TYPE_TO_CONFIG[orderType] ?? 'ELO';
}

/**
 * 解析交易订单类型配置。
 *
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

/**
 * 解析自动寻标配置。
 *
 * @param env 进程环境变量对象
 * @param seatMode 席位模式
 * @returns 自动寻标配置
 */
export function parseAutoSearchConfig(
  env: NodeJS.ProcessEnv,
  seatMode: SeatMode,
): AutoSearchConfig {
  const autoSearchEnabled = seatMode === 'auto';
  if (!autoSearchEnabled) {
    return {
      autoSearchEnabled,
      autoSearchMinDistancePctBull: STRATEGY.AUTO_SEARCH.minDistancePctBull,
      autoSearchMinDistancePctBear: STRATEGY.AUTO_SEARCH.minDistancePctBear,
      autoSearchMinTurnoverPerMinuteBull: STRATEGY.AUTO_SEARCH.minTurnoverPerMinuteBull,
      autoSearchMinTurnoverPerMinuteBear: STRATEGY.AUTO_SEARCH.minTurnoverPerMinuteBear,
      autoSearchExpiryMinMonths: STRATEGY.AUTO_SEARCH.expiryMinMonths,
      autoSearchOpenDelayMinutes: STRATEGY.AUTO_SEARCH.openDelayMinutes,
      switchIntervalMinutes: STRATEGY.AUTO_SEARCH.switchIntervalMinutes,
      switchDistanceRangeBull: STRATEGY.AUTO_SEARCH.switchDistanceRangeBull,
      switchDistanceRangeBear: STRATEGY.AUTO_SEARCH.switchDistanceRangeBear,
    };
  }

  return {
    autoSearchEnabled,
    autoSearchMinDistancePctBull:
      parseNumericConfig({
        env,
        envKey: 'AUTO_SEARCH_MIN_DISTANCE_PCT_BULL',
        defaultValue: STRATEGY.AUTO_SEARCH.minDistancePctBull,
        min: 0,
        max: 10,
        required: true,
      }) ?? STRATEGY.AUTO_SEARCH.minDistancePctBull,
    autoSearchMinDistancePctBear:
      parseNumericConfig({
        env,
        envKey: 'AUTO_SEARCH_MIN_DISTANCE_PCT_BEAR',
        defaultValue: STRATEGY.AUTO_SEARCH.minDistancePctBear,
        min: -10,
        max: 0,
        required: true,
      }) ?? STRATEGY.AUTO_SEARCH.minDistancePctBear,
    autoSearchMinTurnoverPerMinuteBull:
      parseNumericConfig({
        env,
        envKey: 'AUTO_SEARCH_MIN_TURNOVER_PER_MINUTE_BULL',
        defaultValue: STRATEGY.AUTO_SEARCH.minTurnoverPerMinuteBull,
        min: 1,
        max: Number.POSITIVE_INFINITY,
        required: true,
      }) ?? STRATEGY.AUTO_SEARCH.minTurnoverPerMinuteBull,
    autoSearchMinTurnoverPerMinuteBear:
      parseNumericConfig({
        env,
        envKey: 'AUTO_SEARCH_MIN_TURNOVER_PER_MINUTE_BEAR',
        defaultValue: STRATEGY.AUTO_SEARCH.minTurnoverPerMinuteBear,
        min: 1,
        max: Number.POSITIVE_INFINITY,
        required: true,
      }) ?? STRATEGY.AUTO_SEARCH.minTurnoverPerMinuteBear,
    autoSearchExpiryMinMonths:
      parseNumericConfig({
        env,
        envKey: 'AUTO_SEARCH_EXPIRY_MIN_MONTHS',
        defaultValue: STRATEGY.AUTO_SEARCH.expiryMinMonths,
        min: 1,
        max: 120,
        integer: true,
        required: true,
      }) ?? STRATEGY.AUTO_SEARCH.expiryMinMonths,
    autoSearchOpenDelayMinutes:
      parseNumericConfig({
        env,
        envKey: 'AUTO_SEARCH_OPEN_DELAY_MINUTES',
        defaultValue: STRATEGY.AUTO_SEARCH.openDelayMinutes,
        min: 0,
        max: 60,
        integer: true,
        required: true,
      }) ?? STRATEGY.AUTO_SEARCH.openDelayMinutes,
    switchIntervalMinutes:
      parseNumericConfig({
        env,
        envKey: 'SWITCH_INTERVAL_MINUTES',
        defaultValue: STRATEGY.AUTO_SEARCH.switchIntervalMinutes,
        min: 0,
        max: 120,
        integer: true,
        required: true,
      }) ?? STRATEGY.AUTO_SEARCH.switchIntervalMinutes,
    switchDistanceRangeBull: parseRequiredNumberRangeConfig(env, 'SWITCH_DISTANCE_RANGE_BULL'),
    switchDistanceRangeBear: parseRequiredNumberRangeConfig(env, 'SWITCH_DISTANCE_RANGE_BEAR'),
  };
}

/**
 * 解析波动率状态阈值配置。
 *
 * @param env 进程环境变量对象
 * @returns 波动率状态阈值
 */
export function parseRegimeThresholdConfig(env: NodeJS.ProcessEnv): RegimeThresholdConfig {
  return {
    atrShortPeriod: parseFailFastIntegerBoundedNumberConfig({
      env,
      envKey: 'REGIME_THRESHOLDS_ATR_SHORT_PERIOD',
      defaultValue: STRATEGY.REGIME_THRESHOLDS.atrShortPeriod,
      min: 1,
      max: 250,
    }),
    atrLongPeriod: parseFailFastIntegerBoundedNumberConfig({
      env,
      envKey: 'REGIME_THRESHOLDS_ATR_LONG_PERIOD',
      defaultValue: STRATEGY.REGIME_THRESHOLDS.atrLongPeriod,
      min: 1,
      max: 250,
    }),
    rvQuantileWindowDays: parseFailFastIntegerBoundedNumberConfig({
      env,
      envKey: 'REGIME_THRESHOLDS_RV_QUANTILE_WINDOW_DAYS',
      defaultValue: STRATEGY.REGIME_THRESHOLDS.rvQuantileWindowDays,
      min: 1,
      max: 250,
    }),
    trendOnVolExpansion: parseFailFastBoundedNumberConfig({
      env,
      envKey: 'REGIME_THRESHOLDS_TREND_ON_VOL_EXPANSION',
      defaultValue: STRATEGY.REGIME_THRESHOLDS.trendOnVolExpansion,
      min: 0,
      max: 10,
    }),
    trendOffVolExpansion: parseFailFastBoundedNumberConfig({
      env,
      envKey: 'REGIME_THRESHOLDS_TREND_OFF_VOL_EXPANSION',
      defaultValue: STRATEGY.REGIME_THRESHOLDS.trendOffVolExpansion,
      min: 0,
      max: 10,
    }),
    extremeVolExpansion: parseFailFastBoundedNumberConfig({
      env,
      envKey: 'REGIME_THRESHOLDS_EXTREME_VOL_EXPANSION',
      defaultValue: STRATEGY.REGIME_THRESHOLDS.extremeVolExpansion,
      min: 0,
      max: 10,
    }),
    trendOnVolQuantile: parseFailFastBoundedNumberConfig({
      env,
      envKey: 'REGIME_THRESHOLDS_TREND_ON_VOL_QUANTILE',
      defaultValue: STRATEGY.REGIME_THRESHOLDS.trendOnVolQuantile,
      min: 0,
      max: 1,
    }),
    trendOffVolQuantile: parseFailFastBoundedNumberConfig({
      env,
      envKey: 'REGIME_THRESHOLDS_TREND_OFF_VOL_QUANTILE',
      defaultValue: STRATEGY.REGIME_THRESHOLDS.trendOffVolQuantile,
      min: 0,
      max: 1,
    }),
    extremeVolQuantile: parseFailFastBoundedNumberConfig({
      env,
      envKey: 'REGIME_THRESHOLDS_EXTREME_VOL_QUANTILE',
      defaultValue: STRATEGY.REGIME_THRESHOLDS.extremeVolQuantile,
      min: 0,
      max: 1,
    }),
  };
}

/**
 * 解析趋势评分阈值配置。
 *
 * @param env 进程环境变量对象
 * @returns 趋势评分阈值
 */
export function parseTrendScoreThresholdConfig(env: NodeJS.ProcessEnv): TrendScoreThresholdConfig {
  return {
    w15: parseFailFastBoundedNumberConfig({
      env,
      envKey: 'TREND_SCORE_THRESHOLDS_W15',
      defaultValue: STRATEGY.TREND_SCORE_THRESHOLDS.w15,
      min: 0,
      max: 1,
    }),
    w30: parseFailFastBoundedNumberConfig({
      env,
      envKey: 'TREND_SCORE_THRESHOLDS_W30',
      defaultValue: STRATEGY.TREND_SCORE_THRESHOLDS.w30,
      min: 0,
      max: 1,
    }),
    w60: parseFailFastBoundedNumberConfig({
      env,
      envKey: 'TREND_SCORE_THRESHOLDS_W60',
      defaultValue: STRATEGY.TREND_SCORE_THRESHOLDS.w60,
      min: 0,
      max: 1,
    }),
    classificationThreshold: parseFailFastBoundedNumberConfig({
      env,
      envKey: 'TREND_SCORE_THRESHOLDS_CLASSIFICATION_THRESHOLD',
      defaultValue: STRATEGY.TREND_SCORE_THRESHOLDS.classificationThreshold,
      min: 0,
      max: 10,
    }),
    entryThreshold: parseFailFastBoundedNumberConfig({
      env,
      envKey: 'TREND_SCORE_THRESHOLDS_ENTRY_THRESHOLD',
      defaultValue: STRATEGY.TREND_SCORE_THRESHOLDS.entryThreshold,
      min: 0,
      max: 10,
    }),
    exitThreshold: parseFailFastBoundedNumberConfig({
      env,
      envKey: 'TREND_SCORE_THRESHOLDS_EXIT_THRESHOLD',
      defaultValue: STRATEGY.TREND_SCORE_THRESHOLDS.exitThreshold,
      min: 0,
      max: 10,
    }),
    reverseInvalidationThreshold: parseFailFastBoundedNumberConfig({
      env,
      envKey: 'TREND_SCORE_THRESHOLDS_REVERSE_INVALIDATION_THRESHOLD',
      defaultValue: STRATEGY.TREND_SCORE_THRESHOLDS.reverseInvalidationThreshold,
      min: 0,
      max: 10,
    }),
  };
}

/**
 * 解析 ER 阈值配置。
 *
 * @param env 进程环境变量对象
 * @returns ER 阈值
 */
export function parseErThresholdConfig(env: NodeJS.ProcessEnv): ErThresholdConfig {
  return {
    er15EntryMin: parseFailFastBoundedNumberConfig({
      env,
      envKey: 'ER_THRESHOLDS_ER15_ENTRY_MIN',
      defaultValue: STRATEGY.ER_THRESHOLDS.er15EntryMin,
      min: 0,
      max: 10,
    }),
    er30EntryMin: parseFailFastBoundedNumberConfig({
      env,
      envKey: 'ER_THRESHOLDS_ER30_ENTRY_MIN',
      defaultValue: STRATEGY.ER_THRESHOLDS.er30EntryMin,
      min: 0,
      max: 10,
    }),
    er15ExitMax: parseFailFastBoundedNumberConfig({
      env,
      envKey: 'ER_THRESHOLDS_ER15_EXIT_MAX',
      defaultValue: STRATEGY.ER_THRESHOLDS.er15ExitMax,
      min: 0,
      max: 10,
    }),
    er30ExitMax: parseFailFastBoundedNumberConfig({
      env,
      envKey: 'ER_THRESHOLDS_ER30_EXIT_MAX',
      defaultValue: STRATEGY.ER_THRESHOLDS.er30ExitMax,
      min: 0,
      max: 10,
    }),
    strongTrendErFloor: parseFailFastBoundedNumberConfig({
      env,
      envKey: 'ER_THRESHOLDS_STRONG_TREND_ER_FLOOR',
      defaultValue: STRATEGY.ER_THRESHOLDS.strongTrendErFloor,
      min: 0,
      max: 10,
    }),
  };
}

/**
 * 解析 VWAP 确认规则配置。
 *
 * @param env 进程环境变量对象
 * @returns VWAP 确认规则
 */
export function parseVwapConfirmRulesConfig(env: NodeJS.ProcessEnv): VwapConfirmRulesConfig {
  return {
    distanceBandAtr: parseFailFastBoundedNumberConfig({
      env,
      envKey: 'VWAP_CONFIRM_RULES_DISTANCE_BAND_ATR',
      defaultValue: STRATEGY.VWAP_CONFIRM_RULES.distanceBandAtr,
      min: 0,
      max: 1,
    }),
    slopeWindowBars: parseFailFastIntegerBoundedNumberConfig({
      env,
      envKey: 'VWAP_CONFIRM_RULES_SLOPE_WINDOW_BARS',
      defaultValue: STRATEGY.VWAP_CONFIRM_RULES.slopeWindowBars,
      min: 1,
      max: 120,
    }),
    maxCrossCountLast10m: parseFailFastIntegerBoundedNumberConfig({
      env,
      envKey: 'VWAP_CONFIRM_RULES_MAX_CROSS_COUNT_LAST10M',
      defaultValue: STRATEGY.VWAP_CONFIRM_RULES.maxCrossCountLast10m,
      min: 0,
      max: 20,
    }),
  };
}

/**
 * 解析开盘结构规则配置。
 *
 * @param env 进程环境变量对象
 * @returns 开盘结构规则
 */
export function parseOpeningStructureRulesConfig(
  env: NodeJS.ProcessEnv,
): OpeningStructureRulesConfig {
  return {
    openingRangeMinutes: parseFailFastIntegerBoundedNumberConfig({
      env,
      envKey: 'OPENING_STRUCTURE_RULES_OR_WINDOW_MINUTES',
      defaultValue: STRATEGY.OPENING_STRUCTURE_RULES.openingRangeMinutes,
      min: 1,
      max: 120,
    }),
    morningNoiseWindowMinutes: parseFailFastIntegerBoundedNumberConfig({
      env,
      envKey: 'OPENING_STRUCTURE_RULES_MORNING_NOISE_WINDOW_MINUTES',
      defaultValue: STRATEGY.OPENING_STRUCTURE_RULES.morningNoiseWindowMinutes,
      min: 1,
      max: 120,
    }),
    afternoonNoiseWindowMinutes: parseFailFastIntegerBoundedNumberConfig({
      env,
      envKey: 'OPENING_STRUCTURE_RULES_AFTERNOON_NOISE_WINDOW_MINUTES',
      defaultValue: STRATEGY.OPENING_STRUCTURE_RULES.afternoonNoiseWindowMinutes,
      min: 1,
      max: 120,
    }),
    breakoutScoreMin: parseFailFastBoundedNumberConfig({
      env,
      envKey: 'OPENING_STRUCTURE_RULES_BREAKOUT_SCORE_MIN',
      defaultValue: STRATEGY.OPENING_STRUCTURE_RULES.breakoutScoreMin,
      min: 0,
      max: 10,
    }),
    outsidePersistenceWindowBars: parseFailFastIntegerBoundedNumberConfig({
      env,
      envKey: 'OPENING_STRUCTURE_RULES_OUTSIDE_PERSISTENCE_WINDOW_BARS',
      defaultValue: STRATEGY.OPENING_STRUCTURE_RULES.outsidePersistenceWindowBars,
      min: 1,
      max: 30,
    }),
    outsidePersistenceMin: parseFailFastBoundedNumberConfig({
      env,
      envKey: 'OPENING_STRUCTURE_RULES_OUTSIDE_PERSISTENCE_MIN',
      defaultValue: STRATEGY.OPENING_STRUCTURE_RULES.outsidePersistenceMin,
      min: 0,
      max: 1,
    }),
    retestToleranceAtr: parseFailFastBoundedNumberConfig({
      env,
      envKey: 'OPENING_STRUCTURE_RULES_RETEST_TOLERANCE_ATR',
      defaultValue: STRATEGY.OPENING_STRUCTURE_RULES.retestToleranceAtr,
      min: 0,
      max: 1,
    }),
    confirmBars: parseFailFastIntegerBoundedNumberConfig({
      env,
      envKey: 'OPENING_STRUCTURE_RULES_CONFIRM_BARS',
      defaultValue: STRATEGY.OPENING_STRUCTURE_RULES.confirmBars,
      min: 1,
      max: 10,
    }),
  };
}

/**
 * 解析午后延续规则配置。
 *
 * @param env 进程环境变量对象
 * @returns 午后延续规则
 */
export function parsePmContinuationRulesConfig(env: NodeJS.ProcessEnv): PmContinuationRulesConfig {
  return {
    amMoveZMin: parseFailFastBoundedNumberConfig({
      env,
      envKey: 'PM_CONTINUATION_RULES_AM_MOVE_Z_MIN',
      defaultValue: STRATEGY.PM_CONTINUATION_RULES.amMoveZMin,
      min: 0,
      max: 10,
    }),
    middayHoldMin: parseFailFastBoundedNumberConfig({
      env,
      envKey: 'PM_CONTINUATION_RULES_MIDDAY_HOLD_MIN',
      defaultValue: STRATEGY.PM_CONTINUATION_RULES.middayHoldMin,
      min: 0,
      max: 1,
    }),
    pmReExpansionTrendScoreMin: parseFailFastBoundedNumberConfig({
      env,
      envKey: 'PM_CONTINUATION_RULES_PM_RE_EXPANSION_TREND_SCORE_MIN',
      defaultValue: STRATEGY.PM_CONTINUATION_RULES.pmReExpansionTrendScoreMin,
      min: 0,
      max: 10,
    }),
    pmReExpansionEr15Min: parseFailFastBoundedNumberConfig({
      env,
      envKey: 'PM_CONTINUATION_RULES_PM_RE_EXPANSION_ER15_MIN',
      defaultValue: STRATEGY.PM_CONTINUATION_RULES.pmReExpansionEr15Min,
      min: 0,
      max: 1,
    }),
    pmConfirmCutoffTime: parseTimeOfDayConfig({
      env,
      envKey: 'PM_CONTINUATION_RULES_PM_CONFIRM_CUTOFF_TIME',
      defaultValue: STRATEGY.PM_CONTINUATION_RULES.pmConfirmCutoffTime,
    }),
  };
}

/**
 * 解析交易标的适配规则配置。
 *
 * @param env 进程环境变量对象
 * @returns 交易标的适配规则
 */
export function parseInstrumentAdaptationRulesConfig(
  env: NodeJS.ProcessEnv,
): InstrumentAdaptationRulesConfig {
  return {
    bullBuyMinDistancePct: parseFailFastBoundedNumberConfig({
      env,
      envKey: 'INSTRUMENT_ADAPTATION_RULES_BULL_BUY_MIN_DISTANCE_PCT',
      defaultValue: STRATEGY.INSTRUMENT_ADAPTATION_RULES.bullBuyMinDistancePct,
      min: 0,
      max: 10,
    }),
    bearBuyMaxDistancePct: parseFailFastBoundedNumberConfig({
      env,
      envKey: 'INSTRUMENT_ADAPTATION_RULES_BEAR_BUY_MAX_DISTANCE_PCT',
      defaultValue: STRATEGY.INSTRUMENT_ADAPTATION_RULES.bearBuyMaxDistancePct,
      min: -10,
      max: 0,
    }),
    bullLiquidationDistancePct: parseFailFastBoundedNumberConfig({
      env,
      envKey: 'INSTRUMENT_ADAPTATION_RULES_BULL_LIQUIDATION_DISTANCE_PCT',
      defaultValue: STRATEGY.INSTRUMENT_ADAPTATION_RULES.bullLiquidationDistancePct,
      min: 0,
      max: 10,
    }),
    bearLiquidationDistancePct: parseFailFastBoundedNumberConfig({
      env,
      envKey: 'INSTRUMENT_ADAPTATION_RULES_BEAR_LIQUIDATION_DISTANCE_PCT',
      defaultValue: STRATEGY.INSTRUMENT_ADAPTATION_RULES.bearLiquidationDistancePct,
      min: -10,
      max: 0,
    }),
  };
}

/**
 * 解析单实例策略配置。
 *
 * @param env 进程环境变量对象
 * @returns 单实例策略配置
 */
export function parseStrategyConfig(env: NodeJS.ProcessEnv): StrategyConfig {
  const seatMode = parseSeatModeConfig(env);
  const longSymbol = getStringConfig(env, 'LONG_SYMBOL');
  const shortSymbol = getStringConfig(env, 'SHORT_SYMBOL');

  return {
    seatMode,
    longSymbol,
    shortSymbol,
    autoSearchConfig: parseAutoSearchConfig(env, seatMode),
    orderOwnershipMapping: parseOrderOwnershipMapping(env, 'ORDER_OWNERSHIP_MAPPING'),
    targetNotional: parseFailFastMinimumNumberConfig({
      env,
      envKey: 'TARGET_NOTIONAL',
      defaultValue: TRADING.DEFAULT_TARGET_NOTIONAL,
      min: 1,
    }),
    maxPositionNotional: parseFailFastMinimumNumberConfig({
      env,
      envKey: 'MAX_POSITION_NOTIONAL',
      defaultValue: TRADING.DEFAULT_MAX_POSITION_NOTIONAL,
      min: 1,
    }),
    maxUnrealizedLoss: parseFailFastMinimumNumberConfig({
      env,
      envKey: 'MAX_UNREALIZED_LOSS',
      defaultValue: TRADING.DEFAULT_MAX_UNREALIZED_LOSS,
      min: 0,
    }),
    buyIntervalSeconds: parseFailFastIntegerBoundedNumberConfig({
      env,
      envKey: 'BUY_INTERVAL_SECONDS',
      defaultValue: TRADING.DEFAULT_BUY_INTERVAL_SECONDS,
      min: 10,
      max: 600,
    }),
    liquidationCooldown: parseLiquidationCooldownConfig(env, 'LIQUIDATION_COOLDOWN'),
    liquidationTriggerLimit: parseFailFastIntegerBoundedNumberConfig({
      env,
      envKey: 'LIQUIDATION_TRIGGER_LIMIT',
      defaultValue: TRADING.DEFAULT_LIQUIDATION_TRIGGER_LIMIT,
      min: 1,
      max: 10,
    }),
    regimeThresholds: parseRegimeThresholdConfig(env),
    trendScoreThresholds: parseTrendScoreThresholdConfig(env),
    erThresholds: parseErThresholdConfig(env),
    vwapConfirmRules: parseVwapConfirmRulesConfig(env),
    openingStructureRules: parseOpeningStructureRulesConfig(env),
    pmContinuationRules: parsePmContinuationRulesConfig(env),
    instrumentAdaptationRules: parseInstrumentAdaptationRulesConfig(env),
  };
}

/**
 * 解析单实例全局配置。
 *
 * @param env 进程环境变量对象
 * @returns 全局配置
 */
export function parseGlobalConfig(env: NodeJS.ProcessEnv): GlobalConfig {
  const buyOrderTimeoutEnabled = getBooleanConfig(env, 'BUY_ORDER_TIMEOUT_ENABLED', true);
  const buyOrderTimeoutSeconds = buyOrderTimeoutEnabled
    ? parseFailFastIntegerBoundedNumberConfig({
        env,
        envKey: 'BUY_ORDER_TIMEOUT_SECONDS',
        defaultValue: TRADING.DEFAULT_ORDER_TIMEOUT_SECONDS,
        min: 30,
        max: 600,
      })
    : TRADING.DEFAULT_ORDER_TIMEOUT_SECONDS;
  const sellOrderTimeoutEnabled = getBooleanConfig(env, 'SELL_ORDER_TIMEOUT_ENABLED', true);
  const sellOrderTimeoutSeconds = sellOrderTimeoutEnabled
    ? parseFailFastIntegerBoundedNumberConfig({
        env,
        envKey: 'SELL_ORDER_TIMEOUT_SECONDS',
        defaultValue: TRADING.DEFAULT_ORDER_TIMEOUT_SECONDS,
        min: 30,
        max: 600,
      })
    : TRADING.DEFAULT_ORDER_TIMEOUT_SECONDS;
  const orderMonitorPriceUpdateInterval = parseFailFastIntegerBoundedNumberConfig({
    env,
    envKey: 'ORDER_MONITOR_PRICE_UPDATE_INTERVAL',
    defaultValue: TRADING.DEFAULT_ORDER_MONITOR_PRICE_UPDATE_INTERVAL,
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
  const morningOpenProtectionMinutes = morningOpenProtectionEnabled
    ? parseNumericConfig({
        env,
        envKey: 'MORNING_OPENING_PROTECTION_MINUTES',
        defaultValue: 0,
        min: 1,
        max: 60,
        integer: true,
        nullable: true,
      })
    : null;
  const afternoonOpenProtectionEnabled = getBooleanConfig(
    env,
    'AFTERNOON_OPENING_PROTECTION_ENABLED',
    false,
  );
  const afternoonOpenProtectionMinutes = afternoonOpenProtectionEnabled
    ? parseNumericConfig({
        env,
        envKey: 'AFTERNOON_OPENING_PROTECTION_MINUTES',
        defaultValue: 0,
        min: 1,
        max: 60,
        integer: true,
        nullable: true,
      })
    : null;
  const tradingOrderType = parseTradingOrderType(env, 'TRADING_ORDER_TYPE', 'ELO');
  const liquidationOrderType = parseTradingOrderType(env, 'LIQUIDATION_ORDER_TYPE', 'MO');

  return {
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
  };
}
