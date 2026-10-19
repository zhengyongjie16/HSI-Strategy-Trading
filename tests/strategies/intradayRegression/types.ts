import type { CandleData } from '../../../src/types/data.js';
import type { StrategyDeps } from '../../../src/types/strategy.js';

/** 策略数学 fixture 的 K 线输入：OHLCV 可选事实加上运行期 timestamp，供冻结为 NormalizedCandle 快照。 */
export type FixtureCandle = CandleData & { readonly timestamp?: number };

/** 显式对象配置 fixture，保留可注入的非法数值边界。 */
export type ConfigFixture = {
  readonly signals: {
    readonly BUYCALL: string;
    readonly SELLCALL: string;
    readonly BUYPUT: string;
    readonly SELLPUT: string;
  };
  readonly verification: {
    readonly buy: { readonly delaySeconds: number; readonly indicators: ReadonlyArray<string> };
    readonly sell: { readonly delaySeconds: number; readonly indicators: ReadonlyArray<string> };
  };
};

/** 手动 scheduler 条目，原生空句柄立即取消，回调仅由测试显式释放。 */
export type TimerEntry = {
  readonly callback: () => void;
  readonly delay: number;
  readonly handle: ReturnType<typeof setTimeout>;
  cleared: boolean;
};

/** 策略测试环境，记录独立时钟、输出及 fatal 的同步顺序。 */
export type Harness = {
  readonly deps: StrategyDeps;
  readonly timers: TimerEntry[];
  readonly events: string[];
  readonly errors: unknown[];
  readonly setNow: (now: number) => void;
  readonly setReads: (reads: ReadonlyArray<number>) => void;
};
