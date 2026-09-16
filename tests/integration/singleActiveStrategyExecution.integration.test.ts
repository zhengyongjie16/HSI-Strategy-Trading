/**
 * 单策略执行集成：补齐真实保护清仓、订单终态、PostTrade freshness 与延迟卖出之间的交接。
 * 仅使用离线 SDK、行情源和外围风险替身，不启动账户或应用入口。
 */
import { describe, expect, it } from 'bun:test';
import { rejects } from 'node:assert/strict';
import { OrderSide, OrderStatus, OrderType } from 'longbridge';
import { createStrategyEmitter } from '../../src/main/businessEventProgram/emissionAdapter.js';
import { createPostTradeConsistencyRuntime } from '../../src/app/runtime/createPostTradeConsistencyRuntime.js';
import { createOrderRecorder } from '../../src/core/orderRecorder/index.js';
import { createOrderMonitor } from '../../src/core/trader/orderMonitor/index.js';
import { createOrderHoldRegistry } from '../../src/core/trader/orderHoldRegistry.js';
import { createAccountService } from '../../src/core/trader/accountService.js';
import { createOrderExecutor } from '../../src/core/trader/orderExecutor/index.js';
import { createUnrealizedLossMonitor } from '../../src/core/riskController/unrealizedLossMonitor.js';
import { createSignalProcessor } from '../../src/core/signalProcessor/index.js';
import { createBuyProcessor } from '../../src/main/asyncProgram/buyProcessor/index.js';
import type { BuyRiskCheckContext, Trader } from '../../src/types/services.js';
import type { ProcessedSellSignal } from '../../src/core/signalProcessor/types.js';
import { createSellProcessor } from '../../src/main/asyncProgram/sellProcessor/index.js';
import {
  createBuyTaskQueue,
  createSellTaskQueue,
} from '../../src/main/asyncProgram/tradeTaskQueue/index.js';
import { createTradeContextMock } from '../../mock/longbridge/tradeContextMock.js';
import { createTradingConfig } from '../../mock/factories/configFactory.js';
import {
  createPushOrderChanged,
  createStockPositionsResponse,
} from '../../mock/factories/tradeFactory.js';
import type { ExecutableSignal } from '../../src/types/signal.js';
import {
  prepareFixture,
  createHarness,
  marketContext,
} from '../core/strategy/intradayRegression/fixtures.js';
import { createLastState, waitUntil } from '../main/asyncProgram/utils.js';
import {
  createDailyLossTrackerDouble,
  createDoomsdayProtectionDouble,
  createLiquidationCooldownTrackerDouble,
  createMarketDataClientDouble,
  createMonitorConfigDouble,
  createMonitorContextDouble,
  createPositionDouble,
  createProtectiveLiquidationEpisodeTrackerDouble,
  createQuoteDouble,
  createRateLimiterDouble,
  createRiskCheckerDouble,
  createTerminationDouble,
  createTradeContextDouble,
  createTraderDouble,
} from '../helpers/testDoubles.js';

