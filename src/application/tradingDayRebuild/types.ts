import type { OrderTrackingLifecycle, OrderTrackingRecovery } from '../../types/orderTracking.js';
import type { OrderHoldRecovery, OrderHoldReader } from '../../types/orderHold.js';

import type { RiskChecker } from '../../types/riskCheck.js';
import type { OrderRecorder } from '../../types/orderRecorder.js';
import type { MonitorConfig, TradingConfig } from '../../types/config.js';
import type { MonitorSymbolNames } from '../../types/monitor.js';
import type { QuoteSubscriptionState } from '../../types/quoteSubscription.js';
import type { TradingTimeState } from '../../types/timeControlPlane.js';
import type { TradingCalendarState } from '../../types/tradingCalendar.js';
import type { LifecycleMutableState } from '../../types/lifecycle.js';
import type { RuntimeTermination } from '../../types/runtime.js';
import type { AccountPositionSnapshot, SnapshotToken } from '../../types/accountPosition.js';
import type { Logger } from '../../types/logger.js';
import type { DiagnosticObserver } from '../../types/diagnostics.js';
import type { DailyLossTracker } from '../../types/risk.js';
import type { SettlementProtectionRecovery } from '../../types/settlement.js';
import type { TradeLogHydrator } from '../protectiveLiquidation/types.js';
import type { MixedTradeLogRepository } from '../../types/tradeLog.js';
import type { SymbolRegistry } from '../../types/seat.js';

import type { Quote } from '../../types/quote.js';
import type { OrderFact } from '../../types/trade.js';

import type { MarketDataClient } from '../../types/marketPorts.js';
import type { WarrantRiskRefresh } from '../riskRefresh/types.js';
import type { StartupSeatSearch } from '../autoSearch/types.js';
import type { ProtectiveLiquidationEpisodeTracker } from '../../domain/liquidation/episode/types.js';

import type { Position } from '../../types/account.js';
import type { PostTradeSettlementWorkflow } from '../postTradeSettlement/types.js';
import type { KnownExecutionBaseline } from '../../domain/order/types.js';
import type { ExecutionHistorySnapshot } from '../../domain/risk/types.js';

/** 恢复期单订单的完整历史、方向与校验后的 known 累计状态。 */
export type RecoveryExecutionHistory = Readonly<{
  known: KnownExecutionBaseline;
  snapshots: ReadonlyArray<ExecutionHistorySnapshot>;
  direction: 'LONG' | 'SHORT';
}>;

/** 归一后的 API 观察具有完整经济金额；其余字段沿用 broker 观察。 */
export type NormalizedExecutionOrder = Omit<OrderFact, 'executedAmount'> &
  Readonly<{ executedAmount: string }>;

/** stale 观察的消费策略：启动恢复阻断；运行期重建保留当前 owner 的已知事实。 */
export type StaleObservationPolicy = 'THROW' | 'KEEP_KNOWN';

/** loader 使用的席位激活投递能力；由 composition 注入，不依赖具体 runtime。 */
interface RebuildSeatActivationDispatcher {
  readonly dispatchCurrentActivatingSeats: () => void;
}

/** 整轮重建完成前必须等待的订阅真相对账能力；不负责启动订阅 owner。 */
interface RebuildQuoteSubscriptions {
  readonly reconcileFromCurrentTruth: () => Promise<void>;
}

/**
 * rebuildTradingDayState 的外部依赖（开盘重建时刷新交易状态所需的注入）。
 * 类型用途：包含行情客户端、交易、lastState、symbolRegistry、monitorContext、dailyLossTracker、displayAccountAndPositions 等。
 * 数据来源：由 lifecycle 或 cacheDomains 在创建/调用 rebuildTradingDayState 时传入。
 * 使用范围：仅交易日重建用例及其装配方使用。
 */
