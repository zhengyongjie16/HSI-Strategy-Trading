import type { OrderSide } from 'longbridge';
import type { MonitorConfig } from './config.js';
import type { Quote } from './quote.js';
import type {
  OrderRecord,
  OrderRecorder,
  RawOrderFromAPI,
  RiskChecker,
  Trader,
} from './services.js';
import type { OrderFilteringEngine, OrderOwnership } from './orderRecorder.js';

/**
 * 累计成交事实输入。
 * 类型用途：用于 DailyLossTracker.recordCumulativeExecution 按 orderId 幂等合并累计成交事实。
 * 数据来源：OrderMonitor 成交回调，仅在当日日键匹配时写入。
 * 使用范围：风险控制与订单监控链路；全项目可引用。
 */
export type DailyLossCumulativeExecutionInput = {
  readonly factStage: 'OPEN' | 'TERMINAL';
  readonly direction: 'LONG' | 'SHORT';
  readonly symbol: string;
  readonly side: OrderSide.Buy | OrderSide.Sell;
  readonly executedPrice: number;
  readonly executedQuantity: number;
  readonly executedTimeMs: number;
  readonly orderUpdatedAtMs: number;
  readonly orderId: string;
};

/**
 * 待持久化的累计成交权威快照。
 * 类型用途：DailyLossTracker 在提交未封存的权威成交事实前，把 progress 快照暴露给持久化边界。
 * 数据来源：recordCumulativeExecution 的单调合并结果。
 * 使用范围：SettlementFlow 保护性清仓 progress 持久化。
 */
export type DailyLossAuthoritativeFactSnapshot = Readonly<{
  factStage: 'OPEN' | 'TERMINAL';
  cumulativeQuantity: string;
  cumulativeAmount: string;
  lastExecutionTimeMs: number;
  orderRevisionMs: number;
}>;

/**
 * 启动恢复的精确累计成交快照。
 * 类型用途：将 mixed log progress 作为历史 execution snapshot 注入全量重算后的订单事实。
 * 数据来源：PROTECTIVE_LIQUIDATION_EXECUTION_PROGRESS V1。
 * 使用范围：lifecycle 启动恢复。
 */
type RestoreDailyLossExecutionSnapshotParams = Readonly<{
  factStage: 'OPEN' | 'TERMINAL';
  direction: 'LONG' | 'SHORT';
  symbol: string;
  side: OrderSide.Buy | OrderSide.Sell;
  orderId: string;
  cumulativeQuantity: string;
  cumulativeAmount: string;
  lastExecutionTimeMs: number;
  orderRevisionMs: number;
}>;

/**
 * 保护性清仓累计成交进度持久化输入。
 * 类型用途：隔离 OrderMonitor 与具体 mixed-log repository，实现持久化成功后才提交内存事实。
 * 数据来源：SettlementFlow 与 DailyLossTracker 的未封存权威成交事实快照。
 * 使用范围：Trader 装配边界。
 */
export type ProtectiveLiquidationExecutionProgressInput = Readonly<{
  monitorSymbol: string;
  direction: 'LONG' | 'SHORT';
  symbol: string;
  orderId: string;
  factStage: 'OPEN' | 'TERMINAL';
  cumulativeQuantity: string;
  cumulativeAmount: string;
  lastExecutionTimeMs: number;
  orderRevisionMs: number;
}>;

/**
 * 累计成交事实合并结果。
 * 类型用途：由 DailyLossTracker 单一判定事实是否变化、累计成交是否真实推进。
 * 数据来源：recordCumulativeExecution 比较同 orderId 的 revision、累计数量与累计金额后返回。
 * 使用范围：订单监控成交入口，用于推进保护性 episode 与刷新需求。
 */
export type DailyLossCumulativeExecutionResult = {
  readonly authoritativeFactChanged: boolean;
  readonly executionAdvanced: boolean;
};

/**
 * 开启保护性清仓新周期参数。
 * 类型用途：保护性清仓业务事件完成后推进偏移边界，刷新 per-order 累计数量与金额基线。
 * 数据来源：成交后一致性运行时在保护性清仓完成确认后传入。
 * 使用范围：风险控制链路；全项目可引用。
 */
export type StartNewProtectionEpisodeParams = {
  readonly direction: 'LONG' | 'SHORT';

  /** 最近一次已完成保护性清仓事件边界（毫秒） */
  readonly boundaryExecutedTimeMs: number;
};

/**
 * 待提交的 DailyLoss 保护边界。
 * 类型用途：在持久化前冻结 per-order baseline，持久化成功后再原子提交内存投影。
 * 数据来源：DailyLossTracker.prepareProtectionBoundary。
 * 使用范围：PostTradeConsistencyRuntime 完成协调器。
 */
export type PreparedDailyLossProtectionBoundary = Readonly<{
  direction: 'LONG' | 'SHORT';
  boundaryExecutedTimeMs: number;
  orderBaselines: ReadonlyArray<
    Readonly<{
      orderId: string;
      symbol: string;
      side: 'BUY' | 'SELL';
      cumulativeQuantity: string;
      cumulativeAmount: string;
      lastExecutionTimeMs: number;
      orderRevisionMs: number;
    }>
  >;
}>;

