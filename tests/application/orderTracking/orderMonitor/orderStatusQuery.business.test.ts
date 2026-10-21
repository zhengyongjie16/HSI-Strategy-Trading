/**
 * orderStatusQuery：只读 orderDetail 的权威状态映射。
 * 不读取 execution/ledger；正成交 T 只使用本次订单观察的 updatedAt 代理。
 */
import { expect, describe, it } from 'bun:test';
import { wrapExternalApiRequest } from '../../../../src/infrastructure/externalApi/index.js';
import type { BrokerIngressInput } from '../../../infrastructure/longbridge/trade/brokerIngressFixture.js';
import { createBrokerIngressFixture } from '../../../integration/architectureRefactoringP1Native/trade/brokerIngressFixture.js';
import { createRateLimiterDouble } from '../../../helpers/testDoubles.js';

const SUBMITTED_MS = Date.parse('2026-02-25T03:00:00.000Z');
const REVISION_MS = Date.parse('2026-02-25T03:00:10.000Z');

function frame(
  orderId: string,
  status: BrokerIngressInput['status'],
  executedQuantity = '0',
  executedPrice = '0',
): BrokerIngressInput {
  return {
    orderId,
    symbol: 'BULL.HK',
    stockName: 'BULL',
    remark: '',
    side: 'BUY',
    status,
    orderType: 'ELO',
    quantity: '100',
    executedQuantity,
    submittedPrice: '1',
    executedPrice,
    submittedAtMs: SUBMITTED_MS,
    updatedAtMs: REVISION_MS,
  };
}

/** 初始 setup 合法；原坏字段仅在已 issued 的 native DETAIL 入口进入 mapper。 */
async function createQueryContext(frames: ReadonlyArray<BrokerIngressInput>) {
  const native = await createBrokerIngressFixture(frame('QUERY-SETUP', 'New'));
  native.setOrderDetailReplies(frames);
  const abortOwner = new AbortController();
  const query = native.createStateQuery({
    requestExternalApi: wrapExternalApiRequest,
    rateLimiter: createRateLimiterDouble(),
  });
  return {
    native,
    abortOwner,
    check: (orderId: string) => query.checkOrderState(orderId, () => !abortOwner.signal.aborted),
  };
}

async function rejection(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
  } catch (error) {
    return error;
  }

  return null;
}

function expectMapperFailure(error: unknown, message: string): void {
  expect(error).toBeInstanceOf(TypeError);
  expect(error).toHaveProperty('message', message);
}

