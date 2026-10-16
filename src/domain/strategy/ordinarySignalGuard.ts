import type { LifecycleMutableState } from '../../types/lifecycle.js';
import type { TradingTimeState } from '../../types/timeControlPlane.js';

/**
 * ordinarySignalGuard 模块
 *
 * 职责：
 * - 统一普通信号链路的共享准入判断
 * - 复用 lifecycle / 连续交易 / 清仓接管窗口三类门禁
 * - 保持纯函数，不持有任何 owner 私有运行态
 */
import { isWithinDoomsdayClearanceTakeoverWindow } from '../liquidation/doomsday/index.js';

/**
 * 普通信号共享门禁判断参数。
 *
 * @param lastState 全局运行时状态
 * @param now 当前判定时刻
 * @param doomsdayProtectionEnabled 是否启用末日保护清仓接管门禁
 * @returns 门禁打开时返回 true
 */
export function ordinarySignalGuard(params: {
  readonly tradingTimeState: Readonly<Pick<TradingTimeState, 'canTrade' | 'isHalfDay'>>;
  readonly lifecycleState: Readonly<Pick<LifecycleMutableState, 'isTradingEnabled'>>;
  readonly now: Date;
  readonly doomsdayProtectionEnabled: boolean;
}): boolean {
  const { tradingTimeState, lifecycleState, now, doomsdayProtectionEnabled } = params;

  if (!lifecycleState.isTradingEnabled || tradingTimeState.canTrade !== true) {
    return false;
  }

  if (!doomsdayProtectionEnabled) {
    return true;
  }

  return !isWithinDoomsdayClearanceTakeoverWindow(now, tradingTimeState.isHalfDay ?? false);
}
