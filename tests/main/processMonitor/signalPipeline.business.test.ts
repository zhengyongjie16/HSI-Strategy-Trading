/**
 * signalPipeline 业务测试
 *
 * 功能：
 * - 验证信号管道相关场景意图、边界条件与业务期望。
 */
import { describe, expect, it } from 'bun:test';

import { runSignalPipeline } from '../../../src/main/processMonitor/signalPipeline.js';
import {
  createBuyTaskQueue,
  createSellTaskQueue,
} from '../../../src/main/asyncProgram/tradeTaskQueue/index.js';

import type { Signal } from '../../../src/types/signal.js';
import type { IndicatorSnapshot } from '../../../src/types/quote.js';
import type { MainProgramContext } from '../../../src/main/mainProgram/types.js';
import type { StrategyRuntime } from '../../../src/types/state.js';
import type { SeatSyncResult } from '../../../src/main/processMonitor/types.js';

import {
  createFactorSnapshotDouble,
  createIndicatorDisplayProfileDouble,
  createOrderRecorderDouble,
  createPositionCacheDouble,
  createPositionDouble,
  createQuoteDouble,
  createSignalDouble,
  createStrategyRuntimeConfigDouble,
} from '../../helpers/testDoubles.js';

function createSnapshot(): IndicatorSnapshot {
  return {
    price: 100,
    changePercent: 0,
    factorSnapshot: createFactorSnapshotDouble(),
  };
}

function createSeatInfo(overrides: Partial<SeatSyncResult> = {}): SeatSyncResult {
  const base: SeatSyncResult = {
    longSeatState: {
      symbol: 'BULL.HK',
      status: 'ACTIVE',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    },
    shortSeatState: {
      symbol: 'BEAR.HK',
      status: 'ACTIVE',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    },
    longSeatVersion: 7,
    shortSeatVersion: 11,
    longSeatActive: true,
    shortSeatActive: true,
    longSymbol: 'BULL.HK',
    shortSymbol: 'BEAR.HK',
    longQuote: {
      ...createQuoteDouble('BULL.HK', 1.2),
      staticInfo: {
        callPrice: 50,
        warrantType: 'BULL',
      },
    },
    shortQuote: {
      ...createQuoteDouble('BEAR.HK', 0.9),
      staticInfo: {
        callPrice: 150,
        warrantType: 'BEAR',
      },
    },
  };

  return {
    ...base,
    ...overrides,
  };
}

function createPipelineHarness(params: {
  signals: ReadonlyArray<Signal>;
  seatInfo?: SeatSyncResult;
  canTradeNow?: boolean;
  openProtectionActive?: boolean;
  isTradingEnabled?: boolean;
}): {
  buyTaskQueue: ReturnType<typeof createBuyTaskQueue>;
  sellTaskQueue: ReturnType<typeof createSellTaskQueue>;
  releasedSignals: Signal[];
  releasedPositions: Array<string>;
} {
  const buyTaskQueue = createBuyTaskQueue();
  const sellTaskQueue = createSellTaskQueue();

  const releasedSignals: Signal[] = [];
  const releasedPositions: Array<string> = [];

  const monitorContext = {
    config: createStrategyRuntimeConfigDouble(),
    strategy: {
      generateSignals: () => params.signals,
    },
    orderRecorder: createOrderRecorderDouble(),
    indicatorProfile: createIndicatorDisplayProfileDouble(),
  } as unknown as StrategyRuntime;

  const positionCache = createPositionCacheDouble([
    createPositionDouble({ symbol: 'BULL.HK', quantity: 200, availableQuantity: 200 }),
    createPositionDouble({ symbol: 'BEAR.HK', quantity: 100, availableQuantity: 100 }),
  ]);

  const mainContext = {
    lastState: {
      positionCache,
    },
    buyTaskQueue,
    sellTaskQueue,
  } as unknown as MainProgramContext;

  runSignalPipeline({
    baseInstrumentSymbol: 'HSI.HK',
    monitorSnapshot: createSnapshot(),
    monitorContext,
    mainContext,
    runtimeFlags: {
      currentTime: new Date('2026-02-16T09:31:00.000Z'),
      isHalfDay: false,
      canTradeNow: params.canTradeNow ?? true,
      openProtectionActive: params.openProtectionActive ?? false,
      isTradingEnabled: params.isTradingEnabled ?? true,
    },
    seatInfo: params.seatInfo ?? createSeatInfo(),
    releaseSignal: (signal) => {
      releasedSignals.push(signal);
    },
    releasePosition: (position) => {
      releasedPositions.push(position.symbol);
    },
  });

  return {
    buyTaskQueue,
    sellTaskQueue,
    releasedSignals,
    releasedPositions,
  };
}

