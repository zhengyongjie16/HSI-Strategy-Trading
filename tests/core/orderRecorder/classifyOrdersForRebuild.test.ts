/**
 * classifyOrdersForRebuild 单元测试
 *
 * 功能：
 * - 验证全量订单分类器在重建阶段的状态分流行为
 * - 确保 Execution/Pending 与 Buy/Sell 四类输出正确
 */
import { describe, expect, it } from 'bun:test';
import { OrderSide, OrderStatus, OrderType } from 'longbridge';
import { PENDING_ORDER_STATUSES } from '../../../src/constants/index.js';
import { classifyOrdersForRebuild } from '../../../src/core/orderRecorder/utils.js';
import type { RawOrderFromAPI } from '../../../src/types/services.js';

function createRawOrder(overrides: Partial<RawOrderFromAPI>): RawOrderFromAPI {
  return {
    orderId: overrides.orderId ?? 'ORDER-1',
    symbol: overrides.symbol ?? 'BULL.HK',
    stockName: overrides.stockName ?? 'HSI RC SAMPLE',
    side: overrides.side ?? OrderSide.Buy,
    status: overrides.status ?? OrderStatus.Filled,
    orderType: overrides.orderType ?? OrderType.ELO,
    price: overrides.price ?? 1,
    quantity: overrides.quantity ?? 100,
    executedPrice: overrides.executedPrice ?? 1,
    executedQuantity: overrides.executedQuantity ?? 100,
    submittedAt: overrides.submittedAt ?? new Date('2026-02-25T03:00:00.000Z'),
    updatedAt: overrides.updatedAt ?? new Date('2026-02-25T03:05:00.000Z'),
  };
}

const executionFactStatuses: ReadonlyArray<{
  readonly label: string;
  readonly status: OrderStatus;
}> = [
  { label: 'Filled', status: OrderStatus.Filled },
  { label: 'PartialWithdrawal', status: OrderStatus.PartialWithdrawal },
  { label: 'PartialFilled', status: OrderStatus.PartialFilled },
];

const invalidExecutionFactCases: ReadonlyArray<{
  readonly label: string;
  readonly overrides: Readonly<Partial<RawOrderFromAPI>>;
}> = [
  { label: 'zero price', overrides: { executedPrice: 0 } },
  { label: 'negative price', overrides: { executedPrice: -1 } },
  { label: 'NaN price', overrides: { executedPrice: Number.NaN } },
  { label: 'infinite price', overrides: { executedPrice: Number.POSITIVE_INFINITY } },
  { label: 'epoch execution time', overrides: { updatedAt: new Date(0) } },
  { label: 'negative execution time', overrides: { updatedAt: new Date(-1) } },
  { label: 'NaN execution time', overrides: { updatedAt: new Date(Number.NaN) } },
  {
    label: 'infinite execution time',
    overrides: { updatedAt: new Date(Number.POSITIVE_INFINITY) },
  },
  { label: 'negative quantity', overrides: { executedQuantity: -1 } },
  { label: 'NaN quantity', overrides: { executedQuantity: Number.NaN } },
  {
    label: 'infinite quantity',
    overrides: { executedQuantity: Number.POSITIVE_INFINITY },
  },
];

