/**
 * periodicSwitch 配置业务测试
 *
 * 功能：
 * - 验证单 monitor 周期换标间隔配置的解析边界与配置校验行为。
 */
import { describe, expect, it } from 'bun:test';

import { createTradingConfig as parseTradingConfig } from '../../src/config/trading/index.js';
import { validateAllConfig } from '../../src/config/validator/index.js';
import { createMonitorConfigDouble } from '../helpers/testDoubles.js';
import { createTradingConfig } from '../../mock/factories/configFactory.js';

function createBaseEnv(overrides: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  return {
    LONGBRIDGE_AUTH_MODE: 'oauth',
    LONGBRIDGE_CLIENT_ID: 'client-id',
    MONITOR_SYMBOL: 'HSI.HK',
    ...overrides,
  };
}

describe('periodic switch config business flow', () => {
  it('parses SWITCH_INTERVAL_MINUTES with feature-gated fail-fast rules', () => {
    const missingConfig = parseTradingConfig({
      env: createBaseEnv(),
    });
    expect(missingConfig.monitor.autoSearchConfig.switchIntervalMinutes).toBe(0);

    const disabledConfig = parseTradingConfig({
      env: createBaseEnv({
        AUTO_SEARCH_ENABLED: 'false',
        SWITCH_INTERVAL_MINUTES: '999',
      }),
    });
    expect(disabledConfig.monitor.autoSearchConfig.switchIntervalMinutes).toBe(0);

    const validConfig = parseTradingConfig({
      env: createBaseEnv({
        AUTO_SEARCH_ENABLED: 'true',
        SWITCH_INTERVAL_MINUTES: '15',
      }),
    });
    expect(validConfig.monitor.autoSearchConfig.switchIntervalMinutes).toBe(15);

    expect(() =>
      parseTradingConfig({
        env: createBaseEnv({
          AUTO_SEARCH_ENABLED: 'true',
          SWITCH_INTERVAL_MINUTES: '-5',
        }),
      }),
    ).toThrow(/SWITCH_INTERVAL_MINUTES/);

    expect(() =>
      parseTradingConfig({
        env: createBaseEnv({
          AUTO_SEARCH_ENABLED: 'true',
          SWITCH_INTERVAL_MINUTES: '999',
        }),
      }),
    ).toThrow(/SWITCH_INTERVAL_MINUTES/);

    expect(() =>
      parseTradingConfig({
        env: createBaseEnv({
          AUTO_SEARCH_ENABLED: 'true',
          SWITCH_INTERVAL_MINUTES: 'invalid-number',
        }),
      }),
    ).toThrow(/SWITCH_INTERVAL_MINUTES/);
  });

  it('flags invalid SWITCH_INTERVAL_MINUTES during config validation when auto-search is enabled', async () => {
    const signalConfig = {
      conditionGroups: [
        {
          conditions: [{ indicator: 'K', operator: '>', threshold: 1 }],
          requiredCount: 1,
        },
      ],
    } as const;

    const monitorConfig = createMonitorConfigDouble({
      autoSearchConfig: {
        autoSearchEnabled: true,
        autoSearchMinDistancePctBull: 0.35,
        autoSearchMinDistancePctBear: -0.35,
        autoSearchMinTurnoverPerMinuteBull: 100_000,
        autoSearchMinTurnoverPerMinuteBear: 100_000,
        autoSearchExpiryMinMonths: 3,
        autoSearchOpenDelayMinutes: 0,
        switchIntervalMinutes: 0,
        switchDistanceRangeBull: { min: 0.2, max: 1.5 },
        switchDistanceRangeBear: { min: -1.5, max: -0.2 },
      },
      orderOwnershipMapping: ['HSI'],
      signalConfig: {
        buycall: signalConfig,
        sellcall: signalConfig,
        buyput: signalConfig,
        sellput: signalConfig,
      },
    });

    const tradingConfig = createTradingConfig({
      monitor: monitorConfig,
    });

    const invalidValues = ['not-a-number', '-1', '121'] as const;
    for (const invalidValue of invalidValues) {
      let caughtError: unknown = null;
      try {
        await validateAllConfig({
          env: {
            LONGBRIDGE_AUTH_MODE: 'oauth',
            LONGBRIDGE_CLIENT_ID: 'client-id',
            MONITOR_SYMBOL: 'HSI.HK',
            AUTO_SEARCH_ENABLED: 'true',
            SWITCH_INTERVAL_MINUTES: invalidValue,
          },
          tradingConfig,
        });
      } catch (error) {
        caughtError = error;
      }

      expect(caughtError).not.toBeNull();
      const validationError = caughtError as { missingFields?: ReadonlyArray<string> };
      expect(validationError.missingFields).toContain('SWITCH_INTERVAL_MINUTES');
    }
  });
});
