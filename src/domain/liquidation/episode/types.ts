/**
 * 保护性清仓事件方向。
 * 类型用途：按唯一 monitor 内的 direction 隔离保护性清仓事件状态。
 * 数据来源：订单归属解析与风控链路。
 * 使用范围：protectiveLiquidationEpisodeTracker 及其调用方。
 */
export type ProtectiveLiquidationDirection = 'LONG' | 'SHORT';

/**
 * 记录保护性清仓成交进度参数。
 * 类型用途：在保护性清仓订单产生真实成交后更新该事件最新成交时间。
 * 数据来源：settlementFlow 成交结算链路。
 * 使用范围：protectiveLiquidationEpisodeTracker。
 */
export type RecordProtectiveFillProgressParams = Readonly<{
  direction: ProtectiveLiquidationDirection;
  symbol: string;
  executedTimeMs: number;
}>;

/**
 * 保护性清仓完成确认参数。
 * 类型用途：在持仓刷新后基于“空仓 + 无未完成保护性卖单”判定事件完成。
 * 数据来源：PostTradeSettlementWorkflow 的权威持仓与 pending 事实。
 * 使用范围：episode 纯资格规则。
 */
export type PrepareProtectiveCompletionParams = Readonly<{
  direction: ProtectiveLiquidationDirection;
  isDirectionFlat: boolean;
  hasPendingProtectiveOrders: boolean;
}>;

/**
 * 待提交的保护性清仓 episode 完成事实。
 * 类型用途：完成条件验证通过后冻结事件身份，持久化成功后再提交内存状态。
 * 数据来源：prepareCompletion。
 * 使用范围：PostTradeSettlementWorkflow 完成事务。
 */
export type PreparedProtectiveLiquidationCompletion = Readonly<{
  direction: ProtectiveLiquidationDirection;
  boundaryExecutedTimeMs: number;
}>;

/**
 * 恢复已完成边界参数。
 * 类型用途：启动恢复时写入最近一次已完成保护性清仓边界。
 * 数据来源：loadTradingDayRuntimeSnapshot。
 * 使用范围：protectiveLiquidationEpisodeTracker。
 */
export type RestoreCompletedBoundaryParams = Readonly<{
  direction: ProtectiveLiquidationDirection;
  boundaryExecutedTimeMs: number;
}>;

/**
 * 恢复进行中事件参数。
 * 类型用途：启动恢复时写入已发生但未完成的保护性清仓最新成交进度。
 * 数据来源：loadTradingDayRuntimeSnapshot。
 * 使用范围：protectiveLiquidationEpisodeTracker。
 */
export type RestoreInProgressEpisodeParams = Readonly<{
  direction: ProtectiveLiquidationDirection;
  symbol: string;
  latestExecutedTimeMs: number;
}>;

/**
 * 进行中的保护性清仓事件快照。
 * 类型用途：供 settlement 读取原成交归属并独占最终完成判定。
 * 数据来源：tracking 写入的 episode 运行态。
 * 使用范围：PostTradeSettlementWorkflow。
 */
export type InProgressProtectiveEpisode = Readonly<{
  direction: ProtectiveLiquidationDirection;
  symbol: string;
  latestExecutedTimeMs: number;
}>;

/**
 * 保护性清仓事件跟踪器接口。
 * 类型用途：集中管理保护性清仓进行中事件和已完成边界，保证单次事件只完成一次。
 * 数据来源：createProtectiveLiquidationEpisodeTracker 工厂创建。
 * 使用范围：orderMonitor、成交后一致性运行时、lifecycle 恢复链路。
 */
export interface ProtectiveLiquidationEpisodeTracker {
  recordProtectiveFillProgress: (params: RecordProtectiveFillProgressParams) => void;
  prepareCompletion: (
    params: PrepareProtectiveCompletionParams,
  ) => PreparedProtectiveLiquidationCompletion | null;
  commitCompletion: (prepared: PreparedProtectiveLiquidationCompletion) => void;
  restoreCompletedBoundary: (params: RestoreCompletedBoundaryParams) => void;
  restoreInProgressEpisode: (params: RestoreInProgressEpisodeParams) => void;
  getInProgressEpisodes: () => ReadonlyArray<InProgressProtectiveEpisode>;
  resetAll: () => void;
}
