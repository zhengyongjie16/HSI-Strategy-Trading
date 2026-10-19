import type { OrderFact } from './trade.js';
import type { TradingCalendarSnapshot } from './tradingCalendar.js';

/**
 * 已成交订单记录。
 * 类型用途：表示单笔已成交订单，用于订单记录器内部存储、成本均价计算、可卖订单列表等。
 * 数据来源：本地记录或由 OrderFact 转换/同步得到。
 * 使用范围：OrderRecorder、RiskChecker、卖出计算、智能平仓等；全项目可引用。
 */
export type OrderRecord = {
  /** 订单 ID */
  readonly orderId: string;

  /** 标的代码 */
  readonly symbol: string;

  /** 权威累计成交金额，成本不得由显示均价乘回重建。 */
  readonly costAmount: string;

  /** 成交数量（已验证安全整数） */
  readonly executedQuantity: number;

  /** 成交时间戳 */
  readonly executedTime: number;
};

/**
 * 待成交卖出订单信息。
 * 类型用途：智能平仓防重追踪，记录已提交但未成交的卖出订单及关联买单。
 * 数据来源：提交卖单时添加，成交/撤单时更新状态。
 * 使用范围：OrderRecorder、OrderStorage、订单监控等；全项目可引用。
 */
export type PendingSellInfo = {
  /** 卖出订单ID */
  readonly orderId: string;

  /** 标的代码 */
  readonly symbol: string;

  /** 方向 */
  readonly direction: 'LONG' | 'SHORT';

  /** 提交数量 */
  readonly submittedQuantity: number;

  /** 已成交数量 */
  readonly filledQuantity: number;

  /** 关联的买入订单ID列表（精确标记哪些订单被占用） */
  readonly relatedBuyOrderIds: readonly string[];

  /** 状态 */
  readonly status: 'pending' | 'partial' | 'filled' | 'cancelled';
};

/**
 * 可卖订单筛选策略。
 * 类型用途：统一描述卖出订单筛选行为（全量/仅盈利/仅超时）。
 * 数据来源：由卖出决策层传入。
 * 使用范围：订单记录与普通卖出数量计算 模块。
 */
type SellableOrderStrategy = 'ALL' | 'PROFIT_ONLY' | 'TIMEOUT_ONLY';

/**
 * 可卖订单筛选参数。
 * 类型用途：selectSellableOrders 的对象入参，统一承载策略、价格、超时、截断和额外排除规则。
 * 数据来源：卖出决策层构建。
 * 使用范围：订单记录与普通卖出数量计算 模块。
 */
export type SellableOrderSelectParams = {
  readonly symbol: string;
  readonly direction: 'LONG' | 'SHORT';
  readonly strategy: SellableOrderStrategy;
  readonly currentPrice: string;
  readonly maxSellQuantity?: number;
  readonly excludeOrderIds?: ReadonlySet<string>;
  readonly timeoutMinutes?: number | null;
  readonly nowMs?: number;
  readonly calendarSnapshot?: TradingCalendarSnapshot;
};

/**
 * 可卖订单查询结果。
 * 类型用途：OrderStorage.selectSellableOrders 的返回结果，用于卖出数量计算与防重。
 * 数据来源：由 OrderStorage.selectSellableOrders 返回。
 * 使用范围：见调用方（如 普通卖出与共享执行）。
 */
export type SellableOrderResult = {
  /** 可卖出的订单记录列表 */
  readonly orders: ReadonlyArray<OrderRecord>;

  /** 这些订单的总数量 */
  readonly totalQuantity: number;
};

/** 唯一订单事实与经济投影 owner 的真实能力；读取、提交和清理由 app 按实际消费切片注入。 */
export interface OrderRecorder {
  /** 更新待成交卖单元数据（卖单合并后同步数量与占用集合） */
  readonly updatePendingSell: (
    orderId: string,
    params: {
      readonly submittedQuantity: number;
      readonly relatedBuyOrderIds: ReadonlyArray<string>;
    },
  ) => PendingSellInfo | null;

  /** 标记卖出订单完全成交 */
  readonly markSellFilled: (orderId: string) => PendingSellInfo | null;

  /** 标记卖出订单部分成交 */
  readonly markSellPartialFilled: (
    orderId: string,
    filledQuantity: number,
  ) => PendingSellInfo | null;

  /** 标记卖出订单取消 */
  readonly markSellCancelled: (orderId: string) => PendingSellInfo | null;

  /** 获取待成交卖单快照（用于恢复一致性校验） */
  readonly getPendingSellSnapshot: () => ReadonlyArray<PendingSellInfo>;

  /** 恢复期：为待恢复的卖单分配关联买单 ID */
  readonly allocateRelatedBuyOrderIdsForRecovery: (
    symbol: string,
    direction: 'LONG' | 'SHORT',
    quantity: number,
  ) => readonly string[];

  /** 获取原始成本金额与安全整数数量；仅输出时求均价，不用均价重建成本。 */
  readonly getCostBasis: (symbol: string, isLongSymbol: boolean) => OrderCostBasis | null;

  /** 按策略筛选可卖订单（统一处理占用过滤、整笔截断与可选额外排除） */
  readonly selectSellableOrders: (params: SellableOrderSelectParams) => SellableOrderResult;

  /** 同一 broker identity 的 API/在线累计事实同步提交，不生成本地替代订单 ID。 */
  readonly commitExecutionFact: (
    fact: BrokerOrderExecutionFact,
    isLongSymbol: boolean,
    relatedBuyOrderIds: ReadonlyArray<string>,
    beforeCommit: () => OrderExecutionAdmission,
  ) => void;

