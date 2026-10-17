import type { ScheduleBoundedOneShotAt } from '../../types/timer.js';
import type { ExternalApiRequest } from '../../types/apiFailure.js';
import type { RateLimiterConfig } from '../../application/orderExecution/types.js';
import type {
  ContinuousTradingOrderAuthorization,
  OrderCacheManager,
  OrderHoldRegistry,
  OrderMonitor,
} from '../../application/orderTracking/types.js';
import type { LiquidationCooldownTracker } from '../../domain/liquidation/cooldown/types.js';
import type { ProtectiveLiquidationEpisodeTracker } from '../../domain/liquidation/episode/types.js';
import type { MonitorTaskProcessor } from '../../runtime/asyncProgram/monitorTaskProcessor/types.js';
import type { Processor } from '../../runtime/asyncProgram/types.js';
import type { AccountPositionSnapshot, SnapshotToken } from '../../types/accountPosition.js';
import type { AccountService } from '../../types/accountReadPorts.js';
import type { BrokerAccess } from '../../types/brokerAccessPorts.js';
import type { MonitorConfig, TradingConfig } from '../../types/config.js';
import type { DiagnosticObserver } from '../../types/diagnostics.js';
import type { Logger } from '../../types/logger.js';
import type { MarketDataClient } from '../../types/marketPorts.js';
import type { OrderExecutor } from '../../types/orderExecutionPorts.js';
import type { OrderRecorder } from '../../types/orderRecorder.js';
import type { ProtectiveOrderReader } from '../../types/orderTracking.js';
import type {
  DailyLossTracker,
  ProtectiveLiquidationExecutionProgressInput,
} from '../../types/risk.js';
import type { RiskChecker } from '../../types/riskCheck.js';
import type { RuntimeClock, RuntimeScheduler, RuntimeTermination } from '../../types/runtime.js';
import type { SymbolRegistry } from '../../types/seat.js';
import type {
  PostTradeSettlementStatus,
  SettlementFreshnessReader,
  SettlementProtectionRecovery,
  SettlementRefreshNeedRecorder,
} from '../../types/settlement.js';
import type { MixedTradeLogRepository } from '../../types/tradeLog.js';
import type { CachedTradingDayInfo } from '../../types/tradingCalendar.js';
import type { CleanupController } from '../shutdown/types.js';
import type { PostGateRuntime, PreGateRuntime, RuntimeAssemblyResources } from '../types.js';

/**
 * app 内部装配的六个真实实例引用；不向业务注入此聚合，不建立转发门面、registry 或第二 owner。
 * 每个字段直接返回原工厂产物，生命周期在既有固定位置逐一调用真实方法。
 */
export type TradeRuntime = Readonly<{
  accountService: AccountService;
  cacheManager: OrderCacheManager;
  orderRecorder: OrderRecorder;
  orderHoldRegistry: OrderHoldRegistry;
  orderMonitor: OrderMonitor;
  orderExecutor: OrderExecutor;
}>;

/**
 * app 交易子实例装配依赖。
 * 数据来源：启动层注入同一 broker、执行门禁、同步风险缓存和 runtime 协作者。
 * 使用范围：仅真实交易子实例的 composition 工厂，不向业务暴露聚合。
 */
export type CreateTradeRuntimeDeps = {
  readonly wait: (delayMs: number) => Promise<void>;
  readonly nowMonotonicMs: () => number;
  readonly scheduleBoundedOneShotAt: ScheduleBoundedOneShotAt;
  readonly requestExternalApi: ExternalApiRequest;
  readonly logger: Logger;
  readonly diagnostics: DiagnosticObserver;

  /** 同步延迟创建唯一 broker 访问能力；装配错误仍转换为 rejected Promise。 */
  readonly brokerAccess: () => BrokerAccess;
  readonly tradingConfig: TradingConfig;
  readonly marketDataClient: MarketDataClient;

  /** 与 app 监控装配共用的浮亏买入门禁，保证读取同一 R1/N1 与当日亏损偏移缓存。 */
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
  readonly isExecutionAllowed: () => boolean;

  /** 连续交易授权（仅由 OrderMonitor 派生新订单与自动改单使用） */
  readonly isContinuousTradingAllowed: ContinuousTradingOrderAuthorization;

  /** 最终订单授权、买入节流与订单 route 共用的实时钟。 */
  readonly now: () => Date;

  /** 订单 route 共用的 timer scheduler。 */
  readonly scheduleTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void;

  /** 最终订单授权使用的权威当日交易日事实读取器。 */
  readonly readCurrentTradingDayInfo: () => CachedTradingDayInfo | null;

  /** 运行期异步错误的统一 fatal 通道。 */
  readonly termination: Pick<RuntimeTermination, 'isTerminated' | 'reportFatalError'>;
};

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
}>;

