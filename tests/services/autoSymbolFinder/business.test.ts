/**
 * autoSymbolFinder 业务测试
 *
 * 功能：
 * - 验证自动寻标发现相关场景意图、边界条件与业务期望。
 */
import { describe, expect, it } from 'bun:test';
import { inspect } from 'node:util';
import { rejects } from 'node:assert/strict';

import { findBestWarrant } from '../../../src/services/autoSymbolFinder/index.js';
import { resolveDirectionalAutoSearchPolicy } from '../../../src/services/autoSymbolFinder/policyResolver.js';
import { isExternalApiRequestError } from '../../../src/utils/apiFailure/index.js';
import { createExternalApiRequestError } from '../../helpers/createExternalApiRequestError.js';
import type { MarketQuoteContext } from '../../../src/types/services.js';
import {
  buildExpiryDateFilters,
  createWarrantListCache,
  selectBestWarrant,
} from '../../../src/services/autoSymbolFinder/utils.js';

import type {
  DirectionalAutoSearchPolicy,
  WarrantListItem,
} from '../../../src/services/autoSymbolFinder/types.js';
import type { Logger } from '../../../src/utils/logger/types.js';

function createLoggerRecorder(): {
  readonly logger: Logger;
  readonly warns: string[];
} {
  const warns: string[] = [];
  return {
    logger: {
      debug: () => {},
      info: () => {},
      warn: (msg: string, extra?: unknown) => {
        warns.push(msg);
        if (extra !== undefined) {
          warns.push(
            typeof extra === 'string' ? extra : inspect(extra, { depth: 3, breakLength: Infinity }),
          );
        }
      },
      error: () => {},
    },
    warns,
  };
}

function createWarrantListItem(params: {
  readonly symbol: string;
  readonly apiDistanceRatio: string;
  readonly turnover: string;
  readonly status?: WarrantListItem['status'];
  readonly callPrice?: string;
  readonly name?: string;
}): WarrantListItem {
  return {
    symbol: params.symbol,
    name: params.name ?? params.symbol,
    toCallPrice: params.apiDistanceRatio,
    callPrice: params.callPrice ?? '20000',
    turnover: params.turnover,
    status: Object.hasOwn(params, 'status') ? params.status : 'NORMAL',
  };
}

function toWarrantInfo(
  item: WarrantListItem,
): Awaited<ReturnType<MarketQuoteContext['warrantList']>>[number] {
  return {
    ...item,
    lastDone: '1',
    toCallPrice: item.toCallPrice,
    turnover: item.turnover,
    warrantType: 'BULL',
    status: item.status,
  };
}

function createDirectionalPolicy(
  direction: 'LONG' | 'SHORT',
  overrides: Partial<DirectionalAutoSearchPolicy> = {},
): DirectionalAutoSearchPolicy {
  const base =
    direction === 'LONG'
      ? {
          direction,
          primaryThreshold: '0.35',
          minTurnoverPerMinute: '10000',
          degradedRange: { min: '0.2', max: '0.35' },
          switchDistanceRange: { min: '0.2', max: '1.5' },
        }
      : {
          direction,
          primaryThreshold: '-0.35',
          minTurnoverPerMinute: '10000',
          degradedRange: { min: '-0.35', max: '-0.2' },
          switchDistanceRange: { min: '-1.5', max: '-0.2' },
        };
  return {
    ...base,
    ...overrides,
  };
}

