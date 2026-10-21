import type {
  OrderReadStatus,
  OrderReadType,
  OrderClosedReason,
  OrderStateCheckResult,
} from '../../types/orderReadMetadata.js';
import type { Quote } from '../../types/quote.js';
import type {
  BrokerOrderExecutionFact,
  OrderExecutionRecordObservation,
  OrderFilteringEngine,
  OrderOwnership,
  OrderRecord,
} from '../../types/orderRecorder.js';
import type {
  DailyLossCumulativeExecutionResult,
  DailyLossMonitorScope,
  DailyLossOrderSnapshot,
} from '../../types/risk.js';

import type { OrderTypeConfig } from '../../types/signal.js';
import type { OrderFact } from '../../types/trade.js';

/** 订单动作所需的行情字段；由执行或换标用例显式选择，不构成查询/交易授权。 */
type QuoteReadinessRequirement = 'PRICE' | 'PRICE_AND_LOT_SIZE';

/** 订单动作的行情分类事实，供卖出、清仓、换标及盯单用例区分缺失和无效字段。 */
export type QuoteReadinessStatus =
  'READY' | 'MISSING' | 'INVALID_PRICE' | 'MISSING_LOT_SIZE' | 'INVALID_LOT_SIZE';

/** 行情分类规则的只读输入，来自当前用例读取的 quote，不要求或改变 snapshot readiness。 */
export type IsQuoteReadyForRequirementParams = {
  readonly quote: Quote | null | undefined;
  readonly requirement: QuoteReadinessRequirement;
};

/**
 * 订单过滤算法的中间状态类型。
 * 类型用途：OrderFilteringEngine 过滤算法中的中间结构（m0Orders 保留，candidateOrders 待过滤）。
 * 数据来源：模块内部在 applyFilteringAlgorithm 中构造。
 * 使用范围：仅 domain/order 过滤算法内部使用。
 */
export type FilteringState = {
  readonly m0Orders: ReadonlyArray<OrderRecord>;
  readonly candidateOrders: ReadonlyArray<OrderRecord>;
};

/** tracked 旧卖单的中性事实；旧 protective 身份为必填，不由新请求推断或覆盖。 */
export type PendingSellOrderSnapshot = {
  readonly orderId: string;
  readonly isProtectiveLiquidation: boolean;
  readonly status: OrderReadStatus;
  readonly orderType: OrderReadType;
  readonly submittedQuantity: number;
  readonly executedQuantity: number;
  readonly submittedAt: number;
};

/** 新卖出需求与旧挂单事实，供共享执行器初次规划及最终 permit 复核。 */
export type SellMergeDecisionInput = {
  readonly pendingOrders: ReadonlyArray<PendingSellOrderSnapshot>;
  readonly newOrderQuantity: number;
  readonly newOrderType: OrderReadType;
  readonly isProtectiveLiquidation: boolean;
};

/** 纯卖单合并结果；撤旧重提仍须由执行 owner 确认可信终态及新鲜可卖量。 */
export type SellMergeDecision = {
  readonly action: 'SUBMIT' | 'REPLACE' | 'CANCEL_AND_SUBMIT' | 'SKIP';
  readonly mergedQuantity: number;
  readonly targetOrderId: string | null;
  readonly pendingOrderIds: ReadonlyArray<string>;
  readonly pendingRemainingQuantity: number;
  readonly reason:
    'no-additional-quantity' | 'no-pending-sell' | 'cancel-and-merge' | 'replace-and-merge';
};

/** 信号覆盖、保护性及常规订单类型的配置输入，保持原优先级。 */
export type OrderTypeResolutionConfig = {
  readonly tradingOrderType: OrderTypeConfig;
  readonly liquidationOrderType: OrderTypeConfig;
};

