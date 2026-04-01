/**
 * tradingConfig fail-fast 业务测试
 *
 * 功能：
 * - 验证单实例关键交易配置在显式非法/越界时立即失败
 * - 验证关键配置缺失时不会再回退到代码默认值
 * - 验证解析层与校验层对关键配置的非法值判定一致
 */
import { describe, expect, it } from 'bun:test';

import { createTradingConfig } from '../../src/config/trading/index.js';
import { validateAllConfig } from '../../src/config/validator/index.js';
import { createRequiredAutoEnv, createRequiredStaticEnv } from '../helpers/configEnvFactory.js';

function createStaticEnv(overrides: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  return createRequiredStaticEnv(overrides);
}

function createAutoEnv(overrides: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  return createRequiredAutoEnv(overrides);
}

async function validateWithEnv(
  env: NodeJS.ProcessEnv,
  tradingConfig = createTradingConfig({
    env: createAutoEnv(),
  }),
): Promise<ReadonlyArray<string>> {
  try {
    validateAllConfig({
      env,
      tradingConfig,
    });
    return [];
  } catch (error) {
    const validationError = error as { missingFields?: ReadonlyArray<string> };
    return validationError.missingFields ?? [];
  }
}

describe('trading config fail-fast parsing', () => {
  it('requires explicit config instead of falling back to code defaults', () => {
    const env = createStaticEnv();
    delete env['TARGET_NOTIONAL'];

    expect(() =>
      createTradingConfig({
        env,
      }),
    ).toThrow(/TARGET_NOTIONAL/);
  });

  it('requires explicit global boolean config instead of falling back to code defaults', () => {
    const requiredBooleanKeys = [
      'DEBUG',
      'DOOMSDAY_PROTECTION',
      'MORNING_OPENING_PROTECTION_ENABLED',
      'AFTERNOON_OPENING_PROTECTION_ENABLED',
      'BUY_ORDER_TIMEOUT_ENABLED',
      'SELL_ORDER_TIMEOUT_ENABLED',
      'ALLOW_BUY_ORDER_TRACKING_ABOVE_INITIAL_PRICE',
    ] as const;

    for (const envKey of requiredBooleanKeys) {
      const envEntries = Object.entries(createStaticEnv()).filter(([key]) => key !== envKey);
      const env = Object.fromEntries(envEntries) as NodeJS.ProcessEnv;

      expect(() =>
        createTradingConfig({
          env,
        }),
      ).toThrow(new RegExp(envKey));
    }
  });

  it('accepts SWITCH_INTERVAL_MINUTES=0 as a valid business value in auto mode', () => {
    const config = createTradingConfig({
      env: createAutoEnv({
        SWITCH_INTERVAL_MINUTES: '0',
      }),
    });

    expect(config.strategy.autoSearchConfig.switchIntervalMinutes).toBe(0);
  });

  it('flags SWITCH_INTERVAL_MINUTES when auto seat mode is disabled', async () => {
    const config = createTradingConfig({
      env: createStaticEnv({
        SWITCH_INTERVAL_MINUTES: '121',
      }),
    });
    expect(config.strategy.autoSearchConfig.switchIntervalMinutes).toBe(0);

    const missingFields = await validateWithEnv(
      createStaticEnv({
        SWITCH_INTERVAL_MINUTES: '121',
      }),
      createTradingConfig({
        env: createStaticEnv(),
      }),
    );
    expect(missingFields).toContain('SWITCH_INTERVAL_MINUTES');
  });

  it('ignores invalid timeout seconds when the corresponding timeout is disabled', async () => {
    const config = createTradingConfig({
      env: createStaticEnv({
        BUY_ORDER_TIMEOUT_ENABLED: 'false',
        BUY_ORDER_TIMEOUT_SECONDS: '601',
        SELL_ORDER_TIMEOUT_ENABLED: 'false',
        SELL_ORDER_TIMEOUT_SECONDS: '29',
      }),
    });

    expect(config.global.buyOrderTimeout.timeoutSeconds).toBe(0);
    expect(config.global.sellOrderTimeout.timeoutSeconds).toBe(0);

    const validTradingConfig = createTradingConfig({
      env: createStaticEnv(),
    });
    const disabledTimeoutTradingConfig = {
      ...validTradingConfig,
      global: {
        ...validTradingConfig.global,
        buyOrderTimeout: {
          enabled: false,
          timeoutSeconds: 0,
        },
        sellOrderTimeout: {
          enabled: false,
          timeoutSeconds: 0,
        },
      },
    };

    const missingFields = await validateWithEnv(
      createStaticEnv({
        BUY_ORDER_TIMEOUT_ENABLED: 'false',
        BUY_ORDER_TIMEOUT_SECONDS: '601',
        SELL_ORDER_TIMEOUT_ENABLED: 'false',
        SELL_ORDER_TIMEOUT_SECONDS: '29',
      }),
      disabledTimeoutTradingConfig,
    );
    expect(missingFields).not.toContain('BUY_ORDER_TIMEOUT_SECONDS');
    expect(missingFields).not.toContain('SELL_ORDER_TIMEOUT_SECONDS');
  });

  it('throws ConfigValidationError directly from parser for critical strategy-level keys', () => {
    let caughtError: unknown = null;
    try {
      createTradingConfig({
        env: createStaticEnv({
          TARGET_NOTIONAL: '0',
        }),
      });
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).not.toBeNull();
    const validationError = caughtError as {
      readonly name?: string;
      readonly missingFields?: ReadonlyArray<string>;
      readonly message?: string;
    };
    expect(validationError.name).toBe('ConfigValidationError');
    expect(validationError.missingFields).toContain('TARGET_NOTIONAL');
    expect(validationError.message).toContain('TARGET_NOTIONAL');
  });

  it('parses MAX_UNREALIZED_LOSS_PER_SYMBOL as the per-symbol loss contract', () => {
    const config = createTradingConfig({
      env: createStaticEnv({
        MAX_UNREALIZED_LOSS_PER_SYMBOL: '1500',
      }),
    });

    expect(config.strategy.maxUnrealizedLossPerSymbol).toBe(1500);
    expect('maxUnrealizedLoss' in config.strategy).toBeFalse();
  });

  it('fails validation when deprecated MAX_UNREALIZED_LOSS is still provided', async () => {
    const env = createStaticEnv({
      MAX_UNREALIZED_LOSS: '1500',
    });
    const missingFields = await validateWithEnv(
      env,
      createTradingConfig({
        env: createStaticEnv(),
      }),
    );

    expect(missingFields).toContain('MAX_UNREALIZED_LOSS');
  });

  it('reports missing static seat symbols during validation', async () => {
    const env = createStaticEnv();
    delete env['LONG_SYMBOL'];
    delete env['SHORT_SYMBOL'];
    const validTradingConfig = createTradingConfig({
      env: createStaticEnv(),
    });
    const missingFields = await validateWithEnv(env, {
      ...validTradingConfig,
      strategy: {
        ...validTradingConfig.strategy,
        longSymbol: null,
        shortSymbol: null,
      },
    });
    expect(missingFields).toContain('LONG_SYMBOL');
    expect(missingFields).toContain('SHORT_SYMBOL');
  });

  it('fails fast when critical strategy-level keys are explicitly invalid or out of range', () => {
    const invalidCases = [
      { envKey: 'TARGET_NOTIONAL', value: '0', envFactory: createStaticEnv },
      { envKey: 'TARGET_NOTIONAL', value: 'abc', envFactory: createStaticEnv },
      { envKey: 'MAX_POSITION_NOTIONAL', value: '-1', envFactory: createStaticEnv },
      { envKey: 'MAX_POSITION_NOTIONAL', value: 'abc', envFactory: createStaticEnv },
      { envKey: 'BUY_INTERVAL_SECONDS', value: '9', envFactory: createStaticEnv },
      { envKey: 'BUY_INTERVAL_SECONDS', value: '601', envFactory: createStaticEnv },
      { envKey: 'BUY_INTERVAL_SECONDS', value: 'abc', envFactory: createStaticEnv },
      { envKey: 'LIQUIDATION_COOLDOWN', value: 'abc', envFactory: createStaticEnv },
      { envKey: 'VWAP_CONFIRM_RULES_SLOPE_WINDOW_BARS', value: '1', envFactory: createStaticEnv },
      { envKey: 'SWITCH_INTERVAL_MINUTES', value: '-1', envFactory: createAutoEnv },
      { envKey: 'SWITCH_INTERVAL_MINUTES', value: '121', envFactory: createAutoEnv },
      { envKey: 'SWITCH_INTERVAL_MINUTES', value: 'abc', envFactory: createAutoEnv },
    ] as const;

    for (const testCase of invalidCases) {
      expect(() =>
        createTradingConfig({
          env: testCase.envFactory({
            [testCase.envKey]: testCase.value,
          }),
        }),
      ).toThrow(new RegExp(testCase.envKey));
    }
  });

  it('fails fast when open protection is enabled but required minutes are missing or invalid', () => {
    const invalidCases = [
      {
        env: createStaticEnv({
          MORNING_OPENING_PROTECTION_ENABLED: 'true',
          MORNING_OPENING_PROTECTION_MINUTES: '',
        }),
        expectedKey: 'MORNING_OPENING_PROTECTION_MINUTES',
      },
      {
        env: createStaticEnv({
          MORNING_OPENING_PROTECTION_ENABLED: 'true',
          MORNING_OPENING_PROTECTION_MINUTES: '61',
        }),
        expectedKey: 'MORNING_OPENING_PROTECTION_MINUTES',
      },
      {
        env: createStaticEnv({
          AFTERNOON_OPENING_PROTECTION_ENABLED: 'true',
          AFTERNOON_OPENING_PROTECTION_MINUTES: '',
        }),
        expectedKey: 'AFTERNOON_OPENING_PROTECTION_MINUTES',
      },
      {
        env: createStaticEnv({
          AFTERNOON_OPENING_PROTECTION_ENABLED: 'true',
          AFTERNOON_OPENING_PROTECTION_MINUTES: '0',
        }),
        expectedKey: 'AFTERNOON_OPENING_PROTECTION_MINUTES',
      },
    ] as const;

    for (const testCase of invalidCases) {
      expect(() =>
        createTradingConfig({
          env: testCase.env,
        }),
      ).toThrow(new RegExp(testCase.expectedKey));
    }
  });

  it('fails fast when critical global keys are explicitly invalid or out of range', () => {
    const invalidCases = [
      { envKey: 'DEBUG', value: 'maybe', extraEnv: {} },
      { envKey: 'DOOMSDAY_PROTECTION', value: 'maybe', extraEnv: {} },
      { envKey: 'MORNING_OPENING_PROTECTION_ENABLED', value: 'maybe', extraEnv: {} },
      { envKey: 'AFTERNOON_OPENING_PROTECTION_ENABLED', value: 'maybe', extraEnv: {} },
      { envKey: 'BUY_ORDER_TIMEOUT_ENABLED', value: 'maybe', extraEnv: {} },
      { envKey: 'SELL_ORDER_TIMEOUT_ENABLED', value: 'maybe', extraEnv: {} },
      {
        envKey: 'ALLOW_BUY_ORDER_TRACKING_ABOVE_INITIAL_PRICE',
        value: 'maybe',
        extraEnv: {},
      },
      {
        envKey: 'BUY_ORDER_TIMEOUT_SECONDS',
        value: '29',
        extraEnv: { BUY_ORDER_TIMEOUT_ENABLED: 'true' },
      },
      {
        envKey: 'BUY_ORDER_TIMEOUT_SECONDS',
        value: '601',
        extraEnv: { BUY_ORDER_TIMEOUT_ENABLED: 'true' },
      },
      {
        envKey: 'BUY_ORDER_TIMEOUT_SECONDS',
        value: 'abc',
        extraEnv: { BUY_ORDER_TIMEOUT_ENABLED: 'true' },
      },
      {
        envKey: 'SELL_ORDER_TIMEOUT_SECONDS',
        value: '29',
        extraEnv: { SELL_ORDER_TIMEOUT_ENABLED: 'true' },
      },
      {
        envKey: 'SELL_ORDER_TIMEOUT_SECONDS',
        value: '601',
        extraEnv: { SELL_ORDER_TIMEOUT_ENABLED: 'true' },
      },
      {
        envKey: 'SELL_ORDER_TIMEOUT_SECONDS',
        value: 'abc',
        extraEnv: { SELL_ORDER_TIMEOUT_ENABLED: 'true' },
      },
      { envKey: 'ORDER_MONITOR_PRICE_UPDATE_INTERVAL', value: '0', extraEnv: {} },
      { envKey: 'ORDER_MONITOR_PRICE_UPDATE_INTERVAL', value: '61', extraEnv: {} },
      { envKey: 'ORDER_MONITOR_PRICE_UPDATE_INTERVAL', value: 'abc', extraEnv: {} },
    ] as const;

    for (const testCase of invalidCases) {
      expect(() =>
        createTradingConfig({
          env: createStaticEnv({
            ...testCase.extraEnv,
            [testCase.envKey]: testCase.value,
          }),
        }),
      ).toThrow(new RegExp(testCase.envKey));
    }
  });
});

