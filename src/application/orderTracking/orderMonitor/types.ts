import type {
  ScheduleBoundedOneShotAt,
  BoundedOneShotTimerController,
} from '../../../types/timer.js';
import type { ExternalApiRequest } from '../../../types/apiFailure.js';
import type { Logger } from '../../../types/logger.js';
import type { DiagnosticObserver } from '../../../types/diagnostics.js';
import type { ProtectiveLiquidationEpisodeTracker } from '../../../domain/liquidation/episode/types.js';
import type {
  OrderMonitorConfig,
  OrderMonitorTrackedOrder,
  OrderMutationRequest,
  ReplaceOrderPriceOutcome,
  TerminalStateSnapshot,
  TrackOrderParams,
} from '../../../domain/order/types.js';
import type { MonitorConfig, TradingConfig } from '../../../types/config.js';
import type { MarketDataClient } from '../../../types/marketPorts.js';
import type { OrderDetailReadPort } from '../../../types/orderDetailReadPorts.js';
import type { OrderExecutionLedgerPort } from '../../../types/orderExecutionLedger.js';
import type { OrderExecutionTimeEvidence, OrderRecorder } from '../../../types/orderRecorder.js';
import type { Quote } from '../../../types/quote.js';
import type {
  DailyLossCumulativeExecutionResult,
  DailyLossTracker,
  ProtectiveLiquidationExecutionProgressInput,
} from '../../../types/risk.js';
import type { RuntimeTermination } from '../../../types/runtime.js';
import type { SymbolRegistry } from '../../../types/seat.js';

import type { OrderStateChangedEvent } from '../../../types/orderTracking.js';
import type { RateLimiter, TradeMutationPermit } from '../../../types/rateLimit.js';
import type { Unsubscribe } from '../../../types/events.js';
import type { SettlementRefreshNeedRecorder } from '../../../types/settlement.js';
import type { OrderFact } from '../../../types/trade.js';
import type {
  TradeCancelResult,
  TradeMutationPort,
  TradeReplaceResult,
  TradeSubmitResult,
} from '../../../types/tradeMutationPorts.js';
import type {
  CancelOrderNotStartedOutcome,
  CancelOrderOutcome,
} from '../../../types/orderCancellation.js';
import type { OrderClosedReason, OrderStateCheckResult } from '../../../types/orderReadMetadata.js';

import type {
  CancelOrderMutationRequest,
  OrderCacheManager,
  OrderHoldRegistry,
  OrderMonitorRuntimeState,
} from '../types.js';

/**
 * 卖单超时转市价跟进单的 permit 内提交结果。
 * 类型用途：将前置跳过、broker 已确认响应与 broker 请求开始后的未知结果显式传给 route 外层，
 * 使旧 pending-sell 占位只按可确认的提交阶段处理。
 * 数据来源：routeProcessor 的 timeout 市价单提交 callback。
 * 使用范围：仅 orderMonitor/routeProcessor.ts 使用。
 */
export type TimeoutMarketConversionSubmitOutcome =
  | {
      readonly kind: 'PRECHECK_SKIPPED';
    }
  | {
      readonly kind: 'BROKER_RESPONSE';
      readonly brokerResponse: Extract<TradeSubmitResult, { readonly kind: 'ACCEPTED' }>;
    }
  | {
      readonly kind: 'BROKER_REJECTED';
      readonly result: Extract<TradeSubmitResult, { readonly kind: 'REJECTED' }>;
    }
  | {
      readonly kind: 'BROKER_REQUEST_STARTED_UNKNOWN';
      readonly error: unknown;
    };

/**
 * 改单 broker mutation 的 permit 内执行结果。
 * 类型用途：区分 broker 已确认、订单成交事实已变化与授权失效，防止未执行的改动被误写为成功。
 * 数据来源：orderOps.replaceOrderPriceWithRunner 的 permit 内复核。
 * 使用范围：仅 orderMonitor/orderOps.ts 的改单执行链路。
 */
export type MutationPreflightResult =
  | { readonly kind: 'EXECUTION_FACT_CHANGED' }
  | { readonly kind: 'AUTHORIZATION_REVOKED' }
  | { readonly kind: 'CANCEL_NOT_STARTED' };

