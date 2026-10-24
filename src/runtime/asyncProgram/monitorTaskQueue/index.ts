/**
 * 监控任务队列模块
 *
 * 功能：
 * - 提供监控任务的队列管理
 * - 支持任务去重（相同 dedupeKey 的任务会被替换为最新的）
 * - 支持任务添加回调（用于触发处理器）
 *
 * 去重策略：
 * - 使用 scheduleLatest 入队时，会移除队列中 dedupeKey 相同的旧任务
 * - 确保同类型任务只保留最新的一个，避免重复处理
 *
 * 使用场景：
 * - AUTO_SYMBOL_TICK（调用方通常按 task type + direction 生成 dedupeKey）
 * - SEAT_REFRESH（调用方按 task type + direction 生成 dedupeKey，并用新 seatVersion 覆盖旧任务）
 */
import { DIAGNOSTIC_OPERATIONS } from '../../../constants/diagnostics.js';
import type { Logger } from '../../../types/logger.js';

import type { TaskAddedCallback } from '../tradeTaskQueue/types.js';
import { notifyTaskAddedCallbacks, registerTaskAddedCallback } from '../taskNotifications.js';
import type {
  MonitorTask,
  MonitorTaskInput,
  MonitorTaskQueue,
  MonitorTaskQueueDeps,
  QueuedMonitorTask,
} from './types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readStringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : 'null';
}

function readNumberField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : 'null';
}

function logSeatRefreshReplaced<TDataMap extends Readonly<Record<string, unknown>>>(
  logger: Logger,
  task: MonitorTaskInput<TDataMap>,
  removedCount: number,
): void {
  if (task.type !== 'SEAT_REFRESH' || removedCount <= 0 || !isRecord(task.data)) {
    return;
  }

  try {
    logger.debug(
      `[SEAT_REFRESH replaced] direction=${readStringField(task.data, 'direction')} seatVersion=${readNumberField(task.data, 'seatVersion')} nextSymbol=${readStringField(task.data, 'nextSymbol')} dedupeKey=${task.dedupeKey} replacedCount=${removedCount}`,
    );
  } catch {
    // 旧明细日志同样属于诊断旁路，不能阻断已接受的新任务替换。
  }
}

/**
 * 创建监控任务队列
 * 支持任务去重（scheduleLatest）和任务添加回调通知
 *
 * @returns 监控任务队列实例，含 scheduleLatest、pop、isEmpty、removeTasks、clearAll、onTaskAdded
 */
