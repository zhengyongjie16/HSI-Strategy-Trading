import type { Config } from 'longbridge';
import type {
  RuntimeSymbolValidationInput,
  RuntimeSymbolValidationResult,
} from '../config/types.js';
import type { Position } from '../types/account.js';
import type { SymbolRegistry } from '../types/seat.js';
import type { LastState, MonitorContext, MonitorState } from '../types/state.js';
import type { MonitorConfig, TradingConfig } from '../types/config.js';
import type { Quote } from '../types/quote.js';
import type {
  MarketDataClient,
  OrderRecorder,
  PostTradeConsistencyFreshReachedEvent,
  PostTradeConsistencyRefreshNeed,
  RawOrderFromAPI,
  RiskChecker,
  Trader,
  TradingDayInfo,
  Unsubscribe,
} from '../types/services.js';
import type { DailyLossTracker, UnrealizedLossMonitor } from '../types/risk.js';
import type {
  TradingSignalStrategy,
  TradingSignalStrategyFactory,
} from '../core/strategy/types.js';
import type { AutoSymbolManagerPort } from '../types/monitorContextPorts.js';
import type {
  WarrantListCache,
  WarrantListCacheConfig,
} from '../services/autoSymbolFinder/types.js';
import type { LiquidationCooldownTracker } from '../services/liquidationCooldown/types.js';
import type { MixedTradeLogRepository } from '../services/mixedTradeLogRepository/types.js';
import type { ProtectiveLiquidationEpisodeTracker } from '../core/trader/protectiveLiquidationEpisodeTracker/types.js';
import type { DoomsdayProtection } from '../core/doomsdayProtection/types.js';
import type { SignalProcessor } from '../core/signalProcessor/types.js';
import type { IndicatorCache } from '../main/asyncProgram/indicatorCache/types.js';
import type {
  BuyTaskType,
  SellTaskType,
  TaskQueue,
} from '../main/asyncProgram/tradeTaskQueue/types.js';
import type { MonitorTaskQueue } from '../main/asyncProgram/monitorTaskQueue/types.js';
import type {
  MonitorTaskDataMap,
  MonitorTaskProcessor,
} from '../main/asyncProgram/monitorTaskProcessor/types.js';
import type { Processor } from '../main/asyncProgram/types.js';
import type { TradingRiskEventRuntime } from '../main/tradingRiskEventRuntime/types.js';
import type { AutoSearchWakeupRuntime } from '../main/autoSearchWakeupRuntime/types.js';
import type {
  MonitorQuoteEventRuntime,
  SwitchWakeupRuntime,
} from '../main/monitorQuoteEventRuntime/types.js';
import type { MonitorDisplayRuntime } from '../main/monitorDisplayRuntime/types.js';
import type { PeriodicSwitchWakeupRuntime } from '../main/periodicSwitchWakeupRuntime/types.js';
import type { TradingQuoteDisplayRuntime } from '../main/tradingQuoteDisplayRuntime/types.js';
import type {
  BusinessEventProgram,
  BusinessEventProgramDeps,
} from '../main/businessEventProgram/types.js';
import type { QuoteSubscriptionRuntime } from '../main/quoteSubscriptionRuntime/types.js';
import type { SeatActivationDispatcher } from '../main/seatActivationDispatcher/types.js';
import type { SeatRuntimeCleanupDispatcher } from '../main/seatRuntimeCleanupDispatcher/types.js';
import type { TradingGateEventRuntime } from '../main/tradingGateEventRuntime/types.js';
import type {
  LoadTradingDayRuntimeSnapshotParams,
  LoadTradingDayRuntimeSnapshotResult,
  RebuildTradingDayStateDeps,
  RebuildTradingDayStateParams,
  CacheDomain,
  DayLifecycleManager,
  DayLifecycleManagerDeps,
} from '../main/lifecycle/types.js';
import type { Logger } from '../utils/logger/types.js';
import type {
  GlobalStateDomainDeps,
  MarketDataDomainDeps,
  OrderDomainDeps,
  RiskDomainDeps,
  SeatDomainDeps,
  SignalRuntimeDomainDeps,
} from '../main/lifecycle/cacheDomains/types.js';
import type { TimeWakeupRuntime, TimeWakeupRuntimeDeps } from '../main/timeWakeupRuntime/types.js';
import type { DisplayAccountAndPositionsParams } from '../services/accountDisplay/types.js';

