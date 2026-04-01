import type {
  Config,
  Decimal,
  OrderSide,
  OrderType,
  OrderStatus,
  TimeInForceType,
  TradeContext,
  PushOrderChanged,
} from 'longbridge';
import type { Signal, SignalType, OrderTypeConfig } from '../../types/signal.js';
import type { AccountSnapshot, Position } from '../../types/account.js';
import type { GlobalConfig, StrategyRuntimeConfig } from '../../types/config.js';
import type { SymbolRegistry } from '../../types/seat.js';
import type {
  PendingOrder,
  TradeCheckResult,
  RateLimiter,
  PendingRefreshSymbol,
  RawOrderFromAPI,
  MarketDataClient,
  RecentFilledOrderSummary,
} from '../../types/services.js';
import type { DailyLossTracker } from '../../types/risk.js';
import type { CancelOrderOutcome, TradeRecord } from '../../types/trader.js';
import type { ProtectiveLiquidationEpisodeTracker } from './protectiveLiquidationEpisodeTracker/types.js';
import type { RefreshGate } from '../../utils/types.js';
import type { Logger, LoggerFileSystem } from '../../utils/logger/types.js';

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
  readonly baseInstrumentSymbol: string | null;
  readonly isProtectiveLiquidation: boolean;
  readonly orderType: OrderType;

  /** 触发买入冷却所需的保护性清仓次数（可选，默认 1） */
  readonly liquidationTriggerLimit?: number;

  /** 保护性清仓冷却配置（用于触发计数分段与冷却激活计算） */
  readonly liquidationCooldownConfig?: StrategyRuntimeConfig['liquidationCooldown'];
};

/**
 * 订单监控运行态。
 * 类型用途：区分恢复期间（BOOTSTRAPPING）与实时处理期间（ACTIVE）的事件处理策略。
 * 数据来源：OrderMonitor 内部状态机维护。
 * 使用范围：仅 trader/orderMonitor 模块内部使用。
 */
export type OrderMonitorRuntimeState = 'BOOTSTRAPPING' | 'ACTIVE';

/**
 * 订单席位归属解析结果。
 * 类型用途：表示订单归属的监控标的与方向，用于恢复阶段席位匹配校验。
 * 数据来源：根据订单名称映射与监控配置解析得到。
 * 使用范围：仅 trader/orderMonitor 模块内部使用。
 */
