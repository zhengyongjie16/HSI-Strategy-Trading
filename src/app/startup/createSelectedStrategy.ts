/**
 * 选中策略唯一实例创建边界。
 * 先登记可清理对象的 destroy，再校验同步返回、身份和完整端口，拒绝 Promise 及错误身份。
 */
import type { StrategyDeps, TradingSignalStrategy } from '../../core/strategy/types.js';
import type { CleanupController } from '../types.js';
import type { PreparedStrategySelection } from './types.js';

/** 校验可信本地模块运行时返回的完整策略端口，不接受异步实例。 */
function isStrategy(value: unknown, strategyId: string): value is TradingSignalStrategy {
  return (
    typeof value === 'object' &&
    value !== null &&
    !('then' in value) &&
    'strategyId' in value &&
    value.strategyId === strategyId &&
    'onCandlestick' in value &&
    typeof value.onCandlestick === 'function' &&
    'invalidateDirection' in value &&
    typeof value.invalidateDirection === 'function' &&
    'invalidateAll' in value &&
    typeof value.invalidateAll === 'function' &&
    'resetForTradingDay' in value &&
    typeof value.resetForTradingDay === 'function' &&
    'destroy' in value &&
    typeof value.destroy === 'function'
  );
}

/** 创建且只登记一次 destroy；其余契约失败仍由同一 cleanup owner 释放实例。 */
export function createSelectedStrategy(
  selection: PreparedStrategySelection,
  deps: StrategyDeps,
  cleanup: CleanupController,
): TradingSignalStrategy {
  const value: unknown = selection.prepared.create(deps);
  if (
    ((typeof value === 'object' && value !== null) || typeof value === 'function') &&
    'destroy' in value &&
    typeof value.destroy === 'function'
  ) {
    const destroy = value.destroy;
    cleanup.register({
      phase: 'DESTROY_STRATEGY',
      step: '销毁选中策略实例',
      handler: () => {
        destroy.call(value);
      },
    });
  }

  if (!isStrategy(value, selection.strategyId)) {
    throw new TypeError('[Strategy:create] 必须同步返回身份匹配的完整策略实例');
  }

  return value;
}
