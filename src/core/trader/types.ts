import type {
  Config,
  Decimal,
  OrderSide,
  OrderType,
  OrderStatus,
  TimeInForceType,
  TradeContext,
} from 'longbridge';
import type {
  DoomsdayClearanceCommand,
  ExecutableSignal,
  SignalType,
  OrderTypeConfig,
} from '../../types/signal.js';
import type { AccountSnapshot, Position } from '../../types/account.js';
import type { ExternalApiRetryConfig } from '../../utils/apiFailure/types.js';
import type { TradingConfig } from '../../types/config.js';
import type { SymbolRegistry } from '../../types/seat.js';
import type {
  PendingOrder,
  PostTradeConsistencyRuntimePort,
  TradeCheckResult,
  RateLimiter,
  TradeMutationPermit,
  RawOrderFromAPI,
  OrderRecorder,
  MarketDataClient,
  OrderStateChangedEvent,
  OrderHoldSymbolsChangedEvent,
  RiskChecker,
  TradingDayInfo,
  Unsubscribe,
} from '../../types/services.js';
import type {
  DailyLossTracker,
  ProtectiveLiquidationExecutionProgressInput,
} from '../../types/risk.js';
import type {
  CancelOrderOutcome,
  DoomsdayCancelOrderOutcome,
  DoomsdayCancelOrderRequest,
  DoomsdayClearanceExecutionResult,
  ExecuteSignalsResult,
} from '../../types/trader.js';
import type { ProtectiveLiquidationEpisodeTracker } from './protectiveLiquidationEpisodeTracker/types.js';

/**
 * 订单提交 API 可能返回的响应形状。
 * 类型用途：用于 extractOrderId 安全提取订单 ID。
 * 数据来源：由 Longbridge API 的 submitOrder 响应返回。
 * 使用范围：仅在 trader 模块内部使用。
 */
export type OrderSubmitResponse = {
  readonly orderId?: string;
};

/**
 * 订单提交载荷。
 * 类型用途：封装调用 ctx.submitOrder() 时的参数。
 * 数据来源：模块内部根据信号与配置构造。
 * 使用范围：仅在 trader 模块内部使用。
 */
export type OrderPayload = {
  readonly symbol: string;
  readonly orderType: OrderType;
  readonly side: OrderSide;
  readonly timeInForce: TimeInForceType;
  readonly submittedQuantity: Decimal;
  readonly submittedPrice?: Decimal;
  readonly remark?: string;
};

/**
 * 订单追踪入参。
 * 类型用途：传递给 OrderMonitor.trackOrder() 的参数，用于追踪订单状态变化。
 * 数据来源：提交订单后由 OrderExecutor 等构造。
 * 使用范围：仅在 trader 模块内部使用。
 */
export type TrackOrderParams = {
  readonly orderId: string;
  readonly symbol: string;
  readonly side: OrderSide;
  readonly price: number;
  readonly initialSubmittedPrice: number;
  readonly quantity: number;

  /** 可选：恢复阶段使用原始下单时间（毫秒），用于保持超时策略语义一致 */
  readonly submittedAtMs?: number;

  /** 可选：恢复阶段保留快照中的 pending 状态，避免错误触发改单流程 */
  readonly initialStatus?: OrderStatus;
  readonly isLongSymbol: boolean;
  readonly monitorSymbol: string;
  readonly isProtectiveLiquidation: boolean;
  readonly orderType: OrderType;
};

/**
 * 订单监控运行态。
 * 类型用途：区分停机忽略（STOPPED）、恢复缓存（BOOTSTRAPPING）与实时处理（ACTIVE）的事件策略。
 * 数据来源：OrderMonitor 内部状态机维护。
 * 使用范围：仅 trader/orderMonitor 模块内部使用。
 */
export type OrderMonitorRuntimeState = 'STOPPED' | 'BOOTSTRAPPING' | 'ACTIVE';

/**
 * 订单席位归属解析结果。
 * 类型用途：表示订单归属的监控标的与方向，用于恢复阶段席位匹配校验。
 * 数据来源：根据订单名称映射与监控配置解析得到。
 * 使用范围：仅 trader/orderMonitor 模块内部使用。
 */
export type OrderSeatOwnership = {
  readonly monitorSymbol: string;
  readonly direction: 'LONG' | 'SHORT';
  readonly isLongSymbol: boolean;
};

