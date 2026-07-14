import type { Decimal, OrderSide, OrderType, TimeInForceType, TradeContext } from 'longbridge';
import type { MonitorConfig, GlobalConfig } from '../../../types/config.js';
import type { BuySignal, SellSignal, Signal, SignalType } from '../../../types/signal.js';
import type { OrderActionAuthorization, OrderCacheManager, OrderMonitor } from '../types.js';
import type { OrderRecorder, RateLimiter, TradeCheckResult } from '../../../types/services.js';

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
 * 可执行订单命令。
 * 类型用途：在 OrderExecutor 入口把窄信号动作唯一绑定到席位方向与 SDK side；标的、席位版本和关联买单身份只从 signal 读取。
 * 数据来源：ExecutableSignal 经运行时动作解析后构造。
 * 使用范围：orderExecutor 的授权、数量计算与提交链路。
 */
export type ExecutableOrderCommand =
  | {
      readonly kind: 'BUY';
      readonly signal: BuySignal & { readonly action: 'BUYCALL' };
      readonly direction: 'LONG';
      readonly side: OrderSide.Buy;
    }
  | {
      readonly kind: 'BUY';
      readonly signal: BuySignal & { readonly action: 'BUYPUT' };
      readonly direction: 'SHORT';
      readonly side: OrderSide.Buy;
    }
  | {
      readonly kind: 'SELL';
      readonly signal: SellSignal & { readonly action: 'SELLCALL' };
      readonly direction: 'LONG';
      readonly side: OrderSide.Sell;
    }
  | {
      readonly kind: 'SELL';
      readonly signal: SellSignal & { readonly action: 'SELLPUT' };
      readonly direction: 'SHORT';
      readonly side: OrderSide.Sell;
    };

/**
 * 单信号订单动作结果。
 * 类型用途：区分新提交、broker 已确认改单与明确未执行。
 * 数据来源：submitTargetOrder 各业务分支。
 * 使用范围：OrderExecutor 汇总执行订单 ID。
 */
export type OrderActionResult =
  | { readonly kind: 'SUBMITTED'; readonly orderId: string }
  | { readonly kind: 'REPLACED'; readonly orderId: string }
  | { readonly kind: 'SKIPPED' };

/**
 * SDK 下单提交参数。
 * 类型用途：在已解析订单命令上补充数量、订单类型、价格与授权信息。
 * 数据来源：submitTargetOrder 完成数量与订单配置解析后构造。
 * 使用范围：仅 submitFlow 内部 submitOrder 使用。
 */
export type SubmitOrderParams = {
  readonly command: ExecutableOrderCommand;
  readonly authorizeOrderAction: OrderActionAuthorization;
  readonly submittedQtyDecimal: Decimal;
  readonly orderTypeParam: OrderType;
  readonly timeInForce: TimeInForceType;
  readonly remark: string | undefined;
  readonly overridePrice: number | undefined;
  readonly relatedBuyOrderIds?: ReadonlyArray<string> | null;
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
  readonly cacheManager: OrderCacheManager;
  readonly orderMonitor: OrderMonitor;
  readonly orderRecorder: OrderRecorder;
  readonly globalConfig: GlobalConfig;
  readonly monitorConfig: MonitorConfig;
  readonly canExecuteSignal: (signal: Signal, stage: string) => boolean;
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
 * 数量解析器接口。
 * 类型用途：统一封装买入/卖出数量计算逻辑，避免 submitFlow 混入数量解析细节。
 * 数据来源：由 createQuantityResolver 工厂创建。
 * 使用范围：仅 orderExecutor 目录内部使用。
 */
export interface QuantityResolver {
  calculateSellQuantity: (ctx: TradeContext, symbol: string, signal: Signal) => Promise<Decimal>;
  resolveBuyQuantity: (signal: Signal, isShortSymbol: boolean, targetNotional: number) => Decimal;
}
