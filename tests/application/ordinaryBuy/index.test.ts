import { createDiagnosticObserverDouble } from '../../helpers/diagnostics.js';
import {
  createOrderRecorderDouble,
  createLoggerDouble,
  createAccountSnapshotDouble,
  createLiquidationCooldownTrackerDouble,
  createMarketDataClientDouble,
  createQuoteDouble,
  createRiskCheckerDouble,
  createSignalDouble,
  createTradeRuntimeDouble,
} from '../../helpers/testDoubles.js';

/** 普通 BUY owner：真实风险顺序/实时双读、旧席位失效、有限外部失败与 UNKNOWN fatal 语义。 */
import { logger } from '../../../src/infrastructure/logger/index.js';
import { describe, expect, it } from 'bun:test';
import { createOrdinaryBuyWorkflow } from '../../../src/application/ordinaryBuy/index.js';
import { createTradeMutationUnknownError } from '../../../src/application/orderExecution/tradeMutationErrors.js';
import { createBuyProcessor } from '../../../src/runtime/asyncProgram/buyProcessor/index.js';
import { createBuyTaskQueue } from '../../../src/runtime/asyncProgram/tradeTaskQueue/index.js';
import { createTerminationRuntime } from '../../../src/runtime/lifecycle/terminationRuntime.js';
import { createSnapshotFixture } from '../../helpers/accountPositionSnapshot.js';
import { createMonitorContext, runProcessorFlow } from '../../helpers/asyncProgram.js';
import { createExternalApiRequestError } from '../../helpers/createExternalApiRequestError.js';
import { createTradingConfig } from '../../../mock/factories/configFactory.js';

import type { OrdinaryBuyWorkflowDeps } from '../../../src/application/ordinaryBuy/types.js';
import type { DiagnosticFields } from '../../../src/types/diagnostics.js';

/** 通过真实 H 发布基线，窄能力直接创建完整 owner，不经过 SignalProcessor 或旧处理器。 */
async function createWorkflow(overrides: Partial<OrdinaryBuyWorkflowDeps> = {}) {
  const context = createMonitorContext();
  const config = createTradingConfig();
  const snapshot = await createSnapshotFixture({
    account: createAccountSnapshotDouble('100000'),
    positions: [],
  });
  const tradeRuntime = createTradeRuntimeDouble();
  const deps: OrdinaryBuyWorkflowDeps = {
    diagnostics: createDiagnosticObserverDouble(),
    tradeFrequencyReader: tradeRuntime.orderExecutor,
    logger,
    config: config.monitor,
    doomsdayProtection: config.global.doomsdayProtection,
    symbolRegistry: context.symbolRegistry,

    riskChecker: createRiskCheckerDouble(),
    ...tradeRuntime,
    marketDataClient: createMarketDataClientDouble({
      getQuotes: async () =>
        new Map([
          ['HSI.HK', createQuoteDouble('HSI.HK', '20000')],
          ['BULL.HK', createQuoteDouble('BULL.HK', '0.999', 100)],
          ['BEAR.HK', createQuoteDouble('BEAR.HK', '0.9', 100)],
        ]),
    }),
    liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
    snapshot,
    getIsHalfDay: () => false,
    now: () => new Date('2026-02-16T02:00:00Z'),
    getCanProcessTask: () => true,
    termination: {
      isTerminated: () => false,
      reportFatalError: (error) => {
        throw error;
      },
    },
    ...overrides,
  };
  return { workflow: createOrdinaryBuyWorkflow(deps), deps, snapshot };
}

function buySignal() {
  return { ...createSignalDouble('BUYCALL', 'BULL.HK'), seatVersion: 2 };
}

