/**
 * Monitor 公共操作 fatal 边界：真实 FIFO、broker adapter、提交流程与 worker 共同验证
 * 首个内部错误立即关门，已发出的并发 IO 仍由原 operation ledger 和 worker 完整排空。
 */
import { expect, test } from 'bun:test';
import { createTradingConfig } from '../../../../mock/factories/configFactory.js';
import { API } from '../../../../src/constants/common.js';
import { createSignal } from '../../../../mock/factories/signalFactory.js';
import { createRateLimiter } from '../../../../src/application/orderExecution/rateLimiter.js';
import { createSubmitTargetOrder } from '../../../../src/application/orderExecution/submitFlow.js';
import type { ExecutableOrderCommand } from '../../../../src/application/orderExecution/types.js';
import { createOrderMonitor } from '../../../../src/application/orderTracking/orderMonitor/index.js';
import { wrapExternalApiRequest } from '../../../../src/infrastructure/externalApi/index.js';
import { createBaseProcessor } from '../../../../src/runtime/asyncProgram/processor.js';
import { createSellTaskQueue } from '../../../../src/runtime/asyncProgram/tradeTaskQueue/index.js';
import { createTerminationRuntime } from '../../../../src/runtime/lifecycle/terminationRuntime.js';
import { scheduleBoundedOneShotAt } from '../../../../src/runtime/timer/index.js';
import { isExternalApiRequestError } from '../../../../src/utils/apiFailure/index.js';
import { createDiagnosticObserverDouble } from '../../../helpers/diagnostics.js';
import {
  createLoggerDouble,
  createMarketDataClientDouble,
  createQuoteDouble,
  createRiskCheckerDouble,
  createSymbolRegistryDouble,
} from '../../../helpers/testDoubles.js';
import { createBrokerIngressFixture } from '../../../integration/architectureRefactoringP1Native/trade/brokerIngressFixture.js';
import { createExecutionFixture } from '../recorder/executionFixture.js';

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 100; turn++) await Promise.resolve();
}

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error('expected the public operation to reject');
}

