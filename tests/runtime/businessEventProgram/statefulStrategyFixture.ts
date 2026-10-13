/** 有状态替代策略 fixture：只使用 TradingSignalStrategy 公共端口验证延迟回调生命周期。 */
import type {
  StrategyEmitter,
  StrategyMarketContext,
  TradingSignalStrategy,
} from '../../../src/types/strategy.js';
import type { RuntimeScheduler } from '../../../src/types/runtime.js';
import type { Action, Direction, PendingEntry, StatefulStrategyFixture } from './types.js';

/** 创建不读取 intradayRegression 私有状态的最小延迟策略；timer 由调用方注入并显式推进。 */
export function createStatefulStrategyFixture(
  scheduler: RuntimeScheduler,
): StatefulStrategyFixture {
  const pending = new Set<PendingEntry>();
  const invalidatedDirections: Direction[] = [];
  const lifecycle = {
    invalidatedDirections,
    resetCount: 0,
    destroyCount: 0,
  };
  let generation = 0;
  let destroyed = false;

  function cancel(entry: PendingEntry): void {
    if (entry.settled) return;

    entry.settled = true;
    pending.delete(entry);
    if (entry.timerHandle === null) throw new Error('stateful fixture pending timer missing');

    scheduler.clearTimer(entry.timerHandle);
  }

  function cancelDirection(direction?: Direction): void {
    for (const entry of pending) {
      if (direction === undefined || entry.direction === direction) {
        cancel(entry);
      }
    }
  }

  function schedule(
    direction: Direction,
    action: Action,
    context: StrategyMarketContext,
    emit: StrategyEmitter,
  ): void {
    const entry: PendingEntry = {
      action,
      direction,
      emit,
      generation,
      timerHandle: null,
      settled: false,
    };
    const handle = scheduler.scheduleTimer(() => {
      if (entry.settled || destroyed || entry.generation !== generation) return;

      entry.settled = true;
      pending.delete(entry);
      entry.emit({
        action: entry.action,
        triggerTimeMs: context.observedAtMs,
        reason: 'stateful-delayed',
      });
    }, 1_000);
    entry.timerHandle = handle;
    pending.add(entry);
  }

  const strategy: TradingSignalStrategy = {
    strategyId: 'stateful-test-strategy',
    onCandlestick(context, emit) {
      if (destroyed || !context.allowNewEvaluation) return null;

      for (const seat of context.seats) {
        if (seat.direction === 'LONG') {
          schedule('LONG', 'BUYCALL', context, emit);
        } else {
          schedule('SHORT', 'BUYPUT', context, emit);
        }
      }

      return [{ label: 'stateful', valueText: String(generation) }];
    },
    invalidateDirection(direction) {
      if (destroyed) return;

      invalidatedDirections.push(direction);
      cancelDirection(direction);
    },
    invalidateAll() {
      if (!destroyed) cancelDirection();
    },
    resetForTradingDay() {
      if (destroyed) return;

      cancelDirection();
      generation += 1;
      lifecycle.resetCount += 1;
    },
    destroy() {
      if (destroyed) return;

      destroyed = true;
      cancelDirection();
      lifecycle.destroyCount += 1;
    },
  };

  return { strategy, lifecycle };
}
