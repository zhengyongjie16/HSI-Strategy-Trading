/**
 * staticLiquidationExecutor
 *
 * 职责：
 * - 执行 monitor quote 驱动的静态距回收价清仓
 * - 复用历史清仓执行态的清仓、清缓存与浮亏刷新语义
 */
import { ORDER_QUOTE_RETRY, WARRANT_LIQUIDATION_ORDER_TYPE } from '../../constants/index.js';
import { validateSignalSeat } from '../../services/autoSymbolManager/utils.js';
import type { SellSignal } from '../../types/signal.js';
import type { MonitorContext } from '../../types/state.js';
import type { QuoteUpdatedEvent } from '../../types/services.js';
import { isSeatActive } from '../../utils/seat/guards.js';
import { isExternalApiRequestError } from '../../utils/apiFailure/index.js';
import type {
  CreateStaticLiquidationExecutorDeps,
  StaticLiquidationCandidate,
  StaticLiquidationCandidateResult,
  StaticLiquidationRuntimeResult,
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
 * 计算本轮 WAIT 后下一次 retry 的唤醒时间。
 *
 * @param retryAttempts 当前已执行的 retry 次数
 * @returns 下一次 retry 时间；达到上限时返回 null
 */
function resolveStaticLiquidationRetryAtMs(
  retryAttempts: number,
  waitResolvedAtMs: number,
): number | null {
  const nextRetryAttempts = retryAttempts + 1;
  if (nextRetryAttempts > ORDER_QUOTE_RETRY.MAX_ATTEMPTS) {
    return null;
  }

  return waitResolvedAtMs + ORDER_QUOTE_RETRY.INTERVAL_MS;
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
): Extract<StaticLiquidationRuntimeResult, { kind: 'WAIT' }> {
  return {
    kind: 'WAIT',
    wakeupSymbols,
    retryAtMs: resolveStaticLiquidationRetryAtMs(retryAttempts, waitResolvedAtMs),
  };
}

/**
 * 按方向创建静态距回收价清仓候选。
 *
 * @param params monitor 上下文、方向、monitor quote 与交易标的 quote
 * @returns 显式区分等待行情、跳过执行与生成候选三种结果
 */
function createStaticLiquidationCandidate(params: {
  readonly monitorContext: MonitorContext;
  readonly direction: 'LONG' | 'SHORT';
  readonly monitorQuote: QuoteUpdatedEvent['quote'];
  readonly tradingQuote: QuoteUpdatedEvent['quote'] | null;
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

  if (!Number.isFinite(availableQuantity) || availableQuantity <= 0) {
    return { kind: 'SKIP' };
  }

  const liquidationResult = monitorContext.riskChecker.checkWarrantDistanceLiquidation(
    seatState.symbol,
    isLongDirection,
    monitorQuote.price,
  );
  if (!liquidationResult.shouldLiquidate) {
    return { kind: 'SKIP' };
  }

  if (
    tradingQuote === null ||
    !Number.isFinite(tradingQuote.price) ||
    !Number.isFinite(tradingQuote.lotSize)
  ) {
    return { kind: 'WAIT' };
  }

  const signal: SellSignal = {
    symbol: seatState.symbol,
    symbolName: isLongDirection
      ? monitorContext.longSymbolName || seatState.symbol
      : monitorContext.shortSymbolName || seatState.symbol,
    action: isLongDirection ? 'SELLCALL' : 'SELLPUT',
    reason: liquidationResult.reason ?? '牛熊证距回收价触发清仓',
    quantity: availableQuantity,
    triggerTime: executionTime,
    orderTypeOverride: WARRANT_LIQUIDATION_ORDER_TYPE,
    isProtectiveLiquidation: false,
    seatVersion: monitorContext.symbolRegistry.getSeatVersion(direction),
  };

  return {
    kind: 'CANDIDATE',
    candidate: {
      signal,
      quote: tradingQuote,
    },
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
): (params: {
  readonly monitorContext: MonitorContext;
  readonly retryAttempts: number;
  readonly excludedDirections?: ReadonlySet<'LONG' | 'SHORT'>;
  readonly canContinue: () => boolean;
  readonly onDirectionSubmitted?: (direction: 'LONG' | 'SHORT') => void;
}) => Promise<StaticLiquidationRuntimeResult> {
  const { trader, marketDataClient, lastState, now } = deps;

  return async function executeStaticLiquidation(params: {
    readonly monitorContext: MonitorContext;
    readonly retryAttempts: number;
    readonly excludedDirections?: ReadonlySet<'LONG' | 'SHORT'>;
    readonly canContinue: () => boolean;
    readonly onDirectionSubmitted?: (direction: 'LONG' | 'SHORT') => void;
  }): Promise<StaticLiquidationRuntimeResult> {
    if (!params.canContinue()) {
      return { kind: 'NOOP' };
    }

    const { monitorContext } = params;
    const executionTime = now();
    const monitorSymbol = monitorContext.config.monitorSymbol;
    const longSeat = monitorContext.symbolRegistry.getSeatState('LONG');
    const shortSeat = monitorContext.symbolRegistry.getSeatState('SHORT');
    const longSymbol = isSeatActive(longSeat) ? longSeat.symbol : null;
    const shortSymbol = isSeatActive(shortSeat) ? shortSeat.symbol : null;
    const wakeupSymbols = buildStaticLiquidationWakeupSymbols({
      monitorSymbol,
      longSymbol,
      shortSymbol,
    });
    if (wakeupSymbols.length === 0) {
      return { kind: 'NOOP' };
    }

    let executionQuotes: Awaited<ReturnType<typeof marketDataClient.getQuotes>>;
    try {
      executionQuotes = await marketDataClient.getQuotes(wakeupSymbols);
    } catch (error) {
      if (!isExternalApiRequestError(error)) {
        throw error;
      }

      if (!params.canContinue()) {
        return { kind: 'NOOP' };
      }

      return createStaticLiquidationWaitResult(
        wakeupSymbols,
        params.retryAttempts,
        now().getTime(),
      );
    }

    if (!params.canContinue()) {
      return { kind: 'NOOP' };
    }

    const monitorQuote = executionQuotes.get(monitorSymbol) ?? null;
    if (monitorQuote === null || !Number.isFinite(monitorQuote.price)) {
      return createStaticLiquidationWaitResult(
        wakeupSymbols,
        params.retryAttempts,
        now().getTime(),
      );
    }

    const longQuote = longSymbol ? (executionQuotes.get(longSymbol) ?? null) : null;
    const shortQuote = shortSymbol ? (executionQuotes.get(shortSymbol) ?? null) : null;
    const longPosition = longSymbol ? lastState.positionCache.get(longSymbol) : null;
    const shortPosition = shortSymbol ? lastState.positionCache.get(shortSymbol) : null;
    const candidates: StaticLiquidationCandidate[] = [];
    let hasPendingWait = false;

    const longCandidateResult =
      longSymbol && !params.excludedDirections?.has('LONG')
        ? createStaticLiquidationCandidate({
            monitorContext,
            direction: 'LONG',
            monitorQuote,
            tradingQuote: longQuote,
            availableQuantity: longPosition?.availableQuantity ?? 0,
            executionTime,
          })
        : { kind: 'SKIP' as const };
    if (longCandidateResult.kind === 'CANDIDATE') {
      candidates.push(longCandidateResult.candidate);
    } else if (longCandidateResult.kind === 'WAIT') {
      hasPendingWait = true;
    }

    const shortCandidateResult =
      shortSymbol && !params.excludedDirections?.has('SHORT')
        ? createStaticLiquidationCandidate({
            monitorContext,
            direction: 'SHORT',
            monitorQuote,
            tradingQuote: shortQuote,
            availableQuantity: shortPosition?.availableQuantity ?? 0,
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

      const executionResult = await trader.executeSignals([candidate.signal]);
      if (!params.canContinue()) {
        return executionResult.executedOrderIds.length > 0 || hasSubmittedCandidate
          ? { kind: 'COMPLETED' }
          : { kind: 'NOOP' };
      }

      if (executionResult.executedOrderIds.length !== 1) {
        continue;
      }

      hasSubmittedCandidate = true;

      const isLongDirection = candidate.signal.action === 'SELLCALL';
      if (!params.canContinue()) {
        return { kind: 'COMPLETED' };
      }

      params.onDirectionSubmitted?.(isLongDirection ? 'LONG' : 'SHORT');
      if (!params.canContinue()) {
        return { kind: 'COMPLETED' };
      }

      monitorContext.orderRecorder.clearBuyOrders(
        candidate.signal.symbol,
        isLongDirection,
        candidate.quote,
      );
      const dailyLossOffset = monitorContext.dailyLossTracker.getLossOffset(
        isLongDirection ? 'LONG' : 'SHORT',
      );
      if (!params.canContinue()) {
        return { kind: 'COMPLETED' };
      }

      await monitorContext.riskChecker.refreshUnrealizedLossData(
        monitorContext.orderRecorder,
        candidate.signal.symbol,
        isLongDirection,
        candidate.quote,
        dailyLossOffset,
      );

      if (!params.canContinue()) {
        return { kind: 'COMPLETED' };
      }
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
