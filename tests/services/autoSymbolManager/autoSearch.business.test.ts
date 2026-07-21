/**
 * autoSearch 业务测试
 *
 * 功能：
 * - 验证自动寻标相关场景意图、边界条件与业务期望。
 */
import { describe, expect, it } from 'bun:test';
import { createAutoSearch } from '../../../src/services/autoSymbolManager/autoSearch.js';
import { createSeatStateManager } from '../../../src/services/autoSymbolManager/seatStateManager.js';
import type {
  SwitchState,
  SwitchSuppression,
} from '../../../src/services/autoSymbolManager/types.js';
import { getHKDateKey } from '../../../src/utils/time/index.js';
import { createExternalApiRequestError } from '../../helpers/createExternalApiRequestError.js';
import {
  createMonitorConfigDouble,
  createSymbolRegistryDouble,
} from '../../helpers/testDoubles.js';
import {
  createDirectionalAutoSearchPolicy,
  createFindBestWarrantInputDouble,
  createLoggerStub,
  createWarrantCandidate,
  createWarrantCandidateWithOverrides,
  getDefaultAutoSearchConfig,
} from './utils.js';

function createSwitchStatesMap(): Map<'LONG' | 'SHORT', SwitchState> {
  return new Map<'LONG' | 'SHORT', SwitchState>();
}

function createSwitchSuppressionsMap(): Map<'LONG' | 'SHORT', SwitchSuppression> {
  return new Map<'LONG' | 'SHORT', SwitchSuppression>();
}

