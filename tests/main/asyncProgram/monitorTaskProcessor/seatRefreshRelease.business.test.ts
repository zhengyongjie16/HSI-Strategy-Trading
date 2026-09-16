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
import { createExternalApiRequestError } from '../../../helpers/createExternalApiRequestError.js';
import {
  createMarketDataClientDouble,
  createQuoteDouble,
  createQuoteSubscriptionRuntimeDouble,
  createTraderDouble,
} from '../../../helpers/testDoubles.js';
import { createLastState, createMonitorContext, waitUntil } from '../utils.js';

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
    callPrice: 20_000,
  });
  return context;
}

function createSeatRefreshTask(): SeatRefreshTask {
  return {
    id: 'seat-refresh-release-task',
    type: 'SEAT_REFRESH',
    dedupeKey: 'SEAT_REFRESH:LONG:RELEASE',
    data: {
      direction: 'LONG',
      seatVersion: 2,
      previousSymbol: 'OLD_BULL.HK',
      nextSymbol: 'BULL.HK',
      callPrice: 20_000,
      symbolName: 'BULL.HK',
    },
  };
}

function createRefreshHelpers(): RefreshHelpers {
  return {
    ensureAllOrders: async () => [],
    refreshAccountCaches: async () => {},
  };
}

function createSuccessMarketDataClient(): ReturnType<typeof createMarketDataClientDouble> {
  return createMarketDataClientDouble({
    getQuotes: async () =>
      new Map<string, Quote>([
        ['BULL.HK', createQuoteDouble('BULL.HK', 1.1, 100)],
        ['OLD_BULL.HK', createQuoteDouble('OLD_BULL.HK', 1, 100)],
      ]),
  });
}

async function captureHandlerFailure(
  params: Readonly<{
    readonly bodyFailure?: unknown;
    readonly releaseFailure?: unknown;
  }>,
): Promise<unknown> {
  const context = createLongActivatingContext();
  const handler = createSeatRefreshHandler({
    clock: { now: () => new Date(70_000) },
    monitorContext: context,
    marketDataClient: createMarketDataClientDouble({
      getQuotes: async () => {
        if ('bodyFailure' in params) {
          throw params.bodyFailure;
        }

        return new Map<string, Quote>([
          ['BULL.HK', createQuoteDouble('BULL.HK', 1.1, 100)],
          ['OLD_BULL.HK', createQuoteDouble('OLD_BULL.HK', 1, 100)],
        ]);
      },
    }),
    quoteSubscriptionRuntime: createQuoteSubscriptionRuntimeDouble({
      releaseRetain: async () => {
        if ('releaseFailure' in params) {
          throw params.releaseFailure;
        }
      },
    }),
    canContinue: () => true,
  });

  try {
    await handler(createSeatRefreshTask(), createRefreshHelpers());
  } catch (error) {
    return error;
  }

  return 'not-thrown';
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
    const context = createLongActivatingContext();
    const releaseFailure = new TypeError('release retain contract broken');
    const handler = createSeatRefreshHandler({
      clock: { now: () => new Date(70_000) },
      monitorContext: context,
      marketDataClient: createSuccessMarketDataClient(),
      quoteSubscriptionRuntime: createQuoteSubscriptionRuntimeDouble({
        releaseRetain: async () => {
          throw releaseFailure;
        },
      }),
      canContinue: () => true,
    });

    let thrown: unknown = 'not-thrown';
    try {
      await handler(createSeatRefreshTask(), createRefreshHelpers());
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(releaseFailure);
    expect(context.symbolRegistry.getSeatState('LONG').status).toBe('ACTIVE');
  });

  for (const rejectionValue of [undefined, null] as const) {
    it(`releaseRetain 以 ${String(rejectionValue)} rejection 结束时不当作无错`, async () => {
      const context = createLongActivatingContext();
      const releaseRejection = createDeferred<undefined>();
      const releaseStarted = createDeferred<null>();
      const handler = createSeatRefreshHandler({
        clock: { now: () => new Date(70_000) },
        monitorContext: context,
        marketDataClient: createSuccessMarketDataClient(),
        quoteSubscriptionRuntime: createQuoteSubscriptionRuntimeDouble({
          releaseRetain: () => {
            releaseStarted.resolve(null);
            return releaseRejection.promise;
          },
        }),
        canContinue: () => true,
      });

      const handling = handler(createSeatRefreshTask(), createRefreshHelpers());
      await releaseStarted.promise;
      releaseRejection.reject(rejectionValue);

      let thrown: unknown = 'not-thrown';
      try {
        await handling;
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBe(rejectionValue);
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
}>;

function createLateFailureHarness(params: {
  readonly getCanProcessTask?: () => boolean;
  readonly isTerminated?: () => boolean;
  readonly releaseFailure?: Error;
}): ProcessorHarness {
  const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
  const context = createLongActivatingContext();
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
    marketDataClient: createMarketDataClientDouble({
      getQuotes: async () => {
        quotesStarted.resolve(null);
        return await quotesResult.promise;
      },
    }),
    quoteSubscriptionRuntime: createQuoteSubscriptionRuntimeDouble({
      releaseRetain: async () => {
        releaseCalls += 1;
        if (params.releaseFailure !== undefined) {
          throw params.releaseFailure;
        }
      },
    }),
    switchWakeupRuntime: { handoffPendingSwitch: () => {} },
    periodicSwitchWakeupRuntime: {
      markWaitingEmpty: () => {},
      clearWaitingEmpty: () => {},
      replanRouteAfterTask: () => {},
    },
    lastState: createLastState(),
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
      direction: 'LONG',
      seatVersion: 2,
      previousSymbol: 'OLD_BULL.HK',
      nextSymbol: 'BULL.HK',
      callPrice: 20_000,
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
  expect(harness.context.symbolRegistry.getSeatVersion('LONG')).toBe(2);
  expect(harness.context.symbolRegistry.getSeatState('LONG')).toMatchObject({
    symbol: 'BULL.HK',
    status: 'ACTIVATING',
    callPrice: 20_000,
  });
}

describe('SEAT_REFRESH late external failure cancellation', () => {
  it('stop 后的迟到外部 API 失败只取消，不 finalize 为 EMPTY', async () => {
    const harness = createLateFailureHarness({});
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
    const harness = createLateFailureHarness({ getCanProcessTask: () => canProcessTask });
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
    const harness = createLateFailureHarness({ isTerminated: () => terminated });
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
    const harness = createLateFailureHarness({});
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
    const harness = createLateFailureHarness({ releaseFailure });
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
    const harness = createLateFailureHarness({});
    await scheduleLateSeatRefresh(harness, { apiRetryAttempt: 1 });

    harness.rejectQuotes(await createLateExternalFailure());
    await waitUntil(() => harness.releaseCalls() === 1);
    await waitUntil(() => harness.context.symbolRegistry.getSeatState('LONG').status === 'EMPTY');

    expect(harness.retryCallbacks).toEqual([]);
    expect(harness.fatalErrors).toEqual([]);
    expect(harness.context.symbolRegistry.getSeatVersion('LONG')).toBe(3);
    expect(harness.context.symbolRegistry.getSeatState('LONG')).toMatchObject({
      symbol: null,
      status: 'EMPTY',
      callPrice: null,
    });
    await harness.processor.stopAndDrain();
  });
});
