import type { OrderReadStatus, OrderReadType } from './orderReadMetadata.js';
import type {
  BuySignal,
  DoomsdayClearanceCommand,
  ExecutableSignal,
  SignalType,
} from './signal.js';
import type { Quote } from './quote.js';
import type { AccountSnapshot, Position } from './account.js';
import type { MonitorConfig } from './config.js';
import type { TradingCalendarSnapshot } from './tradingCalendar.js';
import type {
  DoomsdayCancelOrderOutcome,
  DoomsdayCancelOrderRequest,
  CancelOrderOutcome,
  TraderCancelOrderRequest,
  DoomsdayClearanceExecutionResult,
  ExecuteSignalsResult,
  SignalCallerAuthorization,
  OrderClosedReason,
} from './trader.js';
import type { ExternalApiRetryConfig } from '../utils/apiFailure/types.js';
import type {
  BrokerOrderExecutionFact,
  OrderCostBasis,
  OrderFactBatchCommitResult,
  OrderFactCommitReceipt,
  OrderExecutionAdmission,
  OrderProjectionTarget,
} from './orderRecorder.js';

/**
 * 待处理订单。
 * 类型用途：表示尚未完全成交的订单，用于 getPendingOrders 返回值、订单监控与撤单逻辑。
 * 数据来源：Trader/订单 API 查询结果转换。
 * 使用范围：trader、orderMonitor、异步处理器等；全项目可引用。
 */
export type PendingOrder = {
  readonly orderId: string;
  readonly symbol: string;
  readonly side: 'BUY' | 'SELL';

  /** SDK 对市价单等合法订单可返回 null；不得伪造为零价格。 */
  readonly submittedPrice: string | null;
  readonly quantity: number;
  readonly executedQuantity: number;
  readonly status: OrderReadStatus;
  readonly orderType: OrderReadType;
};

/**
 * API 返回的原始订单类型。
 * 类型用途：从 Longbridge 订单 API 接收订单数据时的类型安全结构，作为 fetchAllOrdersFromAPI、refreshOrdersFromAllOrdersForLong/Short 等入参或元素类型。
 * 数据来源：Longbridge 订单 API 返回。
 * 使用范围：OrderRecorder、Trader、orderApiManager 等；全项目可引用。
 */
export type RawOrderFromAPI = {
  readonly orderId: string;
  readonly symbol: string;
  readonly stockName: string;

  /** 由adapter一次映射的中性方向，新的P1事实/归属消费不反向比较SDK枚举。 */
  readonly executionSide: 'BUY' | 'SELL';

  /** 由SDK adapter权威映射的执行状态；P1金融/归属reader不再自行比较SDK枚举。 */
  readonly executionStatus: 'NONE' | 'PARTIAL' | 'FILLED';

  /** SDK adapter穷尽验证的生命周期；业务累计事实不再解析SDK status。 */
  readonly executionPhase: 'OPEN' | 'TERMINAL';
  readonly status: OrderReadStatus;
  readonly orderType: OrderReadType;
  readonly remark?: string | null;
  readonly price: string | null;
  readonly quantity: number;
  readonly executedPrice: string | null;
  readonly executedQuantity: number;

  /** SDK 累计成交均价原文 × 累计安全整数数量，非显示均价回乘。 */
  readonly executedAmount: string;

  /** 真实 execution 流水或匹配 durable 证据；未知时必须显式 null。 */
  readonly executionTimeMs: number | null;

  /** broker 修订版本，绝不作为 executionTimeMs 的替代值。 */
  readonly updatedAtMs: number;
  readonly submittedAt: Date;
  readonly updatedAt: Date | null;
};

