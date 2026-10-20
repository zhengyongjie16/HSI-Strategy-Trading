import { createDiagnosticObserverDouble } from '../../../helpers/diagnostics.js';
import { scheduleBoundedOneShotAt } from '../../../../src/runtime/timer/index.js';
import { nowMonotonicMs, wait } from '../../../../src/infrastructure/time/index.js';
import { wrapExternalApiRequest } from '../../../../src/infrastructure/externalApi/index.js';

import {
  createLoggerDouble,
  createDailyLossTrackerDouble,
  createMarketDataClientDouble,
  createOrderRecorderDouble,
  createProtectiveLiquidationEpisodeTrackerDouble,
  createRateLimiterDouble,
  createRiskCheckerDouble,
  createSymbolRegistryDouble,
  createTerminationDouble,
} from '../../../helpers/testDoubles.js';

/** 新增 broker controller 控制的实际 native entry 证明；不替代 Main/Business 完整 actor body。 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createTradingConfig } from '../../../../mock/factories/configFactory.js';
import { createAccountPositionSnapshot } from '../../../../src/application/accountPositionSnapshot/index.js';
import { createOrderHoldRegistry } from '../../../../src/application/orderTracking/orderHoldRegistry.js';
import type { OrderMonitorRuntimeStore } from '../../../../src/application/orderTracking/orderMonitor/types.js';
import { createSettlementReadinessGate } from '../../../../src/application/postTradeSettlement/readinessGate.js';
import type { OrderFact } from '../../../../src/types/trade.js';
import { isExternalApiRequestError } from '../../../../src/utils/apiFailure/index.js';

import { createBrokerIngressFixture } from './brokerIngressFixture.js';

function originalFrame() {
  return {
    orderId: 'CONTROL-O',
    symbol: 'BULL.HK',
    stockName: 'BULL',
    remark: 'control',
    side: 'BUY' as const,
    status: 'Filled' as const,
    quantity: '100',
    executedQuantity: '100',
    submittedPrice: '1',
    executedPrice: '1',
    submittedAtMs: 1700000000000,
    updatedAtMs: 1700000000200,
  };
}

describe('additional private broker controls', () => {
  it('waits for an explicitly configured successful native cancel ACK and keeps revoked original work stale', async () => {
    const f = await createBrokerIngressFixture({
      ...originalFrame(),
      status: 'New',
      executedQuantity: '0',
      executedPrice: '0',
    });
    const runtime: OrderMonitorRuntimeStore = {
      trackedOrders: new Map(),
      trackedOrderLifecycles: new Map(),
      bootstrappingOrderEvents: new Map(),
      closedOrderIds: new Set(),
      queriedTerminalStateByOrderId: new Map(),
      latestReplaceTerminalByOrderId: new Map(),
      orderStateChangedListeners: new Set(),
      trackedOrderIdsBySymbol: new Map(),
      routeStatesBySymbol: new Map(),
      latestRouteGenerationBySymbol: new Map(),
      runtimeState: 'ACTIVE',
      running: true,
      unsubscribeQuoteUpdated: null,
    };
    const origin = { live: true };
    const operations = f.createOperations({
      diagnostics: createDiagnosticObserverDouble(),
      logger: createLoggerDouble(),
      wait: wait,
      runtime,
      rateLimiter: createRateLimiterDouble(),
      orderRecorder: createOrderRecorderDouble(),
      orderHoldRegistry: createOrderHoldRegistry(),
      monitorConfig: createTradingConfig().monitor,
      now: () => new Date(1700000000300),
      captureWorkGuard: () => () => origin.live,
      termination: createTerminationDouble(),
      cacheManager: { clearCache: () => {}, getPendingOrders: async () => [] },
      recordCumulativeExecution: () => {
        throw new Error('cancel ACK is not an execution fact');
      },
      triggerRoute: () => {},
    });
    operations.trackOrder({
      orderId: f.queryObservation.orderId,
      symbol: f.queryObservation.symbol,
      side: f.queryObservation.executionSide,
      executionSide: f.queryObservation.executionSide,
      price: '1',
      initialSubmittedPrice: '1',
      quantity: 100,
      submittedAtMs: 1700000000000,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: f.queryObservation.orderType,
    });
    const invoked = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    let replied = false;
    f.setCancelBeforeReply(async () => {
      invoked.resolve();
      await release.promise;
    });
    const pending = operations
      .cancelOrder(f.queryObservation.orderId, { kind: 'ORDER_FACT' })
      .then((result) => {
        replied = true;
        return result;
      });
    await invoked.promise;
    expect(f.nativeReadCounts().cancel).toBe(1);
    expect(f.nativeCancelOrderIds()).toEqual([f.queryObservation.orderId]);
    expect(replied).toBeFalse();
    origin.live = false;
    release.resolve();
    await pending;
    expect(replied).toBeTrue();
    expect(f.nativeReadCounts().detail).toBe(0);
    expect(f.nativeReadCounts().cancel).toBe(1);
    expect(f.nativeMutations()).toEqual([]);
    const successfulIds = f.nativeCancelOrderIds();
    origin.live = true;
    operations.trackOrder({
      orderId: 'CONTROL-ERROR-O',
      symbol: f.queryObservation.symbol,
      side: f.queryObservation.executionSide,
      executionSide: f.queryObservation.executionSide,
      price: '1',
      initialSubmittedPrice: '1',
      quantity: 100,
      submittedAtMs: 1700000000000,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: false,
      orderType: f.queryObservation.orderType,
    });
    const originalError = new TypeError('original native cancel failure');
    f.setCancelFailure(originalError);
    const failure = await operations
      .cancelOrder('CONTROL-ERROR-O', { kind: 'ORDER_FACT' })
      .catch((error: unknown) => error);
    expect(failure).toBe(originalError);
    expect(f.nativeCancelOrderIds()).toEqual([f.queryObservation.orderId, 'CONTROL-ERROR-O']);
    expect(successfulIds).toEqual([f.queryObservation.orderId]);
    expect(f.nativeReadCounts()).toEqual({ cancel: 2, detail: 0 });
    expect(f.nativeMutations()).toEqual([]);
  });

  it('composes actual Trader on one private native context and preserves constructor/retry/symbol observations', async () => {
    const fixture = await createBrokerIngressFixture(originalFrame());
    const deps: Parameters<typeof fixture.createTradeRuntime>[0] = {
      diagnostics: createDiagnosticObserverDouble(),
      logger: createLoggerDouble(),
      wait: wait,
      nowMonotonicMs: nowMonotonicMs,
      requestExternalApi: wrapExternalApiRequest,
      scheduleBoundedOneShotAt: scheduleBoundedOneShotAt,
      tradingConfig: createTradingConfig(),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () => {
          throw new Error('facade read must not request quotes');
        },
      }),
      unrealizedLossBuyGate: createRiskCheckerDouble(),
      symbolRegistry: createSymbolRegistryDouble(),
      dailyLossTracker: createDailyLossTrackerDouble(),
      protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
      persistProtectiveLiquidationExecutionProgress: () => {
        throw new Error('facade read must not persist protective progress');
      },
      postTradeConsistencyRuntime: {
        recordSettlementRefreshNeed: () => {
          throw new Error('facade read must not publish settlement');
        },
      },
      isExecutionAllowed: () => false,
      isContinuousTradingAllowed: () => false,
      now: () => new Date(1700000000300),
      scheduleTimer: setTimeout,
      clearTimer: clearTimeout,
      readCurrentTradingDayInfo: () => ({
        dateKey: '2023-11-15',
        info: { isTradingDay: true, isHalfDay: false },
      }),
      termination: createTerminationDouble(),
    };
    const tradeRuntime = await fixture.createTradeRuntime(deps);
    expect(fixture.contextCreationCount()).toBe(1);
    fixture.setAccountBalance({
      currency: 'HKD',
      totalCash: '10000',
      netAssets: '10100',
      availableCash: '10000',
    });

    fixture.setStockPositions([
      {
        symbol: '700.HK',
        symbolName: 'Tencent',
        accountChannel: 'offline',
        currency: 'HKD',
        quantity: '100',
        availableQuantity: '80',
        costPrice: '1.23',
      },
    ]);
    const accountSnapshot = await tradeRuntime.accountService.getAccountSnapshot();
    expect(accountSnapshot.totalCash).toBe('10000');
    const positions = await tradeRuntime.accountService.getStockPositions({ symbols: ['700.HK'] });
    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({
      symbol: '700.HK',
      quantity: 100,
      availableQuantity: 80,
      costPrice: '1.23',
    });
    expect(fixture.positionReadSymbols()).toEqual([['700.HK']]);
    const originalError = new Error('HTTP 503 Service Unavailable');
    fixture.setAccountBalanceFailure(originalError);
    const before = fixture.accountReadCounts().balance;
    const failed = await tradeRuntime.accountService
      .getAccountSnapshot({ retryConfig: { retries: 0, delayMs: 0 } })
      .catch((error: unknown) => error);
    expect(isExternalApiRequestError(failed)).toBeTrue();
    expect(failed).toHaveProperty('attempts', 1);
    expect(failed).toHaveProperty('cause', originalError);
    expect(fixture.accountReadCounts().balance).toBe(before + 1);
    fixture.setAccountBalanceFailure(null);
    const subscribeError = new TypeError('original native subscribe contract failure');
    fixture.setSubscribeBehavior(async () => {
      throw subscribeError;
    });
    expect(fixture.subscribeReadCount()).toBe(0);
    const subscribeFailure = await tradeRuntime.orderMonitor
      .initialize()
      .catch((error: unknown) => error);
    expect(subscribeFailure).toBe(subscribeError);
    expect(fixture.subscribeReadCount()).toBe(1);
    let failuresRemaining = 1;
    const issued = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    fixture.setSubscribeBehavior(async () => {
      if (failuresRemaining > 0) {
        failuresRemaining--;
        throw new Error('HTTP 503 Service Unavailable');
      }

      issued.resolve();
      await release.promise;
    });
    let subscriptionReplied = false;
    const initializing = tradeRuntime.orderMonitor.initialize().then(() => {
      subscriptionReplied = true;
    });
    await issued.promise;
    expect(fixture.subscribeReadCount()).toBe(3);
    expect(fixture.subscribeObservations()).toEqual([['PRIVATE'], ['PRIVATE'], ['PRIVATE']]);
    expect(subscriptionReplied).toBeFalse();
    release.resolve();
    await initializing;
    expect(subscriptionReplied).toBeTrue();
    await tradeRuntime.orderMonitor.initialize();
    expect(fixture.subscribeReadCount()).toBe(3);
    const constructorError = new Error('original context constructor failure');
    fixture.setContextCreationFailure(constructorError);
    expect(fixture.contextCreationCount()).toBe(1);
    const rejected = fixture.createTradeRuntime(deps);
    expect(rejected).toBeInstanceOf(Promise);
    expect(await rejected.catch((error: unknown) => error)).toBe(constructorError);
    expect(fixture.contextCreationCount()).toBe(2);
    fixture.setContextCreationFailure(null);
    expect(fixture.nativeMutations()).toEqual([]);
    await tradeRuntime.orderMonitor.stopRuntimeAndDrain();
    const unsubscribeIssued = Promise.withResolvers<undefined>();
    const unsubscribeRelease = Promise.withResolvers<undefined>();
    fixture.setUnsubscribeBehavior(async () => {
      unsubscribeIssued.resolve();
      await unsubscribeRelease.promise;
    });
    expect(fixture.subscriptionMembership()).toEqual(['PRIVATE']);
    const tearingDown = tradeRuntime.orderMonitor.teardown();
    await unsubscribeIssued.promise;
    expect(fixture.unsubscribeReadCount()).toBe(1);
    expect(fixture.subscriptionMembership()).toEqual(['PRIVATE']);
    unsubscribeRelease.resolve();
    await tearingDown;
    expect(fixture.subscriptionMembership()).toEqual([]);
    expect(fixture.unsubscribeObservations()).toEqual([['PRIVATE']]);
    const failedFixture = await createBrokerIngressFixture(originalFrame());
    const failedTrader = await failedFixture.createTradeRuntime({
      ...deps,
      dailyLossTracker: createDailyLossTrackerDouble(),
      protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
    });
    failedFixture.setSubscribeBehavior(async () => {});
    await failedTrader.orderMonitor.initialize();
    const originalUnsubscribeError = new TypeError('original native unsubscribe failure');
    failedFixture.setUnsubscribeBehavior(async () => {
      throw originalUnsubscribeError;
    });
    const unsubscribeFailure = await failedTrader.orderMonitor
      .teardown()
      .catch((error: unknown) => error);
    expect(unsubscribeFailure).toBe(originalUnsubscribeError);
    expect(failedFixture.unsubscribeReadCount()).toBe(1);
    expect(failedFixture.subscriptionMembership()).toEqual(['PRIVATE']);
    expect(failedFixture.unsubscribeObservations()).toEqual([['PRIVATE']]);
    await failedTrader.orderMonitor.stopRuntimeAndDrain();
  });

  it('maps the four exact unreported statuses and nullable native snapshot price without altering SDK push contracts', async () => {
    const fixture = await createBrokerIngressFixture(originalFrame());
    const base = {
      ...originalFrame(),
      executedQuantity: '0',
      executedPrice: '0',
      executionTimeMs: null,
    };
    fixture.setOrderSnapshotReplies(
      [],
      [
        { ...base, orderId: 'UNREPORTED-1', status: 'NotReported' },
        { ...base, orderId: 'UNREPORTED-2', status: 'ReplacedNotReported' },
        { ...base, orderId: 'UNREPORTED-3', status: 'ProtectedNotReported' },
        { ...base, orderId: 'UNREPORTED-4', status: 'VarietiesNotReported' },
        { ...base, orderId: 'MO-NULL', status: 'New', orderType: 'MO' },
        { ...base, orderId: 'ELO-NULL', status: 'New', orderType: 'ELO' },
      ],
    );
    fixture.setOrderSnapshotSubmittedPriceNull('MO-NULL');
    fixture.setOrderSnapshotSubmittedPriceNull('ELO-NULL');
    expect(fixture.orderSnapshotReadCounts()).toEqual({ history: 0, today: 0 });
    const orders = await fixture
      .createApiManager({ rateLimiter: createRateLimiterDouble() })
      .fetchAllOrdersFromAPI();
    expect(orders.map((order) => order.status)).toEqual([
      'UNREPORTED',
      'REPLACEMENT_UNREPORTED',
      'PROTECTION_UNREPORTED',
      'CONDITIONAL_UNREPORTED',
      'WORKING',
      'WORKING',
    ]);

    expect(orders[4]).toMatchObject({
      orderType: 'MO',
      price: null,
      executionSide: 'BUY',
      executionPhase: 'OPEN',
      executedQuantity: 0,
      executedAmount: '0',
      executionTimeMs: null,
    });
    expect(orders[5]).toMatchObject({ orderType: 'ELO', price: null });
    expect(fixture.orderSnapshotReadCounts()).toEqual({ history: 1, today: 1 });
    expect(fixture.nativeMutations()).toEqual([]);
  });

  it('reads frozen V1 SDK metadata privately and preserves each order own observation time proxy', async () => {
    const frozen: unknown = JSON.parse(
      readFileSync(
        new URL('../../architectureRefactoringRecovery/fixtures/recovery.json', import.meta.url),
        'utf8',
      ),
    );
    if (typeof frozen !== 'object' || frozen === null || !('orders' in frozen))
      throw new Error('missing frozen orders');

    const fixture = await createBrokerIngressFixture(originalFrame());
    fixture.setOrderSnapshotRepliesFromFrozenV1(frozen.orders);
    expect(fixture.orderSnapshotReadCounts()).toEqual({ history: 0, today: 0 });
    const orders = await fixture
      .createApiManager({ rateLimiter: createRateLimiterDouble() })
      .fetchAllOrdersFromAPI();
    expect(orders).toHaveLength(2);
    expect(orders[0]).toMatchObject({
      orderId: 'OFFLINE-BUY',
      executionSide: 'BUY',
      status: 'FILLED',
      orderType: 'ELO',
      executedQuantity: 5,
      executedAmount: '50',
      executionTimeMs: 1773367200000,
    });

    expect(orders[1]).toMatchObject({
      orderId: 'OFFLINE-SELL',
      executionSide: 'SELL',
      status: 'CANCELED',
      executedQuantity: 5,
      executedAmount: '45',
      // 订单级观察时间代理：正成交取该订单自己的 updatedAt。
      executionTimeMs: 1773369030000,
      updatedAtMs: 1773369030000,
    });
    expect(fixture.orderSnapshotReadCounts()).toEqual({ history: 1, today: 1 });
    expect(fixture.nativeMutations()).toEqual([]);
    fixture.setOrderSnapshotRepliesFromFrozenV1([
      {
        orderId: 'ILLEGAL-METADATA',
        symbol: 'BULL.HK',
        stockName: 'BULL',
        remark: '',
        side: 999,
        status: 5,
        orderType: 2,
        quantity: '5',
        price: '10',
        executedQuantity: '5',
        executedPrice: '10',
        submittedAt: '2026-03-13T02:00:00.000Z',
        updatedAt: '2026-03-13T02:00:00.000Z',
      },
    ]);
    expect(fixture.orderSnapshotReadCounts().today).toBe(1);
    const invalid = await fixture
      .createApiManager({ rateLimiter: createRateLimiterDouble() })
      .fetchAllOrdersFromAPI()
      .catch((error: unknown) => error);
    expect(invalid).toBeInstanceOf(TypeError);
    expect(invalid).toHaveProperty(
      'message',
      '[BrokerIngressFixture] frozen V1 invalid SDK metadata',
    );
    expect(fixture.orderSnapshotReadCounts().today).toBe(2);
  });

  it('counts DETAIL transport before its explicit response hook and retains raw revision representation at the mapper', async () => {
    const frame = originalFrame();
    const fixture = await createBrokerIngressFixture(frame);
    const originalError = new TypeError('original DETAIL transport failure');
    fixture.setOrderDetailReplies([frame]);
    const read = fixture.createQueryOrdersReader();
    const invokedOrderIds: string[] = [];
    fixture.setOrderDetailBeforeReply(async (orderId) => {
      invokedOrderIds.push(orderId);
      expect(fixture.nativeReadCounts().detail).toBe(1);
      throw originalError;
    });
    const failed = await read().catch((error: unknown) => error);
    expect(failed).toBe(originalError);
    expect(invokedOrderIds).toEqual([frame.orderId]);
    fixture.setOrderDetailBeforeReply(async () => {});
    fixture.setQueryUpdatedAt(1700000000200);
    expect(fixture.nativeReadCounts().detail).toBe(1);
    const rawFailure = await read().catch((error: unknown) => error);
    expect(rawFailure).toBeInstanceOf(TypeError);
    expect(rawFailure).toHaveProperty('message', '[orderMapper] invalid updatedAt');
    expect(fixture.nativeReadCounts().detail).toBe(2);
    expect(fixture.nativeMutations()).toEqual([]);
  });

  it('applies explicit Unknown side lazily after configured native DETAIL reply selection without contaminating legal custom frames', async () => {
    const frame = originalFrame();
    const custom = { ...frame, orderId: 'CUSTOM-DETAIL-SIDE', side: 'BUY' as const };
    const fixture = await createBrokerIngressFixture(frame);
    fixture.setOrderDetailReplies([custom, custom]);
    const read = fixture.createQueryOrdersReader(custom.orderId);
    const legalOrders = await read();
    expect(legalOrders[0]?.executionSide).toBe('BUY');
    expect(fixture.nativeReadCounts().detail).toBe(1);
    fixture.setQuerySideUnknown();
    expect(fixture.nativeReadCounts().detail).toBe(1);
    const failure = await read().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TypeError);
    expect(failure).toHaveProperty('message', '[orderMapper] unknown SDK execution side');
    expect(fixture.nativeReadCounts().detail).toBe(2);
    expect(fixture.nativeMutations()).toEqual([]);
  });

  it('preserves the original lazy getter Error identity on a configured DETAIL frame after native issue', async () => {
    const frame = originalFrame();
    const fixture = await createBrokerIngressFixture(frame);
    fixture.setOrderDetailReplies([{ ...frame, orderId: 'CUSTOM-GETTER-FAILURE' }]);
    const originalError = new TypeError('original detail-side getter failure');
    fixture.setQueryGetterFailure(originalError);
    expect(fixture.nativeReadCounts().detail).toBe(0);
    const failure = await fixture
      .createQueryOrdersReader('CUSTOM-GETTER-FAILURE')()
      .catch((error: unknown) => error);
    expect(failure).toBe(originalError);
    expect(fixture.nativeReadCounts().detail).toBe(1);
    expect(fixture.nativeMutations()).toEqual([]);
  });

  it('keeps missing native cumulative quantity separate from submitted quantity and fails after DETAIL invoke', async () => {
    const fixture = await createBrokerIngressFixture(originalFrame());
    fixture.setQueryExecutedQuantityMissing();
    expect(fixture.nativeReadCounts().detail).toBe(0);
    const failure = await fixture
      .createQueryOrdersReader()()
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TypeError);
    if (!(failure instanceof Error))
      throw new Error('expected actual cumulative quantity TypeError');

    expect(failure.stack).toContain('orderMapper');
    expect(fixture.nativeReadCounts().detail).toBe(1);
    expect(fixture.nativeMutations()).toEqual([]);
  });

  it('connects actual Recorder snapshot reads to the original native context without execution reads', async () => {
    const frame = originalFrame();
    const fixture = await createBrokerIngressFixture(frame);
    fixture.setOrderSnapshotReplies([], [frame]);
    let throttles = 0;
    let refreshNeeds = 0;
    const recorder = fixture.createRecorder({
      logger: createLoggerDouble(),
      rateLimiter: {
        throttle: async () => {
          throttles += 1;
        },
      },
      settlementRefreshNeedRecorder: {
        recordSettlementRefreshNeed: () => {
          refreshNeeds += 1;
        },
      },
    });
    const orders = await recorder.fetchAllOrdersFromAPI();
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({
      orderId: frame.orderId,
      executedAmount: '100',
      executedQuantity: 100,
      executionTimeMs: frame.updatedAtMs,
    });
    expect(fixture.orderSnapshotReadCounts()).toEqual({ history: 1, today: 1 });
    expect(throttles).toBe(2);
    expect(refreshNeeds).toBe(0);
    expect(fixture.nativeMutations()).toEqual([]);
  });

  it('keeps missing native detail quantity lazy and reaches the actual mapper before ledger IO', async () => {
    const fixture = await createBrokerIngressFixture(originalFrame());
    const before = fixture.nativeReadCounts().detail;
    fixture.setQueryQuantityMissing();
    expect(fixture.nativeReadCounts().detail).toBe(before);
    const failure = await fixture
      .createQueryOrdersReader()()
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TypeError);
    expect(fixture.nativeReadCounts().detail).toBe(before + 1);
    expect(fixture.nativeMutations()).toEqual([]);
  });

  it('invokes the actual native empty account array without a default account', async () => {
    const fixture = await createBrokerIngressFixture(originalFrame());
    const account = fixture.createAccountService({ rateLimiter: createRateLimiterDouble() });
    fixture.setAccountBalanceEmpty();
    const emptyFailure = await account.getAccountSnapshot().catch((error: unknown) => error);
    expect(emptyFailure).toBeInstanceOf(TypeError);
    if (!(emptyFailure instanceof Error)) throw new Error('expected empty account failure');

    expect(emptyFailure.message).toContain('returned no primary account');
    expect(fixture.accountReadCounts()).toEqual({ balance: 1, positions: 0 });
    fixture.setAccountBalance({
      currency: 'HKD',
      totalCash: '10',
      netAssets: '13',
      availableCash: '7',
    });

    expect(await account.getAccountSnapshot()).toMatchObject({
      totalCash: '10',
      netAssets: '13',
      positionValue: '3',
    });
    expect(fixture.accountReadCounts()).toEqual({ balance: 2, positions: 0 });
    expect(fixture.nativeMutations()).toEqual([]);
  });

  it('fails a real native position read only after a canonical paired commit and genuine readiness-gate receipt', async () => {
    const fixture = await createBrokerIngressFixture(originalFrame());
    fixture.setStockPositions([
      {
        symbol: 'BULL.HK',
        symbolName: 'BULL',
        accountChannel: 'lb_papertrading',
        currency: 'HKD',
        quantity: '100',
        availableQuantity: '100',
        costPrice: '1',
      },
    ]);

    fixture.setAccountBalance({
      currency: 'HKD',
      totalCash: '1000',
      netAssets: '1100',
      availableCash: '1000',
    });
    const account = fixture.createAccountService({ rateLimiter: createRateLimiterDouble() });
    const snapshot = createAccountPositionSnapshot({
      clock: { now: () => new Date() },
      diagnostics: createDiagnosticObserverDouble(),
      dayEpoch: 1,
      readPort: account,
      scheduler: { schedule: queueMicrotask },
      reportFatalError: (error) => {
        throw error;
      },
    });
    try {
      const commit = await snapshot.requestRefresh({
        source: 'controller-baseline',
        dayEpoch: 1,
        refreshAccount: true,
        refreshPositions: true,
      }).result;
      if (commit.status !== 'COMMITTED') throw new Error('expected actual baseline commit');

      const readiness = createSettlementReadinessGate({
        diagnostics: createDiagnosticObserverDouble(),
        clock: { now: () => new Date() },
        snapshot,
      });
      const version = readiness.markStale();
      expect(readiness.markFresh(version, commit.snapshotToken)).toBeTrue();
      const receipt = await readiness.waitForFresh();
      expect(readiness.isCurrent(receipt)).toBeTrue();
      expect(snapshot.getView().positions[0]?.quantity).toBe(100);
      const baselineReads = fixture.accountReadCounts().positions;
      const original = new Error('service unavailable');
      fixture.setStockPositionsFailure(original);
      let failure: unknown;
      try {
        await account.getStockPositions({
          symbols: ['BULL.HK'],
          retryConfig: { retries: 0, delayMs: 0 },
        });
      } catch (error) {
        failure = error;
      }

      if (!isExternalApiRequestError(failure))
        throw new Error('expected original external read classification');

      expect(failure.cause).toBe(original);
      expect(fixture.accountReadCounts().positions).toBe(baselineReads + 1);
      expect(readiness.isCurrent(receipt)).toBeTrue();
      const internal = new TypeError('position native invariant');
      fixture.setStockPositionsFailure(internal);
      expect(await account.getStockPositions().catch((error: unknown) => error)).toBe(internal);
      expect(fixture.accountReadCounts().positions).toBe(baselineReads + 2);
      fixture.setStockPositionsFailure(null);
      const restoredPositions = await account.getStockPositions();
      expect(restoredPositions[0]?.availableQuantity).toBe(100);
      expect(fixture.nativeMutations()).toEqual([]);
    } finally {
      await snapshot.requestClear({ reason: 'STOP', dayEpoch: 1 });
    }
  });

  it('keeps explicit ELO and MO native detail metadata and assembles state query on the same context and ledger', async () => {
    const frame = originalFrame();
    const fixture = await createBrokerIngressFixture(frame);
    const elo = await createBrokerIngressFixture({ ...frame, orderType: 'ELO' });
    const mo = await createBrokerIngressFixture({ ...frame, orderType: 'MO' });
    expect(elo.queryObservation.orderType).not.toBe(mo.queryObservation.orderType);
    expect(elo.queryObservation.orderType).not.toBe(fixture.queryObservation.orderType);
    expect(mo.queryObservation.orderType).not.toBe(fixture.queryObservation.orderType);
    fixture.setOrderDetailReplies([
      { ...frame, orderType: 'MO' },
      { ...frame, orderType: 'ELO' },
    ]);
    const moRows = await fixture.createQueryOrdersReader(frame.orderId)();
    expect(moRows[0]?.orderType).toBe(mo.queryObservation.orderType);
    const eloRows = await fixture.createQueryOrdersReader(frame.orderId)();
    expect(eloRows[0]?.orderType).toBe(elo.queryObservation.orderType);
    const pushTypes: Array<OrderFact['orderType']> = [];
    fixture.createPushPort().setOnOrderChanged((error, decoder) => {
      expect(error).toBeNull();
      const mapped = decoder.decode();
      if (mapped === null) throw new Error('HK push sample must decode');

      pushTypes.push(mapped.orderType);
    });
    fixture.emitOrderChangedFrame({ ...frame, orderType: 'MO' });
    fixture.emitOrderChangedFrame({ ...frame, orderType: 'ELO' });
    expect(pushTypes).toEqual([mo.queryObservation.orderType, elo.queryObservation.orderType]);

    fixture.setOrderDetailReplies([{ ...frame, orderType: 'MO' }]);
    const state = fixture.createStateQuery({
      requestExternalApi: wrapExternalApiRequest,
      rateLimiter: createRateLimiterDouble(),
    });
    const origin = { current: true };
    const before = fixture.nativeReadCounts().detail;
    expect(await state.checkOrderState(frame.orderId, () => origin.current)).toMatchObject({
      kind: 'TERMINAL',
      executedQuantity: 100,
      executedAmount: '100',
      executionTimeMs: frame.updatedAtMs,
    });
    expect(fixture.nativeReadCounts().detail).toBe(before + 1);
    origin.current = false;
    expect(await state.checkOrderState(frame.orderId, () => origin.current)).toEqual({
      kind: 'QUERY_FAILED',
      errorCode: null,
    });
    expect(fixture.nativeReadCounts().detail).toBe(before + 1);
    expect(fixture.nativeMutations()).toEqual([]);
  });
});
