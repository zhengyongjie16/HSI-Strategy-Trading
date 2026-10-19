import { createDiagnosticObserverDouble } from '../helpers/diagnostics.js';
import {
  createLoggerDouble,
  createAccountSnapshotDouble,
  createMarketDataClientDouble,
  createMonitorConfigDouble,
  createMonitorContextDouble,
  createOrderRecorderDouble,
  createQuoteDouble,
  createQuoteSubscriptionRuntimeDouble,
  createRiskCheckerDouble,
  createTradeRuntimeDouble,
} from '../helpers/testDoubles.js';

/**
 * M7 真实 dispatcher → latest-only queue → processor/handler 交错测试。
 * 入队 epoch 不被消费时新日洗白；首 await 与失败 retry/耗尽都不能向新日发布旧席位工作。
 */
import { describe, expect, it, spyOn } from 'bun:test';
import { createAccountPositionSnapshot } from '../../src/application/accountPositionSnapshot/index.js';
import { createTerminationRuntime } from '../../src/runtime/lifecycle/terminationRuntime.js';
import { createSeatActivationDispatcher } from '../../src/runtime/seatActivationDispatcher/index.js';
import { createMonitorTaskQueue } from '../../src/runtime/asyncProgram/monitorTaskQueue/index.js';
import { createMonitorTaskRuntimeFixture as createMonitorTaskProcessor } from '../runtime/asyncProgram/monitorTaskProcessor/fixtures.js';
import { createSymbolRegistry } from '../../src/domain/seat/symbolRegistry.js';
import { createExternalApiRequestError } from '../helpers/createExternalApiRequestError.js';
import type { MonitorTaskDataMap } from '../../src/runtime/asyncProgram/monitorTaskProcessor/types.js';
import type { RuntimeScheduler } from '../../src/types/runtime.js';

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

  for (let count = 0; count < 120; count++) await Promise.resolve();
}

async function createHarness(
  options: {
    readonly callPrice?: string | null;
    readonly retain?: () => Promise<void>;
    readonly quotes?: () => Promise<void>;
  } = {},
) {
  const writes: string[] = [];
  const termination = createTerminationRuntime({
    closeTradingGate: () => {},
    closeProducerAdmission: () => {},
    stopProducers: [],
    onSecondaryError: () => {},
  });
  const snapshot = createAccountPositionSnapshot({
    clock: { now: () => new Date() },
    diagnostics: createDiagnosticObserverDouble(),
    dayEpoch: 7,
    scheduler: { schedule: queueMicrotask },
    readPort: {
      getAccountSnapshot: async () => createAccountSnapshotDouble('100000'),
      getStockPositions: async () => [],
    },
    reportFatalError: termination.reportFatalError,
  });
  const config = createMonitorConfigDouble({ monitorSymbol: 'HSI.HK', longSymbol: 'BULL.HK' });
  const registry = createSymbolRegistry(config);
  const queue = createMonitorTaskQueue<MonitorTaskDataMap>({
    logger: createLoggerDouble(),
    clock: { now: () => new Date() },
    diagnostics: createDiagnosticObserverDouble(),
  });
  const timerCallbacks = new Map<ReturnType<typeof setTimeout>, () => void>();
  const scheduler: RuntimeScheduler = {
    scheduleTimer: (callback) => {
      const handle = setTimeout(() => {}, 2_147_483_647);
      clearTimeout(handle);
      timerCallbacks.set(handle, callback);
      return handle;
    },
    clearTimer: (handle) => {
      timerCallbacks.delete(handle);
    },
  };
  const recorder = createOrderRecorderDouble({
    commitRebuildSnapshot: () => {
      writes.push('orders');
      return { status: 'COMMITTED' };
    },
  });
  const context = createMonitorContextDouble({
    config,
    symbolRegistry: registry,
    orderRecorder: recorder,
    riskChecker: createRiskCheckerDouble({
      publishUnrealizedLossData: () => {
        writes.push('risk');
      },
      setWarrantInfoFromCallPrice: () => {
        writes.push('warrant');
        return { status: 'ok' };
      },
    }),
  });
  let quotesRead = 0;
  let retained = 0;
  let released = 0;
  const market = createMarketDataClientDouble({
    getQuotes: async (symbols) => {
      quotesRead++;
      await options.quotes?.();
      return new Map([...symbols].map((symbol) => [symbol, createQuoteDouble(symbol, '10')]));
    },
  });
  const processor = createMonitorTaskProcessor({
    clock: { now: () => new Date('2026-07-10T02:00:00.000Z') },
    scheduler,
    monitorTaskQueue: queue,
    snapshot,
    monitorContext: context,
    tradeRuntime: createTradeRuntimeDouble({
      orderRecorder: { fetchAllOrdersFromAPI: async () => [] },
    }),
    marketDataClient: market,
    quoteSubscriptionRuntime: createQuoteSubscriptionRuntimeDouble({
      retainSymbols: async () => {
        retained++;
        await options.retain?.();
      },
      releaseRetain: async () => {
        released++;
      },
    }),
    switchWakeupRuntime: { handoffPendingSwitch: () => {} },
    periodicSwitchWakeupRuntime: {
      markWaitingEmpty: () => {},
      clearWaitingEmpty: () => {},
      replanRouteAfterTask: () => {},
    },
    getCanTradeNow: () => true,
    getCanProcessTask: () => true,
    termination,
  });
  const dispatcher = createSeatActivationDispatcher({
    logger: createLoggerDouble(),
    snapshot,
    symbolRegistry: registry,
    monitorTaskQueue: queue,
    termination,
  });
  dispatcher.start();
  const activate = (): void => {
    registry.updateSeatState('LONG', {
      ...registry.getSeatState('LONG'),
      status: 'ACTIVATING',
      symbol: 'BULL.HK',
      callPrice: options.callPrice === undefined ? '20000' : options.callPrice,
    });
  };
  activate();
  return {
    snapshot,
    registry,
    queue,
    processor,
    writes,
    termination,
    pendingTimers: () => timerCallbacks.size,
    quotesRead: () => quotesRead,
    retained: () => retained,
    released: () => released,
    runRetry: async () => {
      const entry = timerCallbacks.entries().next().value;
      if (!entry) throw new Error('Expected original delayed retry');

      timerCallbacks.delete(entry[0]);
      entry[1]();
      await flush();
    },
    cleanup: async () => {
      dispatcher.stop();
      await processor.stopAndDrain();
      await snapshot.requestClear({ reason: 'STOP', dayEpoch: snapshot.getView().token.dayEpoch });
    },
  };
}

