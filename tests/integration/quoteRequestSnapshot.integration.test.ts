/**
 * 行情请求快照竞态回归。
 * 连接真实 quoteClient、订阅 owner、SymbolRegistry、周期换标、普通 BUY 与 FIFO fatal 通道；
 * 在 SDK IO 边界控制数据和完成时序，验证另一方向合法退订不会破坏原请求。
 */
import { describe, expect, it } from 'bun:test';
import { Decimal, WarrantStatus, WarrantType } from 'longbridge';
import { createWarrantCandidateSearch } from '../../src/application/autoSearch/candidateSearch.js';
import { createOrdinaryBuyWorkflow } from '../../src/application/ordinaryBuy/index.js';
import { createSeatSwitchWorkflow } from '../../src/application/seatSwitch/index.js';
import { createSymbolRegistry } from '../../src/domain/seat/symbolRegistry.js';
import { validateSignalSeat } from '../../src/domain/seat/seatPolicy.js';
import { getTradingMinutesSinceOpen } from '../../src/domain/tradingSession/index.js';
import { createMarketDataClient } from '../../src/infrastructure/longbridge/market/quoteClient.js';
import { createBuyProcessor } from '../../src/runtime/asyncProgram/buyProcessor/index.js';
import { createBuyTaskQueue } from '../../src/runtime/asyncProgram/tradeTaskQueue/index.js';
import { createTerminationRuntime } from '../../src/runtime/lifecycle/terminationRuntime.js';
import { createQuoteSubscriptionRuntime } from '../../src/runtime/quoteSubscriptionRuntime/index.js';
import type { Quote } from '../../src/types/quote.js';
import { createTradingConfig } from '../../mock/factories/configFactory.js';
import { createQuoteContextMock } from '../../mock/longbridge/quoteContextMock.js';
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
import { createSdkConfigDouble } from '../infrastructure/longbridge/trade/sdkConfigDouble.js';

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
      const quoteContext = createQuoteContextMock();
      quoteContext.seedStaticInfo([
        { symbol: 'HSI.HK', info: { symbol: 'HSI.HK', nameHk: '恒指' } },
        { symbol: 'BULL.HK', info: { symbol: 'BULL.HK', nameHk: '入口牛证', lotSize: 100 } },
        { symbol: 'BEAR.HK', info: { symbol: 'BEAR.HK', nameHk: '入口熊证', lotSize: 500 } },
      ]);

      quoteContext.seedQuotes(
        [
          { symbol: 'HSI.HK', price: '20000', prevClose: '19800' },
          { symbol: 'BULL.HK', price: '0.9', prevClose: '0.912345678901234567' },
          { symbol: 'BEAR.HK', price: '0.8', prevClose: '0.812345678901234567' },
        ].map(({ symbol, price, prevClose }) => ({
          symbol,
          quote: {
            symbol,
            lastDone: new Decimal(price),
            prevClose: new Decimal(prevClose),
            timestamp: now,
          },
        })),
      );

      quoteContext.seedWarrantList(
        'HSI.HK',
        rebind
          ? [
              {
                symbol: 'NEW_BEAR.HK',
                name: '新熊证',
                lastDone: new Decimal('9.9'),
                callPrice: new Decimal('20100'),
                toCallPrice: new Decimal('-0.004'),
                turnover: new Decimal('10000000'),
                warrantType: WarrantType.Bear,
                status: WarrantStatus.Normal,
              },
            ]
          : [],
      );
      const entered = Promise.withResolvers<undefined>();
      const release = Promise.withResolvers<undefined>();
      let pauseRead = true;
      const client = await createMarketDataClient({
        config: createSdkConfigDouble(),
        quoteContextFactory: () => ({
          ...quoteContext,
          realtimeQuote: async (symbols) => {
            const quotes = await quoteContext.realtimeQuote(symbols);
            if (pauseRead) {
              pauseRead = false;
              entered.resolve();
              await release.promise;
            }

            return quotes;
          },
        }),
      });
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
        marketDataClient: client,
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
        marketDataClient: client,
        ...tradeRuntime,
        riskChecker,
        candidateSearch: createWarrantCandidateSearch({
          monitorSymbol: config.monitor.monitorSymbol,
          autoSearchConfig: config.monitor.autoSearchConfig,
          marketDataClient: client,
          logger,
          getTradingMinutesSinceOpen,
        }),
        clock,
        getTradingCalendarSnapshot: () =>
          new Map([['2026-02-16', { isTradingDay: true, isHalfDay: false }]]),
      });
      const observedQuotes: ReadonlyMap<string, Quote | null>[] = [];
      const workflow = createOrdinaryBuyWorkflow({
        logger,
        config: config.monitor,
        doomsdayProtection: config.global.doomsdayProtection,
        symbolRegistry,
        ...tradeRuntime,
        tradeFrequencyReader: tradeRuntime.orderExecutor,
        riskChecker,
        liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
        marketDataClient: {
          ...client,
          getQuotes: async (symbols) => {
            const quotes = await client.getQuotes(symbols);
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
        await entered.promise;
        expect(quoteContext.getCalls('realtimeQuote')[0]?.args[0]).toEqual([
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
        expect(quoteContext.getCalls('warrantList')).toHaveLength(1);
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
        expect(quoteContext.getCalls('unsubscribe').map((call) => call.args[0])).toEqual([
          ['BEAR.HK'],
        ]);

        expect(quoteContext.getCalls('subscribe').map((call) => call.args[0])).toEqual([
          ['HSI.HK', 'BULL.HK', 'BEAR.HK'],
        ]);

        expect(symbolRegistry.getSeatState('LONG')).toBe(longSeat);
        expect(validateSignalSeat({ signal, symbolRegistry }).valid).toBeTrue();
        release.resolve();
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
        expect(quoteContext.getCalls('realtimeQuote')).toHaveLength(1);
      } finally {
        release.resolve();
        await processor.stopAndDrain();
        await subscriptions.stopAndDrain();
      }
    },
  );
});
