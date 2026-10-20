/**
 * orderMonitor 单订单状态查询模块
 *
 * 职责：
 * - 在撤单/改单 API 业务失败后调用 orderDetail 做权威确认
 * - 将中性订单事实映射为统一 OrderStateCheckResult
 * - 区分终态、仍开放状态与查询失败原因
 */

import { resolveOrderClosedReasonFromStatus } from '../../../domain/order/orderTrackingPolicy.js';
import type { OrderStateCheckResult } from '../../../types/orderReadMetadata.js';
import { isExternalApiRequestError } from '../../../utils/apiFailure/index.js';
import type { OrderStatusQuery, OrderStatusQueryDeps } from './types.js';

/**
 * 单订单权威状态查询：仅用于撤单/改单 API 业务失败后的确认。
 * 只读取 orderDetail；不读取 execution/ledger，也不补造历史执行时间。
 */
export function createOrderStatusQuery(deps: OrderStatusQueryDeps): OrderStatusQuery {
  const { orderDetailReadPort, rateLimiter } = deps;

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
      const mapped = await deps.requestExternalApi({
        operation: 'TradeContext.orderDetail',
        request: () => orderDetailReadPort.read(orderId),
        shouldRetry: orderDetailReadPort.isRetryableError,
      });
      requireOriginWork();

      const status = mapped.status;
      const closedReason = resolveOrderClosedReasonFromStatus(status);
      if (closedReason !== null) {
        return {
          kind: 'TERMINAL',
          executionStatus: mapped.executionStatus,
          closedReason,
          status,
          executedPrice: mapped.executedPrice,
          executedQuantity: mapped.executedQuantity,
          executedAmount: mapped.executedAmount,
          executionTimeMs: mapped.executionTimeMs,
          submittedQuantity: mapped.quantity,
          orderUpdatedAtMs: mapped.updatedAtMs,
        };
      }

      return {
        kind: 'OPEN',
        executionStatus: mapped.executionStatus,
        status,
        executedPrice: mapped.executedPrice,
        executedQuantity: mapped.executedQuantity,
        executedAmount: mapped.executedAmount,
        executionTimeMs: mapped.executionTimeMs,
        updatedAtMs: mapped.updatedAtMs,
      };
    } catch (error) {
      if (error === cancelled) return { kind: 'QUERY_FAILED', errorCode: null };

      if (isExternalApiRequestError(error)) {
        throw error;
      }

      const errorCode = orderDetailReadPort.getErrorCode(error);
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
