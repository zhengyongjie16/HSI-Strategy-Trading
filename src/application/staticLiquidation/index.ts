/**
 * staticLiquidationExecutor
 *
 * 职责：
 * - 执行 monitor quote 驱动的静态距回收价清仓
 * - 从只读 canonical snapshot 与真实 settlement receipt 捕获执行授权
 * - 远端确认不冒充空仓；仅授权仍有效时沿原清理与风险发布语义推进
 */
import { WARRANT_LIQUIDATION_ORDER_TYPE } from '../../constants/common.js';
import { validateSignalSeat, isSeatActive } from '../../domain/seat/seatPolicy.js';
import type { SellSignal } from '../../types/signal.js';
import type { Quote } from '../../types/quote.js';

import { isExternalApiRequestError } from '../../utils/apiFailure/index.js';
import { exactCompare, sumSafeQuantities } from '../../utils/numeric/exact.js';
import { isSettlementReadinessAbortError } from '../postTradeSettlement/readinessGate.js';
import type { SettlementReadinessReceipt } from '../../types/settlement.js';
import { resolveNextQuoteRetry } from '../quoteRetry.js';
import type {
  CreateStaticLiquidationExecutorDeps,
  StaticLiquidationCandidate,
  StaticLiquidationCandidateResult,
  StaticLiquidationExecutionResult,
  StaticLiquidationExecutionParams,
  StaticLiquidationContext,
} from './types.js';

function buildStaticLiquidationWakeupSymbols(params: {
  readonly monitorSymbol: string;
  readonly longSymbol: string | null;
  readonly shortSymbol: string | null;
}): ReadonlyArray<string> {
  const { monitorSymbol, longSymbol, shortSymbol } = params;
  return [monitorSymbol, longSymbol, shortSymbol].filter((symbol) => symbol !== null);
}

/**
 * 创建静态清仓 WAIT 返回值。
 *
 * @param wakeupSymbols 需要继续等待的唤醒 symbols
 * @param retryAttempts 当前已执行的 retry 次数
 * @returns 统一的 WAIT 返回值
 */
function createStaticLiquidationWaitResult(
  wakeupSymbols: ReadonlyArray<string>,
  retryAttempts: number,
  waitResolvedAtMs: number,
): Extract<StaticLiquidationExecutionResult, { kind: 'WAIT' }> {
  return {
    kind: 'WAIT',
    wakeupSymbols,
    retryAtMs: resolveNextQuoteRetry({
      attempts: retryAttempts,
      nowMs: waitResolvedAtMs,
    }).nextRetryAt,
  };
}

/**
 * 按方向创建静态距回收价清仓候选。
 *
 * @param params monitor 上下文、方向、monitor quote 与交易标的 quote
 * @returns 显式区分等待行情、跳过执行与生成候选三种结果
 */
