/**
 * orderApiManager 单元测试：真实私有SDK快照端口，保history/today优先级与独立T/revision。
 * 非法SDK响应仅在实际native返回阶段发生，domain不持有SDK DTO或枚举。
 */

import { describe, expect, it } from 'bun:test';
import { createRateLimiterDouble } from '../../../helpers/testDoubles.js';
import type { BrokerIngressInput } from '../../../infrastructure/longbridge/trade/brokerIngressFixture.js';
import { createBrokerIngressFixture } from '../../../integration/architectureRefactoringP1Native/trade/brokerIngressFixture.js';

function createSnapshotInput(params: {
  readonly orderId: string;
  readonly symbol: string;
  readonly stockName?: string;
  readonly remark?: string;
  readonly side: BrokerIngressInput['side'];
  readonly status: BrokerIngressInput['status'];
  readonly submittedAt?: Date;
  readonly updatedAt?: Date | null;
}): BrokerIngressInput {
  return {
    orderId: params.orderId,
    symbol: params.symbol,
    stockName: params.stockName ?? 'HSI RC SAMPLE',
    remark: params.remark ?? '',
    side: params.side,
    status: params.status,
    orderType: 'ELO',
    quantity: '100',
    executedQuantity: '100',
    submittedPrice: '1',
    executedPrice: '1',
    submittedAtMs: (params.submittedAt ?? new Date('2026-02-25T03:00:00.000Z')).getTime(),
    updatedAtMs: (params.updatedAt ?? new Date('2026-02-25T03:05:00.000Z')).getTime(),
  };
}

const invalidSdkDateCases = [
  { label: 'Invalid Date', createDate: () => new Date(Number.NaN) },
  { label: 'epoch timestamp', createDate: () => new Date(0) },
  { label: 'negative timestamp', createDate: () => new Date(-1) },
] as const;
const optionalUpdatedAtCases = [
  { label: 'null', mode: 'NULL' },
  { label: 'omitted', mode: 'OMITTED' },
] as const;

async function createApiManagerHarness(
  history: ReadonlyArray<BrokerIngressInput>,
  today: ReadonlyArray<BrokerIngressInput>,
) {
  const fixture = await createBrokerIngressFixture(
    createSnapshotInput({
      orderId: 'NATIVE-BASE',
      symbol: 'BULL.HK',
      side: 'BUY',
      status: 'Filled',
    }),
  );
  fixture.setOrderSnapshotReplies(history, today);

  let throttles = 0;
  const apiManager = fixture.createApiManager({
    rateLimiter: createRateLimiterDouble({
      onThrottle: async () => {
        throttles++;
      },
    }),
  });
  return { fixture, apiManager, throttleCount: () => throttles };
}

async function createApiManagerWithOrder(source: 'history' | 'today', order: BrokerIngressInput) {
  return createApiManagerHarness(
    source === 'history' ? [order] : [],
    source === 'today' ? [order] : [],
  );
}

function getOrderSnapshotOperation(source: 'history' | 'today'): string {
  return source === 'history' ? 'TradeContext.historyOrders' : 'TradeContext.todayOrders';
}

async function assertSdkOrderSnapshotFails(
  actors: Awaited<ReturnType<typeof createApiManagerHarness>>,
  source: 'history' | 'today',
): Promise<void> {
  const caught = await actors.apiManager.fetchAllOrdersFromAPI().catch((error: unknown) => error);
  expect(caught).toBeInstanceOf(TypeError);
  expect(caught).toHaveProperty(
    'message',
    '[订单记录] ' + getOrderSnapshotOperation(source) + ' 订单数据结构无效',
  );

  expect(actors.fixture.orderSnapshotReadCounts()).toEqual({
    history: 1,
    today: source === 'today' ? 1 : 0,
  });
  expect(actors.fixture.nativeMutations()).toEqual([]);
}

