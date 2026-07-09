/**
 * order monitor 买单追高控制配置测试
 *
 * 功能：
 * - 验证 ALLOW_BUY_ORDER_TRACKING_ABOVE_INITIAL_PRICE 在单 monitor 配置下的解析行为。
 */
import { describe, expect, it } from 'bun:test';
import { createTradingConfig as parseTradingConfig } from '../../src/config/trading/index.js';

function createBaseEnv(overrides: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  return {
    MONITOR_SYMBOL: 'HSI.HK',
    ...overrides,
  };
}

describe('order monitor buy chase control config', () => {
  it('parses ALLOW_BUY_ORDER_TRACKING_ABOVE_INITIAL_PRICE with expected defaults', () => {
    const defaultConfig = parseTradingConfig({
      env: createBaseEnv(),
    });
    expect(defaultConfig.global.allowBuyOrderTrackingAboveInitialPrice).toBe(true);

    const enabledConfig = parseTradingConfig({
      env: createBaseEnv({
        ALLOW_BUY_ORDER_TRACKING_ABOVE_INITIAL_PRICE: 'true',
      }),
    });
    expect(enabledConfig.global.allowBuyOrderTrackingAboveInitialPrice).toBe(true);

    const disabledConfig = parseTradingConfig({
      env: createBaseEnv({
        ALLOW_BUY_ORDER_TRACKING_ABOVE_INITIAL_PRICE: 'false',
      }),
    });
    expect(disabledConfig.global.allowBuyOrderTrackingAboveInitialPrice).toBe(false);
  });
});
