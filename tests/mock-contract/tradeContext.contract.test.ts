/**
 * tradeContext 契约测试
 *
 * 功能：
 * - 验证 TradeContext Mock 契约与调用行为。
 */
import { describe, expect, it } from 'bun:test';
import { OrderSide, OrderStatus, OrderType, TimeInForceType, TopicType } from 'longbridge';
import { createTradeContextMock } from '../../mock/longbridge/tradeContextMock.js';
import { toMockDecimal } from '../../mock/longbridge/decimal.js';
import {
  createAccountBalance,
  createOrder,
  createPushOrderChanged,
  createStockPositionsResponse,
} from '../../mock/factories/tradeFactory.js';

function createExecution(params: { readonly tradeId: string; readonly symbol: string }) {
  return {
    orderId: `ORDER-${params.tradeId}`,
    tradeId: params.tradeId,
    symbol: params.symbol,
    tradeDoneAt: new Date('2026-02-16T01:30:00.000Z'),
    quantity: toMockDecimal(100),
    price: toMockDecimal(320),
    toString: () => params.tradeId,
    toJSON: () => ({ tradeId: params.tradeId }),
  };
}

type NestedExecutionProbe = {
  value: number;
};

type CyclicExecutionProbe = {
  value: number;
  self: unknown;
};

function isNestedExecutionProbe(value: unknown): value is NestedExecutionProbe {
  const probe = value as { readonly value?: unknown };
  return (
    typeof value === 'object' &&
    value !== null &&
    'value' in value &&
    typeof probe.value === 'number'
  );
}

function isCyclicExecutionProbe(value: unknown): value is CyclicExecutionProbe {
  return isNestedExecutionProbe(value) && 'self' in value;
}

