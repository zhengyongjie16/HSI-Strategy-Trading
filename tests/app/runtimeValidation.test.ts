/**
 * app/runtimeValidation 单元测试
 *
 * 覆盖：
 * - 运行时标的收集会对监控标的、席位标的与持仓标的去重
 * - 自动寻标关闭时席位标的为 required，开启时为可选
 */
import { describe, expect, it } from 'bun:test';
import { collectRuntimeValidationSymbols } from '../../src/app/runtimeValidation.js';
import {
  createStrategyRuntimeConfigDouble,
  createPositionDouble,
  createSymbolRegistryDouble,
} from '../helpers/testDoubles.js';
import { createTradingConfigFixture } from '../../mock/factories/configFactory.js';

describe('app runtimeValidation', () => {
  it('deduplicates monitor, seat and position symbols while keeping required seat symbols', () => {
    const monitorConfig = createStrategyRuntimeConfigDouble({
      baseInstrumentSymbol: 'HSI.HK',
      autoSearchConfig: {
        autoSearchEnabled: false,
        autoSearchMinDistancePctBull: null,
        autoSearchMinDistancePctBear: null,
        autoSearchMinTurnoverPerMinuteBull: null,
        autoSearchMinTurnoverPerMinuteBear: null,
        autoSearchOpenDelayMinutes: 0,
        autoSearchExpiryMinMonths: 0,
        switchIntervalMinutes: 0,
        switchDistanceRangeBull: null,
        switchDistanceRangeBear: null,
      },
    });
    const tradingConfig = createTradingConfigFixture({
      baseInstrument: monitorConfig.baseInstrumentSymbol,
    });
    const symbolRegistry = createSymbolRegistryDouble({
      baseInstrumentSymbol: 'HSI.HK',
      longSeat: {
        symbol: 'BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      shortSeat: {
        symbol: 'BEAR.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
    });

    const collector = collectRuntimeValidationSymbols({
      tradingConfig,
      monitorConfig,
      symbolRegistry,
      positions: [
        createPositionDouble({
          symbol: 'BULL.HK',
          quantity: 100,
          availableQuantity: 100,
        }),
        createPositionDouble({
          symbol: 'EXTRA.HK',
          quantity: 100,
          availableQuantity: 100,
        }),
      ],
    });

    expect(collector.runtimeValidationInputs).toEqual([
      {
        symbol: 'HSI.HK',
        label: '基础对象',
        requireLotSize: false,
        required: true,
      },
      {
        symbol: 'BULL.HK',
        label: '做多席位标的',
        requireLotSize: true,
        required: true,
      },
      {
        symbol: 'BEAR.HK',
        label: '做空席位标的',
        requireLotSize: true,
        required: true,
      },
      {
        symbol: 'EXTRA.HK',
        label: '持仓标的',
        requireLotSize: false,
        required: false,
      },
    ]);
    expect([...collector.requiredSymbols]).toEqual(['HSI.HK', 'BULL.HK', 'BEAR.HK']);
  });

  it('marks seat symbols as optional when auto search is enabled', () => {
    const monitorConfig = createStrategyRuntimeConfigDouble({
      baseInstrumentSymbol: 'HSCEI.HK',
      autoSearchConfig: {
        autoSearchEnabled: true,
        autoSearchMinDistancePctBull: 0.35,
        autoSearchMinDistancePctBear: -0.35,
        autoSearchMinTurnoverPerMinuteBull: 1_000_000,
        autoSearchMinTurnoverPerMinuteBear: 1_000_000,
        autoSearchOpenDelayMinutes: 0,
        autoSearchExpiryMinMonths: 0,
        switchIntervalMinutes: 0,
        switchDistanceRangeBull: {
          min: 0.35,
          max: 0.8,
        },
        switchDistanceRangeBear: {
          min: -0.8,
          max: -0.35,
        },
      },
    });
    const tradingConfig = createTradingConfigFixture({
      baseInstrument: monitorConfig.baseInstrumentSymbol,
    });
    const symbolRegistry = createSymbolRegistryDouble({
      baseInstrumentSymbol: 'HSCEI.HK',
    });

    const collector = collectRuntimeValidationSymbols({
      tradingConfig,
      monitorConfig,
      symbolRegistry,
      positions: [],
    });

    expect(collector.runtimeValidationInputs[1]).toEqual({
      symbol: 'BULL.HK',
      label: '做多席位标的',
      requireLotSize: true,
      required: false,
    });

    expect(collector.runtimeValidationInputs[2]).toEqual({
      symbol: 'BEAR.HK',
      label: '做空席位标的',
      requireLotSize: true,
      required: false,
    });

    expect([...collector.requiredSymbols]).toEqual(['HSCEI.HK']);
  });
});
