/**
 * autoSearch 异步 owner 一致性业务测试
 *
 * 覆盖：自动寻标跨异步边界后必须重新确认实时普通交易授权、席位版本与 SEARCHING owner，
 * 失效外部结果不得推进席位或写入失败事实，内部错误仍必须暴露。
 */
import { describe, expect, it } from 'bun:test';
import { findBestWarrant } from '../../../src/services/autoSymbolFinder/index.js';
import { createAutoSearch } from '../../../src/services/autoSymbolManager/autoSearch.js';
import { createSeatStateManager } from '../../../src/services/autoSymbolManager/seatStateManager.js';
import { createSymbolRegistry } from '../../../src/services/autoSymbolManager/utils.js';
import type {
  SwitchState,
  SwitchSuppression,
} from '../../../src/services/autoSymbolManager/types.js';
import type {
  FindBestWarrantInput,
  WarrantCandidate,
} from '../../../src/services/autoSymbolFinder/types.js';
import { createExternalApiRequestError } from '../../helpers/createExternalApiRequestError.js';
import { getHKDateKey } from '../../../src/utils/time/index.js';
import { createMonitorConfigDouble, createQuoteContextDouble } from '../../helpers/testDoubles.js';
import {
  captureSearchSeatAuthorization,
  createDirectionalAutoSearchPolicy,
  createFindBestWarrantInputDouble,
  createLoggerStub,
  createWarrantCandidate,
  getDefaultAutoSearchConfig,
} from './utils.js';

type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}>;

type Finder = (input: FindBestWarrantInput) => Promise<WarrantCandidate | null>;

function createDeferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T | PromiseLike<T>) => void) | null = null;
  let rejectPromise: ((reason?: unknown) => void) | null = null;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  return {
    promise,
    resolve(value: T): void {
      if (resolvePromise === null) {
        throw new Error('deferred resolver is unavailable');
      }

      resolvePromise(value);
    },
    reject(reason: unknown): void {
      if (rejectPromise === null) {
        throw new Error('deferred rejecter is unavailable');
      }

      rejectPromise(reason);
    },
  };
}

function createAutoSearchHarness(params: {
  readonly currentTime: Date;
  readonly findBestWarrant: Finder;
  readonly buildFindBestWarrantInput?: () => Promise<FindBestWarrantInput>;
  readonly searchFailCountToday?: number;
}) {
  const monitorConfig = createMonitorConfigDouble({
    autoSearchConfig: getDefaultAutoSearchConfig(),
  });
  const symbolRegistry = createSymbolRegistry(monitorConfig);
  symbolRegistry.updateSeatState('LONG', {
    symbol: null,
    status: 'EMPTY',
    lastSwitchAt: null,
    lastSearchAt: null,
    lastSeatActivatedAt: null,
    callPrice: null,
    searchFailCountToday: params.searchFailCountToday ?? 0,
    frozenTradingDayKey: null,
  });
  const seatStateManager = createSeatStateManager({
    symbolRegistry,
    switchStates: new Map<'LONG' | 'SHORT', SwitchState>(),
    switchSuppressions: new Map<'LONG' | 'SHORT', SwitchSuppression>(),
    now: () => params.currentTime,
    logger: createLoggerStub(),
    getHKDateKey,
  });
  const autoSearch = createAutoSearch({
    autoSearchConfig: monitorConfig.autoSearchConfig,
    monitorSymbol: monitorConfig.monitorSymbol,
    symbolRegistry,
    updateSeatState: seatStateManager.updateSeatState,
    resolveDirectionalAutoSearchPolicy: () => createDirectionalAutoSearchPolicy('LONG'),
    buildFindBestWarrantInput:
      params.buildFindBestWarrantInput ?? (async () => createFindBestWarrantInputDouble()),
    findBestWarrant: params.findBestWarrant,
    isWithinMorningAutoSearchOpenDelay: () => false,
    searchCooldownMs: 10_000,
    getHKDateKey,
    maxSearchFailuresPerDay: 3,
    logger: createLoggerStub(),
  });

  return {
    autoSearch,
    symbolRegistry,
  };
}

