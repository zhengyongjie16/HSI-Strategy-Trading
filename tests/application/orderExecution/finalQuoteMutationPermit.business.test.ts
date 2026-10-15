/**
 * 终态行情与 trade mutation permit 业务测试
 *
 * 覆盖最终 SDK 下单边界必须在 permit 内读取行情、重新授权并基于终态行情构造 payload 的约束。
 */
import { describe, expect, it } from 'bun:test';
import { createBrokerIngressFixture } from '../../integration/architectureRefactoringP1Native/trade/brokerIngressFixture.js';
import { createUnrealizedLossChecker } from '../../../src/domain/risk/unrealizedLossChecker.js';
import { createExecutionFixture } from '../orderTracking/recorder/executionFixture.js';
import type { OrderExecutionTrackingPort } from '../../../src/application/orderExecution/types.js';
import type { TrackOrderParams } from '../../../src/domain/order/types.js';
import { createMonitorConfig, createTradingConfig } from '../../../mock/factories/configFactory.js';
import { createSignal } from '../../../mock/factories/signalFactory.js';
import {
  createAccountSnapshotDouble,
  createMarketDataClientDouble,
  createOrderMonitorDouble as createBaseOrderMonitorDouble,
  createOrderRecorderDouble,
  createQuoteDouble,
  createRateLimiterDouble,
  createSymbolRegistryDouble,
} from '../../helpers/testDoubles.js';
import type { RateLimiter, RiskChecker } from '../../../src/types/services.js';
import type { OrderCostBasis } from '../../../src/types/orderRecorder.js';
import type { ExecutableSignal } from '../../../src/types/signal.js';
import { safeQuantityNumber } from '../../../src/utils/numeric/exact.js';

const EXECUTION_NOW_MS = Date.parse('2026-07-10T02:00:00.000Z');

function createMutationRateLimiter(events: string[]): RateLimiter {
  return createRateLimiterDouble({
    onThrottle: () => {
      events.push('throttle');
    },
    onMutationPermitAcquired: () => {
      events.push('permit');
    },
    onMutationInvoked: () => {
      events.push('invoke');
    },
  });
}

function createOrderMonitorDouble(trackedOrders: TrackOrderParams[]): OrderExecutionTrackingPort {
  return createBaseOrderMonitorDouble({
    trackOrder: (params) => {
      trackedOrders.push(params);
    },
  });
}

type NativeExecutionFixture = Awaited<ReturnType<typeof createBrokerIngressFixture>>;
function readSubmittedPrice(
  observation: ReturnType<NativeExecutionFixture['nativeSubmitObservations']>[number] | undefined,
): string | null {
  return observation?.price ?? null;
}

function readSubmittedQuantity(
  observation: ReturnType<NativeExecutionFixture['nativeSubmitObservations']>[number] | undefined,
): number | null {
  return observation === undefined ? null : safeQuantityNumber(observation.quantity);
}

async function createNativeExecutionFixture() {
  return createBrokerIngressFixture({
    orderId: 'FINAL-QUOTE-NATIVE',
    tradeId: 'NO-EXECUTION',
    symbol: 'BULL.HK',
    stockName: 'BULL',
    remark: '',
    side: 'BUY',
    orderType: 'ELO',
    status: 'New',
    quantity: '100',
    executedQuantity: '0',
    submittedPrice: '1',
    executedPrice: '0',
    submittedAtMs: EXECUTION_NOW_MS,
    executionTimeMs: null,
    updatedAtMs: EXECUTION_NOW_MS,
  });
}

async function captureCallerAuthority(currentTime: Date, native: NativeExecutionFixture) {
  const account = native.createAccountService({ rateLimiter: createRateLimiterDouble() });
  const f = createExecutionFixture({
    nowMs: currentTime.getTime(),
    readPort: {
      getAccountSnapshot: async () => createAccountSnapshotDouble('10000'),
      getStockPositions: async () => account.getStockPositions({ symbols: ['BULL.HK'] }),
    },
  });
  const issued = f.snapshot.requestRefresh({
    source: 'FINAL_QUOTE_CALLER',
    dayEpoch: f.snapshot.getView().token.dayEpoch,
    refreshAccount: true,
    refreshPositions: true,
  });
  const receipt = await issued.result;
  if (receipt.status !== 'COMMITTED') throw new Error('final quote caller baseline aborted');

  const captured = receipt.snapshotToken;
  return {
    economic: f,
    callerAuthorization: () =>
      !f.termination.isTerminated() &&
      f.snapshot.isCurrent(captured, { account: true, positions: true, paired: true }),
  };
}

