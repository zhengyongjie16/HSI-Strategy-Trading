/** 已验证broker订单快照读取行为；原SDK实例/金融对象留在infra，非pure-data资格。 */
import type { OrderFact } from './trade.js';

/** history/today 的真实订单 batch 读取能力；返回中性已验证事实，不持有重建或 retry 策略。 */
export interface OrderSnapshotReadPort {
  readonly fetchSnapshots: () => Promise<
    Readonly<{
      historyOrders: ReadonlyArray<OrderFact>;
      todayOrders: ReadonlyArray<OrderFact>;
    }>
  >;
}
