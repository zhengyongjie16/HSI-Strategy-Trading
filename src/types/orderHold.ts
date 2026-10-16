import type { Unsubscribe } from './events.js';
import type { OrderFact } from './trade.js';

/**
 * 订单保留标的集合变化事件。
 * 类型用途：表达本地未完成订单保留集合的 symbol 粒度增减，供 quote 订阅 runtime 维护 ORDER_HOLD retain。
 * 数据来源：由 OrderHoldRegistry 在 holdSymbols 实际新增或移除时发布。
 * 使用范围：订单保留集、QuoteSubscriptionRuntime 与相关测试。
 */
export type OrderHoldSymbolsChangedEvent = Readonly<{
  /** 发生变化的订单标的 */
  symbol: string;

  /** 保留集合变化方向 */
  action: 'ADDED' | 'REMOVED';
}>;

/** 订阅和换标只读取既有订单保留集；不暴露 tracked order 或本地集合 mutation。 */
export interface OrderHoldReader {
  readonly getHoldSymbols: () => ReadonlySet<string>;
}

/** quote runtime 订阅真实订单保留集合的已发布变化，不另建事实源。 */
export interface OrderHoldEvents {
  readonly onOrderHoldSymbolsChanged: (
    listener: (event: OrderHoldSymbolsChangedEvent) => void,
  ) => Unsubscribe;
}

/** 启动/重建使用相同订单 API batch 种子化既有 hold owner。 */
export interface OrderHoldRecovery {
  readonly seedFromOrders: (orders: ReadonlyArray<OrderFact>) => void;
}
