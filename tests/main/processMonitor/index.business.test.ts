/**
 * processMonitor/index 业务测试
 *
 * 功能：
 * - 验证 processMonitor 主流程相关场景意图、边界条件与业务期望。
 */
import { describe, expect, it } from 'bun:test';
import { Period } from 'longbridge';

import {
  createBuyTaskQueue,
  createSellTaskQueue,
} from '../../../src/main/asyncProgram/tradeTaskQueue/index.js';
import { createMonitorTaskQueue } from '../../../src/main/asyncProgram/monitorTaskQueue/index.js';
import type { CandleData } from '../../../src/types/data.js';
import type { Quote } from '../../../src/types/quote.js';
import type { Signal } from '../../../src/types/signal.js';
import type { ProcessMonitorParams } from '../../../src/main/processMonitor/types.js';
import type { StrategyRuntime } from '../../../src/types/state.js';
import {
  createStrategyRuntimeConfigDouble,
  createPositionCacheDouble,
  createQuoteDouble,
} from '../../helpers/testDoubles.js';
import { createStrategyRuntime as createStrategyRuntimeFromAsync } from '../asyncProgram/utils.js';

type ProcessMonitorFn = (
  context: ProcessMonitorParams,
  quotesMap: ReadonlyMap<string, Quote | null>,
) => Promise<void>;

async function loadProcessMonitor(): Promise<ProcessMonitorFn> {
  const modulePath = '../../../src/main/processMonitor/index.js?real-process-monitor';
  const module = await import(modulePath);
  return module.processMonitor as ProcessMonitorFn;
}

function createCandles(length: number, start: number, step: number): ReadonlyArray<CandleData> {
  const candles: CandleData[] = [];
  for (let i = 0; i < length; i += 1) {
    const close = start + i * step;
    candles.push({
      open: close - 0.1,
      high: close + 0.2,
      low: close - 0.3,
      close,
      volume: 1_000 + i,
    });
  }

  return candles;
}

function createHongKongSessionBaseTimestamp(hour: number, minute: number): number {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Hong_Kong',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(new Date());
  let year = '';
  let month = '';
  let day = '';
  for (const part of parts) {
    if (part.type === 'year') {
      year = part.value;
      continue;
    }

    if (part.type === 'month') {
      month = part.value;
      continue;
    }

    if (part.type === 'day') {
      day = part.value;
    }
  }

  return Date.parse(
    `${year}-${month}-${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+08:00`,
  );
}

function createStrategyRuntime(params: {
  readonly autoSearchEnabled: boolean;
  readonly strategyGenerate: () => ReadonlyArray<Signal>;
}): StrategyRuntime {
  return createStrategyRuntimeFromAsync({
    config: createStrategyRuntimeConfigDouble({
      baseInstrumentSymbol: 'HSI.HK',
      autoSearchConfig: {
        autoSearchEnabled: params.autoSearchEnabled,
        autoSearchMinDistancePctBull: 0.35,
        autoSearchMinDistancePctBear: -0.35,
        autoSearchMinTurnoverPerMinuteBull: 100_000,
        autoSearchMinTurnoverPerMinuteBear: 100_000,
        autoSearchExpiryMinMonths: 3,
        autoSearchOpenDelayMinutes: 0,
        switchIntervalMinutes: 0,
        switchDistanceRangeBull: { min: 0.2, max: 1.5 },
        switchDistanceRangeBear: { min: -1.5, max: -0.2 },
      },
    }),
    state: {
      baseInstrumentSymbol: 'HSI.HK',
      monitorPrice: 20_000,
      longPrice: null,
      shortPrice: null,
      signal: null,
      pendingSignals: [],
      lastMonitorSnapshot: null,
      lastCandlestickCacheVersion: null,
    },
    strategy: {
      generateSignals: params.strategyGenerate,
    },
  });
}

function createCacheSnapshot(candles: ReadonlyArray<CandleData>, version: number) {
  const latest = candles.at(-1);
  const timestamp =
    latest && typeof latest.timestamp === 'number' && Number.isFinite(latest.timestamp)
      ? latest.timestamp
      : null;
  return {
    symbol: 'HSI.HK',
    period: Period.Min_1,
    version,
    candles,
    lastBarTimestamp: timestamp,
    lastBarConfirmed: false,
    initialized: true,
  };
}