function startLongSearch(params: {
  readonly autoSearch: ReturnType<typeof createAutoSearch>;
  readonly currentTime: Date;
  readonly canContinue: () => boolean;
}): Promise<void> {
  return params.autoSearch.maybeSearchOnEvent({
    direction: 'LONG',
    currentTime: params.currentTime,
    canContinue: params.canContinue,
  });
}

describe('autoSearch stale continuation business flow', () => {
  it('does not activate a candidate after the live ordinary authorization closes', async () => {
    const currentTime = new Date('2026-04-10T01:00:00.000Z');
    const candidateResult = createDeferred<WarrantCandidate | null>();
    let finderStarted = false;
    let canContinue = true;
    const { autoSearch, symbolRegistry } = createAutoSearchHarness({
      currentTime,
      findBestWarrant: async () => {
        finderStarted = true;
        return candidateResult.promise;
      },
      searchFailCountToday: 2,
    });

    const pendingSearch = startLongSearch({
      autoSearch,
      currentTime,
      canContinue: () => canContinue,
    });
    await Bun.sleep(0);

    expect(finderStarted).toBe(true);
    expect(symbolRegistry.getSeatState('LONG')).toMatchObject({
      status: 'SEARCHING',
      searchFailCountToday: 2,
    });

    canContinue = false;
    candidateResult.resolve(createWarrantCandidate('STALE_BULL.HK'));
    await pendingSearch;

    expect(symbolRegistry.getSeatState('LONG')).toMatchObject({
      symbol: null,
      status: 'SEARCHING',
      searchFailCountToday: 2,
    });
  });

  it('consumes a captured day-epoch closure without reauthorizing the late candidate', async () => {
    const currentTime = new Date('2026-04-10T01:00:00.000Z');
    const result = createDeferred<WarrantCandidate | null>();
    let dayEpoch = 1;
    const capturedDayEpoch = dayEpoch;
    const { autoSearch, symbolRegistry } = createAutoSearchHarness({
      currentTime,
      findBestWarrant: async () => result.promise,
    });
    const search = startLongSearch({
      autoSearch,
      currentTime,
      canContinue: () => capturedDayEpoch === dayEpoch,
    });
    await Bun.sleep(0);
    dayEpoch = 2;
    result.resolve(createWarrantCandidate('OLD_DAY.HK'));
    await search;
    expect(symbolRegistry.getSeatState('LONG')).toMatchObject({
      status: 'SEARCHING',
      symbol: null,
      callPrice: null,
      searchFailCountToday: 0,
    });
  });

  it('uses the real exact finder with a neutral object-request context, retaining threshold and candidate precision', async () => {
    const currentTime = new Date('2026-04-10T01:00:00.000Z');
    const symbols: string[] = [];
    const input = createFindBestWarrantInputDouble();
    const ctx = createQuoteContextDouble({
      warrantList: async (request) => {
        symbols.push(request.symbol);
        const raw = {
          name: null,
          lastDone: null,
          toCallPrice: '0.003500000000000000001',
          callPrice: '21000.000000000000000001',
          turnover: '1000000',
          warrantType: null,
          status: 'NORMAL' as const,
        };
        return [
          { ...raw, symbol: 'MISSING_CALL.HK', callPrice: null },
          { ...raw, symbol: 'EXACT_BULL.HK' },
        ];
      },
    });
    const { autoSearch, symbolRegistry } = createAutoSearchHarness({
      currentTime,
      findBestWarrant,
      buildFindBestWarrantInput: async () => ({ ...input, ctx }),
    });
    const captured = symbolRegistry.getSeatVersion('LONG');
    await startLongSearch({
      autoSearch,
      currentTime,
      canContinue: () => symbolRegistry.getSeatVersion('LONG') === captured,
    });
    expect(symbols).toEqual(['HSI.HK']);
    expect(symbolRegistry.getSeatState('LONG')).toMatchObject({
      status: 'ACTIVATING',
      symbol: 'EXACT_BULL.HK',
      callPrice: '21000.000000000000000001',
    });
  });

  it('does not disguise corrupt neutral financial input as an empty candidate result', async () => {
    const currentTime = new Date('2026-04-10T01:00:00.000Z');
    const input = createFindBestWarrantInputDouble();
    const ctx = createQuoteContextDouble({
      warrantList: async () => [
        {
          symbol: 'CORRUPT.HK',
          name: null,
          lastDone: null,
          toCallPrice: '0.004',
          callPrice: 'NaN',
          turnover: '1000000',
          warrantType: null,
          status: 'NORMAL',
        },
      ],
    });
    const { autoSearch, symbolRegistry } = createAutoSearchHarness({
      currentTime,
      findBestWarrant,
      buildFindBestWarrantInput: async () => ({ ...input, ctx }),
    });
    const captured = symbolRegistry.getSeatVersion('LONG');
    let caught: unknown;
    try {
      await startLongSearch({
        autoSearch,
        currentTime,
        canContinue: () => symbolRegistry.getSeatVersion('LONG') === captured,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TypeError);
    expect(symbolRegistry.getSeatState('LONG')).toMatchObject({
      status: 'EMPTY',
      symbol: null,
      searchFailCountToday: 1,
    });
  });

  it('does not count a stale null finder result as a search failure', async () => {
    const currentTime = new Date('2026-04-10T01:00:00.000Z');
    const nullResult = createDeferred<WarrantCandidate | null>();
    let finderStarted = false;
    let canContinue = true;
    const { autoSearch, symbolRegistry } = createAutoSearchHarness({
      currentTime,
      findBestWarrant: async () => {
        finderStarted = true;
        return nullResult.promise;
      },
      searchFailCountToday: 1,
    });

    const pendingSearch = startLongSearch({
      autoSearch,
      currentTime,
      canContinue: () => canContinue,
    });
    await Bun.sleep(0);

    expect(finderStarted).toBe(true);
    canContinue = false;
    nullResult.resolve(null);
    await pendingSearch;

    expect(symbolRegistry.getSeatState('LONG')).toMatchObject({
      symbol: null,
      status: 'SEARCHING',
      searchFailCountToday: 1,
      frozenTradingDayKey: null,
    });
  });

  it('does not count a stale external finder failure as a search failure', async () => {
    const currentTime = new Date('2026-04-10T01:00:00.000Z');
    const externalFailure = createDeferred<WarrantCandidate | null>();
    let finderStarted = false;
    let canContinue = true;
    const { autoSearch, symbolRegistry } = createAutoSearchHarness({
      currentTime,
      findBestWarrant: async () => {
        finderStarted = true;
        return externalFailure.promise;
      },
      searchFailCountToday: 1,
    });

    const pendingSearch = startLongSearch({
      autoSearch,
      currentTime,
      canContinue: () => canContinue,
    });
    await Bun.sleep(0);

    expect(finderStarted).toBe(true);
    canContinue = false;
    externalFailure.reject(
      await createExternalApiRequestError({
        operation: 'test.autoSearch.stale',
        attempts: 1,
        cause: new Error('finder unavailable'),
      }),
    );
    await pendingSearch;

    expect(symbolRegistry.getSeatState('LONG')).toMatchObject({
      symbol: null,
      status: 'SEARCHING',
      searchFailCountToday: 1,
      frozenTradingDayKey: null,
    });
  });

  it('does not call the finder after input construction loses live authorization', async () => {
    const currentTime = new Date('2026-04-10T01:00:00.000Z');
    const inputResult = createDeferred<FindBestWarrantInput>();
    let inputBuilderStarted = false;
    let finderCalls = 0;
    let canContinue = true;
    const { autoSearch, symbolRegistry } = createAutoSearchHarness({
      currentTime,
      buildFindBestWarrantInput: async () => {
        inputBuilderStarted = true;
        return inputResult.promise;
      },
      findBestWarrant: async () => {
        finderCalls += 1;
        return createWarrantCandidate('UNUSED_BULL.HK');
      },
    });

    const pendingSearch = startLongSearch({
      autoSearch,
      currentTime,
      canContinue: () => canContinue,
    });
    await Bun.sleep(0);

    expect(inputBuilderStarted).toBe(true);
    canContinue = false;
    inputResult.resolve(createFindBestWarrantInputDouble());
    await pendingSearch;

    expect(finderCalls).toBe(0);
    expect(symbolRegistry.getSeatState('LONG')).toMatchObject({
      symbol: null,
      status: 'SEARCHING',
    });
  });

  it('still exposes an internal input-builder error after the owner becomes stale', async () => {
    const currentTime = new Date('2026-04-10T01:00:00.000Z');
    const inputResult = createDeferred<FindBestWarrantInput>();
    let inputBuilderStarted = false;
    let canContinue = true;
    const { autoSearch, symbolRegistry } = createAutoSearchHarness({
      currentTime,
      buildFindBestWarrantInput: async () => {
        inputBuilderStarted = true;
        return inputResult.promise;
      },
      findBestWarrant: async () => createWarrantCandidate('UNUSED_BULL.HK'),
    });

    const pendingSearch = startLongSearch({
      autoSearch,
      currentTime,
      canContinue: () => canContinue,
    });
    await Bun.sleep(0);

    expect(inputBuilderStarted).toBe(true);
    canContinue = false;
    const originalError = new TypeError('input contract broken');
    inputResult.reject(originalError);

    let caught: unknown = null;
    try {
      await pendingSearch;
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({ message: 'input contract broken' });
    expect(caught).toBe(originalError);
    expect(symbolRegistry.getSeatState('LONG')).toMatchObject({
      symbol: null,
      status: 'SEARCHING',
      searchFailCountToday: 0,
    });
  });

  it('does not let an older seat version overwrite a successor SEARCHING owner', async () => {
    const currentTime = new Date('2026-04-10T01:00:00.000Z');
    const candidateResult = createDeferred<WarrantCandidate | null>();
    let finderStarted = false;
    const { autoSearch, symbolRegistry } = createAutoSearchHarness({
      currentTime,
      findBestWarrant: async () => {
        finderStarted = true;
        return candidateResult.promise;
      },
    });

    const pendingSearch = startLongSearch({
      autoSearch,
      currentTime,
      canContinue: captureSearchSeatAuthorization(symbolRegistry, 'LONG'),
    });
    await Bun.sleep(0);

    expect(finderStarted).toBe(true);
    const originalVersion = symbolRegistry.getSeatVersion('LONG');
    const currentSeat = symbolRegistry.getSeatState('LONG');
    const successor = symbolRegistry.updateSeatStateWithVersionBump('LONG', {
      symbol: null,
      status: 'SEARCHING',
      lastSwitchAt: currentSeat.lastSwitchAt,
      lastSearchAt: currentSeat.lastSearchAt,
      lastSeatActivatedAt: currentSeat.lastSeatActivatedAt,
      callPrice: null,
      searchFailCountToday: currentSeat.searchFailCountToday,
      frozenTradingDayKey: currentSeat.frozenTradingDayKey,
    });

    candidateResult.resolve(createWarrantCandidate('STALE_BULL.HK'));
    await pendingSearch;

    expect(successor.seatVersion).toBe(originalVersion + 1);
    expect(symbolRegistry.getSeatVersion('LONG')).toBe(successor.seatVersion);
    expect(symbolRegistry.getSeatState('LONG')).toMatchObject({
      symbol: null,
      status: 'SEARCHING',
    });
  });
});