describe('autoSymbolManager autoSearch business flow', () => {
  it('counts explicit external request failures and returns control to the cooldown owner', async () => {
    const monitorConfig = createMonitorConfigDouble({
      autoSearchConfig: getDefaultAutoSearchConfig(),
    });
    const now = new Date('2026-02-16T01:00:00.000Z');
    const symbolRegistry = createSymbolRegistryDouble({
      longSeat: {
        symbol: null,
        status: 'EMPTY',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 1,
        frozenTradingDayKey: null,
      },
    });
    const manager = createSeatStateManager({
      symbolRegistry,
      switchStates: createSwitchStatesMap(),
      switchSuppressions: createSwitchSuppressionsMap(),
      now: () => now,
      logger: createLoggerStub(),
      getHKDateKey,
    });
    const autoSearch = createAutoSearch({
      autoSearchConfig: monitorConfig.autoSearchConfig,
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      updateSeatState: manager.updateSeatState,
      resolveDirectionalAutoSearchPolicy: () => createDirectionalAutoSearchPolicy('LONG'),
      buildFindBestWarrantInput: async () => createFindBestWarrantInputDouble(),
      findBestWarrant: async () => {
        throw await createExternalApiRequestError({
          operation: 'test.autoSearch',
          attempts: 1,
          cause: new Error('api unavailable'),
        });
      },
      isWithinMorningAutoSearchOpenDelay: () => false,
      searchCooldownMs: 10_000,
      getHKDateKey,
      maxSearchFailuresPerDay: 3,
      logger: createLoggerStub(),
    });

    await autoSearch.maybeSearchOnEvent({
      direction: 'LONG',
      currentTime: now,
      canContinue: () => true,
    });

    expect(symbolRegistry.getSeatState('LONG')).toMatchObject({
      status: 'EMPTY',
      lastSearchAt: now.getTime(),
      searchFailCountToday: 2,
      frozenTradingDayKey: null,
    });
  });

  it('counts input-builder exceptions as real search failures before rethrowing', async () => {
    const monitorConfig = createMonitorConfigDouble({
      autoSearchConfig: getDefaultAutoSearchConfig(),
    });
    const now = new Date('2026-02-16T01:00:00.000Z');
    const symbolRegistry = createSymbolRegistryDouble({
      longSeat: {
        symbol: null,
        status: 'EMPTY',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 2,
        frozenTradingDayKey: null,
      },
    });
    const manager = createSeatStateManager({
      symbolRegistry,
      switchStates: createSwitchStatesMap(),
      switchSuppressions: createSwitchSuppressionsMap(),
      now: () => now,
      logger: createLoggerStub(),
      getHKDateKey,
    });
    const autoSearch = createAutoSearch({
      autoSearchConfig: monitorConfig.autoSearchConfig,
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      updateSeatState: manager.updateSeatState,
      resolveDirectionalAutoSearchPolicy: () => createDirectionalAutoSearchPolicy('LONG'),
      buildFindBestWarrantInput: async () => {
        throw new Error('finder input unavailable');
      },
      findBestWarrant: async () => null,
      isWithinMorningAutoSearchOpenDelay: () => false,
      searchCooldownMs: 10_000,
      getHKDateKey,
      maxSearchFailuresPerDay: 3,
      logger: createLoggerStub(),
    });

    let caught: unknown = null;
    try {
      await autoSearch.maybeSearchOnEvent({
        direction: 'LONG',
        currentTime: now,
        canContinue: () => true,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({ message: 'finder input unavailable' });

    expect(symbolRegistry.getSeatState('LONG')).toMatchObject({
      status: 'EMPTY',
      symbol: null,
      lastSearchAt: now.getTime(),
      searchFailCountToday: 3,
      frozenTradingDayKey: '2026-02-16',
    });
  });

  it('fills EMPTY seat to ACTIVATING and resets failure counters when a candidate is found', async () => {
    const monitorConfig = createMonitorConfigDouble({
      autoSearchConfig: getDefaultAutoSearchConfig(),
    });
    const symbolRegistry = createSymbolRegistryDouble({
      longSeat: {
        symbol: null,
        status: 'EMPTY',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 1,
        frozenTradingDayKey: null,
      },
    });
    const switchStates = createSwitchStatesMap();
    const switchSuppressions = createSwitchSuppressionsMap();
    const manager = createSeatStateManager({
      symbolRegistry,
      switchStates,
      switchSuppressions,
      now: () => new Date('2026-02-16T01:00:00.000Z'),
      logger: createLoggerStub(),
      getHKDateKey,
    });
    let findCalls = 0;
    const autoSearch = createAutoSearch({
      autoSearchConfig: monitorConfig.autoSearchConfig,
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      updateSeatState: manager.updateSeatState,
      resolveDirectionalAutoSearchPolicy: () => createDirectionalAutoSearchPolicy('LONG'),
      buildFindBestWarrantInput: async () => createFindBestWarrantInputDouble(),
      findBestWarrant: async () => {
        findCalls += 1;
        return {
          ...createWarrantCandidate('NEW_BULL.HK'),
          callPrice: 20_500,
        };
      },
      isWithinMorningAutoSearchOpenDelay: () => false,
      searchCooldownMs: 10_000,
      getHKDateKey,
      maxSearchFailuresPerDay: 3,
      logger: createLoggerStub(),
    });
    await autoSearch.maybeSearchOnEvent({
      direction: 'LONG',
      currentTime: new Date('2026-02-16T01:00:00.000Z'),
      canContinue: () => true,
    });
    const seat = symbolRegistry.getSeatState('LONG');
    expect(findCalls).toBe(1);
    expect(seat.status).toBe('ACTIVATING');
    expect(seat.symbol).toBe('NEW_BULL.HK');
    expect(seat.callPrice).toBe(20_500);
    expect(seat.searchFailCountToday).toBe(0);
    expect(seat.frozenTradingDayKey).toBeNull();
    expect(symbolRegistry.getSeatVersion('LONG')).toBe(2);
  });

  it('freezes seat for the day after reaching max search failures', async () => {
    const monitorConfig = createMonitorConfigDouble({
      autoSearchConfig: getDefaultAutoSearchConfig(),
    });
    const symbolRegistry = createSymbolRegistryDouble({
      longSeat: {
        symbol: null,
        status: 'EMPTY',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 2,
        frozenTradingDayKey: null,
      },
    });
    const switchStates = createSwitchStatesMap();
    const switchSuppressions = createSwitchSuppressionsMap();
    const manager = createSeatStateManager({
      symbolRegistry,
      switchStates,
      switchSuppressions,
      now: () => new Date('2026-02-16T01:00:00.000Z'),
      logger: createLoggerStub(),
      getHKDateKey,
    });
    let findCalls = 0;
    const autoSearch = createAutoSearch({
      autoSearchConfig: monitorConfig.autoSearchConfig,
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      updateSeatState: manager.updateSeatState,
      resolveDirectionalAutoSearchPolicy: () => createDirectionalAutoSearchPolicy('LONG'),
      buildFindBestWarrantInput: async () => createFindBestWarrantInputDouble(),
      findBestWarrant: async () => {
        findCalls += 1;
        return null;
      },
      isWithinMorningAutoSearchOpenDelay: () => false,
      searchCooldownMs: 10_000,
      getHKDateKey,
      maxSearchFailuresPerDay: 3,
      logger: createLoggerStub(),
    });
    await autoSearch.maybeSearchOnEvent({
      direction: 'LONG',
      currentTime: new Date('2026-02-16T01:00:00.000Z'),
      canContinue: () => true,
    });
    const seat = symbolRegistry.getSeatState('LONG');
    expect(findCalls).toBe(1);
    expect(seat.status).toBe('EMPTY');
    expect(seat.searchFailCountToday).toBe(3);
    expect(seat.frozenTradingDayKey).toBe('2026-02-16');
    expect(symbolRegistry.getSeatVersion('LONG')).toBe(1);
  });

  it('honors search cooldown and skips finder call within cooldown window', async () => {
    const monitorConfig = createMonitorConfigDouble({
      autoSearchConfig: getDefaultAutoSearchConfig(),
    });
    const now = new Date('2026-02-16T01:00:00.000Z');
    const symbolRegistry = createSymbolRegistryDouble({
      longSeat: {
        symbol: null,
        status: 'EMPTY',
        lastSwitchAt: null,
        lastSearchAt: now.getTime() - 5_000,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
    });
    const switchStates = createSwitchStatesMap();
    const switchSuppressions = createSwitchSuppressionsMap();
    const manager = createSeatStateManager({
      symbolRegistry,
      switchStates,
      switchSuppressions,
      now: () => now,
      logger: createLoggerStub(),
      getHKDateKey,
    });
    let findCalls = 0;
    const autoSearch = createAutoSearch({
      autoSearchConfig: monitorConfig.autoSearchConfig,
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      updateSeatState: manager.updateSeatState,
      resolveDirectionalAutoSearchPolicy: () => createDirectionalAutoSearchPolicy('LONG'),
      buildFindBestWarrantInput: async () => createFindBestWarrantInputDouble(),
      findBestWarrant: async () => {
        findCalls += 1;
        return null;
      },
      isWithinMorningAutoSearchOpenDelay: () => false,
      searchCooldownMs: 10_000,
      getHKDateKey,
      maxSearchFailuresPerDay: 3,
      logger: createLoggerStub(),
    });
    await autoSearch.maybeSearchOnEvent({
      direction: 'LONG',
      currentTime: now,
      canContinue: () => true,
    });
    expect(findCalls).toBe(0);
  });

  it('fills EMPTY SHORT seat to ACTIVATING when bear candidate is found', async () => {
    const monitorConfig = createMonitorConfigDouble({
      autoSearchConfig: getDefaultAutoSearchConfig(),
    });
    const symbolRegistry = createSymbolRegistryDouble({
      shortSeat: {
        symbol: null,
        status: 'EMPTY',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 1,
        frozenTradingDayKey: null,
      },
    });
    const switchStates = createSwitchStatesMap();
    const switchSuppressions = createSwitchSuppressionsMap();
    const manager = createSeatStateManager({
      symbolRegistry,
      switchStates,
      switchSuppressions,
      now: () => new Date('2026-02-16T01:00:00.000Z'),
      logger: createLoggerStub(),
      getHKDateKey,
    });
    let findCalls = 0;
    const autoSearch = createAutoSearch({
      autoSearchConfig: monitorConfig.autoSearchConfig,
      monitorSymbol: 'HSI.HK',
      symbolRegistry,
      updateSeatState: manager.updateSeatState,
      resolveDirectionalAutoSearchPolicy: () => createDirectionalAutoSearchPolicy('SHORT'),
      buildFindBestWarrantInput: async () =>
        createFindBestWarrantInputDouble(createDirectionalAutoSearchPolicy('SHORT')),
      findBestWarrant: async () => {
        findCalls += 1;
        return createWarrantCandidateWithOverrides('NEW_BEAR.HK', {
          callPrice: 19_500,
          distancePct: -0.3499,
          selectionStage: 'DEGRADED',
          distanceDeltaToThreshold: 0.0001,
        });
      },
      isWithinMorningAutoSearchOpenDelay: () => false,
      searchCooldownMs: 10_000,
      getHKDateKey,
      maxSearchFailuresPerDay: 3,
      logger: createLoggerStub(),
    });
    await autoSearch.maybeSearchOnEvent({
      direction: 'SHORT',
      currentTime: new Date('2026-02-16T01:00:00.000Z'),
      canContinue: () => true,
    });
    const seat = symbolRegistry.getSeatState('SHORT');
    expect(findCalls).toBe(1);
    expect(seat.status).toBe('ACTIVATING');
    expect(seat.symbol).toBe('NEW_BEAR.HK');
    expect(seat.callPrice).toBe(19_500);
    expect(seat.searchFailCountToday).toBe(0);
    expect(seat.frozenTradingDayKey).toBeNull();
    expect(symbolRegistry.getSeatVersion('SHORT')).toBe(2);
  });
});
