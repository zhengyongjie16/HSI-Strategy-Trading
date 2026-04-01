import { describe, expect, it } from 'bun:test';

import { createStrategyRuntimeConfigFromTradingConfig } from '../../src/config/trading/runtime.js';
import { createTradingConfigFixture } from '../../mock/factories/configFactory.js';

describe('trading runtime projection', () => {
  it('preserves opening structure fields that the factor runtime consumes', () => {
    const tradingConfig = createTradingConfigFixture({
      strategy: {
        ...createTradingConfigFixture().strategy,
        openingStructureRules: {
          openingRangeMinutes: 25,
          breakoutScoreMin: 1.1,
          outsidePersistenceWindowBars: 6,
          outsidePersistenceMin: 0.75,
          retestToleranceAtr: 0.3,
          confirmBars: 3,
          morningNoiseWindowMinutes: 12,
          afternoonNoiseWindowMinutes: 9,
        },
      },
    });

    const runtimeConfig = createStrategyRuntimeConfigFromTradingConfig(tradingConfig);

    expect(runtimeConfig.strategyConfig.openingStructureRules).toEqual({
      openingRangeMinutes: 25,
      breakoutScoreMin: 1.1,
      outsidePersistenceWindowBars: 6,
      outsidePersistenceMin: 0.75,
      retestToleranceAtr: 0.3,
      confirmBars: 3,
      morningNoiseWindowMinutes: 12,
      afternoonNoiseWindowMinutes: 9,
    });
  });

  it('projects unrealized loss as per-symbol runtime contract', () => {
    const tradingConfig = createTradingConfigFixture({
      strategy: {
        ...createTradingConfigFixture().strategy,
        maxUnrealizedLossPerSymbol: 1500,
      },
    });

    const runtimeConfig = createStrategyRuntimeConfigFromTradingConfig(tradingConfig);

    expect('maxUnrealizedLossPerSymbol' in runtimeConfig).toBeTrue();
    expect('maxUnrealizedLoss' in runtimeConfig).toBeFalse();
    expect(runtimeConfig.maxUnrealizedLossPerSymbol).toBe(1500);
  });
});
