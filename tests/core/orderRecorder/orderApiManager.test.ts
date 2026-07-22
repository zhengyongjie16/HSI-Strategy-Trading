/**
 * orderApiManager 单元测试
 *
 * 功能：
 * - 验证 history/today 去重时的快照优先级（today 优先、同源按 updatedAt 更晚优先）
 * - 验证每次获取都会重新拉取 history/today，不复用旧快照
 */
import { describe, expect, it } from 'bun:test';
import {
  Decimal,
  OrderSide,
  OrderStatus,
  OrderType,
  type Order,
  type TradeContext,
} from 'longbridge';
import { createOrderAPIManager } from '../../../src/core/orderRecorder/orderApiManager.js';
import { createTradeContextMock } from '../../../mock/longbridge/tradeContextMock.js';
import { createRateLimiterDouble, createTradeContextDouble } from '../../helpers/testDoubles.js';

function createSdkOrder(params: {
  readonly orderId: string;
  readonly symbol: string;
  readonly stockName?: string;
  readonly remark?: string;
  readonly side: OrderSide;
  readonly status: OrderStatus;
  readonly submittedAt?: Date;
  readonly updatedAt?: Date | null;
}): Order {
  return {
    orderId: params.orderId,
    symbol: params.symbol,
    stockName: params.stockName ?? 'HSI RC SAMPLE',
    side: params.side,
    status: params.status,
    orderType: OrderType.ELO,
    remark: params.remark ?? '',
    price: new Decimal('1'),
    quantity: new Decimal('100'),
    executedPrice: new Decimal('1'),
    executedQuantity: new Decimal('100'),
    submittedAt: params.submittedAt ?? new Date('2026-02-25T03:00:00.000Z'),
    ...(params.updatedAt === undefined ? {} : { updatedAt: params.updatedAt }),
  } as unknown as Order;
}

const invalidSdkDateCases = [
  {
    label: 'Invalid Date',
    createDate: () => new Date(Number.NaN),
  },
  {
    label: 'epoch timestamp',
    createDate: () => new Date(0),
  },
  {
    label: 'negative timestamp',
    createDate: () => new Date(-1),
  },
] as const;

const optionalUpdatedAtCases = [
  { label: 'null', orderFields: { updatedAt: null } },
  { label: 'omitted', orderFields: {} },
] as const;

function createApiManagerWithSdkOrder(source: 'history' | 'today', order: Order) {
  const tradeCtx = createTradeContextMock();
  if (source === 'history') {
    tradeCtx.seedHistoryOrders([order]);
  } else {
    tradeCtx.seedTodayOrders([order]);
  }

  return createOrderAPIManager({
    ctx: createTradeContextDouble(tradeCtx),
    rateLimiter: createRateLimiterDouble(),
  });
}

function getOrderSnapshotOperation(source: 'history' | 'today'): string {
  if (source === 'history') {
    return 'TradeContext.historyOrders';
  }

  return 'TradeContext.todayOrders';
}

