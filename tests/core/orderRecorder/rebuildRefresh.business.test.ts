/**
 * OrderRecorder 重建刷新行为测试
 *
 * 验证终态订单的有效成交事实会在重建时与在线结算写入同一持仓账本，
 * 并确保仍处于 OPEN 的 PartialFilled 卖单不会提前扣减持仓。
 */
import { describe, expect, it } from 'bun:test';
import { OrderSide, OrderStatus, OrderType } from 'longbridge';
import { createOrderRecorder } from '../../../src/core/orderRecorder/index.js';
import { classifyOrdersForRebuild } from '../../../src/core/orderRecorder/utils.js';
import type { OrderRecord, OrderRecorder, RawOrderFromAPI } from '../../../src/types/services.js';
import { createRateLimiterDouble, createTradeContextDouble } from '../../helpers/testDoubles.js';

const BASE_TIME_MS = Date.parse('2026-03-02T01:30:00.000Z');

const unknownSideRefreshCases: ReadonlyArray<{
  readonly label: string;
  readonly status: OrderStatus;
  readonly executedPrice: number;
  readonly executedQuantity: number;
}> = [
  {
    label: 'Filled with positive execution',
    status: OrderStatus.Filled,
    executedPrice: 1,
    executedQuantity: 100,
  },
  {
    label: 'PartialWithdrawal with positive execution',
    status: OrderStatus.PartialWithdrawal,
    executedPrice: 1,
    executedQuantity: 100,
  },
  {
    label: 'PartialFilled with positive execution',
    status: OrderStatus.PartialFilled,
    executedPrice: 1,
    executedQuantity: 100,
  },
  {
    label: 'PartialFilled with zero execution',
    status: OrderStatus.PartialFilled,
    executedPrice: 0,
    executedQuantity: 0,
  },
];

function createRecorder(): OrderRecorder {
  return createOrderRecorder({
    // refreshOrdersFromAllOrders 直接消费已提供的快照，不会调用 SDK。
    ctx: createTradeContextDouble(),
    rateLimiter: createRateLimiterDouble(),
  });
}

function createRawOrder(params: {
  readonly orderId: string;
  readonly symbol: string;
  readonly side: OrderSide;
  readonly status: OrderStatus;
  readonly submittedQuantity: number;
  readonly executedPrice: number;
  readonly executedQuantity: number;
  readonly executedTimeOffsetSeconds: number;
}): RawOrderFromAPI {
  const executedAt = new Date(BASE_TIME_MS + params.executedTimeOffsetSeconds * 1000);

  return {
    orderId: params.orderId,
    symbol: params.symbol,
    stockName: params.symbol,
    side: params.side,
    status: params.status,
    orderType: OrderType.ELO,
    price: 1,
    quantity: params.submittedQuantity,
    executedPrice: params.executedPrice,
    executedQuantity: params.executedQuantity,
    submittedAt: executedAt,
    updatedAt: executedAt,
  };
}

function createRebuildSnapshot(params: {
  readonly prefix: string;
  readonly symbol: string;
  readonly settledBuyStatus: OrderStatus;
  readonly settledSellStatus: OrderStatus;
  readonly retainedBuyStatus: OrderStatus;
}): ReadonlyArray<RawOrderFromAPI> {
  const { prefix, symbol, settledBuyStatus, settledSellStatus, retainedBuyStatus } = params;

  return [
    createRawOrder({
      orderId: `${prefix}-BUY-SETTLED`,
      symbol,
      side: OrderSide.Buy,
      status: settledBuyStatus,
      submittedQuantity: 100,
      executedPrice: 1,
      executedQuantity: 40,
      executedTimeOffsetSeconds: 1,
    }),
    createRawOrder({
      orderId: `${prefix}-SELL-SETTLED`,
      symbol,
      side: OrderSide.Sell,
      status: settledSellStatus,
      submittedQuantity: 100,
      executedPrice: 1.1,
      executedQuantity: 40,
      executedTimeOffsetSeconds: 2,
    }),
    createRawOrder({
      orderId: `${prefix}-BUY-RETAINED`,
      symbol,
      side: OrderSide.Buy,
      status: retainedBuyStatus,
      submittedQuantity: 100,
      executedPrice: 1.2,
      executedQuantity: 40,
      executedTimeOffsetSeconds: 3,
    }),
    createRawOrder({
      orderId: `${prefix}-SELL-OPEN-PARTIAL`,
      symbol,
      side: OrderSide.Sell,
      status: OrderStatus.PartialFilled,
      submittedQuantity: 200,
      executedPrice: 1.3,
      executedQuantity: 100,
      executedTimeOffsetSeconds: 4,
    }),
  ];
}

function applyOnlineSettlement(
  recorder: OrderRecorder,
  symbol: string,
  isLongSymbol: boolean,
): void {
  recorder.recordLocalBuy(symbol, 1, 40, isLongSymbol, BASE_TIME_MS + 1000);
  recorder.recordLocalSell(symbol, 1.1, 40, isLongSymbol, BASE_TIME_MS + 2000);
  recorder.recordLocalBuy(symbol, 1.2, 40, isLongSymbol, BASE_TIME_MS + 3000);
}

