/**
 * 自动换标模块：交易信号构造与数量计算
 *
 * 职责：
 * - 方向动作映射
 * - 名义金额换算下单数量
 * - 构造订单信号
 */
import { exactCompare, safeQuantityNumber, wholeLotQuantity } from '../../utils/numeric/exact.js';
import type { RuntimeClock } from '../../types/runtime.js';
import type { BuildOrderSignalParams, OrderSignal, OrderSignalBuilder } from './types.js';

/**
 * 将方向映射到对应的买卖动作与牛熊方向（LONG→BUYCALL/SELLCALL，SHORT→BUYPUT/SELLPUT）。
 * @param direction - 'LONG' | 'SHORT'
 * @returns buyAction、sellAction
 */
export function resolveDirectionSymbols(direction: 'LONG' | 'SHORT'): {
  readonly buyAction: 'BUYCALL' | 'BUYPUT';
  readonly sellAction: 'SELLCALL' | 'SELLPUT';
} {
  const isLong = direction === 'LONG';
  return {
    buyAction: isLong ? 'BUYCALL' : 'BUYPUT',
    sellAction: isLong ? 'SELLCALL' : 'SELLPUT',
  } as const;
}

/**
 * 根据名义金额计算买入数量，按 lotSize 向下取整；无法满足最小手数时返回 null。
 * @param notional - 名义金额
 * @param price - 价格
 * @param lotSize - 每手股数
 * @returns 手数（整数），不满足最小手数时 null
 */
export function calculateBuyQuantityByNotional(
  notional: string,
  price: string,
  lotSize: number,
): number | null {
  if (!Number.isSafeInteger(lotSize) || lotSize <= 0)
    throw new RangeError('Lot size must be a positive safe integer');

  if (exactCompare(notional, '0') <= 0 || exactCompare(price, '0') <= 0) return null;

  const quantity = safeQuantityNumber(wholeLotQuantity(notional, price, String(lotSize)));
  return quantity === 0 ? null : quantity;
}

/**
 * 创建信号构造器，对外暴露 buildOrderSignal 方法。
 * @param clock - composition root 注入的统一运行时时钟
 * @returns 含 buildOrderSignal 的对象
 */
export function createSignalBuilder(clock: RuntimeClock): {
  buildOrderSignal: OrderSignalBuilder;
} {
  const buildOrderSignal: OrderSignalBuilder = (params: BuildOrderSignalParams): OrderSignal => {
    const { action, symbol, quote, reason, orderTypeOverride, quantity, seatVersion } = params;

    return {
      symbol,
      symbolName: quote?.name ?? symbol,
      action,
      reason,
      orderTypeOverride: orderTypeOverride ?? null,
      quantity: quantity ?? null,
      triggerTime: clock.now(),
      seatVersion,
    };
  };

  return {
    buildOrderSignal,
  };
}
