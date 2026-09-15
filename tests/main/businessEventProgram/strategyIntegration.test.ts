import { prepareFixture } from '../../core/strategy/intradayRegression/fixtures.js';

/** 真实策略 + 宿主 emitter + 席位取消：验证私有 pending 跨异步回流而不是旧 verifier mock。 */
import { describe, expect, it } from 'bun:test';
import { createSeatRuntimeCleanupDispatcher } from '../../../src/main/seatRuntimeCleanupDispatcher/index.js';
import { createMonitorTaskQueue } from '../../../src/main/asyncProgram/monitorTaskQueue/index.js';
import type { MonitorTaskDataMap } from '../../../src/main/asyncProgram/monitorTaskProcessor/types.js';
import type { TradingSignalStrategy } from '../../../src/core/strategy/types.js';
import { createEventHarness } from './fixtures.js';
import type { EventHarness, StrategyTimer } from './types.js';

/** 用显式 timer 回调替代真实等待，配置全部动作延迟 K 验证。 */
function attachStrategy(h: EventHarness, timers: StrategyTimer[]): TradingSignalStrategy {
  const strategy = prepareFixture({
    signals: {
      BUYCALL: '(K>-1000)',
      SELLCALL: '(K>-1000)',
      BUYPUT: '(K>-1000)',
      SELLPUT: '(K>-1000)',
    },
    verification: {
      buy: { delaySeconds: 60, indicators: ['K'] },
      sell: { delaySeconds: 60, indicators: ['K'] },
    },
  }).create({
    clock: h.deps.clock,
    scheduler: {
      scheduleTimer: (callback) => {
        const handle = setTimeout(() => {}, 0);
        clearTimeout(handle);
        timers.push({ callback, handle, cleared: false });
        return handle;
      },
      clearTimer: (handle) => {
        const entry = timers.find((timer) => timer.handle === handle);
        if (entry) {
          entry.cleared = true;
        }
      },
    },
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    onFatalError: h.termination.reportFatalError,
  });
  h.mutable.handler = strategy.onCandlestick;
  setCandles(h, 50);
  return strategy;
}

/** 固定 high/low，改变活动柱 close，使 K 样本确定上涨。 */
function setCandles(h: EventHarness, close: number): void {
  h.mutable.snapshot = {
    ...h.mutable.snapshot,
    version: h.mutable.snapshot.version + 1,
    lastBarTimestamp: 1_200_000,
    candles: Array.from({ length: 21 }, (_, index) => ({
      timestamp: index * 60_000,
      open: 50,
      high: 100,
      low: 1,
      close: index === 20 ? close : 50,
      volume: 1000,
    })),
  };
}

describe('真实策略 pending 集成', () => {
  it('SELL 初始有买单，清记录后保护期继续采样，验证通过按原 T0 入队', async () => {
    const h = createEventHarness();
    const timers: StrategyTimer[] = [];
    const strategy = attachStrategy(h, timers);
    const originTime = h.mutable.nowMs;
    h.program.start();
    h.publish();
    await Promise.resolve();
    expect(timers).toHaveLength(4);
    expect(h.contexts[0]?.seats.every((seat) => seat.hasFilledBuyOrders)).toBeTrue();
    h.mutable.filled = false;
    h.lastState.openProtectionActive = true;
    h.mutable.nowMs += 65_000;
    setCandles(h, 80);
    h.publish();
    await Promise.resolve();
    expect(h.contexts[1]?.allowNewEvaluation).toBeFalse();
    expect(h.contexts[1]?.seats.every((seat) => !seat.hasFilledBuyOrders)).toBeTrue();
    const reads = h.mutable.recordReads;
    h.mutable.nowMs += 100_000;
    for (const timer of timers) {
      timer.callback();
    }

    expect(h.sellTaskQueue.pop()?.data).toMatchObject({
      action: 'SELLPUT',
      symbol: 'BEAR.HK',
      triggerTime: new Date(originTime + 60_000),
    });
    expect(h.sellTaskQueue.isEmpty()).toBeTrue();
    expect(h.buyTaskQueue.pop()?.data.action).toBe('BUYCALL');
    expect(h.mutable.recordReads).toBe(reads);
    expect(h.termination.isTerminated()).toBeFalse();
    strategy.destroy();
    await h.program.stopAndDrain();
  });

  it('registry 返回前真实 LONG timers 已取消；SHORT pending 保留并可输出', async () => {
    const h = createEventHarness();
    const timers: StrategyTimer[] = [];
    const strategy = attachStrategy(h, timers);
    const dispatcher = createSeatRuntimeCleanupDispatcher({
      symbolRegistry: h.symbolRegistry,
      monitorContext: {
        strategy,
        riskChecker: { clearLongWarrantInfo: () => {}, clearShortWarrantInfo: () => {} },
      },
      buyTaskQueue: h.buyTaskQueue,
      sellTaskQueue: h.sellTaskQueue,
      monitorTaskQueue: createMonitorTaskQueue<MonitorTaskDataMap>(),
    });
    dispatcher.start();
    h.program.start();
    h.publish();
    await Promise.resolve();
    expect(timers.map((timer) => timer.cleared)).toEqual([false, false, false, false]);
    h.symbolRegistry.updateSeatStateWithVersionBump('LONG', {
      symbol: null,
      status: 'EMPTY',
      lastSeatActivatedAt: null,
      lastSwitchAt: null,
      lastSearchAt: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    });
    expect(timers.map((timer) => timer.cleared)).toEqual([true, true, false, false]);
    h.lastState.openProtectionActive = true;
    h.mutable.nowMs += 65_000;
    setCandles(h, 80);
    h.publish();
    await Promise.resolve();
    for (const timer of timers) {
      timer.callback();
    }

    expect(h.buyTaskQueue.isEmpty()).toBeTrue();
    expect(h.sellTaskQueue.pop()?.data.action).toBe('SELLPUT');
    expect(h.sellTaskQueue.isEmpty()).toBeTrue();
    expect(h.termination.isTerminated()).toBeFalse();
    dispatcher.stop();
    strategy.destroy();
    await h.program.stopAndDrain();
  });
});
