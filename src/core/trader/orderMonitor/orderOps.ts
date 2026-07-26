/**
 * orderMonitor 订单操作模块
 *
 * 职责：
 * - 管理 trackOrder 运行态写入与单订单查询缓存
 * - 封装撤单/改单 API 结果的统一语义
 * - 维护改单阻塞恢复与运行态重置
 */
import { OrderSide } from 'longbridge';
import { logger } from '../../../utils/logger/index.js';
import { isValidPositiveNumber } from '../../../utils/helpers/index.js';
import {
  isExternalApiRequestError,
  wrapExternalApiRequest,
} from '../../../utils/apiFailure/index.js';
import type { CancelOrderOutcome, OrderStateCheckResult } from '../../../types/trader.js';
import type { TradeMutationPermit } from '../../../types/services.js';
import {
  ORDER_MONITOR_REPLACE_TEMP_BLOCK_BACKOFF_MS,
  ORDER_MONITOR_WAIT_WS_ONLY_BLOCK_UNTIL_MS,
} from '../../../constants/index.js';
import { toDecimal } from '../utils.js';
import type {
  CancelOrderMutationRequest,
  OrderActionAuthorizationStage,
  OrderMutationRequest,
  ReplaceOrderPriceOutcome,
  TrackOrderParams,
} from '../types.js';
import type {
  OrderMonitorRuntimeStore,
  OrderMonitorTrackedOrder,
  ReplaceBlockOwnerSnapshot,
  OrderCumulativeExecutionParams,
  CancelOrderBeforeBrokerMutation,
  CancelOrderPreflightOutcome,
  OrderOps,
  OrderOpsDeps,
  ReplacePermitRunner,
  TerminalStateSnapshot,
} from './types.js';
import {
  extractErrorCode,
  extractErrorMessage,
  isOrderClosedBusinessError,
  isReplaceTempBlockedError,
  isReplaceUnsupportedByTypeError,
  isRetryableOrderMutationError,
  isWaitWsOnlyReplaceMode,
  normalizePriceText,
  resolveInitialTrackedStatus,
} from './utils.js';
import { attachTrackedOrder } from './routingIndex.js';
import {
  assertStateCheckRawExecutionFactsReady,
  mergeMonotonicOrderFact,
} from './orderFactMerge.js';

/**
 * 只读取权威终态原始快照，不提前删除。
 *
 * 活跃订单的终态必须在 raw 校验、持久化与本地结算全部成功后才能 ack，
 * 否则同一 broker observation 无法安全重试。
 */
export function peekQueriedTerminalState(
  runtime: OrderMonitorRuntimeStore,
  orderId: string,
): TerminalStateSnapshot | null {
  return runtime.queriedTerminalStateByOrderId.get(orderId) ?? null;
}

/** 仅在仍是同一 raw snapshot 时确认消费，避免删除期间到达的新观察。 */
export function acknowledgeQueriedTerminalState(
  runtime: OrderMonitorRuntimeStore,
  orderId: string,
  terminalState: TerminalStateSnapshot,
): void {
  if (runtime.queriedTerminalStateByOrderId.get(orderId) === terminalState) {
    runtime.queriedTerminalStateByOrderId.delete(orderId);
  }
}

/** 只读取改单已确认终态，不在终态结算完成前删除。 */
export function peekLatestReplaceTerminal(
  runtime: OrderMonitorRuntimeStore,
  orderId: string,
): TerminalStateSnapshot | null {
  return runtime.latestReplaceTerminalByOrderId.get(orderId) ?? null;
}

/** 仅在仍是同一终态时确认消费，保留失败后的同一 raw terminal snapshot 供重试。 */
export function acknowledgeLatestReplaceTerminal(
  runtime: OrderMonitorRuntimeStore,
  orderId: string,
  terminalState: TerminalStateSnapshot,
): void {
  if (runtime.latestReplaceTerminalByOrderId.get(orderId) === terminalState) {
    runtime.latestReplaceTerminalByOrderId.delete(orderId);
  }
}

/** 将改单状态恢复到可继续尝试的初始值。 */
function resetTrackedOrderReplaceState(trackedOrder: OrderMonitorTrackedOrder): void {
  trackedOrder.replaceCapability = 'SUPPORTED';
  trackedOrder.replaceBlockedUntilAt = null;
  trackedOrder.replaceTempBlockedCount = 0;
  trackedOrder.replaceResumeMode = 'TIME_BACKOFF';
}

