import { createLoggerDouble } from '../helpers/testDoubles.js';

/**
 * Longbridge 认证配置业务测试
 *
 * 功能：
 * - 验证双认证模式下的启动配置校验行为
 */
import { describe, expect, it } from 'bun:test';
import { validateAllConfig } from '../../src/config/validator/index.js';
import { createMonitorConfig, createTradingConfig } from '../../mock/factories/configFactory.js';

import { readLongbridgeAuthConfig } from '../../src/config/auth/index.js';
import { readLongbridgeExtraConfig } from '../../src/config/auth/utils.js';

function createTradingConfigForValidation() {
  return createTradingConfig({
    monitor: createMonitorConfig({
      orderOwnershipMapping: ['HSI'],
    }),
  });
}

async function validateEnv(env: NodeJS.ProcessEnv): Promise<unknown> {
  try {
    await validateAllConfig({
      logger: createLoggerDouble(),
      env,
      tradingConfig: createTradingConfigForValidation(),
    });
    return null;
  } catch (error) {
    return error;
  }
}

describe('longbridge auth config validation', () => {
  it('rejects missing auth mode before auth fields are evaluated', async () => {
    const error = await validateEnv({
      LONGBRIDGE_CLIENT_ID: 'client-id',
    });

    expect(error).not.toBeNull();
  });

  it('rejects an invalid auth mode', async () => {
    const error = await validateEnv({
      LONGBRIDGE_AUTH_MODE: 'token',
      LONGBRIDGE_CLIENT_ID: 'client-id',
    });

    expect(error).not.toBeNull();
  });

  it('rejects the .env.example placeholder client id as missing config', async () => {
    const error = await validateEnv({
      LONGBRIDGE_AUTH_MODE: 'oauth',
      LONGBRIDGE_CLIENT_ID: 'your_longbridge_client_id',
    });

    expect(error).not.toBeNull();
  });

  it('rejects an invalid callback port', async () => {
    const error = await validateEnv({
      LONGBRIDGE_AUTH_MODE: 'oauth',
      LONGBRIDGE_CLIENT_ID: 'client-id',
      LONGBRIDGE_CALLBACK_PORT: '70000',
    });

    expect(error).not.toBeNull();
  });

  it('rejects invalid sdk extra config values', async () => {
    const error = await validateEnv({
      LONGBRIDGE_AUTH_MODE: 'oauth',
      LONGBRIDGE_CLIENT_ID: 'client-id',
      LONGBRIDGE_HTTP_URL: 'not-a-url',
      LONGBRIDGE_LANGUAGE: 'fr',
      LONGBRIDGE_PUSH_CANDLESTICK_MODE: 'streaming',
      LONGBRIDGE_ENABLE_OVERNIGHT: 'maybe',
      LONGBRIDGE_PRINT_QUOTE_PACKAGES: 'sometimes',
    });

    expect(error).not.toBeNull();
  });

  it('accepts a complete apikey config', async () => {
    const error = await validateEnv({
      LONGBRIDGE_AUTH_MODE: 'apikey',
      LONGBRIDGE_APP_KEY: 'app-key',
      LONGBRIDGE_APP_SECRET: 'app-secret',
      LONGBRIDGE_ACCESS_TOKEN: 'access-token',
    });

    expect(error).toBeNull();
  });

  it('rejects missing apikey fields individually', async () => {
    const error = await validateEnv({
      LONGBRIDGE_AUTH_MODE: 'apikey',
      LONGBRIDGE_APP_KEY: 'app-key',
      LONGBRIDGE_APP_SECRET: 'app-secret',
    });

    expect(error).not.toBeNull();
  });

  it('treats apikey placeholder values from .env.example as missing config', async () => {
    const error = await validateEnv({
      LONGBRIDGE_AUTH_MODE: 'apikey',
      LONGBRIDGE_APP_KEY: 'your_longbridge_app_key',
      LONGBRIDGE_APP_SECRET: 'your_longbridge_app_secret',
      LONGBRIDGE_ACCESS_TOKEN: 'your_longbridge_access_token',
    });

    expect(error).not.toBeNull();
  });

  it('reads neutral auth and extra values without SDK enums or defaulted fields', () => {
    expect(
      readLongbridgeAuthConfig({
        LONGBRIDGE_AUTH_MODE: 'oauth',
        LONGBRIDGE_CLIENT_ID: 'client-id',
      }),
    ).toEqual({ mode: 'oauth', clientId: 'client-id', callbackPort: null });
    expect(readLongbridgeExtraConfig({})).toEqual({});
    expect(
      readLongbridgeExtraConfig({
        LONGBRIDGE_LANGUAGE: 'zh-HK',
        LONGBRIDGE_PUSH_CANDLESTICK_MODE: 'confirmed',
        LONGBRIDGE_ENABLE_OVERNIGHT: 'false',
        LONGBRIDGE_PRINT_QUOTE_PACKAGES: 'false',
      }),
    ).toEqual({
      language: 'zh-HK',
      pushCandlestickMode: 'confirmed',
      enableOvernight: false,
      enablePrintQuotePackages: false,
    });
  });
});
