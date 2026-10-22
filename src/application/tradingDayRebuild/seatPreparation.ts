/**
 * 运行时席位恢复模块
 *
 * 职责：基于历史订单与持仓解析候选，完成当次交易状态准入后同步发布两方向，再按原门禁补席。
 * 搜索状态迁移、失败计数与冻结政策只由 StartupSeatSearch 管理；恢复链路保留异常重试时机。
 */
import type { PrepareSeatsForRuntimeDeps } from './types.js';
import { resolveStartupSeatCandidate } from '../../domain/seat/seatPolicy.js';
import { getLatestTradedSymbol } from '../../domain/order/orderOwnership.js';

/** 完整准备并校验后再发布席位；所有异步结果沿用原快照授权，不捕获或重分类异常。 */
export async function prepareSeatsForRuntime(deps: PrepareSeatsForRuntimeDeps): Promise<void> {
  const {
    tradingConfig,
    symbolRegistry,
    positions,
    orders,
    marketDataClient,
    logger,
    startupSeatSearch,
    canContinue,
    now,
    resolveCanAutoSearchNow,
  } = deps;
  if (!canContinue()) return;

  const monitorConfig = tradingConfig.monitor;
  const autoSearchEnabled = monitorConfig.autoSearchConfig.autoSearchEnabled;
  const latestTradeFacts = orders.map(({ stockName, symbol, executionStatus, updatedAt }) =>
    Object.freeze({ stockName, symbol, executionStatus, updatedAt }),
  );
  const candidates = (['LONG', 'SHORT'] as const).map((direction) => ({
    direction,
    symbol: resolveStartupSeatCandidate({
      autoSearchEnabled,
      candidateSymbol:
        getLatestTradedSymbol(latestTradeFacts, monitorConfig.orderOwnershipMapping, direction) ??
        null,
      configuredSymbol: direction === 'LONG' ? monitorConfig.longSymbol : monitorConfig.shortSymbol,
      positions,
    }),
  }));
  const candidateSymbols = [
    ...new Set(candidates.flatMap(({ symbol }) => (symbol === null ? [] : [symbol]))),
  ];
  const statuses =
    autoSearchEnabled && candidateSymbols.length > 0
      ? await marketDataClient.getSecurityTradingStatuses(candidateSymbols)
      : null;
  const preparedSeats = candidates.map(({ direction, symbol }) => {
    const tradingStatus = !autoSearchEnabled || symbol === null ? null : statuses?.get(symbol);
    // adapter 已完整验证批次；此处只断言内部端口未丢失候选，不重复维护状态事实。
    // 必须在授权检查及任一方向发布前完成所有取值，损坏事实不得因授权失效被吞掉。
    if (tradingStatus === undefined) {
      throw new TypeError(`[席位恢复] 交易状态端口缺少候选: ${symbol}`);
    }

    const restoredSymbol = tradingStatus !== null && tradingStatus !== 'NORMAL' ? null : symbol;
    const currentSeat = symbolRegistry.getSeatState(direction);
    return {
      direction,
      candidateSymbol: symbol,
      tradingStatus,
      state: {
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        callPrice: null,
        ...(restoredSymbol === null
          ? {
              symbol: null,
              status: 'EMPTY' as const,
              searchFailCountToday: currentSeat.searchFailCountToday,
              frozenTradingDayKey: currentSeat.frozenTradingDayKey,
            }
          : {
              symbol: restoredSymbol,
              status: 'ACTIVATING' as const,
              searchFailCountToday: 0,
              frozenTradingDayKey: null,
            }),
      },
    };
  });

  if (!canContinue()) return;

  // 复核原授权后不再 await，避免整批状态未就绪时出现单方向提前发布。
  for (const { direction, candidateSymbol, tradingStatus, state } of preparedSeats) {
    if (candidateSymbol !== null && tradingStatus !== null && tradingStatus !== 'NORMAL') {
      logger.warn(
        `[席位恢复] 监控 ${monitorConfig.monitorSymbol} 方向 ${direction} 拒绝历史候选 ${candidateSymbol}，交易状态 ${tradingStatus}`,
      );
    }

    symbolRegistry.updateSeatState(direction, state);
  }

  const currentTime = now();
  if (
    !canContinue() ||
    !autoSearchEnabled ||
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
