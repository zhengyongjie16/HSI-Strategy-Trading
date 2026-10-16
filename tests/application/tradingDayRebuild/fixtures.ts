/**
 * 交易日重建测试夹具：真实 canonical H、S 与订阅 owner，仅控制外部 IO。
 */
import { createSnapshotFixture } from '../../helpers/accountPositionSnapshot.js';
import { createTerminationRuntime } from '../../../src/runtime/lifecycle/terminationRuntime.js';
import { createPostTradeConsistencyRuntime } from '../../../src/app/runtime/createPostTradeConsistencyRuntime.js';
import { createQuoteSubscriptionRuntime } from '../../../src/runtime/quoteSubscriptionRuntime/index.js';
import { createTradingConfig } from '../../../mock/factories/configFactory.js';
import {
  createAccountSnapshotDouble,
  createDailyLossTrackerDouble,
  createLiquidationCooldownTrackerDouble,
  createMonitorContextDouble,
  createProtectiveLiquidationEpisodeTrackerDouble,
  createTradeRuntimeDouble,
  createLoggerDouble,
} from '../../helpers/testDoubles.js';

import type { RebuildHarness } from './types.js';

/** 同一 canonical H、真实 S 签发及真实订阅对账 owner；仅外部 IO 受控。 */
export async function createRebuildHarness(): Promise<RebuildHarness> {
  const snapshot = await createSnapshotFixture({
    account: createAccountSnapshotDouble('100000'),
    positions: [],
  });
  const termination = createTerminationRuntime({
    closeTradingGate: () => {},
    closeProducerAdmission: () => {},
    stopProducers: [],
    onSecondaryError: (error) => {
      throw error;
    },
  });
  const monitorContext = createMonitorContextDouble();
  const tradeRuntime = createTradeRuntimeDouble();
  const subscribed: string[][] = [];
  const quoteSubscriptionRuntime = createQuoteSubscriptionRuntime({
    snapshot,
    termination,

    symbolRegistry: monitorContext.symbolRegistry,
    tradingConfig: createTradingConfig({ monitor: monitorContext.config }),

    orderHoldRegistry: tradeRuntime.orderHoldRegistry,

    quoteSubscriptionState: { allTradingSymbols: new Set() },
    logger: createLoggerDouble(),
    marketDataClient: {
      subscribeSymbols: async (symbols) => {
        subscribed.push([...symbols]);
      },
      unsubscribeSymbols: async () => {},
    },
  });
  const postTradeConsistencyRuntime = createPostTradeConsistencyRuntime({
    logger: createLoggerDouble(),
    snapshot,
    termination,
    getProtectiveOrderReader: () => tradeRuntime.orderMonitor,
    onPositionsCommitted: (token) =>
      quoteSubscriptionRuntime.reconcilePositionHoldFromCurrentTruth(token),
    scheduler: {
      scheduleTimer: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimer: (handle) => {
        clearTimeout(handle);
      },
    },
  });
  postTradeConsistencyRuntime.bindBusinessDeps({
    monitorContext,
    dailyLossTracker: createDailyLossTrackerDouble(),
    liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
    protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
    mixedTradeLogRepository: {
      appendCompletionIdempotent: () => {
        throw new Error('unexpected episode completion');
      },
    },
  });
  return {
    snapshot,
    termination,
    postTradeConsistencyRuntime,
    quoteSubscriptionRuntime,
    subscribed,
  };
}
