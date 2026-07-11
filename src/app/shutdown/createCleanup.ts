/**
 * app 退出清理装配模块
 *
 * 职责：
 * - 创建程序退出时的资源清理函数
 * - 确保程序退出时正确释放所有资源
 */
import { logger } from '../../utils/logger/index.js';
import { formatError } from '../../utils/error/index.js';
import { CLEANUP_PHASE_ORDER } from '../../constants/cleanup.js';
import type {
  CleanupController,
  CleanupFailure,
  CleanupStep,
  RegisteredCleanupStep,
} from '../types.js';

/**
 * 创建可增量登记清理步骤、并按阶段单次执行的程序退出清理控制器。
 *
 * @returns 提供 register 与 execute 的增量清理控制器
 */
export function createCleanup(): CleanupController {
  const registeredSteps: RegisteredCleanupStep[] = [];
  let nextSequence = 0;
  let executionStarted = false;
  let executePromise: Promise<void> | null = null;

  const register = (step: CleanupStep): void => {
    if (executionStarted) {
      throw new Error('[Cleanup] cleanup 已开始执行，禁止继续登记资源');
    }

    registeredSteps.push({ ...step, sequence: nextSequence });
    nextSequence += 1;
  };

  /**
   * 执行清理：先关闭交易门禁并中断 freshness 等待，再停止上游事件 owner、排空提交链路处理器，最后停止订单监控与订阅 owner，随后销毁验证器、清空缓存并重置行情订阅。
   */
  async function executeRegisteredSteps(): Promise<void> {
    logger.info('Program exiting, cleaning up resources...');
    const failures: CleanupFailure[] = [];
    const orderedSteps = [...registeredSteps].sort((left, right) => {
      const phaseDifference = CLEANUP_PHASE_ORDER[left.phase] - CLEANUP_PHASE_ORDER[right.phase];
      return phaseDifference === 0 ? left.sequence - right.sequence : phaseDifference;
    });

    for (const cleanupStep of orderedSteps) {
      try {
        await cleanupStep.handler();
      } catch (err) {
        failures.push({ step: cleanupStep.step, error: err });
        logger.error(`[Cleanup] ${cleanupStep.step} 失败: ${formatError(err)}`);
      }
    }

    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((item) => item.error),
        `[Cleanup] 资源清理失败，共 ${failures.length} 处`,
      );
    }
  }

  /**
   * 启动一次清理并复用已发布的执行 Promise；同步启动窗口内的 handler 重入必须立即失败，避免重复执行清理步骤。
   */
  const execute = (): Promise<void> => {
    if (executePromise !== null) {
      return executePromise;
    }

    if (executionStarted) {
      throw new Error('[Cleanup] cleanup 正在同步启动，禁止从清理 handler 重入 execute');
    }

    executionStarted = true;
    executePromise = executeRegisteredSteps();
    return executePromise;
  };

  return {
    register,
    execute,
  };
}