/**
 * 已成交订单记录。
 * 类型用途：表示单笔已成交订单，用于订单记录器内部存储、成本均价计算、可卖订单列表等。
 * 数据来源：本地记录或由 RawOrderFromAPI 转换/同步得到。
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

  /** 下单时间 */
  readonly submittedAt: Date | undefined;

  /** 更新时间 */
  readonly updatedAt: Date | undefined;
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

  /** 原卖单保护性身份；合单不得跨目的扩量。 */
  readonly isProtectiveLiquidation: boolean;

  /** 提交时间 */
  readonly submittedAt: number;
};

/**
 * 可卖订单筛选策略。
 * 类型用途：统一描述卖出订单筛选行为（全量/仅盈利/仅超时）。
 * 数据来源：由卖出决策层传入。
 * 使用范围：orderRecorder 与 signalProcessor 模块。
 */
type SellableOrderStrategy = 'ALL' | 'PROFIT_ONLY' | 'TIMEOUT_ONLY';

/**
 * 可卖订单筛选参数。
 * 类型用途：selectSellableOrders 的对象入参，统一承载策略、价格、超时、截断和额外排除规则。
 * 数据来源：卖出决策层构建。
 * 使用范围：orderRecorder 与 signalProcessor 模块。
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
 * 使用范围：见调用方（如 signalProcessor、trader）。
 */
export type SellableOrderResult = {
  /** 可卖出的订单记录列表 */
  readonly orders: ReadonlyArray<OrderRecord>;

  /** 这些订单的总数量 */
  readonly totalQuantity: number;
};

/**
 * 交易检查结果。
 * 类型用途：表示当前是否可执行交易及原因，作为 canTradeNow 等频率检查调用的返回值。
 * 数据来源：Trader 内部根据频率限制、门禁等计算。
 * 使用范围：交易门禁、买卖处理器等；全项目可引用。
 */
export type TradeCheckResult = {
  /** 是否可以交易 */
  readonly canTrade: boolean;

  /** 需等待秒数（频率限制） */
  readonly waitSeconds?: number;
};

/**
 * 交易 mutation permit。
 * 类型用途：只在 RateLimiter.withTradeMutation 回调内使用，确保最终报价、同步授权与真实 SDK mutation 保持同一 FIFO 临界区。
 * 数据来源：由 RateLimiter 在取得交易 mutation 序列席位后创建。
 * 使用范围：订单提交、撤单、改单与超时市价转单的最终 SDK 调用边界。
 */
export interface TradeMutationPermit {
  /** 在当前 permit 内执行唯一一次真实 SDK mutation；调用前才消耗 Trade API 配额。 */
  invoke: <T>(operation: () => Promise<T>) => Promise<T>;
}

/**
 * API 频率限制器接口。
 * 类型用途：依赖注入用接口，读取使用 throttle，订单 mutation 必须使用 callback permit。
 * 数据来源：如适用；实现由调用方提供。
 * 使用范围：Trader、行情客户端等限流场景；见调用方。
 */
export interface RateLimiter {
  /** 等待读取 API 的限流通过，并立即记入该次 API 配额。 */
  throttle: () => Promise<void>;

  /**
   * 在全局 FIFO trade mutation 序列内执行回调。
   * 回调可先等待最终行情；仅 permit.invoke() 会在实际 SDK 调用前消耗配额，且每个 permit 只能 invoke 一次。
   */
  withTradeMutation: <T>(callback: (permit: TradeMutationPermit) => Promise<T>) => Promise<T>;
}

/**
 * 订单记录器中「待成交卖单 + 可卖订单」相关方法的共享契约。
 * 类型用途：抽取 OrderRecorder 内部复用的方法集合，避免在公开契约中重复书写同一组方法签名。
 * 数据来源：由订单记录器实现提供。
 * 使用范围：OrderRecorder 内部组合复用，不作为跨模块公共类型导出。
 */
interface OrderRecorderPendingSellAndSellable {
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

  /** 获取原始成本金额与安全整数数量；仅输出时求均价，不用均价重建成本。 */
  getCostBasis: (symbol: string, isLongSymbol: boolean) => OrderCostBasis | null;

