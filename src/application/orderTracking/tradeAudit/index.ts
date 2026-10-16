/**
 * 订单状态事件的同步成交审计用例。
 * 过滤不完整成交上下文，保留原金额文本、数量和终态 reason，调用唯一 mixed trade log 仓储。
 * 本用例不判定或提交 protective completion，也不持有第二订单账或 readiness。
 */
import type { OrderStateChangedEvent } from '../../../types/orderTracking.js';
import type { PersistableTradeRecord } from '../../../types/tradeLog.js';
import { exactCompare } from '../../../utils/numeric/exact.js';
import type {
  OrderTradeAudit,
  OrderTradeAuditDeps,
  PersistableTradeExecutionEvent,
} from './types.js';

/** 保留原成交上下文过滤顺序；非法内部金融文本直接暴露，不降级为缺失成交。 */
function hasPersistableTradeExecutionContext(
  event: OrderStateChangedEvent,
): event is PersistableTradeExecutionEvent {
  return (
    event.symbol !== null &&
    event.side !== null &&
    event.isLongSymbol !== null &&
    event.executedPrice !== null &&
    exactCompare(event.executedPrice, '0') > 0 &&
    event.executedQuantity !== null &&
    Number.isSafeInteger(event.executedQuantity) &&
    event.executedQuantity > 0 &&
    event.executedTimeMs !== null &&
    Number.isSafeInteger(event.executedTimeMs) &&
    event.executedTimeMs > 0
  );
}

function resolveTradeAction(
  event: PersistableTradeExecutionEvent,
): 'BUYCALL' | 'BUYPUT' | 'SELLCALL' | 'SELLPUT' {
  if (event.side === 'BUY') {
    return event.isLongSymbol ? 'BUYCALL' : 'BUYPUT';
  }

  return event.isLongSymbol ? 'SELLCALL' : 'SELLPUT';
}

/** 构造普通成交审计；只有完整成交上下文才验证 monitor 身份，保持原过滤与错误优先级。 */
function resolveTradeRecordFromOrderStateChangedEvent(
  event: OrderStateChangedEvent,
  recordedAt: Date,
  deps: OrderTradeAuditDeps,
): PersistableTradeRecord | null {
  if (!hasPersistableTradeExecutionContext(event)) {
    return null;
  }

  if (event.monitorSymbol !== deps.expectedMonitorSymbol) {
    throw new Error(
      `[OrderTradeAudit] order event monitorSymbol mismatch: expected=${deps.expectedMonitorSymbol} actual=${event.monitorSymbol}`,
    );
  }

  return {
    orderId: event.orderId,
    symbol: event.symbol,
    symbolName: null,
    monitorSymbol: event.monitorSymbol,
    action: resolveTradeAction(event),
    side: event.side,
    quantity: String(event.executedQuantity),
    price: event.executedPrice,
    orderType: null,
    status: 'FILLED',
    error: null,
    reason: event.status === 'FILLED' ? null : event.status,
    signalTriggerTime: null,
    executedAt: deps.toHongKongTimeIso(new Date(event.executedTimeMs)),
    executedAtMs: event.executedTimeMs,
    timestamp: deps.toHongKongTimeIso(recordedAt),
    isProtectiveClearance: event.isProtectiveLiquidation,
  };
}

/**
 * 创建同步订单成交审计用例。
 * append 必须在事件调用栈内完成；构造或持久化失败原样抛出，由 listener 上报 fatal 后重抛。
 * @param deps 当前 monitor 身份、唯一仓储同步追加能力与时间格式化能力
 * @returns 同步事件处理函数；每次调用明确交付本事件记录时间，不读取隐藏当前时间
 */
export function createOrderTradeAudit(deps: OrderTradeAuditDeps): OrderTradeAudit {
  return function persistTradeRecordFromOrderStateChangedEvent(event, recordedAt): void {
    const tradeRecord = resolveTradeRecordFromOrderStateChangedEvent(event, recordedAt, deps);
    if (tradeRecord !== null) {
      deps.appendTradeRecord(tradeRecord);
    }
  };
}
