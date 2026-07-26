/**
 * 席位刷新任务处理
 *
 * 功能：
 * - 作为 seat activation barrier，在 ACTIVATING 阶段完成 quote admission 与风险缓存初始化
 * - 在执行时拉取行情后刷新订单、账户、浮亏与牛熊证信息
 * - 成功后推进到 ACTIVE，业务校验失败则回 EMPTY 并 bump version
 */
import { logger } from '../../../../utils/logger/index.js';
import { isSeatVersionMatch } from '../../../../utils/seat/guards.js';

import type { MarketDataClient } from '../../../../types/services.js';
import type { MonitorContext } from '../../../../types/state.js';
import type { SeatState } from '../../../../types/seat.js';
import type { RuntimeClock } from '../../../../types/runtime.js';
import type { QuoteSubscriptionRuntime } from '../../../quoteSubscriptionRuntime/types.js';
import type { MonitorTask } from '../../monitorTaskQueue/types.js';
import type {
  MonitorTaskDataMap,
  MonitorTaskStatus,
  RefreshHelpers,
  SeatRefreshTaskData,
} from '../types.js';

function logSeatRefreshSkipped(params: {
  readonly context: MonitorContext;
  readonly data: SeatRefreshTaskData;
  readonly reason: string;
}): void {
  const { context, data, reason } = params;
  const monitorSymbol = context.config.monitorSymbol;
  const currentSeat = context.symbolRegistry.getSeatState(data.direction);
  const currentSeatVersion = context.symbolRegistry.getSeatVersion(data.direction);
  logger.debug(
    `[SEAT_REFRESH skipped] monitorSymbol=${monitorSymbol} direction=${data.direction} taskSeatVersion=${data.seatVersion} currentSeatVersion=${currentSeatVersion} currentStatus=${currentSeat.status} currentSymbol=${currentSeat.symbol ?? 'null'} reason=${reason}`,
  );
}

function logSeatRefreshProcessed(params: {
  readonly data: SeatRefreshTaskData;
  readonly result: 'activated' | 'marked_empty';
  readonly reason?: string;
}): void {
  const { data, result, reason } = params;
  const reasonSuffix = reason ? ` reason=${reason}` : '';
  logger.debug(
    `[SEAT_REFRESH processed] direction=${data.direction} seatVersion=${data.seatVersion} previousSymbol=${data.previousSymbol ?? 'null'} nextSymbol=${data.nextSymbol} result=${result}${reasonSuffix}`,
  );
}

function setDirectionSymbolName(
  context: MonitorContext,
  direction: 'LONG' | 'SHORT',
  symbolName: string,
): void {
  if (direction === 'LONG') {
    context.longSymbolName = symbolName;
  } else {
    context.shortSymbolName = symbolName;
  }
}

/**
 * 收集席位刷新期间必须能归属的交易标的。
 * @param context 当前唯一 monitor 运行时上下文
 * @param data 席位刷新任务数据
 * @returns 相关交易标的集合
 */
function collectSeatRefreshRelatedTradingSymbols(
  context: MonitorContext,
  data: SeatRefreshTaskData,
): Set<string> {
  const symbols = new Set<string>([data.nextSymbol]);
  if (data.previousSymbol !== null) {
    symbols.add(data.previousSymbol);
  }

  const longSeat = context.symbolRegistry.getSeatState('LONG');
  const shortSeat = context.symbolRegistry.getSeatState('SHORT');
  if (longSeat.symbol !== null) {
    symbols.add(longSeat.symbol);
  }

  if (shortSeat.symbol !== null) {
    symbols.add(shortSeat.symbol);
  }

  symbols.delete(context.config.monitorSymbol);
  return symbols;
}

/**
 * 将指定监控标的的方向席位标记为空（刷新业务失败或数据无效时调用）。
 * 该函数只更新 seat truth；方向运行态清理由 ACTIVE 退场事件 owner 处理。
 *
 * @param direction 多空方向
 * @param reason 标记原因（用于日志）
 * @param context 任务上下文
 * @returns 无返回值
 */
