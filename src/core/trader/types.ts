import type {
  OrderMutationRequest,
  PendingSellOrderSnapshot,
  ReplaceOrderPriceOutcome,
  TrackOrderParams,
} from '../../domain/order/types.js';
import type { BrokerAccess } from '../../types/brokerAccessPorts.js';
import type { Position } from '../../types/account.js';
import type { OrderExecutor } from '../../types/orderExecutionPorts.js';
import type { OrderDetailReadPort } from '../../types/orderDetailReadPorts.js';
import type { OrderReadStatus, OrderReadType } from '../../types/orderReadMetadata.js';
import type { RuntimeTermination } from '../../types/runtime.js';
import type { TradeMutationPort } from '../../types/tradeMutationPorts.js';
import type { OrderExecutionLedgerPort } from '../../types/orderExecutionLedger.js';
import type { OrderPushPort } from '../../types/orderPushPorts.js';
import type { SettlementRefreshNeedRecorder } from '../../types/settlement.js';
import type { MarketDataClient, TradingDayInfo } from '../../types/marketPorts.js';
import type { TradingConfig } from '../../types/config.js';
import type { SymbolRegistry } from '../../types/seat.js';
import type {
  PendingOrder,
  RateLimiter,
  TradeMutationPermit,
  RawOrderFromAPI,
  OrderRecorder,
  OrderStateChangedEvent,
  OrderHoldSymbolsChangedEvent,
  RiskChecker,
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
} from '../../types/trader.js';
import type { ProtectiveLiquidationEpisodeTracker } from '../../domain/liquidation/episode/types.js';

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

// ==================== 服务接口定义 ====================

/**
 * 今日订单缓存原始条目。
 * 类型用途：表达 orderCacheManager 从 todayOrders 信任边界接收并已校验的订单字段。
 * 数据来源：Longbridge TradeContext.todayOrders 返回数组中的单条订单。
 * 使用范围：仅 orderCacheManager 构造 PendingOrder 缓存前使用。
 */
export type TodayOrderForPendingCache = Readonly<{
  orderId: string;
  symbol: string;
  side: PendingOrder['side'];
  submittedPrice: string | null;
  quantity: number;
  executedQuantity: number;
  status: PendingOrder['status'];
  orderType: PendingOrder['orderType'];
}>;

/**
 * 今日订单查询端口。
 * 类型用途：仅暴露 orderCacheManager 所需的 todayOrders 行为，返回值在模块信任边界内校验。
 * 数据来源：生产环境由 Longbridge TradeContext 提供；测试可直接提供最小 double。
 * 使用范围：仅 OrderCacheManagerDeps。
 */
export interface TodayOrdersReader {
  todayOrders: () => Promise<unknown>;
}

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

  /** 最终释放 Private 订阅；必须先排空业务，跨日不可调用。 */
  teardown: () => Promise<void>;

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
    newPrice: string,
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
 * 订单缓存管理器依赖。
 * 类型用途：用于创建 OrderCacheManager 时的依赖注入。
 * 数据来源：如适用。
 * 使用范围：仅在 trader 模块内部使用。
 */
