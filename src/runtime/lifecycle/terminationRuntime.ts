/**
 * 进程终止运行时
 *
 * 统一锁存不可逆终止与首个原始 fatal，同步关闭交易和队列准入，
 * 尝试全部停生产回调后才通知主流程；异步排空由唯一 cleanup 负责。
 */
import type { RuntimeTermination, RuntimeTerminationDeps } from '../../types/runtime.js';

/** 创建唯一进程终止入口，正常退出不制造 fatal，后续真实错误仍可锁存。 */
export function createTerminationRuntime(deps: RuntimeTerminationDeps): RuntimeTermination {
  let terminated = false;
  let fatalState: ReturnType<RuntimeTermination['getFatalState']> = { hasFatalError: false };
  let notify: (() => void) | null = null;
  const terminationPromise = new Promise<void>((resolve) => {
    notify = resolve;
  });

  /** 隔离次要清理错误，避免单个停生产失败阻断后续关停及通知。 */
  function attempt(action: () => void): void {
    try {
      action();
    } catch (error) {
      try {
        deps.onSecondaryError(error);
      } catch {
        // 错误观察者不得夺取首错或阻断其余同步关停。
      }
    }
  }

  /** 先发布终态，再关闭所有准入；重复请求不得重复执行停生产。 */
  function requestShutdown(): void {
    if (terminated) {
      return;
    }

    terminated = true;
    attempt(deps.closeTradingGate);
    attempt(deps.closeProducerAdmission);
    for (const stop of deps.stopProducers) {
      attempt(stop);
    }

    notify?.();
  }

  /** 保留包括 null/undefined 的首个原始错误，随后按同一同步流程关停。 */
  function reportFatalError(error: unknown): void {
    if (!fatalState.hasFatalError) {
      fatalState = { hasFatalError: true, error };
    } else if (fatalState.error !== error) {
      attempt(() => {
        deps.onSecondaryError(error);
      });
    }

    requestShutdown();
  }

  return {
    isTerminated: () => terminated,
    getFatalState: () => fatalState,
    requestShutdown,
    reportFatalError,
    waitForTermination: () => terminationPromise,
  };
}
