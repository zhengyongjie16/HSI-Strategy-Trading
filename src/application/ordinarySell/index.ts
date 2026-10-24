/**
 * 普通 SELL 唯一用例 owner：freshness 后按当前 canonical 持仓/席位重选卖量，持有失败与报价重试策略。
 * 版本失效在本 owner 内重新选择；只有真实报价缺失才返回限次重试请求，FIFO worker 只负责调度。
 */
import { isStaleCrossDaySignal, isLiquidationSignal } from '../../domain/order/executionPolicy.js';
import { ORDER_QUOTE_RETRY } from '../../constants/common.js';
import { DIAGNOSTIC_OPERATIONS } from '../../constants/diagnostics.js';
import { resolveNextQuoteRetry } from '../quoteRetry.js';
import { resolveQuoteReadinessForRequirement } from '../../domain/order/quoteReadiness.js';
import { isExternalApiRequestError } from '../../utils/apiFailure/index.js';
import { isSettlementReadinessAbortError } from '../postTradeSettlement/readinessGate.js';
import { formatError } from '../../utils/error/index.js';
import { formatSymbolDisplay } from '../../utils/display/index.js';
import {
  isSeatActive,
  validateSignalSeat,
  describeSignalSeatValidationFailure,
} from '../../domain/seat/seatPolicy.js';

import { processSellSignals } from './quantityResolver.js';
import type { DiagnosticFields } from '../../types/diagnostics.js';
import type { ExecutableSellSignal } from '../../types/signal.js';
import type { SettlementReadinessReceipt } from '../../types/settlement.js';
import type {
  OrdinarySellWorkflow,
  OrdinarySellWorkflowDeps,
  SellExecutionAttempt,
  SellExecutionOutcome,
} from './types.js';

/**
 * 复制卖出信号，用于 quote retry 的 delayed re-enqueue。
 *
 * @param signal 原始卖出信号
 * @returns 可重新入队的卖出信号副本
 */
function cloneSellSignal(signal: ExecutableSellSignal): ExecutableSellSignal {
  return {
    ...signal,
    triggerTime: signal.triggerTime ? new Date(signal.triggerTime) : null,
    relatedBuyOrderIds: signal.relatedBuyOrderIds ? [...signal.relatedBuyOrderIds] : null,
  };
}

