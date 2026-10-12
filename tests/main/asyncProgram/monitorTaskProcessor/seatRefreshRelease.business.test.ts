/**
 * seatRefresh release/retry 恢复语义业务测试
 *
 * 覆盖：
 * - releaseRetain 始终完整 await，主体与清理的错误归属（内部错误保留 fatal 身份，双外部聚合后仍外部）
 * - SEAT_REFRESH 外部 API 失败后的取消与重试耗尽区分：取消不 finalize，只有真正耗尽才回落 EMPTY
 */
import { describe, expect, it, spyOn } from 'bun:test';
import { createMonitorTaskProcessor } from '../../../../src/main/asyncProgram/monitorTaskProcessor/index.js';
import { createSeatRefreshHandler } from '../../../../src/main/asyncProgram/monitorTaskProcessor/handlers/seatRefresh.js';
import { isExternalApiRequestError } from '../../../../src/utils/apiFailure/index.js';
import { logger } from '../../../../src/utils/logger/index.js';
import type { MonitorTaskDataMap } from '../../../../src/main/asyncProgram/monitorTaskProcessor/types.js';
import { createMonitorTaskQueue } from '../../../../src/main/asyncProgram/monitorTaskQueue/index.js';
import type { ExternalApiRequestError } from '../../../../src/utils/apiFailure/types.js';
import type { Quote } from '../../../../src/types/quote.js';
import type { RawOrderFromAPI } from '../../../../src/types/services.js';
import { classifyOrdersForRebuild } from '../../../../src/core/orderRecorder/utils.js';
import { createSnapshotFixture } from '../../fixtures/accountPositionSnapshot.js';
import { createExternalApiRequestError } from '../../../helpers/createExternalApiRequestError.js';
import {
  createAccountSnapshotDouble,
  createMarketDataClientDouble,
  createQuoteSubscriptionRuntimeDouble,
  createTraderDouble,
} from '../../../helpers/testDoubles.js';
import { createMonitorContext, waitUntil } from '../utils.js';

type RefreshHandler = ReturnType<typeof createSeatRefreshHandler>;
type RefreshHelpers = Parameters<RefreshHandler>[1];
type SeatRefreshTask = Parameters<RefreshHandler>[0];

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });

  return { promise, resolve, reject };
}

function createLongActivatingContext(): ReturnType<typeof createMonitorContext> {
  const context = createMonitorContext();
  context.symbolRegistry.updateSeatState('LONG', {
    ...context.symbolRegistry.getSeatState('LONG'),
    symbol: 'BULL.HK',
    status: 'ACTIVATING',
    callPrice: '20000',
  });
  return context;
}

function createSeatRefreshTask(): SeatRefreshTask {
  return {
    id: 'seat-refresh-release-task',
    type: 'SEAT_REFRESH',
    dedupeKey: 'SEAT_REFRESH:LONG:RELEASE',
    data: {
      dayEpoch: 0,
      direction: 'LONG',
      seatVersion: 2,
      previousSymbol: 'OLD_BULL.HK',
      nextSymbol: 'BULL.HK',
      callPrice: '20000',
      symbolName: 'BULL.HK',
    },
  };
}

function createExecutionQuote(symbol: string, price: string): Quote {
  return { symbol, name: symbol, price, prevClose: price, timestamp: 70_000, lotSize: 100 };
}

