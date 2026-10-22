/**
 * tradeContext 契约测试
 *
 * 功能：
 * - 验证 TradeContext Mock 契约与调用行为。
 */
import { describe, expect, it } from 'bun:test';
import assert from 'node:assert/strict';
import { OrderSide, OrderStatus, OrderType, TimeInForceType, TopicType } from 'longbridge';
import { createTradeContextMock } from '../../../../mock/longbridge/tradeContextMock.js';
import { toMockDecimal } from '../../../../mock/longbridge/decimal.js';
import {
  createAccountBalance,
  createOrder,
  createPushOrderChanged,
  createStockPositionsResponse,
} from '../../../../mock/factories/tradeFactory.js';

describe('TradeContext mock contract', () => {
  it('creates ordinary order DTOs with explicit null fields and only multiLeg on pushes', () => {
    const order = createOrder({ orderId: 'FACTORY-001', symbol: '700.HK' });
    const push = createPushOrderChanged({ orderId: order.orderId, symbol: order.symbol });

    expect(order.multiLeg).toBeNull();
    expect(order.delayedUntil).toBeNull();
    expect(push.multiLeg).toBeNull();
    expect(Object.hasOwn(push, 'delayedUntil')).toBe(false);
  });

  it('implements required trade APIs and exposes deterministic state transitions', async () => {
    const tradeCtx = createTradeContextMock();
    tradeCtx.seedTodayOrders([
      createOrder({
        orderId: 'INIT-001',
        symbol: '700.HK',
        side: OrderSide.Buy,
        status: OrderStatus.New,
        orderType: OrderType.ELO,
        quantity: 100,
      }),
    ]);

    tradeCtx.seedHistoryOrders([
      createOrder({
        orderId: 'HIST-001',
        symbol: '700.HK',
        side: OrderSide.Sell,
        status: OrderStatus.Filled,
        orderType: OrderType.ELO,
        quantity: 100,
        executedQuantity: 100,
        executedPrice: 320,
      }),
    ]);
    tradeCtx.seedAccountBalances([createAccountBalance(100000)]);
    tradeCtx.seedStockPositions(
      createStockPositionsResponse({
        symbol: '700.HK',
        quantity: 100,
        availableQuantity: 80,
      }),
    );

    const submitResp = await tradeCtx.submitOrder({
      symbol: '700.HK',
      side: OrderSide.Buy,
      orderType: OrderType.ELO,
      timeInForce: TimeInForceType.Day,
      submittedQuantity: toMockDecimal(100),
      submittedPrice: toMockDecimal(320),
    });

    await tradeCtx.replaceOrder({
      orderId: submitResp.orderId,
      quantity: toMockDecimal(200),
      price: toMockDecimal(319),
    });
    await tradeCtx.cancelOrder(submitResp.orderId);

    const todayOrders = await tradeCtx.todayOrders();
    const historyOrders = await tradeCtx.historyOrders();
    const balances = await tradeCtx.accountBalance('HKD');
    const positions = await tradeCtx.stockPositions(['700.HK']);
    const detail = await tradeCtx.orderDetail(submitResp.orderId);
    const submittedOrder = todayOrders.find((order) => order.orderId === submitResp.orderId);

    assert.ok(submittedOrder);
    expect(submittedOrder.multiLeg).toBeNull();
    expect(submittedOrder.delayedUntil).toBeNull();
    expect(detail.multiLeg).toBeNull();
    expect(detail.delayedUntil).toBeNull();
    expect(historyOrders).toHaveLength(1);
    expect(balances).toHaveLength(1);
    expect(positions.channels[0]?.positions).toHaveLength(1);
  });

  it('converts internal ordinary orders to push DTOs without adding delayedUntil or delivering early', () => {
    const tradeCtx = createTradeContextMock();
    const submittedAt = new Date('2026-02-16T01:00:00.000Z');
    let receivedCount = 0;
    tradeCtx.setOnOrderChanged((_err, event) => {
      receivedCount += 1;
      expect(event.orderId).toBe('INTERNAL-001');
      expect(event.multiLeg).toBeNull();
      expect(Object.hasOwn(event, 'delayedUntil')).toBe(false);
    });

    tradeCtx.emitOrderChanged({
      orderId: 'INTERNAL-001',
      status: OrderStatus.New,
      stockName: '700.HK',
      quantity: toMockDecimal(100),
      executedQuantity: toMockDecimal(0),
      price: toMockDecimal(320),
      executedPrice: toMockDecimal(0),
      submittedAt,
      side: OrderSide.Buy,
      symbol: '700.HK',
      orderType: OrderType.ELO,
      updatedAt: submittedAt,
      multiLeg: null,
      delayedUntil: null,
    });

    expect(receivedCount).toBe(0);
    expect(tradeCtx.flushAllEvents()).toBe(1);
    expect(receivedCount).toBe(1);
  });

  it('supports order changed push callbacks and topic subscription', async () => {
    const tradeCtx = createTradeContextMock();
    const received: string[] = [];

    tradeCtx.setOnOrderChanged((_err, event) => {
      received.push(`${event.orderId}:${String(event.status)}`);
    });

    await tradeCtx.subscribe([TopicType.Private]);
    tradeCtx.emitOrderChanged(
      createPushOrderChanged({
        orderId: 'WS-001',
        symbol: '700.HK',
        status: OrderStatus.PartialFilled,
      }),
      { sequence: 2 },
    );

    tradeCtx.emitOrderChanged(
      createPushOrderChanged({
        orderId: 'WS-001',
        symbol: '700.HK',
        status: OrderStatus.Filled,
      }),
      { sequence: 1 },
    );

    expect(tradeCtx.flushAllEvents()).toBe(2);
    expect(new Set(received)).toEqual(
      new Set([
        `WS-001:${String(OrderStatus.Filled)}`,
        `WS-001:${String(OrderStatus.PartialFilled)}`,
      ]),
    );

    await tradeCtx.unsubscribe([TopicType.Private]);
    expect(tradeCtx.getSubscribedTopics().size).toBe(0);
  });

  it('delivers only due order events at the requested time and flushes remaining events', () => {
    const tradeCtx = createTradeContextMock();
    const received: string[] = [];
    const deliverAtMs = Date.parse('2026-02-16T01:00:00.000Z');

    tradeCtx.setOnOrderChanged((_err, event) => {
      received.push(event.orderId);
    });

    tradeCtx.emitOrderChanged(
      createPushOrderChanged({
        orderId: 'WS-DUE-001',
        symbol: '700.HK',
        status: OrderStatus.PartialFilled,
      }),
      { deliverAtMs },
    );

    expect(tradeCtx.flushEvents(deliverAtMs - 1)).toBe(0);
    expect(received).toEqual([]);
    expect(tradeCtx.flushEvents(deliverAtMs)).toBe(1);
    expect(received).toEqual(['WS-DUE-001']);
    expect(tradeCtx.flushEvents(deliverAtMs)).toBe(0);

    tradeCtx.emitOrderChanged(
      createPushOrderChanged({
        orderId: 'WS-DUE-002',
        symbol: '700.HK',
        status: OrderStatus.Filled,
      }),
      { deliverAtMs: deliverAtMs + 60_000 },
    );

    expect(tradeCtx.flushAllEvents()).toBe(1);
    expect(received).toEqual(['WS-DUE-001', 'WS-DUE-002']);
  });

  it('no longer exposes any execution ledger capability to tests', () => {
    const tradeCtx = createTradeContextMock();
    expect('todayExecutions' in tradeCtx).toBe(false);
    expect('historyExecutions' in tradeCtx).toBe(false);
    expect('allExecutions' in tradeCtx).toBe(false);
    expect('seedTodayExecutions' in tradeCtx).toBe(false);
  });

  it('supports failure injection and call logs for trade APIs', async () => {
    const tradeCtx = createTradeContextMock();
    tradeCtx.setFailureRule('submitOrder', {
      failAtCalls: [1],
      errorMessage: 'submit failed by rule',
    });

    await assert.rejects(
      tradeCtx.submitOrder({
        symbol: '700.HK',
        side: OrderSide.Buy,
        orderType: OrderType.ELO,
        timeInForce: TimeInForceType.Day,
        submittedQuantity: toMockDecimal(100),
        submittedPrice: toMockDecimal(320),
      }),
      /submit failed by rule/,
    );

    const logs = tradeCtx.getCalls('submitOrder');
    expect(logs).toHaveLength(1);
    expect(logs[0]?.error?.message).toContain('submit failed by rule');
  });
});
