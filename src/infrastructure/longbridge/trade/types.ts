import type { Order, OrderSide, OrderStatus, OrderType } from 'longbridge';

/** 已验证 SDK 订单方向，仅在 trade adapter 入站边界使用；Unknown 不可进入内部事实。 */
export type ValidatedOrderSide = OrderSide.Buy | OrderSide.Sell;

/** 明确支持的明确 SDK 生命周期成员，仅供 adapter 结构验证及 frozen V1 producer 使用。 */
export type ValidatedOrderStatus =
  | OrderStatus.NotReported
  | OrderStatus.ReplacedNotReported
  | OrderStatus.ProtectedNotReported
  | OrderStatus.VarietiesNotReported
  | OrderStatus.WaitToNew
  | OrderStatus.New
  | OrderStatus.WaitToReplace
  | OrderStatus.PendingReplace
  | OrderStatus.Replaced
  | OrderStatus.PartialFilled
  | OrderStatus.WaitToCancel
  | OrderStatus.PendingCancel
  | OrderStatus.Filled
  | OrderStatus.Rejected
  | OrderStatus.Canceled
  | OrderStatus.Expired
  | OrderStatus.PartialWithdrawal;

/** 明确支持的支持的 SDK 订单类型，仅供 adapter 入站验证使用；不向 application 透传枚举。 */
export type ValidatedOrderType =
  | OrderType.LO
  | OrderType.ELO
  | OrderType.MO
  | OrderType.AO
  | OrderType.ALO
  | OrderType.ODD
  | OrderType.LIT
  | OrderType.MIT
  | OrderType.TSLPAMT
  | OrderType.TSLPPCT
  | OrderType.TSMAMT
  | OrderType.TSMPCT
  | OrderType.SLO;
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
