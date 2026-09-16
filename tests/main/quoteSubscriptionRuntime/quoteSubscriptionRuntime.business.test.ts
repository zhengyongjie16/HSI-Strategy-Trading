import { describe, expect, it } from 'bun:test';
import { createQuoteSubscriptionRuntime } from '../../../src/main/quoteSubscriptionRuntime/index.js';
import { createSymbolRegistry } from '../../../src/services/autoSymbolManager/utils.js';
import type { LastState } from '../../../src/types/state.js';
import type { OrderHoldSymbolsChangedEvent } from '../../../src/types/services.js';
import { createTradingConfig } from '../../../mock/factories/configFactory.js';
import { createExternalApiRequestError } from '../../helpers/createExternalApiRequestError.js';
import {
  createLoggerDouble,
  createMonitorConfigDouble,
  createPositionCacheDouble,
  createPositionDouble,
} from '../../helpers/testDoubles.js';

/**
 * QuoteSubscriptionRuntime 业务测试
 *
 * 覆盖：首轮真相投影、seat 事件增量投影、临时 retain 的 admission 与释放、
 * activation 准入纪律（命令串行隔离、失败 retain 回滚、SEAT_BOUND 接棒）。
 */

function createLastState(): LastState {
  return {
    canTrade: true,
    isHalfDay: false,
    openProtectionActive: false,
    currentDayKey: '2026-04-10',
    lifecycleState: 'ACTIVE',
    pendingOpenRebuild: false,
    isTradingEnabled: true,
    cachedAccount: null,
    cachedPositions: [],
    positionCache: createPositionCacheDouble(),
    cachedTradingDayInfo: null,
    tradingCalendarSnapshot: new Map(),

    allTradingSymbols: new Set(),
  };
}

