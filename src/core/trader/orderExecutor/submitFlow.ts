/**
 * orderExecutor 提交流程模块
 *
 * 职责：
 * - 计算买卖数量并完成卖单合并与前置撤单决策
 * - 构造订单载荷并提交到 Trade API
 * - 在提交成功后注册 orderMonitor 追踪与卖单防重占用
 */
import { OrderSide, OrderType, TimeInForceType } from 'longbridge';
import { logger } from '../../../utils/logger/index.js';
import {
  isExternalApiRequestError,
  wrapExternalApiRequest,
} from '../../../utils/apiFailure/index.js';
import { decimalToNumber, isValidPositiveNumber } from '../../../utils/helpers/index.js';
import { formatSymbolDisplay } from '../../../utils/display/index.js';
import type { Signal } from '../../../types/signal.js';
import type { CancelOrderOutcome } from '../../../types/trader.js';
import type { OrderPayload } from '../types.js';
import {
  buildOrderRemark,
  extractOrderId,
  formatOrderTypeLabel,
  getOrderTypeCode,
  resolveOrderTypeConfig,
  resolveSellMergeDecision,
  toDecimal,
} from '../utils.js';
import {
  formatCancelOutcomeTag,
  isTerminalNonFilledCloseConfirmed,
} from '../../../utils/trading/orderStatus.js';
import type {
  OrderActionResult,
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

function getOutcomeRelatedBuyOrderIds(outcome: CancelOrderOutcome): ReadonlyArray<string> {
  if (outcome.kind === 'CANCEL_CONFIRMED' || outcome.kind === 'ALREADY_CLOSED') {
    return outcome.relatedBuyOrderIds ?? [];
  }

  return [];
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
    ctx,
    monitorConfig,
    canExecuteSignal,
    recordBuyAttempt,
  } = deps;
  const quantityResolver = createQuantityResolver({ rateLimiter });

  /**
   * 根据全局配置与信号属性解析最终订单类型。
   *
   * @param signal 交易信号
   * @returns Longbridge 订单类型
   */
  function resolveOrderType(signal: Signal): OrderType {
    const orderTypeConfig = resolveOrderTypeConfig(signal, globalConfig);
    return getOrderTypeFromConfig(orderTypeConfig);
  }

  /**
   * 提交订单并在成功后登记运行态追踪。
   *
   * @param params 提交参数
   * @returns 订单 ID，失败返回 null
   * @throws 当远端下单成功但本地追踪登记失败时抛错，避免静默丢失订单状态
   */
  async function submitOrder(params: SubmitOrderParams): Promise<OrderActionResult> {
    const {
      command,
      authorizeOrderAction,
      submittedQtyDecimal,
      orderTypeParam,
      timeInForce,
      remark,
      overridePrice,
      relatedBuyOrderIds = null,
    } = params;
    const { signal, side } = command;
    const symbol = signal.symbol;

    if (!canExecuteSignal(signal, 'submitOrder')) {
      return { kind: 'SKIPPED' };
    }

    const resolvedPrice = overridePrice ?? signal.price ?? null;
    const symbolDisplayForLog = formatSymbolDisplay(symbol, signal.symbolName ?? null);

    if (orderTypeParam === OrderType.MO) {
      logger.debug(`[订单类型] 使用市价单(MO)，标的=${symbolDisplayForLog}`);
    } else if (orderTypeParam === OrderType.LO || orderTypeParam === OrderType.ELO) {
      const orderTypeLabel = formatOrderTypeLabel(orderTypeParam);
      if (!resolvedPrice) {
        logger.warn(
          `[跳过订单] ${symbolDisplayForLog} 的${orderTypeLabel}缺少价格，无法提交。请确保信号中包含价格信息`,
        );
        return { kind: 'SKIPPED' };
      }

      const orderTypeCode = getOrderTypeCode(orderTypeParam);
      logger.debug(
        `[订单类型] 使用${orderTypeLabel}(${orderTypeCode})，标的=${symbolDisplayForLog}，价格=${resolvedPrice}`,
      );
    }

    const orderPayload: OrderPayload = {
      symbol,
      orderType: orderTypeParam,
      side,
      timeInForce,
      submittedQuantity: submittedQtyDecimal,
      ...(resolvedPrice &&
        orderTypeParam !== OrderType.MO && { submittedPrice: toDecimal(resolvedPrice) }),
      ...(remark && { remark: remark.slice(0, 60) }),
    };

    try {
      await rateLimiter.throttle();
      if (!authorizeOrderAction('submitOrder.beforeApi')) {
        return { kind: 'SKIPPED' };
      }

      recordBuyAttempt(signal.action);
      const resp = await wrapExternalApiRequest({
        operation: 'TradeContext.submitOrder',
        request: () => ctx.submitOrder(orderPayload),
        retryConfig: {
          retries: 0,
          delayMs: 0,
        },
      });
      cacheManager.clearCache();
      const orderId = extractOrderId(resp);
      const actionDesc = getActionDescription(signal.action);
      logger.info(
        `[订单提交成功] ${actionDesc} ${orderPayload.symbol} 数量=${orderPayload.submittedQuantity.toString()} 订单ID=${orderId}`,
      );

      const submittedQuantityNum = decimalToNumber(orderPayload.submittedQuantity);
      const isLongSymbol = command.direction === 'LONG';
      const isProtectiveLiquidation = isLiquidationSignal(signal);
      try {
        orderMonitor.trackOrder({
          orderId,
          symbol,
          side,
          price: resolvedPrice ?? 0,
          initialSubmittedPrice: resolvedPrice ?? 0,
          quantity: submittedQuantityNum,
          isLongSymbol,
          monitorSymbol: monitorConfig.monitorSymbol,
          isProtectiveLiquidation,
          orderType: orderTypeParam,
        });

        const sellRelatedBuyOrderIds = relatedBuyOrderIds ?? signal.relatedBuyOrderIds ?? null;
        if (side === OrderSide.Sell && sellRelatedBuyOrderIds) {
          const direction: 'LONG' | 'SHORT' = isLongSymbol ? 'LONG' : 'SHORT';
          orderRecorder.submitSellOrder(
            orderId,
            symbol,
            direction,
            submittedQuantityNum,
            sellRelatedBuyOrderIds,
          );
        }
      } catch (error) {
        throw new Error(`order submitted but local sync failed: ${orderId}`, {
          cause: error,
        });
      }

      return { kind: 'SUBMITTED', orderId };
    } catch (err) {
      handleSubmitError(err, signal, orderPayload);
      const message = err instanceof Error ? err.message : '';
      if (
        isExternalApiRequestError(err) ||
        message.includes('orderId') ||
        message.startsWith('order submitted but local sync failed:')
      ) {
        throw err;
      }

      return { kind: 'SKIPPED' };
    }
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

    if (!canExecuteSignal(signal, 'submitTargetOrder')) {
      return { kind: 'SKIPPED' };
    }

    const targetNotional = monitorConfig.targetNotional;
    const orderType = resolveOrderType(signal);
    const timeInForce = TimeInForceType.Day;
    const isProtectiveLiquidation = isLiquidationSignal(signal);
    const remark = buildOrderRemark(isProtectiveLiquidation);

    if (side === OrderSide.Sell) {
      const submittedQtyDecimal = await quantityResolver.calculateSellQuantity(ctx, symbol, signal);
      if (submittedQtyDecimal.isZero()) {
        return { kind: 'SKIPPED' };
      }

      const submittedQtyNumber = decimalToNumber(submittedQtyDecimal);
      if (!isValidPositiveNumber(submittedQtyNumber)) {
        logger.warn(
          `[跳过订单] 卖出数量无效，无法合并卖单: ${submittedQtyDecimal.toString()}, symbol=${symbol}`,
        );
        return { kind: 'SKIPPED' };
      }

      const resolvedPrice = isValidPositiveNumber(signal.price) ? signal.price : null;
      const pendingSellOrders = orderMonitor.getPendingSellOrders(symbol);
      const decision = resolveSellMergeDecision({
        symbol,
        pendingOrders: pendingSellOrders,
        newOrderQuantity: submittedQtyNumber,
        newOrderPrice: resolvedPrice,
        newOrderType: orderType,
        isProtectiveLiquidation,
      });

      if (decision.action === 'REPLACE' && decision.targetOrderId) {
        if (!canExecuteSignal(signal, 'replaceOrderPrice')) {
          return { kind: 'SKIPPED' };
        }

        const price = decision.price ?? resolvedPrice ?? 0;
        if (!isValidPositiveNumber(price)) {
          logger.warn(`[订单合并] 无法获取有效改单价格，跳过: ${symbol}`);
          return { kind: 'SKIPPED' };
        }

        const replaceOutcome = await orderMonitor.replaceOrderPrice(
          decision.targetOrderId,
          price,
          { kind: 'SIGNAL_AUTHORIZED', authorize: authorizeOrderAction },
          decision.mergedQuantity,
        );
        if (replaceOutcome.kind !== 'BROKER_CONFIRMED') {
          return { kind: 'SKIPPED' };
        }

        const existingPendingSell = orderRecorder
          .getPendingSellSnapshot()
          .find((pendingSell) => pendingSell.orderId === decision.targetOrderId);
        const mergedRelatedBuyOrderIds = mergeRelatedBuyOrderIds(
          existingPendingSell?.relatedBuyOrderIds,
          signal.relatedBuyOrderIds,
        );
        if (existingPendingSell) {
          orderRecorder.updatePendingSell(decision.targetOrderId, {
            submittedQuantity: decision.mergedQuantity,
            relatedBuyOrderIds: mergedRelatedBuyOrderIds ?? [],
          });
        }

        return { kind: 'REPLACED', orderId: decision.targetOrderId };
      }

      let cancelOutcomes: ReadonlyArray<CancelOrderOutcome> = [];
      if (decision.action === 'CANCEL_AND_SUBMIT') {
        if (!canExecuteSignal(signal, 'cancelAndSubmit')) {
          return { kind: 'SKIPPED' };
        }

        cancelOutcomes = await Promise.all(
          decision.pendingOrderIds.map((orderId) =>
            orderMonitor.cancelOrder(orderId, {
              kind: 'SIGNAL_AUTHORIZED',
              authorize: authorizeOrderAction,
            }),
          ),
        );

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
      }

      if (decision.action === 'SKIP') {
        logger.info(`[订单合并] 无需新增卖单: ${symbol}, reason=${decision.reason}`);
        return { kind: 'SKIPPED' };
      }

      if (decision.action === 'SUBMIT' || decision.action === 'CANCEL_AND_SUBMIT') {
        const mergedQtyDecimal = toDecimal(decision.mergedQuantity);
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
          submittedQtyDecimal: mergedQtyDecimal,
          orderTypeParam: orderType,
          timeInForce,
          remark,
          overridePrice: decision.price ?? undefined,
          relatedBuyOrderIds: mergedRelatedBuyOrderIds,
        });
      }

      return { kind: 'SKIPPED' };
    }

    const submittedQtyDecimal = quantityResolver.resolveBuyQuantity(
      signal,
      command.direction === 'SHORT',
      targetNotional,
    );

    if (submittedQtyDecimal.isZero()) {
      return { kind: 'SKIPPED' };
    }

    return submitOrder({
      command,
      authorizeOrderAction,
      submittedQtyDecimal,
      orderTypeParam: orderType,
      timeInForce,
      remark,
      overridePrice: undefined,
    });
  };
}
