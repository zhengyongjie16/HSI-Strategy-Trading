/** 单订单 detail IO 边界：返回已验证中性订单事实，SDK DTO 不出基础设施。 */

import type { TradeContext } from 'longbridge';
import type { OrderDetailReadPort } from '../../../types/orderDetailReadPorts.js';
import { isHongKongSymbol } from '../../../utils/marketScope.js';
import { mapBrokerOrder } from './orderMapper.js';
import { extractErrorCode, isRetryableOrderApiError } from './orderReadErrorClassification.js';

/**
 * 读取单订单并先校验身份/市场范围：错 orderId 或非HK订单立即拒绝，不做跨市场管理。
 * 校验失败属内部契约错误，不进入 retry / 603001 业务分支。
 * @param context 唯一交易context的单订单读取能力
 * @returns 中性单订单权威读取能力
 */
export function createOrderDetailReadAdapter(
  context: Pick<TradeContext, 'orderDetail'>,
): OrderDetailReadPort {
  return {
    isRetryableError: isRetryableOrderApiError,
    getErrorCode: extractErrorCode,
    read: async (orderId) => {
      const detail = await context.orderDetail(orderId);
      if (detail.orderId !== orderId) {
        throw new TypeError('[OrderDetailReadAdapter] order detail identity mismatch');
      }

      if (!isHongKongSymbol(detail.symbol)) {
        throw new TypeError('[OrderDetailReadAdapter] non-HK order detail rejected');
      }

      return mapBrokerOrder(detail);
    },
  };
}
