/**
 * orderMonitorRouteHooks 集成测试
 *
 * 功能：
 * - 覆盖 createOrderMonitor 真实装配路径下的 route hooks 行为
 * - 验证 TRACKED / ORDER_EVENT / RECOVERED 只有在装配出的 route runtime 进入运行态后才会生效
 */
import { createCleanup } from '../../../src/app/shutdown/createCleanup.js';
import { afterEach, describe, expect, it, mock } from 'bun:test';
import { createBrokerIngressFixture } from '../../integration/architectureRefactoringP1Native/trade/brokerIngressFixture.js';
import { createTradingConfig } from '../../../mock/factories/configFactory.js';
import {
  createDailyLossTrackerDouble,
  createMarketDataClientDouble,
  createOrderRecorderDouble,
  createProtectiveLiquidationEpisodeTrackerDouble,
  createQuoteDouble,
  createSymbolRegistryDouble,
} from '../../helpers/testDoubles.js';
import type { OrderMonitor, OrderMonitorDeps } from '../../../src/core/trader/types.js';
import type { TrackOrderParams } from '../../../src/domain/order/types.js';
import type {
  OrderMonitorWakeupKind,
  RouteRuntime,
  RouteRuntimeDeps,
  RouteRuntimeProcessParams,
} from '../../../src/core/trader/orderMonitor/types.js';
import type { QuoteUpdatedEvent } from '../../../src/types/marketPorts.js';
import type { RawOrderFromAPI, TradeMutationPermit } from '../../../src/types/services.js';

function flushMicrotasks(): Promise<void> {
  return Promise.resolve()
    .then(() => {})
    .then(() => {});
}

type CapturedRouteWakeup = {
  readonly symbol: string;
  readonly wakeupKind: OrderMonitorWakeupKind;
};

type RouteRuntimeModuleShape = {
  readonly createRouteRuntime: (deps: RouteRuntimeDeps) => RouteRuntime;
};

type OrderMonitorModuleShape = {
  readonly createOrderMonitor: (deps: OrderMonitorDeps) => OrderMonitor;
};

async function loadCreateOrderMonitorWithCapturedRouteWakeups(
  suffix: string,
  capturedWakeups: CapturedRouteWakeup[],
): Promise<OrderMonitorModuleShape['createOrderMonitor']> {
  const actualRouteRuntimeModulePath = `../../../src/core/trader/orderMonitor/routeRuntime.js?actual-route-hooks-${suffix}`;
  const actualRouteRuntimeModuleUnknown: unknown = await import(actualRouteRuntimeModulePath);
  const actualRouteRuntimeModule = actualRouteRuntimeModuleUnknown as RouteRuntimeModuleShape;

  void mock.module('../../../src/core/trader/orderMonitor/routeRuntime.js', () => ({
    createRouteRuntime: (deps: RouteRuntimeDeps) =>
      actualRouteRuntimeModule.createRouteRuntime({
        ...deps,
        processRoute: async (params: RouteRuntimeProcessParams) => {
          capturedWakeups.push({
            symbol: params.symbol,
            wakeupKind: params.wakeupKind,
          });
          await deps.processRoute(params);
        },
      }),
  }));

  const orderMonitorModulePath = `../../../src/core/trader/orderMonitor/index.js?captured-route-hooks-${suffix}`;
  const loadedOrderMonitorModuleUnknown: unknown = await import(orderMonitorModulePath);
  const loadedOrderMonitorModule = loadedOrderMonitorModuleUnknown as OrderMonitorModuleShape;
  return loadedOrderMonitorModule.createOrderMonitor;
}

async function loadActualCreateOrderMonitor(
  suffix: string,
): Promise<OrderMonitorModuleShape['createOrderMonitor']> {
  const orderMonitorModulePath = `../../../src/core/trader/orderMonitor/index.js?actual-route-hooks-${suffix}`;
  const loadedOrderMonitorModuleUnknown: unknown = await import(orderMonitorModulePath);
  const loadedOrderMonitorModule = loadedOrderMonitorModuleUnknown as OrderMonitorModuleShape;
  return loadedOrderMonitorModule.createOrderMonitor;
}

