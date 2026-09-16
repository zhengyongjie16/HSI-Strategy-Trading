/**
 * 激活准入恢复集成测试
 *
 * 场景：真实 SymbolRegistry + SeatActivationDispatcher + MonitorTaskQueue + MonitorTaskProcessor +
 * QuoteSubscriptionRuntime + TerminationRuntime 联动，覆盖 ACTIVATING 新标的首次 admission 的外部失败恢复、
 * 不可交易窗口、仅一次延迟重试、内部错误 fatal、普通事件 external fatal、旧排队命令隔离与订阅接棒。
 */
import { describe, expect, it } from 'bun:test';
import { createMonitorTaskQueue } from '../../src/main/asyncProgram/monitorTaskQueue/index.js';
import { createMonitorTaskProcessor } from '../../src/main/asyncProgram/monitorTaskProcessor/index.js';
import { createQuoteSubscriptionRuntime } from '../../src/main/quoteSubscriptionRuntime/index.js';
import { createSeatActivationDispatcher } from '../../src/main/seatActivationDispatcher/index.js';
import { createTerminationRuntime } from '../../src/app/runtime/createTerminationRuntime.js';
import { createSymbolRegistry } from '../../src/services/autoSymbolManager/utils.js';
import { isSeatActive } from '../../src/utils/seat/guards.js';
import { createTradingConfig } from '../../mock/factories/configFactory.js';
import { createExternalApiRequestError } from '../helpers/createExternalApiRequestError.js';
import {
  createLoggerDouble,
  createMarketDataClientDouble,
  createMonitorConfigDouble,
  createMonitorContextDouble,
  createOrderRecorderDouble,
  createPositionCacheDouble,
  createPositionDouble,
  createQuoteDouble,
  createTraderDouble,
} from '../helpers/testDoubles.js';
import { waitUntil } from '../main/asyncProgram/utils.js';
import type { Position } from '../../src/types/account.js';
import type { Quote } from '../../src/types/quote.js';
import type { MarketDataClient, OrderHoldSymbolsChangedEvent } from '../../src/types/services.js';
import type { LastState } from '../../src/types/state.js';
import type { SymbolRegistry } from '../../src/types/seat.js';
import type { MonitorTaskDataMap } from '../../src/main/asyncProgram/monitorTaskProcessor/types.js';

const MONITOR_SYMBOL = 'HSI.HK';
const BEAR_SYMBOL = 'BEAR.HK';
const OLD_SYMBOL = 'OLD_BULL.HK';
const NEXT_SYMBOL = 'NEXT_BULL.HK';
const ORDER_SYMBOL = 'ORDER.HK';

/**
 * 构造可手动触发 order hold 事件的事件源。
 *
 * @param initialSymbols 初始 order hold 标的
 * @returns getOrderHoldSymbols/onOrderHoldSymbolsChanged 与 add/remove 触发口
 */
function createOrderHoldSource(initialSymbols: ReadonlyArray<string>) {
  const holdSymbols = new Set(initialSymbols);
  const listeners = new Set<(event: OrderHoldSymbolsChangedEvent) => void>();

  return {
    getOrderHoldSymbols: (): Set<string> => new Set(holdSymbols),
    onOrderHoldSymbolsChanged: (
      listener: (event: OrderHoldSymbolsChangedEvent) => void,
    ): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    add: (symbol: string): void => {
      holdSymbols.add(symbol);
      for (const listener of listeners) {
        listener({ symbol, action: 'ADDED' });
      }
    },
    remove: (symbol: string): void => {
      holdSymbols.delete(symbol);
      for (const listener of listeners) {
        listener({ symbol, action: 'REMOVED' });
      }
    },
  };
}

type ActivationHarness = ReturnType<typeof createActivationHarness>;

/**
 * 组装激活链路的真实组件：registry、quote runtime、seat activation dispatcher、监控任务处理器与 termination。
 *
 * @param params 行情订阅替身、初始持仓与初始 order hold
 * @returns 集成测试使用的组件集合
 */
