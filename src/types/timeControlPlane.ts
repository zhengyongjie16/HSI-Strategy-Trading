/**
 * 权威时间门禁的唯一可变事实，app 创建后保持对象身份不变。
 * 时间评估写入，global 清理同一对象；普通授权和 WeakMap 状态关联均读取此稳定实例。
 */
export type TradingTimeState = {
  canTrade: boolean | null;
  isHalfDay: boolean | null;
  openProtectionActive: boolean | null;
};

/**
 * 单次生命周期推进的中性时间事实。
 * 数据来源：时间唤醒评估器计算的 HK 日期、连续交易与交易日历结果；管理器只读不写。
 * 使用范围：生命周期 tick、缓存域上下文及系统级时间评估。
 */
export type LifecycleRuntimeFlags = {
  readonly dayKey: string | null;
  readonly canTradeNow: boolean;
  readonly isTradingDay: boolean | null;
};

/**
 * 生命周期 tick 已完成后返回的中性重建状态与下一次重评估时刻。
 * 数据来源：现有生命周期管理器的午夜清理与开盘重建推进，不向调用方公开内部状态。
 * 使用范围：生命周期实现与时间 planner。
 */
export type DayLifecycleTickResult = {
  readonly nextRetryAtMs: number | null;
};

/** 唯一生命周期推进的窄行为契约；调用方触发 tick，不持有缓存域、重建或完成条件。 */
export interface DayLifecycleManager {
  readonly tick: (now: Date, runtime: LifecycleRuntimeFlags) => Promise<DayLifecycleTickResult>;
}

/** 连续交易门禁的已发布变化事实，由权威时间评估写入 TradingTimeState 后同步发出。 */
export type TradingGateStateChangedEvent = {
  readonly previousCanTrade: boolean | null;
  readonly nextCanTrade: boolean;
};

/** 自动寻标授权的已发布变化事实，消费方不得复制生命周期或末日接管判断。 */
export type AutoSearchAuthorizationChangedEvent = {
  readonly previousAuthorized: boolean | null;
  readonly nextAuthorized: boolean;
};

/** 时间控制平面的窄发布能力，不向评估器暴露 listener 集合、订阅或 runtime 启停。 */
export interface TradingGatePublisher {
  readonly emitGateStateChanged: (event: TradingGateStateChangedEvent) => void;
  readonly emitAutoSearchAuthorizationChanged: (event: AutoSearchAuthorizationChangedEvent) => void;
}
