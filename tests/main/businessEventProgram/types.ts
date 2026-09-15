import type { Period } from 'longbridge';
import type {
  BusinessEventProgram,
  BusinessEventProgramDeps,
} from '../../../src/main/businessEventProgram/types.js';
import type {
  StrategyDisplayItem,
  StrategyEmitter,
  StrategyMarketContext,
  TradingSignalStrategy,
} from '../../../src/core/strategy/types.js';
import type { CandlestickCacheSnapshot } from '../../../src/types/services.js';
import type { SymbolRegistry } from '../../../src/types/seat.js';
import type { RuntimeTermination } from '../../../src/types/runtime.js';
import type {
  BuyTaskType,
  SellTaskType,
  TaskQueue,
} from '../../../src/main/asyncProgram/tradeTaskQueue/types.js';

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
  readonly lastState: BusinessEventProgramDeps['lastState'];
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
  readonly publish: (symbol?: string, period?: Period) => void;
  readonly emitter: () => StrategyEmitter;
};

/** 策略私有 timer 的可控离线登记，不在 schedule 调用栈执行。 */
export type StrategyTimer = {
  readonly callback: () => void;
  readonly handle: ReturnType<typeof setTimeout>;
  cleared: boolean;
};
