/** M1 bootstrap 实际 runApp → 同 H/S 的 ready 顺序：quote await 与 dirty 业务不能并行绕过启动放行。 */

import { describe, expect, it, spyOn } from 'bun:test';
import { createTradingConfig } from '../../mock/factories/configFactory.js';
import { executeTradingDayOpenRebuild } from '../../src/app/lifecycle/rebuild.js';
import { createDayLifecycleManager } from '../../src/main/lifecycle/dayLifecycleManager.js';
import { createQuoteSubscriptionRuntime } from '../../src/main/quoteSubscriptionRuntime/index.js';
import { createExecutionFixture } from '../application/orderTracking/recorder/executionFixture.js';
import { createExternalApiRequestError } from '../helpers/createExternalApiRequestError.js';
import {
  createAccountSnapshotDouble,
  createLoggerDouble,
  createMarketDataClientDouble,
  createTraderDouble,
} from '../helpers/testDoubles.js';
import { createStartupRecoveryHarness } from './strategyRecoveryStartup/appHarness.js';

async function flush(): Promise<void> {
  for (let count = 0; count < 100; count++) await Promise.resolve();
}

function createOwner(onPositionsCommitted: () => Promise<void>) {
  const owner = createExecutionFixture({
    readPort: {
      getAccountSnapshot: async () => createAccountSnapshotDouble('100000'),
      getStockPositions: async () => [],
    },
    getTrader: () => createTraderDouble(),
    onPositionsCommitted,
  });
  return owner;
}