/**
 * 恢复后快照对账参数。
 * 类型用途：统一携带恢复输入快照、已撤销不匹配买单集合和回放订单集合。
 * 数据来源：OrderMonitor.recoverOrderTrackingFromSnapshot 流程内部构造。
 * 使用范围：仅 trader/orderMonitor 模块内部使用。
 */
export type RecoverySnapshotReconciliationParams = {
  readonly allOrders: ReadonlyArray<RawOrderFromAPI>;
  readonly closedMismatchedBuyOrderIds: ReadonlySet<string>;
  readonly replayedOrderIds: ReadonlySet<string>;
};

/**
 * 订单类型解析配置（信号级覆盖 / 保护性清仓 / 全局类型）。
 * 类型用途：封装订单类型解析所需的全局配置。
 * 数据来源：来自交易配置（tradingOrderType、liquidationOrderType）。
 * 使用范围：仅在 trader 模块内部使用。
 */
export type OrderTypeResolutionConfig = {
  readonly tradingOrderType: OrderTypeConfig;
  readonly liquidationOrderType: OrderTypeConfig;
};

/**
 * 订单提交错误日志分类。
 * 类型用途：标识订单提交失败日志应使用的分类文本，不参与重试、跳过或交易决策。
 * 数据来源：由 orderExecutor/identifyErrorType 根据 API 错误消息解析得到。
 * 使用范围：仅 orderExecutor 的提交失败日志路径使用。
 */
export type ErrorTypeIdentifier = {
  readonly isShortSellingNotSupported: boolean;
  readonly isInsufficientFunds: boolean;
  readonly isNetworkError: boolean;
  readonly isRateLimited: boolean;
};

// ==================== 服务接口定义 ====================

/**
 * 账户服务接口。
 * 类型用途：提供账户快照与持仓查询，供 Trader/OrderExecutor 等获取资金与持仓状态。
 * 数据来源：由 Trader 依赖注入，实现层通过 TradeContext 调用 Longbridge API 获取。
 * 使用范围：仅 trader 模块内部实现与使用。
 */
export interface AccountService {
  getAccountSnapshot: (params?: {
    readonly retryConfig?: ExternalApiRetryConfig;
  }) => Promise<AccountSnapshot>;
  getStockPositions: (params?: {
    readonly symbols?: ReadonlyArray<string> | null;
    readonly retryConfig?: ExternalApiRetryConfig;
  }) => Promise<ReadonlyArray<Position>>;
}

/**
 * 今日订单缓存原始条目。
 * 类型用途：表达 orderCacheManager 从 todayOrders 信任边界接收并已校验的订单字段。
 * 数据来源：Longbridge TradeContext.todayOrders 返回数组中的单条订单。
 * 使用范围：仅 orderCacheManager 构造 PendingOrder 缓存前使用。
 */
export type TodayOrderForPendingCache = Readonly<{
  orderId: string;
  symbol: string;
  side: OrderSide;
  price: unknown;
  quantity: unknown;
  executedQuantity: unknown;
  status: OrderStatus;
  orderType: PendingOrder['orderType'];
}>;

/**
 * 订单缓存管理器接口。
 * 类型用途：提供待成交订单查询与缓存清理，供下单前校验与恢复阶段使用。
 * 数据来源：由 Trader 依赖注入，实现层通过 TradeContext 拉取订单并缓存。
 * 使用范围：仅 trader 模块内部实现与使用。
 */
export interface OrderCacheManager {
  getPendingOrders: (
    symbols?: ReadonlyArray<string> | null,
    forceRefresh?: boolean,
  ) => Promise<ReadonlyArray<PendingOrder>>;
  clearCache: () => void;
}

/**
 * 订单监控器接口。
 * 类型用途：订单生命周期监控（追踪、撤单、改价、恢复等），与 WebSocket 订单推送协同。
 * 数据来源：由 Trader 依赖注入，实现层在 orderMonitor 模块内。
 * 使用范围：trader 模块内部；恢复流程调用其方法。
 */
export interface OrderMonitor {
  /** 初始化 WebSocket 订阅 */
  initialize: () => Promise<void>;

  /** 订阅订单终态结算事件 */
  onOrderStateChanged: (listener: (event: OrderStateChangedEvent) => void) => Unsubscribe;

