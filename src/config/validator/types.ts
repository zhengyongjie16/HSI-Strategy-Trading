/**
 * 通用配置校验结果。
 * 类型用途：表达累积的配置错误。
 * 数据来源：由 validator 模块内部各类 validate 函数返回。
 * 使用范围：仅 validator 模块内部使用。
 */
export type ValidationResult = {
  readonly errors: ReadonlyArray<string>;
};

/**
 * 标的校验上下文。
 * 类型用途：作为 validateRequiredSymbol 的入参，累积错误。
 * 数据来源：由 validator 聚合流程构造。
 * 使用范围：仅 validator 模块内部使用。
 */
export type SymbolValidationContext = {
  readonly prefix: string;
  readonly symbol: string;
  readonly envKey: string;
  readonly errors: ReadonlyArray<string>;
};
