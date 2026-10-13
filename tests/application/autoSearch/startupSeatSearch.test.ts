/**
 * 启动补席搜索政策测试。
 * 验证无候选计数/冻结、异常不计数、成功保真，以及迟到结果不能写入后继席位。
 */
import { describe, expect, it } from 'bun:test';
import { rejects } from 'node:assert/strict';
import { createStartupSeatSearch } from '../../../src/application/autoSearch/startupSeatSearch.js';
import { createSymbolRegistry } from '../../../src/domain/seat/symbolRegistry.js';
import type { WarrantCandidateSearch } from '../../../src/application/autoSearch/types.js';
import { createExternalApiRequestError } from '../../helpers/createExternalApiRequestError.js';
import { createMonitorConfigDouble } from '../../helpers/testDoubles.js';
import { createLoggerStub, getDefaultAutoSearchConfig } from '../../helpers/seatTestUtils.js';

const currentTime = new Date('2026-02-16T02:00:00.000Z');

function createHarness(findCandidate: WarrantCandidateSearch['findCandidate']) {
  const config = createMonitorConfigDouble({ autoSearchConfig: getDefaultAutoSearchConfig() });
  const registry = createSymbolRegistry(config);
  registry.updateSeatState('LONG', {
    symbol: null,
    status: 'EMPTY',
    lastSwitchAt: null,
    lastSearchAt: null,
    lastSeatActivatedAt: null,
    callPrice: null,
    searchFailCountToday: 2,
    frozenTradingDayKey: null,
  });
  const search = createStartupSeatSearch({
    monitorSymbol: config.monitorSymbol,
    symbolRegistry: registry,
    candidateSearch: {
      resolveDistanceRange: () => ({ min: '0.2', max: '1.5' }),
      findCandidate,
    },
    logger: createLoggerStub(),
  });
  return { search, registry };
}

describe('startup seat search policy', () => {
  it('counts completed no-candidate searches and freezes rather than retrying within the use case', async () => {
    let calls = 0;
    const { search, registry } = createHarness(async () => {
      calls += 1;
      return null;
    });
    await search.searchSeat({ direction: 'LONG', currentTime, canContinue: () => true });
    await search.searchSeat({ direction: 'LONG', currentTime, canContinue: () => true });
    expect(calls).toBe(1);
    expect(registry.getSeatState('LONG')).toMatchObject({
      status: 'EMPTY',
      searchFailCountToday: 3,
      frozenTradingDayKey: '2026-02-16',
    });
  });

  it('restores EMPTY without counting either external or internal exceptions and rethrows the original identity', async () => {
    const external = await createExternalApiRequestError({
      operation: 'QuoteContext.warrantList',
      attempts: 3,
      cause: new Error('network unavailable'),
    });
    for (const error of [external, new TypeError('malformed neutral facts')]) {
      const { search, registry } = createHarness(async () => {
        throw error;
      });
      await rejects(
        search.searchSeat({ direction: 'LONG', currentTime, canContinue: () => true }),
        (actual: unknown) => actual === error,
      );

      expect(registry.getSeatState('LONG')).toMatchObject({
        symbol: null,
        status: 'EMPTY',
        lastSearchAt: currentTime.getTime(),
        searchFailCountToday: 2,
        frozenTradingDayKey: null,
      });
    }
  });

  it('publishes the exact call price to ACTIVATING and clears failures without completing activation', async () => {
    const { search, registry } = createHarness(async () => ({
      symbol: 'NEW.HK',
      callPrice: '20000.1234567890123456789',
    }));
    expect(
      await search.searchSeat({ direction: 'LONG', currentTime, canContinue: () => true }),
    ).toBe('NEW.HK');

    expect(registry.getSeatState('LONG')).toMatchObject({
      symbol: 'NEW.HK',
      status: 'ACTIVATING',
      callPrice: '20000.1234567890123456789',
      lastSeatActivatedAt: null,
      searchFailCountToday: 0,
    });
  });

  it('does not overwrite a successor seat or count a late no-candidate result', async () => {
    const pending = Promise.withResolvers<null>();
    const { search, registry } = createHarness(() => pending.promise);
    const running = search.searchSeat({ direction: 'LONG', currentTime, canContinue: () => true });
    registry.updateSeatStateWithVersionBump('LONG', {
      symbol: 'SUCCESSOR.HK',
      status: 'ACTIVATING',
      lastSwitchAt: currentTime.getTime(),
      lastSearchAt: currentTime.getTime(),
      lastSeatActivatedAt: null,
      callPrice: '21000',
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    });
    const successor = registry.getSeatState('LONG');
    pending.resolve(null);
    expect(await running).toBeNull();
    expect(registry.getSeatState('LONG')).toEqual(successor);
  });
});
