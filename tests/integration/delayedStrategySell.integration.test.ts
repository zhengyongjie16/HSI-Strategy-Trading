/**
 * T16：真实策略私有延迟验证 → 宿主 emitter → 卖出处理器集成。
 * 已生成 SELL 在清仓清记录后仍可回流；freshness、当前席位/门禁和最新可卖事实分别约束后续执行。
 */
import { describe, expect, it } from 'bun:test';
import { createStrategyEmitter } from '../../src/main/businessEventProgram/emissionAdapter.js';
import { createOrderExecutor } from '../../src/core/trader/orderExecutor/index.js';
import { createStockPositionsResponse } from '../../mock/factories/tradeFactory.js';
import { createTradeContextMock } from '../../mock/longbridge/tradeContextMock.js';
import { createSellProcessor } from '../../src/main/asyncProgram/sellProcessor/index.js';
import {
  createBuyTaskQueue,
  createSellTaskQueue,
} from '../../src/main/asyncProgram/tradeTaskQueue/index.js';
import { createSignalProcessor } from '../../src/core/signalProcessor/index.js';
import { createTradingConfig } from '../../mock/factories/configFactory.js';
import type { LastState } from '../../src/types/state.js';
import type { Signal } from '../../src/types/signal.js';
import type { OrderRecorder } from '../../src/types/services.js';
import {
  prepareFixture,
  createHarness,
  marketContext,
} from '../core/strategy/intradayRegression/fixtures.js';
import { waitUntil } from '../main/asyncProgram/utils.js';
import {
  createLiquidationCooldownTrackerDouble,
  createMarketDataClientDouble,
  createMonitorConfigDouble,
  createMonitorContextDouble,
  createOrderRecorderDouble,
  createOrderMonitorDouble,
  createRateLimiterDouble,
  createTradeContextDouble,
  createPositionCacheDouble,
  createPositionDouble,
  createQuoteDouble,
  createTerminationDouble,
  createTraderDouble,
} from '../helpers/testDoubles.js';

