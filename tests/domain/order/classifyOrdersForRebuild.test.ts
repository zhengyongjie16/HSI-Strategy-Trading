/**
 * validateOrdersForRebuild 单元测试
 *
 * 功能：
 * - 验证全量订单重建预检对正成交完整性、方向归属与零成交终态的裁决
 * - 以实际 record 转换（classifyAndConvertOrders）核对合法事实的落地结果
 */

import { describe, expect, it } from 'bun:test';
import {
  OPEN_ORDER_READ_STATUSES,
  isOpenOrderReadStatus,
} from '../../../src/constants/orderReadMetadata.js';
import {
  classifyAndConvertOrders,
  validateOrdersForRebuild,
} from '../../../src/domain/order/orderRecordPolicy.js';
import type { OrderFact } from '../../../src/types/trade.js';

function createRawOrder(
  overrides: Partial<OrderFact> & Readonly<{ unownedDirection?: true }>,
): OrderFact {
  const status = overrides.status ?? 'FILLED';
  let executionStatus: OrderFact['executionStatus'] = 'NONE';
  if (status === 'FILLED') executionStatus = 'FILLED';
  else if ((overrides.executedQuantity ?? 100) > 0) executionStatus = 'PARTIAL';

  const order: OrderFact = {
    orderId: overrides.orderId ?? 'ORDER-1',
    symbol: overrides.symbol ?? 'BULL.HK',
    stockName: overrides.stockName ?? 'HSI RC SAMPLE',
    executionSide: overrides.executionSide ?? 'BUY',
    executionPhase: isOpenOrderReadStatus(status) ? 'OPEN' : 'TERMINAL',
    executionStatus,
    status,
    orderType: overrides.orderType ?? 'ELO',
    price: overrides.price ?? '1',
    quantity: overrides.quantity ?? 100,
    executedPrice: overrides.executedPrice ?? '1',
    executedAmount: overrides.executedAmount ?? '100',
    executionTimeMs: overrides.executionTimeMs ?? Date.parse('2026-02-25T03:05:00.000Z'),
    updatedAtMs: overrides.updatedAtMs ?? Date.parse('2026-02-25T03:05:01.000Z'),
    executedQuantity: overrides.executedQuantity ?? 100,
    submittedAt: overrides.submittedAt ?? new Date('2026-02-25T03:00:00.000Z'),
    updatedAt: overrides.updatedAt ?? new Date('2026-02-25T03:05:01.000Z'),
  };
  // 明确破坏分类器内部观察的方向契约；不是外部SDK Unknown的mapper准入。
  if (overrides.unownedDirection) Reflect.set(order, 'executionSide', 'UNKNOWN');

  return order;
}

const executionFactStatuses: ReadonlyArray<{
  readonly label: string;
  readonly status: OrderFact['status'];
}> = [
  { label: 'Filled', status: 'FILLED' },
  { label: 'PartialWithdrawal', status: 'PARTIALLY_CANCELED' },
  { label: 'PartialFilled', status: 'PARTIALLY_FILLED' },
];

const invalidExecutionFactCases: ReadonlyArray<{
  readonly label: string;
  readonly overrides: Readonly<Partial<OrderFact>>;
}> = [
  { label: 'zero price', overrides: { executedPrice: '0', executedAmount: '0' } },
  { label: 'negative price', overrides: { executedPrice: '-1', executedAmount: '-100' } },
  { label: 'NaN price', overrides: { executedPrice: 'NaN', executedAmount: 'NaN' } },
  { label: 'infinite price', overrides: { executedPrice: 'Infinity', executedAmount: 'Infinity' } },
  { label: 'epoch execution time', overrides: { executionTimeMs: 0 } },
  { label: 'negative execution time', overrides: { executionTimeMs: -1 } },
  { label: 'NaN execution time', overrides: { executionTimeMs: Number.NaN } },
  {
    label: 'infinite execution time',
    overrides: { executionTimeMs: Number.POSITIVE_INFINITY },
  },
  { label: 'negative quantity', overrides: { executedQuantity: -1 } },
  { label: 'NaN quantity', overrides: { executedQuantity: Number.NaN } },
  {
    label: 'infinite quantity',
    overrides: { executedQuantity: Number.POSITIVE_INFINITY },
  },
];

