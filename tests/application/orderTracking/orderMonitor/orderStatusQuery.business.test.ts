import { wrapExternalApiRequest } from '../../../../src/infrastructure/externalApi/index.js';

/** 单订单权威查询：原23例经实际 SDK 读取与 mapper；查询任务的 abort owner 跨 await 保持不变。 */

import { describe, expect, it } from 'bun:test';
import { createRateLimiterDouble } from '../../../helpers/testDoubles.js';
import type { BrokerIngressInput } from '../../../infrastructure/longbridge/trade/brokerIngressFixture.js';
import { createBrokerIngressFixture } from '../../../integration/architectureRefactoringP1Native/trade/brokerIngressFixture.js';

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
    tradeId: orderId + '-trade',
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
    executionTimeMs: null,
    updatedAtMs: REVISION_MS,
  };
}

/** 初始 setup 合法；原坏字段仅在已 issued 的 native DETAIL 入口进入 mapper。 */
async function createQueryContext(frames: ReadonlyArray<BrokerIngressInput>) {
  const native = await createBrokerIngressFixture(frame('QUERY-SETUP', 'New'));
  native.setOrderDetailReplies(frames);
  native.setExecutionReplies([]);
  const abortOwner = new AbortController();
  const query = native.createStateQuery({
    requestExternalApi: wrapExternalApiRequest,
    rateLimiter: createRateLimiterDouble(),
    getExecutionTimeEvidence: () => [],
  });
  const initialLedgerReads = native.readCounts();
  return {
    native,
    abortOwner,
    initialLedgerReads,
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
        expect(result.executionTimeMs).toBeNull();
        expect(result.orderUpdatedAtMs).toBe(REVISION_MS);
      }

      expect(f.native.nativeReadCounts()).toEqual({ cancel: 0, detail: 1 });
      expect(f.native.readCounts().today - f.initialLedgerReads.today).toBe(1);
      f.abortOwner.abort();
    }
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
      expect(withdrawal.executionTimeMs).toBeNull();
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
          executionTimeMs: null,
        });
        expect(f.native.readCounts().today - f.initialLedgerReads.today).toBe(2);
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
        expect(f.native.readCounts().today - f.initialLedgerReads.today).toBe(1);
      } else {
        expectMapperFailure(
          await rejection(() => f.check('ORDER-OPEN-UPDATED-AT')),
          '[orderMapper] invalid updatedAt',
        );

        expectMapperFailure(
          await rejection(() => f.check('ORDER-TERMINAL-UPDATED-AT')),
          '[orderMapper] invalid updatedAt',
        );
        expect(f.native.readCounts()).toEqual(f.initialLedgerReads);
      }

      expect(f.native.nativeReadCounts()).toEqual({ cancel: 0, detail: 2 });
      f.abortOwner.abort();
    },
  );

  it('retries orderDetail request failures before mapping the authoritative state', async () => {
    const orderId = 'ORDER-RETRY-THEN-FILLED';
    const f = await createQueryContext([frame(orderId, 'Filled', '100', '1.01')]);
    const original = new Error('network unavailable');
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
      executionTimeMs: null,
      orderUpdatedAtMs: REVISION_MS,
    });

    expect(f.native.readCounts()).toEqual({
      today: f.initialLedgerReads.today + 1,
      history: f.initialLedgerReads.history,
    });
    f.abortOwner.abort();
  });

  it('retries coded transient orderDetail errors before mapping state', async () => {
    const orderId = 'ORDER-CODED-TRANSIENT-THEN-FILLED';
    const f = await createQueryContext([frame(orderId, 'Filled', '100', '1.01')]);
    const original = new Error('openapi error: code=503: service unavailable');
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
      executionTimeMs: null,
      orderUpdatedAtMs: REVISION_MS,
    });

    expect(f.native.readCounts()).toEqual({
      today: f.initialLedgerReads.today + 1,
      history: f.initialLedgerReads.history,
    });
    f.abortOwner.abort();
  });

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
    expect(f.native.readCounts()).toEqual(f.initialLedgerReads);
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
    expect(f.native.readCounts()).toEqual(f.initialLedgerReads);
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
    expect(f.native.readCounts()).toEqual(f.initialLedgerReads);
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
      expect(result.executionTimeMs).toBeNull();
      expect(result.updatedAtMs).toBe(REVISION_MS);
    }

    expect(f.native.nativeReadCounts()).toEqual({ cancel: 0, detail: 1 });
    expect(f.native.readCounts().today - f.initialLedgerReads.today).toBe(1);
    f.abortOwner.abort();
  });
});