async function createBuyExecutionFixture(params: {
  readonly getQuote: () => Promise<ReturnType<typeof createQuoteDouble> | null>;
  readonly latestBuyCost?: OrderCostBasis | null;
  readonly isExecutionAllowed?: () => boolean;
  readonly symbolRegistry?: ReturnType<typeof createSymbolRegistryDouble>;
  readonly unrealizedLossBuyGate?: Pick<RiskChecker, 'checkUnrealizedLoss'>;
}) {
  const currentTime = new Date(EXECUTION_NOW_MS);
  const native = await createNativeExecutionFixture();
  native.setStockPositions([]);
  const events: string[] = [];
  const trackedOrders: TrackOrderParams[] = [];
  const authority = await captureCallerAuthority(currentTime, native);
  let quoteReadCount = 0;
  const unrealizedLossBuyGate: Pick<RiskChecker, 'checkUnrealizedLoss'> =
    params.unrealizedLossBuyGate ?? {
      checkUnrealizedLoss: () => ({ shouldLiquidate: false }),
    };
  const executorDeps = {
    rateLimiter: createMutationRateLimiter(events),
    marketDataClient: createMarketDataClientDouble({
      getQuotes: async (symbols) => {
        const requestedSymbols = [...symbols];
        expect(requestedSymbols).toEqual(['BULL.HK']);
        quoteReadCount += 1;
        events.push('quote');
        const quote = await params.getQuote();
        return new Map([['BULL.HK', quote]]);
      },
    }),
    cacheManager: {
      clearCache: () => {},
    },
    orderMonitor: createOrderMonitorDouble(trackedOrders),
    orderRecorder: createOrderRecorderDouble({
      getLatestBuyOrderCost: () => params.latestBuyCost ?? null,
    }),
    tradingConfig: createTradingConfig({
      monitor: createMonitorConfig({ targetNotional: '5000' }),
    }),
    symbolRegistry: params.symbolRegistry ?? createSymbolRegistryDouble(),
    isExecutionAllowed: params.isExecutionAllowed ?? (() => true),
    isContinuousTradingAllowed: () => true,
    now: () => currentTime,
    readCurrentTradingDayInfo: () => ({
      dateKey: '2026-07-10',
      info: { isTradingDay: true, isHalfDay: false },
    }),
    unrealizedLossBuyGate,
  };
  const executor = native.createExecutor(executorDeps);

  return {
    events,
    callerAuthorization: authority.callerAuthorization,
    executor,
    quoteReadCount: () => quoteReadCount,
    trackedOrders,
    native,
  };
}

async function createSellExecutionFixture(params: {
  readonly getQuote: () => Promise<ReturnType<typeof createQuoteDouble> | null>;
  readonly currentTime?: Date;
  readonly pendingSellOrders?: ReturnType<OrderExecutionTrackingPort['getPendingSellOrders']>;
  readonly cancelAcknowledges?: boolean;
  readonly observeNativeCancel?: (orderId: string) => void;
  readonly observeNativeReplace?: (orderId: string, price: string, quantity: number | null) => void;
  readonly unrealizedLossBuyGate?: Pick<RiskChecker, 'checkUnrealizedLoss'>;
}) {
  const currentTime = params.currentTime ?? new Date(EXECUTION_NOW_MS);
  const native = await createNativeExecutionFixture();
  native.setStockPositions([
    {
      symbol: 'BULL.HK',
      symbolName: 'BULL',
      accountChannel: 'HK',
      currency: 'HKD',
      quantity: '300',
      availableQuantity: '300',
      costPrice: '1',
    },
  ]);
  const events: string[] = [];
  const trackedOrders: TrackOrderParams[] = [];
  const authority = await captureCallerAuthority(currentTime, native);
  let quoteReadCount = 0;
  const pendingOrders = params.pendingSellOrders ?? [];
  const detailFrames = pendingOrders.map((order) => ({
    orderId: order.orderId,
    tradeId: 'FINAL-QUOTE-' + order.orderId,
    symbol: order.symbol,
    stockName: 'HSI RC',
    remark: '',
    side: order.side,
    orderType: order.orderType === 'MO' ? ('MO' as const) : ('ELO' as const),
    status: 'Canceled' as const,
    quantity: String(order.submittedQuantity),
    executedQuantity: String(order.executedQuantity),
    submittedPrice: order.submittedPrice ?? '0',
    executedPrice: '0',
    submittedAtMs: order.submittedAt,
    executionTimeMs: null,
    updatedAtMs: currentTime.getTime(),
  }));
  native.setOrderDetailReplies(detailFrames);
  if (params.cancelAcknowledges === true) {
    native.setCancelBeforeReply(async () => {});
  } else {
    native.setCancelFailure(
      Object.assign(new Error('original order already canceled'), { code: '601012' }),
    );
  }

  const operations = native.createOperations({
    runtime: authority.economic.runtime,
    rateLimiter: createMutationRateLimiter(events),
    orderRecorder: authority.economic.recorder,
    orderHoldRegistry: authority.economic.holds,
    monitorConfig: createTradingConfig().monitor,
    now: () => currentTime,
    captureWorkGuard: () => authority.callerAuthorization,
    termination: authority.economic.termination,
    cacheManager: { clearCache() {}, getPendingOrders: async () => [] },
    recordCumulativeExecution: (input) => {
      authority.economic.flow.recordCumulativeExecution(input);
    },
    triggerRoute() {},
    getExecutionTimeEvidence: () => [],
  });
  for (const order of pendingOrders) {
    authority.economic.recorder.submitSellOrder(
      order.orderId,
      order.symbol,
      'LONG',
      order.submittedQuantity,
      [],
      false,
      order.submittedAt,
    );

    operations.trackOrder({
      orderId: order.orderId,
      symbol: order.symbol,
      side: order.side,
      executionSide: order.side,
      price: order.submittedPrice,
      initialSubmittedPrice: order.submittedPrice,
      quantity: order.submittedQuantity,
      submittedAtMs: order.submittedAt,
      initialStatus: order.status,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: order.orderType,
    });
  }

  native.setReplaceBeforeReply(async () => {
    const replacements = native.nativeMutations().filter((mutation) => mutation.kind === 'REPLACE');
    const replacement = replacements.at(-1);
    if (
      replacement?.price === undefined ||
      replacement.price === null ||
      replacement.orderId === null
    )
      throw new Error('expected actual native replacement');

    params.observeNativeReplace?.(
      replacement.orderId,
      replacement.price,
      safeQuantityNumber(replacement.quantity),
    );
  });
  const orderMonitorOverrides: Partial<OrderExecutionTrackingPort> = {
    trackOrder: (trackedOrder: TrackOrderParams) => {
      trackedOrders.push(trackedOrder);
    },
    cancelOrder: async (orderId, request) => {
      const outcome = await operations.cancelOrder(orderId, request);
      params.observeNativeCancel?.(orderId);

      if (outcome.kind === 'CANCEL_NOT_STARTED')
        throw new Error('native cancel did not issue under the original owner');

      // SDK ACK 不关闭本地占位；仅把真实 state-check 得到的可信终态交给本地结算链。
      if (outcome.kind === 'ALREADY_CLOSED') {
        const terminal = authority.economic.runtime.queriedTerminalStateByOrderId.get(orderId);
        if (
          terminal?.kind !== 'TERMINAL' ||
          terminal.submittedQuantity === null ||
          terminal.executedQuantity === null
        ) {
          throw new Error('final quote fixture missing trusted terminal quantities');
        }

        const settled = authority.economic.flow.settleOrder({
          orderId,
          closedReason: terminal.closedReason,
          source: 'STATE_CHECK',
          executedPrice: terminal.executedPrice,
          executedAmount: terminal.executedAmount,
          executedQuantity: terminal.executedQuantity,
          executedTimeMs: terminal.executionTimeMs,
          orderUpdatedAtMs: terminal.orderUpdatedAtMs,
        });
        if (!settled.handled)
          throw new Error('final quote fixture terminal settlement not handled');
      }

      return outcome;
    },
    getPendingSellOrders: (symbol) =>
      pendingOrders.filter(
        (order) =>
          order.symbol === symbol && authority.economic.runtime.trackedOrders.has(order.orderId),
      ),
    replaceOrderPriceWithPermit: operations.replaceOrderPriceWithPermit,
  };

  const orderMonitor = createBaseOrderMonitorDouble(orderMonitorOverrides);
  const executor = native.createExecutor({
    rateLimiter: createMutationRateLimiter(events),
    marketDataClient: createMarketDataClientDouble({
      getQuotes: async (symbols) => {
        expect([...symbols]).toEqual(['BULL.HK']);
        quoteReadCount += 1;
        events.push('quote');
        const quote = await params.getQuote();
        return new Map([['BULL.HK', quote]]);
      },
    }),
    cacheManager: {
      clearCache: () => {},
    },
    orderMonitor,
    orderRecorder: createOrderRecorderDouble(),
    unrealizedLossBuyGate: params.unrealizedLossBuyGate ?? {
      checkUnrealizedLoss: () => ({ shouldLiquidate: false }),
    },
    tradingConfig: createTradingConfig({
      monitor: createMonitorConfig({ targetNotional: '5000' }),
    }),
    symbolRegistry: createSymbolRegistryDouble(),
    isExecutionAllowed: () => true,
    isContinuousTradingAllowed: () => true,
    now: () => currentTime,
    readCurrentTradingDayInfo: () => ({
      dateKey: '2026-07-10',
      info: { isTradingDay: true, isHalfDay: false },
    }),
  });

  return {
    events,
    callerAuthorization: authority.callerAuthorization,
    executor,
    quoteReadCount: () => quoteReadCount,
    trackedOrders,
    getPendingSellOrders: orderMonitor.getPendingSellOrders,
    settledOrders: authority.economic.events,
    native,
  };
}

