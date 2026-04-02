/**
 * 交易数据 Mock 工厂
 *
 * 功能：
 * - 构造订单、订单推送与持仓等交易侧测试数据
 */
import {
  Decimal,
  OrderSide,
  OrderStatus,
  OrderType,
  type Order,
  type PushOrderChanged,
  type StockPositionsResponse,
} from 'longbridge';
import { toMockDecimal } from '../longbridge/decimal.js';
import type {
  OrderFactoryParams,
  PushOrderChangedParams,
  StockPositionsResponseParams,
} from './types.js';

/**
 * 构造符合 Longbridge Order 形状的订单对象，供测试或 Mock 使用。
 * 未传字段使用默认值（如 status=New、quantity=100）。
 */
export function createOrder(params: OrderFactoryParams): Order {
  const order = {
    orderId: params.orderId,
    status: params.status ?? OrderStatus.New,
    stockName: params.symbol,
    quantity: toMockDecimal(params.quantity ?? 100),
    executedQuantity: toMockDecimal(params.executedQuantity ?? 0),
    price: toMockDecimal(params.price ?? 1),
    executedPrice: toMockDecimal(params.executedPrice ?? 0),
    submittedAt: new Date(),
    side: params.side ?? OrderSide.Buy,
    symbol: params.symbol,
    orderType: params.orderType ?? OrderType.ELO,
    lastDone: Decimal.ZERO(),
    triggerPrice: Decimal.ZERO(),
    msg: '',
    tag: 0,
    timeInForce: 0,
    expireDate: '2026-12-31',
    updatedAt: new Date(),
    triggerAt: new Date(),
    trailingAmount: Decimal.ZERO(),
    trailingPercent: Decimal.ZERO(),
    limitOffset: Decimal.ZERO(),
    triggerStatus: 0,
    currency: 'HKD',
    outsideRth: 0,
    limitDepthLevel: 0,
    triggerCount: 0,
    monitorPrice: Decimal.ZERO(),
    remark: '',
  };

  return order as unknown as Order;
}

/**
 * 构造订单变更推送事件，用于模拟 TradeContext 的 orderChanged 推送。
 */
export function createPushOrderChanged(params: PushOrderChangedParams): PushOrderChanged {
  const updatedAtMs = params.updatedAtMs ?? Date.now();
  const event = {
    side: params.side ?? OrderSide.Buy,
    stockName: params.symbol,
    submittedQuantity: toMockDecimal(params.submittedQuantity ?? 100),
    symbol: params.symbol,
    orderType: params.orderType ?? OrderType.ELO,
    submittedPrice: toMockDecimal(params.submittedPrice ?? 1),
    executedQuantity: toMockDecimal(params.executedQuantity ?? 0),
    executedPrice: toMockDecimal(params.executedPrice ?? 0),
    orderId: params.orderId,
    currency: 'HKD',
    status: params.status ?? OrderStatus.New,
    submittedAt: new Date(updatedAtMs),
    updatedAt: new Date(updatedAtMs),
    triggerPrice: Decimal.ZERO(),
    msg: '',
    tag: 0,
    triggerStatus: 0,
    triggerAt: new Date(updatedAtMs),
    trailingAmount: Decimal.ZERO(),
    trailingPercent: Decimal.ZERO(),
    limitOffset: Decimal.ZERO(),
    accountNo: 'MOCK',
    lastShare: Decimal.ZERO(),
    lastPrice: Decimal.ZERO(),
    remark: '',
  };

  return event as unknown as PushOrderChanged;
}

/**
 * 构造持仓响应，供 stockPositions Mock 使用；可指定标的、数量与可卖数量。
 */
export function createStockPositionsResponse(
  params: StockPositionsResponseParams,
): StockPositionsResponse {
  const response = {
    channels: [
      {
        accountChannel: 'lb_papertrading',
        positions: [
          {
            symbol: params.symbol,
            symbolName: params.symbol,
            quantity: toMockDecimal(params.quantity),
            availableQuantity: toMockDecimal(params.availableQuantity),
            currency: 'HKD',
            costPrice: toMockDecimal(1),
            market: 'HK',
            initQuantity: toMockDecimal(params.quantity),
          },
        ],
      },
    ],
  };

  return response as unknown as StockPositionsResponse;
}
