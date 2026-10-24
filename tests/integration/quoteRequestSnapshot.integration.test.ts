/**
 * 行情请求快照竞态回归。
 * 连接真实 quoteClient、订阅 owner、SymbolRegistry、周期换标、普通 BUY 与 FIFO fatal 通道；
 * 经中性行情 fixture 在 SDK IO 边界播种报价/轮证并暂停首次 realtime 结果，验证另一方向合法退订不会破坏原请求。
 */
import { describe, expect, it } from 'bun:test';
import { createWarrantCandidateSearch } from '../../src/application/autoSearch/candidateSearch.js';
import { createOrdinaryBuyWorkflow } from '../../src/application/ordinaryBuy/index.js';
import { createSeatSwitchWorkflow } from '../../src/application/seatSwitch/index.js';
import { createSymbolRegistry } from '../../src/domain/seat/symbolRegistry.js';
import { validateSignalSeat } from '../../src/domain/seat/seatPolicy.js';
import { getTradingMinutesSinceOpen } from '../../src/domain/tradingSession/index.js';
import { createBuyProcessor } from '../../src/runtime/asyncProgram/buyProcessor/index.js';
import { createBuyTaskQueue } from '../../src/runtime/asyncProgram/tradeTaskQueue/index.js';
import { createTerminationRuntime } from '../../src/runtime/lifecycle/terminationRuntime.js';
import { createQuoteSubscriptionRuntime } from '../../src/runtime/quoteSubscriptionRuntime/index.js';
import type { Quote } from '../../src/types/quote.js';
import { createTradingConfig } from '../../mock/factories/configFactory.js';
import { createSnapshotFixture } from '../helpers/accountPositionSnapshot.js';
import { createDiagnosticObserverDouble } from '../helpers/diagnostics.js';
import {
  captureSwitchSeatAuthorization,
  getDefaultAutoSearchConfig,
} from '../helpers/seatTestUtils.js';
import {
  createAccountSnapshotDouble,
  createLiquidationCooldownTrackerDouble,
  createLoggerDouble,
  createRiskCheckerDouble,
  createSignalDouble,
  createTradeRuntimeDouble,
} from '../helpers/testDoubles.js';
import { createMarketFixture } from '../infrastructure/longbridge/market/marketFixture.js';

