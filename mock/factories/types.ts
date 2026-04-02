import type { OrderSide, OrderStatus, OrderType, Period } from 'longbridge';
import type { SignalType } from '../../src/types/signal.js';

/**
 * K 线构造参数。
 * 类型用途：为 createCandlestick 提供 close 与时间字段约束。
 * 数据来源：测试场景下手工构造的 K 线输入。
 * 使用范围：mock/factories/quoteFactory.ts。
 */
export type CandlestickParams = {
  readonly close: number;
  readonly timestampMs?: number;
};

/**
 * K 线推送事件构造参数。
 * 类型用途：为 createPushCandlestickEvent 提供 symbol/close/time 入参约束。
 * 数据来源：测试场景下手工构造的 K 线推送输入。
 * 使用范围：mock/factories/quoteFactory.ts。
 */
export type PushCandlestickEventParams = {
  readonly symbol: string;
  readonly close: number;
  readonly timestampMs?: number;
  readonly period?: Period;
  readonly isConfirmed?: boolean;
};

/**
 * 信号构造参数。
 * 类型用途：为 createSignal 提供可选字段与必填行为字段约束。
 * 数据来源：测试场景下手工构造的策略信号输入。
 * 使用范围：mock/factories/signalFactory.ts。
 */
export type SignalFactoryParams = {
  readonly symbol: string;
  readonly action: SignalType;
  readonly seatVersion?: number;
  readonly triggerTimeMs?: number;
  readonly price?: number;
  readonly lotSize?: number;
  readonly reason?: string;
  readonly indicators1?: Readonly<Record<string, number>>;
};

/**
 * 订单构造参数。
 * 类型用途：为 createOrder 提供订单核心字段与可选覆盖字段约束。
 * 数据来源：测试场景下手工构造的下单输入。
 * 使用范围：mock/factories/tradeFactory.ts。
 */
export type OrderFactoryParams = {
  readonly orderId: string;
  readonly symbol: string;
  readonly side?: OrderSide;
  readonly status?: OrderStatus;
  readonly orderType?: OrderType;
  readonly quantity?: number;
  readonly executedQuantity?: number;
  readonly price?: number;
  readonly executedPrice?: number;
};

/**
 * 订单变更推送构造参数。
 * 类型用途：为 createPushOrderChanged 提供推送字段约束。
 * 数据来源：测试场景下手工构造的订单变更输入。
 * 使用范围：mock/factories/tradeFactory.ts。
 */
export type PushOrderChangedParams = {
  readonly orderId: string;
  readonly symbol: string;
  readonly side?: OrderSide;
  readonly status?: OrderStatus;
  readonly orderType?: OrderType;
  readonly submittedQuantity?: number;
  readonly executedQuantity?: number;
  readonly submittedPrice?: number;
  readonly executedPrice?: number;
  readonly updatedAtMs?: number;
};

/**
 * 持仓响应构造参数。
 * 类型用途：为 createStockPositionsResponse 提供标的与数量字段约束。
 * 数据来源：测试场景下手工构造的持仓输入。
 * 使用范围：mock/factories/tradeFactory.ts。
 */
export type StockPositionsResponseParams = {
  readonly symbol: string;
  readonly quantity: number;
  readonly availableQuantity: number;
};
