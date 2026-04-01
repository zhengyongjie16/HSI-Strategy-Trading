/**
 * orderMonitor 终态结算模块
 *
 * 职责：
 * - 对已确认终态订单执行唯一副作用结算
 * - 维护 recentFilled 摘要、tradeLogger 写入与冷却链路更新
 * - 在缺少归属上下文时拒绝结算，避免错误记账
 */
import { OrderSide } from 'longbridge';
import { isValidPositiveNumber } from '../../../utils/helpers/index.js';
import { toHongKongTimeIso } from '../../../utils/time/index.js';
import { recordTrade } from '../tradeLogger.js';
import type { StrategyRuntimeConfig } from '../../../types/config.js';
import type { RecentFilledOrderSummary } from '../../../types/services.js';
import type { TrackedOrder } from '../types.js';
import type {
  FinalizeOrderSettlementParams,
  FinalizeOrderSettlementResult,
  SettlementFlow,
  SettlementFlowDeps,
} from './types.js';
import { resolveSignalAction } from './utils.js';

function resolveOrderSideText(orderSide: OrderSide): 'BUY' | 'SELL' {
  return orderSide === OrderSide.Buy ? 'BUY' : 'SELL';
}

function resolveOrderSideFromText(side: 'BUY' | 'SELL'): OrderSide {
  return side === 'BUY' ? OrderSide.Buy : OrderSide.Sell;
}

function resolveCloseContext(params: {
  readonly trackedOrder: TrackedOrder | undefined;
  readonly closeParams: FinalizeOrderSettlementParams;
  readonly monitorConfig: StrategyRuntimeConfig;
}): {
  readonly side: 'BUY' | 'SELL' | null;
  readonly symbol: string | null;
  readonly baseInstrumentSymbol: string | null;
  readonly isLongSymbol: boolean | undefined;
  readonly isProtectiveLiquidation: boolean;
  readonly liquidationTriggerLimit: number;
  readonly liquidationCooldownConfig: StrategyRuntimeConfig['liquidationCooldown'];
  readonly executedPrice: number | null;
  readonly executedQuantity: number | null;
  readonly executedTimeMs: number | null;
} {
  const { trackedOrder, closeParams, monitorConfig } = params;
  const side = closeParams.side ?? (trackedOrder ? resolveOrderSideText(trackedOrder.side) : null);
  return {
    side,
    symbol: trackedOrder?.symbol ?? closeParams.symbol ?? null,
    baseInstrumentSymbol:
      trackedOrder?.baseInstrumentSymbol ?? closeParams.baseInstrumentSymbol ?? null,
    isLongSymbol: trackedOrder?.isLongSymbol ?? closeParams.isLongSymbol,
    isProtectiveLiquidation:
      trackedOrder?.isProtectiveLiquidation ?? closeParams.isProtectiveLiquidation ?? false,
    liquidationTriggerLimit:
      trackedOrder?.liquidationTriggerLimit ??
      closeParams.liquidationTriggerLimit ??
      monitorConfig.liquidationTriggerLimit,
    liquidationCooldownConfig:
      trackedOrder?.liquidationCooldownConfig ??
      closeParams.liquidationCooldownConfig ??
      monitorConfig.liquidationCooldown,
    executedPrice: closeParams.executedPrice ?? trackedOrder?.executedPrice ?? null,
    executedQuantity: closeParams.executedQuantity ?? trackedOrder?.executedQuantity ?? null,
    executedTimeMs: closeParams.executedTimeMs ?? trackedOrder?.lastExecutedTimeMs ?? null,
  };
}

function resolveRecordedExecution(params: {
  readonly executedPrice: number | null;
  readonly executedQuantity: number | null;
  readonly executedTimeMs: number | null;
}): {
  readonly executedPrice: number;
  readonly executedQuantity: number;
  readonly executedTimeMs: number;
} | null {
  if (
    !isValidPositiveNumber(params.executedPrice) ||
    !isValidPositiveNumber(params.executedQuantity) ||
    !isValidPositiveNumber(params.executedTimeMs)
  ) {
    return null;
  }

  return {
    executedPrice: params.executedPrice,
    executedQuantity: params.executedQuantity,
    executedTimeMs: params.executedTimeMs,
  };
}

