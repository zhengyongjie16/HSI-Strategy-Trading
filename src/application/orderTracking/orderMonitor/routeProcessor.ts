import type { Logger } from '../../../types/logger.js';

/**
 * orderMonitor routeProcessor 模块
 *
 * 职责：
 * - 以单 symbol route 为单位选择本轮唯一可执行动作
 * - 保持 timeout 优先于 replace 的动作语义
 * - 在卖单超时等待终态确认后执行结算与转市价提交
 */

import {
  ORDER_MONITOR_WAIT_WS_ONLY_BLOCK_UNTIL_MS,
  ORDER_QUOTE_RETRY,
  TRADING,
} from '../../../constants/index.js';
import {
  NON_REPLACEABLE_READ_STATUSES,
  NON_REPLACEABLE_READ_TYPES,
} from '../../../constants/orderReadMetadata.js';
import {
  assertProtectiveSellRawTerminalStateFactsReady,
  normalizeTerminalStateSnapshot,
} from '../../../domain/order/orderFactMerge.js';
import {
  canAttemptTimeoutHandling,
  canHandleClosedTimeoutRoute,
  compareTrackedOrderPriority,
  isSupportedTerminalCloseReason,
  resolveCancelRetryDelayMs,
  resolvePendingTimeoutSettlementInput,
  resolveSellTimeoutResolution,
} from '../../../domain/order/orderTimeoutPolicy.js';
import {
  calculatePriceDifference,
  isClosedStatus,
  isWaitWsOnlyReplaceMode,
  normalizePriceText,
} from '../../../domain/order/orderTrackingPolicy.js';
import type {
  OrderMonitorTrackedOrder,
  TerminalSettlementInput,
  TerminalStateSnapshot,
  TrackedOrder,
} from '../../../domain/order/types.js';
import type { Quote } from '../../../types/quote.js';
import { exactCompare } from '../../../utils/numeric/exact.js';
import { DIAGNOSTIC_OPERATIONS } from '../../../constants/diagnostics.js';
import { recordOrderTerminalConfirmation } from './orderObservation.js';
import { resolveNextQuoteRetry } from '../../quoteRetry.js';
import { resolveQuoteReadinessForRequirement } from '../../../domain/order/quoteReadiness.js';
import {
  createAcceptedOrderLocalSyncError,
  createTradeMutationUnknownError,
} from '../../orderExecution/tradeMutationErrors.js';
import {
  acknowledgeLatestReplaceTerminal,
  acknowledgeQueriedTerminalState,
  peekLatestReplaceTerminal,
  peekQueriedTerminalState,
} from './orderOps.js';
import type {
  RouteProcessor,
  RouteProcessorDeps,
  RouteRuntimeProcessParams,
  TimeoutMarketConversionSubmitOutcome,
} from './types.js';

function applyCancelRetryBackoff(order: TrackedOrder, nowMs: number): void {
  order.cancelRetryCount += 1;
  order.nextCancelAttemptAt = nowMs + resolveCancelRetryDelayMs(order.cancelRetryCount);
}

function resetCancelRetry(order: TrackedOrder, nowMs: number): void {
  order.cancelRetryCount = 0;
  order.nextCancelAttemptAt = nowMs;
}

function pauseCancelRetryAndWaitWs(order: TrackedOrder): void {
  order.cancelRetryCount = 0;
  order.nextCancelAttemptAt = ORDER_MONITOR_WAIT_WS_ONLY_BLOCK_UNTIL_MS;
}

function resolveTerminalSettlementInput(
  deps: RouteProcessorDeps,
  orderId: string,
  order: OrderMonitorTrackedOrder,
): {
  readonly settlementInput: TerminalSettlementInput;
  readonly rawTerminalState: TerminalStateSnapshot;
} {
  const rawTerminalState = peekQueriedTerminalState(deps.runtime, orderId);
  if (rawTerminalState === null) {
    throw new Error(
      `[订单监控] 订单 ${orderId} 已确认终态但缺少 raw terminal snapshot，阻断 timeout 收口`,
    );
  }

  assertProtectiveSellRawTerminalStateFactsReady(order, rawTerminalState);
  const isProtectiveSell = order.side === 'SELL' && order.isProtectiveLiquidation;
  const normalizedTerminalState = normalizeTerminalStateSnapshot(
    order,
    rawTerminalState,
    isProtectiveSell,
  );
  const resolvedClosedReason = normalizedTerminalState.closedReason;
  if (!isSupportedTerminalCloseReason(resolvedClosedReason)) {
    throw new Error(
      `[订单监控] 订单 ${orderId} raw terminal snapshot 返回不支持的关闭原因: ${String(resolvedClosedReason)}`,
    );
  }

  recordOrderTerminalConfirmation(deps, {
    orderId,
    closedReason: resolvedClosedReason,
    source: 'API',
    orderUpdatedAtMs: normalizedTerminalState.orderUpdatedAtMs,
  });
  return {
    settlementInput: {
      params: {
        orderId,
        closedReason: resolvedClosedReason,
        source: 'API',
        executedPrice: normalizedTerminalState.executedPrice,
        executedAmount: normalizedTerminalState.executedAmount,
        executedQuantity: normalizedTerminalState.executedQuantity,
        executedTimeMs: normalizedTerminalState.executedTimeMs,
        orderUpdatedAtMs: normalizedTerminalState.orderUpdatedAtMs,
      },
      queriedExecutedQuantity: normalizedTerminalState.executedQuantity,
    },
    rawTerminalState,
  };
}

