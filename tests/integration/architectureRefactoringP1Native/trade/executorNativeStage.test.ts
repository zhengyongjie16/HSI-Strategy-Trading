import { createDiagnosticObserverDouble } from '../../../helpers/diagnostics.js';
import { nowMonotonicMs, wait } from '../../../../src/infrastructure/time/index.js';

import {
  createLoggerDouble,
  createMarketDataClientDouble,
  createOrderMonitorDouble,
  createOrderRecorderDouble,
  createQuoteDouble,
  createRiskCheckerDouble,
  createSymbolRegistryDouble,
} from '../../../helpers/testDoubles.js';

/** 实际Executor→生产FIFO→真实adapter/Decimal→离线SDK entry，非fake mutation port，无TradeContext构造。 */
import { describe, expect, it } from 'bun:test';
import {
  createNativeSubmitFixture,
  interceptNativeDecimalSerialization,
} from '../../../infrastructure/longbridge/trade/mutationStageFixture.js';
import { createOrderExecutor } from '../../../../src/application/orderExecution/index.js';
import { createRateLimiter } from '../../../../src/application/orderExecution/rateLimiter.js';
import {
  createTradingConfig,
  createMonitorConfig,
} from '../../../../mock/factories/configFactory.js';
import { createSignal } from '../../../../mock/factories/signalFactory.js';

const nowMs = Date.parse('2026-07-10T02:00:00.000Z');

function fixture(
  params: Readonly<{
    price?: string;
    type?: 'LO' | 'ELO';
    quoteFault?: Error;
    remoteFault?: Error;
    publishFault?: Error;
  }> = {},
) {
  const native = createNativeSubmitFixture(params.remoteFault);
  const trackedIds: string[] = [];
  let live = true;
  const config = createTradingConfig();
  const executor = createOrderExecutor({
    diagnostics: createDiagnosticObserverDouble(),
    logger: createLoggerDouble(),
    tradeMutationPort: native.port,
    readSellPositions: async () => [],
    rateLimiter: createRateLimiter({
      wait: wait,
      nowMonotonicMs: nowMonotonicMs,
      logger: createLoggerDouble(),
    }),
    marketDataClient: createMarketDataClientDouble({
      getQuotes: async () => {
        if (params.quoteFault) throw params.quoteFault;

        return new Map([
          ['BULL.HK', createQuoteDouble('BULL.HK', params.price ?? '9.234567891234567891', 100)],
        ]);
      },
    }),
    cacheManager: { clearCache: () => {} },
    orderMonitor: createOrderMonitorDouble({
      trackOrder: (order) => {
        trackedIds.push(order.orderId);
        if (params.publishFault) throw params.publishFault;
      },
    }),
    orderRecorder: createOrderRecorderDouble({ getLatestBuyOrderCost: () => null }),
    unrealizedLossBuyGate: createRiskCheckerDouble(),
    tradingConfig: createTradingConfig({
      monitor: createMonitorConfig({ targetNotional: '5000' }),
      global: { ...config.global, tradingOrderType: params.type ?? 'ELO' },
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
  const execute = (quantity: number | null = 100) =>
    executor.executeSignals(
      [
        {
          ...createSignal({ symbol: 'BULL.HK', action: 'BUYCALL', triggerTimeMs: nowMs }),
          quantity,
          action: 'BUYCALL',
        },
      ],
      () => live,
    );
  return {
    execute,
    nativeCalls: native.calls,
    trackedIds,
    revoke: () => {
      live = false;
    },
  };
}

async function rejection(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }

  throw new Error('expected rejection');
}

describe('executor actual native submission stages', () => {
  it('LO/ELO keep exact final price and fund-derived safe whole-lot quantity through native serialization', async () => {
    for (const type of ['LO', 'ELO'] as const) {
      const f = fixture({ type });
      expect(await f.execute(null)).toEqual({
        executedOrderIds: ['NATIVE-ACK'],
        quoteFailures: [],
      });
      expect(f.nativeCalls).toHaveLength(1);
      expect(f.nativeCalls[0]?.orderType).toBe(type);
      expect(f.nativeCalls[0]?.submittedPrice).toBe('9.234567891234567891');
      expect(f.nativeCalls[0]?.submittedQuantity).toBe('500');
      expect(f.trackedIds).toEqual(['NATIVE-ACK']);
    }
  });

  it('actual native capacity truncation and nonzero underflow reject before SDK entry', async () => {
    for (const price of ['18800.12345678901234567890123456', '0.00000000000000000000000000001']) {
      const f = fixture({ price });
      expect(await rejection(() => f.execute())).toBeInstanceOf(RangeError);
      expect(f.nativeCalls).toHaveLength(0);
      expect(f.trackedIds).toHaveLength(0);
    }
  });

  it('PRE_SUBMIT internal RangeError retains original identity even with current execution gate true', async () => {
    const fault = new RangeError('internal final quote contract');
    const f = fixture({ quoteFault: fault });
    expect(await rejection(() => f.execute())).toBe(fault);
    expect(f.nativeCalls).toHaveLength(0);
  });

  it('original caller revoked by actual serialization does not invoke SDK despite current gate still true', async () => {
    const f = fixture();
    const restoreSerialization = interceptNativeDecimalSerialization(f.revoke);

    try {
      expect(await f.execute()).toEqual({ executedOrderIds: [], quoteFailures: [] });
      expect(f.nativeCalls).toHaveLength(0);
      expect(f.trackedIds).toHaveLength(0);
    } finally {
      restoreSerialization();
    }
  });

  it('issued network uncertainty is fatal with original cause, exactly one native action and no invented ACK', async () => {
    const fault = new Error('network connection reset after native entry');
    const f = fixture({ remoteFault: fault });
    const error = await rejection(() => f.execute());
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      name: 'TradeMutationUnknownError',
      operation: 'TradeContext.submitOrder',
      requestAttempted: true,
      code: null,
    });
    expect(error instanceof Error ? error.cause : null).toBe(fault);
    expect(f.nativeCalls).toHaveLength(1);
    expect(f.trackedIds).toHaveLength(0);
  });

  it('accepted local publication failure retains acknowledged identity, cause and one actual remote action', async () => {
    const fault = new RangeError('local publication contract');
    const f = fixture({ publishFault: fault });
    const error = await rejection(() => f.execute());
    expect(error).toHaveProperty('name', 'AcceptedOrderLocalSyncError');
    expect(error).toHaveProperty('orderId', 'NATIVE-ACK');
    expect(error).toHaveProperty('cause', fault);
    expect(f.nativeCalls).toHaveLength(1);
    expect(f.trackedIds).toEqual(['NATIVE-ACK']);
  });
});
