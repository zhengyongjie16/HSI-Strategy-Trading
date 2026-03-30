/**
 * 配置验证错误（含缺失或非法字段列表）。
 * 类型用途：封装配置解析/聚合校验失败时抛出的错误对象类型。
 * 数据来源：由 createConfigValidationError 构造，并在 fail-fast 解析路径与 validateAllConfig 聚合校验路径抛出。
 * 使用范围：供 config 模块及其调用方识别配置错误使用。
 */
export type ConfigValidationError = Error & {
  readonly name: 'ConfigValidationError';
  readonly missingFields: ReadonlyArray<string>;
};

/**
 * 运行时标的校验单条输入。
 * 类型用途：作为 validateRuntimeSymbolsFromQuotesMap 的单条校验项入参。
 * 数据来源：由运行时标的列表与校验策略映射后构造。
 * 使用范围：供 config validator 与 app 装配层共同消费的公共类型边界。
 */
export type RuntimeSymbolValidationInput = {
  readonly symbol: string;
  readonly label: string;
  readonly requireLotSize: boolean;
  readonly required: boolean;
};

/**
 * 运行时标的校验结果。
 * 类型用途：表示单次运行时标的校验的通过状态及错误/警告列表，作为 validateRuntimeSymbolsFromQuotesMap 的返回类型。
 * 数据来源：由 validateRuntimeSymbolsFromQuotesMap 返回。
 * 使用范围：供 config validator 与 app 装配层共同消费的公共类型边界。
 */
export type RuntimeSymbolValidationResult = {
  readonly valid: boolean;
  readonly errors: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<string>;
};
