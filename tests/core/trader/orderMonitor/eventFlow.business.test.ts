/**
 * orderMonitor/eventFlow 业务测试
 *
 * 覆盖：
 * - truth 推进后触发 ORDER_EVENT wakeup
 * - timeoutMarketConversionPending 收到终态后写入 terminal snapshot 并显式唤醒 route
 * - 普通终态结算后若同 symbol route 仍存在，会继续触发 ORDER_EVENT wakeup
 * - 未追踪订单的 closed event 不触发 route wakeup
 */
import { describe, expect, it, mock } from 'bun:test';
import { OrderSide, OrderStatus, OrderType } from 'longbridge';
import { createPushOrderChanged } from '../../../../mock/factories/tradeFactory.js';
import { createEventFlow } from '../../../../src/core/trader/orderMonitor/eventFlow.js';
import { ORDER_MONITOR_WAIT_WS_ONLY_BLOCK_UNTIL_MS } from '../../../../src/constants/index.js';
import type {
  FinalizeOrderSettlementParams,
  OrderMonitorRuntimeStore,
  OrderMonitorTrackedOrder,
} from '../../../../src/core/trader/orderMonitor/types.js';
import { createOrderRecorderDouble } from '../../../helpers/testDoubles.js';

mock.module('../../../../src/utils/logger/index.js', () => ({
  logger: {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  },
}));

function createRuntimeStore(): OrderMonitorRuntimeStore {
  return {
    trackedOrders: new Map<string, OrderMonitorTrackedOrder>(),
    trackedOrderLifecycles: new Map(),
    bootstrappingOrderEvents: new Map(),
    closedOrderIds: new Set(),
    queriedTerminalStateByOrderId: new Map(),
    latestReplaceOutcomeByOrderId: new Map(),
    orderStateChangedListeners: new Set(),
    trackedOrderIdsBySymbol: new Map(),
    routeStatesBySymbol: new Map(),
    latestRouteGenerationBySymbol: new Map(),
    runtimeState: 'ACTIVE',
    running: true,
    unsubscribeQuoteUpdated: null,
  };
}

function createTrackedOrder(params: {
  readonly orderId: string;
  readonly symbol: string;
  readonly side: OrderSide;
  readonly status?: OrderStatus;
  readonly timeoutMarketConversionPending?: boolean;
  readonly isProtectiveLiquidation?: boolean;
}): OrderMonitorTrackedOrder {
  const now = Date.now();
  return {
    orderId: params.orderId,
    symbol: params.symbol,
    side: params.side,
    isLongSymbol: true,
    monitorSymbol: 'HSI.HK',
    isProtectiveLiquidation: params.isProtectiveLiquidation ?? false,
    liquidationTriggerLimit: 1,
    liquidationCooldownConfig: null,
    orderType: OrderType.ELO,
    submittedPrice: 1,
    initialSubmittedPrice: 1,
    submittedQuantity: 100,
    executedQuantity: 0,
    executedPrice: null,
    lastExecutedTimeMs: null,
    lastOrderUpdateAtMs: null,
    status: params.status ?? OrderStatus.New,
    submittedAt: now,
    lastPriceUpdateAt: now,
    convertedToMarket: false,
    nextCancelAttemptAt: now,
    cancelRetryCount: 0,
    replaceCapability: 'SUPPORTED',
    replaceBlockedUntilAt: null,
    quoteRetryAttempts: 0,
    quoteRetryNextAt: null,
    quoteRetryExhausted: false,
    replaceTempBlockedCount: 0,
    replaceResumeMode: 'TIME_BACKOFF',
    timeoutMarketConversionPending: params.timeoutMarketConversionPending ?? false,
    timeoutMarketConversionTerminalState: null,
  };
}

