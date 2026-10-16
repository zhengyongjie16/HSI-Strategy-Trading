import type { OrderStateChangedEvent } from '../../../types/orderTracking.js';
import type { MixedTradeLogRepository } from '../../../types/tradeLog.js';

/** 订单审计的完整成交上下文；仅由本用例按原过滤条件收窄，不补造缺失事实。 */
export type PersistableTradeExecutionEvent = OrderStateChangedEvent & {
  readonly symbol: string;
  readonly side: 'BUY' | 'SELL';
  readonly isLongSymbol: boolean;
  readonly executedPrice: string;
  readonly executedQuantity: number;
  readonly executedTimeMs: number;
};

/** 同步普通成交审计用例；消费唯一 tracking 结算事件与本事件记录时点，不持有时钟/账本/完成状态。 */
export type OrderTradeAudit = (event: OrderStateChangedEvent, recordedAt: Date) => void;

/** 订单审计依赖；仓储使用既有同步追加，格式化只消费调用方明确交付的 Date，不获取隐藏时钟。 */
export interface OrderTradeAuditDeps {
  readonly expectedMonitorSymbol: string;
  readonly appendTradeRecord: MixedTradeLogRepository['appendTradeRecord'];
  readonly toHongKongTimeIso: (date: Date) => string;
}
