/** SDK 订单入站验证：保留原批准成员及生命周期真值表，不向业务层暴露 SDK 枚举。 */
import { OrderSide, OrderStatus, OrderType } from 'longbridge';
import type { ValidatedOrderSide, ValidatedOrderStatus, ValidatedOrderType } from './types.js';

/** todayOrders 原明确方向成员；Unknown 必须在边界拒绝。 */
const validOrderSides: ReadonlySet<number> = new Set([OrderSide.Buy, OrderSide.Sell]);

/** 原查询边界支持的订单类型；不得把 Unknown 转成合法默认类型。 */
const validOrderTypes: ReadonlySet<number> = new Set([
  OrderType.LO,
  OrderType.ELO,
  OrderType.MO,
  OrderType.AO,
  OrderType.ALO,
  OrderType.ODD,
  OrderType.LIT,
  OrderType.MIT,
  OrderType.TSLPAMT,
  OrderType.TSLPPCT,
  OrderType.TSMAMT,
  OrderType.TSMPCT,
  OrderType.SLO,
]);

/** 本系统明确支持的生命周期真值表；未批准状态（含延迟单）拒绝，SDK 数值只存在 adapter 内。 */
const orderStatusLifecycles: ReadonlyMap<number, 'OPEN' | 'TERMINAL'> = new Map([
  [OrderStatus.NotReported, 'OPEN'],
  [OrderStatus.ReplacedNotReported, 'OPEN'],
  [OrderStatus.ProtectedNotReported, 'OPEN'],
  [OrderStatus.VarietiesNotReported, 'OPEN'],
  [OrderStatus.WaitToNew, 'OPEN'],
  [OrderStatus.New, 'OPEN'],
  [OrderStatus.WaitToReplace, 'OPEN'],
  [OrderStatus.PendingReplace, 'OPEN'],
  [OrderStatus.Replaced, 'OPEN'],
  [OrderStatus.PartialFilled, 'OPEN'],
  [OrderStatus.WaitToCancel, 'OPEN'],
  [OrderStatus.PendingCancel, 'OPEN'],
  [OrderStatus.Filled, 'TERMINAL'],
  [OrderStatus.Rejected, 'TERMINAL'],
  [OrderStatus.Canceled, 'TERMINAL'],
  [OrderStatus.Expired, 'TERMINAL'],
  [OrderStatus.PartialWithdrawal, 'TERMINAL'],
]);

/** 收窄原批准 SDK 方向成员；缺失、Unknown 和未来未识别成员均拒绝。 */
export function isValidatedOrderSide(value: unknown): value is ValidatedOrderSide {
  return typeof value === 'number' && validOrderSides.has(value);
}

/** 收窄原批准 SDK 生命周期成员，不因终态缺少经济事实而补造数量或时间。 */
export function isValidatedOrderStatus(value: unknown): value is ValidatedOrderStatus {
  return typeof value === 'number' && orderStatusLifecycles.has(value);
}

/** 收窄原批准 SDK 订单类型，pending 与 snapshot 共用同一准入规则。 */
export function isValidatedOrderType(value: unknown): value is ValidatedOrderType {
  return typeof value === 'number' && validOrderTypes.has(value);
}

/** SDK lifecycle 只在 mapper 入站使用；未知状态 fail-fast。 */
export function classifyBrokerOrderStatusLifecycle(status: OrderStatus): 'OPEN' | 'TERMINAL' {
  const lifecycle = orderStatusLifecycles.get(status);
  if (lifecycle === undefined) {
    throw new TypeError(`[订单生命周期] 未知订单状态: ${String(status)}`);
  }

  return lifecycle;
}
