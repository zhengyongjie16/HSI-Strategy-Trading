/**
 * 运行期空席位自动寻标（AutoSearch）
 *
 * 功能：在席位为空时按冷却间隔触发自动寻标。
 * 职责：自动寻标开盘延迟（在早盘延迟窗口内跳过寻标）、失败冻结与成功后席位 ACTIVATING 更新。
 * 执行流程：准入与冷却 → SEARCHING → 共享候选能力 → ACTIVATING 或 EMPTY/失败冻结。
 * 不处理启动补席或换标失败，不拥有 timer、switch 状态或 activation 完成。
 */
import type {
  AutoSearchCandidate,
  AutoSearchDeps,
  AutoSearchWorkflow,
  CancelSearchParams,
  SearchOnEventParams,
} from './types.js';
import { isExternalApiRequestError } from '../../utils/apiFailure/index.js';
import { isSeatFrozenToday, resolveNextSearchFailureState } from '../../domain/seat/seatPolicy.js';
import { getHKDateKey } from '../../utils/time/index.js';
import { isWithinMorningOpenWindow } from '../../domain/tradingSession/index.js';
import {
  AUTO_SYMBOL_MAX_SEARCH_FAILURES_PER_DAY,
  AUTO_SYMBOL_SEARCH_COOLDOWN_MS,
} from '../../constants/common.js';

/**
 * 创建运行期空席位搜索唯一 owner；当前身份的无候选/外部失败记数，内部错误记数后原样暴露。
 * @param deps 方向配置、registry、共享候选能力与日志，不注入换标状态管理器
 * @returns 只处理运行期 maybeSearchOnEvent 的用例
 */
export function createAutoSearch(deps: AutoSearchDeps): AutoSearchWorkflow {
  const { autoSearchConfig, monitorSymbol, symbolRegistry, candidateSearch, logger } = deps;

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
      maxSearchFailuresPerDay: AUTO_SYMBOL_MAX_SEARCH_FAILURES_PER_DAY,
    });
    if (shouldFreeze) {
      logger.warn(
        `[自动寻标] ${monitorSymbol} ${direction} 当日寻标失败达 ${nextFailCount} 次，席位冻结`,
      );
    }

    symbolRegistry.updateSeatState(direction, {
      symbol: null,
      status: 'EMPTY',
      lastSwitchAt: currentSeat.lastSwitchAt ?? null,
      lastSearchAt: nowMs,
      lastSeatActivatedAt: currentSeat.lastSeatActivatedAt ?? null,
      callPrice: null,
      searchFailCountToday: nextFailCount,
      frozenTradingDayKey,
    });

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
    if (nowMs - lastSearchAt < AUTO_SYMBOL_SEARCH_COOLDOWN_MS) {
      return;
    }

    if (
      autoSearchConfig.autoSearchOpenDelayMinutes > 0 &&
      isWithinMorningOpenWindow(currentTime, autoSearchConfig.autoSearchOpenDelayMinutes)
    ) {
      return;
    }

    if (candidateSearch.resolveDistanceRange(direction) === null) return;

    if (
      !canContinue() ||
      symbolRegistry.getSeatVersion(direction) !== seatVersion ||
      symbolRegistry.getSeatState(direction).status !== 'EMPTY'
    ) {
      return;
    }

    symbolRegistry.updateSeatState(direction, {
      symbol: null,
      status: 'SEARCHING',
      lastSwitchAt: seatState.lastSwitchAt ?? null,
      lastSearchAt: nowMs,
      lastSeatActivatedAt: seatState.lastSeatActivatedAt ?? null,
      callPrice: null,
      searchFailCountToday: seatState.searchFailCountToday,
      frozenTradingDayKey: seatState.frozenTradingDayKey,
    });

    if (!isSearchOwnerCurrent({ direction, seatVersion, canContinue })) {
      return;
    }

    let best: AutoSearchCandidate | null;
    try {
      best = await candidateSearch.findCandidate({
        direction,
        currentTime,
        canContinue: () => isSearchOwnerCurrent({ direction, seatVersion, canContinue }),
      });
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
    symbolRegistry.updateSeatStateWithVersionBump(direction, nextState);
  }

  /** 仅撤销当前 runtime 仍拥有的 SEARCHING 版本，保留搜索时间与失败事实。 */
  function cancelSearch({ direction, seatVersion }: CancelSearchParams): void {
    if (symbolRegistry.getSeatVersion(direction) !== seatVersion) return;

    const seat = symbolRegistry.getSeatState(direction);
    if (seat.status !== 'SEARCHING') return;

    symbolRegistry.updateSeatStateWithVersionBump(direction, {
      symbol: null,
      status: 'EMPTY',
      lastSwitchAt: seat.lastSwitchAt,
      lastSearchAt: seat.lastSearchAt,
      lastSeatActivatedAt: seat.lastSeatActivatedAt,
      callPrice: null,
      searchFailCountToday: seat.searchFailCountToday,
      frozenTradingDayKey: seat.frozenTradingDayKey,
    });
  }

  return {
    maybeSearchOnEvent,
    cancelSearch,
  };
}
