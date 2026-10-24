/**
 * orderExecutor 提交流程模块
 *
 * 职责：
 * - 计算买卖数量并完成卖单合并与前置撤单决策
 * - 构造订单载荷并提交到 Trade API
 * - 在提交成功后注册 orderMonitor 追踪与卖单防重占用
 */
import { DIAGNOSTIC_OPERATIONS } from '../../constants/diagnostics.js';
import { isExternalApiRequestError } from '../../utils/apiFailure/index.js';
import { isHongKongSymbol } from '../../utils/marketScope.js';
import {
  compareRatios,
  exactAdd,
  exactCompare,
  safeQuantityNumber,
} from '../../utils/numeric/exact.js';
import { formatSymbolDisplay } from '../../utils/display/index.js';
import type { TradeSubmitCommand } from '../../types/tradeMutationPorts.js';
import type { Signal } from '../../types/signal.js';
import type { CancelOrderOutcome } from '../../types/orderCancellation.js';
import type { OrderActionAuthorization, SellMergeDecision } from '../../domain/order/types.js';
import { buildOrderRemark } from '../../domain/order/orderRemark.js';
import { resolveOrderTypeConfig } from '../../domain/order/orderTypePolicy.js';
import { resolveSellMergeDecision } from '../../domain/order/sellMergePolicy.js';
import {
  formatCancelOutcomeTag,
  isTerminalNonFilledCloseConfirmed,
} from '../../domain/order/cancelOutcomePolicy.js';
import type {
  DoomsdayClearanceOrderCommand,
  OrderActionResult,
  RelatedBuyOrderQuantityValidationParams,
  SubmitOrderParams,
  SubmitTargetOrder,
  SubmitTargetOrderDeps,
} from './types.js';
import {
  getActionDescription,
  getOrderTypeFromConfig,
  isLiquidationSignal,
} from '../../domain/order/executionPolicy.js';
import {
  createTradeMutationUnknownError,
  createAcceptedOrderLocalSyncError,
} from './tradeMutationErrors.js';
import { handleSubmitError } from './submitFailureLogging.js';
import { createQuantityResolver } from './quantityResolver.js';
import { recordOrderExecutionOutcome } from './diagnostics.js';

/** 已发出的撤单/查询全部落定后才返回或抛错；内部错误优先，保留原错误身份。 */
async function settleCancelFanout(
  requests: ReadonlyArray<Promise<CancelOrderOutcome>>,
): Promise<ReadonlyArray<CancelOrderOutcome>> {
  const settled = await Promise.allSettled(requests);
  const failures = settled.filter((result) => result.status === 'rejected');
  const failure =
    failures.find((result) => !isExternalApiRequestError(result.reason)) ?? failures[0];
  if (failure) throw failure.reason;

  return settled.map((result) => {
    if (result.status !== 'fulfilled') throw new TypeError('撤单 settled 结果不变量失效');

    return result.value;
  });
}

function isFilledCancelOutcome(outcome: CancelOrderOutcome): boolean {
  return outcome.kind === 'ALREADY_CLOSED' && outcome.closedReason === 'FILLED';
}

function mergeRelatedBuyOrderIds(
  left: ReadonlyArray<string> | null | undefined,
  right: ReadonlyArray<string> | null | undefined,
): ReadonlyArray<string> | null {
  const merged = [...(left ?? []), ...(right ?? [])];
  if (merged.length === 0) {
    return null;
  }

  return [...new Set(merged)];
}

/**
 * 判断等待 mutation permit 前后卖单合并所依据的事实是否完全一致。
 * 一旦挂单状态变化，原信号不得基于新事实自动重规划改单，必须拒绝执行。
 *
 * @param queuedDecision 排队前已确认的合并决策
 * @param currentDecision 取得 permit 后基于实时挂单重算的合并决策
 * @returns 五项合并事实完全一致时返回 true
 */
function hasSameSellMergeDecisionFacts(
  queuedDecision: SellMergeDecision,
  currentDecision: SellMergeDecision,
): boolean {
  return (
    queuedDecision.action === currentDecision.action &&
    queuedDecision.targetOrderId === currentDecision.targetOrderId &&
    queuedDecision.mergedQuantity === currentDecision.mergedQuantity &&
    queuedDecision.pendingRemainingQuantity === currentDecision.pendingRemainingQuantity &&
    queuedDecision.pendingOrderIds.length === currentDecision.pendingOrderIds.length &&
    queuedDecision.pendingOrderIds.every(
      (orderId, index) => orderId === currentDecision.pendingOrderIds[index],
    )
  );
}

function getOutcomeRelatedBuyOrderIds(outcome: CancelOrderOutcome): ReadonlyArray<string> {
  if (outcome.kind === 'CANCEL_CONFIRMED' || outcome.kind === 'ALREADY_CLOSED') {
    return outcome.relatedBuyOrderIds ?? [];
  }

  return [];
}

/**
 * 解析最终卖单应登记的关联买单集合。
 * 显式传入 null 表示独立卖出路径（末日清仓、距离换仓）不继承智能平仓关联，
 * 只有调用方未提供该字段时才允许使用信号携带的普通关联集合。
 *
 * @param side 中性订单方向
 * @param signal 当前交易信号
 * @param relatedBuyOrderIds 调用方显式提供的关联集合或未提供标记
 * @returns 最终卖单关联集合；买单始终返回 null
 */
function resolveSellRelatedBuyOrderIds(
  side: 'BUY' | 'SELL',
  signal: Signal,
  relatedBuyOrderIds: ReadonlyArray<string> | null | undefined,
): ReadonlyArray<string> | null {
  if (side !== 'SELL') {
    return null;
  }

  if (relatedBuyOrderIds !== undefined) {
    return relatedBuyOrderIds;
  }

  return signal.relatedBuyOrderIds ?? null;
}

