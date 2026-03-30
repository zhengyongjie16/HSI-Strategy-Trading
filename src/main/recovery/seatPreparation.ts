/**
 * 运行时席位恢复模块
 *
 * 核心职责：
 * - 基于历史订单与持仓推断席位标的，恢复上次运行状态
 * - 对启用自动寻标的空席位执行运行时恢复寻标
 * - 提供席位绑定状态查询与席位标的代码收集工具
 */
import type { SeatSymbolSnapshotEntry, SymbolRegistry } from '../../types/seat.js';
import type {
  CollectSeatSymbolsParams,
  PreparedSeats,
  PrepareSeatsForRuntimeDeps,
  RuntimeRecoverySearchParams,
  SeatSnapshot,
  SeatSnapshotInput,
} from './types.js';
import { findBestWarrant } from '../../services/autoSymbolFinder/index.js';
import {
  buildFindBestWarrantInputFromPolicy,
  resolveDirectionalAutoSearchPolicy,
} from '../../services/autoSymbolFinder/policyResolver.js';
import { hasSeatSymbol } from '../../utils/seat/guards.js';
import {
  resolveNextSearchFailureState,
  resolveSeatOnStartup,
} from '../../services/autoSymbolManager/utils.js';
import { getLatestTradedSymbol } from '../../core/orderRecorder/orderOwnershipParser.js';
import { AUTO_SYMBOL_MAX_SEARCH_FAILURES_PER_DAY } from '../../constants/index.js';
import { getHKDateKey } from '../../utils/time/index.js';

/**
 * 基于订单与持仓生成席位快照，用于恢复运行时席位标的。
 *
 * @param input 包含 monitorConfig、positions、orders 的输入
 * @returns 席位快照，含监控标的双方向的解析结果条目
 */
function resolveSeatSnapshot(input: SeatSnapshotInput): SeatSnapshot {
  const { monitorConfig, positions, orders } = input;
  const entries: SeatSymbolSnapshotEntry[] = [];

  const candidateLongSymbol = getLatestTradedSymbol(
    orders,
    monitorConfig.orderOwnershipMapping,
    'LONG',
  );
  const candidateShortSymbol = getLatestTradedSymbol(
    orders,
    monitorConfig.orderOwnershipMapping,
    'SHORT',
  );
  const resolvedLongSymbol = resolveSeatOnStartup({
    autoSearchEnabled: monitorConfig.autoSearchConfig.autoSearchEnabled,
    candidateSymbol: candidateLongSymbol ?? null,
    configuredSymbol: monitorConfig.longSymbol,
    positions,
  });
  if (resolvedLongSymbol) {
    entries.push({
      baseInstrumentSymbol: monitorConfig.baseInstrumentSymbol,
      direction: 'LONG',
      symbol: resolvedLongSymbol,
    });
  }

  const resolvedShortSymbol = resolveSeatOnStartup({
    autoSearchEnabled: monitorConfig.autoSearchConfig.autoSearchEnabled,
    candidateSymbol: candidateShortSymbol ?? null,
    configuredSymbol: monitorConfig.shortSymbol,
    positions,
  });
  if (resolvedShortSymbol) {
    entries.push({
      baseInstrumentSymbol: monitorConfig.baseInstrumentSymbol,
      direction: 'SHORT',
      symbol: resolvedShortSymbol,
    });
  }

  return { entries };
}

/**
 * 获取指定监控标的和方向的已绑定席位标的代码。
 *
 * @param symbolRegistry 席位注册表
 * @param baseInstrumentSymbol 监控标的代码
 * @param direction 方向（LONG 或 SHORT）
 * @returns 席位已绑定 symbol 时返回标的代码，否则返回 null
 */
export function resolveBoundSeatSymbol(
  symbolRegistry: SymbolRegistry,
  _baseInstrumentSymbol: string,
  direction: 'LONG' | 'SHORT',
): string | null {
  const seatState = symbolRegistry.getSeatState(direction);
  return hasSeatSymbol(seatState) ? seatState.symbol : null;
}

/**
 * 收集当前监控标的已绑定席位的标的代码列表，用于订阅行情。
 *
 * @param params 包含 monitorConfig、symbolRegistry
 * @returns 已绑定席位的 baseInstrumentSymbol + direction + symbol 条目数组
 */
