import type { Unsubscribe } from './events.js';
import type { OrderClosedReason } from './orderReadMetadata.js';
import type { OrderFact } from './trade.js';

/**
 * 订单状态变化事件。
 * 类型用途：表达订单监控向外暴露的最小终态结算事件载荷。
 * 数据来源：由 orderMonitor 在订单完成本地结算后发出。
 * 使用范围：orderMonitor、结算订阅方、后续事件驱动 runtime 与相关测试使用。
 */
export type OrderStateChangedEvent = Readonly<{
  orderId: string;
  symbol: string | null;
  side: 'BUY' | 'SELL' | null;
  source: 'API' | 'WS' | 'STATE_CHECK' | 'RECOVERY';
  status: OrderClosedReason;
  monitorSymbol: string | null;
  isLongSymbol: boolean | null;
  isProtectiveLiquidation: boolean;
  executedPrice: string | null;
  executedQuantity: number | null;
  executedTimeMs: number | null;
}>;

/** 真实订单监控的已结算终态事件；业务消费者不持有监听集合或监控启停。 */
export interface OrderTrackingEvents {
  readonly onOrderStateChanged: (listener: (event: OrderStateChangedEvent) => void) => Unsubscribe;
}

/** 按已经读取的同一全量订单事实恢复唯一 tracking owner，不另建订单集合。 */
export interface OrderTrackingRecovery {
  readonly recoverOrderTrackingFromSnapshot: (allOrders: ReadonlyArray<OrderFact>) => Promise<void>;
}

/** settlement 完成判定只读真实 tracking 中的未完结保护性订单，不推造 flat 结论。 */
export interface ProtectiveOrderReader {
  readonly hasPendingProtectiveLiquidationOrders: (direction: 'LONG' | 'SHORT') => boolean;
}

/** app 与 lifecycle 对唯一 orderMonitor 的实际启停/释放能力，方法名来自真实 owner。 */
export interface OrderTrackingLifecycle {
  readonly initialize: () => Promise<void>;
  readonly startRuntime: () => void;
  readonly stopRuntimeAndDrain: () => Promise<void>;
  readonly teardown: () => Promise<void>;
}
