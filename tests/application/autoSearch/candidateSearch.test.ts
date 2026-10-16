/**
 * 共享候选搜索编排测试。
 * 验证窄 market port、精确金融文本、无席位/计数副作用、异步准入及内部错误先于过期判断。
 */
import { describe, expect, it } from 'bun:test';
import { rejects } from 'node:assert/strict';
import { createWarrantCandidateSearch } from '../../../src/application/autoSearch/candidateSearch.js';
import type { MarketQuoteContext, MarketWarrantListItem } from '../../../src/types/marketPorts.js';
import type { AutoSearchConfig } from '../../../src/types/config.js';
import type { Logger } from '../../../src/types/logger.js';
import { createExternalApiRequestError } from '../../helpers/createExternalApiRequestError.js';
import { getDefaultAutoSearchConfig } from '../../helpers/seatTestUtils.js';

function createLoggerRecorder() {
  const warns: string[] = [];
  const infos: string[] = [];
  const errors: string[] = [];
  const logger: Logger = {
    debug: () => {},
    info: (message) => {
      infos.push(message);
    },
    warn: (message) => {
      warns.push(message);
    },
    error: (message) => {
      errors.push(message);
    },
  };
  return { logger, warns, infos, errors };
}

function createWarrant(overrides: Partial<MarketWarrantListItem> = {}): MarketWarrantListItem {
  return {
    symbol: 'BULL-1.HK',
    name: 'BULL-1.HK',
    lastDone: '0.07',
    callPrice: '20000.1234567890123456789',
    toCallPrice: '0.003500000000000000001',
    turnover: '3000000.000000000000000001',
    warrantType: 'BULL',
    status: 'NORMAL',
    ...overrides,
  };
}

function createSearch(ctx: MarketQuoteContext, overrides: Partial<AutoSearchConfig> = {}) {
  const logs = createLoggerRecorder();
  const search = createWarrantCandidateSearch({
    monitorSymbol: 'HSI.HK',
    autoSearchConfig: { ...getDefaultAutoSearchConfig(), ...overrides },
    marketDataClient: { getQuoteContext: async () => ctx },
    logger: logs.logger,
    getTradingMinutesSinceOpen: () => 10,
  });
  return { search, ...logs };
}

const currentTime = new Date('2026-04-10T02:00:00.000Z');

describe('shared warrant candidate search', () => {
  it.each(['LONG', 'SHORT'] as const)(
    'forwards full %s filters through the actual neutral read port',
    async (direction) => {
      const requests: Array<Parameters<MarketQuoteContext['warrantList']>[0]> = [];
      const { search } = createSearch({
        warrantQuote: async () => [],
        warrantList: async (request) => {
          requests.push(request);
          return [];
        },
      });
      await search.findCandidate({ direction, currentTime, canContinue: () => true });
      expect(requests).toEqual([
        {
          symbol: 'HSI.HK',
          sortBy: 'TURNOVER',
          sortOrder: 'DESCENDING',
          types: [direction === 'LONG' ? 'BULL' : 'BEAR'],
          issuerIds: null,
          expiryFilters: ['MONTHS_3_TO_6', 'MONTHS_6_TO_12', 'OVER_12_MONTHS'],
          inOutBoundsTypes: ['IN'],
          status: ['NORMAL'],
        },
      ]);
    },
  );

  it('returns exact facts while rounded financial logs never flow back to selection', async () => {
    const { search, infos } = createSearch({
      warrantQuote: async () => [],
      warrantList: async () => [createWarrant()],
    });
    const result = await search.findCandidate({
      direction: 'LONG',
      currentTime,
      canContinue: () => true,
    });
    expect(result).toEqual({
      symbol: 'BULL-1.HK',
      callPrice: '20000.1234567890123456789',
    });
    expect(infos[0]).toContain('selectionStage=PRIMARY');
    expect(infos[0]).toContain('distancePct=0.35%');
  });

  it('shares validated policy and returns exact range; business-invalid config skips IO and logs once', async () => {
    let reads = 0;
    const { search, errors } = createSearch(
      {
        warrantQuote: async () => [],
        warrantList: async () => {
          reads += 1;
          return [];
        },
      },
      { switchDistanceRangeBull: { min: '0.2', max: '0.35' } },
    );
    expect(search.resolveDistanceRange('LONG')).toBeNull();
    expect(
      await search.findCandidate({ direction: 'LONG', currentTime, canContinue: () => true }),
    ).toBeNull();
    expect(reads).toBe(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('主阈值未严格落在换标安全区间内部');
    expect(search.resolveDistanceRange('SHORT')).toEqual({ min: '-1.5', max: '-0.2' });
  });

  it('exposes malformed policy without logging it as an ordinary business rejection', () => {
    const { search, errors } = createSearch(
      { warrantQuote: async () => [], warrantList: async () => [] },
      { autoSearchMinDistancePctBull: 'NaN' },
    );
    expect(() => search.resolveDistanceRange('LONG')).toThrow(TypeError);
    expect(errors).toEqual([]);
  });

  it.each([{ callPrice: 'NaN' }, { turnover: 'Infinity' }, { toCallPrice: '2e-3' }])(
    'rejects malformed facts without no-candidate log: %j',
    async (patch) => {
      const { search, warns } = createSearch({
        warrantQuote: async () => [],
        warrantList: async () => [createWarrant(patch)],
      });
      await rejects(
        search.findCandidate({ direction: 'LONG', currentTime, canContinue: () => true }),
        TypeError,
      );
      expect(warns).toEqual([]);
    },
  );

  it('preserves both internal and classified external read failure identities for each entry policy', async () => {
    const internal = new TypeError('internal warrant invariant');
    const external = await createExternalApiRequestError({
      operation: 'QuoteContext.warrantList',
      attempts: 3,
      cause: new Error('network unavailable'),
    });
    for (const failure of [internal, external]) {
      const { search, warns } = createSearch({
        warrantQuote: async () => [],
        warrantList: async () => {
          throw failure;
        },
      });
      await rejects(
        search.findCandidate({ direction: 'LONG', currentTime, canContinue: () => true }),
        (error: unknown) => error === failure,
      );
      expect(warns).toEqual([]);
    }
  });

  it('does not emit a late valid candidate, but still exposes corrupted late financial facts', async () => {
    for (const corrupt of [false, true]) {
      let authorized = true;
      const result = Promise.withResolvers<ReadonlyArray<MarketWarrantListItem>>();
      const { search, warns, infos } = createSearch({
        warrantQuote: async () => [],
        warrantList: () => result.promise,
      });
      const query = search.findCandidate({
        direction: 'LONG',
        currentTime,
        canContinue: () => authorized,
      });
      await Promise.resolve();
      authorized = false;
      result.resolve([createWarrant(corrupt ? { turnover: 'broken' } : {})]);
      if (corrupt) await rejects(query, TypeError);
      else expect(await query).toBeNull();

      expect(warns).toEqual([]);
      expect(infos).toEqual([]);
    }
  });

  it('logs no candidate only after both layers are empty and has no entry-side state to mutate', async () => {
    const { search, warns } = createSearch({
      warrantQuote: async () => [],
      warrantList: async () => [createWarrant({ toCallPrice: '0.002' })],
    });
    expect(
      await search.findCandidate({ direction: 'LONG', currentTime, canContinue: () => true }),
    ).toBeNull();
    expect(warns[0]).toContain('主条件与降级条件均未命中');
  });
});