/**
 * 当 WS 显示订单状态已推进时，解除 TEMP_BLOCKED_BY_STATUS 的改单阻塞。
 */
export function resumeOrderReplaceFromWsProgress(trackedOrder: OrderMonitorTrackedOrder): void {
  if (trackedOrder.replaceCapability !== 'TEMP_BLOCKED_BY_STATUS') {
    return;
  }

  resetTrackedOrderReplaceState(trackedOrder);
}

/** 将单订单权威状态查询结果映射为统一撤单 outcome。 */
function mapStateCheckResultToCancelOutcome(
  deps: OrderOpsDeps,
  orderId: string,
  queryResult: OrderStateCheckResult,
): CancelOrderOutcome {
  const { runtime } = deps;
  if (queryResult.kind === 'TERMINAL') {
    runtime.queriedTerminalStateByOrderId.set(orderId, queryResult);

    return {
      kind: 'ALREADY_CLOSED',
      closedReason: queryResult.closedReason,
      relatedBuyOrderIds: null,
      terminalExecution: {
        submittedQuantity: queryResult.submittedQuantity,
        executedQuantity: queryResult.executedQuantity,
      },
    };
  }

  if (queryResult.kind === 'OPEN') {
    return {
      kind: 'UNKNOWN_FAILURE',
      errorCode: null,
    };
  }

  return {
    kind: 'UNKNOWN_FAILURE',
    errorCode: queryResult.errorCode,
  };
}

/** 将 OPEN state-check 的权威观察值并入 tracked 事实与成交副作用。 */
function applyOpenStateCheckFact(
  deps: OrderOpsDeps,
  orderId: string,
  queryResult: Extract<OrderStateCheckResult, { kind: 'OPEN' }>,
): void {
  const trackedOrder = deps.runtime.trackedOrders.get(orderId);
  if (trackedOrder === undefined) {
    return;
  }

  const rawObservedFact = {
    status: queryResult.status,
    executedQuantity: queryResult.executedQuantity,
    executedPrice: queryResult.executedPrice,
    executedTimeMs: queryResult.updatedAtMs,
    updatedAtMs: queryResult.updatedAtMs,
  };
  const previousExecutedQuantity = trackedOrder.executedQuantity;
  const mergedFact = mergeMonotonicOrderFact(trackedOrder, rawObservedFact);
  if (mergedFact === null) {
    return;
  }

  const cumulativeExecutionParams: OrderCumulativeExecutionParams | null =
    mergedFact.executedQuantity > 0
      ? {
          factStage: 'OPEN' as const,
          orderId,
          side: trackedOrder.side === OrderSide.Buy ? 'BUY' : 'SELL',
          monitorSymbol: trackedOrder.monitorSymbol,
          symbol: trackedOrder.symbol,
          isLongSymbol: trackedOrder.isLongSymbol,
          isProtectiveLiquidation: trackedOrder.isProtectiveLiquidation,
          executedPrice: mergedFact.executedPrice,
          executedQuantity: mergedFact.executedQuantity,
          executedTimeMs: mergedFact.executedTimeMs,
          orderUpdatedAtMs: mergedFact.updatedAtMs,
        }
      : null;
  const isProtectiveSell =
    trackedOrder.side === OrderSide.Sell && trackedOrder.isProtectiveLiquidation;
  if (cumulativeExecutionParams !== null && isProtectiveSell) {
    deps.recordCumulativeExecution(cumulativeExecutionParams);
  }

  trackedOrder.status = mergedFact.status;
  trackedOrder.executedQuantity = mergedFact.executedQuantity;
  trackedOrder.executedPrice = mergedFact.executedPrice;
  trackedOrder.lastExecutedTimeMs = mergedFact.executedTimeMs;
  trackedOrder.lastOrderUpdateAtMs = mergedFact.updatedAtMs;
  if (mergedFact.executedQuantity <= 0) {
    return;
  }

  if (
    trackedOrder.side === OrderSide.Sell &&
    mergedFact.executedQuantity > previousExecutedQuantity
  ) {
    deps.orderRecorder.markSellPartialFilled(orderId, mergedFact.executedQuantity);
  }

  if (cumulativeExecutionParams !== null && !isProtectiveSell) {
    deps.recordCumulativeExecution(cumulativeExecutionParams);
  }
}