/**
 * app 环境参数。
 * 类型用途：统一表达从入口传入 app 组装层的环境变量对象。
 * 数据来源：由 src/index.ts 调用 runApp 时传入 process.env。
 * 使用范围：runApp 与 pre-gate runtime 创建链路使用。
 */
export type AppEnvironmentParams = Readonly<{
  env: NodeJS.ProcessEnv;
}>;

/**
 * pre-gate runtime 创建参数。
 * 类型用途：在首次资源获取前把唯一 cleanup owner 注入 pre-gate 工厂。
 * 数据来源：由 app 顶层入口创建。
 * 使用范围：仅 pre-gate runtime 创建链路使用。
 */
export type CreatePreGateRuntimeParams = AppEnvironmentParams &
  Readonly<{
    cleanup: CleanupController;
  }>;

/**
 * 交易日信息缓存条目。
 * 类型用途：按交易日缓存 `isTradingDay/isHalfDay`，避免重复调用交易日接口。
 * 数据来源：由 createTradingDayInfoResolver 查询并缓存。
 * 使用范围：app 启动状态初始化与运行期交易日状态更新。
 */
export type CachedTradingDayInfo = Readonly<{
  dateStr: string;
  info: TradingDayInfo;
}>;

/**
 * 启动期交易日快照。
 * 类型用途：携带交易日信息及其对应港股日期键，防止跨日装配时缓存错日状态。
 * 数据来源：createPreGateRuntime 在启动阶段解析交易日接口得到。
 * 使用范围：pre-gate 到 post-gate 的启动状态传递。
 */
type StartupTradingDayInfo = Readonly<{
  dateKey: string;
  info: TradingDayInfo;
}>;

/**
 * 交易日信息解析器依赖。
 * 类型用途：创建带缓存的交易日解析函数时注入依赖。
 * 数据来源：由 app 启动组装 marketDataClient、日期键函数和错误回调。
 * 使用范围：仅 app 启动交易日状态初始化使用。
 */
export type TradingDayInfoResolverDeps = Readonly<{
  marketDataClient: Pick<MarketDataClient, 'isTradingDay'>;
  getHKDateKey: (currentTime: Date) => string | null;
  onResolveError: (err: unknown) => void;
}>;

/**
 * 交易日信息解析函数签名。
 * 类型用途：统一交易日信息解析函数类型。
 * 数据来源：由 createTradingDayInfoResolver 创建并返回。
 * 使用范围：app 启动状态初始化与生命周期交易日状态更新。
 */
export type TradingDayInfoResolver = (currentTime: Date) => Promise<TradingDayInfo>;

/**
 * 运行时标的校验收集器。
 * 类型用途：聚合 requiredSymbols 去重集合和 runtimeValidationInputs 校验输入数组。
 * 数据来源：由 app 运行时标的收集阶段初始化并持续写入。
 * 使用范围：仅 app 装配层运行时校验链路使用。
 */
export type MutableRuntimeValidationCollector = {
  requiredSymbols: Set<string>;
  runtimeValidationInputs: RuntimeSymbolValidationInput[];
};

/**
 * 运行时标的校验收集结果。
 * 类型用途：仅向调用方暴露完成去重后的运行时校验输入。
 * 数据来源：由 collectRuntimeValidationSymbols 返回。
 * 使用范围：仅 app 顶层装配与测试替身使用。
 */
export type RuntimeValidationCollector = Readonly<{
  runtimeValidationInputs: ReadonlyArray<RuntimeSymbolValidationInput>;
}>;

/**
 * 运行时标的校验收集参数。
 * 类型用途：封装 collectRuntimeValidationSymbols 所需的配置、席位注册表与持仓列表。
 * 数据来源：由 app 顶层装配在 startup snapshot 后传入。
 * 使用范围：仅 app 运行时标的校验链路使用。
 */
export type RuntimeValidationCollectionParams = Readonly<{
  tradingConfig: TradingConfig;
  symbolRegistry: SymbolRegistry;
  positions: ReadonlyArray<Position>;
}>;

/**
 * 追加运行时标的校验输入的参数。
 * 类型用途：封装单次 pushRuntimeValidationSymbol 所需字段与收集器引用。
 * 数据来源：由 app 运行时校验收集流程组装。
 * 使用范围：仅 app 装配层运行时校验链路使用。
 */
