/**
 * 换标用例：交易信号构造
 *
 * 职责：
 * - 方向动作映射
 * - 构造订单信号
 */
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
 * 创建信号构造器，对外暴露 buildOrderSignal 方法。
 * @param clock - composition root 注入的统一运行时时钟
 * @returns 含 buildOrderSignal 的对象
 */
export function createSignalBuilder(clock: RuntimeClock): {
  buildOrderSignal: OrderSignalBuilder;
} {
  const buildOrderSignal: OrderSignalBuilder = (params: BuildOrderSignalParams): OrderSignal => {
    const {
      action,
      symbol,
      quote,
      reason,
      executionOrigin,
      orderTypeOverride,
      quantity,
      seatVersion,
    } = params;

    return {
      symbol,
      symbolName: quote?.name ?? symbol,
      action,
      reason,
      ...(executionOrigin === undefined ? {} : { executionOrigin }),
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
