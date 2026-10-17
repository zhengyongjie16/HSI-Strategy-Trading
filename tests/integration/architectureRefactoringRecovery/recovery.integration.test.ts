import { createDiagnosticObserverDouble } from '../../helpers/diagnostics.js';
import type { RuntimeStateFixtures } from '../../helpers/types.js';
import { scheduleBoundedOneShotAt } from '../../../src/runtime/timer/index.js';
import { wrapExternalApiRequest } from '../../../src/infrastructure/externalApi/index.js';
import { wait } from '../../../src/infrastructure/time/index.js';

/**
 * P0 脱敏 V1 恢复保护网。
 * 真实 repository → loader → DailyLoss/episode/cooldown → rebuild → orderMonitor 恢复；
 * 恢复后的中性累计输入复用同一 recorder/DailyLoss；不宣称未接通的 broker push 自然接线。
 * 仅 broker、quote、clock、显示与隔离文件 IO 为离线边界，不启动 app/交易路由。
 * oracle 为固定手工账：5×10 买入、5×9 卖出亏 5；新分段买 60 卖 40 亏 20。
 */

import { afterAll, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMonitorConfig, createTradingConfig } from '../../../mock/factories/configFactory.js';
import { createPostTradeConsistencyRuntime } from '../../../src/app/runtime/createPostTradeConsistencyRuntime.js';
import type { PostTradeConsistencyRuntime } from '../../../src/app/runtime/types.js';
import { createAccountPositionSnapshot } from '../../../src/application/accountPositionSnapshot/index.js';
import { createWarrantCandidateSearch } from '../../../src/application/autoSearch/candidateSearch.js';
import { createStartupSeatSearch } from '../../../src/application/autoSearch/startupSeatSearch.js';
import { createOrderHoldRegistry } from '../../../src/application/orderTracking/orderHoldRegistry.js';
import { createTradeLogHydrator } from '../../../src/application/protectiveLiquidation/tradeLogHydrator.js';
import { createWarrantRiskRefresh } from '../../../src/application/riskRefresh/warrantRiskRefresh.js';
import { createLiquidationCooldownTracker } from '../../../src/domain/liquidation/cooldown/index.js';
import { createProtectiveLiquidationEpisodeTracker } from '../../../src/domain/liquidation/episode/index.js';
import { withTrustedOrderExecutionTimes } from '../../../src/domain/order/executionFact.js';
import { orderAnalysis } from '../../../src/domain/order/orderAnalysis.js';
import { resolveOrderOwnership } from '../../../src/domain/order/orderOwnership.js';
import { createDailyLossTracker } from '../../../src/domain/risk/dailyLossTracker.js';
import { createRiskChecker } from '../../../src/domain/risk/index.js';
import { createPositionLimitChecker } from '../../../src/domain/risk/positionLimitChecker.js';
import { createUnrealizedLossChecker } from '../../../src/domain/risk/unrealizedLossChecker.js';
import { createWarrantRiskChecker } from '../../../src/domain/risk/warrantRiskChecker.js';
import { createSymbolRegistry } from '../../../src/domain/seat/symbolRegistry.js';
import { createMixedTradeLogRepository } from '../../../src/infrastructure/persistence/mixedTradeLogRepository/index.js';
import { createLoadTradingDayRuntimeSnapshot } from '../../../src/application/tradingDayRebuild/loadTradingDayRuntimeSnapshot.js';
import { createRebuildTradingDayState } from '../../../src/application/tradingDayRebuild/rebuildTradingDayState.js';
import type { MonitorTaskDataMap } from '../../../src/runtime/asyncProgram/monitorTaskProcessor/types.js';
import { createMonitorTaskQueue } from '../../../src/runtime/asyncProgram/monitorTaskQueue/index.js';
import { createSeatActivationDispatcher } from '../../../src/runtime/seatActivationDispatcher/index.js';
import type { OrderFact } from '../../../src/types/trade.js';
import { isRecord } from '../../../src/utils/helpers/index.js';
import { logger } from '../../../src/infrastructure/logger/index.js';
import { getTradingMinutesSinceOpen } from '../../../src/domain/tradingSession/index.js';
import { toHongKongTimeIso } from '../../../src/utils/time/index.js';
import { buildTradeLogPath } from '../../../src/infrastructure/persistence/mixedTradeLogRepository/tradeLogPath.js';
import {
  createLoggerDouble,
  createMarketDataClientDouble,
  createMonitorContextDouble,
  createQuoteDouble,
  createRateLimiterDouble,
  createTerminationDouble,
  createTradeRuntimeDouble,
} from '../../helpers/testDoubles.js';
import { createBrokerIngressFixture } from '../architectureRefactoringP1Native/trade/brokerIngressFixture.js';
import type { OfflineRecoveryFixture } from './types.js';

const fixture: Pick<
  OfflineRecoveryFixture,
  'dayKey' | 'now' | 'boundaryMs' | 'revisionMs' | 'oracle'
> & {
  readonly orders: unknown;
} = JSON.parse(fs.readFileSync(new URL('fixtures/recovery.json', import.meta.url), 'utf8'));
const originalCompletion = fs.readFileSync(
  new URL('fixtures/completion.jsonl', import.meta.url),
  'utf8',
);
const originalPayload = fs.readFileSync(
  new URL('fixtures/progress.jsonl', import.meta.url),
  'utf8',
);

/** 冻结 V1 只读：完整恢复目标结束后核对四份原字节。 */
afterAll(() => {
  const expected = new Map([
    ['recovery.json', 'ca85220488925aca477123042ff49c0a09c5a7fa670d856e25acf07301651596'],
    ['progress.jsonl', '7071954b3375ab44a54ea900d1ced1df52de6746209d2292dfc6052e44d77a64'],
    ['completion.jsonl', '97298adcc9c4dbd316030ecf402ab04bfe7292c33cc815172e8edadaaccadf0b'],
    ['earlierConflict.jsonl', '8da9188a6010930727debaf222c58a6ea9411a8e2b1b8bdbd399fa427018c73b'],
  ]);
  for (const [name, hash] of expected) {
    expect(
      createHash('sha256')
        .update(fs.readFileSync(new URL('fixtures/' + name, import.meta.url)))
        .digest('hex'),
    ).toBe(hash);
  }
});

// 原冻结 completion 为 BUY 提供独立 T；SELL 不提供 native execution row，等待原 durable progress。
const trustedBuyTime = 1773367200000;
const frozenOrders: unknown = fixture.orders;
async function createRecoveryNative(orders: unknown = frozenOrders) {
  const native = await createBrokerIngressFixture({
    orderId: 'RECOVERY-SETUP',
    tradeId: 'RECOVERY-SETUP-trade',
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
    submittedAtMs: trustedBuyTime,
    executionTimeMs: null,
    updatedAtMs: trustedBuyTime,
  });
  native.setAccountBalance({
    currency: 'HKD',
    totalCash: '100000',
    netAssets: '100000',
    availableCash: '100000',
  });
  native.setStockPositions([]);
  native.setOrderSnapshotRepliesFromFrozenV1(orders);
  native.setExecutionReplies([
    {
      orderId: 'OFFLINE-BUY',
      tradeId: 'OFFLINE-BUY-frozen-completion',
      symbol: 'BULL.HK',
      quantity: '5',
      price: '10',
      tradeDoneAtMs: trustedBuyTime,
    },
  ]);
  return native;
}
const originalNative = await createRecoveryNative();
const originalRecorder = originalNative.createRecorder({
  logger: createLoggerDouble(),
  rateLimiter: createRateLimiterDouble(),
  getExecutionTimeEvidence: () => [],
  settlementRefreshNeedRecorder: {
    recordSettlementRefreshNeed: () => {
      throw new Error('Initial frozen observation must not commit');
    },
  },
});
const rawOrders = await originalRecorder.fetchAllOrdersFromAPI();

