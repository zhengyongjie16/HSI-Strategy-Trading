/**
 * OrderStatus 生命周期分类测试
 *
 * 覆盖 SDK 当前全部状态的 OPEN / TERMINAL 穷尽分类，以及未知状态 fail-fast。
 */
import { describe, expect, it } from 'bun:test';
import { OrderStatus } from 'longbridge';
import { classifyOrderStatusLifecycle } from '../../src/core/orderStatusLifecycle/index.js';
import { isOpenOrderStatus } from '../../src/core/orderStatusLifecycle/utils.js';

describe('OrderStatus 生命周期分类', () => {
  const openStatuses: OrderStatus[] = [
    OrderStatus.NotReported,
    OrderStatus.ReplacedNotReported,
    OrderStatus.ProtectedNotReported,
    OrderStatus.VarietiesNotReported,
    OrderStatus.WaitToNew,
    OrderStatus.New,
    OrderStatus.WaitToReplace,
    OrderStatus.PendingReplace,
    OrderStatus.Replaced,
    OrderStatus.PartialFilled,
    OrderStatus.WaitToCancel,
    OrderStatus.PendingCancel,
  ];
  const terminalStatuses: OrderStatus[] = [
    OrderStatus.Filled,
    OrderStatus.Rejected,
    OrderStatus.Canceled,
    OrderStatus.Expired,
    OrderStatus.PartialWithdrawal,
  ];

  it.each(openStatuses)('将 SDK 开放状态 %s 分类为 OPEN', (status) => {
    expect(classifyOrderStatusLifecycle(status)).toBe('OPEN');
    expect(isOpenOrderStatus(status)).toBe(true);
  });

  it.each(terminalStatuses)('将 SDK 终态 %s 分类为 TERMINAL', (status) => {
    expect(classifyOrderStatusLifecycle(status)).toBe('TERMINAL');
    expect(isOpenOrderStatus(status)).toBe(false);
  });

  it('对 SDK Unknown 和未来未识别数值 fail-fast', () => {
    expect(() => classifyOrderStatusLifecycle(OrderStatus.Unknown)).toThrow(/未知订单状态/);
    expect(() => classifyOrderStatusLifecycle(999 as OrderStatus)).toThrow(/未知订单状态/);
  });
});
