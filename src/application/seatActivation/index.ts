/**
 * 席位激活用例。
 * 唯一运行期 ACTIVATING→ACTIVE owner；按 retain/admission/真实订单/Daily/snapshot/订阅/风险/ACTIVE/release 屏障推进。
 * 外部失败仅一次延迟重试，内部错误与 release 错误保持原分类和身份；不维护第二订单账或 settlement ready。
 */
import { API } from '../../constants/index.js';
import { DIAGNOSTIC_OPERATIONS } from '../../constants/diagnostics.js';
import {
  createExternalApiAggregateRequestError,
  isExternalApiRequestError,
} from '../../utils/apiFailure/index.js';
import { formatError } from '../../utils/error/index.js';
import { exactCompare } from '../../utils/numeric/exact.js';
import { isSeatVersionMatch, resolveActivatingSeat } from '../../domain/seat/seatIdentity.js';

import { resolveOrderOwnership } from '../../domain/order/orderOwnership.js';
import type {
  SeatActivationRequest,
  SeatActivationResult,
  SeatActivationWorkflow,
  SeatActivationWorkflowDeps,
} from './types.js';

function logSeatRefreshSkipped(params: {
  readonly context: SeatActivationWorkflowDeps;
  readonly data: SeatActivationRequest;
  readonly reason: string;
}): void {
  const { context, data, reason } = params;
  const monitorSymbol = context.config.monitorSymbol;
  const currentSeat = context.symbolRegistry.getSeatState(data.direction);
  const currentSeatVersion = context.symbolRegistry.getSeatVersion(data.direction);
  context.logger.debug(
    `[SEAT_REFRESH skipped] monitorSymbol=${monitorSymbol} direction=${data.direction} taskSeatVersion=${data.seatVersion} currentSeatVersion=${currentSeatVersion} currentStatus=${currentSeat.status} currentSymbol=${currentSeat.symbol ?? 'null'} reason=${reason}`,
  );
}

