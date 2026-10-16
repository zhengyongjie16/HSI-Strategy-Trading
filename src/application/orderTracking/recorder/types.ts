import type { Logger } from '../../../types/logger.js';

/**
 * 订单快照来源标识。
 * 类型用途：标记同一 orderId 的来源（history/today），用于去重覆盖决策。
 * 数据来源：OrderAPIManager 拉取 history/today 订单时生成。
 * 使用范围：orderRecorder/orderApiManager 内部使用。
 */

import type {
  OrderCostBasis,
  OrderExecutionTimeEvidence,
  OrderRecord,
  PendingSellInfo,
  SellableOrderResult,
  SellableOrderSelectParams,
} from '../../../types/orderRecorder.js';
import type { OrderSnapshotReadPort } from '../../../types/orderSnapshotReadPorts.js';
import type { Quote } from '../../../types/quote.js';

import type { SettlementRefreshNeedRecorder } from '../../../types/settlement.js';
import type { OrderFact } from '../../../types/trade.js';

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
  fetchAllOrdersFromAPI: () => Promise<ReadonlyArray<OrderFact>>;
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
  readonly logger: Logger;
  readonly orderSnapshotReadPort: OrderSnapshotReadPort;
  readonly getExecutionTimeEvidence: () => ReadonlyArray<OrderExecutionTimeEvidence>;
  readonly settlementRefreshNeedRecorder: SettlementRefreshNeedRecorder;
};

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