function collectSeatSymbols({
  monitorConfig,
  symbolRegistry,
}: CollectSeatSymbolsParams): ReadonlyArray<SeatSymbolSnapshotEntry> {
  const entries: SeatSymbolSnapshotEntry[] = [];

  const longSymbol = resolveBoundSeatSymbol(
    symbolRegistry,
    monitorConfig.baseInstrumentSymbol,
    'LONG',
  );
  if (longSymbol) {
    entries.push({
      baseInstrumentSymbol: monitorConfig.baseInstrumentSymbol,
      direction: 'LONG',
      symbol: longSymbol,
    });
  }

  const shortSymbol = resolveBoundSeatSymbol(
    symbolRegistry,
    monitorConfig.baseInstrumentSymbol,
    'SHORT',
  );
  if (shortSymbol) {
    entries.push({
      baseInstrumentSymbol: monitorConfig.baseInstrumentSymbol,
      direction: 'SHORT',
      symbol: shortSymbol,
    });
  }

  return entries;
}

/**
 * 恢复监控标的的双席位：
 * - 先恢复历史标的
 * - 对启用自动寻标的空席位执行寻标
 *
 * @param deps 依赖注入，包含 monitorConfig、symbolRegistry、positions、orders、marketDataClient、now、logger 等
 * @returns 已绑定席位的标的列表（seatSymbols），用于后续订阅行情
 */
