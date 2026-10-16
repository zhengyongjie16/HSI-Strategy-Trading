import type { SignalCallerAuthorization } from './orderExecutionPorts.js';
import type { OrderClosedReason } from './orderReadMetadata.js';

/**
 * 业务调用方撤单请求。
 * 类型用途：保留订单事实与业务派生撤单的授权来源，禁止门面将原业务授权改成订单事实授权。
 * 数据来源：订单 owner 或换标 owner 捕获的 epoch/readiness/席位/持仓授权。
 * 使用范围：OrderCancellation.cancelOrder 及其到 OrderMonitor mutation permit 的透传链路。
 */
export type CancelOrderRequest =
  | { readonly kind: 'ORDER_FACT' }
  | {
      readonly kind: 'SIGNAL_AUTHORIZED';
      readonly authorize: SignalCallerAuthorization;
    };

/**
 * 已确认终态订单的数量事实。
 * 类型用途：把权威终态的原始委托数量与单调合并后的累计成交数量成对交给后续重规划，禁止由过期 pending 快照补全。
 * 数据来源：orderDetail 终态查询与 orderMonitor 已知订单事实合并结果。
 * 使用范围：CancelOrderOutcome 的 ALREADY_CLOSED 分支及其调用方。
 */
type TerminalOrderExecutionFact = {
  readonly submittedQuantity: number | null;
  readonly executedQuantity: number | null;
};

/**
 * 撤单结果（语义化 outcome）。
 * 类型用途：替代 boolean 语义，区分确认撤销、已关闭、可重试失败与未知失败。
 * 注意：
 * - 对外的 orderMonitor.cancelOrder() 会在确认 tracked order 已终态时先完成本地结算，再返回结果。
 * - relatedBuyOrderIds 表示卖单终态结算后仍需由后续卖单继续关联的买单 ID；无法确定时为 null。
 * - ALREADY_CLOSED 必须携带终态数量事实；调用方在数量不可信时必须 fail-closed，不能回退到撤单前 pending 快照。
 * 数据来源：OrderMonitor.cancelOrder 返回值。
 * 使用范围：订单监控与取消调用方、订单执行与恢复链路；全项目可引用。
 */
export type CancelOrderOutcome =
  | {
      readonly kind: 'CANCEL_CONFIRMED';
      readonly relatedBuyOrderIds: ReadonlyArray<string> | null;
    }
  | {
      readonly kind: 'ALREADY_CLOSED';
      readonly closedReason: OrderClosedReason;
      readonly relatedBuyOrderIds: ReadonlyArray<string> | null;
      readonly terminalExecution: TerminalOrderExecutionFact;
    }
  | {
      readonly kind: 'RETRYABLE_FAILURE';
      readonly errorCode: string | null;
    }
  | {
      readonly kind: 'UNKNOWN_FAILURE';
      readonly errorCode: string | null;
    };

/**
 * 末日保护撤单的 permit 内授权请求。
 * 类型用途：要求末日保护在真正调用 broker 前重新确认其清仓窗口与生命周期门禁仍有效。
 * 数据来源：DoomsdayClearanceWorkflow.cancelPendingBuyOrders 的实时 isLive 门禁。
 * 使用范围：仅 DoomsdayOrderCancellation.cancelDoomsdayOrder 的末日保护调用。
 */
export type DoomsdayCancelOrderRequest = {
  readonly kind: 'DOOMSDAY_WINDOW';
  readonly beforeBrokerCancel: () => boolean;
};

/**
 * 撤单尚未开始结果。
 * 类型用途：明确表示 permit 内前置授权已失效，broker 未收到撤单请求。
 * 数据来源：OrderOps 在调用 TradeContext.cancelOrder 前的授权复核。
 * 使用范围：末日保护与 route owner 的撤单结果分流。
 */
export type CancelOrderNotStartedOutcome = {
  readonly kind: 'CANCEL_NOT_STARTED';
};

/**
 * 末日保护撤单结果。
 * 类型用途：除常规撤单结果外，保留 permit 内门禁关闭且未调用 broker 的事实。
 * 数据来源：DoomsdayOrderCancellation.cancelDoomsdayOrder 的 DOOMSDAY_WINDOW 请求。
 * 使用范围：DoomsdayClearanceWorkflow.cancelPendingBuyOrders。
 */
export type DoomsdayCancelOrderOutcome = CancelOrderOutcome | CancelOrderNotStartedOutcome;

/** 订单 owner 的常规撤单窄能力；保留订单事实或调用方捕获的原业务授权。 */
export interface OrderCancellation {
  readonly cancelOrder: (
    orderId: string,
    request: CancelOrderRequest,
  ) => Promise<CancelOrderOutcome>;
}

/** 末日 owner 的专用撤单能力；每次真实 broker 调用前复核同一窗口授权。 */
export interface DoomsdayOrderCancellation {
  readonly cancelDoomsdayOrder: (
    orderId: string,
    request: DoomsdayCancelOrderRequest,
  ) => Promise<DoomsdayCancelOrderOutcome>;
}