  /** 开始追踪订单 */
  trackOrder: (params: TrackOrderParams) => void;

  /** 常规撤单；若 tracked order 已被权威确认为终态，会先完成本地结算再返回结果。 */
  cancelOrder: (orderId: string, request: OrderMutationRequest) => Promise<CancelOrderOutcome>;

  /** 末日保护撤单；保留 permit 内门禁失效且 broker 未调用的专用结果。 */
  cancelDoomsdayOrder: (
    orderId: string,
    request: DoomsdayCancelOrderRequest,
  ) => Promise<DoomsdayCancelOrderOutcome>;

  /**
   * 在调用方已取得的 mutation permit 内执行一次信号驱动的改单。
   * permit 为必填，禁止在该路径降级为重新排队或使用旧价格调用。
   */
  replaceOrderPriceWithPermit: (
    orderId: string,
    newPrice: number,
    request: OrderMutationRequest,
    permit: TradeMutationPermit,
    quantity?: number | null,
  ) => Promise<ReplaceOrderPriceOutcome>;

  /** 启动订单监控 runtime */
  startRuntime: () => void;

  /** 停止订单监控 runtime 并等待在途处理完成 */
  stopRuntimeAndDrain: () => Promise<void>;

  /** 基于启动/重建快照恢复订单追踪（仅使用调用方传入的 allOrders） */
  recoverOrderTrackingFromSnapshot: (allOrders: ReadonlyArray<RawOrderFromAPI>) => Promise<void>;

  /** 获取指定标的的未成交卖单快照 */
  getPendingSellOrders: (symbol: string) => ReadonlyArray<PendingSellOrderSnapshot>;

  /** 是否存在指定方向的未完成保护性清仓卖单链路 */
  hasPendingProtectiveLiquidationOrders: (direction: 'LONG' | 'SHORT') => boolean;

  /** 清空恢复运行态（tracked order lifecycle / closed set）与 BOOTSTRAPPING 事件缓存 */
  clearTrackedOrders: () => void;
}

/**
 * 订单执行器接口。
 * 由 Trader 依赖注入。
 * 类型用途：用于 OrderExecutor 的类型约束与语义表达。
 * 数据来源：由当前模块的入参、返回值或运行时派生数据提供（如适用）。
 * 使用范围：仅在当前模块及其直接依赖方使用。
 */
export interface OrderExecutor {
  canTradeNow: (signalAction: SignalType) => TradeCheckResult;
  executeSignals: (signals: ReadonlyArray<ExecutableSignal>) => Promise<ExecuteSignalsResult>;

  /** 末日清仓专用入口；仅该入口可构造末日清仓执行目的。 */
  executeDoomsdayClearanceSignals: (
    commands: ReadonlyArray<DoomsdayClearanceCommand>,
  ) => Promise<DoomsdayClearanceExecutionResult>;

  /** 清空 lastBuyTime（买入节流状态） */
  resetBuyThrottle: () => void;
}

/**
 * 频率限制器配置。
 * 类型用途：控制 API 调用频率（窗口内最大调用次数与窗口时长）。
 * 数据来源：由 Trader 从 tradingConfig 或默认值构造，传入 createRateLimiter。
 * 使用范围：仅在 trader 模块内部使用。
 */
export type RateLimiterConfig = {
  readonly maxCalls: number;
  readonly windowMs: number;
};

/**
 * 频率限制器依赖。
 * 类型用途：创建 RateLimiter 实例时的依赖注入参数。
 * 数据来源：由 Trader 工厂在创建 rateLimiter 时传入。
 * 使用范围：仅在 trader 模块内部使用。
 */
export type RateLimiterDeps = {
  readonly config?: RateLimiterConfig;
};

/**
 * 账户服务依赖。
 * 类型用途：创建 AccountService 实例时的依赖注入参数。
 * 数据来源：由 Trader 工厂在创建 accountService 时传入。
 * 使用范围：仅在 trader 模块内部使用。
 */
export type AccountServiceDeps = {
  readonly ctx: TradeContext;
  readonly rateLimiter: RateLimiter;
};

/**
 * 订单缓存管理器依赖。
 * 类型用途：用于创建 OrderCacheManager 时的依赖注入。
 * 数据来源：如适用。
 * 使用范围：仅在 trader 模块内部使用。
 */
