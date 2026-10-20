import type {
  OrderRecord,
  OrderExecutionAdmission,
  OrderExecutionRecordObservation,
  OrderFilteringEngine,
  OrderOwnership,
} from './orderRecorder.js';

/**
 * 当日亏损重算的中性订单快照事实。
 * 复用已验证的累计执行观察，仅补充归属名称、执行状态与可信 revision Date；不携带 SDK 元数据。
 * 数据来源：订单读取 adapter 或已验证历史快照；供 domain/risk 的全量重算与诊断使用。
 */
export type DailyLossOrderSnapshot = OrderExecutionRecordObservation &
  Readonly<{
    stockName: string;
    executionStatus: 'NONE' | 'PARTIAL' | 'FILLED';
    updatedAt: Date | null;
  }>;

/**
 * 唯一监控标的的日损归属范围。
 * 数据来源：装配层的监控标的及归属缩写；仅用于订单归属解析，不包含策略/SDK 配置。
 */
export type DailyLossMonitorScope = Readonly<{
  monitorSymbol: string;
  orderOwnershipMapping: ReadonlyArray<string>;
}>;

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
  readonly side: 'BUY' | 'SELL';
  readonly executedPrice: string;
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
  side: 'BUY' | 'SELL';
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
 * 使用范围：app 交易子实例装配边界。
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
  /** SUPPRESSED 禁止下游经济提交；DUPLICATE 不阻挡 O 首次合法 phase/投影。 */
  readonly admission: OrderExecutionAdmission;
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
 * 同一 DailyLoss owner 发行的全量重算同步发布能力。
 * 候选事实、边界、baseline 与双方向状态仅保存在发行者闭包内，不接受外部构造的状态。
 * prepare 不写运行态；发行后任一运行态写入会使此能力失效，重复 publish 同样拒绝。
 * 使用范围：启动恢复与席位激活的完整预检后同步提交段，不跨 await 使用。
 */
export interface PreparedDailyLossRecalculation {
  readonly isCurrent: () => boolean;
}

/**
 * 当日亏损追踪器接口。
 * 类型用途：按唯一 monitor 的 LONG/SHORT 方向维护已实现盈亏偏移，供浮亏刷新、成交处理与生命周期重建共享。
 * 数据来源：由 domain/risk 实现并注入。
 * 使用范围：主程序、生命周期、订单监控、浮亏监控；全项目可引用。
 */
export interface DailyLossTracker {
  /** 显式重置 dayKey 与 states（含分段元数据） */
  readonly resetAll: (now: Date) => void;

  /** 按本实例真实依赖完整预检全部订单与双方向财务候选，不修改任何运行态。 */
  readonly prepareRecalculationFromAllOrders: (
    allOrders: ReadonlyArray<DailyLossOrderSnapshot>,
    monitor: DailyLossMonitorScope,
    now: Date,
    protectionBoundaryByDirection?: ReadonlyMap<'LONG' | 'SHORT', number>,
    relatedTradingSymbols?: ReadonlySet<string>,
    recovery?: {
      readonly executionSnapshots: ReadonlyArray<RestoreDailyLossExecutionSnapshotParams>;
      readonly boundaries: ReadonlyArray<PreparedDailyLossProtectionBoundary>;
    },
  ) => PreparedDailyLossRecalculation;

  /** 仅接受本实例发行且仍 current 的候选，同步发布全部运行态；伪造、跨实例与重用均拒绝。 */
  readonly publishRecalculation: (prepared: PreparedDailyLossRecalculation) => void;

  /** 按 revision 幂等合并订单累计成交事实，分段投影由 per-order baseline 计算 */
  readonly recordCumulativeExecution: (
    input: DailyLossCumulativeExecutionInput,
    beforeAuthoritativeFactCommit?: (snapshot: DailyLossAuthoritativeFactSnapshot) => void,
  ) => DailyLossCumulativeExecutionResult;

  /** 启动时把正式 progress record 恢复为精确历史 execution snapshot。 */
  readonly restoreExecutionSnapshot: (params: RestoreDailyLossExecutionSnapshotParams) => void;

  /** 获取指定方向的当日亏损偏移（仅亏损，<=0），未初始化时返回规范文本 0 */
  readonly getLossOffset: (direction: 'LONG' | 'SHORT') => string;

  /** 冻结保护边界基线，不修改当前边界与偏移。 */
  readonly prepareProtectionBoundary: (
    params: StartNewProtectionEpisodeParams,
  ) => PreparedDailyLossProtectionBoundary;

  /** 提交已冻结且已持久化的保护边界。 */
  readonly commitProtectionBoundary: (prepared: PreparedDailyLossProtectionBoundary) => void;

  /** 启动恢复时校验 persisted baseline 与当前订单事实后提交。 */
  readonly restoreProtectionBoundary: (prepared: PreparedDailyLossProtectionBoundary) => void;
}

/**
 * 当日亏损 domain owner 的窄协作依赖。
 * 过滤/归属/转换只消费已验证中性事实；观测 callback 由装配层注入，不授予 domain logger IO。
 * 数据来源：启动层的既有纯分析规则、香港时间转换与告警观测；供 domain/risk 工厂使用。
 */
export interface DailyLossTrackerDeps {
  readonly filteringEngine: OrderFilteringEngine;
  readonly resolveOrderOwnership: (
    order: DailyLossOrderSnapshot,
    monitor: DailyLossMonitorScope,
  ) => OrderOwnership | null;
  readonly classifyAndConvertOrders: (orders: ReadonlyArray<OrderExecutionRecordObservation>) => {
    readonly buyOrders: ReadonlyArray<OrderRecord>;
    readonly sellOrders: ReadonlyArray<OrderRecord>;
  };
  readonly toHongKongTimeIso: (date: Date) => string;
  readonly onOwnershipWarning: (message: string) => void;
}