describe('trading config single-instance validator rules', () => {
  it('rejects legacy indexed environment keys', async () => {
    const missingFields = await validateWithEnv(
      createStaticEnv({
        BASE_INSTRUMENT_SYMBOL_1: 'HSI.HK',
      }),
      createTradingConfig({
        env: createStaticEnv(),
      }),
    );
    expect(missingFields).toContain('BASE_INSTRUMENT_SYMBOL_1');
  });

  it('rejects deprecated BASE_INSTRUMENT_SYMBOL in single-instance mode', async () => {
    const missingFields = await validateWithEnv(
      createStaticEnv({
        BASE_INSTRUMENT_SYMBOL: 'HSCEI.HK',
      }),
      createTradingConfig({
        env: createStaticEnv(),
      }),
    );
    expect(missingFields).toContain('BASE_INSTRUMENT_SYMBOL');
  });

  it('rejects deprecated plain legacy strategy keys', async () => {
    const deprecatedKeys = [
      'SIGNAL_BUYCALL',
      'SIGNAL_SELLCALL',
      'SIGNAL_BUYPUT',
      'SIGNAL_SELLPUT',
      'VERIFICATION_DELAY_SECONDS_BUY',
      'VERIFICATION_DELAY_SECONDS_SELL',
      'VERIFICATION_INDICATORS_BUY',
      'VERIFICATION_INDICATORS_SELL',
      'SMART_CLOSE_ENABLED',
      'SMART_CLOSE_TIMEOUT_MINUTES',
    ] as const;

    for (const envKey of deprecatedKeys) {
      const missingFields = await validateWithEnv(
        createStaticEnv({
          [envKey]: 'deprecated',
        }),
        createTradingConfig({
          env: createStaticEnv(),
        }),
      );
      expect(missingFields).toContain(envKey);
    }
  });

  it('rejects indexed legacy strategy keys', async () => {
    const deprecatedKeys = [
      'SIGNAL_BUYCALL_1',
      'SIGNAL_SELLCALL_1',
      'SIGNAL_BUYPUT_1',
      'SIGNAL_SELLPUT_1',
      'VERIFICATION_DELAY_SECONDS_BUY_1',
      'VERIFICATION_DELAY_SECONDS_SELL_1',
      'VERIFICATION_INDICATORS_BUY_1',
      'VERIFICATION_INDICATORS_SELL_1',
      'SMART_CLOSE_ENABLED_1',
      'SMART_CLOSE_TIMEOUT_MINUTES_1',
    ] as const;

    for (const envKey of deprecatedKeys) {
      const missingFields = await validateWithEnv(
        createStaticEnv({
          [envKey]: 'deprecated',
        }),
        createTradingConfig({
          env: createStaticEnv(),
        }),
      );
      expect(missingFields).toContain(envKey);
    }
  });
});

