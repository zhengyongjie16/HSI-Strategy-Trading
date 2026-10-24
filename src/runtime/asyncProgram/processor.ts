/** FIFO 队列 worker：仅消费、调度、stop/drain 与 fatal 路由，不判定买卖业务结果。 */
import { DIAGNOSTIC_OPERATIONS } from '../../constants/diagnostics.js';
import { formatError } from '../../utils/error/index.js';
import type { BaseProcessorConfig, Processor } from './types.js';

/**
 * 创建基础任务处理器。
 * 封装 processQueue、scheduleNextProcess、start、stop、stopAndDrain、restart 的公共逻辑，
 * 供买入处理器和卖出处理器复用；先校验任务内部不变量，门禁关闭时仅跳过后续业务逻辑。
 *
 * @param config 处理器配置（队列、任务处理函数、生命周期门禁与 fatal 上报入口）
 * @returns 实现 Processor 接口的处理器实例（start、stop、stopAndDrain、restart）
 */
export function createBaseProcessor<TType extends string>(
  config: BaseProcessorConfig<TType>,
): Processor {
  const { logger } = config;
  const { loggerPrefix, taskQueue, processTask, getCanProcessTask, termination } = config;
  let running = false;
  let immediateHandle: ReturnType<typeof setImmediate> | null = null;
  let inFlightPromise: Promise<void> | null = null;
  let taskAddedUnregister: (() => void) | null = null;

  /**
   * 立即停止后续队列调度并注销入队监听。
   * fatal 错误上报前先关闭 owner，避免全局清理尚未开始时继续消费剩余任务。
   * @returns 无返回值
   */
  function stopScheduling(): void {
    running = false;
    taskAddedUnregister?.();
    taskAddedUnregister = null;
    if (immediateHandle !== null) {
      clearImmediate(immediateHandle);
      immediateHandle = null;
    }
  }

  /**
   * 循环消费队列中的任务，直到队列为空或处理器停止。
   * 先执行轻量任务不变量校验；门禁关闭时仅跳过后续业务逻辑。
   * @returns 无返回值
   */
  async function processQueue(): Promise<void> {
    while (running && !termination.isTerminated() && !taskQueue.isEmpty()) {
      const task = taskQueue.pop();
      if (!task) break;

      const canProcess = getCanProcessTask ? getCanProcessTask() : true;
      if (!canProcess) {
        try {
          const { symbol, action, seatVersion, triggerTime } = task.data;
          const triggerTimeMs = triggerTime?.getTime();
          config.diagnostics.record(DIAGNOSTIC_OPERATIONS.SIGNAL_PROCESSING_OUTCOME, {
            stage: 'PROCESSOR',
            outcome: 'SKIPPED',
            reasonCode: 'PROCESSOR_GATE_CLOSED',
            symbol,
            action,
            ...(seatVersion === null || seatVersion === undefined ? {} : { seatVersion }),
            ...(triggerTimeMs !== undefined && Number.isFinite(triggerTimeMs)
              ? { triggerTimeMs }
              : {}),
          });
        } catch {
          // 已 pop 的门禁拒绝不受诊断字段或 observer 失败影响。
        }

        continue;
      }

      await processTask(task);
    }
  }

  /**
   * 通过 setImmediate 调度下一次队列处理，避免阻塞事件循环
   * 队列为空时不调度，等待 onTaskAdded 回调触发
   * @returns 无返回值
   */
  function scheduleNextProcess(): void {
    if (!running || termination.isTerminated()) return;

    if (inFlightPromise !== null || immediateHandle !== null) return;

    if (taskQueue.isEmpty()) {
      immediateHandle = null;
      return;
    }

    immediateHandle = setImmediate(() => {
      immediateHandle = null;
      if (!running || termination.isTerminated()) return;

      if (taskQueue.isEmpty()) {
        immediateHandle = null;
      } else {
        inFlightPromise = processQueue()
          .catch((error: unknown) => {
            stopScheduling();
            termination.reportFatalError(error);
            logger.error(`[${loggerPrefix}] 处理队列时发生错误`, formatError(error));
          })
          .finally(() => {
            inFlightPromise = null;
            scheduleNextProcess();
          });
      }
    });
  }

  /**
   * 启动处理器，注册任务入队回调并立即调度一次队列处理
   * @returns 无返回值
   */
  function start(): void {
    if (termination.isTerminated()) return;

    if (running) {
      logger.warn(`[${loggerPrefix}] 处理器已在运行中`);
      return;
    }

    running = true;
    taskAddedUnregister = taskQueue.onTaskAdded(scheduleNextProcess);
    scheduleNextProcess();
  }

  /**
   * 停止处理器，注销任务入队回调并取消待执行的 setImmediate
   * 不等待在途任务完成，如需等待请使用 stopAndDrain
   * @returns 无返回值
   */
  function stop(): void {
    if (!running) {
      logger.warn(`[${loggerPrefix}] 处理器未在运行`);
      return;
    }

    stopScheduling();
  }

  /**
   * 停止处理器并等待当前在途任务完成，确保优雅退出
   * @returns 无返回值
   */
  async function stopAndDrain(): Promise<void> {
    stopScheduling();

    if (inFlightPromise !== null) {
      await inFlightPromise;
    }
  }

  /**
   * 重启处理器：先 stop 再 start，用于跨日重置等生命周期场景
   * @returns 无返回值
   */
  function restart(): void {
    if (running) {
      stop();
    }

    start();
  }
  return {
    start,
    stop,
    stopAndDrain,
    restart,
  };
}