async function createPendingRecoveryOrder(params: {
  readonly orderId: string;
  readonly symbol: string;
  readonly side: 'BUY' | 'SELL';
  readonly stockName?: string;
}): Promise<RawOrderFromAPI> {
  const native = await createBrokerIngressFixture({
    orderId: params.orderId,
    tradeId: 'RECOVERY-' + params.orderId,
    symbol: params.symbol,
    stockName: params.stockName ?? 'HSI RC ROUTE',
    remark: '',
    side: params.side,
    orderType: 'ELO',
    status: 'New',
    quantity: '100',
    executedQuantity: '0',
    submittedPrice: '1.01',
    executedPrice: '0',
    submittedAtMs: Date.parse('2026-04-08T09:00:00.000Z'),
    executionTimeMs: null,
    updatedAtMs: Date.parse('2026-04-08T09:00:00.000Z'),
  });
  return native.queryObservation;
}

async function createTrackParams(
  params: Readonly<{
    orderId: string;
    symbol: string;
    side: 'BUY' | 'SELL';
    submittedPrice: string;
    isLongSymbol: boolean;
    monitorSymbol: string;
    isProtectiveLiquidation: boolean;
  }>,
): Promise<TrackOrderParams> {
  const native = await createBrokerIngressFixture({
    orderId: params.orderId,
    tradeId: 'TRACKED-' + params.orderId,
    symbol: params.symbol,
    stockName: params.symbol,
    remark: '',
    side: params.side,
    orderType: 'ELO',
    status: 'New',
    quantity: '100',
    executedQuantity: '0',
    submittedPrice: params.submittedPrice,
    executedPrice: '0',
    submittedAtMs: Date.now(),
    executionTimeMs: null,
    updatedAtMs: Date.now(),
  });
  const fact = native.queryObservation;
  return {
    orderId: fact.orderId,
    symbol: fact.symbol,
    side: fact.executionSide,
    executionSide: fact.executionSide,
    initialExecutionPhase: fact.executionPhase,
    price: fact.price,
    initialSubmittedPrice: fact.price,
    quantity: fact.quantity,
    initialStatus: fact.status,
    orderType: fact.orderType,
    isLongSymbol: params.isLongSymbol,
    monitorSymbol: params.monitorSymbol,
    isProtectiveLiquidation: params.isProtectiveLiquidation,
  };
}

type NativeMonitorDeps = Parameters<
  Awaited<ReturnType<typeof createBrokerIngressFixture>>['createMonitor']
>[0];

async function createDeps(): Promise<{
  readonly deps: NativeMonitorDeps;
  readonly native: Awaited<ReturnType<typeof createBrokerIngressFixture>>;
}> {
  const native = await createBrokerIngressFixture({
    orderId: 'HOOK-NATIVE',
    tradeId: 'HOOK-NO-EXECUTION',
    symbol: 'BULL.HK',
    stockName: 'HSI RC ROUTE',
    remark: '',
    side: 'BUY',
    orderType: 'ELO',
    status: 'New',
    quantity: '100',
    executedQuantity: '0',
    submittedPrice: '1.01',
    executedPrice: '0',
    submittedAtMs: Date.now(),
    executionTimeMs: null,
    updatedAtMs: Date.now(),
  });
  const baseConfig = createTradingConfig();
  const baseMonitor = baseConfig.monitor;

  const deps: NativeMonitorDeps = {
    now: () => new Date(),
    scheduleTimer: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer: (handle) => {
      clearTimeout(handle);
    },
    rateLimiter: {
      throttle: async () => {},
      withTradeMutation: async <T>(
        callback: (permit: TradeMutationPermit) => Promise<T>,
      ): Promise<T> =>
        callback({
          invoke: async <TResult>(operation: () => Promise<TResult>): Promise<TResult> =>
            operation(),
        }),
    },
    cacheManager: {
      clearCache: () => {},
      getPendingOrders: async () => [],
    },
    marketDataClient: createMarketDataClientDouble(),
    orderRecorder: createOrderRecorderDouble(),
    dailyLossTracker: createDailyLossTrackerDouble(),
    orderHoldRegistry: {
      trackOrder: () => {},
      markOrderClosed: () => {},
      seedFromOrders: () => {},
      getHoldSymbols: () => new Set<string>(),
      onOrderHoldSymbolsChanged: () => () => {},
      clear: () => {},
    },
    protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
    persistProtectiveLiquidationExecutionProgress: () => {},
    postTradeConsistencyRuntime: {
      recordSettlementRefreshNeed: () => {},
    },
    tradingConfig: createTradingConfig({
      monitor: {
        ...baseMonitor,
        orderOwnershipMapping: ['HSI'],
      },
      global: {
        ...baseConfig.global,
        buyOrderTimeout: {
          enabled: true,
          timeoutSeconds: 180,
        },
        sellOrderTimeout: {
          enabled: true,
          timeoutSeconds: 180,
        },
        orderMonitorPriceUpdateInterval: 0,
      },
    }),
    symbolRegistry: createSymbolRegistryDouble(),
    isContinuousTradingAllowed: () => true,
    termination: {
      isTerminated: () => false,
      reportFatalError: (error) => {
        throw error;
      },
    },
  };

  return { deps, native };
}