function clearTimeoutMarketConversionState(order: OrderMonitorTrackedOrder): void {
  order.timeoutMarketConversionPending = false;
  order.timeoutMarketConversionTerminalState = null;
}

function markTimeoutMarketConversionPending(order: OrderMonitorTrackedOrder): void {
  order.timeoutMarketConversionPending = true;
  pauseCancelRetryAndWaitWs(order);
}

/**
 * 在 mutation permit 内确认 timeout->MO owner 仍有效，再开始 broker 撤单。
 *
 * 该检查不能前移到 permit 排队前：route 可能在等待期间被 WS 终态结算。
 * 标记必须早于 ctx.cancelOrder，才能让同一异步窗口抵达的 WS 终态归属 timeout->MO。
 */
function prepareTimeoutMarketConversionCancel(
  params: RouteRuntimeProcessParams,
  deps: RouteProcessorDeps,
  order: OrderMonitorTrackedOrder,
): boolean {
  if (!isRouteGenerationCurrent(deps.runtime, params)) {
    return false;
  }

  if (!isTrackedOrderStillAttachedToRoute(deps.runtime, params.symbol, order)) {
    return false;
  }

  markTimeoutMarketConversionPending(order);
  return true;
}

function getTrackedOrdersForSymbol(
  deps: RouteProcessorDeps,
  symbol: string,
): ReadonlyArray<OrderMonitorTrackedOrder> {
  const orderIds = deps.runtime.trackedOrderIdsBySymbol.get(symbol);
  if (!orderIds) {
    return [];
  }

  return [...orderIds]
    .map((orderId) => deps.runtime.trackedOrders.get(orderId) ?? null)
    .filter((order): order is OrderMonitorTrackedOrder => order !== null)
    .sort(compareTrackedOrderPriority);
}

/**
 * 判断当前 route pass 的 symbol generation 是否仍然有效。
 *
 * 卖单 timeout -> settlement -> submit MO 会在同一 pass 内短暂出现 route 为空，
 * 因此这里以 symbol generation 为 owner，而不是要求 route state 必然存在。
 */
function isRouteGenerationCurrent(
  runtime: RouteProcessorDeps['runtime'],
  params: Pick<RouteRuntimeProcessParams, 'symbol' | 'generation'>,
): boolean {
  if (!runtime.running) {
    return false;
  }

  return runtime.latestRouteGenerationBySymbol.get(params.symbol) === params.generation;
}

/**
 * 判断某个 tracked order 是否仍然附着在当前 symbol route 上。
 *
 * 该判断用于 await 之后继续写入 tracked order 运行态前的二次确认，
 * 防止旧 continuation 回写已经终态清理或被替换的订单对象。
 */
function isTrackedOrderStillAttachedToRoute(
  runtime: RouteProcessorDeps['runtime'],
  symbol: string,
  order: OrderMonitorTrackedOrder,
): boolean {
  if (runtime.closedOrderIds.has(order.orderId)) {
    return false;
  }

  if (runtime.trackedOrderLifecycles.get(order.orderId)?.state !== 'OPEN') {
    return false;
  }

  const attachedOrder = runtime.trackedOrders.get(order.orderId);
  if (attachedOrder !== order) {
    return false;
  }

  const symbolBucket = runtime.trackedOrderIdsBySymbol.get(symbol);
  return symbolBucket?.has(order.orderId) ?? false;
}

