import { createDiagnosticObserverDouble } from '../helpers/diagnostics.js';
import type { RuntimeStateFixtures } from '../helpers/types.js';
import { scheduleBoundedOneShotAt } from '../../src/runtime/timer/index.js';
import { wrapExternalApiRequest } from '../../src/infrastructure/externalApi/index.js';
import { nowMonotonicMs, wait } from '../../src/infrastructure/time/index.js';

/** §13.4.1 真实 static→共享执行→订单事实→Daily/episode→settlement；每场景经正式 loader/rebuild/hydration，离线边界仅 IO。 */

import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createMonitorConfig, createTradingConfig } from '../../mock/factories/configFactory.js';
import { createAccountPositionSnapshot } from '../../src/application/accountPositionSnapshot/index.js';
import { createAccountService } from '../../src/application/accountQuery/index.js';
import { createWarrantCandidateSearch } from '../../src/application/autoSearch/candidateSearch.js';
import { createStartupSeatSearch } from '../../src/application/autoSearch/startupSeatSearch.js';
import { createOrderExecutor } from '../../src/application/orderExecution/index.js';
import { createRateLimiter } from '../../src/application/orderExecution/rateLimiter.js';
import { createOrderHoldRegistry } from '../../src/application/orderTracking/orderHoldRegistry.js';
import { createOrderMonitor } from '../../src/application/orderTracking/orderMonitor/index.js';
import { createOrderRecorder } from '../../src/application/orderTracking/recorder/index.js';
import { createPostTradeSettlementWorkflow } from '../../src/application/postTradeSettlement/index.js';
import type { SettlementProtectionCompletion } from '../../src/application/postTradeSettlement/types.js';
import { createTradeLogHydrator } from '../../src/application/protectiveLiquidation/tradeLogHydrator.js';
import { createWarrantRiskRefresh } from '../../src/application/riskRefresh/warrantRiskRefresh.js';
import { createStaticLiquidationExecutor } from '../../src/application/staticLiquidation/index.js';
import { createLiquidationCooldownTracker } from '../../src/domain/liquidation/cooldown/index.js';
import { createProtectiveLiquidationEpisodeTracker } from '../../src/domain/liquidation/episode/index.js';
import { orderAnalysis } from '../../src/domain/order/orderAnalysis.js';
import { orderEconomics } from '../../src/domain/order/orderEconomics.js';
import { createDailyLossTracker } from '../../src/domain/risk/dailyLossTracker.js';
import { createRiskChecker } from '../../src/domain/risk/index.js';
import { createPositionLimitChecker } from '../../src/domain/risk/positionLimitChecker.js';
import { createUnrealizedLossChecker } from '../../src/domain/risk/unrealizedLossChecker.js';
import { createWarrantRiskChecker } from '../../src/domain/risk/warrantRiskChecker.js';
import { createSymbolRegistry } from '../../src/domain/seat/symbolRegistry.js';
import { createMixedTradeLogRepository } from '../../src/infrastructure/persistence/mixedTradeLogRepository/index.js';
import { createLoadTradingDayRuntimeSnapshot } from '../../src/application/tradingDayRebuild/loadTradingDayRuntimeSnapshot.js';
import { createRebuildTradingDayState } from '../../src/application/tradingDayRebuild/rebuildTradingDayState.js';
import type { ProtectiveLiquidationExecutionProgressInput } from '../../src/types/risk.js';
import { exactMultiply } from '../../src/utils/numeric/exact.js';
import { toHongKongTimeIso } from '../../src/utils/time/index.js';
import {
  createLoggerDouble,
  createMarketDataClientDouble,
  createMonitorContextDouble,
  createQuoteDouble,
  createTradeRuntimeDouble,
} from '../helpers/testDoubles.js';
import {
  createBrokerIngressFixture,
  type BrokerIngressInput,
} from '../infrastructure/longbridge/trade/brokerIngressFixture.js';

const T = Date.parse('2026-10-07T02:00:00Z');
const DAY = '2026-10-07';
const ZERO: BrokerIngressInput = {
  orderId: 'OLD-PROTECTIVE',
  tradeId: 'OLD-EXECUTION',
  symbol: 'BULL.HK',
  stockName: 'HSI RC',
  remark: '|PL',
  side: 'SELL',
  status: 'New',
  orderType: 'ELO',
  quantity: '1500',
  executedQuantity: '0',
  submittedPrice: '0.9',
  executedPrice: '0',
  submittedAtMs: T - 1000,
  executionTimeMs: null,
  updatedAtMs: T,
};
const BUY: BrokerIngressInput = {
  ...ZERO,
  orderId: 'BUY-ASSOCIATION',
  tradeId: 'BUY-EXECUTION',
  remark: 'AUTO',
  side: 'BUY',
  status: 'Filled',
  quantity: '2500',
  executedQuantity: '2500',
  submittedPrice: '1',
  executedPrice: '1',
  submittedAtMs: T - 2000,
  executionTimeMs: T - 1500,
  updatedAtMs: T - 1400,
};
const PARTIAL: BrokerIngressInput = {
  ...ZERO,
  status: 'PartialFilled',
  executedQuantity: '500',
  executedPrice: '0.9',
  executionTimeMs: T + 1000,
  updatedAtMs: T + 1010,
};

