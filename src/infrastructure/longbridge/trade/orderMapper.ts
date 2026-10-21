/** SDK 订单金融与时间边界：保真映射，不补价、不伪造金额、不持有第二订单账。 */
import type { OrderReadStatus, OrderReadType } from '../../../types/orderReadMetadata.js';
import { OrderSide, OrderStatus, OrderType, type PushOrderChanged } from 'longbridge';
import type { BrokerOrderSdkFields } from './types.js';
import type { OrderFact } from '../../../types/trade.js';
import { classifyBrokerOrderStatusLifecycle } from './orderValidation.js';
import { isHongKongSymbol } from '../../../utils/marketScope.js';
import {
  canonicalDecimal,
  exactCompare,
  exactMultiply,
  safeQuantityNumber,
} from '../../../utils/numeric/exact.js';

/** 查询与 push 共用原始身份/归属证据准入，不将坏 remark 变为普通订单或补造身份。 */
function assertBrokerOrderMetadata(
  order: Pick<BrokerOrderSdkFields, 'orderId' | 'symbol' | 'stockName' | 'remark'>,
): void {
  if (
    typeof order.orderId !== 'string' ||
    order.orderId.length === 0 ||
    typeof order.symbol !== 'string' ||
    order.symbol.length === 0 ||
    typeof order.stockName !== 'string' ||
    typeof order.remark !== 'string'
  ) {
    throw new TypeError('[orderMapper] invalid SDK order identity/provenance');
  }
}

/**
 * 验证 broker 时间；正成交观察采用订单级 updatedAt 代理，known 同量执行时间由共享 merge 保留。
 * @param value SDK 的明确时间字段
 * @param label 事实字段名
 * @returns 安全正整数毫秒
 */
function timestamp(value: Date, label: string): number {
  if (!(value instanceof Date) || !Number.isSafeInteger(value.getTime()) || value.getTime() <= 0) {
    throw new TypeError(`[orderMapper] invalid ${label}`);
  }

  return value.getTime();
}

/**
 * 验证并保留 SDK 原生金融字段负零；不使用配置 10+3 输入限制处理历史派生金额。
 * @param text SDK 金融原文
 * @returns 规范金融文本，原生负零仍为 -0
 */
function sdkFinancialText(text: string): string {
  const normalized = canonicalDecimal(text);
  return text.startsWith('-') && exactCompare(normalized, '0') === 0 ? '-0' : normalized;
}

/**
 * 将 SDK 累计金融字段转换为中性事实；成本依据为 SDK 均价原文×累计量，不经 number/显示舍入。
 * FILLED 必须有正累计量；所有正成交观察必须携带本次有效正价，首次映射即拒绝矛盾或缺价事实。
 * @param order SDK 查询订单，身份/归属证据在此共享边界再次校验
 * @returns 含订单级观察时间代理的完整内部订单观察
 */
export function mapBrokerOrder(order: BrokerOrderSdkFields): OrderFact {
  assertBrokerOrderMetadata(order);
  if (order.side !== OrderSide.Buy && order.side !== OrderSide.Sell) {
    throw new TypeError('[orderMapper] unknown SDK execution side');
  }

  const executionPhase = classifyBrokerOrderStatusLifecycle(order.status);

  const quantity = safeQuantityNumber(order.quantity.toString());
  const executedQuantity = safeQuantityNumber(order.executedQuantity.toString());
  if (order.status === OrderStatus.Filled && executedQuantity === 0) {
    throw new TypeError('[orderMapper] FILLED order requires positive cumulative execution quantity');
  }

  const executedPrice =
    order.executedPrice === null ? null : sdkFinancialText(order.executedPrice.toString());
  if (
    (executedPrice !== null && exactCompare(executedPrice, '0') < 0) ||
    executedQuantity > quantity
  ) {
    throw new TypeError('[orderMapper] invalid cumulative execution quantity/price');
  }

  let executedAmount = '0';
  if (executedQuantity > 0) {
    if (executedPrice === null || exactCompare(executedPrice, '0') <= 0) {
      throw new TypeError('[orderMapper] invalid cumulative execution quantity/price');
    }

    executedAmount = exactMultiply(executedPrice, String(executedQuantity));
  }

  const submittedAtMs = timestamp(order.submittedAt, 'submittedAt');
  if (order.updatedAt === null && executedQuantity > 0) {
    throw new TypeError('[orderMapper] executed order lacks independent broker revision');
  }

  let executionStatus: OrderFact['executionStatus'] = 'NONE';
  if (order.status === OrderStatus.Filled) executionStatus = 'FILLED';
  else if (order.status === OrderStatus.PartialFilled || executedQuantity > 0)
    executionStatus = 'PARTIAL';

  // 零成交初始订单的版本就是其提交事实；正成交必须有独立修订字段。
  const updatedAtMs =
    order.updatedAt === null ? submittedAtMs : timestamp(order.updatedAt, 'updatedAt');

  return {
    orderId: order.orderId,
    symbol: order.symbol,
    stockName: order.stockName,
    executionSide: mapBrokerOrderSide(order.side),
    executionStatus,
    executionPhase,
    status: mapBrokerOrderStatus(order.status),
    orderType: mapBrokerOrderType(order.orderType),
    remark: order.remark,
    price: order.price === null ? null : sdkFinancialText(order.price.toString()),
    quantity,
    executedPrice,
    executedQuantity,
    executedAmount,
    // 原始订单观察时间代理：正成交用订单自身 updatedAt，零成交显式未知。
    executionTimeMs: executedQuantity > 0 ? updatedAtMs : null,
    updatedAtMs,
    submittedAt: new Date(submittedAtMs),
    updatedAt: order.updatedAt === null ? null : new Date(timestamp(order.updatedAt, 'updatedAt')),
  };
}