describe('orderMonitor eventFlow', () => {
  it('records a live partial cumulative execution before an equal-quantity terminal revision', () => {
    const runtime = createRuntimeStore();
    const trackedOrder = createTrackedOrder({
      orderId: 'ORDER-LIVE-PARTIAL',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      isProtectiveLiquidation: true,
    });
    runtime.trackedOrders.set(trackedOrder.orderId, trackedOrder);
    const cumulativeExecutions: Array<
      Readonly<{ executedQuantity: number; orderUpdatedAtMs: number }>
    > = [];
    const settlements: FinalizeOrderSettlementParams[] = [];
    const eventFlow = createEventFlow({
      runtime,
      orderRecorder: createOrderRecorderDouble(),
      recordCumulativeExecution: (params) => {
        cumulativeExecutions.push({
          executedQuantity: params.executedQuantity ?? -1,
          orderUpdatedAtMs: params.orderUpdatedAtMs ?? -1,
        });
      },
      settleOrder: (params) => {
        settlements.push(params);
        return { handled: true, relatedBuyOrderIds: null };
      },
      cacheBootstrappingEvent: () => {},
      triggerRoute: () => {},
    });

    eventFlow.handleOrderChangedWhenActive(
      createPushOrderChanged({
        orderId: trackedOrder.orderId,
        symbol: trackedOrder.symbol,
        side: trackedOrder.side,
        status: OrderStatus.PartialFilled,
        executedQuantity: 40,
        executedPrice: 0.9,
        updatedAtMs: 100,
      }),
    );

    eventFlow.handleOrderChangedWhenActive(
      createPushOrderChanged({
        orderId: trackedOrder.orderId,
        symbol: trackedOrder.symbol,
        side: trackedOrder.side,
        status: OrderStatus.Canceled,
        executedQuantity: 40,
        executedPrice: 0.9,
        updatedAtMs: 200,
      }),
    );

    expect(cumulativeExecutions).toEqual([
      { executedQuantity: 40, orderUpdatedAtMs: 100 },
      { executedQuantity: 40, orderUpdatedAtMs: 200 },
    ]);
    expect(settlements).toHaveLength(1);
    expect(settlements[0]).not.toHaveProperty('hasNewExecution');
  });

  it.each([null, 0] as const)(
    'equal-quantity terminal revision preserves the existing valid price when incoming price is %s',
    (incomingPrice) => {
      const runtime = createRuntimeStore();
      const trackedOrder = createTrackedOrder({
        orderId: 'ORDER-EQUAL-QTY-TERMINAL',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
        status: OrderStatus.PartialFilled,
      });
      trackedOrder.executedQuantity = 40;
      trackedOrder.executedPrice = 1;
      trackedOrder.lastExecutedTimeMs = 100;
      trackedOrder.lastOrderUpdateAtMs = 100;
      runtime.trackedOrders.set(trackedOrder.orderId, trackedOrder);
      const settlements: FinalizeOrderSettlementParams[] = [];
      const eventFlow = createEventFlow({
        runtime,
        orderRecorder: createOrderRecorderDouble(),
        recordCumulativeExecution: () => {},
        settleOrder: (params) => {
          settlements.push(params);
          return { handled: true, relatedBuyOrderIds: null };
        },
        cacheBootstrappingEvent: () => {},
        triggerRoute: () => {},
      });

      const terminalEvent = createPushOrderChanged({
        orderId: trackedOrder.orderId,
        symbol: trackedOrder.symbol,
        side: trackedOrder.side,
        status: OrderStatus.Filled,
        executedQuantity: 40,
        executedPrice: 0,
        updatedAtMs: 200,
      });
      Object.assign(terminalEvent, { executedPrice: incomingPrice });
      eventFlow.handleOrderChangedWhenActive(terminalEvent);

      expect(settlements).toEqual([
        {
          orderId: 'ORDER-EQUAL-QTY-TERMINAL',
          closedReason: 'FILLED',
          source: 'WS',
          executedPrice: 1,
          executedQuantity: 40,
          executedTimeMs: 100,
          orderUpdatedAtMs: 200,
        },
      ]);
    },
  );

  it('equal-quantity terminal revision may revise price without advancing execution time', () => {
    const runtime = createRuntimeStore();
    const trackedOrder = createTrackedOrder({
      orderId: 'ORDER-EQUAL-QTY-PRICE-REVISION',
      symbol: 'BULL.HK',
      side: OrderSide.Buy,
      status: OrderStatus.PartialFilled,
    });
    trackedOrder.executedQuantity = 40;
    trackedOrder.executedPrice = 1;
    trackedOrder.lastExecutedTimeMs = 100;
    trackedOrder.lastOrderUpdateAtMs = 100;
    runtime.trackedOrders.set(trackedOrder.orderId, trackedOrder);
    const settlements: FinalizeOrderSettlementParams[] = [];
    const eventFlow = createEventFlow({
      runtime,
      orderRecorder: createOrderRecorderDouble(),
      recordCumulativeExecution: () => {},
      settleOrder: (params) => {
        settlements.push(params);
        return { handled: true, relatedBuyOrderIds: null };
      },
      cacheBootstrappingEvent: () => {},
      triggerRoute: () => {},
    });

    eventFlow.handleOrderChangedWhenActive(
      createPushOrderChanged({
        orderId: trackedOrder.orderId,
        symbol: trackedOrder.symbol,
        side: trackedOrder.side,
        status: OrderStatus.Filled,
        executedQuantity: 40,
        executedPrice: 1.1,
        updatedAtMs: 200,
      }),
    );

    expect(settlements).toMatchObject([
      {
        executedPrice: 1.1,
        executedQuantity: 40,
        executedTimeMs: 100,
        orderUpdatedAtMs: 200,
      },
    ]);
  });

  it.each([null, 0] as const)(
    'quantity-advancing terminal revision rejects invalid incoming price %s before settlement side effects',
    (incomingPrice) => {
      const runtime = createRuntimeStore();
      const trackedOrder = createTrackedOrder({
        orderId: 'ORDER-ADVANCING-QTY-INVALID-PRICE',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.PartialFilled,
        isProtectiveLiquidation: true,
      });
      trackedOrder.executedQuantity = 40;
      trackedOrder.executedPrice = 1;
      trackedOrder.lastExecutedTimeMs = 100;
      trackedOrder.lastOrderUpdateAtMs = 100;
      runtime.trackedOrders.set(trackedOrder.orderId, trackedOrder);
      let cumulativeExecutionCount = 0;
      let settlementCount = 0;
      const eventFlow = createEventFlow({
        runtime,
        orderRecorder: createOrderRecorderDouble(),
        recordCumulativeExecution: () => {
          cumulativeExecutionCount += 1;
        },
        settleOrder: () => {
          settlementCount += 1;
          return { handled: true, relatedBuyOrderIds: null };
        },
        cacheBootstrappingEvent: () => {},
        triggerRoute: () => {},
      });
      const terminalEvent = createPushOrderChanged({
        orderId: trackedOrder.orderId,
        symbol: trackedOrder.symbol,
        side: trackedOrder.side,
        status: OrderStatus.Filled,
        executedQuantity: 100,
        executedPrice: 0,
        updatedAtMs: 200,
      });
      Object.assign(terminalEvent, { executedPrice: incomingPrice });

      expect(() => {
        eventFlow.handleOrderChangedWhenActive(terminalEvent);
      }).toThrow('累计成交数量推进但缺少有效成交价');

      expect(runtime.trackedOrders.get(trackedOrder.orderId)).toMatchObject({
        status: OrderStatus.PartialFilled,
        executedQuantity: 40,
        executedPrice: 1,
        lastExecutedTimeMs: 100,
        lastOrderUpdateAtMs: 100,
      });
      expect(cumulativeExecutionCount).toBe(0);
      expect(settlementCount).toBe(0);
    },
  );

  it.each([
    [OrderStatus.PartialFilled, OrderStatus.New, OrderStatus.PartialFilled],
    [OrderStatus.PendingCancel, OrderStatus.New, OrderStatus.PendingCancel],
    [OrderStatus.PendingReplace, OrderStatus.New, OrderStatus.New],
  ] as const)(
    '同 timestamp、同 quantity 的 OPEN 冲突 %s/%s 与到达顺序无关',
    (leftStatus, rightStatus, expectedStatus) => {
      function resolveStatus(sequence: ReadonlyArray<OrderStatus>): OrderStatus {
        const runtime = createRuntimeStore();
        const trackedOrder = createTrackedOrder({
          orderId: 'ORDER-SAME-TIME-CONFLICT',
          symbol: 'BULL.HK',
          side: OrderSide.Buy,
          status: OrderStatus.New,
        });
        runtime.trackedOrders.set(trackedOrder.orderId, trackedOrder);
        const eventFlow = createEventFlow({
          runtime,
          orderRecorder: createOrderRecorderDouble(),
          recordCumulativeExecution: () => {},
          settleOrder: () => ({ handled: false, relatedBuyOrderIds: null }),
          cacheBootstrappingEvent: () => {},
          triggerRoute: () => {},
        });
        for (const status of sequence) {
          eventFlow.handleOrderChangedWhenActive(
            createPushOrderChanged({
              orderId: trackedOrder.orderId,
              symbol: trackedOrder.symbol,
              side: trackedOrder.side,
              status,
              executedQuantity: 20,
              executedPrice: 1.01,
              updatedAtMs: 200,
            }),
          );
        }

        return trackedOrder.status;
      }

      expect(resolveStatus([leftStatus, rightStatus])).toBe(expectedStatus);
      expect(resolveStatus([rightStatus, leftStatus])).toBe(expectedStatus);
    },
  );

  it('较新 timestamp 的 New 不得否认 PartialFilled 成交状态', () => {
    const runtime = createRuntimeStore();
    const trackedOrder = createTrackedOrder({
      orderId: 'ORDER-NEWER-REGRESSION',
      symbol: 'BULL.HK',
      side: OrderSide.Buy,
      status: OrderStatus.PartialFilled,
    });
    trackedOrder.executedQuantity = 20;
    trackedOrder.lastOrderUpdateAtMs = 100;
    runtime.trackedOrders.set(trackedOrder.orderId, trackedOrder);
    const eventFlow = createEventFlow({
      runtime,
      orderRecorder: createOrderRecorderDouble(),
      recordCumulativeExecution: () => {},
      settleOrder: () => ({ handled: false, relatedBuyOrderIds: null }),
      cacheBootstrappingEvent: () => {},
      triggerRoute: () => {},
    });

    eventFlow.handleOrderChangedWhenActive(
      createPushOrderChanged({
        orderId: trackedOrder.orderId,
        symbol: trackedOrder.symbol,
        side: trackedOrder.side,
        status: OrderStatus.New,
        executedQuantity: trackedOrder.executedQuantity,
        updatedAtMs: 200,
      }),
    );

    expect(trackedOrder.status).toBe(OrderStatus.PartialFilled);
    expect(trackedOrder.lastOrderUpdateAtMs).toBe(100);
  });

  it('权威较新 New 会让 PendingCancel 离开撤单暂态并恢复 retry owner', () => {
    const runtime = createRuntimeStore();
    const trackedOrder = createTrackedOrder({
      orderId: 'ORDER-CANCEL-REOPEN-NEW',
      symbol: 'BULL.HK',
      side: OrderSide.Buy,
      status: OrderStatus.PendingCancel,
    });
    trackedOrder.lastOrderUpdateAtMs = 100;
    trackedOrder.nextCancelAttemptAt = ORDER_MONITOR_WAIT_WS_ONLY_BLOCK_UNTIL_MS;
    trackedOrder.cancelRetryCount = 4;
    runtime.trackedOrders.set(trackedOrder.orderId, trackedOrder);
    const eventFlow = createEventFlow({
      runtime,
      orderRecorder: createOrderRecorderDouble(),
      recordCumulativeExecution: () => {},
      settleOrder: () => ({ handled: false, relatedBuyOrderIds: null }),
      cacheBootstrappingEvent: () => {},
      triggerRoute: () => {},
    });

    eventFlow.handleOrderChangedWhenActive(
      createPushOrderChanged({
        orderId: trackedOrder.orderId,
        symbol: trackedOrder.symbol,
        side: trackedOrder.side,
        status: OrderStatus.New,
        updatedAtMs: 200,
      }),
    );

    expect(trackedOrder.status).toBe(OrderStatus.New);
    expect(trackedOrder.cancelRetryCount).toBe(0);
    expect(trackedOrder.nextCancelAttemptAt).not.toBe(ORDER_MONITOR_WAIT_WS_ONLY_BLOCK_UNTIL_MS);
  });

  it.each([
    [OrderStatus.WaitToCancel, OrderStatus.Replaced, 0],
    [OrderStatus.PendingCancel, OrderStatus.Replaced, 0],
    [OrderStatus.WaitToCancel, OrderStatus.PartialFilled, 20],
    [OrderStatus.PendingCancel, OrderStatus.PartialFilled, 20],
  ] as const)(
    '权威较新 OPEN 允许撤单暂态 %s 退出到 %s',
    (currentStatus, nextStatus, executedQuantity) => {
      const runtime = createRuntimeStore();
      const trackedOrder = createTrackedOrder({
        orderId: 'ORDER-CANCEL-TRANSIENT-EXIT',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
        status: currentStatus,
      });
      trackedOrder.lastOrderUpdateAtMs = 100;
      runtime.trackedOrders.set(trackedOrder.orderId, trackedOrder);
      const eventFlow = createEventFlow({
        runtime,
        orderRecorder: createOrderRecorderDouble(),
        recordCumulativeExecution: () => {},
        settleOrder: () => ({ handled: false, relatedBuyOrderIds: null }),
        cacheBootstrappingEvent: () => {},
        triggerRoute: () => {},
      });

      eventFlow.handleOrderChangedWhenActive(
        createPushOrderChanged({
          orderId: trackedOrder.orderId,
          symbol: trackedOrder.symbol,
          side: trackedOrder.side,
          status: nextStatus,
          executedQuantity,
          ...(executedQuantity > 0 ? { executedPrice: 1 } : {}),
          updatedAtMs: 200,
        }),
      );

      expect(trackedOrder.status).toBe(nextStatus);
      expect(trackedOrder.lastOrderUpdateAtMs).toBe(200);
    },
  );

  it('允许 replace 暂态在较新 timestamp 合法回到 New', () => {
    const runtime = createRuntimeStore();
    const trackedOrder = createTrackedOrder({
      orderId: 'ORDER-REPLACE-REOPEN',
      symbol: 'BULL.HK',
      side: OrderSide.Buy,
      status: OrderStatus.PendingReplace,
    });
    trackedOrder.lastOrderUpdateAtMs = 100;
    runtime.trackedOrders.set(trackedOrder.orderId, trackedOrder);
    const eventFlow = createEventFlow({
      runtime,
      orderRecorder: createOrderRecorderDouble(),
      recordCumulativeExecution: () => {},
      settleOrder: () => ({ handled: false, relatedBuyOrderIds: null }),
      cacheBootstrappingEvent: () => {},
      triggerRoute: () => {},
    });

    eventFlow.handleOrderChangedWhenActive(
      createPushOrderChanged({
        orderId: trackedOrder.orderId,
        symbol: trackedOrder.symbol,
        side: trackedOrder.side,
        status: OrderStatus.New,
        updatedAtMs: 200,
      }),
    );

    expect(trackedOrder.status).toBe(OrderStatus.New);
    expect(trackedOrder.lastOrderUpdateAtMs).toBe(200);
  });

  it('PartialFilled 回退事件携带更大累计成交时仅吸收成交事实并同步 pending-sell', () => {
    const runtime = createRuntimeStore();
    const trackedOrder = createTrackedOrder({
      orderId: 'ORDER-CANCEL-WITH-LATE-FILL',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      status: OrderStatus.PartialFilled,
    });
    trackedOrder.executedQuantity = 20;
    trackedOrder.lastOrderUpdateAtMs = 100;
    runtime.trackedOrders.set(trackedOrder.orderId, trackedOrder);
    const partialFills: number[] = [];
    const eventFlow = createEventFlow({
      runtime,
      orderRecorder: createOrderRecorderDouble({
        markSellPartialFilled: (_orderId, executedQuantity) => {
          partialFills.push(executedQuantity);
          return null;
        },
      }),
      recordCumulativeExecution: () => {},
      settleOrder: () => ({ handled: false, relatedBuyOrderIds: null }),
      cacheBootstrappingEvent: () => {},
      triggerRoute: () => {},
    });

    eventFlow.handleOrderChangedWhenActive(
      createPushOrderChanged({
        orderId: trackedOrder.orderId,
        symbol: trackedOrder.symbol,
        side: trackedOrder.side,
        status: OrderStatus.New,
        executedQuantity: 50,
        executedPrice: 1.02,
        updatedAtMs: 200,
      }),
    );

    expect(trackedOrder.status).toBe(OrderStatus.PartialFilled);
    expect(trackedOrder.executedQuantity).toBe(50);
    expect(trackedOrder.lastOrderUpdateAtMs).toBe(200);
    expect(partialFills).toEqual([50]);
  });

  it('ACTIVE 中较旧 WS 事件不能降低累计成交量或 pending-sell 成交事实', () => {
    const runtime = createRuntimeStore();
    const trackedOrder = createTrackedOrder({
      orderId: 'ORDER-OUT-OF-ORDER-1',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      status: OrderStatus.New,
    });
    runtime.trackedOrders.set(trackedOrder.orderId, trackedOrder);
    const partialFills: number[] = [];
    const eventFlow = createEventFlow({
      runtime,
      orderRecorder: createOrderRecorderDouble({
        markSellPartialFilled: (_orderId, executedQuantity) => {
          partialFills.push(executedQuantity);
          return null;
        },
      }),
      recordCumulativeExecution: () => {},
      settleOrder: () => ({ handled: false, relatedBuyOrderIds: null }),
      cacheBootstrappingEvent: () => {},
      triggerRoute: () => {},
    });

    eventFlow.handleOrderChangedWhenActive(
      createPushOrderChanged({
        orderId: trackedOrder.orderId,
        symbol: trackedOrder.symbol,
        side: trackedOrder.side,
        status: OrderStatus.PartialFilled,
        executedQuantity: 50,
        executedPrice: 1.01,
        updatedAtMs: 200,
      }),
    );

    eventFlow.handleOrderChangedWhenActive(
      createPushOrderChanged({
        orderId: trackedOrder.orderId,
        symbol: trackedOrder.symbol,
        side: trackedOrder.side,
        status: OrderStatus.PartialFilled,
        executedQuantity: 20,
        executedPrice: 1,
        updatedAtMs: 100,
      }),
    );

    expect(trackedOrder.status).toBe(OrderStatus.PartialFilled);
    expect(trackedOrder.executedQuantity).toBe(50);
    expect(trackedOrder.executedPrice).toBe(1.01);
    expect(trackedOrder.lastExecutedTimeMs).toBe(200);
    expect(partialFills).toEqual([50]);
  });

  it('相同 timestamp 选择累计成交量更大的事实且重复事件幂等', () => {
    const runtime = createRuntimeStore();
    const trackedOrder = createTrackedOrder({
      orderId: 'ORDER-SAME-TIME-1',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      status: OrderStatus.New,
    });
    runtime.trackedOrders.set(trackedOrder.orderId, trackedOrder);
    const partialFills: number[] = [];
    const eventFlow = createEventFlow({
      runtime,
      orderRecorder: createOrderRecorderDouble({
        markSellPartialFilled: (_orderId, executedQuantity) => {
          partialFills.push(executedQuantity);
          return null;
        },
      }),
      recordCumulativeExecution: () => {},
      settleOrder: () => ({ handled: false, relatedBuyOrderIds: null }),
      cacheBootstrappingEvent: () => {},
      triggerRoute: () => {},
    });
    const strongerEvent = createPushOrderChanged({
      orderId: trackedOrder.orderId,
      symbol: trackedOrder.symbol,
      side: trackedOrder.side,
      status: OrderStatus.PartialFilled,
      executedQuantity: 30,
      executedPrice: 1.02,
      updatedAtMs: 200,
    });

    eventFlow.handleOrderChangedWhenActive(strongerEvent);
    eventFlow.handleOrderChangedWhenActive(strongerEvent);
    eventFlow.handleOrderChangedWhenActive(
      createPushOrderChanged({
        orderId: trackedOrder.orderId,
        symbol: trackedOrder.symbol,
        side: trackedOrder.side,
        status: OrderStatus.New,
        executedQuantity: 0,
        executedPrice: 0,
        updatedAtMs: 200,
      }),
    );

    expect(trackedOrder.status).toBe(OrderStatus.PartialFilled);
    expect(trackedOrder.executedQuantity).toBe(30);
    expect(partialFills).toEqual([30]);
  });

  it('timeout 等待链路一旦收到终态就不能被后续 OPEN 事件回退', () => {
    const runtime = createRuntimeStore();
    const trackedOrder = createTrackedOrder({
      orderId: 'ORDER-TERMINAL-NO-REOPEN-1',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      timeoutMarketConversionPending: true,
    });
    runtime.trackedOrders.set(trackedOrder.orderId, trackedOrder);
    const eventFlow = createEventFlow({
      runtime,
      orderRecorder: createOrderRecorderDouble(),
      recordCumulativeExecution: () => {},
      settleOrder: () => ({ handled: false, relatedBuyOrderIds: null }),
      cacheBootstrappingEvent: () => {},
      triggerRoute: () => {},
    });

    eventFlow.handleOrderChangedWhenActive(
      createPushOrderChanged({
        orderId: trackedOrder.orderId,
        symbol: trackedOrder.symbol,
        side: trackedOrder.side,
        status: OrderStatus.Canceled,
        updatedAtMs: 200,
      }),
    );

    eventFlow.handleOrderChangedWhenActive(
      createPushOrderChanged({
        orderId: trackedOrder.orderId,
        symbol: trackedOrder.symbol,
        side: trackedOrder.side,
        status: OrderStatus.New,
        updatedAtMs: 300,
      }),
    );

    expect(trackedOrder.status).toBe(OrderStatus.Canceled);
    expect(trackedOrder.timeoutMarketConversionTerminalState?.closedReason).toBe('CANCELED');
  });

  it('STOPPED 阶段收到订单 WS 时会直接忽略，不缓存也不推进 truth', () => {
    const runtime = createRuntimeStore();
    runtime.runtimeState = 'STOPPED';
    runtime.trackedOrders.set(
      'ORDER-STOPPED-IGNORED-1',
      createTrackedOrder({
        orderId: 'ORDER-STOPPED-IGNORED-1',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
      }),
    );
    let cacheCalls = 0;
    let settlementCalls = 0;
    const routeWakeups: Array<{ readonly symbol: string; readonly kind: string }> = [];
    const eventFlow = createEventFlow({
      runtime,
      orderRecorder: createOrderRecorderDouble(),
      recordCumulativeExecution: () => {},
      settleOrder: () => {
        settlementCalls += 1;
        return { handled: false, relatedBuyOrderIds: null };
      },
      cacheBootstrappingEvent: () => {
        cacheCalls += 1;
      },
      triggerRoute: (symbol: string, kind: string) => {
        routeWakeups.push({ symbol, kind });
      },
    });

    eventFlow.handleOrderChanged(
      createPushOrderChanged({
        orderId: 'ORDER-STOPPED-IGNORED-1',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
        status: OrderStatus.Filled,
      }),
    );

    expect(cacheCalls).toBe(0);
    expect(settlementCalls).toBe(0);
    expect(routeWakeups).toEqual([]);
    expect(runtime.trackedOrders.get('ORDER-STOPPED-IGNORED-1')?.status).toBe(OrderStatus.New);
  });

  it('在 truth 推进后触发 tracked order symbol 的 ORDER_EVENT wakeup', () => {
    const runtime = createRuntimeStore();
    runtime.trackedOrders.set(
      'ORDER-WS-1',
      createTrackedOrder({
        orderId: 'ORDER-WS-1',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
      }),
    );
    const routeWakeups: Array<{ readonly symbol: string; readonly kind: string }> = [];
    const eventFlow = createEventFlow({
      runtime,
      orderRecorder: createOrderRecorderDouble(),
      recordCumulativeExecution: () => {},
      settleOrder: () => ({ handled: false, relatedBuyOrderIds: null }),
      cacheBootstrappingEvent: () => {},
      triggerRoute: (symbol: string, kind: string) => {
        routeWakeups.push({ symbol, kind });
      },
    });

    eventFlow.handleOrderChangedWhenActive(
      createPushOrderChanged({
        orderId: 'ORDER-WS-1',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
        status: OrderStatus.PendingCancel,
      }),
    );

    expect(routeWakeups).toEqual([
      {
        symbol: 'BULL.HK',
        kind: 'ORDER_EVENT',
      },
    ]);
  });

  it('卖单 timeoutMarketConversionPending 收到终态后写入 terminal snapshot 并显式唤醒 route', () => {
    const runtime = createRuntimeStore();
    runtime.trackedOrders.set(
      'ORDER-SELL-TIMEOUT-1',
      createTrackedOrder({
        orderId: 'ORDER-SELL-TIMEOUT-1',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        timeoutMarketConversionPending: true,
      }),
    );
    const routeWakeups: Array<{ readonly symbol: string; readonly kind: string }> = [];
    const eventFlow = createEventFlow({
      runtime,
      orderRecorder: createOrderRecorderDouble(),
      recordCumulativeExecution: () => {},
      settleOrder: () => ({ handled: false, relatedBuyOrderIds: null }),
      cacheBootstrappingEvent: () => {},
      triggerRoute: (symbol: string, kind: string) => {
        routeWakeups.push({ symbol, kind });
      },
    });

    eventFlow.handleOrderChangedWhenActive(
      createPushOrderChanged({
        orderId: 'ORDER-SELL-TIMEOUT-1',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.Canceled,
        executedPrice: 1.02,
        executedQuantity: 0,
      }),
    );

    expect(
      runtime.trackedOrders.get('ORDER-SELL-TIMEOUT-1')?.timeoutMarketConversionTerminalState,
    ).toMatchObject({
      closedReason: 'CANCELED',
      source: 'WS',
    });

    expect(routeWakeups).toEqual([
      {
        symbol: 'BULL.HK',
        kind: 'ORDER_EVENT',
      },
    ]);
  });

  it('tracked order 收到普通终态且 route 已空时不再触发 ORDER_EVENT wakeup', () => {
    const runtime = createRuntimeStore();
    runtime.trackedOrders.set(
      'ORDER-TERMINAL-1',
      createTrackedOrder({
        orderId: 'ORDER-TERMINAL-1',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
      }),
    );
    const routeWakeups: Array<{ readonly symbol: string; readonly kind: string }> = [];
    const settlementPayloads: Array<{
      readonly orderId: string;
      readonly closedReason: string;
      readonly source: string;
    }> = [];
    const eventFlow = createEventFlow({
      runtime,
      orderRecorder: createOrderRecorderDouble(),
      recordCumulativeExecution: () => {},
      settleOrder: (params) => {
        settlementPayloads.push({
          orderId: params.orderId,
          closedReason: params.closedReason,
          source: params.source,
        });
        runtime.trackedOrders.delete(params.orderId);
        runtime.trackedOrderLifecycles.set(params.orderId, 'CLOSED');
        runtime.trackedOrderIdsBySymbol.delete('BULL.HK');
        runtime.routeStatesBySymbol.delete('BULL.HK');
        return { handled: true, relatedBuyOrderIds: null };
      },
      cacheBootstrappingEvent: () => {},
      triggerRoute: (symbol: string, kind: string) => {
        routeWakeups.push({ symbol, kind });
      },
    });

    eventFlow.handleOrderChangedWhenActive(
      createPushOrderChanged({
        orderId: 'ORDER-TERMINAL-1',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
        status: OrderStatus.Filled,
        executedPrice: 1.05,
        executedQuantity: 100,
      }),
    );

    expect(settlementPayloads).toEqual([
      {
        orderId: 'ORDER-TERMINAL-1',
        closedReason: 'FILLED',
        source: 'WS',
      },
    ]);
    expect(routeWakeups).toEqual([]);
  });

  it('tracked order 收到普通终态后若 route 仍存在会继续触发 ORDER_EVENT wakeup', () => {
    const runtime = createRuntimeStore();
    runtime.trackedOrders.set(
      'ORDER-TERMINAL-A',
      createTrackedOrder({
        orderId: 'ORDER-TERMINAL-A',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
      }),
    );

    runtime.trackedOrders.set(
      'ORDER-TERMINAL-B',
      createTrackedOrder({
        orderId: 'ORDER-TERMINAL-B',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
      }),
    );

    runtime.trackedOrderIdsBySymbol.set(
      'BULL.HK',
      new Set(['ORDER-TERMINAL-A', 'ORDER-TERMINAL-B']),
    );

    runtime.routeStatesBySymbol.set('BULL.HK', {
      symbol: 'BULL.HK',
      generation: 1,
      inFlight: false,
      dirty: false,
      latestQuote: null,
      pendingWakeupKind: null,
      timerHandles: new Map(),
    });
    const routeWakeups: Array<{ readonly symbol: string; readonly kind: string }> = [];
    const eventFlow = createEventFlow({
      runtime,
      orderRecorder: createOrderRecorderDouble(),
      recordCumulativeExecution: () => {},
      settleOrder: (params) => {
        runtime.trackedOrders.delete(params.orderId);
        runtime.trackedOrderLifecycles.set(params.orderId, 'CLOSED');
        const bucket = runtime.trackedOrderIdsBySymbol.get('BULL.HK');
        if (bucket) {
          bucket.delete(params.orderId);
          if (bucket.size === 0) {
            runtime.trackedOrderIdsBySymbol.delete('BULL.HK');
            runtime.routeStatesBySymbol.delete('BULL.HK');
          }
        }

        return { handled: true, relatedBuyOrderIds: null };
      },
      cacheBootstrappingEvent: () => {},
      triggerRoute: (symbol: string, kind: string) => {
        routeWakeups.push({ symbol, kind });
      },
    });

    eventFlow.handleOrderChangedWhenActive(
      createPushOrderChanged({
        orderId: 'ORDER-TERMINAL-A',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
        status: OrderStatus.Filled,
        executedPrice: 1.05,
        executedQuantity: 100,
      }),
    );

    expect(routeWakeups).toEqual([
      {
        symbol: 'BULL.HK',
        kind: 'ORDER_EVENT',
      },
    ]);
  });

  it('未追踪订单的 closed event 不触发 route wakeup', () => {
    const runtime = createRuntimeStore();
    const routeWakeups: Array<{ readonly symbol: string; readonly kind: string }> = [];
    const eventFlow = createEventFlow({
      runtime,
      orderRecorder: createOrderRecorderDouble(),
      recordCumulativeExecution: () => {},
      settleOrder: () => ({ handled: false, relatedBuyOrderIds: null }),
      cacheBootstrappingEvent: () => {},
      triggerRoute: (symbol: string, kind: string) => {
        routeWakeups.push({ symbol, kind });
      },
    });

    eventFlow.handleOrderChangedWhenActive(
      createPushOrderChanged({
        orderId: 'UNTRACKED-CLOSED-1',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
        status: OrderStatus.Filled,
      }),
    );

    expect(routeWakeups).toEqual([]);
  });
});