/** 写入改单后确认的终态，供 route owner 在后续结算时消费。 */
function setReplaceTerminal(
  runtime: OrderMonitorRuntimeStore,
  orderId: string,
  terminalState: TerminalStateSnapshot,
): void {
  runtime.latestReplaceTerminalByOrderId.set(orderId, terminalState);
}

/** 未覆盖的 mutation 请求来源必须立即暴露，不能降级为默认授权。 */
function assertUnreachableOrderMutationRequest(request: never): never {
  throw new Error(`[订单监控] 未覆盖的订单 mutation 请求来源: ${String(request)}`);
}

/** 在每次真实 SDK mutation attempt 前按请求来源检查授权。 */
function isOrderMutationAuthorized(
  request: OrderMutationRequest,
  stage: OrderActionAuthorizationStage,
): boolean {
  switch (request.kind) {
    case 'ORDER_FACT': {
      return true;
    }

    case 'SIGNAL_AUTHORIZED': {
      return request.authorize(stage);
    }

    case 'CONTINUOUS_TRADING_AUTHORIZED': {
      return request.authorize();
    }

    default: {
      return assertUnreachableOrderMutationRequest(request);
    }
  }
}

/**
 * 在已取得的交易 mutation permit 内执行唯一一次 SDK 撤单。
 *
 * route owner、授权及前置检查必须先在同一 permit callback 内完成；这里仅保留真实 broker mutation
 * 与 permit.invoke 的不可分割边界。
 *
 * @param permit 当前交易 mutation permit
 * @param ctx 交易 SDK 上下文
 * @param orderId 待撤销的订单 ID
 * @returns broker 撤单完成后的 Promise
 */
async function invokeCancelOrderWithPermit(
  permit: TradeMutationPermit,
  ctx: OrderOpsDeps['ctx'],
  orderId: string,
): Promise<void> {
  await permit.invoke(() => ctx.cancelOrder(orderId));
}

/** 清理单个订单的改单阻塞与查询缓存，进入“可重试”稳态。 */
function clearReplaceState(trackedOrder: OrderMonitorTrackedOrder): void {
  resetTrackedOrderReplaceState(trackedOrder);
}

/**
 * 确认 state-check 等待期间未被 WS 进展解除并重分配当前 602013 阻塞 owner。
 *
 * state-check 的 OPEN 事实仍可按单调规则合并；但旧请求派生出的 WAIT_WS_ONLY
 * 决策只能归属于启动查询时的同一 replace block，不能覆盖 WS 已重开的 route。
 */
function isReplaceBlockOwnerSnapshotCurrent(
  trackedOrder: OrderMonitorTrackedOrder,
  snapshot: ReplaceBlockOwnerSnapshot,
): boolean {
  return (
    trackedOrder.replaceCapability === snapshot.replaceCapability &&
    trackedOrder.replaceTempBlockedCount === snapshot.replaceTempBlockedCount &&
    trackedOrder.replaceResumeMode === snapshot.replaceResumeMode &&
    trackedOrder.replaceBlockedUntilAt === snapshot.replaceBlockedUntilAt &&
    trackedOrder.lastPriceUpdateAt === snapshot.lastPriceUpdateAt
  );
}

function resolveAttachedTrackedOrder(
  runtime: OrderMonitorRuntimeStore,
  orderId: string,
  trackedOrder: OrderMonitorTrackedOrder,
): OrderMonitorTrackedOrder | null {
  if (runtime.closedOrderIds.has(orderId)) {
    return null;
  }

  if (runtime.trackedOrderLifecycles.get(orderId) !== 'OPEN') {
    return null;
  }

  return runtime.trackedOrders.get(orderId) === trackedOrder ? trackedOrder : null;
}

/**
 * 断言 602013 连续计数仍处于本 handler 可达的内部状态范围。
 *
 * 0..3 分别选择四档退避；4 表示四档均已完成，下一次必须进入权威状态查询。
 */
function assertReplaceTempBlockedRetryIndex(retryIndex: number): void {
  if (
    !Number.isFinite(retryIndex) ||
    !Number.isInteger(retryIndex) ||
    retryIndex < 0 ||
    retryIndex > ORDER_MONITOR_REPLACE_TEMP_BLOCK_BACKOFF_MS.length
  ) {
    throw new Error(`[订单修改] 602013 重试计数无效: ${String(retryIndex)}`);
  }
}