export interface RebuildTradingDayStateDeps {
  readonly termination: Pick<RuntimeTermination, 'isTerminated' | 'reportFatalError'>;
  readonly marketDataClient: MarketDataClient;
  readonly warrantRiskRefresh: WarrantRiskRefresh;
  readonly orderMonitor: OrderTrackingRecovery;
  readonly snapshot: AccountPositionSnapshot;
  readonly lifecycleState: Readonly<LifecycleMutableState>;
  readonly tradingCalendarState: Readonly<TradingCalendarState>;
  readonly symbolRegistry: SymbolRegistry;
  readonly monitorContext: MonitorSymbolNames & {
    readonly config: MonitorConfig;
    readonly symbolRegistry: Pick<SymbolRegistry, 'getSeatState' | 'getSeatVersion'>;
    readonly orderRecorder: OrderRecorder;
    readonly riskChecker: RiskChecker;
  };
  readonly dailyLossTracker: DailyLossTracker;
  readonly displayAccountAndPositions: (params: {
    readonly snapshot: AccountPositionSnapshot;
    readonly quotesMap: ReadonlyMap<string, Quote | null>;
  }) => void;
}

/**
 * rebuildTradingDayState 的调用参数。
 * 类型用途：传入当日订单列表与行情快照，供开盘重建时刷新状态与展示。
 * 数据来源：由调用方在 openRebuild 流程中获取订单与行情后传入。
 * 使用范围：仅交易日重建用例及其装配方使用。
 */
export type RebuildTradingDayStateParams = Readonly<{
  snapshotToken: SnapshotToken;
  allOrders: ReadonlyArray<OrderFact>;
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
 * 使用范围：仅交易日重建用例及其装配方使用。
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
      readonly allOrders: ReadonlyArray<OrderFact>;
      readonly quotesMap: ReadonlyMap<string, Quote | null>;
    }
  | TradingDayRuntimeInvalidationResult;

/**
 * loadTradingDayRuntimeSnapshot 的外部依赖。
 * 类型用途：封装行情客户端、交易、配置及辅助服务，作为 loadTradingDayRuntimeSnapshot 的入参。
 * 数据来源：由启动流程或开盘重建调用方组装传入。
 * 使用范围：仅交易日重建用例及其装配方使用。
 */
export interface LoadTradingDayRuntimeSnapshotDeps {
  readonly logger: Logger;
  readonly snapshot: AccountPositionSnapshot;
  readonly marketDataClient: MarketDataClient;
  readonly orderRecorder: Pick<OrderRecorder, 'fetchAllOrdersFromAPI'>;
  readonly orderHoldRegistry: OrderHoldReader & OrderHoldRecovery;
  readonly orderMonitor: Pick<OrderTrackingLifecycle, 'initialize'>;
  readonly tradingTimeState: TradingTimeState;
  readonly tradingCalendarState: TradingCalendarState;
  readonly quoteSubscriptionState: QuoteSubscriptionState;
  readonly tradingConfig: TradingConfig;
  readonly symbolRegistry: SymbolRegistry;
  readonly dailyLossTracker: DailyLossTracker;
  readonly protectiveLiquidationEpisodeTracker: ProtectiveLiquidationEpisodeTracker;
  readonly tradeLogHydrator: TradeLogHydrator;
  readonly mixedTradeLogRepository: MixedTradeLogRepository;
  readonly protectionRecovery: SettlementProtectionRecovery;
  readonly startupSeatSearch: StartupSeatSearch;
  readonly seatActivationDispatcher: RebuildSeatActivationDispatcher;
}

/**
 * 交易日历预热错误码。
 * 类型用途：为预热流程提供稳定、可枚举的错误分类，供上层分支处理和日志聚合。
 * 数据来源：由 tradingCalendarPrewarmer 在校验与分块流程中按错误场景生成。
 * 使用范围：仅交易日重建模块内部使用。
 */
type TradingCalendarPrewarmErrorCode =
  'TRADING_CALENDAR_LOOKBACK_EXCEEDED' | 'TRADING_CALENDAR_INVALID_DATE_KEY';

