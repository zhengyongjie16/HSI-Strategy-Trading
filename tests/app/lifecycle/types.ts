import type { CacheDomain } from '../../../src/runtime/lifecycle/types.js';
import type { CleanupPhase } from '../../../src/types/cleanup.js';
import type { LifecycleMutableState } from '../../../src/types/lifecycle.js';

/**
 * 静态检查的五条具名路径；不代表可执行能力或统一 runtime 接口。
 * 类型用途：约束测试侧清单声明的分组键。
 * 数据来源：与生产 lifecycle 资源的真实具名接线一一对应。
 * 使用范围：仅 app/lifecycle 清单测试及其 oracle 使用。
 */
export type LifecycleChecklistGroup =
  | 'startAfterRebuild'
  | 'stopAdmissionAndStopNow'
  | 'midnightStopAndDrain'
  | 'openRebuildStart'
  | 'finalDrainAndDispose';

/**
 * 一个真实资源的覆盖声明。操作名来自现有具名接线，缺少的动作直接省略，绝不补空实现。
 * 类型用途：表达单个资源在各具名路径上的动作与安全偏序声明。
 * 数据来源：由测试侧 oracle 按生产 factory 的实际接线维护。
 * 使用范围：仅 app/lifecycle 清单测试及其 oracle 使用。
 */
export type LifecycleChecklistResource = {
  readonly resource: string;
  readonly createdBy: string;
  readonly runsWhileTradingClosed: boolean;

  /** 无独立 disposer 时必须说明实际释放/持有策略，不能补造 stop/drain。 */
  readonly retainedBy?: string;
  readonly startAfterRebuild?: ReadonlyArray<string>;
  readonly stopAdmissionAndStopNow?: ReadonlyArray<string>;
  readonly midnightStopAndDrain?: ReadonlyArray<string>;
  readonly openRebuildStart?: ReadonlyArray<string>;

  /**
   * 同一资源可拥有多个真实 cleanup phase；空数组表示无独立 disposer。
   */
  readonly finalDrainAndDispose: ReadonlyArray<
    readonly [cleanupPhase: CleanupPhase, operation: string]
  >;
};

/**
 * 一条现有路径必须保持的先后依赖。
 * 类型用途：仅供清单校验比较 trace，不产生拓扑或执行计划。
 * 数据来源：由测试侧 oracle 按生产接线顺序维护。
 * 使用范围：仅 app/lifecycle 清单测试及其 oracle 使用。
 */
export type LifecycleChecklistOrder = {
  readonly group: Exclude<LifecycleChecklistGroup, 'finalDrainAndDispose'>;
  readonly operations: ReadonlyArray<string>;
};

/**
 * 测试侧独立资源清单。
 * 类型用途：每个资源一个声明点，只维护安全相关的偏序，不复制完整执行源码。
 * 数据来源：由 tests/app/lifecycle/lifecycleChecklist.ts 维护。
 * 使用范围：仅 app/lifecycle 清单测试及其 oracle 使用。
 */
export type LifecycleChecklist = {
  readonly resources: ReadonlyArray<LifecycleChecklistResource>;
  readonly order: ReadonlyArray<LifecycleChecklistOrder>;
};

/**
 * 由真实 factory 登记或真实调用 trace 提供的观察值。
 * 类型用途：承载真实 cleanup 登记与具名路径 trace，不接收 handler。
 * 数据来源：由 app lifecycle 测试从真实 factory 与日切域观察取得。
 * 使用范围：仅 app/lifecycle 清单测试使用。
 */
export type LifecycleChecklistObservation = {
  readonly traces?: Partial<Readonly<Record<LifecycleChecklistGroup, ReadonlyArray<string>>>>;
  readonly cleanupRegistrations?: ReadonlyArray<{
    readonly createdBy: string;
    readonly cleanupPhase: CleanupPhase;

    /** 实际 handler 的资源名.操作名；不能只记录同名方法而丢失 owner。 */
    readonly operation: string;
  }>;
};

/**
 * createLifecycleRuntime 接线测试中的开盘重建委托记录。
 * 类型用途：记录 executeTradingDayOpenRebuild 替身收到的入参，便于断言统一入口接线。
 * 数据来源：由 tests/app/lifecycle/createLifecycleRuntime.wiring.test.ts 中的替身函数收集。
 * 使用范围：仅 app/lifecycle 测试使用。
 */
export type ExecuteOpenRebuildCall = Readonly<{
  now: Date;
  loadTradingDayRuntimeSnapshot: unknown;
  rebuildTradingDayState: unknown;
}>;

/**
 * createLifecycleRuntime 接线测试中的 dayLifecycleManager 创建记录。
 * 类型用途：记录 createDayLifecycleManager 替身收到的可变状态与 cache domains。
 * 数据来源：由 tests/app/lifecycle/createLifecycleRuntime.wiring.test.ts 中的替身函数收集。
 * 使用范围：仅 app/lifecycle 测试使用。
 */
export type CreateDayLifecycleManagerCall = Readonly<{
  mutableState: LifecycleMutableState;
  cacheDomains: ReadonlyArray<CacheDomain>;
}>;
