import type { createBusinessEventProgram } from '../../../src/runtime/businessEventProgram/index.js';
import type {
  createBuyTaskQueue,
  createSellTaskQueue,
} from '../../../src/runtime/asyncProgram/tradeTaskQueue/index.js';
import type { createTerminationRuntime } from '../../../src/runtime/lifecycle/terminationRuntime.js';
import type { createSelectedStrategy } from '../../../src/app/startup/createSelectedStrategy.js';
import type { prepareStrategy } from '../../../src/app/startup/prepareStrategy.js';
import type { createCleanup } from '../../../src/app/shutdown/createCleanup.js';
import type { createSymbolRegistry } from '../../../src/domain/seat/symbolRegistry.js';

/**
 * 单个独立 schema 策略的替换性用例参数。
 * 数据来源：replaceability.integration.test.ts 的 fixture 常量，父进程通过命令行 JSON 传给子进程。
 * 使用范围：临时策略 definition 的生成与源码 smoke 的队列字段断言。
 */
export type StrategyReplaceabilityCase = {
  readonly id: string;
  readonly directory: string;
  readonly action: 'BUYCALL' | 'SELLPUT';
  readonly symbol: string;
  readonly symbolName: string;
  readonly reason: string;
};

/**
 * 临时工程源码中真实宿主入口的导出集合。
 * 数据来源：importFixtureModule 从临时工程加载的 app/runtime/domain 模块。
 * 使用范围：smoke 子进程组装 prepare、实例、队列、终止与清理，不回落仓库默认实现。
 */
export type StrategyReplaceabilityRuntime = {
  readonly prepareStrategy: typeof prepareStrategy;
  readonly createSelectedStrategy: typeof createSelectedStrategy;
  readonly createCleanup: typeof createCleanup;
  readonly createBusinessEventProgram: typeof createBusinessEventProgram;
  readonly createBuyTaskQueue: typeof createBuyTaskQueue;
  readonly createSellTaskQueue: typeof createSellTaskQueue;
  readonly createTerminationRuntime: typeof createTerminationRuntime;
  readonly createSymbolRegistry: typeof createSymbolRegistry;
};

/**
 * smoke 子进程观察到的决策队列任务。
 * 数据来源：真实 emitter 经宿主适配器写入的 TaskQueue 条目。
 * 使用范围：父进程复核 action、标的、席位版本、触发时间与原因字段。
 */
export type StrategyReplaceabilityTask = {
  readonly type: 'STRATEGY_BUY' | 'STRATEGY_SELL';
  readonly action: 'BUYCALL' | 'SELLPUT';
  readonly symbol: string;
  readonly symbolName: string;
  readonly seatVersion: number;
  readonly triggerTimeMs: number;
  readonly reason: string;
};

/**
 * smoke 子进程在真实程序运行期间采集、清理前冻结的观察值。
 * 数据来源：真实行情上下文、emitter 经宿主写入的决策队列与共享终止 owner。
 * 使用范围：smoke.ts 的 observeDecision 返回值与结果组装。
 */
export type StrategyReplaceabilityObservation = {
  readonly task: StrategyReplaceabilityTask;
  readonly oppositeQueueEmpty: boolean;
  readonly hasFilledBuyOrders: boolean;
  readonly contextCount: number;
  readonly displayCount: number;
  readonly terminated: boolean;
};

/**
 * smoke 子进程成功后的结构化观察值。
 * 数据来源：子进程内真实策略调用链与全局计数，经单行 JSON 回传。
 * 使用范围：父进程断言未选策略零执行、队列字段、对侧队列为空、无 fatal 与精确调用次数。
 */
export type StrategyReplaceabilitySmokeResult = {
  readonly id: string;
  readonly pid: number;
  readonly definitionPath: string;
  readonly importedPaths: ReadonlyArray<string>;
  readonly calls: Readonly<Record<string, number>>;
  readonly nowMs: number;
  readonly task: StrategyReplaceabilityTask;
  readonly oppositeQueueEmpty: boolean;
  readonly contextCount: number;
  readonly displayCount: number;
  readonly hasFilledBuyOrders: boolean;
  readonly terminated: boolean;
};
