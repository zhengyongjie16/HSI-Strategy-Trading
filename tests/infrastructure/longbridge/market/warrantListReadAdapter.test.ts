import { wrapExternalApiRequest } from '../../../../src/infrastructure/externalApi/index.js';

/**
 * 真实 warrantList adapter 读取/缓存测试。
 * SDK query 仍仅在原 adapter 执行，验证完整过滤参数、重试共享、精确金融映射与 clear 后迟到读取失效。
 */
import { describe, expect, it } from 'bun:test';
import { rejects } from 'node:assert/strict';
import {
  Decimal,
  FilterWarrantExpiryDate,
  FilterWarrantInOutBoundsType,
  SortOrderType,
  WarrantSortBy,
  WarrantStatus,
  WarrantType,
} from 'longbridge';
import { createWarrantListReadAdapter } from '../../../../src/infrastructure/longbridge/market/warrantListReadAdapter.js';
import { createWarrantListCache } from '../../../../src/infrastructure/longbridge/market/warrantListCache/index.js';
import type { MarketWarrantListRequest } from '../../../../src/types/marketPorts.js';
import { isExternalApiRequestError } from '../../../../src/utils/apiFailure/index.js';

function createRequest(
  overrides: Partial<MarketWarrantListRequest> = {},
): MarketWarrantListRequest {
  return {
    symbol: 'HSI.HK',
    sortBy: 'TURNOVER',
    sortOrder: 'DESCENDING',
    types: ['BULL'],
    issuerIds: null,
    expiryFilters: ['MONTHS_3_TO_6', 'MONTHS_6_TO_12', 'OVER_12_MONTHS'],
    inOutBoundsTypes: ['IN'],
    status: ['NORMAL'],
    ...overrides,
  };
}

function createNativeItem(symbol = 'BULL-1.HK') {
  return {
    symbol,
    name: symbol,
    lastDone: new Decimal('0.0700000000000000000001'),
    callPrice: new Decimal('20000.1234567890123456789'),
    toCallPrice: new Decimal('0.003500000000000000001'),
    turnover: new Decimal('300000.000000000000000001'),
    warrantType: WarrantType.Bull,
    status: WarrantStatus.Normal,
  };
}

async function executeOnce<T>(request: () => Promise<T>): Promise<T> {
  return request();
}

