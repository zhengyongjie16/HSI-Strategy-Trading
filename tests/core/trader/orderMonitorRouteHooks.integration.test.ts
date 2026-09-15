/**
 * orderMonitorRouteHooks 集成测试
 *
 * 功能：
 * - 覆盖 createOrderMonitor 真实装配路径下的 route hooks 行为
 * - 验证 TRACKED / ORDER_EVENT / RECOVERED 只有在装配出的 route runtime 进入运行态后才会生效
 */
import { createCleanup } from '../../../src/app/shutdown/createCleanup.js';
import { afterEach, describe, expect, it, mock } from 'bun:test';
import { OrderSide, OrderStatus, OrderType, TopicType, type TradeContext } from 'longbridge';
import { createTradingConfig } from '../../../mock/factories/configFactory.js';
import { createPushOrderChanged } from '../../../mock/factories/tradeFactory.js';
import { createTradeContextMock } from '../../../mock/longbridge/tradeContextMock.js';
import {
  createDailyLossTrackerDouble,
  createMarketDataClientDouble,
  createOrderRecorderDouble,
  createProtectiveLiquidationEpisodeTrackerDouble,
  createQuoteDouble,
  createSymbolRegistryDouble,
} from '../../helpers/testDoubles.js';
import type { OrderMonitor, OrderMonitorDeps } from '../../../src/core/trader/types.js';
import type {
  OrderMonitorWakeupKind,
  RouteRuntime,
  RouteRuntimeDeps,
  RouteRuntimeProcessParams,
} from '../../../src/core/trader/orderMonitor/types.js';
import type {
  QuoteUpdatedEvent,
  RawOrderFromAPI,
  TradeMutationPermit,
} from '../../../src/types/services.js';

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

function createPendingRecoveryOrder(params: {
  readonly orderId: string;
  readonly symbol: string;
  readonly side: OrderSide;
  readonly stockName?: string;
}): RawOrderFromAPI {
  return {
    orderId: params.orderId,
    symbol: params.symbol,
    stockName: params.stockName ?? 'HSI RC ROUTE',
    side: params.side,
    status: OrderStatus.New,
    orderType: OrderType.ELO,
    remark: '',
    price: '1.01',
    quantity: '100',
    executedPrice: '0',
    executedQuantity: '0',
    submittedAt: new Date('2026-04-08T09:00:00.000Z'),
    updatedAt: new Date('2026-04-08T09:00:00.000Z'),
  };
}