/** permit 内改单结果，保留单次请求标签与未发出的 preflight 事实。 */
export type ReplaceMutationOutcome = TradeReplaceResult | MutationPreflightResult;

/** tracking owner 的中性改单/撤单单次请求结果，不含 submit 重提许可。 */
export type OrderMutationRequestResult =
  TradeReplaceResult | TradeCancelResult | MutationPreflightResult;

/**
 * 改单 permit 执行器。
 * 类型用途：约束调用方在每个取得的 mutation permit 边界内执行改单复核与 broker mutation。
 * 数据来源：orderOps 的普通改单与外层 signal callback permit 两条执行路径。
 * 使用范围：仅 orderMonitor/orderOps.ts 的 replaceOrderPriceWithRunner。
 */
export interface ReplacePermitRunner {
  // 行为契约按项目规范使用 interface；call signature 是该契约唯一的公开调用面。
  // eslint-disable-next-line @typescript-eslint/prefer-function-type
  (
    mutation: (permit: TradeMutationPermit) => Promise<ReplaceMutationOutcome>,
  ): Promise<ReplaceMutationOutcome>;
}

/**
 * 订单监控唤醒类型。
 * 类型用途：标识 route runtime 本轮执行由哪类事件触发。
 * 数据来源：quote push、order WS、timer、track 与 runtime bootstrap 流程。
 * 使用范围：orderMonitor route runtime 目录内部。
 */
export type OrderMonitorWakeupKind = 'QUOTE' | 'ORDER_EVENT' | 'TIMER' | 'TRACKED' | 'RECOVERED';

/**
 * 订单监控 timer 类型。
 * 类型用途：为 route timer 建立稳定的业务类型边界，供后续按订单状态投影扩展。
 * 数据来源：orderMonitor route runtime 基于 tracked order 当前状态推导。
 * 使用范围：orderMonitor route runtime 目录内部。
 */
export type OrderMonitorTimerKind =
  'BUY_TIMEOUT' | 'SELL_TIMEOUT' | 'CANCEL_RETRY' | 'REPLACE_RETRY' | 'QUOTE_RETRY';

/**
 * 订单监控 timer 键。
 * 类型用途：为 route 内部 timer 建立稳定的结构化唯一键。
 * 数据来源：由 orderId 与 timerKind 组合生成。
 * 使用范围：orderMonitor route runtime 目录内部。
 */
export type OrderMonitorTimerKey = `${string}:${OrderMonitorTimerKind}`;

/**
 * route timer 计划。
 * 类型用途：表达某个订单当前应投影到 route runtime 的 timer key 与触发时间。
 * 数据来源：routeRuntime 按 tracked order 的 timeout、retry 与 quote retry 状态推导。
 * 使用范围：仅 orderMonitor/routeRuntime.ts 使用。
 */
export type RouteTimerSchedule = Readonly<{
  readonly key: OrderMonitorTimerKey;
  readonly atMs: number;
}>;

/**
 * route timer 注册信息。
 * 类型用途：为每个 timerKey 同时记录句柄与本次投影的计划触发时间。
 * 数据来源：routeRuntime.reconcileRouteTimers 在投影 tracked order timer 时写入。
 * 使用范围：orderMonitor route runtime 与 routing index。
 */
type OrderMonitorTimerRegistration = {
  readonly atMs: number;
  readonly handle: BoundedOneShotTimerController;
};

/**
 * 单 symbol route 运行态。
 * 类型用途：维护 route 执行收敛所需的 generation、in-flight、dirty、latestQuote 与 timer 注册信息。
 * 数据来源：route runtime 在 start/trigger/stop 生命周期中维护。
 * 使用范围：orderMonitor route runtime 目录内部。
 */
export type OrderMonitorSymbolRouteState = {
  symbol: string;
  generation: number;
  inFlight: boolean;
  dirty: boolean;
  latestQuote: Quote | null;
  pendingWakeupKind: OrderMonitorWakeupKind | null;
  readonly timerHandles: Map<OrderMonitorTimerKey, OrderMonitorTimerRegistration>;
};

