import { createLoggerDouble } from '../../../helpers/testDoubles.js';

/**
 * selectSellableOrders 单元测试
 *
 * 功能：
 * - 验证订单筛选策略（ALL / PROFIT_ONLY / TIMEOUT_ONLY）
 * - 验证待成交占用过滤、额外排除与整笔截断
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import { createOrderStorage } from '../../../../src/application/orderTracking/recorder/orderStorage.js';
import type { OrderStorage } from '../../../../src/application/orderTracking/recorder/types.js';
import type { OrderRecord } from '../../../../src/types/orderRecorder.js';

function makeOrder(
  orderId: string,
  costAmount: string,
  quantity: number,
  executedTime: number,
  symbol = 'TEST.HK',
): OrderRecord {
  return {
    orderId,
    symbol,
    costAmount,
    executedQuantity: quantity,
    executedTime,
  };
}

describe('selectSellableOrders', () => {
  let storage: OrderStorage;

  beforeEach(() => {
    storage = createOrderStorage(createLoggerDouble());
  });

  it('PROFIT_ONLY 仅返回买入价小于当前价的订单', () => {
    storage.setBuyOrdersListForLong('TEST.HK', [
      makeOrder('O1', '100', 100, 1),
      makeOrder('O2', '120', 100, 2),
      makeOrder('O3', '80', 100, 3),
    ]);

    const result = storage.selectSellableOrders({
      symbol: 'TEST.HK',
      direction: 'LONG',
      strategy: 'PROFIT_ONLY',
      currentPrice: '1.1',
    });

    expect(result.totalQuantity).toBe(200);
    expect(result.orders.map((order) => order.orderId)).toEqual(['O3', 'O1']);
  });

  it('ALL 返回全部订单（按卖出优先级排序）', () => {
    storage.setBuyOrdersListForLong('TEST.HK', [
      makeOrder('O1', '120', 100, 2),
      makeOrder('O2', '80', 100, 3),
      makeOrder('O3', '100', 100, 1),
    ]);

    const result = storage.selectSellableOrders({
      symbol: 'TEST.HK',
      direction: 'LONG',
      strategy: 'ALL',
      currentPrice: '1',
    });

    expect(result.totalQuantity).toBe(300);
    expect(result.orders.map((order) => order.orderId)).toEqual(['O2', 'O3', 'O1']);
  });

  it('同价智能平仓按成交时间与 orderId 排序且输入反转结果一致', () => {
    const orders = [
      makeOrder('BUY-C', '100', 100, 100),
      makeOrder('BUY-B', '100', 100, 100),
      makeOrder('BUY-D', '100', 100, 200),
    ];
    storage.setBuyOrdersListForLong('TEST.HK', [orders[2]!, orders[1]!, orders[0]!]);

    const result = storage.selectSellableOrders({
      symbol: 'TEST.HK',
      direction: 'LONG',
      strategy: 'ALL',
      currentPrice: '1',
    });

    expect(result.orders.map((order) => order.orderId)).toEqual(['BUY-B', 'BUY-C', 'BUY-D']);
  });

  it('恢复待成交卖单关联按与智能平仓相同的三键顺序分配', () => {
    storage.setBuyOrdersListForLong('TEST.HK', [
      makeOrder('BUY-LATER', '100', 100, 200),
      makeOrder('BUY-ID-C', '100', 100, 100),
      makeOrder('BUY-ID-B', '100', 100, 100),
    ]);

    const relatedIds = storage.allocateRelatedBuyOrderIdsForRecovery('TEST.HK', 'LONG', 200);

    expect(relatedIds).toEqual(['BUY-ID-B', 'BUY-ID-C']);
  });

  it('TIMEOUT_ONLY 在严格交易时段累计超过阈值时返回超时订单', () => {
    storage.setBuyOrdersListForLong('TEST.HK', [
      makeOrder('OLD', '100', 100, Date.parse('2026-02-24T01:30:00.000Z')),
      makeOrder('NEW', '100', 100, Date.parse('2026-02-24T02:10:00.000Z')),
    ]);

    const result = storage.selectSellableOrders({
      symbol: 'TEST.HK',
      direction: 'LONG',
      strategy: 'TIMEOUT_ONLY',
      currentPrice: '1',
      timeoutMinutes: 60,
      nowMs: Date.parse('2026-02-24T02:31:00.000Z'),
      calendarSnapshot: new Map([
        [
          '2026-02-24',
          {
            isTradingDay: true,
            isHalfDay: false,
          },
        ],
      ]),
    });

    expect(result.totalQuantity).toBe(100);
    expect(result.orders.map((order) => order.orderId)).toEqual(['OLD']);
  });

  it('会排除 pending 占用订单与 excludeOrderIds', () => {
    storage.setBuyOrdersListForLong('TEST.HK', [
      makeOrder('O1', '80', 100, 1),
      makeOrder('O2', '90', 100, 2),
      makeOrder('O3', '100', 100, 3),
    ]);

    storage.addPendingSell({
      orderId: 'SELL-1',
      symbol: 'TEST.HK',
      direction: 'LONG',
      submittedQuantity: 100,
      relatedBuyOrderIds: ['O1'],
    });

    const result = storage.selectSellableOrders({
      symbol: 'TEST.HK',
      direction: 'LONG',
      strategy: 'ALL',
      currentPrice: '1',
      excludeOrderIds: new Set(['O2']),
    });

    expect(result.totalQuantity).toBe(100);
    expect(result.orders.map((order) => order.orderId)).toEqual(['O3']);
  });

  it('maxSellQuantity 触发整笔截断', () => {
    storage.setBuyOrdersListForLong('TEST.HK', [
      makeOrder('O1', '120', 150, 1),
      makeOrder('O2', '90', 100, 2),
    ]);

    const result = storage.selectSellableOrders({
      symbol: 'TEST.HK',
      direction: 'LONG',
      strategy: 'ALL',
      currentPrice: '1',
      maxSellQuantity: 200,
    });

    expect(result.totalQuantity).toBe(150);
    expect(result.orders.map((order) => order.orderId)).toEqual(['O1']);
  });

  it('SHORT 方向同样适用策略筛选', () => {
    storage.setBuyOrdersListForShort('TEST.HK', [
      makeOrder('S1', '100', 100, 1),
      makeOrder('S2', '150', 100, 2),
    ]);

    const result = storage.selectSellableOrders({
      symbol: 'TEST.HK',
      direction: 'SHORT',
      strategy: 'PROFIT_ONLY',
      currentPrice: '1.2',
    });

    expect(result.totalQuantity).toBe(100);
    expect(result.orders.map((order) => order.orderId)).toEqual(['S1']);
  });
});
