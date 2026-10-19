import type { Unsubscribe } from './events.js';
import type { OrderFact } from './trade.js';

/** 订阅和换标只读取既有订单保留集；不暴露 tracked order 或本地集合 mutation。 */
export interface OrderHoldReader {
  readonly getHoldSymbols: () => ReadonlySet<string>;
}

/** quote runtime 订阅真实订单保留集合的已发布变化；listener 按当前保留集重新 reconcile，不消费事件载荷。 */
export interface OrderHoldEvents {
  readonly onOrderHoldSymbolsChanged: (listener: () => void) => Unsubscribe;
}

/** 启动/重建使用相同订单 API batch 种子化既有 hold owner。 */
export interface OrderHoldRecovery {
  readonly seedFromOrders: (orders: ReadonlyArray<OrderFact>) => void;
}
