import type { OrderStatus } from 'longbridge';
import { classifyOrderStatusLifecycle } from './index.js';

/**
 * 判断订单是否仍处于开放生命周期；未知状态直接抛错。
 *
 * @param status SDK 订单状态
 * @returns true 表示订单仍处于开放生命周期
 */
export function isOpenOrderStatus(status: OrderStatus): boolean {
  return classifyOrderStatusLifecycle(status) === 'OPEN';
}

/**
 * 判断订单是否已进入终态；未知状态直接抛错。
 *
 * @param status SDK 订单状态
 * @returns true 表示订单已进入终态
 */
export function isTerminalOrderStatus(status: OrderStatus): boolean {
  return classifyOrderStatusLifecycle(status) === 'TERMINAL';
}
