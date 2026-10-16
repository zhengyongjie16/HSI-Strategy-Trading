/**
 * 启动重建后的 runtime 启动协调。
 * 保留具体 owner 的既有顺序；初次重建失败时只启动系统级时间唤醒，等待生命周期恢复。
 * 不负责加载/重建业务、终止锁存或最终 cleanup，也不建立通用生命周期执行器。
 */
import type { StartRuntimeAfterStartupRebuildParams } from './startup/types.js';

/**
 * 按启动协议恢复已创建的 runtime；TimeWakeup 的首轮评估完成后才允许 K 线业务 owner 启动。
 * TimeWakeup 在交易关闭或重建待重试时仍运行；其评估中的午夜切换不得等待自身 drain。
 * 调用方在返回后仍须检查 termination，再记录运行状态或等待退出。
 *
 * @param params 初次重建结果、原交易开关与具体 runtime owner
 * @returns 本次启动协调完成；终止时不再启动后续业务 owner
 */
export async function startRuntimeAfterStartupRebuild(
  params: StartRuntimeAfterStartupRebuildParams,
): Promise<void> {
  if (params.termination.isTerminated()) return;

  if (params.initialRebuildSucceeded) {
    params.lifecycleState.isTradingEnabled = params.startupTradingEnabled;
    params.tradingQuoteDisplayRuntime.start();
    params.quoteSubscriptionRuntime.start();
    params.seatRuntimeCleanupDispatcher.start();
    params.seatActivationDispatcher.start();
    params.autoSearchWakeupRuntime.start();
    params.periodicSwitchWakeupRuntime.start();
    params.monitorDisplayRuntime.start();
    params.tradingRiskEventRuntime.start();
    params.monitorQuoteEventRuntime.start();
    params.switchWakeupRuntime.start();
    params.monitorTaskProcessor.start();
    params.buyProcessor.start();
    params.sellProcessor.start();
    params.orderMonitor.startRuntime();
  }

  await params.timeWakeupRuntime.start();
  if (params.termination.isTerminated()) return;

  if (params.initialRebuildSucceeded) params.businessEventProgram.start();
}
