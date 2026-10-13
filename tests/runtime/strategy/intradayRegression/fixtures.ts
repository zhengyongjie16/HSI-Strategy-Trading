/** 策略对象配置与依赖离线 fixture。 */
import { parseStrategyConfig } from '../../../../src/config/strategy/intradayRegression/config.js';
import { createIntradayRegressionStrategy } from '../../../../src/runtime/strategy/intradayRegression/index.js';
import type { PreparedStrategy, StrategyDeps } from '../../../../src/types/strategy.js';
import type { Harness, TimerEntry } from './types.js';

/** 注入可控时钟与 scheduler，不睡眠、不在登记栈运行回调。 */
export function createHarness(): Harness {
  let now = 1_700_000_000_000;
  let reads: number[] = [];
  const events: string[] = [];
  const errors: unknown[] = [];
  const timers: TimerEntry[] = [];
  const deps: StrategyDeps = {
    clock: {
      now() {
        const value = reads.shift() ?? now;
        events.push(`clock:${value}`);
        return new Date(value);
      },
    },
    scheduler: {
      scheduleTimer(callback, delay) {
        events.push(`timer:${delay}`);
        const handle = setTimeout(() => {}, 0);
        clearTimeout(handle);
        timers.push({ callback, delay, handle, cleared: false });
        return handle;
      },
      clearTimer(handle) {
        const entry = timers.find((timer) => timer.handle === handle);
        if (entry) entry.cleared = true;
      },
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    onFatalError(error) {
      errors.push(error);
      events.push('fatal');
    },
  };
  return {
    deps,
    timers,
    events,
    errors,
    setNow(value) {
      now = value;
    },
    setReads(values) {
      reads = [...values];
    },
  };
}

/** 准备测试自定义配置；生产 definition 始终使用静态 JSON。 */
export function prepareFixture(value: unknown): PreparedStrategy {
  const config = parseStrategyConfig(value);
  return { create: (deps: StrategyDeps) => createIntradayRegressionStrategy(config, deps) };
}