/**
 * 交易日历预热错误上下文（便于日志与告警）。
 * 类型用途：携带错误发生时的关键上下文字段，支持日志排查与告警维度扩展。
 * 数据来源：由 tradingCalendarPrewarmer 在抛错前根据当前计算状态组装。
 * 使用范围：仅交易日重建模块内部使用。
 */
type TradingCalendarPrewarmErrorDetails = Readonly<
  Record<string, string | number | boolean | null>
>;

/**
 * 交易日历预热错误构造参数。
 * 类型用途：统一错误工厂的入参结构，确保 code/message/details 三元信息完整。
 * 数据来源：由 tradingCalendarPrewarmer 内部 createTradingCalendarPrewarmError 调用方传入。
 * 使用范围：仅交易日重建模块内部使用。
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
 * 使用范围：仅交易日重建模块内部使用。
 */
export type TradingCalendarPrewarmError = Error & {
  readonly code: TradingCalendarPrewarmErrorCode;
  readonly details: TradingCalendarPrewarmErrorDetails;
};

/**
 * 按自然月分块时的单块日期区间。
 * 类型用途：表达一次月级分块结果，供交易日历预热按块拉取与缓存写入。
 * 数据来源：由交易日重建流程中的日期分块逻辑生成。
 * 使用范围：仅交易日重建模块内部使用。
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
 * 使用范围：仅交易日重建模块内部使用。
 */
export type PrewarmTradingCalendarSnapshotParams = Readonly<{
  marketDataClient: MarketDataClient;
  readonly tradingCalendarState: TradingCalendarState;
  monitorContext: {
    readonly symbolRegistry: Pick<SymbolRegistry, 'getSeatState' | 'getSeatVersion'>;
    readonly orderRecorder: OrderRecorder;
  };
  now: Date;
}>;

/**
 * prepareSeatsForRuntime() 的依赖注入对象。
 * 类型用途：统一表达恢复候选、批量交易状态准入、拒绝日志、启动寻标及原快照授权。
 * 数据来源：由运行时快照加载链路组装传入。
 * 使用范围：仅席位恢复流程使用。
 */
export interface PrepareSeatsForRuntimeDeps {
  readonly tradingConfig: TradingConfig;
  readonly symbolRegistry: SymbolRegistry;
  readonly positions: ReadonlyArray<Position>;
  readonly orders: ReadonlyArray<OrderFact>;
  readonly marketDataClient: Pick<MarketDataClient, 'getSecurityTradingStatuses'>;
  readonly logger: Pick<Logger, 'warn'>;
  readonly startupSeatSearch: StartupSeatSearch;
  readonly canContinue: () => boolean;
  readonly now: () => Date;
  readonly resolveCanAutoSearchNow: (params: {
    readonly currentTime: Date;
    readonly openDelayMinutes: number;
  }) => boolean;
}

/**
 * 开盘重建执行参数。
 * 类型用途：封装 runTradingDayOpenRebuild 所需的当前时间和重建相关函数依赖。
 * 数据来源：由 app 生命周期装配时组装并传入。
 * 使用范围：仅交易日重建用例及其装配方使用。
 */
export interface RunTradingDayOpenRebuildParams {
  readonly now: Date;
  readonly termination: Pick<RuntimeTermination, 'isTerminated'>;
  readonly snapshot: Pick<AccountPositionSnapshot, 'getStatus' | 'isCurrent'>;
  readonly loadTradingDayRuntimeSnapshot: (
    params: LoadTradingDayRuntimeSnapshotParams,
  ) => Promise<LoadTradingDayRuntimeSnapshotResult>;
  readonly rebuildTradingDayState: (
    params: RebuildTradingDayStateParams,
  ) => Promise<RebuildTradingDayStateResult>;
  readonly postTradeConsistencyRuntime: Pick<
    PostTradeSettlementWorkflow,
    | 'resetAbort'
    | 'start'
    | 'stopScheduling'
    | 'completeRebuildBaseline'
    | 'waitForFresh'
    | 'isCurrent'
  >;
  readonly quoteSubscriptionRuntime: RebuildQuoteSubscriptions;
}