  /** 唯一事实 owner 的只读累计事实；不是另一份经济账或 survivor 推造事实。 */
  readonly getExecutionFact: (brokerOrderId: string) => BrokerOrderExecutionFact | null;

  /** 全 API batch 的归属/累计事实/token 预检与列表/实际覆盖同步提交。 */
  readonly commitRebuildSnapshot: (
    targets: ReadonlyArray<OrderProjectionTarget>,
    allOrders: ReadonlyArray<OrderFact>,
    isCurrent: () => boolean,
    mode: 'ACTIVATION' | 'REBUILD',
  ) => OrderFactBatchCommitResult;

  /** 清空指定标的的买入订单记录 */
  readonly clearBuyOrders: (symbol: string, isLongSymbol: boolean) => void;

  /** 最新订单与全方向列表均以精确成本金额/数量为依据，不返回舍入均价。 */
  readonly getLatestBuyOrderCost: (symbol: string, isLongSymbol: boolean) => OrderCostBasis | null;

  /** 按订单 ID 获取卖出成交记录 */
  readonly getSellRecordByOrderId: (orderId: string) => OrderRecord | null;

  /** 从 API 获取全量订单 */
  readonly fetchAllOrdersFromAPI: () => Promise<ReadonlyArray<OrderFact>>;

  /**
   * 预检同一次全量订单快照中指定标的的重建事实。
   * 不写入本地订单记录；与实际刷新共享同一筛选和分类口径。
   */
  readonly validateRebuildSnapshot: (symbol: string, allOrders: ReadonlyArray<OrderFact>) => void;

  /** 获取指定标的的买入订单 */
  readonly getBuyOrdersForSymbol: (
    symbol: string,
    isLongSymbol: boolean,
  ) => ReadonlyArray<OrderRecord>;

  /**
   * 提交卖出订单时调用（添加待成交追踪）。
   * submittedAtMs 仅用于提交事实校验（安全整数且 >0 的 fail-fast），不落库。
   */
  readonly submitSellOrder: (
    orderId: string,
    symbol: string,
    direction: 'LONG' | 'SHORT',
    quantity: number,
    relatedBuyOrderIds: ReadonlyArray<string>,
    submittedAtMs: number,
  ) => void;

  /** 重置全部本地订单记录 */
  readonly resetAll: () => void;
}

/** 订单归属；解析来自 broker remark 与唯一监控标的映射，不由本地 ID 推造。 */
export type OrderOwnership = {
  readonly monitorSymbol: string;
  readonly direction: 'LONG' | 'SHORT';
};

/** 同一 broker 订单的累计权威事实；成交时间与 broker revision 必须独立保留。 */
export type BrokerOrderExecutionFact = {
  readonly brokerOrderId: string;
  readonly symbol: string;
  readonly side: 'BUY' | 'SELL';
  readonly cumulativeQuantity: number;
  readonly cumulativeAmount: string;
  readonly executionTimeMs: number | null;
  readonly updatedAtMs: number;
  readonly phase: 'OPEN' | 'TERMINAL';
};

/** 已由SDK mapper验证的累计观察最小输入；不携带未消费的SDK side/status/orderType。 */
export type OrderExecutionTimeObservation = {
  readonly orderId: string;
  readonly symbol: string;
  readonly executionSide: 'BUY' | 'SELL';
  readonly executedQuantity: number;
  readonly executedAmount: string;
  readonly executionTimeMs: number | null;
  readonly updatedAtMs: number;
  readonly executionPhase: 'OPEN' | 'TERMINAL';
};

/**
 * 已验证累计事实 + 原订单提交时间；成本投影/重建只消费已验证累计事实，
 * 原提交时间仅供日损重算（保护边界后的零基线证明），均不读取SDK订单元数据。
 */
export type OrderExecutionRecordObservation = OrderExecutionTimeObservation &
  Readonly<{ submittedAt: Date }>;

/** 从已成功提交事实或 durable progress/baseline 提供的可信执行时间证据，revision 独立保存。 */
export type OrderExecutionTimeEvidence = {
  readonly brokerOrderId: string;
  readonly symbol: string;
  readonly side: 'BUY' | 'SELL';
  readonly cumulativeQuantity: number;
  readonly cumulativeAmount: string;
  readonly lastExecutionTimeMs: number;
  readonly orderRevisionMs: number;

  /** V1 boundary baseline 未持久化 phase，显式未知；不得补造 OPEN/TERMINAL。 */
  readonly phase: 'OPEN' | 'TERMINAL' | null;
};

/** 同步成交准入；封存/非当日抑制与已准入事实的纯重复明确区分，重复仍允许首次经济投影。 */
export type OrderExecutionAdmission = 'ADMITTED' | 'DUPLICATE' | 'SUPPRESSED';

/** 成本计算保留金额和经证明的安全整数数量，不将舍入均价回写金融状态。 */
export type OrderCostBasis = {
  readonly costAmount: string;
  readonly quantity: number;
};

/** 同一 API batch 的投影对象，调用前必须完成全部标的归属与 token 预检。 */
export type OrderProjectionTarget = {
  readonly symbol: string;
  readonly isLongSymbol: boolean;
};

/** 原子 batch 的外部结果；过期只返回 ABORTED，成功只声明已提交而不携带逐步事实。 */
export type OrderFactBatchCommitResult =
  { readonly status: 'COMMITTED' } | { readonly status: 'ABORTED' };

/** 订单过滤引擎；按成本金额/数量 cross product 排序并整笔消除。 */
export interface OrderFilteringEngine {
  readonly applyFilteringAlgorithm: (
    allBuyOrders: ReadonlyArray<OrderRecord>,
    executedSellOrders: ReadonlyArray<OrderRecord>,
  ) => ReadonlyArray<OrderRecord>;
}
