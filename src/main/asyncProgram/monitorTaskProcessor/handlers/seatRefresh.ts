/**
 * 席位刷新任务处理
 *
 * 功能：
 * - 作为 seat activation barrier，在 ACTIVATING 阶段完成 quote admission 与风险缓存初始化
 * - 在执行时拉取行情后刷新订单、账户、浮亏与牛熊证信息
 * - 成功后推进到 ACTIVE，业务校验失败则回 EMPTY 并 bump version
 *
 * 清理语义：
 * - retain 的释放始终完整 await；主体与清理的错误按 fatal/外部分类收口
 * - 任何内部错误（主体或清理）保留原始身份进入 fatal，双外部 API 失败聚合后仍保持外部分类
 * - 次级诊断的格式化与日志为 best-effort：其自身失败不得覆盖已收口的错误
 */
import { logger } from '../../../../utils/logger/index.js';
import {
  createExternalApiAggregateRequestError,
  isExternalApiRequestError,
} from '../../../../utils/apiFailure/index.js';
import { formatError } from '../../../../utils/error/index.js';
import { exactCompare } from '../../../../utils/numeric/exact.js';
import { isSeatVersionMatch } from '../../../../utils/seat/guards.js';

import type { AccountPositionSnapshot } from '../../../../types/accountPosition.js';
import type { MarketDataClient } from '../../../../types/services.js';
import { resolveOrderOwnership } from '../../../../domain/order/orderOwnership.js';
import type { MonitorContext } from '../../../../types/state.js';
import type { SeatState } from '../../../../types/seat.js';
import type { RuntimeClock } from '../../../../types/runtime.js';
import type { QuoteSubscriptionRuntime } from '../../../quoteSubscriptionRuntime/types.js';
import type { MonitorTask } from '../../monitorTaskQueue/types.js';
import type { createRefreshHelpers } from '../helpers/refreshHelpers.js';
import type { MonitorTaskDataMap, MonitorTaskStatus, SeatRefreshTaskData } from '../types.js';

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

/**
 * best-effort 记录次级诊断。
 *
 * 为什么：诊断值可能带抛错的 message getter，logger 也可能自身抛错；两者都发生在 finally 中，
 * 一旦逸出就会替换在途的主体错误，因此这里必须完整隔离格式化与日志的失败。
 *
 * @param message 诊断日志消息
 * @param diagnostic 次级诊断值
 * @returns 无返回值
 */
function logSecondaryDiagnosticBestEffort(message: string, diagnostic: unknown): void {
  try {
    logger.error(message, formatError(diagnostic));
  } catch {
    // 诊断失败只允许丢弃，不能覆盖已选定的主体错误
  }
}

/**
 * 收口席位刷新主体失败与 releaseRetain 清理失败的错误归属。
 *
 * 为什么：finally 中的清理错误不能覆盖主体错误。内部错误必须保持 fatal 分类与原始身份，
 * 外部失败只有在主体与清理同为外部 API 失败时才允许聚合后继续保持外部分类；
 * 主体内部错误存在时，清理错误只作为次级诊断记录，且该诊断自身失败不得覆盖主体错误。
 *
 * @param params 主体失败标记、主体错误与清理错误
 * @returns 无返回值；仅当清理错误应成为最终错误时抛出
 */