describe('trading config fail-fast validator consistency', () => {
  it('matches parser semantics for critical global env keys', async () => {
    const invalidCases = [
      { envKey: 'DEBUG', value: 'maybe', extraEnv: {} },
      { envKey: 'DOOMSDAY_PROTECTION', value: 'maybe', extraEnv: {} },
      { envKey: 'MORNING_OPENING_PROTECTION_ENABLED', value: 'maybe', extraEnv: {} },
      { envKey: 'AFTERNOON_OPENING_PROTECTION_ENABLED', value: 'maybe', extraEnv: {} },
      { envKey: 'BUY_ORDER_TIMEOUT_ENABLED', value: 'maybe', extraEnv: {} },
      { envKey: 'SELL_ORDER_TIMEOUT_ENABLED', value: 'maybe', extraEnv: {} },
      {
        envKey: 'ALLOW_BUY_ORDER_TRACKING_ABOVE_INITIAL_PRICE',
        value: 'maybe',
        extraEnv: {},
      },
      {
        envKey: 'BUY_ORDER_TIMEOUT_SECONDS',
        value: '29',
        extraEnv: { BUY_ORDER_TIMEOUT_ENABLED: 'true' },
      },
      {
        envKey: 'BUY_ORDER_TIMEOUT_SECONDS',
        value: '601',
        extraEnv: { BUY_ORDER_TIMEOUT_ENABLED: 'true' },
      },
      {
        envKey: 'BUY_ORDER_TIMEOUT_SECONDS',
        value: 'abc',
        extraEnv: { BUY_ORDER_TIMEOUT_ENABLED: 'true' },
      },
      {
        envKey: 'SELL_ORDER_TIMEOUT_SECONDS',
        value: '29',
        extraEnv: { SELL_ORDER_TIMEOUT_ENABLED: 'true' },
      },
      {
        envKey: 'SELL_ORDER_TIMEOUT_SECONDS',
        value: '601',
        extraEnv: { SELL_ORDER_TIMEOUT_ENABLED: 'true' },
      },
      {
        envKey: 'SELL_ORDER_TIMEOUT_SECONDS',
        value: 'abc',
        extraEnv: { SELL_ORDER_TIMEOUT_ENABLED: 'true' },
      },
      { envKey: 'ORDER_MONITOR_PRICE_UPDATE_INTERVAL', value: '0', extraEnv: {} },
      { envKey: 'ORDER_MONITOR_PRICE_UPDATE_INTERVAL', value: '61', extraEnv: {} },
      { envKey: 'ORDER_MONITOR_PRICE_UPDATE_INTERVAL', value: 'abc', extraEnv: {} },
    ] as const;

    for (const testCase of invalidCases) {
      const baseEnv = createAutoEnv({
        ...testCase.extraEnv,
      });
      const tradingConfig = createTradingConfig({
        env: baseEnv,
      });
      const missingFields = await validateWithEnv(
        {
          ...baseEnv,
          [testCase.envKey]: testCase.value,
        },
        tradingConfig,
      );
      expect(missingFields).toContain(testCase.envKey);
    }
  });

  it('matches validator semantics for enabled open protection minute requirements', async () => {
    const baseTradingConfig = createTradingConfig({
      env: createAutoEnv(),
    });
    const invalidCases = [
      {
        env: createAutoEnv({
          MORNING_OPENING_PROTECTION_ENABLED: 'true',
          MORNING_OPENING_PROTECTION_MINUTES: '',
        }),
        tradingConfig: {
          ...baseTradingConfig,
          global: {
            ...baseTradingConfig.global,
            openProtection: {
              ...baseTradingConfig.global.openProtection,
              morning: {
                enabled: true,
                minutes: null,
              },
            },
          },
        },
        expectedKey: 'MORNING_OPENING_PROTECTION_MINUTES',
      },
      {
        env: createAutoEnv({
          AFTERNOON_OPENING_PROTECTION_ENABLED: 'true',
          AFTERNOON_OPENING_PROTECTION_MINUTES: '',
        }),
        tradingConfig: {
          ...baseTradingConfig,
          global: {
            ...baseTradingConfig.global,
            openProtection: {
              ...baseTradingConfig.global.openProtection,
              afternoon: {
                enabled: true,
                minutes: null,
              },
            },
          },
        },
        expectedKey: 'AFTERNOON_OPENING_PROTECTION_MINUTES',
      },
    ] as const;

    for (const testCase of invalidCases) {
      const missingFields = await validateWithEnv(testCase.env, testCase.tradingConfig);
      expect(missingFields).toContain(testCase.expectedKey);
    }
  });

  it('matches validator semantics for invalid liquidation cooldown raw env values', async () => {
    const validTradingConfig = createTradingConfig({
      env: createAutoEnv(),
    });
    const missingFields = await validateWithEnv(
      createAutoEnv({
        LIQUIDATION_COOLDOWN: 'abc',
      }),
      validTradingConfig,
    );

    expect(missingFields).toContain('LIQUIDATION_COOLDOWN');
  });
});
