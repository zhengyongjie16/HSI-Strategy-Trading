import type { OrderRecord } from '../../types/services.js';
import type { OrderReadStatus, OrderReadType } from '../../types/orderReadMetadata.js';
import type { OrderTypeConfig } from '../../types/signal.js';

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
  readonly symbol: string;
  readonly isProtectiveLiquidation: boolean;
  readonly side: 'BUY' | 'SELL';
  readonly status: OrderReadStatus;
  readonly orderType: OrderReadType;
  readonly submittedPrice: string | null;
  readonly submittedQuantity: number;
  readonly executedQuantity: number;
  readonly submittedAt: number;
};

/** 新卖出需求与旧挂单事实，供共享执行器初次规划及最终 permit 复核。 */
export type SellMergeDecisionInput = {
  readonly symbol: string;
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
