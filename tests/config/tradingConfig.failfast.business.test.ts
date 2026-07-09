/**
 * tradingConfig fail-fast 业务测试
 *
 * 功能：
 * - 验证唯一 monitor 配置的解析与默认值行为。
 * - 验证关键非法值和 LONG/SHORT 同标的会立即失败。
 * - 验证解析层与校验层对关键字段的 fail-fast 口径保持一致。
 */
import { describe, expect, it } from 'bun:test';

import { createTradingConfig as parseTradingConfig } from '../../src/config/trading/index.js';
import { validateAllConfig } from '../../src/config/validator/index.js';
import { createTradingConfig } from '../../mock/factories/configFactory.js';
import { createMonitorConfigDouble } from '../helpers/testDoubles.js';

function createBaseEnv(overrides: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  return {
    LONGBRIDGE_AUTH_MODE: 'oauth',
    LONGBRIDGE_CLIENT_ID: 'client-id',
    MONITOR_SYMBOL: 'HSI.HK',
    ...overrides,
  };
}

function createSignalConfig() {
  return {
    conditionGroups: [
      {
        conditions: [{ indicator: 'K', operator: '>', threshold: 1 }],
        requiredCount: 1,
      },
    ],
  } as const;
}

function createValidTradingConfigForValidation() {
  const signalConfig = createSignalConfig();

  return createTradingConfig({
    monitor: createMonitorConfigDouble({
      orderOwnershipMapping: ['HSI'],
      signalConfig: {
        buycall: signalConfig,
        sellcall: signalConfig,
        buyput: signalConfig,
        sellput: signalConfig,
      },
    }),
  });
}

async function validateWithEnv(
  env: NodeJS.ProcessEnv,
  tradingConfig = createValidTradingConfigForValidation(),
): Promise<ReadonlyArray<string>> {
  try {
    await validateAllConfig({
      env,
      tradingConfig,
    });
    return [];
  } catch (error) {
    const validationError = error as { readonly missingFields?: ReadonlyArray<string> };
    return validationError.missingFields ?? [];
  }
}

const invalidMonitorEnvCases = [
  { envKey: 'TARGET_NOTIONAL', value: '0' },
  { envKey: 'TARGET_NOTIONAL', value: 'abc' },
  { envKey: 'MAX_POSITION_NOTIONAL', value: '-1' },
  { envKey: 'MAX_POSITION_NOTIONAL', value: 'abc' },
  { envKey: 'BUY_INTERVAL_SECONDS', value: '9' },
  { envKey: 'BUY_INTERVAL_SECONDS', value: '601' },
  { envKey: 'BUY_INTERVAL_SECONDS', value: 'abc' },
  {
    envKey: 'SWITCH_INTERVAL_MINUTES',
    value: '-1',
    extraEnv: { AUTO_SEARCH_ENABLED: 'true' },
  },
  {
    envKey: 'SWITCH_INTERVAL_MINUTES',
    value: '121',
    extraEnv: { AUTO_SEARCH_ENABLED: 'true' },
  },
  {
    envKey: 'SWITCH_INTERVAL_MINUTES',
    value: 'abc',
    extraEnv: { AUTO_SEARCH_ENABLED: 'true' },
  },
] as const;

const invalidGlobalNumberEnvCases = [
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
  { envKey: 'ORDER_MONITOR_PRICE_UPDATE_INTERVAL', value: '0' },
  { envKey: 'ORDER_MONITOR_PRICE_UPDATE_INTERVAL', value: '61' },
  { envKey: 'ORDER_MONITOR_PRICE_UPDATE_INTERVAL', value: 'abc' },
] as const;

const invalidOrderTypeEnvCases = [
  { envKey: 'TRADING_ORDER_TYPE', value: 'bad' },
  { envKey: 'LIQUIDATION_ORDER_TYPE', value: 'bad' },
] as const;

function createAutoSearchEnabledTradingConfig() {
  return createTradingConfig({
    monitor: createMonitorConfigDouble({
      autoSearchConfig: {
        autoSearchEnabled: true,
        autoSearchMinDistancePctBull: 0.35,
        autoSearchMinDistancePctBear: -0.35,
        autoSearchMinTurnoverPerMinuteBull: 100_000,
        autoSearchMinTurnoverPerMinuteBear: 100_000,
        autoSearchExpiryMinMonths: 3,
        autoSearchOpenDelayMinutes: 5,
        switchIntervalMinutes: 0,
        switchDistanceRangeBull: { min: 0.2, max: 1.5 },
        switchDistanceRangeBear: { min: -1.5, max: -0.2 },
      },
      orderOwnershipMapping: ['HSI'],
      signalConfig: {
        buycall: createSignalConfig(),
        sellcall: createSignalConfig(),
        buyput: createSignalConfig(),
        sellput: createSignalConfig(),
      },
    }),
  });
}

