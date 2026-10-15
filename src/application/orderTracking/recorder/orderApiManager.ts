/** 订单快照owner：原history/today去重，SDK读取/解析仅在注入infra IO edge。 */

import { mergeAndDeduplicateOrders } from '../../../domain/order/orderSnapshotPolicy.js';
import type { OrderAPIManager, OrderAPIManagerDeps } from './types.js';

/** 原快照合并入口，不改变today优先/同source更新版本选择。 */
export function createOrderAPIManager(deps: OrderAPIManagerDeps): OrderAPIManager {
  return {
    fetchAllOrdersFromAPI: async () => {
      const { historyOrders, todayOrders } = await deps.orderSnapshotReadPort.fetchSnapshots();
      return [...mergeAndDeduplicateOrders(historyOrders, todayOrders)];
    },
  };
}
