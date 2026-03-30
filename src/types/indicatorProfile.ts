/**
 * 指标画像中的指标名称。
 * 类型用途：统一表达展示层与工具脚本会消费的指标键。
 * 数据来源：由指标画像定义直接声明。
 * 使用范围：IndicatorDisplayProfile、IndicatorComputationProfile、marketMonitor 与 tools。
 */
export type ProfileIndicator =
  | 'MFI'
  | 'K'
  | 'D'
  | 'J'
  | 'MACD'
  | 'DIF'
  | 'DEA'
  | 'ADX'
  | `RSI:${number}`
  | `EMA:${number}`
  | `PSY:${number}`;

/**
 * 指标展示项。
 * 类型用途：定义监控日志输出顺序中的单个展示元素，包含价格/涨跌幅与技术指标项。
 * 数据来源：由 indicatorProfile.displayPlan 编译生成。
 * 使用范围：marketMonitor、工具脚本与展示层测试。
 */
export type DisplayIndicatorItem = 'price' | 'changePercent' | ProfileIndicator;

/**
 * 指标展示计划最小契约。
 * 类型用途：只表达展示层真正需要的 displayPlan，避免把完整画像当成运行时依赖边界。
 * 数据来源：StrategyRuntime 装配阶段生成或测试替身构造。
 * 使用范围：marketMonitor、展示层测试与轻量运行时快照。
 */
export type IndicatorDisplayProfile = {
  readonly displayPlan: ReadonlyArray<DisplayIndicatorItem>;
};

/**
 * 工具脚本指标计算画像。
 * 类型用途：描述 `tools/*` 脚本需要计算的指标范围，不参与生产运行时依赖边界。
 * 数据来源：各工具脚本按自身展示需求显式声明。
 * 使用范围：tools/indicatorRuntime、tools/dailyKlineMonitor。
 */
export type IndicatorComputationProfile = {
  /** 指标族使用开关 */
  readonly requiredFamilies: {
    readonly mfi: boolean;
    readonly kdj: boolean;
    readonly macd: boolean;
    readonly adx: boolean;
  };

  /** 周期指标集合 */
  readonly requiredPeriods: {
    readonly rsi: ReadonlyArray<number>;
    readonly ema: ReadonlyArray<number>;
    readonly psy: ReadonlyArray<number>;
  };

  /** 指标展示计划（最终展示顺序） */
  readonly displayPlan: ReadonlyArray<DisplayIndicatorItem>;
};
