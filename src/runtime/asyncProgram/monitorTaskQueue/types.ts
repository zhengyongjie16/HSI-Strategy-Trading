import type { Logger } from '../../../types/logger.js';
import type { RuntimeClock } from '../../../types/runtime.js';
import type { DiagnosticObserver } from '../../../types/diagnostics.js';
import type { TaskAddedCallback } from '../tradeTaskQueue/types.js';

/** 监控队列的显式时间、结构化诊断与既有明细日志能力。 */
export interface MonitorTaskQueueDeps {
  readonly logger: Logger;
  readonly clock: RuntimeClock;
  readonly diagnostics: DiagnosticObserver;
}

/** 有效监控任务的私有时间元数据；不写入 task/data，也不为失效占位保留计数。 */
export type QueuedMonitorTask<TDataMap extends Readonly<Record<string, unknown>>> = {
  readonly task: MonitorTask<TDataMap>;
  readonly enqueuedAtMs: number | null;
};

/**
 * 监控任务数据映射基类（内部类型）。
 * 类型用途：约束监控任务 type 到 payload 的映射表形状，作为后续泛型 helper 的边界。
 * 使用范围：仅 monitorTaskQueue 类型定义内部使用。
 */
type MonitorTaskDataMapBase = Readonly<Record<string, unknown>>;

/**
 * 由任务数据映射派生出的完整监控任务联合类型（内部类型）。
 * 类型用途：为公开的 MonitorTask 提供任务类型、去重键与数据的基础结构。
 * 使用范围：仅 monitorTaskQueue 类型定义内部使用。
 */
type MonitorTaskByDataMap<
  TDataMap extends MonitorTaskDataMapBase,
  TType extends keyof TDataMap = keyof TDataMap,
> = TType extends keyof TDataMap
  ? Readonly<{
      type: TType;
      dedupeKey: string;
      data: TDataMap[TType];
    }>
  : never;

/**
 * 由任务数据映射派生出的监控任务入队参数联合类型（内部类型）。
 * 类型用途：为公开的 MonitorTaskInput 提供基础结构，表达调用方提交的任务形态。
 * 使用范围：仅 monitorTaskQueue 类型定义内部使用。
 */
type MonitorTaskInputByDataMap<
  TDataMap extends MonitorTaskDataMapBase,
  TType extends keyof TDataMap = keyof TDataMap,
> = TType extends keyof TDataMap
  ? Readonly<{
      type: TType;
      dedupeKey: string;
      data: TDataMap[TType];
    }>
  : never;

/**
 * 监控任务（队列元素）。
 * 类型用途：监控任务队列中的单项，携带 type、dedupeKey 与 data；由 Processor 消费。
 * 数据来源：由 scheduleLatest 写入，MonitorTaskProcessor 出队消费。
 * 使用范围：仅 monitorTaskQueue、monitorTaskProcessor 与各任务 owner 内部使用。
 */
export type MonitorTask<
  TDataMap extends MonitorTaskDataMapBase,
  TType extends keyof TDataMap = keyof TDataMap,
> = MonitorTaskByDataMap<TDataMap, TType>;

/**
 * 监控任务入队参数（scheduleLatest 的入参）。
 * 类型用途：调用方提交任务时传入的类型、去重键与数据。
 * 数据来源：由 PeriodicSwitchWakeupRuntime、AutoSearchWakeupRuntime 等任务 owner 在调度监控任务时组装传入。
 * 使用范围：仅 MonitorTaskQueue.scheduleLatest 的调用方与实现使用，内部使用。
 */
export type MonitorTaskInput<
  TDataMap extends MonitorTaskDataMapBase,
  TType extends keyof TDataMap = keyof TDataMap,
> = MonitorTaskInputByDataMap<TDataMap, TType>;

/**
 * 监控任务队列行为契约。
 * 类型用途：基于去重键的最新任务调度（scheduleLatest 替换同 key 旧任务），pop/isEmpty/removeTasks/clearAll/onTaskAdded；供 MonitorTaskProcessor 消费。
 * 数据来源：主程序创建，任务 owner 调用 scheduleLatest，MonitorTaskProcessor 消费 pop。
 * 使用范围：任务 owner 与 monitorTaskProcessor 等，仅内部使用。
 */
export interface MonitorTaskQueue<TDataMap extends MonitorTaskDataMapBase> {
  /** 入队任务；队列已 close 时返回 false 且不产生任何 mutation 或通知。 */
  readonly scheduleLatest: <TType extends keyof TDataMap>(
    task: MonitorTaskInput<TDataMap, TType>,
  ) => boolean;

  /** 关闭 producer admission；关闭后不可重新打开。 */
  readonly close: () => void;

  readonly pop: () => MonitorTask<TDataMap> | null;
  readonly isEmpty: () => boolean;
  readonly removeTasks: (predicate: (task: MonitorTask<TDataMap>) => boolean) => number;
  readonly clearAll: () => number;
  readonly onTaskAdded: (callback: TaskAddedCallback) => () => void;
}
