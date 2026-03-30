/**
 * 自动换标队列清理模块
 *
 * 职责：
 * - 清理指定监控标的方向下的买卖/监控任务
 * - 统一输出队列清理统计日志
 */
import { getQueueClearTotalRemoved } from '../../utils/utils.js';
import { clearMonitorDirectionQueues } from './utils.js';
import type { ClearQueuesForDirectionWithLogParams } from './types.js';

/**
 * 清理指定监控标的方向下的所有待执行任务并按需输出统计日志。
 * 默认行为：baseInstrumentSymbol 与 monitorContext 不一致时直接返回；仅当存在移除任务时写 debug 日志。
 *
 * @param params 清理参数，包含 baseInstrumentSymbol、direction、队列实例、释放回调与 logger
 * @returns 无返回值
 */
export function clearMonitorDirectionQueuesWithLog(
  params: ClearQueuesForDirectionWithLogParams,
): void {
  const {
    direction,
    monitorContext,
    buyTaskQueue,
    sellTaskQueue,
    monitorTaskQueue,
    releaseSignal,
    logger,
  } = params;
  const baseInstrumentSymbol = monitorContext.config.baseInstrumentSymbol;

  const result = clearMonitorDirectionQueues({
    direction,
    buyTaskQueue,
    sellTaskQueue,
    monitorTaskQueue,
    releaseSignal,
  });

  const totalRemoved = getQueueClearTotalRemoved(result);
  if (totalRemoved > 0) {
    logger.debug(
      `[自动换标] ${baseInstrumentSymbol} ${direction} 清理待执行信号：延迟=${result.removedDelayed} 买入=${result.removedBuy} 卖出=${result.removedSell} 监控任务=${result.removedMonitorTasks}`,
    );
  }
}
