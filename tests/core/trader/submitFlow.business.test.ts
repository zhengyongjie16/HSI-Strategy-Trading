/**
 * submitFlow 业务测试
 *
 * 功能：
 * - 验证买入提交前的 pending-buy 二次硬拦截。
 */
import { describe, expect, it } from 'bun:test';
import { createGlobalConfig } from '../../../mock/factories/configFactory.js';
import { createSubmitTargetOrder } from '../../../src/core/trader/orderExecutor/submitFlow.js';
import {
  createOrderMonitorDouble,
  createSignalDouble,
  createStrategyRuntimeConfigDouble,
} from '../../helpers/testDoubles.js';

describe('submitFlow business behavior', () => {
  it('skips buy submission when orderMonitor still tracks pending buy occupation', async () => {
    let throttleCalls = 0;
    let submitOrderCalls = 0;
    let recordBuyAttemptCalls = 0;

    const submitTargetOrder = createSubmitTargetOrder({
      rateLimiter: {
        throttle: async () => {
          throttleCalls += 1;
        },
      },
      cacheManager: {
        clearCache: () => {},
        getPendingOrders: async () => [],
      },
      orderMonitor: createOrderMonitorDouble({
        hasPendingBuyOrders: () => true,
      }),
      globalConfig: createGlobalConfig(),
      canExecuteSignal: () => true,
      recordBuyAttempt: () => {
        recordBuyAttemptCalls += 1;
      },
    });

    const signal = createSignalDouble('BUYCALL', 'BULL.HK');
    signal.price = 1;
    signal.lotSize = 100;

    const result = await submitTargetOrder(
      {
        submitOrder: async () => {
          submitOrderCalls += 1;
          return { orderId: 'SHOULD-NOT-SUBMIT' } as never;
        },
      } as never,
      signal,
      'BULL.HK',
      false,
      createStrategyRuntimeConfigDouble(),
    );

    expect(result).toBeNull();
    expect(throttleCalls).toBe(0);
    expect(submitOrderCalls).toBe(0);
    expect(recordBuyAttemptCalls).toBe(0);
  });
});