describe('startup runApp settlement readiness', () => {
  it('startup baseline false 保留新成交 need，本地重载 await 跨 300ms 不自行再刷新；只在原 owner 续跑后 ready', async () => {
    const reloadEntered = Promise.withResolvers<undefined>();
    const reloadRelease = Promise.withResolvers<undefined>();
    let callbacks = 0;
    const owner = createOwner(async () => {
      callbacks++;
      if (callbacks === 1) owner.commit('STARTUP-LATE-BUY', 'BUY', '10', '100', 10, 1, 'BULL.HK');
    });
    owner.commit('STARTUP-FIRST-BUY', 'BUY', '10', '100', 10, 0, 'BULL.HK');
    const app = createStartupRecoveryHarness({ executionOwner: owner, recover: async () => {} });
    const reload = spyOn(app.post, 'loadTradingDayRuntimeSnapshot').mockImplementation(async () => {
      if (callbacks === 1) {
        reloadEntered.resolve();
        await reloadRelease.promise;
      }

      const receipt = await owner.snapshot.requestRefresh({
        source: 'STARTUP',
        dayEpoch: owner.snapshot.getView().token.dayEpoch,
        refreshAccount: true,
        refreshPositions: true,
      }).result;
      return receipt.status === 'ABORTED'
        ? receipt
        : {
            status: 'COMMITTED',
            snapshotToken: receipt.snapshotToken,
            allOrders: [],
            quotesMap: new Map(),
          };
    });
    let readyEvents = 0;
    owner.sink.onFreshReached(() => {
      readyEvents++;
    });
    const running = app.run();
    try {
      await reloadEntered.promise;
      expect(callbacks).toBe(1);
      expect(owner.sink.getStatus()).toMatchObject({
        started: false,
        currentVersion: 0,
        staleVersion: 2,
      });
      expect(app.starts).not.toContain('buyProcessor.start');
      await Bun.sleep(380);
      expect(callbacks).toBe(1);
      expect(readyEvents).toBe(0);
      reloadRelease.resolve();
      await app.timeStarted;
      expect(callbacks).toBe(2);
      expect(readyEvents).toBe(1);
      expect(owner.sink.getStatus()).toMatchObject({ currentVersion: 2, staleVersion: 2 });
      expect(app.starts).toContain('buyProcessor.start');
      expect(app.classifiedErrors).toEqual([]);
    } finally {
      reloadRelease.resolve();
      app.shutdown();
      await running;
      await owner.sink.stopAndDrain();
      reload.mockRestore();
    }
  });

  it('startup baseline 外错跨 300ms 不启动普通 S 重试；显式 lifecycle 真实 paired 重载后才完成原 need', async () => {
    const fault = await createExternalApiRequestError({
      operation: 'QuoteContext.subscribe',
      attempts: 1,
      cause: new Error('startup baseline subscription unavailable'),
    });
    let callbacks = 0;
    const owner = createOwner(async () => {
      callbacks++;
      if (callbacks === 1) throw fault;
    });
    owner.commit('STARTUP-BUY', 'BUY', '10', '100', 10, 0, 'BULL.HK');
    const app = createStartupRecoveryHarness({ executionOwner: owner, recover: async () => {} });
    const subscription = createQuoteSubscriptionRuntime({
      snapshot: owner.snapshot,
      termination: owner.termination,
      symbolRegistry: app.post.monitorContext.symbolRegistry,
      trader: app.post.trader,
      tradingConfig: createTradingConfig({ monitor: app.post.monitorContext.config }),
      lastState: app.lastState,
      logger: createLoggerDouble(),
      marketDataClient: createMarketDataClientDouble(),
    });
    const fullQuotes = spyOn(
      app.post.quoteSubscriptionRuntime,
      'reconcileFromCurrentTruth',
    ).mockImplementation(subscription.reconcileFromCurrentTruth);
    let readyEvents = 0;
    owner.sink.onFreshReached(() => {
      readyEvents++;
    });
    const running = app.run();
    try {
      await app.timeStarted;
      expect(callbacks).toBe(1);
      expect(owner.sink.getStatus()).toMatchObject({
        started: false,
        currentVersion: 0,
        staleVersion: 1,
      });
      expect(app.lastState.isTradingEnabled).toBe(false);
      const waiting = owner.sink.waitForFresh();
      // 实际 timer 已可运行，跨越原 300ms retry 边界而不是人工禁用 scheduler。
      await Bun.sleep(380);
      expect(callbacks).toBe(1);
      expect(readyEvents).toBe(0);
      expect(app.classifiedErrors).toContain(fault);
      expect(app.starts).not.toContain('buyProcessor.start');
      const now = new Date('2026-04-29T01:31:00Z');
      const manager = createDayLifecycleManager({
        mutableState: app.lastState,
        snapshot: owner.snapshot,
        termination: owner.termination,
        logger: createLoggerDouble(),
        cacheDomains: [
          {
            midnightClear: () => {},
            openRebuild: () =>
              executeTradingDayOpenRebuild({
                now,
                snapshot: owner.snapshot,
                termination: owner.termination,
                postTradeConsistencyRuntime: owner.sink,
                quoteSubscriptionRuntime: app.post.quoteSubscriptionRuntime,
                loadTradingDayRuntimeSnapshot: async () => {
                  const receipt = await owner.snapshot.requestRefresh({
                    source: 'LIFECYCLE_REBUILD',
                    dayEpoch: owner.snapshot.getView().token.dayEpoch,
                    refreshAccount: true,
                    refreshPositions: true,
                  }).result;
                  return receipt.status === 'ABORTED'
                    ? receipt
                    : {
                        status: 'COMMITTED',
                        snapshotToken: receipt.snapshotToken,
                        allOrders: [],
                        quotesMap: new Map(),
                      };
                },
                rebuildTradingDayState: async ({ snapshotToken }) => ({
                  status: 'COMMITTED',
                  snapshotToken,
                }),
              }),
          },
        ],
      });
      await manager.tick(now, { dayKey: '2026-04-29', isTradingDay: true, canTradeNow: true });
      const ready = await waiting;
      expect(ready.settlementVersion).toBe(1);
      expect(callbacks).toBe(2);
      expect(readyEvents).toBe(1);
      expect(owner.sink.isCurrent(ready)).toBe(true);
      expect(app.lastState.isTradingEnabled).toBe(true);
      expect(owner.snapshot.getStatus().admission).toBe('OPEN');
    } finally {
      app.shutdown();
      await running;
      await owner.sink.stopAndDrain();
      await subscription.stopAndDrain();
      fullQuotes.mockRestore();
    }
  });

  it('quote 在途时 S baseline 不启动；quote 成功后真实业务 await 完成才启动稳态 owner', async () => {
    const quoteEntered = Promise.withResolvers<undefined>();
    const quoteRelease = Promise.withResolvers<undefined>();
    const bodyEntered = Promise.withResolvers<undefined>();
    const bodyRelease = Promise.withResolvers<undefined>();
    const owner = createOwner(async () => {
      bodyEntered.resolve();
      await bodyRelease.promise;
    });
    const app = createStartupRecoveryHarness({ executionOwner: owner, recover: async () => {} });
    const quote = spyOn(
      app.post.quoteSubscriptionRuntime,
      'reconcileFromCurrentTruth',
    ).mockImplementation(async () => {
      quoteEntered.resolve();
      await quoteRelease.promise;
    });
    let ready = false;
    owner.sink.onFreshReached(() => {
      ready = true;
    });
    const running = app.run();
    try {
      await quoteEntered.promise;
      expect(owner.sink.getStatus().started).toBe(false);
      expect(ready).toBe(false);
      expect(app.starts).not.toContain('buyProcessor.start');
      quoteRelease.resolve();
      await bodyEntered.promise;
      expect(owner.sink.getStatus().started).toBe(true);
      expect(ready).toBe(false);
      expect(app.starts).not.toContain('buyProcessor.start');
      bodyRelease.resolve();
      await app.timeStarted;
      expect(ready).toBe(true);
      expect(app.starts).toContain('buyProcessor.start');
      expect(app.classifiedErrors).toEqual([]);
    } finally {
      quoteRelease.resolve();
      bodyRelease.resolve();
      app.shutdown();
      await running;
      quote.mockRestore();
      await owner.sink.stopAndDrain();
    }
  });

  it('async baseline 明确外部失败由 runApp 观察并走原启动失败语义，不未处理拒绝或启动稳态', async () => {
    const fault = await createExternalApiRequestError({
      operation: 'QuoteContext.subscribe',
      attempts: 1,
      cause: new Error('baseline subscription unavailable'),
    });
    const owner = createOwner(async () => {
      throw fault;
    });
    const app = createStartupRecoveryHarness({ executionOwner: owner, recover: async () => {} });
    let ready = false;
    owner.sink.onFreshReached(() => {
      ready = true;
    });
    const running = app.run();
    try {
      await app.timeStarted;
      await flush();
      expect(app.classifiedErrors).toContain(fault);
      expect(app.lastState.pendingOpenRebuild).toBe(true);
      expect(app.lastState.isTradingEnabled).toBe(false);
      expect(ready).toBe(false);
      expect(app.starts).not.toContain('buyProcessor.start');
    } finally {
      app.shutdown();
      await running;
      await owner.sink.stopAndDrain();
    }
  });
});
