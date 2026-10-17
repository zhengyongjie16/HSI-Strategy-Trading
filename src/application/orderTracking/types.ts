import type { ScheduleBoundedOneShotAt } from '../../types/timer.js';
import type { ExternalApiRequest } from '../../types/apiFailure.js';
import type { Logger } from '../../types/logger.js';
import type { DiagnosticObserver } from '../../types/diagnostics.js';
import type { ProtectiveLiquidationEpisodeTracker } from '../../domain/liquidation/episode/types.js';
import type {
  OrderMutationRequest,
  PendingSellOrderSnapshot,
  ReplaceOrderPriceOutcome,
  TrackOrderParams,
} from '../../domain/order/types.js';
import type { TradingConfig } from '../../types/config.js';
import type { MarketDataClient } from '../../types/marketPorts.js';
import type { OrderDetailReadPort } from '../../types/orderDetailReadPorts.js';
import type { OrderExecutionLedgerPort } from '../../types/orderExecutionLedger.js';
import type { OrderPushPort } from '../../types/orderPushPorts.js';
import type {
  DailyLossTracker,
  ProtectiveLiquidationExecutionProgressInput,
} from '../../types/risk.js';
import type { RuntimeTermination } from '../../types/runtime.js';
import type { SymbolRegistry } from '../../types/seat.js';
import type { OrderHoldSymbolsChangedEvent } from '../../types/orderHold.js';
import type { OrderRecorder } from '../../types/orderRecorder.js';
import type { OrderStateChangedEvent } from '../../types/orderTracking.js';
import type { PendingOrder } from '../../types/orderReadMetadata.js';
import type { RateLimiter, TradeMutationPermit } from '../../types/rateLimit.js';
import type { Unsubscribe } from '../../types/events.js';
import type { SettlementRefreshNeedRecorder } from '../../types/settlement.js';
import type { OrderFact } from '../../types/trade.js';
import type { TradeMutationPort } from '../../types/tradeMutationPorts.js';
import type {
  CancelOrderOutcome,
  DoomsdayCancelOrderOutcome,
  DoomsdayCancelOrderRequest,
} from '../../types/orderCancellation.js';

/**
 * 订单监控运行态。
 * 类型用途：区分停机忽略（STOPPED）、恢复缓存（BOOTSTRAPPING）与实时处理（ACTIVE）的事件策略。
 * 数据来源：OrderMonitor 内部状态机维护。
 * 使用范围：仅 orderTracking/orderMonitor 模块内部使用。
 */
export type OrderMonitorRuntimeState = 'STOPPED' | 'BOOTSTRAPPING' | 'ACTIVE';

/**
 * 订单席位归属解析结果。
 * 类型用途：表示订单归属的监控标的与方向，用于恢复阶段席位匹配校验。
 * 数据来源：根据订单名称映射与监控配置解析得到。
 * 使用范围：仅 orderTracking/orderMonitor 模块内部使用。
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
 * 使用范围：仅 orderTracking/orderMonitor 模块内部使用。
 */
export type RecoverySnapshotReconciliationParams = {
  readonly allOrders: ReadonlyArray<OrderFact>;
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
  recoverOrderTrackingFromSnapshot: (allOrders: ReadonlyArray<OrderFact>) => Promise<void>;

  /** 获取指定标的的未成交卖单快照 */
  getPendingSellOrders: (symbol: string) => ReadonlyArray<PendingSellOrderSnapshot>;

  /** 读仓前捕获原 tracking 事实证明；新增生命周期、挂单变化或超时跟进交接使本次计划失效。 */
  captureSellAvailabilityGuard: (symbol: string) => () => boolean;

  /** 原卖单及其已 accepted 的超时转市价单身份；不按标的合并，不持有成交金额。 */
  readonly getSellOperationOrderIds: (originalOrderId: string) => ReadonlyArray<string>;

  /** 是否存在指定方向的未完成保护性清仓卖单链路 */
  hasPendingProtectiveLiquidationOrders: (direction: 'LONG' | 'SHORT') => boolean;

  /** 生命周期完整清空 tracking、accepted 转单关联与 BOOTSTRAPPING 事件缓存 */
  clearTrackedOrders: () => void;
}

/**
 * 订单缓存管理器依赖。
 * 类型用途：用于创建 OrderCacheManager 时的依赖注入。
 * 数据来源：如适用。
 * 使用范围：仅在 trader 模块内部使用。
 */
export type OrderCacheManagerDeps = {
  readonly requestExternalApi: ExternalApiRequest;
  readonly logger: Logger;
  readonly ctx: TodayOrdersReader;
  readonly rateLimiter: RateLimiter;

  /** 未成交订单缓存 TTL 使用的统一运行时时钟。 */
  readonly now: () => Date;
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
  seedFromOrders: (orders: ReadonlyArray<OrderFact>) => void;

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
  readonly diagnostics: DiagnosticObserver;
  readonly wait: (delayMs: number) => Promise<void>;
  readonly scheduleBoundedOneShotAt: ScheduleBoundedOneShotAt;
  readonly requestExternalApi: ExternalApiRequest;
  readonly logger: Logger;
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
 * 连续交易订单授权。
 * 类型用途：仅允许订单监控在连续交易时段发起新的超时市价单或自动改单；每次 SDK attempt 都必须重新读取。
 * 数据来源：运行态的生命周期交易开关与连续交易门禁。
 * 使用范围：OrderMonitor route 与连续交易授权 mutation 请求。
 */
export type ContinuousTradingOrderAuthorization = () => boolean;

/**
 * 撤单 mutation 请求来源。
 * 类型用途：在常规 mutation 授权外，允许末日保护将其专用 permit 内门禁显式带到撤单边界，禁止该授权用于改单。
 * 数据来源：订单 owner、OrderExecutor、OrderMonitor route 与 DoomsdayClearanceWorkflow。
 * 使用范围：OrderMonitor.cancelOrder、OrderMonitor.cancelDoomsdayOrder 与 OrderOps.cancelOrder。
 */
export type CancelOrderMutationRequest = OrderMutationRequest | DoomsdayCancelOrderRequest;
