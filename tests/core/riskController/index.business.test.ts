/**
 * riskController/index 业务测试
 *
 * 功能：
 * - 验证风控组合（持仓/浮亏）场景意图与业务期望。
 */
import { describe, expect, it } from 'bun:test';
import { createRiskChecker } from '../../../src/core/riskController/index.js';
import { createUnrealizedLossChecker } from '../../../src/core/riskController/unrealizedLossChecker.js';
import { createUnrealizedLossMonitor } from '../../../src/core/riskController/unrealizedLossMonitor.js';
import { createExternalApiRequestError } from '../../helpers/createExternalApiRequestError.js';
import type {
  PositionLimitChecker,
  UnrealizedLossChecker,
  WarrantRiskChecker,
} from '../../../src/core/riskController/types.js';
import {
  createAccountSnapshotDouble,
  createDailyLossTrackerDouble,
  createOrderRecorderDouble,
  createQuoteDouble,
  createRiskCheckerDouble,
  createSignalDouble,
  createTraderDouble,
} from '../../helpers/testDoubles.js';

function createWarrantCheckerStub(): WarrantRiskChecker {
  return {
    setWarrantInfoFromCallPrice: () => ({ status: 'ok', isWarrant: true }),
    refreshWarrantInfoForSymbol: async () => ({ status: 'ok', isWarrant: true }),
    checkRisk: () => ({ allowed: true }),
    checkWarrantDistanceLiquidation: () => ({ shouldLiquidate: false }),
    getWarrantDistanceInfo: () => null,
    clearLongWarrantInfo: () => {},
    clearShortWarrantInfo: () => {},
  };
}

function getMissingUnrealizedLossData(): undefined {
  return;
}

function createUnrealizedLossCheckerStub(
  overrides: Partial<UnrealizedLossChecker> = {},
): UnrealizedLossChecker {
  const base: UnrealizedLossChecker = {
    getUnrealizedLossData: getMissingUnrealizedLossData,
    clearUnrealizedLossData: () => {},
    prepare: (_orderRecorder, symbol) => ({ symbol, data: { r1: '0', n1: 0 } }),
    publish: () => {},
    check: () => ({ shouldLiquidate: false }),
  };
  return { ...base, ...overrides };
}

function createPositionLimitCheckerStub(
  overrides: Partial<PositionLimitChecker> = {},
): PositionLimitChecker {
  const base: PositionLimitChecker = {
    checkLimit: () => ({ allowed: true }),
  };
  return { ...base, ...overrides };
}

