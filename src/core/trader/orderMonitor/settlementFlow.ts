/**
 * orderMonitor 终态结算模块
 *
 * 职责：
 * - 对已确认终态订单执行唯一副作用结算
 * - 维护买卖记录与冷却链路更新
 * - 在缺少归属上下文时拒绝结算，避免错误记账
 */
import { OrderSide } from 'longbridge';
import { isValidPositiveNumber } from '../../../utils/helpers/index.js';
import type { OrderRecorder, PostTradeConsistencyRefreshNeed } from '../../../types/services.js';
import type { TrackedOrder } from '../types.js';
import type { DailyLossCumulativeExecutionResult } from '../../../types/risk.js';
import type {
  FinalizeOrderSettlementParams,
  FinalizeOrderSettlementResult,
  OrderCumulativeExecutionParams,
  SettlementFlow,
  SettlementFlowDeps,
} from './types.js';
import { detachTrackedOrder } from './routingIndex.js';
import { compareBuyOrdersBySellPriority } from '../../orderRecorder/sellDeductionPolicy.js';

function resolveOrderSideText(orderSide: OrderSide): 'BUY' | 'SELL' {
  return orderSide === OrderSide.Buy ? 'BUY' : 'SELL';
}

function resolveOrderSideFromText(side: 'BUY' | 'SELL'): OrderSide.Buy | OrderSide.Sell {
  return side === 'BUY' ? OrderSide.Buy : OrderSide.Sell;
}

function resolveExactFilledRelatedBuyOrderIds(params: {
  readonly orderRecorder: OrderRecorder;
  readonly symbol: string;
  readonly isLongSymbol: boolean;
  readonly relatedBuyOrderIds: ReadonlyArray<string>;
  readonly filledQuantity: number;
}): ReadonlyArray<string> | null {
  const { orderRecorder, symbol, isLongSymbol, relatedBuyOrderIds, filledQuantity } = params;
  if (relatedBuyOrderIds.length === 0 || !isValidPositiveNumber(filledQuantity)) {
    return null;
  }

  const relatedBuyOrderIdSet = new Set(relatedBuyOrderIds);
  const relatedBuyOrders = orderRecorder
    .getBuyOrdersForSymbol(symbol, isLongSymbol)
    .filter((order) => relatedBuyOrderIdSet.has(order.orderId))
    .sort(compareBuyOrdersBySellPriority);
  if (relatedBuyOrders.length !== relatedBuyOrderIds.length) {
    return null;
  }

  const settledOrderIds: string[] = [];
  let matchedQuantity = 0;
  for (const order of relatedBuyOrders) {
    if (!isValidPositiveNumber(order.executedQuantity)) {
      return null;
    }

    matchedQuantity += order.executedQuantity;
    if (matchedQuantity > filledQuantity) {
      return null;
    }

    settledOrderIds.push(order.orderId);
    if (matchedQuantity === filledQuantity) {
      return settledOrderIds;
    }
  }

  return null;
}