/** 直接迁移原 SELL owner，不经过 SignalProcessor，数量/授权必须和同一 readiness 选择保持一致。 */
export function createOrdinarySellWorkflow(deps: OrdinarySellWorkflowDeps): OrdinarySellWorkflow {
  const {
    logger,
    diagnostics,
    clock,
    config,
    symbolRegistry,
    orderRecorder,
    orderExecutor,
    marketDataClient,
    snapshot,
    settlement,
    getTradingCalendar,
    getCanProcessTask,
    termination,
  } = deps;

  /** 各 await 后先暴露内部错误，再决定旧选择是否可以安全放弃或重新选择。 */
  async function execute(
    signal: ExecutableSellSignal,
    attempt: SellExecutionAttempt,
  ): Promise<SellExecutionOutcome> {
    const symbolDisplay = formatSymbolDisplay(signal.symbol, signal.symbolName ?? null);
    const originDayEpoch = attempt.retry?.dayEpoch ?? snapshot.getView().token.dayEpoch;

    /** 仅在既有阻断/延期分支采集；字段构造及 observer 异常不参与卖出策略。 */
    function recordOutcome(fields: () => DiagnosticFields): void {
      try {
        const triggerTimeMs = signal.triggerTime?.getTime();
        diagnostics.record(DIAGNOSTIC_OPERATIONS.SIGNAL_PROCESSING_OUTCOME, {
          symbol: signal.symbol,
          action: signal.action,
          seatVersion: signal.seatVersion,
          ...(triggerTimeMs !== undefined && Number.isFinite(triggerTimeMs)
            ? { triggerTimeMs }
            : {}),
          originDayEpoch,
          ...fields(),
        });
      } catch {
        // 被动旁路，不调用 logger/fatal、不补读授权、席位或时钟。
      }
    }

    const canContinue = (): boolean => {
      if (!attempt.isActive()) {
        recordOutcome(() => ({
          stage: 'SELL_AUTHORIZATION',
          outcome: 'ABORTED',
          reasonCode: 'RUN_GENERATION_INVALIDATED',
        }));
        return false;
      }

      if (termination.isTerminated()) {
        recordOutcome(() => ({
          stage: 'SELL_AUTHORIZATION',
          outcome: 'ABORTED',
          reasonCode: 'RUNTIME_TERMINATED',
        }));
        return false;
      }

      if (!getCanProcessTask()) {
        recordOutcome(() => ({
          stage: 'SELL_AUTHORIZATION',
          outcome: 'ABORTED',
          reasonCode: 'TRADING_GATE_CLOSED',
        }));
        return false;
      }

      return true;
    };

    const canContinueOrigin = (): boolean => {
      if (!canContinue()) return false;

      const currentDayEpoch = snapshot.getView().token.dayEpoch;
      if (currentDayEpoch !== originDayEpoch) {
        recordOutcome(() => ({
          stage: 'SELL_AUTHORIZATION',
          outcome: 'ABORTED',
          reasonCode: 'TRADING_DAY_INVALIDATED',
          currentDayEpoch,
        }));
        return false;
      }

      const validation = validateSignalSeat({ signal, symbolRegistry });
      if (!validation.valid) {
        recordOutcome(() => ({
          stage: 'SELL_AUTHORIZATION',
          outcome: 'ABORTED',
          reasonCode: validation.reason,
        }));
        return false;
      }

      return true;
    };

    /** 沿原 retry 授权短路检查失效；只在既有跨日拒绝点记录，不增加 clock 调用。 */
    function isRetryCurrent(retrySignal: ExecutableSellSignal): boolean {
      if (!canContinueOrigin()) return false;

      if (isLiquidationSignal(retrySignal) || !isStaleCrossDaySignal(retrySignal, clock.now()))
        return true;

      recordOutcome(() => ({
        stage: 'SELL_RETRY_VALIDITY',
        outcome: 'ABORTED',
        reasonCode: 'SIGNAL_TRADING_DAY_STALE',
      }));
      return false;
    }

    /** 首次报价与 execution 最终报价缺失共用同一预算；返回延期请求，不宣称 runtime 已建立 timer。 */
    function deferMissingQuote(stage: string): SellExecutionOutcome {
      if (!canContinueOrigin()) return { status: 'COMPLETED' };

      const nextRetry = resolveNextQuoteRetry({
        attempts: attempt.retry?.attempts ?? 0,
        nowMs: clock.now().getTime(),
        intervalMs: ORDER_QUOTE_RETRY.INTERVAL_MS,
        maxAttempts: ORDER_QUOTE_RETRY.MAX_ATTEMPTS,
      });
      if (nextRetry.exhausted) {
        logger.warn(`[OrdinarySell] 卖出行情重试耗尽，放弃执行: ${symbolDisplay}`);
        recordOutcome(() => ({
          stage,
          outcome: 'REJECTED',
          reasonCode: 'QUOTE_RETRY_EXHAUSTED',
          retryAttempts: attempt.retry?.attempts ?? 0,
        }));
        return { status: 'COMPLETED' };
      }

      const retrySignal = cloneSellSignal(signal);
      recordOutcome(() => ({
        stage,
        outcome: 'DEFERRED',
        reasonCode: 'QUOTE_MISSING',
        retryAttempts: nextRetry.nextAttempts,
        retryDelayMs: ORDER_QUOTE_RETRY.INTERVAL_MS,
      }));
      return {
        status: 'RETRY',
        retry: {
          signal: retrySignal,
          attempts: nextRetry.nextAttempts,
          dayEpoch: originDayEpoch,
          delayMs: ORDER_QUOTE_RETRY.INTERVAL_MS,
          isCurrent: () => isRetryCurrent(retrySignal),
        },
      };
    }

    try {
      const runtimeAction: unknown = signal.action;
      if (runtimeAction !== 'SELLCALL' && runtimeAction !== 'SELLPUT')
        throw new TypeError('普通 SELL 只接受卖出信号');

      // 持仓/readiness supersession 只由本 SELL owner 重选，不排 timer、不消耗 quote retry。
      while (canContinueOrigin()) {
        let receipt: SettlementReadinessReceipt;
        try {
          receipt = await settlement.waitForFresh();
        } catch (error) {
          if (isSettlementReadinessAbortError(error, 'STOP_AND_DRAIN')) {
            recordOutcome(() => ({
              stage: 'SELL_SETTLEMENT_WAIT',
              outcome: 'ABORTED',
              reasonCode: 'SETTLEMENT_WAIT_ABORTED',
            }));
            return { status: 'COMPLETED' };
          }

          throw error;
        }

        if (!canContinueOrigin()) return { status: 'COMPLETED' };

        const isReceiptCurrent = (): boolean => {
          if (!canContinueOrigin()) return false;

          if (receipt.snapshotToken.dayEpoch !== originDayEpoch) {
            recordOutcome(() => ({
              stage: 'SELL_SETTLEMENT_WAIT',
              outcome: 'INVALIDATED',
              reasonCode: 'SETTLEMENT_RECEIPT_DAY_INVALIDATED',
              receiptDayEpoch: receipt.snapshotToken.dayEpoch,
            }));
            return false;
          }

          return settlement.isCurrent(receipt);
        };

        if (!isReceiptCurrent()) continue;

        const calendar = getTradingCalendar();
        const seatValidation = validateSignalSeat({
          signal,
          symbolRegistry,
        });
        if (!seatValidation.valid) {
          logger.debug(
            `[OrdinarySell] ${describeSignalSeatValidationFailure(seatValidation)}，跳过信号: ${symbolDisplay} ${signal.action}`,
          );

          recordOutcome(() => ({
            stage: 'SELL_SEAT_VALIDATION',
            outcome: 'REJECTED',
            reasonCode: seatValidation.reason,
          }));
          return { status: 'COMPLETED' };
        }

        const longSeatState = symbolRegistry.getSeatState('LONG');
        const shortSeatState = symbolRegistry.getSeatState('SHORT');
        const capturedSeats = (['LONG', 'SHORT'] as const).map((direction) => ({
          direction,
          symbol: symbolRegistry.getSeatState(direction).symbol,
          status: symbolRegistry.getSeatState(direction).status,
          seatVersion: symbolRegistry.getSeatVersion(direction),
        }));
        const selectedView = snapshot.getView();
        const isSelectionCurrent = (): boolean =>
          isReceiptCurrent() &&
          snapshot.isCurrent(selectedView.token, { account: false, positions: true }) &&
          capturedSeats.every(({ direction, symbol, status, seatVersion }) => {
            const currentSeat = symbolRegistry.getSeatState(direction);
            return (
              currentSeat.symbol === symbol &&
              currentSeat.status === status &&
              symbolRegistry.getSeatVersion(direction) === seatVersion
            );
          });
        const resolvePosition = (symbol: string) =>
          snapshot.getAvailablePosition(symbol) ??
          selectedView.positions.find(
            (position) => position.symbol === symbol && position.quantity > 0,
          ) ??
          null;
        // 可卖量为 0 时仍保留真实总持仓；不能把 occupied-but-unavailable 解释成 flat。
        const longPosition = isSeatActive(longSeatState)
          ? resolvePosition(longSeatState.symbol)
          : null;
        const shortPosition = isSeatActive(shortSeatState)
          ? resolvePosition(shortSeatState.symbol)
          : null;
        if (!isSelectionCurrent()) continue;

        const quoteSymbols: string[] = [];
        if (isSeatActive(longSeatState)) {
          quoteSymbols.push(longSeatState.symbol);
        }

        if (isSeatActive(shortSeatState)) {
          quoteSymbols.push(shortSeatState.symbol);
        }

        const executionQuotes = await marketDataClient.getQuotes(quoteSymbols);
        if (!canContinueOrigin()) return { status: 'COMPLETED' };

        if (!isSelectionCurrent()) continue;

        const longQuote = isSeatActive(longSeatState)
          ? (executionQuotes.get(longSeatState.symbol) ?? null)
          : null;
        const shortQuote = isSeatActive(shortSeatState)
          ? (executionQuotes.get(shortSeatState.symbol) ?? null)
          : null;
        const targetQuote = signal.action === 'SELLCALL' ? longQuote : shortQuote;
        const quoteReadiness = resolveQuoteReadinessForRequirement({
          quote: targetQuote,
          requirement: 'PRICE',
        });
        if (quoteReadiness !== 'READY') {
          if (!canContinue()) {
            return { status: 'COMPLETED' };
          }

          if (quoteReadiness !== 'MISSING') {
            logger.warn(
              `[OrdinarySell] 卖出行情无效，放弃当前执行: ${symbolDisplay} ${signal.action} readiness=${quoteReadiness}`,
            );

            recordOutcome(() => ({
              stage: 'SELL_QUOTE_ADMISSION',
              outcome: 'REJECTED',
              reasonCode: 'QUOTE_INVALID',
              quoteReadiness,
              ...(targetQuote === null ? {} : { currentPrice: targetQuote.price }),
            }));
            return { status: 'COMPLETED' };
          }

          return deferMissingQuote('SELL_QUOTE_ADMISSION');
        }

        // 卖出只进入卖量计算与卖出执行链路，不经过买入风控。
        const processedSignals = processSellSignals({
          signals: [signal],
          longPosition,
          shortPosition,
          longQuote,
          shortQuote,
          orderRecorder,
          smartCloseEnabled: config.smartCloseEnabled,
          smartCloseTimeoutMinutes: config.smartCloseTimeoutMinutes,
          nowMs: clock.now().getTime(),
          isHalfDay: calendar.isHalfDay,
          tradingCalendarSnapshot: calendar.tradingCalendarSnapshot,
        });

        if (!canContinueOrigin()) return { status: 'COMPLETED' };

        if (!isSelectionCurrent()) continue;

        // 如果信号被转为 HOLD，跳过执行
        const firstSignal = processedSignals[0];
        if (!firstSignal || firstSignal.action === 'HOLD') {
          logger.debug(`[OrdinarySell] 卖出信号被跳过: ${symbolDisplay} ${signal.action}`);
          recordOutcome(() => ({
            stage: 'SELL_QUANTITY',
            outcome: 'SKIPPED',
            reasonCode: firstSignal ? 'SELL_QUANTITY_HOLD' : 'SELL_QUANTITY_EMPTY',
            ...(firstSignal
              ? {
                  processedAction: firstSignal.action,
                  ...(firstSignal.reason === undefined ? {} : { detail: firstSignal.reason }),
                }
              : {}),
          }));
          return { status: 'COMPLETED' }; // 处理成功（虽然跳过了）
        }

        const executionSeatValidation = validateSignalSeat({
          signal: firstSignal,
          symbolRegistry,
        });
        if (!executionSeatValidation.valid) {
          logger.debug(
            `[OrdinarySell] ${describeSignalSeatValidationFailure(executionSeatValidation)}，执行前复核失败，跳过信号: ${symbolDisplay} ${signal.action}`,
          );

          recordOutcome(() => ({
            stage: 'SELL_EXECUTION_SEAT_VALIDATION',
            outcome: 'REJECTED',
            reasonCode: executionSeatValidation.reason,
          }));
          return { status: 'COMPLETED' };
        }

        if (!isSelectionCurrent()) continue;

        const executionResult = await orderExecutor.executeSignals(
          [firstSignal],
          isSelectionCurrent,
        );
        const quoteFailures = executionResult.quoteFailures;
        if (
          !Array.isArray(executionResult.executedOrderIds) ||
          !Array.isArray(executionResult.quoteFailures)
        ) {
          throw new TypeError('信号执行必须显式报告 accepted order IDs 与最终报价失败事实');
        }

        // 已完成远端执行的 id/ACK 不因随后的 receipt 或报价事实失效而否认或重新提交。
        if (executionResult.executedOrderIds.length > 0 || !canContinueOrigin())
          return { status: 'COMPLETED' };

        const finalQuoteFailure = quoteFailures.find((failure) => failure.signal === firstSignal);
        if (finalQuoteFailure?.kind === 'QUOTE_INVALID') {
          logger.warn(`[OrdinarySell] 最终卖出行情无效，放弃当前执行: ${symbolDisplay}`);
          recordOutcome(() => ({
            stage: 'SELL_EXECUTION',
            outcome: 'REJECTED',
            reasonCode: 'QUOTE_INVALID',
          }));
          return { status: 'COMPLETED' };
        }

        // 版本失效只重选当前事实，不消耗报价预算；明确最终缺价才共用首次缺价的有限重试。
        if (!isSelectionCurrent()) continue;

        if (finalQuoteFailure?.kind === 'QUOTE_MISSING') return deferMissingQuote('SELL_EXECUTION');

        // 其他门禁/订单事实拒绝可能同样无 accepted ID，不能据此推造报价缺失并重试。
        return { status: 'COMPLETED' };
      }

      return { status: 'COMPLETED' };
    } catch (error) {
      if (!isExternalApiRequestError(error)) {
        throw error;
      }

      logger.error(
        `[OrdinarySell] 处理失败: ${symbolDisplay} ${signal.action}`,
        formatError(error),
      );

      recordOutcome(() => ({
        stage: 'SELL_WORKFLOW',
        outcome: 'FAILED',
        reasonCode: 'EXTERNAL_API_READ_FAILED',
        detail: formatError(error),
      }));
      return { status: 'COMPLETED' };
    }
  }
  return { execute };
}
