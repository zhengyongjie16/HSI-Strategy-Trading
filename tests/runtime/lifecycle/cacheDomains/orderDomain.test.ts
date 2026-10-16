/**
 * 订单缓存域单元测试
 *
 * 覆盖：midnightClear 仅重置 tradeRuntime 运行态；openRebuild 不再持有订单监控 runtime owner
 */
import { describe, it, expect } from 'bun:test';
import { createOrderDomain } from '../../../../src/runtime/lifecycle/cacheDomains/orderDomain.js';
import { createLoggerDouble, createTradeRuntimeDouble } from '../../../helpers/testDoubles.js';
import { createOpenRebuildContextFixture } from '../fixtures/openRebuildContext.js';
import { createTerminationRuntime } from '../../../../src/runtime/lifecycle/terminationRuntime.js';

describe('createOrderDomain', () => {
  it('midnightClear 仅重置 tradeRuntime 运行态', async () => {
    const calls: string[] = [];
    const tradeRuntime = createTradeRuntimeDouble({
      orderRecorder: {
        resetAll: () => {
          calls.push('recorder');
        },
      },
      cacheManager: {
        clearCache: () => {
          calls.push('cache');
        },
      },
      orderHoldRegistry: {
        clear: () => {
          calls.push('hold');
        },
      },
      orderMonitor: {
        clearTrackedOrders: () => {
          calls.push('monitor');
        },
      },
      orderExecutor: {
        resetBuyThrottle: () => {
          calls.push('executor');
        },
      },
    });

    const domain = createOrderDomain({
      logger: createLoggerDouble(),
      cacheManager: tradeRuntime.cacheManager,
      orderRecorder: tradeRuntime.orderRecorder,
      orderHoldRegistry: tradeRuntime.orderHoldRegistry,
      orderMonitor: tradeRuntime.orderMonitor,
      orderExecutor: tradeRuntime.orderExecutor,
    });
    await domain.midnightClear({
      now: new Date(),
      runtime: { dayKey: '2025-02-15', canTradeNow: true, isTradingDay: true },
    });

    expect(calls).toEqual(['recorder', 'cache', 'hold', 'monitor', 'executor']);
  });

  it('openRebuild 不再启动订单监控 runtime', async () => {
    const calls: string[] = [];
    const tradeRuntime = createTradeRuntimeDouble({
      orderMonitor: {
        startRuntime: () => {
          calls.push('startOrderMonitorRuntime');
        },
      },
    });
    const domain = createOrderDomain({
      logger: createLoggerDouble(),
      cacheManager: tradeRuntime.cacheManager,
      orderRecorder: tradeRuntime.orderRecorder,
      orderHoldRegistry: tradeRuntime.orderHoldRegistry,
      orderMonitor: tradeRuntime.orderMonitor,
      orderExecutor: tradeRuntime.orderExecutor,
    });
    const termination = createTerminationRuntime({
      closeTradingGate: () => {},
      closeProducerAdmission: () => {},
      stopProducers: [],
      onSecondaryError: () => {},
    });
    const ctx = await createOpenRebuildContextFixture({
      now: new Date(),
      runtime: { dayKey: '2025-02-15', canTradeNow: true, isTradingDay: true },
      termination,
    });
    const result = await domain.openRebuild(ctx);
    expect(result.status).toBe('COMMITTED');
    if (result.status !== 'COMMITTED') throw new Error('Expected completed order domain');

    expect(result.snapshotToken).toBe(ctx.snapshotToken);
    expect(calls).toEqual([]);
  });
});