describe('trading config fail-fast parsing', () => {
  it('keeps mock default trading config inside the production validation contract', async () => {
    await validateAllConfig({
      env: createBaseEnv(),
      tradingConfig: createTradingConfig(),
    });
  });

  it('uses business defaults only when critical keys are missing', () => {
    const config = parseTradingConfig({
      env: createBaseEnv(),
    });

    expect(config.monitor.targetNotional).toBe(10_000);
    expect(config.monitor.maxPositionNotional).toBe(100_000);
    expect(config.monitor.buyIntervalSeconds).toBe(60);
    expect(config.monitor.autoSearchConfig.switchIntervalMinutes).toBe(0);
    expect(config.global.buyOrderTimeout.timeoutSeconds).toBe(180);
    expect(config.global.sellOrderTimeout.timeoutSeconds).toBe(180);
    expect(config.global.orderMonitorPriceUpdateInterval).toBe(5);
  });

  it('accepts switchIntervalMinutes=0 as a valid business value', () => {
    const config = parseTradingConfig({
      env: createBaseEnv({
        AUTO_SEARCH_ENABLED: 'true',
        SWITCH_INTERVAL_MINUTES: '0',
      }),
    });

    expect(config.monitor.autoSearchConfig.switchIntervalMinutes).toBe(0);
  });

  it('ignores invalid switchIntervalMinutes when auto-search is disabled', async () => {
    const config = parseTradingConfig({
      env: createBaseEnv({
        AUTO_SEARCH_ENABLED: 'false',
        SWITCH_INTERVAL_MINUTES: '121',
      }),
    });

    expect(config.monitor.autoSearchConfig.switchIntervalMinutes).toBe(0);

    const disabledAutoSearchTradingConfig = createTradingConfig({
      monitor: createMonitorConfigDouble({
        autoSearchConfig: {
          autoSearchEnabled: false,
          autoSearchMinDistancePctBull: null,
          autoSearchMinDistancePctBear: null,
          autoSearchMinTurnoverPerMinuteBull: null,
          autoSearchMinTurnoverPerMinuteBear: null,
          autoSearchExpiryMinMonths: 3,
          autoSearchOpenDelayMinutes: 5,
          switchIntervalMinutes: 0,
          switchDistanceRangeBull: null,
          switchDistanceRangeBear: null,
        },
        orderOwnershipMapping: ['HSI'],
        signalConfig: {
          buycall: createSignalConfig(),
          sellcall: createSignalConfig(),
          buyput: createSignalConfig(),
          sellput: createSignalConfig(),
        },
      }),
    });

    const missingFields = await validateWithEnv(
      createBaseEnv({
        AUTO_SEARCH_ENABLED: 'false',
        SWITCH_INTERVAL_MINUTES: '121',
      }),
      disabledAutoSearchTradingConfig,
    );
    expect(missingFields).not.toContain('SWITCH_INTERVAL_MINUTES');
  });

  it('ignores invalid timeout seconds when the corresponding timeout is disabled', async () => {
    const config = parseTradingConfig({
      env: createBaseEnv({
        BUY_ORDER_TIMEOUT_ENABLED: 'false',
        BUY_ORDER_TIMEOUT_SECONDS: '601',
        SELL_ORDER_TIMEOUT_ENABLED: 'false',
        SELL_ORDER_TIMEOUT_SECONDS: '29',
      }),
    });

    expect(config.global.buyOrderTimeout.timeoutSeconds).toBe(180);
    expect(config.global.sellOrderTimeout.timeoutSeconds).toBe(180);

    const validTradingConfig = createValidTradingConfigForValidation();
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
      createBaseEnv({
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

  it('fails fast when critical monitor-level keys are explicitly invalid or out of range', () => {
    for (const testCase of invalidMonitorEnvCases) {
      expect(() =>
        parseTradingConfig({
          env: createBaseEnv({
            ...('extraEnv' in testCase ? testCase.extraEnv : {}),
            [testCase.envKey]: testCase.value,
          }),
        }),
      ).toThrow(new RegExp(testCase.envKey));
    }
  });

  it('fails fast when critical global keys are explicitly invalid or out of range', () => {
    for (const testCase of [...invalidGlobalNumberEnvCases, ...invalidOrderTypeEnvCases]) {
      expect(() =>
        parseTradingConfig({
          env: createBaseEnv({
            ...('extraEnv' in testCase ? testCase.extraEnv : {}),
            [testCase.envKey]: testCase.value,
          }),
        }),
      ).toThrow(new RegExp(testCase.envKey));
    }
  });
});

describe('trading config validator rules', () => {
  it('rejects identical LONG/SHORT trading symbols in single-monitor mode', async () => {
    const signalConfig = createSignalConfig();
    const tradingConfig = createTradingConfig({
      monitor: createMonitorConfigDouble({
        longSymbol: '55131.HK',
        shortSymbol: '55131.HK',
        orderOwnershipMapping: ['HSI'],
        signalConfig: {
          buycall: signalConfig,
          sellcall: signalConfig,
          buyput: signalConfig,
          sellput: signalConfig,
        },
      }),
    });

    const missingFields = await validateWithEnv(
      createBaseEnv({
        LONG_SYMBOL: '55131.HK',
        SHORT_SYMBOL: '55131.HK',
      }),
      tradingConfig,
    );
    expect(missingFields).toContain('LONG_SYMBOL');
    expect(missingFields).toContain('SHORT_SYMBOL');
  });
});

describe('trading config fail-fast validator consistency', () => {
  it('matches parser semantics for critical monitor-level env keys', async () => {
    const autoSearchEnabledTradingConfig = createAutoSearchEnabledTradingConfig();

    for (const testCase of invalidMonitorEnvCases) {
      const missingFields = await validateWithEnv(
        createBaseEnv({
          ...('extraEnv' in testCase ? testCase.extraEnv : {}),
          [testCase.envKey]: testCase.value,
        }),
        'extraEnv' in testCase ? autoSearchEnabledTradingConfig : undefined,
      );
      expect(missingFields).toContain(testCase.envKey);
    }
  });

  it('matches parser semantics for critical global env keys', async () => {
    for (const testCase of invalidGlobalNumberEnvCases) {
      const missingFields = await validateWithEnv(
        createBaseEnv({
          ...('extraEnv' in testCase ? testCase.extraEnv : {}),
          [testCase.envKey]: testCase.value,
        }),
      );
      expect(missingFields).toContain(testCase.envKey);
    }
  });
});