/**
 * 消费已缓存的改单终态。
 *
 * 已确认的改单终态必须优先于后续 timeout 或 replace mutation；只有结算成功后
 * 才能同时 ack 终态与 raw terminal snapshot。
 */
function settlePendingReplaceTerminal(
  deps: RouteProcessorDeps,
  order: OrderMonitorTrackedOrder,
): boolean {
  const { logger } = deps;
  const replaceTerminal = peekLatestReplaceTerminal(deps.runtime, order.orderId);
  if (replaceTerminal === null) {
    return false;
  }

  const rawTerminalState = peekQueriedTerminalState(deps.runtime, order.orderId);
  if (rawTerminalState !== replaceTerminal) {
    throw new Error(
      `[订单监控] 订单 ${order.orderId} 改单终态缺少同一 raw terminal snapshot，阻断后续 mutation`,
    );
  }

  assertProtectiveSellRawTerminalStateFactsReady(order, rawTerminalState);
  const isProtectiveSell = order.side === 'SELL' && order.isProtectiveLiquidation;
  const terminal = normalizeTerminalStateSnapshot(order, rawTerminalState, isProtectiveSell);
  recordOrderTerminalConfirmation(deps, {
    orderId: order.orderId,
    closedReason: terminal.closedReason,
    source: 'STATE_CHECK',
    orderUpdatedAtMs: terminal.orderUpdatedAtMs,
  });
  const settlementResult = deps.settleOrder({
    orderId: order.orderId,
    closedReason: terminal.closedReason,
    source: 'STATE_CHECK',
    executedPrice: terminal.executedPrice,
    executedAmount: terminal.executedAmount,
    executedQuantity: terminal.executedQuantity,
    executedTimeMs: terminal.executedTimeMs,
    orderUpdatedAtMs: terminal.orderUpdatedAtMs,
  });
  if (!settlementResult.handled) {
    logger.warn(`[订单监控] 订单 ${order.orderId} 改单失败后确认终态，但结算未执行`);
    return true;
  }

  acknowledgeLatestReplaceTerminal(deps.runtime, order.orderId, replaceTerminal);
  acknowledgeQueriedTerminalState(deps.runtime, order.orderId, rawTerminalState);
  return true;
}

/** 结算已缓存的撤单终态，成功后才确认 raw snapshot。 */
function settleBuyOrderTimeoutTerminal(
  deps: RouteProcessorDeps,
  orderId: string,
  order: OrderMonitorTrackedOrder,
): boolean {
  const { logger } = deps;
  let resolvedTerminal: ReturnType<typeof resolveTerminalSettlementInput>;
  try {
    resolvedTerminal = resolveTerminalSettlementInput(deps, orderId, order);
  } catch (error) {
    pauseCancelRetryAndWaitWs(order);
    throw error;
  }

  const settlementResult = deps.settleOrder(resolvedTerminal.settlementInput.params);
  if (!settlementResult.handled) {
    applyCancelRetryBackoff(order, deps.now().getTime());
    return true;
  }

  acknowledgeQueriedTerminalState(deps.runtime, orderId, resolvedTerminal.rawTerminalState);
  logger.info(
    `[订单监控] 买入订单 ${orderId} 已确认终态=${resolvedTerminal.settlementInput.params.closedReason}`,
  );
  return true;
}

async function handleBuyOrderTimeout(
  logger: Logger,
  params: RouteRuntimeProcessParams,
  deps: RouteProcessorDeps,
  orderId: string,
  order: OrderMonitorTrackedOrder,
): Promise<boolean> {
  const now = deps.now().getTime();
  if (!canAttemptTimeoutHandling(order, now)) {
    return false;
  }

  if (peekQueriedTerminalState(deps.runtime, orderId) !== null) {
    return settleBuyOrderTimeoutTerminal(deps, orderId, order);
  }

  const outcome = await deps.cancelOrder(orderId);
  if (!isRouteGenerationCurrent(deps.runtime, params)) {
    return true;
  }

  if (!isTrackedOrderStillAttachedToRoute(deps.runtime, params.symbol, order)) {
    return false;
  }

  if (outcome.kind === 'CANCEL_NOT_STARTED') {
    throw new Error(`[订单监控] 买入订单 ${orderId} 未提供 route preflight 却未发起撤单`);
  }

  if (outcome.kind === 'CANCEL_CONFIRMED') {
    pauseCancelRetryAndWaitWs(order);
    logger.info(`[订单监控] 买入订单 ${orderId} 撤单请求成功，等待 WS 终态`);
    return true;
  }

  if (outcome.kind === 'ALREADY_CLOSED' && isSupportedTerminalCloseReason(outcome.closedReason)) {
    return settleBuyOrderTimeoutTerminal(deps, orderId, order);
  }

  applyCancelRetryBackoff(order, deps.now().getTime());
  return true;
}