async function setup(orderIds: ReadonlyArray<string> = ['FIRST', 'SECOND']) {
  const nowMs = Date.parse('2026-07-10T02:00:00.000Z');
  let monotonicMs = 0;
  const wait = async (delayMs: number): Promise<void> => {
    monotonicMs += delayMs;
  };
  const logger = createLoggerDouble();
  const diagnostics = createDiagnosticObserverDouble();
  const clock = { now: () => new Date(nowMs) };
  const queue = createSellTaskQueue({ clock, diagnostics });
  const gateClosures: string[] = [];
  const secondaryErrors: unknown[] = [];
  let tradingOpen = true;
  const termination = createTerminationRuntime({
    closeTradingGate: () => {
      tradingOpen = false;
      gateClosures.push('trading');
    },
    closeProducerAdmission: () => {
      queue.close();
      gateClosures.push('producer');
    },
    stopProducers: [],
    onSecondaryError: (error) => {
      secondaryErrors.push(error);
    },
  });
  // 使用生产 FIFO 和配额算法，仅把等待时钟变为确定性推进；不是 immediate limiter double。
  const rateLimiter = createRateLimiter({ logger, wait, nowMonotonicMs: () => monotonicMs });
  const frame = {
    orderId: 'FIRST',
    symbol: 'BULL.HK',
    stockName: 'BULL',
    remark: '',
    side: 'SELL' as const,
    status: 'New' as const,
    orderType: 'LO' as const,
    quantity: '100',
    executedQuantity: '0',
    executedPrice: '0',
    submittedPrice: '1',
    submittedAtMs: nowMs - 1000,
    updatedAtMs: nowMs,
  };
  const native = await createBrokerIngressFixture(frame);
  native.setCancelFailure(new Error('openapi error: code=601011: order already closed'));
  native.failReplace(new Error('openapi error: code=601011: order already closed'));
  native.setOrderDetailReplies(
    orderIds.map((orderId) => ({
      ...frame,
      orderId,
      status: 'Canceled',
      executedQuantity: orderId === 'FIRST' ? '10' : '0',
    })),
  );
  const economic = createExecutionFixture({ rateLimiter, termination, nowMs });
  const detailPort = native.ports.createOrderDetailReadPort();
  const detailErrors: unknown[] = [];
  const tradingConfig = createTradingConfig({
    global: { ...createTradingConfig().global, tradingOrderType: 'LO' },
  });
  const cacheManager = { clearCache: () => {}, getPendingOrders: async () => [] };
  const marketDataClient = createMarketDataClientDouble({
    getQuotes: async () => new Map([['BULL.HK', createQuoteDouble('BULL.HK', '1', 100)]]),
  });
  const tradeMutationPort = native.ports.createTradeMutationPort();
  const monitor = createOrderMonitor({
    logger,
    diagnostics,
    wait,
    requestExternalApi: wrapExternalApiRequest,
    orderDetailReadPort: {
      ...detailPort,
      read: async (orderId) => {
        try {
          return await detailPort.read(orderId);
        } catch (error) {
          detailErrors.push(error);
          throw error;
        }
      },
    },
    orderPushPort: native.ports.createOrderPushPort(),
    tradeMutationPort,
    scheduleBoundedOneShotAt,
    rateLimiter,
    cacheManager,
    marketDataClient,
    orderRecorder: economic.recorder,
    dailyLossTracker: economic.daily,
    orderHoldRegistry: economic.holds,
    protectiveLiquidationEpisodeTracker: economic.episode,
    persistProtectiveLiquidationExecutionProgress: () => {
      throw new Error('ordinary public operations must not persist protection');
    },
    postTradeConsistencyRuntime: economic.sink,
    tradingConfig,
    symbolRegistry: createSymbolRegistryDouble(),
    isContinuousTradingAllowed: () => false,
    termination,
    now: clock.now,
    scheduleTimer: setTimeout,
    clearTimer: clearTimeout,
  });
  await monitor.initialize();
  await monitor.recoverOrderTrackingFromSnapshot([]);
  for (const orderId of orderIds) {
    monitor.trackOrder({
      orderId,
      symbol: frame.symbol,
      side: 'SELL',
      executionSide: 'SELL',
      price: '1',
      initialSubmittedPrice: '1',
      quantity: 100,
      submittedAtMs: frame.submittedAtMs,
      isLongSymbol: true,
      monitorSymbol: tradingConfig.monitor.monitorSymbol,
      isProtectiveLiquidation: false,
      orderType: 'LO',
    });
    economic.recorder.submitSellOrder(orderId, frame.symbol, 'LONG', 100, [], frame.submittedAtMs);
  }

  const submitTargetOrder = createSubmitTargetOrder({
    logger,
    diagnostics,
    readSellPositions: async () => [
      {
        symbol: frame.symbol,
        symbolName: frame.stockName,
        quantity: 500,
        availableQuantity: 500,
        costPrice: '1',
        accountChannel: 'lb',
        currency: 'HKD',
      },
    ],
    tradeMutationPort,
    rateLimiter,
    marketDataClient,
    cacheManager,
    orderMonitor: monitor,
    orderRecorder: economic.recorder,
    globalConfig: tradingConfig.global,
    monitorConfig: tradingConfig.monitor,
    unrealizedLossBuyGate: createRiskCheckerDouble(),
    canExecuteSignal: () => tradingOpen && !termination.isTerminated(),
    canTradeNow: () => ({ canTrade: tradingOpen }),
    recordBuyAttempt: () => {},
    now: clock.now,
  });
  const signal = {
    ...createSignal({ symbol: frame.symbol, action: 'SELLCALL', triggerTimeMs: nowMs }),
    quantity: 100,
  };
  const command: ExecutableOrderCommand = {
    kind: 'SELL',
    signal,
    side: 'SELL',
    direction: 'LONG',
    executionPurpose: 'ORDINARY',
    purpose: 'ORDINARY_SELL',
  };
  return {
    monitor,
    native,
    economic,
    termination,
    gateClosures,
    secondaryErrors,
    detailErrors,
    rateLimiter,
    submitTargetOrder,
    command,
    signal,
    queue,
    logger,
    diagnostics,
  };
}

