/** T05/T06：真实 state 的窗口重建、partial、不变量与状态提交边界。 */
import { expect, it } from 'bun:test';
import {
  bootstrapIndicatorRuntime,
  buildSnapshotFromRuntime,
  updateRuntimeForCandlestickSnapshot,
} from '../../../../../src/core/strategy/intradayRegression/runtime/index.js';
import { parseStrategyConfig } from '../../../../../src/core/strategy/intradayRegression/config.js';

import { prepareFixture, configObject, createHarness, marketContext } from '../fixtures.js';

it('rebuilds an authoritative disconnected window but never hides a symbol mismatch', () => {
  const profile = parseStrategyConfig(configObject()).profile;
  const cache = marketContext().candlesticks;
  const runtime = bootstrapIndicatorRuntime({
    symbol: cache.symbol,
    cacheSnapshot: cache,
    indicatorProfile: profile,
  });
  if (runtime === null) throw new Error('fixture');

  const disconnected = {
    ...cache,
    version: 2,
    lastBarTimestamp: cache.lastBarTimestamp === null ? null : cache.lastBarTimestamp + 6000000,
    candles: cache.candles.map((candle) => ({
      ...candle,
      timestamp: (candle.timestamp ?? 0) + 6000000,
    })),
  };
  const updated = updateRuntimeForCandlestickSnapshot({ runtime, cacheSnapshot: disconnected });
  const full = bootstrapIndicatorRuntime({
    symbol: cache.symbol,
    cacheSnapshot: disconnected,
    indicatorProfile: profile,
  });
  if (updated === null || full === null) throw new Error('fixture');

  expect(buildSnapshotFromRuntime(updated)).toEqual(buildSnapshotFromRuntime(full));
  expect(() =>
    updateRuntimeForCandlestickSnapshot({
      runtime,
      cacheSnapshot: { ...disconnected, symbol: 'WRONG.HK' },
    }),
  ).toThrow('symbol');
  expect(runtime.lastProcessedVersion).toBe(1);
  expect(() =>
    bootstrapIndicatorRuntime({
      symbol: 'WRONG.HK',
      cacheSnapshot: cache,
      indicatorProfile: profile,
    }),
  ).toThrow('symbol');
});

it('keeps partial N-of-M evaluable and does not commit a no-price candidate over valid old state', () => {
  const h = createHarness();
  const text = {
    ...configObject(),
    signals: {
      BUYCALL: '(K>-1000,RSI:100<10)/1',
      SELLCALL: '(K>-1000,RSI:100<10)/1',
      BUYPUT: '(K>-1000,RSI:100<10)/1',
      SELLPUT: '(K>-1000,RSI:100<10)/1',
    },
  };
  const strategy = prepareFixture(text).create(h.deps);
  const emitted: string[] = [];
  const cache = marketContext().candlesticks;
  const good = strategy.onCandlestick(marketContext(), (decision) => {
    emitted.push(decision.action);
  });
  expect(emitted).toHaveLength(4);
  expect(good?.some((item) => item.label === 'RSI100')).toBe(false);
  const invalid = {
    ...cache,
    version: 2,
    lastBarTimestamp: 999999,
    candles: [{ timestamp: 999999, open: null, high: null, low: null, close: null, volume: null }],
  };
  expect(
    strategy.onCandlestick({ ...marketContext(), candlesticks: invalid }, () => {}),
  ).toBeNull();
  const next = strategy.onCandlestick({ ...marketContext(), allowNewEvaluation: false }, () => {});
  expect(next).toEqual(good);
  expect(h.errors).toEqual([]);
  strategy.destroy();
});
