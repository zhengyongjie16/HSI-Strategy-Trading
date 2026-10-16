import type { DoomsdayClearanceWorkflow } from '../application/doomsdayClearance/types.js';
import type { OrdinaryBuyWorkflow } from '../application/ordinaryBuy/types.js';
import type { OrdinarySellWorkflow } from '../application/ordinarySell/types.js';
import type { WarrantRiskRefresh } from '../application/riskRefresh/types.js';
import type { SeatActivationWorkflow } from '../application/seatActivation/types.js';
import type {
  ExecuteStartupRebuildParams,
  LoadStartupSnapshotParams,
  LoadTradingDayRuntimeSnapshotParams,
  LoadTradingDayRuntimeSnapshotResult,
  RebuildTradingDayStateDeps,
  RebuildTradingDayStateParams,
  RebuildTradingDayStateResult,
  StartupRebuildResult,
  StartupSnapshotResult,
} from '../application/tradingDayRebuild/types.js';
import type {
  RuntimeSymbolValidationInput,
  RuntimeSymbolValidationResult,
} from '../config/types.js';
import type { LiquidationCooldownTracker } from '../domain/liquidation/cooldown/types.js';
import type { ProtectiveLiquidationEpisodeTracker } from '../domain/liquidation/episode/types.js';
import type {
  MonitorTaskDataMap,
  MonitorTaskProcessor,
} from '../runtime/asyncProgram/monitorTaskProcessor/types.js';
import type { MonitorTaskQueue } from '../runtime/asyncProgram/monitorTaskQueue/types.js';
import type {
  BuyTaskType,
  SellTaskType,
  TaskQueue,
} from '../runtime/asyncProgram/tradeTaskQueue/types.js';
import type { Processor } from '../runtime/asyncProgram/types.js';
import type { AutoSearchWakeupRuntime } from '../runtime/autoSearchWakeupRuntime/types.js';
import type {
  BusinessEventProgram,
  BusinessEventProgramDeps,
} from '../runtime/businessEventProgram/types.js';
import type { MonitorDisplayRuntime } from '../runtime/monitorDisplayRuntime/types.js';
import type {
  MonitorQuoteEventRuntime,
  SwitchWakeupRuntime,
} from '../runtime/monitorQuoteEventRuntime/types.js';
import type { PeriodicSwitchWakeupRuntime } from '../runtime/periodicSwitchWakeupRuntime/types.js';
import type { QuoteSubscriptionRuntime } from '../runtime/quoteSubscriptionRuntime/types.js';
import type { SeatActivationDispatcher } from '../runtime/seatActivationDispatcher/types.js';
import type { SeatRuntimeCleanupDispatcher } from '../runtime/seatRuntimeCleanupDispatcher/types.js';
import type {
  TimeWakeupRuntime,
  TimeWakeupRuntimeDeps,
} from '../runtime/timeWakeupRuntime/types.js';
import type { TradingGateEventRuntime } from '../runtime/tradingGateEventRuntime/types.js';
import type { TradingQuoteDisplayRuntime } from '../runtime/tradingQuoteDisplayRuntime/types.js';
import type { TradingRiskEventRuntime } from '../runtime/tradingRiskEventRuntime/types.js';
import type { AccountPositionSnapshot } from '../types/accountPosition.js';
import type { BrokerClientFactory } from '../types/brokerClientFactory.js';
import type { TradingConfig } from '../types/config.js';
import type { DisplayAccountAndPositionsParams } from '../types/display.js';
import type { Unsubscribe } from '../types/events.js';
import type { LifecycleMutableState } from '../types/lifecycle.js';
import type { Logger } from '../types/logger.js';
import type { MarketDataClient, WarrantListCacheClearer } from '../types/marketPorts.js';
import type { Quote } from '../types/quote.js';
import type { QuoteSubscriptionState } from '../types/quoteSubscription.js';
import type { DailyLossTracker } from '../types/risk.js';
import type { RuntimeClock, RuntimeScheduler, RuntimeTermination } from '../types/runtime.js';
import type { SymbolRegistry } from '../types/seat.js';
import type { TradingSignalStrategy } from '../types/strategy.js';
import type { DayLifecycleManager, TradingTimeState } from '../types/timeControlPlane.js';
import type { CachedTradingDayInfo, TradingCalendarState } from '../types/tradingCalendar.js';
import type { MonitorContextAssembly } from './context/types.js';
import type { LifecycleRuntimeFactories, LifecycleRuntimeFactoryDeps } from './lifecycle/types.js';
import type {
  AsyncRuntime,
  AsyncRuntimeFactoryDeps,
  PostTradeConsistencyRuntime,
  TradeRuntime,
} from './runtime/types.js';
import type { CleanupController } from './shutdown/types.js';
import type {
  PreparedStrategySelection,
  RuntimeValidationCollectionParams,
  RuntimeValidationCollector,
} from './startup/types.js';

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
 * runApp 默认装配协作者。
 * 类型用途：将顶层运行链路的生产装配与测试替身限制在同一私有依赖边界。
 * 数据来源：生产环境由 runAppDeps 组装，测试仅替换该模块。
 * 使用范围：仅 runApp 与其业务测试。
 */
