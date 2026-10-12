/** 中性快照 port→真实 core 去重；SDK DTO/context 与 mapper 装配由专用 infra fixture 持有。 */
import { expect, test } from 'bun:test';
import { createOrderAPIManager } from '../../../../src/core/orderRecorder/orderApiManager.js';
import { createNativeSnapshotReadFixture } from '../../../infrastructure/longbridge/trade/orderSnapshotReadFixture.js';
import { orderEconomics } from '../../../../src/domain/order/orderEconomics.js';

test('real snapshot IO preserves limiter/four native reads and original today priority/same-source revision selection', async () => {
  const fixture = createNativeSnapshotReadFixture(orderEconomics);
  const api = createOrderAPIManager({ orderSnapshotReadPort: fixture.port });
  const result = await api.fetchAllOrdersFromAPI();
  expect(fixture.calls).toEqual([
    'throttle',
    'historyOrders',
    'throttle',
    'todayOrders',
    'throttle',
    'historyExecutions',
    'throttle',
    'todayExecutions',
  ]);
  expect(result).toHaveLength(2);
  expect(result.find((row) => row.orderId === 'DUP')).toMatchObject({
    updatedAtMs: 250,
    executionSide: 'BUY',
    executionPhase: 'OPEN',
    price: '1.000000000000000001',
  });
});

test('bad returned native structure fails before later reads, and issued getter/internal failure preserves original identity', async () => {
  const cause = new RangeError('native history getter');
  const fixture = createNativeSnapshotReadFixture(orderEconomics, cause);
  const api = createOrderAPIManager({ orderSnapshotReadPort: fixture.port });
  const result = await api.fetchAllOrdersFromAPI().catch((error: unknown) => error);
  expect(result).toBe(cause);
  expect(fixture.getLaterReadCount()).toBe(0);
  expect(fixture.calls).toEqual(['throttle', 'historyOrders']);
});