/** 装配真实下单、订单终态和刷新流程；唯一可控阻塞位于账户服务的上游请求。 */
async function createExecutionFixture(smartCloseEnabled = false) {
  const h = createHarness();
  const generatedAtMs = Date.parse('2026-02-16T01:31:00.000Z');
  h.setNow(generatedAtMs);
  const strategy = prepareFixture({
    signals: {
      BUYCALL: '(K>1000)',
      SELLCALL: '(K>-1000)',
      BUYPUT: '(K>1000)',
      SELLPUT: '(K>1000)',
    },
    verification: {
      buy: { delaySeconds: 0, indicators: [] },
      sell: { delaySeconds: 60, indicators: ['K'] },
    },
  }).create(h.deps);
  const broker = createTradeContextMock({ now: () => h.deps.clock.now().getTime() });
  const ctx = createTradeContextDouble(broker);
  const rateLimiter = createRateLimiterDouble();
  const accountService = createAccountService({ ctx, rateLimiter });
  const orderRecorder = createOrderRecorder({ ctx, rateLimiter });
  orderRecorder.recordLocalBuy('BULL.HK', 2, 400, true, generatedAtMs - 1000);
  const config = createMonitorConfigDouble({ smartCloseEnabled });
  const tradingConfig = createTradingConfig({ monitor: config });
  const riskChecker = createRiskCheckerDouble({
    checkUnrealizedLoss: () => ({ shouldLiquidate: true, quantity: 400, reason: '离线保护清仓' }),
  });
  const monitorContext = createMonitorContextDouble({
    config,
    strategy,
    orderRecorder,
    riskChecker,
  });
  const oldPosition = createPositionDouble({
    symbol: 'BULL.HK',
    quantity: 400,
    availableQuantity: 400,
  });
  const lastState = createLastState({ cachedPositions: [oldPosition] });
  lastState.positionCache.update([oldPosition]);
  broker.seedStockPositions(
    createStockPositionsResponse({ symbol: 'BULL.HK', quantity: 400, availableQuantity: 400 }),
  );
  let quotePrice = 1;
  let quoteReads = 0;
  const marketDataClient = createMarketDataClientDouble({
    getQuotes: async (symbols) => {
      quoteReads += 1;
      return new Map(
        [...symbols].map((symbol) => [symbol, createQuoteDouble(symbol, quotePrice, 100)]),
      );
    },
  });
  const termination = createTerminationDouble();
  const dailyLossTracker = createDailyLossTrackerDouble();
  const liquidationCooldownTracker = createLiquidationCooldownTrackerDouble();
  const protectiveLiquidationEpisodeTracker = createProtectiveLiquidationEpisodeTrackerDouble();
  const cacheManager = { clearCache: () => {}, getPendingOrders: async () => [] };
  let boundTrader: Trader | null = null;
  const postTrade = createPostTradeConsistencyRuntime({
    termination,
    getTrader: () => {
      if (boundTrader === null) throw new Error('Trader 尚未装配');

      return boundTrader;
    },
    lastState,
    scheduler: h.deps.scheduler,
    onPositionsCommitted: async () => {},
  });
  const orderMonitor = createOrderMonitor({
    ctx,
    rateLimiter,
    cacheManager,
    marketDataClient,
    orderRecorder,
    dailyLossTracker,
    orderHoldRegistry: createOrderHoldRegistry(),
    protectiveLiquidationEpisodeTracker,
    persistProtectiveLiquidationExecutionProgress: () => {},
    postTradeConsistencyRuntime: postTrade,
    tradingConfig,
    symbolRegistry: monitorContext.symbolRegistry,
    isContinuousTradingAllowed: () => lastState.canTrade === true && lastState.isTradingEnabled,
    now: h.deps.clock.now,
    scheduleTimer: h.deps.scheduler.scheduleTimer,
    clearTimer: h.deps.scheduler.clearTimer,
    termination,
  });
  const executor = createOrderExecutor({
    ctx,
    rateLimiter,
    cacheManager,
    marketDataClient,
    orderRecorder,
    orderMonitor,
    unrealizedLossBuyGate: riskChecker,
    tradingConfig,
    symbolRegistry: monitorContext.symbolRegistry,
    isExecutionAllowed: () => lastState.isTradingEnabled,
    isContinuousTradingAllowed: () => lastState.canTrade === true,
    now: h.deps.clock.now,
    readCurrentTradingDayInfo: () => ({
      dateKey: '2026-02-16',
      info: { isTradingDay: true, isHalfDay: false },
    }),
  });
  const positionsRelease = Promise.withResolvers<undefined>();
  let positionsRequested = false;
  const executedSignals: ExecutableSignal[] = [];
  const trader = createTraderDouble({
    ...executor,
    orderRecorder,
    executeSignals: async (signals) => {
      executedSignals.push(...signals);
      return executor.executeSignals(signals);
    },
    getStockPositions: async () => {
      positionsRequested = true;
      await positionsRelease.promise;
      return accountService.getStockPositions();
    },
    hasPendingProtectiveLiquidationOrders: orderMonitor.hasPendingProtectiveLiquidationOrders,
  });
  boundTrader = trader;
  postTrade.bindBusinessDeps({
    monitorContext,
    dailyLossTracker,
    liquidationCooldownTracker,
    protectiveLiquidationEpisodeTracker,
    mixedTradeLogRepository: { appendCompletionIdempotent: () => {} },
  });
  const signalProcessor = createSignalProcessor({
    tradingConfig,
    liquidationCooldownTracker,
    reportFatalError: () => {},
  });
  const processedSells: ProcessedSellSignal[] = [];
  const buyTaskQueue = createBuyTaskQueue();
  const sellTaskQueue = createSellTaskQueue();
  const sellProcessor = createSellProcessor({
    clock: h.deps.clock,
    scheduler: h.deps.scheduler,
    termination,
    taskQueue: sellTaskQueue,
    monitorContext,
    trader,
    signalProcessor: {
      ...signalProcessor,
      processSellSignals: (params) => {
        const results = signalProcessor.processSellSignals(params);
        processedSells.push(...results);
        return results;
      },
    },
    marketDataClient,
    getLastState: () => lastState,
    getCanProcessTask: () => lastState.isTradingEnabled,
    postTradeConsistencyRuntime: postTrade,
  });
  await orderMonitor.initialize();
  await orderMonitor.recoverOrderTrackingFromSnapshot([]);
  postTrade.start();
  return {
    h,
    generatedAtMs,
    strategy,
    broker,
    orderMonitor,
    orderRecorder,
    monitorContext,
    lastState,
    postTrade,
    trader,
    signalProcessor,
    sellProcessor,
    buyTaskQueue,
    sellTaskQueue,
    termination,
    executedSignals,
    processedSells,
    positionsRelease,
    tradingConfig,
    marketDataClient,
    riskChecker,
    dailyLossTracker,
    getPositionsRequested: () => positionsRequested,
    getQuoteReads: () => quoteReads,
    setQuotePrice: (value: number) => {
      quotePrice = value;
    },
  };
}

