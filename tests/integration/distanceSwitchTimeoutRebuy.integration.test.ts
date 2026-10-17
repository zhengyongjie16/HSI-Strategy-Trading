/**
 * 距离换标超时转换回补集成：真实 executor 提交 S1，SDK 入站经 monitor/settlement 落入唯一 recorder。
 * 回补只消费同一移仓操作的权威金额，并等待真实 snapshot/settlement fresh，不以读取替身代替成交。
 */
import { createDiagnosticObserverDouble } from '../helpers/diagnostics.js';
import { describe, expect, it } from 'bun:test';
import { createTradingConfig } from '../../mock/factories/configFactory.js';
import { createSeatSwitchWorkflow } from '../../src/application/seatSwitch/index.js';
import { createSymbolRegistry } from '../../src/domain/seat/symbolRegistry.js';
import { wrapExternalApiRequest } from '../../src/infrastructure/externalApi/index.js';
import { wait } from '../../src/infrastructure/time/index.js';
import { scheduleBoundedOneShotAt } from '../../src/runtime/timer/index.js';
import { createExecutionFixture } from '../application/orderTracking/recorder/executionFixture.js';
import { waitUntil } from '../helpers/asyncProgram.js';
import {
  captureSwitchSeatAuthorization,
  createWarrantCandidate,
  getDefaultAutoSearchConfig,
} from '../helpers/seatTestUtils.js';
import {
  createLiquidationCooldownTrackerDouble,
  createLoggerDouble,
  createMarketDataClientDouble,
  createMonitorConfigDouble,
  createMonitorContextDouble,
  createQuoteDouble,
  createRateLimiterDouble,
  createRiskCheckerDouble,
  createTradeRuntimeDouble,
  createWarrantDistanceInfoDouble,
} from '../helpers/testDoubles.js';
import { createHarness } from '../runtime/strategy/intradayRegression/fixtures.js';
import { createBrokerIngressFixture } from './architectureRefactoringP1Native/trade/brokerIngressFixture.js';

const T = Date.parse('2026-02-16T02:00:00.000Z');