function markSeatAsEmpty(
  direction: 'LONG' | 'SHORT',
  reason: string,
  context: MonitorContext,
  nowMs: number,
): void {
  const monitorSymbol = context.config.monitorSymbol;
  const currentSeat = context.symbolRegistry.getSeatState(direction);
  const nextState = {
    symbol: null,
    status: 'EMPTY',
    lastSwitchAt: nowMs,
    lastSearchAt: currentSeat.lastSearchAt ?? nowMs,
    lastSeatActivatedAt: null,
    callPrice: null,
    searchFailCountToday: currentSeat.searchFailCountToday,
    frozenTradingDayKey: currentSeat.frozenTradingDayKey,
  } as const;
  setDirectionSymbolName(context, direction, '');
  const { seatVersion: nextVersion } = context.symbolRegistry.updateSeatStateWithVersionBump(
    direction,
    nextState,
  );
  logger.error(`[自动换标] ${monitorSymbol} ${direction} 换标失败（v${nextVersion}）：${reason}`);
}

/**
 * 校验任务快照与当前席位是否仍一致，并返回当前席位状态。
 * 要求：seatVersion 匹配、状态为 ACTIVATING、symbol 与 nextSymbol 一致。
 *
 * @param context 监控上下文
 * @param data 席位刷新任务数据
 * @returns 快照仍有效时返回当前 seatState，否则返回 null
 */
