import { createDiagnosticObserverDouble } from '../helpers/diagnostics.js';
import {
  createLoggerDouble,
  createMarketDataClientDouble,
  createOrderMonitorDouble,
  createQuoteDouble,
  createRateLimiterDouble,
  createRiskCheckerDouble,
  createSignalDouble,
} from '../helpers/testDoubles.js';

/** 普通 SELL owner 全链路：真实 S/H readiness -> FIFO -> 可卖量重选 -> native mutation，停留在离线 adapter fixture。 */
import { describe, expect, it } from 'bun:test';
import { createBrokerIngressFixture } from './architectureRefactoringP1Native/trade/brokerIngressFixture.js';
import { createOrdinarySellWorkflow } from '../../src/application/ordinarySell/index.js';
import { createSellProcessor } from '../../src/runtime/asyncProgram/sellProcessor/index.js';
import { createSellTaskQueue } from '../../src/runtime/asyncProgram/tradeTaskQueue/index.js';
import { createSellHarness } from '../application/ordinarySell/fixture.js';
import { createTradingConfig } from '../../mock/factories/configFactory.js';
import { waitUntil } from '../helpers/asyncProgram.js';

// 所有外部 DTO 仅进入获准的 native producer；真实 application 不识别 SDK enum/Decimal。
describe('ordinary SELL real owner integration', () => {
  it.each(['READY', 'MISSING', 'ZERO', 'NEGATIVE'] as const)(
    'final permit quote %s keeps native submission and the bounded retry semantics distinct',
    async (scenario) => {
      const now = () => new Date('2026-02-16T02:00:00Z');
      const ingress = await createBrokerIngressFixture({
        orderId: 'OWNER-SELL',
        symbol: 'BULL.HK',
        stockName: 'BULL',
        remark: '',
        side: 'SELL',
        status: 'New',
        quantity: '500',
        executedQuantity: '0',
        submittedPrice: '1',
        executedPrice: '0',
        submittedAtMs: now().getTime(),
        updatedAtMs: now().getTime(),
      });
      ingress.setStockPositions([
        {
          symbol: 'BULL.HK',
          symbolName: 'BULL',
          accountChannel: 'lb_papertrading',
          currency: 'HKD',
          costPrice: '1',
          quantity: '500',
          availableQuantity: '500',
        },
      ]);
      ingress.setSubmitBehavior(async () => 'OWNER-ACCEPTED-SELL');
      const h = await createSellHarness();
      let quoteReads = 0;
      const market = createMarketDataClientDouble({
        getQuotes: async (symbols) => {
          quoteReads += 1;
          if (quoteReads === 2 && scenario === 'MISSING') return new Map();

          let finalPrice = '1.123';
          if (quoteReads === 2 && scenario === 'ZERO') finalPrice = '0';

          if (quoteReads === 2 && scenario === 'NEGATIVE') finalPrice = '-1';

          return new Map(
            [...symbols].map((symbol) => [
              symbol,
              createQuoteDouble(symbol, quoteReads === 1 ? '1.1' : finalPrice, 100),
            ]),
          );
        },
      });
      let tracked = 0;
      const executor = ingress.createExecutor({
        diagnostics: createDiagnosticObserverDouble(),
        logger: createLoggerDouble(),
        rateLimiter: createRateLimiterDouble(),
        marketDataClient: market,
        cacheManager: { clearCache: () => {} },
        orderMonitor: createOrderMonitorDouble({
          trackOrder: () => {
            tracked += 1;
          },
        }),
        orderRecorder: h.context.orderRecorder,
        tradingConfig: createTradingConfig(),
        symbolRegistry: h.context.symbolRegistry,
        isExecutionAllowed: () => true,
        isContinuousTradingAllowed: () => true,
        now,
        readCurrentTradingDayInfo: () => ({
          dateKey: '2026-02-16',
          info: { isTradingDay: true, isHalfDay: false },
        }),
        unrealizedLossBuyGate: createRiskCheckerDouble({
          checkUnrealizedLoss: () => {
            throw new Error('SELL entered BUY floating-loss gate');
          },
        }),
      });
      const workflow = createOrdinarySellWorkflow({
        ...h.deps,

        orderExecutor: executor,
        marketDataClient: market,
      });
      const queue = createSellTaskQueue({
        clock: { now: () => new Date() },
        diagnostics: createDiagnosticObserverDouble(),
      });
      const retries: Array<() => void> = [];
      const worker = createSellProcessor({
        logger: createLoggerDouble(),
        taskQueue: queue,
        workflow,
        scheduler: {
          scheduleTimer: (callback) => {
            retries.push(callback);
            const handle = setTimeout(() => {}, 60_000);
            clearTimeout(handle);
            return handle;
          },
          clearTimer: clearTimeout,
        },
        getCanProcessTask: () => true,
        termination: h.deps.termination,
      });
      try {
        worker.start();
        queue.push({
          type: 'STRATEGY_SELL',
          data: {
            ...createSignalDouble('SELLCALL', 'BULL.HK'),
            seatVersion: 2,
            triggerTime: now(),
          },
        });
        await waitUntil(() => quoteReads >= 2);
        if (scenario === 'MISSING') {
          await waitUntil(() => retries.length === 1 || h.deps.termination.isTerminated());
          expect(ingress.nativeSubmitObservations()).toHaveLength(0);
          expect(retries).toHaveLength(1);
          const retry = retries[0];
          if (retry === undefined) throw new Error('final missing quote must issue a retry');

          retry();
        }

        if (scenario === 'READY' || scenario === 'MISSING') {
          await waitUntil(() => tracked === 1 || h.deps.termination.isTerminated());
          expect(quoteReads).toBe(scenario === 'MISSING' ? 4 : 2);
          expect(ingress.nativeSubmitObservations()).toHaveLength(1);
          expect(ingress.nativeSubmitObservations()[0]?.quantity).toBe('500');
          expect(ingress.nativeSubmitObservations()[0]?.price).toBe('1.123');
          expect(ingress.nativeSubmitObservations()[0]?.side).toBe('SELL');
        } else {
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          expect(quoteReads).toBe(2);
          expect(ingress.nativeSubmitObservations()).toHaveLength(0);
        }

        expect(retries).toHaveLength(scenario === 'MISSING' ? 1 : 0);
        expect(h.deps.termination.isTerminated()).toBeFalse();
        expect(h.snapshot.getView().positions[0]?.quantity).toBe(500);
      } finally {
        await worker.stopAndDrain();
        await h.settlement.stopAndDrain();
      }
    },
  );
});
