/**
 * 订单缓存域单元测试
 *
 * 覆盖：midnightClear 仅重置 trader 运行态；openRebuild 不再持有订单监控 runtime owner
 */
import { describe, it, expect } from 'bun:test';
import { createOrderDomain } from '../../../../src/main/lifecycle/cacheDomains/orderDomain.js';
import { createLoggerDouble, createTraderDouble } from '../../../helpers/testDoubles.js';
import { createOpenRebuildContextFixture } from '../../fixtures/openRebuildContext.js';
import { createTerminationRuntime } from '../../../../src/app/runtime/createTerminationRuntime.js';

describe('createOrderDomain', () => {
  it('midnightClear 仅重置 trader 运行态', async () => {
    const calls: string[] = [];
    const trader = createTraderDouble({
      resetRuntimeState: () => {
        calls.push('resetRuntimeState');
      },
    });

    const domain = createOrderDomain({ logger: createLoggerDouble(), trader });
    await domain.midnightClear({
      now: new Date(),
      runtime: { dayKey: '2025-02-15', canTradeNow: true, isTradingDay: true },
    });

    expect(calls).toEqual(['resetRuntimeState']);
  });

  it('openRebuild 不再启动订单监控 runtime', async () => {
    const calls: string[] = [];
    const trader = createTraderDouble({
      startOrderMonitorRuntime: () => {
        calls.push('startOrderMonitorRuntime');
      },
    });
    const domain = createOrderDomain({ logger: createLoggerDouble(), trader });
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
