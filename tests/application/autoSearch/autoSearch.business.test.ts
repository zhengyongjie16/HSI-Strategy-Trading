/**
 * 运行期空席位自动寻标业务测试。
 * 覆盖真实 registry 的 SEARCHING/ACTIVATING、失败冻结、准入与冷却；不借换标状态管理器提交席位。
 */
import { describe, expect, it } from 'bun:test';
import { rejects } from 'node:assert/strict';
import { createAutoSearch } from '../../../src/application/autoSearch/index.js';
import { createSymbolRegistry } from '../../../src/domain/seat/symbolRegistry.js';
import { AUTO_SYMBOL_SEARCH_COOLDOWN_MS } from '../../../src/constants/common.js';
import type {
  AutoSearchDeps,
  WarrantCandidateSearch,
} from '../../../src/application/autoSearch/types.js';
import { createExternalApiRequestError } from '../../helpers/createExternalApiRequestError.js';
import { createMonitorConfigDouble } from '../../helpers/testDoubles.js';
import {
  captureSearchSeatAuthorization,
  createLoggerStub,
  createWarrantCandidate,
  getDefaultAutoSearchConfig,
} from '../../helpers/seatTestUtils.js';

const currentTime = new Date('2026-02-16T02:00:00.000Z');

function createHarness(
  params: Readonly<{
    failures?: number;
    lastSearchAt?: number | null;
    frozenTradingDayKey?: string | null;
    candidateSearch?: Partial<WarrantCandidateSearch>;
    autoSearchConfig?: Partial<AutoSearchDeps['autoSearchConfig']>;
  }> = {},
) {
  const config = createMonitorConfigDouble({
    autoSearchConfig: { ...getDefaultAutoSearchConfig(), ...params.autoSearchConfig },
  });
  const registry = createSymbolRegistry(config);
  registry.updateSeatState('LONG', {
    symbol: null,
    status: 'EMPTY',
    lastSwitchAt: null,
    lastSearchAt: params.lastSearchAt ?? null,
    lastSeatActivatedAt: null,
    callPrice: null,
    searchFailCountToday: params.failures ?? 0,
    frozenTradingDayKey: params.frozenTradingDayKey ?? null,
  });
  const candidateSearch: WarrantCandidateSearch = {
    resolveDistanceRange: () => ({ min: '0.2', max: '1.5' }),
    findCandidate: async () => createWarrantCandidate('NEW.HK'),
    ...params.candidateSearch,
  };
  const owner = createAutoSearch({
    monitorSymbol: config.monitorSymbol,
    autoSearchConfig: config.autoSearchConfig,
    symbolRegistry: registry,
    candidateSearch,
    logger: createLoggerStub(),
  });
  return { owner, registry, candidateSearch };
}

