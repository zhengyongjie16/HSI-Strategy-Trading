/** 席位身份纯校验：固定方向、版本、标的与激活基线，阻断失效任务。 */
import type { SeatState, SeatStateChangedEvent, SymbolRegistry } from '../../types/seat.js';
import type { SeatActivationIdentity, SeatSnapshot } from './types.js';

/**
 * 判断信号席位版本与当前席位版本是否一致。
 *
 * @param signalVersion 信号携带的 seatVersion
 * @param currentVersion 当前席位版本
 * @returns 版本为有限数且一致时返回 true
 */
export function isSeatVersionMatch(
  signalVersion: number | null | undefined,
  currentVersion: number,
): boolean {
  return Number.isFinite(signalVersion) && signalVersion === currentVersion;
}

/** 返回仍匹配的 ACTIVATING 席位；不改写席位或推进任何完成条件。 */
export function resolveActivatingSeat(
  registry: Pick<SymbolRegistry, 'getSeatState' | 'getSeatVersion'>,
  identity: SeatActivationIdentity,
): Extract<SeatState, { readonly status: 'ACTIVATING' }> | null {
  const state = registry.getSeatState(identity.direction);
  return isSeatVersionMatch(identity.seatVersion, registry.getSeatVersion(identity.direction)) &&
    state.status === 'ACTIVATING' &&
    state.symbol === identity.nextSymbol
    ? state
    : null;
}

/** ACTIVE 退出或标的/版本身份变更时，旧方向等待与 warrant 事实必须失效。 */
export function requiresSeatRuntimeCleanup(event: SeatStateChangedEvent): boolean {
  return (
    event.previousState.status === 'ACTIVE' &&
    (event.nextState.status !== 'ACTIVE' ||
      event.previousState.symbol !== event.nextState.symbol ||
      event.previousVersion !== event.nextVersion)
  );
}

/** 校验周期任务的版本、标的及原 ACTIVE 计时基线，避免旧计划推进新席位。 */
export function isSeatSnapshotValid(
  direction: 'LONG' | 'SHORT',
  snapshot: SeatSnapshot,
  registry: Pick<SymbolRegistry, 'getSeatState' | 'getSeatVersion'>,
): boolean {
  const state = registry.getSeatState(direction);
  return (
    isSeatVersionMatch(snapshot.seatVersion, registry.getSeatVersion(direction)) &&
    state.symbol === snapshot.symbol &&
    state.lastSeatActivatedAt === snapshot.lastSeatActivatedAt
  );
}