export type PushRuntimeValidationSymbolParams = Readonly<{
  symbol: string | null;
  label: string;
  requireLotSize: boolean;
  required: boolean;
  collector: MutableRuntimeValidationCollector;
}>;

/**
 * 开盘重建执行参数。
 * 类型用途：封装 runTradingDayOpenRebuild 所需的当前时间和重建相关函数依赖。
 * 数据来源：由 app 生命周期装配时组装并传入。
 * 使用范围：仅 app 重建接线 helper 使用。
 */
export type RunTradingDayOpenRebuildParams = Readonly<{
  now: Date;
  loadTradingDayRuntimeSnapshot: (
    params: LoadTradingDayRuntimeSnapshotParams,
  ) => Promise<LoadTradingDayRuntimeSnapshotResult>;
  rebuildTradingDayState: (params: RebuildTradingDayStateParams) => Promise<void>;
}>;

/**
 * 监控上下文工厂依赖注入参数。
 * 类型用途：供 createMonitorContext 工厂函数消费，用于构造 MonitorContext。
 * 数据来源：由 app 顶层装配链路在唯一 monitorContext 创建时传入。
 * 使用范围：仅 app createMonitorContext 使用。
 */
export type MonitorContextFactoryDeps = Readonly<{
  config: MonitorConfig;
  state: MonitorState;
  symbolRegistry: SymbolRegistry;
  quotesMap: ReadonlyMap<string, Quote | null> | null;
  strategy: TradingSignalStrategy;
  orderRecorder: OrderRecorder;
  dailyLossTracker: DailyLossTracker;
  riskChecker: RiskChecker;
  unrealizedLossMonitor: UnrealizedLossMonitor;
  delayedSignalVerifier: MonitorContext['delayedSignalVerifier'];
  autoSymbolManager: AutoSymbolManagerPort;
}>;

/**
 * 退出清理控制器。
 * 类型用途：表达 createCleanup 返回的显式资源清理能力。
 * 数据来源：由 createCleanup 创建。
 * 使用范围：仅 app 顶层装配与测试使用。
 */
export type CleanupController = Readonly<{
  register: (step: CleanupStep) => void;
  execute: () => Promise<void>;
}>;

/**
 * cleanup 阶段。
 * 类型用途：让分散的资源获取点只登记真实 disposer，由统一 owner 保持既有有序 shutdown 语义。
 * 数据来源：由各 runtime 工厂在资源获取后立即登记。
 * 使用范围：仅 app 资源所有权与 cleanup 链路使用。
 */
export type CleanupPhase =
  | 'CLOSE_TRADING_GATE'
  | 'ABORT_FRESHNESS_WAITING'
  | 'STOP_TIME_WAKEUP_RUNTIME'
  | 'STOP_BUSINESS_EVENT_PROGRAM'
  | 'STOP_TRADING_RISK_EVENT_RUNTIME'
  | 'STOP_MONITOR_QUOTE_EVENT_RUNTIME'
  | 'STOP_MONITOR_DISPLAY_RUNTIME'
  | 'STOP_TRADING_QUOTE_DISPLAY_RUNTIME'
  | 'STOP_SWITCH_WAKEUP_RUNTIME'
  | 'STOP_PERIODIC_SWITCH_WAKEUP_RUNTIME'
  | 'STOP_AUTO_SEARCH_WAKEUP_RUNTIME'
  | 'STOP_SEAT_ACTIVATION_DISPATCHER'
  | 'STOP_MONITOR_TASK_PROCESSOR'
  | 'STOP_SEAT_RUNTIME_CLEANUP_DISPATCHER'
  | 'STOP_BUY_PROCESSOR'
  | 'STOP_SELL_PROCESSOR'
  | 'UNSUBSCRIBE_TRADER_LISTENER'
  | 'STOP_ORDER_MONITOR_RUNTIME'
  | 'STOP_QUOTE_SUBSCRIPTION_RUNTIME'
  | 'STOP_POST_TRADE_CONSISTENCY_RUNTIME'
  | 'DESTROY_DELAYED_SIGNAL_VERIFIER'
  | 'CLEAR_INDICATOR_CACHE'
  | 'CLEAR_MONITOR_SNAPSHOT'
  | 'RESET_MARKET_DATA_RUNTIME';