describe('classifyOrdersForRebuild', () => {
  it('splits execution records and pending orders into four groups', () => {
    const result = classifyOrdersForRebuild([
      createRawOrder({
        orderId: 'FILLED-BUY',
        side: OrderSide.Buy,
        status: OrderStatus.Filled,
      }),
      createRawOrder({
        orderId: 'FILLED-SELL',
        side: OrderSide.Sell,
        status: OrderStatus.Filled,
      }),
      createRawOrder({
        orderId: 'PENDING-BUY',
        side: OrderSide.Buy,
        status: OrderStatus.New,
        executedPrice: 0,
        executedQuantity: 0,
      }),
      createRawOrder({
        orderId: 'PENDING-SELL',
        side: OrderSide.Sell,
        status: OrderStatus.PartialFilled,
        executedPrice: 1,
        executedQuantity: 10,
      }),
      createRawOrder({
        orderId: 'CANCELLED-BUY',
        side: OrderSide.Buy,
        status: OrderStatus.Canceled,
        executedPrice: 0,
        executedQuantity: 0,
      }),
    ]);

    expect(result.executedBuyOrders.map((order) => order.orderId)).toEqual(['FILLED-BUY']);
    expect(result.executedSellOrders.map((order) => order.orderId)).toEqual(['FILLED-SELL']);
    expect(result.pendingBuyOrders.map((order) => order.orderId)).toEqual(['PENDING-BUY']);
    expect(result.pendingSellOrders.map((order) => order.orderId)).toEqual(['PENDING-SELL']);
  });

  it('fails fast before silently skipping a malformed nonzero Unknown-side execution', () => {
    expect(() =>
      classifyOrdersForRebuild([
        createRawOrder({
          orderId: 'INVALID-UNKNOWN-SIDE-PRICE',
          side: OrderSide.Unknown,
          status: OrderStatus.Filled,
          executedPrice: 0,
          executedQuantity: 100,
        }),
      ]),
    ).toThrow(/执行事实/);
  });

  for (const statusCase of executionFactStatuses) {
    it(`fails fast before silently skipping a valid positive Unknown-side ${statusCase.label} execution`, () => {
      expect(() =>
        classifyOrdersForRebuild([
          createRawOrder({
            orderId: `VALID-POSITIVE-UNKNOWN-SIDE-${statusCase.label}`,
            side: OrderSide.Unknown,
            status: statusCase.status,
            executedPrice: 1,
            executedQuantity: 100,
          }),
        ]),
      ).toThrow(/订单方向不可归属/);
    });
  }

  for (const status of PENDING_ORDER_STATUSES) {
    it(`fails fast when a zero-execution Unknown-side order has OPEN status ${String(status)}`, () => {
      expect(() =>
        classifyOrdersForRebuild([
          createRawOrder({
            orderId: `ZERO-EXECUTION-UNKNOWN-OPEN-${String(status)}`,
            side: OrderSide.Unknown,
            status,
            executedPrice: 0,
            executedQuantity: 0,
          }),
        ]),
      ).toThrow(/订单方向不可归属/);
    });
  }

  it('keeps zero-execution terminal Unknown-side orders non-fatal and unclassified', () => {
    const result = classifyOrdersForRebuild([
      createRawOrder({
        orderId: 'ZERO-EXECUTION-UNKNOWN-FILLED',
        side: OrderSide.Unknown,
        status: OrderStatus.Filled,
        executedPrice: 0,
        executedQuantity: 0,
      }),
      createRawOrder({
        orderId: 'ZERO-EXECUTION-UNKNOWN-PARTIAL-WITHDRAWAL',
        side: OrderSide.Unknown,
        status: OrderStatus.PartialWithdrawal,
        executedPrice: 0,
        executedQuantity: 0,
      }),
    ]);

    expect(result).toEqual({
      executedBuyOrders: [],
      executedSellOrders: [],
      pendingBuyOrders: [],
      pendingSellOrders: [],
    });
  });

  for (const statusCase of executionFactStatuses) {
    for (const invalidExecutionFact of invalidExecutionFactCases) {
      it(`fails fast when ${statusCase.label} has ${invalidExecutionFact.label}`, () => {
        expect(() =>
          classifyOrdersForRebuild([
            createRawOrder({
              orderId: `INVALID-${statusCase.label}-${invalidExecutionFact.label}`,
              side: OrderSide.Buy,
              status: statusCase.status,
              executedPrice: 1,
              executedQuantity: 100,
              ...invalidExecutionFact.overrides,
            }),
          ]),
        ).toThrow(/执行事实/);
      });
    }
  }

  it('separates terminal execution facts from open and zero-execution orders', () => {
    const result = classifyOrdersForRebuild([
      createRawOrder({
        orderId: 'PARTIAL-WITHDRAWAL-BUY',
        side: OrderSide.Buy,
        status: OrderStatus.PartialWithdrawal,
        executedPrice: 1.1,
        executedQuantity: 40,
      }),
      createRawOrder({
        orderId: 'PARTIAL-WITHDRAWAL-SELL',
        side: OrderSide.Sell,
        status: OrderStatus.PartialWithdrawal,
        executedPrice: 1.2,
        executedQuantity: 30,
      }),
      createRawOrder({
        orderId: 'CANCELED-BUY-WITH-EXECUTION',
        side: OrderSide.Buy,
        status: OrderStatus.Canceled,
        executedPrice: 1.3,
        executedQuantity: 20,
      }),
      createRawOrder({
        orderId: 'CANCELED-SELL-WITHOUT-EXECUTION',
        side: OrderSide.Sell,
        status: OrderStatus.Canceled,
        executedPrice: 0,
        executedQuantity: 0,
      }),
      createRawOrder({
        orderId: 'OPEN-PARTIAL-SELL-WITH-EXECUTION',
        side: OrderSide.Sell,
        status: OrderStatus.PartialFilled,
        executedPrice: 1.4,
        executedQuantity: 10,
      }),
    ]);

    expect(result.executedBuyOrders.map((order) => order.orderId)).toEqual([
      'PARTIAL-WITHDRAWAL-BUY',
      'CANCELED-BUY-WITH-EXECUTION',
    ]);

    expect(result.executedSellOrders.map((order) => order.orderId)).toEqual([
      'PARTIAL-WITHDRAWAL-SELL',
    ]);
    expect(result.pendingBuyOrders).toEqual([]);
    expect(result.pendingSellOrders.map((order) => order.orderId)).toEqual([
      'OPEN-PARTIAL-SELL-WITH-EXECUTION',
    ]);
  });

  it('keeps zero-execution New, Canceled, Expired, and PartialFilled orders non-fatal', () => {
    const result = classifyOrdersForRebuild([
      createRawOrder({
        orderId: 'NEW-ZERO-EXECUTION',
        side: OrderSide.Buy,
        status: OrderStatus.New,
        executedPrice: 0,
        executedQuantity: 0,
      }),
      createRawOrder({
        orderId: 'CANCELED-ZERO-EXECUTION',
        side: OrderSide.Buy,
        status: OrderStatus.Canceled,
        executedPrice: 0,
        executedQuantity: 0,
      }),
      createRawOrder({
        orderId: 'EXPIRED-ZERO-EXECUTION',
        side: OrderSide.Sell,
        status: OrderStatus.Expired,
        executedPrice: 0,
        executedQuantity: 0,
      }),
      createRawOrder({
        orderId: 'OPEN-PARTIAL-ZERO-EXECUTION',
        side: OrderSide.Sell,
        status: OrderStatus.PartialFilled,
        executedPrice: 0,
        executedQuantity: 0,
      }),
    ]);

    expect(result.executedBuyOrders).toEqual([]);
    expect(result.executedSellOrders).toEqual([]);
    expect(result.pendingBuyOrders.map((order) => order.orderId)).toEqual(['NEW-ZERO-EXECUTION']);
    expect(result.pendingSellOrders.map((order) => order.orderId)).toEqual([
      'OPEN-PARTIAL-ZERO-EXECUTION',
    ]);
  });
});