export type OrderCacheManagerDeps = {
  readonly ctx: TradeContext;
  readonly rateLimiter: RateLimiter;
};

/**
 * 追踪中的订单信息。
 * 类型用途：OrderMonitor 内部存储，用于 WebSocket 监控订单状态变化，跟踪委托价和成交情况。
 * 数据来源：由 trackOrder 入参初始化，状态由 WebSocket 推送更新。
 * 使用范围：仅在 trader 模块内部使用。
 */
export type TrackedOrder = {
  readonly orderId: string;
  readonly symbol: string;
  readonly side: OrderSide;

  /** 是否为做多标的（成交后更新本地记录时使用） */
  readonly isLongSymbol: boolean;

  /** 监控标的代码（用于成交日志与冷却恢复） */
  readonly monitorSymbol: string;

  /** 是否为保护性清仓订单（用于触发买入冷却） */
  readonly isProtectiveLiquidation: boolean;

  /** 订单类型（用于合并和改单判断） */
  readonly orderType: OrderType;

  /** 当前委托价（会随市价更新） */
  submittedPrice: number;

  /** 跟踪开始时的初始委托价（用于买单跟价上限判断，不会被改单覆盖） */
  readonly initialSubmittedPrice: number;

  /** 委托数量（含部分成交后的剩余总量） */
  submittedQuantity: number;

  /** 已成交数量（部分成交时累加） */
  executedQuantity: number;

  /** 最近一次已成交价格（部分成交/完全成交时更新） */
  executedPrice: number | null;

  /** 最近一次已成交时间（毫秒） */
  lastExecutedTimeMs: number | null;

  /** 最近一次已合并的订单事件更新时间（毫秒），用于拒绝乱序 WS 回退 */
  lastOrderUpdateAtMs: number | null;

  /** 当前订单状态（由 WebSocket 推送更新） */
  status: OrderStatus;

  /** 提交时间戳（用于超时检测） */
  readonly submittedAt: number;

  /** 上次修改价格的时间（用于控制修改频率） */
  lastPriceUpdateAt: number;

  /** 是否已转为市价单（防止重复转换） */
  convertedToMarket: boolean;

  /** 下次允许发起撤单尝试的时间戳（毫秒） */
  nextCancelAttemptAt: number;

  /** 撤单重试计数（用于指数退避） */
  cancelRetryCount: number;

  /** 改单能力状态 */
  replaceCapability: 'SUPPORTED' | 'UNSUPPORTED_BY_TYPE' | 'TEMP_BLOCKED_BY_STATUS';

  /** 临时禁改截止时间戳（毫秒） */
  replaceBlockedUntilAt: number | null;
};

/**
 * 未成交卖单快照（用于卖单合并决策）。
 * 类型用途：提供卖单合并决策所需的订单状态信息。
 * 数据来源：OrderMonitor.getPendingSellOrders 返回。
 * 使用范围：仅在 trader 模块内部使用。
 */
export type PendingSellOrderSnapshot = {
  readonly orderId: string;
  readonly symbol: string;
  readonly side: OrderSide;
  readonly status: OrderStatus;
  readonly orderType: OrderType;
  readonly submittedPrice: number;
  readonly submittedQuantity: number;
  readonly executedQuantity: number;
  readonly submittedAt: number;
};

/**
 * 卖单合并决策动作。
 * 类型用途：表示卖单合并策略（SUBMIT/REPLACE/CANCEL_AND_SUBMIT/SKIP），供 OrderExecutor 执行对应操作。
 * 数据来源：由 decideSellMerge 根据 pendingOrders 与 newOrder 计算后返回的 action 字段。
 * 使用范围：仅在 trader 模块内部使用。
 */
type SellMergeDecisionAction = 'SUBMIT' | 'REPLACE' | 'CANCEL_AND_SUBMIT' | 'SKIP';

/**
 * 卖单合并决策输入
 * 由 OrderExecutor 在提交卖单前构造，传入 decideSellMerge 函数以决定合并策略
 * 仅在 trader 模块内部使用
 * 类型用途：用于 SellMergeDecisionInput 的类型约束与语义表达。
 * 数据来源：由当前模块的入参、返回值或运行时派生数据提供（如适用）。
 * 使用范围：仅在当前模块及其直接依赖方使用。
 */