function createStaticLiquidationCandidate(params: {
  readonly monitorContext: StaticLiquidationContext;
  readonly direction: 'LONG' | 'SHORT';
  readonly monitorQuote: Quote;
  readonly tradingQuote: Quote | null;
  readonly availableQuantity: number;
  readonly executionTime: Date;
}): StaticLiquidationCandidateResult {
  const {
    monitorContext,
    direction,
    monitorQuote,
    tradingQuote,
    availableQuantity,
    executionTime,
  } = params;
  const isLongDirection = direction === 'LONG';
  const seatState = monitorContext.symbolRegistry.getSeatState(direction);
  if (!isSeatActive(seatState)) {
    return { kind: 'SKIP' };
  }

  if (!Number.isSafeInteger(availableQuantity) || availableQuantity < 0)
    throw new RangeError(
      'Static liquidation available quantity must be a nonnegative safe integer',
    );

  if (availableQuantity === 0) return { kind: 'SKIP' };

  const liquidationResult = monitorContext.riskChecker.checkWarrantDistanceLiquidation(
    seatState.symbol,
    isLongDirection,
    monitorQuote.price,
  );
  if (!liquidationResult.shouldLiquidate) {
    return { kind: 'SKIP' };
  }

  if (tradingQuote?.lotSize === undefined) return { kind: 'WAIT' };

  if (!Number.isSafeInteger(tradingQuote.lotSize) || tradingQuote.lotSize <= 0)
    throw new RangeError('Static liquidation lot size must be a positive safe integer');

  if (exactCompare(tradingQuote.price, '0') <= 0) return { kind: 'SKIP' };

  const signal: SellSignal = {
    symbol: seatState.symbol,
    symbolName: isLongDirection
      ? monitorContext.longSymbolName || seatState.symbol
      : monitorContext.shortSymbolName || seatState.symbol,
    action: isLongDirection ? 'SELLCALL' : 'SELLPUT',
    reason: liquidationResult.reason ?? '牛熊证距回收价触发清仓',
    executionOrigin: 'STATIC_DISTANCE_LIQUIDATION',
    quantity: availableQuantity,
    triggerTime: executionTime,
    orderTypeOverride: WARRANT_LIQUIDATION_ORDER_TYPE,
    isProtectiveLiquidation: false,
    seatVersion: monitorContext.symbolRegistry.getSeatVersion(direction),
  };

  return {
    kind: 'CANDIDATE',
    candidate: { signal },
  };
}

/**
 * 创建静态距回收价清仓执行器。
 *
 * @param deps 执行器依赖
 * @returns monitor quote 事件执行函数
 */