describe('orderStatusQuery business flow', () => {
  it('maps terminal order statuses to terminal state check result', async () => {
    const cases: ReadonlyArray<{
      readonly status: BrokerIngressInput['status'];
      readonly expectedReason: 'FILLED' | 'CANCELED' | 'REJECTED';
    }> = [
      { status: 'Filled', expectedReason: 'FILLED' },
      { status: 'Canceled', expectedReason: 'CANCELED' },
      { status: 'Rejected', expectedReason: 'REJECTED' },
    ];
    for (const testCase of cases) {
      const orderId = 'ORDER-' + testCase.status;
      const f = await createQueryContext([frame(orderId, testCase.status, '100', '1.01')]);
      const result = await f.check(orderId);
      expect(result.kind).toBe('TERMINAL');
      if (result.kind === 'TERMINAL') {
        expect(result.closedReason).toBe(testCase.expectedReason);
        expect(result.executedQuantity).toBe(100);
        expect(result.executedAmount).toBe('101');
        expect(result.executionTimeMs).toBe(REVISION_MS);
        expect(result.orderUpdatedAtMs).toBe(REVISION_MS);
      }

      expect(f.native.nativeReadCounts()).toEqual({ cancel: 0, detail: 1 });
      f.abortOwner.abort();
    }
  });

  it('rejects the first positive terminal with zero price without retrying or reading a later valid reply', async () => {
    const orderId = 'ORDER-FIRST-BAD-TERMINAL';
    const f = await createQueryContext([
      frame(orderId, 'Filled', '100', '0'),
      frame(orderId, 'Filled', '100', '1'),
    ]);
    const error = await rejection(() => f.check(orderId));
    expectMapperFailure(error, '[orderMapper] invalid cumulative execution quantity/price');
    expect(f.native.nativeReadCounts()).toEqual({ cancel: 0, detail: 1 });
    expect(f.native.nativeMutations()).toEqual([]);
    f.abortOwner.abort();
  });

  it('maps Expired and PartialWithdrawal to TERMINAL CANCELED', async () => {
    const f = await createQueryContext([
      frame('ORDER-EXPIRED', 'Expired'),
      frame('ORDER-PARTIAL-WITHDRAWAL', 'PartialWithdrawal', '20', '1.02'),
    ]);
    const expired = await f.check('ORDER-EXPIRED');
    expect(expired.kind).toBe('TERMINAL');
    if (expired.kind === 'TERMINAL') expect(expired.closedReason).toBe('CANCELED');

    const withdrawal = await f.check('ORDER-PARTIAL-WITHDRAWAL');
    expect(withdrawal.kind).toBe('TERMINAL');
    if (withdrawal.kind === 'TERMINAL') {
      expect(withdrawal.closedReason).toBe('CANCELED');
      expect(withdrawal.executedQuantity).toBe(20);
      expect(withdrawal.executedAmount).toBe('20.4');
      expect(withdrawal.executionTimeMs).toBe(REVISION_MS);
    }

    expect(f.native.nativeReadCounts()).toEqual({ cancel: 0, detail: 2 });
    f.abortOwner.abort();
  });

  it.each([
    ['invalid Date', new Date(Number.NaN), null],
    ['zero Date', new Date(0), null],
    ['negative Date', new Date(-1), null],
    ['zero number', 0, null],
    ['negative number', -1, null],
    ['invalid number', Number.NaN, null],
    ['zero-like string', '0', null],
    ['negative-like string', '-1', null],
    ['epoch string', '1970-01-01T00:00:00.000Z', null],
    ['invalid string', 'not-a-date', null],
    ['null', null, null],
    ['undefined', undefined, null],
    ['positive Date', new Date('2026-02-25T03:00:10.000Z'), 1771988410000],
    ['positive number', 1771988410000, null],
    ['positive ISO string', '2026-02-25T03:00:10.000Z', null],
  ] as const)(
    'accepts only a valid Date for orderDetail updatedAt in both OPEN and TERMINAL state checks',
    async (_description, updatedAt, expectedUpdatedAtMs) => {
      const f = await createQueryContext([
        frame('ORDER-OPEN-UPDATED-AT', 'PendingCancel'),
        frame('ORDER-TERMINAL-UPDATED-AT', 'Filled', '100', '1.01'),
      ]);
      f.native.setQueryUpdatedAt(updatedAt);
      if (expectedUpdatedAtMs !== null) {
        expect(await f.check('ORDER-OPEN-UPDATED-AT')).toMatchObject({
          kind: 'OPEN',
          updatedAtMs: expectedUpdatedAtMs,
          executionTimeMs: null,
        });

        expect(await f.check('ORDER-TERMINAL-UPDATED-AT')).toMatchObject({
          kind: 'TERMINAL',
          orderUpdatedAtMs: expectedUpdatedAtMs,
          executionTimeMs: expectedUpdatedAtMs,
        });
      } else if (updatedAt === null) {
        // 仅零成交的 null revision 可使用提交版本；执行 T 仍未知。正成交没有 revision 必须先拒绝。
        expect(await f.check('ORDER-OPEN-UPDATED-AT')).toMatchObject({
          kind: 'OPEN',
          updatedAtMs: SUBMITTED_MS,
          executionTimeMs: null,
        });

        expectMapperFailure(
          await rejection(() => f.check('ORDER-TERMINAL-UPDATED-AT')),
          '[orderMapper] executed order lacks independent broker revision',
        );
      } else {
        expectMapperFailure(
          await rejection(() => f.check('ORDER-OPEN-UPDATED-AT')),
          '[orderMapper] invalid updatedAt',
        );

        expectMapperFailure(
          await rejection(() => f.check('ORDER-TERMINAL-UPDATED-AT')),
          '[orderMapper] invalid updatedAt',
        );
      }

      expect(f.native.nativeReadCounts()).toEqual({ cancel: 0, detail: 2 });
      f.abortOwner.abort();
    },
  );

  const assertOrderDetailRetriesBeforeMapping = async (
    orderId: string,
    original: Error,
  ): Promise<void> => {
    const f = await createQueryContext([frame(orderId, 'Filled', '100', '1.01')]);
    let attempts = 0;
    f.native.setOrderDetailBeforeReply(async () => {
      attempts++;
      if (attempts === 1) throw original;
    });
    let result: Awaited<ReturnType<typeof f.check>> | null = null;
    const error = await rejection(async () => {
      result = await f.check(orderId);
    });
    expect(attempts).toBe(2);
    expect(f.native.nativeReadCounts().detail).toBe(2);
    if (error instanceof Error) throw error;

    expect(error).toBeNull();

    expect(result).toMatchObject({
      kind: 'TERMINAL',
      closedReason: 'FILLED',
      executedQuantity: 100,
      executedAmount: '101',
      executionTimeMs: REVISION_MS,
      orderUpdatedAtMs: REVISION_MS,
    });
    f.abortOwner.abort();
  };

  it('retries orderDetail request failures before mapping the authoritative state', async () =>
    assertOrderDetailRetriesBeforeMapping(
      'ORDER-RETRY-THEN-FILLED',
      new Error('network unavailable'),
    ));

  it('retries coded transient orderDetail errors before mapping state', async () =>
    assertOrderDetailRetriesBeforeMapping(
      'ORDER-CODED-TRANSIENT-THEN-FILLED',
      new Error('openapi error: code=503: service unavailable'),
    ));

  it('maps 603001 to QUERY_FAILED NOT_FOUND', async () => {
    const f = await createQueryContext([]);
    const original = new Error(
      'openapi error: code=603001: Order not found, orderId=ORDER-NOT-EXIST',
    );
    f.native.setOrderDetailBeforeReply(async () => {
      throw original;
    });
    expect(await f.check('ORDER-NOT-EXIST')).toEqual({ kind: 'QUERY_FAILED', errorCode: '603001' });
    expect(f.native.nativeReadCounts()).toEqual({ cancel: 0, detail: 1 });
    f.abortOwner.abort();
  });

  it('rethrows ExternalApiRequestError from repeated orderDetail request failures', async () => {
    const f = await createQueryContext([]);
    const original = new Error('network unavailable');
    let attempts = 0;
    f.native.setOrderDetailBeforeReply(async () => {
      attempts++;
      throw original;
    });
    const caught = await rejection(() => f.check('ORDER-API-FAILURE'));
    expect(caught).toMatchObject({
      name: 'ExternalApiRequestError',
      operation: 'TradeContext.orderDetail',
      attempts,
    });

    if (!(caught instanceof Error)) throw new Error('Missing native external request error');

    expect(caught.cause).toBe(original);
    expect(attempts).toBeGreaterThan(1);
    expect(f.native.nativeReadCounts().detail).toBe(attempts);
    f.abortOwner.abort();
  });

  it('rethrows non-603001 business errors without wrapping them', async () => {
    const f = await createQueryContext([]);
    const original = new Error('openapi error: code=500001: unknown upstream error');
    f.native.setOrderDetailBeforeReply(async () => {
      throw original;
    });
    const caught = await rejection(() => f.check('ORDER-BUSINESS-ERROR'));
    expect(caught).toBe(original);
    if (!(caught instanceof Error)) throw new Error('Missing native business error');

    expect(caught.name).not.toBe('ExternalApiRequestError');
    expect(caught.message).toContain('500001');
    expect(f.native.nativeReadCounts()).toEqual({ cancel: 0, detail: 1 });
    f.abortOwner.abort();
  });

  it('keeps pending status as OPEN instead of terminal', async () => {
    const f = await createQueryContext([
      frame('ORDER-PENDING-CANCEL', 'PendingCancel', '20', '1.01'),
    ]);
    const result = await f.check('ORDER-PENDING-CANCEL');
    expect(result.kind).toBe('OPEN');
    if (result.kind === 'OPEN') {
      expect(result.status).toBe('CANCELLATION_PENDING');
      expect(result.executedQuantity).toBe(20);
      expect(result.executedAmount).toBe('20.2');
      expect(result.executionTimeMs).toBe(REVISION_MS);
      expect(result.updatedAtMs).toBe(REVISION_MS);
    }

    expect(f.native.nativeReadCounts()).toEqual({ cancel: 0, detail: 1 });
    f.abortOwner.abort();
  });
});
