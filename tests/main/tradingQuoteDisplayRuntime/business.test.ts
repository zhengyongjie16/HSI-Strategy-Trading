/**
 * tradingQuoteDisplayRuntime 业务测试
 *
 * 功能：
 * - 验证交易标的 quote 事件按单标的输出
 * - 验证异步补充 monitor quote 后会复核 seatVersion，旧 route 不输出
 */
import { describe, expect, it, mock } from 'bun:test';
import {
  createMonitorConfigDouble,
  createMonitorContextDouble,
  createQuoteDouble,
  createSymbolRegistryDouble,
} from '../../helpers/testDoubles.js';
import { createSymbolRegistry as createProductionSymbolRegistry } from '../../../src/services/autoSymbolManager/utils.js';
import { createExternalApiRequestError } from '../../../src/utils/apiFailure/index.js';
import type { QuoteUpdatedEvent } from '../../../src/types/services.js';

const warnLogs: string[] = [];

mock.module('../../../src/utils/logger/index.js', () => ({
  logger: {
    debug: () => {},
    info: () => {},
    warn: (message: string) => {
      warnLogs.push(message);
    },
    error: () => {},
  },
}));

function waitTick(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe('tradingQuoteDisplayRuntime', () => {
  it('uses the startup routing cache for trading quote events', async () => {
    warnLogs.length = 0;
    const { createTradingQuoteDisplayRuntime } =
      await import('../../../src/main/tradingQuoteDisplayRuntime/index.js');
    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol: 'HSI.HK',
      longSeat: {
        symbol: 'BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      shortSeat: {
        symbol: 'BEAR.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSeatActivatedAt: null,
        lastSearchAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
    });
    let quoteUpdatedListener: ((event: QuoteUpdatedEvent) => void) | undefined;
    const renders: string[] = [];
    const monitorContext = createMonitorContextDouble({ symbolRegistry });
    const runtime = createTradingQuoteDisplayRuntime({
      marketDataClient: {
        onQuoteUpdated: (listener: (event: QuoteUpdatedEvent) => void) => {
          quoteUpdatedListener = listener;
          return () => {
            if (quoteUpdatedListener === listener) {
              quoteUpdatedListener = undefined;
            }
          };
        },
        getQuotes: async () => new Map([['HSI.HK', createQuoteDouble('HSI.HK', 20_000)]]),
      },
      symbolRegistry,
      monitorContext,
      lastState: {
        isTradingEnabled: true,
        canTrade: true,
      },
      renderTradingQuote: (params: { readonly tradingSymbol: string }) => {
        renders.push(params.tradingSymbol);
      },
    });

    runtime.start();
    quoteUpdatedListener?.({
      symbol: 'BULL.HK',
      quote: createQuoteDouble('BULL.HK', 1.01),
    });

    await waitTick();

    expect(renders).toEqual(['BULL.HK']);
    await runtime.stopAndDrain();
  });

  it('refreshes routing cache when seat truth changes', async () => {
    warnLogs.length = 0;
    const { createTradingQuoteDisplayRuntime } =
      await import('../../../src/main/tradingQuoteDisplayRuntime/index.js');
    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol: 'HSI.HK',
      longSeat: {
        symbol: 'BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      shortSeat: {
        symbol: 'BEAR.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
    });
    let quoteUpdatedListener: ((event: QuoteUpdatedEvent) => void) | undefined;
    const renders: string[] = [];
    const runtime = createTradingQuoteDisplayRuntime({
      marketDataClient: {
        onQuoteUpdated: (listener: (event: QuoteUpdatedEvent) => void) => {
          quoteUpdatedListener = listener;
          return () => {
            if (quoteUpdatedListener === listener) {
              quoteUpdatedListener = undefined;
            }
          };
        },
        getQuotes: async () => new Map([['HSI.HK', createQuoteDouble('HSI.HK', 20_000)]]),
      },
      symbolRegistry,
      monitorContext: createMonitorContextDouble({ symbolRegistry }),
      lastState: {
        isTradingEnabled: true,
        canTrade: true,
      },
      renderTradingQuote: (params: { readonly tradingSymbol: string }) => {
        renders.push(params.tradingSymbol);
      },
    });

    runtime.start();

    symbolRegistry.updateSeatState('LONG', {
      symbol: 'NEXT_BULL.HK',
      status: 'ACTIVE',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    });

    quoteUpdatedListener?.({
      symbol: 'BULL.HK',
      quote: createQuoteDouble('BULL.HK', 1.01),
    });

    quoteUpdatedListener?.({
      symbol: 'NEXT_BULL.HK',
      quote: createQuoteDouble('NEXT_BULL.HK', 1.02),
    });
    await waitTick();

    expect(renders).toEqual(['NEXT_BULL.HK']);
    await runtime.stopAndDrain();
  });

  it('throws when startup routing cache build fails', async () => {
    warnLogs.length = 0;
    const { createTradingQuoteDisplayRuntime } =
      await import('../../../src/main/tradingQuoteDisplayRuntime/index.js');
    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol: 'HSI.HK',
      longSeat: {
        symbol: 'BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      shortSeat: {
        symbol: 'BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
    });
    const runtime = createTradingQuoteDisplayRuntime({
      marketDataClient: {
        onQuoteUpdated: () => () => {},
        getQuotes: async () => new Map([['HSI.HK', createQuoteDouble('HSI.HK', 20_000)]]),
      },
      symbolRegistry,
      monitorContext: createMonitorContextDouble({
        symbolRegistry,
      }),
      lastState: {
        isTradingEnabled: true,
        canTrade: true,
      },
      renderTradingQuote: () => {},
    });

    expect(() => {
      runtime.start();
    }).toThrow(/标的重复归属/);
    expect(warnLogs).toHaveLength(0);
  });

  it('exposes routing rebuild invariant errors when seat truth refresh fails', async () => {
    warnLogs.length = 0;
    const { createTradingQuoteDisplayRuntime } =
      await import('../../../src/main/tradingQuoteDisplayRuntime/index.js');
    const monitorConfig = createMonitorConfigDouble({
      monitorSymbol: 'HSI.HK',
      longSymbol: 'BULL.HK',
      shortSymbol: 'BEAR.HK',
    });
    const symbolRegistry = createProductionSymbolRegistry(monitorConfig);
    let quoteUpdatedListener: ((event: QuoteUpdatedEvent) => void) | undefined;
    const fatalErrors: Error[] = [];
    const renders: string[] = [];
    const runtime = createTradingQuoteDisplayRuntime({
      marketDataClient: {
        onQuoteUpdated: (listener: (event: QuoteUpdatedEvent) => void) => {
          quoteUpdatedListener = listener;
          return () => {
            if (quoteUpdatedListener === listener) {
              quoteUpdatedListener = undefined;
            }
          };
        },
        getQuotes: async () => new Map([['HSI.HK', createQuoteDouble('HSI.HK', 20_000)]]),
      },
      symbolRegistry,
      monitorContext: createMonitorContextDouble({ symbolRegistry }),
      lastState: {
        isTradingEnabled: true,
        canTrade: true,
      },
      renderTradingQuote: (params: { readonly tradingSymbol: string }) => {
        renders.push(params.tradingSymbol);
      },
      onFatalError: (error) => {
        fatalErrors.push(error instanceof Error ? error : new Error(String(error)));
      },
    });

    runtime.start();

    symbolRegistry.updateSeatState('SHORT', {
      symbol: 'BULL.HK',
      status: 'ACTIVE',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    });

    quoteUpdatedListener?.({
      symbol: 'BULL.HK',
      quote: createQuoteDouble('BULL.HK', 1.01),
    });
    await waitTick();

    expect(fatalErrors.some((error) => error.message.includes('标的重复归属'))).toBe(true);
    expect(renders).toEqual([]);
    expect(warnLogs).toHaveLength(0);
    await runtime.stopAndDrain();
  });

  it('stops responding to quote events after stopAndDrain', async () => {
    warnLogs.length = 0;
    const { createTradingQuoteDisplayRuntime } =
      await import('../../../src/main/tradingQuoteDisplayRuntime/index.js');
    const symbolRegistry = createSymbolRegistryDouble();
    let quoteUpdatedListener: ((event: QuoteUpdatedEvent) => void) | undefined;
    const renders: string[] = [];
    const runtime = createTradingQuoteDisplayRuntime({
      marketDataClient: {
        onQuoteUpdated: (listener: (event: QuoteUpdatedEvent) => void) => {
          quoteUpdatedListener = listener;
          return () => {
            if (quoteUpdatedListener === listener) {
              quoteUpdatedListener = undefined;
            }
          };
        },
        getQuotes: async () => new Map([['HSI.HK', createQuoteDouble('HSI.HK', 20_000)]]),
      },
      symbolRegistry,
      monitorContext: createMonitorContextDouble({ symbolRegistry }),
      lastState: {
        isTradingEnabled: true,
        canTrade: true,
      },
      renderTradingQuote: (params: { readonly tradingSymbol: string }) => {
        renders.push(params.tradingSymbol);
      },
    });

    runtime.start();

    await runtime.stopAndDrain();
    quoteUpdatedListener?.({
      symbol: 'BULL.HK',
      quote: createQuoteDouble('BULL.HK', 1.01),
    });
    await waitTick();

    expect(renders).toEqual([]);
  });

  it('subscribes seat truth changes on start and unsubscribes on stopAndDrain', async () => {
    warnLogs.length = 0;
    const { createTradingQuoteDisplayRuntime } =
      await import('../../../src/main/tradingQuoteDisplayRuntime/index.js');
    const symbolRegistry = createSymbolRegistryDouble();
    const runtime = createTradingQuoteDisplayRuntime({
      marketDataClient: {
        onQuoteUpdated: () => () => {},
        getQuotes: async () => new Map(),
      },
      symbolRegistry,
      monitorContext: createMonitorContextDouble({ symbolRegistry }),
      lastState: {
        isTradingEnabled: true,
        canTrade: true,
      },
      renderTradingQuote: () => {},
    });

    runtime.start();

    expect(symbolRegistry.getSeatTruthChangedListenerCount()).toBe(1);

    await runtime.stopAndDrain();

    expect(symbolRegistry.getSeatTruthChangedListenerCount()).toBe(0);
  });

  it('renders only the matched trading symbol event', async () => {
    warnLogs.length = 0;
    const { createTradingQuoteDisplayRuntime } =
      await import('../../../src/main/tradingQuoteDisplayRuntime/index.js');
    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol: 'HSI.HK',
      longSeat: {
        symbol: 'BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      shortSeat: {
        symbol: 'BEAR.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
    });
    let quoteUpdatedListener: ((event: QuoteUpdatedEvent) => void) | undefined;
    const renders: string[] = [];
    const runtime = createTradingQuoteDisplayRuntime({
      marketDataClient: {
        onQuoteUpdated: (listener: (event: QuoteUpdatedEvent) => void) => {
          quoteUpdatedListener = listener;
          return () => {
            if (quoteUpdatedListener === listener) {
              quoteUpdatedListener = undefined;
            }
          };
        },
        getQuotes: async () => new Map([['HSI.HK', createQuoteDouble('HSI.HK', 20_000)]]),
      },
      symbolRegistry,
      monitorContext: createMonitorContextDouble({ symbolRegistry }),
      lastState: {
        isTradingEnabled: true,
        canTrade: true,
      },
      renderTradingQuote: (params: { readonly tradingSymbol: string }) => {
        renders.push(params.tradingSymbol);
      },
    });

    runtime.start();
    quoteUpdatedListener?.({
      symbol: 'BULL.HK',
      quote: createQuoteDouble('BULL.HK', 1.01),
    });
    await waitTick();

    expect(renders).toEqual(['BULL.HK']);
    await runtime.stopAndDrain();
  });

  it('skips render when seatVersion changes before async quote supplement completes', async () => {
    warnLogs.length = 0;
    const { createTradingQuoteDisplayRuntime } =
      await import('../../../src/main/tradingQuoteDisplayRuntime/index.js');
    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol: 'HSI.HK',
      longSeat: {
        symbol: 'BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      shortSeat: {
        symbol: 'BEAR.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
    });
    let quoteUpdatedListener: ((event: QuoteUpdatedEvent) => void) | undefined;
    let resolveQuotes: (() => void) | undefined;
    const quoteBlocked = new Promise<void>((resolve) => {
      resolveQuotes = resolve;
    });
    const renders: string[] = [];
    const runtime = createTradingQuoteDisplayRuntime({
      marketDataClient: {
        onQuoteUpdated: (listener: (event: QuoteUpdatedEvent) => void) => {
          quoteUpdatedListener = listener;
          return () => {
            if (quoteUpdatedListener === listener) {
              quoteUpdatedListener = undefined;
            }
          };
        },
        getQuotes: async () => {
          await quoteBlocked;
          return new Map([['HSI.HK', createQuoteDouble('HSI.HK', 20_000)]]);
        },
      },
      symbolRegistry,
      monitorContext: createMonitorContextDouble({ symbolRegistry }),
      lastState: {
        isTradingEnabled: true,
        canTrade: true,
      },
      renderTradingQuote: (params: { readonly tradingSymbol: string }) => {
        renders.push(params.tradingSymbol);
      },
    });

    runtime.start();
    quoteUpdatedListener?.({
      symbol: 'BULL.HK',
      quote: createQuoteDouble('BULL.HK', 1.01),
    });
    symbolRegistry.updateSeatStateWithVersionBump('LONG', symbolRegistry.getSeatState('LONG'));
    resolveQuotes?.();
    await waitTick();
    await waitTick();

    expect(renders).toEqual([]);
    await runtime.stopAndDrain();
  });

  it('logs and skips when quote supplement fails, then continues rendering later events', async () => {
    const { createTradingQuoteDisplayRuntime } =
      await import('../../../src/main/tradingQuoteDisplayRuntime/index.js');
    warnLogs.length = 0;
    const quoteError = createExternalApiRequestError({
      operation: 'QuoteContext.realtimeQuote',
      attempts: 1,
      cause: new Error('quote supplement failed'),
    });
    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol: 'HSI.HK',
      longSeat: {
        symbol: 'BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      shortSeat: {
        symbol: 'BEAR.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
    });
    let quoteUpdatedListener: ((event: QuoteUpdatedEvent) => void) | undefined;
    let shouldFail = true;
    const renders: string[] = [];
    const runtime = createTradingQuoteDisplayRuntime({
      marketDataClient: {
        onQuoteUpdated: (listener: (event: QuoteUpdatedEvent) => void) => {
          quoteUpdatedListener = listener;
          return () => {
            if (quoteUpdatedListener === listener) {
              quoteUpdatedListener = undefined;
            }
          };
        },
        getQuotes: async () => {
          if (shouldFail) {
            shouldFail = false;
            throw quoteError;
          }

          return new Map([['HSI.HK', createQuoteDouble('HSI.HK', 20_000)]]);
        },
      },
      symbolRegistry,
      monitorContext: createMonitorContextDouble({ symbolRegistry }),
      lastState: {
        isTradingEnabled: true,
        canTrade: true,
      },
      renderTradingQuote: (params: { readonly tradingSymbol: string }) => {
        renders.push(params.tradingSymbol);
      },
    });

    runtime.start();
    quoteUpdatedListener?.({
      symbol: 'BULL.HK',
      quote: createQuoteDouble('BULL.HK', 1.01),
    });
    await waitTick();
    await waitTick();

    quoteUpdatedListener?.({
      symbol: 'BULL.HK',
      quote: createQuoteDouble('BULL.HK', 1.02),
    });
    await waitTick();
    await waitTick();

    expect(warnLogs).toHaveLength(1);
    expect(renders).toEqual(['BULL.HK']);
    await runtime.stopAndDrain();
  });

  it('exposes render invariant errors to fatal handler instead of treating them as quote supplement failures', async () => {
    const { createTradingQuoteDisplayRuntime } =
      await import('../../../src/main/tradingQuoteDisplayRuntime/index.js');
    warnLogs.length = 0;
    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol: 'HSI.HK',
      longSeat: {
        symbol: 'BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSeatActivatedAt: null,
        lastSearchAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      shortSeat: {
        symbol: 'BEAR.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSeatActivatedAt: null,
        lastSearchAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
    });
    let quoteUpdatedListener: ((event: QuoteUpdatedEvent) => void) | undefined;
    const renderError = new TypeError('display invariant broken');
    const fatalErrors: unknown[] = [];
    const runtime = createTradingQuoteDisplayRuntime({
      marketDataClient: {
        onQuoteUpdated: (listener: (event: QuoteUpdatedEvent) => void) => {
          quoteUpdatedListener = listener;
          return () => {
            if (quoteUpdatedListener === listener) {
              quoteUpdatedListener = undefined;
            }
          };
        },
        getQuotes: async () => new Map([['HSI.HK', createQuoteDouble('HSI.HK', 20_000)]]),
      },
      symbolRegistry,
      monitorContext: createMonitorContextDouble({ symbolRegistry }),
      lastState: {
        isTradingEnabled: true,
        canTrade: true,
      },
      renderTradingQuote: () => {
        throw renderError;
      },
      onFatalError: (error) => {
        fatalErrors.push(error);
      },
    });

    runtime.start();
    quoteUpdatedListener?.({
      symbol: 'BULL.HK',
      quote: createQuoteDouble('BULL.HK', 1.01),
    });
    await waitTick();
    await waitTick();

    expect(fatalErrors).toEqual([renderError]);
    expect(warnLogs).toHaveLength(0);
    await runtime.stopAndDrain();
  });
});
