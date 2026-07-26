/**
 * orderCacheManager 业务测试
 *
 * 场景意图：锁定今日订单 API 信任边界，坏结构必须 fail-fast。
 */
import { describe, expect, it } from 'bun:test';
import { Decimal, OrderSide, OrderStatus, OrderType } from 'longbridge';

import { createOrderCacheManager } from '../../../src/core/trader/orderCacheManager.js';
import type { RateLimiter, TradeMutationPermit } from '../../../src/types/services.js';

const TEST_NOW = (): Date => new Date('2026-04-10T01:00:00.000Z');

/** 构造订单缓存读取测试使用的无副作用限流器。 */
function createRateLimiterDouble(): RateLimiter {
  return {
    throttle: async () => {},
    withTradeMutation: async <T>(
      callback: (permit: TradeMutationPermit) => Promise<T>,
    ): Promise<T> =>
      callback({
        invoke: async <TResult>(operation: () => Promise<TResult>): Promise<TResult> => operation(),
      }),
  };
}

describe('orderCacheManager business flow', () => {
  it('returns pending orders from valid SDK todayOrders payload', async () => {
    const ctx = {
      todayOrders: async () => [
        {
          orderId: 'order-1',
          symbol: 'BULL.HK',
          side: OrderSide.Buy,
          status: OrderStatus.New,
          price: new Decimal('1.23'),
          quantity: new Decimal('1000'),
          executedQuantity: new Decimal('0'),
          orderType: OrderType.ELO,
        },
      ],
    };

    const orderCacheManager = createOrderCacheManager({
      ctx,
      rateLimiter: createRateLimiterDouble(),
      now: TEST_NOW,
    });

    const orders = await orderCacheManager.getPendingOrders();

    expect(orders).toEqual([
      {
        orderId: 'order-1',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
        submittedPrice: 1.23,
        quantity: 1000,
        executedQuantity: 0,
        status: OrderStatus.New,
        orderType: OrderType.ELO,
      },
    ]);
  });

  it('preserves nullable price for a valid pending market order', async () => {
    const ctx = {
      todayOrders: async () => [
        {
          orderId: 'market-order-1',
          symbol: 'BULL.HK',
          side: OrderSide.Buy,
          status: OrderStatus.New,
          price: null,
          quantity: new Decimal('1000'),
          executedQuantity: new Decimal('0'),
          orderType: OrderType.MO,
        },
      ],
    };
    const orderCacheManager = createOrderCacheManager({
      ctx,
      rateLimiter: createRateLimiterDouble(),
      now: TEST_NOW,
    });

    const orders = await orderCacheManager.getPendingOrders();

    expect(orders[0]?.submittedPrice).toBeNull();
    expect(orders[0]?.orderType).toBe(OrderType.MO);
  });

  it('fails fast when todayOrders contains an invalid order item', async () => {
    const ctx = {
      todayOrders: async () => [
        {
          orderId: 'order-1',
          symbol: 'BULL.HK',
          side: OrderSide.Buy,
          status: OrderStatus.New,
          price: new Decimal('1.23'),
          quantity: new Decimal('1000'),
          executedQuantity: new Decimal('0'),
          orderType: OrderType.ELO,
        },
        {
          orderId: 'broken-order',
          symbol: 'BULL.HK',
          status: OrderStatus.New,
        },
      ],
    };

    const orderCacheManager = createOrderCacheManager({
      ctx,
      rateLimiter: createRateLimiterDouble(),
      now: TEST_NOW,
    });

    let caught: unknown = null;
    try {
      await orderCacheManager.getPendingOrders();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TypeError);
  });

  it('fails fast when todayOrders item has non-finite numeric payload', async () => {
    const ctx = {
      todayOrders: async () => [
        {
          orderId: 'broken-order',
          symbol: 'BULL.HK',
          side: OrderSide.Buy,
          status: OrderStatus.New,
          price: {},
          quantity: new Decimal('1000'),
          executedQuantity: new Decimal('0'),
          orderType: OrderType.ELO,
        },
      ],
    };

    const orderCacheManager = createOrderCacheManager({
      ctx,
      rateLimiter: createRateLimiterDouble(),
      now: TEST_NOW,
    });

    let caught: unknown = null;
    try {
      await orderCacheManager.getPendingOrders();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TypeError);
  });

  for (const testCase of [
    { field: 'side', invalidValue: 999, invalidKind: 'non-member' },
    { field: 'status', invalidValue: 999, invalidKind: 'non-member' },
    { field: 'orderType', invalidValue: 999, invalidKind: 'non-member' },
    { field: 'side', invalidValue: OrderSide.Unknown, invalidKind: 'Unknown' },
    { field: 'status', invalidValue: OrderStatus.Unknown, invalidKind: 'Unknown' },
    { field: 'orderType', invalidValue: OrderType.Unknown, invalidKind: 'Unknown' },
  ] as const) {
    it(`fails fast when todayOrders item has invalid ${testCase.field} ${testCase.invalidKind} value`, async () => {
      const ctx = {
        todayOrders: async () => [
          {
            orderId: 'broken-order',
            symbol: 'BULL.HK',
            side: OrderSide.Buy,
            status: OrderStatus.New,
            price: new Decimal('1.23'),
            quantity: new Decimal('1000'),
            executedQuantity: new Decimal('0'),
            orderType: OrderType.ELO,
            [testCase.field]: testCase.invalidValue,
          },
        ],
      };

      const orderCacheManager = createOrderCacheManager({
        ctx,
        rateLimiter: createRateLimiterDouble(),
        now: TEST_NOW,
      });

      let caught: unknown = null;
      try {
        await orderCacheManager.getPendingOrders();
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(TypeError);
    });
  }

  it('accepts less common valid side, status, and orderType enum members', async () => {
    const ctx = {
      todayOrders: async () => [
        {
          orderId: 'order-2',
          symbol: 'BEAR.HK',
          side: OrderSide.Sell,
          status: OrderStatus.PendingCancel,
          price: new Decimal('0.88'),
          quantity: new Decimal('2000'),
          executedQuantity: new Decimal('500'),
          orderType: OrderType.SLO,
        },
      ],
    };

    const orderCacheManager = createOrderCacheManager({
      ctx,
      rateLimiter: createRateLimiterDouble(),
      now: TEST_NOW,
    });

    const orders = await orderCacheManager.getPendingOrders();

    expect(orders[0]).toMatchObject({
      side: OrderSide.Sell,
      status: OrderStatus.PendingCancel,
      orderType: OrderType.SLO,
    });
  });

  it('uses injected clock to expire the pending-order cache', async () => {
    let nowMs = Date.parse('2026-04-10T01:00:00.000Z');
    let todayOrdersCalls = 0;
    const ctx = {
      todayOrders: async () => {
        todayOrdersCalls += 1;
        return [
          {
            orderId: `order-${todayOrdersCalls}`,
            symbol: 'BULL.HK',
            side: OrderSide.Buy,
            status: OrderStatus.New,
            price: new Decimal('1.23'),
            quantity: new Decimal('1000'),
            executedQuantity: new Decimal('0'),
            orderType: OrderType.ELO,
          },
        ];
      },
    };
    const orderCacheManager = createOrderCacheManager({
      ctx,
      rateLimiter: createRateLimiterDouble(),
      now: () => new Date(nowMs),
    });

    const first = await orderCacheManager.getPendingOrders(['BULL.HK']);
    nowMs += 29_999;
    const cached = await orderCacheManager.getPendingOrders(['BULL.HK']);
    nowMs += 1;
    const refreshed = await orderCacheManager.getPendingOrders(['BULL.HK']);

    expect(todayOrdersCalls).toBe(2);
    expect(first[0]?.orderId).toBe('order-1');
    expect(cached[0]?.orderId).toBe('order-1');
    expect(refreshed[0]?.orderId).toBe('order-2');
  });
});
