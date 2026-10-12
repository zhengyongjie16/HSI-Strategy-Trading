/**
 * api-flaky-recovery 混沌测试
 *
 * 功能：
 * - 验证 API 不稳定时的重试与恢复行为期望。
 */
import { describe, expect, it } from 'bun:test';
import { createBrokerIngressFixture } from '../../../integration/architectureRefactoringP1Native/trade/brokerIngressFixture.js';
import { createAccountPositionSnapshot } from '../../../../src/application/accountPositionSnapshot/index.js';
import { createPostTradeConsistencyRuntime } from '../../../../src/app/runtime/createPostTradeConsistencyRuntime.js';
import { createOrderHoldRegistry } from '../../../../src/core/trader/orderHoldRegistry.js';
import { API } from '../../../../src/constants/index.js';

import { createTradingConfig } from '../../../../mock/factories/configFactory.js';
import {
  createTerminationDouble,
  createMarketDataClientDouble,
  createDailyLossTrackerDouble,
  createMonitorContextDouble,
  createTraderDouble,
  createLiquidationCooldownTrackerDouble,
  createProtectiveLiquidationEpisodeTrackerDouble,
  createRateLimiterDouble,
  createSymbolRegistryDouble,
} from '../../../helpers/testDoubles.js';

async function waitForObservedCondition(params: {
  readonly description: string;
  readonly isSatisfied: () => boolean;
}): Promise<void> {
  const maxMicrotaskTurns = 100;
  for (let microtaskTurn = 0; microtaskTurn < maxMicrotaskTurns; microtaskTurn += 1) {
    if (params.isSatisfied()) {
      return;
    }

    await Promise.resolve();
  }

  throw new Error(
    `[测试] 等待${params.description}超时，已推进 ${String(maxMicrotaskTurns)} 个 microtask turn`,
  );
}

type RuntimeTimerHarness = {
  readonly advanceBy: (delayMs: number) => Promise<void>;
  readonly restore: () => void;
  readonly waitForTimerAt: (delayMs: number) => Promise<void>;
};

function createRuntimeTimerHarness(initialNowMs: number): RuntimeTimerHarness {
  const originalNow = Date.now;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let nowMs = initialNowMs;
  const timers = new Map<unknown, { readonly atMs: number; readonly callback: () => void }>();

  function isTimerCallback(
    handler: Parameters<typeof globalThis.setTimeout>[0],
  ): handler is (...args: ReadonlyArray<unknown>) => void {
    return typeof handler === 'function';
  }

  const fakeSetTimeout = Object.assign(
    (
      handler: Parameters<typeof globalThis.setTimeout>[0],
      timeout?: number,
    ): ReturnType<typeof originalSetTimeout> => {
      if (!isTimerCallback(handler)) {
        throw new TypeError('[测试] fake runtime timer 仅支持函数回调');
      }

      const handle = originalSetTimeout(() => {}, 0);
      originalClearTimeout(handle);
      timers.set(handle, {
        atMs: nowMs + (typeof timeout === 'number' ? timeout : 0),
        callback: () => {
          handler();
        },
      });
      return handle;
    },
    {
      __promisify__: originalSetTimeout.__promisify__,
    },
  );

  const fakeClearTimeout: typeof globalThis.clearTimeout = (handle) => {
    timers.delete(handle);
  };

  Date.now = () => nowMs;
  globalThis.setTimeout = fakeSetTimeout;
  globalThis.clearTimeout = fakeClearTimeout;

  function collectDueTimers() {
    return [...timers.entries()].filter(([, timer]) => timer.atMs <= nowMs);
  }

  function runDueTimers(): void {
    let dueTimers = collectDueTimers();
    while (dueTimers.length > 0) {
      for (const [handle, timer] of dueTimers) {
        timers.delete(handle);
        timer.callback();
      }

      dueTimers = collectDueTimers();
    }
  }

  async function waitForTimerAt(delayMs: number): Promise<void> {
    const expectedAtMs = nowMs + delayMs;
    await waitForObservedCondition({
      description: `atMs=${String(expectedAtMs)} 的 timer 注册`,
      isSatisfied: () => [...timers.values()].some((timer) => timer.atMs === expectedAtMs),
    });
  }

  return {
    advanceBy: async (delayMs: number) => {
      runDueTimers();
      nowMs += delayMs;
      runDueTimers();
    },
    restore: () => {
      Date.now = originalNow;
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    },
    waitForTimerAt,
  };
}

