/**
 * buy-flow 集成测试
 *
 * 功能：
 * - 验证买入流程风险管道与下单执行的端到端场景与业务期望。
 */

import { afterEach, describe, expect, it, setSystemTime } from 'bun:test';
import { createTradingConfig } from '../../mock/factories/configFactory.js';
import { createSignal } from '../../mock/factories/signalFactory.js';
import { createTerminationRuntime } from '../../src/app/runtime/createTerminationRuntime.js';
import type { OrderExecutorDeps } from '../../src/application/orderExecution/types.js';
import type { OrderMonitor } from '../../src/application/orderTracking/types.js';
import { createOrdinaryBuyWorkflow } from '../../src/application/ordinaryBuy/index.js';
import { createBuyRiskChecks } from '../../src/application/ordinaryBuy/riskChecks.js';
import type { BuyRiskCheckContext } from '../../src/application/ordinaryBuy/types.js';
import { BUY_RISK_CHECK_COOLDOWN_MS } from '../../src/constants/index.js';
import { createBuyProcessor } from '../../src/runtime/asyncProgram/buyProcessor/index.js';
import { createBuyTaskQueue } from '../../src/runtime/asyncProgram/tradeTaskQueue/index.js';
import type { ExecutableSignal } from '../../src/types/signal.js';
import type { SignalCallerAuthorization } from '../../src/types/trader.js';
import { logger } from '../../src/utils/logger/index.js';
import {
  createLiquidationCooldownTrackerDouble,
  createMarketDataClientDouble,
  createMonitorContextDouble,
  createOrderMonitorDouble,
  createOrderRecorderDouble,
  createQuoteDouble,
  createRateLimiterDouble,
  createRiskCheckerDouble,
  createSymbolRegistryDouble,
  createTraderDouble,
} from '../helpers/testDoubles.js';
import { runProcessorFlow } from '../main/asyncProgram/utils.js';
import { createSnapshotFixture } from '../main/fixtures/accountPositionSnapshot.js';
import { createSettlementRuntimeFixture } from '../main/fixtures/settlementRuntime.js';
import { createBrokerIngressFixture } from './architectureRefactoringP1Native/trade/brokerIngressFixture.js';

const createMutationRateLimiter = createRateLimiterDouble;

type OrderMonitorTestOverrides = Omit<Partial<OrderMonitor>, 'replaceOrderPriceWithPermit'>;

type NativeBuyIngress = Awaited<ReturnType<typeof createBrokerIngressFixture>>;
type OrderExecutorTestDeps = Omit<
  OrderExecutorDeps,
  | 'tradeMutationPort'
  | 'readSellPositions'
  | 'isContinuousTradingAllowed'
  | 'orderMonitor'
  | 'unrealizedLossBuyGate'
> &
  Readonly<{ ingress: NativeBuyIngress; orderMonitor: OrderMonitorTestOverrides }> &
  Partial<Pick<OrderExecutorDeps, 'isContinuousTradingAllowed' | 'unrealizedLossBuyGate'>>;
const ownerCleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of ownerCleanups.splice(0)) await cleanup();
});
let nativeFixtureId = 0;

/** 原始金融文本只进入 approved native producer；账户和持仓仍由实际 adapter 读取。 */
async function createNativeBuyIngress(): Promise<NativeBuyIngress> {
  const id = `BUY-FIXTURE-${++nativeFixtureId}`;
  const ingress = await createBrokerIngressFixture({
    orderId: id,
    tradeId: id + '-trade',
    symbol: 'BULL.HK',
    stockName: 'BULL.HK',
    remark: '',
    side: 'BUY',
    status: 'New',
    quantity: '100',
    executedQuantity: '0',
    submittedPrice: '5',
    executedPrice: '0',
    submittedAtMs: Date.parse('2026-07-10T07:00:00.000Z'),
    executionTimeMs: null,
    updatedAtMs: Date.parse('2026-07-10T07:00:30.000Z'),
  });
  ingress.setAccountBalance({
    currency: 'HKD',
    totalCash: '100000',
    netAssets: '100000',
    availableCash: '100000',
  });
  ingress.setStockPositions([]);
  let submits = 0;
  ingress.setSubmitBehavior(async () => `${id}-ACK-${++submits}`);
  return ingress;
}

/** 原 paired H/S receipt 与原席位 frame 的授权闭包直达实际 native executor。 */
async function createOrderExecutor(deps: OrderExecutorTestDeps) {
  const {
    ingress,
    isContinuousTradingAllowed = () => true,
    unrealizedLossBuyGate = createRiskCheckerDouble(),
    orderMonitor,
    ...remainingDeps
  } = deps;
  const accountService = ingress.createAccountService({ rateLimiter: createRateLimiterDouble() });
  const snapshot = await createSnapshotFixture({
    readPort: accountService,
    account: await accountService.getAccountSnapshot(),
    positions: await accountService.getStockPositions(),
  });
  const frame = (['LONG', 'SHORT'] as const).map((direction) => ({
    direction,
    version: deps.symbolRegistry.getSeatVersion(direction),
    seat: deps.symbolRegistry.getSeatState(direction),
  }));
  const termination = createTerminationRuntime({
    closeTradingGate: () => {},
    closeProducerAdmission: () => {},
    stopProducers: [],
    onSecondaryError: () => {},
  });
  const monitorContext = createMonitorContextDouble({
    config: deps.tradingConfig.monitor,
    symbolRegistry: deps.symbolRegistry,
    orderRecorder: deps.orderRecorder,
  });
  const settlement = createSettlementRuntimeFixture({
    snapshot,
    monitorContext,
    termination,
    getTrader: () => createTraderDouble({ ...accountService }),
    onPositionsCommitted: async (token) => {
      if (!snapshot.isCurrent(token, { account: true, positions: true, paired: true }))
        throw new Error('Stale positions callback');
    },
    scheduler: {
      scheduleTimer: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimer: (handle) => {
        clearTimeout(handle);
      },
    },
  });
  settlement.start();
  expect(await settlement.completeRebuildBaseline()).toBeTrue();
  const receipt = await settlement.waitForFresh();
  const callerAuthorization: SignalCallerAuthorization = () =>
    !termination.isTerminated() &&
    settlement.isCurrent(receipt) &&
    snapshot.isCurrent(receipt.snapshotToken, { account: true, positions: true, paired: true }) &&
    frame.every(({ direction, version, seat }) => {
      const current = deps.symbolRegistry.getSeatState(direction);
      return (
        deps.symbolRegistry.getSeatVersion(direction) === version &&
        current.symbol === seat.symbol &&
        current.status === seat.status &&
        current.lastSeatActivatedAt === seat.lastSeatActivatedAt
      );
    });
  ownerCleanups.push(settlement.stopAndDrain);
  const executor = ingress.createExecutor({
    ...remainingDeps,
    isContinuousTradingAllowed,
    unrealizedLossBuyGate,
    orderMonitor: createOrderMonitorDouble(orderMonitor),
  });
  return { ...executor, callerAuthorization, accountService, snapshot, receipt };
}

/** 创建可供最终提交阶段读取的显式行情客户端。 */
function createExecutableQuoteClient() {
  return createMarketDataClientDouble({
    getQuotes: async (symbols) =>
      new Map([...symbols].map((symbol) => [symbol, createQuoteDouble(symbol, '5', 100)])),
  });
}

