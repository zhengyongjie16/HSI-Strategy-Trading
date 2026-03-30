/**
 * app 退出清理装配模块
 *
 * 职责：
 * - 创建程序退出时的资源清理函数
 * - 注册 SIGINT 和 SIGTERM 信号处理器
 * - 确保程序退出时正确释放所有资源
 */
import { logger } from '../utils/logger/index.js';
import { formatError } from '../utils/error/index.js';
import type { StrategyState } from '../types/state.js';
import type { CleanupContext, CleanupController, CleanupFailure } from './types.js';

/**
 * 释放单实例运行态的最后一个快照对象，并将最后快照指针清空，避免退出后残留对象池引用。
 *
 * @param monitorState 单实例策略状态
 * @returns void
 */
function releaseAllMonitorSnapshots(monitorState: StrategyState): void {
  monitorState.lastMonitorSnapshot = null;
}

/**
 * 创建程序退出时的清理函数，负责按顺序停止处理器、释放快照并注册 SIGINT/SIGTERM。
 *
 * @param context 清理上下文，包含需要停止与释放的处理器、行情客户端与运行态状态
 * @returns 包含 execute（执行清理）与 registerExitHandlers（注册退出信号）的对象
 */
export function createCleanup(context: CleanupContext): CleanupController {
  const {
    buyProcessor,
    sellProcessor,
    monitorTaskProcessor,
    orderMonitorWorker,
    postTradeRefresher,
    marketDataClient,
    lastState,
  } = context;
  let isExiting = false;

  /**
   * 执行清理：按顺序停止各处理器（stopAndDrain 确保 in-flight 任务排空）、释放快照并重置行情订阅。
   */
  async function execute(): Promise<void> {
    logger.info('Program exiting, cleaning up resources...');
    const failures: CleanupFailure[] = [];

    const runStep = async (step: string, handler: () => Promise<void> | void): Promise<void> => {
      try {
        await handler();
      } catch (err) {
        failures.push({ step, error: err });
        logger.error(`[Cleanup] ${step} 失败: ${formatError(err)}`);
      }
    };

    await runStep('停止 BuyProcessor', async () => {
      await buyProcessor.stopAndDrain();
    });

    await runStep('停止 SellProcessor', async () => {
      await sellProcessor.stopAndDrain();
    });

    await runStep('停止 MonitorTaskProcessor', async () => {
      await monitorTaskProcessor.stopAndDrain();
    });

    await runStep('停止 OrderMonitorWorker', async () => {
      await orderMonitorWorker.stopAndDrain();
    });

    await runStep('停止 PostTradeRefresher', async () => {
      await postTradeRefresher.stopAndDrain();
    });

    await runStep('释放监控快照对象', () => {
      releaseAllMonitorSnapshots(lastState.monitorState);
    });

    await runStep('重置行情运行态订阅与缓存', async () => {
      await marketDataClient.resetRuntimeSubscriptionsAndCaches();
    });

    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((item) => item.error),
        `[Cleanup] 资源清理失败，共 ${failures.length} 处`,
      );
    }
  }

  /**
   * 注册 SIGINT/SIGTERM 信号处理，确保进程收到退出信号时执行清理并退出；通过 isExiting 防止重复执行。
   */
  function registerExitHandlers(): void {
    const handler = (): void => {
      if (isExiting) {
        return;
      }

      isExiting = true;
      void execute()
        .then(() => {
          process.exit(0);
        })
        .catch((err: unknown) => {
          logger.error('[Cleanup] 程序退出清理失败', formatError(err));
          process.exit(1);
        });
    };

    process.once('SIGINT', handler);
    process.once('SIGTERM', handler);
  }

  return {
    execute,
    registerExitHandlers,
  };
}
