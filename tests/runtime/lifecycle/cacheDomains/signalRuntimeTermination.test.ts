/** 跨日排空与终态防重开回归，直接调用真实 signal runtime cache domain。 */
import { createDiagnosticObserverDouble } from '../../../helpers/diagnostics.js';
import { describe, expect, it } from 'bun:test';
import { DIAGNOSTIC_OPERATIONS } from '../../../../src/constants/diagnostics.js';
import type { DiagnosticFields } from '../../../../src/types/diagnostics.js';
import { createOpenRebuildContextFixture } from '../fixtures/openRebuildContext.js';
import { createSignalRuntimeDomain } from '../../../../src/runtime/lifecycle/cacheDomains/signalRuntimeDomain.js';
import { createTerminationRuntime } from '../../../../src/runtime/lifecycle/terminationRuntime.js';
import { createDayLifecycleManager } from '../../../../src/runtime/lifecycle/dayLifecycleManager.js';
import { createTimeWakeupRuntime } from '../../../../src/runtime/timeWakeupRuntime/index.js';
import { createEmptySnapshotFixture } from '../../../helpers/accountPositionSnapshot.js';
import type { LifecycleMutableState } from '../../../../src/types/lifecycle.js';
import type { SignalRuntimeDomainDeps } from '../../../../src/runtime/lifecycle/cacheDomains/types.js';
import {
  createBuyTaskQueue,
  createSellTaskQueue,
} from '../../../../src/runtime/asyncProgram/tradeTaskQueue/index.js';
import { createMonitorTaskQueue } from '../../../../src/runtime/asyncProgram/monitorTaskQueue/index.js';
import type { MonitorTaskDataMap } from '../../../../src/runtime/asyncProgram/monitorTaskProcessor/types.js';
import { createLoggerDouble, createMonitorContextDouble } from '../../../helpers/testDoubles.js';

function harness() {
  const calls: string[] = [];
  const queueEvents: DiagnosticFields[] = [];
  const diagnostics = {
    record: (operation: string, fields: DiagnosticFields) => {
      if (operation === DIAGNOSTIC_OPERATIONS.SIGNAL_QUEUE_EVENT) queueEvents.push(fields);
    },
  };
  const owner = {
    start: () => {
      calls.push('start');
    },
    stop: () => {},
    stopAndDrain: async () => {},
    restart: () => {
      calls.push('restart');
    },
  };
  const termination = createTerminationRuntime({
    closeTradingGate: () => {},
    closeProducerAdmission: () => {},
    stopProducers: [],
    onSecondaryError: () => {},
  });
  const originalStrategy = createMonitorContextDouble().strategy;
  const strategy = {
    ...originalStrategy,
    resetForTradingDay: () => {
      calls.push('strategy.reset');
    },
  };
  const deps: SignalRuntimeDomainDeps = {
    termination,
    logger: createLoggerDouble(),
    monitorContext: createMonitorContextDouble({ strategy }),
    buyProcessor: owner,
    sellProcessor: owner,
    monitorTaskProcessor: owner,
    businessEventProgram: owner,
    tradingRiskEventRuntime: owner,
    monitorQuoteEventRuntime: owner,
    monitorDisplayRuntime: owner,
    tradingQuoteDisplayRuntime: owner,
    switchWakeupRuntime: owner,
    periodicSwitchWakeupRuntime: owner,
    autoSearchWakeupRuntime: owner,
    quoteSubscriptionRuntime: {
      ...owner,
      reconcileFromCurrentTruth: async () => {},
      stopAndDrain: async () => {
        calls.push('quote.stop');
      },
    },
    seatActivationDispatcher: owner,
    seatRuntimeCleanupDispatcher: owner,
    orderMonitor: {
      startRuntime: () => {
        calls.push('tradeRuntime.start');
      },
      stopRuntimeAndDrain: async () => {
        calls.push('orders.drain');
      },
    },
    postTradeConsistencyRuntime: {
      abortWaiting: () => {},
      resetAbort: () => {},
      start: () => {},
      completeRebuildBaseline: async () => true,
      stopAndDrain: async () => {
        calls.push('postTrade.drain');
      },
      midnightClear: () => {
        calls.push('postTrade.clear');
      },
    },
    buyTaskQueue: createBuyTaskQueue({
      clock: { now: () => new Date() },
      diagnostics,
    }),
    sellTaskQueue: createSellTaskQueue({
      clock: { now: () => new Date() },
      diagnostics,
    }),
    monitorTaskQueue: createMonitorTaskQueue<MonitorTaskDataMap>({
      logger: createLoggerDouble(),
      clock: { now: () => new Date() },
      diagnostics: createDiagnosticObserverDouble(),
    }),
  };
  const context = {
    now: new Date('2026-05-01T00:00:00+08:00'),
    runtime: { dayKey: '2026-05-01', canTradeNow: false, isTradingDay: true },
  };
  return { deps, calls, termination, context, strategy, queueEvents };
}

