import type { StrategyThresholdConfig } from './factor.js';
import type { OrderTypeConfig } from './signal.js';

/**
 * 数值范围配置。
 * 类型用途：表示 min/max 形式的数值区间，作为自动寻标和换标阈值范围等字段类型。
 * 数据来源：配置解析。
 * 使用范围：TradingConfig、StrategyConfig、自动寻标与换标相关逻辑；全项目可引用。
 */
export type NumberRange = {
  readonly min: number;
  readonly max: number;
};

/**
 * 席位模式。
 * 类型用途：表达单实例程序的席位装配方式。
 * 数据来源：配置解析（SEAT_MODE）。
 * 使用范围：TradingConfig、StrategyConfig、席位恢复与自动寻标相关逻辑；全项目可引用。
 */
export type SeatMode = 'static' | 'auto';

/**
 * 自动寻标配置。
 * 类型用途：单实例策略下的自动寻标与换标参数，作为 StrategyConfig.autoSearchConfig 的类型。
 * 数据来源：配置解析。
 * 使用范围：StrategyConfig、autoSymbolManager、autoSymbolFinder 等；全项目可引用。
 */
export type AutoSearchConfig = {
  /** 自动寻标开关（由 seatMode 派生） */
  readonly autoSearchEnabled: boolean;

  /** 牛证最低距回收价百分比阈值（内部百分比值，正值；0.35 表示 0.35%） */
  readonly autoSearchMinDistancePctBull: number | null;

  /** 熊证最低距回收价百分比阈值（内部百分比值，负值；-0.35 表示 -0.35%） */
  readonly autoSearchMinDistancePctBear: number | null;

  /** 牛证分均成交额阈值 */
  readonly autoSearchMinTurnoverPerMinuteBull: number | null;

  /** 熊证分均成交额阈值 */
  readonly autoSearchMinTurnoverPerMinuteBear: number | null;

  /** 到期日最小月份 */
  readonly autoSearchExpiryMinMonths: number;

  /** 开盘延迟分钟数（仅早盘生效） */
  readonly autoSearchOpenDelayMinutes: number;

  /** 周期换标间隔（分钟，0 表示关闭） */
  readonly switchIntervalMinutes: number;

  /** 牛证距回收价换标阈值范围（内部百分比值，含边界触发） */
  readonly switchDistanceRangeBull: NumberRange | null;

  /** 熊证距回收价换标阈值范围（内部百分比值，含边界触发） */
  readonly switchDistanceRangeBear: NumberRange | null;
};

/**
 * 保护性清仓后的买入冷却配置。
 * 类型用途：保护性清仓后一段时间内禁止买入的策略（按分钟/半日/一日），作为 StrategyConfig.liquidationCooldown 的类型。
 * 数据来源：配置解析。
 * 使用范围：StrategyConfig、liquidationCooldown 服务等；全项目可引用。
 */
export type LiquidationCooldownConfig =
  | {
      readonly mode: 'minutes';
      readonly minutes: number;
    }
  | {
      readonly mode: 'half-day';
    }
  | {
      readonly mode: 'one-day';
    };

/**
 * 波动率状态阈值配置。
 * 类型用途：表达 Volatility Regime 的默认窗口与分段阈值。
 * 数据来源：配置解析。
 * 使用范围：StrategyConfig、波动率状态计算与信号规划；全项目可引用。
 */
export type RegimeThresholdConfig = {
  /** ATR 短周期 */
  readonly atrShortPeriod: number;

  /** ATR 长周期 */
  readonly atrLongPeriod: number;

  /** 同 session 波动率分位数窗口（交易日数） */
  readonly rvQuantileWindowDays: number;

  /** 趋势允许的波动率扩张阈值 */
  readonly trendOnVolExpansion: number;

  /** 趋势关闭的波动率收缩阈值 */
  readonly trendOffVolExpansion: number;

  /** 极端波动扩张阈值 */
  readonly extremeVolExpansion: number;

  /** 趋势允许的波动率分位数阈值 */
  readonly trendOnVolQuantile: number;

  /** 趋势关闭的波动率分位数阈值 */
  readonly trendOffVolQuantile: number;

  /** 极端波动分位数阈值 */
  readonly extremeVolQuantile: number;
};

/**
 * 趋势评分阈值配置。
 * 类型用途：表达多周期动量评分的权重与开平仓阈值。
 * 数据来源：配置解析。
 * 使用范围：StrategyConfig、TrendScore 计算与 Signal Planner；全项目可引用。
 */
export type TrendScoreThresholdConfig = {
  /** 15 分钟窗口权重 */
  readonly w15: number;

  /** 30 分钟窗口权重 */
  readonly w30: number;

  /** 60 分钟窗口权重 */
  readonly w60: number;

  /** 趋势分类阈值 */
  readonly classificationThreshold: number;

  /** 开仓阈值 */
  readonly entryThreshold: number;

  /** 趋势衰减退出阈值 */
  readonly exitThreshold: number;

  /** 反向失效阈值 */
  readonly reverseInvalidationThreshold: number;
};

