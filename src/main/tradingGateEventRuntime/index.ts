/**
 * TradingGateEventRuntime
 *
 * 职责：
 * - 将时间唤醒评估产生的连续交易门禁变化转为显式事件
 * - 发布自动寻标的完整授权变化，避免消费方重复判断 lifecycle 与末日接管
 */
import { formatError } from '../../utils/error/index.js';
import type {
  AutoSearchAuthorizationChangedEvent,
  TradingGateEventRuntime,
  TradingGateEventRuntimeDeps,
  TradingGateStateChangedEvent,
} from './types.js';

/**
 * 创建交易门禁事件端口。
 *
 * @returns 可发布与订阅连续交易门禁和自动寻标授权变化的事件端口
 */
export function createTradingGateEventRuntime(
  deps: TradingGateEventRuntimeDeps,
): TradingGateEventRuntime {
  const { logger } = deps;
  const gateListeners = new Set<(event: TradingGateStateChangedEvent) => void>();
  const autoSearchAuthorizationListeners = new Set<
    (event: AutoSearchAuthorizationChangedEvent) => void
  >();

  function emitGateStateChanged(event: TradingGateStateChangedEvent): void {
    for (const listener of gateListeners) {
      try {
        listener(event);
      } catch (error) {
        logger.error('[TradingGateEventRuntime] gate state listener 执行失败', formatError(error));
      }
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
   * 无授权 owner 残留。因此必须向时间控制平面抛出，由其统一进入 fatal 路径。
   */
  function emitAutoSearchAuthorizationChanged(event: AutoSearchAuthorizationChangedEvent): void {
    for (const listener of autoSearchAuthorizationListeners) {
      listener(event);
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