describe('signal runtime cross-day safety', () => {
  it('resets the same strategy after order/PostTrade/Quote drain, never destroys it at midnight', async () => {
    const h = harness();
    const domain = createSignalRuntimeDomain(h.deps);
    h.deps.buyTaskQueue.push({
      type: 'STRATEGY_BUY',
      data: {
        symbol: 'BUY.HK',
        symbolName: null,
        action: 'BUYCALL',
        seatVersion: 1,
      },
    });

    h.deps.sellTaskQueue.push({
      type: 'STRATEGY_SELL',
      data: {
        symbol: 'SELL.HK',
        symbolName: null,
        action: 'SELLCALL',
        seatVersion: 2,
      },
    });

    await domain.midnightClear(h.context);
    expect(
      h.queueEvents
        .filter((event) => event['outcome'] === 'CLEARED')
        .map(({ symbol, reasonCode }) => ({ symbol, reasonCode })),
    ).toEqual([
      { symbol: 'BUY.HK', reasonCode: 'DAY_CLEAR' },
      { symbol: 'SELL.HK', reasonCode: 'DAY_CLEAR' },
    ]);
    expect(h.deps.monitorContext.strategy).toBe(h.strategy);
    expect(h.calls).toEqual([
      'orders.drain',
      'postTrade.drain',
      'quote.stop',
      'strategy.reset',
      'postTrade.clear',
    ]);
  });

  it('midnight failure stops all subsequent phases instead of best effort', async () => {
    const h = harness();
    const failure = new Error('postTrade internal failure');
    const domain = createSignalRuntimeDomain({
      ...h.deps,
      postTradeConsistencyRuntime: {
        ...h.deps.postTradeConsistencyRuntime,
        stopAndDrain: async () => {
          throw failure;
        },
      },
    });
    let caught: unknown;
    try {
      await domain.midnightClear(h.context);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(failure);
    expect(h.calls).toEqual(['orders.drain']);
  });

  it('waits for PostTrade positions callback before stopping Quote and resetting strategy', async () => {
    const h = harness();
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const domain = createSignalRuntimeDomain({
      ...h.deps,
      postTradeConsistencyRuntime: {
        ...h.deps.postTradeConsistencyRuntime,
        stopAndDrain: async () => {
          await pending;
          h.calls.push('positions.committed');
        },
      },
    });
    const clearing = domain.midnightClear(h.context);
    for (let index = 0; index < 30; index++) await Promise.resolve();

    expect(h.calls).toEqual(['orders.drain']);
    release?.();
    await clearing;
    expect(h.calls.indexOf('quote.stop')).toBeGreaterThan(h.calls.indexOf('positions.committed'));
    expect(h.calls.indexOf('strategy.reset')).toBeGreaterThan(h.calls.indexOf('quote.stop'));
  });

  it('TimeWakeup 内的午夜清理不 self-drain，交易关闭后仍安排并执行后续时间评估', async () => {
    const h = harness();
    const draining = Promise.withResolvers<undefined>();
    const drainStarted = Promise.withResolvers<undefined>();
    const domain = createSignalRuntimeDomain({
      ...h.deps,
      postTradeConsistencyRuntime: {
        ...h.deps.postTradeConsistencyRuntime,
        stopAndDrain: async () => {
          drainStarted.resolve();
          await draining.promise;
          h.calls.push('postTrade.drain');
        },
      },
    });
    const mutableState: LifecycleMutableState = {
      currentDayKey: '2026-04-30',
      lifecycleState: 'ACTIVE',
      pendingOpenRebuild: false,
      isTradingEnabled: true,
    };
    const manager = createDayLifecycleManager({
      diagnostics: createDiagnosticObserverDouble(),
      termination: h.termination,
      mutableState,
      cacheDomains: [domain],
      snapshot: createEmptySnapshotFixture(),
      logger: createLoggerDouble(),
    });
    const timers: Array<{ readonly callback: () => void; readonly delayMs: number }> = [];
    let nowMs = h.context.now.getTime();
    let evaluations = 0;
    const runtime = createTimeWakeupRuntime<number>({
      termination: h.termination,
      evaluate: async () => {
        evaluations += 1;
        await manager.tick(new Date(nowMs), h.context.runtime);
        return { plan: { hasWork: true, nextWakeupAtMs: nowMs + 1_000 } };
      },
      now: () => new Date(nowMs),
      scheduleTimer: (callback, delayMs) => {
        timers.push({ callback, delayMs });
        return timers.length;
      },
      clearTimer: () => {},
      logger: createLoggerDouble(),
    });

    const started = runtime.start();
    await drainStarted.promise;
    draining.resolve();
    await started;

    expect(mutableState.lifecycleState).toBe('MIDNIGHT_CLEANED');
    expect(mutableState.pendingOpenRebuild).toBe(true);
    expect(mutableState.isTradingEnabled).toBe(false);
    expect(timers).toHaveLength(1);
    expect(timers[0]?.delayMs).toBe(1_000);
    expect(h.calls).toEqual([
      'orders.drain',
      'postTrade.drain',
      'quote.stop',
      'strategy.reset',
      'postTrade.clear',
    ]);

    nowMs += 1_000;
    timers[0]?.callback();
    await runtime.start();
    expect(evaluations).toBe(2);
    expect(timers).toHaveLength(2);
    expect(mutableState.isTradingEnabled).toBe(false);
    expect(h.termination.isTerminated()).toBe(false);
    await runtime.stopAndDrain();
  });

  it('does not restart any downstream owner after termination while opening quote baseline', async () => {
    const h = harness();
    const domain = createSignalRuntimeDomain({
      ...h.deps,
      quoteSubscriptionRuntime: {
        ...h.deps.quoteSubscriptionRuntime,
        reconcileFromCurrentTruth: async () => {
          h.termination.requestShutdown();
        },
      },
    });
    const ctx = await createOpenRebuildContextFixture({ ...h.context, termination: h.termination });
    const result = await domain.openRebuild(ctx);
    expect(result).toEqual({ status: 'ABORTED' });
    expect(ctx.isCurrent()).toBe(false);
    expect(h.calls).toEqual([]);
  });
});