function createActivationHarness(params: {
  readonly marketDataClient: MarketDataClient;
  readonly orderHoldSymbols?: ReadonlyArray<string>;
  readonly positions?: ReadonlyArray<Position>;
}) {
  const monitorConfig = createMonitorConfigDouble({ monitorSymbol: MONITOR_SYMBOL });
  const symbolRegistry = createSymbolRegistry(monitorConfig);
  const initialPositions = params.positions ?? [];
  const lastState: LastState = {
    canTrade: true,
    isHalfDay: false,
    openProtectionActive: false,
    currentDayKey: '2026-05-06',
    lifecycleState: 'ACTIVE',
    pendingOpenRebuild: false,
    isTradingEnabled: true,
    cachedAccount: null,
    cachedPositions: [...initialPositions],
    positionCache: createPositionCacheDouble(initialPositions),
    cachedTradingDayInfo: null,
    tradingCalendarSnapshot: new Map(),
    allTradingSymbols: new Set(),
  };
  const orderHoldSource = createOrderHoldSource(params.orderHoldSymbols ?? []);
  const orderRecorder = createOrderRecorderDouble();
  const monitorContext = createMonitorContextDouble({
    config: monitorConfig,
    symbolRegistry,
    orderRecorder,
  });
  const trader = createTraderDouble({
    orderRecorder,
    getOrderHoldSymbols: orderHoldSource.getOrderHoldSymbols,
    onOrderHoldSymbolsChanged: orderHoldSource.onOrderHoldSymbolsChanged,
    getStockPositions: async () => lastState.cachedPositions,
  });
  const termination = createTerminationRuntime({
    closeTradingGate: () => {},
    closeProducerAdmission: () => {},
    stopProducers: [],
    onSecondaryError: () => {},
  });
  const quoteSubscriptionRuntime = createQuoteSubscriptionRuntime({
    logger: createLoggerDouble(),
    tradingConfig: createTradingConfig({ monitor: monitorConfig }),
    symbolRegistry,
    marketDataClient: params.marketDataClient,
    trader,
    lastState,
    termination,
  });
  const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskDataMap>();
  const seatActivationDispatcher = createSeatActivationDispatcher({
    termination,
    symbolRegistry,
    monitorTaskQueue,
  });
  const monitorTaskProcessor = createMonitorTaskProcessor({
    clock: { now: () => new Date() },
    scheduler: {
      scheduleTimer: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimer: (handle) => {
        clearTimeout(handle);
      },
    },
    monitorTaskQueue,
    monitorContext,
    trader,
    marketDataClient: params.marketDataClient,
    quoteSubscriptionRuntime,
    switchWakeupRuntime: { handoffPendingSwitch: () => {} },
    periodicSwitchWakeupRuntime: {
      markWaitingEmpty: () => {},
      clearWaitingEmpty: () => {},
      replanRouteAfterTask: () => {},
    },
    lastState,
    getCanProcessTask: () => true,
    getCanTradeNow: () => true,
    termination,
  });

  return {
    monitorConfig,
    symbolRegistry,
    lastState,
    orderHoldSource,
    monitorContext,
    termination,
    quoteSubscriptionRuntime,
    monitorTaskQueue,
    seatActivationDispatcher,
    monitorTaskProcessor,
  };
}

/** 构造同时返回所有请求标的的行情读取替身。 */
const readQuotesForAll = async (symbols: Iterable<string>): Promise<Map<string, Quote | null>> => {
  const quotes = new Map<string, Quote | null>();
  for (const symbol of symbols) {
    quotes.set(symbol, createQuoteDouble(symbol, 1, 100));
  }

  return quotes;
};

