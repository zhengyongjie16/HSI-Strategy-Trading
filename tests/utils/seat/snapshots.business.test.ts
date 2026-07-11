/**
 * seat snapshots 业务测试
 *
 * 覆盖：monitorContext 席位快照与标的名称派生。
 */
import { describe, expect, it } from 'bun:test';

import {
  resolveMonitorContextSeatSnapshot,
  resolveMonitorContextSymbolNames,
} from '../../../src/utils/seat/snapshots.js';
import { createQuoteDouble, createSymbolRegistryDouble } from '../../helpers/testDoubles.js';

describe('seat snapshots business flow', () => {
  it('resolves ready seat snapshot and derived symbol names', () => {
    const symbolRegistry = createSymbolRegistryDouble({
      longSeat: {
        symbol: 'LONG_READY.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      shortSeat: {
        symbol: 'SHORT_READY.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      longVersion: 3,
      shortVersion: 4,
    });

    const seatSnapshot = resolveMonitorContextSeatSnapshot(symbolRegistry);
    const symbolNames = resolveMonitorContextSymbolNames({
      symbolRegistry,
      monitorSymbol: 'HSI.HK',
      quotesMap: new Map([
        ['LONG_READY.HK', { ...createQuoteDouble('LONG_READY.HK', 1.1), name: 'LongReady' }],
        ['SHORT_READY.HK', { ...createQuoteDouble('SHORT_READY.HK', 0.9), name: 'ShortReady' }],
        ['HSI.HK', { ...createQuoteDouble('HSI.HK', 20_100), name: 'HangSeng' }],
      ]),
    });

    expect(seatSnapshot.seatVersion).toEqual({ long: 3, short: 4 });
    expect(seatSnapshot.longSymbol).toBe('LONG_READY.HK');
    expect(seatSnapshot.shortSymbol).toBe('SHORT_READY.HK');
    expect(symbolNames.longSymbolName).toBe('LongReady');
    expect(symbolNames.shortSymbolName).toBe('ShortReady');
    expect(symbolNames.monitorSymbolName).toBe('HangSeng');
  });

  it('returns empty seat symbols when seats are not ready', () => {
    const symbolRegistry = createSymbolRegistryDouble({
      longSeat: {
        symbol: null,
        status: 'EMPTY',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      shortSeat: {
        symbol: 'SHORT_READY.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
    });

    const seatSnapshot = resolveMonitorContextSeatSnapshot(symbolRegistry);
    const symbolNames = resolveMonitorContextSymbolNames({
      symbolRegistry,
      monitorSymbol: 'HSI.HK',
      quotesMap: new Map([
        ['SHORT_READY.HK', { ...createQuoteDouble('SHORT_READY.HK', 0.9), name: 'ShortReady' }],
      ]),
    });

    expect(seatSnapshot.longSymbol).toBeNull();
    expect(symbolNames.longSymbolName).toBe('');
    expect(symbolNames.shortSymbolName).toBe('ShortReady');
    expect(symbolNames.monitorSymbolName).toBe('HSI.HK');
  });

  it('does not expose activating seat symbols to runtime consumers', () => {
    const symbolRegistry = createSymbolRegistryDouble({
      longSeat: {
        symbol: 'LONG_ACTIVATING.HK',
        status: 'ACTIVATING',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      shortSeat: {
        symbol: 'SHORT_ACTIVE.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
    });

    const seatSnapshot = resolveMonitorContextSeatSnapshot(symbolRegistry);
    const symbolNames = resolveMonitorContextSymbolNames({
      symbolRegistry,
      monitorSymbol: 'HSI.HK',
      quotesMap: new Map([
        [
          'LONG_ACTIVATING.HK',
          { ...createQuoteDouble('LONG_ACTIVATING.HK', 1.1), name: 'LongActivating' },
        ],
        ['SHORT_ACTIVE.HK', { ...createQuoteDouble('SHORT_ACTIVE.HK', 0.9), name: 'ShortActive' }],
      ]),
    });

    expect(seatSnapshot.longSymbol).toBeNull();
    expect(seatSnapshot.shortSymbol).toBe('SHORT_ACTIVE.HK');
    expect(symbolNames.longSymbolName).toBe('');
    expect(symbolNames.shortSymbolName).toBe('ShortActive');
  });
});
