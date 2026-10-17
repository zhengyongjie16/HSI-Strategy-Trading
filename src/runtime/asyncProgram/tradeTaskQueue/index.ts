/**
 * TradeTaskQueue 模块
 *
 * 提供买入/卖出任务队列的创建和管理。
 * 任务队列采用 FIFO（先进先出）策略，支持：
 * - 任务入队（时间元数据仅由队列私有持有，不改写 signal）
 * - 任务出队、查看队首
 * - 按条件移除任务
 * - 任务添加回调（用于触发处理器）
 */
import { DIAGNOSTIC_OPERATIONS } from '../../../constants/diagnostics.js';
import { notifyTaskAddedCallbacks, registerTaskAddedCallback } from '../taskNotifications.js';
import type {
  Task,
  TaskInput,
  TaskQueue,
  TaskAddedCallback,
  BuyTaskType,
  SellTaskType,
  TaskQueueDeps,
  QueuedTradeTask,
} from './types.js';

/**
 * 创建通用任务队列
 *
 * 内部使用数组实现 FIFO 队列，支持回调通知机制。
 *
 * @template TType 具体任务类型
 * @returns TaskQueue<TType> 任务队列实例
 */
function createTaskQueue<TType extends string>(
  deps: TaskQueueDeps,
  queue: 'BUY' | 'SELL',
): TaskQueue<TType> {
  let items: QueuedTradeTask<TType>[] = [];
  let headIndex = 0;
  let closed = false;
  const callbacks: TaskAddedCallback[] = [];

  /** 时间仅用于诊断；采样失败保留未知，不切换其他时钟或影响任务 admission。 */
  function sampleDiagnosticTime(): number | null {
    try {
      const nowMs = deps.clock.now().getTime();
      return Number.isFinite(nowMs) ? nowMs : null;
    } catch {
      return null;
    }
  }

  /** mutation 完成后、消费者回调前采集真实待消费深度，避免同步 pop 混淆 push 事实。 */
  function recordState(
    mutation: 'push' | 'pop' | 'remove' | 'clear',
    changedTaskCount: number,
  ): void {
    try {
      const oldest = items[headIndex];
      const nowMs = sampleDiagnosticTime();
      let oldestTaskAgeMs: number | null = 0;
      if (oldest !== undefined) {
        oldestTaskAgeMs =
          oldest.enqueuedAtMs === null || nowMs === null
            ? null
            : Math.max(0, nowMs - oldest.enqueuedAtMs);
      }

      deps.diagnostics.record(DIAGNOSTIC_OPERATIONS.QUEUE_STATE, {
        queue,
        mutation,
        changedTaskCount,
        depth: items.length - headIndex,
        oldestTaskAgeMs,
      });
    } catch {
      // observer 失败不能中断队列 mutation、返回任务或消费者通知。
    }
  }

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

  return {
    push(task: TaskInput<TType>): boolean {
      if (closed) {
        return false;
      }

      const fullTask: Task<TType> = {
        type: task.type,
        data: task.data,
      };
      items.push({ task: fullTask, enqueuedAtMs: sampleDiagnosticTime() });
      recordState('push', 1);
      notifyTaskAddedCallbacks(callbacks);
      return true;
    },

    close(): void {
      closed = true;
      callbacks.length = 0;
    },

    pop(): Task<TType> | null {
      if (headIndex >= items.length) {
        items = [];
        headIndex = 0;
        recordState('pop', 0);
        return null;
      }

      const task = items[headIndex]?.task ?? null;
      headIndex += 1;
      compactQueue();
      recordState('pop', task === null ? 0 : 1);
      return task;
    },

    isEmpty(): boolean {
      return headIndex >= items.length;
    },

    removeTasks(predicate: (task: Task<TType>) => boolean): number {
      const nextItems: QueuedTradeTask<TType>[] = [];
      let removedCount = 0;

      for (let index = headIndex; index < items.length; index += 1) {
        const task = items[index];
        if (task === undefined) {
          continue;
        }

        if (predicate(task.task)) {
          removedCount += 1;
          continue;
        }

        nextItems.push(task);
      }

      items = nextItems;
      headIndex = 0;
      recordState('remove', removedCount);
      return removedCount;
    },

    clearAll(): number {
      const activeItems = items.slice(headIndex);
      items = [];
      headIndex = 0;
      recordState('clear', activeItems.length);
      return activeItems.length;
    },

    onTaskAdded(callback: TaskAddedCallback): () => void {
      if (closed) {
        return () => {
          // 终态不注册监听，因此注销无需修改队列。
        };
      }

      return registerTaskAddedCallback(callbacks, callback);
    },
  };
}

/**
 * 创建买入任务队列
 *
 * @returns 买入任务队列实例（FIFO，支持 onTaskAdded 回调）
 */
export function createBuyTaskQueue(deps: TaskQueueDeps): TaskQueue<BuyTaskType> {
  return createTaskQueue<BuyTaskType>(deps, 'BUY');
}

/**
 * 创建卖出任务队列
 *
 * @returns 卖出任务队列实例（FIFO，支持 onTaskAdded 回调）
 */
export function createSellTaskQueue(deps: TaskQueueDeps): TaskQueue<SellTaskType> {
  return createTaskQueue<SellTaskType>(deps, 'SELL');
}
