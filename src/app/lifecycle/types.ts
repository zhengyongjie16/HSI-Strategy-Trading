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
import type { Logger } from '../../types/logger.js';
import type { RuntimeTermination } from '../../types/runtime.js';
import type { DayLifecycleManager } from '../../types/timeControlPlane.js';
import type { AsyncRuntime } from '../runtime/types.js';
import type { PostGateRuntime, PreGateRuntime } from '../types.js';

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