/** broker 接受后或恢复快照生成的追踪事实；只传入中性金融文本和安全整数数量。 */
export type TrackOrderParams = {
  readonly orderId: string;
  readonly symbol: string;
  readonly side: 'BUY' | 'SELL';
  readonly executionSide: 'BUY' | 'SELL';
  readonly initialExecutionPhase?: 'OPEN' | 'TERMINAL';
  readonly price: string | null;
  readonly initialSubmittedPrice: string | null;
  readonly quantity: number;
  readonly submittedAtMs?: number;
  readonly initialStatus?: OrderReadStatus;
  readonly isLongSymbol: boolean;
  readonly monitorSymbol: string;
  readonly isProtectiveLiquidation: boolean;
  readonly orderType: OrderReadType;
};

/** 执行器与 tracking 在每次真实 mutation attempt 前共享的授权阶段。 */
export type OrderActionAuthorizationStage =
  'executeSignals' | 'submitOrder.beforeApi' | 'cancelOrder.beforeApi' | 'replaceOrder.beforeApi';

/** 原 caller 授权与执行门禁的共享闭包，不允许重建为当下新授权。 */
export type OrderActionAuthorization = (stage: OrderActionAuthorizationStage) => boolean;

/** 订单事实、信号和连续交易派生 mutation 的明确授权来源。 */
export type OrderMutationRequest =
  | { readonly kind: 'ORDER_FACT' }
  | { readonly kind: 'SIGNAL_AUTHORIZED'; readonly authorize: OrderActionAuthorization }
  | { readonly kind: 'CONTINUOUS_TRADING_AUTHORIZED'; readonly authorize: () => boolean };

/** broker 已确认改单与未执行的事实，失败查询必须在最外 permit 完全释放后执行。 */
export type ReplaceOrderPriceOutcome =
  | { readonly kind: 'BROKER_CONFIRMED' }
  | { readonly kind: 'NOT_EXECUTED' }
  | {
      readonly kind: 'POST_FAILURE_CONFIRMATION_REQUIRED';
      readonly confirmAfterPermitReleased: () => Promise<ReplaceOrderPriceOutcome>;
    };

/**
 * 追踪中的订单信息。
 * 类型用途：OrderMonitor 内部存储，用于 WebSocket 监控订单状态变化，跟踪委托价和成交情况。
 * 数据来源：由 tracking 的 trackOrder 初始化，query/push 合并回报后更新。
 * 使用范围：唯一 tracking owner 持有可变状态；domain 规则仅以只读视图裁决，标有非 readonly 的字段属于该 owner 的可变边界。
 */
export type TrackedOrder = {
  readonly orderId: string;
  readonly symbol: string;
  readonly side: 'BUY' | 'SELL';
  readonly executionSide: 'BUY' | 'SELL';

  /** 原mapper/已接受观察的生命周期；尚无broker事实时未知。 */
  executionPhase: 'OPEN' | 'TERMINAL' | null;

  /** 是否为做多标的（成交后更新本地记录时使用） */
  readonly isLongSymbol: boolean;

  /** 监控标的代码（用于成交日志与冷却恢复） */
  readonly monitorSymbol: string;

  /** 是否为保护性清仓订单（用于触发买入冷却） */
  readonly isProtectiveLiquidation: boolean;

  /** 订单类型（用于合并和改单判断） */
  readonly orderType: OrderReadType;

  /** 当前委托价；市价单为 null，非市价单会随改单更新。 */
  submittedPrice: string | null;

  /** 跟踪开始时的初始委托价；市价单为 null，用于非市价买单跟价上限判断。 */
  readonly initialSubmittedPrice: string | null;

  /** 委托数量（含部分成交后的剩余总量） */
  submittedQuantity: number;

  /** 已成交数量（部分成交时累加） */
  executedQuantity: number;

  /** 最近一次已成交价格（部分成交/完全成交时更新） */
  executedPrice: string | null;
  executedAmount: string;

  /** 最近一次已成交时间（毫秒） */
  lastExecutedTimeMs: number | null;

  /** 最近一次已合并的订单事件更新时间（毫秒），用于拒绝乱序 WS 回退 */
  lastOrderUpdateAtMs: number | null;

  /** 当前订单状态（由 WebSocket 推送更新） */
  status: OrderReadStatus;

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
 * 订单监控配置。
 * 类型用途：控制订单超时转换和价格修改行为。
 * 数据来源：如适用（来自交易配置等）。
 * 使用范围：tracking 盯单推进与 domain 超时规则共同消费。
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
  readonly priceDiffThreshold: string;

  /** 买单跟价是否允许高于初始委托价 */
  readonly allowBuyOrderTrackingAboveInitialPrice: boolean;
};

