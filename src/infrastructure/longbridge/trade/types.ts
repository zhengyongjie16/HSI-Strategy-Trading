import type { Order } from 'longbridge';
import type { PendingOrder } from '../../../types/services.js';

/** 今日挂单SDK映射能力，只返回cache实际消费的保真文本及安全数量事实。 */
export interface PendingOrdersAdapter {
  readonly todayOrders: () => Promise<ReadonlyArray<PendingOrder>>;
}

/** SDK Order/OrderDetail 共有观察字段，只在 adapter 内使用；金融文本和安全数量在 mapper 校验。 */
export type BrokerOrderSdkFields = Pick<
  Order,
  | 'orderId'
  | 'symbol'
  | 'stockName'
  | 'side'
  | 'status'
  | 'orderType'
  | 'remark'
  | 'price'
  | 'quantity'
  | 'executedPrice'
  | 'executedQuantity'
  | 'submittedAt'
  | 'updatedAt'
>;