describe('processMonitor end-to-end orchestration', () => {
  it('returns early when indicator pipeline cannot build snapshot', async () => {
    const processMonitor = await loadProcessMonitor();
    let strategyCalls = 0;
    const monitorContext = createStrategyRuntime({
      autoSearchEnabled: false,
      strategyGenerate: () => {
        strategyCalls += 1;
        return [];
      },
    });

    const buyTaskQueue = createBuyTaskQueue();
    const sellTaskQueue = createSellTaskQueue();
    const monitorTaskQueue = createMonitorTaskQueue();

    const params: ProcessMonitorParams = {
      context: {
        marketDataClient: {
          getCandlestickSnapshot: () => null,
        },
        marketMonitor: {
          monitorPriceChanges: () => false,
          monitorIndicatorChanges: () => false,
        },
        buyTaskQueue,
        sellTaskQueue,
        monitorTaskQueue,
        lastState: {
          positionCache: createPositionCacheDouble(),
        },
      } as never,
      monitorContext,
      runtimeFlags: {
        currentTime: new Date('2026-02-16T01:00:00.000Z'),
        isHalfDay: false,
        canTradeNow: true,
        openProtectionActive: false,
        isTradingEnabled: true,
      },
    };

    await processMonitor(params, new Map([['HSI.HK', createQuoteDouble('HSI.HK', 20_010)]]));

    expect(strategyCalls).toBe(0);
    expect(buyTaskQueue.isEmpty()).toBeTrue();
    expect(sellTaskQueue.isEmpty()).toBeTrue();
  });

  it('runs indicator+signal chain when candles are available and updates monitor price', async () => {
    const processMonitor = await loadProcessMonitor();
    let strategyCalls = 0;
    const monitorContext = createStrategyRuntime({
      autoSearchEnabled: false,
      strategyGenerate: () => {
        strategyCalls += 1;
        return [];
      },
    });

    const buyTaskQueue = createBuyTaskQueue();
    const sellTaskQueue = createSellTaskQueue();
    const monitorTaskQueue = createMonitorTaskQueue();
    const sessionBaseTimestamp = createHongKongSessionBaseTimestamp(9, 30);
    const candles = createCandles(120, 20_000, 2);
    const sessionCandles = candles.map((candle, index) => ({
      ...candle,
      timestamp: sessionBaseTimestamp + index * 60_000,
    }));

    const params: ProcessMonitorParams = {
      context: {
        marketDataClient: {
          getCandlestickSnapshot: () => createCacheSnapshot(sessionCandles, 1),
        },
        marketMonitor: {
          monitorPriceChanges: () => false,
          monitorIndicatorChanges: () => false,
        },
        buyTaskQueue,
        sellTaskQueue,
        monitorTaskQueue,
        lastState: {
          positionCache: createPositionCacheDouble(),
        },
      } as never,
      monitorContext,
      runtimeFlags: {
        currentTime: new Date('2026-02-16T01:00:01.000Z'),
        isHalfDay: false,
        canTradeNow: true,
        openProtectionActive: false,
        isTradingEnabled: true,
      },
    };

    await processMonitor(
      params,
      new Map([
        ['HSI.HK', createQuoteDouble('HSI.HK', 20_050)],
        ['BULL.HK', createQuoteDouble('BULL.HK', 1.1)],
        ['BEAR.HK', createQuoteDouble('BEAR.HK', 0.9)],
      ]),
    );

    expect(strategyCalls).toBe(1);
    expect(monitorContext.state.monitorPrice).toBe(20_050);
    expect(buyTaskQueue.isEmpty()).toBeTrue();
    expect(sellTaskQueue.isEmpty()).toBeTrue();
  });

  it('returns early when monitor quote price is invalid even if candles are available', async () => {
    const processMonitor = await loadProcessMonitor();
    let strategyCalls = 0;
    const monitorContext = createStrategyRuntime({
      autoSearchEnabled: false,
      strategyGenerate: () => {
        strategyCalls += 1;
        return [];
      },
    });

    const buyTaskQueue = createBuyTaskQueue();
    const sellTaskQueue = createSellTaskQueue();
    const monitorTaskQueue = createMonitorTaskQueue();
    const sessionBaseTimestamp = createHongKongSessionBaseTimestamp(9, 30);
    const candles = createCandles(120, 20_000, 2);
    const sessionCandles = candles.map((candle, index) => ({
      ...candle,
      timestamp: sessionBaseTimestamp + index * 60_000,
    }));

    const params: ProcessMonitorParams = {
      context: {
        marketDataClient: {
          getCandlestickSnapshot: () => createCacheSnapshot(sessionCandles, 1),
        },
        marketMonitor: {
          monitorPriceChanges: () => false,
          monitorIndicatorChanges: () => false,
        },
        buyTaskQueue,
        sellTaskQueue,
        monitorTaskQueue,
        lastState: {
          positionCache: createPositionCacheDouble(),
        },
      } as never,
      monitorContext,
      runtimeFlags: {
        currentTime: new Date('2026-02-16T01:00:01.000Z'),
        isHalfDay: false,
        canTradeNow: true,
        openProtectionActive: false,
        isTradingEnabled: true,
      },
    };

    await processMonitor(
      params,
      new Map([
        ['HSI.HK', { ...createQuoteDouble('HSI.HK', 20_050), price: Number.NaN }],
        ['BULL.HK', createQuoteDouble('BULL.HK', 1.1)],
        ['BEAR.HK', createQuoteDouble('BEAR.HK', 0.9)],
      ]),
    );

    expect(strategyCalls).toBe(0);
    expect(buyTaskQueue.isEmpty()).toBeTrue();
    expect(sellTaskQueue.isEmpty()).toBeTrue();
  });
});