/** 把 LONG 席位预置为可交易的旧标的。 */
function activateLongSeat(symbolRegistry: SymbolRegistry, symbol: string): void {
  symbolRegistry.updateSeatState('LONG', {
    symbol,
    status: 'ACTIVE',
    lastSwitchAt: null,
    lastSearchAt: null,
    lastSeatActivatedAt: 1000,
    callPrice: null,
    searchFailCountToday: 0,
    frozenTradingDayKey: null,
  });
}

/** 将 LONG 席位推进到绑定新标的的 ACTIVATING，触发真实 dispatcher 调度 SEAT_REFRESH。 */
function markLongSeatActivating(
  symbolRegistry: SymbolRegistry,
  nextSymbol: string,
  callPrice: number,
): void {
  symbolRegistry.updateSeatStateWithVersionBump('LONG', {
    symbol: nextSymbol,
    status: 'ACTIVATING',
    lastSwitchAt: 1000,
    lastSearchAt: 1000,
    lastSeatActivatedAt: null,
    callPrice,
    searchFailCountToday: 0,
    frozenTradingDayKey: null,
  });
}

/** 停止集成组件并关闭 termination；排空失败只用于清理，行为断言在用例主体内完成。 */
async function stopHarness(harness: ActivationHarness): Promise<void> {
  harness.seatActivationDispatcher.stop();
  await harness.monitorTaskProcessor.stopAndDrain();
  await harness.quoteSubscriptionRuntime.stopAndDrain().catch(() => {});
  harness.termination.requestShutdown();
}