/** protective OPEN 变体从原 mapped SELL 的独立非 SDK 字段复制，经真实 New native frame 再映射。 */
async function createOpenProtectiveObservation(): Promise<OrderFact> {
  const sell = rawOrders.find((order) => order.orderId === 'OFFLINE-SELL');
  if (sell?.price === undefined || sell.price === null)
    throw new Error('Frozen SELL observation lacks submitted price');

  const native = await createBrokerIngressFixture({
    orderId: 'OFFLINE-OPEN',
    tradeId: 'OFFLINE-OPEN-trade',
    symbol: sell.symbol,
    stockName: sell.stockName,
    remark: sell.remark ?? '',
    side: 'SELL',
    status: 'New',
    orderType: 'ELO',
    quantity: String(sell.quantity),
    executedQuantity: '0',
    submittedPrice: sell.price,
    executedPrice: '0',
    submittedAtMs: sell.submittedAt.getTime(),
    executionTimeMs: null,
    updatedAtMs: sell.updatedAtMs,
  });
  native.setExecutionReplies([]);
  const observations = await native.createQueryOrdersReader()();
  const observation = observations[0];
  if (observation === undefined)
    throw new Error('Missing actual native protective OPEN observation');

  return observation;
}

/** 每次重启重建所有真实业务状态；文件只复制到专有临时目录，绝不读取真实日志。 */
async function createOfflineRecovery(
  root: string,
  orders: ReadonlyArray<OrderFact> | null = null,
  appendFailure?: Error,
  frozenInput: unknown = frozenOrders,
  beforeProtectionRecovery?: () => void,
  liquidationTriggerLimit = 1,
) {
  const now = new Date(fixture.now);
  const config = createMonitorConfig({
    monitorSymbol: 'HSI.HK',
    longSymbol: 'BULL.HK',
    shortSymbol: 'BEAR.HK',
    orderOwnershipMapping: ['HSI'],
    liquidationTriggerLimit,
    liquidationCooldown: { mode: 'minutes', minutes: 5 },
  });
  const tradingConfig = createTradingConfig({ monitor: config });
  const symbolRegistry = createSymbolRegistry(config);
  const termination = createTerminationDouble();
  const durableRepository = createMixedTradeLogRepository({ resolveLogRootDir: () => root });
  const repository =
    appendFailure === undefined
      ? durableRepository
      : {
          ...durableRepository,
          appendCompletionIdempotent: () => {
            throw appendFailure;
          },
        };
  const daily = createDailyLossTracker({
    onOwnershipWarning: () => {},
    ...orderAnalysis,
    resolveOrderOwnership,
    toHongKongTimeIso,
  });
  const episode = createProtectiveLiquidationEpisodeTracker();
  const cooldownOwner = createLiquidationCooldownTracker();
  let liveCooldownTriggers = 0;
  const restoredTriggerCounts: number[] = [];
  const cooldown = {
    ...cooldownOwner,
    recordLiquidationTrigger: (
      ...args: Parameters<typeof cooldownOwner.recordLiquidationTrigger>
    ) => {
      liveCooldownTriggers += 1;
      cooldownOwner.recordLiquidationTrigger(...args);
    },
    restoreTriggerCount: (params: Parameters<typeof cooldownOwner.restoreTriggerCount>[0]) => {
      restoredTriggerCounts.push(params.count);
      cooldownOwner.restoreTriggerCount(params);
    },
  };
  const native = await createRecoveryNative(frozenInput);
  const rateLimiter = createRateLimiterDouble();
  // 只装配 monitor 自身的真实 runtime，不另造独立 settlement store 或人工 refresh nudge。
  let postTrade: PostTradeConsistencyRuntime | null = null;
  const recorder = native.createRecorder({
    logger: createLoggerDouble(),
    rateLimiter,
    getExecutionTimeEvidence: daily.getExecutionTimeEvidence,
    settlementRefreshNeedRecorder: {
      recordSettlementRefreshNeed: (need) => {
        if (postTrade === null) throw new Error('post-trade runtime 未完成装配');

        postTrade.recordSettlementRefreshNeed(need);
      },
    },
  });
  const holds = createOrderHoldRegistry();
  let quoteReads = 0;
  const market = createMarketDataClientDouble({
    getQuotes: async (symbols) => {
      quoteReads += 1;
      return new Map(
        [...symbols].map((symbol) => [
          symbol,
          createQuoteDouble(symbol, symbol === 'HSI.HK' ? '20000' : '10', 1),
        ]),
      );
    },
  });
  const monitor = native.createMonitor({
    diagnostics: createDiagnosticObserverDouble(),
    logger: createLoggerDouble(),
    wait: wait,
    requestExternalApi: wrapExternalApiRequest,
    scheduleBoundedOneShotAt: scheduleBoundedOneShotAt,
    rateLimiter,
    marketDataClient: market,
    cacheManager: { clearCache: () => {}, getPendingOrders: async () => [] },
    orderRecorder: recorder,
    dailyLossTracker: daily,
    protectiveLiquidationEpisodeTracker: episode,
    orderHoldRegistry: holds,
    persistProtectiveLiquidationExecutionProgress: repository.appendExecutionProgressIdempotent,
    postTradeConsistencyRuntime: {
      recordSettlementRefreshNeed: (need) => {
        if (postTrade === null) throw new Error('post-trade runtime 未完成装配');

        postTrade.recordSettlementRefreshNeed(need);
      },
    },
    tradingConfig,
    symbolRegistry,
    isContinuousTradingAllowed: () => false,
    termination,
    now: () => now,
    scheduleTimer: setTimeout,
    clearTimer: clearTimeout,
  });
  const tradeRuntime = createTradeRuntimeDouble({
    ...native.createAccountService({ rateLimiter }),
    orderRecorder: {
      fetchAllOrdersFromAPI: () =>
        orders === null ? recorder.fetchAllOrdersFromAPI() : Promise.resolve(orders),
    },
    orderMonitor: {
      initialize: monitor.initialize,
      recoverOrderTrackingFromSnapshot: monitor.recoverOrderTrackingFromSnapshot,
      hasPendingProtectiveLiquidationOrders: monitor.hasPendingProtectiveLiquidationOrders,
    },
    orderHoldRegistry: {
      seedFromOrders: holds.seedFromOrders,
      getHoldSymbols: holds.getHoldSymbols,
    },
  });
  const stateFixtures: RuntimeStateFixtures = {
    tradingTimeState: { canTrade: false, isHalfDay: false, openProtectionActive: false },
    lifecycleState: {
      currentDayKey: fixture.dayKey,
      lifecycleState: 'ACTIVE',
      pendingOpenRebuild: false,
      isTradingEnabled: false,
    },
    tradingCalendarState: { cachedTradingDayInfo: null, tradingCalendarSnapshot: new Map() },
    quoteSubscriptionState: { allTradingSymbols: new Set() },
  };
  const warrantRiskChecker = createWarrantRiskChecker({
    onInvalidCallPrice: () => {},
    onWarrantInfoSet: () => {},
  });
  const risk = createRiskChecker({
    warrantRiskChecker,
    positionLimitChecker: createPositionLimitChecker({ maxPositionNotional: null }),
    unrealizedLossChecker: createUnrealizedLossChecker({
      maxUnrealizedLossPerSymbol: null,
      onMissingData: () => {},
    }),
  });
  const context = createMonitorContextDouble({
    config,
    symbolRegistry,
    orderRecorder: recorder,
    dailyLossTracker: daily,
    riskChecker: risk,
  });
  const snapshot = createAccountPositionSnapshot({
    clock: { now: () => new Date() },
    diagnostics: createDiagnosticObserverDouble(),
    dayEpoch: 1,
    scheduler: { schedule: queueMicrotask },
    readPort: tradeRuntime.accountService,
    reportFatalError: termination.reportFatalError,
  });
  postTrade = createPostTradeConsistencyRuntime({
    diagnostics: createDiagnosticObserverDouble(),
    clock: { now: () => new Date() },
    logger: createLoggerDouble(),
    termination,
    getProtectiveOrderReader: () => tradeRuntime.orderMonitor,
    snapshot,
    onPositionsCommitted: async () => {},
    scheduler: { scheduleTimer: setTimeout, clearTimer: clearTimeout },
  });

  postTrade.bindBusinessDeps({
    monitorContext: context,
    dailyLossTracker: daily,
    liquidationCooldownTracker: cooldown,
    protectiveLiquidationEpisodeTracker: episode,
    mixedTradeLogRepository: repository,
  });
  const dispatcher = createSeatActivationDispatcher({
    logger: createLoggerDouble(),
    snapshot,
    symbolRegistry,
    monitorTaskQueue: createMonitorTaskQueue<MonitorTaskDataMap>({
      logger: createLoggerDouble(),
      clock: { now: () => new Date() },
      diagnostics: createDiagnosticObserverDouble(),
    }),
    termination,
  });
  const hydrate = createTradeLogHydrator({
    mixedTradeLogRepository: repository,
    nowMs: () => now.getTime(),
    logger,
    tradingConfig,
    liquidationCooldownTracker: cooldown,
  });
  let recoveryCalls = 0;
  let hydrationCalls = 0;
  const load = createLoadTradingDayRuntimeSnapshot({
    logger: createLoggerDouble(),
    snapshot,
    marketDataClient: market,
    orderRecorder: tradeRuntime.orderRecorder,
    orderHoldRegistry: tradeRuntime.orderHoldRegistry,
    orderMonitor: tradeRuntime.orderMonitor,
    ...stateFixtures,
    tradingConfig,
    symbolRegistry,
    dailyLossTracker: daily,
    protectiveLiquidationEpisodeTracker: episode,
    tradeLogHydrator: {
      hydrate: () => {
        hydrationCalls += 1;
        hydrate.hydrate();
      },
    },
    mixedTradeLogRepository: repository,
    protectionRecovery: {
      completeProtectionRecovery: (request) => {
        recoveryCalls += 1;
        beforeProtectionRecovery?.();
        return postTrade.completeProtectionRecovery(request);
      },
    },
    startupSeatSearch: createStartupSeatSearch({
      monitorSymbol: tradingConfig.monitor.monitorSymbol,
      symbolRegistry,
      candidateSearch: createWarrantCandidateSearch({
        monitorSymbol: tradingConfig.monitor.monitorSymbol,
        autoSearchConfig: tradingConfig.monitor.autoSearchConfig,
        marketDataClient: market,
        logger,
        getTradingMinutesSinceOpen,
      }),
      logger,
    }),
    seatActivationDispatcher: dispatcher,
    reportFatalError: termination.reportFatalError,
  });
  const rebuild = createRebuildTradingDayState({
    snapshot,
    marketDataClient: market,
    warrantRiskRefresh: createWarrantRiskRefresh({
      marketDataClient: market,
      warrantRiskChecker,
      logger: createLoggerDouble(),
    }),
    orderMonitor: tradeRuntime.orderMonitor,
    ...stateFixtures,
    symbolRegistry,
    monitorContext: context,
    dailyLossTracker: daily,
    termination,
    displayAccountAndPositions: () => {},
  });
  return {
    daily,
    episode,
    cooldown,
    repository,
    symbolRegistry,
    monitor,
    termination,
    recorder,
    snapshot,
    getSubmitCallCount: () =>
      native.nativeMutations().filter((mutation) => mutation.kind === 'SUBMIT').length,
    postTrade,
    getRecoveryProjectionCounts: () => ({ recoveryCalls, hydrationCalls, liveCooldownTriggers }),
    getRestoredTriggerCounts: () => [...restoredTriggerCounts],
    getQuoteReadCount: () => quoteReads,
    load: () =>
      load({
        now,
        requireTradingDay: true,
        resetRuntimeSubscriptions: true,
        hydrateCooldownFromTradeLog: true,
        source: 'STARTUP',
      }),
    recover: async () => {
      const loaded = await load({
        now,
        requireTradingDay: true,
        resetRuntimeSubscriptions: true,
        hydrateCooldownFromTradeLog: true,
        source: 'STARTUP',
      });
      if (loaded.status !== 'COMMITTED')
        throw new Error('Offline recovery paired H publication aborted');

      await rebuild({
        snapshotToken: loaded.snapshotToken,
        allOrders: loaded.allOrders,
        quotesMap: loaded.quotesMap,
        now,
      });
    },
  };
}