export type SellMergeDecisionInput = {
  readonly symbol: string;
  readonly pendingOrders: ReadonlyArray<PendingSellOrderSnapshot>;
  readonly newOrderQuantity: number;
  readonly newOrderType: OrderType;
  readonly isProtectiveLiquidation: boolean;
};

/**
 * 卖单合并决策结果
 * 由 decideSellMerge 函数返回，OrderExecutor 根据 action 字段执行对应的下单/改单/撤单操作
 * 仅在 trader 模块内部使用
 * 类型用途：用于 SellMergeDecision 的类型约束与语义表达。
 * 数据来源：由当前模块的入参、返回值或运行时派生数据提供（如适用）。
 * 使用范围：仅在当前模块及其直接依赖方使用。
 */
export type SellMergeDecision = {
  readonly action: SellMergeDecisionAction;
  readonly mergedQuantity: number;
  readonly targetOrderId: string | null;
  readonly pendingOrderIds: ReadonlyArray<string>;
  readonly pendingRemainingQuantity: number;
  readonly reason:
    | 'no-additional-quantity'
    | 'no-pending-sell'
    | 'cancel-and-merge'
    | 'replace-and-merge';
};

/**
 * 订单监控配置。
 * 类型用途：控制订单超时转换和价格修改行为。
 * 数据来源：如适用（来自交易配置等）。
 * 使用范围：仅在 trader 模块内部使用。
 */
export type OrderMonitorConfig = {
  readonly buyTimeout: {
    readonly enabled: boolean;
    readonly timeoutMs: number;
  };
  readonly sellTimeout: {
    readonly enabled: boolean;
    readonly timeoutMs: number;
  };

  /** 价格修改最小间隔（毫秒） */
  readonly priceUpdateIntervalMs: number;

  /** 价格差异阈值（低于此值不触发修改） */
  readonly priceDiffThreshold: number;

  /** 买单跟价是否允许高于初始委托价 */
  readonly allowBuyOrderTrackingAboveInitialPrice: boolean;
};

/**
 * 订单订阅保留集管理器。
 * 类型用途：依赖注入的服务接口，跟踪需持续订阅的订单标的、恢复订阅状态、成交后移除标记。
 * 数据来源：如适用。
 * 使用范围：由 Trader/OrderMonitor 依赖注入，仅 trader 模块实现与使用。
 */
export interface OrderHoldRegistry {
  /** 跟踪订单（添加标的到订阅保留集） */
  trackOrder: (orderId: string, symbol: string) => void;

  /** 标记订单已关闭（成交/撤销/拒绝/主动撤单成功），从订阅保留集中移除 */
  markOrderClosed: (orderId: string) => void;

  /** 从历史订单初始化订阅保留集（程序重启时调用） */
  seedFromOrders: (orders: ReadonlyArray<RawOrderFromAPI>) => void;

  /** 获取当前需要持续订阅的标的集合 */
  getHoldSymbols: () => ReadonlySet<string>;

  /** 订阅订单保留标的集合变化事件 */
  onOrderHoldSymbolsChanged: (
    listener: (event: OrderHoldSymbolsChangedEvent) => void,
  ) => Unsubscribe;

  /** 清空内部 map/set */
  clear: () => void;
}

/**
 * 订单监控器依赖。
 * 类型用途：用于创建 OrderMonitor 时的依赖注入。
 * 数据来源：如适用。
 * 使用范围：仅在 trader 模块内部使用。
 */
export type OrderMonitorDeps = {
  readonly ctx: TradeContext;
  readonly rateLimiter: RateLimiter;
  readonly cacheManager: OrderCacheManager;
  readonly marketDataClient: MarketDataClient;

  /** 订单记录器（用于成交后更新本地记录） */
  readonly orderRecorder: OrderRecorder;

  /** 当日亏损跟踪器（成交后增量记录） */
  readonly dailyLossTracker: DailyLossTracker;

  /** 订单订阅保留集 */
  readonly orderHoldRegistry: OrderHoldRegistry;

  /** 保护性清仓事件跟踪器（用于完成边界） */
  readonly protectiveLiquidationEpisodeTracker: ProtectiveLiquidationEpisodeTracker;

  /** 保护性累计成交进度的前置持久化端口。 */
  readonly persistProtectiveLiquidationExecutionProgress: (
    input: ProtectiveLiquidationExecutionProgressInput,
  ) => void;

  /** 标的注册表（用于解析动态标的归属） */
  readonly symbolRegistry: SymbolRegistry;

  /** 全局交易配置 */
  readonly tradingConfig: TradingConfig;

  /** 成交后一致性运行时（负责收口成交后的最小补刷需求） */
  readonly postTradeConsistencyRuntime: PostTradeConsistencyRuntimePort;

  /** 连续交易授权（仅用于订单监控派生的新订单与自动改单） */
  readonly isContinuousTradingAllowed: ContinuousTradingOrderAuthorization;

  /** 运行期订单监控失败的统一 fatal 通道。 */
  readonly onFatalError: (error: unknown) => void;
};

