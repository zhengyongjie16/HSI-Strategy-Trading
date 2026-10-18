import { createDiagnosticObserverDouble } from '../../helpers/diagnostics.js';
import { createRuntimeStateFixtures } from '../../helpers/runtimeStateFixtures.js';
import {
  createLoggerDouble,
  createAccountSnapshotDouble,
  createMarketDataClientDouble,
  createMonitorConfigDouble,
  createMonitorContextDouble,
  createPositionDouble,
  createQuoteDouble,
  createRiskCheckerDouble,
  createSymbolRegistryDouble,
  createTradeRuntimeDouble,
  createWarrantDistanceInfoDouble,
} from '../../helpers/testDoubles.js';
import { createSeatSwitchWorkflow } from '../../../src/application/seatSwitch/index.js';
import { createStaticLiquidationExecutor } from '../../../src/application/staticLiquidation/index.js';
import { createDefaultMonitorQuoteEventRuntime } from '../../../src/runtime/monitorQuoteEventRuntime/monitorQuoteEventRuntime.js';
import { createSwitchWakeupRuntime } from '../../../src/runtime/monitorQuoteEventRuntime/switchWakeupRuntime.js';
import { createTerminationRuntime } from '../../../src/runtime/lifecycle/terminationRuntime.js';
import { createSnapshotFixture } from '../../helpers/accountPositionSnapshot.js';
import { createSettlementRuntimeFixture } from '../../helpers/settlementRuntime.js';
import {
  createLoggerStub,
  createWarrantCandidate,
  getDefaultAutoSearchConfig,
} from '../../helpers/seatTestUtils.js';

import type { QuoteUpdatedEvent } from '../../../src/types/marketPorts.js';
import type { StartSwitchOnDistanceResult } from '../../../src/types/seatSwitch.js';
import type { RuntimeScheduler } from '../../../src/types/runtime.js';
import type { AccountPositionSnapshot } from '../../../src/types/accountPosition.js';
import type { SymbolRegistry } from '../../../src/types/seat.js';
import type { SettlementReadinessReceipt } from '../../../src/types/settlement.js';
import type {
  SwitchWakeupHandoffParams,
  MonitorQuoteEventRuntime,
  SwitchWakeupRuntime,
} from '../../../src/runtime/monitorQuoteEventRuntime/types.js';

type DistancePublicationFixture = Readonly<{
  monitor: MonitorQuoteEventRuntime;
  receiver: SwitchWakeupRuntime;
  snapshot: AccountPositionSnapshot;
  symbolRegistry: SymbolRegistry;
  originalReceipt: SettlementReadinessReceipt;
  originalDayEpoch: number;
  handoffs: ReadonlyArray<SwitchWakeupHandoffParams>;
  stageReached: Promise<null>;
  releaseStage: () => void;
  getPublication: () => StartSwitchOnDistanceResult | null;
  getCounts: () => Readonly<{
    advanceCalls: number;
    brokerCalls: number;
    retains: number;
    releases: number;
    listeners: number;
  }>;
  emit: (event: QuoteUpdatedEvent) => void;
  stopAndDrain: () => Promise<void>;
}>;