async function createActivationProtocolFixture() {
  const context = createLongActivatingContext();
  const snapshot = await createSnapshotFixture({
    account: createAccountSnapshotDouble('100000'),
    positions: [],
  });
  const capturedToken = snapshot.getView().token;
  const stages: string[] = [];
  const prepared: Array<ReturnType<typeof context.riskChecker.prepareUnrealizedLossData>> = [];
  const published: Array<ReturnType<typeof context.riskChecker.prepareUnrealizedLossData>> = [];
  const allOrders: ReadonlyArray<RawOrderFromAPI> = [];
  context.orderRecorder.fetchAllOrdersFromAPI = async () => {
    stages.push('orders');
    return allOrders;
  };

  context.orderRecorder.validateRebuildSnapshot = (symbol, orders) => {
    stages.push(`preflight:${symbol}`);
    expect(orders).toBe(allOrders);
    classifyOrdersForRebuild(orders.filter((order) => order.symbol === symbol));
  };

  context.orderRecorder.commitRebuildSnapshot = (targets, orders, isCurrent, mode) => {
    stages.push('commit');
    expect(targets).toEqual([
      { symbol: 'BULL.HK', isLongSymbol: true },
      { symbol: 'BEAR.HK', isLongSymbol: false },
      { symbol: 'OLD_BULL.HK', isLongSymbol: true },
    ]);
    expect(orders).toBe(allOrders);
    expect(mode).toBe('ACTIVATION');
    expect(snapshot.getView().token).toEqual(capturedToken);
    if (!isCurrent()) return { status: 'ABORTED' };

    return { status: 'COMMITTED', receipts: [] };
  };
  context.dailyLossTracker.getLossOffset = () => '0';
  context.riskChecker.prepareUnrealizedLossData = (recorder, symbol, isLong, offset) => {
    stages.push('prepare');
    expect(recorder).toBe(context.orderRecorder);
    expect(symbol).toBe('BULL.HK');
    expect(isLong).toBe(true);
    expect(offset).toBe('0');
    const candidate = Object.freeze({ symbol, data: Object.freeze({ r1: '0', n1: 0 }) });
    prepared.push(candidate);
    return candidate;
  };

  context.riskChecker.publishUnrealizedLossData = (candidate) => {
    stages.push('publish');
    expect(prepared).toEqual([candidate]);
    const preparedCandidate = prepared[0];
    if (preparedCandidate === undefined) throw new Error('publish 之前必须完成 prepare');

    expect(candidate).toBe(preparedCandidate);
    published.push(candidate);
  };
  const helpers: RefreshHelpers = {
    ensureAllOrders: () => context.orderRecorder.fetchAllOrdersFromAPI(),
    requestAccountPositionRefresh: (dayEpoch) => {
      stages.push('request');
      expect(dayEpoch).toBe(capturedToken.dayEpoch);
      const handle = snapshot.requestRefresh({
        source: 'SEAT_ACTIVATION',
        dayEpoch,
        refreshAccount: true,
        refreshPositions: true,
      });
      return {
        result: handle.result.then((receipt) => {
          stages.push('receipt');
          expect(receipt.status).toBe('COMMITTED');
          return receipt;
        }),
        cancel: () => {
          stages.push('cancel');
          handle.cancel();
        },
        cancelIfNotIssued: () => {
          handle.cancelIfNotIssued();
        },
      };
    },
  };
  return { context, snapshot, capturedToken, stages, prepared, published, helpers };
}

function createObservedQuoteRuntime(
  protocol: Awaited<ReturnType<typeof createActivationProtocolFixture>>,
  release: () => Promise<void>,
) {
  return createQuoteSubscriptionRuntimeDouble({
    retainSymbols: async ({ symbols }) => {
      protocol.stages.push('retain');
      expect(symbols).toEqual(['BULL.HK', 'OLD_BULL.HK']);
    },
    waitForAdmission: async (symbols) => {
      protocol.stages.push('admission');
      expect(symbols).toEqual(['BULL.HK', 'OLD_BULL.HK']);
    },
    reconcilePositionHoldFromCurrentTruth: async (token) => {
      protocol.stages.push('reconcile');
      expect(token).toEqual(protocol.snapshot.getView().token);
      expect(
        protocol.snapshot.isCurrent(token, { account: true, positions: true, paired: true }),
      ).toBe(true);
    },
    releaseRetain: async () => {
      protocol.stages.push('release');
      await release();
    },
  });
}