  /** 按策略筛选可卖订单（统一处理占用过滤、整笔截断与可选额外排除） */
  selectSellableOrders: (params: SellableOrderSelectParams) => SellableOrderResult;
}

/**
 * 订单记录器接口。
 * 类型用途：依赖注入用接口，管理买卖订单的本地记录与 API 同步，提供成本价、可卖订单、待成交卖单追踪等。
 * 数据来源：本地记录 + Longbridge 订单 API 同步。
 * 使用范围：Trader、RiskChecker、信号处理、异步处理器等；全项目可引用。
 */
export interface OrderRecorder extends OrderRecorderPendingSellAndSellable {
  /** 同一 broker identity 的 API/在线累计事实同步提交，不生成本地替代订单 ID。 */
  commitExecutionFact: (
    fact: BrokerOrderExecutionFact,
    isLongSymbol: boolean,
    relatedBuyOrderIds: ReadonlyArray<string>,
    beforeCommit: () => OrderExecutionAdmission,
  ) => OrderFactCommitReceipt;

  /** 唯一事实 owner 的只读累计事实；不是另一份经济账或 survivor 推造事实。 */
  getExecutionFact: (brokerOrderId: string) => BrokerOrderExecutionFact | null;

  /** 全 API batch 的归属/累计事实/token 预检与列表/实际覆盖同步提交。 */
  commitRebuildSnapshot: (
    targets: ReadonlyArray<OrderProjectionTarget>,
    allOrders: ReadonlyArray<RawOrderFromAPI>,
    isCurrent: () => boolean,
    mode: 'ACTIVATION' | 'REBUILD',
  ) => OrderFactBatchCommitResult;

  /** 清空指定标的的买入订单记录 */
  clearBuyOrders: (symbol: string, isLongSymbol: boolean, quote?: Quote | null) => void;

  /** 最新订单与全方向列表均以精确成本金额/数量为依据，不返回舍入均价。 */
  getLatestBuyOrderCost: (symbol: string, isLongSymbol: boolean) => OrderCostBasis | null;
  getCostBasis: (symbol: string, isLongSymbol: boolean) => OrderCostBasis | null;

  /** 按订单 ID 获取卖出成交记录 */
  getSellRecordByOrderId: (orderId: string) => OrderRecord | null;

  /** 从 API 获取全量订单 */
  fetchAllOrdersFromAPI: () => Promise<ReadonlyArray<RawOrderFromAPI>>;

  /**
   * 预检同一次全量订单快照中指定标的的重建事实。
   * 不写入本地订单记录；与实际刷新共享同一筛选和分类口径。
   */
  validateRebuildSnapshot: (symbol: string, allOrders: ReadonlyArray<RawOrderFromAPI>) => void;

  /** 获取指定标的的买入订单 */
  getBuyOrdersForSymbol: (symbol: string, isLongSymbol: boolean) => ReadonlyArray<OrderRecord>;

  /** 提交卖出订单时调用（添加待成交追踪） */
  submitSellOrder: (
    orderId: string,
    symbol: string,
    direction: 'LONG' | 'SHORT',
    quantity: number,
    relatedBuyOrderIds: ReadonlyArray<string>,
    isProtectiveLiquidation: boolean,
    submittedAtMs: number,
  ) => void;

  /** 重置全部本地订单记录 */
  resetAll: () => void;
}

/**
 * 取消订阅函数。
 * 类型用途：统一表达事件监听注册返回的清理函数。
 * 数据来源：由各运行时/服务的 onXxx 订阅方法返回。
 * 使用范围：事件端口、服务端口与测试使用。
 */
export type Unsubscribe = () => void;

/**
 * 订单状态变化事件。
 * 类型用途：表达订单监控向外暴露的最小终态结算事件载荷。
 * 数据来源：由 orderMonitor 在订单完成本地结算后发出。
 * 使用范围：trader、orderMonitor、后续事件驱动 runtime 与相关测试使用。
 */