function withMockedNow<T>(
  nowMs: number,
  run: () => Promise<T>,
  useSystemTime: boolean = false,
): Promise<T> {
  if (useSystemTime) {
    setSystemTime(nowMs);
    return run().finally(() => {
      setSystemTime();
    });
  }

  const originalNow = Date.now;
  Date.now = () => nowMs;
  return run().finally(() => {
    Date.now = originalNow;
  });
}

function createRiskContext(params: {
  readonly trader: ReturnType<typeof createTraderDouble>;
  readonly riskChecker: ReturnType<typeof createRiskCheckerDouble>;
  readonly orderRecorder: ReturnType<typeof createOrderRecorderDouble>;
  readonly currentTime: Date;
}): BuyRiskCheckContext {
  const monitorConfig = createTradingConfig().monitor;

  return {
    trader: params.trader,
    riskChecker: params.riskChecker,
    orderRecorder: params.orderRecorder,
    longQuote: createQuoteDouble('BULL.HK', '5', 100),
    shortQuote: createQuoteDouble('BEAR.HK', '5', 100),
    monitorQuote: createQuoteDouble('HSI.HK', '20000'),

    longSymbol: 'BULL.HK',
    shortSymbol: 'BEAR.HK',
    longSymbolName: 'BULL.HK',
    shortSymbolName: 'BEAR.HK',
    currentTime: params.currentTime,
    isHalfDay: false,
    config: monitorConfig,
  };
}