afterEach(() => {
  if (typeof mock.restore === 'function') {
    mock.restore();
  }
});

describe('createOrderMonitor route hooks integration', () => {
  it('真实装配路径不再依赖旧 quoteFlow 模块文件', async () => {
    await loadActualCreateOrderMonitor('no-quote-flow-module');
    const { deps, native } = await createDeps();

    expect(() => native.createMonitor(deps)).not.toThrow();
  });

  it('真实装配路径在恢复完成后触发 TRACKED wakeup', async () => {
    const capturedWakeups: CapturedRouteWakeup[] = [];
    await loadCreateOrderMonitorWithCapturedRouteWakeups('tracked', capturedWakeups);
    const { deps, native } = await createDeps();
    const monitor = native.createMonitor(deps);

    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.startRuntime();

    monitor.trackOrder(
      await createTrackParams({
        orderId: 'ORDER-TRACKED-INTEGRATION-1',
        symbol: 'BULL.HK',
        side: 'BUY',
        submittedPrice: '1.01',
        isLongSymbol: true,
        monitorSymbol: 'HSI.HK',
        isProtectiveLiquidation: false,
      }),
    );
    await flushMicrotasks();

    expect(capturedWakeups).toEqual([
      {
        symbol: 'BULL.HK',
        wakeupKind: 'TRACKED',
      },
    ]);
  });

  it('真实装配路径在 tracked order 收到 WS 推进后触发 ORDER_EVENT wakeup', async () => {
    const capturedWakeups: CapturedRouteWakeup[] = [];
    await loadCreateOrderMonitorWithCapturedRouteWakeups('order-event', capturedWakeups);
    const { deps, native } = await createDeps();
    const monitor = native.createMonitor(deps);

    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.startRuntime();
    monitor.trackOrder(
      await createTrackParams({
        orderId: 'ORDER-EVENT-INTEGRATION-1',
        symbol: 'BULL.HK',
        side: 'BUY',
        submittedPrice: '1.01',
        isLongSymbol: true,
        monitorSymbol: 'HSI.HK',
        isProtectiveLiquidation: false,
      }),
    );
    await flushMicrotasks();
    capturedWakeups.length = 0;

    expect(native.subscriptionMembership().includes('PRIVATE')).toBe(true);
    native.emitOrderChangedFrame({
      orderId: 'ORDER-EVENT-INTEGRATION-1',
      tradeId: 'NO-EXECUTION',
      symbol: 'BULL.HK',
      stockName: 'HSI RC ROUTE',
      remark: '',
      side: 'BUY',
      orderType: 'ELO',
      status: 'PendingCancel',
      quantity: '100',
      executedQuantity: '0',
      submittedPrice: '1.01',
      executedPrice: '0',
      submittedAtMs: Date.now(),
      executionTimeMs: null,
      updatedAtMs: Date.now(),
    });
    await flushMicrotasks();

    expect(capturedWakeups).toEqual([
      {
        symbol: 'BULL.HK',
        wakeupKind: 'ORDER_EVENT',
      },
    ]);
  });

  it('真实装配路径在 recovery restore 期间抑制 TRACKED，并在成功后触发 RECOVERED wakeup', async () => {
    const capturedWakeups: CapturedRouteWakeup[] = [];
    await loadCreateOrderMonitorWithCapturedRouteWakeups('recovered', capturedWakeups);
    const { deps, native } = await createDeps();
    const monitor = native.createMonitor(deps);

    await monitor.initialize();
    monitor.startRuntime();
    await monitor.recoverOrderTrackingFromSnapshot([
      await createPendingRecoveryOrder({
        orderId: 'ORDER-RECOVERED-INTEGRATION-1',
        symbol: 'BULL.HK',
        side: 'BUY',
      }),
    ]);
    await flushMicrotasks();

    expect(capturedWakeups).toEqual([
      {
        symbol: 'BULL.HK',
        wakeupKind: 'RECOVERED',
      },
    ]);
  });

  it('真实装配路径先 recovery 后 startRuntime 时也会补发 RECOVERED wakeup', async () => {
    const capturedWakeups: CapturedRouteWakeup[] = [];
    await loadCreateOrderMonitorWithCapturedRouteWakeups('recovered-after-start', capturedWakeups);
    const { deps, native } = await createDeps();
    const monitor = native.createMonitor(deps);

    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([
      await createPendingRecoveryOrder({
        orderId: 'ORDER-RECOVERED-AFTER-START-1',
        symbol: 'BULL.HK',
        side: 'BUY',
      }),
    ]);
    monitor.startRuntime();
    await flushMicrotasks();

    expect(capturedWakeups).toEqual([
      {
        symbol: 'BULL.HK',
        wakeupKind: 'RECOVERED',
      },
    ]);
  });

  it('真实装配路径不再暴露旧的 processWithLatestQuotes 轮询入口', async () => {
    await loadActualCreateOrderMonitor('no-poll-hook');
    const { deps, native } = await createDeps();
    const monitor = native.createMonitor(deps);

    expect('processWithLatestQuotes' in monitor).toBe(false);
  });

  it('真实装配路径在 QUOTE 唤醒后会执行 routeProcessor 的改单动作', async () => {
    const quoteUpdatedListeners: Array<(event: QuoteUpdatedEvent) => void> = [];
    await loadActualCreateOrderMonitor('quote');
    const { deps, native } = await createDeps();
    const monitor = native.createMonitor({
      ...deps,
      marketDataClient: createMarketDataClientDouble({
        onQuoteUpdated: (listener) => {
          quoteUpdatedListeners.push(listener);
          return () => {
            const listenerIndex = quoteUpdatedListeners.indexOf(listener);
            if (listenerIndex !== -1) {
              quoteUpdatedListeners.splice(listenerIndex, 1);
            }
          };
        },
      }),
    });

    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.startRuntime();
    monitor.trackOrder(
      await createTrackParams({
        orderId: 'ORDER-QUOTE-INTEGRATION-1',
        symbol: 'BULL.HK',
        side: 'SELL',
        submittedPrice: '1',
        isLongSymbol: true,
        monitorSymbol: 'HSI.HK',
        isProtectiveLiquidation: false,
      }),
    );
    await flushMicrotasks();

    const quoteUpdatedListener = quoteUpdatedListeners[0];
    if (!quoteUpdatedListener) {
      throw new Error('quoteUpdatedListener was not captured');
    }

    quoteUpdatedListener({
      symbol: 'BULL.HK',
      quote: createQuoteDouble('BULL.HK', '1.02'),
    });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(native.nativeMutations().filter((mutation) => mutation.kind === 'REPLACE')).toHaveLength(
      1,
    );
  });
});

