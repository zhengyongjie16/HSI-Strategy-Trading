/**
 * 指标画像收集器。
 * 类型用途：在指标画像编译阶段累计家族开关与周期集合，供 compileIndicatorUsageProfile 及其内部流程共享。
 * 数据来源：由指标画像编译流程在运行时初始化并逐步填充。
 * 使用范围：仅 indicators/profile 子模块内部使用。
 */
export type IndicatorCollector = {
  readonly requiredFamilies: {
    mfi: boolean;
    kdj: boolean;
    macd: boolean;
    adx: boolean;
  };
  readonly requiredPeriods: {
    readonly rsi: Set<number>;
    readonly ema: Set<number>;
    readonly psy: Set<number>;
  };
};

/**
 * 指标画像中的指标名称。
 * 类型用途：统一表达运行时可计算的指标键，供展示与延迟验证等链路复用。
 * 数据来源：由 策略私有 signalConfig / verification 编译生成。
 * 使用范围：当前策略的 profile、显示和验证模块。
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
 * 延迟验证支持的指标名称集合。
 * 类型用途：约束延迟验证链路可配置的指标键，避免将仅用于信号求值/展示的指标（如 RSI/MFI）误用于延迟验证。
 * 数据来源：由 verificationConfig 编译生成。
 * 使用范围：当前策略的 profile 和私有验证链路。
 */
export type VerificationIndicator =
  'K' | 'D' | 'J' | 'MACD' | 'DIF' | 'DEA' | 'ADX' | `EMA:${number}` | `PSY:${number}`;

/**
 * 指标展示项。
 * 类型用途：定义监控日志输出顺序中的单个展示元素，包含价格/涨跌幅与技术指标项。
 * 数据来源：由 indicatorProfile.displayPlan 编译生成。
 * 使用范围：当前策略的显示投影。
 */
export type DisplayIndicatorItem = 'price' | 'changePercent' | ProfileIndicator;

/**
 * 监控标的指标画像。
 * 类型用途：描述单标的在运行期需要计算、校验、延迟验证和展示的指标范围，是全链路唯一输入。
 * 数据来源：策略 prepare 阶段由 signalConfig + verificationConfig 生成。
 * 使用范围：当前策略的指标运行态、显示与验证。
 */
export type IndicatorUsageProfile = {
  /** 指标族使用开关（族展开后） */
  readonly requiredFamilies: {
    readonly mfi: boolean;
    readonly kdj: boolean;
    readonly macd: boolean;
    readonly adx: boolean;
  };

  /** 周期指标集合（去重排序后） */
  readonly requiredPeriods: {
    readonly rsi: ReadonlyArray<number>;
    readonly ema: ReadonlyArray<number>;
    readonly psy: ReadonlyArray<number>;
  };

  /** 延迟验证按买卖方向要求存在的指标集合（与配置粒度一致） */
  readonly verificationIndicatorsBySide: {
    readonly buy: ReadonlyArray<VerificationIndicator>;
    readonly sell: ReadonlyArray<VerificationIndicator>;
  };

  /** 指标展示计划（最终展示顺序） */
  readonly displayPlan: ReadonlyArray<DisplayIndicatorItem>;
};
