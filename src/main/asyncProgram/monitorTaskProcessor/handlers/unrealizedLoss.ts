/**
 * 浮亏清仓检查任务处理
 *
 * 功能：
 * - 校验席位快照并触发浮亏监控
 * - 根据监控结果执行保护性清仓
 * - 无有效席位时跳过处理
 */
import { ORDER_QUOTE_RETRY } from '../../../../constants/index.js';
import type { Position } from '../../../../types/account.js';
import type { Trader, MarketDataClient } from '../../../../types/services.js';
import type { RefreshGate } from '../../../../utils/types.js';
import {
  isQuoteReadyForRequirement,
  resolveNextQuoteRetry,
} from '../../../../utils/quoteRetry/index.js';
import { logger } from '../../../../utils/logger/index.js';
import type { MonitorTask } from '../../monitorTaskQueue/types.js';
import type {
  MonitorTaskContext,
  MonitorTaskDataMap,
  MonitorTaskRetryRequest,
  MonitorTaskStatus,
  UnrealizedLossCheckTaskData,
} from '../types.js';
import { evaluateStrategyRuntimeAndSeatReadiness } from '../utils.js';

export function createUnrealizedLossHandler({
  baseInstrumentSymbol,
  getContextOrSkip,
  refreshGate,
  trader,
  marketDataClient,
  getCanProcessTask,
}: {
  readonly baseInstrumentSymbol: string;
  readonly getContextOrSkip: () => MonitorTaskContext | null;
  readonly refreshGate: RefreshGate;
  readonly trader: Trader;
  readonly marketDataClient: MarketDataClient;
  readonly getCanProcessTask?: () => boolean;
}): (task: MonitorTask<MonitorTaskDataMap, 'UNREALIZED_LOSS_CHECK'>) => Promise<{
  readonly status: MonitorTaskStatus;
  readonly retryRequest: MonitorTaskRetryRequest<'UNREALIZED_LOSS_CHECK'> | null;
}> {
  return async function handleUnrealizedLossCheck(
    task: MonitorTask<MonitorTaskDataMap, 'UNREALIZED_LOSS_CHECK'>,
  ): Promise<{
    readonly status: MonitorTaskStatus;
    readonly retryRequest: MonitorTaskRetryRequest<'UNREALIZED_LOSS_CHECK'> | null;
  }> {
    const data: UnrealizedLossCheckTaskData = task.data;
    const evaluated = await evaluateStrategyRuntimeAndSeatReadiness({
      getContextOrSkip,
      refreshGate,
      baseInstrumentSymbol,
      longSnapshot: { seatVersion: data.long.seatVersion, symbol: data.long.symbol },
      shortSnapshot: { seatVersion: data.short.seatVersion, symbol: data.short.symbol },
    });
    if (!evaluated) {
      return { status: 'skipped', retryRequest: null };
    }

    const { context, seatReadiness } = evaluated;
    const { isLongReady, isShortReady, longSymbol, shortSymbol } = seatReadiness;
    const retryKey = 'UNREALIZED_LOSS_CHECK';
    const previousRetryAttempts =
      typeof data.retryAttempts === 'number' && Number.isFinite(data.retryAttempts)
        ? data.retryAttempts
        : 0;
    const quoteSymbols: string[] = [];
    if (isLongReady) {
      quoteSymbols.push(longSymbol);
    }

    if (isShortReady) {
      quoteSymbols.push(shortSymbol);
    }

    const executionQuotes = await marketDataClient.getQuotes(quoteSymbols);
    const longQuote = isLongReady ? (executionQuotes.get(longSymbol) ?? null) : null;
    const shortQuote = isShortReady ? (executionQuotes.get(shortSymbol) ?? null) : null;
    const longQuoteReady =
      isLongReady && isQuoteReadyForRequirement({ quote: longQuote, requirement: 'PRICE' });
    const shortQuoteReady =
      isShortReady && isQuoteReadyForRequirement({ quote: shortQuote, requirement: 'PRICE' });
    const readyPositionSymbols = [
      longQuoteReady ? longSymbol : '',
      shortQuoteReady ? shortSymbol : '',
    ].filter((symbol) => symbol.length > 0);
    const executionPositions =
      readyPositionSymbols.length > 0 ? await trader.getStockPositions(readyPositionSymbols) : [];
    const resolvePosition = (symbol: string): Position | null => {
      return executionPositions.find((position) => position.symbol === symbol) ?? null;
    };
    const unresolvedSymbols = new Set<string>();
    if (isLongReady && !longQuoteReady && longSymbol.length > 0) {
      unresolvedSymbols.add(longSymbol);
    }

    if (isShortReady && !shortQuoteReady && shortSymbol.length > 0) {
      unresolvedSymbols.add(shortSymbol);
    }

    if (!longSymbol && !shortSymbol) {
      return { status: 'skipped', retryRequest: null };
    }

    if (getCanProcessTask && !getCanProcessTask()) {
      return { status: 'skipped', retryRequest: null };
    }

    const readyLongSymbol = longQuoteReady ? longSymbol : '';
    const readyShortSymbol = shortQuoteReady ? shortSymbol : '';
    if (readyLongSymbol.length > 0 || readyShortSymbol.length > 0) {
      await context.unrealizedLossMonitor.monitorUnrealizedLoss({
        longQuote: longQuoteReady ? longQuote : null,
        shortQuote: shortQuoteReady ? shortQuote : null,
        longSymbol: readyLongSymbol,
        shortSymbol: readyShortSymbol,
        longPosition: readyLongSymbol.length > 0 ? resolvePosition(readyLongSymbol) : null,
        shortPosition: readyShortSymbol.length > 0 ? resolvePosition(readyShortSymbol) : null,
        baseInstrumentSymbol,
        riskChecker: context.riskChecker,
        trader,
        dailyLossTracker: context.dailyLossTracker,
      });
    }

    if (unresolvedSymbols.size > 0) {
      const nextRetry = resolveNextQuoteRetry({
        attempts: previousRetryAttempts,
        nowMs: Date.now(),
        intervalMs: ORDER_QUOTE_RETRY.INTERVAL_MS,
        maxAttempts: ORDER_QUOTE_RETRY.MAX_ATTEMPTS,
      });
      if (nextRetry.exhausted) {
        logger.warn(
          `[MonitorTaskProcessor] UNREALIZED_LOSS_CHECK 行情重试耗尽: ${baseInstrumentSymbol} symbols=${[...unresolvedSymbols].join(',')}`,
        );
        return { status: 'processed', retryRequest: null };
      }

      return {
        status: 'processed',
        retryRequest: {
          retryKey,
          attempts: nextRetry.nextAttempts,
          requirement: 'PRICE',
          task: {
            type: task.type,
            dedupeKey: task.dedupeKey,
            data: {
              ...task.data,
              retryAttempts: nextRetry.nextAttempts,
              long: unresolvedSymbols.has(longSymbol)
                ? { ...task.data.long }
                : { ...task.data.long, symbol: null },
              short: unresolvedSymbols.has(shortSymbol)
                ? { ...task.data.short }
                : { ...task.data.short, symbol: null },
            },
          },
        },
      };
    }

    return { status: 'processed', retryRequest: null };
  };
}