export type OrderStateChangedEvent = Readonly<{
  orderId: string;
  symbol: string | null;
  side: 'BUY' | 'SELL' | null;
  source: 'API' | 'WS' | 'STATE_CHECK' | 'RECOVERY';
  status: OrderClosedReason;
  monitorSymbol: string | null;
  isLongSymbol: boolean | null;
  isProtectiveLiquidation: boolean;
  executedPrice: string | null;
  executedQuantity: number | null;
  executedTimeMs: number | null;
}>;

/**
 * 订单保留标的集合变化事件。
 * 类型用途：表达本地未完成订单保留集合的 symbol 粒度增减，供 quote 订阅 runtime 维护 ORDER_HOLD retain。
 * 数据来源：由 OrderHoldRegistry 在 holdSymbols 实际新增或移除时发布。
 * 使用范围：Trader、QuoteSubscriptionRuntime 与相关测试。
 */
export type OrderHoldSymbolsChangedEvent = Readonly<{
  /** 发生变化的订单标的 */
  symbol: string;

  /** 保留集合变化方向 */
  action: 'ADDED' | 'REMOVED';
}>;

/**
 * 交易器接口。
 * 类型用途：依赖注入用接口，封装 Longbridge 交易 API，提供账户/持仓、订单执行、订单监控与信号执行等。
 * 数据来源：实现层对接 Longbridge TradeContext；账户与订单数据来自 API。
 * 使用范围：MonitorContext、信号处理、交易门禁等；全项目可引用。
 */
export interface Trader {
  /** 订单记录器实例 */
  readonly orderRecorder: OrderRecorder;

  // ========== 账户相关 ==========

  /** 获取账户快照 */
  getAccountSnapshot: (params?: {
    readonly retryConfig?: ExternalApiRetryConfig;
  }) => Promise<AccountSnapshot>;

  /** 获取持仓列表 */
  getStockPositions: (params?: {
    readonly symbols?: ReadonlyArray<string> | null;
    readonly retryConfig?: ExternalApiRetryConfig;
  }) => Promise<ReadonlyArray<Position>>;

  // ========== 订单缓存 ==========

  /** 获取待处理订单 */
  getPendingOrders: (
    symbols?: ReadonlyArray<string> | null,
    forceRefresh?: boolean,
  ) => Promise<ReadonlyArray<PendingOrder>>;

  /** 启动阶段种子化订单订阅保留集 */
  seedOrderHoldSymbols: (orders: ReadonlyArray<RawOrderFromAPI>) => void;

  /** 获取订单订阅保留标的集合 */
  getOrderHoldSymbols: () => ReadonlySet<string>;

  /** 订阅订单保留标的集合变化事件 */
  onOrderHoldSymbolsChanged: (
    listener: (event: OrderHoldSymbolsChangedEvent) => void,
  ) => Unsubscribe;

  // ========== 订单监控 ==========

  /** 常规撤单；显式保留订单事实或原业务授权，在实际 broker mutation 前复核。 */
  cancelOrder: (orderId: string, request: TraderCancelOrderRequest) => Promise<CancelOrderOutcome>;

  /** 末日保护撤单；必须显式携带 permit 内实时门禁。 */
  cancelDoomsdayOrder: (
    orderId: string,
    request: DoomsdayCancelOrderRequest,
  ) => Promise<DoomsdayCancelOrderOutcome>;

  /** 启动订单监控 runtime */
  startOrderMonitorRuntime: () => void;

  /** 停止订单监控 runtime 并等待在途处理完成 */
  stopOrderMonitorRuntimeAndDrain: () => Promise<void>;

  /** 是否存在指定方向的未完成保护性清仓卖单链路 */
  hasPendingProtectiveLiquidationOrders: (direction: 'LONG' | 'SHORT') => boolean;