/**
 * route runtime 单次执行入参。
 * 类型用途：向 route 处理器暴露当前 symbol、generation 与最新唤醒来源。
 * 数据来源：route runtime 在触发执行时构造。
 * 使用范围：orderMonitor/routeRuntime.ts 与后续 routeProcessor 共享。
 */
export type RouteRuntimeProcessParams = Readonly<{
  readonly symbol: string;
  readonly generation: number;
  readonly wakeupKind: OrderMonitorWakeupKind;
  readonly latestQuote: Quote | null;
}>;

/**
 * route runtime 依赖。
 * 类型用途：创建 route runtime 所需的 quote 事件源、时间调度与 route 处理依赖。
 * 数据来源：由 createOrderMonitor 或测试代码装配注入。
 * 使用范围：仅 orderMonitor/routeRuntime.ts 使用。
 */
export type RouteRuntimeDeps = Readonly<{
  readonly scheduleBoundedOneShotAt: ScheduleBoundedOneShotAt;
  readonly runtime: OrderMonitorRuntimeStore;
  readonly config: OrderMonitorConfig;
  readonly marketDataClient: Pick<MarketDataClient, 'onQuoteUpdated'>;
  readonly processRoute: (params: RouteRuntimeProcessParams) => Promise<void>;
  readonly now: () => Date;
  readonly scheduleTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void;
  readonly termination: Pick<RuntimeTermination, 'isTerminated' | 'reportFatalError'>;
}>;

/**
 * route runtime 接口。
 * 类型用途：提供启动、停止、显式唤醒与 active route bootstrap 的最小运行时能力。
 * 数据来源：createRouteRuntime 工厂返回。
 * 使用范围：orderMonitor/index.ts 与测试使用。
 */
export interface RouteRuntime {
  start: () => void;
  stopAndDrain: () => Promise<void>;
  triggerRoute: (symbol: string, wakeupKind: OrderMonitorWakeupKind) => void;
  bootstrapActiveRoutes: () => void;
}

/**
 * 订单累计成交观察值。
 * 类型用途：统一承载 WS partial/terminal 与 API/state-check/recovery terminal 的累计成交事实。
 * 数据来源：OrderMonitor 的 tracked order 或权威订单查询。
 * 使用范围：eventFlow 与 settlementFlow。
 */
export type OrderCumulativeExecutionParams = Readonly<{
  factStage: 'OPEN' | 'TERMINAL';
  orderId: string;
  side: 'BUY' | 'SELL';
  monitorSymbol: string | null;
  symbol: string;
  isLongSymbol: boolean;
  isProtectiveLiquidation: boolean;
  executedPrice: string | null;
  executedQuantity: number | null;
  executedAmount: string;
  executedTimeMs: number | null;
  orderUpdatedAtMs: number | null;
}>;

/**
 * 订单监控运行态容器。
 * 类型用途：集中存放 orderMonitor 在运行期维护的可变状态。
 * 数据来源：createOrderMonitor 初始化，后续由事件处理与恢复流程更新。
 * 使用范围：orderMonitor 目录内部各子模块共享。
 */
export type OrderMonitorRuntimeStore = {
  readonly trackedOrders: Map<string, OrderMonitorTrackedOrder>;
  readonly trackedOrderLifecycles: Map<string, TrackedOrderLifecycle>;
  readonly bootstrappingOrderEvents: Map<string, OrderFact>;
  readonly closedOrderIds: Set<string>;
  readonly queriedTerminalStateByOrderId: Map<string, TerminalStateSnapshot>;

  /** 改单失败后确认的终态；必须与 queriedTerminalStateByOrderId 指向同一快照。 */
  readonly latestReplaceTerminalByOrderId: Map<string, TerminalStateSnapshot>;
  readonly orderStateChangedListeners: Set<(event: OrderStateChangedEvent) => void>;
  readonly trackedOrderIdsBySymbol: Map<string, Set<string>>;
  readonly routeStatesBySymbol: Map<string, OrderMonitorSymbolRouteState>;
  readonly latestRouteGenerationBySymbol: Map<string, number>;
  runtimeState: OrderMonitorRuntimeState;
  running: boolean;
  unsubscribeQuoteUpdated: Unsubscribe | null;
};

