import type { Decimal, OrderSide, OrderType, TimeInForceType, TradeContext } from 'longbridge';
import type { MonitorConfig, GlobalConfig } from '../../../types/config.js';
import type {
  BuySignal,
  ExecutableSellSignal,
  SellSignal,
  Signal,
  SignalType,
} from '../../../types/signal.js';
import type {
  OrderActionAuthorization,
  OrderCacheManager,
  OrderMonitor,
  OrderPayload,
} from '../types.js';
import type {
  MarketDataClient,
  OrderRecorder,
  RateLimiter,
  RiskChecker,
  TradeCheckResult,
} from '../../../types/services.js';
import type { RuntimeClock } from '../../../types/runtime.js';

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
 * 类型用途：把普通买卖信号唯一绑定到席位方向与 SDK side，并限制其只能使用普通执行目的。
 * 数据来源：OrderExecutor 的 executeSignals 入口。
 * 使用范围：orderExecutor 内部的授权、数量计算与提交链路。
 */
type OrdinaryOrderCommand =
  | {
      readonly kind: 'BUY';
      readonly signal: BuySignal & { readonly action: 'BUYCALL' };
      readonly direction: 'LONG';
      readonly side: OrderSide.Buy;
      readonly executionPurpose: 'ORDINARY';
    }
  | {
      readonly kind: 'BUY';
      readonly signal: BuySignal & { readonly action: 'BUYPUT' };
      readonly direction: 'SHORT';
      readonly side: OrderSide.Buy;
      readonly executionPurpose: 'ORDINARY';
    }
  | {
      readonly kind: 'SELL';
      readonly signal: ExecutableSellSignal & { readonly action: 'SELLCALL' };
      readonly direction: 'LONG';
      readonly side: OrderSide.Sell;
      readonly executionPurpose: 'ORDINARY';
    }
  | {
      readonly kind: 'SELL';
      readonly signal: ExecutableSellSignal & { readonly action: 'SELLPUT' };
      readonly direction: 'SHORT';
      readonly side: OrderSide.Sell;
      readonly executionPurpose: 'ORDINARY';
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
      readonly side: OrderSide.Sell;
      readonly executionPurpose: 'DOOMSDAY_CLEARANCE';
    }
  | {
      readonly kind: 'SELL';
      readonly signal: SellSignal & { readonly action: 'SELLPUT' };
      readonly direction: 'SHORT';
      readonly side: OrderSide.Sell;
      readonly executionPurpose: 'DOOMSDAY_CLEARANCE';
    };

/**
 * 可执行订单命令。
 * 类型用途：在 OrderExecutor 入口把窄信号动作唯一绑定到席位方向、SDK side 与执行目的；标的、席位版本和关联买单身份只从 signal 读取。
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
  | { readonly kind: 'WAITING_FOR_AUTHORITATIVE_TERMINAL'; readonly symbol: string }
  | { readonly kind: 'QUOTE_UNAVAILABLE'; readonly symbol: string }
  | { readonly kind: 'SKIPPED' };

/**
 * broker 下单阶段。
 * 类型用途：将下单前、已尝试 SDK 提交和已确认 broker 接受三个事实边界显式化。
 * 数据来源：submitFlow 在最终 mutation permit 内推进。
 * 使用范围：仅 submitFlow 的错误分类与本地同步收口。
 */
export type BrokerSubmissionStage =
  | { readonly kind: 'PRE_SUBMIT' }
  | { readonly kind: 'BROKER_SUBMISSION_ATTEMPTED'; readonly orderPayload: OrderPayload }
  | {
      readonly kind: 'BROKER_ACCEPTED';
      readonly orderId: string;
      readonly orderPayload: OrderPayload;
    };

/**
 * 下单失败阶段分类。
 * 类型用途：仅让有结构化业务码的 broker 拒绝返回跳过；其余分类必须被上层错误通道观察。
 * 数据来源：submitFlow 对 SDK、配置、行情和本地同步异常的阶段判定。
 * 使用范围：仅 submitFlow 的 catch 分支。
 */
