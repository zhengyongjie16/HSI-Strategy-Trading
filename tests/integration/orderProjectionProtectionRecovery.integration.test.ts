/**
 * F01/F02 全链路保护网：真实交易装配、启动恢复、Monitor 成交和 settlement durable 完成。
 * broker/行情仅使用离线边界；跨重启只传递 JSONL 与 broker 输入，不共享任何业务 owner。
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMonitorConfig, createTradingConfig } from '../../mock/factories/configFactory.js';
import { createPostTradeConsistencyRuntime } from '../../src/app/runtime/createPostTradeConsistencyRuntime.js';
import type { TradeRuntime } from '../../src/app/runtime/types.js';
import { createAccountPositionSnapshot } from '../../src/application/accountPositionSnapshot/index.js';
import { createWarrantCandidateSearch } from '../../src/application/autoSearch/candidateSearch.js';
import { createStartupSeatSearch } from '../../src/application/autoSearch/startupSeatSearch.js';
import { resolveSellQuantityBySmartClose } from '../../src/application/ordinarySell/quantitySelection.js';
import { createTradeLogHydrator } from '../../src/application/protectiveLiquidation/tradeLogHydrator.js';
import { createWarrantRiskRefresh } from '../../src/application/riskRefresh/warrantRiskRefresh.js';
import { createSeatActivationWorkflow } from '../../src/application/seatActivation/index.js';
import { createLoadTradingDayRuntimeSnapshot } from '../../src/application/tradingDayRebuild/loadTradingDayRuntimeSnapshot.js';
import { createRebuildTradingDayState } from '../../src/application/tradingDayRebuild/rebuildTradingDayState.js';
import { createLiquidationCooldownTracker } from '../../src/domain/liquidation/cooldown/index.js';
import { createProtectiveLiquidationEpisodeTracker } from '../../src/domain/liquidation/episode/index.js';
import { orderAnalysis } from '../../src/domain/order/orderAnalysis.js';
import { resolveOrderOwnership } from '../../src/domain/order/orderOwnership.js';
import { buildOrderRemark } from '../../src/domain/order/orderRemark.js';
import { createDailyLossTracker } from '../../src/domain/risk/dailyLossTracker.js';
import { createRiskChecker } from '../../src/domain/risk/index.js';
import { createPositionLimitChecker } from '../../src/domain/risk/positionLimitChecker.js';
import { createUnrealizedLossChecker } from '../../src/domain/risk/unrealizedLossChecker.js';
import { createWarrantRiskChecker } from '../../src/domain/risk/warrantRiskChecker.js';
import { createSymbolRegistry } from '../../src/domain/seat/symbolRegistry.js';
import { getTradingMinutesSinceOpen } from '../../src/domain/tradingSession/index.js';
import { wrapExternalApiRequest } from '../../src/infrastructure/externalApi/index.js';
import { createMixedTradeLogRepository } from '../../src/infrastructure/persistence/mixedTradeLogRepository/index.js';
import { nowMonotonicMs, wait } from '../../src/infrastructure/time/index.js';
import type { MonitorTaskDataMap } from '../../src/runtime/asyncProgram/monitorTaskProcessor/types.js';
import { createMonitorTaskQueue } from '../../src/runtime/asyncProgram/monitorTaskQueue/index.js';
import { createTerminationRuntime } from '../../src/runtime/lifecycle/terminationRuntime.js';
import { createQuoteSubscriptionRuntime } from '../../src/runtime/quoteSubscriptionRuntime/index.js';
import { createSeatActivationDispatcher } from '../../src/runtime/seatActivationDispatcher/index.js';
import { scheduleBoundedOneShotAt } from '../../src/runtime/timer/index.js';
import { getHKDateKey, toHongKongTimeIso } from '../../src/utils/time/index.js';
import { createDiagnosticObserverDouble } from '../helpers/diagnostics.js';
import {
  createLoggerDouble,
  createMarketDataClientDouble,
  createQuoteDouble,
} from '../helpers/testDoubles.js';
import type { RuntimeStateFixtures } from '../helpers/types.js';
import type { BrokerIngressInput } from '../infrastructure/longbridge/trade/brokerIngressFixture.js';
import { createBrokerIngressFixture } from './architectureRefactoringP1Native/trade/brokerIngressFixture.js';

const START = Date.parse('2026-03-13T02:00:00.000Z');
const BOUNDARY = START + 1_000;
const DAY = getHKDateKey(new Date(START));

function buyFrame(
  orderId: string,
  quantity: number,
  price: string,
  executedAt: number,
): BrokerIngressInput {
  return {
    orderId,
    symbol: 'BULL.HK',
    stockName: 'HSI RC',
    remark: buildOrderRemark(false),
    side: 'BUY',
    status: 'Filled',
    orderType: 'ELO',
    quantity: String(quantity),
    executedQuantity: String(quantity),
    submittedPrice: price,
    executedPrice: price,
    submittedAtMs: executedAt - 100,
    updatedAtMs: executedAt,
  };
}

function sellFrame(
  orderId: string,
  quantity: number,
  executed: number,
  executedAt: number,
  protective: boolean,
): BrokerIngressInput {
  return {
    orderId,
    symbol: 'BULL.HK',
    stockName: 'HSI RC',
    remark: buildOrderRemark(protective),
    side: 'SELL',
    status: quantity === executed ? 'Filled' : 'PartialFilled',
    orderType: 'ELO',
    quantity: String(quantity),
    executedQuantity: String(executed),
    submittedPrice: '3',
    executedPrice: protective ? '1' : '3',
    submittedAtMs: START,
    updatedAtMs: executedAt,
  };
}

/** 有限等待只观察真实 owner；超时显示 fatal 首错，不把定时器返回当作经济提交。 */
async function eventually(
  predicate: () => boolean,
  failure: () => unknown = () => null,
): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return;

    const error = failure();
    if (error !== null)
      throw error instanceof Error ? error : new Error('未知 fatal', { cause: error });

    await Bun.sleep(5);
  }

  throw new Error('真实事件链未在期限内达到预期状态');
}

