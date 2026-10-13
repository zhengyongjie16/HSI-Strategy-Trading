/**
 * 运行期自动寻标旧 owner 隔离测试。
 * 授权关闭、交易日 closure 或席位版本变化后，晚到候选/null/外部失败不落账；内部错误仍必须暴露。
 */
import { describe, expect, it } from 'bun:test';
import { rejects } from 'node:assert/strict';
import { createAutoSearch } from '../../../src/application/autoSearch/index.js';
import { createWarrantCandidateSearch } from '../../../src/application/autoSearch/candidateSearch.js';
import { createSymbolRegistry } from '../../../src/domain/seat/symbolRegistry.js';
import type { AutoSearchCandidate } from '../../../src/application/autoSearch/types.js';
import { createExternalApiRequestError } from '../../helpers/createExternalApiRequestError.js';
import { createMonitorConfigDouble } from '../../helpers/testDoubles.js';
import {
  createLoggerStub,
  createWarrantCandidate,
  getDefaultAutoSearchConfig,
} from '../../helpers/seatTestUtils.js';

const currentTime = new Date('2026-04-10T02:00:00.000Z');

function createHarness(findCandidate: () => Promise<AutoSearchCandidate | null>) {
  const config = createMonitorConfigDouble({ autoSearchConfig: getDefaultAutoSearchConfig() });
  const registry = createSymbolRegistry(config);
  let authorized = true;
  const owner = createAutoSearch({
    monitorSymbol: config.monitorSymbol,
    autoSearchConfig: config.autoSearchConfig,
    symbolRegistry: registry,
    candidateSearch: { resolveDistanceRange: () => ({ min: '0.2', max: '1.5' }), findCandidate },
    logger: createLoggerStub(),
  });
  return {
    registry,
    owner,
    canContinue: () => authorized,
    closeAuthorization: () => {
      authorized = false;
    },
  };
}

describe('autoSearch stale result isolation', () => {
  it.each(['candidate', 'null'] as const)(
    'does not commit a late %s result after authorization closes',
    async (kind) => {
      const result = Promise.withResolvers<AutoSearchCandidate | null>();
      const harness = createHarness(() => result.promise);
      const search = harness.owner.maybeSearchOnEvent({
        direction: 'LONG',
        currentTime,
        canContinue: harness.canContinue,
      });
      expect(harness.registry.getSeatState('LONG').status).toBe('SEARCHING');
      harness.closeAuthorization();
      result.resolve(kind === 'candidate' ? createWarrantCandidate('STALE.HK') : null);
      await search;
      expect(harness.registry.getSeatState('LONG')).toMatchObject({
        symbol: null,
        status: 'SEARCHING',
        searchFailCountToday: 0,
      });
      expect(harness.registry.getSeatVersion('LONG')).toBe(1);
    },
  );

  it('does not count late external failure, while stale internal failure keeps its identity', async () => {
    const external = await createExternalApiRequestError({
      operation: 'QuoteContext.warrantList',
      attempts: 3,
      cause: new Error('network unavailable'),
    });
    const internal = new TypeError('candidate internal invariant');
    for (const failure of [external, internal]) {
      const result = Promise.withResolvers<AutoSearchCandidate | null>();
      const harness = createHarness(() => result.promise);
      const search = harness.owner.maybeSearchOnEvent({
        direction: 'LONG',
        currentTime,
        canContinue: harness.canContinue,
      });
      harness.closeAuthorization();
      result.reject(failure);
      await (failure === internal
        ? rejects(search, (error: unknown) => error === internal)
        : search);

      expect(harness.registry.getSeatState('LONG').searchFailCountToday).toBe(0);
    }
  });

  it('uses the captured trading-day closure and cannot reauthorize an old candidate on a new day', async () => {
    const result = Promise.withResolvers<AutoSearchCandidate | null>();
    const harness = createHarness(() => result.promise);
    let dayEpoch = 1;
    const captured = dayEpoch;
    const search = harness.owner.maybeSearchOnEvent({
      direction: 'LONG',
      currentTime,
      canContinue: () => dayEpoch === captured,
    });
    dayEpoch += 1;
    result.resolve(createWarrantCandidate('STALE.HK'));
    await search;
    expect(harness.registry.getSeatState('LONG')).toMatchObject({
      status: 'SEARCHING',
      symbol: null,
      searchFailCountToday: 0,
    });
  });

  it('cannot overwrite a successor SEARCHING owner with a newer seat identity', async () => {
    const result = Promise.withResolvers<AutoSearchCandidate | null>();
    const harness = createHarness(() => result.promise);
    const search = harness.owner.maybeSearchOnEvent({
      direction: 'LONG',
      currentTime,
      canContinue: harness.canContinue,
    });
    harness.registry.updateSeatStateWithVersionBump('LONG', {
      symbol: null,
      status: 'SEARCHING',
      lastSwitchAt: null,
      lastSearchAt: currentTime.getTime() + 1,
      lastSeatActivatedAt: null,
      callPrice: null,
      searchFailCountToday: 2,
      frozenTradingDayKey: null,
    });
    result.resolve(createWarrantCandidate('STALE.HK'));
    await search;
    expect(harness.registry.getSeatState('LONG')).toMatchObject({
      status: 'SEARCHING',
      symbol: null,
      searchFailCountToday: 2,
      lastSearchAt: currentTime.getTime() + 1,
    });
    expect(harness.registry.getSeatVersion('LONG')).toBe(2);
  });

  it('stops the real candidate query after context acquisition loses authorization', async () => {
    const config = createMonitorConfigDouble({ autoSearchConfig: getDefaultAutoSearchConfig() });
    const registry = createSymbolRegistry(config);
    const context = Promise.withResolvers<{
      warrantQuote: () => Promise<[]>;
      warrantList: () => Promise<[]>;
    }>();
    let authorized = true;
    let reads = 0;
    const candidateSearch = createWarrantCandidateSearch({
      monitorSymbol: config.monitorSymbol,
      autoSearchConfig: config.autoSearchConfig,
      marketDataClient: { getQuoteContext: () => context.promise },
      logger: createLoggerStub(),
      getTradingMinutesSinceOpen: () => 10,
    });
    const owner = createAutoSearch({
      monitorSymbol: config.monitorSymbol,
      autoSearchConfig: config.autoSearchConfig,
      symbolRegistry: registry,
      candidateSearch,
      logger: createLoggerStub(),
    });
    const search = owner.maybeSearchOnEvent({
      direction: 'LONG',
      currentTime,
      canContinue: () => authorized,
    });
    authorized = false;
    context.resolve({
      warrantQuote: async () => [],
      warrantList: async () => {
        reads += 1;
        return [];
      },
    });
    await search;
    expect(reads).toBe(0);
    expect(registry.getSeatState('LONG').searchFailCountToday).toBe(0);
  });
});