function createOrderHoldEventSource(initialSymbols: ReadonlyArray<string>) {
  const holdSymbols = new Set(initialSymbols);
  const listeners = new Set<(event: OrderHoldSymbolsChangedEvent) => void>();

  return {
    trader: {
      getOrderHoldSymbols: () => new Set(holdSymbols),
      onOrderHoldSymbolsChanged: (listener: (event: OrderHoldSymbolsChangedEvent) => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    add(symbol: string): void {
      holdSymbols.add(symbol);
      for (const listener of listeners) {
        listener({ symbol, action: 'ADDED' });
      }
    },
    remove(symbol: string): void {
      holdSymbols.delete(symbol);
      for (const listener of listeners) {
        listener({ symbol, action: 'REMOVED' });
      }
    },
  };
}

/**
 * 构造有状态订阅替身：维护 SDK 端真实订阅集合 actual，并按 symbol 注入固定次数的退订失败。
 *
 * 抛错的 SDK 调用视为未生效，不改变 actual；committed truth 在任何一步都必须等于 actual 订阅集合。
 *
 * @param initialSubscriptions 初始真实订阅集合
 * @param unsubscribeFailureTimes 各 symbol 允许失败的退订次数
 * @returns actual 读取口、调用记录与 marketDataClient 依赖
 */
function createStatefulMarketDataDouble(
  initialSubscriptions: ReadonlyArray<string>,
  unsubscribeFailureTimes?: ReadonlyMap<string, number>,
) {
  const actualSubscriptions = new Set(initialSubscriptions);
  const remainingUnsubscribeFailures = new Map(unsubscribeFailureTimes);
  const subscribeCalls: string[][] = [];
  const unsubscribeCalls: string[][] = [];
  const unsubscribeError = new Error('unsubscribe failed');

  return {
    unsubscribeError,
    getActualSubscriptions: (): Set<string> => new Set(actualSubscriptions),
    subscribeCalls,
    unsubscribeCalls,
    marketDataClient: {
      subscribeSymbols: async (symbols: ReadonlyArray<string>): Promise<void> => {
        subscribeCalls.push([...symbols]);
        for (const symbol of symbols) {
          actualSubscriptions.add(symbol);
        }
      },
      unsubscribeSymbols: async (symbols: ReadonlyArray<string>): Promise<void> => {
        unsubscribeCalls.push([...symbols]);
        for (const symbol of symbols) {
          const remaining = remainingUnsubscribeFailures.get(symbol) ?? 0;
          if (remaining > 0) {
            remainingUnsubscribeFailures.set(symbol, remaining - 1);
            throw unsubscribeError;
          }
        }

        for (const symbol of symbols) {
          actualSubscriptions.delete(symbol);
        }
      },
    },
  };
}

describe('QuoteSubscriptionRuntime', () => {
  it('reconcileFromCurrentTruth 投影 monitor、seat、position 与 order hold，并写入 committed set', async () => {
    const monitorConfig = createMonitorConfigDouble({
      monitorSymbol: 'HSI.HK',
      longSymbol: 'BULL.HK',
      shortSymbol: 'BEAR.HK',
    });
    const symbolRegistry = createSymbolRegistry(monitorConfig);
    const lastState = createLastState();
    lastState.cachedPositions = [
      createPositionDouble({ symbol: 'POS.HK', quantity: 100, availableQuantity: 100 }),
    ];
    const orderHoldEventSource = createOrderHoldEventSource(['ORDER.HK']);
    const subscribed: string[][] = [];
    const unsubscribed: string[][] = [];
    const runtime = createQuoteSubscriptionRuntime({
      logger: createLoggerDouble(),
      tradingConfig: createTradingConfig({ monitor: monitorConfig }),
      symbolRegistry,
      marketDataClient: {
        subscribeSymbols: async (symbols) => {
          subscribed.push([...symbols]);
        },
        unsubscribeSymbols: async (symbols) => {
          unsubscribed.push([...symbols]);
        },
      },
      trader: orderHoldEventSource.trader,
      lastState,
      termination: { isTerminated: () => false, reportFatalError: () => {} },
    });

    await runtime.reconcileFromCurrentTruth();

    expect(new Set(subscribed.flat())).toEqual(
      new Set(['HSI.HK', 'BULL.HK', 'BEAR.HK', 'POS.HK', 'ORDER.HK']),
    );
    expect(unsubscribed).toEqual([]);
    expect(lastState.allTradingSymbols).toEqual(
      new Set(['HSI.HK', 'BULL.HK', 'BEAR.HK', 'POS.HK', 'ORDER.HK']),
    );
  });

  it('启动后按 order hold 事件动态增删订阅', async () => {
    const monitorConfig = createMonitorConfigDouble({ monitorSymbol: 'HSI.HK' });
    const symbolRegistry = createSymbolRegistry(monitorConfig);
    const lastState = createLastState();
    const orderHoldEventSource = createOrderHoldEventSource([]);
    const subscribed: string[][] = [];
    const unsubscribed: string[][] = [];
    const runtime = createQuoteSubscriptionRuntime({
      logger: createLoggerDouble(),
      tradingConfig: createTradingConfig({ monitor: monitorConfig }),
      symbolRegistry,
      marketDataClient: {
        subscribeSymbols: async (symbols) => {
          subscribed.push([...symbols]);
        },
        unsubscribeSymbols: async (symbols) => {
          unsubscribed.push([...symbols]);
        },
      },
      trader: orderHoldEventSource.trader,
      lastState,
      termination: { isTerminated: () => false, reportFatalError: () => {} },
    });

    await runtime.reconcileFromCurrentTruth();
    runtime.start();
    orderHoldEventSource.add('ORDER.HK');
    await runtime.waitForAdmission(['ORDER.HK']);

    expect(subscribed).toEqual([['HSI.HK', 'BULL.HK', 'BEAR.HK'], ['ORDER.HK']]);
    expect(lastState.allTradingSymbols.has('ORDER.HK')).toBe(true);

    orderHoldEventSource.remove('ORDER.HK');
    await runtime.waitForAdmission([]);

    expect(unsubscribed).toEqual([['ORDER.HK']]);
    expect(lastState.allTradingSymbols.has('ORDER.HK')).toBe(false);
    await runtime.stopAndDrain();
  });

  it('seat 事件只在 SEAT_BOUND 清空后退订对应交易标的', async () => {
    const monitorConfig = createMonitorConfigDouble({
      monitorSymbol: 'HSI.HK',
      longSymbol: 'BULL.HK',
      shortSymbol: 'BEAR.HK',
    });
    const symbolRegistry = createSymbolRegistry(monitorConfig);
    const lastState = createLastState();
    const orderHoldEventSource = createOrderHoldEventSource([]);
    const unsubscribed: string[][] = [];
    const runtime = createQuoteSubscriptionRuntime({
      logger: createLoggerDouble(),
      tradingConfig: createTradingConfig({ monitor: monitorConfig }),
      symbolRegistry,
      marketDataClient: {
        subscribeSymbols: async () => {},
        unsubscribeSymbols: async (symbols) => {
          unsubscribed.push([...symbols]);
        },
      },
      trader: orderHoldEventSource.trader,
      lastState,
      termination: { isTerminated: () => false, reportFatalError: () => {} },
    });

    await runtime.reconcileFromCurrentTruth();
    runtime.start();
    symbolRegistry.updateSeatState('LONG', {
      symbol: null,
      status: 'EMPTY',
      lastSwitchAt: Date.now(),
      lastSearchAt: Date.now(),
      lastSeatActivatedAt: Date.now(),
      callPrice: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    });
    await runtime.waitForAdmission([]);

    expect(unsubscribed).toEqual([['BULL.HK']]);
    expect(lastState.allTradingSymbols.has('BULL.HK')).toBe(false);
    expect(lastState.allTradingSymbols.has('BEAR.HK')).toBe(true);
    await runtime.stopAndDrain();
  });

  it('临时 retain 完成 admission，释放后才允许退订', async () => {
    const monitorConfig = createMonitorConfigDouble({ monitorSymbol: 'HSI.HK' });
    const symbolRegistry = createSymbolRegistry(monitorConfig);
    const lastState = createLastState();
    const orderHoldEventSource = createOrderHoldEventSource([]);
    const subscribed: string[][] = [];
    const unsubscribed: string[][] = [];
    const runtime = createQuoteSubscriptionRuntime({
      logger: createLoggerDouble(),
      tradingConfig: createTradingConfig({ monitor: monitorConfig }),
      symbolRegistry,
      marketDataClient: {
        subscribeSymbols: async (symbols) => {
          subscribed.push([...symbols]);
        },
        unsubscribeSymbols: async (symbols) => {
          unsubscribed.push([...symbols]);
        },
      },
      trader: orderHoldEventSource.trader,
      lastState,
      termination: { isTerminated: () => false, reportFatalError: () => {} },
    });

    await runtime.retainSymbols({
      ownerKey: 'SEAT_REFRESH_WAIT:LONG:2',
      reason: 'SEAT_REFRESH_WAIT',
      symbols: ['NEXT.HK', 'PREV.HK'],
    });
    await runtime.waitForAdmission(['NEXT.HK', 'PREV.HK']);
    await runtime.releaseRetain({
      ownerKey: 'SEAT_REFRESH_WAIT:LONG:2',
      reason: 'SEAT_REFRESH_WAIT',
    });
    await runtime.waitForAdmission([]);

    expect(subscribed).toEqual([['NEXT.HK', 'PREV.HK']]);
    expect(unsubscribed).toEqual([['NEXT.HK', 'PREV.HK']]);
  });

  it('retain release mutation 失败交调用方且 drain 不假装成功', async () => {
    const monitorConfig = createMonitorConfigDouble({ monitorSymbol: 'HSI.HK' });
    const symbolRegistry = createSymbolRegistry(monitorConfig);
    const lastState = createLastState();
    const orderHoldEventSource = createOrderHoldEventSource([]);
    const releaseError = new Error('unsubscribe failed');
    const fatalErrors: unknown[] = [];
    const runtime = createQuoteSubscriptionRuntime({
      logger: createLoggerDouble(),
      tradingConfig: createTradingConfig({ monitor: monitorConfig }),
      symbolRegistry,
      marketDataClient: {
        subscribeSymbols: async () => {},
        unsubscribeSymbols: async () => {
          throw releaseError;
        },
      },
      trader: orderHoldEventSource.trader,
      lastState,
      termination: {
        isTerminated: () => false,
        reportFatalError: (error) => {
          fatalErrors.push(error);
        },
      },
    });

    await runtime.retainSymbols({
      ownerKey: 'SEAT_REFRESH_WAIT:LONG:2',
      reason: 'SEAT_REFRESH_WAIT',
      symbols: ['NEXT.HK'],
    });

    expect(
      await runtime
        .releaseRetain({ ownerKey: 'SEAT_REFRESH_WAIT:LONG:2', reason: 'SEAT_REFRESH_WAIT' })
        .catch((error: unknown) => error),
    ).toBe(releaseError);
    expect(await runtime.stopAndDrain().catch((error: unknown) => error)).toBe(releaseError);
    expect(fatalErrors).toEqual([]);
  });

  it('lifecycle 午夜重置后会按 lastState.allTradingSymbols 重新投影 committed truth', async () => {
    const monitorConfig = createMonitorConfigDouble({
      monitorSymbol: 'HSI.HK',
      longSymbol: 'BULL.HK',
      shortSymbol: 'BEAR.HK',
    });
    const symbolRegistry = createSymbolRegistry(monitorConfig);
    const lastState = createLastState();
    const orderHoldEventSource = createOrderHoldEventSource([]);
    const subscribed: string[][] = [];
    const runtime = createQuoteSubscriptionRuntime({
      logger: createLoggerDouble(),
      tradingConfig: createTradingConfig({ monitor: monitorConfig }),
      symbolRegistry,
      marketDataClient: {
        subscribeSymbols: async (symbols) => {
          subscribed.push([...symbols]);
        },
        unsubscribeSymbols: async () => {},
      },
      trader: orderHoldEventSource.trader,
      lastState,
      termination: { isTerminated: () => false, reportFatalError: () => {} },
    });

    await runtime.reconcileFromCurrentTruth();
    await runtime.stopAndDrain();

    lastState.allTradingSymbols = new Set();
    await runtime.reconcileFromCurrentTruth();

    expect(subscribed).toEqual([
      ['HSI.HK', 'BULL.HK', 'BEAR.HK'],
      ['HSI.HK', 'BULL.HK', 'BEAR.HK'],
    ]);
    expect(lastState.allTradingSymbols).toEqual(new Set(['HSI.HK', 'BULL.HK', 'BEAR.HK']));
  });

  it('stopAndDrain 会退订当前 committed symbols 并清空 committed truth', async () => {
    const monitorConfig = createMonitorConfigDouble({
      monitorSymbol: 'HSI.HK',
      longSymbol: 'BULL.HK',
      shortSymbol: 'BEAR.HK',
    });
    const symbolRegistry = createSymbolRegistry(monitorConfig);
    const lastState = createLastState();
    const orderHoldEventSource = createOrderHoldEventSource([]);
    const subscribed: string[][] = [];
    const unsubscribed: string[][] = [];
    const runtime = createQuoteSubscriptionRuntime({
      logger: createLoggerDouble(),
      tradingConfig: createTradingConfig({ monitor: monitorConfig }),
      symbolRegistry,
      marketDataClient: {
        subscribeSymbols: async (symbols) => {
          subscribed.push([...symbols]);
        },
        unsubscribeSymbols: async (symbols) => {
          unsubscribed.push([...symbols]);
        },
      },
      trader: orderHoldEventSource.trader,
      lastState,
      termination: { isTerminated: () => false, reportFatalError: () => {} },
    });

    await runtime.reconcileFromCurrentTruth();
    await runtime.stopAndDrain();

    expect(subscribed).toEqual([['HSI.HK', 'BULL.HK', 'BEAR.HK']]);
    expect(unsubscribed).toEqual([['HSI.HK', 'BULL.HK', 'BEAR.HK']]);
    expect(lastState.allTradingSymbols).toEqual(new Set());
  });

  it('startup 已手工接入的订阅集合不会被 committed truth 重复订阅', async () => {
    const monitorConfig = createMonitorConfigDouble({
      monitorSymbol: 'HSI.HK',
      longSymbol: 'BULL.HK',
      shortSymbol: 'BEAR.HK',
    });
    const symbolRegistry = createSymbolRegistry(monitorConfig);
    const lastState = createLastState();
    lastState.allTradingSymbols = new Set(['HSI.HK', 'BULL.HK', 'BEAR.HK']);
    const orderHoldEventSource = createOrderHoldEventSource([]);
    const subscribed: string[][] = [];
    const unsubscribed: string[][] = [];
    const runtime = createQuoteSubscriptionRuntime({
      logger: createLoggerDouble(),
      tradingConfig: createTradingConfig({ monitor: monitorConfig }),
      symbolRegistry,
      marketDataClient: {
        subscribeSymbols: async (symbols) => {
          subscribed.push([...symbols]);
        },
        unsubscribeSymbols: async (symbols) => {
          unsubscribed.push([...symbols]);
        },
      },
      trader: orderHoldEventSource.trader,
      lastState,
      termination: { isTerminated: () => false, reportFatalError: () => {} },
    });

    await runtime.reconcileFromCurrentTruth();

    expect(subscribed).toEqual([]);
    expect(unsubscribed).toEqual([]);
    expect(lastState.allTradingSymbols).toEqual(new Set(['HSI.HK', 'BULL.HK', 'BEAR.HK']));
  });

  it('seat 事件订阅 mutation 失败会进入 fatal drain', async () => {
    const monitorConfig = createMonitorConfigDouble({
      monitorSymbol: 'HSI.HK',
      longSymbol: 'BULL.HK',
      shortSymbol: 'BEAR.HK',
    });
    const symbolRegistry = createSymbolRegistry(monitorConfig);
    const lastState = createLastState();
    const orderHoldEventSource = createOrderHoldEventSource([]);
    const subscriptionError = new Error('subscribe failed');
    const fatalErrors: unknown[] = [];
    const runtime = createQuoteSubscriptionRuntime({
      logger: createLoggerDouble(),
      tradingConfig: createTradingConfig({ monitor: monitorConfig }),
      symbolRegistry,
      marketDataClient: {
        subscribeSymbols: async (symbols) => {
          if (symbols.includes('NEXT_BULL.HK')) {
            throw subscriptionError;
          }
        },
        unsubscribeSymbols: async () => {},
      },
      trader: orderHoldEventSource.trader,
      lastState,
      termination: {
        isTerminated: () => false,
        reportFatalError: (error) => {
          fatalErrors.push(error);
        },
      },
    });

    await runtime.reconcileFromCurrentTruth();
    runtime.start();
    symbolRegistry.updateSeatState('LONG', {
      symbol: 'NEXT_BULL.HK',
      status: 'ACTIVE',
      lastSwitchAt: Date.now(),
      lastSearchAt: Date.now(),
      lastSeatActivatedAt: Date.now(),
      callPrice: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    });
    await runtime.waitForAdmission(['NEXT_BULL.HK']).catch(() => {});

    expect(fatalErrors).toEqual([subscriptionError]);
    await runtime.stopAndDrain().catch(() => {});
  });

  it('order hold 事件订阅 mutation 失败会进入 fatal drain', async () => {
    const monitorConfig = createMonitorConfigDouble({ monitorSymbol: 'HSI.HK' });
    const symbolRegistry = createSymbolRegistry(monitorConfig);
    const lastState = createLastState();
    const orderHoldEventSource = createOrderHoldEventSource([]);
    const subscriptionError = new Error('order hold subscribe failed');
    const fatalErrors: unknown[] = [];
    const runtime = createQuoteSubscriptionRuntime({
      logger: createLoggerDouble(),
      tradingConfig: createTradingConfig({ monitor: monitorConfig }),
      symbolRegistry,
      marketDataClient: {
        subscribeSymbols: async (symbols) => {
          if (symbols.includes('ORDER.HK')) {
            throw subscriptionError;
          }
        },
        unsubscribeSymbols: async () => {},
      },
      trader: orderHoldEventSource.trader,
      lastState,
      termination: {
        isTerminated: () => false,
        reportFatalError: (error) => {
          fatalErrors.push(error);
        },
      },
    });

    await runtime.reconcileFromCurrentTruth();
    runtime.start();
    orderHoldEventSource.add('ORDER.HK');
    await runtime.waitForAdmission(['ORDER.HK']).catch(() => {});

    expect(fatalErrors).toEqual([subscriptionError]);
    await runtime.stopAndDrain().catch(() => {});
  });
});

describe('Quote activation 准入纪律', () => {
  it('排队中的旧命令不会消费后来注册的 activation retain', async () => {
    const monitorConfig = createMonitorConfigDouble();
    const symbolRegistry = createSymbolRegistry(monitorConfig);
    const lastState = createLastState();
    const orderHoldEventSource = createOrderHoldEventSource([]);
    const subscribed: string[][] = [];
    const lockEntered = Promise.withResolvers<undefined>();
    const lockGate = Promise.withResolvers<undefined>();
    const fatalErrors: unknown[] = [];
    const runtime = createQuoteSubscriptionRuntime({
      logger: createLoggerDouble(),
      tradingConfig: createTradingConfig({ monitor: monitorConfig }),
      symbolRegistry,
      marketDataClient: {
        subscribeSymbols: async (symbols) => {
          subscribed.push([...symbols]);
          if (symbols.includes('LOCK.HK')) {
            lockEntered.resolve();
            await lockGate.promise;
          }
        },
        unsubscribeSymbols: async () => {},
      },
      trader: orderHoldEventSource.trader,
      lastState,
      termination: {
        isTerminated: () => false,
        reportFatalError: (error) => {
          fatalErrors.push(error);
        },
      },
    });

    runtime.start();
    const lockRetain = runtime.retainSymbols({
      ownerKey: 'lock',
      reason: 'SEAT_REFRESH_WAIT',
      symbols: ['LOCK.HK'],
    });
    await lockEntered.promise;

    orderHoldEventSource.add('OLD_CMD.HK');
    const nextRetain = runtime.retainSymbols({
      ownerKey: 'next',
      reason: 'SEAT_REFRESH_WAIT',
      symbols: ['NEXT.HK'],
    });

    lockGate.resolve();
    await lockRetain;
    await nextRetain;

    expect(subscribed).toEqual([['LOCK.HK'], ['OLD_CMD.HK'], ['NEXT.HK']]);
    expect(fatalErrors).toEqual([]);
    expect(lastState.allTradingSymbols).toEqual(new Set(['LOCK.HK', 'OLD_CMD.HK', 'NEXT.HK']));
    await runtime.stopAndDrain();
  });

  it('activation retain mutation 失败后回滚注册，后续命令不偷重试', async () => {
    const monitorConfig = createMonitorConfigDouble({ monitorSymbol: 'HSI.HK' });
    const symbolRegistry = createSymbolRegistry(monitorConfig);
    const lastState = createLastState();
    const orderHoldEventSource = createOrderHoldEventSource([]);
    const nextError = await createExternalApiRequestError({
      operation: 'subscribeSymbols',
      attempts: 1,
      cause: new Error('network unavailable'),
    });
    const subscribeCalls: string[][] = [];
    const fatalErrors: unknown[] = [];
    let allowNext = false;
    let nextSubscriptions = 0;
    const runtime = createQuoteSubscriptionRuntime({
      logger: createLoggerDouble(),
      tradingConfig: createTradingConfig({ monitor: monitorConfig }),
      symbolRegistry,
      marketDataClient: {
        subscribeSymbols: async (symbols) => {
          subscribeCalls.push([...symbols]);
          if (symbols.includes('NEXT.HK')) {
            nextSubscriptions += 1;
            if (!allowNext) throw nextError;
          }
        },
        unsubscribeSymbols: async () => {},
      },
      trader: orderHoldEventSource.trader,
      lastState,
      termination: {
        isTerminated: () => false,
        reportFatalError: (error) => {
          fatalErrors.push(error);
        },
      },
    });

    await runtime.reconcileFromCurrentTruth();
    runtime.start();

    expect(
      await runtime
        .retainSymbols({
          ownerKey: 'activation',
          reason: 'SEAT_REFRESH_WAIT',
          symbols: ['NEXT.HK'],
        })
        .catch((error: unknown) => error),
    ).toBe(nextError);
    expect(nextSubscriptions).toBe(1);
    expect(lastState.allTradingSymbols.has('NEXT.HK')).toBe(false);

    expect(await runtime.waitForAdmission(['NEXT.HK']).catch((error: unknown) => error)).toBe(
      nextError,
    );
    expect(nextSubscriptions).toBe(1);

    orderHoldEventSource.add('ORDER.HK');
    await runtime.waitForAdmission(['ORDER.HK']);

    expect(subscribeCalls).toEqual([['HSI.HK', 'BULL.HK', 'BEAR.HK'], ['NEXT.HK'], ['ORDER.HK']]);
    expect(nextSubscriptions).toBe(1);
    expect(fatalErrors).toEqual([]);

    allowNext = true;
    await runtime.retainSymbols({
      ownerKey: 'activation',
      reason: 'SEAT_REFRESH_WAIT',
      symbols: ['NEXT.HK'],
    });
    expect(nextSubscriptions).toBe(2);
    expect(lastState.allTradingSymbols.has('NEXT.HK')).toBe(true);
    await runtime.stopAndDrain();
  });

  it('未准入 ACTIVATING 新标的不经 SEAT_BOUND 首发，已准入标的随 ACTIVE 接棒', async () => {
    const monitorConfig = createMonitorConfigDouble({
      monitorSymbol: 'HSI.HK',
      longSymbol: 'BULL.HK',
      shortSymbol: 'BEAR.HK',
    });
    const symbolRegistry = createSymbolRegistry(monitorConfig);
    const lastState = createLastState();
    const orderHoldEventSource = createOrderHoldEventSource([]);
    const subscribed: string[][] = [];
    const unsubscribed: string[][] = [];
    const runtime = createQuoteSubscriptionRuntime({
      logger: createLoggerDouble(),
      tradingConfig: createTradingConfig({ monitor: monitorConfig }),
      symbolRegistry,
      marketDataClient: {
        subscribeSymbols: async (symbols) => {
          subscribed.push([...symbols]);
        },
        unsubscribeSymbols: async (symbols) => {
          unsubscribed.push([...symbols]);
        },
      },
      trader: orderHoldEventSource.trader,
      lastState,
      termination: { isTerminated: () => false, reportFatalError: () => {} },
    });

    await runtime.reconcileFromCurrentTruth();
    runtime.start();
    expect(subscribed).toEqual([['HSI.HK', 'BULL.HK', 'BEAR.HK']]);

    const activatingState = {
      symbol: 'NEXT.HK',
      status: 'ACTIVATING',
      lastSwitchAt: 1000,
      lastSearchAt: 1000,
      lastSeatActivatedAt: null,
      callPrice: 20_000,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    } as const;
    symbolRegistry.updateSeatStateWithVersionBump('LONG', activatingState);
    await runtime.waitForAdmission([]);

    expect(subscribed.flat()).not.toContain('NEXT.HK');
    expect(lastState.allTradingSymbols.has('NEXT.HK')).toBe(false);
    expect(unsubscribed.flat()).toContain('BULL.HK');

    await runtime.retainSymbols({
      ownerKey: 'SEAT_REFRESH_WAIT:LONG:2',
      reason: 'SEAT_REFRESH_WAIT',
      symbols: ['NEXT.HK'],
    });
    expect(lastState.allTradingSymbols.has('NEXT.HK')).toBe(true);

    symbolRegistry.updateSeatStateWithVersionBump('LONG', {
      ...activatingState,
      lastSwitchAt: 2000,
    });
    await runtime.waitForAdmission([]);
    expect(lastState.allTradingSymbols.has('NEXT.HK')).toBe(true);
    expect(unsubscribed.flat()).not.toContain('NEXT.HK');

    symbolRegistry.updateSeatStateWithVersionBump('LONG', {
      ...activatingState,
      status: 'ACTIVE',
      lastSwitchAt: 3000,
      lastSearchAt: 3000,
      lastSeatActivatedAt: 3000,
    });
    await runtime.waitForAdmission([]);
    await runtime.releaseRetain({
      ownerKey: 'SEAT_REFRESH_WAIT:LONG:2',
      reason: 'SEAT_REFRESH_WAIT',
    });
    expect(lastState.allTradingSymbols.has('NEXT.HK')).toBe(true);
    expect(unsubscribed.flat()).not.toContain('NEXT.HK');

    symbolRegistry.updateSeatStateWithVersionBump('LONG', {
      symbol: null,
      status: 'EMPTY',
      lastSwitchAt: 4000,
      lastSearchAt: 4000,
      lastSeatActivatedAt: null,
      callPrice: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    });
    await runtime.waitForAdmission([]);
    expect(lastState.allTradingSymbols.has('NEXT.HK')).toBe(false);
    expect(unsubscribed.flat()).toContain('NEXT.HK');
    await runtime.stopAndDrain();
  });

  it('版本切换后旧 activation retain 释放不遗留订阅，新标的必须重新准入', async () => {
    const monitorConfig = createMonitorConfigDouble({
      monitorSymbol: 'HSI.HK',
      longSymbol: 'BULL.HK',
      shortSymbol: 'BEAR.HK',
    });
    const symbolRegistry = createSymbolRegistry(monitorConfig);
    const lastState = createLastState();
    const orderHoldEventSource = createOrderHoldEventSource([]);
    const runtime = createQuoteSubscriptionRuntime({
      logger: createLoggerDouble(),
      tradingConfig: createTradingConfig({ monitor: monitorConfig }),
      symbolRegistry,
      marketDataClient: {
        subscribeSymbols: async () => {},
        unsubscribeSymbols: async () => {},
      },
      trader: orderHoldEventSource.trader,
      lastState,
      termination: { isTerminated: () => false, reportFatalError: () => {} },
    });

    await runtime.reconcileFromCurrentTruth();
    runtime.start();

    await runtime.retainSymbols({
      ownerKey: 'SEAT_REFRESH_WAIT:LONG:2',
      reason: 'SEAT_REFRESH_WAIT',
      symbols: ['NEXT.HK'],
    });
    expect(lastState.allTradingSymbols.has('NEXT.HK')).toBe(true);

    // 席位切换到下一版本的新标的：旧 retain 会在 handler finally 释放，新标的必须重新准入。
    symbolRegistry.updateSeatStateWithVersionBump('LONG', {
      symbol: 'NEXT2.HK',
      status: 'ACTIVATING',
      lastSwitchAt: 2000,
      lastSearchAt: 2000,
      lastSeatActivatedAt: null,
      callPrice: 20_000,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    });
    await runtime.waitForAdmission([]);
    await runtime.releaseRetain({
      ownerKey: 'SEAT_REFRESH_WAIT:LONG:2',
      reason: 'SEAT_REFRESH_WAIT',
    });

    expect(lastState.allTradingSymbols.has('NEXT.HK')).toBe(false);
    expect(lastState.allTradingSymbols.has('NEXT2.HK')).toBe(false);

    await runtime.retainSymbols({
      ownerKey: 'SEAT_REFRESH_WAIT:LONG:3',
      reason: 'SEAT_REFRESH_WAIT',
      symbols: ['NEXT2.HK'],
    });
    expect(lastState.allTradingSymbols.has('NEXT2.HK')).toBe(true);
    await runtime.releaseRetain({
      ownerKey: 'SEAT_REFRESH_WAIT:LONG:3',
      reason: 'SEAT_REFRESH_WAIT',
    });
    await runtime.stopAndDrain();
    expect(lastState.allTradingSymbols).toEqual(new Set());
  });
});

describe('Quote 半成功事实登记', () => {
  it('同 owner OLD→NEXT 半成功后 release 收口，actual 与 committed 均空', async () => {
    const monitor = createMonitorConfigDouble();
    const state = createLastState();
    state.allTradingSymbols = new Set(['OLD.HK']);
    const source = createOrderHoldEventSource([]);
    const double = createStatefulMarketDataDouble(['OLD.HK'], new Map([['OLD.HK', 1]]));
    const owner = { ownerKey: 'SWITCH_WAKEUP:long', reason: 'SWITCH_WAKEUP' as const };
    const runtime = createQuoteSubscriptionRuntime({
      logger: createLoggerDouble(),
      tradingConfig: createTradingConfig({ monitor }),
      symbolRegistry: createSymbolRegistry(monitor),
      marketDataClient: double.marketDataClient,
      trader: source.trader,
      lastState: state,
      termination: { isTerminated: () => false, reportFatalError: () => {} },
    });

    await runtime.retainSymbols({ ...owner, symbols: ['OLD.HK'] });
    expect(
      await runtime
        .retainSymbols({ ...owner, symbols: ['NEXT.HK'] })
        .catch((error: unknown) => error),
    ).toBe(double.unsubscribeError);

    // subscribe NEXT 已成功即成为既成事实：unsubscribe OLD 失败不能丢掉前一阶段的订阅成功。
    expect(double.getActualSubscriptions()).toEqual(new Set(['OLD.HK', 'NEXT.HK']));
    expect(state.allTradingSymbols).toEqual(new Set(['OLD.HK', 'NEXT.HK']));

    await runtime.releaseRetain(owner);
    expect(double.getActualSubscriptions()).toEqual(new Set());
    expect(state.allTradingSymbols).toEqual(new Set());
    await runtime.stopAndDrain();
  });

  it('同 owner OLD→NEXT 半成功后接续无关命令不丢已确认订阅事实', async () => {
    const monitor = createMonitorConfigDouble();
    const state = createLastState();
    state.allTradingSymbols = new Set(['OLD.HK']);
    const source = createOrderHoldEventSource([]);
    const double = createStatefulMarketDataDouble(['OLD.HK'], new Map([['OLD.HK', 1]]));
    const owner = { ownerKey: 'SWITCH_WAKEUP:long', reason: 'SWITCH_WAKEUP' as const };
    const runtime = createQuoteSubscriptionRuntime({
      logger: createLoggerDouble(),
      tradingConfig: createTradingConfig({ monitor }),
      symbolRegistry: createSymbolRegistry(monitor),
      marketDataClient: double.marketDataClient,
      trader: source.trader,
      lastState: state,
      termination: { isTerminated: () => false, reportFatalError: () => {} },
    });

    await runtime.retainSymbols({ ...owner, symbols: ['OLD.HK'] });
    await runtime.retainSymbols({ ...owner, symbols: ['NEXT.HK'] }).catch(() => {});
    expect(state.allTradingSymbols).toEqual(new Set(['OLD.HK', 'NEXT.HK']));

    // 无关 order hold 命令按 committed truth 收口：被确认订阅的 NEXT 不得遗留。
    runtime.start();
    source.add('ORDER.HK');
    await runtime.waitForAdmission(['ORDER.HK']);
    expect(double.getActualSubscriptions()).toEqual(new Set(['ORDER.HK']));
    expect(state.allTradingSymbols).toEqual(new Set(['ORDER.HK']));

    source.remove('ORDER.HK');
    await runtime.waitForAdmission([]);
    expect(double.getActualSubscriptions()).toEqual(new Set());
    expect(state.allTradingSymbols).toEqual(new Set());
    await runtime.stopAndDrain();
  });

  it('同 owner OLD→NEXT 半成功后立即 stop，首轮 drain 保留原错，显式 retry drain 收口为空', async () => {
    const monitor = createMonitorConfigDouble();
    const state = createLastState();
    state.allTradingSymbols = new Set(['OLD.HK']);
    const source = createOrderHoldEventSource([]);
    const double = createStatefulMarketDataDouble(['OLD.HK'], new Map([['OLD.HK', 1]]));
    const owner = { ownerKey: 'SWITCH_WAKEUP:long', reason: 'SWITCH_WAKEUP' as const };
    const runtime = createQuoteSubscriptionRuntime({
      logger: createLoggerDouble(),
      tradingConfig: createTradingConfig({ monitor }),
      symbolRegistry: createSymbolRegistry(monitor),
      marketDataClient: double.marketDataClient,
      trader: source.trader,
      lastState: state,
      termination: { isTerminated: () => false, reportFatalError: () => {} },
    });

    await runtime.retainSymbols({ ...owner, symbols: ['OLD.HK'] });
    await runtime.retainSymbols({ ...owner, symbols: ['NEXT.HK'] }).catch(() => {});

    // 首轮 drain 必须暴露已有 mutation 失败，且不得按失真的 committed 假装已收口。
    const first = runtime.stopAndDrain();
    expect(await first.catch((error: unknown) => error)).toBe(double.unsubscribeError);
    expect(double.getActualSubscriptions()).toEqual(new Set(['OLD.HK', 'NEXT.HK']));
    expect(state.allTradingSymbols).toEqual(new Set(['OLD.HK', 'NEXT.HK']));

    const retry = runtime.stopAndDrain();
    expect(runtime.stopAndDrain()).toBe(retry);
    await retry;
    expect(double.getActualSubscriptions()).toEqual(new Set());
    expect(state.allTradingSymbols).toEqual(new Set());
  });
});

describe('Quote drain 失败轮次隔离', () => {
  it.each([false, true])(
    '并发 waiter 保留原错、显式 retry 才重新退订，terminal=%s',
    async (terminal) => {
      const monitor = createMonitorConfigDouble();
      const state = createLastState();
      state.allTradingSymbols = new Set(['OLD.HK']);
      const source = createOrderHoldEventSource([]);
      const failure = new Error('unsubscribe failed');
      const firstUnsubscribe = Promise.withResolvers<undefined>();
      const retryUnsubscribe = Promise.withResolvers<undefined>();
      const entered = Promise.withResolvers<undefined>();
      let attempts = 0;
      let subscriptions = 0;
      let terminated = false;
      const runtime = createQuoteSubscriptionRuntime({
        logger: createLoggerDouble(),
        tradingConfig: createTradingConfig({ monitor }),
        symbolRegistry: createSymbolRegistry(monitor),
        lastState: state,
        trader: source.trader,
        termination: { isTerminated: () => terminated, reportFatalError: () => {} },
        marketDataClient: {
          subscribeSymbols: async () => {
            subscriptions += 1;
          },
          unsubscribeSymbols: async () => {
            attempts += 1;
            if (attempts === 1) {
              entered.resolve();
              await firstUnsubscribe.promise;
            } else {
              await retryUnsubscribe.promise;
            }
          },
        },
      });
      runtime.start();
      const first = runtime.stopAndDrain();
      const concurrent = runtime.stopAndDrain();
      expect(concurrent).toBe(first);
      const observedFirst = first.catch((error: unknown) => error);
      const observedConcurrent = concurrent.catch((error: unknown) => error);
      const waitingReconcile = runtime.reconcileFromCurrentTruth().catch((error: unknown) => error);
      await entered.promise;
      firstUnsubscribe.reject(failure);
      expect(await observedFirst).toBe(failure);
      expect(await observedConcurrent).toBe(failure);
      expect(await waitingReconcile).toBe(failure);
      expect(await runtime.reconcileFromCurrentTruth().catch((error: unknown) => error)).toBe(
        failure,
      );
      expect(state.allTradingSymbols).toEqual(new Set(['OLD.HK']));
      runtime.start();
      source.add('EVENT.HK');
      await runtime.retainSymbols({
        ownerKey: 'late',
        reason: 'SEAT_REFRESH_WAIT',
        symbols: ['LATE.HK'],
      });
      await runtime.reconcilePositionHoldFromCurrentTruth();
      expect(attempts).toBe(1);
      expect(subscriptions).toBe(0);

      terminated = terminal;
      const retry = runtime.stopAndDrain();
      expect(retry).not.toBe(first);
      expect(runtime.stopAndDrain()).toBe(retry);
      retryUnsubscribe.resolve();
      await retry;
      expect(attempts).toBe(2);
      expect(state.allTradingSymbols).toEqual(new Set());
      expect(runtime.stopAndDrain()).toBe(retry);
      expect(await first.catch((error: unknown) => error)).toBe(failure);
      runtime.start();
      source.add('AFTER.HK');
      await runtime.retainSymbols({
        ownerKey: 'after',
        reason: 'SEAT_REFRESH_WAIT',
        symbols: ['AFTER.HK'],
      });
      expect(subscriptions).toBe(0);
      await runtime.reconcileFromCurrentTruth();
      expect(subscriptions).toBe(terminal ? 0 : 1);
    },
  );

  it('进入 stop 前 mutationChain 已拒绝，首轮仍拒绝原错，后续显式 drain 可收口', async () => {
    const monitor = createMonitorConfigDouble();
    const state = createLastState();
    const failure = new Error('release failed');
    let attempts = 0;
    const runtime = createQuoteSubscriptionRuntime({
      logger: createLoggerDouble(),
      tradingConfig: createTradingConfig({ monitor }),
      symbolRegistry: createSymbolRegistry(monitor),
      lastState: state,
      trader: createOrderHoldEventSource([]).trader,
      termination: { isTerminated: () => false, reportFatalError: () => {} },
      marketDataClient: {
        subscribeSymbols: async () => {},
        unsubscribeSymbols: async () => {
          attempts += 1;
          if (attempts === 1) throw failure;
        },
      },
    });
    const owner = { ownerKey: 'held', reason: 'SEAT_REFRESH_WAIT' as const };
    await runtime.retainSymbols({ ...owner, symbols: ['HELD.HK'] });
    expect(await runtime.releaseRetain(owner).catch((error: unknown) => error)).toBe(failure);
    const first = runtime.stopAndDrain();
    expect(runtime.stopAndDrain()).toBe(first);
    expect(await first.catch((error: unknown) => error)).toBe(failure);
    expect(attempts).toBe(1);
    expect(state.allTradingSymbols).toEqual(new Set(['HELD.HK']));
    await runtime.stopAndDrain();
    expect(attempts).toBe(2);
    expect(state.allTradingSymbols).toEqual(new Set());
  });
});