function resolveActivatingSeatSnapshot(
  context: MonitorContext,
  data: SeatRefreshTaskData,
): (SeatState & { readonly status: 'ACTIVATING'; readonly symbol: string }) | null {
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

/**
 * 创建席位刷新任务处理器。
 * 在 seat 进入 ACTIVATING 后执行 admission、订单/风控缓存初始化与旧标的订单缓存收口；仅当全部成功时才把 seat 推进到 ACTIVE。
 *
 * @param deps 依赖注入，包含唯一 monitorContext、marketDataClient
 * @returns 处理 SEAT_REFRESH 任务的异步函数
 */
export function createSeatRefreshHandler({
  clock,
  monitorContext,
  marketDataClient,
  quoteSubscriptionRuntime,
}: {
  readonly clock: RuntimeClock;
  readonly monitorContext: MonitorContext;
  readonly marketDataClient: MarketDataClient;
  readonly quoteSubscriptionRuntime: Pick<
    QuoteSubscriptionRuntime,
    'retainSymbols' | 'waitForAdmission'
  >;
}): (
  task: MonitorTask<MonitorTaskDataMap, 'SEAT_REFRESH'>,
  helpers: RefreshHelpers,
) => Promise<MonitorTaskStatus> {
  return async function handleSeatRefresh(
    task: MonitorTask<MonitorTaskDataMap, 'SEAT_REFRESH'>,
    helpers: RefreshHelpers,
  ): Promise<MonitorTaskStatus> {
    const data: SeatRefreshTaskData = task.data;
    const context = monitorContext;

    const entrySeatState = resolveActivatingSeatSnapshot(context, data);
    if (!entrySeatState) {
      logSeatRefreshSkipped({
        context,
        data,
        reason: 'entry seat snapshot mismatch',
      });
      return 'skipped';
    }

    const isLong = data.direction === 'LONG';

    const callPriceValid =
      data.callPrice !== null &&
      data.callPrice !== undefined &&
      Number.isFinite(data.callPrice) &&
      data.callPrice > 0;

    if (!callPriceValid) {
      const reason = '未提供有效回收价(callPrice)，无法刷新牛熊证信息';
      markSeatAsEmpty(data.direction, reason, context, clock.now().getTime());
      logSeatRefreshProcessed({
        data,
        result: 'marked_empty',
        reason,
      });
      return 'processed';
    }

    let releaseSeatRefreshRetain: (() => void) | null = null;
    try {
      const quoteSymbols = [data.nextSymbol];
      if (data.previousSymbol && data.previousSymbol !== data.nextSymbol) {
        quoteSymbols.push(data.previousSymbol);
      }

      releaseSeatRefreshRetain = await quoteSubscriptionRuntime.retainSymbols({
        ownerKey: `SEAT_REFRESH_WAIT:${data.direction}:${data.seatVersion}`,
        reason: 'SEAT_REFRESH_WAIT',
        symbols: quoteSymbols,
      });
      await quoteSubscriptionRuntime.waitForAdmission(quoteSymbols);

      const executionQuotes = await marketDataClient.getQuotes(quoteSymbols);
      const nextExecutionQuote = executionQuotes.get(data.nextSymbol) ?? null;

      const allOrders = await helpers.ensureAllOrders();
      const preWriteSeatState = resolveActivatingSeatSnapshot(context, data);
      if (!preWriteSeatState) {
        logSeatRefreshSkipped({
          context,
          data,
          reason: 'seat snapshot changed before shared cache rebuild',
        });
        return 'skipped';
      }

      const relatedTradingSymbols = collectSeatRefreshRelatedTradingSymbols(context, data);
      for (const symbol of relatedTradingSymbols) {
        context.orderRecorder.validateRebuildSnapshot(symbol, allOrders);
      }

      context.dailyLossTracker.recalculateFromAllOrders(
        allOrders,
        context.config,
        clock.now(),
        undefined,
        relatedTradingSymbols,
      );

      await (isLong
        ? context.orderRecorder.refreshOrdersFromAllOrdersForLong(
            data.nextSymbol,
            allOrders,
            nextExecutionQuote,
          )
        : context.orderRecorder.refreshOrdersFromAllOrdersForShort(
            data.nextSymbol,
            allOrders,
            nextExecutionQuote,
          ));

      const seatStateAfterOrderRefresh = resolveActivatingSeatSnapshot(context, data);
      if (!seatStateAfterOrderRefresh) {
        logSeatRefreshSkipped({
          context,
          data,
          reason: 'seat snapshot changed during order refresh',
        });
        return 'skipped';
      }

      await helpers.refreshAccountCaches();

      const seatStateAfterAccountCacheRefresh = resolveActivatingSeatSnapshot(context, data);
      if (!seatStateAfterAccountCacheRefresh) {
        logSeatRefreshSkipped({
          context,
          data,
          reason: 'seat snapshot changed during account cache refresh',
        });
        return 'skipped';
      }

      const dailyLossOffset = context.dailyLossTracker.getLossOffset(isLong ? 'LONG' : 'SHORT');
      await context.riskChecker.refreshUnrealizedLossData(
        context.orderRecorder,
        data.nextSymbol,
        isLong,
        nextExecutionQuote,
        dailyLossOffset,
      );

      const latestSeatState = resolveActivatingSeatSnapshot(context, data);
      if (!latestSeatState) {
        logSeatRefreshSkipped({
          context,
          data,
          reason: 'seat snapshot changed during risk refresh',
        });
        return 'skipped';
      }

      if (data.previousSymbol && data.previousSymbol !== data.nextSymbol) {
        const previousExecutionQuote = executionQuotes.get(data.previousSymbol) ?? null;
        const existingSeat = context.symbolRegistry.resolveSeatBySymbol(data.previousSymbol);
        if (!existingSeat) {
          context.orderRecorder.clearBuyOrders(data.previousSymbol, isLong, previousExecutionQuote);
        }
      }

      const warrantRefreshResult = context.riskChecker.setWarrantInfoFromCallPrice(
        data.nextSymbol,
        data.callPrice,
        isLong,
        nextExecutionQuote?.name ?? data.symbolName,
      );
      if (warrantRefreshResult.status === 'error') {
        const reason = `设置牛熊证信息失败：${warrantRefreshResult.reason}`;
        markSeatAsEmpty(data.direction, reason, context, clock.now().getTime());
        logSeatRefreshProcessed({
          data,
          result: 'marked_empty',
          reason,
        });
        return 'processed';
      }

      setDirectionSymbolName(
        context,
        data.direction,
        nextExecutionQuote?.name ?? data.symbolName ?? data.nextSymbol,
      );

      context.symbolRegistry.updateSeatState(data.direction, {
        ...latestSeatState,
        status: 'ACTIVE',
        lastSeatActivatedAt: clock.now().getTime(),
        callPrice: data.callPrice,
      });

      logSeatRefreshProcessed({
        data,
        result: 'activated',
      });

      return 'processed';
    } finally {
      releaseSeatRefreshRetain?.();
    }
  };
}
