import { classifyOrderReadLifecycle } from '../../../constants/orderReadMetadata.js';

/** 原订单在途/终态判定的中性元数据版本；只读真实映射状态，不产生经济phase/T/revision。 */
import type { OrderReadStatus } from '../../../types/orderReadMetadata.js';

export function isOpenOrderReadStatus(status: OrderReadStatus): boolean {
  return classifyOrderReadLifecycle(status) === 'OPEN';
}

export function isTerminalOrderReadStatus(status: OrderReadStatus): boolean {
  return classifyOrderReadLifecycle(status) === 'TERMINAL';
}

/** 保原同revision/量状态比较优先次序，不把优先序当order revision或execution T。 */
export function orderReadStatusPriority(status: OrderReadStatus): number {
  return [
    'UNCONFIRMED',
    'UNREPORTED',
    'REPLACEMENT_UNREPORTED',
    'PROTECTION_UNREPORTED',
    'CONDITIONAL_UNREPORTED',
    'FILLED',
    'SUBMISSION_PENDING',
    'WORKING',
    'REPLACEMENT_REQUESTED',
    'REPLACEMENT_PENDING',
    'REPLACED',
    'PARTIALLY_FILLED',
    'CANCELLATION_REQUESTED',
    'CANCELLATION_PENDING',
    'REJECTED',
    'CANCELED',
    'EXPIRED',
    'PARTIALLY_CANCELED',
  ].indexOf(status);
}
