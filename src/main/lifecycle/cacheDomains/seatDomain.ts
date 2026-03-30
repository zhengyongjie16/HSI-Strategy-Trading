/**
 * 席位缓存域（CacheDomain: seat）
 *
 * 午夜清理：
 * - 重置所有监控标的的自动换仓状态（autoSymbolManager）
 * - 清空轮证列表缓存
 * - 清空所有席位绑定（保留 lastSwitchAt / lastSearchAt 时间戳，重置 lastSeatActivatedAt）
 * - 同步席位快照到各 StrategyRuntime
 *
 * 开盘重建：
 * - 席位在统一开盘重建流水线（loadTradingDayRuntimeSnapshot）中重建，此处为空操作
 */
import { logger } from '../../../utils/logger/index.js';
import { resolveStrategyRuntimeSeatSnapshot } from '../../../utils/utils.js';
import type { SeatState, SymbolRegistry } from '../../../types/seat.js';
import type { CacheDomain, LifecycleContext } from '../types.js';
import type { SeatDomainDeps } from './types.js';

/** 基于旧席位状态构造空席位，保留 lastSwitchAt / lastSearchAt 时间戳并重置 lastSeatActivatedAt */
function buildEmptySeatState(previous: SeatState): SeatState {
  return {
    symbol: null,
    status: 'EMPTY',
    lastSwitchAt: previous.lastSwitchAt ?? null,
    lastSearchAt: previous.lastSearchAt ?? null,
    lastSeatActivatedAt: null,
    callPrice: null,
    searchFailCountToday: 0,
    frozenTradingDayKey: null,
  };
}

/** 清空单实例 monitor 的多空席位绑定，并刷新席位版本号，返回变更的席位数量 */
function clearAllSeatBindings(symbolRegistry: SymbolRegistry): number {
  let changed = 0;
  for (const direction of ['LONG', 'SHORT'] as const) {
    const previous = symbolRegistry.getSeatState(direction);
    symbolRegistry.updateSeatState(direction, buildEmptySeatState(previous));
    symbolRegistry.bumpSeatVersion(direction);
    changed += 1;
  }

  return changed;
}

/** 将 symbolRegistry 中的最新席位状态和版本号同步到各 StrategyRuntime 快照 */
function syncMonitorSeatSnapshots(
  monitorContext: SeatDomainDeps['monitorContext'],
  symbolRegistry: SymbolRegistry,
): void {
  const seatSnapshot = resolveStrategyRuntimeSeatSnapshot(
    monitorContext.config.baseInstrumentSymbol,
    symbolRegistry,
  );
  monitorContext.seatState = seatSnapshot.seatState;
  monitorContext.seatVersion = seatSnapshot.seatVersion;
}

/**
 * 创建席位缓存域。
 * 午夜清理时重置自动换标状态、清空轮证缓存与席位绑定并同步到各 StrategyRuntime；开盘重建由统一流水线负责，本域为空操作。
 *
 * @param deps 依赖注入，包含 tradingConfig、monitorConfig、symbolRegistry、monitorContext、warrantListCache
 * @returns 实现 CacheDomain 的席位域实例
 */
export function createSeatDomain(deps: SeatDomainDeps): CacheDomain {
  const { tradingConfig, symbolRegistry, monitorContext, warrantListCache } = deps;
  return {
    midnightClear(_ctx: LifecycleContext): void {
      monitorContext.autoSymbolManager.resetAllState();
      warrantListCache.clear();
      const changedSeats = clearAllSeatBindings(symbolRegistry);
      syncMonitorSeatSnapshots(monitorContext, symbolRegistry);

      logger.debug(
        `[Lifecycle][seat] 午夜清理完成: monitor=${tradingConfig.baseInstrument}, seats=${changedSeats}`,
      );
    },
    openRebuild(_ctx: LifecycleContext): void {
      // 席位在统一开盘重建流水线中重建
    },
  };
}