describe('delayed strategy sell integration', () => {
  it.each(['active', 'gate-closed', 'route-changed'])(
    'rechecks %s without rechecking cleared origin buy records',
    async (scenario) => {
      const h = createHarness();
      const now = Date.parse('2026-02-16T01:31:00.000Z');
      h.setNow(now);
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
      let buyOrders: ReturnType<OrderRecorder['getBuyOrdersForSymbol']> = [
        {
          orderId: 'FILLED-BUY',
          symbol: 'BULL.HK',
          executedPrice: 1,
          executedQuantity: 100,
          executedTime: now - 1000,
          submittedAt: undefined,
          updatedAt: undefined,
        },
      ];
      const orderRecorder = createOrderRecorderDouble({ getBuyOrdersForSymbol: () => buyOrders });
      const config = createMonitorConfigDouble({ smartCloseEnabled: false });
      const monitorContext = createMonitorContextDouble({ config, strategy, orderRecorder });
      const lastState: LastState = {
        canTrade: true,
        isHalfDay: false,
        openProtectionActive: false,
        currentDayKey: '2026-02-16',
        lifecycleState: 'ACTIVE',
        pendingOpenRebuild: false,
        isTradingEnabled: true,
        cachedAccount: null,
        cachedPositions: [],
        positionCache: createPositionCacheDouble(),
        cachedTradingDayInfo: null,
        tradingCalendarSnapshot: new Map(),
        allTradingSymbols: new Set(['BULL.HK']),
      };
      const termination = createTerminationDouble();
      const buyTaskQueue = createBuyTaskQueue();
      const sellTaskQueue = createSellTaskQueue();
      const tradingConfig = createTradingConfig({ monitor: config });
      const emitter = createStrategyEmitter(
        {
          clock: h.deps.clock,
          marketDataClient: createMarketDataClientDouble(),
          monitorContext,
          lastState,
          tradingConfig,
          buyTaskQueue,
          sellTaskQueue,
          monitorDisplayRuntime: { requestRender: () => {} },
          termination,
        },
        {
          dayKey: '2026-02-16',
          routes: [
            {
              direction: 'LONG',
              symbol: 'BULL.HK',
              seatVersion: monitorContext.symbolRegistry.getSeatVersion('LONG'),
              hasFilledBuyOrders: orderRecorder.getBuyOrdersForSymbol('BULL.HK', true).length > 0,
            },
          ],
        },
      );
      const origin = marketContext(50, 1, now);
      strategy.onCandlestick(
        { ...origin, seats: origin.seats.filter((seat) => seat.direction === 'LONG') },
        emitter,
      );
      expect(h.timers).toHaveLength(1);
      expect(sellTaskQueue.isEmpty()).toBe(true);
      // 清仓已提交且记录已清，但后续持仓请求还未发布新的可卖事实。
      buyOrders = [];
      const sample = marketContext(20, 2, now + 65_000);
      strategy.onCandlestick({ ...sample, allowNewEvaluation: false, seats: [] }, () => {
        throw new Error('protected sample must not emit');
      });
      h.setNow(now + 70_000);
      if (scenario === 'gate-closed') lastState.isTradingEnabled = false;

      if (scenario === 'route-changed')
        monitorContext.symbolRegistry.updateSeatStateWithVersionBump('LONG', {
          ...monitorContext.symbolRegistry.getSeatState('LONG'),
          status: 'ACTIVE',
          symbol: 'BULL.HK',
          lastSeatActivatedAt: now,
        });

      for (const timer of h.timers) timer.callback();

      expect(h.errors).toEqual([]);
      expect(termination.getFatalState()).toEqual({ hasFatalError: false });
      expect(buyTaskQueue.isEmpty()).toBe(true);
      expect(sellTaskQueue.isEmpty()).toBe(scenario !== 'active');
      if (scenario !== 'active') {
        strategy.destroy();
        return;
      }

      const fresh = Promise.withResolvers<undefined>();
      let waiting = false;
      const submitted: Signal[] = [];
      const broker = createTradeContextMock({ now: () => h.deps.clock.now().getTime() });
      const marketDataClient = createMarketDataClientDouble({
        getQuotes: async () => new Map([['BULL.HK', createQuoteDouble('BULL.HK', 1.1, 100)]]),
      });
      let coordinationReads = 0;
      const executor = createOrderExecutor({
        ctx: createTradeContextDouble(broker),
        rateLimiter: createRateLimiterDouble(),
        marketDataClient,
        cacheManager: { clearCache: () => {}, getPendingOrders: async () => [] },
        orderMonitor: createOrderMonitorDouble({
          getPendingSellOrders: () => {
            coordinationReads += 1;
            return [];
          },
        }),
        orderRecorder,
        unrealizedLossBuyGate: monitorContext.riskChecker,
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
      const trader = createTraderDouble({
        executeSignals: async (signals) => {
          submitted.push(...signals);
          return executor.executeSignals(signals);
        },
      });
      const processor = createSellProcessor({
        clock: h.deps.clock,
        scheduler: h.deps.scheduler,
        termination,
        taskQueue: sellTaskQueue,
        monitorContext,
        trader,
        signalProcessor: createSignalProcessor({
          tradingConfig,
          liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
        }),
        marketDataClient,
        getLastState: () => lastState,
        getCanProcessTask: () => lastState.isTradingEnabled,
        postTradeConsistencyRuntime: {
          waitForFresh: () => {
            waiting = true;
            return fresh.promise;
          },
          onFreshReached: () => () => {},
        },
      });
      processor.start();
      try {
        await waitUntil(() => waiting);
        expect(submitted).toEqual([]);
        expect(broker.getCalls('submitOrder')).toHaveLength(0);
        const position = createPositionDouble({
          symbol: 'BULL.HK',
          quantity: 300,
          availableQuantity: 200,
        });
        broker.seedStockPositions(
          createStockPositionsResponse({
            symbol: 'BULL.HK',
            quantity: 300,
            availableQuantity: 200,
          }),
        );
        lastState.cachedPositions = [position];
        lastState.positionCache.update([position]);
        fresh.resolve();
        await waitUntil(() => broker.getCalls('submitOrder').length === 1);
        expect(submitted[0]?.action).toBe('SELLCALL');
        expect(submitted[0]?.quantity).toBe(200);
        expect(coordinationReads).toBeGreaterThan(0);
        const payload = broker.getCalls('submitOrder')[0]?.args[0];
        if (
          typeof payload !== 'object' ||
          payload === null ||
          !('submittedQuantity' in payload) ||
          !('submittedPrice' in payload)
        )
          throw new Error('missing submitted sell payload');

        expect(Number(String(payload.submittedQuantity))).toBe(200);
        expect(Number(String(payload.submittedPrice))).toBeCloseTo(1.1);
        expect(orderRecorder.getBuyOrdersForSymbol('BULL.HK', true)).toEqual([]);
      } finally {
        fresh.resolve();
        await processor.stopAndDrain();
        strategy.destroy();
      }
    },
  );
});