function settleSellExecutedPart(params: {
  readonly orderRecorder: OrderRecorder;
  readonly orderId: string;
  readonly symbol: string;
  readonly isLongSymbol: boolean;
  readonly executedPrice: number | null;
  readonly executedQuantity: number | null;
  readonly executedTimeMs: number | null;
  readonly relatedBuyOrderIds: ReadonlyArray<string>;
}): {
  readonly remainingRelatedBuyOrderIds: ReadonlyArray<string> | null;
} {
  const {
    orderRecorder,
    orderId,
    symbol,
    isLongSymbol,
    executedPrice,
    executedQuantity,
    executedTimeMs,
    relatedBuyOrderIds,
  } = params;
  if (
    !isValidPositiveNumber(executedPrice) ||
    !isValidPositiveNumber(executedQuantity) ||
    !isValidPositiveNumber(executedTimeMs)
  ) {
    return {
      remainingRelatedBuyOrderIds: relatedBuyOrderIds.length > 0 ? relatedBuyOrderIds : null,
    };
  }

  const settledRelatedBuyOrderIds = resolveExactFilledRelatedBuyOrderIds({
    orderRecorder,
    symbol,
    isLongSymbol,
    relatedBuyOrderIds,
    filledQuantity: executedQuantity,
  });
  orderRecorder.recordLocalSell(
    symbol,
    executedPrice,
    executedQuantity,
    isLongSymbol,
    executedTimeMs,
    orderId,
    settledRelatedBuyOrderIds,
  );

  if (settledRelatedBuyOrderIds === null) {
    return {
      remainingRelatedBuyOrderIds: null,
    };
  }

  const currentBuyOrderIdSet = new Set(
    orderRecorder.getBuyOrdersForSymbol(symbol, isLongSymbol).map((order) => order.orderId),
  );
  const settledOrderIdSet = new Set(settledRelatedBuyOrderIds);
  const remainingRelatedBuyOrderIds = relatedBuyOrderIds.filter(
    (relatedBuyOrderId) =>
      currentBuyOrderIdSet.has(relatedBuyOrderId) && !settledOrderIdSet.has(relatedBuyOrderId),
  );

  return {
    remainingRelatedBuyOrderIds:
      remainingRelatedBuyOrderIds.length > 0 ? remainingRelatedBuyOrderIds : null,
  };
}

function resolveCloseContext(params: {
  readonly trackedOrder: TrackedOrder | undefined;
  readonly closeParams: FinalizeOrderSettlementParams;
}): {
  readonly side: 'BUY' | 'SELL' | null;
  readonly symbol: string | null;
  readonly monitorSymbol: string | null;
  readonly isLongSymbol: boolean | undefined;
  readonly isProtectiveLiquidation: boolean;
  readonly executedPrice: number | null;
  readonly executedQuantity: number | null;
  readonly executedTimeMs: number | null;
  readonly orderUpdatedAtMs: number | null;
} {
  const { trackedOrder, closeParams } = params;
  const side = closeParams.side ?? (trackedOrder ? resolveOrderSideText(trackedOrder.side) : null);
  const isProtectiveLiquidation =
    trackedOrder?.isProtectiveLiquidation ?? closeParams.isProtectiveLiquidation ?? false;
  const requiresAcceptedProtectiveExecution = isProtectiveLiquidation && side === 'SELL';
  return {
    side,
    symbol: trackedOrder?.symbol ?? closeParams.symbol ?? null,
    monitorSymbol: trackedOrder?.monitorSymbol ?? closeParams.monitorSymbol ?? null,
    isLongSymbol: trackedOrder?.isLongSymbol ?? closeParams.isLongSymbol,
    isProtectiveLiquidation,
    // 保护性 SELL 的正成交只能来自已通过 raw 准入的当前结算载荷；
    // 禁止回填 tracked 历史价格、数量或时间，把缺失的 broker 事实伪装为可结算事实。
    executedPrice: requiresAcceptedProtectiveExecution
      ? (closeParams.executedPrice ?? null)
      : (closeParams.executedPrice ?? trackedOrder?.executedPrice ?? null),
    executedQuantity: requiresAcceptedProtectiveExecution
      ? (closeParams.executedQuantity ?? null)
      : (closeParams.executedQuantity ?? trackedOrder?.executedQuantity ?? null),
    executedTimeMs: requiresAcceptedProtectiveExecution
      ? (closeParams.executedTimeMs ?? null)
      : (closeParams.executedTimeMs ?? trackedOrder?.lastExecutedTimeMs ?? null),
    orderUpdatedAtMs: closeParams.orderUpdatedAtMs ?? null,
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
  readonly monitorSymbol: string | null;
  readonly isLongSymbol: boolean | undefined;
}): boolean {
  const { side, symbol, monitorSymbol, isLongSymbol } = params;
  return side !== null && symbol !== null && monitorSymbol !== null && isLongSymbol !== undefined;
}

