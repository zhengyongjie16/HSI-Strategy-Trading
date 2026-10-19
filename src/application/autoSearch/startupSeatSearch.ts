/**
 * 启动空席位寻标用例。
 * 职责：SEARCHING → ACTIVATING/EMPTY；无候选计数冻结，异常复原但不计数并交恢复链路重试。
 * 历史标的推断、启动准入及恢复重试时机仍由 recovery owner 决定。
 */
import { AUTO_SYMBOL_MAX_SEARCH_FAILURES_PER_DAY } from '../../constants/index.js';
import { isSeatFrozenToday, resolveNextSearchFailureState } from '../../domain/seat/seatPolicy.js';
import { isExternalApiRequestError } from '../../utils/apiFailure/index.js';
import { getHKDateKey } from '../../utils/time/index.js';
import type {
  AutoSearchCandidate,
  SearchOnEventParams,
  StartupSeatSearch,
  StartupSeatSearchDeps,
} from './types.js';

/** 创建启动补席的独立失败政策，不借用运行期“外部失败也计数”的搜索入口。 */
export function createStartupSeatSearch(deps: StartupSeatSearchDeps): StartupSeatSearch {
  const { monitorSymbol, symbolRegistry, candidateSearch, logger } = deps;

  /** 只提交原 SEARCHING 身份的结果；过期结果不记成功/失败，异常仍交恢复 owner 分类处理。 */
  async function searchSeat({
    direction,
    currentTime,
    canContinue,
  }: SearchOnEventParams): Promise<void> {
    if (!canContinue() || candidateSearch.resolveDistanceRange(direction) === null) return;

    const currentSeat = symbolRegistry.getSeatState(direction);
    if (currentSeat.status !== 'EMPTY' || isSeatFrozenToday(currentSeat)) return;

    const seatVersion = symbolRegistry.getSeatVersion(direction);
    const nowMs = currentTime.getTime();
    symbolRegistry.updateSeatState(direction, {
      symbol: null,
      status: 'SEARCHING',
      lastSwitchAt: currentSeat.lastSwitchAt,
      lastSearchAt: nowMs,
      lastSeatActivatedAt: currentSeat.lastSeatActivatedAt,
      callPrice: null,
      searchFailCountToday: currentSeat.searchFailCountToday,
      frozenTradingDayKey: currentSeat.frozenTradingDayKey,
    });
    const isSearchCurrent = (): boolean =>
      canContinue() &&
      symbolRegistry.getSeatVersion(direction) === seatVersion &&
      symbolRegistry.getSeatState(direction).status === 'SEARCHING';

    let best: AutoSearchCandidate | null;
    try {
      best = await candidateSearch.findCandidate({
        direction,
        currentTime,
        canContinue: isSearchCurrent,
      });
    } catch (error) {
      if (isSearchCurrent()) {
        const seat = symbolRegistry.getSeatState(direction);
        symbolRegistry.updateSeatState(direction, {
          symbol: null,
          status: 'EMPTY',
          lastSwitchAt: seat.lastSwitchAt,
          lastSearchAt: nowMs,
          lastSeatActivatedAt: seat.lastSeatActivatedAt,
          callPrice: null,
          searchFailCountToday: seat.searchFailCountToday,
          frozenTradingDayKey: seat.frozenTradingDayKey,
        });
      }

      if (isExternalApiRequestError(error)) {
        logger.warn(
          `[席位恢复] ${monitorSymbol} ${direction} 寻标 API 请求失败，等待恢复链路重试: ${error.message}`,
        );
      }

      throw error;
    }

    if (!isSearchCurrent()) return;

    if (best === null) {
      const seat = symbolRegistry.getSeatState(direction);
      const { nextFailCount, frozenTradingDayKey, shouldFreeze } = resolveNextSearchFailureState({
        currentSeat: seat,
        hkDateKey: getHKDateKey(currentTime),
        maxSearchFailuresPerDay: AUTO_SYMBOL_MAX_SEARCH_FAILURES_PER_DAY,
      });
      if (shouldFreeze) {
        logger.warn(
          `[席位恢复] ${monitorSymbol} ${direction} 当日寻标失败达 ${nextFailCount} 次，席位冻结`,
        );
      }

      symbolRegistry.updateSeatState(direction, {
        symbol: null,
        status: 'EMPTY',
        lastSwitchAt: seat.lastSwitchAt,
        lastSearchAt: nowMs,
        lastSeatActivatedAt: seat.lastSeatActivatedAt,
        callPrice: null,
        searchFailCountToday: nextFailCount,
        frozenTradingDayKey,
      });
      return;
    }

    symbolRegistry.updateSeatState(direction, {
      symbol: best.symbol,
      status: 'ACTIVATING',
      lastSwitchAt: nowMs,
      lastSearchAt: nowMs,
      lastSeatActivatedAt: null,
      callPrice: best.callPrice,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    });
    logger.info(`[席位恢复] ${monitorSymbol} ${direction} 已进入激活阶段: ${best.symbol}`);
  }

  return { searchSeat };
}