function resolveRefreshReleaseFailure(params: {
  readonly hasBodyFailure: boolean;
  readonly bodyFailure: unknown;
  readonly releaseFailure: unknown;
}): void {
  const { hasBodyFailure, bodyFailure, releaseFailure } = params;

  if (hasBodyFailure && !isExternalApiRequestError(bodyFailure)) {
    logSecondaryDiagnosticBestEffort(
      '[SEAT_REFRESH] releaseRetain 失败（主体已有内部错误，保留主体 fatal 身份）',
      releaseFailure,
    );
    return;
  }

  if (isExternalApiRequestError(releaseFailure)) {
    if (hasBodyFailure && isExternalApiRequestError(bodyFailure)) {
      throw createExternalApiAggregateRequestError({
        operation: 'SEAT_REFRESH.releaseRetain',
        attempts: 1,
        causes: [bodyFailure, releaseFailure],
      });
    }

    throw releaseFailure;
  }

  if (hasBodyFailure) {
    logSecondaryDiagnosticBestEffort(
      '[SEAT_REFRESH] 主体外部 API 失败后 releaseRetain 内部失败（保留清理 fatal 身份）',
      bodyFailure,
    );
  }

  throw releaseFailure;
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
  snapshot,
  quoteSubscriptionRuntime,
  canContinue,
}: {
  readonly canContinue: () => boolean;
  readonly clock: RuntimeClock;
  readonly monitorContext: MonitorContext;
  readonly marketDataClient: MarketDataClient;
  readonly snapshot: Pick<AccountPositionSnapshot, 'getView' | 'isCurrent'>;
  readonly quoteSubscriptionRuntime: Pick<
    QuoteSubscriptionRuntime,
    'retainSymbols' | 'waitForAdmission' | 'releaseRetain' | 'reconcilePositionHoldFromCurrentTruth'
  >;
}): (
  task: MonitorTask<MonitorTaskDataMap, 'SEAT_REFRESH'>,
  helpers: ReturnType<typeof createRefreshHelpers>,
) => Promise<MonitorTaskStatus> {
  return async function handleSeatRefresh(
    task: MonitorTask<MonitorTaskDataMap, 'SEAT_REFRESH'>,
    helpers: ReturnType<typeof createRefreshHelpers>,
  ): Promise<MonitorTaskStatus> {
    if (!canContinue()) return 'skipped';

    const data: SeatRefreshTaskData = task.data;
    const context = monitorContext;
    if (!Number.isSafeInteger(data.dayEpoch) || data.dayEpoch < 0) {
      throw new TypeError('[SEAT_REFRESH] 入队 dayEpoch 必须是非负安全整数');
    }

    const activationDayEpoch = data.dayEpoch;
    const canContinueActivation = (): boolean =>
      canContinue() &&
      snapshot.getView().token.dayEpoch === activationDayEpoch &&
      resolveActivatingSeatSnapshot(context, data) !== null;
    if (!canContinueActivation()) return 'skipped';

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

    const callPrice = data.callPrice;
    if (callPrice !== null && callPrice !== undefined && typeof callPrice !== 'string') {
      throw new TypeError('[SEAT_REFRESH] callPrice 必须是金融文本');
    }

    const callPriceValid = typeof callPrice === 'string' && exactCompare(callPrice, '0') > 0;

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

    const retainOwner = {
      ownerKey: `SEAT_REFRESH_WAIT:${data.direction}:${data.seatVersion}`,
      reason: 'SEAT_REFRESH_WAIT' as const,
    };
    let hasBodyFailure = false;
    let bodyFailure: unknown = null;
    try {
      const quoteSymbols = [data.nextSymbol];
      if (data.previousSymbol && data.previousSymbol !== data.nextSymbol) {
        quoteSymbols.push(data.previousSymbol);
      }

      await quoteSubscriptionRuntime.retainSymbols({
        ...retainOwner,
        symbols: quoteSymbols,
      });

      if (!canContinueActivation()) return 'skipped';

      await quoteSubscriptionRuntime.waitForAdmission(quoteSymbols);
      if (!canContinueActivation()) return 'skipped';

      const executionQuotes = await marketDataClient.getQuotes(quoteSymbols);
      if (!canContinueActivation()) return 'skipped';

      const nextExecutionQuote = executionQuotes.get(data.nextSymbol) ?? null;

      // 只追赶尚未提交的订单输入；普通 revision 更新不会使订单读票失效。
      while (canContinueActivation()) {
        const orderSourceToken = { ...snapshot.getView().token };
        if (orderSourceToken.dayEpoch !== activationDayEpoch) return 'skipped';

        const capturedSeats = (['LONG', 'SHORT'] as const).map((direction) => ({
          direction,
          symbol: context.symbolRegistry.getSeatState(direction).symbol,
          status: context.symbolRegistry.getSeatState(direction).status,
          version: context.symbolRegistry.getSeatVersion(direction),
        }));
        const areCapturedSeatsCurrent = (): boolean =>
          capturedSeats.every(({ direction, symbol, status, version }) => {
            const currentSeat = context.symbolRegistry.getSeatState(direction);
            return (
              isSeatVersionMatch(version, context.symbolRegistry.getSeatVersion(direction)) &&
              currentSeat.symbol === symbol &&
              currentSeat.status === status
            );
          });
        const isOrderSourceCurrent = (): boolean =>
          canContinueActivation() &&
          areCapturedSeatsCurrent() &&
          snapshot.isCurrent(orderSourceToken, { account: false, positions: false });

        // epoch/generation 与全部席位身份在第一次订单 await 前固定。
        const allOrders = await helpers.ensureAllOrders();
        if (!canContinueActivation()) return 'skipped';

        if (!isOrderSourceCurrent()) continue;

        const relatedTradingSymbols = collectSeatRefreshRelatedTradingSymbols(context, data);
        const directionBySymbol = new Map<string, boolean>();
        for (const { direction, symbol } of capturedSeats) {
          if (symbol === null || symbol === context.config.monitorSymbol) continue;

          const oldDirection = directionBySymbol.get(symbol);
          const isLongSymbol = direction === 'LONG';
          if (oldDirection !== undefined && oldDirection !== isLongSymbol) {
            throw new Error(`[SEAT_REFRESH] LONG/SHORT 标的归属冲突: ${symbol}`);
          }

          directionBySymbol.set(symbol, isLongSymbol);
        }

        if (
          data.previousSymbol !== null &&
          !directionBySymbol.has(data.previousSymbol) &&
          data.previousSymbol !== context.config.monitorSymbol
        ) {
          directionBySymbol.set(data.previousSymbol, isLong);
        }

        for (const symbol of relatedTradingSymbols) {
          context.orderRecorder.validateRebuildSnapshot(symbol, allOrders);
        }

        for (const order of allOrders) {
          if (!relatedTradingSymbols.has(order.symbol)) continue;

          if (order.executedQuantity === 0 && order.executionPhase === 'TERMINAL') continue;

          const ownership = resolveOrderOwnership(order, context.config);
          const expectedDirection = directionBySymbol.get(order.symbol);
          if (
            ownership?.monitorSymbol !== context.config.monitorSymbol ||
            expectedDirection === undefined ||
            (ownership.direction === 'LONG') !== expectedDirection
          ) {
            throw new Error(`[SEAT_REFRESH] 订单归属与 captured 席位冲突: ${order.orderId}`);
          }
        }

        const targets = [...directionBySymbol].map(([symbol, isLongSymbol]) => ({
          symbol,
          isLongSymbol,
        }));
        const preparedDailyLoss = context.dailyLossTracker.prepareRecalculationFromAllOrders(
          allOrders,
          context.config,
          clock.now(),
          undefined,
          relatedTradingSymbols,
        );
        const isPreparedOrderSourceCurrent = (): boolean =>
          isOrderSourceCurrent() && preparedDailyLoss.isCurrent();
        if (!canContinueActivation()) return 'skipped';

        if (!isPreparedOrderSourceCurrent()) continue;

        // 本实例 Daily 完整无写预检后，原 token/全部席位/候选共同授权同步 O→Daily 发布；中间无 await。
        const commit = context.orderRecorder.commitRebuildSnapshot(
          targets,
          allOrders,
          isPreparedOrderSourceCurrent,
          'ACTIVATION',
        );
        if (commit.status === 'ABORTED') return 'skipped';

        context.dailyLossTracker.publishRecalculation(preparedDailyLoss);
        break;
      }

      if (!canContinueActivation()) return 'skipped';

      const handle = helpers.requestAccountPositionRefresh(activationDayEpoch);
      const receipt = await handle.result.finally(handle.cancel);
      if (receipt.status === 'ABORTED' || !canContinueActivation()) return 'skipped';

      // O/Daily 已合法提交，不再回到订单重建；新事实由同一订单 owner 更新经济投影。
      // 后置准备只追赶当前成对 view，字段不足时补读，绝不以新票重新授权旧 allOrders。
      while (canContinueActivation()) {
        const currentView = snapshot.getView();
        const isReceiptCurrent = (): boolean =>
          canContinueActivation() &&
          snapshot.isCurrent(currentView.token, {
            account: true,
            positions: true,
            paired: true,
          });
        if (!isReceiptCurrent()) {
          const refresh = helpers.requestAccountPositionRefresh(activationDayEpoch);
          const refreshed = await refresh.result.finally(refresh.cancel);
          if (refreshed.status === 'ABORTED' || !canContinueActivation()) return 'skipped';

          continue;
        }

        await quoteSubscriptionRuntime.reconcilePositionHoldFromCurrentTruth(currentView.token);
        if (!canContinueActivation()) return 'skipped';

        if (!isReceiptCurrent()) continue;

        const dailyLossOffset = context.dailyLossTracker.getLossOffset(isLong ? 'LONG' : 'SHORT');
        const prepared = context.riskChecker.prepareUnrealizedLossData(
          context.orderRecorder,
          data.nextSymbol,
          isLong,
          dailyLossOffset,
        );
        if (!isReceiptCurrent()) continue;

        context.riskChecker.publishUnrealizedLossData(prepared);
        const latestSeatState = resolveActivatingSeatSnapshot(context, data);
        if (!latestSeatState || !isReceiptCurrent()) continue;

        if (data.previousSymbol && data.previousSymbol !== data.nextSymbol) {
          const existingSeat = context.symbolRegistry.resolveSeatBySymbol(data.previousSymbol);
          if (!existingSeat) context.orderRecorder.clearBuyOrders(data.previousSymbol, isLong);
        }

        const warrantRefreshResult = context.riskChecker.setWarrantInfoFromCallPrice(
          data.nextSymbol,
          callPrice,
          isLong,
          nextExecutionQuote?.name ?? data.symbolName,
        );
        if (!isReceiptCurrent()) continue;

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

        if (!isReceiptCurrent()) continue;

        setDirectionSymbolName(
          context,
          data.direction,
          nextExecutionQuote?.name ?? data.symbolName ?? data.nextSymbol,
        );

        context.symbolRegistry.updateSeatState(data.direction, {
          ...latestSeatState,
          status: 'ACTIVE',
          lastSeatActivatedAt: clock.now().getTime(),
          callPrice,
        });

        logSeatRefreshProcessed({
          data,
          result: 'activated',
        });

        return 'processed';
      }

      return 'skipped';
    } catch (error) {
      hasBodyFailure = true;
      bodyFailure = error;
      throw error;
    } finally {
      try {
        await quoteSubscriptionRuntime.releaseRetain(retainOwner);
      } catch (releaseFailure) {
        resolveRefreshReleaseFailure({ hasBodyFailure, bodyFailure, releaseFailure });
      }
    }
  };
}
