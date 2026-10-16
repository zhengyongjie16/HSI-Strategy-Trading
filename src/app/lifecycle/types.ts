import type {
  RebuildTradingDayStateParams,
  RebuildTradingDayStateResult,
  RunTradingDayOpenRebuildParams,
  TradingDayOpenRebuildResult,
} from '../../application/tradingDayRebuild/types.js';
import type { BusinessEventProgram } from '../../runtime/businessEventProgram/types.js';
import type {
  GlobalStateDomainDeps,
  MarketDataDomainDeps,
  OrderDomainDeps,
  RiskDomainDeps,
  SeatDomainDeps,
  SignalRuntimeDomainDeps,
} from '../../runtime/lifecycle/cacheDomains/types.js';
import type { CacheDomain, DayLifecycleManagerDeps } from '../../runtime/lifecycle/types.js';
import type { CleanupPhase } from '../../types/cleanup.js';
import type { Logger } from '../../types/logger.js';
import type { RuntimeTermination } from '../../types/runtime.js';
import type { DayLifecycleManager } from '../../types/timeControlPlane.js';
import type { AsyncRuntime } from '../runtime/types.js';
import type { PostGateRuntime, PreGateRuntime } from '../types.js';

/** 静态检查的五条具名路径；不代表可执行能力或统一 runtime 接口。 */
export type LifecycleChecklistGroup =
  | 'startAfterRebuild'
  | 'stopAdmissionAndStopNow'
  | 'midnightStopAndDrain'
  | 'openRebuildStart'
  | 'finalDrainAndDispose';

/**
 * 一个真实资源的覆盖声明。操作名来自现有具名接线，缺少的动作直接省略，绝不补空实现。
 * finalDrainAndDispose 中同一资源可拥有多个真实 cleanup phase；空数组表示无独立 disposer。
 * runsWhileTradingClosed 标识日切关门/等待重建期间仍需保留的 owner；false 不要求普通时段关门就停止。
 */
export type LifecycleChecklistResource = {
  readonly resource: string;
  readonly createdBy: string;
  readonly runsWhileTradingClosed: boolean;

  /** 无独立 disposer 时必须说明实际释放/持有策略，不能补造 stop/drain。 */
  readonly retainedBy?: string;
  readonly startAfterRebuild?: ReadonlyArray<string>;
  readonly stopAdmissionAndStopNow?: ReadonlyArray<string>;
  readonly midnightStopAndDrain?: ReadonlyArray<string>;
  readonly openRebuildStart?: ReadonlyArray<string>;
  readonly finalDrainAndDispose: ReadonlyArray<
    readonly [cleanupPhase: CleanupPhase, operation: string]
  >;
};

/** 一条现有路径必须保持的先后依赖；仅用于比较 trace，不产生拓扑或执行计划。 */
export type LifecycleChecklistOrder = {
  readonly group: Exclude<LifecycleChecklistGroup, 'finalDrainAndDispose'>;
  readonly operations: ReadonlyArray<string>;
};

/** app 静态清单：每个资源一个声明点，只维护安全相关的偏序，不复制完整执行源码。 */
export type LifecycleChecklist = {
  readonly resources: ReadonlyArray<LifecycleChecklistResource>;
  readonly order: ReadonlyArray<LifecycleChecklistOrder>;
};

/** 由真实 factory 登记或真实调用 trace 提供的观察值，不接收 handler。 */
export type LifecycleChecklistObservation = {
  readonly traces?: Partial<Readonly<Record<LifecycleChecklistGroup, ReadonlyArray<string>>>>;
  readonly cleanupRegistrations?: ReadonlyArray<{
    readonly createdBy: string;
    readonly cleanupPhase: CleanupPhase;

    /** 实际 handler 的资源名.操作名；不能只记录同名方法而丢失 owner。 */
    readonly operation: string;
  }>;
};

/**
 * 生命周期运行时工厂依赖。
 * 类型用途：封装 lifecycle cache domains 与 dayLifecycleManager 创建所需的共享依赖。
 * 数据来源：由 app 顶层装配在 async runtime 创建后传入。
 * 使用范围：仅 lifecycle 运行时创建链路使用。
 */
export type LifecycleRuntimeFactoryDeps = Readonly<{
  termination: RuntimeTermination;
  logger: Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>;
  preGateRuntime: PreGateRuntime;
  postGateRuntime: PostGateRuntime;
  asyncRuntime: AsyncRuntime;
  businessEventProgram: BusinessEventProgram;
  rebuildTradingDayState: (
    params: RebuildTradingDayStateParams,
  ) => Promise<RebuildTradingDayStateResult>;
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
  executeTradingDayOpenRebuild: (
    params: RunTradingDayOpenRebuildParams,
  ) => Promise<TradingDayOpenRebuildResult>;
  createDayLifecycleManager: (deps: DayLifecycleManagerDeps) => DayLifecycleManager;
}>;