/**
 * 推进效率阈值配置。
 * 类型用途：表达 ER 指标的开仓与退出阈值。
 * 数据来源：配置解析。
 * 使用范围：StrategyConfig、确认层与 Signal Planner；全项目可引用。
 */
export type ErThresholdConfig = {
  /** 15 分钟开仓最小效率 */
  readonly er15EntryMin: number;

  /** 30 分钟开仓最小效率 */
  readonly er30EntryMin: number;

  /** 15 分钟退出最大效率 */
  readonly er15ExitMax: number;

  /** 30 分钟退出最大效率 */
  readonly er30ExitMax: number;

  /** 强趋势效率下限 */
  readonly strongTrendErFloor: number;
};

/**
 * VWAP 确认阈值配置。
 * 类型用途：表达 session VWAP 的距离带、斜率与穿越次数阈值。
 * 数据来源：配置解析。
 * 使用范围：StrategyConfig、确认层与 Signal Planner；全项目可引用。
 */
export type VwapConfirmRulesConfig = {
  /** 价格贴近 VWAP 的 ATR 倍数带宽 */
  readonly distanceBandAtr: number;

  /** VWAP 斜率估计窗口（1m bar 数） */
  readonly slopeWindowBars: number;

  /** 最近 10 分钟允许的 VWAP 穿越次数上限 */
  readonly maxCrossCountLast10m: number;
};

/**
 * 开盘结构阈值配置。
 * 类型用途：表达开盘区间、早盘噪音与午盘重估窗口。
 * 数据来源：配置解析。
 * 使用范围：StrategyConfig、Opening Structure 计算与 Signal Planner；全项目可引用。
 */
export type OpeningStructureRulesConfig = {
  /** 开盘区间窗口（分钟） */
  readonly openingRangeMinutes: number;

  /** 突破评分下限 */
  readonly breakoutScoreMin: number;

  /** 突破后持续观察窗口（1m bar 数） */
  readonly outsidePersistenceWindowBars: number;

  /** 突破后区间外停留比例下限 */
  readonly outsidePersistenceMin: number;

  /** 回踩容忍 ATR 倍数 */
  readonly retestToleranceAtr: number;

  /** 确认所需连续同向 bar 数 */
  readonly confirmBars: number;

  /** 早盘噪音窗口（分钟） */
  readonly morningNoiseWindowMinutes: number;

  /** 午盘噪音窗口（分钟） */
  readonly afternoonNoiseWindowMinutes: number;
};

/**
 * 午后延续阈值配置。
 * 类型用途：表达上午推进、午休保持与午后再扩张的判断阈值。
 * 数据来源：配置解析。
 * 使用范围：StrategyConfig、午后延续因子与 Signal Planner；全项目可引用。
 */
export type PmContinuationRulesConfig = {
  /** 上午推进 z 分数下限 */
  readonly amMoveZMin: number;

  /** 午休后至少保留上午推进的比例 */
  readonly middayHoldMin: number;

  /** 午后重新扩张所需的趋势评分下限 */
  readonly pmReExpansionTrendScoreMin: number;

  /** 午后重新扩张所需的 ER 15m 下限 */
  readonly pmReExpansionEr15Min: number;

  /** 午后延续最早确认时间（HH:MM） */
  readonly pmConfirmCutoffTime: string;
};

/**
 * 交易标的适配阈值配置。
 * 类型用途：表达执行载体的买入风控与静态清仓阈值。
 * 数据来源：配置解析。
 * 使用范围：StrategyConfig、Instrument Adaptation Gate 与自动寻标；全项目可引用。
 */
export type InstrumentAdaptationRulesConfig = {
  /** 牛证买入最小距回收价百分比 */
  readonly bullBuyMinDistancePct: number;

  /** 熊证买入最大距回收价百分比 */
  readonly bearBuyMaxDistancePct: number;

  /** 牛证清仓距离回收价百分比 */
  readonly bullLiquidationDistancePct: number;

  /** 熊证清仓距离回收价百分比 */
  readonly bearLiquidationDistancePct: number;
};

/**
 * 单实例策略配置。
 * 类型用途：表达程序的席位模式、交易参数、自动寻标参数与所有策略阈值。
 * 数据来源：配置解析（环境变量/配置文件）。
 * 使用范围：启动、主程序、风控、策略与席位相关逻辑；全项目可引用。
 */
