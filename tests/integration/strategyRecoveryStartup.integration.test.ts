/** T28 真实恢复到 app 启动分类：受控 broker 完成、可信零成交结算、冲突阻断与外部失败。 */
import { describe, expect, it } from 'bun:test';
import { isExternalApiRequestError } from '../../src/utils/apiFailure/index.js';
import { createStartupRecoveryHarness } from './strategyRecoveryStartup/appHarness.js';
import { createRecoveryHarness } from './strategyRecoveryStartup/recoveryHarness.js';
import type { StartupRecoveryHarness } from './strategyRecoveryStartup/types.js';

/** 观察恢复错误原值，避免等待 app 运行结束前产生未处理拒绝。 */
async function resultOf(promise: Promise<void>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
}

/** 里程碑必须同时观察真实 app 提前退出，不能让内部 fatal 被 timeStarted 的未兑现掩盖成超时。 */
async function waitForStartupTime(
  app: StartupRecoveryHarness,
  result: Promise<unknown>,
): Promise<void> {
  await Promise.race([
    app.timeStarted,
    result.then((error) => {
      if (error instanceof Error) throw error;

      if (error !== null) throw new Error('app failed before time owner started', { cause: error });

      throw new Error('app exited before time owner started');
    }),
  ]);
}

describe('T28 recovery → startup controlled acceptance', () => {
  for (const scenario of ['accepted', 'conflict'] as const) {
    it(`${scenario}: real recovery stops and app rejects the same internal error without starting owners`, async () => {
      let app: StartupRecoveryHarness | null = null;
      const recovery = await createRecoveryHarness(scenario, () => {
        if (app === null) throw new Error('App collaborators must be assembled before baseline');

        return app.post;
      });
      app = createStartupRecoveryHarness({
        recover: recovery.recover,
        executionOwner: recovery.executionOwner,
      });
      const result = resultOf(app.run());
      await recovery.entered;
      expect(recovery.runtime.runtimeState).toBe('BOOTSTRAPPING');
      expect(app.stateFixtures.lifecycleState.isTradingEnabled).toBe(false);
      expect(app.starts).toEqual([]);
      recovery.complete();
      const error = await result;
      expect(error).toBe(recovery.error());
      expect(error).toBeInstanceOf(Error);
      expect(isExternalApiRequestError(error)).toBe(false);
      if (scenario === 'accepted') {
        expect(String(error)).toContain('终态未确认');
      } else {
        // 启动快照与权威终态都声明正成交时，恢复不得把不匹配买单当作零成交资源关闭。
        if (!(error instanceof Error)) throw new Error('expected recovery mismatch Error');

        expect(error.message).toBe(
          '[订单监控] 买单 T28-BUY 不匹配但启动快照或权威终态存在成交事实，阻断恢复',
        );
      }

      expect(app.fatalState()).toEqual({ hasFatalError: true, error });
      expect(recovery.runtime.runtimeState).toBe('STOPPED');
      expect(recovery.runtime.closedOrderIds.size).toBe(0);
      expect(recovery.events).toEqual([]);
      expect(recovery.runtime.trackedOrders.size).toBe(0);
      expect(app.starts).toEqual([]);
      expect(app.stateFixtures.lifecycleState.isTradingEnabled).toBe(false);
      expect(app.stateFixtures.lifecycleState.pendingOpenRebuild).toBe(false);
      expect(app.post.buyTaskQueue.isEmpty()).toBe(true);
      expect(app.post.sellTaskQueue.isEmpty()).toBe(true);
      expect(recovery.steps).toEqual(['cancel.enter', 'cancel.complete', 'recovery.reject']);
    });
  }

  it('trusted zero execution: real settlement closes the order before recovery ACTIVE and ordinary owners start', async () => {
    let app: StartupRecoveryHarness | null = null;
    const recovery = await createRecoveryHarness('zero', () => {
      if (app === null) throw new Error('App collaborators must be assembled before baseline');

      return app.post;
    });
    app = createStartupRecoveryHarness({
      recover: recovery.recover,
      executionOwner: recovery.executionOwner,
    });
    const result = resultOf(app.run());
    await recovery.entered;
    expect(app.starts).toEqual([]);
    expect(recovery.runtime.runtimeState).toBe('BOOTSTRAPPING');
    expect(recovery.runtime.closedOrderIds.size).toBe(0);
    recovery.complete();
    await waitForStartupTime(app, result);
    await Promise.resolve();
    expect(recovery.runtime.runtimeState).toBe('ACTIVE');
    expect(recovery.runtime.closedOrderIds.has('T28-BUY')).toBe(true);
    expect(recovery.runtime.queriedTerminalStateByOrderId.size).toBe(0);
    expect(recovery.orderHoldRegistry.getHoldSymbols().size).toBe(0);
    expect(recovery.orderRecorder.getBuyOrdersForSymbol('OLD.HK', true)).toEqual([]);
    expect(recovery.events).toHaveLength(1);
    expect(recovery.events[0]).toMatchObject({
      orderId: 'T28-BUY',
      status: 'CANCELED',
      executedQuantity: 0,
      side: 'BUY',
    });

    expect(recovery.steps.indexOf('settlement.event')).toBeLessThan(
      recovery.steps.indexOf('recovery.complete'),
    );
    expect(app.stateFixtures.lifecycleState.isTradingEnabled).toBe(true);
    expect(app.starts).toContain('buyProcessor.start');
    expect(app.starts).toContain('sellProcessor.start');
    expect(app.starts).toContain('monitorTaskProcessor.start');
    expect(app.starts).toContain('tradeRuntime.orderMonitor.startRuntime');
    expect(app.starts).toContain('businessEventProgram.start');
    expect(app.post.buyTaskQueue.isEmpty()).toBe(true);
    expect(app.post.sellTaskQueue.isEmpty()).toBe(true);
    app.shutdown();
    expect(await result).toBeNull();
  });

  it('formal external request failure: app preserves error identity, closes trading and starts time owner only; real recovery is reusable', async () => {
    const brokerError = new Error('offline network unavailable');
    let app: StartupRecoveryHarness | null = null;
    const recovery = await createRecoveryHarness(
      'external',
      () => {
        if (app === null) throw new Error('App collaborators must be assembled before baseline');

        return app.post;
      },
      brokerError,
    );
    app = createStartupRecoveryHarness({
      recover: recovery.recover,
      executionOwner: recovery.executionOwner,
    });
    const result = resultOf(app.run());
    await recovery.entered;
    expect(app.starts).toEqual([]);
    recovery.complete();
    await waitForStartupTime(app, result);
    expect(recovery.runtime.runtimeState).toBe('STOPPED');
    const externalError = recovery.error();
    expect(externalError).toBeInstanceOf(Error);
    if (!(externalError instanceof Error)) throw new Error('expected boundary error');

    expect(externalError.cause).toBe(brokerError);
    expect(app.classifiedErrors).toContain(externalError);
    expect(isExternalApiRequestError(recovery.error())).toBe(true);
    expect(app.fatalState()).toEqual({ hasFatalError: false });
    expect(app.stateFixtures.lifecycleState.isTradingEnabled).toBe(false);
    expect(app.stateFixtures.lifecycleState.pendingOpenRebuild).toBe(true);
    expect(app.stateFixtures.lifecycleState.lifecycleState).toBe('OPEN_REBUILD_FAILED');
    expect(app.starts).toEqual(['time.start']);
    expect(recovery.events).toEqual([]);
    recovery.useTrustedZero();
    await recovery.recover();
    expect(recovery.runtime.runtimeState).toBe('ACTIVE');
    expect(recovery.runtime.closedOrderIds.has('T28-BUY')).toBe(true);
    expect(recovery.events).toHaveLength(1);
    // 此处只验证失败运行态可重建，不冒充生命周期 timer 的重新放行。
    expect(app.stateFixtures.lifecycleState.isTradingEnabled).toBe(false);
    expect(app.starts).toEqual(['time.start']);
    app.shutdown();
    expect(await result).toBeNull();
  });
});
