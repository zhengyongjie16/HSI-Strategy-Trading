/** T05/T06：真实 state 的窗口重建、partial、不变量与状态提交边界。 */
import { expect, it } from 'bun:test';
import {
  bootstrapIndicatorRuntime,
  buildSnapshotFromRuntime,
  updateRuntimeForCandlestickSnapshot,
} from '../../../../../src/core/strategy/intradayRegression/runtime/index.js';
import { parseStrategyConfig } from '../../../../../src/core/strategy/intradayRegression/config.js';
import {
  cloneKdjState,
  commitKdjCandle,
  createKdjState,
  readKdjValue,
} from '../../../../../src/core/strategy/intradayRegression/runtime/kdj.js';
import type { CandleData } from '../../../../../src/types/data.js';

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

it('rejects every invalid H/L/C input atomically and advances valid numeric candles', () => {
  const state = createKdjState(3, 2);
  const validCandles: ReadonlyArray<CandleData> = [
    { high: 10, low: 1, close: 5 },
    { high: 11, low: 2, close: 6 },
    { high: 12, low: 3, close: 7 },
    { high: 13, low: 4, close: 8 },
    { open: null, volume: undefined, high: ' 14 ', low: ' 5 ', close: ' 9 ' },
  ];
  for (const [index, candle] of validCandles.entries()) {
    const previousIndex = state.index;
    const result = commitKdjCandle(state, candle);
    expect(state.index).toBe(previousIndex + 1);
    expect(result.available).toBe(index === validCandles.length - 1);
  }

  const signedState = createKdjState(1, 1);
  expect(
    commitKdjCandle(signedState, {
      open: null,
      volume: undefined,
      high: 0,
      low: -1,
      close: -2,
    }),
  ).toEqual({ available: true });
  expect(signedState.index).toBe(1);

  const beforeInvalid = cloneKdjState(state);
  const invalidCandles: ReadonlyArray<CandleData> = [
    { high: null, low: 1, close: 5 },
    { high: 10, low: undefined, close: 5 },
    { high: 10, low: 1 },
    { high: 10, close: 5 },
    { high: 10, low: 1, close: null },
    { high: '   ', low: 1, close: 5 },
    { high: 10, low: 'not-a-number', close: 5 },
    { high: Number.NaN, low: 1, close: 5 },
    { high: Number.POSITIVE_INFINITY, low: 1, close: 5 },
    { high: 10, low: Number.NEGATIVE_INFINITY, close: 5 },
    { high: 10, low: 1, close: 'NaN' },
  ];
  for (const candle of invalidCandles) {
    const result = commitKdjCandle(state, candle);
    expect(result.available).toBe(false);
    expect(state).toEqual(beforeInvalid);
  }

  const reference = createKdjState(3, 2);
  for (const candle of validCandles) commitKdjCandle(reference, candle);

  expect(state).toEqual(reference);
  expect(readKdjValue(state)).toEqual(readKdjValue(reference));
});

it('recomputes default rolling sums after extreme RSV values leave the window', () => {
  const state = createKdjState();
  for (let index = 0; index < 10; index += 1) {
    const result = commitKdjCandle(state, { high: 1, low: 0, close: 1e306 });
    expect(state.index).toBe(index + 1);
    expect(result.available).toBe(false);
  }

  expect(state.rsvWindowSum).toBe(Infinity);
  expect(readKdjValue(state)).toBeNull();

  let lastResult = { available: false };
  for (let index = 0; index < 100; index += 1) {
    lastResult = commitKdjCandle(state, { high: 1, low: 0, close: 0.5 });
  }

  expect(lastResult).toEqual({ available: true });
  expect(state.rsvWindow).toEqual([50, 50, 50]);
  expect(state.rsvWindowSum).toBe(150);
  expect(state.kWindow).toEqual([50, 50, 50]);
  expect(state.kWindowSum).toBe(150);
  expect(readKdjValue(state)).toEqual({ k: 50, d: 50, j: 50 });
});

