import type { KDJIndicator } from './runtime/types.js';
import type { IndicatorUsageProfile } from './profile/types.js';
import type { StrategyDecision } from '../types.js';

/**
 * 信号触发条件。
 * 类型用途：单条指标的触发规则（指标名、比较符、阈值），作为 ConditionGroup.conditions 元素类型。
 * 数据来源：配置解析（策略 JSON signals）。
 * 使用范围：信号配置解析与条件评估；仅当前策略私有模块与直接测试引用。
 */
export type Condition = {
  /** 指标名称（如 "RSI:6"、"PSY:12"、"MFI"、"K"、"D"、"J"） */
  readonly indicator: string;

  /** 比较运算符 */
  readonly operator: '<' | '>';

  /** 阈值 */
  readonly threshold: number;
};

/**
 * 条件组。
 * 类型用途：一组条件及需满足的数量要求，作为 SignalConfig.conditionGroups 元素类型；组内为"满足 N 项"，组间为 OR（满足任一组即可触发）。
 * 数据来源：配置解析（策略 JSON signals）。
 * 使用范围：信号配置解析与条件评估；仅当前策略私有模块与直接测试引用。
 */
export type ConditionGroup = {
  /** 条件列表 */
  readonly conditions: ReadonlyArray<Condition>;

  /** 需满足的条件数量（null 表示全部满足） */
  readonly requiredCount: number | null;
};

/**
 * 信号配置。
 * 类型用途：单类信号（买多/卖多/买空/卖空）的触发条件组合，作为 SignalConfigSet 各键的类型。
 * 数据来源：配置解析（策略 JSON signals）。
 * 使用范围：策略、信号条件评估等；仅当前策略私有模块与直接测试引用。
 */
export type SignalConfig = {
  /** 条件组列表（组间为 OR 关系，满足任一组即触发） */
  readonly conditionGroups: ReadonlyArray<ConditionGroup>;
};

/**
 * MACD 指标。
 * 类型用途：表示 macd/dif/dea，用于趋势判断，作为 IndicatorSnapshot.macd 及策略输入的字段类型。
 * 数据来源：指标计算（indicators 服务或 quote 层）。
 * 使用范围：IndicatorSnapshot、策略 等；仅当前策略私有模块与直接测试引用。
 */
export type MACDIndicator = {
  /** MACD 柱状图值 */
  readonly macd: number;

  /** DIF 快线（短期EMA - 长期EMA） */
  readonly dif: number;

  /** DEA 慢线（DIF 的移动平均） */
  readonly dea: number;
};

/**
 * 指标快照。
 * 类型用途：单次指标聚合结果，用于信号判断与延迟验证，作为策略与延迟验证器的入参。
 * 数据来源：由 K 线与指标运行时计算得到。
 * 使用范围：当前策略的条件判断与私有验证；仅当前策略私有模块与直接测试引用。
 */
export type IndicatorSnapshot = {
  /** 当前价格 */
  readonly price: number;

  /** 涨跌幅（百分比） */
  readonly changePercent: number | null;

  /** EMA 指数移动平均（周期 -> 值） */
  readonly ema: Readonly<Record<number, number>> | null;

  /** RSI 相对强弱指标（周期 -> 值） */
  readonly rsi: Readonly<Record<number, number>> | null;

  /** PSY 心理线指标（周期 -> 值） */
  readonly psy: Readonly<Record<number, number>> | null;

  /** MFI 资金流量指标 */
  readonly mfi: number | null;

  /** KDJ 随机指标 */
  readonly kdj: KDJIndicator | null;

  /** MACD 指标 */
  readonly macd: MACDIndicator | null;

  /** ADX 趋势强度指标 */
  readonly adx: number | null;
};

/** 四动作私有规则，由 JSON 显式解析。 */
export type SignalConfigSet = {
  readonly buycall: SignalConfig;
  readonly sellcall: SignalConfig;
  readonly buyput: SignalConfig;
  readonly sellput: SignalConfig;
};

/** 单侧验证配置，零延迟与空指标显式表示立即执行。 */
export type SingleVerificationConfig = {
  readonly delaySeconds: number;
  readonly indicators: ReadonlyArray<string>;
};

/** BUY/SELL 两侧验证政策。 */
export type VerificationConfig = {
  readonly buy: SingleVerificationConfig;
  readonly sell: SingleVerificationConfig;
};

/**
 * 比较运算符。
 * 类型用途：约束信号条件中允许的比较符，仅支持 `<` 与 `>`。
 * 数据来源：来自信号条件字符串语法定义。
 * 使用范围：仅 config 模块内部解析与校验流程使用。
 */
export type ComparisonOperator = '<' | '>';

/**
 * 解析后的单条条件。
 * 类型用途：表示从信号配置字符串中解析出的单个指标比较条件。
 * 数据来源：由 parseCondition 解析配置字符串得到。
 * 使用范围：仅 config 模块内部 signalConfig 解析流程使用。
 */
export type ParsedCondition = {
  readonly indicator: string;
  readonly period?: number;
  readonly operator: ComparisonOperator;
  readonly threshold: number;
};

/**
 * 解析后的条件组。
 * 类型用途：表示一组条件及其最少满足数量，用于信号配置解析结果的中间表达。
 * 数据来源：由 parseConditionGroup 解析配置字符串得到。
 * 使用范围：仅 config 模块内部 signalConfig 解析流程使用。
 */
export type ParsedConditionGroup = {
  readonly conditions: ReadonlyArray<ParsedCondition>;
  readonly minSatisfied: number;
};

/** 条件组评估结果，来自本轮指标比较。 */
export type ConditionGroupResult = { readonly satisfied: boolean; readonly count: number };

/** 动作表达式评估结果，原因仅用于显示。 */
export type EvaluationResult = { readonly triggered: boolean; readonly reason: string };

/** 已验证并冻结的配置及用途画像，仅由 prepare 捕获。 */
export type StrategyConfig = {
  readonly signals: Readonly<Record<StrategyDecision['action'], string>>;
  readonly signalConfig: SignalConfigSet;
  readonly verification: VerificationConfig;
  readonly profile: IndicatorUsageProfile;
};
