/**
 * OrderStatus 生命周期分类模块
 *
 * 职责：以单一穷尽规则把 Longbridge SDK 订单状态划分为 OPEN / TERMINAL，
 * 所有订单恢复、缓存、监控和记录链路都必须通过这里识别生命周期。
 */
import type { OrderStatus } from 'longbridge';
import { ORDER_STATUS_LIFECYCLE_MAP } from '../../constants/index.js';
import type { OrderStatusLifecycle } from './types.js';

/**
 * 穷尽分类 SDK 订单状态；Unknown 与未来新增状态必须显式暴露，禁止静默跳过。
 *
 * @param status SDK 订单状态
 * @returns OPEN 或 TERMINAL
 */
export function classifyOrderStatusLifecycle(status: OrderStatus): OrderStatusLifecycle {
  const lifecycleMap: ReadonlyMap<number, OrderStatusLifecycle> = ORDER_STATUS_LIFECYCLE_MAP;
  const lifecycle = lifecycleMap.get(status);
  if (lifecycle === undefined) {
    throw new Error(`[订单生命周期] 未知订单状态: ${String(status)}`);
  }

  return lifecycle;
}
