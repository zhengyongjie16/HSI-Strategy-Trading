import type { OrderReadStatus, OrderReadType } from '../types/orderReadMetadata.js';

export const OPEN_ORDER_READ_STATUSES: ReadonlySet<OrderReadStatus> = new Set([
  'UNREPORTED',
  'REPLACEMENT_UNREPORTED',
  'PROTECTION_UNREPORTED',
  'CONDITIONAL_UNREPORTED',
  'SUBMISSION_PENDING',
  'WORKING',
  'REPLACEMENT_REQUESTED',
  'REPLACEMENT_PENDING',
  'REPLACED',
  'PARTIALLY_FILLED',
  'CANCELLATION_REQUESTED',
  'CANCELLATION_PENDING',
]);
export const TERMINAL_ORDER_READ_STATUSES: ReadonlySet<OrderReadStatus> = new Set([
  'FILLED',
  'REJECTED',
  'CANCELED',
  'EXPIRED',
  'PARTIALLY_CANCELED',
]);

/** 唯一已验证详细状态集合；未知不伪造为OPEN或非pending。 */
export const ORDER_READ_STATUS_VALUES: ReadonlySet<OrderReadStatus> = new Set([
  ...OPEN_ORDER_READ_STATUSES,
  ...TERMINAL_ORDER_READ_STATUSES,
]);

/** 只分类业务操作生命周期，不产生经济execution phase/T/revision。 */
export function classifyOrderReadLifecycle(status: OrderReadStatus): 'OPEN' | 'TERMINAL' {
  if (OPEN_ORDER_READ_STATUSES.has(status)) return 'OPEN';

  if (TERMINAL_ORDER_READ_STATUSES.has(status)) return 'TERMINAL';

  throw new Error(`[订单生命周期] 无法分类中性订单状态: ${status}`);
}

/** services/core共享的真实中性pending判定；unknown保持failfast。 */
export function isOpenOrderReadStatus(status: OrderReadStatus): boolean {
  return classifyOrderReadLifecycle(status) === 'OPEN';
}

export const ORDER_READ_TYPE_VALUES: ReadonlySet<OrderReadType> = new Set([
  'UNSPECIFIED',
  'LO',
  'ELO',
  'MO',
  'AO',
  'ALO',
  'ODD',
  'LIT',
  'MIT',
  'TSLPAMT',
  'TSLPPCT',
  'TSMAMT',
  'TSMPCT',
  'SLO',
]);

/** 原不可改单原因：保改单/撤单四种在途状态及真正市价单。 */
export const NON_REPLACEABLE_READ_STATUSES: ReadonlySet<OrderReadStatus> = new Set([
  'REPLACEMENT_REQUESTED',
  'REPLACEMENT_PENDING',
  'CANCELLATION_REQUESTED',
  'CANCELLATION_PENDING',
]);
export const NON_REPLACEABLE_READ_TYPES: ReadonlySet<OrderReadType> = new Set(['MO']);