  /** 初始化订单监控（WebSocket 订阅） */
  initializeOrderMonitor: () => Promise<void>;

  /** 最终释放交易私有订阅；必须先排空业务，跨日不可调用。 */
  teardown: () => Promise<void>;

  /** 订阅订单终态结算事件 */
  onOrderStateChanged: (listener: (event: OrderStateChangedEvent) => void) => Unsubscribe;

  // ========== 订单执行 ==========

  /** 检查当前是否可交易 */
  canTradeNow: (signalAction: SignalType) => TradeCheckResult;

  /** 从 API 获取全量订单 */
  fetchAllOrdersFromAPI: () => Promise<ReadonlyArray<RawOrderFromAPI>>;

  /** 生命周期午夜清理：重置订单运行态缓存 */
  resetRuntimeState: () => void;

  /** 生命周期开盘重建：基于快照恢复订单追踪 */
  recoverOrderTrackingFromSnapshot: (allOrders: ReadonlyArray<RawOrderFromAPI>) => Promise<void>;

  /** 执行交易信号；返回唯一 accepted ID 与准确保留原输入对象的最终报价失败事实 */
  executeSignals: (
    signals: ReadonlyArray<ExecutableSignal>,
    callerAuthorization: SignalCallerAuthorization,
  ) => Promise<ExecuteSignalsResult>;

  /** 执行末日清仓信号；该专用入口在最终订单命令中标记末日清仓目的。 */
  executeDoomsdayClearanceSignals: (
    commands: ReadonlyArray<DoomsdayClearanceCommand>,
    callerAuthorization: SignalCallerAuthorization,
  ) => Promise<DoomsdayClearanceExecutionResult>;
}

/**
 * 牛熊证类型。
 * 类型用途：区分牛证（做多）与熊证（做空），用于 RiskCheckResult、WarrantDistanceInfo 等字段。
 * 数据来源：Longbridge 行情静态信息或 RiskChecker 解析。
 * 使用范围：RiskChecker、UI/监控展示等；全项目可引用。
 */
export type BullBearWarrantType = 'BULL' | 'BEAR';

/**
 * 牛熊证距离回收价信息。
 * 类型用途：保存未除法、未舍入的距回收价比例基数，用于风控交叉乘比较与终态展示。
 * 数据来源：RiskChecker 根据权威行情与回收价计算；已知分母严格为正，未知时分子/分母同时为 null。
 * 使用范围：RiskChecker、UI/监控展示；全项目可引用。
 */
export type WarrantDistanceInfo = {
  /** 牛熊证类型 */
  readonly warrantType: BullBearWarrantType;

  /** 距回收价比例的精确十进制分子，尚未乘以百分比单位 100 */
  readonly distanceNumerator: string | null;

  /** 距回收价比例的精确十进制分母；已知时严格为正 */
  readonly distanceDenominator: string | null;
};

/**
 * 牛熊证信息刷新结果。
 * 类型用途：表示刷新牛熊证信息的结果（ok/notWarrant/error/skipped），作为 setWarrantInfoFromCallPrice、refreshWarrantInfoForSymbol 返回值。
 * 数据来源：同步 RiskChecker 的已知回收价发布，或 WarrantRiskRefresh 的外部事实查询。
 * 使用范围：同步风险检查、风险刷新用例、调用方与 UI；全项目可引用。
 */
export type WarrantRefreshResult =
  | { readonly status: 'ok'; readonly isWarrant: true }
  | { readonly status: 'notWarrant'; readonly isWarrant: false }
  | { readonly status: 'error'; readonly isWarrant: false; readonly reason: string }
  | { readonly status: 'skipped'; readonly isWarrant: false };

/**
 * 牛熊证距回收价清仓判定结果。
 * 类型用途：表示是否应因距回收价过近而清仓及原因，作为 checkWarrantDistanceLiquidation 返回值。
 * 数据来源：RiskChecker 根据当前价与回收价计算。
 * 使用范围：RiskChecker、信号处理/卖出逻辑；全项目可引用。
 */
