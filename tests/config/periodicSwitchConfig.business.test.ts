/**
 * periodicSwitch 配置业务测试
 *
 * 功能：
 * - 验证单实例模式下 SWITCH_INTERVAL_MINUTES 的解析边界
 * - 验证 auto seat 模式下显式非法值会被 fail-fast 与 validator 一致拒绝
 */
import { describe, expect, it } from 'bun:test';

import { createTradingConfig } from '../../src/config/trading/index.js';

function createStaticEnv(overrides: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  return {
    LONGBRIDGE_AUTH_MODE: 'oauth',
    LONGBRIDGE_CLIENT_ID: 'client-id',
    LONG_SYMBOL: 'BULL.HK',
    SHORT_SYMBOL: 'BEAR.HK',
    ORDER_OWNERSHIP_MAPPING: 'HSI',
    ...overrides,
  };
}

function createAutoEnv(overrides: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  return {
    LONGBRIDGE_AUTH_MODE: 'oauth',
    LONGBRIDGE_CLIENT_ID: 'client-id',
    ORDER_OWNERSHIP_MAPPING: 'HSI',
    SEAT_MODE: 'auto',
    AUTO_SEARCH_MIN_DISTANCE_PCT_BULL: '0.8',
    AUTO_SEARCH_MIN_DISTANCE_PCT_BEAR: '-0.8',
    AUTO_SEARCH_MIN_TURNOVER_PER_MINUTE_BULL: '300000',
    AUTO_SEARCH_MIN_TURNOVER_PER_MINUTE_BEAR: '300000',
    AUTO_SEARCH_EXPIRY_MIN_MONTHS: '6',
    AUTO_SEARCH_OPEN_DELAY_MINUTES: '5',
    SWITCH_INTERVAL_MINUTES: '0',
    SWITCH_DISTANCE_RANGE_BULL: '0.4,1.5',
    SWITCH_DISTANCE_RANGE_BEAR: '-1.5,-0.4',
    ...overrides,
  };
}

describe('periodic switch config business flow', () => {
  it('parses SWITCH_INTERVAL_MINUTES with seat-mode-aware fail-fast rules', () => {
    const staticConfig = createTradingConfig({
      env: createStaticEnv(),
    });
    expect(staticConfig.strategy.autoSearchConfig.switchIntervalMinutes).toBe(0);

    const ignoredWhenStatic = createTradingConfig({
      env: createStaticEnv({
        SWITCH_INTERVAL_MINUTES: '999',
      }),
    });
    expect(ignoredWhenStatic.strategy.autoSearchConfig.switchIntervalMinutes).toBe(0);

    const autoConfig = createTradingConfig({
      env: createAutoEnv({
        SWITCH_INTERVAL_MINUTES: '15',
      }),
    });
    expect(autoConfig.strategy.autoSearchConfig.switchIntervalMinutes).toBe(15);

    expect(() =>
      createTradingConfig({
        env: createAutoEnv({
          SWITCH_INTERVAL_MINUTES: '-5',
        }),
      }),
    ).toThrow(/SWITCH_INTERVAL_MINUTES/);

    expect(() =>
      createTradingConfig({
        env: createAutoEnv({
          SWITCH_INTERVAL_MINUTES: '999',
        }),
      }),
    ).toThrow(/SWITCH_INTERVAL_MINUTES/);

    expect(() =>
      createTradingConfig({
        env: createAutoEnv({
          SWITCH_INTERVAL_MINUTES: 'invalid-number',
        }),
      }),
    ).toThrow(/SWITCH_INTERVAL_MINUTES/);
  });
});