describe('OrderExecutor terminal quote mutation permit', () => {
  it('uses P1 read after the permit for buy payload quantity and tracked price', async () => {
    const fixture = await createBuyExecutionFixture({
      getQuote: async () => createQuoteDouble('BULL.HK', '2.5', 100),
    });
    const signal = createSignal({
      symbol: 'BULL.HK',
      action: 'BUYCALL',
      triggerTimeMs: EXECUTION_NOW_MS,
      reason: 'P0 must not reach broker payload',
    });

    const result = await fixture.executor.executeSignals([signal], fixture.callerAuthorization);

    expect(result.executedOrderIds).toHaveLength(1);
    expect(fixture.events).toEqual(['permit', 'quote', 'invoke']);
    expect(fixture.quoteReadCount()).toBe(1);
    expect(readSubmittedPrice(fixture.native.nativeSubmitObservations()[0])).toBe('2.5');
    expect(readSubmittedQuantity(fixture.native.nativeSubmitObservations()[0])).toBe(2_000);
    expect(fixture.trackedOrders).toHaveLength(1);
    expect(fixture.trackedOrders[0]?.side).toBe('BUY');
    expect(fixture.trackedOrders[0]?.price).toBe('2.5');
    expect(fixture.trackedOrders[0]?.quantity).toBe(2_000);
  });

  it('rejects a buy when the permit-time REST quote exposes an exceeded unrealized loss', async () => {
    let unrealizedLossGateCalls = 0;
    const fixture = await createBuyExecutionFixture({
      getQuote: async () => createQuoteDouble('BULL.HK', '2.5', 100),
      unrealizedLossBuyGate: {
        checkUnrealizedLoss: (symbol, price, isLongSymbol) => {
          unrealizedLossGateCalls += 1;
          expect(symbol).toBe('BULL.HK');
          expect(price).toBe('2.5');
          expect(isLongSymbol).toBeTrue();
          return {
            shouldLiquidate: true,
            reason: 'P1 price crosses the existing unrealized-loss protection threshold',
            quantity: 100,
          };
        },
      },
    });
    const signal = createSignal({
      symbol: 'BULL.HK',
      action: 'BUYCALL',
      triggerTimeMs: EXECUTION_NOW_MS,
      reason: 'the signal snapshot must not bypass the P1 loss gate',
    });

    const result = await fixture.executor.executeSignals([signal], fixture.callerAuthorization);

    expect(result).toEqual({ executedOrderIds: [], quoteFailures: [] });
    expect(unrealizedLossGateCalls).toBe(1);
    expect(fixture.events).toEqual(['permit', 'quote']);
    expect(fixture.native.nativeSubmitObservations()).toHaveLength(0);
    expect(fixture.trackedOrders).toEqual([]);
    expect(fixture.executor.canTradeNow('BUYCALL')).toEqual({ canTrade: true });
  });

  it('passes false to the loss gate for a short-direction buy', async () => {
    const symbolRegistry = createSymbolRegistryDouble({
      longSeat: {
        symbol: null,
        status: 'EMPTY',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      shortSeat: {
        symbol: 'BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: 1,
        lastSearchAt: 1,
        lastSeatActivatedAt: 1,
        callPrice: '20000',
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
    });
    let lossGateDirection: boolean | null = null;
    const fixture = await createBuyExecutionFixture({
      getQuote: async () => createQuoteDouble('BULL.HK', '2.5', 100),
      symbolRegistry,
      unrealizedLossBuyGate: {
        checkUnrealizedLoss: (_symbol, _price, isLongSymbol) => {
          lossGateDirection = isLongSymbol;
          return { shouldLiquidate: false };
        },
      },
    });
    const signal = createSignal({
      symbol: 'BULL.HK',
      action: 'BUYPUT',
      triggerTimeMs: EXECUTION_NOW_MS,
      reason: 'short-direction final loss gate',
    });

    const result = await fixture.executor.executeSignals([signal], fixture.callerAuthorization);

    expect(result.executedOrderIds).toHaveLength(1);
    expect(lossGateDirection).toBeFalse();
  });

  it('allows a buy exactly at the configured unrealized-loss threshold', async () => {
    const unrealizedLossChecker = createUnrealizedLossChecker({
      maxUnrealizedLossPerSymbol: '100',
      onMissingData: () => {},
    });
    const prepared = unrealizedLossChecker.prepare(
      createOrderRecorderDouble({
        getCostBasis: () => ({ costAmount: '1000', quantity: 100 }),
        getBuyOrdersForSymbol: () => [
          {
            orderId: 'BULL-OPEN-1',
            symbol: 'BULL.HK',
            costAmount: '1000',
            executedQuantity: 100,
            executedTime: Date.now(),
            submittedAt: new Date(),
            updatedAt: new Date(),
          },
        ],
      }),
      'BULL.HK',
      true,
      '0',
    );
    unrealizedLossChecker.publish(prepared);
    let unrealizedLossGateCalls = 0;
    const fixture = await createBuyExecutionFixture({
      getQuote: async () => createQuoteDouble('BULL.HK', '9', 100),
      unrealizedLossBuyGate: {
        checkUnrealizedLoss: (symbol, price, isLongSymbol) => {
          unrealizedLossGateCalls += 1;
          return unrealizedLossChecker.check(symbol, price, isLongSymbol);
        },
      },
    });
    const signal = createSignal({
      symbol: 'BULL.HK',
      action: 'BUYCALL',
      triggerTimeMs: EXECUTION_NOW_MS,
      reason: 'loss exactly at threshold remains a valid buy',
    });

    const result = await fixture.executor.executeSignals([signal], fixture.callerAuthorization);

    expect(result.executedOrderIds).toHaveLength(1);
    expect(unrealizedLossGateCalls).toBe(1);
    expect(fixture.events).toEqual(['permit', 'quote', 'invoke']);
    expect(fixture.native.nativeSubmitObservations()).toHaveLength(1);
  });

  it('does not invoke the loss gate when the permit-time quote is invalid', async () => {
    let unrealizedLossGateCalls = 0;
    const fixture = await createBuyExecutionFixture({
      getQuote: async () => createQuoteDouble('BULL.HK', '0', 100),
      unrealizedLossBuyGate: {
        checkUnrealizedLoss: () => {
          unrealizedLossGateCalls += 1;
          return { shouldLiquidate: false };
        },
      },
    });
    const signal = createSignal({
      symbol: 'BULL.HK',
      action: 'BUYCALL',
      triggerTimeMs: EXECUTION_NOW_MS,
      reason: 'invalid final quote cannot be treated as a loss-gate input',
    });

    const result = await fixture.executor.executeSignals([signal], fixture.callerAuthorization);

    expect(result).toEqual({
      executedOrderIds: [],
      quoteFailures: [{ signal, kind: 'QUOTE_INVALID' }],
    });
    expect(result.quoteFailures[0]?.signal).toBe(signal);
    expect(unrealizedLossGateCalls).toBe(0);
    expect(fixture.events).toEqual(['permit', 'quote']);
    expect(fixture.native.nativeSubmitObservations()).toHaveLength(0);
  });

  it.each([
    {
      label: 'invalid final price',
      finalQuote: createQuoteDouble('BULL.HK', '0', 100),
      latestBuyCost: null,
    },
    {
      label: 'latest buy price collision',
      finalQuote: createQuoteDouble('BULL.HK', '1', 100),
      latestBuyCost: { costAmount: '100', quantity: 100 },
    },
  ])('skips buy without SDK or buy attempt when P1 has $label', async (scenario) => {
    const fixture = await createBuyExecutionFixture({
      getQuote: async () => scenario.finalQuote,
      latestBuyCost: scenario.latestBuyCost,
    });
    const signal = createSignal({
      symbol: 'BULL.HK',
      action: 'BUYCALL',
      triggerTimeMs: EXECUTION_NOW_MS,
      reason: `P1 ${scenario.label}`,
    });

    const result = await fixture.executor.executeSignals([signal], fixture.callerAuthorization);

    expect(result.executedOrderIds).toEqual([]);
    expect(fixture.events).toEqual(['permit', 'quote']);
    expect(fixture.native.nativeSubmitObservations()).toHaveLength(0);
    expect(fixture.trackedOrders).toEqual([]);
    expect(fixture.executor.canTradeNow('BUYCALL')).toEqual({ canTrade: true });
  });

  it('does not mutate when the execution gate closes while final quote awaits', async () => {
    let executionAllowed = true;
    let unrealizedLossGateCalls = 0;
    let resolveQuote: ((quote: ReturnType<typeof createQuoteDouble>) => void) | undefined;
    const finalQuote = new Promise<ReturnType<typeof createQuoteDouble>>((resolve) => {
      resolveQuote = resolve;
    });
    const fixture = await createBuyExecutionFixture({
      getQuote: async () => finalQuote,
      isExecutionAllowed: () => executionAllowed,
      unrealizedLossBuyGate: {
        checkUnrealizedLoss: () => {
          unrealizedLossGateCalls += 1;
          return { shouldLiquidate: false };
        },
      },
    });
    const signal = createSignal({
      symbol: 'BULL.HK',
      action: 'BUYCALL',
      triggerTimeMs: EXECUTION_NOW_MS,
      reason: 'gate may close while P1 awaits',
    });

    const execution = fixture.executor.executeSignals([signal], fixture.callerAuthorization);
    for (let index = 0; index < 4; index += 1) {
      await Promise.resolve();
    }

    expect(fixture.quoteReadCount()).toBe(1);
    executionAllowed = false;
    if (resolveQuote === undefined) {
      throw new Error('final quote resolver is unavailable');
    }

    resolveQuote(createQuoteDouble('BULL.HK', '2.5', 100));
    const result = await execution;

    expect(result).toEqual({ executedOrderIds: [], quoteFailures: [] });
    expect(fixture.events).toEqual(['permit', 'quote']);
    expect(unrealizedLossGateCalls).toBe(0);
    expect(fixture.native.nativeSubmitObservations()).toHaveLength(0);
    expect(fixture.trackedOrders).toEqual([]);
  });

  it('rejects a stale seat after P1 before invoking the unrealized-loss gate', async () => {
    const symbolRegistry = createSymbolRegistryDouble({
      longSeat: {
        symbol: 'BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: 1,
        lastSearchAt: 1,
        lastSeatActivatedAt: 1,
        callPrice: '20000',
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      longVersion: 1,
    });
    let unrealizedLossGateCalls = 0;
    let resolveQuote: ((quote: ReturnType<typeof createQuoteDouble>) => void) | undefined;
    const finalQuote = new Promise<ReturnType<typeof createQuoteDouble>>((resolve) => {
      resolveQuote = resolve;
    });
    const fixture = await createBuyExecutionFixture({
      getQuote: async () => finalQuote,
      symbolRegistry,
      unrealizedLossBuyGate: {
        checkUnrealizedLoss: () => {
          unrealizedLossGateCalls += 1;
          return { shouldLiquidate: false };
        },
      },
    });
    const signal = createSignal({
      symbol: 'BULL.HK',
      action: 'BUYCALL',
      triggerTimeMs: EXECUTION_NOW_MS,
      reason: 'seat version can change while P1 is pending',
    });

    const execution = fixture.executor.executeSignals([signal], fixture.callerAuthorization);
    for (let index = 0; index < 4; index += 1) {
      await Promise.resolve();
    }

    expect(fixture.quoteReadCount()).toBe(1);
    symbolRegistry.updateSeatStateWithVersionBump('LONG', {
      symbol: 'BULL.HK',
      status: 'ACTIVE',
      lastSwitchAt: 1,
      lastSearchAt: 1,
      lastSeatActivatedAt: 1,
      callPrice: '20000',
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    });

    if (resolveQuote === undefined) {
      throw new Error('final quote resolver is unavailable');
    }

    resolveQuote(createQuoteDouble('BULL.HK', '2.5', 100));
    const result = await execution;

    expect(result).toEqual({ executedOrderIds: [], quoteFailures: [] });
    expect(fixture.events).toEqual(['permit', 'quote']);
    expect(unrealizedLossGateCalls).toBe(0);
    expect(fixture.native.nativeSubmitObservations()).toHaveLength(0);
    expect(fixture.trackedOrders).toEqual([]);
  });

  it('uses P1 read after the permit for an ordinary sell submit payload and tracking price', async () => {
    const fixture = await createSellExecutionFixture({
      getQuote: async () => createQuoteDouble('BULL.HK', '1.6', 100),
    });
    const signal = {
      ...createSignal({
        symbol: 'BULL.HK',
        action: 'SELLCALL',
        triggerTimeMs: EXECUTION_NOW_MS,
        reason: 'sell P0 must not reach broker payload',
      }),
      quantity: 200,
    };

    const result = await fixture.executor.executeSignals([signal], fixture.callerAuthorization);

    expect(result.executedOrderIds).toHaveLength(1);
    expect(fixture.events.slice(-3)).toEqual(['permit', 'quote', 'invoke']);
    expect(fixture.quoteReadCount()).toBe(1);
    expect(
      Object.is(readSubmittedPrice(fixture.native.nativeSubmitObservations()[0]), '1.6'),
    ).toBeTrue();
    expect(readSubmittedQuantity(fixture.native.nativeSubmitObservations()[0])).toBe(200);
    expect(Object.is(fixture.trackedOrders[0]?.price, '1.6')).toBeTrue();
  });

  it('never invokes the unrealized-loss buy gate for an ordinary sell', async () => {
    let unrealizedLossGateCalls = 0;
    const fixture = await createSellExecutionFixture({
      getQuote: async () => createQuoteDouble('BULL.HK', '1.6', 100),
      unrealizedLossBuyGate: {
        checkUnrealizedLoss: () => {
          unrealizedLossGateCalls += 1;
          return { shouldLiquidate: true };
        },
      },
    });
    const signal = {
      ...createSignal({
        symbol: 'BULL.HK',
        action: 'SELLCALL',
        triggerTimeMs: EXECUTION_NOW_MS,
        reason: 'a sell must not consume the buy-only loss gate',
      }),
      quantity: 200,
    };

    const result = await fixture.executor.executeSignals([signal], fixture.callerAuthorization);

    expect(result.executedOrderIds).toHaveLength(1);
    expect(unrealizedLossGateCalls).toBe(0);
    expect(fixture.native.nativeSubmitObservations()).toHaveLength(1);
  });

  it('never invokes the unrealized-loss buy gate for a protective liquidation sell', async () => {
    let unrealizedLossGateCalls = 0;
    const fixture = await createSellExecutionFixture({
      getQuote: async () => createQuoteDouble('BULL.HK', '1.6', 100),
      unrealizedLossBuyGate: {
        checkUnrealizedLoss: () => {
          unrealizedLossGateCalls += 1;
          return { shouldLiquidate: true };
        },
      },
    });
    const signal = {
      ...createSignal({
        symbol: 'BULL.HK',
        action: 'SELLCALL',
        triggerTimeMs: EXECUTION_NOW_MS,
        reason: 'protective liquidation must bypass the buy gate',
      }),
      quantity: 200,
      isProtectiveLiquidation: true as const,
    };

    const result = await fixture.executor.executeSignals([signal], fixture.callerAuthorization);

    expect(result.executedOrderIds).toHaveLength(1);
    expect(unrealizedLossGateCalls).toBe(0);
    expect(fixture.native.nativeSubmitObservations()).toHaveLength(1);
  });

  it('reads P1 only after CANCEL_AND_SUBMIT has a terminal cancel and fresh quantity', async () => {
    const cancelOrderIds: string[] = [];
    const fixture = await createSellExecutionFixture({
      getQuote: async () => createQuoteDouble('BULL.HK', '1.7', 100),
      pendingSellOrders: [
        {
          orderId: 'SELL-OLD-MO',
          symbol: 'BULL.HK',
          isProtectiveLiquidation: false,
          side: 'SELL',
          status: 'WORKING',
          orderType: 'MO',
          submittedPrice: null,
          submittedQuantity: 100,
          executedQuantity: 0,
          submittedAt: Date.now(),
        },
      ],
      observeNativeCancel: (orderId) => {
        cancelOrderIds.push(orderId);
      },
    });
    const signal = {
      ...createSignal({
        symbol: 'BULL.HK',
        action: 'SELLCALL',
        triggerTimeMs: EXECUTION_NOW_MS,
        reason: 'cancel then P1',
      }),
      quantity: 50,
    };

    const result = await fixture.executor.executeSignals([signal], fixture.callerAuthorization);

    expect(result.executedOrderIds).toHaveLength(1);
    expect(cancelOrderIds).toEqual(['SELL-OLD-MO']);
    expect(fixture.native.nativeReadCounts()).toEqual({ cancel: 1, detail: 1 });
    expect(fixture.native.nativeCancelOrderIds()).toEqual(['SELL-OLD-MO']);
    expect(fixture.getPendingSellOrders('BULL.HK')).toEqual([]);
    expect(fixture.settledOrders).toMatchObject([{ orderId: 'SELL-OLD-MO', status: 'CANCELED' }]);
    expect(fixture.events.slice(-3)).toEqual(['permit', 'quote', 'invoke']);
    expect(
      Object.is(readSubmittedPrice(fixture.native.nativeSubmitObservations()[0]), '1.7'),
    ).toBeTrue();
    expect(readSubmittedQuantity(fixture.native.nativeSubmitObservations()[0])).toBe(150);
    expect(Object.is(fixture.trackedOrders[0]?.price, '1.7')).toBeTrue();
    expect(fixture.trackedOrders[0]?.quantity).toBe(150);
  });

  it('keeps the old pending sell after cancel ACK without local settlement or a new submit', async () => {
    const fixture = await createSellExecutionFixture({
      cancelAcknowledges: true,
      getQuote: async () => createQuoteDouble('BULL.HK', '1.7', 100),
      pendingSellOrders: [
        {
          orderId: 'SELL-ACK-MO',
          symbol: 'BULL.HK',
          isProtectiveLiquidation: false,
          side: 'SELL',
          status: 'WORKING',
          orderType: 'MO',
          submittedPrice: null,
          submittedQuantity: 100,
          executedQuantity: 0,
          submittedAt: EXECUTION_NOW_MS,
        },
      ],
    });
    const signal = {
      ...createSignal({ symbol: 'BULL.HK', action: 'SELLCALL', triggerTimeMs: EXECUTION_NOW_MS }),
      quantity: 50,
    };

    expect(await fixture.executor.executeSignals([signal], fixture.callerAuthorization)).toEqual({
      executedOrderIds: [],
      quoteFailures: [],
    });
    expect(fixture.native.nativeReadCounts()).toEqual({ cancel: 1, detail: 0 });
    expect(fixture.native.nativeCancelOrderIds()).toEqual(['SELL-ACK-MO']);
    expect(fixture.getPendingSellOrders('BULL.HK')).toMatchObject([{ orderId: 'SELL-ACK-MO' }]);
    expect(fixture.settledOrders).toEqual([]);
    expect(fixture.native.nativeSubmitObservations()).toEqual([]);
    expect(fixture.quoteReadCount()).toBe(0);
    expect(fixture.trackedOrders).toEqual([]);
  });

  it('uses P1 inside a permit for merge REPLACE rather than the signal decision price', async () => {
    const replaceCalls: Array<{
      readonly orderId: string;
      readonly price: string;
      readonly quantity: number | null | undefined;
    }> = [];
    const fixture = await createSellExecutionFixture({
      getQuote: async () => createQuoteDouble('BULL.HK', '1.8', 100),
      pendingSellOrders: [
        {
          orderId: 'SELL-EXISTING-ELO',
          symbol: 'BULL.HK',
          isProtectiveLiquidation: false,
          side: 'SELL',
          status: 'WORKING',
          orderType: 'ELO',
          submittedPrice: '1',
          submittedQuantity: 100,
          executedQuantity: 0,
          submittedAt: Date.now(),
        },
      ],
      observeNativeReplace: (orderId, price, quantity) => {
        replaceCalls.push({ orderId, price, quantity });
      },
    });
    const signal = {
      ...createSignal({
        symbol: 'BULL.HK',
        action: 'SELLCALL',
        triggerTimeMs: EXECUTION_NOW_MS,
        reason: 'replace must use P1',
      }),
      quantity: 50,
    };

    const result = await fixture.executor.executeSignals([signal], fixture.callerAuthorization);

    expect(result.executedOrderIds).toEqual(['SELL-EXISTING-ELO']);
    expect(fixture.events.slice(-3)).toEqual(['permit', 'quote', 'invoke']);
    expect(fixture.quoteReadCount()).toBe(1);
    expect(replaceCalls).toEqual([
      {
        orderId: 'SELL-EXISTING-ELO',
        price: '1.8',
        quantity: 150,
      },
    ]);
    expect(fixture.native.nativeSubmitObservations()).toHaveLength(0);
    expect(fixture.getPendingSellOrders('BULL.HK')).toMatchObject([
      { orderId: 'SELL-EXISTING-ELO' },
    ]);
    expect(fixture.settledOrders).toEqual([]);
  });

  it('cancels old doomsday sells, reads fresh quantity, then submits and tracks with P1', async () => {
    const currentTime = new Date('2026-07-10T07:56:00.000Z');
    const cancelOrderIds: string[] = [];
    let unrealizedLossGateCalls = 0;
    const fixture = await createSellExecutionFixture({
      currentTime,
      getQuote: async () => createQuoteDouble('BULL.HK', '1.9', 100),
      unrealizedLossBuyGate: {
        checkUnrealizedLoss: () => {
          unrealizedLossGateCalls += 1;
          return { shouldLiquidate: true };
        },
      },
      pendingSellOrders: [
        {
          orderId: 'SELL-OLD-DOOMSDAY',
          symbol: 'BULL.HK',
          isProtectiveLiquidation: false,
          side: 'SELL',
          status: 'WORKING',
          orderType: 'ELO',
          submittedPrice: '1',
          submittedQuantity: 100,
          executedQuantity: 0,
          submittedAt: Date.now(),
        },
      ],
      observeNativeCancel: (orderId) => {
        cancelOrderIds.push(orderId);
      },
    });
    const clearanceCommand = {
      symbol: 'BULL.HK',
      symbolName: 'BULL.HK',
      action: 'SELLCALL' as const,
      triggerTime: currentTime,
      seatVersion: 1,
    };

    const result = await fixture.executor.executeDoomsdayClearanceSignals(
      [clearanceCommand],
      fixture.callerAuthorization,
    );

    expect(result.executedOrderIds).toHaveLength(1);
    expect(cancelOrderIds).toEqual(['SELL-OLD-DOOMSDAY']);
    expect(fixture.native.nativeReadCounts()).toEqual({ cancel: 1, detail: 1 });
    expect(fixture.native.nativeCancelOrderIds()).toEqual(['SELL-OLD-DOOMSDAY']);
    expect(fixture.getPendingSellOrders('BULL.HK')).toEqual([]);
    expect(fixture.settledOrders).toMatchObject([
      { orderId: 'SELL-OLD-DOOMSDAY', status: 'CANCELED' },
    ]);
    expect(fixture.events.slice(-3)).toEqual(['permit', 'quote', 'invoke']);
    expect(
      Object.is(readSubmittedPrice(fixture.native.nativeSubmitObservations()[0]), '1.9'),
    ).toBeTrue();
    expect(readSubmittedQuantity(fixture.native.nativeSubmitObservations()[0])).toBe(300);
    expect(Object.is(fixture.trackedOrders[0]?.price, '1.9')).toBeTrue();
    expect(fixture.trackedOrders[0]?.quantity).toBe(300);
    expect(unrealizedLossGateCalls).toBe(0);
  });

  it('skips ordinary and protective tasks without SDK or local writes when final quote is missing', async () => {
    const ordinaryFixture = await createBuyExecutionFixture({
      getQuote: async () => null,
    });
    const ordinaryResult = await ordinaryFixture.executor.executeSignals(
      [
        createSignal({
          symbol: 'BULL.HK',
          action: 'BUYCALL',
          triggerTimeMs: EXECUTION_NOW_MS,
          reason: 'ordinary final quote missing',
        }),
      ],
      ordinaryFixture.callerAuthorization,
    );

    expect(ordinaryResult.executedOrderIds).toEqual([]);
    expect(ordinaryFixture.events).toEqual(['permit', 'quote']);
    expect(ordinaryFixture.native.nativeSubmitObservations()).toHaveLength(0);
    expect(ordinaryFixture.trackedOrders).toEqual([]);

    const protectiveFixture = await createSellExecutionFixture({
      getQuote: async () => null,
    });
    const protectiveSignal = {
      ...createSignal({
        symbol: 'BULL.HK',
        action: 'SELLCALL',
        triggerTimeMs: EXECUTION_NOW_MS,
        reason: 'protective final quote missing',
      }),
      quantity: 200,
      isProtectiveLiquidation: true as const,
    };
    const protectiveResult = await protectiveFixture.executor.executeSignals(
      [protectiveSignal],
      protectiveFixture.callerAuthorization,
    );

    expect(protectiveResult.executedOrderIds).toEqual([]);
    expect(protectiveFixture.events.slice(-2)).toEqual(['permit', 'quote']);
    expect(protectiveFixture.native.nativeSubmitObservations()).toHaveLength(0);
    expect(protectiveFixture.trackedOrders).toEqual([]);
  });

  it.each([
    { branch: 'SUBMIT', pending: false, price: null, kind: 'QUOTE_MISSING' },
    { branch: 'SUBMIT', pending: false, price: '0', kind: 'QUOTE_INVALID' },
    { branch: 'REPLACE', pending: true, price: null, kind: 'QUOTE_MISSING' },
    { branch: 'REPLACE', pending: true, price: '0', kind: 'QUOTE_INVALID' },
  ] as const)(
    'reports $kind for $branch with the exact original input and no broker mutation',
    async ({ pending, price, kind }) => {
      const fixture = await createSellExecutionFixture({
        getQuote: async () => (price === null ? null : createQuoteDouble('BULL.HK', price, 100)),
        pendingSellOrders: pending
          ? [
              {
                orderId: 'SELL-QUOTE-OLD',
                symbol: 'BULL.HK',
                isProtectiveLiquidation: false,
                side: 'SELL',
                status: 'WORKING',
                orderType: 'ELO',
                submittedPrice: '1',
                submittedQuantity: 100,
                executedQuantity: 0,
                submittedAt: EXECUTION_NOW_MS,
              },
            ]
          : [],
      });
      const signal = {
        ...createSignal({ symbol: 'BULL.HK', action: 'SELLCALL', triggerTimeMs: EXECUTION_NOW_MS }),
        quantity: 50,
      };
      const result = await fixture.executor.executeSignals([signal], fixture.callerAuthorization);
      expect(result).toEqual({ executedOrderIds: [], quoteFailures: [{ signal, kind }] });
      expect(result.quoteFailures[0]?.signal).toBe(signal);
      expect(fixture.native.nativeMutations()).toEqual([]);
      expect(fixture.native.nativeCancelOrderIds()).toEqual([]);
      expect(fixture.trackedOrders).toEqual([]);
      expect(fixture.getPendingSellOrders('BULL.HK')).toHaveLength(pending ? 1 : 0);
    },
  );

  it('maps mixed accepted/missing/invalid commands sharing a symbol by input index, not cloned signals or symbol', async () => {
    let reads = 0;
    const fixture = await createSellExecutionFixture({
      getQuote: async () => {
        const price = ['1.7', null, '0'][reads++];
        if (price === undefined) throw new Error('unexpected extra quote read');

        return price === null ? null : createQuoteDouble('BULL.HK', price, 100);
      },
    });
    const signals: ReadonlyArray<ExecutableSignal> = [0, 1, 2].map((index) => ({
      ...createSignal({
        symbol: 'BULL.HK',
        action: 'SELLCALL',
        triggerTimeMs: EXECUTION_NOW_MS,
        reason: `input-${index}`,
      }),
      quantity: 50,
    }));
    const [firstSignal, secondSignal, thirdSignal] = signals;
    if (firstSignal === undefined || secondSignal === undefined || thirdSignal === undefined)
      throw new Error('expected three input signals');

    const result = await fixture.executor.executeSignals(signals, fixture.callerAuthorization);
    expect(result.executedOrderIds).toHaveLength(1);
    expect(result.quoteFailures).toEqual([
      { signal: secondSignal, kind: 'QUOTE_MISSING' },
      { signal: thirdSignal, kind: 'QUOTE_INVALID' },
    ]);
    expect(result.quoteFailures[0]?.signal).toBe(secondSignal);
    expect(result.quoteFailures[1]?.signal).toBe(thirdSignal);
    expect(result.quoteFailures.some((failure) => failure.signal === firstSignal)).toBe(false);
    expect(fixture.native.nativeSubmitObservations()).toHaveLength(1);
    expect(fixture.trackedOrders).toHaveLength(1);
  });

  it('returns doomsday final-quote unavailability to the window retry owner without submitting', async () => {
    const currentTime = new Date('2026-07-10T07:56:00.000Z');
    const fixture = await createSellExecutionFixture({
      currentTime,
      getQuote: async () => null,
    });
    const clearanceCommand = {
      symbol: 'BULL.HK',
      symbolName: 'BULL.HK',
      action: 'SELLCALL' as const,
      triggerTime: currentTime,
      seatVersion: 1,
    };

    const result = await fixture.executor.executeDoomsdayClearanceSignals(
      [clearanceCommand],
      fixture.callerAuthorization,
    );

    expect(result.executedOrderIds).toEqual([]);
    expect(result.unresolvedQuoteSymbols).toEqual(['BULL.HK']);
    expect(fixture.events.slice(-2)).toEqual(['permit', 'quote']);
    expect(fixture.native.nativeSubmitObservations()).toHaveLength(0);
    expect(fixture.trackedOrders).toEqual([]);
  });
});