/** 只表达 broker 执行 ledger 的原始 IO，不直接写 O/Daily 或 episode。 */
function ledger(frame: BrokerIngressInput) {
  if (frame.executionTimeMs === null) throw new Error('ledger requires real execution time');

  return {
    orderId: frame.orderId,
    tradeId: frame.tradeId,
    symbol: frame.symbol,
    quantity: frame.executedQuantity,
    price: frame.executedPrice,
    tradeDoneAtMs: frame.executionTimeMs,
  };
}

/** durable 原始成交来源与独立 broker revision；repository 实际序列化 V1，loader 实际回放。 */
function progressOf(frame: BrokerIngressInput): ProtectiveLiquidationExecutionProgressInput {
  if (frame.executionTimeMs === null) throw new Error('progress requires precise execution time');

  return {
    monitorSymbol: 'HSI.HK',
    direction: 'LONG',
    symbol: frame.symbol,
    orderId: frame.orderId,
    factStage: frame.status === 'PartialFilled' ? 'OPEN' : 'TERMINAL',
    cumulativeQuantity: frame.executedQuantity,
    cumulativeAmount: exactMultiply(frame.executedQuantity, frame.executedPrice),
    lastExecutionTimeMs: frame.executionTimeMs,
    orderRevisionMs: frame.updatedAtMs,
  };
}

/** 入站确认必须等真实 limiter timer 和完整 O fact，不能用固定微任务或空 progress 断言冒充完成。 */
async function waitForFact(
  f: Awaited<ReturnType<typeof createHarness>>,
  frame: BrokerIngressInput,
) {
  const deadline = performance.now() + 2500;
  while (performance.now() < deadline) {
    if (f.fatal.length > 0) throw new Error('ingress fatal', { cause: f.fatal[0] });

    const fact = f.recorder.getExecutionFact(frame.orderId);
    if (
      fact !== null &&
      fact.cumulativeQuantity === Number(frame.executedQuantity) &&
      fact.cumulativeAmount === exactMultiply(frame.executedQuantity, frame.executedPrice) &&
      fact.executionTimeMs === frame.executionTimeMs &&
      fact.updatedAtMs === frame.updatedAtMs &&
      fact.phase === (frame.status === 'PartialFilled' ? 'OPEN' : 'TERMINAL')
    )
      return;

    await delay(5);
  }

  throw new Error('ingress fact timeout: ' + frame.orderId);
}

