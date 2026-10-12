import type { OrderSnapshotReadPort } from '../../types/orderSnapshotReadPorts.js';
import type { Quote } from '../../types/quote.js';
import type { SettlementRefreshNeedRecorder } from '../../types/settlement.js';
import type { DailyLossMonitorScope, DailyLossOrderSnapshot } from '../../types/risk.js';
import type {
  BrokerOrderExecutionFact,
  OrderFilteringEngine,
  OrderOwnership,
  OrderCostBasis,
  OrderExecutionTimeEvidence,
  OrderExecutionRecordObservation,
  OrderFactCommitReceipt,
} from '../../types/orderRecorder.js';
import type {
  OrderRecord,
  PendingSellInfo,
  RawOrderFromAPI,
  SellableOrderResult,
  SellableOrderSelectParams,
} from '../../types/services.js';

/**
 * 订单统计信息类型。
 * 类型用途：用于调试输出或内部汇总（数量、均价）。
 * 数据来源：如适用（由模块内部根据订单列表计算）。
 * 使用范围：仅 orderRecorder 模块使用。
 */
export type OrderStatistics = {
  readonly totalQuantity: number;
  readonly costAmount: string;
};

/**
 * 订单重建分类结果。
 * 类型用途：启动/开盘重建阶段在单标的维度将全量订单按生命周期、有效成交事实与买卖方向分流。
 * 数据来源：由 classifyOrdersForRebuild 从 RawOrderFromAPI 转换得到。
 * 使用范围：orderRecorder 重建链路内部使用。
 */
export type OrderRebuildClassification<T extends OrderExecutionRecordObservation> = {
  readonly executedBuyOrders: ReadonlyArray<OrderRecord>;
  readonly executedSellOrders: ReadonlyArray<OrderRecord>;
  readonly pendingBuyOrders: ReadonlyArray<T>;
  readonly pendingSellOrders: ReadonlyArray<T>;
};

/**
 * 订单快照来源标识。
 * 类型用途：标记同一 orderId 的来源（history/today），用于去重覆盖决策。
 * 数据来源：OrderAPIManager 拉取 history/today 订单时生成。
 * 使用范围：orderRecorder/orderApiManager 内部使用。
 */
export type OrderSnapshotSource = 'history' | 'today';

/**
 * 合并去重后的订单条目。
 * 类型用途：在按 orderId 合并时同时保留来源与订单内容，供覆盖策略判断。
 * 数据来源：mergeAndDeduplicateOrders 构建。
 * 使用范围：orderRecorder/orderApiManager 内部使用。
 */
export type MergedOrderEntry = {
  readonly source: OrderSnapshotSource;
  readonly order: RawOrderFromAPI;
};

// ==================== 服务接口定义 ====================

/**
 * 订单存储接口。
 * 类型用途：依赖注入，提供订单的本地存储管理（买卖记录、待成交卖单、可卖订单查询等）。
 * 数据来源：如适用。
 * 使用范围：由 OrderRecorder 依赖注入；仅 orderRecorder 模块实现与使用。
 */
export interface OrderStorage {
  getBuyOrdersList: (symbol: string, isLongSymbol: boolean) => ReadonlyArray<OrderRecord>;
  setBuyOrdersListForLong: (symbol: string, newList: ReadonlyArray<OrderRecord>) => void;
  setBuyOrdersListForShort: (symbol: string, newList: ReadonlyArray<OrderRecord>) => void;
  setSellRecord: (record: OrderRecord) => void;
  clearBuyOrders: (symbol: string, isLongSymbol: boolean, quote?: Quote | null) => void;
  getLatestBuyOrderCost: (symbol: string, isLongSymbol: boolean) => OrderCostBasis | null;
  getSellRecordByOrderId: (orderId: string) => OrderRecord | null;

  /** 添加待成交卖出订单（提交时调用） */
  addPendingSell: (info: Omit<PendingSellInfo, 'filledQuantity' | 'status'>) => void;

  /** 更新待成交卖单元数据（卖单合并后同步数量与占用集合） */
  updatePendingSell: (
    orderId: string,
    params: {
      readonly submittedQuantity: number;
      readonly relatedBuyOrderIds: ReadonlyArray<string>;
    },
  ) => PendingSellInfo | null;

  /** 标记卖出订单完全成交 */
  markSellFilled: (orderId: string) => PendingSellInfo | null;

  /** 标记卖出订单部分成交 */
  markSellPartialFilled: (orderId: string, filledQuantity: number) => PendingSellInfo | null;

  /** 标记卖出订单取消 */
  markSellCancelled: (orderId: string) => PendingSellInfo | null;

  /** 获取待成交卖单快照（用于恢复一致性校验） */
  getPendingSellSnapshot: () => ReadonlyArray<PendingSellInfo>;