export async function prepareSeatsForRuntime(
  deps: PrepareSeatsForRuntimeDeps,
): Promise<PreparedSeats> {
  const {
    monitorConfig,
    symbolRegistry,
    positions,
    orders,
    marketDataClient,
    now,
    logger,
    getTradingMinutesSinceOpen,
    isWithinMorningOpenProtection,
    warrantListCacheConfig,
  } = deps;
  const snapshot = resolveSeatSnapshot({
    monitorConfig,
    positions,
    orders,
  });
  const snapshotMap = new Map<string, string>();

  for (const entry of snapshot.entries) {
    snapshotMap.set(`${entry.baseInstrumentSymbol}:${entry.direction}`, entry.symbol);
  }

  /**
   * 用快照结果初始化席位状态。
   * 运行时恢复阶段只负责绑定 symbol，不在这里推进 ACTIVE。
   */
  function updateSeatOnRuntimeRecovery(
    _baseInstrumentSymbol: string,
    direction: 'LONG' | 'SHORT',
    symbol: string | null,
  ): void {
    symbolRegistry.updateSeatState(direction, {
      symbol,
      status: symbol ? 'ACTIVATING' : 'EMPTY',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: null,
      callPrice: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    });
  }

  const longKey = `${monitorConfig.baseInstrumentSymbol}:LONG`;
  const shortKey = `${monitorConfig.baseInstrumentSymbol}:SHORT`;
  updateSeatOnRuntimeRecovery(
    monitorConfig.baseInstrumentSymbol,
    'LONG',
    snapshotMap.get(longKey) ?? null,
  );

  updateSeatOnRuntimeRecovery(
    monitorConfig.baseInstrumentSymbol,
    'SHORT',
    snapshotMap.get(shortKey) ?? null,
  );

  let quoteContextPromise: ReturnType<typeof marketDataClient.getQuoteContext> | null = null;

  function getQuoteContext(): ReturnType<typeof marketDataClient.getQuoteContext> {
    quoteContextPromise ??= marketDataClient.getQuoteContext();
    return quoteContextPromise;
  }

  /**
   * 对空席位执行一次恢复寻标。
   * 该流程只负责把席位推进到 ACTIVATING，并记录寻标失败/冻结状态。
   */
  async function searchSeatSymbol({
    baseInstrumentSymbol,
    direction,
    autoSearchConfig,
    currentTime,
  }: RuntimeRecoverySearchParams): Promise<string | null> {
    const policy = resolveDirectionalAutoSearchPolicy({
      direction,
      autoSearchConfig,
      baseInstrumentSymbol,
      logPrefix: '[席位恢复] 缺少自动寻标阈值配置，跳过恢复寻标',
      logger,
    });
    if (policy === null) {
      return null;
    }

    const currentSeat = symbolRegistry.getSeatState(direction);
    const nowMs = currentTime.getTime();
    symbolRegistry.updateSeatState(direction, {
      symbol: null,
      status: 'SEARCHING',
      lastSwitchAt: currentSeat.lastSwitchAt ?? null,
      lastSearchAt: nowMs,
      lastSeatActivatedAt: currentSeat.lastSeatActivatedAt ?? null,
      callPrice: null,
      searchFailCountToday: currentSeat.searchFailCountToday,
      frozenTradingDayKey: currentSeat.frozenTradingDayKey,
    });
    const ctx = await getQuoteContext();
    const best = await findBestWarrant(
      buildFindBestWarrantInputFromPolicy({
        ctx,
        baseInstrumentSymbol,
        currentTime,
        policy,
        expiryMinMonths: autoSearchConfig.autoSearchExpiryMinMonths,
        logger,
        getTradingMinutesSinceOpen,
        ...(warrantListCacheConfig ? { cacheConfig: warrantListCacheConfig } : {}),
      }),
    );
    if (!best) {
      const updatedSeat = symbolRegistry.getSeatState(direction);
      const hkDateKey = getHKDateKey(currentTime);
      const { nextFailCount, frozenTradingDayKey, shouldFreeze } = resolveNextSearchFailureState({
        currentSeat: updatedSeat,
        hkDateKey,
        maxSearchFailuresPerDay: AUTO_SYMBOL_MAX_SEARCH_FAILURES_PER_DAY,
      });
      if (shouldFreeze) {
        logger.warn(
          `[席位恢复] ${baseInstrumentSymbol} ${direction} 当日寻标失败达 ${nextFailCount} 次，席位冻结`,
        );
      }

      symbolRegistry.updateSeatState(direction, {
        symbol: null,
        status: 'EMPTY',
        lastSwitchAt: updatedSeat.lastSwitchAt ?? null,
        lastSearchAt: nowMs,
        lastSeatActivatedAt: updatedSeat.lastSeatActivatedAt ?? null,
        callPrice: null,
        searchFailCountToday: nextFailCount,
        frozenTradingDayKey,
      });
      return null;
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
    return best.symbol;
  }

  /**
   * 恢复寻标异常时，把停留在 SEARCHING 的席位回退为空席位并累加失败次数。
   */
  function handleSearchException(
    baseInstrumentSymbol: string,
    direction: 'LONG' | 'SHORT',
    currentTime: Date,
  ): void {
    const stuckSeat = symbolRegistry.getSeatState(direction);
    if (stuckSeat.status !== 'SEARCHING') {
      return;
    }

    const hkDateKey = getHKDateKey(currentTime);
    const { nextFailCount, frozenTradingDayKey, shouldFreeze } = resolveNextSearchFailureState({
      currentSeat: stuckSeat,
      hkDateKey,
      maxSearchFailuresPerDay: AUTO_SYMBOL_MAX_SEARCH_FAILURES_PER_DAY,
    });
    if (shouldFreeze) {
      logger.warn(
        `[席位恢复] ${baseInstrumentSymbol} ${direction} 当日寻标失败达 ${nextFailCount} 次，席位冻结`,
      );
    }

    symbolRegistry.updateSeatState(direction, {
      symbol: null,
      status: 'EMPTY',
      lastSwitchAt: stuckSeat.lastSwitchAt ?? null,
      lastSearchAt: currentTime.getTime(),
      lastSeatActivatedAt: stuckSeat.lastSeatActivatedAt ?? null,
      callPrice: null,
      searchFailCountToday: nextFailCount,
      frozenTradingDayKey,
    });
  }

  /**
   * 判断恢复阶段是否应跳过某个空席位的寻标。
   * 已有 symbol 或仍处于开盘保护期时都不应触发恢复寻标。
   */
  function shouldSkipRuntimeRecoverySearch(
    seatState: ReturnType<SymbolRegistry['getSeatState']>,
    openDelayMinutes: number,
    currentTime: Date,
  ): boolean {
    if (hasSeatSymbol(seatState)) {
      return true;
    }

    if (openDelayMinutes > 0 && isWithinMorningOpenProtection(currentTime, openDelayMinutes)) {
      return true;
    }

    return false;
  }

  /**
   * 对单监控标的的双方向空席位执行恢复寻标。
   * static 模式或未启用 auto-search 时直接跳过。
   */
  async function trySearchEmptySeats(): Promise<void> {
    if (!monitorConfig.autoSearchConfig.autoSearchEnabled) {
      return;
    }

    const currentTime = now();
    for (const direction of ['LONG', 'SHORT'] as const) {
      const seatState = symbolRegistry.getSeatState(direction);
      const openDelayMinutes = monitorConfig.autoSearchConfig.autoSearchOpenDelayMinutes;
      if (shouldSkipRuntimeRecoverySearch(seatState, openDelayMinutes, currentTime)) {
        continue;
      }

      try {
        const symbol = await searchSeatSymbol({
          baseInstrumentSymbol: monitorConfig.baseInstrumentSymbol,
          direction,
          autoSearchConfig: monitorConfig.autoSearchConfig,
          currentTime,
        });
        if (symbol) {
          logger.info(
            `[席位恢复] ${monitorConfig.baseInstrumentSymbol} ${direction} 已进入激活阶段: ${symbol}`,
          );
        }
      } catch (err) {
        handleSearchException(monitorConfig.baseInstrumentSymbol, direction, currentTime);
        logger.error(
          `[席位恢复] ${monitorConfig.baseInstrumentSymbol} ${direction} 寻标异常: ${String(err)}`,
        );
      }
    }
  }

  await trySearchEmptySeats();

  return {
    seatSymbols: collectSeatSymbols({
      monitorConfig,
      symbolRegistry,
    }),
  };
}
