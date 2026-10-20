/**
 * 今日挂单SDK读取边界：先过滤明确非HK订单，再映射委托金融文本和安全整数数量；不做缓存或交易决策。
 * 使用注入的同一TradeContext；金融字段不经过toNumber，不建立第二订单账。
 */
import type { TradeContext } from 'longbridge';
import { mapBrokerOrderSide, mapBrokerOrderStatus, mapBrokerOrderType } from './orderMapper.js';
import { isRecord } from '../../../utils/helpers/index.js';
import { isHongKongSymbol } from '../../../utils/marketScope.js';
import type { PendingOrder } from '../../../types/orderReadMetadata.js';
import type { PendingOrdersAdapter } from './types.js';
import {
  isValidatedOrderSide,
  isValidatedOrderStatus,
  isValidatedOrderType,
} from './orderValidation.js';
import {
  canonicalDecimal,
  exactCompare,
  safeQuantityNumber,
} from '../../../utils/numeric/exact.js';

/**
 * 同ctx装配todayOrders读取，将SDK数据转换为cache实际消费的中性文本/整数事实。
 * 明确非HK订单在严格数值/状态映射前过滤，坏 symbol 结构直接抛出。
 * @param ctx 唯一交易context的今日订单读取能力
 * @returns 不含SDK金融对象的读取能力
 */
export function createPendingOrdersAdapter(context: unknown): PendingOrdersAdapter {
  if (!isRecord(context) || typeof context['todayOrders'] !== 'function') {
    throw new TypeError('[PendingOrdersAdapter] missing injected SDK todayOrders capability');
  }

  const ctx = context as Pick<TradeContext, 'todayOrders'>;
  return {
    todayOrders: async (): Promise<ReadonlyArray<PendingOrder>> => {
      const orders = await ctx.todayOrders();
      const scope: PendingOrder[] = [];
      for (const order of orders) {
        // 跨市场订单（含碎股小数数量）不进入本系统订单管理范围。
        if (!isHongKongSymbol(order.symbol)) continue;

        if (
          !isValidatedOrderSide(order.side) ||
          !isValidatedOrderStatus(order.status) ||
          !isValidatedOrderType(order.orderType)
        ) {
          throw new TypeError('[PendingOrdersAdapter] unknown SDK order side/status/type');
        }

        const quantity = safeQuantityNumber(order.quantity.toString());
        const executedQuantity = safeQuantityNumber(order.executedQuantity.toString());
        if (executedQuantity > quantity)
          throw new TypeError(
            '[PendingOrdersAdapter] executed quantity exceeds submitted quantity',
          );

        const originalPrice = order.price === null ? null : order.price.toString();
        const price = originalPrice === null ? null : canonicalDecimal(originalPrice);
        scope.push({
          orderId: order.orderId,
          symbol: order.symbol,
          side: mapBrokerOrderSide(order.side),
          status: mapBrokerOrderStatus(order.status),
          orderType: mapBrokerOrderType(order.orderType),
          submittedPrice:
            price !== null && originalPrice?.startsWith('-') && exactCompare(price, '0') === 0
              ? '-0'
              : price,
          quantity,
        });
      }

      return scope;
    },
  };
}
