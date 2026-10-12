/** SDK 状态映射观察：原生枚举与私有 mapper 留在 infra，跨 owner 分类测试只接收中性结果和独立预期。 */
import { OrderStatus } from 'longbridge';
import { mapBrokerOrderStatus } from '../../../../src/infrastructure/longbridge/trade/orderMapper.js';
import type { OrderReadStatus } from '../../../../src/types/orderReadMetadata.js';

/** 覆盖全部真实 native 状态，不把待测映射结果用作 expected metadata。 */
export function observeNativeOrderReadStatuses(): ReadonlyArray<{
  readonly status: OrderReadStatus;
  readonly expectedStatus: OrderReadStatus;
  readonly expectedOpen: boolean;
}> {
  const states: ReadonlyArray<readonly [OrderStatus, OrderReadStatus, boolean]> = [
    [OrderStatus.NotReported, 'UNREPORTED', true],
    [OrderStatus.ReplacedNotReported, 'REPLACEMENT_UNREPORTED', true],
    [OrderStatus.ProtectedNotReported, 'PROTECTION_UNREPORTED', true],
    [OrderStatus.VarietiesNotReported, 'CONDITIONAL_UNREPORTED', true],
    [OrderStatus.WaitToNew, 'SUBMISSION_PENDING', true],
    [OrderStatus.New, 'WORKING', true],
    [OrderStatus.WaitToReplace, 'REPLACEMENT_REQUESTED', true],
    [OrderStatus.PendingReplace, 'REPLACEMENT_PENDING', true],
    [OrderStatus.Replaced, 'REPLACED', true],
    [OrderStatus.PartialFilled, 'PARTIALLY_FILLED', true],
    [OrderStatus.WaitToCancel, 'CANCELLATION_REQUESTED', true],
    [OrderStatus.PendingCancel, 'CANCELLATION_PENDING', true],
    [OrderStatus.Filled, 'FILLED', false],
    [OrderStatus.Rejected, 'REJECTED', false],
    [OrderStatus.Canceled, 'CANCELED', false],
    [OrderStatus.Expired, 'EXPIRED', false],
    [OrderStatus.PartialWithdrawal, 'PARTIALLY_CANCELED', false],
  ];
  return states.map(([native, expectedStatus, expectedOpen]) => ({
    status: mapBrokerOrderStatus(native),
    expectedStatus,
    expectedOpen,
  }));
}
