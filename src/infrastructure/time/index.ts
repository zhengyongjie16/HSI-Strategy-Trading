/**
 * 系统时间基础设施适配
 *
 * 职责：为 app 装配提供真实系统时钟与原生 one-shot timer；不持有唤醒计划或业务重试状态。
 */
import type { RuntimeClock, RuntimeScheduler } from '../../types/runtime.js';

/** 真实系统时钟；调用时读取当前时间，不缓存业务时间。 */
export const SYSTEM_RUNTIME_CLOCK: RuntimeClock = {
  now: () => new Date(),
};

/** 原生 timer 适配；原样返回并取消 setTimeout 的句柄。 */
export const SYSTEM_RUNTIME_SCHEDULER: RuntimeScheduler = {
  scheduleTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (handle) => {
    clearTimeout(handle);
  },
};

/** 真实单调时钟，用于 Trade API 限流，不能以墙钟时间替代。 */
export function nowMonotonicMs(): number {
  return performance.now();
}

/** 等待原毫秒时长；不改变任何业务重试判断。 */
export function wait(delayMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
}
