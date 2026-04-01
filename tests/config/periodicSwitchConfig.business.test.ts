/**
 * periodicSwitch 配置业务测试
 *
 * 功能：
 * - 验证单实例模式下 SWITCH_INTERVAL_MINUTES 的解析边界
 * - 验证 auto seat 模式下显式非法值会被 fail-fast 与 validator 一致拒绝
 */
import { describe, expect, it } from 'bun:test';

import { createTradingConfig } from '../../src/config/trading/index.js';
import { createRequiredAutoEnv, createRequiredStaticEnv } from '../helpers/configEnvFactory.js';

function createStaticEnv(overrides: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  return createRequiredStaticEnv(overrides);
}

function createAutoEnv(overrides: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  return createRequiredAutoEnv(overrides);
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
