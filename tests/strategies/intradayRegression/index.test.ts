import { createLoggerDouble } from '../../helpers/testDoubles.js';

/** T08–T13：直接创建策略，显式释放 scheduler，不通过旧 verifier 代理。 */
import { describe, expect, it } from 'bun:test';
import type { StrategyDecision } from '../../../src/types/strategy.js';

import { prepareFixture, createHarness } from './runtimeFixtures.js';
import { configObject } from './configFixtures.js';
import { marketContext } from './indicatorFixtures.js';

const now = 1_700_000_000_000;

function independentlyTriggerableSignals() {
  return {
    BUYCALL: '(RSI:6>-1000)',
    SELLCALL: '(RSI:6>-1000)',
    BUYPUT: '(RSI:6>-1000)',
    SELLPUT: '(RSI:6>-1000)',
  } as const;
}

describe('intraday regression instance', () => {
  it('can trigger all four immediate actions through an independent indicator', () => {
    const h = createHarness();
    const strategy = prepareFixture({
      ...configObject(),
      signals: independentlyTriggerableSignals(),
    }).create(h.deps);
    const emitted: StrategyDecision[] = [];

    strategy.onCandlestick(marketContext(), (decision) => {
      emitted.push(decision);
    });

    expect(emitted.map((decision) => decision.action)).toEqual([
      'BUYCALL',
      'SELLCALL',
      'BUYPUT',
      'SELLPUT',
    ]);
    expect(h.errors).toEqual([]);
    strategy.destroy();
  });

  it('reads each action clock before any registration; emits entire immediate batch before delayed registration', () => {
    const h = createHarness();
    h.setReads([now, now + 1, now + 2, now + 3, now + 100, now + 200]);
    const strategy = prepareFixture(configObject(60, 0, ['K'], [])).create(h.deps);
    const emitted: StrategyDecision[] = [];
    strategy.onCandlestick(marketContext(), (decision) => {
      emitted.push(decision);
      h.events.push(`emit:${decision.action}`);
    });

    expect(h.events).toEqual([
      `clock:${now}`,
      `clock:${now + 1}`,
      `clock:${now + 2}`,
      `clock:${now + 3}`,
      'emit:SELLCALL',
      'emit:SELLPUT',
      `clock:${now + 100}`,
      'timer:69900',
      `clock:${now + 200}`,
      'timer:69802',
    ]);

    expect(emitted.map((item) => [item.action, item.triggerTimeMs])).toEqual([
      ['SELLCALL', now + 1],
      ['SELLPUT', now + 3],
    ]);

    expect(Object.keys(emitted[0] ?? {}).sort((left, right) => left.localeCompare(right))).toEqual([
      'action',
      'reason',
      'triggerTimeMs',
    ]);
    strategy.destroy();
  });

  it('SELL requires current filled buy facts; BUY does not, and directions are independent', () => {
    const h = createHarness();
    const strategy = prepareFixture(configObject()).create(h.deps);
    const context = marketContext();
    const emitted: StrategyDecision[] = [];
    strategy.onCandlestick(
      { ...context, seats: context.seats.map((seat) => ({ ...seat, hasFilledBuyOrders: false })) },
      (value) => {
        emitted.push(value);
      },
    );
    expect(emitted.map((value) => value.action)).toEqual(['BUYCALL', 'BUYPUT']);
    strategy.destroy();
  });

  it('propagates unavailable current KDJ through display and signal N-of-M while retaining other indicators', () => {
    const h = createHarness();
    const strategy = prepareFixture({
      ...configObject(0, 0, ['D', 'ADX'], ['K']),
      signals: independentlyTriggerableSignals(),
    }).create(h.deps);
    const initial = marketContext();
    const latest = initial.candlesticks.candles.at(-1);
    if (!latest || typeof latest.timestamp !== 'number') throw new Error('expected latest candle');

    const bad = { ...latest, high: null, close: 80 };
    const badContext = {
      ...initial,
      candlesticks: {
        ...initial.candlesticks,
        version: 2,
        candles: [...initial.candlesticks.candles.slice(0, -1), bad],
        lastBarTimestamp: latest.timestamp,
      },
    };
    const emitted: StrategyDecision[] = [];
    const display = strategy.onCandlestick(badContext, (decision) => {
      emitted.push(decision);
    });

    expect(display?.find((item) => item.label === 'K')).toBeUndefined();
    expect(display?.find((item) => item.label === 'RSI6')).not.toBeUndefined();
    expect(emitted.map((decision) => decision.action)).toEqual([
      'BUYCALL',
      'SELLCALL',
      'BUYPUT',
      'SELLPUT',
    ]);

    const good = { ...latest, high: 100, low: 1, close: 80 };
    const goodDisplay = strategy.onCandlestick(
      {
        ...badContext,
        allowNewEvaluation: false,
        candlesticks: {
          ...badContext.candlesticks,
          version: 3,
          candles: [...badContext.candlesticks.candles.slice(0, -1), good],
        },
      },
      () => {},
    );
    expect(goodDisplay?.find((item) => item.label === 'K')).not.toBeUndefined();
    strategy.destroy();
  });

  it('does not create timers or immediate fallback for all actions when initial KDJ values are missing', () => {
    const context = marketContext();
    const latest = context.candlesticks.candles.at(-1);
    if (!latest || typeof latest.timestamp !== 'number') throw new Error('expected latest candle');

    const cases = [
      {
        name: 'bad HLC',
        candles: [
          ...context.candlesticks.candles.slice(0, -1),
          { ...latest, high: null, close: 80 },
        ],
      },
      {
        name: 'zero range',
        candles: context.candlesticks.candles.map((candle, index) =>
          index < context.candlesticks.candles.length - 9
            ? candle
            : { ...candle, high: 50, low: 50, close: 50 },
        ),
      },
    ];

    for (const testCase of cases) {
      const h = createHarness();
      const strategy = prepareFixture({
        ...configObject(60, 60, ['D', 'ADX'], ['K']),
        signals: independentlyTriggerableSignals(),
      }).create(h.deps);
      const emitted: StrategyDecision[] = [];
      strategy.onCandlestick(
        {
          ...context,
          candlesticks: {
            ...context.candlesticks,
            version: 2,
            candles: testCase.candles,
            lastBarTimestamp: latest.timestamp,
          },
        },
        (decision) => {
          emitted.push(decision);
        },
      );

      expect(h.timers, testCase.name).toHaveLength(0);
      expect(emitted, testCase.name).toHaveLength(0);
      expect(h.errors, testCase.name).toEqual([]);
      strategy.destroy();
    }
  });

  it('keeps pending through a zero-range sample when recovered nearest samples pass verification', () => {
    const h = createHarness();
    const strategy = prepareFixture({
      ...configObject(60, 0, ['K'], []),
      signals: independentlyTriggerableSignals(),
    }).create(h.deps);
    const baseContext = marketContext();
    const baseTimestamp = 1_700_100_000_000;
    const validHistory = Array.from({ length: 20 }, (_, index) => {
      const close = 100 + index;
      return {
        timestamp: baseTimestamp + index * 60_000,
        open: close - 0.2,
        high: close + 0.4,
        low: close - 0.6,
        close,
        volume: 1_000,
      };
    });
    const zeroRangeHistory = Array.from({ length: 8 }, (_, index) => ({
      timestamp: baseTimestamp + (20 + index) * 60_000,
      open: 50,
      high: 50,
      low: 50,
      close: 50,
      volume: 1_000,
    }));
    const activeTimestamp = baseTimestamp + 28 * 60_000;
    const activeGood = {
      timestamp: activeTimestamp,
      open: 0.1,
      high: 100,
      low: 0,
      close: 0.1,
      volume: 1_000,
    };
    const seats = [{ direction: 'LONG' as const, symbol: 'BULL.HK', hasFilledBuyOrders: false }];
    const candles = [...validHistory, ...zeroRangeHistory];
    const contextFor = (params: {
      readonly version: number;
      readonly observedAtMs: number;
      readonly active: typeof activeGood;
    }) => ({
      ...baseContext,
      observedAtMs: params.observedAtMs,
      allowNewEvaluation: params.version === 1,
      seats,
      candlesticks: {
        ...baseContext.candlesticks,
        version: params.version,
        candles: [...candles, params.active],
        lastBarTimestamp: activeTimestamp,
        lastBarConfirmed: false,
      },
    });

    const emitted: StrategyDecision[] = [];
    const initialDisplay = strategy.onCandlestick(
      contextFor({ version: 1, observedAtMs: now, active: activeGood }),
      (decision) => {
        emitted.push(decision);
      },
    );
    const initialKText = initialDisplay?.find((item) => item.label === 'K')?.valueText;
    if (initialKText === undefined) throw new Error('expected initial KDJ value');

    expect(h.timers).toHaveLength(1);
    expect(emitted).toHaveLength(0);

    const zeroRange = {
      ...activeGood,
      open: 50,
      high: 50,
      low: 50,
      close: 50,
    };
    const zeroDisplay = strategy.onCandlestick(
      contextFor({ version: 2, observedAtMs: now + 59_000, active: zeroRange }),
      () => {
        throw new Error('zero-range sample must not create a new decision');
      },
    );
    expect(zeroDisplay?.find((item) => item.label === 'K')).toBeUndefined();
    expect(h.timers).toHaveLength(1);
    expect(h.timers[0]?.cleared).toBe(false);

    const recovered = {
      ...activeGood,
      open: 99,
      close: 100,
    };
    for (const [version, observedAtMs] of [
      [3, now + 60_000],
      [4, now + 65_000],
      [5, now + 70_000],
    ] as const) {
      const recoveredDisplay = strategy.onCandlestick(
        contextFor({ version, observedAtMs, active: recovered }),
        () => {
          throw new Error('recovery samples must not create a new decision');
        },
      );
      const recoveredKText = recoveredDisplay?.find((item) => item.label === 'K')?.valueText;
      expect(recoveredKText).not.toBeUndefined();
      if (recoveredKText === undefined) throw new Error('expected recovered KDJ value');

      expect(Number(recoveredKText)).toBeGreaterThan(Number(initialKText));
    }

    h.timers[0]?.callback();
    expect(emitted.map((decision) => decision.action)).toEqual(['BUYCALL']);
    expect(h.errors).toEqual([]);
    strategy.destroy();
  });

  it('does not cancel or refill existing pending verification when a bad KDJ bar is sampled', () => {
    const h = createHarness();
    const strategy = prepareFixture(configObject(60, 60, ['K'], ['K'])).create(h.deps);
    const emitted: StrategyDecision[] = [];
    const initial = marketContext();
    strategy.onCandlestick(initial, (decision) => {
      emitted.push(decision);
    });
    expect(h.timers).toHaveLength(4);

    const latest = initial.candlesticks.candles.at(-1);
    if (!latest || typeof latest.timestamp !== 'number') throw new Error('expected latest candle');

    strategy.onCandlestick(
      {
        ...initial,
        observedAtMs: now + 70_000,
        allowNewEvaluation: false,
        candlesticks: {
          ...initial.candlesticks,
          version: 2,
          candles: [
            ...initial.candlesticks.candles.slice(0, -1),
            { ...latest, high: null, close: 80 },
          ],
          lastBarTimestamp: latest.timestamp,
        },
      },
      () => {},
    );
    expect(h.timers.every((timer) => !timer.cleared)).toBe(true);
    for (const timer of h.timers) timer.callback();

    expect(emitted).toHaveLength(0);
    expect(h.errors).toEqual([]);
    strategy.destroy();
  });

  it('samples during opening protection and delayed SELL may emit after filled buy facts become false', () => {
    const h = createHarness();
    const strategy = prepareFixture(configObject(60, 60, ['K'], ['K'])).create(h.deps);
    const emitted: StrategyDecision[] = [];
    strategy.onCandlestick(marketContext(), (value) => {
      emitted.push(value);
    });
    expect(h.timers).toHaveLength(4);
    const sample = marketContext(80, 2, now + 65000);
    const display = strategy.onCandlestick(
      {
        ...sample,
        allowNewEvaluation: false,
        seats: sample.seats.map((seat) => ({ ...seat, hasFilledBuyOrders: false })),
      },
      () => {
        throw new Error('protected origin must not emit');
      },
    );
    expect(display?.find((item) => item.label === 'K')?.valueText).toBe('59.596');
    expect(h.timers).toHaveLength(4);
    h.setNow(now + 999999);
    for (const timer of h.timers) timer.callback();

    expect(emitted.map((value) => [value.action, value.triggerTimeMs])).toEqual([
      ['BUYCALL', now + 60000],
      ['SELLPUT', now + 60000],
    ]);
    expect(h.errors).toEqual([]);
    strategy.destroy();
  });

  it('D3 distinguishes zero, decimal, Date-truncated advancement, and no raw advancement', () => {
    for (const [delay, timers, outputs, target] of [
      [0, 0, 2, now],
      [0.5, 2, 0, now + 500],
      [0.0001, 2, 0, now],
      [1e-10, 0, 0, now],
    ]) {
      if (
        delay === undefined ||
        timers === undefined ||
        outputs === undefined ||
        target === undefined
      )
        throw new Error('fixture');

      const h = createHarness();
      const strategy = prepareFixture(configObject(delay, delay, ['K'], ['K'])).create(h.deps);
      const emitted: StrategyDecision[] = [];
      const context = marketContext();
      strategy.onCandlestick(
        { ...context, seats: context.seats.filter((seat) => seat.direction === 'LONG') },
        (value) => {
          emitted.push(value);
        },
      );
      expect(h.timers).toHaveLength(timers);
      expect(emitted).toHaveLength(outputs);
      if (timers > 0) expect(h.timers[0]?.delay).toBe(target + 10000 - now);

      strategy.destroy();
    }
  });

  it('initial missing ADX drops delayed candidates without immediate fallback', () => {
    const h = createHarness();
    const strategy = prepareFixture({
      ...configObject(60, 60, ['ADX'], ['ADX']),
      signals: independentlyTriggerableSignals(),
    }).create(h.deps);
    const emitted: StrategyDecision[] = [];
    strategy.onCandlestick(marketContext(), (value) => {
      emitted.push(value);
    });
    expect(h.timers).toHaveLength(0);
    expect(emitted).toHaveLength(0);
    strategy.destroy();
  });

  it('deduplicates identity, invalidates one direction, and ignores stale callbacks after same-key replacement', () => {
    const h = createHarness();
    const strategy = prepareFixture(configObject(60, 60, ['K'], ['K'])).create(h.deps);
    const emitted: StrategyDecision[] = [];
    const emit = (value: StrategyDecision): void => {
      emitted.push(value);
    };
    strategy.onCandlestick(marketContext(), emit);
    strategy.onCandlestick(marketContext(), emit);
    expect(h.timers).toHaveLength(4);
    strategy.invalidateDirection('LONG');
    expect(h.timers.map((timer) => timer.cleared)).toEqual([true, true, false, false]);
    strategy.onCandlestick(marketContext(), emit);
    expect(h.timers).toHaveLength(6);
    strategy.onCandlestick(
      { ...marketContext(80, 2, now + 65000), allowNewEvaluation: false },
      emit,
    );
    h.timers[0]?.callback();
    h.timers[1]?.callback();
    expect(emitted).toHaveLength(0);
    h.timers[4]?.callback();
    h.timers[4]?.callback();
    h.timers[3]?.callback();
    expect(emitted.map((value) => value.action)).toEqual(['BUYCALL', 'SELLPUT']);
    strategy.destroy();
  });

  it('destroy is irreversible/idempotent, reset clears all state, and stale timers have no authority', () => {
    const h = createHarness();
    const strategy = prepareFixture(configObject(60, 60, ['K'], ['K'])).create(h.deps);
    const emitted: StrategyDecision[] = [];
    const emit = (value: StrategyDecision): void => {
      emitted.push(value);
    };
    strategy.onCandlestick(marketContext(), emit);
    strategy.resetForTradingDay();
    expect(h.timers.every((timer) => timer.cleared)).toBe(true);
    strategy.onCandlestick(
      { ...marketContext(), candlesticks: { ...marketContext().candlesticks, symbol: 'NEXT.HK' } },
      emit,
    );
    expect(h.errors).toEqual([]);
    strategy.destroy();
    strategy.destroy();
    strategy.resetForTradingDay();
    strategy.invalidateAll();
    const before = [h.events.length, h.timers.length];
    expect(
      strategy.onCandlestick({ ...marketContext(), observedAtMs: Number.NaN }, emit),
    ).toBeNull();

    for (const timer of h.timers) timer.callback();

    expect([h.events.length, h.timers.length]).toEqual(before);
    expect(emitted).toHaveLength(0);
  });

  it('same version events still sample; invalidateAll keeps market baseline and samples', () => {
    const h = createHarness();
    const strategy = prepareFixture(configObject(60, 60, ['K'], ['K'])).create(h.deps);
    const emitted: StrategyDecision[] = [];
    strategy.onCandlestick(marketContext(), (value) => {
      emitted.push(value);
    });

    strategy.onCandlestick(
      { ...marketContext(80, 2, now + 20000), allowNewEvaluation: false },
      () => {},
    );
    const repeated = strategy.onCandlestick(
      { ...marketContext(20, 2, now + 65000), allowNewEvaluation: false },
      () => {},
    );
    expect(repeated?.find((item) => item.label === 'K')?.valueText).toBe('59.596');
    // 不采同版本的65000样本时，三个目标都会更接近80000的下跌样本，BUYCALL不会通过。
    strategy.onCandlestick(
      { ...marketContext(20, 3, now + 80000), allowNewEvaluation: false },
      () => {},
    );
    h.timers[0]?.callback();
    expect(emitted.map((value) => value.action)).toEqual(['BUYCALL']);
    strategy.invalidateAll();
    const display = strategy.onCandlestick(
      { ...marketContext(80, 3, now + 85000), allowNewEvaluation: false },
      () => {},
    );
    expect(display?.find((item) => item.label === 'K')?.valueText).toBe('39.394');
    strategy.destroy();
  });

  it('invalid time, symbol invariants, emitter and scheduler errors synchronously report fatal, not null', () => {
    for (const fault of ['observed', 'clock', 'symbol', 'emit', 'schedule'] as const) {
      const h = createHarness();
      const strategy = prepareFixture(
        configObject(fault === 'schedule' ? 60 : 0, 0, ['K'], []),
      ).create({
        ...h.deps,
        ...(fault === 'schedule'
          ? {
              logger: createLoggerDouble(),
              scheduler: {
                ...h.deps.scheduler,
                scheduleTimer() {
                  throw new Error('schedule');
                },
              },
            }
          : { logger: createLoggerDouble() }),
      });
      if (fault === 'symbol')
        strategy.onCandlestick({ ...marketContext(), allowNewEvaluation: false }, () => {});

      if (fault === 'clock') h.setNow(Number.NaN);

      const context = marketContext();
      expect(() =>
        strategy.onCandlestick(
          {
            ...context,
            ...(fault === 'observed' ? { observedAtMs: Number.NaN } : {}),
            ...(fault === 'symbol'
              ? { candlesticks: { ...context.candlesticks, symbol: 'FOREIGN.HK' } }
              : {}),
          },
          () => {
            if (fault === 'emit') throw new Error('emit');
          },
        ),
      ).toThrow();
      expect(h.errors).toHaveLength(1);
      strategy.destroy();
    }
  });

  it('cancellation revokes every authorization even when one clearTimer throws', () => {
    const h = createHarness();
    const strategy = prepareFixture(configObject(60, 60, ['K'], ['K'])).create({
      ...h.deps,
      scheduler: {
        ...h.deps.scheduler,
        clearTimer(handle) {
          h.deps.scheduler.clearTimer(handle);
          throw new Error('clear');
        },
      },
    });
    strategy.onCandlestick(marketContext(), () => {
      throw new Error('must not emit');
    });

    expect(() => {
      strategy.destroy();
    }).toThrow('clear');
    expect(h.timers.every((timer) => timer.cleared)).toBe(true);
    for (const timer of h.timers) timer.callback();

    expect(h.errors).toHaveLength(1);
    strategy.destroy();
  });
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