describe('runtime empty-seat autoSearch owner', () => {
  it.each(['LONG', 'SHORT'] as const)(
    'binds %s to ACTIVATING with a new identity and resets counters',
    async (direction) => {
      const { owner, registry } = createHarness({ failures: 1 });
      await owner.maybeSearchOnEvent({
        direction,
        currentTime,
        canContinue: captureSearchSeatAuthorization(registry, direction),
      });

      expect(registry.getSeatState(direction)).toMatchObject({
        symbol: 'NEW.HK',
        status: 'ACTIVATING',
        callPrice: '21000',
        lastSeatActivatedAt: null,
        lastSearchAt: currentTime.getTime(),
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      });
      expect(registry.getSeatVersion(direction)).toBe(2);
    },
  );

  it('counts current-owner external failure without rethrowing and hands retry to the cooldown runtime', async () => {
    const external = await createExternalApiRequestError({
      operation: 'QuoteContext.warrantList',
      attempts: 3,
      cause: new Error('network unavailable'),
    });
    let searches = 0;
    const { owner, registry } = createHarness({
      failures: 1,
      candidateSearch: {
        findCandidate: async () => {
          searches += 1;
          throw external;
        },
      },
    });
    const canContinue = captureSearchSeatAuthorization(registry, 'LONG');
    await owner.maybeSearchOnEvent({ direction: 'LONG', currentTime, canContinue });
    expect(registry.getSeatState('LONG')).toMatchObject({
      status: 'EMPTY',
      searchFailCountToday: 2,
      frozenTradingDayKey: null,
    });

    await owner.maybeSearchOnEvent({
      direction: 'LONG',
      currentTime: new Date(currentTime.getTime() + 1),
      canContinue,
    });
    expect(searches).toBe(1);
  });

  it('counts an internal candidate-build/read error before exposing its original identity', async () => {
    const failure = new TypeError('candidate input contract');
    const { owner, registry } = createHarness({
      failures: 2,
      candidateSearch: {
        findCandidate: async () => {
          throw failure;
        },
      },
    });
    await rejects(
      owner.maybeSearchOnEvent({
        direction: 'LONG',
        currentTime,
        canContinue: captureSearchSeatAuthorization(registry, 'LONG'),
      }),
      (error: unknown) => error === failure,
    );

    expect(registry.getSeatState('LONG')).toMatchObject({
      symbol: null,
      status: 'EMPTY',
      searchFailCountToday: 3,
      frozenTradingDayKey: '2026-02-16',
    });
  });

  it('freezes after a completed no-candidate search and performs no further search that day', async () => {
    let searches = 0;
    const { owner, registry } = createHarness({
      failures: 2,
      candidateSearch: {
        findCandidate: async () => {
          searches += 1;
          return null;
        },
      },
    });
    const canContinue = captureSearchSeatAuthorization(registry, 'LONG');
    await owner.maybeSearchOnEvent({ direction: 'LONG', currentTime, canContinue });
    await owner.maybeSearchOnEvent({
      direction: 'LONG',
      currentTime: new Date(currentTime.getTime() + AUTO_SYMBOL_SEARCH_COOLDOWN_MS),
      canContinue,
    });
    expect(searches).toBe(1);
    expect(registry.getSeatState('LONG')).toMatchObject({
      status: 'EMPTY',
      searchFailCountToday: 3,
      frozenTradingDayKey: '2026-02-16',
    });
    expect(registry.getSeatVersion('LONG')).toBe(1);
  });

  it('retains inclusive cooldown expiry: just before expiry skips and equality searches', async () => {
    let searches = 0;
    const { owner, registry } = createHarness({
      lastSearchAt: currentTime.getTime() - AUTO_SYMBOL_SEARCH_COOLDOWN_MS + 1,
      candidateSearch: {
        findCandidate: async () => {
          searches += 1;
          return null;
        },
      },
    });
    const canContinue = captureSearchSeatAuthorization(registry, 'LONG');
    await owner.maybeSearchOnEvent({ direction: 'LONG', currentTime, canContinue });
    expect(searches).toBe(0);
    await owner.maybeSearchOnEvent({
      direction: 'LONG',
      currentTime: new Date(currentTime.getTime() + 1),
      canContinue,
    });
    expect(searches).toBe(1);
  });

  it('skips disabled, unauthorized, frozen and invalid-policy searches without counting a failure', async () => {
    for (const scenario of ['disabled', 'unauthorized', 'frozen', 'invalid-policy'] as const) {
      let searches = 0;
      const { owner, registry } = createHarness({
        failures: 1,
        autoSearchConfig: { autoSearchEnabled: scenario !== 'disabled' },
        frozenTradingDayKey: scenario === 'frozen' ? '2026-02-16' : null,
        candidateSearch: {
          resolveDistanceRange: () =>
            scenario === 'invalid-policy' ? null : { min: '0.2', max: '1.5' },
          findCandidate: async () => {
            searches += 1;
            return null;
          },
        },
      });
      await owner.maybeSearchOnEvent({
        direction: 'LONG',
        currentTime,
        canContinue: () => scenario !== 'unauthorized',
      });
      expect(searches).toBe(0);
      expect(registry.getSeatState('LONG')).toMatchObject({
        status: 'EMPTY',
        lastSearchAt: null,
        searchFailCountToday: 1,
      });
    }
  });

  it('applies open delay only in the morning and not at the afternoon open', async () => {
    let searches = 0;
    const { owner, registry } = createHarness({
      autoSearchConfig: { autoSearchOpenDelayMinutes: 10 },
      candidateSearch: {
        findCandidate: async () => {
          searches += 1;
          return null;
        },
      },
    });
    const canContinue = captureSearchSeatAuthorization(registry, 'LONG');
    await owner.maybeSearchOnEvent({
      direction: 'LONG',
      currentTime: new Date('2026-02-16T01:35:00.000Z'),
      canContinue,
    });
    expect(searches).toBe(0);
    expect(registry.getSeatState('LONG').searchFailCountToday).toBe(0);
    await owner.maybeSearchOnEvent({
      direction: 'LONG',
      currentTime: new Date('2026-02-16T05:00:00.000Z'),
      canContinue,
    });
    expect(searches).toBe(1);
  });
});
