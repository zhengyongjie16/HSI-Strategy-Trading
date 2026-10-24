/**
 * Longbridge 客户端工厂边界测试。
 * 覆盖：认证前校验、OAuth/extra 映射、唯一 Config 的行情/交易共享以及同步 lazy 交易创建。
 */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { createSdkModuleMock } from '../sdkModuleMock.js';
import { createQuoteContextMock } from '../../../../../mock/longbridge/quoteContextMock.js';
import { createWarrantListCache } from '../../../../../src/infrastructure/longbridge/market/warrantListCache/index.js';

const sdkModuleMock = createSdkModuleMock();
const sdkConfig = { kind: 'sdk-config' };
const oauthHandle = { kind: 'oauth-handle' };
const fromOAuthCalls: Array<Readonly<{ oauth: unknown; extra: unknown }>> = [];
const fromApikeyCalls: Array<Readonly<{ credentials: ReadonlyArray<string>; extra: unknown }>> = [];
const oauthBuildCalls: Array<Readonly<{ clientId: string; callbackPort: number | undefined }>> = [];
const quoteConfigCalls: unknown[] = [];
const tradeConfigCalls: unknown[] = [];
let oauthCallbackError: Error | null = null;
let tradeCreateError: Error | null = null;

sdkModuleMock.install({
  Config: {
    fromOAuth: (oauth: unknown, extra: unknown) => {
      fromOAuthCalls.push({ oauth, extra });
      return sdkConfig;
    },
    fromApikey: (appKey: string, appSecret: string, accessToken: string, extra: unknown) => {
      fromApikeyCalls.push({ credentials: [appKey, appSecret, accessToken], extra });
      return sdkConfig;
    },
  },
  OAuth: {
    build: async (
      clientId: string,
      onOpenUrl: (error: Error | null, url: string) => void,
      callbackPort?: number,
    ) => {
      oauthBuildCalls.push({ clientId, callbackPort });
      onOpenUrl(oauthCallbackError, 'https://example.test/oauth');
      return oauthHandle;
    },
  },
  Language: { ZH_CN: 'sdk-zh-CN', ZH_HK: 'sdk-zh-HK', EN: 'sdk-en' },
  PushCandlestickMode: { Realtime: 'sdk-realtime', Confirmed: 'sdk-confirmed' },
  QuoteContext: {
    new: (config: unknown) => {
      quoteConfigCalls.push(config);
      return createQuoteContextMock();
    },
  },
  TradeContext: {
    new: (config: unknown) => {
      tradeConfigCalls.push(config);
      if (tradeCreateError !== null) throw tradeCreateError;

      return {};
    },
  },
});

const { createLongbridgeClientFactory } =
  await import('../../../../../src/infrastructure/longbridge/trade/clientFactory/index.js');

beforeEach(() => {
  fromOAuthCalls.length = 0;
  fromApikeyCalls.length = 0;
  oauthBuildCalls.length = 0;
  quoteConfigCalls.length = 0;
  tradeConfigCalls.length = 0;
  oauthCallbackError = null;
  tradeCreateError = null;
});

afterAll(async () => {
  sdkModuleMock.restore();
  await sdkModuleMock.assertRestored();
});

