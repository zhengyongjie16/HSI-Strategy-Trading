/**
 * 交易日状态重建模块
 *
 * 核心职责：
 * - 在开盘重建阶段，基于最新的行情和订单数据重建所有运行时状态
 *
 * 重建流程（按顺序执行）：
 * 1. 同步单实例 monitorContext 的席位快照和行情数据
 * 2. 预热交易日历快照（统一回退到 fallback lookback 窗口）
 * 3. 重建牛熊证风险缓存（收回价等关键风控数据）
 * 4. 重建浮亏缓存（结合当前持仓与当日已实现亏损偏移量）
 * 5. 恢复订单追踪状态
 * 6. 展示账户和持仓信息
 */
import { hasSeatSymbol } from '../../utils/seat/guards.js';
import type { LastState, StrategyRuntime } from '../../types/state.js';
import type { Quote } from '../../types/quote.js';
import type { SymbolRegistry } from '../../types/seat.js';
import type { MarketDataClient } from '../../types/services.js';
import type { DailyLossTracker } from '../../types/risk.js';
import { resolveStrategyRuntimeSnapshot } from '../../utils/utils.js';
import type { RebuildTradingDayStateDeps, RebuildTradingDayStateParams } from './types.js';
import { prewarmTradingCalendarSnapshotForRebuild } from './tradingCalendarPrewarmer.js';
import { formatError } from '../../utils/error/index.js';

function syncStrategyRuntimeQuotes(
  monitorContext: StrategyRuntime,
  symbolRegistry: SymbolRegistry,
  quotesMap: ReadonlyMap<string, Quote | null>,
): void {
  const runtimeSnapshot = resolveStrategyRuntimeSnapshot(
    monitorContext.config.baseInstrumentSymbol,
    symbolRegistry,
    quotesMap,
  );
  monitorContext.seatState = runtimeSnapshot.seatState;
  monitorContext.seatVersion = runtimeSnapshot.seatVersion;
  monitorContext.longSymbolName = runtimeSnapshot.longSymbolName;
  monitorContext.shortSymbolName = runtimeSnapshot.shortSymbolName;
  monitorContext.baseInstrumentName = runtimeSnapshot.baseInstrumentName;
}

async function refreshSeatWarrantInfo(
  marketDataClient: MarketDataClient,
  monitorContext: StrategyRuntime,
  symbol: string | null,
  quote: Quote | null,
  isLongSymbol: boolean,
  callPriceFromSeat: number | null,
): Promise<void> {
  if (!symbol) {
    return;
  }

  const symbolName = quote?.name ?? null;
  if (callPriceFromSeat !== null && Number.isFinite(callPriceFromSeat) && callPriceFromSeat > 0) {
    const result = monitorContext.riskChecker.setWarrantInfoFromCallPrice(
      symbol,
      callPriceFromSeat,
      isLongSymbol,
      symbolName,
    );
    if (result.status === 'error') {
      throw new Error(result.reason);
    }

    return;
  }

  const result = await monitorContext.riskChecker.refreshWarrantInfoForSymbol(
    marketDataClient,
    symbol,
    isLongSymbol,
    symbolName,
  );
  if (result.status === 'error' || result.status === 'skipped') {
    const reason = result.status === 'error' ? result.reason : '未提供行情客户端';
    throw new Error(reason);
  }
}

async function rebuildWarrantRiskCache(
  marketDataClient: MarketDataClient,
  monitorContext: StrategyRuntime,
  quotesMap: ReadonlyMap<string, Quote | null>,
): Promise<void> {
  const longSeatState = monitorContext.symbolRegistry.getSeatState('LONG');
  const shortSeatState = monitorContext.symbolRegistry.getSeatState('SHORT');
  await refreshSeatWarrantInfo(
    marketDataClient,
    monitorContext,
    hasSeatSymbol(longSeatState) ? longSeatState.symbol : null,
    hasSeatSymbol(longSeatState) ? (quotesMap.get(longSeatState.symbol) ?? null) : null,
    true,
    hasSeatSymbol(longSeatState) ? (longSeatState.callPrice ?? null) : null,
  );

  await refreshSeatWarrantInfo(
    marketDataClient,
    monitorContext,
    hasSeatSymbol(shortSeatState) ? shortSeatState.symbol : null,
    hasSeatSymbol(shortSeatState) ? (quotesMap.get(shortSeatState.symbol) ?? null) : null,
    false,
    hasSeatSymbol(shortSeatState) ? (shortSeatState.callPrice ?? null) : null,
  );
}

async function rebuildUnrealizedLossCache(
  monitorContext: StrategyRuntime,
  lastState: LastState,
  dailyLossTracker: DailyLossTracker,
  quotesMap: ReadonlyMap<string, Quote | null>,
): Promise<void> {
  const longSeatState = monitorContext.symbolRegistry.getSeatState('LONG');
  const shortSeatState = monitorContext.symbolRegistry.getSeatState('SHORT');
  if (hasSeatSymbol(longSeatState)) {
    const dailyLossOffset = dailyLossTracker.getLossOffset('LONG');
    await monitorContext.riskChecker.refreshUnrealizedLossData(
      longSeatState.symbol,
      lastState.positionCache.get(longSeatState.symbol),
      true,
      quotesMap.get(longSeatState.symbol) ?? null,
      dailyLossOffset,
    );
  }

  if (hasSeatSymbol(shortSeatState)) {
    const dailyLossOffset = dailyLossTracker.getLossOffset('SHORT');
    await monitorContext.riskChecker.refreshUnrealizedLossData(
      shortSeatState.symbol,
      lastState.positionCache.get(shortSeatState.symbol),
      false,
      quotesMap.get(shortSeatState.symbol) ?? null,
      dailyLossOffset,
    );
  }
}

function activateRebuiltSeats(monitorContext: StrategyRuntime, nowMs: number): void {
  for (const direction of ['LONG', 'SHORT'] as const) {
    const seatState = monitorContext.symbolRegistry.getSeatState(direction);
    if (!hasSeatSymbol(seatState)) {
      continue;
    }

    monitorContext.symbolRegistry.updateSeatState(direction, {
      ...seatState,
      status: 'ACTIVE',
      lastSeatActivatedAt: nowMs,
    });
  }
}

export function createRebuildTradingDayState(
  deps: RebuildTradingDayStateDeps,
): (params: RebuildTradingDayStateParams) => Promise<void> {
  const {
    marketDataClient,
    trader,
    lastState,
    symbolRegistry,
    monitorContext,
    dailyLossTracker,
    displayAccountAndPositions,
  } = deps;

  return async function rebuildTradingDayState(
    params: RebuildTradingDayStateParams,
  ): Promise<void> {
    const { allOrders, quotesMap, now = new Date() } = params;
    syncStrategyRuntimeQuotes(monitorContext, symbolRegistry, quotesMap);
    try {
      await prewarmTradingCalendarSnapshotForRebuild({
        marketDataClient,
        lastState,
        monitorContext,
        now,
      });
      await rebuildWarrantRiskCache(marketDataClient, monitorContext, quotesMap);
      await rebuildUnrealizedLossCache(monitorContext, lastState, dailyLossTracker, quotesMap);
      activateRebuiltSeats(monitorContext, now.getTime());
      syncStrategyRuntimeQuotes(monitorContext, symbolRegistry, quotesMap);
      await trader.recoverOrderTrackingFromSnapshot(allOrders);
      await displayAccountAndPositions({ lastState, quotesMap });
    } catch (err) {
      throw new Error(`[Lifecycle] 重建交易日状态失败: ${formatError(err)}`, { cause: err });
    }
  };
}
