import { createTerminationRuntime } from '../../../src/runtime/lifecycle/terminationRuntime.js';

/**
 * createPreGateRuntime 最小启动门禁测试
 *
 * 功能：验证启动阶段只初始化可靠交易日状态，不因非交易日或交易日接口异常阻断 pre-gate runtime 创建。
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';

import { createCleanup } from '../../../src/app/shutdown/createCleanup.js';
import type { CreatePreGateRuntimeParams } from '../../../src/app/types.js';
import { createExternalApiRequestError } from '../../helpers/createExternalApiRequestError.js';
import { createMarketDataClientDouble } from '../../helpers/testDoubles.js';
import { createBrokerClientFactoryDouble } from '../../helpers/brokerClientFactoryDouble.js';

let isTradingDayCalls = 0;
let tradingDayResolveError: Error | null = null;
let marketCreateCalls = 0;
let marketResetCalls = 0;
let onAuthCompleted = (): void => {};

let onMarketCreated = (): void => {};

mock.module('../../../src/app/runtime/createPreGateRuntimeDeps.js', () => ({
  DEFAULT_CREATE_PRE_GATE_RUNTIME_DEPS: {
    createLongbridgeClientFactory: async () => {
      onAuthCompleted();
      return createBrokerClientFactoryDouble({
        createMarketDataClient: async () => {
          marketCreateCalls += 1;
          onMarketCreated();
          return createMarketDataClientDouble({
            isTradingDay: async () => {
              isTradingDayCalls += 1;
              if (tradingDayResolveError !== null) {
                throw tradingDayResolveError;
              }

              return { isTradingDay: false, isHalfDay: false };
            },
            resetRuntimeSubscriptionsAndCaches: async () => {
              marketResetCalls += 1;
            },
          });
        },
      });
    },
  },
}));

const { createPreGateRuntime } = await import('../../../src/app/runtime/createPreGateRuntime.js');

function createRuntimeParams(): CreatePreGateRuntimeParams {
  return {
    cleanup: createCleanup(),
    termination: createTerminationRuntime({
      closeTradingGate: () => {},
      closeProducerAdmission: () => {},
      stopProducers: [],
      onSecondaryError: () => {},
    }),
    env: {
      MONITOR_SYMBOL: 'HSI.HK',
      LONG_SYMBOL: 'BULL.HK',
      SHORT_SYMBOL: 'BEAR.HK',
      ORDER_OWNERSHIP_MAPPING: 'HSI',
      LONGBRIDGE_AUTH_MODE: 'apikey',
      LONGBRIDGE_APP_KEY: 'app-key',
      LONGBRIDGE_APP_SECRET: 'app-secret',
      LONGBRIDGE_ACCESS_TOKEN: 'access-token',
    },
  };
}

describe('app createPreGateRuntime minimal startup gate', () => {
  beforeEach(() => {
    isTradingDayCalls = 0;
    tradingDayResolveError = null;
    marketCreateCalls = 0;
    marketResetCalls = 0;
    onAuthCompleted = () => {};

    onMarketCreated = () => {};
  });

  it('returns pre-gate runtime even when current day is not a trading day', async () => {
    const runtime = await createPreGateRuntime({
      cleanup: createCleanup(),
      termination: createTerminationRuntime({
        closeTradingGate: () => {},
        closeProducerAdmission: () => {},
        stopProducers: [],
        onSecondaryError: () => {},
      }),
      env: {
        MONITOR_SYMBOL: 'HSI.HK',
        LONG_SYMBOL: 'BULL.HK',
        SHORT_SYMBOL: 'BEAR.HK',
        ORDER_OWNERSHIP_MAPPING: 'HSI',
        LONGBRIDGE_AUTH_MODE: 'apikey',
        LONGBRIDGE_APP_KEY: 'app-key',
        LONGBRIDGE_APP_SECRET: 'app-secret',
        LONGBRIDGE_ACCESS_TOKEN: 'access-token',
      },
    });

    if (runtime === null) throw new Error('unexpected terminated runtime');

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
      termination: createTerminationRuntime({
        closeTradingGate: () => {},
        closeProducerAdmission: () => {},
        stopProducers: [],
        onSecondaryError: () => {},
      }),
      env: {
        MONITOR_SYMBOL: 'HSI.HK',
        LONG_SYMBOL: 'BULL.HK',
        SHORT_SYMBOL: 'BEAR.HK',
        ORDER_OWNERSHIP_MAPPING: 'HSI',
        LONGBRIDGE_AUTH_MODE: 'apikey',
        LONGBRIDGE_APP_KEY: 'app-key',
        LONGBRIDGE_APP_SECRET: 'app-secret',
        LONGBRIDGE_ACCESS_TOKEN: 'access-token',
      },
    });

    if (runtime === null) throw new Error('unexpected terminated runtime');

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
        termination: createTerminationRuntime({
          closeTradingGate: () => {},
          closeProducerAdmission: () => {},
          stopProducers: [],
          onSecondaryError: () => {},
        }),
        env: {
          MONITOR_SYMBOL: 'HSI.HK',
          LONG_SYMBOL: 'BULL.HK',
          SHORT_SYMBOL: 'BEAR.HK',
          ORDER_OWNERSHIP_MAPPING: 'HSI',
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

  it('does not create market resources when termination occurs during auth', async () => {
    const params = createRuntimeParams();
    onAuthCompleted = params.termination.requestShutdown;
    expect(await createPreGateRuntime(params)).toBeNull();
    expect(marketCreateCalls).toBe(0);
    expect(isTradingDayCalls).toBe(0);
  });

  it('registers market cleanup before returning after a terminated acquisition', async () => {
    const params = createRuntimeParams();
    onMarketCreated = params.termination.requestShutdown;
    expect(await createPreGateRuntime(params)).toBeNull();
    expect(marketCreateCalls).toBe(1);
    expect(isTradingDayCalls).toBe(0);
    expect(marketResetCalls).toBe(0);
    await params.cleanup.execute();
    expect(marketResetCalls).toBe(1);
  });
});
