import { describe, expect, it, mock } from 'bun:test';
import { Period } from 'longbridge';
import { createSelectedStrategy } from '../../../src/app/startup/createSelectedStrategy.js';
import { createCleanup } from '../../../src/app/shutdown/createCleanup.js';
import type { PreparedStrategySelection } from '../../../src/app/startup/types.js';
import type {
  StrategyDeps,
  StrategyMarketContext,
  TradingSignalStrategy,
} from '../../../src/core/strategy/types.js';

const deps: StrategyDeps = {
  clock: { now: () => new Date(0) },
  scheduler: {
    scheduleTimer: () => {
      throw new Error('create must not schedule');
    },
    clearTimer: () => {},
  },
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  onFatalError: (error) => {
    throw error;
  },
};
function strategy(destroy: () => void): TradingSignalStrategy {
  return {
    strategyId: 'selected',
    onCandlestick: () => null,
    invalidateAll: () => {},
    invalidateDirection: () => {},
    resetForTradingDay: () => {},
    destroy,
  };
}

// 故意模拟运行时 JS 模块绕过静态返回值契约，不修改生产端口。
function selection(value: unknown): PreparedStrategySelection {
  return { strategyId: 'selected', prepared: { create: () => value as TradingSignalStrategy } };
}
describe('selected strategy cleanup boundary', () => {
  it('creates the single valid instance and destroys once across repeated cleanup', async () => {
    let destroyed = 0;
    const onCandlestick = mock(() => null);
    const instance = {
      ...strategy(() => {
        destroyed++;
      }),
      onCandlestick,
    };
    const cleanup = createCleanup();
    const selected = createSelectedStrategy(selection(instance), deps, cleanup);
    expect(selected).toBe(instance);
    const context: StrategyMarketContext = {
      candlesticks: {
        symbol: 'HSI.HK',
        period: Period.Min_1,
        version: 1,
        initialized: true,
        lastBarTimestamp: 0,
        lastBarConfirmed: false,
        candles: [],
      },
      observedAtMs: 0,
      allowNewEvaluation: false,
      seats: [],
    };
    const emit = () => {};
    expect(selected.onCandlestick(context, emit)).toBeNull();
    expect(onCandlestick).toHaveBeenCalledTimes(1);
    expect(onCandlestick).toHaveBeenCalledWith(context, emit);
    await cleanup.execute();
    await cleanup.execute();
    expect(destroyed).toBe(1);
  });

  for (const kind of [
    'wrongIdentity',
    'missingMethod',
    'missingCandlestickHook',
    'promise',
  ] as const) {
    it('registers destroy before rejecting ' + kind, async () => {
      let destroyed = 0;
      const destroy = () => {
        destroyed++;
      };
      let instance: unknown = { strategyId: 'selected', destroy };
      if (kind === 'promise') {
        instance = Object.assign(Promise.resolve(null), { destroy });
      } else if (kind === 'missingCandlestickHook') {
        instance = { ...strategy(destroy), onCandlestick: undefined };
      } else if (kind === 'wrongIdentity') {
        instance = { ...strategy(destroy), strategyId: 'other' };
      }

      const cleanup = createCleanup();
      expect(() => createSelectedStrategy(selection(instance), deps, cleanup)).toThrow(TypeError);
      await cleanup.execute();
      await cleanup.execute();
      expect(destroyed).toBe(1);
    });
  }

  it.each([null, undefined, 1, 'strategy'])(
    'rejects non-instance %p without inventing a disposer',
    async (value) => {
      const cleanup = createCleanup();
      expect(() => createSelectedStrategy(selection(value), deps, cleanup)).toThrow(TypeError);
      await cleanup.execute();
    },
  );
});
