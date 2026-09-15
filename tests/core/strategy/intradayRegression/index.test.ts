/** T08–T13：直接创建策略，显式释放 scheduler，不通过旧 verifier 代理。 */
import { describe, expect, it } from 'bun:test';
import type { StrategyDecision } from '../../../../src/core/strategy/types.js';

import { prepareFixture, configObject, createHarness, marketContext } from './fixtures.js';

const now = 1_700_000_000_000;

describe('intraday regression instance', () => {
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
    const strategy = prepareFixture(configObject(60, 60, ['ADX'], ['ADX'])).create(h.deps);
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
              scheduler: {
                ...h.deps.scheduler,
                scheduleTimer() {
                  throw new Error('schedule');
                },
              },
            }
          : {}),
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
