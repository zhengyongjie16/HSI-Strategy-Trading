/**
 * app 单实例运行时辅助模块
 *
 * 职责：
 * - 校验单实例 StrategyRuntime 是否已注册完成
 */
import type { StrategyRuntime } from '../types/state.js';

/**
 * 断言单实例 StrategyRuntime 已存在。
 *
 * @param monitorContext post-gate runtime 暂存的 StrategyRuntime
 * @returns 已注册完成的 StrategyRuntime
 */
export function requireStrategyRuntime(monitorContext: StrategyRuntime | null): StrategyRuntime {
  if (monitorContext === null) {
    throw new Error('单实例 StrategyRuntime 尚未完成装配');
  }

  return monitorContext;
}