describe('single active strategy execution integration', () => {
  it('hands real protection settlement to delayed SELL through actual PostTrade freshness and SDK submission', async () => {
    const f = await createExecutionFixture();
    try {
      const emitter = createStrategyEmitter(
        {
          clock: f.h.deps.clock,
          marketDataClient: f.marketDataClient,
          monitorContext: f.monitorContext,
          lastState: f.lastState,
          tradingConfig: f.tradingConfig,
          buyTaskQueue: f.buyTaskQueue,
          sellTaskQueue: f.sellTaskQueue,
          monitorDisplayRuntime: { requestRender: () => {} },
          termination: f.termination,
        },
        {
          dayKey: '2026-02-16',
          routes: [
            {
              direction: 'LONG',
              symbol: 'BULL.HK',
              seatVersion: f.monitorContext.symbolRegistry.getSeatVersion('LONG'),
              hasFilledBuyOrders: f.orderRecorder.getBuyOrdersForSymbol('BULL.HK', true).length > 0,
            },
          ],
        },
      );
      const origin = marketContext(50, 1, f.generatedAtMs);
      f.strategy.onCandlestick(
        { ...origin, seats: origin.seats.filter((seat) => seat.direction === 'LONG') },
        emitter,
      );
      const verificationTimer = f.h.timers[0];
      if (!verificationTimer) throw new Error('策略未创建验证 timer');

      expect(f.sellTaskQueue.isEmpty()).toBeTrue();
      await createUnrealizedLossMonitor({
        maxUnrealizedLossPerSymbol: 1,
      }).monitorDirectionalUnrealizedLoss({
        symbol: 'BULL.HK',
        isLong: true,
        seatVersion: f.monitorContext.symbolRegistry.getSeatVersion('LONG'),
        quote: createQuoteDouble('BULL.HK', 1, 100),
        riskChecker: f.riskChecker,
        trader: f.trader,
        orderRecorder: f.orderRecorder,
        dailyLossTracker: f.dailyLossTracker,
      });
      expect(f.broker.getCalls('submitOrder')).toHaveLength(1);
      expect(f.executedSignals[0]?.isProtectiveLiquidation).toBeTrue();
      expect(f.orderRecorder.getBuyOrdersForSymbol('BULL.HK', true)).toEqual([]);
      expect(f.lastState.positionCache.get('BULL.HK')?.quantity).toBe(400);
      const protectionId = f.orderMonitor.getPendingSellOrders('BULL.HK')[0]?.orderId;
      if (!protectionId) throw new Error('保护清仓未登记真实挂单');

      // 真实订单监控根据累计成交事实推进 stale；不直接调用 recordSettlementRefreshNeed。
      f.broker.emitOrderChanged(
        createPushOrderChanged({
          orderId: protectionId,
          symbol: 'BULL.HK',
          side: OrderSide.Sell,
          orderType: OrderType.MO,
          status: OrderStatus.PartialWithdrawal,
          submittedQuantity: 400,
          executedQuantity: 100,
          executedPrice: 1,
          updatedAtMs: f.generatedAtMs + 1000,
        }),
      );
      f.broker.flushAllEvents();
      for (const timer of f.h.timers) {
        if (timer !== verificationTimer && !timer.cleared && timer.delay === 0) timer.callback();
      }

      await waitUntil(f.getPositionsRequested);
      expect(f.orderMonitor.getPendingSellOrders('BULL.HK')).toEqual([]);
      expect(f.postTrade.getStatus().staleVersion).toBeGreaterThan(
        f.postTrade.getStatus().currentVersion,
      );

      for (const [index, delta] of [60_000, 65_000, 70_000].entries()) {
        f.h.setNow(f.generatedAtMs + delta);
        f.strategy.onCandlestick(
          {
            ...marketContext(20 - index, index + 2, f.generatedAtMs + delta),
            allowNewEvaluation: false,
            seats: [],
          },
          () => {
            throw new Error('pending 必须回调 T0 的 emitter');
          },
        );
      }

      verificationTimer.callback();
      expect(f.sellTaskQueue.isEmpty()).toBeFalse();
      expect(f.buyTaskQueue.isEmpty()).toBeTrue();
      const quoteReadsBeforeWait = f.getQuoteReads();
      f.sellProcessor.start();
      await waitUntil(() => f.sellTaskQueue.isEmpty());
      expect(f.executedSignals).toHaveLength(1);
      expect(f.broker.getCalls('submitOrder')).toHaveLength(1);
      expect(f.broker.getCalls('cancelOrder')).toEqual([]);
      expect(f.getQuoteReads()).toBe(quoteReadsBeforeWait);
      expect(f.lastState.positionCache.get('BULL.HK')?.quantity).toBe(400);
      f.setQuotePrice(1.23);
      f.broker.seedStockPositions(
        createStockPositionsResponse({ symbol: 'BULL.HK', quantity: 300, availableQuantity: 200 }),
      );
      f.positionsRelease.resolve();
      await f.postTrade.waitForFresh();
      await waitUntil(() => f.executedSignals.length === 2);
      await f.sellProcessor.stopAndDrain();
      expect(f.lastState.positionCache.get('BULL.HK')?.availableQuantity).toBe(200);
      expect(f.h.errors).toEqual([]);
      expect(f.termination.getFatalState()).toEqual({ hasFatalError: false });
      const sell = f.executedSignals[1];
      // T0 是生成时刻加配置 delay，不能被回调到达的 T0+10s 改写。
      expect(sell?.triggerTime?.getTime()).toBe(f.generatedAtMs + 60_000);
      expect(sell?.quantity).toBe(200);
      expect(sell?.isProtectiveLiquidation).not.toBeTrue();
      expect(f.broker.getCalls('submitOrder')).toHaveLength(2);
      const payload = f.broker.getCalls('submitOrder')[1]?.args[0];
      expect(payload).toMatchObject({
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        orderType: OrderType.ELO,
      });

      if (
        typeof payload !== 'object' ||
        payload === null ||
        !('submittedQuantity' in payload) ||
        !('submittedPrice' in payload)
      )
        throw new Error('缺少实际卖出 payload');

      expect(String(payload.submittedQuantity)).toBe('200');
      expect(String(payload.submittedPrice)).toBe('1.23');
      expect(f.orderMonitor.getPendingSellOrders('BULL.HK')).toHaveLength(1);
      expect(f.broker.getCalls('replaceOrder')).toEqual([]);
      expect(f.orderRecorder.getBuyOrdersForSymbol('BULL.HK', true)).toEqual([]);
    } finally {
      f.positionsRelease.resolve();
      await f.sellProcessor.stopAndDrain();
      await f.postTrade.stopAndDrain();
      await f.orderMonitor.stopRuntimeAndDrain();
      f.strategy.destroy();
    }
  });
});