describe('createOrderAPIManager', () => {
  it('fetches fresh history and today snapshots on every call', async () => {
    const first = createSnapshotInput({
      orderId: 'ORDER-FRESH-SNAPSHOT',
      symbol: 'BULL.HK',
      side: 'BUY',
      status: 'New',
      updatedAt: new Date('2026-02-25T03:01:00.000Z'),
    });
    const { fixture, apiManager, throttleCount } = await createApiManagerHarness([], [first]);
    const firstSnapshot = await apiManager.fetchAllOrdersFromAPI();
    fixture.setOrderSnapshotReplies(
      [],
      [{ ...first, status: 'Filled', updatedAtMs: Date.parse('2026-02-25T03:05:00.000Z') }],
    );
    const secondSnapshot = await apiManager.fetchAllOrdersFromAPI();
    expect(firstSnapshot[0]?.status).toBe('WORKING');
    expect(secondSnapshot[0]?.status).toBe('FILLED');
    expect(fixture.orderSnapshotReadCounts().history).toBe(2);
    expect(fixture.orderSnapshotReadCounts().today).toBe(2);
    expect(throttleCount()).toBe(4);
    expect(secondSnapshot[0]).toMatchObject({
      executionSide: 'BUY',
      executionPhase: 'TERMINAL',
      executedAmount: '100',
      executedQuantity: 100,
      executionTimeMs: Date.parse('2026-02-25T03:05:00.000Z'),
      updatedAtMs: Date.parse('2026-02-25T03:05:00.000Z'),
    });
    expect(fixture.nativeMutations()).toEqual([]);
  });

  it('prefers today snapshot when history and today share the same orderId', async () => {
    const history = createSnapshotInput({
      orderId: 'ORDER-1',
      symbol: 'BULL.HK',
      side: 'BUY',
      status: 'Filled',
      updatedAt: new Date('2026-02-25T03:10:00.000Z'),
    });
    const today = createSnapshotInput({
      orderId: 'ORDER-1',
      symbol: 'BULL.HK',
      side: 'BUY',
      status: 'New',
      updatedAt: new Date('2026-02-25T03:01:00.000Z'),
    });
    const { apiManager } = await createApiManagerHarness([history], [today]);
    const allOrders = await apiManager.fetchAllOrdersFromAPI();
    expect(allOrders).toHaveLength(1);
    expect(allOrders[0]?.status).toBe('WORKING');
    expect(allOrders[0]?.updatedAt?.toISOString()).toBe('2026-02-25T03:01:00.000Z');
  });

  it('uses newer updatedAt when duplicates come from the same snapshot source', async () => {
    const old = createSnapshotInput({
      orderId: 'ORDER-2',
      symbol: 'BULL.HK',
      side: 'SELL',
      status: 'New',
      updatedAt: new Date('2026-02-25T03:01:00.000Z'),
    });
    const newer = createSnapshotInput({
      orderId: 'ORDER-2',
      symbol: 'BULL.HK',
      side: 'SELL',
      status: 'PartialFilled',
      updatedAt: new Date('2026-02-25T03:05:00.000Z'),
    });
    const { apiManager } = await createApiManagerHarness([], [old, newer]);
    const allOrders = await apiManager.fetchAllOrdersFromAPI();
    expect(allOrders).toHaveLength(1);
    expect(allOrders[0]?.status).toBe('PARTIALLY_FILLED');
    expect(allOrders[0]?.updatedAt?.toISOString()).toBe('2026-02-25T03:05:00.000Z');
  });

  it('preserves SDK submittedAt in the RawOrder snapshot used by recovery gates', async () => {
    const submittedAt = new Date('2026-02-25T03:00:00.000Z');
    const { apiManager } = await createApiManagerHarness(
      [],
      [
        createSnapshotInput({
          orderId: 'ORDER-SUBMITTED-AT',
          symbol: 'BULL.HK',
          side: 'BUY',
          status: 'Filled',
          submittedAt,
          updatedAt: new Date('2026-02-25T03:05:00.000Z'),
        }),
      ],
    );
    const allOrders = await apiManager.fetchAllOrdersFromAPI();
    expect(allOrders).toHaveLength(1);
    expect(allOrders[0]?.submittedAt).toEqual(submittedAt);
  });

  for (const updatedAtCase of optionalUpdatedAtCases) {
    it(`accepts SDK updatedAt ${updatedAtCase.label} and normalizes the RawOrder value to null`, async () => {
      // HEAD该case只断言updatedAt规范化，正执行100来自未被断言的默认frame。
      // 此处显式真实零执行/空ledger；无revision不补执行T，不变更原null字段期望。
      const input = {
        ...createSnapshotInput({
          orderId: 'ORDER-OPTIONAL-UPDATED-AT-' + updatedAtCase.label,
          symbol: 'BULL.HK',
          side: 'SELL',
          status: 'New',
        }),
        executedQuantity: '0',
        executedPrice: '0',
        executionTimeMs: null,
      };
      const { fixture, apiManager } = await createApiManagerHarness([], [input]);
      fixture.setOrderSnapshotUpdatedAtAbsent('today', updatedAtCase.mode);
      const allOrders = await apiManager.fetchAllOrdersFromAPI();
      expect(allOrders).toHaveLength(1);
      expect(allOrders[0]?.updatedAt).toBeNull();
      expect(allOrders[0]).toMatchObject({
        executedQuantity: 0,
        executedAmount: '0',
        executionTimeMs: null,
        executionPhase: 'OPEN',
      });
    });
  }

  for (const updatedAtCase of optionalUpdatedAtCases) {
    it(`rejects positive execution with SDK updatedAt ${updatedAtCase.label} without deriving revision from T`, async () => {
      const { fixture, apiManager } = await createApiManagerHarness(
        [],
        [
          createSnapshotInput({
            orderId: 'ORDER-EXECUTED-MISSING-REV-' + updatedAtCase.label,
            symbol: 'BULL.HK',
            side: 'SELL',
            status: 'Filled',
          }),
        ],
      );
      fixture.setOrderSnapshotUpdatedAtAbsent('today', updatedAtCase.mode);
      const caught = await apiManager.fetchAllOrdersFromAPI().catch((error: unknown) => error);
      expect(caught).toBeInstanceOf(TypeError);
      expect(caught).toHaveProperty(
        'message',
        '[orderMapper] executed order lacks independent broker revision',
      );
      expect(fixture.orderSnapshotReadCounts()).toEqual({ history: 1, today: 1 });
      expect(fixture.nativeMutations()).toEqual([]);
    });
  }

  for (const source of ['history', 'today'] as const) {
    for (const invalidDateCase of invalidSdkDateCases) {
      it(`fails fast when ${source} order submittedAt is ${invalidDateCase.label}`, async () => {
        const actors = await createApiManagerWithOrder(
          source,
          createSnapshotInput({
            orderId: 'ORDER-BAD-SUBMITTED-AT-' + source + '-' + invalidDateCase.label,
            symbol: 'BULL.HK',
            side: 'SELL',
            status: 'New',
            submittedAt: invalidDateCase.createDate(),
            updatedAt: new Date('2026-02-25T03:05:00.000Z'),
          }),
        );
        await assertSdkOrderSnapshotFails(actors, source);
      });
    }
  }

  for (const source of ['history', 'today'] as const) {
    for (const invalidDateCase of invalidSdkDateCases) {
      it(`fails fast when ${source} order updatedAt is ${invalidDateCase.label}`, async () => {
        const actors = await createApiManagerWithOrder(
          source,
          createSnapshotInput({
            orderId: 'ORDER-BAD-UPDATED-AT-' + source + '-' + invalidDateCase.label,
            symbol: 'BULL.HK',
            side: 'SELL',
            status: 'New',
            updatedAt: invalidDateCase.createDate(),
          }),
        );
        await assertSdkOrderSnapshotFails(actors, source);
      });
    }
  }

  for (const source of ['history', 'today'] as const) {
    it(`fails fast when ${source} orderType is Unknown`, async () => {
      const actors = await createApiManagerWithOrder(
        source,
        createSnapshotInput({
          orderId: 'ORDER-UNKNOWN-TYPE-' + source,
          symbol: 'BULL.HK',
          side: 'SELL',
          status: 'New',
        }),
      );
      actors.fixture.setOrderSnapshotOrderTypeUnknown(source);
      await assertSdkOrderSnapshotFails(actors, source);
    });
  }

  it('fails fast when historyOrders returns non-array value', async () => {
    const { fixture, apiManager } = await createApiManagerHarness([], []);
    fixture.setOrderSnapshotNonArray('history');
    const caught = await apiManager.fetchAllOrdersFromAPI().catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(TypeError);
    expect(caught).toHaveProperty(
      'message',
      '[订单记录] TradeContext.historyOrders 返回值不是数组',
    );
    expect(fixture.orderSnapshotReadCounts()).toEqual({ history: 1, today: 0 });
  });

  it('fails fast when todayOrders returns non-array value', async () => {
    const { fixture, apiManager } = await createApiManagerHarness([], []);
    fixture.setOrderSnapshotNonArray('today');
    const caught = await apiManager.fetchAllOrdersFromAPI().catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(TypeError);
    expect(caught).toHaveProperty('message', '[订单记录] TradeContext.todayOrders 返回值不是数组');
    expect(fixture.orderSnapshotReadCounts()).toEqual({ history: 1, today: 1 });
  });

  it('fails fast when API order misses required fields', async () => {
    const actors = await createApiManagerWithOrder(
      'history',
      createSnapshotInput({
        orderId: 'ORDER-MISSING-ID',
        symbol: 'BULL.HK',
        stockName: 'BULL',
        side: 'BUY',
        status: 'Filled',
      }),
    );
    actors.fixture.setOrderSnapshotOrderIdMissing('history');
    await assertSdkOrderSnapshotFails(actors, 'history');
  });

  it('fails fast when today API order misses required fields', async () => {
    const actors = await createApiManagerWithOrder(
      'today',
      createSnapshotInput({
        orderId: 'ORDER-TODAY-MISSING',
        symbol: 'BULL.HK',
        stockName: 'BULL',
        side: 'BUY',
        status: 'Filled',
      }),
    );
    actors.fixture.setOrderSnapshotSymbolEmpty('today');
    await assertSdkOrderSnapshotFails(actors, 'today');
  });

  it('fails fast when API order contains invalid enum facts', async () => {
    const actors = await createApiManagerWithOrder(
      'history',
      createSnapshotInput({
        orderId: 'ORDER-BAD-ENUM',
        symbol: 'BULL.HK',
        stockName: 'BULL',
        side: 'BUY',
        status: 'Filled',
      }),
    );
    actors.fixture.setOrderSnapshotSideInvalid('history');
    await assertSdkOrderSnapshotFails(actors, 'history');
  });

  it('fails fast when API order misses quantity fields', async () => {
    const actors = await createApiManagerWithOrder(
      'history',
      createSnapshotInput({
        orderId: 'ORDER-MISSING-QUANTITY',
        symbol: 'BULL.HK',
        stockName: 'BULL',
        side: 'BUY',
        status: 'Filled',
      }),
    );
    actors.fixture.setOrderSnapshotQuantitiesMissing('history');
    await assertSdkOrderSnapshotFails(actors, 'history');
  });

  it('fails fast when API order has invalid updatedAt field', async () => {
    const actors = await createApiManagerWithOrder(
      'history',
      createSnapshotInput({
        orderId: 'ORDER-BAD-UPDATED',
        symbol: 'BULL.HK',
        stockName: 'BULL',
        side: 'BUY',
        status: 'Filled',
      }),
    );
    actors.fixture.setOrderSnapshotUpdatedAtInvalid('history');
    await assertSdkOrderSnapshotFails(actors, 'history');
  });

  it('maps sdk order remark into raw order snapshot', async () => {
    const { apiManager } = await createApiManagerHarness(
      [],
      [
        createSnapshotInput({
          orderId: 'ORDER-REMARK',
          symbol: 'BULL.HK',
          side: 'SELL',
          status: 'New',
          updatedAt: new Date('2026-02-25T03:01:00.000Z'),
          remark: 'QuantDemo|PL',
        }),
      ],
    );
    const allOrders = await apiManager.fetchAllOrdersFromAPI();
    expect(allOrders[0]?.remark).toBe('QuantDemo|PL');
  });

});