/**
 * 单个 cleanup 步骤。
 * 类型用途：描述资源释放动作、业务顺序阶段与日志名称。
 * 数据来源：由资源 acquisition owner 在取得真实 disposer 后创建。
 * 使用范围：仅 CleanupController.register 使用。
 */
export type CleanupStep = Readonly<{
  phase: CleanupPhase;
  step: string;
  handler: () => Promise<void> | void;
}>;

/**
 * 已登记的 cleanup 步骤。
 * 类型用途：在公开 cleanup 步骤上附加稳定登记顺序，用于同阶段排序。
 * 数据来源：由 createCleanup.register 在资源登记时生成。
 * 使用范围：仅 app/shutdown/createCleanup 内部使用。
 */
export type RegisteredCleanupStep = CleanupStep &
  Readonly<{
    sequence: number;
  }>;

/**
 * 退出清理失败条目。
 * 类型用途：记录单个 cleanup 步骤失败的步骤名与原始错误。
 * 数据来源：由 createCleanup 在执行各清理步骤时收集。
 * 使用范围：仅 app cleanup 装配链路内部使用。
 */
export type CleanupFailure = Readonly<{
  step: string;
  error: unknown;
}>;

/**
 * 启动快照加载结果。
 * 类型用途：表达 startup snapshot load 成功或失败后的统一结果。
 * 数据来源：由 loadStartupSnapshot 返回。
 * 使用范围：仅 app 顶层装配与测试使用。
 */
export type StartupSnapshotResult =
  | Readonly<{
      kind: 'READY';
      allOrders: ReadonlyArray<RawOrderFromAPI>;
      quotesMap: ReadonlyMap<string, Quote | null>;
      now: Date;
    }>
  | Readonly<{
      kind: 'API_RETRY_PENDING';
      now: Date;
    }>;

/**
 * 启动快照加载参数。
 * 类型用途：封装 startup snapshot load 所需依赖与当前时间。
 * 数据来源：由 app 顶层装配阶段组装传入。
 * 使用范围：仅 app loadStartupSnapshot 使用。
 */
export type LoadStartupSnapshotParams = Readonly<{
  now: Date;
  lastState: LastState;
  loadTradingDayRuntimeSnapshot: (
    params: LoadTradingDayRuntimeSnapshotParams,
  ) => Promise<LoadTradingDayRuntimeSnapshotResult>;
  applyStartupSnapshotFailureState: (lastState: LastState, now: Date) => void;
  logger: Pick<Logger, 'error'>;
  formatError: (error: unknown) => string;
}>;

/**
 * 延迟验证通过后的分流注册参数。
 * 类型用途：封装注册 DelayedSignalVerifier 回调所需的共享状态与队列。
 * 数据来源：由 app 顶层装配在唯一 monitorContext 创建完成后传入。
 * 使用范围：仅 app 延迟验证接线使用。
 */
export type RegisterDelayedSignalHandlersParams = Readonly<{
  monitorContext: MonitorContext;
  lastState: LastState;
  buyTaskQueue: TaskQueue<BuyTaskType>;
  sellTaskQueue: TaskQueue<SellTaskType>;
  logger: Pick<Logger, 'debug' | 'warn'>;
  doomsdayProtectionEnabled: boolean;
  now?: () => Date;
}>;

/**
 * 唯一监控上下文装配参数。
 * 类型用途：封装 createMonitorContext 所需的 pre/post gate 运行时对象与启动 quotesMap。
 * 数据来源：由 createPostGateRuntime 在 startup snapshot 前以 quotesMap: null 组装传入；READY 后再同步标的名称。
 * 使用范围：仅唯一 monitorContext 装配链路使用。
 */
export type CreateMonitorContextParams = Readonly<{
  preGateRuntime: PreGateRuntime;
  postGateRuntime: MonitorContextBootstrapRuntime;
  quotesMap: ReadonlyMap<string, Quote | null> | null;
  strategyFactory?: TradingSignalStrategyFactory;
}>;

/**
 * 启动前阶段运行时对象。
 * 类型用途：集中表达 pre-gate 阶段创建并在后续阶段共享的对象所有权。
 * 数据来源：由 createPreGateRuntime 创建。
 * 使用范围：仅 app 顶层装配与后续 runtime 工厂使用。
 */
