import type { OrderTradeAudit } from '../../application/orderTracking/tradeAudit/types.js';
import type { OrderTrackingEvents } from '../../types/orderTracking.js';
import type { RuntimeClock, RuntimeTermination } from '../../types/runtime.js';

/** 订单成交审计 listener 的窄依赖；不持有 trader、账本、cleanup 或完整 termination 对象。 */
export interface OrderTradeAuditListenerDeps {
  readonly onOrderStateChanged: OrderTrackingEvents['onOrderStateChanged'];
  readonly audit: OrderTradeAudit;
  readonly now: RuntimeClock['now'];
  readonly reportFatalError: RuntimeTermination['reportFatalError'];
}