/**
 * 提交卖单超时后的 follow-up 市价单。
 *
 * 这里要求 old order 的 pending sell 占用在整个异步提交窗口内保持连续：
 * - 进入该函数前，settlementFlow 已把旧卖单占用保留为 follow-up placeholder
 * - 提交前若 route/gate 已失效，则释放 placeholder，避免生成不存在新单的假占用
 * - SDK 调用尚未发出时若提交失败，则释放 placeholder，避免本地残留不存在的卖单占用
 * - SDK 调用已发出但结果不可确认时，保留 placeholder 并把错误交给运行期错误通道
 * - broker 返回新 orderId 后，远端事实不再受 route generation / stop 状态否认
 * - 先建立新 tracked order，再迁移 pending-sell 占用并移除旧 placeholder
 *
 * @param params 当前 route generation 快照
 * @param deps routeProcessor 依赖
 * @param order 已进入 timeout conversion 的旧卖单
 * @param marketConversionQuantity follow-up 市价单数量
 * @param relatedBuyOrderIds 已由 settlementFlow 保留的连续占用集合
 * @returns 无返回值
 */
async function submitTimeoutMarketOrder(
  logger: Logger,
  params: Pick<RouteRuntimeProcessParams, 'symbol' | 'generation'>,
  deps: RouteProcessorDeps,
  order: OrderMonitorTrackedOrder,
  marketConversionQuantity: number,
  relatedBuyOrderIds: ReadonlyArray<string>,
): Promise<void> {
  if (typeof order.monitorSymbol !== 'string' || order.monitorSymbol.length === 0) {
    throw new Error(`[订单监控] 市价转单时缺少 monitorSymbol: orderId=${order.orderId}`);
  }

  const monitorSymbol = order.monitorSymbol;
  const { tradeMutationPort } = deps;
  let timeoutConversionRemark = `超时转市价-原订单${order.orderId}`;
  if (order.isProtectiveLiquidation) {
    timeoutConversionRemark += TRADING.PROTECTIVE_LIQUIDATION_REMARK_SUFFIX;
  }

  // 先做无副作用预检；最终 route/gate 复核与 SDK submit 必须留在同一 callback permit。
  if (!isRouteGenerationCurrent(deps.runtime, params)) {
    deps.releaseSellHandoff(order.orderId, order.symbol);
    return;
  }

  if (!deps.isContinuousTradingAllowed()) {
    deps.releaseSellHandoff(order.orderId, order.symbol);
    logger.info(`[连续交易门禁] 连续交易关闭，卖出订单 ${order.orderId} 超时转市价单被阻止`);
    return;
  }

  let submitOutcome: TimeoutMarketConversionSubmitOutcome;
  try {
    submitOutcome = await deps.rateLimiter.withTradeMutation(async (permit) => {
      if (!isRouteGenerationCurrent(deps.runtime, params)) {
        return { kind: 'PRECHECK_SKIPPED' };
      }

      if (!deps.isContinuousTradingAllowed()) {
        logger.info(
          `[连续交易门禁] 连续交易已关闭，卖出订单 ${order.orderId} 转市价单在提交前被阻止`,
        );
        return { kind: 'PRECHECK_SKIPPED' };
      }

      return permit.invoke(async () => {
        const phase = { remoteIssued: false };
        const finalAuthorizationAborted = new Error('[订单监控] 原route在SDK序列化后失效');
        try {
          const brokerResponse = await tradeMutationPort.submitOrder(
            {
              symbol: order.symbol,
              side: order.executionSide,
              orderType: 'MO',
              purpose: order.isProtectiveLiquidation ? 'PROTECTIVE_LIQUIDATION' : 'ORDINARY_SELL',
              submittedQuantity: marketConversionQuantity,
              timeInForce: 'DAY',
              remark: timeoutConversionRemark,
            },
            () => {
              if (
                !isRouteGenerationCurrent(deps.runtime, params) ||
                !deps.isContinuousTradingAllowed()
              ) {
                throw finalAuthorizationAborted;
              }

              phase.remoteIssued = true;
            },
          );
          if (brokerResponse.kind === 'ACCEPTED')
            return { kind: 'BROKER_RESPONSE', brokerResponse };

          if (brokerResponse.kind === 'REJECTED')
            return { kind: 'BROKER_REJECTED', result: brokerResponse };

          return {
            kind: 'BROKER_REQUEST_STARTED_UNKNOWN',
            error: createTradeMutationUnknownError(brokerResponse),
          };
        } catch (error: unknown) {
          if (error === finalAuthorizationAborted) return { kind: 'PRECHECK_SKIPPED' };

          if (!phase.remoteIssued) throw error;

          return { kind: 'BROKER_REQUEST_STARTED_UNKNOWN', error };
        }
      });
    });
  } catch (error: unknown) {
    deps.releaseSellHandoff(order.orderId, order.symbol);
    throw error;
  }

  if (submitOutcome.kind === 'PRECHECK_SKIPPED') {
    deps.releaseSellHandoff(order.orderId, order.symbol);
    return;
  }

  if (submitOutcome.kind === 'BROKER_REJECTED') {
    deps.releaseSellHandoff(order.orderId, order.symbol);
    logger.warn(
      `[订单监控] 卖出订单 ${order.orderId} 超时转市价被 broker 拒绝，code=${submitOutcome.result.code ?? 'null'}`,
    );
    return;
  }

  if (submitOutcome.kind === 'BROKER_REQUEST_STARTED_UNKNOWN') {
    try {
      deps.diagnostics.record(DIAGNOSTIC_OPERATIONS.ORDER_SUBMIT_UNKNOWN_FATAL, {
        symbol: order.symbol,
        side: order.executionSide,
        orderType: 'MO',
        sdkOperation: 'TradeContext.submitOrder',
        requestAttempted: true,
        originalOrderId: order.orderId,
        count: 1,
      });
    } catch {
      // 真实 submit UNKNOWN 仅记录一次；仍由原分支保留占用并抛出原 fatal。
    }

    logger.error(
      `[订单监控] 卖出订单 ${order.orderId} 转市价单提交结果不可确认，保留旧占用等待订单事实收敛`,
      submitOutcome.error,
    );
    throw submitOutcome.error;
  }

  const newOrderId = submitOutcome.brokerResponse.orderId;
  try {
    const direction: 'LONG' | 'SHORT' = order.isLongSymbol ? 'LONG' : 'SHORT';
    // ACK 已是远端事实；先保存操作关联，再触发 tracking/route 与 pending 占用同步。
    deps.recordAcceptedSellContinuation(order.orderId, newOrderId);
    deps.trackOrder({
      orderId: newOrderId,
      symbol: order.symbol,
      side: order.side,
      executionSide: order.executionSide,
      price: null,
      initialSubmittedPrice: null,
      quantity: marketConversionQuantity,
      isLongSymbol: order.isLongSymbol,
      monitorSymbol,
      isProtectiveLiquidation: order.isProtectiveLiquidation,
      orderType: 'MO',
    });

    deps.orderRecorder.submitSellOrder(
      newOrderId,
      order.symbol,
      direction,
      marketConversionQuantity,
      relatedBuyOrderIds,
      order.isProtectiveLiquidation,
      deps.now().getTime(),
    );
    deps.releaseSellHandoff(order.orderId, order.symbol);
  } catch (error: unknown) {
    logger.error(
      `[订单监控] 卖出订单 ${order.orderId} 转市价单已提交，但本地同步失败，订单ID=${newOrderId}`,
      error,
    );
    throw createAcceptedOrderLocalSyncError(newOrderId, error);
  }
}

