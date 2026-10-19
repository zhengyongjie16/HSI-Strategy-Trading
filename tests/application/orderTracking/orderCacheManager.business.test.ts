import { wrapExternalApiRequest } from '../../../src/infrastructure/externalApi/index.js';
import { createLoggerDouble, createRateLimiterDouble } from '../../helpers/testDoubles.js';

/**
 * orderCacheManager 业务测试：同ctx真实pending adapter/cache；保精确文本与注入时钟TTL。
 */

import { describe, expect, it } from 'bun:test';

import type { BrokerIngressInput } from '../../infrastructure/longbridge/trade/brokerIngressFixture.js';
import { createBrokerIngressFixture } from '../../integration/architectureRefactoringP1Native/trade/brokerIngressFixture.js';

const TEST_NOW = (): Date => new Date('2026-04-10T01:00:00.000Z');
function frame(overrides: Partial<BrokerIngressInput> = {}): BrokerIngressInput {
  return {
    orderId: 'order-1',
    tradeId: 'CACHE-T',
    symbol: 'BULL.HK',
    stockName: 'BULL',
    remark: '',
    side: 'BUY',
    status: 'New',
    orderType: 'ELO',
    quantity: '1000',
    executedQuantity: '0',
    submittedPrice: '1.23',
    executedPrice: '0',
    submittedAtMs: 1775782800000,
    executionTimeMs: null,
    updatedAtMs: 1775782800000,
    ...overrides,
  };
}

async function createActors(orders: ReadonlyArray<BrokerIngressInput>, now = TEST_NOW) {
  const fixture = await createBrokerIngressFixture(frame());
  fixture.setOrderSnapshotReplies([], orders);
  let throttles = 0;
  const cache = fixture.createCacheManager({
    logger: createLoggerDouble(),
    requestExternalApi: wrapExternalApiRequest,
    rateLimiter: createRateLimiterDouble({
      onThrottle: () => {
        throttles++;
      },
    }),
    now,
  });
  return { fixture, cache, throttleCount: () => throttles };
}

async function assertRejected(actors: Awaited<ReturnType<typeof createActors>>) {
  expect(actors.fixture.orderSnapshotReadCounts().today).toBe(0);
  const failure = await actors.cache.getPendingOrders().catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(TypeError);
  expect(actors.fixture.orderSnapshotReadCounts().today).toBe(1);
  expect(actors.fixture.nativeMutations()).toEqual([]);
}

describe('orderCacheManager business flow', () => {
  it('returns pending orders from valid SDK todayOrders payload', async () => {
    const actors = await createActors([frame()]);
    const orders = await actors.cache.getPendingOrders();
    expect(orders).toEqual([
      {
        orderId: 'order-1',
        symbol: 'BULL.HK',
        side: 'BUY',
        submittedPrice: '1.23',
        quantity: 1000,
        status: 'WORKING',
        orderType: 'ELO',
      },
    ]);
    expect(actors.fixture.orderSnapshotReadCounts().today).toBe(1);
  });

  it('preserves original SDK price text beyond JavaScript numeric precision', async () => {
    const price = '9007199254740993.125';
    const { cache } = await createActors([
      frame({ orderId: 'precise-order', submittedPrice: price, quantity: '100' }),
    ]);
    const orders = await cache.getPendingOrders();
    expect(orders[0]?.submittedPrice).toBe(price);
  });

  it('preserves nullable price for a valid pending market order', async () => {
    const actors = await createActors([frame({ orderId: 'market-order-1', orderType: 'MO' })]);
    actors.fixture.setOrderSnapshotSubmittedPriceNull('market-order-1');
    const orders = await actors.cache.getPendingOrders();
    expect(orders[0]?.submittedPrice).toBeNull();
    expect(orders[0]?.orderType).toBe('MO');
  });

  it('fails fast when todayOrders contains an invalid order item', async () => {
    const actors = await createActors([frame(), frame({ orderId: 'broken-order' })]);
    actors.fixture.setPendingOrderMetadataInvalid('broken-order', 'side', 'MISSING');
    await assertRejected(actors);
  });

  it('fails fast when todayOrders item has non-finite numeric payload', async () => {
    const actors = await createActors([frame({ orderId: 'broken-order' })]);
    actors.fixture.setOrderSnapshotPriceMalformed('broken-order');
    await assertRejected(actors);
  });

  for (const testCase of [
    { field: 'side', kind: 'NON_MEMBER', invalidKind: 'non-member' },
    { field: 'status', kind: 'NON_MEMBER', invalidKind: 'non-member' },
    { field: 'orderType', kind: 'NON_MEMBER', invalidKind: 'non-member' },
    { field: 'side', kind: 'UNKNOWN', invalidKind: 'Unknown' },
    { field: 'status', kind: 'UNKNOWN', invalidKind: 'Unknown' },
    { field: 'orderType', kind: 'UNKNOWN', invalidKind: 'Unknown' },
  ] as const) {
    it(`fails fast when todayOrders item has invalid ${testCase.field} ${testCase.invalidKind} value`, async () => {
      const actors = await createActors([frame({ orderId: 'broken-order' })]);
      actors.fixture.setPendingOrderMetadataInvalid('broken-order', testCase.field, testCase.kind);
      await assertRejected(actors);
    });
  }

  it('accepts less common valid side, status, and orderType enum members', async () => {
    const { cache } = await createActors([
      frame({
        orderId: 'order-2',
        symbol: 'BEAR.HK',
        side: 'SELL',
        status: 'PendingCancel',
        submittedPrice: '0.88',
        quantity: '2000',
        executedQuantity: '500',
        executedPrice: '0.88',
        orderType: 'SLO',
      }),
    ]);
    const orders = await cache.getPendingOrders();
    expect(orders[0]).toMatchObject({
      side: 'SELL',
      status: 'CANCELLATION_PENDING',
      orderType: 'SLO',
    });
  });

  it('uses injected clock to expire the pending-order cache', async () => {
    let nowMs = Date.parse('2026-04-10T01:00:00.000Z');
    const actors = await createActors([frame()], () => new Date(nowMs));
    const first = await actors.cache.getPendingOrders(['BULL.HK']);
    actors.fixture.setOrderSnapshotReplies([], [frame({ orderId: 'order-2' })]);
    nowMs += 29_999;
    const cached = await actors.cache.getPendingOrders(['BULL.HK']);
    nowMs += 1;
    const refreshed = await actors.cache.getPendingOrders(['BULL.HK']);
    expect(actors.fixture.orderSnapshotReadCounts().today).toBe(2);
    expect(first[0]?.orderId).toBe('order-1');
    expect(cached[0]?.orderId).toBe('order-1');
    expect(refreshed[0]?.orderId).toBe('order-2');
    expect(actors.throttleCount()).toBe(2);
  });
});
