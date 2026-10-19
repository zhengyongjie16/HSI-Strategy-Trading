import type { Logger } from '../../types/logger.js';
import type { DiagnosticObserver } from '../../types/diagnostics.js';
import type {
  OrderActionAuthorization,
  OrderMutationRequest,
  PendingSellOrderSnapshot,
  ReplaceOrderPriceOutcome,
  TrackOrderParams,
} from '../../domain/order/types.js';
import type { Position } from '../../types/account.js';
import type { GlobalConfig, MonitorConfig, TradingConfig } from '../../types/config.js';
import type { MarketDataClient } from '../../types/marketPorts.js';
import type { TradingDayInfo } from '../../types/tradingCalendar.js';
import type { RuntimeClock } from '../../types/runtime.js';
import type { SymbolRegistry } from '../../types/seat.js';
import type { OrderRecorder } from '../../types/orderRecorder.js';
import type { RateLimiter, TradeMutationPermit } from '../../types/rateLimit.js';
import type { RiskChecker } from '../../types/riskCheck.js';
import type {
  TradeCheckResult,
  DoomsdayClearanceExecutionResult,
  ExecuteSignalsResult,
  SignalCallerAuthorization,
} from '../../types/orderExecutionPorts.js';
import type {
  BuySignal,
  DoomsdayClearanceCommand,
  ExecutableSellSignal,
  ExecutableSignal,
  OrderTypeConfig,
  SellSignal,
  Signal,
  SignalType,
} from '../../types/signal.js';
import type { OrderCommandPurpose, TradeMutationPort } from '../../types/tradeMutationPorts.js';
import type { CancelOrderOutcome } from '../../types/orderCancellation.js';

/**
 * 提交目标订单函数签名。
 * 类型用途：约束 submitFlow 对外暴露的核心提交流程函数形状。
 * 数据来源：由 createSubmitTargetOrder 工厂返回。
 * 使用范围：仅 orderExecutor/index.ts 调用。
 */
export type SubmitTargetOrder = (
  command: ExecutableOrderCommand,
  authorizeOrderAction: OrderActionAuthorization,
) => Promise<OrderActionResult>;

/**
 * 普通信号订单命令。
 * 类型用途：把普通买卖信号唯一绑定到席位方向与 中性 side，并限制其只能使用普通执行目的。
 * 数据来源：OrderExecutor 的 executeSignals 入口。
 * 使用范围：orderExecutor 内部的授权、数量计算与提交链路。
 */
type OrdinaryOrderCommand =
  | {
      readonly kind: 'BUY';
      readonly signal: BuySignal & { readonly action: 'BUYCALL' };
      readonly direction: 'LONG';
      readonly side: 'BUY';
      readonly executionPurpose: 'ORDINARY';
      readonly purpose: Exclude<OrderCommandPurpose, 'DOOMSDAY_CLEARANCE'>;
    }
  | {
      readonly kind: 'BUY';
      readonly signal: BuySignal & { readonly action: 'BUYPUT' };
      readonly direction: 'SHORT';
      readonly side: 'BUY';
      readonly executionPurpose: 'ORDINARY';
      readonly purpose: Exclude<OrderCommandPurpose, 'DOOMSDAY_CLEARANCE'>;
    }
  | {
      readonly kind: 'SELL';
      readonly signal: ExecutableSellSignal & { readonly action: 'SELLCALL' };
      readonly direction: 'LONG';
      readonly side: 'SELL';
      readonly executionPurpose: 'ORDINARY';
      readonly purpose: Exclude<OrderCommandPurpose, 'DOOMSDAY_CLEARANCE'>;
    }
  | {
      readonly kind: 'SELL';
      readonly signal: ExecutableSellSignal & { readonly action: 'SELLPUT' };
      readonly direction: 'SHORT';
      readonly side: 'SELL';
      readonly executionPurpose: 'ORDINARY';
      readonly purpose: Exclude<OrderCommandPurpose, 'DOOMSDAY_CLEARANCE'>;
    };

/**
 * 末日清仓订单命令。
 * 类型用途：把末日清仓目的限制为卖出动作，避免 BUY 与 DOOMSDAY_CLEARANCE 的无效组合进入最终副作用边界。
 * 数据来源：OrderExecutor 的 executeDoomsdayClearanceSignals 专用入口。
 * 使用范围：orderExecutor 内部的末日清仓撤单、持仓重读与普通末日单提交链路。
 */
export type DoomsdayClearanceOrderCommand =
  | {
      readonly kind: 'SELL';
      readonly signal: SellSignal & { readonly action: 'SELLCALL' };
      readonly direction: 'LONG';
      readonly side: 'SELL';
      readonly executionPurpose: 'DOOMSDAY_CLEARANCE';
      readonly purpose: 'DOOMSDAY_CLEARANCE';
    }
  | {
      readonly kind: 'SELL';
      readonly signal: SellSignal & { readonly action: 'SELLPUT' };
      readonly direction: 'SHORT';
      readonly side: 'SELL';
      readonly executionPurpose: 'DOOMSDAY_CLEARANCE';
      readonly purpose: 'DOOMSDAY_CLEARANCE';
    };