/**
 * 恢复流程依赖。
 * 类型用途：为 recoveryFlow 提供恢复所需的状态、服务与 ACTIVE 事件回放能力。
 * 数据来源：由 createOrderMonitor 组装注入。
 * 使用范围：仅 orderMonitor/recoveryFlow.ts 使用。
 */
export type RecoveryFlowDeps = {
  readonly logger: Logger;
  readonly diagnostics: DiagnosticObserver;
  readonly now: () => Date;
  readonly termination: Pick<RuntimeTermination, 'isTerminated' | 'reportFatalError'>;
  readonly runtime: OrderMonitorRuntimeStore;
  readonly orderHoldRegistry: OrderHoldRegistry;
  readonly orderRecorder: OrderRecorder;
  readonly tradingConfig: TradingConfig;
  readonly symbolRegistry: SymbolRegistry;
  readonly trackOrder: (params: TrackOrderParams) => void;
  readonly cancelOrder: (orderId: string) => Promise<CancelOrderOutcome>;
  readonly settleOrder: (params: FinalizeOrderSettlementParams) => FinalizeOrderSettlementResult;
  readonly handleOrderChangedWhenActive: (event: OrderFact) => void;
};

/**
 * 恢复流程接口。
 * 类型用途：暴露 BOOTSTRAPPING 事件缓存、重置与快照恢复能力。
 * 数据来源：createRecoveryFlow 工厂返回。
 * 使用范围：orderMonitor/index.ts 调用。
 */
export interface RecoveryFlow {
  cacheBootstrappingEvent: (event: OrderFact) => void;
  clearBootstrappingEventBuffer: () => void;
  resetRecoveryTrackingState: () => void;
  recoverOrderTrackingFromSnapshot: (allOrders: ReadonlyArray<OrderFact>) => Promise<void>;
}

/**
 * 事件流依赖。
 * 类型用途：为 eventFlow 提供推送事件处理所需依赖与缓存回调。
 * 数据来源：由 createOrderMonitor 装配注入。
 * 使用范围：仅 orderMonitor/eventFlow.ts 使用。
 */
export type EventFlowDeps = {
  readonly logger: Logger;
  readonly diagnostics: DiagnosticObserver;
  readonly now: () => Date;
  readonly monitorConfig: MonitorConfig;
  readonly runtime: OrderMonitorRuntimeStore;
  readonly orderRecorder: OrderRecorder;
  readonly recordCumulativeExecution: (params: OrderCumulativeExecutionParams) => void;

  /** timeout 卖单终态在写入运行态快照前提交保护性累计成交事实。 */
  readonly prepareProtectiveTerminalExecution: (
    params: FinalizeOrderSettlementParams,
  ) => DailyLossCumulativeExecutionResult | null;
  readonly settleOrder: (params: FinalizeOrderSettlementParams) => FinalizeOrderSettlementResult;
  readonly cacheBootstrappingEvent: (event: OrderFact) => void;
  readonly triggerRoute: (symbol: string, wakeupKind: OrderMonitorWakeupKind) => void;
};

/**
 * 事件流接口。
 * 类型用途：封装 ACTIVE 事件处理与 BOOTSTRAPPING/ACTIVE 分发入口。
 * 数据来源：createEventFlow 工厂返回。
 * 使用范围：orderMonitor/index.ts 调用。
 */
export interface EventFlow {
  handleOrderChangedWhenActive: (event: OrderFact) => void;
  handleOrderChanged: (event: OrderFact) => void;
}

/**
 * 单订单状态查询依赖。
 * 类型用途：为 orderStatusQuery 提供单订单权威状态查询所需依赖。
 * 数据来源：由 createOrderMonitor 装配注入。
 * 使用范围：仅 orderMonitor/orderStatusQuery.ts 使用。
 */
