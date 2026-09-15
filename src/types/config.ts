import type { OrderTypeConfig } from './signal.js';

/**
 * 数值范围配置。
 * 类型用途：表示 min/max 形式的数值区间，作为 AutoSearchConfig 中换标阈值范围等字段类型。
 * 数据来源：配置解析。
 * 使用范围：AutoSearchConfig、自动寻标等；全项目可引用。
 */
export type NumberRange = {
  readonly min: number;
  readonly max: number;
};

/**
 * 自动寻标配置（单监控标的）。
 * 类型用途：单监控标的的自动寻标/换标参数，作为 MonitorConfig.autoSearchConfig 的类型。
 * 数据来源：配置解析。
 * 使用范围：MonitorConfig、autoSymbolManager、autoSymbolFinder 等；全项目可引用。
 */
export type AutoSearchConfig = {
  /** 自动寻标开关 */
  readonly autoSearchEnabled: boolean;

  /** 牛证最低距回收价百分比阈值（内部百分比值，正值；0.35 表示 0.35%；warrantList 原始值会在边界先做单位转换） */
  readonly autoSearchMinDistancePctBull: number | null;

  /** 熊证最低距回收价百分比阈值（内部百分比值，负值；-0.35 表示 -0.35%；warrantList 原始值会在边界先做单位转换） */
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
 * 类型用途：保护性清仓后一段时间内禁止买入的策略（按分钟/半日/一日），作为 MonitorConfig.liquidationCooldown 的类型。
 * 数据来源：配置解析。
 * 使用范围：MonitorConfig、liquidationCooldown 服务等；全项目可引用。
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
 * 单个监控标的的完整配置。
 * 类型用途：单监控标的的交易标的、席位、风控参数与执行政策，作为 MonitorContext.config、BuyRiskCheckContext.config 等类型。
 * 数据来源：配置解析（环境变量/配置文件）。
 * 使用范围：MonitorContext、信号处理、风控等；全项目可引用。
 */
export type MonitorConfig = {
  /** 监控标的代码（如恒指期货） */
  readonly monitorSymbol: string;

  /** 做多标的代码（牛证） */
  readonly longSymbol: string;

  /** 做空标的代码（熊证） */
  readonly shortSymbol: string;

  /** 自动寻标配置 */
  readonly autoSearchConfig: AutoSearchConfig;

  /** 订单归属映射（stockName 缩写列表） */
  readonly orderOwnershipMapping: ReadonlyArray<string>;

  /** 单次目标交易金额 */
  readonly targetNotional: number;

  /** 单标的最大持仓市值 */
  readonly maxPositionNotional: number;

  /** 单标的最大浮亏 */
  readonly maxUnrealizedLossPerSymbol: number;

  /** 买入间隔时间（秒） */
  readonly buyIntervalSeconds: number;

  /** 保护性清仓后买入冷却配置（未配置时为 null） */
  readonly liquidationCooldown: LiquidationCooldownConfig | null;

  /** 触发买入冷却所需的保护性清仓次数（默认 1） */
  readonly liquidationTriggerLimit: number;

  /** 智能平仓开关（true 时启用三阶段智能平仓） */
  readonly smartCloseEnabled: boolean;

  /** 智能平仓第三阶段超时阈值（分钟，null 表示关闭） */
  readonly smartCloseTimeoutMinutes: number | null;
};

/**
 * 全局配置。
 * 类型用途：非监控标的特定的系统级配置（末日保护、开盘保护、订单类型与超时等），作为 TradingConfig.global 的类型。
 * 数据来源：配置解析。
 * 使用范围：主程序、doomsdayProtection、orderMonitor 等；全项目可引用。
 */
export type GlobalConfig = {
  /** 末日保护开关（买入截止 + 清仓接管） */
  readonly doomsdayProtection: boolean;

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
 * 交易配置。
 * 类型用途：系统完整配置根类型，包含唯一监控标的与全局配置，作为启动与运行期配置入参。
 * 数据来源：配置解析（环境变量/配置文件）。
 * 使用范围：启动、主程序、gate 等；全项目可引用。
 */
export type TradingConfig = {
  /** 唯一监控标的配置 */
  readonly monitor: MonitorConfig;

  /** 全局配置 */
  readonly global: GlobalConfig;
};
