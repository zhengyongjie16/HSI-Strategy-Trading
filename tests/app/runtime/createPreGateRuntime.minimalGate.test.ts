/**
 * createPreGateRuntime 最小启动门禁测试
 *
 * 功能：验证启动阶段只初始化可靠交易日状态，不因非交易日或交易日接口异常阻断 pre-gate runtime 创建。
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';

import { createCleanup } from '../../../src/app/shutdown/createCleanup.js';
import { createExternalApiRequestError } from '../../helpers/createExternalApiRequestError.js';
import { createMarketDataClientDouble, createSdkConfigDouble } from '../../helpers/testDoubles.js';

let isTradingDayCalls = 0;
let tradingDayResolveError: Error | null = null;

mock.module('../../../src/app/runtime/createPreGateRuntimeDeps.js', () => ({
  DEFAULT_CREATE_PRE_GATE_RUNTIME_DEPS: {
    createSdkConfigFromAuth: async () => createSdkConfigDouble(),
    createMarketDataClient: async () =>
      createMarketDataClientDouble({
        isTradingDay: async () => {
          isTradingDayCalls += 1;
          if (tradingDayResolveError !== null) {
            throw tradingDayResolveError;
          }

          return { isTradingDay: false, isHalfDay: false };
        },
      }),
  },
}));

const { createPreGateRuntime } = await import('../../../src/app/runtime/createPreGateRuntime.js');

describe('app createPreGateRuntime minimal startup gate', () => {
  beforeEach(() => {
    isTradingDayCalls = 0;
    tradingDayResolveError = null;
  });

  it('returns pre-gate runtime even when current day is not a trading day', async () => {
    const runtime = await createPreGateRuntime({
      cleanup: createCleanup(),
      env: {
        MONITOR_SYMBOL: 'HSI.HK',
        LONG_SYMBOL: 'BULL.HK',
        SHORT_SYMBOL: 'BEAR.HK',
        ORDER_OWNERSHIP_MAPPING: 'HSI',
        SIGNAL_BUYCALL: '(RSI:6<25,MFI<20,D<25,J<0)/3|(J<-20)',
        SIGNAL_SELLCALL: '(RSI:6>75,MFI>80,D>75,J>100)/3|(J>110)',
        SIGNAL_BUYPUT: '(RSI:6>75,MFI>80,D>75,J>100)/3|(J>120)',
        SIGNAL_SELLPUT: '(RSI:6<25,MFI<20,D<25,J<0)/3|(J<-15)',
        LONGBRIDGE_AUTH_MODE: 'apikey',
        LONGBRIDGE_APP_KEY: 'app-key',
        LONGBRIDGE_APP_SECRET: 'app-secret',
        LONGBRIDGE_ACCESS_TOKEN: 'access-token',
      },
    });

    expect(runtime.startupTradingDayInfo?.info).toEqual({
      isTradingDay: false,
      isHalfDay: false,
    });
    expect(runtime.startupTradingDayInfo?.dateKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(isTradingDayCalls).toBe(1);
  });

  it('keeps startup trading day unknown when trading day API request fails', async () => {
    tradingDayResolveError = await createExternalApiRequestError({
      operation: 'QuoteContext.isTradingDay',
      attempts: 1,
      cause: new Error('trading day service unavailable'),
    });
    const runtime = await createPreGateRuntime({
      cleanup: createCleanup(),
      env: {
        MONITOR_SYMBOL: 'HSI.HK',
        LONG_SYMBOL: 'BULL.HK',
        SHORT_SYMBOL: 'BEAR.HK',
        ORDER_OWNERSHIP_MAPPING: 'HSI',
        SIGNAL_BUYCALL: '(RSI:6<25,MFI<20,D<25,J<0)/3|(J<-20)',
        SIGNAL_SELLCALL: '(RSI:6>75,MFI>80,D>75,J>100)/3|(J>110)',
        SIGNAL_BUYPUT: '(RSI:6>75,MFI>80,D>75,J>100)/3|(J>120)',
        SIGNAL_SELLPUT: '(RSI:6<25,MFI<20,D<25,J<0)/3|(J<-15)',
        LONGBRIDGE_AUTH_MODE: 'apikey',
        LONGBRIDGE_APP_KEY: 'app-key',
        LONGBRIDGE_APP_SECRET: 'app-secret',
        LONGBRIDGE_ACCESS_TOKEN: 'access-token',
      },
    });

    expect(runtime.startupTradingDayInfo).toBeNull();
    expect(isTradingDayCalls).toBe(1);
  });

  it('rethrows non API startup trading day resolution errors', async () => {
    const internalError = new Error('trading day parser broken');
    tradingDayResolveError = internalError;
    let caught: unknown = null;
    try {
      await createPreGateRuntime({
        cleanup: createCleanup(),
        env: {
          MONITOR_SYMBOL: 'HSI.HK',
          LONG_SYMBOL: 'BULL.HK',
          SHORT_SYMBOL: 'BEAR.HK',
          ORDER_OWNERSHIP_MAPPING: 'HSI',
          SIGNAL_BUYCALL: '(RSI:6<25,MFI<20,D<25,J<0)/3|(J<-20)',
          SIGNAL_SELLCALL: '(RSI:6>75,MFI>80,D>75,J>100)/3|(J>110)',
          SIGNAL_BUYPUT: '(RSI:6>75,MFI>80,D>75,J>100)/3|(J>120)',
          SIGNAL_SELLPUT: '(RSI:6<25,MFI<20,D<25,J<0)/3|(J<-15)',
          LONGBRIDGE_AUTH_MODE: 'apikey',
          LONGBRIDGE_APP_KEY: 'app-key',
          LONGBRIDGE_APP_SECRET: 'app-secret',
          LONGBRIDGE_ACCESS_TOKEN: 'access-token',
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(internalError);
    expect(isTradingDayCalls).toBe(1);
  });
});