test('SELL 双撤单首次坏 detail 立即 fatal；另一已发 IO、worker 和公共 ledger 继续排空', async () => {
  const f = await setup();
  const firstStarted = deferred();
  const secondStarted = deferred();
  const firstReply = deferred();
  const secondReply = deferred();
  const permitStarted = deferred();
  const releasePermit = deferred();
  f.native.setOrderDetailBeforeReply(async (orderId) => {
    const first = orderId === 'FIRST';
    (first ? firstStarted : secondStarted).resolve();
    await (first ? firstReply : secondReply).promise;
  });
  let taskSettled = false;
  let taskError: unknown;
  let processedTasks = 0;
  const processor = createBaseProcessor({
    diagnostics: f.diagnostics,
    logger: f.logger,
    loggerPrefix: 'PublicOperationFatalBoundary',
    taskQueue: f.queue,
    termination: f.termination,
    processTask: async () => {
      processedTasks++;
      try {
        await f.submitTargetOrder(f.command, () => !f.termination.isTerminated());
      } catch (error) {
        taskError = error;
        throw error;
      } finally {
        taskSettled = true;
      }
    },
  });
  for (let queued = 0; queued < 2; queued++) {
    f.queue.push({ type: 'STRATEGY_SELL', data: f.signal });
  }

  processor.start();
  try {
    await Promise.all([firstStarted.promise, secondStarted.promise]);
    const heldPermit = f.rateLimiter.withTradeMutation(async () => {
      permitStarted.resolve();
      await releasePermit.promise;
    });
    await permitStarted.promise;
    const queuedCancel = f.monitor.cancelOrder('NOT-ISSUED', { kind: 'ORDER_FACT' });
    firstReply.resolve();
    await flushMicrotasks();

    const originalError = f.detailErrors[0];
    expect(originalError).toBeInstanceOf(TypeError);
    expect(String(originalError)).toContain('invalid cumulative execution quantity/price');
    expect(f.termination.getFatalState()).toEqual({ hasFatalError: true, error: originalError });
    expect(f.gateClosures).toEqual(['trading', 'producer']);
    expect(f.queue.push({ type: 'STRATEGY_SELL', data: f.signal })).toBe(false);
    expect(taskSettled).toBe(false);
    expect(f.native.nativeReadCounts()).toEqual({ cancel: 2, detail: 2 });

    let monitorDrained = false;
    let workerDrained = false;
    const monitorDrain = f.monitor.stopRuntimeAndDrain().then(() => {
      monitorDrained = true;
    });
    const workerDrain = processor.stopAndDrain().then(() => {
      workerDrained = true;
    });
    releasePermit.resolve();
    await heldPermit;
    expect(await queuedCancel).toEqual({ kind: 'UNKNOWN_FAILURE', errorCode: null });
    await flushMicrotasks();
    expect(monitorDrained).toBe(false);
    expect(workerDrained).toBe(false);
    expect(f.native.nativeCancelOrderIds()).toEqual(['FIRST', 'SECOND']);

    secondReply.resolve();
    await Promise.all([monitorDrain, workerDrain]);
    expect(taskError).toBe(originalError);
    expect(processedTasks).toBe(1);
    expect(taskSettled).toBe(true);
    expect(f.termination.getFatalState()).toEqual({ hasFatalError: true, error: originalError });
    expect(f.gateClosures).toEqual(['trading', 'producer']);
    expect(f.secondaryErrors).toEqual([]);
    expect(f.detailErrors).toEqual([originalError]);
    expect(f.native.nativeReadCounts()).toEqual({ cancel: 2, detail: 2 });
    expect(f.native.nativeMutations()).toEqual([]);
    expect(f.economic.recorder.getExecutionFact('FIRST')).toBeNull();
  } finally {
    firstReply.resolve();
    secondReply.resolve();
    releasePermit.resolve();
    await processor.stopAndDrain();
    await f.monitor.stopRuntimeAndDrain();
    await f.monitor.teardown();
  }
});

