/** 普通行情事件的 latest-only、不可变投影及同步 fatal 回归。 */
import { describe, expect, it } from 'bun:test';
import { Period } from 'longbridge';
import { createEventHarness } from './fixtures.js';

describe('businessEventProgram 中性事件宿主', () => {
  it('积压只保留最新 observed 时间，读权威缓存，展示不重复调用，同版本继续采样', async () => {
    const h = createEventHarness();
    h.program.start();
    h.publish('OTHER.HK');
    h.publish('HSI.HK', Period.Min_5);
    h.publish();
    h.mutable.nowMs += 7;
    h.publish();
    const observed = h.mutable.nowMs;
    h.mutable.nowMs += 100;
    await Promise.resolve();
    expect(h.contexts).toHaveLength(1);
    expect(h.contexts[0]?.observedAtMs).toBe(observed);
    expect(h.displays).toEqual([[{ label: 'test', valueText: '1' }]]);
    h.publish();
    await Promise.resolve();
    expect(h.contexts).toHaveLength(2);
    expect(h.contexts[1]?.candlesticks.version).toBe(1);
    await h.program.stopAndDrain();
  });

  it('策略重入的多次事件也只处理最新观测', async () => {
    const h = createEventHarness();
    h.mutable.handler = () => {
      if (h.contexts.length === 1) {
        h.mutable.nowMs += 1;
        h.publish();
        h.mutable.nowMs += 2;
        h.publish();
      }

      return null;
    };
    h.program.start();
    h.publish();
    await Promise.resolve();
    expect(h.contexts).toHaveLength(2);
    expect(h.contexts[1]?.observedAtMs).toBe(h.mutable.nowMs);
    expect(h.displays).toHaveLength(0);
    await h.program.stopAndDrain();
  });

  it('完整行情、每根 candle、每个 seat 和 context 深冻结且不补零', async () => {
    const h = createEventHarness();
    const candle = {
      open: undefined,
      high: Number.NaN,
      low: Number.POSITIVE_INFINITY,
      close: null,
      volume: { toString: () => '123.4' },
    };
    h.mutable.snapshot = { ...h.mutable.snapshot, candles: [candle] };
    h.program.start();
    h.publish();
    await Promise.resolve();
    const context = h.contexts[0];
    if (!context) {
      throw new Error('missing context');
    }

    for (const value of [
      context,
      context.candlesticks,
      context.candlesticks.candles,
      context.candlesticks.candles[0],
      context.seats,
      ...context.seats,
    ]) {
      expect(Object.isFrozen(value)).toBeTrue();
    }

    expect(Reflect.ownKeys(context)).toEqual([
      'candlesticks',
      'observedAtMs',
      'allowNewEvaluation',
      'seats',
    ]);

    expect(context.seats[0]).toEqual({
      direction: 'LONG',
      symbol: 'BULL.HK',
      hasFilledBuyOrders: true,
    });

    expect(context.candlesticks.candles[0]).toEqual({
      open: undefined,
      high: Number.NaN,
      low: Number.POSITIVE_INFINITY,
      close: null,
      volume: '123.4',
    });
    expect(Reflect.set(context.candlesticks.candles[0] ?? {}, 'close', 100)).toBeFalse();
    candle.high = 999;
    expect(context.candlesticks.candles[0]?.high).toBeNaN();
    expect(candle.close).toBeNull();
    await h.program.stopAndDrain();
  });

  it.each(['protection', 'gate', 'day', 'takeover'] as const)(
    '%s 禁止新评估但保留单次行情与显示',
    async (boundary) => {
      const h = createEventHarness();
      if (boundary === 'protection') {
        h.lastState.openProtectionActive = true;
      }

      if (boundary === 'gate') {
        h.lastState.canTrade = false;
      }

      if (boundary === 'day') {
        h.lastState.currentDayKey = null;
      }

      if (boundary === 'takeover') {
        h.mutable.nowMs = Date.parse('2026-07-15T07:56:00Z');
        Object.assign(h.deps.tradingConfig.global, { doomsdayProtection: true });
      }

      h.program.start();
      h.publish();
      await Promise.resolve();
      expect(h.contexts).toHaveLength(1);
      expect(h.contexts[0]?.allowNewEvaluation).toBeFalse();
      expect(h.displays).toHaveLength(1);
      await h.program.stopAndDrain();
    },
  );

  it('非法监听时钟同步关门；终态后 start 不重新订阅', () => {
    const h = createEventHarness();
    h.program.start();
    h.mutable.nowMs = Number.NaN;
    expect(() => {
      h.publish();
    }).toThrow('监听时间');
    expect(h.termination.isTerminated()).toBeTrue();
    expect(h.lastState.isTradingEnabled).toBeFalse();
    expect(h.contexts).toHaveLength(0);
    h.program.start();
    expect(h.mutable.subscriptions).toBe(1);
  });

  it('门禁时钟非法时零采样；策略同步异常立即报告并停止', async () => {
    const h = createEventHarness();
    h.program.start();
    h.publish();
    h.mutable.nowMs = Number.NaN;
    await Promise.resolve();
    expect(h.contexts).toHaveLength(0);
    expect(h.termination.isTerminated()).toBeTrue();
    const second = createEventHarness();
    second.mutable.handler = () => {
      throw new Error('private invariant');
    };
    second.program.start();
    second.publish();
    await Promise.resolve();
    expect(second.termination.getFatalState()).toMatchObject({ hasFatalError: true });
    expect(second.displays).toHaveLength(0);
    await h.program.stopAndDrain();
    await second.program.stopAndDrain();
  });

  it('普通 stop 清积压而非永久 close，恢复后可继续处理', async () => {
    const h = createEventHarness();
    h.program.start();
    h.publish();
    await h.program.stopAndDrain();
    expect(h.contexts).toHaveLength(0);
    h.program.start();
    h.publish();
    await Promise.resolve();
    expect(h.contexts).toHaveLength(1);
    expect(h.termination.isTerminated()).toBeFalse();
    await h.program.stopAndDrain();
  });
});