/**
 * 保护性 SELL 的正累计成交必须先具备可持久化的完整事实。
 *
 * 禁止把缺失的时间、revision 或归属降级为“未成交”：一旦允许后续本地结算，
 * pending sell、订单追踪与状态事件会关闭，但不可恢复的保护性成交事实会永久丢失。
 */
function assertProtectiveSellExecutionFactsReady(params: {
  readonly orderId: string;
  readonly side: OrderCumulativeExecutionParams['side'] | null;
  readonly symbol: string | null;
  readonly monitorSymbol: string | null;
  readonly isLongSymbol: boolean | undefined;
  readonly isProtectiveLiquidation: boolean;
  readonly executedPrice: number | null;
  readonly executedQuantity: number | null;
  readonly executedTimeMs: number | null;
  readonly orderUpdatedAtMs: number | null;
}): void {
  const {
    orderId,
    side,
    symbol,
    monitorSymbol,
    isLongSymbol,
    isProtectiveLiquidation,
    executedPrice,
    executedQuantity,
    executedTimeMs,
    orderUpdatedAtMs,
  } = params;
  if (!isProtectiveLiquidation || side !== 'SELL' || !isValidPositiveNumber(executedQuantity)) {
    return;
  }

  if (
    !hasExecutionAttributionContext({
      side,
      symbol,
      monitorSymbol,
      isLongSymbol,
    })
  ) {
    throw new Error(
      `[订单监控] 订单 ${orderId} 存在成交事实但缺少唯一 monitor/direction 归因，阻断结算`,
    );
  }

  if (
    !isValidPositiveNumber(executedPrice) ||
    !isValidPositiveNumber(executedTimeMs) ||
    !isValidPositiveNumber(orderUpdatedAtMs)
  ) {
    throw new Error(
      `[订单监控] 订单 ${orderId} 保护性 SELL 存在正累计成交但执行事实不完整，阻断结算`,
    );
  }

  if (executedTimeMs > orderUpdatedAtMs) {
    throw new Error(`[订单监控] 订单 ${orderId} 保护性 SELL 执行时间晚于 order revision，阻断结算`);
  }
}

function reserveFollowUpSellOccupancy(params: {
  readonly orderRecorder: OrderRecorder;
  readonly orderId: string;
  readonly symbol: string;
  readonly isLongSymbol: boolean;
  readonly followUpQuantity: number;
  readonly relatedBuyOrderIds: ReadonlyArray<string> | null;
}): ReadonlyArray<string> {
  const { orderRecorder, orderId, symbol, isLongSymbol, followUpQuantity, relatedBuyOrderIds } =
    params;
  const direction: 'LONG' | 'SHORT' = isLongSymbol ? 'LONG' : 'SHORT';
  const resolvedRelatedBuyOrderIds =
    relatedBuyOrderIds ??
    orderRecorder.allocateRelatedBuyOrderIdsForRecovery(symbol, direction, followUpQuantity);
  orderRecorder.submitSellOrder(
    orderId,
    symbol,
    direction,
    followUpQuantity,
    resolvedRelatedBuyOrderIds,
  );

  return resolvedRelatedBuyOrderIds;
}

/**
 * 新终态结算流程：只处理已确认终态，不做终态推理。
 */