export type RunAppDeps = Readonly<{
  createPreGateRuntime: (params: CreatePreGateRuntimeParams) => Promise<PreGateRuntime | null>;
  createPostGateRuntime: (params: CreatePostGateRuntimeParams) => Promise<PostGateRuntime | null>;
  loadStartupSnapshot: (params: LoadStartupSnapshotParams) => Promise<StartupSnapshotResult>;
  executeStartupRebuild: (params: ExecuteStartupRebuildParams) => Promise<StartupRebuildResult>;
  collectRuntimeValidationSymbols: (
    params: RuntimeValidationCollectionParams,
  ) => RuntimeValidationCollector;
  createRebuildTradingDayState: (
    deps: RebuildTradingDayStateDeps,
  ) => (params: RebuildTradingDayStateParams) => Promise<RebuildTradingDayStateResult>;
  displayAccountAndPositions: (params: DisplayAccountAndPositionsParams) => void;
  createBusinessEventProgram: (deps: BusinessEventProgramDeps) => BusinessEventProgram;
  createAsyncRuntime: (params: AsyncRuntimeFactoryDeps) => AsyncRuntime | null;
  createLifecycleRuntime: (
    params: LifecycleRuntimeFactoryDeps,
    factories?: LifecycleRuntimeFactories,
  ) => DayLifecycleManager;
  createCleanup: () => CleanupController;
  createTimeWakeupRuntime: <TTimerHandle>(
    deps: TimeWakeupRuntimeDeps<TTimerHandle>,
  ) => TimeWakeupRuntime;
  prepareStrategy: (params: AppEnvironmentParams) => Promise<PreparedStrategySelection>;
  subscribeShutdownSignal: (onShutdown: () => void) => Unsubscribe;
  logger: Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>;
  formatError: (error: unknown) => string;
  validateRuntimeSymbolsFromQuotesMap: (
    params: Readonly<{
      inputs: ReadonlyArray<RuntimeSymbolValidationInput>;
      quotesMap: ReadonlyMap<string, Quote | null>;
    }>,
  ) => RuntimeSymbolValidationResult;
  applyStartupSnapshotFailureState: (lifecycleState: LifecycleMutableState) => void;
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
    termination: RuntimeTermination;
  }>;

/**
 * 启动前阶段运行时对象。
 * 类型用途：集中表达 pre-gate 阶段创建并在后续阶段共享的对象所有权。
 * 数据来源：由 createPreGateRuntime 创建。
 * 使用范围：仅 app 顶层装配与后续 runtime 工厂使用。
 */
