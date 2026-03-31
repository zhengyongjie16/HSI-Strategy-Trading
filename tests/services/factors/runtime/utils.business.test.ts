import { describe, expect, it } from 'bun:test';

import { computeMacd, getHongKongParts } from '../../../../src/services/factors/runtime/utils.js';

function computeEmaReference(values: ReadonlyArray<number>, period: number): number | null {
  if (values.length < period) {
    return null;
  }

  const smoothing = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((total, value) => total + value, 0) / period;
  for (let index = period; index < values.length; index += 1) {
    const value = values[index];
    if (value === undefined) {
      continue;
    }

    ema = value * smoothing + ema * (1 - smoothing);
  }

  return ema;
}

function computeMacdReference(values: ReadonlyArray<number>) {
  const fast = computeEmaReference(values, 12);
  const slow = computeEmaReference(values, 26);
  if (fast === null || slow === null) {
    return {
      dif: null,
      dea: null,
      macd: null,
    };
  }

  const macdBaseSeries: number[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const seriesFast = computeEmaReference(values.slice(0, index + 1), 12);
    const seriesSlow = computeEmaReference(values.slice(0, index + 1), 26);
    if (seriesFast !== null && seriesSlow !== null) {
      macdBaseSeries.push(seriesFast - seriesSlow);
    }
  }

  const dif = fast - slow;
  const dea = computeEmaReference(macdBaseSeries, 9);
  return {
    dif,
    dea,
    macd: dea === null ? null : (dif - dea) * 2,
  };
}

describe('factor runtime utils', () => {
  it('keeps MACD output identical to the historical implementation', () => {
    const values = Array.from({ length: 120 }, (_, index) => {
      return 20_000 + Math.sin(index / 7) * 30 + index * 0.8;
    });

    expect(computeMacd(values)).toEqual(computeMacdReference(values));
  });

  it('keeps Hong Kong time parsing output stable', () => {
    const timestamp = Date.UTC(2026, 2, 31, 1, 45, 0, 0);

    expect(getHongKongParts(timestamp)).toEqual({
      dayKey: '2026-03-31',
      minuteOfDay: 9 * 60 + 45,
    });
  });
});
