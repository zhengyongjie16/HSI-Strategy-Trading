/**
 * app/rebuild 单元测试
 *
 * 覆盖：
 * - executeTradingDayOpenRebuild 固定 loadTradingDayRuntimeSnapshot 参数语义
 * - 同一时间源会同时透传给 load 与 rebuild
 */
import { describe, expect, it } from 'bun:test';
import {
  createTradingDayInfoResolver,
  executeTradingDayOpenRebuild,
} from '../../../src/app/lifecycle/rebuild.js';
import type {
  LoadTradingDayRuntimeSnapshotParams,
  RebuildTradingDayStateParams,
} from '../../../src/main/lifecycle/types.js';
import type { Quote } from '../../../src/types/quote.js';
import type { OrderFact } from '../../../src/types/trade.js';
import { createSnapshotFixture } from '../../main/fixtures/accountPositionSnapshot.js';
import { createTerminationRuntime } from '../../../src/app/runtime/createTerminationRuntime.js';
import { createPostTradeConsistencyRuntime } from '../../../src/app/runtime/createPostTradeConsistencyRuntime.js';
import { createQuoteSubscriptionRuntime } from '../../../src/main/quoteSubscriptionRuntime/index.js';
import { createTradingConfig } from '../../../mock/factories/configFactory.js';
import {
  createAccountSnapshotDouble,
  createDailyLossTrackerDouble,
  createLiquidationCooldownTrackerDouble,
  createMonitorContextDouble,
  createProtectiveLiquidationEpisodeTrackerDouble,
  createTraderDouble,
  createLoggerDouble,
} from '../../helpers/testDoubles.js';

/** 同一 canonical H、真实 S 签发及真实订阅对账 owner；仅外部 IO 受控。 */
async function createOpenHarness() {
  const snapshot = await createSnapshotFixture({
    account: createAccountSnapshotDouble('100000'),
    positions: [],
  });
  const termination = createTerminationRuntime({
    closeTradingGate: () => {},
    closeProducerAdmission: () => {},
    stopProducers: [],
    onSecondaryError: (error) => {
      throw error;
    },
  });
  const monitorContext = createMonitorContextDouble();
  const trader = createTraderDouble();
  const subscribed: string[][] = [];
  const quoteSubscriptionRuntime = createQuoteSubscriptionRuntime({
    snapshot,
    termination,
    trader,
    symbolRegistry: monitorContext.symbolRegistry,
    tradingConfig: createTradingConfig({ monitor: monitorContext.config }),
    lastState: { allTradingSymbols: new Set() },
    logger: createLoggerDouble(),
    marketDataClient: {
      subscribeSymbols: async (symbols) => {
        subscribed.push([...symbols]);
      },
      unsubscribeSymbols: async () => {},
    },
  });
  const postTradeConsistencyRuntime = createPostTradeConsistencyRuntime({
    snapshot,
    termination,
    getTrader: () => trader,
    onPositionsCommitted: (token) =>
      quoteSubscriptionRuntime.reconcilePositionHoldFromCurrentTruth(token),
    scheduler: {
      scheduleTimer: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimer: (handle) => {
        clearTimeout(handle);
      },
    },
  });
  postTradeConsistencyRuntime.bindBusinessDeps({
    monitorContext,
    dailyLossTracker: createDailyLossTrackerDouble(),
    liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
    protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
    mixedTradeLogRepository: {
      appendCompletionIdempotent: () => {
        throw new Error('unexpected episode completion');
      },
    },
  });
  return {
    snapshot,
    termination,
    postTradeConsistencyRuntime,
    quoteSubscriptionRuntime,
    subscribed,
  };
}