export type PreGateRuntime = Readonly<{
  brokerClientFactory: Pick<BrokerClientFactory, 'createBrokerAccess'>;
  tradingConfig: TradingConfig;
  symbolRegistry: SymbolRegistry;
  warrantListCache: WarrantListCacheClearer;
  marketDataClient: MarketDataClient;
  startupTradingDayInfo: CachedTradingDayInfo | null;
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
  clock: RuntimeClock;
  scheduler: RuntimeScheduler;
  cleanup: CleanupController;
  termination: RuntimeTermination;
  resources: RuntimeAssemblyResources;
  strategy: TradingSignalStrategy;
  logger: Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>;
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
  monitorContext: MonitorContextAssembly;
  tradingGateEventRuntime: TradingGateEventRuntime;
  quoteSubscriptionRuntime: QuoteSubscriptionRuntime;
  seatActivationDispatcher: SeatActivationDispatcher;
  seatActivation: SeatActivationWorkflow;
  warrantRiskRefresh: WarrantRiskRefresh;
  seatRuntimeCleanupDispatcher: SeatRuntimeCleanupDispatcher;
  autoSearchWakeupRuntime: AutoSearchWakeupRuntime;
  periodicSwitchWakeupRuntime: PeriodicSwitchWakeupRuntime;
  tradingRiskEventRuntime: TradingRiskEventRuntime;
  monitorQuoteEventRuntime: MonitorQuoteEventRuntime;
  monitorDisplayRuntime: MonitorDisplayRuntime;
  tradingQuoteDisplayRuntime: TradingQuoteDisplayRuntime;
  switchWakeupRuntime: SwitchWakeupRuntime;
  postTradeConsistencyRuntime: PostTradeConsistencyRuntime;
  snapshot: AccountPositionSnapshot;
  tradingTimeState: TradingTimeState;
  lifecycleState: LifecycleMutableState;
  tradingCalendarState: TradingCalendarState;
  quoteSubscriptionState: QuoteSubscriptionState;
  tradeRuntime: TradeRuntime;
  loadTradingDayRuntimeSnapshot: (
    params: LoadTradingDayRuntimeSnapshotParams,
  ) => Promise<LoadTradingDayRuntimeSnapshotResult>;
  doomsdayClearanceWorkflow: DoomsdayClearanceWorkflow;
  ordinaryBuy: OrdinaryBuyWorkflow;
  ordinarySell: OrdinarySellWorkflow;
  buyTaskQueue: TaskQueue<BuyTaskType>;
  sellTaskQueue: TaskQueue<SellTaskType>;
  monitorTaskQueue: MonitorTaskQueue<MonitorTaskDataMap>;
}>;

/**
 * 装配期资源槽，仅由取得资源的工厂写入；终止 owner 的固定闭包读取晚到实例。
 * 不注册动态停机回调，资源释放仍由唯一 CleanupController 登记和执行。
 */
export type RuntimeAssemblyResources = {
  snapshot?: AccountPositionSnapshot;
  closeSnapshotAdmission?: () => void;
  lifecycleState?: LifecycleMutableState;
  strategy?: TradingSignalStrategy;
  buyTaskQueue?: TaskQueue<BuyTaskType>;
  sellTaskQueue?: TaskQueue<SellTaskType>;
  monitorTaskQueue?: MonitorTaskQueue<MonitorTaskDataMap>;
  postTradeConsistencyRuntime?: PostTradeConsistencyRuntime;
  seatActivationDispatcher?: SeatActivationDispatcher;
  seatRuntimeCleanupDispatcher?: SeatRuntimeCleanupDispatcher;
  autoSearchWakeupRuntime?: AutoSearchWakeupRuntime;
  periodicSwitchWakeupRuntime?: PeriodicSwitchWakeupRuntime;
  tradingRiskEventRuntime?: TradingRiskEventRuntime;
  monitorQuoteEventRuntime?: MonitorQuoteEventRuntime;
  tradingQuoteDisplayRuntime?: TradingQuoteDisplayRuntime;
  switchWakeupRuntime?: SwitchWakeupRuntime;
  monitorTaskProcessor?: MonitorTaskProcessor;
  buyProcessor?: Processor;
  sellProcessor?: Processor;
  businessEventProgram?: BusinessEventProgram;
  timeWakeupRuntime?: TimeWakeupRuntime;
};