/**
 * 运行时执行门禁。
 * 类型用途：无参函数，返回当前是否允许下单；门禁关闭时 OrderExecutor 仅记录日志并跳过，不下单。
 * 数据来源：由主程序/启动层注入，单一状态源，执行层统一判定。
 * 使用范围：Trader、OrderMonitor、OrderExecutor 依赖注入使用。
 */
type IsExecutionAllowed = () => boolean;

/**
 * 连续交易订单授权。
 * 类型用途：仅允许订单监控在连续交易时段发起新的超时市价单或自动改单；每次 SDK attempt 都必须重新读取。
 * 数据来源：运行态的生命周期交易开关与连续交易门禁。
 * 使用范围：OrderMonitor route 与连续交易授权 mutation 请求。
 */
type ContinuousTradingOrderAuthorization = () => boolean;

/**
 * 信号派生订单副作用授权阶段。
 * 类型用途：限制授权器只接受真实存在的执行与 mutation API 前阶段。
 * 数据来源：OrderExecutor 与 OrderMonitor 固定调用点。
 * 使用范围：OrderActionAuthorization 参数。
 */
export type OrderActionAuthorizationStage =
  | 'executeSignals'
  | 'submitOrder.beforeApi'
  | 'cancelOrder.beforeApi'
  | 'replaceOrder.beforeApi';

/**
 * 信号派生订单副作用授权器。
 * 类型用途：在固定订单副作用阶段复核信号绑定是否仍然有效。
 * 数据来源：OrderExecutor 根据信号与当前运行态创建。
 * 使用范围：executeSignals 初始复核与 SIGNAL_AUTHORIZED 订单 mutation 请求。
 */
export type OrderActionAuthorization = (stage: OrderActionAuthorizationStage) => boolean;

/**
 * 最终下单授权读取的当日交易日事实。
 * 类型用途：把权威 TradingDayInfo 与其香港日期键绑定，防止跨日误用旧日历状态。
 * 数据来源：app runtime 的 LastState.cachedTradingDayInfo。
 * 使用范围：Trader 与 OrderExecutor 的末日保护最终买入授权。
 */
type CurrentTradingDayInfo = Readonly<{
  dateKey: string;
  info: TradingDayInfo;
}>;

/**
 * 最终下单授权的实时交易日事实读取器。
 * 类型用途：在 broker mutation 前同步读取当前权威交易日状态。
 * 数据来源：由 app runtime 注入。
 * 使用范围：Trader 与 OrderExecutor。
 */
type CurrentTradingDayInfoReader = () => CurrentTradingDayInfo | null;

/**
 * 订单 mutation 请求来源。
 * 类型用途：强制调用方区分公共订单事实、信号派生与连续交易派生的常规 mutation 授权来源。
 * 数据来源：订单 owner、OrderExecutor 信号链路或 OrderMonitor 连续交易链路创建。
 * 使用范围：OrderMonitor cancel/replace API。
 */
export type OrderMutationRequest =
  | { readonly kind: 'ORDER_FACT' }
  | {
      readonly kind: 'SIGNAL_AUTHORIZED';
      readonly authorize: OrderActionAuthorization;
    }
  | {
      readonly kind: 'CONTINUOUS_TRADING_AUTHORIZED';
      readonly authorize: ContinuousTradingOrderAuthorization;
    };

/**
 * 撤单 mutation 请求来源。
 * 类型用途：在常规 mutation 授权外，允许末日保护将其专用 permit 内门禁显式带到撤单边界，禁止该授权用于改单。
 * 数据来源：订单 owner、OrderExecutor、OrderMonitor route 与 DoomsdayProtection。
 * 使用范围：OrderMonitor.cancelOrder、OrderMonitor.cancelDoomsdayOrder 与 OrderOps.cancelOrder。
 */
