/**
 * 订单成交审计具名 listener。
 * 仅负责订阅路由及同步 fatal+rethrow；订阅时点和唯一 cleanup 登记由 app 保持原顺序。
 */
import type { Unsubscribe } from '../../types/events.js';
import type { OrderStateChangedEvent } from '../../types/orderTracking.js';
import type { OrderTradeAuditListenerDeps } from './types.js';

/**
 * 立即订阅唯一 tracking 的结算事件，返回原始 unsubscribe，不提前停订或另建事件队列。
 * @param deps 唯一订单事件源、同步审计用例、每事件当前时间与 fatal 上报能力
 * @returns 由 app 在 UNSUBSCRIBE_TRADER_LISTENER 阶段执行的原始取消订阅函数
 */
export function createOrderTradeAuditListener(deps: OrderTradeAuditListenerDeps): Unsubscribe {
  function auditOrderStateChanged(event: OrderStateChangedEvent): void {
    try {
      deps.audit(event, deps.now());
    } catch (error) {
      deps.reportFatalError(error);
      throw error;
    }
  }

  return deps.onOrderStateChanged(auditOrderStateChanged);
}