/**
 * 处理卖单超时。
 *
 * 业务顺序固定：
 * 1. 先确认旧卖单是否已进入可转换的终态，且剩余数量明确
 * 2. 由 settlementFlow 结算已成交部分，并决定旧 pending sell 占用是释放还是保留为 follow-up
 * 3. 只有在占用已连续保留后，才允许异步提交新的市价卖单
 *
 * @param params 当前 route pass 上下文
 * @param deps routeProcessor 依赖
 * @param orderId 超时卖单 ID
 * @param order 超时卖单运行态
 * @returns 本轮是否已消费该 timeout owner
 */
async function handleSellOrderTimeout(
  logger: Logger,
  params: RouteRuntimeProcessParams,
  deps: RouteProcessorDeps,
  orderId: string,
  order: OrderMonitorTrackedOrder,
): Promise<boolean> {
  const now = deps.now().getTime();
  if (!canAttemptTimeoutHandling(order, now)) {
    return false;
  }

  let settlementInput: TerminalSettlementInput;
  let rawTerminalStateToAcknowledge: TerminalStateSnapshot | null = null;
  if (order.timeoutMarketConversionPending && order.timeoutMarketConversionTerminalState !== null) {
    const resolvedSettlementInput = resolvePendingTimeoutSettlementInput(
      orderId,
      order.timeoutMarketConversionTerminalState,
    );
    if (resolvedSettlementInput === null) {
      applyCancelRetryBackoff(order, deps.now().getTime());
      return true;
    }

    settlementInput = resolvedSettlementInput;
  } else {
    const pendingTerminalState = peekQueriedTerminalState(deps.runtime, orderId);
    if (pendingTerminalState === null) {
      const outcome = await deps.cancelOrder(orderId, () =>
        prepareTimeoutMarketConversionCancel(params, deps, order),
      );
      if (!isRouteGenerationCurrent(deps.runtime, params)) {
        return true;
      }

      if (!isTrackedOrderStillAttachedToRoute(deps.runtime, params.symbol, order)) {
        return false;
      }

      if (outcome.kind === 'CANCEL_NOT_STARTED') {
        return false;
      }

      if (outcome.kind === 'CANCEL_CONFIRMED') {
        logger.info(`[订单监控] 卖出订单 ${orderId} 撤单请求成功，等待 WS 非成交终态后再评估`);
        return true;
      }

      if (
        outcome.kind !== 'ALREADY_CLOSED' ||
        !isSupportedTerminalCloseReason(outcome.closedReason)
      ) {
        applyCancelRetryBackoff(order, deps.now().getTime());
        return true;
      }

      let resolvedTerminal: ReturnType<typeof resolveTerminalSettlementInput>;
      try {
        resolvedTerminal = resolveTerminalSettlementInput(deps, orderId, order);
      } catch (error) {
        pauseCancelRetryAndWaitWs(order);
        throw error;
      }

      settlementInput = resolvedTerminal.settlementInput;
      rawTerminalStateToAcknowledge = resolvedTerminal.rawTerminalState;
    } else {
      let resolvedTerminal: ReturnType<typeof resolveTerminalSettlementInput>;
      try {
        resolvedTerminal = resolveTerminalSettlementInput(deps, orderId, order);
      } catch (error) {
        pauseCancelRetryAndWaitWs(order);
        throw error;
      }

      settlementInput = resolvedTerminal.settlementInput;
      rawTerminalStateToAcknowledge = resolvedTerminal.rawTerminalState;
    }
  }

  recordOrderTerminalConfirmation(deps, settlementInput.params);
  const timeoutResolution = resolveSellTimeoutResolution(order, settlementInput);
  if (timeoutResolution.kind === 'WAIT_RETRY') {
    applyCancelRetryBackoff(order, deps.now().getTime());
    return true;
  }

  const settlementParams =
    timeoutResolution.kind === 'SETTLE_AND_CONVERT'
      ? {
          ...timeoutResolution.settlementInput.params,
          pendingSellDisposition: {
            kind: 'HANDOFF_TO_FOLLOW_UP_SELL',
            followUpQuantity: timeoutResolution.marketConversionQuantity,
          } as const,
        }
      : timeoutResolution.settlementInput.params;
  const settlementResult = deps.settleOrder(settlementParams);
  if (!settlementResult.handled) {
    applyCancelRetryBackoff(order, deps.now().getTime());
    return false;
  }

  if (rawTerminalStateToAcknowledge !== null) {
    acknowledgeQueriedTerminalState(deps.runtime, orderId, rawTerminalStateToAcknowledge);
  }

  clearTimeoutMarketConversionState(order);
  resetCancelRetry(order, deps.now().getTime());

  if (timeoutResolution.kind === 'SETTLE_FILLED') {
    logger.info(`[订单监控] 卖出订单 ${orderId} 已成交，禁止超时转市价`);
    return false;
  }

  if (timeoutResolution.kind === 'SETTLE_NO_REMAINDER') {
    return false;
  }

  if (!isRouteGenerationCurrent(deps.runtime, params)) {
    deps.releaseSellHandoff(orderId, order.symbol);
    return true;
  }

  if (settlementResult.relatedBuyOrderIds === null) {
    throw new Error(`[订单监控] 卖出订单 ${orderId} 超时转市价缺少连续占用信息`);
  }

  await submitTimeoutMarketOrder(
    logger,
    params,
    deps,
    order,
    timeoutResolution.marketConversionQuantity,
    settlementResult.relatedBuyOrderIds,
  );
  return true;
}