describe('distance switch timeout market conversion rebuy', () => {
  it.each([
    {
      parentFill: 0,
      revisionPrice: null,
      revisionAmount: null,
      expectedBuy: '500',
      retryBeforeRevision: false,
    },
    {
      parentFill: 40,
      revisionPrice: null,
      revisionAmount: null,
      expectedBuy: '500',
      retryBeforeRevision: false,
    },
    {
      parentFill: 40,
      revisionPrice: '4',
      revisionAmount: '160',
      expectedBuy: '600',
      retryBeforeRevision: false,
    },
    {
      parentFill: 40,
      revisionPrice: '0.5',
      revisionAmount: '20',
      expectedBuy: '300',
      retryBeforeRevision: false,
    },
    {
      parentFill: 40,
      revisionPrice: '4',
      revisionAmount: '160',
      expectedBuy: '600',
      retryBeforeRevision: true,
    },
  ])(
    'S1/S2 authoritative amounts and quote/retry revision: %p',
    async ({ parentFill, revisionPrice, revisionAmount, expectedBuy, retryBeforeRevision }) => {
      const h = createHarness();
      h.setNow(T);
      const original = {
        orderId: 'S1',
        tradeId: 'S1-EXECUTION',
        symbol: 'OLD_BULL.HK',
        stockName: 'HSI RC',
        remark: 'HSI',
        side: 'SELL' as const,
        orderType: 'ELO' as const,
        status: 'New' as const,
        quantity: '100',
        executedQuantity: '0',
        submittedPrice: '2',
        executedPrice: '0',
        submittedAtMs: T,
        executionTimeMs: null,
        updatedAtMs: T,
      };
      const native = await createBrokerIngressFixture(original);
      native.setOrderSnapshotReplies([], []);
      const remaining = 100 - parentFill;
      native.setAccountBalance({
        currency: 'HKD',
        totalCash: '100000',
        netAssets: '100100',
        availableCash: '100000',
      });

      native.setStockPositions([
        {
          symbol: original.symbol,
          symbolName: 'HSI RC',
          accountChannel: 'HK',
          currency: 'HKD',
          quantity: '100',
          availableQuantity: '100',
          costPrice: '1',
        },
      ]);
      const rateLimiter = createRateLimiterDouble();
      const account = native.createAccountService({ rateLimiter });
      const refreshIssued = Promise.withResolvers<undefined>();
      const releaseRefresh = Promise.withResolvers<undefined>();
      let blockRefresh = false;
      let monitor: ReturnType<typeof native.createMonitor> | null = null;
      const f = createExecutionFixture({
        nowMs: T,
        rateLimiter,
        createRecorder: native.createRecorder,
        readPort: {
          getAccountSnapshot: account.getAccountSnapshot,
          getStockPositions: async () => {
            if (blockRefresh) {
              refreshIssued.resolve();
              await releaseRefresh.promise;
            }

            return account.getStockPositions();
          },
        },
        getTradeRuntime: () => {
          if (monitor === null) throw new Error('monitor must be assembled before settlement');

          return createTradeRuntimeDouble({ orderMonitor: monitor });
        },
        onPositionsCommitted: async (token) => {
          expect(f.snapshot.isCurrent(token, { account: false, positions: true })).toBeTrue();
        },
      });
      const config = createMonitorConfigDouble({
        autoSearchConfig: getDefaultAutoSearchConfig(),
        orderOwnershipMapping: ['HSI'],
      });
      const base = createTradingConfig({ monitor: config });
      const tradingConfig = createTradingConfig({
        monitor: config,
        global: { ...base.global, sellOrderTimeout: { enabled: true, timeoutSeconds: 1 } },
      });
      const registry = createSymbolRegistry(config);
      registry.updateSeatState('LONG', {
        symbol: original.symbol,
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: T - 1000,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
        callPrice: '21000',
      });
      const quoteIssued = Promise.withResolvers<undefined>();
      const releaseQuote = Promise.withResolvers<undefined>();
      let blockNewQuote = false;
      const market = createMarketDataClientDouble({
        getQuotes: async (symbols) => {
          if (blockNewQuote && [...symbols].includes('NEW_BULL.HK')) {
            quoteIssued.resolve();
            await releaseQuote.promise;
          }

          return new Map(
            [...symbols].map((symbol) => [
              symbol,
              createQuoteDouble(symbol, symbol === 'NEW_BULL.HK' ? '0.52' : '2', 100),
            ]),
          );
        },
      });
      const risk = createRiskCheckerDouble({
        getWarrantDistanceInfo: () =>
          createWarrantDistanceInfoDouble({
            warrantType: 'BULL',
            distanceNumerator: '0.1',
            distanceDenominator: '100',
          }),
      });
      const cache = native.createCacheManager({
        logger: createLoggerDouble(),
        requestExternalApi: wrapExternalApiRequest,
        rateLimiter,
        now: h.deps.clock.now,
      });
      monitor = native.createMonitor({
        diagnostics: createDiagnosticObserverDouble(),
        logger: createLoggerDouble(),
        wait,
        requestExternalApi: wrapExternalApiRequest,
        scheduleBoundedOneShotAt,
        now: h.deps.clock.now,
        ...h.deps.scheduler,
        rateLimiter,
        cacheManager: cache,
        marketDataClient: market,
        orderRecorder: f.recorder,
        dailyLossTracker: f.daily,
        orderHoldRegistry: f.holds,
        protectiveLiquidationEpisodeTracker: f.episode,
        persistProtectiveLiquidationExecutionProgress: () => {
          throw new Error('ordinary switch cannot persist protective execution');
        },
        postTradeConsistencyRuntime: f.sink,
        tradingConfig,
        symbolRegistry: registry,
        isContinuousTradingAllowed: () => true,
        termination: f.termination,
      });
      let executorAllowed = true;
      const closedCounts = new Map<string, number>();
      monitor.onOrderStateChanged((event) => {
        closedCounts.set(event.orderId, (closedCounts.get(event.orderId) ?? 0) + 1);
      });
      const executor = native.createExecutor({
        diagnostics: createDiagnosticObserverDouble(),
        logger: createLoggerDouble(),
        rateLimiter,
        cacheManager: cache,
        marketDataClient: market,
        orderRecorder: f.recorder,
        orderMonitor: monitor,
        unrealizedLossBuyGate: risk,
        tradingConfig,
        symbolRegistry: registry,
        isExecutionAllowed: () => executorAllowed,
        isContinuousTradingAllowed: () => true,
        now: h.deps.clock.now,
        readCurrentTradingDayInfo: () => ({
          dateKey: '2026-02-16',
          info: { isTradingDay: true, isHalfDay: false },
        }),
      });
      const manager = createSeatSwitchWorkflow({
        logger: createLoggerDouble(),
        monitorConfig: config,
        symbolRegistry: registry,
        marketDataClient: market,
        cacheManager: cache,
        orderHoldRegistry: f.holds,
        orderMonitor: monitor,
        orderExecutor: executor,
        orderRecorder: f.recorder,
        riskChecker: risk,
        candidateSearch: {
          resolveDistanceRange: () => config.autoSearchConfig.switchDistanceRangeBull,
          findCandidate: async () => createWarrantCandidate('NEW_BULL.HK'),
        },
        clock: h.deps.clock,
        getTradingCalendarSnapshot: () =>
          new Map([['2026-02-16', { isTradingDay: true, isHalfDay: false }]]),
      });
      f.sink.bindBusinessDeps({
        monitorContext: createMonitorContextDouble({
          config,
          symbolRegistry: registry,
          orderRecorder: f.recorder,
          dailyLossTracker: f.daily,
          riskChecker: risk,
        }),
        dailyLossTracker: f.daily,
        protectiveLiquidationEpisodeTracker: f.episode,
        liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
        mixedTradeLogRepository: {
          appendCompletionIdempotent: () => {
            throw new Error('ordinary switch cannot complete protective episode');
          },
        },
      });
      let submissions = 0;
      native.setSubmitBehavior(async () => {
        const orderId = ['S1', 'S2', 'REBUY'][submissions++];
        if (orderId === undefined) throw new Error('unexpected duplicate broker submission');

        return orderId;
      });
      const cancelIssued = Promise.withResolvers<undefined>();
      const releaseCancel = Promise.withResolvers<undefined>();
      native.setCancelBeforeReply(async () => {
        cancelIssued.resolve();
        await releaseCancel.promise;
      });
      const advance = async (receipt: Awaited<ReturnType<typeof f.sink.waitForFresh>>) => {
        const seatAuthorization = captureSwitchSeatAuthorization(registry, 'LONG');
        return manager.advancePendingSwitch({
          direction: 'LONG',
          positions: f.snapshot.getView().positions,
          canContinue: () =>
            seatAuthorization() &&
            f.sink.isCurrent(receipt) &&
            f.snapshot.isCurrent(receipt.snapshotToken, { account: false, positions: true }),
        });
      };

      try {
        // 同标的既往卖单是无关操作，不能被移仓预算按 symbol 一并计入。
        f.commit('UNRELATED', 'SELL', '100', '10000', 100, -3000, original.symbol, true);
        f.commit('BUY-40', 'BUY', '1', '40', 40, -2000, original.symbol, true);
        f.commit('BUY-60', 'BUY', '1', '60', 60, -1000, original.symbol, true);
        await monitor.initialize();
        await monitor.recoverOrderTrackingFromSnapshot([]);
        monitor.startRuntime();
        f.sink.start();
        const baseline = await f.sink.waitForFresh();
        const started = await manager.startSwitchOnDistance({
          direction: 'LONG',
          monitorPrice: '20000',
          positions: f.snapshot.getView().positions,
          canContinue: captureSwitchSeatAuthorization(registry, 'LONG'),
        });
        expect(started.started).toBeTrue();
        await advance(baseline);
        expect(native.nativeSubmitObservations()).toMatchObject([
          { side: 'SELL', orderType: 'ELO', quantity: '100' },
        ]);
        await waitUntil(() => h.timers.some((timer) => !timer.cleared && timer.delay === 1000));
        h.setNow(T + 1001);
        for (const timer of [...h.timers].filter((entry) => !entry.cleared && entry.delay === 1000))
          timer.callback();

        await cancelIssued.promise;
        const rows =
          parentFill === 0
            ? []
            : [
                {
                  orderId: 'S1',
                  tradeId: 'S1-EXECUTION',
                  symbol: original.symbol,
                  quantity: '40',
                  price: '2',
                  tradeDoneAtMs: T + 1100,
                },
              ];
        native.setExecutionReplies(rows);
        native.emitOrderChangedFrame({
          ...original,
          status: 'Canceled',
          executedQuantity: String(parentFill),
          executedPrice: parentFill === 0 ? '0' : '2',
          executionTimeMs: parentFill === 0 ? null : T + 1100,
          updatedAtMs: T + 1200,
        });
        releaseCancel.resolve();
        await waitUntil(() =>
          monitor.getPendingSellOrders(original.symbol).some((order) => order.orderId === 'S2'),
        );

        expect(native.nativeSubmitObservations()[1]).toMatchObject({
          side: 'SELL',
          orderType: 'MO',
          quantity: String(remaining),
        });
        expect(monitor.getSellOperationOrderIds('S1')).toEqual(['S1', 'S2']);
        expect(monitor.getSellOperationOrderIds('UNRELATED')).toEqual(['UNRELATED']);
        await f.sink.waitForFresh();
        blockRefresh = true;
        native.setStockPositions([]);
        native.setExecutionReplies([
          ...rows,
          {
            orderId: 'S2',
            tradeId: 'S2-A',
            symbol: original.symbol,
            quantity: String(remaining / 2),
            price: '2',
            tradeDoneAtMs: T + 1300,
          },
          {
            orderId: 'S2',
            tradeId: 'S2-B',
            symbol: original.symbol,
            quantity: String(remaining / 2),
            price: '4',
            tradeDoneAtMs: T + 1400,
          },
        ]);
        const successor = {
          ...original,
          orderId: 'S2',
          tradeId: 'S2-B',
          orderType: 'MO' as const,
          status: 'Filled' as const,
          quantity: String(remaining),
          executedQuantity: String(remaining),
          executedPrice: '3',
          executionTimeMs: T + 1400,
          updatedAtMs: T + 1500,
        };
        native.emitOrderChangedFrame(successor);
        await refreshIssued.promise;
        const afterFill = f.recorder.getSellRecordByOrderId('S2');
        expect(afterFill?.costAmount).toBe(String(remaining * 3));
        expect(f.recorder.getSellRecordByOrderId('S1')?.costAmount ?? '0').toBe(
          String(parentFill * 2),
        );
        expect(f.recorder.getSellRecordByOrderId('UNRELATED')?.costAmount).toBe('10000');
        if (parentFill === 0) expect(f.recorder.getExecutionFact('S1')).toBeNull();

        // tracking recovery 与买单清理不应删除本次操作身份；完整生命周期 clear 才释放它。
        await monitor.recoverOrderTrackingFromSnapshot([]);
        f.recorder.clearBuyOrders(original.symbol, true);
        expect(monitor.getSellOperationOrderIds('S1')).toEqual(['S1', 'S2']);
        await advance(baseline);
        expect(native.nativeSubmitObservations()).toHaveLength(2);
        releaseRefresh.resolve();
        const fresh = await f.sink.waitForFresh();
        await advance(fresh);
        if (revisionPrice === null) {
          await advance(fresh);
        } else {
          let waitingQuote: Promise<unknown> | null = null;
          if (retryBeforeRevision) {
            // 真实 executor 门禁关闭产生无 accepted ID 的提交结果；状态机需保留有限重试而非旧预算。
            executorAllowed = false;
            await advance(fresh);
            expect(native.nativeSubmitObservations()).toHaveLength(2);
            h.setNow(T + 20000);
          } else {
            blockNewQuote = true;
            waitingQuote = advance(fresh);
            await quoteIssued.promise;
          }

          native.setExecutionReplies(rows.map((row) => ({ ...row, price: revisionPrice })));
          native.emitOrderChangedFrame({
            ...original,
            status: 'Canceled',
            executedQuantity: '40',
            executedPrice: revisionPrice,
            executionTimeMs: T + 1100,
            updatedAtMs: T + 1600,
          });

          await waitUntil(
            () => f.recorder.getSellRecordByOrderId('S1')?.costAmount === revisionAmount,
          );
          releaseQuote.resolve();
          if (waitingQuote !== null) await waitingQuote;

          expect(native.nativeSubmitObservations()).toHaveLength(2);
          executorAllowed = true;
          await advance(await f.sink.waitForFresh());
        }

        expect(native.nativeSubmitObservations()).toHaveLength(3);
        expect(native.nativeSubmitObservations()[2]).toMatchObject({
          side: 'BUY',
          symbol: 'NEW_BULL.HK',
          orderType: 'ELO',
          quantity: expectedBuy,
        });

        expect(registry.getSeatState('LONG')).toMatchObject({
          symbol: 'NEW_BULL.HK',
          status: 'ACTIVATING',
        });
        native.emitOrderChangedFrame(successor);
        await advance(await f.sink.waitForFresh());
        expect(native.nativeSubmitObservations()).toHaveLength(3);
        expect(f.recorder.getSellRecordByOrderId('S2')?.costAmount).toBe(afterFill?.costAmount);
        // BUY 已 accepted 后再修订关闭单，只更新事实，不追补或提交第二张回补单。
        native.setExecutionReplies([
          {
            orderId: 'S2',
            tradeId: 'S2-REVISED',
            symbol: original.symbol,
            quantity: String(remaining),
            price: '4',
            tradeDoneAtMs: T + 1400,
          },
        ]);
        native.emitOrderChangedFrame({ ...successor, executedPrice: '4', updatedAtMs: T + 1700 });
        await waitUntil(
          () => f.recorder.getSellRecordByOrderId('S2')?.costAmount === String(remaining * 4),
        );
        await advance(await f.sink.waitForFresh());
        expect(native.nativeSubmitObservations()).toHaveLength(3);
        expect(closedCounts.get('S1')).toBe(1);
        expect(closedCounts.get('S2')).toBe(1);
        await monitor.stopRuntimeAndDrain();
        monitor.clearTrackedOrders();
        expect(monitor.getSellOperationOrderIds('S1')).toEqual(['S1']);
        f.recorder.resetAll();
        expect(f.recorder.getSellRecordByOrderId('S1')).toBeNull();
        expect(f.recorder.getSellRecordByOrderId('S2')).toBeNull();
      } finally {
        releaseCancel.resolve();
        releaseRefresh.resolve();
        releaseQuote.resolve();
        await monitor.stopRuntimeAndDrain();
        await monitor.teardown();
        await f.sink.stopAndDrain();
      }
    },
  );
});