/**
 * 可执行订单命令。
 * 类型用途：在 OrderExecutor 入口把窄信号动作唯一绑定到席位方向、中性 side 与执行目的；标的、席位版本和关联买单身份只从 signal 读取。
 * 数据来源：ExecutableSignal 经运行时动作解析后构造。
 * 使用范围：orderExecutor 的授权、数量计算与提交链路。
 */
export type ExecutableOrderCommand = OrdinaryOrderCommand | DoomsdayClearanceOrderCommand;

/**
 * 单信号订单动作结果。
 * 类型用途：区分新提交、broker 已确认改单与明确未执行。
 * 数据来源：submitTargetOrder 各业务分支。
 * 使用范围：OrderExecutor 汇总执行订单 ID。
 */
export type OrderActionResult =
  | { readonly kind: 'SUBMITTED'; readonly orderId: string }
  | { readonly kind: 'REPLACED'; readonly orderId: string }
  | { readonly kind: 'SELL_AVAILABILITY_CHANGED'; readonly symbol: string }
  | { readonly kind: 'QUOTE_MISSING' | 'QUOTE_INVALID'; readonly symbol: string }
  | { readonly kind: 'REJECTED' | 'NO_AVAILABLE_QUANTITY' }
  | { readonly kind: 'SKIPPED' };

/** 命令批次的内部执行事实；commandIndex 保留输入序号，解析时克隆的 signal 不承担回映身份。 */
export type OrderCommandBatchResult = {
  readonly executedOrderIds: ReadonlyArray<string>;
  readonly reevaluationSymbols: ReadonlyArray<string>;
  readonly unresolvedQuoteSymbols: ReadonlyArray<string>;
  readonly sellDecisionResults: ReadonlyArray<{
    readonly commandIndex: number;
    readonly kind: 'REJECTED' | 'NO_AVAILABLE_QUANTITY' | 'SELL_AVAILABILITY_CHANGED';
  }>;
  readonly quoteFailures: ReadonlyArray<{
    readonly commandIndex: number;
    readonly kind: 'QUOTE_MISSING' | 'QUOTE_INVALID';
  }>;
};

/**
 * 域内下单提交计划。
 * 类型用途：在已解析订单命令上补充安全整数数量、订单类型与授权信息；不传递 SDK 金融对象。
 * 数据来源：submitTargetOrder 完成数量与订单配置解析后构造。
 * 使用范围：仅 submitFlow 内部 submitOrder 使用。
 */
export type SubmitOrderParams = {
  readonly command: ExecutableOrderCommand;
  readonly authorizeOrderAction: OrderActionAuthorization;

  /** SELL 在最终报价前已完成的数量计划；BUY 必须为 null 并在 permit 内按 P1 重算。 */
  readonly submittedQuantity: number | null;

  /** 末日或距离换仓读仓前由 tracking owner 捕获，最终提交边界不得重签；普通合单不提供。 */
  readonly isSellAvailabilityCurrent?: () => boolean;
  readonly orderTypeConfig: OrderTypeConfig;
  readonly remark: string | undefined;
  readonly relatedBuyOrderIds?: ReadonlyArray<string> | null;
};

/**
 * 智能平仓关联买单与最终卖出数量的精确性校验参数。
 * 类型用途：把订单记录器中的整笔买单集合与最终 broker 卖出数量绑定，禁止 pending/settlement 使用不可表示的关联集合。
 * 数据来源：submitFlow 在 SUBMIT、REPLACE 与 CANCEL_AND_SUBMIT 的最终副作用边界构造。
 * 使用范围：仅 orderExecutor/submitFlow.ts 的关联数量校验与 REPLACE 授权复核。
 */
export type RelatedBuyOrderQuantityValidationParams = {
  readonly orderRecorder: OrderRecorder;
  readonly symbol: string;
  readonly isLongSymbol: boolean;
  readonly submittedQuantity: number;
  readonly relatedBuyOrderIds: ReadonlyArray<string>;
};

/**
 * 目标订单提交流程依赖。
 * 类型用途：集中注入 submitFlow 所需的上下文、服务与回调，避免内部直接构造依赖。
 * 数据来源：由 createOrderExecutor 装配。
 * 使用范围：仅 orderExecutor/submitFlow.ts 使用。
 */
export type SubmitTargetOrderDeps = {
  readonly logger: Logger;
  readonly diagnostics: DiagnosticObserver;
  readonly readSellPositions: (symbol: string) => Promise<ReadonlyArray<Position>>;
  readonly tradeMutationPort: TradeMutationPort;
  readonly rateLimiter: RateLimiter;
  readonly marketDataClient: MarketDataClient;
  readonly cacheManager: OrderExecutionCacheInvalidator;
  readonly orderMonitor: OrderExecutionTrackingPort;
  readonly orderRecorder: OrderRecorder;
  readonly globalConfig: GlobalConfig;
  readonly monitorConfig: MonitorConfig;

  /** 与运行时共享的浮亏买入门禁；只允许最终 BUY 提交边界调用。 */
  readonly unrealizedLossBuyGate: Pick<RiskChecker, 'checkUnrealizedLoss'>;
  readonly canExecuteSignal: (signal: Signal, stage: string) => boolean;
  readonly canTradeNow: (signalAction: SignalType) => TradeCheckResult;
  readonly recordBuyAttempt: (signalAction: SignalType) => void;

  /** 与外层执行器同源的提交时钟；不得以 signal/quote 时间或默认当前时间替代。 */
  readonly now: () => Date;
};

