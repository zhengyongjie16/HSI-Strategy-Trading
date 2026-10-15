/** 单订单 detail IO 边界：私有 SDK DTO 只被延迟解码闭包捕获，校验时机归原 query owner。 */

import type { TradeContext } from 'longbridge';
import type { OrderDetailReadPort } from '../../../types/orderDetailReadPorts.js';
import type { OrderEconomics } from '../../../types/orderEconomics.js';
import { mapBrokerOrder } from './orderMapper.js';
import { extractErrorCode, isRetryableOrderApiError } from './orderReadErrorClassification.js';

/** 读取不校验 DTO；让原 query 在 request wrapper 退出后执行预检和 ledger 合并。 */
export function createOrderDetailReadAdapter(
  context: Pick<TradeContext, 'orderDetail'>,
  economics: OrderEconomics,
): OrderDetailReadPort {
  return {
    isRetryableError: isRetryableOrderApiError,
    getErrorCode: extractErrorCode,
    read: async (orderId) => {
      const detail = await context.orderDetail(orderId);
      return { decode: (executions) => mapBrokerOrder(detail, executions, economics) };
    },
  };
}