export type OrderCacheManagerDeps = {
  readonly ctx: TodayOrdersReader;
  readonly rateLimiter: RateLimiter;

  /** 未成交订单缓存 TTL 使用的统一运行时时钟。 */
  readonly now: () => Date;
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
  readonly side: 'BUY' | 'SELL';
  readonly executionSide: 'BUY' | 'SELL';

  /** 原mapper/已接受观察的生命周期；尚无broker事实时未知。 */
  executionPhase: 'OPEN' | 'TERMINAL' | null;

  /** 是否为做多标的（成交后更新本地记录时使用） */
  readonly isLongSymbol: boolean;

  /** 监控标的代码（用于成交日志与冷却恢复） */
  readonly monitorSymbol: string;

  /** 是否为保护性清仓订单（用于触发买入冷却） */
  readonly isProtectiveLiquidation: boolean;

  /** 订单类型（用于合并和改单判断） */
  readonly orderType: OrderReadType;

  /** 当前委托价；市价单为 null，非市价单会随改单更新。 */
  submittedPrice: string | null;

  /** 跟踪开始时的初始委托价；市价单为 null，用于非市价买单跟价上限判断。 */
  readonly initialSubmittedPrice: string | null;

  /** 委托数量（含部分成交后的剩余总量） */
  submittedQuantity: number;

  /** 已成交数量（部分成交时累加） */
  executedQuantity: number;

  /** 最近一次已成交价格（部分成交/完全成交时更新） */
  executedPrice: string | null;
  executedAmount: string;

  /** 最近一次已成交时间（毫秒） */
  lastExecutedTimeMs: number | null;

  /** 最近一次已合并的订单事件更新时间（毫秒），用于拒绝乱序 WS 回退 */
  lastOrderUpdateAtMs: number | null;

  /** 当前订单状态（由 WebSocket 推送更新） */
  status: OrderReadStatus;

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
  readonly priceDiffThreshold: string;

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
  readonly orderDetailReadPort: OrderDetailReadPort;
  readonly executionLedgerPort: OrderExecutionLedgerPort;
  readonly orderPushPort: OrderPushPort;
  readonly tradeMutationPort: TradeMutationPort;
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
  readonly postTradeConsistencyRuntime: SettlementRefreshNeedRecorder;

  /** 连续交易授权（仅用于订单监控派生的新订单与自动改单） */
  readonly isContinuousTradingAllowed: ContinuousTradingOrderAuthorization;

  /** 订单 timeout/retry route 使用的统一运行时时钟。 */
  readonly now: () => Date;

  /** 订单 timeout/retry route 使用的统一 timer scheduler。 */
  readonly scheduleTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void;

  /** 运行期订单监控失败的统一 fatal 通道。 */
  readonly termination: Pick<RuntimeTermination, 'isTerminated' | 'reportFatalError'>;
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
 * 撤单 mutation 请求来源。
 * 类型用途：在常规 mutation 授权外，允许末日保护将其专用 permit 内门禁显式带到撤单边界，禁止该授权用于改单。
 * 数据来源：订单 owner、OrderExecutor、OrderMonitor route 与 DoomsdayClearanceWorkflow。
 * 使用范围：OrderMonitor.cancelOrder、OrderMonitor.cancelDoomsdayOrder 与 OrderOps.cancelOrder。
 */
export type CancelOrderMutationRequest = OrderMutationRequest | DoomsdayCancelOrderRequest;

/**
 * 共享执行器的装配绑定。
 * 数据来源：旧 Trader 已创建的唯一 recorder、tracking、cache、broker 与限流器。
 * 使用范围：app 注入的同步 composition callback；只传现有能力，不在 core 创建 application owner。
 */
export type TraderExecutionBindings = Pick<
  TraderDeps,
  | 'marketDataClient'
  | 'unrealizedLossBuyGate'
  | 'tradingConfig'
  | 'symbolRegistry'
  | 'isExecutionAllowed'
  | 'isContinuousTradingAllowed'
  | 'now'
  | 'readCurrentTradingDayInfo'
> &
  Readonly<{
    readSellPositions: (symbol: string) => Promise<ReadonlyArray<Position>>;
    tradeMutationPort: TradeMutationPort;
    rateLimiter: RateLimiter;
    cacheManager: Pick<OrderCacheManager, 'clearCache'>;
    orderMonitor: Pick<
      OrderMonitor,
      'trackOrder' | 'getPendingSellOrders' | 'cancelOrder' | 'replaceOrderPriceWithPermit'
    >;
    orderRecorder: OrderRecorder;
  }>;

/**
 * 交易器依赖。
 * 类型用途：用于创建顶层 Trader 实例时的依赖注入。
 * 数据来源：如适用。
 * 使用范围：见调用方（启动层等）。
 */
export type TraderDeps = {
  /** app composition 消费唯一 tracking 绑定并创建执行器；必填，不提供 core 默认实现。 */
  readonly createExecution: (bindings: TraderExecutionBindings) => OrderExecutor;

  /** 同步延迟创建唯一 broker 访问能力；错误仍由 createTrader 捕获为 rejected Promise。 */
  readonly brokerAccess: () => BrokerAccess;
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
  readonly postTradeConsistencyRuntime: SettlementRefreshNeedRecorder;

  /** 运行时执行门禁（单一状态源注入，执行层统一判定） */
  readonly isExecutionAllowed: IsExecutionAllowed;

  /** 连续交易授权（仅由 OrderMonitor 派生新订单与自动改单使用） */
  readonly isContinuousTradingAllowed: ContinuousTradingOrderAuthorization;

  /** 最终订单授权、买入节流与订单 route 共用的实时钟。 */
  readonly now: () => Date;

  /** 订单 route 共用的 timer scheduler。 */
  readonly scheduleTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void;

  /** 最终订单授权使用的权威当日交易日事实读取器。 */
  readonly readCurrentTradingDayInfo: CurrentTradingDayInfoReader;

  /** 运行期异步错误的统一 fatal 通道。 */
  readonly termination: Pick<RuntimeTermination, 'isTerminated' | 'reportFatalError'>;
};
