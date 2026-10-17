/**
 * 保护性清仓单方向执行测试
 *
 * 验证 purpose/seat 授权、UNKNOWN 与内部失败穿透、明确外部失败及 accepted 后失效不重提或发布旧风险。
 */
import { createDiagnosticObserverDouble } from '../../helpers/diagnostics.js';
import { afterEach, describe, expect, it } from 'bun:test';
import { createSnapshotFixture } from '../../helpers/accountPositionSnapshot.js';
import { createSettlementRuntimeFixture } from '../../helpers/settlementRuntime.js';
import { createTerminationRuntime } from '../../../src/runtime/lifecycle/terminationRuntime.js';
import { createUnrealizedLossMonitor } from '../../../src/application/protectiveLiquidation/unrealizedLossExecutor.js';
import { createRiskChecker } from '../../../src/domain/risk/index.js';
import { createUnrealizedLossChecker } from '../../../src/domain/risk/unrealizedLossChecker.js';
import { createExternalApiRequestError } from '../../helpers/createExternalApiRequestError.js';
import type { PositionLimitChecker, WarrantRiskChecker } from '../../../src/domain/risk/types.js';
import {
  createAccountSnapshotDouble,
  createDailyLossTrackerDouble,
  createMonitorContextDouble,
  createOrderRecorderDouble,
  createQuoteDouble,
  createRiskCheckerDouble,
  createSymbolRegistryDouble,
  createTradeRuntimeDouble,
  createLoggerDouble,
} from '../../helpers/testDoubles.js';

function createWarrantCheckerStub(): WarrantRiskChecker {
  return {
    setWarrantInfoFromCallPrice: () => ({ status: 'ok', isWarrant: true }),
    publishWarrantInfo: () => {},
    checkRisk: () => ({ allowed: true }),
    checkWarrantDistanceLiquidation: () => ({ shouldLiquidate: false }),
    getWarrantDistanceInfo: () => null,
    clearLongWarrantInfo: () => {},
    clearShortWarrantInfo: () => {},
  };
}

function createPositionLimitCheckerStub(
  overrides: Partial<PositionLimitChecker> = {},
): PositionLimitChecker {
  const base: PositionLimitChecker = {
    checkLimit: () => ({ allowed: true }),
  };
  return { ...base, ...overrides };
}

const settlementCleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of settlementCleanups.splice(0)) await cleanup();
});

