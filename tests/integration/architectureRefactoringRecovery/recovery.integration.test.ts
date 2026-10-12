/**
 * P0 脱敏 V1 恢复保护网。
 * 真实 repository → loader → DailyLoss/episode/cooldown → rebuild → orderMonitor 恢复；
 * 恢复后的中性累计输入复用同一 recorder/DailyLoss；不宣称未接通的 broker push 自然接线。
 * 仅 broker、quote、clock、显示与隔离文件 IO 为离线边界，不启动 app/交易路由。
 * oracle 为固定手工账：5×10 买入、5×9 卖出亏 5；新分段买 60 卖 40 亏 20。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { createPostTradeConsistencyRuntime } from '../../../src/app/runtime/createPostTradeConsistencyRuntime.js';
import { createLoadTradingDayRuntimeSnapshot } from '../../../src/main/lifecycle/loadTradingDayRuntimeSnapshot.js';
import { createRebuildTradingDayState } from '../../../src/main/lifecycle/rebuildTradingDayState.js';
import { createMixedTradeLogRepository } from '../../../src/services/mixedTradeLogRepository/index.js';
import { createDailyLossTracker } from '../../../src/core/riskController/dailyLossTracker.js';
import { createDailyLossOrderAnalysisDeps } from '../../../src/core/orderRecorder/index.js';
import { resolveOrderOwnership } from '../../../src/domain/order/orderOwnership.js';
import { createProtectiveLiquidationEpisodeTracker } from '../../../src/core/trader/protectiveLiquidationEpisodeTracker/index.js';
import { createLiquidationCooldownTracker } from '../../../src/services/liquidationCooldown/index.js';
import { createTradeLogHydrator } from '../../../src/services/liquidationCooldown/tradeLogHydrator.js';
import { createBrokerIngressFixture } from '../architectureRefactoringP1Native/trade/brokerIngressFixture.js';
import { createAccountPositionSnapshot } from '../../../src/application/accountPositionSnapshot/index.js';
import { withTrustedOrderExecutionTimes } from '../../../src/domain/order/executionFact.js';
import { createOrderHoldRegistry } from '../../../src/core/trader/orderHoldRegistry.js';
import { createSymbolRegistry } from '../../../src/services/autoSymbolManager/utils.js';
import { createWarrantListCache } from '../../../src/services/autoSymbolFinder/utils.js';
import { createSeatActivationDispatcher } from '../../../src/main/seatActivationDispatcher/index.js';
import { createMonitorTaskQueue } from '../../../src/main/asyncProgram/monitorTaskQueue/index.js';
import { createRiskChecker } from '../../../src/core/riskController/index.js';
import { createWarrantRiskChecker } from '../../../src/core/riskController/warrantRiskChecker.js';
import { createPositionLimitChecker } from '../../../src/core/riskController/positionLimitChecker.js';
import { createUnrealizedLossChecker } from '../../../src/core/riskController/unrealizedLossChecker.js';
import { createTradingConfig, createMonitorConfig } from '../../../mock/factories/configFactory.js';
import { toHongKongTimeIso } from '../../../src/utils/time/index.js';
import { buildTradeLogPath } from '../../../src/utils/trading/tradeLogPath.js';
import { logger } from '../../../src/utils/logger/index.js';
import { isRecord } from '../../../src/utils/helpers/index.js';
import type { PostTradeConsistencyRuntime } from '../../../src/app/types.js';
import type { LastState } from '../../../src/types/state.js';
import type { RawOrderFromAPI } from '../../../src/types/services.js';
import type { MonitorTaskDataMap } from '../../../src/main/asyncProgram/monitorTaskProcessor/types.js';
import type { OfflineRecoveryFixture } from './types.js';
import {
  createMarketDataClientDouble,
  createMonitorContextDouble,
  createQuoteDouble,
  createRateLimiterDouble,
  createTerminationDouble,
  createTraderDouble,
} from '../../helpers/testDoubles.js';

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
async function createOpenProtectiveObservation(): Promise<RawOrderFromAPI> {
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
  orders: ReadonlyArray<RawOrderFromAPI> | null = null,
  appendFailure?: Error,
  frozenInput: unknown = frozenOrders,
) {
  const now = new Date(fixture.now);
  const config = createMonitorConfig({
    monitorSymbol: 'HSI.HK',
    longSymbol: 'BULL.HK',
    shortSymbol: 'BEAR.HK',
    orderOwnershipMapping: ['HSI'],
    liquidationTriggerLimit: 1,
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
    ...createDailyLossOrderAnalysisDeps(),
    resolveOrderOwnership,
    toHongKongTimeIso,
  });
  const episode = createProtectiveLiquidationEpisodeTracker();
  const cooldown = createLiquidationCooldownTracker({ nowMs: () => now.getTime() });
  const native = await createRecoveryNative(frozenInput);
  const rateLimiter = createRateLimiterDouble();
  // 只装配 monitor 自身的真实 runtime，不另造独立 settlement store 或人工 refresh nudge。
  let postTrade: PostTradeConsistencyRuntime | null = null;
  const recorder = native.createRecorder({
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
  const market = createMarketDataClientDouble({
    getQuotes: async (symbols) =>
      new Map(
        [...symbols].map((symbol) => [
          symbol,
          createQuoteDouble(symbol, symbol === 'HSI.HK' ? '20000' : '10', 1),
        ]),
      ),
  });
  const monitor = native.createMonitor({
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
  const trader = createTraderDouble({
    orderRecorder: recorder,
    ...native.createAccountService({ rateLimiter }),
    fetchAllOrdersFromAPI: () =>
      orders === null ? recorder.fetchAllOrdersFromAPI() : Promise.resolve(orders),
    initializeOrderMonitor: monitor.initialize,
    seedOrderHoldSymbols: holds.seedFromOrders,
    getOrderHoldSymbols: holds.getHoldSymbols,
    recoverOrderTrackingFromSnapshot: monitor.recoverOrderTrackingFromSnapshot,
    hasPendingProtectiveLiquidationOrders: monitor.hasPendingProtectiveLiquidationOrders,
  });
  const lastState: LastState = {
    canTrade: false,
    isHalfDay: false,
    openProtectionActive: false,
    currentDayKey: fixture.dayKey,
    lifecycleState: 'ACTIVE',
    pendingOpenRebuild: false,
    isTradingEnabled: false,
    cachedTradingDayInfo: null,
    tradingCalendarSnapshot: new Map(),
    allTradingSymbols: new Set(),
  };
  const risk = createRiskChecker({
    warrantRiskChecker: createWarrantRiskChecker(),
    positionLimitChecker: createPositionLimitChecker({ maxPositionNotional: null }),
    unrealizedLossChecker: createUnrealizedLossChecker({ maxUnrealizedLossPerSymbol: null }),
  });
  const context = createMonitorContextDouble({
    config,
    symbolRegistry,
    orderRecorder: recorder,
    dailyLossTracker: daily,
    riskChecker: risk,
  });
  const snapshot = createAccountPositionSnapshot({
    dayEpoch: 1,
    scheduler: { schedule: queueMicrotask },
    readPort: trader,
    reportFatalError: termination.reportFatalError,
  });
  postTrade = createPostTradeConsistencyRuntime({
    termination,
    getTrader: () => trader,
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
    snapshot,
    symbolRegistry,
    monitorTaskQueue: createMonitorTaskQueue<MonitorTaskDataMap>(),
    termination,
  });
  const hydrate = createTradeLogHydrator({
    mixedTradeLogRepository: repository,
    nowMs: () => now.getTime(),
    logger,
    tradingConfig,
    liquidationCooldownTracker: cooldown,
  });
  const load = createLoadTradingDayRuntimeSnapshot({
    snapshot,
    marketDataClient: market,
    trader,
    lastState,
    tradingConfig,
    symbolRegistry,
    dailyLossTracker: daily,
    protectiveLiquidationEpisodeTracker: episode,
    tradeLogHydrator: hydrate,
    mixedTradeLogRepository: repository,
    warrantListCacheConfig: {
      cache: createWarrantListCache(),
      ttlMs: 60_000,
      nowMs: () => now.getTime(),
    },
    seatActivationDispatcher: dispatcher,
    reportFatalError: termination.reportFatalError,
  });
  const rebuild = createRebuildTradingDayState({
    snapshot,
    marketDataClient: market,
    trader,
    lastState,
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

describe('P0 offline V1 full recovery baseline', () => {
  it('completes crash-gap once, preserves original progress bytes, hydrates cooldown and rebuilds tracking', async () => {
    await withOfflineLog(async (root, logFile) => {
      const first = await createOfflineRecovery(root);
      await first.recover();
      expect(first.termination.isTerminated()).toBe(false);
      expect(first.symbolRegistry.getSeatState('LONG').status).toBe('ACTIVE');
      expect(first.episode.getInProgressEpisodes()).toEqual([]);
      expect(first.daily.getLossOffset('LONG')).toBe('0');
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