/**
 * 买入节流器接口。
 * 类型用途：封装买入频率限制状态与操作，供 orderExecutor 主流程与提交流程共用。
 * 数据来源：由 createBuyThrottle 工厂创建并维护内部 Map 状态。
 * 使用范围：仅 orderExecutor 目录内部使用。
 */
export interface BuyThrottle {
  canTradeNow: (signalAction: SignalType) => TradeCheckResult;
  resetBuyThrottle: () => void;
  recordBuyAttempt: (signalAction: SignalType) => void;
}

/**
 * 买入节流器依赖。
 * 类型用途：绑定单 monitor 的买入间隔与订单执行器共享的运行时时钟。
 * 数据来源：由 OrderExecutor 在创建阶段注入。
 * 使用范围：仅 orderExecutor/buyThrottle.ts 使用。
 */
export type BuyThrottleDeps = Readonly<{
  readonly buyIntervalSeconds: number;
  readonly clock: RuntimeClock;
}>;

/** 执行器只使既有订单缓存失效，不读写第二订单账。 */
interface OrderExecutionCacheInvalidator {
  clearCache: () => void;
}

/** 共享执行所需 tracking 能力；权威终态结算仍由 tracking 与唯一 settlement owner 负责。 */
export interface OrderExecutionTrackingPort {
  trackOrder: (params: TrackOrderParams) => void;
  getPendingSellOrders: (symbol: string) => ReadonlyArray<PendingSellOrderSnapshot>;
  captureSellAvailabilityGuard: (symbol: string) => () => boolean;
  cancelOrder: (orderId: string, request: OrderMutationRequest) => Promise<CancelOrderOutcome>;
  replaceOrderPriceWithPermit: (
    orderId: string,
    newPrice: string,
    request: OrderMutationRequest,
    permit: TradeMutationPermit,
    quantity?: number | null,
  ) => Promise<ReplaceOrderPriceOutcome>;
}

/** 单一共享执行入口及买入节流能力，由 Trader 创建并直接消费，不保留旧转发 owner。 */
export interface OrderExecutor {
  canTradeNow: (signalAction: SignalType) => TradeCheckResult;
  executeSignals: (
    signals: ReadonlyArray<ExecutableSignal>,
    callerAuthorization: SignalCallerAuthorization,
  ) => Promise<ExecuteSignalsResult>;
  executeDoomsdayClearanceSignals: (
    commands: ReadonlyArray<DoomsdayClearanceCommand>,
    callerAuthorization: SignalCallerAuthorization,
  ) => Promise<DoomsdayClearanceExecutionResult>;
  resetBuyThrottle: () => void;
}

/** 共享订单执行依赖；仅注入中性 port/事实，无 SDK 或旧混合 owner 类型。 */
export type OrderExecutorDeps = {
  readonly logger: Logger;
  readonly diagnostics: DiagnosticObserver;
  readonly readSellPositions: (symbol: string) => Promise<ReadonlyArray<Position>>;
  readonly tradeMutationPort: TradeMutationPort;
  readonly rateLimiter: RateLimiter;
  readonly marketDataClient: MarketDataClient;
  readonly cacheManager: OrderExecutionCacheInvalidator;
  readonly orderMonitor: OrderExecutionTrackingPort;
  readonly orderRecorder: OrderRecorder;
  readonly unrealizedLossBuyGate: Pick<RiskChecker, 'checkUnrealizedLoss'>;
  readonly tradingConfig: TradingConfig;
  readonly symbolRegistry: SymbolRegistry;
  readonly isExecutionAllowed: () => boolean;
  readonly isContinuousTradingAllowed: () => boolean;
  readonly now: () => Date;
  readonly readCurrentTradingDayInfo: () => Readonly<{
    dateKey: string;
    info: TradingDayInfo;
  }> | null;
};

/**
 * 频率限制器配置。
 * 类型用途：控制 API 调用频率（窗口内最大调用次数与窗口时长）。
 * 数据来源：由 Trader 从 tradingConfig 或默认值构造，传入 createRateLimiter。
 * 使用范围：仅在 trader 模块内部使用。
 */
export type RateLimiterConfig = {
  readonly maxCalls: number;
  readonly windowMs: number;
};

/**
 * 频率限制器依赖。
 * 类型用途：创建 RateLimiter 实例时的依赖注入参数。
 * 数据来源：由 Trader 工厂在创建 rateLimiter 时传入。
 * 使用范围：仅在 trader 模块内部使用。
 */
export type RateLimiterDeps = {
  readonly wait: (delayMs: number) => Promise<void>;
  readonly nowMonotonicMs: () => number;
  readonly logger: Logger;
  readonly config?: RateLimiterConfig;
};
