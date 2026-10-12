/**
 * orderMonitor 单订单状态查询模块
 *
 * 职责：
 * - 在撤单/改单 API 业务失败后调用 orderDetail 做权威确认
 * - 将 Longbridge 原始订单状态映射为统一 OrderStateCheckResult
 * - 区分终态、仍开放状态与查询失败原因
 */
import { withTrustedOrderExecutionTimes } from '../../../domain/order/executionFact.js';
import {
  isExternalApiRequestError,
  wrapExternalApiRequest,
} from '../../../utils/apiFailure/index.js';
import type { OrderStateCheckResult } from '../../../types/trader.js';
import type { OrderStatusQuery, OrderStatusQueryDeps } from './types.js';
import {
  extractErrorCode,
  isRetryableOrderApiError,
  resolveOrderClosedReasonFromStatus,
} from './utils.js';

/**
 * 单订单权威状态查询：仅用于撤单/改单 API 业务失败后的确认。
 */
export function createOrderStatusQuery(deps: OrderStatusQueryDeps): OrderStatusQuery {
  const { orderDetailReadPort, rateLimiter, executionLedgerPort } = deps;

  /**
   * 在撤单或改单业务失败后限流查询单订单权威状态，供调用方决定结算、继续等待或恢复跟踪。
   *
   * 将已成交、已撤销、已拒绝等终态归一为 TERMINAL，其余状态归一为 OPEN；
   * broker 明确返回 603001 时返回 QUERY_FAILED，避免把“订单不存在”误判为终态。
   *
   * @param orderId 待确认的 broker 订单标识
   * @returns 归一化后的权威订单状态
   * @throws 外部请求失败或非 603001 的未知 SDK 错误时原样抛出
   */
  async function checkOrderState(
    orderId: string,
    isWorkCurrent: () => boolean,
  ): Promise<OrderStateCheckResult> {
    const cancelled = new Error('[订单状态查询] origin work cancelled');
    const requireOriginWork = (): void => {
      if (!isWorkCurrent()) throw cancelled;
    };

    try {
      requireOriginWork();
      await rateLimiter.throttle();
      requireOriginWork();
      const detail = await wrapExternalApiRequest({
        operation: 'TradeContext.orderDetail',
        request: () => {
          requireOriginWork();
          return orderDetailReadPort.read(orderId);
        },
        shouldRetry: isRetryableOrderApiError,
      });
      // 先验证已经返回的事实，再判断取消；过期不能吞内部DTO/金融错误。
      detail.decode([]);
      requireOriginWork();
      await rateLimiter.throttle();
      requireOriginWork();
      const executions = await wrapExternalApiRequest({
        operation: 'TradeContext.todayExecutions',
        request: () => {
          requireOriginWork();
          return executionLedgerPort.todayExecutions({ orderId });
        },
      });
      const mapped = withTrustedOrderExecutionTimes(
        [detail.decode(executions)],
        deps.getExecutionTimeEvidence(orderId),
      )[0];
      if (mapped === undefined) throw new Error('[订单状态查询] missing mapped order fact');

      requireOriginWork();
      const status = mapped.status;
      const submittedQuantity = mapped.quantity;
      const executedPrice = mapped.executedPrice;
      const executedQuantity = mapped.executedQuantity;
      const updatedAtMs = mapped.updatedAtMs;
      const closedReason = resolveOrderClosedReasonFromStatus(status);
      if (closedReason !== null) {
        return {
          kind: 'TERMINAL',
          executionStatus: mapped.executionStatus,
          closedReason,
          status,
          executedPrice,
          executedQuantity,
          executedAmount: mapped.executedAmount,
          executionTimeMs: mapped.executionTimeMs,
          submittedQuantity,
          orderUpdatedAtMs: updatedAtMs,
        };
      }

      return {
        kind: 'OPEN',
        executionStatus: mapped.executionStatus,
        status,
        executedPrice,
        executedQuantity,
        executedAmount: mapped.executedAmount,
        executionTimeMs: mapped.executionTimeMs,
        updatedAtMs,
      };
    } catch (error) {
      if (error === cancelled) return { kind: 'QUERY_FAILED', errorCode: null };

      if (isExternalApiRequestError(error)) {
        throw error;
      }

      const errorCode = extractErrorCode(error);
      if (errorCode !== '603001') {
        throw error;
      }

      return {
        kind: 'QUERY_FAILED',
        errorCode,
      };
    }
  }

  return {
    checkOrderState,
  };
}