function hasExecutionAttributionContext(params: {
  readonly side: 'BUY' | 'SELL' | null;
  readonly symbol: string | null;
  readonly isLongSymbol: boolean | undefined;
}): boolean {
  const { side, symbol, isLongSymbol } = params;
  return side !== null && symbol !== null && isLongSymbol !== undefined;
}

export function createSettlementFlow(deps: SettlementFlowDeps): SettlementFlow {
  const {
    runtime,
    orderHoldRegistry,
    dailyLossTracker,
    protectiveLiquidationEpisodeTracker,
    monitorConfig,
    refreshGate,
  } = deps;

  function clearRuntimeTracking(orderId: string): void {
    runtime.trackedOrders.delete(orderId);
    runtime.trackedOrderLifecycles.set(orderId, 'CLOSED');
    orderHoldRegistry.markOrderClosed(orderId);
  }

  function markPostTradeRefresh(symbol: string, isLongSymbol: boolean): void {
    refreshGate?.markStale();
    runtime.pendingRefreshSymbols.push({
      symbol,
      isLongSymbol,
      refreshAccount: true,
      refreshPositions: true,
    });
  }

  function recordRecentFilledOrder(summary: RecentFilledOrderSummary): void {
    runtime.recentFilledOrders.set(summary.orderId, summary);
  }

  function recordDailyLossAndEpisodeProgress(params: {
    readonly orderId: string;
    readonly side: 'BUY' | 'SELL';
    readonly baseInstrumentSymbol: string | null;
    readonly symbol: string | null;
    readonly isLongSymbol: boolean | undefined;
    readonly isProtectiveLiquidation: boolean;
    readonly executedPrice: number | null;
    readonly executedQuantity: number | null;
    readonly executedTimeMs: number | null;
  }): void {
    const {
      orderId,
      side,
      baseInstrumentSymbol,
      symbol,
      isLongSymbol,
      isProtectiveLiquidation,
      executedPrice,
      executedQuantity,
      executedTimeMs,
    } = params;
    if (
      !baseInstrumentSymbol ||
      !symbol ||
      isLongSymbol === undefined ||
      !isValidPositiveNumber(executedPrice) ||
      !isValidPositiveNumber(executedQuantity) ||
      !isValidPositiveNumber(executedTimeMs)
    ) {
      return;
    }

    const orderSide = resolveOrderSideFromText(side);
    dailyLossTracker.recordFilledOrder({
      direction: isLongSymbol ? 'LONG' : 'SHORT',
      symbol,
      side: orderSide,
      executedPrice,
      executedQuantity,
      executedTimeMs,
      orderId,
    });

    if (isProtectiveLiquidation && orderSide === OrderSide.Sell) {
      const direction = isLongSymbol ? 'LONG' : 'SHORT';
      protectiveLiquidationEpisodeTracker.recordProtectiveFillProgress({
        direction,
        executedTimeMs,
      });
    }
  }

  function recordFilledTradeLog(params: {
    readonly orderId: string;
    readonly side: 'BUY' | 'SELL';
    readonly symbol: string | null;
    readonly baseInstrumentSymbol: string | null;
    readonly isLongSymbol: boolean | undefined;
    readonly isProtectiveLiquidation: boolean;
    readonly closedReason: FinalizeOrderSettlementParams['closedReason'];
    readonly executedPrice: number | null;
    readonly executedQuantity: number | null;
    readonly executedTimeMs: number | null;
  }): void {
    const {
      orderId,
      side,
      symbol,
      baseInstrumentSymbol,
      isLongSymbol,
      isProtectiveLiquidation,
      closedReason,
      executedPrice,
      executedQuantity,
      executedTimeMs,
    } = params;
    if (
      !symbol ||
      isLongSymbol === undefined ||
      !isValidPositiveNumber(executedPrice) ||
      !isValidPositiveNumber(executedQuantity) ||
      !isValidPositiveNumber(executedTimeMs)
    ) {
      return;
    }

    const signalAction = resolveSignalAction(resolveOrderSideFromText(side), isLongSymbol);
    recordTrade({
      orderId,
      symbol,
      symbolName: null,
      baseInstrumentSymbol,
      action: signalAction,
      side,
      quantity: String(executedQuantity),
      price: String(executedPrice),
      orderType: null,
      status: 'FILLED',
      error: null,
      reason: closedReason === 'FILLED' ? null : closedReason,
      signalTriggerTime: null,
      executedAt: toHongKongTimeIso(new Date(executedTimeMs)),
      executedAtMs: executedTimeMs,
      timestamp: null,
      isProtectiveClearance: isProtectiveLiquidation,
    });
  }

  function settleOrder(params: FinalizeOrderSettlementParams): FinalizeOrderSettlementResult {
    const { orderId, closedReason } = params;
    if (runtime.closedOrderIds.has(orderId)) {
      return {
        handled: false,
      };
    }

    const trackedOrder = runtime.trackedOrders.get(orderId);
    const context = resolveCloseContext({
      trackedOrder,
      closeParams: params,
      monitorConfig,
    });
    const side = context.side;
    const symbol = context.symbol;
    const isLongSymbol = context.isLongSymbol;
    const executedPrice = context.executedPrice;
    const executedQuantity = context.executedQuantity;
    const executedTimeMs = context.executedTimeMs;
    const recordedExecution = resolveRecordedExecution({
      executedPrice,
      executedQuantity,
      executedTimeMs,
    });
    const executionContextReady = hasExecutionAttributionContext({
      side,
      symbol,
      isLongSymbol,
    });
    if (recordedExecution !== null && !executionContextReady) {
      return {
        handled: false,
      };
    }

    if (closedReason === 'FILLED') {
      if (
        !symbol ||
        !side ||
        isLongSymbol === undefined ||
        !isValidPositiveNumber(executedPrice) ||
        !isValidPositiveNumber(executedQuantity) ||
        !isValidPositiveNumber(executedTimeMs)
      ) {
        return {
          handled: false,
        };
      }

      recordRecentFilledOrder({
        orderId,
        symbol,
        side: resolveOrderSideFromText(side),
        executedPrice,
        executedQuantity,
        executedTimeMs,
      });

      recordDailyLossAndEpisodeProgress({
        orderId,
        side,
        baseInstrumentSymbol: context.baseInstrumentSymbol,
        symbol,
        isLongSymbol,
        isProtectiveLiquidation: context.isProtectiveLiquidation,
        executedPrice,
        executedQuantity,
        executedTimeMs,
      });

      recordFilledTradeLog({
        orderId,
        side,
        symbol,
        baseInstrumentSymbol: context.baseInstrumentSymbol,
        isLongSymbol,
        isProtectiveLiquidation: context.isProtectiveLiquidation,
        closedReason,
        executedPrice,
        executedQuantity,
        executedTimeMs,
      });
      markPostTradeRefresh(symbol, isLongSymbol);
    }

    if (
      (closedReason === 'CANCELED' || closedReason === 'REJECTED') &&
      symbol &&
      side &&
      isLongSymbol !== undefined &&
      recordedExecution !== null
    ) {
      recordRecentFilledOrder({
        orderId,
        symbol,
        side: resolveOrderSideFromText(side),
        executedPrice: recordedExecution.executedPrice,
        executedQuantity: recordedExecution.executedQuantity,
        executedTimeMs: recordedExecution.executedTimeMs,
      });

      recordDailyLossAndEpisodeProgress({
        orderId,
        side,
        baseInstrumentSymbol: context.baseInstrumentSymbol,
        symbol,
        isLongSymbol,
        isProtectiveLiquidation: context.isProtectiveLiquidation,
        executedPrice: recordedExecution.executedPrice,
        executedQuantity: recordedExecution.executedQuantity,
        executedTimeMs: recordedExecution.executedTimeMs,
      });

      recordFilledTradeLog({
        orderId,
        side,
        symbol,
        baseInstrumentSymbol: context.baseInstrumentSymbol,
        isLongSymbol,
        isProtectiveLiquidation: context.isProtectiveLiquidation,
        closedReason,
        executedPrice: recordedExecution.executedPrice,
        executedQuantity: recordedExecution.executedQuantity,
        executedTimeMs: recordedExecution.executedTimeMs,
      });
      markPostTradeRefresh(symbol, isLongSymbol);
    }

    runtime.closedOrderIds.add(orderId);
    clearRuntimeTracking(orderId);
    return {
      handled: true,
    };
  }

  return {
    settleOrder,
  };
}
