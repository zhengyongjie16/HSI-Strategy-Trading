/** 快照 adapter 单测：并发原始读取、每 attempt 共享限流、身份/范围/重复检查及 today 整条覆盖后严格映射。 */
import { describe, expect, it } from 'bun:test';
import { createRateLimiter } from '../../../../src/application/orderExecution/rateLimiter.js';
import type { OrderFact } from '../../../../src/types/trade.js';
import { createLoggerDouble, createRateLimiterDouble } from '../../../helpers/testDoubles.js';
import {
  createOrderSnapshotReadFixture,
  createOrderSnapshotTimerHarness,
  createSnapshotInput,
  flushSnapshotMicrotasks,
} from './orderSnapshotReadFixture.js';

describe('OrderSnapshotReadAdapter', () => {
  it('唯一 fetchAllOrders 每次重新读取，保留精确金融文本和独立提交/修订时间', async () => {
    let throttles = 0;
    const first = createSnapshotInput({ status: 'New', executedQuantity: '0' });
    const { native, port } = await createOrderSnapshotReadFixture(
      [],
      [first],
      createRateLimiterDouble({
        onThrottle: () => {
          throttles += 1;
        },
      }),
    );
    expect(Object.keys(port)).toEqual(['fetchAllOrders']);
    const initial = await port.fetchAllOrders();
    native.setOrderSnapshotReplies([], [createSnapshotInput()]);
    const latest = await port.fetchAllOrders();
    expect(initial[0]?.status).toBe('WORKING');
    expect(latest[0]).toMatchObject({
      orderId: 'ORDER',
      status: 'FILLED',
      executionPhase: 'TERMINAL',
      executionSide: 'BUY',
      price: '1.000000000000000001',
      executedPrice: '1.2345678901234567890123456789',
      executedAmount: '123.45678901234567890123456789',
      executedQuantity: 100,
      submittedAt: new Date(1000),
      updatedAt: new Date(3000),
      executionTimeMs: 3000,
      updatedAtMs: 3000,
      remark: 'QuantDemo|PL',
    });
    expect(native.orderSnapshotReadCounts()).toEqual({ history: 2, today: 2 });
    expect(throttles).toBe(4);
    expect(native.nativeMutations()).toEqual([]);
  });

  it('history 未响应时，today 在共享 FIFO 准入后仍发起；两份原始结果齐全前不发布', async () => {
    const firstPermit = Promise.withResolvers<undefined>();
    const historyReply = Promise.withResolvers<undefined>();
    let admissions = 0;
    const limiter = createRateLimiterDouble({
      onThrottle: async () => {
        admissions += 1;
        if (admissions === 1) await firstPermit.promise;
      },
    });
    const { native, port } = await createOrderSnapshotReadFixture(
      [createSnapshotInput({ orderId: 'HISTORY' })],
      [createSnapshotInput({ orderId: 'TODAY' })],
      limiter,
    );
    native.setOrderSnapshotBeforeReply('history', () => historyReply.promise);
    let published = false;
    const read = port.fetchAllOrders().then((orders) => {
      published = true;
      return orders;
    });
    await flushSnapshotMicrotasks();
    expect(admissions).toBe(1);
    expect(native.orderSnapshotReadCounts()).toEqual({ history: 0, today: 0 });
    firstPermit.resolve();
    await flushSnapshotMicrotasks();
    expect(admissions).toBe(2);
    expect(native.orderSnapshotReadCounts()).toEqual({ history: 1, today: 1 });
    expect(published).toBe(false);
    historyReply.resolve();
    const orders = await read;
    expect(orders.map((order) => order.orderId)).toEqual(['HISTORY', 'TODAY']);
  });

  for (const firstSource of ['history', 'today'] as const) {
    it(`${firstSource} 先返回也不影响整条 today 覆盖；today 修订更早仍获选且不同 ID 保留`, async () => {
      const historyReply = Promise.withResolvers<undefined>();
      const todayReply = Promise.withResolvers<undefined>();
      const { native, port } = await createOrderSnapshotReadFixture(
        [
          createSnapshotInput({ orderId: 'SHARED', updatedAtMs: 9000 }),
          createSnapshotInput({ orderId: 'HISTORY-ONLY' }),
        ],
        [
          createSnapshotInput({
            orderId: 'SHARED',
            side: 'SELL',
            status: 'Canceled',
            remark: 'TODAY-ONLY',
            quantity: '200',
            executedQuantity: '50',
            executedPrice: '2.000000000000000001',
            submittedPrice: '3.000000000000000001',
            submittedAtMs: 500,
            updatedAtMs: 2000,
          }),
          createSnapshotInput({ orderId: 'TODAY-ONLY' }),
        ],
      );
      native.setOrderSnapshotBeforeReply('history', () => historyReply.promise);
      native.setOrderSnapshotBeforeReply('today', () => todayReply.promise);
      let published = false;
      const read = port.fetchAllOrders().then((orders) => {
        published = true;
        return orders;
      });
      await flushSnapshotMicrotasks();
      expect(native.orderSnapshotReadCounts()).toEqual({ history: 1, today: 1 });
      (firstSource === 'history' ? historyReply : todayReply).resolve();
      await flushSnapshotMicrotasks();
      expect(published).toBe(false);
      (firstSource === 'history' ? todayReply : historyReply).resolve();
      const orders = await read;
      expect(
        orders.map((order) => order.orderId).sort((left, right) => left.localeCompare(right)),
      ).toEqual(['HISTORY-ONLY', 'SHARED', 'TODAY-ONLY']);
      expect(orders.find((order) => order.orderId === 'SHARED')).toMatchObject({
        executionSide: 'SELL',
        status: 'CANCELED',
        executionStatus: 'PARTIAL',
        executionPhase: 'TERMINAL',
        quantity: 200,
        executedQuantity: 50,
        price: '3.000000000000000001',
        executedPrice: '2.000000000000000001',
        executedAmount: '100.00000000000000005',
        submittedAt: new Date(500),
        updatedAtMs: 2000,
        executionTimeMs: 2000,
        remark: 'TODAY-ONLY',
      });
    });
  }

  for (const source of ['history', 'today'] as const) {
    it(`${source} 同来源 HK 重复 fatal，history 重复即使被完整 today 覆盖也不能救回`, async () => {
      const older = createSnapshotInput({ updatedAtMs: 2000 });
      const newer = createSnapshotInput({ updatedAtMs: 9000 });
      const { native, port } = await createOrderSnapshotReadFixture(
        source === 'history' ? [older, newer] : [],
        source === 'today' ? [older, newer] : [createSnapshotInput()],
      );
      const failure: unknown = await port.fetchAllOrders().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(TypeError);
      expect(failure instanceof Error ? failure.message : '').toMatch(/duplicate|重复/i);
      expect(native.orderSnapshotReadCounts()).toEqual({ history: 1, today: 1 });
    });

    it(`${source} 不是数组时整次读取拒绝，不重试、不返回另一来源`, async () => {
      const { native, port } = await createOrderSnapshotReadFixture([], [createSnapshotInput()]);
      native.setOrderSnapshotNonArray(source);
      const failure: unknown = await port.fetchAllOrders().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(TypeError);
      expect(failure).toHaveProperty(
        'message',
        `[订单记录] TradeContext.${source}Orders 返回值不是数组`,
      );
      expect(native.orderSnapshotReadCounts()).toEqual({ history: 1, today: 1 });
    });
  }

  for (const status of [
    'Filled',
    'Canceled',
    'Expired',
    'Rejected',
    'PartialWithdrawal',
  ] as const) {
    for (const defect of ['PRICE', 'NULL_REVISION', 'OMITTED_REVISION'] as const) {
      it(`正成交终态 ${status} 的 history ${defect} 在完整 today 覆盖后成功，不提前映射废弃行`, async () => {
        const history = createSnapshotInput({ status, updatedAtMs: 9000 });
        const today = createSnapshotInput({ status, side: 'SELL', updatedAtMs: 2000 });
        const { native, port } = await createOrderSnapshotReadFixture([history], [today]);
        if (defect === 'PRICE') native.setOrderSnapshotExecutedPriceMissing('history');
        else
          native.setOrderSnapshotUpdatedAtAbsent(
            'history',
            defect === 'NULL_REVISION' ? 'NULL' : 'OMITTED',
          );

        expect(await port.fetchAllOrders()).toMatchObject([
          {
            orderId: 'ORDER',
            executionSide: 'SELL',
            executedQuantity: 100,
            executedAmount: '123.45678901234567890123456789',
            updatedAtMs: 2000,
            executionTimeMs: 2000,
          },
        ]);
      });
    }
  }

  it('history 同时缺价及 revision 的正成交终态也可以被完整 today 整条覆盖', async () => {
    const { native, port } = await createOrderSnapshotReadFixture(
      [createSnapshotInput()],
      [createSnapshotInput()],
    );
    native.setOrderSnapshotExecutedPriceMissing('history');
    native.setOrderSnapshotUpdatedAtAbsent('history', 'NULL');
    expect(await port.fetchAllOrders()).toHaveLength(1);
  });

  for (const source of ['history', 'today'] as const) {
    for (const defect of ['PRICE', 'NULL_REVISION', 'OMITTED_REVISION'] as const) {
      it(`获选 ${source} ${defect} fatal，today 不回退完整 history，未覆盖坏 history 也不忽略`, async () => {
        const { native, port } = await createOrderSnapshotReadFixture(
          [createSnapshotInput()],
          [createSnapshotInput({ orderId: source === 'history' ? 'UNRELATED' : 'ORDER' })],
        );
        if (defect === 'PRICE') native.setOrderSnapshotExecutedPriceMissing(source);
        else
          native.setOrderSnapshotUpdatedAtAbsent(
            source,
            defect === 'NULL_REVISION' ? 'NULL' : 'OMITTED',
          );

        const failure: unknown = await port.fetchAllOrders().catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(TypeError);
        expect(failure instanceof Error ? failure.message : '').toMatch(
          defect === 'PRICE'
            ? /cumulative execution quantity\/price/
            : /independent broker revision/,
        );
        expect(native.orderSnapshotReadCounts()).toEqual({ history: 1, today: 1 });
      });
    }

    for (const field of ['submittedAtMs', 'updatedAtMs'] as const) {
      for (const invalidTime of [Number.NaN, 0, -1]) {
        it(`获选 ${source} ${field}=${invalidTime} fatal，不能由另一来源回退或补时间`, async () => {
          const bad = createSnapshotInput({ [field]: invalidTime });
          const { native, port } = await createOrderSnapshotReadFixture(
            source === 'history' ? [bad] : [createSnapshotInput()],
            source === 'today' ? [bad] : [],
          );
          expect(await port.fetchAllOrders().catch((error: unknown) => error)).toBeInstanceOf(
            TypeError,
          );
          expect(native.orderSnapshotReadCounts()).toEqual({ history: 1, today: 1 });
        });
      }
    }

    for (const defect of ['QUANTITIES_MISSING', 'REVISION_PRIMITIVE', 'MALFORMED_PRICE'] as const) {
      it(`获选 ${source} ${defect} 不可通过结构边界或补造字段`, async () => {
        const { native, port } = await createOrderSnapshotReadFixture(
          source === 'history' ? [createSnapshotInput()] : [],
          source === 'today' ? [createSnapshotInput()] : [],
        );
        if (defect === 'QUANTITIES_MISSING') native.setOrderSnapshotQuantitiesMissing(source);
        else if (defect === 'REVISION_PRIMITIVE') native.setOrderSnapshotUpdatedAtInvalid(source);
        else native.setOrderSnapshotPriceMalformed('ORDER');

        expect(await port.fetchAllOrders().catch((error: unknown) => error)).toBeInstanceOf(
          TypeError,
        );
        expect(native.orderSnapshotReadCounts()).toEqual({ history: 1, today: 1 });
      });
    }

    it(`获选 ${source} HK Canceled 零成交 Unknown side 仍 fatal，today 不回退同 ID 合法 history`, async () => {
      const canceled = createSnapshotInput({ status: 'Canceled', executedQuantity: '0' });
      const { native, port } = await createOrderSnapshotReadFixture(
        source === 'history' ? [canceled] : [createSnapshotInput()],
        source === 'today' ? [canceled] : [],
      );
      native.setOrderSnapshotMetadataInvalid(source, 'side', 'UNKNOWN');

      expect(await port.fetchAllOrders().catch((error: unknown) => error)).toBeInstanceOf(
        TypeError,
      );
      expect(native.orderSnapshotReadCounts()).toEqual({ history: 1, today: 1 });
    });

    for (const field of ['side', 'status', 'orderType'] as const) {
      for (const kind of ['UNKNOWN', 'NON_MEMBER', 'MISSING'] as const) {
        it(`获选 ${source} ${field}/${kind} 必须严格拒绝`, async () => {
          const { native, port } = await createOrderSnapshotReadFixture(
            source === 'history' ? [createSnapshotInput()] : [],
            source === 'today' ? [createSnapshotInput()] : [],
          );
          native.setOrderSnapshotMetadataInvalid(source, field, kind);
          expect(await port.fetchAllOrders().catch((error: unknown) => error)).toBeInstanceOf(
            TypeError,
          );
          expect(native.orderSnapshotReadCounts()).toEqual({ history: 1, today: 1 });
        });
      }
    }
  }

  for (const defect of ['MISSING_ID', 'EMPTY_SYMBOL', 'MALFORMED_SYMBOL'] as const) {
    it(`history 身份 ${defect} 不可由合法 today 覆盖救回`, async () => {
      const { native, port } = await createOrderSnapshotReadFixture(
        [createSnapshotInput({ symbol: defect === 'MALFORMED_SYMBOL' ? 'BULL' : 'BULL.HK' })],
        [createSnapshotInput()],
      );
      if (defect === 'MISSING_ID') native.setOrderSnapshotOrderIdMissing('history');

      if (defect === 'EMPTY_SYMBOL') native.setOrderSnapshotSymbolEmpty('history');

      expect(await port.fetchAllOrders().catch((error: unknown) => error)).toBeInstanceOf(
        TypeError,
      );
      expect(native.orderSnapshotReadCounts()).toEqual({ history: 1, today: 1 });
    });
  }

  it('history 身份 getter 的原始错误不可被覆盖吞掉，也不阻止已准入 today 请求', async () => {
    const { native, port } = await createOrderSnapshotReadFixture(
      [createSnapshotInput()],
      [createSnapshotInput()],
    );
    const cause = new RangeError('native identity getter');
    native.setOrderSnapshotGetterFailure('history', 'ORDER', 'orderId', cause);
    expect(await port.fetchAllOrders().catch((error: unknown) => error)).toBe(cause);
    expect(native.orderSnapshotReadCounts()).toEqual({ history: 1, today: 1 });
  });

  it('废弃 history 的非身份 getter 不读取，获选 today 才进入严格 mapper', async () => {
    const { native, port } = await createOrderSnapshotReadFixture(
      [createSnapshotInput()],
      [createSnapshotInput()],
    );
    native.setOrderSnapshotGetterFailure(
      'history',
      'ORDER',
      'remark',
      new TypeError('discarded provenance'),
    );
    expect(await port.fetchAllOrders()).toMatchObject([
      { orderId: 'ORDER', remark: 'QuantDemo|PL' },
    ]);
  });

  it('合法非HK碎股和非HK同来源重复先过滤，既不映射也不与HK同 ID 冲突', async () => {
    const us = createSnapshotInput({
      orderId: 'ORDER',
      symbol: 'AAPL.US',
      quantity: '1.5',
      executedQuantity: '1.5',
    });
    const hk = createSnapshotInput();
    const { port } = await createOrderSnapshotReadFixture([us, us, hk], [us, us]);
    expect(await port.fetchAllOrders()).toMatchObject([
      { orderId: 'ORDER', symbol: 'BULL.HK', quantity: 100 },
    ]);
  });

  it('非HK也必须先有完整身份，缺失 ID 不能当作范围外订单跳过', async () => {
    const { native, port } = await createOrderSnapshotReadFixture(
      [createSnapshotInput({ symbol: 'AAPL.US', quantity: '1.5', executedQuantity: '1.5' })],
      [createSnapshotInput()],
    );
    native.setOrderSnapshotOrderIdMissing('history');
    expect(await port.fetchAllOrders().catch((error: unknown) => error)).toBeInstanceOf(TypeError);
  });

  for (const mode of ['NULL', 'OMITTED'] as const) {
    for (const status of ['New', 'Canceled', 'Rejected'] as const) {
      it(`合法零成交 ${status} 缺价及 ${mode} revision 不误拒，不伪造执行时间`, async () => {
        const { native, port } = await createOrderSnapshotReadFixture(
          [],
          [createSnapshotInput({ status, executedQuantity: '0' })],
        );
        native.setOrderSnapshotExecutedPriceMissing('today');
        native.setOrderSnapshotSubmittedPriceNull('ORDER');
        native.setOrderSnapshotUpdatedAtAbsent('today', mode);
        expect(await port.fetchAllOrders()).toMatchObject([
          {
            executedQuantity: 0,
            executedPrice: null,
            executedAmount: '0',
            price: null,
            updatedAt: null,
            updatedAtMs: 1000,
            executionTimeMs: null,
          },
        ]);
      });
    }
  }

  for (const source of ['history', 'today'] as const) {
    it(`${source} 请求失败整批不返回另一来源，晚到原始结果也不发布`, async () => {
      const failedReply = Promise.withResolvers<undefined>();
      const lateReply = Promise.withResolvers<undefined>();
      const failure = new Error('permission denied at native read');
      const { native, port } = await createOrderSnapshotReadFixture(
        [createSnapshotInput({ orderId: 'HISTORY' })],
        [createSnapshotInput({ orderId: 'TODAY' })],
      );
      native.setOrderSnapshotBeforeReply(source, () => failedReply.promise);
      native.setOrderSnapshotBeforeReply(
        source === 'history' ? 'today' : 'history',
        () => lateReply.promise,
      );
      const deliveries: ReadonlyArray<OrderFact>[] = [];
      const read = port
        .fetchAllOrders()
        .then((orders) => {
          deliveries.push(orders);
          return orders;
        })
        .catch((error: unknown) => error);
      await flushSnapshotMicrotasks();
      expect(native.orderSnapshotReadCounts()).toEqual({ history: 1, today: 1 });
      failedReply.reject(failure);
      expect(await read).toBe(failure);
      expect(deliveries).toEqual([]);
      lateReply.resolve();
      await flushSnapshotMicrotasks();
      expect(deliveries).toEqual([]);
      native.setOrderSnapshotBeforeReply('history', async () => {});
      native.setOrderSnapshotBeforeReply('today', async () => {});
      expect(await port.fetchAllOrders()).toHaveLength(2);
      expect(native.orderSnapshotReadCounts()).toEqual({ history: 2, today: 2 });
    });
  }

  it('后面的获选记录映射失败不交付已成功映射前缀，原始 getter error identity 保留', async () => {
    const { native, port } = await createOrderSnapshotReadFixture(
      [],
      [createSnapshotInput({ orderId: 'GOOD' }), createSnapshotInput({ orderId: 'BAD' })],
    );
    const failure = new TypeError('native selected provenance getter');
    native.setOrderSnapshotGetterFailure('today', 'BAD', 'remark', failure);
    const deliveries: ReadonlyArray<OrderFact>[] = [];
    const result: unknown = await port
      .fetchAllOrders()
      .then((orders) => {
        deliveries.push(orders);
        return orders;
      })
      .catch((error: unknown) => error);
    expect(result).toBe(failure);
    expect(deliveries).toEqual([]);
    expect(native.orderSnapshotReadCounts()).toEqual({ history: 1, today: 1 });
  });

  it('共享真实 limiter 每 attempt 只 throttle 一次，默认 retry2 和 30ms 最小间隔均使用虚拟时间', async () => {
    const timers = createOrderSnapshotTimerHarness();
    try {
      const limiter = createRateLimiter({
        logger: createLoggerDouble(),
        nowMonotonicMs: timers.nowMs,
        wait: (delayMs) =>
          new Promise((resolve) => {
            setTimeout(resolve, delayMs);
          }),
      });
      let throttles = 0;
      const { native, port } = await createOrderSnapshotReadFixture(
        [createSnapshotInput({ orderId: 'HISTORY' })],
        [createSnapshotInput({ orderId: 'TODAY' })],
        {
          throttle: async () => {
            throttles += 1;
            await limiter.throttle();
          },
        },
      );
      const attempts: Array<Readonly<{ source: string; atMs: number }>> = [];
      for (const source of ['history', 'today'] as const) {
        native.setOrderSnapshotBeforeReply(source, async () => {
          attempts.push({ source, atMs: timers.nowMs() });
          if (native.orderSnapshotReadCounts()[source] < 3)
            throw new Error('network temporarily unavailable');
        });
      }

      const read = port.fetchAllOrders();
      await flushSnapshotMicrotasks();
      expect(native.orderSnapshotReadCounts()).toEqual({ history: 1, today: 0 });
      expect(timers.pendingDelays()).toEqual([30, 300]);
      await timers.advanceBy(29);
      expect(native.orderSnapshotReadCounts()).toEqual({ history: 1, today: 0 });
      await timers.advanceBy(1);
      expect(native.orderSnapshotReadCounts()).toEqual({ history: 1, today: 1 });
      await timers.advanceBy(270);
      expect(native.orderSnapshotReadCounts()).toEqual({ history: 2, today: 1 });
      await timers.advanceBy(30);
      expect(native.orderSnapshotReadCounts()).toEqual({ history: 2, today: 2 });
      await timers.advanceBy(270);
      expect(native.orderSnapshotReadCounts()).toEqual({ history: 3, today: 2 });
      await timers.advanceBy(30);
      expect(await read).toHaveLength(2);
      expect(native.orderSnapshotReadCounts()).toEqual({ history: 3, today: 3 });
      expect(throttles).toBe(6);
      expect(attempts).toEqual([
        { source: 'history', atMs: 10000 },
        { source: 'today', atMs: 10030 },
        { source: 'history', atMs: 10300 },
        { source: 'today', atMs: 10330 },
        { source: 'history', atMs: 10600 },
        { source: 'today', atMs: 10630 },
      ]);
    } finally {
      timers.restore();
    }
  });

  for (const source of ['history', 'today'] as const) {
    it(`${source} 默认最多 3 attempts；耗尽保持 external error cause/operation，不回退成功来源`, async () => {
      const timers = createOrderSnapshotTimerHarness();
      try {
        let throttles = 0;
        const { native, port } = await createOrderSnapshotReadFixture(
          [createSnapshotInput({ orderId: 'HISTORY' })],
          [createSnapshotInput({ orderId: 'TODAY' })],
          createRateLimiterDouble({
            onThrottle: () => {
              throttles += 1;
            },
          }),
        );
        const cause = new Error('network timeout');
        native.setOrderSnapshotBeforeReply(source, async () => {
          throw cause;
        });
        const deliveries: ReadonlyArray<OrderFact>[] = [];
        const read = port
          .fetchAllOrders()
          .then((orders) => {
            deliveries.push(orders);
            return orders;
          })
          .catch((error: unknown) => error);
        await flushSnapshotMicrotasks();
        expect(timers.pendingDelays()).toEqual([300]);
        await timers.advanceBy(299);
        expect(native.orderSnapshotReadCounts()[source]).toBe(1);
        await timers.advanceBy(1);
        expect(native.orderSnapshotReadCounts()[source]).toBe(2);
        await timers.advanceBy(300);
        const failure = await read;
        expect(failure).toMatchObject({
          name: 'ExternalApiRequestError',
          operation: `TradeContext.${source}Orders`,
          attempts: 3,
          cause,
        });
        expect(failure instanceof Error ? failure.cause : null).toBe(cause);
        expect(native.orderSnapshotReadCounts()[source]).toBe(3);
        expect(throttles).toBe(4);
        expect(deliveries).toEqual([]);
        expect(timers.pendingDelays()).toEqual([]);
      } finally {
        timers.restore();
      }
    });
  }
});