describe('TradeContext mock contract', () => {
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
    const executions = await tradeCtx.todayExecutions();
    const balances = await tradeCtx.accountBalance('HKD');
    const positions = await tradeCtx.stockPositions(['700.HK']);

    expect(todayOrders.some((order) => order.orderId === submitResp.orderId)).toBe(true);
    expect(historyOrders).toHaveLength(1);
    expect(executions).toHaveLength(0);
    expect(balances).toHaveLength(1);
    expect(positions.channels[0]?.positions).toHaveLength(1);
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

  it('isolates seeded today-execution elements from input and returned mutations', async () => {
    const tradeCtx = createTradeContextMock();
    const nestedMetadataKey = Symbol('nestedMetadata');
    const firstExecution = {
      ...createExecution({ tradeId: 'TRADE-001', symbol: '700.HK' }),
      nested: { value: 1 },
    };
    const secondExecution = createExecution({ tradeId: 'TRADE-002', symbol: '3690.HK' });
    Object.defineProperty(firstExecution, nestedMetadataKey, {
      configurable: true,
      enumerable: false,
      value: { value: 1 },
      writable: true,
    });
    const computedProbeGetter = () => firstExecution.nested.value;
    Object.defineProperty(firstExecution, 'computedProbe', {
      configurable: true,
      enumerable: true,
      get: computedProbeGetter,
    });

    expect(await tradeCtx.todayExecutions()).toEqual([]);

    tradeCtx.seedTodayExecutions([firstExecution]);
    firstExecution.symbol = 'INPUT-MUTATED.HK';
    firstExecution.quantity = toMockDecimal(200);
    firstExecution.tradeDoneAt.setTime(Date.parse('2026-02-16T02:00:00.000Z'));
    firstExecution.nested.value = 2;
    const inputMetadata = Object.getOwnPropertyDescriptor(firstExecution, nestedMetadataKey)?.value;
    if (!isNestedExecutionProbe(inputMetadata)) {
      throw new Error('Execution 输入缺少嵌套 symbol metadata');
    }

    inputMetadata.value = 2;

    const firstRead = await tradeCtx.todayExecutions();

    const firstReadExecution = firstRead[0];
    if (!firstReadExecution) {
      throw new Error('todayExecutions 未返回已注入记录');
    }

    expect(firstReadExecution.symbol).toBe('700.HK');
    expect(firstReadExecution.quantity.toNumber()).toBe(100);
    expect(firstReadExecution.tradeDoneAt.toISOString()).toBe('2026-02-16T01:30:00.000Z');
    expect(Object.getPrototypeOf(firstReadExecution)).toBe(Object.getPrototypeOf(firstExecution));
    expect(firstReadExecution.quantity).not.toBe(firstExecution.quantity);
    expect(firstReadExecution.tradeDoneAt).not.toBe(firstExecution.tradeDoneAt);

    const firstReadNested = Reflect.get(firstReadExecution, 'nested');
    const firstReadMetadataDescriptor = Object.getOwnPropertyDescriptor(
      firstReadExecution,
      nestedMetadataKey,
    );
    const firstReadAccessorDescriptor = Object.getOwnPropertyDescriptor(
      firstReadExecution,
      'computedProbe',
    );
    if (
      !isNestedExecutionProbe(firstReadNested) ||
      !isNestedExecutionProbe(firstReadMetadataDescriptor?.value)
    ) {
      throw new Error('Execution 读取缺少嵌套 metadata');
    }

    expect(firstReadNested).not.toBe(firstExecution.nested);
    expect(firstReadNested.value).toBe(1);
    expect(firstReadMetadataDescriptor.enumerable).toBe(false);
    expect(firstReadMetadataDescriptor.value).not.toBe(inputMetadata);
    expect(firstReadMetadataDescriptor.value.value).toBe(1);
    expect(firstReadAccessorDescriptor?.get).toBe(computedProbeGetter);

    Reflect.set(firstReadExecution, 'symbol', 'RETURN-MUTATED.HK');
    Reflect.set(firstReadExecution, 'quantity', toMockDecimal(300));
    firstReadExecution.tradeDoneAt.setTime(Date.parse('2026-02-16T03:00:00.000Z'));
    firstReadNested.value = 3;
    firstReadMetadataDescriptor.value.value = 3;

    const secondRead = await tradeCtx.todayExecutions();
    const secondReadExecution = secondRead[0];
    if (!secondReadExecution) {
      throw new Error('后续 todayExecutions 未返回已注入记录');
    }

    expect(secondReadExecution.symbol).toBe('700.HK');
    expect(secondReadExecution.quantity.toNumber()).toBe(100);
    expect(secondReadExecution.tradeDoneAt.toISOString()).toBe('2026-02-16T01:30:00.000Z');
    const secondReadNested = Reflect.get(secondReadExecution, 'nested');
    const secondReadMetadata = Object.getOwnPropertyDescriptor(
      secondReadExecution,
      nestedMetadataKey,
    )?.value;
    if (!isNestedExecutionProbe(secondReadNested) || !isNestedExecutionProbe(secondReadMetadata)) {
      throw new Error('后续 Execution 读取缺少嵌套 metadata');
    }

    expect(secondReadNested.value).toBe(1);
    expect(secondReadMetadata.value).toBe(1);

    tradeCtx.seedTodayExecutions([secondExecution]);

    expect(secondReadExecution.symbol).toBe('700.HK');
    expect(await tradeCtx.todayExecutions()).toEqual([secondExecution]);
    expect(tradeCtx.getCalls('todayExecutions')).toHaveLength(4);
  });

  it('clones cyclic today-execution extension fields without sharing mutable references', async () => {
    const tradeCtx = createTradeContextMock();
    const cyclicProbe: { value: number; self?: unknown } = { value: 1 };
    cyclicProbe.self = cyclicProbe;
    const execution = {
      ...createExecution({ tradeId: 'TRADE-CYCLE', symbol: '700.HK' }),
      cyclicProbe,
    };

    tradeCtx.seedTodayExecutions([execution]);
    cyclicProbe.value = 2;

    const firstRead = await tradeCtx.todayExecutions();
    const firstReadExecution = firstRead[0];
    if (!firstReadExecution) {
      throw new Error('todayExecutions 未返回循环引用记录');
    }

    const firstReadProbe = Reflect.get(firstReadExecution, 'cyclicProbe');
    if (!isCyclicExecutionProbe(firstReadProbe)) {
      throw new Error('Execution 读取缺少循环引用 probe');
    }

    expect(firstReadProbe.value).toBe(1);
    expect(firstReadProbe.self).toBe(firstReadProbe);
    firstReadProbe.value = 3;

    const secondRead = await tradeCtx.todayExecutions();
    const secondReadExecution = secondRead[0];
    if (!secondReadExecution) {
      throw new Error('后续 todayExecutions 未返回循环引用记录');
    }

    const secondReadProbe = Reflect.get(secondReadExecution, 'cyclicProbe');
    if (!isCyclicExecutionProbe(secondReadProbe)) {
      throw new Error('后续 Execution 读取缺少循环引用 probe');
    }

    expect(secondReadProbe.value).toBe(1);
    expect(secondReadProbe.self).toBe(secondReadProbe);
  });

  it('preserves non-configurable today-execution public field descriptors', async () => {
    const tradeCtx = createTradeContextMock();
    const execution = createExecution({ tradeId: 'TRADE-DESCRIPTOR', symbol: '700.HK' });
    Object.defineProperty(execution, 'symbol', {
      configurable: false,
      enumerable: true,
      value: '700.HK',
      writable: false,
    });

    tradeCtx.seedTodayExecutions([execution]);

    const readExecutions = await tradeCtx.todayExecutions();
    const readExecution = readExecutions[0];
    if (!readExecution) {
      throw new Error('todayExecutions 未返回 descriptor 记录');
    }

    const symbolDescriptor = Object.getOwnPropertyDescriptor(readExecution, 'symbol');
    if (!symbolDescriptor) {
      throw new Error('Execution 读取缺少 symbol descriptor');
    }

    expect(readExecution.symbol).toBe('700.HK');
    expect(symbolDescriptor.configurable).toBe(false);
    expect(symbolDescriptor.writable).toBe(false);
  });

  it('records failed todayExecutions calls through failure injection', async () => {
    const tradeCtx = createTradeContextMock();
    tradeCtx.setFailureRule('todayExecutions', {
      failAtCalls: [1],
      errorMessage: 'today executions failed by rule',
    });

    expect(async () => {
      await tradeCtx.todayExecutions();
    }).toThrow('today executions failed by rule');

    const calls = tradeCtx.getCalls('todayExecutions');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.error?.message).toContain('today executions failed by rule');
  });

  it('supports failure injection and call logs for trade APIs', async () => {
    const tradeCtx = createTradeContextMock();
    tradeCtx.setFailureRule('submitOrder', {
      failAtCalls: [1],
      errorMessage: 'submit failed by rule',
    });

    expect(async () => {
      await tradeCtx.submitOrder({
        symbol: '700.HK',
        side: OrderSide.Buy,
        orderType: OrderType.ELO,
        timeInForce: TimeInForceType.Day,
        submittedQuantity: toMockDecimal(100),
        submittedPrice: toMockDecimal(320),
      });
    }).toThrow('submit failed by rule');

    const logs = tradeCtx.getCalls('submitOrder');
    expect(logs).toHaveLength(1);
    expect(logs[0]?.error?.message).toContain('submit failed by rule');
  });
});
