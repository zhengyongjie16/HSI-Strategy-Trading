/** 策略 DSL 解析：保持旧条件组、空 OR 段与阈值接受域。 */
import { SIGNAL_CONFIG_SUPPORTED_INDICATORS } from './constants.js';
import { validatePsyPeriod, validateRsiPeriod } from './indicatorHelpers/utils.js';
import type {
  ComparisonOperator,
  ParsedCondition,
  ParsedConditionGroup,
  ConditionGroup,
  SignalConfig,
} from './types.js';

/**
 * 类型保护：判断字符串是否为支持的比较运算符（< 或 >）。
 *
 * @param value 待判断字符串
 * @returns true 表示是合法比较运算符
 */
function isComparisonOperator(value: string): value is ComparisonOperator {
  return value === '<' || value === '>';
}

/**
 * 类型保护：判断字符串是否为支持的固定指标（不含 RSI/PSY 动态周期指标）。
 *
 * @param value 指标名称
 * @returns true 表示属于固定指标集合
 */
function isSupportedFixedIndicator(
  value: string,
): value is (typeof SIGNAL_CONFIG_SUPPORTED_INDICATORS)[number] {
  const supportedIndicators: ReadonlyArray<string> = SIGNAL_CONFIG_SUPPORTED_INDICATORS;
  return supportedIndicators.includes(value);
}

/**
 * 解析单个信号条件字符串，支持 RSI:n、PSY:n 及固定指标（K、D、J、MFI）格式。
 *
 * @param conditionStr 条件字符串，如 "RSI:6<20"、"PSY:12<25"、"J<-1"
 * @returns 解析后的 ParsedCondition，格式无效时返回 null
 */
function parseCondition(conditionStr: string): ParsedCondition | null {
  const trimmed = conditionStr.trim();
  if (!trimmed) {
    return null;
  }

  const rsiRegex = /^RSI:(\d+)\s*([<>])\s*(-?\d+(?:\.\d+)?)$/;
  const rsiMatch = rsiRegex.exec(trimmed);

  if (rsiMatch) {
    const [, periodStr, operator, thresholdStr] = rsiMatch;

    if (!periodStr || !operator || !thresholdStr) {
      return null;
    }

    const period = Number.parseInt(periodStr, 10);
    const threshold = Number.parseFloat(thresholdStr);
    if (
      !validateRsiPeriod(period) ||
      !Number.isFinite(threshold) ||
      !isComparisonOperator(operator)
    ) {
      return null;
    }

    return { indicator: 'RSI', period, operator, threshold };
  }

  const psyRegex = /^PSY:(\d+)\s*([<>])\s*(-?\d+(?:\.\d+)?)$/;
  const psyMatch = psyRegex.exec(trimmed);

  if (psyMatch) {
    const [, periodStr, operator, thresholdStr] = psyMatch;

    if (!periodStr || !operator || !thresholdStr) {
      return null;
    }

    const period = Number.parseInt(periodStr, 10);
    const threshold = Number.parseFloat(thresholdStr);
    if (
      !validatePsyPeriod(period) ||
      !Number.isFinite(threshold) ||
      !isComparisonOperator(operator)
    ) {
      return null;
    }

    return { indicator: 'PSY', period, operator, threshold };
  }

  const matchRegex = /^([A-Z]+)\s*([<>])\s*(-?\d+(?:\.\d+)?)$/;
  const match = matchRegex.exec(trimmed);
  if (!match) {
    return null;
  }

  const [, indicator, operator, thresholdStr] = match;
  if (!indicator || !operator || !thresholdStr) {
    return null;
  }

  const threshold = Number.parseFloat(thresholdStr);
  if (
    !isSupportedFixedIndicator(indicator) ||
    !Number.isFinite(threshold) ||
    !isComparisonOperator(operator)
  ) {
    return null;
  }

  return { indicator, operator, threshold };
}

/**
 * 解析条件组字符串，支持 "(条件列表)/N" 或 "(条件列表)" 格式，逗号分隔多条件。
 *
 * @param groupStr 条件组字符串，如 "(RSI:6<20,MFI<15,D<20,J<-1)/3" 或 "(J<-20)"
 * @returns 解析后的 ParsedConditionGroup（conditions + minSatisfied），格式无效时返回 null
 */
function parseConditionGroup(groupStr: string): ParsedConditionGroup | null {
  const trimmed = groupStr.trim();
  if (!trimmed) {
    return null;
  }

  let conditionsStr: string;
  let minSatisfied: number | null = null;

  const bracketRegex = /^\(([^)]+)\)(?:\/(\d+))?$/;
  const bracketMatch = bracketRegex.exec(trimmed);

  if (bracketMatch) {
    const capturedConditions = bracketMatch[1];
    if (!capturedConditions) {
      return null;
    }

    conditionsStr = capturedConditions;
    const minSatisfiedStr = bracketMatch[2];
    minSatisfied = minSatisfiedStr ? Number.parseInt(minSatisfiedStr, 10) : null;
  } else {
    conditionsStr = trimmed;
  }

  const conditionStrs = conditionsStr.split(',');
  const conditions: ParsedCondition[] = [];

  for (const condStr of conditionStrs) {
    const condition = parseCondition(condStr);
    if (!condition) {
      return null;
    }

    conditions.push(condition);
  }

  if (conditions.length === 0) {
    return null;
  }

  minSatisfied ??= conditions.length;
  if (minSatisfied < 1 || minSatisfied > conditions.length) {
    return null;
  }

  return {
    conditions,
    minSatisfied,
  };
}

/**
 * 将配置字符串解析为 SignalConfig。默认行为：空字符串或非字符串返回 null；超过 3 个条件组或任一条件组解析失败则整体返回 null。
 *
 * @param configStr 配置字符串，如 "(RSI:6<20,MFI<15,D<20,J<-1)/3|(J<-20)"
 * @returns 解析后的 SignalConfig，无效时返回 null
 */
export function parseSignalConfig(configStr: string | null | undefined): SignalConfig | null {
  if (!configStr || typeof configStr !== 'string') {
    return null;
  }

  const trimmed = configStr.trim();
  if (!trimmed) {
    return null;
  }

  const groupStrs = trimmed.split('|');
  if (groupStrs.length > 3) {
    return null;
  }

  const conditionGroups: ConditionGroup[] = [];

  for (const groupStr of groupStrs) {
    if (!groupStr) {
      continue;
    }

    const group = parseConditionGroup(groupStr);
    if (!group) {
      return null;
    }

    conditionGroups.push({
      conditions: group.conditions.map((condition) => ({
        indicator: condition.period
          ? `${condition.indicator}:${condition.period}`
          : condition.indicator,
        operator: condition.operator,
        threshold: condition.threshold,
      })),
      requiredCount: group.minSatisfied,
    });
  }

  if (conditionGroups.length === 0) {
    return null;
  }

  return {
    conditionGroups,
  };
}
