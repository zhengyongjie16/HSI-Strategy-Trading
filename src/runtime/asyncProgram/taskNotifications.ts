/**
 * 任务入队通知。
 * 队列共享同步 listener 注册与注销；不参与任务业务判断或失败策略。
 */
import type { TaskAddedCallback } from './tradeTaskQueue/types.js';

/** 同步通知已注册的队列 listener，保留 listener 异常向调用方传播的语义。 */
export function notifyTaskAddedCallbacks(callbacks: ReadonlyArray<TaskAddedCallback>): void {
  for (const callback of callbacks) callback();
}

/** 注册入队 listener，返回幂等注销函数。 */
export function registerTaskAddedCallback(
  callbacks: TaskAddedCallback[],
  callback: TaskAddedCallback,
): () => void {
  callbacks.push(callback);
  return () => {
    const index = callbacks.indexOf(callback);
    if (index !== -1) callbacks.splice(index, 1);
  };
}