describe('激活准入恢复集成', () => {
  it('首次外部 admission 失败不 fatal、席位不可交易，仅一次延迟重试后 ACTIVE 并完成订阅接棒', async () => {
    const subscribeCalls: string[][] = [];
    const unsubscribeCalls: string[][] = [];
    const nextError = await createExternalApiRequestError({
      operation: 'subscribeSymbols',
      attempts: 1,
      cause: new Error('network unavailable'),
    });
    const nextAttemptStarted = Promise.withResolvers<undefined>();
    const nextGate = Promise.withResolvers<undefined>();
    let nextAttempts = 0;
    const harness = createActivationHarness({
      positions: [
        createPositionDouble({ symbol: OLD_SYMBOL, quantity: 100, availableQuantity: 100 }),
      ],
      orderHoldSymbols: [ORDER_SYMBOL],
      marketDataClient: createMarketDataClientDouble({
        subscribeSymbols: async (symbols) => {
          const callSymbols = [...symbols];
          subscribeCalls.push(callSymbols);
          if (!callSymbols.includes(NEXT_SYMBOL)) return;

          nextAttempts += 1;
          if (nextAttempts === 1) {
            nextAttemptStarted.resolve();
            await nextGate.promise;
            throw nextError;
          }
        },
        unsubscribeSymbols: async (symbols) => {
          unsubscribeCalls.push([...symbols]);
        },
        getQuotes: readQuotesForAll,
      }),
    });
    activateLongSeat(harness.symbolRegistry, OLD_SYMBOL);

    await harness.quoteSubscriptionRuntime.reconcileFromCurrentTruth();
    harness.quoteSubscriptionRuntime.start();
    harness.seatActivationDispatcher.start();
    harness.monitorTaskProcessor.start();

    try {
      expect(subscribeCalls).toEqual([[MONITOR_SYMBOL, OLD_SYMBOL, BEAR_SYMBOL, ORDER_SYMBOL]]);

      markLongSeatActivating(harness.symbolRegistry, NEXT_SYMBOL, 20_000);
      await nextAttemptStarted.promise;

      // 首次 admission 卡在外部请求中时排队一个无关 order hold 命令，验证失败回滚后它不会偷重试。
      harness.orderHoldSource.add('UNRELATED.HK');
      nextGate.resolve();
      await waitUntil(() => harness.lastState.allTradingSymbols.has('UNRELATED.HK'));

      expect(subscribeCalls.filter((call) => call.includes(NEXT_SYMBOL))).toEqual([[NEXT_SYMBOL]]);
      expect(nextAttempts).toBe(1);
      expect(harness.termination.getFatalState()).toEqual({ hasFatalError: false });
      expect(harness.symbolRegistry.getSeatState('LONG').status).toBe('ACTIVATING');
      expect(isSeatActive(harness.symbolRegistry.getSeatState('LONG'))).toBe(false);
      expect(harness.lastState.allTradingSymbols.has(NEXT_SYMBOL)).toBe(false);
      expect(harness.lastState.allTradingSymbols.has(OLD_SYMBOL)).toBe(true);

      await waitUntil(() => harness.symbolRegistry.getSeatState('LONG').status === 'ACTIVE');

      expect(nextAttempts).toBe(2);
      expect(subscribeCalls.filter((call) => call.includes(NEXT_SYMBOL))).toEqual([
        [NEXT_SYMBOL],
        [NEXT_SYMBOL],
      ]);
      expect(unsubscribeCalls.flat()).not.toContain(NEXT_SYMBOL);
      expect(harness.lastState.allTradingSymbols).toEqual(
        new Set([
          MONITOR_SYMBOL,
          NEXT_SYMBOL,
          OLD_SYMBOL,
          BEAR_SYMBOL,
          ORDER_SYMBOL,
          'UNRELATED.HK',
        ]),
      );

      // 延迟重试只允许一次：成功激活后不得再出现第三次尝试或第二次 fatal。
      await Bun.sleep(120);
      expect(nextAttempts).toBe(2);
      expect(harness.termination.getFatalState()).toEqual({ hasFatalError: false });

      // ACTIVE 后由 SEAT_BOUND 接棒；旧标的仅由持仓保留，清仓后立即释放。
      harness.lastState.cachedPositions = [];
      harness.lastState.positionCache.update([]);
      await harness.quoteSubscriptionRuntime.reconcilePositionHoldFromCurrentTruth();

      expect(harness.lastState.allTradingSymbols.has(OLD_SYMBOL)).toBe(false);
      expect(unsubscribeCalls.flat()).toContain(OLD_SYMBOL);
      expect(harness.lastState.allTradingSymbols.has(NEXT_SYMBOL)).toBe(true);

      harness.orderHoldSource.remove('UNRELATED.HK');
      await waitUntil(() => !harness.lastState.allTradingSymbols.has('UNRELATED.HK'));
      expect(harness.lastState.allTradingSymbols.has(ORDER_SYMBOL)).toBe(true);
      expect(harness.lastState.allTradingSymbols.has(NEXT_SYMBOL)).toBe(true);
    } finally {
      await stopHarness(harness);
    }
  });

  it('队列被旧命令占住时，排队中的旧命令不会把新标的并入自己的订阅 mutation', async () => {
    const subscribeCalls: string[][] = [];
    const gateEntered = Promise.withResolvers<undefined>();
    const gateRelease = Promise.withResolvers<undefined>();
    const harness = createActivationHarness({
      positions: [
        createPositionDouble({ symbol: OLD_SYMBOL, quantity: 100, availableQuantity: 100 }),
      ],
      marketDataClient: createMarketDataClientDouble({
        subscribeSymbols: async (symbols) => {
          const callSymbols = [...symbols];
          subscribeCalls.push(callSymbols);
          if (callSymbols.includes('GATE.HK')) {
            gateEntered.resolve();
            await gateRelease.promise;
          }
        },
        unsubscribeSymbols: async () => {},
        getQuotes: readQuotesForAll,
      }),
    });
    activateLongSeat(harness.symbolRegistry, OLD_SYMBOL);

    await harness.quoteSubscriptionRuntime.reconcileFromCurrentTruth();
    harness.quoteSubscriptionRuntime.start();
    harness.seatActivationDispatcher.start();
    harness.monitorTaskProcessor.start();

    try {
      expect(subscribeCalls).toEqual([[MONITOR_SYMBOL, OLD_SYMBOL, BEAR_SYMBOL]]);

      harness.orderHoldSource.add('GATE.HK');
      await gateEntered.promise;

      // 旧命令占住串行链：先排队第二个旧命令，再让 activation retain 进入队列。
      harness.orderHoldSource.add('ORDER2.HK');
      markLongSeatActivating(harness.symbolRegistry, NEXT_SYMBOL, 20_000);
      await waitUntil(() => harness.monitorTaskQueue.isEmpty());
      await Bun.sleep(20);
      gateRelease.resolve();

      await waitUntil(() => harness.lastState.allTradingSymbols.has(NEXT_SYMBOL));

      expect(subscribeCalls).toEqual([
        [MONITOR_SYMBOL, OLD_SYMBOL, BEAR_SYMBOL],
        ['GATE.HK'],
        ['ORDER2.HK'],
        [NEXT_SYMBOL],
      ]);
      expect(harness.termination.getFatalState()).toEqual({ hasFatalError: false });
      await waitUntil(() => harness.symbolRegistry.getSeatState('LONG').status === 'ACTIVE');
    } finally {
      await stopHarness(harness);
    }
  });

  it('内部 mutation 错误进入 fatal，且不安排延迟重试也不回落 EMPTY', async () => {
    const internalError = new TypeError('subscribe invariant broken');
    let nextAttempts = 0;
    const harness = createActivationHarness({
      marketDataClient: createMarketDataClientDouble({
        subscribeSymbols: async (symbols) => {
          if ([...symbols].includes(NEXT_SYMBOL)) {
            nextAttempts += 1;
            throw internalError;
          }
        },
        unsubscribeSymbols: async () => {},
        getQuotes: readQuotesForAll,
      }),
    });
    activateLongSeat(harness.symbolRegistry, OLD_SYMBOL);

    await harness.quoteSubscriptionRuntime.reconcileFromCurrentTruth();
    harness.quoteSubscriptionRuntime.start();
    harness.seatActivationDispatcher.start();
    harness.monitorTaskProcessor.start();

    try {
      markLongSeatActivating(harness.symbolRegistry, NEXT_SYMBOL, 20_000);
      await waitUntil(() => harness.termination.getFatalState().hasFatalError);

      expect(harness.termination.getFatalState()).toEqual({
        hasFatalError: true,
        error: internalError,
      });
      expect(harness.symbolRegistry.getSeatState('LONG').status).toBe('ACTIVATING');
      expect(nextAttempts).toBe(1);

      await Bun.sleep(400);
      expect(nextAttempts).toBe(1);
      expect(harness.symbolRegistry.getSeatState('LONG').status).toBe('ACTIVATING');
    } finally {
      await stopHarness(harness);
    }
  });

  it('普通 order hold 事件的 external mutation 失败仍进入 fatal', async () => {
    const orderError = await createExternalApiRequestError({
      operation: 'subscribeSymbols',
      attempts: 1,
      cause: new Error('network unavailable'),
    });
    const harness = createActivationHarness({
      marketDataClient: createMarketDataClientDouble({
        subscribeSymbols: async (symbols) => {
          if ([...symbols].includes('ORDER_FAIL.HK')) throw orderError;
        },
        unsubscribeSymbols: async () => {},
        getQuotes: readQuotesForAll,
      }),
    });

    await harness.quoteSubscriptionRuntime.reconcileFromCurrentTruth();
    harness.quoteSubscriptionRuntime.start();

    try {
      harness.orderHoldSource.add('ORDER_FAIL.HK');
      await waitUntil(() => harness.termination.getFatalState().hasFatalError);

      expect(harness.termination.getFatalState()).toEqual({
        hasFatalError: true,
        error: orderError,
      });
      expect(harness.lastState.allTradingSymbols.has('ORDER_FAIL.HK')).toBe(false);
    } finally {
      await stopHarness(harness);
    }
  });
});
