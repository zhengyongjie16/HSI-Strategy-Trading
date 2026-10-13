import type { RuntimeTermination } from '../../types/runtime.js';
import type { AccountPositionSnapshot, SnapshotToken } from '../../types/accountPosition.js';
import type { Logger } from '../../utils/logger/types.js';
import type { DailyLossTracker } from '../../types/risk.js';
import type { SettlementProtectionRecovery } from '../../types/settlement.js';
import type { TradeLogHydrator } from '../../application/protectiveLiquidation/types.js';
import type { MixedTradeLogRepository } from '../../types/tradeLog.js';
import type { LastState, MonitorContext } from '../../types/state.js';
import type { LifecycleState, SymbolRegistry } from '../../types/seat.js';
import type { TradingConfig } from '../../types/config.js';
import type { Quote } from '../../types/quote.js';
import type { RawOrderFromAPI, Trader } from '../../types/services.js';
import type { MarketDataClient } from '../../types/marketPorts.js';
import type { WarrantRiskRefresh } from '../../application/riskRefresh/types.js';
import type { StartupSeatSearch } from '../../application/autoSearch/types.js';
import type { ProtectiveLiquidationEpisodeTracker } from '../../domain/liquidation/episode/types.js';
import type { SeatActivationDispatcher } from '../../runtime/seatActivationDispatcher/types.js';

import type { LifecycleRuntimeFlags } from '../../types/timeControlPlane.js';

/**
 * 生命周期管理器持有的可变状态。
 * 类型用途：记录当前日期键、生命周期阶段、待开盘重建标志及交易门禁开关，供 tick 与缓存域回调读写。
 * 数据来源：由 createDayLifecycleManager 创建并由管理器内部在 tick 与 openRebuild 时更新。
 * 使用范围：仅 lifecycle 模块内部使用。
 */
export type LifecycleMutableState = {
  currentDayKey: string | null;
  lifecycleState: LifecycleState;
  pendingOpenRebuild: boolean;
  isTradingEnabled: boolean;
};

/**
 * 传递给各 CacheDomain 回调的上下文（midnightClear / openRebuild 的入参）。
 * 类型用途：供各缓存域在午夜清理与开盘重建时使用，包含当前时间与运行时标志。
 * 数据来源：由 DayLifecycleManager 在调用 cacheDomain.midnightClear/openRebuild 时组装传入。
 * 使用范围：仅 lifecycle 与各 cacheDomains 使用，内部使用。
 */
export type LifecycleContext = Readonly<{
  now: Date;
  runtime: LifecycleRuntimeFlags;
  invalidateSeatActivationCarryover?: boolean;
}>;

/**
 * 单次开盘域调用的原 owner 授权。
 * 由 manager 在首个 await 前固定 dayEpoch 与 owner 身份；下游只读取，不重新绑定当前输入。
 */
export type OpenRebuildContext = LifecycleContext & {
  readonly dayEpoch: number;
  readonly snapshotToken: SnapshotToken;
  readonly isCurrent: () => boolean;
};

/**
 * 开盘域回调结果。COMMITTED 仅在域内实际工作完成后返回，ABORTED 阻断后续域与 ACTIVE。
 * 不把旧 void/undefined 回调当成功，内部与外部失败继续抛原异常。
 */
export type CacheDomainOpenRebuildResult =
  | { readonly status: 'COMMITTED'; readonly snapshotToken: SnapshotToken }
  | { readonly status: 'ABORTED' };

/**
 * 缓存域接口，每个域负责自身数据的午夜清理与开盘重建。
 * 类型用途：依赖注入给 DayLifecycleManager，在跨日与开盘时被调用；midnightClear 按注册顺序、openRebuild 按逆序执行。
 * 数据来源：由主程序注册各 CacheDomain 实现（如 globalStateDomain、orderDomain 等）。
 * 使用范围：仅 lifecycle 模块及 cacheDomains 实现使用。
 */
export interface CacheDomain {
  readonly midnightClear: (ctx: LifecycleContext) => Promise<void> | void;
  readonly openRebuild: (
    ctx: OpenRebuildContext,
  ) => Promise<CacheDomainOpenRebuildResult> | CacheDomainOpenRebuildResult;
}

/**
 * 交易日生命周期管理器依赖（创建 DayLifecycleManager 时的参数）。
 * 类型用途：createDayLifecycleManager 的依赖注入，包含可变状态、缓存域列表、日志与重试间隔等。
 * 数据来源：由主程序/启动流程组装并传入工厂。
 * 使用范围：仅 lifecycle 及启动流程使用，内部使用。
 */
