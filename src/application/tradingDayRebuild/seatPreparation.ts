/**
 * 运行时席位恢复模块
 *
 * 职责：基于历史订单与持仓恢复标的，并按启动准入调用独立 StartupSeatSearch 补齐空席位。
 * 搜索状态迁移、失败计数与冻结政策只由启动寻标 owner 管理；恢复链路保留异常重试时机。
 */
import type { PrepareSeatsForRuntimeDeps } from './types.js';
import { resolveSeatOnStartup } from '../../domain/seat/seatPolicy.js';
import { getLatestTradedSymbol } from '../../domain/order/orderOwnership.js';

/** 恢复历史席位后按启动门禁补席；异步结果持续使用原快照授权，不捕获或重分类搜索异常。 */
export async function prepareSeatsForRuntime(deps: PrepareSeatsForRuntimeDeps): Promise<void> {
  const {
    tradingConfig,
    symbolRegistry,
    positions,
    orders,
    startupSeatSearch,
    canContinue,
    now,
    resolveCanAutoSearchNow,
  } = deps;
  const monitorConfig = tradingConfig.monitor;
  const latestTradeFacts = orders.map(({ stockName, symbol, executionStatus, updatedAt }) =>
    Object.freeze({ stockName, symbol, executionStatus, updatedAt }),
  );

  function updateSeatOnRuntimeRecovery(direction: 'LONG' | 'SHORT'): void {
    const currentSeat = symbolRegistry.getSeatState(direction);
    const symbol = resolveSeatOnStartup({
      autoSearchEnabled: monitorConfig.autoSearchConfig.autoSearchEnabled,
      candidateSymbol:
        getLatestTradedSymbol(latestTradeFacts, monitorConfig.orderOwnershipMapping, direction) ??
        null,
      configuredSymbol: direction === 'LONG' ? monitorConfig.longSymbol : monitorConfig.shortSymbol,
      positions,
    });
    symbolRegistry.updateSeatState(direction, {
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: null,
      callPrice: null,
      ...(symbol === null
        ? {
            symbol: null,
            status: 'EMPTY',
            searchFailCountToday: currentSeat.searchFailCountToday,
            frozenTradingDayKey: currentSeat.frozenTradingDayKey,
          }
        : {
            symbol,
            status: 'ACTIVATING',
            searchFailCountToday: 0,
            frozenTradingDayKey: null,
          }),
    });
  }

  if (!canContinue()) return;

  updateSeatOnRuntimeRecovery('LONG');
  updateSeatOnRuntimeRecovery('SHORT');

  const currentTime = now();
  if (
    !canContinue() ||
    !monitorConfig.autoSearchConfig.autoSearchEnabled ||
    !resolveCanAutoSearchNow({
      currentTime,
      openDelayMinutes: monitorConfig.autoSearchConfig.autoSearchOpenDelayMinutes,
    })
  ) {
    return;
  }

  for (const direction of ['LONG', 'SHORT'] as const) {
    if (!canContinue()) return;

    await startupSeatSearch.searchSeat({ direction, currentTime, canContinue });
  }
}