describe('orderMonitor terminal subscription ownership', () => {
  it('跨日 stop/start 保留 Private，最终退订一次并拒绝重新初始化', async () => {
    await loadActualCreateOrderMonitor('terminal-normal');
    const { deps, native } = await createDeps();
    const monitor = native.createMonitor(deps);
    await Promise.all([monitor.initialize(), monitor.initialize()]);
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.startRuntime();
    await monitor.stopRuntimeAndDrain();
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.startRuntime();
    expect(native.subscribeObservations()).toHaveLength(1);
    expect(native.unsubscribeObservations()).toHaveLength(0);
    await monitor.stopRuntimeAndDrain();
    const final = monitor.teardown();
    expect(monitor.teardown()).toBe(final);
    await final;
    await monitor.initialize();
    monitor.startRuntime();
    expect(native.subscribeObservations()).toHaveLength(1);
    expect(native.unsubscribeObservations()).toHaveLength(1);
    expect(native.subscriptionMembership().includes('PRIVATE')).toBe(false);
  });

  it('初始化晚到成功仍由 final owner 等待并退订，不伪造挂起已释放', async () => {
    await loadActualCreateOrderMonitor('terminal-late');
    const { deps, native } = await createDeps();
    const gate = Promise.withResolvers<undefined>();
    native.setSubscribeBehavior(async () => {
      await gate.promise;
    });
    const monitor = native.createMonitor(deps);
    const initialization = monitor.initialize();
    const final = monitor.teardown();
    let completed = false;
    void final.then(() => {
      completed = true;
    });
    await flushMicrotasks();
    expect(completed).toBe(false);
    expect(native.unsubscribeObservations()).toHaveLength(0);
    gate.resolve();
    await initialization;
    await final;
    expect(native.unsubscribeObservations()).toHaveLength(1);
  });

  it('subscribe 失败不伪造订阅成功或调用 unsubscribe', async () => {
    await loadActualCreateOrderMonitor('terminal-subscribe-fail');
    const { deps, native } = await createDeps();
    native.setSubscribeBehavior(() => Promise.reject(new Error('subscribe failed')));
    const monitor = native.createMonitor(deps);
    expect(monitor.initialize()).rejects.toThrow();
    await monitor.teardown();
    expect(native.unsubscribeObservations()).toHaveLength(0);
  });

  it('在途 subscribe 晚到失败由 final 汇总，不尝试无成功事实的退订', async () => {
    await loadActualCreateOrderMonitor('terminal-late-fail');
    const { deps, native } = await createDeps();
    const gate = Promise.withResolvers<undefined>();
    native.setSubscribeBehavior(() => gate.promise);
    const monitor = native.createMonitor(deps);
    const initialization = monitor.initialize();
    const final = monitor.teardown();
    const outcomes = Promise.allSettled([initialization, final]);
    gate.reject(new Error('late subscribe failure'));
    const settled = await outcomes;
    expect(settled.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    expect(native.unsubscribeObservations()).toHaveLength(0);
    expect(monitor.teardown()).toBe(final);
    await monitor.initialize();
    expect(native.subscriptionMembership()).toHaveLength(0);
  });

  it('unsubscribe 失败保留单次结果且 cleanup 继续 PostTrade 和后续资源', async () => {
    await loadActualCreateOrderMonitor('terminal-unsubscribe-fail');
    const { deps, native } = await createDeps();
    let attempts = 0;
    const trace: string[] = [];
    native.setUnsubscribeBehavior(() => {
      attempts += 1;
      trace.push('unsubscribe');
      return Promise.reject(new Error('unsubscribe failed'));
    });
    const monitor = native.createMonitor(deps);
    await monitor.initialize();
    const cleanup = createCleanup();
    cleanup.register({
      phase: 'STOP_POST_TRADE_CONSISTENCY_RUNTIME',
      step: 'post-trade',
      handler: () => {
        trace.push('post-trade');
      },
    });
    cleanup.register({ phase: 'TEARDOWN_TRADER', step: 'private', handler: monitor.teardown });
    cleanup.register({
      phase: 'UNSUBSCRIBE_TRADER_LISTENER',
      step: 'listener',
      handler: () => {
        trace.push('listener');
      },
    });

    cleanup.register({
      phase: 'STOP_ORDER_MONITOR_RUNTIME',
      step: 'drain',
      handler: async () => {
        await monitor.stopRuntimeAndDrain();
        trace.push('drain');
      },
    });
    expect(cleanup.execute()).rejects.toThrow(AggregateError);
    expect(monitor.teardown()).rejects.toThrow();
    expect(attempts).toBe(1);
    expect(trace).toEqual(['drain', 'listener', 'unsubscribe', 'post-trade']);
  });
});