export function createSettlementFlow(deps: SettlementFlowDeps): SettlementFlow {
  const {
    runtime,
    orderHoldRegistry,
    orderRecorder,
    dailyLossTracker,
    protectiveLiquidationEpisodeTracker,
    persistProtectiveLiquidationExecutionProgress,
    postTradeConsistencyRuntime,
    emitOrderStateChanged,
  } = deps;

  /**
   * 清理订单运行态，并在删除 tracked order 前基于 symbol 释放 routing index。
   *
   * @param orderId 订单 ID
   * @returns 无返回值
   */
  function clearRuntimeTracking(orderId: string): void {
    const trackedOrder = runtime.trackedOrders.get(orderId);
    if (trackedOrder) {
      detachTrackedOrder(runtime, trackedOrder.symbol, orderId);
    }

    runtime.trackedOrders.delete(orderId);
    runtime.trackedOrderLifecycles.set(orderId, 'CLOSED');
    orderHoldRegistry.markOrderClosed(orderId);
  }

  function markPostTradeRefresh(): void {
    const refreshNeed: PostTradeConsistencyRefreshNeed = {
      refreshAccount: true,
      refreshPositions: true,
    };
    postTradeConsistencyRuntime.recordSettlementRefreshNeed(refreshNeed);
  }

  function recordCumulativeExecutionFact(
    params: OrderCumulativeExecutionParams,
  ): DailyLossCumulativeExecutionResult {
    const {
      orderId,
      side,
      monitorSymbol,
      symbol,
      isLongSymbol,
      isProtectiveLiquidation,
      executedPrice,
      executedQuantity,
      executedTimeMs,
      orderUpdatedAtMs,
      factStage,
    } = params;
    if (
      !monitorSymbol ||
      !isValidPositiveNumber(executedPrice) ||
      !isValidPositiveNumber(executedQuantity) ||
      !isValidPositiveNumber(executedTimeMs) ||
      !isValidPositiveNumber(orderUpdatedAtMs)
    ) {
      return { authoritativeFactChanged: false, executionAdvanced: false };
    }

    const orderSide = resolveOrderSideFromText(side);
    const direction = isLongSymbol ? 'LONG' : 'SHORT';
    const result = dailyLossTracker.recordCumulativeExecution(
      {
        factStage,
        direction,
        symbol,
        side: orderSide,
        executedPrice,
        executedQuantity,
        executedTimeMs,
        orderUpdatedAtMs,
        orderId,
      },
      isProtectiveLiquidation && orderSide === OrderSide.Sell
        ? (snapshot) => {
            persistProtectiveLiquidationExecutionProgress({
              monitorSymbol,
              direction,
              symbol,
              orderId,
              ...snapshot,
            });
          }
        : undefined,
    );

    return result;
  }

  function applyCumulativeExecutionSideEffects(
    params: OrderCumulativeExecutionParams,
    result: DailyLossCumulativeExecutionResult,
  ): void {
    const { isLongSymbol, isProtectiveLiquidation, side, symbol, executedTimeMs } = params;
    const orderSide = resolveOrderSideFromText(side);
    const direction = isLongSymbol ? 'LONG' : 'SHORT';
    if (
      result.executionAdvanced &&
      isProtectiveLiquidation &&
      orderSide === OrderSide.Sell &&
      isValidPositiveNumber(executedTimeMs)
    ) {
      protectiveLiquidationEpisodeTracker.recordProtectiveFillProgress({
        direction,
        symbol,
        executedTimeMs,
      });
    }

    if (result.authoritativeFactChanged) {
      markPostTradeRefresh();
    }
  }

  function recordCumulativeExecution(
    params: OrderCumulativeExecutionParams,
  ): DailyLossCumulativeExecutionResult {
    assertProtectiveSellExecutionFactsReady({
      orderId: params.orderId,
      side: params.side,
      symbol: params.symbol,
      monitorSymbol: params.monitorSymbol,
      isLongSymbol: params.isLongSymbol,
      isProtectiveLiquidation: params.isProtectiveLiquidation,
      executedPrice: params.executedPrice,
      executedQuantity: params.executedQuantity,
      executedTimeMs: params.executedTimeMs,
      orderUpdatedAtMs: params.orderUpdatedAtMs,
    });
    const result = recordCumulativeExecutionFact(params);
    applyCumulativeExecutionSideEffects(params, result);
    return result;
  }

  /**
   * 为超时转市价路径的保护性 SELL 终态先提交 durable progress。
   * 该阶段只提交持久化与 DailyLoss fact，任何 recorder、runtime 或 episode 副作用都留给正式结算。
   */
  function prepareProtectiveTerminalExecution(
    params: FinalizeOrderSettlementParams,
  ): DailyLossCumulativeExecutionResult | null {
    const trackedOrder = runtime.trackedOrders.get(params.orderId);
    const context = resolveCloseContext({
      trackedOrder,
      closeParams: params,
    });
    assertProtectiveSellExecutionFactsReady({
      orderId: params.orderId,
      side: context.side,
      symbol: context.symbol,
      monitorSymbol: context.monitorSymbol,
      isLongSymbol: context.isLongSymbol,
      isProtectiveLiquidation: context.isProtectiveLiquidation,
      executedPrice: context.executedPrice,
      executedQuantity: context.executedQuantity,
      executedTimeMs: context.executedTimeMs,
      orderUpdatedAtMs: context.orderUpdatedAtMs,
    });
    const recordedExecution = resolveRecordedExecution({
      executedPrice: context.executedPrice,
      executedQuantity: context.executedQuantity,
      executedTimeMs: context.executedTimeMs,
    });
    if (!context.isProtectiveLiquidation || context.side !== 'SELL' || recordedExecution === null) {
      return null;
    }

    if (
      !hasExecutionAttributionContext({
        side: context.side,
        symbol: context.symbol,
        monitorSymbol: context.monitorSymbol,
        isLongSymbol: context.isLongSymbol,
      })
    ) {
      throw new Error(
        `[订单监控] 订单 ${params.orderId} 存在成交事实但缺少唯一 monitor/direction 归因，阻断结算`,
      );
    }

    if (!isValidPositiveNumber(context.orderUpdatedAtMs)) {
      throw new Error(
        `[订单监控] 订单 ${params.orderId} 存在成交事实但缺少 order revision，阻断结算`,
      );
    }

    if (context.symbol === null || context.isLongSymbol === undefined) {
      throw new Error(`[订单监控] 订单 ${params.orderId} 的保护性终态归因不完整，阻断结算`);
    }

    const executionParams = {
      factStage: 'TERMINAL',
      orderId: params.orderId,
      side: context.side,
      monitorSymbol: context.monitorSymbol,
      symbol: context.symbol,
      isLongSymbol: context.isLongSymbol,
      isProtectiveLiquidation: true,
      executedPrice: recordedExecution.executedPrice,
      executedQuantity: recordedExecution.executedQuantity,
      executedTimeMs: recordedExecution.executedTimeMs,
      orderUpdatedAtMs: context.orderUpdatedAtMs,
    } as const;
    return recordCumulativeExecutionFact(executionParams);
  }

  /**
   * 以权威终态结算一次订单生命周期，并以 closedOrderIds 保证同一订单只结算一次。
   *
   * 成交事实必须先具备唯一 monitor/direction 归因和单调 revision；保护性卖单还会先把
   * cumulative fact 与 durable progress 提交给日内损益 owner，再更新本地买卖记录、
   * 待成交占用和刷新门禁。全部结算完成后才关闭 runtime tracking 并发布
   * OrderStateChanged，避免下游观察到未完成的终态。
   *
   * @param params 权威终态、成交事实及待成交卖单处置方式
   * @returns 是否完成本次结算，以及仍需延续的关联买单标识
   * @throws 成交归因、revision 或保护性清仓持久化前置条件不完整时抛出
   */
  function settleOrder(params: FinalizeOrderSettlementParams): FinalizeOrderSettlementResult {
    const { orderId, closedReason } = params;
    if (runtime.closedOrderIds.has(orderId)) {
      return {
        handled: false,
        relatedBuyOrderIds: null,
      };
    }

    const trackedOrder = runtime.trackedOrders.get(orderId);
    const context = resolveCloseContext({
      trackedOrder,
      closeParams: params,
    });
    const side = context.side;
    const symbol = context.symbol;
    const isLongSymbol = context.isLongSymbol;
    const executedPrice = context.executedPrice;
    const executedQuantity = context.executedQuantity;
    const executedTimeMs = context.executedTimeMs;
    const orderUpdatedAtMs = context.orderUpdatedAtMs;
    assertProtectiveSellExecutionFactsReady({
      orderId,
      side,
      symbol,
      monitorSymbol: context.monitorSymbol,
      isLongSymbol,
      isProtectiveLiquidation: context.isProtectiveLiquidation,
      executedPrice,
      executedQuantity,
      executedTimeMs,
      orderUpdatedAtMs,
    });
    const recordedExecution = resolveRecordedExecution({
      executedPrice,
      executedQuantity,
      executedTimeMs,
    });
    const executionContextReady = hasExecutionAttributionContext({
      side,
      symbol,
      monitorSymbol: context.monitorSymbol,
      isLongSymbol,
    });
    const pendingSellDisposition = params.pendingSellDisposition ?? {
      kind: 'RELEASE',
    };
    if (recordedExecution !== null && !executionContextReady) {
      throw new Error(
        `[订单监控] 订单 ${orderId} 存在成交事实但缺少唯一 monitor/direction 归因，阻断结算`,
      );
    }

    if (recordedExecution !== null && !isValidPositiveNumber(orderUpdatedAtMs)) {
      throw new Error(`[订单监控] 订单 ${orderId} 存在成交事实但缺少 order revision，阻断结算`);
    }

    const protectiveTerminalExecutionParams =
      context.isProtectiveLiquidation &&
      side === 'SELL' &&
      symbol !== null &&
      isLongSymbol !== undefined &&
      recordedExecution !== null
        ? {
            factStage: 'TERMINAL' as const,
            orderId,
            side,
            monitorSymbol: context.monitorSymbol,
            symbol,
            isLongSymbol,
            isProtectiveLiquidation: true,
            executedPrice: recordedExecution.executedPrice,
            executedQuantity: recordedExecution.executedQuantity,
            executedTimeMs: recordedExecution.executedTimeMs,
            orderUpdatedAtMs,
          }
        : null;
    if (
      params.preparedProtectiveTerminalExecution !== undefined &&
      protectiveTerminalExecutionParams === null
    ) {
      throw new Error(`[订单监控] 订单 ${orderId} 缺少保护性终态归因，禁止消费已提交 progress`);
    }

    const protectiveTerminalExecutionResult =
      params.preparedProtectiveTerminalExecution ??
      (protectiveTerminalExecutionParams === null
        ? null
        : recordCumulativeExecutionFact(protectiveTerminalExecutionParams));
    let relatedBuyOrderIds: ReadonlyArray<string> | null = null;

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
          relatedBuyOrderIds: null,
        };
      }

      const orderSide = resolveOrderSideFromText(side);
      if (orderSide === OrderSide.Buy) {
        orderRecorder.recordLocalBuy(
          symbol,
          executedPrice,
          executedQuantity,
          isLongSymbol,
          executedTimeMs,
        );
      } else {
        const filledSell = orderRecorder.markSellFilled(orderId);
        const settledSell = settleSellExecutedPart({
          orderRecorder,
          orderId,
          symbol,
          isLongSymbol,
          executedPrice,
          executedQuantity,
          executedTimeMs,
          relatedBuyOrderIds: filledSell?.relatedBuyOrderIds ?? [],
        });
        relatedBuyOrderIds = settledSell.remainingRelatedBuyOrderIds;
      }

      const executionResult =
        protectiveTerminalExecutionResult ??
        recordCumulativeExecution({
          factStage: 'TERMINAL',
          orderId,
          side,
          monitorSymbol: context.monitorSymbol,
          symbol,
          isLongSymbol,
          isProtectiveLiquidation: context.isProtectiveLiquidation,
          executedPrice,
          executedQuantity,
          executedTimeMs,
          orderUpdatedAtMs,
        });

      if (
        protectiveTerminalExecutionParams !== null &&
        protectiveTerminalExecutionResult !== null
      ) {
        applyCumulativeExecutionSideEffects(
          protectiveTerminalExecutionParams,
          protectiveTerminalExecutionResult,
        );
      }

      if (!executionResult.authoritativeFactChanged) {
        markPostTradeRefresh();
      }
    }

    if (closedReason === 'CANCELED' || closedReason === 'REJECTED') {
      if (side === 'SELL') {
        const cancelledSell = orderRecorder.markSellCancelled(orderId);
        const cancelledRelatedBuyOrderIds = cancelledSell?.relatedBuyOrderIds ?? [];
        if (symbol && isLongSymbol !== undefined) {
          const settledSell = settleSellExecutedPart({
            orderRecorder,
            orderId,
            symbol,
            isLongSymbol,
            executedPrice,
            executedQuantity,
            executedTimeMs,
            relatedBuyOrderIds: cancelledRelatedBuyOrderIds,
          });
          relatedBuyOrderIds = settledSell.remainingRelatedBuyOrderIds;
        } else {
          relatedBuyOrderIds =
            cancelledRelatedBuyOrderIds.length > 0 ? cancelledRelatedBuyOrderIds : null;
        }

        if (
          pendingSellDisposition.kind === 'HANDOFF_TO_FOLLOW_UP_SELL' &&
          symbol &&
          isLongSymbol !== undefined &&
          isValidPositiveNumber(pendingSellDisposition.followUpQuantity)
        ) {
          relatedBuyOrderIds = reserveFollowUpSellOccupancy({
            orderRecorder,
            orderId,
            symbol,
            isLongSymbol,
            followUpQuantity: pendingSellDisposition.followUpQuantity,
            relatedBuyOrderIds,
          });
        }
      }

      if (side === 'BUY' && symbol && isLongSymbol !== undefined && recordedExecution !== null) {
        orderRecorder.recordLocalBuy(
          symbol,
          recordedExecution.executedPrice,
          recordedExecution.executedQuantity,
          isLongSymbol,
          recordedExecution.executedTimeMs,
        );
      }

      if (symbol && side && isLongSymbol !== undefined && recordedExecution !== null) {
        const executionResult =
          protectiveTerminalExecutionResult ??
          recordCumulativeExecution({
            factStage: 'TERMINAL',
            orderId,
            side,
            monitorSymbol: context.monitorSymbol,
            symbol,
            isLongSymbol,
            isProtectiveLiquidation: context.isProtectiveLiquidation,
            executedPrice: recordedExecution.executedPrice,
            executedQuantity: recordedExecution.executedQuantity,
            executedTimeMs: recordedExecution.executedTimeMs,
            orderUpdatedAtMs,
          });

        if (
          protectiveTerminalExecutionParams !== null &&
          protectiveTerminalExecutionResult !== null
        ) {
          applyCumulativeExecutionSideEffects(
            protectiveTerminalExecutionParams,
            protectiveTerminalExecutionResult,
          );
        }

        if (!executionResult.authoritativeFactChanged) {
          markPostTradeRefresh();
        }
      }
    }

    runtime.closedOrderIds.add(orderId);
    clearRuntimeTracking(orderId);
    emitOrderStateChanged({
      orderId,
      symbol,
      side,
      source: params.source,
      status: closedReason,
      monitorSymbol: context.monitorSymbol,
      isLongSymbol: isLongSymbol ?? null,
      isProtectiveLiquidation: context.isProtectiveLiquidation,
      executedPrice,
      executedQuantity,
      executedTimeMs,
    });
    return {
      handled: true,
      relatedBuyOrderIds,
    };
  }

  return {
    prepareProtectiveTerminalExecution,
    recordCumulativeExecution,
    settleOrder,
  };
}
