/**
 * 受控重建席位发布。
 * 启动/开盘在全局交易关闭下已完成独立订单、snapshot、风险和订阅基线后，只发布其席位基线，不重跑运行期激活。
 */
import type { RebuiltSeatActivationDeps, RebuiltSeatActivationInput } from './types.js';

/**
 * 以原成对 token 和全部 captured 席位身份授权同步 ACTIVE 发布；失效返回 false，开门误用立即失败。
 * @param deps 重建阶段共享 snapshot/席位及全局交易开关
 * @param input 重建调用链已完成的完整基线及继承的激活时间
 * @returns 本次基线仍有效且全部席位已发布时返回 true
 */
export function commitRebuiltSeatActivation(
  deps: RebuiltSeatActivationDeps,
  input: RebuiltSeatActivationInput,
): boolean {
  if (deps.isTerminated()) return false;

  if (deps.getIsTradingEnabled()) throw new Error('[SeatActivation] 受控重建激活要求全局交易关闭');

  if (
    !deps.snapshot.isCurrent(input.snapshotToken, { account: true, positions: true, paired: true })
  )
    return false;

  const identitiesCurrent = input.seats.every((seat) => {
    const current = deps.symbolRegistry.getSeatState(seat.direction);
    return (
      current.symbol === seat.symbol &&
      current.status === seat.status &&
      deps.symbolRegistry.getSeatVersion(seat.direction) === seat.seatVersion
    );
  });
  if (!identitiesCurrent) return false;

  for (const seat of input.seats) {
    if (!Number.isFinite(seat.lastSeatActivatedAt))
      throw new TypeError('[SeatActivation] 重建激活时间必须有限');
  }

  for (const seat of input.seats) {
    if (deps.isTerminated()) return false;

    const current = deps.symbolRegistry.getSeatState(seat.direction);
    deps.symbolRegistry.updateSeatState(seat.direction, {
      ...current,
      symbol: seat.symbol,
      status: 'ACTIVE',
      lastSeatActivatedAt: seat.lastSeatActivatedAt,
    });
  }

  return true;
}