function expectSuccessfulActivationStages(
  protocol: Awaited<ReturnType<typeof createActivationProtocolFixture>>,
): void {
  expect(protocol.stages).toEqual([
    'retain',
    'admission',
    'quotes',
    'orders',
    'preflight:BULL.HK',
    'preflight:OLD_BULL.HK',
    'preflight:BEAR.HK',
    'commit',
    'request',
    'receipt',
    'cancel',
    'reconcile',
    'prepare',
    'publish',
    'release',
  ]);
  expect(protocol.prepared).toHaveLength(1);
  expect(protocol.published).toEqual(protocol.prepared);
  expect(protocol.context.symbolRegistry.getSeatState('LONG').status).toBe('ACTIVE');
}

function createSuccessMarketDataClient(
  protocol: Awaited<ReturnType<typeof createActivationProtocolFixture>>,
): ReturnType<typeof createMarketDataClientDouble> {
  return createMarketDataClientDouble({
    getQuotes: async () => {
      protocol.stages.push('quotes');
      return new Map<string, Quote>([
        ['BULL.HK', createExecutionQuote('BULL.HK', '1.1')],
        ['OLD_BULL.HK', createExecutionQuote('OLD_BULL.HK', '1')],
      ]);
    },
  });
}

async function captureHandlerFailure(
  params: Readonly<{
    readonly bodyFailure?: unknown;
    readonly releaseFailure?: unknown;
  }>,
): Promise<unknown> {
  const protocol = await createActivationProtocolFixture();
  const context = protocol.context;
  const handler = createSeatRefreshHandler({
    clock: { now: () => new Date(70_000) },
    snapshot: protocol.snapshot,
    monitorContext: context,
    marketDataClient: createMarketDataClientDouble({
      getQuotes: async () => {
        protocol.stages.push('quotes');
        if ('bodyFailure' in params) {
          throw params.bodyFailure;
        }

        return new Map<string, Quote>([
          ['BULL.HK', createExecutionQuote('BULL.HK', '1.1')],
          ['OLD_BULL.HK', createExecutionQuote('OLD_BULL.HK', '1')],
        ]);
      },
    }),
    quoteSubscriptionRuntime: createObservedQuoteRuntime(protocol, async () => {
      if ('releaseFailure' in params) throw params.releaseFailure;
    }),
    canContinue: () => true,
  });

  let thrown: unknown = 'not-thrown';
  try {
    await handler(createSeatRefreshTask(), protocol.helpers);
  } catch (error) {
    thrown = error;
  }

  expect(protocol.stages).toEqual(['retain', 'admission', 'quotes', 'release']);
  expect(protocol.prepared).toEqual([]);
  expect(protocol.published).toEqual([]);
  expect(context.symbolRegistry.getSeatState('LONG').status).toBe('ACTIVATING');
  return thrown;
}