/**
 * 异步运行时工厂依赖。
 * 类型用途：封装 createAsyncRuntime 所需的 pre/post gate runtime。
 * 数据来源：由 app 顶层装配在 monitor context 完成后传入。
 * 使用范围：仅异步运行时创建链路使用。
 */
export type AsyncRuntimeFactoryDeps = Readonly<{
  logger: Logger;
  termination: RuntimeTermination;
  resources: RuntimeAssemblyResources;
  cleanup: CleanupController;
  preGateRuntime: PreGateRuntime;
  postGateRuntime: PostGateRuntime;
  clock: RuntimeClock;
  scheduler: RuntimeScheduler;
}>;

/**
 * 成交后一致性运行时依赖。
 * 类型用途：封装创建 PostTradeConsistencyRuntime 所需的最小外部依赖。
 * 数据来源：由 app 顶层装配在创建运行时时注入。
 * 使用范围：仅 createPostTradeConsistencyRuntime 与相关测试使用。
 */
export type PostTradeConsistencyRuntimeDeps = Readonly<{
  logger: Logger;
  diagnostics: DiagnosticObserver;
  clock: Pick<RuntimeClock, 'now'>;
  termination: Pick<RuntimeTermination, 'isTerminated' | 'reportFatalError'>;
  getProtectiveOrderReader: () => ProtectiveOrderReader;
  snapshot: Pick<
    AccountPositionSnapshot,
    'getView' | 'isCurrent' | 'getStatus' | 'requestRefresh' | 'invalidate' | 'waitForIssuedDrain'
  >;
  onPositionsCommitted: (token: SnapshotToken) => Promise<void>;
  scheduler: RuntimeScheduler;
}>;

/**
 * 成交后一致性运行时业务依赖。
 * 类型用途：在唯一 monitorContext 与风控跟踪器完成装配后，为 PostTradeConsistencyRuntime 绑定成交后业务刷新所需协作者。
 * 数据来源：由 createPostGateRuntime 在唯一 monitorContext 装配完成后、任何 start 前内部单次绑定。
 * 使用范围：仅成交后一致性运行时与 app 装配层使用。
 */
export type PostTradeConsistencyRuntimeBusinessDeps = Readonly<{
  monitorContext: {
    readonly config: Pick<
      MonitorConfig,
      'monitorSymbol' | 'liquidationTriggerLimit' | 'liquidationCooldown'
    >;
    readonly symbolRegistry: Pick<SymbolRegistry, 'getSeatState' | 'getSeatVersion'>;
    readonly orderRecorder: Pick<OrderRecorder, 'getCostBasis'>;
    readonly riskChecker: Pick<
      RiskChecker,
      'prepareUnrealizedLossData' | 'publishUnrealizedLossData'
    >;
    readonly dailyLossTracker: Pick<DailyLossTracker, 'getLossOffset'>;
  };
  dailyLossTracker: Pick<
    DailyLossTracker,
    'prepareProtectionBoundary' | 'commitProtectionBoundary'
  >;
  liquidationCooldownTracker: Pick<LiquidationCooldownTracker, 'recordLiquidationTrigger'>;
  protectiveLiquidationEpisodeTracker: Pick<
    ProtectiveLiquidationEpisodeTracker,
    'getInProgressEpisodes' | 'prepareCompletion' | 'commitCompletion'
  >;
  mixedTradeLogRepository: Pick<MixedTradeLogRepository, 'appendCompletionIdempotent'>;
}>;

/**
 * 成交后一致性运行时契约。
 * 类型用途：把 app 的构造环绑定入口与唯一 application settlement owner 的能力装配到一起。
 * 数据来源：由 createPostTradeConsistencyRuntime 映射窄能力后返回真实 workflow。
 * 使用范围：仅 app 装配与生命周期接线使用，不承载业务实现。
 */
export interface PostTradeConsistencyRuntime
  extends SettlementFreshnessReader, SettlementRefreshNeedRecorder, SettlementProtectionRecovery {
  /** 绑定成交后业务依赖；同一运行时只允许绑定一次，重复绑定必须暴露为装配错误。 */
  readonly bindBusinessDeps: (deps: PostTradeConsistencyRuntimeBusinessDeps) => void;
  readonly getStatus: () => PostTradeSettlementStatus;
  readonly abortWaiting: () => void;
  readonly resetAbort: () => void;
  readonly start: () => void;
  readonly stopScheduling: () => void;
  readonly stopAndDrain: () => Promise<void>;
  readonly midnightClear: () => void;
  readonly completeRebuildBaseline: () => Promise<boolean>;
}
