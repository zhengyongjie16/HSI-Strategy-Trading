/**
 * 监控任务 worker。
 * 仅持有串行队列、application 发出的重试 timer 与 stop/drain；激活完成、次数和 EMPTY 决定属于 application。
 */
import { createQueueRunner } from './queueRunner.js';
import { formatError } from '../../../utils/error/index.js';
import type { SeatActivationResult } from '../../../application/seatActivation/types.js';
import type { MonitorTask } from '../monitorTaskQueue/types.js';
import type {
  MonitorTaskDataMap,
  MonitorTaskProcessor,
  MonitorTaskProcessorDeps,
} from './types.js';

/** 创建监控任务串行 worker，原样消费 application 的 retry 指令，不重新分类业务失败。 */
export function createMonitorTaskProcessor(deps: MonitorTaskProcessorDeps): MonitorTaskProcessor {
  const { monitorTaskQueue, scheduler, termination, seatActivation, logger } = deps;
  let running = false;
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const canRun = (): boolean => running && !termination.isTerminated();
  const canProcessTask = (): boolean => canRun() && (deps.getCanProcessTask?.() ?? true);

  function clearRetryTimer(dedupeKey: string): void {
    const timer = retryTimers.get(dedupeKey);
    if (timer === undefined) return;

    retryTimers.delete(dedupeKey);
    scheduler.clearTimer(timer);
  }

  /** 将应用层已授权的单次重试指令转成 timer；触发前重新向 owner 校验身份。 */
  function scheduleRetry(
    task: MonitorTask<MonitorTaskDataMap, 'SEAT_REFRESH'>,
    result: Extract<SeatActivationResult, { readonly status: 'retry' }>,
  ): void {
    if (!canProcessTask() || !seatActivation.isCurrent(result.request)) return;

    clearRetryTimer(task.dedupeKey);
    const handle = scheduler.scheduleTimer(() => {
      try {
        if (retryTimers.get(task.dedupeKey) !== handle) return;

        retryTimers.delete(task.dedupeKey);
        if (!canProcessTask() || !seatActivation.isCurrent(result.request)) return;

        const admitted = monitorTaskQueue.scheduleLatest({
          type: 'SEAT_REFRESH',
          dedupeKey: task.dedupeKey,
          data: result.request,
        });
        if (!admitted && !termination.isTerminated()) {
          termination.reportFatalError(new Error('[MonitorTaskProcessor] 非终态队列拒绝激活重试'));
        }
      } catch (error) {
        termination.reportFatalError(error);
      }
    }, result.delayMs);
    retryTimers.set(task.dedupeKey, handle);
  }

  function clearRetryTimers(): void {
    for (const key of retryTimers.keys()) clearRetryTimer(key);
  }

  /** 按 FIFO 消费当前有效任务，失效/门禁策略由原业务 owner 判断。 */
  async function processQueue(): Promise<void> {
    while (canRun() && !monitorTaskQueue.isEmpty()) {
      const task = monitorTaskQueue.pop();
      if (task === null) break;

      switch (task.type) {
        case 'AUTO_SYMBOL_TICK': {
          const status = canProcessTask()
            ? await deps.handlePeriodicSwitchTask(task, canRun)
            : 'skipped';
          if (canRun()) deps.onPeriodicSwitchTaskResult(task, status, canRun);

          break;
        }

        case 'SEAT_REFRESH': {
          // 最新任务接棒时取消同 key timer，防止旧 retry 覆盖新任务。
          clearRetryTimer(task.dedupeKey);
          if (!canProcessTask()) break;

          const result = await seatActivation.activate(task.data, canProcessTask);
          if (!canRun()) return;

          if (result.status === 'retry') scheduleRetry(task, result);

          break;
        }

        default: {
          const unhandled: never = task;
          throw new Error(`[MonitorTaskProcessor] 存在未处理的任务分派分支: ${String(unhandled)}`);
        }
      }
    }
  }

  const queueRunner = createQueueRunner({
    monitorTaskQueue,
    termination,
    processQueue,
    onQueueError: (error) => {
      termination.reportFatalError(error);
      logger.error('[MonitorTaskProcessor] 处理队列时发生错误', formatError(error));
    },
    onAlreadyRunning: () => {
      logger.warn('[MonitorTaskProcessor] 处理器已在运行中');
    },
  });

  return {
    start: () => {
      if (termination.isTerminated()) return;

      running = true;
      queueRunner.start();
    },
    stop: () => {
      running = false;
      clearRetryTimers();
      queueRunner.stop();
    },
    stopAndDrain: async () => {
      running = false;
      clearRetryTimers();
      await queueRunner.stopAndDrain();
      clearRetryTimers();
    },
    restart: () => {
      clearRetryTimers();
      if (termination.isTerminated()) return;

      running = true;
      queueRunner.restart();
    },
  };
}
