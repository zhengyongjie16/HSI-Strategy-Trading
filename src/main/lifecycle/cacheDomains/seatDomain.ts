/**
 * 席位缓存域（CacheDomain: seat）
 *
 * 午夜清理：
 * - 重置唯一监控标的的自动换仓状态（autoSymbolManager）
 * - 清空轮证列表缓存
 * - 清空所有席位绑定（保留 lastSwitchAt / lastSearchAt 时间戳，重置 lastSeatActivatedAt）
 *
 * 开盘重建：
 * - 席位在统一开盘重建流水线（loadTradingDayRuntimeSnapshot）中重建，此处为空操作
 */
import { logger } from '../../../utils/logger/index.js';
import type { SeatState, SymbolRegistry } from '../../../types/seat.js';
import type { CacheDomain, LifecycleContext } from '../types.js';
import {
  captureSeatActivationCarryover,
  clearSeatActivationCarryover,
} from '../seatActivationCarryover.js';
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

/** 清空唯一 monitor 的多空席位绑定，并刷新席位版本号，返回变更的席位数量 */
function clearAllSeatBindings(symbolRegistry: SymbolRegistry): number {
  let changed = 0;

  for (const direction of ['LONG', 'SHORT'] as const) {
    const previous = symbolRegistry.getSeatState(direction);
    symbolRegistry.updateSeatStateWithVersionBump(direction, buildEmptySeatState(previous));
    changed += 1;
  }

  return changed;
}

/**
 * 创建席位缓存域。
 * 午夜清理时重置自动换标状态、清空轮证缓存与席位绑定；开盘重建由统一流水线负责，本域为空操作。
 *
 * @param deps 依赖注入，包含 symbolRegistry、自动换标状态重置与 warrantListCache
 * @returns 实现 CacheDomain 的席位域实例
 */
export function createSeatDomain(deps: SeatDomainDeps): CacheDomain {
  const { symbolRegistry, autoSymbolManager, warrantListCache } = deps;
  return {
    midnightClear(ctx: LifecycleContext): void {
      if (ctx.invalidateSeatActivationCarryover === true) {
        clearSeatActivationCarryover(symbolRegistry);
      } else {
        captureSeatActivationCarryover({ symbolRegistry });
      }

      autoSymbolManager.resetAllState();
      warrantListCache.clear();
      const changedSeats = clearAllSeatBindings(symbolRegistry);

      logger.debug(`[Lifecycle][seat] 午夜清理完成: seats=${changedSeats}`);
    },
    openRebuild(_ctx: LifecycleContext): void {
      // 席位在统一开盘重建流水线中重建
    },
  };
}
