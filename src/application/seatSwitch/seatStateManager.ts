/**
 * 自动换标模块：席位状态管理与日内抑制
 *
 * 职责：
 * - 席位状态创建与更新
 * - 日内抑制记录与清理
 * - 原子发布换标中席位状态与新身份；阶段计划由唯一 switchStateMachine 写入
 */
import type { SuppressibleSwitchTriggerKind } from '../../domain/seat/types.js';
import { LOG_COLORS } from '../../constants/common.js';
import type { SeatStateManager, SeatStateManagerDeps, SeatStateUpdater } from './types.js';

/**
 * 创建席位状态管理器，封装席位状态构建、更新、日内抑制记录与换标启动准备。
 * @param deps - 依赖（symbolRegistry、switchSuppressions、now、logger、getHKDateKey）
 * @returns SeatStateManager 实例（updateSeatState、resolveSuppression、markSuppression、enterSwitchingSeat）
 */
export function createSeatStateManager(deps: SeatStateManagerDeps): SeatStateManager {
  const { symbolRegistry, switchSuppressions, now, logger, getHKDateKey } = deps;

  /**
   * 更新席位状态，若标的发生变更且 bumpOnSymbolChange 为 true，则同步提升席位版本以隔离旧信号。
   */
  const updateSeatState: SeatStateUpdater = (
    direction: 'LONG' | 'SHORT',
    nextState,
    bumpOnSymbolChange,
  ): void => {
    const current = symbolRegistry.getSeatState(direction);
    if (bumpOnSymbolChange && current.symbol !== nextState.symbol) {
      symbolRegistry.updateSeatStateWithVersionBump(direction, nextState);
      return;
    }

    symbolRegistry.updateSeatState(direction, nextState);
  };

  /**
   * 查询当前方向指定 trigger kind 的日内抑制记录。
   * 若日期键已过期或标的不匹配则自动清除并返回 null；若仅 trigger kind 不匹配，则保留原记录并返回 null。
   */
  function resolveSuppression(
    direction: 'LONG' | 'SHORT',
    seatSymbol: string,
    triggerKind: SuppressibleSwitchTriggerKind,
  ): ReturnType<SeatStateManager['resolveSuppression']> {
    const record = switchSuppressions.get(direction);
    if (!record) {
      return null;
    }

    const currentKey = getHKDateKey(now());
    if (record.dateKey !== currentKey || record.symbol !== seatSymbol) {
      switchSuppressions.delete(direction);
      return null;
    }

    if (!record.suppressedTriggerKinds.has(triggerKind)) {
      return null;
    }

    return record;
  }

  /**
   * 记录指定 trigger kind 的当日日内抑制，防止同一标的在同一交易日内重复触发相同语义的换标。
   */
  function markSuppression(
    direction: 'LONG' | 'SHORT',
    seatSymbol: string,
    triggerKind: SuppressibleSwitchTriggerKind,
  ): void {
    const dateKey = getHKDateKey(now());
    const currentRecord = switchSuppressions.get(direction);
    if (currentRecord?.symbol === seatSymbol && currentRecord.dateKey === dateKey) {
      switchSuppressions.set(direction, {
        symbol: seatSymbol,
        dateKey,
        suppressedTriggerKinds: new Set([...currentRecord.suppressedTriggerKinds, triggerKind]),
      });
      return;
    }

    switchSuppressions.set(direction, {
      symbol: seatSymbol,
      dateKey,
      suppressedTriggerKinds: new Set([triggerKind]),
    });
  }

  /**
   * 将当前席位与版本原子发布为 SWITCHING；同步 listener 清理旧信号，完整阶段计划随后由用例构造一次。
   */
  function enterSwitchingSeat({
    direction,
    reason,
  }: {
    direction: 'LONG' | 'SHORT';
    reason: string;
  }): number {
    const timestamp = now().getTime();
    const currentState = symbolRegistry.getSeatState(direction);
    const currentSymbol = currentState.symbol;
    if (currentSymbol === null) {
      throw new Error(`无法将无标的席位推进为 SWITCHING: direction=${direction}`);
    }

    const { seatVersion: nextVersion } = symbolRegistry.updateSeatStateWithVersionBump(direction, {
      symbol: currentSymbol,
      status: 'SWITCHING',
      lastSwitchAt: timestamp,
      lastSearchAt: null,
      lastSeatActivatedAt: currentState.lastSeatActivatedAt,
      callPrice: null,
      searchFailCountToday: currentState.searchFailCountToday,
      frozenTradingDayKey: currentState.frozenTradingDayKey,
    });
    logger.info(
      `${LOG_COLORS.green}[自动换标] ${direction} 进入换标中状态: ${reason}${LOG_COLORS.reset}`,
    );
    return nextVersion;
  }

  return {
    updateSeatState,
    resolveSuppression,
    markSuppression,
    enterSwitchingSeat,
  };
}