export type OrderStatusQueryDeps = {
  readonly requestExternalApi: ExternalApiRequest;
  readonly orderDetailReadPort: OrderDetailReadPort;
  readonly executionLedgerPort: OrderExecutionLedgerPort;
  readonly rateLimiter: RateLimiter;
  readonly getExecutionTimeEvidence: (orderId: string) => ReadonlyArray<OrderExecutionTimeEvidence>;
};

/**
 * 单订单状态查询接口。
 * 类型用途：统一封装撤单/改单业务失败后的权威状态确认。
 * 数据来源：createOrderStatusQuery 工厂返回。
 * 使用范围：orderMonitor/orderOps.ts 调用。
 */
export interface OrderStatusQuery {
  checkOrderState: (
    orderId: string,
    isWorkCurrent: () => boolean,
  ) => Promise<OrderStateCheckResult>;
}

/**
 * 订单操作流依赖。
 * 类型用途：为 orderOps 提供 track/cancel/replace 所需依赖。
 * 数据来源：由 createOrderMonitor 装配注入。
 * 使用范围：仅 orderMonitor/orderOps.ts 使用。
 */
export type OrderOpsDeps = {
  readonly wait: (delayMs: number) => Promise<void>;
  readonly logger: Logger;
  readonly diagnostics: DiagnosticObserver;

  /** 每operation捕获原 ingress generation；停止后不能发后继query或发布旧事实。 */
  readonly captureWorkGuard: () => () => boolean;
  readonly tradeMutationPort: TradeMutationPort;
  readonly termination: Pick<RuntimeTermination, 'isTerminated' | 'reportFatalError'>;
  readonly now: () => Date;
  readonly runtime: OrderMonitorRuntimeStore;
  readonly monitorConfig: MonitorConfig;
  readonly rateLimiter: RateLimiter;
  readonly cacheManager: OrderCacheManager;
  readonly orderHoldRegistry: OrderHoldRegistry;
  readonly orderRecorder: OrderRecorder;
  readonly recordCumulativeExecution: (params: OrderCumulativeExecutionParams) => void;
  readonly orderStatusQuery: OrderStatusQuery;
  readonly triggerRoute: (symbol: string, wakeupKind: OrderMonitorWakeupKind) => void;
};

/**
 * 撤单 mutation 前置检查。
 * 类型用途：仅允许 route owner 在已取得 mutation permit 后、实际调用 broker 前同步确认本次撤单仍归当前 route 所有。
 * 数据来源：routeProcessor 的 timeout->MO 处理链路。
 * 使用范围：仅 orderOps.cancelOrder 的内部 route 调用。
 */
export type CancelOrderBeforeBrokerMutation = () => boolean;

/**
 * 带 permit 内前置检查的撤单结果。
 * 类型用途：显式区分 broker 尚未调用的授权失效，与 broker 已确认或常规失败结果，禁止将前者映射为可重试失败。
 * 数据来源：orderOps.cancelOrder 在 permit 内执行 route 或末日保护前置检查后的结果。
 * 使用范围：routeProcessor 与末日保护撤单链路。
 */
export type CancelOrderPreflightOutcome = CancelOrderOutcome | CancelOrderNotStartedOutcome;

/**
 * 订单操作流接口。
 * 类型用途：封装订单追踪、撤单、改单的运行态修改行为。
 * 数据来源：createOrderOps 工厂返回。
 * 使用范围：orderMonitor/index.ts 与 routeProcessor.ts 调用。
 */
export interface OrderOps {
  trackOrder: (params: TrackOrderParams) => void;
  cancelOrder: (
    orderId: string,
    request: CancelOrderMutationRequest,
    beforeBrokerCancel?: CancelOrderBeforeBrokerMutation,
  ) => Promise<CancelOrderPreflightOutcome>;
  replaceOrderPrice: (
    orderId: string,
    newPrice: string,
    request: OrderMutationRequest,
    quantity?: number | null,
  ) => Promise<ReplaceOrderPriceOutcome>;
  replaceOrderPriceWithPermit: (
    orderId: string,
    newPrice: string,
    request: OrderMutationRequest,
    permit: TradeMutationPermit,
    quantity?: number | null,
  ) => Promise<ReplaceOrderPriceOutcome>;
}

