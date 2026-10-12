/**
 * orderRecorder 分析边界测试
 *
 * 覆盖：
 * - 校验对外暴露的分析依赖面保持最小且稳定
 * - 防止订单分析能力泄漏不必要的内部实现细节
 */
import { describe, expect, it } from 'bun:test';
import * as orderRecorder from '../../../src/core/orderRecorder/index.js';
import { getLatestTradedSymbol } from '../../../src/domain/order/orderOwnership.js';
import type { RawOrderFromAPI } from '../../../src/types/services.js';

function createRawOrder(params: {
  readonly orderId: string;
  readonly symbol: string;
  readonly stockName: string;
  readonly side: 'BUY' | 'SELL';
  readonly updatedAt: Date;
  readonly executedPrice: string;
  readonly executedAmount: string;
  readonly executedQuantity: number;
  readonly executionTimeMs: number;
}): RawOrderFromAPI {
  return {
    orderId: params.orderId,
    symbol: params.symbol,
    stockName: params.stockName,
    remark: '',
    executionSide: params.side,
    executionStatus: 'FILLED',
    executionPhase: 'TERMINAL',
    status: 'FILLED',
    orderType: 'LO',
    quantity: params.executedQuantity,
    executedQuantity: params.executedQuantity,
    price: params.executedPrice,
    executedPrice: params.executedPrice,
    executedAmount: params.executedAmount,
    submittedAt: params.updatedAt,
    executionTimeMs: params.executionTimeMs,
    updatedAtMs: params.updatedAt.getTime(),
    updatedAt: params.updatedAt,
  };
}

describe('orderRecorder public analysis boundary', () => {
  it('exposes dedicated daily loss analysis deps with a minimal public surface', () => {
    const buyOrder = createRawOrder({
      orderId: 'BUY-1',
      symbol: '70000.HK',
      stockName: 'HSI RC',
      side: 'BUY',
      updatedAt: new Date('2026-05-18T01:30:00.000Z'),
      executedPrice: '1',
      executedAmount: '100',
      executedQuantity: 100,
      executionTimeMs: Date.parse('2026-05-18T01:30:00.000Z'),
    });
    const sellOrder = createRawOrder({
      orderId: 'SELL-1',
      symbol: '70000.HK',
      stockName: 'HSI RC',
      side: 'SELL',
      updatedAt: new Date('2026-05-18T02:30:00.000Z'),
      executedPrice: '0.9',
      executedAmount: '90',
      executedQuantity: 100,
      executionTimeMs: Date.parse('2026-05-18T02:30:00.000Z'),
    });

    const deps = orderRecorder.createDailyLossOrderAnalysisDeps();
    const classified = deps.classifyAndConvertOrders([buyOrder, sellOrder]);

    expect(Object.keys(deps).sort((left, right) => left.localeCompare(right))).toEqual([
      'classifyAndConvertOrders',
      'filteringEngine',
      'resolveOrderOwnership',
    ]);

    expect(
      deps.resolveOrderOwnership(buyOrder, {
        monitorSymbol: 'HSI',
        orderOwnershipMapping: ['HSI'],
      }),
    ).toEqual({ monitorSymbol: 'HSI', direction: 'LONG' });
    expect(Object.keys(deps.filteringEngine)).toEqual(['applyFilteringAlgorithm']);

    expect(
      deps.filteringEngine.applyFilteringAlgorithm(classified.buyOrders, classified.sellOrders),
    ).toEqual([]);
  });

  it('keeps order analysis internals off the public boundary', () => {
    expect(orderRecorder).not.toHaveProperty('createOrderAnalysisTools');
    expect(orderRecorder).not.toHaveProperty('createOrderFilteringEngine');
    expect(orderRecorder).not.toHaveProperty('classifyAndConvertOrders');
  });

  it('keeps analysis ownership and parser latest-symbol lookup as separate capabilities', () => {
    const buyOrder = createRawOrder({
      orderId: 'BUY-2',
      symbol: '70000.HK',
      stockName: 'HSI RC',
      side: 'BUY',
      updatedAt: new Date('2026-05-18T03:30:00.000Z'),
      executedPrice: '1',
      executedAmount: '100',
      executedQuantity: 100,
      executionTimeMs: Date.parse('2026-05-18T03:30:00.000Z'),
    });

    expect(
      orderRecorder.createDailyLossOrderAnalysisDeps().resolveOrderOwnership(buyOrder, {
        monitorSymbol: 'HSI',
        orderOwnershipMapping: ['HSI'],
      }),
    ).toEqual({ monitorSymbol: 'HSI', direction: 'LONG' });
    expect(getLatestTradedSymbol([buyOrder], ['HSI'], 'LONG')).toBe('70000.HK');
  });
});