describe('riskController(index) business flow', () => {
  it('rejects buy when HKD available cash is insufficient', () => {
    const checker = createRiskChecker({
      warrantRiskChecker: createWarrantCheckerStub(),
      unrealizedLossChecker: createUnrealizedLossCheckerStub(),
      positionLimitChecker: createPositionLimitCheckerStub(),
    });

    const result = checker.checkBeforeOrder({
      account: createAccountSnapshotDouble('500'),
      positions: [],
      signal: createSignalDouble('BUYCALL', 'BULL.HK'),
      orderNotional: '5000',
    });

    expect(result.allowed).toBeFalse();
    expect(result.reason).toContain('港币可用现金');
  });

  it('rejects buy when account data is unavailable before position-limit checking', () => {
    let positionLimitCalls = 0;
    const checker = createRiskChecker({
      warrantRiskChecker: createWarrantCheckerStub(),
      unrealizedLossChecker: createUnrealizedLossCheckerStub(),
      positionLimitChecker: createPositionLimitCheckerStub({
        checkLimit: () => {
          positionLimitCalls += 1;
          return { allowed: true };
        },
      }),
    });

    const result = checker.checkBeforeOrder({
      account: null,
      positions: [],
      signal: createSignalDouble('BUYCALL', 'BULL.HK'),
      orderNotional: '5000',
    });

    expect(result.allowed).toBeFalse();
    expect(result.reason).toContain('账户数据不可用');
    expect(positionLimitCalls).toBe(0);
  });

  it('returns position limit checker rejection after passing buy preconditions', () => {
    const checker = createRiskChecker({
      warrantRiskChecker: createWarrantCheckerStub(),
      unrealizedLossChecker: createUnrealizedLossCheckerStub({
        getUnrealizedLossData: getMissingUnrealizedLossData,
      }),
      positionLimitChecker: createPositionLimitCheckerStub({
        checkLimit: () => ({
          allowed: false,
          reason: '持仓市值超过限制',
        }),
      }),
    });

    const result = checker.checkBeforeOrder({
      account: createAccountSnapshotDouble('100000'),
      positions: [],
      signal: createSignalDouble('BUYCALL', 'BULL.HK'),
      orderNotional: '5000',
    });

    expect(result.allowed).toBeFalse();
    expect(result.reason).toBe('持仓市值超过限制');
  });

  it('rethrows internal errors during unrealized loss preparation', () => {
    const checker = createUnrealizedLossChecker({ maxUnrealizedLossPerSymbol: '1000' });
    const internalError = new Error('order recorder broken');
    const orderRecorder = createOrderRecorderDouble({
      getCostBasis: () => {
        throw internalError;
      },
    });

    expect(() => checker.prepare(orderRecorder, 'BULL.HK', true, '0')).toThrow(internalError);
  });

  it('prepares exact R1/N1 without publishing and applies the daily loss offset synchronously', () => {
    const checker = createUnrealizedLossChecker({ maxUnrealizedLossPerSymbol: '499' });
    const orderRecorder = createOrderRecorderDouble({
      getCostBasis: () => ({ costAmount: '1000', quantity: 90 }),
    });

    const dailyLossTracker = createDailyLossTrackerDouble();
    const now = new Date('2026-02-16T02:00:00.000Z');
    const dailyPrepared = dailyLossTracker.prepareRecalculationFromAllOrders(
      [],
      { monitorSymbol: 'HSI.HK', orderOwnershipMapping: ['HSI'] },
      now,
      undefined,
      new Set(['BULL.HK']),
    );
    expect(dailyPrepared.isCurrent()).toBeTrue();
    expect(dailyLossTracker.getLossOffset('LONG')).toBe('0');
    dailyLossTracker.publishRecalculation(dailyPrepared);
    expect(dailyPrepared.isCurrent()).toBeFalse();
    expect(
      dailyLossTracker.recordCumulativeExecution({
        factStage: 'TERMINAL',
        direction: 'LONG',
        symbol: 'BULL.HK',
        side: 'BUY',
        executedPrice: '10',
        executedQuantity: 100,
        executedTimeMs: now.getTime() - 2,
        orderUpdatedAtMs: now.getTime() - 2,
        orderId: 'DAILY-LOSS-BUY',
      }).admission,
    ).toBe('ADMITTED');

    expect(
      dailyLossTracker.recordCumulativeExecution({
        factStage: 'TERMINAL',
        direction: 'LONG',
        symbol: 'BULL.HK',
        side: 'SELL',
        executedPrice: '8',
        executedQuantity: 100,
        executedTimeMs: now.getTime() - 1,
        orderUpdatedAtMs: now.getTime() - 1,
        orderId: 'DAILY-LOSS-SELL',
      }).admission,
    ).toBe('ADMITTED');
    expect(dailyLossTracker.getLossOffset('LONG')).toBe('-200');
    const prepared = checker.prepare(
      orderRecorder,
      'BULL.HK',
      true,
      dailyLossTracker.getLossOffset('LONG'),
    );
    expect(checker.getUnrealizedLossData('BULL.HK')).toBeUndefined();
    expect(prepared).toEqual({ symbol: 'BULL.HK', data: { r1: '1200', n1: 90 } });
    checker.publish(prepared);
    const result = checker.check('BULL.HK', '7', true);
    expect(checker.getUnrealizedLossData('BULL.HK')).toEqual({ r1: '1200', n1: 90 });
    expect(result).toMatchObject({ shouldLiquidate: true, quantity: 90 });
  });

  it('keeps the buy gate open when unrealized-loss cache is missing or the threshold is disabled', () => {
    const cacheMissingChecker = createUnrealizedLossChecker({ maxUnrealizedLossPerSymbol: '100' });
    expect(cacheMissingChecker.check('BULL.HK', '1', true)).toEqual({ shouldLiquidate: false });
    const disabledChecker = createUnrealizedLossChecker({ maxUnrealizedLossPerSymbol: '0' });
    disabledChecker.publish(
      disabledChecker.prepare(
        createOrderRecorderDouble({ getCostBasis: () => ({ costAmount: '1000', quantity: 100 }) }),
        'BULL.HK',
        true,
        '0',
      ),
    );
    expect(disabledChecker.check('BULL.HK', '1', true)).toEqual({ shouldLiquidate: false });
  });

  it('rethrows submitOrder API failure during protective liquidation', async () => {
    const authorization = { revision: 1 };
    const capturedRevision = authorization.revision;
    const isCurrent = () => authorization.revision === capturedRevision;
    const monitor = createUnrealizedLossMonitor({
      maxUnrealizedLossPerSymbol: '1000',
    });
    const submitError = await createExternalApiRequestError({
      operation: 'TradeContext.submitOrder',
      attempts: 1,
      cause: new Error('submit timeout'),
    });
    const riskChecker = createRiskCheckerDouble({
      checkUnrealizedLoss: () => ({ shouldLiquidate: true, reason: 'loss limit', quantity: 100 }),
    });
    const trader = createTraderDouble({
      executeSignals: async (_signals, callerAuthorization) => {
        expect(callerAuthorization).toBe(isCurrent);
        expect(callerAuthorization()).toBeTrue();
        throw submitError;
      },
    });
    const orderRecorder = createOrderRecorderDouble();
    const dailyLossTracker = createDailyLossTrackerDouble();

    let caught: unknown = null;
    try {
      await monitor.monitorDirectionalUnrealizedLoss({
        symbol: 'BULL.HK',
        isLong: true,
        seatVersion: 2,
        quote: createQuoteDouble('BULL.HK', '1.1', 100),
        riskChecker,
        trader,
        orderRecorder,
        dailyLossTracker,
        isCurrent,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(submitError);
  });

  it('rethrows internal trader execution errors during protective liquidation', async () => {
    const authorization = { revision: 1 };
    const capturedRevision = authorization.revision;
    const isCurrent = () => authorization.revision === capturedRevision;
    const monitor = createUnrealizedLossMonitor({
      maxUnrealizedLossPerSymbol: '1000',
    });
    const internalError = new TypeError('trader execution invariant broken');

    const execution = monitor.monitorDirectionalUnrealizedLoss({
      symbol: 'BULL.HK',
      isLong: true,
      seatVersion: 2,
      quote: createQuoteDouble('BULL.HK', '1.1', 100),
      riskChecker: createRiskCheckerDouble({
        checkUnrealizedLoss: () => ({
          shouldLiquidate: true,
          reason: 'loss limit',
          quantity: 100,
        }),
      }),
      trader: createTraderDouble({
        executeSignals: async (_signals, callerAuthorization) => {
          expect(callerAuthorization).toBe(isCurrent);
          expect(callerAuthorization()).toBeTrue();
          throw internalError;
        },
      }),
      orderRecorder: createOrderRecorderDouble(),
      dailyLossTracker: createDailyLossTrackerDouble(),
      isCurrent,
    });

    let caught: unknown = null;
    try {
      await execution;
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(internalError);
  });

  it('records branded non-submit API failures without local liquidation mutations', async () => {
    const authorization = { revision: 1 };
    const capturedRevision = authorization.revision;
    const isCurrent = () => authorization.revision === capturedRevision;
    const monitor = createUnrealizedLossMonitor({
      maxUnrealizedLossPerSymbol: '1000',
    });
    const externalError = await createExternalApiRequestError({
      operation: 'QuoteContext.realtimeQuote',
      attempts: 1,
      cause: new Error('quote timeout'),
    });
    let executionAttempts = 0;
    let clearedBuyOrders = false;
    let refreshedUnrealizedLoss = false;

    const execution = monitor.monitorDirectionalUnrealizedLoss({
      symbol: 'BULL.HK',
      isLong: true,
      seatVersion: 2,
      quote: createQuoteDouble('BULL.HK', '1.1', 100),
      riskChecker: createRiskCheckerDouble({
        checkUnrealizedLoss: () => ({
          shouldLiquidate: true,
          reason: 'loss limit',
          quantity: 100,
        }),
        publishUnrealizedLossData: () => {
          refreshedUnrealizedLoss = true;
        },
      }),
      trader: createTraderDouble({
        executeSignals: async (_signals, callerAuthorization) => {
          expect(callerAuthorization).toBe(isCurrent);
          expect(callerAuthorization()).toBeTrue();
          executionAttempts += 1;
          throw externalError;
        },
      }),
      orderRecorder: createOrderRecorderDouble({
        clearBuyOrders: () => {
          clearedBuyOrders = true;
        },
      }),
      dailyLossTracker: createDailyLossTrackerDouble(),
      isCurrent,
    });

    await execution;
    expect(executionAttempts).toBe(1);
    expect(clearedBuyOrders).toBeFalse();
    expect(refreshedUnrealizedLoss).toBeFalse();
  });

  it('rethrows local cleanup errors after protective liquidation is submitted', async () => {
    const authorization = { revision: 1 };
    const capturedRevision = authorization.revision;
    const isCurrent = () => authorization.revision === capturedRevision;
    const monitor = createUnrealizedLossMonitor({
      maxUnrealizedLossPerSymbol: '1000',
    });
    const cleanupError = new Error('refresh failed after liquidation submitted');
    const riskChecker = createRiskCheckerDouble({
      checkUnrealizedLoss: () => ({ shouldLiquidate: true, reason: 'loss limit', quantity: 100 }),
      prepareUnrealizedLossData: () => {
        throw cleanupError;
      },
    });
    const trader = createTraderDouble({
      executeSignals: async (_signals, callerAuthorization) => {
        expect(callerAuthorization).toBe(isCurrent);
        expect(callerAuthorization()).toBeTrue();
        return { executedOrderIds: ['order-1'] };
      },
    });
    const orderRecorder = createOrderRecorderDouble();
    const dailyLossTracker = createDailyLossTrackerDouble();

    let caught: unknown = null;
    try {
      await monitor.monitorDirectionalUnrealizedLoss({
        symbol: 'BULL.HK',
        isLong: true,
        seatVersion: 2,
        quote: createQuoteDouble('BULL.HK', '1.1', 100),
        riskChecker,
        trader,
        orderRecorder,
        dailyLossTracker,
        isCurrent,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(cleanupError);
  });

  it('rethrows local sync failure after protective liquidation order is submitted remotely', async () => {
    const authorization = { revision: 1 };
    const capturedRevision = authorization.revision;
    const isCurrent = () => authorization.revision === capturedRevision;
    const monitor = createUnrealizedLossMonitor({
      maxUnrealizedLossPerSymbol: '1000',
    });
    const localSyncError = new Error('order monitor track failed');
    const syncFailure = new Error('order submitted but local sync failed: order-1', {
      cause: localSyncError,
    });
    const riskChecker = createRiskCheckerDouble({
      checkUnrealizedLoss: () => ({ shouldLiquidate: true, reason: 'loss limit', quantity: 100 }),
    });
    const trader = createTraderDouble({
      executeSignals: async (_signals, callerAuthorization) => {
        expect(callerAuthorization).toBe(isCurrent);
        expect(callerAuthorization()).toBeTrue();
        throw syncFailure;
      },
    });
    const orderRecorder = createOrderRecorderDouble();
    const dailyLossTracker = createDailyLossTrackerDouble();

    let caught: unknown = null;
    try {
      await monitor.monitorDirectionalUnrealizedLoss({
        symbol: 'BULL.HK',
        isLong: true,
        seatVersion: 2,
        quote: createQuoteDouble('BULL.HK', '1.1', 100),
        riskChecker,
        trader,
        orderRecorder,
        dailyLossTracker,
        isCurrent,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(syncFailure);
  });

  it('keeps a real protective broker ID after authorization expires without clearing buys or publishing risk', async () => {
    const authorization = { revision: 1 };
    const capturedRevision = authorization.revision;
    const isCurrent = () => authorization.revision === capturedRevision;
    let releaseAcknowledgement: () => void = () => {
      throw new Error('Acknowledgement release not initialized');
    };

    let confirmSubmission: () => void = () => {
      throw new Error('Submission observation not initialized');
    };
    const acknowledgement = new Promise<void>((resolve) => {
      releaseAcknowledgement = resolve;
    });
    const submissionStarted = new Promise<void>((resolve) => {
      confirmSubmission = resolve;
    });
    let submitAttempts = 0;
    let clearedBuyOrders = 0;
    let publishedRisk = 0;
    const acknowledgedOrderIds: string[] = [];
    const orderRecorder = createOrderRecorderDouble({
      getCostBasis: () => ({ costAmount: '200', quantity: 100 }),
      clearBuyOrders: () => {
        clearedBuyOrders += 1;
      },
    });
    const unrealizedLossChecker = createUnrealizedLossChecker({
      maxUnrealizedLossPerSymbol: '10',
    });
    unrealizedLossChecker.publish(
      unrealizedLossChecker.prepare(orderRecorder, 'BULL.HK', true, '0'),
    );
    const riskChecker = createRiskChecker({
      warrantRiskChecker: createWarrantCheckerStub(),
      positionLimitChecker: createPositionLimitCheckerStub(),
      unrealizedLossChecker: {
        ...unrealizedLossChecker,
        publish: (prepared) => {
          publishedRisk += 1;
          unrealizedLossChecker.publish(prepared);
        },
      },
    });
    const monitor = createUnrealizedLossMonitor({ maxUnrealizedLossPerSymbol: '10' });
    const execution = monitor.monitorDirectionalUnrealizedLoss({
      symbol: 'BULL.HK',
      isLong: true,
      seatVersion: 2,
      quote: createQuoteDouble('BULL.HK', '1', 100),
      riskChecker,
      orderRecorder,
      dailyLossTracker: createDailyLossTrackerDouble(),
      isCurrent,
      trader: createTraderDouble({
        executeSignals: async (signals, callerAuthorization) => {
          expect(callerAuthorization).toBe(isCurrent);
          expect(callerAuthorization()).toBeTrue();
          submitAttempts += 1;
          expect(signals[0]?.isProtectiveLiquidation).toBeTrue();
          expect(signals[0]?.seatVersion).toBe(2);
          confirmSubmission();
          await acknowledgement;
          expect(callerAuthorization()).toBeFalse();
          acknowledgedOrderIds.push('BROKER-PROTECTIVE-1');
          return { executedOrderIds: ['BROKER-PROTECTIVE-1'] };
        },
      }),
    });
    await submissionStarted;
    authorization.revision += 1;
    releaseAcknowledgement();
    await execution;

    expect(acknowledgedOrderIds).toEqual(['BROKER-PROTECTIVE-1']);
    expect(submitAttempts).toBe(1);
    expect(clearedBuyOrders).toBe(0);
    expect(publishedRisk).toBe(0);
    expect(unrealizedLossChecker.getUnrealizedLossData('BULL.HK')).toEqual({ r1: '200', n1: 100 });
  });

  it('builds unrealized-loss metrics from cached R1/N1 and current price', () => {
    const checker = createRiskChecker({
      warrantRiskChecker: createWarrantCheckerStub(),
      unrealizedLossChecker: createUnrealizedLossCheckerStub({
        getUnrealizedLossData: () => ({
          r1: '1000',
          n1: 100,
        }),
      }),
      positionLimitChecker: createPositionLimitCheckerStub(),
    });

    const metrics = checker.getUnrealizedLossMetrics('BULL.HK', '12');
    expect(metrics).toEqual({
      r1: '1000',
      n1: 100,
      r2: '1200',
      unrealizedPnL: '200',
    });
  });
});