function shouldHandleTimeout(deps: RouteProcessorDeps, order: OrderMonitorTrackedOrder): boolean {
  if (order.convertedToMarket || order.orderType === 'MO') {
    return false;
  }

  if (isClosedStatus(order.status) && !canHandleClosedTimeoutRoute(order)) {
    return false;
  }

  const timeoutConfig = order.side === 'BUY' ? deps.config.buyTimeout : deps.config.sellTimeout;
  if (!timeoutConfig.enabled) {
    return false;
  }

  return deps.now().getTime() - order.submittedAt >= timeoutConfig.timeoutMs;
}

function canEnterReplaceFlow(deps: RouteProcessorDeps, order: OrderMonitorTrackedOrder): boolean {
  if (order.convertedToMarket) {
    return false;
  }

  if (shouldHandleTimeout(deps, order)) {
    return false;
  }

  if (order.nextCancelAttemptAt === ORDER_MONITOR_WAIT_WS_ONLY_BLOCK_UNTIL_MS) {
    return false;
  }

  if (order.timeoutMarketConversionPending) {
    return false;
  }

  if (
    NON_REPLACEABLE_READ_TYPES.has(order.orderType) ||
    NON_REPLACEABLE_READ_STATUSES.has(order.status)
  ) {
    return false;
  }

  if (isWaitWsOnlyReplaceMode(order)) {
    return false;
  }

  if (deps.now().getTime() - order.lastPriceUpdateAt < deps.config.priceUpdateIntervalMs) {
    return false;
  }

  return true;
}