export type PreGateRuntime = Readonly<{
  config: Config;
  tradingConfig: TradingConfig;
  symbolRegistry: SymbolRegistry;
  warrantListCache: WarrantListCache;
  warrantListCacheConfig: WarrantListCacheConfig;
  marketDataClient: MarketDataClient;
  startupTradingDayInfo: StartupTradingDayInfo | null;
}>;

/**
 * post-gate runtime 创建参数。
 * 类型用途：封装 createPostGateRuntime 所需的环境、pre-gate runtime 与统一时间源。
 * 数据来源：由 app 顶层装配在 pre-gate runtime 创建后组装传入。
 * 使用范围：仅 post-gate runtime 创建链路使用。
 */
export type CreatePostGateRuntimeParams = Readonly<{
  env: NodeJS.ProcessEnv;
  preGateRuntime: PreGateRuntime;
  now: Date;
  cleanup: CleanupController;
}>;

/**
 * 启动后阶段共享运行时对象。
 * 类型用途：集中表达 post-gate 阶段唯一创建并跨模块共享的对象所有权。
 * 数据来源：由 createPostGateRuntime 创建。
 * 使用范围：仅 app 顶层装配与后续 runtime 工厂使用。
 */
export type PostGateRuntime = Readonly<{
  liquidationCooldownTracker: LiquidationCooldownTracker;
  dailyLossTracker: DailyLossTracker;
  protectiveLiquidationEpisodeTracker: ProtectiveLiquidationEpisodeTracker;
  monitorContext: MonitorContext;
  tradingGateEventRuntime: TradingGateEventRuntime;
  quoteSubscriptionRuntime: QuoteSubscriptionRuntime;
  seatActivationDispatcher: SeatActivationDispatcher;
  seatRuntimeCleanupDispatcher: SeatRuntimeCleanupDispatcher;
  autoSearchWakeupRuntime: AutoSearchWakeupRuntime;
  periodicSwitchWakeupRuntime: PeriodicSwitchWakeupRuntime;
  tradingRiskEventRuntime: TradingRiskEventRuntime;
  monitorQuoteEventRuntime: MonitorQuoteEventRuntime;
  monitorDisplayRuntime: MonitorDisplayRuntime;
  tradingQuoteDisplayRuntime: TradingQuoteDisplayRuntime;
  switchWakeupRuntime: SwitchWakeupRuntime;
  postTradeConsistencyRuntime: PostTradeConsistencyRuntime;
  lastState: LastState;
  trader: Trader;
  loadTradingDayRuntimeSnapshot: (
    params: LoadTradingDayRuntimeSnapshotParams,
  ) => Promise<LoadTradingDayRuntimeSnapshotResult>;
  doomsdayProtection: DoomsdayProtection;
  signalProcessor: SignalProcessor;
  indicatorCache: IndicatorCache;
  buyTaskQueue: TaskQueue<BuyTaskType>;
  sellTaskQueue: TaskQueue<SellTaskType>;
  monitorTaskQueue: MonitorTaskQueue<MonitorTaskDataMap>;

  /** 等待 post-gate 层 fatal error；与 createAsyncRuntime.drainFatalError 语义一致 */
  drainFatalError: () => Promise<never>;
}>;

/**
 * monitorContext 启动装配所需的最小 post-gate 运行时切片。
 * 类型用途：允许在完整 runtime 组装完毕前先创建唯一 monitorContext，并通过工厂返回值收敛到单上下文装配链路。
 * 数据来源：由 createPostGateRuntime 在内部装配点按需组装。
 * 使用范围：仅 createMonitorContext 使用。
 */
export type MonitorContextBootstrapRuntime = Readonly<{
  readonly trader: Trader;
  readonly dailyLossTracker: DailyLossTracker;

  /** 与 Trader 共用的唯一风险检查器，统一持有浮亏 R1/N1 与当日亏损偏移缓存。 */
  readonly riskChecker: RiskChecker;
  readonly indicatorCache: IndicatorCache;
  readonly lastState: LastState;

  /** 延迟验证器内部异常进入 post-gate 统一 drain 的 fatal 上报入口。 */
  readonly onFatalError: (error: unknown) => void;
}>;

