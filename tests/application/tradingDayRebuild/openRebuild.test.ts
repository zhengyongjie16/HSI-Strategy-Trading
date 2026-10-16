/**
 * 开盘整轮重建单元测试
 *
 * 覆盖：
 * - executeTradingDayOpenRebuild 固定 loadTradingDayRuntimeSnapshot 参数语义
 * - 同一时间源会同时透传给 load 与 rebuild
 */
import { describe, expect, it } from 'bun:test';
import { executeTradingDayOpenRebuild } from '../../../src/application/tradingDayRebuild/openRebuild.js';
import type {
  LoadTradingDayRuntimeSnapshotParams,
  RebuildTradingDayStateParams,
} from '../../../src/application/tradingDayRebuild/types.js';
import type { Quote } from '../../../src/types/quote.js';
import type { OrderFact } from '../../../src/types/trade.js';
import { createRebuildHarness } from './fixtures.js';

describe('trading day open rebuild', () => {
  it('keeps ABORTED from opening business readiness or starting subscription work', async () => {
    const harness = await createRebuildHarness();
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
    const harness = await createRebuildHarness();
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
    const harness = await createRebuildHarness();
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

    const harness = await createRebuildHarness();
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
