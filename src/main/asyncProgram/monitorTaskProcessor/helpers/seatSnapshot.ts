/**
 * 席位快照校验助手
 *
 * 功能：
 * - 校验席位快照一致性与版本，避免旧任务在换标后执行
 */
import { isSeatVersionMatch } from '../../../../utils/seat/guards.js';

import type { MonitorContext } from '../../../../types/state.js';
import type { SeatSnapshot } from '../types.js';

/**
 * 校验席位快照是否与当前席位状态一致
 * 同时比对版本号、标的与激活基线，防止旧任务在换标后被错误执行
 *
 * @param direction 方向（LONG 或 SHORT）
 * @param snapshot 任务携带的席位快照（版本号 + 标的 + 激活基线）
 * @param context 唯一监控上下文
 * @returns 版本、标的与激活基线均一致时返回 true
 */
export function isSeatSnapshotValid(
  direction: 'LONG' | 'SHORT',
  snapshot: SeatSnapshot,
  context: Pick<MonitorContext, 'symbolRegistry'>,
): boolean {
  const seatState = context.symbolRegistry.getSeatState(direction);
  const currentVersion = context.symbolRegistry.getSeatVersion(direction);
  if (!isSeatVersionMatch(snapshot.seatVersion, currentVersion)) {
    return false;
  }

  if (seatState.symbol !== snapshot.symbol) {
    return false;
  }

  return seatState.lastSeatActivatedAt === snapshot.lastSeatActivatedAt;
}