test('公共 REPLACE 的 permit 外确认同样立即 fatal，不等待另一公共撤单 detail', async () => {
  const f = await setup();
  const firstStarted = deferred();
  const secondStarted = deferred();
  const firstReply = deferred();
  const secondReply = deferred();
  f.native.setOrderDetailBeforeReply(async (orderId) => {
    const first = orderId === 'FIRST';
    (first ? firstStarted : secondStarted).resolve();
    await (first ? firstReply : secondReply).promise;
  });

  try {
    const replacement = await f.rateLimiter.withTradeMutation((permit) =>
      f.monitor.replaceOrderPriceWithPermit('FIRST', '1.01', { kind: 'ORDER_FACT' }, permit),
    );
    expect(replacement.kind).toBe('POST_FAILURE_CONFIRMATION_REQUIRED');
    if (replacement.kind !== 'POST_FAILURE_CONFIRMATION_REQUIRED')
      throw new Error('closed replace must confirm after releasing its FIFO permit');

    const rejected = captureRejection(replacement.confirmAfterPermitReleased());
    const pendingCancel = f.monitor.cancelOrder('SECOND', { kind: 'ORDER_FACT' });
    await Promise.all([firstStarted.promise, secondStarted.promise]);
    firstReply.resolve();
    const error = await rejected;
    expect(error).toBe(f.detailErrors[0]);
    expect(error).toBeInstanceOf(TypeError);
    expect(f.termination.getFatalState()).toEqual({ hasFatalError: true, error });
    expect(f.gateClosures).toEqual(['trading', 'producer']);
    let drained = false;
    const drain = f.monitor.stopRuntimeAndDrain().then(() => {
      drained = true;
    });
    await flushMicrotasks();
    expect(drained).toBe(false);
    secondReply.resolve();
    await Promise.all([pendingCancel, drain]);
    expect(f.native.nativeReadCounts()).toEqual({ cancel: 1, detail: 2 });
    expect(f.native.nativeMutations()).toHaveLength(1);
    expect(f.secondaryErrors).toEqual([]);
  } finally {
    firstReply.resolve();
    secondReply.resolve();
    await f.monitor.stopRuntimeAndDrain();
    await f.monitor.teardown();
  }
});

test('末日公共撤单也在相同边界上报原始内部错误', async () => {
  const f = await setup(['FIRST']);
  try {
    const error = await captureRejection(
      f.monitor.cancelDoomsdayOrder('FIRST', {
        kind: 'DOOMSDAY_WINDOW',
        beforeBrokerCancel: () => true,
      }),
    );
    expect(error).toBe(f.detailErrors[0]);
    expect(error).toBeInstanceOf(TypeError);
    expect(f.termination.getFatalState()).toEqual({ hasFatalError: true, error });
    expect(f.gateClosures).toEqual(['trading', 'producer']);
    expect(f.native.nativeReadCounts()).toEqual({ cancel: 1, detail: 1 });
  } finally {
    await f.monitor.stopRuntimeAndDrain();
    await f.monitor.teardown();
  }
});