/**
 * 当日亏损追踪器接口。
 * 类型用途：按唯一 monitor 的 LONG/SHORT 方向维护已实现盈亏偏移，供浮亏刷新、成交处理与生命周期重建共享。
 * 数据来源：由 riskController 模块实现并注入。
 * 使用范围：主程序、生命周期、订单监控、浮亏监控；全项目可引用。
 */
export interface DailyLossTracker {
  /** 显式重置 dayKey 与 states（含分段元数据） */
  resetAll: (now: Date) => void;

  /** 使用完整订单列表全量重算当日状态，供启动恢复或 SEAT_REFRESH 纠偏使用。 */
  recalculateFromAllOrders: (
    allOrders: ReadonlyArray<RawOrderFromAPI>,
    monitor: Pick<MonitorConfig, 'monitorSymbol' | 'orderOwnershipMapping'>,
    now: Date,
    protectionBoundaryByDirection?: ReadonlyMap<'LONG' | 'SHORT', number>,
    relatedTradingSymbols?: ReadonlySet<string>,
  ) => void;

  /** 按 revision 幂等合并订单累计成交事实，分段投影由 per-order baseline 计算 */
  recordCumulativeExecution: (
    input: DailyLossCumulativeExecutionInput,
    beforeAuthoritativeFactCommit?: (snapshot: DailyLossAuthoritativeFactSnapshot) => void,
  ) => DailyLossCumulativeExecutionResult;

  /** 启动时把正式 progress record 恢复为精确历史 execution snapshot。 */
  restoreExecutionSnapshot: (params: RestoreDailyLossExecutionSnapshotParams) => void;

  /** 获取指定方向的当日亏损偏移（仅亏损，<=0），未初始化时返回 0 */
  getLossOffset: (direction: 'LONG' | 'SHORT') => number;

  /** 冻结保护边界基线，不修改当前边界与偏移。 */
  prepareProtectionBoundary: (
    params: StartNewProtectionEpisodeParams,
  ) => PreparedDailyLossProtectionBoundary;

  /** 提交已冻结且已持久化的保护边界。 */
  commitProtectionBoundary: (prepared: PreparedDailyLossProtectionBoundary) => void;

  /** 启动恢复时校验 persisted baseline 与当前订单事实后提交。 */
  restoreProtectionBoundary: (prepared: PreparedDailyLossProtectionBoundary) => void;
}

/**
 * 单方向浮亏监控上下文。
 * 类型用途：TradingRiskEventRuntime 调用单方向浮亏执行器时的入参，只携带当前命中的方向与 seatVersion。
 * 数据来源：由 tradingRiskEventRuntime 基于 symbolRegistry 路由与 quote push 事件组装传入。
 * 使用范围：风险控制与事件驱动浮亏链路；全项目可引用。
 */
export type DirectionalUnrealizedLossMonitorContext = {
  readonly symbol: string;
  readonly isLong: boolean;
  readonly seatVersion: number;
  readonly quote: Quote;
  readonly riskChecker: RiskChecker;
  readonly trader: Trader;
  readonly orderRecorder: OrderRecorder;
  readonly dailyLossTracker: DailyLossTracker;
};

/**
 * 浮亏监控器接口。
 * 类型用途：依赖注入，由 riskController 模块实现，供事件驱动浮亏链路按单方向执行保护性清仓。
 * 数据来源：由 riskController 模块实现并注入。
 * 使用范围：TradingRiskEventRuntime 与 MonitorContext；全项目可引用。
 */
export interface UnrealizedLossMonitor {
  /**
   * 监控单方向标的的浮亏。
   * @param context 单方向浮亏监控上下文
   */
  monitorDirectionalUnrealizedLoss: (
    context: DirectionalUnrealizedLossMonitorContext,
  ) => Promise<void>;
}

/**
 * 当日亏损追踪器依赖注入类型。
 * 类型用途：创建 DailyLossTracker 时约束过滤算法、归属解析与订单转换依赖。
 * 数据来源：由启动层在组装 riskController 子模块时传入。
 * 使用范围：riskController 模块内部创建流程；全项目可引用。
 */
export type DailyLossTrackerDeps = {
  readonly filteringEngine: OrderFilteringEngine;
  readonly resolveOrderOwnership: (
    order: RawOrderFromAPI,
    monitor: Pick<MonitorConfig, 'monitorSymbol' | 'orderOwnershipMapping'>,
  ) => OrderOwnership | null;
  readonly classifyAndConvertOrders: (orders: ReadonlyArray<RawOrderFromAPI>) => {
    buyOrders: ReadonlyArray<OrderRecord>;
    sellOrders: ReadonlyArray<OrderRecord>;
  };
  readonly toHongKongTimeIso: (date: Date | null) => string;
};
