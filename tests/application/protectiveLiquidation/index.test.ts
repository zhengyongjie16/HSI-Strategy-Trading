import { createRuntimeStateFixtures } from '../../helpers/runtimeStateFixtures.js';

/**
 * ProtectiveLiquidationWorkflow 授权测试
 *
 * 使用真实 snapshot 与 settlement owner，验证风险 prepare 失效不能先写后检，
 * 以及入队 epoch 在 readiness 等待期间失效后不会借用下一交易日授权。
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { createProtectiveLiquidationWorkflow } from '../../../src/application/protectiveLiquidation/index.js';
import { createTerminationRuntime } from '../../../src/runtime/lifecycle/terminationRuntime.js';
import { createSnapshotFixture } from '../../helpers/accountPositionSnapshot.js';
import { createSettlementRuntimeFixture } from '../../helpers/settlementRuntime.js';
import {
  createAccountSnapshotDouble,
  createLoggerDouble,
  createMonitorContextDouble,
  createPositionDouble,
  createQuoteDouble,
  createRiskCheckerDouble,
  createTradeRuntimeDouble,
  createUnrealizedLossMonitorDouble,
} from '../../helpers/testDoubles.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** 测试只隔离风险计算/提交，epoch 与 readiness 由真实 owners 发行。 */
async function createScenario() {
  const trace: string[] = [];
  const snapshot = await createSnapshotFixture({
    account: createAccountSnapshotDouble('100000'),
    positions: [
      createPositionDouble({
        symbol: 'BULL.HK',
        quantity: 100,
        availableQuantity: 100,
        costPrice: '1',
      }),
    ],
  });
  let invalidateDuringPrepare = false;
  const monitorContext = createMonitorContextDouble({
    riskChecker: createRiskCheckerDouble({
      prepareUnrealizedLossData: (_recorder, symbol) => {
        trace.push(`prepare:${symbol}`);
        if (invalidateDuringPrepare) snapshot.invalidate();

        return { symbol, data: { r1: '100.1', n1: 100 } };
      },
      publishUnrealizedLossData: ({ symbol }) => {
        trace.push(`publish:${symbol}`);
      },
    }),
    unrealizedLossMonitor: createUnrealizedLossMonitorDouble({
      monitorDirectionalUnrealizedLoss: async () => {
        trace.push('execute');
        return false;
      },
    }),
  });
  const stateFixtures = createRuntimeStateFixtures({
    tradingTimeState: { canTrade: true, isHalfDay: false },
    lifecycleState: { isTradingEnabled: true },
    tradingCalendarState: {},
    quoteSubscriptionState: {},
  });
  const termination = createTerminationRuntime({
    closeTradingGate: () => {
      stateFixtures.lifecycleState.isTradingEnabled = false;
    },
    closeProducerAdmission: () => {},
    stopProducers: [],
    onSecondaryError: () => {},
  });
  const tradeRuntime = createTradeRuntimeDouble();
  const settlement = createSettlementRuntimeFixture({
    logger: createLoggerDouble(),
    snapshot,
    termination,
    getProtectiveOrderReader: () => tradeRuntime.orderMonitor,
    monitorContext,
    onPositionsCommitted: async (token) => {
      expect(
        snapshot.isCurrent(token, { account: true, positions: true, paired: true }),
      ).toBeTrue();
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
  await settlement.waitForFresh();
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  trace.length = 0;
  cleanups.push(settlement.stopAndDrain);
  return {
    snapshot,
    trace,
    invalidateOnPrepare: () => {
      invalidateDuringPrepare = true;
    },
    deps: {
      logger: createLoggerDouble(),
      snapshot,
      orderExecutor: tradeRuntime.orderExecutor,
      monitorContext,
      symbolRegistry: monitorContext.symbolRegistry,
      ...stateFixtures,
      termination,
      postTradeConsistencyRuntime: settlement,
      doomsdayProtectionEnabled: false,
      now: () => new Date('2026-04-06T01:30:00.000Z'),
    },
  };
}

function createDeferred() {
  let resolve: () => void = () => {
    throw new Error('deferred not initialized');
  };
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createTrigger(workflow: ReturnType<typeof createProtectiveLiquidationWorkflow>) {
  const trigger = workflow.captureTrigger(
    { direction: 'LONG', tradingSymbol: 'BULL.HK', seatVersion: 1 },
    { symbol: 'BULL.HK', quote: createQuoteDouble('BULL.HK', '0.8', 100) },
  );
  if (trigger === null) throw new Error('positive ACTIVE trigger expected');

  return trigger;
}

describe('ProtectiveLiquidationWorkflow', () => {
  it('does not publish prepared risk when the consumed position component becomes invalid', async () => {
    const scenario = await createScenario();
    const workflow = createProtectiveLiquidationWorkflow(scenario.deps);
    const trigger = createTrigger(workflow);
    scenario.invalidateOnPrepare();
    const result = await workflow.execute({
      trigger,
      getLatestTrigger: () => trigger,
      isExecutionActive: () => true,
      onFreshnessBlocked: () => {},
    });
    expect(result).toBe('RETRY_LATEST');
    expect(scenario.trace).toEqual(['prepare:BULL.HK']);
  });

  it('cancels the original trigger when its captured epoch expires during readiness wait', async () => {
    const scenario = await createScenario();
    const enteredWait = createDeferred();
    const releaseReceipt = createDeferred();
    cleanups.unshift(async () => {
      releaseReceipt.resolve();
    });
    const settlement = scenario.deps.postTradeConsistencyRuntime;
    const workflow = createProtectiveLiquidationWorkflow({
      ...scenario.deps,
      postTradeConsistencyRuntime: {
        getStatus: settlement.getStatus,
        isCurrent: settlement.isCurrent,
        waitForFresh: async () => {
          const receipt = await settlement.waitForFresh();
          enteredWait.resolve();
          await releaseReceipt.promise;
          return receipt;
        },
      },
    });
    const trigger = createTrigger(workflow);
    const attempt = workflow.execute({
      trigger,
      getLatestTrigger: () => trigger,
      isExecutionActive: () => true,
      onFreshnessBlocked: () => {},
    });
    await enteredWait.promise;
    await scenario.snapshot.requestClear({ reason: 'DAY_CUT', dayEpoch: trigger.dayEpoch + 1 });
    releaseReceipt.resolve();
    expect(await attempt).toBe('COMPLETE');
    expect(scenario.trace).toEqual([]);
  });
});
