/**
 * orderCacheManager 业务测试
 *
 * 功能：
 * - 验证未成交订单查询异常不会被伪装为空数组。
 */
import { describe, expect, it } from 'bun:test';
import { createOrderCacheManager } from '../../../src/core/trader/orderCacheManager.js';

describe('orderCacheManager business flow', () => {
  it('throws when todayOrders response is malformed instead of returning empty orders', async () => {
    const manager = createOrderCacheManager({
      ctxPromise: Promise.resolve({
        todayOrders: async () => ({ invalid: true }) as never,
      } as never),
      rateLimiter: {
        throttle: async () => {},
      },
    });

    expect(manager.getPendingOrders(null, true)).rejects.toThrow('todayOrders 返回结果不是数组');
  });
});