describe('SEAT_REFRESH release error precedence', () => {
  it('保留主体内部错误的 fatal 身份，releaseRetain 外部失败不得替换内部错误', async () => {
    const bodyFailure = new TypeError('order snapshot contract broken');
    const releaseFailure = await createExternalApiRequestError({
      operation: 'QuoteContext.releaseRetain',
      attempts: 1,
      cause: new Error('network'),
    });

    const thrown = await captureHandlerFailure({ bodyFailure, releaseFailure });

    expect(thrown).toBe(bodyFailure);
    expect(isExternalApiRequestError(thrown)).toBeFalse();
  });

  it('主体与清理同为外部 API 失败时聚合后仍保持外部分类', async () => {
    const bodyFailure = await createExternalApiRequestError({
      operation: 'QuoteContext.realtimeQuote',
      attempts: 1,
      cause: new Error('quotes unavailable'),
    });
    const releaseFailure = await createExternalApiRequestError({
      operation: 'QuoteContext.releaseRetain',
      attempts: 1,
      cause: new Error('release unavailable'),
    });

    const thrown = await captureHandlerFailure({ bodyFailure, releaseFailure });

    expect(isExternalApiRequestError(thrown)).toBeTrue();
    expect(thrown instanceof AggregateError).toBeTrue();
    if (!isExternalApiRequestError(thrown) || !(thrown instanceof AggregateError)) {
      throw new Error('expected external aggregate ApiRequestError');
    }

    expect(thrown.operation).toBe('SEAT_REFRESH.releaseRetain');
    expect(thrown.errors).toEqual([bodyFailure, releaseFailure]);
  });

  it('主体外部失败后 releaseRetain 内部失败时保留清理方 fatal 身份', async () => {
    const bodyFailure = await createExternalApiRequestError({
      operation: 'QuoteContext.realtimeQuote',
      attempts: 1,
      cause: new Error('quotes unavailable'),
    });
    const releaseFailure = new TypeError('release retain contract broken');

    const thrown = await captureHandlerFailure({ bodyFailure, releaseFailure });

    expect(thrown).toBe(releaseFailure);
    expect(isExternalApiRequestError(thrown)).toBeFalse();
  });

  it('主体与清理同时内部失败时保留主体 fatal 身份', async () => {
    const bodyFailure = new RangeError('recalculate contract broken');
    const releaseFailure = new TypeError('release retain contract broken');

    const thrown = await captureHandlerFailure({ bodyFailure, releaseFailure });

    expect(thrown).toBe(bodyFailure);
  });

  it('主体内部错误时 releaseRetain 次级诊断格式化抛错不覆盖主体 fatal 身份', async () => {
    const bodyFailure = new TypeError('order snapshot contract broken');
    const releaseFailure = {
      get message(): never {
        throw new Error('release message getter broken');
      },
    };

    const thrown = await captureHandlerFailure({ bodyFailure, releaseFailure });

    expect(thrown).toBe(bodyFailure);
  });

  it('主体内部错误时 releaseRetain 次级诊断 logger 抛错不覆盖主体 fatal 身份', async () => {
    const bodyFailure = new TypeError('order snapshot contract broken');
    const releaseFailure = new TypeError('release retain contract broken');
    const loggerError = spyOn(logger, 'error').mockImplementation(() => {
      throw new Error('logger sink broken');
    });

    try {
      const thrown = await captureHandlerFailure({ bodyFailure, releaseFailure });

      expect(loggerError).toHaveBeenCalledTimes(1);
      expect(thrown).toBe(bodyFailure);
    } finally {
      loggerError.mockRestore();
    }
  });

  it('主体外部失败后 releaseRetain 内部失败时主体次级诊断格式化抛错不覆盖清理 fatal 身份', async () => {
    const bodyFailure = await createExternalApiRequestError({
      operation: 'QuoteContext.realtimeQuote',
      attempts: 1,
      cause: new Error('quotes unavailable'),
    });
    Object.defineProperty(bodyFailure, 'message', {
      configurable: true,
      get: () => {
        throw new Error('body message getter broken');
      },
    });
    const releaseFailure = new TypeError('release retain contract broken');

    expect(isExternalApiRequestError(bodyFailure)).toBeTrue();

    const thrown = await captureHandlerFailure({ bodyFailure, releaseFailure });

    expect(thrown).toBe(releaseFailure);
    expect(isExternalApiRequestError(thrown)).toBeFalse();
  });

  it('主体外部失败后 releaseRetain 内部失败时主体次级诊断 logger 抛错不覆盖清理 fatal 身份', async () => {
    const bodyFailure = await createExternalApiRequestError({
      operation: 'QuoteContext.realtimeQuote',
      attempts: 1,
      cause: new Error('quotes unavailable'),
    });
    const releaseFailure = new TypeError('release retain contract broken');
    const loggerError = spyOn(logger, 'error').mockImplementation(() => {
      throw new Error('logger sink broken');
    });

    try {
      const thrown = await captureHandlerFailure({ bodyFailure, releaseFailure });

      expect(loggerError).toHaveBeenCalledTimes(1);
      expect(thrown).toBe(releaseFailure);
    } finally {
      loggerError.mockRestore();
    }
  });

  for (const bodyRejection of [undefined, null] as const) {
    it(`主体以 ${String(bodyRejection)} rejection 结束且清理内部失败时保留主体 rejection 值`, async () => {
      const releaseFailure = new TypeError('release retain contract broken');

      const thrown = await captureHandlerFailure({
        bodyFailure: bodyRejection,
        releaseFailure,
      });

      expect(thrown).toBe(bodyRejection);
    });
  }

  it('主体成功时 releaseRetain 内部错误仍进入 fatal 通道', async () => {
    const protocol = await createActivationProtocolFixture();
    const context = protocol.context;
    const releaseFailure = new TypeError('release retain contract broken');
    const handler = createSeatRefreshHandler({
      clock: { now: () => new Date(70_000) },
      monitorContext: context,
      snapshot: protocol.snapshot,
      marketDataClient: createSuccessMarketDataClient(protocol),
      quoteSubscriptionRuntime: createObservedQuoteRuntime(protocol, async () => {
        throw releaseFailure;
      }),
      canContinue: () => true,
    });

    let thrown: unknown = 'not-thrown';
    try {
      await handler(createSeatRefreshTask(), protocol.helpers);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(releaseFailure);
    expectSuccessfulActivationStages(protocol);
    expect(context.symbolRegistry.getSeatState('LONG').status).toBe('ACTIVE');
  });

  for (const rejectionValue of [undefined, null] as const) {
    it(`releaseRetain 以 ${String(rejectionValue)} rejection 结束时不当作无错`, async () => {
      const protocol = await createActivationProtocolFixture();
      const context = protocol.context;
      const releaseRejection = createDeferred<undefined>();
      const releaseStarted = createDeferred<null>();
      const handler = createSeatRefreshHandler({
        clock: { now: () => new Date(70_000) },
        monitorContext: context,
        snapshot: protocol.snapshot,
        marketDataClient: createSuccessMarketDataClient(protocol),
        quoteSubscriptionRuntime: createObservedQuoteRuntime(protocol, () => {
          releaseStarted.resolve(null);
          return releaseRejection.promise;
        }),
        canContinue: () => true,
      });

      const handling = handler(createSeatRefreshTask(), protocol.helpers);
      await releaseStarted.promise;
      releaseRejection.reject(rejectionValue);

      let thrown: unknown = 'not-thrown';
      try {
        await handling;
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBe(rejectionValue);
      expectSuccessfulActivationStages(protocol);
    });
  }

  it('主体外部失败且清理成功时保留主体外部分类', async () => {
    const bodyFailure = await createExternalApiRequestError({
      operation: 'QuoteContext.realtimeQuote',
      attempts: 1,
      cause: new Error('quotes unavailable'),
    });

    const thrown = await captureHandlerFailure({ bodyFailure });

    expect(thrown).toBe(bodyFailure);
    expect(isExternalApiRequestError(thrown)).toBeTrue();
  });
});

type ProcessorHarness = Readonly<{
  readonly context: ReturnType<typeof createMonitorContext>;
  readonly queue: ReturnType<typeof createMonitorTaskQueue<MonitorTaskDataMap>>;
  readonly processor: ReturnType<typeof createMonitorTaskProcessor>;
  readonly fatalErrors: Array<unknown>;
  readonly retryCallbacks: Array<() => void>;
  readonly quotesRejected: Promise<null>;
  readonly rejectQuotes: (failure: unknown) => void;
  readonly resolveQuotes: (value: Map<string, Quote | null>) => void;
  readonly releaseCalls: () => number;
  readonly protocol: Awaited<ReturnType<typeof createActivationProtocolFixture>>;
}>;

async function createLateFailureHarness(params: {
  readonly getCanProcessTask?: () => boolean;
  readonly isTerminated?: () => boolean;
  readonly releaseFailure?: Error;
}): Promise<ProcessorHarness> {
  const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
  const protocol = await createActivationProtocolFixture();
  const context = protocol.context;
  const quotesStarted = createDeferred<null>();
  const quotesResult = createDeferred<Map<string, Quote | null>>();
  const fatalErrors: Array<unknown> = [];
  const retryCallbacks: Array<() => void> = [];
  let releaseCalls = 0;

  const processor = createMonitorTaskProcessor({
    clock: { now: () => new Date(70_000) },
    scheduler: {
      scheduleTimer: (callback: () => void) => {
        retryCallbacks.push(callback);
        const handle = setTimeout(() => {}, 0);
        clearTimeout(handle);
        return handle;
      },
      clearTimer: () => {},
    },
    monitorTaskQueue: queue,
    monitorContext: context,
    trader: createTraderDouble({ orderRecorder: context.orderRecorder }),
    snapshot: protocol.snapshot,
    marketDataClient: createMarketDataClientDouble({
      getQuotes: async () => {
        protocol.stages.push('quotes');
        quotesStarted.resolve(null);
        return await quotesResult.promise;
      },
    }),
    quoteSubscriptionRuntime: createObservedQuoteRuntime(protocol, async () => {
      releaseCalls += 1;
      if (params.releaseFailure !== undefined) throw params.releaseFailure;
    }),
    switchWakeupRuntime: { handoffPendingSwitch: () => {} },
    periodicSwitchWakeupRuntime: {
      markWaitingEmpty: () => {},
      clearWaitingEmpty: () => {},
      replanRouteAfterTask: () => {},
    },
    getCanTradeNow: () => true,
    ...(params.getCanProcessTask ? { getCanProcessTask: params.getCanProcessTask } : {}),
    termination: {
      isTerminated: params.isTerminated ?? (() => false),
      reportFatalError: (error: unknown) => {
        fatalErrors.push(error);
      },
    },
  });

  return {
    context,
    queue,
    processor,
    fatalErrors,
    retryCallbacks,
    quotesRejected: quotesStarted.promise,
    rejectQuotes: (failure: unknown) => {
      quotesResult.reject(failure);
    },
    resolveQuotes: (value) => {
      quotesResult.resolve(value);
    },
    releaseCalls: () => releaseCalls,
    protocol,
  };
}

function scheduleLateSeatRefresh(
  harness: ProcessorHarness,
  overrides: Partial<MonitorTaskDataMap['SEAT_REFRESH']> = {},
): Promise<null> {
  harness.processor.start();
  harness.queue.scheduleLatest({
    type: 'SEAT_REFRESH',
    dedupeKey: 'SEAT_REFRESH:LONG:LATE_CANCEL',
    data: {
      dayEpoch: 0,
      direction: 'LONG',
      seatVersion: 2,
      previousSymbol: 'OLD_BULL.HK',
      nextSymbol: 'BULL.HK',
      callPrice: '20000',
      symbolName: 'BULL.HK',
      ...overrides,
    },
  });
  return harness.quotesRejected;
}

async function createLateExternalFailure(): Promise<ExternalApiRequestError> {
  return createExternalApiRequestError({
    operation: 'QuoteContext.realtimeQuote',
    attempts: 1,
    cause: new Error('quotes unavailable'),
  });
}

function expectActivatingSeatKept(harness: ProcessorHarness): void {
  expect(harness.protocol.stages).toEqual(['retain', 'admission', 'quotes', 'release']);
  expect(harness.protocol.prepared).toEqual([]);
  expect(harness.protocol.published).toEqual([]);
  expect(harness.context.symbolRegistry.getSeatVersion('LONG')).toBe(2);
  expect(harness.context.symbolRegistry.getSeatState('LONG')).toMatchObject({
    symbol: 'BULL.HK',
    status: 'ACTIVATING',
    callPrice: '20000',
  });
}

describe('SEAT_REFRESH late external failure cancellation', () => {
  it('stop 后的迟到外部 API 失败只取消，不 finalize 为 EMPTY', async () => {
    const harness = await createLateFailureHarness({});
    await scheduleLateSeatRefresh(harness);

    harness.processor.stop();
    harness.rejectQuotes(await createLateExternalFailure());
    await waitUntil(() => harness.releaseCalls() === 1);
    await Bun.sleep(10);

    expect(harness.retryCallbacks).toEqual([]);
    expect(harness.fatalErrors).toEqual([]);
    expectActivatingSeatKept(harness);
    await harness.processor.stopAndDrain();
  });

  it('生命周期门禁关闭后的迟到外部 API 失败只取消，不 finalize 为 EMPTY', async () => {
    let canProcessTask = true;
    const harness = await createLateFailureHarness({ getCanProcessTask: () => canProcessTask });
    await scheduleLateSeatRefresh(harness);

    canProcessTask = false;
    harness.rejectQuotes(await createLateExternalFailure());
    await waitUntil(() => harness.releaseCalls() === 1);
    await Bun.sleep(10);

    expect(harness.retryCallbacks).toEqual([]);
    expect(harness.fatalErrors).toEqual([]);
    expectActivatingSeatKept(harness);
    await harness.processor.stopAndDrain();
  });

  it('进程终止后的迟到外部 API 失败只取消，不 finalize 为 EMPTY', async () => {
    let terminated = false;
    const harness = await createLateFailureHarness({ isTerminated: () => terminated });
    await scheduleLateSeatRefresh(harness);

    terminated = true;
    harness.rejectQuotes(await createLateExternalFailure());
    await waitUntil(() => harness.releaseCalls() === 1);
    await Bun.sleep(10);

    expect(harness.retryCallbacks).toEqual([]);
    expect(harness.fatalErrors).toEqual([]);
    expectActivatingSeatKept(harness);
    await harness.processor.stopAndDrain();
  });

  it('取消优先于重试耗尽：重试尝试到达后的迟到外部失败同样不 finalize', async () => {
    const harness = await createLateFailureHarness({});
    await scheduleLateSeatRefresh(harness, { apiRetryAttempt: 1 });

    harness.processor.stop();
    harness.rejectQuotes(await createLateExternalFailure());
    await waitUntil(() => harness.releaseCalls() === 1);
    await Bun.sleep(10);

    expect(harness.retryCallbacks).toEqual([]);
    expect(harness.fatalErrors).toEqual([]);
    expectActivatingSeatKept(harness);
    await harness.processor.stopAndDrain();
  });

  it('停止后到达的 releaseRetain 内部错误不会被停止吞掉', async () => {
    const releaseFailure = new TypeError('release retain contract broken');
    const harness = await createLateFailureHarness({ releaseFailure });
    await scheduleLateSeatRefresh(harness);

    harness.processor.stop();
    harness.resolveQuotes(new Map());
    await waitUntil(() => harness.releaseCalls() === 1);
    await waitUntil(() => harness.fatalErrors.length === 1);

    expect(harness.fatalErrors[0]).toBe(releaseFailure);
    expectActivatingSeatKept(harness);
    await harness.processor.stopAndDrain();
  });

  it('运行态下的重试耗尽仍回落 EMPTY 并 bump 版本', async () => {
    const harness = await createLateFailureHarness({});
    await scheduleLateSeatRefresh(harness, { apiRetryAttempt: 1 });

    harness.rejectQuotes(await createLateExternalFailure());
    await waitUntil(() => harness.releaseCalls() === 1);
    await waitUntil(() => harness.context.symbolRegistry.getSeatState('LONG').status === 'EMPTY');

    expect(harness.retryCallbacks).toEqual([]);
    expect(harness.fatalErrors).toEqual([]);
    expect(harness.protocol.stages).toEqual(['retain', 'admission', 'quotes', 'release']);
    expect(harness.protocol.prepared).toEqual([]);
    expect(harness.protocol.published).toEqual([]);
    expect(harness.context.symbolRegistry.getSeatVersion('LONG')).toBe(3);
    expect(harness.context.symbolRegistry.getSeatState('LONG')).toMatchObject({
      symbol: null,
      status: 'EMPTY',
      callPrice: null,
    });
    await harness.processor.stopAndDrain();
  });
});