describe('execution authority at buy and clearance boundaries', () => {
  it('keeps an emitter reason ordinary through smart-close HOLD but permits the typed clearance path', async () => {
    const f = await createExecutionFixture(true);
    try {
      const emitter = createStrategyEmitter(
        {
          clock: f.h.deps.clock,
          marketDataClient: f.marketDataClient,
          monitorContext: f.monitorContext,
          lastState: f.lastState,
          tradingConfig: f.tradingConfig,
          buyTaskQueue: f.buyTaskQueue,
          sellTaskQueue: f.sellTaskQueue,
          monitorDisplayRuntime: { requestRender: () => {} },
          termination: f.termination,
        },
        {
          dayKey: '2026-02-16',
          routes: [
            {
              direction: 'LONG',
              symbol: 'BULL.HK',
              seatVersion: f.monitorContext.symbolRegistry.getSeatVersion('LONG'),
              hasFilledBuyOrders: true,
            },
          ],
        },
      );
      emitter({
        action: 'SELLCALL',
        triggerTimeMs: f.generatedAtMs,
        reason: '末日保护程序：策略要求全量清仓',
      });
      f.sellProcessor.start();
      await waitUntil(() => f.processedSells.length === 1);
      await f.sellProcessor.stopAndDrain();
      expect(f.processedSells[0]?.action).toBe('HOLD');
      expect(f.processedSells[0]?.triggerTime?.getTime()).toBe(f.generatedAtMs);
      expect(f.broker.getCalls('submitOrder')).toEqual([]);
      expect(f.executedSignals).toEqual([]);
      expect(f.orderRecorder.getBuyOrdersForSymbol('BULL.HK', true)).toHaveLength(1);
      f.h.setNow(Date.parse('2026-02-16T07:56:00.000Z'));
      f.broker.seedStockPositions(
        createStockPositionsResponse({ symbol: 'BULL.HK', quantity: 300, availableQuantity: 200 }),
      );
      const result = await f.trader.executeDoomsdayClearanceSignals([
        {
          symbol: 'BULL.HK',
          symbolName: null,
          action: 'SELLCALL',
          triggerTime: f.h.deps.clock.now(),
          seatVersion: f.monitorContext.symbolRegistry.getSeatVersion('LONG'),
        },
      ]);
      expect(result.executedOrderIds).toHaveLength(1);
      const payload = f.broker.getCalls('submitOrder')[0]?.args[0];
      expect(payload).toMatchObject({
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        orderType: OrderType.ELO,
      });

      if (typeof payload !== 'object' || payload === null || !('submittedQuantity' in payload))
        throw new Error('缺少 typed 清仓 payload');

      expect(String(payload.submittedQuantity)).toBe('200');
      expect(f.termination.getFatalState()).toEqual({ hasFatalError: false });
    } finally {
      f.positionsRelease.resolve();
      await f.sellProcessor.stopAndDrain();
      await f.postTrade.stopAndDrain();
      await f.orderMonitor.stopRuntimeAndDrain();
      f.strategy.destroy();
    }
  });

  it.each([null, 0, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid monitor quote %s at the actual buy queue without account reads or SDK mutations',
    async (price) => {
      const f = await createExecutionFixture();
      let quoteRequested = false;
      const processor = createBuyProcessor({
        taskQueue: f.buyTaskQueue,
        monitorContext: f.monitorContext,
        trader: f.trader,
        signalProcessor: f.signalProcessor,
        marketDataClient: createMarketDataClientDouble({
          getQuotes: async () => {
            quoteRequested = true;
            const quotes = new Map([['BULL.HK', createQuoteDouble('BULL.HK', 1, 100)]]);
            if (price !== null)
              quotes.set(
                f.monitorContext.config.monitorSymbol,
                createQuoteDouble(f.monitorContext.config.monitorSymbol, price),
              );

            return quotes;
          },
        }),
        doomsdayProtection: createDoomsdayProtectionDouble(),
        getIsHalfDay: () => false,
        now: f.h.deps.clock.now,
        getCanProcessTask: () => true,
        termination: f.termination,
      });
      try {
        f.buyTaskQueue.push({
          type: 'STRATEGY_BUY',
          data: {
            symbol: 'BULL.HK',
            symbolName: null,
            action: 'BUYCALL',
            triggerTime: new Date(f.generatedAtMs),
            seatVersion: f.monitorContext.symbolRegistry.getSeatVersion('LONG'),
          },
        });
        processor.start();
        await waitUntil(() => quoteRequested);
        await processor.stopAndDrain();
        expect(f.getPositionsRequested()).toBeFalse();
        expect(f.broker.getCalls('accountBalance')).toEqual([]);
        expect(f.broker.getCalls('submitOrder')).toEqual([]);
        expect(f.executedSignals).toEqual([]);
        expect(f.termination.getFatalState()).toEqual({ hasFatalError: false });
      } finally {
        f.positionsRelease.resolve();
        await processor.stopAndDrain();
        await f.postTrade.stopAndDrain();
        await f.orderMonitor.stopRuntimeAndDrain();
        f.strategy.destroy();
      }
    },
  );

  it('fails fast if the internal buy risk context bypasses the monitor quote admission contract', async () => {
    const f = await createExecutionFixture();
    try {
      const invalidContext = {
        trader: f.trader,
        riskChecker: f.riskChecker,
        orderRecorder: f.orderRecorder,
        longQuote: createQuoteDouble('BULL.HK', 1, 100),
        shortQuote: null,
        monitorQuote: null,
        longSymbol: 'BULL.HK',
        shortSymbol: 'BEAR.HK',
        longSymbolName: null,
        shortSymbolName: null,
        currentTime: new Date(f.generatedAtMs),
        isHalfDay: false,
        doomsdayProtection: createDoomsdayProtectionDouble(),
        config: f.monitorContext.config,
      } as unknown as BuyRiskCheckContext;
      await rejects(
        f.signalProcessor.applyRiskChecks(
          [
            {
              symbol: 'BULL.HK',
              symbolName: null,
              action: 'BUYCALL',
              seatVersion: f.monitorContext.symbolRegistry.getSeatVersion('LONG'),
            },
          ],
          invalidContext,
        ),
      );
      expect(f.getPositionsRequested()).toBeFalse();
      expect(f.broker.getCalls('submitOrder')).toEqual([]);
    } finally {
      f.positionsRelease.resolve();
      await f.postTrade.stopAndDrain();
      await f.orderMonitor.stopRuntimeAndDrain();
      f.strategy.destroy();
    }
  });
});