describe('buy-flow integration', () => {
  it('runs FIFO -> ordinary BUY owner -> realtime risk reads -> final native execution with exact whole-lot notional', async () => {
    const baseConfig = createTradingConfig();
    const tradingConfig = createTradingConfig({
      monitor: { ...baseConfig.monitor, targetNotional: '0.3' },
    });
    const ingress = await createNativeBuyIngress();
    const registry = createSymbolRegistryDouble();
    const recorder = createOrderRecorderDouble();
    const now = () => new Date('2026-07-10T03:00:00Z');
    let quoteReads = 0;
    const market = createMarketDataClientDouble({
      getQuotes: async (symbols) => {
        quoteReads += 1;
        return new Map(
          [...symbols].map((symbol) => [
            symbol,
            createQuoteDouble(symbol, symbol === 'HSI.HK' ? '20000' : '0.1', 3),
          ]),
        );
      },
    });
    const executor = await createOrderExecutor({
      ingress,
      rateLimiter: createRateLimiterDouble(),
      marketDataClient: market,
      cacheManager: { clearCache: () => {} },
      orderMonitor: {},
      orderRecorder: recorder,
      tradingConfig,
      symbolRegistry: registry,
      isExecutionAllowed: () => true,
      now,
      readCurrentTradingDayInfo: () => ({
        dateKey: '2026-07-10',
        info: { isTradingDay: true, isHalfDay: false },
      }),
    });
    const queue = createBuyTaskQueue();
    const termination = createTerminationRuntime({
      closeTradingGate: () => {},
      closeProducerAdmission: queue.close,
      stopProducers: [],
      onSecondaryError: () => {},
    });
    const workflow = createOrdinaryBuyWorkflow({
      logger,
      config: tradingConfig.monitor,
      doomsdayProtection: tradingConfig.global.doomsdayProtection,
      symbolRegistry: registry,
      orderRecorder: recorder,
      riskChecker: createRiskCheckerDouble(),
      trader: {
        ...executor.accountService,
        canTradeNow: executor.canTradeNow,
        executeSignals: executor.executeSignals,
      },
      marketDataClient: market,
      liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
      snapshot: executor.snapshot,
      getIsHalfDay: () => false,
      now,
      getCanProcessTask: () => true,
      termination,
    });
    const processor = createBuyProcessor({
      taskQueue: queue,
      workflow,
      getCanProcessTask: () => true,
      termination,
    });
    await runProcessorFlow({
      processor,
      pushTask: () => {
        queue.push({
          type: 'STRATEGY_BUY',
          data: createSignal({
            symbol: 'BULL.HK',
            action: 'BUYCALL',
            triggerTimeMs: now().getTime(),
          }),
        });
      },
      waitCondition: () => ingress.nativeSubmitObservations().length === 1,
    });
    expect(termination.isTerminated()).toBeFalse();
    expect(quoteReads).toBe(2);
    expect(ingress.nativeSubmitObservations()[0]?.quantity).toBe('3');
    expect(ingress.nativeSubmitObservations()[0]?.price).toBe('0.1');
  });

  it.each([
    {
      label: '正常交易日',
      beforeCutoff: '2026-07-12T07:44:59.000Z',
      afterCutoff: '2026-07-12T07:45:01.000Z',
      isHalfDay: false,
    },
    {
      label: '半日交易日',
      beforeCutoff: '2026-07-12T03:44:59.000Z',
      afterCutoff: '2026-07-12T03:45:01.000Z',
      isHalfDay: true,
    },
  ])('$label 买入在 throttle 跨过末日截止后不得进入 broker API', async (scenario) => {
    const tradingConfig = createTradingConfig();
    const tradeCtx = await createNativeBuyIngress();
    let currentTime = new Date(scenario.beforeCutoff);
    const orderExecutor = await createOrderExecutor({
      ingress: tradeCtx,
      rateLimiter: createRateLimiterDouble({
        onMutationPermitAcquired: async () => {
          currentTime = new Date(scenario.afterCutoff);
        },
      }),
      marketDataClient: createExecutableQuoteClient(),
      cacheManager: {
        clearCache: () => {},
      },
      orderMonitor: {
        initialize: async () => {},
        trackOrder: () => {},
        cancelOrder: async () => ({
          kind: 'CANCEL_CONFIRMED',
          relatedBuyOrderIds: null,
        }),
        startRuntime: () => {},
        stopRuntimeAndDrain: async () => {},
        recoverOrderTrackingFromSnapshot: async () => {},
        getPendingSellOrders: () => [],
        clearTrackedOrders: () => {},
        onOrderStateChanged: () => () => {},
        hasPendingProtectiveLiquidationOrders: () => false,
      },
      orderRecorder: createOrderRecorderDouble(),
      tradingConfig,
      symbolRegistry: createSymbolRegistryDouble(),
      isExecutionAllowed: () => true,
      now: () => currentTime,
      readCurrentTradingDayInfo: () => ({
        dateKey: scenario.afterCutoff.slice(0, 10),
        info: { isTradingDay: true, isHalfDay: scenario.isHalfDay },
      }),
    });

    const result = await orderExecutor.executeSignals(
      [
        createSignal({
          symbol: 'BULL.HK',
          action: 'BUYCALL',
          triggerTimeMs: currentTime.getTime(),
          reason: 'cross-doomsday-buy-cutoff-during-throttle',
        }),
      ],
      orderExecutor.callerAuthorization,
    );

    expect(result).toEqual({ executedOrderIds: [], quoteFailures: [] });
    expect(tradeCtx.nativeMutations()).toHaveLength(0);
    expect(orderExecutor.canTradeNow('BUYCALL')).toEqual({ canTrade: true });
  });

  it.each([
    {
      label: '正常交易日 exact close',
      finalTime: '2026-07-12T08:00:00.000Z',
      isHalfDay: false,
    },
    {
      label: '正常交易日 after close',
      finalTime: '2026-07-12T10:00:00.000Z',
      isHalfDay: false,
    },
    {
      label: '半日交易日 exact close',
      finalTime: '2026-07-12T04:00:00.000Z',
      isHalfDay: true,
    },
    {
      label: '半日交易日 after close',
      finalTime: '2026-07-12T06:00:00.000Z',
      isHalfDay: true,
    },
  ])('$label 达到截止起点后当日持续拒绝买入', async (scenario) => {
    const tradingConfig = createTradingConfig();
    const tradeCtx = await createNativeBuyIngress();
    let currentTime = new Date('2026-07-12T03:30:00.000Z');
    const orderExecutor = await createOrderExecutor({
      ingress: tradeCtx,
      rateLimiter: createRateLimiterDouble({
        onMutationPermitAcquired: async () => {
          currentTime = new Date(scenario.finalTime);
        },
      }),
      marketDataClient: createExecutableQuoteClient(),
      cacheManager: { clearCache: () => {} },
      orderMonitor: {
        initialize: async () => {},
        trackOrder: () => {},
        cancelOrder: async () => ({
          kind: 'CANCEL_CONFIRMED',
          relatedBuyOrderIds: null,
        }),
        startRuntime: () => {},
        stopRuntimeAndDrain: async () => {},
        recoverOrderTrackingFromSnapshot: async () => {},
        getPendingSellOrders: () => [],
        clearTrackedOrders: () => {},
        onOrderStateChanged: () => () => {},
        hasPendingProtectiveLiquidationOrders: () => false,
      },
      orderRecorder: createOrderRecorderDouble(),
      tradingConfig,
      symbolRegistry: createSymbolRegistryDouble(),
      isExecutionAllowed: () => true,
      now: () => currentTime,
      readCurrentTradingDayInfo: () => ({
        dateKey: '2026-07-12',
        info: { isTradingDay: true, isHalfDay: scenario.isHalfDay },
      }),
    });

    const result = await orderExecutor.executeSignals(
      [
        createSignal({
          symbol: 'BULL.HK',
          action: 'BUYCALL',
          triggerTimeMs: currentTime.getTime(),
          reason: 'same-day-after-doomsday-cutoff',
        }),
      ],
      orderExecutor.callerAuthorization,
    );

    expect(result).toEqual({ executedOrderIds: [], quoteFailures: [] });
    expect(tradeCtx.nativeMutations()).toHaveLength(0);
    expect(orderExecutor.canTradeNow('BUYCALL')).toEqual({ canTrade: true });
  });

  it.each([
    {
      label: '交易日历缺失',
      readCurrentTradingDayInfo: () => null,
    },
    {
      label: '交易日历日期不匹配',
      readCurrentTradingDayInfo: () => ({
        dateKey: '2026-07-11',
        info: { isTradingDay: true, isHalfDay: false },
      }),
    },
    {
      label: '当日不是交易日',
      readCurrentTradingDayInfo: () => ({
        dateKey: '2026-07-12',
        info: { isTradingDay: false, isHalfDay: false },
      }),
    },
  ])('$label 时末日保护买入最终授权 fail-closed', async (scenario) => {
    const tradingConfig = createTradingConfig();
    const tradeCtx = await createNativeBuyIngress();
    const currentTime = new Date('2026-07-12T06:30:00.000Z');
    const orderExecutor = await createOrderExecutor({
      ingress: tradeCtx,
      rateLimiter: createMutationRateLimiter(),
      marketDataClient: createExecutableQuoteClient(),
      cacheManager: { clearCache: () => {} },
      orderMonitor: {
        initialize: async () => {},
        trackOrder: () => {},
        cancelOrder: async () => ({
          kind: 'CANCEL_CONFIRMED',
          relatedBuyOrderIds: null,
        }),
        startRuntime: () => {},
        stopRuntimeAndDrain: async () => {},
        recoverOrderTrackingFromSnapshot: async () => {},
        getPendingSellOrders: () => [],
        clearTrackedOrders: () => {},
        onOrderStateChanged: () => () => {},
        hasPendingProtectiveLiquidationOrders: () => false,
      },
      orderRecorder: createOrderRecorderDouble(),
      tradingConfig,
      symbolRegistry: createSymbolRegistryDouble(),
      isExecutionAllowed: () => true,
      now: () => currentTime,
      readCurrentTradingDayInfo: scenario.readCurrentTradingDayInfo,
    });

    const result = await orderExecutor.executeSignals(
      [
        createSignal({
          symbol: 'BEAR.HK',
          action: 'BUYPUT',
          triggerTimeMs: currentTime.getTime(),
          reason: 'missing-authoritative-trading-day-info',
        }),
      ],
      orderExecutor.callerAuthorization,
    );

    expect(result.executedOrderIds).toHaveLength(0);
    expect(tradeCtx.nativeMutations()).toHaveLength(0);
    expect(orderExecutor.canTradeNow('BUYPUT')).toEqual({ canTrade: true });
  });

  it('普通买入的跨日门禁以注入时钟为准而非全局时间', async () => {
    const baseConfig = createTradingConfig();
    const tradingConfig = createTradingConfig({
      global: { ...baseConfig.global, doomsdayProtection: false },
    });
    const tradeCtx = await createNativeBuyIngress();
    const currentTimeMs = Date.parse('2026-07-12T02:00:00.000Z');
    const orderExecutor = await createOrderExecutor({
      ingress: tradeCtx,
      rateLimiter: createMutationRateLimiter(),
      marketDataClient: createExecutableQuoteClient(),
      cacheManager: { clearCache: () => {} },
      orderMonitor: {
        initialize: async () => {},
        trackOrder: () => {},
        cancelOrder: async () => ({
          kind: 'CANCEL_CONFIRMED',
          relatedBuyOrderIds: null,
        }),
        startRuntime: () => {},
        stopRuntimeAndDrain: async () => {},
        recoverOrderTrackingFromSnapshot: async () => {},
        getPendingSellOrders: () => [],
        clearTrackedOrders: () => {},
        onOrderStateChanged: () => () => {},
        hasPendingProtectiveLiquidationOrders: () => false,
      },
      orderRecorder: createOrderRecorderDouble(),
      tradingConfig,
      symbolRegistry: createSymbolRegistryDouble(),
      isExecutionAllowed: () => true,
      now: () => new Date(currentTimeMs),
      readCurrentTradingDayInfo: () => ({
        dateKey: '2026-07-12',
        info: { isTradingDay: true, isHalfDay: false },
      }),
    });

    const result = await withMockedNow(
      currentTimeMs - 86_400_000,
      async () =>
        orderExecutor.executeSignals(
          [
            createSignal({
              symbol: 'BULL.HK',
              action: 'BUYCALL',
              triggerTimeMs: currentTimeMs,
              reason: 'doomsday-protection-disabled',
            }),
          ],
          orderExecutor.callerAuthorization,
        ),
      true,
    );

    expect(result.executedOrderIds).toHaveLength(1);
    expect(tradeCtx.nativeMutations()).toHaveLength(1);
  });

  it('rejects broker success responses that do not contain a real orderId', async () => {
    const tradingConfig = createTradingConfig();
    const currentTime = new Date('2026-07-10T07:00:00.000Z');
    const trackedOrders: Array<{
      orderId: string;
      quantity: number;
      executionSide: 'BUY' | 'SELL';
    }> = [];
    let submitOrderCallCount = 0;
    const tradeCtx = await createNativeBuyIngress();
    tradeCtx.setSubmitBehavior(async () => {
      submitOrderCallCount += 1;
      return '';
    });
    const orderExecutor = await createOrderExecutor({
      ingress: tradeCtx,
      rateLimiter: createMutationRateLimiter(),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () => new Map([['BULL.HK', createQuoteDouble('BULL.HK', '5', 100)]]),
      }),
      cacheManager: {
        clearCache: () => {},
      },
      orderMonitor: {
        initialize: async () => {},
        trackOrder: ({ orderId, quantity, executionSide }) => {
          trackedOrders.push({ orderId, quantity, executionSide });
        },
        cancelOrder: async () => ({
          kind: 'CANCEL_CONFIRMED',
          relatedBuyOrderIds: null,
        }),
        startRuntime: () => {},
        stopRuntimeAndDrain: async () => {},
        recoverOrderTrackingFromSnapshot: async () => {},
        getPendingSellOrders: () => [],
        clearTrackedOrders: () => {},
        onOrderStateChanged: () => () => {},
        hasPendingProtectiveLiquidationOrders: () => false,
      },
      orderRecorder: createOrderRecorderDouble(),
      tradingConfig,
      symbolRegistry: createSymbolRegistryDouble(),
      isExecutionAllowed: () => true,
      isContinuousTradingAllowed: () => true,
      now: () => currentTime,
      readCurrentTradingDayInfo: () => ({
        dateKey: '2026-07-10',
        info: { isTradingDay: true, isHalfDay: false },
      }),
    });

    await withMockedNow(
      currentTime.getTime(),
      async () => {
        const signal = createSignal({
          symbol: 'BULL.HK',
          action: 'BUYCALL',
          triggerTimeMs: Date.now(),
          reason: 'missing-order-id-should-fail',
        });

        let missingOrderIdError: unknown = null;
        try {
          await orderExecutor.executeSignals([signal], orderExecutor.callerAuthorization);
        } catch (error) {
          missingOrderIdError = error;
        }

        expect(missingOrderIdError).toBeInstanceOf(Error);
        expect(submitOrderCallCount).toBe(1);
        expect(trackedOrders).toHaveLength(0);
      },
      true,
    );
  });

  it('surfaces local tracking failures after broker submit succeeds', async () => {
    const tradingConfig = createTradingConfig();
    const tradeCtx = await createNativeBuyIngress();
    const currentTime = new Date('2026-07-10T07:00:00.000Z');
    tradeCtx.setSubmitBehavior(async () => 'LOCAL-SYNC-ACCEPTED');
    const localTrackingFailure = new Error('track failed after submit');
    const orderExecutor = await createOrderExecutor({
      ingress: tradeCtx,
      rateLimiter: createMutationRateLimiter(),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () => new Map([['BULL.HK', createQuoteDouble('BULL.HK', '5', 100)]]),
      }),
      cacheManager: {
        clearCache: () => {},
      },
      orderMonitor: {
        initialize: async () => {},
        trackOrder: () => {
          throw localTrackingFailure;
        },
        cancelOrder: async () => ({
          kind: 'CANCEL_CONFIRMED',
          relatedBuyOrderIds: null,
        }),
        startRuntime: () => {},
        stopRuntimeAndDrain: async () => {},
        recoverOrderTrackingFromSnapshot: async () => {},
        getPendingSellOrders: () => [],
        clearTrackedOrders: () => {},
        onOrderStateChanged: () => () => {},
        hasPendingProtectiveLiquidationOrders: () => false,
      },
      orderRecorder: createOrderRecorderDouble(),
      tradingConfig,
      symbolRegistry: createSymbolRegistryDouble(),
      isExecutionAllowed: () => true,
      isContinuousTradingAllowed: () => true,
      now: () => currentTime,
      readCurrentTradingDayInfo: () => ({
        dateKey: '2026-07-10',
        info: { isTradingDay: true, isHalfDay: false },
      }),
    });

    await withMockedNow(
      currentTime.getTime(),
      async () => {
        const signal = createSignal({
          symbol: 'BULL.HK',
          action: 'BUYCALL',
          triggerTimeMs: Date.now(),
          reason: 'track-order-failure-should-surface',
        });

        let localSyncError: unknown = null;
        try {
          await orderExecutor.executeSignals([signal], orderExecutor.callerAuthorization);
        } catch (error) {
          localSyncError = error;
        }

        expect(localSyncError).toBeInstanceOf(Error);
        expect(localSyncError).toMatchObject({
          name: 'AcceptedOrderLocalSyncError',
          orderId: 'LOCAL-SYNC-ACCEPTED',
        });

        if (!(localSyncError instanceof Error)) {
          throw new Error('expected local sync failure to be an Error');
        }

        expect(localSyncError.cause).toBe(localTrackingFailure);
        expect(tradeCtx.nativeMutations()).toHaveLength(1);
      },
      true,
    );
  });

  it('skips stale seatVersion at final order execution gate', async () => {
    const tradingConfig = createTradingConfig();
    const tradeCtx = await createNativeBuyIngress();
    const currentTime = new Date('2026-07-10T02:00:00.000Z');
    let trackedOrderCount = 0;
    const orderExecutor = await createOrderExecutor({
      ingress: tradeCtx,
      rateLimiter: createMutationRateLimiter(),
      marketDataClient: createExecutableQuoteClient(),
      cacheManager: {
        clearCache: () => {},
      },
      orderMonitor: {
        initialize: async () => {},
        trackOrder: () => {
          trackedOrderCount += 1;
        },
        cancelOrder: async () => ({
          kind: 'CANCEL_CONFIRMED',
          relatedBuyOrderIds: null,
        }),
        startRuntime: () => {},
        stopRuntimeAndDrain: async () => {},
        recoverOrderTrackingFromSnapshot: async () => {},
        getPendingSellOrders: () => [],
        clearTrackedOrders: () => {},
        onOrderStateChanged: () => () => {},
        hasPendingProtectiveLiquidationOrders: () => false,
      },
      orderRecorder: createOrderRecorderDouble(),
      tradingConfig,
      symbolRegistry: createSymbolRegistryDouble({ longVersion: 2 }),
      isExecutionAllowed: () => true,
      now: () => currentTime,
      readCurrentTradingDayInfo: () => ({
        dateKey: '2026-07-10',
        info: { isTradingDay: true, isHalfDay: false },
      }),
    });

    const staleSignal = {
      ...createSignal({
        symbol: 'BULL.HK',
        action: 'BUYCALL',
        triggerTimeMs: currentTime.getTime(),
        reason: 'stale-seat-version',
      }),
      seatVersion: 1,
    };

    const result = await withMockedNow(
      currentTime.getTime(),
      () => orderExecutor.executeSignals([staleSignal], orderExecutor.callerAuthorization),
      true,
    );

    expect(result).toEqual({ executedOrderIds: [], quoteFailures: [] });
    expect(tradeCtx.nativeMutations()).toHaveLength(0);
    expect(trackedOrderCount).toBe(0);
  });

  it('skips submit when the same symbol seatVersion advances after mutation permit acquisition', async () => {
    const tradingConfig = createTradingConfig();
    const tradeCtx = await createNativeBuyIngress();
    const currentTime = new Date('2026-07-10T02:00:00.000Z');
    const symbolRegistry = createSymbolRegistryDouble();
    const staticSeat = symbolRegistry.getSeatState('LONG');
    symbolRegistry.updateSeatState('LONG', {
      ...staticSeat,
      lastSeatActivatedAt: currentTime.getTime(),
    });
    const initialSeatVersion = symbolRegistry.getSeatVersion('LONG');
    let mutationPermitAcquisitions = 0;
    const orderExecutor = await createOrderExecutor({
      ingress: tradeCtx,
      rateLimiter: createRateLimiterDouble({
        onMutationPermitAcquired: async () => {
          mutationPermitAcquisitions += 1;
          const currentSeat = symbolRegistry.getSeatState('LONG');
          if (currentSeat.status !== 'ACTIVE' || currentSeat.lastSeatActivatedAt === null) {
            throw new Error('expected runtime ACTIVE LONG seat');
          }

          symbolRegistry.updateSeatStateWithVersionBump('LONG', currentSeat);
        },
      }),
      marketDataClient: createExecutableQuoteClient(),
      cacheManager: {
        clearCache: () => {},
      },
      orderMonitor: {
        initialize: async () => {},
        trackOrder: () => {},
        cancelOrder: async () => ({
          kind: 'CANCEL_CONFIRMED',
          relatedBuyOrderIds: null,
        }),
        startRuntime: () => {},
        stopRuntimeAndDrain: async () => {},
        recoverOrderTrackingFromSnapshot: async () => {},
        getPendingSellOrders: () => [],
        clearTrackedOrders: () => {},
        onOrderStateChanged: () => () => {},
        hasPendingProtectiveLiquidationOrders: () => false,
      },
      orderRecorder: createOrderRecorderDouble(),
      tradingConfig,
      symbolRegistry,
      isExecutionAllowed: () => true,
      now: () => currentTime,
      readCurrentTradingDayInfo: () => ({
        dateKey: '2026-07-10',
        info: { isTradingDay: true, isHalfDay: false },
      }),
    });
    const signal = createSignal({
      symbol: 'BULL.HK',
      action: 'BUYCALL',
      triggerTimeMs: currentTime.getTime(),
      reason: 'seat-version-advanced-during-throttle',
    });

    const result = await withMockedNow(
      currentTime.getTime(),
      () => orderExecutor.executeSignals([signal], orderExecutor.callerAuthorization),
      true,
    );

    expect(mutationPermitAcquisitions).toBe(1);
    expect(symbolRegistry.getSeatVersion('LONG')).toBe(initialSeatVersion + 1);
    expect(result).toEqual({ executedOrderIds: [], quoteFailures: [] });
    expect(tradeCtx.nativeMutations()).toHaveLength(0);
  });

  it('fails fast when executable signal action does not match the resolved seat direction', async () => {
    const tradingConfig = createTradingConfig();
    const tradeCtx = await createNativeBuyIngress();
    const currentTime = new Date('2026-07-10T02:00:00.000Z');
    let trackedOrderCount = 0;
    const orderExecutor = await createOrderExecutor({
      ingress: tradeCtx,
      rateLimiter: createMutationRateLimiter(),
      marketDataClient: createExecutableQuoteClient(),
      cacheManager: {
        clearCache: () => {},
      },
      orderMonitor: {
        initialize: async () => {},
        trackOrder: () => {
          trackedOrderCount += 1;
        },
        cancelOrder: async () => ({
          kind: 'CANCEL_CONFIRMED',
          relatedBuyOrderIds: null,
        }),
        startRuntime: () => {},
        stopRuntimeAndDrain: async () => {},
        recoverOrderTrackingFromSnapshot: async () => {},
        getPendingSellOrders: () => [],
        clearTrackedOrders: () => {},
        onOrderStateChanged: () => () => {},
        hasPendingProtectiveLiquidationOrders: () => false,
      },
      orderRecorder: createOrderRecorderDouble(),
      tradingConfig,
      symbolRegistry: createSymbolRegistryDouble(),
      isExecutionAllowed: () => true,
      now: () => currentTime,
      readCurrentTradingDayInfo: () => ({
        dateKey: '2026-07-10',
        info: { isTradingDay: true, isHalfDay: false },
      }),
    });
    const mismatchedSignal: ExecutableSignal = createSignal({
      symbol: 'BULL.HK',
      action: 'BUYPUT',
      triggerTimeMs: currentTime.getTime(),
      reason: 'mismatched-seat-direction',
    });

    let directionMismatchError: unknown = null;
    try {
      await withMockedNow(
        currentTime.getTime(),
        () => orderExecutor.executeSignals([mismatchedSignal], orderExecutor.callerAuthorization),
        true,
      );
    } catch (error) {
      directionMismatchError = error;
    }

    expect(directionMismatchError).toBeInstanceOf(Error);
    if (!(directionMismatchError instanceof Error)) {
      throw new Error('expected seat direction mismatch error');
    }

    expect(directionMismatchError.message).toContain('信号动作与席位方向不一致');
    expect(tradeCtx.nativeMutations()).toHaveLength(0);
    expect(trackedOrderCount).toBe(0);
  });

  it('rejects missing seatVersion at final order execution gate', async () => {
    const tradingConfig = createTradingConfig();
    const tradeCtx = await createNativeBuyIngress();
    const currentTime = new Date('2026-07-10T02:00:00.000Z');
    let trackedOrderCount = 0;
    const orderExecutor = await createOrderExecutor({
      ingress: tradeCtx,
      rateLimiter: createMutationRateLimiter(),
      marketDataClient: createExecutableQuoteClient(),
      cacheManager: {
        clearCache: () => {},
      },
      orderMonitor: {
        initialize: async () => {},
        trackOrder: () => {
          trackedOrderCount += 1;
        },
        cancelOrder: async () => ({
          kind: 'CANCEL_CONFIRMED',
          relatedBuyOrderIds: null,
        }),
        startRuntime: () => {},
        stopRuntimeAndDrain: async () => {},
        recoverOrderTrackingFromSnapshot: async () => {},
        getPendingSellOrders: () => [],
        clearTrackedOrders: () => {},
        onOrderStateChanged: () => () => {},
        hasPendingProtectiveLiquidationOrders: () => false,
      },
      orderRecorder: createOrderRecorderDouble(),
      tradingConfig,
      symbolRegistry: createSymbolRegistryDouble({ longVersion: 1 }),
      isExecutionAllowed: () => true,
      now: () => currentTime,
      readCurrentTradingDayInfo: () => ({
        dateKey: '2026-07-10',
        info: { isTradingDay: true, isHalfDay: false },
      }),
    });
    const { seatVersion: omittedSeatVersion, ...missingSeatVersionSignal } = createSignal({
      symbol: 'BULL.HK',
      action: 'BUYCALL',
      triggerTimeMs: currentTime.getTime(),
      reason: 'missing-seat-version',
    });
    void omittedSeatVersion;

    const invalidSignals = [missingSeatVersionSignal] as unknown as ReadonlyArray<ExecutableSignal>;
    const result = await withMockedNow(
      currentTime.getTime(),
      () => orderExecutor.executeSignals(invalidSignals, orderExecutor.callerAuthorization),
      true,
    );

    expect(result).toEqual({ executedOrderIds: [], quoteFailures: [] });
    expect(tradeCtx.nativeMutations()).toHaveLength(0);
    expect(trackedOrderCount).toBe(0);
  });

  it('runs risk pipeline -> order execution and submits notional-based buy quantity', async () => {
    const tradingConfig = createTradingConfig();
    const currentTime = new Date('2026-07-10T07:00:00.000Z');
    const checkBuyRisk = createBuyRiskChecks({
      logger,
      lastRiskCheckTime: new Map(),
      doomsdayProtection: tradingConfig.global.doomsdayProtection,
      liquidationCooldownTracker: {
        getRemainingMs: () => 0,
      },
      reportFatalError: () => {},
    });

    const tradeCtx = await createNativeBuyIngress();
    const trackedOrders: Array<{
      orderId: string;
      quantity: number;
      executionSide: 'BUY' | 'SELL';
    }> = [];
    const orderExecutor = await createOrderExecutor({
      ingress: tradeCtx,
      rateLimiter: createMutationRateLimiter(),
      marketDataClient: createExecutableQuoteClient(),
      cacheManager: {
        clearCache: () => {},
      },
      orderMonitor: {
        initialize: async () => {},
        trackOrder: ({ orderId, quantity, executionSide }) => {
          trackedOrders.push({ orderId, quantity, executionSide });
        },
        cancelOrder: async () => ({
          kind: 'CANCEL_CONFIRMED',
          relatedBuyOrderIds: null,
        }),
        startRuntime: () => {},
        stopRuntimeAndDrain: async () => {},
        recoverOrderTrackingFromSnapshot: async () => {},
        getPendingSellOrders: () => [],
        clearTrackedOrders: () => {},
        onOrderStateChanged: () => () => {},
        hasPendingProtectiveLiquidationOrders: () => false,
      },
      orderRecorder: createOrderRecorderDouble(),
      tradingConfig,
      symbolRegistry: createSymbolRegistryDouble(),
      isExecutionAllowed: () => true,
      now: () => currentTime,
      readCurrentTradingDayInfo: () => ({
        dateKey: '2026-07-10',
        info: { isTradingDay: true, isHalfDay: false },
      }),
    });

    const trader = createTraderDouble({
      ...orderExecutor.accountService,
      canTradeNow: orderExecutor.canTradeNow,
    });
    const riskChecker = createRiskCheckerDouble();
    const orderRecorder = createOrderRecorderDouble();

    await withMockedNow(
      currentTime.getTime(),
      async () => {
        const signal = createSignal({
          symbol: 'BULL.HK',
          action: 'BUYCALL',
          triggerTimeMs: Date.now(),
          reason: 'integration-buy',
        });

        const checkedSignals = await checkBuyRisk(
          [signal],
          createRiskContext({ trader, riskChecker, orderRecorder, currentTime }),
        );
        const result = await orderExecutor.executeSignals(
          checkedSignals,
          orderExecutor.callerAuthorization,
        );

        expect(result.executedOrderIds).toHaveLength(1);
        expect(trackedOrders).toHaveLength(1);
        expect(trackedOrders[0]?.executionSide).toBe('BUY');
        expect(trackedOrders[0]?.quantity).toBe(1000);

        const payload = tradeCtx.nativeSubmitObservations()[0];
        if (!payload) {
          throw new TypeError('expected submitted buy payload');
        }

        expect(payload.orderType).toBe('ELO');
        expect(payload.timeInForce).toBe('DAY');
        expect(payload.side).toBe('BUY');
        expect(payload.symbol).toBe('BULL.HK');
        expect(payload.quantity).toBe('1000');
      },
      true,
    );
  });

  it('uses explicit signal quantity when valid quantity is provided', async () => {
    const tradingConfig = createTradingConfig();
    const tradeCtx = await createNativeBuyIngress();
    const currentTime = new Date('2026-07-10T07:00:00.000Z');
    const trackedOrders: Array<{
      orderId: string;
      quantity: number;
      executionSide: 'BUY' | 'SELL';
    }> = [];
    const orderExecutor = await createOrderExecutor({
      ingress: tradeCtx,
      rateLimiter: createMutationRateLimiter(),
      marketDataClient: createExecutableQuoteClient(),
      cacheManager: {
        clearCache: () => {},
      },
      orderMonitor: {
        initialize: async () => {},
        trackOrder: ({ orderId, quantity, executionSide }) => {
          trackedOrders.push({ orderId, quantity, executionSide });
        },
        cancelOrder: async () => ({
          kind: 'CANCEL_CONFIRMED',
          relatedBuyOrderIds: null,
        }),
        startRuntime: () => {},
        stopRuntimeAndDrain: async () => {},
        recoverOrderTrackingFromSnapshot: async () => {},
        getPendingSellOrders: () => [],
        clearTrackedOrders: () => {},
        onOrderStateChanged: () => () => {},
        hasPendingProtectiveLiquidationOrders: () => false,
      },
      orderRecorder: createOrderRecorderDouble(),
      tradingConfig,
      symbolRegistry: createSymbolRegistryDouble(),
      isExecutionAllowed: () => true,
      now: () => currentTime,
      readCurrentTradingDayInfo: () => ({
        dateKey: '2026-07-10',
        info: { isTradingDay: true, isHalfDay: false },
      }),
    });

    await withMockedNow(
      currentTime.getTime(),
      async () => {
        let signal = createSignal({
          symbol: 'BULL.HK',
          action: 'BUYCALL',
          triggerTimeMs: Date.now(),
          reason: 'integration-buy-explicit-quantity',
        });
        signal = { ...signal, quantity: 200 };

        const result = await orderExecutor.executeSignals(
          [signal],
          orderExecutor.callerAuthorization,
        );

        expect(result.executedOrderIds).toHaveLength(1);
        expect(trackedOrders).toHaveLength(1);
        expect(trackedOrders[0]?.executionSide).toBe('BUY');
        expect(trackedOrders[0]?.quantity).toBe(200);

        const submitCall = tradeCtx.nativeMutations()[0];
        const payload = submitCall;
        if (!payload || typeof payload !== 'object' || !('quantity' in payload)) {
          throw new TypeError('expected submitted buy payload');
        }

        expect(payload.quantity).toBe('200');
      },
      true,
    );
  });

  it('rejects invalid explicit buy quantity without silently using targetNotional', async () => {
    const tradingConfig = createTradingConfig();
    const tradeCtx = await createNativeBuyIngress();
    const currentTime = new Date('2026-07-10T02:00:00.000Z');
    const trackedOrders: Array<{
      orderId: string;
      quantity: number;
      executionSide: 'BUY' | 'SELL';
    }> = [];
    const orderExecutor = await createOrderExecutor({
      ingress: tradeCtx,
      rateLimiter: createMutationRateLimiter(),
      marketDataClient: createExecutableQuoteClient(),
      cacheManager: {
        clearCache: () => {},
      },
      orderMonitor: {
        initialize: async () => {},
        trackOrder: ({ orderId, quantity, executionSide }) => {
          trackedOrders.push({ orderId, quantity, executionSide });
        },
        cancelOrder: async () => ({
          kind: 'CANCEL_CONFIRMED',
          relatedBuyOrderIds: null,
        }),
        startRuntime: () => {},
        stopRuntimeAndDrain: async () => {},
        recoverOrderTrackingFromSnapshot: async () => {},
        getPendingSellOrders: () => [],
        clearTrackedOrders: () => {},
        onOrderStateChanged: () => () => {},
        hasPendingProtectiveLiquidationOrders: () => false,
      },
      orderRecorder: createOrderRecorderDouble(),
      tradingConfig,
      symbolRegistry: createSymbolRegistryDouble(),
      isExecutionAllowed: () => true,
      now: () => currentTime,
      readCurrentTradingDayInfo: () => ({
        dateKey: '2026-07-10',
        info: { isTradingDay: true, isHalfDay: false },
      }),
    });

    let signal = createSignal({
      symbol: 'BULL.HK',
      action: 'BUYCALL',
      triggerTimeMs: currentTime.getTime(),
      reason: 'integration-buy-invalid-explicit-quantity',
    });
    signal = { ...signal, quantity: 250 };

    const result = await withMockedNow(
      currentTime.getTime(),
      () => orderExecutor.executeSignals([signal], orderExecutor.callerAuthorization),
      true,
    );

    expect(result.executedOrderIds).toHaveLength(0);
    expect(trackedOrders).toHaveLength(0);
    expect(tradeCtx.nativeMutations()).toHaveLength(0);
  });

  it('isolates successful buy throttling by direction', async () => {
    const fixedNow = 1_000_000;
    const authorizationTime = new Date('1970-01-01T02:00:00.000Z');
    const tradingConfig = createTradingConfig();
    const tradeCtx = await createNativeBuyIngress();
    const orderExecutor = await createOrderExecutor({
      ingress: tradeCtx,
      rateLimiter: createMutationRateLimiter(),
      marketDataClient: createExecutableQuoteClient(),
      cacheManager: {
        clearCache: () => {},
      },
      orderMonitor: {
        initialize: async () => {},
        trackOrder: () => {},
        cancelOrder: async () => ({
          kind: 'CANCEL_CONFIRMED',
          relatedBuyOrderIds: null,
        }),
        startRuntime: () => {},
        stopRuntimeAndDrain: async () => {},
        recoverOrderTrackingFromSnapshot: async () => {},
        getPendingSellOrders: () => [],
        clearTrackedOrders: () => {},
        onOrderStateChanged: () => () => {},
        hasPendingProtectiveLiquidationOrders: () => false,
      },
      orderRecorder: createOrderRecorderDouble(),
      tradingConfig,
      symbolRegistry: createSymbolRegistryDouble(),
      isExecutionAllowed: () => true,
      now: () => authorizationTime,
      readCurrentTradingDayInfo: () => ({
        dateKey: '1970-01-01',
        info: { isTradingDay: true, isHalfDay: false },
      }),
    });

    const firstSignal = createSignal({
      symbol: 'BULL.HK',
      action: 'BUYCALL',
      triggerTimeMs: authorizationTime.getTime(),
      reason: 'first-successful-buy',
    });

    await withMockedNow(fixedNow, async () => {
      const firstResult = await orderExecutor.executeSignals(
        [firstSignal],
        orderExecutor.callerAuthorization,
      );
      expect(firstResult.executedOrderIds).toHaveLength(1);
    });

    const { secondCallCheck, firstPutCheck } = await withMockedNow(fixedNow, async () => ({
      secondCallCheck: orderExecutor.canTradeNow('BUYCALL'),
      firstPutCheck: orderExecutor.canTradeNow('BUYPUT'),
    }));

    expect(secondCallCheck.canTrade).toBe(false);
    expect(secondCallCheck.waitSeconds).toBe(60);
    expect(firstPutCheck).toEqual({ canTrade: true });

    orderExecutor.resetBuyThrottle();
    const firstPutSignal = createSignal({
      symbol: 'BEAR.HK',
      action: 'BUYPUT',
      triggerTimeMs: authorizationTime.getTime(),
      reason: 'first-successful-put-buy',
    });

    await withMockedNow(fixedNow, async () => {
      const firstPutResult = await orderExecutor.executeSignals(
        [firstPutSignal],
        orderExecutor.callerAuthorization,
      );
      expect(firstPutResult.executedOrderIds).toHaveLength(1);
    });

    const { secondPutCheck, nextCallCheck } = await withMockedNow(fixedNow, async () => ({
      secondPutCheck: orderExecutor.canTradeNow('BUYPUT'),
      nextCallCheck: orderExecutor.canTradeNow('BUYCALL'),
    }));

    expect(secondPutCheck.canTrade).toBe(false);
    expect(secondPutCheck.waitSeconds).toBe(60);
    expect(nextCallCheck).toEqual({ canTrade: true });
  });

  it('still blocks the next same-direction buy when submit fails after frequency check passed', async () => {
    const fixedNow = 2_000_000;
    const authorizationTime = new Date('1970-01-01T02:00:00.000Z');
    const tradingConfig = createTradingConfig();
    const tradeCtx = await createNativeBuyIngress();
    const submitFailure = new Error('service unavailable');
    tradeCtx.setSubmitBehavior(async () => {
      throw submitFailure;
    });

    const orderExecutor = await createOrderExecutor({
      ingress: tradeCtx,
      rateLimiter: createMutationRateLimiter(),
      marketDataClient: createExecutableQuoteClient(),
      cacheManager: {
        clearCache: () => {},
      },
      orderMonitor: {
        initialize: async () => {},
        trackOrder: () => {},
        cancelOrder: async () => ({
          kind: 'CANCEL_CONFIRMED',
          relatedBuyOrderIds: null,
        }),
        startRuntime: () => {},
        stopRuntimeAndDrain: async () => {},
        recoverOrderTrackingFromSnapshot: async () => {},
        getPendingSellOrders: () => [],
        clearTrackedOrders: () => {},
        onOrderStateChanged: () => () => {},
        hasPendingProtectiveLiquidationOrders: () => false,
      },
      orderRecorder: createOrderRecorderDouble(),
      tradingConfig,
      symbolRegistry: createSymbolRegistryDouble(),
      isExecutionAllowed: () => true,
      now: () => authorizationTime,
      readCurrentTradingDayInfo: () => ({
        dateKey: '1970-01-01',
        info: { isTradingDay: true, isHalfDay: false },
      }),
    });

    const failedSignal = createSignal({
      symbol: 'BULL.HK',
      action: 'BUYCALL',
      triggerTimeMs: authorizationTime.getTime(),
      reason: 'failed-submit-buy',
    });

    await withMockedNow(fixedNow, async () => {
      let submitError: unknown = null;
      try {
        await orderExecutor.executeSignals([failedSignal], orderExecutor.callerAuthorization);
      } catch (error) {
        submitError = error;
      }

      expect(submitError).toBeInstanceOf(Error);
      expect(submitError).toMatchObject({
        name: 'TradeMutationUnknownError',
        operation: 'TradeContext.submitOrder',
        requestAttempted: true,
        code: null,
      });
      expect(submitError).toHaveProperty('cause', submitFailure);
      expect(tradeCtx.nativeMutations()).toHaveLength(1);
      expect(submitFailure.message).toBe('service unavailable');
    });

    const nextCheck = await withMockedNow(fixedNow, async () =>
      orderExecutor.canTradeNow('BUYCALL'),
    );

    expect(nextCheck.canTrade).toBe(false);
    expect(nextCheck.waitSeconds).toBe(60);
  });

  it('blocks the next buy in applyRiskChecks once the previous buy has passed frequency check, regardless of submit success', async () => {
    const tradingConfig = createTradingConfig();
    const checkBuyRisk = createBuyRiskChecks({
      logger,
      lastRiskCheckTime: new Map(),
      doomsdayProtection: tradingConfig.global.doomsdayProtection,
      liquidationCooldownTracker: {
        getRemainingMs: () => 0,
      },
      reportFatalError: () => {},
    });

    const successNow = 3_000_000;
    const successAuthorizationMs = Date.parse('1970-01-01T02:00:00.000Z');
    let successClockMs = successAuthorizationMs;
    const successTradeCtx = await createNativeBuyIngress();
    const successOrderExecutor = await createOrderExecutor({
      ingress: successTradeCtx,
      rateLimiter: createMutationRateLimiter(),
      marketDataClient: createExecutableQuoteClient(),
      cacheManager: {
        clearCache: () => {},
      },
      orderMonitor: {
        initialize: async () => {},
        trackOrder: () => {},
        cancelOrder: async () => ({
          kind: 'CANCEL_CONFIRMED',
          relatedBuyOrderIds: null,
        }),
        startRuntime: () => {},
        stopRuntimeAndDrain: async () => {},
        recoverOrderTrackingFromSnapshot: async () => {},
        getPendingSellOrders: () => [],
        clearTrackedOrders: () => {},
        onOrderStateChanged: () => () => {},
        hasPendingProtectiveLiquidationOrders: () => false,
      },
      orderRecorder: createOrderRecorderDouble(),
      tradingConfig,
      symbolRegistry: createSymbolRegistryDouble(),
      isExecutionAllowed: () => true,
      now: () => new Date(successClockMs),
      readCurrentTradingDayInfo: () => ({
        dateKey: '1970-01-01',
        info: { isTradingDay: true, isHalfDay: false },
      }),
    });

    const successTrader = createTraderDouble({
      ...successOrderExecutor.accountService,
      canTradeNow: successOrderExecutor.canTradeNow,
    });
    const successRiskChecker = createRiskCheckerDouble();
    const successOrderRecorder = createOrderRecorderDouble();

    const successfulSignal = createSignal({
      symbol: 'BULL.HK',
      action: 'BUYCALL',
      triggerTimeMs: successClockMs,
      reason: 'successful-buy-before-next-risk-check',
    });

    await withMockedNow(successNow, async () => {
      const checkedSignals = await checkBuyRisk(
        [successfulSignal],
        createRiskContext({
          trader: successTrader,
          riskChecker: successRiskChecker,
          orderRecorder: successOrderRecorder,
          currentTime: new Date(successClockMs),
        }),
      );
      expect(checkedSignals).toHaveLength(1);
      const executeResult = await successOrderExecutor.executeSignals(
        checkedSignals,
        successOrderExecutor.callerAuthorization,
      );
      expect(executeResult.executedOrderIds).toHaveLength(1);
    });

    const blockedSignal = createSignal({
      symbol: 'BULL.HK',
      action: 'BUYCALL',
      triggerTimeMs: successAuthorizationMs + BUY_RISK_CHECK_COOLDOWN_MS + 1,
      reason: 'should-be-frequency-blocked',
    });

    await withMockedNow(successNow + BUY_RISK_CHECK_COOLDOWN_MS + 1, async () => {
      successClockMs = successAuthorizationMs + BUY_RISK_CHECK_COOLDOWN_MS + 1;
      const blockedResult = await checkBuyRisk(
        [blockedSignal],
        createRiskContext({
          trader: successTrader,
          riskChecker: successRiskChecker,
          orderRecorder: successOrderRecorder,
          currentTime: new Date(successClockMs),
        }),
      );
      expect(blockedResult).toHaveLength(0);
      expect(blockedSignal.reason).toBe('should-be-frequency-blocked');
    });

    const failedNow = 4_000_000;
    const failedAuthorizationMs = Date.parse('1970-01-01T03:00:00.000Z');
    let failedClockMs = failedAuthorizationMs;
    const failedTradeCtx = await createNativeBuyIngress();
    const failedSubmitFailure = new Error('service unavailable');
    failedTradeCtx.setSubmitBehavior(async () => {
      throw failedSubmitFailure;
    });

    const failedOrderExecutor = await createOrderExecutor({
      ingress: failedTradeCtx,
      rateLimiter: createMutationRateLimiter(),
      marketDataClient: createExecutableQuoteClient(),
      cacheManager: {
        clearCache: () => {},
      },
      orderMonitor: {
        initialize: async () => {},
        trackOrder: () => {},
        cancelOrder: async () => ({
          kind: 'CANCEL_CONFIRMED',
          relatedBuyOrderIds: null,
        }),
        startRuntime: () => {},
        stopRuntimeAndDrain: async () => {},
        recoverOrderTrackingFromSnapshot: async () => {},
        getPendingSellOrders: () => [],
        clearTrackedOrders: () => {},
        onOrderStateChanged: () => () => {},
        hasPendingProtectiveLiquidationOrders: () => false,
      },
      orderRecorder: createOrderRecorderDouble(),
      tradingConfig,
      symbolRegistry: createSymbolRegistryDouble(),
      isExecutionAllowed: () => true,
      now: () => new Date(failedClockMs),
      readCurrentTradingDayInfo: () => ({
        dateKey: '1970-01-01',
        info: { isTradingDay: true, isHalfDay: false },
      }),
    });

    const failedTrader = createTraderDouble({
      ...failedOrderExecutor.accountService,
      canTradeNow: failedOrderExecutor.canTradeNow,
    });
    const failedRiskChecker = createRiskCheckerDouble();
    const failedOrderRecorder = createOrderRecorderDouble();

    const firstFailedSignal = createSignal({
      symbol: 'BULL.HK',
      action: 'BUYCALL',
      triggerTimeMs: failedClockMs,
      reason: 'failed-buy-before-next-risk-check',
    });

    await withMockedNow(failedNow, async () => {
      const checkedSignals = await checkBuyRisk(
        [firstFailedSignal],
        createRiskContext({
          trader: failedTrader,
          riskChecker: failedRiskChecker,
          orderRecorder: failedOrderRecorder,
          currentTime: new Date(failedClockMs),
        }),
      );
      expect(checkedSignals).toHaveLength(1);
      let submitError: unknown = null;
      try {
        await failedOrderExecutor.executeSignals(
          checkedSignals,
          failedOrderExecutor.callerAuthorization,
        );
      } catch (error) {
        submitError = error;
      }

      expect(submitError).toBeInstanceOf(Error);
      expect(submitError).toMatchObject({
        name: 'TradeMutationUnknownError',
        operation: 'TradeContext.submitOrder',
        requestAttempted: true,
        code: null,
      });
      expect(submitError).toHaveProperty('cause', failedSubmitFailure);
      expect(failedTradeCtx.nativeMutations()).toHaveLength(1);
      expect(failedSubmitFailure.message).toBe('service unavailable');
    });

    const secondAllowedSignal = createSignal({
      symbol: 'BULL.HK',
      action: 'BUYCALL',
      triggerTimeMs: failedAuthorizationMs + BUY_RISK_CHECK_COOLDOWN_MS + 1,
      reason: 'should-pass-frequency-check-after-failed-submit',
    });

    await withMockedNow(failedNow + BUY_RISK_CHECK_COOLDOWN_MS + 1, async () => {
      failedClockMs = failedAuthorizationMs + BUY_RISK_CHECK_COOLDOWN_MS + 1;
      const allowedResult = await checkBuyRisk(
        [secondAllowedSignal],
        createRiskContext({
          trader: failedTrader,
          riskChecker: failedRiskChecker,
          orderRecorder: failedOrderRecorder,
          currentTime: new Date(failedClockMs),
        }),
      );
      expect(allowedResult).toHaveLength(0);
      expect(secondAllowedSignal.reason).toBe('should-pass-frequency-check-after-failed-submit');
    });
  });
});