/**
 * 异步运行时对象。
 * 类型用途：集中表达顶层单次创建的异步处理器所有权。
 * 数据来源：由 createAsyncRuntime 创建。
 * 使用范围：仅 app 顶层装配与 cleanup/lifecycle 使用。
 */
export type AsyncRuntime = Readonly<{
  monitorTaskProcessor: MonitorTaskProcessor;
  buyProcessor: Processor;
  sellProcessor: Processor;
  drainFatalError: () => Promise<never>;
}>;

/**
 * 异步运行时工厂依赖。
 * 类型用途：封装 createAsyncRuntime 所需的 pre/post gate runtime。
 * 数据来源：由 app 顶层装配在 monitor context 完成后传入。
 * 使用范围：仅异步运行时创建链路使用。
 */
export type AsyncRuntimeFactoryDeps = Readonly<{
  preGateRuntime: PreGateRuntime;
  postGateRuntime: PostGateRuntime;
}>;

/**
 * 成交后一致性运行时状态快照。
 * 类型用途：向调用方暴露启动态与 freshness 版本号。
 * 数据来源：由 PostTradeConsistencyRuntime.getStatus 返回。
 * 使用范围：仅 app 装配层与相关测试使用。
 */
export type PostTradeConsistencyRuntimeStatus = Readonly<{
  started: boolean;
  currentVersion: number;
  staleVersion: number;
}>;

/**
 * 成交后一致性运行时依赖。
 * 类型用途：封装创建 PostTradeConsistencyRuntime 所需的最小外部依赖。
 * 数据来源：由 app 顶层装配在创建运行时时注入。
 * 使用范围：仅 createPostTradeConsistencyRuntime 与相关测试使用。
 */
export type PostTradeConsistencyRuntimeDeps = Readonly<{
  getTrader: () => Trader;
  lastState: LastState;
  onPositionsCommitted: () => Promise<void>;
}>;

/**
 * 成交后一致性运行时业务依赖。
 * 类型用途：在唯一 monitorContext 与风控跟踪器完成装配后，为 PostTradeConsistencyRuntime 绑定成交后业务刷新所需协作者。
 * 数据来源：由 createPostGateRuntime 在唯一 monitorContext 装配完成后、任何 start 前内部单次绑定。
 * 使用范围：仅成交后一致性运行时与 app 装配层使用。
 */
export type PostTradeConsistencyRuntimeBusinessDeps = Readonly<{
  monitorContext: MonitorContext;
  dailyLossTracker: DailyLossTracker;
  liquidationCooldownTracker: LiquidationCooldownTracker;
  protectiveLiquidationEpisodeTracker: ProtectiveLiquidationEpisodeTracker;
  mixedTradeLogRepository: Pick<MixedTradeLogRepository, 'appendCompletionIdempotent'>;
}>;

/**
 * 成交后一致性运行时契约。
 * 类型用途：统一拥有成交后 stale/fresh 推进与账户持仓最小补刷能力，供后续主流程与生命周期链路接入。
 * 数据来源：由 createPostTradeConsistencyRuntime 创建。
 * 使用范围：仅 app 装配层与后续接线模块使用。
 */
export interface PostTradeConsistencyRuntime {
  /** 绑定成交后业务依赖；同一运行时只允许绑定一次，重复绑定必须暴露为装配错误。 */
  readonly bindBusinessDeps: (deps: PostTradeConsistencyRuntimeBusinessDeps) => void;
  readonly recordSettlementRefreshNeed: (need: PostTradeConsistencyRefreshNeed) => void;
  readonly getStatus: () => PostTradeConsistencyRuntimeStatus;
  readonly waitForFresh: () => Promise<void>;
  readonly onFreshReached: (
    listener: (event: PostTradeConsistencyFreshReachedEvent) => void,
  ) => Unsubscribe;
  readonly drainFatalError: () => Promise<never>;
  readonly abortWaiting: () => void;
  readonly resetAbort: () => void;
  readonly start: () => void;
  readonly stopAndDrain: () => Promise<void>;
  readonly midnightClear: () => void;
  readonly completeRebuildBaseline: () => void;
}

/**
 * 生命周期运行时工厂依赖。
 * 类型用途：封装 lifecycle cache domains 与 dayLifecycleManager 创建所需的共享依赖。
 * 数据来源：由 app 顶层装配在 async runtime 创建后传入。
 * 使用范围：仅 lifecycle 运行时创建链路使用。
 */