/** 每次调用重新装配全套 owners，startup 只能由 loader/rebuild 推进。 */
async function createChain(
  root: string,
  orders: ReadonlyArray<BrokerIngressInput>,
  positionQuantity: number,
  initialNow = START,
) {
  let nowMs = initialNow;
  let tradingGate = false;
  const now = (): Date => new Date(nowMs);
  const logger = createLoggerDouble();
  const diagnostics = createDiagnosticObserverDouble();
  const config = createMonitorConfig({
    maxUnrealizedLossPerSymbol: '50',
    liquidationCooldown: { mode: 'minutes', minutes: 5 },
  });
  const tradingConfig = createTradingConfig({ monitor: config });
  const symbolRegistry = createSymbolRegistry(config);
  const daily = createDailyLossTracker({
    ...orderAnalysis,
    resolveOrderOwnership,
    toHongKongTimeIso,
    onOwnershipWarning: () => {},
  });
  const episode = createProtectiveLiquidationEpisodeTracker();
  const cooldown = createLiquidationCooldownTracker();
  const repository = createMixedTradeLogRepository({ tradesDir: path.join(root, 'trades') });
  const termination = createTerminationRuntime({
    closeTradingGate: () => {
      tradingGate = false;
    },
    closeProducerAdmission: () => {},
    stopProducers: [],
    onSecondaryError: () => {},
  });
  const native = await createBrokerIngressFixture(
    orders[0] ?? buyFrame('BOOT', 100, '1', START - 100),
  );
  native.setAccountBalance({
    currency: 'HKD',
    totalCash: '100000',
    netAssets: '100000',
    availableCash: '100000',
  });
  const setPosition = (quantity: number): void => {
    native.setStockPositions(
      quantity === 0
        ? []
        : [
            {
              symbol: 'BULL.HK',
              symbolName: 'HSI RC',
              accountChannel: 'lb_papertrading',
              currency: 'HKD',
              quantity: String(quantity),
              availableQuantity: String(quantity),
              costPrice: '1',
            },
          ],
    );
  };
  setPosition(positionQuantity);
  native.setOrderSnapshotReplies([], orders);
  native.setOrderDetailReplies(orders);
  const market = createMarketDataClientDouble({
    getQuotes: async (symbols) =>
      new Map(
        [...symbols].map((symbol) => [
          symbol,
          createQuoteDouble(symbol, symbol === 'HSI.HK' ? '20000' : '3', 100),
        ]),
      ),
    getQuoteContext: async () => ({
      warrantList: async () => [],
      warrantQuote: async (symbols) =>
        symbols.map((symbol) => ({
          symbol,
          category: symbol === 'BULL.HK' ? 'Bull' : 'Bear',
          callPrice: symbol === 'BULL.HK' ? '18000' : '22000',
        })),
    }),
  });
  const warrant = createWarrantRiskChecker({
    onInvalidCallPrice: () => {},
    onWarrantInfoSet: () => {},
  });
  const unrealized = createUnrealizedLossChecker({
    maxUnrealizedLossPerSymbol: '50',
    onMissingData: () => {},
  });
  const risk = createRiskChecker({
    warrantRiskChecker: warrant,
    positionLimitChecker: createPositionLimitChecker({ maxPositionNotional: '50000' }),
    unrealizedLossChecker: unrealized,
  });
  let tradeRuntime: TradeRuntime | null = null;
  const requireTrader = (): TradeRuntime => {
    if (tradeRuntime === null) throw new Error('交易 owner 尚未装配');

    return tradeRuntime;
  };
  const snapshot = createAccountPositionSnapshot({
    clock: { now },
    diagnostics,
    dayEpoch: 1,
    scheduler: { schedule: queueMicrotask },
    readPort: {
      getAccountSnapshot: () => requireTrader().accountService.getAccountSnapshot(),
      getStockPositions: () => requireTrader().accountService.getStockPositions(),
    },
    reportFatalError: termination.reportFatalError,
  });
  let subscriptions: ReturnType<typeof createQuoteSubscriptionRuntime> | null = null;
  const settlement = createPostTradeConsistencyRuntime({
    diagnostics,
    clock: { now },
    logger,
    snapshot,
    termination,
    getProtectiveOrderReader: () => requireTrader().orderMonitor,
    onPositionsCommitted: async (token) => {
      if (subscriptions === null) throw new Error('订阅 owner 尚未装配');

      await subscriptions.reconcilePositionHoldFromCurrentTruth(token);
    },
    scheduler: { scheduleTimer: setTimeout, clearTimer: clearTimeout },
  });
  const state: RuntimeStateFixtures = {
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
  tradeRuntime = await native.createTradeRuntime({
    diagnostics,
    logger,
    wait,
    nowMonotonicMs,
    requestExternalApi: wrapExternalApiRequest,
    scheduleBoundedOneShotAt,
    tradingConfig,
    marketDataClient: market,
    symbolRegistry,
    dailyLossTracker: daily,
    protectiveLiquidationEpisodeTracker: episode,
    persistProtectiveLiquidationExecutionProgress: repository.appendExecutionProgressIdempotent,
    postTradeConsistencyRuntime: settlement,
    unrealizedLossBuyGate: risk,
    isExecutionAllowed: () => tradingGate,
    isContinuousTradingAllowed: () => tradingGate,
    now,
    scheduleTimer: setTimeout,
    clearTimer: clearTimeout,
    readCurrentTradingDayInfo: () => state.tradingCalendarState.cachedTradingDayInfo,
    termination,
  });
  const trader = tradeRuntime;
  const context = {
    config,
    symbolRegistry,
    orderRecorder: trader.orderRecorder,
    riskChecker: risk,
    dailyLossTracker: daily,
    monitorSymbolName: '',
    longSymbolName: '',
    shortSymbolName: '',
  };
  settlement.bindBusinessDeps({
    monitorContext: context,
    dailyLossTracker: daily,
    liquidationCooldownTracker: cooldown,
    protectiveLiquidationEpisodeTracker: episode,
    mixedTradeLogRepository: repository,
  });

  subscriptions = createQuoteSubscriptionRuntime({
    logger,
    tradingConfig,
    symbolRegistry,
    marketDataClient: market,
    orderHoldRegistry: trader.orderHoldRegistry,
    quoteSubscriptionState: state.quoteSubscriptionState,
    snapshot,
    termination,
  });
  const quoteSubscriptions = subscriptions;
  // 与 createPostGateRuntime 相同连接：activation、Monitor、settlement 消费同一 O/Daily/风险 owners。
  const activation = createSeatActivationWorkflow({
    termination,
    clock: { now },
    diagnostics,
    config,
    symbolRegistry,
    orders: trader.orderRecorder,
    dailyLoss: daily,
    risk: {
      prepareUnrealizedLossData: (symbol, isLong, lossOffset) =>
        risk.prepareUnrealizedLossData(trader.orderRecorder, symbol, isLong, lossOffset),
      publishUnrealizedLossData: risk.publishUnrealizedLossData,
      setWarrantInfoFromCallPrice: risk.setWarrantInfoFromCallPrice,
    },
    snapshot,
    subscriptions: quoteSubscriptions,
    getQuotes: market.getQuotes,
    setDirectionSymbolName: (direction, name) => {
      if (direction === 'LONG') context.longSymbolName = name;
      else context.shortSymbolName = name;
    },
    logger,
  });
  const dispatcher = createSeatActivationDispatcher({
    logger,
    snapshot,
    symbolRegistry,
    termination,
    monitorTaskQueue: createMonitorTaskQueue<MonitorTaskDataMap>({
      logger,
      clock: { now },
      diagnostics,
    }),
  });
  const load = createLoadTradingDayRuntimeSnapshot({
    logger,
    snapshot,
    marketDataClient: market,
    ...state,
    tradingConfig,
    symbolRegistry,
    orderRecorder: trader.orderRecorder,
    orderHoldRegistry: trader.orderHoldRegistry,
    orderMonitor: trader.orderMonitor,
    dailyLossTracker: daily,
    protectiveLiquidationEpisodeTracker: episode,
    tradeLogHydrator: createTradeLogHydrator({
      mixedTradeLogRepository: repository,
      nowMs: () => nowMs,
      logger,
      tradingConfig,
      liquidationCooldownTracker: cooldown,
    }),
    mixedTradeLogRepository: repository,
    protectionRecovery: settlement,
    startupSeatSearch: createStartupSeatSearch({
      monitorSymbol: config.monitorSymbol,
      symbolRegistry,
      logger,
      candidateSearch: createWarrantCandidateSearch({
        monitorSymbol: config.monitorSymbol,
        autoSearchConfig: config.autoSearchConfig,
        marketDataClient: market,
        logger,
        getTradingMinutesSinceOpen,
      }),
    }),
    seatActivationDispatcher: dispatcher,
  });
  const rebuild = createRebuildTradingDayState({
    snapshot,
    marketDataClient: market,
    ...state,
    symbolRegistry,
    monitorContext: context,
    dailyLossTracker: daily,
    termination,
    orderMonitor: trader.orderMonitor,
    warrantRiskRefresh: createWarrantRiskRefresh({
      marketDataClient: market,
      warrantRiskChecker: warrant,
      logger,
    }),
    displayAccountAndPositions: () => {},
  });
  const fatalError = (): unknown => {
    const fatal = termination.getFatalState();
    return fatal.hasFatalError ? fatal.error : null;
  };
  return {
    native,
    trader,
    daily,
    episode,
    cooldown,
    repository,
    risk,
    unrealized,
    snapshot,
    settlement,
    termination,
    symbolRegistry,
    state,
    config,
    setPosition,
    fatalError,
    setNow: (value: number): void => {
      nowMs = value;
    },
    start: async (): Promise<void> => {
      const loaded = await load({
        now: now(),
        requireTradingDay: true,
        resetRuntimeSubscriptions: true,
        source: 'STARTUP',
      });
      expect(loaded.status).toBe('COMMITTED');
      if (loaded.status !== 'COMMITTED') throw new Error('loader 未提交');

      expect(
        await rebuild({
          snapshotToken: loaded.snapshotToken,
          allOrders: loaded.allOrders,
          quotesMap: loaded.quotesMap,
          now: now(),
        }),
      ).toEqual({ status: 'COMMITTED', snapshotToken: loaded.snapshotToken });
      await quoteSubscriptions.reconcileFromCurrentTruth();
      quoteSubscriptions.start();
      settlement.resetAbort();
      settlement.start();
      expect(await settlement.completeRebuildBaseline()).toBe(true);
      const receipt = await settlement.waitForFresh();
      expect(settlement.isCurrent(receipt)).toBe(true);
      expect(
        snapshot.isCurrent(receipt.snapshotToken, { account: true, positions: true, paired: true }),
      ).toBe(true);
      expect(symbolRegistry.getSeatState('LONG').status).toBe('ACTIVE');
      state.lifecycleState.isTradingEnabled = true;
      state.tradingTimeState.canTrade = true;
      tradingGate = true;
      trader.orderMonitor.startRuntime();
      expect(fatalError()).toBeNull();
    },

    /** 只投递 SDK callback；事实、Daily 与刷新均由生产 Monitor/settlement 推进。 */
    emitExecution: async (
      frame: BrokerIngressInput,
      currentOrders: ReadonlyArray<BrokerIngressInput>,
      quantity: number,
    ): Promise<void> => {
      nowMs = frame.updatedAtMs;
      setPosition(quantity);
      native.setOrderSnapshotReplies([], currentOrders);
      native.setOrderDetailReplies(currentOrders);
      native.emitOrderChangedFrame(frame);
      await eventually(() => {
        const fact = trader.orderRecorder.getExecutionFact(frame.orderId);
        return (
          fact?.phase === 'TERMINAL' &&
          fact.cumulativeQuantity === Number(frame.executedQuantity) &&
          fact.updatedAtMs === frame.updatedAtMs
        );
      }, fatalError);
      const receipt = await settlement.waitForFresh();
      expect(settlement.isCurrent(receipt)).toBe(true);
      expect(snapshot.getAvailablePosition('BULL.HK')?.quantity).toBe(quantity);
      expect(fatalError()).toBeNull();
    },

    /** 直接驱动生产激活协调器；不伪造 API fact/slice，也不扩展 dispatcher/queue 调度覆盖。 */
    activateFromAPI: async (
      currentOrders: ReadonlyArray<BrokerIngressInput>,
      quantity: number,
    ): Promise<void> => {
      setPosition(quantity);
      native.setOrderSnapshotReplies([], currentOrders);
      native.setOrderDetailReplies(currentOrders);
      const tokenBefore = snapshot.getView().token;
      const readsBefore = native.orderSnapshotReadCounts();
      const seat = symbolRegistry.getSeatState('LONG');
      if (seat.status !== 'ACTIVE' || seat.symbol !== 'BULL.HK')
        throw new Error('缺少可重新激活的当前 LONG 席位');

      const { seatVersion } = symbolRegistry.updateSeatStateWithVersionBump('LONG', {
        ...seat,
        status: 'ACTIVATING',
        callPrice: '18000',
      });
      const request = {
        dayEpoch: tokenBefore.dayEpoch,
        direction: 'LONG' as const,
        seatVersion,
        previousSymbol: seat.symbol,
        nextSymbol: 'BULL.HK',
        symbolName: 'HSI RC',
        callPrice: '18000',
      };
      const canContinue = (): boolean =>
        tradingGate &&
        state.lifecycleState.isTradingEnabled &&
        state.tradingTimeState.canTrade === true &&
        !termination.isTerminated() &&
        snapshot.getView().token.dayEpoch === request.dayEpoch;
      // 真实过期身份必须无 API 读取/发布；随后正确身份走完全部激活屏障。
      const staleRequest = { ...request, seatVersion: seatVersion - 1 };
      expect(activation.isCurrent(staleRequest)).toBe(false);
      expect(await activation.activate(staleRequest, canContinue)).toEqual({ status: 'skipped' });
      expect(native.orderSnapshotReadCounts()).toEqual(readsBefore);
      expect(snapshot.getView().token).toEqual(tokenBefore);
      expect(activation.isCurrent(request)).toBe(true);
      expect(await activation.activate(request, canContinue)).toEqual({ status: 'processed' });
      expect(symbolRegistry.getSeatState('LONG')).toMatchObject({
        status: 'ACTIVE',
        symbol: 'BULL.HK',
        lastSeatActivatedAt: nowMs,
      });
      expect(symbolRegistry.getSeatVersion('LONG')).toBe(seatVersion);
      const readsAfter = native.orderSnapshotReadCounts();
      expect(readsAfter.history).toBeGreaterThan(readsBefore.history);
      expect(readsAfter.today).toBeGreaterThan(readsBefore.today);
      const currentToken = snapshot.getView().token;
      expect(currentToken.pairedRevision).toBeGreaterThan(tokenBefore.pairedRevision);
      expect(
        snapshot.isCurrent(tokenBefore, { account: true, positions: true, paired: true }),
      ).toBe(false);

      expect(
        snapshot.isCurrent(currentToken, { account: true, positions: true, paired: true }),
      ).toBe(true);
      expect(snapshot.getAvailablePosition('BULL.HK')?.availableQuantity).toBe(quantity);
      expect(state.quoteSubscriptionState.allTradingSymbols.has('BULL.HK')).toBe(true);
      const receipt = await settlement.waitForFresh();
      expect(settlement.isCurrent(receipt)).toBe(true);
      expect(fatalError()).toBeNull();
    },
    submitSell: async (
      id: string,
      quantity: number,
      protective: boolean,
      relatedBuyOrderIds: ReadonlyArray<string> = [],
    ): Promise<void> => {
      const receipt = await settlement.waitForFresh();
      const seatVersion = symbolRegistry.getSeatVersion('LONG');
      const capturedAuthorization = (): boolean =>
        tradingGate &&
        settlement.isCurrent(receipt) &&
        snapshot.isCurrent(receipt.snapshotToken, {
          account: true,
          positions: true,
          paired: true,
        }) &&
        symbolRegistry.getSeatVersion('LONG') === seatVersion;
      native.setSubmitBehavior(async () => id);
      const result = await trader.orderExecutor.executeSignals(
        [
          {
            action: 'SELLCALL',
            symbol: 'BULL.HK',
            symbolName: 'HSI RC',
            quantity,
            seatVersion,
            isProtectiveLiquidation: protective,
            relatedBuyOrderIds,
            triggerTime: now(),
          },
        ],
        capturedAuthorization,
      );
      expect(result.executedOrderIds).toEqual([id]);
      expect(native.nativeSubmitObservations().at(-1)).toMatchObject({
        side: 'SELL',
        quantity: String(quantity),
      });
    },
    stop: async (expectedFatal = false): Promise<void> => {
      tradingGate = false;
      const monitorDrain = await Promise.allSettled([trader.orderMonitor.stopRuntimeAndDrain()]);
      const settlementDrain = await Promise.allSettled([settlement.stopAndDrain()]);
      const subscriptionDrain = await Promise.allSettled([quoteSubscriptions.stopAndDrain()]);
      const teardown = await Promise.allSettled([
        trader.orderMonitor.teardown(),
        snapshot.waitForIssuedDrain(),
      ]);
      for (const result of [
        ...monitorDrain,
        ...settlementDrain,
        ...subscriptionDrain,
        ...teardown,
      ]) {
        if (result.status === 'rejected' && (!expectedFatal || result.reason !== fatalError()))
          throw result.reason;
      }
    },
  };
}

describe('F01: 同毫秒 BUY/SELL 真实 Monitor 经济投影', () => {
  for (const associated of [false, true]) {
    for (const sellDelay of [0, 1]) {
      it(`SELL ${sellDelay}ms / 正式关联=${associated} 保留 B2 并支撑风险与智能平仓`, async () => {
        const root = mkdtempSync(path.join(tmpdir(), 'f01-full-chain-'));
        const buys = [buyFrame('B1', 100, '1', START - 100), buyFrame('B2', 100, '2', START)];
        const pendingBuys: ReadonlyArray<BrokerIngressInput> = buys.map((buy) => ({
          ...buy,
          status: 'New',
          executedQuantity: '0',
          executedPrice: '0',
          updatedAtMs: buy.submittedAtMs,
        }));
        const chain = await createChain(root, pendingBuys, 0, START - 100);
        try {
          await chain.start();
          expect(chain.trader.orderRecorder.getCostBasis('BULL.HK', true)).toBeNull();
          // 零成交 API 仅恢复 tracking；两个 BUY 的经济资格必须由真实在线入站先后建立。
          for (const [index, buy] of buys.entries()) {
            chain.setNow(buy.updatedAtMs);
            chain.setPosition((index + 1) * 100);
            const currentOrders = [...buys.slice(0, index + 1), ...pendingBuys.slice(index + 1)];
            chain.native.setOrderSnapshotReplies([], currentOrders);
            chain.native.setOrderDetailReplies(currentOrders);
            chain.native.emitOrderChangedFrame(buy);
            await eventually(
              () => chain.trader.orderRecorder.getExecutionFact(buy.orderId)?.phase === 'TERMINAL',
              chain.fatalError,
            );
            await chain.settlement.waitForFresh();
          }

          expect(chain.trader.orderRecorder.getCostBasis('BULL.HK', true)).toEqual({
            costAmount: '300',
            quantity: 200,
          });
          const selected = chain.trader.orderRecorder.selectSellableOrders({
            symbol: 'BULL.HK',
            direction: 'LONG',
            strategy: 'ALL',
            currentPrice: '3',
            maxSellQuantity: 100,
          });
          expect(selected.orders.map((order) => order.orderId)).toEqual(['B1']);
          await chain.submitSell(
            'S1',
            100,
            false,
            associated ? selected.orders.map((order) => order.orderId) : [],
          );

          expect(
            chain.trader.orderRecorder.getPendingSellSnapshot()[0]?.relatedBuyOrderIds,
          ).toEqual(associated ? ['B1'] : []);
          const sell = {
            ...sellFrame('S1', 100, 100, START + sellDelay, false),
            executedPrice: '1.5',
          };
          chain.setPosition(100);
          chain.native.setOrderSnapshotReplies([], [...buys, sell]);
          chain.native.setOrderDetailReplies([sell]);
          chain.native.emitOrderChangedFrame(sell);
          await eventually(
            () => chain.trader.orderRecorder.getExecutionFact('S1')?.phase === 'TERMINAL',
            chain.fatalError,
          );
          await chain.settlement.waitForFresh();
          expect(
            chain.trader.orderRecorder
              .getBuyOrdersForSymbol('BULL.HK', true)
              .map((order) => order.orderId),
          ).toEqual(['B2']);

          expect(chain.trader.orderRecorder.getCostBasis('BULL.HK', true)).toEqual({
            costAmount: '200',
            quantity: 100,
          });
          // Daily 仍用严格时间筛选：同 T 剩余成本=0，150-300+0=-150；晚 1ms 剩余成本=200，盈利 50 截为 0。
          // O 的在线经济投影独立保留 B2 成本 200，故 R1=200-Daily。
          const expectedDaily = sellDelay === 0 ? '-150' : '0';
          expect(chain.daily.getLossOffset('LONG')).toBe(expectedDaily);
          expect(chain.unrealized.getUnrealizedLossData('BULL.HK')).toEqual({
            r1: sellDelay === 0 ? '350' : '200',
            n1: 100,
          });

          expect(chain.risk.checkUnrealizedLoss('BULL.HK', '1', true)).toMatchObject({
            shouldLiquidate: true,
            quantity: 100,
          });
          const close = resolveSellQuantityBySmartClose({
            orderRecorder: chain.trader.orderRecorder,
            currentPrice: '3',
            availableQuantity: 100,
            direction: 'LONG',
            symbol: 'BULL.HK',
            smartCloseTimeoutMinutes: null,
            nowMs: START + 10,
            isHalfDay: false,
            tradingCalendarSnapshot: chain.state.tradingCalendarState.tradingCalendarSnapshot,
          });
          expect(close).toMatchObject({
            quantity: 100,
            shouldHold: false,
            relatedBuyOrderIds: ['B2'],
          });
          expect(chain.fatalError()).toBeNull();
        } finally {
          try {
            await chain.stop();
          } finally {
            rmSync(root, { recursive: true, force: true });
          }
        }
      });
    }
  }
});

/** API 仅恢复零成交 tracking；随后经济准入由 SDK callback 建立 ONLINE 来源。 */
function pendingBuy(frame: BrokerIngressInput): BrokerIngressInput {
  return {
    ...frame,
    status: 'New',
    executedQuantity: '0',
    executedPrice: '0',
    updatedAtMs: frame.submittedAtMs,
  };
}

/** 消费真实激活发布的 Daily/R1/N1 与订单成本，不在断言前手工刷新风险。 */
function expectMixedActivationProjection(
  chain: Awaited<ReturnType<typeof createChain>>,
  remainingOrderId: string,
  costAmount: string,
  dailyOffset: string,
  r1: string,
  quantity = 100,
  riskPrice = '1',
): void {
  expect(
    chain.trader.orderRecorder.getBuyOrdersForSymbol('BULL.HK', true).map((order) => order.orderId),
  ).toEqual([remainingOrderId]);

  expect(chain.trader.orderRecorder.getCostBasis('BULL.HK', true)).toEqual({
    costAmount,
    quantity,
  });
  expect(chain.daily.getLossOffset('LONG')).toBe(dailyOffset);
  expect(chain.unrealized.getUnrealizedLossData('BULL.HK')).toEqual({ r1, n1: quantity });
  expect(chain.config.maxUnrealizedLossPerSymbol).toBe('50');
  expect(chain.risk.checkUnrealizedLoss('BULL.HK', riskPrice, true)).toMatchObject({
    shouldLiquidate: true,
    quantity,
  });
  const availableQuantity = chain.snapshot.getAvailablePosition('BULL.HK')?.availableQuantity;
  expect(availableQuantity).toBe(quantity);
  if (availableQuantity === undefined) throw new Error('激活后缺少权威持仓');

  expect(
    resolveSellQuantityBySmartClose({
      orderRecorder: chain.trader.orderRecorder,
      currentPrice: '4',
      availableQuantity,
      direction: 'LONG',
      symbol: 'BULL.HK',
      smartCloseTimeoutMinutes: null,
      nowMs: START + 300,
      isHalfDay: false,
      tradingCalendarSnapshot: chain.state.tradingCalendarState.tradingCalendarSnapshot,
    }),
  ).toMatchObject({ quantity, shouldHold: false, relatedBuyOrderIds: [remainingOrderId] });
  expect(chain.fatalError()).toBeNull();
}

describe('F01: ONLINE 准入与 HISTORY ACTIVATION 混合全链', () => {
  it('混合完整 BUY 身份在 native callback 增长后不能被 API 等时 SELL 拆分', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'f01-whole-identity-'));
    const a100: BrokerIngressInput = {
      ...buyFrame('A', 100, '1', START),
      quantity: '200',
      status: 'Canceled',
    };
    const a200 = buyFrame('A', 200, '1', START + 100);
    const b = buyFrame('B', 100, '3', START + 100);
    const chain = await createChain(root, [a100, pendingBuy(b)], 100);
    try {
      await chain.start();
      await chain.emitExecution(a200, [a200, pendingBuy(b)], 200);
      await chain.emitExecution(b, [a200, b], 300);
      const sell = { ...sellFrame('S', 100, 100, START, false), executedPrice: '1.5' };
      await chain.activateFromAPI([a200, b, sell], 200);
      expectMixedActivationProjection(chain, 'A', '200', '0', '200', 200, '0.5');
      await chain.activateFromAPI([a200, b, sell], 200);
      expectMixedActivationProjection(chain, 'A', '200', '0', '200', 200, '0.5');
    } finally {
      try {
        await chain.stop();
        expect(chain.fatalError()).toBeNull();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  for (const futureHistoryAssociation of [false, true]) {
    it(`真实选单与 partial terminal 精确关联优先于 API 累计 SELL 的${futureHistoryAssociation ? '未来历史区间' : '等时总量捷径'}`, async () => {
      const root = mkdtempSync(path.join(tmpdir(), 'f01-exact-association-'));
      const b1 = buyFrame('B1', 100, '1', futureHistoryAssociation ? START + 1000 : START);
      const b2 = buyFrame('B2', 200, '2', futureHistoryAssociation ? START - 100 : START);
      const chain = await createChain(
        root,
        [b1, futureHistoryAssociation ? b2 : pendingBuy(b2)],
        futureHistoryAssociation ? 300 : 100,
      );
      try {
        await chain.start();
        if (!futureHistoryAssociation) await chain.emitExecution(b2, [b1, b2], 300);

        const recorder = chain.trader.orderRecorder;
        const selected = recorder.selectSellableOrders({
          symbol: 'BULL.HK',
          direction: 'LONG',
          strategy: 'ALL',
          currentPrice: '3',
          maxSellQuantity: 300,
        });
        expect(selected.totalQuantity).toBe(300);
        await chain.submitSell(
          'S',
          selected.totalQuantity,
          false,
          selected.orders.map((order) => order.orderId),
        );
        expect(recorder.getPendingSellSnapshot()[0]?.relatedBuyOrderIds).toEqual(['B1', 'B2']);
        const sold100: BrokerIngressInput = {
          ...sellFrame('S', 300, 100, START, false),
          status: 'Canceled',
          executedPrice: '1.5',
        };
        await chain.emitExecution(sold100, [b1, b2, sold100], 200);
        expect(
          recorder.getBuyOrdersForSymbol('BULL.HK', true).map((order) => order.orderId),
        ).toEqual(['B2']);

        expect(recorder.getCostBasis('BULL.HK', true)).toEqual({
          costAmount: '400',
          quantity: 200,
        });
        expect(recorder.getPendingSellSnapshot()).toEqual([]);
        const sold200 = {
          ...sold100,
          executedQuantity: '200',
          updatedAtMs: futureHistoryAssociation ? START + 100 : START,
        };
        await chain.activateFromAPI([b1, b2, sold200], 100);
        // 精确关联只覆盖 B1，经济整笔 B2=200 与实际持仓 100 分属两个口径；消费者必须保留成本。
        expect(recorder.getCostBasis('BULL.HK', true)).toEqual({
          costAmount: '400',
          quantity: 200,
        });

        expect(chain.unrealized.getUnrealizedLossData('BULL.HK')).toEqual({
          r1: futureHistoryAssociation ? '500' : '600',
          n1: 200,
        });

        expect(chain.risk.checkUnrealizedLoss('BULL.HK', '1', true)).toMatchObject({
          shouldLiquidate: true,
          quantity: 200,
        });

        expect(
          resolveSellQuantityBySmartClose({
            orderRecorder: recorder,
            currentPrice: '4',
            availableQuantity: 100,
            direction: 'LONG',
            symbol: 'BULL.HK',
            smartCloseTimeoutMinutes: null,
            nowMs: START + 300,
            isHalfDay: false,
            tradingCalendarSnapshot: chain.state.tradingCalendarState.tradingCalendarSnapshot,
          }),
        ).toMatchObject({ quantity: null, shouldHold: true, relatedBuyOrderIds: [] });
        await chain.activateFromAPI([b1, b2, sold200], 100);
        expect(recorder.getCostBasis('BULL.HK', true)).toEqual({
          costAmount: '400',
          quantity: 200,
        });
      } finally {
        try {
          await chain.stop();
          expect(chain.fatalError()).toBeNull();
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }
    });
  }

  it('同一 SELL 的 API 累计增长只扣一次，保留等时 ONLINE B3', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'f01-mixed-growth-'));
    const b1 = buyFrame('B1', 100, '1', START);
    const b2 = buyFrame('B2', 100, '2', START + 100);
    const b3 = buyFrame('B3', 100, '3', START + 200);
    const pending = [pendingBuy(b1), pendingBuy(b2), pendingBuy(b3)];
    const chain = await createChain(root, pending, 0, START - 100);
    try {
      await chain.start();
      const recorder = chain.trader.orderRecorder;
      expect(recorder.getCostBasis('BULL.HK', true)).toBeNull();
      await chain.emitExecution(b1, [b1, pendingBuy(b2), pendingBuy(b3)], 100);
      await chain.emitExecution(b2, [b1, b2, pendingBuy(b3)], 200);
      await chain.submitSell('S', 200, false);
      // 部分成交撤单先形成终态经济 100；API 随后确认同 broker ID 的迟到成交累计 200。
      const sold100: BrokerIngressInput = {
        ...sellFrame('S', 200, 100, START + 100, false),
        status: 'Canceled',
        executedPrice: '1.5',
      };
      await chain.emitExecution(sold100, [b1, b2, pendingBuy(b3), sold100], 100);
      expect(recorder.getCostBasis('BULL.HK', true)).toEqual({ costAmount: '200', quantity: 100 });
      await chain.emitExecution(b3, [b1, b2, b3, sold100], 200);
      const onlineB3 = recorder.getExecutionFact('B3');
      expect(onlineB3).toMatchObject({ cumulativeQuantity: 100, executionTimeMs: START + 200 });
      expect(recorder.getCostBasis('BULL.HK', true)).toEqual({ costAmount: '500', quantity: 200 });
      const sold200 = {
        ...sellFrame('S', 200, 200, START + 200, false),
        executedPrice: '1.5',
      };
      const activationOrders = [b1, b2, b3, sold200];
      await chain.activateFromAPI(activationOrders, 100);
      expect(chain.trader.orderRecorder).toBe(recorder);
      expect(recorder.getExecutionFact('B3')).toBe(onlineB3);
      expect(recorder.getExecutionFact('S')).toMatchObject({
        cumulativeQuantity: 200,
        cumulativeAmount: '300',
        executionTimeMs: START + 200,
        phase: 'TERMINAL',
      });
      expectMixedActivationProjection(chain, 'B3', '300', '-300', '600');
      await chain.activateFromAPI(activationOrders, 100);
      expect(recorder.getExecutionFact('B3')).toBe(onlineB3);
      expectMixedActivationProjection(chain, 'B3', '300', '-300', '600');
    } finally {
      try {
        await chain.stop();
        expect(chain.fatalError()).toBeNull();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('首次 API SELL 合并历史 B1 与等时 ONLINE B2 候选，仅消费 B1', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'f01-mixed-first-sell-'));
    const b1 = buyFrame('B1', 100, '1', START);
    const b2 = buyFrame('B2', 100, '2', START + 100);
    const chain = await createChain(root, [b1, pendingBuy(b2)], 100);
    try {
      await chain.start();
      const recorder = chain.trader.orderRecorder;
      expect(recorder.getCostBasis('BULL.HK', true)).toEqual({ costAmount: '100', quantity: 100 });
      await chain.emitExecution(b2, [b1, b2], 200);
      const onlineB2 = recorder.getExecutionFact('B2');
      expect(onlineB2).toMatchObject({ cumulativeQuantity: 100, executionTimeMs: START + 100 });
      expect(recorder.getCostBasis('BULL.HK', true)).toEqual({ costAmount: '300', quantity: 200 });
      expect(recorder.getExecutionFact('S')).toBeNull();
      const sell = {
        ...sellFrame('S', 100, 100, START + 100, false),
        executedPrice: '1.5',
      };
      const activationOrders = [b1, b2, sell];
      await chain.activateFromAPI(activationOrders, 100);
      expect(chain.trader.orderRecorder).toBe(recorder);
      expect(recorder.getExecutionFact('B2')).toBe(onlineB2);
      expect(recorder.getExecutionFact('S')).toMatchObject({
        cumulativeQuantity: 100,
        cumulativeAmount: '150',
        executionTimeMs: START + 100,
        phase: 'TERMINAL',
      });
      expectMixedActivationProjection(chain, 'B2', '200', '-150', '350');
      await chain.activateFromAPI(activationOrders, 100);
      expect(recorder.getExecutionFact('B2')).toBe(onlineB2);
      expectMixedActivationProjection(chain, 'B2', '200', '-150', '350');
    } finally {
      try {
        await chain.stop();
        expect(chain.fatalError()).toBeNull();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
});

/** A 先由真实保护性 SELL partial 产生 OPEN durable；不提前制造 completion 或人工边界。 */
async function persistOpenEpisode(root: string): Promise<ReadonlyArray<BrokerIngressInput>> {
  const originals = [
    buyFrame('ORIGINAL', 100, '1', START - 200),
    buyFrame('REMAINDER', 100, '1', START - 100),
  ];
  const chain = await createChain(root, originals, 200);
  try {
    await chain.start();
    await chain.submitSell('PROTECT', 200, true);
    const partial = sellFrame('PROTECT', 200, 100, BOUNDARY, true);
    chain.setNow(BOUNDARY);
    chain.setPosition(100);
    chain.native.setOrderDetailReplies([partial]);
    chain.native.emitOrderChangedFrame(partial);
    await eventually(
      () => chain.repository.loadExecutionProgressRecords(DAY).length === 1,
      chain.fatalError,
    );
    await chain.settlement.waitForFresh();
    expect(chain.repository.loadExecutionProgressRecords(DAY)[0]).toMatchObject({
      orderId: 'PROTECT',
      factStage: 'OPEN',
      cumulativeQuantity: '100',
      lastExecutionTimeMs: BOUNDARY,
    });
    expect(chain.repository.loadCompletionRecords(DAY)).toEqual([]);
    expect(chain.episode.getInProgressEpisodes()).toHaveLength(1);
    return [...originals, partial];
  } finally {
    await chain.stop();
  }
}

describe('F02: OPEN durable → 新实例恢复 → 普通 SELL flat → 再重启', () => {
  for (const submittedOffset of [-1, 0, 1]) {
    for (const revision of ['none', 'duplicate', 'revision', 'amount', 'phase'] as const) {
      // 严格晚提交的零基线证明不需要任何同量修订；负向覆盖每种错误的历史“补证”。
      if (submittedOffset > 0 && revision !== 'none') continue;

      it(`折叠 BUY submit=${submittedOffset}ms，同量观察=${revision}`, async () => {
        const root = mkdtempSync(path.join(tmpdir(), 'f02-full-chain-'));
        try {
          const source = await persistOpenEpisode(root);
          const folded: BrokerIngressInput = {
            ...buyFrame('FOLDED', 100, '2', BOUNDARY + 1_000),
            quantity: '200',
            status: 'PartialFilled',
            submittedAtMs: BOUNDARY + submittedOffset,
          };
          const orders = [...source, folded];
          const b = await createChain(root, orders, 200, BOUNDARY + 2_000);
          let finalOrders: ReadonlyArray<BrokerIngressInput> = orders;
          try {
            await b.start();
            expect(b.episode.getInProgressEpisodes()).toHaveLength(1);
            expect(b.repository.loadCompletionRecords(DAY)).toEqual([]);
            let revised = folded;
            if (revision !== 'none') {
              revised = {
                ...folded,
                updatedAtMs: revision === 'duplicate' ? folded.updatedAtMs : BOUNDARY + 2_100,
                executedPrice: revision === 'amount' ? '2.1' : folded.executedPrice,
                status: revision === 'phase' ? 'Canceled' : folded.status,
              };
              b.native.setOrderDetailReplies([revised]);
              b.native.emitOrderChangedFrame(revised);
              await eventually(
                () =>
                  b.trader.orderRecorder.getExecutionFact('FOLDED')?.updatedAtMs ===
                  revised.updatedAtMs,
                b.fatalError,
              );
              await b.settlement.waitForFresh();
            }

            const protective = source.at(-1);
            if (protective === undefined) throw new Error('缺少 A 的保护性订单');

            const canceled: BrokerIngressInput = {
              ...protective,
              status: 'Canceled',
              updatedAtMs: BOUNDARY + 2_200,
            };
            b.native.setOrderDetailReplies([canceled, revised]);
            b.native.emitOrderChangedFrame(canceled);
            await eventually(
              () => !b.trader.orderMonitor.hasPendingProtectiveLiquidationOrders('LONG'),
              b.fatalError,
            );
            await b.settlement.waitForFresh();
            expect(b.trader.orderRecorder.getExecutionFact('PROTECT')?.executionTimeMs).toBe(
              BOUNDARY,
            );

            expect(b.repository.loadExecutionProgressRecords(DAY).at(-1)).toMatchObject({
              factStage: 'TERMINAL',
              lastExecutionTimeMs: BOUNDARY,
            });
            expect(b.repository.loadCompletionRecords(DAY)).toEqual([]);
            b.setNow(BOUNDARY + 3_000);
            b.native.setOrderSnapshotReplies([], [...source.slice(0, -1), canceled, revised]);
            await b.submitSell('ORDINARY', 200, false);
            const ordinary = {
              ...sellFrame('ORDINARY', 200, 200, BOUNDARY + 3_100, false),
              submittedAtMs: BOUNDARY + 3_000,
            };
            finalOrders = [...source.slice(0, -1), canceled, revised, ordinary];
            b.setPosition(0);
            b.native.setOrderSnapshotReplies([], finalOrders);
            b.native.setOrderDetailReplies([ordinary, canceled, revised]);
            b.native.emitOrderChangedFrame(ordinary);
            if (submittedOffset <= 0) {
              await eventually(() => b.termination.getFatalState().hasFatalError);
              expect(String(b.fatalError())).toMatch(/历史|边界|baseline|快照/);
              expect(b.repository.loadCompletionRecords(DAY)).toEqual([]);
              expect(b.episode.getInProgressEpisodes()).toHaveLength(1);
              expect(
                b.cooldown.getRemainingMs({
                  direction: 'LONG',
                  cooldownConfig: b.config.liquidationCooldown,
                  currentTimeMs: BOUNDARY + 3_100,
                }),
              ).toBe(0);
            } else {
              await eventually(
                () => b.repository.loadCompletionRecords(DAY).length === 1,
                b.fatalError,
              );
              await b.settlement.waitForFresh();
              expect(b.repository.loadCompletionRecords(DAY)[0]).toMatchObject({
                boundaryExecutedTimeMs: BOUNDARY,
              });

              expect(
                b.repository
                  .loadCompletionRecords(DAY)[0]
                  ?.orderBaselines.some((baseline) => baseline.orderId === 'FOLDED'),
              ).toBe(false);
              expect(b.episode.getInProgressEpisodes()).toEqual([]);
              expect(b.snapshot.getView().positions).toEqual([]);
              expect(b.trader.orderRecorder.getCostBasis('BULL.HK', true)).toBeNull();
              expect(b.daily.getLossOffset('LONG')).toBe('0');
              expect(b.unrealized.getUnrealizedLossData('BULL.HK')).toEqual({ r1: '0', n1: 0 });
              expect(
                b.cooldown.getRemainingMs({
                  direction: 'LONG',
                  cooldownConfig: b.config.liquidationCooldown,
                  currentTimeMs: BOUNDARY + 3_100,
                }),
              ).toBe(296_900);
              expect(b.fatalError()).toBeNull();
            }
          } finally {
            await b.stop(submittedOffset <= 0);
          }

          const c = await createChain(root, finalOrders, 0, BOUNDARY + 4_000);
          try {
            if (submittedOffset <= 0) {
              const recoveryError: unknown = await c.start().then(
                () => null,
                (error: unknown) => error,
              );
              expect(recoveryError).toBeInstanceOf(Error);
              expect(String(recoveryError)).toMatch(/FOLDED.*baseline/);
              expect(c.repository.loadCompletionRecords(DAY)).toEqual([]);
              expect(
                c.cooldown.getRemainingMs({
                  direction: 'LONG',
                  cooldownConfig: c.config.liquidationCooldown,
                  currentTimeMs: BOUNDARY + 4_000,
                }),
              ).toBe(0);
            } else {
              await c.start();
              expect(c.repository.loadCompletionRecords(DAY)).toHaveLength(1);
              expect(c.episode.getInProgressEpisodes()).toEqual([]);
              expect(c.snapshot.getView().positions).toEqual([]);
              expect(c.trader.orderRecorder.getCostBasis('BULL.HK', true)).toBeNull();
              expect(c.daily.getLossOffset('LONG')).toBe('0');
              expect(c.unrealized.getUnrealizedLossData('BULL.HK')).toEqual({ r1: '0', n1: 0 });
              expect(
                c.cooldown.getRemainingMs({
                  direction: 'LONG',
                  cooldownConfig: c.config.liquidationCooldown,
                  currentTimeMs: BOUNDARY + 4_000,
                }),
              ).toBe(296_000);
              expect(c.fatalError()).toBeNull();
            }
          } finally {
            await c.stop(submittedOffset <= 0);
          }
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }, 30_000);
    }
  }
});