describe('quote request metadata snapshot', () => {
  it.each(['cleared', 'rebound'] as const)(
    'keeps LONG BUY authorized without fatal while periodic SHORT switch is %s',
    async (shortState) => {
      const rebind = shortState === 'rebound';
      const baseConfig = createTradingConfig();
      const config = createTradingConfig({
        monitor: {
          ...baseConfig.monitor,
          longSymbol: '',
          shortSymbol: '',
          autoSearchConfig: { ...getDefaultAutoSearchConfig(), switchIntervalMinutes: 5 },
        },
      });
      const logger = createLoggerDouble();
      const now = new Date('2026-02-16T02:00:00.000Z');
      const clock = { now: () => now };
      const symbolRegistry = createSymbolRegistry(config.monitor);
      for (const direction of ['LONG', 'SHORT'] as const) {
        symbolRegistry.updateSeatStateWithVersionBump(direction, {
          ...symbolRegistry.getSeatState(direction),
          status: 'ACTIVE',
          symbol: direction === 'LONG' ? 'BULL.HK' : 'BEAR.HK',
          lastSeatActivatedAt: Date.parse('2026-02-16T01:30:00.000Z'),
        });
      }

      const longSeat = symbolRegistry.getSeatState('LONG');
      const signal = {
        ...createSignalDouble('BUYCALL', 'BULL.HK'),
        seatVersion: symbolRegistry.getSeatVersion('LONG'),
      };
      const snapshot = await createSnapshotFixture({
        account: createAccountSnapshotDouble('100000'),
        positions: [],
      });
      const { client, controller } = await createMarketFixture();
      const marketDataClient = {
        ...client,
        getQuotes: (symbols: Iterable<string>) => client.getQuotes([...symbols]),
      };
      const realtimeGate = controller.pauseFirstRealtimeQuote();
      controller.seedQuotes([
        {
          symbol: 'HSI.HK',
          name: '恒指',
          price: '20000',
          previousClose: '19800',
          timestampMs: now.getTime(),
        },
        {
          symbol: 'BULL.HK',
          name: '入口牛证',
          price: '0.9',
          previousClose: '0.912345678901234567',
          timestampMs: now.getTime(),
          lotSize: 100,
        },
        {
          symbol: 'BEAR.HK',
          name: '入口熊证',
          price: '0.8',
          previousClose: '0.812345678901234567',
          timestampMs: now.getTime(),
          lotSize: 500,
        },
      ]);

      controller.seedWarrants(
        'HSI.HK',
        rebind
          ? [
              {
                symbol: 'NEW_BEAR.HK',
                name: '新熊证',
                price: '9.9',
                callPrice: '20100',
                toCallPrice: '-0.004',
                turnover: '10000000',
                direction: 'BEAR',
              },
            ]
          : [],
      );
      const queue = createBuyTaskQueue({
        clock,
        diagnostics: createDiagnosticObserverDouble(),
      });
      let canTrade = true;
      const secondaryErrors: unknown[] = [];
      const termination = createTerminationRuntime({
        closeTradingGate: () => {
          canTrade = false;
        },
        closeProducerAdmission: queue.close,
        stopProducers: [],
        onSecondaryError: (error) => {
          secondaryErrors.push(error);
        },
      });
      let executions = 0;
      const tradeRuntime = createTradeRuntimeDouble({
        orderExecutor: {
          executeSignals: async (signals, authorize) => {
            expect(authorize()).toBeTrue();
            expect(signals).toEqual([signal]);
            executions += 1;
            return { executedOrderIds: ['LONG-BUY'], quoteFailures: [] };
          },
        },
      });
      const quoteSubscriptionState = { allTradingSymbols: new Set<string>() };
      const subscriptions = createQuoteSubscriptionRuntime({
        logger,
        tradingConfig: config,
        symbolRegistry,
        marketDataClient,
        orderHoldRegistry: tradeRuntime.orderHoldRegistry,
        quoteSubscriptionState,
        snapshot,
        termination,
      });
      const riskChecker = createRiskCheckerDouble();
      const seatSwitch = createSeatSwitchWorkflow({
        readSwitchPositions: async () => [],
        logger,
        monitorConfig: config.monitor,
        symbolRegistry,
        marketDataClient,
        ...tradeRuntime,
        riskChecker,
        candidateSearch: createWarrantCandidateSearch({
          monitorSymbol: config.monitor.monitorSymbol,
          autoSearchConfig: config.monitor.autoSearchConfig,
          marketDataClient,
          logger,
          getTradingMinutesSinceOpen,
        }),
        clock,
        getTradingCalendarSnapshot: () =>
          new Map([['2026-02-16', { isTradingDay: true, isHalfDay: false }]]),
      });
      const observedQuotes: ReadonlyMap<string, Quote | null>[] = [];
      const workflow = createOrdinaryBuyWorkflow({
        diagnostics: createDiagnosticObserverDouble(),
        logger,
        config: config.monitor,
        doomsdayProtection: config.global.doomsdayProtection,
        symbolRegistry,
        ...tradeRuntime,
        tradeFrequencyReader: tradeRuntime.orderExecutor,
        riskChecker,
        liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
        marketDataClient: {
          ...marketDataClient,
          getQuotes: async (symbols) => {
            const quotes = await marketDataClient.getQuotes(symbols);
            observedQuotes.push(quotes);
            return quotes;
          },
        },
        snapshot,
        getIsHalfDay: () => false,
        now: () => now,
        getCanProcessTask: () => canTrade,
        termination,
      });
      const processor = createBuyProcessor({
        diagnostics: createDiagnosticObserverDouble(),
        logger,
        taskQueue: queue,
        workflow,
        getCanProcessTask: () => canTrade,
        termination,
      });
      try {
        await subscriptions.reconcileFromCurrentTruth();
        subscriptions.start();
        processor.start();
        queue.push({ type: 'STRATEGY_BUY', data: signal });
        await realtimeGate.entered;
        expect(controller.readSymbolCalls('realtimeQuote')[0]).toEqual([
          'HSI.HK',
          'BULL.HK',
          'BEAR.HK',
        ]);

        // SHORT 空仓且无在途订单，真实周期 policy 清席或交付新标 ACTIVATING；LONG 身份不变。
        const switchResult = await seatSwitch.evaluatePeriodicSwitchDue({
          direction: 'SHORT',
          currentTime: now,
          canContinue: captureSwitchSeatAuthorization(symbolRegistry, 'SHORT'),
        });
        expect(controller.readSymbolCalls('warrantList')).toHaveLength(1);
        if (rebind) {
          expect(switchResult.kind).toBe('WAIT');
          expect(symbolRegistry.getSeatState('SHORT')).toMatchObject({
            status: 'SWITCHING',
            symbol: 'BEAR.HK',
          });
          const advanced = await seatSwitch.advancePendingSwitch({
            direction: 'SHORT',
            positions: [],
            canContinue: captureSwitchSeatAuthorization(symbolRegistry, 'SHORT'),
          });
          expect(advanced.driveResult.kind).toBe('COMPLETED');
          expect(symbolRegistry.getSeatState('SHORT')).toMatchObject({
            status: 'ACTIVATING',
            symbol: 'NEW_BEAR.HK',
          });
        } else {
          expect(switchResult.kind).toBe('NOOP');
          expect(symbolRegistry.getSeatState('SHORT')).toMatchObject({
            status: 'EMPTY',
            symbol: null,
            searchFailCountToday: 1,
          });
        }

        // 回归止于换绑交付；未运行激活 owner，ACTIVATING 新标的尚不获首次行情准入。
        await subscriptions.waitForAdmission([]);
        expect([...quoteSubscriptionState.allTradingSymbols]).toEqual(['HSI.HK', 'BULL.HK']);
        expect(controller.readSymbolCalls('unsubscribe')).toEqual([['BEAR.HK']]);

        expect(controller.readSymbolCalls('subscribe')).toEqual([['HSI.HK', 'BULL.HK', 'BEAR.HK']]);

        expect(symbolRegistry.getSeatState('LONG')).toBe(longSeat);
        expect(validateSignalSeat({ signal, symbolRegistry }).valid).toBeTrue();
        realtimeGate.release();
        await processor.stopAndDrain();
        expect(termination.getFatalState()).toEqual({ hasFatalError: false });
        expect(termination.isTerminated()).toBeFalse();
        expect(secondaryErrors).toEqual([]);
        expect(executions).toBe(1);
        expect(observedQuotes).toHaveLength(1);
        expect(observedQuotes[0]?.get('BULL.HK')).toEqual({
          symbol: 'BULL.HK',
          name: '入口牛证',
          price: '0.9',
          prevClose: '0.912345678901234567',
          timestamp: now.getTime(),
          lotSize: 100,
        });

        expect(observedQuotes[0]?.get('BEAR.HK')).toEqual({
          symbol: 'BEAR.HK',
          name: '入口熊证',
          price: '0.8',
          prevClose: '0.812345678901234567',
          timestamp: now.getTime(),
          lotSize: 500,
        });
        expect(client.getQuotes(['BEAR.HK'])).rejects.toThrow('未订阅');
        expect(controller.readSymbolCalls('realtimeQuote')).toHaveLength(1);
      } finally {
        realtimeGate.release();
        await processor.stopAndDrain();
        await subscriptions.stopAndDrain();
      }
    },
  );
});
