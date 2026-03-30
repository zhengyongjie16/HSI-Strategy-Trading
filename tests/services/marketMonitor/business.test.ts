/**
 * marketMonitor 业务测试
 *
 * 功能：
 * - 验证市场监控相关场景意图、边界条件与业务期望。
 */
import { describe, expect, it } from 'bun:test';

import { createMarketMonitor } from '../../../src/services/marketMonitor/index.js';
import {
  formatPositionDisplay,
  formatWarrantDistanceDisplay,
} from '../../../src/services/marketMonitor/utils.js';
import type { IndicatorSnapshot } from '../../../src/types/quote.js';
import type { StrategyState } from '../../../src/types/state.js';
import {
  createFactorSnapshotDouble,
  createQuoteDouble,
  createWarrantDistanceInfoDouble,
} from '../../helpers/testDoubles.js';

function createStrategyState(baseInstrumentSymbol: string): StrategyState {
  return {
    baseInstrumentSymbol,
    monitorPrice: null,
    longPrice: null,
    shortPrice: null,
    signal: null,
    pendingSignals: [],
    monitorValues: null,
    lastMonitorSnapshot: null,
    lastCandlestickCacheVersion: null,
    lastDisplaySignature: null,
    displayPlan: ['price', 'changePercent'],
  };
}

function createSnapshot(overrides: Partial<IndicatorSnapshot> = {}): IndicatorSnapshot {
  return {
    price: 20_000,
    changePercent: 0,
    factorSnapshot: createFactorSnapshotDouble(),
    ...overrides,
  };
}

describe('marketMonitor business flow', () => {
  it('formats warrant distance display with unified label', () => {
    expect(formatWarrantDistanceDisplay(null)).toBeNull();

    const bullText = formatWarrantDistanceDisplay(
      createWarrantDistanceInfoDouble({
        warrantType: 'BULL',
        distanceToStrikePercent: 1.9,
      }),
    );
    expect(bullText).toBe('距回收价=+1.90%');

    const bearText = formatWarrantDistanceDisplay(
      createWarrantDistanceInfoDouble({
        warrantType: 'BEAR',
        distanceToStrikePercent: -2.35,
      }),
    );
    expect(bearText).toBe('距回收价=-2.35%');

    const unknownText = formatWarrantDistanceDisplay(
      createWarrantDistanceInfoDouble({
        warrantType: 'BULL',
        distanceToStrikePercent: null,
      }),
    );
    expect(unknownText).toBe('距回收价=未知');
  });

  it('formats position display text with required labels and order', () => {
    const display = formatPositionDisplay(
      {
        r1: 100,
        n1: 100,
        r2: 110,
        unrealizedPnL: 10,
      },
      2,
    );
    expect(display).toBe('持仓市值=110.00 持仓盈亏=+10.00 持仓数量=2');

    const emptyDisplay = formatPositionDisplay(null, null);
    expect(emptyDisplay).toBe('持仓市值=- 持仓盈亏=- 持仓数量=-');
  });

  it('detects price change with configured threshold and updates state', () => {
    const monitor = createMarketMonitor();
    const state = createStrategyState('HSI.HK');

    const firstChanged = monitor.monitorPriceChanges(
      createQuoteDouble('LONG.HK', 1),
      createQuoteDouble('SHORT.HK', 2),
      'LONG.HK',
      'SHORT.HK',
      state,
    );
    expect(firstChanged).toBe(true);
    expect(state.longPrice).toBe(1);
    expect(state.shortPrice).toBe(2);

    const belowThresholdChanged = monitor.monitorPriceChanges(
      createQuoteDouble('LONG.HK', 1.0005),
      createQuoteDouble('SHORT.HK', 2.0004),
      'LONG.HK',
      'SHORT.HK',
      state,
    );
    expect(belowThresholdChanged).toBe(false);

    const aboveThresholdChanged = monitor.monitorPriceChanges(
      createQuoteDouble('LONG.HK', 1.01),
      createQuoteDouble('SHORT.HK', 2),
      'LONG.HK',
      'SHORT.HK',
      state,
    );
    expect(aboveThresholdChanged).toBe(true);
    expect(state.longPrice).toBe(1.01);
  });

  it('detects factor snapshot changes and stores a display signature', () => {
    const monitor = createMarketMonitor();
    const state = createStrategyState('HSI.HK');
    const monitorQuote = createQuoteDouble('HSI.HK', 20_000);
    const klineTimestamp = 1_708_000_000_000;

    const first = monitor.monitorIndicatorChanges({
      monitorSnapshot: createSnapshot(),
      monitorQuote,
      baseInstrumentSymbol: 'HSI.HK',
      klineTimestamp,
      monitorState: state,
    });
    expect(first).toBe(true);
    expect(state.lastDisplaySignature).toContain('SESSION=am');
    expect(state.lastMonitorSnapshot?.factorSnapshot?.trendClassification).toBe('trend_up');

    const unchanged = monitor.monitorIndicatorChanges({
      monitorSnapshot: createSnapshot(),
      monitorQuote,
      baseInstrumentSymbol: 'HSI.HK',
      klineTimestamp,
      monitorState: state,
    });
    expect(unchanged).toBe(false);

    const changed = monitor.monitorIndicatorChanges({
      monitorSnapshot: createSnapshot({
        factorSnapshot: createFactorSnapshotDouble({
          trendScore: 1.5,
          er15: 0.7,
        }),
      }),
      monitorQuote,
      baseInstrumentSymbol: 'HSI.HK',
      klineTimestamp,
      monitorState: state,
    });
    expect(changed).toBe(true);
    expect(state.lastDisplaySignature).toContain('SCORE=1.500');
  });

  it('skips factor updates when snapshot does not carry factor runtime output', () => {
    const monitor = createMarketMonitor();
    const state = createStrategyState('HSI.HK');
    const monitorQuote = createQuoteDouble('HSI.HK', 20_000);

    const changed = monitor.monitorIndicatorChanges({
      monitorSnapshot: {
        price: 20_000,
        changePercent: 0,
        factorSnapshot: null,
      },
      monitorQuote,
      baseInstrumentSymbol: 'HSI.HK',
      klineTimestamp: 1_708_000_000_000,
      monitorState: state,
    });

    expect(changed).toBe(false);
    expect(state.lastDisplaySignature).toBeNull();
  });
});