/** SDK push 与 query 经同一保真边界映射；push 不做 execution IO，也不伪造执行时间。 */
export function mapBrokerOrderPush(event: PushOrderChanged): OrderFact | null {
  if (!isHongKongSymbol(event.symbol)) return null;

  return mapBrokerOrder({
    orderId: event.orderId,
    symbol: event.symbol,
    stockName: event.stockName,
    side: event.side,
    status: event.status,
    orderType: event.orderType,
    remark: event.remark,
    price: event.submittedPrice,
    quantity: event.submittedQuantity,
    executedPrice: event.executedPrice,
    executedQuantity: event.executedQuantity,
    submittedAt: event.submittedAt,
    updatedAt: event.updatedAt,
  });
}

/** 唯一SDK方向映射；无默认BUY/SELL，pending/经济观察共用同一事实边界。 */
export function mapBrokerOrderSide(value: OrderSide): 'BUY' | 'SELL' {
  if (value === OrderSide.Buy) return 'BUY';

  if (value === OrderSide.Sell) return 'SELL';

  throw new TypeError('[orderMapper] unknown SDK execution side');
}

/** 唯一SDK元数据映射，保详细在途/终态意义，不把状态/类型数值返回域。 */
export function mapBrokerOrderStatus(value: OrderStatus): OrderReadStatus {
  switch (value) {
    case OrderStatus.Unknown: {
      throw new TypeError('[orderMapper] unknown SDK order status');
    }

    case OrderStatus.NotReported: {
      return 'UNREPORTED';
    }

    case OrderStatus.ReplacedNotReported: {
      return 'REPLACEMENT_UNREPORTED';
    }

    case OrderStatus.ProtectedNotReported: {
      return 'PROTECTION_UNREPORTED';
    }

    case OrderStatus.VarietiesNotReported: {
      return 'CONDITIONAL_UNREPORTED';
    }

    case OrderStatus.Filled: {
      return 'FILLED';
    }

    case OrderStatus.WaitToNew: {
      return 'SUBMISSION_PENDING';
    }

    case OrderStatus.New: {
      return 'WORKING';
    }

    case OrderStatus.WaitToReplace: {
      return 'REPLACEMENT_REQUESTED';
    }

    case OrderStatus.PendingReplace: {
      return 'REPLACEMENT_PENDING';
    }

    case OrderStatus.Replaced: {
      return 'REPLACED';
    }

    case OrderStatus.PartialFilled: {
      return 'PARTIALLY_FILLED';
    }

    case OrderStatus.WaitToCancel: {
      return 'CANCELLATION_REQUESTED';
    }

    case OrderStatus.PendingCancel: {
      return 'CANCELLATION_PENDING';
    }

    case OrderStatus.Rejected: {
      return 'REJECTED';
    }

    case OrderStatus.Canceled: {
      return 'CANCELED';
    }

    case OrderStatus.Expired: {
      return 'EXPIRED';
    }

    case OrderStatus.PartialWithdrawal: {
      return 'PARTIALLY_CANCELED';
    }

    default: {
      throw new TypeError('[orderMapper] unknown SDK order status');
    }
  }
}

/** 保留全部订单种类；Unknown仅保UNSPECIFIED元数据，不构造价格或执行phase。 */
export function mapBrokerOrderType(value: OrderType): OrderReadType {
  switch (value) {
    case OrderType.Unknown: {
      return 'UNSPECIFIED';
    }

    case OrderType.LO: {
      return 'LO';
    }

    case OrderType.ELO: {
      return 'ELO';
    }

    case OrderType.MO: {
      return 'MO';
    }

    case OrderType.AO: {
      return 'AO';
    }

    case OrderType.ALO: {
      return 'ALO';
    }

    case OrderType.ODD: {
      return 'ODD';
    }

    case OrderType.LIT: {
      return 'LIT';
    }

    case OrderType.MIT: {
      return 'MIT';
    }

    case OrderType.TSLPAMT: {
      return 'TSLPAMT';
    }

    case OrderType.TSLPPCT: {
      return 'TSLPPCT';
    }

    case OrderType.TSMAMT: {
      return 'TSMAMT';
    }

    case OrderType.TSMPCT: {
      return 'TSMPCT';
    }

    case OrderType.SLO: {
      return 'SLO';
    }

    default: {
      throw new TypeError('[orderMapper] unknown SDK order type');
    }
  }
}
