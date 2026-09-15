import { describe, expect, it } from 'bun:test';
import { createQuoteSubscriptionRuntime } from '../../../src/main/quoteSubscriptionRuntime/index.js';
import { createSymbolRegistry } from '../../../src/services/autoSymbolManager/utils.js';
import type { LastState } from '../../../src/types/state.js';
import type { OrderHoldSymbolsChangedEvent } from '../../../src/types/services.js';
import { createTradingConfig } from '../../../mock/factories/configFactory.js';
import {
  createLoggerDouble,
  createMonitorConfigDouble,
  createPositionCacheDouble,
  createPositionDouble,
} from '../../helpers/testDoubles.js';

/**
 * QuoteSubscriptionRuntime 业务测试
 *
 * 覆盖：首轮真相投影、seat 事件增量投影、临时 retain 的 admission 与释放。
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