/**
 * 校验智能平仓的整单关联集合能否精确表示最终卖出数量。
 *
 * 订单记录器按关联 ID 整笔扣减买单，因此最终 broker 数量必须等于这些
 * 未平仓买单的成交数量之和；否则提交后会使 pending 占用与结算账本分叉。
 * 空关联集合属于普通全仓卖出，不适用该整单不变量。
 *
 * @param params 关联买单、方向与最终提交数量
 * @returns 关联集合精确表示最终数量时返回 true
 */
function hasExactRelatedBuyOrderQuantity(params: RelatedBuyOrderQuantityValidationParams): boolean {
  const { orderRecorder, symbol, isLongSymbol, submittedQuantity, relatedBuyOrderIds } = params;
  if (relatedBuyOrderIds.length === 0) {
    return true;
  }

  if (!Number.isSafeInteger(submittedQuantity) || submittedQuantity <= 0) {
    return false;
  }

  const uniqueRelatedBuyOrderIds = new Set(relatedBuyOrderIds);
  if (uniqueRelatedBuyOrderIds.size !== relatedBuyOrderIds.length) {
    return false;
  }

  const buyOrdersById = new Map(
    orderRecorder
      .getBuyOrdersForSymbol(symbol, isLongSymbol)
      .map((order) => [order.orderId, order] as const),
  );
  let relatedQuantity = '0';
  for (const orderId of relatedBuyOrderIds) {
    const order = buyOrdersById.get(orderId);
    if (!order || !Number.isSafeInteger(order.executedQuantity) || order.executedQuantity <= 0) {
      return false;
    }

    relatedQuantity = exactAdd(relatedQuantity, String(order.executedQuantity));
  }

  return exactCompare(relatedQuantity, String(submittedQuantity)) === 0;
}

/**
 * 创建在每次 REPLACE SDK attempt 前重新校验整单关联不变量的授权器。
 *
 * @param authorizeOrderAction 原始信号授权器
 * @param validationParams 最终 REPLACE 数量与关联集合
 * @returns 同时满足信号授权和关联数量精确性的授权器
 */
function createRelatedBuyOrderReplaceAuthorization(
  authorizeOrderAction: OrderActionAuthorization,
  validationParams: RelatedBuyOrderQuantityValidationParams | null,
): OrderActionAuthorization {
  if (validationParams === null) {
    return authorizeOrderAction;
  }

  return (stage) =>
    authorizeOrderAction(stage) && hasExactRelatedBuyOrderQuantity(validationParams);
}

/**
 * 判断终态数量是否可作为重规划事实。
 *
 * @param quantity 经纪商终态或账户快照中的数量
 * @returns 数量为非负安全整数时返回 true
 */
function isValidNonNegativeQuantity(quantity: number | null): quantity is number {
  return quantity !== null && Number.isSafeInteger(quantity) && quantity >= 0;
}

/**
 * 基于已确认终态和撤单后的账户可卖量，重算替换卖单数量。
 *
 * @param cancelOutcomes 每个被撤销卖单的已结算终态结果
 * @param freshAvailableQuantity 撤单完成后刚读取的可卖上限
 * @param freshSignalQuantity 当前新信号在同一账户快照下允许卖出的数量
 * @returns 可安全提交的数量；任一终态事实不可信时返回 null
 */
function resolveReplannedSellQuantity(
  cancelOutcomes: ReadonlyArray<CancelOrderOutcome>,
  freshAvailableQuantity: number,
  freshSignalQuantity: number,
): number | null {
  if (
    !Number.isSafeInteger(freshAvailableQuantity) ||
    freshAvailableQuantity <= 0 ||
    !Number.isSafeInteger(freshSignalQuantity) ||
    freshSignalQuantity <= 0
  ) {
    return null;
  }

  let remainingCancelledQuantity = '0';
  for (const outcome of cancelOutcomes) {
    if (outcome.kind !== 'ALREADY_CLOSED') {
      return null;
    }

    const { submittedQuantity, executedQuantity } = outcome.terminalExecution;
    if (
      !isValidNonNegativeQuantity(submittedQuantity) ||
      !isValidNonNegativeQuantity(executedQuantity) ||
      executedQuantity > submittedQuantity
    ) {
      return null;
    }

    remainingCancelledQuantity = exactAdd(
      remainingCancelledQuantity,
      String(submittedQuantity - executedQuantity),
    );
  }

  const replannedQuantity = exactAdd(remainingCancelledQuantity, String(freshSignalQuantity));
  return exactCompare(replannedQuantity, String(freshAvailableQuantity)) > 0
    ? freshAvailableQuantity
    : safeQuantityNumber(replannedQuantity);
}

/**
 * 创建 submitTargetOrder 实现。
 *
 * @param deps 提交流程依赖
 * @returns 目标订单提交函数
 */
