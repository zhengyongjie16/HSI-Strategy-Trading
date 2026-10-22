/**
 * OrderStatus 生命周期分类测试
 *
 * 覆盖本系统明确支持状态的 OPEN / TERMINAL 分类，以及延迟单、未知状态的拒绝政策。
 */
import { describe, expect, it } from 'bun:test';
import { OrderStatus } from 'longbridge';
import {
  classifyBrokerOrderStatusLifecycle,
  isValidatedOrderStatus,
} from '../../../../src/infrastructure/longbridge/trade/orderValidation.js';

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
    expect(classifyBrokerOrderStatusLifecycle(status)).toBe('OPEN');
    expect(isValidatedOrderStatus(status)).toBe(true);
  });

  it.each(terminalStatuses)('将 SDK 终态 %s 分类为 TERMINAL', (status) => {
    expect(classifyBrokerOrderStatusLifecycle(status)).toBe('TERMINAL');
    expect(isValidatedOrderStatus(status)).toBe(true);
  });

  it('拒绝未支持的延迟单状态，不将其归为 OPEN', () => {
    expect(isValidatedOrderStatus(OrderStatus.DelayedNotReported)).toBe(false);
    expect(() => classifyBrokerOrderStatusLifecycle(OrderStatus.DelayedNotReported)).toThrow(
      /未知订单状态/,
    );
  });

  it('对 SDK Unknown 和未来未识别数值 fail-fast', () => {
    expect(() => classifyBrokerOrderStatusLifecycle(OrderStatus.Unknown)).toThrow(/未知订单状态/);
    expect(() => classifyBrokerOrderStatusLifecycle(999 as OrderStatus)).toThrow(/未知订单状态/);
    expect(isValidatedOrderStatus(OrderStatus.Unknown)).toBe(false);
    expect(isValidatedOrderStatus(999)).toBe(false);
  });
});
