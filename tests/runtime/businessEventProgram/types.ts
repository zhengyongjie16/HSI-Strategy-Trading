import type { RuntimeStateFixtures } from '../../helpers/types.js';
import type {
  CandlestickPeriod,
  CandlestickCacheSnapshot,
} from '../../../src/types/marketPorts.js';
import type {
  BusinessEventProgram,
  BusinessEventProgramDeps,
} from '../../../src/runtime/businessEventProgram/types.js';
import type {
  StrategyDisplayItem,
  StrategyEmitter,
  StrategyMarketContext,
  TradingSignalStrategy,
} from '../../../src/types/strategy.js';
import type { SymbolRegistry } from '../../../src/types/seat.js';
import type { RuntimeTermination } from '../../../src/types/runtime.js';
import type {
  BuyTaskType,
  SellTaskType,
  TaskQueue,
} from '../../../src/runtime/asyncProgram/tradeTaskQueue/types.js';

/** D-event 测试中显式可变的时间、缓存与订单事实。 */
export type EventHarnessMutable = {
  nowMs: number;
  filled: boolean;
  recordReads: number;
  subscriptions: number;
  unsubscriptions: number;
  handler: TradingSignalStrategy['onCandlestick'] | null;
  snapshot: CandlestickCacheSnapshot;
};

/** 本包真实 owner/registry/queue 离线测试端口。 */
export type EventHarness = {
  readonly mutable: EventHarnessMutable;
  readonly stateFixtures: RuntimeStateFixtures;
  readonly buyTaskQueue: TaskQueue<BuyTaskType>;
  readonly sellTaskQueue: TaskQueue<SellTaskType>;
  readonly symbolRegistry: SymbolRegistry;
  readonly contexts: ReadonlyArray<StrategyMarketContext>;
  readonly emitters: ReadonlyArray<StrategyEmitter>;
  readonly displays: ReadonlyArray<ReadonlyArray<StrategyDisplayItem>>;
  readonly strategy: TradingSignalStrategy;
  readonly termination: RuntimeTermination;
  readonly deps: BusinessEventProgramDeps;
  readonly program: BusinessEventProgram;
  readonly publish: (symbol?: string, period?: CandlestickPeriod) => void;
  readonly emitter: () => StrategyEmitter;
};

/** 策略私有 timer 的可控离线登记，不在 schedule 调用栈执行。 */
export type StrategyTimer = {
  readonly callback: () => void;
  readonly handle: ReturnType<typeof setTimeout>;
  cleared: boolean;
};

/**
 * 有状态替代策略测试可验证的策略方向。
 * 用途：标记延迟动作所属的席位方向。
 * 使用范围：statefulStrategyFixture.ts 的 pending 状态与生命周期观察。
 */
export type Direction = 'LONG' | 'SHORT';

/**
 * 有状态替代策略测试的延迟买入动作。
 * 用途：限制 fixture 只产生可验证的普通买入动作。
 * 数据来源：由测试 fixture 根据席位方向选择。
 * 使用范围：statefulStrategyFixture.ts 的 pending 状态。
 */
export type Action = 'BUYCALL' | 'BUYPUT';

/**
 * 有状态替代策略的待处理延迟项。
 * 用途：保存延迟 emitter、生命周期代数与可取消的 timer 状态。
 * 数据来源：由 statefulStrategyFixture.ts 在策略评估时创建。
 * 使用范围：statefulStrategyFixture.ts 的取消、重置与销毁流程。
 */
export type PendingEntry = {
  readonly action: Action;
  readonly direction: Direction;
  readonly emit: StrategyEmitter;
  readonly generation: number;
  timerHandle: ReturnType<typeof setTimeout> | null;
  settled: boolean;
};

/**
 * 有状态替代策略测试 fixture 的公共结果。
 * 用途：向验收用例提供策略实例及生命周期观察值。
 * 数据来源：由 statefulStrategyFixture.ts 创建。
 * 使用范围：statefulStrategy.test.ts 与 fixture 工厂函数。
 */
export type StatefulStrategyFixture = {
  readonly strategy: TradingSignalStrategy;
  readonly lifecycle: {
    readonly invalidatedDirections: ReadonlyArray<Direction>;
    readonly resetCount: number;
    readonly destroyCount: number;
  };
};