export type WarrantDistanceLiquidationResult = {
  /** 是否触发清仓 */
  readonly shouldLiquidate: boolean;

  /** 牛熊证类型 */
  readonly warrantType?: BullBearWarrantType;

  /** 清仓结果的终态展示百分比文本，不作为比例风控的状态或判定输入 */
  readonly distancePercent?: string | null;

  /** 判定原因 */
  readonly reason?: string;
};

/**
 * 风险检查结果。
 * 类型用途：买入订单前/牛熊证风险检查的返回值，表示是否允许交易、原因及牛熊证风险信息。
 * 数据来源：RiskChecker.checkBeforeOrder、checkWarrantRisk 等。
 * 使用范围：信号处理、买卖流程、风控链路；全项目可引用。
 */
export type RiskCheckResult = {
  /** 是否允许交易 */
  readonly allowed: boolean;

  /** 不允许原因 */
  readonly reason?: string;

  /** 牛熊证风险信息 */
  readonly warrantInfo?: {
    /** 是否为牛熊证 */
    readonly isWarrant: boolean;

    /** 牛熊证类型 */
    readonly warrantType: BullBearWarrantType;

    /** 距离回收价百分比 */
    readonly distanceToStrikePercent: string;
  };
};

/**
 * 浮亏数据。
 * 类型用途：存储单标的累计买入金额/数量等，用于计算浮动亏损与强平判定。
 * 数据来源：OrderRecorder 订单记录 + RiskChecker 刷新与计算。
 * 使用范围：RiskChecker、UnrealizedLossMonitor 等；全项目可引用。
 */
export type UnrealizedLossData = {
  /** r1: 累计买入金额 */
  readonly r1: string;

  /** n1: 累计买入数量 */
  readonly n1: number;
};

/** 异步 owner 准备的未发布风险结果；最终 token 校验通过后才能同步 publish。 */
export type PreparedUnrealizedLossData = {
  readonly symbol: string;
  readonly data: UnrealizedLossData;
};

/**
 * 浮亏实时指标。
 * 类型用途：基于浮亏缓存和当前价格计算的实时持仓指标，供行情展示等非清仓场景使用。
 * 数据来源：RiskChecker 读取 UnrealizedLossData 并结合最新价格计算得到。
 * 使用范围：行情展示、风控任务等；全项目可引用。
 */
export type UnrealizedLossMetrics = {
  /** r1: 调整后的开仓成本 */
  readonly r1: string;

  /** n1: 持仓数量 */
  readonly n1: number;

  /** r2: 当前持仓市值 */
  readonly r2: string;

  /** 持仓盈亏（r2 - r1） */
  readonly unrealizedPnL: string;
};

/**
 * 浮亏检查结果。
 * 类型用途：单标的浮亏检查返回值，表示是否应强制平仓、原因及建议平仓数量。
 * 数据来源：RiskChecker.checkUnrealizedLoss。
 * 使用范围：信号处理、卖出逻辑；全项目可引用。
 */
export type UnrealizedLossCheckResult = {
  /** 是否应该强制平仓 */
  readonly shouldLiquidate: boolean;

  /** 平仓原因 */
  readonly reason?: string;

  /** 平仓数量 */
  readonly quantity?: number;
};

/**
 * 买入风险检查上下文。
 * 类型用途：承载固定买入风控流水线所需的交易器、风控器、实时行情与配置依赖。
 * 数据来源：由 BuyProcessor 根据当前 MonitorContext 与执行时行情组装传入。
 * 使用范围：仅买入信号风控链路使用。
 */