/**
 * 创建订单操作处理器。
 *
 * @param deps 订单操作依赖
 * @returns 订单操作接口
 */
export function createOrderOps(deps: OrderOpsDeps): OrderOps {
  const {
    runtime,
    monitorConfig,
    ctx,
    rateLimiter,
    cacheManager,
    orderHoldRegistry,
    orderStatusQuery,
    triggerRoute,
  } = deps;

  /**
   * 开始追踪订单（订单提交后调用）。
   *
   * @param params 追踪参数
   * @returns 无返回值
   */
  function trackOrder(params: TrackOrderParams): void {
    const {
      orderId,
      symbol,
      side,
      price,
      initialSubmittedPrice,
      quantity,
      submittedAtMs,
      initialStatus,
      isLongSymbol,
      monitorSymbol,
      isProtectiveLiquidation,
      orderType,
    } = params;
    if (monitorSymbol !== monitorConfig.monitorSymbol) {
      throw new Error(
        `[订单监控] trackOrder 收到不匹配的 monitorSymbol=${monitorSymbol}，期望=${monitorConfig.monitorSymbol}`,
      );
    }

    const now = deps.now().getTime();
    const submittedAt =
      typeof submittedAtMs === 'number' && isValidPositiveNumber(submittedAtMs)
        ? submittedAtMs
        : now;
    orderHoldRegistry.trackOrder(orderId, symbol);
    const order: OrderMonitorTrackedOrder = {
      orderId,
      symbol,
      side,
      isLongSymbol,
      monitorSymbol,
      isProtectiveLiquidation,
      orderType,
      submittedPrice: price,
      initialSubmittedPrice,
      submittedQuantity: quantity,
      executedQuantity: 0,
      executedPrice: null,
      lastExecutedTimeMs: null,
      lastOrderUpdateAtMs: null,
      status: resolveInitialTrackedStatus(initialStatus),
      submittedAt,
      lastPriceUpdateAt: now,
      convertedToMarket: false,
      nextCancelAttemptAt: now,
      cancelRetryCount: 0,
      replaceCapability: 'SUPPORTED',
      replaceBlockedUntilAt: null,
      quoteRetryAttempts: 0,
      quoteRetryNextAt: null,
      quoteRetryExhausted: false,
      replaceTempBlockedCount: 0,
      replaceResumeMode: 'TIME_BACKOFF',
      timeoutMarketConversionPending: false,
      timeoutMarketConversionTerminalState: null,
    };
    runtime.trackedOrders.set(orderId, order);
    runtime.trackedOrderLifecycles.set(orderId, 'OPEN');
    attachTrackedOrder(runtime, symbol, orderId);
    if (runtime.runtimeState === 'ACTIVE') {
      triggerRoute(symbol, 'TRACKED');
    }

    logger.debug(
      `[订单监控] 开始追踪订单 ${orderId}，` +
        `标的=${symbol}，方向=${side === OrderSide.Buy ? '买入' : '卖出'}，` +
        `${isLongSymbol ? '做多' : '做空'}标的`,
    );
  }

  /**
   * 撤销订单并返回 outcome。
   *
   * @param orderId 订单 ID
   * @param request 撤单授权来源
   * @param beforeBrokerCancel route owner 的 permit 内前置检查；返回 false 时不调用 broker
   * @returns 语义化撤单结果
   */
  async function cancelOrder(
    orderId: string,
    request: CancelOrderMutationRequest,
    beforeBrokerCancel?: CancelOrderBeforeBrokerMutation,
  ): Promise<CancelOrderPreflightOutcome> {
    const pendingTerminalState = peekQueriedTerminalState(runtime, orderId);
    if (pendingTerminalState !== null) {
      return {
        kind: 'ALREADY_CLOSED',
        closedReason: pendingTerminalState.closedReason,
        relatedBuyOrderIds: null,
        terminalExecution: {
          submittedQuantity: pendingTerminalState.submittedQuantity,
          executedQuantity: pendingTerminalState.executedQuantity,
        },
      };
    }

    try {
      const mutationOutcome = await wrapExternalApiRequest({
        operation: 'TradeContext.cancelOrder',
        request: () =>
          rateLimiter.withTradeMutation(async (permit) => {
            if (
              request.kind !== 'DOOMSDAY_WINDOW' &&
              !isOrderMutationAuthorized(request, 'cancelOrder.beforeApi')
            ) {
              return { kind: 'AUTHORIZATION_REVOKED' } as const;
            }

            if (request.kind === 'DOOMSDAY_WINDOW' && !request.beforeBrokerCancel()) {
              return { kind: 'CANCEL_NOT_STARTED' } as const;
            }

            if (beforeBrokerCancel !== undefined && !beforeBrokerCancel()) {
              return { kind: 'CANCEL_NOT_STARTED' } as const;
            }

            await invokeCancelOrderWithPermit(permit, ctx, orderId);
            return { kind: 'BROKER_CONFIRMED' } as const;
          }),
        shouldRetry: isRetryableOrderMutationError,
      });
      if (mutationOutcome.kind === 'AUTHORIZATION_REVOKED') {
        return {
          kind: 'UNKNOWN_FAILURE',
          errorCode: null,
        };
      }

      if (mutationOutcome.kind === 'CANCEL_NOT_STARTED') {
        return mutationOutcome;
      }

      cacheManager.clearCache();
      logger.debug(`[订单撤销成功] 订单ID=${orderId}，等待 WS 终态确认`);
      return {
        kind: 'CANCEL_CONFIRMED',
        relatedBuyOrderIds: null,
      };
    } catch (error) {
      if (isExternalApiRequestError(error)) {
        throw error;
      }

      const errorCode = extractErrorCode(error);
      if (isRetryableOrderMutationError(error)) {
        return {
          kind: 'RETRYABLE_FAILURE',
          errorCode,
        };
      }

      if (!isOrderClosedBusinessError(error)) {
        return {
          kind: 'UNKNOWN_FAILURE',
          errorCode,
        };
      }

      const queryResult = await orderStatusQuery.checkOrderState(orderId);
      const currentTrackedOrder = runtime.trackedOrders.get(orderId);
      const stateCheckTrackedOrder =
        currentTrackedOrder === undefined
          ? undefined
          : resolveAttachedTrackedOrder(runtime, orderId, currentTrackedOrder);
      if (queryResult.kind !== 'QUERY_FAILED') {
        assertStateCheckRawExecutionFactsReady(stateCheckTrackedOrder, queryResult);
      }

      if (queryResult.kind === 'OPEN') {
        applyOpenStateCheckFact(deps, orderId, queryResult);
      }

      return mapStateCheckResultToCancelOutcome(deps, orderId, queryResult);
    }
  }

  /**
   * 处理 602013（订单状态暂不允许改单）：
   * 前四次指数退避；第五次先做权威状态查询，若非终态才切换 WAIT_WS_ONLY 并仅依赖 WS 推进解锁。
   */
  async function handleReplaceTempBlockedByStatus(
    orderId: string,
    trackedOrder: OrderMonitorTrackedOrder,
    now: number,
  ): Promise<void> {
    const retryIndex = trackedOrder.replaceTempBlockedCount;
    assertReplaceTempBlockedRetryIndex(retryIndex);
    const retryCount = retryIndex + 1;

    if (retryIndex < ORDER_MONITOR_REPLACE_TEMP_BLOCK_BACKOFF_MS.length) {
      const backoffMs = ORDER_MONITOR_REPLACE_TEMP_BLOCK_BACKOFF_MS[retryIndex];
      if (backoffMs === undefined) {
        throw new Error(`[订单修改] 602013 第 ${retryCount} 次退避配置缺失`);
      }

      trackedOrder.lastPriceUpdateAt = now;
      trackedOrder.replaceTempBlockedCount = retryCount;
      trackedOrder.replaceCapability = 'TEMP_BLOCKED_BY_STATUS';
      trackedOrder.replaceBlockedUntilAt = now + backoffMs;
      trackedOrder.replaceResumeMode = 'TIME_BACKOFF';
      logger.warn(
        `[订单修改] 订单 ${orderId} 状态暂不允许改单（602013），第 ${retryCount} 次退避 ${Math.floor(backoffMs / 1000)} 秒`,
      );
      return;
    }

    const replaceBlockOwnerAtStateCheck: ReplaceBlockOwnerSnapshot = {
      replaceCapability: trackedOrder.replaceCapability,
      replaceTempBlockedCount: trackedOrder.replaceTempBlockedCount,
      replaceResumeMode: trackedOrder.replaceResumeMode,
      replaceBlockedUntilAt: trackedOrder.replaceBlockedUntilAt,
      lastPriceUpdateAt: trackedOrder.lastPriceUpdateAt,
    };
    const queryResult = await orderStatusQuery.checkOrderState(orderId);
    const attachedTrackedOrder = resolveAttachedTrackedOrder(runtime, orderId, trackedOrder);
    if (attachedTrackedOrder === null) {
      logger.debug(`[订单修改] 订单 ${orderId} 已脱离追踪，丢弃过期 602013 恢复结果`);
      return;
    }

    if (queryResult.kind !== 'QUERY_FAILED') {
      assertStateCheckRawExecutionFactsReady(attachedTrackedOrder, queryResult);
    }

    if (queryResult.kind === 'OPEN') {
      applyOpenStateCheckFact(deps, orderId, queryResult);
    }

    if (queryResult.kind === 'TERMINAL') {
      attachedTrackedOrder.lastPriceUpdateAt = now;
      clearReplaceState(attachedTrackedOrder);
      runtime.queriedTerminalStateByOrderId.set(orderId, queryResult);
      setReplaceTerminal(runtime, orderId, queryResult);
      logger.warn(`[订单修改] 订单 ${orderId} 连续 602013 后确认已终态，停止改单`);
      return;
    }

    if (!isReplaceBlockOwnerSnapshotCurrent(attachedTrackedOrder, replaceBlockOwnerAtStateCheck)) {
      logger.debug(`[订单修改] 订单 ${orderId} 的 602013 state-check 已过期，丢弃旧阻塞决定`);
      return;
    }

    attachedTrackedOrder.lastPriceUpdateAt = now;
    attachedTrackedOrder.replaceTempBlockedCount = retryCount;
    attachedTrackedOrder.replaceCapability = 'TEMP_BLOCKED_BY_STATUS';
    attachedTrackedOrder.replaceBlockedUntilAt = ORDER_MONITOR_WAIT_WS_ONLY_BLOCK_UNTIL_MS;
    attachedTrackedOrder.replaceResumeMode = 'WAIT_WS_ONLY';
    logger.warn(
      `[订单修改] 订单 ${orderId} 连续 602013 第 5 次后仍未确认终态，切换 WAIT_WS_ONLY 等待 WS`,
    );
  }

  /**
   * 修改订单委托价格。
   *
   * @param orderId 订单 ID
   * @param newPrice 新价格
   * @param request 改单请求及其 API 前授权来源
   * @param quantity 可选新数量（默认剩余数量）
   * @returns Promise<ReplaceOrderPriceOutcome>，区分经纪商确认改单与本地未执行
   */
  async function replaceOrderPriceWithRunner(
    orderId: string,
    newPrice: number,
    request: OrderMutationRequest,
    quantity: number | null,
    runWithPermit: ReplacePermitRunner,
  ): Promise<ReplaceOrderPriceOutcome> {
    if (peekLatestReplaceTerminal(runtime, orderId) !== null) {
      logger.debug(`[订单修改] 订单 ${orderId} 存在未确认终态，拒绝再次改单`);
      return { kind: 'NOT_EXECUTED' };
    }

    const trackedOrder = runtime.trackedOrders.get(orderId);
    if (!trackedOrder) {
      logger.warn(`[订单修改] 订单 ${orderId} 未在追踪列表中`);
      return { kind: 'NOT_EXECUTED' };
    }

    const now = deps.now().getTime();
    if (trackedOrder.replaceCapability === 'UNSUPPORTED_BY_TYPE') {
      logger.debug(`[订单修改] 订单 ${orderId} 已标记为类型不支持改单，跳过`);
      return { kind: 'NOT_EXECUTED' };
    }

    if (isWaitWsOnlyReplaceMode(trackedOrder)) {
      return { kind: 'NOT_EXECUTED' };
    }

    if (
      trackedOrder.replaceCapability === 'TEMP_BLOCKED_BY_STATUS' &&
      trackedOrder.replaceBlockedUntilAt !== null &&
      trackedOrder.replaceBlockedUntilAt > now
    ) {
      return { kind: 'NOT_EXECUTED' };
    }

    const remainingQty = trackedOrder.submittedQuantity - trackedOrder.executedQuantity;
    const targetQuantity = quantity ?? remainingQty;
    if (!Number.isFinite(targetQuantity) || targetQuantity <= 0) {
      logger.warn(`[订单修改] 订单 ${orderId} 剩余数量无效: ${targetQuantity}`);
      return { kind: 'NOT_EXECUTED' };
    }

    const executionFactAtPlan = {
      executedQuantity: trackedOrder.executedQuantity,
      executedPrice: trackedOrder.executedPrice,
      lastExecutedTimeMs: trackedOrder.lastExecutedTimeMs,
      lastOrderUpdateAtMs: trackedOrder.lastOrderUpdateAtMs,
    };

    const normalizedNewPriceText = normalizePriceText(newPrice);
    const normalizedNewPriceDecimal = toDecimal(normalizedNewPriceText);
    const normalizedNewPriceNumber = Number(normalizedNewPriceText);
    const replacePayload = {
      orderId,
      price: normalizedNewPriceDecimal,
      quantity: toDecimal(targetQuantity),
    };

    try {
      const mutationOutcome = await runWithPermit(async (permit) => {
        const attachedTrackedOrder = resolveAttachedTrackedOrder(runtime, orderId, trackedOrder);
        if (attachedTrackedOrder === null) {
          return { kind: 'EXECUTION_FACT_CHANGED' } as const;
        }

        if (
          attachedTrackedOrder.executedQuantity !== executionFactAtPlan.executedQuantity ||
          attachedTrackedOrder.executedPrice !== executionFactAtPlan.executedPrice ||
          attachedTrackedOrder.lastExecutedTimeMs !== executionFactAtPlan.lastExecutedTimeMs ||
          attachedTrackedOrder.lastOrderUpdateAtMs !== executionFactAtPlan.lastOrderUpdateAtMs
        ) {
          return { kind: 'EXECUTION_FACT_CHANGED' } as const;
        }

        if (!isOrderMutationAuthorized(request, 'replaceOrder.beforeApi')) {
          return { kind: 'AUTHORIZATION_REVOKED' } as const;
        }

        await permit.invoke(() => ctx.replaceOrder(replacePayload));
        return { kind: 'BROKER_CONFIRMED' } as const;
      });
      if (mutationOutcome.kind !== 'BROKER_CONFIRMED') {
        return { kind: 'NOT_EXECUTED' };
      }

      cacheManager.clearCache();
      const attachedTrackedOrder = resolveAttachedTrackedOrder(runtime, orderId, trackedOrder);
      if (attachedTrackedOrder === null) {
        logger.debug(
          `[订单修改] 订单 ${orderId} 已脱离追踪，不写回过期本地状态，但保留 broker 已确认改单事实`,
        );
        return { kind: 'BROKER_CONFIRMED' };
      }

      attachedTrackedOrder.submittedPrice = normalizedNewPriceNumber;
      attachedTrackedOrder.submittedQuantity =
        attachedTrackedOrder.executedQuantity + targetQuantity;
      attachedTrackedOrder.lastPriceUpdateAt = now;
      clearReplaceState(attachedTrackedOrder);
      logger.debug(`[订单修改成功] 订单ID=${orderId} 新价格=${normalizedNewPriceText}`);
      return { kind: 'BROKER_CONFIRMED' };
    } catch (error) {
      if (isExternalApiRequestError(error)) {
        throw error;
      }

      const attachedTrackedOrder = resolveAttachedTrackedOrder(runtime, orderId, trackedOrder);
      if (attachedTrackedOrder === null) {
        logger.debug(`[订单修改] 订单 ${orderId} 已脱离追踪，丢弃过期改单失败结果`);
        return { kind: 'NOT_EXECUTED' };
      }

      const message = extractErrorMessage(error);

      if (isReplaceUnsupportedByTypeError(error)) {
        attachedTrackedOrder.lastPriceUpdateAt = now;
        attachedTrackedOrder.replaceCapability = 'UNSUPPORTED_BY_TYPE';
        attachedTrackedOrder.replaceBlockedUntilAt = null;
        attachedTrackedOrder.replaceResumeMode = 'TIME_BACKOFF';
        attachedTrackedOrder.replaceTempBlockedCount = 0;
        logger.warn(`[订单修改] 订单 ${orderId} 类型不支持改单（602012），后续永久禁改`);
        return { kind: 'NOT_EXECUTED' };
      }

      if (isReplaceTempBlockedError(error)) {
        await handleReplaceTempBlockedByStatus(orderId, attachedTrackedOrder, now);
        return { kind: 'NOT_EXECUTED' };
      }

      if (isRetryableOrderMutationError(error)) {
        attachedTrackedOrder.lastPriceUpdateAt = now;
        logger.warn(
          `[订单修改失败] 订单ID=${orderId} 新价格=${normalizedNewPriceText}: ${message}`,
        );
        return { kind: 'NOT_EXECUTED' };
      }

      if (isOrderClosedBusinessError(error)) {
        const queryResult = await orderStatusQuery.checkOrderState(orderId);
        const latestAttachedTrackedOrder = resolveAttachedTrackedOrder(
          runtime,
          orderId,
          trackedOrder,
        );
        if (latestAttachedTrackedOrder === null) {
          logger.debug(`[订单修改] 订单 ${orderId} 已脱离追踪，丢弃过期改单终态查询结果`);
          return { kind: 'NOT_EXECUTED' };
        }

        if (queryResult.kind !== 'QUERY_FAILED') {
          assertStateCheckRawExecutionFactsReady(latestAttachedTrackedOrder, queryResult);
        }

        if (queryResult.kind === 'OPEN') {
          applyOpenStateCheckFact(deps, orderId, queryResult);
        }

        latestAttachedTrackedOrder.lastPriceUpdateAt = now;
        if (queryResult.kind === 'TERMINAL') {
          clearReplaceState(latestAttachedTrackedOrder);
          runtime.queriedTerminalStateByOrderId.set(orderId, queryResult);
          setReplaceTerminal(runtime, orderId, queryResult);
          logger.warn(`[订单修改] 订单 ${orderId} 业务失败后确认已终态，停止改单流程`);
          return { kind: 'NOT_EXECUTED' };
        }

        if (queryResult.kind === 'OPEN') {
          return { kind: 'NOT_EXECUTED' };
        }

        return { kind: 'NOT_EXECUTED' };
      }

      attachedTrackedOrder.lastPriceUpdateAt = now;
      logger.error(`[订单修改失败] 订单ID=${orderId} 新价格=${normalizedNewPriceText}: ${message}`);
      return { kind: 'NOT_EXECUTED' };
    }
  }

  /** 由 OrderMonitor 自主 owner 发起的改单：每次 SDK retry 都重新取得一个 mutation permit。 */
  async function replaceOrderPrice(
    orderId: string,
    newPrice: number,
    request: OrderMutationRequest,
    quantity: number | null = null,
  ): Promise<ReplaceOrderPriceOutcome> {
    return replaceOrderPriceWithRunner(orderId, newPrice, request, quantity, async (mutation) =>
      wrapExternalApiRequest({
        operation: 'TradeContext.replaceOrder',
        request: () => rateLimiter.withTradeMutation(mutation),
        shouldRetry: isRetryableOrderMutationError,
      }),
    );
  }

  /**
   * 信号卖单合并在外层 callback permit 内完成最终 quote 后，使用同一 permit 执行唯一一次 SDK 改单。
   * 此路径不重新排队，且不会接受无 permit 的兼容调用。
   */
  async function replaceOrderPriceWithPermit(
    orderId: string,
    newPrice: number,
    request: OrderMutationRequest,
    permit: TradeMutationPermit,
    quantity: number | null = null,
  ): Promise<ReplaceOrderPriceOutcome> {
    const singleAttemptPermit: TradeMutationPermit = {
      invoke: <T>(operation: () => Promise<T>): Promise<T> =>
        permit.invoke(() =>
          wrapExternalApiRequest({
            operation: 'TradeContext.replaceOrder',
            request: operation,
            retryConfig: {
              retries: 0,
              delayMs: 0,
            },
          }),
        ),
    };

    return replaceOrderPriceWithRunner(orderId, newPrice, request, quantity, async (mutation) =>
      mutation(singleAttemptPermit),
    );
  }

  return {
    trackOrder,
    cancelOrder,
    replaceOrderPrice,
    replaceOrderPriceWithPermit,
  };
}