/** Real distance admission/publication + monitor handoff + switch receiver; pauses source stage delivery only. */
export async function createDistanceSwitchPublicationFixture(
  params: Readonly<{
    stage: 'BEFORE_PUBLICATION' | 'AFTER_PUBLICATION';
    now: () => Date;
    scheduler: RuntimeScheduler;
  }>,
): Promise<DistancePublicationFixture> {
  const stageReached = Promise.withResolvers<null>();
  const releaseStage = Promise.withResolvers<null>();
  const listeners = new Set<(event: QuoteUpdatedEvent) => void>();
  const handoffs: SwitchWakeupHandoffParams[] = [];
  let publication: StartSwitchOnDistanceResult | null = null;
  let advanceCalls = 0;
  let brokerCalls = 0;
  let retains = 0;
  let releases = 0;
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
  const config = createMonitorConfigDouble({
    autoSearchConfig: { ...getDefaultAutoSearchConfig(), switchIntervalMinutes: 0 },
  });
  const symbolRegistry = createSymbolRegistryDouble({
    longSeat: {
      symbol: 'BULL.HK',
      status: 'ACTIVE',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: params.now().getTime() - 120_000,
      callPrice: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    },
    shortSeat: {
      symbol: null,
      status: 'EMPTY',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    },
  });
  const marketDataClient = createMarketDataClientDouble({
    onQuoteUpdated: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getQuotes: async (symbols) =>
      new Map([...symbols].map((symbol) => [symbol, createQuoteDouble(symbol, '1')])),
  });
  const tradeRuntime = createTradeRuntimeDouble({
    orderExecutor: {
      executeSignals: async () => {
        brokerCalls += 1;
        throw new Error('Paused distance publication must not submit');
      },
    },
  });
  const riskChecker = createRiskCheckerDouble({
    getWarrantDistanceInfo: () =>
      createWarrantDistanceInfoDouble({
        warrantType: 'BULL',
        distanceNumerator: '0.1',
        distanceDenominator: '100',
      }),
  });
  const base = createMonitorContextDouble({
    orderRecorder: tradeRuntime.orderRecorder,
    config,
    symbolRegistry,
    riskChecker,
  });
  const manager = createSeatSwitchWorkflow({
    readSwitchPositions: async () => [],
    logger: createLoggerStub(),
    monitorConfig: config,
    symbolRegistry,
    marketDataClient,
    cacheManager: tradeRuntime.cacheManager,
    orderHoldRegistry: tradeRuntime.orderHoldRegistry,
    orderMonitor: tradeRuntime.orderMonitor,
    orderExecutor: tradeRuntime.orderExecutor,
    riskChecker,
    orderRecorder: base.orderRecorder,
    clock: { now: params.now },
    getTradingCalendarSnapshot: () =>
      new Map([['2026-02-16', { isTradingDay: true, isHalfDay: false }]]),
    candidateSearch: {
      resolveDistanceRange: (direction) =>
        config.autoSearchConfig[
          direction === 'LONG' ? 'switchDistanceRangeBull' : 'switchDistanceRangeBear'
        ],
      findCandidate: async () => {
        if (params.stage === 'BEFORE_PUBLICATION') {
          stageReached.resolve(null);
          await releaseStage.promise;
        }

        return createWarrantCandidate('NEXT_BULL.HK');
      },
    },
  });
  const monitorContext = {
    ...base,
    seatSwitch: {
      ...manager,
      startSwitchOnDistance: async (...args: Parameters<typeof manager.startSwitchOnDistance>) => {
        const result = await manager.startSwitchOnDistance(...args);
        publication = result;
        if (params.stage === 'AFTER_PUBLICATION') {
          if (!result.started || !result.driveResult.publishedRoute?.isCurrent())
            throw new Error('Expected actual current distance publication');

          stageReached.resolve(null);
          await releaseStage.promise;
        }

        return result;
      },
      advancePendingSwitch: async (...args: Parameters<typeof manager.advancePendingSwitch>) => {
        advanceCalls += 1;
        return manager.advancePendingSwitch(...args);
      },
    },
  };
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
  const settlement = createSettlementRuntimeFixture({
    diagnostics: createDiagnosticObserverDouble(),
    clock: { now: () => new Date() },
    logger: createLoggerDouble(),
    snapshot,
    termination,
    monitorContext,
    getProtectiveOrderReader: () => tradeRuntime.orderMonitor,
    onPositionsCommitted: async (token) => {
      if (!snapshot.isCurrent(token, { account: true, positions: true, paired: true }))
        throw new Error('Stale positions commit');
    },
    scheduler: params.scheduler,
  });
  settlement.start();
  if (!(await settlement.completeRebuildBaseline()))
    throw new Error('Distance switch paired settlement baseline incomplete');

  const originalReceipt = await settlement.waitForFresh();
  const originalDayEpoch = originalReceipt.snapshotToken.dayEpoch;
  const subscription = {
    retainSymbols: async () => {
      retains += 1;
    },
    releaseRetain: async () => {
      releases += 1;
    },
  };
  const receiver = createSwitchWakeupRuntime({
    logger: { error: () => {} },
    marketDataClient,
    orderMonitor: tradeRuntime.orderMonitor,
    symbolRegistry,
    monitorContext,
    ...stateFixtures,
    snapshot,
    postTradeConsistencyRuntime: settlement,
    tradingGateEventRuntime: { onGateStateChanged: () => () => {} },
    quoteSubscriptionRuntime: subscription,
    doomsdayProtectionEnabled: true,
    now: params.now,
    ...params.scheduler,
    termination,
  });
  const monitor = createDefaultMonitorQuoteEventRuntime({
    logger: { error: () => {} },
    executeStaticLiquidation: createStaticLiquidationExecutor({
      orderExecutor: tradeRuntime.orderExecutor,
      marketDataClient,
      snapshot,
      postTradeConsistencyRuntime: settlement,
      now: params.now,
    }),
    marketDataClient,
    monitorContext,
    ...stateFixtures,
    snapshot,
    postTradeConsistencyRuntime: settlement,
    doomsdayProtectionEnabled: true,
    now: params.now,
    ...params.scheduler,
    termination,
    handoffPendingSwitch: (handoff) => {
      handoffs.push(handoff);
      receiver.handoffPendingSwitch(handoff);
    },
  });
  return {
    monitor,
    receiver,
    snapshot,
    symbolRegistry,
    originalReceipt,
    originalDayEpoch,
    handoffs,
    stageReached: stageReached.promise,
    releaseStage: () => {
      releaseStage.resolve(null);
    },
    getPublication: () => publication,
    getCounts: () => ({ advanceCalls, brokerCalls, retains, releases, listeners: listeners.size }),
    emit: (event: QuoteUpdatedEvent) => {
      for (const listener of listeners) listener(event);
    },
    stopAndDrain: async () => {
      releaseStage.resolve(null);
      await monitor.stopAndDrain();
      await receiver.stopAndDrain();
      await settlement.stopAndDrain();
    },
  };
}
