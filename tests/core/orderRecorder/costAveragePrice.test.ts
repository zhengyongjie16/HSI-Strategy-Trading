/** 成本依据回归：保留原价格经济口径，使用精确金额/数量；动态买卖经真实 O/Daily/S。 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { createOrderStorage } from '../../../src/core/orderRecorder/orderStorage.js';
import type { OrderRecord } from '../../../src/types/services.js';
import type { OrderStorage } from '../../../src/core/orderRecorder/types.js';
import { createExecutionFixture } from './executionFixture.js';

function makeOrder(
  orderId: string,
  costAmount: string,
  quantity: number,
  time = 1_000,
): OrderRecord {
  return {
    orderId,
    symbol: 'TEST.HK',
    costAmount,
    executedQuantity: quantity,
    executedTime: time,
    submittedAt: undefined,
    updatedAt: undefined,
  };
}

describe('getCostBasis', () => {
  let storage: OrderStorage;
  beforeEach(() => {
    storage = createOrderStorage();
  });

  it('无订单时返回 null', () => {
    expect(storage.getCostBasis('TEST.HK', true)).toBeNull();
  });

  it('无订单时做空方向也返回 null', () => {
    expect(storage.getCostBasis('TEST.HK', false)).toBeNull();
  });

  it('单笔订单保留原成本', () => {
    storage.setBuyOrdersListForLong('TEST.HK', [makeOrder('O1', '100', 100)]);
    expect(storage.getCostBasis('TEST.HK', true)).toEqual({ costAmount: '100', quantity: 100 });
  });

  it('两笔等量订单保留算术平均的精确依据', () => {
    storage.setBuyOrdersListForLong('TEST.HK', [
      makeOrder('O1', '100', 100),
      makeOrder('O2', '120', 100),
    ]);
    expect(storage.getCostBasis('TEST.HK', true)).toEqual({ costAmount: '220', quantity: 200 });
  });

  it('多笔不等量订单保留加权依据，不舍入 325/300', () => {
    storage.setBuyOrdersListForLong('TEST.HK', [
      makeOrder('O1', '100', 100),
      makeOrder('O2', '180', 150),
      makeOrder('O3', '45', 50),
    ]);
    expect(storage.getCostBasis('TEST.HK', true)).toEqual({ costAmount: '325', quantity: 300 });
  });

  it('做多和做空方向的成本互不影响', () => {
    storage.setBuyOrdersListForLong('TEST.HK', [makeOrder('O1', '100', 100)]);
    storage.setBuyOrdersListForShort('TEST.HK', [makeOrder('O2', '200', 100)]);
    expect(storage.getCostBasis('TEST.HK', true)).toEqual({ costAmount: '100', quantity: 100 });
    expect(storage.getCostBasis('TEST.HK', false)).toEqual({ costAmount: '200', quantity: 100 });
  });

  it('不同标的的成本互不影响', () => {
    storage.setBuyOrdersListForLong('A.HK', [makeOrder('O1', '100', 100)]);
    storage.setBuyOrdersListForLong('B.HK', [makeOrder('O2', '300', 100)]);
    expect(storage.getCostBasis('A.HK', true)).toEqual({ costAmount: '100', quantity: 100 });
    expect(storage.getCostBasis('B.HK', true)).toEqual({ costAmount: '300', quantity: 100 });
    expect(storage.getCostBasis('C.HK', true)).toBeNull();
  });

  // 原无效价格/数量场景仍保留；当前成交事实契约拒绝而非按零吞掉。
  it.each([
    {
      label: '零金额混合有效订单',
      orders: [makeOrder('O1', '0', 100), makeOrder('O2', '100', 100)],
    },
    { label: '零数量混合有效订单', orders: [makeOrder('O1', '0', 0), makeOrder('O2', '200', 200)] },
    { label: '所有金额无效', orders: [makeOrder('O1', '0', 100), makeOrder('O2', 'NaN', 100)] },
    { label: '所有数量为零', orders: [makeOrder('O1', '0', 0), makeOrder('O2', '0', 0)] },
    { label: 'NaN 金额', orders: [makeOrder('O1', 'NaN', 100), makeOrder('O2', '200', 100)] },
    {
      label: 'Infinity 金额',
      orders: [makeOrder('O1', 'Infinity', 100), makeOrder('O2', '300', 200)],
    },
  ])('无效依据不再污染成本：$label', ({ orders }) => {
    storage.setBuyOrdersListForLong('TEST.HK', orders);
    expect(() => storage.getCostBasis('TEST.HK', true)).toThrow();
  });

  it('买入后成本经真实准入更新并登记同 H/S stale', () => {
    const f = createExecutionFixture();
    expect(f.commit('O1', 'BUY', '1', '100', 100, 1_000).admission).toBe('ADMITTED');
    expect(f.recorder.getCostBasis('TEST.HK', true)).toEqual({ costAmount: '100', quantity: 100 });
    expect(f.commit('O2', 'BUY', '1.2', '120', 100, 2_000).admission).toBe('ADMITTED');
    expect(f.recorder.getCostBasis('TEST.HK', true)).toEqual({ costAmount: '220', quantity: 200 });
    expect(f.sink.getStatus()).toEqual({ started: false, currentVersion: 0, staleVersion: 2 });
    expect(f.snapshot.getView().token.snapshotGeneration).toBe(2);
    expect(f.io.calls).toEqual([]);
  });

  it('卖出部分后成本依据正确更新', () => {
    const f = createExecutionFixture();
    f.commit('O1', 'BUY', '1', '100', 100, 1_000);
    f.commit('O2', 'BUY', '1.2', '120', 100, 2_000);
    expect(f.recorder.getCostBasis('TEST.HK', true)).toEqual({ costAmount: '220', quantity: 200 });
    expect(f.commit('S1', 'SELL', '1.05', '105', 100, 3_000).admission).toBe('ADMITTED');
    expect(f.recorder.getCostBasis('TEST.HK', true)).toEqual({ costAmount: '120', quantity: 100 });
    expect(f.recorder.getBuyOrdersForSymbol('TEST.HK', true).map((o) => o.orderId)).toEqual(['O2']);
  });

  it('卖出全部后成本为 null', () => {
    const f = createExecutionFixture();
    f.commit('O1', 'BUY', '1', '100', 100, 1_000);
    f.commit('O2', 'BUY', '1.2', '120', 100, 2_000);
    f.commit('S1', 'SELL', '1.1', '220', 200, 3_000);
    expect(f.recorder.getCostBasis('TEST.HK', true)).toBeNull();
  });

  it('clearBuyOrders 后成本为 null', () => {
    const f = createExecutionFixture();
    f.commit('O1', 'BUY', '1', '100', 100, 1_000);
    expect(f.recorder.getCostBasis('TEST.HK', true)).toEqual({ costAmount: '100', quantity: 100 });
    f.recorder.clearBuyOrders('TEST.HK', true);
    expect(f.recorder.getCostBasis('TEST.HK', true)).toBeNull();
  });

  it('resetAll 后所有成本为 null', () => {
    const f = createExecutionFixture();
    f.commit('O1', 'BUY', '1', '100', 100, 1_000, 'A.HK');
    f.commit('O2', 'BUY', '2', '200', 100, 1_000, 'B.HK', false);
    f.recorder.resetAll();
    expect(f.recorder.getCostBasis('A.HK', true)).toBeNull();
    expect(f.recorder.getCostBasis('B.HK', false)).toBeNull();
  });

  it('相同价格订单保留相同价格的精确依据', () => {
    storage.setBuyOrdersListForLong('TEST.HK', [
      makeOrder('O1', '100', 100),
      makeOrder('O2', '100', 100),
    ]);
    expect(storage.getCostBasis('TEST.HK', true)).toEqual({ costAmount: '200', quantity: 200 });
  });

  it('极小价格订单正确计算', () => {
    storage.setBuyOrdersListForLong('TEST.HK', [
      makeOrder('O1', '10', 10000),
      makeOrder('O2', '20', 10000),
    ]);
    expect(storage.getCostBasis('TEST.HK', true)).toEqual({ costAmount: '30', quantity: 20000 });
  });

  it('大量订单成本汇总保持原 1.4995 的精确经济依据', () => {
    // 原 price = 1 + i*0.001、qty = 100；以整数十分之一金额直接构造，独立于生产金融 helper。
    const orders = Array.from({ length: 1000 }, (_, i) => {
      const tenths = 1000n + BigInt(i);
      return makeOrder(`O${i}`, `${tenths / 10n}.${tenths % 10n}`, 100);
    });
    storage.setBuyOrdersListForLong('TEST.HK', orders);
    expect(storage.getCostBasis('TEST.HK', true)).toEqual({
      costAmount: '149950',
      quantity: 100000,
    });
  });
});