/** 每次构造隔离文件仓储和真实模块；bootstrap 只调用正式 loader/rebuild，不手工恢复 tracker 或补票。 */
async function createHarness(
  params: {
    readonly initial?: BrokerIngressInput;
    readonly associated?: boolean;
    readonly triggerLimit?: number;
    readonly progress?: ReadonlyArray<BrokerIngressInput>;
    readonly history?: ReadonlyArray<BrokerIngressInput>;
    readonly completion?: SettlementProtectionCompletion;
    readonly logRoot?: string;
  } = {},
) {
  const root = params.logRoot ?? mkdtempSync(path.join(tmpdir(), 'p3f-static-'));
  const initial = params.initial ?? ZERO;
  const history = params.history ?? [];
  const inputOrders = [...(params.associated ? [BUY] : []), ...history, initial];
  const native = await createBrokerIngressFixture(initial, orderEconomics);
  const limiter = createRateLimiter({
    wait: wait,
    nowMonotonicMs: nowMonotonicMs,
    logger: createLoggerDouble(),
  });
  const logger = createLoggerDouble();
  const trace: string[] = [];
  const fatal: unknown[] = [];
  const repositoryOwner = createMixedTradeLogRepository({ resolveLogRootDir: () => root });
  if (params.logRoot === undefined) {
    for (const progress of params.progress ?? (initial.executionTimeMs === null ? [] : [initial]))
      repositoryOwner.appendExecutionProgressIdempotent(progressOf(progress));

    if (params.completion) repositoryOwner.appendCompletionIdempotent(params.completion);
  }

  const repository = {
    ...repositoryOwner,
    appendExecutionProgressIdempotent: (input: ProtectiveLiquidationExecutionProgressInput) => {
      trace.push('progress');
      repositoryOwner.appendExecutionProgressIdempotent(input);
    },
    appendCompletionIdempotent: (input: SettlementProtectionCompletion) => {
      trace.push('completion');
      repositoryOwner.appendCompletionIdempotent(input);
    },
  };
  native.setAccountBalance({
    currency: 'HKD',
    totalCash: '10000',
    netAssets: '10000',
    availableCash: '10000',
  });
  native.setOrderSnapshotReplies([], inputOrders);
  native.setExecutionReplies(inputOrders.filter((frame) => frame.side === 'BUY').map(ledger));
  let clock = T + 1500;
  const setPositions = (quantity: number, availableQuantity: number) => {
    native.setStockPositions(
      quantity === 0
        ? []
        : [
            {
              symbol: 'BULL.HK',
              symbolName: 'HSI RC',
              accountChannel: 'HK',
              currency: 'HKD',
              quantity: String(quantity),
              availableQuantity: String(availableQuantity),
              costPrice: '1',
            },
          ],
    );
  };
  setPositions(2500 - Number(initial.executedQuantity), 1000);
  const config = createMonitorConfig({
    longSymbol: 'BULL.HK',
    shortSymbol: 'BEAR.HK',
    orderOwnershipMapping: ['HSI'],
    liquidationTriggerLimit: params.triggerLimit ?? 1,
    liquidationCooldown: { mode: 'minutes', minutes: 5 },
  });
  const tradingConfig = createTradingConfig({ monitor: config });
  const seats = createSymbolRegistry(config);
  const daily = createDailyLossTracker({
    ...orderAnalysis,
    toHongKongTimeIso,
    onOwnershipWarning: () => {},
  });
  const episodes = createProtectiveLiquidationEpisodeTracker();
  const cooldown = createLiquidationCooldownTracker();
  const termination = {
    isTerminated: () => fatal.length > 0,
    reportFatalError: (error: unknown) => {
      fatal.push(error);
    },
  };
  const account = createAccountService({
    accountReadPort: native.ports.createAccountReadPort(),
    rateLimiter: limiter,
  });
  const snapshot = createAccountPositionSnapshot({
    clock: { now: () => new Date() },
    diagnostics: createDiagnosticObserverDouble(),
    dayEpoch: 1,
    readPort: account,
    scheduler: { schedule: queueMicrotask },
    reportFatalError: termination.reportFatalError,
  });
  let tracking: ReturnType<typeof createOrderMonitor> | null = null;
  const settlement = createPostTradeSettlementWorkflow({
    diagnostics: createDiagnosticObserverDouble(),
    clock: { now: () => new Date() },
    snapshot,
    hasPendingProtectiveOrders: (direction) => {
      if (tracking === null) throw new Error('tracking not assembled');

      return tracking.hasPendingProtectiveLiquidationOrders(direction);
    },
    onPositionsCommitted: async () => {
      trace.push('positions');
    },
    scheduler: { scheduleTimer: setTimeout, clearTimer: clearTimeout },
    termination,
    logger,
    retryDelayMs: 500,
    isExternalFailure: () => false,
  });
  const recorderOwner = createOrderRecorder({
    logger: createLoggerDouble(),
    orderSnapshotReadPort: native.ports.createOrderSnapshotReadPort({
      rateLimiter: limiter,
      executionLedgerPort: native.executionLedgerPort,
    }),
    getExecutionTimeEvidence: daily.getExecutionTimeEvidence,
    settlementRefreshNeedRecorder: settlement,
  });
  const clearCalls: string[] = [];
  const recorder = {
    ...recorderOwner,
    clearBuyOrders: (...args: Parameters<typeof recorderOwner.clearBuyOrders>) => {
      clearCalls.push(args[0]);
      recorderOwner.clearBuyOrders(...args);
    },
  };
  const warrant = createWarrantRiskChecker({
    onInvalidCallPrice: () => {},
    onWarrantInfoSet: () => {},
  });
  const risk = createRiskChecker({
    warrantRiskChecker: warrant,
    positionLimitChecker: createPositionLimitChecker({ maxPositionNotional: null }),
    unrealizedLossChecker: createUnrealizedLossChecker({
      maxUnrealizedLossPerSymbol: null,
      onMissingData: () => {},
    }),
  });
  let quoteReads = 0;
  const market = createMarketDataClientDouble({
    getQuotes: async (symbols) => {
      quoteReads++;
      return new Map(
        [...symbols].map((symbol) => [
          symbol,
          createQuoteDouble(symbol, symbol === 'HSI.HK' ? '20000' : '0.9', 100),
        ]),
      );
    },
    getQuoteContext: async () => ({
      warrantList: async () => [],
      warrantQuote: async (symbols) =>
        [...symbols].map((symbol) => ({ symbol, category: 'BULL', callPrice: '20000' })),
    }),
  });
  const context = createMonitorContextDouble({
    config,
    symbolRegistry: seats,
    orderRecorder: recorder,
    dailyLossTracker: daily,
    riskChecker: risk,
  });
  settlement.bindBusinessDeps({
    monitorSymbol: 'HSI.HK',
    seats,
    episodes: {
      ...episodes,
      commitCompletion: (input) => {
        trace.push('episode');
        episodes.commitCompletion(input);
      },
    },
    completionPersistence: repository,
    lossBoundaries: {
      getLossOffset: daily.getLossOffset,
      prepareProtectionBoundary: daily.prepareProtectionBoundary,
      commitProtectionBoundary: (input) => {
        trace.push('boundary');
        daily.commitProtectionBoundary(input);
      },
    },
    cooldownTriggers: {
      recordLiquidationTrigger: (input) => {
        trace.push('cooldown');
        cooldown.recordLiquidationTrigger({
          ...input,
          triggerLimit: config.liquidationTriggerLimit,
          cooldownConfig: config.liquidationCooldown,
        });
      },
    },
    riskProjection: {
      prepare: (symbol, direction, offset) =>
        risk.prepareUnrealizedLossData(recorder, symbol, direction === 'LONG', offset),
      publish: risk.publishUnrealizedLossData,
    },
  });
  const holds = createOrderHoldRegistry();
  const monitor = createOrderMonitor({
    diagnostics: createDiagnosticObserverDouble(),
    wait: wait,
    requestExternalApi: wrapExternalApiRequest,
    scheduleBoundedOneShotAt: scheduleBoundedOneShotAt,
    logger: createLoggerDouble(),
    orderDetailReadPort: native.ports.createOrderDetailReadPort(),
    orderPushPort: native.ports.createOrderPushPort(),
    executionLedgerPort: native.executionLedgerPort,
    tradeMutationPort: native.ports.createTradeMutationPort(),
    rateLimiter: limiter,
    cacheManager: { clearCache() {}, getPendingOrders: async () => [] },
    marketDataClient: market,
    orderRecorder: recorder,
    dailyLossTracker: daily,
    orderHoldRegistry: holds,
    protectiveLiquidationEpisodeTracker: episodes,
    persistProtectiveLiquidationExecutionProgress: repository.appendExecutionProgressIdempotent,
    postTradeConsistencyRuntime: settlement,
    tradingConfig,
    symbolRegistry: seats,
    isContinuousTradingAllowed: () => false,
    now: () => new Date(clock),
    scheduleTimer: setTimeout,
    clearTimer: clearTimeout,
    termination,
  });
  tracking = monitor;
  const cancelOutcomes: Awaited<ReturnType<typeof monitor.cancelOrder>>[] = [];
  const executor = createOrderExecutor({
    diagnostics: createDiagnosticObserverDouble(),
    logger: createLoggerDouble(),
    readSellPositions: native.ports.createSellPositionReader(),
    tradeMutationPort: native.ports.createTradeMutationPort(),
    rateLimiter: limiter,
    cacheManager: { clearCache() {} },
    orderMonitor: {
      ...monitor,
      cancelOrder: async (...args) => {
        const out = await monitor.cancelOrder(...args);
        cancelOutcomes.push(out);
        return out;
      },
    },
    orderRecorder: recorder,
    unrealizedLossBuyGate: risk,
    tradingConfig,
    symbolRegistry: seats,
    marketDataClient: market,
    isExecutionAllowed: () => fatal.length === 0,
    isContinuousTradingAllowed: () => true,
    now: () => new Date(clock),
    readCurrentTradingDayInfo: () => ({
      dateKey: DAY,
      info: { isTradingDay: true, isHalfDay: false },
    }),
  });
  const tradeRuntime = createTradeRuntimeDouble({
    ...account,
    orderExecutor: { executeSignals: executor.executeSignals },
    orderMonitor: {
      initialize: monitor.initialize,
      recoverOrderTrackingFromSnapshot: monitor.recoverOrderTrackingFromSnapshot,
      hasPendingProtectiveLiquidationOrders: monitor.hasPendingProtectiveLiquidationOrders,
    },
    orderRecorder: { fetchAllOrdersFromAPI: recorder.fetchAllOrdersFromAPI },
    orderHoldRegistry: {
      seedFromOrders: holds.seedFromOrders,
      getHoldSymbols: holds.getHoldSymbols,
    },
  });
  const stateFixtures: RuntimeStateFixtures = {
    tradingTimeState: { canTrade: false, isHalfDay: false, openProtectionActive: false },
    lifecycleState: {
      currentDayKey: DAY,
      lifecycleState: 'ACTIVE',
      pendingOpenRebuild: false,
      isTradingEnabled: false,
    },
    tradingCalendarState: { cachedTradingDayInfo: null, tradingCalendarSnapshot: new Map() },
    quoteSubscriptionState: { allTradingSymbols: new Set() },
  };
  const hydrator = createTradeLogHydrator({
    mixedTradeLogRepository: repository,
    nowMs: () => clock,
    logger,
    tradingConfig,
    liquidationCooldownTracker: cooldown,
  });
  const load = createLoadTradingDayRuntimeSnapshot({
    logger: createLoggerDouble(),
    snapshot,
    marketDataClient: market,
    orderRecorder: tradeRuntime.orderRecorder,
    orderHoldRegistry: tradeRuntime.orderHoldRegistry,
    orderMonitor: tradeRuntime.orderMonitor,
    ...stateFixtures,
    tradingConfig,
    symbolRegistry: seats,
    dailyLossTracker: daily,
    protectiveLiquidationEpisodeTracker: episodes,
    tradeLogHydrator: {
      hydrate: () => {
        trace.push('hydrate');
        hydrator.hydrate();
      },
    },
    mixedTradeLogRepository: repository,
    protectionRecovery: {
      completeProtectionRecovery: (request) => {
        trace.push('recovery');
        return settlement.completeProtectionRecovery(request);
      },
    },
    startupSeatSearch: createStartupSeatSearch({
      monitorSymbol: config.monitorSymbol,
      symbolRegistry: seats,
      candidateSearch: createWarrantCandidateSearch({
        monitorSymbol: config.monitorSymbol,
        autoSearchConfig: config.autoSearchConfig,
        marketDataClient: market,
        logger,
        getTradingMinutesSinceOpen: () => 30,
      }),
      logger,
    }),
    seatActivationDispatcher: { dispatchCurrentActivatingSeats: () => {} },
    reportFatalError: termination.reportFatalError,
  });
  const rebuild = createRebuildTradingDayState({
    snapshot,
    marketDataClient: market,
    orderMonitor: tradeRuntime.orderMonitor,
    ...stateFixtures,
    symbolRegistry: seats,
    monitorContext: context,
    dailyLossTracker: daily,
    termination,
    displayAccountAndPositions: () => {},
    warrantRiskRefresh: createWarrantRiskRefresh({
      marketDataClient: market,
      warrantRiskChecker: warrant,
      logger,
    }),
  });
  const runStatic = createStaticLiquidationExecutor({
    orderExecutor: tradeRuntime.orderExecutor,
    marketDataClient: market,
    snapshot,
    postTradeConsistencyRuntime: settlement,
    now: () => new Date(clock),
  });
  const bootstrap = async () => {
    const loaded = await load({
      now: new Date(clock),
      requireTradingDay: true,
      resetRuntimeSubscriptions: true,
      hydrateCooldownFromTradeLog: true,
      source: 'STARTUP',
    });
    expect(loaded.status).toBe('COMMITTED');
    if (loaded.status !== 'COMMITTED') throw new Error('loader aborted');

    expect(await rebuild({ ...loaded, now: new Date(clock) })).toMatchObject({
      status: 'COMMITTED',
    });
    settlement.start();
    expect(await settlement.completeRebuildBaseline()).toBe(true);
    await settlement.waitForFresh();
    expect(fatal).toEqual([]);
  };

  const settleTerminal = (frame: BrokerIngressInput, available: number) => {
    native.setCancelFailure(Object.assign(new Error('already canceled'), { code: '601012' }));
    native.setOrderDetailReplies([frame]);
    native.setCancelBeforeReply(async () => {
      setPositions(available, available);
    });
    native.setSubmitBehavior(async () => 'NEW-STATIC');
  };
  return {
    native,
    root,
    initial,
    recorder,
    daily,
    episodes,
    cooldown,
    snapshot,
    settlement,
    monitor,
    repository,
    trace,
    clearCalls,
    fatal,
    bootstrap,
    cancelOutcomes,
    settleTerminal,
    setPositions,
    quoteReads: () => quoteReads,
    now: () => clock,
    advance: (value: number) => {
      clock = value;
    },
    execute: () =>
      runStatic({
        monitorContext: context,
        retryAttempts: 0,
        canContinue: () => fatal.length === 0,
      }),
    logText: () => {
      const p = path.join(root, 'trades', DAY + '.jsonl');
      return existsSync(p) ? readFileSync(p, 'utf8') : '';
    },
    close: async (preserveLog = false) => {
      await monitor.stopRuntimeAndDrain();
      await monitor.teardown();
      await settlement.stopAndDrain();
      if (!preserveLog) rmSync(root, { recursive: true, force: true });
    },
  };
}