export type SubmitFailureClassification =
  | { readonly kind: 'PRE_SUBMIT_FAILURE' }
  | { readonly kind: 'EXPLICIT_BROKER_REJECTION'; readonly orderPayload: OrderPayload }
  | { readonly kind: 'UNCONFIRMED_EXTERNAL_SUBMISSION' }
  | { readonly kind: 'UNCONFIRMED_SUBMISSION' }
  | { readonly kind: 'POST_ACCEPTANCE_LOCAL_SYNC_FAILURE' };

/**
 * broker 已接受订单后的本地同步失败。
 * 类型用途：携带已确认订单 ID 和原始 cause，避免靠错误文案判断下单状态。
 * 数据来源：submitFlow 的缓存失效、追踪登记和卖单记录步骤。
 * 使用范围：运行期错误通道与 submitFlow 业务测试。
 */
export type AcceptedOrderLocalSyncError = Error & {
  readonly name: 'AcceptedOrderLocalSyncError';
  readonly orderId: string;
};

/**
 * SDK 下单提交参数。
 * 类型用途：在已解析订单命令上补充数量、订单类型、价格与授权信息。
 * 数据来源：submitTargetOrder 完成数量与订单配置解析后构造。
 * 使用范围：仅 submitFlow 内部 submitOrder 使用。
 */
export type SubmitOrderParams = {
  readonly command: ExecutableOrderCommand;
  readonly authorizeOrderAction: OrderActionAuthorization;

  /** SELL 在最终报价前已完成的数量计划；BUY 必须为 null 并在 permit 内按 P1 重算。 */
  readonly submittedQtyDecimal: Decimal | null;
  readonly orderTypeParam: OrderType;
  readonly timeInForce: TimeInForceType;
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
  readonly ctx: TradeContext;
  readonly rateLimiter: RateLimiter;
  readonly marketDataClient: MarketDataClient;
  readonly cacheManager: OrderCacheManager;
  readonly orderMonitor: OrderMonitor;
  readonly orderRecorder: OrderRecorder;
  readonly globalConfig: GlobalConfig;
  readonly monitorConfig: MonitorConfig;

  /** 与运行时共享的浮亏买入门禁；只允许最终 BUY 提交边界调用。 */
  readonly unrealizedLossBuyGate: Pick<RiskChecker, 'checkUnrealizedLoss'>;
  readonly canExecuteSignal: (signal: Signal, stage: string) => boolean;
  readonly canTradeNow: (signalAction: SignalType) => TradeCheckResult;
  readonly recordBuyAttempt: (signalAction: SignalType) => void;
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

/**
 * 卖出数量新鲜度解析结果。
 * 类型用途：同时保留账户刚读取的可卖上限与当前信号允许提交的数量，供撤单后的重规划统一裁剪。
 * 数据来源：QuantityResolver 对 TradeContext.stockPositions 的实时读取。
 * 使用范围：仅 orderExecutor/submitFlow.ts 使用。
 */
export type SellQuantityResolution = {
  readonly availableQuantity: number;
  readonly submittedQuantity: Decimal;
};

/**
 * 数量解析器接口。
 * 类型用途：统一封装买入/卖出数量计算逻辑，避免 submitFlow 混入数量解析细节。
 * 数据来源：由 createQuantityResolver 工厂创建。
 * 使用范围：仅 orderExecutor 目录内部使用。
 */
export interface QuantityResolver {
  calculateSellQuantity: (
    ctx: TradeContext,
    symbol: string,
    signal: Signal,
  ) => Promise<SellQuantityResolution>;
  resolveDoomsdayClearanceQuantity: (ctx: TradeContext, symbol: string) => Promise<Decimal>;
  resolveBuyQuantity: (
    signal: Signal,
    isShortSymbol: boolean,
    targetNotional: number,
    finalPrice: number,
    finalLotSize: number | undefined,
  ) => Decimal;
}
