/** 真实成交准入→精确成本依据→智能平仓→结算集成；保留原十二场景的经济和防重 oracle。 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { resolveSellQuantityBySmartClose } from '../../../src/core/signalProcessor/utils.js';
import { createExecutionFixture } from './executionFixture.js';

const emptyCalendarSnapshot = new Map<string, { isTradingDay: boolean; isHalfDay: boolean }>();

describe('精确成本与智能平仓全链路集成测试', () => {
  let f: ReturnType<typeof createExecutionFixture>;
  beforeEach(() => {
    f = createExecutionFixture();
  });
  function smartClose(currentPrice: string, availableQuantity: number) {
    return resolveSellQuantityBySmartClose({
      orderRecorder: f.recorder,
      currentPrice,
      availableQuantity,
      direction: 'LONG',
      symbol: 'TEST.HK',
      smartCloseTimeoutMinutes: null,
      nowMs: f.now + 10_000,
      isHalfDay: false,
      tradingCalendarSnapshot: emptyCalendarSnapshot,
    });
  }
  it('场景1: 整体盈利全部卖出', () => {
    f.commit('BUY-1', 'BUY', '1', '100', 100, 1000);
    f.commit('BUY-2', 'BUY', '1.2', '120', 100, 2000);
    expect(f.recorder.getCostBasis('TEST.HK', true)).toEqual({ costAmount: '220', quantity: 200 });
    const result = smartClose('1.15', 200);
    expect(result.shouldHold).toBe(false);
    expect(result.quantity).toBe(200);
    expect(result.relatedBuyOrderIds).toHaveLength(2);
  });

  it('场景2: 整体未盈利仅卖盈利部分', () => {
    f.commit('BUY-1', 'BUY', '1', '100', 100, 1000);
    f.commit('BUY-2', 'BUY', '1.2', '120', 100, 2000);
    expect(f.recorder.getCostBasis('TEST.HK', true)).toEqual({ costAmount: '220', quantity: 200 });
    const result = smartClose('1.05', 200);
    expect(result.shouldHold).toBe(false);
    expect(result.quantity).toBe(100);
    expect(result.relatedBuyOrderIds).toEqual(['BUY-1']);
  });

  it('场景3: 卖出后成本依据更新', () => {
    f.commit('BUY-1', 'BUY', '1', '100', 100, 1000);
    f.commit('BUY-2', 'BUY', '1.2', '120', 100, 2000);
    expect(f.recorder.getCostBasis('TEST.HK', true)).toEqual({ costAmount: '220', quantity: 200 });
    f.commit('SELL-1', 'SELL', '1.05', '105', 100, 3000);
    expect(f.recorder.getCostBasis('TEST.HK', true)).toEqual({ costAmount: '120', quantity: 100 });
    const result = smartClose('1.15', 100);
    expect(result.shouldHold).toBe(true);
    expect(result.quantity).toBeNull();
  });

  it('场景4: 保护性清仓后成本依据为空', () => {
    f.commit('BUY-1', 'BUY', '1', '100', 100, 1000);
    f.commit('BUY-2', 'BUY', '1.2', '120', 100, 2000);
    expect(f.recorder.getCostBasis('TEST.HK', true)).toEqual({ costAmount: '220', quantity: 200 });
    f.recorder.clearBuyOrders('TEST.HK', true);
    expect(f.recorder.getCostBasis('TEST.HK', true)).toBeNull();
    expect(smartClose('1.5', 200).shouldHold).toBe(true);
  });

  it('场景5: 防重端到端验证', () => {
    f.commit('BUY-LOW', 'BUY', '0.8', '80', 100, 1000);
    f.commit('BUY-MID', 'BUY', '1', '100', 100, 2000);
    f.commit('BUY-HIGH', 'BUY', '1.2', '120', 100, 3000);
    expect(f.recorder.getCostBasis('TEST.HK', true)).toEqual({ costAmount: '300', quantity: 300 });
    f.recorder.submitSellOrder('SELL-1', 'TEST.HK', 'LONG', 100, ['BUY-LOW'], false, f.now + 4000);
    const result = smartClose('1.5', 300);
    expect(result.shouldHold).toBe(false);
    expect(result.quantity).toBe(200);
    expect(result.relatedBuyOrderIds).toHaveLength(2);
    expect(result.relatedBuyOrderIds).not.toContain('BUY-LOW');
  });

  it('场景6: 三笔订单的原完整计算，不舍入 325/300', () => {
    f.commit('BUY-1', 'BUY', '1', '100', 100, 1000);
    f.commit('BUY-2', 'BUY', '1.2', '180', 150, 2000);
    f.commit('BUY-3', 'BUY', '0.9', '45', 50, 3000);
    expect(f.recorder.getCostBasis('TEST.HK', true)).toEqual({ costAmount: '325', quantity: 300 });
    const result1 = smartClose('1.1', 300);
    expect(result1.shouldHold).toBe(false);
    expect(result1.quantity).toBe(300);
    const result2 = smartClose('1.05', 300);
    expect(result2.shouldHold).toBe(false);
    expect(result2.quantity).toBe(150);
  });

  it('场景7: 连续买入卖出后成本依据持续正确', () => {
    f.commit('BUY-1', 'BUY', '1', '100', 100, 1000);
    expect(f.recorder.getCostBasis('TEST.HK', true)).toEqual({ costAmount: '100', quantity: 100 });
    f.commit('BUY-2', 'BUY', '1.4', '140', 100, 2000);
    expect(f.recorder.getCostBasis('TEST.HK', true)).toEqual({ costAmount: '240', quantity: 200 });
    f.commit('SELL-1', 'SELL', '1.3', '130', 100, 3000);
    expect(f.recorder.getCostBasis('TEST.HK', true)).toEqual({ costAmount: '140', quantity: 100 });
    f.commit('BUY-3', 'BUY', '1', '100', 100, 4000);
    expect(f.recorder.getCostBasis('TEST.HK', true)).toEqual({ costAmount: '240', quantity: 200 });
    f.commit('SELL-2', 'SELL', '1.3', '260', 200, 5000);
    expect(f.recorder.getCostBasis('TEST.HK', true)).toBeNull();
  });

  it('场景8: 待成交卖出成交资源关闭后释放占用', () => {
    f.commit('BUY-1', 'BUY', '1', '100', 100, 1000);
    f.commit('BUY-2', 'BUY', '0.9', '90', 100, 2000);
    f.recorder.submitSellOrder('SELL-1', 'TEST.HK', 'LONG', 100, ['BUY-1'], false, f.now + 3000);
    expect(
      f.recorder.selectSellableOrders({
        symbol: 'TEST.HK',
        direction: 'LONG',
        strategy: 'ALL',
        currentPrice: '1.5',
      }).totalQuantity,
    ).toBe(100);
    // 保留原占用资源 API 的 oracle；不声称已提交 SELL 经济事实。
    expect(f.recorder.markSellFilled('SELL-1')?.status).toBe('filled');
    expect(
      f.recorder.selectSellableOrders({
        symbol: 'TEST.HK',
        direction: 'LONG',
        strategy: 'ALL',
        currentPrice: '1.5',
      }).totalQuantity,
    ).toBe(200);
  });

  it('零成交撤单沿真实终态结算链释放占用且保留全部买单', () => {
    // 原场景只测试占用释放，不能伪造 FILLED 却不抵扣经济；真实零成交终态保留全部买单。
    f.commit('BUY-1', 'BUY', '1', '100', 100, 1000);
    f.commit('BUY-2', 'BUY', '0.9', '90', 100, 2000);
    f.recorder.submitSellOrder('SELL-1', 'TEST.HK', 'LONG', 100, ['BUY-1'], false, f.now + 3000);
    expect(
      f.recorder.selectSellableOrders({
        symbol: 'TEST.HK',
        direction: 'LONG',
        strategy: 'ALL',
        currentPrice: '1.5',
      }).totalQuantity,
    ).toBe(100);

    expect(
      f.flow.settleOrder({
        orderId: 'SELL-1',
        closedReason: 'CANCELED',
        source: 'STATE_CHECK',
        symbol: 'TEST.HK',
        side: 'SELL',
        monitorSymbol: 'HSI.HK',
        isLongSymbol: true,
        isProtectiveLiquidation: false,
        executedPrice: null,
        executedAmount: '0',
        executedQuantity: 0,
        executedTimeMs: null,
        orderUpdatedAtMs: f.now + 4000,
      }).handled,
    ).toBe(true);

    expect(
      f.recorder.selectSellableOrders({
        symbol: 'TEST.HK',
        direction: 'LONG',
        strategy: 'ALL',
        currentPrice: '1.5',
      }).totalQuantity,
    ).toBe(200);
    expect(f.recorder.getPendingSellSnapshot()).toEqual([]);
    expect(f.events).toHaveLength(1);
  });

  it('场景9: resetAll 后所有状态重置', () => {
    f.commit('BUY-A', 'BUY', '1', '100', 100, 1000, 'A.HK');
    f.commit('BUY-B', 'BUY', '2', '200', 100, 1000, 'B.HK', false);
    f.recorder.resetAll();
    expect(f.recorder.getCostBasis('A.HK', true)).toBeNull();
    expect(f.recorder.getCostBasis('B.HK', false)).toBeNull();
    expect(f.recorder.getBuyOrdersForSymbol('A.HK', true)).toHaveLength(0);
    expect(f.recorder.getBuyOrdersForSymbol('B.HK', false)).toHaveLength(0);
  });

  it('场景10: 成本不受待成交卖出影响（按全部订单计算）', () => {
    f.commit('BUY-1', 'BUY', '1', '100', 100, 1000);
    f.commit('BUY-2', 'BUY', '1.2', '120', 100, 2000);
    expect(f.recorder.getCostBasis('TEST.HK', true)).toEqual({ costAmount: '220', quantity: 200 });
    f.recorder.submitSellOrder('SELL-1', 'TEST.HK', 'LONG', 100, ['BUY-1'], false, f.now + 3000);
    expect(f.recorder.getCostBasis('TEST.HK', true)).toEqual({ costAmount: '220', quantity: 200 });
  });

  it('场景11: 卖出结算优先按关联买单 ID 精确扣减', () => {
    f.commit('BUY-1', 'BUY', '0.8', '80', 100, 1000);
    f.commit('BUY-2', 'BUY', '0.9', '90', 100, 2000);
    f.commit('BUY-3', 'BUY', '1.2', '120', 100, 3000);
    f.recorder.submitSellOrder(
      'SELL-1',
      'TEST.HK',
      'LONG',
      200,
      ['BUY-1', 'BUY-3'],
      false,
      f.now + 3500,
    );

    expect(
      f.flow.settleOrder({
        orderId: 'SELL-1',
        closedReason: 'FILLED',
        source: 'STATE_CHECK',
        symbol: 'TEST.HK',
        side: 'SELL',
        monitorSymbol: 'HSI.HK',
        isLongSymbol: true,
        isProtectiveLiquidation: false,
        executedPrice: '1.05',
        executedAmount: '210',
        executedQuantity: 200,
        executedTimeMs: f.now + 4000,
        orderUpdatedAtMs: f.now + 4000,
      }),
    ).toEqual({ handled: true, relatedBuyOrderIds: null });

    expect(f.recorder.getBuyOrdersForSymbol('TEST.HK', true).map((order) => order.orderId)).toEqual(
      ['BUY-2'],
    );
    expect(f.recorder.getCostBasis('TEST.HK', true)).toEqual({ costAmount: '90', quantity: 100 });
  });

  it('场景12: 同毫秒 broker 买单保持唯一 identity，避免占用误伤', () => {
    f.commit('BROKER-A', 'BUY', '1', '100', 100, 1000);
    f.commit('BROKER-B', 'BUY', '1.1', '110', 100, 1000);
    const orders = f.recorder.getBuyOrdersForSymbol('TEST.HK', true);
    expect(orders).toHaveLength(2);
    expect(orders[0]?.orderId).not.toBe(orders[1]?.orderId);
    expect(orders.map((o) => o.orderId)).toEqual(['BROKER-A', 'BROKER-B']);
    f.recorder.submitSellOrder('SELL-1', 'TEST.HK', 'LONG', 100, ['BROKER-A'], false, f.now + 2000);
    const sellable = f.recorder.selectSellableOrders({
      symbol: 'TEST.HK',
      direction: 'LONG',
      strategy: 'ALL',
      currentPrice: '1.5',
    });
    expect(sellable.totalQuantity).toBe(100);
    expect(sellable.orders).toHaveLength(1);
    expect(sellable.orders[0]?.orderId).toBe('BROKER-B');
  });
});
