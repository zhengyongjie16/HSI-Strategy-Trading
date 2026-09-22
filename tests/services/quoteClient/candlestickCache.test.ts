/**
 * quoteClient K 线缓存边界测试
 *
 * 功能：验证标准化输入、不可变 candle 复用、写时复制和乱序/重复推送语义。
 */
import { describe, expect, it } from 'bun:test';
import { Period } from 'longbridge';
import {
  applyCandlestickPush,
  createCandlestickCacheStore,
  seedCandlestickSeries,
} from '../../../src/services/quoteClient/candlestickCache.js';

class TestDecimal {
  public constructor(private readonly value: number) {}

  public toNumber(): number {
    return this.value;
  }
}

function createRawCandle(
  timestamp: number | string | undefined,
  close: number,
): Record<string, unknown> {
  return {
    ...(timestamp === undefined ? {} : { timestamp }),
    open: close - 0.2,
    high: close + 0.3,
    low: close - 0.4,
    close,
    volume: 1_000,
  };
}

const signedZeroFields = ['timestamp', 'open', 'high', 'low', 'close', 'volume'] as const;
type SignedZeroField = (typeof signedZeroFields)[number];
const signedZeroTransitions: ReadonlyArray<readonly [number, number]> = [
  [-0, 0],
  [0, -0],
];

function createCandleWithValue(field: SignedZeroField, value: number): Record<string, unknown> {
  const candle = createRawCandle(1_000, 1);
  return field === 'timestamp' ? { ...candle, timestamp: value } : { ...candle, [field]: value };
}