describe('ordinaryBuy owner', () => {
  it('fetches one risk quote set, then uses realtime reads without modifying canonical facts', async () => {
    const steps: string[] = [];
    const account = createAccountSnapshotDouble('77777');
    const tradeInstances1 = createTradeRuntimeDouble({
      accountService: {
        getAccountSnapshot: async () => {
          steps.push('account');
          return account;
        },
        getStockPositions: async () => {
          steps.push('positions');
          return [];
        },
      },
      orderExecutor: {
        executeSignals: async (signals, authorize) => {
          expect(authorize()).toBeTrue();
          expect(signals[0]?.quantity).toBeUndefined();
          steps.push('execute');
          return { executedOrderIds: ['BUY'], quoteFailures: [] };
        },
      },
    });
    const { workflow, snapshot } = await createWorkflow({
      accountService: tradeInstances1.accountService,
      orderRecorder: tradeInstances1.orderRecorder,
      orderExecutor: tradeInstances1.orderExecutor,
      tradeFrequencyReader: tradeInstances1.orderExecutor,
      riskChecker: createRiskCheckerDouble({
        checkBeforeOrder: (params) => {
          expect(params.account).toBe(account);
          steps.push('baseRisk');
          return { allowed: true };
        },
      }),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async (symbols) => {
          steps.push('quotes');
          expect([...symbols]).toEqual(['HSI.HK', 'BULL.HK', 'BEAR.HK']);
          return new Map([
            ['HSI.HK', createQuoteDouble('HSI.HK', '20000')],
            ['BULL.HK', createQuoteDouble('BULL.HK', '0.999', 100)],
          ]);
        },
      }),
    });
    const original = snapshot.getView();
    await workflow.execute(buySignal());
    expect(steps).toEqual(['quotes', 'account', 'positions', 'baseRisk', 'execute']);
    expect(snapshot.getView()).toBe(original);
  });

  it('rejects equality to original cost before realtime reads, and cooldown reset belongs only to BUY', async () => {
    let reads = 0;
    let checks = 0;
    let price = '1';
    const tradeInstances2 = createTradeRuntimeDouble({
      orderExecutor: {
        canTradeNow: () => {
          checks += 1;
          return { canTrade: true };
        },
      },
      accountService: {
        getAccountSnapshot: async () => {
          reads += 1;
          return createAccountSnapshotDouble('100000');
        },
      },
    });
    const { workflow } = await createWorkflow({
      accountService: tradeInstances2.accountService,
      orderRecorder: createOrderRecorderDouble({
        getLatestBuyOrderCost: () => ({ costAmount: '1000', quantity: 1000 }),
      }),
      orderExecutor: tradeInstances2.orderExecutor,
      tradeFrequencyReader: tradeInstances2.orderExecutor,
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () =>
          new Map([
            ['HSI.HK', createQuoteDouble('HSI.HK', '20000')],
            ['BULL.HK', createQuoteDouble('BULL.HK', price, 100)],
          ]),
      }),
    });
    await workflow.execute(buySignal());
    price = '0.999';
    await workflow.execute(buySignal());
    expect(reads).toBe(0);
    expect(checks).toBe(1);
    workflow.resetRiskCheckCooldown();
    await workflow.execute(buySignal());
    expect(reads).toBe(1);
  });

  it('does not submit after seat identity changes during the realtime account read', async () => {
    let submits = 0;
    const context = createMonitorContext();
    const tradeInstances3 = createTradeRuntimeDouble({
      accountService: {
        getAccountSnapshot: async () => {
          context.symbolRegistry.updateSeatStateWithVersionBump('LONG', {
            symbol: 'BULL.HK',
            status: 'ACTIVE',
            lastSwitchAt: null,
            lastSearchAt: null,
            lastSeatActivatedAt: 12000,
            searchFailCountToday: 0,
            frozenTradingDayKey: null,
          });
          return createAccountSnapshotDouble('100000');
        },
      },
      orderExecutor: {
        executeSignals: async () => {
          submits += 1;
          return { executedOrderIds: ['INVALID'], quoteFailures: [] };
        },
      },
    });
    const { workflow } = await createWorkflow({
      symbolRegistry: context.symbolRegistry,
      accountService: tradeInstances3.accountService,
      orderRecorder: tradeInstances3.orderRecorder,
      orderExecutor: tradeInstances3.orderExecutor,
      tradeFrequencyReader: tradeInstances3.orderExecutor,
    });
    await workflow.execute(buySignal());
    expect(submits).toBe(0);
  });

  it('drops missing risk-time quote and stale-seat signal before realtime reads', async () => {
    let reads = 0;
    const tradeInstances4 = createTradeRuntimeDouble({
      accountService: {
        getAccountSnapshot: async () => {
          reads += 1;
          return createAccountSnapshotDouble('100000');
        },
      },
    });
    const { workflow } = await createWorkflow({
      accountService: tradeInstances4.accountService,
      orderRecorder: tradeInstances4.orderRecorder,
      orderExecutor: tradeInstances4.orderExecutor,
      tradeFrequencyReader: tradeInstances4.orderExecutor,
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () => new Map([['HSI.HK', createQuoteDouble('HSI.HK', '20000')]]),
      }),
    });
    await workflow.execute({ ...buySignal(), seatVersion: 1 });
    await workflow.execute(buySignal());
    expect(reads).toBe(0);
  });

  it.each(['getQuotes', 'submitOrder'])(
    'keeps %s failure at the owning business/fatal boundary',
    async (operation) => {
      const failure =
        operation === 'submitOrder'
          ? createTradeMutationUnknownError({
              kind: 'UNKNOWN',
              operation: 'TradeContext.submitOrder',
              requestAttempted: true,
              code: null,
              cause: new Error('submit outcome unknown'),
            })
          : await createExternalApiRequestError({
              operation: 'QuoteContext.quote',
              attempts: 1,
              cause: new Error('network'),
            });
      const queue = createBuyTaskQueue({
        clock: { now: () => new Date() },
        diagnostics: createDiagnosticObserverDouble(),
      });
      const termination = createTerminationRuntime({
        closeTradingGate: () => {},
        closeProducerAdmission: queue.close,
        stopProducers: [],
        onSecondaryError: () => {},
      });
      let executions = 0;
      const tradeInstances5 = createTradeRuntimeDouble({
        orderExecutor: {
          executeSignals: async () => {
            executions += 1;
            if (operation === 'submitOrder') throw failure;

            return { executedOrderIds: [], quoteFailures: [] };
          },
        },
      });
      const { workflow } = await createWorkflow({
        termination,
        accountService: tradeInstances5.accountService,
        orderRecorder: tradeInstances5.orderRecorder,
        orderExecutor: tradeInstances5.orderExecutor,
        tradeFrequencyReader: tradeInstances5.orderExecutor,
        marketDataClient: createMarketDataClientDouble({
          getQuotes: async () => {
            if (operation === 'getQuotes') throw failure;

            return new Map([
              ['HSI.HK', createQuoteDouble('HSI.HK', '20000')],
              ['BULL.HK', createQuoteDouble('BULL.HK', '0.9', 100)],
            ]);
          },
        }),
      });
      const processor = createBuyProcessor({
        logger: createLoggerDouble(),
        diagnostics: createDiagnosticObserverDouble(),
        taskQueue: queue,
        workflow,
        getCanProcessTask: () => true,
        termination,
      });
      await runProcessorFlow({
        processor,
        pushTask: () => {
          for (const data of [buySignal(), buySignal()]) queue.push({ type: 'STRATEGY_BUY', data });
        },
        waitCondition: () =>
          operation === 'submitOrder' ? termination.isTerminated() : queue.isEmpty(),
      });
      expect(termination.isTerminated()).toBe(operation === 'submitOrder');
      expect(executions).toBe(operation === 'submitOrder' ? 1 : 0);
      if (operation === 'submitOrder') {
        const fatalState = termination.getFatalState();
        expect(fatalState.hasFatalError && fatalState.error).toBe(failure);
        expect(queue.isEmpty()).toBeFalse();
        expect(queue.pop()?.data.action).toBe('BUYCALL');
        expect(queue.isEmpty()).toBeTrue();
      }
    },
  );
});