  /** 恢复期：为待恢复的卖单分配关联买单 ID */
  allocateRelatedBuyOrderIdsForRecovery: (
    symbol: string,
    direction: 'LONG' | 'SHORT',
    quantity: number,
  ) => readonly string[];

  /** 获取指定标的的成本均价（实时计算，无缓存） */
  getCostBasis: (symbol: string, isLongSymbol: boolean) => OrderCostBasis | null;

  /** 按策略筛选可卖订单（统一处理占用过滤、整笔截断与可选额外排除） */
  selectSellableOrders: (params: SellableOrderSelectParams) => SellableOrderResult;

  /** 清空买卖记录与 pendingSells */
  clearAll: () => void;
}

/**
 * 订单 API 管理器接口。
 * 类型用途：依赖注入，负责从 Longbridge API 获取订单。
 * 数据来源：如适用。
 * 使用范围：由 OrderRecorder 依赖注入；仅 orderRecorder 模块实现与使用。
 */
export interface OrderAPIManager {
  fetchAllOrdersFromAPI: () => Promise<ReadonlyArray<RawOrderFromAPI>>;
}

// ==================== 依赖类型定义 ====================

/**
 * 订单 API 管理器依赖。
 * 类型用途：用于创建 OrderAPIManager 时的依赖注入。
 * 数据来源：如适用。
 * 使用范围：仅 orderRecorder 模块内部使用。
 */
export type OrderAPIManagerDeps = {
  readonly orderSnapshotReadPort: OrderSnapshotReadPort;
};

/**
 * 订单记录器正式工厂依赖。
 * 类型用途：创建 OrderRecorder 时注入同context已装配的实际快照IO能力。
 * 数据来源：由 Trader 装配层创建后传入。
 * 使用范围：仅 orderRecorder 对外工厂使用。
 */
export type OrderRecorderFactoryDeps = {
  readonly orderSnapshotReadPort: OrderSnapshotReadPort;
  readonly getExecutionTimeEvidence: () => ReadonlyArray<OrderExecutionTimeEvidence>;
  readonly settlementRefreshNeedRecorder: SettlementRefreshNeedRecorder;
};

/**
 * 日内亏损回算所需的订单分析依赖。
 * 类型用途：作为 orderRecorder 对外暴露的最小分析能力集合，供装配层注入 dailyLossTracker。
 * 数据来源：由 orderRecorder 公共边界内组装后返回。
 * 使用范围：仅 orderRecorder 的对外分析导出使用。
 */
export interface OrderDailyLossAnalysisDeps {
  readonly filteringEngine: OrderFilteringEngine;
  readonly resolveOrderOwnership: (
    order: DailyLossOrderSnapshot,
    monitor: DailyLossMonitorScope,
  ) => OrderOwnership | null;
  readonly classifyAndConvertOrders: (orders: ReadonlyArray<OrderExecutionRecordObservation>) => {
    readonly buyOrders: ReadonlyArray<OrderRecord>;
    readonly sellOrders: ReadonlyArray<OrderRecord>;
  };
}

/**
 * 订单记录器依赖。
 * 类型用途：用于创建 OrderRecorder 时的依赖注入。
 * 数据来源：如适用。
 * 使用范围：仅 orderRecorder 模块内部组装使用。
 */
export type OrderRecorderDeps = {
  readonly storage: OrderStorage;
  readonly apiManager: OrderAPIManager;
  readonly getExecutionTimeEvidence: () => ReadonlyArray<OrderExecutionTimeEvidence>;
  readonly settlementRefreshNeedRecorder: SettlementRefreshNeedRecorder;
};

/** 同 broker identity 的已消费增量范围；主动 clear 仅作用于当时实际存活的范围。 */
export type ExecutionProjectionSlice = {
  readonly quantity: number;
  readonly executionTimeMs: number;
  readonly admittedSequence: number;
  readonly clearedAtSequence: number | null;
};

/** 唯一 broker fact 条目的经济消费证明；OPEN partial 不建立 slice，不从 survivor 推造覆盖。 */
export type OwnedExecutionFact = {
  readonly fact: BrokerOrderExecutionFact;
  readonly isLongSymbol: boolean;
  readonly economicQuantity: number;
  readonly projectionSlices: ReadonlyArray<ExecutionProjectionSlice>;
  readonly relatedBuyOrderIds: ReadonlyArray<string>;
};

/** 纯重算中的私有 slice 引用；同 broker ID 保留，不生成 LOCAL identity。 */
export type ProjectionSliceInput = {
  readonly brokerOrderId: string;
  readonly entry: OwnedExecutionFact;
  readonly slice: ExecutionProjectionSlice;
};

/** 同步预检后待发布的经济变化；失败前不修改任何事实或列表。 */
export type PreparedExecutionCommit = {
  readonly entry: OwnedExecutionFact;
  readonly receipt: OrderFactCommitReceipt;
};
