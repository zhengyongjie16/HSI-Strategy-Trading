import type { RuntimeStateFixtures } from '../../helpers/types.js';

/**
 * 启动初次重建用例测试。
 * 保留原 runApp 的完成条件、本地重载和 API pending 策略；不测试普通 runtime 启停接线。
 */
import { describe, expect, it } from 'bun:test';
import { executeStartupRebuild } from '../../../src/application/tradingDayRebuild/startupRebuild.js';
import { loadStartupSnapshot } from '../../../src/application/tradingDayRebuild/startupSnapshot.js';
import { applyStartupSnapshotFailureState } from '../../../src/application/tradingDayRebuild/startupFailureState.js';
import type { ExecuteStartupRebuildParams } from '../../../src/application/tradingDayRebuild/types.js';
import type { Quote } from '../../../src/types/quote.js';
import { createExternalApiRequestError } from '../../helpers/createExternalApiRequestError.js';
import { createLoggerDouble } from '../../helpers/testDoubles.js';
import { createRebuildHarness } from './fixtures.js';

/** 仅补齐 startup 的原始装配参数，H/S/订阅仍使用真实 owner。 */
async function createStartupHarness() {
  const harness = await createRebuildHarness();
  const now = new Date('2026-03-09T09:31:00.000Z');
  const token = harness.snapshot.getView().token;
  const quotesMap = new Map<string, Quote | null>();
  const stateFixtures: RuntimeStateFixtures = {
    tradingTimeState: { canTrade: true, isHalfDay: false, openProtectionActive: false },
    lifecycleState: {
      currentDayKey: '2026-03-09',
      lifecycleState: 'ACTIVE',
      pendingOpenRebuild: false,
      isTradingEnabled: false,
    },
    tradingCalendarState: { cachedTradingDayInfo: null, tradingCalendarSnapshot: new Map() },
    quoteSubscriptionState: { allTradingSymbols: new Set() },
  };
  const params: ExecuteStartupRebuildParams = {
    ...harness,
    now,
    ...stateFixtures,
    startupSnapshot: { kind: 'READY', snapshotToken: token, allOrders: [], quotesMap, now },
    loadStartupSnapshot,
    loadTradingDayRuntimeSnapshot: async () => ({
      status: 'COMMITTED',
      snapshotToken: token,
      allOrders: [],
      quotesMap,
    }),
    rebuildTradingDayState: async ({ snapshotToken }) => ({ status: 'COMMITTED', snapshotToken }),
    applyStartupSnapshotFailureState,
    validateRuntimeSymbols: () => ({ valid: true }),
    syncMonitorContextSymbolNames: () => {},
    logger: createLoggerDouble(),
    formatError: String,
  };
  return { ...harness, params, token, quotesMap };
}