/**
 * routeProcessor 依赖。
 * 类型用途：为单 symbol route 的一次业务推进提供最小依赖集合。
 * 数据来源：由 createOrderMonitor 或测试代码装配注入。
 * 使用范围：仅 orderMonitor/routeProcessor.ts 使用。
 */
export type RouteProcessorDeps = {
  readonly logger: Logger;
  readonly diagnostics: DiagnosticObserver;
  readonly tradeMutationPort: TradeMutationPort;
  readonly now: () => Date;
  readonly runtime: OrderMonitorRuntimeStore;
  readonly config: OrderMonitorConfig;
  readonly orderRecorder: OrderRecorder;
  readonly rateLimiter: RateLimiter;
  readonly isContinuousTradingAllowed: () => boolean;

  /** accepted 后先登记真实 S1→MO S2 身份，不受后续 tracking 同步结果撤销。 */
  /** 释放真实 handoff placeholder 并发布操作变化；UNKNOWN 不得调用。 */
  readonly releaseSellHandoff: (orderId: string, symbol: string) => void;
  readonly recordAcceptedSellContinuation: (originalOrderId: string, marketOrderId: string) => void;
  readonly trackOrder: (params: TrackOrderParams) => void;
  readonly cancelOrder: (
    orderId: string,
    beforeBrokerCancel?: CancelOrderBeforeBrokerMutation,
  ) => Promise<CancelOrderPreflightOutcome>;
  readonly settleOrder: (params: FinalizeOrderSettlementParams) => FinalizeOrderSettlementResult;
  readonly replaceOrderPrice: (
    orderId: string,
    newPrice: string,
    quantity?: number | null,
  ) => Promise<void>;
};

/**
 * routeProcessor 接口。
 * 类型用途：封装单 symbol route 的一次动作选择与推进过程。
 * 数据来源：createRouteProcessor 工厂返回。
 * 使用范围：routeRuntime 与测试代码使用。
 */
export interface RouteProcessor {
  processRoute: (params: RouteRuntimeProcessParams) => Promise<void>;
}

/**
 * 卖单终态后的 pending sell 占用处置。
 * 类型用途：声明终态结算后是直接释放占用，还是为后续跟进卖单保留占位。
 * 数据来源：由 routeProcessor 等终态调用方按业务路径传入。
 * 使用范围：orderMonitor/settlementFlow.ts 与相关调用链。
 */
type PendingSellDisposition =
  | {
      readonly kind: 'RELEASE';
    }
  | {
      readonly kind: 'HANDOFF_TO_FOLLOW_UP_SELL';
      readonly followUpQuantity: number;
    };

/**
 * 终态结算入参。
 * 类型用途：统一描述订单终态结算副作用所需上下文。
 * 数据来源：撤单 outcome 归一结果、WebSocket 终态事件、恢复链路终态确认结果。
 * 使用范围：orderMonitor/settlementFlow.ts。
 */
export type FinalizeOrderSettlementParams = {
  readonly orderId: string;
  readonly closedReason: OrderClosedReason;
  readonly source: 'API' | 'WS' | 'STATE_CHECK' | 'RECOVERY';
  readonly executedPrice: string | null;
  readonly executedAmount: string;
  readonly executedQuantity: number | null;
  readonly executedTimeMs: number | null;
  readonly orderUpdatedAtMs: number | null;
  readonly symbol?: string;
  readonly side?: 'BUY' | 'SELL';
  readonly monitorSymbol?: string | null;
  readonly isLongSymbol?: boolean;
  readonly isProtectiveLiquidation?: boolean;

  /** 已在 timeout WS 路径完成 durable progress 的保护性终态结果。 */
  readonly preparedProtectiveTerminalExecution?: DailyLossCumulativeExecutionResult;
  readonly pendingSellDisposition?: PendingSellDisposition;
};

/**
 * 终态结算结果。
 * 类型用途：向调用方返回幂等处理结果与卖单关联买单占用信息。
 * 数据来源：settlementFlow.settleOrder 计算结果。
 * 使用范围：orderMonitor 各流程共享。
 */