/**
 * 订单统计信息类型。
 * 类型用途：用于调试输出或内部汇总（数量、均价）。
 * 数据来源：如适用（由模块内部根据订单列表计算）。
 * 使用范围：仅 orderRecorder 模块使用。
 */
export type OrderStatistics = {
  readonly totalQuantity: number;
  readonly costAmount: string;
};

/**
 * 日内亏损回算所需的订单分析依赖。
 * 类型用途：纯订单分析能力集合，供装配层注入 dailyLossTracker，不包含 recorder 状态或经济提交能力。
 * 数据来源：domain/order/orderAnalysis 的无状态函数组合。
 * 使用范围：日损益重建与订单分析测试。
 */
export interface OrderDailyLossAnalysisDeps {
  readonly filteringEngine: OrderFilteringEngine;
  readonly resolveOrderOwnership: (
    order: DailyLossOrderSnapshot,
    monitor: DailyLossMonitorScope,
  ) => OrderOwnership | null;
  readonly classifyAndConvertOrders: (orders: ReadonlyArray<OrderExecutionRecordObservation>) => {
    readonly buyOrders: ReadonlyArray<OrderRecord>;
    readonly sellOrders: ReadonlyArray<OrderRecord>;
  };
}

/** 同 broker identity 的经济增量范围；来源和准入位置固定。slice 不是独立订单，clear 仅标记当时幸存范围。 */
type ExecutionProjectionSlice = {
  readonly quantity: number;
  readonly executionTimeMs: number;
  readonly admittedSequence: number;
  readonly origin: 'ONLINE' | 'HISTORY';
  readonly clearedAtSequence: number | null;
};

/** 唯一 broker fact 条目的经济消费证明；OPEN partial 不建立 slice，不从 survivor 推造覆盖。 */
export type OwnedExecutionFact = {
  readonly fact: BrokerOrderExecutionFact;
  readonly isLongSymbol: boolean;
  readonly economicQuantity: number;
  readonly projectionSlices: ReadonlyArray<ExecutionProjectionSlice>;
  readonly relatedBuyOrderIds: ReadonlyArray<string>;
};

/** 纯重算中的私有 slice 引用；每轮只聚合当前位置尚存的同 broker ID 范围，不复活已消费范围。 */
export type ProjectionSliceInput = {
  readonly brokerOrderId: string;
  readonly entry: OwnedExecutionFact;
  readonly slice: ExecutionProjectionSlice;
};

/**
 * 单订单权威终态快照。
 * 类型用途：缓存撤单/改单业务失败后的权威终态查询结果。
 * 数据来源：orderStatusQuery.checkOrderState 返回的 TERMINAL 分支。
 * 使用范围：orderMonitor 目录内部。
 */
export type TerminalStateSnapshot = Extract<OrderStateCheckResult, { kind: 'TERMINAL' }>;

/**
 * 已与当前订单事实合并的终态快照。
 * 类型用途：为结算链路同时提供单调的终态、累计成交、成交时间与 revision。
 * 数据来源：orderFactMerge 合并 tracked/启动快照与 API TERMINAL state-check。
 * 使用范围：orderMonitor 内部 TERMINAL 消费路径。
 */
export type NormalizedTerminalStateSnapshot = TerminalStateSnapshot &
  Readonly<{
    /** 归一后的经济事实必须携带精确金额文本，不得保留原始缺价 null。 */
    readonly executedAmount: string;
    readonly executedTimeMs: number | null;
  }>;

/**
 * 订单事实观察值。
 * 类型用途：统一承载 WS 与权威 state-check 输入单调合并的状态、成交和 revision。
 * 数据来源：OrderFact 或 OrderStateCheckResult OPEN/TERMINAL 分支。
 * 使用范围：orderMonitor 内部。
 */
