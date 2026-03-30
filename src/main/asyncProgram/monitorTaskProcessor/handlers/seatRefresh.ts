/**
 * 席位刷新任务处理
 *
 * 功能：
 * - 作为 seat activation barrier，在 ACTIVATING 阶段完成 quote admission 与风险缓存初始化
 * - 在执行时拉取行情后刷新牛熊证信息与持仓缓存
 * - 成功后推进到 ACTIVE，失败则回 EMPTY 并 bump version
 */
import { logger } from '../../../../utils/logger/index.js';
import { isSeatVersionMatch } from '../../../../utils/seat/guards.js';

import type { LastState } from '../../../../types/state.js';
import type { MarketDataClient } from '../../../../types/services.js';
import type { MonitorTask } from '../../monitorTaskQueue/types.js';
import type {
  MonitorTaskContext,
  MonitorTaskDataMap,
  MonitorTaskStatus,
  RefreshHelpers,
  SeatRefreshTaskData,
} from '../types.js';

export function createSeatRefreshHandler({
  baseInstrumentSymbol,
  getContextOrSkip,
  clearMonitorDirectionQueues,
  marketDataClient,
  lastState,
}: {
  readonly baseInstrumentSymbol: string;
  readonly getContextOrSkip: () => MonitorTaskContext | null;
  readonly clearMonitorDirectionQueues: (direction: 'LONG' | 'SHORT') => void;
  readonly marketDataClient: MarketDataClient;
  readonly lastState: LastState;
}): (
  task: MonitorTask<MonitorTaskDataMap, 'SEAT_REFRESH'>,
  helpers: RefreshHelpers,
) => Promise<MonitorTaskStatus> {
  function markSeatAsEmpty(
    targetMonitorSymbol: string,
    direction: 'LONG' | 'SHORT',
    reason: string,
    context: MonitorTaskContext | null,
  ): void {
    if (!context) {
      return;
    }

    if (direction === 'LONG') {
      context.riskChecker.clearLongWarrantInfo();
    } else {
      context.riskChecker.clearShortWarrantInfo();
    }

    const nextVersion = context.symbolRegistry.bumpSeatVersion(direction);
    const nextState = {
      symbol: null,
      status: 'EMPTY',
      lastSwitchAt: Date.now(),
      lastSearchAt: null,
      lastSeatActivatedAt: null,
      callPrice: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    } as const;
    context.symbolRegistry.updateSeatState(direction, nextState);
    clearMonitorDirectionQueues(direction);
    logger.error(
      `[自动换标] ${targetMonitorSymbol} ${direction} 换标失败（v${nextVersion}）：${reason}`,
    );
  }

  function resolveActivatingSeatSnapshot(
    context: MonitorTaskContext,
    data: SeatRefreshTaskData,
  ): ReturnType<MonitorTaskContext['symbolRegistry']['getSeatState']> | null {
    const seatState = context.symbolRegistry.getSeatState(data.direction);
    const seatVersion = context.symbolRegistry.getSeatVersion(data.direction);
    if (!isSeatVersionMatch(data.seatVersion, seatVersion)) {
      return null;
    }

    if (seatState.status !== 'ACTIVATING' || seatState.symbol !== data.nextSymbol) {
      return null;
    }

    return seatState;
  }

  return async function handleSeatRefresh(
    task: MonitorTask<MonitorTaskDataMap, 'SEAT_REFRESH'>,
    helpers: RefreshHelpers,
  ): Promise<MonitorTaskStatus> {
    const data: SeatRefreshTaskData = task.data;
    const context = getContextOrSkip();
    if (!context) {
      return 'skipped';
    }

    const entrySeatState = resolveActivatingSeatSnapshot(context, data);
    if (!entrySeatState) {
      return 'skipped';
    }

    const isLong = data.direction === 'LONG';
    if (isLong) {
      context.riskChecker.clearLongWarrantInfo();
    } else {
      context.riskChecker.clearShortWarrantInfo();
    }

    const callPriceValid =
      data.callPrice !== null &&
      data.callPrice !== undefined &&
      Number.isFinite(data.callPrice) &&
      data.callPrice > 0;

    if (!callPriceValid) {
      markSeatAsEmpty(
        baseInstrumentSymbol,
        data.direction,
        '未提供有效回收价(callPrice)，无法刷新牛熊证信息',
        context,
      );
      return 'processed';
    }

    try {
      const quoteSymbols = [data.nextSymbol];
      if (data.previousSymbol && data.previousSymbol !== data.nextSymbol) {
        quoteSymbols.push(data.previousSymbol);
      }

      await marketDataClient.subscribeSymbols(quoteSymbols);
      const executionQuotes = await marketDataClient.getQuotes(quoteSymbols);
      const nextExecutionQuote = executionQuotes.get(data.nextSymbol) ?? null;

      await helpers.refreshAccountCaches();
      const dailyLossOffset = context.dailyLossTracker.getLossOffset(isLong ? 'LONG' : 'SHORT');
      await context.riskChecker.refreshUnrealizedLossData(
        data.nextSymbol,
        lastState.positionCache.get(data.nextSymbol),
        isLong,
        nextExecutionQuote,
        dailyLossOffset,
      );

      const warrantRefreshResult = context.riskChecker.setWarrantInfoFromCallPrice(
        data.nextSymbol,
        data.callPrice,
        isLong,
        data.symbolName,
      );
      if (warrantRefreshResult.status === 'error') {
        markSeatAsEmpty(
          baseInstrumentSymbol,
          data.direction,
          `设置牛熊证信息失败：${warrantRefreshResult.reason}`,
          context,
        );
        return 'processed';
      }

      const latestSeatState = resolveActivatingSeatSnapshot(context, data);
      if (!latestSeatState) {
        return 'skipped';
      }

      context.symbolRegistry.updateSeatState(data.direction, {
        ...latestSeatState,
        status: 'ACTIVE',
        lastSeatActivatedAt: Date.now(),
        callPrice: data.callPrice,
      });

      return 'processed';
    } catch (error) {
      markSeatAsEmpty(
        baseInstrumentSymbol,
        data.direction,
        error instanceof Error ? error.message : String(error),
        context,
      );
      return 'processed';
    }
  };
}
