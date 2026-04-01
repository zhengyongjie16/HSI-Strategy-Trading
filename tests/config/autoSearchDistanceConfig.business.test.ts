/**
 * autoSearchDistance 配置业务测试
 *
 * 功能：
 * - 验证单实例自动寻标距离配置的运行时单位口径
 * - 验证换标区间与主阈值/清仓阈值的关系校验
 */
import { describe, expect, it } from 'bun:test';

import { createTradingConfig } from '../../src/config/trading/index.js';
import { validateAllConfig } from '../../src/config/validator/index.js';
import { createRequiredAutoEnv } from '../helpers/configEnvFactory.js';

function createAutoEnv(overrides: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  return createRequiredAutoEnv({
    AUTO_SEARCH_MIN_DISTANCE_PCT_BULL: '0.35',
    AUTO_SEARCH_MIN_DISTANCE_PCT_BEAR: '-0.35',
    AUTO_SEARCH_MIN_TURNOVER_PER_MINUTE_BULL: '100000',
    AUTO_SEARCH_MIN_TURNOVER_PER_MINUTE_BEAR: '100000',
    AUTO_SEARCH_EXPIRY_MIN_MONTHS: '3',
    AUTO_SEARCH_OPEN_DELAY_MINUTES: '0',
    SWITCH_INTERVAL_MINUTES: '0',
    SWITCH_DISTANCE_RANGE_BULL: '0.31,1.5',
    SWITCH_DISTANCE_RANGE_BEAR: '-1.5,-0.31',
    ...overrides,
  });
}

async function validateConfig(env: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    const tradingConfig = createTradingConfig({
      env,
    });
    validateAllConfig({
      env,
      tradingConfig,
    });
    return true;
  } catch {
    return false;
  }
}

describe('auto search distance config business flow', () => {
  it('keeps AUTO_SEARCH_MIN_DISTANCE_PCT_* as percent-value runtime units', () => {
    const config = createTradingConfig({
      env: createAutoEnv(),
    });

    expect(config.strategy.autoSearchConfig.autoSearchMinDistancePctBull).toBe(0.35);
    expect(config.strategy.autoSearchConfig.autoSearchMinDistancePctBear).toBe(-0.35);
    expect(config.strategy.autoSearchConfig.switchDistanceRangeBull).toEqual({
      min: 0.31,
      max: 1.5,
    });

    expect(config.strategy.autoSearchConfig.switchDistanceRangeBear).toEqual({
      min: -1.5,
      max: -0.31,
    });
  });

  it('accepts valid degraded-range relationships for bull and bear directions', async () => {
    const isValid = await validateConfig(createAutoEnv());
    expect(isValid).toBe(true);
  });

  it('rejects bull degraded range when switchDistanceRange.min is equal to or above the primary threshold', async () => {
    const invalidEqual = await validateConfig(
      createAutoEnv({
        SWITCH_DISTANCE_RANGE_BULL: '0.35,1.5',
      }),
    );
    const invalidGreater = await validateConfig(
      createAutoEnv({
        SWITCH_DISTANCE_RANGE_BULL: '0.36,1.5',
      }),
    );

    expect(invalidEqual).toBe(false);
    expect(invalidGreater).toBe(false);
  });

  it('rejects bull degraded range when primary threshold is equal to or above switchDistanceRange.max', async () => {
    const invalidEqual = await validateConfig(
      createAutoEnv({
        SWITCH_DISTANCE_RANGE_BULL: '0.2,0.35',
      }),
    );
    const invalidGreater = await validateConfig(
      createAutoEnv({
        SWITCH_DISTANCE_RANGE_BULL: '0.2,0.34',
      }),
    );

    expect(invalidEqual).toBe(false);
    expect(invalidGreater).toBe(false);
  });

  it('rejects bear degraded range when switchDistanceRange.max is equal to or below the primary threshold', async () => {
    const invalidEqual = await validateConfig(
      createAutoEnv({
        SWITCH_DISTANCE_RANGE_BEAR: '-1.5,-0.35',
      }),
    );
    const invalidLower = await validateConfig(
      createAutoEnv({
        SWITCH_DISTANCE_RANGE_BEAR: '-1.5,-0.36',
      }),
    );

    expect(invalidEqual).toBe(false);
    expect(invalidLower).toBe(false);
  });

  it('rejects bear degraded range when switchDistanceRange.min is equal to or above the primary threshold', async () => {
    const invalidEqual = await validateConfig(
      createAutoEnv({
        SWITCH_DISTANCE_RANGE_BEAR: '-0.35,-0.2',
      }),
    );
    const invalidGreater = await validateConfig(
      createAutoEnv({
        SWITCH_DISTANCE_RANGE_BEAR: '-0.34,-0.2',
      }),
    );

    expect(invalidEqual).toBe(false);
    expect(invalidGreater).toBe(false);
  });
});
