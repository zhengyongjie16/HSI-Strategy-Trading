/**
 * 启动失败生命周期状态协同模块
 *
 * 职责：
 * - 在启动快照失败时切换生命周期状态
 * - 固化 pendingOpenRebuild 为当前恢复触发契约
 */
import type { LifecycleMutableState } from '../../types/lifecycle.js';

/**
 * 将全局状态切换为"启动快照失败，等待开盘重建重试"。
 * 默认行为：阻断交易并标记 pendingOpenRebuild。
 *
 * @param lastState 全局可变状态
 * @returns 无返回值，直接原地更新 lastState
 */
export function applyStartupSnapshotFailureState(lifecycleState: LifecycleMutableState): void {
  lifecycleState.pendingOpenRebuild = true;
  lifecycleState.lifecycleState = 'OPEN_REBUILD_FAILED';
  lifecycleState.isTradingEnabled = false;
}
