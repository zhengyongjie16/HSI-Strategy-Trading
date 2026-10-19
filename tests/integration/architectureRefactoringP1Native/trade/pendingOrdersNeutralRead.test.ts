import { wrapExternalApiRequest } from '../../../../src/infrastructure/externalApi/index.js';
import { nowMonotonicMs, wait } from '../../../../src/infrastructure/time/index.js';

import { createLoggerDouble } from '../../../helpers/testDoubles.js';

/** 实际private同ctx pending adapter→生产cache，原TTL/刷新/过滤及primitive校验不替换。 */

import { expect, test } from 'bun:test';
import { createRateLimiter } from '../../../../src/application/orderExecution/rateLimiter.js';
import { createOrderCacheManager } from '../../../../src/application/orderTracking/orderCacheManager.js';
import { API } from '../../../../src/constants/index.js';
import { orderEconomics } from '../../../../src/domain/order/orderEconomics.js';
import {
  createBrokerIngressFixture,
  type BrokerIngressInput,
} from '../../../infrastructure/longbridge/trade/brokerIngressFixture.js';

const original: BrokerIngressInput = {
  orderId: 'PENDING-BUY',
  tradeId: 'PENDING-TRADE',
  symbol: 'BULL.HK',
  stockName: 'SDK',
  remark: '',
  side: 'BUY',
  status: 'New',
  orderType: 'ELO',
  quantity: '100',
  executedQuantity: '0',
  submittedPrice: '1.000000000000000001',
  executedPrice: '0',
  submittedAtMs: 100,
  executionTimeMs: null,
  updatedAtMs: 200,
};

test('actual native pending BUY/SELL status/type map once; original symbol filter/cache TTL/forced refresh remain', async () => {
  const native = await createBrokerIngressFixture(original, orderEconomics);
  const frames: ReadonlyArray<BrokerIngressInput> = [
    original,
    {
      ...original,
      orderId: 'PENDING-SELL',
      side: 'SELL',
      status: 'PendingCancel',
      orderType: 'MO',
      submittedPrice: '0',
    },
    { ...original, orderId: 'OTHER-SYMBOL', symbol: 'BEAR.HK' },
    { ...original, orderId: 'TERMINAL', status: 'Canceled' },
  ];
  native.setOrderSnapshotReplies([], frames);
  let now = 1000;
  let throttles = 0;
  const reader = native.ports.createPendingOrdersReader();
  const originalLimiter = createRateLimiter({
    wait: wait,
    nowMonotonicMs: nowMonotonicMs,
    logger: createLoggerDouble(),
  });
  const cache = createOrderCacheManager({
    requestExternalApi: wrapExternalApiRequest,
    logger: createLoggerDouble(),
    ctx: reader,
    rateLimiter: {
      ...originalLimiter,
      throttle: async () => {
        throttles++;
        await originalLimiter.throttle();
      },
    },
    now: () => new Date(now),
  });
  const rows = await cache.getPendingOrders(['BULL.HK']);
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({
    side: 'BUY',
    status: 'WORKING',
    orderType: 'ELO',
    submittedPrice: '1.000000000000000001',
    quantity: 100,
  });

  expect(rows[1]).toMatchObject({
    side: 'SELL',
    status: 'CANCELLATION_PENDING',
    orderType: 'MO',
    submittedPrice: '0',
  });
  expect(native.orderSnapshotReadCounts().today).toBe(1);
  expect(throttles).toBe(1);
  expect(await cache.getPendingOrders(['BULL.HK'])).toEqual(rows);
  expect(native.orderSnapshotReadCounts().today).toBe(1);
  now += API.PENDING_ORDERS_CACHE_TTL_MS;
  await cache.getPendingOrders(['BULL.HK']);
  expect(native.orderSnapshotReadCounts().today).toBe(2);
  await cache.getPendingOrders(['BULL.HK'], true);
  expect(native.orderSnapshotReadCounts().today).toBe(3);
  cache.clearCache();
  await cache.getPendingOrders(['BULL.HK']);
  expect(native.orderSnapshotReadCounts().today).toBe(4);
  expect(throttles).toBe(4);
});

test('neutral cache rejects numeric SDK-shaped direction/status/type without accepting a compatibility bridge', async () => {
  const deps = {
    rateLimiter: createRateLimiter({
      wait: wait,
      nowMonotonicMs: nowMonotonicMs,
      logger: createLoggerDouble(),
    }),
    now: () => new Date(1000),
  };
  const valid = {
    orderId: 'BAD',
    symbol: 'BULL.HK',
    side: 'BUY',
    status: 'WORKING',
    orderType: 'ELO',
    submittedPrice: '1',
    quantity: 100,
  };
  for (const invalid of [
    { ...valid, side: 1 },
    { ...valid, status: 7 },
    { ...valid, orderType: 2 },
    { ...valid, side: 'UNKNOWN' },
  ]) {
    const malformed = createOrderCacheManager({
      requestExternalApi: wrapExternalApiRequest,
      logger: createLoggerDouble(),
      ...deps,
      ctx: { todayOrders: async () => [invalid] },
    });
    const error = await malformed.getPendingOrders().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(TypeError);
    if (!(error instanceof TypeError)) throw new Error('missing strict cache rejection');

    expect(error.message).toContain('[订单缓存] todayOrders 订单数据结构无效');
  }
});