export function createSubmitTargetOrder(deps: SubmitTargetOrderDeps): SubmitTargetOrder {
  const { logger } = deps;
  const {
    rateLimiter,
    cacheManager,
    orderMonitor,
    orderRecorder,
    globalConfig,
    readSellPositions,
    tradeMutationPort,
    marketDataClient,
    monitorConfig,
    unrealizedLossBuyGate,
    canExecuteSignal,
    canTradeNow,
    recordBuyAttempt,
    now,
  } = deps;
  // 数量解析的 0 也可能是授权拒绝哨兵，诊断只描述派生执行结果，不据此声称真实可卖量为零。
  const quantityResolver = createQuantityResolver({
    logger: logger,
    rateLimiter,
    readSellPositions,
  });

  /**
   * 提交订单并在成功后登记运行态追踪。
   *
   * @param params 提交参数
   * @returns 成功提交的订单结果或明确跳过结果
   * @throws 当远端下单成功但本地追踪登记失败时抛错，避免静默丢失订单状态
   */
  async function submitOrder(params: SubmitOrderParams): Promise<OrderActionResult> {
    const {
      command,
      authorizeOrderAction,
      submittedQuantity,
      orderTypeConfig,
      remark,
      relatedBuyOrderIds,
      isSellAvailabilityCurrent,
    } = params;
    const { signal, side } = command;
    const orderTypeParam = getOrderTypeFromConfig(orderTypeConfig);
    const symbol = signal.symbol;
    const sellRelatedBuyOrderIds = resolveSellRelatedBuyOrderIds(side, signal, relatedBuyOrderIds);

    if (!canExecuteSignal(signal, 'submitOrder')) {
      return { kind: 'SKIPPED' };
    }

    const symbolDisplayForLog = formatSymbolDisplay(symbol, signal.symbolName ?? null);
    const finalAuthorizationAborted = new Error('原 caller 最终提交授权失效');
    const sellAvailabilityChanged = new Error('独立卖出可卖量计划已失效');
    const recordSellMergeChanged = (): void => {
      recordOrderExecutionOutcome(
        deps.diagnostics,
        signal,
        'submitOrder.beforeApi',
        'BLOCKED',
        'SELL_MERGE_DECISION_CHANGED',
        () => ({ mutation: 'SUBMIT' }),
      );
    };

    try {
      return await rateLimiter.withTradeMutation(async (permit) => {
        if (!authorizeOrderAction('submitOrder.beforeApi')) return { kind: 'SKIPPED' };

        if (isSellAvailabilityCurrent !== undefined && !isSellAvailabilityCurrent()) {
          recordOrderExecutionOutcome(
            deps.diagnostics,
            signal,
            'submitOrder.beforeApi',
            'BLOCKED',
            'SELL_AVAILABILITY_CHANGED',
            () => ({ mutation: 'SUBMIT' }),
          );
          return { kind: 'SELL_AVAILABILITY_CHANGED', symbol };
        }

        const finalQuotes = await marketDataClient.getQuotes([symbol]);
        if (!authorizeOrderAction('submitOrder.beforeApi')) return { kind: 'SKIPPED' };

        if (isSellAvailabilityCurrent !== undefined && !isSellAvailabilityCurrent()) {
          recordOrderExecutionOutcome(
            deps.diagnostics,
            signal,
            'submitOrder.beforeApi',
            'BLOCKED',
            'SELL_AVAILABILITY_CHANGED',
            () => ({ mutation: 'SUBMIT' }),
          );
          return { kind: 'SELL_AVAILABILITY_CHANGED', symbol };
        }

        const finalQuote = finalQuotes.get(symbol) ?? null;
        if (finalQuote === null) {
          logger.warn(`[订单提交] 最终执行行情缺失，尚未提交: ${symbolDisplayForLog}`);
          recordOrderExecutionOutcome(
            deps.diagnostics,
            signal,
            'submitOrder.finalQuote',
            'SKIPPED',
            'QUOTE_MISSING',
            () => ({ mutation: 'SUBMIT' }),
          );
          return { kind: 'QUOTE_MISSING', symbol };
        }

        if (exactCompare(finalQuote.price, '0') <= 0) {
          logger.warn(`[订单提交] 最终执行行情无效，尚未提交: ${symbolDisplayForLog}`);
          recordOrderExecutionOutcome(
            deps.diagnostics,
            signal,
            'submitOrder.finalQuote',
            'SKIPPED',
            'QUOTE_INVALID',
            () => ({ mutation: 'SUBMIT', price: finalQuote.price }),
          );
          return { kind: 'QUOTE_INVALID', symbol };
        }

        if (!authorizeOrderAction('submitOrder.beforeApi')) {
          return { kind: 'SKIPPED' };
        }

        if (command.kind === 'BUY') {
          const unrealizedLossCheck = unrealizedLossBuyGate.checkUnrealizedLoss(
            symbol,
            finalQuote.price,
            command.direction === 'LONG',
          );
          if (unrealizedLossCheck.shouldLiquidate) {
            logger.warn(
              `[订单提交] 当前浮亏已触发保护性清仓阈值，拒绝买入: ${symbolDisplayForLog}`,
            );

            recordOrderExecutionOutcome(
              deps.diagnostics,
              signal,
              'submitOrder.buyRisk',
              'BLOCKED',
              'UNREALIZED_LOSS_LIMIT',
              () => ({ mutation: 'SUBMIT', price: finalQuote.price }),
            );
            return { kind: 'SKIPPED' };
          }
        }

        let finalSubmittedQuantity = submittedQuantity;
        if (side === 'BUY') {
          if (!canTradeNow(signal.action).canTrade) {
            logger.debug(`[订单提交] 最终买入频率检查未通过，跳过: ${symbol}`);
            recordOrderExecutionOutcome(
              deps.diagnostics,
              signal,
              'submitOrder.buyThrottle',
              'BLOCKED',
              'BUY_THROTTLED',
              () => ({ mutation: 'SUBMIT' }),
            );
            return { kind: 'SKIPPED' };
          }

          const latestBuyCost = orderRecorder.getLatestBuyOrderCost(
            symbol,
            command.direction === 'LONG',
          );
          if (
            latestBuyCost !== null &&
            (!Number.isSafeInteger(latestBuyCost.quantity) || latestBuyCost.quantity <= 0)
          ) {
            throw new RangeError('[订单提交] 最新买单成本数量必须是正安全整数');
          }

          if (
            latestBuyCost !== null &&
            compareRatios(
              finalQuote.price,
              '1',
              latestBuyCost.costAmount,
              String(latestBuyCost.quantity),
            ) >= 0
          ) {
            logger.warn(`[订单提交] 最终买入价格触及最新买入价，跳过: ${symbol}`);
            recordOrderExecutionOutcome(
              deps.diagnostics,
              signal,
              'submitOrder.buyPrice',
              'BLOCKED',
              'LATEST_BUY_COST_REACHED',
              () => ({
                mutation: 'SUBMIT',
                price: finalQuote.price,
                latestBuyCostAmount: latestBuyCost.costAmount,
                latestBuyQuantity: latestBuyCost.quantity.toString(),
              }),
            );
            return { kind: 'SKIPPED' };
          }

          finalSubmittedQuantity = quantityResolver.resolveBuyQuantity(
            signal,
            command.direction === 'SHORT',
            monitorConfig.targetNotional,
            finalQuote.price,
            finalQuote.lotSize,
          );
        }

        if (finalSubmittedQuantity === null || finalSubmittedQuantity === 0) {
          recordOrderExecutionOutcome(
            deps.diagnostics,
            signal,
            'submitOrder.quantity',
            'SKIPPED',
            'NO_SUBMITTABLE_QUANTITY',
            () => ({
              mutation: 'SUBMIT',
              ...(finalSubmittedQuantity === null
                ? {}
                : { quantity: finalSubmittedQuantity.toString() }),
            }),
          );
          return { kind: 'SKIPPED' };
        }

        if (!Number.isSafeInteger(finalSubmittedQuantity) || finalSubmittedQuantity <= 0) {
          throw new RangeError('[订单提交] 最终订单数量必须是正安全整数');
        }

        if (
          sellRelatedBuyOrderIds !== null &&
          !hasExactRelatedBuyOrderQuantity({
            orderRecorder,
            symbol,
            isLongSymbol: command.direction === 'LONG',
            submittedQuantity: finalSubmittedQuantity,
            relatedBuyOrderIds: sellRelatedBuyOrderIds,
          })
        ) {
          logger.warn(`[订单提交] 关联买单无法整单表示最终卖出数量，拒绝提交: ${symbol}`);
          recordOrderExecutionOutcome(
            deps.diagnostics,
            signal,
            'submitOrder.relatedBuyOrders',
            'BLOCKED',
            'RELATED_BUY_QUANTITY_MISMATCH',
            () => ({ mutation: 'SUBMIT', quantity: finalSubmittedQuantity.toString() }),
          );
          return { kind: 'SKIPPED' };
        }

        if (orderTypeParam === 'MO') {
          logger.debug(`[订单类型] 使用市价单(MO)，标的=${symbolDisplayForLog}`);
        } else {
          const orderTypeLabel = orderTypeParam === 'LO' ? '限价单' : '增强限价单';
          const orderTypeCode = orderTypeParam;
          logger.debug(
            `[订单类型] 使用${orderTypeLabel}(${orderTypeCode})，标的=${symbolDisplayForLog}，价格=${finalQuote.price}`,
          );
        }

        const neutralType = orderTypeConfig;
        const orderPayload: TradeSubmitCommand = {
          symbol,
          side: command.kind,
          purpose: command.purpose,
          timeInForce: 'DAY',
          submittedQuantity: finalSubmittedQuantity,
          ...(neutralType === 'MO'
            ? ({ orderType: 'MO' } as const)
            : { orderType: neutralType, submittedPrice: finalQuote.price }),
          ...(remark ? { remark: remark.slice(0, 60) } : {}),
        };

        const submittedAtMs = now().getTime();
        if (!Number.isSafeInteger(submittedAtMs)) {
          throw new TypeError('[订单提交] 提交时钟必须返回有效毫秒时间');
        }

        if (!authorizeOrderAction('submitOrder.beforeApi')) return { kind: 'SKIPPED' };

        // 普通 SELL 保留原合单门禁；末日及距离换仓沿读仓前 owner 证明独立新增。
        const isSellSubmissionCurrent = (): boolean => {
          if (
            command.executionPurpose === 'DOOMSDAY_CLEARANCE' ||
            signal.executionOrigin === 'SWITCH_MOVE'
          ) {
            if (isSellAvailabilityCurrent === undefined)
              throw new TypeError('[独立卖出] 缺少读仓前的可卖量计划证明');

            if (!isSellAvailabilityCurrent()) throw sellAvailabilityChanged;

            return true;
          }

          return (
            side !== 'SELL' ||
            resolveSellMergeDecision({
              pendingOrders: orderMonitor.getPendingSellOrders(symbol),
              newOrderQuantity: finalSubmittedQuantity,
              newOrderType: orderTypeParam,
              isProtectiveLiquidation: isLiquidationSignal(signal),
            }).action === 'SUBMIT'
          );
        };

        const onRemoteIssued = (): void => {
          if (!authorizeOrderAction('submitOrder.beforeApi')) throw finalAuthorizationAborted;

          if (!isSellSubmissionCurrent()) {
            recordSellMergeChanged();
            throw finalAuthorizationAborted;
          }

          // adapter 已完成序列化/容量证明，才登记真实提交尝试；PRE_SUBMIT 拒绝不占买入频率。
          if (command.kind === 'BUY') recordBuyAttempt(signal.action);
        };
        const response = await permit.invoke(async () => {
          if (!authorizeOrderAction('submitOrder.beforeApi')) return null;

          if (!isSellSubmissionCurrent()) {
            recordSellMergeChanged();
            return null;
          }

          return tradeMutationPort.submitOrder(orderPayload, onRemoteIssued);
        });
        if (response === null) return { kind: 'SKIPPED' };

        if (response.kind === 'REJECTED') {
          recordOrderExecutionOutcome(
            deps.diagnostics,
            signal,
            'submitOrder.brokerResult',
            'REJECTED',
            'BROKER_REJECTED',
            () => ({
              mutation: 'SUBMIT',
              sdkOperation: response.operation,
              requestAttempted: response.requestAttempted,
              code: response.code,
              quantity: finalSubmittedQuantity.toString(),
              ...(orderPayload.submittedPrice === undefined
                ? {}
                : { price: orderPayload.submittedPrice }),
              localSyncStatus: 'NOT_APPLICABLE',
            }),
          );
          handleSubmitError(logger, response, signal, orderPayload);
          return { kind: 'REJECTED' };
        }

        if (response.kind === 'UNKNOWN') {
          try {
            const seatVersion = signal.seatVersion;
            const triggerTimeMs = signal.triggerTime?.getTime();
            deps.diagnostics.record(DIAGNOSTIC_OPERATIONS.ORDER_SUBMIT_UNKNOWN_FATAL, {
              stage: 'submitOrder.brokerResult',
              outcome: 'UNKNOWN',
              reasonCode: 'BROKER_SUBMIT_UNKNOWN',
              symbol,
              action: signal.action,
              ...(Number.isFinite(seatVersion) ? { seatVersion } : {}),
              ...(typeof triggerTimeMs === 'number' && Number.isFinite(triggerTimeMs)
                ? { triggerTimeMs }
                : {}),
              mutation: 'SUBMIT',
              localSyncStatus: 'NOT_STARTED',
              side,
              purpose: orderPayload.purpose,
              orderType: orderPayload.orderType,
              sdkOperation: response.operation,
              requestAttempted: response.requestAttempted,
              code: response.code,
              count: 1,
            });
          } catch {
            // 诊断不得覆盖原 UNKNOWN fatal，也不得触发重提或猜测 broker orderId。
          }

          throw createTradeMutationUnknownError(response);
        }

        const { orderId } = response;
        if (typeof orderId !== 'string' || orderId.length === 0)
          throw new TypeError('broker 返回无效 orderId');

        // 真实 accepted 必须先于任何本地同步；后续失败不能被解释为未提交。
        recordOrderExecutionOutcome(
          deps.diagnostics,
          signal,
          'submitOrder.brokerResult',
          'BROKER_ACCEPTED',
          'BROKER_ACCEPTED',
          () => ({
            mutation: 'SUBMIT',
            orderId,
            sdkOperation: response.operation,
            requestAttempted: response.requestAttempted,
            quantity: finalSubmittedQuantity.toString(),
            ...(orderPayload.submittedPrice === undefined
              ? {}
              : { price: orderPayload.submittedPrice }),
            localSyncStatus: 'PENDING',
          }),
        );
        const isLongSymbol = command.direction === 'LONG';
        const isProtectiveLiquidation = isLiquidationSignal(signal);
        try {
          cacheManager.clearCache();
          orderMonitor.trackOrder({
            orderId,
            symbol,
            side,
            executionSide: command.kind,
            price: orderTypeParam === 'MO' ? null : finalQuote.price,
            initialSubmittedPrice: orderTypeParam === 'MO' ? null : finalQuote.price,
            quantity: finalSubmittedQuantity,
            submittedAtMs,
            isLongSymbol,
            monitorSymbol: monitorConfig.monitorSymbol,
            isProtectiveLiquidation,
            orderType: orderTypeParam,
          });

          if (side === 'SELL' && sellRelatedBuyOrderIds) {
            const direction: 'LONG' | 'SHORT' = isLongSymbol ? 'LONG' : 'SHORT';
            orderRecorder.submitSellOrder(
              orderId,
              symbol,
              direction,
              finalSubmittedQuantity,
              sellRelatedBuyOrderIds,
              submittedAtMs,
            );
          }
        } catch (error) {
          recordOrderExecutionOutcome(
            deps.diagnostics,
            signal,
            'submitOrder.localSync',
            'ACCEPTED_LOCAL_SYNC_FAILED',
            'LOCAL_SYNC_FAILED',
            () => ({
              mutation: 'SUBMIT',
              orderId,
              requestAttempted: response.requestAttempted,
              localSyncStatus: 'FAILED',
            }),
          );
          throw createAcceptedOrderLocalSyncError(orderId, error);
        }

        recordOrderExecutionOutcome(
          deps.diagnostics,
          signal,
          'submitOrder.localSync',
          'LOCAL_SYNC_SUCCEEDED',
          'LOCAL_SYNC_SUCCEEDED',
          () => ({
            mutation: 'SUBMIT',
            orderId,
            requestAttempted: response.requestAttempted,
            localSyncStatus: 'SUCCEEDED',
          }),
        );
        const actionDesc = getActionDescription(signal.action);
        logger.info(
          `[订单提交成功] ${actionDesc} ${orderPayload.symbol} 数量=${orderPayload.submittedQuantity} 订单ID=${orderId}`,
        );
        return { kind: 'SUBMITTED', orderId };
      });
    } catch (error) {
      // 只接收本轮私有取消身份；任何内部/SDK 错误即使原授权过期仍原样暴露。
      if (error === finalAuthorizationAborted) return { kind: 'SKIPPED' };

      if (error === sellAvailabilityChanged) {
        recordOrderExecutionOutcome(
          deps.diagnostics,
          signal,
          'submitOrder.beforeApi',
          'BLOCKED',
          'SELL_AVAILABILITY_CHANGED',
          () => ({ mutation: 'SUBMIT' }),
        );
        return { kind: 'SELL_AVAILABILITY_CHANGED', symbol };
      }

      throw error;
    }
  }

  /**
   * 末日只为执行时的权威可卖量新增 SELL，既有卖单的数量、目的与类型均不变。
   * 读仓仍在 mutation permit 外限流；本次证明跨越所有等待，失效或超时跟进交接由窗口稍后重评估。
   */
  async function submitDoomsdayClearanceSell(
    command: DoomsdayClearanceOrderCommand,
    authorizeOrderAction: OrderActionAuthorization,
  ): Promise<OrderActionResult> {
    const { signal } = command;
    const symbol = signal.symbol;
    const isSellAvailabilityCurrent = orderMonitor.captureSellAvailabilityGuard(symbol);
    if (!isSellAvailabilityCurrent()) {
      recordOrderExecutionOutcome(
        deps.diagnostics,
        signal,
        'submitDoomsdayClearanceSell',
        'BLOCKED',
        'SELL_AVAILABILITY_CHANGED',
        () => ({ mutation: 'SUBMIT' }),
      );
      return { kind: 'SELL_AVAILABILITY_CHANGED', symbol };
    }

    const freshSubmittedQuantity = await quantityResolver.readFreshAvailableSellQuantity(
      symbol,
      () => authorizeOrderAction('executeSignals'),
    );
    if (!authorizeOrderAction('submitOrder.beforeApi')) return { kind: 'SKIPPED' };

    if (!isSellAvailabilityCurrent()) {
      recordOrderExecutionOutcome(
        deps.diagnostics,
        signal,
        'submitDoomsdayClearanceSell',
        'BLOCKED',
        'SELL_AVAILABILITY_CHANGED',
        () => ({ mutation: 'SUBMIT' }),
      );
      return { kind: 'SELL_AVAILABILITY_CHANGED', symbol };
    }

    if (freshSubmittedQuantity === 0) {
      recordOrderExecutionOutcome(
        deps.diagnostics,
        signal,
        'submitDoomsdayClearanceSell.quantity',
        'SKIPPED',
        'NO_POSITIVE_EXECUTABLE_QUANTITY',
        () => ({ mutation: 'SUBMIT' }),
      );
      return { kind: 'SKIPPED' };
    }

    return submitOrder({
      command,
      authorizeOrderAction,
      submittedQuantity: freshSubmittedQuantity,
      isSellAvailabilityCurrent,
      orderTypeConfig: globalConfig.tradingOrderType,
      remark: buildOrderRemark(false),
      relatedBuyOrderIds: null,
    });
  }

  /**
   * 根据信号构建并提交订单。
   * 卖出分支包含卖单合并（REPLACE/CANCEL_AND_SUBMIT/SUBMIT/SKIP）。
   *
   * @param command 已在执行入口解析并固化身份的订单命令
   * @returns 新提交、已确认改单或明确跳过
   */
  return async function submitTargetOrder(
    command,
    authorizeOrderAction,
  ): Promise<OrderActionResult> {
    const { signal, side } = command;
    const symbol = signal.symbol;

    // 最简市场门禁：非港股不进入任何报价、持仓读取、合并或原生提交副作用。
    if (!isHongKongSymbol(symbol)) {
      logger.warn(
        `[订单提交] 非港股标的禁止交易，跳过: ${formatSymbolDisplay(symbol, signal.symbolName ?? null)}`,
      );

      recordOrderExecutionOutcome(
        deps.diagnostics,
        signal,
        'submitTargetOrder',
        'BLOCKED',
        'NON_HONG_KONG_SYMBOL',
      );
      return { kind: 'SKIPPED' };
    }

    if (!authorizeOrderAction('executeSignals') || !canExecuteSignal(signal, 'submitTargetOrder')) {
      return { kind: 'SKIPPED' };
    }

    if (command.executionPurpose === 'DOOMSDAY_CLEARANCE') {
      return submitDoomsdayClearanceSell(command, authorizeOrderAction);
    }

    const orderTypeConfig = resolveOrderTypeConfig(signal, globalConfig);
    const orderType = getOrderTypeFromConfig(orderTypeConfig);
    const isProtectiveLiquidation = isLiquidationSignal(signal);
    const remark = buildOrderRemark(isProtectiveLiquidation);

    if (side === 'SELL' && signal.executionOrigin === 'SWITCH_MOVE') {
      // 换仓只新增实时 available；原卖单继续归原 owner，不撤、不改、不合并，也不预扣 broker 占用。
      const isSellAvailabilityCurrent = orderMonitor.captureSellAvailabilityGuard(symbol);
      if (!isSellAvailabilityCurrent()) {
        recordOrderExecutionOutcome(
          deps.diagnostics,
          signal,
          'submitTargetOrder.switchMove',
          'BLOCKED',
          'SELL_AVAILABILITY_CHANGED',
          () => ({ mutation: 'SUBMIT' }),
        );
        return { kind: 'SELL_AVAILABILITY_CHANGED', symbol };
      }

      const quantity = await quantityResolver.readFreshAvailableSellQuantity(symbol, () =>
        authorizeOrderAction('executeSignals'),
      );
      if (!authorizeOrderAction('submitOrder.beforeApi')) return { kind: 'SKIPPED' };

      if (!isSellAvailabilityCurrent()) {
        recordOrderExecutionOutcome(
          deps.diagnostics,
          signal,
          'submitTargetOrder.switchMove',
          'BLOCKED',
          'SELL_AVAILABILITY_CHANGED',
          () => ({ mutation: 'SUBMIT' }),
        );
        return { kind: 'SELL_AVAILABILITY_CHANGED', symbol };
      }

      if (quantity === 0) {
        recordOrderExecutionOutcome(
          deps.diagnostics,
          signal,
          'submitTargetOrder.quantity',
          'SKIPPED',
          'NO_POSITIVE_EXECUTABLE_QUANTITY',
          () => ({ mutation: 'SUBMIT' }),
        );
        return { kind: 'NO_AVAILABLE_QUANTITY' };
      }

      return submitOrder({
        command,
        authorizeOrderAction,
        submittedQuantity: quantity,
        isSellAvailabilityCurrent,
        orderTypeConfig,
        remark,
        relatedBuyOrderIds: null,
      });
    }

    if (side === 'SELL') {
      const initialSellQuantity = await quantityResolver.calculateSellQuantity(symbol, signal, () =>
        authorizeOrderAction('executeSignals'),
      );
      if (!authorizeOrderAction('executeSignals')) return { kind: 'SKIPPED' };

      const submittedQuantity = initialSellQuantity.submittedQuantity;
      if (submittedQuantity === 0) {
        recordOrderExecutionOutcome(
          deps.diagnostics,
          signal,
          'submitTargetOrder.quantity',
          'SKIPPED',
          'NO_POSITIVE_EXECUTABLE_QUANTITY',
          () => ({ mutation: 'SUBMIT' }),
        );
        return { kind: 'SKIPPED' };
      }

      const pendingSellOrders = orderMonitor.getPendingSellOrders(symbol);
      const decision = resolveSellMergeDecision({
        pendingOrders: pendingSellOrders,
        newOrderQuantity: submittedQuantity,
        newOrderType: orderType,
        isProtectiveLiquidation,
      });

      if (!Number.isSafeInteger(decision.mergedQuantity) || decision.mergedQuantity < 0) {
        throw new RangeError('[订单合并] 提交或改单数量必须是非负安全整数');
      }

      const replaceTargetOrderId = decision.targetOrderId;
      if (decision.action === 'REPLACE' && replaceTargetOrderId !== null) {
        if (!canExecuteSignal(signal, 'replaceOrderPrice')) {
          return { kind: 'SKIPPED' };
        }

        const replaceResult = await rateLimiter.withTradeMutation(async (permit) => {
          if (!authorizeOrderAction('replaceOrder.beforeApi')) {
            return {
              outcome: { kind: 'NOT_EXECUTED' } as const,
              existingPendingSell: null,
              mergedRelatedBuyOrderIds: null,
            };
          }

          const finalQuotes = await marketDataClient.getQuotes([symbol]);
          const finalQuote = finalQuotes.get(symbol) ?? null;
          if (finalQuote === null || exactCompare(finalQuote.price, '0') <= 0) {
            logger.warn(`[订单合并] 最终改单行情缺失或无效，尚未改单: ${symbol}`);
            const quoteFailure = finalQuote === null ? 'QUOTE_MISSING' : 'QUOTE_INVALID';
            recordOrderExecutionOutcome(
              deps.diagnostics,
              signal,
              'replaceOrder.finalQuote',
              'SKIPPED',
              quoteFailure,
              () => ({
                mutation: 'REPLACE',
                orderId: replaceTargetOrderId,
                ...(finalQuote === null ? {} : { price: finalQuote.price }),
              }),
            );
            return {
              outcome: { kind: 'NOT_EXECUTED' } as const,
              quoteFailure,
              existingPendingSell: null,
              mergedRelatedBuyOrderIds: null,
            } as const;
          }

          const currentDecision = resolveSellMergeDecision({
            pendingOrders: orderMonitor.getPendingSellOrders(symbol),
            newOrderQuantity: submittedQuantity,
            newOrderType: orderType,
            isProtectiveLiquidation,
          });
          if (!hasSameSellMergeDecisionFacts(decision, currentDecision)) {
            logger.warn(`[订单合并] 等待改单额度期间挂单事实已变化，拒绝改单: ${symbol}`);
            recordOrderExecutionOutcome(
              deps.diagnostics,
              signal,
              'replaceOrder.beforeApi',
              'BLOCKED',
              'SELL_MERGE_DECISION_CHANGED',
              () => ({ mutation: 'REPLACE', orderId: replaceTargetOrderId }),
            );
            return {
              outcome: { kind: 'NOT_EXECUTED' } as const,
              existingPendingSell: null,
              mergedRelatedBuyOrderIds: null,
            };
          }

          const currentPendingSell = orderRecorder
            .getPendingSellSnapshot()
            .find((pendingSell) => pendingSell.orderId === replaceTargetOrderId);
          const currentMergedRelatedBuyOrderIds = mergeRelatedBuyOrderIds(
            currentPendingSell?.relatedBuyOrderIds,
            signal.relatedBuyOrderIds,
          );
          const currentRelatedBuyOrderValidation =
            currentMergedRelatedBuyOrderIds === null
              ? null
              : {
                  orderRecorder,
                  symbol,
                  isLongSymbol: command.direction === 'LONG',
                  submittedQuantity: decision.mergedQuantity,
                  relatedBuyOrderIds: currentMergedRelatedBuyOrderIds,
                };
          if (
            currentRelatedBuyOrderValidation !== null &&
            !hasExactRelatedBuyOrderQuantity(currentRelatedBuyOrderValidation)
          ) {
            logger.warn(`[订单合并] 关联买单无法整单表示 REPLACE 数量，拒绝改单: ${symbol}`);
            recordOrderExecutionOutcome(
              deps.diagnostics,
              signal,
              'replaceOrder.relatedBuyOrders',
              'BLOCKED',
              'RELATED_BUY_QUANTITY_MISMATCH',
              () => ({
                mutation: 'REPLACE',
                orderId: replaceTargetOrderId,
                quantity: decision.mergedQuantity.toString(),
              }),
            );
            return {
              outcome: { kind: 'NOT_EXECUTED' } as const,
              existingPendingSell: null,
              mergedRelatedBuyOrderIds: null,
            };
          }

          const replaceAuthorization = createRelatedBuyOrderReplaceAuthorization(
            (stage) =>
              authorizeOrderAction(stage) &&
              hasSameSellMergeDecisionFacts(
                decision,
                resolveSellMergeDecision({
                  pendingOrders: orderMonitor.getPendingSellOrders(symbol),
                  newOrderQuantity: submittedQuantity,
                  newOrderType: orderType,
                  isProtectiveLiquidation,
                }),
              ),
            currentRelatedBuyOrderValidation,
          );
          if (!replaceAuthorization('replaceOrder.beforeApi')) {
            return {
              outcome: { kind: 'NOT_EXECUTED' } as const,
              existingPendingSell: null,
              mergedRelatedBuyOrderIds: null,
            };
          }

          return {
            outcome: await orderMonitor.replaceOrderPriceWithPermit(
              replaceTargetOrderId,
              finalQuote.price,
              {
                kind: 'SIGNAL_AUTHORIZED',
                authorize: replaceAuthorization,
              },
              permit,
              decision.mergedQuantity,
            ),
            existingPendingSell: currentPendingSell,
            mergedRelatedBuyOrderIds: currentMergedRelatedBuyOrderIds,
          };
        });
        if ('quoteFailure' in replaceResult) {
          return { kind: replaceResult.quoteFailure, symbol };
        }

        // 最外 FIFO callback 已完整退出并释放额度，失败确认才可排 query/throttle。
        const replaceOutcome =
          replaceResult.outcome.kind === 'POST_FAILURE_CONFIRMATION_REQUIRED'
            ? await replaceResult.outcome.confirmAfterPermitReleased()
            : replaceResult.outcome;
        if (replaceOutcome.kind === 'POST_FAILURE_CONFIRMATION_REQUIRED') {
          throw new TypeError('改单失败确认不得再次要求持 permit 确认');
        }

        if (replaceOutcome.kind !== 'BROKER_CONFIRMED') {
          recordOrderExecutionOutcome(
            deps.diagnostics,
            signal,
            'replaceOrder.result',
            'SKIPPED',
            'REPLACE_NOT_CONFIRMED',
            () => ({ mutation: 'REPLACE', orderId: replaceTargetOrderId }),
          );
          return { kind: 'SKIPPED' };
        }

        // tracking 仅确认旧单修改；该结果不提供新单、成交或 adapter request 元数据。
        recordOrderExecutionOutcome(
          deps.diagnostics,
          signal,
          'replaceOrder.result',
          'REPLACED',
          'REPLACE_BROKER_CONFIRMED',
          () => ({
            mutation: 'REPLACE',
            orderId: replaceTargetOrderId,
            quantity: decision.mergedQuantity.toString(),
          }),
        );

        if (replaceResult.existingPendingSell) {
          orderRecorder.updatePendingSell(replaceTargetOrderId, {
            submittedQuantity: decision.mergedQuantity,
            relatedBuyOrderIds: replaceResult.mergedRelatedBuyOrderIds ?? [],
          });
        }

        return { kind: 'REPLACED', orderId: replaceTargetOrderId };
      }

      let cancelOutcomes: ReadonlyArray<CancelOrderOutcome> = [];
      let finalSubmitQuantity = decision.mergedQuantity;
      if (decision.action === 'CANCEL_AND_SUBMIT') {
        if (!canExecuteSignal(signal, 'cancelAndSubmit')) {
          return { kind: 'SKIPPED' };
        }

        cancelOutcomes = await settleCancelFanout(
          decision.pendingOrderIds.map(async (orderId) =>
            orderMonitor.cancelOrder(orderId, {
              kind: 'SIGNAL_AUTHORIZED',
              authorize: authorizeOrderAction,
            }),
          ),
        );

        if (!authorizeOrderAction('cancelOrder.beforeApi')) return { kind: 'SKIPPED' };

        if (cancelOutcomes.some(isFilledCancelOutcome)) {
          logger.warn(`[订单合并] 检测到已成交卖单，禁止重复提交: ${symbol}`);
          recordOrderExecutionOutcome(
            deps.diagnostics,
            signal,
            'cancelAndSubmit.result',
            'BLOCKED',
            'PENDING_SELL_FILLED',
            () => ({ mutation: 'SUBMIT' }),
          );
          return { kind: 'SKIPPED' };
        }

        const unconfirmedOutcome = cancelOutcomes.find(
          (outcome) => !isTerminalNonFilledCloseConfirmed(outcome),
        );
        if (unconfirmedOutcome) {
          logger.warn(
            `[订单合并] 撤单未确认非成交终态，跳过合并提交: ${symbol}, outcome=${formatCancelOutcomeTag(unconfirmedOutcome)}`,
          );

          recordOrderExecutionOutcome(
            deps.diagnostics,
            signal,
            'cancelAndSubmit.result',
            'BLOCKED',
            'CANCEL_TERMINAL_UNCONFIRMED',
            () => ({ mutation: 'SUBMIT', cancelOutcome: unconfirmedOutcome.kind }),
          );
          return { kind: 'SKIPPED' };
        }

        const freshSellQuantity = await quantityResolver.calculateSellQuantity(symbol, signal, () =>
          authorizeOrderAction('executeSignals'),
        );
        if (!authorizeOrderAction('submitOrder.beforeApi')) return { kind: 'SKIPPED' };

        const freshSignalQuantity = freshSellQuantity.submittedQuantity;
        const replannedQuantity = resolveReplannedSellQuantity(
          cancelOutcomes,
          freshSellQuantity.availableQuantity,
          freshSignalQuantity,
        );
        if (replannedQuantity === null) {
          logger.warn(`[订单合并] 撤单终态数量或撤单后可卖量不可信，拒绝提交: ${symbol}`);
          recordOrderExecutionOutcome(
            deps.diagnostics,
            signal,
            'cancelAndSubmit.quantity',
            'BLOCKED',
            'SELL_REPLAN_UNTRUSTED',
            () => ({ mutation: 'SUBMIT' }),
          );
          return { kind: 'SKIPPED' };
        }

        finalSubmitQuantity = replannedQuantity;
      }

      if (decision.action === 'SKIP') {
        logger.info(`[订单合并] 无需新增卖单: ${symbol}, reason=${decision.reason}`);
        recordOrderExecutionOutcome(
          deps.diagnostics,
          signal,
          'submitTargetOrder.sellMerge',
          'SKIPPED',
          'SELL_MERGE_SKIPPED',
          () => ({ mutation: 'SUBMIT', mergeReason: decision.reason }),
        );
        return { kind: 'SKIPPED' };
      }

      if (decision.action === 'SUBMIT' || decision.action === 'CANCEL_AND_SUBMIT') {
        const mergedRelatedBuyOrderIds =
          decision.action === 'CANCEL_AND_SUBMIT'
            ? mergeRelatedBuyOrderIds(
                signal.relatedBuyOrderIds,
                cancelOutcomes.flatMap(getOutcomeRelatedBuyOrderIds),
              )
            : (signal.relatedBuyOrderIds ?? null);
        return submitOrder({
          command,
          authorizeOrderAction,
          submittedQuantity: finalSubmitQuantity,
          orderTypeConfig,
          remark,
          relatedBuyOrderIds: mergedRelatedBuyOrderIds,
        });
      }

      return { kind: 'SKIPPED' };
    }

    return submitOrder({
      command,
      authorizeOrderAction,
      submittedQuantity: null,
      orderTypeConfig,
      remark,
    });
  };
}
