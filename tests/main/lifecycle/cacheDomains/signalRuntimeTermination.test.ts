/** 跨日排空与终态防重开回归，直接调用真实 signal runtime cache domain。 */
import { describe, expect, it } from 'bun:test';
import { createSignalRuntimeDomain } from '../../../../src/main/lifecycle/cacheDomains/signalRuntimeDomain.js';
import { createTerminationRuntime } from '../../../../src/app/runtime/createTerminationRuntime.js';
import type { SignalRuntimeDomainDeps } from '../../../../src/main/lifecycle/cacheDomains/types.js';
import {
  createBuyTaskQueue,
  createSellTaskQueue,
} from '../../../../src/main/asyncProgram/tradeTaskQueue/index.js';
import { createMonitorTaskQueue } from '../../../../src/main/asyncProgram/monitorTaskQueue/index.js';
import type { MonitorTaskDataMap } from '../../../../src/main/asyncProgram/monitorTaskProcessor/types.js';
import { createLoggerDouble, createMonitorContextDouble } from '../../../helpers/testDoubles.js';

function harness() {
  const calls: string[] = [];
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
    trader: {
      startOrderMonitorRuntime: () => {
        calls.push('trader.start');
      },
      stopOrderMonitorRuntimeAndDrain: async () => {
        calls.push('orders.drain');
      },
    },
    postTradeConsistencyRuntime: {
      abortWaiting: () => {},
      resetAbort: () => {},
      start: () => {},
      completeRebuildBaseline: () => {},
      stopAndDrain: async () => {
        calls.push('postTrade.drain');
      },
      midnightClear: () => {
        calls.push('postTrade.clear');
      },
    },
    buyTaskQueue: createBuyTaskQueue(),
    sellTaskQueue: createSellTaskQueue(),
    monitorTaskQueue: createMonitorTaskQueue<MonitorTaskDataMap>(),
  };
  const context = {
    now: new Date('2026-05-01T00:00:00+08:00'),
    runtime: { dayKey: '2026-05-01', canTradeNow: false, isTradingDay: true },
  };
  return { deps, calls, termination, context, strategy };
}

describe('signal runtime cross-day safety', () => {
  it('resets the same strategy after order/PostTrade/Quote drain, never destroys it at midnight', async () => {
    const h = harness();
    const domain = createSignalRuntimeDomain(h.deps);
    await domain.midnightClear(h.context);
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
    await domain.openRebuild(h.context);
    expect(h.calls).toEqual([]);
  });
});