describe('protective liquidation executor', () => {
  it('rethrows submitOrder API failure during protective liquidation', async () => {
    const authorization = { revision: 1 };
    const capturedRevision = authorization.revision;
    const isCurrent = () => authorization.revision === capturedRevision;
    const monitor = createUnrealizedLossMonitor({
      logger: createLoggerDouble(),
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
    const tradeRuntime = createTradeRuntimeDouble({
      orderExecutor: {
        executeSignals: async (_signals, callerAuthorization) => {
          expect(callerAuthorization).toBe(isCurrent);
          expect(callerAuthorization()).toBeTrue();
          throw submitError;
        },
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
        orderExecutor: tradeRuntime.orderExecutor,
        orderRecorder,
        dailyLossTracker,
        isCurrent,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(submitError);
  });

  it('rethrows internal tradeRuntime execution errors during protective liquidation', async () => {
    const authorization = { revision: 1 };
    const capturedRevision = authorization.revision;
    const isCurrent = () => authorization.revision === capturedRevision;
    const monitor = createUnrealizedLossMonitor({
      logger: createLoggerDouble(),
      maxUnrealizedLossPerSymbol: '1000',
    });
    const internalError = new TypeError('tradeRuntime execution invariant broken');

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
      ...createTradeRuntimeDouble({
        orderExecutor: {
          executeSignals: async (_signals, callerAuthorization) => {
            expect(callerAuthorization).toBe(isCurrent);
            expect(callerAuthorization()).toBeTrue();
            throw internalError;
          },
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
      logger: createLoggerDouble(),
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
      ...createTradeRuntimeDouble({
        orderExecutor: {
          executeSignals: async (_signals, callerAuthorization) => {
            expect(callerAuthorization).toBe(isCurrent);
            expect(callerAuthorization()).toBeTrue();
            executionAttempts += 1;
            throw externalError;
          },
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
      logger: createLoggerDouble(),
      maxUnrealizedLossPerSymbol: '1000',
    });
    const cleanupError = new Error('refresh failed after liquidation submitted');
    const riskChecker = createRiskCheckerDouble({
      checkUnrealizedLoss: () => ({ shouldLiquidate: true, reason: 'loss limit', quantity: 100 }),
      prepareUnrealizedLossData: () => {
        throw cleanupError;
      },
    });
    const tradeRuntime = createTradeRuntimeDouble({
      orderExecutor: {
        executeSignals: async (_signals, callerAuthorization) => {
          expect(callerAuthorization).toBe(isCurrent);
          expect(callerAuthorization()).toBeTrue();
          return { executedOrderIds: ['order-1'], quoteFailures: [] };
        },
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
        orderExecutor: tradeRuntime.orderExecutor,
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
      logger: createLoggerDouble(),
      maxUnrealizedLossPerSymbol: '1000',
    });
    const localSyncError = new Error('order monitor track failed');
    const syncFailure = new Error('order submitted but local sync failed: order-1', {
      cause: localSyncError,
    });
    const riskChecker = createRiskCheckerDouble({
      checkUnrealizedLoss: () => ({ shouldLiquidate: true, reason: 'loss limit', quantity: 100 }),
    });
    const tradeRuntime = createTradeRuntimeDouble({
      orderExecutor: {
        executeSignals: async (_signals, callerAuthorization) => {
          expect(callerAuthorization).toBe(isCurrent);
          expect(callerAuthorization()).toBeTrue();
          throw syncFailure;
        },
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
        orderExecutor: tradeRuntime.orderExecutor,
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
      onMissingData: () => {},
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
    const monitor = createUnrealizedLossMonitor({
      logger: createLoggerDouble(),
      maxUnrealizedLossPerSymbol: '10',
    });
    const execution = monitor.monitorDirectionalUnrealizedLoss({
      symbol: 'BULL.HK',
      isLong: true,
      seatVersion: 2,
      quote: createQuoteDouble('BULL.HK', '1', 100),
      riskChecker,

      dailyLossTracker: createDailyLossTrackerDouble(),
      isCurrent,
      ...createTradeRuntimeDouble({
        orderExecutor: {
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
            return { executedOrderIds: ['BROKER-PROTECTIVE-1'], quoteFailures: [] };
          },
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
});

describe('unrealizedLossMonitor directional execution', () => {
  it('writes seatVersion into the liquidation signal', async () => {
    const executedSignals: Array<{ readonly seatVersion: number | null; readonly action: string }> =
      [];
    const tradeRuntime = createTradeRuntimeDouble({
      orderExecutor: {
        executeSignals: async (signals, callerAuthorization) => {
          expect(callerAuthorization()).toBe(true);
          for (const signal of signals) {
            executedSignals.push({
              seatVersion: signal.seatVersion,
              action: signal.action,
            });
          }

          return { executedOrderIds: signals.map(() => `EXECUTED-ORDER`), quoteFailures: [] };
        },
      },
    });
    const riskChecker = createRiskCheckerDouble({
      checkUnrealizedLoss: () => ({
        shouldLiquidate: true,
        reason: 'test-liquidation',
        quantity: 1,
      }),
    });
    const monitor = createUnrealizedLossMonitor({
      logger: createLoggerDouble(),
      maxUnrealizedLossPerSymbol: '1',
    });

    const symbolRegistry = createSymbolRegistryDouble({ longVersion: 7 });
    const context = createMonitorContextDouble({
      orderRecorder: tradeRuntime.orderRecorder,
      symbolRegistry,
      riskChecker,
    });
    const snapshot = await createSnapshotFixture({
      account: createAccountSnapshotDouble('100000'),
      positions: [],
    });
    const termination = createTerminationRuntime({
      closeTradingGate: () => {},
      closeProducerAdmission: () => {},
      stopProducers: [],
      onSecondaryError: () => {},
    });
    const settlement = createSettlementRuntimeFixture({
      diagnostics: createDiagnosticObserverDouble(),
      clock: { now: () => new Date() },
      logger: createLoggerDouble(),
      snapshot,
      termination,
      monitorContext: context,
      getProtectiveOrderReader: () => tradeRuntime.orderMonitor,
      onPositionsCommitted: async (token) => {
        expect(token).toBe(snapshot.getView().token);
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
    const capturedReceipt = await settlement.waitForFresh();
    const capturedSeatVersion = symbolRegistry.getSeatVersion('LONG');
    const isCurrent = () =>
      !termination.isTerminated() &&
      settlement.isCurrent(capturedReceipt) &&
      snapshot.isCurrent(capturedReceipt.snapshotToken, { account: false, positions: true }) &&
      symbolRegistry.getSeatVersion('LONG') === capturedSeatVersion;
    settlementCleanups.push(settlement.stopAndDrain);

    await monitor.monitorDirectionalUnrealizedLoss({
      isCurrent,
      symbol: 'BULL.HK',
      isLong: true,
      seatVersion: 7,
      quote: createQuoteDouble('BULL.HK', '1.23', 100),
      riskChecker,
      orderExecutor: tradeRuntime.orderExecutor,
      orderRecorder: createOrderRecorderDouble(),
      dailyLossTracker: createDailyLossTrackerDouble(),
    });

    expect(executedSignals).toEqual([
      {
        seatVersion: 7,
        action: 'SELLCALL',
      },
    ]);
  });
});
