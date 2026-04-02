/**
 * 行情数据 Mock 工厂
 *
 * 功能：
 * - 构造 K 线与 K 线推送事件，供高价值业务测试复用
 */
import { Decimal, Period, type Candlestick, type PushCandlestickEvent } from 'longbridge';
import { toMockDecimal } from '../longbridge/decimal.js';
import type { CandlestickParams, PushCandlestickEventParams } from './types.js';

/**
 * 构造单根 K 线数据，供 K 线订阅或历史数据 Mock 使用。
 */
export function createCandlestick(params: CandlestickParams): Candlestick {
  const timestampMs = params.timestampMs ?? Date.now();
  const candle = {
    close: toMockDecimal(params.close),
    open: toMockDecimal(params.close),
    high: toMockDecimal(params.close),
    low: toMockDecimal(params.close),
    volume: 1,
    turnover: Decimal.ZERO(),
    timestamp: new Date(timestampMs),
    tradeSession: 0,
  };

  return candle as unknown as Candlestick;
}

/**
 * 构造 K 线推送事件，用于模拟 candlestick 订阅推送。
 */
export function createPushCandlestickEvent(
  params: PushCandlestickEventParams,
): PushCandlestickEvent {
  const timestampMs = params.timestampMs ?? Date.now();
  const candlestick = {
    close: toMockDecimal(params.close),
    open: toMockDecimal(params.close),
    high: toMockDecimal(params.close),
    low: toMockDecimal(params.close),
    volume: 1,
    turnover: Decimal.ZERO(),
    timestamp: new Date(timestampMs),
    tradeSession: 0,
  } as Candlestick;
  const event = {
    symbol: params.symbol,
    data: {
      period: params.period ?? Period.Min_1,
      candlestick,
      isConfirmed: params.isConfirmed ?? false,
    },
  };

  return event as unknown as PushCandlestickEvent;
}
