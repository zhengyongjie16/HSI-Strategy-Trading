import { expect, test } from 'bun:test';
import { createBrokerIngressFixture } from './brokerIngressFixture.js';
import { createRateLimiter } from '../../../../src/core/trader/rateLimiter.js';
import {
  createTradingConfig,
  createMonitorConfig,
} from '../../../../mock/factories/configFactory.js';
import { createSignal } from '../../../../mock/factories/signalFactory.js';
import {
  createMarketDataClientDouble,
  createQuoteDouble,
  createOrderMonitorDouble,
  createOrderRecorderDouble,
  createRiskCheckerDouble,
  createSymbolRegistryDouble,
} from '../../../helpers/testDoubles.js';

const nowMs = Date.parse('2026-07-10T02:00:00.000Z');
test('actual BUY/ELO native entry observations precede reply failure and retain original failure identity', async () => {
  const f = await createBrokerIngressFixture({
    orderId: 'SEED',
    tradeId: 'T',
    symbol: 'BULL.HK',
    stockName: 'SDK',
    remark: '',
    side: 'BUY',
    status: 'New',
    quantity: '100',
    executedQuantity: '0',
    submittedPrice: '9.2',
    executedPrice: '0',
    submittedAtMs: nowMs,
    executionTimeMs: null,
    updatedAtMs: nowMs,
  });
  const cause = new TypeError('issued native submit failure');
  const config = createTradingConfig();
  f.setSubmitBehavior(async () => {
    expect(f.nativeSubmitObservations()).toHaveLength(1);
    throw cause;
  });
  const executor = f.createExecutor({
    rateLimiter: createRateLimiter(),
    marketDataClient: createMarketDataClientDouble({
      getQuotes: async () =>
        new Map([['BULL.HK', createQuoteDouble('BULL.HK', '9.234567891234567891', 100)]]),
    }),
    cacheManager: { clearCache: () => {}, getPendingOrders: async () => [] },
    orderMonitor: createOrderMonitorDouble(),
    orderRecorder: createOrderRecorderDouble({ getLatestBuyOrderCost: () => null }),
    unrealizedLossBuyGate: createRiskCheckerDouble(),
    tradingConfig: createTradingConfig({
      monitor: createMonitorConfig({ targetNotional: '5000' }),
      global: { ...config.global, tradingOrderType: 'ELO' },
    }),
    symbolRegistry: createSymbolRegistryDouble(),
    isExecutionAllowed: () => true,
    isContinuousTradingAllowed: () => true,
    now: () => new Date(nowMs),
    readCurrentTradingDayInfo: () => ({
      dateKey: '2026-07-10',
      info: { isTradingDay: true, isHalfDay: false },
    }),
  });
  expect(f.nativeSubmitObservations()).toEqual([]);
  const result = await executor
    .executeSignals(
      [
        {
          ...createSignal({ symbol: 'BULL.HK', action: 'BUYCALL', triggerTimeMs: nowMs }),
          quantity: 100,
        },
      ],
      () => true,
    )
    .catch((error: unknown) => error);
  expect(result).toBe(cause);
  expect(f.nativeSubmitObservations()).toMatchObject([
    {
      symbol: 'BULL.HK',
      side: 'BUY',
      orderType: 'ELO',
      quantity: '100',
      price: '9.234567891234567891',
      timeInForce: 'DAY',
    },
  ]);
  expect(f.nativeMutations()).toHaveLength(1);
});
