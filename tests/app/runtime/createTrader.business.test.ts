import { scheduleBoundedOneShotAt } from '../../../src/runtime/timer/index.js';
import { wrapExternalApiRequest } from '../../../src/infrastructure/externalApi/index.js';
import { nowMonotonicMs, wait } from '../../../src/infrastructure/time/index.js';

import {
  createLoggerDouble,
  createMarketDataClientDouble,
  createMonitorConfigDouble,
  createRateLimiterDouble,
  createRiskCheckerDouble,
  createSymbolRegistryDouble,
} from '../../helpers/testDoubles.js';
import type { TradeRuntime } from '../../../src/app/runtime/types.js';

/** Trader 门面契约：同 ctx 实际 ports 装配、原授权与原生 IO 故障；重建保留 H/O/Daily 原子提交。 */

import { describe, expect, it } from 'bun:test';
import { createTradingConfig } from '../../../mock/factories/configFactory.js';
import { createPostTradeConsistencyRuntime } from '../../../src/app/runtime/createPostTradeConsistencyRuntime.js';
import { createTerminationRuntime } from '../../../src/runtime/lifecycle/terminationRuntime.js';
import { createAccountPositionSnapshot } from '../../../src/application/accountPositionSnapshot/index.js';
import { createProtectiveLiquidationEpisodeTracker } from '../../../src/domain/liquidation/episode/index.js';
import { orderAnalysis } from '../../../src/domain/order/orderAnalysis.js';
import { createDailyLossTracker } from '../../../src/domain/risk/dailyLossTracker.js';
import { getRequiredHKDateKey, toHongKongTimeIso } from '../../../src/utils/time/index.js';

import type { BrokerIngressInput } from '../../infrastructure/longbridge/trade/brokerIngressFixture.js';
import { createBrokerIngressFixture } from '../../integration/architectureRefactoringP1Native/trade/brokerIngressFixture.js';

const NOW_MS = Date.parse('2026-03-13T02:00:00.000Z');

async function createNativeAccountFixture() {
  const native = await createBrokerIngressFixture({
    orderId: 'FACADE-SEED',
    tradeId: 'FACADE-SEED-trade',
    symbol: 'BULL.HK',
    stockName: 'HSI RC',
    remark: '',
    side: 'BUY',
    status: 'New',
    orderType: 'ELO',
    quantity: '100',
    executedQuantity: '0',
    submittedPrice: '1',
    executedPrice: '0',
    submittedAtMs: NOW_MS,
    executionTimeMs: null,
    updatedAtMs: NOW_MS,
  });
  native.setAccountBalance({
    currency: 'HKD',
    totalCash: '100000',
    netAssets: '100000',
    availableCash: '100000',
  });
  native.setStockPositions([]);
  return native;
}

/** 仅装配真实 Trader；不初始化订阅、不发布 baseline，也不声称默认 READY。 */
async function createFacadeFixture() {
  const native = await createNativeAccountFixture();
  const daily = createDailyLossTracker({
    onOwnershipWarning: () => {},
    ...orderAnalysis,
    toHongKongTimeIso,
  });
  daily.resetAll(new Date(NOW_MS));
  const termination = createTerminationRuntime({
    closeTradingGate: () => {},
    closeProducerAdmission: () => {},
    stopProducers: [],
    onSecondaryError: (error) => {
      throw error;
    },
  });
  const readPort = native.createAccountService({ rateLimiter: createRateLimiterDouble() });
  const snapshot = createAccountPositionSnapshot({
    dayEpoch: 1,
    scheduler: { schedule: queueMicrotask },
    readPort,
    reportFatalError: termination.reportFatalError,
  });
  let tradeRuntime: TradeRuntime | null = null;
  const settlement = createPostTradeConsistencyRuntime({
    logger: createLoggerDouble(),
    snapshot,
    termination,
    getProtectiveOrderReader: () => {
      if (tradeRuntime === null) throw new Error('Trader composition has not completed');

      return tradeRuntime.orderMonitor;
    },
    onPositionsCommitted: async () => {},
    scheduler: { scheduleTimer: setTimeout, clearTimer: clearTimeout },
  });
  const createTradeRuntime = (): Promise<TradeRuntime> =>
    native
      .createTradeRuntime({
        logger: createLoggerDouble(),
        wait: wait,
        nowMonotonicMs: nowMonotonicMs,
        requestExternalApi: wrapExternalApiRequest,
        scheduleBoundedOneShotAt: scheduleBoundedOneShotAt,
        tradingConfig: createTradingConfig(),
        marketDataClient: createMarketDataClientDouble(),
        symbolRegistry: createSymbolRegistryDouble(),
        dailyLossTracker: daily,
        protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTracker(),
        persistProtectiveLiquidationExecutionProgress: () => {},
        postTradeConsistencyRuntime: settlement,
        isExecutionAllowed: () => true,
        isContinuousTradingAllowed: () => true,
        now: () => new Date(NOW_MS),
        scheduleTimer: setTimeout,
        clearTimer: clearTimeout,
        readCurrentTradingDayInfo: () => ({
          dateKey: getRequiredHKDateKey(new Date(NOW_MS)),
          info: { isTradingDay: true, isHalfDay: false },
        }),
        unrealizedLossBuyGate: createRiskCheckerDouble(),
        termination,
      })
      .then((owner) => {
        tradeRuntime = owner;
        return owner;
      });
  return { native, daily, snapshot, settlement, createTradeRuntime };
}