export type LifecycleRuntimeFactoryDeps = Readonly<{
  preGateRuntime: PreGateRuntime;
  postGateRuntime: PostGateRuntime;
  asyncRuntime: AsyncRuntime;
  businessEventProgram: BusinessEventProgram;
  rebuildTradingDayState: (params: RebuildTradingDayStateParams) => Promise<void>;
}>;

/**
 * app 主入口依赖集合。
 * 类型用途：为 app 主入口内部工厂显式描述装配链路依赖。
 * 数据来源：生产环境使用默认依赖对象。
 * 使用范围：仅 app 顶层入口装配使用。
 */
export type RunAppDeps = Readonly<{
  createPreGateRuntime: (params: CreatePreGateRuntimeParams) => Promise<PreGateRuntime>;
  createPostGateRuntime: (params: CreatePostGateRuntimeParams) => Promise<PostGateRuntime>;
  loadStartupSnapshot: (params: LoadStartupSnapshotParams) => Promise<StartupSnapshotResult>;
  collectRuntimeValidationSymbols: (
    params: RuntimeValidationCollectionParams,
  ) => RuntimeValidationCollector;
  createRebuildTradingDayState: (
    deps: RebuildTradingDayStateDeps,
  ) => (params: RebuildTradingDayStateParams) => Promise<void>;
  displayAccountAndPositions: (params: DisplayAccountAndPositionsParams) => void;
  registerDelayedSignalHandlers: (params: RegisterDelayedSignalHandlersParams) => void;
  createBusinessEventProgram: (params: BusinessEventProgramDeps) => BusinessEventProgram;
  createAsyncRuntime: (params: AsyncRuntimeFactoryDeps) => AsyncRuntime;
  createLifecycleRuntime: (
    params: LifecycleRuntimeFactoryDeps,
    factories?: LifecycleRuntimeFactories,
  ) => DayLifecycleManager;
  createCleanup: () => CleanupController;
  createTimeWakeupRuntime: (deps: TimeWakeupRuntimeDeps) => TimeWakeupRuntime;
  waitForShutdownSignal: () => Promise<void>;
  logger: Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>;
  formatError: (error: unknown) => string;
  validateRuntimeSymbolsFromQuotesMap: (
    params: ValidateRuntimeSymbolsParams,
  ) => RuntimeSymbolValidationResult;
  applyStartupSnapshotFailureState: (lastState: LastState, now: Date) => void;
}>;

/**
 * 生命周期运行时工厂集合。
 * 类型用途：显式表达 cache domain 与 dayLifecycleManager 的创建依赖，便于装配测试复核接线路径。
 * 数据来源：生产环境使用默认工厂集合，测试可注入受控工厂。
 * 使用范围：仅 app 生命周期装配与相关测试使用。
 */
export type LifecycleRuntimeFactories = Readonly<{
  createSignalRuntimeDomain: (deps: SignalRuntimeDomainDeps) => CacheDomain;
  createMarketDataDomain: (deps: MarketDataDomainDeps) => CacheDomain;
  createSeatDomain: (deps: SeatDomainDeps) => CacheDomain;
  createOrderDomain: (deps: OrderDomainDeps) => CacheDomain;
  createRiskDomain: (deps: RiskDomainDeps) => CacheDomain;
  createGlobalStateDomain: (deps: GlobalStateDomainDeps) => CacheDomain;
  executeTradingDayOpenRebuild: (params: RunTradingDayOpenRebuildParams) => Promise<void>;
  createDayLifecycleManager: (deps: DayLifecycleManagerDeps) => DayLifecycleManager;
}>;

/**
 * 运行时标的校验器入参。
 * 类型用途：封装 validateRuntimeSymbolsFromQuotesMap 所需的校验输入与 quotes 快照。
 * 数据来源：由 app 顶层装配在 startup snapshot 后组装。
 * 使用范围：仅 app 顶层入口依赖声明与测试替身使用。
 */
type ValidateRuntimeSymbolsParams = Readonly<{
  inputs: ReadonlyArray<RuntimeSymbolValidationInput>;
  quotesMap: ReadonlyMap<string, Quote | null>;
}>;
