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
import {
  createConfigValidationError,
  getStringConfig,
  parseLiquidationCooldownConfig,
  parseNumberRangeConfig,
  parseOrderOwnershipMapping,
} from '../utils.js';
import type { BoundedNumberConfig, MinimumNumberConfig } from './types.js';

/**
 * 解析数值配置的通用内部实现。
 *
 * @param options 解析参数
 * @returns 合法数值；配置缺失且未提供 defaultValue 时返回 null
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
  readonly defaultValue?: number;
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

    if (nullable || defaultValue === undefined) {
      return null;
    }

    return defaultValue;
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
 * 解析 HH:MM 形式的必填时间配置。
 *
 * @param env 进程环境变量对象
 * @param envKey 环境变量键名
 * @returns 合法的 HH:MM 时间字符串
 */
function parseRequiredTimeOfDayConfig(env: NodeJS.ProcessEnv, envKey: string): string {
  const value = getStringConfig(env, envKey);
  if (!value) {
    throw createConfigValidationError(`[配置错误] ${envKey} 未配置`, [envKey]);
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
 * 解析布尔配置的必填版本。
 *
 * @param env 进程环境变量对象
 * @param envKey 环境变量键名
 * @returns 合法布尔值
 */
function parseRequiredBooleanConfig(env: NodeJS.ProcessEnv, envKey: string): boolean {
  const value = getStringConfig(env, envKey);
  if (!value) {
    throw createConfigValidationError(`[配置错误] ${envKey} 未配置`, [envKey]);
  }

  const normalizedValue = value.toLowerCase();
  if (normalizedValue === 'true') {
    return true;
  }

  if (normalizedValue === 'false') {
    return false;
  }

  throw createConfigValidationError(`[配置错误] ${envKey} 无效（必须为 true 或 false）`, [envKey]);
}

/**
 * 解析可选清仓冷却配置：缺失时允许为空，显式非法时立即失败。
 *
 * @param env 进程环境变量对象
 * @param envKey 环境变量键名
 * @returns 合法冷却配置；缺失时返回 null
 */
function parseOptionalLiquidationCooldownConfig(
  env: NodeJS.ProcessEnv,
  envKey: string,
): StrategyConfig['liquidationCooldown'] {
  const rawValue = getStringConfig(env, envKey);
  if (rawValue === null) {
    return null;
  }

  const cooldown = parseLiquidationCooldownConfig(env, envKey);
  if (cooldown !== null) {
    return cooldown;
  }

  throw createConfigValidationError(
    `[配置错误] ${envKey} 无效（必须为 1-120 分钟、half-day 或 one-day）`,
    [envKey],
  );
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
 * 解析席位模式。
 *
 * @param env 进程环境变量对象
 * @returns 单实例席位模式
 */
function parseSeatModeConfig(env: NodeJS.ProcessEnv): SeatMode {
  const value = getStringConfig(env, 'SEAT_MODE');
  if (!value) {
    throw createConfigValidationError('[配置错误] SEAT_MODE 未配置', ['SEAT_MODE']);
  }

  if (value === 'static' || value === 'auto') {
    return value;
  }

  throw createConfigValidationError('[配置错误] SEAT_MODE 无效（必须为 static 或 auto）', [
    'SEAT_MODE',
  ]);
}

/**
 * 解析关键数值配置：缺失或显式非法时立即失败。
 *
 * @param options 包含 env、envKey、min、max 的配置对象
 * @returns 合法范围内的数值
 */
function parseFailFastBoundedNumberConfig({ env, envKey, min, max }: BoundedNumberConfig): number {
  return parseRequiredNumericConfig({
    env,
    envKey,
    min,
    max,
  });
}

/**
 * 解析关键整数配置：缺失或显式非法、非整数、越界时立即失败。
 *
 * @param options 包含 env、envKey、min、max 的配置对象
 * @returns 合法范围内的整数
 */
function parseFailFastIntegerBoundedNumberConfig({
  env,
  envKey,
  min,
  max,
}: BoundedNumberConfig): number {
  return parseRequiredNumericConfig({
    env,
    envKey,
    min,
    max,
    integer: true,
  });
}

/**
 * 解析关键数值配置：缺失或显式非法、小于下限时立即失败。
 *
 * @param options 包含 env、envKey、min 的配置对象
 * @returns 大于等于 min 的合法数值
 */
function parseFailFastMinimumNumberConfig({ env, envKey, min }: MinimumNumberConfig): number {
  return parseRequiredNumericConfig({
    env,
    envKey,
    min,
    max: Number.POSITIVE_INFINITY,
  });
}

/**
 * 解析交易订单类型配置。
 *
 * @param env 进程环境变量对象
 * @param envKey 环境变量键名
 * @returns 内部订单类型配置
 */
function parseRequiredTradingOrderType(env: NodeJS.ProcessEnv, envKey: string): OrderTypeConfig {
  const value = getStringConfig(env, envKey);
  if (!value) {
    throw createConfigValidationError(`[配置错误] ${envKey} 未配置`, [envKey]);
  }

  if (value === 'LO' || value === 'ELO' || value === 'MO') {
    return value;
  }

  throw createConfigValidationError(`[配置错误] ${envKey} 无效（必须为 LO、ELO 或 MO）`, [envKey]);
}

/**
 * 解析自动寻标配置。
 *
 * @param env 进程环境变量对象
 * @param seatMode 席位模式
 * @returns 自动寻标配置
 */
function parseAutoSearchConfig(env: NodeJS.ProcessEnv, seatMode: SeatMode): AutoSearchConfig {
  const autoSearchEnabled = seatMode === 'auto';
  if (!autoSearchEnabled) {
    return {
      autoSearchEnabled,
      autoSearchMinDistancePctBull: null,
      autoSearchMinDistancePctBear: null,
      autoSearchMinTurnoverPerMinuteBull: null,
      autoSearchMinTurnoverPerMinuteBear: null,
      autoSearchExpiryMinMonths: 0,
      autoSearchOpenDelayMinutes: 0,
      switchIntervalMinutes: 0,
      switchDistanceRangeBull: null,
      switchDistanceRangeBear: null,
    };
  }

  return {
    autoSearchEnabled,
    autoSearchMinDistancePctBull: parseRequiredNumericConfig({
      env,
      envKey: 'AUTO_SEARCH_MIN_DISTANCE_PCT_BULL',
      min: 0,
      max: 10,
    }),
    autoSearchMinDistancePctBear: parseRequiredNumericConfig({
      env,
      envKey: 'AUTO_SEARCH_MIN_DISTANCE_PCT_BEAR',
      min: -10,
      max: 0,
    }),
    autoSearchMinTurnoverPerMinuteBull: parseRequiredNumericConfig({
      env,
      envKey: 'AUTO_SEARCH_MIN_TURNOVER_PER_MINUTE_BULL',
      min: 1,
      max: Number.POSITIVE_INFINITY,
    }),
    autoSearchMinTurnoverPerMinuteBear: parseRequiredNumericConfig({
      env,
      envKey: 'AUTO_SEARCH_MIN_TURNOVER_PER_MINUTE_BEAR',
      min: 1,
      max: Number.POSITIVE_INFINITY,
    }),
    autoSearchExpiryMinMonths: parseRequiredNumericConfig({
      env,
      envKey: 'AUTO_SEARCH_EXPIRY_MIN_MONTHS',
      min: 1,
      max: 120,
      integer: true,
    }),
    autoSearchOpenDelayMinutes: parseRequiredNumericConfig({
      env,
      envKey: 'AUTO_SEARCH_OPEN_DELAY_MINUTES',
      min: 0,
      max: 60,
      integer: true,
    }),
    switchIntervalMinutes: parseRequiredNumericConfig({
      env,
      envKey: 'SWITCH_INTERVAL_MINUTES',
      min: 0,
      max: 120,
      integer: true,
    }),
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
function parseRegimeThresholdConfig(env: NodeJS.ProcessEnv): RegimeThresholdConfig {
  return {
    atrShortPeriod: parseFailFastIntegerBoundedNumberConfig({
      env,
      envKey: 'REGIME_THRESHOLDS_ATR_SHORT_PERIOD',
      min: 1,
      max: 250,
    }),
    atrLongPeriod: parseFailFastIntegerBoundedNumberConfig({
      env,
      envKey: 'REGIME_THRESHOLDS_ATR_LONG_PERIOD',
      min: 1,
      max: 250,
    }),
    rvQuantileWindowDays: parseFailFastIntegerBoundedNumberConfig({
      env,
      envKey: 'REGIME_THRESHOLDS_RV_QUANTILE_WINDOW_DAYS',
      min: 1,
      max: 250,
    }),
    trendOnVolExpansion: parseFailFastBoundedNumberConfig({
      env,
      envKey: 'REGIME_THRESHOLDS_TREND_ON_VOL_EXPANSION',
      min: 0,
      max: 10,
    }),
    trendOffVolExpansion: parseFailFastBoundedNumberConfig({
      env,
      envKey: 'REGIME_THRESHOLDS_TREND_OFF_VOL_EXPANSION',
      min: 0,
      max: 10,
    }),
    extremeVolExpansion: parseFailFastBoundedNumberConfig({
      env,
      envKey: 'REGIME_THRESHOLDS_EXTREME_VOL_EXPANSION',
      min: 0,
      max: 10,
    }),
    trendOnVolQuantile: parseFailFastBoundedNumberConfig({
      env,
      envKey: 'REGIME_THRESHOLDS_TREND_ON_VOL_QUANTILE',
      min: 0,
      max: 1,
    }),
    trendOffVolQuantile: parseFailFastBoundedNumberConfig({
      env,
      envKey: 'REGIME_THRESHOLDS_TREND_OFF_VOL_QUANTILE',
      min: 0,
      max: 1,
    }),
    extremeVolQuantile: parseFailFastBoundedNumberConfig({
      env,
      envKey: 'REGIME_THRESHOLDS_EXTREME_VOL_QUANTILE',
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
function parseTrendScoreThresholdConfig(env: NodeJS.ProcessEnv): TrendScoreThresholdConfig {
  return {
    w15: parseFailFastBoundedNumberConfig({
      env,
      envKey: 'TREND_SCORE_THRESHOLDS_W15',
      min: 0,
      max: 1,
    }),
    w30: parseFailFastBoundedNumberConfig({
      env,
      envKey: 'TREND_SCORE_THRESHOLDS_W30',
      min: 0,
      max: 1,
    }),
    w60: parseFailFastBoundedNumberConfig({
      env,
      envKey: 'TREND_SCORE_THRESHOLDS_W60',
      min: 0,
      max: 1,
    }),
    classificationThreshold: parseFailFastBoundedNumberConfig({
      env,
      envKey: 'TREND_SCORE_THRESHOLDS_CLASSIFICATION_THRESHOLD',
      min: 0,
      max: 10,
    }),
    entryThreshold: parseFailFastBoundedNumberConfig({
      env,
      envKey: 'TREND_SCORE_THRESHOLDS_ENTRY_THRESHOLD',
      min: 0,
      max: 10,
    }),
    exitThreshold: parseFailFastBoundedNumberConfig({
      env,
      envKey: 'TREND_SCORE_THRESHOLDS_EXIT_THRESHOLD',
      min: 0,
      max: 10,
    }),
    reverseInvalidationThreshold: parseFailFastBoundedNumberConfig({
      env,
      envKey: 'TREND_SCORE_THRESHOLDS_REVERSE_INVALIDATION_THRESHOLD',
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
function parseErThresholdConfig(env: NodeJS.ProcessEnv): ErThresholdConfig {
  return {
    er15EntryMin: parseFailFastBoundedNumberConfig({
      env,
      envKey: 'ER_THRESHOLDS_ER15_ENTRY_MIN',
      min: 0,
      max: 10,
    }),
    er30EntryMin: parseFailFastBoundedNumberConfig({
      env,
      envKey: 'ER_THRESHOLDS_ER30_ENTRY_MIN',
      min: 0,
      max: 10,
    }),
    er15ExitMax: parseFailFastBoundedNumberConfig({
      env,
      envKey: 'ER_THRESHOLDS_ER15_EXIT_MAX',
      min: 0,
      max: 10,
    }),
    er30ExitMax: parseFailFastBoundedNumberConfig({
      env,
      envKey: 'ER_THRESHOLDS_ER30_EXIT_MAX',
      min: 0,
      max: 10,
    }),
    strongTrendErFloor: parseFailFastBoundedNumberConfig({
      env,
      envKey: 'ER_THRESHOLDS_STRONG_TREND_ER_FLOOR',
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
function parseVwapConfirmRulesConfig(env: NodeJS.ProcessEnv): VwapConfirmRulesConfig {
  return {
    distanceBandAtr: parseFailFastBoundedNumberConfig({
      env,
      envKey: 'VWAP_CONFIRM_RULES_DISTANCE_BAND_ATR',
      min: 0,
      max: 1,
    }),
    slopeWindowBars: parseFailFastIntegerBoundedNumberConfig({
      env,
      envKey: 'VWAP_CONFIRM_RULES_SLOPE_WINDOW_BARS',
      min: 2,
      max: 120,
    }),
    maxCrossCountLast10m: parseFailFastIntegerBoundedNumberConfig({
      env,
      envKey: 'VWAP_CONFIRM_RULES_MAX_CROSS_COUNT_LAST10M',
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
function parseOpeningStructureRulesConfig(env: NodeJS.ProcessEnv): OpeningStructureRulesConfig {
  return {
    openingRangeMinutes: parseFailFastIntegerBoundedNumberConfig({
      env,
      envKey: 'OPENING_STRUCTURE_RULES_OR_WINDOW_MINUTES',
      min: 1,
      max: 120,
    }),
    morningNoiseWindowMinutes: parseFailFastIntegerBoundedNumberConfig({
      env,
      envKey: 'OPENING_STRUCTURE_RULES_MORNING_NOISE_WINDOW_MINUTES',
      min: 1,
      max: 120,
    }),
    afternoonNoiseWindowMinutes: parseFailFastIntegerBoundedNumberConfig({
      env,
      envKey: 'OPENING_STRUCTURE_RULES_AFTERNOON_NOISE_WINDOW_MINUTES',
      min: 1,
      max: 120,
    }),
    breakoutScoreMin: parseFailFastBoundedNumberConfig({
      env,
      envKey: 'OPENING_STRUCTURE_RULES_BREAKOUT_SCORE_MIN',
      min: 0,
      max: 10,
    }),
    outsidePersistenceWindowBars: parseFailFastIntegerBoundedNumberConfig({
      env,
      envKey: 'OPENING_STRUCTURE_RULES_OUTSIDE_PERSISTENCE_WINDOW_BARS',
      min: 1,
      max: 30,
    }),
    outsidePersistenceMin: parseFailFastBoundedNumberConfig({
      env,
      envKey: 'OPENING_STRUCTURE_RULES_OUTSIDE_PERSISTENCE_MIN',
      min: 0,
      max: 1,
    }),
    retestToleranceAtr: parseFailFastBoundedNumberConfig({
      env,
      envKey: 'OPENING_STRUCTURE_RULES_RETEST_TOLERANCE_ATR',
      min: 0,
      max: 1,
    }),
    confirmBars: parseFailFastIntegerBoundedNumberConfig({
      env,
      envKey: 'OPENING_STRUCTURE_RULES_CONFIRM_BARS',
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
function parsePmContinuationRulesConfig(env: NodeJS.ProcessEnv): PmContinuationRulesConfig {
  return {
    amMoveZMin: parseFailFastBoundedNumberConfig({
      env,
      envKey: 'PM_CONTINUATION_RULES_AM_MOVE_Z_MIN',
      min: 0,
      max: 10,
    }),
    middayHoldMin: parseFailFastBoundedNumberConfig({
      env,
      envKey: 'PM_CONTINUATION_RULES_MIDDAY_HOLD_MIN',
      min: 0,
      max: 1,
    }),
    pmReExpansionTrendScoreMin: parseFailFastBoundedNumberConfig({
      env,
      envKey: 'PM_CONTINUATION_RULES_PM_RE_EXPANSION_TREND_SCORE_MIN',
      min: 0,
      max: 10,
    }),
    pmReExpansionEr15Min: parseFailFastBoundedNumberConfig({
      env,
      envKey: 'PM_CONTINUATION_RULES_PM_RE_EXPANSION_ER15_MIN',
      min: 0,
      max: 1,
    }),
    pmConfirmCutoffTime: parseRequiredTimeOfDayConfig(
      env,
      'PM_CONTINUATION_RULES_PM_CONFIRM_CUTOFF_TIME',
    ),
  };
}

/**
 * 解析交易标的适配规则配置。
 *
 * @param env 进程环境变量对象
 * @returns 交易标的适配规则
 */
function parseInstrumentAdaptationRulesConfig(
  env: NodeJS.ProcessEnv,
): InstrumentAdaptationRulesConfig {
  return {
    bullBuyMinDistancePct: parseFailFastBoundedNumberConfig({
      env,
      envKey: 'INSTRUMENT_ADAPTATION_RULES_BULL_BUY_MIN_DISTANCE_PCT',
      min: 0,
      max: 10,
    }),
    bearBuyMaxDistancePct: parseFailFastBoundedNumberConfig({
      env,
      envKey: 'INSTRUMENT_ADAPTATION_RULES_BEAR_BUY_MAX_DISTANCE_PCT',
      min: -10,
      max: 0,
    }),
    bullLiquidationDistancePct: parseFailFastBoundedNumberConfig({
      env,
      envKey: 'INSTRUMENT_ADAPTATION_RULES_BULL_LIQUIDATION_DISTANCE_PCT',
      min: 0,
      max: 10,
    }),
    bearLiquidationDistancePct: parseFailFastBoundedNumberConfig({
      env,
      envKey: 'INSTRUMENT_ADAPTATION_RULES_BEAR_LIQUIDATION_DISTANCE_PCT',
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
      min: 1,
    }),
    maxPositionNotional: parseFailFastMinimumNumberConfig({
      env,
      envKey: 'MAX_POSITION_NOTIONAL',
      min: 1,
    }),
    maxUnrealizedLossPerSymbol: parseFailFastMinimumNumberConfig({
      env,
      envKey: 'MAX_UNREALIZED_LOSS_PER_SYMBOL',
      min: 0,
    }),
    buyIntervalSeconds: parseFailFastIntegerBoundedNumberConfig({
      env,
      envKey: 'BUY_INTERVAL_SECONDS',
      min: 10,
      max: 600,
    }),
    liquidationCooldown: parseOptionalLiquidationCooldownConfig(env, 'LIQUIDATION_COOLDOWN'),
    liquidationTriggerLimit: parseFailFastIntegerBoundedNumberConfig({
      env,
      envKey: 'LIQUIDATION_TRIGGER_LIMIT',
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
  const buyOrderTimeoutEnabled = parseRequiredBooleanConfig(env, 'BUY_ORDER_TIMEOUT_ENABLED');
  const buyOrderTimeoutSeconds = buyOrderTimeoutEnabled
    ? parseFailFastIntegerBoundedNumberConfig({
        env,
        envKey: 'BUY_ORDER_TIMEOUT_SECONDS',
        min: 30,
        max: 600,
      })
    : 0;
  const sellOrderTimeoutEnabled = parseRequiredBooleanConfig(env, 'SELL_ORDER_TIMEOUT_ENABLED');
  const sellOrderTimeoutSeconds = sellOrderTimeoutEnabled
    ? parseFailFastIntegerBoundedNumberConfig({
        env,
        envKey: 'SELL_ORDER_TIMEOUT_SECONDS',
        min: 30,
        max: 600,
      })
    : 0;
  const orderMonitorPriceUpdateInterval = parseFailFastIntegerBoundedNumberConfig({
    env,
    envKey: 'ORDER_MONITOR_PRICE_UPDATE_INTERVAL',
    min: 1,
    max: 60,
  });
  const allowBuyOrderTrackingAboveInitialPrice = parseRequiredBooleanConfig(
    env,
    'ALLOW_BUY_ORDER_TRACKING_ABOVE_INITIAL_PRICE',
  );
  const morningOpenProtectionEnabled = parseRequiredBooleanConfig(
    env,
    'MORNING_OPENING_PROTECTION_ENABLED',
  );
  const morningOpenProtectionMinutes = morningOpenProtectionEnabled
    ? parseRequiredNumericConfig({
        env,
        envKey: 'MORNING_OPENING_PROTECTION_MINUTES',
        min: 1,
        max: 60,
        integer: true,
      })
    : null;
  const afternoonOpenProtectionEnabled = parseRequiredBooleanConfig(
    env,
    'AFTERNOON_OPENING_PROTECTION_ENABLED',
  );
  const afternoonOpenProtectionMinutes = afternoonOpenProtectionEnabled
    ? parseRequiredNumericConfig({
        env,
        envKey: 'AFTERNOON_OPENING_PROTECTION_MINUTES',
        min: 1,
        max: 60,
        integer: true,
      })
    : null;
  const tradingOrderType = parseRequiredTradingOrderType(env, 'TRADING_ORDER_TYPE');
  const liquidationOrderType = parseRequiredTradingOrderType(env, 'LIQUIDATION_ORDER_TYPE');

  return {
    doomsdayProtection: parseRequiredBooleanConfig(env, 'DOOMSDAY_PROTECTION'),
    debug: parseRequiredBooleanConfig(env, 'DEBUG'),
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