/** 拷贝原始 V1 文本；最终删除的仅为本用例创建的隔离目录。 */
async function withOfflineLog(
  run: (root: string, logFile: string) => Promise<void>,
  text = originalPayload,
): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hsi-p0-offline-recovery-'));
  const logFile = buildTradeLogPath(root, new Date(fixture.now));
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  if (text !== '') fs.writeFileSync(logFile, text);

  try {
    await run(root, logFile);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** 等待真实 loader 拒绝，避免 Bun matcher 的 void 类型掩盖异步恢复未完成。 */
async function expectRecoveryBlocked(
  load: () => Promise<unknown>,
  message?: string | RegExp,
): Promise<unknown> {
  let caught: unknown;
  try {
    await load();
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(Error);
  if (message !== undefined && caught instanceof Error) {
    if (typeof message === 'string') expect(caught.message).toContain(message);
    else expect(caught.message).toMatch(message);
  }

  return caught;
}

/** 从冻结 OPEN 行生成独立的离线输入；不修改原 fixture，也不变更 schema/ID/revision。 */
function openProgressWithAmount(amount: string): string {
  const openRecord = originalPayload
    .split('\n')
    .find((line) => line.includes('"factStage":"OPEN"'));
  if (openRecord === undefined) throw new Error('Frozen OPEN progress is missing');

  return openRecord.replace('"cumulativeAmount":"44"', `"cumulativeAmount":"${amount}"`) + '\n';
}

/** 所有不可证明恢复都保持完成、冷却与 ready 未推进，历史文本不变。 */
function expectRecoveryUncommitted(
  state: Awaited<ReturnType<typeof createOfflineRecovery>>,
  logFile: string,
  text: string,
): void {
  expect(state.repository.loadCompletionRecords(fixture.dayKey)).toHaveLength(0);
  expect(state.episode.getInProgressEpisodes()).toEqual([]);
  expect(
    state.cooldown.getRemainingMs({
      direction: 'LONG',
      cooldownConfig: { mode: 'minutes', minutes: 5 },
      currentTimeMs: Date.parse(fixture.now),
    }),
  ).toBe(0);

  expect(state.postTrade.getStatus()).toEqual({
    started: false,
    currentVersion: 0,
    staleVersion: 0,
  });

  expect(state.getRecoveryProjectionCounts()).toEqual({
    recoveryCalls: 0,
    hydrationCalls: 0,
    liveCooldownTriggers: 0,
  });
  expect(state.getQuoteReadCount()).toBe(0);
  expect(state.getSubmitCallCount()).toBe(0);
  expect(fs.readFileSync(logFile, 'utf8')).toBe(text);
}

describe('P2 offline V1 precision evidence boundary', () => {
  it('retains high-significant-digit BUY/SELL amounts across full recovery, exact baseline, later segment and restart', async () => {
    const text = openProgressWithAmount('45.0000000000000001');
    const preciseOrders = rawOrders.map((order) =>
      Object.freeze({
        ...order,
        executedAmount:
          order.executionSide === 'BUY' ? '50.0000000000000002' : '45.0000000000000001',
        executedPrice:
          order.executionSide === 'BUY' ? '10.00000000000000004' : '9.00000000000000002',
      }),
    );
    await withOfflineLog(async (root, logFile) => {
      const first = await createOfflineRecovery(root, preciseOrders);
      await first.recover();
      const completion = first.repository.loadCompletionRecords(fixture.dayKey);
      expect(completion[0]?.orderBaselines).toEqual([
        {
          orderId: 'OFFLINE-BUY',
          symbol: 'BULL.HK',
          side: 'BUY',
          cumulativeQuantity: '5',
          cumulativeAmount: '50.0000000000000002',
          lastExecutionTimeMs: trustedBuyTime,
          orderRevisionMs: trustedBuyTime,
        },
        {
          orderId: 'OFFLINE-SELL',
          symbol: 'BULL.HK',
          side: 'SELL',
          cumulativeQuantity: '5',
          cumulativeAmount: '45.0000000000000001',
          lastExecutionTimeMs: fixture.boundaryMs,
          orderRevisionMs: fixture.revisionMs,
        },
      ]);
      const after = fs.readFileSync(logFile, 'utf8');
      expect(after.startsWith(text)).toBe(true);
      const restarted = await createOfflineRecovery(root, preciseOrders);
      await restarted.recover();
      expect(restarted.repository.loadCompletionRecords(fixture.dayKey)).toEqual(completion);
      expect(fs.readFileSync(logFile, 'utf8')).toBe(after);
      const later = fixture.boundaryMs + 120_000;
      restarted.daily.recordCumulativeExecution({
        factStage: 'TERMINAL',
        orderId: 'OFFLINE-BUY',
        direction: 'LONG',
        symbol: 'BULL.HK',
        side: 'BUY',
        executedQuantity: 10,
        executedPrice: '11.00000000000000003',
        executedTimeMs: later,
        orderUpdatedAtMs: later,
      });

      restarted.daily.recordCumulativeExecution({
        factStage: 'TERMINAL',
        orderId: 'OFFLINE-SELL',
        direction: 'LONG',
        symbol: 'BULL.HK',
        side: 'SELL',
        executedQuantity: 10,
        executedPrice: '8.50000000000000004',
        executedTimeMs: later + 1,
        orderUpdatedAtMs: later + 1,
      });
      // 固定人工账：新段 BUY 60.0000000000000001、SELL 40.0000000000000003。
      expect(restarted.daily.getLossOffset('LONG')).toBe('-19.9999999999999998');
      expect(restarted.getSubmitCallCount()).toBe(0);
      expect(fs.readFileSync(logFile, 'utf8')).toBe(after);
    }, text);
  });

  for (const amount of ['49.9999999999999999', '50.0000000000000001']) {
    it(`rejects a low-bit BUY baseline/API amount conflict at ${amount} without rewriting V1`, async () => {
      const text = originalPayload + originalCompletion;
      const conflictingOrders = rawOrders.map((order) =>
        order.executionSide === 'BUY' ? Object.freeze({ ...order, executedAmount: amount }) : order,
      );
      await withOfflineLog(async (root, logFile) => {
        const state = await createOfflineRecovery(root, conflictingOrders);
        await expectRecoveryBlocked(state.load, 'persisted baseline does not match boundary fact');
        expect(state.repository.loadCompletionRecords(fixture.dayKey)).toHaveLength(1);
        expect(state.episode.getInProgressEpisodes()).toEqual([]);
        expect(
          state.cooldown.getRemainingMs({
            direction: 'LONG',
            cooldownConfig: { mode: 'minutes', minutes: 5 },
            currentTimeMs: Date.parse(fixture.now),
          }),
        ).toBe(0);
        expect(state.postTrade.getStatus().currentVersion).toBe(0);
        expect(state.getSubmitCallCount()).toBe(0);
        expect(fs.readFileSync(logFile, 'utf8')).toBe(text);
      }, text);
    });
  }

  for (const amount of ['44.9999999999999999', '45.0000000000000001']) {
    it(`blocks same-revision OPEN/API TERMINAL amount ${amount} without independent durable evidence`, async () => {
      const text = openProgressWithAmount(amount);
      await withOfflineLog(async (root, logFile) => {
        const state = await createOfflineRecovery(root);
        await expectRecoveryBlocked(state.load, '金额冲突缺少独立 durable 终态证据');
        expectRecoveryUncommitted(state, logFile, text);
      }, text);
    });
  }

  for (const mismatch of [
    'OTHER_ORDER',
    'AMOUNT',
    'SYMBOL',
    'DIRECTION',
    'QUANTITY',
    'REVISION',
    'EXECUTION_TIME',
  ] as const) {
    it(`refuses ${mismatch} durable TERMINAL as independent evidence for a conflicting OPEN/API amount`, async () => {
      const text = openProgressWithAmount('44.9999999999999999');
      await withOfflineLog(async (root, logFile) => {
        const sell = rawOrders.find((order) => order.orderId === 'OFFLINE-SELL');
        if (sell === undefined) throw new Error('Frozen SELL is missing');

        const orders =
          mismatch === 'OTHER_ORDER'
            ? [...rawOrders, Object.freeze({ ...sell, orderId: 'UNRELATED-PROTECTIVE-SELL' })]
            : rawOrders;
        const state = await createOfflineRecovery(root, orders);
        state.repository.appendExecutionProgressIdempotent({
          monitorSymbol: 'HSI.HK',
          direction: mismatch === 'DIRECTION' ? 'SHORT' : 'LONG',
          symbol: mismatch === 'SYMBOL' ? 'OTHER.HK' : 'BULL.HK',
          orderId: mismatch === 'OTHER_ORDER' ? 'UNRELATED-PROTECTIVE-SELL' : 'OFFLINE-SELL',
          factStage: 'TERMINAL',
          cumulativeQuantity: mismatch === 'QUANTITY' ? '4' : '5',
          cumulativeAmount: mismatch === 'AMOUNT' ? '44.9999999999999999' : '45',
          lastExecutionTimeMs: fixture.boundaryMs + (mismatch === 'EXECUTION_TIME' ? 1 : 0),
          orderRevisionMs: fixture.revisionMs + (mismatch === 'REVISION' ? 1 : 0),
        });
        const before = fs.readFileSync(logFile, 'utf8');
        expect(before.startsWith(text)).toBe(true);
        expect(state.repository.loadExecutionProgressRecords(fixture.dayKey)).toHaveLength(2);
        await expectRecoveryBlocked(
          state.load,
          /金额冲突缺少独立 durable 终态证据|与保护性清仓原始订单归属不一致/,
        );
        expectRecoveryUncommitted(state, logFile, before);
      }, text);
    });
  }

  it('accepts the same low-bit OPEN difference only when an independently persisted TERMINAL confirms the exact API payload', async () => {
    const text =
      openProgressWithAmount('44.9999999999999999') +
      originalPayload
        .split('\n')
        .filter((line) => line.includes('"factStage":"TERMINAL"'))
        .join('\n') +
      '\n';
    await withOfflineLog(async (root, logFile) => {
      const state = await createOfflineRecovery(root);
      await state.recover();
      expect(state.daily.getLossOffset('LONG')).toBe('0');
      expect(
        state.repository.loadCompletionRecords(fixture.dayKey)[0]?.orderBaselines,
      ).toContainEqual({
        orderId: 'OFFLINE-SELL',
        symbol: 'BULL.HK',
        side: 'SELL',
        cumulativeQuantity: '5',
        cumulativeAmount: '45',
        lastExecutionTimeMs: fixture.boundaryMs,
        orderRevisionMs: fixture.revisionMs,
      });
      expect(fs.readFileSync(logFile, 'utf8').startsWith(text)).toBe(true);
      expect(state.getSubmitCallCount()).toBe(0);
    }, text);
  });

  it('keeps an exact equal OPEN/API TERMINAL payload recoverable without inventing correction evidence', async () => {
    const text = openProgressWithAmount('45');
    await withOfflineLog(async (root, logFile) => {
      const state = await createOfflineRecovery(root);
      await state.recover();
      expect(state.daily.getLossOffset('LONG')).toBe('0');
      expect(state.repository.loadCompletionRecords(fixture.dayKey)).toHaveLength(1);
      expect(fs.readFileSync(logFile, 'utf8').startsWith(text)).toBe(true);
    }, text);
  });

  it('preserves a higher-revision authoritative amount correction under the existing recovery protocol', async () => {
    const text = openProgressWithAmount('44.9999999999999999');
    const revisedOrders = rawOrders.map((order) =>
      order.orderId === 'OFFLINE-SELL'
        ? Object.freeze({
            ...order,
            updatedAtMs: fixture.revisionMs + 1,
            updatedAt: new Date(fixture.revisionMs + 1),
          })
        : order,
    );
    await withOfflineLog(async (root, logFile) => {
      const state = await createOfflineRecovery(root, revisedOrders);
      await state.recover();
      expect(state.daily.getLossOffset('LONG')).toBe('0');
      expect(
        state.repository.loadCompletionRecords(fixture.dayKey)[0]?.orderBaselines,
      ).toContainEqual({
        orderId: 'OFFLINE-SELL',
        symbol: 'BULL.HK',
        side: 'SELL',
        cumulativeQuantity: '5',
        cumulativeAmount: '45',
        lastExecutionTimeMs: fixture.boundaryMs,
        orderRevisionMs: fixture.revisionMs + 1,
      });
      expect(fs.readFileSync(logFile, 'utf8').startsWith(text)).toBe(true);
      expect(state.getSubmitCallCount()).toBe(0);
    }, text);
  });
});

describe('P2 same-owner loader recovery completion', () => {
  it('restores triggerLimit=2 partial count on real restart and exactly one next completion activates cooldown once', async () => {
    await withOfflineLog(async (root, logFile) => {
      const first = await createOfflineRecovery(root, null, undefined, frozenOrders, undefined, 2);
      await first.recover();
      expect(first.getRestoredTriggerCounts()).toEqual([1]);
      expect(
        first.cooldown.getRemainingMs({
          direction: 'LONG',
          cooldownConfig: { mode: 'minutes', minutes: 5 },
          currentTimeMs: Date.parse(fixture.now),
        }),
      ).toBe(0);
      expect(first.getRecoveryProjectionCounts().liveCooldownTriggers).toBe(0);
      const afterFirst = fs.readFileSync(logFile, 'utf8');
      const restarted = await createOfflineRecovery(
        root,
        null,
        undefined,
        frozenOrders,
        undefined,
        2,
      );
      await restarted.recover();
      expect(restarted.getRestoredTriggerCounts()).toEqual([1]);
      expect(
        restarted.cooldown.getRemainingMs({
          direction: 'LONG',
          cooldownConfig: { mode: 'minutes', minutes: 5 },
          currentTimeMs: Date.parse(fixture.now),
        }),
      ).toBe(0);

      expect(restarted.getRecoveryProjectionCounts()).toEqual({
        recoveryCalls: 1,
        hydrationCalls: 1,
        liveCooldownTriggers: 0,
      });
      expect(fs.readFileSync(logFile, 'utf8')).toBe(afterFirst);

      const nextTimeMs = Date.parse(fixture.now);
      const nextOrderId = 'OFFLINE-NEXT-PROTECTIVE-SELL';
      restarted.daily.recordCumulativeExecution(
        {
          factStage: 'TERMINAL',
          orderId: nextOrderId,
          direction: 'LONG',
          symbol: 'BULL.HK',
          side: 'SELL',
          executedQuantity: 5,
          executedPrice: '9',
          executedTimeMs: nextTimeMs,
          orderUpdatedAtMs: nextTimeMs,
        },
        (progress) => {
          restarted.repository.appendExecutionProgressIdempotent({
            monitorSymbol: 'HSI.HK',
            direction: 'LONG',
            symbol: 'BULL.HK',
            orderId: nextOrderId,
            ...progress,
          });
        },
      );

      restarted.episode.recordProtectiveFillProgress({
        direction: 'LONG',
        symbol: 'BULL.HK',
        executedTimeMs: nextTimeMs,
      });
      restarted.postTrade.start();
      try {
        expect(await restarted.postTrade.completeRebuildBaseline()).toBe(true);
        await restarted.postTrade.waitForFresh();
        expect(restarted.repository.loadCompletionRecords(fixture.dayKey)).toHaveLength(2);
        expect(restarted.episode.getInProgressEpisodes()).toEqual([]);
        expect(restarted.getRecoveryProjectionCounts().liveCooldownTriggers).toBe(1);
        expect(
          restarted.cooldown.getRemainingMs({
            direction: 'LONG',
            cooldownConfig: { mode: 'minutes', minutes: 5 },
            currentTimeMs: nextTimeMs,
          }),
        ).toBe(300_000);
        const afterNext = fs.readFileSync(logFile, 'utf8');
        expect(afterNext.startsWith(afterFirst)).toBe(true);
        expect(await restarted.postTrade.completeRebuildBaseline()).toBe(true);
        expect(restarted.getRecoveryProjectionCounts().liveCooldownTriggers).toBe(1);
        expect(fs.readFileSync(logFile, 'utf8')).toBe(afterNext);
        expect(
          restarted.cooldown.getRemainingMs({
            direction: 'LONG',
            cooldownConfig: { mode: 'minutes', minutes: 5 },
            currentTimeMs: nextTimeMs + 60_000,
          }),
        ).toBe(240_000);
      } finally {
        await restarted.postTrade.stopAndDrain();
      }
    });
  });

  it('restores all LONG/SHORT episodes before one synchronous owner call, then hydrates cooldown once without live triggers', async () => {
    const sell = rawOrders.find((order) => order.orderId === 'OFFLINE-SELL');
    if (sell === undefined) throw new Error('Frozen SELL is missing');

    const shortSell = Object.freeze({
      ...sell,
      orderId: 'OFFLINE-SHORT-SELL',
      symbol: 'BEAR.HK',
      stockName: 'HSI BEAR',
    });
    const text =
      originalPayload +
      originalPayload
        .replaceAll('LONG', 'SHORT')
        .replaceAll('BULL.HK', 'BEAR.HK')
        .replaceAll('OFFLINE-SELL', 'OFFLINE-SHORT-SELL');
    await withOfflineLog(async (root, logFile) => {
      let verifyBeforeOwner: () => void = () => {
        throw new Error('Recovery fixture not assembled');
      };
      const state = await createOfflineRecovery(
        root,
        [...rawOrders, shortSell],
        undefined,
        frozenOrders,
        () => {
          verifyBeforeOwner();
        },
      );
      verifyBeforeOwner = () => {
        expect(state.episode.getInProgressEpisodes()).toEqual([
          { direction: 'LONG', symbol: 'BULL.HK', latestExecutedTimeMs: fixture.boundaryMs },
          { direction: 'SHORT', symbol: 'BEAR.HK', latestExecutedTimeMs: fixture.boundaryMs },
        ]);
        expect(state.repository.loadCompletionRecords(fixture.dayKey)).toHaveLength(0);
        expect(state.getRecoveryProjectionCounts()).toEqual({
          recoveryCalls: 1,
          hydrationCalls: 0,
          liveCooldownTriggers: 0,
        });
      };
      await state.recover();
      expect(
        state.repository
          .loadCompletionRecords(fixture.dayKey)
          .map((record) => record.direction)
          .sort((left, right) => left.localeCompare(right)),
      ).toEqual(['LONG', 'SHORT']);
      expect(state.episode.getInProgressEpisodes()).toEqual([]);
      expect(state.getRecoveryProjectionCounts()).toEqual({
        recoveryCalls: 1,
        hydrationCalls: 1,
        liveCooldownTriggers: 0,
      });
      expect(state.postTrade.getStatus().currentVersion).toBe(0);
      expect(fs.readFileSync(logFile, 'utf8').startsWith(text)).toBe(true);
    }, text);
  });

  for (const invalidation of ['GENERATION', 'DAY_CUT', 'TERMINATION'] as const) {
    it(`owner false on ${invalidation} stops before completion/hydrate/quotes and returns the original invalidation result`, async () => {
      await withOfflineLog(async (root, logFile) => {
        let invalidate: () => void = () => {
          throw new Error('Recovery fixture not assembled');
        };
        const state = await createOfflineRecovery(root, null, undefined, frozenOrders, () => {
          invalidate();
        });
        invalidate = () => {
          if (invalidation === 'GENERATION') state.snapshot.invalidate();
          else if (invalidation === 'DAY_CUT')
            void state.snapshot.requestClear({ reason: 'DAY_CUT', dayEpoch: 2 });
          else state.termination.reportFatalError(new Error('Offline recovery termination'));
        };

        expect(await state.load()).toEqual({
          status: invalidation === 'GENERATION' ? 'SUPERSEDED' : 'ABORTED',
        });
        expect(state.repository.loadCompletionRecords(fixture.dayKey)).toHaveLength(0);
        expect(state.daily.getLossOffset('LONG')).toBe('-5');
        expect(state.episode.getInProgressEpisodes()).toEqual([
          { direction: 'LONG', symbol: 'BULL.HK', latestExecutedTimeMs: fixture.boundaryMs },
        ]);

        expect(state.getRecoveryProjectionCounts()).toEqual({
          recoveryCalls: 1,
          hydrationCalls: 0,
          liveCooldownTriggers: 0,
        });
        expect(state.postTrade.getStatus().currentVersion).toBe(0);
        expect(
          state.cooldown.getRemainingMs({
            direction: 'LONG',
            cooldownConfig: { mode: 'minutes', minutes: 5 },
            currentTimeMs: Date.parse(fixture.now),
          }),
        ).toBe(0);
        expect(fs.readFileSync(logFile, 'utf8')).toBe(originalPayload);
        expect(state.getQuoteReadCount()).toBe(0);
        expect(state.getSubmitCallCount()).toBe(0);
      });
    });
  }
});

describe('P0 offline V1 full recovery baseline', () => {
  it('completes crash-gap once, preserves original progress bytes, hydrates cooldown and rebuilds tracking', async () => {
    await withOfflineLog(async (root, logFile) => {
      const first = await createOfflineRecovery(root);
      await first.recover();
      expect(first.termination.isTerminated()).toBe(false);
      expect(first.symbolRegistry.getSeatState('LONG').status).toBe('ACTIVE');
      expect(first.episode.getInProgressEpisodes()).toEqual([]);
      expect(first.daily.getLossOffset('LONG')).toBe('0');
      expect(first.getRecoveryProjectionCounts()).toEqual({
        recoveryCalls: 1,
        hydrationCalls: 1,
        liveCooldownTriggers: 0,
      });
      const completion = first.repository.loadCompletionRecords(fixture.dayKey);
      expect(completion).toHaveLength(1);
      expect(completion[0]?.boundaryExecutedTimeMs).toBe(fixture.boundaryMs);
      expect(completion[0]?.orderBaselines).toEqual([
        {
          orderId: 'OFFLINE-BUY',
          symbol: 'BULL.HK',
          side: 'BUY',
          cumulativeQuantity: '5',
          cumulativeAmount: '50',
          lastExecutionTimeMs: Date.parse('2026-03-13T02:00:00Z'),
          orderRevisionMs: Date.parse('2026-03-13T02:00:00Z'),
        },
        {
          orderId: 'OFFLINE-SELL',
          symbol: 'BULL.HK',
          side: 'SELL',
          cumulativeQuantity: '5',
          cumulativeAmount: '45',
          lastExecutionTimeMs: fixture.boundaryMs,
          orderRevisionMs: fixture.revisionMs,
        },
      ]);

      expect(
        first.cooldown.getRemainingMs({
          direction: 'LONG',
          cooldownConfig: { mode: 'minutes', minutes: 5 },
          currentTimeMs: Date.parse(fixture.now),
        }),
      ).toBe(fixture.oracle.cooldownRemainingMs);
      const after = fs.readFileSync(logFile, 'utf8');
      expect(after.startsWith(originalPayload)).toBe(true);
      const restarted = await createOfflineRecovery(root);
      await restarted.recover();
      expect(restarted.repository.loadExecutionProgressRecords(fixture.dayKey)).toHaveLength(2);
      expect(restarted.repository.loadCompletionRecords(fixture.dayKey)).toEqual(completion);
      expect(fs.readFileSync(logFile, 'utf8')).toBe(after);
      expect(restarted.daily.getLossOffset('LONG')).toBe('0');
      expect(
        restarted.cooldown.getRemainingMs({
          direction: 'LONG',
          cooldownConfig: { mode: 'minutes', minutes: 5 },
          currentTimeMs: Date.parse(fixture.now),
        }),
      ).toBe(fixture.oracle.cooldownRemainingMs);

      expect(restarted.getRecoveryProjectionCounts()).toEqual({
        recoveryCalls: 1,
        hydrationCalls: 1,
        liveCooldownTriggers: 0,
      });
    });
  });

  it('recovers frozen historical BUY/SELL completion text independently of candidate serialization', async () => {
    const historical = originalPayload + originalCompletion;
    await withOfflineLog(async (root, logFile) => {
      const recovered = await createOfflineRecovery(root);
      await recovered.recover();
      expect(recovered.repository.loadCompletionRecords(fixture.dayKey)).toHaveLength(1);
      expect(recovered.daily.getLossOffset('LONG')).toBe('0');
      expect(recovered.episode.getInProgressEpisodes()).toEqual([]);
      expect(
        recovered.cooldown.getRemainingMs({
          direction: 'LONG',
          cooldownConfig: { mode: 'minutes', minutes: 5 },
          currentTimeMs: Date.parse(fixture.now),
        }),
      ).toBe(fixture.oracle.cooldownRemainingMs);
      expect(fs.readFileSync(logFile, 'utf8')).toBe(historical);
    }, historical);
  });

  it('zero-fill protective open order alone creates no episode or completion', async () => {
    await withOfflineLog(async (root, logFile) => {
      const pending = await createOpenProtectiveObservation();
      const recovered = await createOfflineRecovery(root, [pending]);
      await recovered.recover();
      expect(recovered.monitor.hasPendingProtectiveLiquidationOrders('LONG')).toBe(true);
      expect(recovered.episode.getInProgressEpisodes()).toEqual([]);
      expect(recovered.repository.loadCompletionRecords(fixture.dayKey)).toHaveLength(0);
      expect(recovered.daily.getLossOffset('LONG')).toBe('0');
      expect(fs.existsSync(logFile)).toBe(false);
    }, '');
  });

  it('retains recovered BUY/SELL baseline arithmetic under later neutral cumulative facts without claiming push wiring', async () => {
    await withOfflineLog(async (root) => {
      const first = await createOfflineRecovery(root);
      await first.recover();
      const restarted = await createOfflineRecovery(root);
      await restarted.recover();
      const laterMs = fixture.boundaryMs + 120_000;
      const buy = restarted.daily.recordCumulativeExecution({
        factStage: 'TERMINAL',
        orderId: 'OFFLINE-BUY',
        direction: 'LONG',
        symbol: 'BULL.HK',
        side: 'BUY',
        executedQuantity: 10,
        executedPrice: '11',
        executedTimeMs: laterMs,
        orderUpdatedAtMs: laterMs,
      });
      const sell = restarted.daily.recordCumulativeExecution({
        factStage: 'TERMINAL',
        orderId: 'OFFLINE-SELL',
        direction: 'LONG',
        symbol: 'BULL.HK',
        side: 'SELL',
        executedQuantity: 10,
        executedPrice: '8.5',
        executedTimeMs: laterMs + 1,
        orderUpdatedAtMs: laterMs + 1,
      });
      expect(buy.executionAdvanced).toBe(true);
      expect(sell.executionAdvanced).toBe(true);
      // 人工账：新分段卖 85−45=40、买 110−50=60，亏损 −20。
      expect(restarted.daily.getLossOffset('LONG')).toBe('-20');
    });
  });

  it('keeps progress but refuses crash-gap completion while a zero-fill protective SELL is OPEN', async () => {
    await withOfflineLog(async (root, logFile) => {
      const pending = await createOpenProtectiveObservation();
      const state = await createOfflineRecovery(root, [...rawOrders, pending]);
      await state.recover();
      expect(state.daily.getLossOffset('LONG')).toBe('-5');
      expect(state.episode.getInProgressEpisodes()).toEqual([
        { direction: 'LONG', symbol: 'BULL.HK', latestExecutedTimeMs: fixture.boundaryMs },
      ]);
      expect(state.monitor.hasPendingProtectiveLiquidationOrders('LONG')).toBe(true);
      expect(state.repository.loadCompletionRecords(fixture.dayKey)).toEqual([]);
      expect(fs.readFileSync(logFile, 'utf8')).toBe(originalPayload);
    });
  });

  it('restores durable execution T separately from revision T+30 and consumes the same query fact without progress or submit', async () => {
    await withOfflineLog(async (root, logFile) => {
      const state = await createOfflineRecovery(root);
      await state.recover();
      const before = fs.readFileSync(logFile, 'utf8');
      const progressCount = state.repository.loadExecutionProgressRecords(fixture.dayKey).length;
      const observations = withTrustedOrderExecutionTimes(
        rawOrders,
        state.daily.getExecutionTimeEvidence(),
      );
      const sell = observations.find((order) => order.orderId === 'OFFLINE-SELL');
      expect(sell).toBeDefined();
      if (sell === undefined) throw new Error('offline SELL observation missing');

      expect(sell.executionTimeMs).toBe(fixture.boundaryMs);
      expect(sell.updatedAtMs).toBe(fixture.revisionMs);
      expect(sell.updatedAtMs - fixture.boundaryMs).toBe(30_000);
      const factReceipt = state.recorder.commitExecutionFact(
        {
          brokerOrderId: sell.orderId,
          symbol: sell.symbol,
          side: 'SELL',
          cumulativeQuantity: sell.executedQuantity,
          cumulativeAmount: sell.executedAmount,
          executionTimeMs: sell.executionTimeMs,
          updatedAtMs: sell.updatedAtMs,
          phase: 'TERMINAL',
        },
        true,
        [],
        () =>
          state.daily.recordCumulativeExecution({
            factStage: 'TERMINAL',
            orderId: sell.orderId,
            direction: 'LONG',
            symbol: sell.symbol,
            side: 'SELL',
            executedQuantity: sell.executedQuantity,
            executedPrice: '9',
            executedTimeMs: fixture.boundaryMs,
            orderUpdatedAtMs: sell.updatedAtMs,
          }).admission,
      );
      expect(factReceipt.authoritativeFactChanged).toBe(false);
      expect(factReceipt.economicProjectionChanged).toBe(false);
      const replay = state.daily.recordCumulativeExecution(
        {
          factStage: 'TERMINAL',
          orderId: sell.orderId,
          direction: 'LONG',
          symbol: sell.symbol,
          side: 'SELL',
          // 保留原 P0 9.2/T/revision+1 输入：已完成旧 boundary 的修订仍沿已确认规则不提交。
          executedPrice: '9.2',
          executedQuantity: sell.executedQuantity,
          executedTimeMs: fixture.boundaryMs,
          orderUpdatedAtMs: fixture.revisionMs + 1,
        },
        (prepared) => {
          state.repository.appendExecutionProgressIdempotent({
            monitorSymbol: 'HSI.HK',
            direction: 'LONG',
            symbol: sell.symbol,
            orderId: sell.orderId,
            ...prepared,
          });
        },
      );
      expect(replay).toEqual({
        admission: 'SUPPRESSED',
        authoritativeFactChanged: false,
        executionAdvanced: false,
      });

      expect(state.repository.loadExecutionProgressRecords(fixture.dayKey)).toHaveLength(
        progressCount,
      );
      expect(state.daily.getLossOffset('LONG')).toBe('0');
      expect(state.getSubmitCallCount()).toBe(0);
      expect(state.recorder.getExecutionFact('OFFLINE-SELL')).toMatchObject({
        executionTimeMs: fixture.boundaryMs,
        updatedAtMs: fixture.revisionMs,
        cumulativeAmount: '45',
      });
      expect(fs.readFileSync(logFile, 'utf8')).toBe(before);
      expect(fs.readFileSync(new URL('fixtures/progress.jsonl', import.meta.url), 'utf8')).toBe(
        originalPayload,
      );
    });
  });

  it('full loader rejects an earlier schema-valid conflicting ID even when newer progress recovers alone', async () => {
    await withOfflineLog(async (root) => {
      const original = await createOfflineRecovery(root);
      await original.recover();
    });
    const earlier = fs.readFileSync(
      new URL('fixtures/earlierConflict.jsonl', import.meta.url),
      'utf8',
    );
    const allRecords = earlier + originalPayload;
    await withOfflineLog(async (root, logFile) => {
      const recovered = await createOfflineRecovery(root);
      expect(recovered.repository.loadExecutionProgressRecords(fixture.dayKey)).toHaveLength(3);
      await expectRecoveryBlocked(recovered.load, 'execution progress exceeds current fact');
      expect(recovered.repository.loadCompletionRecords(fixture.dayKey)).toHaveLength(0);
      expect(
        recovered.cooldown.getRemainingMs({
          direction: 'LONG',
          cooldownConfig: { mode: 'minutes', minutes: 5 },
          currentTimeMs: Date.parse(fixture.now),
        }),
      ).toBe(0);
      expect(fs.readFileSync(logFile, 'utf8')).toBe(allRecords);
    }, allRecords);
  });

  it('completion append IO failure blocks boundary/cooldown/episode commit and quote readiness', async () => {
    await withOfflineLog(async (root, logFile) => {
      const failure = new Error('offline completion IO failure');
      const recovered = await createOfflineRecovery(root, rawOrders, failure);
      expect(await expectRecoveryBlocked(recovered.load, failure.message)).toBe(failure);
      expect(recovered.daily.getLossOffset('LONG')).toBe('-5');
      expect(recovered.episode.getInProgressEpisodes()).toEqual([
        { direction: 'LONG', symbol: 'BULL.HK', latestExecutedTimeMs: fixture.boundaryMs },
      ]);
      expect(recovered.repository.loadCompletionRecords(fixture.dayKey)).toHaveLength(0);
      expect(
        recovered.cooldown.getRemainingMs({
          direction: 'LONG',
          cooldownConfig: { mode: 'minutes', minutes: 5 },
          currentTimeMs: Date.parse(fixture.now),
        }),
      ).toBe(0);

      expect(recovered.getRecoveryProjectionCounts()).toEqual({
        recoveryCalls: 1,
        hydrationCalls: 0,
        liveCooldownTriggers: 0,
      });
      expect(recovered.postTrade.getStatus().currentVersion).toBe(0);
      expect(recovered.getQuoteReadCount()).toBe(0);
      expect(fs.readFileSync(logFile, 'utf8')).toBe(originalPayload);
    });
  });

  it('rejects an API amount conflict against frozen baseline without changing any old payload', async () => {
    const historical = originalPayload + originalCompletion;
    if (!Array.isArray(fixture.orders)) throw new Error('Frozen orders must remain an array');

    const originalOrders: ReadonlyArray<unknown> = fixture.orders;
    const conflictingOrders: unknown = originalOrders.map((order) => {
      if (!isRecord(order)) throw new Error('Frozen order must remain an object');

      return order['orderId'] === 'OFFLINE-BUY' ? { ...order, executedPrice: '10.2' } : order;
    });
    await withOfflineLog(async (root, logFile) => {
      const restarted = await createOfflineRecovery(root, null, undefined, conflictingOrders);
      await expectRecoveryBlocked(
        restarted.load,
        /persisted baseline does not match boundary fact: OFFLINE-BUY|同 revision 同量同阶段的累计经济或执行时间冲突/,
      );
      expect(restarted.episode.getInProgressEpisodes()).toEqual([]);
      expect(
        restarted.cooldown.getRemainingMs({
          direction: 'LONG',
          cooldownConfig: { mode: 'minutes', minutes: 5 },
          currentTimeMs: Date.parse(fixture.now),
        }),
      ).toBe(0);
      expect(restarted.getSubmitCallCount()).toBe(0);
      expect(fs.readFileSync(logFile, 'utf8')).toBe(historical);
    }, historical);
  });

  it('rejects protective executed orders missing precise durable evidence, never fabricating execution time from revision', async () => {
    await withOfflineLog(async (root, logFile) => {
      const state = await createOfflineRecovery(root);
      await expectRecoveryBlocked(
        state.load,
        '[DailyLossTracker] 已成交订单缺少可信真实 execution time: OFFLINE-SELL',
      );
      expect(state.episode.getInProgressEpisodes()).toEqual([]);
      expect(
        state.cooldown.getRemainingMs({
          direction: 'LONG',
          cooldownConfig: { mode: 'minutes', minutes: 5 },
          currentTimeMs: Date.parse(fixture.now),
        }),
      ).toBe(0);
      expect(state.getSubmitCallCount()).toBe(0);
      expect(fs.existsSync(logFile)).toBe(false);
    }, '');
  });
});