function summarizeOrders(orders: ReadonlyArray<OrderRecord>): ReadonlyArray<{
  readonly executedPrice: number;
  readonly executedQuantity: number;
  readonly executedTime: number;
}> {
  return orders.map((order) => ({
    executedPrice: order.executedPrice,
    executedQuantity: order.executedQuantity,
    executedTime: order.executedTime,
  }));
}

describe('OrderRecorder rebuild refresh', () => {
  it('rebuilds terminal partial executions like online settlement and keeps OPEN partial sells pending', async () => {
    const rebuiltRecorder = createRecorder();
    const onlineSettlementRecorder = createRecorder();
    const longSymbol = 'BULL.HK';
    const shortSymbol = 'BEAR.HK';
    const longSnapshot = createRebuildSnapshot({
      prefix: 'LONG',
      symbol: longSymbol,
      settledBuyStatus: OrderStatus.PartialWithdrawal,
      settledSellStatus: OrderStatus.Canceled,
      retainedBuyStatus: OrderStatus.Canceled,
    });
    const shortSnapshot = createRebuildSnapshot({
      prefix: 'SHORT',
      symbol: shortSymbol,
      settledBuyStatus: OrderStatus.Canceled,
      settledSellStatus: OrderStatus.PartialWithdrawal,
      retainedBuyStatus: OrderStatus.PartialWithdrawal,
    });

    await rebuiltRecorder.refreshOrdersFromAllOrdersForLong(longSymbol, longSnapshot);
    await rebuiltRecorder.refreshOrdersFromAllOrdersForShort(shortSymbol, shortSnapshot);
    applyOnlineSettlement(onlineSettlementRecorder, longSymbol, true);
    applyOnlineSettlement(onlineSettlementRecorder, shortSymbol, false);

    const longRebuiltOrders = rebuiltRecorder.getBuyOrdersForSymbol(longSymbol, true);
    const shortRebuiltOrders = rebuiltRecorder.getBuyOrdersForSymbol(shortSymbol, false);

    expect(longRebuiltOrders.map((order) => order.orderId)).toEqual(['LONG-BUY-RETAINED']);
    expect(shortRebuiltOrders.map((order) => order.orderId)).toEqual(['SHORT-BUY-RETAINED']);
    expect(summarizeOrders(longRebuiltOrders)).toEqual(
      summarizeOrders(onlineSettlementRecorder.getBuyOrdersForSymbol(longSymbol, true)),
    );

    expect(summarizeOrders(shortRebuiltOrders)).toEqual(
      summarizeOrders(onlineSettlementRecorder.getBuyOrdersForSymbol(shortSymbol, false)),
    );
    expect(Object.is(rebuiltRecorder.getCostAveragePrice(longSymbol, true), 1.2)).toBeTrue();
    expect(Object.is(rebuiltRecorder.getCostAveragePrice(shortSymbol, false), 1.2)).toBeTrue();

    const classifiedOrders = classifyOrdersForRebuild([...longSnapshot, ...shortSnapshot]);
    expect(
      classifiedOrders.pendingSellOrders.map((order) => ({
        orderId: order.orderId,
        submittedQuantity: order.quantity,
        executedQuantity: order.executedQuantity,
      })),
    ).toEqual([
      {
        orderId: 'LONG-SELL-OPEN-PARTIAL',
        submittedQuantity: 200,
        executedQuantity: 100,
      },
      {
        orderId: 'SHORT-SELL-OPEN-PARTIAL',
        submittedQuantity: 200,
        executedQuantity: 100,
      },
    ]);
  });

  it('rejects a malformed positive execution before refresh replaces existing local records', async () => {
    const recorder = createRecorder();
    const symbol = 'BULL.HK';
    const validSnapshot = [
      createRawOrder({
        orderId: 'VALID-BUY',
        symbol,
        side: OrderSide.Buy,
        status: OrderStatus.Filled,
        submittedQuantity: 100,
        executedPrice: 1,
        executedQuantity: 100,
        executedTimeOffsetSeconds: 1,
      }),
    ];
    const malformedSnapshot = [
      createRawOrder({
        orderId: 'INVALID-BUY',
        symbol,
        side: OrderSide.Buy,
        status: OrderStatus.Filled,
        submittedQuantity: 100,
        executedPrice: 0,
        executedQuantity: 100,
        executedTimeOffsetSeconds: 2,
      }),
    ];

    await recorder.refreshOrdersFromAllOrdersForLong(symbol, validSnapshot);
    const beforeRefresh = summarizeOrders(recorder.getBuyOrdersForSymbol(symbol, true));

    expect(() => recorder.refreshOrdersFromAllOrdersForLong(symbol, malformedSnapshot)).toThrow(
      /执行事实/,
    );

    expect(summarizeOrders(recorder.getBuyOrdersForSymbol(symbol, true))).toEqual(beforeRefresh);
  });

  it('rejects a malformed nonzero Unknown-side execution before refresh clears local records', async () => {
    const recorder = createRecorder();
    const symbol = 'BULL.HK';
    const validSnapshot = [
      createRawOrder({
        orderId: 'VALID-BUY',
        symbol,
        side: OrderSide.Buy,
        status: OrderStatus.Filled,
        submittedQuantity: 100,
        executedPrice: 1,
        executedQuantity: 100,
        executedTimeOffsetSeconds: 1,
      }),
    ];
    const malformedSnapshot = [
      createRawOrder({
        orderId: 'INVALID-UNKNOWN-SIDE',
        symbol,
        side: OrderSide.Unknown,
        status: OrderStatus.Filled,
        submittedQuantity: 100,
        executedPrice: 0,
        executedQuantity: 100,
        executedTimeOffsetSeconds: 2,
      }),
    ];

    await recorder.refreshOrdersFromAllOrdersForLong(symbol, validSnapshot);
    const beforeRefresh = summarizeOrders(recorder.getBuyOrdersForSymbol(symbol, true));
    let refreshError: unknown;

    try {
      await recorder.refreshOrdersFromAllOrdersForLong(symbol, malformedSnapshot);
    } catch (error) {
      refreshError = error;
    }

    const refreshWasBlocked =
      refreshError instanceof Error && refreshError.message.includes('执行事实');

    expect({
      refreshWasBlocked,
      orders: summarizeOrders(recorder.getBuyOrdersForSymbol(symbol, true)),
    }).toEqual({
      refreshWasBlocked: true,
      orders: beforeRefresh,
    });
  });

  for (const unknownSideCase of unknownSideRefreshCases) {
    it(`rejects Unknown-side ${unknownSideCase.label} before refresh clears local records`, async () => {
      const recorder = createRecorder();
      const symbol = 'BULL.HK';
      const validSnapshot = [
        createRawOrder({
          orderId: 'VALID-BUY',
          symbol,
          side: OrderSide.Buy,
          status: OrderStatus.Filled,
          submittedQuantity: 100,
          executedPrice: 1,
          executedQuantity: 100,
          executedTimeOffsetSeconds: 1,
        }),
      ];
      const unknownSideSnapshot = [
        createRawOrder({
          orderId: `UNKNOWN-SIDE-${unknownSideCase.label}`,
          symbol,
          side: OrderSide.Unknown,
          status: unknownSideCase.status,
          submittedQuantity: 100,
          executedPrice: unknownSideCase.executedPrice,
          executedQuantity: unknownSideCase.executedQuantity,
          executedTimeOffsetSeconds: 2,
        }),
      ];

      await recorder.refreshOrdersFromAllOrdersForLong(symbol, validSnapshot);
      const beforeRefresh = summarizeOrders(recorder.getBuyOrdersForSymbol(symbol, true));
      let refreshError: unknown;

      try {
        await recorder.refreshOrdersFromAllOrdersForLong(symbol, unknownSideSnapshot);
      } catch (error) {
        refreshError = error;
      }

      const refreshWasBlocked =
        refreshError instanceof Error && refreshError.message.includes('订单方向不可归属');

      expect({
        refreshWasBlocked,
        orders: summarizeOrders(recorder.getBuyOrdersForSymbol(symbol, true)),
      }).toEqual({
        refreshWasBlocked: true,
        orders: beforeRefresh,
      });
    });
  }

  it('uses the same symbol-scoped classifier failure for preflight and refresh', async () => {
    const recorder = createRecorder();
    const symbol = 'BULL.HK';
    const snapshot = [
      createRawOrder({
        orderId: 'UNKNOWN-PREFLIGHT-TARGET',
        symbol,
        side: OrderSide.Unknown,
        status: OrderStatus.Filled,
        submittedQuantity: 100,
        executedPrice: 1,
        executedQuantity: 100,
        executedTimeOffsetSeconds: 1,
      }),
      createRawOrder({
        orderId: 'VALID-OTHER-SYMBOL',
        symbol: 'OTHER.HK',
        side: OrderSide.Buy,
        status: OrderStatus.Filled,
        submittedQuantity: 100,
        executedPrice: 1,
        executedQuantity: 100,
        executedTimeOffsetSeconds: 2,
      }),
    ];
    let preflightError: unknown;
    let refreshError: unknown;

    try {
      recorder.validateRebuildSnapshot(symbol, snapshot);
    } catch (error) {
      preflightError = error;
    }

    try {
      await recorder.refreshOrdersFromAllOrdersForLong(symbol, snapshot);
    } catch (error) {
      refreshError = error;
    }

    const preflightMessage = preflightError instanceof Error ? preflightError.message : null;
    const refreshMessage = refreshError instanceof Error ? refreshError.message : null;
    expect(preflightMessage).toBe(refreshMessage);
    expect(preflightMessage).toContain('订单方向不可归属');
  });
});