describe('validateOrdersForRebuild', () => {
  it('accepts mixed execution/open orders and converts only positive execution facts to records', () => {
    const orders = [
      createRawOrder({
        orderId: 'FILLED-BUY',
        executionSide: 'BUY',
        status: 'FILLED',
      }),
      createRawOrder({
        orderId: 'FILLED-SELL',
        executionSide: 'SELL',
        status: 'FILLED',
      }),
      createRawOrder({
        orderId: 'PENDING-BUY',
        executionSide: 'BUY',
        status: 'WORKING',
        executedPrice: '0',
        executedAmount: '0',
        executedQuantity: 0,
      }),
      createRawOrder({
        orderId: 'PENDING-SELL',
        executionSide: 'SELL',
        status: 'PARTIALLY_FILLED',
        executedPrice: '1',
        executedAmount: '10',
        executedQuantity: 10,
      }),
      createRawOrder({
        orderId: 'CANCELLED-BUY',
        executionSide: 'BUY',
        status: 'CANCELED',
        executedPrice: '0',
        executedAmount: '0',
        executedQuantity: 0,
      }),
    ];

    expect(() => {
      validateOrdersForRebuild(orders);
    }).not.toThrow();
    const { buyOrders, sellOrders } = classifyAndConvertOrders(orders);
    expect(buyOrders.map((order) => order.orderId)).toEqual(['FILLED-BUY']);
    expect(sellOrders.map((order) => order.orderId)).toEqual(['FILLED-SELL', 'PENDING-SELL']);
    expect(buyOrders[0]).toMatchObject({
      costAmount: '100',
      executedQuantity: 100,
      executedTime: Date.parse('2026-02-25T03:05:00.000Z'),
    });
  });

  it('fails fast before silently skipping a malformed nonzero Unknown-side execution', () => {
    expect(() => {
      validateOrdersForRebuild([
        createRawOrder({
          orderId: 'INVALID-UNKNOWN-SIDE-PRICE',
          unownedDirection: true,
          status: 'FILLED',
          executedPrice: '0',
          executedAmount: '0',
          executedQuantity: 100,
        }),
      ]);
    }).toThrow('[订单记录] 金额、数量或执行时间无效');
  });

  for (const statusCase of executionFactStatuses) {
    it(`fails fast before silently skipping a valid positive Unknown-side ${statusCase.label} execution`, () => {
      expect(() => {
        validateOrdersForRebuild([
          createRawOrder({
            orderId: `VALID-POSITIVE-UNKNOWN-SIDE-${statusCase.label}`,
            unownedDirection: true,
            status: statusCase.status,
            executedPrice: '1',
            executedAmount: '100',
            executedQuantity: 100,
          }),
        ]);
      }).toThrow(/订单方向不可归属/);
    });
  }

  // 后缀仅保留原case标题，不作为方向/状态解码或兼容数据。
  const originalOpenCaseSuffixes = ['1', '2', '3', '4', '6', '7', '8', '9', '10', '11', '12', '13'];
  for (const [index, status] of [...OPEN_ORDER_READ_STATUSES].entries()) {
    it(`fails fast when a zero-execution Unknown-side order has OPEN status ${originalOpenCaseSuffixes[index]}`, () => {
      expect(() => {
        validateOrdersForRebuild([
          createRawOrder({
            orderId: `ZERO-EXECUTION-UNKNOWN-OPEN-${originalOpenCaseSuffixes[index]}`,
            unownedDirection: true,
            status,
            executedPrice: '0',
            executedAmount: '0',
            executedQuantity: 0,
          }),
        ]);
      }).toThrow(/订单方向不可归属/);
    });
  }

  it('keeps zero-execution terminal Unknown-side orders non-fatal and record-free', () => {
    const orders = [
      createRawOrder({
        orderId: 'ZERO-EXECUTION-UNKNOWN-FILLED',
        unownedDirection: true,
        status: 'FILLED',
        executedPrice: '0',
        executedAmount: '0',
        executedQuantity: 0,
      }),
      createRawOrder({
        orderId: 'ZERO-EXECUTION-UNKNOWN-PARTIAL-WITHDRAWAL',
        unownedDirection: true,
        status: 'PARTIALLY_CANCELED',
        executedPrice: '0',
        executedAmount: '0',
        executedQuantity: 0,
      }),
    ];

    expect(() => {
      validateOrdersForRebuild(orders);
    }).not.toThrow();
    expect(classifyAndConvertOrders(orders)).toEqual({ buyOrders: [], sellOrders: [] });
  });

  for (const statusCase of executionFactStatuses) {
    for (const invalidExecutionFact of invalidExecutionFactCases) {
      it(`fails fast when ${statusCase.label} has ${invalidExecutionFact.label}`, () => {
        expect(() => {
          validateOrdersForRebuild([
            createRawOrder({
              orderId: `INVALID-${statusCase.label}-${invalidExecutionFact.label}`,
              executionSide: 'BUY',
              status: statusCase.status,
              executedPrice: '1',
              executedAmount: '100',
              executedQuantity: 100,
              ...invalidExecutionFact.overrides,
            }),
          ]);
        }).toThrow(
          invalidExecutionFact.label === 'NaN price' ||
            invalidExecutionFact.label === 'infinite price'
            ? 'Financial input must be plain decimal text'
            : '[订单记录] 金额、数量或执行时间无效',
        );
      });
    }
  }

  it('converts terminal and open positive executions to records while zero-execution orders produce none', () => {
    const orders = [
      createRawOrder({
        orderId: 'PARTIAL-WITHDRAWAL-BUY',
        executionSide: 'BUY',
        status: 'PARTIALLY_CANCELED',
        executedPrice: '1.1',
        executedAmount: '44',
        executedQuantity: 40,
      }),
      createRawOrder({
        orderId: 'PARTIAL-WITHDRAWAL-SELL',
        executionSide: 'SELL',
        status: 'PARTIALLY_CANCELED',
        executedPrice: '1.2',
        executedAmount: '36',
        executedQuantity: 30,
      }),
      createRawOrder({
        orderId: 'CANCELED-BUY-WITH-EXECUTION',
        executionSide: 'BUY',
        status: 'CANCELED',
        executedPrice: '1.3',
        executedAmount: '26',
        executedQuantity: 20,
      }),
      createRawOrder({
        orderId: 'CANCELED-SELL-WITHOUT-EXECUTION',
        executionSide: 'SELL',
        status: 'CANCELED',
        executedPrice: '0',
        executedAmount: '0',
        executedQuantity: 0,
      }),
      createRawOrder({
        orderId: 'OPEN-PARTIAL-SELL-WITH-EXECUTION',
        executionSide: 'SELL',
        status: 'PARTIALLY_FILLED',
        executedPrice: '1.4',
        executedAmount: '14',
        executedQuantity: 10,
      }),
    ];

    expect(() => {
      validateOrdersForRebuild(orders);
    }).not.toThrow();
    // OPEN partial 卖单在重建发布时仍是 pending，由 recorder 重建回归单独验证。
    const { buyOrders, sellOrders } = classifyAndConvertOrders(orders);
    expect(buyOrders.map((order) => order.orderId)).toEqual([
      'PARTIAL-WITHDRAWAL-BUY',
      'CANCELED-BUY-WITH-EXECUTION',
    ]);

    expect(sellOrders.map((order) => order.orderId)).toEqual([
      'PARTIAL-WITHDRAWAL-SELL',
      'OPEN-PARTIAL-SELL-WITH-EXECUTION',
    ]);
    expect(buyOrders.map((order) => order.costAmount)).toEqual(['44', '26']);
    expect(sellOrders.map((order) => order.costAmount)).toEqual(['36', '14']);
  });

  it('keeps zero-execution New, Canceled, Expired, and PartialFilled orders non-fatal', () => {
    const orders = [
      createRawOrder({
        orderId: 'NEW-ZERO-EXECUTION',
        executionSide: 'BUY',
        status: 'WORKING',
        executedPrice: '0',
        executedAmount: '0',
        executedQuantity: 0,
      }),
      createRawOrder({
        orderId: 'CANCELED-ZERO-EXECUTION',
        executionSide: 'BUY',
        status: 'CANCELED',
        executedPrice: '0',
        executedAmount: '0',
        executedQuantity: 0,
      }),
      createRawOrder({
        orderId: 'EXPIRED-ZERO-EXECUTION',
        executionSide: 'SELL',
        status: 'EXPIRED',
        executedPrice: '0',
        executedAmount: '0',
        executedQuantity: 0,
      }),
      createRawOrder({
        orderId: 'OPEN-PARTIAL-ZERO-EXECUTION',
        executionSide: 'SELL',
        status: 'PARTIALLY_FILLED',
        executedPrice: '0',
        executedAmount: '0',
        executedQuantity: 0,
      }),
    ];

    expect(() => {
      validateOrdersForRebuild(orders);
    }).not.toThrow();
    expect(classifyAndConvertOrders(orders)).toEqual({ buyOrders: [], sellOrders: [] });
  });
});