export function createMonitorTaskQueue<TDataMap extends Readonly<Record<string, unknown>>>(
  deps: MonitorTaskQueueDeps,
): MonitorTaskQueue<TDataMap> {
  const { logger, clock, diagnostics } = deps;
  let items: Array<MonitorTask<TDataMap>> = [];
  let headIndex = 0;
  let closed = false;
  const taskByDedupeKey = new Map<string, QueuedMonitorTask<TDataMap>>();
  const callbacks: TaskAddedCallback[] = [];

  /** 时间仅服务诊断；失败时保留未知，不增加另一个时钟或业务失败分支。 */
  function sampleDiagnosticTime(): number | null {
    try {
      const nowMs = clock.now().getTime();
      return Number.isFinite(nowMs) ? nowMs : null;
    } catch {
      return null;
    }
  }

  /** Map 只保留有效任务；替换先删后插，保持与有效 FIFO 相同的入队顺序。 */
  function recordState(
    mutation: 'push' | 'replace' | 'pop' | 'remove' | 'clear',
    changedTaskCount: number,
  ): void {
    try {
      const oldest = taskByDedupeKey.values().next().value;
      const nowMs = sampleDiagnosticTime();
      let oldestTaskAgeMs: number | null = 0;
      if (oldest !== undefined) {
        oldestTaskAgeMs =
          oldest.enqueuedAtMs === null || nowMs === null
            ? null
            : Math.max(0, nowMs - oldest.enqueuedAtMs);
      }

      diagnostics.record(DIAGNOSTIC_OPERATIONS.QUEUE_STATE, {
        queue: 'MONITOR',
        mutation,
        changedTaskCount,
        depth: taskByDedupeKey.size,
        oldestTaskAgeMs,
      });
    } catch {
      // 诊断不能影响有效任务替换、出队或消费者通知。
    }
  }

  /**
   * 按已出队游标压缩底层数组，避免长期保留已消费任务。
   */
  function compactQueue(): void {
    if (headIndex === 0) {
      return;
    }

    if (headIndex < 64 && headIndex * 2 < items.length) {
      return;
    }

    items = items.slice(headIndex);
    headIndex = 0;
  }

  /**
   * 判断任务是否仍是对应 dedupeKey 的当前有效任务。
   *
   * @param task 待判断的监控任务
   * @returns 任务仍有效时返回 true
   */
  function isEffectiveTask(task: MonitorTask<TDataMap>): boolean {
    return taskByDedupeKey.get(task.dedupeKey)?.task === task;
  }

  /**
   * 主动移除任务后重建待消费切片，只保留仍有效的任务。
   *
   * removeTasks 已经扫描当前待消费范围；重建后不再保留已取消占位任务。
   */
  function rebuildEffectiveQueue(): void {
    const effectiveTasks: Array<MonitorTask<TDataMap>> = [];

    for (let index = headIndex; index < items.length; index += 1) {
      const task = items[index];
      if (task !== undefined && isEffectiveTask(task)) {
        effectiveTasks.push(task);
      }
    }

    items = effectiveTasks;
    headIndex = 0;
  }

  function scheduleLatest<TType extends keyof TDataMap>(
    task: MonitorTaskInput<TDataMap, TType>,
  ): boolean {
    if (closed) {
      return false;
    }

    const previousTask = taskByDedupeKey.get(task.dedupeKey);
    const removedCount = previousTask === undefined ? 0 : 1;
    if (previousTask !== undefined) {
      taskByDedupeKey.delete(task.dedupeKey);
    }

    logSeatRefreshReplaced(logger, task, removedCount);

    const fullTask = {
      type: task.type,
      dedupeKey: task.dedupeKey,
      data: task.data,
    } as MonitorTask<TDataMap, TType>;

    taskByDedupeKey.set(task.dedupeKey, {
      task: fullTask,
      enqueuedAtMs: sampleDiagnosticTime(),
    });
    items.push(fullTask);
    recordState(previousTask === undefined ? 'push' : 'replace', 1);
    notifyTaskAddedCallbacks(callbacks);
    return true;
  }

  function pop(): MonitorTask<TDataMap> | null {
    while (headIndex < items.length) {
      const task = items[headIndex];
      headIndex += 1;

      if (task === undefined || !isEffectiveTask(task)) {
        continue;
      }

      taskByDedupeKey.delete(task.dedupeKey);
      compactQueue();
      recordState('pop', 1);
      return task;
    }

    items = [];
    headIndex = 0;
    recordState('pop', 0);
    return null;
  }

  function isEmpty(): boolean {
    return taskByDedupeKey.size === 0;
  }

  function removeTasks(predicate: (task: MonitorTask<TDataMap>) => boolean): number {
    const removedTasks: Array<MonitorTask<TDataMap>> = [];

    for (let index = headIndex; index < items.length; index += 1) {
      const task = items[index];
      if (task === undefined || !isEffectiveTask(task) || !predicate(task)) {
        continue;
      }

      removedTasks.push(task);
      taskByDedupeKey.delete(task.dedupeKey);
    }

    if (removedTasks.length > 0) {
      rebuildEffectiveQueue();
    } else {
      compactQueue();
    }

    recordState('remove', removedTasks.length);
    return removedTasks.length;
  }

  function clearAll(): number {
    const activeTasks: Array<MonitorTask<TDataMap>> = [];
    for (let index = headIndex; index < items.length; index += 1) {
      const task = items[index];
      if (task !== undefined && isEffectiveTask(task)) {
        activeTasks.push(task);
      }
    }

    items = [];
    headIndex = 0;
    taskByDedupeKey.clear();
    recordState('clear', activeTasks.length);
    return activeTasks.length;
  }

  function onTaskAdded(callback: TaskAddedCallback): () => void {
    if (closed) {
      return () => {
        // 终态不注册监听，因此注销无需修改队列。
      };
    }

    return registerTaskAddedCallback(callbacks, callback);
  }

  return {
    close: () => {
      closed = true;
      callbacks.length = 0;
    },
    scheduleLatest,
    pop,
    isEmpty,
    removeTasks,
    clearAll,
    onTaskAdded,
  };
}
