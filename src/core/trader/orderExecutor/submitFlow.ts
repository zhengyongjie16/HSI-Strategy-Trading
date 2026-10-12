/**
 * orderExecutor 提交流程模块
 *
 * 职责：
 * - 计算买卖数量并完成卖单合并与前置撤单决策
 * - 构造订单载荷并提交到 Trade API
 * - 在提交成功后注册 orderMonitor 追踪与卖单防重占用
 */
import { logger } from '../../../utils/logger/index.js';
import {
  isProgramError,
  isExternalApiRequestError,
  isUnconfirmedOrderSubmissionError,
} from '../../../utils/apiFailure/index.js';
import { isRecord } from '../../../utils/helpers/index.js';
import {
  compareRatios,
  exactAdd,
  exactCompare,
  safeQuantityNumber,
} from '../../../utils/numeric/exact.js';
import { formatSymbolDisplay } from '../../../utils/display/index.js';
import type { TradeSubmitCommand } from '../../../types/tradeMutationPorts.js';
import type { Signal, OrderTypeConfig } from '../../../types/signal.js';
import type { CancelOrderOutcome } from '../../../types/trader.js';
import type { OrderActionAuthorization, SellMergeDecision } from '../types.js';
import { buildOrderRemark, resolveOrderTypeConfig, resolveSellMergeDecision } from '../utils.js';
import {
  formatCancelOutcomeTag,
  isTerminalNonFilledCloseConfirmed,
} from '../../../utils/trading/orderStatus.js';
import type {
  AcceptedOrderLocalSyncError,
  BrokerSubmissionStage,
  DoomsdayClearanceOrderCommand,
  OrderActionResult,
  RelatedBuyOrderQuantityValidationParams,
  SubmitFailureClassification,
  SubmitOrderParams,
  SubmitTargetOrder,
  SubmitTargetOrderDeps,
} from './types.js';
import {
  getActionDescription,
  getOrderTypeFromConfig,
  handleSubmitError,
  isLiquidationSignal,
} from './utils.js';
import { createQuantityResolver } from './quantityResolver.js';

/**
 * 判断错误是否携带券商明确返回的业务拒绝码。
 *
 * 只读取 SDK/包装器的结构化字段及其 cause/error 链，不把自由文本当作
 * 可安全跳过订单的事实；六位码与 apiFailure 边界的业务错误码口径一致。
 *
 * @param error 待分类错误
 * @param depth 当前 cause/error 链深度
 * @returns 存在明确的六位业务拒绝码时返回 true
 */
function hasStructuredBrokerBusinessRejectionCode(error: unknown, depth: number = 0): boolean {
  if (depth > 2 || !isRecord(error)) {
    return false;
  }

  for (const key of ['code', 'errorCode', 'errno'] as const) {
    const value = error[key];
    if (typeof value === 'string' && /^\d{6}$/.test(value.trim())) {
      return true;
    }

    if (
      typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= 100_000 &&
      value <= 999_999
    ) {
      return true;
    }
  }

  for (const key of ['cause', 'error'] as const) {
    if (hasStructuredBrokerBusinessRejectionCode(error[key], depth + 1)) {
      return true;
    }
  }

  return false;
}

/**
 * 将 broker 已接受后的本地同步异常包装为带订单身份的结构化错误。
 *
 * @param orderId 已由 broker 返回并校验通过的订单 ID
 * @param cause 缓存、追踪或订单记录器的原始失败
 * @returns 可供运行期错误通道识别的本地同步失败
 */
function createAcceptedOrderLocalSyncError(
  orderId: string,
  cause: unknown,
): AcceptedOrderLocalSyncError {
  return Object.assign(
    new Error(`[订单提交] broker 已接受订单但本地同步失败: ${orderId}`, { cause }),
    {
      name: 'AcceptedOrderLocalSyncError' as const,
      orderId,
    },
  );
}

/**
 * 按真实下单阶段分类错误，只有已尝试 SDK submit 且携带结构化业务码的
 * 拒绝可以降级为跳过；其余场景都必须交给上层错误通道处理。
 *
 * @param error 当前失败
 * @param stage broker 下单阶段
 * @returns 不可混淆的错误阶段分类
 */