export type OrderObservedFact = Readonly<{
  status: OrderReadStatus;
  executionPhase: 'OPEN' | 'TERMINAL';
  executedQuantity: number | null;

  /** 原始累计成交金额；正成交量缺价时显式为 null，由共享累计 merge 拒绝或保留 known。 */
  executedAmount: string | null;
  executedPrice: string | null;
  executedTimeMs: number | null;
  updatedAtMs: number | null;
}>;

/**
 * 单调合并后的订单事件事实。
 * 类型用途：承载 WS 或 state-check 观察值经过时间、累计成交量和状态强度裁决后的结果。
 * 数据来源：orderFactMerge 对观察值与 tracked order 当前事实合并得到。
 * 使用范围：orderMonitor 内部。
 */
export type MonotonicOrderFact = Readonly<{
  status: OrderReadStatus;
  executionPhase: 'OPEN' | 'TERMINAL';
  executedQuantity: number;
  executedAmount: string;
  executedPrice: string | null;
  executedTimeMs: number | null;
  updatedAtMs: number | null;
}>;

/** 单调裁决只读事实，不依赖 tracking 的 runtime store 或队列模型。 */
export type KnownOrderFact = {
  readonly orderId: string;
  readonly symbol: string;
  readonly executionSide: 'BUY' | 'SELL';
  readonly executionPhase: 'OPEN' | 'TERMINAL' | null;
  readonly submittedQuantity: number;
  readonly status: OrderReadStatus;
  readonly executedQuantity: number;
  readonly executedPrice: string | null;
  readonly executedAmount: string;
  readonly lastExecutedTimeMs: number | null;
  readonly lastOrderUpdateAtMs: number | null;
};

/**
 * 改单恢复模式。
 * 类型用途：约束 602013 临时阻塞后的恢复策略。
 * 数据来源：orderOps 与 route runtime 相关运行态更新。
 * 使用范围：orderMonitor 目录内部。
 */
type ReplaceResumeMode = 'TIME_BACKOFF' | 'WAIT_WS_ONLY';

/**
 * 已确认终态原因。
 * 类型用途：约束 routeProcessor / settlementFlow 只处理系统认可的终态结论。
 * 数据来源：WS 订单终态、权威状态查询结果与恢复链路。
 * 使用范围：orderMonitor 目录内部。
 */
export type TerminalClosedReason = 'FILLED' | 'CANCELED' | 'REJECTED';

/**
 * 终态结算输入。
 * 类型用途：把已确认终态的最小结算载荷与查询侧剩余数量信息打包传递。
 * 数据来源：routeProcessor 在 timeout / state-check / WS 终态处理中构造。
 * 使用范围：orderMonitor 目录内部。
 */
export type TerminalSettlementInput = {
  readonly params: {
    readonly orderId: string;
    readonly closedReason: TerminalClosedReason;
    readonly source: 'API' | 'WS';
    readonly executedPrice: string | null;
    readonly executedQuantity: number | null;
    readonly executedAmount: string;
    readonly executedTimeMs: number | null;
    readonly orderUpdatedAtMs: number | null;
    readonly preparedProtectiveTerminalExecution?: DailyLossCumulativeExecutionResult;
  };
  readonly queriedExecutedQuantity: number | null;
};

/**
 * 卖单超时处置结果。
 * 类型用途：区分继续等待终态、直接结算或结算后转市价的后续动作。
 * 数据来源：routeProcessor 在收到卖单超时终态后基于剩余数量计算。
 * 使用范围：仅 orderMonitor/routeProcessor.ts 使用。
 */
export type SellTimeoutResolution =
  | {
      readonly kind: 'WAIT_RETRY';
    }
  | {
      readonly kind: 'SETTLE_FILLED';
      readonly settlementInput: TerminalSettlementInput;
    }
  | {
      readonly kind: 'SETTLE_NO_REMAINDER';
      readonly settlementInput: TerminalSettlementInput;
    }
  | {
      readonly kind: 'SETTLE_AND_CONVERT';
      readonly settlementInput: TerminalSettlementInput;
      readonly marketConversionQuantity: number;
    };