async function assertSdkOrderSnapshotFails(
  apiManager: ReturnType<typeof createOrderAPIManager>,
  source: 'history' | 'today',
): Promise<void> {
  let caught: unknown = null;
  try {
    await apiManager.fetchAllOrdersFromAPI();
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(TypeError);
  if (!(caught instanceof Error)) {
    throw new Error('expected SDK order boundary failure');
  }

  expect(caught.message).toContain(`${getOrderSnapshotOperation(source)} 订单数据结构无效`);
}

describe('createOrderAPIManager', () => {
  it('fetches fresh history and today snapshots on every call', async () => {
    const tradeCtx = createTradeContextMock();
    tradeCtx.seedHistoryOrders([]);
    tradeCtx.seedTodayOrders([
      createSdkOrder({
        orderId: 'ORDER-FRESH-SNAPSHOT',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
        status: OrderStatus.New,
        updatedAt: new Date('2026-02-25T03:01:00.000Z'),
      }),
    ]);
    const apiManager = createOrderAPIManager({
      ctx: createTradeContextDouble(tradeCtx),
      rateLimiter: createRateLimiterDouble(),
    });

    const firstSnapshot = await apiManager.fetchAllOrdersFromAPI();

    tradeCtx.seedTodayOrders([
      createSdkOrder({
        orderId: 'ORDER-FRESH-SNAPSHOT',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
        status: OrderStatus.Filled,
        updatedAt: new Date('2026-02-25T03:05:00.000Z'),
      }),
    ]);
    const secondSnapshot = await apiManager.fetchAllOrdersFromAPI();

    expect(firstSnapshot[0]?.status).toBe(OrderStatus.New);
    expect(secondSnapshot[0]?.status).toBe(OrderStatus.Filled);
    expect(tradeCtx.getCalls('historyOrders')).toHaveLength(2);
    expect(tradeCtx.getCalls('todayOrders')).toHaveLength(2);
  });

  it('prefers today snapshot when history and today share the same orderId', async () => {
    const tradeCtx = createTradeContextMock();
    tradeCtx.seedHistoryOrders([
      createSdkOrder({
        orderId: 'ORDER-1',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
        status: OrderStatus.Filled,
        updatedAt: new Date('2026-02-25T03:10:00.000Z'),
      }),
    ]);

    tradeCtx.seedTodayOrders([
      createSdkOrder({
        orderId: 'ORDER-1',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
        status: OrderStatus.New,
        updatedAt: new Date('2026-02-25T03:01:00.000Z'),
      }),
    ]);

    const apiManager = createOrderAPIManager({
      ctx: createTradeContextDouble(tradeCtx),
      rateLimiter: createRateLimiterDouble(),
    });

    const allOrders = await apiManager.fetchAllOrdersFromAPI();
    expect(allOrders).toHaveLength(1);
    expect(allOrders[0]?.status).toBe(OrderStatus.New);
    expect(allOrders[0]?.updatedAt?.toISOString()).toBe('2026-02-25T03:01:00.000Z');
  });

  it('uses newer updatedAt when duplicates come from the same snapshot source', async () => {
    const tradeCtx = createTradeContextMock();
    tradeCtx.seedHistoryOrders([]);
    tradeCtx.seedTodayOrders([
      createSdkOrder({
        orderId: 'ORDER-2',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.New,
        updatedAt: new Date('2026-02-25T03:01:00.000Z'),
      }),
      createSdkOrder({
        orderId: 'ORDER-2',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.PartialFilled,
        updatedAt: new Date('2026-02-25T03:05:00.000Z'),
      }),
    ]);

    const apiManager = createOrderAPIManager({
      ctx: createTradeContextDouble(tradeCtx),
      rateLimiter: createRateLimiterDouble(),
    });

    const allOrders = await apiManager.fetchAllOrdersFromAPI();
    expect(allOrders).toHaveLength(1);
    expect(allOrders[0]?.status).toBe(OrderStatus.PartialFilled);
    expect(allOrders[0]?.updatedAt?.toISOString()).toBe('2026-02-25T03:05:00.000Z');
  });

  it('preserves SDK submittedAt in the RawOrder snapshot used by recovery gates', async () => {
    const tradeCtx = createTradeContextMock();
    const submittedAt = new Date('2026-02-25T03:00:00.000Z');
    tradeCtx.seedHistoryOrders([]);
    tradeCtx.seedTodayOrders([
      createSdkOrder({
        orderId: 'ORDER-SUBMITTED-AT',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
        status: OrderStatus.Filled,
        submittedAt,
        updatedAt: new Date('2026-02-25T03:05:00.000Z'),
      }),
    ]);

    const apiManager = createOrderAPIManager({
      ctx: createTradeContextDouble(tradeCtx),
      rateLimiter: createRateLimiterDouble(),
    });

    const allOrders = await apiManager.fetchAllOrdersFromAPI();
    expect(allOrders).toHaveLength(1);
    expect(allOrders[0]?.submittedAt).toEqual(submittedAt);
  });

  for (const updatedAtCase of optionalUpdatedAtCases) {
    it(`accepts SDK updatedAt ${updatedAtCase.label} and normalizes the RawOrder value to null`, async () => {
      const tradeCtx = createTradeContextMock();
      const sdkOrder = createSdkOrder({
        orderId: `ORDER-OPTIONAL-UPDATED-AT-${updatedAtCase.label}`,
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.New,
        ...updatedAtCase.orderFields,
      });
      tradeCtx.seedHistoryOrders([]);
      // mock 的深拷贝要求 updatedAt 为 Date；此处直通 SDK 合法的 nullable 原始字段。
      tradeCtx.todayOrders = async () => [sdkOrder];
      const apiManager = createOrderAPIManager({
        ctx: createTradeContextDouble(tradeCtx),
        rateLimiter: createRateLimiterDouble(),
      });

      const allOrders = await apiManager.fetchAllOrdersFromAPI();
      expect(allOrders).toHaveLength(1);
      expect(allOrders[0]?.updatedAt).toBeNull();
    });
  }

  for (const source of ['history', 'today'] as const) {
    for (const invalidDateCase of invalidSdkDateCases) {
      it(`fails fast when ${source} order submittedAt is ${invalidDateCase.label}`, async () => {
        const apiManager = createApiManagerWithSdkOrder(
          source,
          createSdkOrder({
            orderId: `ORDER-BAD-SUBMITTED-AT-${source}-${invalidDateCase.label}`,
            symbol: 'BULL.HK',
            side: OrderSide.Sell,
            status: OrderStatus.New,
            submittedAt: invalidDateCase.createDate(),
            updatedAt: new Date('2026-02-25T03:05:00.000Z'),
          }),
        );

        await assertSdkOrderSnapshotFails(apiManager, source);
      });
    }
  }

  for (const source of ['history', 'today'] as const) {
    for (const invalidDateCase of invalidSdkDateCases) {
      it(`fails fast when ${source} order updatedAt is ${invalidDateCase.label}`, async () => {
        const apiManager = createApiManagerWithSdkOrder(
          source,
          createSdkOrder({
            orderId: `ORDER-BAD-UPDATED-AT-${source}-${invalidDateCase.label}`,
            symbol: 'BULL.HK',
            side: OrderSide.Sell,
            status: OrderStatus.New,
            updatedAt: invalidDateCase.createDate(),
          }),
        );

        await assertSdkOrderSnapshotFails(apiManager, source);
      });
    }
  }

  it('fails fast when historyOrders returns non-array value', async () => {
    const apiManager = createOrderAPIManager({
      ctx: {
        historyOrders: async () => ({ [Symbol.iterator]: function* () {} }),
        todayOrders: async () => [],
      } as unknown as TradeContext,
      rateLimiter: createRateLimiterDouble(),
    });

    let caught: unknown = null;
    try {
      await apiManager.fetchAllOrdersFromAPI();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TypeError);
    expect((caught as Error).message).toContain('TradeContext.historyOrders 返回值不是数组');
  });

  it('fails fast when todayOrders returns non-array value', async () => {
    const apiManager = createOrderAPIManager({
      ctx: {
        historyOrders: async () => [],
        todayOrders: async () => ({ [Symbol.iterator]: function* () {} }),
      } as unknown as TradeContext,
      rateLimiter: createRateLimiterDouble(),
    });

    let caught: unknown = null;
    try {
      await apiManager.fetchAllOrdersFromAPI();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TypeError);
    expect((caught as Error).message).toContain('TradeContext.todayOrders 返回值不是数组');
  });

  it('fails fast when API order misses required fields', async () => {
    const apiManager = createOrderAPIManager({
      ctx: {
        historyOrders: async () => [
          {
            orderId: undefined,
            symbol: 'BULL.HK',
            stockName: 'BULL',
            side: OrderSide.Buy,
            status: OrderStatus.Filled,
            orderType: OrderType.ELO,
            submittedAt: new Date('2026-02-25T03:00:00.000Z'),
          },
        ],
        todayOrders: async () => [],
      } as unknown as TradeContext,
      rateLimiter: createRateLimiterDouble(),
    });

    let caught: unknown = null;
    try {
      await apiManager.fetchAllOrdersFromAPI();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TypeError);
    expect((caught as Error).message).toContain('TradeContext.historyOrders 订单数据结构无效');
  });

  it('fails fast when today API order misses required fields', async () => {
    const apiManager = createOrderAPIManager({
      ctx: {
        historyOrders: async () => [],
        todayOrders: async () => [
          {
            orderId: 'ORDER-TODAY-MISSING',
            symbol: '',
            stockName: 'BULL',
            side: OrderSide.Buy,
            status: OrderStatus.Filled,
            orderType: OrderType.ELO,
            price: new Decimal('1'),
            quantity: new Decimal('100'),
            executedPrice: new Decimal('1'),
            executedQuantity: new Decimal('100'),
            submittedAt: new Date('2026-02-25T03:00:00.000Z'),
          },
        ],
      } as unknown as TradeContext,
      rateLimiter: createRateLimiterDouble(),
    });

    let caught: unknown = null;
    try {
      await apiManager.fetchAllOrdersFromAPI();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TypeError);
    expect((caught as Error).message).toContain('TradeContext.todayOrders 订单数据结构无效');
  });

  it('fails fast when API order contains invalid enum facts', async () => {
    const apiManager = createOrderAPIManager({
      ctx: {
        historyOrders: async () => [
          {
            orderId: 'ORDER-BAD-ENUM',
            symbol: 'BULL.HK',
            stockName: 'BULL',
            side: 999,
            status: OrderStatus.Filled,
            orderType: OrderType.ELO,
            price: new Decimal('1'),
            quantity: new Decimal('100'),
            executedPrice: new Decimal('1'),
            executedQuantity: new Decimal('100'),
            submittedAt: new Date('2026-02-25T03:00:00.000Z'),
          },
        ],
        todayOrders: async () => [],
      } as unknown as TradeContext,
      rateLimiter: createRateLimiterDouble(),
    });

    let caught: unknown = null;
    try {
      await apiManager.fetchAllOrdersFromAPI();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TypeError);
    expect((caught as Error).message).toContain('TradeContext.historyOrders 订单数据结构无效');
  });

  it('fails fast when API order misses quantity fields', async () => {
    const apiManager = createOrderAPIManager({
      ctx: {
        historyOrders: async () => [
          {
            orderId: 'ORDER-MISSING-QUANTITY',
            symbol: 'BULL.HK',
            stockName: 'BULL',
            side: OrderSide.Buy,
            status: OrderStatus.Filled,
            orderType: OrderType.ELO,
            price: new Decimal('1'),
            executedPrice: new Decimal('1'),
            submittedAt: new Date('2026-02-25T03:00:00.000Z'),
          },
        ],
        todayOrders: async () => [],
      } as unknown as TradeContext,
      rateLimiter: createRateLimiterDouble(),
    });

    let caught: unknown = null;
    try {
      await apiManager.fetchAllOrdersFromAPI();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TypeError);
    expect((caught as Error).message).toContain('TradeContext.historyOrders 订单数据结构无效');
  });

  it('fails fast when API order has invalid updatedAt field', async () => {
    const apiManager = createOrderAPIManager({
      ctx: {
        historyOrders: async () => [
          {
            orderId: 'ORDER-BAD-UPDATED',
            symbol: 'BULL.HK',
            stockName: 'BULL',
            side: OrderSide.Buy,
            status: OrderStatus.Filled,
            orderType: OrderType.ELO,
            price: new Decimal('1'),
            quantity: new Decimal('100'),
            executedPrice: new Decimal('1'),
            executedQuantity: new Decimal('100'),
            submittedAt: new Date('2026-02-25T03:00:00.000Z'),
            updatedAt: 'not-a-date',
          },
        ],
        todayOrders: async () => [],
      } as unknown as TradeContext,
      rateLimiter: createRateLimiterDouble(),
    });

    let caught: unknown = null;
    try {
      await apiManager.fetchAllOrdersFromAPI();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TypeError);
    expect((caught as Error).message).toContain('TradeContext.historyOrders 订单数据结构无效');
  });

  it('maps sdk order remark into raw order snapshot', async () => {
    const tradeCtx = createTradeContextMock();
    tradeCtx.seedHistoryOrders([]);
    tradeCtx.seedTodayOrders([
      createSdkOrder({
        orderId: 'ORDER-REMARK',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        status: OrderStatus.New,
        updatedAt: new Date('2026-02-25T03:01:00.000Z'),
        remark: 'QuantDemo|PL',
      }),
    ]);

    const apiManager = createOrderAPIManager({
      ctx: createTradeContextDouble(tradeCtx),
      rateLimiter: createRateLimiterDouble(),
    });

    const allOrders = await apiManager.fetchAllOrdersFromAPI();
    expect(allOrders[0]?.remark).toBe('QuantDemo|PL');
  });
});
