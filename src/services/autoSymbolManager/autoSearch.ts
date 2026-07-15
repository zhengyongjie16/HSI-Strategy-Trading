/**
 * 自动换标模块：自动寻标（AutoSearch）
 *
 * 功能：在席位为空时按冷却间隔触发自动寻标。
 * 职责：自动寻标开盘延迟（在早盘延迟窗口内跳过寻标）、失败冻结与成功后席位 ACTIVATING 更新。
 * 执行流程：maybeSearchOnEvent 检查席位状态与冷却 → 调用 findBestWarrant → 成功则更新为 ACTIVATING，失败则累计失败计数或冻结。
 */
import type { AutoSearchDeps, AutoSearchManager, SearchOnEventParams } from './types.js';
import { isExternalApiRequestError } from '../../utils/apiFailure/index.js';
import { isSeatFrozenToday, resolveNextSearchFailureState } from './utils.js';

/**
 * 创建自动寻标子模块，管理空席位的寻标触发、冷却控制与失败冻结逻辑；事件唤醒时检查席位状态，满足条件时调用 findBestWarrant 并更新席位。
 * @param deps - 依赖（autoSearchConfig、symbolRegistry、updateSeatState、resolveDirectionalAutoSearchPolicy、buildFindBestWarrantInput、findBestWarrant 等）
 * @returns AutoSearchManager 实例（maybeSearchOnEvent）
 */
export function createAutoSearch(deps: AutoSearchDeps): AutoSearchManager {
  const {
    autoSearchConfig,
    monitorSymbol,
    symbolRegistry,
    updateSeatState,
    resolveDirectionalAutoSearchPolicy,
    buildFindBestWarrantInput,
    findBestWarrant,
    isWithinMorningAutoSearchOpenDelay,
    searchCooldownMs,
    getHKDateKey,
    maxSearchFailuresPerDay,
    logger,
  } = deps;

  /**
   * 判断异步寻标结果是否仍属于当前 SEARCHING owner。
   *
   * 仅方向与席位版本共同标识 owner；普通交易授权关闭、版本变更或状态离开 SEARCHING 时，
   * 外部结果必须直接丢弃，不能再写入候选或失败事实。
   */
  function isSearchOwnerCurrent(params: {
    readonly direction: 'LONG' | 'SHORT';
    readonly seatVersion: number;
    readonly canContinue: () => boolean;
  }): boolean {
    if (!params.canContinue()) {
      return false;
    }

    if (symbolRegistry.getSeatVersion(params.direction) !== params.seatVersion) {
      return false;
    }

    return symbolRegistry.getSeatState(params.direction).status === 'SEARCHING';
  }

  /** 将一次仍归属当前 owner 的寻标失败统一收口为 EMPTY，并推进当日失败计数。 */
  function recordSearchFailure(params: {
    readonly direction: 'LONG' | 'SHORT';
    readonly currentTime: Date;
    readonly seatVersion: number;
    readonly canContinue: () => boolean;
  }): boolean {
    if (!isSearchOwnerCurrent(params)) {
      return false;
    }

    const { direction, currentTime } = params;
    const currentSeat = symbolRegistry.getSeatState(direction);
    const nowMs = currentTime.getTime();
    const { nextFailCount, frozenTradingDayKey, shouldFreeze } = resolveNextSearchFailureState({
      currentSeat,
      hkDateKey: getHKDateKey(currentTime),
      maxSearchFailuresPerDay,
    });
    if (shouldFreeze) {
      logger.warn(
        `[自动寻标] ${monitorSymbol} ${direction} 当日寻标失败达 ${nextFailCount} 次，席位冻结`,
      );
    }

    updateSeatState(
      direction,
      {
        symbol: null,
        status: 'EMPTY',
        lastSwitchAt: currentSeat.lastSwitchAt ?? null,
        lastSearchAt: nowMs,
        lastSeatActivatedAt: currentSeat.lastSeatActivatedAt ?? null,
        callPrice: null,
        searchFailCountToday: nextFailCount,
        frozenTradingDayKey,
      },
      false,
    );

    return true;
  }

  /**
   * 在席位为空时执行自动寻标，受自动寻标开盘延迟与冷却时间限制。
   */
  async function maybeSearchOnEvent({
    direction,
    currentTime,
    canContinue,
  }: SearchOnEventParams): Promise<void> {
    if (!autoSearchConfig.autoSearchEnabled || !canContinue()) {
      return;
    }

    const seatState = symbolRegistry.getSeatState(direction);
    const seatVersion = symbolRegistry.getSeatVersion(direction);
    if (seatState.status !== 'EMPTY') {
      return;
    }

    if (isSeatFrozenToday(seatState)) {
      return;
    }

    const lastSearchAt = seatState.lastSearchAt ?? 0;
    const nowMs = currentTime.getTime();
    if (nowMs - lastSearchAt < searchCooldownMs) {
      return;
    }

    if (
      autoSearchConfig.autoSearchOpenDelayMinutes > 0 &&
      isWithinMorningAutoSearchOpenDelay(currentTime, autoSearchConfig.autoSearchOpenDelayMinutes)
    ) {
      return;
    }

    const policy = resolveDirectionalAutoSearchPolicy({
      direction,
      logPrefix: '[自动寻标] 缺少阈值配置，跳过寻标',
    });
    if (policy === null) {
      return;
    }

    if (
      !canContinue() ||
      symbolRegistry.getSeatVersion(direction) !== seatVersion ||
      symbolRegistry.getSeatState(direction).status !== 'EMPTY'
    ) {
      return;
    }

    updateSeatState(
      direction,
      {
        symbol: null,
        status: 'SEARCHING',
        lastSwitchAt: seatState.lastSwitchAt ?? null,
        lastSearchAt: nowMs,
        lastSeatActivatedAt: seatState.lastSeatActivatedAt ?? null,
        callPrice: null,
        searchFailCountToday: seatState.searchFailCountToday,
        frozenTradingDayKey: seatState.frozenTradingDayKey,
      },
      false,
    );

    if (!isSearchOwnerCurrent({ direction, seatVersion, canContinue })) {
      return;
    }

    let best: { readonly symbol: string; readonly callPrice: number } | null;
    try {
      const input = await buildFindBestWarrantInput({
        currentTime,
        policy,
      });
      if (!isSearchOwnerCurrent({ direction, seatVersion, canContinue })) {
        return;
      }

      best = await findBestWarrant(input);
    } catch (err) {
      if (isExternalApiRequestError(err)) {
        if (!recordSearchFailure({ direction, currentTime, seatVersion, canContinue })) {
          return;
        }

        logger.warn(
          `[自动寻标] ${monitorSymbol} ${direction} 外部请求失败，等待 cooldown owner 重试: ${err.message}`,
        );
        return;
      }

      recordSearchFailure({ direction, currentTime, seatVersion, canContinue });
      throw err;
    }

    if (!isSearchOwnerCurrent({ direction, seatVersion, canContinue })) {
      return;
    }

    if (!best) {
      recordSearchFailure({ direction, currentTime, seatVersion, canContinue });
      return;
    }

    const nextState = {
      symbol: best.symbol,
      status: 'ACTIVATING',
      lastSwitchAt: nowMs,
      lastSearchAt: nowMs,
      lastSeatActivatedAt: null,
      callPrice: best.callPrice,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    } as const;
    updateSeatState(direction, nextState, true);
  }

  return {
    maybeSearchOnEvent,
  };
}