export type StrategyConfig = {
  /** 席位模式 */
  readonly seatMode: SeatMode;

  /** 做多标的代码（静态模式必填，自动模式可为空） */
  readonly longSymbol: string | null;

  /** 做空标的代码（静态模式必填，自动模式可为空） */
  readonly shortSymbol: string | null;

  /** 自动寻标配置 */
  readonly autoSearchConfig: AutoSearchConfig;

  /** 订单归属映射（stockName 缩写列表） */
  readonly orderOwnershipMapping: ReadonlyArray<string>;

  /** 单次目标交易金额 */
  readonly targetNotional: number;

  /** 执行标的最大持仓市值 */
  readonly maxPositionNotional: number;

  /** 每个执行标的独立最大浮亏 */
  readonly maxUnrealizedLossPerSymbol: number;

  /** 买入间隔时间（秒） */
  readonly buyIntervalSeconds: number;

  /** 保护性清仓后买入冷却配置（未配置时为 null） */
  readonly liquidationCooldown: LiquidationCooldownConfig | null;

  /** 触发买入冷却所需的保护性清仓次数（默认 1） */
  readonly liquidationTriggerLimit: number;

  /** 波动率状态阈值 */
  readonly regimeThresholds: RegimeThresholdConfig;

  /** 趋势评分阈值 */
  readonly trendScoreThresholds: TrendScoreThresholdConfig;

  /** 推进效率阈值 */
  readonly erThresholds: ErThresholdConfig;

  /** VWAP 确认阈值 */
  readonly vwapConfirmRules: VwapConfirmRulesConfig;

  /** 开盘结构阈值 */
  readonly openingStructureRules: OpeningStructureRulesConfig;

  /** 午后延续阈值 */
  readonly pmContinuationRules: PmContinuationRulesConfig;

  /** 交易标的适配阈值 */
  readonly instrumentAdaptationRules: InstrumentAdaptationRulesConfig;
};

/**
 * 全局配置。
 * 类型用途：非策略特定的系统级配置（末日保护、开盘保护、订单类型与超时等），作为 TradingConfig.global 的类型。
 * 数据来源：配置解析。
 * 使用范围：主程序、doomsdayProtection、orderMonitor 等；全项目可引用。
 */
export type GlobalConfig = {
  /** 末日保护开关（收盘前清仓） */
  readonly doomsdayProtection: boolean;

  /** 调试模式 */
  readonly debug: boolean;

  /** 开盘保护配置（早盘 + 午盘） */
  readonly openProtection: {
    /** 早盘开盘保护 */
    readonly morning: {
      /** 是否启用早盘开盘保护 */
      readonly enabled: boolean;

      /** 保护时长（分钟） */
      readonly minutes: number | null;
    };

    /** 午盘开盘保护 */
    readonly afternoon: {
      /** 是否启用午盘开盘保护 */
      readonly enabled: boolean;

      /** 保护时长（分钟） */
      readonly minutes: number | null;
    };
  };

  /** 订单价格修改最小间隔（秒） */
  readonly orderMonitorPriceUpdateInterval: number;

  /** 买单跟价是否允许高于初始委托价 */
  readonly allowBuyOrderTrackingAboveInitialPrice: boolean;

  /** 正常交易订单类型 */
  readonly tradingOrderType: OrderTypeConfig;

  /** 清仓订单类型 */
  readonly liquidationOrderType: OrderTypeConfig;

  /** 买入订单超时配置 */
  readonly buyOrderTimeout: {
    /** 是否启用超时检测 */
    readonly enabled: boolean;

    /** 超时时间（秒） */
    readonly timeoutSeconds: number;
  };

  /** 卖出订单超时配置 */
  readonly sellOrderTimeout: {
    /** 是否启用超时检测 */
    readonly enabled: boolean;

    /** 超时时间（秒） */
    readonly timeoutSeconds: number;
  };
};

/**
 * 单实例交易配置根对象。
 * 类型用途：表达程序的完整配置根，包含固定基础对象、全局配置与策略配置。
 * 数据来源：配置解析（环境变量/配置文件）。
 * 使用范围：启动、主程序、门禁、策略与风控装配；全项目可引用。
 */
export type TradingConfig = {
  /** 固定基础对象代码，由程序内部 preset 提供 */
  readonly baseInstrument: string;

  /** 全局配置 */
  readonly global: GlobalConfig;

  /** 单实例策略配置 */
  readonly strategy: StrategyConfig;
};

/**
 * 单实例运行时监控配置。
 * 类型用途：表达主程序、风控、席位与执行链路实际消费的单监控运行时配置。
 * 数据来源：由 TradingConfig 在启动装配阶段投影生成。
 * 使用范围：app、main、core、services 与相关测试；全项目可引用。
 */
export type StrategyRuntimeConfig = {
  readonly baseInstrumentSymbol: string;
  readonly longSymbol: string;
  readonly shortSymbol: string;
  readonly autoSearchConfig: AutoSearchConfig;
  readonly orderOwnershipMapping: ReadonlyArray<string>;
  readonly targetNotional: number;
  readonly maxPositionNotional: number;
  readonly maxUnrealizedLossPerSymbol: number;
  readonly buyIntervalSeconds: number;
  readonly liquidationCooldown: LiquidationCooldownConfig | null;
  readonly liquidationTriggerLimit: number;
  readonly seatMode: SeatMode;
  readonly strategyConfig: StrategyThresholdConfig;
};