export type OrderSeatOwnership = {
  readonly baseInstrumentSymbol: string;
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
 * 提交订单入参。
 * 类型用途：传递给内部 submitOrder 函数的参数，封装订单提交所需的完整上下文（交易上下文、信号、标的、方向、数量、价格等）。
 * 数据来源：由 OrderExecutor.executeSignals 等根据信号与配置构造。
 * 使用范围：仅在 trader 模块内部使用。
 */
export type SubmitOrderParams = {
  readonly ctx: TradeContext;
  readonly signal: Signal;
  readonly symbol: string;
  readonly side: OrderSide;
  readonly submittedQtyDecimal: Decimal;
  readonly orderTypeParam: OrderType;
  readonly timeInForce: TimeInForceType;
  readonly remark: string | undefined;
  readonly overridePrice: number | undefined;
  readonly isShortSymbol: boolean;
  readonly monitorConfig?: StrategyRuntimeConfig | null;
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
 * 错误类型标识。
 * 类型用途：识别 API 错误的具体类型，便于针对性处理（如重试、跳过、记录日志）。
 * 数据来源：由 identifyErrorType 等根据 API 抛错或返回结果解析得到。
 * 使用范围：仅在 trader 模块内部使用。
 */
export type ErrorTypeIdentifier = {
  readonly isShortSellingNotSupported: boolean;
  readonly isInsufficientFunds: boolean;
  readonly isOrderNotFound: boolean;
  readonly isNetworkError: boolean;
  readonly isRateLimited: boolean;
};

/**
 * 交易记录文件系统边界。
 * 类型用途：屏蔽 tradeLogger 模块对 node:fs 的直接依赖，只允许通过注入的文件系统接口读写交易日志。
 * 数据来源：由入口组合根组装并传入。
 * 使用范围：仅 tradeLogger 运行时工厂与入口装配层使用。
 */
export interface TradeLoggerFileSystem {
  existsSync: LoggerFileSystem['existsSync'];
  mkdirSync: LoggerFileSystem['mkdirSync'];
  readdirSync: LoggerFileSystem['readdirSync'];
  statSync: LoggerFileSystem['statSync'];
  unlinkSync: LoggerFileSystem['unlinkSync'];
  createWriteStream: LoggerFileSystem['createWriteStream'];
  readFileSync: (path: string, encoding: BufferEncoding) => string;
  writeFileSync: (path: string, data: string, encoding: BufferEncoding) => void;
}

/**
 * 交易记录运行时依赖集合。
 * 类型用途：统一收口 tradeLogger 运行时所需的环境、日志与文件系统边界。
 * 数据来源：由 src/index.ts 组装并注入。
 * 使用范围：仅 tradeLogger 模块与入口装配层使用。
 */
export interface TradeLoggerRuntimeDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly fs: TradeLoggerFileSystem;
  readonly joinPath: (...parts: ReadonlyArray<string>) => string;
  readonly logger: Logger;
  readonly stderr: NodeJS.WriteStream;
}

/**
 * 交易记录运行时工厂参数。
 * 类型用途：显式传递 tradeLogger 创建所需的所有注入边界。
 * 数据来源：由组合根在入口处显式传入。
 * 使用范围：仅 tradeLogger 模块与 app 入口边界使用。
 */
export type TradeLoggerRuntimeFactoryParams = Readonly<{
  readonly deps: TradeLoggerRuntimeDeps;
}>;

/**
 * 交易记录运行时对象。
 * 类型用途：封装 tradeLogger 的可安装记录函数，供入口装配层显式管理生命周期。
 * 数据来源：由 createTradeLoggerRuntime 创建。
 * 使用范围：仅 tradeLogger 模块与入口装配层使用。
 */
export interface TradeLoggerRuntime {
  readonly recordTrade: (tradeRecord: TradeRecord) => void;
}

// ==================== 服务接口定义 ====================

/**
 * 账户服务接口。
 * 类型用途：提供账户快照与持仓查询，供 Trader/OrderExecutor 等获取资金与持仓状态。
 * 数据来源：由 Trader 依赖注入，实现层通过 TradeContext 调用 Longbridge API 获取。
 * 使用范围：仅 trader 模块内部实现与使用。
 */
export interface AccountService {
  getAccountSnapshot: () => Promise<AccountSnapshot | null>;
  getStockPositions: (symbols?: ReadonlyArray<string> | null) => Promise<ReadonlyArray<Position>>;
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
 * 类型用途：订单生命周期监控（追踪、撤单、改价、恢复、待刷新标的等），与 WebSocket 订单推送协同。
 * 数据来源：由 Trader 依赖注入，实现层在 orderMonitor 模块内。
 * 使用范围：trader 模块内部；主循环与恢复流程调用其方法。
 */
export interface OrderMonitor {
  /** 初始化 WebSocket 订阅 */
  initialize: () => Promise<void>;

  /** 开始追踪订单 */
  trackOrder: (params: TrackOrderParams) => void;

  /** 撤销订单；若 tracked order 已被权威确认为终态，会先完成本地结算再返回结果 */
  cancelOrder: (orderId: string) => Promise<CancelOrderOutcome>;

  /** 修改订单价格 */
  replaceOrderPrice: (orderId: string, newPrice: number, quantity?: number | null) => Promise<void>;

  /**
   * 处理一轮订单监控（内部自行读取当前 realtime 行情）
   */
  processWithLatestQuotes: () => Promise<void>;

  /** 基于启动/重建快照恢复订单追踪（仅使用调用方传入的 allOrders） */
  recoverOrderTrackingFromSnapshot: (allOrders: ReadonlyArray<RawOrderFromAPI>) => Promise<void>;

  /** 获取指定标的的未成交卖单快照 */
  getPendingSellOrders: (symbol: string) => ReadonlyArray<PendingSellOrderSnapshot>;

  /** 是否存在指定标的的未完成卖单链路 */
  hasPendingSellOrders: (symbol: string) => boolean;

  /** 获取指定标的的未成交买单快照 */
  getPendingBuyOrders: (symbol: string) => ReadonlyArray<PendingBuyOrderSnapshot>;

  /** 是否存在指定标的的未完成买单链路 */
  hasPendingBuyOrders: (symbol: string) => boolean;

  /** 按订单 ID 读取最近成交摘要 */
  getRecentFilledOrder: (orderId: string) => RecentFilledOrderSummary | null;

  /**
   * 获取并清空待刷新浮亏数据的标的列表
   * 订单成交后会将标的添加到此列表，主循环中应调用此方法获取并刷新
   *
   * @returns 待刷新的标的列表（调用后列表会被清空）
   */
  getAndClearPendingRefreshSymbols: () => PendingRefreshSymbol[];

  /** 是否存在指定监控标的方向的未完成保护性清仓卖单链路 */
  hasPendingProtectiveLiquidationOrders?: (
    baseInstrumentSymbol: string,
    direction: 'LONG' | 'SHORT',
  ) => boolean;

  /** 清空恢复运行态（tracked/pendingSell/refreshQueue）与 BOOTSTRAPPING 事件缓存 */
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
  canTradeNow: (
    signalAction: SignalType,
    monitorConfig?: StrategyRuntimeConfig | null,
  ) => TradeCheckResult;
  executeSignals: (
    signals: Signal[],
  ) => Promise<{ submittedCount: number; submittedOrderIds: ReadonlyArray<string> }>;

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
  readonly ctxPromise: Promise<TradeContext>;
  readonly rateLimiter: RateLimiter;
};

/**
 * 订单缓存管理器依赖。
 * 类型用途：用于创建 OrderCacheManager 时的依赖注入。
 * 数据来源：如适用。
 * 使用范围：仅在 trader 模块内部使用。
 */
export type OrderCacheManagerDeps = {
  readonly ctxPromise: Promise<TradeContext>;
  readonly rateLimiter: RateLimiter;
};

/**
 * 订单快照来源标记。
 * 类型用途：区分历史订单与当日订单来源，用于合并去重时的覆盖优先级判断。
 * 数据来源：orderApiManager 拉取 historyOrders/todayOrders 后在合并流程内赋值。
 * 使用范围：仅 core/trader/orderApiManager 使用。
 */
export type OrderSnapshotSource = 'history' | 'today';

/**
 * 合并订单映射项。
 * 类型用途：封装同一 orderId 的来源与订单实体，支撑按版本与来源替换策略。
 * 数据来源：orderApiManager 合并 history/today 订单时写入 Map。
 * 使用范围：仅 core/trader/orderApiManager 使用。
 */
export type MergedOrderEntry = Readonly<{
  source: OrderSnapshotSource;
  order: RawOrderFromAPI;
}>;

/**
 * 订单 API 管理器依赖。
 * 类型用途：创建 OrderApiManager 时注入交易上下文与限频器。
 * 数据来源：createTrader 组装依赖后传入 createOrderAPIManager。
 * 使用范围：仅 core/trader/orderApiManager 使用。
 */
export type OrderApiManagerDeps = Readonly<{
  ctxPromise: Promise<TradeContext>;
  rateLimiter: RateLimiter;
}>;

/**
 * 订单 API 管理器能力契约。
 * 类型用途：抽象全量订单查询与缓存清理能力，供 trader 组装期依赖。
 * 数据来源：createOrderAPIManager 返回对象。
 * 使用范围：仅 core/trader 内部使用。
 */
export type OrderApiManager = Readonly<{
  fetchAllOrdersFromAPI: (forceRefresh?: boolean) => Promise<ReadonlyArray<RawOrderFromAPI>>;
  clearCache: () => void;
}>;

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
  readonly baseInstrumentSymbol: string | null;

  /** 是否为保护性清仓订单（用于触发买入冷却） */
  readonly isProtectiveLiquidation: boolean;

  /** 触发买入冷却所需的保护性清仓次数 */
  readonly liquidationTriggerLimit: number;

  /** 保护性清仓冷却配置（用于触发计数分段与冷却激活计算） */
  readonly liquidationCooldownConfig: StrategyRuntimeConfig['liquidationCooldown'];

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
 * 未成交买单快照（用于买入占用判断）。
 * 类型用途：提供买入占用判断所需的订单状态信息。
 * 数据来源：OrderMonitor.getPendingBuyOrders 返回。
 * 使用范围：仅在 trader 模块内部使用。
 */
export type PendingBuyOrderSnapshot = {
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
  readonly newOrderPrice: number | null;
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
  readonly price: number | null;
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
  readonly ctxPromise: Promise<TradeContext>;
  readonly rateLimiter: RateLimiter;
  readonly cacheManager: OrderCacheManager;
  readonly marketDataClient: MarketDataClient;
  readonly globalConfig: GlobalConfig;
  readonly monitorConfig: StrategyRuntimeConfig;

  /** 当日亏损跟踪器（成交后增量记录） */
  readonly dailyLossTracker: DailyLossTracker;

  /** 订单订阅保留集 */
  readonly orderHoldRegistry: OrderHoldRegistry;

  /** 保护性清仓事件跟踪器（用于完成边界） */
  readonly protectiveLiquidationEpisodeTracker: ProtectiveLiquidationEpisodeTracker;

  /** 标的注册表（用于解析动态标的归属） */
  readonly symbolRegistry: SymbolRegistry;

  /** 可选测试钩子（仅用于单元测试） */
  readonly testHooks?: {
    readonly setHandleOrderChanged?: (handler: (event: PushOrderChanged) => void) => void;
  };

  /** 刷新门禁（成交后标记 stale） */
  readonly refreshGate?: RefreshGate;

  /** 运行时执行门禁（卖单超时转市价单时校验，禁止门禁关闭时新开单） */
  readonly isExecutionAllowed: IsExecutionAllowed;
};

/**
 * 运行时执行门禁。
 * 类型用途：无参函数，返回当前是否允许下单；门禁关闭时 OrderExecutor 仅记录日志并跳过，不下单。
 * 数据来源：由主程序/启动层注入，单一状态源，执行层统一判定。
 * 使用范围：Trader、OrderMonitor、OrderExecutor 依赖注入使用。
 */
type IsExecutionAllowed = () => boolean;

/**
 * 订单执行器依赖。
 * 类型用途：用于创建 OrderExecutor 时的依赖注入。
 * 数据来源：如适用。
 * 使用范围：仅在 trader 模块内部使用。
 */
export type OrderExecutorDeps = {
  readonly ctxPromise: Promise<TradeContext>;
  readonly rateLimiter: RateLimiter;
  readonly cacheManager: OrderCacheManager;
  readonly orderMonitor: OrderMonitor;
  readonly globalConfig: GlobalConfig;
  readonly monitorConfig: StrategyRuntimeConfig;

  /** 标的注册表（用于解析动态标的归属） */
  readonly symbolRegistry: SymbolRegistry;

  /** 运行时执行门禁（单一状态源注入，执行层统一判定） */
  readonly isExecutionAllowed: IsExecutionAllowed;
};

/**
 * 交易器依赖。
 * 类型用途：用于创建顶层 Trader 实例时的依赖注入。
 * 数据来源：如适用。
 * 使用范围：见调用方（启动层等）。
 */
export type TraderDeps = {
  readonly config: Config;
  readonly globalConfig: GlobalConfig;
  readonly monitorConfig: StrategyRuntimeConfig;
  readonly marketDataClient: MarketDataClient;
  readonly rateLimiterConfig?: RateLimiterConfig;

  /** 标的注册表（用于动态标的映射） */
  readonly symbolRegistry: SymbolRegistry;
  readonly dailyLossTracker: DailyLossTracker;
  readonly protectiveLiquidationEpisodeTracker: ProtectiveLiquidationEpisodeTracker;

  /** 刷新门禁（成交后标记 stale） */
  readonly refreshGate?: RefreshGate;

  /** 运行时执行门禁（单一状态源注入，执行层统一判定） */
  readonly isExecutionAllowed: IsExecutionAllowed;
};