function shouldReplaceFromQuote(
  latestQuote: Quote,
  deps: RouteProcessorDeps,
  order: OrderMonitorTrackedOrder,
): boolean {
  if (!canEnterReplaceFlow(deps, order)) {
    return false;
  }

  if (latestQuote.symbol !== order.symbol || exactCompare(latestQuote.price, '0') <= 0) {
    return false;
  }

  if (order.submittedPrice === null) {
    throw new Error(`[订单监控] 非市价订单 ${order.orderId} 缺少当前委托价，无法执行改单`);
  }

  const priceDifference = calculatePriceDifference(latestQuote.price, order.submittedPrice);
  if (exactCompare(priceDifference, deps.config.priceDiffThreshold) < 0) {
    return false;
  }

  if (order.side === 'BUY' && !deps.config.allowBuyOrderTrackingAboveInitialPrice) {
    if (order.initialSubmittedPrice === null) {
      throw new Error(`[订单监控] 非市价买单 ${order.orderId} 缺少初始委托价，无法执行改单`);
    }

    if (
      exactCompare(
        normalizePriceText(latestQuote.price),
        normalizePriceText(order.initialSubmittedPrice),
      ) > 0
    ) {
      return false;
    }
  }

  return true;
}

function shouldRetryReplaceFromTimer(
  latestQuote: Quote,
  deps: RouteProcessorDeps,
  order: OrderMonitorTrackedOrder,
): boolean {
  if (order.replaceCapability !== 'TEMP_BLOCKED_BY_STATUS') {
    return false;
  }

  if (order.replaceResumeMode !== 'TIME_BACKOFF') {
    return false;
  }

  if (order.replaceBlockedUntilAt === null || order.replaceBlockedUntilAt > deps.now().getTime()) {
    return false;
  }

  return shouldReplaceFromQuote(latestQuote, deps, order);
}

function shouldReplaceForWakeup(
  params: RouteRuntimeProcessParams,
  latestQuote: Quote,
  deps: RouteProcessorDeps,
  order: OrderMonitorTrackedOrder,
): boolean {
  if (params.wakeupKind === 'QUOTE' || params.wakeupKind === 'ORDER_EVENT') {
    return shouldReplaceFromQuote(latestQuote, deps, order);
  }

  if (params.wakeupKind === 'TIMER') {
    return shouldRetryReplaceFromTimer(latestQuote, deps, order);
  }

  return false;
}

function applyQuoteRetryForUnavailableQuote(order: OrderMonitorTrackedOrder, now: number): void {
  if (order.quoteRetryNextAt !== null && now < order.quoteRetryNextAt) {
    return;
  }

  const nextRetry = resolveNextQuoteRetry({
    attempts: order.quoteRetryAttempts,
    nowMs: now,
    intervalMs: ORDER_QUOTE_RETRY.INTERVAL_MS,
    maxAttempts: ORDER_QUOTE_RETRY.MAX_ATTEMPTS,
  });
  if (nextRetry.exhausted) {
    order.quoteRetryAttempts = nextRetry.nextAttempts;
    order.quoteRetryNextAt = null;
    order.quoteRetryExhausted = true;
    return;
  }

  order.quoteRetryAttempts = nextRetry.nextAttempts;
  order.quoteRetryNextAt = nextRetry.nextRetryAt;
  order.quoteRetryExhausted = false;
}