export type DayLifecycleManagerDeps = Readonly<{
  termination: Pick<RuntimeTermination, 'isTerminated' | 'reportFatalError'>;
  mutableState: LifecycleMutableState;
  cacheDomains: ReadonlyArray<CacheDomain>;
  snapshot: Pick<
    AccountPositionSnapshot,
    'getStatus' | 'requestClear' | 'beginRebuild' | 'openAdmission' | 'isCurrent'
  >;
  logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  rebuildRetryDelayMs?: number;
}>;

/**
 * rebuildTradingDayState 的外部依赖（开盘重建时刷新交易状态所需的注入）。
 * 类型用途：包含行情客户端、交易、lastState、symbolRegistry、monitorContext、dailyLossTracker、displayAccountAndPositions 等。
 * 数据来源：由 lifecycle 或 cacheDomains 在创建/调用 rebuildTradingDayState 时传入。
 * 使用范围：仅 lifecycle 内部使用。
 */
export type RebuildTradingDayStateDeps = Readonly<{
  termination: Pick<RuntimeTermination, 'isTerminated' | 'reportFatalError'>;
  marketDataClient: MarketDataClient;
  warrantRiskRefresh: WarrantRiskRefresh;
  trader: Trader;
  snapshot: AccountPositionSnapshot;
  lastState: LastState;
  symbolRegistry: SymbolRegistry;
  monitorContext: MonitorContext;
  dailyLossTracker: DailyLossTracker;
  displayAccountAndPositions: (params: {
    readonly snapshot: AccountPositionSnapshot;
    readonly quotesMap: ReadonlyMap<string, Quote | null>;
  }) => void;
}>;

/**
 * rebuildTradingDayState 的调用参数。
 * 类型用途：传入当日订单列表与行情快照，供开盘重建时刷新状态与展示。
 * 数据来源：由调用方在 openRebuild 流程中获取订单与行情后传入。
 * 使用范围：仅 lifecycle 内部使用。
 */
export type RebuildTradingDayStateParams = Readonly<{
  snapshotToken: SnapshotToken;
  allOrders: ReadonlyArray<RawOrderFromAPI>;
  quotesMap: ReadonlyMap<string, Quote | null>;
  now: Date;
}>;

/**
 * 单次生命周期尝试的授权失效结果。
 * 同日原 token 或席位身份过期返回 SUPERSEDED，由原 owner 整轮重新加载；
 * 原 dayEpoch 失效、停止或 H admission 关闭返回 ABORTED，不代表重建成功。
 * 仅真实授权失效使用此结果，财经、归属、配置与外部请求错误仍通过异常通道传播。
 */
export type TradingDayRuntimeInvalidationResult =
  { readonly status: 'SUPERSEDED' } | { readonly status: 'ABORTED' };

/**
 * 重建阶段结果；COMMITTED 仅证明本轮重建完成，不签发 settlement readiness 或交易放行。
 * 成功 token 是调用方原样传入的加载 receipt token，不能以最新 view 洗白旧输入。
 */
export type RebuildTradingDayStateResult =
  | { readonly status: 'COMMITTED'; readonly snapshotToken: SnapshotToken }
  | TradingDayRuntimeInvalidationResult;

/**
 * loadTradingDayRuntimeSnapshot 的调用参数。
 * 类型用途：控制加载行为：是否要求交易日、是否重置订阅、是否从成交记录恢复冷却等。
 * 数据来源：由启动流程或开盘重建逻辑根据场景组装传入。
 * 使用范围：仅 lifecycle 内部使用。
 */
export type LoadTradingDayRuntimeSnapshotParams = Readonly<{
  now: Date;
  requireTradingDay: boolean;
  resetRuntimeSubscriptions: boolean;
  hydrateCooldownFromTradeLog: boolean;
  source: 'STARTUP' | 'OPEN_REBUILD';
}>;

/**
 * loadTradingDayRuntimeSnapshot 的返回结果。
 * 类型用途：COMMITTED 携带真实 captured snapshot token、订单与行情；授权失效不携带空事实。
 * 数据来源：本轮原 dayEpoch/generation 仍有效时收到的真实 H receipt，供原 owner 整轮 load→rebuild。
 * 使用范围：startup/open rebuild 必须显式区分结果；COMMITTED 不代表 settlement ready 或门禁开放。
 */