export type CancelOrderMutationRequest = OrderMutationRequest | DoomsdayCancelOrderRequest;

/**
 * 改单执行结果。
 * 类型用途：明确区分 broker 已确认改单与未执行，防止未执行时更新本地 pending fact。
 * 数据来源：订单监控内部改单与 permit 改单入口返回。
 * 使用范围：OrderExecutor 卖单合并链路。
 */
export type ReplaceOrderPriceOutcome =
  | { readonly kind: 'BROKER_CONFIRMED' }
  | { readonly kind: 'NOT_EXECUTED' };

/**
 * 订单执行器依赖。
 * 类型用途：用于创建 OrderExecutor 时的依赖注入。
 * 数据来源：如适用。
 * 使用范围：仅在 trader 模块内部使用。
 */
export type OrderExecutorDeps = {
  readonly ctx: TradeContext;
  readonly rateLimiter: RateLimiter;

  /** 与 Trader 共用的行情客户端；仅最终订单 callback permit 内读取执行行情。 */
  readonly marketDataClient: MarketDataClient;
  readonly cacheManager: OrderCacheManager;
  readonly orderMonitor: OrderMonitor;

  /** 订单记录器（用于卖出订单防重追踪） */
  readonly orderRecorder: OrderRecorder;

  /** 与运行时共享的浮亏买入门禁；仅在最终 BUY 提交边界读取。 */
  readonly unrealizedLossBuyGate: Pick<RiskChecker, 'checkUnrealizedLoss'>;

  /** 全局交易配置 */
  readonly tradingConfig: TradingConfig;

  /** 标的注册表（用于解析动态标的归属） */
  readonly symbolRegistry: SymbolRegistry;

  /** 运行时执行门禁（单一状态源注入，执行层统一判定） */
  readonly isExecutionAllowed: IsExecutionAllowed;

  /** 连续交易授权；最终 SDK mutation 前必须再次读取。 */
  readonly isContinuousTradingAllowed: ContinuousTradingOrderAuthorization;

  /** 最终订单授权使用的实时钟。 */
  readonly now: () => Date;

  /** 最终订单授权使用的权威当日交易日事实读取器。 */
  readonly readCurrentTradingDayInfo: CurrentTradingDayInfoReader;
};

/**
 * 交易器依赖。
 * 类型用途：用于创建顶层 Trader 实例时的依赖注入。
 * 数据来源：如适用。
 * 使用范围：见调用方（启动层等）。
 */
export type TraderDeps = {
  readonly config: Config;
  readonly tradingConfig: TradingConfig;
  readonly marketDataClient: MarketDataClient;

  /** 与 MonitorContext 共用的浮亏买入门禁，保证读取同一 R1/N1 与当日亏损偏移缓存。 */
  readonly unrealizedLossBuyGate: Pick<RiskChecker, 'checkUnrealizedLoss'>;
  readonly rateLimiterConfig?: RateLimiterConfig;

  /** 标的注册表（用于动态标的映射） */
  readonly symbolRegistry: SymbolRegistry;
  readonly dailyLossTracker: DailyLossTracker;
  readonly protectiveLiquidationEpisodeTracker: ProtectiveLiquidationEpisodeTracker;
  readonly persistProtectiveLiquidationExecutionProgress: (
    input: ProtectiveLiquidationExecutionProgressInput,
  ) => void;

  /** 成交后一致性运行时（负责收口成交后的最小补刷需求） */
  readonly postTradeConsistencyRuntime: PostTradeConsistencyRuntimePort;

  /** 运行时执行门禁（单一状态源注入，执行层统一判定） */
  readonly isExecutionAllowed: IsExecutionAllowed;

  /** 连续交易授权（仅由 OrderMonitor 派生新订单与自动改单使用） */
  readonly isContinuousTradingAllowed: ContinuousTradingOrderAuthorization;

  /** 最终订单授权使用的实时钟。 */
  readonly now: () => Date;

  /** 最终订单授权使用的权威当日交易日事实读取器。 */
  readonly readCurrentTradingDayInfo: CurrentTradingDayInfoReader;

  /** 运行期异步错误的统一 fatal 通道。 */
  readonly onFatalError: (error: unknown) => void;
};