describe('app rebuild helpers', () => {
  it('keeps ABORTED from opening business readiness or starting subscription work', async () => {
    const harness = await createOpenHarness();
    let rebuilt = 0;
    const result = await executeTradingDayOpenRebuild({
      ...harness,
      now: new Date('2026-03-09T09:30:00.000Z'),
      loadTradingDayRuntimeSnapshot: async () => ({ status: 'ABORTED' }),
      rebuildTradingDayState: async () => {
        rebuilt += 1;
        return { status: 'ABORTED' };
      },
    });
    expect(result.status).toBe('ABORTED');
    expect('snapshotToken' in result).toBe(false);
    expect(rebuilt).toBe(0);
    expect(harness.postTradeConsistencyRuntime.getStatus().started).toBe(false);
    expect(harness.subscribed).toEqual([]);
  });

  it('pursues same-day supersession locally while preserving the captured token through S and subscription', async () => {
    const harness = await createOpenHarness();
    const token = harness.snapshot.getView().token;
    let loads = 0;
    let rebuilds = 0;
    const result = await executeTradingDayOpenRebuild({
      ...harness,
      now: new Date('2026-03-09T09:30:00.000Z'),
      loadTradingDayRuntimeSnapshot: async () => {
        loads += 1;
        return loads === 1
          ? { status: 'SUPERSEDED' }
          : { status: 'COMMITTED', snapshotToken: token, allOrders: [], quotesMap: new Map() };
      },
      rebuildTradingDayState: async ({ snapshotToken }) => {
        rebuilds += 1;
        expect(snapshotToken).toBe(token);
        return rebuilds === 1 ? { status: 'SUPERSEDED' } : { status: 'COMMITTED', snapshotToken };
      },
    });
    expect(loads).toBe(3);
    expect(rebuilds).toBe(2);
    expect(result).toEqual({ status: 'COMMITTED', snapshotToken: token });
    expect(harness.subscribed).toHaveLength(1);
    await harness.postTradeConsistencyRuntime.stopAndDrain();
    await harness.quoteSubscriptionRuntime.stopAndDrain();
  });

  it('preserves internal rebuild failure identity before S readiness or subscription admission', async () => {
    const harness = await createOpenHarness();
    const token = harness.snapshot.getView().token;
    const failure = new TypeError('invalid internal financial state');
    const caught = await executeTradingDayOpenRebuild({
      ...harness,
      now: new Date('2026-03-09T09:30:00.000Z'),
      loadTradingDayRuntimeSnapshot: async () => ({
        status: 'COMMITTED',
        snapshotToken: token,
        allOrders: [],
        quotesMap: new Map(),
      }),
      rebuildTradingDayState: async () => {
        throw failure;
      },
    }).catch((error: unknown) => error);
    expect(caught).toBe(failure);
    expect(harness.postTradeConsistencyRuntime.getStatus().started).toBe(false);
    expect(harness.subscribed).toEqual([]);
  });

  it('rethrows trading-day resolver failures without treating the day as non-trading', async () => {
    const thrownError = new Error('trading day service unavailable');
    const resolveErrors: unknown[] = [];
    let lookupCalls = 0;
    const resolveTradingDayInfo = createTradingDayInfoResolver({
      marketDataClient: {
        isTradingDay: async () => {
          lookupCalls += 1;
          throw thrownError;
        },
      },
      getHKDateKey: () => '2026-03-09',
      onResolveError: (error) => {
        resolveErrors.push(error);
      },
    });

    let caught: unknown = null;
    try {
      await resolveTradingDayInfo(new Date('2026-03-09T09:30:00.000Z'));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(thrownError);
    expect(resolveErrors).toEqual([thrownError]);
    expect(lookupCalls).toBe(1);
  });

  it('executes open rebuild with fixed snapshot flags and shared now', async () => {
    const now = new Date('2026-03-09T09:30:00.000Z');
    const calls: LoadTradingDayRuntimeSnapshotParams[] = [];
    const allOrders: ReadonlyArray<OrderFact> = [
      {
        orderId: '1',
        symbol: 'HSI-BULL.HK',
        stockName: 'HSI BULL',
        remark: '',
        executionSide: 'BUY',
        executionStatus: 'FILLED',
        executionPhase: 'TERMINAL',
        status: 'FILLED',
        orderType: 'LO',
        quantity: 100,
        executedQuantity: 100,
        price: '1',
        executedPrice: '1',
        executedAmount: '100',
        submittedAt: new Date(now),
        executionTimeMs: now.getTime(),
        updatedAtMs: now.getTime(),
        updatedAt: new Date(now),
      },
    ];
    const quotesMap = new Map<string, Quote | null>([['HSI.HK', null]]);
    const rebuildCalls: RebuildTradingDayStateParams[] = [];

    const harness = await createOpenHarness();
    const capturedToken = harness.snapshot.getView().token;
    const result = await executeTradingDayOpenRebuild({
      ...harness,
      now,
      loadTradingDayRuntimeSnapshot: async (params) => {
        calls.push(params);
        return {
          status: 'COMMITTED',
          snapshotToken: capturedToken,
          allOrders,
          quotesMap,
        };
      },
      rebuildTradingDayState: async (params) => {
        rebuildCalls.push(params);
        return { status: 'COMMITTED', snapshotToken: params.snapshotToken };
      },
    });

    expect(calls).toEqual([
      {
        now,
        requireTradingDay: true,
        resetRuntimeSubscriptions: true,
        hydrateCooldownFromTradeLog: true,
        source: 'OPEN_REBUILD',
      },
    ]);

    expect(rebuildCalls).toEqual([
      {
        snapshotToken: capturedToken,
        allOrders,
        quotesMap,
        now,
      },
    ]);
    expect(result.status).toBe('COMMITTED');
    if (result.status !== 'COMMITTED') throw new Error('expected committed open rebuild');

    expect(result.snapshotToken).toBe(capturedToken);
    expect(harness.subscribed.flat()).toContain('HSI.HK');
    const receipt = await harness.postTradeConsistencyRuntime.waitForFresh();
    expect(receipt.snapshotToken).toBe(capturedToken);
    expect(harness.postTradeConsistencyRuntime.isCurrent(receipt)).toBe(true);
    await harness.postTradeConsistencyRuntime.stopAndDrain();
    await harness.quoteSubscriptionRuntime.stopAndDrain();
  });
});