test.each(['cancel', 'doomsday', 'replace'] as const)(
  '%s 外部 mutation 失败保持原有有限重试/拒绝，不升级 fatal',
  async (operation) => {
    const f = await setup(['FIRST']);
    const cause = new Error('network unavailable');
    f.native.setCancelFailure(cause);
    f.native.failReplace(cause);
    try {
      const requests = {
        cancel: () => f.monitor.cancelOrder('FIRST', { kind: 'ORDER_FACT' }),
        doomsday: () =>
          f.monitor.cancelDoomsdayOrder('FIRST', {
            kind: 'DOOMSDAY_WINDOW',
            beforeBrokerCancel: () => true,
          }),
        replace: () =>
          f.rateLimiter.withTradeMutation((permit) =>
            f.monitor.replaceOrderPriceWithPermit('FIRST', '1.01', { kind: 'ORDER_FACT' }, permit),
          ),
      };
      const error = await captureRejection(requests[operation]());
      expect(isExternalApiRequestError(error)).toBe(true);
      expect(error).toMatchObject({ cause });
      expect(f.termination.getFatalState()).toEqual({ hasFatalError: false });
      expect(f.gateClosures).toEqual([]);
      expect(f.native.nativeReadCounts().detail).toBe(0);
      expect(
        operation === 'replace'
          ? f.native.nativeMutations().length
          : f.native.nativeReadCounts().cancel,
      ).toBe(operation === 'replace' ? 1 : API.DEFAULT_RETRY_COUNT + 1);
    } finally {
      await f.monitor.stopRuntimeAndDrain();
      await f.monitor.teardown();
    }
  },
);

test.each(['cancel', 'replace-confirmation'] as const)(
  '%s 的外部 detail 失败仍按既有重试分类传播，不升级 fatal',
  async (operation) => {
    const f = await setup(['FIRST']);
    const cause = new Error('network unavailable');
    f.native.setOrderDetailBeforeReply(async () => {
      throw cause;
    });

    try {
      const result =
        operation === 'cancel'
          ? f.monitor.cancelOrder('FIRST', { kind: 'ORDER_FACT' })
          : f.rateLimiter
              .withTradeMutation((permit) =>
                f.monitor.replaceOrderPriceWithPermit(
                  'FIRST',
                  '1.01',
                  { kind: 'ORDER_FACT' },
                  permit,
                ),
              )
              .then((outcome) => {
                if (outcome.kind !== 'POST_FAILURE_CONFIRMATION_REQUIRED')
                  throw new Error('replace must require an out-of-permit confirmation');

                return outcome.confirmAfterPermitReleased();
              });
      const error = await captureRejection(result);
      expect(isExternalApiRequestError(error)).toBe(true);
      expect(error).toMatchObject({ cause, attempts: API.DEFAULT_RETRY_COUNT + 1 });
      expect(f.native.nativeReadCounts().detail).toBe(API.DEFAULT_RETRY_COUNT + 1);
      expect(f.termination.getFatalState()).toEqual({ hasFatalError: false });
      expect(f.gateClosures).toEqual([]);
    } finally {
      await f.monitor.stopRuntimeAndDrain();
      await f.monitor.teardown();
    }
  },
);

test('授权失效结果与 SDK 序列化后的 replace sentinel 均不泄漏为 fatal', async () => {
  const f = await setup(['FIRST']);
  try {
    expect(
      await f.monitor.cancelOrder('FIRST', { kind: 'SIGNAL_AUTHORIZED', authorize: () => false }),
    ).toEqual({ kind: 'UNKNOWN_FAILURE', errorCode: null });

    expect(
      await f.monitor.cancelDoomsdayOrder('FIRST', {
        kind: 'DOOMSDAY_WINDOW',
        beforeBrokerCancel: () => false,
      }),
    ).toEqual({ kind: 'CANCEL_NOT_STARTED' });
    let authorizations = 0;
    const result = await f.rateLimiter.withTradeMutation((permit) =>
      f.monitor.replaceOrderPriceWithPermit(
        'FIRST',
        '1.01',
        {
          kind: 'SIGNAL_AUTHORIZED',
          authorize: () => ++authorizations === 1,
        },
        permit,
      ),
    );
    expect(result).toEqual({ kind: 'NOT_EXECUTED' });
    expect(authorizations).toBe(2);
    expect(f.native.nativeReadCounts()).toEqual({ cancel: 0, detail: 0 });
    expect(f.native.nativeMutations()).toEqual([]);
    expect(f.termination.getFatalState()).toEqual({ hasFatalError: false });
    expect(f.gateClosures).toEqual([]);
  } finally {
    await f.monitor.stopRuntimeAndDrain();
    await f.monitor.teardown();
  }
});