describe.each([false, true])(
  'ordinaryBuy admission diagnostics observer throws=%s',
  (observerThrows) => {
    it.each([
      { quoteCase: 'tradeMissing', reasonCode: 'QUOTE_MISSING', quoteRole: 'TRADE' },
      { quoteCase: 'monitorMissing', reasonCode: 'QUOTE_MISSING', quoteRole: 'MONITOR' },
      { quoteCase: 'monitorInvalid', reasonCode: 'QUOTE_INVALID', quoteRole: 'MONITOR' },
    ])(
      'keeps $quoteCase admission before realtime reads',
      async ({ quoteCase, reasonCode, quoteRole }) => {
        const events: DiagnosticFields[] = [];
        let reads = 0;
        let quoteReads = 0;
        let clockReads = 0;
        const { workflow } = await createWorkflow({
          logger: createLoggerDouble(),
          diagnostics: {
            record: (_operation, fields) => {
              events.push(fields);
              if (observerThrows) throw new Error('observer failed');
            },
          },
          now: () => {
            clockReads += 1;
            return new Date('2026-02-16T02:00:00Z');
          },
          accountService: {
            getAccountSnapshot: async () => {
              reads += 1;
              return createAccountSnapshotDouble('100000');
            },
            getStockPositions: async () => {
              reads += 1;
              return [];
            },
          },
          marketDataClient: createMarketDataClientDouble({
            getQuotes: async () => {
              quoteReads += 1;
              const quotes = new Map();
              if (quoteCase !== 'tradeMissing')
                quotes.set('BULL.HK', createQuoteDouble('BULL.HK', '1'));

              if (quoteCase !== 'monitorMissing')
                quotes.set(
                  'HSI.HK',
                  createQuoteDouble('HSI.HK', quoteCase === 'monitorInvalid' ? '0' : '20000'),
                );

              return quotes;
            },
          }),
        });
        await workflow.execute(buySignal());
        expect(quoteReads).toBe(1);
        expect(reads).toBe(0);
        expect(clockReads).toBe(0);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          stage: 'BUY_QUOTE_ADMISSION',
          outcome: 'REJECTED',
          reasonCode,
          quoteRole,
          action: 'BUYCALL',
          seatVersion: 2,
        });
      },
    );

    it('reports the existing post-quote day rejection without extra authorization calls', async () => {
      const events: DiagnosticFields[] = [];
      let gateChecks = 0;
      let clockReads = 0;
      let snapshotReads = 0;
      const h = await createWorkflow({
        logger: createLoggerDouble(),
        diagnostics: {
          record: (_operation, fields) => {
            events.push(fields);
            if (observerThrows) throw new Error('observer failed');
          },
        },
        now: () => {
          clockReads += 1;
          return new Date('2026-02-16T02:00:00Z');
        },
        getCanProcessTask: () => {
          gateChecks += 1;
          return true;
        },
        marketDataClient: createMarketDataClientDouble({
          getQuotes: async () => {
            await h.snapshot.requestClear({ reason: 'DAY_CUT', dayEpoch: 7 });
            return new Map();
          },
        }),
      });
      const originalDayEpoch = h.snapshot.getView().token.dayEpoch;
      const workflow = createOrdinaryBuyWorkflow({
        ...h.deps,
        snapshot: {
          getView: () => {
            snapshotReads += 1;
            return h.snapshot.getView();
          },
        },
      });
      await workflow.execute(buySignal());
      expect(gateChecks).toBe(2);
      expect(snapshotReads).toBe(3);
      expect(clockReads).toBe(0);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        stage: 'BUY_AUTHORIZATION',
        outcome: 'ABORTED',
        reasonCode: 'TRADING_DAY_INVALIDATED',
        originDayEpoch: originalDayEpoch,
        currentDayEpoch: 7,
      });
    });
  },
);
