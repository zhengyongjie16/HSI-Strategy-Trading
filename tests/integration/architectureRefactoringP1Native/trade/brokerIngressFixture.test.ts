import { nowMonotonicMs, wait } from '../../../../src/infrastructure/time/index.js';
import { scheduleBoundedOneShotAt } from '../../../../src/runtime/timer/index.js';
import { wrapExternalApiRequest } from '../../../../src/infrastructure/externalApi/index.js';

import {
  createLoggerDouble,
  createDailyLossTrackerDouble,
  createMarketDataClientDouble,
  createOrderRecorderDouble,
  createProtectiveLiquidationEpisodeTrackerDouble,
  createSymbolRegistryDouble,
} from '../../../helpers/testDoubles.js';

/** 无网络typed SDK DTO→实际adapter→query/push完整中性事实，不把mapper作为经济expected oracle。 */

import { describe, expect, it } from 'bun:test';
import { createTradingConfig } from '../../../../mock/factories/configFactory.js';
import { createRateLimiter } from '../../../../src/application/orderExecution/rateLimiter.js';
import { createOrderHoldRegistry } from '../../../../src/application/orderTracking/orderHoldRegistry.js';

import { createBrokerIngressFixture } from './brokerIngressFixture.js';

describe('broker ingress fixture production mapping', () => {
  it('proves full query/push native DTO fields, exact cost and independent execution/revision', async () => {
    const fixture = await createBrokerIngressFixture({
      orderId: 'BROKER-O',
      tradeId: 'TRADE-T',
      symbol: 'BULL.HK',
      stockName: 'Typed SDK DTO',
      remark: 'offline',
      side: 'SELL',
      status: 'Filled',
      quantity: '100',
      executedQuantity: '100',
      submittedPrice: '9.3',
      executedPrice: '9.234567891234567891',
      submittedAtMs: 1700000000000,
      executionTimeMs: 1700000000100,
      updatedAtMs: 1700000000200,
    });
    expect(() => {
      fixture.emitOrderChanged();
    }).toThrow('Monitor SDK push callback not registered');
    expect(fixture.queryObservation).toEqual(fixture.pushObservation);
    expect(fixture.queryObservation).toMatchObject({
      orderId: 'BROKER-O',
      symbol: 'BULL.HK',
      stockName: 'Typed SDK DTO',
      remark: 'offline',
      executionSide: 'SELL',
      executionStatus: 'FILLED',
      quantity: 100,
      executedQuantity: 100,
      price: '9.3',
      executedPrice: '9.234567891234567891',
      executedAmount: '923.4567891234567891',
      executionTimeMs: 1700000000100,
      updatedAtMs: 1700000000200,
    });
    expect(fixture.queryObservation.submittedAt.getTime()).toBe(1700000000000);
    expect(fixture.readCounts()).toEqual({ today: 1, history: 0 });
    const history = await fixture.executionLedgerPort.historyExecutions({
      endAt: new Date(1700000000300),
    });
    expect(history[0]?.tradeDoneAtMs).toBe(1700000000100);
    expect(fixture.readCounts()).toEqual({ today: 1, history: 1 });
    const fatalErrors: unknown[] = [];
    const monitor = fixture.createMonitor({
      logger: createLoggerDouble(),
      wait: wait,
      requestExternalApi: wrapExternalApiRequest,
      scheduleBoundedOneShotAt: scheduleBoundedOneShotAt,
      rateLimiter: createRateLimiter({
        wait: wait,
        nowMonotonicMs: nowMonotonicMs,
        logger: createLoggerDouble(),
      }),
      cacheManager: { clearCache: () => {}, getPendingOrders: async () => [] },
      marketDataClient: createMarketDataClientDouble(),
      orderRecorder: createOrderRecorderDouble(),
      dailyLossTracker: createDailyLossTrackerDouble(),
      orderHoldRegistry: createOrderHoldRegistry(),
      protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
      persistProtectiveLiquidationExecutionProgress: () => {},
      symbolRegistry: createSymbolRegistryDouble(),
      tradingConfig: createTradingConfig(),
      postTradeConsistencyRuntime: { recordSettlementRefreshNeed: () => {} },
      isContinuousTradingAllowed: () => true,
      now: () => new Date(1700000000200),
      scheduleTimer: setTimeout,
      clearTimer: clearTimeout,
      termination: {
        isTerminated: () => false,
        reportFatalError: (error) => {
          fatalErrors.push(error);
        },
      },
    });
    await monitor.initialize();
    // 实际SDK注册callback受STOPPED生命周期拒绝；ACTIVE经济链由business owner独立编排证明。
    expect(() => {
      fixture.emitOrderChanged();
    }).not.toThrow();
    await monitor.stopRuntimeAndDrain();
    expect(fatalErrors).toEqual([]);
    let settleToday!: () => void;
    let settleHistory!: () => void;
    fixture.setExecutionReadBarriers({
      today: new Promise<void>((resolve) => {
        settleToday = resolve;
      }),
      history: new Promise<void>((resolve) => {
        settleHistory = resolve;
      }),
    });
    let todaySettled = false;
    let historySettled = false;
    const todayRead = fixture.executionLedgerPort.todayExecutions().then(() => {
      todaySettled = true;
    });
    const historyRead = fixture.executionLedgerPort
      .historyExecutions({ endAt: new Date(1700000000300) })
      .then(() => {
        historySettled = true;
      });
    expect(fixture.readCounts()).toEqual({ today: 2, history: 2 });
    await Promise.resolve();
    expect(todaySettled).toBe(false);
    expect(historySettled).toBe(false);
    settleToday();
    await todayRead;
    expect(historySettled).toBe(false);
    settleHistory();
    await historyRead;
    expect(historySettled).toBe(true);
    const lazyRead = fixture.createQueryOrdersReader();
    fixture.setQuerySideUnknown();
    expect(fixture.nativeReadCounts().detail).toBe(0);
    let rejected: unknown;
    try {
      await lazyRead();
    } catch (error) {
      rejected = error;
    }

    expect(rejected).toBeInstanceOf(TypeError);
    expect(rejected).toHaveProperty('message', '[orderMapper] unknown SDK execution side');
    expect(fixture.nativeReadCounts().detail).toBe(1);
    expect(fixture.readCounts()).toEqual({ today: 2, history: 2 });
    const getterFault = new RangeError('lazy SDK detail getter');
    fixture.setQueryGetterFailure(getterFault);
    try {
      await lazyRead();
    } catch (error) {
      rejected = error;
    }

    expect(rejected).toBe(getterFault);
    expect(fixture.nativeReadCounts().detail).toBe(2);
  });
});