/** 已接受 static broker order 通过原 callback 与真实 ledger 终态结算；等待事实再断言无保护性污染。 */
async function fillStatic(f: Awaited<ReturnType<typeof createHarness>>, quantity: number) {
  const submitted = f.native.nativeSubmitObservations()[0];
  if (submitted === undefined) throw new Error('static new order not submitted');

  const fill: BrokerIngressInput = {
    ...ZERO,
    orderId: 'NEW-STATIC',
    tradeId: 'NEW-EXECUTION',
    remark: submitted.remark ?? '',
    status: 'Filled',
    quantity: String(quantity),
    executedQuantity: String(quantity),
    executedPrice: '0.9',
    submittedAtMs: T + 2500,
    executionTimeMs: T + 4000,
    updatedAtMs: T + 4010,
  };
  f.advance(T + 5000);
  f.setPositions(0, 0);
  f.native.setExecutionReplies([ledger(fill)]);
  f.native.emitOrderChangedFrame(fill);
  await waitForFact(f, fill);
  await f.settlement.waitForFresh();
  expect(f.fatal).toEqual([]);
}

describe('static purpose isolation with full recovery', () => {
  for (const [name, initial, associated] of [
    ['zero/empty', ZERO, false],
    ['zero/associated', ZERO, true],
    ['partial/empty', PARTIAL, false],
    ['partial/associated', PARTIAL, true],
  ] as const) {
    it(
      name +
        ': recovered ELO identity survives real static cancellation and only old execution completes',
      async () => {
        const f = await createHarness({ initial, associated, triggerLimit: 2 });
        try {
          await f.bootstrap();
          expect(f.trace.filter((entry) => ['recovery', 'hydrate'].includes(entry))).toEqual([
            'recovery',
            'hydrate',
          ]);

          expect(f.monitor.getPendingSellOrders('BULL.HK')).toMatchObject([
            {
              orderId: initial.orderId,
              isProtectiveLiquidation: true,
              executedQuantity: Number(initial.executedQuantity),
            },
          ]);

          expect(f.recorder.getPendingSellSnapshot()[0]?.relatedBuyOrderIds.length === 0).toBe(
            !associated,
          );
          expect(f.repository.loadCompletionRecords(DAY)).toEqual([]);
          if (initial.executedQuantity === '0')
            expect(f.episodes.getInProgressEpisodes()).toEqual([]);
          else
            expect(f.episodes.getInProgressEpisodes()).toEqual([
              { direction: 'LONG', symbol: 'BULL.HK', latestExecutedTimeMs: T + 1000 },
            ]);

          const terminal = {
            ...initial,
            status: 'Canceled' as const,
            executedQuantity: initial.executedQuantity,
            executedPrice: initial.executedPrice,
            updatedAtMs: T + 2000,
          };
          const expectedQuantity = 2500 - Number(initial.executedQuantity);
          f.settleTerminal(terminal, expectedQuantity);
          const firstAttempt = await f.execute();
          if (initial.executedQuantity === '0') {
            expect(firstAttempt).toEqual({ kind: 'COMPLETED' });
          } else {
            // 正成交终态登记 S stale；原 static receipt 失效，只由原 owner 重评估，不在 executor 内换票。
            expect(firstAttempt).toEqual({ kind: 'RE_EVALUATE' });
            expect(f.native.nativeSubmitObservations()).toEqual([]);
            expect(f.clearCalls).toEqual([]);
            await f.settlement.waitForFresh();
            expect(await f.execute()).toEqual({ kind: 'COMPLETED' });
          }

          expect(f.native.nativeCancelOrderIds()).toEqual([initial.orderId]);
          expect(
            f.native.nativeMutations().filter((mutation) => mutation.kind === 'REPLACE'),
          ).toEqual([]);

          expect(f.native.nativeSubmitObservations()).toMatchObject([
            { quantity: String(expectedQuantity), orderType: 'ELO' },
          ]);
          expect(f.native.nativeSubmitObservations()[0]?.remark).not.toEndWith('|PL');
          expect(f.clearCalls).toEqual(['BULL.HK']);
          const oldProgress = f.repository.loadExecutionProgressRecords(DAY);
          if (initial.executedQuantity !== '0')
            expect(
              oldProgress.map(
                ({
                  recordType: _r,
                  schemaVersion: _v,
                  progressId: _i,
                  tradingDayKey: _d,
                  ...fact
                }) => fact,
              ),
            ).toEqual([progressOf(initial), progressOf(terminal)]);

          await fillStatic(f, expectedQuantity);
          expect(f.repository.loadExecutionProgressRecords(DAY)).toEqual(oldProgress);
          expect(f.recorder.getExecutionFact('NEW-STATIC')).toMatchObject({
            phase: 'TERMINAL',
            cumulativeQuantity: expectedQuantity,
            cumulativeAmount: exactMultiply(String(expectedQuantity), '0.9'),
            executionTimeMs: T + 4000,
            updatedAtMs: T + 4010,
          });
          const completions = f.repository.loadCompletionRecords(DAY);
          if (initial.executedQuantity === '0') expect(completions).toEqual([]);
          else {
            expect(completions).toHaveLength(1);
            expect(completions[0]).toMatchObject({
              monitorSymbol: 'HSI.HK',
              direction: 'LONG',
              boundaryExecutedTimeMs: T + 1000,
            });

            expect(completions[0]?.orderBaselines).toEqual([
              ...(associated
                ? [
                    {
                      orderId: BUY.orderId,
                      symbol: BUY.symbol,
                      side: BUY.side,
                      cumulativeQuantity: '2500',
                      cumulativeAmount: '2500',
                      lastExecutionTimeMs: T - 1500,
                      orderRevisionMs: T - 1400,
                    },
                  ]
                : []),
              {
                orderId: initial.orderId,
                symbol: 'BULL.HK',
                side: 'SELL',
                cumulativeQuantity: '500',
                cumulativeAmount: '450',
                lastExecutionTimeMs: T + 1000,
                orderRevisionMs: T + 2000,
              },
            ]);

            expect(
              completions[0]?.orderBaselines.some((baseline) => baseline.orderId === 'NEW-STATIC'),
            ).toBe(false);

            expect(
              f.trace.filter((entry) =>
                ['completion', 'boundary', 'cooldown', 'episode'].includes(entry),
              ),
            ).toEqual(['completion', 'boundary', 'cooldown', 'episode']);
          }

          expect(f.episodes.getInProgressEpisodes()).toEqual([]);
          const after = f.logText();
          await f.settlement.waitForFresh();
          expect(f.logText()).toBe(after);
          expect(
            f.cooldown.getRemainingMs({
              direction: 'LONG',
              cooldownConfig: { mode: 'minutes', minutes: 5 },
              currentTimeMs: T + 5000,
            }),
          ).toBe(0);
        } finally {
          await f.close();
        }
      },
    );
  }

  it('cancel-window partial 500→700 publishes the old fact before re-evaluation and sells only fresh 1800', async () => {
    const f = await createHarness({ initial: PARTIAL });
    try {
      await f.bootstrap();
      const advanced: BrokerIngressInput = {
        ...PARTIAL,
        executedQuantity: '700',
        executionTimeMs: T + 1800,
        updatedAtMs: T + 1810,
      };
      const terminal: BrokerIngressInput = {
        ...advanced,
        status: 'Canceled',
        updatedAtMs: T + 2000,
      };
      f.settleTerminal(terminal, 1800);
      f.native.setCancelBeforeReply(async () => {
        f.advance(T + 1900);
        f.native.setExecutionReplies([ledger(advanced)]);
        f.native.emitOrderChangedFrame(advanced);
        await waitForFact(f, advanced);
        expect(f.repository.loadExecutionProgressRecords(DAY).at(-1)).toMatchObject(
          progressOf(advanced),
        );
        f.setPositions(1800, 1800);
      });
      expect(await f.execute()).toEqual({ kind: 'RE_EVALUATE' });
      expect(f.native.nativeSubmitObservations()).toEqual([]);
      expect(f.clearCalls).toEqual([]);
      expect(f.monitor.getPendingSellOrders('BULL.HK')).toMatchObject([
        { isProtectiveLiquidation: true, executedQuantity: 700 },
      ]);
      await f.settlement.waitForFresh();
      f.advance(T + 2100);
      expect(await f.execute()).toEqual({ kind: 'RE_EVALUATE' });
      await f.settlement.waitForFresh();
      expect(await f.execute()).toEqual({ kind: 'COMPLETED' });
      expect(f.native.nativeSubmitObservations()).toMatchObject([
        { quantity: '1800', orderType: 'ELO' },
      ]);

      expect(f.native.nativeMutations().filter((mutation) => mutation.kind === 'REPLACE')).toEqual(
        [],
      );
      const progress = f.repository.loadExecutionProgressRecords(DAY);
      expect(
        progress.map(
          ({
            factStage,
            cumulativeQuantity,
            cumulativeAmount,
            lastExecutionTimeMs,
            orderRevisionMs,
          }) => ({
            factStage,
            cumulativeQuantity,
            cumulativeAmount,
            lastExecutionTimeMs,
            orderRevisionMs,
          }),
        ),
      ).toEqual([
        {
          factStage: 'OPEN',
          cumulativeQuantity: '500',
          cumulativeAmount: '450',
          lastExecutionTimeMs: T + 1000,
          orderRevisionMs: T + 1010,
        },
        {
          factStage: 'OPEN',
          cumulativeQuantity: '700',
          cumulativeAmount: '630',
          lastExecutionTimeMs: T + 1800,
          orderRevisionMs: T + 1810,
        },
        {
          factStage: 'TERMINAL',
          cumulativeQuantity: '700',
          cumulativeAmount: '630',
          lastExecutionTimeMs: T + 1800,
          orderRevisionMs: T + 2000,
        },
      ]);
      await fillStatic(f, 1800);
      expect(f.repository.loadExecutionProgressRecords(DAY)).toEqual(progress);
      expect(f.repository.loadCompletionRecords(DAY)).toMatchObject([
        {
          boundaryExecutedTimeMs: T + 1800,
          orderBaselines: [
            {
              orderId: 'OLD-PROTECTIVE',
              cumulativeQuantity: '700',
              cumulativeAmount: '630',
              lastExecutionTimeMs: T + 1800,
              orderRevisionMs: T + 2000,
            },
          ],
        },
      ]);

      expect(
        f.cooldown.getRemainingMs({
          direction: 'LONG',
          cooldownConfig: { mode: 'minutes', minutes: 5 },
          currentTimeMs: T + 5000,
        }),
      ).toBe(296800);
    } finally {
      await f.close();
    }
  });

  for (const kind of ['ACK', 'OPEN', 'MISSING_QUANTITY'] as const) {
    it(
      kind + ': no new submit/REPLACE/static clearing and the old order can still advance',
      async () => {
        const f = await createHarness({ associated: true });
        try {
          await f.bootstrap();
          const beforeBuy = f.recorder.getBuyOrdersForSymbol('BULL.HK', true);
          expect(beforeBuy).toHaveLength(1);
          if (kind === 'ACK') f.native.setCancelBeforeReply(async () => {});
          else {
            f.native.setCancelFailure(Object.assign(new Error('closed'), { code: '601012' }));
            f.native.setOrderDetailReplies([
              { ...ZERO, status: kind === 'OPEN' ? 'New' : 'Canceled', updatedAtMs: T + 2000 },
            ]);

            if (kind === 'MISSING_QUANTITY') f.native.setQueryExecutedQuantityMissing();
          }

          if (kind === 'MISSING_QUANTITY') {
            const failure: unknown = await f.execute().then(
              () => null,
              (error: unknown) => error,
            );
            expect(failure).toBeInstanceOf(Error);
          } else expect(await f.execute()).toEqual({ kind: 'NOOP' });

          expect(f.native.nativeCancelOrderIds()).toEqual(['OLD-PROTECTIVE']);
          expect(f.native.nativeReadCounts()).toEqual({
            cancel: 1,
            detail: kind === 'ACK' ? 0 : 1,
          });

          if (kind === 'ACK')
            expect(f.cancelOutcomes).toEqual([
              { kind: 'CANCEL_CONFIRMED', relatedBuyOrderIds: null },
            ]);
          else if (kind === 'OPEN')
            expect(f.cancelOutcomes).toEqual([{ kind: 'UNKNOWN_FAILURE', errorCode: null }]);
          else expect(f.cancelOutcomes).toEqual([]);

          expect(f.native.nativeMutations()).toEqual([]);
          expect(f.clearCalls).toEqual([]);
          expect(f.recorder.getBuyOrdersForSymbol('BULL.HK', true)).toEqual(beforeBuy);
          expect(f.monitor.getPendingSellOrders('BULL.HK')).toMatchObject([
            { orderId: 'OLD-PROTECTIVE', isProtectiveLiquidation: true },
          ]);
          expect(f.repository.loadExecutionProgressRecords(DAY)).toEqual([]);
          const laterPartial = { ...PARTIAL, executionTimeMs: T + 2100, updatedAtMs: T + 2110 };
          f.native.setExecutionReplies([ledger(laterPartial)]);
          f.native.emitOrderChangedFrame(laterPartial);
          await waitForFact(f, laterPartial);
          await f.settlement.waitForFresh();
          expect(f.repository.loadExecutionProgressRecords(DAY)).toMatchObject([
            progressOf(laterPartial),
          ]);
          expect(f.repository.loadCompletionRecords(DAY)).toEqual([]);
          expect(f.episodes.getInProgressEpisodes()).toEqual([
            { direction: 'LONG', symbol: 'BULL.HK', latestExecutedTimeMs: T + 2100 },
          ]);
          const safeTerminal = {
            ...laterPartial,
            status: 'Canceled' as const,
            updatedAtMs: T + 3000,
          };
          f.setPositions(2000, 2000);
          f.native.emitOrderChangedFrame(safeTerminal);
          await waitForFact(f, safeTerminal);
          await f.settlement.waitForFresh();
          expect(f.monitor.getPendingSellOrders('BULL.HK')).toEqual([]);
          expect(f.repository.loadExecutionProgressRecords(DAY)).toMatchObject([
            progressOf(laterPartial),
            progressOf(safeTerminal),
          ]);
          expect(f.repository.loadCompletionRecords(DAY)).toEqual([]);
          f.native.setSubmitBehavior(async () => 'NEW-STATIC');
          expect(await f.execute()).toEqual({ kind: 'COMPLETED' });
          expect(f.native.nativeSubmitObservations()).toMatchObject([{ quantity: '2000' }]);
          expect(f.native.nativeSubmitObservations()[0]?.remark).not.toEndWith('|PL');
          expect(f.fatal).toEqual([]);
        } finally {
          await f.close();
        }
      },
    );
  }

  it('ordinary recovered same-type ELO remains a legal real REPLACE, not a blanket ban', async () => {
    const ordinary: BrokerIngressInput = { ...ZERO, remark: 'AUTO' };
    const f = await createHarness({ initial: ordinary });
    try {
      await f.bootstrap();
      f.native.setReplaceBeforeReply(async () => {});
      expect(await f.execute()).toEqual({ kind: 'COMPLETED' });
      expect(f.native.nativeCancelOrderIds()).toEqual([]);
      expect(f.native.nativeMutations()).toMatchObject([
        { kind: 'REPLACE', orderId: ordinary.orderId, price: '0.9', quantity: '2500' },
      ]);
      expect(f.native.nativeSubmitObservations()).toEqual([]);
      expect(f.monitor.getPendingSellOrders('BULL.HK')).toMatchObject([
        { isProtectiveLiquidation: false, submittedQuantity: 2500 },
      ]);
      expect(f.repository.loadExecutionProgressRecords(DAY)).toEqual([]);
      expect(f.episodes.getInProgressEpisodes()).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it('loader replays prior progress but zero-fill OPEN blocks completion; static flat completes once and full restart hydrates it', async () => {
    const previous: BrokerIngressInput = {
      ...PARTIAL,
      orderId: 'PREVIOUS-PROTECTIVE',
      tradeId: 'PREVIOUS-EXECUTION',
      status: 'Canceled',
    };
    const f = await createHarness({ history: [previous], progress: [previous] });
    let closed = false;
    try {
      await f.bootstrap();
      expect(f.repository.loadCompletionRecords(DAY)).toEqual([]);
      expect(f.episodes.getInProgressEpisodes()).toEqual([
        { direction: 'LONG', symbol: 'BULL.HK', latestExecutedTimeMs: T + 1000 },
      ]);
      expect(f.monitor.hasPendingProtectiveLiquidationOrders('LONG')).toBe(true);
      f.settleTerminal({ ...ZERO, status: 'Canceled', updatedAtMs: T + 2000 }, 2500);
      expect(await f.execute()).toEqual({ kind: 'COMPLETED' });
      await fillStatic(f, 2500);
      const completion = f.repository.loadCompletionRecords(DAY);
      expect(completion).toMatchObject([
        {
          boundaryExecutedTimeMs: T + 1000,
          orderBaselines: [
            {
              orderId: previous.orderId,
              cumulativeQuantity: '500',
              cumulativeAmount: '450',
              lastExecutionTimeMs: T + 1000,
              orderRevisionMs: T + 1010,
            },
          ],
        },
      ]);

      expect(
        f.trace.filter((entry) =>
          ['completion', 'boundary', 'cooldown', 'episode'].includes(entry),
        ),
      ).toEqual(['completion', 'boundary', 'cooldown', 'episode']);
      const text = f.logText();
      await f.close(true);
      closed = true;
      const newFill: BrokerIngressInput = {
        ...ZERO,
        orderId: 'NEW-STATIC',
        tradeId: 'NEW-EXECUTION',
        remark: 'AUTO',
        status: 'Filled',
        quantity: '2500',
        executedQuantity: '2500',
        executedPrice: '0.9',
        submittedAtMs: T + 2500,
        executionTimeMs: T + 4000,
        updatedAtMs: T + 4010,
      };
      const restart = await createHarness({
        logRoot: f.root,
        initial: { ...ZERO, status: 'Canceled', updatedAtMs: T + 2000 },
        history: [previous, newFill],
        progress: [],
      });
      try {
        restart.advance(T + 5000);
        restart.setPositions(0, 0);
        restart.native.setExecutionReplies([ledger(newFill)]);
        await restart.bootstrap();
        expect(restart.logText()).toBe(text);
        expect(restart.repository.loadCompletionRecords(DAY)).toEqual(completion);
        expect(
          restart.trace.filter((entry) =>
            ['completion', 'cooldown', 'recovery', 'hydrate'].includes(entry),
          ),
        ).toEqual(['recovery', 'hydrate']);
        expect(restart.episodes.getInProgressEpisodes()).toEqual([]);
        expect(restart.monitor.hasPendingProtectiveLiquidationOrders('LONG')).toBe(false);
        expect(restart.recorder.getExecutionFact(newFill.orderId)).toMatchObject({
          cumulativeQuantity: 2500,
          cumulativeAmount: '2250',
          executionTimeMs: T + 4000,
          updatedAtMs: T + 4010,
        });

        expect(
          restart.cooldown.getRemainingMs({
            direction: 'LONG',
            cooldownConfig: { mode: 'minutes', minutes: 5 },
            currentTimeMs: restart.now(),
          }),
        ).toBe(296000);
      } finally {
        await restart.close();
      }
    } finally {
      if (!closed) await f.close();
    }
  });

  it('loader rejects missing precise execution evidence before hydration, never using revision as execution time', async () => {
    const f = await createHarness({ initial: { ...PARTIAL, executionTimeMs: null }, progress: [] });
    try {
      const failure: unknown = await f.bootstrap().then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(Error);
      expect(failure).toHaveProperty('message', expect.stringContaining('execution time'));
      expect(f.trace).not.toContain('hydrate');
      expect(f.repository.loadCompletionRecords(DAY)).toEqual([]);
      expect(f.episodes.getInProgressEpisodes()).toEqual([]);
      expect(f.native.nativeMutations()).toEqual([]);
    } finally {
      await f.close();
    }
  });
});