describe('signalPipeline business flow', () => {
  it('routes ready signals to correct queues and enriches seatVersion/symbolName', () => {
    const buySignal = createSignalDouble('BUYCALL', 'BULL.HK');
    buySignal.symbolName = null;
    const sellSignal = createSignalDouble('SELLPUT', 'BEAR.HK');
    sellSignal.symbolName = null;

    const harness = createPipelineHarness({
      signals: [buySignal, sellSignal],
    });

    const queuedBuy = harness.buyTaskQueue.pop();
    const queuedSell = harness.sellTaskQueue.pop();

    expect(queuedBuy?.type).toBe('IMMEDIATE_BUY');
    expect(queuedBuy?.data.seatVersion).toBe(7);
    expect(queuedBuy?.data.symbolName).toBe('BULL.HK');

    expect(queuedSell?.type).toBe('IMMEDIATE_SELL');
    expect(queuedSell?.data.seatVersion).toBe(11);
    expect(queuedSell?.data.symbolName).toBe('BEAR.HK');

    expect(harness.releasedSignals).toHaveLength(0);
    expect(harness.releasedPositions).toEqual(['BULL.HK', 'BEAR.HK']);
  });

  it('drops buy signal when quote is not ready but keeps sell signal path available', () => {
    const immediateBuy = createSignalDouble('BUYCALL', 'BULL.HK');
    const immediateSell = createSignalDouble('SELLCALL', 'BULL.HK');

    const harness = createPipelineHarness({
      signals: [immediateBuy, immediateSell],
      seatInfo: createSeatInfo({
        longQuote: null,
      }),
    });

    expect(harness.releasedSignals).toHaveLength(1);
    expect(harness.releasedSignals[0]?.action).toBe('BUYCALL');

    const queuedSell = harness.sellTaskQueue.pop();
    expect(queuedSell?.data.action).toBe('SELLCALL');
    expect(harness.buyTaskQueue.isEmpty()).toBeTrue();
  });

  it('releases valid signals instead of enqueue when trading gate is disabled', () => {
    const immediateBuy = createSignalDouble('BUYCALL', 'BULL.HK');
    const immediateShortBuy = createSignalDouble('BUYPUT', 'BEAR.HK');

    const harness = createPipelineHarness({
      signals: [immediateBuy, immediateShortBuy],
      isTradingEnabled: false,
    });

    expect(harness.buyTaskQueue.isEmpty()).toBeTrue();
    expect(harness.sellTaskQueue.isEmpty()).toBeTrue();
    expect(harness.releasedSignals).toEqual([immediateBuy, immediateShortBuy]);
  });

  it('returns early during opening protection and still releases pooled positions', () => {
    const harness = createPipelineHarness({
      signals: [createSignalDouble('BUYCALL', 'BULL.HK'), createSignalDouble('BUYPUT', 'BEAR.HK')],
      openProtectionActive: true,
    });

    expect(harness.buyTaskQueue.isEmpty()).toBeTrue();
    expect(harness.sellTaskQueue.isEmpty()).toBeTrue();
    expect(harness.releasedSignals).toHaveLength(0);
    expect(harness.releasedPositions).toEqual(['BULL.HK', 'BEAR.HK']);
  });
});