export type FinalizeOrderSettlementResult = {
  readonly handled: boolean;
  readonly relatedBuyOrderIds: ReadonlyArray<string> | null;
};

/**
 * 终态结算流程依赖。
 * 类型用途：为 settlementFlow 提供终态结算副作用依赖。
 * 数据来源：createOrderMonitor 组装注入。
 * 使用范围：orderMonitor/settlementFlow.ts。
 */
export type SettlementFlowDeps = {
  readonly runtime: OrderMonitorRuntimeStore;
  readonly diagnostics: DiagnosticObserver;
  readonly now: () => Date;
  readonly orderHoldRegistry: OrderHoldRegistry;
  readonly orderRecorder: OrderRecorder;
  readonly dailyLossTracker: DailyLossTracker;
  readonly protectiveLiquidationEpisodeTracker: ProtectiveLiquidationEpisodeTracker;
  readonly persistProtectiveLiquidationExecutionProgress: (
    input: ProtectiveLiquidationExecutionProgressInput,
  ) => void;
  readonly postTradeConsistencyRuntime: SettlementRefreshNeedRecorder;
  readonly emitOrderStateChanged: (event: OrderStateChangedEvent) => void;
};

/**
 * 终态结算流程接口。
 * 类型用途：统一提供订单终态副作用结算能力。
 * 数据来源：createSettlementFlow 工厂返回。
 * 使用范围：orderMonitor/index.ts 及子流程调用。
 */
export interface SettlementFlow {
  /** timeout WS 写运行态终态快照前，先提交保护性 SELL 的 durable progress。 */
  prepareProtectiveTerminalExecution: (
    params: FinalizeOrderSettlementParams,
  ) => DailyLossCumulativeExecutionResult | null;
  recordCumulativeExecution: (
    params: OrderCumulativeExecutionParams,
  ) => DailyLossCumulativeExecutionResult;
  settleOrder: (params: FinalizeOrderSettlementParams) => FinalizeOrderSettlementResult;
}

/** 首次权威终态确认元数据；在资源结算之前保存，跨重复观察与恢复重试保持幂等。 */
type OrderTerminalConfirmation = {
  readonly source: FinalizeOrderSettlementParams['source'];
  readonly closedReason: OrderClosedReason;
  readonly confirmedAtMs: number | null;
  readonly orderUpdatedAtMs: number | null;
};

/**
 * tracking owner 的生命周期与观测元数据。
 * state 为 null 表示尚未追踪或恢复重置；ACK 与确认元数据仅随全量运行态重置清除。
 * 首个 ACK 的 null 时间表示诊断时钟无效，不得拿后续 ACK 补造 duration。
 */
export type TrackedOrderLifecycle = {
  /** 仅在真实 tracking 证明归属后写入，终态保留，用于标的内读仓计划的 ABA 失效。 */
  readonly symbol?: string;

  /** 真实 tracking 的执行方向，终结后保留以识别异步窗口中新出现的 SELL。 */
  readonly executionSide?: 'BUY' | 'SELL';
  readonly state: 'OPEN' | 'CLOSED' | null;

  /** 本地结算和资源释放确已完成；恢复 tracking 不得抹掉已发生的完成事实。 */
  readonly settlementCompleted?: boolean;

  /** 已结算 SELL 最终未成交完；真实 MO 后继存在时由后继结果覆盖操作结论。 */
  readonly settledWithRemainder?: boolean;
  readonly firstCancelAcknowledgedAtMs?: number | null;
  readonly terminalConfirmation?: OrderTerminalConfirmation;
};

/** 真实订单事实 owner 的被动观测依赖，不持有独立订单表或改变推进结果。 */
export type OrderObservationDeps = {
  readonly runtime: OrderMonitorRuntimeStore;
  readonly diagnostics: DiagnosticObserver;
  readonly now: () => Date;
};

/** 权威 terminal 事实的最小诊断上下文，不包含本地结算成功或资源释放承诺。 */
export type OrderTerminalConfirmationParams = Pick<
  FinalizeOrderSettlementParams,
  'orderId' | 'closedReason' | 'source' | 'orderUpdatedAtMs' | 'symbol' | 'side'
>;