it('recovers a finite RSV sum when opposite extreme replacement would overflow the delta', () => {
  const state = createKdjState(1, 3);
  const positive = { high: 1, low: 0, close: 1e306 };
  const negative = { high: 1, low: 0, close: -1e306 };

  commitKdjCandle(state, positive);
  commitKdjCandle(state, negative);
  commitKdjCandle(state, positive);
  const result = commitKdjCandle(state, negative);

  expect(result).toEqual({ available: false });
  expect(state.rsvWindow).toEqual([-1e308, 1e308, -1e308]);
  expect(state.rsvWindowSum).toBe(-1e308);
  expect(Number.isFinite(state.rsvWindowSum)).toBe(true);
});

it('recovers both RSV and K rolling windows across positive and negative extremes', () => {
  const state = createKdjState(1, 1);
  const positive = { high: 1, low: 0, close: 1e306 };
  const negative = { high: 1, low: 0, close: -1e306 };

  expect(commitKdjCandle(state, positive)).toEqual({ available: false });
  expect(commitKdjCandle(state, negative)).toEqual({ available: false });

  expect(state.rsvWindowSum).toBe(-1e308);
  expect(state.kWindowSum).toBe(-1e308);
  expect(state.rsvWindow).toEqual([-1e308]);
  expect(state.kWindow).toEqual([-1e308]);
  expect(readKdjValue(state)).toBeNull();
});

it('advances only on valid candles while prewarming KDJ around invalid inputs', () => {
  const state = createKdjState(3, 2);
  const reference = createKdjState(3, 2);
  const validCandles: ReadonlyArray<CandleData> = [
    { high: 10, low: 1, close: 5 },
    { high: 11, low: 2, close: 6 },
    { high: 12, low: 3, close: 7 },
    { high: 13, low: 4, close: 8 },
    { high: 14, low: 5, close: 9 },
  ];
  const invalidCandles: ReadonlyArray<CandleData> = [
    { high: null, low: 1, close: 5 },
    { high: 11, low: undefined, close: 6 },
    { high: 12, low: 3, close: 'not-a-number' },
  ];

  for (const [index, candle] of validCandles.entries()) {
    const referenceResult = commitKdjCandle(reference, candle);
    const result = commitKdjCandle(state, candle);
    expect(state.index).toBe(reference.index);
    expect(result).toEqual(referenceResult);
    const invalid = invalidCandles[index];
    if (invalid === undefined) continue;

    const beforeInvalid = cloneKdjState(state);
    expect(commitKdjCandle(state, invalid).available).toBe(false);
    expect(state).toEqual(beforeInvalid);
  }

  expect(state).toEqual(reference);
  expect(state.hasKdjValue).toBe(true);
  expect(readKdjValue(state)).toEqual(readKdjValue(reference));
});

it('advances a legal zero-range window without erasing smoothing history and recovers on range restoration', () => {
  const state = createKdjState(3, 2);
  for (const candle of [
    { high: 10, low: 1, close: 5 },
    { high: 11, low: 2, close: 6 },
    { high: 12, low: 3, close: 7 },
    { high: 13, low: 4, close: 8 },
    { high: 14, low: 5, close: 9 },
  ]) {
    const previousIndex = state.index;
    commitKdjCandle(state, candle);
    expect(state.index).toBe(previousIndex + 1);
  }

  for (let index = 0; index < 2; index += 1) {
    const previousIndex = state.index;
    commitKdjCandle(state, { high: 0, low: 0, close: 0 });
    expect(state.index).toBe(previousIndex + 1);
  }

  const beforeZeroRange = cloneKdjState(state);
  const previousValue = readKdjValue(state);
  expect(previousValue).not.toBeNull();
  const zeroRangeResult = commitKdjCandle(state, { high: 0, low: 0, close: 0 });
  expect(zeroRangeResult.available).toBe(false);

  expect(state.index).toBe(beforeZeroRange.index + 1);
  expect(state.rsvWindow).toEqual(beforeZeroRange.rsvWindow);
  expect(state.rsvWindowSum).toBe(beforeZeroRange.rsvWindowSum);
  expect(state.kWindow).toEqual(beforeZeroRange.kWindow);
  expect(state.kWindowSum).toBe(beforeZeroRange.kWindowSum);
  expect(state.lastK).toBe(beforeZeroRange.lastK);
  expect(state.lastD).toBe(beforeZeroRange.lastD);
  expect(state.hasKdjValue).toBe(true);
  expect(readKdjValue(state)).toEqual(previousValue);

  const recovered = commitKdjCandle(state, { high: 6, low: 4, close: 5 });
  expect(recovered).toEqual({ available: true });
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
