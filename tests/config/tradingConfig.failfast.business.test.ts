/**
 * tradingConfig fail-fast 业务测试
 *
 * 功能：
 * - 验证单实例关键交易配置在显式非法/越界时立即失败
 * - 验证缺失时仅保留当前业务允许的默认值
 * - 验证解析层与校验层对关键配置的非法值判定一致
 */
import { describe, expect, it } from 'bun:test';

import { createTradingConfig } from '../../src/config/trading/index.js';
import { validateAllConfig } from '../../src/config/validator/index.js';

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
  it('uses business defaults only when critical keys are missing', () => {
    const config = createTradingConfig({
      env: createStaticEnv(),
    });

    expect(config.strategy.targetNotional).toBe(10_000);
    expect(config.strategy.maxPositionNotional).toBe(100_000);
    expect(config.strategy.buyIntervalSeconds).toBe(60);
    expect(config.strategy.autoSearchConfig.switchIntervalMinutes).toBe(0);
    expect(config.global.buyOrderTimeout.timeoutSeconds).toBe(180);
    expect(config.global.sellOrderTimeout.timeoutSeconds).toBe(180);
    expect(config.global.orderMonitorPriceUpdateInterval).toBe(5);
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

    expect(config.global.buyOrderTimeout.timeoutSeconds).toBe(180);
    expect(config.global.sellOrderTimeout.timeoutSeconds).toBe(180);

    const validTradingConfig = createTradingConfig({
      env: createStaticEnv(),
    });
    const disabledTimeoutTradingConfig = {
      ...validTradingConfig,
      global: {
        ...validTradingConfig.global,
        buyOrderTimeout: {
          enabled: false,
          timeoutSeconds: 180,
        },
        sellOrderTimeout: {
          enabled: false,
          timeoutSeconds: 180,
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

  it('reports missing static seat symbols during validation', async () => {
    const env = {
      LONGBRIDGE_AUTH_MODE: 'oauth',
      LONGBRIDGE_CLIENT_ID: 'client-id',
      ORDER_OWNERSHIP_MAPPING: 'HSI',
    } satisfies NodeJS.ProcessEnv;
    const missingFields = await validateWithEnv(
      env,
      createTradingConfig({
        env,
      }),
    );
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

  it('fails fast when critical global keys are explicitly invalid or out of range', () => {
    const invalidCases = [
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
      const missingFields = await validateWithEnv(
        createAutoEnv({
          ...testCase.extraEnv,
          [testCase.envKey]: testCase.value,
        }),
      );
      expect(missingFields).toContain(testCase.envKey);
    }
  });
});
