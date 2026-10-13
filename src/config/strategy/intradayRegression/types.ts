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