describe('chaos: api flaky recovery', () => {
  it('retries timeout cancel after backoff and still waits for WS after cancel succeeds', async () => {
    const nowMs = Date.parse('2026-02-25T03:00:00.000Z');
    const fixture = await createBrokerIngressFixture({
      orderId: 'BUY-001',
      tradeId: 'BUY-001-T',
      symbol: 'BULL.HK',
      stockName: 'BULL',
      remark: '',
      side: 'BUY',
      status: 'Filled',
      orderType: 'ELO',
      quantity: '100',
      executedQuantity: '100',
      submittedPrice: '1',
      executedPrice: '1',
      submittedAtMs: nowMs - 2000,
      executionTimeMs: nowMs - 1000,
      updatedAtMs: nowMs - 500,
    });
    const dailyLossTracker = createDailyLossTrackerDouble();
    dailyLossTracker.resetAll(new Date(nowMs));
    fixture.setAccountBalance({
      currency: 'HKD',
      totalCash: '1000',
      availableCash: '1000',
      netAssets: '1100',
    });

    fixture.setStockPositions([
      {
        symbol: 'BULL.HK',
        symbolName: 'BULL',
        accountChannel: 'offline',
        currency: 'HKD',
        quantity: '100',
        availableQuantity: '100',
        costPrice: '1',
      },
    ]);
    const account = fixture.createAccountService({ rateLimiter: createRateLimiterDouble() });
    const snapshot = createAccountPositionSnapshot({
      dayEpoch: 1,
      readPort: account,
      scheduler: { schedule: queueMicrotask },
      reportFatalError: (error) => {
        throw error;
      },
    });
    const paired = await snapshot.requestRefresh({
      source: 'flaky-baseline',
      dayEpoch: 1,
      refreshAccount: true,
      refreshPositions: true,
    }).result;
    if (paired.status !== 'COMMITTED') throw new Error('expected paired baseline');

    let trader: ReturnType<typeof createTraderDouble> | null = null;
    const postTrade = createPostTradeConsistencyRuntime({
      snapshot,
      termination: createTerminationDouble(),
      getTrader: () => {
        if (trader === null) throw new Error('trader unbound');

        return trader;
      },
      onPositionsCommitted: async (token) => {
        if (!snapshot.isCurrent(token, { positions: true, account: false }))
          throw new Error('stale positions token');
      },
      scheduler: { scheduleTimer: setTimeout, clearTimer: clearTimeout },
    });
    const orderRecorder = fixture.createRecorder({
      rateLimiter: createRateLimiterDouble(),
      getExecutionTimeEvidence: dailyLossTracker.getExecutionTimeEvidence,
      settlementRefreshNeedRecorder: postTrade,
    });
    dailyLossTracker.publishRecalculation(
      dailyLossTracker.prepareRecalculationFromAllOrders(
        [],
        createTradingConfig().monitor,
        new Date(nowMs),
        undefined,
        new Set(['BULL.HK']),
      ),
    );
    const protectiveTracker = createProtectiveLiquidationEpisodeTrackerDouble();
    trader = createTraderDouble({ ...account, orderRecorder });
    postTrade.bindBusinessDeps({
      monitorContext: createMonitorContextDouble({ orderRecorder, dailyLossTracker }),
      dailyLossTracker,
      protectiveLiquidationEpisodeTracker: protectiveTracker,
      liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
      mixedTradeLogRepository: {
        appendCompletionIdempotent: () => {
          throw new Error('ordinary cancel must not append protective completion');
        },
      },
    });
    postTrade.start();
    expect(await postTrade.completeRebuildBaseline()).toBeTrue();
    const nativeBuy = fixture.queryObservation;
    const executedPrice = nativeBuy.executedPrice;
    const executionTimeMs = nativeBuy.executionTimeMs;
    if (executedPrice === null || executionTimeMs === null)
      throw new Error('expected complete native BUY price and independent execution time');

    expect(nativeBuy).toMatchObject({
      executedQuantity: 100,
      executedAmount: '100',
      executionTimeMs: nowMs - 1000,
      updatedAtMs: nowMs - 500,
    });

    orderRecorder.commitExecutionFact(
      {
        brokerOrderId: nativeBuy.orderId,
        symbol: nativeBuy.symbol,
        side: nativeBuy.executionSide,
        cumulativeQuantity: nativeBuy.executedQuantity,
        cumulativeAmount: nativeBuy.executedAmount,
        executionTimeMs: nativeBuy.executionTimeMs,
        updatedAtMs: nativeBuy.updatedAtMs,
        phase: nativeBuy.executionPhase,
      },
      true,
      [],
      () =>
        dailyLossTracker.recordCumulativeExecution({
          factStage: nativeBuy.executionPhase,
          direction: 'LONG',
          symbol: nativeBuy.symbol,
          side: nativeBuy.executionSide,
          executedPrice,
          executedQuantity: nativeBuy.executedQuantity,
          executedTimeMs: executionTimeMs,
          orderUpdatedAtMs: nativeBuy.updatedAtMs,
          orderId: nativeBuy.orderId,
        }).admission,
    );
    const originalReceipt = await postTrade.waitForFresh();
    expect(postTrade.isCurrent(originalReceipt)).toBeTrue();
    const originalTransportError = new Error('network timeout');
    let failuresRemaining = 1;
    const nativeFailures: Error[] = [];
    fixture.setCancelBeforeReply(async () => {
      if (failuresRemaining > 0) {
        failuresRemaining--;
        nativeFailures.push(originalTransportError);
        throw originalTransportError;
      }
    });
    const runtimeTimers = createRuntimeTimerHarness(nowMs);
    const originalWork = { live: true };
    const monitor = fixture.createMonitor({
      now: () => new Date(),
      scheduleTimer: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimer: (handle) => {
        clearTimeout(handle);
      },
      rateLimiter: createRateLimiterDouble(),
      cacheManager: fixture.createCacheManager({
        rateLimiter: createRateLimiterDouble(),
        now: () => new Date(),
      }),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () =>
          new Map([
            [
              'BULL.HK',
              {
                symbol: 'BULL.HK',
                name: 'BULL',
                price: '1.01',
                prevClose: '1.01',
                timestamp: Date.now(),
                lotSize: 100,
              },
            ],
          ]),
      }),
      orderRecorder,
      dailyLossTracker,
      orderHoldRegistry: createOrderHoldRegistry(),
      protectiveLiquidationEpisodeTracker: protectiveTracker,
      persistProtectiveLiquidationExecutionProgress: () => {
        throw new Error('ordinary cancel cannot persist protective progress');
      },
      postTradeConsistencyRuntime: postTrade,
      tradingConfig: createTradingConfig({
        global: {
          ...createTradingConfig().global,
          buyOrderTimeout: { enabled: true, timeoutSeconds: 999 },
          sellOrderTimeout: { enabled: true, timeoutSeconds: 0 },
          orderMonitorPriceUpdateInterval: 0,
        },
      }),
      symbolRegistry: createSymbolRegistryDouble(),
      isContinuousTradingAllowed: () => originalWork.live && postTrade.isCurrent(originalReceipt),
      termination: createTerminationDouble({
        reportFatalError: (error) => {
          throw error;
        },
      }),
    });
    try {
      await monitor.initialize();
      await monitor.recoverOrderTrackingFromSnapshot([]);
      monitor.startRuntime();

      orderRecorder.submitSellOrder(
        'SELL-CHAOS-001',
        'BULL.HK',
        'LONG',
        100,
        ['BUY-001'],
        false,
        nowMs,
      );

      monitor.trackOrder({
        orderId: 'SELL-CHAOS-001',
        symbol: 'BULL.HK',
        side: 'SELL',
        executionSide: 'SELL',
        submittedAtMs: nowMs,
        price: '1',
        initialSubmittedPrice: '1',
        quantity: 100,
        isLongSymbol: true,
        monitorSymbol: 'HSI.HK',
        isProtectiveLiquidation: false,
        orderType: 'ELO',
      });
      await runtimeTimers.waitForTimerAt(API.DEFAULT_RETRY_DELAY_MS);

      expect(fixture.nativeCancelOrderIds()).toHaveLength(1);
      expect(fixture.nativeReadCounts().detail).toBe(0);
      expect(fixture.nativeMutations()).toEqual([]);

      await runtimeTimers.advanceBy(API.DEFAULT_RETRY_DELAY_MS);
      await waitForObservedCondition({
        description: '第二次 cancelOrder 调用',
        isSatisfied: () => fixture.nativeCancelOrderIds().length >= 2,
      });
      await runtimeTimers.waitForTimerAt(0);

      expect(fixture.nativeCancelOrderIds()).toHaveLength(2);
      expect(fixture.nativeReadCounts().detail).toBe(0);
      expect(fixture.nativeMutations()).toEqual([]);
      expect(fixture.nativeCancelOrderIds()).toEqual(['SELL-CHAOS-001', 'SELL-CHAOS-001']);
      expect(nativeFailures).toEqual([originalTransportError]);
      expect(orderRecorder.getPendingSellSnapshot()[0]).toMatchObject({
        orderId: 'SELL-CHAOS-001',
        filledQuantity: 0,
        status: 'pending',
      });
      expect(dailyLossTracker.getLossOffset('LONG')).toBe('0');
    } finally {
      originalWork.live = false;
      await monitor.stopRuntimeAndDrain();
      await monitor.teardown();
      await postTrade.stopAndDrain();
      await snapshot.requestClear({ reason: 'STOP', dayEpoch: 1 });
      runtimeTimers.restore();
    }
  });
});
