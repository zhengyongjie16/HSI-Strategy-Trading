import type { OrderFact } from './trade.js';

/**
 * 同一 context 的全量订单读取能力；由 adapter 完成来源唯一性校验与 today 整条覆盖。
 * 仅返回最终获选且严格映射的 HK 订单事实，SDK 实例及金融对象不离开 infrastructure。
 */
export interface OrderSnapshotReadPort {
  readonly fetchAllOrders: () => Promise<ReadonlyArray<OrderFact>>;
}