function seedOriginalPosition(
  native: Awaited<ReturnType<typeof createNativeAccountFixture>>,
): void {
  native.setStockPositions([
    {
      symbol: '700.HK',
      symbolName: '700.HK',
      accountChannel: 'lb_papertrading',
      currency: 'HKD',
      quantity: '100',
      availableQuantity: '80',
      costPrice: '1',
    },
  ]);
}

function assertOriginalCause(error: unknown, original: Error): void {
  if (!(error instanceof Error)) throw new Error('Missing actual external IO rejection');

  expect(error.cause).toBe(original);
}

async function catchRejection(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
  } catch (error) {
    return error;
  }

  return null;
}

describe('tradeRuntime facade business flow', () => {
  it('createTradeRuntime 不再暴露旧的订单监控轮询入口', async () => {
    const f = await createFacadeFixture();
    const tradeRuntime = await f.createTradeRuntime();
    expect('monitorAndManageOrders' in tradeRuntime).toBe(false);
    expect(f.native.contextCreationCount()).toBe(1);
    expect(f.native.accountReadCounts()).toEqual({ balance: 0, positions: 0 });
  });

  it('将末日撤单 permit 内授权透传到专用 Trader API，授权失效时不调用 broker', async () => {
    const f = await createFacadeFixture();
    const tradeRuntime = await f.createTradeRuntime();
    await tradeRuntime.orderMonitor.initialize();
    await tradeRuntime.orderMonitor.recoverOrderTrackingFromSnapshot([]);
    let authorizationChecks = 0;
    const outcome = await tradeRuntime.orderMonitor.cancelDoomsdayOrder('DOOMSDAY-BUY', {
      kind: 'DOOMSDAY_WINDOW',
      beforeBrokerCancel: () => {
        authorizationChecks++;
        return false;
      },
    });
    expect(outcome).toEqual({ kind: 'CANCEL_NOT_STARTED' });
    expect(f.native.nativeReadCounts().cancel).toBe(0);
    expect(f.native.nativeMutations()).toEqual([]);
    expect(authorizationChecks).toBe(1);
    await tradeRuntime.orderMonitor.stopRuntimeAndDrain();
  });

  it('createTradeRuntime 通过公开 orderRecorder 工厂组装真实订单记录器', async () => {
    const f = await createFacadeFixture();
    const tradeRuntime = await f.createTradeRuntime();
    const paired = await f.snapshot.requestRefresh({
      source: 'TRADER_RECORDER_REBUILD',
      dayEpoch: 1,
      refreshAccount: true,
      refreshPositions: true,
    }).result;
    if (paired.status !== 'COMMITTED') throw new Error('Trader paired H refresh aborted');

    const frames: ReadonlyArray<BrokerIngressInput> = [
      {
        orderId: 'BUY-1',
        tradeId: 'BUY-1-trade',
        symbol: 'BULL.HK',
        stockName: 'HSI RC',
        remark: '',
        side: 'BUY',
        status: 'Filled',
        orderType: 'ELO',
        quantity: '100',
        executedQuantity: '100',
        submittedPrice: '1',
        executedPrice: '1',
        submittedAtMs: 1000,
        executionTimeMs: 1000,
        updatedAtMs: 1000,
      },
      {
        orderId: 'BUY-2',
        tradeId: 'BUY-2-trade',
        symbol: 'BULL.HK',
        stockName: 'HSI RC',
        remark: '',
        side: 'BUY',
        status: 'Filled',
        orderType: 'ELO',
        quantity: '100',
        executedQuantity: '100',
        submittedPrice: '1.2',
        executedPrice: '1.2',
        submittedAtMs: 2000,
        executionTimeMs: 2000,
        updatedAtMs: 2000,
      },
    ];
    f.native.setOrderSnapshotReplies(frames, []);
    f.native.setExecutionReplies([
      {
        orderId: 'BUY-1',
        tradeId: 'BUY-1-trade',
        symbol: 'BULL.HK',
        quantity: '100',
        price: '1',
        tradeDoneAtMs: 1000,
      },
      {
        orderId: 'BUY-2',
        tradeId: 'BUY-2-trade',
        symbol: 'BULL.HK',
        quantity: '100',
        price: '1.2',
        tradeDoneAtMs: 2000,
      },
    ]);
    const observations = await tradeRuntime.orderRecorder.fetchAllOrdersFromAPI();
    expect(f.native.orderSnapshotReadCounts()).toEqual({ history: 1, today: 1 });
    expect(
      observations.map((o) => ({
        id: o.orderId,
        amount: o.executedAmount,
        quantity: o.executedQuantity,
        time: o.executionTimeMs,
        phase: o.executionPhase,
      })),
    ).toEqual([
      { id: 'BUY-1', amount: '100', quantity: 100, time: 1000, phase: 'TERMINAL' },
      { id: 'BUY-2', amount: '120', quantity: 100, time: 2000, phase: 'TERMINAL' },
    ]);
    const prepared = f.daily.prepareRecalculationFromAllOrders(
      observations,
      createMonitorConfigDouble({ monitorSymbol: 'HSI.HK' }),
      new Date(NOW_MS),
    );
    const commit = tradeRuntime.orderRecorder.commitRebuildSnapshot(
      [{ symbol: 'BULL.HK', isLongSymbol: true }],
      observations,
      () =>
        f.snapshot.isCurrent(paired.snapshotToken, {
          account: true,
          positions: true,
          paired: true,
        }) && prepared.isCurrent(),
      'REBUILD',
    );
    if (commit.status !== 'COMMITTED') throw new Error('Trader O rebuild aborted');

    f.daily.publishRecalculation(prepared);
    const buyOrders = tradeRuntime.orderRecorder.getBuyOrdersForSymbol('BULL.HK', true);
    const sellableOrders = tradeRuntime.orderRecorder.selectSellableOrders({
      symbol: 'BULL.HK',
      direction: 'LONG',
      strategy: 'PROFIT_ONLY',
      currentPrice: '1.1',
    });
    expect(buyOrders).toHaveLength(2);
    expect(
      buyOrders.map((order) => ({
        amount: order.costAmount,
        quantity: order.executedQuantity,
        time: order.executedTime,
      })),
    ).toEqual([
      { amount: '100', quantity: 100, time: 1000 },
      { amount: '120', quantity: 100, time: 2000 },
    ]);

    expect(
      f.snapshot.isCurrent(paired.snapshotToken, { account: true, positions: true, paired: true }),
    ).toBeTrue();
    expect(f.settlement.getStatus().staleVersion).toBe(0);
    expect(tradeRuntime.orderRecorder.getCostBasis('BULL.HK', true)).toEqual({
      costAmount: '220',
      quantity: 200,
    });
    expect(sellableOrders.orders).toHaveLength(1);
    expect(sellableOrders.orders[0]).toMatchObject({
      costAmount: '100',
      executedQuantity: 100,
      executedTime: 1000,
    });
    expect(sellableOrders.orders[0]?.orderId).toBe('BUY-1');
    tradeRuntime.orderRecorder.resetAll();
    tradeRuntime.cacheManager.clearCache();
    tradeRuntime.orderHoldRegistry.clear();
    tradeRuntime.orderMonitor.clearTrackedOrders();
    tradeRuntime.orderExecutor.resetBuyThrottle();
    expect(tradeRuntime.orderRecorder.getBuyOrdersForSymbol('BULL.HK', true)).toEqual([]);
    expect(tradeRuntime.orderRecorder.getCostBasis('BULL.HK', true)).toBeNull();
  });

  it('createTradeRuntime 在 TradeContext.new 同步抛错时保持 rejected promise 语义', async () => {
    const f = await createFacadeFixture();
    const original = new Error('trade context init failed');
    f.native.setContextCreationFailure(original);
    const promise = f.createTradeRuntime();
    expect(promise).toBeInstanceOf(Promise);
    const caught = await catchRejection(() => promise);
    expect(caught).toBe(original);
    expect(caught).toHaveProperty('message', 'trade context init failed');
    expect(f.native.contextCreationCount()).toBe(1);
    expect(f.native.accountReadCounts()).toEqual({ balance: 0, positions: 0 });
  });

  it('createTradeRuntime 的公开 getAccountSnapshot 在空账户时透传契约失败', async () => {
    const f = await createFacadeFixture();
    f.native.setAccountBalanceEmpty();
    const tradeRuntime = await f.createTradeRuntime();
    const caught = await catchRejection(() => tradeRuntime.accountService.getAccountSnapshot());
    expect(caught).toBeInstanceOf(TypeError);
    expect(caught).toHaveProperty(
      'message',
      'TradeContext.accountBalance returned no primary account',
    );
  });

  it('createTradeRuntime 的公开 getAccountSnapshot 支持透传 retryConfig 并保持 attempts 为 1', async () => {
    const f = await createFacadeFixture();
    const original = new Error('service unavailable');
    f.native.setAccountBalanceFailure(original);
    const tradeRuntime = await f.createTradeRuntime();
    const caught = await catchRejection(() =>
      tradeRuntime.accountService.getAccountSnapshot({ retryConfig: { retries: 0, delayMs: 0 } }),
    );
    expect(caught).toMatchObject({
      name: 'ExternalApiRequestError',
      attempts: 1,
      operation: 'TradeContext.accountBalance',
      cause: original,
    });
    assertOriginalCause(caught, original);
    expect(f.native.accountReadCounts().balance).toBe(1);
  });

  it('createTradeRuntime 的公开 getStockPositions 支持透传 symbols 与 retryConfig', async () => {
    const f = await createFacadeFixture();
    seedOriginalPosition(f.native);
    const original = new Error('service unavailable');
    f.native.setStockPositionsFailure(original);
    const tradeRuntime = await f.createTradeRuntime();
    const caught = await catchRejection(() =>
      tradeRuntime.accountService.getStockPositions({
        symbols: ['700.HK'],
        retryConfig: { retries: 0, delayMs: 0 },
      }),
    );
    expect(caught).toMatchObject({
      name: 'ExternalApiRequestError',
      attempts: 1,
      operation: 'TradeContext.stockPositions',
      cause: original,
    });
    assertOriginalCause(caught, original);
    expect(f.native.accountReadCounts().positions).toBe(1);
    expect(f.native.positionReadSymbols()).toEqual([['700.HK']]);
  });
});

