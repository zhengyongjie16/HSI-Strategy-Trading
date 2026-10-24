/**
 * TradingGateEventRuntime
 *
 * 职责：
 * - 将时间唤醒评估产生的连续交易门禁变化转为显式事件
 * - 发布自动寻标的完整授权变化，避免消费方重复判断 lifecycle 与末日接管
 */
import type { TradingGateEventRuntime, TradingGateEventRuntimeDeps } from './types.js';
import type {
  AutoSearchAuthorizationChangedEvent,
  TradingGateStateChangedEvent,
} from '../../types/timeControlPlane.js';

/**
 * 创建交易门禁事件端口。
 *
 * @returns 可发布与订阅连续交易门禁和自动寻标授权变化的事件端口
 */
export function createTradingGateEventRuntime(
  deps: TradingGateEventRuntimeDeps,
): TradingGateEventRuntime {
  const { termination } = deps;
  const gateListeners = new Set<(event: TradingGateStateChangedEvent) => void>();
  const autoSearchAuthorizationListeners = new Set<
    (event: AutoSearchAuthorizationChangedEvent) => void
  >();

  /**
   * 按发布开始时的快照通知全部 listener；失败立即同步关门，避免后续 listener 继续生产。
   * stop 中的退订不影响本轮通知，新增订阅留待下轮；全部尝试后再抛包括空值在内的原始首错。
   */
  function emitGateStateChanged(event: TradingGateStateChangedEvent): void {
    const listeners = [...gateListeners];
    let hasFirstError = false;
    let firstError: unknown;
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (error) {
        if (!hasFirstError) {
          hasFirstError = true;
          firstError = error;
        }

        termination.reportFatalError(error);
      }
    }

    if (hasFirstError) {
      throw firstError;
    }
  }

  function onGateStateChanged(listener: (event: TradingGateStateChangedEvent) => void): () => void {
    gateListeners.add(listener);
    return () => {
      gateListeners.delete(listener);
    };
  }

  /**
   * 发布自动寻标授权变化。
   *
   * 该事件负责使授权失效时的 SEARCHING owner 同步失效；listener 的内部错误若被吞掉，会让
   * 无授权 owner 残留。因此先同步进入唯一 fatal 路径，再向时间控制平面抛出原值，禁止继续发布。
   */
  function emitAutoSearchAuthorizationChanged(event: AutoSearchAuthorizationChangedEvent): void {
    for (const listener of autoSearchAuthorizationListeners) {
      try {
        listener(event);
      } catch (error) {
        termination.reportFatalError(error);
        throw error;
      }
    }
  }

  function onAutoSearchAuthorizationChanged(
    listener: (event: AutoSearchAuthorizationChangedEvent) => void,
  ): () => void {
    autoSearchAuthorizationListeners.add(listener);
    return () => {
      autoSearchAuthorizationListeners.delete(listener);
    };
  }

  return {
    emitGateStateChanged,
    onGateStateChanged,
    emitAutoSearchAuthorizationChanged,
    onAutoSearchAuthorizationChanged,
  };
}