describe('warrant list read adapter', () => {
  it('uses the existing native query tuple and exact Decimal text without altering caller filters', async () => {
    const tuples: unknown[][] = [];
    const reader = createWarrantListReadAdapter(
      {
        warrantList: async (...args: unknown[]) => {
          tuples.push(args);
          return [createNativeItem()];
        },
      },
      executeOnce,
    );
    const request = createRequest();
    const result = await reader.warrantList(request);
    expect(tuples).toEqual([
      [
        'HSI.HK',
        WarrantSortBy.Turnover,
        SortOrderType.Descending,
        [WarrantType.Bull],
        null,
        [
          FilterWarrantExpiryDate.Between_3_6,
          FilterWarrantExpiryDate.Between_6_12,
          FilterWarrantExpiryDate.GT_12,
        ],
        [FilterWarrantInOutBoundsType.In],
        [WarrantStatus.Normal],
      ],
    ]);

    expect(result[0]).toMatchObject({
      lastDone: '0.0700000000000000000001',
      callPrice: '20000.1234567890123456789',
      toCallPrice: '0.003500000000000000001',
      turnover: '300000.000000000000000001',
      status: 'NORMAL',
    });
    expect(request.types).toEqual(['BULL']);
  });

  it('shares cache across port instances, includes TTL equality and re-fetches after expiry', async () => {
    let reads = 0;
    let nowMs = 1000;
    const native = {
      warrantList: async () => {
        reads += 1;
        return [createNativeItem()];
      },
    };
    const config = { cache: createWarrantListCache(), ttlMs: 3000, nowMs: () => nowMs };
    const firstPort = createWarrantListReadAdapter(native, executeOnce, config);
    const secondPort = createWarrantListReadAdapter(native, executeOnce, config);
    const first = await firstPort.warrantList(createRequest());
    nowMs = 4000;
    expect(await secondPort.warrantList(createRequest())).toBe(first);
    expect(reads).toBe(1);
    nowMs = 4001;
    await secondPort.warrantList(createRequest());
    expect(reads).toBe(2);
  });

  it('keys on complete request semantics: direction, expiry, issuer null/absence and omitted filters', async () => {
    let reads = 0;
    const reader = createWarrantListReadAdapter(
      {
        warrantList: async () => {
          reads += 1;
          return [];
        },
      },
      executeOnce,
      { cache: createWarrantListCache(), ttlMs: 3000, nowMs: () => 1000 },
    );
    const base = createRequest();
    const { issuerIds: _issuerIds, ...withoutIssuer } = base;
    const { status: _status, ...withoutStatus } = base;
    for (const request of [
      base,
      createRequest({ types: ['BEAR'] }),
      createRequest({ expiryFilters: ['OVER_12_MONTHS'] }),
      createRequest({ issuerIds: [7] }),
      withoutIssuer,
      withoutStatus,
    ])
      await reader.warrantList(request);

    expect(reads).toBe(6);
    await reader.warrantList(base);
    expect(reads).toBe(6);
  });

  it('validates every request before cache/retry and does not retry malformed mapped financial facts', async () => {
    let reads = 0;
    let executions = 0;
    const reader = createWarrantListReadAdapter(
      {
        warrantList: async () => {
          reads += 1;
          return [{ ...createNativeItem(), turnover: 1 }];
        },
      },
      async (request) => {
        executions += 1;
        return request();
      },
      {
        cache: createWarrantListCache(),
        ttlMs: 3000,
        nowMs: () => 1000,
      },
    );
    await rejects(reader.warrantList({ ...createRequest(), symbol: '' }), TypeError);
    expect(executions).toBe(0);
    expect(reads).toBe(0);
    await rejects(reader.warrantList(createRequest()), TypeError);
    await rejects(reader.warrantList(createRequest()), TypeError);
    expect(executions).toBe(2);
    expect(reads).toBe(2);
  });

  it('deduplicates an entire exhausted IO retry and preserves the same classified failure identity', async () => {
    let reads = 0;
    const networkFailure = new Error('network unavailable');
    const reader = createWarrantListReadAdapter(
      {
        warrantList: async () => {
          reads += 1;
          throw networkFailure;
        },
      },
      (request) =>
        wrapExternalApiRequest({
          operation: 'QuoteContext.warrantList',
          request,
          retryConfig: { retries: 2, delayMs: 0 },
        }),
      { cache: createWarrantListCache(), ttlMs: 3000, nowMs: () => 1000 },
    );
    const results = await Promise.allSettled([
      reader.warrantList(createRequest()),
      reader.warrantList(createRequest()),
    ]);
    const [first, second] = results;
    if (first.status !== 'rejected' || second.status !== 'rejected')
      throw new Error('expected read failures');

    expect(isExternalApiRequestError(first.reason)).toBeTrue();
    expect(second.reason).toBe(first.reason);
    expect(first.reason).toMatchObject({ operation: 'QuoteContext.warrantList', attempts: 3 });
    expect(first.reason.cause).toBe(networkFailure);
    expect(reads).toBe(3);
    await rejects(reader.warrantList(createRequest()), isExternalApiRequestError);
    expect(reads).toBe(6);
  });

  it('shares an internal read failure unchanged, releases its owner and caches the next success', async () => {
    const internalFailure = new TypeError('internal native read invariant');
    let reads = 0;
    const reader = createWarrantListReadAdapter(
      {
        warrantList: async () => {
          reads += 1;
          if (reads === 1) throw internalFailure;

          return [createNativeItem()];
        },
      },
      executeOnce,
      { cache: createWarrantListCache(), ttlMs: 3000, nowMs: () => 1000 },
    );
    const results = await Promise.allSettled([
      reader.warrantList(createRequest()),
      reader.warrantList(createRequest()),
    ]);
    expect(
      results.every((result) => result.status === 'rejected' && result.reason === internalFailure),
    ).toBeTrue();
    expect(reads).toBe(1);
    const next = await reader.warrantList(createRequest());
    expect(await reader.warrantList(createRequest())).toBe(next);
    expect(reads).toBe(2);
  });

  it('clear invalidates late cache writes and an old finally cannot delete the new same-key read', async () => {
    let reads = 0;
    const firstNative = Promise.withResolvers<ReadonlyArray<ReturnType<typeof createNativeItem>>>();
    const secondNative =
      Promise.withResolvers<ReadonlyArray<ReturnType<typeof createNativeItem>>>();
    const cache = createWarrantListCache();
    const reader = createWarrantListReadAdapter(
      {
        warrantList: () => {
          reads += 1;
          return reads === 1 ? firstNative.promise : secondNative.promise;
        },
      },
      executeOnce,
      { cache, ttlMs: 3000, nowMs: () => 1000 },
    );
    const oldRead = reader.warrantList(createRequest());
    cache.clear();
    const newRead = reader.warrantList(createRequest());
    firstNative.resolve([createNativeItem('OLD.HK')]);
    const oldResult = await oldRead;
    expect(oldResult[0]?.symbol).toBe('OLD.HK');
    const sharedNew = reader.warrantList(createRequest());
    expect(reads).toBe(2);
    secondNative.resolve([createNativeItem('NEW.HK')]);
    const newResult = await newRead;
    const sharedResult = await sharedNew;
    const cachedResult = await reader.warrantList(createRequest());
    expect(newResult[0]?.symbol).toBe('NEW.HK');
    expect(sharedResult[0]?.symbol).toBe('NEW.HK');
    expect(cachedResult[0]?.symbol).toBe('NEW.HK');
    expect(reads).toBe(2);
  });

  it.each([0, -1, Infinity, Number.NaN])(
    'does not cache or deduplicate when TTL is disabled: %s',
    async (ttlMs) => {
      let reads = 0;
      const reader = createWarrantListReadAdapter(
        {
          warrantList: async () => {
            reads += 1;
            return [];
          },
        },
        executeOnce,
        { cache: createWarrantListCache(), ttlMs, nowMs: () => 1000 },
      );
      await Promise.all([reader.warrantList(createRequest()), reader.warrantList(createRequest())]);
      expect(reads).toBe(2);
    },
  );
});