describe('Longbridge client factory', () => {
  it('rejects an invalid callback port before OAuth or Config creation', async () => {
    const error = await createLongbridgeClientFactory({
      env: {
        LONGBRIDGE_AUTH_MODE: 'oauth',
        LONGBRIDGE_CLIENT_ID: 'client-id',
        LONGBRIDGE_CALLBACK_PORT: '70000',
      },
    }).catch((error_: unknown) => error_);
    expect(error).toHaveProperty('message', expect.stringContaining('LONGBRIDGE_CALLBACK_PORT'));
    expect(oauthBuildCalls).toHaveLength(0);
    expect(fromOAuthCalls).toHaveLength(0);
    expect(quoteConfigCalls).toHaveLength(0);
    expect(tradeConfigCalls).toHaveLength(0);
  });

  it('rejects invalid extra values before creating a Config', async () => {
    const error = await createLongbridgeClientFactory({
      env: {
        LONGBRIDGE_AUTH_MODE: 'apikey',
        LONGBRIDGE_APP_KEY: 'app-key',
        LONGBRIDGE_APP_SECRET: 'app-secret',
        LONGBRIDGE_ACCESS_TOKEN: 'access-token',
        LONGBRIDGE_LANGUAGE: 'fr',
      },
    }).catch((error_: unknown) => error_);
    expect(error).toHaveProperty('message', expect.stringContaining('LONGBRIDGE_LANGUAGE'));
    expect(fromApikeyCalls).toHaveLength(0);
  });

  it('shares one Config while deferring market and synchronous trade creation to callers', async () => {
    const factory = await createLongbridgeClientFactory({
      env: {
        LONGBRIDGE_AUTH_MODE: 'apikey',
        LONGBRIDGE_APP_KEY: 'app-key',
        LONGBRIDGE_APP_SECRET: 'app-secret',
        LONGBRIDGE_ACCESS_TOKEN: 'access-token',
      },
      warrantListCacheConfig: { cache: createWarrantListCache(), ttlMs: 1000, nowMs: () => 0 },
    });
    expect(fromApikeyCalls).toEqual([
      { credentials: ['app-key', 'app-secret', 'access-token'], extra: {} },
    ]);

    expect(Object.keys(factory).sort((left, right) => left.localeCompare(right))).toEqual([
      'createBrokerAccess',
      'createMarketDataClient',
    ]);
    expect(quoteConfigCalls).toHaveLength(0);
    expect(tradeConfigCalls).toHaveLength(0);

    await factory.createMarketDataClient();
    expect(quoteConfigCalls).toHaveLength(1);
    expect(quoteConfigCalls[0]).toBe(sdkConfig);
    expect(tradeConfigCalls).toHaveLength(0);
    const brokerAccess = factory.createBrokerAccess();
    expect(tradeConfigCalls).toHaveLength(1);
    expect(tradeConfigCalls[0]).toBe(sdkConfig);
    expect(typeof brokerAccess.createTradeMutationPort).toBe('function');
    expect(fromApikeyCalls).toHaveLength(1);

    tradeCreateError = new Error('native trade construction failed');
    expect(() => factory.createBrokerAccess()).toThrow(tradeCreateError);
  });

  it('preserves OAuth URL/port and maps optional extra fields only at the SDK boundary', async () => {
    const openedUrls: string[] = [];
    await createLongbridgeClientFactory({
      env: {
        LONGBRIDGE_AUTH_MODE: 'oauth',
        LONGBRIDGE_CLIENT_ID: 'client-id',
        LONGBRIDGE_CALLBACK_PORT: '61234',
        LONGBRIDGE_HTTP_URL: 'https://example.test/http',
        LONGBRIDGE_QUOTE_WS_URL: 'wss://example.test/quote',
        LONGBRIDGE_TRADE_WS_URL: 'wss://example.test/trade',
        LONGBRIDGE_LANGUAGE: 'zh-HK',
        LONGBRIDGE_PUSH_CANDLESTICK_MODE: 'confirmed',
        LONGBRIDGE_ENABLE_OVERNIGHT: 'true',
        LONGBRIDGE_PRINT_QUOTE_PACKAGES: 'false',
        LONGBRIDGE_LOG_PATH: '/offline/sdk-log',
      },
      onOpenUrl: (url) => {
        openedUrls.push(url);
      },
    });
    expect(openedUrls).toEqual(['https://example.test/oauth']);
    expect(oauthBuildCalls).toEqual([{ clientId: 'client-id', callbackPort: 61234 }]);
    expect(fromOAuthCalls).toEqual([
      {
        oauth: oauthHandle,
        extra: {
          httpUrl: 'https://example.test/http',
          quoteWsUrl: 'wss://example.test/quote',
          tradeWsUrl: 'wss://example.test/trade',
          language: 'sdk-zh-HK',
          pushCandlestickMode: 'sdk-confirmed',
          enableOvernight: true,
          enablePrintQuotePackages: false,
          logPath: '/offline/sdk-log',
        },
      },
    ]);
    expect(fromApikeyCalls).toHaveLength(0);
    expect(quoteConfigCalls).toHaveLength(0);
    expect(tradeConfigCalls).toHaveLength(0);
  });

  it('propagates OAuth callback errors before Config/resource creation and omits an unset port', async () => {
    const failure = new Error('OAuth callback failed');
    oauthCallbackError = failure;
    const error = await createLongbridgeClientFactory({
      env: { LONGBRIDGE_AUTH_MODE: 'oauth', LONGBRIDGE_CLIENT_ID: 'client-id' },
    }).catch((error_: unknown) => error_);
    expect(error).toBe(failure);
    expect(oauthBuildCalls).toEqual([{ clientId: 'client-id', callbackPort: undefined }]);
    expect(fromOAuthCalls).toHaveLength(0);
    expect(quoteConfigCalls).toHaveLength(0);
    expect(tradeConfigCalls).toHaveLength(0);
  });
});