/**
 * orderMonitor 内部追踪订单模型。
 * 类型用途：在基础 TrackedOrder 上补充状态确认与改单恢复的窄状态字段。
 * 数据来源：trackOrder 初始化，后续由 orderOps / eventFlow / routeProcessor 更新。
 * 使用范围：orderMonitor 目录内部。
 */
export type TimeoutMarketConversionTerminalState = Readonly<{
  readonly closedReason: OrderClosedReason;
  readonly source: 'WS';
  readonly executedPrice: string | null;
  readonly executedQuantity: number | null;
  readonly executedAmount: string;
  readonly executedTimeMs: number | null;
  readonly orderUpdatedAtMs: number | null;
  readonly preparedProtectiveTerminalExecution?: DailyLossCumulativeExecutionResult;
}>;

/**
 * orderMonitor 内部扩展追踪订单模型。
 * 类型用途：在基础 TrackedOrder 上补充改单限流、quote retry 与卖单超时转市价等待态。
 * 数据来源：trackOrder 初始化后，由 orderOps、eventFlow 与 routeProcessor 按订单链路推进更新。
 * 使用范围：仅 orderMonitor 目录内部使用。
 */
export type OrderMonitorTrackedOrder = TrackedOrder & {
  /** 连续命中 602013 的计数 */
  replaceTempBlockedCount: number;

  /** 改单恢复模式 */
  replaceResumeMode: ReplaceResumeMode;

  /** quote retry 已尝试次数 */
  quoteRetryAttempts: number;

  /** 下次允许重试 quote 的时间戳（毫秒） */
  quoteRetryNextAt: number | null;

  /** 卖单超时后是否已进入“等待终态确认后转市价”阶段 */
  timeoutMarketConversionPending: boolean;

  /** 卖单超时等待阶段已收到的终态快照 */
  timeoutMarketConversionTerminalState: TimeoutMarketConversionTerminalState | null;
};

/**
 * 602013 state-check 发起时的改单阻塞 owner 快照。
 * 类型用途：在异步查询返回后确认 WS 未解除并重新分配该阻塞 owner。
 * 数据来源：orderOps.handleReplaceTempBlockedByStatus 发起第五次 state-check 前的 tracked order。
 * 使用范围：仅 orderMonitor/orderOps.ts 使用。
 */
export type ReplaceBlockOwnerSnapshot = Readonly<{
  readonly replaceCapability: OrderMonitorTrackedOrder['replaceCapability'];
  readonly replaceTempBlockedCount: OrderMonitorTrackedOrder['replaceTempBlockedCount'];
  readonly replaceResumeMode: OrderMonitorTrackedOrder['replaceResumeMode'];
  readonly replaceBlockedUntilAt: OrderMonitorTrackedOrder['replaceBlockedUntilAt'];
  readonly lastPriceUpdateAt: OrderMonitorTrackedOrder['lastPriceUpdateAt'];
}>;

/** broker 全量快照来源，决定相同订单 history/today 的覆盖优先级，仅用于纯快照择新。 */
export type OrderSnapshotSource = 'history' | 'today';

/**
 * 合并去重后的订单条目。
 * 类型用途：在按 orderId 合并时同时保留来源与订单内容，供覆盖策略判断。
 * 数据来源：mergeAndDeduplicateOrders 构建。
 * 使用范围：domain/order/orderSnapshotPolicy 的纯快照覆盖判断。
 */
export type MergedOrderEntry = {
  readonly source: OrderSnapshotSource;
  readonly order: OrderFact;
};

/**
 * durable baseline 恢复事实：累计经济完整，但 V1 baseline 可能未持久化 phase。
 * phase 为 null 时不得据此授权任何阶段推进，只能消费观察本身已声明的 phase。
 */
export type KnownExecutionBaseline = Omit<BrokerOrderExecutionFact, 'phase'> &
  Readonly<{ phase: 'OPEN' | 'TERMINAL' | null }>;

/** 重建输入保留 mapper 原始缺价：正成交缺金额/价时不得以 known 外的方式补造。 */
export type RebuildOrderObservation = Omit<OrderExecutionRecordObservation, 'executedAmount'> &
  Readonly<{ executedAmount: string | null }>;