export type LoadTradingDayRuntimeSnapshotResult =
  | {
      readonly status: 'COMMITTED';
      readonly snapshotToken: SnapshotToken;
      readonly allOrders: ReadonlyArray<RawOrderFromAPI>;
      readonly quotesMap: ReadonlyMap<string, Quote | null>;
    }
  | TradingDayRuntimeInvalidationResult;

/**
 * loadTradingDayRuntimeSnapshot 的外部依赖。
 * 类型用途：封装行情客户端、交易、配置及辅助服务，作为 loadTradingDayRuntimeSnapshot 的入参。
 * 数据来源：由启动流程或开盘重建调用方组装传入；reportFatalError 必须来自真实 termination，禁止默认 no-op。
 * 使用范围：仅 lifecycle 内部使用。
 */
export type LoadTradingDayRuntimeSnapshotDeps = Readonly<{
  snapshot: AccountPositionSnapshot;
  marketDataClient: MarketDataClient;
  trader: Trader;
  lastState: LastState;
  tradingConfig: TradingConfig;
  symbolRegistry: SymbolRegistry;
  dailyLossTracker: DailyLossTracker;
  protectiveLiquidationEpisodeTracker: ProtectiveLiquidationEpisodeTracker;
  tradeLogHydrator: TradeLogHydrator;
  mixedTradeLogRepository: MixedTradeLogRepository;
  protectionRecovery: SettlementProtectionRecovery;
  startupSeatSearch: StartupSeatSearch;
  seatActivationDispatcher: Pick<SeatActivationDispatcher, 'dispatchCurrentActivatingSeats'>;
  reportFatalError: (error: unknown) => void;
}>;

/**
 * 交易日历预热错误码。
 * 类型用途：为预热流程提供稳定、可枚举的错误分类，供上层分支处理和日志聚合。
 * 数据来源：由 tradingCalendarPrewarmer 在校验与分块流程中按错误场景生成。
 * 使用范围：仅 lifecycle 模块内部使用。
 */
type TradingCalendarPrewarmErrorCode =
  'TRADING_CALENDAR_LOOKBACK_EXCEEDED' | 'TRADING_CALENDAR_INVALID_DATE_KEY';

/**
 * 交易日历预热错误上下文（便于日志与告警）。
 * 类型用途：携带错误发生时的关键上下文字段，支持日志排查与告警维度扩展。
 * 数据来源：由 tradingCalendarPrewarmer 在抛错前根据当前计算状态组装。
 * 使用范围：仅 lifecycle 模块内部使用。
 */
type TradingCalendarPrewarmErrorDetails = Readonly<
  Record<string, string | number | boolean | null>
>;

/**
 * 交易日历预热错误构造参数。
 * 类型用途：统一错误工厂的入参结构，确保 code/message/details 三元信息完整。
 * 数据来源：由 tradingCalendarPrewarmer 内部 createTradingCalendarPrewarmError 调用方传入。
 * 使用范围：仅 lifecycle 模块内部使用。
 */
export type TradingCalendarPrewarmErrorParams = Readonly<{
  code: TradingCalendarPrewarmErrorCode;
  message: string;
  details: TradingCalendarPrewarmErrorDetails;
}>;

/**
 * 交易日历预热结构化错误对象。
 * 类型用途：在预热流程中承载稳定错误码与上下文 details，供日志与重试链路识别。
 * 数据来源：由 tradingCalendarPrewarmer 内部错误工厂创建。
 * 使用范围：仅 lifecycle 模块内部使用。
 */
export type TradingCalendarPrewarmError = Error & {
  readonly code: TradingCalendarPrewarmErrorCode;
  readonly details: TradingCalendarPrewarmErrorDetails;
};

/**
 * 按自然月分块时的单块日期区间。
 * 类型用途：表达一次月级分块结果，供交易日历预热按块拉取与缓存写入。
 * 数据来源：由 lifecycle 重建流程中的日期分块逻辑生成。
 * 使用范围：仅 lifecycle 模块内部使用。
 */
export type DateRangeChunk = Readonly<{
  startKey: string;
  endKey: string;
  dateKeys: ReadonlyArray<string>;
}>;

/**
 * 重建阶段预热交易日历快照的入参。
 * 类型用途：约束 prewarmTradingCalendarSnapshot 的依赖与时间上下文，避免调用方内联结构漂移。
 * 数据来源：由 rebuildTradingDayState 在开盘重建链路中组装并传入。
 * 使用范围：仅 lifecycle 模块内部使用。
 */
export type PrewarmTradingCalendarSnapshotParams = Readonly<{
  marketDataClient: MarketDataClient;
  lastState: LastState;
  monitorContext: MonitorContext;
  now: Date;
}>;