describe('SEAT_REFRESH queue dayEpoch integration', () => {
  it('producer 捕获入队 epoch；同 symbol/version 跨日迟到 invalid callPrice 也不写 EMPTY', async () => {
    const f = await createHarness({ callPrice: null });
    try {
      const task = f.queue.pop();
      if (task?.type !== 'SEAT_REFRESH') throw new Error('Expected real dispatcher task');

      expect(task.data.dayEpoch).toBe(7);
      const version = f.registry.getSeatVersion('LONG');
      await f.snapshot.requestClear({ reason: 'DAY_CUT', dayEpoch: 8 });
      f.snapshot.openAdmission();
      f.queue.scheduleLatest(task);
      f.processor.start();
      await flush();
      expect(f.registry.getSeatVersion('LONG')).toBe(version);
      expect(f.registry.getSeatState('LONG').status).toBe('ACTIVATING');
      expect(f.retained()).toBe(0);
      expect(f.quotesRead()).toBe(0);
      expect(f.writes).toEqual([]);
      expect(f.termination.getFatalState()).toEqual({ hasFatalError: false });
    } finally {
      await f.cleanup();
    }
  });

  it('首 retain await 中 epoch 切换：release 完整收口，旧任务不进入 quote/order/risk/ACTIVE', async () => {
    const entered = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const f = await createHarness({
      retain: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    try {
      f.processor.start();
      await entered.promise;
      await f.snapshot.requestClear({ reason: 'DAY_CUT', dayEpoch: 8 });
      f.snapshot.openAdmission();
      release.resolve();
      await flush();
      expect(f.retained()).toBe(1);
      expect(f.released()).toBe(1);
      expect(f.quotesRead()).toBe(0);
      expect(f.writes).toEqual([]);
      expect(f.registry.getSeatState('LONG').status).toBe('ACTIVATING');
    } finally {
      release.resolve();
      await f.cleanup();
    }
  });

  it('明确外部失败 retry payload 保留原 epoch，timer 跨日后不重新入队', async () => {
    const fault = await createExternalApiRequestError({
      operation: 'QuoteContext.realtimeQuote',
      attempts: 1,
      cause: new Error('quotes unavailable'),
    });
    const f = await createHarness({
      quotes: async () => {
        throw fault;
      },
    });
    const schedule = spyOn(f.queue, 'scheduleLatest');
    try {
      f.processor.start();
      await flush();
      expect(f.pendingTimers()).toBe(1);
      await f.runRetry();
      expect(
        schedule.mock.calls.map(([task]) =>
          task.type === 'SEAT_REFRESH' ? task.data.dayEpoch : null,
        ),
      ).toEqual([7]);
      expect(f.pendingTimers()).toBe(0);
      expect(f.registry.getSeatState('LONG').status).toBe('EMPTY');
    } finally {
      schedule.mockRestore();
      await f.cleanup();
    }

    const cancelled = await createHarness({
      quotes: async () => {
        throw fault;
      },
    });
    try {
      cancelled.processor.start();
      await flush();
      expect(cancelled.pendingTimers()).toBe(1);
      await cancelled.snapshot.requestClear({ reason: 'DAY_CUT', dayEpoch: 8 });
      cancelled.snapshot.openAdmission();
      await cancelled.runRetry();
      expect(cancelled.quotesRead()).toBe(1);
      expect(cancelled.queue.isEmpty()).toBe(true);
      expect(cancelled.registry.getSeatState('LONG').status).toBe('ACTIVATING');
    } finally {
      await cancelled.cleanup();
    }
  });

  it('已是 retry 的 quotes 外部失败在跨日后迟到，耗尽也不得 EMPTY 当前同版本席位', async () => {
    const entered = Promise.withResolvers<undefined>();
    const reply = Promise.withResolvers<undefined>();
    const fault = await createExternalApiRequestError({
      operation: 'QuoteContext.realtimeQuote',
      attempts: 1,
      cause: new Error('late quotes failure'),
    });
    const f = await createHarness({
      quotes: async () => {
        entered.resolve();
        await reply.promise;
        throw fault;
      },
    });
    try {
      const task = f.queue.pop();
      if (task?.type !== 'SEAT_REFRESH') throw new Error('Expected real dispatcher task');

      f.queue.scheduleLatest({ ...task, data: { ...task.data, apiRetryAttempt: 1 } });
      f.processor.start();
      await entered.promise;
      await f.snapshot.requestClear({ reason: 'DAY_CUT', dayEpoch: 8 });
      f.snapshot.openAdmission();
      reply.resolve();
      await flush();
      expect(f.registry.getSeatState('LONG').status).toBe('ACTIVATING');
      expect(f.pendingTimers()).toBe(0);
      expect(f.writes).toEqual([]);
      expect(f.termination.getFatalState()).toEqual({ hasFatalError: false });
    } finally {
      reply.resolve();
      await f.cleanup();
    }
  });
});