export function createStaticLiquidationExecutor(
  deps: CreateStaticLiquidationExecutorDeps,
): (params: StaticLiquidationExecutionParams) => Promise<StaticLiquidationExecutionResult> {
  const { orderExecutor, marketDataClient, snapshot, postTradeConsistencyRuntime, now } = deps;

  return async function executeStaticLiquidation(
    params: StaticLiquidationExecutionParams,
  ): Promise<StaticLiquidationExecutionResult> {
    if (!params.canContinue()) {
      return { kind: 'NOOP' };
    }

    const { monitorContext } = params;
    const executionTime = now();
    const dayEpoch = snapshot.getView().token.dayEpoch;
    const monitorSymbol = monitorContext.config.monitorSymbol;
    const longSeat = monitorContext.symbolRegistry.getSeatState('LONG');
    const shortSeat = monitorContext.symbolRegistry.getSeatState('SHORT');
    const longSymbol = isSeatActive(longSeat) ? longSeat.symbol : null;
    const shortSymbol = isSeatActive(shortSeat) ? shortSeat.symbol : null;
    const longSeatVersion = monitorContext.symbolRegistry.getSeatVersion('LONG');
    const shortSeatVersion = monitorContext.symbolRegistry.getSeatVersion('SHORT');
    const isSeatCurrent = (direction: 'LONG' | 'SHORT'): boolean => {
      const current = monitorContext.symbolRegistry.getSeatState(direction);
      return (
        isSeatActive(current) &&
        current.symbol === (direction === 'LONG' ? longSymbol : shortSymbol) &&
        monitorContext.symbolRegistry.getSeatVersion(direction) ===
          (direction === 'LONG' ? longSeatVersion : shortSeatVersion)
      );
    };
    const wakeupSymbols = buildStaticLiquidationWakeupSymbols({
      monitorSymbol,
      longSymbol,
      shortSymbol,
    });
    if (wakeupSymbols.length === 0) {
      return { kind: 'NOOP' };
    }

    let receipt: SettlementReadinessReceipt;
    try {
      receipt = await postTradeConsistencyRuntime.waitForFresh();
    } catch (error) {
      if (isSettlementReadinessAbortError(error, 'STOP_AND_DRAIN')) return { kind: 'NOOP' };

      throw error;
    }

    if (!params.canContinue() || snapshot.getView().token.dayEpoch !== dayEpoch)
      return { kind: 'NOOP' };

    const view = snapshot.getView();
    const isCurrent = (): boolean =>
      params.canContinue() &&
      snapshot.getView().token.dayEpoch === dayEpoch &&
      postTradeConsistencyRuntime.isCurrent(receipt) &&
      snapshot.isCurrent(view.token, { account: false, positions: true });
    if (!isCurrent()) return { kind: 'RE_EVALUATE' };

    let executionQuotes: Awaited<ReturnType<typeof marketDataClient.getQuotes>>;
    try {
      executionQuotes = await marketDataClient.getQuotes(wakeupSymbols);
    } catch (error) {
      if (!isExternalApiRequestError(error)) {
        throw error;
      }

      if (!params.canContinue() || snapshot.getView().token.dayEpoch !== dayEpoch)
        return { kind: 'NOOP' };

      if (!isCurrent()) return { kind: 'RE_EVALUATE' };

      return createStaticLiquidationWaitResult(
        wakeupSymbols,
        params.retryAttempts,
        now().getTime(),
      );
    }

    if (!params.canContinue() || snapshot.getView().token.dayEpoch !== dayEpoch)
      return { kind: 'NOOP' };

    if (!isCurrent()) return { kind: 'RE_EVALUATE' };

    const monitorQuote = executionQuotes.get(monitorSymbol) ?? null;
    if (monitorQuote === null) {
      return createStaticLiquidationWaitResult(
        wakeupSymbols,
        params.retryAttempts,
        now().getTime(),
      );
    }

    // 内部价格非法立即失败；合法非正监控价仍由 warrant 原规则拒绝，不变成外部行情重试。
    exactCompare(monitorQuote.price, '0');
    const longQuote = longSymbol ? (executionQuotes.get(longSymbol) ?? null) : null;
    const shortQuote = shortSymbol ? (executionQuotes.get(shortSymbol) ?? null) : null;
    const getAvailableQuantity = (symbol: string): number => {
      const total = sumSafeQuantities(
        view.positions
          .filter((position) => position.symbol === symbol)
          .map((position) => String(position.quantity)),
      );
      if (total === 0) return 0;

      // available lookup 只决定本次可卖量；lookup为空或available=0不证明total持仓flat。
      const position = snapshot.getAvailablePosition(symbol);
      const available = position?.availableQuantity ?? 0;
      if (!Number.isSafeInteger(available) || available < 0)
        throw new RangeError(
          'Static liquidation available quantity must be a nonnegative safe integer',
        );

      return available;
    };
    const candidates: StaticLiquidationCandidate[] = [];
    let hasPendingWait = false;

    const longCandidateResult =
      longSymbol && isSeatCurrent('LONG') && !params.excludedDirections?.has('LONG')
        ? createStaticLiquidationCandidate({
            monitorContext,
            direction: 'LONG',
            monitorQuote,
            tradingQuote: longQuote,
            availableQuantity: getAvailableQuantity(longSymbol),
            executionTime,
          })
        : { kind: 'SKIP' as const };
    if (longCandidateResult.kind === 'CANDIDATE') {
      candidates.push(longCandidateResult.candidate);
    } else if (longCandidateResult.kind === 'WAIT') {
      hasPendingWait = true;
    }

    const shortCandidateResult =
      shortSymbol && isSeatCurrent('SHORT') && !params.excludedDirections?.has('SHORT')
        ? createStaticLiquidationCandidate({
            monitorContext,
            direction: 'SHORT',
            monitorQuote,
            tradingQuote: shortQuote,
            availableQuantity: getAvailableQuantity(shortSymbol),
            executionTime,
          })
        : { kind: 'SKIP' as const };
    if (shortCandidateResult.kind === 'CANDIDATE') {
      candidates.push(shortCandidateResult.candidate);
    } else if (shortCandidateResult.kind === 'WAIT') {
      hasPendingWait = true;
    }

    if (candidates.length === 0 && !hasPendingWait) {
      return { kind: 'NOOP' };
    }

    let hasSubmittedCandidate = false;

    for (const candidate of candidates) {
      if (!params.canContinue()) {
        return hasSubmittedCandidate ? { kind: 'COMPLETED' } : { kind: 'NOOP' };
      }

      if (!isCurrent())
        return hasSubmittedCandidate ? { kind: 'COMPLETED' } : { kind: 'RE_EVALUATE' };

      const direction = candidate.signal.action === 'SELLCALL' ? 'LONG' : 'SHORT';
      if (!isSeatCurrent(direction)) continue;

      const seatValidation = validateSignalSeat({
        signal: candidate.signal,
        symbolRegistry: monitorContext.symbolRegistry,
      });
      if (!seatValidation.valid) {
        continue;
      }

      if (!params.canContinue()) {
        return hasSubmittedCandidate ? { kind: 'COMPLETED' } : { kind: 'NOOP' };
      }

      // 最终同步提交条件重新检查：receipt/epoch/seat/position与风险阈值均仍成立。
      if (!isCurrent())
        return hasSubmittedCandidate ? { kind: 'COMPLETED' } : { kind: 'RE_EVALUATE' };

      if (
        !isSeatCurrent(direction) ||
        !monitorContext.riskChecker.checkWarrantDistanceLiquidation(
          candidate.signal.symbol,
          direction === 'LONG',
          monitorQuote.price,
        ).shouldLiquidate
      )
        continue;

      if (!isCurrent())
        return hasSubmittedCandidate ? { kind: 'COMPLETED' } : { kind: 'RE_EVALUATE' };

      if (!isSeatCurrent(direction)) continue;

      // executor内部每个await与最终broker调用复用原receipt/组件/席位票，不在其内换票。
      const executionResult = await orderExecutor.executeSignals(
        [candidate.signal],
        () => isCurrent() && isSeatCurrent(direction),
      );
      const submitted = executionResult.executedOrderIds.length > 0;
      if (
        !submitted &&
        executionResult.quoteFailures.some(
          (failure) => failure.signal === candidate.signal && failure.kind === 'QUOTE_MISSING',
        )
      )
        hasPendingWait = true;

      hasSubmittedCandidate = hasSubmittedCandidate || submitted;
      // 已确认orderId是真实远端事实；原tracker负责终态，不因授权失效否认/取消/重提。
      if (
        submitted &&
        params.canContinue() &&
        snapshot.getView().token.dayEpoch === dayEpoch &&
        isSeatCurrent(direction)
      )
        params.onDirectionSubmitted?.(direction);

      if (!params.canContinue() || snapshot.getView().token.dayEpoch !== dayEpoch)
        return hasSubmittedCandidate ? { kind: 'COMPLETED' } : { kind: 'NOOP' };

      if (!isCurrent())
        return hasSubmittedCandidate ? { kind: 'COMPLETED' } : { kind: 'RE_EVALUATE' };

      if (!isSeatCurrent(direction) || executionResult.executedOrderIds.length !== 1) continue;

      const isLongDirection = direction === 'LONG';
      monitorContext.orderRecorder.clearBuyOrders(candidate.signal.symbol, isLongDirection);
      const prepared = monitorContext.riskChecker.prepareUnrealizedLossData(
        monitorContext.orderRecorder,
        candidate.signal.symbol,
        isLongDirection,
        monitorContext.dailyLossTracker.getLossOffset(direction),
      );
      // prepare不发布；最终校验—发布尾段没有await，旧结果不污染风险缓存。
      if (!isCurrent() || !isSeatCurrent(direction)) return { kind: 'COMPLETED' };

      monitorContext.riskChecker.publishUnrealizedLossData(prepared);
    }

    if (hasPendingWait) {
      if (!params.canContinue()) {
        return hasSubmittedCandidate ? { kind: 'COMPLETED' } : { kind: 'NOOP' };
      }

      return createStaticLiquidationWaitResult(
        wakeupSymbols,
        params.retryAttempts,
        now().getTime(),
      );
    }

    return hasSubmittedCandidate ? { kind: 'COMPLETED' } : { kind: 'NOOP' };
  };
}