describe('autoSymbolFinder business flow', () => {
  it('builds expiry filter sets by configured minimum month threshold', () => {
    expect(buildExpiryDateFilters(3)).toEqual([
      'MONTHS_3_TO_6',
      'MONTHS_6_TO_12',
      'OVER_12_MONTHS',
    ]);

    expect(buildExpiryDateFilters(5)).toEqual(['MONTHS_6_TO_12', 'OVER_12_MONTHS']);
    expect(buildExpiryDateFilters(7)).toEqual(['OVER_12_MONTHS']);
  });

  it('selects best candidate by distance then turnover-per-minute under business constraints', () => {
    const result = selectBestWarrant({
      warrants: [
        createWarrantListItem({
          symbol: 'A.HK',
          apiDistanceRatio: '0.008',
          turnover: '120000',
        }),
        createWarrantListItem({
          symbol: 'B.HK',
          apiDistanceRatio: '0.006',
          turnover: '200000',
        }),
        createWarrantListItem({
          symbol: 'C.HK',
          apiDistanceRatio: '0.006',
          turnover: '260000',
        }),
        createWarrantListItem({
          symbol: 'D.HK',
          apiDistanceRatio: '0.003',
          turnover: '500000',
        }),
        createWarrantListItem({
          symbol: 'E.HK',
          apiDistanceRatio: '0.005',
          turnover: '500000',
          status: 'NON_NORMAL',
        }),
        createWarrantListItem({
          symbol: 'UNKNOWN-NULL.HK',
          apiDistanceRatio: '0.005',
          turnover: '999999',
          status: null,
        }),
        createWarrantListItem({
          symbol: 'UNKNOWN-UNDEFINED.HK',
          apiDistanceRatio: '0.005',
          turnover: '999999',
          status: undefined,
        }),
      ],
      tradingMinutes: 10,
      policy: createDirectionalPolicy('LONG'),
    });

    expect(result.candidate?.symbol).toBe('C.HK');
    expect(result.candidate?.distancePct).toBe('0.6');
    expect(result.candidate?.turnoverPerMinute).toBe('26000');
    expect(result.candidate?.selectionStage).toBe('PRIMARY');
    expect(result.primaryCandidateCount).toBe(3);
    expect(result.degradedCandidateCount).toBe(1);
  });

  it('falls back to degraded band only when primary band has no candidates', () => {
    const result = selectBestWarrant({
      warrants: [
        createWarrantListItem({
          symbol: 'LOWER.HK',
          apiDistanceRatio: '0.0022',
          turnover: '150000',
        }),
        createWarrantListItem({
          symbol: 'BEST.HK',
          apiDistanceRatio: '0.0034',
          turnover: '160000',
        }),
        createWarrantListItem({
          symbol: 'PRIMARY.HK',
          apiDistanceRatio: '0.0036',
          turnover: '200000',
        }),
      ],
      tradingMinutes: 10,
      policy: createDirectionalPolicy('LONG'),
    });

    expect(result.candidate?.symbol).toBe('PRIMARY.HK');
    expect(result.candidate?.selectionStage).toBe('PRIMARY');
    expect(result.primaryCandidateCount).toBe(1);
    expect(result.degradedCandidateCount).toBe(2);
  });

  it('selects the degraded candidate closest to threshold when primary band is empty', () => {
    const result = selectBestWarrant({
      warrants: [
        createWarrantListItem({
          symbol: 'LOWER.HK',
          apiDistanceRatio: '0.0022',
          turnover: '150000',
        }),
        createWarrantListItem({
          symbol: 'BEST.HK',
          apiDistanceRatio: '0.003499',
          turnover: '140000',
        }),
        createWarrantListItem({
          symbol: 'TIE.HK',
          apiDistanceRatio: '0.003499',
          turnover: '180000',
        }),
      ],
      tradingMinutes: 10,
      policy: createDirectionalPolicy('LONG'),
    });

    expect(result.candidate?.symbol).toBe('TIE.HK');
    expect(result.candidate?.selectionStage).toBe('DEGRADED');
    expect(result.candidate?.distanceDeltaToThreshold).toBe('0.0001');
    expect(result.primaryCandidateCount).toBe(0);
    expect(result.degradedCandidateCount).toBe(3);
  });

  it('selects the best SHORT candidate by negative-threshold distance and turnover-per-minute', () => {
    const result = selectBestWarrant({
      warrants: [
        createWarrantListItem({
          symbol: 'FAR.HK',
          apiDistanceRatio: '-0.008',
          turnover: '200000',
        }),
        createWarrantListItem({
          symbol: 'BEST.HK',
          apiDistanceRatio: '-0.004',
          turnover: '260000',
        }),
        createWarrantListItem({
          symbol: 'TIE.HK',
          apiDistanceRatio: '-0.004',
          turnover: '220000',
        }),
        createWarrantListItem({
          symbol: 'DEGRADED.HK',
          apiDistanceRatio: '-0.003',
          turnover: '500000',
        }),
      ],
      tradingMinutes: 10,
      policy: createDirectionalPolicy('SHORT'),
    });

    expect(result.candidate?.symbol).toBe('BEST.HK');
    expect(result.candidate?.selectionStage).toBe('PRIMARY');
    expect(result.primaryCandidateCount).toBe(3);
    expect(result.degradedCandidateCount).toBe(1);
  });

  it('falls back to the closest degraded SHORT candidate when primary band is empty', () => {
    const result = selectBestWarrant({
      warrants: [
        createWarrantListItem({
          symbol: 'UPPER.HK',
          apiDistanceRatio: '-0.0022',
          turnover: '150000',
        }),
        createWarrantListItem({
          symbol: 'BEST.HK',
          apiDistanceRatio: '-0.003499',
          turnover: '160000',
        }),
        createWarrantListItem({
          symbol: 'TIE.HK',
          apiDistanceRatio: '-0.003499',
          turnover: '180000',
        }),
      ],
      tradingMinutes: 10,
      policy: createDirectionalPolicy('SHORT'),
    });

    expect(result.candidate?.symbol).toBe('TIE.HK');
    expect(result.candidate?.selectionStage).toBe('DEGRADED');
    expect(result.candidate?.distanceDeltaToThreshold).toBe('0.0001');
    expect(result.primaryCandidateCount).toBe(0);
    expect(result.degradedCandidateCount).toBe(3);
  });

  it('excludes threshold and degraded-boundary equality from both candidate bands', () => {
    const result = selectBestWarrant({
      warrants: [
        createWarrantListItem({
          symbol: 'THRESHOLD.HK',
          apiDistanceRatio: '0.0035',
          turnover: '200000',
        }),
        createWarrantListItem({
          symbol: 'BOUNDARY.HK',
          apiDistanceRatio: '0.002',
          turnover: '200000',
        }),
      ],
      tradingMinutes: 10,
      policy: createDirectionalPolicy('LONG'),
    });

    expect(result.candidate).toBeNull();
    expect(result.primaryCandidateCount).toBe(0);
    expect(result.degradedCandidateCount).toBe(0);
  });

  it('excludes SHORT threshold and degraded-boundary equality from both candidate bands', () => {
    const result = selectBestWarrant({
      warrants: [
        createWarrantListItem({
          symbol: 'THRESHOLD.HK',
          apiDistanceRatio: '-0.0035',
          turnover: '200000',
        }),
        createWarrantListItem({
          symbol: 'BOUNDARY.HK',
          apiDistanceRatio: '-0.002',
          turnover: '200000',
        }),
      ],
      tradingMinutes: 10,
      policy: createDirectionalPolicy('SHORT'),
    });

    expect(result.candidate).toBeNull();
    expect(result.primaryCandidateCount).toBe(0);
    expect(result.degradedCandidateCount).toBe(0);
  });

  it('keeps Decimal precision when comparing near-threshold candidates', () => {
    const result = selectBestWarrant({
      warrants: [
        createWarrantListItem({
          symbol: 'NEARER.HK',
          apiDistanceRatio: '0.003500000002',
          turnover: '200000',
        }),
        createWarrantListItem({
          symbol: 'FARTHER.HK',
          apiDistanceRatio: '0.003500000009',
          turnover: '500000',
        }),
      ],
      tradingMinutes: 10,
      policy: createDirectionalPolicy('LONG'),
    });

    expect(result.candidate?.symbol).toBe('NEARER.HK');
  });

  it('keeps Decimal precision when comparing near-threshold SHORT candidates', () => {
    const result = selectBestWarrant({
      warrants: [
        createWarrantListItem({
          symbol: 'NEARER.HK',
          apiDistanceRatio: '-0.003500000002',
          turnover: '200000',
        }),
        createWarrantListItem({
          symbol: 'FARTHER.HK',
          apiDistanceRatio: '-0.003500000009',
          turnover: '500000',
        }),
      ],
      tradingMinutes: 10,
      policy: createDirectionalPolicy('SHORT'),
    });

    expect(result.candidate?.symbol).toBe('NEARER.HK');
  });

  it('interprets realistic bull thresholds against api raw ratio inputs', () => {
    const result = selectBestWarrant({
      warrants: [
        createWarrantListItem({
          symbol: 'BELOW.HK',
          apiDistanceRatio: '0.0184',
          turnover: '2000000',
        }),
        createWarrantListItem({
          symbol: 'MATCH.HK',
          apiDistanceRatio: '0.0185000001',
          turnover: '2500000',
        }),
      ],
      tradingMinutes: 10,
      policy: createDirectionalPolicy('LONG', {
        primaryThreshold: '1.85',
        degradedRange: { min: '1', max: '1.85' },
        switchDistanceRange: { min: '1', max: '4' },
      }),
    });

    expect(result.candidate?.symbol).toBe('MATCH.HK');
    expect(result.candidate?.selectionStage).toBe('PRIMARY');
    expect(result.candidate?.distancePct).toBe('1.85000001');
  });

  it('interprets realistic bear thresholds against api raw ratio inputs', () => {
    const result = selectBestWarrant({
      warrants: [
        createWarrantListItem({
          symbol: 'ABOVE.HK',
          apiDistanceRatio: '-0.0184',
          turnover: '2000000',
        }),
        createWarrantListItem({
          symbol: 'MATCH.HK',
          apiDistanceRatio: '-0.0185000001',
          turnover: '2500000',
        }),
      ],
      tradingMinutes: 10,
      policy: createDirectionalPolicy('SHORT', {
        primaryThreshold: '-1.85',
        degradedRange: { min: '-1.85', max: '-1' },
        switchDistanceRange: { min: '-4', max: '-1' },
      }),
    });

    expect(result.candidate?.symbol).toBe('MATCH.HK');
    expect(result.candidate?.selectionStage).toBe('PRIMARY');
    expect(result.candidate?.distancePct).toBe('-1.85000001');
  });

  it('supports higher realistic bull thresholds without treating api raw ratios as percent values', () => {
    const result = selectBestWarrant({
      warrants: [
        createWarrantListItem({
          symbol: 'BELOW.HK',
          apiDistanceRatio: '0.0349',
          turnover: '2000000',
        }),
        createWarrantListItem({
          symbol: 'MATCH.HK',
          apiDistanceRatio: '0.035000001',
          turnover: '2500000',
        }),
      ],
      tradingMinutes: 10,
      policy: createDirectionalPolicy('LONG', {
        primaryThreshold: '3.5',
        degradedRange: { min: '2', max: '3.5' },
        switchDistanceRange: { min: '2', max: '8' },
      }),
    });

    expect(result.candidate?.symbol).toBe('MATCH.HK');
    expect(result.candidate?.selectionStage).toBe('PRIMARY');
    expect(result.candidate?.distancePct).toBe('3.5000001');
  });

  it('supports higher realistic bear thresholds without treating api raw ratios as percent values', () => {
    const result = selectBestWarrant({
      warrants: [
        createWarrantListItem({
          symbol: 'ABOVE.HK',
          apiDistanceRatio: '-0.0349',
          turnover: '2000000',
        }),
        createWarrantListItem({
          symbol: 'MATCH.HK',
          apiDistanceRatio: '-0.035000001',
          turnover: '2500000',
        }),
      ],
      tradingMinutes: 10,
      policy: createDirectionalPolicy('SHORT', {
        primaryThreshold: '-3.5',
        degradedRange: { min: '-3.5', max: '-2' },
        switchDistanceRange: { min: '-8', max: '-2' },
      }),
    });

    expect(result.candidate?.symbol).toBe('MATCH.HK');
    expect(result.candidate?.selectionStage).toBe('PRIMARY');
    expect(result.candidate?.distancePct).toBe('-3.5000001');
  });

  it('fails fast for malformed financial thresholds at policy construction boundary', () => {
    const { logger, warns } = createLoggerRecorder();
    expect(() =>
      resolveDirectionalAutoSearchPolicy({
        direction: 'LONG',
        autoSearchConfig: {
          autoSearchEnabled: true,
          autoSearchMinDistancePctBull: 'NaN',
          autoSearchMinDistancePctBear: '-0.35',
          autoSearchMinTurnoverPerMinuteBull: 'NaN',
          autoSearchMinTurnoverPerMinuteBear: '10000',
          autoSearchExpiryMinMonths: 3,
          autoSearchOpenDelayMinutes: 0,
          switchIntervalMinutes: 0,
          switchDistanceRangeBull: { min: '0.2', max: '1.5' },
          switchDistanceRangeBear: { min: '-1.5', max: '-0.2' },
        },
        monitorSymbol: 'HSI.HK',
        logPrefix: '[自动寻标] 非法策略',
        logger: {
          ...logger,
          error: (message: string) => {
            warns.push(message);
          },
        },
      }),
    ).toThrow(TypeError);
    expect(warns).toEqual([]);
  });

  it('rejects policies whose primary threshold is not strictly inside the switch range', () => {
    const { logger, warns } = createLoggerRecorder();
    const longPolicy = resolveDirectionalAutoSearchPolicy({
      direction: 'LONG',
      autoSearchConfig: {
        autoSearchEnabled: true,
        autoSearchMinDistancePctBull: '0.35',
        autoSearchMinDistancePctBear: '-0.35',
        autoSearchMinTurnoverPerMinuteBull: '10000',
        autoSearchMinTurnoverPerMinuteBear: '10000',
        autoSearchExpiryMinMonths: 3,
        autoSearchOpenDelayMinutes: 0,
        switchIntervalMinutes: 0,
        switchDistanceRangeBull: { min: '0.2', max: '0.35' },
        switchDistanceRangeBear: { min: '-1.5', max: '-0.2' },
      },
      monitorSymbol: 'HSI.HK',
      logPrefix: '[自动寻标] 非法策略',
      logger: {
        ...logger,
        error: (message: string) => {
          warns.push(message);
        },
      },
    });
    const shortPolicy = resolveDirectionalAutoSearchPolicy({
      direction: 'SHORT',
      autoSearchConfig: {
        autoSearchEnabled: true,
        autoSearchMinDistancePctBull: '0.35',
        autoSearchMinDistancePctBear: '-0.35',
        autoSearchMinTurnoverPerMinuteBull: '10000',
        autoSearchMinTurnoverPerMinuteBear: '10000',
        autoSearchExpiryMinMonths: 3,
        autoSearchOpenDelayMinutes: 0,
        switchIntervalMinutes: 0,
        switchDistanceRangeBull: { min: '0.2', max: '1.5' },
        switchDistanceRangeBear: { min: '-0.35', max: '-0.2' },
      },
      monitorSymbol: 'HSI.HK',
      logPrefix: '[自动寻标] 非法策略',
      logger: {
        ...logger,
        error: (message: string) => {
          warns.push(message);
        },
      },
    });

    expect(longPolicy).toBeNull();
    expect(shortPolicy).toBeNull();
    expect(
      warns.some((message) => message.includes('主阈值未严格落在换标安全区间内部')),
    ).toBeTrue();
  });

  it('forwards full finder filters through the neutral MarketQuoteContext boundary', async () => {
    const requests: Array<Parameters<MarketQuoteContext['warrantList']>[0]> = [];
    const ctx: MarketQuoteContext = {
      warrantQuote: async () => [],
      warrantList: async (request) => {
        requests.push(request);
        return [];
      },
    };
    const { logger } = createLoggerRecorder();
    await findBestWarrant({
      ctx,
      monitorSymbol: 'HSI.HK',
      tradingMinutes: 10,
      policy: createDirectionalPolicy('LONG'),
      expiryMinMonths: 3,
      logger,
    });

    expect(requests).toEqual([
      {
        symbol: 'HSI.HK',
        sortBy: 'TURNOVER',
        sortOrder: 'DESCENDING',
        types: ['BULL'],
        issuerIds: null,
        expiryFilters: ['MONTHS_3_TO_6', 'MONTHS_6_TO_12', 'OVER_12_MONTHS'],
        inOutBoundsTypes: ['IN'],
        status: ['NORMAL'],
      },
    ]);
  });

  it('reuses cache within TTL and re-fetches after expiry for the same monitor symbol and direction', async () => {
    const items = [
      toWarrantInfo(
        createWarrantListItem({
          symbol: 'BULL-1.HK',
          apiDistanceRatio: '0.0055',
          turnover: '300000',
        }),
      ),
    ];
    let queries = 0;
    const ctx: MarketQuoteContext = {
      warrantQuote: async () => [],
      warrantList: async () => {
        queries += 1;
        return items;
      },
    };
    let nowMs = 1_000;
    const cache = createWarrantListCache();
    const { logger } = createLoggerRecorder();
    const baseInput = {
      ctx,
      monitorSymbol: 'HSI.HK',
      tradingMinutes: 10,
      policy: createDirectionalPolicy('LONG'),
      expiryMinMonths: 3,
      logger,
      cacheConfig: { cache, ttlMs: 3_000, nowMs: () => nowMs },
    };
    const first = await findBestWarrant(baseInput);
    nowMs = 2_000;
    const second = await findBestWarrant(baseInput);
    expect(first?.symbol).toBe('BULL-1.HK');
    expect(second?.symbol).toBe('BULL-1.HK');
    expect(queries).toBe(1);
    nowMs = 5_500;
    await findBestWarrant(baseInput);
    expect(queries).toBe(2);
  });

  it('shares one exhausted read-port failure across same-key calls and reuses the next success from cache', async () => {
    const items = [
      toWarrantInfo(
        createWarrantListItem({
          symbol: 'BULL-1.HK',
          apiDistanceRatio: '0.0055',
          turnover: '300000',
        }),
      ),
    ];
    const cause = new Error('service unavailable');
    const exhausted = await createExternalApiRequestError({
      operation: 'QuoteContext.warrantList',
      attempts: 3,
      cause,
    });
    let queries = 0;
    const ctx: MarketQuoteContext = {
      warrantQuote: async () => [],
      warrantList: async () => {
        queries += 1;
        if (queries === 1) throw exhausted;

        return items;
      },
    };
    const { logger } = createLoggerRecorder();
    const cache = createWarrantListCache();
    const baseInput = {
      ctx,
      monitorSymbol: 'HSI.HK',
      tradingMinutes: 10,
      policy: createDirectionalPolicy('LONG'),
      expiryMinMonths: 3,
      logger,
      cacheConfig: { cache, ttlMs: 3_000, nowMs: () => 1_000 },
    };
    const results = await Promise.allSettled([
      findBestWarrant(baseInput),
      findBestWarrant(baseInput),
    ]);
    const [first, second] = results;
    expect(first.status).toBe('rejected');
    expect(second.status).toBe('rejected');
    if (first.status !== 'rejected' || second.status !== 'rejected')
      throw new Error('expected both requests to reject');

    expect(first.reason).toBe(exhausted);
    expect(second.reason).toBe(first.reason);
    expect(isExternalApiRequestError(first.reason)).toBeTrue();
    expect(first.reason).toMatchObject({
      name: 'ExternalApiRequestError',
      operation: 'QuoteContext.warrantList',
      attempts: 3,
    });
    expect(exhausted.cause).toBe(cause);
    expect(queries).toBe(1);
    const next = await findBestWarrant(baseInput);
    expect(next?.symbol).toBe('BULL-1.HK');
    expect(queries).toBe(2);
    const cached = await findBestWarrant(baseInput);
    expect(cached?.symbol).toBe('BULL-1.HK');
    expect(queries).toBe(2);
  });

  it.each([{ callPrice: 'NaN' }, { turnover: 'Infinity' }, { toCallPrice: '2e-3' }])(
    'rejects malformed NORMAL candidate financial fields before no-candidate fallback: %j',
    async (invalidFields) => {
      const { logger, warns } = createLoggerRecorder();
      const item = toWarrantInfo(
        createWarrantListItem({
          symbol: 'MALFORMED.HK',
          apiDistanceRatio: '0.005',
          turnover: '300000',
          status: 'NORMAL',
        }),
      );
      const ctx: MarketQuoteContext = {
        warrantQuote: async () => [],
        warrantList: async () => [{ ...item, ...invalidFields }],
      };
      await rejects(
        findBestWarrant({
          ctx,
          monitorSymbol: 'HSI.HK',
          tradingMinutes: 10,
          policy: createDirectionalPolicy('LONG'),
          expiryMinMonths: 3,
          logger,
        }),
        TypeError,
      );
      expect(warns).toEqual([]);
    },
  );

  it('preserves the original internal read failure identity instead of returning an empty candidate', async () => {
    const internalError = new TypeError('internal warrant projection invariant');
    const item = toWarrantInfo(
      createWarrantListItem({
        symbol: 'BROKEN.HK',
        apiDistanceRatio: '0.005',
        turnover: '300000',
        status: 'NORMAL',
      }),
    );
    Object.defineProperty(item, 'callPrice', {
      get: () => {
        throw internalError;
      },
    });
    const { logger, warns } = createLoggerRecorder();
    const ctx: MarketQuoteContext = {
      warrantQuote: async () => [],
      warrantList: async () => [item],
    };
    await rejects(
      findBestWarrant({
        ctx,
        monitorSymbol: 'HSI.HK',
        tradingMinutes: 10,
        policy: createDirectionalPolicy('LONG'),
        expiryMinMonths: 3,
        logger,
      }),
      (error: unknown) => error === internalError,
    );
    expect(warns).toEqual([]);
  });

  it('returns null and logs when no warrant can satisfy business thresholds', async () => {
    const ctx: MarketQuoteContext = {
      warrantQuote: async () => [],
      warrantList: async () => [
        toWarrantInfo(
          createWarrantListItem({
            symbol: 'LOW-DIST.HK',
            apiDistanceRatio: '0.002',
            turnover: '1000000',
          }),
        ),
      ],
    };
    const { logger, warns } = createLoggerRecorder();
    expect(
      await findBestWarrant({
        ctx,
        monitorSymbol: 'HSI.HK',
        tradingMinutes: 10,
        policy: createDirectionalPolicy('LONG'),
        expiryMinMonths: 3,
        logger,
      }),
    ).toBeNull();
    expect(warns.some((msg) => msg.includes('主条件与降级条件均未命中'))).toBeTrue();
  });
});