describe('startup rebuild', () => {
  it('requires the captured token, full subscription reconcile and real S freshness before commit', async () => {
    const harness = await createStartupHarness();
    const rebuildInputs: Date[] = [];
    const result = await executeStartupRebuild({
      ...harness.params,
      rebuildTradingDayState: async ({ now, snapshotToken }) => {
        rebuildInputs.push(now);
        expect(snapshotToken).toBe(harness.token);
        return { status: 'COMMITTED', snapshotToken };
      },
    });
    expect(result).toEqual({ status: 'COMMITTED', snapshotToken: harness.token });
    expect(rebuildInputs).toEqual([harness.params.now]);
    expect(harness.subscribed.flat()).toContain('HSI.HK');
    const fresh = await harness.postTradeConsistencyRuntime.waitForFresh();
    expect(fresh.snapshotToken).toBe(harness.token);
    expect(harness.postTradeConsistencyRuntime.isCurrent(fresh)).toBe(true);
    await harness.postTradeConsistencyRuntime.stopAndDrain();
    await harness.quoteSubscriptionRuntime.stopAndDrain();
  });

  it('owns supersession and false-baseline reloads with startup flags, validation and symbol-name synchronization', async () => {
    const harness = await createStartupHarness();
    let rebuilds = 0;
    let baselines = 0;
    let loads = 0;
    let validations = 0;
    let nameSyncs = 0;
    const result = await executeStartupRebuild({
      ...harness.params,
      rebuildTradingDayState: async ({ snapshotToken }) => {
        rebuilds += 1;
        return rebuilds === 1 ? { status: 'SUPERSEDED' } : { status: 'COMMITTED', snapshotToken };
      },
      postTradeConsistencyRuntime: {
        ...harness.postTradeConsistencyRuntime,
        completeRebuildBaseline: async () => {
          baselines += 1;
          return baselines === 1
            ? false
            : harness.postTradeConsistencyRuntime.completeRebuildBaseline();
        },
      },
      loadTradingDayRuntimeSnapshot: async (params) => {
        loads += 1;
        expect(params).toEqual({
          now: harness.params.now,
          requireTradingDay: false,
          resetRuntimeSubscriptions: false,
          hydrateCooldownFromTradeLog: true,
          source: 'STARTUP',
        });
        return {
          status: 'COMMITTED',
          snapshotToken: harness.token,
          allOrders: [],
          quotesMap: harness.quotesMap,
        };
      },
      validateRuntimeSymbols: ({ positions, quotesMap }) => {
        validations += 1;
        expect(positions).toBe(harness.snapshot.getView().positions);
        expect(quotesMap).toBe(harness.quotesMap);
        return { valid: true };
      },
      syncMonitorContextSymbolNames: ({ quotesMap }) => {
        nameSyncs += 1;
        expect(quotesMap).toBe(harness.quotesMap);
      },
    });
    expect(result).toEqual({ status: 'COMMITTED', snapshotToken: harness.token });
    expect({ rebuilds, baselines, loads, validations, nameSyncs }).toEqual({
      rebuilds: 3,
      baselines: 2,
      loads: 2,
      validations: 2,
      nameSyncs: 2,
    });
    await harness.postTradeConsistencyRuntime.stopAndDrain();
    await harness.quoteSubscriptionRuntime.stopAndDrain();
  });

  it('keeps an API-pending startup static without rebuilding or starting S', async () => {
    const harness = await createStartupHarness();
    let rebuilds = 0;
    const result = await executeStartupRebuild({
      ...harness.params,
      startupSnapshot: { kind: 'API_RETRY_PENDING', now: harness.params.now },
      rebuildTradingDayState: async () => {
        rebuilds += 1;
        return { status: 'ABORTED' };
      },
    });
    expect(result).toEqual({ status: 'API_RETRY_PENDING' });
    expect(rebuilds).toBe(0);
    expect(harness.postTradeConsistencyRuntime.getStatus().started).toBe(false);
    expect(harness.subscribed).toEqual([]);
  });

  it('keeps the original external failure policy but rethrows internal failure identity', async () => {
    const harness = await createStartupHarness();
    const external = await createExternalApiRequestError({
      operation: 'test.startupRebuild',
      attempts: 1,
      cause: new Error('quote request failed'),
    });
    const result = await executeStartupRebuild({
      ...harness.params,
      rebuildTradingDayState: async () => {
        throw external;
      },
    });
    expect(result).toEqual({ status: 'API_RETRY_PENDING' });
    expect(harness.params.lifecycleState.pendingOpenRebuild).toBe(true);
    expect(harness.params.lifecycleState.lifecycleState).toBe('OPEN_REBUILD_FAILED');
    expect(harness.params.lifecycleState.isTradingEnabled).toBe(false);
    expect(harness.postTradeConsistencyRuntime.getStatus().started).toBe(false);

    const internal = new TypeError('invalid financial state');
    const caught = await executeStartupRebuild({
      ...harness.params,
      rebuildTradingDayState: async () => {
        throw internal;
      },
    }).catch((error: unknown) => error);
    expect(caught).toBe(internal);
    expect(harness.subscribed).toEqual([]);
  });

  it('does not accept a rebuild that replaces the captured token or finishes after termination', async () => {
    const harness = await createStartupHarness();
    const mismatch = await executeStartupRebuild({
      ...harness.params,
      rebuildTradingDayState: async ({ snapshotToken }) => ({
        status: 'COMMITTED',
        snapshotToken: { ...snapshotToken, commitRevision: snapshotToken.commitRevision + 1 },
      }),
    }).catch((error: unknown) => error);
    expect(mismatch).toBeInstanceOf(TypeError);
    expect(harness.subscribed).toEqual([]);

    const aborted = await executeStartupRebuild({
      ...harness.params,
      rebuildTradingDayState: async ({ snapshotToken }) => {
        harness.termination.requestShutdown();
        return { status: 'COMMITTED', snapshotToken };
      },
    });
    expect(aborted).toEqual({ status: 'ABORTED' });
    expect(harness.postTradeConsistencyRuntime.getStatus().started).toBe(false);
    expect(harness.subscribed).toEqual([]);
  });
});