describe('account service contract boundary', () => {
  it('getAccountSnapshot 在 accountBalance 返回空数组时拒绝为无账户快照', async () => {
    const native = await createNativeAccountFixture();
    native.setAccountBalanceEmpty();
    const account = native.createAccountService({ rateLimiter: createRateLimiterDouble() });
    const caught = await catchRejection(() => account.getAccountSnapshot());
    expect(caught).toBeInstanceOf(TypeError);
    expect(caught).toHaveProperty(
      'message',
      'TradeContext.accountBalance returned no primary account',
    );
  });

  it('getStockPositions 在 stockPositions 返回空 channels 时保留权威空持仓事实', async () => {
    const native = await createNativeAccountFixture();
    const account = native.createAccountService({ rateLimiter: createRateLimiterDouble() });
    expect(await account.getStockPositions()).toEqual([]);
  });

  it('getAccountSnapshot 在显式禁用重试时只尝试一次', async () => {
    const native = await createNativeAccountFixture();
    const original = new Error('service unavailable');
    native.setAccountBalanceFailure(original);
    const account = native.createAccountService({ rateLimiter: createRateLimiterDouble() });
    const caught = await catchRejection(() =>
      account.getAccountSnapshot({ retryConfig: { retries: 0, delayMs: 0 } }),
    );
    expect(caught).toMatchObject({
      name: 'ExternalApiRequestError',
      attempts: 1,
      operation: 'TradeContext.accountBalance',
      cause: original,
    });
    assertOriginalCause(caught, original);
    expect(native.accountReadCounts().balance).toBe(1);
  });

  it('getStockPositions 支持对象参数同时透传 symbols 与 retryConfig', async () => {
    const native = await createNativeAccountFixture();
    seedOriginalPosition(native);
    const original = new Error('service unavailable');
    native.setStockPositionsFailure(original);
    const account = native.createAccountService({ rateLimiter: createRateLimiterDouble() });
    const caught = await catchRejection(() =>
      account.getStockPositions({ symbols: ['700.HK'], retryConfig: { retries: 0, delayMs: 0 } }),
    );
    expect(caught).toMatchObject({
      name: 'ExternalApiRequestError',
      attempts: 1,
      operation: 'TradeContext.stockPositions',
      cause: original,
    });
    assertOriginalCause(caught, original);
    expect(native.accountReadCounts().positions).toBe(1);
    expect(native.positionReadSymbols()).toEqual([['700.HK']]);
  });

  it('getAccountSnapshot 在存在主账户时返回快照', async () => {
    const native = await createNativeAccountFixture();
    seedOriginalPosition(native);
    const account = native.createAccountService({ rateLimiter: createRateLimiterDouble() });
    const snapshot = await account.getAccountSnapshot();
    expect(snapshot).toMatchObject({
      currency: 'HKD',
      totalCash: '100000',
      netAssets: '100000',
      positionValue: '0',
    });

    expect(await account.getStockPositions()).toMatchObject([
      { symbol: '700.HK', quantity: 100, availableQuantity: 80, costPrice: '1' },
    ]);
  });
});