export type BuyRiskCheckContext = {
  /** 交易器 */
  readonly trader: Trader;

  /** 风险检查器 */
  readonly riskChecker: RiskChecker;

  /** 订单记录器 */
  readonly orderRecorder: OrderRecorder;

  /** 做多标的行情 */
  readonly longQuote: Quote | null;

  /** 做空标的行情 */
  readonly shortQuote: Quote | null;

  /** 已由买入入口准入的监控行情，价格必须为有效正有限数 */
  readonly monitorQuote: Quote;

  /** 做多标的代码 */
  readonly longSymbol: string;

  /** 做空标的代码 */
  readonly shortSymbol: string;

  /** 做多标的名称 */
  readonly longSymbolName: string | null;

  /** 做空标的名称 */
  readonly shortSymbolName: string | null;

  /** 当前时间 */
  readonly currentTime: Date;

  /** 是否为半日市 */
  readonly isHalfDay: boolean;

  /** 监控配置 */
  readonly config: MonitorConfig;
};

/**
 * 风险检查器接口。
 * 类型用途：依赖注入用接口，门面模式协调牛熊证风险、持仓限制与浮亏检查，供信号处理与买卖流程调用。
 * 数据来源：实现层对接行情与订单记录；牛熊证/浮亏数据由内部缓存与 API 维护。
 * 使用范围：MonitorContext、信号处理、风控链路等；全项目可引用。
 */
export interface RiskChecker {
  /** 从透传的回收价设置牛熊证信息（不调用 API） */
  setWarrantInfoFromCallPrice: (
    symbol: string,
    callPrice: string,
    isLongSymbol: boolean,
    symbolName?: string | null,
  ) => WarrantRefreshResult;

  /** 买入订单前风险检查（现金与持仓限制） */
  checkBeforeOrder: (params: {
    readonly account: AccountSnapshot | null;
    readonly positions: ReadonlyArray<Position> | null;
    readonly signal: BuySignal;
    readonly orderNotional: string;
  }) => RiskCheckResult;

  /** 牛熊证风险检查（距离回收价阈值） */
  checkWarrantRisk: (
    symbol: string,
    signalType: SignalType,
    monitorCurrentPrice: string,
  ) => RiskCheckResult;

  /** 牛熊证距回收价清仓检查 */
  checkWarrantDistanceLiquidation: (
    symbol: string,
    isLongSymbol: boolean,
    monitorCurrentPrice: string,
  ) => WarrantDistanceLiquidationResult;

  /** 获取牛熊证距离回收价信息（实时展示用） */
  getWarrantDistanceInfo: (
    isLongSymbol: boolean,
    seatSymbol: string,
    monitorCurrentPrice: string | null,
  ) => WarrantDistanceInfo | null;

  /** 清空做多标的牛熊证信息缓存（换标时调用） */
  clearLongWarrantInfo: () => void;

  /** 清空做空标的牛熊证信息缓存（换标时调用） */
  clearShortWarrantInfo: () => void;

  /** 无副作用准备 R1/N1；不得在异步返回后才判断是否已经污染缓存。 */
  prepareUnrealizedLossData: (
    orderRecorder: OrderRecorder,
    symbol: string,
    isLongSymbol: boolean,
    dailyLossOffset: string,
  ) => PreparedUnrealizedLossData;

  /** 调用方完成最终 token/身份验证的同一同步段发布。 */
  publishUnrealizedLossData: (prepared: PreparedUnrealizedLossData) => void;

  /** 浮亏检查（是否触发强平） */
  checkUnrealizedLoss: (
    symbol: string,
    currentPrice: string,
    isLongSymbol: boolean,
  ) => UnrealizedLossCheckResult;

  /** 获取实时浮亏指标（用于展示持仓市值与持仓盈亏） */
  getUnrealizedLossMetrics: (
    symbol: string,
    currentPrice: string | null,
  ) => UnrealizedLossMetrics | null;

  /** 清空浮亏缓存（symbol 为空时清空全部） */
  clearUnrealizedLossData: (symbol?: string | null) => void;
}