describe('candlestick cache immutable boundary', () => {
  it('normalizes and detaches seed inputs while freezing retained candles only', () => {
    const store = createCandlestickCacheStore({ maxCandles: 1 });
    const discarded = createRawCandle(1_000, 1);
    const retained = {
      ...createRawCandle('1970-01-01T00:20:00.000Z', 2),
      open: new TestDecimal(1.8),
    };
    const input = [discarded, retained];

    const snapshot = seedCandlestickSeries({
      store,
      symbol: 'HSI.HK',
      period: Period.Min_1,
      candles: input,
    });

    expect(snapshot.candles).toHaveLength(1);
    expect(snapshot.candles).not.toBe(input);
    expect(Object.isFrozen(snapshot)).toBeFalse();
    expect(Object.isFrozen(snapshot.candles)).toBeFalse();
    expect(Object.isFrozen(snapshot.candles[0])).toBeTrue();
    expect(snapshot.candles[0]).not.toBe(retained);
    expect(snapshot.candles[0]).toEqual({
      timestamp: 1_200_000,
      open: 1.8,
      high: 2.3,
      low: 1.6,
      close: 2,
      volume: 1_000,
    });

    Reflect.set(retained, 'close', new TestDecimal(99));
    input[0] = createRawCandle(2_000, 88);
    expect(snapshot.candles[0]?.close).toBe(2);
    expect(Object.isFrozen(retained)).toBeFalse();
    expect(Object.isFrozen(discarded)).toBeFalse();
  });

  it('retains primitive NaN/Infinity and applies finite toNumber conversion semantics', () => {
    const store = createCandlestickCacheStore({ maxCandles: 4 });
    const nanDecimal = { toNumber: () => Number.NaN };
    const infinityDecimal = { toNumber: () => Number.POSITIVE_INFINITY };
    const snapshot = seedCandlestickSeries({
      store,
      symbol: 'HSI.HK',
      period: Period.Min_1,
      candles: [
        {
          timestamp: 1_000,
          open: new TestDecimal(1.25),
          high: infinityDecimal,
          low: nanDecimal,
          close: Number.NaN,
          volume: Number.POSITIVE_INFINITY,
        },
        createRawCandle(undefined, 3),
      ],
    });

    expect(snapshot.candles[0]).toMatchObject({
      open: 1.25,
      high: undefined,
      low: undefined,
      close: Number.NaN,
      volume: Number.POSITIVE_INFINITY,
    });
    expect(snapshot.candles[1]?.timestamp).toBeUndefined();
    expect(snapshot.lastBarTimestamp).toBeNull();
    expect(snapshot.candles.every((candle) => Object.isFrozen(candle))).toBeTrue();
  });

  it('shares history across replacement and append while preserving old snapshots', () => {
    const store = createCandlestickCacheStore({ maxCandles: 3 });
    const seeded = seedCandlestickSeries({
      store,
      symbol: 'HSI.HK',
      period: Period.Min_1,
      candles: [createRawCandle(1_000, 10), createRawCandle(2_000, 11)],
    });
    const firstCandle = seeded.candles[0];
    const secondCandle = seeded.candles[1];

    const replaced = applyCandlestickPush({
      store,
      symbol: 'HSI.HK',
      period: Period.Min_1,
      candlestick: createRawCandle(2_000, 12),
      isConfirmed: false,
    });
    expect(replaced).not.toBeNull();
    if (replaced === null || firstCandle === undefined || secondCandle === undefined) {
      throw new Error('expected replacement snapshot');
    }

    expect(replaced.candles).not.toBe(seeded.candles);
    expect(replaced.candles[0]).toBe(firstCandle);
    expect(replaced.candles[1]).not.toBe(secondCandle);
    expect(replaced.candles[1]).toMatchObject({ close: 12 });
    expect(Object.isFrozen(replaced.candles[1])).toBeTrue();
    expect(seeded.candles[1]).toMatchObject({ close: 11 });

    const appended = applyCandlestickPush({
      store,
      symbol: 'HSI.HK',
      period: Period.Min_1,
      candlestick: createRawCandle(3_000, 13),
      isConfirmed: true,
    });
    expect(appended).not.toBeNull();
    if (appended === null) {
      throw new Error('expected appended snapshot');
    }

    expect(appended.candles).not.toBe(replaced.candles);
    expect(appended.candles[0]).toBe(firstCandle);
    expect(appended.candles[1]).toBe(replaced.candles[1]);
    expect(appended.candles[2]).not.toBeUndefined();
    expect(Object.isFrozen(appended.candles[2])).toBeTrue();
    expect(replaced.candles).toHaveLength(2);
    expect(appended.candles).toHaveLength(3);
  });

  it('reuses candle and array for confirmation-only updates and rejects stale or duplicate pushes', () => {
    const store = createCandlestickCacheStore({ maxCandles: 4 });
    const seeded = seedCandlestickSeries({
      store,
      symbol: 'HSI.HK',
      period: Period.Min_1,
      candles: [createRawCandle(1_000, 10)],
    });
    const confirmation = applyCandlestickPush({
      store,
      symbol: 'HSI.HK',
      period: Period.Min_1,
      candlestick: createRawCandle(1_000, 10),
      isConfirmed: true,
    });
    expect(confirmation).not.toBeNull();
    if (confirmation === null) {
      throw new Error('expected confirmation snapshot');
    }

    expect(confirmation.version).toBe(seeded.version + 1);
    expect(confirmation.candles).toBe(seeded.candles);
    expect(confirmation.candles[0]).toBe(seeded.candles[0]);

    const duplicate = applyCandlestickPush({
      store,
      symbol: 'HSI.HK',
      period: Period.Min_1,
      candlestick: createRawCandle(1_000, 10),
      isConfirmed: true,
    });
    const confirmedRollback = applyCandlestickPush({
      store,
      symbol: 'HSI.HK',
      period: Period.Min_1,
      candlestick: createRawCandle(1_000, 99),
      isConfirmed: false,
    });
    const old = applyCandlestickPush({
      store,
      symbol: 'HSI.HK',
      period: Period.Min_1,
      candlestick: createRawCandle(999, 9),
      isConfirmed: true,
    });
    const missingTimestamp = applyCandlestickPush({
      store,
      symbol: 'HSI.HK',
      period: Period.Min_1,
      candlestick: createRawCandle(undefined, 8),
      isConfirmed: true,
    });
    const invalid = applyCandlestickPush({
      store,
      symbol: 'HSI.HK',
      period: Period.Min_1,
      candlestick: null,
      isConfirmed: true,
    });

    expect(duplicate).toBe(confirmation);
    expect(confirmedRollback).toBe(confirmation);
    expect(old).toBe(confirmation);
    expect(missingTimestamp).toBe(confirmation);
    expect(invalid).toBe(confirmation);
    expect(confirmation.lastBarConfirmed).toBeTrue();
  });

  for (const field of signedZeroFields) {
    for (const [seedValue, incomingValue] of signedZeroTransitions) {
      it(`adopts exact ${field} representation on ${Object.is(seedValue, -0) ? '-0 to +0' : '+0 to -0'} confirmation change`, () => {
        const store = createCandlestickCacheStore({ maxCandles: 1 });
        const seeded = seedCandlestickSeries({
          store,
          symbol: 'HSI.HK',
          period: Period.Min_1,
          candles: [createCandleWithValue(field, seedValue)],
        });
        const accepted = applyCandlestickPush({
          store,
          symbol: 'HSI.HK',
          period: Period.Min_1,
          candlestick: createCandleWithValue(field, incomingValue),
          isConfirmed: false,
        });
        expect(accepted).not.toBeNull();
        if (accepted === null) {
          throw new Error('expected signed-zero confirmation update');
        }

        const seededCandle = seeded.candles.at(-1);
        const acceptedCandle = accepted.candles.at(-1);
        if (seededCandle === undefined || acceptedCandle === undefined) {
          throw new Error('expected signed-zero candle');
        }

        expect(accepted.version).toBe(seeded.version + 1);
        expect(accepted.candles).not.toBe(seeded.candles);
        expect(acceptedCandle).not.toBe(seededCandle);
        expect(Object.is(acceptedCandle[field], incomingValue)).toBeTrue();
        expect(
          Object.is(accepted.lastBarTimestamp, field === 'timestamp' ? incomingValue : 1_000),
        ).toBeTrue();
        expect(Object.isFrozen(acceptedCandle)).toBeTrue();

        const noop = applyCandlestickPush({
          store,
          symbol: 'HSI.HK',
          period: Period.Min_1,
          candlestick: createCandleWithValue(field, seedValue),
          isConfirmed: false,
        });
        expect(noop).toBe(accepted);
        expect(noop?.version).toBe(accepted.version);
        expect(noop?.candles).toBe(accepted.candles);
        expect(noop?.candles.at(-1)).toBe(acceptedCandle);
      });
    }
  }

  it('keeps === NaN changes as new versions instead of reusing the candle', () => {
    const store = createCandlestickCacheStore({ maxCandles: 1 });
    const nanCandle = { ...createRawCandle(1_000, 1), close: Number.NaN };
    const seeded = seedCandlestickSeries({
      store,
      symbol: 'HSI.HK',
      period: Period.Min_1,
      candles: [nanCandle],
    });

    const first = applyCandlestickPush({
      store,
      symbol: 'HSI.HK',
      period: Period.Min_1,
      candlestick: { ...nanCandle },
      isConfirmed: false,
    });
    expect(first).not.toBeNull();
    if (first === null) {
      throw new Error('expected first NaN update');
    }

    expect(first.version).toBe(seeded.version + 1);
    expect(first.candles).not.toBe(seeded.candles);
    expect(first.candles[0]).not.toBe(seeded.candles[0]);
    expect(Object.is(first.candles[0]?.close, Number.NaN)).toBeTrue();

    const second = applyCandlestickPush({
      store,
      symbol: 'HSI.HK',
      period: Period.Min_1,
      candlestick: { ...nanCandle },
      isConfirmed: false,
    });
    expect(second).not.toBeNull();
    if (second === null) {
      throw new Error('expected repeated NaN update');
    }

    expect(second.version).toBe(first.version + 1);
    expect(second.candles).not.toBe(first.candles);
    expect(second.candles[0]).not.toBe(first.candles[0]);
  });
});