function logSeatRefreshProcessed(params: {
  readonly context: SeatActivationWorkflowDeps;
  readonly data: SeatActivationRequest;
  readonly result: 'activated' | 'marked_empty';
  readonly reason?: string;
}): void {
  const { context, data, result, reason } = params;
  const reasonSuffix = reason ? ` reason=${reason}` : '';
  context.logger.debug(
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
function logSecondaryDiagnosticBestEffort(
  context: SeatActivationWorkflowDeps,
  message: string,
  diagnostic: unknown,
): void {
  try {
    context.logger.error(message, formatError(diagnostic));
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
  readonly context: SeatActivationWorkflowDeps;
  readonly hasBodyFailure: boolean;
  readonly bodyFailure: unknown;
  readonly releaseFailure: unknown;
}): void {
  const { context, hasBodyFailure, bodyFailure, releaseFailure } = params;

  if (hasBodyFailure && !isExternalApiRequestError(bodyFailure)) {
    logSecondaryDiagnosticBestEffort(
      context,
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
      context,
      '[SEAT_REFRESH] 主体外部 API 失败后 releaseRetain 内部失败（保留清理 fatal 身份）',
      bodyFailure,
    );
  }

  throw releaseFailure;
}

/**
 * 收集席位刷新期间必须能归属的交易标的。
 * @param context 当前唯一 monitor 运行时上下文
 * @param data 席位刷新任务数据
 * @returns 相关交易标的集合
 */
function collectSeatRefreshRelatedTradingSymbols(
  context: SeatActivationWorkflowDeps,
  data: SeatActivationRequest,
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
  context: SeatActivationWorkflowDeps,
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
  context.setDirectionSymbolName(direction, '');
  const { seatVersion: nextVersion } = context.symbolRegistry.updateSeatStateWithVersionBump(
    direction,
    nextState,
  );
  context.logger.error(
    `[自动换标] ${monitorSymbol} ${direction} 换标失败（v${nextVersion}）：${reason}`,
  );
}

/**
 * 创建唯一席位激活 owner。
 * 在固定身份下完成行情准入、真实订单与日损同步提交、snapshot、订阅及风险屏障；外部失败仅发出一次延迟重试指令。
 * @param deps 当前共享事实 owner、窄 I/O 能力与方向名称发布端口
 * @returns 激活执行与重试入队前身份校验能力
 */
export function createSeatActivationWorkflow(
  deps: SeatActivationWorkflowDeps,
): SeatActivationWorkflow {
  const { clock, snapshot, subscriptions: quoteSubscriptionRuntime } = deps;

  /** release 计时仅用于诊断；时钟故障保留未知，不改变激活/清理结果。 */
  function sampleDiagnosticTime(): number | null {
    try {
      const nowMs = clock.now().getTime();
      return Number.isFinite(nowMs) ? nowMs : null;
    } catch {
      return null;
    }
  }

  function isCurrent(data: SeatActivationRequest): boolean {
    return (
      snapshot.getView().token.dayEpoch === data.dayEpoch &&
      resolveActivatingSeat(deps.symbolRegistry, data) !== null
    );
  }

  async function performActivation(
    data: SeatActivationRequest,
    canContinue: () => boolean,
  ): Promise<SeatActivationResult> {
    if (!canContinue()) return { status: 'skipped' };

    const context = deps;
    if (!Number.isSafeInteger(data.dayEpoch) || data.dayEpoch < 0) {
      throw new TypeError('[SEAT_REFRESH] 入队 dayEpoch 必须是非负安全整数');
    }

    const activationDayEpoch = data.dayEpoch;
    const canContinueActivation = (): boolean =>
      canContinue() &&
      snapshot.getView().token.dayEpoch === activationDayEpoch &&
      resolveActivatingSeat(context.symbolRegistry, data) !== null;
    if (!canContinueActivation()) return { status: 'skipped' };

    const entrySeatState = resolveActivatingSeat(context.symbolRegistry, data);
    if (!entrySeatState) {
      logSeatRefreshSkipped({
        context,
        data,
        reason: 'entry seat snapshot mismatch',
      });
      return { status: 'skipped' };
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
        context,
        data,
        result: 'marked_empty',
        reason,
      });
      return { status: 'processed' };
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

      if (!canContinueActivation()) return { status: 'skipped' };

      await quoteSubscriptionRuntime.waitForAdmission(quoteSymbols);
      if (!canContinueActivation()) return { status: 'skipped' };

      const executionQuotes = await deps.getQuotes(quoteSymbols);
      if (!canContinueActivation()) return { status: 'skipped' };

      const nextExecutionQuote = executionQuotes.get(data.nextSymbol) ?? null;

      // 只追赶尚未提交的订单输入；普通 revision 更新不会使订单读票失效。
      while (canContinueActivation()) {
        const orderSourceToken = { ...snapshot.getView().token };
        if (orderSourceToken.dayEpoch !== activationDayEpoch) return { status: 'skipped' };

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
        const allOrders = await deps.orders.fetchAllOrdersFromAPI();
        if (!canContinueActivation()) return { status: 'skipped' };

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
          context.orders.validateRebuildSnapshot(symbol, allOrders);
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
        const preparedDailyLoss = context.dailyLoss.prepareRecalculationFromAllOrders(
          allOrders,
          context.config,
          clock.now(),
          undefined,
          relatedTradingSymbols,
        );
        const isPreparedOrderSourceCurrent = (): boolean =>
          isOrderSourceCurrent() && preparedDailyLoss.isCurrent();
        if (!canContinueActivation()) return { status: 'skipped' };

        if (!isPreparedOrderSourceCurrent()) continue;

        // 本实例 Daily 完整无写预检后，原 token/全部席位/候选共同授权同步 O→Daily 发布；中间无 await。
        const commit = context.orders.commitRebuildSnapshot(
          targets,
          allOrders,
          isPreparedOrderSourceCurrent,
          'ACTIVATION',
        );
        if (commit.status === 'ABORTED') return { status: 'skipped' };

        context.dailyLoss.publishRecalculation(preparedDailyLoss);
        break;
      }

      if (!canContinueActivation()) return { status: 'skipped' };

      const handle = requestRefresh(activationDayEpoch);
      const receipt = await handle.result.finally(handle.cancel);
      if (receipt.status === 'ABORTED' || !canContinueActivation()) return { status: 'skipped' };

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
          const refresh = requestRefresh(activationDayEpoch);
          const refreshed = await refresh.result.finally(refresh.cancel);
          if (refreshed.status === 'ABORTED' || !canContinueActivation())
            return { status: 'skipped' };

          continue;
        }

        await quoteSubscriptionRuntime.reconcilePositionHoldFromCurrentTruth(currentView.token);
        if (!canContinueActivation()) return { status: 'skipped' };

        if (!isReceiptCurrent()) continue;

        const dailyLossOffset = context.dailyLoss.getLossOffset(isLong ? 'LONG' : 'SHORT');
        const prepared = context.risk.prepareUnrealizedLossData(
          data.nextSymbol,
          isLong,
          dailyLossOffset,
        );
        if (!isReceiptCurrent()) continue;

        const latestSeatState = resolveActivatingSeat(context.symbolRegistry, data);
        if (!latestSeatState || !isReceiptCurrent()) continue;

        // 最终授权后按原次序同步发布，下面直到 ACTIVE 都不插入 await 或追赶分支。
        context.risk.publishUnrealizedLossData(prepared);
        if (!isReceiptCurrent()) return { status: 'skipped' };

        if (data.previousSymbol && data.previousSymbol !== data.nextSymbol) {
          const existingSeat = context.symbolRegistry.resolveSeatBySymbol(data.previousSymbol);
          if (!existingSeat) context.orders.clearBuyOrders(data.previousSymbol, isLong);
        }

        const warrantRefreshResult = context.risk.setWarrantInfoFromCallPrice(
          data.nextSymbol,
          callPrice,
          isLong,
          nextExecutionQuote?.name ?? data.symbolName,
        );
        if (!isReceiptCurrent()) return { status: 'skipped' };

        if (warrantRefreshResult.status === 'error') {
          const reason = `设置牛熊证信息失败：${warrantRefreshResult.reason}`;
          markSeatAsEmpty(data.direction, reason, context, clock.now().getTime());
          logSeatRefreshProcessed({
            context,
            data,
            result: 'marked_empty',
            reason,
          });
          return { status: 'processed' };
        }

        context.setDirectionSymbolName(
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
          context,
          data,
          result: 'activated',
        });

        return { status: 'processed' };
      }

      return { status: 'skipped' };
    } catch (error) {
      hasBodyFailure = true;
      bodyFailure = error;
      throw error;
    } finally {
      let releaseStartedAtMs: number | null = null;
      let afterActive = false;
      let released = false;
      try {
        const releaseSeat = context.symbolRegistry.getSeatState(data.direction);
        afterActive =
          releaseSeat.status === 'ACTIVE' &&
          releaseSeat.symbol === data.nextSymbol &&
          context.symbolRegistry.getSeatVersion(data.direction) === data.seatVersion;
        releaseStartedAtMs = sampleDiagnosticTime();
      } catch {
        // 私有诊断采样失败不影响必须执行的 retain release。
      }

      try {
        await quoteSubscriptionRuntime.releaseRetain(retainOwner);
        released = true;
      } catch (releaseFailure) {
        resolveRefreshReleaseFailure({ context, hasBodyFailure, bodyFailure, releaseFailure });
      } finally {
        // activation 总周期已由 registry 的 ACTIVE/退出事件结束；release 的成功/失败与耗时独立记录。
        try {
          const releaseCompletedAtMs = sampleDiagnosticTime();
          deps.diagnostics.record(DIAGNOSTIC_OPERATIONS.SEAT_ACTIVATION_RETAIN_RELEASED, {
            source: 'SEAT_ACTIVATION',
            phase: 'RETAIN_RELEASE',
            dayEpoch: data.dayEpoch,
            seatDirection: data.direction,
            seatVersion: data.seatVersion,
            symbol: data.nextSymbol,
            afterActive,
            outcome: released ? 'RELEASED' : 'FAILED',
            apiRetryAttempt: data.apiRetryAttempt ?? 0,
            durationMs:
              releaseStartedAtMs === null || releaseCompletedAtMs === null
                ? null
                : Math.max(0, releaseCompletedAtMs - releaseStartedAtMs),
          });
        } catch {
          // 诊断失败不能覆盖主体或 release 失败，更不能触发额外 activation 重试。
        }
      }
    }
  }

  function requestRefresh(dayEpoch: number) {
    return snapshot.requestRefresh({
      source: 'SEAT_ACTIVATION',
      dayEpoch,
      refreshAccount: true,
      refreshPositions: true,
    });
  }

  async function activate(
    data: SeatActivationRequest,
    canContinue: () => boolean,
  ): Promise<SeatActivationResult> {
    try {
      return await performActivation(data, canContinue);
    } catch (error) {
      if (!isExternalApiRequestError(error)) throw error;

      deps.logger.error(
        `[SEAT_REFRESH] 激活外部请求失败 direction=${data.direction} seatVersion=${data.seatVersion}`,
        formatError(error),
      );

      if (!canContinue() || !isCurrent(data)) return { status: 'failed', error };

      const attempt = data.apiRetryAttempt ?? 0;
      if (attempt >= 1) {
        const seat = deps.symbolRegistry.getSeatState(data.direction);
        const nowMs = clock.now().getTime();
        deps.symbolRegistry.updateSeatStateWithVersionBump(data.direction, {
          symbol: null,
          status: 'EMPTY',
          lastSwitchAt: nowMs,
          lastSearchAt: seat.lastSearchAt ?? nowMs,
          lastSeatActivatedAt: null,
          callPrice: null,
          searchFailCountToday: seat.searchFailCountToday,
          frozenTradingDayKey: seat.frozenTradingDayKey,
        });
        return { status: 'failed', error };
      }

      return {
        status: 'retry',
        error,
        request: { ...data, apiRetryAttempt: attempt + 1 },
        delayMs: API.DEFAULT_RETRY_DELAY_MS,
      };
    }
  }

  return { activate, isCurrent };
}
