/** infra 中性映射观察→真实 lifecycle classifier；纯 side/kind/unknown mapper oracle 位于 tests/infrastructure/longbridge/trade/orderReadMetadata.test.ts。 */
import { expect, test } from 'bun:test';
import { observeNativeOrderReadStatuses } from '../../../infrastructure/longbridge/trade/orderReadMetadataFixture.js';
import {
  isOpenOrderReadStatus,
  isTerminalOrderReadStatus,
  orderReadStatusPriority,
} from '../../../../src/core/trader/orderMonitor/orderReadLifecycle.js';
import {
  NON_REPLACEABLE_READ_STATUSES,
  NON_REPLACEABLE_READ_TYPES,
  classifyOrderReadLifecycle,
} from '../../../../src/constants/orderReadMetadata.js';

test('native metadata maps once to actual neutral detailed states and preserves open/terminal/replace action distinctions', () => {
  const observations = observeNativeOrderReadStatuses();
  expect(observations).toHaveLength(17);
  for (const { status, expectedStatus, expectedOpen } of observations) {
    expect(status).toBe(expectedStatus);
    expect(isOpenOrderReadStatus(status)).toBe(expectedOpen);
    expect(isTerminalOrderReadStatus(status)).toBe(!expectedOpen);
    expect(classifyOrderReadLifecycle(status)).toBe(expectedOpen ? 'OPEN' : 'TERMINAL');
  }

  expect(() => isOpenOrderReadStatus('UNCONFIRMED')).toThrow();
  expect(() => classifyOrderReadLifecycle('UNCONFIRMED')).toThrow();
  expect(orderReadStatusPriority('CANCELLATION_PENDING')).toBeGreaterThan(
    orderReadStatusPriority('CANCELLATION_REQUESTED'),
  );

  expect(orderReadStatusPriority('CONDITIONAL_UNREPORTED')).toBeGreaterThan(
    orderReadStatusPriority('UNREPORTED'),
  );

  expect([...NON_REPLACEABLE_READ_STATUSES]).toEqual([
    'REPLACEMENT_REQUESTED',
    'REPLACEMENT_PENDING',
    'CANCELLATION_REQUESTED',
    'CANCELLATION_PENDING',
  ]);
  expect([...NON_REPLACEABLE_READ_TYPES]).toEqual(['MO']);
});