function classifySubmitFailure(
  error: unknown,
  stage: BrokerSubmissionStage,
): SubmitFailureClassification {
  if (isProgramError(error)) {
    return { kind: 'PRE_SUBMIT_FAILURE' };
  }

  if (stage.kind === 'BROKER_ACCEPTED') {
    return { kind: 'POST_ACCEPTANCE_LOCAL_SYNC_FAILURE' };
  }

  if (stage.kind !== 'BROKER_SUBMISSION_ATTEMPTED') {
    return { kind: 'PRE_SUBMIT_FAILURE' };
  }

  if (hasStructuredBrokerBusinessRejectionCode(error)) {
    return { kind: 'EXPLICIT_BROKER_REJECTION', orderPayload: stage.orderPayload };
  }

  if (isUnconfirmedOrderSubmissionError(error)) {
    return { kind: 'UNCONFIRMED_EXTERNAL_SUBMISSION' };
  }

  return { kind: 'UNCONFIRMED_SUBMISSION' };
}

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
 * 显式传入 null 表示受控路径（如末日清仓）要求彻底取消智能平仓关联，
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
  const quantityResolver = createQuantityResolver({ rateLimiter, readSellPositions });
  const doomsdayAwaitingTerminalOrderIdsBySymbol = new Map<string, ReadonlySet<string>>();

  /**
   * 根据全局配置与信号属性解析最终订单类型。
   *
   * @param signal 交易信号
   * @returns Longbridge 订单类型
   */
  function resolveOrderType(signal: Signal): OrderTypeConfig {
    return resolveOrderTypeConfig(signal, globalConfig);
  }

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
    } = params;
    const { signal, side } = command;
    const orderTypeParam = getOrderTypeFromConfig(orderTypeConfig);
    const symbol = signal.symbol;
    const sellRelatedBuyOrderIds = resolveSellRelatedBuyOrderIds(side, signal, relatedBuyOrderIds);

    if (!canExecuteSignal(signal, 'submitOrder')) {
      return { kind: 'SKIPPED' };
    }

    const symbolDisplayForLog = formatSymbolDisplay(symbol, signal.symbolName ?? null);
    let brokerSubmissionStage: BrokerSubmissionStage = { kind: 'PRE_SUBMIT' };
    const finalAuthorizationAborted = new Error('原 caller 最终提交授权失效');

    try {
      return await rateLimiter.withTradeMutation(async (permit) => {
        if (!authorizeOrderAction('submitOrder.beforeApi')) return { kind: 'SKIPPED' };

        const finalQuotes = await marketDataClient.getQuotes([symbol]);
        const finalQuote = finalQuotes.get(symbol) ?? null;
        if (!finalQuote || exactCompare(finalQuote.price, '0') <= 0) {
          logger.warn(`[订单提交] 最终执行行情缺失或无效，跳过: ${symbolDisplayForLog}`);
          if (command.executionPurpose === 'DOOMSDAY_CLEARANCE') {
            return { kind: 'QUOTE_UNAVAILABLE', symbol };
          }

          return { kind: 'SKIPPED' };
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
            return { kind: 'SKIPPED' };
          }
        }

        let finalSubmittedQuantity = submittedQuantity;
        if (side === 'BUY') {
          if (!canTradeNow(signal.action).canTrade) {
            logger.debug(`[订单提交] 最终买入频率检查未通过，跳过: ${symbol}`);
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

        const onRemoteIssued = (): void => {
          if (!authorizeOrderAction('submitOrder.beforeApi')) throw finalAuthorizationAborted;

          // adapter 已完成序列化/容量证明，才登记真实提交尝试；PRE_SUBMIT 拒绝不占买入频率。
          if (command.kind === 'BUY') recordBuyAttempt(signal.action);

          brokerSubmissionStage = { kind: 'BROKER_SUBMISSION_ATTEMPTED', orderPayload };
        };
        const response = await permit.invoke(async () => {
          if (!authorizeOrderAction('submitOrder.beforeApi')) return null;

          return tradeMutationPort.submitOrder(orderPayload, onRemoteIssued);
        });
        if (response === null) return { kind: 'SKIPPED' };

        const { orderId } = response;
        if (typeof orderId !== 'string' || orderId.length === 0)
          throw new TypeError('broker 返回无效 orderId');

        brokerSubmissionStage = {
          kind: 'BROKER_ACCEPTED',
          orderId,
          orderPayload,
        };

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
              isProtectiveLiquidation,
              submittedAtMs,
            );
          }
        } catch (error) {
          throw createAcceptedOrderLocalSyncError(orderId, error);
        }

        const actionDesc = getActionDescription(signal.action);
        logger.info(
          `[订单提交成功] ${actionDesc} ${orderPayload.symbol} 数量=${orderPayload.submittedQuantity} 订单ID=${orderId}`,
        );
        return { kind: 'SUBMITTED', orderId };
      });
    } catch (err) {
      // 只接收本轮私有取消身份；任何内部/SDK 错误即使原授权过期仍原样暴露。
      if (err === finalAuthorizationAborted) return { kind: 'SKIPPED' };

      const failure = classifySubmitFailure(err, brokerSubmissionStage);
      if (failure.kind === 'EXPLICIT_BROKER_REJECTION') {
        handleSubmitError(err, signal, failure.orderPayload);
        return { kind: 'SKIPPED' };
      }

      throw err;
    }
  }

  /**
   * 执行末日清仓卖出。
   * 末日清仓不能复用普通卖单的合并/改单语义：先清理当前标的全部待成交卖单，
   * 仅在每条链路均返回权威终态后重新读取可用仓位，并以新鲜可卖量提交一张普通卖单。
   * 已成交或部分成交的旧单不参与数量合并，是否仍需提交完全由新鲜持仓事实决定。
   *
   * @param command 受控末日清仓卖出命令
   * @param authorizeOrderAction 每次订单副作用前重新校验的授权器
   * @returns 新提交订单或明确跳过结果
   */
  async function submitDoomsdayClearanceSell(
    command: DoomsdayClearanceOrderCommand,
    authorizeOrderAction: OrderActionAuthorization,
  ): Promise<OrderActionResult> {
    const { signal } = command;
    const symbol = signal.symbol;
    const pendingOrderIds = orderMonitor
      .getPendingSellOrders(symbol)
      .map((pendingOrder) => pendingOrder.orderId);

    const awaitingTerminalOrderIds = doomsdayAwaitingTerminalOrderIdsBySymbol.get(symbol);
    if (awaitingTerminalOrderIds !== undefined) {
      const stillAwaitingAuthoritativeTerminal = pendingOrderIds.some((orderId) =>
        awaitingTerminalOrderIds.has(orderId),
      );
      if (stillAwaitingAuthoritativeTerminal) {
        return { kind: 'WAITING_FOR_AUTHORITATIVE_TERMINAL', symbol };
      }

      doomsdayAwaitingTerminalOrderIdsBySymbol.delete(symbol);
    }

    if (pendingOrderIds.length > 0) {
      if (!canExecuteSignal(signal, 'doomsdayClearance.cancelPendingSells')) {
        return { kind: 'SKIPPED' };
      }

      const cancelOutcomes = await settleCancelFanout(
        pendingOrderIds.map(async (orderId) =>
          orderMonitor.cancelOrder(orderId, {
            kind: 'SIGNAL_AUTHORIZED',
            authorize: authorizeOrderAction,
          }),
        ),
      );
      if (!authorizeOrderAction('cancelOrder.beforeApi')) return { kind: 'SKIPPED' };

      const nonTerminalOutcome = cancelOutcomes.find(
        (outcome) => outcome.kind !== 'ALREADY_CLOSED',
      );

      const awaitingTerminalOrderIdsAfterCancel = pendingOrderIds.filter(
        (_orderId, index) => cancelOutcomes[index]?.kind === 'CANCEL_CONFIRMED',
      );
      if (awaitingTerminalOrderIdsAfterCancel.length > 0) {
        doomsdayAwaitingTerminalOrderIdsBySymbol.set(
          symbol,
          new Set(awaitingTerminalOrderIdsAfterCancel),
        );

        logger.warn(
          `[末日清仓] 撤单请求已接受，等待权威终态后重读仓位: ${symbol}, orderIds=${awaitingTerminalOrderIdsAfterCancel.join(',')}`,
        );
        return { kind: 'WAITING_FOR_AUTHORITATIVE_TERMINAL', symbol };
      }

      if (nonTerminalOutcome) {
        logger.warn(
          `[末日清仓] 待成交卖单尚未取得权威终态，保留后续重评估: ${symbol}, outcome=${formatCancelOutcomeTag(nonTerminalOutcome)}`,
        );
        return { kind: 'SKIPPED' };
      }
    }

    const freshSubmittedQuantity = await quantityResolver.resolveDoomsdayClearanceQuantity(
      symbol,
      () => authorizeOrderAction('executeSignals'),
    );
    if (!authorizeOrderAction('submitOrder.beforeApi')) return { kind: 'SKIPPED' };

    if (freshSubmittedQuantity === 0) {
      return { kind: 'SKIPPED' };
    }

    return submitOrder({
      command,
      authorizeOrderAction,
      submittedQuantity: freshSubmittedQuantity,
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

    if (!authorizeOrderAction('executeSignals') || !canExecuteSignal(signal, 'submitTargetOrder')) {
      return { kind: 'SKIPPED' };
    }

    if (command.executionPurpose === 'DOOMSDAY_CLEARANCE') {
      return submitDoomsdayClearanceSell(command, authorizeOrderAction);
    }

    const orderTypeConfig = resolveOrderType(signal);
    const orderType = getOrderTypeFromConfig(orderTypeConfig);
    const isProtectiveLiquidation = isLiquidationSignal(signal);
    const remark = buildOrderRemark(isProtectiveLiquidation);

    if (side === 'SELL') {
      const initialSellQuantity = await quantityResolver.calculateSellQuantity(symbol, signal, () =>
        authorizeOrderAction('executeSignals'),
      );
      if (!authorizeOrderAction('executeSignals')) return { kind: 'SKIPPED' };

      const submittedQuantity = initialSellQuantity.submittedQuantity;
      if (submittedQuantity === 0) {
        return { kind: 'SKIPPED' };
      }

      const pendingSellOrders = orderMonitor.getPendingSellOrders(symbol);
      const decision = resolveSellMergeDecision({
        symbol,
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
          if (!finalQuote || exactCompare(finalQuote.price, '0') <= 0) {
            logger.warn(`[订单合并] 最终改单行情缺失或无效，跳过: ${symbol}`);
            return {
              outcome: { kind: 'NOT_EXECUTED' } as const,
              existingPendingSell: null,
              mergedRelatedBuyOrderIds: null,
            };
          }

          const currentDecision = resolveSellMergeDecision({
            symbol,
            pendingOrders: orderMonitor.getPendingSellOrders(symbol),
            newOrderQuantity: submittedQuantity,
            newOrderType: orderType,
            isProtectiveLiquidation,
          });
          if (!hasSameSellMergeDecisionFacts(decision, currentDecision)) {
            logger.warn(`[订单合并] 等待改单额度期间挂单事实已变化，拒绝改单: ${symbol}`);
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
            return {
              outcome: { kind: 'NOT_EXECUTED' } as const,
              existingPendingSell: null,
              mergedRelatedBuyOrderIds: null,
            };
          }

          const replaceAuthorization = createRelatedBuyOrderReplaceAuthorization(
            authorizeOrderAction,
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
        // 最外 FIFO callback 已完整退出并释放额度，失败确认才可排 query/throttle。
        const replaceOutcome =
          replaceResult.outcome.kind === 'POST_FAILURE_CONFIRMATION_REQUIRED'
            ? await replaceResult.outcome.confirmAfterPermitReleased()
            : replaceResult.outcome;
        if (replaceOutcome.kind === 'POST_FAILURE_CONFIRMATION_REQUIRED') {
          throw new TypeError('改单失败确认不得再次要求持 permit 确认');
        }

        if (replaceOutcome.kind !== 'BROKER_CONFIRMED') {
          return { kind: 'SKIPPED' };
        }

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
          return { kind: 'SKIPPED' };
        }

        const unconfirmedOutcome = cancelOutcomes.find(
          (outcome) => !isTerminalNonFilledCloseConfirmed(outcome),
        );
        if (unconfirmedOutcome) {
          logger.warn(
            `[订单合并] 撤单未确认非成交终态，跳过合并提交: ${symbol}, outcome=${formatCancelOutcomeTag(unconfirmedOutcome)}`,
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
          return { kind: 'SKIPPED' };
        }

        finalSubmitQuantity = replannedQuantity;
      }

      if (decision.action === 'SKIP') {
        logger.info(`[订单合并] 无需新增卖单: ${symbol}, reason=${decision.reason}`);
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