function resetQuoteRetryState(order: OrderMonitorTrackedOrder): void {
  order.quoteRetryAttempts = 0;
  order.quoteRetryNextAt = null;
  order.quoteRetryExhausted = false;
}

function shouldAdvanceQuoteRetryFromTimer(
  deps: RouteProcessorDeps,
  order: OrderMonitorTrackedOrder,
): boolean {
  if (!canEnterReplaceFlow(deps, order)) {
    return false;
  }

  if (order.quoteRetryNextAt === null || order.quoteRetryNextAt > deps.now().getTime()) {
    return false;
  }

  return order.quoteRetryAttempts > 0;
}

/**
 * 创建单 symbol 订单 route 的动作处理器。
 *
 * 每次 route pass 先收敛改单终态与 timeout，再处理行情驱动的改单；同一轮最多提交一个
 * broker mutation，确保同 symbol 订单动作串行。异步操作错误直接向 route runtime 传播，
 * 由该 owner 停止并暴露失败。
 *
 * @param deps route runtime、订单事实、broker 操作与交易门禁依赖
 * @returns 提供单次 route 推进能力的处理器
 */
export function createRouteProcessor(deps: RouteProcessorDeps): RouteProcessor {
  const { logger } = deps;

  /**
   * 执行一次 symbol route 的动作选择。
   *
   * 顺序约束：
   * 1. timeout 永远优先于 replace
   * 2. 同一轮 pass 最多只消费一个 timeout/replace owner，然后立即返回
   * 3. quote 不可用时只推进 quote-retry 状态，不做普通 replace
   *
   * @param params 当前 route pass 上下文
   * @returns 无返回值
   */
  async function processRoute(params: RouteRuntimeProcessParams): Promise<void> {
    if (!isRouteGenerationCurrent(deps.runtime, params)) {
      return;
    }

    const trackedOrders = getTrackedOrdersForSymbol(deps, params.symbol);
    for (const order of trackedOrders) {
      if (settlePendingReplaceTerminal(deps, order)) {
        return;
      }

      if (!shouldHandleTimeout(deps, order)) {
        continue;
      }

      if (order.side === 'BUY') {
        const handled = await handleBuyOrderTimeout(logger, params, deps, order.orderId, order);
        if (handled) {
          return;
        }

        continue;
      }

      const handled = await handleSellOrderTimeout(logger, params, deps, order.orderId, order);
      if (handled) {
        return;
      }
    }

    const latestQuote = params.latestQuote;
    const quoteReadiness = resolveQuoteReadinessForRequirement({
      quote: latestQuote,
      requirement: 'PRICE',
    });
    if (quoteReadiness !== 'READY') {
      if (quoteReadiness !== 'MISSING') {
        logger.warn(
          `[订单监控] 跟价行情无效，跳过本轮改单: symbol=${params.symbol} readiness=${quoteReadiness}`,
        );
        return;
      }

      const now = deps.now().getTime();
      for (const order of trackedOrders) {
        if (params.wakeupKind === 'QUOTE') {
          if (!canEnterReplaceFlow(deps, order)) {
            continue;
          }

          applyQuoteRetryForUnavailableQuote(order, now);
          return;
        }

        if (params.wakeupKind === 'TIMER' && shouldAdvanceQuoteRetryFromTimer(deps, order)) {
          applyQuoteRetryForUnavailableQuote(order, now);
          return;
        }
      }

      return;
    }

    if (latestQuote === null) {
      return;
    }

    for (const order of trackedOrders) {
      if (!isTrackedOrderStillAttachedToRoute(deps.runtime, params.symbol, order)) {
        continue;
      }

      resetQuoteRetryState(order);

      const shouldReplace = shouldReplaceForWakeup(params, latestQuote, deps, order);
      if (!shouldReplace) {
        continue;
      }

      await deps.replaceOrderPrice(order.orderId, latestQuote.price);
      if (!isRouteGenerationCurrent(deps.runtime, params)) {
        return;
      }

      if (!isTrackedOrderStillAttachedToRoute(deps.runtime, params.symbol, order)) {
        continue;
      }

      settlePendingReplaceTerminal(deps, order);
      return;
    }
  }

  return {
    processRoute,
  };
}
