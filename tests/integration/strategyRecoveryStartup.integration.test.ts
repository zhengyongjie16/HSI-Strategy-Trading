/** T28 真实恢复到 app 启动分类：受控 broker 完成、可信零成交结算、冲突阻断与外部失败。 */
import { describe, expect, it } from 'bun:test';
import { isExternalApiRequestError } from '../../src/utils/apiFailure/index.js';
import { createStartupRecoveryHarness } from './strategyRecoveryStartup/appHarness.js';
import { createRecoveryHarness } from './strategyRecoveryStartup/recoveryHarness.js';

/** 观察恢复错误原值，避免等待 app 运行结束前产生未处理拒绝。 */
async function resultOf(promise: Promise<void>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
}

describe('T28 recovery → startup controlled acceptance', () => {
  for (const scenario of ['accepted', 'conflict'] as const) {
    it(`${scenario}: real recovery stops and app rejects the same internal error without starting owners`, async () => {
      const recovery = createRecoveryHarness(scenario);
      const app = createStartupRecoveryHarness({ recover: recovery.recover });
      const result = resultOf(app.run());
      await recovery.entered;
      expect(recovery.runtime.runtimeState).toBe('BOOTSTRAPPING');
      expect(app.lastState.isTradingEnabled).toBe(false);
      expect(app.starts).toEqual([]);
      recovery.complete();
      const error = await result;
      expect(error).toBe(recovery.error());
      expect(error).toBeInstanceOf(Error);
      expect(isExternalApiRequestError(error)).toBe(false);
      expect(String(error)).toContain(scenario === 'accepted' ? '终态未确认' : '成交事实');
      expect(app.fatalState()).toEqual({ hasFatalError: true, error });
      expect(recovery.runtime.runtimeState).toBe('STOPPED');
      expect(recovery.runtime.closedOrderIds.size).toBe(0);
      expect(recovery.events).toEqual([]);
      expect(recovery.runtime.trackedOrders.size).toBe(0);
      expect(app.starts).toEqual([]);
      expect(app.lastState.isTradingEnabled).toBe(false);
      expect(app.lastState.pendingOpenRebuild).toBe(false);
      expect(app.post.buyTaskQueue.isEmpty()).toBe(true);
      expect(app.post.sellTaskQueue.isEmpty()).toBe(true);
      expect(recovery.steps).toEqual(['cancel.enter', 'cancel.complete', 'recovery.reject']);
    });
  }

  it('trusted zero execution: real settlement closes the order before recovery ACTIVE and ordinary owners start', async () => {
    const recovery = createRecoveryHarness('zero');
    const app = createStartupRecoveryHarness({ recover: recovery.recover });
    const result = resultOf(app.run());
    await recovery.entered;
    expect(app.starts).toEqual([]);
    expect(recovery.runtime.runtimeState).toBe('BOOTSTRAPPING');
    expect(recovery.runtime.closedOrderIds.size).toBe(0);
    recovery.complete();
    await app.timeStarted;
    await Promise.resolve();
    expect(recovery.runtime.runtimeState).toBe('ACTIVE');
    expect(recovery.runtime.closedOrderIds.has('T28-BUY')).toBe(true);
    expect(recovery.runtime.queriedTerminalStateByOrderId.size).toBe(0);
    expect(recovery.orderHoldRegistry.getHoldSymbols().size).toBe(0);
    expect(recovery.orderRecorder.getBuyOrdersForSymbol('OLD.HK', true)).toEqual([]);
    expect(recovery.events).toHaveLength(1);
    expect(recovery.events[0]).toMatchObject({
      orderId: 'T28-BUY',
      source: 'RECOVERY',
      status: 'CANCELED',
      executedQuantity: 0,
      side: 'BUY',
    });

    expect(recovery.steps.indexOf('settlement.event')).toBeLessThan(
      recovery.steps.indexOf('recovery.complete'),
    );
    expect(app.lastState.isTradingEnabled).toBe(true);
    expect(app.starts).toContain('buyProcessor.start');
    expect(app.starts).toContain('sellProcessor.start');
    expect(app.starts).toContain('monitorTaskProcessor.start');
    expect(app.starts).toContain('trader.startOrderMonitorRuntime');
    expect(app.starts).toContain('businessEventProgram.start');
    expect(app.post.buyTaskQueue.isEmpty()).toBe(true);
    expect(app.post.sellTaskQueue.isEmpty()).toBe(true);
    app.shutdown();
    expect(await result).toBeNull();
  });

  it('formal external request failure: app preserves error identity, closes trading and starts time owner only; real recovery is reusable', async () => {
    const brokerError = new Error('offline network unavailable');
    const recovery = createRecoveryHarness('external', brokerError);
    const app = createStartupRecoveryHarness({ recover: recovery.recover });
    const result = resultOf(app.run());
    await recovery.entered;
    expect(app.starts).toEqual([]);
    recovery.complete();
    await app.timeStarted;
    expect(recovery.runtime.runtimeState).toBe('STOPPED');
    const externalError = recovery.error();
    expect(externalError).toBeInstanceOf(Error);
    if (!(externalError instanceof Error)) throw new Error('expected boundary error');

    expect(externalError.cause).toBe(brokerError);
    expect(app.classifiedErrors).toContain(externalError);
    expect(isExternalApiRequestError(recovery.error())).toBe(true);
    expect(app.fatalState()).toEqual({ hasFatalError: false });
    expect(app.lastState.isTradingEnabled).toBe(false);
    expect(app.lastState.pendingOpenRebuild).toBe(true);
    expect(app.lastState.lifecycleState).toBe('OPEN_REBUILD_FAILED');
    expect(app.starts).toEqual(['time.start']);
    expect(recovery.events).toEqual([]);
    recovery.useTrustedZero();
    await recovery.recover();
    expect(recovery.runtime.runtimeState).toBe('ACTIVE');
    expect(recovery.runtime.closedOrderIds.has('T28-BUY')).toBe(true);
    expect(recovery.events).toHaveLength(1);
    // 此处只验证失败运行态可重建，不冒充生命周期 timer 的重新放行。
    expect(app.lastState.isTradingEnabled).toBe(false);
    expect(app.starts).toEqual(['time.start']);
    app.shutdown();
    expect(await result).toBeNull();
  });
});