/**
 * 开盘整轮 owner 结果；同日 SUPERSEDED 已在 owner 本地重新 load→prepare/rebuild。
 * COMMITTED 同时证明原 captured 输入仍有效、S fresh 与订阅对账完成；不自行开放预算。
 * ABORTED 不携带事实或成功 token，必须由 lifecycle consumer 保持门禁关闭。
 */
export type TradingDayOpenRebuildResult =
  Readonly<{ status: 'COMMITTED'; snapshotToken: SnapshotToken }> | Readonly<{ status: 'ABORTED' }>;

/**
 * 启动快照加载结果。
 * 类型用途：仅真实 captured COMMITTED 可 READY；原 owner 失效返回 ABORTED，不洗成成功或外部重试。
 * 数据来源：由 loadStartupSnapshot 返回。
 * 使用范围：仅交易日重建用例、app 装配与测试使用。
 */
export type StartupSnapshotResult =
  | Readonly<{
      kind: 'READY';
      snapshotToken: SnapshotToken;
      allOrders: ReadonlyArray<OrderFact>;
      quotesMap: ReadonlyMap<string, Quote | null>;
      now: Date;
    }>
  | Readonly<{ kind: 'API_RETRY_PENDING' }>
  | Readonly<{ kind: 'ABORTED' }>;

/**
 * 启动快照加载参数。
 * 类型用途：封装 startup snapshot load 所需依赖与当前时间。
 * 数据来源：由 app 顶层装配阶段组装传入。
 * 使用范围：仅启动快照加载与其装配方使用。
 */
export interface LoadStartupSnapshotParams {
  readonly now: Date;
  readonly lifecycleState: LifecycleMutableState;
  readonly termination: Pick<RuntimeTermination, 'isTerminated'>;
  readonly snapshot: Pick<AccountPositionSnapshot, 'getStatus' | 'isCurrent'>;
  readonly loadTradingDayRuntimeSnapshot: (
    params: LoadTradingDayRuntimeSnapshotParams,
  ) => Promise<LoadTradingDayRuntimeSnapshotResult>;
  readonly applyStartupSnapshotFailureState: (lifecycleState: LifecycleMutableState) => void;
  readonly logger: Pick<Logger, 'error'>;
  readonly formatError: (error: unknown) => string;
}

/** 启动初次重建的完整依赖；复用原 loader 与验证调用，不接管 runtime 启停。 */
export interface ExecuteStartupRebuildParams extends LoadStartupSnapshotParams {
  readonly diagnostics: DiagnosticObserver;
  readonly startupSnapshot: StartupSnapshotResult;
  readonly snapshot: Pick<AccountPositionSnapshot, 'getStatus' | 'getView' | 'isCurrent'>;
  readonly loadStartupSnapshot: (
    params: LoadStartupSnapshotParams,
  ) => Promise<StartupSnapshotResult>;
  readonly rebuildTradingDayState: (
    params: RebuildTradingDayStateParams,
  ) => Promise<RebuildTradingDayStateResult>;
  readonly postTradeConsistencyRuntime: RunTradingDayOpenRebuildParams['postTradeConsistencyRuntime'];
  readonly quoteSubscriptionRuntime: RebuildQuoteSubscriptions;
  readonly validateRuntimeSymbols: (params: {
    readonly positions: ReadonlyArray<Position>;
    readonly quotesMap: ReadonlyMap<string, Quote | null>;
  }) => { readonly valid: boolean };
  readonly syncMonitorContextSymbolNames: (params: {
    readonly quotesMap: ReadonlyMap<string, Quote | null>;
  }) => void;
  readonly logger: Pick<Logger, 'error' | 'warn'>;
}

/** 初次重建完成条件；pending/aborted 都不携带成功事实，app 只能在 COMMITTED 后开门。 */
export type StartupRebuildResult =
  | { readonly status: 'COMMITTED'; readonly snapshotToken: SnapshotToken }
  | { readonly status: 'API_RETRY_PENDING' }
  | { readonly status: 'ABORTED' };
