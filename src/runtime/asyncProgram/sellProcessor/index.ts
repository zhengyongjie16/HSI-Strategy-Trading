/**
 * 普通 SELL FIFO worker。
 * 只消费用例、调度 application 签发的报价重试及 stop/drain；不等待/判定业务 freshness 或计算卖量。
 */
import { createBaseProcessor } from '../processor.js';
import type { Processor } from '../types.js';
import type { ExecutableSellSignal } from '../../../types/signal.js';
import type { Task, SellTaskType } from '../tradeTaskQueue/types.js';
import type { SellProcessorDeps, ScheduledSellRetry } from './types.js';

/** 路由同一需求的报价重试；不同业务动作、席位或关联买单不能共享 timer。 */
function retryKey(signal: ExecutableSellSignal): string {
  return [
    signal.action,
    signal.symbol,
    signal.seatVersion,
    signal.quantity ?? '',
    signal.orderTypeOverride ?? '',
    signal.isProtectiveLiquidation ?? '',
    signal.reason ?? '',
    signal.relatedBuyOrderIds?.join(',') ?? '',
    signal.triggerTime?.getTime() ?? -1,
  ].join('|');
}

/** 独立 FIFO 队列；用例失效返回由 application 决定，runtime 只取消资源和旧代次调度。 */
export function createSellProcessor(deps: SellProcessorDeps): Processor {
  const { taskQueue, workflow, scheduler, termination } = deps;
  const scheduled = new Map<string, ScheduledSellRetry>();
  let active = true;
  let runVersion = 0;

  function clearRetry(key: string): void {
    const pending = scheduled.get(key);
    if (pending?.handle !== null && pending?.handle !== undefined)
      scheduler.clearTimer(pending.handle);

    // timer 已回流 FIFO 时，同步移除这个克隆信号的队列项，不能在 restart 后丢失原重试身份。
    if (pending?.queued === true)
      taskQueue.removeTasks((task) => task.data === pending.retry.signal);

    scheduled.delete(key);
  }

  function stopRetries(): void {
    active = false;
    runVersion += 1;
    for (const key of scheduled.keys()) clearRetry(key);
  }

  /** 串行调用 owner；报价 timer 回流尾部排队，不在 worker 内重试业务。 */
  async function processTask(task: Task<SellTaskType>): Promise<void> {
    const key = retryKey(task.data);
    const pending = scheduled.get(key);
    const version = runVersion;
    const isActive = (): boolean => active && runVersion === version;
    const result = await workflow.execute(task.data, {
      isActive,
      retry: pending?.queued === true && pending.retry.signal === task.data ? pending.retry : null,
    });
    if (!isActive()) return;

    if (result.status === 'COMPLETED') {
      clearRetry(key);
      return;
    }

    if (pending !== undefined && !pending.queued) return;

    clearRetry(key);
    const next: ScheduledSellRetry = { handle: null, queued: false, retry: result.retry };
    next.handle = scheduler.scheduleTimer(() => {
      try {
        if (!isActive() || scheduled.get(key) !== next) return;

        next.handle = null;
        if (!next.retry.isCurrent()) {
          clearRetry(key);
          return;
        }

        next.queued = true;
        const admitted = taskQueue.push({ type: task.type, data: next.retry.signal });
        if (!admitted && !termination.isTerminated()) {
          throw new Error('[SellProcessor] 非终态队列拒绝重试任务');
        }
      } catch (error) {
        termination.reportFatalError(error);
      }
    }, result.retry.delayMs);
    scheduled.set(key, next);
  }

  const base = createBaseProcessor({
    loggerPrefix: 'SellProcessor',
    taskQueue,
    processTask,
    getCanProcessTask: deps.getCanProcessTask,
    termination,
  });
  return {
    start: () => {
      if (termination.isTerminated()) return;

      active = true;
      base.start();
    },
    stop: () => {
      stopRetries();
      base.stop();
    },
    stopAndDrain: async () => {
      stopRetries();
      await base.stopAndDrain();
    },
    restart: () => {
      stopRetries();
      if (termination.isTerminated()) return;

      active = true;
      base.restart();
    },
  };
}