function createDeps(): {
  readonly deps: OrderMonitorDeps;
  readonly tradeCtx: ReturnType<typeof createTradeContextMock>;
} {
  const tradeCtx = createTradeContextMock();
  const baseConfig = createTradingConfig();
  const baseMonitor = baseConfig.monitor;

  const deps: OrderMonitorDeps = {
    now: () => new Date(),
    scheduleTimer: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer: (handle) => {
      clearTimeout(handle);
    },
    ctx: tradeCtx as unknown as TradeContext,
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

  return { deps, tradeCtx };
}

afterEach(() => {
  if (typeof mock.restore === 'function') {
    mock.restore();
  }
});

describe('createOrderMonitor route hooks integration', () => {
  it('真实装配路径不再依赖旧 quoteFlow 模块文件', async () => {
    const createOrderMonitor = await loadActualCreateOrderMonitor('no-quote-flow-module');
    const { deps } = createDeps();

    expect(() => createOrderMonitor(deps)).not.toThrow();
  });

  it('真实装配路径在恢复完成后触发 TRACKED wakeup', async () => {
    const capturedWakeups: CapturedRouteWakeup[] = [];
    const createOrderMonitor = await loadCreateOrderMonitorWithCapturedRouteWakeups(
      'tracked',
      capturedWakeups,
    );
    const { deps } = createDeps();
    const monitor = createOrderMonitor(deps);

    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.startRuntime();

    monitor.trackOrder({
      orderId: 'ORDER-TRACKED-INTEGRATION-1',
      symbol: 'BULL.HK',
      side: OrderSide.Buy,
      price: 1.01,
      initialSubmittedPrice: 1.01,
      quantity: 100,
      initialStatus: OrderStatus.New,
      monitorSymbol: 'HSI.HK',
      isLongSymbol: true,
      isProtectiveLiquidation: false,
      orderType: OrderType.ELO,
    });
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
    const createOrderMonitor = await loadCreateOrderMonitorWithCapturedRouteWakeups(
      'order-event',
      capturedWakeups,
    );
    const { deps, tradeCtx } = createDeps();
    const monitor = createOrderMonitor(deps);

    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.startRuntime();
    monitor.trackOrder({
      orderId: 'ORDER-EVENT-INTEGRATION-1',
      symbol: 'BULL.HK',
      side: OrderSide.Buy,
      price: 1.01,
      initialSubmittedPrice: 1.01,
      quantity: 100,
      initialStatus: OrderStatus.New,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: OrderType.ELO,
    });
    await flushMicrotasks();
    capturedWakeups.length = 0;

    expect(tradeCtx.getSubscribedTopics().has(TopicType.Private)).toBe(true);
    tradeCtx.emitOrderChanged(
      createPushOrderChanged({
        orderId: 'ORDER-EVENT-INTEGRATION-1',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
        status: OrderStatus.PendingCancel,
      }),
    );
    tradeCtx.flushAllEvents();
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
    const createOrderMonitor = await loadCreateOrderMonitorWithCapturedRouteWakeups(
      'recovered',
      capturedWakeups,
    );
    const { deps } = createDeps();
    const monitor = createOrderMonitor(deps);

    await monitor.initialize();
    monitor.startRuntime();
    await monitor.recoverOrderTrackingFromSnapshot([
      createPendingRecoveryOrder({
        orderId: 'ORDER-RECOVERED-INTEGRATION-1',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
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
    const createOrderMonitor = await loadCreateOrderMonitorWithCapturedRouteWakeups(
      'recovered-after-start',
      capturedWakeups,
    );
    const { deps } = createDeps();
    const monitor = createOrderMonitor(deps);

    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([
      createPendingRecoveryOrder({
        orderId: 'ORDER-RECOVERED-AFTER-START-1',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
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
    const createOrderMonitor = await loadActualCreateOrderMonitor('no-poll-hook');
    const { deps } = createDeps();
    const monitor = createOrderMonitor(deps);

    expect('processWithLatestQuotes' in monitor).toBe(false);
  });

  it('真实装配路径在 QUOTE 唤醒后会执行 routeProcessor 的改单动作', async () => {
    const quoteUpdatedListeners: Array<(event: QuoteUpdatedEvent) => void> = [];
    const createOrderMonitor = await loadActualCreateOrderMonitor('quote');
    const { deps } = createDeps();
    const tradeCtx = createTradeContextMock();
    const monitor = createOrderMonitor({
      ...deps,
      ctx: tradeCtx as unknown as TradeContext,
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
    monitor.trackOrder({
      orderId: 'ORDER-QUOTE-INTEGRATION-1',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      price: 1,
      initialSubmittedPrice: 1,
      quantity: 100,
      initialStatus: OrderStatus.New,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: OrderType.ELO,
    });
    await flushMicrotasks();

    const quoteUpdatedListener = quoteUpdatedListeners[0];
    if (!quoteUpdatedListener) {
      throw new Error('quoteUpdatedListener was not captured');
    }

    quoteUpdatedListener({
      symbol: 'BULL.HK',
      quote: createQuoteDouble('BULL.HK', 1.02),
    });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(tradeCtx.getCalls('replaceOrder')).toHaveLength(1);
  });
});

describe('orderMonitor terminal subscription ownership', () => {
  it('跨日 stop/start 保留 Private，最终退订一次并拒绝重新初始化', async () => {
    const createOrderMonitor = await loadActualCreateOrderMonitor('terminal-normal');
    const { deps, tradeCtx } = createDeps();
    const monitor = createOrderMonitor(deps);
    await Promise.all([monitor.initialize(), monitor.initialize()]);
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.startRuntime();
    await monitor.stopRuntimeAndDrain();
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    monitor.startRuntime();
    expect(tradeCtx.getCalls('tradeSubscribe')).toHaveLength(1);
    expect(tradeCtx.getCalls('tradeUnsubscribe')).toHaveLength(0);
    await monitor.stopRuntimeAndDrain();
    const final = monitor.teardown();
    expect(monitor.teardown()).toBe(final);
    await final;
    await monitor.initialize();
    monitor.startRuntime();
    expect(tradeCtx.getCalls('tradeSubscribe')).toHaveLength(1);
    expect(tradeCtx.getCalls('tradeUnsubscribe')).toHaveLength(1);
    expect(tradeCtx.getSubscribedTopics().has(TopicType.Private)).toBe(false);
  });

  it('初始化晚到成功仍由 final owner 等待并退订，不伪造挂起已释放', async () => {
    const createOrderMonitor = await loadActualCreateOrderMonitor('terminal-late');
    const { deps, tradeCtx } = createDeps();
    const gate = Promise.withResolvers<undefined>();
    const originalSubscribe = tradeCtx.subscribe;
    tradeCtx.subscribe = async (topics) => {
      await gate.promise;
      await originalSubscribe(topics);
    };
    const monitor = createOrderMonitor(deps);
    const initialization = monitor.initialize();
    const final = monitor.teardown();
    let completed = false;
    void final.then(() => {
      completed = true;
    });
    await flushMicrotasks();
    expect(completed).toBe(false);
    expect(tradeCtx.getCalls('tradeUnsubscribe')).toHaveLength(0);
    gate.resolve();
    await initialization;
    await final;
    expect(tradeCtx.getCalls('tradeUnsubscribe')).toHaveLength(1);
  });

  it('subscribe 失败不伪造订阅成功或调用 unsubscribe', async () => {
    const createOrderMonitor = await loadActualCreateOrderMonitor('terminal-subscribe-fail');
    const { deps, tradeCtx } = createDeps();
    tradeCtx.subscribe = () => Promise.reject(new Error('subscribe failed'));
    const monitor = createOrderMonitor(deps);
    expect(monitor.initialize()).rejects.toThrow();
    await monitor.teardown();
    expect(tradeCtx.getCalls('tradeUnsubscribe')).toHaveLength(0);
  });

  it('在途 subscribe 晚到失败由 final 汇总，不尝试无成功事实的退订', async () => {
    const createOrderMonitor = await loadActualCreateOrderMonitor('terminal-late-fail');
    const { deps, tradeCtx } = createDeps();
    const gate = Promise.withResolvers<undefined>();
    tradeCtx.subscribe = () => gate.promise;
    const monitor = createOrderMonitor(deps);
    const initialization = monitor.initialize();
    const final = monitor.teardown();
    const outcomes = Promise.allSettled([initialization, final]);
    gate.reject(new Error('late subscribe failure'));
    const settled = await outcomes;
    expect(settled.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    expect(tradeCtx.getCalls('tradeUnsubscribe')).toHaveLength(0);
    expect(monitor.teardown()).toBe(final);
    await monitor.initialize();
    expect(tradeCtx.getSubscribedTopics().size).toBe(0);
  });

  it('unsubscribe 失败保留单次结果且 cleanup 继续 PostTrade 和后续资源', async () => {
    const createOrderMonitor = await loadActualCreateOrderMonitor('terminal-unsubscribe-fail');
    const { deps, tradeCtx } = createDeps();
    let attempts = 0;
    const trace: string[] = [];
    tradeCtx.unsubscribe = () => {
      attempts += 1;
      trace.push('unsubscribe');
      return Promise.reject(new Error('unsubscribe failed'));
    };
    const monitor = createOrderMonitor(deps);
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
